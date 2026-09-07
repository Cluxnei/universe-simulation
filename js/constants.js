/**
 * Tunable scenario parameters. Physical constants and unit conversions live in
 * units.js; nothing in this file is a law of nature.
 *
 * All values are in simulation units: solar masses, astronomical units, years.
 */

// --- Gravity ------------------------------------------------------------------
// G = 4*PI^2 exactly in Msun/AU/yr. See units.js.
const GRAVITATION_CONSTANT = 4 * Math.PI * Math.PI

// Plummer softening. Force = G*m1*m2 * r / (r^2 + eps^2)^(3/2), so the
// interaction stays finite as r -> 0. It must be far smaller than the orbital
// separations we care about or it would distort the orbits themselves; bodies
// merge on contact long before they get this close anyway.
const SOFTENING = 1e-3                      // AU, about a fifth of a solar radius
const SOFTENING_SQUARED = SOFTENING * SOFTENING

// --- Time stepping ------------------------------------------------------------
// The innermost orbit sets the limit. At DISK_INNER_RADIUS the orbital period is
// ~0.35 yr, and Velocity-Verlet wants well over 20 steps per orbit, so this
// gives ~100. Raising it visibly degrades the inner orbits first.
const FIXED_DT = 0.0035                     // years
const MAX_FRAME_TIME = 0.25                 // seconds of wall clock
const MAX_STEPS_PER_FRAME = 8

// --- Host star ----------------------------------------------------------------
// A single dominant central body. Its luminosity sets the disk's temperature
// profile, and therefore the snow line and the composition of everything that
// forms.
const STAR_MASS = 1.0                       // Msun
const STAR_ENABLED = true

// --- Protoplanetary disk ------------------------------------------------------
// 800 embryos totalling 1e-3 Msun is ~333 Earth masses, or 0.42 Earth masses
// each: the oligarchic growth stage, which is the phase real late-accretion
// simulations model with this many bodies.
const PLANETS_NUMBER = 800
const DISK_TOTAL_MASS = 1e-3                // Msun
const DISK_INNER_RADIUS = 0.5               // AU
const DISK_OUTER_RADIUS = 20.0              // AU

// Surface density profile Sigma(r) ~ r^-DISK_SURFACE_DENSITY_EXPONENT. 1.5 is
// the minimum-mass solar nebula value, so most of the mass sits inside.
const DISK_SURFACE_DENSITY_EXPONENT = 1.5

// Orbits need some spread or they never cross and nothing ever collides.
// Real embryo swarms have Rayleigh-distributed eccentricity and inclination
// with these typical values; inclination is conventionally half of eccentricity.
const DISK_ECCENTRICITY_RMS = 0.03
const DISK_INCLINATION_RMS = 0.015          // radians

// --- Accretion ----------------------------------------------------------------
// POETIC LICENCE, and the largest one in the simulation.
//
// At true scale a planetary radius is ~1e-5 AU against orbital separations of
// order 1 AU, so the geometric collision cross-section is so small that a real
// disk takes 1e7-1e8 years to build planets. Nothing would ever be seen to
// happen. Bodies are therefore given an accretion radius far larger than their
// physical one, which compresses planet formation into a few thousand simulated
// years without touching the dynamics: orbits, resonances and scattering all
// stay exactly right, only the target size is exaggerated.
//
// The physical radius is still what structure.js computes and what the renderer
// reports; this factor affects collision detection only.
const ACCRETION_RADIUS_FACTOR = 800

// Gravitational focusing enhances the cross-section by (1 + vesc^2/vrel^2).
// This part is real physics, not licence, and it matters at low relative speed.
const USE_GRAVITATIONAL_FOCUSING = true

// An impact much faster than the target's escape speed erodes rather than
// accretes. Above this ratio the collision is treated as disruptive.
const FRAGMENTATION_VELOCITY_RATIO = 2.5

const MIN_PLANET_MASS = 1e-12               // Msun, below this a body is dropped

// --- Accretion, gas and fusion tunables ---------------------------------------
// Migrated out of planet.js / simulation.js so every knob lives in one place.
// Absorption radius of a star, as a multiple of its physical radius. It is
// deliberately NOT ACCRETION_RADIUS_FACTOR: 800 solar radii is 3.7 AU, which
// would swallow the entire inner disk on the first step. Ten solar radii is
// roughly where a rocky body crosses the Roche limit and is torn apart, which is
// the physical event actually being modelled when something falls into a star.
const STAR_ACCRETION_RADIUS_FACTOR = 10
// Below this effective temperature a body's own emission is entirely infrared
// and it is not visibly self-luminous, so it must be coloured by what it is
// made of. It is not enough to test luminosity > 0: structure.js gives a gas
// giant a real 1e-9 Lsun of contraction luminosity, which at 130 K is invisible
// - and blackbodyColorHex() clamps anything that cold to a deep red that means
// nothing. It is the same floor the blackbody fit itself is valid down to.
const LUMINOUS_MIN_TEMPERATURE = 1000        // K
// Gravitational focusing enhances the collision cross-section by
// (1 + vesc^2/vrel^2), i.e. the capture radius by the square root of that. As
// vrel -> 0 the factor diverges, and it also has to stay bounded for the
// collision grid to be able to size its cells, so the radius enhancement is
// capped here.
const GRAVITATIONAL_FOCUSING_MAX = 3.0
// Erosive (disruptive) impacts. Above FRAGMENTATION_VELOCITY_RATIO times the
// target's escape speed the impactor is not swallowed: only this fraction of it
// is retained and the pair rebounds with this restitution. NO fragment bodies
// are spawned - see disruptPair() for why - and nothing is destroyed, so mass,
// momentum and every element stay exactly conserved.
const FRAGMENTATION_ACCRETION_EFFICIENCY = 0.1
const FRAGMENTATION_RESTITUTION = 0.3
// Runaway gas accretion. A solid core heavier than the critical mass, still
// inside the gas disk, starts to pull nebular H/He onto itself; the envelope
// grows exponentially until the planet is massive enough to open a gap in the
// disk and cut off its own supply.
//
// TIMESCALES ARE COMPRESSED, exactly like ACCRETION_RADIUS_FACTOR. A real disk
// disperses in ~3e6 yr and runaway accretion takes ~1e5 yr; this simulation
// builds planets in a few hundred years, so the gas numbers are scaled to that
// same compressed clock. They are tunables, not measurements.
const GAS_ACCRETION_ENABLED = true
const GAS_ACCRETION_CRITICAL_CORE_MASS = 10 * EARTH_MASS    // ~3e-5 Msun, the standard value
const GAS_ACCRETION_TIMESCALE = 50                          // years, e-folding of the envelope
const GAS_ACCRETION_MAX_RATE = 5e-5                         // Msun/yr, hard ceiling
const GAS_ACCRETION_GAP_MASS = 3 * JUPITER_MASS             // gap opening halts accretion
const GAS_DISK_MASS = 0.01                                  // Msun, ~10 Jupiters (MMSN gas)
const GAS_DISK_DISPERSAL_TIME = 1000                        // years, e-folding of the reservoir
const GAS_DISK_MINIMUM_RESERVOIR = 1e-8                     // Msun, below this the disk is gone
// Fusion. composition.js burns 10% of the available hydrogen per year, which is
// a sensible knob for a star watched over its own lifetime and absurd here: the
// Sun would be out of hydrogen in fifty simulated years. Scaling the time it is
// given puts a solar hydrogen lifetime at ~1e5 simulated years - long compared
// with planet formation, short enough that a long run shows the star evolving.
const FUSION_ENABLED = true
const FUSION_TIME_SCALE = 1e-4

// --- Black holes --------------------------------------------------------------
//
// A black hole is dynamically JUST A POINT MASS. Newtonian gravity cannot tell a
// 10 Msun black hole from a 10 Msun star, so nothing below touches the force
// law, the integrator or the tree: every knob here is about capture and about
// the light the infalling matter emits on its way in.
//
// The scales involved, measured rather than asserted:
//
//     r_s(1 Msun)     = 1.974e-8 AU   235000x SMALLER than the Sun
//     r_s(1e6 Msun)   = 1.974e-2 AU   20x the softening length, resolvable
//     R_tidal(10 Msun, Sun-like) = 0.0100 AU
//     R_tidal(1e6 Msun, Sun-like) = 0.465 AU
//
// So for a stellar-mass hole the horizon sits five orders of magnitude below
// SOFTENING and is not a thing this simulation can resolve; the TIDAL radius is
// macroscopic and is what actually eats stars. Capture is keyed off that.

// The capture radius can never fall below the length at which the softened
// force stops being the real force. Two bodies closer than SOFTENING are not
// being integrated correctly any more - the potential has been deliberately
// flattened there - so merging them is the honest response, and it is also what
// lets two stellar-mass black holes ever merge at all: their horizons are 2e-7
// AU apart and no timestep would ever resolve a contact that small.
const BLACK_HOLE_MIN_CAPTURE_RADIUS = SOFTENING

// Broad-phase safety margin ONLY. The collision grid is sized from each body's
// stored accretionRadius, which for a hole is its tidal radius against a
// Sun-like (solar mean density) victim; the exact pairwise tidal radius used to
// decide a capture depends on the victim's mean density, which for a puffy
// massive star can be ~1/8 solar. Doubling the stored value keeps such a pair in
// the same grid neighbourhood. It does NOT widen the capture test itself.
const BLACK_HOLE_CAPTURE_MARGIN = 2.0

// Accretion luminosity. A thin disk around a non-rotating hole radiates ~6% of
// the rest mass of what it swallows, ~10-40% for a spinning one; 0.1 is the
// figure usually quoted and is 15x more efficient than hydrogen fusion (0.7%).
const BLACK_HOLE_ACCRETION_ENABLED = true
const BLACK_HOLE_ACCRETION_EFFICIENCY = 0.1
// Captured mass does not radiate instantly: it circularises and drains inward
// on the disk's viscous timescale, which is what turns a single tidal disruption
// into a flare that fades over months to years rather than a one-frame spike.
// Scaled to this simulation's compressed clock, like GAS_ACCRETION_TIMESCALE.
// A swallowed star is a lot of fuel: 20 Msun of it drains with this e-folding
// but stays pinned at the Eddington cap below for the first ~80 years and then
// fades over the next ~100, which is the light curve a run actually shows.
const BLACK_HOLE_ACCRETION_TIMESCALE = 5.0                  // years, e-folding
// Below this the disk has gone out and the hole is dark again.
const BLACK_HOLE_MIN_ACCRETION_RESERVOIR = 1e-12            // Msun
// Radiation pressure caps the sustained output at the Eddington limit
// (32840 Lsun per Msun). Real tidal disruptions do exceed it briefly; capping
// keeps the HUD readable and the renderer's dynamic range finite.
const BLACK_HOLE_EDDINGTON_LIMITED = true

// The hole itself, drawn. Not quite #000000: pure black is indistinguishable
// from the background and the body would simply vanish. This is the colour of
// the horizon, not of the disk - the disk's light is reported through the normal
// `luminosity` field.
const BLACK_HOLE_COLOR_HEX = '#06060a'

// --- Barnes-Hut ---------------------------------------------------------------
// The star is summed directly rather than through the tree: it holds ~99.9% of
// the mass, and approximating it would wreck every orbit in the disk.
const USE_BARNES_HUT = true
const BARNES_HUT_THETA = 0.5
const BARNES_HUT_MIN_BODIES = 32
const BARNES_HUT_MAX_DEPTH = 24

// --- Rendering ----------------------------------------------------------------
const BACKGROUND_COLOR = '#000'
const RENDER_DETAILS = 2

// POETIC LICENCE. One solar radius is 0.00465 AU; in a 20 AU disk a true-scale
// planet is a few millionths of the scene and the screen is simply black. Bodies
// are drawn inflated, on a compressive curve so that a Jupiter does not dwarf an
// Earth by the factor it really does.
// Calibrated against real radiusFor() output: at 1200 every body from a pebble
// upward pinned to RENDER_RADIUS_MAX, collapsing the dynamic range to 1.3x. At 6
// the same span covers 0.02 -> 0.31 AU, a usable 15x.
const RENDER_RADIUS_SCALE = 6
const RENDER_RADIUS_EXPONENT = 0.55
const RENDER_RADIUS_MIN = 0.03              // AU, floor so nothing vanishes
const RENDER_RADIUS_MAX = 1.5               // AU, ceiling so the star fits on screen

// Black holes need their own display curve. A Schwarzschild radius spans eight
// decades of mass (2e-8 AU at 1 Msun to 8e-2 AU at Sgr A*), and the ordinary
// RENDER_RADIUS_* curve pins everything below ~3300 Msun to its floor, drawing a
// stellar-mass hole the same size as a pebble. This keeps the mass ordering
// visible across the whole range instead.
const RENDER_BLACK_HOLE_RADIUS_SCALE = 0.045      // AU at 10 Msun
const RENDER_BLACK_HOLE_RADIUS_EXPONENT = 0.2
const RENDER_BLACK_HOLE_RADIUS_MIN = 0.045
const RENDER_BLACK_HOLE_RADIUS_MAX = 1.5

// Blackbody colour is used for anything that emits its own light; everything
// else is shaded by composition.
const STAR_EMISSIVE_BOOST = 3.0
