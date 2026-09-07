/**
 * NavigatorUI
 *
 * Creates its own DOM overlay on top of the WebGL canvas:
 *
 *   - a searchable / sortable body-navigation panel (fly to distant bodies)
 *   - a compact HUD (counts, energies, momentum, heaviest element, mode, FPS)
 *   - a selected-body inspector
 *   - a keyboard help overlay fed by CameraController.getKeyBindings()
 *   - playback controls (pause + speed multiplier)
 *
 * PERFORMANCE
 *   The render loop must never pay for this panel. Everything is throttled:
 *   the body list and the HUD refresh at ~4 Hz, the list renders at most
 *   `maxRows` (default 60) pooled rows that are mutated in place instead of
 *   being recreated, and the DOM is never rebuilt wholesale.
 *
 * No modules, no build step: this declares a global class.
 * All user-facing strings are pt-BR.
 */
class NavigatorUI {

    /**
     * @param {Object} options
     *   mount          {HTMLElement}                        default document.body
     *   getBodies      {Function} () => Planet[]
     *   getStats       {Function} () => stats object
     *   getCamera      {Function} () => THREE.Camera
     *   getKeyBindings {Function} () => [{keys, description, group}]
     *   onSelect       {Function} (planet) => void          row clicked
     *   onFollow       {Function} (planet) => void          "Seguir"
     *   onFrame        {Function} (planet) => void          "Enquadrar"
     *   onRelease      {Function} () => void                "Soltar"
     *   onFrameAll     {Function} () => void                "Tudo"
     *   onModeChange   {Function} (mode) => void
     *   onPause        {Function} (isPaused) => void
     *   onSpeedChange  {Function} (multiplier) => void
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
        this.getKeyBindings = typeof options.getKeyBindings === 'function' ? options.getKeyBindings : function () { return []; };

        this.onSelect = options.onSelect || null;
        this.onFollow = options.onFollow || null;
        this.onFrame = options.onFrame || null;
        this.onRelease = options.onRelease || null;
        this.onFrameAll = options.onFrameAll || null;
        this.onModeChange = options.onModeChange || null;
        this.onPause = options.onPause || null;
        this.onSpeedChange = options.onSpeedChange || null;

        this.maxRows = options.maxRows || 60;
        this.refreshInterval = options.refreshInterval || 0.25;

        // --- state ---------------------------------------------------------
        this.selected = null;
        this.following = null;
        this.mode = 'orbit';
        this.paused = false;
        this.speed = 1;
        this.sortKey = 'distance';
        this.sortAscending = true;
        this.filterText = '';
        this.helpVisible = false;

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

        this._build();
        this.setKeyBindings(this.getKeyBindings());
        this._applySortButtons();
        this.refresh(true);
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

    // --- HUD ---------------------------------------------------------------

    _buildHud() {
        const panel = this._panel('nv-hud', 'Universo');
        const body = panel.nvBody;

        const grid = document.createElement('dl');
        grid.className = 'nv-stats';

        this.hudFields = {};
        const fields = [
            ['count', 'Corpos'],
            ['totalMass', 'Massa total'],
            ['kinetic', 'Energia cinética'],
            ['potential', 'Energia potencial'],
            ['total', 'Energia total'],
            ['momentum', 'Momento linear'],
            ['maxElement', 'Elemento mais pesado'],
            ['mode', 'Câmera'],
            ['fps', 'FPS']
        ];

        for (let i = 0; i < fields.length; i++) {
            const key = fields[i][0];
            const label = fields[i][1];

            const dt = document.createElement('dt');
            dt.textContent = label;

            const dd = document.createElement('dd');
            dd.textContent = '—';
            if (key === 'total') {
                dd.className = 'nv-stats__highlight';
            }

            grid.appendChild(dt);
            grid.appendChild(dd);
            this.hudFields[key] = dd;
        }

        body.appendChild(grid);
        this.hudPanel = panel;
        return panel;
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
        search.placeholder = 'Buscar elemento (ex.: Ferro, Fe, #12)';
        search.setAttribute('aria-label', 'Buscar corpo por elemento');
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
            ['distance', 'Distância'],
            ['mass', 'Massa'],
            ['radius', 'Raio'],
            ['element', 'Elemento']
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
        frameAll.title = 'Enquadrar toda a simulação (A)';
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

        const name = document.createElement('span');
        name.className = 'nv-inspector__name';
        name.textContent = 'Nenhum corpo selecionado';

        head.appendChild(swatch);
        head.appendChild(name);
        body.appendChild(head);

        const grid = document.createElement('dl');
        grid.className = 'nv-stats';

        this.inspectorFields = {};
        const fields = [
            ['mass', 'Massa'],
            ['radius', 'Raio'],
            ['density', 'Densidade'],
            ['speed', 'Velocidade'],
            ['distance', 'Dist. da câmera'],
            ['distanceCom', 'Dist. do centro de massa']
        ];
        for (let i = 0; i < fields.length; i++) {
            const dt = document.createElement('dt');
            dt.textContent = fields[i][1];
            const dd = document.createElement('dd');
            dd.textContent = '—';
            grid.appendChild(dt);
            grid.appendChild(dd);
            this.inspectorFields[fields[i][0]] = dd;
        }
        body.appendChild(grid);

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

        const help = document.createElement('button');
        help.type = 'button';
        help.className = 'nv-chip nv-chip--action';
        help.textContent = '? Ajuda';
        help.addEventListener('click', function () {
            self.toggleHelp();
            self._blur(help);
        });
        bar.appendChild(help);

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
        this._refreshList();
        this._refreshHud();
        this._refreshInspector();
        if (immediate) {
            this._accumulator = 0;
        }
        return this;
    }

    setSelected(planet) {
        this.selected = planet || null;
        this.inspectorPanel.classList.toggle('nv-panel--empty', !this.selected);
        this._refreshInspector();
        this._markRows();
        return this;
    }

    setFollowing(planet) {
        this.following = planet || null;
        this._markRows();
        this._refreshInspector();
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
            this.hudFields.mode.textContent = NavigatorUI.MODE_LABELS[this.mode] || this.mode;
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
            // distance reads best ascending, magnitudes read best descending
            this.sortAscending = (key === 'distance');
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

        const filter = NavigatorUI.normalizeText(this.filterText);
        const idFilter = /^#(\d+)$/.exec(this.filterText.trim());
        const wantedId = idFilter ? parseInt(idFilter[1], 10) : null;

        const entries = this._entries;
        let count = 0;

        for (let i = 0; i < bodies.length; i++) {
            const planet = bodies[i];
            if (!planet || planet.removed || !planet.position) {
                continue;
            }
            const element = planet.composition && planet.composition.element ? planet.composition.element : null;

            if (wantedId !== null) {
                if (planet.id !== wantedId) {
                    continue;
                }
            } else if (filter) {
                const name = element ? NavigatorUI.normalizeText(element.name) : '';
                const symbol = element ? NavigatorUI.normalizeText(element.symbol) : '';
                if (name.indexOf(filter) === -1 && symbol.indexOf(filter) === -1) {
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

            let entry = entries[count];
            if (!entry) {
                entry = { planet: null, distance: 0, mass: 0, radius: 0, element: '' };
                entries[count] = entry;
            }
            entry.planet = planet;
            entry.distance = distance;
            entry.mass = typeof planet.mass === 'number' ? planet.mass : 0;
            entry.radius = typeof planet.radius === 'number' ? planet.radius : 0;
            entry.element = element ? (element.number || 0) : 0;
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
            this.listFooter.textContent = 'Mostrando ' + shown + ' de ' + count + ' corpos.';
        } else {
            this.listFooter.textContent = count + (count === 1 ? ' corpo.' : ' corpos.');
        }

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

        const numbers = document.createElement('span');
        numbers.className = 'nv-row__numbers';

        const distance = document.createElement('span');
        distance.className = 'nv-row__distance';

        const follow = document.createElement('button');
        follow.type = 'button';
        follow.className = 'nv-row__follow';
        follow.dataset.action = 'follow';
        follow.textContent = '⌖';
        follow.title = 'Seguir este corpo';

        element.appendChild(swatch);
        element.appendChild(label);
        element.appendChild(numbers);
        element.appendChild(distance);
        element.appendChild(follow);

        this.listElement.appendChild(element);

        return {
            element: element,
            swatch: swatch,
            label: label,
            numbers: numbers,
            distance: distance,
            lastColor: '',
            lastLabel: '',
            lastNumbers: '',
            lastDistance: ''
        };
    }

    _writeRow(row, entry, index) {
        const planet = entry.planet;
        const element = planet.composition && planet.composition.element ? planet.composition.element : null;

        const color = element && element.color ? element.color : '#8899aa';
        if (row.lastColor !== color) {
            row.swatch.style.backgroundColor = color;
            row.lastColor = color;
        }

        const label = element
            ? (element.symbol + ' · ' + element.name)
            : ('Corpo #' + (planet.id !== undefined ? planet.id : index));
        if (row.lastLabel !== label) {
            row.label.textContent = label;
            row.lastLabel = label;
        }

        const numbers = 'm ' + NavigatorUI.formatNumber(entry.mass) + '  ·  r ' + NavigatorUI.formatNumber(entry.radius);
        if (row.lastNumbers !== numbers) {
            row.numbers.textContent = numbers;
            row.lastNumbers = numbers;
        }

        const distance = NavigatorUI.formatNumber(entry.distance) + ' u';
        if (row.lastDistance !== distance) {
            row.distance.textContent = distance;
            row.lastDistance = distance;
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
        const bodies = this._bodies();

        fields.count.textContent = stats && typeof stats.count === 'number'
            ? NavigatorUI.formatInteger(stats.count)
            : NavigatorUI.formatInteger(bodies.length);

        fields.totalMass.textContent = stats ? NavigatorUI.formatNumber(stats.totalMass) : '—';
        fields.kinetic.textContent = stats ? NavigatorUI.formatNumber(stats.kineticEnergy) : '—';
        fields.potential.textContent = stats ? NavigatorUI.formatNumber(stats.potentialEnergy) : '—';
        fields.total.textContent = stats ? NavigatorUI.formatNumber(stats.totalEnergy) : '—';

        fields.momentum.textContent = stats && stats.momentum
            ? NavigatorUI.formatNumber(NavigatorUI.magnitudeOf(stats.momentum))
            : '—';

        fields.maxElement.textContent = NavigatorUI.describeElement(stats ? stats.maxElement : null);
        fields.fps.textContent = this._fps ? this._fps.toFixed(0) : '—';
        fields.mode.textContent = NavigatorUI.MODE_LABELS[this.mode] || this.mode;
    }

    _refreshInspector() {
        const planet = this.selected;
        const fields = this.inspectorFields;

        if (!planet || planet.removed) {
            this.inspectorPanel.classList.add('nv-panel--empty');
            this.inspectorName.textContent = 'Nenhum corpo selecionado';
            this.inspectorSwatch.style.backgroundColor = 'transparent';
            const keys = Object.keys(fields);
            for (let i = 0; i < keys.length; i++) {
                fields[keys[i]].textContent = '—';
            }
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

        const element = planet.composition && planet.composition.element ? planet.composition.element : null;
        this.inspectorSwatch.style.backgroundColor = element && element.color ? element.color : '#8899aa';

        let title = element ? (element.symbol + ' · ' + element.name) : 'Corpo';
        if (planet.id !== undefined) {
            title += '  #' + planet.id;
        }
        this.inspectorName.textContent = title;

        fields.mass.textContent = NavigatorUI.formatNumber(planet.mass);
        fields.radius.textContent = NavigatorUI.formatNumber(planet.radius) + ' u';
        fields.density.textContent = NavigatorUI.formatNumber(planet.density);
        fields.speed.textContent = planet.velocity
            ? NavigatorUI.formatNumber(NavigatorUI.magnitudeOf(planet.velocity)) + ' u/s'
            : '—';

        const camera = this._camera();
        if (camera && planet.position) {
            const dx = planet.position.x - camera.position.x;
            const dy = planet.position.y - camera.position.y;
            const dz = planet.position.z - camera.position.z;
            fields.distance.textContent = NavigatorUI.formatNumber(Math.sqrt(dx * dx + dy * dy + dz * dz)) + ' u';
        } else {
            fields.distance.textContent = '—';
        }

        const stats = this._stats();
        const centerOfMass = stats ? stats.centerOfMass : null;
        if (centerOfMass && planet.position) {
            const dx = planet.position.x - centerOfMass.x;
            const dy = planet.position.y - centerOfMass.y;
            const dz = planet.position.z - centerOfMass.z;
            fields.distanceCom.textContent = NavigatorUI.formatNumber(Math.sqrt(dx * dx + dy * dy + dz * dz)) + ' u';
        } else {
            fields.distanceCom.textContent = '—';
        }
    }

    // =======================================================================
    // small helpers
    // =======================================================================

    _bodies() {
        let bodies;
        try { bodies = this.getBodies(); } catch (e) { bodies = null; }
        return Array.isArray(bodies) ? bodies : [];
    }

    _stats() {
        let stats;
        try { stats = this.getStats(); } catch (e) { stats = null; }
        return stats || null;
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

    static describeElement(value) {
        if (value === null || value === undefined) {
            return '—';
        }
        if (typeof value === 'object') {
            if (value.symbol && value.name) {
                return value.symbol + ' · ' + value.name;
            }
            if (value.name) {
                return value.name;
            }
            return '—';
        }
        if (typeof value === 'number') {
            const table = (typeof PERIODIC_TABLE_ELEMENTS !== 'undefined') ? PERIODIC_TABLE_ELEMENTS : null;
            const atom = table ? table[value] : null;
            if (atom) {
                return atom.symbol + ' · ' + atom.name;
            }
            return 'Z = ' + value;
        }
        return String(value);
    }

    static formatInteger(value) {
        if (typeof value !== 'number' || !isFinite(value)) {
            return '—';
        }
        return Math.round(value).toLocaleString('pt-BR');
    }

    /** Compact pt-BR number formatting that survives 1e-9 .. 1e30. */
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
        if (magnitude >= 1) {
            return value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
        }
        return value.toLocaleString('pt-BR', { maximumFractionDigits: 4 });
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
