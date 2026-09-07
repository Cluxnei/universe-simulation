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
    { key: 'star', label: 'Estrelas', singular: 'Estrela' }
];

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
