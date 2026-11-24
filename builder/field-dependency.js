// V556: a field is worth what it switches on.
//
// The port of the app's `field_dependency_v556.py`, function for function. Read that file for
// the complaint and the reasoning; what follows is only what a reader of THIS file needs.
//
// THE DEFECT, on the owner's sand six (Mega Salamence / Mega Tyranitar / Corviknight /
// Excadrill / Indeedee / Sneasler). The Suggestions list opened with
//
//     Swap Tyranitar-Mega -> Dragonite-Mega        100.0
//     What the swap gives up    -0.9
//
// and Mega Tyranitar's Sand Stream is what makes Excadrill's Sand Rush 2x Speed. Measured on
// this site's own data: 280 Speed against 140, 30 of the Top 30 outrun against 16, 16 Tailwind
// races against 1 -- and the Synergy axis moved 59.8 -> 56.3 while the row the ranking showed
// said "Syn +4.1".
//
// The app had a term for exactly this and lost it: `_v402_team_synergy` ends with
// `+ support_bonus - unsupported_penalty` and V465 re-implemented team synergy in a later
// runtime part without carrying it. THIS SITE copied V465 (`TeamSynergy.team`) and so never had
// the term at all, which is why every recorded parity suite is green on it.
//
// WHAT THIS ADDS. One measurement, spent in three places (the other two are in
// `team-synergy.js` and `team-suggest.js`):
//
//   * a dependency is a (setter, dependent, field) triple, read off the tables this codebase
//     already carries -- ABILITY_SUPPORT, ITEM_SUPPORT, MOVE_SUPPORT and the V187 setter lists;
//   * for the five Speed doublers, and only for them, the grade is MEASURED inside V402's own
//     4.0-10.0 span: the share of the Top X it newly outruns, plain and through an opposing
//     Tailwind. Everything else keeps V402's own flat grade.
//
// THE GATE. `fieldDependencyRule`, the same shape as `speedAbilityRule`: absent means
// production (on), an explicit 0/false/"off" means off. Every recorded evaluation, suggestion
// and Auto Build vector was made before this rule, so those suites replay with it off.

import { pyFixed } from "./engine.js";

/** Compacted key: the spelling every table here is written in. */
export function compactKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export const FIELD_DEPENDENCY_RULE = 1;

/** `fieldDependencyRule` as a flag: absent means production (on), 0/false/"off" means off. */
export function fieldDependencyRuleOption(value) {
  if (value === undefined || value === null) return FIELD_DEPENDENCY_RULE;
  if (value === false) return 0;
  const text = String(value).trim().toLowerCase();
  if (!text || text === "0" || text === "off" || text === "false" || text === "no" || text === "none") return 0;
  return 1;
}

/** Whether the rule is on for this evaluator. */
export function fieldDependencyOn(ev) {
  return Boolean(fieldDependencyRuleOption(ev?.fieldDependencyRule));
}

// --- V402's own numbers, quoted ------------------------------------------------------------
//
// `_V402_HARD_FIELD_ABILITIES` graded the five Speed doublers 10.0,
// `_V402_MEDIUM_FIELD_ABILITIES` the middling ones 6-7, and the function fell back to 4.0.

export const PLAIN_GRADE = 4.0;
export const HARD_GRADE = 10.0;
export const MEDIUM_GRADES = Object.freeze({
  solarpower: 7.0, protosynthesis: 7.0, quarkdrive: 7.0, sandforce: 6.0, flowergift: 6.0,
});
export const SUPPORT_SHARE = 0.55;
export const SUPPORT_FLOOR = 2.0;
export const SUPPORT_CEILING = 6.0;
export const SUPPORT_CAP = 14.0;
export const SELF_SHARE = 0.22;
export const SELF_FLOOR = 1.0;
export const SELF_CEILING = 2.5;
export const STRAND_CAP = 24.0;

/** The five Abilities whose payoff this codebase already measures. */
export const SPEED_DOUBLERS = Object.freeze({
  swiftswim: ["Swift Swim", "rain", 2.0],
  chlorophyll: ["Chlorophyll", "sun", 2.0],
  sandrush: ["Sand Rush", "sand", 2.0],
  slushrush: ["Slush Rush", "snow", 2.0],
  surgesurfer: ["Surge Surfer", "electric", 2.0],
});

/** What a member must beat for the second half of the payoff -- `TAILWIND_MULTIPLIER`. */
export const TAILWIND_MULTIPLIER = 2.0;

/**
 * A dependent that is REMOVED costs this share of one that is STRANDED.
 *
 * The one choice in this module, and it is a choice: stranding a dependent leaves a dead
 * Ability on the team, while removing it leaves a working field whose next occupant may use it.
 */
export const WASTE_SHARE = 0.5;

/** `_v202_problem_slot_score`'s own weight for one yellow check. */
export const PROBLEM_YELLOW_WEIGHT = 2.25;

/** The row's score is `sum(projected) / 4 + ...`, so an axis reaches it at a quarter. */
export const AXES = 4.0;

// --- the vocabulary, shared with the rest of the codebase ----------------------------------
//
// `field_synergy.ITEM_SUPPORT` / `ABILITY_SUPPORT` and `_V494_MOVES_NEEDING_SUPPORT` (plus
// `field_synergy.EXTRA_MOVES_NEEDING_SUPPORT`). They live here now so that `team-suggest.js`
// and this module cannot drift apart; `team-suggest.js` re-exports MOVE_SUPPORT as
// MOVES_NEEDING_SUPPORT, which is the name `team-autobuild.js` imports.

export const ITEM_SUPPORT = Object.freeze({
  psychicseed: "psychic", grassyseed: "grassy", electricseed: "electric", mistyseed: "misty",
  terrainextender: "terrain", heatrock: "sun", damprock: "rain", smoothrock: "sand", icyrock: "snow",
});
export const ABILITY_SUPPORT = Object.freeze({
  chlorophyll: "sun", solarpower: "sun", flowergift: "sun", swiftswim: "rain", raindish: "rain",
  sandrush: "sand", sandforce: "sand", sandveil: "sand", slushrush: "snow", snowcloak: "snow",
  surgesurfer: "electric", grasspelt: "grassy",
});
export const MOVE_SUPPORT = Object.freeze({
  solarbeam: "sun", solarblade: "sun", electroshot: "rain", auroraveil: "snow", steelroller: "terrain",
  grassyglide: "grassy", weatherball: "weather", terrainpulse: "terrain", thunder: "rain", hurricane: "rain",
  blizzard: "snow", expandingforce: "psychic", risingvoltage: "electric",
});

/** `_SIMPLE_WEATHER_SETTERS_V187` + `_SIMPLE_TERRAIN_SETTERS_V187`, quoted. */
export const SETTER_TABLE = Object.freeze({
  sun: ["drought", "orichalcumpulse", "sunnyday"],
  rain: ["drizzle", "primordialsea", "raindance"],
  sand: ["sandspit", "sandstorm", "sandstream"],
  snow: ["chillyreception", "snowscape", "snowwarning"],
  electric: ["electricsurge", "electricterrain", "hadronengine"],
  grassy: ["grassysurge", "grassyterrain"],
  psychic: ["psychicsurge", "psychicterrain"],
  misty: ["mistysurge", "mistyterrain"],
});

export const TERRAIN_FIELDS = ["electric", "grassy", "psychic", "misty"];
export const WEATHER_FIELDS = ["rain", "sun", "sand", "snow"];

/** A move needing *any* field is not a dependency on one setter. */
export const WILDCARD_CONDITIONS = ["weather", "terrain"];

const FIELD_PHRASES = Object.freeze({
  rain: "rain", sun: "sun", sand: "sand", snow: "snow",
  electric: "Electric Terrain", grassy: "Grassy Terrain",
  psychic: "Psychic Terrain", misty: "Misty Terrain",
  terrain: "a terrain", weather: "weather",
});

const UNGROUNDED_ABILITIES = ["levitate"];
const UNGROUNDED_ITEMS = ["airballoon"];

/** `field_synergy.grounded`: whether terrain reaches this Pokemon. */
export function grounded(types, ability = "", item = "") {
  if ((types || []).some((kind) => compactKey(kind) === "flying")) return false;
  if (UNGROUNDED_ABILITIES.includes(compactKey(ability))) return false;
  return !UNGROUNDED_ITEMS.includes(compactKey(item));
}

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
/**
 * Python `round(x, n)`, through `pyFixed` -- never `Math.round(x * 100) / 100`.
 *
 * The two disagree: Python rounds the EXACT binary value, so `round(4.795, 2)` is 4.79 because
 * 4.795 is really 4.79499999999999993, while `Math.round(4.795 * 100) / 100` is 4.8 because the
 * multiply lands on 479.50000000000006. The sand team's support bonus is exactly 4.795, so the
 * naive form would have put the app at 4.79 and this port at 4.8 -- and the suites could not see
 * it, because every recording replays with the rule off. Nothing on the scoring path is rounded
 * at all: `support`, `stranded`, `adjustment` and the loads stay full floats, and only the
 * numbers a reader is shown are rounded here.
 */
const round2 = (value) => Number(pyFixed(num(value), 2));

// --- the member view ------------------------------------------------------------------------

/** One team member: the five things an entry carries, plus its types and its Speed. */
export function fieldMember(name, types = [], ability = "", item = "", moves = [], speed = 0) {
  return {
    name: String(name ?? "").trim(),
    types: (types || []).map((kind) => String(kind ?? "").trim()).filter(Boolean),
    ability: String(ability ?? "").trim(),
    item: String(item ?? "").trim(),
    moves: (moves || []).map((move) => String(move ?? "").trim()).filter(Boolean),
    speed: num(speed),
  };
}

/** The member view of one evaluation slot. `mon` carries the real set, entry the saved one. */
export function memberFromSlot(slot, speedOf) {
  const entry = slot?.entry || {};
  const mon = slot?.mon || {};
  const name = String(mon.display_name || mon.form_name || entry.form || entry.pokemon || "").trim();
  return fieldMember(name, mon.types || entry.types || [],
    mon.ability || entry.ability, entry.item || mon.item,
    (entry.moves || mon.moves || []), typeof speedOf === "function" ? speedOf(mon) : mon.speed);
}

// --- the graph ------------------------------------------------------------------------------

/** {field -> the slots that switch it on}, Abilities and moves together. */
export function fieldsSetBy(members, table = SETTER_TABLE) {
  const setters = {};
  const needles = Object.entries(table || {}).map(([field, values]) =>
    [String(field).trim().toLowerCase(), new Set((values || []).map(compactKey))]);
  (members || []).forEach((row, index) => {
    const keys = new Set([compactKey(row?.ability), ...(row?.moves || []).map(compactKey)]);
    keys.delete("");
    for (const [field, wanted] of needles) {
      if ([...keys].some((key) => wanted.has(key))) {
        setters[field] = setters[field] || [];
        if (!setters[field].includes(index)) setters[field].push(index);
      }
    }
  });
  return setters;
}

/** V402's own grade for one field Ability, before any measurement. */
export function abilityGrade(ability) {
  const key = compactKey(ability);
  if (SPEED_DOUBLERS[key]) return HARD_GRADE;
  return num(MEDIUM_GRADES[key], PLAIN_GRADE);
}

/** Every (dependent, field) pair on this team, graded but not yet measured. */
export function dependencies(members, table = SETTER_TABLE) {
  const rows = (members || []).map((row) => row || {});
  const setters = fieldsSetBy(rows, table);
  const out = [];
  rows.forEach((row, index) => {
    const found = new Map();
    const note = (field, kind, label, grade) => {
      const token = String(field ?? "").trim().toLowerCase();
      if (!token || WILDCARD_CONDITIONS.includes(token)) return;
      // Terrain reaches the ground and nothing above it, so an ungrounded holder has no
      // terrain dependency -- the same rule that refuses it a terrain seed.
      if (TERRAIN_FIELDS.includes(token) && !grounded(row.types || [], row.ability, row.item)) return;
      const best = found.get(token);
      if (!best || num(grade) > num(best.grade)) {
        found.set(token, { kind, label: String(label ?? "").trim(), grade: num(grade) });
      }
    };
    const ability = compactKey(row.ability);
    if (ABILITY_SUPPORT[ability]) {
      note(ABILITY_SUPPORT[ability], SPEED_DOUBLERS[ability] ? "speed" : "ability",
        row.ability, abilityGrade(ability));
    }
    const item = compactKey(row.item);
    if (ITEM_SUPPORT[item]) note(ITEM_SUPPORT[item], "item", row.item, PLAIN_GRADE);
    const moves = (row.moves || []).map((move) => [compactKey(move), move]);
    const damaging = Math.max(1, moves.filter(([key]) => key).length);
    for (const [key, label] of moves) {
      // Measured, not graded: the share of this member's moves the field is carrying.
      if (MOVE_SUPPORT[key]) note(MOVE_SUPPORT[key], "move", label, PLAIN_GRADE / damaging);
    }
    for (const token of [...found.keys()].sort()) {
      const entry = found.get(token);
      out.push({
        slot: index,
        name: String(row.name || ""),
        field: token,
        kind: entry.kind,
        label: entry.label,
        grade: num(entry.grade),
        severity: num(entry.grade),
        setters: (setters[token] || []).filter((slot) => slot !== index),
        self_set: (setters[token] || []).includes(index),
        payoff: null,
        counts: {},
      });
    }
  });
  return out;
}

// --- the measurement ------------------------------------------------------------------------

/** What doubling this member's Speed is worth against the Top X, counted. */
export function outspeedCounts(speed, multiplier, metaSpeeds) {
  const speeds = (metaSpeeds || []).map((value) => num(value)).filter((value) => value > 0);
  const raw = num(speed);
  const boosted = raw * num(multiplier, 2.0);
  const plainWith = speeds.filter((value) => boosted > value).length;
  const plainWithout = speeds.filter((value) => raw > value).length;
  const tailWith = speeds.filter((value) => boosted > value * TAILWIND_MULTIPLIER).length;
  const tailWithout = speeds.filter((value) => raw > value * TAILWIND_MULTIPLIER).length;
  return {
    meta: speeds.length,
    plain_with: plainWith, plain_without: plainWithout,
    tailwind_with: tailWith, tailwind_without: tailWithout,
    gained: Math.max(0, plainWith - plainWithout),
    gained_tailwind: Math.max(0, tailWith - tailWithout),
  };
}

/** The measured payoff in [0, 1]: the share of both races the field wins. */
export function payoffFromCounts(counts) {
  const meta = Math.max(0, Math.trunc(num(counts?.meta)));
  if (meta <= 0) return 0;
  const gained = num(counts?.gained) + num(counts?.gained_tailwind);
  return Math.max(0, Math.min(1, gained / (2 * meta)));
}

/** A measured grade, inside V402's own span. A payoff of 1 keeps V402's number exactly. */
export function measuredSeverity(grade, payoff) {
  const ceiling = Math.max(PLAIN_GRADE, num(grade, PLAIN_GRADE));
  return PLAIN_GRADE + (ceiling - PLAIN_GRADE) * Math.max(0, Math.min(1, num(payoff)));
}

/** Fill in the payoff for every row whose payoff this codebase can measure. */
export function measure(rows, members, metaSpeeds) {
  const team = members || [];
  return (rows || []).map((row) => {
    const entry = { ...row };
    if (String(entry.kind) === "speed") {
      const slot = Math.trunc(num(entry.slot, -1));
      const holder = slot >= 0 && slot < team.length ? team[slot] || {} : {};
      const ability = compactKey(holder.ability);
      const multiplier = num((SPEED_DOUBLERS[ability] || ["", "", 2.0])[2], 2.0);
      const counts = outspeedCounts(num(holder.speed), multiplier, metaSpeeds);
      const payoff = payoffFromCounts(counts);
      entry.counts = counts;
      entry.payoff = payoff;
      entry.multiplier = multiplier;
      entry.severity = measuredSeverity(entry.grade, payoff);
    }
    return entry;
  });
}

// --- the term, in V402's shape --------------------------------------------------------------

/** [support bonus, stranded penalty, one detail row each] -- `_v402_field_dependency_adjustment`. */
export function teamTerm(rows) {
  let bonus = 0;
  let penalty = 0;
  const details = [];
  for (const row of rows || []) {
    const severity = num(row?.severity, PLAIN_GRADE);
    const setters = [...(row?.setters || [])];
    const detail = {
      pokemon: String(row?.name || ""),
      field: String(row?.field || ""),
      label: String(row?.label || ""),
      kind: String(row?.kind || ""),
      severity: round2(severity),
      payoff: row?.payoff === null || row?.payoff === undefined ? null : Number(pyFixed(num(row.payoff), 4)),
      counts: { ...(row?.counts || {}) },
    };
    if (setters.length) {
      const gained = Math.min(SUPPORT_CEILING, Math.max(SUPPORT_FLOOR, severity * SUPPORT_SHARE));
      bonus += gained;
      Object.assign(detail, { supported: true, setters, adjustment: round2(gained) });
    } else if (row?.self_set) {
      const gained = Math.min(SELF_CEILING, Math.max(SELF_FLOOR, severity * SELF_SHARE));
      bonus += gained;
      Object.assign(detail, { supported: true, setters: [], self: true, adjustment: round2(gained) });
    } else {
      penalty += severity;
      Object.assign(detail, { supported: false, setters: [], adjustment: round2(-severity) });
    }
    details.push(detail);
  }
  return [Math.min(SUPPORT_CAP, bonus), Math.min(STRAND_CAP, penalty), details];
}

/** The whole term for one team: what to add to its Synergy score. */
export function teamAdjustment(members, metaSpeeds, table = SETTER_TABLE) {
  const rows = measure(dependencies(members, table), members, metaSpeeds);
  const [support, stranded, dependencyRows] = teamTerm(rows);
  return {
    // Unrounded on purpose: this is what the Synergy score is moved by, and the app adds the
    // same full float.
    support,
    stranded,
    adjustment: support - stranded,
    dependencies: dependencyRows,
    rows,
  };
}

/** The Synergy points a change in the team is worth, after minus before. */
export function dependencyDelta(before, after) {
  return num(after?.adjustment) - num(before?.adjustment);
}

// --- what removing one member destroys ------------------------------------------------------

/** How much live dependency removing `slot` destroys, in severity points. */
export function removalLoad(rows, slot) {
  const index = Math.trunc(num(slot, -1));
  let load = 0;
  for (const row of rows || []) {
    const severity = num(row?.severity, PLAIN_GRADE);
    const setters = (row?.setters || []).map((value) => Math.trunc(num(value)));
    if (Math.trunc(num(row?.slot, -1)) === index) {
      if (setters.length || row?.self_set) load += severity * WASTE_SHARE;
      continue;
    }
    if (setters.length === 1 && setters[0] === index && !row?.self_set) load += severity;
  }
  return load;
}

/** `removalLoad` for every slot, measured once per team. */
export function removalLoads(members, metaSpeeds, table = SETTER_TABLE) {
  const rows = measure(dependencies(members, table), members, metaSpeeds);
  return (members || []).map((_row, index) => removalLoad(rows, index));
}

/** What a slot's live dependency load is worth in check weights. */
export function problemCredit(load) {
  const share = Math.max(0, Math.min(1, num(load) / HARD_GRADE));
  return PROBLEM_YELLOW_WEIGHT * share;
}

// --- the sentences --------------------------------------------------------------------------

export function fieldPhrase(field) {
  const token = String(field ?? "").trim().toLowerCase();
  return FIELD_PHRASES[token] || token || "a field";
}

const deadFirst = (details) => (details || [])
  .filter((row) => row && !row.supported)
  .map((row) => ({ ...row }))
  .sort((a, b) => num(b.severity) - num(a.severity)
    || (String(a.pokemon) < String(b.pokemon) ? -1 : String(a.pokemon) > String(b.pokemon) ? 1 : 0));

/** One sentence naming what is stranded and the counts behind it. */
export function strandSentence(details, outgoing = "") {
  const dead = deadFirst(details);
  if (!dead.length) return "";
  const first = dead[0];
  const counts = first.counts || {};
  const who = String(outgoing || "").trim();
  const lead = who
    ? `${who} is the team's only ${fieldPhrase(first.field)}`
    : `Nothing on the team sets ${fieldPhrase(first.field)}`;
  const label = String(first.label || "its field ability").trim();
  let body = `${lead}, and ${first.pokemon || "a teammate"}'s ${label} needs it`;
  const gained = Math.trunc(num(counts.gained));
  const gainedTailwind = Math.trunc(num(counts.gained_tailwind));
  const meta = Math.trunc(num(counts.meta));
  if (meta && (gained || gainedTailwind)) {
    // "Speed tiers", not "Top 30 threats": these counts are measured against the synergy
    // layer's own meta table, which is not quite the Speed section's `v51MetaMons`.
    body += ` -- worth ${gained} of ${meta} Top-Meta Speed tiers and ${gainedTailwind} of ${meta} into an opposing Tailwind`;
  }
  if (dead.length > 1) {
    body += dead.length === 2 ? " (+1 more dependency)" : ` (+${dead.length - 1} more dependencies)`;
  }
  return `${body}.`;
}

/** The other direction: a candidate that brings a field something already needs. */
export function fieldGainSentence(beforeDetails, candidate) {
  const dead = deadFirst(beforeDetails);
  if (!dead.length) return "";
  const first = dead[0];
  const who = String(candidate || "the replacement").trim() || "the replacement";
  return `${who} sets ${fieldPhrase(first.field)}, which ${first.pokemon || "a teammate"}'s ${first.label || "field ability"} has been waiting for.`;
}
