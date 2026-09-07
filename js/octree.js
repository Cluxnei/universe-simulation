// Barnes-Hut octree.
// Nodes live in flat typed arrays and the whole tree is rebuilt from scratch every
// step, so a gravity pass costs O(n log n) with zero per-body allocation.
// A node is opened when size / distance >= theta, otherwise it is treated as a
// single point mass sitting at its centre of mass.
class Octree{
    constructor(theta = BARNES_HUT_THETA, softening = SOFTENING){
        this.theta = theta
        this.thetaSquared = theta * theta
        this.softeningSquared = softening * softening
        this.gravitation = GRAVITATION_CONSTANT
        this.maxDepth = BARNES_HUT_MAX_DEPTH
        this.capacity = 0
        this.nodeCount = 0
        this.planets = null
        this.bodyCount = 0
        this.bodyNext = new Int32Array(0)
        this.bodyX = new Float64Array(0)
        this.bodyY = new Float64Array(0)
        this.bodyZ = new Float64Array(0)
        this.bodyMass = new Float64Array(0)
        this.stack = new Int32Array(2048)
        this.allocate(1024)
    }

    setTheta(theta){
        this.theta = theta
        this.thetaSquared = theta * theta
        return this
    }

    setSoftening(softening){
        this.softeningSquared = softening * softening
        return this
    }

    allocate(capacity){
        const children = new Int32Array(capacity * 8)
        children.fill(-1)
        const nodeMass = new Float64Array(capacity)
        const comX = new Float64Array(capacity)
        const comY = new Float64Array(capacity)
        const comZ = new Float64Array(capacity)
        const centerX = new Float64Array(capacity)
        const centerY = new Float64Array(capacity)
        const centerZ = new Float64Array(capacity)
        const halfSize = new Float64Array(capacity)
        const head = new Int32Array(capacity)
        head.fill(-1)
        const leaf = new Uint8Array(capacity)
        if(this.capacity > 0){
            children.set(this.children)
            nodeMass.set(this.nodeMass)
            comX.set(this.comX)
            comY.set(this.comY)
            comZ.set(this.comZ)
            centerX.set(this.centerX)
            centerY.set(this.centerY)
            centerZ.set(this.centerZ)
            halfSize.set(this.halfSize)
            head.set(this.head)
            leaf.set(this.leaf)
        }
        this.children = children
        this.nodeMass = nodeMass
        this.comX = comX
        this.comY = comY
        this.comZ = comZ
        this.centerX = centerX
        this.centerY = centerY
        this.centerZ = centerZ
        this.halfSize = halfSize
        this.head = head
        this.leaf = leaf
        this.capacity = capacity
    }

    newNode(cx, cy, cz, half){
        if(this.nodeCount >= this.capacity)
            this.allocate(this.capacity * 2)
        const node = this.nodeCount++
        const base = node * 8
        for(let k = 0; k < 8; k++)
            this.children[base + k] = -1
        this.nodeMass[node] = 0
        this.comX[node] = 0
        this.comY[node] = 0
        this.comZ[node] = 0
        this.centerX[node] = cx
        this.centerY[node] = cy
        this.centerZ[node] = cz
        this.halfSize[node] = half
        this.head[node] = -1
        this.leaf[node] = 1
        return node
    }

    octantOf(node, x, y, z){
        let octant = 0
        if(x >= this.centerX[node]) octant |= 1
        if(y >= this.centerY[node]) octant |= 2
        if(z >= this.centerZ[node]) octant |= 4
        return octant
    }

    createChild(node, octant){
        const half = this.halfSize[node] * 0.5
        const cx = this.centerX[node] + ((octant & 1) ? half : -half)
        const cy = this.centerY[node] + ((octant & 2) ? half : -half)
        const cz = this.centerZ[node] + ((octant & 4) ? half : -half)
        const child = this.newNode(cx, cy, cz, half)
        this.children[node * 8 + octant] = child
        return child
    }

    build(planets, count){
        const n = count === undefined ? planets.length : count
        this.planets = planets
        this.bodyCount = n
        this.nodeCount = 0
        if(this.bodyNext.length < n){
            const size = Math.max(n, 64)
            this.bodyNext = new Int32Array(size)
            this.bodyX = new Float64Array(size)
            this.bodyY = new Float64Array(size)
            this.bodyZ = new Float64Array(size)
            this.bodyMass = new Float64Array(size)
        }
        if(n <= 0)
            return this
        // flat copy of the body state: the build and the leaf walk then run entirely on
        // contiguous doubles instead of chasing Vector objects
        const bodyX = this.bodyX, bodyY = this.bodyY, bodyZ = this.bodyZ, bodyMass = this.bodyMass
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            bodyX[i] = planet.position.x
            bodyY[i] = planet.position.y
            bodyZ[i] = planet.position.z
            bodyMass[i] = planet.removed ? 0 : planet.mass
        }
        let minX = Infinity, minY = Infinity, minZ = Infinity
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
        for(let i = 0; i < n; i++){
            const planet = planets[i]
            if(planet.removed) continue
            const p = planet.position
            if(p.x < minX) minX = p.x
            if(p.y < minY) minY = p.y
            if(p.z < minZ) minZ = p.z
            if(p.x > maxX) maxX = p.x
            if(p.y > maxY) maxY = p.y
            if(p.z > maxZ) maxZ = p.z
        }
        if(!isFinite(minX) || !isFinite(maxX))
            return this
        let half = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.5
        if(!(half > 0)) half = 1
        half *= 1.0001
        this.newNode((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5, half)
        for(let i = 0; i < n; i++){
            if(!planets[i].removed && planets[i].mass > 0)
                this.insert(i)
        }
        for(let k = 0; k < this.nodeCount; k++){
            const mass = this.nodeMass[k]
            if(mass > 0){
                this.comX[k] /= mass
                this.comY[k] /= mass
                this.comZ[k] /= mass
            }else{
                this.comX[k] = this.centerX[k]
                this.comY[k] = this.centerY[k]
                this.comZ[k] = this.centerZ[k]
            }
        }
        return this
    }

    insert(bodyIndex){
        const px = this.bodyX[bodyIndex], py = this.bodyY[bodyIndex], pz = this.bodyZ[bodyIndex]
        const mass = this.bodyMass[bodyIndex]
        let node = 0
        let depth = 0
        for(;;){
            // centre of mass is accumulated as a mass weighted sum, normalised in build()
            this.nodeMass[node] += mass
            this.comX[node] += mass * px
            this.comY[node] += mass * py
            this.comZ[node] += mass * pz
            if(this.leaf[node]){
                const occupant = this.head[node]
                if(occupant < 0){
                    this.head[node] = bodyIndex
                    this.bodyNext[bodyIndex] = -1
                    return
                }
                if(depth >= this.maxDepth){
                    // coincident (or nearly) bodies: keep them as a bucket list
                    this.bodyNext[bodyIndex] = occupant
                    this.head[node] = bodyIndex
                    return
                }
                // a splittable leaf always holds exactly one body, push it one level down
                const ox = this.bodyX[occupant], oy = this.bodyY[occupant], oz = this.bodyZ[occupant]
                const om = this.bodyMass[occupant]
                this.head[node] = -1
                this.leaf[node] = 0
                const octant = this.octantOf(node, ox, oy, oz)
                const child = this.createChild(node, octant)
                this.nodeMass[child] += om
                this.comX[child] += om * ox
                this.comY[child] += om * oy
                this.comZ[child] += om * oz
                this.head[child] = occupant
                this.bodyNext[occupant] = -1
            }
            const octant = this.octantOf(node, px, py, pz)
            let child = this.children[node * 8 + octant]
            if(child < 0)
                child = this.createChild(node, octant)
            node = child
            depth++
        }
    }

    // writes the acceleration on planet into out[0..2].
    // bodyIndex, when given, is the planet's slot in the array passed to build() and
    // lets the leaf walk skip self without an object comparison.
    accelerationFor(planet, out, bodyIndex = -1){
        out[0] = 0
        out[1] = 0
        out[2] = 0
        if(this.nodeCount === 0)
            return out
        const px = planet.position.x, py = planet.position.y, pz = planet.position.z
        const bodyX = this.bodyX, bodyY = this.bodyY, bodyZ = this.bodyZ, bodyMass = this.bodyMass
        const bodyNext = this.bodyNext
        const nodeMass = this.nodeMass, comX = this.comX, comY = this.comY, comZ = this.comZ
        const leaf = this.leaf, head = this.head, children = this.children, halfSize = this.halfSize
        const gravitation = this.gravitation
        const eps2 = this.softeningSquared
        let stack = this.stack
        let sp = 0
        stack[sp++] = 0
        const thetaSquared = this.thetaSquared
        let outX = 0, outY = 0, outZ = 0
        while(sp > 0){
            const node = stack[--sp]
            const mass = nodeMass[node]
            if(mass <= 0) continue
            const dx = comX[node] - px
            const dy = comY[node] - py
            const dz = comZ[node] - pz
            const d2 = dx * dx + dy * dy + dz * dz
            const size = halfSize[node] * 2
            if(leaf[node]){
                let body = head[node]
                while(body >= 0){
                    if(body !== bodyIndex){
                        const ox = bodyX[body] - px
                        const oy = bodyY[body] - py
                        const oz = bodyZ[body] - pz
                        const s2 = ox * ox + oy * oy + oz * oz + eps2
                        const inv = gravitation * bodyMass[body] / (s2 * Math.sqrt(s2))
                        outX += inv * ox
                        outY += inv * oy
                        outZ += inv * oz
                    }
                    body = bodyNext[body]
                }
            }else if(size * size < thetaSquared * d2){
                const s2 = d2 + eps2
                const inv = gravitation * mass / (s2 * Math.sqrt(s2))
                outX += inv * dx
                outY += inv * dy
                outZ += inv * dz
            }else{
                if(sp + 8 > stack.length){
                    const grown = new Int32Array(stack.length * 2)
                    grown.set(stack)
                    this.stack = grown
                    stack = grown
                }
                const base = node * 8
                for(let k = 0; k < 8; k++){
                    const child = children[base + k]
                    if(child >= 0)
                        stack[sp++] = child
                }
            }
        }
        out[0] = outX
        out[1] = outY
        out[2] = outZ
        return out
    }
}
