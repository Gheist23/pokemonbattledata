// Team Building Checks and archetype detection, ported from the Companion app.
//
// The app builds its checks in layers; the final behaviour is reproduced here:
//   profiles      _simple_profile_v187 (+ V303: the Mega a stone turns into)
//   check rows    _v201_check_* (+ V251 switch-ins) with the V201/V203 text
//   selection     V218 partial-team rows, V221 filter/sort, V403/V462 archetype
//                 row first, V418 Mega row second, V433 archetype toggle
//   archetype     _v403_archetype_features (+ V494 redirection, tailwind payoff)
//                 classified by team_evaluation_v462.classify_archetype_features
//
// The move groups come from the app's own tables (app-data analysisTables), so a
// rule change in the app reaches the website with the next export.

import { compact } from "./engine.js";

export const ARCHETYPE_CHECK_ID = "archetype_fit";

const TYPES = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy"];
const WEATHERS = ["rain", "sun", "sand", "snow"];
const SEVERITY_ORDER = { red: 0, yellow: 1, good: 2, green: 2 };

// Singles (the website's own rule; the app's checks are written for Doubles). With one
// Pokemon a side there is no partner to help and no second target: a spread move hits
// one Pokemon, so the Spread Damage check and the "Spread attackers" archetype
// requirements are skipped, and these partner-only moves count for no check group.
const SINGLES_NO_EFFECT = new Set(["followme", "ragepowder", "spotlight", "helpinghand", "coaching", "decorate", "allyswitch", "afteryou", "aromaticmist", "holdhands"]);
const SINGLES_SKIPPED_CHECKS = new Set(["spread_damage"]);

/** The archetype texts that name spread pressure or redirection, as they read in Singles. */
const SINGLES_ARCHETYPE_WHY = {
  offense: "Offense needs several immediate attackers and enough speed or priority to keep tempo.",
  setup: "Setup teams need multiple win conditions and protection through disruption, screens, or safe switches.",
};

/** The Customize list's descriptions where the app's text is about Doubles. */
const SINGLES_DESCRIPTIONS = {
  protect_positioning: "Checks for Protect-style moves and safe switching tools such as pivoting moves, Fake Out or Intimidate.",
  spread_damage: "Doubles only: checks whether the team can pressure both opposing slots with spread attacks. In Singles every move hits one Pokémon, so this check is skipped.",
  utility_disruption: "Checks for utility such as Fake Out, Taunt, Haze, Encore, status, healing, screens, pivoting or other disruption.",
};

/** Whether an evaluator (or a stand-in with a `format`) is in Singles. */
function isSingles(evaluator) {
  return String(evaluator?.format || "").toLowerCase().startsWith("single");
}

// part_016 _V201_SCORE_THRESHOLDS (the fallback when a row has no threshold)
const SCORE_THRESHOLDS = {
  good: "",
  yellow: "Needs Attention, usable, but shallow or dependent on too few Pokemon.",
  red: "Problem, missing or very fragile; fix this before trusting the team.",
};

const ARCHETYPE_DISPLAY = {
  "trick room": "Trick Room", "bulky offense": "Bulky Offense", "hyper offense": "Hyper Offense",
  "semi-stall": "Semi-Stall", goodstuff: "Goodstuff", "perish trap": "Perish Trap",
};

/** The archetypes Auto Build and the check can name, in the app's order (V432). */
export const ARCHETYPES = [
  ["Balanced", "balanced"], ["Offense", "offense"], ["Bulky Offense", "bulky offense"], ["Hyper Offense", "hyper offense"],
  ["Stall", "stall"], ["Semi-Stall", "semi-stall"], ["Goodstuff", "goodstuff"], ["Trick Room", "trick room"],
  ["Tailwind", "tailwind"], ["Rain", "rain"], ["Sun", "sun"], ["Sand", "sand"], ["Snow", "snow"],
  ["Terrain", "terrain"], ["Screens", "screens"], ["Setup", "setup"], ["Perish Trap", "perish trap"],
];

function asSet(values) {
  return new Set((values || []).map((v) => String(v)));
}

function intersects(set, other) {
  for (const value of set) if (other.has(value)) return true;
  return false;
}

function pyTitleWord(text) {
  return String(text).replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/** _simple_join_v187 */
export function simpleJoin(values, limit = 6) {
  const clean = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value ?? "").trim();
    const k = text.toLowerCase();
    if (text && !seen.has(k)) {
      seen.add(k);
      clean.push(text);
    }
  }
  const shown = clean.slice(0, Math.max(1, Number(limit) || 1));
  const suffix = clean.length > shown.length ? ` +${clean.length - shown.length} more` : "";
  return shown.join(", ") + suffix;
}

/** _v203_sentence */
function sentence(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ");
}

/** _v201_status_label */
export function statusLabel(severity) {
  const sev = String(severity || "good").toLowerCase();
  return sev === "red" ? "Problem" : sev === "yellow" ? "Needs Attention" : "Good";
}

/** _v203_clean_score_phrase */
function cleanScorePhrase(severity, threshold = "") {
  const sev = String(severity || "good").toLowerCase();
  if (sev === "good") return "";
  let text = sentence(threshold);
  if (!text) text = SCORE_THRESHOLDS[sev] || "";
  text = text.replace(/^Good\s*=\s*/i, "").trim();
  text = text.replace(/^(?:Needs\s+Attention|Need\s+Attention)\s*=\s*/i, "Needs Attention, ").trim();
  text = text.replace(/^Problem\s*=\s*/i, "Problem, ").trim();
  text = text.replace(/\bNeed\s+Attention\b/gi, "Needs Attention");
  return text.replaceAll("Needs Attention —", "Needs Attention,").replaceAll("Needs Attention -", "Needs Attention,");
}

function severityRank(row) {
  return SEVERITY_ORDER[String(row?.severity || "good").toLowerCase()] ?? 2;
}

function rowId(row) {
  return String(row?.check_id || row?.kind || "").trim();
}

function stableSort(rows, keyFn) {
  return rows
    .map((row, index) => [keyFn(row), index, row])
    .sort((a, b) => {
      for (let i = 0; i < a[0].length; i += 1) {
        if (a[0][i] < b[0][i]) return -1;
        if (a[0][i] > b[0][i]) return 1;
      }
      return a[1] - b[1];
    })
    .map(([, , row]) => row);
}

/** team_evaluation_v462.classify_archetype_features */
export function classifyArchetype(features) {
  const f = features || {};
  const n = (field) => Number(f[field]) || 0;
  const setters = f.weather_setters || {};
  const users = f.weather_users || {};
  const beneficiaries = f.weather_beneficiaries || {};
  const teamSize = Math.max(1, n("team"));
  const trSet = n("trick_room_setters");
  const slow = n("slow_attackers");
  const twSet = n("tailwind_setters");
  const fast = n("fast");
  const scores = { balanced: 35.0 };
  scores["trick room"] = trSet * 48 + slow * 11 + n("protect") * 2 + n("spread") * 3;
  scores.tailwind = twSet * 46 + fast * 9 + n("spread") * 3;
  for (const weather of WEATHERS) {
    scores[weather] = (Number(setters[weather]) || 0) * 46 + (Number(users[weather]) || 0) * 11 + (Number(beneficiaries[weather]) || 0) * 7 - Math.max(0, n("weather_types") - 1) * 18;
  }
  scores.terrain = n("terrain_setters") * 48 + n("terrain_beneficiaries") * 12;
  scores.screens = n("screens_distinct") * 26 + n("screen_providers") * 14 + n("light_clay") * 12 + n("setup") * 5;
  scores["perish trap"] = n("perish_song") * 55 + n("trap_sources") * 32 + n("protect") * 4;
  scores.setup = n("setup") * 22 + n("redirection_fakeout") * 9 + n("speed_control") * 4;
  scores.stall = n("bulky") * 9 + n("recovery") * 14 + n("denial") * 9 + n("protect") * 4;
  scores["semi-stall"] = n("bulky") * 8 + n("recovery") * 10 + n("denial") * 6 + n("attackers") * 3;
  scores["hyper offense"] = n("attackers") * 9 + fast * 8 + n("speed_control") * 6 + n("priority") * 4;
  scores.offense = n("attackers") * 8 + fast * 5 + n("spread") * 4 + n("speed_control") * 5;
  scores["bulky offense"] = n("attackers") * 7 + n("bulky") * 8 + n("sustain_pivot") * 5;
  scores.goodstuff = n("attackers") * 5 + n("utility_categories") * 8 + n("positioning") * 6 + n("speed_control") * 5;
  scores.balanced += Math.min(n("physical"), 2) * 5 + Math.min(n("special"), 2) * 5 + n("utility_providers") * 4 + n("bulky") * 3;

  const allowed = new Set(["balanced", "offense", "bulky offense", "hyper offense", "stall", "semi-stall", "goodstuff"]);
  if ((trSet >= 2 && slow >= 2) || (trSet >= 1 && slow >= Math.max(4, teamSize - 2))) allowed.add("trick room");
  if ((twSet >= 2 && fast >= 2) || (twSet >= 1 && fast >= 4)) allowed.add("tailwind");
  for (const weather of WEATHERS) {
    if ((Number(setters[weather]) || 0) >= 1 && (Number(beneficiaries[weather]) || 0) >= 2) allowed.add(weather);
  }
  if (n("terrain_setters") >= 1 && n("terrain_beneficiaries") >= 2) allowed.add("terrain");
  if (n("screens_distinct") >= 2 && n("screen_providers") >= 1) allowed.add("screens");
  if (n("perish_song") >= 1 && n("trap_sources") >= 1) allowed.add("perish trap");
  if (n("setup") >= 2) allowed.add("setup");

  // max(allowed, key=(score, name)): the higher score, then the later name.
  let best = null;
  for (const candidate of allowed) {
    const score = Number(scores[candidate]) || 0;
    if (best === null || score > best[0] || (score === best[0] && candidate > best[1])) best = [score, candidate];
  }
  const key = best ? best[1] : "balanced";
  return [archetypeDisplay(key), key, scores];
}

export function archetypeDisplay(key) {
  return ARCHETYPE_DISPLAY[key] || pyTitleWord(key);
}

function minRequirement(label, current, target, critical = false) {
  const c = Math.trunc(Number(current) || 0);
  const t = Math.trunc(Number(target) || 0);
  return { label, current: c, target: t, display: `${c}/${t}`, met: c >= t, critical: Boolean(critical) };
}

function maxRequirement(label, current, target, critical = false) {
  const c = Math.trunc(Number(current) || 0);
  const t = Math.trunc(Number(target) || 0);
  return { label, current: c, target: t, display: `${c} (max ${t})`, met: c <= t, critical: Boolean(critical) };
}

/** _v403_archetype_requirements (+ V494: Perish Trap wants redirection; Singles: see below) */
export function archetypeRequirements(key, f) {
  const specs = doublesRequirements(key, f);
  if (!f?.singles) return specs;
  // Singles: no spread moves and no partner to redirect for or to protect while it sets
  // up, so those requirements go; Perish Trap keeps its target in with trapping instead.
  return specs
    .filter((req) => !["Spread attackers", "Redirection / Fake Out"].includes(req.label))
    .map((req) => (req.label === "Redirection users" ? minRequirement("Trapping users", f.trap_sources || 0, 1, true) : req));
}

function doublesRequirements(key, f) {
  const minimum = (label, field, target, critical = false) => minRequirement(label, f[field] || 0, target, critical);
  const weather = f.weather_setters || {};
  const weatherUsers = f.weather_users || {};
  const beneficiaries = f.weather_beneficiaries || {};
  const conflicts = (desired) => Math.max(0, (Number(f.weather_types) || 0) - (weather[desired] ? 1 : 0));
  const mixedDamage = Math.min(Number(f.physical) || 0, 1) + Math.min(Number(f.special) || 0, 1);
  const specs = {
    balanced: [
      minimum("Physical attackers", "physical", 2), minimum("Special attackers", "special", 2),
      minimum("Speed-control users", "speed_control", 1, true), minimum("Utility providers", "utility_providers", 2),
      minimum("Protect / positioning users", "protect_positioning", 4), minimum("Bulky members", "bulky", 2),
    ],
    offense: [
      minimum("Immediate attackers", "attackers", 4), minimum("Speed-control users", "speed_control", 1, true),
      minimum("Spread attackers", "spread", 2), minimum("Fast attackers", "fast", 2),
      minimum("Priority users", "priority", 1), minimum("Positioning users", "positioning", 2),
    ],
    "bulky offense": [
      minimum("Attackers", "attackers", 3), minimum("Bulky members", "bulky", 3),
      minimum("Speed-control users", "speed_control", 1, true), minimum("Protect users", "protect", 3),
      minimum("Recovery / pivot users", "sustain_pivot", 2), minRequirement("Mixed damage modes", mixedDamage, 2),
    ],
    "hyper offense": [
      minimum("Attackers", "attackers", 5, true), minimum("Fast attackers", "fast", 4),
      minimum("Speed-control users", "speed_control", 2, true), minimum("Spread attackers", "spread", 2),
      minimum("Priority users", "priority", 2),
    ],
    stall: [
      minimum("Bulky members", "bulky", 4, true), minimum("Recovery users", "recovery", 3),
      minimum("Protect users", "protect", 4), minimum("Disruption users", "denial", 3),
      minimum("Speed / board control", "speed_control", 1),
    ],
    "semi-stall": [
      minimum("Bulky members", "bulky", 3), minimum("Recovery users", "recovery", 2),
      minimum("Protect users", "protect", 3), minimum("Disruption users", "denial", 2),
      minimum("Attackers", "attackers", 2),
    ],
    goodstuff: [
      minimum("Attackers", "attackers", 3), minimum("Physical damage", "physical", 1),
      minimum("Special damage", "special", 1), minimum("Utility categories", "utility_categories", 3),
      minimum("Positioning users", "positioning", 3), minimum("Speed-control users", "speed_control", 1),
    ],
    "trick room": [
      minimum("Trick Room setters", "trick_room_setters", 2, true), minimum("Slow attackers", "slow_attackers", 3),
      minimum("Protect users", "protect", 4), minimum("Spread attackers", "spread", 1),
      minimum("Priority users", "priority", 1),
    ],
    tailwind: [
      minimum("Tailwind setters", "tailwind_setters", 2, true), minimum("Fast attackers", "fast", 4),
      minimum("Spread attackers", "spread", 2), minimum("Priority users", "priority", 1),
      minimum("Positioning users", "positioning", 2),
    ],
    screens: [
      minimum("Distinct screens", "screens_distinct", 2, true), minimum("Screen providers", "screen_providers", 2),
      minimum("Light Clay users", "light_clay", 1), minimum("Setup users", "setup", 2),
      minimum("Protect / positioning", "protect_positioning", 3),
    ],
    setup: [
      minimum("Setup users", "setup", 2, true), minimum("Redirection / Fake Out", "redirection_fakeout", 2),
      minimum("Speed-control users", "speed_control", 1), minimum("Protect users", "protect", 3),
      minimum("Attackers", "attackers", 3),
    ],
    terrain: [
      minimum("Terrain setters", "terrain_setters", 1, true), minimum("Terrain beneficiaries", "terrain_beneficiaries", 2),
      maxRequirement("Conflicting terrains", f.terrain_types || 0, 1), minimum("Positioning users", "positioning", 2),
    ],
    "perish trap": [
      minimum("Perish Song users", "perish_song", 1, true), minimRedirection(f),
      minimum("Protect users", "protect", 3), minimum("Sustain / pivot users", "sustain_pivot", 2),
      minimum("Speed-control users", "speed_control", 1),
    ],
  };
  for (const [desired, display] of [["rain", "Rain"], ["sun", "Sun"], ["sand", "Sand"], ["snow", "Snow"]]) {
    const setterTarget = desired === "rain" || desired === "sun" ? 2 : 1;
    specs[desired] = [
      minRequirement(`${display} setters`, weather[desired] || 0, setterTarget, true),
      minRequirement(`${display} beneficiaries`, beneficiaries[desired] || 0, 3),
      minRequirement(`${display} ability users`, weatherUsers[desired] || 0, 1),
      minimum("Protect users", "protect", 3),
      maxRequirement("Competing weather setters", conflicts(desired), 0, true),
    ];
  }
  return specs[key] || specs.balanced;
}

// V494 replaced Perish Trap's Singles trapping requirement with redirection.
function minimRedirection(f) {
  return minRequirement("Redirection users", f.redirection_users || 0, 1, true);
}

/** archetype_payoff.fast_tier: the meta's fast quarter. */
export function fastTier(metaSpeeds) {
  const speeds = (metaSpeeds || []).map(([, speed]) => Number(speed) || 0).filter((s) => s > 0).sort((a, b) => a - b);
  if (!speeds.length) return 130.0;
  return speeds[Math.trunc(0.75 * (speeds.length - 1))];
}

/** archetype_payoff.tailwind_beneficiaries */
export function tailwindBeneficiaries(profiles, metaSpeeds) {
  const tier = fastTier(metaSpeeds);
  let count = 0;
  for (const profile of profiles || []) {
    if (!(profile.has_damage || profile.damage_pressure || Number(profile.damaging_count))) continue;
    const speed = Number(profile.effective_speed ?? profile.speed ?? 0) || 0;
    if (speed > 0 && speed < tier && tier <= speed * 2) count += 1;
  }
  return count;
}

export class TeamChecks {
  /**
   * @param {TeamEvaluator} evaluator  supplies stats, types, move data and names
   */
  constructor(evaluator) {
    this.ev = evaluator;
    this.singles = isSingles(evaluator);
    const data = evaluator.engine.data || {};
    const tables = data.analysisTables || {};
    this.tables = tables;
    this.abilityFields = data.abilityFields || {};
    this.displayNames = new Map(Object.entries(data.displayNames || {}).map(([name, shown]) => [compact(name), shown]));
    this.checks = (tables._SIMPLE_CHECKS_V187 || []).map(([id, label, description]) => ({ id, label, description }));
    this.baseIds = this.checks.map((c) => c.id);
    this.labels = Object.fromEntries(this.checks.map((c) => [c.id, c.label]));
    this.oldMap = tables._V201_OLD_CHECK_MAP || {};
    this.groups = {
      protect: asSet(tables._SIMPLE_PROTECT_V187),
      speed: asSet(tables._SIMPLE_SPEED_V187),
      priority: asSet(tables._SIMPLE_PRIORITY_V187),
      positioning: asSet(tables._SIMPLE_POSITIONING_V187),
      spread: asSet(tables._SIMPLE_SPREAD_V187),
    };
    this.utilityGroups = Object.entries(tables._SIMPLE_UTILITY_GROUPS_V187 || {}).map(([label, keys]) => [label, asSet(keys)]);
    const keyed = (table) => Object.entries(table || {}).map(([name, keys]) => [name, asSet(keys)]);
    this.weatherSetters = keyed(tables._SIMPLE_WEATHER_SETTERS_V187);
    this.weatherUsers = keyed(tables._SIMPLE_WEATHER_USERS_V187);
    this.terrainSetters = keyed(tables._SIMPLE_TERRAIN_SETTERS_V187);
    this.archetypeSets = {
      setup: asSet(tables._V403_SETUP_MOVES),
      recovery: asSet(tables._V403_RECOVERY_MOVES),
      denial: asSet(tables._V403_DENIAL_MOVES),
      screen: asSet(tables._V403_SCREEN_MOVES),
      redirection: asSet(tables._V403_REDIRECTION_MOVES),
      pivot: asSet(tables._V403_PIVOT_MOVES),
      trapMoves: asSet(tables._V403_TRAP_MOVES),
      trapAbilities: asSet(tables._V403_TRAP_ABILITIES),
    };
    this.descriptions = tables._V403_ARCHETYPE_DESCRIPTIONS || {};
  }

  /** Every check the Customize list offers (V433: Archetype first). */
  allCheckIds() {
    return [ARCHETYPE_CHECK_ID, ...this.baseIds.filter((id) => id !== ARCHETYPE_CHECK_ID)];
  }

  /** The Customize list: id, label and the app's description. */
  checkList() {
    return [
      { id: ARCHETYPE_CHECK_ID, label: "Archetype", description: "Checks the current archetype's setters, payoffs, Speed plan, support, and other archetype-specific requirements." },
      ...this.checks.filter((c) => c.id !== ARCHETYPE_CHECK_ID).map((c) => (this.singles ? { ...c, description: SINGLES_DESCRIPTIONS[c.id] || c.description } : c)),
    ];
  }

  /** _v200_selected_check_ids: every check when nothing was saved; old ids mapped forward. */
  selectedIds(raw) {
    if (raw === undefined || raw === null) return new Set(this.allCheckIds());
    const values = typeof raw === "string" ? raw.split(",").map((v) => v.trim()).filter(Boolean) : [...raw];
    const selected = new Set();
    for (const value of values) {
      const k = String(value || "").trim();
      if (this.baseIds.includes(k)) selected.add(k);
      for (const mapped of this.oldMap[k] || []) if (this.baseIds.includes(mapped)) selected.add(mapped);
    }
    if (values.includes(ARCHETYPE_CHECK_ID)) selected.add(ARCHETYPE_CHECK_ID);
    return selected;
  }

  /** pokemon_display_name: the Showdown spelling of a form.  A Mega the table
   *  has no entry for gets Showdown's gendered name: the app's single "Mega
   *  Meowstic" is Meowstic-M-Mega, and the evaluation's threat "Mega
   *  Meowstic-F" (the female meta row holding the stone) is Meowstic-F-Mega. */
  showdownName(name) {
    const text = String(name ?? "").trim();
    const shown = this.displayNames.get(compact(text));
    if (shown) return shown;
    const mega = text.match(/^Mega\s+(.+)$/i);
    if (mega) {
      const base = this.showdownName(mega[1]);
      const gendered = this.displayNames.get(compact(`${base}-Mega`)) || this.displayNames.get(compact(`${base}-M-Mega`));
      if (gendered) return gendered;
    }
    return text;
  }

  /**
   * One team slot as the checks read it.
   * @param {object} entry  {pokemon, item, form, ability, moves}: the slot as saved
   * @param {object} mon    the evaluator's team mon for that slot (Mega applied)
   */
  profile(entry, mon) {
    const moves = (entry.moves || []).map((m) => String(m ?? "").trim()).filter(Boolean).slice(0, 4);
    const moveKeys = new Set(moves.map(compact));
    const ability = String(mon.ability || "");
    const abilityKey = compact(ability);
    const physical = [];
    const special = [];
    const damagingTypes = new Set();
    for (const move of moves) {
      const [type, category, power] = this.ev.simpleMoveInfo(move);
      if (category === "physical" && power > 0) {
        physical.push(move);
        damagingTypes.add(type);
      } else if (category === "special" && power > 0) {
        special.push(move);
        damagingTypes.add(type);
      }
    }
    const allKeys = new Set([...moveKeys, abilityKey]);
    const weatherSet = new Set(this.weatherSetters.filter(([, keys]) => intersects(allKeys, keys)).map(([w]) => w));
    const weatherUse = new Set(this.weatherUsers.filter(([, keys]) => keys.has(abilityKey)).map(([w]) => w));
    const terrainSet = new Set(this.terrainSetters.filter(([, keys]) => intersects(allKeys, keys)).map(([t]) => t));
    // V303: the Ability's own field, as _v51 reads it.
    const [weather, terrain] = this.abilityFields[ability] || this.abilityFields[pyTitleWord(ability)] || ["", ""];
    if (weather) weatherSet.add(weather.toLowerCase());
    if (terrain) terrainSet.add(terrain.toLowerCase().replace(" terrain", ""));
    const stats = this.ev.statsFor(mon);
    // Singles: partner-only moves count for no group, and nothing is a spread move.
    const groupKeys = this.singles ? new Set([...moveKeys].filter((k) => !SINGLES_NO_EFFECT.has(k))) : moveKeys;
    return {
      entry,
      mon,
      name: this.showdownName(mon.form_name || mon.pokemon_name),
      pokemon: String(entry.pokemon || mon.pokemon_name || ""),
      item: String(entry.item || "").trim(),
      ability,
      types: this.ev.typesFor(mon),
      moves,
      move_keys: moveKeys,
      physical,
      special,
      damaging_count: physical.length + special.length,
      damaging_types: damagingTypes,
      protect: intersects(groupKeys, this.groups.protect),
      speed_control: intersects(groupKeys, this.groups.speed),
      priority: intersects(groupKeys, this.groups.priority),
      positioning: intersects(groupKeys, this.groups.positioning) || abilityKey === "intimidate",
      spread: !this.singles && intersects(groupKeys, this.groups.spread),
      utility: new Set(this.utilityGroups.filter(([, keys]) => intersects(groupKeys, keys)).map(([label]) => label)),
      speed: Number(stats.speed) || 0,
      stats,
      weather_set: weatherSet,
      weather_use: weatherUse,
      terrain_set: terrainSet,
    };
  }

  profiles(team) {
    return team.map(({ entry, mon }) => this.profile(entry, mon));
  }

  // --- V201 rows -----------------------------------------------------------------

  requirementText(checkId, severity, summary, why, fix = "", threshold = "") {
    const label = this.labels[checkId] || pyTitleWord(String(checkId || "").replace(/_/g, " "));
    const sev = String(severity || "good").toLowerCase();
    const summaryText = sentence(summary);
    const parts = [summaryText ? `${label}: ${statusLabel(sev)}, ${summaryText}` : `${label}: ${statusLabel(sev)}`];
    if (sev !== "good") {
      const whyText = sentence(why);
      const fixText = sentence(fix);
      if (whyText) parts.push(whyText);
      if (fixText) parts.push(`Fix, ${fixText}`);
      const score = cleanScorePhrase(sev, threshold);
      if (score) parts.push(`Score, ${score}`);
    }
    return parts.filter((p) => String(p).trim()).map((p) => `${p.replace(/\.+$/, "")}.`).join(" ");
  }

  row(checkId, severity, summary, why, fix = "", pressure = 0, threshold = "", extra = {}) {
    let sev = String(severity || "good").toLowerCase();
    if (!["good", "yellow", "red"].includes(sev)) sev = "good";
    return {
      kind: checkId,
      check_id: checkId,
      check_label: this.labels[checkId] || checkId,
      severity: sev,
      text: this.requirementText(checkId, sev, summary, why, fix, threshold),
      pressure: sev === "good" ? 0 : Math.max(0, Number(pressure) || 0),
      check_system: "simple_custom_v187",
      ...extra,
      status_label: statusLabel(sev),
      score_explanation: cleanScorePhrase(sev, threshold),
      team_requirement_v201: true,
      summary_v203: sentence(summary),
      why_v203: sev === "good" ? "" : sentence(why),
      fix_v203: sev === "good" ? "" : sentence(fix),
      threshold_v203: cleanScorePhrase(sev, threshold),
    };
  }

  checkSpeedControl(profiles) {
    const direct = names(profiles, (p) => p.speed_control);
    const priority = names(profiles, (p) => p.priority);
    const fast = names(profiles, (p) => p.speed >= 110);
    const extra = { direct, priority, fast };
    if (direct.length) {
      return this.row("speed_control", "good", `direct Speed control is present on ${simpleJoin(direct, 5)}.`,
        "Move order is actively controllable instead of relying only on base Speed.", "", 0,
        "Good = at least one direct control move such as Tailwind, Trick Room, Icy Wind, Electroweb, Thunder Wave, or similar.", extra);
    }
    if (priority.length >= 2 || fast.length >= 2) {
      const pieces = [];
      if (priority.length) pieces.push(`priority on ${simpleJoin(priority, 4)}`);
      if (fast.length) pieces.push(`natural Speed on ${simpleJoin(fast, 4)}`);
      return this.row("speed_control", "yellow", `no direct Speed control; the team relies on ${simpleJoin(pieces, 2)}.`,
        "This can work, but opposing Tailwind, Trick Room, or speed drops can still take control of turns.",
        "Add one direct speed-control move, or make sure the team has a deliberate fast-offense plan.", 2.4,
        "Needs attention = no direct control, but at least two priority users or two naturally fast Pokémon.", extra);
    }
    return this.row("speed_control", "red", "the team has no reliable way to change or bypass move order.",
      this.singles ? "Most teams need some way to move first at key moments." : "Most doubles teams need some way to move first at key moments.",
      "Add Tailwind, Trick Room, Icy Wind, Electroweb, Thunder Wave, Fake Out plus priority, or another clear speed plan.", 5.5,
      "Problem = no direct control and fewer than two priority/fast backup options.", extra);
  }

  checkProtectPositioning(profiles) {
    const protect = names(profiles, (p) => p.protect);
    const positioning = names(profiles, (p) => p.positioning);
    const active = profiles.filter(Boolean).length;
    const extra = { protect, positioning };
    if (protect.length >= 3 || (protect.length >= 2 && positioning.length >= 2)) {
      return this.row("protect_positioning", "good", `${protect.length} Protect user(s) and ${positioning.length} positioning user(s) are available.`,
        this.singles ? "The team can scout turns, stall field effects, and bring in the right Pokémon safely." : "The team can scout turns, stall field effects, and protect vulnerable slots while partner Pokémon act.", "", 0,
        "Good = 3+ Protect users, or 2 Protect users plus 2+ positioning tools.", extra);
    }
    if (protect.length >= 1 || positioning.length >= 2 || active < 4) {
      return this.row("protect_positioning", "yellow", `only ${protect.length} Protect user(s) and ${positioning.length} positioning user(s) are visible.`,
        "The team has some safe-turn tools, but they may be concentrated on too few slots.",
        this.singles ? "Add another Protect-style move or a reliable positioning tool such as a pivoting move (U-turn, Volt Switch, Parting Shot), Fake Out, or Intimidate."
          : "Add another Protect-style move or a reliable positioning tool such as Fake Out, Follow Me/Rage Powder, pivoting, or Intimidate.", 2.5,
        "Needs attention = at least one Protect or two positioning tools, but below the good threshold.", extra);
    }
    return this.row("protect_positioning", "red", this.singles ? "there is almost no way to scout a turn or switch safely." : "there is almost no way to protect a slot or reposition safely.",
      "Without these tools, reads become all-or-nothing and setup/support turns are hard to create.",
      this.singles ? "Add Protect to key attackers and at least one switching tool such as a pivoting move, Fake Out, or Intimidate."
        : "Add Protect to key attackers and at least one board-control tool such as Fake Out, redirection, pivoting, or Intimidate.", 5.4,
      "Problem = no Protect and fewer than two positioning tools.", extra);
  }

  checkSpreadDamage(profiles) {
    const spread = names(profiles, (p) => p.spread);
    const active = profiles.filter(Boolean).length;
    const extra = { spread };
    if (spread.length >= 2 || (active <= 3 && spread.length >= 1)) {
      return this.row("spread_damage", "good", `spread pressure is available on ${simpleJoin(spread, 4)}.`,
        "Spread moves punish both opposing slots and stop the team from needing perfect single-target reads every turn.", "", 0,
        "Good = 2+ spread users on a full team, or at least one while the team is still incomplete.", extra);
    }
    if (spread.length === 1) {
      return this.row("spread_damage", "yellow", `only ${simpleJoin(spread, 1)} currently pressures both opposing slots.`,
        "One spread option is useful but can be denied by typing, positioning, or losing that Pokémon early.",
        "Add a second spread attack if the team wants consistent board pressure.", 2.0,
        "Needs attention = exactly one spread user on a mostly complete team.", extra);
    }
    return this.row("spread_damage", "red", "no common spread attack is selected.",
      "The team may struggle to punish two threats at once or clean low-health boards efficiently.",
      "Add a spread move such as Heat Wave, Rock Slide, Dazzling Gleam, Earthquake, Hyper Voice, Blizzard, or similar if it fits the Pokémon.", 4.4,
      "Problem = zero detected spread-damage users.", extra);
  }

  checkPriorityCleanup(profiles) {
    const priority = names(profiles, (p) => p.priority);
    const fast = names(profiles, (p) => p.speed >= 120 && p.damaging_count > 0);
    const extra = { priority, fast };
    if (priority.length >= 2) {
      return this.row("priority_cleanup", "good", `priority cleanup is available on ${simpleJoin(priority, 4)}.`,
        "Priority lets the team finish weakened targets even when speed control is unfavorable.", "", 0,
        "Good = 2+ priority users.", extra);
    }
    if (priority.length === 1 || fast.length >= 2) {
      const summary = priority.length ? `priority is limited to ${simpleJoin(priority, 2)}.` : `cleanup relies on fast attackers: ${simpleJoin(fast, 3)}.`;
      return this.row("priority_cleanup", "yellow", summary,
        "The team has a way to clean, but losing one slot or facing opposing speed control may remove it.",
        "Add another priority move or a second dedicated fast cleaner.", 2.1,
        "Needs attention = one priority user, or no priority but at least two very fast damaging attackers.", extra);
    }
    return this.row("priority_cleanup", "red", "no priority or clear cleanup plan is visible.",
      "Low-health opposing Pokémon may still move first if they win the Speed-control exchange.",
      "Add priority, Fake Out support, or a fast cleaner that reliably threatens weakened targets.", 4.6,
      "Problem = no priority and fewer than two very fast damaging attackers.", extra);
  }

  checkPhysicalDamage(profiles) {
    const physical = names(profiles, (p) => p.physical.length);
    const extra = { physical };
    if (physical.length >= 2) {
      return this.row("physical_damage", "good", `physical pressure is available on ${simpleJoin(physical, 5)}.`,
        "The team can punish specially bulky targets and does not rely only on special attacks.", "", 0,
        "Good = 2+ physical attackers.", extra);
    }
    if (physical.length === 1) {
      return this.row("physical_damage", "yellow", `only ${simpleJoin(physical, 1)} provides physical damage.`,
        "One physical attacker can be enough, but the team becomes easier to wall or intimidate around.",
        "Add a second physical attacker or make sure this slot is protected and reliable.", 2.2,
        "Needs attention = exactly one physical attacker.", extra);
    }
    return this.row("physical_damage", "red", "no physical damage source is selected.",
      "Purely special teams can struggle into special walls, Assault Vest users, or special-defense boosts.",
      "Add at least one reliable physical attacker, preferably two on a full team.", 5.0,
      "Problem = zero detected physical attackers.", extra);
  }

  checkSpecialDamage(profiles) {
    const special = names(profiles, (p) => p.special.length);
    const extra = { special };
    if (special.length >= 2) {
      return this.row("special_damage", "good", `special pressure is available on ${simpleJoin(special, 5)}.`,
        "The team can punish physically bulky targets and does not rely only on contact/physical attacks.", "", 0,
        "Good = 2+ special attackers.", extra);
    }
    if (special.length === 1) {
      return this.row("special_damage", "yellow", `only ${simpleJoin(special, 1)} provides special damage.`,
        "One special attacker can work, but the team becomes easier to wall with physical bulk or Intimidate cycling.",
        "Add a second special attacker or make sure this slot covers the team’s key defensive matchups.", 2.2,
        "Needs attention = exactly one special attacker.", extra);
    }
    return this.row("special_damage", "red", "no special damage source is selected.",
      "Purely physical teams can struggle into Intimidate, burns, Defense boosts, or physically bulky Pokémon.",
      "Add at least one reliable special attacker, preferably two on a full team.", 5.0,
      "Problem = zero detected special attackers.", extra);
  }

  checkUtilityDisruption(profiles) {
    const categories = [...new Set(profiles.flatMap((p) => [...p.utility]))].sort();
    const providers = names(profiles, (p) => p.utility.size);
    const extra = { categories, providers };
    if (categories.length >= 3 && providers.length >= 2) {
      return this.row("utility_disruption", "good", `${simpleJoin(categories, 7)} are covered across ${providers.length} Pokémon.`,
        "The team has multiple ways to interrupt the opponent beyond raw damage.", "", 0,
        "Good = 3+ utility categories across 2+ providers.", extra);
    }
    if (categories.length >= 2 || providers.length >= 2) {
      return this.row("utility_disruption", "yellow", `utility is limited to ${simpleJoin(categories, 7) || "a small number of tools"} across ${providers.length} Pokémon.`,
        "The team has support options, but may not be able to disrupt varied opposing plans.",
        this.singles ? "Add another utility category such as Taunt, Haze, Encore, status, healing, screens, or pivoting."
          : "Add another utility category such as Fake Out, redirection, Taunt, Haze, Encore, status, healing, or screens.", 2.4,
        "Needs attention = 2 categories or 2 providers, but not both enough for good.", extra);
    }
    return this.row("utility_disruption", "red", "very little utility or disruption is selected.",
      this.singles ? "Teams that only attack often struggle when the opponent sets up or controls the game first."
        : "Teams that only attack often struggle when the opponent sets up, redirects, or controls the board first.",
      this.singles ? "Add useful tools such as Taunt, Haze, Encore, status, healing, screens, or pivoting."
        : "Add useful doubles tools such as Fake Out, redirection, Taunt, Haze, Encore, status, healing, screens, or pivoting.", 5.2,
      "Problem = fewer than 2 utility categories and fewer than 2 utility providers.", extra);
  }

  /** _v201_defensive_counts */
  defensiveCounts(profiles) {
    const weak = {};
    const resist = {};
    const immune = {};
    for (const attacking of TYPES) {
      let w = 0;
      let r = 0;
      let i = 0;
      for (const profile of profiles) {
        if (!profile.types.length) continue;
        const mult = this.ev.engine.typeMultiplier(attacking, profile.types);
        if (mult === 0) {
          i += 1;
          r += 1;
        } else if (mult < 1) r += 1;
        else if (mult > 1) w += 1;
      }
      weak[attacking] = w;
      resist[attacking] = r;
      immune[attacking] = i;
    }
    return [weak, resist, immune];
  }

  /** _v251_check_defensive_switch_ins */
  checkDefensiveSwitchIns(profiles) {
    const [weakCounts, resistCounts, immuneCounts] = this.defensiveCounts(profiles);
    let typeRows = [];
    for (const type of TYPES) {
      const weak = weakCounts[type] || 0;
      const switchIns = resistCounts[type] || 0;
      const severity = weak >= 4 || (weak >= 3 && switchIns === 0) ? "red" : weak >= 3 || (weak >= 2 && switchIns === 0) ? "yellow" : "";
      if (severity) typeRows.push({ type, weak, switch_ins: switchIns, immunities: immuneCounts[type] || 0, severity });
    }
    typeRows = stableSort(typeRows, (r) => [r.severity === "red" ? 0 : 1, -r.weak, r.switch_ins, r.type]);
    const severe = typeRows.filter((r) => r.severity === "red");
    const exposed = typeRows.filter((r) => r.severity === "yellow");
    const plural = typeRows.length !== 1 ? "s" : "";
    const extra = { weak_counts: weakCounts, resist_counts: resistCounts, immune_counts: immuneCounts, severe, exposed, type_rows_v251: typeRows };
    if (severe.length) {
      return this.row("defensive_switch_ins", "red", `${typeRows.length} attacking type${plural} need defensive attention. See the separate type rows below.`,
        "A switch in is a teammate that resists or is immune to that attacking type.",
        "Add a resist or immunity for the listed types, or remove one Pokemon that stacks the weakness.", 5.8,
        "Problem = 4+ weaknesses to a type, or 3+ weaknesses with no switch in.", extra);
    }
    if (exposed.length) {
      return this.row("defensive_switch_ins", "yellow", `${typeRows.length} attacking type${plural} have shallow switch-in coverage. See the separate type rows below.`,
        "Repeated attacks of these types can force awkward turns because too few teammates enter safely.",
        "Add another resist or immunity, or make sure speed and board control stop these attacks from landing freely.", 2.6,
        "Needs attention = 3 shared weaknesses, or 2+ weaknesses with no switch in.", extra);
    }
    return this.row("defensive_switch_ins", "good", "No attacking type creates an obvious shared-weakness gap.",
      "The team has reasonable resistance or immunity pivots for its current typings.", "", 0,
      "Good = no type reaches the yellow or red switch-in threshold.", { ...extra, severe: [], exposed: [], type_rows_v251: [] });
  }

  checkFieldWeatherConsistency(profiles) {
    const union = (field) => new Set(profiles.flatMap((p) => [...p[field]]));
    const weatherSet = union("weather_set");
    const weatherUse = union("weather_use");
    const terrainSet = union("terrain_set");
    const moveKeys = union("move_keys");
    const priority = names(profiles, (p) => p.priority);
    const problems = [];
    const unsupported = [...weatherUse].filter((w) => !weatherSet.has(w)).sort();
    if (unsupported.length) problems.push(`missing setter for ${simpleJoin(unsupported.map(pyTitleWord), 4)}`);
    if (weatherSet.size >= 2) problems.push("multiple weather setters may fight each other");
    if (terrainSet.has("psychic") && priority.length) problems.push("Psychic Terrain can block the team's priority attacks");
    if (terrainSet.has("grassy") && ["earthquake", "bulldoze", "magnitude"].some((k) => moveKeys.has(k))) problems.push(this.singles ? "Grassy Terrain weakens the team's Earthquake-style Ground attacks" : "Grassy Terrain weakens the team's Ground spread attacks");
    if (problems.length >= 2) {
      return this.row("field_weather_consistency", "red", `${simpleJoin(problems, 4)}.`,
        "Conflicting field choices can make the team’s own tools unreliable.",
        "Remove the conflict or add the missing weather/terrain support.", 5.0,
        "Problem = two or more field/weather conflicts.", { problems });
    }
    if (problems.length) {
      return this.row("field_weather_consistency", "yellow", `${simpleJoin(problems, 4)}.`,
        "The field plan mostly works, but one dependency or conflict needs attention.",
        "Fix the listed conflict or confirm it is an intentional matchup-specific choice.", 2.4,
        "Needs attention = one detected field/weather issue.", { problems });
    }
    if (weatherSet.size || weatherUse.size || terrainSet.size) {
      return this.row("field_weather_consistency", "good", "weather and terrain choices have no obvious internal conflict.",
        "The detected field tools support the current team instead of blocking it.", "", 0,
        "Good = field dependencies have matching support and no detected conflict.", { problems: [] });
    }
    return this.row("field_weather_consistency", "good", "the team does not depend on weather or terrain, so no field support is required.",
      "No field plan is also valid for many balance or offense teams.", "", 0,
      "Good = no weather or terrain dependency needs support.", { problems: [] });
  }

  checkFor(id) {
    return {
      speed_control: this.checkSpeedControl,
      protect_positioning: this.checkProtectPositioning,
      spread_damage: this.checkSpreadDamage,
      priority_cleanup: this.checkPriorityCleanup,
      physical_damage: this.checkPhysicalDamage,
      special_damage: this.checkSpecialDamage,
      utility_disruption: this.checkUtilityDisruption,
      defensive_switch_ins: this.checkDefensiveSwitchIns,
      field_weather_consistency: this.checkFieldWeatherConsistency,
    }[id];
  }

  // --- the check list -------------------------------------------------------------

  /** V201 base: the selected requirement rows, red first. */
  baseRows(profiles, selected) {
    const base = new Set([...selected].filter((id) => this.baseIds.includes(id)));
    if (!base.size) {
      return [{ kind: "checks_disabled", check_id: "checks_disabled", check_label: "checks_disabled", severity: "good", pressure: 0, check_system: "simple_custom_v187",
        text: "No Team Building Checks are enabled. Use Customize to select the requirements used by Team Building Checks, Suggestion Calcs, and Optimize Calcs." }];
    }
    const rows = this.baseIds.filter((id) => base.has(id) && !(this.singles && SINGLES_SKIPPED_CHECKS.has(id))).map((id) => this.checkFor(id).call(this, profiles));
    const order = Object.fromEntries(this.baseIds.map((id, i) => [id, i]));
    return stableSort(rows.filter((r) => String(r.text || "").trim()), (r) => [severityRank(r), order[rowId(r)] ?? 99]);
  }

  /** _v218_partial_team_check_rows: what a one-Pokemon team still gets told. */
  partialRows(team) {
    const count = team.length;
    if (count === 0) {
      return [{ check_id: "team_size", check_label: "Team Size", severity: "yellow", text: "Team Size: Needs Attention - add your first Pokemon to start checking team structure." }];
    }
    const hasMove = (list) => {
      const wanted = new Set(list);
      return team.some(({ entry }) => (entry.moves || []).some((m) => wanted.has(String(m ?? "").trim().toLowerCase())));
    };
    const rows = [{
      check_id: "team_size", check_label: "Team Size", severity: count < 6 ? "yellow" : "good",
      text: `Team Size: ${count < 6 ? "Needs Attention" : "Covered"} - ${count}/6 Pokemon selected. Suggested Pokemon can add teammates until the team is full.`,
    }];
    const protect = hasMove(["protect", "detect", "spiky shield", "king's shield", "baneful bunker", "silk trap", "burning bulwark"]);
    rows.push({ check_id: "protect_positioning", check_label: "Protect / Positioning", severity: protect ? "good" : "yellow",
      text: protect ? "Protect / Positioning: Covered - at least one selected Pokemon has a Protect-style tool."
        : this.singles ? "Protect / Positioning: Needs Attention - add Protect, a pivoting move, Fake Out, Intimidate, or similar switching support."
          : "Protect / Positioning: Needs Attention - add Protect, Fake Out, redirection, pivoting, Intimidate, or similar board-control support." });
    const speed = hasMove(["tailwind", "trick room", "icy wind", "electroweb", "thunder wave", "scary face", "bulldoze", "quash"]);
    rows.push({ check_id: "speed_control", check_label: "Speed Control", severity: speed ? "good" : "yellow",
      text: speed ? "Speed Control: Covered - at least one selected Pokemon has a speed-control move." : "Speed Control: Needs Attention - add Tailwind, Trick Room, speed-lowering moves, priority, or naturally fast teammates." });
    let physical = 0;
    let special = 0;
    for (const { entry } of team) {
      for (const move of entry.moves || []) {
        const category = String(this.ev.meta(move).category || "").toLowerCase();
        if (category === "physical") physical += 1;
        else if (category === "special") special += 1;
      }
    }
    if (physical && special) rows.push({ check_id: "damage_mix", check_label: "Damage Mix", severity: "good", text: "Damage Mix: Covered - the current team already has both physical and special pressure." });
    else if (count <= 1) rows.push({ check_id: "damage_mix", check_label: "Damage Mix", severity: "yellow", text: "Damage Mix: Needs Attention - one Pokemon cannot establish a complete physical/special damage profile yet. Add teammates that cover the missing side." });
    else rows.push({ check_id: "damage_mix", check_label: "Damage Mix", severity: "yellow", text: "Damage Mix: Needs Attention - the current team leans too heavily toward one attacking side. Add physical or special pressure to balance it." });
    if (!this.singles) {
      const spread = hasMove(["heat wave", "rock slide", "earthquake", "dazzling gleam", "hyper voice", "blizzard", "muddy water", "eruption", "water spout", "discharge", "surf", "icy wind", "snarl"]);
      rows.push({ check_id: "spread_damage", check_label: "Spread Damage", severity: spread ? "good" : "yellow",
        text: spread ? "Spread Damage: Covered - the current team has at least one spread-pressure option." : "Spread Damage: Needs Attention - add spread attacks so the team can pressure both opposing slots." });
    }
    const utility = hasMove(this.singles
      ? ["fake out", "taunt", "haze", "encore", "will-o-wisp", "parting shot", "snarl", "quick guard"]
      : ["fake out", "follow me", "rage powder", "taunt", "haze", "encore", "will-o-wisp", "parting shot", "snarl", "helping hand", "wide guard", "quick guard"]);
    rows.push({ check_id: "utility_disruption", check_label: "Utility / Disruption", severity: utility ? "good" : "yellow",
      text: utility ? "Utility / Disruption: Covered - at least one selected Pokemon has a disruption or support tool."
        : this.singles ? "Utility / Disruption: Needs Attention - add Taunt, Haze, Encore, Parting Shot, status, screens, or similar support."
          : "Utility / Disruption: Needs Attention - add Fake Out, redirection, Taunt, Haze, Parting Shot, status, screens, or similar support." });
    return rows;
  }

  /** _v403_archetype_features (+ V494 redirection users, + the Tailwind payoff count). */
  archetypeFeatures(profiles, { tailwind = null } = {}) {
    const s = this.archetypeSets;
    const weatherSetters = { rain: 0, sun: 0, sand: 0, snow: 0 };
    const weatherUsers = { rain: 0, sun: 0, sand: 0, snow: 0 };
    const weatherBeneficiaries = { rain: 0, sun: 0, sand: 0, snow: 0 };
    const terrainTypes = new Set();
    let terrainBeneficiaries = 0;
    const utility = new Set();
    const values = {
      team: profiles.length, attackers: 0, physical: 0, special: 0, fast: 0, slow_attackers: 0, protect: 0, speed_control: 0,
      priority: 0, positioning: 0, protect_positioning: 0, spread: 0, utility_providers: 0, bulky: 0, setup: 0, recovery: 0,
      denial: 0, screen_providers: 0, screens_distinct: 0, redirection_fakeout: 0, pivots: 0, tailwind_setters: 0,
      trick_room_setters: 0, perish_song: 0, trap_sources: 0, light_clay: 0, sustain_pivot: 0,
    };
    const screens = new Set();
    const evidence = {};
    const mark = (feature, profile) => {
      const list = evidence[feature] || (evidence[feature] = []);
      if (!list.includes(profile.name)) list.push(profile.name);
    };
    const has = (moves, set) => intersects(moves, set);
    for (const profile of profiles) {
      const moves = profile.move_keys;
      const ability = compact(profile.ability);
      const item = compact(profile.item);
      const types = new Set(profile.types.map((t) => t.toLowerCase()));
      const damaging = profile.damaging_count > 0;
      const speed = profile.speed;
      // _v403_profile_stats reads "special-defense"/"special_defense"/"spd"; the
      // engine's key is "sp_defense", so Special Defense never counts here.
      const hp = Number(profile.stats.hp) || 0;
      const defense = Number(profile.stats.defense) || 0;
      const finalStats = Math.max(hp, defense, 0, speed) > 150;
      const bulky = hp + defense >= (finalStats ? 355 : 270);
      const flags = {
        attackers: damaging,
        physical: profile.physical.length > 0,
        special: profile.special.length > 0,
        fast: damaging && speed >= (finalStats ? 150 : 110),
        slow_attackers: damaging && speed <= (finalStats ? 110 : 80),
        protect: profile.protect,
        speed_control: profile.speed_control,
        priority: profile.priority,
        positioning: profile.positioning,
        protect_positioning: profile.protect || profile.positioning,
        spread: profile.spread,
        utility_providers: profile.utility.size > 0,
        bulky,
        setup: has(moves, s.setup),
        recovery: has(moves, s.recovery),
        denial: has(moves, s.denial),
        screen_providers: has(moves, s.screen),
        redirection_fakeout: (!this.singles && has(moves, s.redirection)) || moves.has("fakeout"),
        pivots: has(moves, s.pivot),
        tailwind_setters: moves.has("tailwind"),
        trick_room_setters: moves.has("trickroom"),
        perish_song: moves.has("perishsong"),
        trap_sources: has(moves, s.trapMoves) || s.trapAbilities.has(ability),
        light_clay: item === "lightclay",
      };
      for (const [feature, active] of Object.entries(flags)) {
        if (active) {
          values[feature] += 1;
          mark(feature, profile);
        }
      }
      if (flags.recovery || flags.pivots || ["regenerator", "intimidate", "hospitality"].includes(ability)) {
        values.sustain_pivot += 1;
        mark("sustain_pivot", profile);
      }
      for (const u of profile.utility) utility.add(u);
      for (const m of moves) if (s.screen.has(m)) screens.add(m);
      for (const weather of WEATHERS) {
        if (profile.weather_set.has(weather)) {
          weatherSetters[weather] += 1;
          mark(`${weather}_setters`, profile);
        }
        if (profile.weather_use.has(weather)) {
          weatherUsers[weather] += 1;
          mark(`${weather}_users`, profile);
        }
        let benefit = profile.weather_use.has(weather);
        if (weather === "rain") benefit = benefit || (damaging && types.has("water")) || ["thunder", "hurricane", "weatherball"].some((m) => moves.has(m));
        else if (weather === "sun") benefit = benefit || (damaging && types.has("fire")) || ["solarbeam", "solarblade", "weatherball"].some((m) => moves.has(m));
        else if (weather === "sand") benefit = benefit || ["rock", "ground", "steel"].some((t) => types.has(t));
        else if (weather === "snow") benefit = benefit || types.has("ice") || moves.has("auroraveil");
        if (benefit) {
          weatherBeneficiaries[weather] += 1;
          mark(`${weather}_beneficiaries`, profile);
        }
      }
      for (const t of profile.terrain_set) terrainTypes.add(t);
      if (profile.terrain_set.size) mark("terrain_setters", profile);
      let payoff = ["risingvoltage", "expandingforce", "grassyglide", "terrainpulse"].some((m) => moves.has(m));
      payoff = payoff || ["surgesurfer", "quarkdrive"].includes(ability) || item.endsWith("seed");
      if (payoff) {
        terrainBeneficiaries += 1;
        mark("terrain_beneficiaries", profile);
      }
    }
    values.utility_categories = utility.size;
    values.screens_distinct = screens.size;
    values.terrain_setters = profiles.filter((p) => p.terrain_set.size).length;
    values.terrain_types = terrainTypes.size;
    values.terrain_beneficiaries = terrainBeneficiaries;
    values.weather_setters = weatherSetters;
    values.weather_users = weatherUsers;
    values.weather_beneficiaries = weatherBeneficiaries;
    values.weather_types = Object.values(weatherSetters).filter(Boolean).length;
    values.utility_category_names = [...utility].sort();
    values.evidence = evidence;
    values.redirection_users = this.singles ? 0 : profiles.filter((p) => has(p.move_keys, s.redirection)).length;
    values.tailwind_beneficiaries = typeof tailwind === "function" ? tailwind() : Number(tailwind) || 0;
    // Read by archetypeRequirements (only set in Singles, so Doubles features are unchanged).
    if (this.singles) values.singles = true;
    return values;
  }

  /** V462 _v403_archetype_check_row: the detected archetype and what it still misses. */
  archetypeRow(features) {
    const [display, key, scores] = classifyArchetype(features);
    const requirements = archetypeRequirements(key, features);
    const missing = requirements.filter((r) => !r.met);
    const passed = Math.max(0, requirements.length - missing.length);
    let summary = `Detected ${display}. ${passed}/${requirements.length} archetype requirements are covered.`;
    if (missing.length) summary += ` Missing: ${missing.slice(0, 4).map((r) => r.label || "requirement").join(", ")}.`;
    return {
      check_id: ARCHETYPE_CHECK_ID,
      kind: ARCHETYPE_CHECK_ID,
      check_label: `Archetype: ${display}`,
      archetype: display,
      archetype_key_v403: key,
      archetype_requirements_v403: requirements,
      archetype_features_v403: features,
      detected_archetype_v462: true,
      archetype_scores_v462: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      summary_v203: summary,
      summary,
      text: summary,
      why_v203: String((this.singles && SINGLES_ARCHETYPE_WHY[key]) || this.descriptions[key] || ""),
      fix_v203: missing.length ? `Improve ${missing.map((r) => r.label || "requirement").join(", ")}.` : "No archetype-specific changes are needed.",
      score_explanation: "",
      threshold_v203: "",
      severity: missing.length ? "yellow" : "good",
      status: missing.length ? "Watch Recommendation" : "OK",
      pressure: missing.length ? Math.min(2.4, 0.45 + 0.32 * missing.length) : 0,
    };
  }

  /** TeamAnalysisPanel.mega_count (V494: a Mega form counts, and so does any Mega Stone). */
  megaCount(team) {
    const labels = [];
    for (const { entry, mon } of team) {
      const base = String(entry.pokemon || "").trim();
      if (!base) continue;
      let item = String(entry.item || "").trim();
      if (!item) item = String(this.ev.commonSet(base)?.item || "");
      const formIsMega = this.formIsMega(base, entry.form);
      if (!formIsMega && !(item && this.ev.engine.isMegaStone(item))) continue;
      // The website keeps the species as the slot's form and lets the stone pick
      // the Mega, where the Companion saves the Mega form itself: name the Mega.
      const label = formIsMega ? String(entry.form).trim() : this.formIsMega(base, mon?.form_name) ? String(mon.form_name) : "";
      labels.push(label || base || "Unknown");
    }
    return [labels.length, labels];
  }

  formIsMega(base, form) {
    const name = String(form || "").trim();
    if (!name) return false;
    const record = this.ev.engine.formRecord(base, name);
    const kind = String(record?.kind || "").trim().toLowerCase();
    if (record && compact(record.form) === compact(name) && kind) return kind === "mega" || kind.startsWith("mega ");
    return name.toLowerCase().startsWith("mega ");
  }

  /** _v418_mega_check_row */
  megaRow(team) {
    const [count, megaNames] = this.megaCount(team);
    let severity = "good";
    let status = "OK";
    let summary;
    let fix;
    let pressure = 0;
    if (count === 0) {
      severity = "red";
      status = "Problem";
      summary = "0 Mega-capable Pokemon — add at least one Mega Stone user.";
      fix = "Add a Pokemon with a compatible Mega Stone so the team has a Mega option.";
      pressure = 5.2;
    } else if (count >= 3) {
      severity = "red";
      status = "Problem";
      summary = `${count} Mega-capable Pokemon — too many competing Mega options.`;
      fix = "Keep one or two flexible Mega options and free the remaining item slots.";
      pressure = 4.4 + Math.max(0, count - 3) * 0.6;
    } else {
      summary = `${count} Mega-capable Pokemon provide${count === 1 ? "s" : ""} a practical Mega option.`;
      fix = "No Mega-option change is required.";
    }
    const evidence = megaNames.length ? megaNames.join(", ") : "No Mega-capable Pokemon detected";
    return {
      check_id: "mega", kind: "mega", check_label: "Mega Options", severity, status,
      summary_v203: summary, summary, text: summary,
      why_v203: `${this.singles ? "A team" : "A VGC team"} needs a usable Mega option, while three or more Mega users compete for the one Mega Evolution available in battle. ${evidence}.`,
      fix_v203: fix,
      score_explanation: "0 Mega options and 3 or more Mega options are structural Team Building Problems; 1 or 2 are healthy.",
      pressure, mega_count: count, mega_names: megaNames,
    };
  }

  /**
   * The Team Building Checks card, in the app's final order.
   * @param {Array<{entry, mon}>} team   filled slots (Exclude Pokemon already applied)
   * @param {Iterable<string>|null} selection  saved check ids (null = everything)
   * @param {object} options  {tailwind}: the Tailwind payoff count or a function for it
   */
  rows(team, selection = null, options = {}) {
    const selected = this.selectedIds(selection);
    const profiles = this.profiles(team);
    // V201 base, then V218's partial-team rows for a one-Pokemon team.
    let rows = this.baseRows(profiles, selected);
    if (team.length <= 1 || !rows.length) {
      const seen = new Set(rows.map((r) => String(r.check_id || r.kind || r.check_label || "").toLowerCase()));
      for (const row of this.partialRows(team)) {
        const k = String(row.check_id || row.check_label || "").toLowerCase();
        if (!seen.has(k)) {
          rows.push(row);
          seen.add(k);
        }
      }
    }
    // V221: only enabled checks, red first, then the Customize order.
    const allIds = [...this.allCheckIds(), "mega"];
    const oldMap = { ...this.oldMap, damage_options: this.oldMap.damage_options || ["physical_damage", "special_damage"], damage_mix: this.oldMap.damage_mix || ["physical_damage", "special_damage"] };
    if (!selected.size) {
      rows = [{ check_id: "checks_disabled", check_label: "Team Building Checks", severity: "good",
        text: "No Team Building Checks are enabled. Use Customize to activate the checks used by Team Building Checks, Suggestion Calcs, and Optimize Calcs.",
        score_explanation: "Disabled checks are ignored by Team Building Checks, Suggested Pokemon, and Optimize calculations." }];
    } else {
      rows = rows.filter((row) => {
        const id = rowId(row);
        if (allIds.includes(id)) return selected.has(id);
        if (oldMap[id]) return oldMap[id].some((mapped) => selected.has(mapped));
        return false;
      });
      const order = Object.fromEntries(allIds.map((id, i) => [id, i]));
      rows = stableSort(rows, (r) => [severityRank(r), order[rowId(r)] ?? 999, String(r.check_label || r.text || "")]);
    }
    // V403/V462: the archetype row leads; V418: the Mega row follows it.
    const archetype = this.archetypeRow(this.archetypeFeatures(profiles, options));
    rows = [archetype, ...rows.filter((r) => rowId(r) !== ARCHETYPE_CHECK_ID && rowId(r) !== "mega")];
    rows.splice(1, 0, this.megaRow(team));
    // V433: Archetype is a check like the others; "disabled" only when nothing is on.
    if (!selected.has(ARCHETYPE_CHECK_ID)) rows = rows.filter((r) => rowId(r) !== ARCHETYPE_CHECK_ID);
    if (selected.size) rows = rows.filter((r) => rowId(r) !== "checks_disabled");
    return { rows, profiles, archetype, selected };
  }

  /** _v77_team_check_snapshot: what Suggestions and Auto Build score against. */
  snapshot(team, selection = null, options = {}) {
    const { rows, profiles, archetype, selected } = this.rows(team, selection, options);
    const scoredBase = rows.filter((r) => this.baseIds.includes(rowId(r)) && selected.has(rowId(r)) && String(r.severity || "good").toLowerCase() !== "good");
    const scored = rows.filter((r) => selected.has(rowId(r)) && !["good", "green", "ok"].includes(String(r.severity || "good").toLowerCase()));
    const pressure = scored.reduce((sum, r) => sum + (Number(r.pressure) || 0), 0);
    const utility = [...new Set(profiles.flatMap((p) => [...p.utility]))].sort();
    return {
      rows,
      warnings: scored.length,
      red_count: scored.filter((r) => String(r.severity).toLowerCase() === "red").length,
      yellow_count: scored.filter((r) => String(r.severity).toLowerCase() === "yellow").length,
      penalty: pressure,
      weighted_penalty: pressure,
      red_units: pressure / 3,
      check_pressure: pressure,
      role_balance: scoredBase.filter((r) => ["physical_damage", "special_damage", "utility_disruption"].includes(rowId(r))),
      type_coverage: scoredBase.filter((r) => rowId(r) === "defensive_switch_ins"),
      role: [],
      type: [],
      active: team.length,
      protect: profiles.filter((p) => p.protect).length,
      mega: 0,
      utility: utility.length,
      utility_moves: utility,
      selected_team_checks: this.allCheckIds().filter((id) => selected.has(id)),
      current_archetype_v403: String(archetype.archetype || "Balanced"),
      archetype_check_v403: rows.find((r) => rowId(r) === ARCHETYPE_CHECK_ID) || {},
    };
  }
}

function names(profiles, predicate) {
  return profiles.filter((p) => p && predicate(p)).map((p) => String(p.name || "Pokémon"));
}
