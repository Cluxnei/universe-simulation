/**
 * Tidal debris streams.
 *
 * A star that crosses a black hole's tidal radius is not swallowed whole: the
 * tide across its own diameter beats its self-gravity, it comes apart, and what
 * is left is a STREAM of debris whose specific orbital energy is spread by the
 * potential difference across the star at the moment it was destroyed. That
 * spread is the whole event:
 *
 *     dE = G * M_hole * x / r_t^2
 *
 * with x the position of a fluid element along the star's radius, measured
 * outward from the hole. It is tiny - dv/v is 0.003 for Sagittarius A* - but it
 * straddles zero, so ROUGHLY HALF THE STAR ENDS UP BOUND AND HALF UNBOUND. The
 * unbound half leaves forever; the bound half returns to periapsis with a
 * spread of orbital periods, and because the mass is spread evenly in energy
 * (dM/dE flat), Kepler's third law turns that into the observational signature
 * of a real tidal disruption event:
 *
 *     dM/dt = (dM/dE) (dE/dt) ~ t^(-5/3)
 *
 * This is the "frozen-in" approximation: the energy spread is imprinted once,
 * at disruption, and every fragment is a test particle from then on. It is what
 * every semi-analytic TDE model does, and it is the right level of physics for
 * a code with no hydrodynamics.
 *
 * ---------------------------------------------------------------------------
 * HOW TO ABORT THIS ENTIRELY
 *
 * Set TIDAL_DEBRIS_ENABLED = false in constants.js. Every function here then
 * returns immediately without touching a single body, and the capture path in
 * simulation.js falls through to the old absorb-whole merge, byte for byte -
 * verified by comparing every body's state as raw IEEE-754 against the code
 * that shipped, across seven scenarios.
 *
 * simulation.js calls into this file from exactly four places, each guarded by
 * TIDAL_DEBRIS_ENABLED so the branch folds away when it is off:
 *
 *     step()               tidalDebrisTick()      fallback and cleanup
 *     resolveCollisions()  two isDebris skips     debris is collisionless
 *     captureReach()       one isDebris test      the hole's own rule is bypassed
 *     handlePair()         tidalDebrisDisrupt()   the disruption itself
 *
 * Nothing here reassigns a method or a field on a Simulation: with the flag off
 * the class behaves, and reads, exactly as it did before. Deleting this file,
 * its <script> tag and those four guarded blocks removes the feature completely;
 * nothing else in the simulation depends on it.
 * ---------------------------------------------------------------------------
 *
 * HONEST ABOUT RESOLUTION. Two different lengths have to be compared with the
 * softening, and only the first one is comfortable:
 *
 *   - THE TIDAL RADIUS, which sets the orbits. 0.465 AU for a 1e6 Msun hole
 *     against a Sun-like star, 465 softening lengths, well posed. 0.0100 AU for
 *     a 10 Msun one, TEN softening lengths, and there the whole disruption
 *     happens inside a region where the force law has been deliberately
 *     flattened. Measured for a 10 Msun hole: the capture fires at NINE tidal
 *     radii (the star's own absorption radius is five times the tidal radius at
 *     that mass), dv/v comes out at 1.3 instead of 0.01 so the linearisation
 *     that the whole frozen-in model rests on is meaningless, and the fallback
 *     exponent fits -2.5 with r2 = 0.80 instead of -5/3. Conservation stays
 *     exact to 1e-14; nothing else about it should be believed.
 *
 *   - THE STAR'S OWN RADIUS, which sets the spacing between fragments. A solar
 *     radius is 4.65 softening lengths, so six hundred fragments laid across it
 *     would be SIXTY-FIVE TIMES CLOSER TOGETHER THAN THE SOFTENING - and inside
 *     that length the Plummer kernel is a spring, not gravity. That is a real
 *     failure and it was measured: the flat dM/dE collapsed into four clumps
 *     within a hundred steps and the fallback exponent went to -0.4. It is why
 *     the stream is given a WIDTH (see TIDAL_DEBRIS_SPACING_SOFTENINGS): spread
 *     out until the spacing is a few softening lengths, the distribution is
 *     unchanged from spawn to five thousand steps later.
 *
 * See tidalDebrisResolution() at the bottom.
 */

// The golden angle. Successive fragments are placed at this azimuth around the
// star's radius vector, which fills the cross-section evenly with no random
// numbers at all: turning the feature on must not perturb any scenario's RNG
// sequence, or "the flag off reproduces today exactly" would stop being
// testable.
const TIDAL_DEBRIS_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/**
 * Per-simulation debris bookkeeping, created on demand.
 *
 * Lives on the Simulation instance as `tidalDebris` rather than in a field of
 * simulation.js, so that turning the feature off leaves that class exactly as
 * it was. `particles` is the live debris list, kept so the per-step tick does
 * not have to scan every body in the system.
 */
function tidalDebrisState(simulation, create){
    if(!simulation)
        return null
    let state = simulation.tidalDebris
    if(!state && create){
        state = {
            particles: [],      // live debris bodies
            events: 0,          // disruptions this feature has handled
            spawned: 0,         // debris bodies created, ever
            accreted: 0,        // debris bodies that fell back into a hole
            accretedMass: 0,    // Msun returned to the holes
            coalesced: 0,       // escaped debris bodies merged away by cleanup
            declined: 0,        // disruptions handed back to the absorb-whole path
            ticks: 0
        }
        simulation.tidalDebris = state
    }
    return state || null
}

/** Everything a HUD would want to show. Safe to call with the flag off. */
function tidalDebrisStats(simulation){
    const state = tidalDebrisState(simulation, false)
    if(!state){
        return { enabled: TIDAL_DEBRIS_ENABLED, particles: 0, events: 0,
                 accreted: 0, accretedMass: 0, coalesced: 0, declined: 0 }
    }
    let live = 0
    for(let i = 0; i < state.particles.length; i++){
        if(!state.particles[i].removed) live++
    }
    return {
        enabled: TIDAL_DEBRIS_ENABLED,
        particles: live,
        events: state.events,
        accreted: state.accreted,
        accretedMass: state.accretedMass,
        coalesced: state.coalesced,
        declined: state.declined
    }
}

/**
 * Specific orbital energy of `body` about `hole`, (AU/yr)^2.
 *
 * The hole is treated as the whole potential and the fragment as a test
 * particle - mu = G*M_hole, not G*(M+m) - which is the same convention used for
 * every fragment and for the star itself, so the bound/unbound split is a
 * comparison of like with like.
 */
function tidalDebrisSpecificEnergy(body, hole){
    const dx = body.position.x - hole.position.x
    const dy = body.position.y - hole.position.y
    const dz = body.position.z - hole.position.z
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if(!(distance > 0))
        return 0
    const vx = body.velocity.x - hole.velocity.x
    const vy = body.velocity.y - hole.velocity.y
    const vz = body.velocity.z - hole.velocity.z
    return 0.5 * (vx * vx + vy * vy + vz * vz) -
        GRAVITATION_CONSTANT * hole.mass / distance
}

/**
 * Periapsis of the star's current two-body orbit about the hole, in AU.
 *
 * The broad phase in simulation.js fires a capture as soon as the swept segment
 * comes within the capture radius ENHANCED BY GRAVITATIONAL FOCUSING, which for
 * a plunging orbit is up to three times the tidal radius. So "the collision
 * test fired" is NOT the same statement as "the star went inside its tidal
 * radius", and spawning a stream for a star that was only ever going to graze
 * would invent a disruption that never happened. This is the test that decides.
 */
function tidalDebrisPeriapsis(star, hole){
    const rx = star.position.x - hole.position.x
    const ry = star.position.y - hole.position.y
    const rz = star.position.z - hole.position.z
    const distance = Math.sqrt(rx * rx + ry * ry + rz * rz)
    if(!(distance > 0))
        return 0
    const vx = star.velocity.x - hole.velocity.x
    const vy = star.velocity.y - hole.velocity.y
    const vz = star.velocity.z - hole.velocity.z
    const mu = GRAVITATION_CONSTANT * (hole.mass + star.mass)
    if(!(mu > 0))
        return distance
    const hx = ry * vz - rz * vy
    const hy = rz * vx - rx * vz
    const hz = rx * vy - ry * vx
    const angular = hx * hx + hy * hy + hz * hz
    if(!(angular > 0))
        return 0                        // radial plunge: it goes straight in
    const energy = 0.5 * (vx * vx + vy * vy + vz * vz) - mu / distance
    let eccentricity = 1 + 2 * energy * angular / (mu * mu)
    eccentricity = eccentricity > 0 ? Math.sqrt(eccentricity) : 0
    return (angular / mu) / (1 + eccentricity)
}

/**
 * How many fragments to cut the star into, or 0 to decline the disruption.
 *
 * Three limits, in order:
 *  1. the requested count, TIDAL_DEBRIS_PARTICLES;
 *  2. enough of them that no fragment is heavy enough to IGNITE. A fragment
 *     above ~0.06 Msun classifies as CLASS_STAR, refreshStars() would then
 *     promote it into the direct-summed set, and six hundred direct-summed
 *     bodies is an O(n^2) force loop and the end of the frame rate. Fragments
 *     are capped below that limit instead;
 *  3. the hard body-count cap. If what is left of the budget cannot pay for a
 *     stream that satisfies (2), the disruption is declined and the caller
 *     falls back to swallowing the star whole - which is always correct, never
 *     spawns anything, and conserves everything.
 */
function tidalDebrisCount(simulation, star){
    const cap = TIDAL_DEBRIS_MAX_BODIES - simulation.planets.length
    if(cap < TIDAL_DEBRIS_MIN_PARTICLES)
        return 0
    let count = TIDAL_DEBRIS_PARTICLES
    const required = Math.ceil(star.mass / TIDAL_DEBRIS_MAX_PARTICLE_MASS)
    if(required > count)
        count = required
    if(count > cap)
        count = cap
    if(count < TIDAL_DEBRIS_MIN_PARTICLES || count < required)
        return 0
    return count
}

/**
 * Replace `star` with a debris stream around `hole`. Returns true if it did.
 *
 * THE ONE ENTRY POINT. simulation.js calls this and nothing else; a false
 * return means "not my business, carry on", and the old absorb-whole path runs
 * unchanged.
 *
 * WHAT IS CONSERVED, AND HOW:
 *
 *  - MASS. The fragments are given equal masses m/N and the last one takes the
 *    remainder, so the sum is the star's mass to the last bit.
 *  - COMPOSITION. Every fragment gets a clone of the star's composition, so
 *    each of the eight species is conserved by the same mass-weighted identity
 *    that Composition.blend() relies on.
 *  - MOMENTUM. The fragments' speeds are laid out along the star's own velocity
 *    direction, and a single uniform offset lambda is added to all of them so
 *    that SUM m_k v_k is exactly m v_star. That offset perturbs the energies by
 *    a few parts in a thousand OF THE SPREAD - see the comment where it is
 *    computed - which is the price of exact momentum, and momentum is the one
 *    that must be exact.
 *  - The debris centre of mass is placed exactly on the star's position, so the
 *    system's centre of mass does not jump either.
 */
function tidalDebrisDisrupt(simulation, hole, star){
    // The abort switch. First line, no state touched, no allocation.
    if(!TIDAL_DEBRIS_ENABLED)
        return false
    if(!simulation || !hole || !star)
        return false
    if(!hole.isBlackHole || star.isBlackHole)
        return false
    // Debris that falls back in is swallowed, never shredded again: it has
    // already been torn apart once and a fragment of a fragment is not a thing
    // this model knows how to make.
    if(star.isDebris)
        return false
    if(!(star.mass > 0) || !(star.radius > 0) || !(hole.mass > 0))
        return false
    const tidal = tidalDisruptionRadius(hole.mass, star.mass, star.radius)
    if(!(tidal > 0))
        return false
    // The Hills limit. Above ~1.1e8 Msun the horizon overtakes the tide and the
    // star crosses it intact: no disruption, no debris, no flare. This falls
    // out of comparing the two radii rather than being asserted anywhere.
    if(schwarzschildRadius(hole.mass) >= tidal)
        return false
    // Did the star actually go inside its tidal radius, or did the focused
    // broad phase merely catch it on the way past?
    const periapsis = tidalDebrisPeriapsis(star, hole)
    if(periapsis > TIDAL_DEBRIS_PERIAPSIS_FACTOR * tidal)
        return false
    const state = tidalDebrisState(simulation, true)
    // Make room before deciding we cannot afford the stream.
    if(simulation.planets.length + TIDAL_DEBRIS_MIN_PARTICLES > TIDAL_DEBRIS_MAX_BODIES)
        tidalDebrisTick(simulation, true)
    const count = tidalDebrisCount(simulation, star)
    if(count <= 0){
        state.declined++
        return false
    }
    tidalDebrisSpawn(simulation, hole, star, tidal, count)
    // The star is gone. Its mass is now in the fragments, not in the hole, so
    // NOTHING is transferred to the hole here and its accretion reservoir is
    // not fed: the flare comes later, from the debris that falls back.
    star.mass = 0
    star.removed = true
    return true
}

/** Build and register the stream. Assumes the caller has validated everything. */
function tidalDebrisSpawn(simulation, hole, star, tidal, count){
    const state = tidalDebrisState(simulation, true)
    const mu = GRAVITATION_CONSTANT * hole.mass
    const radius = star.radius
    // Radial unit vector, hole -> star. +x is AWAY from the hole, which is the
    // sign convention in dE = G*M*x/r_t^2: a fragment on the far side is left
    // behind with more energy and is the half that escapes.
    let nx = star.position.x - hole.position.x
    let ny = star.position.y - hole.position.y
    let nz = star.position.z - hole.position.z
    let separation = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if(!(separation > 0)){
        nx = 1; ny = 0; nz = 0; separation = tidal
    }else{
        nx /= separation; ny /= separation; nz /= separation
    }
    // Two vectors spanning the plane across the stream, for the azimuthal
    // spread. Built from the least-aligned axis so the cross product is never
    // degenerate.
    let ax = 0, ay = 0, az = 0
    if(Math.abs(nx) <= Math.abs(ny) && Math.abs(nx) <= Math.abs(nz)) ax = 1
    else if(Math.abs(ny) <= Math.abs(nz)) ay = 1
    else az = 1
    let e1x = ny * az - nz * ay
    let e1y = nz * ax - nx * az
    let e1z = nx * ay - ny * ax
    const e1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z) || 1
    e1x /= e1; e1y /= e1; e1z /= e1
    const e2x = ny * e1z - nz * e1y
    const e2y = nz * e1x - nx * e1z
    const e2z = nx * e1y - ny * e1x
    // The star's own relative state. Every fragment keeps this DIRECTION and
    // differs only in speed, so the stream inherits the star's angular momentum
    // to within the 1% that the position spread itself contributes - which is
    // right: a real stream is thin in angular momentum and wide in energy.
    const ux = star.velocity.x - hole.velocity.x
    const uy = star.velocity.y - hole.velocity.y
    const uz = star.velocity.z - hole.velocity.z
    let speed = Math.sqrt(ux * ux + uy * uy + uz * uz)
    let hx, hy, hz
    if(speed > 0){
        hx = ux / speed; hy = uy / speed; hz = uz / speed
    }else{
        // A star released at rest: it falls straight in along -n.
        hx = -nx; hy = -ny; hz = -nz
        speed = 0
    }
    const starEnergy = 0.5 * speed * speed - mu / separation
    const massEach = star.mass / count
    // HOW WIDE TO MAKE THE STREAM, and this is the least obvious number in the
    // file. Six hundred fragments strung across a solar radius sit 1.5e-5 AU
    // apart - SIXTY-FIVE TIMES CLOSER THAN THE SOFTENING LENGTH - and inside
    // that length the Plummer kernel turns gravity into a linear spring. The
    // stream is then held together by an interaction that is not gravity, it
    // resists the tide it is supposed to be stretched by, and it snaps into
    // clumps: measured, the flat dM/dE that the whole fallback rate depends on
    // collapses into four spikes within a hundred steps, and the t^(-5/3) with
    // it.
    //
    // So the fragments are spread out until their mean spacing is a few
    // softening lengths, at which point the kernel is honest gravity again and
    // the tide dominates their mutual attraction by three orders of magnitude.
    // Measured: at this width the energy distribution is unchanged from spawn
    // to five thousand steps later. It is the same kind of licence as
    // ACCRETION_RADIUS_FACTOR - a macro-particle is given a size the thing it
    // stands for does not have - and it is bounded by the tidal radius so the
    // stream can never be drawn wider than the region it was destroyed in.
    const spacing = TIDAL_DEBRIS_SPACING_SOFTENINGS * SOFTENING
    let width = Math.sqrt(count * spacing * spacing * spacing / (Math.PI * 2 * radius))
    const minimumWidth = TIDAL_DEBRIS_TRANSVERSE_FRACTION * radius
    const maximumWidth = TIDAL_DEBRIS_MAX_WIDTH_FACTOR * tidal
    if(!(width > minimumWidth)) width = minimumWidth
    if(width > maximumWidth) width = maximumWidth
    // Scratch, sized once per event.
    const positionsX = new Float64Array(count)
    const positionsY = new Float64Array(count)
    const positionsZ = new Float64Array(count)
    const masses = new Float64Array(count)
    const speeds = new Float64Array(count)
    let sumMass = 0
    let comX = 0, comY = 0, comZ = 0
    for(let k = 0; k < count; k++){
        // UNIFORM IN x, which is the same statement as dM/dE FLAT, which is the
        // same statement as a t^(-5/3) fallback rate. Everything downstream
        // comes from this one line.
        const x = radius * (2 * (k + 0.5) / count - 1)
        // Fill the cross-section: the chord profile of a sphere at height x,
        // scaled to the width chosen above, at a golden angle so that
        // successive fragments never line up.
        const chord = width * Math.sqrt(Math.max(0, 1 - (x / radius) * (x / radius)))
        const angle = k * TIDAL_DEBRIS_GOLDEN_ANGLE
        const cos = Math.cos(angle), sin = Math.sin(angle)
        const mass = k === count - 1 ? star.mass - sumMass : massEach
        sumMass += mass
        masses[k] = mass
        const px = star.position.x + nx * x + (e1x * cos + e2x * sin) * chord
        const py = star.position.y + ny * x + (e1y * cos + e2y * sin) * chord
        const pz = star.position.z + nz * x + (e1z * cos + e2z * sin) * chord
        positionsX[k] = px
        positionsY[k] = py
        positionsZ[k] = pz
        comX += mass * px
        comY += mass * py
        comZ += mass * pz
    }
    // Put the debris centre of mass exactly where the star was.
    const shiftX = star.position.x - comX / star.mass
    const shiftY = star.position.y - comY / star.mass
    const shiftZ = star.position.z - comZ / star.mass
    let sumSpeed = 0
    for(let k = 0; k < count; k++){
        positionsX[k] += shiftX
        positionsY[k] += shiftY
        positionsZ[k] += shiftZ
        const dx = positionsX[k] - hole.position.x
        const dy = positionsY[k] - hole.position.y
        const dz = positionsZ[k] - hole.position.z
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
        // The frozen-in energy offset. x is recovered by projection rather than
        // reused from the loop above so that the transverse spread and the
        // centre-of-mass shift are both accounted for exactly.
        const x = (positionsX[k] - star.position.x) * nx +
            (positionsY[k] - star.position.y) * ny +
            (positionsZ[k] - star.position.z) * nz
        const target = starEnergy + mu * x / (tidal * tidal)
        // Speed that puts the fragment on that energy AT ITS OWN POSITION: the
        // potential it actually sits in, not a linearised one.
        let kinetic = 2 * (target + (distance > 0 ? mu / distance : 0))
        speeds[k] = kinetic > 0 ? Math.sqrt(kinetic) : 0
        sumSpeed += masses[k] * speeds[k]
    }
    // EXACT MOMENTUM. The speeds above cannot also sum to the star's momentum -
    // energy and momentum are two constraints on one degree of freedom - so a
    // single uniform offset is added to every fragment. It is second order
    // small: lambda/v ~ (dv/v)^2 / 24, about 6e-6 for Sgr A*, which moves every
    // energy by ~0.2% OF THE SPREAD and the bound fraction by ~0.1%. Momentum
    // comes out exact, which is the property worth having.
    const lambda = speed - sumSpeed / star.mass
    const composition = star.composition
    for(let k = 0; k < count; k++){
        // A negative w is allowed: it means the fragment ends up moving against
        // the star's direction of travel, which is what a violent disruption
        // does to the innermost material. Clamping it at zero here would break
        // the momentum sum that lambda was computed to satisfy, and momentum is
        // the thing that must be exact.
        let w = speeds[k] + lambda
        if(!isFinite(w)) w = 0
        const position = new Vector(positionsX[k], positionsY[k], positionsZ[k])
        const velocity = new Vector(
            hole.velocity.x + hx * w,
            hole.velocity.y + hy * w,
            hole.velocity.z + hz * w
        )
        const fragment = new Planet(position, velocity, masses[k], composition.clone())
        // Debris does not accrete onto debris - see constants.js - so this flag
        // has to be set before the structure cache is trusted.
        fragment.isDebris = true
        fragment.structureDirty = true
        fragment.refreshStructure()
        fragment.debrisHost = hole
        fragment.debrisReturned = false
        fragment.debrisReturnRadius = TIDAL_DEBRIS_RETURN_RADIUS_FACTOR * tidal
        fragment.debrisApoapsisRadius = TIDAL_DEBRIS_APOAPSIS_FACTOR * tidal
        fragment.debrisEscapeRadius = Math.max(TIDAL_DEBRIS_ESCAPE_MIN_RADIUS,
            TIDAL_DEBRIS_ESCAPE_RADIUS_FACTOR * tidal)
        fragment.debrisBirthTime = simulation.time
        state.particles.push(fragment)
        simulation.addPlanet(fragment)
    }
    state.events++
    state.spawned += count
    return count
}

/**
 * One step of debris housekeeping, called once per step from Simulation.step().
 * Returns the same bitmask resolveCollisions does: 1 if a body was removed, so
 * that step()'s existing compact() picks the removals up.
 *
 * TWO JOBS.
 *
 * 1. FALLBACK. A fragment that has been out past TIDAL_DEBRIS_APOAPSIS_FACTOR
 *    tidal radii and comes back inside TIDAL_DEBRIS_RETURN_RADIUS_FACTOR of
 *    them has completed one orbit and returned to periapsis; it is accreted.
 *    The "has been out" test is what stops the whole stream being eaten during
 *    the disruption passage itself, when every fragment is inside the tidal
 *    radius by construction and none of it has fallen back yet.
 *
 *    This is the standard prompt-accretion closure of semi-analytic TDE models,
 *    and it is why the flare is a flare: mergeInto() hands the mass to the hole
 *    through transferMassTo(), which feeds accretionReservoir, which
 *    updateBlackHoleAccretion() drains into light. Nothing new is needed for
 *    the light curve - the returning debris IS the light curve.
 *
 * 2. CLEANUP, every TIDAL_DEBRIS_CLEANUP_INTERVAL steps. Unbound fragments past
 *    their escape radius are never coming back and nobody can see them, so they
 *    are COALESCED - merged into each other, up to TIDAL_DEBRIS_MAX_PARTICLE_MASS
 *    per remnant - rather than deleted. Merging conserves mass, momentum and
 *    every species exactly (it is the same transferMassTo() every accretion in
 *    the simulation uses), where deleting would quietly leak all three. The
 *    price is that the escaped stream's geometry is destroyed, which is exactly
 *    why the threshold is hundreds of tidal radii out.
 */
function tidalDebrisTick(simulation, force){
    if(!TIDAL_DEBRIS_ENABLED)
        return 0
    const state = tidalDebrisState(simulation, false)
    if(!state)
        return 0
    const particles = state.particles
    const total = particles.length
    if(total === 0)
        return 0
    const sweep = force || (state.ticks % TIDAL_DEBRIS_CLEANUP_INTERVAL) === 0
    state.ticks++
    let flags = 0
    let write = 0
    let sink = null
    for(let i = 0; i < total; i++){
        const fragment = particles[i]
        if(fragment.removed)
            continue                    // the hole ate it through the normal path
        const host = fragment.debrisHost
        if(!host || host.removed || !(host.mass > 0)){
            particles[write++] = fragment
            continue
        }
        const dx = fragment.position.x - host.position.x
        const dy = fragment.position.y - host.position.y
        const dz = fragment.position.z - host.position.z
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if(distance > fragment.debrisApoapsisRadius)
            fragment.debrisReturned = true
        // Inside the horizon (or inside the softening length, below which the
        // force law is not the force law any more) it is gone whatever it was
        // doing - the "must have completed an orbit first" rule does not apply
        // to something that is already through the event horizon.
        const swallowed = distance < Math.max(schwarzschildRadius(host.mass),
            BLACK_HOLE_MIN_CAPTURE_RADIUS)
        if(swallowed || (fragment.debrisReturned && distance < fragment.debrisReturnRadius)){
            state.accreted++
            state.accretedMass += fragment.mass
            state.lastFallbackTime = simulation.time
            fragment.mergeInto(host)
            fragment.removed = true
            flags |= 1
            continue
        }
        if(sweep && distance > fragment.debrisEscapeRadius &&
            tidalDebrisSpecificEnergy(fragment, host) > 0){
            if(sink && sink.mass + fragment.mass <= TIDAL_DEBRIS_MAX_PARTICLE_MASS){
                fragment.mergeInto(sink)
                fragment.removed = true
                state.coalesced++
                flags |= 1
                continue
            }
            sink = fragment
        }
        particles[write++] = fragment
    }
    particles.length = write
    return flags
}

/**
 * How well resolved a disruption by a hole of this mass would be: the tidal
 * radius in units of the softening length. Diagnostic only - nothing branches
 * on it - but it is the number that says whether to believe the stream.
 *
 *     10 Msun     10x     mush: the star is destroyed inside the region where
 *                         the force law is flattened, the capture fires nine
 *                         tidal radii out, dv/v is of order 1, and the measured
 *                         fallback exponent is -2.5 rather than -5/3
 *     1e4 Msun    100x    marginal
 *     1e6 Msun    465x    well posed
 *     4.3e6 Msun  756x    well posed (Sagittarius A*)
 */
function tidalDebrisResolution(holeMass){
    return tidalDisruptionRadius(holeMass, 1, SOLAR_RADIUS) / SOFTENING
}
