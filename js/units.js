/**
 * Unit system and physical constants.
 *
 * The simulation works in astronomical units throughout:
 *
 *     mass   -> solar masses      (Msun)
 *     length -> astronomical units (AU)
 *     time   -> years
 *
 * In this system the gravitational constant is exactly G = 4*PI^2, because a
 * circular orbit of radius 1 AU around 1 Msun takes 1 year by definition. That
 * identity is the sanity check for the whole simulation: put one body at 1 AU
 * with speed 2*PI AU/yr and it must close its orbit in exactly one year.
 *
 * Everything below is either an exact definition or a measured value converted
 * into these units. Nothing here is tuned - tunable scenario parameters live in
 * constants.js.
 */

// --- SI reference values, for conversion only ---------------------------------
const SOLAR_MASS_KG = 1.98892e30
const AU_METERS = 1.495978707e11
const YEAR_SECONDS = 3.15576e7
const KG_PER_EARTH_MASS = 5.9722e24
const KG_PER_JUPITER_MASS = 1.89813e27

// --- Masses, in Msun ----------------------------------------------------------
const EARTH_MASS = KG_PER_EARTH_MASS / SOLAR_MASS_KG        // 3.003e-6
const JUPITER_MASS = KG_PER_JUPITER_MASS / SOLAR_MASS_KG    // 9.546e-4

// --- Radii, in AU -------------------------------------------------------------
const SOLAR_RADIUS = 6.957e8 / AU_METERS                    // 4.650e-3
const EARTH_RADIUS = 6.371e6 / AU_METERS                    // 4.259e-5
const JUPITER_RADIUS = 6.9911e7 / AU_METERS                 // 4.673e-4

// --- Speed of light ------------------------------------------------------------
/**
 * c in simulation units, AU/yr. Derived, never guessed:
 *
 *     299792458 m/s * 3.15576e7 s/yr / 1.495978707e11 m/AU = 63241.08 AU/yr
 *
 * It appears in exactly two places: the Schwarzschild radius of a black hole
 * (structure.js) and the rest-mass energy of accreted material. It is NOT used
 * anywhere in the force law - gravity in this simulation is Newtonian and stays
 * Newtonian; see the note on Paczynski-Wiita in structure.js.
 */
const SPEED_OF_LIGHT_METERS_PER_SECOND = 299792458
const SPEED_OF_LIGHT = SPEED_OF_LIGHT_METERS_PER_SECOND * YEAR_SECONDS / AU_METERS
const SPEED_OF_LIGHT_SQUARED = SPEED_OF_LIGHT * SPEED_OF_LIGHT

// --- Temperatures and luminosity ----------------------------------------------
// Luminosity is carried in solar luminosities, which lets us use
// L/Lsun = (R/Rsun)^2 * (T/Tsun)^4 and never touch the Stefan-Boltzmann
// constant in simulation units.
const SOLAR_EFFECTIVE_TEMPERATURE = 5772           // K
const SOLAR_LUMINOSITY = 1                         // by definition

/**
 * The one place a luminosity has to leave solar units: an accretion disk's
 * output is set by a mass flow (Msun/yr) times c^2, which lands in
 * Msun*AU^2/yr^3 and has to be converted back to Lsun for the rest of the code.
 *
 *     1 Msun*AU^2/yr^3 = 1.4166e30 W = 3700 Lsun
 *     1 Lsun           = 2.703e-4 Msun*AU^2/yr^3
 *
 * Both are derived below rather than quoted, so a change to any SI reference
 * above propagates.
 */
const SOLAR_LUMINOSITY_WATTS = 3.828e26
const WATTS_PER_SIMULATION_LUMINOSITY =
    SOLAR_MASS_KG * AU_METERS * AU_METERS /
    (YEAR_SECONDS * YEAR_SECONDS * YEAR_SECONDS)
const SOLAR_LUMINOSITY_IN_SIMULATION_UNITS =
    SOLAR_LUMINOSITY_WATTS / WATTS_PER_SIMULATION_LUMINOSITY

/**
 * Eddington luminosity per solar mass, in Lsun/Msun: the luminosity at which
 * radiation pressure on free electrons balances gravity, so an accreting body
 * cannot shine much brighter for long without blowing its own fuel supply away.
 *
 *     L_Edd = 4*pi*G*M*m_p*c / sigma_T = 1.257e31 W * (M/Msun) = 32840 Lsun * (M/Msun)
 *
 * Evaluated once in SI (it needs the proton mass and the Thomson cross-section,
 * neither of which belongs in simulation units) and kept as the single number.
 * Note the pleasing coincidence that structure.luminosity() gives the most
 * massive stars 32000*M Lsun - massive stars really do sit at their own
 * Eddington limit.
 */
const EDDINGTON_LUMINOSITY_PER_SOLAR_MASS = 3.284e4          // Lsun / Msun

/**
 * Mass thresholds that separate the physical classes of body. These are not
 * arbitrary bins: each one is the mass at which a nuclear reaction becomes
 * possible in the core, so the classification is a consequence of the physics
 * rather than a setting.
 */
// Above this a body fuses deuterium -> brown dwarf rather than planet.
const DEUTERIUM_BURNING_MASS = 13 * JUPITER_MASS            // 0.0124 Msun
// Above this the core reaches ~1e7 K and hydrogen ignites -> a real star.
const HYDROGEN_BURNING_MASS = 0.08                          // Msun
// Below this a body is too small for self-gravity to pull it round.
const HYDROSTATIC_EQUILIBRIUM_MASS = 1.5e-10                // Msun, ~Ceres

/**
 * Zero-pressure densities of the material groups we track, in g/cm^3, and the
 * same values converted to Msun/AU^3 for use in the simulation.
 *
 * "Ice" means the volatile condensates (water, CO, CH4, NH3) treated as one
 * group; "rock" means silicates; "metal" means the iron-nickel core material.
 */
const DENSITY_GRAMS_PER_CM3_TO_SOLAR_PER_AU3 =
    (1e3 / SOLAR_MASS_KG) * (AU_METERS * AU_METERS * AU_METERS)

const DENSITY_ICE_CGS = 1.0
const DENSITY_ROCK_CGS = 3.2
const DENSITY_METAL_CGS = 7.9

const DENSITY_ICE = DENSITY_ICE_CGS * DENSITY_GRAMS_PER_CM3_TO_SOLAR_PER_AU3
const DENSITY_ROCK = DENSITY_ROCK_CGS * DENSITY_GRAMS_PER_CM3_TO_SOLAR_PER_AU3
const DENSITY_METAL = DENSITY_METAL_CGS * DENSITY_GRAMS_PER_CM3_TO_SOLAR_PER_AU3

/**
 * Temperature below which water ice is stable against sublimation. The radius
 * in the disk where the equilibrium temperature crosses it is the snow line,
 * and it is not configured anywhere - it falls out of the host star's
 * luminosity. For a solar-type star it lands at ~2.7 AU, which is where the
 * asteroid belt ends and Jupiter begins in the real solar system.
 */
const SNOW_LINE_TEMPERATURE = 170                           // K

// --- Conversion helpers, for display only -------------------------------------
function solarMassesToEarthMasses(mass) {
    return mass / EARTH_MASS
}

function solarMassesToJupiterMasses(mass) {
    return mass / JUPITER_MASS
}

function auToSolarRadii(radius) {
    return radius / SOLAR_RADIUS
}

function auToEarthRadii(radius) {
    return radius / EARTH_RADIUS
}

/** Msun/AU^3 -> g/cm^3, the unit densities are actually quoted in. */
function densityToGramsPerCm3(density) {
    return density / DENSITY_GRAMS_PER_CM3_TO_SOLAR_PER_AU3
}

/**
 * Equilibrium temperature of a body heated only by its host star.
 *
 *     T(r) = Tstar * sqrt(Rstar / 2r) * (1 - albedo)^(1/4)
 *
 * At 1 AU from the Sun with albedo 0.3 this gives 255 K, which is Earth's
 * measured equilibrium temperature.
 */
function equilibriumTemperature(distance, starTemperature, starRadius, albedo) {
    if (!(distance > 0)) {
        return starTemperature
    }
    const geometric = Math.sqrt(starRadius / (2 * distance))
    return starTemperature * geometric * Math.pow(1 - (albedo || 0), 0.25)
}

/** Orbital period of a circular orbit, in years. */
function orbitalPeriod(semiMajorAxis, centralMass) {
    return 2 * Math.PI * Math.sqrt(
        (semiMajorAxis * semiMajorAxis * semiMajorAxis) /
        (GRAVITATION_CONSTANT * centralMass)
    )
}

/** Speed of a circular orbit, in AU/yr. */
function circularOrbitalSpeed(radius, centralMass) {
    return Math.sqrt(GRAVITATION_CONSTANT * centralMass / radius)
}

/** Escape speed from the surface of a body, in AU/yr. */
function escapeSpeed(mass, radius) {
    return Math.sqrt(2 * GRAVITATION_CONSTANT * mass / radius)
}

/**
 * Hill radius: the distance within which a body's gravity dominates over the
 * central star's tide. It sets the natural length scale for accretion.
 */
function hillRadius(mass, centralMass, distance) {
    return distance * Math.pow(mass / (3 * centralMass), 1 / 3)
}

/** Rest-mass energy of a mass, in simulation units (Msun*AU^2/yr^2). */
function restMassEnergy(mass) {
    return mass * SPEED_OF_LIGHT_SQUARED
}

/** Eddington luminosity of a body, in solar luminosities. */
function eddingtonLuminosity(mass) {
    return mass > 0 ? EDDINGTON_LUMINOSITY_PER_SOLAR_MASS * mass : 0
}
