/**
 * Render layer and application wiring.
 *
 * The physics core (Planet / Simulation / Octree) knows nothing about Three.js.
 * Everything visual lives here.
 *
 * WHAT IS ON SCREEN
 *   - every disk body as one instance of a single InstancedMesh (one draw call)
 *   - the host star as its own mesh, so it can carry a blackbody colour, an
 *     additive halo and the point light that illuminates the disk
 *   - optional guides: concentric rings in the disk plane plus the snow line
 *
 * UNITS: solar masses, astronomical units, years. `simulatedTime` is in YEARS.
 */

let camera, controls, scene, renderer, simulation, cameraController, ui;
let PERIODIC_TABLE_ELEMENTS;

let bodyMesh = null;
let planetIds = [];
let pickables = [];

// Host star visuals. The star is drawn outside the InstancedMesh because it is
// ~1e6 times more massive than an embryo and it emits light: it needs its own
// material, its own halo and its own point light.
let starGroup = null;
let starCore = null;
let starGlow = null;
let starLight = null;

// Disk guides (rings + snow line), toggled with `O`.
let guides = null;
let guidesVisible = true;
let snowLineRing = null;
let lastSnowLineRadius = -1;

// Reused every frame so the render loop allocates nothing.
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _starColor = new THREE.Color();
// Body colours are CSS strings that repeat across hundreds of bodies. Parsing
// them every frame is pure waste, so keep one THREE.Color per distinct string.
const colorCache = new Map();

let paused = false;
let speedMultiplier = 1;

// Rate meter: how many simulated years pass per real second, measured rather
// than assumed, because the step budget can saturate.
let simulatedYears = 0;
let yearsWindow = 0;
let clockWindow = 0;
let yearsPerSecond = 0;

// ---------------------------------------------------------------------------
// Render radius (poetic licence)
// ---------------------------------------------------------------------------

/**
 * displayR = clamp(SCALE * physicalR^EXPONENT, MIN, MAX)
 *
 * CALIBRATION NOTE. constants.js currently ships RENDER_RADIUS_SCALE = 1200,
 * which maps every body larger than ~0.1 Earth radii straight onto
 * RENDER_RADIUS_MAX: the whole disk becomes 800 overlapping 3 AU spheres and
 * nothing is legible. The calibrated value for this constant set is ~6:
 *
 *     0.4 Earth-mass embryo (3.2e-5 AU) -> 0.019 AU  (i.e. the 0.02 AU floor)
 *     Earth                 (4.3e-5 AU) -> 0.024 AU
 *     Jupiter               (4.7e-4 AU) -> 0.088 AU
 *     the Sun               (4.7e-3 AU) -> 0.31  AU  (disk inner edge is 0.5 AU)
 *
 * constants.js is owned by someone else, so the shipped value is validated
 * here instead of overwritten: if it pins a solar radius to the ceiling it is
 * rejected in favour of the calibrated one. Once RENDER_RADIUS_SCALE is fixed
 * upstream this guard silently becomes a no-op.
 */
const RENDER_RADIUS_SCALE_CALIBRATED = 6;

let renderRadiusScale = RENDER_RADIUS_SCALE_CALIBRATED;
let renderRadiusExponent = 0.55;
let renderRadiusMin = 0.02;
let renderRadiusMax = 1.5;

function resolveRenderRadiusMapping() {
    renderRadiusExponent = (typeof RENDER_RADIUS_EXPONENT === 'number' &&
        isFinite(RENDER_RADIUS_EXPONENT) && RENDER_RADIUS_EXPONENT > 0)
        ? RENDER_RADIUS_EXPONENT : 0.55;

    renderRadiusMin = (typeof RENDER_RADIUS_MIN === 'number' &&
        isFinite(RENDER_RADIUS_MIN) && RENDER_RADIUS_MIN > 0)
        ? RENDER_RADIUS_MIN : 0.02;

    renderRadiusMax = (typeof RENDER_RADIUS_MAX === 'number' &&
        isFinite(RENDER_RADIUS_MAX) && RENDER_RADIUS_MAX > renderRadiusMin)
        ? RENDER_RADIUS_MAX : Math.max(renderRadiusMin * 10, 1.5);

    const configured = (typeof RENDER_RADIUS_SCALE === 'number' &&
        isFinite(RENDER_RADIUS_SCALE) && RENDER_RADIUS_SCALE > 0)
        ? RENDER_RADIUS_SCALE : RENDER_RADIUS_SCALE_CALIBRATED;

    const solarRadius = (typeof SOLAR_RADIUS === 'number' && SOLAR_RADIUS > 0)
        ? SOLAR_RADIUS : 4.65e-3;

    // The star is the largest thing in the scene by a wide margin. If even it
    // saturates the ceiling then so does everything else, and the mapping has
    // no dynamic range left at all.
    const starDisplay = configured * Math.pow(solarRadius, renderRadiusExponent);
    renderRadiusScale = (starDisplay >= renderRadiusMax * 0.98)
        ? RENDER_RADIUS_SCALE_CALIBRATED
        : configured;
}

/** Physical radius (AU) -> radius actually drawn (AU). Never throws. */
function displayRadius(physicalRadius) {
    if (!(physicalRadius > 0) || !isFinite(physicalRadius)) {
        return renderRadiusMin;
    }
    const r = renderRadiusScale * Math.pow(physicalRadius, renderRadiusExponent);
    if (!(r > renderRadiusMin)) {
        return renderRadiusMin;
    }
    if (r > renderRadiusMax) {
        return renderRadiusMax;
    }
    return r;
}

/** Display radius of a body, tolerating a body without a usable radius. */
function displayRadiusOf(planet) {
    return displayRadius(planet && typeof planet.radius === 'number' ? planet.radius : 0);
}

// Composition colours are continuous, so over a long run the cache would grow
// without bound. 4096 entries is far more than the ~800 live at any instant;
// past that, drop the lot and let it refill.
const COLOR_CACHE_LIMIT = 4096;

function cachedColor(cssColor) {
    let color = colorCache.get(cssColor);
    if (color === undefined) {
        if (colorCache.size >= COLOR_CACHE_LIMIT) {
            colorCache.clear();
        }
        color = new THREE.Color(cssColor);
        colorCache.set(cssColor, color);
    }
    return color;
}

/** planet.color() is the contract; degrade to composition, then to grey. */
function colorOf(planet) {
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

// ---------------------------------------------------------------------------
// The host star
// ---------------------------------------------------------------------------

const WHITE = new THREE.Color(0xffffff);

let starCache = null;
let starProbeCountdown = 0;

/**
 * The central star, from the contract when it exists and from a rare O(n) scan
 * when it does not. The scan is throttled hard because it runs in the render
 * loop; the star does not change identity often enough to justify more.
 */
function currentStar() {
    if (simulation && simulation.star && !simulation.star.removed) {
        starCache = simulation.star;
        return starCache;
    }
    if (starCache && !starCache.removed) {
        return starCache;
    }
    starCache = null;
    if (starProbeCountdown-- > 0) {
        return null;
    }
    starProbeCountdown = 120;

    const planets = (simulation && Array.isArray(simulation.planets)) ? simulation.planets : null;
    if (!planets) {
        return null;
    }
    const threshold = (typeof HYDROGEN_BURNING_MASS === 'number') ? HYDROGEN_BURNING_MASS : 0.08;
    let best = null;
    for (let i = 0; i < planets.length; i++) {
        const planet = planets[i];
        if (!planet || planet.removed) {
            continue;
        }
        // isLuminous is deliberately NOT part of this test: structure.js gives
        // even a gas giant a residual contraction luminosity, so it would match
        // half the disk. Only a real star gets the star treatment.
        const isStar = planet.isCentralStar === true ||
            planet.classification === 'star' ||
            (typeof planet.mass === 'number' && planet.mass >= threshold);
        if (!isStar) {
            continue;
        }
        if (!best || planet.mass > best.mass) {
            best = planet;
        }
    }
    starCache = best;
    return best;
}

/** Colour of the star's own emission: blackbody first, then whatever it says. */
function starColorHex(star) {
    if (star && typeof blackbodyColorHex === 'function') {
        const temperature = star.effectiveTemperature;
        if (typeof temperature === 'number' && isFinite(temperature) && temperature > 0) {
            try {
                const hex = blackbodyColorHex(temperature);
                if (typeof hex === 'string' && hex) {
                    return hex;
                }
            } catch (e) { /* fall through */ }
        }
    }
    if (star) {
        return colorOf(star);
    }
    return '#fff2d8';
}

/**
 * A soft radial falloff, drawn once into a canvas and used as the halo sprite.
 * There is no EffectComposer or UnrealBloomPass in js/libs (only three.js and
 * OrbitControls are vendored, and we may not add files), so the glow is faked
 * with an additive sprite. It costs one quad.
 */
function createGlowTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const context = canvas.getContext('2d');
    const half = size / 2;
    const gradient = context.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0.00, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.14, 'rgba(255,255,255,0.72)');
    gradient.addColorStop(0.32, 'rgba(255,255,255,0.24)');
    gradient.addColorStop(0.60, 'rgba(255,255,255,0.06)');
    gradient.addColorStop(1.00, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
}

function createStar() {
    starGroup = new THREE.Group();
    starGroup.name = 'star';
    starGroup.visible = false;

    starCore = new THREE.Mesh(
        new THREE.SphereGeometry(1, 32, 24),
        new THREE.MeshBasicMaterial({ color: 0xfff2d8, fog: false, toneMapped: false })
    );
    starCore.frustumCulled = false;
    starCore.name = 'starCore';
    starGroup.add(starCore);

    starGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: createGlowTexture(),
        color: 0xfff2d8,
        blending: THREE.AdditiveBlending,
        transparent: true,
        // depth-tested but not depth-writing: bodies passing in front of the
        // star occlude the corona instead of being washed out by it. The sprite
        // shader includes the logdepthbuf chunks, so this is correct under the
        // logarithmic depth buffer too.
        depthWrite: false,
        depthTest: true,
        toneMapped: false
    }));
    starGlow.frustumCulled = false;
    // never pickable: clicks must land on the core, not on the halo
    starGlow.raycast = function () { };
    starGroup.add(starGlow);

    // Materials are Lambert, so the disk is genuinely lit by the star. distance
    // 0 disables attenuation: at 20 AU a physically attenuated light would leave
    // the outer disk black.
    starLight = new THREE.PointLight(0xffffff, 1.4, 0);
    starGroup.add(starLight);

    return starGroup;
}

/** Place and colour the star; hide it entirely when there is no star. */
function syncStar() {
    const star = currentStar();
    if (!starGroup) {
        return;
    }
    if (!star || !star.position) {
        // starCore is handed to the raycaster directly, so hiding only the
        // group would still leave an invisible pickable in front of the disk.
        starGroup.visible = false;
        starCore.visible = false;
        starCore.userData.planet = null;
        return;
    }

    starGroup.visible = true;
    starCore.visible = true;
    starGroup.position.set(star.position.x, star.position.y, star.position.z);
    starCore.userData.planet = star;

    const radius = displayRadiusOf(star);
    starCore.scale.setScalar(radius);
    starGlow.scale.setScalar(radius * 10);

    const boost = (typeof STAR_EMISSIVE_BOOST === 'number' && STAR_EMISSIVE_BOOST > 0)
        ? STAR_EMISSIVE_BOOST : 1;
    _starColor.set(starColorHex(star));

    // The halo keeps the honest blackbody hue; the core is the same hue driven
    // past 1.0 by the emissive boost, which is what makes a photographed star
    // read as a white disc with a coloured corona.
    starGlow.material.color.copy(_starColor);
    starCore.material.color.copy(_starColor).multiplyScalar(boost);
    starLight.color.copy(_starColor).lerp(WHITE, 0.6);
}

// ---------------------------------------------------------------------------
// Disk guides
// ---------------------------------------------------------------------------

function createCircleGeometry(segments) {
    const points = new Float32Array((segments + 1) * 3);
    for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        points[i * 3] = Math.cos(angle);
        points[i * 3 + 1] = Math.sin(angle);
        points[i * 3 + 2] = 0;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
    return geometry;
}

/**
 * Which way is "up" out of the disk? The physics layer decides that, not us, so
 * measure it: the axis with the smallest spread of body positions is the disk
 * normal. Defaults to +Z (the disk in the XY plane) when the cloud is not flat.
 */
function detectDiskNormalAxis(planets) {
    if (!Array.isArray(planets) || planets.length < 8) {
        return 'z';
    }
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let i = 0; i < planets.length; i++) {
        const planet = planets[i];
        const p = planet && planet.position;
        if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) {
            continue;
        }
        sx += p.x * p.x;
        sy += p.y * p.y;
        sz += p.z * p.z;
        n++;
    }
    if (n < 8) {
        return 'z';
    }
    if (sz <= sx && sz <= sy) {
        return 'z';
    }
    return (sy <= sx) ? 'y' : 'x';
}

/**
 * Tilt the camera out of the disk plane before the opening frame.
 *
 * A protoplanetary disk viewed exactly edge-on is a line. Everything the
 * simulation is actually about - the radial ordering of the bodies, the snow
 * line, the orbit ellipses - only becomes legible from above the plane, so open
 * on a three-quarter view instead of whatever axis the camera happened to start
 * on. The user can still drop to edge-on by dragging, which is the right way to
 * inspect how thin the disk is.
 */
function orientCameraToDisk(planets) {
    const axis = detectDiskNormalAxis(planets);
    const elevationDegrees = 32;
    const up = Math.sin(elevationDegrees * Math.PI / 180);
    const along = Math.cos(elevationDegrees * Math.PI / 180);
    // Kept off the cardinal axes so the disk reads as a disk, not a symmetric
    // silhouette.
    const a = along * 0.55;
    const b = along * 0.84;

    const direction = new THREE.Vector3();
    if (axis === 'y') {
        direction.set(a, up, b);
    } else if (axis === 'x') {
        direction.set(up, a, b);
    } else {
        direction.set(a, b, up);
    }
    if (direction.lengthSq() === 0) {
        return;
    }
    direction.normalize();

    // frameAll fits the distance along whatever direction the camera is looking
    // from, so only the direction matters here.
    const distance = camera.position.length() || 1;
    camera.position.copy(direction).multiplyScalar(distance);
    camera.lookAt(0, 0, 0);
    if (cameraController && cameraController.controls) {
        cameraController.controls.target.set(0, 0, 0);
    }
}

function createGuides(planets) {
    const group = new THREE.Group();
    group.name = 'guides';

    const geometry = createCircleGeometry(180);
    const inner = (typeof DISK_INNER_RADIUS === 'number' && DISK_INNER_RADIUS > 0) ? DISK_INNER_RADIUS : 0.5;
    const outer = (typeof DISK_OUTER_RADIUS === 'number' && DISK_OUTER_RADIUS > inner) ? DISK_OUTER_RADIUS : 20;

    // Kept deliberately dim and monochrome: these are fixed scaffolding, while
    // orbit lines are per-body coloured, so the two layers stay tellable apart.
    const ringMaterial = new THREE.LineBasicMaterial({
        color: 0x3f6ea8, transparent: true, opacity: 0.22, depthWrite: false, fog: false
    });

    const radii = [0.5, 1, 2, 3, 5, 10, 20, 30, 50];
    for (let i = 0; i < radii.length; i++) {
        const radius = radii[i];
        if (radius < inner * 0.9 || radius > outer * 1.15) {
            continue;
        }
        const ring = new THREE.LineLoop(geometry, ringMaterial);
        ring.scale.setScalar(radius);
        ring.frustumCulled = false;
        ring.raycast = function () { };
        group.add(ring);
    }

    // The snow line is a result, not a setting: it moves with the star's
    // luminosity, so it gets its own ring and its own colour.
    snowLineRing = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({
        color: 0x8fd8ff, transparent: true, opacity: 0.75, depthWrite: false, fog: false
    }));
    snowLineRing.frustumCulled = false;
    snowLineRing.raycast = function () { };
    snowLineRing.visible = false;
    group.add(snowLineRing);

    // RingGeometry/LineLoop circles live in the XY plane; rotate the whole group
    // onto the plane the bodies actually occupy.
    const axis = detectDiskNormalAxis(planets);
    if (axis === 'y') {
        group.rotation.x = -Math.PI / 2;
    } else if (axis === 'x') {
        group.rotation.y = Math.PI / 2;
    }

    group.visible = guidesVisible;
    return group;
}

/** Keep the snow-line ring on the radius the simulation reports. */
function updateSnowLine(radius) {
    if (!snowLineRing) {
        return;
    }
    if (typeof radius !== 'number' || !isFinite(radius) || radius <= 0) {
        snowLineRing.visible = false;
        return;
    }
    snowLineRing.visible = true;
    if (radius !== lastSnowLineRadius) {
        snowLineRing.scale.setScalar(radius);
        lastSnowLineRadius = radius;
    }
}

function setGuidesVisible(visible) {
    guidesVisible = !!visible;
    if (guides) {
        guides.visible = guidesVisible;
    }
    if (ui) {
        ui.setGuidesVisible(guidesVisible);
    }
}

function toggleGuides() {
    setGuidesVisible(!guidesVisible);
    if (ui) {
        ui.notify(guidesVisible ? 'Guias do disco visíveis' : 'Guias do disco ocultas');
    }
}

// ---------------------------------------------------------------------------
// Orbit visualisation: breadcrumb trails and osculating ellipses
// ---------------------------------------------------------------------------
//
// Two different questions, two different drawings:
//
//   TRAILS   a polyline of recently sampled positions. Shows what a body
//            actually did, scattering and all. Sampled on a fixed window of
//            SIMULATED time, so the trail covers the same span of years - and
//            therefore looks the same - at 1x and at 4x.
//   ELLIPSES the instantaneous two-body orbit through the body's current state.
//            A body at 20 AU takes 89 years to close its trail but its ellipse
//            is complete the moment it is drawn, which is what makes the
//            architecture of the system and its resonances legible. Default.
//
// This lives entirely in the render layer: it samples planet.position and
// derives the elements from the state vector. Nothing is stored on a Planet -
// bodies stay pure physics.
//
// PACKING. Every trail shares ONE LineSegments and every ellipse shares another,
// so the whole feature is two draw calls no matter how many bodies are shown.
// Buffers are preallocated for ORBIT_MAX_SLOTS bodies and written in place; a
// round-robin cursor repacks at most ORBIT_SLOT_BUDGET slots per frame, so the
// per-frame cost is bounded and independent of how many orbits are on screen.

const ORBIT_MAX_SLOTS = 128;            // hard cap, including the "todos" scope
const ORBIT_SLOT_BUDGET = 24;           // slots repacked per frame

const ORBIT_ELLIPSE_SEGMENTS = 96;
const ORBIT_ELLIPSE_VERTICES = ORBIT_ELLIPSE_SEGMENTS * 2;

const TRAIL_SAMPLES = 96;
const TRAIL_SEGMENTS = TRAIL_SAMPLES - 1;
const TRAIL_VERTICES = TRAIL_SEGMENTS * 2;
// A fixed window of simulated years. Sampling is driven by simulated time, so
// the trail spans the same 4 years whatever the speed multiplier is doing; at
// high speed it simply carries fewer, coarser vertices over the same arc.
const TRAIL_WINDOW_YEARS = 4;
const TRAIL_SAMPLE_INTERVAL = TRAIL_WINDOW_YEARS / (TRAIL_SAMPLES - 1);

const ORBIT_ELLIPSE_ALPHA = 0.45;
const ORBIT_TRAIL_ALPHA = 0.85;
// How far out an orbit is still worth drawing. A body scattered onto a
// near-parabolic orbit would otherwise stretch the geometry to infinity.
const ORBIT_MAX_DRAW_RADIUS_FACTOR = 10;

const ORBIT_MODES = ['none', 'ellipses', 'trails', 'both'];
const ORBIT_SCOPES = ['selected', 'top12', 'top48', 'all'];
const ORBIT_SCOPE_COUNTS = { selected: 0, top12: 12, top48: 48, all: ORBIT_MAX_SLOTS };

let orbitMode = 'ellipses';
let orbitScope = 'top12';

let orbitGroup = null;
let ellipseMesh = null;
let trailMesh = null;
let ellipsePositions = null;
let ellipseColors = null;
let trailPositions = null;
let trailColors = null;

let orbitSlots = [];
const orbitSlotByPlanet = new Map();
let orbitActiveCount = 0;
let orbitHighWater = 0;
let orbitCursor = 0;
// slots released but not yet zeroed in the buffers
let orbitPendingBlank = 0;
let orbitTargetTimer = 0;
let orbitTargetsDirty = true;
let orbitMaxDrawRadius = 200;
let lastTrailSampleTime = -Infinity;

// Scratch, reused so the orbit code allocates nothing per frame.
const _orbitTargets = [];
const _orbitRanking = [];
const _orbitElements = {
    valid: false, p: 0, e: 0,
    px: 0, py: 0, pz: 0,
    qx: 0, qy: 0, qz: 0,
    nuLimit: 0
};

function makeOrbitSlot() {
    return {
        planet: null,
        active: false,
        blanked: true,          // a fresh buffer is already zeroed
        dirty: false,
        color: null,
        // ring buffer of sampled positions and their simulated times
        x: new Float64Array(TRAIL_SAMPLES),
        y: new Float64Array(TRAIL_SAMPLES),
        z: new Float64Array(TRAIL_SAMPLES),
        t: new Float64Array(TRAIL_SAMPLES),
        head: 0,
        count: 0
    };
}

/**
 * Classical elements from a state vector, in the PERIFOCAL BASIS rather than as
 * (i, Omega, omega) angles.
 *
 * Building the basis directly from the angular momentum and eccentricity
 * vectors sidesteps every classical singularity: a circular orbit has no
 * periapsis and an equatorial one has no ascending node, and both of those make
 * the angle formulation produce NaN. Here a near-circular orbit just picks an
 * arbitrary in-plane direction, which is correct because the resulting circle is
 * the same whatever direction is picked.
 *
 * The radius is r(nu) = p / (1 + e cos nu), measured FROM THE FOCUS, so the star
 * lands on a focus of the drawn conic and not on its centre. That is the classic
 * bug in this code and it looks plausible on screen, so it is checked
 * numerically rather than by eye.
 *
 * Writes into `_orbitElements` to avoid allocating; returns true on success.
 */
function computeOrbitElements(rx, ry, rz, vx, vy, vz, mu) {
    const out = _orbitElements;
    out.valid = false;

    if (!isFinite(rx) || !isFinite(ry) || !isFinite(rz) ||
        !isFinite(vx) || !isFinite(vy) || !isFinite(vz) || !(mu > 0)) {
        return false;
    }
    const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (!(r > 0) || !isFinite(r)) {
        return false;
    }
    const v2 = vx * vx + vy * vy + vz * vz;

    // specific angular momentum h = r x v; |h| = 0 is a radial fall with no plane
    const hx = ry * vz - rz * vy;
    const hy = rz * vx - rx * vz;
    const hz = rx * vy - ry * vx;
    const h2 = hx * hx + hy * hy + hz * hz;
    const h = Math.sqrt(h2);
    if (!(h > 1e-14) || !isFinite(h)) {
        return false;
    }

    const p = h2 / mu;                       // semi-latus rectum, valid for any conic
    if (!(p > 0) || !isFinite(p)) {
        return false;
    }

    // eccentricity vector e = ((v^2 - mu/r) r - (r.v) v) / mu
    const rv = rx * vx + ry * vy + rz * vz;
    const k = v2 - mu / r;
    const ex = (k * rx - rv * vx) / mu;
    const ey = (k * ry - rv * vy) / mu;
    const ez = (k * rz - rv * vz) / mu;
    let e = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (!isFinite(e)) {
        return false;
    }

    const wx = hx / h, wy = hy / h, wz = hz / h;

    let px, py, pz;
    if (e > 1e-8) {
        px = ex / e; py = ey / e; pz = ez / e;
    } else {
        // Near-circular: no periapsis. Any in-plane unit vector draws the same
        // circle, so take the axis least aligned with the orbit normal and
        // orthogonalise it. Also covers a near-zero inclination, which the
        // ascending-node formulation cannot express at all.
        e = 0;
        let ax = 0, ay = 0, az = 0;
        const aw = Math.abs(wx), bw = Math.abs(wy), cw = Math.abs(wz);
        if (aw <= bw && aw <= cw) {
            ax = 1;
        } else if (bw <= cw) {
            ay = 1;
        } else {
            az = 1;
        }
        const dot = ax * wx + ay * wy + az * wz;
        px = ax - dot * wx;
        py = ay - dot * wy;
        pz = az - dot * wz;
        const length = Math.sqrt(px * px + py * py + pz * pz);
        if (!(length > 1e-12)) {
            return false;
        }
        px /= length; py /= length; pz /= length;
    }

    // Q = W x P completes a right-handed perifocal frame; motion runs P -> Q.
    const qx = wy * pz - wz * py;
    const qy = wz * px - wx * pz;
    const qz = wx * py - wy * px;

    // How much of the conic to draw. Bound orbits normally close (nuLimit = PI);
    // an unbound or enormous one is cut back to the part inside the scene so it
    // reads as an escaping arc instead of stretching to infinity.
    let nuLimit = Math.PI;
    const maxRadius = orbitMaxDrawRadius;
    if (e > 1e-8) {
        // r(nu) <= maxRadius  <=>  cos nu >= (p/maxRadius - 1) / e
        const cutoff = (p / maxRadius - 1) / e;
        if (cutoff >= 1) {
            return false;                    // even periapsis is off the scene
        }
        if (cutoff > -1) {
            nuLimit = Math.acos(cutoff);
        }
    } else if (p > maxRadius) {
        return false;
    }
    if (e >= 1) {
        // stop short of the asymptote, where r diverges
        const asymptote = Math.acos(-1 / e) * 0.98;
        if (asymptote < nuLimit) {
            nuLimit = asymptote;
        }
    }
    if (!(nuLimit > 1e-4) || !isFinite(nuLimit)) {
        return false;
    }

    out.p = p;
    out.e = e;
    out.px = px; out.py = py; out.pz = pz;
    out.qx = qx; out.qy = qy; out.qz = qz;
    out.nuLimit = nuLimit;
    out.valid = true;
    return true;
}

function createOrbitLayer() {
    orbitGroup = new THREE.Group();
    orbitGroup.name = 'orbits';

    // itemSize 4 on the colour attribute is what makes three.js define
    // USE_COLOR_ALPHA, which is how a per-vertex alpha (the trail fade) reaches
    // the shader. linewidth is ignored by WebGL on essentially every platform,
    // so emphasis is carried by colour and opacity only.
    const material = () => new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        fog: false
    });

    ellipsePositions = new Float32Array(ORBIT_MAX_SLOTS * ORBIT_ELLIPSE_VERTICES * 3);
    ellipseColors = new Float32Array(ORBIT_MAX_SLOTS * ORBIT_ELLIPSE_VERTICES * 4);
    const ellipseGeometry = new THREE.BufferGeometry();
    ellipseGeometry.setAttribute('position', new THREE.BufferAttribute(ellipsePositions, 3).setUsage(THREE.DynamicDrawUsage));
    ellipseGeometry.setAttribute('color', new THREE.BufferAttribute(ellipseColors, 4).setUsage(THREE.DynamicDrawUsage));
    ellipseGeometry.setDrawRange(0, 0);
    ellipseMesh = new THREE.LineSegments(ellipseGeometry, material());
    ellipseMesh.frustumCulled = false;
    ellipseMesh.raycast = function () { };
    ellipseMesh.name = 'orbitEllipses';
    orbitGroup.add(ellipseMesh);

    trailPositions = new Float32Array(ORBIT_MAX_SLOTS * TRAIL_VERTICES * 3);
    trailColors = new Float32Array(ORBIT_MAX_SLOTS * TRAIL_VERTICES * 4);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3).setUsage(THREE.DynamicDrawUsage));
    trailGeometry.setAttribute('color', new THREE.BufferAttribute(trailColors, 4).setUsage(THREE.DynamicDrawUsage));
    trailGeometry.setDrawRange(0, 0);
    trailMesh = new THREE.LineSegments(trailGeometry, material());
    trailMesh.frustumCulled = false;
    trailMesh.raycast = function () { };
    trailMesh.name = 'orbitTrails';
    orbitGroup.add(trailMesh);

    orbitSlots = new Array(ORBIT_MAX_SLOTS);
    for (let i = 0; i < ORBIT_MAX_SLOTS; i++) {
        orbitSlots[i] = makeOrbitSlot();
    }

    const diskRadius = (typeof DISK_OUTER_RADIUS === 'number' && DISK_OUTER_RADIUS > 0)
        ? DISK_OUTER_RADIUS : 20;
    orbitMaxDrawRadius = diskRadius * ORBIT_MAX_DRAW_RADIUS_FACTOR;

    applyOrbitVisibility();
    return orbitGroup;
}

function applyOrbitVisibility() {
    if (!orbitGroup) {
        return;
    }
    const on = orbitMode !== 'none';
    orbitGroup.visible = on;
    ellipseMesh.visible = on && (orbitMode === 'ellipses' || orbitMode === 'both');
    trailMesh.visible = on && (orbitMode === 'trails' || orbitMode === 'both');
}

/** Release a slot: drop the body reference and blank its span of the buffers. */
function releaseOrbitSlot(index) {
    const slot = orbitSlots[index];
    if (!slot.active) {
        return;
    }
    slot.planet = null;
    slot.active = false;
    slot.count = 0;
    slot.head = 0;
    slot.blanked = false;      // forces one blanking pass before it goes quiet
    slot.dirty = true;
    orbitPendingBlank++;
    orbitActiveCount--;
}

function compareByMassDescending(a, b) {
    return (b.mass || 0) - (a.mass || 0);
}

/** Add a body to the target list, skipping dead bodies and duplicates. */
function pushOrbitTarget(planet) {
    if (!planet || planet.removed || !planet.position) {
        return;
    }
    if (_orbitTargets.length >= ORBIT_MAX_SLOTS) {
        return;
    }
    if (_orbitTargets.indexOf(planet) === -1) {
        _orbitTargets.push(planet);
    }
}

/**
 * Choose which bodies get an orbit drawn. Never all 800: the selected and
 * followed bodies always, then the most massive up to the scope's limit, capped
 * at ORBIT_MAX_SLOTS. A body keeps its slot across updates so its trail history
 * survives; bodies that fall out of the set (or get accreted) are released.
 */
function updateOrbitTargets() {
    orbitTargetsDirty = false;
    if (!orbitGroup) {
        return;
    }

    const targets = _orbitTargets;
    targets.length = 0;

    if (orbitMode !== 'none') {
        const wanted = ORBIT_SCOPE_COUNTS[orbitScope] || 0;
        const planets = (simulation && Array.isArray(simulation.planets)) ? simulation.planets : [];

        // the bodies the user is actually looking at always get an orbit
        pushOrbitTarget(cameraController ? cameraController.getSelected() : null);
        pushOrbitTarget(cameraController ? cameraController.getFollowed() : null);

        if (wanted > 0) {
            const ranking = _orbitRanking;
            ranking.length = 0;
            const star = currentStar();
            for (let i = 0; i < planets.length; i++) {
                const planet = planets[i];
                if (!planet || planet.removed || !planet.position) {
                    continue;
                }
                // the star's own "orbit" is meaningless: it is the focus
                if (planet === star) {
                    continue;
                }
                ranking.push(planet);
            }
            ranking.sort(compareByMassDescending);
            const limit = Math.min(wanted, ranking.length);
            for (let i = 0; i < limit && targets.length < ORBIT_MAX_SLOTS; i++) {
                pushOrbitTarget(ranking[i]);
            }
            ranking.length = 0;
        }
    }

    // release slots whose body is gone or no longer wanted
    for (let i = 0; i < ORBIT_MAX_SLOTS; i++) {
        const slot = orbitSlots[i];
        if (!slot.active) {
            continue;
        }
        if (!slot.planet || slot.planet.removed || targets.indexOf(slot.planet) === -1) {
            orbitSlotByPlanet.delete(slot.planet);
            releaseOrbitSlot(i);
        }
    }

    // Assign slots to newcomers, always taking the LOWEST free index. A
    // free-list stack would hand released indices back highest-first, live
    // slots would drift to the top of the buffer and setDrawRange below could
    // never trim the unused tail. The scan cursor only moves forward, so the
    // whole assignment pass is O(ORBIT_MAX_SLOTS), not O(n * slots).
    let scan = 0;
    for (let i = 0; i < targets.length; i++) {
        const planet = targets[i];
        if (orbitSlotByPlanet.has(planet)) {
            continue;
        }
        while (scan < ORBIT_MAX_SLOTS && orbitSlots[scan].active) {
            scan++;
        }
        if (scan >= ORBIT_MAX_SLOTS) {
            break;
        }
        const index = scan;
        const slot = orbitSlots[index];
        slot.planet = planet;
        slot.active = true;
        slot.blanked = false;
        slot.dirty = true;
        slot.count = 0;
        slot.head = 0;
        orbitSlotByPlanet.set(planet, index);
        orbitActiveCount++;
    }

    // Slots are handed out low-first, so drawing up to the highest live index
    // keeps the GPU off the unused tail without any compaction.
    //
    // orbitPendingBlank is recomputed here rather than only incremented and
    // decremented: reclaiming a slot that had not been zeroed yet would
    // otherwise leak the count upward, and a stuck non-zero count keeps the
    // 'none' mode repacking every frame forever. Deriving it from the slots
    // makes drift impossible.
    let high = 0;
    let pending = 0;
    for (let i = 0; i < ORBIT_MAX_SLOTS; i++) {
        const slot = orbitSlots[i];
        if (slot.active || !slot.blanked) {
            high = i + 1;
        }
        if (!slot.active && !slot.blanked) {
            pending++;
        }
    }
    orbitPendingBlank = pending;
    orbitHighWater = high;
    ellipseMesh.geometry.setDrawRange(0, high * ORBIT_ELLIPSE_VERTICES);
    trailMesh.geometry.setDrawRange(0, high * TRAIL_VERTICES);
    targets.length = 0;
}

/** Push one position per tracked body into its ring buffer. */
function sampleOrbitTrails(now) {
    for (let i = 0; i < ORBIT_MAX_SLOTS; i++) {
        const slot = orbitSlots[i];
        if (!slot.active || !slot.planet || slot.planet.removed) {
            continue;
        }
        const p = slot.planet.position;
        if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) {
            continue;
        }
        const head = slot.head;
        slot.x[head] = p.x;
        slot.y[head] = p.y;
        slot.z[head] = p.z;
        slot.t[head] = now;
        slot.head = (head + 1) % TRAIL_SAMPLES;
        if (slot.count < TRAIL_SAMPLES) {
            slot.count++;
        }
        slot.dirty = true;
    }
}

let _orbitTouchedLow = Infinity;
let _orbitTouchedHigh = -1;

function touchOrbitSlot(index) {
    if (index < _orbitTouchedLow) {
        _orbitTouchedLow = index;
    }
    if (index > _orbitTouchedHigh) {
        _orbitTouchedHigh = index;
    }
}

/** Zero the alpha across a slot's whole span so it draws nothing. */
function blankOrbitSlot(index) {
    let base = index * ORBIT_ELLIPSE_VERTICES * 4;
    for (let i = 0; i < ORBIT_ELLIPSE_VERTICES; i++) {
        ellipseColors[base + i * 4 + 3] = 0;
    }
    base = index * TRAIL_VERTICES * 4;
    for (let i = 0; i < TRAIL_VERTICES; i++) {
        trailColors[base + i * 4 + 3] = 0;
    }
}

/** Write one body's ellipse into the shared buffer. */
function packEllipse(index, planet, star, color) {
    const positionBase = index * ORBIT_ELLIPSE_VERTICES * 3;
    const colorBase = index * ORBIT_ELLIPSE_VERTICES * 4;

    let ok = false;
    let sx = 0, sy = 0, sz = 0;
    if (star && star.position && planet.position && planet.velocity) {
        sx = star.position.x; sy = star.position.y; sz = star.position.z;
        const sv = star.velocity || { x: 0, y: 0, z: 0 };
        const mu = GRAVITATION_CONSTANT *
            ((typeof star.mass === 'number' ? star.mass : 0) +
             (typeof planet.mass === 'number' ? planet.mass : 0));
        ok = computeOrbitElements(
            planet.position.x - sx, planet.position.y - sy, planet.position.z - sz,
            planet.velocity.x - (sv.x || 0), planet.velocity.y - (sv.y || 0), planet.velocity.z - (sv.z || 0),
            mu
        );
    }

    if (!ok) {
        for (let i = 0; i < ORBIT_ELLIPSE_VERTICES; i++) {
            ellipseColors[colorBase + i * 4 + 3] = 0;
        }
        return;
    }

    const el = _orbitElements;
    const step = (2 * el.nuLimit) / ORBIT_ELLIPSE_SEGMENTS;
    const start = -el.nuLimit;

    // point j, then emit segments (j, j+1): one shared vertex written twice, which
    // is what LineSegments wants and what keeps this to a single draw call.
    let previousX = 0, previousY = 0, previousZ = 0;
    for (let j = 0; j <= ORBIT_ELLIPSE_SEGMENTS; j++) {
        const nu = start + step * j;
        const cos = Math.cos(nu);
        const sin = Math.sin(nu);
        const denominator = 1 + el.e * cos;
        // guarded by nuLimit, but a rounding error near the asymptote is fatal
        const radius = denominator > 1e-9 ? el.p / denominator : orbitMaxDrawRadius;
        const x = sx + radius * (cos * el.px + sin * el.qx);
        const y = sy + radius * (cos * el.py + sin * el.qy);
        const z = sz + radius * (cos * el.pz + sin * el.qz);

        if (j > 0) {
            const v = (j - 1) * 2;
            let o = positionBase + v * 3;
            ellipsePositions[o] = previousX;
            ellipsePositions[o + 1] = previousY;
            ellipsePositions[o + 2] = previousZ;
            ellipsePositions[o + 3] = x;
            ellipsePositions[o + 4] = y;
            ellipsePositions[o + 5] = z;

            o = colorBase + v * 4;
            ellipseColors[o] = color.r;
            ellipseColors[o + 1] = color.g;
            ellipseColors[o + 2] = color.b;
            ellipseColors[o + 3] = ORBIT_ELLIPSE_ALPHA;
            ellipseColors[o + 4] = color.r;
            ellipseColors[o + 5] = color.g;
            ellipseColors[o + 6] = color.b;
            ellipseColors[o + 7] = ORBIT_ELLIPSE_ALPHA;
        }
        previousX = x; previousY = y; previousZ = z;
    }
}

/** Write one body's breadcrumb trail into the shared buffer. */
function packTrail(index, slot, now) {
    const positionBase = index * TRAIL_VERTICES * 3;
    const colorBase = index * TRAIL_VERTICES * 4;
    const color = slot.color;
    const oldest = now - TRAIL_WINDOW_YEARS;

    let written = 0;
    if (slot.count >= 2) {
        // walk the ring from oldest to newest, dropping anything past the window
        let read = (slot.head - slot.count + TRAIL_SAMPLES * 2) % TRAIL_SAMPLES;
        let havePrevious = false;
        let previousX = 0, previousY = 0, previousZ = 0, previousAge = 0;

        for (let i = 0; i < slot.count && written < TRAIL_SEGMENTS; i++) {
            const t = slot.t[read];
            const x = slot.x[read];
            const y = slot.y[read];
            const z = slot.z[read];
            read = (read + 1) % TRAIL_SAMPLES;

            if (!(t >= oldest) || !isFinite(x) || !isFinite(y) || !isFinite(z)) {
                havePrevious = false;
                continue;
            }
            // fade by AGE, not by index, so the gradient is stable when the
            // sample spacing changes with the speed multiplier
            let age = (now - t) / TRAIL_WINDOW_YEARS;
            if (!(age >= 0)) { age = 0; } else if (age > 1) { age = 1; }
            const alpha = ORBIT_TRAIL_ALPHA * (1 - age) * (1 - age);

            if (havePrevious) {
                const v = written * 2;
                let o = positionBase + v * 3;
                trailPositions[o] = previousX;
                trailPositions[o + 1] = previousY;
                trailPositions[o + 2] = previousZ;
                trailPositions[o + 3] = x;
                trailPositions[o + 4] = y;
                trailPositions[o + 5] = z;

                o = colorBase + v * 4;
                trailColors[o] = color.r;
                trailColors[o + 1] = color.g;
                trailColors[o + 2] = color.b;
                trailColors[o + 3] = previousAge;
                trailColors[o + 4] = color.r;
                trailColors[o + 5] = color.g;
                trailColors[o + 6] = color.b;
                trailColors[o + 7] = alpha;
                written++;
            }
            previousX = x; previousY = y; previousZ = z;
            previousAge = alpha;
            havePrevious = true;
        }
    }

    for (let i = written; i < TRAIL_SEGMENTS; i++) {
        const o = colorBase + i * 2 * 4;
        trailColors[o + 3] = 0;
        trailColors[o + 7] = 0;
    }
}

/**
 * Repack a bounded number of slots per frame. Osculating elements and trail
 * tails both drift continuously, so every live slot is effectively always
 * dirty; visiting them round-robin keeps the per-frame cost flat whether 12 or
 * 128 orbits are on screen, at the price of a slot's drawing being at most
 * (slots / budget) frames stale, which at 128 slots is about 5 frames.
 */
function repackOrbitSlots(now) {
    const star = currentStar();
    const wantEllipses = ellipseMesh.visible;
    const wantTrails = trailMesh.visible;
    let budget = ORBIT_SLOT_BUDGET;

    for (let visited = 0; visited < ORBIT_MAX_SLOTS && budget > 0; visited++) {
        const index = orbitCursor;
        orbitCursor = (orbitCursor + 1) % ORBIT_MAX_SLOTS;
        const slot = orbitSlots[index];

        if (!slot.active) {
            // one blanking pass after release, then it costs nothing again
            if (!slot.blanked) {
                blankOrbitSlot(index);
                slot.blanked = true;
                slot.dirty = false;
                if (orbitPendingBlank > 0) {
                    orbitPendingBlank--;
                }
                touchOrbitSlot(index);
                budget--;
            }
            continue;
        }

        const planet = slot.planet;
        if (!planet || planet.removed) {
            orbitSlotByPlanet.delete(planet);
            releaseOrbitSlot(index);
            orbitTargetsDirty = true;
            continue;
        }

        slot.color = cachedColor(colorOf(planet));
        if (wantEllipses) {
            packEllipse(index, planet, star, slot.color);
        }
        if (wantTrails) {
            packTrail(index, slot, now);
        }
        slot.blanked = false;
        slot.dirty = false;
        touchOrbitSlot(index);
        budget--;
    }
}

/**
 * Upload only the slots touched this frame. three.js resets updateRange.count
 * to -1 after each upload, so it is set fresh every time; a wrapped (therefore
 * non-contiguous) window just falls back to a full upload.
 */
function flushOrbitBuffers() {
    if (_orbitTouchedHigh < 0) {
        return;
    }
    const low = _orbitTouchedLow;
    const high = _orbitTouchedHigh;
    const slots = high - low + 1;

    const setRange = (attribute, perSlot, itemSize) => {
        attribute.updateRange.offset = low * perSlot * itemSize;
        attribute.updateRange.count = slots * perSlot * itemSize;
        attribute.needsUpdate = true;
    };

    const ellipseGeometry = ellipseMesh.geometry;
    setRange(ellipseGeometry.attributes.position, ORBIT_ELLIPSE_VERTICES, 3);
    setRange(ellipseGeometry.attributes.color, ORBIT_ELLIPSE_VERTICES, 4);

    const trailGeometry = trailMesh.geometry;
    setRange(trailGeometry.attributes.position, TRAIL_VERTICES, 3);
    setRange(trailGeometry.attributes.color, TRAIL_VERTICES, 4);

    _orbitTouchedLow = Infinity;
    _orbitTouchedHigh = -1;
}

/** Called once per frame from the render loop. */
function updateOrbits(frameTime, now) {
    if (!orbitGroup) {
        return;
    }

    orbitTargetTimer += frameTime;
    if (orbitTargetsDirty || orbitTargetTimer >= 0.25) {
        orbitTargetTimer = 0;
        updateOrbitTargets();
    }

    if (orbitMode === 'none') {
        // Finish zeroing whatever was still drawn, then go completely quiet.
        // Without this the last orbits would linger for a few frames after the
        // group is shown again.
        if (orbitPendingBlank > 0) {
            repackOrbitSlots(0);
            flushOrbitBuffers();
        }
        return;
    }

    // Sampling is driven by SIMULATED time, never by frames, so the trail spans
    // the same number of years at every speed multiplier. Paused time does not
    // advance, so a paused trail does not decay either.
    if (isFinite(now)) {
        if (!(lastTrailSampleTime <= now)) {
            lastTrailSampleTime = -Infinity;      // time jumped backwards: resync
        }
        if (now - lastTrailSampleTime >= TRAIL_SAMPLE_INTERVAL) {
            sampleOrbitTrails(now);
            lastTrailSampleTime = now;
        }
    }

    repackOrbitSlots(isFinite(now) ? now : 0);
    flushOrbitBuffers();
}

function setOrbitMode(mode) {
    if (ORBIT_MODES.indexOf(mode) === -1) {
        return;
    }
    orbitMode = mode;
    orbitTargetsDirty = true;
    applyOrbitVisibility();
    if (ui) {
        ui.setOrbitMode(orbitMode);
    }
}

function setOrbitScope(scope) {
    if (ORBIT_SCOPES.indexOf(scope) === -1) {
        return;
    }
    orbitScope = scope;
    orbitTargetsDirty = true;
    if (ui) {
        ui.setOrbitScope(orbitScope);
    }
}

const ORBIT_MODE_LABELS = {
    none: 'Órbitas ocultas',
    ellipses: 'Órbitas: elipses',
    trails: 'Órbitas: rastros',
    both: 'Órbitas: elipses e rastros'
};

function cycleOrbitMode() {
    const next = (ORBIT_MODES.indexOf(orbitMode) + 1) % ORBIT_MODES.length;
    setOrbitMode(ORBIT_MODES[next]);
    if (ui) {
        ui.notify(ORBIT_MODE_LABELS[orbitMode] || 'Órbitas');
    }
}

// ---------------------------------------------------------------------------
// Instanced bodies
// ---------------------------------------------------------------------------

/**
 * Build the single InstancedMesh that draws every disk body.
 *
 * The geometry has radius 1, so an instance's world radius is entirely carried
 * by its matrix scale.
 *
 * Lambert rather than Basic: the whole point of the scene is that there is a
 * star at the middle, and unlit spheres hide that completely. instanceColor is
 * honoured by the Lambert shader (color_vertex handles USE_INSTANCING_COLOR),
 * so the per-instance composition colours still come through.
 */
function createBodyMesh(capacity) {
    const geometry = new THREE.DodecahedronGeometry(1, RENDER_DETAILS);
    const material = new THREE.MeshLambertMaterial({ fog: false });
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Bodies move far apart and the camera flies among them; a stale bounding
    // volume would cull instances that are actually on screen.
    mesh.frustumCulled = false;
    mesh.name = 'bodies';
    // Picking convention required by CameraController: instanceId -> planet.id
    mesh.userData.planetIds = planetIds;
    return mesh;
}

/** Push the current physics state into the instance buffers. */
function syncInstances() {
    const planets = (simulation && Array.isArray(simulation.planets)) ? simulation.planets : [];
    const capacity = bodyMesh.instanceMatrix.count;
    const star = currentStar();
    let written = 0;

    for (let i = 0; i < planets.length && written < capacity; i++) {
        const planet = planets[i];
        if (!planet || planet.removed || !planet.position) {
            continue;
        }
        // the star has its own mesh; drawing it twice would double its brightness
        if (planet === star) {
            continue;
        }
        _position.set(planet.position.x, planet.position.y, planet.position.z);
        _scale.setScalar(displayRadiusOf(planet));
        _matrix.compose(_position, _quaternion, _scale);
        bodyMesh.setMatrixAt(written, _matrix);
        bodyMesh.setColorAt(written, cachedColor(colorOf(planet)));
        planetIds[written] = planet.id;
        written++;
    }

    planetIds.length = written;
    bodyMesh.count = written;
    bodyMesh.instanceMatrix.needsUpdate = true;
    if (bodyMesh.instanceColor) {
        bodyMesh.instanceColor.needsUpdate = true;
    }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

function onWindowResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    if (cameraController) {
        cameraController.handleResize();
    }
}

/** Extra shortcuts owned by main.js, appended to the controller's own table. */
const EXTRA_KEY_BINDINGS = [
    { group: 'Simulação', keys: 'O', description: 'Mostrar ou ocultar as guias do disco' },
    { group: 'Simulação', keys: 'T', description: 'Alternar órbitas: nenhuma / elipses / rastros / ambos' }
];

function onExtraKeyDown(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
        return;
    }
    if (CameraController.isTypingTarget(event.target)) {
        return;
    }
    // CameraController keys off event.code, so match it for consistency, but
    // accept event.key too for layouts where the two disagree.
    if (event.code === 'KeyO' || (event.key || '').toLowerCase() === 'o') {
        event.preventDefault();
        toggleGuides();
        return;
    }
    if (event.code === 'KeyT' || (event.key || '').toLowerCase() === 't') {
        event.preventDefault();
        cycleOrbitMode();
    }
}

/** Orbital elements of a body, or null. Never throws at the call site. */
function orbitOf(planet) {
    if (!planet || !simulation) {
        return null;
    }
    if (typeof simulation.orbitalElements === 'function') {
        try {
            const elements = simulation.orbitalElements(planet);
            if (elements) {
                return elements;
            }
        } catch (e) { /* fall through */ }
    }
    // The physics layer may cache them on the body instead.
    if (typeof planet.semiMajorAxis === 'number') {
        return { semiMajorAxis: planet.semiMajorAxis, eccentricity: planet.eccentricity };
    }
    return null;
}

/** Simulated time in YEARS, whatever the physics layer chooses to call it. */
function simulatedTime() {
    if (simulation) {
        if (typeof simulation.simulatedTime === 'number' && isFinite(simulation.simulatedTime)) {
            return simulation.simulatedTime;
        }
        if (typeof simulation.time === 'number' && isFinite(simulation.time)) {
            return simulation.time;
        }
    }
    return simulatedYears;
}

function start() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    PERIODIC_TABLE_ELEMENTS = (new PeriodicTable()).atoms;
    resolveRenderRadiusMapping();

    const diskRadius = (typeof DISK_OUTER_RADIUS === 'number' && DISK_OUTER_RADIUS > 0)
        ? DISK_OUTER_RADIUS : 20;

    // A logarithmic depth buffer is what makes a near plane of 1e-3 AU coexist
    // with a far plane of 1e4 AU: without it, standing next to a 0.02 AU embryo
    // and still seeing the outer disk is not possible in one pass.
    camera = new THREE.PerspectiveCamera(70, width / height, 0.001, diskRadius * 500);

    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND_COLOR);

    // Night sides must not be pure black or half of every body disappears.
    scene.add(new THREE.AmbientLight(0x8fa8cc, 0.5));

    simulation = new Simulation();

    // Headroom above PLANETS_NUMBER: fragmenting impacts can briefly raise the
    // body count above the initial one, and an InstancedMesh cannot grow.
    const capacity = Math.max(16, (typeof PLANETS_NUMBER === 'number' ? PLANETS_NUMBER : 800) + 64);
    bodyMesh = createBodyMesh(capacity);
    scene.add(bodyMesh);

    scene.add(createStar());
    guides = createGuides(simulation.planets);
    scene.add(guides);
    scene.add(createOrbitLayer());

    pickables = [bodyMesh, starCore];

    syncInstances();
    syncStar();

    document.body.appendChild(renderer.domElement);

    cameraController = new CameraController(camera, renderer.domElement, {
        getBodies: () => simulation.planets,
        getPickables: () => pickables,
        scene: scene,
        onSelect: (planet) => {
            orbitTargetsDirty = true;
            if (ui) { ui.setSelected(planet); }
        },
        onModeChange: (mode) => { if (ui) ui.setMode(mode); },
        onFollowChange: (planet) => {
            orbitTargetsDirty = true;
            if (ui) { ui.setFollowing(planet); }
        },
        onTogglePause: () => { if (ui) ui.togglePause(); },
        onToggleHelp: () => { if (ui) ui.toggleHelp(); },
        onNotice: (message) => { if (ui) ui.notify(message); }
    });
    // OrbitControls is created and owned by the controller.
    controls = cameraController.controls;

    // CameraController frames bodies by planet.radius, which is the PHYSICAL
    // radius - a few millionths of an AU. Every flight started from here passes
    // the display radius explicitly so the camera stops at a distance where the
    // body actually fills the frame.
    const flyToBody = (planet, fill) => {
        if (!planet) {
            return;
        }
        cameraController.flyTo(planet, { radius: displayRadiusOf(planet), fill: fill });
    };

    ui = new NavigatorUI({
        getBodies: () => simulation.planets,
        getStats: () => simulation.stats,
        getCamera: () => camera,
        getOrbit: orbitOf,
        getTime: simulatedTime,
        getRate: () => yearsPerSecond,
        getKeyBindings: () => cameraController.getKeyBindings().concat(EXTRA_KEY_BINDINGS),
        onSelect: (planet) => {
            cameraController.select(planet);
            flyToBody(planet, 0.35);
        },
        onFollow: (planet) => cameraController.follow(planet),
        onFrame: (planet) => flyToBody(planet, 0.4),
        onRelease: () => cameraController.stopFollowing(),
        onFrameAll: () => cameraController.frameAll(),
        onModeChange: (mode) => cameraController.setMode(mode),
        onPause: (isPaused) => { paused = isPaused; },
        onSpeedChange: (multiplier) => { speedMultiplier = multiplier; },
        onToggleGuides: () => toggleGuides(),
        onOrbitModeChange: (mode) => setOrbitMode(mode),
        onOrbitScopeChange: (scope) => setOrbitScope(scope)
    });
    ui.setGuidesVisible(guidesVisible);
    ui.setOrbitMode(orbitMode);
    ui.setOrbitScope(orbitScope);

    if (typeof simulation.onPlanetRemoved === 'function') {
        simulation.onPlanetRemoved((planet) => {
            const watched = cameraController.getFollowed() || cameraController.getSelected();
            if (watched !== planet) {
                return;
            }
            const label = (planet && typeof planet.classLabel === 'string' && planet.classLabel)
                ? planet.classLabel
                : 'Corpo';
            const id = (planet && planet.id !== undefined) ? ' #' + planet.id : '';
            ui.notify(label + id + ' acretado por outro corpo');
        });
    }

    window.addEventListener('resize', onWindowResize, false);
    window.addEventListener('keydown', onExtraKeyDown, false);
    Object.assign(window, { scene, simulation, camera, cameraController, ui });

    // Frame the whole disk rather than sitting at the origin inside the star,
    // and look at it from above the plane first - see orientCameraToDisk.
    orientCameraToDisk(simulation.planets);
    cameraController.frameAll({ duration: 0 });

    let lastTime = performance.now();
    let accumulator = 0;

    function animate(now) {
        requestAnimationFrame(animate);

        let frameTime = (now - lastTime) / 1000;
        lastTime = now;
        if (frameTime > MAX_FRAME_TIME) {
            frameTime = MAX_FRAME_TIME;
        }

        let steppedYears = 0;

        if (!paused) {
            // FIXED_DT is in YEARS, frameTime is in seconds: at 1x, one real
            // second advances the disk by one year.
            accumulator += frameTime * speedMultiplier;

            // MAX_STEPS_PER_FRAME is budgeted for 1x. Scaling it with the
            // multiplier is what makes the 2x and 4x buttons actually do
            // something instead of silently discarding the backlog.
            const maxSteps = Math.min(48, Math.max(1,
                Math.ceil(MAX_STEPS_PER_FRAME * Math.max(1, speedMultiplier))));

            let steps = 0;
            while (accumulator >= FIXED_DT && steps < maxSteps) {
                simulation.step(FIXED_DT);
                accumulator -= FIXED_DT;
                steppedYears += FIXED_DT;
                steps++;
            }
            // Could not keep up: drop the backlog rather than accumulate a debt
            // we will never repay.
            if (steps === maxSteps) {
                accumulator = 0;
            }
        }

        simulatedYears += steppedYears;
        yearsWindow += steppedYears;
        clockWindow += frameTime;
        if (clockWindow >= 0.5) {
            yearsPerSecond = yearsWindow / clockWindow;
            yearsWindow = 0;
            clockWindow = 0;
        }

        syncInstances();
        syncStar();
        updateOrbits(frameTime, simulatedTime());
        cameraController.update(frameTime);
        ui.update(frameTime);
        updateSnowLine(ui.snowLineRadius());
        renderer.render(scene, camera);
    }

    requestAnimationFrame(animate);
}

window.onload = start;
