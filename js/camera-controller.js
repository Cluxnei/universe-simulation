/**
 * CameraController
 *
 * A 3D exploration camera for the universe simulation. Wraps the vendored
 * THREE.OrbitControls (three.js r147, non-module examples/js build) and adds:
 *
 *   - three camera modes: 'orbit', 'fly' (free spectator) and 'follow'
 *   - smooth, interruptible flyTo() animations that keep tracking a moving body
 *   - frame-all / frame-selected helpers based on bounding spheres
 *   - click-to-select via raycasting (uses the `mesh.userData.planetId` convention)
 *   - a documented, queryable keyboard binding table
 *
 * Bodies are pure physics objects: they do NOT own a THREE.Mesh.
 *
 * PICKING CONTRACT (the integrator must honour one of these):
 *   a) one mesh per body  -> `mesh.userData.planetId = planet.id`
 *   b) a single InstancedMesh -> `instancedMesh.userData.planetIds` is an Array
 *      (or any index-able object) mapping instanceId -> planet.id, OR
 *      `instancedMesh.userData.getPlanetId = function (instanceId) {...}`
 *   c) anything else -> pass a `resolvePlanetId(intersection)` option that
 *      returns the planet id for a THREE intersection record.
 * `mesh.userData.planet` (a direct reference) is also accepted as a fallback.
 *
 * No modules, no build step: this declares a global class.
 */
class CameraController {

    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {HTMLElement} domElement usually renderer.domElement
     * @param {Object} options
     *   getBodies      {Function} () => Planet[]                (required)
     *   getMeshFor     {Function} (planet) => THREE.Object3D|null (optional)
     *   getPickables   {Function} () => THREE.Object3D[]        (optional, raycast roots)
     *   resolvePlanetId{Function} (intersection) => id|null     (optional override)
     *   scene          {THREE.Scene}                            (optional, raycast fallback)
     *   onSelect       {Function} (planet|null, mesh|null) => void
     *   onModeChange   {Function} (mode) => void
     *   onFollowChange {Function} (planet|null) => void
     *   onTogglePause  {Function} () => void
     *   onToggleHelp   {Function} () => void
     *   onNotice       {Function} (messageInPortuguese) => void
     */
    constructor(camera, domElement, options) {
        options = options || {};

        this.camera = camera;
        this.domElement = domElement;
        this.options = options;

        this.getBodies = typeof options.getBodies === 'function' ? options.getBodies : function () { return []; };
        this.getMeshFor = typeof options.getMeshFor === 'function' ? options.getMeshFor : null;
        this.getPickables = typeof options.getPickables === 'function' ? options.getPickables : null;
        this.resolvePlanetId = typeof options.resolvePlanetId === 'function' ? options.resolvePlanetId : null;
        this.scene = options.scene || null;

        this.onSelect = options.onSelect || null;
        this.onModeChange = options.onModeChange || null;
        this.onFollowChange = options.onFollowChange || null;
        this.onTogglePause = options.onTogglePause || null;
        this.onToggleHelp = options.onToggleHelp || null;
        this.onNotice = options.onNotice || null;

        // --- OrbitControls -------------------------------------------------
        this.controls = new THREE.OrbitControls(camera, domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.rotateSpeed = 0.55;
        this.controls.zoomSpeed = 1.1;
        this.controls.panSpeed = 0.9;
        this.controls.screenSpacePanning = true;
        this.controls.minDistance = 0.05;
        this.controls.maxDistance = 4000000;
        this.controls.autoRotate = false;
        // r147 OrbitControls only listens for keys after listenToKeyEvents() is
        // called - we never call it, so this class owns the keyboard entirely.
        this.controls.saveState();

        // --- state ---------------------------------------------------------
        this.mode = CameraController.ORBIT;
        this.selected = null;
        this.followed = null;
        this.followRigid = false;          // false => orbit-around-target (default)
        this.followOffset = new THREE.Vector3();
        this.enabled = true;

        // free-fly state
        this.flySpeed = 250;               // world units / second
        this.flySpeedMin = 0.5;
        this.flySpeedMax = 500000;
        this.flyBoost = 6;
        this.flySlow = 0.15;
        this.lookSensitivity = 0.0022;
        this._yaw = 0;
        this._pitch = 0;
        this._pointerLocked = false;
        this._keys = Object.create(null);

        // flyTo animation state
        this._flight = null;

        // scratch objects (never allocate inside the render loop)
        this._v1 = new THREE.Vector3();
        this._v2 = new THREE.Vector3();
        this._v3 = new THREE.Vector3();
        this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
        this._raycaster = new THREE.Raycaster();
        this._ndc = new THREE.Vector2();
        this._meshBuffer = [];

        // housekeeping timers
        this._membershipTimer = 0;

        // --- semi-fixed view (mobile) --------------------------------------
        // Null on desktop, which is what keeps every branch below inert there.
        this.fixedView = null;             // normalised meta.mobileView
        this._fixedTarget = null;          // the followed body, when asked for
        this._fixedAzimuth = 0;            // radians, drifts with REAL time
        this._fixedTimer = 0;              // follow re-acquisition throttle
        this._fixedSavedUp = new THREE.Vector3(0, 1, 0);
        this._fixedU = new THREE.Vector3(1, 0, 0);
        this._fixedV = new THREE.Vector3(0, 1, 0);
        this._fixedN = new THREE.Vector3(0, 0, 1);
        this._fixedPoint = new THREE.Vector3();
        this._fixedOffset = { x: 0, y: 0, z: 0 };

        // click vs drag discrimination
        this._pointerDown = null;

        this._bind();
        this._attach();
    }

    // -----------------------------------------------------------------------
    // constants
    // -----------------------------------------------------------------------

    static get ORBIT() { return 'orbit'; }
    static get FLY() { return 'fly'; }
    static get FOLLOW() { return 'follow'; }
    static get MODES() { return ['orbit', 'fly', 'follow']; }

    // -----------------------------------------------------------------------
    // event wiring
    // -----------------------------------------------------------------------

    _bind() {
        this._onKeyDown = this._handleKeyDown.bind(this);
        this._onKeyUp = this._handleKeyUp.bind(this);
        this._onPointerDown = this._handlePointerDown.bind(this);
        this._onPointerUp = this._handlePointerUp.bind(this);
        this._onWheel = this._handleWheel.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onPointerLockChange = this._handlePointerLockChange.bind(this);
        this._onBlur = this._handleBlur.bind(this);
        this._onContextMenu = function (event) { event.preventDefault(); };
    }

    _attach() {
        window.addEventListener('keydown', this._onKeyDown, false);
        window.addEventListener('keyup', this._onKeyUp, false);
        window.addEventListener('blur', this._onBlur, false);
        // r147 OrbitControls is pointer-event based; stay consistent with it
        this.domElement.addEventListener('pointerdown', this._onPointerDown, false);
        this.domElement.addEventListener('pointerup', this._onPointerUp, false);
        this.domElement.addEventListener('wheel', this._onWheel, { passive: false });
        this.domElement.addEventListener('contextmenu', this._onContextMenu, false);
        document.addEventListener('mousemove', this._onMouseMove, false);
        document.addEventListener('pointerlockchange', this._onPointerLockChange, false);
        document.addEventListener('mozpointerlockchange', this._onPointerLockChange, false);
    }

    dispose() {
        window.removeEventListener('keydown', this._onKeyDown, false);
        window.removeEventListener('keyup', this._onKeyUp, false);
        window.removeEventListener('blur', this._onBlur, false);
        this.domElement.removeEventListener('pointerdown', this._onPointerDown, false);
        this.domElement.removeEventListener('pointerup', this._onPointerUp, false);
        this.domElement.removeEventListener('wheel', this._onWheel, { passive: false });
        this.domElement.removeEventListener('contextmenu', this._onContextMenu, false);
        document.removeEventListener('mousemove', this._onMouseMove, false);
        document.removeEventListener('pointerlockchange', this._onPointerLockChange, false);
        document.removeEventListener('mozpointerlockchange', this._onPointerLockChange, false);
        this.controls.dispose();
    }

    /**
     * Call from the window resize handler AFTER camera.updateProjectionMatrix().
     * Nothing heavy happens here (the canvas rect is read lazily on click), but
     * it keeps a running flight framed correctly.
     */
    handleResize() {
        // no cached viewport state; kept for API symmetry and future-proofing
        return this;
    }

    setEnabled(value) {
        // The semi-fixed view owns the camera outright: nothing may re-enable
        // input while it is on, including openPicker() handing control back.
        this.enabled = !!value && !this.fixedView;
        this.controls.enabled = this.enabled
            && !this._flight
            && this.mode !== CameraController.FLY
            && !(this.mode === CameraController.FOLLOW && this.followRigid);
        if (!this.enabled) {
            this._keys = Object.create(null);
            this.exitPointerLock();
        }
        return this;
    }

    // -----------------------------------------------------------------------
    // modes
    // -----------------------------------------------------------------------

    getMode() {
        return this.mode;
    }

    /**
     * @param {'orbit'|'fly'|'follow'} mode
     */
    setMode(mode) {
        if (CameraController.MODES.indexOf(mode) === -1) {
            return this;
        }
        if (mode === this.mode) {
            return this;
        }
        const previous = this.mode;

        if (previous === CameraController.FLY) {
            this.exitPointerLock();
            this._keys = Object.create(null);
            // rebuild an orbit pivot in front of the camera so orbiting feels natural
            this._placeOrbitTargetAhead();
        }

        if (mode === CameraController.FOLLOW && !this.getFollowed()) {
            const candidate = this.getSelected();
            if (!candidate) {
                this._notice('Nenhum corpo selecionado para seguir.');
                return this;
            }
            this._setFollowed(candidate);
        }

        this.mode = mode;

        if (mode === CameraController.FLY) {
            this.cancelFlight();
            this.controls.enabled = false;
            this._syncFlyAnglesFromCamera();
        } else if (mode === CameraController.FOLLOW) {
            this.controls.enabled = this.enabled && !this.followRigid;
            this._captureFollowOffset();
        } else {
            this.controls.enabled = this.enabled;
        }

        if (mode !== CameraController.FOLLOW && previous === CameraController.FOLLOW) {
            this._setFollowed(null);
        }

        this._emitModeChange();
        return this;
    }

    cycleMode() {
        const list = CameraController.MODES;
        const next = list[(list.indexOf(this.mode) + 1) % list.length];
        this.setMode(next);
        return this;
    }

    _emitModeChange() {
        if (this.onModeChange) {
            try { this.onModeChange(this.mode); } catch (e) { console.error(e); }
        }
    }

    _notice(message) {
        if (this.onNotice) {
            try { this.onNotice(message); } catch (e) { console.error(e); }
        }
    }

    // -----------------------------------------------------------------------
    // selection
    // -----------------------------------------------------------------------

    getSelected() {
        return this.selected && !this.selected.removed ? this.selected : null;
    }

    /**
     * @param {Object|null} planet
     * @param {boolean} [silent] when true the onSelect callback is not fired
     */
    select(planet, silent) {
        this.selected = planet || null;
        if (!silent && this.onSelect) {
            const mesh = planet ? this._meshFor(planet) : null;
            try { this.onSelect(this.selected, mesh); } catch (e) { console.error(e); }
        }
        return this;
    }

    clearSelection() {
        return this.select(null);
    }

    /**
     * Cycle the selection through the body list.
     * @param {number} direction +1 next, -1 previous
     */
    cycleSelection(direction) {
        const bodies = this._bodies();
        if (!bodies.length) {
            return this;
        }
        const step = direction < 0 ? -1 : 1;
        let index = this.selected ? bodies.indexOf(this.selected) : -1;
        index = (index + step + bodies.length) % bodies.length;
        const next = bodies[index];
        this.select(next);
        this.flyTo(next, { follow: this.mode === CameraController.FOLLOW });
        return this;
    }

    // -----------------------------------------------------------------------
    // follow
    // -----------------------------------------------------------------------

    getFollowed() {
        return this.followed && !this.followed.removed ? this.followed : null;
    }

    isFollowRigid() {
        return this.followRigid;
    }

    /**
     * Lock the camera onto a body.
     * @param {Object} planet
     * @param {Object} [opts] { rigid:boolean, fly:boolean }  fly defaults to true
     */
    follow(planet, opts) {
        opts = opts || {};
        if (!planet || planet.removed) {
            return this;
        }
        if (typeof opts.rigid === 'boolean') {
            this.followRigid = opts.rigid;
        }
        this._setFollowed(planet);
        this.select(planet);

        if (opts.fly === false) {
            this.mode = CameraController.FOLLOW;
            this.controls.enabled = this.enabled && !this.followRigid;
            this._captureFollowOffset();
            this._emitModeChange();
        } else {
            this.flyTo(planet, { follow: true });
        }
        return this;
    }

    /**
     * Follow whatever is currently selected (keyboard `F`).
     * Toggles off when already following that body.
     */
    followSelected() {
        const selected = this.getSelected();
        if (!selected) {
            this._notice('Selecione um corpo antes de seguir.');
            return this;
        }
        if (this.mode === CameraController.FOLLOW && this.followed === selected) {
            this.stopFollowing();
        } else {
            this.follow(selected);
        }
        return this;
    }

    stopFollowing() {
        if (this.mode === CameraController.FOLLOW) {
            this.mode = CameraController.ORBIT;
            this.controls.enabled = this.enabled;
            this._emitModeChange();
        }
        this._setFollowed(null);
        return this;
    }

    /** Switch between rigid follow (fixed offset) and orbit-around-target. */
    setFollowRigid(value) {
        this.followRigid = !!value;
        if (this.mode === CameraController.FOLLOW) {
            this.controls.enabled = this.enabled && !this.followRigid;
            this._captureFollowOffset();
        }
        return this;
    }

    toggleFollowRigid() {
        this.setFollowRigid(!this.followRigid);
        this._notice(this.followRigid ? 'Perseguição rígida ativada.' : 'Órbita em torno do alvo ativada.');
        return this;
    }

    _setFollowed(planet) {
        if (this.followed === planet) {
            return;
        }
        this.followed = planet || null;
        if (this.onFollowChange) {
            try { this.onFollowChange(this.followed); } catch (e) { console.error(e); }
        }
    }

    _captureFollowOffset() {
        const body = this.getFollowed();
        if (!body) {
            return;
        }
        this._readPosition(body, this._v1);
        this.followOffset.copy(this.camera.position).sub(this._v1);
        if (this.followOffset.lengthSq() < 1e-8) {
            const radius = this._radiusOf(body);
            this.followOffset.set(0, radius * 2, radius * 6);
        }
        this.controls.target.copy(this._v1);
    }

    /** Called when the followed body vanishes (merged / removed). */
    _loseFollowTarget() {
        const last = new THREE.Vector3().copy(this.controls.target);
        this._setFollowed(null);
        this.cancelFlight();
        this.mode = CameraController.ORBIT;
        this.controls.enabled = this.enabled;
        this.controls.target.copy(last);
        this._emitModeChange();
        this._notice('O corpo seguido foi absorvido. Voltando ao modo órbita.');
    }

    // -----------------------------------------------------------------------
    // flyTo / framing
    // -----------------------------------------------------------------------

    isFlying() {
        return this._flight !== null;
    }

    cancelFlight() {
        if (!this._flight) {
            return this;
        }
        const flight = this._flight;
        this._flight = null;
        if (flight.restoreControls && this.mode !== CameraController.FLY) {
            this.controls.enabled = this.enabled && !(this.mode === CameraController.FOLLOW && this.followRigid);
        }
        return this;
    }

    /**
     * Smoothly ease the camera towards a body or a world position.
     * The destination is recomputed every frame, so a moving body stays framed.
     *
     * @param {Object|THREE.Vector3} target a Planet, a THREE.Vector3 or {x,y,z}
     * @param {Object} [options]
     *   duration {number}  seconds, default 1.0
     *   fill     {number}  fraction of the smaller viewport axis the body should
     *                      span, default 0.35
     *   radius   {number}  explicit radius when target is a bare point
     *   follow   {boolean} enter follow mode on arrival, default false
     *   onComplete {Function}
     */
    flyTo(target, options) {
        if (!target) {
            return this;
        }
        options = options || {};

        // flights are driven through the orbit rig; leave pointer lock behind
        if (this.mode === CameraController.FLY) {
            this.exitPointerLock();
            this._keys = Object.create(null);
            this.mode = CameraController.ORBIT;
            this.controls.enabled = this.enabled;
            this._emitModeChange();
        }

        const isBody = !(target instanceof THREE.Vector3) && typeof target.x !== 'number';
        const planet = isBody ? target : null;
        const point = isBody ? null : new THREE.Vector3(target.x, target.y, target.z);

        if (planet && planet.removed) {
            return this;
        }

        const radius = options.radius !== undefined
            ? options.radius
            : (planet ? this._radiusOf(planet) : 1);

        const fill = options.fill !== undefined ? options.fill : 0.35;
        const distance = this.frameDistanceFor(radius, fill);

        const destinationCenter = new THREE.Vector3();
        if (planet) {
            this._readPosition(planet, destinationCenter);
        } else {
            destinationCenter.copy(point);
        }

        // approach direction: keep the current viewing direction when possible
        const direction = new THREE.Vector3().copy(this.camera.position).sub(destinationCenter);
        if (direction.lengthSq() < 1e-8) {
            this.camera.getWorldDirection(direction);
            direction.negate();
        }
        direction.normalize();

        const duration = Math.max(0.05, options.duration !== undefined ? options.duration : 1.0);

        this._flight = {
            planet: planet,
            point: point ? point.clone() : null,
            distance: distance,
            direction: direction,
            startPosition: this.camera.position.clone(),
            startTarget: this.controls.target.clone(),
            elapsed: 0,
            duration: duration,
            follow: !!options.follow,
            onComplete: options.onComplete || null,
            restoreControls: true
        };

        // freeze OrbitControls while the animation owns the camera
        this.controls.enabled = false;
        return this;
    }

    /**
     * Distance at which a sphere of `radius` spans `fill` of the smaller
     * viewport axis. Works for bodies of wildly different sizes.
     */
    frameDistanceFor(radius, fill) {
        const safeRadius = Math.max(radius || 0, 1e-4);
        const clampedFill = Math.min(Math.max(fill || 0.35, 0.02), 0.98);
        const vFov = this.camera.fov * Math.PI / 180;
        const aspect = this.camera.aspect || 1;
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
        const halfAngle = Math.min(vFov, hFov) / 2;
        const angularRadius = Math.max(halfAngle * clampedFill, 1e-4);
        const distance = safeRadius / Math.sin(angularRadius);
        return Math.max(distance, safeRadius * 1.2 + this.camera.near * 4);
    }

    /** Frame the currently selected body (keyboard `C`). */
    frameSelected(options) {
        const selected = this.getSelected();
        if (!selected) {
            this._notice('Nenhum corpo selecionado.');
            return this;
        }
        this.flyTo(selected, options || { fill: 0.4 });
        return this;
    }

    /**
     * Compute the bounding sphere of every body and frame it (keyboard `A`).
     */
    frameAll(options) {
        const bodies = this._bodies();
        if (!bodies.length) {
            return this;
        }
        options = options || {};

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < bodies.length; i++) {
            const body = bodies[i];
            if (!body || body.removed || !body.position) {
                continue;
            }
            const p = body.position;
            const r = this._radiusOf(body);
            if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) {
                continue;
            }
            if (p.x - r < minX) { minX = p.x - r; }
            if (p.y - r < minY) { minY = p.y - r; }
            if (p.z - r < minZ) { minZ = p.z - r; }
            if (p.x + r > maxX) { maxX = p.x + r; }
            if (p.y + r > maxY) { maxY = p.y + r; }
            if (p.z + r > maxZ) { maxZ = p.z + r; }
        }

        if (!isFinite(minX)) {
            return this;
        }

        const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
        let radius = 0;
        for (let i = 0; i < bodies.length; i++) {
            const body = bodies[i];
            if (!body || body.removed || !body.position) {
                continue;
            }
            const p = body.position;
            if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) {
                continue;
            }
            const dx = p.x - center.x;
            const dy = p.y - center.y;
            const dz = p.z - center.z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + this._radiusOf(body);
            if (d > radius) {
                radius = d;
            }
        }
        radius = Math.max(radius, 1);

        this.stopFollowing();
        this.flyTo(center, {
            radius: radius,
            fill: options.fill !== undefined ? options.fill : 0.9,
            duration: options.duration !== undefined ? options.duration : 1.1
        });
        return this;
    }

    /** Restore the initial camera placement (keyboard `R`). */
    reset() {
        this.cancelFlight();
        this.stopFollowing();
        this.setMode(CameraController.ORBIT);
        this.controls.enabled = this.enabled;
        this.controls.reset();
        this._syncFlyAnglesFromCamera();
        return this;
    }

    // -----------------------------------------------------------------------
    // semi-fixed view (mobile)
    // -----------------------------------------------------------------------
    //
    // On a phone there are no camera controls at all: each scenario is shown
    // from a viewpoint it chooses itself, through `meta.mobileView`. The camera
    // sits at a fixed distance, elevation and azimuth relative to the disk
    // normal, looks at a fixed point or at a body it tracks, and drifts slowly
    // around the normal so the frame is *semi*-fixed rather than a photograph.
    //
    // This is NOT a member of MODES: adding it there would put it in the
    // desktop `cycleMode()` rotation. It is a separate switch that overrides
    // whatever mode is set, and turning it off restores the mode untouched.
    //
    // EVERY field of meta.mobileView may be missing or malformed. Validation
    // lives in the static helpers below, which are pure (no THREE, no DOM) so
    // that the placement maths can be exercised outside a browser.

    static get FIXED() { return 'fixed'; }

    /** A finite number, or `fallback`. */
    static safeNumber(value, fallback) {
        return (typeof value === 'number' && isFinite(value)) ? value : fallback;
    }

    /** `value` clamped to [min, max]; anything non-finite becomes `min`. */
    static clampNumber(value, min, max) {
        if (!(typeof value === 'number' && isFinite(value))) {
            return min;
        }
        return Math.min(Math.max(value, min), max);
    }

    /**
     * A unit vector from a possibly malformed {x, y, z}. Falls back to +Z,
     * which is the plane the rest of the render layer already builds rings in.
     * @returns {{x:number, y:number, z:number}} a plain object, never THREE
     */
    static normalizeAxis(raw) {
        // All three components must be finite numbers, exactly as
        // resolveDiskNormal() in main.js demands: a vector with one bad
        // component says nothing trustworthy about the other two.
        const x = CameraController.safeNumber(raw && raw.x, NaN);
        const y = CameraController.safeNumber(raw && raw.y, NaN);
        const z = CameraController.safeNumber(raw && raw.z, NaN);
        const length = Math.sqrt(x * x + y * y + z * z);
        if (!(length > 1e-9) || !isFinite(length)) {
            return { x: 0, y: 0, z: 1 };
        }
        return { x: x / length, y: y / length, z: z / length };
    }

    /**
     * An orthonormal basis of the plane whose normal is the unit vector `n`.
     * u = normalize(n x helper), v = n x u, so (u, v, n) is right-handed.
     */
    static planeBasis(n) {
        const helper = (Math.abs(n.z) < 0.9)
            ? { x: 0, y: 0, z: 1 }
            : { x: 1, y: 0, z: 0 };
        let ux = n.y * helper.z - n.z * helper.y;
        let uy = n.z * helper.x - n.x * helper.z;
        let uz = n.x * helper.y - n.y * helper.x;
        let length = Math.sqrt(ux * ux + uy * uy + uz * uz);
        if (!(length > 1e-9)) {
            ux = 1; uy = 0; uz = 0; length = 1;
        }
        ux /= length; uy /= length; uz /= length;
        const vx = n.y * uz - n.z * uy;
        const vy = n.z * ux - n.x * uz;
        const vz = n.x * uy - n.y * ux;
        return { u: { x: ux, y: uy, z: uz }, v: { x: vx, y: vy, z: vz } };
    }

    /**
     * The camera's offset from its target, given a precomputed basis.
     *
     *   offset = distance * ( u cos(el) cos(az) + v cos(el) sin(az) + n sin(el) )
     *
     * `u`, `v`, `n` may be plain objects or THREE.Vector3 - only .x/.y/.z are
     * read. `out` is written in place, so the render loop allocates nothing.
     */
    static mobileOffsetFromBasis(u, v, n, distance, elevationDegrees, azimuthDegrees, out) {
        const target = out || { x: 0, y: 0, z: 0 };
        let d = CameraController.safeNumber(distance, 1);
        if (!(d > 0)) {
            d = 1;
        }
        const elevation = CameraController.clampNumber(elevationDegrees, -89, 89) * Math.PI / 180;
        const azimuth = CameraController.safeNumber(azimuthDegrees, 0) * Math.PI / 180;
        const flat = Math.cos(elevation);
        const up = Math.sin(elevation);
        const a = flat * Math.cos(azimuth) * d;
        const b = flat * Math.sin(azimuth) * d;
        const c = up * d;
        target.x = u.x * a + v.x * b + n.x * c;
        target.y = u.y * a + v.y * b + n.y * c;
        target.z = u.z * a + v.z * b + n.z * c;
        return target;
    }

    /** mobileOffsetFromBasis, deriving the basis from a (possibly bad) normal. */
    static mobileOffset(normal, distance, elevationDegrees, azimuthDegrees, out) {
        const n = CameraController.normalizeAxis(normal);
        const basis = CameraController.planeBasis(n);
        return CameraController.mobileOffsetFromBasis(
            basis.u, basis.v, n, distance, elevationDegrees, azimuthDegrees, out);
    }

    /**
     * Validate and clamp a scenario's `meta.mobileView`. Nothing here throws:
     * `raw` may be undefined, null, a string, or an object with every field
     * wrong, and the result is always a complete, usable view.
     *
     * @param {*} raw          meta.mobileView, whatever it turned out to be
     * @param {Object} [options]
     *   normal          {x,y,z}  the disk normal to place the camera against
     *   defaultDistance {number} used when `raw.distance` is missing or bad
     * @returns {{distance:number, elevation:number, azimuth:number,
     *           target:?{x:number,y:number,z:number}, autoRotate:number,
     *           follow:?string, normal:{x:number,y:number,z:number}}}
     */
    static normalizeMobileView(raw, options) {
        options = options || {};
        const source = (raw && typeof raw === 'object') ? raw : {};

        let fallback = CameraController.safeNumber(options.defaultDistance, NaN);
        if (!(fallback > 0)) {
            fallback = CameraController.DEFAULT_MOBILE_DISTANCE;
        }
        let distance = CameraController.safeNumber(source.distance, NaN);
        if (!(distance > 0)) {
            distance = fallback;
        }
        distance = Math.min(Math.max(distance, 1e-3), 1e7);

        const elevation = CameraController.clampNumber(
            CameraController.safeNumber(source.elevation, 28), -89, 89);

        // Any azimuth is legal; it is only folded into [0, 360) so the drift
        // does not start from an absurd number.
        let azimuth = CameraController.safeNumber(source.azimuth, 35);
        azimuth = ((azimuth % 360) + 360) % 360;

        let target = null;
        const rawTarget = source.target;
        if (rawTarget && typeof rawTarget === 'object') {
            const x = CameraController.safeNumber(rawTarget.x, NaN);
            const y = CameraController.safeNumber(rawTarget.y, NaN);
            const z = CameraController.safeNumber(rawTarget.z, NaN);
            if (isFinite(x) && isFinite(y) && isFinite(z)) {
                target = { x: x, y: y, z: z };
            }
        }

        // Degrees per REAL second. Clamped hard: the brief says keep it slow,
        // and a scenario asking for 400 deg/s would be unwatchable.
        const autoRotate = CameraController.clampNumber(
            CameraController.safeNumber(source.autoRotate, 0), -30, 30);

        const follow = (source.follow === 'dominant' || source.follow === 'largest')
            ? source.follow
            : null;

        const normal = CameraController.normalizeAxis(
            options.normal || source.normal || null);

        return {
            distance: distance,
            elevation: elevation,
            azimuth: azimuth,
            target: target,
            autoRotate: autoRotate,
            follow: follow,
            normal: normal
        };
    }

    /** AU. Only used when a scenario publishes no usable distance at all. */
    static get DEFAULT_MOBILE_DISTANCE() { return 40; }

    /** Is the semi-fixed view currently driving the camera? */
    isFixed() {
        return !!this.fixedView;
    }

    /** The normalised view in force, or null. */
    getFixedView() {
        return this.fixedView;
    }

    /**
     * Turn the semi-fixed view on. Input handling (OrbitControls, the keyboard,
     * picking, pointer lock) is switched off rather than fought with.
     *
     * @param {*} raw        meta.mobileView, in any state
     * @param {Object} [options] see normalizeMobileView
     */
    setFixedView(raw, options) {
        const view = CameraController.normalizeMobileView(raw, options);

        if (!this.fixedView) {
            this._fixedSavedUp.copy(this.camera.up);
        }

        this.cancelFlight();
        this.stopFollowing();          // must run BEFORE input is switched off
        // Not silent: the panel must forget the selection too, or flipping back
        // to the desktop build would leave an inspector pointing at nothing.
        this.select(null);

        this.fixedView = view;
        this._fixedAzimuth = view.azimuth * Math.PI / 180;
        this._fixedTarget = null;
        this._fixedTimer = Infinity;   // force an immediate re-acquisition
        this.mode = CameraController.ORBIT;

        const basis = CameraController.planeBasis(view.normal);
        this._fixedU.set(basis.u.x, basis.u.y, basis.u.z);
        this._fixedV.set(basis.v.x, basis.v.y, basis.v.z);
        this._fixedN.set(view.normal.x, view.normal.y, view.normal.z);

        this.enabled = false;
        this.controls.enabled = false;
        this._keys = Object.create(null);
        this.exitPointerLock();

        this._applyFixedView(0, true);
        return this;
    }

    /** Turn it off and hand the camera back to the ordinary modes. */
    clearFixedView() {
        if (!this.fixedView) {
            return this;
        }
        this.fixedView = null;
        this._fixedTarget = null;
        if (this.camera.up && this.camera.up.copy) {
            this.camera.up.copy(this._fixedSavedUp);
        }
        this.setEnabled(true);
        return this;
    }

    /**
     * Place the camera for this frame.
     * @param {number} dt REAL seconds since the previous frame
     * @param {boolean} immediate re-acquire the followed body right now
     */
    _applyFixedView(dt, immediate) {
        const view = this.fixedView;
        if (!view) {
            return this;
        }
        if (!(typeof dt === 'number' && isFinite(dt) && dt > 0)) {
            dt = 0;
        }

        // Real seconds, so the drift is the same at 1x and at 4x, and continues
        // while the simulation is paused.
        if (view.autoRotate) {
            const twoPi = Math.PI * 2;
            this._fixedAzimuth += view.autoRotate * Math.PI / 180 * dt;
            this._fixedAzimuth = ((this._fixedAzimuth % twoPi) + twoPi) % twoPi;
        }

        this._fixedTimer += dt;
        if (view.follow) {
            const lost = !this._fixedTarget || this._fixedTarget.removed;
            if (immediate || lost || this._fixedTimer >= 0.5) {
                this._fixedTimer = 0;
                this._fixedTarget = this._pickFixedTarget(view.follow);
            }
        } else {
            this._fixedTarget = null;
        }

        const point = this._fixedPoint;
        point.set(0, 0, 0);
        if (this._fixedTarget && !this._fixedTarget.removed) {
            this._readPosition(this._fixedTarget, point);
        } else if (view.target) {
            point.set(view.target.x, view.target.y, view.target.z);
        }

        const offset = CameraController.mobileOffsetFromBasis(
            this._fixedU, this._fixedV, this._fixedN,
            view.distance, view.elevation,
            this._fixedAzimuth * 180 / Math.PI,
            this._fixedOffset);

        this.camera.position.set(
            point.x + offset.x, point.y + offset.y, point.z + offset.z);
        this.controls.target.copy(point);
        if (this.camera.up && this.camera.up.set) {
            // The disk normal is "up", so the plane reads as a plane rather
            // than as an arbitrarily rolled silhouette.
            this.camera.up.set(this._fixedN.x, this._fixedN.y, this._fixedN.z);
        }
        this.camera.lookAt(point);
        return this;
    }

    /**
     * The body the view should track.
     *   'dominant' -> the heaviest star or black hole
     *   'largest'  -> the heaviest body of any kind
     * Re-run whenever the current target dies, so merges re-target on their own.
     */
    _pickFixedTarget(kind) {
        const bodies = this._bodies();
        let best = null;
        let bestMass = -Infinity;
        const dominantOnly = (kind === 'dominant');

        for (let i = 0; i < bodies.length; i++) {
            const body = bodies[i];
            if (!body || body.removed || !body.position) {
                continue;
            }
            const p = body.position;
            if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) {
                continue;
            }
            if (dominantOnly && !CameraController.isDominantCandidate(body)) {
                continue;
            }
            const mass = CameraController.safeNumber(body.mass, 0);
            if (mass > bestMass) {
                bestMass = mass;
                best = body;
            }
        }

        // A scenario may ask to track the dominant star and then contain none
        // (a cluster of embryos, a disk whose star was swallowed). Falling back
        // to the heaviest body keeps the frame pointed at something.
        if (!best && dominantOnly) {
            return this._pickFixedTarget('largest');
        }
        return best;
    }

    /** Star or black hole, by whichever field the physics layer publishes. */
    static isDominantCandidate(planet) {
        if (!planet) {
            return false;
        }
        if (planet.isBlackHole === true || planet.isCentralStar === true) {
            return true;
        }
        const kind = planet.classification;
        return kind === 'star' || kind === 'blackHole';
    }

    // -----------------------------------------------------------------------
    // free-fly speed
    // -----------------------------------------------------------------------

    getFlySpeed() {
        return this.flySpeed;
    }

    setFlySpeed(value) {
        this.flySpeed = Math.min(Math.max(value, this.flySpeedMin), this.flySpeedMax);
        return this;
    }

    isPointerLocked() {
        return this._pointerLocked;
    }

    requestPointerLock() {
        const element = this.domElement;
        const request = element.requestPointerLock || element.mozRequestPointerLock;
        if (request) {
            try { request.call(element); } catch (e) { /* ignore */ }
        }
        return this;
    }

    exitPointerLock() {
        const exit = document.exitPointerLock || document.mozExitPointerLock;
        if (exit && (document.pointerLockElement || document.mozPointerLockElement)) {
            try { exit.call(document); } catch (e) { /* ignore */ }
        }
        return this;
    }

    // -----------------------------------------------------------------------
    // main loop
    // -----------------------------------------------------------------------

    /**
     * @param {number} dt seconds since the previous frame
     */
    update(dt) {
        if (typeof dt !== 'number' || !isFinite(dt) || dt <= 0) {
            dt = 1 / 60;
        }
        dt = Math.min(dt, 0.1);

        this._pruneDeadReferences(dt);

        // The semi-fixed view replaces every other camera behaviour, and it is
        // driven by REAL seconds so its drift is independent of the sim speed.
        if (this.fixedView) {
            this._applyFixedView(dt, false);
            return this;
        }

        if (this._flight) {
            this._updateFlight(dt);
        } else if (this.mode === CameraController.FLY) {
            this._updateFly(dt);
        } else if (this.mode === CameraController.FOLLOW) {
            this._updateFollow(dt);
        }

        if (this.controls.enabled) {
            this.controls.update();
        }
        return this;
    }

    _pruneDeadReferences(dt) {
        if (this.selected && this.selected.removed) {
            this.select(null);
        }
        if (this.followed && this.followed.removed) {
            this._loseFollowTarget();
        }
        if (this._flight && this._flight.planet && this._flight.planet.removed) {
            const flight = this._flight;
            this._flight = null;
            if (flight.restoreControls) {
                this.controls.enabled = this.enabled && this.mode !== CameraController.FLY;
            }
            this._notice('O destino desapareceu durante o trajeto.');
        }

        // bodies can also be dropped from the array without the flag being seen
        this._membershipTimer += dt;
        if (this._membershipTimer < 0.25) {
            return;
        }
        this._membershipTimer = 0;

        if (!this.selected && !this.followed && !this._flight) {
            return;
        }
        const bodies = this._bodies();
        if (this.selected && bodies.indexOf(this.selected) === -1) {
            this.select(null);
        }
        if (this.followed && bodies.indexOf(this.followed) === -1) {
            this._loseFollowTarget();
        }
        if (this._flight && this._flight.planet && bodies.indexOf(this._flight.planet) === -1) {
            this._flight = null;
            this.controls.enabled = this.enabled && this.mode !== CameraController.FLY;
        }
    }

    _updateFlight(dt) {
        const flight = this._flight;
        flight.elapsed += dt;

        const raw = Math.min(flight.elapsed / flight.duration, 1);
        const eased = CameraController.easeInOutCubic(raw);

        const center = this._v1;
        if (flight.planet) {
            this._readPosition(flight.planet, center);
        } else {
            center.copy(flight.point);
        }

        const destination = this._v2
            .copy(flight.direction)
            .multiplyScalar(flight.distance)
            .add(center);

        this.camera.position.lerpVectors(flight.startPosition, destination, eased);
        this.controls.target.lerpVectors(flight.startTarget, center, eased);
        this.camera.lookAt(this.controls.target);

        if (raw >= 1) {
            this._flight = null;
            this._syncFlyAnglesFromCamera();

            if (flight.follow && flight.planet && !flight.planet.removed) {
                this._setFollowed(flight.planet);
                this.mode = CameraController.FOLLOW;
                this._captureFollowOffset();
                this.controls.enabled = this.enabled && !this.followRigid;
                this._emitModeChange();
            } else {
                this.controls.enabled = this.enabled && this.mode !== CameraController.FLY;
            }

            if (flight.onComplete) {
                try { flight.onComplete(); } catch (e) { console.error(e); }
            }
        }
    }

    _updateFollow(dt) {
        const body = this.getFollowed();
        if (!body) {
            this._loseFollowTarget();
            return;
        }
        this._readPosition(body, this._v1);

        if (this.followRigid) {
            this.camera.position.copy(this._v1).add(this.followOffset);
            this.controls.target.copy(this._v1);
            this.camera.lookAt(this._v1);
        } else {
            // translate the whole orbit rig so the user keeps free rotation/zoom
            const delta = this._v2.copy(this._v1).sub(this.controls.target);
            this.controls.target.copy(this._v1);
            this.camera.position.add(delta);
            this.followOffset.copy(this.camera.position).sub(this._v1);
        }
    }

    _updateFly(dt) {
        const keys = this._keys;

        let forward = 0;
        let strafe = 0;
        let vertical = 0;

        if (keys['KeyW'] || keys['ArrowUp']) { forward += 1; }
        if (keys['KeyS'] || keys['ArrowDown']) { forward -= 1; }
        if (keys['KeyD'] || keys['ArrowRight']) { strafe += 1; }
        if (keys['KeyA'] || keys['ArrowLeft']) { strafe -= 1; }
        if (keys['KeyE']) { vertical += 1; }
        if (keys['KeyQ']) { vertical -= 1; }

        if (!forward && !strafe && !vertical) {
            return;
        }

        let speed = this.flySpeed;
        if (keys['ShiftLeft'] || keys['ShiftRight']) { speed *= this.flyBoost; }
        if (keys['ControlLeft'] || keys['ControlRight']) { speed *= this.flySlow; }

        const step = speed * dt;

        const direction = this._v1.set(0, 0, 0);
        const forwardVector = this._v2.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        const rightVector = this._v3.set(1, 0, 0).applyQuaternion(this.camera.quaternion);

        direction.addScaledVector(forwardVector, forward);
        direction.addScaledVector(rightVector, strafe);
        direction.y += vertical;

        if (direction.lengthSq() > 0) {
            direction.normalize().multiplyScalar(step);
            this.camera.position.add(direction);
        }
    }

    _placeOrbitTargetAhead() {
        const direction = this._v1;
        this.camera.getWorldDirection(direction);
        const distance = Math.max(this.flySpeed, 50);
        this.controls.target.copy(this.camera.position).addScaledVector(direction, distance);
    }

    _syncFlyAnglesFromCamera() {
        this._euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
        this._yaw = this._euler.y;
        this._pitch = this._euler.x;
    }

    _applyFlyAngles() {
        const limit = Math.PI / 2 - 0.001;
        this._pitch = Math.min(Math.max(this._pitch, -limit), limit);
        this._euler.set(this._pitch, this._yaw, 0, 'YXZ');
        this.camera.quaternion.setFromEuler(this._euler);
    }

    // -----------------------------------------------------------------------
    // input handlers
    // -----------------------------------------------------------------------

    _handleBlur() {
        this._keys = Object.create(null);
    }

    _handlePointerLockChange() {
        const element = document.pointerLockElement || document.mozPointerLockElement || null;
        this._pointerLocked = element === this.domElement;
        if (!this._pointerLocked) {
            this._keys = Object.create(null);
        }
    }

    _handleMouseMove(event) {
        if (!this.enabled || !this._pointerLocked || this.mode !== CameraController.FLY) {
            return;
        }
        const dx = event.movementX || event.mozMovementX || 0;
        const dy = event.movementY || event.mozMovementY || 0;
        this._yaw -= dx * this.lookSensitivity;
        this._pitch -= dy * this.lookSensitivity;
        this._applyFlyAngles();
    }

    _handlePointerDown(event) {
        if (!this.enabled || event.isPrimary === false) {
            return;
        }
        this.cancelFlight();
        this._pointerDown = {
            x: event.clientX,
            y: event.clientY,
            button: event.button,
            time: Date.now()
        };
        if (this.mode === CameraController.FLY && !this._pointerLocked && event.button === 0) {
            this.requestPointerLock();
        }
    }

    _handlePointerUp(event) {
        if (!this.enabled || event.isPrimary === false || !this._pointerDown) {
            return;
        }
        const down = this._pointerDown;
        this._pointerDown = null;

        if (event.button !== 0 || down.button !== 0) {
            return;
        }

        if (this.mode === CameraController.FLY) {
            if (this._pointerLocked) {
                this.pickAtScreenCenter();
            }
            return;
        }

        const moved = Math.abs(event.clientX - down.x) + Math.abs(event.clientY - down.y);
        const elapsed = Date.now() - down.time;
        if (moved > 6 || elapsed > 450) {
            return; // that was a drag-rotate, not a click
        }
        this.pickAtClientPoint(event.clientX, event.clientY);
    }

    _handleWheel(event) {
        if (!this.enabled) {
            return;
        }
        this.cancelFlight();
        if (this.mode !== CameraController.FLY) {
            return; // OrbitControls owns the wheel in orbit / follow modes
        }
        event.preventDefault();
        const delta = event.deltaY || 0;
        const factor = delta < 0 ? 1.18 : (delta > 0 ? 1 / 1.18 : 1);
        this.setFlySpeed(this.flySpeed * factor);
    }

    _handleKeyDown(event) {
        if (!this.enabled || CameraController.isTypingTarget(event.target)) {
            return;
        }
        // never swallow browser / OS shortcuts
        if (event.metaKey || event.altKey) {
            return;
        }

        const code = event.code || '';
        this._keys[code] = true;

        // Ctrl is only a fly-mode modifier
        if (event.ctrlKey && code !== 'ControlLeft' && code !== 'ControlRight') {
            return;
        }

        switch (code) {
            case 'Digit1':
            case 'Numpad1':
                this.setMode(CameraController.ORBIT);
                event.preventDefault();
                break;
            case 'Digit2':
            case 'Numpad2':
                this.setMode(CameraController.FLY);
                event.preventDefault();
                break;
            case 'Digit3':
            case 'Numpad3':
                this.setMode(CameraController.FOLLOW);
                event.preventDefault();
                break;
            case 'KeyF':
                this.followSelected();
                event.preventDefault();
                break;
            case 'KeyG':
                this.toggleFollowRigid();
                event.preventDefault();
                break;
            case 'KeyC':
                this.frameSelected();
                event.preventDefault();
                break;
            case 'KeyR':
                this.reset();
                event.preventDefault();
                break;
            case 'Space':
                if (this.onTogglePause) {
                    try { this.onTogglePause(); } catch (e) { console.error(e); }
                }
                event.preventDefault();
                break;
            case 'Tab':
            case 'KeyN':
                this.cycleSelection(event.shiftKey ? -1 : 1);
                event.preventDefault();
                break;
            case 'KeyB':
                this.cycleSelection(-1);
                event.preventDefault();
                break;
            case 'KeyH':
            case 'Slash':
                if (this.onToggleHelp) {
                    try { this.onToggleHelp(); } catch (e) { console.error(e); }
                }
                event.preventDefault();
                break;
            case 'Escape':
                if (this._pointerLocked) {
                    this.exitPointerLock();
                } else {
                    this.clearSelection();
                }
                break;
            default:
                break;
        }

        // "A" is frame-all outside fly mode, strafe-left inside it
        if (code === 'KeyA' && this.mode !== CameraController.FLY) {
            this.frameAll();
            event.preventDefault();
        }
    }

    _handleKeyUp(event) {
        const code = event.code || '';
        delete this._keys[code];
    }

    // -----------------------------------------------------------------------
    // picking
    // -----------------------------------------------------------------------

    /**
     * Raycast at a viewport pixel and select whatever body is under it.
     * @returns {Object|null} the picked planet
     */
    pickAtClientPoint(clientX, clientY) {
        const rect = this.domElement.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            return null;
        }
        const x = ((clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((clientY - rect.top) / rect.height) * 2 + 1;
        return this._pickAtNdc(x, y);
    }

    /** Raycast straight ahead (used while pointer-locked in fly mode). */
    pickAtScreenCenter() {
        return this._pickAtNdc(0, 0);
    }

    _pickAtNdc(x, y) {
        const roots = this._collectPickables();
        if (!roots.list.length) {
            return null;
        }
        this._ndc.set(x, y);
        this._raycaster.setFromCamera(this._ndc, this.camera);
        this._raycaster.far = this.camera.far;

        const hits = this._raycaster.intersectObjects(roots.list, roots.recursive);
        for (let i = 0; i < hits.length; i++) {
            const planet = this._planetFromIntersection(hits[i]);
            if (planet) {
                this.select(planet);
                return planet;
            }
        }
        this.select(null);
        return null;
    }

    /**
     * Objects handed to the raycaster.
     * Preference order: explicit getPickables() > the scene graph > per-body
     * meshes. Duplicates are removed so a shared InstancedMesh is tested once.
     * @returns {{list: Array, recursive: boolean}}
     */
    _collectPickables() {
        const buffer = this._meshBuffer;
        buffer.length = 0;

        if (this.getPickables) {
            let list = null;
            try { list = this.getPickables(); } catch (e) { list = null; }
            if (Array.isArray(list) && list.length) {
                for (let i = 0; i < list.length; i++) {
                    if (list[i]) {
                        buffer.push(list[i]);
                    }
                }
                return { list: buffer, recursive: true };
            }
        }

        if (this.scene && this.scene.children && this.scene.children.length) {
            for (let i = 0; i < this.scene.children.length; i++) {
                if (this.scene.children[i]) {
                    buffer.push(this.scene.children[i]);
                }
            }
            return { list: buffer, recursive: true };
        }

        if (this.getMeshFor) {
            const bodies = this._bodies();
            for (let i = 0; i < bodies.length; i++) {
                const body = bodies[i];
                if (!body || body.removed) {
                    continue;
                }
                let mesh = null;
                try { mesh = this.getMeshFor(body); } catch (e) { mesh = null; }
                if (mesh && mesh.visible !== false && buffer.indexOf(mesh) === -1) {
                    buffer.push(mesh);
                }
            }
        }
        return { list: buffer, recursive: false };
    }

    /**
     * Map a THREE intersection record back to a simulation body.
     * Handles plain meshes, InstancedMesh instances and the custom
     * `resolvePlanetId` hook.
     */
    _planetFromIntersection(intersection) {
        if (!intersection || !intersection.object) {
            return null;
        }

        if (this.resolvePlanetId) {
            let id = null;
            try { id = this.resolvePlanetId(intersection); } catch (e) { id = null; }
            const planet = this._planetById(id);
            if (planet) {
                return planet;
            }
        }

        let node = intersection.object;
        while (node) {
            const data = node.userData;
            if (data) {
                // InstancedMesh: one object, many bodies
                if (intersection.instanceId !== undefined && intersection.instanceId !== null) {
                    if (typeof data.getPlanetId === 'function') {
                        const planet = this._planetById(data.getPlanetId(intersection.instanceId));
                        if (planet) {
                            return planet;
                        }
                    }
                    if (data.planetIds) {
                        const planet = this._planetById(data.planetIds[intersection.instanceId]);
                        if (planet) {
                            return planet;
                        }
                    }
                }
                if (data.planetId !== undefined && data.planetId !== null) {
                    const planet = this._planetById(data.planetId);
                    if (planet) {
                        return planet;
                    }
                }
                if (data.planet && !data.planet.removed) {
                    return data.planet;
                }
            }
            node = node.parent;
        }
        return null;
    }

    _planetById(id) {
        if (id === undefined || id === null) {
            return null;
        }
        const bodies = this._bodies();
        for (let i = 0; i < bodies.length; i++) {
            const body = bodies[i];
            if (body && body.id === id && !body.removed) {
                return body;
            }
        }
        return null;
    }

    _meshFor(planet) {
        if (!planet || !this.getMeshFor) {
            return null;
        }
        try { return this.getMeshFor(planet) || null; } catch (e) { return null; }
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    _bodies() {
        let bodies;
        try { bodies = this.getBodies(); } catch (e) { bodies = null; }
        return Array.isArray(bodies) ? bodies : [];
    }

    _readPosition(planet, out) {
        const p = planet && planet.position;
        if (p && isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) {
            out.set(p.x, p.y, p.z);
        }
        return out;
    }

    _radiusOf(planet) {
        const r = planet && planet.radius;
        return (typeof r === 'number' && isFinite(r) && r > 0) ? r : 1;
    }

    /** Distance from the camera to a body, in world units. */
    distanceTo(planet) {
        if (!planet || !planet.position) {
            return Infinity;
        }
        const dx = planet.position.x - this.camera.position.x;
        const dy = planet.position.y - this.camera.position.y;
        const dz = planet.position.z - this.camera.position.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    static easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    static isTypingTarget(target) {
        if (!target || !target.tagName) {
            return false;
        }
        const tag = target.tagName.toUpperCase();
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
    }

    // -----------------------------------------------------------------------
    // key binding table (consumed by NavigatorUI to render the help overlay)
    // -----------------------------------------------------------------------

    /**
     * @returns {Array<{keys:string, description:string, group:string}>}
     */
    getKeyBindings() {
        return [
            { group: 'Modos', keys: '1', description: 'Modo órbita' },
            { group: 'Modos', keys: '2', description: 'Modo livre (voo)' },
            { group: 'Modos', keys: '3', description: 'Modo seguir (corpo selecionado)' },
            { group: 'Modos', keys: 'G', description: 'Alternar perseguição rígida / órbita no alvo' },

            { group: 'Navegação', keys: 'Clique', description: 'Selecionar corpo sob o cursor' },
            { group: 'Navegação', keys: 'F', description: 'Seguir / soltar o corpo selecionado' },
            { group: 'Navegação', keys: 'C', description: 'Enquadrar o corpo selecionado' },
            { group: 'Navegação', keys: 'A', description: 'Enquadrar toda a simulação' },
            { group: 'Navegação', keys: 'Tab / N', description: 'Próximo corpo' },
            { group: 'Navegação', keys: 'Shift+Tab / B', description: 'Corpo anterior' },
            { group: 'Navegação', keys: 'R', description: 'Redefinir a câmera' },
            { group: 'Navegação', keys: 'Esc', description: 'Sair da captura do mouse / limpar seleção' },

            { group: 'Modo livre', keys: 'W A S D', description: 'Mover para frente / lados' },
            { group: 'Modo livre', keys: 'Q / E', description: 'Descer / subir' },
            { group: 'Modo livre', keys: 'Shift', description: 'Turbo (6x)' },
            { group: 'Modo livre', keys: 'Ctrl', description: 'Movimento lento' },
            { group: 'Modo livre', keys: 'Roda', description: 'Ajustar velocidade de voo' },
            { group: 'Modo livre', keys: 'Clique', description: 'Capturar o mouse (Esc libera)' },

            { group: 'Simulação', keys: 'Espaço', description: 'Pausar / retomar' },
            { group: 'Simulação', keys: 'H / ?', description: 'Mostrar ou ocultar esta ajuda' }
        ];
    }
}
