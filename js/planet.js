// Pure physics body. No rendering state lives here: the render layer keeps its own
// meshes keyed by planet.id.
let PLANET_ID_SEQUENCE = 0

class Planet{
    constructor(position = new Vector(), velocity = new Vector(), radius = 1, density = 1){
        this.id = PLANET_ID_SEQUENCE++
        this.position = position
        this.velocity = velocity
        this.acceleration = new Vector()
        this.previousAcceleration = new Vector()
        this.previousPosition = position.copy()
        this.radius = radius
        this.initialRadius = radius
        this.density = density
        this.volume = 4 / 3 * Math.PI * Math.pow(radius, 3)
        this.mass = this.density * this.volume
        this.composition = new Composition()
        this.removed = false
    }

    color(){
        const element = this.composition.element
        return element ? element.color : '#ffffff'
    }

    // mass and volume are the conserved quantities, density and radius derive from them
    syncFromMassAndVolume(){
        if(!isFinite(this.volume) || this.volume < MIN_PLANET_VOLUME)
            this.volume = MIN_PLANET_VOLUME
        if(!isFinite(this.mass) || this.mass < 0)
            this.mass = 0
        this.density = this.mass / this.volume
        this.radius = Math.pow(3 * this.volume / (4 * Math.PI), 1 / 3)
        return this
    }

    // Inelastic absorption: momentum of the swallowed lump is added, not ignored.
    // Volume is conserved separately from mass so the donor density actually matters.
    absorbMass(deltaMass, donorDensity, donorVelocity){
        if(!isFinite(deltaMass) || deltaMass <= 0)
            return 0
        const total = this.mass + deltaMass
        if(total > 0 && donorVelocity){
            this.velocity.x = (this.mass * this.velocity.x + deltaMass * donorVelocity.x) / total
            this.velocity.y = (this.mass * this.velocity.y + deltaMass * donorVelocity.y) / total
            this.velocity.z = (this.mass * this.velocity.z + deltaMass * donorVelocity.z) / total
        }
        const density = (isFinite(donorDensity) && donorDensity > 0) ? donorDensity : this.density
        this.volume += deltaMass / density
        this.mass = total
        this.syncFromMassAndVolume()
        return deltaMass
    }

    // The donor keeps its velocity: it loses mass, not momentum per unit mass.
    // It also loses the matching volume, so its density is unchanged.
    releaseMass(deltaMass){
        if(!isFinite(deltaMass) || deltaMass <= 0)
            return 0
        const given = Math.min(deltaMass, this.mass)
        const density = this.density > 0 && isFinite(this.density) ? this.density : 1
        this.volume -= given / density
        this.mass -= given
        if(this.mass <= MIN_PLANET_MASS || this.volume <= MIN_PLANET_VOLUME){
            this.mass = 0
            this.volume = MIN_PLANET_VOLUME
        }
        this.syncFromMassAndVolume()
        return given
    }

    // Gradual, momentum conserving transfer from this body (donor) to receiver.
    // Exponential form is bounded by the donor mass for any dt.
    transferMassTo(receiver, dt){
        let giveMass = this.mass * (1 - Math.exp(-MASS_TRANSFER_RATE * dt))
        if(this.radius < EXISTING_RADIUS_MIN || !isFinite(giveMass) || giveMass <= 0)
            giveMass = this.mass
        giveMass = Math.min(giveMass, this.mass)
        // never leave a crumb behind: the leftover would be dropped by the mass floor
        // below and its momentum would vanish with it
        if(this.mass - giveMass <= MIN_PLANET_MASS)
            giveMass = this.mass
        if(giveMass <= 0)
            return 0
        receiver.composition.upgrade(this.composition)
        receiver.absorbMass(giveMass, this.density, this.velocity)
        this.releaseMass(giveMass)
        return giveMass
    }

    // Full accretion in one shot, used for impacts detected by the swept test.
    mergeInto(receiver){
        const given = this.mass
        if(given <= 0)
            return 0
        receiver.composition.upgrade(this.composition)
        receiver.absorbMass(given, this.density, this.velocity)
        this.releaseMass(given)
        return given
    }

    kineticEnergy(){
        return 0.5 * this.mass * this.velocity.magnitudeSquared()
    }

    isFinite(){
        return this.position.isFinite() && this.velocity.isFinite()
            && isFinite(this.mass) && isFinite(this.radius)
            && isFinite(this.density) && isFinite(this.volume)
    }

    touching(planet){
        const reach = this.radius + planet.radius
        return this.position.distanceSquaredTo(planet.position) < reach * reach
    }
}
