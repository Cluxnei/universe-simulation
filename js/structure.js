/**
 * Structure: mass + composition -> radius, interior conditions, class, light.
 *
 * Stateless. Every function here is pure: it reads a mass (Msun), optionally a
 * Composition-shaped object, and returns numbers. Nothing is cached that can go
 * stale, nothing global is mutated, nothing here knows about the DOM or THREE.
 *
 * Units, as everywhere else in the simulation: solar masses, astronomical
 * units, years, so G = 4*PI^2. No SI constant (k_B, m_H, sigma, c) appears in
 * any formula below. Where a result has to be reported in SI - central pressure
 * in pascals, temperature in kelvin - the relation is calibrated against the
 * measured solar value instead, which is both more accurate and impossible to
 * get wrong by unit slip.
 *
 * The Composition contract this file codes against:
 *
 *     .gasFraction         mass fraction of H+He
 *     .iceFraction         mass fraction of volatile ices
 *     .rockFraction        mass fraction of silicates
 *     .metalFraction       mass fraction of Fe/Ni
 *     .zeroPressureDensity uncompressed density, Msun/AU^3
 *     .meanMolecularWeight mu, dimensionless
 *
 * Any of them may be missing; a body with no usable composition is treated as
 * pure rock with mu = 0.6.
 */

// ============================================================================
// Mass-radius: fitted parameters
// ============================================================================

/**
 * Seager et al. (2007), "Mass-Radius Relationships for Solid Exoplanets",
 * ApJ 669, 1279, equation 23:
 *
 *     R/r1 = 10^k1 * (M/m1)^(1/3) * 10^(-k2 * (M/m1)^k3)
 *
 * The (M/m1)^(1/3) term is the strengthless, constant-density limit; the
 * trailing power of ten is the compression correction, which tends to 1 as
 * M -> 0 and drives the radius back down once the material becomes degenerate.
 * We keep only that compression factor from the fit and take the zero-pressure
 * density from the composition instead, so the two low-mass regimes the brief
 * asks for are literally the same expression and cannot disagree at their
 * boundary.
 *
 * k2 and k3 barely move between materials (0.0804/0.394 for perovskite and
 * iron, 0.0807/0.375 for water ice), so one pair is used for the mixture.
 */
const STRUCTURE_SEAGER_K2 = 0.0804
const STRUCTURE_SEAGER_K3 = 0.39

// Characteristic mass m1 of the Seager fit, per material, converted to Msun.
const STRUCTURE_SEAGER_MASS_ICE = 5.52 * EARTH_MASS
const STRUCTURE_SEAGER_MASS_ROCK = 10.55 * EARTH_MASS
const STRUCTURE_SEAGER_MASS_METAL = 5.80 * EARTH_MASS

/**
 * Radius of a one-Earth-mass sphere of each pure material, in Earth radii,
 * from the same paper's interior models. Rock is 1.00 by construction - it is
 * the normalisation the brief asks for - and the other two are measured
 * against it: a water world of Earth's mass is 1.4 R_earth, an iron ball is
 * 0.76 R_earth.
 */
const STRUCTURE_EARTH_MASS_RADIUS_ICE = 1.40
const STRUCTURE_EARTH_MASS_RADIUS_ROCK = 1.00
const STRUCTURE_EARTH_MASS_RADIUS_METAL = 0.76

/**
 * Gas giants and brown dwarfs: a Zapolsky & Salpeter (1969) style
 * interpolation between the two limits of a cold hydrogen-helium sphere,
 *
 *     R ~ M^(+1/3)   while ordinary Coulomb pressure holds the body up
 *     R ~ M^(-1/3)   once electrons are degenerate and adding mass compresses
 *
 * written as a single smooth function with a maximum in between:
 *
 *     R(M) = 2 * Rpeak * x^a / (1 + x^(2a)),   x = M / Mpeak
 *
 * Calibrated to the cold-model tables of Chabrier & Baraffe (2000): the
 * maximum sits near 4 Jupiter masses at 1.10 R_Jupiter, and a slightly soft
 * exponent (0.28 rather than 1/3) reproduces their flatness. This is the
 * regime where a body can gain a hundred times its mass and barely change
 * size, which falls out of the shape rather than being imposed.
 */
const STRUCTURE_DEGENERATE_PEAK_MASS = 4.0 * JUPITER_MASS
const STRUCTURE_DEGENERATE_PEAK_RADIUS = 1.10 * JUPITER_RADIUS
const STRUCTURE_DEGENERATE_EXPONENT = 0.28

/**
 * Main sequence, the standard empirical broken power law:
 *
 *     R/Rsun = (M/Msun)^0.80   below 1 Msun
 *     R/Rsun = (M/Msun)^0.57   above 1 Msun
 *
 * Both branches pass through (1, 1), so the relation is continuous there; only
 * its slope changes.
 */
const STRUCTURE_STELLAR_EXPONENT_LOW = 0.80
const STRUCTURE_STELLAR_EXPONENT_HIGH = 0.57

// ---------------------------------------------------------------------------
// Regime blending windows.
//
// Every boundary below is crossed with a smoothstep in log10(mass), never with
// an `if`. A step in radius would make a growing body pop on screen and would
// jolt collision detection, which keys off the radius directly.
// ---------------------------------------------------------------------------

// Quoted zero-pressure density -> interior-model density. See structureSolidRadius.
const STRUCTURE_PHASE_RAMP_LOW = -4.0        // log10(M / M_earth)
const STRUCTURE_PHASE_RAMP_HIGH = -1.0

// Below ~0.1 M_earth a body's escape speed is under the thermal speed of
// hydrogen at disk temperatures and it cannot bind an H/He envelope at all, so
// its declared gas fraction must not inflate it. The envelope switches on
// through the core-accretion range.
const STRUCTURE_ENVELOPE_RAMP_LOW = -1.0     // log10(M / M_earth)
const STRUCTURE_ENVELOPE_RAMP_HIGH = 0.5

// Above a few Jupiter masses the interior is a pressure-ionised, degenerate
// plasma whatever it was made of: metallicity moves a brown dwarf's radius by
// a few percent, not by a factor. So the solid branch is retired entirely by
// the deuterium-burning mass, regardless of composition.
const STRUCTURE_DEGENERACY_RAMP_LOW = 0.0    // log10(M / M_Jupiter)
const STRUCTURE_DEGENERACY_RAMP_HIGH = Math.log10(13)

// Hydrogen ignition halts contraction and leaves a star noticeably larger than
// the degenerate object it would otherwise have been - a real feature, and the
// only place in the whole curve where the radius climbs steeply.
const STRUCTURE_IGNITION_RAMP_LOW = Math.log10(0.060)   // log10(M / Msun)
const STRUCTURE_IGNITION_RAMP_HIGH = Math.log10(0.130)

// Precomputed so radiusFor() takes one logarithm rather than three: the mass
// expressed in other units differs only by an additive constant in log space.
const STRUCTURE_LOG_EARTH_MASS = Math.log10(EARTH_MASS)
const STRUCTURE_LOG_JUPITER_MASS = Math.log10(JUPITER_MASS)
// The mass below which no composition and no degeneracy can raise the envelope
// weight above zero, so the whole gas branch can be skipped outright. This is
// the path every disk embryo takes, 800 times a step.
const STRUCTURE_ENVELOPE_MIN_MASS = Math.min(
    Math.pow(10, STRUCTURE_ENVELOPE_RAMP_LOW) * EARTH_MASS,
    Math.pow(10, STRUCTURE_DEGENERACY_RAMP_LOW) * JUPITER_MASS)
const STRUCTURE_IGNITION_MIN_MASS = Math.pow(10, STRUCTURE_IGNITION_RAMP_LOW)

// ============================================================================
// Classification
// ============================================================================

const CLASS_ASTEROID = 'asteroid'
const CLASS_PLANET = 'planet'
const CLASS_GAS_GIANT = 'gasGiant'
const CLASS_BROWN_DWARF = 'brownDwarf'
const CLASS_STAR = 'star'

// A gas giant is a planet-mass body whose mass is mostly envelope. The mass
// floor is the runaway gas accretion threshold: below ~10 Earth masses a core
// cannot start runaway accretion, so a small body with a high gas fraction is
// a puffy planet, not a giant.
const GAS_GIANT_GAS_FRACTION = 0.5
const GAS_GIANT_MIN_MASS = 10 * EARTH_MASS

const CLASS_LABELS_PT_BR = {
    asteroid: 'Asteroide',
    planet: 'Planeta',
    gasGiant: 'Gigante gasoso',
    brownDwarf: 'Anã marrom',
    star: 'Estrela'
}

// ============================================================================
// Interior conditions
// ============================================================================

/**
 * Central temperature coefficient. The hydrostatic estimate is
 *
 *     T_c ~ G * M * mu * m_H / (k_B * R)
 *
 * which is NOT evaluated in SI anywhere in this file. Evaluated once for the
 * Sun it gives 1.39e7 K against a measured 1.57e7 K - a 12% underestimate from
 * a one-line formula, which is comfortably good enough to decide whether a core
 * ignites. That single number is all we keep, and everything else scales off
 * it:
 *
 *     T_c = 1.39e7 K * (M/Msun) / (R/Rsun) * (mu / 0.6)
 */
const SOLAR_CENTRAL_TEMPERATURE_ESTIMATE = 1.39e7    // K
const SOLAR_MEAN_MOLECULAR_WEIGHT = 0.6

/**
 * Central pressure of a uniform-density Sun, (3/(8*PI)) * G*Msun^2/Rsun^4,
 * evaluated once in SI so that nothing downstream has to be: 1.345e14 Pa.
 * Every other body is scaled off it by M^2 / R^4.
 */
const SOLAR_UNIFORM_CENTRAL_PRESSURE = 1.345e14      // Pa

/**
 * Central condensation correction for the pressure. The uniform-density result
 * underestimates the Sun's true central pressure by a factor of ~185 (1.3e14
 * against a measured 2.5e16 Pa) because a star's mass is piled into its core;
 * an n=3 polytrope recovers about half of that, and the real Sun is denser in
 * the middle still. A nearly incompressible rocky body has almost no central
 * condensation and needs a correction of only ~2 (which lands Earth at 3.5e11
 * Pa against a measured 3.6e11).
 *
 * The correction is interpolated between those two anchors across the brown
 * dwarf range.
 */
const STRUCTURE_CONDENSATION_SOLID = 2.0
const STRUCTURE_CONDENSATION_STELLAR = 185.0

// ============================================================================
// Blackbody colour
// ============================================================================

// Tanner Helland's piecewise fit to the Planckian locus (see below). It is
// only defined over this range; outside it we clamp.
const BLACKBODY_MIN_TEMPERATURE = 1000               // K
const BLACKBODY_MAX_TEMPERATURE = 40000              // K
// Colours are quantised to this before lookup, so a body drifting in
// temperature reuses the same cached object frame after frame.
const BLACKBODY_TEMPERATURE_QUANTUM = 50             // K

const STRUCTURE_COLOR_CACHE = {}
const STRUCTURE_COLOR_HEX_CACHE = {}

// ============================================================================
// Small helpers
// ============================================================================

/** Hermite smoothstep. Named apart from composition.js's global smoothStep. */
function structureSmoothStep(x, edge0, edge1) {
    if (!(edge1 > edge0)) {
        return x >= edge1 ? 1 : 0
    }
    let t = (x - edge0) / (edge1 - edge0)
    if (t <= 0) {
        return 0
    }
    if (t >= 1) {
        return 1
    }
    return t * t * (3 - 2 * t)
}

/** A finite number, or the fallback. Guards every field of the contract. */
function structureNumber(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback
}

/**
 * Geometric interpolation, i.e. linear in log(radius). Radii span fourteen
 * decades, so blending them linearly would let the larger branch swamp the
 * smaller one; blending the logarithms keeps the transition symmetric.
 */
function structureBlend(low, high, weight) {
    if (weight <= 0) {
        return low
    }
    if (weight >= 1) {
        return high
    }
    if (!(low > 0) || !(high > 0)) {
        return low > 0 ? low : high
    }
    return low * Math.pow(high / low, weight)
}

/** Radius of a sphere of given mass at constant density. */
function structureUncompressedRadius(mass, density) {
    return Math.cbrt(3 * mass / (4 * Math.PI * density))
}

/** The Seager compression factor 10^(-k2 * (M/m1)^k3); 1 at zero mass. */
function structureCompression(mass, characteristicMass) {
    // 10^x written as exp(x * ln10): same value, and exp() is the cheaper call
    // in the one place this is evaluated 800 times a step.
    return Math.exp(
        -STRUCTURE_SEAGER_K2 * Math.LN10 *
        Math.pow(mass / characteristicMass, STRUCTURE_SEAGER_K3)
    )
}

/**
 * Per-material normalisation. The zero-pressure densities in units.js are the
 * low-pressure surface values (3.2 g/cm^3 for silicate, 1.0 for ice), while the
 * Seager fits assume the high-pressure phases that actually make up a planetary
 * interior (perovskite at 4.1, ice VII at 1.5). Rather than fight over which
 * density is "right" - both are, at their own pressure - we take the surface
 * value literally for strengthless bodies and ramp in this constant, which is
 * exactly the factor that puts a pure-rock Earth-mass body at one Earth radius.
 */
function structurePhaseFactor(earthMassRadius, density, characteristicMass) {
    return (earthMassRadius * EARTH_RADIUS) /
        (structureUncompressedRadius(EARTH_MASS, density) *
            structureCompression(EARTH_MASS, characteristicMass))
}

const STRUCTURE_PHASE_ICE = structurePhaseFactor(
    STRUCTURE_EARTH_MASS_RADIUS_ICE, DENSITY_ICE, STRUCTURE_SEAGER_MASS_ICE)
const STRUCTURE_PHASE_ROCK = structurePhaseFactor(
    STRUCTURE_EARTH_MASS_RADIUS_ROCK, DENSITY_ROCK, STRUCTURE_SEAGER_MASS_ROCK)
const STRUCTURE_PHASE_METAL = structurePhaseFactor(
    STRUCTURE_EARTH_MASS_RADIUS_METAL, DENSITY_METAL, STRUCTURE_SEAGER_MASS_METAL)

// ============================================================================
// 1. Radius
// ============================================================================

/**
 * The degenerate branch: gas giants and brown dwarfs, in AU.
 *
 * Nearly flat from a third of a Jupiter mass to the hydrogen burning limit.
 * That is not a fudge and not a clamp - it is what a cold hydrogen sphere does
 * once its electrons are degenerate, and it is why Jupiter and a fifty-Jupiter
 * brown dwarf are the same size.
 */
function degenerateRadius(mass) {
    if (!(mass > 0)) {
        return 0
    }
    const x = Math.pow(mass / STRUCTURE_DEGENERATE_PEAK_MASS, STRUCTURE_DEGENERATE_EXPONENT)
    return STRUCTURE_DEGENERATE_PEAK_RADIUS * 2 * x / (1 + x * x)
}

/** The main sequence branch, in AU. */
function mainSequenceRadius(mass) {
    if (!(mass > 0)) {
        return 0
    }
    const exponent = mass < 1
        ? STRUCTURE_STELLAR_EXPONENT_LOW
        : STRUCTURE_STELLAR_EXPONENT_HIGH
    return SOLAR_RADIUS * Math.pow(mass, exponent)
}

/**
 * The condensed branch, in AU: strengthless bodies and rocky/icy planets, which
 * are one continuous expression rather than two regimes.
 *
 *     R = (3M / 4*PI*rho0)^(1/3)  *  compression(M)  *  phase(M)
 *
 * The first factor is the constant-density result the brief asks for below
 * ~1e-4 Earth masses, using the composition's own zero-pressure density; the
 * second is the Seager compression correction, which is within 1% of unity all
 * the way up to 0.01 Earth masses and only bites at planetary masses; the third
 * ramps the surface-phase density over to the interior-phase density across the
 * same range. Nothing here has a branch in it, so nothing here can step.
 *
 * `iceWeight`, `rockWeight` and `metalWeight` must sum to 1.
 */
function condensedRadius(mass, iceWeight, rockWeight, metalWeight, density, logEarthMasses) {
    if (!(mass > 0)) {
        return 0
    }
    if (logEarthMasses === undefined) {
        logEarthMasses = Math.log10(mass / EARTH_MASS)
    }
    const characteristicMass =
        iceWeight * STRUCTURE_SEAGER_MASS_ICE +
        rockWeight * STRUCTURE_SEAGER_MASS_ROCK +
        metalWeight * STRUCTURE_SEAGER_MASS_METAL

    const phase =
        iceWeight * STRUCTURE_PHASE_ICE +
        rockWeight * STRUCTURE_PHASE_ROCK +
        metalWeight * STRUCTURE_PHASE_METAL

    const ramp = structureSmoothStep(
        logEarthMasses,
        STRUCTURE_PHASE_RAMP_LOW,
        STRUCTURE_PHASE_RAMP_HIGH
    )

    return structureUncompressedRadius(mass, density) *
        structureCompression(mass, characteristicMass) *
        (1 + (phase - 1) * ramp)
}

/**
 * Zero-pressure density of the condensed part of a composition, Msun/AU^3.
 *
 * Volumes add, densities do not, so the mixture density is the volume-additive
 * (harmonic) mean 1 / sum(f_i / rho_i), not the mass-weighted mean. For a pure
 * material the two agree; for Earth's two-thirds rock, one-third iron they
 * differ by 19%, which is 6% in radius and the difference between passing and
 * failing against the real Earth. `composition.zeroPressureDensity` is the
 * documented fallback for when the individual fractions are unavailable - it
 * cannot be the primary source, because for a gas-rich body it is dominated by
 * whatever density was assumed for H/He, a quantity that has no meaning at zero
 * pressure.
 */
function condensedDensity(composition, iceWeight, rockWeight, metalWeight) {
    const inverse =
        iceWeight / DENSITY_ICE +
        rockWeight / DENSITY_ROCK +
        metalWeight / DENSITY_METAL

    if (inverse > 0 && isFinite(inverse)) {
        return 1 / inverse
    }
    const declared = structureNumber(composition && composition.zeroPressureDensity, 0)
    return declared > 0 ? declared : DENSITY_ROCK
}

/**
 * Radius of a body, in AU, from its mass in Msun and its composition.
 *
 * Four published relations, blended in log space so the curve is smooth from a
 * boulder to an O star:
 *
 *   strengthless    constant density from the composition
 *   rocky / icy     Seager et al. (2007) eq. 23, normalised to Earth
 *   giant / dwarf   Zapolsky & Salpeter degenerate interpolation
 *   main sequence   R ~ M^0.8 below 1 Msun, M^0.57 above
 *
 * Hot path: no allocation, ~6 pow() calls.
 */
function radiusFor(mass, composition) {
    if (!(mass > 0) || !isFinite(mass)) {
        return 0
    }

    let gas = 0
    let ice = 0
    let rock = 0
    let metal = 0
    if (composition) {
        gas = Math.max(0, structureNumber(composition.gasFraction, 0))
        ice = Math.max(0, structureNumber(composition.iceFraction, 0))
        rock = Math.max(0, structureNumber(composition.rockFraction, 0))
        metal = Math.max(0, structureNumber(composition.metalFraction, 0))
    }

    const declared = gas + ice + rock + metal
    const gasShare = declared > 0 ? gas / declared : 0

    let condensed = ice + rock + metal
    if (!(condensed > 0)) {
        // A body with no condensed material still needs a defined solid branch
        // to blend away from. Rock is the documented default.
        ice = 0
        rock = 1
        metal = 0
        condensed = 1
    }
    const iceWeight = ice / condensed
    const rockWeight = rock / condensed
    const metalWeight = metal / condensed

    const logMass = Math.log10(mass)
    const density = condensedDensity(composition, iceWeight, rockWeight, metalWeight)
    let radius = condensedRadius(mass, iceWeight, rockWeight, metalWeight, density,
        logMass - STRUCTURE_LOG_EARTH_MASS)

    // Below this nothing can put the body on the gas branch, whatever it claims
    // to be made of, so the whole rest of the function is skipped. Every disk
    // embryo returns here.
    if (mass < STRUCTURE_ENVELOPE_MIN_MASS) {
        return radius
    }

    // Envelope weight: how much of the body's size is set by hydrogen rather
    // than by rock. Either the composition says so (once the body is heavy
    // enough to hold an envelope), or the mass alone says so (once the interior
    // is degenerate no matter what it is made of).
    const byComposition = gasShare * structureSmoothStep(
        logMass - STRUCTURE_LOG_EARTH_MASS,
        STRUCTURE_ENVELOPE_RAMP_LOW, STRUCTURE_ENVELOPE_RAMP_HIGH)
    const byDegeneracy = structureSmoothStep(
        logMass - STRUCTURE_LOG_JUPITER_MASS,
        STRUCTURE_DEGENERACY_RAMP_LOW, STRUCTURE_DEGENERACY_RAMP_HIGH)
    const envelope = byComposition > byDegeneracy ? byComposition : byDegeneracy

    if (envelope > 0) {
        radius = structureBlend(radius, degenerateRadius(mass), envelope)
    }

    if (mass >= STRUCTURE_IGNITION_MIN_MASS) {
        radius = structureBlend(radius, mainSequenceRadius(mass),
            structureSmoothStep(logMass,
                STRUCTURE_IGNITION_RAMP_LOW, STRUCTURE_IGNITION_RAMP_HIGH))
    }

    return radius
}

/** Mean density of a body, Msun/AU^3. */
function meanDensity(mass, radius) {
    if (!(radius > 0)) {
        return 0
    }
    return mass / ((4 / 3) * Math.PI * radius * radius * radius)
}

// ============================================================================
// 2. Central temperature
// ============================================================================

/**
 * Central temperature in kelvin, from hydrostatic equilibrium.
 *
 *     T_c = 1.39e7 K * (M/Msun) / (R/Rsun) * (mu / 0.6)
 *
 * The coefficient is the SI expression G*M*mu*m_H/(k_B*R) evaluated once for
 * the Sun; see SOLAR_CENTRAL_TEMPERATURE_ESTIMATE above for why 1.39e7 and not
 * the measured 1.57e7. This is the quantity fusion decisions should key off.
 *
 * CAVEAT, and it matters for anyone thresholding on this number: the derivation
 * assumes an ideal gas held up by thermal pressure. Below about half a solar
 * mass a body is partly supported by electron degeneracy, which costs no
 * temperature at all, so the estimate runs high - and it runs high in a way
 * that gets worse as mass falls, because the radius stops shrinking while the
 * mass keeps dropping. Measured against real interiors:
 *
 *     1 Msun      1.39e7 K   vs 1.57e7 K    12% low
 *     0.08 Msun   1.19e7 K   vs ~3e6 K      4x high
 *     13 M_J      3.6e6 K    vs ~1e6 K      3x high
 *
 * So an ignition threshold set near 1e7 K would light brown dwarfs up as if
 * they were stars. Gate hydrogen burning on mass >= HYDROGEN_BURNING_MASS and
 * use this for the depth and rate of burning, not for the yes/no.
 */
function centralTemperature(mass, radius, composition) {
    if (!(radius > 0) || !(mass > 0)) {
        return 0
    }
    const mu = Math.max(0.01, structureNumber(
        composition && composition.meanMolecularWeight, SOLAR_MEAN_MOLECULAR_WEIGHT))

    return SOLAR_CENTRAL_TEMPERATURE_ESTIMATE *
        (mass / (radius / SOLAR_RADIUS)) *
        (mu / SOLAR_MEAN_MOLECULAR_WEIGHT)
}

// ============================================================================
// 3. Central pressure
// ============================================================================

/**
 * Central pressure in pascals.
 *
 * DISPLAY ONLY. This is an order-of-magnitude number for the info panel and
 * nothing in the simulation should branch on it. Fusion keys off
 * centralTemperature(), always.
 *
 * The uniform-density result P_c = (3/(8*PI)) * G*M^2/R^4 is wrong for a star
 * by a factor of ~185, because real stars are centrally condensed and a uniform
 * sphere is not; it is nearly right for a rocky planet, which genuinely is
 * close to uniform. We scale off the Sun's uniform-density value and multiply
 * by a condensation correction interpolated between those two cases, which lands
 * Earth, Jupiter and the Sun all within a factor of two of their measured
 * central pressures. Two significant figures it is not.
 */
function centralPressure(mass, radius) {
    if (!(radius > 0) || !(mass > 0)) {
        return 0
    }
    const solarRadii = radius / SOLAR_RADIUS
    const uniform = SOLAR_UNIFORM_CENTRAL_PRESSURE *
        (mass * mass) / (solarRadii * solarRadii * solarRadii * solarRadii)

    const stellar = structureSmoothStep(
        Math.log10(mass), Math.log10(DEUTERIUM_BURNING_MASS), Math.log10(0.5))
    const condensation = STRUCTURE_CONDENSATION_SOLID *
        Math.pow(STRUCTURE_CONDENSATION_STELLAR / STRUCTURE_CONDENSATION_SOLID, stellar)

    return uniform * condensation
}

// ============================================================================
// 4. Classification
// ============================================================================

/**
 * Which kind of body this is, from the mass thresholds in units.js. The
 * thresholds are not bins we chose: each is the mass at which a new nuclear
 * reaction or a new source of support switches on.
 *
 * Returns 'asteroid' | 'planet' | 'gasGiant' | 'brownDwarf' | 'star'.
 */
function classify(mass, composition) {
    if (!(mass > 0) || !isFinite(mass)) {
        return CLASS_ASTEROID
    }
    if (mass >= HYDROGEN_BURNING_MASS) {
        return CLASS_STAR
    }
    if (mass >= DEUTERIUM_BURNING_MASS) {
        return CLASS_BROWN_DWARF
    }
    if (mass < HYDROSTATIC_EQUILIBRIUM_MASS) {
        return CLASS_ASTEROID
    }
    const gas = structureNumber(composition && composition.gasFraction, 0)
    if (gas >= GAS_GIANT_GAS_FRACTION && mass >= GAS_GIANT_MIN_MASS) {
        return CLASS_GAS_GIANT
    }
    return CLASS_PLANET
}

/** Display label, pt-BR. */
function classLabel(classification) {
    return CLASS_LABELS_PT_BR[classification] || 'Corpo'
}

// ============================================================================
// 5. Luminosity
// ============================================================================

/**
 * Luminosity in solar luminosities.
 *
 * Stars follow the standard piecewise empirical mass-luminosity relation; the
 * steepness of it (L ~ M^4 around a solar mass) is why a star twice the Sun's
 * mass burns out in a tenth of the time.
 *
 * Everything below the hydrogen burning limit is essentially dark, but not
 * exactly dark, and the residual is real rather than a floor: a brown dwarf
 * burns deuterium briefly and then glows from Kelvin-Helmholtz contraction, and
 * Jupiter still radiates about 1e-9 Lsun from its own contraction, which is
 * where its 124 K effective temperature comes from. Rocky bodies emit nothing
 * of their own; their temperature comes from equilibriumTemperature() in
 * units.js instead.
 *
 * `classification` is optional; without it the class is taken from mass alone.
 */
function luminosity(mass, classification) {
    if (!(mass > 0) || !isFinite(mass)) {
        return 0
    }
    const cls = classification || classify(mass, null)

    if (cls === CLASS_STAR) {
        if (mass < 0.43) {
            return 0.23 * Math.pow(mass, 2.3)
        }
        if (mass < 2) {
            return mass * mass * mass * mass
        }
        if (mass < 55) {
            return 1.4 * Math.pow(mass, 3.5)
        }
        return 32000 * mass
    }

    if (cls === CLASS_BROWN_DWARF) {
        // ~1e-6 Lsun at the deuterium limit rising to ~1e-4 at the hydrogen
        // limit, which puts effective temperatures across the T and L dwarf
        // range (roughly 600 K to 2000 K).
        return 1e-6 * Math.pow(mass / DEUTERIUM_BURNING_MASS, 2.54)
    }

    if (cls === CLASS_GAS_GIANT) {
        return 1e-9 * (mass / JUPITER_MASS)
    }

    return 0
}

// ============================================================================
// 6. Effective temperature
// ============================================================================

/**
 * Effective (surface) temperature in kelvin, from
 *
 *     L/Lsun = (R/Rsun)^2 * (T/Tsun)^4
 *
 * rearranged. Because luminosity is carried in solar units the
 * Stefan-Boltzmann constant cancels and never appears.
 */
function effectiveTemperature(bodyLuminosity, radius) {
    if (!(radius > 0) || !(bodyLuminosity > 0) || !isFinite(bodyLuminosity)) {
        return 0
    }
    const solarRadii = radius / SOLAR_RADIUS
    return SOLAR_EFFECTIVE_TEMPERATURE *
        Math.pow(bodyLuminosity / (solarRadii * solarRadii), 0.25)
}

// ============================================================================
// 7. Blackbody colour
// ============================================================================

/**
 * Tanner Helland's piecewise fit to the Planckian locus, the usual approximation
 * for star colours. It is a least-squares fit to Mitchell Charity's blackbody
 * colour table (itself Planck's law integrated against the CIE 1931 colour
 * matching functions and converted to sRGB), and it reproduces that table to
 * within a couple of units of 255 over 1000-40000 K. Chosen over integrating
 * Planck's law directly because it is three lines and needs no SI constants.
 *
 * Sanity points: 1000 K deep red, 3000 K orange, 5772 K white with a yellow
 * cast, 10000 K blue-white, 30000 K blue.
 */
function structureComputeBlackbodyColor(temperature) {
    const t = temperature / 100
    let red
    let green
    let blue

    if (t <= 66) {
        red = 255
        green = 99.4708025861 * Math.log(t) - 161.1195681661
        blue = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
    } else {
        red = 329.698727446 * Math.pow(t - 60, -0.1332047592)
        green = 288.1221695283 * Math.pow(t - 60, -0.0755148492)
        blue = 255
    }

    return {
        r: Math.min(1, Math.max(0, red / 255)),
        g: Math.min(1, Math.max(0, green / 255)),
        b: Math.min(1, Math.max(0, blue / 255))
    }
}

/**
 * Blackbody colour as {r, g, b} in 0..1, clamped to 1000-40000 K.
 *
 * Quantised to 50 K and cached, so calling it once per body per frame costs a
 * rounding and a property lookup. THE RETURNED OBJECT IS SHARED - it is the
 * cache entry itself. Read it, never mutate it.
 */
function blackbodyColor(temperature) {
    let t = structureNumber(temperature, BLACKBODY_MIN_TEMPERATURE)
    if (t < BLACKBODY_MIN_TEMPERATURE) {
        t = BLACKBODY_MIN_TEMPERATURE
    } else if (t > BLACKBODY_MAX_TEMPERATURE) {
        t = BLACKBODY_MAX_TEMPERATURE
    }
    const bucket = Math.round(t / BLACKBODY_TEMPERATURE_QUANTUM)
    const cached = STRUCTURE_COLOR_CACHE[bucket]
    if (cached !== undefined) {
        return cached
    }
    const color = structureComputeBlackbodyColor(bucket * BLACKBODY_TEMPERATURE_QUANTUM)
    STRUCTURE_COLOR_CACHE[bucket] = color
    return color
}

/** The same colour as '#rrggbb'. Cached on the same 50 K buckets. */
function blackbodyColorHex(temperature) {
    let t = structureNumber(temperature, BLACKBODY_MIN_TEMPERATURE)
    if (t < BLACKBODY_MIN_TEMPERATURE) {
        t = BLACKBODY_MIN_TEMPERATURE
    } else if (t > BLACKBODY_MAX_TEMPERATURE) {
        t = BLACKBODY_MAX_TEMPERATURE
    }
    const bucket = Math.round(t / BLACKBODY_TEMPERATURE_QUANTUM)
    const cached = STRUCTURE_COLOR_HEX_CACHE[bucket]
    if (cached !== undefined) {
        return cached
    }
    const color = blackbodyColor(bucket * BLACKBODY_TEMPERATURE_QUANTUM)
    const packed = (Math.round(color.r * 255) << 16) |
        (Math.round(color.g * 255) << 8) |
        Math.round(color.b * 255)
    const hex = '#' + ('000000' + packed.toString(16)).slice(-6)
    STRUCTURE_COLOR_HEX_CACHE[bucket] = hex
    return hex
}

// ============================================================================
// 8. Everything at once
// ============================================================================

/**
 * The whole structure of a body in one object, for the UI and the renderer.
 *
 * Allocates - call it when something is being displayed, not once per body per
 * physics step. The individual functions above allocate nothing.
 *
 * `color` is the blackbody colour of the body's own emission, and is only
 * meaningful when `luminous` is true; a planet's colour should come from its
 * composition instead.
 */
function describe(mass, composition) {
    const radius = radiusFor(mass, composition)
    const classification = classify(mass, composition)
    const bodyLuminosity = luminosity(mass, classification)
    const surfaceTemperature = effectiveTemperature(bodyLuminosity, radius)

    return {
        radius: radius,
        density: meanDensity(mass, radius),
        centralTemperature: centralTemperature(mass, radius, composition),
        centralPressure: centralPressure(mass, radius),
        classification: classification,
        classLabel: classLabel(classification),
        luminosity: bodyLuminosity,
        effectiveTemperature: surfaceTemperature,
        luminous: bodyLuminosity > 0,
        color: blackbodyColor(surfaceTemperature)
    }
}
