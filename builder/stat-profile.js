// A Pokemon's stats are worth something, and a team's stats have a shape.
//
// Ported from the Companion app (`stat_profile_v553.py`, its V553). Suggestions and Auto Build
// scored a candidate's TYPING and never its stats: `typeFit` is a pure type chart (offence
// 100/82/42/10, defence 100/88/50/18/4) and `speedFit` rewards raw Speed. So a Pokemon that is
// frail or cannot threaten anything was priced the same as one that can, as long as its types
// lined up -- which is the owner's own complaint about the app, now the same on both sides.
//
// WHAT THIS DELIBERATELY DOES NOT TOUCH. Team Evaluation's Offense and Defense are already real
// damage rolls over the meta's moves (`use_current_team_sets=True` in the app, `set_aware` here),
// so they ALREADY price stats: a frail four measures 29.8 Defense against a bulky four's 63.0.
// Adding a frailty factor there would charge twice for the same thing. The blind spot was only
// ever the type chart and the row score built on it.
//
// THE RATINGS ARE AGAINST THE FORMAT, NOT ABSOLUTE. Every axis is mapped so the format's own p10
// rates 10, its median 50 and its p90 90, which is what makes "frail for this meta" mean
// something. The two spans per axis are not decoration: each distribution is skewed (bulk's
// median sits 5.0 below its p10 gap and 7.5 under its p90 gap), and a single half-span would put
// one axis's p10 at 18 and another's p90 at 98.
//
// THE GATE. `statProfileRule`, the same shape as `speedAbilityRule`: absent means production
// (on), an explicit 0/false/off means off. Every recorded parity vector in `tests/` was made
// before this rule existed -- `grep stat_profile tests/*-vectors*.json` finds nothing in any of
// the nine -- so those suites replay with the rule OFF, because a recording must be replayed
// under the rules it was made under. `tests/run-stat-profile.mjs` exercises it ON, and holds a
// guard asserting the vector suites really do pass it off.
//
// Numbers, thresholds and reasoning are the app's, unchanged, so the two engines agree; the app's
// module is the reference and `tests/run-stat-profile.mjs` fails if a constant drifts apart.

import { pyFixed } from "./engine.js";

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, low = 0, high = 100) {
  return Math.max(low, Math.min(high, num(value, low)));
}

/** Python round(x, 1) / round(x, 2): exact halves to even, as the app's `round` does. */
function r1(x) {
  return Number(pyFixed(num(x), 1));
}

function r2(x) {
  return Number(pyFixed(num(x), 2));
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

/** Production is on. A replay harness turns it off to match what it recorded. */
export const STAT_PROFILE_RULE = 1;

/** `statProfileRule` as a flag: absent means production (on), an explicit 0/false means off. */
export function statProfileRuleOption(value) {
  if (value === undefined || value === null) return STAT_PROFILE_RULE;
  if (value === false) return 0;
  const text = String(value).trim().toLowerCase();
  if (!text || text === "0" || text === "off" || text === "false" || text === "no" || text === "none") return 0;
  return 1;
}

/** The flag off an evaluator, which is where the suites set it. */
export function statProfileRuleOn(ev) {
  return Boolean(statProfileRuleOption(ev?.statProfileRule));
}

// ---------------------------------------------------------------------------
// the ratings
// ---------------------------------------------------------------------------

/** (median, span below, span above) per axis, measured over all 259 species of the harvest. */
export const STAT_AXES = {
  //            median  below  above      (p10, p90)
  bulk: [17.5, 5.0, 7.5],          // 12.5, 25.0
  offense: [160.0, 45.0, 34.0],    //  115,  194
  speed: [120.0, 65.0, 57.0],      //   55,  177
};

/** 40 rating points per span: the shape that puts p10 at 10 and p90 at 90. */
export const RATING_GAIN = 40.0;

/** A member is frail below this effective HP (HP x harmonic(Def, SpD) / 1000).
 *  Measured: 19.8% of the 11,479 members of the real-team corpus are under it, rating 25.2. */
export const FRAIL_BULK = 14.4;

/** No offensive power below this attacking stat -- or with no damaging move at all, which
 *  answers 0. Measured: 5.8% of the corpus is under it, rating 23.3. */
export const POWERLESS_STAT = 130.0;

/** 0-100 against the format: its p10 is 10, its median 50, its p90 90. */
export function rating(value, axis) {
  const [median, below, above] = STAT_AXES[String(axis)] || [50.0, 50.0, 50.0];
  const number = num(value);
  if (number >= median) return above > 0 ? clamp(50.0 + (RATING_GAIN * (number - median)) / above) : 50.0;
  return below > 0 ? clamp(50.0 - (RATING_GAIN * (median - number)) / below) : 50.0;
}

/** One stat out of whichever spelling the dict happens to use.
 *  Presence, not truthiness: a stat that really is 0 must answer 0, not fall through. */
export function statOf(stats, ...names) {
  const source = stats || {};
  for (const name of names) if (name in source) return num(source[name]);
  return 0.0;
}

/** [physical, special, combined] effective HP in thousands.
 *
 *  Combined is the HARMONIC mean of the two sides: one soft side is a frailty, and an
 *  arithmetic mean would let a high Def hide a low Sp. Def. */
export function bulkValues(stats) {
  const source = stats || {};
  const hp = statOf(source, "hp", "HP");
  const defense = statOf(source, "defense", "def", "DEF");
  const spDefense = statOf(source, "sp_defense", "spd", "SPD", "special_defense");
  const physical = (hp * defense) / 1000.0;
  const special = (hp * spDefense) / 1000.0;
  if (physical <= 0 || special <= 0) return [physical, special, Math.max(0.0, Math.min(physical, special))];
  return [physical, special, 2.0 / (1.0 / physical + 1.0 / special)];
}

/** [the stat its moves use, which side that is].
 *
 *  Most Pokemon only care about one of the two -- 2 of the Doubles Top 30 run both -- so a
 *  physical set is rated on Attack and its Sp. Attack is ignored. A set with no damaging move
 *  at all answers 0.0 / "none", which is what POWERLESS_STAT is there to catch. */
export function attackingStat(stats, physical, special) {
  const source = stats || {};
  const attack = statOf(source, "attack", "atk", "ATK");
  const spAttack = statOf(source, "sp_attack", "spa", "SPA", "special_attack");
  const phys = Math.max(0, Math.trunc(num(physical)));
  const spec = Math.max(0, Math.trunc(num(special)));
  if (phys && spec) return [Math.max(attack, spAttack), "mixed"];
  if (phys) return [attack, "physical"];
  if (spec) return [spAttack, "special"];
  return [0.0, "none"];
}

/** Every rating and flag for one Pokemon, from its stats and its own moves. */
export function memberRatings(stats, physical, special) {
  const [physicalBulk, specialBulk, combined] = bulkValues(stats);
  const [attacking, side] = attackingStat(stats, physical, special);
  return {
    offense: r1(attacking > 0 ? rating(attacking, "offense") : 0.0),
    bulk: r1(rating(combined, "bulk")),
    bulk_physical: r1(rating(physicalBulk, "bulk")),
    bulk_special: r1(rating(specialBulk, "bulk")),
    speed: r1(rating(statOf(stats || {}, "speed", "spe", "SPE"), "speed")),
    attacking_stat: r1(attacking),
    attacking_side: side,
    bulk_value: r2(combined),
    // The FLAGS are the measured values, not the ratings: the corpus was counted at these
    // thresholds, and a later re-calibration of a rating curve must not quietly move what
    // "frail" means.
    frail: Boolean(combined < FRAIL_BULK),
    powerless: Boolean(attacking < POWERLESS_STAT),
  };
}

/** The rating dict for one of this codebase's profiles (`TeamSynergy.profile` / `TeamChecks`).
 *
 *  `battle_stats` is already the slot's FINAL stats (`statsFor` -> `engine.finalStats`), which
 *  is what the app's `_v121_entry_stats` returns too -- the metadata stat plus the species'
 *  most-common Stat Points and Nature. Rating a base stat here would read every candidate low. */
export function memberFromProfile(profile) {
  const source = profile || {};
  // TWO PROFILE BUILDERS, AND THEY DISAGREE ABOUT BOTH FIELDS THIS NEEDS.
  // `TeamChecks.profile` (what a suggestion row's candidate profile is) returns `physical` and
  // `special` as ARRAYS OF MOVE NAMES and its stats under `stats`; `TeamSynergy.profile` (what
  // the team's own slots are read through) returns them as COUNTS and its stats under
  // `battle_stats`. Both reach this function, and `Number([...])` is NaN -- which read every
  // candidate as having no damaging move at all, so every one of them rated offence 0 and came
  // out POWERLESS, Mega Salamence included. Normalise instead of trusting either shape.
  const countOf = (value) => (Array.isArray(value) ? value.length : Math.max(0, Math.trunc(num(value))));
  const stats = source.battle_stats || source.stats || null;
  // The app's `is_stamped` guard, and it matters: with no stats at all `bulkValues` answers 0,
  // so an unstamped profile would be rated FRAIL AND POWERLESS and charged for both. Answering
  // null instead makes every caller decide, and `teamBalance` drops it the way it drops an
  // empty slot -- a four-Pokemon team is judged as a four-Pokemon team.
  if (!stats || statOf(stats, "hp", "HP") <= 0) return null;
  const member = memberRatings(stats, countOf(source.physical), countOf(source.special));
  const name = String(source.name || source.pokemon || "").trim();
  return name ? { ...member, name } : member;
}

// ---------------------------------------------------------------------------
// the team's shape
// ---------------------------------------------------------------------------

/** (frail allowance, passenger allowance). AN ARCHETYPE CAN ONLY BUY MORE TOLERANCE, never
 *  less: the 1946-team corpus has no archetype labels, so a stricter-than-measured allowance
 *  would be an unmeasured hunch that punishes teams real players bring, while a more lenient
 *  one only withholds a penalty -- and each of these has a mechanical reason to withhold it.
 *  Everything not listed (balanced, goodstuff, bulky offense, setup, trick room, tailwind,
 *  rain, sun, sand, snow, terrain) uses the measured default. */
export const DEFAULT_ALLOWANCE = [2, 1];
export const ARCHETYPE_ALLOWANCE = {
  // Frailty is what the damage was bought with.
  "hyper offense": [4, 1],
  offense: [3, 1],
  // Four turns of halved damage is bulk the ratings cannot see.
  screens: [3, 1],
  // Winning without attacking is the plan, so a passenger is the team.
  stall: [2, 3],
  "semi-stall": [2, 3],
  "perish trap": [2, 3],
};

/** The archetypes whose plan is to be slower than the opponent. */
export const SLOW_PLAN_ARCHETYPES = new Set(["trick room"]);

/** V511's own pivot and formula, reused so Auto Build and Suggestions agree. */
export const SLOW_PLAN_PIVOT = 125.0;

/** What one member over the allowance costs, in the units the redundancy penalty beside it
 *  already uses (type redundancy 5, role redundancy 4, three Megas 5, too little Protect 8). */
export const FRAIL_STEP = 6.0;
export const POWERLESS_STEP = 7.0;
export const BALANCE_PENALTY_CAP = 18.0;

export function allowanceFor(archetype) {
  const key = String(archetype ?? "").trim().toLowerCase();
  return ARCHETYPE_ALLOWANCE[key] || DEFAULT_ALLOWANCE;
}

export function slowPlan(archetype) {
  return SLOW_PLAN_ARCHETYPES.has(String(archetype ?? "").trim().toLowerCase());
}

function namesOf(rows) {
  const out = [];
  for (const row of rows || []) {
    const name = String((row || {}).name || "").trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function joinNames(values, limit = 4) {
  const list = (values || []).map((v) => String(v)).filter((v) => v.trim());
  if (!list.length) return "unnamed";
  if (list.length <= limit) return list.join(", ");
  return `${list.slice(0, limit).join(", ")} and ${list.length - limit} more`;
}

function archetypeLabel(archetype) {
  const key = String(archetype ?? "").trim().toLowerCase();
  if (!key || key === "automatic" || key === "automatically" || key === "auto") return "a balanced team";
  return `a ${key} team`;
}

/** What the team's stats look like as a set, and what that costs.
 *
 *  `members` are the per-member rating dicts. Only the slots that are FILLED count: a
 *  four-Pokemon team is judged as a four-Pokemon team, exactly as the Protect and redundancy
 *  penalties beside this one are. */
export function teamBalance(members, archetype = "") {
  const rows = (members || []).filter((row) => row && typeof row === "object").map((row) => ({ ...row }));
  const count = rows.length;
  const [frailAllowance, powerlessAllowance] = allowanceFor(archetype);
  const frail = rows.filter((row) => Boolean(row.frail));
  const powerless = rows.filter((row) => Boolean(row.powerless));
  const excessFrail = Math.max(0, frail.length - frailAllowance);
  const excessPowerless = Math.max(0, powerless.length - powerlessAllowance);
  const penalty = Math.min(BALANCE_PENALTY_CAP, FRAIL_STEP * excessFrail + POWERLESS_STEP * excessPowerless);

  const lines = [];
  if (excessFrail) {
    lines.push(`${frail.length} of ${count} are frail for this meta (${joinNames(namesOf(frail))}); `
      + `${archetypeLabel(archetype)} allows ${frailAllowance}.`);
  }
  if (excessPowerless) {
    lines.push(`${powerless.length} of ${count} bring no offensive power (${joinNames(namesOf(powerless))}); `
      + `${archetypeLabel(archetype)} allows ${powerlessAllowance}.`);
  }
  const offenseValues = rows.map((row) => num(row.offense));
  const bulkRatings = rows.map((row) => num(row.bulk));
  return {
    count,
    archetype: String(archetype ?? "").trim().toLowerCase(),
    frail: frail.length,
    frail_names: namesOf(frail),
    frail_allowance: frailAllowance,
    powerless: powerless.length,
    powerless_names: namesOf(powerless),
    powerless_allowance: powerlessAllowance,
    penalty: r2(penalty),
    average_offense: count ? r1(offenseValues.reduce((a, b) => a + b, 0) / count) : 0.0,
    average_bulk: count ? r1(bulkRatings.reduce((a, b) => a + b, 0) / count) : 0.0,
    lines,
    summary: lines.length ? lines.join(" ") : "The team's stats are balanced for its archetype.",
  };
}

// ---------------------------------------------------------------------------
// what a candidate's stats are worth
// ---------------------------------------------------------------------------

/** Fit points, each way, for a candidate's own offence and own bulk. A fit point is
 *  0.32/4 = 0.08 of a row score, so each axis spans 2.4 score points either way: more than the
 *  meta-rank bonus (4.0 end to end), less than the calc-backed threat terms (+-18). */
export const STAT_FIT_SPAN = 30.0;

/** Row-score points per point of balance penalty the candidate removes (or adds), and the cap.
 *  Removing one excess frail member is 6 penalty points, so 3.0 score points; the cap is
 *  reached by a candidate that repairs (or breaks) two counts at once. Smaller than the
 *  archetype speed plan (+-26) and the calc-backed threat terms (+-18), bigger than the
 *  meta-rank bonus: the team's shape breaks ties, it does not decide. */
export const BALANCE_SCORE_PER_POINT = 0.5;
export const BALANCE_SCORE_CAP = 6.0;

/** Fit points for one rating: 0 at the format's median, +-span at the ends. */
export function fitDelta(ratingValue, span = STAT_FIT_SPAN) {
  return Math.max(-span, Math.min(span, (span * (num(ratingValue) - 50.0)) / 50.0));
}

/** [offence fit delta, defence fit delta] for one candidate's own stats. */
export function candidateDeltas(member) {
  const source = member || {};
  return [fitDelta(source.offense), fitDelta(source.bulk)];
}

/** Row-score points for what the candidate does to the team's stat shape: positive when it
 *  removes a penalty the team was paying, negative when it adds one. */
export function balanceScoreDelta(before, after) {
  const removed = num((before || {}).penalty) - num((after || {}).penalty);
  return Math.max(-BALANCE_SCORE_CAP, Math.min(BALANCE_SCORE_CAP, BALANCE_SCORE_PER_POINT * removed));
}

/** `speedFit`'s number with the team's speed plan pointing it.
 *
 *  V511's `directedSpeedFit` formula, unchanged and for the same reason: on a Trick Room team
 *  the slow half of the speed tiers is the half you want, and `35 + min(30, speed / 5)` pays for
 *  the opposite. Only the raw-Speed term moves -- the Speed-control and priority credits the
 *  base fit already added are kept exactly as they are. This is the Auto Build path, where
 *  V511's own directed fit stands down; the two now agree. */
export function directedSpeedFitFromBase(speed, archetype, baseFit) {
  const base = num(baseFit);
  if (!slowPlan(archetype)) return base;
  const value = num(speed);
  const forward = Math.min(30.0, Math.max(0.0, value) / 5.0);
  const backward = Math.min(30.0, Math.max(0.0, SLOW_PLAN_PIVOT - value) / 4.0);
  return clamp(base - forward + backward);
}

function sideWord(side) {
  const key = String(side ?? "").trim().toLowerCase();
  if (key === "physical") return "its physical";
  if (key === "special") return "its special";
  if (key === "mixed") return "its better";
  return "its";
}

/** The sentence a suggestion row shows for its stat term, or "". */
export function candidateLine(member, balanceDelta = 0.0) {
  const source = member || {};
  const offense = num(source.offense);
  const bulk = num(source.bulk);
  const side = String(source.attacking_side || "none");
  const parts = [];
  // The FLAGS first, so the sentence cannot disagree with the counts the balance penalty was
  // built from: Sneasler rates 28 for bulk and is frail, and a line calling it average while
  // the score charges for it would be worse than no line at all.
  if (side === "none") parts.push("brings no damaging move, so no offensive stat to rate");
  else if (source.powerless) parts.push(`${sideWord(side)} attack is too low to threaten this meta`);
  else if (offense >= 75.0) parts.push(`${sideWord(side)} attack is in the format's top quarter`);
  else if (offense <= 25.0) parts.push(`${sideWord(side)} attack is in the format's bottom quarter`);
  if (source.frail) parts.push("frail for this meta");
  else if (bulk >= 75.0) parts.push("bulky for this meta");
  if (num(balanceDelta) > 1e-9) parts.push("and it repairs the team's stat balance");
  else if (num(balanceDelta) < -1e-9) parts.push("and it worsens the team's stat balance");
  if (!parts.length) return "";
  return `Stats: ${parts.join(", ")}.`;
}
