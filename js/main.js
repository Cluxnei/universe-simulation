/**
 * Render layer and application wiring.
 *
 * The physics core (Planet / Simulation / Octree) knows nothing about Three.js.
 * Everything visual lives here.
 *
 * WHAT IS ON SCREEN
 *   - every body as one instance of a single InstancedMesh (one draw call)
 *   - every STAR as its own small mesh, so it can carry a blackbody colour and
 *     an additive halo; the brightest few also carry a point light
 *   - optional guides: concentric rings in the disk plane plus the snow line
 *
 * LIFECYCLE
 *   The stage (renderer, scene, camera, ambient light) is built ONCE and lives
 *   for the whole page: a WebGL context is expensive and browsers only allow a
 *   handful of them. Everything that belongs to a single run - the bodies, the
 *   stars, the guides, the orbit layer, the simulation, the UI and the camera
 *   controller - is built by buildRun() and released by teardownRun(), so the
 *   user can pick a different scenario without reloading the page.
 *
 *   Every allocation in buildRun() has a matching release in teardownRun();
 *   that pairing is the whole reason restarts do not leak.
 *
 * UNITS: solar masses, astronomical units, years. `simulatedTime` is in YEARS.
 */

let camera, controls, scene, renderer, simulation, cameraController, ui;
let PERIODIC_TABLE_ELEMENTS;

// Everything a single run owns hangs off this group, so teardown is one
// remove() plus an explicit dispose of the resources we allocated.
let world = null;

let bodyMesh = null;
let textureLibrary = null;   // procedural body textures
let detailBodies = null;    // LOD pool of textured spheres
let bodyGeometry = null;
let bodyMaterial = null;
let planetIds = [];
let pickables = [];

// Star visuals. Stars are drawn outside the InstancedMesh because they emit
// light: they need their own material, their own halo and (for the brightest
// few) a point light. A cluster can hold tens of them, so the visuals are
// POOLED - the meshes are created once and reused, never rebuilt per frame.
let starLayer = null;
let starGeometry = null;            // shared by every star core
let starGlowTexture = null;         // shared by every halo sprite
let starVisuals = [];               // pool of visuals, index-aligned with starList
let starVisualCount = 0;            // how many of them are in use this frame
const starSet = new Set();          // bodies that own a visual, skipped by the InstancedMesh

// Disk guides (rings + snow line), toggled with `O`.
let guides = null;
let guidesVisible = true;
let guideGeometry = null;
let guideMaterials = [];
let snowLineRing = null;
let lastSnowLineRadius = -1;

// Reused every frame so the render loop allocates nothing.
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
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

// --- the active scenario -------------------------------------------------
let activeScenarioId = null;
let activeParams = null;
let activeMeta = null;
let activeLabel = '';
let activeDt = 0.0035;
let sceneRadius = 20;               // AU, the size of the thing being simulated
let running = false;                // a run is built and stepping
let frameCounter = 0;
let renderFaults = 0;

// Scenario picker (built lazily, kept alive between runs so the parameters the
// user typed survive a "Trocar cenário").
let picker = null;

// Handlers registered on the simulation, kept so they can be dropped again.
let onRemovedHandler = null;
let onSpawnedHandler = null;

// ---------------------------------------------------------------------------
// Defensive reads of constants.js
// ---------------------------------------------------------------------------

function numberOr(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback;
}

function positiveOr(value, fallback) {
    return (typeof value === 'number' && isFinite(value) && value > 0) ? value : fallback;
}

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

    const solarRadius = positiveOr(typeof SOLAR_RADIUS !== 'undefined' ? SOLAR_RADIUS : 0, 4.65e-3);

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
// Stars
// ---------------------------------------------------------------------------
//
// simulation.stars is the contract: an array of the luminous bodies, because a
// scenario may be a binary, a trinary or a whole cluster. simulation.star (the
// dominant one) is kept as a fallback, and when neither exists the bodies are
// scanned - rarely, because that scan is O(n) and runs from the render loop.

const WHITE = new THREE.Color(0xffffff);

// Hard caps. Halo sprites are cheap (one quad each) but point lights are not:
// every extra light is a per-fragment cost in the Lambert shader AND a shader
// recompile when the count changes, so only the few brightest stars get one.
const STAR_VISUAL_LIMIT = 64;
const STAR_LIGHT_LIMIT = 4;
// Blackbody colour moves on the fusion timescale, so recomputing it for every
// star on every frame is pure waste. Refresh a star's colour this often.
const STAR_COLOR_INTERVAL = 12;     // frames

let starList = [];                  // reused every frame, never reallocated
let starScanCache = [];
let starProbeCountdown = 0;

/** Is this body one the renderer should treat as a star? */
function looksLikeStar(planet) {
    if (!planet || planet.removed) {
        return false;
    }
    // isLuminous is deliberately NOT part of this test: structure.js gives even
    // a gas giant a residual contraction luminosity, so it would match half the
    // disk. Only a real star gets the star treatment.
    const threshold = positiveOr(typeof HYDROGEN_BURNING_MASS !== 'undefined' ? HYDROGEN_BURNING_MASS : 0, 0.08);
    return planet.isCentralStar === true ||
        planet.classification === 'star' ||
        (typeof planet.mass === 'number' && planet.mass >= threshold);
}

function compareByMassDescending(a, b) {
    return (b && typeof b.mass === 'number' ? b.mass : 0) -
        (a && typeof a.mass === 'number' ? a.mass : 0);
}

/** Rescan every body for stars. Throttled by the caller; allocates nothing. */
function scanForStars() {
    starScanCache.length = 0;
    const planets = (simulation && Array.isArray(simulation.planets)) ? simulation.planets : null;
    if (!planets) {
        return;
    }
    for (let i = 0; i < planets.length; i++) {
        const planet = planets[i];
        if (!planet || !planet.position || !looksLikeStar(planet)) {
            continue;
        }
        starScanCache.push(planet);
        if (starScanCache.length >= STAR_VISUAL_LIMIT) {
            break;
        }
    }
    starScanCache.sort(compareByMassDescending);
}

/**
 * The live stars, most massive first. Reuses one array, so the caller must not
 * hold on to it across frames.
 */
function collectStars() {
    const out = starList;
    out.length = 0;
    if (!simulation) {
        return out;
    }

    // 1. the contract
    const declared = simulation.stars;
    if (Array.isArray(declared)) {
        for (let i = 0; i < declared.length && out.length < STAR_VISUAL_LIMIT; i++) {
            const star = declared[i];
            if (star && !star.removed && star.position) {
                out.push(star);
            }
        }
        if (out.length > 0) {
            starScanCache.length = 0;
            out.sort(compareByMassDescending);
            return out;
        }
    }

    // 2. the single-star fallback
    const single = simulation.star;
    if (single && !single.removed && single.position) {
        starScanCache.length = 0;
        out.push(single);
        return out;
    }

    // 3. our own detection, throttled hard: it is O(n) from inside the frame.
    let stale = starProbeCountdown-- <= 0;
    for (let i = 0; i < starScanCache.length && !stale; i++) {
        if (starScanCache[i].removed) {
            stale = true;
        }
    }
    if (stale) {
        starProbeCountdown = 120;
        scanForStars();
    }
    for (let i = 0; i < starScanCache.length && out.length < STAR_VISUAL_LIMIT; i++) {
        const star = starScanCache[i];
        if (star && !star.removed && star.position) {
            out.push(star);
        }
    }
    return out;
}

/** The dominant star, or null. Used for the HUD and the guides. */
function dominantStar() {
    return starList.length > 0 ? starList[0] : null;
}

/** Colour of a star's own emission: blackbody first, then whatever it says. */
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
 * with an additive sprite. It costs one quad per star.
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

function createStarLayer() {
    starLayer = new THREE.Group();
    starLayer.name = 'stars';
    // One geometry and one texture for every star in the scene: only the
    // materials (which carry the colour) are per-star.
    starGeometry = new THREE.SphereGeometry(1, 32, 24);
    starGlowTexture = createGlowTexture();
    starVisuals = [];
    starVisualCount = 0;
    starSet.clear();
    return starLayer;
}

/** Create one star visual and park it in the pool. */
function createStarVisual(index) {
    const group = new THREE.Group();
    group.name = 'star' + index;
    group.visible = false;

    const core = new THREE.Mesh(
        starGeometry,
        new THREE.MeshBasicMaterial({ color: 0xfff2d8, fog: false, toneMapped: false })
    );
    core.frustumCulled = false;
    core.name = 'starCore' + index;
    group.add(core);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: starGlowTexture,
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
    glow.frustumCulled = false;
    // never pickable: clicks must land on the core, not on the halo
    glow.raycast = function () { };
    group.add(glow);

    // Materials are Lambert, so bodies are genuinely lit by the stars. distance
    // 0 disables attenuation: at 20 AU a physically attenuated light would leave
    // the outer disk black. Only the first few stars carry one.
    let light = null;
    if (index < STAR_LIGHT_LIMIT) {
        light = new THREE.PointLight(0xffffff, 1.4, 0);
        group.add(light);
    }

    const visual = {
        group: group,
        core: core,
        glow: glow,
        light: light,
        planet: null,
        lastHex: '',
        colorTimer: index
    };
    starLayer.add(group);
    starVisuals.push(visual);
    return visual;
}

/**
 * Place and colour one visual per live star, hiding the surplus.
 *
 * COST WITH MANY STARS. The pool is created once and only ever mutated, so a
 * cluster of fifty stars is fifty position/scale writes plus, once every
 * STAR_COLOR_INTERVAL frames, one blackbody lookup each. Nothing is allocated
 * and nothing is rebuilt.
 */
function syncStars() {
    if (!starLayer) {
        return;
    }
    const stars = collectStars();
    const wanted = Math.min(stars.length, STAR_VISUAL_LIMIT);
    const boost = positiveOr(typeof STAR_EMISSIVE_BOOST !== 'undefined' ? STAR_EMISSIVE_BOOST : 0, 1);

    let pickablesDirty = (wanted !== starVisualCount);
    starSet.clear();

    for (let i = 0; i < wanted; i++) {
        const star = stars[i];
        let visual = starVisuals[i];
        if (!visual) {
            visual = createStarVisual(i);
            pickablesDirty = true;
        }
        starSet.add(star);

        visual.planet = star;
        visual.group.visible = true;
        visual.core.visible = true;
        visual.group.position.set(star.position.x, star.position.y, star.position.z);
        visual.core.userData.planet = star;

        const radius = displayRadiusOf(star);
        visual.core.scale.setScalar(radius);
        visual.glow.scale.setScalar(radius * 10);

        // Colour changes on the fusion timescale: refresh it on a stagger.
        if (visual.colorTimer-- <= 0 || visual.lastHex === '') {
            visual.colorTimer = STAR_COLOR_INTERVAL;
            const hex = starColorHex(star);
            if (hex !== visual.lastHex) {
                visual.lastHex = hex;
                const color = cachedColor(hex);
                // The halo keeps the honest blackbody hue; the core is the same
                // hue driven past 1.0 by the emissive boost, which is what makes
                // a photographed star read as a white disc with a coloured corona.
                visual.glow.material.color.copy(color);
                visual.core.material.color.copy(color).multiplyScalar(boost);
                if (visual.light) {
                    visual.light.color.copy(color).lerp(WHITE, 0.6);
                }
            }
        }
    }

    // Hide the surplus. The core is handed to the raycaster directly, so hiding
    // only the group would leave an invisible pickable floating in the scene.
    for (let i = wanted; i < starVisuals.length; i++) {
        const visual = starVisuals[i];
        if (visual.group.visible) {
            visual.group.visible = false;
            visual.core.visible = false;
            visual.core.userData.planet = null;
            visual.planet = null;
            pickablesDirty = true;
        }
    }

    starVisualCount = wanted;
    if (pickablesDirty) {
        rebuildPickables();
    }
}

/** The raycast roots handed to CameraController. */
/**
 * Hand the detail pool the current selection so it prioritises what the user is
 * looking at. Must run BEFORE syncInstances, which skips whatever it claims.
 */
function updateDetailBodies() {
    if (!detailBodies || !simulation) {
        return;
    }
    try {
        detailBodies.update(simulation.planets, camera, {
            selected: cameraController ? cameraController.getSelected() : null,
            followed: cameraController ? cameraController.getFollowed() : null
        });
    } catch (e) {
        // Never let a cosmetic layer kill the animation frame.
        detailBodies = null;
    }
}

function rebuildPickables() {
    pickables.length = 0;
    if (bodyMesh) {
        pickables.push(bodyMesh);
    }
    for (let i = 0; i < starVisualCount; i++) {
        pickables.push(starVisuals[i].core);
    }
}

// --- the gravitational focus an orbit should be drawn around ---------------
//
// With one star the focus is that star. With several it depends where the body
// is: a circumbinary planet orbits the pair's barycentre, while a planet inside
// a wide binary orbits its own host. Picking the wrong one draws a nonsense
// ellipse, so the choice is made per body, from the geometry.

const _starField = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mass: 0, spread: 0, count: 0 };
const _focus = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mass: 0 };

/** Barycentre, total mass and spread of the star system. Once per frame. */
function updateStarField() {
    const field = _starField;
    field.x = field.y = field.z = 0;
    field.vx = field.vy = field.vz = 0;
    field.mass = 0;
    field.spread = 0;
    field.count = starList.length;
    if (field.count === 0) {
        return;
    }
    let mass = 0;
    for (let i = 0; i < starList.length; i++) {
        const star = starList[i];
        const m = (typeof star.mass === 'number' && isFinite(star.mass) && star.mass > 0) ? star.mass : 0;
        const p = star.position;
        if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) {
            continue;
        }
        const v = star.velocity || { x: 0, y: 0, z: 0 };
        field.x += p.x * m;
        field.y += p.y * m;
        field.z += p.z * m;
        field.vx += (v.x || 0) * m;
        field.vy += (v.y || 0) * m;
        field.vz += (v.z || 0) * m;
        mass += m;
    }
    if (mass > 0) {
        field.x /= mass;
        field.y /= mass;
        field.z /= mass;
        field.vx /= mass;
        field.vy /= mass;
        field.vz /= mass;
    }
    field.mass = mass;

    for (let i = 0; i < starList.length; i++) {
        const p = starList[i].position;
        if (!p) {
            continue;
        }
        const dx = p.x - field.x, dy = p.y - field.y, dz = p.z - field.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > field.spread) {
            field.spread = d;
        }
    }
}

/**
 * The focus to draw `planet`'s orbit around: the whole star system when the
 * body is far outside it, otherwise the star that dominates locally (max
 * m/r^2). Writes into a scratch object; returns null when there is no star.
 */
function focusFor(planet) {
    const field = _starField;
    if (field.count === 0 || !(field.mass > 0)) {
        return null;
    }
    const p = planet.position;
    if (!p) {
        return null;
    }
    if (field.count === 1) {
        const star = starList[0];
        const v = star.velocity || { x: 0, y: 0, z: 0 };
        _focus.x = star.position.x; _focus.y = star.position.y; _focus.z = star.position.z;
        _focus.vx = v.x || 0; _focus.vy = v.y || 0; _focus.vz = v.z || 0;
        _focus.mass = (typeof star.mass === 'number') ? star.mass : 0;
        return _focus;
    }

    const dx = p.x - field.x, dy = p.y - field.y, dz = p.z - field.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance > field.spread * 3) {
        // far outside the pair: it orbits the barycentre of the whole system
        _focus.x = field.x; _focus.y = field.y; _focus.z = field.z;
        _focus.vx = field.vx; _focus.vy = field.vy; _focus.vz = field.vz;
        _focus.mass = field.mass;
        return _focus;
    }

    let best = null;
    let bestPull = -Infinity;
    for (let i = 0; i < starList.length; i++) {
        const star = starList[i];
        const sp = star.position;
        if (!sp) {
            continue;
        }
        const ex = p.x - sp.x, ey = p.y - sp.y, ez = p.z - sp.z;
        const r2 = ex * ex + ey * ey + ez * ez;
        const mass = (typeof star.mass === 'number' && star.mass > 0) ? star.mass : 0;
        const pull = (r2 > 1e-12) ? mass / r2 : Infinity;
        if (pull > bestPull) {
            bestPull = pull;
            best = star;
        }
    }
    if (!best) {
        return null;
    }
    const v = best.velocity || { x: 0, y: 0, z: 0 };
    _focus.x = best.position.x; _focus.y = best.position.y; _focus.z = best.position.z;
    _focus.vx = v.x || 0; _focus.vy = v.y || 0; _focus.vz = v.z || 0;
    _focus.mass = (typeof best.mass === 'number') ? best.mass : 0;
    return _focus;
}

function disposeStarLayer() {
    for (let i = 0; i < starVisuals.length; i++) {
        const visual = starVisuals[i];
        visual.core.material.dispose();
        visual.glow.material.dispose();
        visual.core.userData.planet = null;
        visual.planet = null;
        if (visual.light && visual.light.parent) {
            visual.light.parent.remove(visual.light);
        }
    }
    starVisuals.length = 0;
    starVisualCount = 0;
    starSet.clear();
    starList.length = 0;
    starScanCache.length = 0;
    starProbeCountdown = 0;
    if (starGeometry) {
        starGeometry.dispose();
        starGeometry = null;
    }
    if (starGlowTexture) {
        starGlowTexture.dispose();
        starGlowTexture = null;
    }
    if (starLayer && starLayer.parent) {
        starLayer.parent.remove(starLayer);
    }
    starLayer = null;
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
 * Which way is "up" out of the disk? The scenario says so through
 * `meta.diskNormal`; when it does not (or there is no disk at all) it is
 * MEASURED: the axis with the smallest spread of body positions is the normal.
 * Defaults to +Z, the plane the ring geometry is already built in.
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
 * The disk normal as a unit vector: the scenario's when it publishes a usable
 * one, the measured axis otherwise. Returns a fresh THREE.Vector3 - this is
 * called at build time, never from the render loop.
 */
function resolveDiskNormal(planets, meta) {
    const declared = meta && meta.diskNormal;
    if (declared &&
        typeof declared.x === 'number' && typeof declared.y === 'number' && typeof declared.z === 'number' &&
        isFinite(declared.x) && isFinite(declared.y) && isFinite(declared.z)) {
        const vector = new THREE.Vector3(declared.x, declared.y, declared.z);
        if (vector.lengthSq() > 1e-12) {
            return vector.normalize();
        }
    }
    const axis = detectDiskNormalAxis(planets);
    if (axis === 'y') {
        return new THREE.Vector3(0, 1, 0);
    }
    if (axis === 'x') {
        return new THREE.Vector3(1, 0, 0);
    }
    return new THREE.Vector3(0, 0, 1);
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
 *
 * @param {THREE.Vector3} normal the disk normal, from the scenario or measured
 * @param {number} [distance] AU; keeps the current distance when omitted
 */
function orientCameraToDisk(normal, distance) {
    if (!normal || normal.lengthSq() === 0) {
        return;
    }
    const elevationDegrees = 32;
    const up = Math.sin(elevationDegrees * Math.PI / 180);
    const along = Math.cos(elevationDegrees * Math.PI / 180);

    // An in-plane basis: any vector not parallel to the normal, orthogonalised.
    const helper = (Math.abs(normal.z) < 0.9)
        ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(normal, helper);
    if (u.lengthSq() < 1e-12) {
        u.set(1, 0, 0);
    }
    u.normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();

    // Kept off the cardinal axes so the disk reads as a disk, not a symmetric
    // silhouette.
    const direction = new THREE.Vector3()
        .addScaledVector(u, along * 0.55)
        .addScaledVector(v, along * 0.84)
        .addScaledVector(normal, up);
    if (direction.lengthSq() === 0) {
        return;
    }
    direction.normalize();

    // frameAll fits the distance along whatever direction the camera is looking
    // from, so the direction is what matters here; the distance is only a hint
    // for scenarios that publish one.
    const length = positiveOr(distance, camera.position.length() || 1);
    camera.position.copy(direction).multiplyScalar(length);
    camera.lookAt(0, 0, 0);
    if (cameraController && cameraController.controls) {
        cameraController.controls.target.set(0, 0, 0);
    }
}

/**
 * Ring radii that suit the scale of what is being simulated. A 20 AU disk and a
 * 4000 AU cluster cannot share a ladder, so the ladder is filtered to the scene
 * and thinned to at most nine rings.
 */
function guideRadiiFor(extent) {
    const ladder = [0.05, 0.1, 0.2, 0.5, 1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 300, 500,
        1000, 2000, 3000, 5000, 10000];
    const inner = extent / 60;
    const outer = extent * 1.15;
    const chosen = [];
    for (let i = 0; i < ladder.length; i++) {
        if (ladder[i] >= inner && ladder[i] <= outer) {
            chosen.push(ladder[i]);
        }
    }
    if (chosen.length <= 9) {
        return chosen;
    }
    const stride = Math.ceil(chosen.length / 9);
    const thinned = [];
    for (let i = 0; i < chosen.length; i += stride) {
        thinned.push(chosen[i]);
    }
    return thinned;
}

function createGuides(normal, extent) {
    const group = new THREE.Group();
    group.name = 'guides';

    guideGeometry = createCircleGeometry(180);
    guideMaterials.length = 0;

    // Kept deliberately dim and monochrome: these are fixed scaffolding, while
    // orbit lines are per-body coloured, so the two layers stay tellable apart.
    const ringMaterial = new THREE.LineBasicMaterial({
        color: 0x3f6ea8, transparent: true, opacity: 0.22, depthWrite: false, fog: false
    });
    guideMaterials.push(ringMaterial);

    const radii = guideRadiiFor(extent);
    for (let i = 0; i < radii.length; i++) {
        const ring = new THREE.LineLoop(guideGeometry, ringMaterial);
        ring.scale.setScalar(radii[i]);
        ring.frustumCulled = false;
        ring.raycast = function () { };
        group.add(ring);
    }

    // The snow line is a result, not a setting: it moves with the star's
    // luminosity, so it gets its own ring and its own colour.
    const snowMaterial = new THREE.LineBasicMaterial({
        color: 0x8fd8ff, transparent: true, opacity: 0.75, depthWrite: false, fog: false
    });
    guideMaterials.push(snowMaterial);
    snowLineRing = new THREE.LineLoop(guideGeometry, snowMaterial);
    snowLineRing.frustumCulled = false;
    snowLineRing.raycast = function () { };
    snowLineRing.visible = false;
    group.add(snowLineRing);

    // The circles are built in the XY plane; rotate the whole group so that its
    // +Z lands on the disk normal.
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);

    group.visible = guidesVisible;
    lastSnowLineRadius = -1;
    return group;
}

function disposeGuides() {
    for (let i = 0; i < guideMaterials.length; i++) {
        guideMaterials[i].dispose();
    }
    guideMaterials.length = 0;
    if (guideGeometry) {
        guideGeometry.dispose();
        guideGeometry = null;
    }
    if (guides && guides.parent) {
        guides.parent.remove(guides);
    }
    guides = null;
    snowLineRing = null;
    lastSnowLineRadius = -1;
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

function createOrbitLayer(extent) {
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
    orbitSlotByPlanet.clear();
    orbitActiveCount = 0;
    orbitHighWater = 0;
    orbitCursor = 0;
    orbitPendingBlank = 0;
    orbitTargetTimer = 0;
    orbitTargetsDirty = true;
    lastTrailSampleTime = -Infinity;
    _orbitTouchedLow = Infinity;
    _orbitTouchedHigh = -1;

    orbitMaxDrawRadius = positiveOr(extent, 20) * ORBIT_MAX_DRAW_RADIUS_FACTOR;

    applyOrbitVisibility();
    return orbitGroup;
}

function disposeOrbitLayer() {
    if (ellipseMesh) {
        ellipseMesh.geometry.dispose();
        ellipseMesh.material.dispose();
    }
    if (trailMesh) {
        trailMesh.geometry.dispose();
        trailMesh.material.dispose();
    }
    if (orbitGroup && orbitGroup.parent) {
        orbitGroup.parent.remove(orbitGroup);
    }
    orbitGroup = null;
    ellipseMesh = null;
    trailMesh = null;
    // the typed arrays are only reachable through the attributes above
    ellipsePositions = null;
    ellipseColors = null;
    trailPositions = null;
    trailColors = null;
    // slots hold references to bodies: dropping them is what stops a restart
    // from keeping the previous run's planets alive
    orbitSlots.length = 0;
    orbitSlotByPlanet.clear();
    _orbitTargets.length = 0;
    _orbitRanking.length = 0;
    orbitActiveCount = 0;
    orbitHighWater = 0;
    orbitCursor = 0;
    orbitPendingBlank = 0;
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
            for (let i = 0; i < planets.length; i++) {
                const planet = planets[i];
                if (!planet || planet.removed || !planet.position) {
                    continue;
                }
                // a star's own "orbit" is meaningless: it is (near) the focus
                if (starSet.has(planet)) {
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
    for (let i = 0; i < orbitSlots.length; i++) {
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

/**
 * Write one body's ellipse into the shared buffer.
 * @param {Object} focus {x,y,z,vx,vy,vz,mass} - see focusFor()
 */
function packEllipse(index, planet, focus, color) {
    const positionBase = index * ORBIT_ELLIPSE_VERTICES * 3;
    const colorBase = index * ORBIT_ELLIPSE_VERTICES * 4;

    let ok = false;
    let sx = 0, sy = 0, sz = 0;
    if (focus && planet.position && planet.velocity) {
        sx = focus.x; sy = focus.y; sz = focus.z;
        const gravity = positiveOr(typeof GRAVITATION_CONSTANT !== 'undefined' ? GRAVITATION_CONSTANT : 0,
            4 * Math.PI * Math.PI);
        const mu = gravity *
            ((typeof focus.mass === 'number' ? focus.mass : 0) +
             (typeof planet.mass === 'number' ? planet.mass : 0));
        ok = computeOrbitElements(
            planet.position.x - sx, planet.position.y - sy, planet.position.z - sz,
            planet.velocity.x - focus.vx, planet.velocity.y - focus.vy, planet.velocity.z - focus.vz,
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
    const wantEllipses = ellipseMesh.visible;
    const wantTrails = trailMesh.visible;
    let budget = ORBIT_SLOT_BUDGET;

    for (let visited = 0; visited < ORBIT_MAX_SLOTS && budget > 0; visited++) {
        const index = orbitCursor;
        orbitCursor = (orbitCursor + 1) % ORBIT_MAX_SLOTS;
        const slot = orbitSlots[index];
        if (!slot) {
            continue;
        }

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
            packEllipse(index, planet, focusFor(planet), slot.color);
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
 * Build the single InstancedMesh that draws every body.
 *
 * The geometry has radius 1, so an instance's world radius is entirely carried
 * by its matrix scale.
 *
 * Lambert rather than Basic: the whole point of the scene is that there are
 * stars in it, and unlit spheres hide that completely. instanceColor is honoured
 * by the Lambert shader (color_vertex handles USE_INSTANCING_COLOR), so the
 * per-instance composition colours still come through.
 */
function createBodyMesh(capacity) {
    const detail = numberOr(typeof RENDER_DETAILS !== 'undefined' ? RENDER_DETAILS : 2, 2);
    bodyGeometry = new THREE.DodecahedronGeometry(1, detail);
    bodyMaterial = new THREE.MeshLambertMaterial({ fog: false });
    const mesh = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Bodies move far apart and the camera flies among them; a stale bounding
    // volume would cull instances that are actually on screen.
    mesh.frustumCulled = false;
    mesh.name = 'bodies';
    // Picking convention required by CameraController: instanceId -> planet.id
    mesh.userData.planetIds = planetIds;
    return mesh;
}

function disposeBodyMesh() {
    if (bodyMesh) {
        if (typeof bodyMesh.dispose === 'function') {
            bodyMesh.dispose();          // releases the instanced attribute buffers
        }
        if (bodyMesh.parent) {
            bodyMesh.parent.remove(bodyMesh);
        }
        bodyMesh.userData.planetIds = null;
    }
    if (bodyGeometry) {
        bodyGeometry.dispose();
        bodyGeometry = null;
    }
    if (bodyMaterial) {
        bodyMaterial.dispose();
        bodyMaterial = null;
    }
    bodyMesh = null;
    planetIds.length = 0;
    pickables.length = 0;
}

/** Push the current physics state into the instance buffers. */
function syncInstances() {
    if (!bodyMesh) {
        return;
    }
    const planets = (simulation && Array.isArray(simulation.planets)) ? simulation.planets : [];
    const capacity = bodyMesh.instanceMatrix.count;
    let written = 0;

    for (let i = 0; i < planets.length && written < capacity; i++) {
        const planet = planets[i];
        if (!planet || planet.removed || !planet.position) {
            continue;
        }
        // a star with its own mesh must not be drawn twice
        if (starSet.has(planet)) {
            continue;
        }
        // nor a body the detail pool is drawing at full resolution
        if (detailBodies && detailBodies.isDetailed(planet)) {
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
// Scenario plumbing
// ---------------------------------------------------------------------------
//
// EVERYTHING read out of js/scenarios.js is optional. The file may not exist,
// may be half-written, or may publish a shape slightly different from the
// contract: none of that is allowed to leave the user staring at a black page.

/**
 * Read one of scenarios.js's globals.
 *
 * `typeof X` is NOT safe here: scenarios.js may declare its registry with
 * `const`, and a const in its temporal dead zone throws on typeof rather than
 * reporting 'undefined'. Every read of that file goes through one of these.
 */
function readRegistryGlobal(name) {
    try {
        switch (name) {
            case 'SCENARIOS': return (typeof SCENARIOS !== 'undefined') ? SCENARIOS : undefined;
            case 'DEFAULT_SCENARIO_ID': return (typeof DEFAULT_SCENARIO_ID !== 'undefined') ? DEFAULT_SCENARIO_ID : undefined;
            case 'getScenario': return (typeof getScenario !== 'undefined') ? getScenario : undefined;
            case 'buildScenario': return (typeof buildScenario !== 'undefined') ? buildScenario : undefined;
            case 'scenarioDefaults': return (typeof scenarioDefaults !== 'undefined') ? scenarioDefaults : undefined;
            default: return undefined;
        }
    } catch (e) {
        return undefined;            // declared but not yet initialised
    }
}

function scenarioRegistry() {
    const registry = readRegistryGlobal('SCENARIOS');
    if (!Array.isArray(registry)) {
        return [];
    }
    const out = [];
    for (let i = 0; i < registry.length; i++) {
        const scenario = registry[i];
        if (scenario && typeof scenario === 'object' && typeof scenario.id === 'string' && scenario.id) {
            out.push(scenario);
        }
    }
    return out;
}

function scenarioById(id) {
    if (typeof id !== 'string' || !id) {
        return null;
    }
    const lookup = readRegistryGlobal('getScenario');
    if (typeof lookup === 'function') {
        try {
            const found = lookup(id);
            if (found && typeof found === 'object') {
                return found;
            }
        } catch (e) { /* fall through to the registry scan */ }
    }
    const list = scenarioRegistry();
    for (let i = 0; i < list.length; i++) {
        if (list[i].id === id) {
            return list[i];
        }
    }
    return null;
}

function defaultScenarioId() {
    const declared = readRegistryGlobal('DEFAULT_SCENARIO_ID');
    if (typeof declared === 'string' && declared && scenarioById(declared)) {
        return declared;
    }
    const list = scenarioRegistry();
    return list.length > 0 ? list[0].id : null;
}

/** Every parameter of a scenario at its default value. Never throws. */
function scenarioDefaultsFor(id) {
    const declared = readRegistryGlobal('scenarioDefaults');
    if (typeof declared === 'function') {
        try {
            const values = declared(id);
            if (values && typeof values === 'object') {
                return values;
            }
        } catch (e) { /* fall through */ }
    }
    const out = {};
    const scenario = scenarioById(id);
    const params = (scenario && Array.isArray(scenario.params)) ? scenario.params : [];
    for (let i = 0; i < params.length; i++) {
        const spec = params[i];
        if (spec && typeof spec.key === 'string' && spec.key) {
            out[spec.key] = spec.default;
        }
    }
    return out;
}

/**
 * Build the simulation for a scenario.
 *
 * Falls through several shapes of the contract, in order of preference, and
 * throws an Error with a pt-BR message when none of them produces bodies. The
 * caller shows that message in the picker.
 */
function instantiateSimulation(id, params) {
    let bodies = null;
    let meta = null;
    let built = null;

    const build = readRegistryGlobal('buildScenario');
    if (id && typeof build === 'function') {
        const result = build(id, params || {});
        if (!result || typeof result !== 'object') {
            throw new Error('O cenário não devolveu nenhum corpo.');
        }
        bodies = Array.isArray(result.bodies) ? result.bodies : null;
        meta = (result.meta && typeof result.meta === 'object') ? result.meta : null;
        if (!bodies || bodies.length === 0) {
            throw new Error('O cenário não devolveu nenhum corpo.');
        }
        // `new Simulation(planets, meta)` is also the signature of the older
        // constructor, which simply ignores the second argument.
        built = new Simulation(bodies, meta);
    } else if (id && Simulation && typeof Simulation.fromScenario === 'function') {
        built = Simulation.fromScenario(id, params || {});
    } else {
        // No registry at all: the legacy constructor builds its own disk.
        built = new Simulation();
    }

    if (!built || !Array.isArray(built.planets) || built.planets.length === 0) {
        throw new Error('A simulação foi criada sem nenhum corpo.');
    }
    if (!meta && built.meta && typeof built.meta === 'object') {
        meta = built.meta;
    }
    return { simulation: built, meta: meta || {} };
}

/** The scenario name for the HUD, from whichever source has one. */
function resolveScenarioLabel(id, meta, built) {
    if (meta && typeof meta.label === 'string' && meta.label) {
        return meta.label;
    }
    const scenario = scenarioById(id || (built && built.scenarioId));
    if (scenario && typeof scenario.name === 'string' && scenario.name) {
        return scenario.name;
    }
    if (built && typeof built.scenarioId === 'string' && built.scenarioId) {
        return built.scenarioId;
    }
    if (typeof id === 'string' && id) {
        return id;
    }
    return 'Simulação padrão';
}

/** How big the thing being simulated is, in AU. Used for guides and clipping. */
function measureExtent(planets, meta) {
    let extent = 0;
    if (Array.isArray(planets)) {
        for (let i = 0; i < planets.length; i++) {
            const planet = planets[i];
            const p = planet && planet.position;
            if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) {
                continue;
            }
            const d = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
            if (d > extent) {
                extent = d;
            }
        }
    }
    const hint = meta ? positiveOr(meta.cameraDistance, 0) : 0;
    if (hint > extent) {
        extent = hint;
    }
    if (!(extent > 0)) {
        extent = positiveOr(typeof DISK_OUTER_RADIUS !== 'undefined' ? DISK_OUTER_RADIUS : 0, 20);
    }
    return extent;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

function onWindowResize() {
    if (!camera || !renderer) {
        return;
    }
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
    if (!running || (picker && picker.isVisible())) {
        return;                     // the launch screen owns the keyboard
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

// ---------------------------------------------------------------------------
// The stage: built once, kept for the life of the page
// ---------------------------------------------------------------------------

function initStage() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    PERIODIC_TABLE_ELEMENTS = (new PeriodicTable()).atoms;
    resolveRenderRadiusMapping();

    // A logarithmic depth buffer is what makes a near plane of 1e-3 AU coexist
    // with a far plane of 1e4 AU: without it, standing next to a 0.02 AU embryo
    // and still seeing the outer disk is not possible in one pass.
    camera = new THREE.PerspectiveCamera(70, width / height, 0.001, 10000);
    camera.position.set(0, 0, 60);

    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(
        (typeof BACKGROUND_COLOR === 'string' && BACKGROUND_COLOR) ? BACKGROUND_COLOR : '#000');

    // Night sides must not be pure black or half of every body disappears.
    scene.add(new THREE.AmbientLight(0x8fa8cc, 0.5));

    document.body.appendChild(renderer.domElement);

    window.addEventListener('resize', onWindowResize, false);
    window.addEventListener('keydown', onExtraKeyDown, false);

    Object.assign(window, { scene, camera, renderer });
}

// ---------------------------------------------------------------------------
// One run: build and teardown
// ---------------------------------------------------------------------------

/**
 * Release EVERY resource buildRun() allocated. The pairs are, in order:
 *
 *   NavigatorUI            -> ui.dispose()
 *   CameraController       -> cameraController.dispose()
 *   simulation listeners   -> dropped here
 *   InstancedMesh + geom + material -> disposeBodyMesh()
 *   star meshes/materials/texture   -> disposeStarLayer()
 *   guide geometry + materials      -> disposeGuides()
 *   orbit buffers, meshes, slots    -> disposeOrbitLayer()
 *   colour cache, world group       -> here
 *
 * Anything left behind shows up as growing memory and stale bodies in the body
 * list after a few restarts, so this is deliberately exhaustive.
 */
function teardownRun() {
    running = false;

    if (detailBodies) {
        try { detailBodies.dispose(); } catch (e) { /* going away anyway */ }
        detailBodies = null;
    }
    if (textureLibrary) {
        try { textureLibrary.dispose(); } catch (e) { /* idem */ }
        textureLibrary = null;
    }

    if (ui) {
        try { ui.dispose(); } catch (e) { /* the panel is going away anyway */ }
        ui = null;
    }
    if (cameraController) {
        try { cameraController.dispose(); } catch (e) { /* idem */ }
        cameraController = null;
    }
    controls = null;

    if (simulation) {
        // Drop the callbacks we registered so the closures (and everything they
        // capture) die with the run, even if the Simulation object is somehow
        // kept alive elsewhere.
        if (Array.isArray(simulation.removedListeners)) {
            simulation.removedListeners.length = 0;
        }
        if (Array.isArray(simulation.spawnedListeners)) {
            simulation.spawnedListeners.length = 0;
        }
    }
    onRemovedHandler = null;
    onSpawnedHandler = null;
    simulation = null;

    disposeOrbitLayer();
    disposeGuides();
    disposeStarLayer();
    disposeBodyMesh();

    if (world) {
        if (world.parent) {
            world.parent.remove(world);
        }
        world = null;
    }

    colorCache.clear();
    starSet.clear();
    starList.length = 0;
    starScanCache.length = 0;

    simulatedYears = 0;
    yearsWindow = 0;
    clockWindow = 0;
    yearsPerSecond = 0;
    paused = false;
    speedMultiplier = 1;
    renderFaults = 0;
    activeMeta = null;
    activeLabel = '';
}

/**
 * Build a run. Throws (with a pt-BR message) when the scenario cannot be built;
 * the caller shows that in the launch screen.
 *
 * @param {string|null} id       scenario id, null for the built-in default
 * @param {Object|null} params   scenario parameters, may be partial
 */
function buildRun(id, params) {
    teardownRun();

    const created = instantiateSimulation(id, params);
    simulation = created.simulation;
    const meta = created.meta || {};

    activeScenarioId = (typeof simulation.scenarioId === 'string' && simulation.scenarioId)
        ? simulation.scenarioId
        : id;
    activeParams = params || null;
    activeMeta = meta;
    activeLabel = resolveScenarioLabel(id, meta, simulation);

    // The timestep is a property of the scenario: a tight binary needs a far
    // smaller one than a 20 AU disk, and reusing the disk's would visibly break
    // it. Clamped so a malformed value cannot freeze the page.
    const fallbackDt = positiveOr(typeof FIXED_DT !== 'undefined' ? FIXED_DT : 0, 0.0035);
    activeDt = positiveOr(meta.suggestedDt, fallbackDt);
    if (activeDt > 1) {
        activeDt = 1;
    }

    // Some builds of the Simulation may not read meta themselves; setting the
    // switches here is harmless when they did.
    if (typeof meta.gasAccretion === 'boolean' && typeof simulation.gasAccretionEnabled === 'boolean') {
        simulation.gasAccretionEnabled = meta.gasAccretion;
    }
    if (typeof meta.fusion === 'boolean' && typeof simulation.fusionEnabled === 'boolean') {
        simulation.fusionEnabled = meta.fusion;
    }

    sceneRadius = measureExtent(simulation.planets, meta);
    camera.far = Math.max(sceneRadius * 500, 1000);
    camera.near = Math.max(sceneRadius * 1e-6, 1e-4);
    camera.updateProjectionMatrix();

    world = new THREE.Group();
    world.name = 'world';
    scene.add(world);

    // Headroom above the initial body count: fragmenting impacts can briefly
    // raise it, and an InstancedMesh cannot grow.
    const capacity = Math.max(16, simulation.planets.length + 64);
    bodyMesh = createBodyMesh(capacity);
    world.add(bodyMesh);

    // Most bodies are a few pixels wide, so texturing all of them is wasted. A
    // small pool of full-detail textured spheres follows whatever the camera is
    // actually looking at; everyone else stays a coloured instance.
    textureLibrary = new BodyTextureLibrary();
    detailBodies = new DetailBodyPool(world, {
        library: textureLibrary,
        count: 12,
        getCamera: () => camera,
        radiusOf: displayRadiusOf,
        skip: (planet) => starSet.has(planet)
    });

    world.add(createStarLayer());

    const normal = resolveDiskNormal(simulation.planets, meta);
    guides = createGuides(normal, sceneRadius);
    world.add(guides);

    world.add(createOrbitLayer(sceneRadius));

    syncStars();
    updateStarField();
    updateDetailBodies();
    syncInstances();
    rebuildPickables();

    cameraController = new CameraController(camera, renderer.domElement, {
        getBodies: () => (simulation ? simulation.planets : []),
        getPickables: () => (detailBodies ? pickables.concat(detailBodies.pickables()) : pickables),
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
        if (!planet || !cameraController) {
            return;
        }
        cameraController.flyTo(planet, { radius: displayRadiusOf(planet), fill: fill });
    };

    ui = new NavigatorUI({
        getBodies: () => (simulation ? simulation.planets : []),
        getStats: () => (simulation ? simulation.stats : null),
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
        onOrbitScopeChange: (scope) => setOrbitScope(scope),
        onChangeScenario: () => openPicker()
    });
    ui.setGuidesVisible(guidesVisible);
    ui.setOrbitMode(orbitMode);
    ui.setOrbitScope(orbitScope);
    ui.setSpeed(1, false);
    ui.setPaused(false);
    ui.setScenario(activeLabel, activeScenarioId);

    onRemovedHandler = function (planet) {
        if (!cameraController || !ui) {
            return;
        }
        const watched = cameraController.getFollowed() || cameraController.getSelected();
        if (watched !== planet) {
            return;
        }
        const label = (planet && typeof planet.classLabel === 'string' && planet.classLabel)
            ? planet.classLabel
            : 'Corpo';
        const id = (planet && planet.id !== undefined) ? ' #' + planet.id : '';
        ui.notify(label + id + ' acretado por outro corpo');
    };
    if (typeof simulation.onPlanetRemoved === 'function') {
        simulation.onPlanetRemoved(onRemovedHandler);
    }
    onSpawnedHandler = function () {
        orbitTargetsDirty = true;
    };
    if (typeof simulation.onPlanetSpawned === 'function') {
        simulation.onPlanetSpawned(onSpawnedHandler);
    }

    Object.assign(window, { simulation, cameraController, ui });

    // Frame the whole system rather than sitting at the origin inside a star,
    // and look at it from above the plane first - see orientCameraToDisk. When
    // the scenario suggests an opening distance, that is used verbatim;
    // otherwise the bounding sphere decides.
    // Start every run from the same place, whatever the previous one left the
    // camera doing: a restart that opened from the inside of a body would be
    // indistinguishable from a broken build.
    const suggestedDistance = positiveOr(meta.cameraDistance, 0);
    if (camera.up && camera.up.set) {
        camera.up.set(0, 1, 0);
    }
    camera.position.set(0, 0, Math.max(sceneRadius * 2.2, 1));
    orientCameraToDisk(normal, suggestedDistance > 0 ? suggestedDistance : undefined);
    if (suggestedDistance > 0) {
        cameraController.controls.target.set(0, 0, 0);
        cameraController.controls.saveState();
    } else {
        cameraController.frameAll({ duration: 0 });
    }

    if (typeof meta.notes === 'string' && meta.notes) {
        ui.notify(meta.notes);
    }

    running = true;
}

// ---------------------------------------------------------------------------
// The launch screen
// ---------------------------------------------------------------------------

function ensurePicker() {
    if (picker) {
        return picker;
    }
    picker = new ScenarioPicker({
        getScenarios: scenarioRegistry,
        getDefaultId: defaultScenarioId,
        getDefaults: scenarioDefaultsFor,
        onStart: startScenario,
        onCancel: () => {
            // only offered while a run exists behind the launch screen
            if (running) {
                closePicker();
            }
        }
    });
    return picker;
}

/** Called by the picker's "Iniciar simulação" button. */
function startScenario(id, params) {
    const screen = ensurePicker();
    if (!id) {
        id = defaultScenarioId();
    }
    screen.setError('');
    try {
        buildRun(id, params);
    } catch (error) {
        const detail = (error && error.message) ? String(error.message) : '';
        screen.setError('Não foi possível montar este cenário. ' + detail);
        // Leave whatever was there before torn down but do NOT leave a blank
        // page: the launch screen stays up with a way out.
        screen.show({ allowCancel: false });
        return;
    }
    screen.hide();
    if (ui && activeLabel) {
        ui.notify('Cenário: ' + activeLabel);
    }
}

let pausedBeforePicker = false;

/** "Trocar cenário": back to the launch screen without reloading the page. */
function openPicker() {
    const screen = ensurePicker();
    pausedBeforePicker = paused;
    paused = true;
    if (ui) {
        ui.setPaused(true);
    }
    // The controller listens on window: leave it enabled and Tab, Space and the
    // camera shortcuts would fire while the user is filling in the form.
    if (cameraController) {
        cameraController.setEnabled(false);
    }
    screen.show({
        scenarioId: activeScenarioId,
        allowCancel: running,
        keptParameters: true
    });
}

/** Dismiss the launch screen and hand the running simulation back. */
function closePicker() {
    if (picker) {
        picker.hide();
    }
    if (cameraController) {
        cameraController.setEnabled(true);
    }
    paused = pausedBeforePicker;
    if (ui) {
        ui.setPaused(paused);
    }
}

function boot() {
    try {
        initStage();
    } catch (error) {
        showFatalError(error);
        return;
    }

    const screen = ensurePicker();
    if (scenarioRegistry().length === 0) {
        screen.setError(
            'A lista de cenários ainda não está disponível. ' +
            'Você pode iniciar a simulação padrão e escolher um cenário depois.');
    }
    screen.show({ allowCancel: false });

    let lastTime = performance.now();
    let accumulator = 0;

    function animate(now) {
        // scheduled FIRST, so even a thrown frame cannot kill the page
        requestAnimationFrame(animate);

        let frameTime = (now - lastTime) / 1000;
        lastTime = now;
        const maxFrameTime = positiveOr(typeof MAX_FRAME_TIME !== 'undefined' ? MAX_FRAME_TIME : 0, 0.25);
        if (!(frameTime > 0)) {
            frameTime = 0;
        }
        if (frameTime > maxFrameTime) {
            frameTime = maxFrameTime;
        }

        try {
            if (running && simulation) {
                stepAndDraw(frameTime);
            }
            renderer.render(scene, camera);
        } catch (error) {
            renderFaults++;
            if (renderFaults === 1) {
                if (ui) {
                    ui.notify('Erro ao desenhar o quadro; a simulação foi pausada.');
                    ui.setPaused(true);
                }
                paused = true;
                if (typeof console !== 'undefined' && console.error) {
                    console.error(error);
                }
            }
        }
    }

    function stepAndDraw(frameTime) {
        frameCounter++;
        let steppedYears = 0;

        if (!paused) {
            // activeDt is in YEARS, frameTime is in seconds: at 1x, one real
            // second advances the system by 1/activeDt steps.
            accumulator += frameTime * speedMultiplier;

            // MAX_STEPS_PER_FRAME is budgeted for 1x. Scaling it with the
            // multiplier is what makes the 2x and 4x buttons actually do
            // something instead of silently discarding the backlog.
            const budget = positiveOr(typeof MAX_STEPS_PER_FRAME !== 'undefined' ? MAX_STEPS_PER_FRAME : 0, 8);
            const maxSteps = Math.min(48, Math.max(1,
                Math.ceil(budget * Math.max(1, speedMultiplier))));

            let steps = 0;
            while (accumulator >= activeDt && steps < maxSteps) {
                simulation.step(activeDt);
                accumulator -= activeDt;
                steppedYears += activeDt;
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

        syncStars();
        updateStarField();
        updateDetailBodies();
        syncInstances();
        updateOrbits(frameTime, simulatedTime());
        cameraController.update(frameTime);
        ui.update(frameTime);
        updateSnowLine(ui.snowLineRadius());
    }

    // The accumulator must not swallow the time spent on the launch screen.
    function resetClock() {
        lastTime = performance.now();
        accumulator = 0;
    }
    window.addEventListener('focus', resetClock, false);

    requestAnimationFrame(animate);
}

/**
 * Last resort: the stage itself could not be built (no WebGL, for instance).
 * Anything is better than a black page with nothing on it.
 */
function showFatalError(error) {
    const box = document.createElement('div');
    box.className = 'nv-fatal';
    const title = document.createElement('h1');
    title.textContent = 'Não foi possível iniciar a simulação';
    const text = document.createElement('p');
    text.textContent = 'O navegador não conseguiu criar a cena 3D. ' +
        'Verifique se o WebGL está habilitado e recarregue a página.';
    const detail = document.createElement('p');
    detail.className = 'nv-fatal__detail';
    detail.textContent = (error && error.message) ? String(error.message) : '';
    box.appendChild(title);
    box.appendChild(text);
    box.appendChild(detail);
    document.body.appendChild(box);
    if (typeof console !== 'undefined' && console.error) {
        console.error(error);
    }
}

window.onload = boot;
