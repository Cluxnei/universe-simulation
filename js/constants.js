//Math constants
const GRAVITATION_CONSTANT = 6.67e-11 * 10e10
const FIXED_DT = 0.016
// Plummer softening length. Force = G*m1*m2 * r / (r^2 + eps^2)^(3/2), so the
// interaction stays finite as r -> 0 instead of needing an acceleration clamp.
// Order of the smallest body radius.
const SOFTENING = 2.0
const SOFTENING_SQUARED = SOFTENING * SOFTENING
// Planet Constants
const EXISTING_RADIUS_MIN = 1
// Mass transfer uses dm = m * (1 - exp(-MASS_TRANSFER_RATE * dt)), which is bounded
// by m for any dt, so a big dt can never produce negative mass / NaN radius.
const MASS_TRANSFER_RATE = 6.0
const MIN_PLANET_MASS = 0.1
const MIN_PLANET_VOLUME = 1e-9
// Fraction of the overlap removed per step when two bodies interpenetrate.
const PENETRATION_CORRECTION = 0.4
// 0 = perfectly inelastic contact (bodies stick), 1 = bouncy. Real accretion is 0.
const COLLISION_RESTITUTION = 0
// Canvas constants
const BACKGROUND_COLOR = '#000'
const RENDER_DETAILS = 2;
// Render loop. Physics always advances in fixed FIXED_DT steps, decoupled from the
// frame rate by an accumulator. MAX_FRAME_TIME clamps the delta after a tab stall or
// a breakpoint so the accumulator cannot demand hundreds of catch-up steps, and
// MAX_STEPS_PER_FRAME caps the catch-up loop so a slow machine degrades into slow
// motion instead of freezing (the "spiral of death").
const MAX_FRAME_TIME = 0.25
const MAX_STEPS_PER_FRAME = 5
// Simulation constants
// 800 is comfortable with Barnes-Hut enabled. The brute force path
// (USE_BARNES_HUT = false) is O(n^2) and is noticeably slower at this count.
const PLANETS_NUMBER = 800
const PLANETS_POSITION_RANGE = 1000
const PLANETS_VELOCITY_RANGE = 100
const PLANETS_RADIUS_RANGE_MIN = 1
const PLANETS_RADIUS_RANGE_MAX = 10
const PLANETS_DENSITY_RANGE_MIN = 1
const PLANETS_DENSITY_RANGE_MAX = 150
// Initial conditions
// Solid body rotation added on top of the random velocities, as a fraction of the
// circular speed at the edge of the cloud. Gives the cloud net angular momentum.
const ANGULAR_MOMENTUM_FACTOR = 0.6
// Velocities are rescaled so that 2*T = VIRIAL_RATIO * |U| (1 = virial equilibrium,
// < 1 collapses, > 1 disperses).
const VIRIAL_RATIO = 1.0
const ROTATION_AXIS_X = 0
const ROTATION_AXIS_Y = 1
const ROTATION_AXIS_Z = 0
// Barnes-Hut
const USE_BARNES_HUT = true
const BARNES_HUT_THETA = 0.5
const BARNES_HUT_MIN_BODIES = 32
const BARNES_HUT_MAX_DEPTH = 24
const LOG_AT = 3
var MAX_ELEMENT = 0
