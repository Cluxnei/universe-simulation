/**
 * Initial scenarios.
 *
 * The simulation no longer builds its own bodies: a scenario does, and hands
 * Simulation a finished array of Planets plus a small `meta` block describing
 * how the system should be integrated and framed. Everything here is a
 * *configuration* of the same physics; nothing in this file is a law of nature
 * and nothing here is read once the run has started.
 *
 * Units are the simulation's own throughout: solar masses, astronomical units,
 * years, G = 4*PI^2 (units.js).
 *
 * CONVENTIONS THAT MATTER
 *
 *  - Orbits are built with textbook elements in the standard z-normal frame and
 *    mapped by (x, y, z) -> (x, z, -y), so every disk here lies in the xz-plane
 *    with its angular momentum along +y. That is the renderer's up axis, so the
 *    camera orbits the pole of the disk instead of tumbling across it.
 *  - Every scenario returns bodies whose total momentum is zero and whose
 *    centre of mass is the origin. Scenarios that deliberately drift say so in
 *    `meta.notes`; none currently do.
 *  - Stars are flagged `isStar = true`. Simulation direct-sums those outside
 *    the Barnes-Hut tree and picks the dominant one as `simulation.star`.
 *
 * User-facing strings are pt-BR; comments are English.
 */

// --- Deterministic pseudo-random source ---------------------------------------
/**
 * A seeded generator, so a scenario can be reproduced exactly from a number.
 *
 * mulberry32: 32 bits of state, a single multiply-xorshift round, period 2^32.
 * It is not cryptographic and does not need to be - it only has to be uniform,
 * fast and, above all, *repeatable*, which Math.random is not. With seed 0 (or
 * no seed) it forwards to Math.random and the run is not reproducible.
 */
class ScenarioRandom{
    constructor(seed){
        const value = Math.floor(Number(seed))
        this.seeded = isFinite(value) && value > 0
        this.state = (this.seeded ? value : 1) >>> 0
        this.spare = null
    }

    next(){
        if(!this.seeded)
            return Math.random()
        this.state = (this.state + 0x6D2B79F5) >>> 0
        let t = this.state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }

    uniform(min, max){
        return min + (max - min) * this.next()
    }

    /** Standard normal, Box-Muller. The second variate is cached, not thrown away. */
    normal(){
        if(this.spare !== null){
            const value = this.spare
            this.spare = null
            return value
        }
        // 1 - u so the log never sees exactly zero.
        const u = 1 - this.next()
        const v = this.next()
        const radius = Math.sqrt(-2 * Math.log(u))
        const angle = 2 * Math.PI * v
        this.spare = radius * Math.sin(angle)
        return radius * Math.cos(angle)
    }

    /**
     * Rayleigh variate with the requested RMS. For a Rayleigh distribution
     * E[x^2] = 2*sigma^2, so sigma = rms/sqrt(2) and the inverse transform is
     * x = rms * sqrt(-ln u). This is the distribution real embryo swarms have
     * in eccentricity and inclination.
     */
    rayleigh(rms){
        return rms * Math.sqrt(-Math.log(1 - this.next()))
    }

    /** A unit vector uniform on the sphere. Sampling cos(theta), not theta. */
    direction(out){
        const cosTheta = this.uniform(-1, 1)
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
        const phi = this.uniform(0, 2 * Math.PI)
        const target = out || new Vector()
        return target.set(sinTheta * Math.cos(phi), cosTheta, sinTheta * Math.sin(phi))
    }
}

// --- Small numeric helpers ----------------------------------------------------

function scenarioClamp(value, min, max){
    if(!isFinite(value)) return min
    if(value < min) return min
    if(value > max) return max
    return value
}

/**
 * Kroupa (2001) initial mass function, sampled by inverse transform.
 *
 *     dN/dm ~ m^-1.3   for  0.08 <= m < 0.5 Msun
 *     dN/dm ~ m^-2.3   for  m >= 0.5 Msun
 *
 * This is the real distribution of stellar masses at birth and it is nothing
 * like uniform: it is dominated in number by red dwarfs and in light by the
 * handful of massive stars in the tail. A cluster sampled uniformly would look
 * and behave completely wrong - every star roughly equal, no dominant member,
 * no mass segregation.
 *
 * The two segments are joined continuously (k2 = k1 * mBreak^(a2-a1)) and each
 * is integrated analytically, so the sampler is exact rather than rejection
 * based and costs one random number.
 */
const KROUPA_BREAK_MASS = 0.5           // Msun
const KROUPA_SLOPE_LOW = 1.3
const KROUPA_SLOPE_HIGH = 2.3

function sampleKroupaMass(rng, minMass, maxMass){
    const low = Math.max(1e-4, minMass > 0 ? minMass : HYDROGEN_BURNING_MASS)
    const high = Math.max(low * 1.0001, maxMass > 0 ? maxMass : 50)
    const brk = scenarioClamp(KROUPA_BREAK_MASS, low, high)
    const a1 = KROUPA_SLOPE_LOW, a2 = KROUPA_SLOPE_HIGH
    const p1 = 1 - a1, p2 = 1 - a2
    // Integral of m^-a over a segment, with the continuity constant folded in.
    const lowBrk = Math.pow(brk, p1)
    const lowMin = Math.pow(low, p1)
    const i1 = brk > low ? (lowBrk - lowMin) / p1 : 0
    const k2 = Math.pow(brk, a2 - a1)
    const highMax = Math.pow(high, p2)
    const highBrk = Math.pow(brk, p2)
    const i2 = high > brk ? k2 * (highMax - highBrk) / p2 : 0
    const total = i1 + i2
    if(!(total > 0)) return brk
    const u = rng.next() * total
    if(u < i1){
        const value = Math.pow(lowMin + u * p1, 1 / p1)
        return scenarioClamp(value, low, high)
    }
    const v = (u - i1) / k2
    const value = Math.pow(highBrk + v * p2, 1 / p2)
    return scenarioClamp(value, low, high)
}

/**
 * Move the whole set to its barycentre and kill the net momentum.
 *
 * Nothing is scaled: the orbits were built Keplerian and must stay that way.
 * This is a pure Galilean transformation, so it changes no relative motion and
 * no energy of relative motion - only the frame.
 */
function scenarioCenter(bodies){
    const n = bodies.length
    if(n === 0) return bodies
    let totalMass = 0
    let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0
    for(let i = 0; i < n; i++){
        const body = bodies[i]
        totalMass += body.mass
        cx += body.mass * body.position.x
        cy += body.mass * body.position.y
        cz += body.mass * body.position.z
        vx += body.mass * body.velocity.x
        vy += body.mass * body.velocity.y
        vz += body.mass * body.velocity.z
    }
    if(!(totalMass > 0)) return bodies
    cx /= totalMass; cy /= totalMass; cz /= totalMass
    vx /= totalMass; vy /= totalMass; vz /= totalMass
    for(let i = 0; i < n; i++){
        const body = bodies[i]
        body.position.x -= cx
        body.position.y -= cy
        body.position.z -= cz
        body.velocity.x -= vx
        body.velocity.y -= vy
        body.velocity.z -= vz
        body.previousPosition.copyFrom(body.position)
    }
    return bodies
}

// --- Irradiation and composition ----------------------------------------------

/**
 * Equilibrium temperature at a point, heated by EVERY star in the system.
 *
 * Irradiation is a flux, and fluxes add:
 *
 *     T(p)^4 = SUM_i T_i(|p - p_i|)^4,   T_i(r) = Tstar_i * sqrt(Rstar_i / 2r)
 *
 * so a body sitting midway between two suns really is hotter than one the same
 * distance from a single sun - by 2^(1/4) = 1.19 for two identical stars. With
 * one star this collapses exactly to the single-star formula the disk has
 * always used, so the default scenario is bit-for-bit unchanged.
 *
 * The consequence is that with several stars the snow line is not a radius at
 * all: it is a level set of this field, a surface that bulges around the
 * brighter star and is pushed outward in between them.
 */
function scenarioIrradiationTemperature(x, y, z, stars){
    let quartic = 0
    for(let i = 0; i < stars.length; i++){
        const star = stars[i]
        if(!star || !(star.effectiveTemperature > 0) || !(star.radius > 0)) continue
        const dx = x - star.position.x
        const dy = y - star.position.y
        const dz = z - star.position.z
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
        // Inside the photosphere there is no geometric dilution left to apply.
        const temperature = distance <= star.radius
            ? star.effectiveTemperature
            : Composition.formationTemperature(distance, star.effectiveTemperature, star.radius)
        if(isFinite(temperature) && temperature > 0)
            quartic += temperature * temperature * temperature * temperature
    }
    if(!(quartic > 0)) return 0
    return Math.pow(quartic, 0.25)
}

/**
 * Composition of a solid body that condensed at a given temperature.
 *
 * This is exactly Composition.fromFormationRadius(), expressed in temperature
 * instead of radius so that it can be driven by the summed multi-star field
 * above. With the solar rock:metal split it reproduces that function's output
 * identically: ice = 0.5 outside the line, and the dry remainder shared 2:1
 * between silicate and iron.
 *
 * `rockShare` and `metalShare` are the split of the *dry* fraction and let a
 * scenario ask for an iron-poor or an iron-rich nebula without touching the
 * snow-line physics.
 */
function scenarioSolidComposition(temperature, rockShare, metalShare){
    const condensed = compositionSmoothStep(
        SNOW_LINE_TEMPERATURE * (1 + SNOW_LINE_TRANSITION_WIDTH),
        SNOW_LINE_TEMPERATURE * (1 - SNOW_LINE_TRANSITION_WIDTH),
        temperature
    )
    const ice = ICY_ICE_FRACTION * condensed
    const dry = 1 - ice
    let rock = rockShare > 0 ? rockShare : DRY_ROCK_FRACTION
    let metal = metalShare > 0 ? metalShare : DRY_METAL_FRACTION
    const sum = rock + metal
    rock /= sum
    metal /= sum
    return Composition.fromCategories(0, ice, dry * rock, dry * metal)
}

/**
 * The three nebular presets the random generator offers.
 *
 *  - primordial: what came out of the Big Bang, X ~ 0.75 / Y ~ 0.25 and no
 *    metals at all. Population III. Solids can barely form; what little there
 *    is is silicate-dominated because there is almost no iron.
 *  - solar: the mix this simulation has always used, X = 0.71, Y = 0.27,
 *    Z = 0.02, with the dry solids 2/3 rock and 1/3 iron - Earth.
 *  - enriched: a metal-rich nebula, Z ~ 0.10, the kind found around the
 *    high-metallicity stars that host most known giant planets. Its solids are
 *    half iron, so its planets come out dense.
 */
function scenarioCompositionPreset(id){
    if(id === 'primordial'){
        return {
            star: () => Composition.fromCategories(1, 0, 0, 0),
            rockShare: 0.85,
            metalShare: 0.15
        }
    }
    if(id === 'enriched'){
        return {
            star: () => Composition.fromCategories(0.90, 0.02, 0.053, 0.027),
            rockShare: 0.5,
            metalShare: 0.5
        }
    }
    return {
        star: () => new Composition(),
        rockShare: DRY_ROCK_FRACTION,
        metalShare: DRY_METAL_FRACTION
    }
}

// --- Body construction --------------------------------------------------------

/** A star: nebular (or preset) mix, flagged for the direct-sum path. */
function scenarioMakeStar(mass, composition, position, velocity){
    const star = new Planet(
        position || new Vector(),
        velocity || new Vector(),
        Math.max(mass, HYDROGEN_BURNING_MASS * 1e-3),
        composition || new Composition()
    )
    star.isStar = true
    return star
}

/**
 * Position and velocity of a Kepler orbit with the given elements, with random
 * node, argument of periapsis and true anomaly.
 *
 * The perifocal speed is written in terms of the circular speed at the same
 * semi-major axis, because
 *
 *     sqrt(mu/p) = circularOrbitalSpeed(a) / sqrt(1 - e^2)
 *
 * so a body with e = 0 gets exactly circularOrbitalSpeed(a), and the unit
 * system's defining property (1 AU around 1 Msun closes in 1 year) stays
 * visible in the code instead of being buried in a mu.
 *
 * Results are written into `outPosition` / `outVelocity`, already rotated from
 * the z-normal frame into the +y-normal disk plane.
 */
function scenarioOrbitState(semiMajorAxis, eccentricity, inclination, centralMass, rng, outPosition, outVelocity){
    const node = rng.uniform(0, 2 * Math.PI)
    const periapsis = rng.uniform(0, 2 * Math.PI)
    const anomaly = rng.uniform(0, 2 * Math.PI)
    const cosF = Math.cos(anomaly)
    const sinF = Math.sin(anomaly)
    const oneMinusE2 = Math.max(1e-9, 1 - eccentricity * eccentricity)
    const distance = semiMajorAxis * oneMinusE2 / (1 + eccentricity * cosF)
    const speed = circularOrbitalSpeed(semiMajorAxis, centralMass) / Math.sqrt(oneMinusE2)
    const px = distance * cosF
    const py = distance * sinF
    const vx = -speed * sinF
    const vy = speed * (eccentricity + cosF)
    const cosW = Math.cos(periapsis), sinW = Math.sin(periapsis)
    const cosI = Math.cos(inclination), sinI = Math.sin(inclination)
    const cosO = Math.cos(node), sinO = Math.sin(node)
    const m11 = cosO * cosW - sinO * sinW * cosI
    const m12 = -cosO * sinW - sinO * cosW * cosI
    const m21 = sinO * cosW + cosO * sinW * cosI
    const m22 = -sinO * sinW + cosO * cosW * cosI
    const m31 = sinW * sinI
    const m32 = cosW * sinI
    const x = m11 * px + m12 * py
    const y = m21 * px + m22 * py
    const z = m31 * px + m32 * py
    const ux = m11 * vx + m12 * vy
    const uy = m21 * vx + m22 * vy
    const uz = m31 * vx + m32 * vy
    // z-normal frame -> disk plane (normal +y)
    outPosition.set(x, z, -y)
    outVelocity.set(ux, uz, -uy)
    return outPosition
}

/**
 * Inverse-transform sample of the surface density profile Sigma(r) ~ r^-p
 * between the disk edges.
 *
 * The mass in an annulus is Sigma(r)*2*pi*r*dr ~ r^(1-p) dr, so the cumulative
 * mass goes as r^(2-p) and the sample is
 *
 *     r = [ rin^q + u*(rout^q - rin^q) ]^(1/q),   q = 2 - p
 *
 * Sampling r uniformly instead would pile mass into the outer disk, where it
 * would never accrete into anything.
 */
function scenarioSampleDiskRadius(inner, outer, exponent, rng){
    if(!(outer > inner)) return inner
    const q = 2 - exponent
    const u = rng.next()
    if(Math.abs(q) < 1e-9)
        return inner * Math.pow(outer / inner, u)
    const low = Math.pow(inner, q)
    const high = Math.pow(outer, q)
    return Math.pow(low + u * (high - low), 1 / q)
}

/**
 * A protoplanetary disk of embryos around `centre` (a star, or the barycentre
 * of a binary given as a plain {position, velocity, mass}).
 *
 * Compositions come from the SUMMED irradiation of `stars`, not from the host
 * star alone, so a disk shared between two suns condenses correctly: its snow
 * line sits further out than either star would put it on its own.
 */
function scenarioBuildDisk(options){
    const rng = options.rng
    const count = Math.max(0, Math.floor(options.count || 0))
    const bodies = []
    if(count === 0 || !(options.totalMass > 0)) return bodies
    const inner = options.inner
    const outer = options.outer
    const exponent = options.exponent !== undefined ? options.exponent : DISK_SURFACE_DENSITY_EXPONENT
    const eccentricityRms = options.eccentricityRms !== undefined ? options.eccentricityRms : DISK_ECCENTRICITY_RMS
    const inclinationRms = options.inclinationRms !== undefined ? options.inclinationRms : DISK_INCLINATION_RMS
    const centre = options.centre
    const centralMass = options.centralMass > 0 ? options.centralMass : centre.mass
    const stars = options.stars || [centre]
    const rockShare = options.rockShare !== undefined ? options.rockShare : DRY_ROCK_FRACTION
    const metalShare = options.metalShare !== undefined ? options.metalShare : DRY_METAL_FRACTION
    const embryoMass = options.totalMass / count
    const position = new Vector()
    const velocity = new Vector()
    for(let i = 0; i < count; i++){
        const semiMajorAxis = scenarioSampleDiskRadius(inner, outer, exponent, rng)
        const eccentricity = Math.min(0.9, rng.rayleigh(eccentricityRms))
        const inclination = rng.rayleigh(inclinationRms)
        scenarioOrbitState(semiMajorAxis, eccentricity, inclination, centralMass, rng, position, velocity)
        position.add(centre.position)
        velocity.add(centre.velocity)
        const temperature = scenarioIrradiationTemperature(position.x, position.y, position.z, stars)
        bodies.push(new Planet(
            position.copy(), velocity.copy(), embryoMass,
            scenarioSolidComposition(temperature, rockShare, metalShare)
        ))
    }
    return bodies
}

// --- Time step and framing ----------------------------------------------------

/**
 * Steps per orbit that Velocity-Verlet needs before the innermost orbit starts
 * to precess visibly. Twenty is the textbook minimum; a hundred is what the
 * default disk has always used, and star-star pairs get twice that because the
 * two bodies are equal partners and the pair's period is the whole dynamic.
 */
const SCENARIO_STEPS_PER_ORBIT = 100
const SCENARIO_STEPS_PER_STELLAR_ORBIT = 200
const SCENARIO_MIN_DT = 1e-6
const SCENARIO_MAX_DT = 2.0

/**
 * Timestep from the shortest orbital period actually present in the system.
 *
 * Every body is measured against the star that dominates it, and every pair of
 * stars against each other. A tight binary or a close cluster pair therefore
 * drives the timestep down automatically, which is the whole point: the same
 * dt that is comfortable for a 20 AU disk is catastrophically wrong for two
 * suns 0.1 AU apart.
 */
function scenarioSuggestedTimestep(bodies, stars, fallback, stepsPerOrbit){
    const perOrbit = stepsPerOrbit > 0 ? stepsPerOrbit : SCENARIO_STEPS_PER_ORBIT
    let shortest = Infinity
    for(let i = 0; i < bodies.length; i++){
        const body = bodies[i]
        if(body.isStar) continue
        let best = 0
        let bestPull = 0
        for(let s = 0; s < stars.length; s++){
            const star = stars[s]
            const distance = body.position.distanceTo(star.position)
            if(!(distance > 0)) continue
            const pull = star.mass / (distance * distance)
            if(pull > bestPull){
                bestPull = pull
                best = orbitalPeriod(distance, star.mass + body.mass)
            }
        }
        if(best > 0 && best < shortest) shortest = best
    }
    let candidate = shortest / perOrbit
    for(let i = 0; i < stars.length; i++){
        for(let j = i + 1; j < stars.length; j++){
            const distance = stars[i].position.distanceTo(stars[j].position)
            if(!(distance > 0)) continue
            const period = orbitalPeriod(distance, stars[i].mass + stars[j].mass)
            const pairStep = period / (perOrbit * 2)
            if(pairStep < candidate) candidate = pairStep
        }
    }
    if(!isFinite(candidate) || !(candidate > 0))
        candidate = fallback > 0 ? fallback : FIXED_DT
    return scenarioClamp(candidate, SCENARIO_MIN_DT, SCENARIO_MAX_DT)
}

/**
 * Extra timestep constraint for an encounter: the pair must not cross its own
 * merge radius in one step, or the swept collision test is the only thing left
 * holding the physics together and the approach itself is integrated wrongly.
 *
 * `speed` is the relative speed at contact, obtained from energy conservation
 * along the incoming hyperbola.
 */
function scenarioEncounterTimestep(starA, starB, relativeVelocity, closestApproach){
    const contact = (starA.accretionRadius + starB.accretionRadius) *
        (USE_GRAVITATIONAL_FOCUSING ? GRAVITATIONAL_FOCUSING_MAX : 1)
    const separation = Math.max(contact, closestApproach > 0 ? closestApproach : contact)
    const mu = GRAVITATION_CONSTANT * (starA.mass + starB.mass)
    const speed = Math.sqrt(relativeVelocity * relativeVelocity + 2 * mu / separation)
    if(!(speed > 0)) return SCENARIO_MAX_DT
    // Fifty steps to traverse the contact sphere.
    return scenarioClamp(contact / speed / 50, SCENARIO_MIN_DT, SCENARIO_MAX_DT)
}

/**
 * Timestep a self-gravitating swarm needs to survive its own close encounters.
 *
 * Sizing dt on the closest pair at t = 0 is not enough and never was: the
 * dangerous encounter is the one that has not happened yet. The right scale is
 * the 90-degree deflection radius, the separation at which a two-body encounter
 * turns a star through a right angle,
 *
 *     r90 = 2 G <m> / sigma^2
 *
 * with sigma the velocity dispersion, which for a virialised uniform sphere is
 * sigma^2 = 3 G M / 5 R. A pair crosses r90 in r90/sigma, and that passage has
 * to be resolved or the integrator invents energy. Measured over 200 years on
 * the default 60-star, 30 Msun, 200 AU cluster across several draws, the worst
 * case runs: 200 steps per crossing -> 3.6% of the total energy invented,
 * 800 -> 0.4%, 1600 -> 1e-5. The knee is around 800, which is what is used;
 * the timestep the *initial* closest pair alone would suggest is sixteen times
 * larger and lets the cluster unbind itself outright, because the encounter
 * that breaks the integration is always one that has not happened yet.
 *
 * r90 is capped at the swarm's own radius: when it comes out larger the system
 * is strongly interacting everywhere and there is no separate encounter scale
 * left to resolve.
 */
const SCENARIO_STEPS_PER_ENCOUNTER = 800

function scenarioSwarmTimestep(totalMass, radius, meanMass, virialRatio){
    if(!(totalMass > 0) || !(radius > 0) || !(meanMass > 0))
        return SCENARIO_MAX_DT
    const ratio = Math.max(0.25, virialRatio > 0 ? virialRatio : 1)
    const sigmaSquared = 3 * GRAVITATION_CONSTANT * totalMass / (5 * radius) * ratio
    if(!(sigmaSquared > 0)) return SCENARIO_MAX_DT
    const sigma = Math.sqrt(sigmaSquared)
    const deflection = Math.min(2 * GRAVITATION_CONSTANT * meanMass / sigmaSquared, radius)
    return scenarioClamp(deflection / sigma / SCENARIO_STEPS_PER_ENCOUNTER,
        SCENARIO_MIN_DT, SCENARIO_MAX_DT)
}

/**
 * Closest approach of an encounter, from the state it is actually launched in.
 *
 * The scenarios below start their two stars at a finite separation D with a
 * perpendicular offset b and a purely approaching speed v, so v is the speed
 * THERE and not the speed at infinity - the two differ by the potential the
 * pair has yet to fall through, which at 25 AU is a third of the kinetic
 * energy. Treating one as the other puts the predicted periapsis and the
 * predicted encounter time visibly wrong, so both are derived from the two
 * conserved quantities of the launch state instead:
 *
 *     L  = b*v                      (specific angular momentum, v perp to b)
 *     2E = v^2 - 2mu/D              (twice the specific energy)
 *
 * Periapsis is where the radial velocity vanishes, vq = L/q, which gives
 *
 *     2E q^2 + 2mu q - L^2 = 0
 *
 * and the physical root. E > 0 is a hyperbola that never returns; E < 0 is an
 * ellipse and the same root is its periapsis, so both cases are covered.
 */
function scenarioEncounterPeriapsis(totalMass, separation, offset, speed){
    const mu = GRAVITATION_CONSTANT * totalMass
    if(!(separation > 0) || !(mu > 0)) return 0
    const angularMomentum = offset * speed
    const twiceEnergy = speed * speed - 2 * mu / separation
    if(Math.abs(twiceEnergy) < 1e-12)
        // Parabolic: 2mu q = L^2 exactly.
        return angularMomentum * angularMomentum / (2 * mu)
    const discriminant = mu * mu + twiceEnergy * angularMomentum * angularMomentum
    if(!(discriminant >= 0)) return 0
    const root = (-mu + Math.sqrt(discriminant)) / twiceEnergy
    return root > 0 ? Math.min(root, separation) : 0
}

/**
 * Time from the initial separation to closest approach, in years.
 *
 * The radial equation of the two-body problem,
 *
 *     (dr/dt)^2 = 2E + 2mu/r - L^2/r^2
 *
 * integrated from the periapsis q out to the starting separation D, with E and
 * L taken from the launch state exactly as above. The
 * integrand diverges as 1/sqrt(r - q) at the periapsis, so the substitution
 * r = q + s^2 is applied first, which cancels it exactly and leaves a smooth
 * integrand for Simpson's rule.
 *
 * A free-fall estimate D/v is 30-50% wrong here because the pair accelerates
 * the whole way in, and this is the number shown to the user as "the encounter
 * happens at about T years" - it has to be right or the scenario looks broken.
 */
function scenarioEncounterTime(totalMass, separation, offset, speed){
    const mu = GRAVITATION_CONSTANT * totalMass
    const angularMomentum = offset * speed
    const twiceEnergy = speed * speed - 2 * mu / separation
    const l2 = angularMomentum * angularMomentum
    const periapsis = scenarioEncounterPeriapsis(totalMass, separation, offset, speed)
    const span = separation - periapsis
    if(!(span > 0)) return 0
    const upper = Math.sqrt(span)
    const samples = 400
    const h = upper / samples
    let total = 0
    for(let k = 0; k <= samples; k++){
        const s = k * h
        const r = periapsis + s * s
        let speedSquared = twiceEnergy + 2 * mu / r - l2 / (r * r)
        if(!(speedSquared > 0)) speedSquared = 0
        const radial = Math.sqrt(speedSquared)
        // 2s/|dr/dt|; at s = 0 both vanish together and the limit is finite,
        // so the endpoint is simply skipped rather than dividing by zero.
        const value = radial > 0 ? 2 * s / radial : 0
        const weight = (k === 0 || k === samples) ? 1 : (k % 2 === 1 ? 4 : 2)
        total += weight * value
    }
    return total * h / 3
}

/** Radius that contains every body, for the opening camera distance. */
function scenarioExtent(bodies){
    let extent = 0
    for(let i = 0; i < bodies.length; i++){
        const distance = bodies[i].position.magnitude()
        if(distance > extent) extent = distance
    }
    return extent
}

// --- Parameter plumbing -------------------------------------------------------

function scenarioCoerceParam(spec, raw){
    if(spec.type === 'bool'){
        if(raw === undefined || raw === null) return !!spec.default
        if(typeof raw === 'string')
            return raw !== '' && raw !== 'false' && raw !== '0' && raw !== 'nao' && raw !== 'não'
        return !!raw
    }
    if(spec.type === 'choice'){
        const choices = spec.choices || []
        for(let i = 0; i < choices.length; i++){
            if(choices[i].value === raw) return raw
        }
        return spec.default
    }
    let value = Number(raw)
    if(!isFinite(value)) value = spec.default
    if(spec.type === 'int') value = Math.round(value)
    if(typeof spec.min === 'number' && value < spec.min) value = spec.min
    if(typeof spec.max === 'number' && value > spec.max) value = spec.max
    if(!isFinite(value)) value = spec.default
    return value
}

/**
 * Every declared parameter, defaulted and clamped. Unknown keys in `params`
 * are ignored and missing ones fall back to the default, so build({}) always
 * works and a stale UI can never inject a value the scenario did not declare.
 */
function scenarioResolveParams(descriptor, params){
    const source = params || {}
    const resolved = {}
    const specs = descriptor.params || []
    for(let i = 0; i < specs.length; i++){
        const spec = specs[i]
        resolved[spec.key] = scenarioCoerceParam(spec, source[spec.key])
    }
    return resolved
}

// --- Shared parameter specs ---------------------------------------------------

const SCENARIO_COMPOSITION_CHOICES = [
    { value: 'primordial', label: 'Primordial (H/He)' },
    { value: 'solar', label: 'Solar (X=0,71 Y=0,27 Z=0,02)' },
    { value: 'enriched', label: 'Enriquecida (rica em metais)' }
]

const SCENARIO_LAYOUT_CHOICES = [
    { value: 'disk', label: 'Disco (achatado, em rotação)' },
    { value: 'sphere', label: 'Esfera (isotrópica)' }
]

// --- 1. Planetary system ------------------------------------------------------

const SCENARIO_PLANETARY_SYSTEM = {
    id: 'planetary-system',
    name: 'Sistema planetário',
    description: 'Uma estrela e um disco protoplanetário de embriões. É a ' +
        'configuração clássica: a linha de gelo sai da luminosidade da estrela ' +
        'e decide do que cada corpo é feito.',
    category: 'sistema',
    params: [
        {
            key: 'starMass', label: 'Massa da estrela', type: 'float',
            default: STAR_MASS, min: 0.08, max: 50, step: 0.01, unit: 'M☉',
            help: 'Define a luminosidade e, com ela, a posição da linha de gelo.'
        },
        {
            key: 'diskMass', label: 'Massa do disco', type: 'float',
            default: DISK_TOTAL_MASS, min: 0, max: 0.1, step: 1e-4, unit: 'M☉',
            help: 'Massa sólida total repartida entre todos os embriões.'
        },
        {
            key: 'bodyCount', label: 'Número de corpos', type: 'int',
            default: PLANETS_NUMBER, min: 0, max: 4000, step: 10,
            help: 'Embriões no disco. Mais corpos, mais colisões e menos quadros por segundo.'
        },
        {
            key: 'innerRadius', label: 'Raio interno', type: 'float',
            default: DISK_INNER_RADIUS, min: 0.05, max: 100, step: 0.05, unit: 'UA',
            help: 'A borda interna fixa o passo de tempo: é a órbita mais rápida do sistema.'
        },
        {
            key: 'outerRadius', label: 'Raio externo', type: 'float',
            default: DISK_OUTER_RADIUS, min: 0.1, max: 500, step: 0.5, unit: 'UA'
        }
    ],
    build(params){
        const p = scenarioResolveParams(SCENARIO_PLANETARY_SYSTEM, params)
        const rng = new ScenarioRandom(0)
        const inner = Math.min(p.innerRadius, p.outerRadius * 0.95)
        const outer = Math.max(p.outerRadius, inner * 1.05)
        const star = scenarioMakeStar(p.starMass, new Composition())
        const stars = [star]
        const bodies = [star]
        const disk = scenarioBuildDisk({
            rng, count: p.bodyCount, totalMass: p.diskMass,
            inner, outer, centre: star, centralMass: star.mass, stars
        })
        for(let i = 0; i < disk.length; i++) bodies.push(disk[i])
        scenarioCenter(bodies)
        // The inner edge is the fastest orbit, and the analytic period there is
        // a better bound than the sampled minimum: it does not wobble with the
        // random draw, so the default scenario reproduces FIXED_DT exactly.
        const suggestedDt = scenarioClamp(
            orbitalPeriod(inner, star.mass) / SCENARIO_STEPS_PER_ORBIT,
            SCENARIO_MIN_DT, SCENARIO_MAX_DT
        )
        return {
            bodies,
            meta: {
                label: 'Sistema planetário',
                suggestedDt,
                cameraDistance: 2 * outer,
                diskNormal: { x: 0, y: 1, z: 0 },
                gasAccretion: true,
                fusion: true,
                gasInnerRadius: inner,
                gasOuterRadius: outer,
                notes: 'Linha de gelo em ' +
                    Composition.snowLineRadius(star.effectiveTemperature, star.radius).toFixed(2) +
                    ' UA. Dentro dela os corpos são secos; fora, gelados.'
            }
        }
    }
}

// --- 2. Binary star -----------------------------------------------------------

/**
 * Holman & Wiegert (1999) critical semi-major axis for a stable P-type
 * (circumbinary) orbit, in units of the binary separation. Inside it a test
 * particle is ejected within a few hundred binary periods; the disk therefore
 * starts outside it, which is exactly why real circumbinary planets (Kepler-16
 * and its kin) all sit just beyond the same limit.
 */
function scenarioCircumbinaryLimit(massA, massB, eccentricity){
    const total = massA + massB
    const mu = total > 0 ? Math.min(massA, massB) / total : 0.5
    const e = scenarioClamp(eccentricity, 0, 0.9)
    return 1.60 + 5.10 * e - 2.22 * e * e + 4.12 * mu -
        4.27 * e * mu - 5.09 * mu * mu + 4.61 * e * e * mu * mu
}

const SCENARIO_BINARY_STAR = {
    id: 'binary-star',
    name: 'Estrela binária',
    description: 'Duas estrelas em órbita mútua em torno do baricentro comum, ' +
        'com um disco circumbinário opcional. O disco começa fora do limite de ' +
        'estabilidade de Holman-Wiegert, onde os planetas circumbinários reais vivem.',
    category: 'multiplo',
    params: [
        {
            key: 'massA', label: 'Massa da estrela A', type: 'float',
            default: 1.0, min: 0.08, max: 50, step: 0.01, unit: 'M☉'
        },
        {
            key: 'massB', label: 'Massa da estrela B', type: 'float',
            default: 0.8, min: 0.08, max: 50, step: 0.01, unit: 'M☉'
        },
        {
            key: 'separation', label: 'Semieixo maior da binária', type: 'float',
            default: 1.0, min: 0.05, max: 200, step: 0.05, unit: 'UA',
            help: 'Separação média das duas estrelas. Binárias apertadas exigem ' +
                'um passo de tempo muito menor.'
        },
        {
            key: 'eccentricity', label: 'Excentricidade', type: 'float',
            default: 0.3, min: 0, max: 0.9, step: 0.01,
            help: 'Excentricidades altas são reduzidas automaticamente se o ' +
                'periastro cair dentro do raio de fusão das estrelas.'
        },
        {
            key: 'disk', label: 'Disco circumbinário', type: 'bool', default: true
        },
        {
            key: 'bodyCount', label: 'Corpos no disco', type: 'int',
            default: 600, min: 0, max: 4000, step: 10
        },
        {
            key: 'diskWidth', label: 'Largura do disco', type: 'float',
            default: 20, min: 1, max: 400, step: 0.5, unit: 'UA',
            help: 'Espessura radial do disco a partir do limite de estabilidade.'
        }
    ],
    build(params){
        const p = scenarioResolveParams(SCENARIO_BINARY_STAR, params)
        const rng = new ScenarioRandom(0)
        const massA = p.massA, massB = p.massB
        const total = massA + massB
        const a = p.separation
        const starA = scenarioMakeStar(massA, new Composition())
        const starB = scenarioMakeStar(massB, new Composition())
        // Clamp the eccentricity so the pair does not reach periapsis inside its
        // own (inflated) merge radius on the first orbit and vanish.
        const contact = (starA.accretionRadius + starB.accretionRadius) * GRAVITATIONAL_FOCUSING_MAX
        // Twice the merge radius leaves a comfortable margin at periapsis
        // without forbidding the eccentric orbits that make a binary interesting.
        const minPeriapsis = 2 * contact
        let e = p.eccentricity
        let clamped = false
        if(a * (1 - e) < minPeriapsis){
            e = scenarioClamp(1 - minPeriapsis / a, 0, p.eccentricity)
            clamped = true
        }
        // Start at apoapsis: the slowest, widest point of the orbit, so the
        // opening frame is the least demanding one for the integrator.
        const apoapsis = a * (1 + e)
        const mu = GRAVITATION_CONSTANT * total
        const speed = Math.sqrt(mu / a * (1 - e) / (1 + e))
        // Relative position along +x, relative velocity along -z, so the
        // angular momentum r x v points along +y like every disk here.
        starA.position.set(-apoapsis * massB / total, 0, 0)
        starB.position.set(apoapsis * massA / total, 0, 0)
        starA.velocity.set(0, 0, speed * massB / total)
        starB.velocity.set(0, 0, -speed * massA / total)
        const stars = [starA, starB]
        const bodies = [starA, starB]
        const limit = scenarioCircumbinaryLimit(massA, massB, e)
        const inner = limit * a * 1.05
        const outer = inner + p.diskWidth
        if(p.disk && p.bodyCount > 0){
            // The disk orbits the barycentre, which is the origin here, and sees
            // the summed light of both stars.
            const barycentre = { position: new Vector(), velocity: new Vector(), mass: total }
            const disk = scenarioBuildDisk({
                rng, count: p.bodyCount, totalMass: DISK_TOTAL_MASS,
                inner, outer, centre: barycentre, centralMass: total, stars
            })
            for(let i = 0; i < disk.length; i++) bodies.push(disk[i])
        }
        scenarioCenter(bodies)
        const binaryPeriod = orbitalPeriod(a, total)
        // The periapsis passage is the fastest part of the orbit; scaling the
        // period by (1-e)^1.5 is the timescale of that passage.
        const suggestedDt = scenarioClamp(
            binaryPeriod * Math.pow(1 - e, 1.5) / SCENARIO_STEPS_PER_STELLAR_ORBIT,
            SCENARIO_MIN_DT, SCENARIO_MAX_DT
        )
        let notes = 'Período orbital da binária: ' + binaryPeriod.toFixed(3) + ' anos. ' +
            'O disco começa em ' + inner.toFixed(2) + ' UA (limite de estabilidade ' +
            limit.toFixed(2) + ' a).'
        if(clamped)
            notes += ' Excentricidade reduzida para ' + e.toFixed(2) +
                ' para as estrelas não se fundirem no primeiro periastro.'
        return {
            bodies,
            meta: {
                label: 'Estrela binária',
                suggestedDt,
                cameraDistance: Math.max(4 * apoapsis, 2 * (p.disk && p.bodyCount > 0 ? outer : apoapsis)),
                diskNormal: { x: 0, y: 1, z: 0 },
                gasAccretion: p.disk && p.bodyCount > 0,
                fusion: true,
                gasInnerRadius: inner,
                gasOuterRadius: outer,
                notes
            }
        }
    }
}

// --- 3. Stellar collision -----------------------------------------------------

const SCENARIO_STELLAR_COLLISION = {
    id: 'stellar-collision',
    name: 'Colisão estelar',
    description: 'Duas estrelas em rota de colisão, cada uma com um pequeno ' +
        'disco. Com parâmetro de impacto pequeno elas se fundem; aumentando-o, ' +
        'passam raspando e arrancam os discos uma da outra.',
    category: 'colisao',
    params: [
        {
            key: 'massA', label: 'Massa da estrela A', type: 'float',
            default: 1.0, min: 0.08, max: 50, step: 0.01, unit: 'M☉'
        },
        {
            key: 'massB', label: 'Massa da estrela B', type: 'float',
            default: 1.0, min: 0.08, max: 50, step: 0.01, unit: 'M☉'
        },
        {
            key: 'separation', label: 'Separação inicial', type: 'float',
            default: 25, min: 5, max: 500, step: 1, unit: 'UA',
            help: 'Distância no instante zero. O encontro leva aproximadamente ' +
                'separação dividida pela velocidade relativa.'
        },
        {
            key: 'relativeVelocity', label: 'Velocidade relativa', type: 'float',
            default: 4.0, min: 0.1, max: 50, step: 0.1, unit: 'UA/ano',
            help: 'Acima da velocidade de escape mútua o encontro é hiperbólico ' +
                'e a energia total do sistema é positiva.'
        },
        {
            key: 'impactParameter', label: 'Parâmetro de impacto', type: 'float',
            default: 0.5, min: 0, max: 100, step: 0.1, unit: 'UA',
            help: 'Zero é frontal. O foco gravitacional puxa muito mais para ' +
                'dentro do que a geometria sugere.'
        },
        {
            key: 'disks', label: 'Discos ao redor das estrelas', type: 'bool', default: true
        },
        {
            key: 'bodiesPerDisk', label: 'Corpos por disco', type: 'int',
            default: 200, min: 0, max: 2000, step: 10
        },
        {
            key: 'diskOuterRadius', label: 'Raio externo dos discos', type: 'float',
            default: 6, min: 0.5, max: 100, step: 0.5, unit: 'UA'
        }
    ],
    build(params){
        const p = scenarioResolveParams(SCENARIO_STELLAR_COLLISION, params)
        const rng = new ScenarioRandom(0)
        const massA = p.massA, massB = p.massB
        const total = massA + massB
        const starA = scenarioMakeStar(massA, new Composition())
        const starB = scenarioMakeStar(massB, new Composition())
        // Built directly in the centre-of-momentum frame: the relative vector is
        // (separation, 0, impact parameter) and the relative velocity is a pure
        // approach along -x. Each star takes the share of the relative motion
        // that its partner's mass demands, so the net momentum is zero by
        // construction and scenarioCenter() below is a no-op.
        const rx = p.separation, rz = p.impactParameter
        starA.position.set(-rx * massB / total, 0, -rz * massB / total)
        starB.position.set(rx * massA / total, 0, rz * massA / total)
        starA.velocity.set(p.relativeVelocity * massB / total, 0, 0)
        starB.velocity.set(-p.relativeVelocity * massA / total, 0, 0)
        const stars = [starA, starB]
        const bodies = [starA, starB]
        const inner = Math.max(0.2, p.diskOuterRadius * 0.08)
        if(p.disks && p.bodiesPerDisk > 0){
            const diskA = scenarioBuildDisk({
                rng, count: p.bodiesPerDisk, totalMass: DISK_TOTAL_MASS,
                inner, outer: p.diskOuterRadius, centre: starA, centralMass: massA, stars
            })
            const diskB = scenarioBuildDisk({
                rng, count: p.bodiesPerDisk, totalMass: DISK_TOTAL_MASS,
                inner, outer: p.diskOuterRadius, centre: starB, centralMass: massB, stars
            })
            for(let i = 0; i < diskA.length; i++) bodies.push(diskA[i])
            for(let i = 0; i < diskB.length; i++) bodies.push(diskB[i])
        }
        scenarioCenter(bodies)
        const periapsis = scenarioEncounterPeriapsis(
            total, p.separation, p.impactParameter, p.relativeVelocity)
        const contact = (starA.accretionRadius + starB.accretionRadius) * GRAVITATIONAL_FOCUSING_MAX
        // Two constraints: resolve the innermost disk orbit, and resolve the
        // crossing of the merge radius at the speed the pair actually arrives
        // with. The encounter is far more demanding than the disks.
        let suggestedDt = scenarioEncounterTimestep(starA, starB, p.relativeVelocity, periapsis)
        if(p.disks && p.bodiesPerDisk > 0){
            const diskStep = orbitalPeriod(inner, Math.min(massA, massB)) / SCENARIO_STEPS_PER_ORBIT
            if(diskStep < suggestedDt) suggestedDt = diskStep
        }
        suggestedDt = scenarioClamp(suggestedDt, SCENARIO_MIN_DT, SCENARIO_MAX_DT)
        const escape = Math.sqrt(2 * GRAVITATION_CONSTANT * total / p.separation)
        const encounterTime = scenarioEncounterTime(
            total, p.separation, p.impactParameter, p.relativeVelocity)
        return {
            bodies,
            meta: {
                label: 'Colisão estelar',
                suggestedDt,
                cameraDistance: 1.6 * p.separation,
                diskNormal: (p.disks && p.bodiesPerDisk > 0) ? { x: 0, y: 1, z: 0 } : null,
                gasAccretion: false,
                fusion: true,
                gasInnerRadius: inner,
                gasOuterRadius: p.diskOuterRadius,
                notes: 'Encontro por volta de ' + encounterTime.toFixed(1) + ' anos, com ' +
                    'periastro de ' + periapsis.toFixed(3) + ' UA contra um raio de fusão de ' +
                    contact.toFixed(3) + ' UA. Velocidade de escape mútua a esta distância: ' +
                    escape.toFixed(2) + ' UA/ano' +
                    (p.relativeVelocity > escape
                        ? ' - o encontro é hiperbólico e a energia total é positiva.'
                        : ' - o par está ligado e voltará a se encontrar.')
            }
        }
    }
}

// --- 4. Cluster ---------------------------------------------------------------

const SCENARIO_CLUSTER = {
    id: 'cluster',
    name: 'Aglomerado estelar',
    description: 'N estrelas numa esfera virializada, com massas sorteadas da ' +
        'função de massa inicial de Kroupa. Poucas gigantes, muitas anãs ' +
        'vermelhas - e encontros próximos desde o começo.',
    category: 'aglomerado',
    params: [
        {
            key: 'starCount', label: 'Número de estrelas', type: 'int',
            default: 60, min: 2, max: 400, step: 1
        },
        {
            key: 'totalMass', label: 'Massa total', type: 'float',
            default: 30, min: 0.2, max: 5000, step: 1, unit: 'M☉',
            help: 'As massas vêm da IMF de Kroupa e depois são reescaladas ' +
                'para somar este total.'
        },
        {
            key: 'radius', label: 'Raio do aglomerado', type: 'float',
            default: 200, min: 5, max: 20000, step: 5, unit: 'UA',
            help: 'Esfera de densidade uniforme. Raios pequenos produzem ' +
                'colisões estelares em poucas dezenas de anos.'
        },
        {
            key: 'virialRatio', label: 'Razão virial 2T/|U|', type: 'float',
            default: 1.0, min: 0, max: 2, step: 0.05,
            help: '1 é equilíbrio. Abaixo de 1 o aglomerado colapsa; acima de 2 ' +
                'ele se desfaz.'
        },
        {
            key: 'maxStarMass', label: 'Massa estelar máxima', type: 'float',
            default: 20, min: 0.1, max: 150, step: 0.5, unit: 'M☉',
            help: 'Corte superior da IMF.'
        }
    ],
    build(params){
        const p = scenarioResolveParams(SCENARIO_CLUSTER, params)
        const rng = new ScenarioRandom(0)
        const count = p.starCount
        const maxMass = Math.max(HYDROGEN_BURNING_MASS * 1.5, p.maxStarMass)
        // Sample the IMF, then rescale to the requested total. A multiplicative
        // rescale preserves a power law exactly - it only shifts where the break
        // sits - so the sampled slopes survive.
        const masses = new Float64Array(count)
        let sampled = 0
        for(let i = 0; i < count; i++){
            masses[i] = sampleKroupaMass(rng, HYDROGEN_BURNING_MASS, maxMass)
            sampled += masses[i]
        }
        const scale = sampled > 0 ? p.totalMass / sampled : 1
        const stars = []
        for(let i = 0; i < count; i++)
            stars.push(scenarioMakeStar(masses[i] * scale, new Composition()))
        // Uniform-density sphere: r = R*u^(1/3), direction isotropic. Rejected
        // and resampled if a pair would start inside its own merge radius,
        // which would swallow half the cluster on the first step.
        const direction = new Vector()
        for(let i = 0; i < count; i++){
            const star = stars[i]
            for(let attempt = 0; attempt < 64; attempt++){
                const radius = p.radius * Math.pow(rng.next(), 1 / 3)
                rng.direction(direction)
                star.position.set(direction.x * radius, direction.y * radius, direction.z * radius)
                let clear = true
                for(let j = 0; j < i; j++){
                    const minimum = 5 * (star.accretionRadius + stars[j].accretionRadius)
                    if(star.position.distanceTo(stars[j].position) < minimum){
                        clear = false
                        break
                    }
                }
                if(clear) break
            }
        }
        // Isotropic Gaussian velocities, then rescaled so that 2T/|U| is exactly
        // the requested virial ratio. The potential is measured on the actual
        // configuration rather than taken from the uniform-sphere formula, so
        // the ratio is right for the realisation we actually drew.
        for(let i = 0; i < count; i++)
            stars[i].velocity.set(rng.normal(), rng.normal(), rng.normal())
        scenarioCenter(stars)
        let potential = 0
        for(let i = 0; i < count; i++){
            for(let j = i + 1; j < count; j++){
                potential -= GRAVITATION_CONSTANT * stars[i].mass * stars[j].mass /
                    Math.sqrt(stars[i].position.distanceSquaredTo(stars[j].position) + SOFTENING_SQUARED)
            }
        }
        let kinetic = 0
        for(let i = 0; i < count; i++)
            kinetic += stars[i].kineticEnergy()
        const target = 0.5 * p.virialRatio * Math.abs(potential)
        const factor = kinetic > 0 ? Math.sqrt(target / kinetic) : 0
        for(let i = 0; i < count; i++)
            stars[i].velocity.scale(factor)
        scenarioCenter(stars)
        const systemPeriod = orbitalPeriod(p.radius, p.totalMass)
        // Two bounds. The first is the encounter scale, which is what actually
        // sets the timestep in a cluster; the second catches a draw that happens
        // to start with a very tight pair.
        let suggestedDt = scenarioSwarmTimestep(
            p.totalMass, p.radius, p.totalMass / count, p.virialRatio)
        const closest = scenarioSuggestedTimestep(stars, stars, suggestedDt)
        if(closest < suggestedDt) suggestedDt = closest
        // A single unlucky close pair must not drive the whole run to a crawl.
        suggestedDt = scenarioClamp(suggestedDt, systemPeriod / 200000, systemPeriod / 200)
        let heaviest = stars[0]
        let lightest = stars[0]
        for(let i = 1; i < count; i++){
            if(stars[i].mass > heaviest.mass) heaviest = stars[i]
            if(stars[i].mass < lightest.mass) lightest = stars[i]
        }
        return {
            bodies: stars,
            meta: {
                label: 'Aglomerado estelar',
                suggestedDt,
                cameraDistance: 3 * p.radius,
                diskNormal: null,
                gasAccretion: false,
                fusion: true,
                notes: 'Massas de Kroupa entre ' + lightest.mass.toPrecision(2) +
                    ' e ' + heaviest.mass.toFixed(2) + ' M☉. Período dinâmico do ' +
                    'aglomerado: ' + systemPeriod.toFixed(0) + ' anos.'
            }
        }
    }
}

// --- 5. System collision ------------------------------------------------------

const SCENARIO_SYSTEM_COLLISION = {
    id: 'system-collision',
    name: 'Colisão de sistemas',
    description: 'Dois sistemas planetários completos em rota de colisão. As ' +
        'duas estrelas passam perto o bastante para rasgar os dois discos e ' +
        'trocar planetas entre si.',
    category: 'colisao',
    params: [
        {
            key: 'starMassA', label: 'Massa da estrela A', type: 'float',
            default: 1.0, min: 0.08, max: 50, step: 0.01, unit: 'M☉'
        },
        {
            key: 'starMassB', label: 'Massa da estrela B', type: 'float',
            default: 1.0, min: 0.08, max: 50, step: 0.01, unit: 'M☉'
        },
        {
            key: 'separation', label: 'Separação inicial', type: 'float',
            default: 60, min: 10, max: 1000, step: 5, unit: 'UA'
        },
        {
            key: 'relativeVelocity', label: 'Velocidade relativa', type: 'float',
            default: 2.0, min: 0.05, max: 50, step: 0.05, unit: 'UA/ano'
        },
        {
            key: 'impactParameter', label: 'Parâmetro de impacto', type: 'float',
            default: 10, min: 0, max: 200, step: 0.5, unit: 'UA'
        },
        {
            key: 'bodiesPerSystem', label: 'Corpos por sistema', type: 'int',
            default: 300, min: 0, max: 2000, step: 10
        },
        {
            key: 'diskOuterRadius', label: 'Raio externo dos discos', type: 'float',
            default: 15, min: 1, max: 200, step: 0.5, unit: 'UA'
        }
    ],
    build(params){
        const p = scenarioResolveParams(SCENARIO_SYSTEM_COLLISION, params)
        const rng = new ScenarioRandom(0)
        const massA = p.starMassA, massB = p.starMassB
        const total = massA + massB
        const starA = scenarioMakeStar(massA, new Composition())
        const starB = scenarioMakeStar(massB, new Composition())
        const rx = p.separation, rz = p.impactParameter
        starA.position.set(-rx * massB / total, 0, -rz * massB / total)
        starB.position.set(rx * massA / total, 0, rz * massA / total)
        starA.velocity.set(p.relativeVelocity * massB / total, 0, 0)
        starB.velocity.set(-p.relativeVelocity * massA / total, 0, 0)
        const stars = [starA, starB]
        const bodies = [starA, starB]
        const inner = Math.max(0.2, p.diskOuterRadius * 0.035)
        const perSystem = p.bodiesPerSystem
        if(perSystem > 0){
            const diskA = scenarioBuildDisk({
                rng, count: perSystem, totalMass: DISK_TOTAL_MASS,
                inner, outer: p.diskOuterRadius, centre: starA, centralMass: massA, stars
            })
            const diskB = scenarioBuildDisk({
                rng, count: perSystem, totalMass: DISK_TOTAL_MASS,
                inner, outer: p.diskOuterRadius, centre: starB, centralMass: massB, stars
            })
            for(let i = 0; i < diskA.length; i++) bodies.push(diskA[i])
            for(let i = 0; i < diskB.length; i++) bodies.push(diskB[i])
        }
        scenarioCenter(bodies)
        const periapsis = scenarioEncounterPeriapsis(
            total, p.separation, p.impactParameter, p.relativeVelocity)
        let suggestedDt = scenarioEncounterTimestep(starA, starB, p.relativeVelocity, periapsis)
        if(perSystem > 0){
            const diskStep = orbitalPeriod(inner, Math.min(massA, massB)) / SCENARIO_STEPS_PER_ORBIT
            if(diskStep < suggestedDt) suggestedDt = diskStep
        }
        // The stars also swing past each other; resolve that passage too.
        if(periapsis > 0){
            const passage = orbitalPeriod(periapsis, total) / SCENARIO_STEPS_PER_STELLAR_ORBIT
            if(passage < suggestedDt) suggestedDt = passage
        }
        suggestedDt = scenarioClamp(suggestedDt, SCENARIO_MIN_DT, SCENARIO_MAX_DT)
        const escape = Math.sqrt(2 * GRAVITATION_CONSTANT * total / p.separation)
        const encounterTime = scenarioEncounterTime(
            total, p.separation, p.impactParameter, p.relativeVelocity)
        return {
            bodies,
            meta: {
                label: 'Colisão de sistemas',
                suggestedDt,
                cameraDistance: 1.4 * p.separation + 2 * p.diskOuterRadius,
                diskNormal: perSystem > 0 ? { x: 0, y: 1, z: 0 } : null,
                gasAccretion: false,
                fusion: true,
                gasInnerRadius: inner,
                gasOuterRadius: p.diskOuterRadius,
                notes: 'As estrelas passam a ' + periapsis.toFixed(2) + ' UA uma da outra ' +
                    'por volta de ' + encounterTime.toFixed(1) + ' anos. Discos de ' +
                    p.diskOuterRadius.toFixed(1) + ' UA: tudo além do periastro é arrancado.'
            }
        }
    }
}

// --- 6. Random ----------------------------------------------------------------

const SCENARIO_RANDOM = {
    id: 'random',
    name: 'Gerador aleatório',
    description: 'Monte o sistema que quiser: quantas estrelas, de que material, ' +
        'em disco ou em esfera, com que dispersão de velocidades. Com uma ' +
        'semente diferente de zero o mesmo sistema é reproduzido exatamente.',
    category: 'custom',
    params: [
        {
            key: 'starCount', label: 'Número de estrelas', type: 'int',
            default: 3, min: 1, max: 50, step: 1,
            help: 'Todas são somadas exatamente, fora da árvore de Barnes-Hut.'
        },
        {
            key: 'starMass', label: 'Massa média das estrelas', type: 'float',
            default: 1.0, min: 0.08, max: 50, step: 0.01, unit: 'M☉',
            help: 'Cada estrela é sorteada entre 0,6 e 1,6 vezes este valor.'
        },
        {
            key: 'composition', label: 'Composição', type: 'choice',
            default: 'solar', choices: SCENARIO_COMPOSITION_CHOICES,
            help: 'Define a mistura das estrelas e a razão rocha/ferro dos sólidos.'
        },
        {
            key: 'layout', label: 'Distribuição', type: 'choice',
            default: 'disk', choices: SCENARIO_LAYOUT_CHOICES,
            help: 'O disco gira; a esfera é virializada e isotrópica.'
        },
        {
            key: 'spread', label: 'Extensão', type: 'float',
            default: 50, min: 1, max: 5000, step: 1, unit: 'UA'
        },
        {
            key: 'velocityDispersion', label: 'Dispersão de velocidades', type: 'float',
            default: 0.15, min: 0, max: 1.5, step: 0.01, unit: '× v',
            help: 'Ruído gaussiano somado à velocidade ordenada, em fração da ' +
                'velocidade circular local. Acima de ~0,5 o sistema se desfaz.'
        },
        {
            key: 'bodyCount', label: 'Planetesimais', type: 'int',
            default: 500, min: 0, max: 4000, step: 10
        },
        {
            key: 'diskMass', label: 'Massa em planetesimais', type: 'float',
            default: DISK_TOTAL_MASS, min: 0, max: 1, step: 1e-4, unit: 'M☉'
        },
        {
            key: 'seed', label: 'Semente', type: 'int',
            default: 0, min: 0, max: 999999, step: 1,
            help: '0 sorteia um sistema novo a cada vez. Qualquer outro valor ' +
                'reproduz exatamente o mesmo sistema.'
        }
    ],
    build(params){
        const p = scenarioResolveParams(SCENARIO_RANDOM, params)
        const rng = new ScenarioRandom(p.seed)
        const preset = scenarioCompositionPreset(p.composition)
        const sphere = p.layout === 'sphere'
        const spread = p.spread
        const stars = []
        const direction = new Vector()
        // --- stars
        for(let i = 0; i < p.starCount; i++){
            const mass = Math.max(HYDROGEN_BURNING_MASS, p.starMass * rng.uniform(0.6, 1.6))
            stars.push(scenarioMakeStar(mass, preset.star()))
        }
        if(p.starCount === 1){
            // One star: it sits at the centre and everything orbits it, which is
            // the ordinary planetary system.
            stars[0].position.setZero()
            stars[0].velocity.setZero()
        }else{
            for(let i = 0; i < stars.length; i++){
                const star = stars[i]
                for(let attempt = 0; attempt < 64; attempt++){
                    const radius = spread * (0.15 + 0.85 * Math.pow(rng.next(), 1 / 3))
                    rng.direction(direction)
                    if(sphere)
                        star.position.set(direction.x * radius, direction.y * radius, direction.z * radius)
                    else
                        // Flattened by 20:1 into the xz-plane, which is the plane
                        // every disk in this file lives in.
                        star.position.set(direction.x * radius, direction.y * radius * 0.05, direction.z * radius)
                    let clear = true
                    for(let j = 0; j < i; j++){
                        const minimum = 5 * (star.accretionRadius + stars[j].accretionRadius)
                        if(star.position.distanceTo(stars[j].position) < minimum){
                            clear = false
                            break
                        }
                    }
                    if(clear) break
                }
            }
        }
        // --- planetesimals
        const bodies = stars.slice()
        const totalStarMass = stars.reduce((sum, star) => sum + star.mass, 0)
        const embryoMass = p.bodyCount > 0 ? p.diskMass / p.bodyCount : 0
        const position = new Vector()
        const velocity = new Vector()
        const inner = Math.max(0.05 * spread, 0.2)
        for(let i = 0; i < p.bodyCount; i++){
            if(p.starCount === 1 && !sphere){
                // Single star, disk layout: build a proper Keplerian disk, which
                // is the one configuration where we can do better than a random
                // cloud with a circular speed slapped on it.
                const semiMajorAxis = scenarioSampleDiskRadius(inner, spread, DISK_SURFACE_DENSITY_EXPONENT, rng)
                scenarioOrbitState(
                    semiMajorAxis, Math.min(0.9, rng.rayleigh(DISK_ECCENTRICITY_RMS)),
                    rng.rayleigh(DISK_INCLINATION_RMS), stars[0].mass, rng, position, velocity
                )
            }else{
                const radius = Math.max(inner, spread * Math.pow(rng.next(), 1 / 3))
                rng.direction(direction)
                if(sphere)
                    position.set(direction.x * radius, direction.y * radius, direction.z * radius)
                else
                    position.set(direction.x * radius, direction.y * radius * 0.05, direction.z * radius)
                velocity.setZero()
            }
            const temperature = scenarioIrradiationTemperature(position.x, position.y, position.z, stars)
            bodies.push(new Planet(
                position.copy(), velocity.copy(), embryoMass,
                scenarioSolidComposition(temperature, preset.rockShare, preset.metalShare)
            ))
        }
        scenarioCenter(bodies)
        // --- velocities
        // Ordered motion first: every body that does not already have a velocity
        // gets the circular speed for the mass enclosed inside its own radius,
        // measured on the actual configuration rather than assumed. Then the
        // requested dispersion is added as gaussian noise on top.
        const needsVelocity = []
        for(let i = 0; i < bodies.length; i++){
            const body = bodies[i]
            if(body.velocity.magnitudeSquared() === 0 || (p.starCount > 1 && body.isStar))
                needsVelocity.push(body)
        }
        if(needsVelocity.length > 0){
            const sorted = bodies.slice().sort(
                (a, b) => a.position.magnitudeSquared() - b.position.magnitudeSquared())
            const enclosed = new Float64Array(sorted.length)
            let running = 0
            for(let i = 0; i < sorted.length; i++){
                enclosed[i] = running
                running += sorted[i].mass
            }
            const enclosedFor = new Map()
            for(let i = 0; i < sorted.length; i++)
                enclosedFor.set(sorted[i], enclosed[i])
            for(let i = 0; i < needsVelocity.length; i++){
                const body = needsVelocity[i]
                const radius = body.position.magnitude()
                const mass = Math.max(enclosedFor.get(body) || 0, totalStarMass * 0.05)
                if(!(radius > 0)){
                    body.velocity.setZero()
                    continue
                }
                const circular = circularOrbitalSpeed(radius, mass)
                if(sphere){
                    // Isotropic, and slowed to the virial value: a circular
                    // speed in every direction at once is twice the kinetic
                    // energy a bound sphere can hold, and it would fly apart.
                    rng.direction(direction)
                    body.velocity.set(
                        direction.x * circular * 0.7,
                        direction.y * circular * 0.7,
                        direction.z * circular * 0.7
                    )
                }else{
                    // Prograde and tangential in the xz-plane: +y cross r.
                    let tx = -body.position.z
                    let tz = body.position.x
                    const tangent = Math.hypot(tx, tz)
                    if(tangent > 0){
                        tx /= tangent
                        tz /= tangent
                        body.velocity.set(tx * circular, 0, tz * circular)
                    }else{
                        body.velocity.setZero()
                    }
                }
                if(p.velocityDispersion > 0){
                    const sigma = p.velocityDispersion * circular
                    body.velocity.x += sigma * rng.normal()
                    body.velocity.y += sigma * rng.normal() * (sphere ? 1 : 0.2)
                    body.velocity.z += sigma * rng.normal()
                }
            }
        }
        scenarioCenter(bodies)
        // A single star with a disk is an ordinary planetary system and a
        // hundred steps per orbit is plenty. Anything else here - several stars,
        // or an isotropic sphere - is not on closed Keplerian orbits at all:
        // bodies are scattered within a few encounters and reach periapsis
        // distances far inside where they started, so the timestep has to be
        // sized for the orbit they will end up on, not the one they were given.
        // Measured on the default three-star draw over 100 years: a hundred
        // steps per initial orbit invents 4.5% of the total energy, two hundred
        // 2.2%, four hundred 0.4%.
        const scattered = p.starCount > 1 || sphere
        let suggestedDt = scenarioSuggestedTimestep(
            bodies, stars, FIXED_DT, scattered ? 400 : SCENARIO_STEPS_PER_ORBIT)
        if(p.starCount > 1){
            // Several stars sharing a volume is a small cluster and needs the
            // same close-encounter bound one does.
            const swarm = scenarioSwarmTimestep(
                totalStarMass + p.diskMass, spread, totalStarMass / p.starCount, 1)
            if(swarm < suggestedDt) suggestedDt = swarm
        }
        const extent = scenarioExtent(bodies)
        return {
            bodies,
            meta: {
                label: 'Gerador aleatório',
                suggestedDt,
                cameraDistance: Math.max(2 * extent, 2 * spread),
                diskNormal: sphere ? null : { x: 0, y: 1, z: 0 },
                gasAccretion: !sphere && p.bodyCount > 0,
                fusion: true,
                gasInnerRadius: inner,
                gasOuterRadius: spread,
                notes: p.starCount + (p.starCount === 1 ? ' estrela' : ' estrelas') +
                    ' e ' + p.bodyCount + ' planetesimais, ' +
                    (sphere ? 'em esfera' : 'em disco') + ', até ' + spread.toFixed(0) + ' UA.' +
                    (p.seed > 0 ? ' Semente ' + p.seed + ': reproduzível.' : ' Sem semente: sorteado a cada vez.')
            }
        }
    }
}

// --- Registry -----------------------------------------------------------------

const SCENARIOS = [
    SCENARIO_PLANETARY_SYSTEM,
    SCENARIO_BINARY_STAR,
    SCENARIO_STELLAR_COLLISION,
    SCENARIO_CLUSTER,
    SCENARIO_SYSTEM_COLLISION,
    SCENARIO_RANDOM
]

const DEFAULT_SCENARIO_ID = 'planetary-system'

function getScenario(id){
    for(let i = 0; i < SCENARIOS.length; i++){
        if(SCENARIOS[i].id === id) return SCENARIOS[i]
    }
    return null
}

/** Every parameter of a scenario at its default. Safe to hand straight to build(). */
function scenarioDefaults(id){
    const descriptor = getScenario(id)
    const defaults = {}
    if(!descriptor) return defaults
    const specs = descriptor.params || []
    for(let i = 0; i < specs.length; i++)
        defaults[specs[i].key] = specs[i].default
    return defaults
}

/**
 * Build a scenario. An unknown id falls back to the default one rather than
 * throwing, so a stale saved setting can never leave the app with no universe.
 *
 * The returned meta is normalised: every field the contract promises is
 * present and finite, whatever the scenario chose to omit.
 */
function buildScenario(id, params){
    let descriptor = getScenario(id)
    if(!descriptor) descriptor = getScenario(DEFAULT_SCENARIO_ID)
    const result = descriptor.build(params || {})
    const bodies = Array.isArray(result.bodies) ? result.bodies : []
    const meta = result.meta || {}
    return {
        bodies,
        meta: {
            scenarioId: descriptor.id,
            label: meta.label || descriptor.name,
            suggestedDt: isFinite(meta.suggestedDt) && meta.suggestedDt > 0
                ? meta.suggestedDt : FIXED_DT,
            cameraDistance: isFinite(meta.cameraDistance) && meta.cameraDistance > 0
                ? meta.cameraDistance : 40,
            diskNormal: meta.diskNormal || null,
            gasAccretion: meta.gasAccretion !== undefined ? !!meta.gasAccretion : true,
            fusion: meta.fusion !== undefined ? !!meta.fusion : true,
            gasInnerRadius: isFinite(meta.gasInnerRadius) && meta.gasInnerRadius > 0
                ? meta.gasInnerRadius : DISK_INNER_RADIUS,
            gasOuterRadius: isFinite(meta.gasOuterRadius) && meta.gasOuterRadius > 0
                ? meta.gasOuterRadius : DISK_OUTER_RADIUS,
            notes: meta.notes || ''
        }
    }
}
