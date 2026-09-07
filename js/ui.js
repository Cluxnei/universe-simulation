/**
 * NavigatorUI
 *
 * DOM overlay on top of the WebGL canvas, for a PLANETARY SYSTEM rather than a
 * generic cloud of bodies:
 *
 *   - a HUD: simulated time in years, body counts broken down by class, total
 *     mass in Earth masses, the snow line, the largest body and the conserved
 *     quantities
 *   - a searchable / sortable body list, sorted by semi-major axis by default,
 *     because that is how a planetary system is actually read
 *   - an inspector showing the structure of the selected body: class, mass,
 *     radius, density, interior temperature, luminosity, orbit and a
 *     composition breakdown
 *   - a keyboard help overlay fed by CameraController.getKeyBindings()
 *   - playback controls (pause, speed, camera mode, disk guides)
 *
 * UNITS. The simulation works in solar masses, AU and years. Nothing in this
 * file prints a raw simulation number: masses become Earth / Jupiter / solar
 * masses, radii become Earth / Jupiter / solar radii, densities become g/cm^3.
 *
 * PERFORMANCE
 *   The render loop must never pay for this panel. Everything is throttled: the
 *   body list and the HUD refresh at ~4 Hz, the list renders at most `maxRows`
 *   (default 60) pooled rows mutated in place, and the DOM is never rebuilt
 *   wholesale. `simulation.stats` is O(n^2) (it sums the potential energy), so
 *   it is fetched exactly once per refresh and memoised.
 *
 * DEFENSIVE BY DESIGN
 *   Every field of the physics contract is optional here. A missing value shows
 *   as an em dash or hides its row; nothing in this file may throw, because it
 *   is called from inside the animation frame.
 *
 * No modules, no build step: this declares a global class.
 * All user-facing strings are pt-BR.
 */

/**
 * The five physical classes, in mass order. The keys are exactly what
 * structure.js `classify()` returns. Hoisted out of the class because the list
 * is consulted once per body per refresh: a static getter that built a fresh
 * array would allocate 800 arrays of 5 objects, four times a second.
 */
const NV_CLASSES = [
    { key: 'asteroid', label: 'Asteroides', singular: 'Asteroide' },
    { key: 'planet', label: 'Planetas', singular: 'Planeta' },
    { key: 'gasGiant', label: 'Gigantes gasosos', singular: 'Gigante gasoso' },
    { key: 'brownDwarf', label: 'Anãs marrons', singular: 'Anã marrom' },
    { key: 'star', label: 'Estrelas', singular: 'Estrela' },
    // Not a mass class like the others - a black hole of 10 Msun and a star of
    // 10 Msun differ by collapse, not by mass - but it belongs at the end of the
    // list because it is where the sequence ends.
    { key: 'blackHole', label: 'Buracos negros', singular: 'Buraco negro' }
];

/**
 * Presets for the "Adicionar corpo" tool.
 *
 * `min`, `max` and `preset` are in the type's own DISPLAY unit (Earth masses
 * for the small stuff, Jupiter masses for giants, solar masses for stars),
 * because nobody types 9.546e-4 for a Jupiter. `composition` is the mix that
 * lets structure.js classify() agree with the button that was pressed: a body
 * made of condensed rock has gasFraction 0 and can never be a gas giant, a
 * brown dwarf or a star, whatever its mass.
 *
 * The ranges deliberately straddle each class boundary, so the derived class in
 * the panel changes under the user's hand instead of being decorative.
 */
const NV_SPAWN_TYPES = [
    {
        key: 'asteroid', label: 'Asteroide', unit: 'earth',
        min: 1e-8, max: 1e-3, preset: 1e-5, composition: 'auto',
        hint: 'Corpo pequeno demais para o equilíbrio hidrostático'
    },
    {
        key: 'planet', label: 'Planeta', unit: 'earth',
        min: 1e-4, max: 300, preset: 1, composition: 'auto',
        hint: 'Corpo condensado de rocha, metal e gelo'
    },
    {
        key: 'gasGiant', label: 'Gigante gasoso', unit: 'jupiter',
        min: 0.02, max: 13, preset: 1, composition: 'nebular',
        hint: 'Envelope de H/He: precisa de composição nebular e de pelo menos 10 M⊕'
    },
    {
        key: 'brownDwarf', label: 'Anã marrom', unit: 'jupiter',
        min: 5, max: 80, preset: 30, composition: 'nebular',
        hint: 'Acima de 13 M♃ o deutério queima'
    },
    {
        key: 'star', label: 'Estrela', unit: 'solar',
        min: 0.05, max: 50, preset: 1, composition: 'nebular',
        hint: 'Acima de 0,08 M☉ o hidrogênio queima'
    }
];

/** key -> index in NV_SPAWN_TYPES. */
const NV_SPAWN_TYPE_RANK = (function () {
    const ranks = Object.create(null);
    for (let i = 0; i < NV_SPAWN_TYPES.length; i++) {
        ranks[NV_SPAWN_TYPES[i].key] = i;
    }
    return ranks;
})();

/** key -> index in NV_CLASSES, so classRank() is a lookup and not a scan. */
const NV_CLASS_RANK = (function () {
    const ranks = Object.create(null);
    for (let i = 0; i < NV_CLASSES.length; i++) {
        ranks[NV_CLASSES[i].key] = i;
    }
    return ranks;
})();

class NavigatorUI {

    /**
     * @param {Object} options
     *   mount          {HTMLElement}                        default document.body
     *   getBodies      {Function} () => Planet[]
     *   getStats       {Function} () => stats object
     *   getCamera      {Function} () => THREE.Camera
     *   getOrbit       {Function} (planet) => {semiMajorAxis, eccentricity} | null
     *   getTime        {Function} () => simulated time in YEARS
     *   getRate        {Function} () => simulated years per real second
     *   getKeyBindings {Function} () => [{keys, description, group}]
     *   onSelect       {Function} (planet) => void          row clicked
     *   onFollow       {Function} (planet) => void          "Seguir"
     *   onFrame        {Function} (planet) => void          "Enquadrar"
     *   onRelease      {Function} () => void                "Soltar"
     *   onFrameAll     {Function} () => void                "Tudo"
     *   onModeChange   {Function} (mode) => void
     *   onPause        {Function} (isPaused) => void
     *   onSpeedChange  {Function} (multiplier) => void
     *   onToggleGuides {Function} () => void
     *   onOrbitModeChange {Function} ('none'|'ellipses'|'trails'|'both') => void
     *   onOrbitScopeChange {Function} ('selected'|'top12'|'top48'|'all') => void
     *   onChangeScenario {Function} () => void                back to the launch screen
     *   onSpawnArm     {Function} (armed) => void            ferramenta armada / desarmada
     *   onSpawnConfigChange {Function} (config) => void      type / mass / composition / velocity
     *   onSpawnUndo    {Function} () => void                 remove the last body created
     *   maxRows        {number}   default 60
     *   refreshInterval{number}   seconds, default 0.25
     */
    constructor(options) {
        options = options || {};
        this.options = options;

        this.mount = options.mount || document.body;
        this.getBodies = typeof options.getBodies === 'function' ? options.getBodies : function () { return []; };
        this.getStats = typeof options.getStats === 'function' ? options.getStats : function () { return null; };
        this.getCamera = typeof options.getCamera === 'function' ? options.getCamera : function () { return null; };
        this.getOrbit = typeof options.getOrbit === 'function' ? options.getOrbit : null;
        this.getTime = typeof options.getTime === 'function' ? options.getTime : null;
        this.getRate = typeof options.getRate === 'function' ? options.getRate : null;
        this.getKeyBindings = typeof options.getKeyBindings === 'function' ? options.getKeyBindings : function () { return []; };

        this.onSelect = options.onSelect || null;
        this.onFollow = options.onFollow || null;
        this.onFrame = options.onFrame || null;
        this.onRelease = options.onRelease || null;
        this.onFrameAll = options.onFrameAll || null;
        this.onModeChange = options.onModeChange || null;
        this.onPause = options.onPause || null;
        this.onSpeedChange = options.onSpeedChange || null;
        this.onToggleGuides = options.onToggleGuides || null;
        this.onOrbitModeChange = options.onOrbitModeChange || null;
        this.onOrbitScopeChange = options.onOrbitScopeChange || null;
        this.onChangeScenario = options.onChangeScenario || null;
        this.onSpawnArm = options.onSpawnArm || null;
        this.onSpawnConfigChange = options.onSpawnConfigChange || null;
        this.onSpawnUndo = options.onSpawnUndo || null;

        this.maxRows = options.maxRows || 60;
        this.refreshInterval = options.refreshInterval || 0.25;

        // --- state ---------------------------------------------------------
        this.selected = null;
        this.following = null;
        this.mode = 'orbit';
        this.paused = false;
        this.speed = 1;
        // A planetary system reads outward from the star, so that is the default.
        this.sortKey = 'axis';
        this.sortAscending = true;
        this.filterText = '';
        this.helpVisible = false;
        this.guidesOn = true;
        this.orbitMode = 'ellipses';
        this.orbitScope = 'top12';
        this.scenarioLabel = null;
        this.scenarioId = null;

        // --- "Adicionar corpo" tool ---------------------------------------
        this.spawnArmed = false;
        this.spawnType = 'planet';
        this.spawnComposition = 'auto';
        this.spawnVelocityMode = 'circular';
        this.spawnUndoCount = 0;
        // mass per type, in SOLAR masses, so switching types back and forth
        // does not throw away what the user typed
        this.spawnMasses = Object.create(null);
        for (let i = 0; i < NV_SPAWN_TYPES.length; i++) {
            const spec = NV_SPAWN_TYPES[i];
            this.spawnMasses[spec.key] = spec.preset * NavigatorUI.spawnUnitFactor(spec.unit);
        }
        // what the render layer last told us about the pending placement
        this.spawnContext = {
            armed: false, ok: false, hovering: false, plane: 'disk',
            grazing: false, clamped: false, radius: 0, focusRadius: 0,
            speed: 0, centralMass: 0, hasFocus: false,
            starTemperature: 0, starRadius: 0
        };
        this._spawnDerivedKey = null;
        this._spawnDerivedValue = null;
        this._spawnMassSource = '';
        this._spawnLastColor = '';

        // throttling / fps
        this._accumulator = 0;
        this._frames = 0;
        this._fpsWindow = 0;
        this._fps = 0;

        // reusable buffers - no per-refresh allocation of entry objects
        this._entries = [];
        this._visible = [];
        this._rows = [];
        this._toastTimers = [];

        // per-refresh memoisation of the (expensive) stats object
        this._statsCache = null;
        this._statsFresh = false;

        // computed while walking the bodies, used as fallbacks when the physics
        // layer does not publish them
        this._classTally = NavigatorUI.emptyClassTally();
        this._largestFallback = null;
        this._snowLine = NaN;

        this._build();
        this.setKeyBindings(this.getKeyBindings());
        this._applySortButtons();
        this.refresh(true);
    }

    // =======================================================================
    // class metadata
    // =======================================================================

    /** The five physical classes, in mass order. See NV_CLASSES. */
    static get CLASSES() {
        return NV_CLASSES;
    }

    static emptyClassTally() {
        const tally = {};
        for (let i = 0; i < NV_CLASSES.length; i++) {
            tally[NV_CLASSES[i].key] = 0;
        }
        return tally;
    }

    static classRank(key) {
        const rank = NV_CLASS_RANK[key];
        return rank === undefined ? -1 : rank;
    }

    /**
     * Singular pt-BR label of a class, preferring structure.js so the two
     * halves never disagree. Memoised: it is asked for once per visible row.
     */
    static classNameOf(key) {
        const rank = NavigatorUI.classRank(key);
        if (rank < 0) {
            return 'Corpo';
        }
        const entry = NV_CLASSES[rank];
        if (entry.resolved === undefined) {
            entry.resolved = entry.singular;
            if (typeof classLabel === 'function') {
                try {
                    const label = classLabel(key);
                    if (typeof label === 'string' && label && label !== 'Corpo') {
                        entry.resolved = label;
                    }
                } catch (e) { /* keep the built-in label */ }
            }
            entry.searchable = NavigatorUI.normalizeText(entry.resolved);
        }
        return entry.resolved;
    }

    /** Accent-folded lowercase class label, for the search filter. */
    static classSearchTextOf(key) {
        const rank = NavigatorUI.classRank(key);
        if (rank < 0) {
            return '';
        }
        if (NV_CLASSES[rank].searchable === undefined) {
            NavigatorUI.classNameOf(key);
        }
        return NV_CLASSES[rank].searchable || '';
    }

    /** The class of a body, defaulting to `asteroid` when unclassified. */
    static classOf(planet) {
        const value = planet && planet.classification;
        return (typeof value === 'string' && NV_CLASS_RANK[value] !== undefined)
            ? value
            : 'asteroid';
    }

    // =======================================================================
    // DOM construction
    // =======================================================================

    _build() {
        const root = document.createElement('div');
        root.className = 'nv-root';
        this.root = root;

        root.appendChild(this._buildHud());
        root.appendChild(this._buildBodiesPanel());
        root.appendChild(this._buildInspector());
        root.appendChild(this._buildSpawnPanel());
        root.appendChild(this._buildPlayback());
        root.appendChild(this._buildHelp());
        root.appendChild(this._buildCrosshair());
        root.appendChild(this._buildToasts());

        this.mount.appendChild(root);
    }

    _panel(className, titleText, startCollapsed) {
        const panel = document.createElement('section');
        panel.className = 'nv-panel ' + className;

        const header = document.createElement('header');
        header.className = 'nv-panel__header';

        const title = document.createElement('h2');
        title.className = 'nv-panel__title';
        title.textContent = titleText;

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'nv-panel__toggle';
        toggle.setAttribute('aria-label', 'Recolher ou expandir painel');
        toggle.textContent = '−';

        header.appendChild(title);
        header.appendChild(toggle);

        const body = document.createElement('div');
        body.className = 'nv-panel__body';

        panel.appendChild(header);
        panel.appendChild(body);

        const self = this;
        function toggleCollapsed() {
            const collapsed = panel.classList.toggle('nv-panel--collapsed');
            toggle.textContent = collapsed ? '+' : '−';
            self._blur(toggle);
        }
        toggle.addEventListener('click', function (event) {
            event.stopPropagation();
            toggleCollapsed();
        });
        header.addEventListener('click', toggleCollapsed);

        if (startCollapsed) {
            panel.classList.add('nv-panel--collapsed');
            toggle.textContent = '+';
        }

        panel.nvBody = body;
        panel.nvTitle = title;
        panel.nvToggle = toggle;
        return panel;
    }

    /**
     * A <dt>/<dd> pair inside a stat grid, remembered so the whole row can be
     * hidden when the physics layer does not publish that quantity.
     */
    _statRow(grid, store, key, label, highlight) {
        const dt = document.createElement('dt');
        dt.textContent = label;

        const dd = document.createElement('dd');
        dd.textContent = '—';
        if (highlight) {
            dd.className = 'nv-stats__highlight';
        }

        grid.appendChild(dt);
        grid.appendChild(dd);
        store[key] = { dt: dt, dd: dd, last: null };
        return store[key];
    }

    /**
     * Write a stat row. `null` or `undefined` hides the whole row; that is how
     * "luminosity only when meaningful" is expressed.
     */
    static _writeStat(row, value) {
        if (!row) {
            return;
        }
        const hidden = (value === null || value === undefined);
        const text = hidden ? '—' : value;
        if (row.last !== text) {
            row.dd.textContent = text;
            row.last = text;
        }
        row.dt.classList.toggle('nv-hidden', hidden);
        row.dd.classList.toggle('nv-hidden', hidden);
    }

    // --- HUD ---------------------------------------------------------------

    _buildHud() {
        const panel = this._panel('nv-hud', 'Sistema planetário');
        const body = panel.nvBody;

        this.hudFields = {};

        const topGrid = document.createElement('dl');
        topGrid.className = 'nv-stats';
        this._statRow(topGrid, this.hudFields, 'scenario', 'Cenário');
        this._statRow(topGrid, this.hudFields, 'time', 'Tempo simulado', true);
        this._statRow(topGrid, this.hudFields, 'rate', 'Ritmo');
        this._statRow(topGrid, this.hudFields, 'count', 'Corpos');
        body.appendChild(topGrid);

        // one badge per physical class, always present so the layout is stable
        const classes = document.createElement('div');
        classes.className = 'nv-classes';
        this.classChips = {};
        const list = NavigatorUI.CLASSES;
        for (let i = 0; i < list.length; i++) {
            const item = list[i];

            const chip = document.createElement('span');
            chip.className = 'nv-classchip';
            chip.dataset.class = item.key;
            chip.title = item.label;

            const dot = document.createElement('span');
            dot.className = 'nv-classchip__dot';

            const name = document.createElement('span');
            name.className = 'nv-classchip__name';
            name.textContent = item.label;

            const value = document.createElement('span');
            value.className = 'nv-classchip__count';
            value.textContent = '0';

            chip.appendChild(dot);
            chip.appendChild(name);
            chip.appendChild(value);
            classes.appendChild(chip);

            this.classChips[item.key] = { chip: chip, count: value, last: null };
        }
        body.appendChild(classes);

        const grid = document.createElement('dl');
        grid.className = 'nv-stats';
        this._statRow(grid, this.hudFields, 'totalMass', 'Massa total');
        this._statRow(grid, this.hudFields, 'snowLine', 'Linha de gelo');
        this._statRow(grid, this.hudFields, 'largest', 'Maior corpo');
        this._statRow(grid, this.hudFields, 'kinetic', 'Energia cinética');
        this._statRow(grid, this.hudFields, 'potential', 'Energia potencial');
        this._statRow(grid, this.hudFields, 'total', 'Energia total');
        this._statRow(grid, this.hudFields, 'momentum', 'Momento linear');
        this._statRow(grid, this.hudFields, 'mode', 'Câmera');
        this._statRow(grid, this.hudFields, 'fps', 'FPS');
        body.appendChild(grid);
        body.appendChild(this._buildOrbitControls());

        this.hudPanel = panel;
        return panel;
    }

    /**
     * A labelled row of mutually exclusive chips. Returns the row element and
     * fills `store` with key -> button so the active one can be marked later.
     */
    _chipGroup(items, store, onPick) {
        const row = document.createElement('div');
        row.className = 'nv-chiprow';
        const self = this;
        for (let i = 0; i < items.length; i++) {
            const key = items[i][0];
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'nv-chip nv-chip--mini';
            button.textContent = items[i][1];
            if (items[i][2]) {
                button.title = items[i][2];
            }
            button.addEventListener('click', function () {
                onPick(key);
                self._blur(button);
            });
            row.appendChild(button);
            store[key] = button;
        }
        return row;
    }

    static _markGroup(store, activeKey) {
        const keys = Object.keys(store || {});
        for (let i = 0; i < keys.length; i++) {
            store[keys[i]].classList.toggle('nv-chip--active', keys[i] === activeKey);
        }
    }

    /**
     * Orbit display controls.
     *
     * Ellipses are the default because they answer the more useful question: a
     * body at 20 AU needs 89 simulated years to close a breadcrumb trail, while
     * its osculating ellipse is complete the instant it is drawn.
     */
    _buildOrbitControls() {
        const block = document.createElement('div');
        block.className = 'nv-orbits';
        const self = this;

        const title = document.createElement('h3');
        title.className = 'nv-orbits__title';
        title.textContent = 'Órbitas';
        block.appendChild(title);

        this.orbitModeButtons = {};
        block.appendChild(this._chipGroup([
            ['none', 'Nenhuma', 'Não desenhar órbitas (tecla T alterna)'],
            ['ellipses', 'Elipses', 'Órbita instantânea completa, calculada dos elementos orbitais'],
            ['trails', 'Rastros', 'Caminho realmente percorrido nos últimos 4 anos simulados'],
            ['both', 'Ambos', 'Elipses e rastros ao mesmo tempo']
        ], this.orbitModeButtons, function (key) {
            self.setOrbitMode(key);
            if (self.onOrbitModeChange) { self.onOrbitModeChange(key); }
        }));

        this.orbitScopeButtons = {};
        block.appendChild(this._chipGroup([
            ['selected', 'Selecionado', 'Apenas o corpo selecionado e o corpo seguido'],
            ['top12', '12 maiores', 'Os 12 corpos mais massivos'],
            ['top48', '48 maiores', 'Os 48 corpos mais massivos'],
            ['all', 'Todos', 'Todos os corpos, limitado aos 128 mais massivos - custa caro']
        ], this.orbitScopeButtons, function (key) {
            self.setOrbitScope(key);
            if (self.onOrbitScopeChange) { self.onOrbitScopeChange(key); }
        }));

        const hint = document.createElement('p');
        hint.className = 'nv-orbits__hint';
        this.orbitHint = hint;
        block.appendChild(hint);

        this.orbitBlock = block;
        this._refreshOrbitHint();
        return block;
    }

    // --- body navigation panel --------------------------------------------

    _buildBodiesPanel() {
        const panel = this._panel('nv-bodies', 'Navegar');
        const body = panel.nvBody;
        const self = this;

        // search
        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'nv-search';
        search.placeholder = 'Buscar por elemento, classe ou #id';
        search.setAttribute('aria-label', 'Buscar corpo por elemento, classe ou identificador');
        search.addEventListener('input', function () {
            self.filterText = search.value || '';
            self.refresh(true);
        });
        // keep simulation shortcuts from firing while typing
        search.addEventListener('keydown', function (event) {
            event.stopPropagation();
            if (event.key === 'Escape') {
                search.value = '';
                self.filterText = '';
                search.blur();
                self.refresh(true);
            }
        });
        this.searchInput = search;
        body.appendChild(search);

        // sort bar
        const sortBar = document.createElement('div');
        sortBar.className = 'nv-sortbar';

        const sorts = [
            ['axis', 'Semieixo'],
            ['mass', 'Massa'],
            ['radius', 'Raio'],
            ['distance', 'Distância'],
            ['classRank', 'Classe']
        ];
        this.sortButtons = {};
        for (let i = 0; i < sorts.length; i++) {
            const key = sorts[i][0];
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'nv-chip';
            button.dataset.sort = key;
            button.textContent = sorts[i][1];
            button.addEventListener('click', function () {
                self.setSort(key);
                self._blur(button);
            });
            sortBar.appendChild(button);
            this.sortButtons[key] = button;
        }

        const frameAll = document.createElement('button');
        frameAll.type = 'button';
        frameAll.className = 'nv-chip nv-chip--action';
        frameAll.textContent = 'Tudo';
        frameAll.title = 'Enquadrar todo o sistema (A)';
        frameAll.addEventListener('click', function () {
            if (self.onFrameAll) { self.onFrameAll(); }
            self._blur(frameAll);
        });
        sortBar.appendChild(frameAll);

        body.appendChild(sortBar);

        // list
        const list = document.createElement('div');
        list.className = 'nv-list';
        list.addEventListener('click', function (event) {
            const rowElement = self._closestRow(event.target);
            if (!rowElement) {
                return;
            }
            const index = parseInt(rowElement.dataset.index, 10);
            const planet = self._visible[index];
            if (!planet) {
                return;
            }
            if (event.target && event.target.dataset && event.target.dataset.action === 'follow') {
                if (self.onFollow) { self.onFollow(planet); }
                return;
            }
            if (self.onSelect) { self.onSelect(planet); }
        });
        this.listElement = list;
        body.appendChild(list);

        const footer = document.createElement('div');
        footer.className = 'nv-list__footer';
        footer.textContent = '—';
        this.listFooter = footer;
        body.appendChild(footer);

        this.bodiesPanel = panel;
        return panel;
    }

    _closestRow(node) {
        while (node && node !== this.listElement) {
            if (node.classList && node.classList.contains('nv-row')) {
                return node;
            }
            node = node.parentNode;
        }
        return null;
    }

    // --- inspector ---------------------------------------------------------

    _buildInspector() {
        const panel = this._panel('nv-inspector', 'Corpo selecionado');
        const body = panel.nvBody;
        const self = this;

        const head = document.createElement('div');
        head.className = 'nv-inspector__head';

        const swatch = document.createElement('span');
        swatch.className = 'nv-swatch nv-swatch--lg';

        const heading = document.createElement('span');
        heading.className = 'nv-inspector__heading';

        const name = document.createElement('span');
        name.className = 'nv-inspector__name';
        name.textContent = 'Nenhum corpo selecionado';

        const badge = document.createElement('span');
        badge.className = 'nv-badge';
        badge.dataset.class = 'asteroid';
        badge.textContent = '—';

        heading.appendChild(name);
        heading.appendChild(badge);

        head.appendChild(swatch);
        head.appendChild(heading);
        body.appendChild(head);

        const grid = document.createElement('dl');
        grid.className = 'nv-stats';
        this.inspectorFields = {};
        this._statRow(grid, this.inspectorFields, 'mass', 'Massa', true);
        this._statRow(grid, this.inspectorFields, 'radius', 'Raio');
        this._statRow(grid, this.inspectorFields, 'density', 'Densidade');
        this._statRow(grid, this.inspectorFields, 'centralTemperature', 'Temp. central');
        this._statRow(grid, this.inspectorFields, 'effectiveTemperature', 'Temp. efetiva');
        this._statRow(grid, this.inspectorFields, 'luminosity', 'Luminosidade');
        this._statRow(grid, this.inspectorFields, 'axis', 'Semieixo maior');
        this._statRow(grid, this.inspectorFields, 'eccentricity', 'Excentricidade');
        this._statRow(grid, this.inspectorFields, 'period', 'Período orbital');
        this._statRow(grid, this.inspectorFields, 'speed', 'Velocidade');
        this._statRow(grid, this.inspectorFields, 'distance', 'Dist. da câmera');
        body.appendChild(grid);

        // --- composition ---------------------------------------------------
        const composition = document.createElement('div');
        composition.className = 'nv-composition';

        const compTitle = document.createElement('h3');
        compTitle.className = 'nv-composition__title';
        compTitle.textContent = 'Composição';
        composition.appendChild(compTitle);

        const bar = document.createElement('div');
        bar.className = 'nv-compbar';
        composition.appendChild(bar);

        const legend = document.createElement('dl');
        legend.className = 'nv-stats nv-compbar__legend';

        this.compositionParts = {};
        const parts = [
            ['gas', 'Gás'],
            ['ice', 'Gelo'],
            ['rock', 'Rocha'],
            ['metal', 'Metal']
        ];
        for (let i = 0; i < parts.length; i++) {
            const key = parts[i][0];

            const segment = document.createElement('span');
            segment.className = 'nv-compbar__seg';
            segment.dataset.part = key;
            segment.style.width = '0%';
            segment.title = parts[i][1];
            bar.appendChild(segment);

            const dt = document.createElement('dt');
            const dot = document.createElement('span');
            dot.className = 'nv-compbar__dot';
            dot.dataset.part = key;
            dt.appendChild(dot);
            dt.appendChild(document.createTextNode(parts[i][1]));

            const dd = document.createElement('dd');
            dd.textContent = '—';

            legend.appendChild(dt);
            legend.appendChild(dd);

            this.compositionParts[key] = { segment: segment, value: dd, last: null, lastWidth: null };
        }
        composition.appendChild(legend);

        const summary = document.createElement('p');
        summary.className = 'nv-composition__summary';
        summary.textContent = '—';
        composition.appendChild(summary);

        this.compositionSummary = summary;
        this.compositionBlock = composition;
        body.appendChild(composition);

        const actions = document.createElement('div');
        actions.className = 'nv-actions';

        const followButton = document.createElement('button');
        followButton.type = 'button';
        followButton.className = 'nv-button nv-button--primary';
        followButton.textContent = 'Seguir';
        followButton.addEventListener('click', function () {
            if (self.selected && self.onFollow) { self.onFollow(self.selected); }
            self._blur(followButton);
        });

        const frameButton = document.createElement('button');
        frameButton.type = 'button';
        frameButton.className = 'nv-button';
        frameButton.textContent = 'Enquadrar';
        frameButton.addEventListener('click', function () {
            if (self.selected && self.onFrame) { self.onFrame(self.selected); }
            self._blur(frameButton);
        });

        const releaseButton = document.createElement('button');
        releaseButton.type = 'button';
        releaseButton.className = 'nv-button';
        releaseButton.textContent = 'Soltar';
        releaseButton.addEventListener('click', function () {
            if (self.onRelease) { self.onRelease(); }
            self._blur(releaseButton);
        });

        actions.appendChild(followButton);
        actions.appendChild(frameButton);
        actions.appendChild(releaseButton);
        body.appendChild(actions);

        this.inspectorSwatch = swatch;
        this.inspectorName = name;
        this.inspectorBadge = badge;
        this.inspectorPanel = panel;
        this.inspectorButtons = {
            follow: followButton,
            frame: frameButton,
            release: releaseButton
        };
        panel.classList.add('nv-panel--empty');
        return panel;
    }

    // --- playback ----------------------------------------------------------

    _buildPlayback() {
        const bar = document.createElement('div');
        bar.className = 'nv-playback';
        const self = this;

        const pause = document.createElement('button');
        pause.type = 'button';
        pause.className = 'nv-button nv-button--primary nv-playback__pause';
        pause.textContent = 'Pausar';
        pause.title = 'Pausar / retomar (Espaço)';
        pause.addEventListener('click', function () {
            self.togglePause();
            self._blur(pause);
        });
        this.pauseButton = pause;
        bar.appendChild(pause);

        const speeds = document.createElement('div');
        speeds.className = 'nv-speeds';
        this.speedButtons = {};
        const values = [0.25, 0.5, 1, 2, 4];
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'nv-chip';
            button.textContent = (value === 1 ? '1' : String(value).replace('.', ',')) + 'x';
            button.title = 'A 1x, um segundo real vale um ano simulado';
            button.addEventListener('click', function () {
                self.setSpeed(value, true);
                self._blur(button);
            });
            speeds.appendChild(button);
            this.speedButtons[String(value)] = button;
        }
        bar.appendChild(speeds);

        const modes = document.createElement('div');
        modes.className = 'nv-modes';
        this.modeButtons = {};
        const modeList = [
            ['orbit', 'Órbita', '1'],
            ['fly', 'Livre', '2'],
            ['follow', 'Seguir', '3']
        ];
        for (let i = 0; i < modeList.length; i++) {
            const key = modeList[i][0];
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'nv-chip';
            button.textContent = modeList[i][1];
            button.title = 'Tecla ' + modeList[i][2];
            button.addEventListener('click', function () {
                if (self.onModeChange) { self.onModeChange(key); }
                self._blur(button);
            });
            modes.appendChild(button);
            this.modeButtons[key] = button;
        }
        bar.appendChild(modes);

        const extras = document.createElement('div');
        extras.className = 'nv-extras';

        const guides = document.createElement('button');
        guides.type = 'button';
        guides.className = 'nv-chip';
        guides.textContent = 'Guias';
        guides.title = 'Mostrar ou ocultar as guias do disco (O)';
        guides.addEventListener('click', function () {
            if (self.onToggleGuides) { self.onToggleGuides(); }
            self._blur(guides);
        });
        this.guidesButton = guides;
        extras.appendChild(guides);

        const swap = document.createElement('button');
        swap.type = 'button';
        swap.className = 'nv-chip';
        swap.textContent = 'Trocar cenário';
        swap.title = 'Escolher outro cenário sem recarregar a página';
        swap.addEventListener('click', function () {
            if (self.onChangeScenario) { self.onChangeScenario(); }
            self._blur(swap);
        });
        this.scenarioButton = swap;
        extras.appendChild(swap);

        const help = document.createElement('button');
        help.type = 'button';
        help.className = 'nv-chip nv-chip--action';
        help.textContent = '? Ajuda';
        help.addEventListener('click', function () {
            self.toggleHelp();
            self._blur(help);
        });
        extras.appendChild(help);

        bar.appendChild(extras);

        this.playbackBar = bar;
        this.setSpeed(1, false);
        this.setMode('orbit');
        return bar;
    }

    // --- "Adicionar corpo" tool -------------------------------------------
    //
    // The user picks WHAT to create here; WHERE it goes is a click on the 3D
    // view, resolved by the render layer. Everything shown as "derived" comes
    // from structure.js describe(), never from the type button that was
    // pressed: a 5 Earth-mass "gigante gasoso" is a planet and the panel has to
    // say so, because classify() is what the physics will actually use.

    _spawnHeading(text) {
        const heading = document.createElement('h3');
        heading.className = 'nv-spawn__heading';
        heading.textContent = text;
        return heading;
    }

    _buildSpawnPanel() {
        const panel = this._panel('nv-spawn', 'Adicionar corpo', true);
        const body = panel.nvBody;
        const self = this;

        // --- arm / disarm --------------------------------------------------
        const arm = document.createElement('button');
        arm.type = 'button';
        arm.className = 'nv-button nv-button--primary nv-spawn__arm';
        arm.textContent = 'Armar ferramenta';
        arm.title = 'Armar e clicar na cena para posicionar o corpo (tecla P)';
        arm.addEventListener('click', function () {
            self.toggleSpawnArmed();
            self._blur(arm);
        });
        this.spawnArmButton = arm;
        body.appendChild(arm);

        // --- type ----------------------------------------------------------
        body.appendChild(this._spawnHeading('Tipo'));
        const typeItems = [];
        for (let i = 0; i < NV_SPAWN_TYPES.length; i++) {
            const spec = NV_SPAWN_TYPES[i];
            typeItems.push([spec.key, spec.label, spec.hint]);
        }
        this.spawnTypeButtons = {};
        body.appendChild(this._chipGroup(typeItems, this.spawnTypeButtons, function (key) {
            self.setSpawnType(key);
        }));

        // --- mass ----------------------------------------------------------
        body.appendChild(this._spawnHeading('Massa'));

        const massRow = document.createElement('div');
        massRow.className = 'nv-spawn__massrow';

        const number = document.createElement('input');
        number.type = 'number';
        number.className = 'nv-spawn__number';
        number.setAttribute('aria-label', 'Massa do corpo a criar');
        number.addEventListener('input', function () {
            const parsed = parseFloat(number.value);
            if (isFinite(parsed) && parsed > 0) {
                self._setSpawnMassDisplay(parsed, 'number');
            }
        });
        number.addEventListener('change', function () {
            const parsed = parseFloat(number.value);
            self._setSpawnMassDisplay(isFinite(parsed) ? parsed : NaN, 'commit');
        });
        // the simulation shortcuts live on window; typing must not reach them
        number.addEventListener('keydown', function (event) {
            event.stopPropagation();
        });
        this.spawnMassInput = number;

        const unit = document.createElement('span');
        unit.className = 'nv-spawn__unit';
        this.spawnUnitElement = unit;

        massRow.appendChild(number);
        massRow.appendChild(unit);
        body.appendChild(massRow);

        // A logarithmic slider: the useful range of every type spans several
        // decades, so a linear one would spend 90% of its travel on the top
        // decade and be unusable for the rest.
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'nv-spawn__slider';
        slider.min = '0';
        slider.max = '1000';
        slider.step = '1';
        slider.setAttribute('aria-label', 'Massa do corpo a criar, escala logarítmica');
        slider.addEventListener('input', function () {
            const value = parseFloat(slider.value);
            if (isFinite(value)) {
                self._setSpawnMass(self._spawnMassFromSlider(value), 'slider');
            }
        });
        slider.addEventListener('keydown', function (event) {
            event.stopPropagation();
        });
        this.spawnMassSlider = slider;
        body.appendChild(slider);

        const range = document.createElement('p');
        range.className = 'nv-spawn__range';
        this.spawnRangeText = range;
        body.appendChild(range);

        // --- composition ---------------------------------------------------
        body.appendChild(this._spawnHeading('Composição'));
        this.spawnCompositionButtons = {};
        body.appendChild(this._chipGroup([
            ['auto', 'Automática', 'Condensada no raio de formação: rocha e metal dentro da linha de gelo, gelo fora dela'],
            ['nebular', 'Nebular (H/He)', 'Mistura solar X=0,71 Y=0,27 - obrigatória para estrelas, anãs marrons e gigantes gasosos']
        ], this.spawnCompositionButtons, function (key) {
            self.setSpawnComposition(key);
        }));

        // --- velocity ------------------------------------------------------
        body.appendChild(this._spawnHeading('Velocidade inicial'));
        this.spawnVelocityButtons = {};
        body.appendChild(this._chipGroup([
            ['circular', 'Órbita circular', 'Velocidade circular no plano do disco, no mesmo sentido dos corpos existentes'],
            ['rest', 'Em repouso', 'Velocidade zero no referencial da simulação'],
            ['radial', 'Queda radial', 'Acompanha a estrela dominante e cai direto sobre ela']
        ], this.spawnVelocityButtons, function (key) {
            self.setSpawnVelocityMode(key);
        }));

        // --- what would actually be created --------------------------------
        const head = document.createElement('div');
        head.className = 'nv-spawn__preview';

        const swatch = document.createElement('span');
        swatch.className = 'nv-swatch';
        this.spawnSwatch = swatch;

        const badge = document.createElement('span');
        badge.className = 'nv-badge nv-badge--sm';
        badge.dataset.class = 'planet';
        badge.textContent = '—';
        this.spawnBadge = badge;

        head.appendChild(swatch);
        head.appendChild(badge);
        body.appendChild(head);

        const grid = document.createElement('dl');
        grid.className = 'nv-stats';
        this.spawnFields = {};
        this._statRow(grid, this.spawnFields, 'mass', 'Massa', true);
        this._statRow(grid, this.spawnFields, 'radius', 'Raio');
        this._statRow(grid, this.spawnFields, 'density', 'Densidade');
        this._statRow(grid, this.spawnFields, 'luminosity', 'Luminosidade');
        this._statRow(grid, this.spawnFields, 'temperature', 'Temp. efetiva');
        this._statRow(grid, this.spawnFields, 'plane', 'Plano do clique');
        this._statRow(grid, this.spawnFields, 'distance', 'Distância');
        this._statRow(grid, this.spawnFields, 'speed', 'Velocidade');
        body.appendChild(grid);

        const hint = document.createElement('p');
        hint.className = 'nv-spawn__hint';
        this.spawnHint = hint;
        body.appendChild(hint);

        const actions = document.createElement('div');
        actions.className = 'nv-actions';
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'nv-button';
        undo.textContent = 'Desfazer';
        undo.title = 'Remover o último corpo adicionado (Ctrl+Z)';
        undo.disabled = true;
        undo.addEventListener('click', function () {
            if (self.onSpawnUndo) { self.onSpawnUndo(); }
            self._blur(undo);
        });
        this.spawnUndoButton = undo;
        actions.appendChild(undo);
        body.appendChild(actions);

        this.spawnPanel = panel;
        this._applySpawnType(this.spawnType, false);
        return panel;
    }

    // --- spawn tool: public API --------------------------------------------

    /** The body the panel currently describes: mass is in SOLAR MASSES. */
    spawnConfig() {
        return {
            type: this.spawnType,
            mass: this.spawnMassValue(),
            composition: this.spawnComposition,
            velocity: this.spawnVelocityMode
        };
    }

    /** Configured mass in solar masses. */
    spawnMassValue() {
        const mass = this.spawnMasses[this.spawnType];
        return (typeof mass === 'number' && isFinite(mass) && mass > 0) ? mass : 0;
    }

    /**
     * The Composition the body would be created with.
     *
     * A star, a brown dwarf or a gas giant MUST get the nebular mix: condensed
     * rock and ice carry gasFraction 0, and classify() would then refuse to call
     * a 1 Msun body a star. The type presets choose 'nebular' for those three
     * for exactly that reason, but the user may override it and the panel says
     * what the result really is.
     *
     * @param {number} [formationRadius] AU, for the automatic composition
     */
    buildSpawnComposition(formationRadius) {
        const radius = this._spawnFormationRadius(formationRadius);
        try {
            if (this.spawnComposition !== 'auto' || typeof Composition !== 'function') {
                return new Composition();
            }
            if (typeof Composition.fromFormationRadius !== 'function') {
                return new Composition();
            }
            const context = this.spawnContext;
            return Composition.fromFormationRadius(
                radius,
                context.starTemperature > 0 ? context.starTemperature : 0,
                context.starRadius > 0 ? context.starRadius : 0
            );
        } catch (e) {
            try {
                return new Composition();
            } catch (e2) {
                return null;
            }
        }
    }

    _spawnFormationRadius(formationRadius) {
        if (typeof formationRadius === 'number' && isFinite(formationRadius) && formationRadius > 0) {
            return formationRadius;
        }
        const context = this.spawnContext;
        if (context && context.radius > 0) {
            return context.radius;
        }
        return 1;
    }

    /**
     * What structure.js says the configured body would be: class, radius,
     * density, luminosity, effective temperature and colour.
     *
     * Memoised, because the render layer asks for the radius once per frame to
     * size the ghost marker and describe() runs eight structure functions.
     */
    spawnDerived(formationRadius) {
        const mass = this.spawnMassValue();
        const radius = this._spawnFormationRadius(formationRadius);
        // quantise the radius so a moving cursor does not invalidate the cache
        // on every pixel; 5% steps are far finer than the composition ramp
        const bucket = (this.spawnComposition === 'auto')
            ? Math.round(Math.log(radius) * 20)
            : 0;
        const key = this.spawnComposition + '|' + mass + '|' + bucket;
        if (this._spawnDerivedKey === key && this._spawnDerivedValue) {
            return this._spawnDerivedValue;
        }

        const composition = this.buildSpawnComposition(radius);
        let info = null;
        if (typeof describe === 'function') {
            try {
                info = describe(mass, composition);
            } catch (e) {
                info = null;
            }
        }
        if (!info) {
            info = {
                radius: 0, density: 0, classification: 'asteroid', classLabel: 'Corpo',
                luminosity: 0, effectiveTemperature: 0, luminous: false
            };
        }
        info.composition = composition;
        info.colorHex = NavigatorUI.spawnColorOf(info, composition);
        this._spawnDerivedKey = key;
        this._spawnDerivedValue = info;
        return info;
    }

    /** Blackbody colour for anything that shines, composition colour otherwise. */
    static spawnColorOf(info, composition) {
        if (info && info.luminous && info.effectiveTemperature > 0 &&
            (info.classification === 'star' || info.classification === 'brownDwarf') &&
            typeof blackbodyColorHex === 'function') {
            try {
                const hex = blackbodyColorHex(info.effectiveTemperature);
                if (typeof hex === 'string' && hex) {
                    return hex;
                }
            } catch (e) { /* fall through */ }
        }
        if (composition && typeof composition.displayColor === 'string' && composition.displayColor) {
            return composition.displayColor;
        }
        return '#8899aa';
    }

    /** Reflect the tool's armed state. Does NOT emit onSpawnArm. */
    setSpawnArmed(armed) {
        this.spawnArmed = !!armed;
        if (this.spawnPanel) {
            this.spawnPanel.classList.toggle('nv-spawn--armed', this.spawnArmed);
            // an armed tool the user cannot see is a trap
            if (this.spawnArmed && this.spawnPanel.classList.contains('nv-panel--collapsed')) {
                this.spawnPanel.classList.remove('nv-panel--collapsed');
                if (this.spawnPanel.nvToggle) {
                    this.spawnPanel.nvToggle.textContent = '−';
                }
            }
        }
        if (this.root) {
            this.root.classList.toggle('nv-root--spawning', this.spawnArmed);
        }
        this._refreshSpawn();
        return this;
    }

    toggleSpawnArmed() {
        const next = !this.spawnArmed;
        this.setSpawnArmed(next);
        if (this.onSpawnArm) {
            this.onSpawnArm(next);
        }
        return this;
    }

    /**
     * Everything the render layer knows about the pending placement: where the
     * ray landed, on which plane, how fast the body would be launched and which
     * star sets the formation temperature.
     */
    setSpawnContext(context) {
        const target = this.spawnContext;
        const source = context || {};
        target.armed = !!source.armed;
        target.ok = !!source.ok;
        target.hovering = !!source.hovering;
        target.plane = (source.plane === 'camera') ? 'camera' : 'disk';
        target.grazing = !!source.grazing;
        target.clamped = !!source.clamped;
        target.radius = NavigatorUI._spawnNumber(source.radius);
        target.focusRadius = NavigatorUI._spawnNumber(source.focusRadius);
        target.speed = NavigatorUI._spawnNumber(source.speed);
        target.centralMass = NavigatorUI._spawnNumber(source.centralMass);
        target.hasFocus = !!source.hasFocus;
        target.starTemperature = NavigatorUI._spawnNumber(source.starTemperature);
        target.starRadius = NavigatorUI._spawnNumber(source.starRadius);
        this._refreshSpawn();
        return this;
    }

    static _spawnNumber(value) {
        return (typeof value === 'number' && isFinite(value) && value > 0) ? value : 0;
    }

    /** How many bodies this tool has created and could still take back. */
    setSpawnUndoCount(count) {
        this.spawnUndoCount = (typeof count === 'number' && count > 0) ? count : 0;
        if (this.spawnUndoButton) {
            this.spawnUndoButton.disabled = this.spawnUndoCount === 0;
            this.spawnUndoButton.textContent = this.spawnUndoCount > 0
                ? 'Desfazer (' + this.spawnUndoCount + ')'
                : 'Desfazer';
        }
        return this;
    }

    setSpawnType(key) {
        this._applySpawnType(key, true);
        return this;
    }

    setSpawnComposition(key) {
        this.spawnComposition = (key === 'nebular') ? 'nebular' : 'auto';
        this._spawnDerivedKey = null;
        this._refreshSpawn();
        this._emitSpawnConfig();
        return this;
    }

    setSpawnVelocityMode(key) {
        this.spawnVelocityMode = (key === 'rest' || key === 'radial') ? key : 'circular';
        this._refreshSpawn();
        this._emitSpawnConfig();
        return this;
    }

    _emitSpawnConfig() {
        if (this.onSpawnConfigChange) {
            try {
                this.onSpawnConfigChange(this.spawnConfig());
            } catch (e) { /* the panel must not depend on the listener */ }
        }
    }

    // --- spawn tool: internals ---------------------------------------------

    _spawnSpec() {
        const rank = NV_SPAWN_TYPE_RANK[this.spawnType];
        return NV_SPAWN_TYPES[rank === undefined ? 1 : rank];
    }

    static spawnUnitFactor(unit) {
        if (unit === 'solar') {
            return 1;
        }
        if (unit === 'jupiter') {
            return (typeof JUPITER_MASS === 'number' && JUPITER_MASS > 0) ? JUPITER_MASS : 9.546e-4;
        }
        return (typeof EARTH_MASS === 'number' && EARTH_MASS > 0) ? EARTH_MASS : 3.003e-6;
    }

    static spawnUnitLabel(unit) {
        if (unit === 'solar') {
            return 'M☉';
        }
        if (unit === 'jupiter') {
            return 'M♃';
        }
        return 'M⊕';
    }

    /** Slider position (0..1000) -> mass in SOLAR masses. */
    _spawnMassFromSlider(value) {
        const spec = this._spawnSpec();
        const factor = NavigatorUI.spawnUnitFactor(spec.unit);
        let t = value / 1000;
        if (!(t >= 0)) { t = 0; }
        if (t > 1) { t = 1; }
        const display = spec.min * Math.pow(spec.max / spec.min, t);
        return display * factor;
    }

    /** Mass in SOLAR masses -> slider position (0..1000). */
    _spawnSliderFromMass(mass) {
        const spec = this._spawnSpec();
        const factor = NavigatorUI.spawnUnitFactor(spec.unit);
        let display = mass / factor;
        if (!(display > 0) || !isFinite(display)) {
            display = spec.preset;
        }
        if (display < spec.min) { display = spec.min; }
        if (display > spec.max) { display = spec.max; }
        const t = Math.log(display / spec.min) / Math.log(spec.max / spec.min);
        return Math.round(Math.max(0, Math.min(1, t)) * 1000);
    }

    /** Set the mass from a value typed in the type's DISPLAY unit. */
    _setSpawnMassDisplay(display, source) {
        const spec = this._spawnSpec();
        let value = display;
        if (!isFinite(value) || !(value > 0)) {
            value = spec.preset;
        }
        if (source === 'commit') {
            // only snap back into range once the user has finished typing
            if (value < spec.min) { value = spec.min; }
            if (value > spec.max) { value = spec.max; }
        }
        this._setSpawnMass(value * NavigatorUI.spawnUnitFactor(spec.unit), source);
    }

    _setSpawnMass(mass, source) {
        if (!(mass > 0) || !isFinite(mass)) {
            return;
        }
        this.spawnMasses[this.spawnType] = mass;
        this._spawnDerivedKey = null;
        this._spawnMassSource = source || '';
        this._refreshSpawn();
        this._spawnMassSource = '';
        this._emitSpawnConfig();
    }

    _applySpawnType(key, emit) {
        const rank = NV_SPAWN_TYPE_RANK[key];
        if (rank !== undefined) {
            this.spawnType = key;
        }
        const spec = this._spawnSpec();
        if (!(this.spawnMasses[this.spawnType] > 0)) {
            this.spawnMasses[this.spawnType] =
                spec.preset * NavigatorUI.spawnUnitFactor(spec.unit);
        }
        // A star made of rock is not a star: the preset picks the composition
        // that lets classify() agree with the button that was pressed.
        this.spawnComposition = spec.composition;
        this._spawnDerivedKey = null;
        this._refreshSpawn();
        if (emit) {
            this._emitSpawnConfig();
        }
    }

    /** Number typed into the mass field: short, and never in exponent soup. */
    static formatSpawnInput(value) {
        if (!isFinite(value) || value <= 0) {
            return '';
        }
        const rounded = Number(value.toPrecision(4));
        if (rounded >= 1e-4 && rounded < 1e6) {
            return String(rounded);
        }
        return rounded.toExponential(3);
    }

    _refreshSpawn() {
        if (!this.spawnPanel) {
            return;
        }
        const spec = this._spawnSpec();
        const write = NavigatorUI._writeStat;
        const context = this.spawnContext;

        // --- controls ------------------------------------------------------
        if (this.spawnArmButton) {
            this.spawnArmButton.textContent = this.spawnArmed
                ? 'Desarmar ferramenta'
                : 'Armar ferramenta';
            this.spawnArmButton.classList.toggle('nv-button--warn', this.spawnArmed);
        }
        NavigatorUI._markGroup(this.spawnTypeButtons, this.spawnType);
        NavigatorUI._markGroup(this.spawnCompositionButtons, this.spawnComposition);
        NavigatorUI._markGroup(this.spawnVelocityButtons, this.spawnVelocityMode);

        const mass = this.spawnMassValue();
        const factor = NavigatorUI.spawnUnitFactor(spec.unit);
        if (this.spawnUnitElement) {
            const label = NavigatorUI.spawnUnitLabel(spec.unit);
            if (this.spawnUnitElement.textContent !== label) {
                this.spawnUnitElement.textContent = label;
            }
        }
        // a 10 Hz refresh must not reformat the field under the caret
        const typing = (typeof document !== 'undefined' &&
            document.activeElement === this.spawnMassInput);
        if (this.spawnMassInput && !typing && this._spawnMassSource !== 'number') {
            const text = NavigatorUI.formatSpawnInput(mass / factor);
            if (this.spawnMassInput.value !== text) {
                this.spawnMassInput.value = text;
            }
        }
        if (this.spawnMassSlider && this._spawnMassSource !== 'slider') {
            const position = String(this._spawnSliderFromMass(mass));
            if (this.spawnMassSlider.value !== position) {
                this.spawnMassSlider.value = position;
            }
        }
        if (this.spawnRangeText) {
            const unitLabel = NavigatorUI.spawnUnitLabel(spec.unit);
            const text = 'Faixa ' + NavigatorUI.formatSpawnInput(spec.min) + ' a ' +
                NavigatorUI.formatSpawnInput(spec.max) + ' ' + unitLabel + '.';
            if (this.spawnRangeText.textContent !== text) {
                this.spawnRangeText.textContent = text;
            }
        }

        // --- what would really be created ----------------------------------
        const derived = this.spawnDerived(context.radius);
        const classification = (derived && typeof derived.classification === 'string')
            ? derived.classification : 'asteroid';

        if (this.spawnBadge) {
            const label = NavigatorUI.classNameOf(classification);
            if (this.spawnBadge.textContent !== label) {
                this.spawnBadge.textContent = label;
                this.spawnBadge.dataset.class = classification;
            }
        }
        if (this.spawnSwatch) {
            const color = (derived && derived.colorHex) ? derived.colorHex : '#8899aa';
            if (this._spawnLastColor !== color) {
                this.spawnSwatch.style.backgroundColor = color;
                this._spawnLastColor = color;
            }
        }

        write(this.spawnFields.mass, mass > 0 ? NavigatorUI.formatMass(mass) : null);
        write(this.spawnFields.radius, (derived && derived.radius > 0)
            ? NavigatorUI.formatRadius(derived.radius) : null);
        write(this.spawnFields.density, (derived && derived.density > 0)
            ? NavigatorUI.formatDensity(derived.density) : null);
        write(this.spawnFields.luminosity, (derived && derived.luminous && derived.luminosity > 0)
            ? NavigatorUI.formatNumber(derived.luminosity) + ' L☉' : null);
        write(this.spawnFields.temperature, (derived && derived.luminous)
            ? NavigatorUI.formatTemperature(derived.effectiveTemperature) : null);

        // --- where the click would land ------------------------------------
        if (context.ok) {
            write(this.spawnFields.plane, context.plane === 'camera'
                ? 'Plano da câmera'
                : 'Plano do disco');
            write(this.spawnFields.distance, NavigatorUI.formatAu(context.radius) +
                (context.clamped ? ' (limitada)' : ''));
            write(this.spawnFields.speed, context.hasFocus
                ? NavigatorUI.formatNumber(context.speed) + ' UA/ano'
                : '0 UA/ano');
        } else {
            write(this.spawnFields.plane, null);
            write(this.spawnFields.distance, null);
            write(this.spawnFields.speed, null);
        }

        // --- the one line that explains the current state -------------------
        let hint;
        if (!this.spawnArmed) {
            hint = 'Arme a ferramenta e clique na cena para posicionar. Arrastar continua girando a câmera.';
        } else if (!context.ok) {
            hint = 'Passe o cursor sobre a cena: um marcador mostra onde o corpo cairia.';
        } else if (context.plane === 'camera') {
            hint = 'Visão de perfil: o disco está quase de lado, então a profundidade vem de um plano voltado para a câmera. Incline a câmera para voltar ao plano do disco.';
        } else if (!context.hasFocus) {
            hint = 'Sem estrela dominante: o corpo nasce parado, seja qual for o modo escolhido.';
        } else if (classification !== this.spawnType) {
            hint = 'Com esta massa e composição, classify() chama o corpo de ' +
                NavigatorUI.classNameOf(classification).toLowerCase() + '.';
        } else if (this.spawnVelocityMode === 'circular') {
            hint = 'Órbita circular prógrada em torno de ' +
                NavigatorUI.formatMass(context.centralMass) + ' a ' +
                NavigatorUI.formatAu(context.focusRadius) + '.';
        } else if (this.spawnVelocityMode === 'rest') {
            hint = 'Em repouso: o corpo cai em direção ao centro de massa.';
        } else {
            hint = 'Queda radial: o corpo cai direto sobre a estrela dominante.';
        }
        if (this.spawnHint && this.spawnHint.textContent !== hint) {
            this.spawnHint.textContent = hint;
        }
    }

    // --- help overlay ------------------------------------------------------

    _buildHelp() {
        const overlay = document.createElement('div');
        overlay.className = 'nv-help';
        const self = this;

        const dialog = document.createElement('div');
        dialog.className = 'nv-help__dialog';

        const header = document.createElement('header');
        header.className = 'nv-help__header';

        const title = document.createElement('h2');
        title.textContent = 'Atalhos do teclado';

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'nv-panel__toggle';
        close.textContent = '×';
        close.setAttribute('aria-label', 'Fechar ajuda');
        close.addEventListener('click', function () {
            self.setHelpVisible(false);
        });

        header.appendChild(title);
        header.appendChild(close);

        const content = document.createElement('div');
        content.className = 'nv-help__content';

        dialog.appendChild(header);
        dialog.appendChild(content);
        overlay.appendChild(dialog);

        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) {
                self.setHelpVisible(false);
            }
        });

        this.helpOverlay = overlay;
        this.helpContent = content;
        return overlay;
    }

    _buildCrosshair() {
        const crosshair = document.createElement('div');
        crosshair.className = 'nv-crosshair';
        this.crosshair = crosshair;
        return crosshair;
    }

    _buildToasts() {
        const holder = document.createElement('div');
        holder.className = 'nv-toasts';
        this.toastHolder = holder;
        return holder;
    }

    // =======================================================================
    // public API
    // =======================================================================

    /**
     * Call once per frame from the render loop. Internally throttled, so the
     * cost per frame is a couple of additions except ~4 times per second.
     * @param {number} dt seconds
     */
    update(dt) {
        if (typeof dt !== 'number' || !isFinite(dt) || dt <= 0) {
            dt = 1 / 60;
        }
        this._frames += 1;
        this._fpsWindow += dt;
        this._accumulator += dt;

        if (this._accumulator < this.refreshInterval) {
            return this;
        }
        this._accumulator = 0;

        if (this._fpsWindow > 0) {
            const instant = this._frames / this._fpsWindow;
            this._fps = this._fps ? this._fps * 0.6 + instant * 0.4 : instant;
        }
        this._frames = 0;
        this._fpsWindow = 0;

        this.refresh(false);
        return this;
    }

    /** Force an immediate refresh of the list, HUD and inspector. */
    refresh(immediate) {
        this._invalidateStats();
        this._refreshList();
        this._refreshHud();
        this._refreshInspector();
        this._statsFresh = false;
        this._statsCache = null;
        if (immediate) {
            this._accumulator = 0;
        }
        return this;
    }

    /**
     * Snow line radius in AU, or NaN. Read every frame by the renderer to place
     * the snow-line ring, so it must stay a plain field read.
     */
    snowLineRadius() {
        return this._snowLine;
    }

    setSelected(planet) {
        this.selected = planet || null;
        this.inspectorPanel.classList.toggle('nv-panel--empty', !this.selected);
        this._invalidateStats();
        this._refreshInspector();
        this._statsFresh = false;
        this._statsCache = null;
        this._markRows();
        return this;
    }

    setFollowing(planet) {
        this.following = planet || null;
        this._markRows();
        this._invalidateStats();
        this._refreshInspector();
        this._statsFresh = false;
        this._statsCache = null;
        return this;
    }

    setMode(mode) {
        this.mode = mode || 'orbit';
        const keys = Object.keys(this.modeButtons || {});
        for (let i = 0; i < keys.length; i++) {
            this.modeButtons[keys[i]].classList.toggle('nv-chip--active', keys[i] === this.mode);
        }
        if (this.crosshair) {
            this.crosshair.classList.toggle('nv-crosshair--on', this.mode === 'fly');
        }
        if (this.hudFields && this.hudFields.mode) {
            NavigatorUI._writeStat(this.hudFields.mode, NavigatorUI.MODE_LABELS[this.mode] || this.mode);
        }
        return this;
    }

    setPaused(isPaused) {
        this.paused = !!isPaused;
        if (this.pauseButton) {
            this.pauseButton.textContent = this.paused ? 'Retomar' : 'Pausar';
            this.pauseButton.classList.toggle('nv-button--warn', this.paused);
        }
        if (this.root) {
            this.root.classList.toggle('nv-root--paused', this.paused);
        }
        return this;
    }

    togglePause() {
        this.setPaused(!this.paused);
        if (this.onPause) {
            this.onPause(this.paused);
        }
        return this;
    }

    /**
     * Name the scenario that is running, in the HUD header and in its own row.
     * Both arguments are optional: whatever is missing simply is not shown.
     */
    setScenario(label, id) {
        const name = (typeof label === 'string' && label) ? label : null;
        const identifier = (typeof id === 'string' && id) ? id : null;
        this.scenarioLabel = name;
        this.scenarioId = identifier;
        if (this.hudPanel && this.hudPanel.nvTitle) {
            this.hudPanel.nvTitle.textContent = name || 'Simulação';
        }
        if (this.hudFields && this.hudFields.scenario) {
            NavigatorUI._writeStat(this.hudFields.scenario, name || identifier);
            if (identifier) {
                this.hudFields.scenario.dd.title = identifier;
            }
        }
        return this;
    }

    /** Reflect the renderer's guide state on the toolbar chip. */
    setGuidesVisible(visible) {
        this.guidesOn = !!visible;
        if (this.guidesButton) {
            this.guidesButton.classList.toggle('nv-chip--active', this.guidesOn);
        }
        return this;
    }

    /** Reflect the renderer's orbit mode on the toolbar (does not emit). */
    setOrbitMode(mode) {
        this.orbitMode = mode || 'none';
        NavigatorUI._markGroup(this.orbitModeButtons, this.orbitMode);
        if (this.orbitBlock) {
            this.orbitBlock.classList.toggle('nv-orbits--off', this.orbitMode === 'none');
        }
        this._refreshOrbitHint();
        return this;
    }

    /** Reflect the renderer's orbit scope on the toolbar (does not emit). */
    setOrbitScope(scope) {
        this.orbitScope = scope || 'top12';
        NavigatorUI._markGroup(this.orbitScopeButtons, this.orbitScope);
        this._refreshOrbitHint();
        return this;
    }

    _refreshOrbitHint() {
        if (!this.orbitHint) {
            return;
        }
        let text;
        if (this.orbitMode === 'none') {
            text = 'Órbitas ocultas. Tecla T alterna.';
        } else if (this.orbitScope === 'all') {
            text = 'Todos os corpos: limitado aos 128 mais massivos, custa caro.';
        } else if (this.orbitScope === 'selected') {
            text = 'Apenas o corpo selecionado e o corpo seguido.';
        } else {
            text = 'Cores das linhas seguem a cor de cada corpo.';
        }
        if (this.orbitHint.textContent !== text) {
            this.orbitHint.textContent = text;
        }
        return this;
    }

    /**
     * @param {number} multiplier
     * @param {boolean} emit fire onSpeedChange
     */
    setSpeed(multiplier, emit) {
        this.speed = multiplier;
        const keys = Object.keys(this.speedButtons || {});
        for (let i = 0; i < keys.length; i++) {
            this.speedButtons[keys[i]].classList.toggle('nv-chip--active', parseFloat(keys[i]) === multiplier);
        }
        if (emit && this.onSpeedChange) {
            this.onSpeedChange(multiplier);
        }
        return this;
    }

    _applySortButtons() {
        const keys = Object.keys(this.sortButtons || {});
        for (let i = 0; i < keys.length; i++) {
            const button = this.sortButtons[keys[i]];
            const active = keys[i] === this.sortKey;
            button.classList.toggle('nv-chip--active', active);
            button.dataset.direction = active ? (this.sortAscending ? 'asc' : 'desc') : '';
        }
        return this;
    }

    setSort(key) {
        if (this.sortKey === key) {
            this.sortAscending = !this.sortAscending;
        } else {
            this.sortKey = key;
            // positions read best outward from the star, magnitudes descending
            this.sortAscending = (key === 'distance' || key === 'axis');
        }
        this._applySortButtons();
        this.refresh(true);
        return this;
    }

    setKeyBindings(bindings) {
        this.bindings = Array.isArray(bindings) ? bindings : [];
        if (!this.helpContent) {
            return this;
        }
        while (this.helpContent.firstChild) {
            this.helpContent.removeChild(this.helpContent.firstChild);
        }
        const groups = [];
        const byGroup = {};
        for (let i = 0; i < this.bindings.length; i++) {
            const binding = this.bindings[i];
            const group = binding.group || 'Geral';
            if (!byGroup[group]) {
                byGroup[group] = [];
                groups.push(group);
            }
            byGroup[group].push(binding);
        }
        for (let g = 0; g < groups.length; g++) {
            const section = document.createElement('div');
            section.className = 'nv-help__group';

            const heading = document.createElement('h3');
            heading.textContent = groups[g];
            section.appendChild(heading);

            const list = document.createElement('dl');
            list.className = 'nv-stats';
            const items = byGroup[groups[g]];
            for (let i = 0; i < items.length; i++) {
                const dt = document.createElement('dt');
                const kbd = document.createElement('kbd');
                kbd.textContent = items[i].keys;
                dt.appendChild(kbd);
                const dd = document.createElement('dd');
                dd.textContent = items[i].description;
                list.appendChild(dt);
                list.appendChild(dd);
            }
            section.appendChild(list);
            this.helpContent.appendChild(section);
        }
        return this;
    }

    setHelpVisible(visible) {
        this.helpVisible = !!visible;
        this.helpOverlay.classList.toggle('nv-help--on', this.helpVisible);
        return this;
    }

    toggleHelp() {
        return this.setHelpVisible(!this.helpVisible);
    }

    /** Transient message in the corner. */
    notify(message) {
        if (!message) {
            return this;
        }
        const toast = document.createElement('div');
        toast.className = 'nv-toast';
        toast.textContent = message;
        this.toastHolder.appendChild(toast);

        const timer = window.setTimeout(function () {
            toast.classList.add('nv-toast--out');
            window.setTimeout(function () {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 400);
        }, 2600);
        this._toastTimers.push(timer);
        if (this._toastTimers.length > 20) {
            this._toastTimers.shift();
        }
        return this;
    }

    dispose() {
        for (let i = 0; i < this._toastTimers.length; i++) {
            window.clearTimeout(this._toastTimers[i]);
        }
        this._toastTimers.length = 0;
        if (this.root && this.root.parentNode) {
            this.root.parentNode.removeChild(this.root);
        }
        return this;
    }

    // =======================================================================
    // refresh internals
    // =======================================================================

    _refreshList() {
        const bodies = this._bodies();
        const camera = this._camera();
        const cameraPosition = camera ? camera.position : null;
        const stats = this._stats();
        const origin = (stats && stats.centerOfMass) ? stats.centerOfMass : null;

        const filter = NavigatorUI.normalizeText(this.filterText);
        const idFilter = /^#(\d+)$/.exec(this.filterText.trim());
        const wantedId = idFilter ? parseInt(idFilter[1], 10) : null;

        const entries = this._entries;
        const tally = this._classTally;
        for (let i = 0; i < NV_CLASSES.length; i++) {
            tally[NV_CLASSES[i].key] = 0;
        }
        this._largestFallback = null;

        let count = 0;
        let total = 0;

        for (let i = 0; i < bodies.length; i++) {
            const planet = bodies[i];
            if (!planet || planet.removed || !planet.position) {
                continue;
            }
            total++;

            const classification = NavigatorUI.classOf(planet);
            tally[classification]++;
            if (!this._largestFallback ||
                (typeof planet.mass === 'number' && planet.mass > this._largestFallback.mass)) {
                this._largestFallback = planet;
            }

            const composition = planet.composition || null;
            const element = (composition && composition.element) ? composition.element : null;

            if (wantedId !== null) {
                if (planet.id !== wantedId) {
                    continue;
                }
            } else if (filter) {
                const name = element ? NavigatorUI.normalizeText(element.name) : '';
                const symbol = element ? NavigatorUI.normalizeText(element.symbol) : '';
                const label = NavigatorUI.classSearchTextOf(classification);
                if (name.indexOf(filter) === -1 &&
                    symbol.indexOf(filter) === -1 &&
                    label.indexOf(filter) === -1) {
                    continue;
                }
            }

            let distance = 0;
            if (cameraPosition) {
                const dx = planet.position.x - cameraPosition.x;
                const dy = planet.position.y - cameraPosition.y;
                const dz = planet.position.z - cameraPosition.z;
                distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            }

            // Semi-major axis when the physics layer caches it on the body,
            // otherwise the orbital radius, which for a near-circular disk is
            // the same number to within the eccentricity. Calling
            // simulation.orbitalElements() for every body every refresh would
            // be 800 solves at 4 Hz; the inspector pays that for one body only.
            let axis = planet.semiMajorAxis;
            if (typeof axis !== 'number' || !isFinite(axis) || axis <= 0) {
                const ox = origin ? origin.x : 0;
                const oy = origin ? origin.y : 0;
                const oz = origin ? origin.z : 0;
                const rx = planet.position.x - ox;
                const ry = planet.position.y - oy;
                const rz = planet.position.z - oz;
                axis = Math.sqrt(rx * rx + ry * ry + rz * rz);
            }

            let entry = entries[count];
            if (!entry) {
                entry = {
                    planet: null, distance: 0, mass: 0, radius: 0,
                    axis: 0, classification: 'asteroid', classRank: 0
                };
                entries[count] = entry;
            }
            entry.planet = planet;
            entry.distance = distance;
            entry.mass = typeof planet.mass === 'number' ? planet.mass : 0;
            entry.radius = typeof planet.radius === 'number' ? planet.radius : 0;
            entry.axis = axis;
            entry.classification = classification;
            entry.classRank = NavigatorUI.classRank(classification);
            count++;
        }

        // release references to bodies that no longer qualify so the pool
        // cannot keep merged/removed planets alive
        for (let i = count; i < entries.length; i++) {
            entries[i].planet = null;
        }

        const slice = entries.slice(0, count);
        const key = this.sortKey;
        const sign = this.sortAscending ? 1 : -1;
        slice.sort(function (a, b) {
            const av = a[key];
            const bv = b[key];
            if (av === bv) {
                return 0;
            }
            return av < bv ? -sign : sign;
        });

        const shown = Math.min(slice.length, this.maxRows);
        this._visible.length = 0;
        for (let i = 0; i < shown; i++) {
            this._visible.push(slice[i].planet);
        }

        this._ensureRows(shown);

        for (let i = 0; i < shown; i++) {
            this._writeRow(this._rows[i], slice[i], i);
        }
        for (let i = shown; i < this._rows.length; i++) {
            this._rows[i].element.style.display = 'none';
        }

        if (count === 0) {
            this.listFooter.textContent = this.filterText
                ? 'Nenhum corpo corresponde à busca.'
                : 'Nenhum corpo na simulação.';
        } else if (count > shown) {
            this.listFooter.textContent = 'Mostrando ' + NavigatorUI.formatInteger(shown) +
                ' de ' + NavigatorUI.formatInteger(count) + ' corpos.';
        } else {
            this.listFooter.textContent = NavigatorUI.formatInteger(count) +
                (count === 1 ? ' corpo.' : ' corpos.');
        }
        this._totalBodies = total;

        this._markRows();
    }

    _ensureRows(needed) {
        while (this._rows.length < needed) {
            this._rows.push(this._createRow(this._rows.length));
        }
        for (let i = 0; i < needed; i++) {
            this._rows[i].element.style.display = '';
        }
    }

    _createRow(index) {
        const element = document.createElement('div');
        element.className = 'nv-row';
        element.dataset.index = String(index);

        const swatch = document.createElement('span');
        swatch.className = 'nv-swatch';

        const label = document.createElement('span');
        label.className = 'nv-row__label';

        const badge = document.createElement('span');
        badge.className = 'nv-badge nv-badge--sm';
        badge.dataset.class = 'asteroid';

        const name = document.createElement('span');
        name.className = 'nv-row__name';

        label.appendChild(badge);
        label.appendChild(name);

        const numbers = document.createElement('span');
        numbers.className = 'nv-row__numbers';

        const value = document.createElement('span');
        value.className = 'nv-row__value';

        const follow = document.createElement('button');
        follow.type = 'button';
        follow.className = 'nv-row__follow';
        follow.dataset.action = 'follow';
        follow.textContent = '⌖';
        follow.title = 'Seguir este corpo';

        element.appendChild(swatch);
        element.appendChild(label);
        element.appendChild(numbers);
        element.appendChild(value);
        element.appendChild(follow);

        this.listElement.appendChild(element);

        return {
            element: element,
            swatch: swatch,
            badge: badge,
            name: name,
            numbers: numbers,
            value: value,
            lastColor: '',
            lastClass: '',
            lastName: '',
            lastNumbers: '',
            lastValue: ''
        };
    }

    _writeRow(row, entry, index) {
        const planet = entry.planet;
        const composition = planet.composition || null;
        const element = (composition && composition.element) ? composition.element : null;

        const color = NavigatorUI.colorOf(planet);
        if (row.lastColor !== color) {
            row.swatch.style.backgroundColor = color;
            row.lastColor = color;
        }

        if (row.lastClass !== entry.classification) {
            row.badge.dataset.class = entry.classification;
            row.badge.textContent = NavigatorUI.classNameOf(entry.classification);
            row.lastClass = entry.classification;
        }

        const name = '#' + (planet.id !== undefined ? planet.id : index) +
            (element && element.symbol ? ' · ' + element.symbol : '');
        if (row.lastName !== name) {
            row.name.textContent = name;
            row.lastName = name;
        }

        const numbers = NavigatorUI.formatMass(entry.mass) +
            '  ·  ' + NavigatorUI.formatRadius(entry.radius) +
            '  ·  a ' + NavigatorUI.formatAu(entry.axis);
        if (row.lastNumbers !== numbers) {
            row.numbers.textContent = numbers;
            row.lastNumbers = numbers;
        }

        // the right-hand column always shows whatever the list is sorted by
        let value;
        switch (this.sortKey) {
            case 'mass': value = NavigatorUI.formatMass(entry.mass); break;
            case 'radius': value = NavigatorUI.formatRadius(entry.radius); break;
            case 'distance': value = NavigatorUI.formatAu(entry.distance); break;
            case 'classRank': value = NavigatorUI.classNameOf(entry.classification); break;
            default: value = NavigatorUI.formatAu(entry.axis); break;
        }
        if (row.lastValue !== value) {
            row.value.textContent = value;
            row.lastValue = value;
        }

        row.element.dataset.index = String(index);
        row.planet = planet;
    }

    _markRows() {
        for (let i = 0; i < this._rows.length; i++) {
            const row = this._rows[i];
            const planet = this._visible[i] || null;
            const isSelected = !!planet && planet === this.selected;
            const isFollowed = !!planet && planet === this.following;
            row.element.classList.toggle('nv-row--selected', isSelected);
            row.element.classList.toggle('nv-row--followed', isFollowed);
        }
    }

    _refreshHud() {
        const fields = this.hudFields;
        const stats = this._stats();
        const write = NavigatorUI._writeStat;

        // --- time ----------------------------------------------------------
        let time = (stats && typeof stats.simulatedTime === 'number') ? stats.simulatedTime : NaN;
        if (!isFinite(time) && this.getTime) {
            try {
                const value = this.getTime();
                if (typeof value === 'number') {
                    time = value;
                }
            } catch (e) { /* ignore */ }
        }
        write(fields.time, isFinite(time) ? NavigatorUI.formatYears(time) : null);

        let rate = NaN;
        if (this.getRate) {
            try {
                const value = this.getRate();
                if (typeof value === 'number') {
                    rate = value;
                }
            } catch (e) { /* ignore */ }
        }
        write(fields.rate, (isFinite(rate) && rate > 0)
            ? NavigatorUI.formatNumber(rate) + ' anos/s'
            : null);

        // --- counts --------------------------------------------------------
        const count = (stats && typeof stats.count === 'number')
            ? stats.count
            : (this._totalBodies || 0);
        write(fields.count, NavigatorUI.formatInteger(count));

        // classCounts may arrive as a plain object or as a Map; anything else
        // falls back to the tally this panel computed while walking the bodies.
        const published = (stats && stats.classCounts) ? stats.classCounts : null;
        const publishedIsMap = !!published && typeof published.get === 'function';
        for (let i = 0; i < NV_CLASSES.length; i++) {
            const key = NV_CLASSES[i].key;
            const chip = this.classChips[key];
            if (!chip) {
                continue;
            }
            let value;
            if (publishedIsMap) {
                value = published.get(key);
            } else if (published) {
                value = published[key];
            }
            if (typeof value !== 'number' || !isFinite(value)) {
                value = this._classTally[key] || 0;
            }
            const text = NavigatorUI.formatInteger(value);
            if (chip.last !== text) {
                chip.count.textContent = text;
                chip.last = text;
            }
            chip.chip.classList.toggle('nv-classchip--zero', !(value > 0));
        }

        // --- masses and structure ------------------------------------------
        write(fields.totalMass, (stats && typeof stats.totalMass === 'number')
            ? NavigatorUI.formatMass(stats.totalMass)
            : null);

        const snowLine = (stats && typeof stats.snowLineRadius === 'number' &&
            isFinite(stats.snowLineRadius) && stats.snowLineRadius > 0)
            ? stats.snowLineRadius
            : NaN;
        this._snowLine = snowLine;
        write(fields.snowLine, isFinite(snowLine) ? NavigatorUI.formatAu(snowLine) : null);

        const largest = (stats && stats.largestBody) ? stats.largestBody : this._largestFallback;
        write(fields.largest, NavigatorUI.describeBody(largest));

        // --- conservation ---------------------------------------------------
        write(fields.kinetic, (stats && typeof stats.kineticEnergy === 'number')
            ? NavigatorUI.formatNumber(stats.kineticEnergy) : null);
        write(fields.potential, (stats && typeof stats.potentialEnergy === 'number')
            ? NavigatorUI.formatNumber(stats.potentialEnergy) : null);
        write(fields.total, (stats && typeof stats.totalEnergy === 'number')
            ? NavigatorUI.formatNumber(stats.totalEnergy) : null);
        write(fields.momentum, (stats && stats.momentum)
            ? NavigatorUI.formatNumber(NavigatorUI.magnitudeOf(stats.momentum)) : null);

        write(fields.fps, this._fps ? this._fps.toFixed(0) : '—');
        write(fields.mode, NavigatorUI.MODE_LABELS[this.mode] || this.mode);

        // The scenario is set once per run by setScenario(); stats.scenarioId
        // only overrides it when the physics layer disagrees with what we were
        // told, which happens when a build falls back to another scenario.
        const publishedId = (stats && typeof stats.scenarioId === 'string' && stats.scenarioId)
            ? stats.scenarioId
            : null;
        if (publishedId && publishedId !== this.scenarioId && !this.scenarioLabel) {
            this.setScenario(publishedId, publishedId);
        }
    }

    _refreshInspector() {
        const planet = this.selected;
        const fields = this.inspectorFields;
        const write = NavigatorUI._writeStat;

        if (!planet || planet.removed) {
            this.inspectorPanel.classList.add('nv-panel--empty');
            this.inspectorName.textContent = 'Nenhum corpo selecionado';
            this.inspectorBadge.textContent = '—';
            this.inspectorBadge.dataset.class = 'asteroid';
            this.inspectorSwatch.style.backgroundColor = 'transparent';
            const keys = Object.keys(fields);
            for (let i = 0; i < keys.length; i++) {
                write(fields[keys[i]], '—');
            }
            this._writeComposition(null);
            this.inspectorButtons.follow.disabled = true;
            this.inspectorButtons.frame.disabled = true;
            this.inspectorButtons.release.disabled = !this.following;
            return;
        }

        this.inspectorPanel.classList.remove('nv-panel--empty');
        this.inspectorButtons.follow.disabled = false;
        this.inspectorButtons.frame.disabled = false;
        this.inspectorButtons.release.disabled = !this.following;
        this.inspectorButtons.follow.textContent = (this.following === planet) ? 'Seguindo' : 'Seguir';

        const classification = NavigatorUI.classOf(planet);
        this.inspectorSwatch.style.backgroundColor = NavigatorUI.colorOf(planet);
        this.inspectorBadge.dataset.class = classification;
        this.inspectorBadge.textContent = (typeof planet.classLabel === 'string' && planet.classLabel)
            ? planet.classLabel
            : NavigatorUI.classNameOf(classification);

        const composition = planet.composition || null;
        const element = (composition && composition.element) ? composition.element : null;
        this.inspectorName.textContent = 'Corpo #' +
            (planet.id !== undefined ? planet.id : '?') +
            (element && element.symbol ? '  ·  ' + element.symbol : '');

        // --- structure ------------------------------------------------------
        write(fields.mass, typeof planet.mass === 'number'
            ? NavigatorUI.formatMass(planet.mass) : null);
        write(fields.radius, typeof planet.radius === 'number'
            ? NavigatorUI.formatRadius(planet.radius) : null);
        write(fields.density, typeof planet.density === 'number'
            ? NavigatorUI.formatDensity(planet.density) : null);
        write(fields.centralTemperature, NavigatorUI.formatTemperature(planet.centralTemperature));
        write(fields.effectiveTemperature, NavigatorUI.formatTemperature(planet.effectiveTemperature));

        // A rocky body's "luminosity" is a rounding error; only print it when it
        // is a number a reader could act on.
        const bodyLuminosity = planet.luminosity;
        write(fields.luminosity,
            (typeof bodyLuminosity === 'number' && isFinite(bodyLuminosity) && bodyLuminosity >= 1e-6)
                ? NavigatorUI.formatNumber(bodyLuminosity) + ' L☉'
                : null);

        // --- orbit -----------------------------------------------------------
        let axis = NaN;
        let eccentricity = NaN;
        let elements = null;
        if (this.getOrbit) {
            try { elements = this.getOrbit(planet); } catch (e) { elements = null; }
        }
        if (elements) {
            if (typeof elements.semiMajorAxis === 'number') {
                axis = elements.semiMajorAxis;
            }
            if (typeof elements.eccentricity === 'number') {
                eccentricity = elements.eccentricity;
            }
        }
        if (!isFinite(axis) && typeof planet.semiMajorAxis === 'number') {
            axis = planet.semiMajorAxis;
        }
        if (!isFinite(eccentricity) && typeof planet.eccentricity === 'number') {
            eccentricity = planet.eccentricity;
        }

        const validAxis = isFinite(axis) && axis > 0;
        write(fields.axis, validAxis ? NavigatorUI.formatAu(axis) : null);
        write(fields.eccentricity, (isFinite(eccentricity) && eccentricity >= 0)
            ? NavigatorUI.formatDecimal(eccentricity, 3)
            : null);

        let period = (elements && typeof elements.period === 'number') ? elements.period : NaN;
        if (!isFinite(period) && validAxis && typeof orbitalPeriod === 'function') {
            const centralMass = this._centralMass();
            if (centralMass > 0) {
                try { period = orbitalPeriod(axis, centralMass); } catch (e) { period = NaN; }
            }
        }
        write(fields.period, (isFinite(period) && period > 0)
            ? NavigatorUI.formatYears(period)
            : null);

        write(fields.speed, planet.velocity
            ? NavigatorUI.formatNumber(NavigatorUI.magnitudeOf(planet.velocity)) + ' UA/ano'
            : null);

        const camera = this._camera();
        if (camera && planet.position) {
            const dx = planet.position.x - camera.position.x;
            const dy = planet.position.y - camera.position.y;
            const dz = planet.position.z - camera.position.z;
            write(fields.distance, NavigatorUI.formatAu(Math.sqrt(dx * dx + dy * dy + dz * dz)));
        } else {
            write(fields.distance, null);
        }

        this._writeComposition(composition);
    }

    /** Stacked bar + legend + the composition's own one-line summary. */
    _writeComposition(composition) {
        const parts = this.compositionParts;
        const keys = ['gas', 'ice', 'rock', 'metal'];

        let categories = null;
        if (composition) {
            try {
                categories = composition.categories || {
                    gas: composition.gasFraction,
                    ice: composition.iceFraction,
                    rock: composition.rockFraction,
                    metal: composition.metalFraction
                };
            } catch (e) {
                categories = null;
            }
        }

        let sum = 0;
        if (categories) {
            for (let i = 0; i < keys.length; i++) {
                const value = categories[keys[i]];
                if (typeof value === 'number' && isFinite(value) && value > 0) {
                    sum += value;
                }
            }
        }

        for (let i = 0; i < keys.length; i++) {
            const part = parts[keys[i]];
            if (!part) {
                continue;
            }
            let fraction = 0;
            if (sum > 0) {
                const value = categories[keys[i]];
                fraction = (typeof value === 'number' && isFinite(value) && value > 0) ? value / sum : 0;
            }
            const width = (fraction * 100).toFixed(2) + '%';
            if (part.lastWidth !== width) {
                part.segment.style.width = width;
                part.lastWidth = width;
            }
            const text = sum > 0 ? NavigatorUI.formatPercent(fraction) : '—';
            if (part.last !== text) {
                part.value.textContent = text;
                part.last = text;
            }
        }

        let summary = '—';
        if (composition && typeof composition.describe === 'function') {
            try {
                const described = composition.describe();
                if (typeof described === 'string' && described) {
                    summary = described;
                }
            } catch (e) { /* keep the dash */ }
        }
        if (summary === '—' && composition && composition.element && composition.element.name) {
            summary = 'Predominante: ' + composition.element.name;
        }
        if (this.compositionSummary.textContent !== summary) {
            this.compositionSummary.textContent = summary;
        }
        this.compositionBlock.classList.toggle('nv-hidden', !composition);
    }

    /**
     * Mass of whatever the bodies orbit, for the orbital period. Prefers the
     * live star, falls back to the configured star mass, then to 1 Msun.
     */
    _centralMass() {
        const bodies = this._bodies();
        for (let i = 0; i < bodies.length; i++) {
            const body = bodies[i];
            if (body && !body.removed && body.isCentralStar === true && typeof body.mass === 'number') {
                return body.mass;
            }
        }
        if (typeof STAR_MASS === 'number' && STAR_MASS > 0) {
            return STAR_MASS;
        }
        return 1;
    }

    // =======================================================================
    // small helpers
    // =======================================================================

    _bodies() {
        let bodies;
        try { bodies = this.getBodies(); } catch (e) { bodies = null; }
        return Array.isArray(bodies) ? bodies : [];
    }

    _invalidateStats() {
        this._statsFresh = false;
        this._statsCache = null;
    }

    /**
     * `simulation.stats` sums the potential energy, which is O(n^2) over 800
     * bodies. Fetching it once per refresh instead of once per consumer is the
     * difference between 0.6M and 1.8M operations a second.
     */
    _stats() {
        if (this._statsFresh) {
            return this._statsCache;
        }
        let stats;
        try { stats = this.getStats(); } catch (e) { stats = null; }
        this._statsCache = stats || null;
        this._statsFresh = true;
        return this._statsCache;
    }

    _camera() {
        let camera;
        try { camera = this.getCamera(); } catch (e) { camera = null; }
        return (camera && camera.position) ? camera : null;
    }

    _blur(element) {
        // buttons must not keep focus, otherwise Space would re-trigger them
        if (element && element.blur) {
            element.blur();
        }
    }

    static get MODE_LABELS() {
        return { orbit: 'Órbita', fly: 'Livre', follow: 'Seguindo' };
    }

    /** planet.color() first, then the composition colour, then a neutral grey. */
    static colorOf(planet) {
        if (planet) {
            if (typeof planet.color === 'function') {
                try {
                    const value = planet.color();
                    if (typeof value === 'string' && value) {
                        return value;
                    }
                } catch (e) { /* fall through */ }
            }
            const composition = planet.composition;
            if (composition && typeof composition.displayColor === 'string') {
                return composition.displayColor;
            }
        }
        return '#8899aa';
    }

    static magnitudeOf(vector) {
        if (!vector) {
            return 0;
        }
        if (typeof vector.magnitude === 'function') {
            return vector.magnitude();
        }
        const x = vector.x || 0;
        const y = vector.y || 0;
        const z = vector.z || 0;
        return Math.sqrt(x * x + y * y + z * z);
    }

    /** "Planeta #42 · 3,1 M⊕" for the HUD's largest-body row. */
    static describeBody(planet) {
        if (planet === null || planet === undefined) {
            return null;
        }
        // some builds of the contract report the largest body as a bare mass
        if (typeof planet === 'number') {
            return NavigatorUI.formatMass(planet);
        }
        if (typeof planet !== 'object') {
            return null;
        }
        const label = (typeof planet.classLabel === 'string' && planet.classLabel)
            ? planet.classLabel
            : NavigatorUI.classNameOf(NavigatorUI.classOf(planet));
        const id = (planet.id !== undefined) ? ' #' + planet.id : '';
        const mass = (typeof planet.mass === 'number')
            ? '  ·  ' + NavigatorUI.formatMass(planet.mass)
            : '';
        return label + id + mass;
    }

    // --- number formatting (pt-BR) -----------------------------------------

    static formatInteger(value) {
        if (typeof value !== 'number' || !isFinite(value)) {
            return '—';
        }
        return Math.round(value).toLocaleString('pt-BR');
    }

    static formatDecimal(value, digits) {
        if (typeof value !== 'number' || !isFinite(value)) {
            return '—';
        }
        return value.toLocaleString('pt-BR', {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits
        });
    }

    /**
     * Compact pt-BR formatting that survives 1e-9 .. 1e30. Scientific notation
     * only where a decimal string would be unreadable.
     */
    static formatNumber(value) {
        if (typeof value !== 'number' || !isFinite(value)) {
            return '—';
        }
        if (value === 0) {
            return '0';
        }
        const magnitude = Math.abs(value);
        if (magnitude >= 1e6 || magnitude < 1e-3) {
            return value.toExponential(2).replace('.', ',').replace('e+', 'e');
        }
        if (magnitude >= 1000) {
            return value.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
        }
        if (magnitude >= 10) {
            return value.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
        }
        if (magnitude >= 1) {
            return value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
        }
        return value.toLocaleString('pt-BR', { maximumFractionDigits: 4 });
    }

    static formatPercent(fraction) {
        if (typeof fraction !== 'number' || !isFinite(fraction)) {
            return '—';
        }
        const percent = fraction * 100;
        if (percent > 0 && percent < 0.1) {
            return '< 0,1%';
        }
        if (percent >= 10) {
            return NavigatorUI.formatDecimal(percent, 0) + '%';
        }
        return NavigatorUI.formatDecimal(percent, 1) + '%';
    }

    /** Simulated time, in years. Thousands and millions get words, not zeros. */
    static formatYears(years) {
        if (typeof years !== 'number' || !isFinite(years)) {
            return '—';
        }
        const magnitude = Math.abs(years);
        if (magnitude >= 1e9) {
            return NavigatorUI.formatDecimal(years / 1e9, 2) + ' bi de anos';
        }
        if (magnitude >= 1e6) {
            return NavigatorUI.formatDecimal(years / 1e6, 2) + ' mi de anos';
        }
        if (magnitude >= 1000) {
            return years.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + ' anos';
        }
        if (magnitude >= 10) {
            return NavigatorUI.formatDecimal(years, 1) + ' anos';
        }
        if (magnitude >= 0.01) {
            return NavigatorUI.formatDecimal(years, 3) + ' anos';
        }
        if (magnitude === 0) {
            return '0 anos';
        }
        return NavigatorUI.formatNumber(years) + ' anos';
    }

    /** Distances in the disk are AU (UA in pt-BR) and never anything else. */
    static formatAu(value) {
        if (typeof value !== 'number' || !isFinite(value)) {
            return '—';
        }
        const magnitude = Math.abs(value);
        if (magnitude === 0) {
            return '0 UA';
        }
        if (magnitude < 1e-3) {
            return NavigatorUI.formatNumber(value) + ' UA';
        }
        if (magnitude < 0.1) {
            return NavigatorUI.formatDecimal(value, 4) + ' UA';
        }
        if (magnitude < 100) {
            return NavigatorUI.formatDecimal(value, 2) + ' UA';
        }
        return value.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + ' UA';
    }

    /**
     * Mass in the unit a human would use for that body: Earth masses for
     * planets, Jupiter masses for giants, solar masses for stars. A 1 Msun star
     * must never read "332946 M⊕".
     */
    static formatMass(solarMasses) {
        if (typeof solarMasses !== 'number' || !isFinite(solarMasses)) {
            return '—';
        }
        if (solarMasses === 0) {
            return '0 M⊕';
        }
        const earthMass = (typeof EARTH_MASS === 'number' && EARTH_MASS > 0) ? EARTH_MASS : 3.003e-6;
        const jupiterMass = (typeof JUPITER_MASS === 'number' && JUPITER_MASS > 0) ? JUPITER_MASS : 9.546e-4;

        const earths = solarMasses / earthMass;
        if (Math.abs(earths) < 300) {
            return NavigatorUI.formatNumber(earths) + ' M⊕';
        }
        const jupiters = solarMasses / jupiterMass;
        // 80 Jupiters is the hydrogen burning limit: above it, solar masses.
        if (Math.abs(jupiters) < 80) {
            return NavigatorUI.formatNumber(jupiters) + ' M♃';
        }
        return NavigatorUI.formatNumber(solarMasses) + ' M☉';
    }

    /** Radius in Earth / Jupiter / solar radii, chosen the same way. */
    static formatRadius(au) {
        if (typeof au !== 'number' || !isFinite(au) || au <= 0) {
            return '—';
        }
        const earthRadius = (typeof EARTH_RADIUS === 'number' && EARTH_RADIUS > 0) ? EARTH_RADIUS : 4.259e-5;
        const jupiterRadius = (typeof JUPITER_RADIUS === 'number' && JUPITER_RADIUS > 0) ? JUPITER_RADIUS : 4.673e-4;
        const solarRadius = (typeof SOLAR_RADIUS === 'number' && SOLAR_RADIUS > 0) ? SOLAR_RADIUS : 4.650e-3;

        // 1 Jupiter radius is 11 Earth radii, so switching at 10 keeps giants
        // reading as "1 R♃" instead of "11 R⊕" while Neptune stays in R⊕.
        const earths = au / earthRadius;
        if (earths < 10) {
            return NavigatorUI.formatNumber(earths) + ' R⊕';
        }
        const jupiters = au / jupiterRadius;
        if (jupiters < 3) {
            return NavigatorUI.formatNumber(jupiters) + ' R♃';
        }
        return NavigatorUI.formatNumber(au / solarRadius) + ' R☉';
    }

    /** Msun/AU^3 -> g/cm^3, the unit densities are actually quoted in. */
    static formatDensity(density) {
        if (typeof density !== 'number' || !isFinite(density) || density <= 0) {
            return '—';
        }
        let cgs = density;
        if (typeof densityToGramsPerCm3 === 'function') {
            try { cgs = densityToGramsPerCm3(density); } catch (e) { cgs = density; }
        }
        if (!isFinite(cgs) || cgs <= 0) {
            return '—';
        }
        return NavigatorUI.formatNumber(cgs) + ' g/cm³';
    }

    static formatTemperature(kelvin) {
        if (typeof kelvin !== 'number' || !isFinite(kelvin) || kelvin <= 0) {
            return null;
        }
        if (kelvin >= 1e5) {
            return NavigatorUI.formatNumber(kelvin) + ' K';
        }
        return kelvin.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + ' K';
    }

    static normalizeText(text) {
        if (!text) {
            return '';
        }
        let value = String(text).toLowerCase();
        if (value.normalize) {
            value = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        }
        return value.trim();
    }
}

/**
 * ScenarioPicker
 *
 * The launch screen: an overlay shown BEFORE the simulation starts, and again
 * whenever the user asks for a different scenario.
 *
 * IT KNOWS NOTHING ABOUT ANY PARTICULAR SCENARIO. The cards come from the
 * SCENARIOS registry and every control is generated from the `params` array of
 * the selected descriptor, following the ParamSpec schema (`int`, `float`,
 * `bool`, `choice`). Adding a scenario, or a parameter to one, changes nothing
 * here.
 *
 * DEFENSIVE BY DESIGN. The registry may be missing, empty or malformed, and
 * buildScenario may throw: every one of those paths ends in a readable pt-BR
 * message plus a way to start something, never in a blank page.
 *
 * No modules, no build step: this declares a global class.
 * All user-facing strings are pt-BR.
 */

/** pt-BR names for the contract's categories; anything else is shown verbatim. */
const NV_CATEGORY_LABELS = {
    sistema: 'Sistema planetário',
    multiplo: 'Múltiplas estrelas',
    colisao: 'Colisão',
    aglomerado: 'Aglomerado',
    'buraco-negro': 'Buraco negro',
    custom: 'Personalizado'
};

class ScenarioPicker {

    /**
     * @param {Object} options
     *   mount        {HTMLElement}                     default document.body
     *   getScenarios {Function} () => descriptor[]
     *   getDefaultId {Function} () => string|null
     *   getDefaults  {Function} (id) => {key: value}
     *   onStart      {Function} (id|null, params) => void
     *   onCancel     {Function} () => void             "Voltar à simulação"
     */
    constructor(options) {
        options = options || {};
        this.options = options;
        this.mount = options.mount || document.body;

        this.getScenarios = typeof options.getScenarios === 'function'
            ? options.getScenarios : function () { return []; };
        this.getDefaultId = typeof options.getDefaultId === 'function'
            ? options.getDefaultId : function () { return null; };
        this.getDefaults = typeof options.getDefaults === 'function'
            ? options.getDefaults : function () { return {}; };
        this.onStart = options.onStart || null;
        this.onCancel = options.onCancel || null;

        // per-scenario parameter values, kept across show/hide so a "Trocar
        // cenário" does not silently throw away what the user typed
        this.values = Object.create(null);
        this.scenarios = [];
        this.selectedId = null;
        this.category = 'all';
        this.visible = false;
        this.errorText = '';
        this.cards = [];
        this.controls = [];
        this.allowCancel = false;

        this._onKeyDown = this._handleKeyDown.bind(this);
        this._build();
    }

    // =======================================================================
    // DOM
    // =======================================================================

    _build() {
        const self = this;

        const root = document.createElement('div');
        root.className = 'nv-launch';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', 'Escolha do cenário');

        const dialog = document.createElement('div');
        dialog.className = 'nv-launch__dialog';

        // --- header --------------------------------------------------------
        const header = document.createElement('header');
        header.className = 'nv-launch__header';

        const title = document.createElement('h1');
        title.className = 'nv-launch__title';
        title.textContent = 'Simulação do Universo';

        const subtitle = document.createElement('p');
        subtitle.className = 'nv-launch__subtitle';
        subtitle.textContent = 'Escolha o que simular e ajuste os parâmetros antes de começar.';

        header.appendChild(title);
        header.appendChild(subtitle);
        dialog.appendChild(header);

        // --- body: cards on the left, parameters on the right --------------
        const body = document.createElement('div');
        body.className = 'nv-launch__body';

        const left = document.createElement('div');
        left.className = 'nv-launch__left';

        const filters = document.createElement('div');
        filters.className = 'nv-launch__filters';
        filters.setAttribute('role', 'group');
        filters.setAttribute('aria-label', 'Filtrar por categoria');
        this.filterRow = filters;
        left.appendChild(filters);

        const cards = document.createElement('div');
        cards.className = 'nv-launch__cards';
        cards.setAttribute('role', 'radiogroup');
        cards.setAttribute('aria-label', 'Cenários disponíveis');
        cards.addEventListener('keydown', function (event) {
            self._handleCardKey(event);
        });
        this.cardList = cards;
        left.appendChild(cards);

        const right = document.createElement('div');
        right.className = 'nv-launch__right';

        const detailName = document.createElement('h2');
        detailName.className = 'nv-launch__name';
        detailName.textContent = 'Nenhum cenário selecionado';
        this.detailName = detailName;

        const detailBadge = document.createElement('span');
        detailBadge.className = 'nv-launch__category';
        this.detailBadge = detailBadge;

        const detailHead = document.createElement('div');
        detailHead.className = 'nv-launch__detailhead';
        detailHead.appendChild(detailName);
        detailHead.appendChild(detailBadge);

        const detailText = document.createElement('p');
        detailText.className = 'nv-launch__description';
        this.detailText = detailText;

        const params = document.createElement('div');
        params.className = 'nv-params';
        this.paramsHolder = params;

        const kept = document.createElement('p');
        kept.className = 'nv-launch__kept nv-hidden';
        kept.textContent = 'Os parâmetros da última execução foram mantidos. ' +
            'Use "Restaurar padrões" para voltar aos valores originais.';
        this.keptNotice = kept;

        right.appendChild(detailHead);
        right.appendChild(detailText);
        right.appendChild(kept);
        right.appendChild(params);

        body.appendChild(left);
        body.appendChild(right);
        dialog.appendChild(body);

        // --- error banner ---------------------------------------------------
        const error = document.createElement('div');
        error.className = 'nv-launch__error nv-hidden';
        error.setAttribute('role', 'alert');

        const errorText = document.createElement('p');
        error.appendChild(errorText);
        this.errorBox = error;
        this.errorMessage = errorText;

        const fallback = document.createElement('button');
        fallback.type = 'button';
        fallback.className = 'nv-button';
        fallback.textContent = 'Iniciar a simulação padrão';
        fallback.addEventListener('click', function () {
            self._emitStart(null, null);
        });
        this.fallbackButton = fallback;
        error.appendChild(fallback);
        dialog.appendChild(error);

        // --- footer ---------------------------------------------------------
        const footer = document.createElement('footer');
        footer.className = 'nv-launch__footer';

        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'nv-button';
        reset.textContent = 'Restaurar padrões';
        reset.title = 'Voltar todos os parâmetros deste cenário aos valores originais';
        reset.addEventListener('click', function () {
            self.resetDefaults();
        });
        this.resetButton = reset;

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'nv-button nv-hidden';
        cancel.textContent = 'Voltar à simulação';
        cancel.addEventListener('click', function () {
            if (self.onCancel) { self.onCancel(); }
        });
        this.cancelButton = cancel;

        const start = document.createElement('button');
        start.type = 'button';
        start.className = 'nv-button nv-button--primary nv-launch__start';
        start.textContent = 'Iniciar simulação';
        start.addEventListener('click', function () {
            self.start();
        });
        this.startButton = start;

        const spacer = document.createElement('span');
        spacer.className = 'nv-launch__spacer';

        footer.appendChild(reset);
        footer.appendChild(spacer);
        footer.appendChild(cancel);
        footer.appendChild(start);
        dialog.appendChild(footer);

        root.appendChild(dialog);
        this.root = root;
        this.mount.appendChild(root);
    }

    // =======================================================================
    // public API
    // =======================================================================

    isVisible() {
        return this.visible;
    }

    /**
     * @param {Object} [options]
     *   scenarioId     {string}  pre-select this scenario
     *   allowCancel    {boolean} show "Voltar à simulação"
     *   keptParameters {boolean} explain that the previous values were kept
     */
    show(options) {
        options = options || {};
        this.allowCancel = !!options.allowCancel;
        this.cancelButton.classList.toggle('nv-hidden', !this.allowCancel);
        this.keptNotice.classList.toggle('nv-hidden', !options.keptParameters);

        this._readRegistry();
        this._renderFilters();
        this._renderCards();

        let wanted = (typeof options.scenarioId === 'string' && options.scenarioId)
            ? options.scenarioId
            : this.selectedId;
        if (!this._find(wanted)) {
            wanted = null;
        }
        if (!wanted) {
            let fallback = null;
            try { fallback = this.getDefaultId(); } catch (e) { fallback = null; }
            wanted = (fallback && this._find(fallback))
                ? fallback
                : (this.scenarios.length > 0 ? this.scenarios[0].id : null);
        }
        this.select(wanted);

        this.visible = true;
        this.root.classList.add('nv-launch--on');
        // removed first: show() may be called twice in a row (a failed build
        // re-shows the screen) and the listener must not stack up.
        document.removeEventListener('keydown', this._onKeyDown, true);
        document.addEventListener('keydown', this._onKeyDown, true);

        // focus something useful, but never trap focus inside the dialog
        const focusTarget = this._selectedCard() || this.startButton;
        if (focusTarget && focusTarget.focus) {
            try { focusTarget.focus(); } catch (e) { /* ignore */ }
        }
        return this;
    }

    hide() {
        this.visible = false;
        this.root.classList.remove('nv-launch--on');
        document.removeEventListener('keydown', this._onKeyDown, true);
        return this;
    }

    /** An empty message clears the banner. */
    setError(message) {
        this.errorText = (typeof message === 'string') ? message : '';
        const empty = !this.errorText;
        this.errorMessage.textContent = this.errorText;
        this.errorBox.classList.toggle('nv-hidden', empty);
        return this;
    }

    dispose() {
        document.removeEventListener('keydown', this._onKeyDown, true);
        if (this.root && this.root.parentNode) {
            this.root.parentNode.removeChild(this.root);
        }
        this.cards.length = 0;
        this.controls.length = 0;
        return this;
    }

    /** Select a scenario by id and regenerate its parameter controls. */
    select(id) {
        const scenario = this._find(id);
        this.selectedId = scenario ? scenario.id : null;

        for (let i = 0; i < this.cards.length; i++) {
            const card = this.cards[i];
            const active = !!scenario && card.dataset.scenario === scenario.id;
            card.classList.toggle('nv-scenario--active', active);
            card.setAttribute('aria-checked', active ? 'true' : 'false');
        }

        if (!scenario) {
            this.detailName.textContent = 'Nenhum cenário disponível';
            this.detailBadge.textContent = '';
            this.detailBadge.classList.add('nv-hidden');
            this.detailText.textContent =
                'Escolher um cenário exige a lista de cenários, que não foi carregada. ' +
                'Você ainda pode iniciar a simulação padrão.';
            this._clearParams();
            this.startButton.disabled = true;
            this.resetButton.disabled = true;
            if (!this.errorText) {
                this.setError('A lista de cenários não foi carregada.');
            }
            return this;
        }

        this.startButton.disabled = false;
        this.detailName.textContent = ScenarioPicker.textOf(scenario.name, scenario.id);
        const category = ScenarioPicker.categoryLabel(scenario.category);
        this.detailBadge.textContent = category;
        this.detailBadge.classList.toggle('nv-hidden', !category);
        if (scenario.category) {
            this.detailBadge.dataset.category = String(scenario.category);
        }
        this.detailText.textContent = ScenarioPicker.textOf(scenario.description, '');
        this._renderParams(scenario);
        return this;
    }

    /** Put every parameter of the selected scenario back to its default. */
    resetDefaults() {
        if (!this.selectedId) {
            return this;
        }
        delete this.values[this.selectedId];
        this.keptNotice.classList.add('nv-hidden');
        const scenario = this._find(this.selectedId);
        if (scenario) {
            this._renderParams(scenario);
        }
        return this;
    }

    /** The parameters as they would be handed to buildScenario(). */
    collectParams() {
        const scenario = this._find(this.selectedId);
        if (!scenario) {
            return {};
        }
        const specs = ScenarioPicker.specsOf(scenario);
        const stored = this._valuesFor(scenario);
        const out = {};
        for (let i = 0; i < specs.length; i++) {
            const spec = specs[i];
            out[spec.key] = ScenarioPicker.clampValue(spec, stored[spec.key]);
        }
        return out;
    }

    start() {
        if (!this.selectedId) {
            this._emitStart(null, null);
            return this;
        }
        this._emitStart(this.selectedId, this.collectParams());
        return this;
    }

    // =======================================================================
    // internals
    // =======================================================================

    _emitStart(id, params) {
        if (this.onStart) {
            this.onStart(id, params);
        }
    }

    _readRegistry() {
        let list;
        try { list = this.getScenarios(); } catch (e) { list = null; }
        this.scenarios = Array.isArray(list) ? list.filter(function (scenario) {
            return scenario && typeof scenario === 'object' &&
                typeof scenario.id === 'string' && scenario.id;
        }) : [];
        return this.scenarios;
    }

    _find(id) {
        if (typeof id !== 'string' || !id) {
            return null;
        }
        for (let i = 0; i < this.scenarios.length; i++) {
            if (this.scenarios[i].id === id) {
                return this.scenarios[i];
            }
        }
        return null;
    }

    _selectedCard() {
        for (let i = 0; i < this.cards.length; i++) {
            if (this.cards[i].dataset.scenario === this.selectedId) {
                return this.cards[i];
            }
        }
        return null;
    }

    _renderFilters() {
        const self = this;
        const row = this.filterRow;
        while (row.firstChild) {
            row.removeChild(row.firstChild);
        }
        const seen = [];
        for (let i = 0; i < this.scenarios.length; i++) {
            const category = this.scenarios[i].category;
            if (typeof category === 'string' && category && seen.indexOf(category) === -1) {
                seen.push(category);
            }
        }
        if (seen.length < 2) {
            this.category = 'all';
            return;                       // one category: a filter would be noise
        }
        if (this.category !== 'all' && seen.indexOf(this.category) === -1) {
            this.category = 'all';
        }
        const entries = [['all', 'Todos']];
        for (let i = 0; i < seen.length; i++) {
            entries.push([seen[i], ScenarioPicker.categoryLabel(seen[i])]);
        }
        for (let i = 0; i < entries.length; i++) {
            const key = entries[i][0];
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'nv-chip nv-chip--mini';
            button.textContent = entries[i][1];
            button.classList.toggle('nv-chip--active', key === this.category);
            button.addEventListener('click', function () {
                self.category = key;
                self._renderFilters();
                self._renderCards();
                self.select(self.selectedId);
                if (button.blur) { button.blur(); }
            });
            row.appendChild(button);
        }
    }

    _renderCards() {
        const self = this;
        const holder = this.cardList;
        while (holder.firstChild) {
            holder.removeChild(holder.firstChild);
        }
        this.cards.length = 0;

        if (this.scenarios.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'nv-launch__empty';
            empty.textContent = 'Nenhum cenário foi carregado.';
            holder.appendChild(empty);
            return;
        }

        for (let i = 0; i < this.scenarios.length; i++) {
            const scenario = this.scenarios[i];
            if (this.category !== 'all' && scenario.category !== this.category) {
                continue;
            }
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'nv-scenario';
            card.setAttribute('role', 'radio');
            card.setAttribute('aria-checked', 'false');
            card.dataset.scenario = scenario.id;

            const head = document.createElement('span');
            head.className = 'nv-scenario__head';

            const name = document.createElement('span');
            name.className = 'nv-scenario__name';
            name.textContent = ScenarioPicker.textOf(scenario.name, scenario.id);

            const badge = document.createElement('span');
            badge.className = 'nv-scenario__category';
            const category = ScenarioPicker.categoryLabel(scenario.category);
            badge.textContent = category;
            if (scenario.category) {
                badge.dataset.category = String(scenario.category);
            }
            badge.classList.toggle('nv-hidden', !category);

            head.appendChild(name);
            head.appendChild(badge);

            const description = document.createElement('span');
            description.className = 'nv-scenario__description';
            description.textContent = ScenarioPicker.textOf(scenario.description, '');

            card.appendChild(head);
            card.appendChild(description);
            card.addEventListener('click', function () {
                self.select(scenario.id);
            });
            holder.appendChild(card);
            this.cards.push(card);
        }

        if (this.cards.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'nv-launch__empty';
            empty.textContent = 'Nenhum cenário nesta categoria.';
            holder.appendChild(empty);
        }
    }

    _clearParams() {
        const holder = this.paramsHolder;
        while (holder.firstChild) {
            holder.removeChild(holder.firstChild);
        }
        this.controls.length = 0;
    }

    /** The stored values of a scenario, seeded from its defaults on first use. */
    _valuesFor(scenario) {
        let values = this.values[scenario.id];
        if (!values) {
            values = Object.create(null);
            let defaults = null;
            try { defaults = this.getDefaults(scenario.id); } catch (e) { defaults = null; }
            const specs = ScenarioPicker.specsOf(scenario);
            for (let i = 0; i < specs.length; i++) {
                const spec = specs[i];
                const seed = (defaults && defaults[spec.key] !== undefined)
                    ? defaults[spec.key]
                    : spec.default;
                values[spec.key] = ScenarioPicker.clampValue(spec, seed);
            }
            this.values[scenario.id] = values;
        }
        return values;
    }

    /**
     * Generate the controls for a scenario, purely from its ParamSpec array.
     * Nothing here is specific to any scenario.
     */
    _renderParams(scenario) {
        this._clearParams();
        const specs = ScenarioPicker.specsOf(scenario);
        this.resetButton.disabled = specs.length === 0;

        if (specs.length === 0) {
            const none = document.createElement('p');
            none.className = 'nv-params__empty';
            none.textContent = 'Este cenário não tem parâmetros ajustáveis.';
            this.paramsHolder.appendChild(none);
            return;
        }

        const values = this._valuesFor(scenario);
        for (let i = 0; i < specs.length; i++) {
            const control = this._buildControl(specs[i], values);
            if (control) {
                this.paramsHolder.appendChild(control);
            }
        }
    }

    _buildControl(spec, values) {
        const self = this;
        const type = ScenarioPicker.typeOf(spec);

        const field = document.createElement('div');
        field.className = 'nv-param';
        field.dataset.type = type;

        const label = document.createElement('label');
        label.className = 'nv-param__label';
        label.textContent = ScenarioPicker.textOf(spec.label, spec.key);

        const valueTag = document.createElement('span');
        valueTag.className = 'nv-param__value';

        const head = document.createElement('div');
        head.className = 'nv-param__head';
        head.appendChild(label);
        head.appendChild(valueTag);
        field.appendChild(head);

        const inputs = document.createElement('div');
        inputs.className = 'nv-param__inputs';
        field.appendChild(inputs);

        const id = 'nv-param-' + ScenarioPicker.slug(spec.key) + '-' + (this.controls.length + 1);
        const write = function (value) {
            values[spec.key] = value;
        };

        if (type === 'bool') {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = id;
            checkbox.className = 'nv-param__check';
            checkbox.checked = values[spec.key] === true;
            checkbox.addEventListener('change', function () {
                write(checkbox.checked);
                valueTag.textContent = checkbox.checked ? 'Sim' : 'Não';
            });
            label.setAttribute('for', id);
            valueTag.textContent = checkbox.checked ? 'Sim' : 'Não';
            inputs.appendChild(checkbox);
            this.controls.push({ spec: spec, input: checkbox });

        } else if (type === 'choice') {
            const select = document.createElement('select');
            select.id = id;
            select.className = 'nv-param__select';
            const choices = Array.isArray(spec.choices) ? spec.choices : [];
            for (let i = 0; i < choices.length; i++) {
                const choice = choices[i];
                if (!choice || choice.value === undefined) {
                    continue;
                }
                const option = document.createElement('option');
                option.value = String(choice.value);
                option.textContent = ScenarioPicker.textOf(choice.label, String(choice.value));
                select.appendChild(option);
            }
            select.value = String(values[spec.key]);
            if (select.selectedIndex < 0 && select.options.length > 0) {
                select.selectedIndex = 0;
                write(ScenarioPicker.choiceValue(spec, select.value));
            }
            select.addEventListener('change', function () {
                write(ScenarioPicker.choiceValue(spec, select.value));
            });
            label.setAttribute('for', id);
            inputs.appendChild(select);
            this.controls.push({ spec: spec, input: select });

        } else {
            const isInteger = (type === 'int');
            const min = ScenarioPicker.finiteOr(spec.min, null);
            const max = ScenarioPicker.finiteOr(spec.max, null);
            const step = ScenarioPicker.stepOf(spec, isInteger);

            const number = document.createElement('input');
            number.type = 'number';
            number.id = id;
            number.className = 'nv-param__number';
            if (min !== null) { number.min = String(min); }
            if (max !== null) { number.max = String(max); }
            number.step = String(step);
            number.value = String(values[spec.key]);
            label.setAttribute('for', id);

            let slider = null;
            if (min !== null && max !== null && max > min) {
                slider = document.createElement('input');
                slider.type = 'range';
                slider.className = 'nv-param__range';
                slider.min = String(min);
                slider.max = String(max);
                slider.step = String(step);
                slider.value = String(values[spec.key]);
                slider.setAttribute('aria-label', ScenarioPicker.textOf(spec.label, spec.key));
                inputs.appendChild(slider);
            }
            inputs.appendChild(number);

            if (typeof spec.unit === 'string' && spec.unit) {
                const unit = document.createElement('span');
                unit.className = 'nv-param__unit';
                unit.textContent = spec.unit;
                inputs.appendChild(unit);
            }

            const show = function (value) {
                valueTag.textContent = ScenarioPicker.formatValue(value, isInteger) +
                    ((typeof spec.unit === 'string' && spec.unit) ? ' ' + spec.unit : '');
            };
            show(values[spec.key]);

            // The stored value is ALWAYS clamped; the text field is only
            // rewritten on `change`, so half-typed numbers are not fought with.
            const commit = function (raw, rewrite) {
                const value = ScenarioPicker.clampValue(spec, raw);
                write(value);
                show(value);
                if (slider) { slider.value = String(value); }
                if (rewrite) { number.value = String(value); }
            };

            number.addEventListener('input', function () {
                commit(number.value, false);
            });
            number.addEventListener('change', function () {
                commit(number.value, true);
            });
            number.addEventListener('keydown', function (event) {
                event.stopPropagation();
            });
            if (slider) {
                slider.addEventListener('input', function () {
                    commit(slider.value, true);
                });
                slider.addEventListener('keydown', function (event) {
                    event.stopPropagation();
                });
            }
            this.controls.push({ spec: spec, input: number, slider: slider });
        }

        if (typeof spec.help === 'string' && spec.help) {
            const help = document.createElement('p');
            help.className = 'nv-param__help';
            help.textContent = spec.help;
            field.appendChild(help);
        }
        return field;
    }

    // --- keyboard ----------------------------------------------------------

    _handleKeyDown(event) {
        if (!this.visible) {
            return;
        }
        if (event.key === 'Escape') {
            if (this.allowCancel && this.onCancel) {
                event.preventDefault();
                this.onCancel();
            }
            return;
        }
        // Enter starts, unless the focus is on a control that uses it itself
        if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
            const target = event.target;
            const tag = (target && target.tagName) ? target.tagName.toUpperCase() : '';
            if (tag === 'BUTTON' || tag === 'SELECT') {
                return;
            }
            event.preventDefault();
            this.start();
        }
    }

    _handleCardKey(event) {
        const key = event.key;
        if (key !== 'ArrowDown' && key !== 'ArrowUp' &&
            key !== 'ArrowRight' && key !== 'ArrowLeft') {
            return;
        }
        if (this.cards.length === 0) {
            return;
        }
        let index = this.cards.indexOf(event.target);
        if (index === -1) {
            index = 0;
        } else {
            index += (key === 'ArrowDown' || key === 'ArrowRight') ? 1 : -1;
            index = (index + this.cards.length) % this.cards.length;
        }
        event.preventDefault();
        const card = this.cards[index];
        this.select(card.dataset.scenario);
        if (card.focus) {
            card.focus();
        }
    }

    // =======================================================================
    // ParamSpec helpers - the whole schema lives here and nowhere else
    // =======================================================================

    static specsOf(scenario) {
        const params = (scenario && Array.isArray(scenario.params)) ? scenario.params : [];
        const out = [];
        for (let i = 0; i < params.length; i++) {
            const spec = params[i];
            if (spec && typeof spec === 'object' && typeof spec.key === 'string' && spec.key) {
                out.push(spec);
            }
        }
        return out;
    }

    /** Declared type, or the type inferred from the default / choices. */
    static typeOf(spec) {
        const declared = (spec && typeof spec.type === 'string') ? spec.type.toLowerCase() : '';
        if (declared === 'int' || declared === 'integer') {
            return 'int';
        }
        if (declared === 'float' || declared === 'number') {
            return 'float';
        }
        if (declared === 'bool' || declared === 'boolean') {
            return 'bool';
        }
        if (declared === 'choice' || declared === 'enum' || declared === 'select') {
            return 'choice';
        }
        if (spec && Array.isArray(spec.choices) && spec.choices.length > 0) {
            return 'choice';
        }
        if (spec && typeof spec.default === 'boolean') {
            return 'bool';
        }
        if (spec && typeof spec.default === 'number' && Number.isInteger(spec.default) &&
            (spec.step === undefined || spec.step === 1)) {
            return 'int';
        }
        return 'float';
    }

    static finiteOr(value, fallback) {
        return (typeof value === 'number' && isFinite(value)) ? value : fallback;
    }

    static stepOf(spec, isInteger) {
        const declared = ScenarioPicker.finiteOr(spec.step, null);
        if (declared !== null && declared > 0) {
            return declared;
        }
        if (isInteger) {
            return 1;
        }
        const min = ScenarioPicker.finiteOr(spec.min, null);
        const max = ScenarioPicker.finiteOr(spec.max, null);
        if (min !== null && max !== null && max > min) {
            const span = (max - min) / 100;
            // round to a power of ten so the control does not show noise
            const magnitude = Math.pow(10, Math.floor(Math.log(span) / Math.LN10));
            return magnitude > 0 ? magnitude : 0.01;
        }
        return 0.01;
    }

    /** The declared value of a choice, matched back from its stringified form. */
    static choiceValue(spec, raw) {
        const choices = Array.isArray(spec.choices) ? spec.choices : [];
        for (let i = 0; i < choices.length; i++) {
            if (choices[i] && String(choices[i].value) === raw) {
                return choices[i].value;
            }
        }
        return raw;
    }

    /**
     * Coerce and clamp one value to its spec. Out-of-range and unparseable
     * input never reaches the scenario: it falls back to the default.
     */
    static clampValue(spec, raw) {
        const type = ScenarioPicker.typeOf(spec);

        if (type === 'bool') {
            if (typeof raw === 'boolean') {
                return raw;
            }
            if (raw === 'true' || raw === 1 || raw === '1') {
                return true;
            }
            if (raw === 'false' || raw === 0 || raw === '0') {
                return false;
            }
            return spec.default === true;
        }

        if (type === 'choice') {
            const choices = Array.isArray(spec.choices) ? spec.choices : [];
            for (let i = 0; i < choices.length; i++) {
                if (choices[i] && String(choices[i].value) === String(raw)) {
                    return choices[i].value;
                }
            }
            if (spec.default !== undefined) {
                return spec.default;
            }
            return (choices.length > 0 && choices[0]) ? choices[0].value : raw;
        }

        let value = (typeof raw === 'number') ? raw : parseFloat(raw);
        if (typeof value !== 'number' || !isFinite(value)) {
            value = ScenarioPicker.finiteOr(spec.default, 0);
        }
        if (type === 'int') {
            value = Math.round(value);
        }
        const min = ScenarioPicker.finiteOr(spec.min, null);
        const max = ScenarioPicker.finiteOr(spec.max, null);
        if (min !== null && value < min) {
            value = min;
        }
        if (max !== null && value > max) {
            value = max;
        }
        return value;
    }

    static categoryLabel(category) {
        if (typeof category !== 'string' || !category) {
            return '';
        }
        const known = NV_CATEGORY_LABELS[category];
        if (known) {
            return known;
        }
        return category.charAt(0).toUpperCase() + category.slice(1);
    }

    static textOf(value, fallback) {
        return (typeof value === 'string' && value) ? value : fallback;
    }

    static slug(text) {
        return String(text).replace(/[^a-zA-Z0-9_-]/g, '');
    }

    static formatValue(value, isInteger) {
        if (typeof value !== 'number' || !isFinite(value)) {
            return String(value);
        }
        if (isInteger) {
            return Math.round(value).toLocaleString('pt-BR');
        }
        const magnitude = Math.abs(value);
        if (magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e6)) {
            return value.toExponential(2).replace('.', ',').replace('e+', 'e');
        }
        return value.toLocaleString('pt-BR', { maximumFractionDigits: 4 });
    }
}
