/**
 * Procedural body textures + a level-of-detail pool of detailed meshes.
 *
 * WHY THIS FILE EXISTS
 *   The disk is drawn as one InstancedMesh of ~800 flat-shaded spheres. That is
 *   the right call while a body is four pixels across, and the wrong one the
 *   moment the camera flies to it. This file adds the second half: a small
 *   number of real, textured spheres for the bodies the user is actually
 *   looking at, and a library of textures generated from the simulated physics
 *   rather than from stock imagery.
 *
 *   Nothing here is loaded from disk or from the network. Every pixel is drawn
 *   at runtime into a <canvas> and wrapped in a THREE.CanvasTexture, so the
 *   repository gains no binary assets and the simulation still starts offline.
 *
 * WHAT DRIVES THE APPEARANCE
 *   classification  ('asteroid'|'planet'|'gasGiant'|'brownDwarf'|'star'|
 *                    'blackHole')
 *   composition     (.gasFraction .iceFraction .rockFraction .metalFraction)
 *   effectiveTemperature (only meaningful for bodies that emit their own light)
 *   mass, and a seed derived from planet.id
 *
 *   A body that accreted ice beyond the snow line comes out pale and cracked;
 *   an iron-rich embryo comes out dark and red; a body that ran away on gas
 *   comes out banded. That is the whole point: the picture is a readout of the
 *   physics, not decoration bolted on top of it.
 *
 * BLACK HOLES
 *   Every path above is wrong for one. A horizon has no surface, so no map is a
 *   map OF anything; its temperature is zero, so its blackbody colour is a
 *   clamped red rather than black; and it emits nothing, so the star treatment -
 *   granulation, limb darkening, an additive halo - is exactly backwards. A
 *   black hole therefore takes a separate route from textureClassOf() all the
 *   way to the mesh: a genuinely black unlit sphere for the horizon, and the
 *   accretion disk, photon ring and shadow around it carrying all the light.
 *   See the "Black holes" tunables below and textureDrawAccretionDisk().
 *
 * THREE.JS
 *   r147, UMD global. Every API used here was checked against js/libs/three.js:
 *   CanvasTexture, SphereGeometry, RingGeometry, Mesh, Group,
 *   MeshLambertMaterial (map / emissive / emissiveMap), MeshBasicMaterial,
 *   DoubleSide, RepeatWrapping, ClampToEdgeWrapping, sRGBEncoding,
 *   AdditiveBlending, Color, Object3D.renderOrder, Material.transparent /
 *   opacity / depthWrite / blending / toneMapped,
 *   Material.dispose, Texture.dispose, BufferGeometry.dispose, onBeforeCompile.
 *
 * SAFETY
 *   This runs inside the animation frame, where a TypeError kills the page.
 *   Nothing in this file throws: a missing composition, an absent
 *   classification, a null camera, an empty planet list, structure.js not
 *   loaded, THREE not loaded and even `document` not existing (node) are all
 *   handled and degrade to "no textures, no detail meshes".
 *
 * UNITS: solar masses, astronomical units, years, kelvin - as everywhere else.
 */

// ============================================================================
// Environment
// ============================================================================

/** Canvas generation needs a DOM. In node this is false and everything no-ops. */
const TEXTURE_HAS_DOCUMENT = (typeof document !== 'undefined' && document !== null &&
    typeof document.createElement === 'function')

/** THREE is a global from a <script> tag; it may legitimately not be there. */
function textureHasThree() {
    return typeof THREE !== 'undefined' && THREE !== null &&
        typeof THREE.CanvasTexture === 'function'
}

// ============================================================================
// Tunables
// ============================================================================

// Texture size. Equirectangular maps are 2:1 - one full turn of longitude
// against half a turn of latitude - so a square canvas would spend half its
// pixels stretching. TEXTURE_DEFAULT_SIZE is the WIDTH; the height is half.
const TEXTURE_DEFAULT_SIZE = 512

// LRU bound. Only ~12 bodies are detailed at once, so this is generous; it
// exists because CanvasTextures live in GPU memory and an unbounded cache of
// them is a leak that nothing ever reports.
const TEXTURE_DEFAULT_MAX_ENTRIES = 48

// How many different-looking textures a single (class, composition) bucket can
// produce. Higher looks more individual and costs more distinct textures.
const TEXTURE_DEFAULT_VARIANTS = 6

// Composition fractions are quantised to 1/TEXTURE_FRACTION_BUCKETS before
// they reach the cache key, so a body whose ice fraction jitters in the fifth
// decimal keeps the texture it already has.
const TEXTURE_FRACTION_BUCKETS = 5

// Temperature is bucketed geometrically: 12% steps, which is finer than the eye
// can follow along the Planckian locus and still only ~30 buckets over the
// whole 1000-40000 K range.
const TEXTURE_TEMPERATURE_RATIO = 1.12

// Limb darkening coefficient for stars, the usual linear law
// I(mu)/I(1) = 1 - u*(1 - mu). u = 0.6 is the solar value in the visible.
const TEXTURE_LIMB_DARKENING = 0.6

// --- Black holes -----------------------------------------------------------
//
// Radii here are in Schwarzschild radii. That is exactly the radius the physics
// hands the renderer for a black hole, and DetailBodyPool scales the whole
// group by the drawn radius, so the horizon sphere is 1 unit and every number
// below is a multiple of the horizon.

// Innermost stable circular orbit of a non-rotating hole: 6 GM/c^2 = 3 R_s.
// A thin disk cannot exist inside it, so this is where the disk starts.
const TEXTURE_BH_ISCO = 3
// The disk is drawn as two concentric annuli purely so they can be spun at
// different rates - see the Keplerian shear note in DetailBodyPool.
const TEXTURE_BH_DISK_SPLIT = 7
const TEXTURE_BH_DISK_OUTER = 16
// The apparent shadow of a Schwarzschild hole has radius sqrt(27)/2 = 2.598
// R_s, larger than the horizon because light bends round it, and the photon
// ring sits on its rim.
const TEXTURE_BH_SHADOW_RADIUS = 2.598
const TEXTURE_BH_PHOTON_INNER = 2.35
const TEXTURE_BH_PHOTON_OUTER = 3
// Width of the bright band, as a fraction of the photon ring's outer radius.
const TEXTURE_BH_PHOTON_WIDTH = 0.035
const TEXTURE_BH_PHOTON_BRIGHTNESS = 0.9
const TEXTURE_BH_SHADOW_OPACITY = 0.55

// Eddington luminosity: L_edd = 1.26e38 (M/Msun) erg/s and L_sun = 3.828e33
// erg/s, so in solar luminosities L_edd ~ 3.29e4 (M/Msun).
const TEXTURE_BH_EDDINGTON_PER_MASS = 3.29e4
// Assumed when nobody hands us an accretion luminosity. A tenth of Eddington is
// an ordinary Seyfert or a soft-state X-ray binary: visibly fed, not blazing.
const TEXTURE_BH_DEFAULT_EDDINGTON = 0.1
const TEXTURE_BH_MIN_EDDINGTON = 1e-4
// Anchor of the disk temperature scale: a 10 Msun hole at a tenth of Eddington
// gets a 30000 K inner disk. See textureDiskPeakTemperature for why this is an
// anchor and not a prediction.
const TEXTURE_BH_ANCHOR_MASS = 10
const TEXTURE_BH_ANCHOR_TEMPERATURE = 30000
const TEXTURE_BH_MIN_TEMPERATURE = 1200
const TEXTURE_BH_MAX_TEMPERATURE = 34000
// Peak of the thin-disk radial temperature shape, at x = 49/36. Computed rather
// than written out so the shape and its normalisation cannot drift apart.
const TEXTURE_BH_PROFILE_PEAK = Math.pow(49 / 36, -0.75) *
    Math.pow(1 - Math.pow(49 / 36, -0.5), 0.25)
// Peak brightness written into a disk texture, 0..255.
const TEXTURE_BH_DISK_GAIN = 235
// Keplerian rate at 1 R_s, radians per second of WALL CLOCK. Showmanship in
// absolute terms - the real figure is ~1e4 rad/s for a stellar-mass hole - but
// the ratio between the two annuli below is the true r^(-3/2) one.
const TEXTURE_BH_SPIN_SCALE = 7.5
const TEXTURE_BH_INNER_SPIN = TEXTURE_BH_SPIN_SCALE *
    Math.pow((TEXTURE_BH_ISCO + TEXTURE_BH_DISK_SPLIT) / 2, -1.5)
const TEXTURE_BH_OUTER_SPIN = TEXTURE_BH_SPIN_SCALE *
    Math.pow((TEXTURE_BH_DISK_SPLIT + TEXTURE_BH_DISK_OUTER) / 2, -1.5)

// Radial resolution of the shared annulus rasteriser's lookup tables.
const TEXTURE_ANNULUS_SAMPLES = 1024

// ============================================================================
// Small pure helpers - no DOM, no THREE, testable in node
// ============================================================================

function textureNumber(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback
}

function textureClamp(value, low, high) {
    if (!(value > low)) {
        return low
    }
    return value > high ? high : value
}

function textureMix(a, b, t) {
    return a + (b - a) * t
}

/** Hermite smoothstep on an already-normalised t. */
function textureSmooth(t) {
    return t * t * (3 - 2 * t)
}

/** Normalised smoothstep between two edges. */
function textureStep(x, edge0, edge1) {
    if (!(edge1 > edge0)) {
        return x >= edge1 ? 1 : 0
    }
    const t = textureClamp((x - edge0) / (edge1 - edge0), 0, 1)
    return textureSmooth(t)
}

/**
 * 32-bit integer avalanche. Deterministic, no Math.random anywhere in this
 * file: the same planet.id must produce the same body on every run and on
 * every frame, or textures would regenerate as values jitter.
 */
function textureHashInt(x) {
    let h = x | 0
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
    h = h ^ (h >>> 16)
    return h >>> 0
}

/** Seed for a body. Stable across frames because planet.id never changes. */
function textureSeedFromId(id) {
    const numeric = (typeof id === 'number' && isFinite(id)) ? Math.floor(id) : 0
    // The +1 keeps id 0 (the first body created, usually the star) off the
    // degenerate all-zeros seed.
    return textureHashInt(numeric + 1)
}

/** mulberry32: tiny, fast, seedable. Returns a function producing [0,1). */
function textureRandom(seed) {
    let state = (seed >>> 0) || 1
    return function () {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// ============================================================================
// Noise
// ============================================================================

// A sine lookup table. The band functions below evaluate two sines per pixel
// over 131072 pixels, which is a measurable slice of the generation budget, and
// a texture cannot see the difference between this and the real thing.
const TEXTURE_SIN_BITS = 12
const TEXTURE_SIN_SIZE = 1 << TEXTURE_SIN_BITS
const TEXTURE_SIN_MASK = TEXTURE_SIN_SIZE - 1
const TEXTURE_SIN_SCALE = TEXTURE_SIN_SIZE / (Math.PI * 2)
const TEXTURE_SIN_TABLE = (function () {
    const table = new Float64Array(TEXTURE_SIN_SIZE + 1)
    for (let i = 0; i <= TEXTURE_SIN_SIZE; i++) {
        table[i] = Math.sin((i / TEXTURE_SIN_SIZE) * Math.PI * 2)
    }
    return table
})()

/** sin(x), to about six decimal places, without the libm call. */
function textureSin(x) {
    const scaled = x * TEXTURE_SIN_SCALE
    const index = Math.floor(scaled)
    const fraction = scaled - index
    const i = index & TEXTURE_SIN_MASK
    const a = TEXTURE_SIN_TABLE[i]
    return a + (TEXTURE_SIN_TABLE[i + 1] - a) * fraction
}

/** Lattice hash for value noise. */
function textureHash3(ix, iy, iz, seed) {
    let h = seed ^ Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^
        Math.imul(iz, 0xcb1ab31f)
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
    h ^= h >>> 12
    h = Math.imul(h, 0x297a2d39)
    h ^= h >>> 15
    return (h >>> 0) / 4294967296
}

/** Trilinearly interpolated value noise in [0,1]. */
function textureValueNoise3(x, y, z, seed) {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const zi = Math.floor(z)
    const fx = textureSmooth(x - xi)
    const fy = textureSmooth(y - yi)
    const fz = textureSmooth(z - zi)

    const x0 = xi | 0
    const y0 = yi | 0
    const z0 = zi | 0
    const x1 = x0 + 1
    const y1 = y0 + 1
    const z1 = z0 + 1

    const c000 = textureHash3(x0, y0, z0, seed)
    const c100 = textureHash3(x1, y0, z0, seed)
    const c010 = textureHash3(x0, y1, z0, seed)
    const c110 = textureHash3(x1, y1, z0, seed)
    const c001 = textureHash3(x0, y0, z1, seed)
    const c101 = textureHash3(x1, y0, z1, seed)
    const c011 = textureHash3(x0, y1, z1, seed)
    const c111 = textureHash3(x1, y1, z1, seed)

    const a = textureMix(textureMix(c000, c100, fx), textureMix(c010, c110, fx), fy)
    const b = textureMix(textureMix(c001, c101, fx), textureMix(c011, c111, fx), fy)
    return textureMix(a, b, fz)
}

/**
 * Fractal noise over a whole equirectangular image, written into `out`.
 *
 * THE SEAM. A texture wrapped round a sphere meets itself at longitude 0. Noise
 * sampled on a plane does not, and the resulting vertical scar down one side of
 * every planet is the classic giveaway of a procedural texture.
 *
 * The fix here is geometric rather than cosmetic: the noise is 3-dimensional
 * and the image is sampled along a CYLINDER through it -
 *
 *     (x, y, z) = (cos(2*PI*u) * r, sin(2*PI*u) * r, v * f)
 *
 * - so u = 0 and u = 1 are literally the same point in the noise field, at
 * every octave and to every derivative. There is nothing to blend and nothing
 * to hide, and it holds for any radius r, so each octave can pick its own.
 *
 * cos/sin are evaluated once per column and reused across every row and every
 * octave, which is what makes this affordable at 256x128.
 *
 * @param {Float32Array} out    width*height, filled with values in [0,1]
 */
function textureNoiseField(out, width, height, frequency, octaves, gain, seed) {
    const columnCos = textureScratchCos(width)
    const columnSin = textureScratchSin(width)
    const latticeX = textureScratchInt(0, width)
    const latticeY = textureScratchInt(1, width)
    const fractionX = textureScratchDouble(0, width)
    const fractionY = textureScratchDouble(1, width)
    const planeLow = textureScratchDouble(2, width)
    const planeHigh = textureScratchDouble(3, width)

    for (let i = 0; i < out.length; i++) {
        out[i] = 0
    }

    let amplitude = 1
    let total = 0
    let scale = 1

    for (let octave = 0; octave < octaves; octave++) {
        // Radius of the sampling circle: chosen so one full turn of longitude
        // covers `frequency * scale` noise cells.
        const radius = (frequency * scale) / (2 * Math.PI)
        const vScale = frequency * scale * 0.5
        const octaveSeed = (seed + octave * 0x9e3779b1) | 0

        // The (x, y) lattice cell of a column never changes as rows advance -
        // only z does - so the whole horizontal half of the interpolation is
        // computed once per column per octave instead of once per pixel.
        for (let x = 0; x < width; x++) {
            const px = columnCos[x] * radius
            const py = columnSin[x] * radius
            const xi = Math.floor(px)
            const yi = Math.floor(py)
            latticeX[x] = xi
            latticeY[x] = yi
            fractionX[x] = textureSmooth(px - xi)
            fractionY[x] = textureSmooth(py - yi)
        }

        // ... and the four corners of a z-plane are shared by every row that
        // falls between that plane and the next, which is most of them: a
        // 256-wide octave at frequency 22 has 44 planes, not 128 rows.
        let cachedPlane = null

        for (let y = 0; y < height; y++) {
            const z = ((y + 0.5) / height) * vScale
            const zi = Math.floor(z)
            const fz = textureSmooth(z - zi)

            if (cachedPlane === null) {
                textureFillPlane(planeLow, width, latticeX, latticeY,
                    fractionX, fractionY, zi, octaveSeed)
                textureFillPlane(planeHigh, width, latticeX, latticeY,
                    fractionX, fractionY, zi + 1, octaveSeed)
                cachedPlane = zi
            } else if (zi !== cachedPlane) {
                if (zi === cachedPlane + 1) {
                    // v increases monotonically with y, so this is the common
                    // case: yesterday's upper plane is today's lower one.
                    for (let x = 0; x < width; x++) {
                        planeLow[x] = planeHigh[x]
                    }
                } else {
                    textureFillPlane(planeLow, width, latticeX, latticeY,
                        fractionX, fractionY, zi, octaveSeed)
                }
                textureFillPlane(planeHigh, width, latticeX, latticeY,
                    fractionX, fractionY, zi + 1, octaveSeed)
                cachedPlane = zi
            }

            const row = y * width
            for (let x = 0; x < width; x++) {
                const low = planeLow[x]
                out[row + x] += amplitude * (low + (planeHigh[x] - low) * fz)
            }
        }

        total += amplitude
        amplitude *= gain
        scale *= 2
    }

    if (total > 0) {
        const inverse = 1 / total
        for (let i = 0; i < out.length; i++) {
            out[i] *= inverse
        }
    }
    return out
}

/** One z-plane of the value noise, already interpolated in x and y. */
function textureFillPlane(target, width, latticeX, latticeY, fractionX, fractionY, zi, seed) {
    for (let x = 0; x < width; x++) {
        const xi = latticeX[x]
        const yi = latticeY[x]
        const fx = fractionX[x]
        const fy = fractionY[x]
        const c00 = textureHash3(xi, yi, zi, seed)
        const c10 = textureHash3(xi + 1, yi, zi, seed)
        const c01 = textureHash3(xi, yi + 1, zi, seed)
        const c11 = textureHash3(xi + 1, yi + 1, zi, seed)
        const a = c00 + (c10 - c00) * fx
        const b = c01 + (c11 - c01) * fx
        target[x] = a + (b - a) * fy
    }
}

// Column trig tables and noise scratch buffers, allocated once and grown on
// demand. Generation happens inside the animation frame, so it must not churn
// the heap.
let TEXTURE_SCRATCH_COS = null
let TEXTURE_SCRATCH_SIN = null
let TEXTURE_SCRATCH_WIDTH = 0
const TEXTURE_SCRATCH_FIELDS = []
const TEXTURE_SCRATCH_INTS = []
const TEXTURE_SCRATCH_DOUBLES = []

function textureScratchTrig(width) {
    if (TEXTURE_SCRATCH_WIDTH !== width || !TEXTURE_SCRATCH_COS) {
        TEXTURE_SCRATCH_COS = new Float64Array(width)
        TEXTURE_SCRATCH_SIN = new Float64Array(width)
        for (let x = 0; x < width; x++) {
            const angle = ((x + 0.5) / width) * Math.PI * 2
            TEXTURE_SCRATCH_COS[x] = Math.cos(angle)
            TEXTURE_SCRATCH_SIN[x] = Math.sin(angle)
        }
        TEXTURE_SCRATCH_WIDTH = width
    }
}

function textureScratchCos(width) {
    textureScratchTrig(width)
    return TEXTURE_SCRATCH_COS
}

function textureScratchSin(width) {
    textureScratchTrig(width)
    return TEXTURE_SCRATCH_SIN
}

/** A reusable Int32 column buffer. */
function textureScratchInt(index, size) {
    let buffer = TEXTURE_SCRATCH_INTS[index]
    if (!buffer || buffer.length !== size) {
        buffer = new Int32Array(size)
        TEXTURE_SCRATCH_INTS[index] = buffer
    }
    return buffer
}

/** A reusable Float64 column buffer. */
function textureScratchDouble(index, size) {
    let buffer = TEXTURE_SCRATCH_DOUBLES[index]
    if (!buffer || buffer.length !== size) {
        buffer = new Float64Array(size)
        TEXTURE_SCRATCH_DOUBLES[index] = buffer
    }
    return buffer
}

/** A reusable width*height float buffer, index 0..n. */
function textureScratchField(index, size) {
    let field = TEXTURE_SCRATCH_FIELDS[index]
    if (!field || field.length !== size) {
        field = new Float32Array(size)
        TEXTURE_SCRATCH_FIELDS[index] = field
    }
    return field
}

// ============================================================================
// Profile: what the physics says this body looks like
// ============================================================================

const TEXTURE_CLASS_ASTEROID = 'asteroid'
const TEXTURE_CLASS_PLANET = 'planet'
const TEXTURE_CLASS_GAS_GIANT = 'gasGiant'
const TEXTURE_CLASS_BROWN_DWARF = 'brownDwarf'
const TEXTURE_CLASS_STAR = 'star'
const TEXTURE_CLASS_BLACK_HOLE = 'blackHole'
const TEXTURE_CLASSES = [TEXTURE_CLASS_ASTEROID, TEXTURE_CLASS_PLANET,
    TEXTURE_CLASS_GAS_GIANT, TEXTURE_CLASS_BROWN_DWARF, TEXTURE_CLASS_STAR,
    TEXTURE_CLASS_BLACK_HOLE]

/**
 * Is this body a black hole?
 *
 * Two independent signals, either of which is enough, because the flag and the
 * classification are being added by other files and may arrive separately or
 * not at all. When neither is present the body falls through to the ordinary
 * mass-based guess and is drawn as whatever it looks like - which is the right
 * degradation, not a bug.
 */
function textureIsBlackHole(planet) {
    if (!planet) {
        return false
    }
    if (planet.isBlackHole === true) {
        return true
    }
    return planet.classification === TEXTURE_CLASS_BLACK_HOLE
}

// ---------------------------------------------------------------------------
// Accretion physics, such as it is. Pure, no DOM, no THREE.
// ---------------------------------------------------------------------------

/**
 * Accretion rate as a fraction of the Eddington rate, inferred from whatever
 * luminosity the physics is willing to give us. Never throws, never returns
 * anything but a finite number in (0, 1].
 */
function textureEddingtonRatio(mass, luminosity) {
    const m = textureNumber(mass, 0)
    const l = textureNumber(luminosity, 0)
    if (!(m > 0) || !(l > 0)) {
        return TEXTURE_BH_DEFAULT_EDDINGTON
    }
    const ratio = l / (TEXTURE_BH_EDDINGTON_PER_MASS * m)
    if (!isFinite(ratio)) {
        return TEXTURE_BH_DEFAULT_EDDINGTON
    }
    return textureClamp(ratio, TEXTURE_BH_MIN_EDDINGTON, 1)
}

/**
 * Temperature at the hottest point of the accretion disk, in kelvin.
 *
 * A standard thin disk peaks at T ~ (Mdot / M^2)^(1/4), and at a fixed fraction
 * of the Eddington rate Mdot ~ M, so T ~ M^(-1/4) * f_edd^(1/4). BOTH SCALINGS
 * ARE REAL: a stellar-mass hole's disk peaks in the X-ray, a supermassive one's
 * in the ultraviolet, and a hole fed harder runs hotter.
 *
 * The ABSOLUTE numbers are not. A real disk peaks near 1e7 K around a stellar
 * hole and 1e5 K around a supermassive one, and every blackbody above ~30000 K
 * is the same blue-white to the eye, so drawing the true values would make
 * every black hole in the simulation identical and identically blue. The anchor
 * slides the whole scale down into the range the eye can read while keeping the
 * two exponents intact: a stellar-mass hole comes out blue-white, a
 * supermassive one comes out the deep orange-red the Event Horizon Telescope
 * images are drawn in, and feeding either one harder moves it toward blue.
 */
function textureDiskPeakTemperature(mass, luminosity) {
    const m = textureNumber(mass, 0)
    const scale = (m > 0) ? m : TEXTURE_BH_ANCHOR_MASS
    const ratio = textureEddingtonRatio(m, luminosity)
    const temperature = TEXTURE_BH_ANCHOR_TEMPERATURE *
        Math.pow(scale / TEXTURE_BH_ANCHOR_MASS, -0.25) *
        Math.pow(ratio / TEXTURE_BH_DEFAULT_EDDINGTON, 0.25)
    if (!isFinite(temperature)) {
        return TEXTURE_BH_ANCHOR_TEMPERATURE
    }
    return textureClamp(temperature, TEXTURE_BH_MIN_TEMPERATURE,
        TEXTURE_BH_MAX_TEMPERATURE)
}

/**
 * Radial temperature shape of a thin disk, normalised so its peak is 1.
 *
 *     T(r) ~ r^(-3/4) * (1 - sqrt(r_isco / r))^(1/4),   x = r / r_isco
 *
 * The r^(-3/4) is the familiar Shakura-Sunyaev result. The second factor is the
 * zero-torque inner boundary condition, and it is what makes the disk fade to
 * nothing AT the ISCO and peak just outside it at x = 49/36 instead of being
 * hottest at its own inner edge. It costs one more pow and it is the difference
 * between a disk and a bright washer.
 */
function textureDiskTemperatureShape(x) {
    if (!(x > 1) || !isFinite(x)) {
        return 0
    }
    const shape = Math.pow(x, -0.75) * Math.pow(1 - Math.pow(x, -0.5), 0.25)
    return isFinite(shape) ? shape / TEXTURE_BH_PROFILE_PEAK : 0
}

/**
 * Classification of a body, tolerating every way it can be missing.
 * Prefers the body's own field, then structure.js, then a mass-only guess.
 */
function textureClassOf(planet) {
    // The flag wins over everything: a body may be flagged before structure.js
    // has had a chance to relabel it, and a black hole drawn as a star for one
    // frame is a bright white ball where a hole should be.
    if (planet && planet.isBlackHole === true) {
        return TEXTURE_CLASS_BLACK_HOLE
    }
    if (planet && typeof planet.classification === 'string' &&
        TEXTURE_CLASSES.indexOf(planet.classification) !== -1) {
        return planet.classification
    }
    const mass = textureNumber(planet && planet.mass, 0)
    if (typeof classify === 'function') {
        try {
            const guess = classify(mass, planet && planet.composition)
            if (typeof guess === 'string' && TEXTURE_CLASSES.indexOf(guess) !== -1) {
                return guess
            }
        } catch (e) { /* fall through to the mass-only guess */ }
    }
    // structure.js is not loaded. The thresholds below are the same physical
    // ones (deuterium and hydrogen ignition) expressed in solar masses.
    if (mass >= 0.08) {
        return TEXTURE_CLASS_STAR
    }
    if (mass >= 0.0124) {
        return TEXTURE_CLASS_BROWN_DWARF
    }
    if (mass < 1.5e-10) {
        return TEXTURE_CLASS_ASTEROID
    }
    return TEXTURE_CLASS_PLANET
}

/**
 * The raw, unquantised physics of a body, normalised and guarded.
 *
 * The four composition fractions are renormalised to sum to 1; a body with no
 * usable composition is treated as pure rock, which is the same default
 * structure.js uses.
 */
function textureRawOf(planet) {
    const composition = (planet && planet.composition) || null
    let gas = Math.max(0, textureNumber(composition && composition.gasFraction, 0))
    let ice = Math.max(0, textureNumber(composition && composition.iceFraction, 0))
    let rock = Math.max(0, textureNumber(composition && composition.rockFraction, 0))
    let metal = Math.max(0, textureNumber(composition && composition.metalFraction, 0))

    const sum = gas + ice + rock + metal
    if (sum > 0) {
        gas /= sum
        ice /= sum
        rock /= sum
        metal /= sum
    } else {
        gas = 0
        ice = 0
        rock = 1
        metal = 0
    }

    return {
        classification: textureClassOf(planet),
        gas: gas,
        ice: ice,
        rock: rock,
        metal: metal,
        mass: Math.max(0, textureNumber(planet && planet.mass, 0)),
        // Only a self-luminous body has a meaningful surface temperature here:
        // structure.js derives it from luminosity, which is 0 for a rock.
        temperature: Math.max(0, textureNumber(planet && planet.effectiveTemperature, 0)),
        // Only black holes read this, and only to decide how hard the disk is
        // being fed. It is 0 for a body that has no luminosity and for a body
        // whose physics never supplies one, and both are handled.
        luminosity: Math.max(0, textureNumber(planet && planet.luminosity, 0)),
        seed: textureSeedFromId(planet ? planet.id : 0)
    }
}

/**
 * Would `current` still land in the same cache bucket as the raw values that
 * produced an existing key?
 *
 * This is hysteresis on the CACHE KEY, and it is not optional. Quantisation
 * alone leaves a body whose ice fraction sits exactly on a bucket boundary
 * flipping between two textures forever, regenerating a few milliseconds of
 * canvas work every frame. Comparing against the values that were actually used
 * - rather than against the current bucket edge - means a full half-bucket of
 * real change is needed before anything is rebuilt, and the recorded values
 * move with it, so it cannot oscillate.
 */
function textureRawStable(previous, current) {
    if (!previous || !current) {
        return false
    }
    if (previous.classification !== current.classification) {
        return false
    }
    if (previous.classification === TEXTURE_CLASS_BLACK_HOLE) {
        // A horizon has no composition and no photosphere, so the comparisons
        // below would be measuring noise. The only two numbers that change how
        // a black hole is drawn are its mass and how hard it is being fed, and
        // both enter the key logarithmically.
        if (current.mass > 0 && previous.mass > 0 &&
            Math.abs(Math.log10(current.mass / previous.mass)) >= 0.5) {
            return false
        }
        const before = textureEddingtonRatio(previous.mass, previous.luminosity)
        const after = textureEddingtonRatio(current.mass, current.luminosity)
        return Math.abs(Math.log10(after / before)) < 0.25
    }
    const tolerance = 0.5 / TEXTURE_FRACTION_BUCKETS
    if (Math.abs(previous.gas - current.gas) >= tolerance ||
        Math.abs(previous.ice - current.ice) >= tolerance ||
        Math.abs(previous.rock - current.rock) >= tolerance ||
        Math.abs(previous.metal - current.metal) >= tolerance) {
        return false
    }
    if ((previous.temperature > 0) !== (current.temperature > 0)) {
        return false
    }
    if (current.temperature > 0) {
        const ratio = Math.sqrt(TEXTURE_TEMPERATURE_RATIO)
        if (current.temperature > previous.temperature * ratio ||
            current.temperature < previous.temperature / ratio) {
            return false
        }
    }
    if ((previous.mass > 0) !== (current.mass > 0)) {
        return false
    }
    // Mass buckets are three decades wide; half of one is a factor of ~31.
    if (current.mass > 0 && Math.abs(Math.log10(current.mass / previous.mass)) >= 1.5) {
        return false
    }
    return true
}

/** Quantise raw physics into the bucket that names a texture. */
function textureProfileFromRaw(raw, variants) {
    if (raw.classification === TEXTURE_CLASS_BLACK_HOLE) {
        return textureBlackHoleProfile(raw, variants)
    }
    const quantum = TEXTURE_FRACTION_BUCKETS
    const qGas = Math.round(raw.gas * quantum)
    const qIce = Math.round(raw.ice * quantum)
    const qRock = Math.round(raw.rock * quantum)
    const qMetal = Math.round(raw.metal * quantum)
    const qTemp = raw.temperature > 0
        ? Math.round(Math.log(raw.temperature) / Math.log(TEXTURE_TEMPERATURE_RATIO))
        : 0
    // Mass only matters where it changes the look rather than the class: a
    // heavier rocky body is rounder and less cratered. Three decades per bucket
    // is plenty.
    const qMass = raw.mass > 0 ? Math.round(Math.log10(raw.mass) / 3) : 0
    const variant = variants > 1 ? (raw.seed % variants) : 0

    return {
        classification: raw.classification,
        gas: raw.gas,
        ice: raw.ice,
        rock: raw.rock,
        metal: raw.metal,
        temperature: raw.temperature,
        mass: raw.mass,
        seed: raw.seed,
        variant: variant,
        // Meaningless off a black hole, present so every profile has one shape.
        eddington: 0,
        diskTemperature: 0,
        key: raw.classification + ':' + qGas + '.' + qIce + '.' + qRock + '.' + qMetal +
            ':' + qTemp + ':' + qMass + ':' + variant
    }
}

/**
 * The bucketed profile of a black hole.
 *
 * Composition is dropped entirely - it says nothing about a horizon, and
 * letting it into the key would regenerate the disk every time an accreting
 * hole's bookkeeping fractions twitched. What is left is the peak disk
 * temperature (which already folds in mass and accretion rate, so it is the one
 * number that sets the colour) and the Eddington ratio (which sets how bright
 * the disk is drawn at that colour). The 'blackHole:' prefix keeps the key out
 * of every other class's namespace exactly as 'star:' does, so a black hole and
 * a star can never share a cache entry however their numbers land.
 */
function textureBlackHoleProfile(raw, variants) {
    const eddington = textureEddingtonRatio(raw.mass, raw.luminosity)
    const diskTemperature = textureDiskPeakTemperature(raw.mass, raw.luminosity)
    const qTemp = Math.round(Math.log(diskTemperature) / Math.log(TEXTURE_TEMPERATURE_RATIO))
    // Half a decade per bucket, so the whole 1e-4..1 range is nine of them.
    const qEddington = Math.round(Math.log10(eddington) * 2)
    const variant = variants > 1 ? (raw.seed % variants) : 0
    return {
        classification: TEXTURE_CLASS_BLACK_HOLE,
        gas: 0,
        ice: 0,
        rock: 0,
        metal: 0,
        temperature: 0,
        mass: raw.mass,
        seed: raw.seed,
        variant: variant,
        eddington: eddington,
        diskTemperature: diskTemperature,
        key: TEXTURE_CLASS_BLACK_HOLE + ':' + qTemp + ':' + qEddington + ':' + variant
    }
}

/** Raw physics + bucket, in one call. Pure. */
function textureProfileOf(planet, options) {
    const variants = (options && options.variants > 0)
        ? Math.floor(options.variants) : TEXTURE_DEFAULT_VARIANTS
    return textureProfileFromRaw(textureRawOf(planet), variants)
}

/** The cache key alone, for callers that only want to compare. */
function textureKeyOf(planet, options) {
    return textureProfileOf(planet, options).key
}

// ============================================================================
// Palettes
// ============================================================================

/** #rrggbb -> {r,g,b} in 0..255. Tolerates rubbish and returns mid grey. */
function textureParseHex(hex) {
    if (typeof hex === 'string') {
        const text = hex.charAt(0) === '#' ? hex.slice(1) : hex
        if (text.length === 6) {
            const value = parseInt(text, 16)
            if (isFinite(value)) {
                return {
                    r: (value >> 16) & 255,
                    g: (value >> 8) & 255,
                    b: value & 255
                }
            }
        }
    }
    return { r: 136, g: 136, b: 136 }
}

/**
 * Blackbody colour in 0..255, from structure.js when it is loaded and from a
 * crude local ramp when it is not.
 */
function textureBlackbodyRgb(temperature) {
    if (typeof blackbodyColor === 'function') {
        try {
            const color = blackbodyColor(temperature)
            if (color && typeof color.r === 'number') {
                return {
                    r: textureClamp(color.r * 255, 0, 255),
                    g: textureClamp(color.g * 255, 0, 255),
                    b: textureClamp(color.b * 255, 0, 255)
                }
            }
        } catch (e) { /* fall through */ }
    }
    // Cool -> red, ~5800 K -> white, hot -> blue. Enough to not look broken.
    const t = textureClamp(textureNumber(temperature, 5772), 1000, 40000)
    const warm = textureStep(t, 1000, 6500)
    const hot = textureStep(t, 6500, 20000)
    return {
        r: textureClamp(255 - hot * 60, 0, 255),
        g: textureClamp(80 + warm * 160 + hot * 15, 0, 255),
        b: textureClamp(20 + warm * 195 + hot * 40, 0, 255)
    }
}

/**
 * Two-to-four colour ramp for a body, from what it is made of.
 *
 * Returned as flat 0..255 numbers rather than objects because the pixel loops
 * read them millions of times.
 */
function texturePaletteFor(profile) {
    const cls = profile.classification
    const ice = profile.ice
    const rock = profile.rock
    const metal = profile.metal
    const solid = rock + metal + ice

    if (cls === TEXTURE_CLASS_BLACK_HOLE) {
        // The horizon is black, and that is not a stylisation: no light leaves
        // it, so there is no colour to choose. `accent` is the accretion disk's
        // peak colour, which is the only colour a black hole actually has, and
        // it is what tints the photon ring.
        const rgb = textureBlackbodyRgb(profile.diskTemperature ||
            TEXTURE_BH_ANCHOR_TEMPERATURE)
        return {
            kind: 'blackHole',
            lowR: 0, lowG: 0, lowB: 0,
            highR: 0, highG: 0, highB: 0,
            accentR: rgb.r, accentG: rgb.g, accentB: rgb.b
        }
    }

    if (cls === TEXTURE_CLASS_STAR) {
        const rgb = textureBlackbodyRgb(profile.temperature || 5772)
        return {
            kind: 'star',
            lowR: rgb.r * 0.62, lowG: rgb.g * 0.60, lowB: rgb.b * 0.58,
            highR: textureClamp(rgb.r * 1.06, 0, 255),
            highG: textureClamp(rgb.g * 1.04, 0, 255),
            highB: textureClamp(rgb.b * 1.02, 0, 255),
            accentR: rgb.r * 0.30, accentG: rgb.g * 0.24, accentB: rgb.b * 0.22
        }
    }

    if (cls === TEXTURE_CLASS_BROWN_DWARF) {
        // Hotter L dwarfs are dull red; cooler T dwarfs go magenta-brown as
        // methane and alkali absorption eat the red end.
        const hot = textureStep(profile.temperature || 1200, 700, 2200)
        return {
            kind: 'brownDwarf',
            lowR: textureMix(26, 44, hot), lowG: textureMix(12, 16, hot), lowB: textureMix(16, 14, hot),
            highR: textureMix(96, 150, hot), highG: textureMix(46, 62, hot), highB: textureMix(44, 40, hot),
            accentR: textureMix(150, 205, hot), accentG: textureMix(76, 96, hot), accentB: textureMix(62, 56, hot)
        }
    }

    if (cls === TEXTURE_CLASS_GAS_GIANT) {
        // Ice-rich envelopes are the ice giants: methane absorbs red and the
        // planet reads blue-green. Ice-poor ones are the ammonia-cloud tans.
        const icy = textureClamp(solid > 0 ? ice / solid : 0, 0, 1) * 0.6 +
            textureClamp(ice / Math.max(1e-6, ice + profile.gas) * 2.4, 0, 1) * 0.4
        return {
            kind: 'gasGiant',
            // belts (dark, sinking, warmer)
            lowR: textureMix(142, 58, icy), lowG: textureMix(104, 104, icy), lowB: textureMix(72, 148, icy),
            // zones (bright, rising ammonia cloud tops)
            highR: textureMix(232, 148, icy), highG: textureMix(204, 200, icy), highB: textureMix(166, 226, icy),
            // vortex
            accentR: textureMix(206, 96, icy), accentG: textureMix(118, 150, icy), accentB: textureMix(88, 200, icy),
            icy: icy
        }
    }

    // Rocky bodies: the balance of iron against silicate sets the hue, and ice
    // washes the whole thing out toward white.
    const condensed = rock + metal
    const ironFraction = condensed > 0 ? metal / condensed : 0
    const iciness = solid > 0 ? textureClamp(ice / solid, 0, 1) : 0

    // silicate grey-brown -> iron dark red
    let lowR = textureMix(74, 52, ironFraction)
    let lowG = textureMix(68, 30, ironFraction)
    let lowB = textureMix(62, 26, ironFraction)
    let highR = textureMix(158, 132, ironFraction)
    let highG = textureMix(148, 84, ironFraction)
    let highB = textureMix(134, 64, ironFraction)

    // ice: bright, blue-white, and it lifts the floor as well as the ceiling
    const iceMix = textureSmooth(textureClamp(iciness * 1.15, 0, 1))
    lowR = textureMix(lowR, 150, iceMix)
    lowG = textureMix(lowG, 172, iceMix)
    lowB = textureMix(lowB, 192, iceMix)
    highR = textureMix(highR, 238, iceMix)
    highG = textureMix(highG, 245, iceMix)
    highB = textureMix(highB, 252, iceMix)

    return {
        kind: iciness > 0.45 ? 'icy' : 'rocky',
        lowR: lowR, lowG: lowG, lowB: lowB,
        highR: highR, highG: highG, highB: highB,
        accentR: textureMix(highR, 255, 0.35),
        accentG: textureMix(highG, 255, 0.35),
        accentB: textureMix(highB, 255, 0.35),
        iron: ironFraction,
        iciness: iciness
    }
}

// ============================================================================
// Canvas generation
// ============================================================================

/** A 2d canvas, or null when there is no DOM. Never throws. */
function textureCreateCanvas(width, height) {
    if (!TEXTURE_HAS_DOCUMENT) {
        return null
    }
    try {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        return canvas
    } catch (e) {
        return null
    }
}

function textureContextOf(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') {
        return null
    }
    try {
        return canvas.getContext('2d')
    } catch (e) {
        return null
    }
}

/** rgb(...) string, for the canvas draw calls. */
function textureRgba(r, g, b, a) {
    return 'rgba(' + Math.round(textureClamp(r, 0, 255)) + ',' +
        Math.round(textureClamp(g, 0, 255)) + ',' +
        Math.round(textureClamp(b, 0, 255)) + ',' + textureClamp(a, 0, 1) + ')'
}

/**
 * Draw a shape three times - at x, x - width and x + width - so anything that
 * straddles longitude 0 appears on both edges of the image and matches itself
 * across the wrap. The two off-canvas copies are clipped away for free.
 */
function textureWrapDraw(context, width, x, draw) {
    draw(x)
    draw(x - width)
    draw(x + width)
}

/**
 * Rocky and metallic bodies: a mottled, cratered surface.
 *
 * Two noise fields do the work - a low frequency one for terrain (basins,
 * highlands) and a high frequency one for regolith grain - and the craters are
 * drawn on top with the canvas API, because a crater is a sharp feature and
 * noise is bad at sharp features.
 */
function textureDrawRocky(context, width, height, profile, palette) {
    const size = width * height
    const terrain = textureNoiseField(textureScratchField(0, size), width, height,
        4, 5, 0.5, profile.seed)
    const grain = textureNoiseField(textureScratchField(1, size), width, height,
        22, 3, 0.55, profile.seed ^ 0x51ed270b)

    const image = context.createImageData(width, height)
    const data = image.data
    const iciness = palette.iciness || 0

    for (let y = 0; y < height; y++) {
        const v = (y + 0.5) / height
        // Polar caps: volatiles survive at the poles even on a body that is
        // mostly rock, so the effect is scaled by the ice fraction.
        const polar = Math.max(textureStep(v, 0.16, 0.02), textureStep(v, 0.84, 0.98)) *
            textureClamp(iciness * 1.6, 0, 0.85)
        const row = y * width
        for (let x = 0; x < width; x++) {
            const index = row + x
            let t = terrain[index]
            t = textureClamp(t * 1.25 - 0.12, 0, 1)
            const g = grain[index] - 0.5

            let r = textureMix(palette.lowR, palette.highR, t) + g * 26
            let gr = textureMix(palette.lowG, palette.highG, t) + g * 26
            let b = textureMix(palette.lowB, palette.highB, t) + g * 26

            if (polar > 0) {
                r = textureMix(r, 236, polar)
                gr = textureMix(gr, 242, polar)
                b = textureMix(b, 250, polar)
            }

            const offset = index * 4
            data[offset] = textureClamp(r, 0, 255)
            data[offset + 1] = textureClamp(gr, 0, 255)
            data[offset + 2] = textureClamp(b, 0, 255)
            data[offset + 3] = 255
        }
    }
    context.putImageData(image, 0, 0)

    // Craters. Small bodies never resurfaced, so they are saturated with them;
    // a planet-mass body has had its record partly erased.
    const random = textureRandom(profile.seed ^ 0x2f1c7b3d)
    const heavy = profile.classification === TEXTURE_CLASS_ASTEROID ? 1 : 0.45
    const count = Math.round((18 + random() * 26) * heavy + 6)

    for (let i = 0; i < count; i++) {
        const cx = random() * width
        const v = random()
        const cy = v * height
        // Equirectangular stretches longitude near the poles; widening the
        // crater by 1/sin(latitude) keeps it round once it is on the sphere.
        const latitude = Math.max(0.18, Math.sin(v * Math.PI))
        const radius = (0.012 + random() * random() * 0.055) * width
        const stretch = 1 / latitude
        const depth = 0.18 + random() * 0.3

        textureWrapDraw(context, width, cx, function (x) {
            context.save()
            context.translate(x, cy)
            context.scale(stretch, 1)
            const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radius)
            gradient.addColorStop(0, textureRgba(palette.lowR, palette.lowG, palette.lowB, depth))
            gradient.addColorStop(0.62, textureRgba(palette.lowR, palette.lowG, palette.lowB, depth * 0.5))
            gradient.addColorStop(0.82, textureRgba(palette.accentR, palette.accentG, palette.accentB, depth * 0.9))
            gradient.addColorStop(1, textureRgba(palette.accentR, palette.accentG, palette.accentB, 0))
            context.fillStyle = gradient
            context.beginPath()
            context.arc(0, 0, radius, 0, Math.PI * 2)
            context.fill()
            context.restore()
        })
    }
}

/**
 * Icy bodies: high albedo, low contrast, and a network of fractures - the
 * signature of a brittle shell over something that flexed (Europa, Enceladus).
 */
function textureDrawIcy(context, width, height, profile, palette) {
    const size = width * height
    const mottle = textureNoiseField(textureScratchField(0, size), width, height,
        3, 4, 0.55, profile.seed)
    const frost = textureNoiseField(textureScratchField(1, size), width, height,
        16, 3, 0.5, profile.seed ^ 0x7a2b91c5)

    const image = context.createImageData(width, height)
    const data = image.data

    for (let y = 0; y < height; y++) {
        const row = y * width
        for (let x = 0; x < width; x++) {
            const index = row + x
            const t = textureClamp(mottle[index] * 0.7 + frost[index] * 0.3, 0, 1)
            const offset = index * 4
            data[offset] = textureClamp(textureMix(palette.lowR, palette.highR, t), 0, 255)
            data[offset + 1] = textureClamp(textureMix(palette.lowG, palette.highG, t), 0, 255)
            data[offset + 2] = textureClamp(textureMix(palette.lowB, palette.highB, t), 0, 255)
            data[offset + 3] = 255
        }
    }
    context.putImageData(image, 0, 0)

    // Fractures: wandering polylines. Each is drawn wrapped, so one that runs
    // off the right edge continues on the left.
    const random = textureRandom(profile.seed ^ 0x13579bdf)
    const count = 8 + Math.round(random() * 10)
    context.lineCap = 'round'

    for (let i = 0; i < count; i++) {
        const startX = random() * width
        const startY = random() * height
        const angle = random() * Math.PI * 2
        const steps = 14 + Math.round(random() * 22)
        const stepLength = width * 0.02
        const wobble = 0.35
        // Precompute the path once so all three wrapped copies are identical.
        const points = [0, 0]
        let px = 0
        let py = 0
        let heading = angle
        for (let s = 0; s < steps; s++) {
            heading += (random() - 0.5) * wobble
            px += Math.cos(heading) * stepLength
            py += Math.sin(heading) * stepLength * 0.6
            points.push(px, py)
        }

        const dark = textureRgba(palette.lowR * 0.75, palette.lowG * 0.8, palette.lowB * 0.95, 0.5)
        const bright = textureRgba(250, 252, 255, 0.42)

        textureWrapDraw(context, width, startX, function (x) {
            context.save()
            context.translate(x, startY)
            context.beginPath()
            context.moveTo(points[0], points[1])
            for (let p = 2; p < points.length; p += 2) {
                context.lineTo(points[p], points[p + 1])
            }
            context.strokeStyle = dark
            context.lineWidth = 1.6 + random() * 1.6
            context.stroke()
            context.strokeStyle = bright
            context.lineWidth = 0.7
            context.stroke()
            context.restore()
        })
    }
}

/**
 * Gas giants: zonal bands.
 *
 * The banding is not decoration. A rapidly rotating fluid planet cannot
 * transport heat across latitude freely - the Coriolis force organises the flow
 * into alternating jets, and each jet is a belt (sinking, dark, warm) or a zone
 * (rising ammonia cloud tops, bright). So latitude, and only latitude, sets the
 * base colour; everything else is turbulence smeared along the jets.
 *
 * Two details make it read as fluid rather than as stripes:
 *   - the latitude coordinate is displaced by noise before the band function is
 *     evaluated, so the jets wobble and occasionally pinch off;
 *   - the displacement is strongly anisotropic (much larger along longitude
 *     than across latitude), which is what shear does to a passive tracer.
 */
function textureDrawGasGiant(context, width, height, profile, palette) {
    const size = width * height
    const swirl = textureNoiseField(textureScratchField(0, size), width, height,
        5, 4, 0.55, profile.seed)
    const fine = textureNoiseField(textureScratchField(1, size), width, height,
        14, 3, 0.5, profile.seed ^ 0x6c8e37a1)

    const random = textureRandom(profile.seed ^ 0x0a1b2c3d)
    // Jet count scales with rotation in reality; here it is a stable per-body
    // choice in a plausible range (Jupiter has of order a dozen).
    const jets = 7 + Math.floor(random() * 8)
    const phase = random() * Math.PI * 2
    const secondary = 0.35 + random() * 0.3

    const image = context.createImageData(width, height)
    const data = image.data

    for (let y = 0; y < height; y++) {
        const v = (y + 0.5) / height
        const latitude = (v - 0.5) * Math.PI
        // Jets crowd toward the equator on a real giant; sin() spacing does the
        // same thing here.
        const polar = Math.abs(v - 0.5) * 2
        const row = y * width
        for (let x = 0; x < width; x++) {
            const index = row + x
            const displaced = latitude +
                (swirl[index] - 0.5) * 0.16 +
                (fine[index] - 0.5) * 0.035

            let band = textureSin(displaced * jets + phase) * 0.5 + 0.5
            band = textureMix(band,
                textureSin(displaced * jets * 2.13 + phase * 1.7) * 0.5 + 0.5, secondary)
            band = textureSmooth(textureClamp(band * 1.18 - 0.09, 0, 1))

            let r = textureMix(palette.lowR, palette.highR, band)
            let g = textureMix(palette.lowG, palette.highG, band)
            let b = textureMix(palette.lowB, palette.highB, band)

            // Cloud-top texture within the jet.
            const detail = (fine[index] - 0.5) * 22
            r += detail
            g += detail
            b += detail * 0.8

            // Polar hood: less insolation, deeper haze.
            const hood = textureStep(polar, 0.72, 1) * 0.42
            r = textureMix(r, r * 0.62, hood)
            g = textureMix(g, g * 0.66, hood)
            b = textureMix(b, b * 0.78, hood)

            const offset = index * 4
            data[offset] = textureClamp(r, 0, 255)
            data[offset + 1] = textureClamp(g, 0, 255)
            data[offset + 2] = textureClamp(b, 0, 255)
            data[offset + 3] = 255
        }
    }
    context.putImageData(image, 0, 0)

    // A long-lived vortex - the Great Red Spot is one - sitting inside a jet
    // rather than across it, so it is much wider than it is tall.
    const spots = 1 + (random() < 0.35 ? 1 : 0)
    for (let i = 0; i < spots; i++) {
        const cx = random() * width
        const cy = height * (0.28 + random() * 0.44)
        const radius = width * (0.045 + random() * 0.05) / (i + 1)
        const stretch = 1.9 + random() * 1.1
        const alpha = 0.55 + random() * 0.3

        textureWrapDraw(context, width, cx, function (x) {
            context.save()
            context.translate(x, cy)
            context.scale(stretch, 1)
            const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radius)
            gradient.addColorStop(0, textureRgba(palette.accentR, palette.accentG, palette.accentB, alpha))
            gradient.addColorStop(0.55, textureRgba(palette.accentR, palette.accentG, palette.accentB, alpha * 0.7))
            gradient.addColorStop(0.8, textureRgba(palette.highR, palette.highG, palette.highB, alpha * 0.35))
            gradient.addColorStop(1, textureRgba(palette.highR, palette.highG, palette.highB, 0))
            context.fillStyle = gradient
            context.beginPath()
            context.arc(0, 0, radius, 0, Math.PI * 2)
            context.fill()
            context.restore()
        })
    }
}

/**
 * Brown dwarfs: dim, patchy silicate and iron cloud decks over a deep red
 * photosphere. Variability from exactly this kind of patchiness is one of the
 * few things actually observed on L/T dwarfs.
 */
function textureDrawBrownDwarf(context, width, height, profile, palette) {
    const size = width * height
    const deck = textureNoiseField(textureScratchField(0, size), width, height,
        4, 5, 0.58, profile.seed)
    const holes = textureNoiseField(textureScratchField(1, size), width, height,
        9, 3, 0.5, profile.seed ^ 0x3c9ba7f1)

    const image = context.createImageData(width, height)
    const data = image.data

    for (let y = 0; y < height; y++) {
        const v = (y + 0.5) / height
        const banding = textureSin((v - 0.5) * Math.PI * 5) * 0.12 + 0.5
        const row = y * width
        for (let x = 0; x < width; x++) {
            const index = row + x
            // Patchy: push the cloud field through a threshold so the deck
            // breaks up into holes instead of fading smoothly.
            const cloud = textureSmooth(textureClamp((deck[index] - 0.34) * 2.6, 0, 1))
            const clear = textureSmooth(textureClamp((holes[index] - 0.55) * 3.2, 0, 1))
            const t = textureClamp(cloud * banding * 1.6 - clear * 0.55, 0, 1)

            const offset = index * 4
            data[offset] = textureClamp(textureMix(palette.lowR, palette.highR, t), 0, 255)
            data[offset + 1] = textureClamp(textureMix(palette.lowG, palette.highG, t), 0, 255)
            data[offset + 2] = textureClamp(textureMix(palette.lowB, palette.highB, t), 0, 255)
            data[offset + 3] = 255
        }
    }
    context.putImageData(image, 0, 0)
}

/**
 * Stars: granulation.
 *
 * The photosphere is the top of a convection zone, so it is tiled with
 * granules - hot gas rising in the middle of a cell, cooling and sinking in the
 * dark lanes between. That is a cellular pattern, which is why the noise here
 * runs at high frequency and is pushed to high contrast at the lanes.
 *
 * LIMB DARKENING IS NOT IN THIS TEXTURE, and cannot be: it depends on the angle
 * between the surface normal and the viewer, which a texture does not know.
 * BodyTextureLibrary.applyLimbDarkening() adds it to the material instead.
 */
function textureDrawStar(context, width, height, profile, palette) {
    const size = width * height
    const granules = textureNoiseField(textureScratchField(0, size), width, height,
        30, 3, 0.5, profile.seed)
    const supergranules = textureNoiseField(textureScratchField(1, size), width, height,
        7, 2, 0.5, profile.seed ^ 0x5bd1e995)

    const image = context.createImageData(width, height)
    const data = image.data

    for (let y = 0; y < height; y++) {
        const row = y * width
        for (let x = 0; x < width; x++) {
            const index = row + x
            // Sharpen: granule interiors are broad and bright, the intergranular
            // lanes are narrow and dark.
            const cell = textureSmooth(textureClamp((granules[index] - 0.42) * 2.2, 0, 1))
            const broad = supergranules[index] - 0.5
            const t = textureClamp(cell * 0.82 + 0.18 + broad * 0.22, 0, 1)

            const offset = index * 4
            data[offset] = textureClamp(textureMix(palette.lowR, palette.highR, t), 0, 255)
            data[offset + 1] = textureClamp(textureMix(palette.lowG, palette.highG, t), 0, 255)
            data[offset + 2] = textureClamp(textureMix(palette.lowB, palette.highB, t), 0, 255)
            data[offset + 3] = 255
        }
    }
    context.putImageData(image, 0, 0)

    // Starspots: cool magnetic regions. Common on cool stars, essentially
    // absent on hot ones, so gate on temperature.
    const spotting = 1 - textureStep(profile.temperature || 5772, 4200, 7500)
    if (spotting > 0.02) {
        const random = textureRandom(profile.seed ^ 0x1f83d9ab)
        const count = Math.round(spotting * (2 + random() * 6))
        for (let i = 0; i < count; i++) {
            const cx = random() * width
            const v = 0.2 + random() * 0.6
            const cy = v * height
            const radius = width * (0.015 + random() * 0.035)
            const stretch = 1 / Math.max(0.25, Math.sin(v * Math.PI))
            textureWrapDraw(context, width, cx, function (x) {
                context.save()
                context.translate(x, cy)
                context.scale(stretch, 1)
                const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radius)
                gradient.addColorStop(0, textureRgba(palette.accentR, palette.accentG, palette.accentB, 0.85))
                gradient.addColorStop(0.5, textureRgba(palette.accentR, palette.accentG, palette.accentB, 0.6))
                gradient.addColorStop(1, textureRgba(palette.lowR, palette.lowG, palette.lowB, 0))
                context.fillStyle = gradient
                context.beginPath()
                context.arc(0, 0, radius, 0, Math.PI * 2)
                context.fill()
                context.restore()
            })
        }
    }
}

/**
 * Rasterise a radially-symmetric annulus into a square RGBA image.
 *
 * RingGeometry in r147 uses PLANAR uvs - uv = (vertex.xy / outerRadius + 1)/2 -
 * not radial ones, so anything drawn on a ring has to be a square image of
 * concentric circles rather than a 1D radial strip. Ring systems and black hole
 * accretion disks are therefore literally the same problem, and this is the one
 * place it is solved: four lookup tables indexed by distance from the centre,
 * one square root and one integer index per pixel.
 *
 * `modulate`, when supplied, is (radius, dx, dy) -> multiplier on the COLOUR
 * only, and is the only thing in here allowed to depend on the angle. It is
 * null for ring systems, which keeps that path exactly as fast as it was.
 */
function textureRasterizeAnnulus(context, size, alphaLut, redLut, greenLut, blueLut, modulate) {
    const half = size / 2
    const samples = alphaLut.length
    const image = context.createImageData(size, size)
    const data = image.data

    for (let y = 0; y < size; y++) {
        const dy = (y + 0.5 - half) / half
        const dy2 = dy * dy
        const row = y * size
        for (let x = 0; x < size; x++) {
            const dx = (x + 0.5 - half) / half
            const radius = Math.sqrt(dx * dx + dy2)
            const offset = (row + x) * 4
            if (radius >= 1) {
                data[offset + 3] = 0
                continue
            }
            const index = (radius * samples) | 0
            const alpha = alphaLut[index]
            if (!(alpha > 0)) {
                data[offset + 3] = 0
                continue
            }
            const scale = modulate ? modulate(radius, dx, dy) : 1
            data[offset] = textureClamp(redLut[index] * scale, 0, 255)
            data[offset + 1] = textureClamp(greenLut[index] * scale, 0, 255)
            data[offset + 2] = textureClamp(blueLut[index] * scale, 0, 255)
            data[offset + 3] = alpha * 255
        }
    }
    context.putImageData(image, 0, 0)
}

/**
 * Ring system texture. The alpha channel carries the gaps.
 */
function textureDrawRings(context, size, profile, palette, innerFraction) {
    const random = textureRandom(profile.seed ^ 0x2c9277b5)

    // A handful of ringlet groups: centre, width, opacity.
    const groups = 5 + Math.floor(random() * 6)
    const centres = []
    const widths = []
    const strengths = []
    for (let i = 0; i < groups; i++) {
        centres.push(innerFraction + random() * (1 - innerFraction))
        widths.push(0.012 + random() * 0.08)
        strengths.push(0.25 + random() * 0.75)
    }

    // The ring is radially symmetric, so its whole appearance is a function of
    // one variable. Build it once and let the rasteriser do lookups.
    const samples = TEXTURE_ANNULUS_SAMPLES
    const alpha = new Float32Array(samples)
    const red = new Float32Array(samples)
    const green = new Float32Array(samples)
    const blue = new Float32Array(samples)

    for (let i = 0; i < samples; i++) {
        const radius = (i + 0.5) / samples
        if (radius < innerFraction || radius > 1) {
            continue
        }
        let density = 0.22
        for (let g = 0; g < groups; g++) {
            const d = (radius - centres[g]) / widths[g]
            density += strengths[g] * Math.exp(-d * d * 3)
        }
        // Fine ringlets on top of the groups.
        density *= 0.78 + 0.22 * textureSin(radius * 260 + (profile.seed % 17))
        // Fade at both edges so the ring does not end on a hard line.
        density *= textureStep(radius, innerFraction, innerFraction + 0.06) *
            (1 - textureStep(radius, 0.9, 1))
        const value = textureClamp(density, 0, 1)
        if (!(value > 0)) {
            continue
        }
        const shade = 0.55 + 0.45 * value
        alpha[i] = value
        red[i] = textureClamp(textureMix(palette.lowR, palette.highR, shade) * 1.05, 0, 255)
        green[i] = textureClamp(textureMix(palette.lowG, palette.highG, shade) * 1.02, 0, 255)
        blue[i] = textureClamp(textureMix(palette.lowB, palette.highB, shade), 0, 255)
    }

    textureRasterizeAnnulus(context, size, alpha, red, green, blue, null)
}

/**
 * Accretion disk texture for one annulus of a black hole's disk.
 *
 * `innerFraction` is the hole in the planar uv square - inner geometry radius
 * over outer geometry radius, exactly as for a ring system - and `outerIsco` is
 * that outer geometry radius measured in ISCOs, so a texture radius q sits at
 * x = q * outerIsco in the temperature profile.
 *
 * COLOUR is the blackbody colour of the LOCAL disk temperature: hottest and
 * bluest just outside the ISCO, falling outward as roughly r^(-3/4) through
 * white and orange toward red. That is the real behaviour of a thin disk, and
 * it is the whole reason a black hole is worth drawing at all.
 *
 * BRIGHTNESS is baked into the rgb rather than carried in the alpha channel.
 * The material blends additively, and three.js's premultiplied-alpha path -
 * which is the renderer default - implements AdditiveBlending as
 * blendFunc(ONE, ONE), where the alpha channel does nothing whatsoever. Baking
 * it in is correct under both blend paths.
 *
 * The azimuthal structure is a trailing spiral plus one octave of value noise.
 * Real disks are turbulent and really do carry spiral density waves, and the
 * pitch tightens inward, which is what differential rotation does to any
 * pattern in the flow. `arms` must stay an INTEGER or the pattern tears open
 * along atan2's branch cut.
 *
 * THE TWO ANNULI HAVE TO AGREE WHERE THEY MEET. They are separate textures with
 * separate uv scales, so every radial quantity in here is computed in PHYSICAL
 * units - x, in ISCOs - rather than in texture units, and both are seeded from
 * the same profile. Do that and the temperature, the spiral and the clumping
 * are all continuous across the join; skip it and there is a visible step at
 * TEXTURE_BH_DISK_SPLIT. `fadeOuter` is there for the same reason: only the
 * OUTERMOST annulus may fade out at its rim.
 *
 * NOT MODELLED, deliberately: relativistic beaming, which brightens and blues
 * the side of the disk approaching the observer. It lives in the OBSERVER's
 * frame, so it cannot be baked into a texture that rotates with the gas; like
 * the lensing, it would need a shader.
 */
function textureDrawAccretionDisk(context, size, profile, innerFraction, outerIsco, fadeOuter) {
    const samples = TEXTURE_ANNULUS_SAMPLES
    const alpha = new Float32Array(samples)
    const red = new Float32Array(samples)
    const green = new Float32Array(samples)
    const blue = new Float32Array(samples)
    // log(radius) depends on radius alone, so the spiral's radial term goes in
    // a table and the per-pixel cost is one atan2 and one noise lookup.
    const spiral = new Float32Array(samples)

    const seed = (profile && isFinite(profile.seed)) ? (profile.seed | 0) : 0
    const peak = textureClamp(textureNumber(profile && profile.diskTemperature,
        TEXTURE_BH_ANCHOR_TEMPERATURE), TEXTURE_BH_MIN_TEMPERATURE,
        TEXTURE_BH_MAX_TEMPERATURE)
    const eddington = textureClamp(textureNumber(profile && profile.eddington,
        TEXTURE_BH_DEFAULT_EDDINGTON), TEXTURE_BH_MIN_EDDINGTON, 1)
    // An actively feeding hole is drawn brighter. The quarter power is the same
    // one that set the temperature, so a disk that turns blue also turns up.
    const gain = TEXTURE_BH_DISK_GAIN * textureClamp(
        Math.pow(eddington / TEXTURE_BH_DEFAULT_EDDINGTON, 0.25), 0.45, 1.35) / 255

    const random = textureRandom(seed ^ 0x6ba1c3e7)
    const arms = 2 + Math.floor(random() * 2)
    const phase = random() * Math.PI * 2
    const pitch = -(2.6 + random() * 1.8)
    const clumpFrequency = 0.9 + random() * 0.6
    const clumpSeed = (seed ^ 0x1d2e3f40) | 0

    for (let i = 0; i < samples; i++) {
        const q = (i + 0.5) / samples
        const x = q * outerIsco
        spiral[i] = pitch * Math.log(x > 1e-6 ? x : 1e-6)
        if (q < innerFraction || q > 1) {
            continue
        }
        const shape = textureDiskTemperatureShape(x)
        if (!(shape > 0)) {
            continue
        }
        const rgb = textureBlackbodyRgb(peak * shape)
        // Surface brightness goes as T^4, which is far too steep to survive an
        // 8-bit texture - it would leave one bright line and nothing else. The
        // square keeps the inner disk clearly dominant without erasing
        // everything past a couple of ISCOs.
        let brightness = shape * shape * gain
        // Fade the outer rim so the disk does not end on a drawn circle - but
        // only where the disk actually ends, or the join tears open.
        if (fadeOuter) {
            brightness *= 1 - textureStep(q, 0.88, 1)
        }
        if (!(brightness > 0)) {
            continue
        }
        red[i] = rgb.r * brightness
        green[i] = rgb.g * brightness
        blue[i] = rgb.b * brightness
        alpha[i] = 1
    }

    textureRasterizeAnnulus(context, size, alpha, red, green, blue,
        function (radius, dx, dy) {
            const index = (radius * samples) | 0
            const arm = textureSin(arms * Math.atan2(dy, dx) + spiral[index] + phase) *
                0.5 + 0.5
            // Physical coordinates again, so both annuli sample one noise field.
            const scale = clumpFrequency * outerIsco
            const clump = textureValueNoise3(dx * scale, dy * scale,
                radius * outerIsco * 0.5, clumpSeed)
            return textureClamp(0.58 + 0.5 * arm + 0.34 * (clump - 0.5), 0, 1.45)
        })
}

/**
 * The photon ring.
 *
 * THIS IS A SUGGESTION OF GRAVITATIONAL LENSING, NOT A COMPUTATION OF IT.
 * Real lensing means integrating null geodesics per pixel in a shader, and
 * nothing in this file does that. What is drawn instead is the single feature
 * that carries almost all of the recognisability: light on orbits near the
 * photon sphere piles up into a thin bright circle at sqrt(27)/2 R_s, and that
 * circle is the rim of the black shadow. A gaussian band of additive light at
 * exactly that radius, sitting on the edge of a dark halo that eats the
 * background, reads as a lensed black hole and costs one small texture and one
 * draw call. It does not bend anything, and it never claims to.
 */
function textureDrawPhotonRing(context, size, palette) {
    const samples = TEXTURE_ANNULUS_SAMPLES
    const alpha = new Float32Array(samples)
    const red = new Float32Array(samples)
    const green = new Float32Array(samples)
    const blue = new Float32Array(samples)

    const centre = TEXTURE_BH_SHADOW_RADIUS / TEXTURE_BH_PHOTON_OUTER
    const width = TEXTURE_BH_PHOTON_WIDTH
    // Brightened well past the disk's own colour: the ring is light that has
    // been round the hole and is blueshifted on the way out.
    const r = textureMix(textureNumber(palette && palette.accentR, 255), 255, 0.45)
    const g = textureMix(textureNumber(palette && palette.accentG, 255), 255, 0.45)
    const b = textureMix(textureNumber(palette && palette.accentB, 255), 255, 0.5)

    for (let i = 0; i < samples; i++) {
        const q = (i + 0.5) / samples
        if (q > 1) {
            continue
        }
        const d = (q - centre) / width
        const band = Math.exp(-d * d) * TEXTURE_BH_PHOTON_BRIGHTNESS
        if (!(band > 0.004)) {
            continue
        }
        alpha[i] = 1
        red[i] = r * band
        green[i] = g * band
        blue[i] = b * band
    }

    textureRasterizeAnnulus(context, size, alpha, red, green, blue, null)
}

// ============================================================================
// BodyTextureLibrary
// ============================================================================

/**
 * Cached procedural textures and materials, keyed by what a body is rather than
 * by which body it is, so hundreds of bodies share a handful of textures.
 *
 * Options (all optional):
 *   size        {number}  texture width in px, height is half. Default 512.
 *   maxEntries  {number}  LRU bound on cached textures. Default 48 (~33 MB at 512).
 *   variants    {number}  distinct looks per (class, composition) bucket. Default 6.
 *   anisotropy  {number}  texture anisotropy, clamped by THREE. Default 4.
 *   rings       {boolean} generate ring textures at all. Default true.
 *   limbDarkening {boolean} inject limb darkening into star materials. Default true.
 */
class BodyTextureLibrary {

    constructor(options) {
        const config = options || {}

        this.size = (config.size > 0) ? Math.floor(config.size) : TEXTURE_DEFAULT_SIZE
        this.height = Math.max(8, Math.floor(this.size / 2))
        this.maxEntries = (config.maxEntries > 0)
            ? Math.floor(config.maxEntries) : TEXTURE_DEFAULT_MAX_ENTRIES
        this.variants = (config.variants > 0)
            ? Math.floor(config.variants) : TEXTURE_DEFAULT_VARIANTS
        this.anisotropy = (config.anisotropy > 0) ? config.anisotropy : 4
        this.ringsEnabled = config.rings !== false
        this.limbDarkeningEnabled = config.limbDarkening !== false

        // key -> {texture, material, ringTexture, used}
        this.entries = new Map()
        // planet.id -> {raw, profile}. Keeps a body on the texture it already
        // has until its physics genuinely moves; see textureRawStable.
        this.profiles = new Map()
        this.profileLimit = (config.profileLimit > 0)
            ? Math.floor(config.profileLimit) : 2048
        // Monotonic counter used as the LRU stamp. Cheaper than Date.now().
        this.clock = 0
        // Diagnostics, read by the tests and worth logging once in a browser.
        this.stats = { generated: 0, evicted: 0, hits: 0, misses: 0, totalMs: 0 }

        this.available = TEXTURE_HAS_DOCUMENT && textureHasThree()
    }

    // ------------------------------------------------------------------ query

    /** The cache key a body would use. Safe without a DOM or THREE. */
    keyFor(planet) {
        return this.profileFor(planet).key
    }

    /**
     * The bucketed profile of a body, memoised per planet.id so that a value
     * jittering across a bucket edge does not regenerate a texture every frame.
     */
    profileFor(planet) {
        const id = (planet && typeof planet.id === 'number' && isFinite(planet.id))
            ? planet.id : null
        const raw = textureRawOf(planet)
        if (id === null) {
            return textureProfileFromRaw(raw, this.variants)
        }
        const memo = this.profiles.get(id)
        if (memo && textureRawStable(memo.raw, raw)) {
            return memo.profile
        }
        const profile = textureProfileFromRaw(raw, this.variants)
        if (this.profiles.size >= this.profileLimit) {
            // Ids only ever grow, so the map is mostly dead bodies by now.
            this.profiles.clear()
        }
        this.profiles.set(id, { raw: raw, profile: profile })
        return profile
    }

    /** True when this body's texture already exists, i.e. materialFor is free. */
    isReady(planet) {
        return this.entries.has(this.keyFor(planet))
    }

    // ------------------------------------------------------------- generation

    /**
     * Material for a body: cached, ready to use, never null unless THREE or the
     * DOM is missing (then null, and the caller should fall back to a flat
     * colour). Generating one costs a few milliseconds; see isReady().
     */
    materialFor(planet) {
        const entry = this._entryFor(planet)
        return entry ? entry.material : null
    }

    /** Texture for a body. Same caching, same null contract. */
    textureFor(planet) {
        const entry = this._entryFor(planet)
        return entry ? entry.texture : null
    }

    /**
     * Ring texture for a body, or null. Only gas giants and brown dwarfs get
     * one, and only when their seed says so - rings are common but not
     * universal, and a ring on every giant reads as a gimmick.
     */
    ringTextureFor(planet) {
        if (!this.ringsEnabled) {
            return null
        }
        const entry = this._entryFor(planet)
        if (!entry || !entry.profile) {
            return null
        }
        if (!textureBodyHasRings(entry.profile)) {
            return null
        }
        if (entry.ringTexture === undefined) {
            entry.ringTexture = this._generateRingTexture(entry.profile)
        }
        return entry.ringTexture
    }

    /** Whether this body should be drawn with a ring system. Pure. */
    hasRings(planet) {
        return this.ringsEnabled && textureBodyHasRings(this.profileFor(planet))
    }

    /** Whether this body is a black hole. Pure, and safe without THREE. */
    isBlackHole(planet) {
        return textureIsBlackHole(planet)
    }

    /**
     * Everything needed to draw a black hole's accretion disk, photon ring and
     * shadow, or null for anything that is not a black hole.
     *
     * Returns the cached, shared materials - never copies - so a hundred black
     * holes in the same bucket cost one set. DetailBodyPool owns the geometry;
     * this owns the pixels.
     *
     *   {innerMaterial, outerMaterial, photonMaterial, innerSpin, outerSpin}
     *
     * innerSpin / outerSpin are angular rates in rad/s, and their ratio is the
     * genuine Keplerian one for the two annuli.
     */
    accretionDiskFor(planet) {
        if (!textureIsBlackHole(planet)) {
            return null
        }
        const entry = this._entryFor(planet)
        return (entry && entry.disk) ? entry.disk : null
    }

    _entryFor(planet) {
        if (!this.available) {
            return null
        }
        const profile = this.profileFor(planet)
        const existing = this.entries.get(profile.key)
        if (existing) {
            existing.used = ++this.clock
            this.stats.hits++
            return existing
        }
        this.stats.misses++

        const entry = this._generate(profile)
        if (!entry) {
            return null
        }
        entry.used = ++this.clock
        this.entries.set(profile.key, entry)
        this._evict()
        return entry
    }

    /** Build one texture + material pair. Returns null on any failure. */
    _generate(profile) {
        if (profile.classification === TEXTURE_CLASS_BLACK_HOLE) {
            return this._generateBlackHole(profile)
        }
        const width = this.size
        const height = this.height
        const canvas = textureCreateCanvas(width, height)
        const context = textureContextOf(canvas)
        if (!context) {
            // A DOM that will not give us a 2d context is not going to start
            // working later; stop trying.
            this.available = false
            return null
        }

        const started = textureNow()
        const palette = texturePaletteFor(profile)

        try {
            switch (profile.classification) {
                case TEXTURE_CLASS_STAR:
                    textureDrawStar(context, width, height, profile, palette)
                    break
                case TEXTURE_CLASS_BROWN_DWARF:
                    textureDrawBrownDwarf(context, width, height, profile, palette)
                    break
                case TEXTURE_CLASS_GAS_GIANT:
                    textureDrawGasGiant(context, width, height, profile, palette)
                    break
                default:
                    if (palette.kind === 'icy') {
                        textureDrawIcy(context, width, height, profile, palette)
                    } else {
                        textureDrawRocky(context, width, height, profile, palette)
                    }
                    break
            }
        } catch (e) {
            // A broken generator must not take the frame with it. The canvas
            // keeps whatever was drawn before the throw.
            if (typeof console !== 'undefined' && console.error) {
                console.error('textures: geração falhou', e)
            }
        }

        const texture = this._wrapTexture(canvas)
        if (!texture) {
            return null
        }

        const material = this._materialFor(profile, palette, texture)
        this.stats.generated++
        this.stats.totalMs += textureNow() - started

        return {
            profile: profile,
            palette: palette,
            texture: texture,
            material: material,
            ringTexture: undefined,
            used: 0
        }
    }

    /**
     * Canvas -> THREE.CanvasTexture with the right wrapping.
     *
     * wrapS is RepeatWrapping because longitude is periodic: with the noise
     * already periodic in u (see textureNoiseField), this makes the hardware
     * filter across the seam too, so even the mipmap levels match.
     * wrapT is ClampToEdge because latitude is NOT periodic - repeating it
     * would fold the north pole onto the south.
     */
    _wrapTexture(canvas) {
        try {
            const texture = new THREE.CanvasTexture(canvas)
            texture.wrapS = THREE.RepeatWrapping
            texture.wrapT = THREE.ClampToEdgeWrapping
            texture.anisotropy = this.anisotropy
            texture.generateMipmaps = true
            if (THREE.sRGBEncoding !== undefined) {
                // The canvas holds sRGB values and the renderer's
                // outputEncoding is sRGB, so this has to be declared or every
                // texture comes out washed out.
                texture.encoding = THREE.sRGBEncoding
            }
            texture.needsUpdate = true
            return texture
        } catch (e) {
            return null
        }
    }

    _materialFor(profile, palette, texture) {
        try {
            if (profile.classification === TEXTURE_CLASS_STAR) {
                // Self-luminous: a star is not lit by anything, so Basic, and
                // out of the tone mapping so it can read as blown out.
                const material = new THREE.MeshBasicMaterial({
                    map: texture,
                    fog: false,
                    toneMapped: false
                })
                if (this.limbDarkeningEnabled) {
                    this.applyLimbDarkening(material)
                }
                return material
            }

            if (profile.classification === TEXTURE_CLASS_BROWN_DWARF) {
                // Faintly self-luminous: mostly its own dim glow, but still
                // catching light from a nearby star.
                const material = new THREE.MeshLambertMaterial({
                    map: texture,
                    emissiveMap: texture,
                    fog: false
                })
                material.emissive = new THREE.Color(0xffffff)
                material.emissiveIntensity = 0.45
                return material
            }

            return new THREE.MeshLambertMaterial({ map: texture, fog: false })
        } catch (e) {
            return null
        }
    }

    /**
     * Build a black hole's cache entry.
     *
     * There is no body texture in the usual sense and there cannot be: an event
     * horizon has no surface, so there is nothing for an equirectangular map to
     * be a map OF. The 8x8 black canvas exists only so textureFor() keeps its
     * contract of returning a texture wherever materialFor() returns a
     * material; the material itself carries no map at all, because the honest
     * answer for a horizon is an unlit, untinted, pure black surface.
     */
    _generateBlackHole(profile) {
        const started = textureNow()
        const palette = texturePaletteFor(profile)
        const canvas = textureCreateCanvas(8, 8)
        const context = textureContextOf(canvas)
        if (!context) {
            this.available = false
            return null
        }
        try {
            const image = context.createImageData(8, 8)
            const data = image.data
            for (let i = 0; i < data.length; i += 4) {
                data[i + 3] = 255
            }
            context.putImageData(image, 0, 0)
        } catch (e) { /* a canvas that stayed transparent is still not white */ }

        let texture = null
        let material = null
        try {
            texture = new THREE.CanvasTexture(canvas)
            texture.needsUpdate = true
            // Basic, not Lambert: the scene's point light must not be able to
            // put a highlight on an event horizon. Out of the tone mapping too,
            // so no exposure curve can lift it off zero.
            material = new THREE.MeshBasicMaterial({
                color: 0x000000,
                fog: false,
                toneMapped: false
            })
        } catch (e) {
            return null
        }

        const disk = this._generateAccretionDisk(profile, palette)
        this.stats.generated++
        this.stats.totalMs += textureNow() - started

        return {
            profile: profile,
            palette: palette,
            texture: texture,
            material: material,
            // A black hole never carries a ring system; textureBodyHasRings
            // already says so, this makes it explicit for the disposer.
            ringTexture: null,
            disk: disk,
            used: 0
        }
    }

    /**
     * The three additive layers around the horizon: two disk annuli and the
     * photon ring. Null if any of them cannot be built, so the caller falls
     * back to a bare black sphere rather than to half a black hole.
     */
    _generateAccretionDisk(profile, palette) {
        const size = Math.max(128, Math.min(256, this.size))
        const inner = this._diskTexture(profile, size,
            TEXTURE_BH_ISCO / TEXTURE_BH_DISK_SPLIT,
            TEXTURE_BH_DISK_SPLIT / TEXTURE_BH_ISCO, false)
        const outer = this._diskTexture(profile, size,
            TEXTURE_BH_DISK_SPLIT / TEXTURE_BH_DISK_OUTER,
            TEXTURE_BH_DISK_OUTER / TEXTURE_BH_ISCO, true)
        const photon = this._photonTexture(palette, Math.min(128, size))

        if (!inner || !outer || !photon) {
            textureDisposeAll([inner, outer, photon])
            return null
        }
        const innerMaterial = this._additiveMaterial(inner)
        const outerMaterial = this._additiveMaterial(outer)
        const photonMaterial = this._additiveMaterial(photon)
        if (!innerMaterial || !outerMaterial || !photonMaterial) {
            textureDisposeAll([inner, outer, photon, innerMaterial, outerMaterial,
                photonMaterial])
            return null
        }
        return {
            innerTexture: inner,
            outerTexture: outer,
            photonTexture: photon,
            innerMaterial: innerMaterial,
            outerMaterial: outerMaterial,
            photonMaterial: photonMaterial,
            // Keplerian: omega ~ r^(-3/2) at each annulus' mid-radius, so the
            // inner ring really does lap the outer one, by a factor of ~3.5.
            innerSpin: TEXTURE_BH_INNER_SPIN,
            outerSpin: TEXTURE_BH_OUTER_SPIN
        }
    }

    _diskTexture(profile, size, innerFraction, outerIsco, fadeOuter) {
        const canvas = textureCreateCanvas(size, size)
        const context = textureContextOf(canvas)
        if (!context) {
            return null
        }
        try {
            textureDrawAccretionDisk(context, size, profile, innerFraction, outerIsco,
                fadeOuter)
        } catch (e) {
            if (typeof console !== 'undefined' && console.error) {
                console.error('textures: disco de acreção falhou', e)
            }
            return null
        }
        return this._planarTexture(canvas)
    }

    _photonTexture(palette, size) {
        const canvas = textureCreateCanvas(size, size)
        const context = textureContextOf(canvas)
        if (!context) {
            return null
        }
        try {
            textureDrawPhotonRing(context, size, palette)
        } catch (e) {
            return null
        }
        return this._planarTexture(canvas)
    }

    /** Canvas -> CanvasTexture for a planar (ring/disk) uv layout. */
    _planarTexture(canvas) {
        try {
            const texture = new THREE.CanvasTexture(canvas)
            // Planar uvs never leave 0..1, so clamping is right on both axes.
            texture.wrapS = THREE.ClampToEdgeWrapping
            texture.wrapT = THREE.ClampToEdgeWrapping
            texture.anisotropy = this.anisotropy
            if (THREE.sRGBEncoding !== undefined) {
                texture.encoding = THREE.sRGBEncoding
            }
            texture.needsUpdate = true
            return texture
        } catch (e) {
            return null
        }
    }

    /**
     * Unlit additive material for one of the glowing layers.
     *
     * depthWrite is off because these are transparent and overlap each other;
     * depth TEST stays on so the horizon sphere still occludes the far side of
     * the disk, which is the one bit of occlusion that has to be right.
     */
    _additiveMaterial(texture) {
        try {
            const parameters = {
                map: texture,
                transparent: true,
                side: THREE.DoubleSide,
                depthWrite: false,
                fog: false,
                toneMapped: false
            }
            if (THREE.AdditiveBlending !== undefined) {
                parameters.blending = THREE.AdditiveBlending
            }
            return new THREE.MeshBasicMaterial(parameters)
        } catch (e) {
            return null
        }
    }

    _generateRingTexture(profile) {
        if (!this.available) {
            return null
        }
        // Capped at 256: a ring texture is a planar square whose useful area is
        // one thin annulus, so it buys nothing from being large, and it is
        // generated in the same frame as the body texture it accompanies.
        const size = Math.max(128, Math.min(256, this.size))
        const canvas = textureCreateCanvas(size, size)
        const context = textureContextOf(canvas)
        if (!context) {
            return null
        }
        try {
            textureDrawRings(context, size, profile, texturePaletteFor(profile),
                TEXTURE_RING_INNER)
        } catch (e) {
            return null
        }
        return this._planarTexture(canvas)
    }

    /**
     * Add limb darkening to a material.
     *
     * A star is dimmer at its edge because a line of sight that grazes the limb
     * leaves the photosphere higher up, where the gas is cooler. The standard
     * linear law is I(mu)/I(1) = 1 - u*(1 - mu), with mu the cosine of the
     * angle between the surface normal and the line of sight. That is a
     * view-dependent quantity, so it cannot live in a texture; it is injected
     * into the compiled shader instead.
     *
     * The injection is deliberately minimal: two varyings, one multiply, and it
     * refuses to touch the shader at all if the chunks it expects are not there,
     * so a future three.js cannot silently produce a black star.
     *
     * Returns true if it was applied.
     */
    applyLimbDarkening(material) {
        if (!material || typeof material !== 'object') {
            return false
        }
        const strength = TEXTURE_LIMB_DARKENING.toFixed(3)
        try {
            material.onBeforeCompile = function (shader) {
                if (!shader || typeof shader.vertexShader !== 'string' ||
                    typeof shader.fragmentShader !== 'string') {
                    return
                }
                if (shader.vertexShader.indexOf('#include <begin_vertex>') === -1 ||
                    shader.fragmentShader.indexOf('#include <tonemapping_fragment>') === -1) {
                    return
                }
                shader.vertexShader = shader.vertexShader
                    .replace('#include <common>',
                        '#include <common>\nvarying vec3 vLimbNormal;\nvarying vec3 vLimbView;')
                    .replace('#include <begin_vertex>',
                        '#include <begin_vertex>\n' +
                        'vLimbNormal = normalize( normalMatrix * normal );\n' +
                        'vLimbView = ( modelViewMatrix * vec4( transformed, 1.0 ) ).xyz;')
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <common>',
                        '#include <common>\nvarying vec3 vLimbNormal;\nvarying vec3 vLimbView;')
                    .replace('#include <tonemapping_fragment>',
                        'float limbMu = clamp( dot( normalize( vLimbNormal ), ' +
                        'normalize( -vLimbView ) ), 0.0, 1.0 );\n' +
                        'gl_FragColor.rgb *= ( 1.0 - ' + strength + ' * ( 1.0 - limbMu ) );\n' +
                        '#include <tonemapping_fragment>')
            }
            material.needsUpdate = true
            return true
        } catch (e) {
            return false
        }
    }

    // ------------------------------------------------------------------ memory

    /** Drop the least recently used entries until the cache is inside bounds. */
    _evict() {
        while (this.entries.size > this.maxEntries) {
            let oldestKey = null
            let oldestUsed = Infinity
            this.entries.forEach(function (entry, key) {
                if (entry.used < oldestUsed) {
                    oldestUsed = entry.used
                    oldestKey = key
                }
            })
            if (oldestKey === null) {
                return
            }
            const entry = this.entries.get(oldestKey)
            this.entries.delete(oldestKey)
            textureDisposeEntry(entry)
            this.stats.evicted++
        }
    }

    /** Release every GPU resource this library owns. Safe to call twice. */
    dispose() {
        const entries = this.entries
        this.entries = new Map()
        this.profiles.clear()
        entries.forEach(textureDisposeEntry)
    }
}

/** Free one cache entry's GPU resources. Never throws. */
function textureDisposeEntry(entry) {
    if (!entry) {
        return
    }
    textureDisposeAll([entry.texture, entry.ringTexture, entry.material])
    const disk = entry.disk
    if (disk) {
        textureDisposeAll([disk.innerTexture, disk.outerTexture, disk.photonTexture,
            disk.innerMaterial, disk.outerMaterial, disk.photonMaterial])
        entry.disk = null
    }
}

/** dispose() everything in a list that has one, tolerating nulls. */
function textureDisposeAll(items) {
    if (!items) {
        return
    }
    for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item && typeof item.dispose === 'function') {
            try { item.dispose() } catch (e) { /* already gone */ }
        }
    }
}

/** Monotonic-ish milliseconds, wherever we are running. */
function textureNow() {
    if (typeof performance !== 'undefined' && performance &&
        typeof performance.now === 'function') {
        return performance.now()
    }
    return Date.now()
}

// Ring geometry, in body radii. Saturn's rings run from about 1.2 to 2.3 R.
const TEXTURE_RING_INNER_RADIUS = 1.45
const TEXTURE_RING_OUTER_RADIUS = 2.45
// RingGeometry's planar uvs put uv radius 1 at the OUTER edge of the ring, so
// the hole in the texture has to sit at exactly this fraction of it. Derived
// rather than written out, because getting it wrong hides the inner fade and
// leaves a hard cut where the ring meets its gap.
const TEXTURE_RING_INNER = TEXTURE_RING_INNER_RADIUS / TEXTURE_RING_OUTER_RADIUS

/**
 * Does this body carry rings? Gas giants and brown dwarfs only, and only ~40%
 * of them, decided by the seed so it never changes for a given body.
 */
function textureBodyHasRings(profile) {
    if (!profile) {
        return false
    }
    if (profile.classification !== TEXTURE_CLASS_GAS_GIANT &&
        profile.classification !== TEXTURE_CLASS_BROWN_DWARF) {
        return false
    }
    return ((profile.seed >>> 7) & 1023) < 410
}

// ============================================================================
// Level-of-detail selection (pure)
// ============================================================================

/**
 * Apparent size of a body from the camera: radius / distance, which is
 * tan(theta/2) to first order and proportional to the number of pixels it
 * covers. This is the only sane ranking - a Jupiter twenty AU away deserves
 * less detail than an asteroid you are parked next to.
 */
function textureApparentSize(radius, distance) {
    if (!(radius > 0) || !isFinite(radius)) {
        return 0
    }
    if (!(distance > 1e-9) || !isFinite(distance)) {
        return Infinity
    }
    return radius / distance
}

/**
 * Choose which candidates get a detailed mesh.
 *
 * `candidates` is an array of {score, forced, incumbent, ...}. Pure: no DOM, no
 * THREE, and deterministic. `options.length` bounds how much of the array is
 * live, so the caller can reuse one over-long scratch array every frame instead
 * of slicing a fresh one.
 *
 * HYSTERESIS. A body already detailed has its score multiplied by
 * `hysteresis` (> 1) before it is ranked, and it survives down to
 * minScore / hysteresis. Two bodies of nearly equal apparent size therefore
 * cannot trade the last slot back and forth every frame, which is exactly the
 * flicker this is here to prevent.
 */
function textureSelectDetailed(candidates, count, options) {
    const selected = []
    if (!Array.isArray(candidates) || !(count > 0)) {
        return selected
    }
    const config = options || {}
    const hysteresis = (config.hysteresis > 0) ? config.hysteresis : 1.5
    const minScore = (config.minScore >= 0) ? config.minScore : 0
    const limit = Math.floor(count)
    const length = (config.length >= 0 && config.length <= candidates.length)
        ? config.length : candidates.length

    // Forced entries (selected / followed body) come first and ignore the
    // minimum size: if the user asked to look at it, it gets detail.
    for (let i = 0; i < length && selected.length < limit; i++) {
        const candidate = candidates[i]
        if (candidate && candidate.forced) {
            if (selected.indexOf(candidate) === -1) {
                selected.push(candidate)
            }
        }
    }

    // Everything else by weighted score, kept in a small sorted array so no
    // full sort of 800 entries happens per frame.
    const ranked = []
    for (let i = 0; i < length; i++) {
        const candidate = candidates[i]
        if (!candidate || candidate.forced) {
            continue
        }
        const score = textureNumber(candidate.score, 0)
        const weight = candidate.incumbent ? score * hysteresis : score
        if (!(weight >= minScore)) {
            continue
        }
        let position = ranked.length
        while (position > 0 && ranked[position - 1].weight < weight) {
            position--
        }
        if (position >= limit) {
            continue
        }
        ranked.splice(position, 0, { candidate: candidate, weight: weight })
        if (ranked.length > limit) {
            ranked.length = limit
        }
    }

    for (let i = 0; i < ranked.length && selected.length < limit; i++) {
        selected.push(ranked[i].candidate)
    }
    return selected
}

// ============================================================================
// DetailBodyPool
// ============================================================================

/**
 * A small fixed pool of real, textured spheres, reassigned every frame to the
 * bodies that most deserve them.
 *
 * The pool never creates or destroys a mesh while it is running: slots are
 * built once and their planet, material, scale and position are swapped.
 *
 * Options:
 *   library   {BodyTextureLibrary}  required for textures; without it the pool
 *                                   still runs and draws flat-coloured spheres.
 *   count     {number}   pool size. Default 12.
 *   getCamera {Function} () => THREE.Camera, used when update() is given none.
 *   radiusOf  {Function} (planet) => drawn radius in AU. Defaults to main.js's
 *                        displayRadiusOf, then to planet.radius.
 *   segments  {number}   sphere tessellation, width segments. Default 48.
 *   minApparentSize {number} below this a body is not worth detailing. Default 0.004.
 *   hysteresis {number}  incumbency bonus. Default 1.5.
 *   generationsPerFrame {number} new textures generated per update. Default 1.
 *   rings     {boolean}  draw ring systems. Default true.
 *   blackHoles {boolean} draw accretion disks, photon rings and shadows around
 *                        black holes. Default true. With it off a black hole is
 *                        still black - it just has nothing around it.
 *   rotate    {boolean}  cosmetic spin. Default true. SEE BELOW.
 *   rotationSpeed {number} radians per second at the reference size. Default 0.25.
 *   skipStars {boolean}  never detail a body main.js already draws with its own
 *                        star mesh + halo. Default true.
 *   skip      {Function} (planet) => boolean, an extra veto. main.js keeps a
 *                        `starSet`; passing `p => starSet.has(p)` is exact.
 *
 * COSMETIC ROTATION. The simulation does not model spin: bodies have no angular
 * momentum, no obliquity and no rotation period anywhere in the physics. The
 * slow turn applied here exists only so that a textured body reads as a sphere
 * rather than as a decal, and the same goes for the ring plane's tilt. Set
 * `rotate: false` (or call setRotationEnabled(false)) to remove it entirely.
 *
 * The one exception is the accretion disk of a black hole. Its absolute rate is
 * cosmetic like everything else here, but the RATIO between its two annuli is
 * the real Keplerian omega ~ r^(-3/2), so the inner ring genuinely laps the
 * outer one and the disk shears the way a disk does.
 */
class DetailBodyPool {

    constructor(scene, options) {
        const config = options || {}

        this.scene = scene || null
        this.library = config.library || null
        this.getCamera = (typeof config.getCamera === 'function') ? config.getCamera : null
        this.radiusOf = (typeof config.radiusOf === 'function') ? config.radiusOf : null
        this.segments = (config.segments > 3) ? Math.floor(config.segments) : 48
        this.minApparentSize = (config.minApparentSize >= 0) ? config.minApparentSize : 0.004
        this.hysteresis = (config.hysteresis > 1) ? config.hysteresis : 1.5
        this.generationsPerFrame = (config.generationsPerFrame >= 0)
            ? Math.floor(config.generationsPerFrame) : 1
        this.ringsEnabled = config.rings !== false
        this.blackHolesEnabled = config.blackHoles !== false
        this.rotationEnabled = config.rotate !== false
        this.rotationSpeed = (typeof config.rotationSpeed === 'number' && config.rotationSpeed >= 0)
            ? config.rotationSpeed : 0.25
        this.skipStars = config.skipStars !== false
        this.skip = (typeof config.skip === 'function') ? config.skip : null

        this.enabled = config.enabled !== false
        this.count = (config.count > 0) ? Math.floor(config.count) : 12

        this.available = textureHasThree() && !!this.scene &&
            typeof this.scene.add === 'function'

        this.slots = []
        this.byPlanet = new Map()
        this._pickables = []
        this._candidates = []
        this._candidateCount = 0
        this._keep = new Set()
        this._frame = 0
        this._lastTime = textureNow()

        this._geometry = null
        this._ringGeometry = null
        // Built lazily: most runs never contain a black hole and should not pay
        // for four geometries and a material that nothing will ever draw.
        this._diskInnerGeometry = null
        this._diskOuterGeometry = null
        this._photonGeometry = null
        this._shadowGeometry = null
        this._shadowMaterial = null
        this._group = null

        if (this.available) {
            try {
                this._group = new THREE.Group()
                this._group.name = 'detailBodies'
                this.scene.add(this._group)
                this._geometry = new THREE.SphereGeometry(1, this.segments,
                    Math.max(8, Math.floor(this.segments / 2)))
            } catch (e) {
                this.available = false
            }
        }

        this.setCount(this.count)
    }

    // ------------------------------------------------------------------- API

    /** Is this body currently drawn as a detailed mesh? main.js skips these. */
    isDetailed(planet) {
        return !!planet && this.byPlanet.has(planet)
    }

    setEnabled(enabled) {
        this.enabled = !!enabled
        if (!this.enabled) {
            this._releaseAll()
        }
        return this
    }

    setRotationEnabled(enabled) {
        this.rotationEnabled = !!enabled
        return this
    }

    /** Grow or shrink the pool. Safe at any time. */
    setCount(count) {
        const target = Math.max(0, Math.floor(textureNumber(count, this.count)))
        this.count = target

        while (this.slots.length > target) {
            const slot = this.slots.pop()
            this._release(slot)
            this._destroySlot(slot)
        }
        while (this.slots.length < target) {
            const slot = this._createSlot()
            if (!slot) {
                break
            }
            this.slots.push(slot)
        }
        return this
    }

    /** Meshes that should be raycast against, using the userData.planet convention. */
    pickables() {
        return this._pickables
    }

    /**
     * Once per frame, BEFORE syncInstances().
     *
     * @param planets  the live body array
     * @param camera   the render camera (falls back to getCamera())
     * @param context  {selected, followed} - both optional
     */
    update(planets, camera, context) {
        const now = textureNow()
        let dt = (now - this._lastTime) / 1000
        this._lastTime = now
        if (!(dt > 0) || dt > 0.25) {
            dt = 0.016
        }

        if (!this.available || !this.enabled || this.slots.length === 0) {
            this._releaseAll()
            return
        }

        const view = camera || (this.getCamera ? this._safeCamera() : null)
        const eye = view && view.position
        if (!eye || !Array.isArray(planets) || planets.length === 0) {
            this._releaseAll()
            return
        }

        const selected = (context && context.selected) || null
        const followed = (context && context.followed) || null

        this._collect(planets, eye, selected, followed)

        const chosen = textureSelectDetailed(this._candidates, this.slots.length, {
            hysteresis: this.hysteresis,
            minScore: this.minApparentSize,
            length: this._candidateCount
        })

        this._assign(chosen)
        this._refresh(dt)
    }

    /** Release everything and remove the pool from the scene. */
    dispose() {
        this._releaseAll()
        for (let i = 0; i < this.slots.length; i++) {
            this._destroySlot(this.slots[i])
        }
        this.slots.length = 0
        this._pickables.length = 0
        this.byPlanet.clear()

        textureDisposeAll([this._geometry, this._ringGeometry,
            this._diskInnerGeometry, this._diskOuterGeometry, this._photonGeometry,
            this._shadowGeometry, this._shadowMaterial])
        this._geometry = null
        this._ringGeometry = null
        this._diskInnerGeometry = null
        this._diskOuterGeometry = null
        this._photonGeometry = null
        this._shadowGeometry = null
        this._shadowMaterial = null

        if (this._group && this.scene && typeof this.scene.remove === 'function') {
            try { this.scene.remove(this._group) } catch (e) { /* ignore */ }
        }
        this._group = null
        this.available = false
    }

    // -------------------------------------------------------------- internals

    /**
     * Bodies main.js draws itself. A star already has its own mesh, its own
     * halo and its own light over there; detailing it here would draw it twice
     * and double its brightness.
     */
    _skipped(planet) {
        if (this.skip) {
            try {
                if (this.skip(planet)) {
                    return true
                }
            } catch (e) { /* a broken predicate must not veto everything */ }
        }
        if (!this.skipStars) {
            return false
        }
        // A black hole is never one of the bodies main.js already draws as a
        // star: there is no photosphere over there and no halo, and the star
        // flags may well still be set on it by the physics that collapsed it.
        // An explicit `skip` predicate above still wins, so main.js keeps the
        // final say.
        if (textureIsBlackHole(planet)) {
            return false
        }
        return planet.isStar === true || planet.isCentralStar === true ||
            planet.classification === TEXTURE_CLASS_STAR
    }

    _safeCamera() {
        try {
            return this.getCamera()
        } catch (e) {
            return null
        }
    }

    /** Drawn radius of a body, in AU. */
    _radiusOf(planet) {
        if (this.radiusOf) {
            try {
                const value = this.radiusOf(planet)
                if (typeof value === 'number' && isFinite(value) && value > 0) {
                    return value
                }
            } catch (e) { /* fall through to the next source */ }
        }
        // main.js owns the render-radius mapping; use it when it is loaded so
        // the detailed sphere is exactly the size of the instance it replaces.
        if (typeof displayRadiusOf === 'function') {
            try {
                const value = displayRadiusOf(planet)
                if (typeof value === 'number' && isFinite(value) && value > 0) {
                    return value
                }
            } catch (e) { /* fall through */ }
        }
        const radius = textureNumber(planet && planet.radius, 0)
        return radius > 0 ? radius : 0.02
    }

    /** Fill the reusable candidate array. Allocates only when the pool grows. */
    _collect(planets, eye, selected, followed) {
        const candidates = this._candidates
        let written = 0

        for (let i = 0; i < planets.length; i++) {
            const planet = planets[i]
            if (!planet || planet.removed) {
                continue
            }
            const position = planet.position
            if (!position || !isFinite(position.x) || !isFinite(position.y) ||
                !isFinite(position.z)) {
                continue
            }
            if (this._skipped(planet)) {
                continue
            }

            const dx = position.x - eye.x
            const dy = position.y - eye.y
            const dz = position.z - eye.z
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
            const radius = this._radiusOf(planet)
            const score = textureApparentSize(radius, distance)
            const forced = (planet === selected) || (planet === followed)

            if (!forced && !(score > 0)) {
                continue
            }

            let candidate = candidates[written]
            if (!candidate) {
                candidate = { planet: null, score: 0, forced: false, incumbent: false, radius: 0 }
                candidates[written] = candidate
            }
            candidate.planet = planet
            candidate.score = score === Infinity ? 1e9 : score
            candidate.forced = forced
            candidate.incumbent = this.byPlanet.has(planet)
            candidate.radius = radius
            written++
        }

        this._candidateCount = written
    }

    /** Bind chosen candidates to slots, keeping existing assignments in place. */
    _assign(chosen) {
        // 1. release slots whose body was not chosen (or vanished).
        const keep = this._keep
        keep.clear()
        for (let i = 0; i < chosen.length; i++) {
            keep.add(chosen[i].planet)
        }
        for (let i = 0; i < this.slots.length; i++) {
            const slot = this.slots[i]
            if (slot.planet && !keep.has(slot.planet)) {
                this._release(slot)
            }
        }

        // 2. give a free slot to every chosen body that does not have one.
        for (let i = 0; i < chosen.length; i++) {
            const candidate = chosen[i]
            const planet = candidate.planet
            if (this.byPlanet.has(planet)) {
                continue
            }
            const slot = this._freeSlot()
            if (!slot) {
                break
            }
            this._bind(slot, planet)
        }
    }

    _freeSlot() {
        for (let i = 0; i < this.slots.length; i++) {
            if (!this.slots[i].planet) {
                return this.slots[i]
            }
        }
        return null
    }

    _bind(slot, planet) {
        slot.planet = planet
        slot.pending = true
        slot.key = null
        slot.spin = 0
        this.byPlanet.set(planet, slot)

        // A stable, seeded obliquity so the body is not drawn pole-on. Cosmetic:
        // see the class comment - the physics has no spin axis.
        const seed = textureSeedFromId(planet.id)
        slot.group.rotation.set(0, 0, ((seed & 255) / 255 - 0.5) * 0.9)
        slot.mesh.rotation.set(0, ((seed >>> 8) & 255) / 255 * Math.PI * 2, 0)
        slot.spinRate = this.rotationSpeed * (0.4 + ((seed >>> 16) & 255) / 255)
        if ((seed & 1024) !== 0) {
            slot.spinRate = -slot.spinRate
        }
        slot.mesh.userData.planet = planet
        slot.group.visible = true
    }

    _release(slot) {
        if (!slot) {
            return
        }
        if (slot.planet) {
            this.byPlanet.delete(slot.planet)
        }
        slot.planet = null
        slot.pending = false
        slot.key = null
        slot.group.visible = false
        slot.mesh.userData.planet = null
        if (slot.ring) {
            slot.ring.visible = false
        }
        textureHideBlackHole(slot)
    }

    _releaseAll() {
        for (let i = 0; i < this.slots.length; i++) {
            this._release(this.slots[i])
        }
        this.byPlanet.clear()
        this._pickables.length = 0
    }

    /**
     * Position, scale, material and spin for every bound slot.
     *
     * Texture generation is budgeted here: at most `generationsPerFrame` new
     * textures are built per call, and a body waiting its turn is drawn with a
     * flat material in its own composition colour, which is exactly what the
     * InstancedMesh was drawing anyway. Nothing pops, nothing stalls.
     */
    _refresh(dt) {
        let budget = this.generationsPerFrame
        this._pickables.length = 0
        this._frame++

        for (let i = 0; i < this.slots.length; i++) {
            const slot = this.slots[i]
            const planet = slot.planet
            if (!planet) {
                continue
            }
            if (planet.removed || !planet.position) {
                // Bodies vanish through accretion constantly; releasing a slot
                // has to be survivable at any moment.
                this._release(slot)
                continue
            }

            const radius = this._radiusOf(planet)
            slot.group.position.set(planet.position.x, planet.position.y, planet.position.z)
            slot.group.scale.setScalar(radius)

            // A body accretes, changes composition and can change CLASS while
            // it is being watched, so the texture it was given may no longer be
            // the right one. Re-checking that costs a key comparison, so it is
            // staggered: one slot per frame, each revisited every ~30 frames.
            if (!slot.pending && slot.key !== null &&
                (this._frame + i) % 30 === 0 && this.library &&
                typeof this.library.keyFor === 'function') {
                try {
                    if (this.library.keyFor(planet) !== slot.key) {
                        slot.pending = true
                    }
                } catch (e) { /* keep what it has */ }
            }

            if (slot.pending) {
                const ready = this.library && this.library.isReady &&
                    this.library.isReady(planet)
                if (ready || budget > 0) {
                    if (!ready) {
                        budget--
                    }
                    this._applyMaterial(slot, planet)
                } else {
                    this._applyFallback(slot, planet)
                }
            }

            if (this.rotationEnabled && slot.spinRate) {
                slot.mesh.rotation.y += slot.spinRate * dt
            }
            if (this.rotationEnabled && slot.blackHole && slot.blackHole.group.visible) {
                // Differential rotation. The absolute rate is showmanship; the
                // ratio is omega ~ r^(-3/2) and is real, so the inner annulus
                // laps the outer one and the disk visibly shears.
                slot.blackHole.inner.rotation.z += slot.blackHole.innerSpin * dt
                slot.blackHole.outer.rotation.z += slot.blackHole.outerSpin * dt
            }

            this._pickables.push(slot.mesh)
        }
    }

    _applyMaterial(slot, planet) {
        let material = null
        if (this.library && typeof this.library.materialFor === 'function') {
            try {
                material = this.library.materialFor(planet)
            } catch (e) {
                material = null
            }
        }
        if (!material) {
            this._applyFallback(slot, planet)
            return
        }
        slot.mesh.material = material
        slot.pending = false
        slot.key = null
        if (this.library && typeof this.library.keyFor === 'function') {
            try { slot.key = this.library.keyFor(planet) } catch (e) { slot.key = null }
        }
        this._applyBlackHole(slot, planet)
        this._applyRings(slot, planet)
    }

    /** Flat colour, used while a texture is queued or when there is none. */
    _applyFallback(slot, planet) {
        const hex = textureColorOf(planet)
        try {
            slot.fallback.color.set(hex)
        } catch (e) { /* keep whatever colour it had */ }
        slot.mesh.material = slot.fallback
        if (slot.ring) {
            slot.ring.visible = false
        }
        textureHideBlackHole(slot)
    }

    /**
     * Give a black hole its accretion disk, photon ring and shadow - or take
     * them away again, because the same slot was very likely holding a planet
     * ten frames ago and will hold another one ten frames from now.
     */
    _applyBlackHole(slot, planet) {
        let disk = null
        if (this.blackHolesEnabled && this.library &&
            typeof this.library.accretionDiskFor === 'function') {
            try {
                disk = this.library.accretionDiskFor(planet)
            } catch (e) {
                disk = null
            }
        }
        if (!disk) {
            textureHideBlackHole(slot)
            return
        }
        if (!slot.blackHole) {
            slot.blackHole = this._createBlackHole()
            if (!slot.blackHole) {
                return
            }
            slot.group.add(slot.blackHole.group)
        }
        const parts = slot.blackHole
        parts.inner.material = disk.innerMaterial
        parts.outer.material = disk.outerMaterial
        parts.photon.material = disk.photonMaterial
        parts.innerSpin = textureNumber(disk.innerSpin, 0)
        parts.outerSpin = textureNumber(disk.outerSpin, 0)
        parts.group.visible = true
    }

    /**
     * The four meshes that surround a horizon, in one group tilted into the
     * body's plane.
     *
     * Ordering matters and is set explicitly, because three.js sorts the
     * transparent pass by renderOrder first and every one of these has its
     * centre at the same point, so a depth sort has nothing to work with:
     * shadow, then the outer disk, then the hotter inner disk, then the photon
     * ring on top. The horizon sphere itself is opaque and writes depth, so it
     * still occludes the far side of the disk.
     */
    _createBlackHole() {
        try {
            if (!this._diskInnerGeometry) {
                this._diskInnerGeometry = new THREE.RingGeometry(
                    TEXTURE_BH_ISCO, TEXTURE_BH_DISK_SPLIT, 128, 1)
            }
            if (!this._diskOuterGeometry) {
                this._diskOuterGeometry = new THREE.RingGeometry(
                    TEXTURE_BH_DISK_SPLIT, TEXTURE_BH_DISK_OUTER, 128, 1)
            }
            if (!this._photonGeometry) {
                this._photonGeometry = new THREE.RingGeometry(
                    TEXTURE_BH_PHOTON_INNER, TEXTURE_BH_PHOTON_OUTER, 128, 1)
            }
            if (!this._shadowGeometry) {
                this._shadowGeometry = new THREE.SphereGeometry(
                    TEXTURE_BH_SHADOW_RADIUS, 32, 16)
            }
            if (!this._shadowMaterial) {
                // The dark halo. Not additive and not opaque: it multiplies the
                // background down inside sqrt(27)/2 R_s, which is where a real
                // hole's shadow falls, and the photon ring lands on its rim.
                // depthWrite off so it never occludes the disk drawn after it.
                this._shadowMaterial = new THREE.MeshBasicMaterial({
                    color: 0x000000,
                    transparent: true,
                    opacity: TEXTURE_BH_SHADOW_OPACITY,
                    depthWrite: false,
                    fog: false,
                    toneMapped: false
                })
            }

            const group = new THREE.Group()
            // RingGeometry lies in XY; the body's equator is XZ.
            group.rotation.x = -Math.PI / 2

            const shadow = new THREE.Mesh(this._shadowGeometry, this._shadowMaterial)
            const outer = new THREE.Mesh(this._diskOuterGeometry, this._shadowMaterial)
            const inner = new THREE.Mesh(this._diskInnerGeometry, this._shadowMaterial)
            const photon = new THREE.Mesh(this._photonGeometry, this._shadowMaterial)
            const parts = [shadow, outer, inner, photon]
            for (let i = 0; i < parts.length; i++) {
                // Same reason as the body mesh: AU-scale distances and a camera
                // that flies among them make a stale bounding sphere a cull.
                parts[i].frustumCulled = false
                parts[i].renderOrder = i
                // Clicks belong to the body, not to its glow.
                parts[i].raycast = function () { }
                group.add(parts[i])
            }

            return {
                group: group,
                shadow: shadow,
                outer: outer,
                inner: inner,
                photon: photon,
                innerSpin: 0,
                outerSpin: 0
            }
        } catch (e) {
            return null
        }
    }

    _applyRings(slot, planet) {
        if (!this.ringsEnabled || !this.library ||
            typeof this.library.ringTextureFor !== 'function') {
            if (slot.ring) {
                slot.ring.visible = false
            }
            return
        }

        let texture = null
        try {
            texture = this.library.ringTextureFor(planet)
        } catch (e) {
            texture = null
        }
        if (!texture) {
            if (slot.ring) {
                slot.ring.visible = false
            }
            return
        }

        if (!slot.ring) {
            slot.ring = this._createRing()
            if (!slot.ring) {
                return
            }
            slot.group.add(slot.ring)
        }
        if (slot.ring.material.map !== texture) {
            slot.ring.material.map = texture
            slot.ring.material.needsUpdate = true
        }
        slot.ring.visible = true
    }

    _createSlot() {
        if (!this.available || !this._geometry) {
            return null
        }
        try {
            const group = new THREE.Group()
            group.visible = false
            // The bodies are tiny against AU-scale distances and the camera
            // flies among them; a stale bounding sphere would cull them.
            const fallback = new THREE.MeshLambertMaterial({ fog: false })
            const mesh = new THREE.Mesh(this._geometry, fallback)
            mesh.frustumCulled = false
            group.add(mesh)
            this._group.add(group)
            return {
                group: group,
                mesh: mesh,
                ring: null,
                blackHole: null,
                fallback: fallback,
                planet: null,
                pending: false,
                key: null,
                spinRate: 0
            }
        } catch (e) {
            return null
        }
    }

    _createRing() {
        try {
            if (!this._ringGeometry) {
                this._ringGeometry = new THREE.RingGeometry(
                    TEXTURE_RING_INNER_RADIUS, TEXTURE_RING_OUTER_RADIUS, 96, 1)
            }
            const material = new THREE.MeshLambertMaterial({
                transparent: true,
                side: THREE.DoubleSide,
                depthWrite: false,
                fog: false
            })
            const ring = new THREE.Mesh(this._ringGeometry, material)
            // RingGeometry lies in XY; the sphere's equator is XZ.
            ring.rotation.x = -Math.PI / 2
            ring.frustumCulled = false
            // Clicks belong to the body, not to its rings.
            ring.raycast = function () { }
            return ring
        } catch (e) {
            return null
        }
    }

    _destroySlot(slot) {
        if (!slot) {
            return
        }
        if (slot.ring) {
            if (slot.ring.material && typeof slot.ring.material.dispose === 'function') {
                try { slot.ring.material.dispose() } catch (e) { /* ignore */ }
            }
            if (slot.group && typeof slot.group.remove === 'function') {
                try { slot.group.remove(slot.ring) } catch (e) { /* ignore */ }
            }
            slot.ring = null
        }
        if (slot.blackHole) {
            // The geometries and materials belong to the pool and to the
            // texture library respectively; only the meshes are the slot's.
            if (slot.group && typeof slot.group.remove === 'function') {
                try { slot.group.remove(slot.blackHole.group) } catch (e) { /* ignore */ }
            }
            slot.blackHole = null
        }
        if (slot.fallback && typeof slot.fallback.dispose === 'function') {
            try { slot.fallback.dispose() } catch (e) { /* ignore */ }
        }
        if (this._group && slot.group && typeof this._group.remove === 'function') {
            try { this._group.remove(slot.group) } catch (e) { /* ignore */ }
        }
        slot.mesh = null
        slot.group = null
    }
}

/** Hide a slot's black hole decorations, if it has any. Never throws. */
function textureHideBlackHole(slot) {
    if (slot && slot.blackHole && slot.blackHole.group) {
        slot.blackHole.group.visible = false
    }
}

/** Body colour as a CSS string, using whatever the body is willing to tell us. */
function textureColorOf(planet) {
    if (planet) {
        // Before anything else. A black hole's colorHex is whatever structure.js
        // made of a zero luminosity - a composition grey, or a clamped red if
        // the accretion disk gave it one - and neither is a colour a horizon
        // has. Black is not a fallback here, it is the answer.
        if (textureIsBlackHole(planet)) {
            return '#000000'
        }
        if (typeof planet.colorHex === 'string' && planet.colorHex) {
            return planet.colorHex
        }
        if (typeof planet.color === 'function') {
            try {
                const value = planet.color()
                if (typeof value === 'string' && value) {
                    return value
                }
            } catch (e) { /* fall through */ }
        }
        const composition = planet.composition
        if (composition && typeof composition.displayColor === 'string') {
            return composition.displayColor
        }
    }
    return '#8899aa'
}

// ============================================================================
// Node export, for the unit tests. A no-op in the browser.
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        BodyTextureLibrary: BodyTextureLibrary,
        DetailBodyPool: DetailBodyPool,
        textureProfileOf: textureProfileOf,
        textureRawOf: textureRawOf,
        textureRawStable: textureRawStable,
        textureProfileFromRaw: textureProfileFromRaw,
        textureKeyOf: textureKeyOf,
        texturePaletteFor: texturePaletteFor,
        textureSelectDetailed: textureSelectDetailed,
        textureApparentSize: textureApparentSize,
        textureSeedFromId: textureSeedFromId,
        textureNoiseField: textureNoiseField,
        textureValueNoise3: textureValueNoise3,
        textureBodyHasRings: textureBodyHasRings,
        textureRasterizeAnnulus: textureRasterizeAnnulus,
        textureDrawAccretionDisk: textureDrawAccretionDisk,
        textureDrawPhotonRing: textureDrawPhotonRing,
        textureIsBlackHole: textureIsBlackHole,
        textureEddingtonRatio: textureEddingtonRatio,
        textureDiskPeakTemperature: textureDiskPeakTemperature,
        textureDiskTemperatureShape: textureDiskTemperatureShape,
        textureBlackHoleProfile: textureBlackHoleProfile,
        textureClassOf: textureClassOf,
        textureColorOf: textureColorOf,
        textureRandom: textureRandom,
        textureSin: textureSin
    }
}
