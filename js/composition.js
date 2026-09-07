class Composition{
    constructor(element){
        this.element = element || PERIODIC_TABLE_ELEMENTS[0]
        this.number = this.element.number - 1
    }
    upgrade(composition){
        // Fusion stops at the end of the table: there is nothing heavier to become.
        // Without this guard `number` grew past the 118 known atoms and `element`
        // silently became undefined.
        if(this.number >= PERIODIC_TABLE_ELEMENTS.length - 1)
            return
        if(composition.number >= this.number){
            this.number++
            this.element = PERIODIC_TABLE_ELEMENTS[this.number]
            if(this.number > MAX_ELEMENT)
               MAX_ELEMENT = this.number
        }
    }
}
