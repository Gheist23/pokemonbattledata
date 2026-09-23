// Team Evaluation, ported from the Companion app's TeamAnalysisPanel.
//
// The app's evaluation is a stack of override layers (best_attack_result alone
// is twelve deep). This file follows the *final* behaviour of each layer, with
// the app function it mirrors named in a comment, and is checked against
// results recorded from the app itself (tests/run-eval-vectors.mjs). Where the
// app and this file disagree, the app is the reference.

import { DamageEngine, PINCH_ABILITIES, applyChainedModifiers, compact, key as engineKey, makeContext, makeMon, pyTitle } from "./engine.js";
import { PAIRED_SPREADS, pairedOption, pointsForNature } from "./nature-spreads.js";

// --- settings (TEAM_ANALYSIS_DEFAULT_SETTINGS_V35 after every override) ---------

export const STAT_DISTRIBUTION_OPTIONS = [
  "Don't use Stats Distributions",
  "Use most common Stat Distribution",
  "Use 2 most common Stat Distributions",
  "Use 3 most common Stat Distributions",
];
export const STAT_DISTRIBUTION_LIMITS = {
  "Don't use Stats Distributions": 0,
  "Use most common Stat Distribution": 1,
  "Use 2 most common Stat Distributions": 2,
  "Use 3 most common Stat Distributions": 3,
};

export const DEFAULT_SETTINGS = Object.freeze({
  top_meta: 20,
  calc_item_limit: 3,
  calc_move_limit: 6,
  threat_stat_distributions: "Use most common Stat Distribution",
  use_move_accuracies: true,
  use_weather_abilities: true,
  ignore_weather_abilities: false,
  use_other_abilities: true,
  ignore_other_abilities: false,
  use_held_items: true,
  ignore_held_items: false,
  use_speed_tiers: true,
  weather: "None",
  terrain: "None",
  trick_room: false,
  tailwind: "None",
  reflect: "None",
  light_screen: "None",
  exclude_moves: "",
  exclude_abilities: "",
  exclude_pokemon: "",
  my_stages: "",
  threat_stages: "",
});

const SIDES = ["None", "My Team", "Threat Team", "Both"];

/** _v35_copy_settings (final): defaults, clamps and the use/ignore pairs. */
export function normalizeSettings(raw = {}, topMetaCap = 1000) {
  const out = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const clampInt = (value, fallback, low, high) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n ? Math.max(low, Math.min(high, n)) : fallback;
  };
  out.top_meta = clampInt(out.top_meta, 20, 1, Math.max(1, topMetaCap));
  out.calc_item_limit = clampInt(out.calc_item_limit, 3, 1, 5);
  out.calc_move_limit = clampInt(out.calc_move_limit, 6, 1, 10);
  if (!(out.threat_stat_distributions in STAT_DISTRIBUTION_LIMITS)) out.threat_stat_distributions = DEFAULT_SETTINGS.threat_stat_distributions;
  for (const [use, ignore] of [["use_weather_abilities", "ignore_weather_abilities"], ["use_other_abilities", "ignore_other_abilities"], ["use_held_items", "ignore_held_items"]]) {
    const enabled = raw && use in raw ? Boolean(raw[use]) : !(raw && raw[ignore]);
    out[use] = enabled;
    out[ignore] = !enabled;
  }
  out.use_move_accuracies = Boolean(out.use_move_accuracies);
  out.use_speed_tiers = Boolean(out.use_speed_tiers);
  out.trick_room = Boolean(out.trick_room);
  // A value saved by an older version (or typed into storage) falls back to "None".
  if (!["None", "Sun", "Rain", "Sand", "Snow"].includes(out.weather)) out.weather = "None";
  if (!["None", "Electric", "Grassy", "Psychic", "Misty"].includes(out.terrain)) out.terrain = "None";
  for (const field of ["tailwind", "reflect", "light_screen"]) out[field] = SIDES.includes(out[field]) ? out[field] : "None";
  for (const field of ["exclude_moves", "exclude_abilities", "exclude_pokemon", "my_stages", "threat_stages"]) out[field] = String(out[field] || "");
  return out;
}

/** _v35_csv_tokens */
export function csvTokens(text) {
  return new Set(String(text || "").split(/[,;\n]+/).map((t) => t.trim().toLowerCase()).filter(Boolean));
}

// --- small helpers ---------------------------------------------------------------

const RECHARGE_MOVES = new Set(["hyper beam", "giga impact", "frenzy plant", "blast burn", "hydro cannon", "rock wrecker", "roar of time", "prismatic laser", "eternabeam", "meteor assault"]);
const SELF_KO_MOVES = new Set(["explosion", "selfdestruct", "mistyexplosion", "finalgambit"]);
const SPEED_WEATHER_ABILITIES = { chlorophyll: ["Chlorophyll", "Sun"], "swift swim": ["Swift Swim", "Rain"], "sand rush": ["Sand Rush", "Sand"], "slush rush": ["Slush Rush", "Snow"] };
const WEATHER_SETTERS = { drizzle: "Rain", drought: "Sun", sandstream: "Sand", snowwarning: "Snow", frostwarning: "Snow", desolateland: "Sun", primordialsea: "Rain", deltastream: "Strong Winds", orichalcumpulse: "Sun" };
const TERRAIN_SETTERS = { electricsurge: "Electric", grassysurge: "Grassy", psychicsurge: "Psychic", mistysurge: "Misty", hadronengine: "Electric" };
const MANUAL_DAMAGE_ABILITIES = new Set(["anger shell", "beast boost", "berserk", "chilling neigh", "competitive", "defiant", "download", "electromorphosis", "flash fire", "grim neigh", "guard dog", "justified", "moxie", "sap sipper", "storm drain", "stamina", "toxic boost", "water compaction", "weak armor", "wind power"]);

// _v49_stone_matches_species reads this hand-written table first (V49/V67).
const STONE_SPECIES_V67 = {
  abomasite: "abomasnow", absolite: "absol", aerodactylite: "aerodactyl", aggronite: "aggron", alakazite: "alakazam",
  altarianite: "altaria", ampharosite: "ampharos", audinite: "audino", banettite: "banette", beedrillite: "beedrill",
  blastoisinite: "blastoise", blazikenite: "blaziken", cameruptite: "camerupt", charizarditex: "charizard", charizarditey: "charizard",
  diancite: "diancie", froslassite: "froslass", galladite: "gallade", garchompite: "garchomp", gardevoirite: "gardevoir",
  gengarite: "gengar", glalitite: "glalie", gyaradosite: "gyarados", heracronite: "heracross", houndoominite: "houndoom",
  kangaskhanite: "kangaskhan", latiasite: "latias", latiosite: "latios", lopunnite: "lopunny", lucarionite: "lucario",
  manectite: "manectric", mawilite: "mawile", medichamite: "medicham", metagrossite: "metagross", mewtwonitex: "mewtwo",
  mewtwonitey: "mewtwo", pidgeotite: "pidgeot", pinsirite: "pinsir", sablenite: "sableye", salamencite: "salamence",
  sceptilite: "sceptile", scizorite: "scizor", sharpedonite: "sharpedo", slowbronite: "slowbro", steelixite: "steelix",
  swampertite: "swampert", tyranitarite: "tyranitar", venusaurite: "venusaur",
};
const STONE_FORM_OVERRIDES_V67 = {
  charizarditex: "Mega Charizard X", charizarditey: "Mega Charizard Y", froslassite: "Mega Froslass",
  mewtwonitex: "Mega Mewtwo X", mewtwonitey: "Mega Mewtwo Y",
};

export const TYPES = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy"];
const YELLOW = 35;
const RED = 75;

function clamp100(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

/** _v188_colored_threats: yellow and red rows, worst first. */
export function coloredThreats(threats) {
  return (threats || []).filter((t) => (Number(t?.score) || 0) >= YELLOW).map((t) => ({ ...t }))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (Number(a.position) || 999999) - (Number(b.position) || 999999) || String(a.name).localeCompare(String(b.name)));
}

/** _v34_ko_points */
export function koPoints(hits, chance = 1) {
  const base = { 1: 100, 2: 65, 3: 40 }[Number.parseInt(hits, 10) || 99] || 0;
  return base * Math.max(0, Math.min(1, Number(chance) || 0));
}

/** _v78_result_ko_weight */
export function resultKoWeight(result) {
  if (!result || result.speed_tier_suppressed) return 0;
  const hits = Number.parseInt(result.hits, 10) || 99;
  const chance = Number(result.chance) || 0;
  if (chance <= 0) return 0;
  const base = { 1: 1.0, 2: 0.66, 3: 0.26 }[hits] || 0;
  if (base <= 0) return 0;
  return base * Math.max(0.35, Math.min(1, chance));
}

/** _v47_ko_label_for_hits */
export function koLabelForHits(hits, chance) {
  const label = Number(hits) === 1 ? "OHKO" : `${Number.parseInt(hits, 10)}HKO`;
  return chance >= 0.999 ? `Guaranteed ${label}` : `${pyRoundInt(chance * 100)}% to ${label}`;
}

function pyRoundInt(value) {
  // Python round(): half to even.
  const floor = Math.floor(value);
  const diff = value - floor;
  if (Math.abs(diff - 0.5) < 1e-12) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

/** _v35_best_rank_from_result */
export function bestRank(result) {
  const hits = Number.parseInt(result?.hits, 10);
  return [1, 2, 3].includes(hits) ? hits : 6;
}

/** _v175_rolls_for_hit */
function rollsForHit(result, hitIndex) {
  const r = result || {};
  let field;
  if ((hitIndex | 0) <= 0) field = r.rolls_with_resist_berry && r.rolls_with_resist_berry.length ? "rolls_with_resist_berry" : "rolls";
  else field = r.rolls_without_resist_berry && r.rolls_without_resist_berry.length ? "rolls_without_resist_berry" : "rolls";
  let rolls = (r[field] || []).filter((v) => typeof v === "number").map((v) => Math.trunc(v));
  if (!rolls.length && field !== "rolls") rolls = (r.rolls || []).filter((v) => typeof v === "number").map((v) => Math.trunc(v));
  return rolls;
}

/** _v175_chance_for_hits: exact damage distribution, misses included. */
export function chanceForHits(result, hits, accuracy = 1) {
  const hp = Math.trunc(result?.current_hp || result?.max_hp || 0);
  const n = Math.max(1, Math.trunc(hits || 1));
  const acc = Math.max(0, Math.min(1, accuracy ?? 1));
  if (hp <= 0) return 0;
  let dist = new Map([[0, 1]]);
  for (let i = 0; i < n; i += 1) {
    const rolls = rollsForHit(result, i);
    if (!rolls.length) return 0;
    const perRoll = acc / rolls.length;
    const outcomes = rolls.map((roll) => [roll, perRoll]);
    if (acc < 0.999999) outcomes.push([0, 1 - acc]);
    const next = new Map();
    for (const [total, prob] of dist) {
      for (const [damage, p] of outcomes) {
        const t = total + damage;
        next.set(t, (next.get(t) || 0) + prob * p);
      }
    }
    dist = next;
  }
  let sum = 0;
  for (const [total, prob] of dist) if (total >= hp) sum += prob;
  return Math.max(0, Math.min(1, sum));
}

/** _v40_chance_for_hits: equal-weight roll convolution, no accuracy. */
function chanceForHitsV40(rolls, hp, hits) {
  if (!rolls.length || hp <= 0 || hits <= 0) return 0;
  let dist = new Map([[0, 1]]);
  for (let i = 0; i < hits; i += 1) {
    const next = new Map();
    for (const [total, count] of dist) for (const roll of rolls) next.set(total + roll, (next.get(total + roll) || 0) + count);
    dist = next;
  }
  let all = 0;
  let ok = 0;
  for (const [total, count] of dist) {
    all += count;
    if (total >= hp) ok += count;
  }
  return ok / (all || 1);
}

/** _v40_full_ko_summary_from_result */
export function fullKoSummaryV40(result, maxHits = 10) {
  const rolls = (result?.rolls || []).filter((v) => typeof v === "number").map((v) => Math.trunc(v));
  const hp = Math.trunc(result?.current_hp || result?.max_hp || 1);
  if (!rolls.length || Math.max(...rolls) <= 0 || hp <= 0) return { hits: 99, chance: 0, label: "No damage" };
  let lastPositive = 0;
  for (let hits = 1; hits <= Math.max(1, maxHits); hits += 1) {
    const chance = chanceForHitsV40(rolls, hp, hits);
    if (chance > 0) lastPositive = chance;
    if (chance >= 0.5) {
      const label = hits === 1 ? "OHKO" : `${hits}HKO`;
      return { hits, chance, label: chance >= 0.999 ? `Guaranteed ${label}` : `${pyRoundInt(chance * 100)}% to ${label}` };
    }
  }
  return { hits: 99, chance: lastPositive, label: "No reliable KO" };
}

/** _v185_normalize_ko_text (without the guaranteed-range removal) */
function normalizeKoText(text) {
  return String(text || "").trim().replace(/\b100%\s+(?:chance\s+)?to\s+(OHKO|[2-9]\s*HKO)\b/gi, (_m, label) => `Guaranteed ${label.replace(/ /g, "")}`);
}

/** _v45_turn_hits_for_move */
function turnHitsForMove(rawHits, recharge) {
  const hits = Number.parseInt(rawHits, 10) || 99;
  if (!recharge || hits <= 1 || hits >= 90) return hits;
  return hits * 2 - 1;
}

/** _v45_turn_label */
function turnLabel(rawHits, turnHits, chance, recharge) {
  const c = Number(chance) || 0;
  if (!recharge || (rawHits || 99) <= 1 || turnHits === rawHits) {
    const label = turnHits === 1 ? "OHKO" : `${turnHits}HKO`;
    return c >= 0.999 ? `Guaranteed ${label}` : `${pyRoundInt(c * 100)}% to ${label}`;
  }
  const t = `${turnHits}-turn KO`;
  const raw = `${rawHits} hits`;
  return c >= 0.999 ? `Guaranteed ${t} (${raw} + cooldown)` : `${pyRoundInt(c * 100)}% to ${t} (${raw} + cooldown)`;
}

/** _v366_result_damage_key: average/high/low as % of max HP. */
function damageKey(result) {
  const rolls = (result?.rolls || []).filter((v) => typeof v === "number");
  const hp = Math.max(1, Number(result?.max_hp || result?.current_hp || 1));
  const avg = rolls.length ? rolls.reduce((a, b) => a + b, 0) / rolls.length : 0;
  return [(avg * 100) / hp, ((rolls.length ? Math.max(...rolls) : 0) * 100) / hp, ((rolls.length ? Math.min(...rolls) : 0) * 100) / hp];
}

function compareTuples(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** _v366_team_result_key */
function teamResultKey(result) {
  return [Number(result.score) || 0, Number(result.chance) || 0, damageKey(result)[0], -(Number.parseInt(result.full_hits, 10) || 99)];
}

function conditionLabel(value) {
  return String(value || "").trim().replace(/\binactive\b/gi, "not triggered");
}

// --- the evaluator ------------------------------------------------------------------

export class TeamEvaluator {
  /**
   * @param {object} data   BuilderData (app-data + meta) for the website
   * @param {DamageEngine} engine
   * @param {string} format  "Doubles" | "Singles"
   * @param {object} settings  normalised settings
   * @param {{pairedSpreads?: boolean|null}} options  `pairedSpreads`: each Nature is shown
   *   with Stat Points it does not contradict (builder/nature-spreads.js) instead of with
   *   the distribution at its own place in the usage file's other list. On in production;
   *   a run recorded before the rule replays with it off.
   */
  constructor(data, engine, format, settings, { pairedSpreads = PAIRED_SPREADS } = {}) {
    this.pairedSpreads = pairedOption(pairedSpreads);
    this.data = data;
    this.engine = engine;
    this.format = format === "Singles" ? "Singles" : "Doubles";
    this.settings = normalizeSettings(settings);
    this.excludedMoves = csvTokens(this.settings.exclude_moves);
    this.fieldCache = new Map();
    this.attackCache = new Map();
  }

  side(mon) {
    return String(mon?.analysis_side || "").toLowerCase();
  }

  /** _v35_display_mon */
  display(mon) {
    const form = String(mon?.form_name || "").trim();
    if (form && form.toLowerCase() !== String(mon?.pokemon_name || "").trim().toLowerCase()) return form;
    return String(mon?.pokemon_name || "Unknown").trim() || "Unknown";
  }

  meta(move) {
    return this.engine.moveMeta(makeContext({ move_name: move, battle_format: this.format })) || {};
  }

  /** _v36_move_priority: the move table's priority. */
  movePriority(move) {
    return Number.parseInt(this.meta(move).priority, 10) || 0;
  }

  /** _v159_damaging_move */
  damagingMove(move) {
    const meta = this.meta(move);
    const category = String(meta.category || "").toLowerCase();
    return (category === "physical" || category === "special") && Math.trunc(Number(meta.power) || 0) > 0;
  }

  /** _v166_calc_moves */
  calcMoves(moves, limit = 8) {
    const out = [];
    const seen = new Set();
    for (const move of moves || []) {
      const clean = String(move || "").trim();
      const k = clean.toLowerCase();
      if (!clean || seen.has(k) || this.excludedMoves.has(k)) continue;
      if (!this.damagingMove(clean)) continue;
      seen.add(k);
      out.push(clean);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** _v45_move_has_recharge / _v48_move_has_cooldown_for_result */
  hasCooldown(move, result) {
    const clean = String(move || "").trim();
    if (!clean) return false;
    if (compact(clean) === "solarbeam") return String(result?.weather || "").trim().toLowerCase() !== "sun";
    if (RECHARGE_MOVES.has(clean.toLowerCase())) return true;
    const meta = this.meta(clean);
    if (meta.recharge || meta.requires_recharge || (Number.parseInt(meta.cooldown, 10) || 0) >= 1) return true;
    const special = String(meta.special || "").toLowerCase();
    if (special.includes("recharge") || special.includes("cooldown")) return true;
    return (meta.flags || []).some((f) => ["recharge", "cooldown", "mustrecharge"].includes(String(f).toLowerCase()));
  }

  /** _v432_move_self_destructs */
  selfDestructs(move) {
    const k = String(move || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (SELF_KO_MOVES.has(k)) return true;
    const meta = this.meta(move);
    const flags = new Set((meta.flags || []).map((f) => String(f).toLowerCase().replace(/[^a-z0-9]+/g, "")));
    const special = String(meta.special || meta.effect || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    return Boolean(meta.self_destruct || meta.user_faints || flags.has("explosive") || flags.has("selfdestruct") || flags.has("userfaints") || special === "selfdestruct" || special === "userfaints");
  }

  /** _v432_apply_self_ko_limit */
  selfKoLimit(move, ko) {
    const out = { ...ko };
    if (!this.selfDestructs(move)) return out;
    const raw = Number.parseInt(out.raw_hits ?? out.hits, 10) || 99;
    out.self_ko_move_v432 = true;
    out.raw_hits = raw;
    if (raw === 1) return out;
    Object.assign(out, { hits: 99, chance: 0, score: 0, label: "No KO (user faints after one use)" });
    return out;
  }

  /** _team_analysis_ko_summary_v175 */
  koSummary(result) {
    const rolls = rollsForHit(result, 0);
    const hp = Math.trunc(result?.current_hp || result?.max_hp || 1);
    if (!rolls.length || Math.max(...rolls) <= 0 || hp <= 0) return { score: 0, hits: 99, chance: 0, label: "No damage" };
    const accRaw = result?.move_accuracy_factor;
    const acc = Math.max(0, Math.min(1, accRaw === undefined || accRaw === null ? 1 : Number(accRaw)));
    let lastPositive = null;
    for (const hits of [1, 2, 3]) {
      const chance = chanceForHits(result, hits, acc);
      if (chance > 0) lastPositive = [hits, chance];
      if (chance >= 0.5) return { score: koPoints(hits, chance), hits, chance, label: koLabelForHits(hits, chance) };
    }
    if (lastPositive) {
      const nextHits = Math.min(4, lastPositive[0] + 1);
      const nextChance = chanceForHits(result, nextHits, acc);
      if (nextHits <= 3 && nextChance >= 0.5) return { score: koPoints(nextHits, nextChance), hits: nextHits, chance: nextChance, label: koLabelForHits(nextHits, nextChance) };
    }
    const chance4 = chanceForHits(result, 4, acc);
    return { score: 8 * Math.max(0.25, chance4), hits: 4, chance: chance4, label: "4HKO+" };
  }

  /** _v45_full_ko_summary_from_result (+ V432 self-KO limit) */
  fullKoSummary(move, result, maxHits = 10) {
    const rolls = rollsForHit(result, 0);
    const hp = Math.trunc(result?.current_hp || result?.max_hp || 1);
    let base;
    if (!rolls.length || Math.max(...rolls) <= 0 || hp <= 0) {
      base = { score: 0, hits: 99, chance: 0, label: "No damage", raw_hits: 99, recharge_move: false };
    } else {
      const accRaw = result?.move_accuracy_factor;
      const acc = Math.max(0, Math.min(1, accRaw === undefined || accRaw === null ? 1 : Number(accRaw)));
      let chosen = null;
      let lastPositive = null;
      for (let hits = 1; hits <= Math.max(1, maxHits); hits += 1) {
        const chance = chanceForHits(result, hits, acc);
        if (chance > 0) lastPositive = [hits, chance];
        if (chance >= 0.5) {
          chosen = [hits, chance];
          break;
        }
      }
      if (!chosen) chosen = lastPositive || [99, 0];
      const [hits, chance] = chosen;
      base = { score: koPoints(hits, chance), hits, chance, label: hits < 90 ? koLabelForHits(hits, chance) : "No KO", raw_hits: hits };
      const cooldown = this.hasCooldown(move, result);
      const turns = turnHitsForMove(hits, cooldown);
      base.hits = turns;
      base.recharge_move = cooldown;
      if (cooldown && hits > 1 && hits < 90) base.label = turnLabel(hits, turns, chance, true);
    }
    return this.selfKoLimit(move, base);
  }

  /** _v48_apply_cooldown_to_ko (+ V432 self-KO limit) */
  applyCooldown(move, ko, result) {
    const out = { ...ko };
    const raw = Number.parseInt(out.hits, 10) || 99;
    const cooldown = this.hasCooldown(move, result);
    const turns = turnHitsForMove(raw, cooldown);
    out.raw_hits = raw;
    out.hits = turns;
    out.recharge_move = cooldown;
    if (cooldown && raw > 1 && raw < 90) {
      const chance = Number(out.chance) || 0;
      out.label = turnLabel(raw, turns, chance, true);
      out.score = koPoints(turns, chance);
    }
    return this.selfKoLimit(move, out);
  }

  // --- field -------------------------------------------------------------------------

  /** _v51_effective_ability_for_field: a Mega's own ability counts for the field. */
  fieldAbility(mon) {
    const ability = String(mon?.ability || "").trim();
    const k = compact(ability);
    if (WEATHER_SETTERS[k] || TERRAIN_SETTERS[k]) return ability;
    // A Mega form's own Ability sets the field even when the tile still shows the base
    // one (Mega Charizard Y listed with Blaze still brings Drought's sun).
    const mega = this.engine.effectiveMegaMon(mon);
    if (mega && /^mega\s/i.test(mega.form_name) && mega.ability) return String(mega.ability);
    return ability;
  }

  /** _v51_speed_for_weather_activation */
  activationSpeed(mon) {
    const mega = this.engine.effectiveMegaMon(mon);
    return Number(this.engine.finalStats({ ...mon, form_name: mega?.form_name || mon.form_name }).speed) || 0;
  }

  /** _team_analysis_auto_field_from_abilities_v51: the slowest setter's field remains. */
  autoField(...mons) {
    const cacheKey = mons.map((m) => monSignature(m)).join("|");
    const cached = this.fieldCache.get(cacheKey);
    if (cached) return cached;
    const weathers = [];
    const terrains = [];
    mons.filter(Boolean).forEach((mon, index) => {
      const ability = this.fieldAbility(mon);
      const speed = this.activationSpeed(mon);
      const k = compact(ability);
      if (WEATHER_SETTERS[k]) weathers.push([speed, index, WEATHER_SETTERS[k]]);
      if (TERRAIN_SETTERS[k] && k !== "hadronengine") terrains.push([speed, index, TERRAIN_SETTERS[k]]);
    });
    const order = (a, b) => b[0] - a[0] || a[1] - b[1];
    weathers.sort(order);
    terrains.sort(order);
    const result = [weathers.length ? weathers[weathers.length - 1][2] : "None", terrains.length ? terrains[terrains.length - 1][2] : "None"];
    this.fieldCache.set(cacheKey, result);
    return result;
  }

  screenOn(setting, defenderSide) {
    return setting === "Both" || (setting === "My Team" && defenderSide === "team") || (setting === "Threat Team" && defenderSide === "threat");
  }

  sideTailwind(side) {
    const t = this.settings.tailwind;
    return t === "Both" || (t === "My Team" && side === "team") || (t === "Threat Team" && side === "threat");
  }

  /** calc_context: v35, v47, v48, v49, v51 and v420 combined. */
  calcContext(attacker, defender, move) {
    const s = this.settings;
    const meta = this.meta(move);
    let weather = s.weather;
    let terrain = s.terrain;
    if (weather === "None" && s.use_weather_abilities) weather = this.autoField(attacker, defender)[0] || "None";
    if (terrain === "None") terrain = this.autoField(attacker, defender)[1] || "None";
    const category = String(meta.category || "").toLowerCase();
    const defenderSide = this.side(defender);
    const ctx = makeContext({
      move_name: move,
      weather,
      terrain,
      battle_format: this.format,
      spread_move: Boolean(meta.spread) && this.format === "Doubles",
    });
    ctx.trick_room = s.trick_room;
    ctx.reflect = category === "physical" && this.screenOn(s.reflect, defenderSide);
    ctx.light_screen = category === "special" && this.screenOn(s.light_screen, defenderSide);
    ctx.use_move_accuracies_v47 = s.use_move_accuracies;
    ctx.ignore_other_abilities_v47 = s.ignore_other_abilities;
    ctx.ignore_held_items_v48 = s.ignore_held_items;
    ctx.ignore_weather_abilities_v48 = s.ignore_weather_abilities;
    ctx.field_activation_order_v51 = "speed";
    ctx.attacker_state = { weather, tailwind: this.sideTailwind(this.side(attacker)) };
    ctx.defender_state = { weather, tailwind: this.sideTailwind(defenderSide) };
    return ctx;
  }

  calculate(attacker, defender, ctx) {
    return this.engine.calculate(makeMon(attacker), makeMon(defender), { ...ctx, attacker_state: { ...ctx.attacker_state }, defender_state: { ...ctx.defender_state } });
  }

  // --- best attack (twelve layers) ------------------------------------------------------

  baseResult(attacker, defender, speed) {
    const a = this.display(attacker);
    const d = this.display(defender);
    return {
      score: 0, label: "No damage", full_label: "No damage", move: "-", percent: "0-0%",
      hits: 99, chance: 0, full_hits: 99, full_chance: 0, weather: "None", terrain: "None",
      attacker_mon: a, defender_mon: d, attacker: a, defender: d,
      attacker_side: this.side(attacker), defender_side: this.side(defender),
      attacker_speed: speed, move_priority: 0,
      attacker_spread_label: String(attacker.stat_spread_label || ""),
      defender_spread_label: String(defender.stat_spread_label || ""),
      raw_hits: 99, raw_full_hits: 99, recharge_move: false,
    };
  }

  /** v161: one move's candidate (called with a single move by v377). */
  bestV161(attacker, defender, moves) {
    const baseSpeed = this.engine.effectiveSpeed(makeMon(attacker), {});
    let best = this.baseResult(attacker, defender, baseSpeed);
    const tiers = this.settings.use_speed_tiers;
    for (const raw of (moves || attacker.moves || []).slice(0, 8)) {
      const move = String(raw || "").trim();
      if (!move || this.excludedMoves.has(move.toLowerCase())) continue;
      const ctx = this.calcContext(attacker, defender, move);
      const result = this.calculate(attacker, defender, ctx);
      result.weather = ctx.weather;
      const rawKo = this.koSummary(result);
      const ko = this.applyCooldown(move, rawKo, result);
      const full = this.fullKoSummary(move, result, 10);
      const priority = this.movePriority(move);
      const candidate = {
        score: Number(ko.score) || 0,
        label: ko.label ?? "No damage",
        full_label: String(full.label ?? ko.label ?? "No damage"),
        move,
        percent: String(result.percent ?? "0-0%"),
        ko: String(result.ko ?? ""),
        hits: Number.parseInt(ko.hits, 10) || 99,
        chance: Number(ko.chance) || 0,
        full_hits: Number.parseInt(full.hits, 10) || 99,
        full_chance: Number(full.chance) || 0,
        weather: ctx.weather,
        terrain: ctx.terrain,
        attacker_mon: this.display(attacker),
        defender_mon: this.display(defender),
        attacker: this.display(attacker),
        defender: this.display(defender),
        attacker_side: this.side(attacker),
        defender_side: this.side(defender),
        attacker_speed: baseSpeed,
        move_priority: priority,
        rolls: [...(result.rolls || [])],
        current_hp: result.current_hp,
        max_hp: result.max_hp,
        attacker_spread_label: String(attacker.stat_spread_label || ""),
        defender_spread_label: String(defender.stat_spread_label || ""),
        raw_hits: Number.parseInt(ko.raw_hits ?? ko.hits, 10) || 99,
        raw_full_hits: Number.parseInt(full.raw_hits ?? full.hits, 10) || 99,
        recharge_move: Boolean(ko.recharge_move || full.recharge_move),
        move_accuracy_factor: result.move_accuracy_factor,
      };
      const keyOf = (r, speed) => (tiers
        ? [-bestRank(r), Number.parseInt(r.move_priority, 10) || 0, Number(r.chance) || 0, Number(r.score) || 0, -(Number.parseInt(r.full_hits, 10) || 99), Number(r.full_chance) || 0, Number(speed) || 0]
        : [-bestRank(r), Number(r.chance) || 0, Number(r.score) || 0, -(Number.parseInt(r.full_hits, 10) || 99), Number(r.full_chance) || 0, Number.parseInt(r.move_priority, 10) || 0, Number(speed) || 0]);
      if (compareTuples(keyOf(candidate, baseSpeed), keyOf(best, best.attacker_speed)) > 0) best = candidate;
    }
    delete best.move_accuracy_factor;
    return best;
  }

  /** v185: damaging moves only, and "100% to" reads "Guaranteed". */
  bestV185(attacker, defender, moves) {
    const calcMoves = this.calcMoves(moves || attacker.moves || [], 8);
    if (!calcMoves.length) {
      const a = this.display(attacker);
      const d = this.display(defender);
      return {
        score: 0, label: "No damaging move", full_label: "No damaging move", move: "-", percent: "0-0%",
        hits: 99, chance: 0, full_hits: 99, full_chance: 0, attacker: a, attacker_mon: a, defender: d, defender_mon: d,
        attacker_side: this.side(attacker), defender_side: this.side(defender),
        attacker_speed: this.engine.effectiveSpeed(makeMon(attacker), {}), move_priority: 0,
      };
    }
    const result = this.bestV161(attacker, defender, calcMoves);
    result.label = normalizeKoText(result.label);
    result.full_label = normalizeKoText(result.full_label ?? result.label);
    return result;
  }

  /** v304: record whether speed tiers apply, and the Tailwind-adjusted speed. */
  bestV304(attacker, defender, moves) {
    const result = this.bestV185(attacker, defender, moves);
    result.speed_tiers_used = this.settings.use_speed_tiers;
    const speed = Number(result.attacker_speed) || 0;
    result.effective_attacker_speed = this.sideTailwind(String(result.attacker_side || "").toLowerCase()) ? speed * 2 : speed;
    return result;
  }

  /** _v366_condition_axes (+ V377 relabel, + V494 settled field axes) */
  conditionAxes(attacker, defender, ctx) {
    const meta = this.engine.moveMeta(ctx) || {};
    const special = String(meta.special || "").toLowerCase();
    const ability = engineKey(attacker.ability);
    const defAbility = engineKey(defender.ability);
    const axes = new Map();
    const add = (name, values) => {
      const bucket = axes.get(name) || [];
      const seen = new Set(bucket.map(([v]) => JSON.stringify(v)));
      for (const [value, label] of values) {
        if (!seen.has(JSON.stringify(value))) {
          seen.add(JSON.stringify(value));
          bucket.push([value, String(label)]);
        }
      }
      axes.set(name, bucket);
    };
    const maxFainted = this.format === "Singles" ? 2 : 3;
    const faintedAxis = [[0, "0 fainted allies"], [maxFainted, `${maxFainted} fainted allies`]];
    if (special === "last_respects") add("fainted_allies", faintedAxis);
    else if (special === "rage_fist") add("times_hit", [[0, "not hit"], [6, "hit 6 times"]]);
    else if (special === "payback" || special === "first_double") add("moved_first", [[false, "moves second"], [true, "moves first"]]);
    else if (special === "assurance") add("defender_damaged", [[false, "target not damaged"], [true, "target already damaged"]]);
    else if (special === "revenge") add("attacker_was_hit", [[false, "not hit first"], [true, "hit first"]]);
    else if (special === "failed_double") add("last_move_failed", [[false, "previous move succeeded"], [true, "previous move failed"]]);
    else if (special === "flail" || special === "eruption") add("attacker_hp", [[1, "user at 1% HP"], [100, "user at full HP"]]);
    else if (special === "target_hp_power") add("defender_hp", [[1, "target at 1% HP"], [100, "target at full HP"]]);
    else if (special === "brine") add("defender_hp", [[50, "target at half HP"], [100, "target at full HP"]]);
    else if (special === "facade") add("attacker_status", [["", "user has no status"], ["Burned", "user is statused"]]);
    else if (special === "hex") add("defender_status", [["", "target has no status"], ["Burned", "target is statused"]]);
    else if (special === "venoshock") add("defender_status", [["", "target is not poisoned"], ["Poisoned", "target is poisoned"]]);
    else if (special === "stored_power") add("positive_stages", [[0, "no positive stages"], [6, "maximum positive stages"]]);
    else if (special === "expanding_force" || special === "rising_voltage") {
      const required = special === "expanding_force" ? "Psychic" : "Electric";
      add("terrain", [["None", "no terrain"], [required, `${required} Terrain`]]);
    } else if (special === "psyblade") add("terrain", [["None", "no terrain"], ["Electric", "Electric Terrain"]]);
    else if (special === "weather_ball") add("weather", [["None", "no weather"], ["Sun", "Sun"], ["Rain", "Rain"], ["Sand", "Sand"], ["Snow", "Snow"]]);
    else if (special === "solar_beam") add("weather", [["Sun", "Sun"], ["Rain", "Rain"], ["Sand", "Sand"], ["Snow", "Snow"]]);
    else if (special === "hydro_steam") add("weather", [["None", "no weather"], ["Sun", "Sun"]]);

    if (ability === "supreme overlord") add("fainted_allies", faintedAxis);
    if (ability === "analytic") add("moved_first", [[true, "moves first"], [false, "moves second"]]);
    if (ability === "stakeout") add("defender_switching", [[false, "target stays in"], [true, "target switches in"]]);
    if (ability === "slow start") add("slow_start_ended", [[false, "Slow Start active"], [true, "Slow Start ended"]]);
    // Plus and Minus need a partner beside them, which Singles never has.
    if ((ability === "plus" || ability === "minus") && this.format !== "Singles") add("plus_minus_partner", [[false, "no Plus/Minus partner"], [true, "Plus/Minus partner active"]]);
    if (ability in PINCH_ABILITIES) add("attacker_hp", [[100, `${attacker.ability} inactive`], [33, `${attacker.ability} active`]]);
    if (ability === "guts") add("attacker_status", [["", "Guts inactive"], ["Burned", "Guts active"]]);
    if (ability === "toxic boost") add("attacker_status", [["", "Toxic Boost inactive"], ["Poisoned", "Toxic Boost active"]]);
    if (ability === "flare boost") add("attacker_status", [["", "Flare Boost inactive"], ["Burned", "Flare Boost active"]]);
    if (ability === "rivalry" && (!["Male", "Female"].includes(String(attacker.gender || "")) || !["Male", "Female"].includes(String(defender.gender || "")))) add("rivalry", [["same", "same gender"], ["opposite", "opposite gender"]]);
    if (MANUAL_DAMAGE_ABILITIES.has(ability)) add("manual_trigger", [[false, `${attacker.ability} inactive`], [true, `${attacker.ability} triggered`]]);
    if (ability === "solar power" || ability === "orichalcum pulse") add("weather", [["None", "no Sun"], ["Sun", "Sun"]]);
    if (ability === "sand force") add("weather", [["None", "no Sand"], ["Sand", "Sand"]]);
    if (ability === "hadron engine") add("terrain", [["None", "no Electric Terrain"], ["Electric", "Electric Terrain"]]);
    if (defAbility === "marvel scale" && !String(defender.status || "")) add("defender_status", [["", "Marvel Scale inactive"], ["Burned", "Marvel Scale active"]]);
    if (defAbility === "grass pelt") add("terrain", [["None", "Grass Pelt inactive"], ["Grassy", "Grass Pelt active"]]);
    if (defAbility === "multiscale" || defAbility === "shadow shield") add("defender_hp", [[99, `${defender.ability} inactive`], [100, `${defender.ability} active`]]);

    const settled = new Set();
    if (String(ctx.weather || "None") !== "None") settled.add("weather");
    if (String(ctx.terrain || "None") !== "None") settled.add("terrain");
    return [...axes.entries()]
      .filter(([, values]) => values.length > 1)
      .filter(([name]) => !settled.has(name))
      .map(([name, values]) => [name, values.map(([v, label]) => [v, conditionLabel(label)])]);
  }

  applyAxis(name, value, attacker, defender, ctx) {
    switch (name) {
      case "fainted_allies": ctx.fainted_allies = Math.trunc(value); break;
      case "times_hit": ctx.attacker_state.times_hit = Math.trunc(value); break;
      case "moved_first": ctx.attacker_moved_first = Boolean(value); break;
      case "defender_damaged": ctx.defender_state.damaged_this_turn = Boolean(value); break;
      case "attacker_was_hit": ctx.attacker_was_hit = Boolean(value); ctx.attacker_state.was_hit = Boolean(value); break;
      case "last_move_failed": ctx.last_move_failed = Boolean(value); break;
      case "defender_switching": ctx.defender_switching = Boolean(value); break;
      case "attacker_hp": attacker.current_hp_percent = Math.trunc(value); break;
      case "defender_hp": defender.current_hp_percent = Math.trunc(value); break;
      case "attacker_status": attacker.status = String(value); break;
      case "defender_status": defender.status = String(value); break;
      case "positive_stages":
        for (const f of ["attack_stage", "defense_stage", "sp_attack_stage", "sp_defense_stage", "speed_stage"]) attacker[f] = Math.trunc(value);
        break;
      case "weather": ctx.weather = String(value); break;
      case "terrain": ctx.terrain = String(value); break;
      case "slow_start_ended": ctx.attacker_state.slow_start_ended = Boolean(value); break;
      case "plus_minus_partner": ctx.attacker_state.plus_minus_partner = Boolean(value); break;
      case "manual_trigger": ctx._manual_trigger_attacker_ability_v290 = Boolean(value); break;
      case "rivalry": attacker.gender = "Male"; defender.gender = value === "same" ? "Male" : "Female"; break;
      default: break;
    }
  }

  /** _v366_calculate_condition_range (V377) */
  conditionRange(attacker, defender, ctx) {
    const axes = this.conditionAxes(attacker, defender, ctx);
    let combos = [[]];
    for (const [, values] of axes) {
      const next = [];
      for (const combo of combos) for (const v of values) next.push([...combo, v]);
      combos = next;
    }
    combos = combos.slice(0, 32);
    const scenarios = [];
    for (const combo of combos) {
      const a = { ...attacker, bonuses: [...(attacker.bonuses || [])] };
      const d = { ...defender, bonuses: [...(defender.bonuses || [])] };
      const local = { ...ctx, attacker_state: { ...ctx.attacker_state }, defender_state: { ...ctx.defender_state } };
      const labels = [];
      let manual = null;
      axes.forEach(([name], i) => {
        const [value, label] = combo[i];
        this.applyAxis(name, value, a, d, local);
        labels.push(conditionLabel(label));
        if (name === "manual_trigger") manual = Boolean(value);
      });
      if (manual === false && engineKey(d.ability) === "intimidate") d.ability = "";
      let calculated;
      try {
        calculated = this.calculate(a, d, local);
      } catch (error) {
        calculated = { rolls: [], current_hp: 1, max_hp: 1, percent: "0-0%", ko: "No calculation", warnings: [String(error)] };
      }
      scenarios.push([calculated, labels.length ? labels.join(", ") : "current conditions"]);
    }
    let low = scenarios[0];
    let high = scenarios[0];
    for (const s of scenarios) {
      if (compareTuples(damageKey(s[0]), damageKey(low[0])) < 0) low = s;
      if (compareTuples(damageKey(s[0]), damageKey(high[0])) > 0) high = s;
    }
    return { is_range: axes.length > 0, min_result: low[0], max_result: high[0], min_condition: conditionLabel(low[1]), max_condition: conditionLabel(high[1]) };
  }

  /** _v366_team_candidate */
  teamCandidate(attacker, defender, move, span) {
    const high = span.max_result || {};
    const low = span.min_result || {};
    const ko = this.koSummary(high);
    const lowKo = this.koSummary(low);
    const full = fullKoSummaryV40(high, 10);
    const speed = this.engine.effectiveSpeed(makeMon(attacker), {});
    const a = this.display(attacker);
    const d = this.display(defender);
    const result = {
      score: Number(ko.score) || 0,
      label: String(ko.label || "No damage"),
      full_label: String(full.label || ko.label || "No damage"),
      move,
      percent: String(high.percent || "0-0%"),
      ko: String(high.ko || ""),
      hits: Number.parseInt(ko.hits, 10) || 99,
      chance: Number(ko.chance) || 0,
      full_hits: Number.parseInt(full.hits, 10) || 99,
      full_chance: Number(full.chance) || 0,
      attacker: a, attacker_mon: a, defender: d, defender_mon: d,
      attacker_side: this.side(attacker), defender_side: this.side(defender),
      attacker_speed: Math.trunc(speed || 0),
      move_priority: this.movePriority(move),
      rolls: [...(high.rolls || [])],
      current_hp: high.current_hp,
      max_hp: high.max_hp,
      attacker_item: String(attacker.item || ""),
      defender_item: String(defender.item || ""),
      attacker_spread_label: String(attacker.stat_spread_label || ""),
      defender_spread_label: String(defender.stat_spread_label || ""),
    };
    return attachRange(result, span, String(lowKo.label || ""), String(ko.label || ""));
  }

  /** v366: a conditional move can be replaced by its range candidate. */
  bestV366(attacker, defender, moves) {
    const raw = (moves || attacker.moves || []).map((m) => String(m || "").trim()).filter(Boolean);
    let best = this.bestV304(attacker, defender, raw);
    for (const move of raw.slice(0, 8)) {
      const ctx = this.calcContext(attacker, defender, move);
      if (!this.conditionAxes(attacker, defender, ctx).length) continue;
      const span = this.conditionRange(attacker, defender, ctx);
      if (!span.is_range) continue;
      const candidate = this.teamCandidate(attacker, defender, move, span);
      if (compareTuples(teamResultKey(candidate), teamResultKey(best)) > 0) best = candidate;
    }
    return best;
  }

  /** _v377_apply_score_endpoint */
  scoreEndpoint(attacker, defender, result) {
    const data = { ...result };
    if (!data.condition_range) return data;
    const low = data.range_min_result || {};
    const high = data.range_max_result || {};
    if (!Object.keys(low).length || !Object.keys(high).length) return data;
    let selected = low;
    let selectedCondition = conditionLabel(data.range_min_condition || "condition not triggered");
    try {
      const ctx = this.calcContext(attacker, defender, String(data.move || ""));
      const actual = this.calculate(attacker, defender, ctx);
      const distance = (x, y) => damageKey(x).reduce((sum, v, i) => sum + Math.abs(v - damageKey(y)[i]), 0);
      if (distance(actual, high) + 1e-7 < distance(actual, low)) {
        selected = high;
        selectedCondition = conditionLabel(data.range_max_condition || "condition triggered");
      }
    } catch {
      // keep the untriggered endpoint
    }
    const summary = this.koSummary(selected);
    const full = fullKoSummaryV40(selected, 10);
    Object.assign(data, {
      score: Number(summary.score) || 0,
      label: String(summary.label || selected.ko || "No damage"),
      full_label: String(full.label || summary.label || "No damage"),
      percent: String(selected.percent || "0-0%"),
      ko: String(selected.ko || ""),
      hits: Number.parseInt(summary.hits, 10) || 99,
      chance: Number(summary.chance) || 0,
      full_hits: Number.parseInt(full.hits ?? summary.hits, 10) || 99,
      full_chance: Number(full.chance ?? summary.chance) || 0,
      rolls: [...(selected.rolls || [])],
      current_hp: selected.current_hp,
      max_hp: selected.max_hp,
      threat_score_condition_v377: selectedCondition,
    });
    return data;
  }

  /** v377: each move scored on its own, best by (score, chance, average%, full hits). */
  bestV377(attacker, defender, moves) {
    const raw = (moves || attacker.moves || []).map((m) => String(m || "").trim()).filter(Boolean).slice(0, 8);
    if (!raw.length) return this.scoreEndpoint(attacker, defender, this.bestV366(attacker, defender, moves));
    let best = null;
    for (const move of raw) {
      const candidate = this.scoreEndpoint(attacker, defender, this.bestV366(attacker, defender, [move]));
      if (!best || compareTuples(teamResultKey(candidate), teamResultKey(best)) > 0) best = candidate;
    }
    return best || {};
  }

  /** _v381_speed_state */
  speedState(attacker, defender, move) {
    const ctx = this.calcContext(attacker, defender, move);
    const abilityKey = engineKey(attacker.ability);
    const state = { weather: ctx.weather };
    if (abilityKey === "unburden" && engineKey(attacker.item) === "white herb" && engineKey(defender.ability) === "intimidate") state.unburden = true;
    let speed = Math.trunc(this.engine.effectiveSpeed(makeMon(attacker), state));
    if (abilityKey === "surge surfer" && ctx.terrain === "Electric Terrain") speed = Math.trunc(applyChainedModifiers(speed, [["Surge Surfer", 2]]));
    return { speed, use_speed_tiers: this.settings.use_speed_tiers };
  }

  /** v381: the attacking speed includes Scarf, weather abilities and Unburden. */
  bestV381(attacker, defender, moves) {
    const result = this.bestV377(attacker, defender, moves);
    const move = String(result.move || "").trim();
    if (!move || move === "-" || move === "—") return result;
    const state = this.speedState(attacker, defender, move);
    result.attacker_speed = state.speed;
    result.speed_tiers_used = state.use_speed_tiers;
    return result;
  }

  /** _v420_condition_names */
  conditionNames(mon, ctx, state) {
    const names = [];
    const weatherAbilities = { "swift swim": "Swift Swim", chlorophyll: "Chlorophyll", "sand rush": "Sand Rush", "slush rush": "Slush Rush" };
    const ability = engineKey(mon.ability);
    if (ctx.weather !== "None") {
      names.push(ctx.weather);
      if (weatherAbilities[ability]) names.push(weatherAbilities[ability]);
    }
    if (ctx.terrain !== "None") names.push(`${ctx.terrain} Terrain`);
    if (state.tailwind) names.push("Tailwind");
    if (state.unburden) names.push("Unburden");
    return [...new Set(names)];
  }

  /** v420: speeds under the matchup's conditions, and a neutral-field baseline. */
  bestV420(attacker, defender, moves) {
    const result = this.bestV381(attacker, defender, moves);
    const move = String(result.move || "").trim();
    if (!move || move === "-" || move === "—") return result;
    const ctx = this.calcContext(attacker, defender, move);
    const aState = { ...ctx.attacker_state };
    const dState = { ...ctx.defender_state };
    const whiteHerb = (m, o) => engineKey(m.ability) === "unburden" && engineKey(m.item) === "white herb" && engineKey(o.ability) === "intimidate";
    if (whiteHerb(attacker, defender)) aState.unburden = true;
    if (whiteHerb(defender, attacker)) dState.unburden = true;
    Object.assign(result, {
      attacker_speed: Math.trunc(this.engine.effectiveSpeed(makeMon(attacker), aState)),
      defender_speed: Math.trunc(this.engine.effectiveSpeed(makeMon(defender), dState)),
      baseline_speed_v420: Math.trunc(this.engine.effectiveSpeed(makeMon(attacker), {})),
      _speed_conditions_applied_v420: true,
      condition_names_v420: this.conditionNames(attacker, ctx, aState),
      attacker_ability_v420: String(attacker.ability || ""),
    });
    if (ctx.weather !== "None" || ctx.terrain !== "None") {
      const neutral = { ...ctx, weather: "None", terrain: "None", attacker_state: { weather: "None" }, defender_state: { weather: "None" } };
      const raw = this.calculate(attacker, defender, neutral);
      const ko = this.koSummary(raw);
      result.baseline_result_v420 = { hits: Number.parseInt(ko.hits, 10) || 99, chance: Number(ko.chance) || 0, label: String(ko.label || "No reliable KO"), percent: String(raw.percent || "0-0%") };
    }
    return result;
  }

  /** v432: a self-KO move that needs two hits never KOs. */
  bestV432(attacker, defender, moves) {
    const result = this.bestV420(attacker, defender, moves);
    const move = String(result.move || "");
    if (move && this.selfDestructs(move)) {
      const raw = Number.parseInt(result.raw_hits ?? result.hits, 10) || 99;
      if (raw !== 1) Object.assign(result, { hits: 99, full_hits: 99, chance: 0, full_chance: 0, score: 0, label: "No KO (user faints after one use)", full_label: "No KO (user faints after one use)", ko: "No KO (user faints after one use)", self_ko_move_v432: true });
    }
    return result;
  }

  /** _v447_weather_setter_info */
  weatherSetter(attacker, defender, weather) {
    const s = this.settings;
    if (s.weather !== "None" || !s.use_weather_abilities) return {};
    const candidates = [];
    [attacker, defender].forEach((mon, index) => {
      const ability = this.fieldAbility(mon);
      const field = WEATHER_SETTERS[compact(ability)];
      if (!field || field !== weather) return;
      candidates.push([this.activationSpeed(mon), index, mon, ability, field]);
    });
    if (!candidates.length) return {};
    candidates.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
    const [, , setter, ability, field] = candidates[candidates.length - 1];
    return { name: this.display(setter), ability: String(ability), weather: String(field) };
  }

  /** v447: move typing and the weather's source, for the detail views. */
  bestV447(attacker, defender, moves) {
    const out = this.bestV432(attacker, defender, moves);
    const move = String(out.move || "").trim();
    if (!move || move === "-" || move === "—") return out;
    out.attacker_name_v447 = this.display(attacker);
    const ctx = this.calcContext(attacker, defender, move);
    const meta = this.engine.moveMeta(ctx) || {};
    const moveType = pyTitle(String(meta.type || ""));
    let effective = moveType;
    const k = compact(move);
    if (k === "weatherball" && ["Rain", "Sun", "Sand", "Snow"].includes(ctx.weather)) effective = { Rain: "Water", Sun: "Fire", Sand: "Rock", Snow: "Ice" }[ctx.weather];
    else if (k === "terrainpulse" && ["Electric", "Grassy", "Psychic", "Misty"].includes(ctx.terrain)) effective = { Electric: "Electric", Grassy: "Grass", Psychic: "Psychic", Misty: "Fairy" }[ctx.terrain];
    Object.assign(out, {
      move_type_v447: moveType,
      effective_move_type_v447: effective,
      move_category_v447: String(meta.category || "").toLowerCase(),
      move_power_v447: Math.trunc(Number(meta.power) || 0),
      attacker_types_v447: [...(this.engine.pokemon(attacker.pokemon_name, attacker.form_name)?.types || [])],
      defender_name_v447: this.display(defender),
      defender_types_v447: [...(this.engine.pokemon(defender.pokemon_name, defender.form_name)?.types || [])],
      weather_source_v447: this.weatherSetter(attacker, defender, ctx.weather),
      tailwind_active_v447: Boolean(ctx.attacker_state.tailwind),
    });
    return out;
  }

  /** v466: the neutral-field baseline, recalculated from a fresh context. */
  /**
   * V458, which the app runs while Auto Build screens candidates: every move on its
   * own, the best by (KO rank, chance, score, full KO, full chance, priority, Speed).
   * The whole-list evaluation keeps the first of two equal KOs, so a priority move
   * tied with a stronger-sounding one (Sucker Punch and Kowtow Cleave, both 2HKO)
   * only wins here - and with it the race.
   */
  bestAttackPerMove(attacker, defender, moves = null) {
    const list = (moves || attacker.moves || []).slice(0, 6).map((m) => String(m || "").trim()).filter(Boolean);
    this.perMoveAttacks = false;
    try {
      if (!list.length) return this.bestAttack(attacker, defender, moves);
      const key = (r) => [-bestRank(r), Number(r.chance) || 0, Number(r.score) || 0, -(Number.parseInt(r.full_hits, 10) || 99), Number(r.full_chance) || 0, Number.parseInt(r.move_priority, 10) || 0, Number(r.attacker_speed) || 0];
      const greater = (a, b) => {
        for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
        return false;
      };
      let best = null;
      for (const move of list) {
        let result;
        try {
          result = this.bestAttack(attacker, defender, [move]);
        } catch {
          continue;
        }
        if (!best || greater(key(result), key(best))) best = result;
      }
      return best || { score: 0, label: "No damage", full_label: "No damage", move: "—", hits: 99, chance: 0, full_hits: 99, full_chance: 0, percent: "0-0%" };
    } finally {
      this.perMoveAttacks = true;
    }
  }

  bestAttack(attacker, defender, moves = null) {
    if (this.perMoveAttacks) return this.bestAttackPerMove(attacker, defender, moves);
    const cacheKey = `${monSignature(attacker)}>${monSignature(defender)}>${(moves || attacker.moves || []).join(",")}`;
    const cached = this.attackCache.get(cacheKey);
    if (cached) return structuredClone(cached);
    const result = this.bestV447(attacker, defender, moves);
    const move = String(result.move || "").trim();
    if (move && move !== "-" && move !== "—") {
      const ctx = this.calcContext(attacker, defender, move);
      if (ctx.weather !== "None" || ctx.terrain !== "None") {
        const neutral = this.calcContext(attacker, defender, move);
        Object.assign(neutral, { weather: "None", terrain: "None", attacker_state: { weather: "None" }, defender_state: { weather: "None" } });
        const raw = this.calculate(attacker, defender, neutral);
        const ko = this.koSummary(raw);
        result.baseline_result_v420 = {
          attacker: String(attacker.form_name || attacker.pokemon_name || "Pokemon"),
          defender: String(defender.form_name || defender.pokemon_name || "Pokemon"),
          move,
          hits: Number.parseInt(ko.hits, 10) || 99,
          chance: Number(ko.chance) || 0,
          label: String(ko.label || "No reliable KO"),
          full_label: String(ko.label || "No reliable KO"),
          percent: String(raw.percent || "0-0%"),
          neutral_field_v466: true,
        };
      }
    }
    this.attackCache.set(cacheKey, structuredClone(result));
    return result;
  }

  // --- move order -------------------------------------------------------------------

  /** _v36_speed_for_result: a V420 result's speed already carries its conditions. */
  speedForResult(result) {
    const speed = Number(result?.attacker_speed) || 0;
    if (result?._speed_conditions_applied_v420) return speed;
    return this.sideTailwind(String(result?.attacker_side || "").toLowerCase()) ? speed * 2 : speed;
  }

  /** _v161_result_priority */
  resultPriority(result) {
    const raw = result?.move_priority;
    if (raw !== undefined && raw !== null && raw !== "") return Number.parseInt(raw, 10) || 0;
    return this.movePriority(result?.move || "");
  }

  /** _v36_first_result (final): priority, then speed. Trick Room is not applied here (V494). */
  firstResult(a, b) {
    const pa = this.resultPriority(a);
    const pb = this.resultPriority(b);
    if (pa !== pb) return pa > pb ? "a" : "b";
    const sa = this.speedForResult(a);
    const sb = this.speedForResult(b);
    if (sa === sb) return null;
    return sa > sb ? "a" : "b";
  }

  /** _v36_apply_speed_tier_result_order (final): the side that KOs first suppresses the other. */
  applySpeedOrder(incoming, outgoing) {
    let inc = { ...incoming };
    let out = { ...outgoing };
    if (!this.settings.use_speed_tiers) {
      inc.speed_tiers_used = false;
      out.speed_tiers_used = false;
      return [inc, out, ""];
    }
    inc.speed_tiers_used = true;
    out.speed_tiers_used = true;
    const first = this.firstResult(inc, out);
    if (first === null) return [inc, out, ""];
    const incEvent = koEventIndex(inc, first === "a");
    const outEvent = koEventIndex(out, first === "b");
    if (incEvent < outEvent) {
      out = suppressKo(out, inc);
      out.speed_tiers_used = true;
    } else if (outEvent < incEvent) {
      inc = suppressKo(inc, out);
      inc.speed_tiers_used = true;
    }
    return [inc, out, ""];
  }

  /** _v37_first_token_for_breakdown */
  firstToken(incoming, outgoing) {
    const first = this.firstResult(incoming, outgoing);
    return first === "a" ? "incoming" : first === "b" ? "outgoing" : null;
  }

  /** _v494_move_order: (we move first, threat moves first) under the field settings. */
  moveOrder(outgoing, incoming) {
    const s = this.settings;
    if (!s.use_speed_tiers) return [false, false];
    let o = Number(outgoing?.attacker_speed) || 0;
    let i = Number(incoming?.attacker_speed) || 0;
    if (s.tailwind === "My Team" || s.tailwind === "Both") o *= 2;
    if (s.tailwind === "Threat Team" || s.tailwind === "Both") i *= 2;
    return s.trick_room ? [o < i, i < o] : [o > i, i > o];
  }

  /** matchup_quality: V35 base with the V494 outsped penalties. */
  matchupQuality(outgoing, incoming) {
    const outHits = bestRank(outgoing);
    const inHits = bestRank(incoming);
    let quality = (inHits - outHits) * 100;
    quality += (Number(outgoing?.chance) || 0) * 20;
    quality -= (Number(incoming?.chance) || 0) * 20;
    const [outFirst, inFirst] = this.moveOrder(outgoing, incoming);
    if (this.settings.use_speed_tiers && outHits === inHits && [1, 2, 3].includes(outHits)) {
      if (outFirst && !inFirst) quality += 55;
      else if (inFirst && !outFirst) quality -= 55;
    }
    if (!inFirst) return quality;
    if (inHits === 1) {
      quality -= 400;
      if (outgoing && typeof outgoing === "object") outgoing.outsped_and_ohkod_v494 = true;
    } else if (inHits < outHits) {
      quality -= 90;
    }
    return quality;
  }

  // --- meta data (the app's API-cache battle rows, as the site's meta records) -------

  /** Records from data/builder/meta-<format>.json (tools/builder-meta.mjs). */
  setMetaRecords(records) {
    this.metaRecords = [...(records || [])].sort((a, b) => (a.position ?? 999999) - (b.position ?? 999999) || String(a.name).localeCompare(String(b.name)));
    this.recordByKey = new Map();
    for (const record of this.metaRecords) if (!this.recordByKey.has(compact(record.name))) this.recordByKey.set(compact(record.name), record);
    this.metaEntryCache = null;
    return this;
  }

  record(name) {
    return this.recordByKey?.get(compact(name)) || null;
  }

  /** PokemonBattleApiClient.usage_pairs: rank-ordered [name, pct]. */
  usagePairs(name, category, limit) {
    const record = this.record(name);
    if (!record) return [];
    const list = { move: record.moves, held_item: record.items, ability: record.abilities }[category] || [];
    return list.slice(0, Math.max(0, limit));
  }

  /** common_set_for_pokemon: the top row of each usage category. */
  commonSet(name) {
    const record = this.record(name);
    if (!record) return {};
    const set = record.set || {};
    return { nature_name: set.nature || "Serious", bonuses: [...(set.bonuses || [0, 0, 0, 0, 0, 0])], ability: set.ability || "", item: set.item || "", moves: [...(set.moves || [])].slice(0, 4) };
  }

  knownSpecies() {
    if (!this._knownSpecies) this._knownSpecies = new Map([...this.engine.speciesByName.values()].map((entry) => [compact(entry.name), entry.name]));
    return this._knownSpecies;
  }

  /** _v124_base_species_from_display */
  baseSpeciesFromDisplay(name) {
    const text = String(name || "").trim();
    if (!text) return "";
    if (!/^mega[\s-]/i.test(text)) return text;
    const rest = text.replace(/^mega[\s-]+/i, "").trim();
    const noSuffix = rest.replace(/\s+[XYZ]$/i, "").trim();
    const known = this.knownSpecies();
    for (const candidate of [rest, noSuffix]) if (known.has(compact(candidate))) return known.get(compact(candidate));
    return noSuffix || rest || text;
  }

  /** v494 `_v124_is_mega_item_for_species`: the catalogue's owner, compared as written. */
  isMegaItemForSpecies(species, item) {
    const holders = this.engine.megaStones.get(compact(item)) || [];
    return holders.some((h) => compact(h.species) === compact(species));
  }

  /** _v67_species_key */
  v67SpeciesKey(value) {
    let k = compact(value);
    if (k.startsWith("mega") && !k.startsWith("meganium")) k = k.slice(4);
    if (k === "charizardx" || k === "charizardy") return "charizard";
    if (k === "mewtwox" || k === "mewtwoy") return "mewtwo";
    return k;
  }

  /** _v49_stone_matches_species: the hand-written table, else a name match. */
  stoneMatchesSpecies(name, item) {
    const itemKey = compact(item);
    const speciesKey = this.v67SpeciesKey(name);
    if (!itemKey || !speciesKey || !this.engine.isMegaStone(item)) return false;
    const mapped = STONE_SPECIES_V67[itemKey];
    if (mapped) return mapped === speciesKey;
    const generic = itemKey.endsWith("ite") ? itemKey.slice(0, -3) : itemKey;
    return Boolean(generic) && (generic === speciesKey || speciesKey.includes(generic) || generic.includes(speciesKey));
  }

  /** The Mega forms a species' own data lists (V33 mega_form_for_item). */
  megaFormsOf(name) {
    const entry = this.engine.speciesByName.get(compact(name)) || this.engine.speciesByName.get(compact(this.engine.resolve(name)[0]));
    return (entry?.forms || []).map((f) => f.form).filter((form) => /^mega /i.test(String(form).trim()));
  }

  /** mega_form_for_item: V67 (catalogue first) over V49 over V33. */
  megaFormForItem(name, item) {
    const species = String(name || "").trim();
    const holders = this.engine.megaStones.get(compact(item)) || [];
    const own = holders.find((h) => compact(h.species) === compact(species));
    if (own) return own.form;
    if (!this.stoneMatchesSpecies(species, item)) return species;
    const itemKey = compact(item);
    if (STONE_FORM_OVERRIDES_V67[itemKey]) return STONE_FORM_OVERRIDES_V67[itemKey];
    // V33: the species' Mega form whose extra word the stone names, else its first.
    let resolved = species;
    const megas = this.megaFormsOf(species);
    if (megas.length) {
      const itemLow = String(item).toLowerCase();
      resolved = megas.find((form) => (form.toLowerCase().match(/[a-z0-9]+/g) || []).some((word) => word && word !== "mega" && word !== species.toLowerCase() && itemLow.includes(word))) || megas[0];
    }
    if (compact(resolved).includes(compact(species))) return resolved;
    return /^mega /i.test(species) ? species : `Mega ${species}`;
  }

  /** _v40_mega_ability_for_form: the form's own metadata, a weather setter first. */
  megaAbility(species, form, fallback) {
    if (compact(species) === "staraptor" && compact(form) === "megastaraptor") return "Contrary";
    const entry = this.engine.speciesByName.get(compact(species));
    const record = entry?.forms.find((f) => compact(f.form) === compact(form));
    const abilities = (record?.abilities || []).filter((a) => String(a || "").trim());
    const weather = abilities.find((a) => WEATHER_SETTERS[compact(a)]);
    if (weather) return weather;
    return abilities[0] || String(fallback || "");
  }

  /** _v197_rows_to_meta_entries + _v197_apply_mega_metadata_from_api_forms */
  metaEntries() {
    if (this.metaEntryCache) return this.metaEntryCache;
    this.metaEntryCache = (this.metaRecords || []).map((record) => {
      const name = String(record.name);
      const topItems = (record.items || []).map(([item]) => item).filter(Boolean).slice(0, 3);
      const entry = {
        name, pokemon: name, pokemon_name: name, base_name: name,
        position: Number(record.position) || 999999,
        top_item: topItems[0] || "", top_items: topItems,
        moves: (record.moves || []).map(([move]) => move).filter(Boolean).slice(0, 4),
      };
      const item = entry.top_item;
      if (item && compact(item).endsWith("ite") && this.isMegaItemForSpecies(name, item)) {
        const form = this.megaFormForItem(name, item);
        if (form && compact(form) !== compact(name)) {
          Object.assign(entry, { _v124_base_species: name, _v124_threat_form: form, _v124_is_mega: true, form_name: form, form, threat_item: item, name: form });
        }
      }
      return entry;
    });
    return this.metaEntryCache;
  }

  excludedPokemonKeys() {
    const keys = new Set();
    for (const token of String(this.settings.exclude_pokemon || "").split(/[,;\n]/)) {
      const text = token.trim();
      if (!text) continue;
      for (const variant of new Set([text, text.replace(/-/g, " "), text.replace(/_/g, " "), /^mega[\s-]/i.test(text) ? text.slice(5).trim() : text])) keys.add(compact(variant));
    }
    return keys;
  }

  /** top_meta_pokemon (V197/V223) */
  topMeta(limit) {
    const excluded = this.excludedPokemonKeys();
    const out = [];
    for (const entry of this.metaEntries()) {
      if (excluded.size) {
        const keys = new Set(["name", "pokemon", "pokemon_name", "base_name", "form", "form_name"].flatMap((f) => (entry[f] ? [compact(entry[f]), compact(String(entry[f]).replace(/^mega[\s-]+/i, ""))] : [])));
        if ([...keys].some((k) => excluded.has(k))) continue;
      }
      out.push({ ...entry });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** _v35_apply_stage_text over _v35_parse_stages */
  applyStages(mon, text) {
    const mapping = { atk: "attack_stage", attack: "attack_stage", def: "defense_stage", defense: "defense_stage", spa: "sp_attack_stage", spatk: "sp_attack_stage", specialattack: "sp_attack_stage", spd: "sp_defense_stage", spdef: "sp_defense_stage", specialdefense: "sp_defense_stage", spe: "speed_stage", speed: "speed_stage" };
    for (const part of String(text || "").split(/[,;\n]+/)) {
      const piece = part.trim();
      if (!piece) continue;
      let m = piece.match(/([A-Za-z. _-]+)\s*[:=]\s*([+-]?\d+)/);
      let stat;
      let value;
      if (m) [, stat, value] = m;
      else {
        m = piece.match(/([+-]?\d+)\s*([A-Za-z. _-]+)/);
        if (!m) continue;
        [, value, stat] = m;
      }
      const attr = mapping[String(stat).toLowerCase().replace(/[^a-z]/g, "")];
      if (attr) mon[attr] = Math.max(-6, Math.min(6, Number.parseInt(value, 10) || 0));
    }
    return mon;
  }

  /** common_mon (V124 over V35 over the base) */
  commonMon(name, formName = null) {
    const requested = String(name || "").trim();
    const requestedForm = String(formName || requested || "").trim();
    const base = this.baseSpeciesFromDisplay(requested);
    const form = compact(requested) !== compact(base) ? requested : requestedForm;
    const pokemon = base || requested;
    const common = this.commonSet(pokemon);
    let moves = (common.moves || []).filter((m) => String(m).trim()).slice(0, 4);
    if (!moves.length) moves = this.usagePairs(pokemon, "move", 4).map(([m]) => m);
    const mon = makeMon({
      pokemon_name: pokemon,
      form_name: form || pokemon,
      item: String(common.item || ""),
      ability: String(common.ability || ""),
      nature_name: String(common.nature_name || "Serious") || "Serious",
      bonuses: [...(common.bonuses || [0, 0, 0, 0, 0, 0])],
      moves,
    });
    const excludedAbilities = new Set([...csvTokens(this.settings.exclude_abilities)].map(compact));
    if (excludedAbilities.has(compact(mon.ability))) mon.ability = "";
    if (this.engine.isMegaStone(mon.item)) mon.form_name = this.megaFormForItem(mon.pokemon_name, mon.item);
    mon.analysis_side = "threat";
    this.applyStages(mon, this.settings.threat_stages);
    // V124: the requested name decides the form, even over the stone's Mega.
    mon.pokemon_name = pokemon;
    mon.form_name = form || pokemon;
    return mon;
  }

  uniqueNames(values, limit) {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
      const text = String(value || "").trim();
      const k = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!text || !k || seen.has(k)) continue;
      seen.add(k);
      out.push(text);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** common_items (V61 over V33) */
  commonItems(name, selected, metaItems, limit) {
    const cap = Math.min(limit, this.settings.calc_item_limit);
    const items = [selected, ...(metaItems || []), ...this.usagePairs(name, "held_item", cap).map(([i]) => i)];
    const out = uniqueTa(items).slice(0, cap);
    return out.length ? out : [""];
  }

  /** common_moves (V61 over V35 over V33) */
  commonMoves(name, selected, limit) {
    const cap = Math.min(limit, this.settings.calc_move_limit);
    const inner = Math.max(cap, 8);
    const moves = uniqueTa([...(selected || []), ...this.usagePairs(name, "move", inner).map(([m]) => m)]).slice(0, inner);
    return moves.filter((m) => !this.excludedMoves.has(String(m).trim().toLowerCase())).slice(0, cap);
  }

  /** _v61_valid_mega_or_base */
  validMegaOrBase(source, variant) {
    const item = String(variant.item || "");
    if (!item || !this.engine.isMegaStone(item)) return variant;
    const species = String(source.pokemon_name || variant.pokemon_name || "");
    const megaForm = this.megaFormForItem(species, item);
    if (compact(megaForm) === compact(species)) {
      variant.form_name = String(source.pokemon_name || source.form_name || variant.pokemon_name || "");
      return variant;
    }
    if (compact(megaForm) !== compact(variant.form_name)) variant.form_name = megaForm;
    variant.ability = this.megaAbility(species, megaForm, variant.ability);
    return variant;
  }

  /** variants_for_mon (V494 over V61 over V35 over V33) */
  variantsForMon(mon, itemOptions, moves, limitItems = 3, limitMoves = 6) {
    const li = Math.min(Math.max(1, Math.min(5, limitItems)), this.settings.calc_item_limit);
    const lm = Math.min(Math.max(1, Math.min(10, limitMoves)), this.settings.calc_move_limit);
    const items = this.commonItems(mon.pokemon_name, mon.item, itemOptions, li);
    const moveNames = this.commonMoves(mon.pokemon_name, moves && moves.length ? moves : mon.moves, lm);
    const side = this.side(mon) || "team";
    const excludedAbilities = new Set([...csvTokens(this.settings.exclude_abilities)].map(compact));
    const variants = items.slice(0, li).map((item) => {
      const form = this.megaFormForItem(mon.pokemon_name, item);
      const variant = makeMon({
        pokemon_name: mon.pokemon_name,
        form_name: form || mon.form_name,
        item,
        ability: mon.ability,
        nature_name: mon.nature_name,
        bonuses: [...(mon.bonuses || [])],
        moves: moveNames.slice(0, lm),
        current_hp_percent: mon.current_hp_percent,
        attack_stage: mon.attack_stage, defense_stage: mon.defense_stage, sp_attack_stage: mon.sp_attack_stage, sp_defense_stage: mon.sp_defense_stage, speed_stage: mon.speed_stage,
        status: mon.status || "",
      });
      variant.analysis_side = side;
      if (excludedAbilities.has(compact(variant.ability))) variant.ability = "";
      if (this.engine.isMegaStone(variant.item)) variant.form_name = this.megaFormForItem(variant.pokemon_name, variant.item);
      this.applyStages(variant, side === "team" ? this.settings.my_stages : this.settings.threat_stages);
      variant.moves = variant.moves.slice(0, lm);
      return this.asMegaVariant(this.validMegaOrBase(mon, variant));
    });
    return variants.length ? variants : [mon];
  }

  /** _v494_as_mega_variant */
  asMegaVariant(mon) {
    const item = String(mon.item || "");
    if (!item || !mon.pokemon_name || !this.engine.isMegaStone(item) || !this.isMegaItemForSpecies(mon.pokemon_name, item)) return mon;
    const eff = this.engine.effectiveMegaMon(mon);
    return Object.assign(mon, { form_name: eff.form_name, ability: eff.ability });
  }

  /**
   * _v40_common_spreads_for_pokemon over build_stat_alignment_spreads: the candidate spreads
   * Auto Build, Suggestions and the threat stat distributions are built from.
   *
   * The usage file ranks Natures and Stat Points as two separate lists, so the Nature in
   * place `i` has nothing to do with the distribution in place `i`: each Nature instead gets
   * the most used distribution it does not contradict (builder/nature-spreads.js). `paired`
   * false is the file's own index zip, which is what a run recorded before the rule replays.
   */
  commonSpreads(name, limit, paired = this.pairedSpreads) {
    const record = this.record(name);
    let spreads = [];
    if (record) {
      const natures = (record.natures || []).slice(0, Math.max(2, limit));
      const points = record.spreads || [];
      const table = this.engine?.natures || {};
      spreads = natures.map(([nature, pct], index) => {
        const point = pointsForNature(points, nature || "Serious", table, { paired, index });
        return {
          name: nature || "Serious",
          nature_name: nature || "Serious",
          bonuses: [...(point?.[1] || [0, 0, 0, 0, 0, 0])],
          percentage: Number(pct) || 0,
          stat_points_percentage: Number(point?.[0]) || 0,
          rank: index + 1,
        };
      });
      if (!spreads.length) {
        const common = this.commonSet(name);
        spreads = [{ name: common.nature_name || "Serious", nature_name: common.nature_name || "Serious", bonuses: [...(common.bonuses || [0, 0, 0, 0, 0, 0])], rank: 1 }];
      }
    }
    if (!spreads.length) spreads = [{ name: "Serious", nature_name: "Serious", bonuses: [0, 0, 0, 0, 0, 0], rank: 1 }];
    const out = [];
    const seen = new Set();
    for (const spread of spreads) {
      const k = `${String(spread.nature_name || spread.name).toLowerCase()}|${spread.bonuses.join(",")}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(spread);
      if (out.length >= Math.max(1, limit)) break;
    }
    return out;
  }

  /** _v40_spread_label */
  spreadLabel(spread) {
    const nature = String(spread.nature_name || spread.name || "Serious").trim() || "Serious";
    const pts = spreadPointsCompact(spread.bonuses);
    const pctValue = spread.percentage !== undefined && spread.percentage !== null && spread.percentage !== "" ? spread.percentage : spread.stat_points_percentage;
    const pct = Number(pctValue) > 0 ? `${pyRoundInt(Number(pctValue))}%` : "";
    return `${nature} · ${pts}${pct ? ` · ${pct}` : ""}`;
  }

  /** _v40_threat_variants_with_two_spreads */
  threatVariants(base, topItems, threatMoves) {
    const li = this.settings.calc_item_limit;
    const lm = this.settings.calc_move_limit;
    const variants = this.variantsForMon(base, (topItems || []).slice(0, li), (threatMoves || []).slice(0, lm), li, lm);
    const limit = STAT_DISTRIBUTION_LIMITS[this.settings.threat_stat_distributions] ?? 1;
    if (limit <= 0) {
      for (const v of variants) {
        v.analysis_side = "threat";
        v.stat_spread_label = "No stat distribution";
      }
      return variants;
    }
    const spreads = this.commonSpreads(base.pokemon_name, limit);
    const expanded = [];
    for (const variant of variants) {
      for (const spread of spreads.slice(0, limit)) {
        const clone = { ...variant, bonuses: [...variant.bonuses], moves: [...variant.moves] };
        clone.nature_name = String(spread.nature_name || spread.name || clone.nature_name || "Serious");
        clone.bonuses = [...spread.bonuses];
        clone.stat_spread_label = this.spreadLabel(spread);
        clone.analysis_side = "threat";
        expanded.push(this.validMegaOrBase(base, clone));
      }
    }
    return expanded.length ? expanded : variants;
  }

  /**
   * _team_analysis_mon_from_entry_slot_v40: a team slot as the evaluation plays it.
   * `set` is {species, form, item, ability, moves, nature, bonuses, hasSpread, usage}.
   */
  teamMon(set, slot) {
    const pokemon = String(set.species || "").trim();
    const form = String(set.form || pokemon).trim() || pokemon;
    const common = this.commonSet(set.usage || pokemon);
    const spread = set.hasSpread === false ? null : { nature_name: set.nature, bonuses: set.bonuses };
    const nature = spread ? String(spread.nature_name || common.nature_name || "Serious") : String(common.nature_name || "Serious");
    const bonuses = spread ? [...(spread.bonuses || common.bonuses || [0, 0, 0, 0, 0, 0])] : [...(common.bonuses || [0, 0, 0, 0, 0, 0])];
    const mon = makeMon({
      pokemon_name: pokemon,
      form_name: form,
      item: String(set.item || "").trim(),
      ability: String(set.ability || "").trim(),
      nature_name: nature,
      bonuses,
      moves: (set.moves || []).map((m) => String(m || "").trim()).filter(Boolean).slice(0, 4),
    });
    mon.analysis_side = "team";
    mon.analysis_slot = slot;
    mon.stat_spread_label = `Current: ${nature} · ${spreadPointsCompact(bonuses)}`;
    mon.current_set_only_v361 = true;
    if (compact(mon.item) && this.engine.isMegaStone(mon.item)) {
      const megaForm = this.megaFormForItem(mon.pokemon_name, mon.item);
      if (megaForm && compact(megaForm) !== compact(mon.pokemon_name)) {
        mon.form_name = megaForm;
        mon.ability = this.megaAbility(mon.pokemon_name, megaForm, mon.ability);
      }
    }
    this.applyStages(mon, this.settings.my_stages);
    return mon;
  }

  /** _v40_team_variants_for_mon: the team plays exactly its own set. */
  teamVariants(mon) {
    const clone = { ...mon, bonuses: [...mon.bonuses], moves: mon.moves.slice(0, 4) };
    if (this.engine.isMegaStone(clone.item)) {
      const megaForm = this.megaFormForItem(clone.pokemon_name, clone.item);
      if (megaForm && compact(megaForm) !== compact(clone.pokemon_name)) {
        clone.form_name = megaForm;
        clone.ability = this.megaAbility(clone.pokemon_name, clone.form_name, clone.ability);
      }
    }
    return [clone];
  }

  /** One threat against the whole team (the body of V451's loop). */
  threatRow(meta, teamMons, teamVariantSets) {
    const s = this.settings;
    const itemLimit = s.calc_item_limit;
    const moveLimit = s.calc_move_limit;
    const name = String(meta.name || "").trim();
    const baseSpecies = String(meta._v124_base_species || meta.base_name || name).trim() || name;
    const baseThreat = this.commonMon(name, name);
    const strict = this.uniqueNames(meta._v124_strict_top_items || [], itemLimit);
    let topItems = strict.length ? strict : this.uniqueNames(meta.top_items || [], itemLimit);
    if (!topItems.length) topItems = baseThreat.item ? [baseThreat.item] : [];
    if (!s.use_held_items) topItems = topItems.slice(0, 1);
    let threatMoves = this.uniqueNames([...(meta.moves || []), ...(meta.top_moves || [])], moveLimit);
    if (!threatMoves.length) threatMoves = this.uniqueNames(this.commonMoves(baseSpecies, baseThreat.moves, moveLimit), moveLimit);
    const variants = this.threatVariants(baseThreat, topItems, threatMoves);
    for (const v of variants) v.analysis_side = "threat";

    const threatCounts = { 1: 0, 2: 0, 3: 0 };
    const answerCounts = { 1: 0, 2: 0, 3: 0 };
    const legacyThreat = [];
    const legacyAnswer = [];
    let bestThreat = { score: 0, label: "No damage", full_label: "No damage", move: "—", weather: "None", hits: 99, chance: 0, attacker_spread_label: "" };
    let bestRawThreat = { score: 0, label: "No damage", full_label: "No damage", move: "—", weather: "None", hits: 99, chance: 0, full_hits: 99, full_chance: 0, attacker_spread_label: "" };
    let bestSpeedAnswer = { score: 0, label: "No damage", full_label: "No damage", move: "—", weather: "None", hits: 99, chance: 0, quality: -9999 };
    let bestRawAnswer = { score: 0, label: "No damage", full_label: "No damage", move: "—", weather: "None", hits: 99, chance: 0, full_hits: 99, full_chance: 0 };
    const usedWeather = new Set();
    const breakdown = [];

    teamMons.forEach((teamMon, pairIndex) => {
      const teamVariants = teamVariantSets[pairIndex];
      const rawIncoming = this.bestBetween(variants, teamVariants);
      const rawOutgoing = this.bestBetween(teamVariants, variants);
      const first = this.firstToken(rawIncoming, rawOutgoing);
      let [incoming, outgoing] = this.applySpeedOrder(rawIncoming, rawOutgoing);
      incoming = { ...incoming };
      outgoing = { ...outgoing };
      if (outgoing.speed_tier_suppressed) {
        outgoing.raw_label = rawOutgoing.full_label || rawOutgoing.label;
        outgoing.full_label = rawOutgoing.full_label || rawOutgoing.label;
        outgoing.full_hits = rawOutgoing.full_hits ?? outgoing.hits ?? 99;
        outgoing.full_chance = rawOutgoing.full_chance ?? outgoing.chance ?? 0;
      }
      if (incoming.speed_tier_suppressed) {
        incoming.raw_label = rawIncoming.full_label || rawIncoming.label;
        incoming.full_label = rawIncoming.full_label || rawIncoming.label;
        incoming.full_hits = rawIncoming.full_hits ?? incoming.hits ?? 99;
        incoming.full_chance = rawIncoming.full_chance ?? incoming.chance ?? 0;
      }
      const quality = this.matchupQuality(outgoing, incoming);
      outgoing.quality = quality;
      if ([1, 2, 3].includes(incoming.hits) && (Number(incoming.chance) || 0) > 0) threatCounts[incoming.hits] += 1;
      if ([1, 2, 3].includes(outgoing.hits) && (Number(outgoing.chance) || 0) > 0) answerCounts[outgoing.hits] += 1;
      const threatPoint = koPoints(incoming.hits ?? 99, incoming.chance ?? 0);
      const answerPoint = koPoints(outgoing.hits ?? 99, outgoing.chance ?? 0);
      legacyThreat.push(threatPoint);
      legacyAnswer.push(answerPoint);
      if (threatPoint > koPoints(bestThreat.hits ?? 99, bestThreat.chance ?? 0)) bestThreat = { ...incoming };
      if (compareTuples(displayQuality(rawIncoming), displayQuality(bestRawThreat)) < 0) bestRawThreat = { ...rawIncoming };
      if (quality > Number(bestSpeedAnswer.quality ?? -9999)) bestSpeedAnswer = { ...outgoing };
      if (compareTuples(damageDisplayKey(rawOutgoing), damageDisplayKey(bestRawAnswer)) > 0) bestRawAnswer = { ...rawOutgoing };
      for (const r of [incoming, outgoing, rawIncoming, rawOutgoing]) {
        const w = String(r.weather || "None");
        if (w && w !== "None") usedWeather.add(w);
      }
      breakdown.push({
        team_mon: this.display(teamMon),
        threat_mon: String(rawIncoming.attacker || name),
        incoming_result: { ...incoming },
        outgoing_result: { ...outgoing },
        raw_incoming_result: { ...rawIncoming },
        raw_outgoing_result: { ...rawOutgoing },
        first_result: first,
        incoming_move: incoming.move ?? "—",
        incoming_label: incoming.label ?? "No damage",
        incoming_percent: incoming.percent ?? "0-0%",
        incoming_hits: incoming.hits ?? 99,
        incoming_chance: incoming.chance ?? 0,
        incoming_speed: incoming.attacker_speed ?? 0,
        incoming_priority: incoming.move_priority ?? 0,
        outgoing_move: outgoing.move ?? "—",
        outgoing_label: outgoing.label ?? "No damage",
        outgoing_percent: outgoing.percent ?? "0-0%",
        outgoing_hits: outgoing.hits ?? 99,
        outgoing_chance: outgoing.chance ?? 0,
        outgoing_speed: outgoing.attacker_speed ?? 0,
        outgoing_priority: outgoing.move_priority ?? 0,
        speed_note: incoming.speed_tier_note || outgoing.speed_tier_note || "",
        quality,
      });
    });

    const teamSize = Math.max(1, teamMons.length);
    const incomingWeighted = breakdown.reduce((sum, row) => sum + resultKoWeight(row.incoming_result), 0);
    const outgoingWeighted = breakdown.reduce((sum, row) => sum + resultKoWeight(row.outgoing_result), 0);
    const threatScore = Math.max(0, Math.min(100, 50 + (incomingWeighted - outgoingWeighted * 0.82) * (50 / teamSize)));
    const displayForm = String(bestThreat.attacker || name);
    const row = {
      name: displayForm || name,
      base_name: baseSpecies,
      form: displayForm.includes("/") ? displayForm.split("/", 2)[1] : (variants[0]?.form_name || name),
      position: meta.position ?? 9999,
      score: pyRoundTo(threatScore, 2),
      their_best: bestThreat,
      our_best: bestRawAnswer,
      our_best_speed_adjusted: bestSpeedAnswer,
      threat_counts: threatCounts,
      answer_counts: answerCounts,
      weather_used: [...usedWeather].sort(),
      top_items: [...topItems],
      top_moves: [...threatMoves],
      threat_spread_label: String(bestRawThreat.attacker_spread_label || bestThreat.attacker_spread_label || "").trim(),
      threat_ability: String(bestRawThreat.attacker_ability_v420 || (variants[0]?.ability ?? "")),
      breakdown: [...breakdown].sort((a, b) => (Number(b.quality) || 0) - (Number(a.quality) || 0)),
      score_basis_v78: `Incoming weighted OHKO/2HKO/3HKO pressure ${incomingWeighted.toFixed(2)}; team answer pressure ${outgoingWeighted.toFixed(2)}`,
      calc_items_considered_v451: topItems.length,
      calc_moves_considered_v451: threatMoves.length,
      calc_threat_variants_v451: variants.length,
    };
    const corrected = chooseBestAnswer(row.breakdown, row.our_best);
    if (corrected && Object.keys(corrected).length) row.our_best = corrected;
    return {
      row: cleanThreatItems(row),
      offense: legacyAnswer.reduce((a, b) => a + b, 0) / teamSize,
      defense: Math.max(0, 100 - legacyThreat.reduce((a, b) => a + b, 0) / teamSize),
    };
  }

  /** team_threats: V451 settings-aware core, V453 Top-X canonicalisation. */
  teamThreats(teamMons, { onProgress } = {}) {
    if (!teamMons.length) return { threats: [], legacyOffense: 0, legacyDefense: 0 };
    const teamVariantSets = teamMons.map((mon) => this.teamVariants(mon));
    const metaRows = this.topMeta(this.settings.top_meta);
    const threats = [];
    const offenseScores = [];
    const defenseScores = [];
    metaRows.forEach((meta, metaIndex) => {
      if (!String(meta.name || "").trim()) return;
      const { row, offense, defense } = this.threatRow(meta, teamMons, teamVariantSets);
      threats.push(row);
      offenseScores.push(offense);
      defenseScores.push(defense);
      onProgress?.(metaIndex + 1, metaRows.length, meta.name);
    });
    const canonical = new Map();
    metaRows.forEach((meta, index) => {
      const base = String(meta._v124_base_species || meta.base_name || meta.name || "").trim();
      const k = compact(this.baseSpeciesFromDisplay(base || meta.name));
      if (k) canonical.set(k, { position: Number(meta.position ?? index + 1) || index + 1, base_name: base || meta.name });
    });
    const seen = new Set();
    const clean = [];
    for (const raw of threats) {
      let k = compact(this.baseSpeciesFromDisplay(raw.base_name || raw.name || ""));
      let info = canonical.get(k);
      if (!info) {
        k = compact(this.baseSpeciesFromDisplay(raw.name || ""));
        info = canonical.get(k);
      }
      if (!info || seen.has(k)) continue;
      seen.add(k);
      clean.push({ ...raw, base_name: info.base_name, position: info.position, top_x_member_v453: true });
    }
    clean.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (a.position - b.position) || String(a.base_name || a.name).localeCompare(String(b.base_name || b.name)));
    const legacyOffense = offenseScores.reduce((a, b) => a + b, 0) / Math.max(1, offenseScores.length);
    const legacyDefense = defenseScores.reduce((a, b) => a + b, 0) / Math.max(1, defenseScores.length);
    const sorted = [...threats].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (Number(a.position) || 999999) - (Number(b.position) || 999999) || String(a.name).localeCompare(String(b.name)));
    const overview = this.pressureOverview(teamMons, sorted, legacyOffense, legacyDefense);
    return { threats: clean, legacyOffense, legacyDefense, overview, offense: overview.offense_score, defense: overview.defense_score };
  }

  // --- Offense / Defense: the pressure overview (V188, V191, V192, V494) ---------------

  /** _simple_move_info_v187: type, category and power (damaging moves default to 70). */
  simpleMoveInfo(move) {
    const recorded = this.engine.moves[this.engine.canonicalMoveName(move)]?.simple;
    if (Array.isArray(recorded)) return [recorded[0] || "Normal", String(recorded[1] || "status").toLowerCase(), Number(recorded[2]) || 0];
    const meta = this.meta(move);
    const type = pyTitle(String(meta.type || "Normal"));
    let category = String(meta.category || "").toLowerCase();
    let power = Number(meta.power) || 0;
    if ((category === "physical" || category === "special") && power <= 0) power = 70;
    if (!category) category = power <= 0 ? "status" : "physical";
    return [type || "Normal", category, power];
  }

  typesFor(mon) {
    return [...(this.engine.pokemon(mon.pokemon_name, mon.form_name)?.types || [])].map((t) => pyTitle(String(t))).filter((t) => TYPES.includes(t));
  }

  statsFor(mon) {
    const raw = this.engine.finalStats(makeMon(mon)) || {};
    const out = {};
    for (const k of ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"]) out[k] = Math.max(1, Number(raw[k]) || 1);
    return out;
  }

  /** _v188_team_records */
  teamRecords(teamMons) {
    return teamMons.map((mon, index) => ({
      owner: index,
      name: this.display(mon),
      pokemon: mon.pokemon_name,
      form: mon.form_name,
      types: this.typesFor(mon),
      stats: this.statsFor(mon),
      moves: (mon.moves || []).map((m) => String(m).trim()).filter(Boolean).slice(0, 4),
      mon: { ...mon, analysis_side: "team", analysis_slot: index },
      set_aware: true,
    }));
  }

  /** _v192_meta_common_set: one coherent most-common set per meta threat. */
  metaCommonSet(base, form, row) {
    const common = this.commonSet(base);
    let moves = (common.moves || []).filter((m) => String(m).trim()).slice(0, 4);
    if (!moves.length) moves = this.usagePairs(base, "move", 4).map(([m]) => m).slice(0, 4);
    const isMega = Boolean(row._v124_is_mega) || (compact(form) !== compact(base) && String(form || "").toLowerCase().includes("mega"));
    let item = String(common.item || "");
    let ability = String(common.ability || "");
    if (isMega) {
      const required = String(row.top_item || row.threat_item || "").trim();
      if (required) item = required;
      ability = this.megaAbility(base, form, ability);
    }
    const mon = makeMon({ pokemon_name: base, form_name: form || base, item, ability, nature_name: common.nature_name || "Serious", bonuses: [...(common.bonuses || [0, 0, 0, 0, 0, 0])], moves });
    mon.analysis_side = "threat";
    mon.uses_most_common_set = true;
    return mon;
  }

  /** _v188_meta_records */
  metaPressureRecords(topX) {
    const out = [];
    this.topMeta(topX).forEach((row, index) => {
      const base = String(row._v124_base_species || row.base_name || row.pokemon_name || row.pokemon || row.name || "").trim();
      const form = String(row._v124_threat_form || row.form_name || row.form || row.name || base).trim() || base;
      if (!base) return;
      const mon = this.metaCommonSet(base, form, row);
      out.push({
        owner: index,
        name: String(row.name || form).trim(),
        pokemon: base,
        form,
        position: Number(row.position ?? index + 1) || index + 1,
        types: this.typesFor(mon),
        stats: this.statsFor(mon),
        moves: mon.moves.slice(0, 4),
        mon,
        set_aware: true,
      });
    });
    return out;
  }

  /** _v188_profile: the average type chart and the damage-move list. */
  profile(records, label) {
    const chart = {};
    for (const type of TYPES) {
      const values = records.map((r) => (r.types.length ? this.engine.typeMultiplier(type, r.types) : 1));
      chart[type] = records.length ? values.reduce((a, b) => a + b, 0) / records.length : 1;
    }
    const excluded = new Set(String(this.settings.exclude_moves || "").split(/[,;]/).map(compact).filter(Boolean));
    const damageMoves = [];
    for (const record of records) {
      const ownerTypes = new Set(record.types);
      for (const move of record.moves.slice(0, 4)) {
        const clean = String(move || "").trim();
        if (!clean || excluded.has(compact(clean))) continue;
        const [type, category, power] = this.simpleMoveInfo(clean);
        if (category !== "physical" && category !== "special") continue;
        const numeric = power > 0 ? power : 70;
        damageMoves.push({
          owner: record.owner, owner_name: record.name, move: clean, type, category,
          power: Math.max(20, Math.min(180, numeric)), stab: ownerTypes.has(type) ? 1.5 : 1,
          attacker_mon: record.mon, set_aware: record.set_aware,
        });
      }
    }
    return { label, count: records.length, names: records.map((r) => r.name), records, defensive_type_chart: chart, damage_moves: damageMoves };
  }

  /** _v191_set_adjusted_damage: per-matchup damage, capped at 100% before averaging. */
  setAdjustedDamage(move, targetProfile) {
    const attacker = move.attacker_mon;
    if (!attacker || !move.set_aware || !targetProfile.records.length) return null;
    const raw = [];
    const capped = [];
    for (const target of targetProfile.records) {
      const ctx = this.calcContext(attacker, target.mon, move.move);
      const result = this.calculate(attacker, target.mon, ctx);
      const rolls = (result.rolls_with_resist_berry && result.rolls_with_resist_berry.length ? result.rolls_with_resist_berry : result.rolls || []).filter((v) => typeof v === "number");
      const hp = Number(result.current_hp || result.max_hp || 0);
      const pct = rolls.length && hp > 0 ? Math.max(0, (rolls.reduce((a, b) => a + b, 0) / rolls.length) * 100 / hp) : 0;
      raw.push(pct);
      capped.push(Math.min(100, pct));
    }
    if (!raw.length) return null;
    const avg = (list) => list.reduce((a, b) => a + b, 0) / list.length;
    return { adjusted_damage: avg(capped), actual_damage: avg(raw), samples: raw.length };
  }

  /**
   * _v188_directional_pressure: each Pokemon's two strongest moves, averaged.
   * `useSets` is the app's use_current_team_sets: the Team Evaluation prices each
   * move with the full damage engine, the Team Overview charts only by type and power.
   */
  directionalPressure(source, target, useSets = true) {
    const chart = target.defensive_type_chart;
    const ownerCount = Math.max(1, source.count);
    const byOwner = new Map();
    const all = [];
    for (const move of source.damage_moves) {
      const multiplier = Math.max(0, chart[move.type] ?? 1);
      const power = Math.max(20, Math.min(180, move.power));
      const effective = (power / 80) * Math.max(1, move.stab) * multiplier;
      let pressure = clamp100(40 * effective);
      const set = useSets ? this.setAdjustedDamage(move, target) : null;
      if (set) pressure = clamp100(set.adjusted_damage);
      const row = { ...move, target_multiplier: multiplier, pressure, uses_current_set: Boolean(set), set_adjusted_damage: set?.adjusted_damage || 0 };
      if (!byOwner.has(move.owner)) byOwner.set(move.owner, []);
      byOwner.get(move.owner).push(row);
      all.push(row);
    }
    const chosen = [];
    const ownerScores = [];
    for (let owner = 0; owner < ownerCount; owner += 1) {
      const ranked = [...(byOwner.get(owner) || [])].sort((a, b) => b.pressure - a.pressure || String(a.move).localeCompare(String(b.move)));
      const best = ranked.slice(0, 2);
      chosen.push(...best);
      ownerScores.push(best.length ? best.reduce((s, r) => s + r.pressure, 0) / best.length : 0);
    }
    const n = Math.max(1, chosen.length);
    return {
      score: clamp100(ownerScores.reduce((a, b) => a + b, 0) / Math.max(1, ownerScores.length)),
      move_count: source.damage_moves.length,
      selected_move_count: chosen.length,
      average_type_multiplier: chosen.length ? chosen.reduce((s, r) => s + r.target_multiplier, 0) / n : 1,
      average_power: chosen.length ? chosen.reduce((s, r) => s + r.power, 0) / n : 0,
      average_stab: chosen.length ? chosen.reduce((s, r) => s + r.stab, 0) / n : 1,
      physical_share: chosen.length ? chosen.filter((r) => r.category === "physical").length / n : 0,
      special_share: chosen.length ? chosen.filter((r) => r.category === "special").length / n : 0,
      top_moves: [...chosen].sort((a, b) => b.pressure - a.pressure || String(a.owner_name).localeCompare(String(b.owner_name)) || String(a.move).localeCompare(String(b.move))).slice(0, 12)
        .map(({ attacker_mon: _a, ...rest }) => rest),
      type_summary: Object.fromEntries(TYPES.map((type) => {
        const rows = all.filter((r) => r.type === type);
        return [type, { count: rows.length, pressure: rows.length ? rows.reduce((s, r) => s + r.pressure, 0) / rows.length : 0, multiplier: chart[type] ?? 1 }];
      })),
    };
  }

  /** _v188_critical_components (V310 rows, V465 best-answer text) */
  criticalComponents(threats, legacyOffense, legacyDefense) {
    const displayRows = threats.map((t) => {
      const score = Number(t.score) || 0;
      const result = t.our_best_speed_adjusted || t.our_best || {};
      const answer = Number(result.score ?? legacyOffense) || 0;
      return { name: String(t.name || t.base_name || "Threat"), score: clamp100(score), answer: clamp100(answer), severity: score >= RED ? "red" : score >= YELLOW ? "yellow" : "neutral" };
    }).sort((a, b) => b.answer - a.answer || b.score - a.score || a.name.localeCompare(b.name));
    const critical = coloredThreats(threats);
    if (!critical.length) {
      return { count: 0, average_score: 0, worst_score: 0, answer_score: 100, safety_score: 100, legacy_offense: clamp100(legacyOffense), legacy_defense: clamp100(legacyDefense), rows: displayRows, critical_rows: [] };
    }
    let weightedScore = 0;
    let weightedAnswer = 0;
    let totalWeight = 0;
    const criticalRows = critical.map((t) => {
      const score = Number(t.score) || 0;
      const weight = 1 + Math.max(0, score - YELLOW) / Math.max(1, 100 - YELLOW);
      const result = t.our_best_speed_adjusted || t.our_best || {};
      const answer = Number(result.score ?? legacyOffense) || 0;
      weightedScore += score * weight;
      weightedAnswer += clamp100(answer) * weight;
      totalWeight += weight;
      return { name: String(t.name || t.base_name || "Threat"), score, answer: clamp100(answer), severity: score >= RED ? "red" : "yellow" };
    });
    const averageScore = weightedScore / Math.max(1, totalWeight);
    return {
      count: critical.length,
      average_score: averageScore,
      worst_score: Math.max(0, ...criticalRows.map((r) => r.score)),
      answer_score: weightedAnswer / Math.max(1, totalWeight),
      safety_score: clamp100(100 - Math.max(0, averageScore - YELLOW) * (100 / Math.max(1, 100 - YELLOW))),
      legacy_offense: clamp100(legacyOffense),
      legacy_defense: clamp100(legacyDefense),
      rows: displayRows,
      critical_rows: criticalRows,
    };
  }

  /** _v188_build_pressure_overview */
  pressureOverview(teamMons, threats, legacyOffense, legacyDefense) {
    const topX = this.settings.top_meta;
    const teamProfile = this.profile(this.teamRecords(teamMons), "Your Team");
    const metaProfile = this.profile(this.metaPressureRecords(topX), `Top ${topX} Meta`);
    const outgoing = this.directionalPressure(teamProfile, metaProfile);
    const incoming = this.directionalPressure(metaProfile, teamProfile);
    const critical = this.criticalComponents(threats, legacyOffense, legacyDefense);
    const offense = clamp100(outgoing.score * 0.7 + critical.answer_score * 0.3);
    const resistance = clamp100(100 - incoming.score);
    const defense = clamp100(resistance * 0.7 + critical.safety_score * 0.3);
    const strip = (profile) => ({ ...profile, records: profile.records.map(({ mon: _m, ...rest }) => rest), damage_moves: profile.damage_moves.map(({ attacker_mon: _a, ...rest }) => rest) });
    return {
      version: "per_matchup_overkill_cap_v193",
      top_x: topX,
      meta_count: metaProfile.count,
      team: strip(teamProfile),
      meta: strip(metaProfile),
      team_to_meta: outgoing,
      meta_to_team: incoming,
      critical,
      pressure_weight: 0.7,
      critical_weight: 0.3,
      defense_pressure_resistance: resistance,
      offense_score: offense,
      defense_score: defense,
      formula: "70% per-matchup capped set damage and typing pressure + 30% yellow/red Critical Threat results",
    };
  }

  /** _v463_best_between_no_yield */
  bestBetween(attackers, defenders) {
    let best = {
      score: 0, label: "No damage", full_label: "No damage", move: "—", attacker: "—", defender: "—",
      hits: 99, chance: 0, full_hits: 99, full_chance: 0, weather: "None", percent: "0-0%",
      quality: -9999, attacker_speed: 0, move_priority: 0, attacker_spread_label: "", defender_spread_label: "",
    };
    const keyOf = (r) => [-bestRank(r), Number(r.chance) || 0, Number(r.score) || 0, -(Number.parseInt(r.full_hits, 10) || 99), Number(r.full_chance) || 0, Number.parseInt(r.move_priority, 10) || 0, Number(r.attacker_speed) || 0];
    for (const attacker of attackers || []) {
      for (const defender of defenders || []) {
        const result = this.bestAttack(attacker, defender, attacker.moves || []);
        result.attacker = this.display(attacker);
        result.defender = this.display(defender);
        result.item = String(attacker.item || "");
        result.attacker_side = this.side(attacker);
        result.defender_side = this.side(defender);
        result.attacker_spread_label = String(attacker.stat_spread_label || result.attacker_spread_label || "");
        result.defender_spread_label = String(defender.stat_spread_label || result.defender_spread_label || "");
        if (compareTuples(keyOf(result), keyOf(best)) > 0) best = { ...result };
      }
    }
    return best;
  }
}


/** _v36_ko_event_index */
function koEventIndex(result, goesFirst) {
  const hits = bestRank(result);
  if (![1, 2, 3].includes(hits) || (Number(result?.chance) || 0) <= 0) return 9999;
  return hits * 2 - (goesFirst ? 1 : 0);
}

/** _v36_suppress_ko */
function suppressKo(result, winner) {
  const out = { ...result };
  out.pre_speed_tier_label = result.label ?? "No damage";
  out.pre_speed_tier_hits = result.hits ?? 99;
  out.pre_speed_tier_score = result.score ?? 0;
  const name = String(winner.attacker || winner.attacker_mon || "the faster Pokémon");
  const move = String(winner.move || "its move");
  Object.assign(out, {
    score: 0, hits: 99, chance: 0, label: "Knocked out before it can KO", speed_tier_suppressed: true,
    speed_tier_note: `${name} uses ${move} first; this Pokemon is knocked out before it can KO.`,
  });
  return out;
}

/** Python round(x, n) for display values (half-even at the last digit). */
function pyRoundTo(value, digits) {
  const factor = 10 ** digits;
  return pyRoundInt(value * factor) / factor;
}

/** _v33_unique: whitespace-collapsed names, unique by compact key. */
function uniqueTa(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const clean = String(value ?? "").replace(/\s+/g, " ").trim();
    const k = clean.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (clean && !seen.has(k)) {
      seen.add(k);
      out.push(clean);
    }
  }
  return out;
}

const SPREAD_LABELS = ["HP", "ATK", "DEF", "SPA", "SPD", "SPE"];

/** _v40_spread_points_compact */
export function spreadPointsCompact(bonuses) {
  const parts = (bonuses || []).slice(0, 6).map((v, i) => ((Number(v) || 0) > 0 ? `${SPREAD_LABELS[i]}${Math.trunc(v)}` : "")).filter(Boolean);
  return parts.length ? parts.join(" ") : "neutral points";
}

/** _v40_result_quality_for_display (lower is a stronger incoming line) */
function displayQuality(r) {
  return [bestRank(r), -(Number(r.chance) || 0), -(Number(r.score) || 0), Number.parseInt(r.full_hits, 10) || 99, -(Number(r.full_chance) || 0)];
}

/** _v450_result_has_damage */
function resultHasDamage(r) {
  if (!r || String(r.move || "—") === "—") return false;
  if ((r.rolls || []).some((v) => Number(v) > 0)) return true;
  if ((Number(r.score) || 0) > 0) return true;
  return (Number.parseInt(r.full_hits, 10) || 99) < 99;
}

/** _v450_damage_display_key */
function damageDisplayKey(r) {
  if (!r || typeof r !== "object") return [0, -99, 0, 0, -99, 0];
  return [resultHasDamage(r) ? 1 : 0, -bestRank(r), Number(r.chance) || 0, Number(r.score) || 0, -(Number.parseInt(r.full_hits, 10) || 99), Number(r.full_chance) || 0];
}

/** team_evaluation_v465.percent_bounds */
export function percentBounds(value) {
  const numbers = [...String(value ?? "").replace(/[–—]/g, "-").matchAll(/(\d+(?:\.\d+)?)\s*%?/g)].map((m) => Number(m[1]));
  if (!numbers.length) return [0, 0];
  if (numbers.length === 1) return [numbers[0], numbers[0]];
  return [Math.min(numbers[0], numbers[1]), Math.max(numbers[0], numbers[1])];
}

/** team_evaluation_v465.ko_tier */
export function koTier(result, baseline = false) {
  let data = result || {};
  if (baseline && data.baseline_result_v420 && typeof data.baseline_result_v420 === "object") data = data.baseline_result_v420;
  const [low] = percentBounds(data.percent);
  if (low >= 100) return 1;
  const hits = Number.parseInt(data.hits, 10) || 99;
  return [1, 2, 3].includes(hits) ? hits : 99;
}

function v465DamageKey(result) {
  const [low, high] = percentBounds(result?.percent);
  return [(low + high) / 2, high, Number(result?.chance) || 0];
}

/** team_evaluation_v465.reliable_answer */
function reliableAnswer(result) {
  if (!result || !Object.keys(result).length || String(result.move || "—") === "—" || result.speed_tier_suppressed) return false;
  return [1, 2, 3].includes(koTier(result)) && (Number(result.chance) || 0) > 0;
}

/** team_evaluation_v465.choose_best_answer */
export function chooseBestAnswer(breakdown, fallback) {
  const candidates = [];
  for (const row of breakdown || []) {
    const outgoing = row.outgoing_result || {};
    const rawOutgoing = row.raw_outgoing_result || {};
    const result = Object.keys(outgoing).length && !outgoing.speed_tier_suppressed ? outgoing : (Object.keys(rawOutgoing).length ? rawOutgoing : outgoing);
    if (!result || !Object.keys(result).length) continue;
    const incoming = Object.keys(row.incoming_result || {}).length ? row.incoming_result : (row.raw_incoming_result || {});
    candidates.push([result, incoming, Number(row.quality) || 0]);
  }
  let damaging = candidates.filter(([o]) => reliableAnswer(o));
  const survivors = damaging.filter(([o]) => !o.outsped_and_ohkod_v494);
  if (survivors.length) damaging = survivors;
  const maxBy = (items, keyFn) => items.reduce((best, item) => (best === null || compareTuples(keyFn(item), keyFn(best)) > 0 ? item : best), null);
  if (damaging.length) {
    return { ...maxBy(damaging, ([o, , q]) => { const d = v465DamageKey(o); return [q, -koTier(o), d[0], d[1], d[2]]; })[0] };
  }
  if (candidates.length) {
    return { ...maxBy(candidates, ([o, i, q]) => { const t = koTier(i); const d = v465DamageKey(o); return [t !== 99 ? t : 9, -(Number(i.chance) || 0), q, d[0], d[1]]; })[0] };
  }
  return { ...(fallback || {}) };
}

/** _v124_clean_threat_items */
function cleanThreatItems(threat) {
  const out = { ...threat };
  const seen = new Set();
  const strict = [];
  for (const value of out._v124_strict_top_items || out.top_items || []) {
    const text = String(value || "").trim();
    const k = compact(text);
    if (!text || !k || seen.has(k)) continue;
    seen.add(k);
    strict.push(text);
    if (strict.length >= 12) break;
  }
  if (strict.length) {
    out._v124_strict_top_items = strict;
    out.top_items = strict;
  } else {
    out.top_items = [];
  }
  return out;
}

function attachRange(result, span, minLabel, maxLabel) {
  const out = { ...result };
  if (!span.is_range) return out;
  const low = span.min_result || {};
  const high = span.max_result || {};
  Object.assign(out, {
    condition_range: true,
    range_min_result: low,
    range_max_result: high,
    range_min_percent: String(low.percent || "0-0%"),
    range_max_percent: String(high.percent || "0-0%"),
    range_min_label: String(minLabel || low.ko || ""),
    range_max_label: String(maxLabel || high.ko || ""),
    range_min_condition: String(span.min_condition || "worst case"),
    range_max_condition: String(span.max_condition || "best case"),
  });
  return out;
}


export function monSignature(mon) {
  if (!mon) return "";
  return [mon.pokemon_name, mon.form_name, mon.item, mon.ability, mon.nature_name, (mon.bonuses || []).join("."), (mon.moves || []).join("."), mon.analysis_side || "",
    mon.current_hp_percent, mon.status, mon.attack_stage, mon.defense_stage, mon.sp_attack_stage, mon.sp_defense_stage, mon.speed_stage, mon.gender].join("/");
}

export { DamageEngine };
