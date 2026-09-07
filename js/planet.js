// Pure physics body. No rendering state lives here: the render layer keeps its own
// meshes keyed by planet.id.
//
// STATE vs DERIVED. The state of a body is its mass and its composition, and
// nothing else. Radius, density, interior conditions, class, luminosity and
// colour are all consequences, computed by structure.js from those two. The old
// model had it backwards - it stored a density and a volume and derived the mass
// - which made it impossible to say what a body was made of, and impossible for
// a planet to become a star by growing.
//
// Everything derived is cached and only recomputed when the mass or the
// composition actually changed: refreshStructure() runs eight structure
// functions and this is a hot path with 800 bodies.
let PLANET_ID_SEQUENCE = 0

// --- Local tunables -----------------------------------------------------------
// These belong in constants.js and should migrate there; this file cannot edit it.

class Planet{
    /**
     * mass in Msun, composition a Composition (defaults to the nebular mix).
     * The old signature was (position, velocity, radius, density); radius and
     * density are outputs now, not inputs.
     */
    constructor(position = new Vector(), velocity = new Vector(), mass = 0, composition = null){
        this.id = PLANET_ID_SEQUENCE++
        this.position = position
        this.velocity = velocity
        this.acceleration = new Vector()
        this.previousAcceleration = new Vector()
        this.previousPosition = position.copy()
        this.mass = isFinite(mass) && mass > 0 ? mass : 0
        this.composition = composition || new Composition()
        // The central star is never destroyed by accretion and never enters the
        // Barnes-Hut tree; the simulation sets this flag on the body it creates.
        this.isCentralStar = false
        this.removed = false
        // Derived quantities, all filled by refreshStructure().
        this.radius = 0
        this.density = 0
        this.accretionRadius = 0
        this.classification = CLASS_ASTEROID
        this.classLabel = ''
        this.luminosity = 0
        this.effectiveTemperature = 0
        this.centralTemperature = 0
        this.centralPressure = 0
        this.isLuminous = false
        this.colorHex = '#ffffff'
        // Cache keys. structureMass is the mass the cache was built at; the
        // dirty flag covers composition changes, which the mass cannot see.
        this.structureMass = -1
        this.structureDirty = true
        this.refreshStructure()
        this.initialRadius = this.radius
    }

    // ---------------------------------------------------------------- structure

    /**
     * Recompute everything that follows from mass + composition. Cheap when
     * nothing changed, which is the common case: only bodies that collided,
     * accreted gas or burnt fuel this step do any work.
     *
     * describe() in structure.js returns the same numbers in one object; the
     * individual functions are used instead so that 800 bodies do not allocate
     * 800 objects per step.
     */
    refreshStructure(){
        if(!this.structureDirty && this.structureMass === this.mass)
            return this
        const mass = this.mass
        const composition = this.composition
        this.radius = radiusFor(mass, composition)
        this.density = meanDensity(mass, this.radius)
        this.classification = classify(mass, composition)
        this.classLabel = classLabel(this.classification)
        this.luminosity = luminosity(mass, this.classification)
        this.effectiveTemperature = effectiveTemperature(this.luminosity, this.radius)
        this.centralTemperature = centralTemperature(mass, this.radius, composition)
        this.centralPressure = centralPressure(mass, this.radius)
        this.isLuminous = this.luminosity > 0 &&
            this.effectiveTemperature >= LUMINOUS_MIN_TEMPERATURE
        // Poetic licence lives here and nowhere else: the physical radius above
        // is physical, the collision target below is inflated. See
        // ACCRETION_RADIUS_FACTOR in constants.js.
        const factor = this.classification === CLASS_STAR
            ? STAR_ACCRETION_RADIUS_FACTOR
            : ACCRETION_RADIUS_FACTOR
        this.accretionRadius = this.radius * factor
        // A body that emits its own light is coloured by its blackbody spectrum;
        // anything else is coloured by what it is made of. A planet's luminosity
        // is ~0, so its blackbody colour would be a meaningless clamped red.
        this.colorHex = this.isLuminous
            ? blackbodyColorHex(this.effectiveTemperature)
            : composition.displayColor
        this.structureMass = mass
        this.structureDirty = false
        return this
    }

    /** Call after mutating this.composition in place (blend, burn, gas accretion). */
    markCompositionChanged(){
        this.structureDirty = true
        return this
    }

    color(){
        return this.colorHex
    }

    /** Volume of the physical body, AU^3. Derived, kept for the info panel. */
    get volume(){
        const radius = this.radius
        return (4 / 3) * Math.PI * radius * radius * radius
    }

    /** Escape speed from the physical surface, AU/yr. Sets the impact regime. */
    get escapeVelocity(){
        return this.radius > 0 ? escapeSpeed(this.mass, this.radius) : 0
    }

    // ---------------------------------------------------------------- accretion

    /**
     * Move `amount` of mass from this body (donor) to `receiver`.
     *
     * ORDER MATTERS. blend() weights the two compositions by the masses it is
     * given, so it has to see the masses as they are BEFORE the transfer. Doing
     * it afterwards silently corrupts every composition in the simulation, and
     * nothing downstream would ever complain.
     *
     * Momentum is conserved exactly: the receiver takes the transferred mass at
     * the donor's velocity (mass-weighted average), and the donor keeps its own
     * velocity, so it loses momentum exactly equal to what the receiver gained.
     * Elemental mass is conserved exactly, because blend() is a mass-weighted
     * average of mass fractions.
     */
    transferMassTo(receiver, amount){
        if(!receiver || !isFinite(amount) || amount <= 0 || this.mass <= 0)
            return 0
        let given = Math.min(amount, this.mass)
        // Never leave a crumb behind: the remainder would be dropped by the mass
        // floor and its momentum would vanish with it.
        if(this.mass - given <= MIN_PLANET_MASS)
            given = this.mass
        if(given <= 0)
            return 0
        receiver.composition.blend(this.composition, receiver.mass, given)
        const total = receiver.mass + given
        if(total > 0){
            const velocity = receiver.velocity
            velocity.x = (receiver.mass * velocity.x + given * this.velocity.x) / total
            velocity.y = (receiver.mass * velocity.y + given * this.velocity.y) / total
            velocity.z = (receiver.mass * velocity.z + given * this.velocity.z) / total
        }
        receiver.mass = total
        this.mass -= given
        if(this.mass < 0)
            this.mass = 0
        receiver.markCompositionChanged().refreshStructure()
        this.refreshStructure()
        return given
    }

    /** Full accretion in one shot, used for impacts detected by the swept test. */
    mergeInto(receiver){
        return this.transferMassTo(receiver, this.mass)
    }

    /**
     * Absorb nebular gas from the disk. The gas is external to the N-body
     * system, so this is the one place where mass and momentum enter from
     * outside; the simulation books both so the conservation checks stay exact.
     */
    accreteGas(amount, gasComposition, gasVelocity){
        if(!isFinite(amount) || amount <= 0)
            return 0
        this.composition.blend(gasComposition, this.mass, amount)
        const total = this.mass + amount
        if(total > 0 && gasVelocity){
            const velocity = this.velocity
            velocity.x = (this.mass * velocity.x + amount * gasVelocity.x) / total
            velocity.y = (this.mass * velocity.y + amount * gasVelocity.y) / total
            velocity.z = (this.mass * velocity.z + amount * gasVelocity.z) / total
        }
        this.mass = total
        this.markCompositionChanged().refreshStructure()
        return amount
    }

    // ---------------------------------------------------------------- diagnostics

    kineticEnergy(){
        return 0.5 * this.mass * this.velocity.magnitudeSquared()
    }

    isFinite(){
        if(!(this.position.isFinite() && this.velocity.isFinite()))
            return false
        if(!isFinite(this.mass) || !isFinite(this.radius) || !isFinite(this.density))
            return false
        const fractions = this.composition.fractions
        for(let i = 0; i < fractions.length; i++){
            if(!isFinite(fractions[i]))
                return false
        }
        return true
    }

    /** Overlap test against the accretion radii, not the physical ones. */
    touching(planet){
        const reach = this.accretionRadius + planet.accretionRadius
        return this.position.distanceSquaredTo(planet.position) < reach * reach
    }
}
