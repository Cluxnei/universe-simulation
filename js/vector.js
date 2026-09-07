class Vector{

    constructor(x = 0, y = 0, z = 0){
        this.x = x
        this.y = y
        this.z = z
    }

    copy(){
        return new Vector(this.x, this.y, this.z)
    }

    clone(){
        return this.copy()
    }

    set(x = 0, y = 0, z = 0){
        this.x = x
        this.y = y
        this.z = z
        return this
    }

    copyFrom(vector){
        this.x = vector.x
        this.y = vector.y
        this.z = vector.z
        return this
    }

    setZero(){
        this.x = 0
        this.y = 0
        this.z = 0
        return this
    }

    add(vector){
        this.x += vector.x
        this.y += vector.y
        this.z += vector.z
        return this
    }

    // this += vector * scalar, without allocating a temporary
    addScaled(vector, scalar){
        this.x += vector.x * scalar
        this.y += vector.y * scalar
        this.z += vector.z * scalar
        return this
    }

    sub(vector){
        this.x -= vector.x
        this.y -= vector.y
        this.z -= vector.z
        return this
    }

    scale(scaleX = 1, scaleY = undefined, scaleZ = undefined){
        this.x *= scaleX
        this.y *= scaleY ?? scaleX
        this.z *= scaleZ ?? scaleX
        return this
    }

    magnitude(){
        return Math.hypot(this.x, this.y, this.z)
    }

    magnitudeSquared(){
        return this.x * this.x + this.y * this.y + this.z * this.z
    }

    distanceTo(vector){
        return Math.hypot(vector.x - this.x, vector.y - this.y, vector.z - this.z)
    }

    distanceSquaredTo(vector){
        const dx = vector.x - this.x
        const dy = vector.y - this.y
        const dz = vector.z - this.z
        return dx * dx + dy * dy + dz * dz
    }

    dot(vector){
        return this.x * vector.x + this.y * vector.y + this.z * vector.z
    }

    // in place cross product
    cross(vector){
        const x = this.y * vector.z - this.z * vector.y
        const y = this.z * vector.x - this.x * vector.z
        const z = this.x * vector.y - this.y * vector.x
        this.x = x
        this.y = y
        this.z = z
        return this
    }

    normalize(){
        const magnitude = this.magnitude()
        if(magnitude === 0 || !isFinite(magnitude))
            return this.setZero()
        this.x /= magnitude
        this.y /= magnitude
        this.z /= magnitude
        return this
    }

    isFinite(){
        return isFinite(this.x) && isFinite(this.y) && isFinite(this.z)
    }
}
