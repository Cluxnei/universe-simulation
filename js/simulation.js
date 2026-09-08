/**
 * The simulation: a set of bodies handed to it by a scenario, integrated in
 * solar masses, astronomical units and years (G = 4*PI^2).
 *
 * IT NO LONGER BUILDS ITS OWN UNIVERSE. scenarios.js decides what exists, where
 * it is and what it is made of; this class only integrates it. That inversion
 * is what makes several stars, a cluster or a collision possible at all - the
 * old constructor could only ever produce one star and one disk.
 *
 * The integrator is Velocity-Verlet with pair-symmetric force accumulation, so
 * total momentum is conserved to round-off. Gravity is Barnes-Hut over the
 * light bodies, plus EVERY star summed EXACTLY, body by body: the stars hold
 * almost all of the mass and there are only ever a handful to a few hundred of
 * them, so approximating them through the tree would wreck every orbit for no
 * meaningful saving. Collisions are swept (continuous), and accretion is
 * momentum- and element-conserving.
 */

class Simulation{
    /**
     * `bodies` is a finished array of Planets from a scenario; `meta` is the
     * scenario's BuildResult meta. Both are optional: with no arguments the
     * default scenario is built, so a caller that forgets still gets a universe.
     */
    constructor(bodies, meta){
        const built = Simulation.resolveBodies(bodies, meta)
        this.planets = built.bodies
        this.meta = built.meta
        this.scenarioId = built.meta.scenarioId
        // Every star in the system, direct-summed outside the tree, heaviest
        // first. `star` is the dominant one and is kept for compatibility: the
        // HUD, the renderer and the orbital elements all still read it.
        this.stars = []
        this.star = null
        // Runtime switches for the two non-conservative processes, so the UI
        // and the verification harness can turn them off without editing code.
        this.gasAccretionEnabled = GAS_ACCRETION_ENABLED && this.meta.gasAccretion
        this.fusionEnabled = FUSION_ENABLED && this.meta.fusion
        this.gasReservoir = GAS_DISK_MASS
        this.gasAccreted = 0
        // Gas comes from outside the N-body system. Book what it injects so the
        // conservation checks can subtract it and stay exact.
        this.injectedMass = 0
        this.injectedMomentum = new Vector()
        this.gasVelocity = new Vector()
        this.fusionEnergyReleased = 0
        this.nebularComposition = new Composition()
        // The timestep the scenario asked for. A tight binary needs a far
        // smaller one than a 20 AU disk, and using the disk's dt on the binary
        // makes it visibly wrong within one orbit.
        this.dt = this.meta.suggestedDt
        this.refreshStars()
        // Which way the disk turns. Accreted gas has to orbit with it, not
        // against it: gas on a retrograde orbit torques a growing planet's
        // angular momentum away and drops it straight into the star.
        this.diskNormal = new Vector(0, 1, 0)
        if(this.meta.diskNormal)
            this.diskNormal.set(this.meta.diskNormal.x, this.meta.diskNormal.y, this.meta.diskNormal.z)
        else
            this.measureDiskNormal()
        this.removedListeners = []
        this.spawnedListeners = []
        this.octree = new Octree(BARNES_HUT_THETA, SOFTENING)
        this.useBarnesHut = USE_BARNES_HUT
        this.softeningSquared = SOFTENING_SQUARED
        // scratch force accumulators, sized lazily, never reallocated per step
        this.accelerationX = new Float64Array(0)
        this.accelerationY = new Float64Array(0)
        this.accelerationZ = new Float64Array(0)
        this.previousAccelerationX = new Float64Array(0)
        this.previousAccelerationY = new Float64Array(0)
        this.previousAccelerationZ = new Float64Array(0)
        this.treeAcceleration = new Float64Array(3)
        // the light bodies handed to the octree: everything except the stars
        this.treeBodies = []
        this.treeIndex = new Int32Array(0)
        // ordinal of each body in this.stars, or -1. Rebuilt every acceleration
        // pass so the direct sum can skip star-star pairs it has already done.
        this.starOrdinal = new Int32Array(0)
        this.starSlots = new Int32Array(0)
        // collision broad phase scratch
        this.cellX = new Int32Array(0)
        this.cellY = new Int32Array(0)
        this.cellZ = new Int32Array(0)
        this.cellHash = new Int32Array(0)
        this.cellEntries = new Int32Array(0)
        this.cellStart = new Int32Array(0)
        this.cellEnd = new Int32Array(0)
        this.tableSize = 0
        this.visitedHashes = new Int32Array(27)
        this.accelerationsValid = false
        this.time = 0
        this.steps = 0
        this.collisions = 0
        this.disruptions = 0
        this.absorbedByStar = 0
        // Stars (and anything else) torn apart and swallowed by a black hole.
        this.tidalDisruptions = 0
        this.blackHoleAccretionEnabled = BLACK_HOLE_ACCRETION_ENABLED
        this.blackHoleAccreted = 0
    }

    // ---------------------------------------------------------------- scenarios

    /** Build a named scenario and wrap it in a Simulation. */
    static fromScenario(id, params){
        const result = buildScenario(id, params)
        return new Simulation(result.bodies, result.meta)
    }

    /**
     * Normalise whatever the caller passed into a (bodies, meta) pair.
     *
     * With no bodies we build the default scenario. If scenarios.js is missing
     * entirely - the script tag was not added - we fall back to a lone star
     * rather than throwing, and say so loudly: an empty sky is a far more
     * obvious symptom than a silent exception during page load.
     */
    static resolveBodies(bodies, meta){
        if(Array.isArray(bodies) && bodies.length > 0)
            return { bodies: bodies, meta: Simulation.normalizeMeta(meta) }
        if(typeof buildScenario === 'function'){
            const built = buildScenario(
                meta && meta.scenarioId ? meta.scenarioId : DEFAULT_SCENARIO_ID, null)
            return { bodies: built.bodies, meta: Simulation.normalizeMeta(built.meta) }
        }
        if(typeof console !== 'undefined' && console.warn)
            console.warn('Simulation: scenarios.js is not loaded, falling back to a single star.')
        const star = new Planet(new Vector(), new Vector(), STAR_MASS, new Composition())
        star.isStar = true
        return { bodies: [star], meta: Simulation.normalizeMeta(meta) }
    }

    /** Every meta field the scenario contract promises, present and finite. */
    static normalizeMeta(meta){
        const source = meta || {}
        return {
            scenarioId: source.scenarioId || (typeof DEFAULT_SCENARIO_ID === 'string'
                ? DEFAULT_SCENARIO_ID : 'planetary-system'),
            label: source.label || 'Sistema',
            suggestedDt: isFinite(source.suggestedDt) && source.suggestedDt > 0
                ? source.suggestedDt : FIXED_DT,
            cameraDistance: isFinite(source.cameraDistance) && source.cameraDistance > 0
                ? source.cameraDistance : 2 * DISK_OUTER_RADIUS,
            diskNormal: source.diskNormal || null,
            gasAccretion: source.gasAccretion !== undefined ? !!source.gasAccretion : true,
            fusion: source.fusion !== undefined ? !!source.fusion : true,
            gasInnerRadius: isFinite(source.gasInnerRadius) && source.gasInnerRadius > 0
                ? source.gasInnerRadius : DISK_INNER_RADIUS,
            gasOuterRadius: isFinite(source.gasOuterRadius) && source.gasOuterRadius > 0
                ? source.gasOuterRadius : DISK_OUTER_RADIUS,
            notes: source.notes || ''
        }
    }

    // ---------------------------------------------------------------- stars

    /**
     * Rebuild the list of bodies that are summed exactly outside the tree.
     *
     * A body qualifies if a scenario flagged it (`isStar`) or if it has grown
     * into CLASS_STAR since - a merger of two brown dwarfs really does light up,
     * and it must then start being treated as a star by the force solver and by
     * fusion. Sorted heaviest first, so `stars[0]` is the dominant star and the
     * ordering is stable for the HUD.
     *
     * Cheap - one O(n) pass - and called only when the body set or a mass could
     * have changed, never on a quiet step.
     */
    refreshStars(){
        const planets = this.planets
        const stars = this.stars
        stars.length = 0
        for(let i = 0; i < planets.length; i++){
            const planet = planets[i]
            if(planet.removed) continue
            planet.isCentralStar = false
            planet.starIndex = -1
            // Black holes join this list too. Not because they shine - they do
            // not - but because the list IS the direct-summation set: everything
            // on it is summed exactly, body by body, outside the Barnes-Hut
            // tree. A black hole is one of the heaviest bodies in any system
            // that contains one, and approximating it through the tree would
            // wreck every orbit around it, for the same reason it would for a
            // star. Its gravity is in no other way special: same G, same 1/r^2,
            // same softening, same pair-symmetric accumulation.
            if(planet.isStar || planet.classification === CLASS_STAR ||
                planet.classification === CLASS_BLACK_HOLE){
                planet.isStar = true
                stars.push(planet)
            }
        }
        // No star at all - a disk with the star switched off, or a cluster that
        // has merged away to nothing. The heaviest body then stands in, so the
        // HUD and the orbital elements still have a reference.
        if(stars.length === 0){
            let heaviest = null
            for(let i = 0; i < planets.length; i++){
                const planet = planets[i]
                if(planet.removed) continue
                if(!heaviest || planet.mass > heaviest.mass) heaviest = planet
            }
            this.star = heaviest
            if(heaviest) heaviest.isCentralStar = true
            return this.stars
        }
        stars.sort((a, b) => b.mass - a.mass)
        for(let k = 0; k < stars.length; k++)
            stars[k].starIndex = k
        this.star = stars[0]
        this.star.isCentralStar = true
        return stars
    }

    /** The dominant star, or the heaviest body if there is none. */
    findCentralStar(){
        this.refreshStars()
        return this.star
    }

    /**
     * Move to the barycentre and kill the net momentum, stars included, so the
     * whole system does not translate off screen over a long run. Scaling is
     * not involved: the orbits were built Keplerian and must stay that way.
     *
     * Scenarios do this for themselves (scenarioCenter in scenarios.js); this
     * stays for callers that assemble bodies by hand.
     */
    conditionInitialState(planets){
        const n = planets.length
        if(n === 0) return planets
        let totalMass = 0
        let cx = 0, cy = 0, cz = 0
        let vx = 0, vy = 0, vz = 0
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            totalMass += planet.mass
            cx += planet.mass * planet.position.x
            cy += planet.mass * planet.position.y
            cz += planet.mass * planet.position.z
            vx += planet.mass * planet.velocity.x
            vy += planet.mass * planet.velocity.y
            vz += planet.mass * planet.velocity.z
        }
        if(!(totalMass > 0)) return planets
        cx /= totalMass; cy /= totalMass; cz /= totalMass
        vx /= totalMass; vy /= totalMass; vz /= totalMass
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            planet.position.x -= cx
            planet.position.y -= cy
            planet.position.z -= cz
            planet.velocity.x -= vx
            planet.velocity.y -= vy
            planet.velocity.z -= vz
            planet.previousPosition.copyFrom(planet.position)
        }
        return planets
    }

    /**
     * Unit vector along the total orbital angular momentum of the light bodies
     * about the dominant star. Every scenario here builds its disk in the
     * xz-plane, so this comes out as +y, but it is measured rather than assumed
     * so a hand-built system still gets its gas accretion the right way round.
     * A scenario that knows its own plane passes it in meta.diskNormal and this
     * is never called.
     */
    measureDiskNormal(){
        const star = this.star
        const planets = this.planets
        let hx = 0, hy = 0, hz = 0
        if(star){
            for(let i = 0; i < planets.length; i++){
                const planet = planets[i]
                if(planet === star || planet.removed) continue
                const rx = planet.position.x - star.position.x
                const ry = planet.position.y - star.position.y
                const rz = planet.position.z - star.position.z
                const vx = planet.velocity.x - star.velocity.x
                const vy = planet.velocity.y - star.velocity.y
                const vz = planet.velocity.z - star.velocity.z
                hx += planet.mass * (ry * vz - rz * vy)
                hy += planet.mass * (rz * vx - rx * vz)
                hz += planet.mass * (rx * vy - ry * vx)
            }
        }
        const magnitude = Math.hypot(hx, hy, hz)
        if(magnitude > 0)
            this.diskNormal.set(hx / magnitude, hy / magnitude, hz / magnitude)
        else
            this.diskNormal.set(0, 1, 0)
        return this.diskNormal
    }

    addPlanet(planet){
        this.planets.push(planet)
        this.accelerationsValid = false
        // A spawned star, or black hole, has to join the direct-sum set before
        // the next step.
        if(planet.isStar || planet.classification === CLASS_STAR ||
            planet.classification === CLASS_BLACK_HOLE)
            this.refreshStars()
        for(let i = 0; i < this.spawnedListeners.length; i++)
            this.spawnedListeners[i](planet)
        return planet
    }

    spawnPlanet(planet){
        return this.addPlanet(planet)
    }

    removePlanet(planet){
        const index = this.planets.indexOf(planet)
        planet.removed = true
        if(index >= 0)
            this.planets.splice(index, 1)
        if(planet.isStar)
            this.refreshStars()
        this.accelerationsValid = false
        this.notifyRemoved(planet)
        return planet
    }

    onPlanetRemoved(callback){
        if(typeof callback === 'function')
            this.removedListeners.push(callback)
        return this
    }

    onPlanetSpawned(callback){
        if(typeof callback === 'function')
            this.spawnedListeners.push(callback)
        return this
    }

    notifyRemoved(planet){
        for(let i = 0; i < this.removedListeners.length; i++)
            this.removedListeners[i](planet)
    }

    // ---------------------------------------------------------------- integration

    ensureCapacity(n){
        if(this.accelerationX.length >= n) return
        const size = Math.max(n, 64)
        this.accelerationX = new Float64Array(size)
        this.accelerationY = new Float64Array(size)
        this.accelerationZ = new Float64Array(size)
        this.previousAccelerationX = new Float64Array(size)
        this.previousAccelerationY = new Float64Array(size)
        this.previousAccelerationZ = new Float64Array(size)
        this.treeIndex = new Int32Array(size)
        this.starOrdinal = new Int32Array(size)
        this.cellX = new Int32Array(size)
        this.cellY = new Int32Array(size)
        this.cellZ = new Int32Array(size)
        this.cellHash = new Int32Array(size)
        this.cellEntries = new Int32Array(size)
    }

    setBarnesHut(enabled){
        this.useBarnesHut = !!enabled
        this.accelerationsValid = false
        return this
    }

    computeAccelerations(){
        const planets = this.planets
        const n = planets.length
        this.ensureCapacity(n)
        const ax = this.accelerationX, ay = this.accelerationY, az = this.accelerationZ
        ax.fill(0, 0, n)
        ay.fill(0, 0, n)
        az.fill(0, 0, n)
        if(this.useBarnesHut && n > BARNES_HUT_MIN_BODIES){
            // Light bodies through the tree, every star exactly. The two passes
            // touch disjoint pairs - the tree never sees a star and the direct
            // sum covers every pair involving one - so nothing is counted twice
            // and nothing is missed.
            this.markStars(n)
            this.accumulateBarnesHut(n, ax, ay, az)
            this.accumulateStars(n, ax, ay, az)
        }else{
            // Brute force is already exact for every pair, star included.
            this.accumulateBruteForce(n, ax, ay, az)
        }
        for(let i = 0; i < n; i++){
            const acceleration = planets[i].acceleration
            acceleration.x = ax[i]
            acceleration.y = ay[i]
            acceleration.z = az[i]
        }
    }

    // Every pair is visited once and the force is applied with opposite signs to both
    // bodies, so Newton's third law holds exactly. Plummer softening keeps it finite.
    accumulateBruteForce(n, ax, ay, az){
        const planets = this.planets
        const gravitation = GRAVITATION_CONSTANT
        const eps2 = this.softeningSquared
        for(let i = 0; i < n; i++){
            const a = planets[i]
            if(a.removed) continue
            const px = a.position.x, py = a.position.y, pz = a.position.z
            const mi = a.mass
            for(let j = i + 1; j < n; j++){
                const b = planets[j]
                if(b.removed) continue
                const dx = b.position.x - px
                const dy = b.position.y - py
                const dz = b.position.z - pz
                const s2 = dx * dx + dy * dy + dz * dz + eps2
                const inv = gravitation / (s2 * Math.sqrt(s2))
                const mj = b.mass
                const fi = inv * mj
                const fj = inv * mi
                ax[i] += fi * dx
                ay[i] += fi * dy
                az[i] += fi * dz
                ax[j] -= fj * dx
                ay[j] -= fj * dy
                az[j] -= fj * dz
            }
        }
    }

    /**
     * Index every star so the direct sum can find them in one pass.
     *
     * starOrdinal[i] is the body's position in this.stars, or -1 if it is not a
     * star. That single array does two jobs: it tells the tree pass which
     * bodies to leave out, and it lets the direct sum skip the half of the
     * star-star pairs it has already visited.
     */
    markStars(n){
        const planets = this.planets
        const ordinal = this.starOrdinal
        ordinal.fill(-1, 0, n)
        if(this.starSlots.length < this.stars.length)
            this.starSlots = new Int32Array(Math.max(this.stars.length, 8))
        const slots = this.starSlots
        slots.fill(-1)
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            if(planet.removed) continue
            const index = planet.starIndex
            if(index < 0 || index >= this.stars.length) continue
            ordinal[i] = index
            slots[index] = i
        }
    }

    accumulateBarnesHut(n, ax, ay, az){
        const planets = this.planets
        const ordinal = this.starOrdinal
        const bodies = this.treeBodies
        const treeIndex = this.treeIndex
        bodies.length = 0
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            if(planet.removed || ordinal[i] >= 0){
                treeIndex[i] = -1
                continue
            }
            treeIndex[i] = bodies.length
            bodies.push(planet)
        }
        const count = bodies.length
        if(count === 0) return
        const tree = this.octree
        tree.setSoftening(Math.sqrt(this.softeningSquared))
        tree.build(bodies, count)
        const out = this.treeAcceleration
        let totalMass = 0
        let netX = 0, netY = 0, netZ = 0
        for(let i = 0; i < n; i++){
            const slot = treeIndex[i]
            if(slot < 0) continue
            const planet = planets[i]
            tree.accelerationFor(planet, out, slot)
            ax[i] += out[0]
            ay[i] += out[1]
            az[i] += out[2]
            totalMass += planet.mass
            netX += planet.mass * out[0]
            netY += planet.mass * out[1]
            netZ += planet.mass * out[2]
        }
        // Tree forces are not pair symmetric, so they leave a small spurious net force
        // on the system. Subtracting it as a uniform acceleration restores sum(m*a) = 0
        // without touching any relative acceleration. It is applied only to the bodies
        // that went through the tree; the stars' contribution below is already exact.
        if(totalMass > 0){
            const cx = netX / totalMass, cy = netY / totalMass, cz = netZ / totalMass
            for(let i = 0; i < n; i++){
                if(treeIndex[i] < 0) continue
                ax[i] -= cx
                ay[i] -= cy
                az[i] -= cz
            }
        }
    }

    /**
     * The gravity of every star, summed body by body and never through the tree.
     *
     * The stars carry almost all of the mass, so the orbit of every light body
     * is its orbit around these few terms; a multipole approximation of them
     * would dominate the error budget of the whole simulation. There are only
     * ever a handful to a few hundred of them, so this is O(S*n) and exact,
     * against O(n log n) and approximate for everything else.
     *
     * Written pair-symmetrically, so each star recoils from everything it pulls
     * and momentum is conserved to round-off. Star-star pairs are visited once:
     * the inner loop skips any star whose ordinal is lower than the outer one's,
     * because that pair was already done.
     */
    accumulateStars(n, ax, ay, az){
        const stars = this.stars
        if(stars.length === 0) return
        const planets = this.planets
        const ordinal = this.starOrdinal
        const slots = this.starSlots
        const gravitation = GRAVITATION_CONSTANT
        const eps2 = this.softeningSquared
        for(let s = 0; s < stars.length; s++){
            const star = stars[s]
            const index = slots[s]
            if(index < 0 || star.removed || !(star.mass > 0)) continue
            const sx = star.position.x, sy = star.position.y, sz = star.position.z
            const starMass = star.mass
            let starX = 0, starY = 0, starZ = 0
            for(let i = 0; i < n; i++){
                if(i === index) continue
                // already handled when the other star was the outer body
                if(ordinal[i] >= 0 && ordinal[i] < s) continue
                const planet = planets[i]
                if(planet.removed) continue
                const dx = sx - planet.position.x
                const dy = sy - planet.position.y
                const dz = sz - planet.position.z
                const s2 = dx * dx + dy * dy + dz * dz + eps2
                const inv = gravitation / (s2 * Math.sqrt(s2))
                const toStar = inv * starMass
                ax[i] += toStar * dx
                ay[i] += toStar * dy
                az[i] += toStar * dz
                const toBody = inv * planet.mass
                starX -= toBody * dx
                starY -= toBody * dy
                starZ -= toBody * dz
            }
            ax[index] += starX
            ay[index] += starY
            az[index] += starZ
        }
    }

    // Velocity-Verlet, applied as three separate passes over the whole array so no
    // body ever sees another body that has already moved this step.
    step(dt = this.dt){
        if(!isFinite(dt) || dt <= 0) return this
        const planets = this.planets
        const n = planets.length
        if(n === 0) return this
        this.ensureCapacity(n)
        if(!this.accelerationsValid){
            this.computeAccelerations()
            this.accelerationsValid = true
        }
        const ax = this.accelerationX, ay = this.accelerationY, az = this.accelerationZ
        const pax = this.previousAccelerationX, pay = this.previousAccelerationY, paz = this.previousAccelerationZ
        for(let i = 0; i < n; i++){
            pax[i] = ax[i]
            pay[i] = ay[i]
            paz[i] = az[i]
        }
        // drift: x += v*dt + 0.5*a*dt^2
        const halfDtSquared = 0.5 * dt * dt
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            const position = planet.position
            const previous = planet.previousPosition
            previous.x = position.x
            previous.y = position.y
            previous.z = position.z
            planet.previousAcceleration.x = pax[i]
            planet.previousAcceleration.y = pay[i]
            planet.previousAcceleration.z = paz[i]
            position.x += planet.velocity.x * dt + pax[i] * halfDtSquared
            position.y += planet.velocity.y * dt + pay[i] * halfDtSquared
            position.z += planet.velocity.z * dt + paz[i] * halfDtSquared
        }
        // new accelerations from the new positions
        this.computeAccelerations()
        // kick: v += 0.5*(a_old + a_new)*dt
        const halfDt = 0.5 * dt
        for(let i = 0; i < n; i++){
            const velocity = planets[i].velocity
            velocity.x += (pax[i] + ax[i]) * halfDt
            velocity.y += (pay[i] + ay[i]) * halfDt
            velocity.z += (paz[i] + az[i]) * halfDt
        }
        this.accelerationsValid = true
        let changes = this.resolveCollisions()
        // Tidal debris fallback and cleanup (js/debris.js). It returns the same
        // bitmask resolveCollisions does - 1 when it removed a body - so the
        // compact() below picks its removals up with no further plumbing. With
        // TIDAL_DEBRIS_ENABLED off, or with debris.js not loaded at all, both
        // tests fold away and nothing is called.
        if(TIDAL_DEBRIS_ENABLED && typeof tidalDebrisTick === 'function')
            changes |= tidalDebrisTick(this, false)
        if(changes & 1)
            this.compact()
        if(changes !== 0)
            this.accelerationsValid = false
        // Anything that moved mass around can have removed a star, or pushed a
        // body over the hydrogen-burning limit into becoming one. The star list
        // is what the force solver splits on and what gas accretion feeds from,
        // so it is refreshed before either of them runs.
        if(changes !== 0)
            this.refreshStars()
        if(this.updateGasAccretion(dt))
            this.accelerationsValid = false
        this.updateFusion(dt)
        // Last, so it has the final word on the luminosity of a black hole that
        // ate something this step: refreshStructure() zeroes that field, and
        // anything above can trigger a refresh.
        this.updateBlackHoleAccretion(dt)
        this.time += dt
        this.steps++
        return this
    }

    update(dt = this.dt){
        return this.step(dt)
    }

    compact(){
        const planets = this.planets
        const n = planets.length
        let write = 0
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            if(planet.removed)
                this.notifyRemoved(planet)
            else
                planets[write++] = planet
        }
        planets.length = write
    }

    // ---------------------------------------------------------------- gas and fusion

    /**
     * Runaway gas accretion, the only reason a gas giant can exist at all.
     *
     * Bodies condense out of the disk as ice, rock and metal - gas fraction
     * exactly zero - so classify() could never return gasGiant and no Jupiter
     * could ever form no matter how much solid material a body swept up. Here a
     * core past the critical mass, still inside the gas disk, starts pulling
     * nebular H/He onto itself:
     *
     *     dM/dt = M / tau,  capped by GAS_ACCRETION_MAX_RATE
     *
     * which is runaway (the more envelope it has, the faster it grows) but
     * bounded three ways: by the rate ceiling, by the gap-opening mass, and by
     * a finite reservoir that itself decays as the disk is photoevaporated.
     *
     * The gas arrives on a circular orbit in the disk plane, which is also
     * physically why giant planets end up on near-circular, near-coplanar
     * orbits: accreting circular material damps eccentricity and inclination.
     *
     * WITH SEVERAL STARS each body is fed by the star that dominates it - the
     * one with the largest m/r^2 at its position - and orbits that star's gas.
     * A body being pulled between two suns is not in anybody's quiet disk and
     * gets nothing, which is right: there is no ordered gas flow there to
     * accrete from.
     *
     * Returns true if anything accreted.
     */
    updateGasAccretion(dt){
        if(!this.gasAccretionEnabled) return false
        // Photoevaporation: the reservoir drains whether or not anyone drinks.
        this.gasReservoir *= Math.exp(-dt / GAS_DISK_DISPERSAL_TIME)
        if(this.gasReservoir <= GAS_DISK_MINIMUM_RESERVOIR){
            this.gasReservoir = 0
            return false
        }
        const stars = this.stars
        if(stars.length === 0) return false
        const inner = this.meta.gasInnerRadius
        const outer = this.meta.gasOuterRadius
        const planets = this.planets
        const growthFactor = Math.expm1(dt / GAS_ACCRETION_TIMESCALE)
        const maxThisStep = GAS_ACCRETION_MAX_RATE * dt
        let accreted = false
        for(let i = 0; i < planets.length; i++){
            const planet = planets[i]
            if(planet.removed || planet.isStar) continue
            if(planet.mass < GAS_ACCRETION_CRITICAL_CORE_MASS) continue
            if(planet.mass >= GAS_ACCRETION_GAP_MASS) continue
            // The star this body actually belongs to, by gravitational pull.
            let star = null
            let distance = 0
            let strongest = 0
            for(let k = 0; k < stars.length; k++){
                const candidate = stars[k]
                if(candidate.removed) continue
                const separation = planet.position.distanceTo(candidate.position)
                if(!(separation > 0)) continue
                const pull = candidate.mass / (separation * separation)
                if(pull > strongest){
                    strongest = pull
                    star = candidate
                    distance = separation
                }
            }
            if(!star) continue
            if(distance < inner || distance > outer) continue
            const dx = planet.position.x - star.position.x
            const dy = planet.position.y - star.position.y
            const dz = planet.position.z - star.position.z
            let growth = planet.mass * growthFactor
            if(growth > maxThisStep) growth = maxThisStep
            if(growth > GAS_ACCRETION_GAP_MASS - planet.mass) growth = GAS_ACCRETION_GAP_MASS - planet.mass
            if(growth > this.gasReservoir) growth = this.gasReservoir
            if(!(growth > 0)) continue
            // Circular velocity of the gas at this radius: prograde with the
            // disk, tangential, in the disk plane, on top of the star's own
            // motion. The direction is diskNormal x r, normalised.
            const n = this.diskNormal
            let tx = n.y * dz - n.z * dy
            let ty = n.z * dx - n.x * dz
            let tz = n.x * dy - n.y * dx
            const tangent = Math.sqrt(tx * tx + ty * ty + tz * tz)
            let gx = star.velocity.x, gy = star.velocity.y, gz = star.velocity.z
            if(tangent > 0){
                const speed = circularOrbitalSpeed(distance, star.mass) / tangent
                gx += speed * tx
                gy += speed * ty
                gz += speed * tz
            }
            this.gasVelocity.set(gx, gy, gz)
            planet.accreteGas(growth, this.nebularComposition, this.gasVelocity)
            this.gasReservoir -= growth
            this.gasAccreted += growth
            this.injectedMass += growth
            this.injectedMomentum.addScaled(this.gasVelocity, growth)
            accreted = true
        }
        return accreted
    }

    /**
     * Nuclear burning, for stars only.
     *
     * GATED ON MASS, NOT ON TEMPERATURE. structure.centralTemperature() assumes
     * an ideal gas held up by heat, and below ~0.5 Msun a body is partly held
     * up by electron degeneracy instead, which costs no temperature: the
     * estimate runs up to 4x high there (1.19e7 K computed against ~3e6 K real
     * at 0.08 Msun). A 1e7 K ignition threshold would therefore light up brown
     * dwarfs as if they were stars. classify() returns CLASS_STAR exactly when
     * mass >= HYDROGEN_BURNING_MASS, which is the honest test; the central
     * temperature is then used only to decide which stages run and how fast.
     *
     * Called for stars only - it is pointless for 800 planetesimals.
     */
    updateFusion(dt){
        if(!this.fusionEnabled) return false
        const planets = this.planets
        let burned = false
        for(let i = 0; i < planets.length; i++){
            const planet = planets[i]
            // CLASS_STAR only, which excludes black holes by construction:
            // classify() returns 'blackHole' for one at any mass, so burn() is
            // never called on a body that has no interior to burn in. There is
            // no fusion inside a black hole, and its composition is a ledger of
            // what fell in rather than a description of anything.
            if(planet.removed || planet.classification !== CLASS_STAR) continue
            const result = planet.composition.burn(
                planet.centralTemperature, planet.mass, dt * FUSION_TIME_SCALE)
            if(result.changed){
                this.fusionEnergyReleased += result.energyReleased
                planet.markCompositionChanged().refreshStructure()
                burned = true
            }
        }
        return burned
    }

    /**
     * Accretion luminosity, the brightest engine in the universe.
     *
     * A black hole converts up to ~10% of the rest mass of what it swallows into
     * light - against 0.7% for hydrogen fusion - which is why a quasar outshines
     * its entire host galaxy from a region the size of the solar system.
     *
     * THE HOLE IS STILL BLACK. Nothing leaves the horizon. The light comes from
     * the accretion disk outside it: matter tidally shredded, circularised, and
     * heated by viscous friction as it spirals in. So it is reported through the
     * body's normal `luminosity` field, in solar luminosities, where the HUD and
     * the renderer already look - while `isLuminous` stays false and the body's
     * colour stays the horizon's, because the emission has no surface.
     *
     * Captured mass does not radiate all at once: it drains out of
     * `accretionReservoir` on the disk's viscous timescale, so one tidal
     * disruption becomes a flare that rises in a step and fades over years.
     *
     * NO MASS IS LOST. The radiated energy is not subtracted from the hole -
     * doing so would break the mass conservation check for a term of order
     * 1e-1 * v^2/c^2 of a swallowed body. The luminosity is bookkeeping on top
     * of an exactly conservative merge.
     */
    updateBlackHoleAccretion(dt){
        if(!this.blackHoleAccretionEnabled || !(dt > 0)) return false
        const planets = this.planets
        // Fraction of the reservoir that drains this step, from the exponential
        // decay: 1 - exp(-dt/tau), written with expm1 so it stays accurate for
        // the small dt this simulation actually uses.
        const drainFraction = -Math.expm1(-dt / BLACK_HOLE_ACCRETION_TIMESCALE)
        let shining = false
        for(let i = 0; i < planets.length; i++){
            const planet = planets[i]
            if(planet.removed || !planet.isBlackHole) continue
            const reservoir = planet.accretionReservoir
            if(!(reservoir > BLACK_HOLE_MIN_ACCRETION_RESERVOIR)){
                planet.accretionReservoir = 0
                planet.accretionRate = 0
                planet.accretionLuminosity = 0
                planet.luminosity = 0
                continue
            }
            const drained = reservoir * drainFraction
            planet.accretionReservoir = reservoir - drained
            planet.accretionRate = drained / dt
            planet.accretionLuminosity =
                accretionDiskLuminosity(planet.mass, planet.accretionRate)
            planet.luminosity = planet.accretionLuminosity
            this.blackHoleAccreted += drained
            shining = true
        }
        return shining
    }

    // ---------------------------------------------------------------- collisions

    // Uniform spatial hash sized so that any pair that can touch during this step
    // shares a cell or sits in one of the 26 neighbours. The reach is the accretion
    // radius, with room for the gravitational focusing enhancement applied in
    // handlePair(), not the physical radius.
    buildCollisionGrid(n){
        const planets = this.planets
        const focus = USE_GRAVITATIONAL_FOCUSING ? GRAVITATIONAL_FOCUSING_MAX : 1
        let reach = 0
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            if(planet.removed) continue
            const displacement = planet.position.distanceTo(planet.previousPosition)
            const candidate = planet.accretionRadius * focus + displacement
            if(candidate > reach) reach = candidate
        }
        const cellSize = Math.max(2 * reach, 1e-6)
        this.cellSize = cellSize
        let tableSize = 64
        while(tableSize < n * 2) tableSize *= 2
        if(this.tableSize !== tableSize){
            this.tableSize = tableSize
            this.cellStart = new Int32Array(tableSize)
            this.cellEnd = new Int32Array(tableSize)
        }
        const cellStart = this.cellStart, cellEnd = this.cellEnd
        cellStart.fill(0)
        const inverse = 1 / cellSize
        const cellX = this.cellX, cellY = this.cellY, cellZ = this.cellZ, cellHash = this.cellHash
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            const gx = Math.floor(planet.position.x * inverse)
            const gy = Math.floor(planet.position.y * inverse)
            const gz = Math.floor(planet.position.z * inverse)
            cellX[i] = gx
            cellY[i] = gy
            cellZ[i] = gz
            const hash = this.hashCell(gx, gy, gz)
            cellHash[i] = hash
            cellStart[hash]++
        }
        let total = 0
        for(let h = 0; h < tableSize; h++){
            total += cellStart[h]
            cellStart[h] = total
            cellEnd[h] = total
        }
        const entries = this.cellEntries
        for(let i = 0; i < n; i++)
            entries[--cellStart[cellHash[i]]] = i
    }

    hashCell(x, y, z){
        const hash = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791))
        return hash & (this.tableSize - 1)
    }

    // returns a bitmask: 1 = a body was removed, 2 = masses or velocities changed
    resolveCollisions(){
        const planets = this.planets
        const n = planets.length
        if(n < 2) return 0
        this.buildCollisionGrid(n)
        const cellStart = this.cellStart, cellEnd = this.cellEnd, entries = this.cellEntries
        const visited = this.visitedHashes
        let flags = 0
        for(let i = 0; i < n; i++){
            const a = planets[i]
            if(a.removed) continue
            // Tidal debris is collisionless (js/debris.js). Skipping it here and
            // in the inner loop below keeps a six-hundred-fragment stream out of
            // the pair tests entirely: the grid sizes its cells from the hole's
            // capture reach, a stream is a thin filament, so every fragment
            // lands in the same handful of cells and the broad phase would
            // otherwise generate the full N^2 - 180000 candidate pairs a step,
            // measured, every one of them rejected for a contact distance of
            // zero. Both tests fold away when the feature is off.
            if(TIDAL_DEBRIS_ENABLED && TIDAL_DEBRIS_COLLISIONLESS && a.isDebris) continue
            const gx = this.cellX[i], gy = this.cellY[i], gz = this.cellZ[i]
            let visitedCount = 0
            for(let ox = -1; ox <= 1 && !a.removed; ox++){
                for(let oy = -1; oy <= 1 && !a.removed; oy++){
                    for(let oz = -1; oz <= 1 && !a.removed; oz++){
                        const hash = this.hashCell(gx + ox, gy + oy, gz + oz)
                        // two neighbour cells can collide in the table, only scan a bucket once
                        let seen = false
                        for(let k = 0; k < visitedCount; k++){
                            if(visited[k] === hash){ seen = true; break }
                        }
                        if(seen) continue
                        visited[visitedCount++] = hash
                        for(let e = cellStart[hash]; e < cellEnd[hash]; e++){
                            const j = entries[e]
                            if(j <= i) continue
                            const b = planets[j]
                            if(b.removed) continue
                            if(TIDAL_DEBRIS_ENABLED && TIDAL_DEBRIS_COLLISIONLESS &&
                                b.isDebris) continue
                            flags |= this.handlePair(a, b)
                            if(a.removed) break
                        }
                    }
                }
            }
        }
        return flags
    }

    /**
     * How far `body` reaches toward `other` for the purpose of capture, in AU.
     *
     * For everything except a black hole this is the inflated accretion radius,
     * unchanged. For a black hole it is the pairwise capture radius - the
     * largest of the pair's tidal disruption radius, the horizon, and the
     * softening length - because the horizon on its own is useless as a target:
     * a 10 Msun hole's is 2e-7 AU, and 800 times it is still 1.6e-5 AU, so a
     * hole using the ordinary rule would never capture anything as long as the
     * simulation ran. The tidal radius is 0.0100 AU for that same hole against a
     * Sun-like star, and 0.465 AU for a million-solar-mass one - macroscopic,
     * and the physically correct place for a star to be destroyed.
     *
     * The stored accretionRadius of a hole is an upper bound on this (it uses a
     * Sun-like victim times BLACK_HOLE_CAPTURE_MARGIN), which is what the
     * collision grid is sized from, so no pair that can capture is ever missed
     * by the broad phase.
     */
    captureReach(body, other){
        if(!body.isBlackHole)
            return body.accretionRadius
        // A HOLE DOES NOT CAPTURE ITS OWN DEBRIS THROUGH THIS RULE. The rule is
        // the pairwise tidal radius, which depends only on the hole's mass and
        // the victim's MEAN DENSITY - and a fragment of a shredded star is a
        // degenerate blob barely denser than the star was, so its tidal radius
        // is nearly the star's own. The hole would swallow the entire stream
        // during the disruption passage itself and nothing would ever escape.
        // Fallback is decided by tidalDebrisTick() instead, after a full orbit.
        if(TIDAL_DEBRIS_ENABLED && other.isDebris)
            return 0
        return blackHoleCaptureRadius(body.mass, other.mass, other.radius)
    }

    /**
     * Swept (continuous) test against the segment travelled this step, so small
     * fast bodies cannot tunnel through each other, against the ACCRETION radii
     * enhanced by gravitational focusing.
     *
     * Focusing is real physics: a body that would have missed is pulled in by
     * the pair's own gravity, and the cross-section is enhanced by
     * (1 + vesc^2/vrel^2), i.e. the capture radius by its square root. The
     * escape speed is evaluated at the capture radius itself - the separation
     * the bodies actually have to reach - and not at the physical surface,
     * which would be inconsistent with the inflated target and would give
     * capture radii larger than the Hill sphere.
     */
    handlePair(a, b){
        let contact = this.captureReach(a, b) + this.captureReach(b, a)
        if(contact <= 0) return 0
        const vx = a.velocity.x - b.velocity.x
        const vy = a.velocity.y - b.velocity.y
        const vz = a.velocity.z - b.velocity.z
        const impactSpeedSquared = vx * vx + vy * vy + vz * vz
        if(USE_GRAVITATIONAL_FOCUSING && impactSpeedSquared > 0){
            const mutualEscape = escapeSpeed(a.mass + b.mass, contact)
            let enhancement = Math.sqrt(1 + (mutualEscape * mutualEscape) / impactSpeedSquared)
            if(enhancement > GRAVITATIONAL_FOCUSING_MAX)
                enhancement = GRAVITATIONAL_FOCUSING_MAX
            contact *= enhancement
        }
        const rx = a.previousPosition.x - b.previousPosition.x
        const ry = a.previousPosition.y - b.previousPosition.y
        const rz = a.previousPosition.z - b.previousPosition.z
        const dvx = (a.position.x - a.previousPosition.x) - (b.position.x - b.previousPosition.x)
        const dvy = (a.position.y - a.previousPosition.y) - (b.position.y - b.previousPosition.y)
        const dvz = (a.position.z - a.previousPosition.z) - (b.position.z - b.previousPosition.z)
        const relative = dvx * dvx + dvy * dvy + dvz * dvz
        let t = 1
        if(relative > 0){
            t = -(rx * dvx + ry * dvy + rz * dvz) / relative
            if(t < 0) t = 0
            else if(t > 1) t = 1
        }
        const cx = rx + t * dvx
        const cy = ry + t * dvy
        const cz = rz + t * dvz
        if(cx * cx + cy * cy + cz * cz >= contact * contact)
            return 0
        // The heavier body is always the receiver, and a star always wins
        // against anything that is not one. Two stars fall back to the mass
        // test, so the heavier of the pair swallows the lighter.
        let donor = a.mass <= b.mass ? a : b
        let receiver = donor === a ? b : a
        if(donor.isStar && !receiver.isStar){
            const swap = donor
            donor = receiver
            receiver = swap
        }
        // A BLACK HOLE ALWAYS WINS, whatever the masses. This is what keeps a
        // hole a hole: the receiver is the body that survives and keeps its
        // composition object, and the composition is where the black hole
        // marker lives. Without this rule a 10 Msun hole meeting a 20 Msun star
        // would be absorbed BY the star and the pair would come out classified
        // as a star, which is not a thing that can happen. Two black holes fall
        // through to the mass test above, so the heavier one swallows the
        // lighter and the result is - necessarily - a black hole.
        if(donor.isBlackHole && !receiver.isBlackHole){
            const swap = donor
            donor = receiver
            receiver = swap
        }
        // Erosive regime: an impact far faster than the target's own escape
        // speed excavates material instead of sticking. The escape speed here is
        // the real one, from the physical surface.
        // For a black hole this can never fire, and pleasingly it needs no
        // special case to not fire: the escape speed from a Schwarzschild radius
        // is exactly c by construction, so the test asks whether the impact was
        // faster than 2.5c. Nothing rebounds off a black hole.
        const targetEscape = escapeSpeed(receiver.mass, receiver.radius)
        if(targetEscape > 0 && impactSpeedSquared >
            FRAGMENTATION_VELOCITY_RATIO * FRAGMENTATION_VELOCITY_RATIO * targetEscape * targetEscape){
            return this.disruptPair(receiver, donor)
        }
        this.collisions++
        if(receiver.isStar)
            this.absorbedByStar++
        // A tidal disruption event. The victim crossed the radius at which the
        // hole's tide beats its own self-gravity, so it is not a body any more.
        //
        // WHAT HAPPENS TO THE DEBRIS: all of it goes in, and NO fragments are
        // spawned. A real disruption unbinds about half the star and returns the
        // rest over months to years; modelling that needs debris bodies, and
        // this simulation already refuses to spawn fragments in the ordinary
        // erosive-impact path (see disruptPair) for the same reason - the body
        // count runs away and the frame rate dies. Swallowing the lot keeps
        // mass, momentum and every element exactly conserved, which is the
        // property worth protecting, and the mass that arrives is what drives
        // the accretion disk's luminosity in updateBlackHoleAccretion().
        if(receiver.isBlackHole){
            this.tidalDisruptions++
            // THE HOOK for the debris stream (js/debris.js). It returns true
            // only when it has taken the disruption over and replaced the
            // victim with fragments; with TIDAL_DEBRIS_ENABLED off - or with
            // debris.js not loaded at all - it is false on its first line and
            // everything below runs exactly as it always did.
            if(typeof tidalDebrisDisrupt === 'function' &&
                tidalDebrisDisrupt(this, receiver, donor))
                return 1
        }
        donor.mergeInto(receiver)
        donor.removed = true
        return 1
    }

    /**
     * Disruptive impact.
     *
     * A real code would replace the pair with a swarm of fragments. We do not:
     * with 800 bodies already, spawning fragments makes the body count run away
     * and the simulation slows to a stop within minutes. Instead the impact is
     * treated as a hit-and-run - the target retains only
     * FRAGMENTATION_ACCRETION_EFFICIENCY of the impactor and the two bodies
     * rebound with restitution FRAGMENTATION_RESTITUTION - which reproduces the
     * physical consequence that matters here (fast impacts do not build
     * planets) without inventing bodies.
     *
     * NOTHING IS LOST. The material that a real disruption would spread into
     * debris stays on the impactor, so mass, momentum and every element are
     * still conserved exactly; only the growth is suppressed.
     */
    disruptPair(receiver, donor){
        this.disruptions++
        let flags = 2
        donor.transferMassTo(receiver, donor.mass * FRAGMENTATION_ACCRETION_EFFICIENCY)
        if(donor.mass <= MIN_PLANET_MASS){
            donor.mergeInto(receiver)
            donor.removed = true
            return 1
        }
        // Rebound along the line of centres, equal and opposite, so momentum is
        // untouched. Only if they are still approaching: without that test a
        // pair sitting inside each other's (hugely inflated) accretion radius
        // would be kicked every step.
        let dx = receiver.position.x - donor.position.x
        let dy = receiver.position.y - donor.position.y
        let dz = receiver.position.z - donor.position.z
        let distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if(distance < 1e-12){
            dx = 1; dy = 0; dz = 0; distance = 1
        }
        const nx = dx / distance, ny = dy / distance, nz = dz / distance
        const approach = (receiver.velocity.x - donor.velocity.x) * nx +
            (receiver.velocity.y - donor.velocity.y) * ny +
            (receiver.velocity.z - donor.velocity.z) * nz
        const totalMass = receiver.mass + donor.mass
        if(approach < 0 && totalMass > 0){
            const impulse = -(1 + FRAGMENTATION_RESTITUTION) * approach *
                (receiver.mass * donor.mass) / totalMass
            const toReceiver = impulse / receiver.mass
            const toDonor = impulse / donor.mass
            receiver.velocity.x += nx * toReceiver
            receiver.velocity.y += ny * toReceiver
            receiver.velocity.z += nz * toReceiver
            donor.velocity.x -= nx * toDonor
            donor.velocity.y -= ny * toDonor
            donor.velocity.z -= nz * toDonor
        }
        return flags
    }

    // ---------------------------------------------------------------- diagnostics

    computeKineticEnergy(planets = this.planets){
        let kinetic = 0
        for(let i = 0; i < planets.length; i++)
            kinetic += planets[i].kineticEnergy()
        return kinetic
    }

    // Softened potential, consistent with the softened force: U = -G m1 m2 / sqrt(d^2 + eps^2)
    computePotentialEnergy(planets = this.planets){
        const n = planets.length
        const eps2 = SOFTENING_SQUARED
        let potential = 0
        for(let i = 0; i < n; i++){
            const a = planets[i]
            for(let j = i + 1; j < n; j++){
                const b = planets[j]
                potential -= GRAVITATION_CONSTANT * a.mass * b.mass /
                    Math.sqrt(a.position.distanceSquaredTo(b.position) + eps2)
            }
        }
        return potential
    }

    /**
     * Which body a given planet's orbit should be measured against.
     *
     * With one star this is trivially the star. With several it is not, and
     * getting it wrong makes the reported semi-major axis meaningless, so the
     * rule is stated here rather than guessed at the call site:
     *
     *  1. The PRIMARY is the star with the largest m/r^2 at the body's
     *     position - the one that actually dominates its motion, which is not
     *     always the heaviest or the nearest.
     *  2. Any other star closer to the primary than HALF the body's distance to
     *     the primary joins the reference set. A body far outside a tight
     *     binary cannot resolve its two components and is really orbiting their
     *     combined mass, so it is measured against their BARYCENTRE; a body
     *     orbiting one member of a wide pair is measured against that member
     *     alone. The one-half is the usual "hierarchical if the ratio is at
     *     least two" criterion.
     *  3. A star is never measured against itself. For a star the reference is
     *     built from the other stars only, so the two members of a binary each
     *     report the mutual orbit and the analytic period comes back exactly.
     *
     * Fills `out` with mass, position and velocity of the reference, and
     * returns it, or returns null when there is nothing to measure against.
     */
    orbitalReference(planet, out){
        const stars = this.stars
        const reference = out || {}
        let primary = null
        let strongest = -1
        for(let i = 0; i < stars.length; i++){
            const star = stars[i]
            if(star === planet || star.removed || !(star.mass > 0)) continue
            const distance = planet.position.distanceSquaredTo(star.position) + this.softeningSquared
            const pull = star.mass / distance
            if(pull > strongest){
                strongest = pull
                primary = star
            }
        }
        if(!primary) return null
        const span = 0.5 * planet.position.distanceTo(primary.position)
        let mass = 0
        let px = 0, py = 0, pz = 0, vx = 0, vy = 0, vz = 0
        for(let i = 0; i < stars.length; i++){
            const star = stars[i]
            if(star === planet || star.removed || !(star.mass > 0)) continue
            if(star !== primary && star.position.distanceTo(primary.position) >= span) continue
            mass += star.mass
            px += star.mass * star.position.x
            py += star.mass * star.position.y
            pz += star.mass * star.position.z
            vx += star.mass * star.velocity.x
            vy += star.mass * star.velocity.y
            vz += star.mass * star.velocity.z
        }
        if(!(mass > 0)) return null
        reference.mass = mass
        reference.x = px / mass
        reference.y = py / mass
        reference.z = pz / mass
        reference.vx = vx / mass
        reference.vy = vy / mass
        reference.vz = vz / mass
        return reference
    }

    /**
     * Osculating orbital elements of a body about its reference (see
     * orbitalReference above), computed on demand.
     *
     * This is the natural way to read a planetary system: the semi-major axis
     * says where a planet lives and the eccentricity says how violent its
     * neighbourhood is. Pass `out` to reuse an object and allocate nothing.
     *
     * Never returns NaN. Every quantity is zeroed first and only overwritten
     * once its denominator is known to be positive, so a body sitting exactly
     * on its reference, or a system with no stars left at all, reports zeros
     * and bound = false rather than poisoning the HUD.
     */
    orbitalElements(planet, out){
        const result = out || {}
        result.semiMajorAxis = 0
        result.eccentricity = 0
        result.inclination = 0
        result.period = 0
        result.periapsis = 0
        result.apoapsis = 0
        result.distance = 0
        result.bound = false
        result.reference = null
        if(!planet) return result
        const reference = this.orbitalReference(planet, this._orbitalReference ||
            (this._orbitalReference = {}))
        if(!reference || !(reference.mass > 0)) return result
        result.reference = reference
        const rx = planet.position.x - reference.x
        const ry = planet.position.y - reference.y
        const rz = planet.position.z - reference.z
        const vx = planet.velocity.x - reference.vx
        const vy = planet.velocity.y - reference.vy
        const vz = planet.velocity.z - reference.vz
        const distance = Math.sqrt(rx * rx + ry * ry + rz * rz)
        if(!(distance > 0)) return result
        result.distance = distance
        // Two-body problem for the pair, so the reduced mass is included.
        const mu = GRAVITATION_CONSTANT * (reference.mass + planet.mass)
        if(!(mu > 0)) return result
        const speedSquared = vx * vx + vy * vy + vz * vz
        // specific angular momentum h = r x v
        const hx = ry * vz - rz * vy
        const hy = rz * vx - rx * vz
        const hz = rx * vy - ry * vx
        const h = Math.sqrt(hx * hx + hy * hy + hz * hz)
        const energy = 0.5 * speedSquared - mu / distance
        // eccentricity vector e = (v x h)/mu - r/|r|
        const ex = (vy * hz - vz * hy) / mu - rx / distance
        const ey = (vz * hx - vx * hz) / mu - ry / distance
        const ez = (vx * hy - vy * hx) / mu - rz / distance
        const eccentricity = Math.sqrt(ex * ex + ey * ey + ez * ez)
        result.eccentricity = isFinite(eccentricity) ? eccentricity : 0
        // Inclination is measured from the system's own plane, which for every
        // scenario built here is the xz-plane with normal +y.
        if(h > 0){
            const normal = this.diskNormal
            const cosine = (hx * normal.x + hy * normal.y + hz * normal.z) / h
            result.inclination = Math.acos(Math.max(-1, Math.min(1, cosine)))
        }
        if(energy < 0){
            const semiMajorAxis = -mu / (2 * energy)
            result.semiMajorAxis = semiMajorAxis
            result.bound = true
            result.period = orbitalPeriod(semiMajorAxis, reference.mass + planet.mass)
            result.periapsis = semiMajorAxis * (1 - result.eccentricity)
            result.apoapsis = semiMajorAxis * (1 + result.eccentricity)
        }else{
            // Unbound: report the (negative) semi-major axis of the hyperbola.
            result.semiMajorAxis = energy !== 0 ? -mu / (2 * energy) : Infinity
            result.periapsis = h > 0 ? (h * h / mu) / (1 + result.eccentricity) : 0
            result.apoapsis = Infinity
        }
        return result
    }

    /**
     * Equilibrium temperature at a point, heated by EVERY star, in K.
     *
     * Irradiation is a flux and fluxes add, so T^4 = SUM_i L_i / (16 pi sigma
     * r_i^2), which in these units is just the sum of each star's own T(r)^4.
     * Two identical suns at the same distance make a point 2^(1/4) = 1.19 times
     * hotter than one would. This is the field scenarios.js assigns formation
     * compositions from, and it is why a body between two stars comes out dry
     * when the same body around a single star would be icy.
     */
    irradiationTemperatureAt(x, y, z){
        const stars = this.stars
        let quartic = 0
        for(let i = 0; i < stars.length; i++){
            const star = stars[i]
            if(star.removed || !(star.effectiveTemperature > 0) || !(star.radius > 0)) continue
            const dx = x - star.position.x
            const dy = y - star.position.y
            const dz = z - star.position.z
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
            const temperature = distance <= star.radius
                ? star.effectiveTemperature
                : Composition.formationTemperature(distance, star.effectiveTemperature, star.radius)
            if(isFinite(temperature) && temperature > 0)
                quartic += temperature * temperature * temperature * temperature
        }
        return quartic > 0 ? Math.pow(quartic, 0.25) : 0
    }

    /**
     * Radius around the DOMINANT star at which it alone heats a grain to
     * SNOW_LINE_TEMPERATURE, in AU. For the HUD.
     *
     * WITH SEVERAL STARS THE SNOW LINE IS NOT A RADIUS. It is a level set of
     * irradiationTemperatureAt() - a surface that wraps each star, bulges
     * outward in the space between them where both suns shine at once, and is
     * not centred on anything. This number is the radius the dominant star
     * would put it at on its own, which is the right single figure to show and
     * an underestimate of the true line everywhere a second star contributes.
     * Composition assignment uses the summed field, never this.
     */
    get snowLineRadius(){
        // Measured from the dominant body that actually SHINES. `this.star` can
        // be a black hole - it is the heaviest thing on the direct-sum list, and
        // in a galactic-centre scenario that is exactly what it will be - and a
        // black hole has effective temperature zero and a radius of order 1e-8
        // AU, which would put the snow line on top of the singularity.
        let star = this.star
        if(star && (star.isBlackHole || !(star.effectiveTemperature > 0))){
            star = null
            const stars = this.stars
            for(let i = 0; i < stars.length; i++){
                const candidate = stars[i]
                if(candidate.removed || candidate.isBlackHole) continue
                if(!(candidate.effectiveTemperature > 0)) continue
                if(!star || candidate.mass > star.mass) star = candidate
            }
        }
        return Composition.snowLineRadius(
            star ? star.effectiveTemperature : SOLAR_EFFECTIVE_TEMPERATURE,
            star ? star.radius : SOLAR_RADIUS
        )
    }

    /**
     * Everything a planetary-system HUD needs, in one pass over the bodies plus
     * one O(n^2) potential sum. Call it a few times a second, not every frame.
     */
    get stats(){
        const planets = this.planets
        const n = planets.length
        const star = this.star
        let totalMass = 0
        let diskMass = 0
        let kinetic = 0
        let maxElementIndex = 0
        let mostMassive = null
        let asteroids = 0, rocky = 0, giants = 0, dwarfs = 0, stars = 0, holes = 0
        let blackHoleMass = 0
        let blackHoleLuminosity = 0
        const momentum = new Vector()
        const centerOfMass = new Vector()
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            if(planet.removed) continue
            totalMass += planet.mass
            kinetic += planet.kineticEnergy()
            momentum.addScaled(planet.velocity, planet.mass)
            centerOfMass.addScaled(planet.position, planet.mass)
            const number = planet.composition.number
            if(number > maxElementIndex) maxElementIndex = number
            switch(planet.classification){
                case CLASS_BLACK_HOLE:
                    holes++
                    blackHoleMass += planet.mass
                    blackHoleLuminosity += planet.luminosity
                    break
                case CLASS_STAR: stars++; break
                case CLASS_BROWN_DWARF: dwarfs++; break
                case CLASS_GAS_GIANT: giants++; break
                case CLASS_PLANET: rocky++; break
                default: asteroids++; break
            }
            // "Disk mass" is everything that is not a star, whatever the
            // scenario: in a cluster that is zero, which is correct.
            if(planet.isStar) continue
            diskMass += planet.mass
            if(!mostMassive || planet.mass > mostMassive.mass)
                mostMassive = planet
        }
        if(totalMass > 0)
            centerOfMass.scale(1 / totalMass)
        const classCounts = {
            asteroid: asteroids,
            planet: rocky,
            gasGiant: giants,
            brownDwarf: dwarfs,
            star: stars,
            blackHole: holes
        }
        const potential = this.computePotentialEnergy(planets)
        const table = typeof PERIODIC_TABLE_ELEMENTS !== 'undefined' ? PERIODIC_TABLE_ELEMENTS : null
        const clamped = table ? Math.min(maxElementIndex, table.length - 1) : maxElementIndex
        return {
            count: n,
            scenarioId: this.scenarioId,
            scenarioLabel: this.meta.label,
            scenarioNotes: this.meta.notes,
            meta: this.meta,
            simulatedTime: this.time,
            steps: this.steps,
            totalMass,
            diskMass,
            kineticEnergy: kinetic,
            potentialEnergy: potential,
            totalEnergy: kinetic + potential,
            momentum,
            centerOfMass,
            // classCounts is keyed by the classification strings structure.js
            // returns, so the HUD can index it directly.
            classCounts: classCounts,
            counts: classCounts,
            star: star,
            stars: this.stars,
            starCount: this.stars.length,
            largestBody: mostMassive,
            mostMassive: mostMassive,
            largestMass: mostMassive ? mostMassive.mass : 0,
            mostMassiveMass: mostMassive ? mostMassive.mass : 0,
            snowLineRadius: this.snowLineRadius,
            gasReservoir: this.gasReservoir,
            gasAccreted: this.gasAccreted,
            collisions: this.collisions,
            disruptions: this.disruptions,
            absorbedByStar: this.absorbedByStar,
            blackHoleCount: holes,
            blackHoleMass: blackHoleMass,
            // Total accretion disk luminosity, Lsun. The holes themselves emit
            // nothing; this is the light of what is falling into them.
            blackHoleLuminosity: blackHoleLuminosity,
            tidalDisruptions: this.tidalDisruptions,
            blackHoleAccreted: this.blackHoleAccreted,
            fusionEnergyReleased: this.fusionEnergyReleased,
            maxElement: table ? table[clamped] : null,
            maxElementIndex: clamped
        }
    }
}
