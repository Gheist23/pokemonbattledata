// Champions damage engine — a line-for-line port of the Companion's calculator.
//
// The app's DamageCalculatorEngine is a stack of override layers, each wrapping
// the previous one.  The layers that are still live are reproduced here in the
// same order and with the same arithmetic (fixed-point modifiers, Python
// rounding, Python number formatting), so the website and the app give the same
// rolls, percentages and KO text for the same inputs.  tests/run-calc-vectors.mjs
// checks that against thousands of results recorded from the app itself.
//
//   calculate            recharge wording            (recharge_ko.py)
//     v494                self-dropping moves          (part_140)
//       v446              description-registry moves   (part_095)
//         v445            Charge and real target count (part_094)
//           v351          display spacing              (part_031)
//             v314        White Herb + Unburden, speeds(part_024)
//               v297      Mega Stone forms/abilities   (part_022)
//                 v290    effect switches, triggers    (part_022)
//                   v289  recoil                       (part_022)
//                     v287 the formula itself         (part_022)
//
// Static data (move metadata, species, Mega Stones) comes from
// data/builder/app-data.json, which the app writes with
// pct_tool94/tools/export_web_builder_data.py.

// --- Python-compatible number helpers -------------------------------------

/** Python's round(): nearest integer, exact halves to even. */
export function pyRound(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python's f"{x:.{digits}f}" — correctly rounded, exact halves to even. */
export function pyFixed(x, digits = 1) {
  if (!Number.isFinite(x)) return String(x);
  const negative = x < 0 || Object.is(x, -0);
  const value = Math.abs(x);
  // Exact binary value: mantissa * 2^exponent.
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value);
  const hi = buffer.getUint32(0);
  const lo = buffer.getUint32(4);
  const exponentBits = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exponent;
  if (exponentBits === 0) {
    exponent = -1074;
  } else {
    mantissa |= 1n << 52n;
    exponent = exponentBits - 1075;
  }
  const scale = 10n ** BigInt(digits);
  let scaled;
  if (exponent >= 0) {
    scaled = mantissa * (1n << BigInt(exponent)) * scale;
  } else {
    const numerator = mantissa * scale;
    const denominator = 1n << BigInt(-exponent);
    let quotient = numerator / denominator;
    const remainder = numerator - quotient * denominator;
    const twice = remainder * 2n;
    if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
    scaled = quotient;
  }
  let text = scaled.toString();
  if (digits > 0) {
    text = text.padStart(digits + 1, "0");
    text = `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  }
  return (negative && scaled !== 0n ? "-" : "") + text;
}

function stripZeros(text) {
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

function floorDiv(a, b) {
  return Math.floor(a / b);
}

// --- small helpers mirroring the Python ones ------------------------------

export function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function key(value) {
  return clean(value).toLowerCase();
}

export function compact(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Python str.title() for the short ASCII words used here (types, categories). */
export function pyTitle(value) {
  return String(value ?? "").toLowerCase().replace(/(^|[^a-z])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
}

const truthy = (value) => Boolean(value) && !(Array.isArray(value) && value.length === 0);
const int = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// --- constant tables (DamageCalculatorEngine class attributes) -------------

const TYPE_BOOST_ITEMS = {
  "charcoal": ["Fire", 1.2], "flame plate": ["Fire", 1.2],
  "mystic water": ["Water", 1.2], "splash plate": ["Water", 1.2],
  "miracle seed": ["Grass", 1.2], "meadow plate": ["Grass", 1.2],
  "magnet": ["Electric", 1.2], "zap plate": ["Electric", 1.2],
  "never-melt ice": ["Ice", 1.2], "icicle plate": ["Ice", 1.2],
  "black belt": ["Fighting", 1.2], "fist plate": ["Fighting", 1.2],
  "poison barb": ["Poison", 1.2], "toxic plate": ["Poison", 1.2],
  "soft sand": ["Ground", 1.2], "earth plate": ["Ground", 1.2],
  "sharp beak": ["Flying", 1.2], "sky plate": ["Flying", 1.2],
  "twisted spoon": ["Psychic", 1.2], "mind plate": ["Psychic", 1.2],
  "silver powder": ["Bug", 1.2], "insect plate": ["Bug", 1.2],
  "hard stone": ["Rock", 1.2], "stone plate": ["Rock", 1.2],
  "spell tag": ["Ghost", 1.2], "spooky plate": ["Ghost", 1.2],
  "dragon fang": ["Dragon", 1.2], "draco plate": ["Dragon", 1.2],
  "black glasses": ["Dark", 1.2], "dread plate": ["Dark", 1.2],
  "metal coat": ["Steel", 1.2], "iron plate": ["Steel", 1.2],
  "fairy feather": ["Fairy", 1.2], "pixie plate": ["Fairy", 1.2],
  "silk scarf": ["Normal", 1.2],
};
export const RESIST_BERRIES = {
  "chilan berry": "Normal", "occa berry": "Fire", "passho berry": "Water", "wacan berry": "Electric",
  "rindo berry": "Grass", "yache berry": "Ice", "chople berry": "Fighting", "kebia berry": "Poison",
  "shuca berry": "Ground", "coba berry": "Flying", "payapa berry": "Psychic", "tanga berry": "Bug",
  "charti berry": "Rock", "kasib berry": "Ghost", "haban berry": "Dragon", "colbur berry": "Dark",
  "babiri berry": "Steel", "roseli berry": "Fairy",
};
export const PINCH_ABILITIES = { "blaze": "Fire", "torrent": "Water", "overgrow": "Grass", "swarm": "Bug" };
export const TYPE_IMMUNITY_ABILITIES = {
  "levitate": "Ground", "flash fire": "Fire", "well-baked body": "Fire",
  "water absorb": "Water", "storm drain": "Water", "dry skin": "Water",
  "volt absorb": "Electric", "lightning rod": "Electric", "motor drive": "Electric",
  "sap sipper": "Grass", "earth eater": "Ground",
};
export const ATE_ABILITIES = { "pixilate": "Fairy", "aerilate": "Flying", "refrigerate": "Ice", "galvanize": "Electric" };
const ORB_BOOSTS = {
  "adamant orb": ["Dragon", "Steel"], "lustrous orb": ["Dragon", "Water"],
  "griseous orb": ["Dragon", "Ghost"], "griseous core": ["Dragon", "Ghost"],
};
const DRIVE_TYPES = { "burn drive": "Fire", "chill drive": "Ice", "douse drive": "Water", "shock drive": "Electric" };
const PLATE_TYPES = Object.fromEntries(Object.entries(TYPE_BOOST_ITEMS).filter(([k]) => k.includes("plate")).map(([k, v]) => [k, v[0]]));
const MEMORY_TYPES = {
  "bug memory": "Bug", "dark memory": "Dark", "dragon memory": "Dragon", "electric memory": "Electric",
  "fairy memory": "Fairy", "fighting memory": "Fighting", "fire memory": "Fire", "flying memory": "Flying",
  "ghost memory": "Ghost", "grass memory": "Grass", "ground memory": "Ground", "ice memory": "Ice",
  "poison memory": "Poison", "psychic memory": "Psychic", "rock memory": "Rock", "steel memory": "Steel", "water memory": "Water",
};
const MOLD_BREAKERS = new Set(["mold breaker", "teravolt", "turboblaze"]);
const INTIMIDATE_BLOCKERS = new Set(["clear body", "white smoke", "full metal body", "inner focus", "oblivious", "own tempo", "scrappy"]);
const DAMAGE_RECOIL_FRACTIONS = {
  "Brave Bird": 1 / 3, "Double-Edge": 1 / 3, "Flare Blitz": 1 / 3,
  "Light of Ruin": 1 / 2, "Head Smash": 1 / 2, "Take Down": 1 / 4,
  "Submission": 1 / 4, "Volt Tackle": 1 / 3, "Wave Crash": 1 / 3,
  "Wild Charge": 1 / 4, "Wood Hammer": 1 / 3, "Head Charge": 1 / 4,
};
const MAX_HP_RECOIL_FRACTIONS = { "Steel Beam": 1 / 2, "Mind Blown": 1 / 2, "Chloroblast": 1 / 2 };
const SELF_DROP_STAGES = {
  "close combat": ["defense", 1], "superpower": ["attack", 1], "headlong rush": ["defense", 1],
  "v-create": ["defense", 1], "v create": ["defense", 1], "draco meteor": ["sp_attack", 2],
  "leaf storm": ["sp_attack", 2], "overheat": ["sp_attack", 2], "fleur cannon": ["sp_attack", 2],
  "make it rain": ["sp_attack", 2], "psycho boost": ["sp_attack", 2], "hyperspace fury": ["defense", 1],
};
const RECHARGE_MOVES = new Set("hyperbeam gigaimpact frenzyplant blastburn hydrocannon rockwrecker roaroftime prismaticlaser eternabeam meteorassault".split(" "));
export const TRIGGERED_ABILITIES = new Set([
  "electromorphosis", "wind power", "flash fire", "motor drive", "sap sipper",
  "storm drain", "steam engine", "weak armor", "justified", "rattled",
  "berserk", "stamina", "water compaction", "anger shell", "moxie",
  "beast boost", "chilling neigh", "grim neigh", "download",
]);
export const MANUAL_STAGE_CHANGES = {
  "motor drive": { speed_stage: 1 },
  "sap sipper": { attack_stage: 1 },
  "storm drain": { sp_attack_stage: 1 },
  "steam engine": { speed_stage: 6 },
  "weak armor": { defense_stage: -1, speed_stage: 2 },
  "justified": { attack_stage: 1 },
  "rattled": { speed_stage: 1 },
  "berserk": { sp_attack_stage: 1 },
  "stamina": { defense_stage: 1 },
  "water compaction": { defense_stage: 2 },
  "anger shell": { attack_stage: 1, sp_attack_stage: 1, speed_stage: 1, defense_stage: -1, sp_defense_stage: -1 },
  "moxie": { attack_stage: 1 },
  "chilling neigh": { attack_stage: 1 },
  "grim neigh": { sp_attack_stage: 1 },
};
export const STAT_KEYS = [["HP", "hp"], ["ATK", "attack"], ["DEF", "defense"], ["SPA", "sp_attack"], ["SPD", "sp_defense"], ["SPE", "speed"]];
const STAGE_ATTRS = ["attack_stage", "defense_stage", "sp_attack_stage", "sp_defense_stage", "speed_stage"];
export const MAX_BONUS_STAT_POINTS = 66;
export const MAX_BONUS_POINTS_PER_STAT = 32;

// --- fixed-point modifier arithmetic (part_001) ----------------------------

const KNOWN_FIXED = [[0.25, 1024], [0.5, 2048], [0.75, 3072], [1.0, 4096], [1.2, 4915], [1.25, 5120], [1.3, 5324], [1.5, 6144], [2.0, 8192]];

export function modifierFixedPoint(value) {
  const v = Number(value);
  if (Math.abs(v - 2 / 3) < 1e-9) return 2732;
  for (const [candidate, fixed] of KNOWN_FIXED) {
    if (Math.abs(v - candidate) < 1e-9) return fixed;
  }
  return Math.max(0, Math.trunc(pyRound(v * 4096)));
}

function normalRoundFraction(numerator, denominator) {
  denominator = Math.max(1, Math.trunc(denominator));
  const n = Math.max(0, Math.trunc(numerator));
  const quotient = Math.floor(n / denominator);
  const remainder = n - quotient * denominator;
  return quotient + (remainder * 2 >= denominator ? 1 : 0);
}

function pokeRoundFraction(numerator, denominator) {
  denominator = Math.max(1, Math.trunc(denominator));
  const n = Math.max(0, Math.trunc(numerator));
  const quotient = Math.floor(n / denominator);
  const remainder = n - quotient * denominator;
  return quotient + (remainder * 2 > denominator ? 1 : 0);
}

export function chainModifiers(modifiers) {
  let combined = 4096;
  for (const [, value] of modifiers) {
    combined = normalRoundFraction(combined * modifierFixedPoint(value), 4096);
  }
  return Math.max(0, combined);
}

export function applyChainedModifiers(value, modifiers) {
  if (!modifiers.length) return Math.max(0, Math.trunc(value));
  return pokeRoundFraction(Math.max(0, Math.trunc(value)) * chainModifiers(modifiers), 4096);
}

export function applyDamageModifier(value, modifier) {
  return pokeRoundFraction(Math.max(0, Math.trunc(value)) * modifierFixedPoint(modifier), 4096);
}

export function stagedStat(value, stage) {
  stage = clamp(Math.trunc(stage), -6, 6);
  value = Math.max(1, Math.trunc(value));
  if (stage >= 0) return Math.max(1, floorDiv(value * (2 + stage), 2));
  return Math.max(1, floorDiv(value * 2, 2 - stage));
}

// --- DamageMon / DamageContext ---------------------------------------------

export function makeMon(fields = {}) {
  return {
    pokemon_name: "",
    form_name: "",
    level: 50,
    item: "",
    ability: "",
    nature_name: "Serious",
    bonuses: [0, 0, 0, 0, 0, 0],
    moves: [],
    current_hp_percent: 100,
    attack_stage: 0,
    defense_stage: 0,
    sp_attack_stage: 0,
    sp_defense_stage: 0,
    speed_stage: 0,
    status: "",
    gender: "Unspecified",
    ...fields,
  };
}

export function makeContext(fields = {}) {
  return {
    move_name: "",
    move_type_override: "",
    move_category_override: "",
    move_power_override: 0,
    weather: "None",
    terrain: "None",
    battle_format: "Doubles",
    critical: false,
    spread_move: false,
    burned: false,
    helping_hand: false,
    reflect: false,
    light_screen: false,
    aurora_veil: false,
    friend_guard: false,
    protect: false,
    stealth_rock: false,
    spikes: 0,
    salt_cure: false,
    hits: 0,
    times_used: 1,
    attacker_moved_first: false,
    attacker_was_hit: false,
    defender_switching: false,
    last_move_failed: false,
    fainted_allies: 0,
    last_damage: 0,
    gravity: false,
    wonder_room: false,
    attacker_state: {},
    defender_state: {},
    ...fields,
  };
}

function cloneMon(mon) {
  return { ...mon, bonuses: [...(mon.bonuses || [])], moves: [...(mon.moves || [])] };
}

function copyCtx(ctx) {
  return { ...ctx, attacker_state: { ...(ctx.attacker_state || {}) }, defender_state: { ...(ctx.defender_state || {}) } };
}

export function normalizeBonuses(values) {
  const list = Array.isArray(values) ? values.slice(0, 6) : [];
  const out = list.map((value) => clamp(int(value, 0), 0, MAX_BONUS_POINTS_PER_STAT));
  while (out.length < 6) out.push(0);
  return out;
}

export function maxFaintedAllies(battleFormat) {
  return String(battleFormat || "Doubles").toLowerCase().startsWith("single") ? 2 : 3;
}

export function clampFaintedAllies(value, battleFormat) {
  return clamp(int(value, 0), 0, maxFaintedAllies(battleFormat));
}

/** v351: canonical (species, form) for either Mega naming style. */
export function parseMegaName(value) {
  const words = String(value ?? "").trim().replace(/_/g, " ").split(/[\s-]+/).filter(Boolean);
  if (!words.length) return null;
  const lower = words.map((w) => w.toLowerCase());
  const megaIndex = lower.indexOf("mega");
  if (megaIndex < 0) return null;
  let suffix = "";
  // Z as well as X/Y: "Mega Garchomp Z" is Garchomp's, not a species "Garchomp Z".
  if (["X", "Y", "Z"].includes(words[words.length - 1].toUpperCase()) && words.length - 1 !== megaIndex) {
    suffix = words[words.length - 1].toUpperCase();
  }
  let baseWords;
  if (megaIndex === 0) baseWords = words.slice(1, words.length - (suffix ? 1 : 0));
  else baseWords = words.slice(0, megaIndex);
  const base = baseWords.join(" ").trim();
  if (!base) return null;
  return [base, `Mega ${base}${suffix ? ` ${suffix}` : ""}`];
}

export function speciesAndForm(pokemonName, formName = "") {
  const rawSpecies = String(pokemonName ?? "").trim();
  const rawForm = String(formName ?? "").trim();
  const parsedForm = parseMegaName(rawForm);
  const parsedSpecies = parseMegaName(rawSpecies);
  if (parsedForm) return parsedForm;
  if (parsedSpecies) return parsedSpecies;
  const species = rawSpecies || rawForm;
  return [species, rawForm || species];
}

// --- the engine ------------------------------------------------------------

export class DamageEngine {
  constructor(appData) {
    this.data = appData;
    this.typeChart = appData.typeChart || {};
    this.natures = appData.natures || {};
    this.moves = appData.moves || {};
    this.moveByCompact = new Map();
    for (const name of Object.keys(this.moves)) this.moveByCompact.set(compact(name), name);
    this.moveAliases = appData.moveAliases || {};
    this.speciesByName = new Map();
    this.formIndex = new Map(); // compact(form) -> [species, form]
    for (const entry of appData.species || []) {
      this.speciesByName.set(compact(entry.name), entry);
      for (const form of entry.forms) {
        if (!this.formIndex.has(compact(form.form))) this.formIndex.set(compact(form.form), [entry.name, form.form]);
      }
    }
    for (const entry of appData.species || []) {
      if (!this.formIndex.has(compact(entry.name)) && entry.forms.length) {
        this.formIndex.set(compact(entry.name), [entry.name, entry.forms[0].form]);
      }
    }
    this.usageAliases = appData.usageAliases || {};
    for (const [stem, pair] of Object.entries(this.usageAliases)) {
      if (!this.formIndex.has(compact(stem))) this.formIndex.set(compact(stem), pair);
    }
    this.items = new Map((appData.items || []).map((item) => [compact(item.name), item]));
    this.megaStones = new Map(Object.entries(appData.megaStones || {}).map(([name, holders]) => [compact(name), holders]));
    this._statCache = new Map();
  }

  // ---- lookups ----

  /** The app's (species, form) for any spelling of a Pokemon. */
  resolve(pokemonName, formName = "") {
    const [species, form] = speciesAndForm(pokemonName, formName || pokemonName);
    const entry = this.speciesByName.get(compact(species));
    if (entry) {
      const match = entry.forms.find((f) => compact(f.form) === compact(form));
      if (match) return [entry.name, match.form];
    }
    const byForm = this.formIndex.get(compact(form));
    if (byForm) return byForm;
    const bySpecies = this.formIndex.get(compact(species));
    if (bySpecies) return bySpecies;
    return [species, form];
  }

  speciesEntry(name) {
    return this.speciesByName.get(compact(name)) || null;
  }

  formRecord(pokemonName, formName = "") {
    const [species, form] = this.resolve(pokemonName, formName);
    const entry = this.speciesByName.get(compact(species));
    if (!entry) return null;
    return entry.forms.find((f) => compact(f.form) === compact(form)) || entry.forms[0] || null;
  }

  /** AssetManager.get_pokemon: types, stats, weight (placeholder when unknown). */
  pokemon(pokemonName, formName = "") {
    const record = this.formRecord(pokemonName, formName);
    if (record) return record;
    return {
      form: String(formName || pokemonName || ""),
      types: ["Unknown"],
      stats: { hp: 70, attack: 70, defense: 70, sp_attack: 70, sp_defense: 70, speed: 70 },
      weight: 0,
      abilities: [],
      mega: false,
    };
  }

  isMegaStone(item) {
    const record = this.items.get(compact(item));
    if (record) return Boolean(record.mega);
    const k = compact(item);
    return Boolean(k) && /(ite|itex|itey|itez)$/.test(k) && !["eviolite", "whiteherb"].includes(k);
  }

  /** V494's `_v297_mega_form_for_mon`: a matching stone decides, even over an explicit Mega form. */
  megaFormForMon(mon) {
    const holders = this.megaStones.get(compact(mon.item)) || [];
    const [named, current] = speciesAndForm(mon.pokemon_name, mon.form_name);
    // A ladder spelling ("Floette-Eternal") names its species through the
    // alias table, as the app's species_identity layer does.
    const species = this.speciesByName.has(compact(named)) ? named : this.resolve(named)[0];
    const holder = holders.find((h) => compact(h.species) === compact(species));
    if (holder) return holder.form;
    if (parseMegaName(current)) return current;
    return current || species;
  }

  /** v351 `_v297_effective_mega_mon`: the stone decides the form, a Mega form its ability. */
  effectiveMegaMon(mon) {
    const clone = cloneMon(mon);
    const rawForm = String(mon.form_name || mon.pokemon_name || "").trim();
    const [named, canonical] = speciesAndForm(mon.pokemon_name, rawForm);
    const species = this.speciesByName.has(compact(named)) ? named : this.resolve(named)[0];
    clone.pokemon_name = species;
    clone.form_name = canonical || species;
    const resolved = this.megaFormForMon(clone);
    clone.form_name = resolved;
    if (parseMegaName(resolved)) {
      const record = this.formRecord(species, resolved);
      let ability = record?.megaAbility || "";
      if (!ability && record?.abilities?.length) ability = record.abilities[0];
      if (ability) clone.ability = ability;
    }
    return clone;
  }

  canonicalMoveName(moveName) {
    const name = clean(moveName);
    if (this.moveAliases[name]) return this.moveAliases[name];
    return this.moveByCompact.get(compact(name)) || name;
  }

  moveRecord(moveName) {
    return this.moves[this.canonicalMoveName(moveName)] || null;
  }

  /** The final `move_meta` chain for a context. */
  moveMeta(ctx) {
    const name = this.canonicalMoveName(ctx.move_name);
    const record = this.moves[name];
    let meta;
    if (record) {
      meta = JSON.parse(JSON.stringify(record));
      delete meta.acc;
      delete meta.acc_weather;
      delete meta.description;
    } else {
      meta = { type: "Normal", category: "physical", power: 80, missing_metadata: true, priority: 0, target: "normal", spread: false };
    }
    meta.name = name;
    if (ctx.move_type_override) meta.type = pyTitle(ctx.move_type_override);
    if (ctx.move_category_override) meta.category = String(ctx.move_category_override).toLowerCase();
    if (int(ctx.move_power_override) > 0) {
      meta.power = int(ctx.move_power_override);
      if (meta.type && meta.category) delete meta.missing_metadata;
    }
    // V445 drops the spread modifier for a single target, but the description
    // registry sits outside it and restores `spread` for the moves it has
    // structural data for, so in the app the rule only reaches the others.
    const targets = ctx.actual_spread_targets_v445;
    if (targets !== undefined && targets !== null && int(targets) <= 1 && !meta.registry_spread) {
      meta.spread_capable_v445 = Boolean(meta.spread);
      meta.spread = false;
    }
    delete meta.registry_spread;
    return meta;
  }

  moveAccuracyPercent(moveName, ctx) {
    const record = this.moveRecord(moveName);
    if (!record) return 100;
    const weather = String(ctx.weather || "None");
    const byWeather = record.acc_weather || {};
    if (Object.prototype.hasOwnProperty.call(byWeather, weather)) return Number(byWeather[weather]);
    return Number(record.acc ?? 100);
  }

  // ---- stats ----

  finalStats(mon) {
    const effective = this.effectiveMegaMon(mon);
    const cacheKey = `${effective.pokemon_name}|${effective.form_name}|${effective.nature_name}|${(effective.bonuses || []).join(",")}`;
    const cached = this._statCache.get(cacheKey);
    if (cached) return { ...cached };
    const data = this.pokemon(effective.pokemon_name, effective.form_name);
    const bonuses = normalizeBonuses(effective.bonuses);
    const [boost, nerf] = this.natures[effective.nature_name] || ["", ""];
    const out = {};
    STAT_KEYS.forEach(([label, statKey], index) => {
      let value = Math.trunc(pyRound(Number(data.stats?.[statKey] ?? 70)));
      value += clamp(bonuses[index], 0, MAX_BONUS_POINTS_PER_STAT);
      if (statKey !== "hp") {
        if (label === String(boost).toUpperCase()) value = Math.floor(value * 1.1);
        else if (label === String(nerf).toUpperCase()) value = Math.floor(value * 0.9);
      }
      out[statKey] = Math.max(1, value);
    });
    if (this._statCache.size > 4096) this._statCache.clear();
    this._statCache.set(cacheKey, out);
    return { ...out };
  }

  effectiveSpeed(mon, sideState = {}) {
    const stats = this.finalStats(mon);
    let speed = stagedStat(stats.speed ?? 1, mon.speed_stage || 0);
    const ability = key(mon.ability);
    const item = key(mon.item);
    const status = clean(mon.status);
    const weather = String(sideState.weather || "None");
    const modifiers = [];
    if (ability === "chlorophyll" && weather === "Sun") modifiers.push(["Chlorophyll", 2.0]);
    if (ability === "swift swim" && weather === "Rain") modifiers.push(["Swift Swim", 2.0]);
    if (ability === "sand rush" && weather === "Sand") modifiers.push(["Sand Rush", 2.0]);
    if (ability === "slush rush" && weather === "Snow") modifiers.push(["Slush Rush", 2.0]);
    if (ability === "quick feet" && status) modifiers.push(["Quick Feet", 1.5]);
    else if (status === "Paralyzed") modifiers.push(["Paralysis", 0.5]);
    if (item === "choice scarf") modifiers.push(["Choice Scarf", 1.5]);
    if (item === "iron ball") modifiers.push(["Iron Ball", 0.5]);
    if (sideState.tailwind) modifiers.push(["Tailwind", 2.0]);
    if (sideState.unburden) modifiers.push(["Unburden", 2.0]);
    if (modifiers.length) speed = applyChainedModifiers(speed, modifiers);
    return Math.max(1, Math.trunc(speed));
  }

  isGrounded(mon, data, sideState) {
    const ability = key(mon.ability);
    const item = key(mon.item);
    if (item === "iron ball") return true;
    if (sideState && sideState.gravity) return true;
    if ((data.types || []).includes("Flying") || ability === "levitate" || item === "air balloon") return false;
    return true;
  }

  typeMultiplier(attackingType, defendingTypes) {
    let multiplier = 1.0;
    const chart = this.typeChart[pyTitle(attackingType)] || {};
    for (const type of defendingTypes || []) {
      const value = chart[pyTitle(type)];
      multiplier *= value === undefined ? 1.0 : value;
    }
    return multiplier;
  }

  typeEffectiveness(moveName, moveType, attacker, defender, defData) {
    const attackType = pyTitle(moveType || "Normal");
    const atkAbility = key(attacker.ability);
    let multiplier = 1.0;
    const chart = this.typeChart[attackType] || {};
    for (const defendingType of defData.types || []) {
      const defending = pyTitle(defendingType);
      let value = chart[defending] === undefined ? 1.0 : chart[defending];
      if (value === 0 && (attackType === "Normal" || attackType === "Fighting") && defending === "Ghost" && (atkAbility === "scrappy" || atkAbility === "mind's eye")) value = 1.0;
      multiplier *= value;
    }
    if (moveName === "Freeze-Dry" && (defData.types || []).includes("Water")) multiplier *= 4.0;
    return multiplier;
  }

  abilityBlocksDamage(attacker, defender, moveType, meta) {
    const ability = key(defender.ability);
    const atkAbility = key(attacker.ability);
    if (MOLD_BREAKERS.has(atkAbility)) return null;
    if (TYPE_IMMUNITY_ABILITIES[ability] === moveType) return defender.ability;
    const flags = new Set((meta.flags || []).map((f) => String(f).toLowerCase()));
    if (ability === "bulletproof" && (flags.has("ballistics") || flags.has("bomb"))) return defender.ability;
    if (ability === "soundproof" && flags.has("sound")) return defender.ability;
    if (ability === "wind rider" && flags.has("wind")) return defender.ability;
    if (ability === "damp" && ["Explosion", "Self-Destruct", "Mind Blown", "Misty Explosion"].includes(meta.name)) return defender.ability;
    return null;
  }

  modifiedMoveType(attacker, moveType, meta, details) {
    // base
    const ability = key(attacker.ability);
    const moveName = String(meta.name || "");
    if (moveType === "Normal" && ATE_ABILITIES[ability] && !["Judgment", "Natural Gift", "Revelation Dance", "Techno Blast", "Multi-Attack"].includes(moveName)) {
      meta._ate_converted = true;
      details.push(`${attacker.ability}: Normal move becomes ${ATE_ABILITIES[ability]}`);
      moveType = ATE_ABILITIES[ability];
    }
    // v287
    const item = key(attacker.item);
    const flags = new Set((meta.flags || []).map((f) => String(f).toLowerCase()));
    if (ability === "normalize" && moveName !== "Struggle") {
      meta._normalize_converted = true;
      return "Normal";
    }
    if (ability === "liquid voice" && flags.has("sound")) {
      meta._liquid_voice_converted = true;
      return "Water";
    }
    if (moveName === "Revelation Dance") {
      const types = this.pokemon(attacker.pokemon_name, attacker.form_name).types || [];
      if (types.length) return pyTitle(types[0]);
    }
    if (moveName === "Judgment" && PLATE_TYPES[item]) return PLATE_TYPES[item];
    if (moveName === "Techno Blast" && DRIVE_TYPES[item]) return DRIVE_TYPES[item];
    if (moveName === "Multi-Attack" && MEMORY_TYPES[item]) return MEMORY_TYPES[item];
    return pyTitle(moveType);
  }

  hazardAdjustedHp(defender, defData, ctx, maxHp, defState, details) {
    const percent = clamp(int(defender.current_hp_percent, 100), 1, 100);
    let currentHp = Math.max(1, Math.ceil((maxHp * percent) / 100));
    const item = key(defender.item);
    const ability = key(defender.ability);
    const hazards = Boolean(ctx.stealth_rock) || int(ctx.spikes) !== 0;
    if (hazards && item === "heavy-duty boots") {
      details.push("Heavy-Duty Boots: entry hazards ignored");
      return currentHp;
    }
    if (hazards && ability === "magic guard") {
      details.push("Magic Guard: entry-hazard damage ignored");
      return currentHp;
    }
    let hazardDamage = 0;
    if (ctx.stealth_rock) {
      const rock = this.typeMultiplier("Rock", defData.types);
      const rockDamage = rock > 0 ? Math.max(1, Math.floor(maxHp * 0.125 * rock)) : 0;
      hazardDamage += rockDamage;
    }
    if (int(ctx.spikes) && this.isGrounded(defender, defData, defState)) {
      const layers = clamp(int(ctx.spikes), 0, 3);
      const fraction = { 0: 0, 1: 1 / 8, 2: 1 / 6, 3: 1 / 4 }[layers] || 0;
      hazardDamage += fraction > 0 ? Math.max(1, Math.floor(maxHp * fraction)) : 0;
    }
    if (hazardDamage) currentHp = Math.max(1, currentHp - hazardDamage);
    return currentHp;
  }

  static weightPower(weightKg) {
    const weight = Number(weightKg) || 0;
    if (weight <= 0) return 0;
    if (weight < 10) return 20;
    if (weight < 25) return 40;
    if (weight < 50) return 60;
    if (weight < 100) return 80;
    if (weight < 200) return 100;
    return 120;
  }

  static weightRatioPower(attackerKg, defenderKg) {
    const a = Number(attackerKg) || 0;
    const d = Number(defenderKg) || 0;
    if (a <= 0 || d <= 0) return 0;
    const ratio = a / Math.max(0.001, d);
    if (ratio >= 5) return 120;
    if (ratio >= 4) return 100;
    if (ratio >= 3) return 80;
    if (ratio >= 2) return 60;
    return 40;
  }

  /** modified_power: base -> v287 -> v445 (Charge) -> v446 (registry). */
  modifiedPower(attacker, defender, ctx, meta, atkState, defState, details, warnings) {
    const moveName = String(meta.name || ctx.move_name);
    let power = int(Number(meta.power), 0);
    if (!Number.isFinite(Number(meta.power))) power = 0;
    const special = String(meta.special || "");
    const moveType = pyTitle(meta.type || "Normal");
    const atkData = this.pokemon(attacker.pokemon_name, attacker.form_name);
    const defData = this.pokemon(defender.pokemon_name, defender.form_name);

    // --- base (part_001) ---
    if (special === "weather_ball" && ["Sun", "Rain", "Sand", "Snow"].includes(ctx.weather)) {
      meta.type = { Sun: "Fire", Rain: "Water", Sand: "Rock", Snow: "Ice" }[ctx.weather] || moveType;
      power = 100;
    } else if (special === "solar_beam" && ["Rain", "Sand", "Snow"].includes(ctx.weather)) {
      power = Math.max(1, floorDiv(power, 2));
    } else if (special === "knock_off" && clean(defender.item)) {
      power = Math.floor(power * 1.5);
    } else if (special === "facade" && ["Burned", "Poisoned", "Badly Poisoned", "Paralyzed"].includes(clean(attacker.status))) {
      power *= 2;
    } else if (special === "hex" && clean(defender.status)) {
      power *= 2;
    } else if (special === "venoshock" && ["Poisoned", "Badly Poisoned"].includes(clean(defender.status))) {
      power *= 2;
    } else if (special === "brine") {
      const maxHp = Math.max(1, this.finalStats(defender).hp || 1);
      const currentHp = this.hazardAdjustedHp(defender, defData, ctx, maxHp, defState, []);
      if (currentHp <= floorDiv(maxHp, 2)) power *= 2;
    } else if (special === "acrobatics" && !clean(attacker.item)) {
      power *= 2;
    } else if (special === "eruption") {
      const maxHp = Math.max(1, this.finalStats(attacker).hp || 1);
      const currentHp = Math.max(1, Math.ceil((maxHp * clamp(int(attacker.current_hp_percent, 100), 1, 100)) / 100));
      power = Math.max(1, Math.floor((150 * currentHp) / maxHp));
    } else if (special === "electro_ball" || special === "gyro_ball") {
      const atkSpeed = this.effectiveSpeed(attacker, atkState);
      const defSpeed = this.effectiveSpeed(defender, defState);
      if (special === "electro_ball") {
        const ratio = atkSpeed / Math.max(1, defSpeed);
        power = ratio >= 4 ? 150 : ratio >= 3 ? 120 : ratio >= 2 ? 80 : ratio >= 1 ? 60 : 40;
      } else {
        power = Math.max(1, Math.min(150, Math.floor((25 * defSpeed) / Math.max(1, atkSpeed)) + 1));
      }
    } else if (special === "stored_power") {
      const positive = STAGE_ATTRS.reduce((sum, attr) => sum + Math.max(0, int(attacker[attr])), 0);
      power = Math.min(860, power + 20 * positive);
    } else if (special === "expanding_force" && ctx.terrain === "Psychic" && this.isGrounded(attacker, atkData, atkState)) {
      power = Math.floor(power * 1.5);
      meta.spread = String(ctx.battle_format).toLowerCase() === "doubles";
    } else if (special === "rising_voltage" && ctx.terrain === "Electric" && this.isGrounded(defender, defData, defState)) {
      power *= 2;
    } else if (special === "weight_power") {
      const calculated = DamageEngine.weightPower(defData.weight || 0);
      if (calculated > 0) power = calculated;
      else warnings.push(`Exact ${moveName} power needs target weight metadata`);
    } else if (special === "weight_ratio_power") {
      const calculated = DamageEngine.weightRatioPower(atkData.weight || 0, defData.weight || 0);
      if (calculated > 0) power = calculated;
      else warnings.push(`Exact ${moveName} power needs both Pokémon weights`);
    }
    power = Math.max(0, Math.trunc(power));

    // --- v287 ---
    if (special === "knock_off" && clean(defender.item) && this.isMegaStone(defender.item)) {
      power = int(Number(meta.power ?? 65) || 65);
    }
    if (special === "poltergeist" && !clean(defender.item)) {
      power = 0;
    } else if (special === "payback" && !ctx.attacker_moved_first) {
      power *= 2;
    } else if (special === "assurance" && defState.damaged_this_turn) {
      power *= 2;
    } else if (special === "revenge" && (ctx.attacker_was_hit || atkState.was_hit)) {
      power *= 2;
    } else if (special === "first_double" && ctx.attacker_moved_first) {
      power *= 2;
    } else if (special === "failed_double" && ctx.last_move_failed) {
      power *= 2;
    } else if (special === "rage_fist") {
      power = Math.min(350, 50 + 50 * Math.max(0, int(atkState.times_hit)));
    } else if (special === "last_respects") {
      power = 50 + 50 * clampFaintedAllies(ctx.fainted_allies, ctx.battle_format || "Doubles");
    } else if (special === "flail") {
      const maximum = Math.max(1, this.finalStats(attacker).hp || 1);
      const current = Math.max(1, Math.ceil((maximum * clamp(int(attacker.current_hp_percent, 100), 1, 100)) / 100));
      const ratio = Math.floor((48 * current) / maximum);
      power = ratio <= 1 ? 200 : ratio <= 4 ? 150 : ratio <= 9 ? 100 : ratio <= 16 ? 80 : ratio <= 32 ? 40 : 20;
    } else if (special === "target_hp_power") {
      const maximum = Math.max(1, this.finalStats(defender).hp || 1);
      const current = Math.max(1, Math.ceil((maximum * clamp(int(defender.current_hp_percent, 100), 1, 100)) / 100));
      power = Math.max(1, Math.floor((120 * current) / maximum));
    } else if (special === "psyblade" && String(ctx.terrain) === "Electric") {
      power = applyDamageModifier(power, 1.5);
    }
    power = Math.max(0, Math.trunc(power));

    // --- v445: Charge ---
    const charged = Boolean(atkState.charged_v445 || atkState.charged || ctx.charged_v445);
    const isElectric = pyTitle(meta.type || "") === "Electric";
    const isDamaging = String(meta.category || "status").toLowerCase() !== "status" && power > 0 && !meta.fixed_damage;
    if (charged && isElectric && isDamaging) {
      power = Math.max(1, applyChainedModifiers(power, [["Charge", 2.0]]));
    }
    power = Math.max(0, Math.trunc(power));

    // --- v446: description registry ---
    const moveKey = key(moveName);
    if (special === "hard_press") {
      const maximum = Math.max(1, this.finalStats(defender).hp || 1);
      const current = this.hazardAdjustedHp(defender, defData, ctx, maximum, defState, []);
      power = Math.max(1, Math.floor((100 * current) / maximum));
    } else if (special === "misty_explosion") {
      if (String(ctx.terrain) === "Misty" && this.isGrounded(attacker, atkData, atkState)) power = applyDamageModifier(power, 1.5);
    } else if (special === "punishment") {
      const positive = [...STAGE_ATTRS, "accuracy_stage", "evasion_stage"].reduce((s, a) => s + Math.max(0, int(defender[a])), 0);
      power = Math.min(200, 60 + 20 * positive);
    } else if (special === "successive_power") {
      const uses = Math.max(1, int(ctx.times_used, 1) || 1);
      if (moveKey === "fury cutter") {
        const base = Math.max(1, int(Number(meta.power ?? 40) || 40));
        power = Math.min(160, base * 2 ** Math.min(uses - 1, 3));
      } else {
        const effect = effectOp(meta, "successive_power") || {};
        const base = Math.max(1, int(Number(meta.power ?? power) || power));
        const multiplier = Math.max(1.0, Number(effect.multiplier ?? 2) || 2);
        const maxUses = Math.max(1, int(effect.max_uses ?? 5) || 5);
        power = Math.max(1, Math.trunc(base * multiplier ** Math.min(uses - 1, maxUses - 1)));
      }
    } else if (special === "lash_out") {
      if (atkState.stats_lowered_this_turn) power *= 2;
    } else if (special === "retaliate") {
      if (atkState.ally_fainted_last_turn || ctx.ally_fainted_last_turn) power *= 2;
    } else if (special === "fusion_combo") {
      const previous = String(atkState.previous_team_move || ctx.previous_team_move || "");
      const partner = moveKey === "fusion bolt" ? "fusion flare" : "fusion bolt";
      if (key(previous) === partner) power *= 2;
    } else if (special === "gust_double") {
      const state = String(defState.semi_invulnerable || "").toLowerCase();
      if (["fly", "bounce", "sky drop", "skydrop"].includes(state)) power *= 2;
    } else if (special === "team_successive_power") {
      const uses = Math.max(1, int(ctx.times_used, 1) || 1);
      const increment = Math.max(1, int(meta.successive_increment ?? 40) || 40);
      const base = Math.max(1, int(Number(meta.power ?? power) || power));
      power = Math.min(base + increment * 4, base + increment * (uses - 1));
    } else if (special === "round_combo") {
      if (atkState.round_used_by_ally) power *= 2;
    } else if (special === "pledge_combo") {
      const partner = String(atkState.partner_pledge || "");
      if (partner && key(partner) !== moveKey) power *= 2;
    } else if (special === "spit_up") {
      const stockpile = clamp(int(atkState.stockpile), 0, 3);
      power = stockpile ? 100 * stockpile : 0;
    } else if (special === "trump_card") {
      const remaining = Math.max(1, int(atkState.move_pp_remaining ?? 1) || 1);
      const maximum = Math.max(1, int(meta.pp ?? remaining) || remaining);
      const ratio = remaining / maximum;
      power = ratio <= 0.04 ? 200 : ratio <= 0.10 ? 80 : ratio <= 0.20 ? 60 : ratio <= 0.35 ? 50 : 40;
    } else if (special === "return" || special === "frustration") {
      const happiness = clamp(int(atkState.happiness ?? (special === "return" ? 255 : 0)), 0, 255);
      power = Math.max(1, Math.floor(((special === "return" ? happiness : 255 - happiness) * 10) / 25));
    }
    for (const condition of meta.conditional_power_ops || []) {
      if (!condition || typeof condition !== "object") continue;
      const op = String(condition.op || "");
      const factor = Number(condition.multiplier ?? 2) || 2;
      let triggered = false;
      if (op === "power_if_target_volatile") {
        const wanted = String(condition.volatile || "").toLowerCase();
        const volatile = defState.volatile;
        const set = new Set(typeof volatile === "string" ? [volatile.toLowerCase()] : [...(volatile || [])].map((v) => String(v).toLowerCase()));
        triggered = set.has(wanted) || Boolean(defState[wanted]);
      } else if (op === "power_if_target_state") {
        const wanted = String(condition.state || "").toLowerCase();
        let actual = String(defState.semi_invulnerable || "").toLowerCase();
        actual = { dig: "underground", dive: "underwater", fly: "airborne", bounce: "airborne" }[actual] || actual;
        triggered = actual === wanted;
      } else if (op === "power_if_target_switching") {
        triggered = Boolean(ctx.defender_switching);
      } else if (op === "terrain_power" && moveKey !== "earthquake" && moveKey !== "psyblade") {
        triggered = String(ctx.terrain) === String(condition.terrain || "");
      } else if (op === "weather_power" && moveKey !== "hydrosteam") {
        triggered = String(ctx.weather) === String(condition.weather || "");
      }
      if (triggered) power = Math.max(0, Math.trunc(power * factor));
    }
    const filtered = effectOp(meta, "power_if_target_status");
    if (filtered && moveKey !== "hex" && moveKey !== "infernal parade") {
      const allowed = new Set((filtered.statuses || []).map((v) => String(v).toLowerCase()));
      let status = clean(defender.status).toLowerCase();
      status = { paralyzed: "paralysis", asleep: "sleep", sleeping: "sleep", poisoned: "poison", "badly poisoned": "toxic", burned: "burn" }[status] || status;
      if (status && (allowed.size === 0 || allowed.has(status))) {
        const factor = Number(filtered.multiplier ?? 2) || 2;
        power = Math.max(0, Math.trunc(power * factor));
      }
    }
    return Math.max(0, Math.trunc(power));
  }

  /** v287 attack_defense_values (with v314's Intimidate/White Herb rule). */
  attackDefenseValues(attacker, defender, meta, category, ctx, details) {
    const atkStats = this.finalStats(attacker);
    const defStats = this.finalStats(defender);
    if ((ctx.attacker_state || {}).power_trick) [atkStats.attack, atkStats.defense] = [atkStats.defense, atkStats.attack];
    if ((ctx.defender_state || {}).power_trick) [defStats.attack, defStats.defense] = [defStats.defense, defStats.attack];
    const atkAbility = key(attacker.ability);
    const defAbility = key(defender.ability);
    const atkItem = key(attacker.item);
    const defItem = key(defender.item);
    const moveName = String(meta.name || ctx.move_name);
    const isCritical = Boolean(ctx.critical || meta.always_critical);
    const atkOffsets = intimidateOffsets(defender, attacker);
    const defOffsets = intimidateOffsets(attacker, defender);
    const moldBreaker = MOLD_BREAKERS.has(atkAbility);
    const defenderUnaware = defAbility === "unaware" && !moldBreaker;
    const attackerUnaware = atkAbility === "unaware";

    let attackKey = category === "special" ? "sp_attack" : "attack";
    let attackStageAttr = category === "special" ? "sp_attack_stage" : "attack_stage";
    if (meta.attack_stat === "defense") {
      attackKey = "defense";
      attackStageAttr = "defense_stage";
    }
    let attack;
    if (moveName === "Foul Play" || meta.special === "foul_play") {
      attack = stagedStat(defStats.attack, stageFor(defender, "attack_stage", isCritical, "attacker", false, defOffsets.attack_stage));
    } else {
      attack = stagedStat(atkStats[attackKey], stageFor(attacker, attackStageAttr, isCritical, "attacker", defenderUnaware, atkOffsets[attackStageAttr] || 0));
    }

    let defenseKey = category === "physical" || meta.defense_stat === "defense" ? "defense" : "sp_defense";
    if (ctx.wonder_room) defenseKey = defenseKey === "defense" ? "sp_defense" : "defense";
    const defenseStageAttr = defenseKey === "defense" ? "defense_stage" : "sp_defense_stage";
    const ignoreDefenseStage = Boolean(meta.ignore_defense_stage) || attackerUnaware;
    let defense = stagedStat(defStats[defenseKey], stageFor(defender, defenseStageAttr, isCritical, "defender", ignoreDefenseStage));

    const atkMods = [];
    const defMods = [];
    const status = clean(attacker.status);
    const weather = String(ctx.weather);
    const atkSpecies = speciesKey(attacker);
    const defSpecies = speciesKey(defender);
    const atkState = ctx.attacker_state || {};
    const defState = ctx.defender_state || {};
    const atkTypes = new Set((this.pokemon(attacker.pokemon_name, attacker.form_name).types || []).map(pyTitle));
    const defTypes = new Set((this.pokemon(defender.pokemon_name, defender.form_name).types || []).map(pyTitle));
    void atkTypes;

    if (category === "physical" && attackKey === "attack" && moveName !== "Foul Play") {
      if (atkAbility === "huge power" || atkAbility === "pure power") atkMods.push([attacker.ability, 2.0]);
      if (atkAbility === "hustle") atkMods.push([attacker.ability, 1.5]);
      if (atkAbility === "guts" && status) atkMods.push([attacker.ability, 1.5]);
      if (atkAbility === "gorilla tactics") atkMods.push([attacker.ability, 1.5]);
      if (atkAbility === "toxic boost" && (status === "Poisoned" || status === "Badly Poisoned")) atkMods.push([attacker.ability, 1.5]);
      if (atkAbility === "slow start" && !atkState.slow_start_ended) atkMods.push([attacker.ability, 0.5]);
      if (atkAbility === "orichalcum pulse" && weather === "Sun") atkMods.push([attacker.ability, 4 / 3]);
      if (atkItem === "choice band") atkMods.push([attacker.item, 1.5]);
      if (atkItem === "thick club" && (atkSpecies.includes("cubone") || atkSpecies.includes("marowak"))) atkMods.push([attacker.item, 2.0]);
      if (atkItem === "light ball" && atkSpecies.includes("pikachu")) atkMods.push([attacker.item, 2.0]);
    } else if (category === "special" && attackKey === "sp_attack") {
      if (atkAbility === "solar power" && weather === "Sun") atkMods.push([attacker.ability, 1.5]);
      if (atkAbility === "flare boost" && status === "Burned") atkMods.push([attacker.ability, 1.5]);
      if (atkAbility === "hadron engine" && String(ctx.terrain) === "Electric") atkMods.push([attacker.ability, 4 / 3]);
      if ((atkAbility === "plus" || atkAbility === "minus") && atkState.plus_minus_partner) atkMods.push([attacker.ability, 1.5]);
      if (atkItem === "choice specs") atkMods.push([attacker.item, 1.5]);
      if (atkItem === "light ball" && atkSpecies.includes("pikachu")) atkMods.push([attacker.item, 2.0]);
      if (atkItem === "deep sea tooth" && atkSpecies.includes("clamperl")) atkMods.push([attacker.item, 2.0]);
    }

    if (category === "physical" && defAbility === "tablets of ruin" && !moldBreaker) atkMods.push([defender.ability, 0.75]);
    if (category === "special" && defAbility === "vessel of ruin" && !moldBreaker) atkMods.push([defender.ability, 0.75]);
    if (category === "physical" && defState.tablets_of_ruin) atkMods.push(["Tablets of Ruin", 0.75]);
    if (category === "special" && defState.vessel_of_ruin) atkMods.push(["Vessel of Ruin", 0.75]);

    if (defenseKey === "defense") {
      if (weather === "Snow" && defTypes.has("Ice")) defMods.push(["Snow", 1.5]);
      if (defAbility === "fur coat" && !moldBreaker) defMods.push([defender.ability, 2.0]);
      if (defAbility === "marvel scale" && clean(defender.status) && !moldBreaker) defMods.push([defender.ability, 1.5]);
      if (defAbility === "grass pelt" && String(ctx.terrain) === "Grassy" && !moldBreaker) defMods.push([defender.ability, 1.5]);
      if (atkAbility === "sword of ruin") defMods.push([attacker.ability, 0.75]);
      if (atkState.sword_of_ruin) defMods.push(["Sword of Ruin", 0.75]);
      if (defItem === "metal powder" && defSpecies.includes("ditto")) defMods.push([defender.item, 2.0]);
    } else {
      if (weather === "Sand" && defTypes.has("Rock")) defMods.push(["Sand", 1.5]);
      if (defAbility === "ice scales" && !moldBreaker) defMods.push([defender.ability, 2.0]);
      if (atkAbility === "beads of ruin") defMods.push([attacker.ability, 0.75]);
      if (atkState.beads_of_ruin) defMods.push(["Beads of Ruin", 0.75]);
      if (defItem === "assault vest") defMods.push([defender.item, 1.5]);
      if (defItem === "deep sea scale" && defSpecies.includes("clamperl")) defMods.push([defender.item, 2.0]);
    }
    if (defItem === "eviolite") defMods.push([defender.item, 1.5]);
    if (defAbility === "thick fat" && ["Fire", "Ice"].includes(pyTitle(meta.type || "")) && !moldBreaker) atkMods.push([defender.ability, 0.5]);

    attack = applyChainedModifiers(attack, atkMods);
    defense = applyChainedModifiers(defense, defMods);
    for (const [name, amount] of [...atkMods, ...defMods]) details.push(`${name}: effective stat ×${amount}`);
    return [Math.max(1, Math.trunc(attack)), Math.max(1, Math.trunc(defense))];
  }

  // ---- the calculate chain ----

  calculate(attacker, defender, ctx) {
    // recharge_ko.py
    const result = this._calcV494(attacker, defender, ctx);
    const name = String(ctx.move_name || "");
    result.move_name = name;
    if (RECHARGE_MOVES.has(compact(name))) {
      result.recharge_move = true;
      result.ko = String(result.ko || "").replace(/\b([2-9][0-9]*)HKO\b/g, (m, n) => `KO in ${2 * Number(n) - 1} turns (${n} hits + recharge)`);
    }
    return result;
  }

  _calcV494(attacker, defender, ctx) {
    const result = this._calcV446(attacker, defender, ctx);
    const canonical = this.canonicalMoveName(ctx.move_name);
    result.move_name_v494 = String(canonical || ctx.move_name || "");
    const drop = SELF_DROP_STAGES[clean(canonical || ctx.move_name).toLowerCase()];
    if (drop) result.self_drop_v494 = { stat: drop[0], stages: drop[1] };
    return result;
  }

  _calcV446(attacker, defender, ctx) {
    const meta = this.moveMeta(ctx);
    const special = String(meta.special || "");
    const moveName = String(meta.name || ctx.move_name || "");
    const moveKey = key(moveName);
    const atkState = { ...(ctx.attacker_state || {}) };
    const defState = { ...(ctx.defender_state || {}) };
    const localCtx = { ...ctx };

    if (special === "terrain_pulse" && ["Electric", "Grassy", "Psychic", "Misty"].includes(String(ctx.terrain || "None"))) {
      const atkData = this.pokemon(attacker.pokemon_name, attacker.form_name);
      if (this.isGrounded(attacker, atkData, atkState)) {
        localCtx.move_type_override = { Electric: "Electric", Grassy: "Grass", Psychic: "Psychic", Misty: "Fairy" }[ctx.terrain];
        localCtx.move_power_override = 100;
      }
    }
    if (special === "tera_blast") {
      const teraType = pyTitle(atkState.tera_type || "");
      if (teraType) {
        localCtx.move_type_override = teraType;
        const stats = this.finalStats(attacker);
        const atkValue = stagedStat(stats.attack, int(attacker.attack_stage));
        const spaValue = stagedStat(stats.sp_attack, int(attacker.sp_attack_stage));
        localCtx.move_category_override = atkValue > spaValue ? "physical" : "special";
      }
    }
    if (meta.choose_best_category) {
      const physical = this._calcV445(attacker, defender, { ...localCtx, move_category_override: "physical" });
      const specialResult = this._calcV445(attacker, defender, { ...localCtx, move_category_override: "special" });
      const avg = (r) => (r.rolls || [0]).reduce((s, v) => s + v, 0) / Math.max(1, (r.rolls || [0]).length);
      const chosen = avg(physical) > avg(specialResult) ? physical : specialResult;
      chosen.details = [...(chosen.details || []), `${moveName}: uses ${avg(physical) > avg(specialResult) ? "Physical" : "Special"} because it deals more damage`];
      return chosen;
    }
    if (meta.choose_higher_offense) {
      const stats = this.finalStats(attacker);
      const atkValue = stagedStat(stats.attack, int(attacker.attack_stage));
      const spaValue = stagedStat(stats.sp_attack, int(attacker.sp_attack_stage));
      localCtx.move_category_override = atkValue > spaValue ? "physical" : "special";
    }
    let randomPowers = null;
    let randomDetail = "";
    if (meta.random_power_multiplier) {
      const base = Math.max(1, int(Number(meta.power ?? 1) || 1));
      const factor = Math.max(1.0, Number(meta.random_power_multiplier) || 1);
      randomPowers = [base, Math.max(1, Math.trunc(base * factor))];
      randomDetail = `${moveName}: includes the boosted-power outcome`;
    } else if (special === "magnitude") {
      randomPowers = [10, 30, 50, 70, 90, 110, 150];
      if (["dig", "underground"].includes(String(defState.semi_invulnerable || "").toLowerCase())) randomPowers = randomPowers.map((v) => v * 2);
      randomDetail = "Magnitude: range includes every possible magnitude power";
    } else if (special === "present") {
      randomPowers = [40, 80, 120];
      randomDetail = "Present: damage range excludes the separate 20% healing outcome";
    }
    if (randomPowers) {
      const allRolls = [];
      let template = null;
      for (const power of randomPowers) {
        const candidate = this._calcV445(attacker, defender, { ...localCtx, move_power_override: power });
        if (!template) template = candidate;
        allRolls.push(...(candidate.rolls || []));
      }
      return rewriteRolls(template || {}, allRolls.length ? allRolls : [0], randomDetail);
    }

    let result = this._calcV445(attacker, defender, localCtx);
    const coreRolls = (result.rolls || [0]).map((v) => Math.trunc(v));
    const coreCanHit = Math.max(...(coreRolls.length ? coreRolls : [0])) > 0;
    const currentHp = Math.max(1, int(result.current_hp, 1) || 1);

    if (special === "counter_damage" && coreCanHit) {
      let lastDamage = Math.max(0, int(ctx.last_damage || atkState.last_damage || 0));
      const required = String(meta.counter_category || "any").toLowerCase();
      const received = String(atkState.last_damage_category ?? ctx.last_damage_category ?? "").toLowerCase();
      if (received && !["", "any", received].includes(required)) lastDamage = 0;
      const damage = Math.max(0, Math.floor(lastDamage * (Number(meta.counter_multiplier ?? 1) || 1)));
      return rewriteRolls(result, [damage], `${moveName}: retaliatory damage from ${lastDamage} damage received`);
    }
    if (special === "ohko" && coreCanHit) {
      if (int(defender.level, 50) > int(attacker.level, 50)) return rewriteRolls(result, [0], `${moveName}: fails against a higher-level target`);
      if (moveKey === "sheer cold" && (this.pokemon(defender.pokemon_name, defender.form_name).types || []).includes("Ice")) {
        return rewriteRolls(result, [0], "Sheer Cold: Ice-type targets are immune");
      }
      if (key(defender.ability) === "sturdy") return rewriteRolls(result, [0], "Sturdy blocks one-hit KO moves");
      return rewriteRolls(result, [currentHp], `${moveName}: one-hit KO damage`);
    }
    if (special === "random_level_damage" && coreCanHit) {
      const level = int(attacker.level, 50);
      const low = Math.max(1, Math.floor(level * (Number(meta.level_damage_min ?? 0.5) || 0.5)));
      const high = Math.max(low, Math.floor(level * (Number(meta.level_damage_max ?? 1.5) || 1.5)));
      const rolls = [];
      for (let value = low; value <= high; value += 1) rolls.push(value);
      return rewriteRolls(result, rolls, `${moveName}: level-based random damage`);
    }
    const fraction = Number(meta.fixed_damage_fraction || 0) || 0;
    if (fraction > 0 && coreCanHit) {
      return rewriteRolls(result, [Math.max(1, Math.floor(currentHp * fraction))], `${moveName}: deals ${fraction} of the target's current HP`);
    }
    if (meta.leave_at_one_hp && coreCanHit) {
      const cap = Math.max(0, currentHp - 1);
      result = rewriteRolls(result, coreRolls.map((v) => Math.min(Math.max(0, v), cap)), `${moveName}: cannot reduce the target below 1 HP`);
    }
    if (special === "party_multi_hit" && !atkState.beat_up_attack_values) {
      result.warnings = [...(result.warnings || []), "Exact Beat Up damage needs the usable party members' Attack data"];
    }
    return result;
  }

  _calcV445(attacker, defender, ctx) {
    const localCtx = copyCtx(ctx);
    const targets = localCtx.actual_spread_targets_v445;
    if (targets !== undefined && targets !== null && int(targets) <= 1) localCtx.spread_move = false;
    const abilityKey = key(attacker.ability);
    const chargeSource = abilityKey === "electromorphosis" || abilityKey === "wind power";
    const chargeTriggered = Boolean(localCtx._manual_trigger_attacker_ability_v290 || localCtx.attacker_state.charged_v445 || localCtx.attacker_state.charged || localCtx.charged_v445);
    if (chargeSource && chargeTriggered) {
      localCtx._manual_trigger_attacker_ability_v290 = false;
      localCtx.attacker_state.charged_v445 = true;
      localCtx.charged_v445 = true;
    }
    const result = this._calcV351(attacker, defender, localCtx);
    if (chargeSource && chargeTriggered) {
      const meta = this.moveMeta(localCtx);
      const electricDamage = pyTitle(meta.type || "") === "Electric" && String(meta.category || "status").toLowerCase() !== "status" && Math.max(...(result.rolls || [0])) > 0;
      result.charged_state_active = true;
      result.charged_source = String(attacker.ability || "Charge");
      result.charged_consumed = electricDamage;
    }
    return result;
  }

  _calcV351(attacker, defender, ctx) {
    const result = this._calcV314(attacker, defender, ctx);
    const basePercent = String(result.percent || "");
    const recoilPercent = String(result.recoil_percent || "");
    if (basePercent) {
      const spacedBase = basePercent.replace(/(\d)-(?=\d)/, "$1 - ");
      if (recoilPercent) {
        const spacedRecoil = recoilPercent.replace(/(\d)-(?=\d)/, "$1 - ");
        result.display_percent = `${spacedBase} (${spacedRecoil} recoil)`;
      } else {
        result.display_percent = spacedBase;
      }
    }
    return result;
  }

  _calcV314(attacker, defender, ctx) {
    const localCtx = copyCtx(ctx);
    const disabled = new Set(ctx._disabled_effects_v290 || []);
    const triggers = (mon, other, role, otherRole) => {
      if (disabled.has(`${role}:ability`) || disabled.has(`${role}:item`) || disabled.has(`${otherRole}:ability`)) return false;
      return key(mon.ability) === "unburden" && key(mon.item) === "white herb" && key(other.ability) === "intimidate";
    };
    const attackerTriggered = triggers(attacker, defender, "attacker", "defender");
    const defenderTriggered = triggers(defender, attacker, "defender", "attacker");
    const calcAttacker = cloneMon(attacker);
    const calcDefender = cloneMon(defender);
    const triggered = [];
    if (attackerTriggered) {
      localCtx.attacker_state.unburden = true;
      calcAttacker.item = "";
      calcAttacker._white_herb_restored_v314 = true;
      triggered.push(`${attacker.pokemon_name}'s White Herb restores Intimidate; the consumed item activates Unburden`);
    }
    if (defenderTriggered) {
      localCtx.defender_state.unburden = true;
      calcDefender.item = "";
      calcDefender._white_herb_restored_v314 = true;
      triggered.push(`${defender.pokemon_name}'s White Herb restores Intimidate; the consumed item activates Unburden`);
    }
    const result = this._calcV297(calcAttacker, calcDefender, localCtx);
    const speedAttacker = cloneMon(calcAttacker);
    const speedDefender = cloneMon(calcDefender);
    if (disabled.has("attacker:ability")) speedAttacker.ability = "";
    if (disabled.has("attacker:item")) speedAttacker.item = "";
    if (disabled.has("defender:ability")) speedDefender.ability = "";
    if (disabled.has("defender:item")) speedDefender.item = "";
    const attackerSpeed = Math.trunc(this.effectiveSpeed(speedAttacker, localCtx.attacker_state));
    const defenderSpeed = Math.trunc(this.effectiveSpeed(speedDefender, localCtx.defender_state));
    result.attacker_speed = attackerSpeed;
    result.defender_speed = defenderSpeed;
    result.speed_tie = attackerSpeed === defenderSpeed;
    if (triggered.length) result.details = [...(result.details || []), ...triggered];
    return result;
  }

  _calcV297(attacker, defender, ctx) {
    return this._calcV290(this.effectiveMegaMon(attacker), this.effectiveMegaMon(defender), ctx);
  }

  _calcV290(attacker, defender, ctx) {
    const localCtx = copyCtx(ctx);
    const disabled = new Set(ctx._disabled_effects_v290 || []);
    const atk = cloneMon(attacker);
    const dfn = cloneMon(defender);
    if (disabled.has("attacker:ability")) atk.ability = "";
    if (disabled.has("defender:ability")) dfn.ability = "";
    if (disabled.has("attacker:item")) atk.item = "";
    if (disabled.has("defender:item")) dfn.item = "";
    const atkAbility = key(atk.ability);
    const defAbility = key(dfn.ability);
    const manuallyTriggered = Boolean(localCtx._manual_trigger_attacker_ability_v290);
    const opposingIntimidate = defAbility === "intimidate";
    const triggerDetails = [];

    if (manuallyTriggered) {
      const changes = MANUAL_STAGE_CHANGES[atkAbility] || {};
      for (const [attr, change] of Object.entries(changes)) atk[attr] = clamp(int(atk[attr]) + change, -6, 6);
      if (atkAbility === "beast boost") {
        const stats = this.finalStats(atk);
        const order = ["attack", "defense", "sp_attack", "sp_defense", "speed"];
        let best = order[0];
        for (const statKey of order) if (int(stats[statKey]) > int(stats[best])) best = statKey;
        atk[`${best}_stage`] = Math.min(6, int(atk[`${best}_stage`]) + 1);
        triggerDetails.push(`${atk.ability} manually triggered`);
      } else if (atkAbility === "download") {
        const defStats = this.finalStats(dfn);
        const attr = int(defStats.defense) < int(defStats.sp_defense) ? "attack_stage" : "sp_attack_stage";
        atk[attr] = Math.min(6, int(atk[attr]) + 1);
      }
      if (atkAbility === "flash fire") localCtx.attacker_state.flash_fire = true;
    }
    if (manuallyTriggered && !opposingIntimidate) {
      if (atkAbility === "defiant" || atkAbility === "guard dog") atk.attack_stage = Math.min(6, int(atk.attack_stage) + 2);
      else if (atkAbility === "competitive") atk.sp_attack_stage = Math.min(6, int(atk.sp_attack_stage) + 2);
    }
    if (manuallyTriggered && (atkAbility === "electromorphosis" || atkAbility === "wind power")) {
      const meta = this.moveMeta(localCtx);
      if (pyTitle(meta.type || "") === "Electric" && int(meta.power) > 0) localCtx.move_power_override = int(meta.power) * 2;
    }

    const result = this._calcV289(atk, dfn, localCtx);
    if (triggerDetails.length) result.details = [...(result.details || []), ...triggerDetails];
    if (key(dfn.item) === "sitrus berry") {
      const maximum = Math.max(1, int(result.max_hp) || this.finalStats(dfn).hp || 1);
      result.sitrus_berry_active = true;
      result.sitrus_heal = Math.max(1, floorDiv(maximum, 4));
    }
    return result;
  }

  _calcV289(attacker, defender, ctx) {
    const out = this._calcV287(attacker, defender, ctx);
    const baseDisplay = String(out.percent || "0-0%").replace(/(\d)-(?=\d)/, "$1 - ");
    const rolls = (out.rolls || []).map((v) => Math.max(0, Math.trunc(v)));
    if (!rolls.length || Math.max(...rolls) <= 0) {
      out.display_percent = baseDisplay;
      return out;
    }
    const meta = this.moveMeta(ctx);
    const moveName = String(meta.name || ctx.move_name || "");
    const flags = new Set((meta.flags || []).map((f) => String(f).toLowerCase()));
    const ability = key(attacker.ability);
    const item = key(attacker.item);
    const maxHp = Math.max(1, int(this.finalStats(attacker).hp, 1));
    const targetHp = Math.max(1, int(out.current_hp) || int(out.max_hp) || 1);
    let fixedRecoil = 0;
    let variable = rolls.map(() => 0);
    if (moveName === "Struggle") {
      fixedRecoil += Math.max(1, Math.floor(maxHp / 4));
    } else if (ability !== "magic guard") {
      const maxHpFraction = "recoil_max_hp_fraction" in meta ? meta.recoil_max_hp_fraction : MAX_HP_RECOIL_FRACTIONS[moveName];
      if (maxHpFraction !== undefined && maxHpFraction !== null) fixedRecoil += Math.max(1, Math.ceil(maxHp * Number(maxHpFraction)));
      let damageFraction = "recoil_fraction" in meta ? meta.recoil_fraction : DAMAGE_RECOIL_FRACTIONS[moveName];
      if ((damageFraction === undefined || damageFraction === null) && flags.has("recoil")) damageFraction = 1 / 3;
      if (damageFraction !== undefined && damageFraction !== null && ability !== "rock head") {
        const f = Math.max(0, Number(damageFraction));
        variable = rolls.map((damage) => (damage > 0 ? Math.max(1, Math.floor(Math.min(targetHp, damage) * f)) : 0));
      }
      const sheerForceSuppresses = ability === "sheer force" && flags.has("secondary");
      if (item === "life orb" && !sheerForceSuppresses) fixedRecoil += Math.max(1, Math.floor(maxHp / 10));
    }
    const recoilRolls = variable.map((v) => fixedRecoil + v);
    const lo = Math.min(...recoilRolls);
    const hi = Math.max(...recoilRolls);
    if (hi <= 0) {
      out.display_percent = baseDisplay;
      return out;
    }
    const loText = displayPercent(lo, maxHp);
    const hiText = displayPercent(hi, maxHp);
    const recoilPercent = lo === hi ? `${loText}%` : `${loText}-${hiText}%`;
    out.recoil_hp_range = `${lo}-${hi}`;
    out.recoil_percent = recoilPercent;
    out.recoil_text = `${recoilPercent} recoil`;
    out.display_percent = `${baseDisplay} (${out.recoil_text})`;
    return out;
  }

  /** v287 — the damage formula. */
  _calcV287(attacker, defender, ctx) {
    const atkData = this.pokemon(attacker.pokemon_name, attacker.form_name);
    const defData = this.pokemon(defender.pokemon_name, defender.form_name);
    const meta = this.moveMeta(ctx);
    const details = [];
    const warnings = [];
    const moveName = String(meta.name || ctx.move_name);
    const category = String(meta.category || "status").toLowerCase();
    const atkState = { ...(ctx.attacker_state || {}) };
    const defState = { ...(ctx.defender_state || {}) };
    if (ctx.gravity) {
      atkState.gravity = true;
      defState.gravity = true;
    }
    let weather = String(ctx.weather);
    if (["air lock", "cloud nine"].includes(key(attacker.ability)) || ["air lock", "cloud nine"].includes(key(defender.ability))) weather = "None";
    if (key(attacker.item) === "utility umbrella" || key(defender.item) === "utility umbrella") weather = "None";
    const weatherCtx = { ...ctx, weather };
    let moveType = this.modifiedMoveType(attacker, pyTitle(meta.type || "Normal"), meta, details);
    meta.type = moveType;
    const maxHp = Math.max(1, int(this.finalStats(defender).hp, 1));
    const currentHp = this.hazardAdjustedHp(defender, defData, weatherCtx, maxHp, defState, details);
    const rawPower = this.modifiedPower(attacker, defender, weatherCtx, meta, atkState, defState, details, warnings);
    moveType = pyTitle(meta.type || moveType);

    const bare = (reason) => resultRecord(attacker, defender, moveName, [0], maxHp, currentHp, [reason], warnings);
    if (category === "status" || rawPower <= 0) return resultRecord(attacker, defender, moveName, [0], maxHp, currentHp, ["Status/no-power move.", ...details], warnings);

    const flags = new Set((meta.flags || []).map((f) => String(f).toLowerCase()));
    const atkAbility = key(attacker.ability);
    const defAbility = key(defender.ability);
    const atkItem = key(attacker.item);
    const defItem = key(defender.item);
    if (atkAbility === "long reach" || (atkItem === "punching glove" && flags.has("punch"))) flags.delete("contact");
    const moldBreaker = MOLD_BREAKERS.has(atkAbility);
    const groundedAttacker = this.isGrounded(attacker, atkData, atkState);
    const groundedDefender = this.isGrounded(defender, defData, defState);
    const critical = Boolean(ctx.critical || (meta.always_critical && !ctx._mcts_ignore_guaranteed_crit));

    if (ctx.protect && !(atkAbility === "unseen fist" && flags.has("contact"))) return bare("Protect blocks the move.");
    const blocked = this.abilityBlocksDamage(attacker, defender, moveType, meta);
    if (blocked) return bare(`${blocked} grants immunity.`);
    if (moveType === "Ground" && !groundedDefender && !meta.hits_airborne) return bare("Target is airborne and immune to Ground.");
    const priority = int(meta.priority);
    if (priority > 0 && groundedDefender && String(ctx.terrain) === "Psychic") return bare("Psychic Terrain blocks priority.");
    if (priority > 0 && ["armor tail", "dazzling", "queenly majesty"].includes(defAbility) && !moldBreaker) return bare(`${defender.ability} blocks priority.`);

    let eff = this.typeEffectiveness(moveName, moveType, attacker, defender, defData);
    if (meta.dual_type) eff *= this.typeMultiplier(String(meta.dual_type), defData.types);
    if (eff === 0) return bare("Type immunity.");
    if (defAbility === "wonder guard" && eff <= 1 && !moldBreaker) return bare("Wonder Guard blocks non-super-effective damage.");

    const fixed = meta.fixed_damage;
    if (fixed) {
      let damage;
      if (fixed === "level") damage = Math.max(1, int(attacker.level, 50));
      else if (fixed === "half_current_hp") damage = Math.max(1, floorDiv(currentHp, 2));
      else if (fixed === "attacker_current_hp") {
        const atkMax = Math.max(1, int(this.finalStats(attacker).hp, 1));
        damage = Math.max(1, Math.ceil((atkMax * clamp(int(attacker.current_hp_percent, 100), 1, 100)) / 100));
      } else if (fixed === "endeavor") {
        const atkMax = Math.max(1, int(this.finalStats(attacker).hp, 1));
        const atkHp = Math.max(1, Math.ceil((atkMax * clamp(int(attacker.current_hp_percent, 100), 1, 100)) / 100));
        damage = Math.max(0, currentHp - atkHp);
      } else damage = Math.max(0, int(fixed));
      return resultRecord(attacker, defender, moveName, [damage], maxHp, currentHp, details, warnings);
    }

    const powerMods = [];
    const doubles = String(ctx.battle_format).toLowerCase() === "doubles";
    const terrain = String(ctx.terrain);
    if (ctx.helping_hand && doubles) powerMods.push(["Helping Hand", 1.5]);
    if (terrain === "Electric" && moveType === "Electric" && groundedAttacker) powerMods.push(["Electric Terrain", 1.3]);
    if (terrain === "Grassy" && moveType === "Grass" && groundedAttacker) powerMods.push(["Grassy Terrain", 1.3]);
    if (terrain === "Psychic" && moveType === "Psychic" && groundedAttacker) powerMods.push(["Psychic Terrain", 1.3]);
    if (terrain === "Grassy" && ["Earthquake", "Bulldoze", "Magnitude"].includes(moveName) && groundedDefender) powerMods.push(["Grassy Terrain", 0.5]);
    if (atkItem === "normal gem" && moveType === "Normal") powerMods.push([attacker.item, 1.3]);
    const typeBoost = TYPE_BOOST_ITEMS[atkItem];
    if (typeBoost && typeBoost[0] === moveType) powerMods.push([attacker.item, typeBoost[1]]);
    if (ORB_BOOSTS[atkItem] && ORB_BOOSTS[atkItem].includes(moveType)) powerMods.push([attacker.item, 1.2]);
    const atkSpeciesKey = speciesKey(attacker);
    if (atkItem === "soul dew" && (atkSpeciesKey.includes("latios") || atkSpeciesKey.includes("latias")) && (moveType === "Psychic" || moveType === "Dragon")) powerMods.push([attacker.item, 1.2]);
    if (atkItem === "muscle band" && category === "physical") powerMods.push([attacker.item, 1.1]);
    if (atkItem === "wise glasses" && category === "special") powerMods.push([attacker.item, 1.1]);
    if (atkItem === "punching glove" && flags.has("punch")) powerMods.push([attacker.item, 1.1]);
    if (atkItem === "metronome") powerMods.push([attacker.item, Math.min(2.0, 1.0 + 0.2 * Math.max(0, (int(ctx.times_used, 1) || 1) - 1))]);
    if (PINCH_ABILITIES[atkAbility] && moveType === PINCH_ABILITIES[atkAbility] && int(attacker.current_hp_percent, 100) <= 33) powerMods.push([attacker.ability, 1.5]);
    if (meta._ate_converted) powerMods.push([attacker.ability, 1.2]);
    if (meta._normalize_converted) powerMods.push([attacker.ability, 1.2]);
    if (atkAbility === "tough claws" && flags.has("contact")) powerMods.push([attacker.ability, 1.3]);
    if (atkAbility === "iron fist" && flags.has("punch")) powerMods.push([attacker.ability, 1.2]);
    if (atkAbility === "strong jaw" && flags.has("bite")) powerMods.push([attacker.ability, 1.5]);
    if (atkAbility === "mega launcher" && (flags.has("pulse") || flags.has("aura"))) powerMods.push([attacker.ability, 1.5]);
    if (atkAbility === "sharpness" && flags.has("slicing")) powerMods.push([attacker.ability, 1.5]);
    if (atkAbility === "reckless" && (flags.has("recoil") || flags.has("crash"))) powerMods.push([attacker.ability, 1.2]);
    if (atkAbility === "punk rock" && flags.has("sound")) powerMods.push([attacker.ability, 1.3]);
    if (atkAbility === "technician" && rawPower <= 60) powerMods.push([attacker.ability, 1.5]);
    if (atkAbility === "sheer force" && flags.has("secondary")) powerMods.push([attacker.ability, 1.3]);
    if (atkAbility === "sand force" && weather === "Sand" && ["Rock", "Ground", "Steel"].includes(moveType)) powerMods.push([attacker.ability, 1.3]);
    if (atkAbility === "steelworker" && moveType === "Steel") powerMods.push([attacker.ability, 1.5]);
    if (atkAbility === "rocky payload" && moveType === "Rock") powerMods.push([attacker.ability, 1.5]);
    if (atkAbility === "transistor" && moveType === "Electric") powerMods.push([attacker.ability, 1.3]);
    if (atkAbility === "dragon's maw" && moveType === "Dragon") powerMods.push([attacker.ability, 1.5]);
    if (atkAbility === "water bubble" && moveType === "Water") powerMods.push([attacker.ability, 2.0]);
    if (atkAbility === "rivalry") {
      const a = String(attacker.gender);
      const d = String(defender.gender);
      if (["Male", "Female"].includes(a) && ["Male", "Female"].includes(d)) powerMods.push([attacker.ability, a === d ? 1.25 : 0.75]);
    }
    if (atkAbility === "analytic" && !ctx.attacker_moved_first) powerMods.push([attacker.ability, 1.3]);
    if (atkAbility === "stakeout" && ctx.defender_switching) powerMods.push([attacker.ability, 2.0]);
    if (atkAbility === "flash fire" && atkState.flash_fire && moveType === "Fire") powerMods.push([attacker.ability, 1.5]);
    if (atkAbility === "supreme overlord") powerMods.push([attacker.ability, 1.0 + 0.1 * clampFaintedAllies(ctx.fainted_allies, ctx.battle_format || "Doubles")]);
    if (atkState.battery && category === "special") powerMods.push(["Battery", 1.3]);
    if (atkState.power_spot) powerMods.push(["Power Spot", 1.3]);
    if (atkState.steely_spirit && moveType === "Steel") powerMods.push(["Steely Spirit", 1.5]);

    const [attack, defense] = this.attackDefenseValues(attacker, defender, meta, category, ctx, details);
    const levelFactor = Math.floor((2 * int(attacker.level, 50)) / 5) + 2;
    const hits = hitCount(attacker, meta, ctx);
    let rawHitPowers = Array(hits).fill(rawPower);
    if (String(meta.special) === "triple_axel") rawHitPowers = [20, 40, 60].slice(0, hits);
    if (String(meta.special) === "triple_kick") rawHitPowers = [10, 20, 30].slice(0, hits);
    let hitFinalScales = rawHitPowers.map(() => 1.0);
    if (atkAbility === "parental bond" && hits === 1 && !ctx._mcts_single_hit) {
      rawHitPowers = [rawPower, rawPower];
      hitFinalScales = [1.0, 0.25];
    }

    const generalMods = [];
    if ((meta.spread || ctx.spread_move) && doubles) generalMods.push(["Spread move", 0.75]);
    if (weather === "Sun" && moveType === "Fire") generalMods.push(["Sun", 1.5]);
    else if (weather === "Sun" && moveType === "Water") generalMods.push(["Sun", String(meta.special) === "hydro_steam" ? 1.5 : 0.5]);
    else if (weather === "Rain" && moveType === "Water") generalMods.push(["Rain", 1.5]);
    else if (weather === "Rain" && moveType === "Fire") generalMods.push(["Rain", 0.5]);
    if (critical) generalMods.push(["Critical", 1.5]);

    const hasStab = (atkData.types || []).includes(moveType) || atkAbility === "protean" || atkAbility === "libero";
    const stab = hasStab && atkAbility === "adaptability" ? 2.0 : hasStab ? 1.5 : 1.0;
    const burned = clean(attacker.status) === "Burned" || Boolean(ctx.burned);
    const burnMod = category === "physical" && burned && atkAbility !== "guts" && moveName !== "Facade";
    const finalMods = [];
    if (atkAbility !== "infiltrator" && !critical) {
      const screen = (category === "physical" && ctx.reflect) || (category === "special" && ctx.light_screen) || ctx.aurora_veil;
      if (screen) finalMods.push(["Screen/Aurora Veil", doubles ? 2 / 3 : 0.5]);
    }
    if (terrain === "Misty" && moveType === "Dragon" && groundedDefender) finalMods.push(["Misty Terrain", 0.5]);
    if (atkAbility === "neuroforce" && eff > 1) finalMods.push([attacker.ability, 1.25]);
    if (critical && atkAbility === "sniper") finalMods.push([attacker.ability, 1.5]);
    if (atkAbility === "tinted lens" && eff < 1) finalMods.push([attacker.ability, 2.0]);
    if (String(meta.special) === "super_effective_boost" && eff > 1) finalMods.push([moveName, 4 / 3]);
    const fullHp = currentHp >= maxHp;
    if ((defAbility === "multiscale" || defAbility === "shadow shield") && fullHp && !moldBreaker) finalMods.push([defender.ability, 0.5]);
    if (defAbility === "fluffy" && flags.has("contact") && !moldBreaker) finalMods.push([defender.ability, 0.5]);
    if (defAbility === "fluffy" && moveType === "Fire" && !moldBreaker) finalMods.push([defender.ability, 2.0]);
    if (["filter", "solid rock", "prism armor"].includes(defAbility) && eff > 1 && !moldBreaker) finalMods.push([defender.ability, 0.75]);
    if (defAbility === "punk rock" && flags.has("sound") && !moldBreaker) finalMods.push([defender.ability, 0.5]);
    if (defAbility === "purifying salt" && moveType === "Ghost" && !moldBreaker) finalMods.push([defender.ability, 0.5]);
    if ((defAbility === "heatproof" || defAbility === "water bubble") && moveType === "Fire" && !moldBreaker) finalMods.push([defender.ability, 0.5]);
    if (defAbility === "dry skin" && moveType === "Fire" && !moldBreaker) finalMods.push([defender.ability, 1.25]);
    if (ctx.friend_guard && doubles) finalMods.push(["Friend Guard", 0.75]);
    if (atkItem === "expert belt" && eff > 1) finalMods.push([attacker.item, 1.2]);
    if (atkItem === "life orb") finalMods.push([attacker.item, 1.3]);
    const berryType = RESIST_BERRIES[defItem];
    if (berryType === moveType && (eff > 1 || berryType === "Normal")) finalMods.push([defender.item, 0.5]);

    const totals = Array(16).fill(0);
    rawHitPowers.forEach((hitPower, h) => {
      const hitScale = hitFinalScales[h];
      const power = Math.max(1, applyChainedModifiers(hitPower, powerMods));
      const base = Math.max(1, Math.floor(Math.floor((levelFactor * power * attack) / Math.max(1, defense)) / 50) + 2);
      for (let index = 0; index < 16; index += 1) {
        const randomRoll = 85 + index;
        let damage = base;
        for (const [, modifier] of generalMods) damage = applyDamageModifier(damage, modifier);
        damage = Math.floor((damage * randomRoll) / 100);
        if (stab !== 1.0) damage = applyDamageModifier(damage, stab);
        damage = Math.floor(damage * eff);
        if (burnMod) damage = applyDamageModifier(damage, 0.5);
        if (finalMods.length) damage = applyChainedModifiers(damage, finalMods);
        if (hitScale !== 1.0) damage = applyDamageModifier(damage, hitScale);
        totals[index] += Math.max(1, Math.trunc(damage));
      }
    });

    let accuracyPercent = 100.0;
    if (ctx.use_move_accuracies_v47 !== false) accuracyPercent = this.moveAccuracyPercent(moveName, ctx);
    const result = resultRecord(
      attacker, defender, moveName, totals, maxHp, currentHp,
      [`Move: ${moveName} / ${moveType} / ${pyTitle(category)}`, `Attack used: ${attack}`, `Defense used: ${defense}`, `Hits: ${rawHitPowers.length}`, ...details],
      warnings,
      { hit_count: rawHitPowers.length, move_accuracy_percent: accuracyPercent, move_accuracy_factor: clamp(accuracyPercent / 100, 0, 1) },
    );
    if (fullHp && rawHitPowers.length === 1 && defItem === "focus sash" && Math.max(...totals) >= currentHp) {
      result.ko = "Focus Sash prevents an OHKO from full HP";
      result.focus_sash_active = true;
    }
    if (fullHp && rawHitPowers.length === 1 && defAbility === "sturdy" && !moldBreaker && Math.max(...totals) >= currentHp) {
      result.ko = "Sturdy prevents an OHKO from full HP";
      result.sturdy_active = true;
    }
    if (ctx.salt_cure) {
      const types = defData.types || [];
      result.ko += ` | Salt Cure: ${types.includes("Steel") || types.includes("Water") ? "1/4" : "1/8"} max HP/turn`;
    }
    return result;
  }
}

// --- module-level helpers used by the chain --------------------------------

function effectOp(meta, opName) {
  for (const value of meta.effect_script || []) {
    if (value && typeof value === "object" && String(value.op || "") === opName) return value;
  }
  return null;
}

function speciesKey(mon) {
  return `${mon.pokemon_name} ${mon.form_name}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stageFor(mon, attr, critical, side, ignore = false, offset = 0) {
  if (ignore) return 0;
  let stage = clamp(int(mon[attr]) + int(offset), -6, 6);
  if (key(mon.ability) === "simple") stage = clamp(stage * 2, -6, 6);
  if (critical && side === "attacker" && stage < 0) stage = 0;
  if (critical && side === "defender" && stage > 0) stage = 0;
  return stage;
}

// Exported for the Tournament Test, which applies Intimidate once on entry instead of per calc.
export function intimidateOffsets(source, target) {
  const offsets = { attack_stage: 0, sp_attack_stage: 0 };
  if (key(source.ability) !== "intimidate") return offsets;
  if (target._white_herb_restored_v314) return offsets;
  const targetAbility = key(target.ability);
  if (INTIMIDATE_BLOCKERS.has(targetAbility) || key(target.item) === "white herb") return offsets;
  offsets.attack_stage = -1;
  if (targetAbility === "defiant") offsets.attack_stage += 2;
  if (targetAbility === "competitive") offsets.sp_attack_stage += 2;
  return offsets;
}

function hitCount(attacker, meta, ctx) {
  const requested = int(ctx.hits);
  if (requested > 0) return clamp(requested, 1, 10);
  if (meta.hits) return clamp(int(meta.hits), 1, 10);
  const range = meta.hit_range;
  if (Array.isArray(range) && range.length >= 2) {
    if (key(attacker.ability) === "skill link") return int(range[1]);
    if (key(attacker.item) === "loaded dice") return Math.max(int(range[0]), int(range[1]) - 1);
    return 3;
  }
  return 1;
}

function percentFloor(value, maximum) {
  const number = Math.floor((Math.max(0, Math.trunc(value)) * 1000) / Math.max(1, Math.trunc(maximum))) / 10;
  return stripZeros(pyFixed(number, 1));
}

function displayPercent(value, maximum) {
  const number = pyRound((Math.max(0, Math.trunc(value)) * 1000) / Math.max(1, Math.trunc(maximum))) / 10;
  return stripZeros(pyFixed(number, 1));
}

export function koText(rolls, hp) {
  rolls = rolls.map((v) => Math.max(0, Math.trunc(v)));
  if (!rolls.length || Math.max(...rolls) <= 0) return "No direct damage.";
  const ohko = rolls.filter((v) => v >= hp).length;
  if (ohko === rolls.length) return "Guaranteed OHKO";
  if (ohko) return `${pyFixed((ohko / rolls.length) * 100, 1)}% chance to OHKO`;
  let pairs = 0;
  for (const a of rolls) for (const b of rolls) if (a + b >= hp) pairs += 1;
  const total = rolls.length ** 2;
  if (pairs === total) return "Guaranteed 2HKO";
  if (pairs) return `${pyFixed((pairs / total) * 100, 1)}% chance to 2HKO`;
  return "No guaranteed 2HKO from raw damage";
}

function resultRecord(attacker, defender, moveName, rolls, maxHp, currentHp, details, warnings, extra = null) {
  rolls = (rolls && rolls.length ? rolls : [0]).map((v) => Math.max(0, Math.trunc(v)));
  const lo = Math.min(...rolls);
  const hi = Math.max(...rolls);
  const pctLo = percentFloor(lo, maxHp);
  const pctHi = percentFloor(hi, maxHp);
  const result = {
    summary: `${attacker.pokemon_name} ${moveName} vs. ${defender.pokemon_name}: ${lo}-${hi} (${pctLo}-${pctHi}%)`,
    range: `${lo}-${hi}`,
    percent: `${pctLo}-${pctHi}%`,
    rolls,
    ko: koText(rolls, currentHp),
    details: [...(details || [])],
    warnings: [...(warnings || [])],
    current_hp: Math.trunc(currentHp),
    max_hp: Math.trunc(maxHp),
    random_rolls_visible: false,
  };
  if (extra) Object.assign(result, extra);
  return result;
}

function rewriteRolls(result, rolls, detail = "") {
  const out = { ...result };
  const cleanRolls = (rolls && rolls.length ? rolls : [0]).map((v) => Math.max(0, Math.trunc(v)));
  const currentHp = Math.max(1, int(out.current_hp, 1) || 1);
  const maxHp = Math.max(1, int(out.max_hp, currentHp) || currentHp);
  const lo = Math.min(...cleanRolls);
  const hi = Math.max(...cleanRolls);
  const loText = stripZeros(pyFixed(pyRound((lo * 1000) / maxHp) / 10, 1));
  const hiText = stripZeros(pyFixed(pyRound((hi * 1000) / maxHp) / 10, 1));
  out.range = `${lo}-${hi}`;
  out.percent = `${loText}-${hiText}%`;
  out.rolls = cleanRolls;
  out.ko = koText(cleanRolls, currentHp);
  const summary = String(out.summary || "");
  if (summary.includes(":")) out.summary = `${summary.split(":")[0]}: ${lo}-${hi} (${loText}-${hiText}%)`;
  if (detail) out.details = [...(out.details || []), detail];
  return out;
}

// Read-only tables for Optimize (builder/optimize-deep.js): recoil and self-lowering moves.
export { DAMAGE_RECOIL_FRACTIONS, MAX_HP_RECOIL_FRACTIONS, SELF_DROP_STAGES };
