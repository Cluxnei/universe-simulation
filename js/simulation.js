/**
 * The simulation: a central star plus a protoplanetary disk of embryos, in
 * solar masses, astronomical units and years (G = 4*PI^2).
 *
 * The integrator is Velocity-Verlet with pair-symmetric force accumulation, so
 * total momentum is conserved to round-off. Gravity is Barnes-Hut over the disk
 * bodies, plus the star summed EXACTLY, body by body: the star holds 99.9% of
 * the mass and letting a tree node approximate it would wreck every orbit in
 * the disk. Collisions are swept (continuous), and accretion is momentum- and
 * element-conserving.
 */

// --- Local tunables -----------------------------------------------------------
// Everything in this block belongs in constants.js and should migrate there;
// this file cannot edit that one.

class Simulation{
    constructor(planets){
        this.star = null
        // Runtime switches for the two non-conservative processes, so the UI
        // and the verification harness can turn them off without editing code.
        this.gasAccretionEnabled = GAS_ACCRETION_ENABLED
        this.fusionEnabled = FUSION_ENABLED
        this.gasReservoir = GAS_DISK_MASS
        this.gasAccreted = 0
        // Gas comes from outside the N-body system. Book what it injects so the
        // conservation checks can subtract it and stay exact.
        this.injectedMass = 0
        this.injectedMomentum = new Vector()
        this.gasVelocity = new Vector()
        this.fusionEnergyReleased = 0
        this.nebularComposition = new Composition()
        this.planets = planets || this.randomPlanets()
        if(!this.star)
            this.star = this.findCentralStar()
        // Which way the disk turns. Accreted gas has to orbit with it, not
        // against it: gas on a retrograde orbit torques a growing planet's
        // angular momentum away and drops it straight into the star.
        this.diskNormal = new Vector(0, 1, 0)
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
        // the disk bodies handed to the octree: everything except the star
        this.treeBodies = []
        this.treeIndex = new Int32Array(0)
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
    }

    // ---------------------------------------------------------------- spawning

    /**
     * A star plus a Keplerian disk.
     *
     * The disk lies in the xz-plane, so its angular momentum points along +y,
     * which is the renderer's up axis: the camera then orbits the disk's pole
     * rather than tumbling across it. Orbits are built with textbook orbital
     * elements in the standard z-normal frame and rotated into that plane by
     * (x, y, z) -> (x, z, -y).
     */
    randomPlanets(count = PLANETS_NUMBER){
        const planets = []
        if(STAR_ENABLED){
            // The star gets the nebular mix (X = 0.71, Y = 0.27, Z = 0.02), so
            // structure.js classifies it as a star and gives it the right
            // radius, luminosity and colour with nothing hard coded here.
            const star = new Planet(new Vector(), new Vector(), STAR_MASS, new Composition())
            star.isCentralStar = true
            this.star = star
            planets.push(star)
        }
        const centralMass = this.star ? this.star.mass : DISK_TOTAL_MASS
        // The snow line is not a setting: it follows from the star we just
        // built, so a hotter star moves it outwards on its own.
        const starTemperature = this.star ? this.star.effectiveTemperature : SOLAR_EFFECTIVE_TEMPERATURE
        const starRadius = this.star ? this.star.radius : SOLAR_RADIUS
        const embryoMass = DISK_TOTAL_MASS / Math.max(1, count)
        for(let i = 0; i < count; i++){
            const semiMajorAxis = this.sampleDiskRadius()
            // Rayleigh distributions with the requested RMS. For a Rayleigh
            // variate E[x^2] = 2*sigma^2, so sigma = rms/sqrt(2) and the
            // inverse transform is x = rms * sqrt(-ln u).
            const eccentricity = DISK_ECCENTRICITY_RMS * Math.sqrt(-Math.log(1 - Math.random()))
            const inclination = DISK_INCLINATION_RMS * Math.sqrt(-Math.log(1 - Math.random()))
            const planet = new Planet(
                new Vector(), new Vector(), embryoMass,
                Composition.fromFormationRadius(semiMajorAxis, starTemperature, starRadius)
            )
            this.placeOnOrbit(planet, semiMajorAxis, Math.min(eccentricity, 0.9), inclination, centralMass)
            planets.push(planet)
        }
        this.conditionInitialState(planets)
        return planets
    }

    /**
     * Inverse-transform sample of the surface density profile
     * Sigma(r) ~ r^-p between the disk edges.
     *
     * The mass in an annulus is Sigma(r) * 2*pi*r*dr ~ r^(1-p) dr, so the
     * cumulative mass goes as r^(2-p) and the sample is
     *
     *     r = [ rin^q + u * (rout^q - rin^q) ]^(1/q),   q = 2 - p
     *
     * Sampling r uniformly instead would put far too much mass in the outer
     * disk, where it would never accrete into anything.
     */
    sampleDiskRadius(){
        const inner = DISK_INNER_RADIUS
        const outer = DISK_OUTER_RADIUS
        const q = 2 - DISK_SURFACE_DENSITY_EXPONENT
        const u = Math.random()
        if(Math.abs(q) < 1e-9){
            // p = 2 exactly: the cumulative mass is logarithmic.
            return inner * Math.pow(outer / inner, u)
        }
        const low = Math.pow(inner, q)
        const high = Math.pow(outer, q)
        return Math.pow(low + u * (high - low), 1 / q)
    }

    /**
     * Put a body on a Kepler orbit of the given elements around the star, with
     * random node, periapsis argument and anomaly.
     *
     * The perifocal velocity is written in terms of the circular speed at the
     * same semi-major axis, because
     *
     *     sqrt(mu/p) = circularOrbitalSpeed(a) / sqrt(1 - e^2)
     *
     * so a body with e = 0 gets exactly circularOrbitalSpeed(a) and the unit
     * system's defining property (1 AU around 1 Msun closes in 1 year) is
     * visible in the code rather than buried in a mu.
     */
    placeOnOrbit(planet, semiMajorAxis, eccentricity, inclination, centralMass){
        const node = rand(0, 2 * Math.PI)
        const periapsis = rand(0, 2 * Math.PI)
        const anomaly = rand(0, 2 * Math.PI)
        const cosF = Math.cos(anomaly)
        const sinF = Math.sin(anomaly)
        const oneMinusE2 = Math.max(1e-9, 1 - eccentricity * eccentricity)
        const distance = semiMajorAxis * oneMinusE2 / (1 + eccentricity * cosF)
        const speed = circularOrbitalSpeed(semiMajorAxis, centralMass) / Math.sqrt(oneMinusE2)
        // perifocal frame
        const px = distance * cosF
        const py = distance * sinF
        const vx = -speed * sinF
        const vy = speed * (eccentricity + cosF)
        // rotate by argument of periapsis, inclination, longitude of node
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
        planet.position.set(x, z, -y)
        planet.velocity.set(ux, uz, -uy)
        planet.previousPosition.copyFrom(planet.position)
        if(this.star){
            planet.position.add(this.star.position)
            planet.velocity.add(this.star.velocity)
            planet.previousPosition.copyFrom(planet.position)
        }
        return planet
    }

    /**
     * Move to the barycentre and kill the net momentum, star included, so the
     * whole system does not translate off screen over a long run. Scaling is
     * not involved: the orbits were built Keplerian and must stay that way.
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

    /** The heaviest body, used when a caller supplies its own planet array. */
    findCentralStar(){
        const planets = this.planets
        let best = null
        for(let i = 0; i < planets.length; i++){
            const planet = planets[i]
            if(planet.isCentralStar)
                return planet
            if(!best || planet.mass > best.mass)
                best = planet
        }
        if(best && best.classification === CLASS_STAR){
            best.isCentralStar = true
            return best
        }
        return null
    }

    /**
     * Unit vector along the disk's total orbital angular momentum about the
     * star. randomPlanets() builds the disk in the xz-plane, so this comes out
     * as +y, but it is measured rather than assumed so a hand-built system
     * still gets its gas accretion the right way round.
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
        if(planet === this.star)
            this.star = null
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
            // Disk bodies through the tree, the star exactly. The two passes
            // touch disjoint pairs, so no interaction is counted twice.
            this.accumulateBarnesHut(n, ax, ay, az)
            this.accumulateStar(n, ax, ay, az)
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

    accumulateBarnesHut(n, ax, ay, az){
        const planets = this.planets
        const star = this.star
        const bodies = this.treeBodies
        const treeIndex = this.treeIndex
        bodies.length = 0
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            if(planet.removed || planet === star){
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
        // that went through the tree; the star's contribution below is already exact.
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
     * The star's gravity, summed body by body and never through the tree.
     *
     * It carries ~99.9% of the mass, so the orbit of every body in the disk is
     * its orbit around this one term; a multipole approximation of it would
     * dominate the error budget of the whole simulation. O(n) and exact, and
     * written pair-symmetrically so the star recoils and momentum is conserved
     * to round-off.
     */
    accumulateStar(n, ax, ay, az){
        const star = this.star
        if(!star || star.removed || !(star.mass > 0)) return
        const planets = this.planets
        const index = planets.indexOf(star)
        if(index < 0) return
        const gravitation = GRAVITATION_CONSTANT
        const eps2 = this.softeningSquared
        const sx = star.position.x, sy = star.position.y, sz = star.position.z
        const starMass = star.mass
        let starX = 0, starY = 0, starZ = 0
        for(let i = 0; i < n; i++){
            if(i === index) continue
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

    // Velocity-Verlet, applied as three separate passes over the whole array so no
    // body ever sees another body that has already moved this step.
    step(dt = FIXED_DT){
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
        const changes = this.resolveCollisions()
        if(changes & 1)
            this.compact()
        if(changes !== 0)
            this.accelerationsValid = false
        if(this.updateGasAccretion(dt))
            this.accelerationsValid = false
        this.updateFusion(dt)
        this.time += dt
        this.steps++
        return this
    }

    update(dt = FIXED_DT){
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
        const star = this.star
        if(!star) return false
        const planets = this.planets
        const growthFactor = Math.expm1(dt / GAS_ACCRETION_TIMESCALE)
        const maxThisStep = GAS_ACCRETION_MAX_RATE * dt
        let accreted = false
        for(let i = 0; i < planets.length; i++){
            const planet = planets[i]
            if(planet.removed || planet === star) continue
            if(planet.mass < GAS_ACCRETION_CRITICAL_CORE_MASS) continue
            if(planet.mass >= GAS_ACCRETION_GAP_MASS) continue
            const dx = planet.position.x - star.position.x
            const dy = planet.position.y - star.position.y
            const dz = planet.position.z - star.position.z
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
            if(distance < DISK_INNER_RADIUS || distance > DISK_OUTER_RADIUS) continue
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
        let contact = a.accretionRadius + b.accretionRadius
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
        // The heavier body is always the receiver, and the star always wins.
        let donor = a.mass <= b.mass ? a : b
        let receiver = donor === a ? b : a
        if(donor.isCentralStar){
            const swap = donor
            donor = receiver
            receiver = swap
        }
        // Erosive regime: an impact far faster than the target's own escape
        // speed excavates material instead of sticking. The escape speed here is
        // the real one, from the physical surface.
        const targetEscape = escapeSpeed(receiver.mass, receiver.radius)
        if(targetEscape > 0 && impactSpeedSquared >
            FRAGMENTATION_VELOCITY_RATIO * FRAGMENTATION_VELOCITY_RATIO * targetEscape * targetEscape){
            return this.disruptPair(receiver, donor)
        }
        this.collisions++
        if(receiver === this.star)
            this.absorbedByStar++
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
     * Osculating orbital elements of a body about the star, computed on demand.
     *
     * This is the natural way to read a planetary system: the semi-major axis
     * says where a planet lives and the eccentricity says how violent its
     * neighbourhood is. Pass `out` to reuse an object and allocate nothing.
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
        const star = this.star
        if(!planet || !star || planet === star || !(star.mass > 0))
            return result
        const rx = planet.position.x - star.position.x
        const ry = planet.position.y - star.position.y
        const rz = planet.position.z - star.position.z
        const vx = planet.velocity.x - star.velocity.x
        const vy = planet.velocity.y - star.velocity.y
        const vz = planet.velocity.z - star.velocity.z
        const distance = Math.sqrt(rx * rx + ry * ry + rz * rz)
        if(!(distance > 0)) return result
        result.distance = distance
        // Two-body problem for the pair, so the reduced mass is included.
        const mu = GRAVITATION_CONSTANT * (star.mass + planet.mass)
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
        result.eccentricity = eccentricity
        // Inclination is measured from the disk plane, whose normal is +y.
        result.inclination = h > 0 ? Math.acos(Math.max(-1, Math.min(1, hy / h))) : 0
        if(energy < 0){
            const semiMajorAxis = -mu / (2 * energy)
            result.semiMajorAxis = semiMajorAxis
            result.bound = true
            result.period = orbitalPeriod(semiMajorAxis, star.mass + planet.mass)
            result.periapsis = semiMajorAxis * (1 - eccentricity)
            result.apoapsis = semiMajorAxis * (1 + eccentricity)
        }else{
            // Unbound: report the (negative) semi-major axis of the hyperbola.
            result.semiMajorAxis = energy !== 0 ? -mu / (2 * energy) : Infinity
            result.periapsis = h > 0 ? (h * h / mu) / (1 + eccentricity) : 0
            result.apoapsis = Infinity
        }
        return result
    }

    /** Radius where the star heats a grain to SNOW_LINE_TEMPERATURE, in AU. */
    get snowLineRadius(){
        const star = this.star
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
        let asteroids = 0, rocky = 0, giants = 0, dwarfs = 0, stars = 0
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
                case CLASS_STAR: stars++; break
                case CLASS_BROWN_DWARF: dwarfs++; break
                case CLASS_GAS_GIANT: giants++; break
                case CLASS_PLANET: rocky++; break
                default: asteroids++; break
            }
            if(planet === star) continue
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
            star: stars
        }
        const potential = this.computePotentialEnergy(planets)
        const table = typeof PERIODIC_TABLE_ELEMENTS !== 'undefined' ? PERIODIC_TABLE_ELEMENTS : null
        const clamped = table ? Math.min(maxElementIndex, table.length - 1) : maxElementIndex
        return {
            count: n,
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
            fusionEnergyReleased: this.fusionEnergyReleased,
            maxElement: table ? table[clamped] : null,
            maxElementIndex: clamped
        }
    }
}
