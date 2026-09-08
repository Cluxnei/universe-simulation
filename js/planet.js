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

// Give every Composition the black hole marker as a prototype default of false.
// classify() and radiusFor() read it for all 800 bodies every time a mass
// changes, and without a default the read would miss the hidden class on every
// ordinary body. Set here rather than in structure.js only because structure.js
// is loaded before composition.js and Composition does not exist yet there.
if (typeof Composition === 'function' && Composition.prototype.isBlackHole === undefined) {
    Composition.prototype.isBlackHole = false
}

// --- Local tunables -----------------------------------------------------------
// These belong in constants.js and should migrate there; this file cannot edit it.

class Planet{
    /**
     * mass in Msun, composition a Composition (defaults to the nebular mix).
     * The old signature was (position, velocity, radius, density); radius and
     * density are outputs now, not inputs.
     */
    constructor(position = new Vector(), velocity = new Vector(), mass = 0, composition = null,
                isBlackHole = false){
        this.id = PLANET_ID_SEQUENCE++
        this.position = position
        this.velocity = velocity
        this.acceleration = new Vector()
        this.previousAcceleration = new Vector()
        this.previousPosition = position.copy()
        this.mass = isFinite(mass) && mass > 0 ? mass : 0
        this.composition = composition || new Composition()
        // Star bookkeeping, maintained by Simulation.refreshStars().
        //
        // `isStar` marks a body that is summed EXACTLY, body by body, outside
        // the Barnes-Hut tree. Scenarios set it on the stars they create; the
        // simulation also sets it on anything that grows into CLASS_STAR. There
        // may be one of these or fifty, and none of them is ever a tree body.
        //
        // `isCentralStar` is the single dominant one - the heaviest star in the
        // system. It is what `simulation.star` points at, what the HUD reads,
        // and the body that always wins an accretion against a non-star.
        this.isStar = false
        this.isCentralStar = false
        // Backing field for the isBlackHole accessor below. Written directly
        // here because the setter needs this.composition, which exists by now,
        // but refreshStructure() has not run yet.
        this._isBlackHole = false
        // Accretion disk bookkeeping, black holes only. `accretionReservoir` is
        // mass that has been captured but not yet drained through the disk;
        // simulation.js turns it into `accretionRate` and then into light.
        // NONE of this removes mass from the hole - the radiated energy is not
        // subtracted, so mass conservation stays exact to the last bit.
        this.accretionReservoir = 0
        this.accretionRate = 0
        this.accretionLuminosity = 0
        this.accretedMass = 0
        // Position in Simulation.stars, or -1. Kept on the body so the force
        // solver can classify 800 planets in one linear pass per step instead
        // of searching the star list for each of them.
        this.starIndex = -1
        this.removed = false
        // Set by js/debris.js on the fragments of a tidally disrupted star. It
        // only changes the accretion radius below; nothing else in the physics
        // reads it. Always false unless TIDAL_DEBRIS_ENABLED.
        this.isDebris = false
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
        if(isBlackHole || isBlackHoleComposition(this.composition))
            markBlackHole(this.composition)
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
        if(this.classification === CLASS_BLACK_HOLE)
            return this.refreshBlackHole(mass)
        this._isBlackHole = false
        this.luminosity = luminosity(mass, this.classification)
        this.effectiveTemperature = effectiveTemperature(this.luminosity, this.radius)
        this.centralTemperature = centralTemperature(mass, this.radius, composition)
        this.centralPressure = centralPressure(mass, this.radius, composition)
        this.isLuminous = this.luminosity > 0 &&
            this.effectiveTemperature >= LUMINOUS_MIN_TEMPERATURE
        // Poetic licence lives here and nowhere else: the physical radius above
        // is physical, the collision target below is inflated. See
        // ACCRETION_RADIUS_FACTOR in constants.js.
        const factor = this.classification === CLASS_STAR
            ? STAR_ACCRETION_RADIUS_FACTOR
            : ACCRETION_RADIUS_FACTOR
        this.accretionRadius = this.radius * factor
        // Tidal debris does not accrete onto tidal debris. A fragment given the
        // ordinary factor would have a collision target of ~0.8 AU and the
        // whole stream would clump back into a ball within a few steps. See
        // TIDAL_DEBRIS_ACCRETION_RADIUS_FACTOR in constants.js and js/debris.js.
        if(this.isDebris)
            this.accretionRadius = this.radius * TIDAL_DEBRIS_ACCRETION_RADIUS_FACTOR
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

    /**
     * The black hole half of refreshStructure(). Split out so the ordinary path
     * pays nothing for it beyond one already-computed string comparison.
     *
     * Everything a star would derive from its interior is zero here, because
     * there is no interior: no central temperature, no central pressure, no
     * surface and therefore no effective temperature and no blackbody colour.
     * `radius` is the Schwarzschild radius, already computed by radiusFor().
     *
     * `luminosity` is NOT zero when the hole is being fed. It carries the
     * accretion disk's output, in the same solar-luminosity field every other
     * body uses, so the HUD and the renderer need no special case to see that a
     * quasar is bright. The hole itself is still black - `isLuminous` stays
     * false and `colorHex` stays the horizon's colour - because the light comes
     * from the disk outside the horizon, not from the body.
     */
    refreshBlackHole(mass){
        this._isBlackHole = true
        // Direct-summed outside the tree, exactly like a star and for exactly
        // the same reason: it holds most of the mass near it. It is not a claim
        // that it shines.
        this.isStar = true
        this.centralTemperature = 0
        this.centralPressure = 0
        this.effectiveTemperature = 0
        this.luminosity = this.accretionLuminosity
        this.isLuminous = false
        this.colorHex = BLACK_HOLE_COLOR_HEX
        // Capture reach for the collision broad phase: the tidal radius against
        // a Sun-like victim, which is the right order for anything this
        // simulation can build, times a margin for low-density victims. The
        // exact pairwise radius is recomputed per collision candidate in
        // simulation.js; this only has to be an upper bound for grid sizing.
        // ACCRETION_RADIUS_FACTOR is deliberately not used - 800 times a 2e-8 AU
        // horizon is still 1.6e-5 AU and would never catch anything.
        this.accretionRadius = BLACK_HOLE_CAPTURE_MARGIN *
            blackHoleCaptureRadius(mass, 1, SOLAR_RADIUS)
        this.structureMass = mass
        this.structureDirty = false
        return this
    }

    /**
     * Is this body a black hole?
     *
     * Assigning `true` is the supported way to turn any body into one:
     *
     *     const hole = new Planet(position, velocity, 10)
     *     hole.isBlackHole = true
     *
     * (or `new Planet(position, velocity, 10, composition, true)`, or
     * `Planet.blackHole(position, velocity, 10)` - all three do the same thing).
     * The setter marks the COMPOSITION, which is what classify(), radiusFor()
     * and describe() key off, and which is what makes the identity survive
     * accretion: Composition.blend() averages the fraction arrays in place and
     * never touches the marker, so a hole that swallows a star keeps its own
     * composition object, keeps the marker, and simply gains the mass. There is
     * no path back out - a black hole never reclassifies as anything else,
     * whatever it eats and however heavy it gets.
     */
    get isBlackHole(){
        return this._isBlackHole
    }

    set isBlackHole(value){
        const flag = !!value
        if(flag)
            markBlackHole(this.composition)
        else if(this.composition)
            this.composition.isBlackHole = false
        this._isBlackHole = flag
        if(flag)
            this.isStar = true
        this.structureDirty = true
        this.refreshStructure()
    }

    /** Convenience constructor for scenarios. Mass in Msun. */
    static blackHole(position, velocity, mass, composition){
        return new Planet(position, velocity, mass, composition, true)
    }

    /**
     * The separation at which this hole would capture `victim`, in AU: the
     * largest of the pair's tidal radius, this hole's horizon, and the softening
     * length. Zero for anything that is not a black hole. See
     * blackHoleCaptureRadius() in structure.js.
     */
    captureRadiusFor(victim){
        if(!this._isBlackHole)
            return 0
        return blackHoleCaptureRadius(this.mass, victim.mass, victim.radius)
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
        // Everything a black hole ever swallows comes through here, so this is
        // the one place the accretion disk has to be fed. The mass is already
        // in the hole; the reservoir is only a record of how recently it
        // arrived, and simulation.js drains it into light over the disk's
        // viscous timescale. No mass is removed by radiating.
        if(receiver._isBlackHole){
            receiver.accretionReservoir += given
            receiver.accretedMass += given
        }
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
