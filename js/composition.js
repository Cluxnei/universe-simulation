/**
 * Composition: what a body is made of.
 *
 * The old model carried a single atomic number and "upgraded" it by +1 on every
 * collision. That conserved nothing - two hydrogen bodies merged into a helium
 * body of the same mass, and mass simply changed element. This replaces it with
 * a mass-fraction vector, which is the only representation that survives
 * accretion: merging is a mass-weighted average, and a mass-weighted average of
 * mass fractions conserves the mass of every element exactly.
 *
 * We track 8 species, not 118. These are the ones that decide what a planet
 * becomes, and Fe is where exothermic fusion ends:
 *
 *     H  He  C  N  O  Mg  Si  Fe
 *
 * The 118-element periodic table is kept, but demoted to display flavour: the
 * dominant species is mapped back onto an `Atom` so the UI still has a name, a
 * symbol and a colour.
 *
 * Units: solar masses (Msun), astronomical units (AU), years - see units.js.
 * Mass fractions are dimensionless and always sum to 1.
 */

// --- Species table ------------------------------------------------------------
const SPECIES_H = 0
const SPECIES_HE = 1
const SPECIES_C = 2
const SPECIES_N = 3
const SPECIES_O = 4
const SPECIES_MG = 5
const SPECIES_SI = 6
const SPECIES_FE = 7
const SPECIES_COUNT = 8

const SPECIES_SYMBOLS = ['H', 'He', 'C', 'N', 'O', 'Mg', 'Si', 'Fe']

// Display names, pt-BR (the periodic table itself is in English and is only
// used for colours and symbols).
const SPECIES_NAMES = [
    'Hidrogenio', 'Helio', 'Carbono', 'Nitrogenio',
    'Oxigenio', 'Magnesio', 'Silicio', 'Ferro'
]

// Atomic numbers, used to look the species up in PERIODIC_TABLE_ELEMENTS.
const SPECIES_ATOMIC_NUMBERS = [1, 2, 6, 7, 8, 12, 14, 26]

// Standard atomic weights, in atomic mass units. Needed to go from mass
// fractions to mole fractions, which is where all the ice/rock bookkeeping
// happens - stoichiometry counts atoms, not grams.
const SPECIES_ATOMIC_MASSES = [
    1.008, 4.0026, 12.011, 14.007, 15.999, 24.305, 28.085, 55.845
]

// Ionic charge when fully ionized, for the mean molecular weight.
const SPECIES_CHARGES = [1, 2, 6, 7, 8, 12, 14, 26]

// Fallback colours, used only if the periodic table has not been built yet.
const SPECIES_FALLBACK_COLORS = [
    '#63b9d5', '#d1c991', '#3b3b3b', '#2cc6b2',
    '#6fec98', '#9e80ea', '#4a4070', '#e06633'
]

// --- Material categories ------------------------------------------------------
const MATERIAL_GAS = 0
const MATERIAL_ICE = 1
const MATERIAL_ROCK = 2
const MATERIAL_METAL = 3

const MATERIAL_LABELS = ['Gasoso', 'Gelado', 'Rochoso', 'Metalico']

/**
 * Zero-pressure density of the H/He end member, in g/cm^3.
 *
 * units.js has no gas density because there is no such thing as a
 * zero-pressure density for a gas: unconfined H2 simply expands. The value used
 * here is that of *solid* molecular hydrogen at zero pressure (~0.086 g/cm^3),
 * rounded, so that the volumetric mixing rule below stays well defined for a
 * body of any composition. It is only meaningful for the condensed part of a
 * body; a real gas envelope is a hydrostatic problem for structure.js, not a
 * density lookup.
 */
const DENSITY_GAS_CGS = 0.09

// Speed of light, m/s. units.js works in AU/yr and does not carry it.
const SPEED_OF_LIGHT_MPS = 2.99792458e8

/**
 * Silicate stoichiometry. Rock is modelled as MgO.SiO2 (enstatite, MgSiO3),
 * which matches the solar Mg/Si ratio of ~1 far better than forsterite would.
 * Written as oxides it generalises to any Mg/Si ratio:
 *
 *     oxygen locked in rock (moles) = 2 * n(Si) + 1 * n(Mg)
 *
 * i.e. every silicon takes two oxygens (SiO2) and every magnesium takes one
 * (MgO). See the category bookkeeping in `_categories()`.
 */
const ROCK_OXYGEN_PER_SILICON = 2
const ROCK_OXYGEN_PER_MAGNESIUM = 1

// Mass fractions of MgSiO3, precomputed from the numbers above. Used to build
// a rock component of a requested mass.
const ROCK_MOLAR_MASS =
    SPECIES_ATOMIC_MASSES[SPECIES_MG] +
    SPECIES_ATOMIC_MASSES[SPECIES_SI] +
    3 * SPECIES_ATOMIC_MASSES[SPECIES_O]
const ROCK_MASS_FRACTION_MG = SPECIES_ATOMIC_MASSES[SPECIES_MG] / ROCK_MOLAR_MASS
const ROCK_MASS_FRACTION_SI = SPECIES_ATOMIC_MASSES[SPECIES_SI] / ROCK_MOLAR_MASS
const ROCK_MASS_FRACTION_O = 1 - ROCK_MASS_FRACTION_MG - ROCK_MASS_FRACTION_SI

/**
 * Heavy-atom make-up of the ice component, by mass. Cometary ice is dominated
 * by water, with CO/CO2/CH4 and a little NH3/N2 behind it. Only the heavy atoms
 * are counted here - see the note on hydrogen in `_categories()`.
 */
const ICE_MASS_FRACTION_O = 0.70
const ICE_MASS_FRACTION_C = 0.22
const ICE_MASS_FRACTION_N = 0.08

// --- Formation end members ----------------------------------------------------
// Dry (inside the snow line): chondritic, ~2/3 silicate mantle and ~1/3 iron
// core. That is Earth, and it is what you get when water cannot condense.
const DRY_ROCK_FRACTION = 2 / 3
const DRY_METAL_FRACTION = 1 / 3

// Icy (outside the snow line): water ice roughly triples the condensable solid
// mass, so ice ends up about half the body and the rock:metal ratio of the
// refractory remainder is unchanged.
const ICY_ICE_FRACTION = 0.5
const ICY_ROCK_FRACTION = DRY_ROCK_FRACTION * (1 - ICY_ICE_FRACTION)
const ICY_METAL_FRACTION = DRY_METAL_FRACTION * (1 - ICY_ICE_FRACTION)

/**
 * Half-width of the condensation band, as a fraction of SNOW_LINE_TEMPERATURE.
 * Condensation is not a step function - grain size, pressure and orbital
 * eccentricity all smear it out - and a hard step would give neighbouring
 * bodies wildly different compositions for a 1% difference in radius. 0.08
 * gives a band of 156 K - 184 K, which for a solar-type star is 2.3 - 3.2 AU.
 */
const SNOW_LINE_TRANSITION_WIDTH = 0.08

// Bond albedo assumed for a bare planetesimal when deriving its formation
// temperature. Zero: a dark, freshly condensed body absorbs essentially all of
// the starlight that hits it, and this is what puts the snow line at 2.7 AU for
// a solar-type star.
const FORMATION_ALBEDO = 0

// --- Nebular (solar) composition ---------------------------------------------
// X = 0.71, Y = 0.27, Z = 0.02, with Z split between our six metals in roughly
// solar proportions by mass (O and C dominate, then Fe, N, Si, Mg).
const NEBULAR_METALS = [0.531, 0.210, 0.062, 0.049, 0.062, 0.086]  // C N O Mg Si Fe order below
const SOLAR_HYDROGEN_FRACTION = 0.71
const SOLAR_HELIUM_FRACTION = 0.27
const SOLAR_METAL_FRACTION = 0.02

/**
 * Fusion stages, in strict order of increasing ignition temperature.
 *
 * `q` is the fraction of the consumed rest mass released as energy, taken from
 * the real reaction Q values:
 *
 *   H  -> He   0.7 %    (4 H -> He4, the classic 0.007*m*c^2)
 *   He -> C,O  0.07 %   (triple alpha, 3 He4 -> C12, plus C12(a,g)O16)
 *   N  -> O    0.012 %  (N14(a,g)F18 -> O18, during helium burning)
 *   C  -> Mg   0.021 %  (C12+C12 -> Ne20+He4)
 *   Mg -> Si   0.015 %  (neon burning, then Mg24(a,g)Si28)
 *   O  -> Si   0.032 %  (O16+O16 -> Si28+He4)
 *   Si -> Fe   0.020 %  (silicon burning to the iron peak)
 *
 * There is deliberately no stage above iron: Fe56 has the highest binding
 * energy per nucleon of anything reachable, so fusing it consumes energy rather
 * than releasing it. That is why massive stars collapse instead of continuing.
 * Iron is the ONLY absorbing state in this chain, which is the point: every
 * other species has a path down to it, so a core hot enough for silicon burning
 * really does end up as iron and then stops.
 *
 * We do NOT track neon, so the neon and alpha products of carbon burning are
 * folded into Mg. That is the closest tracked species (Ne20 sits between C12
 * and Mg24) and it keeps the mass budget exact; the price is that a
 * carbon-burning core reports slightly too much magnesium. The Mg -> Si stage
 * at 1.2e9 K is therefore doing double duty: it is the neon burning that the
 * folding hid, plus the Mg24 alpha captures that really do run alongside oxygen
 * burning. Without it magnesium would be a second absorbing state and the chain
 * would never reach iron. Nitrogen is handled the same way: it is a CNO
 * catalyst while hydrogen burns, but once helium ignites it is destroyed by
 * alpha capture, so it drains into oxygen rather than piling up.
 *
 * `rate` is a crude fractional burn rate per year of the *available fuel*. The
 * ordering and the thresholds are the physics; the rates are a knob. Advanced
 * stages are given much larger rates because in a real star they are: hydrogen
 * burning lasts ~1e10 yr and silicon burning lasts about a day.
 */
const FUSION_STAGES = [
    {
        name: 'H -> He',
        threshold: 1e7,
        fuel: SPECIES_H,
        products: [[SPECIES_HE, 1.0]],
        q: 0.007,
        rate: 0.1
    },
    {
        name: 'He -> C, O',
        threshold: 1e8,
        fuel: SPECIES_HE,
        products: [[SPECIES_C, 0.7], [SPECIES_O, 0.3]],
        q: 7.0e-4,
        rate: 1.0
    },
    {
        // Nitrogen is a catalyst, not a fuel, while hydrogen burns; it is
        // destroyed by alpha capture once helium ignites.
        name: 'N -> O',
        threshold: 1e8,
        fuel: SPECIES_N,
        products: [[SPECIES_O, 1.0]],
        q: 1.2e-4,
        rate: 5.0
    },
    {
        // Ne folded into Mg, see above.
        name: 'C -> Ne, Mg',
        threshold: 6e8,
        fuel: SPECIES_C,
        products: [[SPECIES_MG, 1.0]],
        q: 2.1e-4,
        rate: 10.0
    },
    {
        // Neon burning plus Mg24(a,g)Si28. Keeps Mg from being a dead end.
        name: 'Mg -> Si',
        threshold: 1.2e9,
        fuel: SPECIES_MG,
        products: [[SPECIES_SI, 1.0]],
        q: 1.5e-4,
        rate: 30.0
    },
    {
        name: 'O -> Si',
        threshold: 1.5e9,
        fuel: SPECIES_O,
        products: [[SPECIES_SI, 1.0]],
        q: 3.2e-4,
        rate: 50.0
    },
    {
        // The end of the line. Nothing burns iron.
        name: 'Si -> Fe',
        threshold: 3e9,
        fuel: SPECIES_SI,
        products: [[SPECIES_FE, 1.0]],
        q: 2.0e-4,
        rate: 200.0
    }
]

// Below this a species is treated as absent, so we do not chase denormals.
const COMPOSITION_EPSILON = 1e-18

// Cache for the atomic-number -> Atom lookup. PERIODIC_TABLE_ELEMENTS is built
// in main.js after this file is parsed, so the lookup has to be lazy.
let SPECIES_ATOM_CACHE = null

function compositionSmoothStep(edge0, edge1, x) {
    if (edge1 === edge0) {
        return x < edge0 ? 0 : 1
    }
    let t = (x - edge0) / (edge1 - edge0)
    if (t < 0) t = 0
    if (t > 1) t = 1
    return t * t * (3 - 2 * t)
}

class Composition {

    /**
     * With no argument: the nebular mix the disk itself is made of
     * (X = 0.71, Y = 0.27, Z = 0.02).
     *
     * Accepts an array/Float64Array of 8 mass fractions to build a specific
     * composition. The old signature took an `Atom`; that is still tolerated so
     * a stray `new Composition(atom)` does not explode - see the compatibility
     * section at the bottom of the class.
     */
    constructor(fractions) {
        this.fractions = new Float64Array(SPECIES_COUNT)
        if (fractions && fractions.length === SPECIES_COUNT) {
            for (let i = 0; i < SPECIES_COUNT; i++) {
                this.fractions[i] = fractions[i]
            }
            this.normalize()
            return
        }
        if (fractions && typeof fractions.number === 'number') {
            // Legacy: an Atom was passed. Make a body of that single species if
            // we track it, otherwise fall back to the nebular mix.
            const index = SPECIES_ATOMIC_NUMBERS.indexOf(fractions.number)
            if (index >= 0) {
                this.fractions[index] = 1
                return
            }
        }
        this.setNebular()
    }

    /** Solar/nebular composition: X = 0.71, Y = 0.27, Z = 0.02. */
    setNebular() {
        const f = this.fractions
        f.fill(0)
        f[SPECIES_H] = SOLAR_HYDROGEN_FRACTION
        f[SPECIES_HE] = SOLAR_HELIUM_FRACTION
        // NEBULAR_METALS is listed as O, C, N, Mg, Si, Fe by mass share of Z.
        f[SPECIES_O] = SOLAR_METAL_FRACTION * NEBULAR_METALS[0]
        f[SPECIES_C] = SOLAR_METAL_FRACTION * NEBULAR_METALS[1]
        f[SPECIES_N] = SOLAR_METAL_FRACTION * NEBULAR_METALS[2]
        f[SPECIES_MG] = SOLAR_METAL_FRACTION * NEBULAR_METALS[3]
        f[SPECIES_SI] = SOLAR_METAL_FRACTION * NEBULAR_METALS[4]
        f[SPECIES_FE] = SOLAR_METAL_FRACTION * NEBULAR_METALS[5]
        this.normalize()
        return this
    }

    /**
     * Clamp away negatives and renormalise to a unit sum. Called after every
     * mutation so rounding drift can never accumulate: without it a few hundred
     * thousand blends walk the sum away from 1 and every derived quantity
     * silently drifts with it.
     */
    normalize() {
        const f = this.fractions
        let sum = 0
        for (let i = 0; i < SPECIES_COUNT; i++) {
            if (!(f[i] > COMPOSITION_EPSILON)) {
                f[i] = 0
            }
            sum += f[i]
        }
        if (!(sum > 0)) {
            // Nothing left, or garbage in. Hydrogen is the only honest default.
            f.fill(0)
            f[SPECIES_H] = 1
            return this
        }
        const inverse = 1 / sum
        for (let i = 0; i < SPECIES_COUNT; i++) {
            f[i] *= inverse
        }
        return this
    }

    clone() {
        return new Composition(this.fractions)
    }

    copyFrom(other) {
        for (let i = 0; i < SPECIES_COUNT; i++) {
            this.fractions[i] = other.fractions[i]
        }
        return this.normalize()
    }

    fractionOf(species) {
        return this.fractions[species] || 0
    }

    // --- Accretion ------------------------------------------------------------

    /**
     * Mix another body into this one on accretion.
     *
     *     f_new[i] = (m1*f1[i] + m2*f2[i]) / (m1 + m2)
     *
     * This is the whole point of the rewrite. Because the fractions are
     * mass-weighted, the mass of every element is conserved exactly: the
     * elemental mass held by the merged body, m*f_new[i], is identically
     * m1*f1[i] + m2*f2[i]. Nothing is created and nothing transmutes.
     *
     * `this` becomes the merged composition. Masses are in Msun but any
     * consistent unit works, since only their ratio matters.
     */
    blend(other, myMass, otherMass) {
        if (!other) {
            return this
        }
        const m1 = myMass > 0 ? myMass : 0
        const m2 = otherMass > 0 ? otherMass : 0
        const total = m1 + m2
        if (!(total > 0)) {
            // Two massless bodies: there is nothing to average. Leave us alone.
            return this
        }
        const inverse = 1 / total
        const f = this.fractions
        const g = other.fractions
        for (let i = 0; i < SPECIES_COUNT; i++) {
            f[i] = (m1 * f[i] + m2 * g[i]) * inverse
        }
        return this.normalize()
    }

    // --- Category bookkeeping -------------------------------------------------

    /**
     * Split the elemental budget into the four material categories. This is the
     * subtle part, because oxygen appears in both silicates and water ice, so
     * it has to be shared out rather than assigned.
     *
     * The rules, applied in this order:
     *
     *  1. GAS is H + He, by definition (X + Y).
     *  2. METAL is Fe. Nickel is not tracked and is folded into iron, which is
     *     what the "Fe/Ni core" of a planet means anyway.
     *  3. ROCK claims oxygen first, because silicates are refractory and
     *     condense at ~1500 K, long before any ice does. Written as oxides,
     *     rock takes 2 oxygens per silicon and 1 per magnesium
     *     (SiO2 + MgO = MgSiO3). If there is not enough oxygen to go round -
     *     an oxygen-poor, carbon-rich mix - rock takes all there is and the
     *     silicates are simply under-oxidised.
     *  4. ICE is everything left: all C, all N, and whatever oxygen the
     *     silicates did not claim. Physically that is H2O from the free oxygen,
     *     CO/CO2/CH4 from the carbon and NH3/N2 from the nitrogen. Note that
     *     which carbon molecule forms does not change the split, since both the
     *     C and the O of a CO molecule land in ice either way.
     *
     * ASSUMPTION, stated plainly: the hydrogen bound inside H2O, CH4 and NH3 is
     * counted in the GAS budget, not the ICE budget, because the contract fixes
     * gasFraction = H + He. So `iceFraction` is the mass of the *heavy atoms*
     * of the ices; true water ice is 11% hydrogen by mass, so the ice mass of a
     * hydrogen-bearing body is under-reported by that much and the shortfall
     * sits in the gas column. For the bodies this actually matters for -
     * planetesimals condensed out of the disk, which carry no free H/He - the
     * two agree, and `fromFormationRadius` builds them that way.
     *
     * The four returned fractions sum to 1 by construction: every species goes
     * to exactly one category, and the oxygen is split, not duplicated.
     */
    _categories() {
        const f = this.fractions
        const A = SPECIES_ATOMIC_MASSES

        const gas = f[SPECIES_H] + f[SPECIES_HE]
        const metal = f[SPECIES_FE]

        const molesMg = f[SPECIES_MG] / A[SPECIES_MG]
        const molesSi = f[SPECIES_SI] / A[SPECIES_SI]
        const molesO = f[SPECIES_O] / A[SPECIES_O]

        let molesOxygenInRock =
            ROCK_OXYGEN_PER_SILICON * molesSi +
            ROCK_OXYGEN_PER_MAGNESIUM * molesMg
        if (molesOxygenInRock > molesO) {
            molesOxygenInRock = molesO
        }
        const oxygenInRock = molesOxygenInRock * A[SPECIES_O]
        let oxygenFree = f[SPECIES_O] - oxygenInRock
        if (oxygenFree < 0) {
            oxygenFree = 0
        }

        const rock = f[SPECIES_MG] + f[SPECIES_SI] + oxygenInRock
        const ice = f[SPECIES_C] + f[SPECIES_N] + oxygenFree

        return { gas: gas, ice: ice, rock: rock, metal: metal }
    }

    get gasFraction() {
        return this._categories().gas
    }

    get iceFraction() {
        return this._categories().ice
    }

    get rockFraction() {
        return this._categories().rock
    }

    get metalFraction() {
        return this._categories().metal
    }

    /** All four at once, for callers that need more than one (structure.js). */
    get categories() {
        return this._categories()
    }

    /** Hydrogen mass fraction, the X of stellar astrophysics. */
    get hydrogenFraction() {
        return this.fractions[SPECIES_H]
    }

    /** Helium mass fraction, Y. */
    get heliumFraction() {
        return this.fractions[SPECIES_HE]
    }

    /** Metallicity Z: everything heavier than helium. */
    get metallicity() {
        return 1 - this.fractions[SPECIES_H] - this.fractions[SPECIES_HE]
    }

    // --- Derived physical properties ------------------------------------------

    /**
     * Uncompressed (zero-pressure) density of the mixture, in Msun/AU^3.
     *
     * Mixtures add VOLUMES, not densities. For unit mass, the volume is
     * sum(f_i / rho_i), so
     *
     *     1 / rho = sum(f_i / rho_i)
     *
     * i.e. the harmonic, mass-weighted mean - which is the same thing as the
     * volume-weighted arithmetic mean. Averaging the densities directly is the
     * classic mistake and gives a 50/50 ice/rock mix 2.1 g/cm^3 instead of the
     * correct 1.52 g/cm^3.
     *
     * This is the density the material would have with no self-compression;
     * structure.js is what turns it into an actual radius.
     */
    get zeroPressureDensity() {
        const c = this._categories()
        const densityGas = DENSITY_GAS_CGS * DENSITY_GRAMS_PER_CM3_TO_SOLAR_PER_AU3
        const specificVolume =
            c.gas / densityGas +
            c.ice / DENSITY_ICE +
            c.rock / DENSITY_ROCK +
            c.metal / DENSITY_METAL
        if (!(specificVolume > 0)) {
            return DENSITY_ROCK
        }
        return 1 / specificVolume
    }

    /** The same thing in g/cm^3, which is the unit densities are quoted in. */
    get zeroPressureDensityCgs() {
        return densityToGramsPerCm3(this.zeroPressureDensity)
    }

    /**
     * Mean molecular weight if the material were neutral and atomic: one
     * particle per atom, so
     *
     *     1 / mu = sum(f_i / A_i)
     *
     * For solar composition this gives 1.29 - the ~1.3 of cold nebular gas.
     */
    get meanMolecularWeightNeutral() {
        const f = this.fractions
        let inverse = 0
        for (let i = 0; i < SPECIES_COUNT; i++) {
            inverse += f[i] / SPECIES_ATOMIC_MASSES[i]
        }
        return inverse > 0 ? 1 / inverse : 1
    }

    /**
     * Mean molecular weight if fully ionized: each atom contributes its nucleus
     * plus Z electrons, so
     *
     *     1 / mu = sum(f_i * (1 + Z_i) / A_i)
     *
     * For solar composition this gives 0.62 - the ~0.6 used for stellar
     * interiors.
     */
    get meanMolecularWeightIonized() {
        const f = this.fractions
        let inverse = 0
        for (let i = 0; i < SPECIES_COUNT; i++) {
            inverse += f[i] * (1 + SPECIES_CHARGES[i]) / SPECIES_ATOMIC_MASSES[i]
        }
        return inverse > 0 ? 1 / inverse : 1
    }

    /**
     * The mu to actually use, chosen from the gas fraction.
     *
     * Ionization state is really a function of temperature, which a composition
     * does not know. The gas fraction is the available proxy and it is not a
     * bad one: a body that is mostly H/He is a star or a giant, held up by a
     * deep hot interior where the hydrogen is ionized, while a body that is
     * mostly rock and ice has no ionized reservoir at all. The interpolation is
     * a smooth ramp between gas fractions of 0.5 and 0.8, so solar composition
     * (gas = 0.98) lands on 0.62 and a planetesimal never gets a stellar mu.
     *
     * If you know the temperature, call meanMolecularWeightAt(T) instead.
     */
    get meanMolecularWeight() {
        const ionized = compositionSmoothStep(0.5, 0.8, this._categories().gas)
        const neutral = this.meanMolecularWeightNeutral
        return neutral + (this.meanMolecularWeightIonized - neutral) * ionized
    }

    /**
     * Physical version of the above: hydrogen ionizes around 1e4 K, so ramp
     * from neutral to fully ionized between 5e3 K and 2e4 K.
     */
    meanMolecularWeightAt(temperature) {
        const ionized = compositionSmoothStep(5e3, 2e4, temperature || 0)
        const neutral = this.meanMolecularWeightNeutral
        return neutral + (this.meanMolecularWeightIonized - neutral) * ionized
    }

    // --- Display --------------------------------------------------------------

    /** Index of the species with the largest mass fraction. Never -1. */
    get dominantSpecies() {
        const f = this.fractions
        let best = 0
        let bestValue = -1
        for (let i = 0; i < SPECIES_COUNT; i++) {
            if (f[i] > bestValue) {
                bestValue = f[i]
                best = i
            }
        }
        return best
    }

    /**
     * The `Atom` from the periodic table matching the dominant species, for the
     * renderer and the inspector. Never undefined: if the table has not been
     * built yet (this file is parsed before main.js builds it) a stand-in with
     * the same fields is returned.
     */
    get dominantElement() {
        return Composition.atomForSpecies(this.dominantSpecies)
    }

    /** Dominant material category, as one of the MATERIAL_* constants. */
    get dominantCategory() {
        const c = this._categories()
        let best = MATERIAL_GAS
        let bestValue = c.gas
        if (c.ice > bestValue) { bestValue = c.ice; best = MATERIAL_ICE }
        if (c.rock > bestValue) { bestValue = c.rock; best = MATERIAL_ROCK }
        if (c.metal > bestValue) { bestValue = c.metal; best = MATERIAL_METAL }
        return best
    }

    /** pt-BR label for the dominant category: Gasoso / Gelado / Rochoso / Metalico. */
    get categoryLabel() {
        return MATERIAL_LABELS[this.dominantCategory]
    }

    /**
     * Colour for the renderer, blended by material category rather than by
     * element: what a body looks like is decided by what it is made of, not by
     * which single atom happens to be most abundant. The four end members are
     * tan for gas, pale blue for ice, brown-grey for rock and dark grey for
     * metal, mixed in proportion to the category mass fractions. A body that is
     * half ice and half rock therefore reads as a dirty snowball, which is what
     * it is.
     */
    get displayColor() {
        const c = this._categories()
        const r = c.gas * 216 + c.ice * 207 + c.rock * 138 + c.metal * 74
        const g = c.gas * 201 + c.ice * 230 + c.rock * 122 + c.metal * 74
        const b = c.gas * 160 + c.ice * 242 + c.rock * 104 + c.metal * 82
        return '#' +
            Composition._hexByte(r) +
            Composition._hexByte(g) +
            Composition._hexByte(b)
    }

    static _hexByte(value) {
        let v = Math.round(value)
        if (!(v >= 0)) v = 0
        if (v > 255) v = 255
        return (v < 16 ? '0' : '') + v.toString(16)
    }

    /** Short pt-BR summary, e.g. "Rochoso - O 32%, Fe 33%, Si 19%". */
    describe() {
        const f = this.fractions
        const order = []
        for (let i = 0; i < SPECIES_COUNT; i++) {
            order.push(i)
        }
        order.sort((a, b) => f[b] - f[a])
        const parts = []
        for (let i = 0; i < 3; i++) {
            const s = order[i]
            if (f[s] < 0.005) {
                break
            }
            parts.push(SPECIES_SYMBOLS[s] + ' ' + (f[s] * 100).toFixed(0) + '%')
        }
        return this.categoryLabel + ' - ' + parts.join(', ')
    }

    // --- Fusion ---------------------------------------------------------------

    /**
     * Burn nuclear fuel for one step.
     *
     *     burn(centralTemperature [K], mass [Msun], dt [years])
     *       -> { energyReleased, changed, stages }
     *
     * `energyReleased` is in JOULES. Nothing else in the simulation is in SI,
     * but energy in Msun*AU^2/yr^2 is unreadable and this number only ever goes
     * to the UI or to a luminosity calculation, so joules it is. Divide by
     * 3.828e26 * 3.156e7 to get solar-luminosity-years.
     *
     * Every stage whose ignition temperature is met runs, in order, each
     * consuming a fraction of its own fuel. That is a shell-burning star
     * compressed into one call: at 2e7 K only hydrogen burns, at 5e9 K the whole
     * chain runs and everything cascades down to iron, where it stops, because
     * fusing iron absorbs energy instead of releasing it.
     *
     * MASS DEFECT: neglected. Fuel is converted to product one-for-one by mass,
     * so the species vector still sums to 1 and the body's mass is untouched,
     * while the energy is reported as if the 0.7% had been taken out. Over a
     * full hydrogen lifetime that is a 0.7% error in the mass budget, which is
     * far below the poetic licence already taken with the accretion radius.
     * Stated here rather than hidden.
     */
    burn(centralTemperature, mass, dt) {
        const result = { energyReleased: 0, changed: false, stages: null }
        if (!(centralTemperature > 0) || !(dt > 0) || !(mass > 0)) {
            return result
        }
        const f = this.fractions
        let convertedTotal = 0
        for (let s = 0; s < FUSION_STAGES.length; s++) {
            const stage = FUSION_STAGES[s]
            if (centralTemperature < stage.threshold) {
                // Stages are ordered by ignition temperature, so nothing above
                // this one can run either.
                break
            }
            const available = f[stage.fuel]
            if (!(available > COMPOSITION_EPSILON)) {
                continue
            }
            let burnedFraction = stage.rate * dt
            if (burnedFraction > 1) {
                burnedFraction = 1
            }
            const burned = available * burnedFraction
            if (!(burned > COMPOSITION_EPSILON)) {
                continue
            }
            f[stage.fuel] -= burned
            for (let p = 0; p < stage.products.length; p++) {
                f[stage.products[p][0]] += burned * stage.products[p][1]
            }
            // Energy = q * consumed rest mass * c^2, in joules.
            result.energyReleased +=
                stage.q * burned * mass * SOLAR_MASS_KG *
                SPEED_OF_LIGHT_MPS * SPEED_OF_LIGHT_MPS
            convertedTotal += burned
            if (!result.stages) {
                result.stages = []
            }
            result.stages.push(stage.name)
        }
        if (convertedTotal > 0) {
            result.changed = true
            this.normalize()
        }
        return result
    }

    // --- Statics --------------------------------------------------------------

    /**
     * Look a species up in the 118-element table. Lazily cached because
     * PERIODIC_TABLE_ELEMENTS is assigned in main.js, after this file loads.
     * Never returns undefined - the whole point of the old bug.
     */
    static atomForSpecies(species) {
        let index = species
        if (!(index >= 0) || index >= SPECIES_COUNT) {
            index = SPECIES_H
        }
        if (!SPECIES_ATOM_CACHE) {
            SPECIES_ATOM_CACHE = new Array(SPECIES_COUNT).fill(null)
        }
        if (SPECIES_ATOM_CACHE[index]) {
            return SPECIES_ATOM_CACHE[index]
        }
        const number = SPECIES_ATOMIC_NUMBERS[index]
        let atom = null
        if (typeof PERIODIC_TABLE_ELEMENTS !== 'undefined' && PERIODIC_TABLE_ELEMENTS) {
            for (let i = 0; i < PERIODIC_TABLE_ELEMENTS.length; i++) {
                if (PERIODIC_TABLE_ELEMENTS[i] && PERIODIC_TABLE_ELEMENTS[i].number === number) {
                    atom = PERIODIC_TABLE_ELEMENTS[i]
                    break
                }
            }
        }
        if (!atom) {
            // Stand-in with the same shape as an Atom, so the UI never sees
            // undefined even before the table exists.
            const fallback = {
                name: SPECIES_NAMES[index],
                color: SPECIES_FALLBACK_COLORS[index],
                number: number,
                symbol: SPECIES_SYMBOLS[index],
                relativeMass: SPECIES_ATOMIC_MASSES[index]
            }
            // Do not cache the stand-in: the real table may appear later.
            return fallback
        }
        SPECIES_ATOM_CACHE[index] = atom
        return atom
    }

    /** Build a composition from category targets. They are normalised for you. */
    static fromCategories(gas, ice, rock, metal) {
        let g = gas > 0 ? gas : 0
        let i = ice > 0 ? ice : 0
        let r = rock > 0 ? rock : 0
        let m = metal > 0 ? metal : 0
        const total = g + i + r + m
        if (!(total > 0)) {
            return new Composition()
        }
        const inverse = 1 / total
        g *= inverse; i *= inverse; r *= inverse; m *= inverse

        const f = new Float64Array(SPECIES_COUNT)
        // Gas is split in the nebular H/He ratio.
        const heliumShare = SOLAR_HELIUM_FRACTION /
            (SOLAR_HYDROGEN_FRACTION + SOLAR_HELIUM_FRACTION)
        f[SPECIES_HE] = g * heliumShare
        f[SPECIES_H] = g * (1 - heliumShare)
        // Rock as MgSiO3. The oxygen written here is exactly the oxygen that
        // _categories() will claim back for rock, so the round trip is exact.
        f[SPECIES_MG] = r * ROCK_MASS_FRACTION_MG
        f[SPECIES_SI] = r * ROCK_MASS_FRACTION_SI
        f[SPECIES_O] = r * ROCK_MASS_FRACTION_O
        // Ice as water + carbon and nitrogen volatiles, heavy atoms only.
        f[SPECIES_O] += i * ICE_MASS_FRACTION_O
        f[SPECIES_C] = i * ICE_MASS_FRACTION_C
        f[SPECIES_N] = i * ICE_MASS_FRACTION_N
        // Metal, Ni folded in.
        f[SPECIES_FE] = m
        return new Composition(f)
    }

    /**
     * Composition of a body that condensed at `radius` in the disk.
     *
     * THE SNOW LINE IS NOT A SETTING. Nowhere in this simulation is a radius
     * configured for it. What is configured is the star: its temperature and
     * its radius, hence its luminosity. The equilibrium temperature
     *
     *     T(r) = Tstar * sqrt(Rstar / 2r)
     *
     * falls with distance, and where it crosses SNOW_LINE_TEMPERATURE = 170 K,
     * water ice becomes stable and the mass of condensable solid roughly
     * triples. For a solar-type star that crossing lands at 2.68 AU - which is
     * the outer asteroid belt, exactly where the real solar system switches
     * from rocky bodies to icy ones. Give the simulation a hotter star and the
     * line moves outward on its own.
     *
     * Inside the line: dry chondritic, 2/3 silicate and 1/3 iron - Earth.
     * Outside: ~50% ice with the same rock:metal ratio behind it - Europa,
     * Ganymede, a comet nucleus.
     *
     * The switch is a smooth ramp over a narrow temperature band rather than a
     * step, so two embryos on neighbouring orbits are not made of wildly
     * different stuff.
     */
    static fromFormationRadius(radius, starTemperature, starRadius) {
        const temperature = Composition.formationTemperature(
            radius, starTemperature, starRadius
        )
        // 0 inside the line (too hot for ice), 1 outside it.
        const condensed = compositionSmoothStep(
            SNOW_LINE_TEMPERATURE * (1 + SNOW_LINE_TRANSITION_WIDTH),
            SNOW_LINE_TEMPERATURE * (1 - SNOW_LINE_TRANSITION_WIDTH),
            temperature
        )
        const ice = ICY_ICE_FRACTION * condensed
        const rock = DRY_ROCK_FRACTION + (ICY_ROCK_FRACTION - DRY_ROCK_FRACTION) * condensed
        const metal = DRY_METAL_FRACTION + (ICY_METAL_FRACTION - DRY_METAL_FRACTION) * condensed
        return Composition.fromCategories(0, ice, rock, metal)
    }

    /** Equilibrium temperature used by fromFormationRadius, in K. */
    static formationTemperature(radius, starTemperature, starRadius) {
        const tStar = starTemperature > 0 ? starTemperature : SOLAR_EFFECTIVE_TEMPERATURE
        const rStar = starRadius > 0 ? starRadius : SOLAR_RADIUS
        return equilibriumTemperature(radius, tStar, rStar, FORMATION_ALBEDO)
    }

    /**
     * Radius at which the equilibrium temperature equals SNOW_LINE_TEMPERATURE,
     * in AU. Inverting T(r) = Tstar*sqrt(Rstar/2r) gives
     *
     *     r = (Rstar/2) * (Tstar/Tsnow)^2
     *
     * Provided for the UI and for verification; nothing in the physics reads it.
     */
    static snowLineRadius(starTemperature, starRadius) {
        const tStar = starTemperature > 0 ? starTemperature : SOLAR_EFFECTIVE_TEMPERATURE
        const rStar = starRadius > 0 ? starRadius : SOLAR_RADIUS
        const ratio = tStar / SNOW_LINE_TEMPERATURE
        return 0.5 * rStar * ratio * ratio
    }

    // --- Compatibility shims for the old API ----------------------------------
    //
    // planet.js, simulation.js and ui.js still speak the old language. These
    // keep them running until they are adapted; every one of them is a
    // read-only view onto the new model and none of them is the right long-term
    // API.

    /** OLD: composition.element -> the Atom. Now the dominant species. */
    get element() {
        return this.dominantElement
    }

    /**
     * OLD: composition.number -> index into PERIODIC_TABLE_ELEMENTS.
     * simulation.js uses it to report the heaviest element reached, so the
     * dominant species' index still means something sensible.
     */
    get number() {
        return SPECIES_ATOMIC_NUMBERS[this.dominantSpecies] - 1
    }

    /**
     * OLD: composition.upgrade(other) incremented an atomic number on impact.
     * That conserved nothing and is gone.
     *
     * Called with masses, this forwards to blend(), which is the correct
     * operation. Called the old way - with no masses - it deliberately does
     * NOTHING: there is no honest way to mix two compositions without knowing
     * how much of each there is, and silently assuming equal masses would
     * corrupt the very conservation this class exists to guarantee. planet.js
     * must be changed to pass the masses.
     */
    upgrade(other, myMass, otherMass) {
        if (myMass > 0 || otherMass > 0) {
            return this.blend(other, myMass, otherMass)
        }
        return this
    }
}
