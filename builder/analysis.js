// Team analysis for the website: Team Overview, Team Evaluation, suggestions
// and Auto Build.  Pure functions over BuilderData, so the same code runs on the
// page and inside builder/analysis-worker.js.
//
// It follows the Companion's model where the app pins one down:
//   * the meta is the top-X ranked Pokemon, each playing its most common set;
//   * every number comes from the ported damage engine (same rolls as the app);
//   * Offense  = set-aware damage pressure into the meta, at full weight (V512;
//                before it, 70% of that + 30% how well the team answers its
//                critical threats, V188)
//   * Defense  = 100 - the meta's pressure into the team, at full weight (V512;
//                before it, 70% of that + 30% critical-threat safety, V188)
//     Critical Threat answers and safety are still reported in full beside the
//     scores - they are simply no longer part of them;
//   * Speed    = the V36 blend of Trick Room, standard speed, answers to an
//                opposing Tailwind and priority; a Trick Room team leads on
//                Trick Room and keeps the other two parts (V512);
//   * the Team Building Checks use the V201 thresholds and the V418 Mega rule,
//     and the archetype is the V462 feature classifier;
//   * a critical threat is one whose best line into the team is a 1-3HKO (V462).

import { makeContext } from "./engine.js";
import { TYPES, monFromSet, setFromCommon } from "./common.js";

const key = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, value));
const sum = (list) => list.reduce((total, value) => total + value, 0);
const mean = (list) => (list.length ? sum(list) / list.length : 0);

// Move groups (V187 / V403), keyed the app's compact way.
const PROTECT = new Set(["protect", "detect", "spikyshield", "banefulbunker", "kingsshield", "burningbulwark", "silktrap", "obstruct"]);
const SPEED = new Set(["tailwind", "trickroom", "icywind", "electroweb", "thunderwave", "scaryface", "stringshot", "cottonspore", "bulldoze", "rocktomb", "lowsweep", "quash", "afteryou"]);
const PRIORITY = new Set(["fakeout", "suckerpunch", "extremespeed", "aquajet", "bulletpunch", "machpunch", "iceshard", "shadowsneak", "grassyglide", "jetpunch", "firstimpression", "vacuumwave", "quickattack", "accelerock", "upperhand", "thunderclap", "watershuriken", "feint"]);
const POSITIONING = new Set(["fakeout", "followme", "ragepowder", "spotlight", "wideguard", "quickguard", "uturn", "voltswitch", "flipturn", "partingshot", "chillyreception", "teleport"]);
const SPREAD = new Set(["heatwave", "rockslide", "dazzlinggleam", "earthquake", "surf", "muddywater", "discharge", "blizzard", "hypervoice", "snarl", "icywind", "electroweb", "eruption", "waterspout", "expandingforce", "makeitrain", "sludgewave", "boomburst", "dragonenergy", "astralbarrage", "glaciallance", "precipiceblades", "originpulse"]);
const UTILITY = {
  "Fake Out": new Set(["fakeout"]),
  "Redirection": new Set(["followme", "ragepowder", "spotlight"]),
  "Speed Control": SPEED,
  "Setup Denial": new Set(["taunt", "haze", "clearsmog", "encore", "disable", "imprison", "roar", "whirlwind", "dragontail", "circlethrow", "perishsong"]),
  "Spread Defense": new Set(["wideguard", "quickguard", "matblock"]),
  "Damage Support": new Set(["helpinghand", "coaching", "decorate"]),
  "Pivoting": new Set(["uturn", "voltswitch", "flipturn", "partingshot", "chillyreception", "teleport"]),
  "Healing": new Set(["lifedew", "healpulse", "floralhealing", "junglehealing", "pollenpuff", "wish", "recover", "roost", "synthesis", "moonlight", "morningsun", "strengthsap"]),
  "Screens": new Set(["reflect", "lightscreen", "auroraveil", "safeguard"]),
  "Status": new Set(["spore", "sleeppowder", "hypnosis", "willowisp", "thunderwave", "toxic", "yawn", "stunspore", "glare", "nuzzle", "charm", "snarl"]),
};
const WEATHER_SET = { sun: new Set(["sunnyday", "drought", "orichalcumpulse"]), rain: new Set(["raindance", "drizzle", "primordialsea"]), sand: new Set(["sandstorm", "sandstream", "sandspit"]), snow: new Set(["snowscape", "snowwarning", "chillyreception"]) };
const WEATHER_USE = { sun: new Set(["chlorophyll", "solarpower", "protosynthesis"]), rain: new Set(["swiftswim", "raindish", "hydration", "dryskin"]), sand: new Set(["sandrush", "sandforce", "sandveil"]), snow: new Set(["slushrush", "icebody", "snowcloak"]) };
const TERRAIN_SET = { electric: new Set(["electricterrain", "electricsurge", "hadronengine"]), grassy: new Set(["grassyterrain", "grassysurge"]), psychic: new Set(["psychicterrain", "psychicsurge"]), misty: new Set(["mistyterrain", "mistysurge"]) };
const SETUP = new Set(["swordsdance", "nastyplot", "calmmind", "dragondance", "quiverdance", "bulkup", "shellsmash", "coil", "irondefense", "agility", "tailglow", "geomancy", "bellydrum", "filletaway", "tidyup", "shiftgear"]);
const RECOVERY = new Set(["recover", "roost", "slackoff", "softboiled", "milkdrink", "shoreup", "synthesis", "moonlight", "morningsun", "strengthsap", "wish", "lifedew", "healpulse", "pollenpuff", "floralhealing", "junglehealing"]);
const DENIAL = new Set(["taunt", "haze", "clearsmog", "encore", "disable", "imprison", "spore", "sleeppowder", "hypnosis", "willowisp", "thunderwave", "toxic", "yawn", "glare", "nuzzle", "perishsong", "roar", "whirlwind"]);
const SCREENS = new Set(["reflect", "lightscreen", "auroraveil"]);
const REDIRECTION = new Set(["followme", "ragepowder", "spotlight"]);
const PIVOTS = new Set(["uturn", "voltswitch", "flipturn", "partingshot", "chillyreception", "teleport"]);
const TRAP_MOVES = new Set(["meanlook", "block", "spiderweb", "infestation", "firespin", "whirlpool", "sandtomb", "magmastorm", "thousandwaves", "anchorshot", "spiritshackle"]);
const WEATHER_ABILITY = { drizzle: "Rain", primordialsea: "Rain", drought: "Sun", orichalcumpulse: "Sun", desolateland: "Sun", sandstream: "Sand", sandspit: "Sand", snowwarning: "Snow", snowcloak: "Snow" };
const TERRAIN_ABILITY = { electricsurge: "Electric", hadronengine: "Electric", grassysurge: "Grassy", psychicsurge: "Psychic", mistysurge: "Misty" };

export const ARCHETYPES = ["Auto", "Balanced", "Offense", "Hyper Offense", "Bulky Offense", "Trick Room", "Tailwind", "Rain", "Sun", "Sand", "Snow", "Terrain", "Setup", "Goodstuff", "Stall"];

// --- records -------------------------------------------------------------------

/** A set with everything the analysis needs precomputed. */
export function record(data, set, extra = {}) {
  const mon = monFromSet(set);
  const effective = data.engine.effectiveMegaMon(mon);
  const types = data.engine.pokemon(effective.pokemon_name, effective.form_name).types || [];
  const stats = data.engine.finalStats(mon);
  return {
    set,
    mon,
    ability: effective.ability || set.ability || "",
    types,
    stats,
    name: data.displayName(effective.pokemon_name, effective.form_name, set.form),
    key: `${set.species}|${set.form}|${set.item}|${set.ability}|${(set.moves || []).join(",")}|${set.nature}|${(set.bonuses || []).join(",")}`,
    isMega: effective.form_name !== (set.form || set.species) && /(^|[\s-])mega([\s-]|$)/i.test(effective.form_name),
    megaCapable: data.isMegaStone(set.item) && effective.form_name !== (set.form || set.species),
    ...extra,
  };
}

export async function metaRecords(data, format, top = 40) {
  const meta = await data.loadMeta(format);
  return meta.pokemon.slice(0, top).map((row) => record(data, setFromCommon(data.commonSet(format, row.species, row.form)), {
    position: row.position,
    usageName: row.name,
    usage: row,
  }));
}

// --- matchup maths --------------------------------------------------------------

function autoField(data, a, b) {
  const setters = [];
  [a, b].forEach((rec, index) => {
    const weather = WEATHER_ABILITY[key(rec.ability)];
    if (weather) setters.push([rec.stats.speed || 0, index, weather]);
  });
  setters.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  const weather = setters.length ? setters[setters.length - 1][2] : "None";
  const terrain = TERRAIN_ABILITY[key(a.ability)] || TERRAIN_ABILITY[key(b.ability)] || "None";
  return { weather, terrain };
}

/** `_v253_ko_summary`, with move accuracy folded into the chance. */
export function koSummary(result) {
  const rolls = (result.rolls || []).filter((v) => Number.isFinite(v));
  const hp = Math.max(1, Number(result.current_hp || result.max_hp || 1));
  const accuracy = Math.max(0, Math.min(1, Number(result.move_accuracy_factor ?? 1)));
  if (!rolls.length || Math.max(...rolls) <= 0) return { tier: 4, score: 0, label: "No damage", avgPct: 0, chance: 0 };
  const average = mean(rolls);
  const avgPct = (average * 100) / hp;
  const ohko = (rolls.filter((r) => r >= hp).length / rolls.length) * accuracy;
  if (Math.min(...rolls) >= hp && accuracy >= 0.999) return { tier: 1, score: 100, label: "Guaranteed OHKO", avgPct, chance: 1 };
  if (ohko > 0) return { tier: 1, score: 88 + 12 * ohko, label: chanceLabel(1, ohko), avgPct, chance: ohko };
  let pairs = 0;
  for (const a of rolls) for (const b of rolls) if (a + b >= hp) pairs += 1;
  const twohko = (pairs / (rolls.length ** 2)) * accuracy * accuracy;
  if (Math.min(...rolls) * 2 >= hp && accuracy >= 0.999) return { tier: 2, score: 78, label: "Guaranteed 2HKO", avgPct, chance: 1 };
  if (twohko > 0) return { tier: 2, score: 58 + 20 * twohko, label: chanceLabel(2, twohko), avgPct, chance: twohko };
  if (Math.max(...rolls) * 3 >= hp) {
    const threehko = Math.min(1, Math.max(0, (average * 3 - hp * 0.94) / (hp * 0.12 + 1))) * accuracy;
    const chance = Math.min(...rolls) * 3 >= hp ? accuracy : Math.max(0.05, threehko);
    return { tier: 3, score: Math.min(55, Math.max(1, avgPct * 0.82)), label: chanceLabel(3, chance), avgPct, chance };
  }
  return { tier: 4, score: Math.min(40, Math.max(1, avgPct * 0.82)), label: `${Math.round(avgPct)}% (4HKO+)`, avgPct, chance: 0 };
}

function chanceLabel(hits, chance) {
  const label = hits === 1 ? "OHKO" : `${hits}HKO`;
  if (chance >= 0.999) return `Guaranteed ${label}`;
  if (chance > 0 && chance < 0.005) return `Less than 1% to ${label}`;
  return `${Math.max(1, Math.round(chance * 100))}% to ${label}`;
}

export class Matchups {
  constructor(data, format) {
    this.data = data;
    this.format = format;
    this.cache = new Map();
    this.calls = 0;
  }

  damage(attacker, defender, move) {
    const cacheKey = `${attacker.key}>${defender.key}>${move}`;
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;
    const meta = this.data.engine.moveMeta(makeContext({ move_name: move }));
    const field = autoField(this.data, attacker, defender);
    const ctx = makeContext({
      move_name: move,
      battle_format: this.format,
      weather: field.weather,
      terrain: field.terrain,
      spread_move: Boolean(meta.spread) && this.format === "Doubles",
    });
    const result = this.data.engine.calculate(attacker.mon, defender.mon, ctx);
    const summary = koSummary(result);
    const out = { move, result, ...summary, priority: Number(meta.priority || 0), type: meta.type, category: String(meta.category || "").toLowerCase(), percent: result.percent };
    this.calls += 1;
    if (this.cache.size > 60000) this.cache.clear();
    this.cache.set(cacheKey, out);
    return out;
  }

  /** The attacker's best move into the defender (highest KO score, then damage). */
  best(attacker, defender) {
    let best = { tier: 4, score: 0, label: "No damage", avgPct: 0, chance: 0, move: "—", percent: "0-0%", priority: 0 };
    for (const move of attacker.set.moves || []) {
      if (!move) continue;
      const meta = this.data.move(move);
      if (!meta || String(meta.category).toLowerCase() === "status") continue;
      const out = this.damage(attacker, defender, move);
      if (out.score > best.score || (out.score === best.score && out.avgPct > best.avgPct)) best = out;
    }
    return best;
  }

  speed(rec) {
    const item = key(rec.set.item);
    let speed = rec.stats.speed || 1;
    if (item === "choicescarf") speed = Math.floor(speed * 1.5);
    if (item === "ironball") speed = Math.floor(speed / 2);
    return speed;
  }

  /** Does `attacker` act before `defender` with this move? Ties count as no. */
  movesFirst(attacker, defender, priority, trickRoom = false) {
    const theirPriority = 0;
    if (priority !== theirPriority) return priority > theirPriority;
    const a = this.speed(attacker);
    const d = this.speed(defender);
    return trickRoom ? a < d : a > d;
  }
}

// --- profiles and checks -------------------------------------------------------------

function profile(data, rec) {
  const moveKeys = new Set((rec.set.moves || []).map(key));
  const abilityKey = key(rec.ability);
  const physical = [];
  const special = [];
  for (const move of rec.set.moves || []) {
    const meta = data.move(move);
    if (!meta) continue;
    const category = String(meta.category || "").toLowerCase();
    if (category === "physical" && Number(meta.power) > 0) physical.push(move);
    if (category === "special" && Number(meta.power) > 0) special.push(move);
  }
  const all = new Set([...moveKeys, abilityKey]);
  const weatherSet = new Set();
  const weatherUse = new Set();
  const terrainSet = new Set();
  for (const [weather, keys] of Object.entries(WEATHER_SET)) if ([...all].some((k) => keys.has(k))) weatherSet.add(weather);
  for (const [weather, keys] of Object.entries(WEATHER_USE)) if (keys.has(abilityKey)) weatherUse.add(weather);
  for (const [terrain, keys] of Object.entries(TERRAIN_SET)) if ([...all].some((k) => keys.has(k))) terrainSet.add(terrain);
  if (WEATHER_ABILITY[abilityKey]) weatherSet.add(WEATHER_ABILITY[abilityKey].toLowerCase());
  if (TERRAIN_ABILITY[abilityKey]) terrainSet.add(TERRAIN_ABILITY[abilityKey].toLowerCase());
  const utility = new Set(Object.entries(UTILITY).filter(([, keys]) => [...moveKeys].some((k) => keys.has(k))).map(([label]) => label));
  return {
    rec,
    name: rec.name,
    types: rec.types,
    ability: rec.ability,
    item: rec.set.item,
    moveKeys,
    physical,
    special,
    damaging: physical.length + special.length,
    protect: [...moveKeys].some((k) => PROTECT.has(k)),
    speedControl: [...moveKeys].some((k) => SPEED.has(k)),
    priority: [...moveKeys].some((k) => PRIORITY.has(k)),
    positioning: [...moveKeys].some((k) => POSITIONING.has(k)) || abilityKey === "intimidate",
    spread: [...moveKeys].some((k) => SPREAD.has(k)),
    utility,
    speed: rec.stats.speed || 0,
    weatherSet,
    weatherUse,
    terrainSet,
  };
}

function join(names, limit = 4) {
  const list = [...names];
  if (list.length <= limit) return list.join(", ");
  return `${list.slice(0, limit).join(", ")} +${list.length - limit}`;
}

function row(id, label, severity, summary, why, fix = "", extra = {}) {
  return { id, label, severity, status: severity === "red" ? "Problem" : severity === "yellow" ? "Needs attention" : "OK", summary, why, fix: severity === "good" ? "" : fix, ...extra };
}

function names(profiles, predicate) {
  return profiles.filter(predicate).map((p) => p.name);
}

export function archetypeFeatures(profiles) {
  const weatherSetters = { rain: 0, sun: 0, sand: 0, snow: 0 };
  const weatherUsers = { ...weatherSetters };
  const beneficiaries = { ...weatherSetters };
  const values = { team: profiles.length, attackers: 0, physical: 0, special: 0, fast: 0, slow_attackers: 0, protect: 0, speed_control: 0, priority: 0, positioning: 0, spread: 0, utility_providers: 0, bulky: 0, setup: 0, recovery: 0, denial: 0, screen_providers: 0, redirection_fakeout: 0, pivots: 0, tailwind_setters: 0, trick_room_setters: 0, perish_song: 0, trap_sources: 0, light_clay: 0, sustain_pivot: 0 };
  const utility = new Set();
  const screens = new Set();
  let terrainSetters = 0;
  let terrainBeneficiaries = 0;
  for (const p of profiles) {
    const moves = p.moveKeys;
    const ability = key(p.ability);
    const item = key(p.item);
    const types = new Set(p.types.map((t) => t.toLowerCase()));
    const damaging = p.damaging > 0;
    const stats = p.rec.stats;
    const bulk = stats.hp + stats.defense + stats.sp_defense;
    const finalStats = Math.max(stats.hp, stats.defense, stats.sp_defense, stats.speed) > 150;
    const flags = {
      attackers: damaging,
      physical: p.physical.length > 0,
      special: p.special.length > 0,
      fast: damaging && p.speed >= (finalStats ? 150 : 110),
      slow_attackers: damaging && p.speed <= (finalStats ? 110 : 80),
      protect: p.protect,
      speed_control: p.speedControl,
      priority: p.priority,
      positioning: p.positioning,
      spread: p.spread,
      utility_providers: p.utility.size > 0,
      bulky: bulk >= (finalStats ? 355 : 270),
      setup: [...moves].some((k) => SETUP.has(k)),
      recovery: [...moves].some((k) => RECOVERY.has(k)),
      denial: [...moves].some((k) => DENIAL.has(k)),
      screen_providers: [...moves].some((k) => SCREENS.has(k)),
      redirection_fakeout: [...moves].some((k) => REDIRECTION.has(k) || k === "fakeout"),
      pivots: [...moves].some((k) => PIVOTS.has(k)),
      tailwind_setters: moves.has("tailwind"),
      trick_room_setters: moves.has("trickroom"),
      perish_song: moves.has("perishsong"),
      trap_sources: [...moves].some((k) => TRAP_MOVES.has(k)) || ["shadowtag", "arenatrap", "magnetpull"].includes(ability),
      light_clay: item === "lightclay",
    };
    for (const [feature, active] of Object.entries(flags)) if (active) values[feature] += 1;
    if (flags.recovery || flags.pivots || ["regenerator", "intimidate", "hospitality"].includes(ability)) values.sustain_pivot += 1;
    p.utility.forEach((u) => utility.add(u));
    for (const k of moves) if (SCREENS.has(k)) screens.add(k);
    for (const weather of Object.keys(weatherSetters)) {
      if (p.weatherSet.has(weather)) weatherSetters[weather] += 1;
      if (p.weatherUse.has(weather)) weatherUsers[weather] += 1;
      let benefit = p.weatherUse.has(weather);
      if (weather === "rain") benefit = benefit || (damaging && types.has("water")) || ["thunder", "hurricane", "weatherball"].some((k) => moves.has(k));
      else if (weather === "sun") benefit = benefit || (damaging && types.has("fire")) || ["solarbeam", "solarblade", "weatherball"].some((k) => moves.has(k));
      else if (weather === "sand") benefit = benefit || ["rock", "ground", "steel"].some((t) => types.has(t));
      else if (weather === "snow") benefit = benefit || types.has("ice") || moves.has("auroraveil");
      if (benefit) beneficiaries[weather] += 1;
    }
    if (p.terrainSet.size) terrainSetters += 1;
    if (["risingvoltage", "expandingforce", "grassyglide", "terrainpulse"].some((k) => moves.has(k)) || ["surgesurfer", "quarkdrive"].includes(ability) || item.endsWith("seed")) terrainBeneficiaries += 1;
  }
  values.utility_categories = utility.size;
  values.screens_distinct = screens.size;
  values.terrain_setters = terrainSetters;
  values.terrain_beneficiaries = terrainBeneficiaries;
  values.weather_setters = weatherSetters;
  values.weather_users = weatherUsers;
  values.weather_beneficiaries = beneficiaries;
  values.weather_types = Object.values(weatherSetters).filter(Boolean).length;
  return values;
}

/** V462 classify_archetype_features. */
export function classifyArchetype(f) {
  const size = Math.max(1, f.team || 0);
  const tr = f.trick_room_setters || 0;
  const slow = f.slow_attackers || 0;
  const tw = f.tailwind_setters || 0;
  const fast = f.fast || 0;
  const scores = { balanced: 35 };
  scores["trick room"] = tr * 48 + slow * 11 + (f.protect || 0) * 2 + (f.spread || 0) * 3;
  scores.tailwind = tw * 46 + fast * 9 + (f.spread || 0) * 3;
  for (const weather of ["rain", "sun", "sand", "snow"]) {
    scores[weather] = (f.weather_setters[weather] || 0) * 46 + (f.weather_users[weather] || 0) * 11 + (f.weather_beneficiaries[weather] || 0) * 7 - Math.max(0, (f.weather_types || 0) - 1) * 18;
  }
  scores.terrain = (f.terrain_setters || 0) * 48 + (f.terrain_beneficiaries || 0) * 12;
  scores.screens = (f.screens_distinct || 0) * 26 + (f.screen_providers || 0) * 14 + (f.light_clay || 0) * 12 + (f.setup || 0) * 5;
  scores["perish trap"] = (f.perish_song || 0) * 55 + (f.trap_sources || 0) * 32 + (f.protect || 0) * 4;
  scores.setup = (f.setup || 0) * 22 + (f.redirection_fakeout || 0) * 9 + (f.speed_control || 0) * 4;
  scores.stall = (f.bulky || 0) * 9 + (f.recovery || 0) * 14 + (f.denial || 0) * 9 + (f.protect || 0) * 4;
  scores["semi-stall"] = (f.bulky || 0) * 8 + (f.recovery || 0) * 10 + (f.denial || 0) * 6 + (f.attackers || 0) * 3;
  scores["hyper offense"] = (f.attackers || 0) * 9 + fast * 8 + (f.speed_control || 0) * 6 + (f.priority || 0) * 4;
  scores.offense = (f.attackers || 0) * 8 + fast * 5 + (f.spread || 0) * 4 + (f.speed_control || 0) * 5;
  scores["bulky offense"] = (f.attackers || 0) * 7 + (f.bulky || 0) * 8 + (f.sustain_pivot || 0) * 5;
  scores.goodstuff = (f.attackers || 0) * 5 + (f.utility_categories || 0) * 8 + (f.positioning || 0) * 6 + (f.speed_control || 0) * 5;
  scores.balanced += Math.min(f.physical || 0, 2) * 5 + Math.min(f.special || 0, 2) * 5 + (f.utility_providers || 0) * 4 + (f.bulky || 0) * 3;
  const allowed = new Set(["balanced", "offense", "bulky offense", "hyper offense", "stall", "semi-stall", "goodstuff"]);
  if ((tr >= 2 && slow >= 2) || (tr >= 1 && slow >= Math.max(4, size - 2))) allowed.add("trick room");
  if ((tw >= 2 && fast >= 2) || (tw >= 1 && fast >= 4)) allowed.add("tailwind");
  for (const weather of ["rain", "sun", "sand", "snow"]) if ((f.weather_setters[weather] || 0) >= 1 && (f.weather_beneficiaries[weather] || 0) >= 2) allowed.add(weather);
  if ((f.terrain_setters || 0) >= 1 && (f.terrain_beneficiaries || 0) >= 2) allowed.add("terrain");
  if ((f.screens_distinct || 0) >= 2 && (f.screen_providers || 0) >= 1) allowed.add("screens");
  if ((f.perish_song || 0) >= 1 && (f.trap_sources || 0) >= 1) allowed.add("perish trap");
  if ((f.setup || 0) >= 2) allowed.add("setup");
  let best = "balanced";
  for (const candidate of allowed) {
    if (scores[candidate] > scores[best] || (scores[candidate] === scores[best] && candidate > best)) best = candidate;
  }
  const display = { "trick room": "Trick Room", "bulky offense": "Bulky Offense", "hyper offense": "Hyper Offense", "semi-stall": "Semi-Stall", goodstuff: "Goodstuff", "perish trap": "Perish Trap" }[best] || best.replace(/\b\w/g, (c) => c.toUpperCase());
  return { key: best, display, scores };
}

// FROZEN BENCHMARK COPY -- not the live implementation.
// builder/team-checks.js is what the Team Builder, the Team Evaluation payload and the
// Customize dialog use; this function is reachable only from tests/bench-analysis.mjs and
// is deliberately left at its pre-V514 wording (it still says "Defensive Switch-ins",
// which the live path now calls "Shared Weakness", and it has none of the V514 rows).
// Do not extend it: change builder/team-checks.js.
export function teamChecks(data, records) {
  const profiles = records.map((rec) => profile(data, rec));
  const active = profiles.length;
  const rows = [];
  const features = archetypeFeatures(profiles);
  const archetype = classifyArchetype(features);
  rows.push(row("archetype", `Archetype: ${archetype.display}`, "good", `Detected ${archetype.display} from what the current sets actually do.`, "The archetype is read from the moves, abilities and items on the team, not from its label."));

  const megas = records.filter((rec) => rec.megaCapable).map((rec) => rec.name);
  if (!megas.length) rows.push(row("mega", "Mega Options", "red", "0 Mega-capable Pokémon — add at least one Mega Stone user.", "A team needs a usable Mega option, while three or more compete for the one Mega Evolution available in battle.", "Add a Pokémon with a compatible Mega Stone so the team has a Mega option."));
  else if (megas.length >= 3) rows.push(row("mega", "Mega Options", "red", `${megas.length} Mega-capable Pokémon — too many competing Mega options.`, `Only one can Mega Evolve per battle: ${join(megas, 6)}.`, "Keep one or two flexible Mega options and free the remaining item slots."));
  else rows.push(row("mega", "Mega Options", "good", `${megas.length} Mega-capable Pokémon provide${megas.length === 1 ? "s" : ""} a practical Mega option.`, join(megas, 3)));

  // Speed control
  {
    const direct = names(profiles, (p) => p.speedControl);
    const priority = names(profiles, (p) => p.priority);
    const fast = names(profiles, (p) => p.speed >= 110);
    if (direct.length) rows.push(row("speed_control", "Speed Control", "good", `Direct Speed control is present on ${join(direct, 5)}.`, "Move order is actively controllable instead of relying only on base Speed."));
    else if (priority.length >= 2 || fast.length >= 2) rows.push(row("speed_control", "Speed Control", "yellow", `No direct Speed control; the team relies on ${[priority.length ? `priority on ${join(priority)}` : "", fast.length ? `natural Speed on ${join(fast)}` : ""].filter(Boolean).join(" and ")}.`, "Opposing Tailwind, Trick Room or speed drops can still take control of turns.", "Add one direct speed-control move, or make sure the team has a deliberate fast-offense plan."));
    else rows.push(row("speed_control", "Speed Control", "red", "The team has no reliable way to change or bypass move order.", "Most doubles teams need some way to move first at key moments.", "Add Tailwind, Trick Room, Icy Wind, Electroweb, Thunder Wave, Fake Out plus priority, or another clear speed plan."));
  }
  // Protect / positioning
  {
    const protect = names(profiles, (p) => p.protect);
    const positioning = names(profiles, (p) => p.positioning);
    if (protect.length >= 3 || (protect.length >= 2 && positioning.length >= 2)) rows.push(row("protect_positioning", "Protect / Positioning", "good", `${protect.length} Protect user(s) and ${positioning.length} positioning user(s) are available.`, "The team can scout turns, stall field effects and protect vulnerable slots."));
    else if (protect.length >= 1 || positioning.length >= 2 || active < 4) rows.push(row("protect_positioning", "Protect / Positioning", "yellow", `Only ${protect.length} Protect user(s) and ${positioning.length} positioning user(s).`, "The team has some safe-turn tools, but they may be concentrated on too few slots.", "Add another Protect-style move or a positioning tool such as Fake Out, Follow Me, pivoting or Intimidate."));
    else rows.push(row("protect_positioning", "Protect / Positioning", "red", "There is almost no way to protect a slot or reposition safely.", "Without these tools, reads become all-or-nothing.", "Add Protect to key attackers and at least one board-control tool."));
  }
  // Spread damage
  {
    const spread = names(profiles, (p) => p.spread);
    if (spread.length >= 2 || (active <= 3 && spread.length >= 1)) rows.push(row("spread_damage", "Spread Damage", "good", `Spread pressure is available on ${join(spread)}.`, "Spread moves punish both opposing slots."));
    else if (spread.length === 1) rows.push(row("spread_damage", "Spread Damage", "yellow", `Only ${spread[0]} pressures both opposing slots.`, "One spread option can be denied by typing, positioning or losing that Pokémon early.", "Add a second spread attack for consistent board pressure."));
    else rows.push(row("spread_damage", "Spread Damage", "red", "No common spread attack is selected.", "The team may struggle to punish two threats at once.", "Add a spread move such as Heat Wave, Rock Slide, Dazzling Gleam, Earthquake, Hyper Voice or Blizzard."));
  }
  // Priority / cleanup
  {
    const priority = names(profiles, (p) => p.priority);
    const fast = names(profiles, (p) => p.speed >= 120 && p.damaging > 0);
    if (priority.length >= 2) rows.push(row("priority_cleanup", "Priority or Cleanup", "good", `Priority cleanup is available on ${join(priority)}.`, "Priority finishes weakened targets even when speed control is unfavourable."));
    else if (priority.length === 1 || fast.length >= 2) rows.push(row("priority_cleanup", "Priority or Cleanup", "yellow", priority.length ? `Priority is limited to ${priority[0]}.` : `Cleanup relies on fast attackers: ${join(fast, 3)}.`, "Losing one slot or facing opposing speed control may remove it.", "Add another priority move or a second fast cleaner."));
    else rows.push(row("priority_cleanup", "Priority or Cleanup", "red", "No priority or clear cleanup plan is visible.", "Low-health opponents may still move first.", "Add priority, Fake Out support, or a fast cleaner."));
  }
  // Physical / special
  for (const [id, label, list, other] of [["physical_damage", "Physical Damage", names(profiles, (p) => p.physical.length > 0), "special"], ["special_damage", "Special Damage", names(profiles, (p) => p.special.length > 0), "physical"]]) {
    const kind = label.split(" ")[0].toLowerCase();
    if (list.length >= 2) rows.push(row(id, label, "good", `${label.split(" ")[0]} pressure is available on ${join(list, 5)}.`, `The team does not rely only on ${other} attacks.`));
    else if (list.length === 1) rows.push(row(id, label, "yellow", `Only ${list[0]} provides ${kind} damage.`, "One attacker can be enough, but the team becomes easier to wall.", `Add a second ${kind} attacker or make sure this slot is reliable.`));
    else rows.push(row(id, label, "red", `No ${kind} damage source is selected.`, `A purely ${other} team struggles into the matching walls.`, `Add at least one reliable ${kind} attacker, preferably two.`));
  }
  // Utility
  {
    const categories = new Set(profiles.flatMap((p) => [...p.utility]));
    const providers = names(profiles, (p) => p.utility.size > 0);
    if (categories.size >= 3 && providers.length >= 2) rows.push(row("utility_disruption", "Utility / Disruption", "good", `${join([...categories].sort(), 7)} are covered across ${providers.length} Pokémon.`, "The team has several ways to interrupt the opponent beyond raw damage."));
    else if (categories.size >= 2 || providers.length >= 2) rows.push(row("utility_disruption", "Utility / Disruption", "yellow", `Utility is limited to ${join([...categories].sort(), 7) || "a small number of tools"} across ${providers.length} Pokémon.`, "The team may not be able to disrupt varied opposing plans.", "Add Fake Out, redirection, Taunt, Haze, Encore, status, healing or screens."));
    else rows.push(row("utility_disruption", "Utility / Disruption", "red", "Very little utility or disruption is selected.", "Teams that only attack struggle when the opponent sets up first.", "Add useful doubles tools such as Fake Out, redirection, Taunt, status or pivoting."));
  }
  // Defensive switch-ins
  {
    const severe = [];
    const exposed = [];
    for (const type of TYPES) {
      let weak = 0;
      let resist = 0;
      for (const p of profiles) {
        const mult = data.engine.typeMultiplier(type, p.types);
        if (mult === 0) resist += 1;
        else if (mult < 1) resist += 1;
        else if (mult > 1) weak += 1;
      }
      if (weak >= 4 || (weak >= 3 && resist === 0)) severe.push(`${type} (${weak} weak / ${resist} switch-ins)`);
      else if (weak >= 3 || (weak >= 2 && resist === 0)) exposed.push(`${type} (${weak} weak / ${resist} switch-ins)`);
    }
    if (severe.length) rows.push(row("defensive_switch_ins", "Defensive Switch-ins", "red", `Major defensive gaps into ${join(severe, 5)}.`, "A switch-in lets a teammate enter into that type without taking super-effective damage.", "Add a resist or immunity for these types, or replace a Pokémon that stacks the weakness."));
    else if (exposed.length) rows.push(row("defensive_switch_ins", "Defensive Switch-ins", "yellow", `Watch the switch-in coverage into ${join(exposed, 5)}.`, "Repeated attacks of that type may force awkward turns.", "Add another resist or immunity for that type."));
    else rows.push(row("defensive_switch_ins", "Defensive Switch-ins", "good", "No common attacking type has an obvious shared-weakness gap.", "The team has defensive pivots for the major type pressures."));
  }
  // Field / weather consistency
  {
    const weatherSet = new Set(profiles.flatMap((p) => [...p.weatherSet]));
    const weatherUse = new Set(profiles.flatMap((p) => [...p.weatherUse]));
    const terrainSet = new Set(profiles.flatMap((p) => [...p.terrainSet]));
    const moveKeys = new Set(profiles.flatMap((p) => [...p.moveKeys]));
    const priority = names(profiles, (p) => p.priority);
    const problems = [];
    const unsupported = [...weatherUse].filter((w) => !weatherSet.has(w));
    if (unsupported.length) problems.push(`missing setter for ${unsupported.map((w) => w[0].toUpperCase() + w.slice(1)).join(", ")}`);
    if (weatherSet.size >= 2) problems.push("multiple weather setters may fight each other");
    if (terrainSet.has("psychic") && priority.length) problems.push("Psychic Terrain can block the team's priority attacks");
    if (terrainSet.has("grassy") && ["earthquake", "bulldoze", "magnitude"].some((k) => moveKeys.has(k))) problems.push("Grassy Terrain weakens the team's Ground spread attacks");
    if (problems.length >= 2) rows.push(row("field_weather_consistency", "Field / Weather Consistency", "red", `${problems.join("; ")}.`, "Conflicting field choices make the team's own tools unreliable.", "Remove the conflict or add the missing weather or terrain support."));
    else if (problems.length) rows.push(row("field_weather_consistency", "Field / Weather Consistency", "yellow", `${problems[0][0].toUpperCase()}${problems[0].slice(1)}.`, "One dependency or conflict needs attention.", "Fix the conflict or confirm it is intentional."));
    else rows.push(row("field_weather_consistency", "Field / Weather Consistency", "good", weatherSet.size || weatherUse.size || terrainSet.size ? "Weather and terrain choices have no obvious internal conflict." : "The team does not depend on weather or terrain.", "No field support is missing."));
  }
  return { rows, archetype, features, profiles };
}

// --- directional pressure (V188 / V191) ---------------------------------------------

export function typeChart(data, records) {
  const chart = {};
  for (const type of TYPES) chart[type] = records.length ? mean(records.map((rec) => data.engine.typeMultiplier(type, rec.types))) : 1;
  return chart;
}

/** The type a move actually hits with for this user (-ate abilities, Liquid Voice, Normalize). */
function effectiveMoveType(rec, meta) {
  const ability = key(rec.ability);
  const ate = { pixilate: "Fairy", aerilate: "Flying", refrigerate: "Ice", galvanize: "Electric" }[ability];
  if (ability === "normalize") return "Normal";
  if (ate && meta.type === "Normal") return ate;
  if (ability === "liquidvoice" && (meta.flags || []).includes("sound")) return "Water";
  return meta.type;
}

export function directionalPressure(matchups, sources, targets) {
  const moveRows = [];
  const ownerScores = [];
  for (const source of sources) {
    const rows = [];
    for (const move of source.set.moves || []) {
      const meta = matchups.data.move(move);
      if (!meta || String(meta.category).toLowerCase() === "status" || !(Number(meta.power) > 0 || meta.fixed_damage)) continue;
      const samples = targets.map((target) => Math.min(100, matchups.damage(source, target, move).avgPct));
      const pressure = mean(samples);
      const type = effectiveMoveType(source, meta);
      const multiplier = mean(targets.map((target) => matchups.data.engine.typeMultiplier(type, target.types)));
      rows.push({ owner: source.name, move, type, category: String(meta.category).toLowerCase(), pressure, multiplier });
    }
    rows.sort((a, b) => b.pressure - a.pressure);
    moveRows.push(...rows);
    const best = rows.slice(0, 2);
    ownerScores.push(best.length ? mean(best.map((r) => r.pressure)) : 0);
  }
  const typeSummary = {};
  for (const type of TYPES) {
    const rows = moveRows.filter((r) => r.type === type);
    typeSummary[type] = rows.length ? { count: rows.length, pressure: mean(rows.map((r) => r.pressure)), multiplier: mean(rows.map((r) => r.multiplier)) } : { count: 0, pressure: 0, multiplier: 0 };
  }
  return { score: clamp(mean(ownerScores)), typeSummary, moves: moveRows.sort((a, b) => b.pressure - a.pressure).slice(0, 12) };
}

// --- threats -------------------------------------------------------------------------

export function threatRows(matchups, team, meta, { trickRoom = false } = {}) {
  const rows = [];
  for (const threat of meta) {
    const breakdown = team.map((member) => {
      const incoming = matchups.best(threat, member);
      const outgoing = matchups.best(member, threat);
      const threatFirst = matchups.movesFirst(threat, member, incoming.priority || 0, trickRoom);
      const memberFirst = matchups.movesFirst(member, threat, outgoing.priority || 0, trickRoom);
      return { member, incoming, outgoing, threatFirst, memberFirst };
    });
    const count = (list, tier) => list.filter((summary) => summary.tier === tier && summary.chance > 0).length;
    const incoming = breakdown.map((b) => b.incoming);
    const outgoing = breakdown.map((b) => b.outgoing);
    const pressure = { 1: count(incoming, 1), 2: count(incoming, 2), 3: count(incoming, 3) };
    const answers = { 1: count(outgoing, 1), 2: count(outgoing, 2), 3: count(outgoing, 3) };
    let theirBest = { tier: 4, score: 0, chance: 0, label: "No damage", move: "—" };
    let theirTarget = null;
    for (const b of breakdown) {
      if (b.incoming.score > theirBest.score) {
        theirBest = b.incoming;
        theirTarget = b.member;
      }
    }
    // The best answer: a clean KO that lands before the threat acts ranks first.
    let answer = null;
    for (const b of breakdown) {
      let quality = b.outgoing.score;
      if (!b.memberFirst && b.incoming.tier === 1 && b.incoming.chance >= 0.5) quality *= 0.45;
      else if (!b.memberFirst && b.incoming.tier < b.outgoing.tier) quality *= 0.75;
      else if (b.memberFirst && b.outgoing.tier <= 2) quality += 6;
      if (!answer || quality > answer.quality) answer = { ...b, quality };
    }
    const breadth = (pressure[1] + 0.5 * pressure[2] + 0.2 * pressure[3]) / Math.max(1, team.length);
    const answerScore = clamp(answer ? answer.quality : 0);
    const score = clamp(42 + 0.34 * theirBest.score + 28 * breadth - 0.32 * answerScore);
    rows.push({
      threat,
      name: threat.name,
      position: threat.position,
      breakdown,
      pressure,
      answers,
      theirBest,
      theirTarget: theirTarget?.name || "",
      answer: answer ? { name: answer.member.name, move: answer.outgoing.move, label: answer.outgoing.label, percent: answer.outgoing.percent, first: answer.memberFirst, score: answerScore } : null,
      score,
      critical: theirBest.tier <= 3 && theirBest.chance > 0,
    });
  }
  rows.sort((a, b) => b.score - a.score || a.position - b.position);
  return rows;
}

function criticalComponents(threats) {
  const critical = threats.filter((t) => t.critical && t.score >= 35);
  if (!critical.length) return { count: 0, answerScore: 100, safetyScore: 100, averageScore: 0 };
  let weighted = 0;
  let weightedAnswer = 0;
  let total = 0;
  for (const threat of critical) {
    const weight = 1 + Math.max(0, threat.score - 35) / 65;
    weighted += threat.score * weight;
    weightedAnswer += clamp(threat.answer?.score || 0) * weight;
    total += weight;
  }
  const averageScore = weighted / total;
  return {
    count: critical.length,
    averageScore,
    answerScore: weightedAnswer / total,
    safetyScore: clamp(100 - Math.max(0, averageScore - 35) * (100 / 65)),
  };
}

// --- speed ----------------------------------------------------------------------------

const SPEED_CONTROL_MOVES = new Set(["Tailwind", "Trick Room", "Icy Wind", "Electroweb", "Thunder Wave", "Scary Face", "Bulldoze", "Rock Tomb", "Low Sweep", "Quash", "After You"]);

export function speedAnalysis(matchups, team, meta) {
  const speeds = team.map((rec) => rec.stats.speed || 0);
  const avg = mean(speeds);
  const moves = team.flatMap((rec) => rec.set.moves || []);
  const hasTR = moves.includes("Trick Room");
  const hasTW = moves.includes("Tailwind");
  const hasSpeedMoves = moves.some((m) => SPEED_CONTROL_MOVES.has(m));
  const priorityMoves = [...new Set(moves.filter((m) => PRIORITY.has(key(m))))];
  const slow = speeds.filter((s) => s <= 80).length;
  const fast = speeds.filter((s) => s >= 125).length;
  const trickRoom = clamp((hasTR ? 35 : 0) + slow * 10 - fast * 4);
  const standard = clamp(35 + fast * 11 + (hasSpeedMoves ? 10 : 0) + Math.min(20, avg / 6));
  const opposingTailwind = clamp(20 + priorityMoves.length * 10 + (hasTR ? 20 : 0) + (hasTW ? 18 : 0) + (hasSpeedMoves ? 12 : 0));
  const priority = clamp(priorityMoves.length * 18);
  const score = clamp(trickRoom * 0.22 + standard * 0.32 + opposingTailwind * 0.31 + priority * 0.15);
  const tiers = [
    ...team.map((rec) => ({ name: rec.name, speed: matchups.speed(rec), ours: true, set: rec.set })),
    ...meta.slice(0, 30).map((rec) => ({ name: rec.name, speed: matchups.speed(rec), ours: false, set: rec.set, position: rec.position })),
  ].sort((a, b) => b.speed - a.speed);
  const outspeeds = team.map((rec) => ({ name: rec.name, speed: matchups.speed(rec), faster: meta.slice(0, 30).filter((m) => matchups.speed(rec) > matchups.speed(m)).length }));
  return { score, trickRoom, standard, opposingTailwind, priority, priorityMoves, hasTR, hasTW, average: avg, tiers, outspeeds, summary: `Avg SPE ${Math.round(avg)} · TR ${hasTR ? "yes" : "no"} · Tailwind ${hasTW ? "yes" : "no"}` };
}

// --- evaluation ------------------------------------------------------------------------

/**
 * Synergy: how completely the team covers the Team Building Checks, minus
 * stacked weaknesses and duplicate items, scaled by how full the team is.
 * A "Problem" check costs 16 points, a "Needs attention" one 7.
 */
function synergyScore(checks, records, data) {
  const counted = checks.rows.filter((r) => r.id !== "archetype");
  const reds = counted.filter((r) => r.severity === "red").length;
  const yellows = counted.filter((r) => r.severity === "yellow").length;
  // Shared weaknesses drag synergy down beyond what the switch-in check flags.
  let stacked = 0;
  for (const type of TYPES) {
    const weak = records.filter((rec) => data.engine.typeMultiplier(type, rec.types) > 1).length;
    if (weak >= 3) stacked += weak - 2;
  }
  const items = records.map((rec) => key(rec.set.item)).filter(Boolean);
  const duplicateItems = items.length - new Set(items).size;
  const fill = Math.min(1, records.length / 6);
  return clamp((100 - reds * 16 - yellows * 7 - stacked * 3 - duplicateItems * 6) * (0.7 + 0.3 * fill));
}

export function evaluateTeam(data, format, sets, meta, { top = 40, trickRoom = false, detail = true } = {}) {
  const records = sets.filter((set) => set && set.species).map((set) => record(data, set));
  if (!records.length) return { empty: true };
  const matchups = new Matchups(data, format);
  const metaTop = meta.slice(0, top);
  const threats = threatRows(matchups, records, metaTop, { trickRoom });
  const critical = threats.filter((t) => t.critical);
  const pressureMeta = meta.slice(0, 30);
  const outgoing = directionalPressure(matchups, records, pressureMeta);
  const incoming = directionalPressure(matchups, pressureMeta, records);
  const components = criticalComponents(threats);
  const offense = clamp(outgoing.score * 0.7 + components.answerScore * 0.3);
  const defense = clamp((100 - incoming.score) * 0.7 + components.safetyScore * 0.3);
  const speed = speedAnalysis(matchups, records, meta);
  const checks = teamChecks(data, records);
  const synergy = synergyScore(checks, records, data);
  const result = {
    format,
    size: records.length,
    scores: { synergy, offense, defense, speed: speed.score },
    total: clamp(synergy * 0.25 + offense * 0.27 + defense * 0.27 + speed.score * 0.21),
    archetype: checks.archetype,
    checks: checks.rows,
    critical: critical.slice(0, 24).map(threatView),
    threatCount: threats.length,
    components,
    pressure: { outgoing, incoming, teamChart: typeChart(data, records), metaChart: typeChart(data, pressureMeta) },
    speed,
    calls: matchups.calls,
  };
  if (!detail) delete result.pressure;
  return result;
}

function threatView(row) {
  const set = row.threat.set;
  const spread = (set.bonuses || []).map((value, index) => (value ? `${["HP", "ATK", "DEF", "SPA", "SPD", "SPE"][index]}${value}` : "")).filter(Boolean).join(" ");
  return {
    name: row.name,
    species: set.species,
    form: set.form,
    item: set.item,
    ability: row.threat.ability,
    nature: set.nature,
    spread,
    position: row.position,
    score: row.score,
    pressure: row.pressure,
    answers: row.answers,
    theirBest: { move: row.theirBest.move, label: row.theirBest.label, target: row.theirTarget, percent: row.theirBest.percent },
    answer: row.answer,
  };
}

// --- Team Overview (fast, no threats) ----------------------------------------------------

export function overview(data, format, sets, meta, top = 30) {
  const records = sets.filter((set) => set && set.species).map((set) => record(data, set));
  const metaTop = meta.slice(0, top);
  if (!records.length) return { empty: true, meta: metaTop.map(metaView) };
  const matchups = new Matchups(data, format);
  const outgoing = directionalPressure(matchups, records, metaTop);
  const incoming = directionalPressure(matchups, metaTop, records);
  const speed = speedAnalysis(matchups, records, metaTop);
  // Defensive chart: how the meta's attacking types land on this team.
  const defense = {};
  for (const type of TYPES) {
    const multipliers = records.map((rec) => data.engine.typeMultiplier(type, rec.types));
    defense[type] = { average: mean(multipliers), weak: multipliers.filter((m) => m > 1).length, resist: multipliers.filter((m) => m < 1).length };
  }
  return { empty: false, outgoing, incoming, defense, speed, meta: metaTop.map(metaView) };
}

function metaView(rec) {
  return { name: rec.name, species: rec.set.species, form: rec.set.form, item: rec.set.item, ability: rec.ability, moves: rec.set.moves, position: rec.position, types: rec.types };
}

// --- suggestions ---------------------------------------------------------------------------

function quickObjective(data, matchups, records, meta, checksCache) {
  const threats = threatRows(matchups, records, meta);
  const components = criticalComponents(threats);
  const answered = threats.filter((t) => t.critical && (t.answer?.score || 0) >= 60).length;
  const pressureCount = threats.reduce((total, t) => total + t.pressure[1] + t.pressure[2] * 0.5, 0) / Math.max(1, records.length);
  const checks = checksCache ? checksCache(records) : teamChecks(data, records);
  const synergy = synergyScore(checks, records, data);
  const speed = speedAnalysis(matchups, records, meta).score;
  const offense = components.answerScore;
  const defense = components.safetyScore;
  return { value: offense * 0.3 + defense * 0.28 + synergy * 0.24 + speed * 0.12 + answered * 0.8 - pressureCount * 0.6, threats, checks, offense, defense, synergy, speed };
}

/** Rank candidate sets for one slot of the current team. */
export function suggest(data, format, sets, meta, candidates, { slot = null, limit = 8, top = 30, onProgress } = {}) {
  const base = sets.map((set) => (set && set.species ? set : null));
  const target = slot ?? base.findIndex((set) => !set);
  const matchups = new Matchups(data, format);
  const metaTop = meta.slice(0, top);
  const baseRecords = base.filter(Boolean).map((set) => record(data, set));
  const baseline = quickObjective(data, matchups, baseRecords, metaTop);
  const taken = new Set(base.filter((set, index) => set && index !== target).map((set) => key(set.species)));
  const items = new Set(base.filter((set, index) => set && index !== target).map((set) => key(set.item)).filter(Boolean));
  const out = [];
  candidates.forEach((candidate, index) => {
    if (taken.has(key(candidate.set.species))) return;
    const trial = base.map((set) => set);
    if (target >= 0 && target < 6) trial[target] = candidate.set;
    else trial.push(candidate.set);
    const records = trial.filter(Boolean).map((set) => record(data, set));
    const objective = quickObjective(data, matchups, records, metaTop);
    const before = new Map(baseline.threats.map((t) => [t.name, t]));
    const newlyAnswered = objective.threats.filter((t) => t.critical && (t.answer?.score || 0) >= 60 && t.answer?.name === record(data, candidate.set).name && ((before.get(t.name)?.answer?.score || 0) < 60)).map((t) => t.name);
    const fixes = objective.checks.rows.filter((r) => r.severity === "good" && baseline.checks.rows.find((b) => b.id === r.id)?.severity !== "good").map((r) => r.label);
    out.push({
      set: candidate.set,
      source: candidate.source,
      gain: objective.value - baseline.value,
      value: objective.value,
      answers: newlyAnswered.slice(0, 4),
      fixes: fixes.slice(0, 3),
      itemClash: items.has(key(candidate.set.item)),
    });
    onProgress?.((index + 1) / candidates.length);
  });
  out.sort((a, b) => (a.itemClash - b.itemClash) || b.gain - a.gain);
  return { slot: target, baseline: baseline.value, rows: out.slice(0, limit) };
}

// --- Auto Build --------------------------------------------------------------------------------

const ARCHETYPE_KEYS = { "Trick Room": "trick room", "Tailwind": "tailwind", "Rain": "rain", "Sun": "sun", "Sand": "sand", "Snow": "snow", "Terrain": "terrain", "Setup": "setup", "Hyper Offense": "hyper offense", "Offense": "offense", "Bulky Offense": "bulky offense", "Balanced": "balanced", "Goodstuff": "goodstuff", "Stall": "stall" };

/**
 * Build a team from a candidate pool.  Keeps the locked sets, then fills the
 * remaining slots with a beam search over the same threat model Team
 * Evaluation uses, so every pick is there to answer something specific.
 */
export function autoBuild(data, format, meta, pool, { locked = [], archetype = "Auto", beam = 3, top = 30, onProgress } = {}) {
  const matchups = new Matchups(data, format);
  const metaTop = meta.slice(0, top);
  const lockedSets = locked.filter((set) => set && set.species);
  const wantKey = ARCHETYPE_KEYS[archetype] || "";
  const unique = new Map();
  for (const candidate of pool) {
    const k = `${key(candidate.set.species)}|${key(candidate.set.item)}|${(candidate.set.moves || []).map(key).join(",")}`;
    if (!unique.has(k)) unique.set(k, candidate);
  }
  const candidates = [...unique.values()].filter((c) => !lockedSets.some((s) => key(s.species) === key(c.set.species)));
  const checksCache = new Map();
  const checksFor = (records) => {
    const k = records.map((r) => r.key).sort().join("#");
    if (!checksCache.has(k)) checksCache.set(k, teamChecks(data, records));
    return checksCache.get(k);
  };
  const score = (sets) => {
    const records = sets.map((set) => record(data, set));
    const objective = quickObjective(data, matchups, records, metaTop, checksFor);
    let value = objective.value;
    const items = sets.map((set) => key(set.item)).filter(Boolean);
    value -= (items.length - new Set(items).size) * 12;
    const megas = records.filter((r) => r.megaCapable).length;
    if (megas === 2) value -= 2;
    if (sets.length >= 4 && megas === 0) value -= 6;
    if (sets.length === 6 && megas === 0) value -= 10;
    if (wantKey) {
      const archetypeScores = objective.checks.archetype.scores;
      value += Math.min(18, (archetypeScores[wantKey] || 0) / 8);
      if (objective.checks.archetype.key === wantKey) value += 6;
    }
    return { value, objective };
  };

  let frontier = [{ sets: [...lockedSets], value: lockedSets.length ? score(lockedSets).value : 0, log: [] }];
  const slotsToFill = Math.max(0, 6 - lockedSets.length);
  const totalSteps = slotsToFill * Math.max(1, candidates.length) * Math.max(1, beam);
  let step = 0;
  for (let slot = 0; slot < slotsToFill; slot += 1) {
    const next = [];
    for (const state of frontier) {
      const taken = new Set(state.sets.map((set) => key(set.species)));
      const items = new Set(state.sets.map((set) => key(set.item)).filter(Boolean));
      const before = state.sets.length ? quickObjective(data, matchups, state.sets.map((set) => record(data, set)), metaTop, checksFor) : null;
      const megaCount = state.sets.filter((set) => record(data, set).megaCapable).length;
      for (const candidate of candidates) {
        step += 1;
        if (taken.has(key(candidate.set.species))) continue;
        if (candidate.set.item && items.has(key(candidate.set.item))) continue;
        // One Mega Evolution per battle: two stones is flexibility, three is waste.
        if (megaCount >= 2 && record(data, candidate.set).megaCapable) continue;
        const sets = [...state.sets, candidate.set];
        const { value, objective } = score(sets);
        const name = record(data, candidate.set).name;
        const answered = objective.threats.filter((t) => t.critical && t.answer?.name === name && (t.answer?.score || 0) >= 60 && (!before || (before.threats.find((b) => b.name === t.name)?.answer?.score || 0) < 60)).map((t) => t.name);
        next.push({ sets, value, log: [...state.log, { name, source: candidate.source, answered: answered.slice(0, 4), value }] });
        if (step % 25 === 0) onProgress?.({ fraction: step / totalSteps, message: `Slot ${state.sets.length + 1}: testing ${name}` });
      }
    }
    if (!next.length) break;
    next.sort((a, b) => b.value - a.value);
    const seen = new Set();
    frontier = [];
    for (const candidate of next) {
      const signature = candidate.sets.map((set) => key(set.species)).sort().join(",");
      if (seen.has(signature)) continue;
      seen.add(signature);
      frontier.push(candidate);
      if (frontier.length >= beam) break;
    }
    const lead = frontier[0];
    const last = lead.log[lead.log.length - 1];
    onProgress?.({ fraction: (slot + 1) / slotsToFill, message: `Slot ${lead.sets.length}: ${last.name}${last.answered.length ? ` — answers ${last.answered.join(", ")}` : ""}`, pick: last });
  }
  const best = frontier[0];
  return { sets: best.sets, log: best.log, value: best.value, candidates: candidates.length };
}
