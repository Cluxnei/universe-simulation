/**
 * Render layer and application wiring.
 *
 * The physics core (Planet / Simulation / Octree) knows nothing about Three.js.
 * Everything visual lives here: bodies are drawn as instances of a single
 * InstancedMesh, so 800 bodies cost one draw call instead of 800.
 */

let camera, controls, scene, renderer, simulation, cameraController, ui;
let PERIODIC_TABLE_ELEMENTS;
let bodyMesh = null;
let planetIds = [];

// Reused every frame so the render loop allocates nothing.
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
// Element colors are CSS strings that repeat across hundreds of bodies. Parsing
// them every frame is pure waste, so keep one THREE.Color per distinct string.
const colorCache = new Map();

let paused = false;
let speedMultiplier = 1;

function cachedColor(cssColor) {
    let color = colorCache.get(cssColor);
    if (color === undefined) {
        color = new THREE.Color(cssColor);
        colorCache.set(cssColor, color);
    }
    return color;
}

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

/**
 * Build the single InstancedMesh that draws every body.
 *
 * The geometry has radius 1, so an instance's world radius is entirely carried by
 * its matrix scale. The old code baked the radius into the geometry and then
 * scaled by initialRadius/radius, which was inverted - growing bodies shrank on
 * screen. With a unit geometry that whole class of bug disappears.
 */
function createBodyMesh() {
    const geometry = new THREE.DodecahedronGeometry(1, RENDER_DETAILS);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, PLANETS_NUMBER);
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
    const planets = simulation.planets;
    const count = Math.min(planets.length, PLANETS_NUMBER);

    for (let i = 0; i < count; i++) {
        const planet = planets[i];
        _position.set(planet.position.x, planet.position.y, planet.position.z);
        _scale.setScalar(planet.radius);
        _matrix.compose(_position, _quaternion, _scale);
        bodyMesh.setMatrixAt(i, _matrix);
        bodyMesh.setColorAt(i, cachedColor(planet.color()));
        planetIds[i] = planet.id;
    }

    planetIds.length = count;
    bodyMesh.count = count;
    bodyMesh.instanceMatrix.needsUpdate = true;
    if (bodyMesh.instanceColor) {
        bodyMesh.instanceColor.needsUpdate = true;
    }
}

function start() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    PERIODIC_TABLE_ELEMENTS = (new PeriodicTable()).atoms;

    camera = new THREE.PerspectiveCamera(70, width / height, 0.1, PLANETS_POSITION_RANGE * 100);

    renderer = new THREE.WebGLRenderer({antialias: true});
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND_COLOR);

    simulation = new Simulation();

    bodyMesh = createBodyMesh();
    scene.add(bodyMesh);
    syncInstances();

    document.body.appendChild(renderer.domElement);

    cameraController = new CameraController(camera, renderer.domElement, {
        getBodies: () => simulation.planets,
        getPickables: () => [bodyMesh],
        scene: scene,
        onSelect: (planet) => { if (ui) ui.setSelected(planet); },
        onModeChange: (mode) => { if (ui) ui.setMode(mode); },
        onFollowChange: (planet) => { if (ui) ui.setFollowing(planet); },
        onTogglePause: () => { if (ui) ui.togglePause(); },
        onToggleHelp: () => { if (ui) ui.toggleHelp(); },
        onNotice: (message) => { if (ui) ui.notify(message); }
    });
    // OrbitControls is created and owned by the controller.
    controls = cameraController.controls;

    ui = new NavigatorUI({
        getBodies: () => simulation.planets,
        getStats: () => simulation.stats,
        getCamera: () => camera,
        getKeyBindings: () => cameraController.getKeyBindings(),
        onSelect: (planet) => {
            cameraController.select(planet);
            cameraController.flyTo(planet);
        },
        onFollow: (planet) => cameraController.follow(planet),
        onFrame: (planet) => cameraController.flyTo(planet, {fill: 0.4}),
        onRelease: () => cameraController.stopFollowing(),
        onFrameAll: () => cameraController.frameAll(),
        onModeChange: (mode) => cameraController.setMode(mode),
        onPause: (isPaused) => { paused = isPaused; },
        onSpeedChange: (multiplier) => { speedMultiplier = multiplier; }
    });

    simulation.onPlanetRemoved((planet) => {
        const watched = cameraController.getFollowed() || cameraController.getSelected();
        if (watched === planet) {
            ui.notify(`${planet.composition.element.name} absorvido por outro corpo`);
        }
    });

    window.addEventListener('resize', onWindowResize, false);
    Object.assign(window, {scene, simulation, camera, cameraController, ui});

    // camera.position.z = 5 would put us inside the cloud origin; frame the whole
    // simulation instead.
    cameraController.frameAll({duration: 0});

    let lastTime = performance.now();
    let accumulator = 0;

    function animate(now) {
        requestAnimationFrame(animate);

        let frameTime = (now - lastTime) / 1000;
        lastTime = now;
        if (frameTime > MAX_FRAME_TIME) {
            frameTime = MAX_FRAME_TIME;
        }

        if (!paused) {
            accumulator += frameTime * speedMultiplier;
            let steps = 0;
            while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
                simulation.step(FIXED_DT);
                accumulator -= FIXED_DT;
                steps++;
            }
            // Could not keep up: drop the backlog rather than accumulate a debt we
            // will never repay.
            if (steps === MAX_STEPS_PER_FRAME) {
                accumulator = 0;
            }
        }

        syncInstances();
        cameraController.update(frameTime);
        ui.update(frameTime);
        renderer.render(scene, camera);
    }

    requestAnimationFrame(animate);
}

window.onload = start;
