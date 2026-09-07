class Simulation{
    constructor(planets){
        this.planets = planets || this.randomPlanets()
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
    }

    // ---------------------------------------------------------------- spawning

    randomPlanets(count = PLANETS_NUMBER){
        const planets = []
        for(let i = 0; i < count; i++){
            // uniform inside a sphere, not a cube
            const radius = PLANETS_POSITION_RANGE * Math.cbrt(Math.random())
            const cosTheta = rand(-1, 1)
            const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
            const phi = rand(0, 2 * Math.PI)
            const position = new Vector(
                radius * sinTheta * Math.cos(phi),
                radius * sinTheta * Math.sin(phi),
                radius * cosTheta
            )
            const speed = rand(0, PLANETS_VELOCITY_RANGE)
            const vCosTheta = rand(-1, 1)
            const vSinTheta = Math.sqrt(Math.max(0, 1 - vCosTheta * vCosTheta))
            const vPhi = rand(0, 2 * Math.PI)
            const velocity = new Vector(
                speed * vSinTheta * Math.cos(vPhi),
                speed * vSinTheta * Math.sin(vPhi),
                speed * vCosTheta
            )
            planets.push(new Planet(
                position,
                velocity,
                rand(PLANETS_RADIUS_RANGE_MIN, PLANETS_RADIUS_RANGE_MAX),
                rand(PLANETS_DENSITY_RANGE_MIN, PLANETS_DENSITY_RANGE_MAX)
            ))
        }
        this.conditionInitialState(planets)
        return planets
    }

    // Recentre the cloud, give it net angular momentum, kill the bulk drift and
    // rescale the velocities towards virial equilibrium (2T = ratio * |U|).
    conditionInitialState(planets, angularFactor = ANGULAR_MOMENTUM_FACTOR, virialRatio = VIRIAL_RATIO){
        const n = planets.length
        if(n === 0) return planets
        let totalMass = 0
        let cx = 0, cy = 0, cz = 0
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            totalMass += planet.mass
            cx += planet.mass * planet.position.x
            cy += planet.mass * planet.position.y
            cz += planet.mass * planet.position.z
        }
        if(totalMass <= 0) return planets
        cx /= totalMass
        cy /= totalMass
        cz /= totalMass
        let maxRadius = 0
        for(let i = 0; i < n; i++){
            const p = planets[i].position
            p.x -= cx
            p.y -= cy
            p.z -= cz
            const r = p.magnitude()
            if(r > maxRadius) maxRadius = r
        }
        if(maxRadius <= 0) maxRadius = 1
        // solid body rotation: v += omega x r, with omega a fraction of the circular
        // frequency at the cloud edge, so a disk can actually form
        const axis = new Vector(ROTATION_AXIS_X, ROTATION_AXIS_Y, ROTATION_AXIS_Z).normalize()
        const omega = angularFactor * Math.sqrt(GRAVITATION_CONSTANT * totalMass / (maxRadius * maxRadius * maxRadius))
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            const p = planet.position
            planet.velocity.x += omega * (axis.y * p.z - axis.z * p.y)
            planet.velocity.y += omega * (axis.z * p.x - axis.x * p.z)
            planet.velocity.z += omega * (axis.x * p.y - axis.y * p.x)
        }
        // remove the centre of mass velocity so the whole cloud does not fly away
        let vx = 0, vy = 0, vz = 0
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            vx += planet.mass * planet.velocity.x
            vy += planet.mass * planet.velocity.y
            vz += planet.mass * planet.velocity.z
        }
        vx /= totalMass
        vy /= totalMass
        vz /= totalMass
        for(let i = 0; i < n; i++){
            planets[i].velocity.x -= vx
            planets[i].velocity.y -= vy
            planets[i].velocity.z -= vz
        }
        // virial scaling. Scaling every velocity by the same factor keeps the total
        // momentum at zero.
        const kinetic = this.computeKineticEnergy(planets)
        const potential = this.computePotentialEnergy(planets)
        if(kinetic > 0 && potential < 0){
            const factor = Math.sqrt(virialRatio * Math.abs(potential) / (2 * kinetic))
            if(isFinite(factor) && factor > 0){
                for(let i = 0; i < n; i++)
                    planets[i].velocity.scale(factor)
            }
        }
        return planets
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
        if(this.useBarnesHut && n > BARNES_HUT_MIN_BODIES)
            this.accumulateBarnesHut(n, ax, ay, az)
        else
            this.accumulateBruteForce(n, ax, ay, az)
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
        const tree = this.octree
        tree.setSoftening(Math.sqrt(this.softeningSquared))
        tree.build(planets, n)
        const out = this.treeAcceleration
        let totalMass = 0
        let netX = 0, netY = 0, netZ = 0
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            if(planet.removed) continue
            tree.accelerationFor(planet, out, i)
            ax[i] = out[0]
            ay[i] = out[1]
            az[i] = out[2]
            totalMass += planet.mass
            netX += planet.mass * out[0]
            netY += planet.mass * out[1]
            netZ += planet.mass * out[2]
        }
        // Tree forces are not pair symmetric, so they leave a small spurious net force
        // on the system. Subtracting it as a uniform acceleration restores sum(m*a) = 0
        // without touching any relative acceleration.
        if(totalMass > 0){
            const cx = netX / totalMass, cy = netY / totalMass, cz = netZ / totalMass
            for(let i = 0; i < n; i++){
                ax[i] -= cx
                ay[i] -= cy
                az[i] -= cz
            }
        }
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
        const changes = this.resolveCollisions(dt)
        if(changes & 1)
            this.compact()
        if(changes !== 0)
            this.accelerationsValid = false
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

    // ---------------------------------------------------------------- collisions

    // Uniform spatial hash sized so that any pair that can touch during this step
    // shares a cell or sits in one of the 26 neighbours.
    buildCollisionGrid(n){
        const planets = this.planets
        let reach = 0
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            if(planet.removed) continue
            const displacement = planet.position.distanceTo(planet.previousPosition)
            const candidate = planet.radius + displacement
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

    // returns a bitmask: 1 = a body was removed, 2 = positions were corrected
    resolveCollisions(dt){
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
                            flags |= this.handlePair(a, b, dt)
                            if(a.removed) break
                        }
                    }
                }
            }
        }
        return flags
    }

    // Swept (continuous) test against the segment travelled this step, so small fast
    // bodies cannot tunnel through each other.
    handlePair(a, b, dt){
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
        const contact = a.radius + b.radius
        if(cx * cx + cy * cy + cz * cz >= contact * contact)
            return 0
        const donor = a.mass <= b.mass ? a : b
        const receiver = donor === a ? b : a
        let dx = a.position.x - b.position.x
        let dy = a.position.y - b.position.y
        let dz = a.position.z - b.position.z
        let distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if(distance >= contact){
            // surfaces crossed somewhere inside the step but the bodies are already
            // apart again: a genuine impact, the smaller one is accreted whole.
            // (Rewinding them to the contact point instead would leave them stuck at
            // closest approach with gravity still working on them, which pumps energy.)
            donor.mergeInto(receiver)
            donor.removed = true
            return 1
        }
        // Contact. Perfectly inelastic normal impulse: equal and opposite, so momentum
        // is untouched and the relative approach speed is removed instead of being fed
        // back by the penetration correction below.
        if(distance < 1e-9){
            dx = 1; dy = 0; dz = 0
            distance = 1
        }
        const nx = dx / distance, ny = dy / distance, nz = dz / distance
        const approach = (a.velocity.x - b.velocity.x) * nx +
            (a.velocity.y - b.velocity.y) * ny +
            (a.velocity.z - b.velocity.z) * nz
        const totalMass = a.mass + b.mass
        if(approach < 0 && totalMass > 0){
            const impulse = -(1 + COLLISION_RESTITUTION) * approach * (a.mass * b.mass) / totalMass
            const ia = impulse / a.mass
            const ib = impulse / b.mass
            a.velocity.x += nx * ia
            a.velocity.y += ny * ia
            a.velocity.z += nz * ia
            b.velocity.x -= nx * ib
            b.velocity.y -= ny * ib
            b.velocity.z -= nz * ib
        }
        donor.transferMassTo(receiver, dt)
        if(donor.mass <= MIN_PLANET_MASS){
            donor.removed = true
            return 1
        }
        // masses and velocities changed, the cached accelerations no longer sum to zero
        let flags = 2
        // push what is left of the overlap apart so bodies do not sit inside each other
        const reach = a.radius + b.radius
        if(distance < reach){
            const pushMass = a.mass + b.mass
            const shareA = pushMass > 0 ? b.mass / pushMass : 0.5
            const correction = (reach - distance) * PENETRATION_CORRECTION
            a.position.x += nx * correction * shareA
            a.position.y += ny * correction * shareA
            a.position.z += nz * correction * shareA
            b.position.x -= nx * correction * (1 - shareA)
            b.position.y -= ny * correction * (1 - shareA)
            b.position.z -= nz * correction * (1 - shareA)
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

    get stats(){
        const planets = this.planets
        const n = planets.length
        let totalMass = 0
        let kinetic = 0
        let maxElementIndex = 0
        const momentum = new Vector()
        const centerOfMass = new Vector()
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            totalMass += planet.mass
            kinetic += planet.kineticEnergy()
            momentum.addScaled(planet.velocity, planet.mass)
            centerOfMass.addScaled(planet.position, planet.mass)
            const number = planet.composition.number
            if(number > maxElementIndex) maxElementIndex = number
        }
        if(totalMass > 0)
            centerOfMass.scale(1 / totalMass)
        const potential = this.computePotentialEnergy(planets)
        const table = typeof PERIODIC_TABLE_ELEMENTS !== 'undefined' ? PERIODIC_TABLE_ELEMENTS : null
        const clamped = table ? Math.min(maxElementIndex, table.length - 1) : maxElementIndex
        return {
            count: n,
            totalMass,
            kineticEnergy: kinetic,
            potentialEnergy: potential,
            totalEnergy: kinetic + potential,
            momentum,
            centerOfMass,
            maxElement: table ? table[clamped] : null,
            maxElementIndex: clamped
        }
    }
}
