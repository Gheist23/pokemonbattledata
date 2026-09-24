// Suggested Pokémon, ported from the Companion app (_v307_suggestion_worker).
//
// Every ranked meta Pokemon that is not already on the team is tried in the open
// slot (or in place of the weakest member when the team is full) on its most
// common set, and scored by the app's layers, innermost first:
//
//   V378  checks, type fit into the critical threats, partner typing, Speed
//   V418  newly failed / worsened Team Building Checks
//   V419  no "review any role" note
//   V429  archetype requirement coverage (+-30)
//   V451  before/after Team Building Check penalties, enabled checks only
//         (it replaces V433, which scored every check)
//   V466  strategy fit: archetype speed plan, Speed Control fixes, then the
//         installers (Trick Room plan, terrain reach, archetype payoff,
//         condition-dependent moves)
//   V480  Item Clause
//   V494  a Mega Stone candidate is named as its Mega; a type-fit answer that
//         loses the actual matchup is taken back
//
// The candidate set is the app's common set (_v123/_v113) with its move gate
// (a move whose weather/terrain the team cannot set is not offered) and its
// field repair (an item or Ability the team cannot switch on is replaced).
// Every candidate set then carries the Pokémon's guaranteed moves (at least 95%
// usage; builder/guaranteed-moves.js), unless the option switches the rule off.
// Its Nature and its Stat Points are put together by builder/nature-spreads.js
// instead of by the two usage lists' positions, unless that option is switched off too.

import { compact, makeMon, pyFixed, pyRound } from "./engine.js";
import { GUARANTEED_MOVE_SHARE, describeChanges, enforce, lockedMoves, moveShares, shareOption } from "./guaranteed-moves.js";
import { PAIRED_SPREADS, pairedOption, spreadPointsForNature } from "./nature-spreads.js";
import { FOUND_IN_TEAM_NOTE } from "./known-teams.js";
import { classifyArchetype, tailwindBeneficiaries } from "./team-checks.js";
import { roomPlan } from "./team-speed.js";

// The Nature / Stat Point pairing lives in builder/nature-spreads.js, so team-eval.js's
// candidate spreads and the pairing here cannot drift apart; re-exported for its old callers.
export { spreadPointsForNature } from "./nature-spreads.js";

const TEAM_SIZE = 6;
const ROW_LIMIT = 14;
const TYPES = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy"];

// _V494_MOVES_NEEDING_SUPPORT (+ field_synergy EXTRA_MOVES_NEEDING_SUPPORT)
export const MOVES_NEEDING_SUPPORT = {
  solarbeam: "sun", solarblade: "sun", electroshot: "rain", auroraveil: "snow", steelroller: "terrain",
  grassyglide: "grassy", weatherball: "weather", terrainpulse: "terrain", thunder: "rain", hurricane: "rain",
  blizzard: "snow", expandingforce: "psychic", risingvoltage: "electric",
};
// field_synergy ITEM_SUPPORT / ABILITY_SUPPORT
const ITEM_SUPPORT = { psychicseed: "psychic", grassyseed: "grassy", electricseed: "electric", mistyseed: "misty", terrainextender: "terrain", heatrock: "sun", damprock: "rain", smoothrock: "sand", icyrock: "snow" };
const ABILITY_SUPPORT = { chlorophyll: "sun", solarpower: "sun", flowergift: "sun", swiftswim: "rain", raindish: "rain", sandrush: "sand", sandforce: "sand", sandveil: "sand", slushrush: "snow", snowcloak: "snow", surgesurfer: "electric", grasspelt: "grassy" };
const TERRAIN_CONDITIONS = ["grassy", "psychic", "electric", "misty"];
// team_evaluation_v466 FAST_SPEED_CONTROL
const FAST_SPEED_CONTROL = new Set(["tailwind", "icywind", "electroweb", "thunderwave", "nuzzle", "scaryface", "stringshot", "bulldoze", "rocktomb", "lowsweep", "pounce", "mudshot", "drumbeating"]);
// archetype_payoff
const CONDITION_BY_ARCHETYPE = { rain: "rain", sun: "sun", sand: "sand", snow: "snow", terrain: "terrain", tailwind: "tailwind", "trick room": "trick room" };
const WEATHERS = ["rain", "sun", "sand", "snow"];

export function clamp(value, low = 0, high = 100) {
  const v = Number(value);
  return Math.max(low, Math.min(high, Number.isFinite(v) ? v : low));
}

/** Python round(x, n): correctly rounded, exact halves to even. */
export function r1(x) {
  return Number(pyFixed(Number(x) || 0, 1));
}

function r2(x) {
  return Number(pyFixed(Number(x) || 0, 2));
}

function r3(x) {
  return Number(pyFixed(Number(x) || 0, 3));
}

export function uniqueNames(values, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value ?? "").trim();
    const k = compact(text);
    if (text && k && !seen.has(k)) {
      seen.add(k);
      out.push(text);
    }
    if (out.length >= limit) break;
  }
  return out;
}

function pyTitle(text) {
  return String(text).replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

function severityOf(row) {
  const v = String(row?.severity || "good").toLowerCase();
  return v === "red" ? "red" : v === "yellow" ? "yellow" : "good";
}

function severityValue(row) {
  return { good: 0, yellow: 1, red: 2 }[String(row?.severity || "good").toLowerCase()] ?? 0;
}

function rowKey(row) {
  return String(row?.check_id || row?.kind || "").trim();
}

const MAX_DEFENSIVE_WARNINGS = 2; // team_build_constraints

const RESULT_FIELDS = ["attacker", "defender", "attacker_side", "move", "percent", "label", "full_label", "hits", "chance", "full_hits", "full_chance", "attacker_speed", "move_priority",
  "speed_tier_suppressed", "pre_speed_tier_label", "pre_speed_tier_hits", "condition_range", "range_min_percent", "range_min_label", "range_max_percent",
  "range_max_label", "range_max_condition", "weather", "terrain"];

/** A calc result cut to what a calc line shows (builder/calc-format.js), for rows sent to the page. */
export function compactResult(result) {
  if (!result || typeof result !== "object") return null;
  const out = {};
  for (const k of RESULT_FIELDS) if (result[k] !== undefined && result[k] !== null && result[k] !== "") out[k] = result[k];
  return out;
}
const MAX_STRUCTURAL_SETS = 18; // V449_MAX_STRUCTURAL_SET_VARIANTS

/** _v483_speed_reducing_nature: keep the role the nature (or the Stat Points) says. */
export function speedReducingNature(spread, natures) {
  const current = String(spread?.nature_name || spread?.name || "Serious").trim() || "Serious";
  const [boosted, reduced] = natures[current] || ["", ""];
  if (String(reduced || "").toUpperCase() === "SPE") return current;
  const mapping = { ATK: "Brave", SPA: "Quiet", DEF: "Relaxed", SPD: "Sassy" };
  const up = String(boosted || "").toUpperCase();
  if (mapping[up]) return mapping[up];
  const b = [...(spread?.bonuses || []), 0, 0, 0, 0, 0, 0];
  const roles = { ATK: Number(b[1]) || 0, DEF: Number(b[2]) || 0, SPA: Number(b[3]) || 0, SPD: Number(b[4]) || 0 };
  const tie = { ATK: 4, SPA: 3, DEF: 2, SPD: 1 };
  const best = Object.keys(roles).sort((x, y) => roles[y] - roles[x] || tie[y] - tie[x])[0];
  return roles[best] > 0 ? mapping[best] : "Brave";
}

// --- V466 helpers -------------------------------------------------------------------

/** team_evaluation_v466.archetype_speed_control_fit */
function archetypeSpeedControlFit(archetype, moves, trSetters, twSetters) {
  const keys = new Set((moves || []).map(compact).filter(Boolean));
  const hasTr = keys.has("trickroom");
  const hasTw = keys.has("tailwind");
  const fast = [...keys].filter((k) => FAST_SPEED_CONTROL.has(k));
  let conflict = false;
  let adjustment = 0;
  let reason = "";
  if (["hyper offense", "tailwind", "offense"].includes(archetype)) {
    if (hasTr) {
      conflict = true;
      adjustment -= 36 + Math.min(18, trSetters * 18);
      reason = "Trick Room conflicts with a fast offensive speed plan; extra setters do not fix that conflict.";
    }
    if (hasTw) {
      if (twSetters >= 1) {
        adjustment += 4;
        reason = "The team already sets Tailwind, so a second setter adds little to the speed plan.";
      } else {
        adjustment += archetype === "hyper offense" || archetype === "tailwind" ? 22 : 16;
        reason = "Tailwind directly supports the team's fast offensive speed plan.";
      }
    } else if (fast.length) {
      adjustment += 11;
      if (!reason) reason = "Fast speed control supports the team's offensive speed plan.";
    }
  } else if (archetype === "trick room") {
    if (hasTw && twSetters <= 0) {
      conflict = true;
      adjustment -= 28;
      reason = "Isolated Tailwind conflicts with the team's Trick Room speed plan.";
    }
    if (hasTr) {
      adjustment += 22;
      reason = "Trick Room reinforces the team's primary speed plan.";
    }
  } else if (["balanced", "goodstuff", "bulky offense", "semi-stall", "stall", "setup"].includes(archetype)) {
    if (hasTr || hasTw || fast.length) {
      adjustment += 7;
      reason = "Adds direct speed control without conflicting with the current flexible archetype.";
    }
  }
  return { conflict, adjustment, reason, has_trick_room: hasTr, has_tailwind: hasTw };
}

// --- V511: a suggestion is ranked on what it does, not on one move it holds ----------
//
// suggestion_scoring_v511.py. On a Trick Room team the list was, in the owner's words,
// "every Pokémon with Trick Room", because `archetypeSpeedControlFit` paid a carrier a flat
// +22 however many setters the team already had (the Tailwind branch above it damps to +4
// at one setter; that damping was never applied back). Two stages fix it:
//
//   stage one   the archetype reward is damped by what the team already has, the same move
//               is not charged a second time by the coverage layer, and speed fit points
//               the way the team's plan points (a Trick Room team wants slow);
//   stage two   the best 40 candidates are measured against the team's 8 worst threats with
//               the engine the Team Evaluation uses, and three calc-backed terms decide the
//               order: what it answers, what it covers that the team has nothing for, and
//               what removes it first.
//
// Version 3 answers the owner's second report ("the suggestions still show just Trick Room
// users"). Version 2 damped `archetypeSpeedControlFit` and stopped there, and the archetype's
// requirement list *is* the speed plan: on a Trick Room team one requirement is "Trick Room
// setters, at least 2, critical", so up to version 2 `v429` paid a carrier for closing it --
// +14.75, undamped, more than the damped speed plan itself (of which a flat +5 was simply for
// closing a critical requirement, identical for every carrier).
// Measured on Indeedee-F / Milotic / Sylveon / Rillaboom (one setter, one open slot): 20 of
// the stage-one top 20 carried Trick Room, seven tied at exactly 90.9 against 74.9 for the
// best Pokémon that did not, and 12 of the 14 shown rows still carried it after the calcs --
// five of those answering none of the team's eight worst threats.
//
// Plain Suggestions only: Auto Build has its own archetype machinery and keeps the weights
// it was tuned with, so its recorded runs still replay.

/** The rule version production runs; a recording stamps it as `rules.suggestion_scoring`. */
export const SUGGESTION_SCORING = 3;

/**
 * What another Trick Room carrier is worth once the plan has 0 / 1 / 2+ setters, per rule
 * version. **Every version the app has ever stamped is kept here.** A stamp selects behaviour,
 * not just on or off: a recording stamped 2 replays exactly as version 2 scored it, one
 * stamped 3 as version 3, and an unstamped one with the rule off entirely - the same contract
 * the guaranteed-move, Nature-pairing and terrain-seed rules follow.
 *
 * Version 3's floor is zero, not a token: once the plan runs, carrying the move is worth
 * nothing extra and what the Pokémon does decides the ranking. At one setter the plan does
 * want a second, but roughly a tenth of the pool can supply it, so the credit stays under the
 * span the calcs move (±18).
 */
const TRICK_ROOM_BY_SETTERS_BY_RULE = { 2: [22, 12, 2], 3: [22, 10, 0] };
/** `archetypeSpeedControlFit`'s own flat reward, which no version changes. */
const FLAT_TRICK_ROOM_REWARD = 22;
/** The version that stopped the coverage layer charging for the same move twice. */
const COVERAGE_CORRECTION_FROM_RULE = 3;
/**
 * The archetype requirement labels the damped speed-plan term above already prices, so the
 * coverage layer must not pay for them again. Nothing else is touched: the weather setter
 * requirements are paid by `payoff`, and "Speed-control users" is a role, not one move.
 */
const SPEED_PLAN_REQUIREMENT = { "trick room": "trick room setters", tailwind: "tailwind setters" };
const COVERAGE_WEIGHT = 52; // v429: coverage delta -> score
const COVERAGE_CRITICAL_FIXED = 5; // v429: flat, for closing a critical requirement
const COVERAGE_CRITICAL_WORSENED = 8;
const COVERAGE_SPAN = 30; // v429 clamps its own adjustment to ±30
const CRITICAL_WEIGHT = 2.4; // v429: a critical requirement weighs 2.4
const SPEED_CONTROL_CREDIT = 24;
const SPEED_CONTROL_CREDIT_ALREADY_PAID = 8;
const PRIORITY_CREDIT = 10;
const SLOW_PLAN_PIVOT = 125; // the Speed at which a Trick Room team stops caring
// The base row folds speed fit in as (fit - 50) * 0.32 and then divides four projected
// scores by four, so one point of speed fit is 0.08 score points.
const SPEED_FIT_TO_SCORE = 0.32 / 4;
const SHORTLIST = 40; // candidates that get real calcs
const DEEP_THREATS = 8; // threats each of them is measured against
const ANSWER_SPAN = 18;
const ANSWER_MIDPOINT = 45;
const ANSWER_SCALE = 0.3;
const GAP_SPAN = 18;
const VULNERABLE_SPAN = 14;
const THREATEN_MAX_HITS = 2; // a 1-2HKO is a real threat (the V494 rule)
const WALL_MIN_INCOMING = 4; // it needs 4+ hits to remove us
/** How much a verdict is worth, 0..1, and the order the breakdown lists them in. */
export const VERDICT_VALUE = { beats: 1, walls: 0.85, chips: 0.35, trades: 0.15, loses: 0 };
const VERDICT_SORT = { beats: 0, walls: 1, chips: 2, trades: 3, loses: 4 };

/**
 * The scoring version in force. Left out, production's version; null (an unstamped
 * recording) or "off"/"0"/"false"/"no"/"none", the rule is off and the old weights rank.
 */
export function suggestionScoringOption(value) {
  if (value === undefined) return SUGGESTION_SCORING;
  if (value === null || value === "" || value === false) return 0;
  if (value === true) return SUGGESTION_SCORING;
  const text = String(value).trim().toLowerCase();
  if (["off", "false", "no", "none", "0"].includes(text)) return 0;
  const version = Number.parseInt(text, 10);
  if (Number.isFinite(version)) return version > 0 ? version : 0;
  return SUGGESTION_SCORING;
}

/**
 * suggestion_scoring_v511.rule_table: the damping table the given version scored with. An
 * unknown (newer) version uses production's, so a recording from a build ahead of this one is
 * replayed on the newest weights rather than refused.
 */
export function ruleTable(rule) {
  const version = Math.trunc(Number(rule) || 0) || SUGGESTION_SCORING;
  return TRICK_ROOM_BY_SETTERS_BY_RULE[version] || TRICK_ROOM_BY_SETTERS_BY_RULE[SUGGESTION_SCORING];
}

/** suggestion_scoring_v511.trick_room_reward */
export function trickRoomReward(setters, rule) {
  const table = ruleTable(rule);
  const index = Math.max(0, Math.min(table.length - 1, Math.trunc(Number(setters) || 0)));
  return table[index];
}

/**
 * suggestion_scoring_v511.damped_speed_plan: `archetypeSpeedControlFit` with the Trick Room
 * branch damped the way the Tailwind branch already was. Only the positive reward on a Trick
 * Room team moves: a conflict penalty is a refusal, and refusing Trick Room on a fast team
 * was never the complaint.
 * @returns {[number, string]} the adjustment and the reason line that replaces the old one
 */
export function dampedSpeedPlan(fit, archetype, trickRoomSetters, rule) {
  const adjustment = Number(fit?.adjustment) || 0;
  const reason = String(fit?.reason || "");
  if (String(archetype || "").trim().toLowerCase() !== "trick room") return [adjustment, reason];
  if (!fit?.has_trick_room) return [adjustment, reason];
  const setters = Math.trunc(Number(trickRoomSetters) || 0);
  const reward = trickRoomReward(setters, rule);
  const damped = adjustment - FLAT_TRICK_ROOM_REWARD + reward;
  if (setters >= 2) {
    // Version 2 paid a token +2 here and said so; version 3 pays nothing.
    const adds = reward <= 0 ? "nothing" : "little";
    return [damped, `The team already sets Trick Room, so another setter adds ${adds} to the speed plan; what it does against the threats decides this.`];
  }
  if (setters === 1) return [damped, "A second Trick Room setter makes the speed plan reliable."];
  return [damped, "Trick Room reinforces the team's primary speed plan."];
}

/** suggestion_scoring_v511.speed_plan_requirement */
export function speedPlanRequirement(archetype) {
  return SPEED_PLAN_REQUIREMENT[String(archetype || "").trim().toLowerCase()] || "";
}

const requirementLabel = (req) => String(req?.label || "requirement").trim().replace(/\s+/g, " ").toLowerCase();
const requirementWeight = (req) => (req?.critical ? CRITICAL_WEIGHT : 1);

/**
 * suggestion_scoring_v511.coverage_adjustment: `v429`'s own arithmetic re-derived from the
 * two requirement lists the row already carries, so the correction below is a difference
 * rather than a guess. `hold` is a requirement label whose *improvement* is withheld, having
 * been paid for once already; a worsening still counts, because swapping away a setter the
 * plan needs really does cost the team something.
 * @param {(req: object) => number} ratioOf  `requirementRatio`
 */
export function coverageAdjustment(beforeRequirements, afterRequirements, ratioOf, hold = "") {
  const indexed = (list) => new Map((list || []).filter((r) => r && typeof r === "object").map((r) => [requirementLabel(r), r]));
  const before = indexed(beforeRequirements);
  const after = indexed(afterRequirements);
  // Each side is divided by its own total, the way `archetypeCoverage` does it: adding a
  // Pokémon can move the team into a different archetype, and then the two requirement lists
  // are not the same list.
  const sum = (map) => [...map.values()].reduce((acc, req) => acc + requirementWeight(req), 0) || 1;
  const totalBefore = sum(before);
  const totalAfter = sum(after);
  const held = String(hold || "").trim().replace(/\s+/g, " ").toLowerCase();
  let coveredBefore = 0;
  let coveredAfter = 0;
  let criticalFixed = 0;
  let criticalWorsened = 0;
  for (const label of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(label) || null;
    const a = after.get(label) || null;
    const br = b ? Number(ratioOf(b)) || 0 : 0;
    const ar = a ? Number(ratioOf(a)) || 0 : 0;
    const withhold = Boolean(held) && label === held && ar > br;
    if (b) coveredBefore += br * requirementWeight(b);
    if (a) coveredAfter += (withhold ? br : ar) * requirementWeight(a);
    if (withhold) continue;
    const subject = a || b || {};
    if (ar > br + 0.001) {
      if (subject.critical && !b?.met && a?.met) criticalFixed += 1;
    } else if (ar + 0.001 < br) {
      if (subject.critical) criticalWorsened += 1;
    }
  }
  const delta = coveredAfter / totalAfter - coveredBefore / totalBefore;
  const raw = delta * COVERAGE_WEIGHT + criticalFixed * COVERAGE_CRITICAL_FIXED - criticalWorsened * COVERAGE_CRITICAL_WORSENED;
  return Math.max(-COVERAGE_SPAN, Math.min(COVERAGE_SPAN, raw));
}

/**
 * suggestion_scoring_v511.archetype_move_double_payment: what the coverage layer paid for the
 * move the speed-plan term already paid for, as the correction to apply (≤ 0). Zero when the
 * archetype has no move-shaped requirement, or the candidate did not improve it.
 */
export function archetypeMoveDoublePayment(beforeRequirements, afterRequirements, ratioOf, archetype, rule) {
  // Version 2 left that payment in place, and a recording stamped 2 replays as version 2.
  if ((Math.trunc(Number(rule) || 0) || SUGGESTION_SCORING) < COVERAGE_CORRECTION_FROM_RULE) return 0;
  const label = speedPlanRequirement(archetype);
  if (!label) return 0;
  const plain = coverageAdjustment(beforeRequirements, afterRequirements, ratioOf);
  const held = coverageAdjustment(beforeRequirements, afterRequirements, ratioOf, label);
  return Math.min(0, held - plain);
}

/**
 * suggestion_scoring_v511.directed_speed_fit: `speedFit` with the team's speed plan pointing
 * it. The original rewards raw Speed on a team whose whole plan is to be slow, and pays Trick
 * Room a second time for being "speed control".
 */
export function directedSpeedFit(profile, archetype, trickRoomSetters) {
  const speed = Number(profile?.speed) || 0;
  const room = String(archetype || "").trim().toLowerCase() === "trick room";
  let score = room ? 35 + Math.min(30, Math.max(0, SLOW_PLAN_PIVOT - speed) / 4) : 35 + Math.min(30, speed / 5);
  if (profile?.speed_control) {
    const onlyTrickRoom = onlySpeedControlIsTrickRoom(profile);
    score += room && onlyTrickRoom && Math.trunc(Number(trickRoomSetters) || 0) >= 2 ? SPEED_CONTROL_CREDIT_ALREADY_PAID : SPEED_CONTROL_CREDIT;
  }
  if (profile?.priority) score += PRIORITY_CREDIT;
  return clamp(score);
}

function onlySpeedControlIsTrickRoom(profile) {
  const keys = new Set((profile?.moves || []).map(compact).filter(Boolean));
  if (!keys.has("trickroom")) return false;
  return ![...keys].some((key) => FAST_SPEED_CONTROL.has(key));
}

/** Hits to remove, read off a Team Evaluation label ("OHKO", "3HKO"). */
export function hitsFromLabel(label) {
  const text = String(label ?? "");
  if (/\bOHKO\b/i.test(text)) return 1;
  const found = /\b(\d+)\s*HKO\b/i.exec(text);
  if (found) return Math.max(1, Number.parseInt(found[1], 10) || 99);
  return 99;
}

/** One of beats / walls / chips / trades / loses: the app's real-answer rule (V494), graded. */
export function verdictFor(outHits, inHits, oursFirst, theirsFirst) {
  const out = Math.trunc(Number(outHits) || 99);
  const inn = Math.trunc(Number(inHits) || 99);
  if (theirsFirst && inn === 1) return "loses";
  const wins = out < inn;
  const matchesAndFaster = out === inn && Boolean(oursFirst);
  if (out <= THREATEN_MAX_HITS && (wins || matchesAndFaster)) return "beats";
  if (inn >= WALL_MIN_INCOMING && wins) return "walls";
  if (inn < out) return "loses";
  if (out === inn) return "trades";
  return "chips";
}

/** The verdict in words, before any calc line. */
export function verdictSentence(name, verdict, outHits, inHits, oursFirst, theirsFirst) {
  const hits = (count) => {
    const n = Math.trunc(Number(count) || 99);
    if (n >= 99) return "no reliable KO";
    return n === 1 ? "one hit" : `${n} hits`;
  };
  // Move order is only worth a clause where it decides the exchange: when both need the same
  // number of hits, or when the threat can remove this Pokémon inside the turns it needs.
  const close = (Math.trunc(Number(inHits) || 99)) <= (Math.trunc(Number(outHits) || 99));
  const order = close && oursFirst ? " and moves first" : close && theirsFirst ? " but moves second" : "";
  if (verdict === "beats") return `Beats ${name}: removes it in ${hits(outHits)}${order}, and takes ${hits(inHits)} to be removed.`;
  if (verdict === "walls") return `Walls ${name}: it needs ${hits(inHits)} to remove this, which removes it in ${hits(outHits)}.`;
  if (verdict === "trades") return `Even with ${name}: both need ${hits(outHits)}${order || ", so it comes down to the speed tie"}.`;
  if (verdict === "loses") {
    if (theirsFirst && Math.trunc(Number(inHits) || 99) === 1) return `Loses to ${name}: it moves first and removes this in one hit.`;
    return `Loses to ${name}: it needs ${hits(inHits)} to remove this, which needs ${hits(outHits)}.`;
  }
  return `Chips ${name}: needs ${hits(outHits)} while taking ${hits(inHits)}.`;
}

/**
 * Which of these threats nothing on the team currently beats or walls, read off the Team
 * Evaluation's own per-member breakdown (it already carries both damage labels for every
 * team member against every threat).
 * @returns {Map<string, boolean>} threat name -> nothing on the team answers it
 */
export function teamGapThreats(threats) {
  const gaps = new Map();
  for (const threat of threats || []) {
    const name = String(threat?.name || threat?.base_name || "");
    let answered = false;
    for (const row of threat?.breakdown || []) {
      if (!row || typeof row !== "object") continue;
      const out = hitsFromLabel(row.outgoing_label);
      const inn = hitsFromLabel(row.incoming_label);
      if ((out <= THREATEN_MAX_HITS && out < inn) || (inn >= WALL_MIN_INCOMING && out < inn)) {
        answered = true;
        break;
      }
    }
    gaps.set(name, !answered);
  }
  return gaps;
}

/** A threat's own score, or NaN where it has none (the weights fall back to 40, as the app's does). */
function threatScore(threat) {
  const raw = threat?.score;
  return raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
}

/** One plain sentence at the top of the breakdown. */
export function verdictLine(row) {
  const measured = Math.trunc(Number(row?.threats_measured_v511) || 0);
  if (!measured) return "";
  const beaten = (row?.threat_answers_v511 || []).filter((e) => e.verdict === "beats" || e.verdict === "walls").length;
  const parts = [`Answers ${beaten} of the team's ${measured} worst threats`];
  const gaps = Math.trunc(Number(row?.gaps_filled_v511) || 0);
  if (gaps) parts.push(`${gaps} of those nothing on the team answers today`);
  const removed = Math.trunc(Number(row?.removed_first_v511) || 0);
  if (removed) parts.push(`${removed} of them ${removed === 1 ? "removes" : "remove"} it first`);
  return `${parts.join("; ")}.`;
}

/** team_evaluation_v466.check_resolution_metrics: only Speed Control counts as a role fix. */
function checkResolution(beforeRows, afterRows) {
  const rank = (row) => {
    if (!row) return 0;
    const v = String(row.severity || row.status || "good").trim().toLowerCase();
    if (["red", "problem", "critical"].includes(v)) return 2;
    if (["yellow", "orange", "needs attention", "warning"].includes(v)) return 1;
    return 0;
  };
  const index = (rows) => Object.fromEntries((rows || []).map((row) => [compact(row.check_id || row.kind || row.check_label || row.text), row]).filter(([k]) => k));
  const before = index(beforeRows);
  const after = index(afterRows);
  let fixes = 0;
  let worsened = 0;
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = rank(before[k]);
    const a = rank(after[k]);
    if (a < b && (k === "speedcontrol" || k === "utility")) fixes += 1;
    else if (a > b && (k === "speedcontrol" || k === "utility")) worsened += 1;
  }
  return { fixes, worsened };
}

/** archetype_payoff.payoff */
function payoff(condition, before, after) {
  const counts = (f) => {
    if (WEATHERS.includes(condition)) return [Number(f.weather_setters?.[condition]) || 0, Number(f.weather_beneficiaries?.[condition]) || 0];
    if (condition === "terrain") return [Number(f.terrain_setters) || 0, Number(f.terrain_beneficiaries) || 0];
    if (condition === "tailwind") return [Number(f.tailwind_setters) || 0, Number(f.tailwind_beneficiaries) || 0];
    if (condition === "trick room") return [Number(f.trick_room_setters) || 0, Number(f.slow_attackers) || 0];
    return [0, 0];
  };
  const rivals = (f) => {
    if (WEATHERS.includes(condition)) return WEATHERS.filter((w) => w !== condition && (Number(f.weather_setters?.[w]) || 0) > 0).length;
    if (condition === "terrain") return Math.max(0, (Number(f.terrain_types) || 0) - 1);
    return 0;
  };
  const label = condition === "tailwind" ? "Tailwind" : condition === "trick room" ? "Trick Room" : condition;
  const [sb, bb] = counts(before);
  const [sa, ba] = counts(after);
  let adjustment = 0;
  let reason = "";
  let conflict = false;
  if (sa > sb) {
    if (sb <= 0) {
      adjustment += 26;
      reason = `Turns on the team's ${label}, which nothing else on the team does.`;
    } else if (sb === 1) {
      adjustment += 3;
      reason = `The team already sets ${label}; a second setter is only insurance.`;
    } else {
      adjustment -= 12;
      reason = `A third ${label} setter is a slot the plan does not need.`;
    }
  }
  const added = Math.max(0, ba - bb);
  if (added) {
    adjustment += Math.min(18, 9 * added);
    if (!reason) reason = `Gets more out of the team's ${label} than the slot does now.`;
  }
  const newRivals = Math.max(0, rivals(after) - rivals(before));
  if (newRivals) {
    conflict = true;
    adjustment += -30 * newRivals;
    reason = `Sets a condition that replaces the team's own ${label} on every switch-in.`;
  }
  return { adjustment, conflict, reason, condition, setters_before: sb, setters_after: sa, beneficiaries_before: bb, beneficiaries_after: ba };
}

/** speed_mode_v505.plan: the speed mode a team is built for. */
export function speedModePlan(profiles, metaSpeeds) {
  const speeds = metaSpeeds.map(([, s]) => Number(s)).filter((s) => s > 0).sort((a, b) => a - b);
  const mid = Math.floor(speeds.length / 2);
  const threshold = speeds.length ? (speeds.length % 2 ? speeds[mid] : (speeds[mid - 1] + speeds[mid]) / 2) : 130;
  const setters = [];
  const winders = [];
  const slow = [];
  const fast = [];
  let attackers = 0;
  for (const p of profiles) {
    const moves = new Set([...(p.move_keys || [])].map(compact));
    if (moves.has("trickroom")) setters.push(p.name);
    if (moves.has("tailwind")) winders.push(p.name);
    if (!(p.has_damage || p.damage_pressure)) continue;
    attackers += 1;
    const speed = Number(p.effective_speed ?? p.speed ?? 0) || 0;
    if (speed <= 0) continue;
    if (speed < threshold * 0.8 && (Number(p.physical) || 0) + (Number(p.special) || 0) >= 2) slow.push(p.name);
    else if (speed >= threshold) fast.push(p.name);
  }
  const roomSupported = slow.length >= 2 && slow.length >= attackers / 2;
  const windSupported = fast.length >= 2;
  let mode;
  if (!setters.length && !winders.length) mode = "none";
  else if (setters.length && !winders.length) mode = roomSupported ? "trickroom" : "none";
  else if (winders.length && !setters.length) mode = "tailwind";
  else if (roomSupported && !windSupported) mode = "trickroom";
  else if (windSupported && !roomSupported) mode = "tailwind";
  else if (roomSupported && windSupported) mode = slow.length > fast.length ? "trickroom" : "tailwind";
  else mode = "tailwind";
  return { threshold, trick_room: setters, tailwind: winders, slow_attackers: slow, fast_attackers: fast, attackers, room_supported: roomSupported, wind_supported: windSupported, mode };
}

/**
 * "Only Box" candidates (_v321_box_suggestion_candidates + V494), shared by Suggestions
 * and Auto Build: each Box entry not on the team with its saved set forced; an entry
 * saved without moves gets its usage set instead, because Only Box limits the species,
 * not the moveset. `position` is the Box order, as in the app.
 * @param {TeamSuggestions} sg
 */
export function boxCandidates(sg, box, activeNames) {
  const active = new Set(activeNames.map(compact).filter(Boolean));
  const rows = [];
  (box || []).forEach((set, index) => {
    const pokemon = String(set?.species || "").trim();
    if (!pokemon) return;
    const form = String(set.form || pokemon).trim() || pokemon;
    if (active.has(compact(form)) || active.has(compact(pokemon))) return;
    const moves = (set.moves || []).map((m) => String(m || "").trim()).filter(Boolean).slice(0, 4);
    const forced = {
      rank: 1, evaluated_count: 1, total_sets: 1, item: String(set.item || ""), ability: String(set.ability || ""), moves,
      spread: { name: set.nature || "Serious", nature_name: set.nature || "Serious", bonuses: [...(set.bonuses || [0, 0, 0, 0, 0, 0])] },
    };
    const row = {
      name: form, base_name: pokemon, form, position: index + 1, top_item: forced.item, top_items: forced.item ? [forced.item] : [],
      moves: [...moves], _candidate_set_v113: forced, candidate_source: "Pokemon Box",
    };
    if (!moves.length) {
      delete row._candidate_set_v113;
      const common = sg.common(form);
      if ((common.moves || []).length) row.moves = common.moves.slice(0, 4);
      if (common.item && !row.top_item) Object.assign(row, { top_item: common.item, top_items: [common.item] });
      row._v494_box_set_completed = true;
    }
    rows.push(row);
  });
  return rows;
}

/**
 * A suggestion row as the page gets it: what the list and its breakdown show, and no
 * engine objects. `selected` is the enabled Team Building Checks (a Set of ids).
 * @param {TeamSuggestions} sg
 */
export function suggestionForPage(sg, row, selected = null) {
  const species = row.candidate_entry?.pokemon || row.name;
  const enabled = (id) => id && id !== "checks_disabled" && id !== "archetype_fit" && (!selected || !selected.size || selected.has(id));
  const index = (rows) => new Map((rows || []).map((r) => [rowKey(r), r]));
  const before = index(row._before_check_rows);
  const after = index(row._after_check_rows);
  // Only the checks whose status the suggestion changes.
  const checks = [];
  for (const [id, now] of after) {
    if (!enabled(id)) continue;
    const old = before.get(id);
    if (severityOf(old) === severityOf(now)) continue;
    checks.push({ id, label: String(now.check_label || old?.check_label || id), before: severityOf(old), after: severityOf(now), summary: String(now.summary || now.summary_v203 || "") });
  }
  const requirements = (rows) => new Map((sg.archetypeRow(rows)?.archetype_requirements_v403 || []).map((req) => [String(req.label || ""), req]));
  const reqBefore = requirements(row._before_check_rows);
  const reqAfter = requirements(row._after_check_rows);
  const requirement = (req, old) => ({ label: String(req.label || ""), display: String(req.display || ""), before: String(old?.display || ""), critical: Boolean(req.critical) });
  const gained = [...reqAfter.values()].filter((req) => req.met && !reqBefore.get(req.label)?.met).map((req) => requirement(req, reqBefore.get(req.label)));
  const lost = [...reqAfter.values()].filter((req) => !req.met && reqBefore.get(req.label)?.met).map((req) => requirement(req, reqBefore.get(req.label)));
  const inBox = row._candidate_meta_v378?.candidate_source === "Pokemon Box";
  return {
    key: String(row.action || row.name), name: row.name, action: row.action, action_kind: row.action_kind, slot_index: row.slot_index, swap_target: row.swap_target,
    score: row.score, score_uncapped: row.score_uncapped ?? row.score, ledger: row.score_ledger || [],
    position: row.position, meta_rank: sg.metaPosition(row.form || row.name) || (inBox ? 0 : row.position), source: inBox ? "box" : "meta",
    item: row.item, ability: row.ability, moves: row.moves, spread_label: row.spread_label,
    answers: row.answers, details: row.details, severities: row._v104_detail_severities, candidate_entry: row.candidate_entry,
    spread: row.candidate_spread, form: row.form || row.candidate_entry?.form, components: row.suggestion_score_components_v318,
    found_in_team: row.found_in_team_v496 || "",
    set_source: row.found_in_team_v496 ? `Tournament team ${row.found_in_team_v496}` : inBox && row._candidate_meta_v378?._candidate_set_v113 ? "Your Box" : "Most common set",
    archetype: row.strategy_archetype_v466, fixed: row._fixed_requirements, worsened: row._worsened_requirements,
    checks, archetype_changes: { archetype: String(sg.archetypeRow(row._after_check_rows)?.archetype || ""), gained, lost },
    payoff: row.archetype_payoff_v496 || null, conditional: row.conditional_dependence_v499 || null,
    role_fixes: row.role_fixes_v466 || 0, speed_conflict: Boolean(row.counter_archetype_speed_control_v466),
    answer_calcs: row.answer_calcs_v494 || [],
    // V511: what the real calcs said about this candidate against the team's worst threats.
    verdict_line: row.verdict_line_v511 || "",
    threats_measured: row.threats_measured_v511 || 0,
    threat_verdicts: row.threat_verdicts_v511 || [],
    threat_answers: row.threat_answers_v511 || [],
    type_matchup_only: row.type_matchup_only_v511 || [],
    gaps_filled: row.gaps_filled_v511 || 0,
    removed_first: row.removed_first_v511 || 0,
    // _v480_item_options: what "Use" may swap a clashing item for (V482 applies Item Clause on apply).
    item_options: [...new Set([row.candidate_entry?.item, sg.common(species).item, ...sg.usage(species, "held_item", 30)].filter(Boolean))],
  };
}

export class TeamSuggestions {
  /**
   * @param {TeamEvaluation} evaluation  (its evaluator carries the settings and meta)
   * @param {{guaranteedMoveShare?: number|null, pairedSpreads?: boolean|null,
   *          suggestionScoring?: number|null}} options
   *   `guaranteedMoveShare`: the usage share (percent) from which a move is on every set
   *   this engine puts forward; null or 0 switches it off.
   *   `pairedSpreads`: a candidate's Nature gets Stat Points it does not contradict
   *   (builder/nature-spreads.js); left out, the evaluator's own setting decides.
   *   `suggestionScoring`: the V511 scoring version (the damped archetype reward and the
   *   calc-backed ranking terms); null (a recording made before the rule) switches it off.
   */
  constructor(evaluation, { guaranteedMoveShare = GUARANTEED_MOVE_SHARE, pairedSpreads, suggestionScoring } = {}) {
    this.guaranteedShare = shareOption(guaranteedMoveShare);
    this.suggestionScoring = suggestionScoringOption(suggestionScoring);
    this.evaluation = evaluation;
    this.ev = evaluation.ev;
    this.pairedSpreads = pairedSpreads === undefined ? (this.ev.pairedSpreads ?? PAIRED_SPREADS) : pairedOption(pairedSpreads);
    this.checks = evaluation.checks;
    this.synergy = evaluation.synergy;
    this.lossCache = new Map();
    /** @type {import("./known-teams.js").KnownTeams|null} the tournament-team library, when loaded */
    this.known = evaluation.knownTeams || null;
    const t = this.ev.engine.data?.analysisTables || {};
    this.weatherSetters = Object.entries(t._SIMPLE_WEATHER_SETTERS_V187 || {}).map(([c, keys]) => [c, new Set(keys)]);
    this.terrainSetters = Object.entries(t._SIMPLE_TERRAIN_SETTERS_V187 || {}).map(([c, keys]) => [c, new Set(keys)]);
  }

  name(value) {
    return this.checks.showdownName(value);
  }

  /** species_identity.base_species_id ("Arcanine-Hisui" -> arcanine, "Mega Salamence" -> salamence). */
  speciesId(value) {
    const k = compact(value);
    return (this.ev.engine.data?.baseSpeciesIds || {})[k] || k;
  }

  /** The battle-data name a (possibly Mega-named) Pokemon's usage is filed under. */
  usageName(name) {
    const text = String(name || "").trim();
    return this.ev.record(text) ? text : this.ev.baseSpeciesFromDisplay(text);
  }

  common(name) {
    return this.ev.commonSet(this.usageName(name));
  }

  // --- the team as the app holds it ----------------------------------------------

  /** Payload slots as app entries (the Mega form and its Ability, as the app saves them). */
  teamEntries(payload) {
    return (payload.slots || []).map(({ entry, mon }) => ({ ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }));
  }

  /** A {entry, mon} slot for an app entry; `spread` is the slot's saved one, else the common set's. */
  slotFor(entry, index, spread = null) {
    const common = this.common(entry.pokemon);
    const set = {
      species: entry.pokemon, form: entry.form || entry.pokemon, item: entry.item || common.item || "",
      ability: entry.ability || common.ability || "", moves: (entry.moves || []).length ? entry.moves : common.moves || [],
      nature: spread?.nature || common.nature_name || "Serious", bonuses: spread?.bonuses || common.bonuses || [0, 0, 0, 0, 0, 0],
    };
    return { entry: { ...entry, moves: (entry.moves || []).slice(0, 4) }, mon: this.ev.teamMon(set, index), set };
  }

  /** _v494_field_support_available: every weather/terrain the team (plus extra Abilities) turns on. */
  fieldSupport(teamEntries, extra = []) {
    const keys = new Set(extra.map(compact).filter(Boolean));
    for (const entry of teamEntries) {
      if (String(entry.ability || "").trim()) keys.add(compact(entry.ability));
      for (const move of entry.moves || []) if (String(move || "").trim()) keys.add(compact(move));
    }
    const have = new Set();
    for (const [source, umbrella] of [[this.weatherSetters, "weather"], [this.terrainSetters, "terrain"]]) {
      for (const [condition, setters] of source) {
        if ([...keys].some((k) => setters.has(k))) {
          have.add(condition);
          have.add(umbrella);
        }
      }
    }
    return have;
  }

  usage(name, category, limit) {
    return this.ev.usagePairs(this.usageName(name), category, limit).map(([n]) => n);
  }

  // --- guaranteed moves (builder/guaranteed-moves.js) --------------------------------

  /** The weather / terrain a move needs to be offered ("" when it needs none). */
  moveCondition(move) {
    return MOVES_NEEDING_SUPPORT[compact(move)] || "";
  }

  /** The moves a set ({ability, item}) of this Pokémon must carry on this team: [{move, share}]. */
  lockedMoves(name, set, teamEntries) {
    return lockedMoves(this, name, set || {}, teamEntries || []);
  }

  /**
   * The set with its guaranteed moves in (the same object when nothing was missing).
   * `protect` names moves that may not make room (the archetype's anchor move); `notes`
   * collects the plain-English lines for a log.
   */
  guaranteeSet(name, set, teamEntries, protect = [], notes = null) {
    if (!(this.guaranteedShare > 0) || !set) return set;
    const locked = this.lockedMoves(name, set, teamEntries);
    if (!locked.length) return set;
    const { moves, changes } = enforce(set.moves || [], locked, { shares: moveShares(this, name), protect });
    if (!changes.length) return set;
    if (notes) notes.push(...describeChanges(String(name || ""), changes));
    return { ...set, moves };
  }

  // --- candidates -----------------------------------------------------------------

  /** The all-meta entries (_v197 include_all): top three items, top six moves, "...ite" Megas named. */
  allMeta() {
    if (this._allMeta) return this._allMeta;
    this._allMeta = (this.ev.metaRecords || []).map((record) => {
      const name = String(record.name);
      const topItems = (record.items || []).map(([item]) => item).filter(Boolean).slice(0, 3);
      const entry = {
        name, pokemon: name, pokemon_name: name, base_name: name,
        position: Number(record.position) || 999999, column_position: Number(record.position) || 999999,
        top_item: topItems[0] || "", top_items: topItems,
        moves: (record.moves || []).map(([move]) => move).filter(Boolean).slice(0, 6),
      };
      const item = entry.top_item;
      if (item && compact(item).endsWith("ite") && this.ev.isMegaItemForSpecies(name, item)) {
        const form = this.ev.megaFormForItem(name, item);
        if (form && compact(form) !== compact(name)) entry.name = form;
      }
      return entry;
    });
    return this._allMeta;
  }

  /** suggestionForPage for this engine. */
  forPage(row, selected = null) {
    return suggestionForPage(this, row, selected);
  }

  /** The meta rank of a Pokemon (its own name, or the species a Mega is filed under); 0 when unranked. */
  metaPosition(name) {
    if (!this._metaRank) {
      this._metaRank = new Map();
      this.allMeta().forEach((meta, index) => {
        const rank = Number(meta.position) || index + 1;
        for (const value of [meta.name, meta.base_name]) if (!this._metaRank.has(compact(value))) this._metaRank.set(compact(value), rank);
      });
    }
    const k = compact(name);
    return this._metaRank.get(k) || this._metaRank.get(compact(this.ev.baseSpeciesFromDisplay(String(name || "")))) || 0;
  }

  /** _v476_full_suggestion_candidates: every ranked Pokemon not already on the team. */
  candidates(payload, activeNames) {
    const teamKeys = new Set(activeNames.map(compact).filter(Boolean));
    const excluded = this.ev.excludedPokemonKeys();
    const nameKeys = (value) => {
      const text = String(value || "").trim();
      if (!text) return [];
      const variants = new Set([text, text.replace(/-/g, " "), text.replace(/_/g, " ")]);
      if (/^mega[ -]/i.test(text)) variants.add(text.slice(5).trim());
      return [...variants].map(compact).filter(Boolean);
    };
    const seen = new Set();
    const rows = [];
    this.allMeta().forEach((meta, index) => {
      const name = String(meta.name || meta.base_name || "").trim();
      const k = compact(name);
      if (!k || teamKeys.has(k) || excluded.has(k) || seen.has(k)) return;
      if (excluded.size && ["name", "pokemon", "pokemon_name", "base_name", "form", "form_name"].some((f) => nameKeys(meta[f]).some((v) => excluded.has(v)))) return;
      seen.add(k);
      rows.push({ ...meta, name, position: Number(meta.position) || index + 1, candidate_source: "All available Pokemon" });
    });
    return rows.sort((a, b) => a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** _v494_mega_form_for_stone: the catalogue's form for a stone. */
  megaFormForStone(item) {
    const holders = this.ev.engine.megaStones.get(compact(item)) || [];
    return holders[0]?.form || "";
  }

  // --- the candidate set -----------------------------------------------------------

  /** _v123_common_candidate_set over _v113_candidate_sets(limit=1) with the V494 and field guards. */
  commonCandidateSet(meta, teamEntries) {
    const name = String(meta.name || "").trim();
    const common = this.common(name);
    const items = uniqueNames([common.item, meta.top_item, ...(meta.top_items || []), ...this.usage(name, "held_item", 3)], 3);
    const abilities = uniqueNames([common.ability, ...this.usage(name, "ability", 3)], 3);
    // V494: moves whose condition this team (or the species' own Abilities) cannot set.
    const have = this.fieldSupport(teamEntries, [common.ability, ...(meta.top_abilities || []).slice(0, 4)]);
    const blocked = new Set(Object.entries(MOVES_NEEDING_SUPPORT).filter(([, need]) => !have.has(need)).map(([m]) => m));
    const allowed = (list) => (list || []).filter((m) => !blocked.has(compact(m)));
    const baseMoves = uniqueNames([...allowed(common.moves), ...allowed(meta.moves), ...this.usage(name, "move", 8)], 10);
    let moves = uniqueNames(baseMoves.slice(0, 4), 4);
    if (moves.length < 4) moves = uniqueNames([...moves, ...baseMoves], 4);
    if (blocked.size) moves = allowed(moves);
    const spread = { name: common.nature_name || "Serious", nature_name: common.nature_name || "Serious", bonuses: [...(common.bonuses || [0, 0, 0, 0, 0, 0])], rank: 1 };
    let set = { rank: 1, item: items[0] || "", ability: abilities[0] || "", moves: moves.slice(0, 4), spread, total_sets: 1 };
    set = this.repairSetMoves(name, set, teamEntries);
    set = this.repairSetFields(name, set, teamEntries);
    // Guaranteed moves: judged with the Ability the set plays with (a Mega's for its stone).
    set = this.guaranteeSet(name, set, teamEntries);
    return { ...set, rank: 1, evaluated_count: 1, total_sets: 1, _common_gate_v123: true };
  }

  /** _v494_repair_set_moves: once the set has an Ability, drop moves it still cannot power. */
  repairSetMoves(name, set, teamEntries) {
    const have = this.fieldSupport(teamEntries, set.ability ? [set.ability] : []);
    const blocked = new Set(Object.entries(MOVES_NEEDING_SUPPORT).filter(([, need]) => !have.has(need)).map(([m]) => m));
    if (!blocked.size || !(set.moves || []).length) return set;
    const kept = set.moves.filter((m) => !blocked.has(compact(m)));
    if (kept.length === set.moves.length) return set;
    for (const move of this.usage(name, "move", 12).filter((m) => !blocked.has(compact(m)))) {
      if (kept.length >= set.moves.length) break;
      if (!kept.some((x) => compact(x) === compact(move))) kept.push(move);
    }
    return { ...set, moves: kept };
  }

  /** field_synergy.repair_set_fields: an item or Ability the team cannot switch on is replaced. */
  repairSetFields(name, set, teamEntries, itemMap = null) {
    const item = String(set.item || "");
    const ability = String(set.ability || "");
    if (!item && !ability) return set;
    const teamHave = this.fieldSupport(teamEntries);
    const have = this.fieldSupport(teamEntries, ability ? [ability] : []);
    const types = this.ev.engine.pokemon(this.usageName(name), set.form || this.usageName(name))?.types || [];
    const grounded = (a, i) => !types.some((t) => compact(t) === "flying") && compact(a) !== "levitate" && compact(i) !== "airballoon";
    const blockedItems = (available, isGrounded) => {
      const out = new Set(Object.entries(ITEM_SUPPORT).filter(([, need]) => !available.has(need)).map(([k]) => k));
      if (!isGrounded) for (const [k, need] of Object.entries(ITEM_SUPPORT)) if (TERRAIN_CONDITIONS.includes(need) || need === "terrain") out.add(k);
      return out;
    };
    const out = { ...set };
    // The guard decides stand-ins against the team alone; the repair then judges with the set's Ability.
    const guardBlocked = blockedItems(teamHave, grounded(ability, item));
    const blocked = blockedItems(have, grounded(ability, item));
    if (item && blocked.has(compact(item))) {
      let replacement = "";
      if (itemMap && itemMap.has(compact(item))) {
        replacement = itemMap.get(compact(item));
      } else if (guardBlocked.has(compact(item))) {
        const all = blockedItems(teamHave, true);
        replacement = this.usage(name, "held_item", 12).find((o) => !all.has(compact(o))) || "";
      } else {
        replacement = this.usage(name, "held_item", 12).find((o) => !blocked.has(compact(o))) || "";
      }
      out.item = replacement;
    }
    const blockedAbilities = new Set(Object.entries(ABILITY_SUPPORT).filter(([, need]) => !have.has(need)).map(([k]) => k));
    if (ability && blockedAbilities.has(compact(ability))) {
      const option = this.usage(name, "ability", 4).find((o) => !blockedAbilities.has(compact(o)));
      if (option) out.ability = option;
    }
    return out;
  }

  /** _v378_candidate_entry + V494 mega identity */
  candidateEntry(meta, set) {
    // normalize_team_entry spells the species as the game data does: "Farfetch’d"
    // from the usage files becomes "Farfetch'd" (the row keeps the usage name).
    const plain = (value) => String(value ?? "").replace(/[‘’]/g, "'").trim();
    const name = plain(meta.name || meta.form || meta.pokemon || "Pokemon");
    const base = plain(meta.base_name || meta.pokemon || meta.pokemon_name || name) || name;
    let form = plain(meta.form || name || base) || base;
    const item = String(set.item || meta.top_item || "").trim();
    let ability = String(set.ability || meta.ability || "").trim();
    const moves = (set.moves?.length ? set.moves : meta.moves || []).slice(0, 4).map((m) => String(m).trim()).filter(Boolean);
    const [megaForm, megaAbility] = this.megaIdentity(base, item, ability);
    if (megaForm) {
      form = megaForm;
      if (megaAbility) ability = megaAbility;
    }
    return { pokemon: base, item, form, ability, moves };
  }

  /** _v494_mega_identity: (Mega form, its Ability) for a stone holder. */
  megaIdentity(species, item, ability) {
    if (!species || !item || !this.ev.engine.isMegaStone(item) || !this.ev.isMegaItemForSpecies(species, item)) return ["", ""];
    const form = this.megaFormForStone(item);
    if (!form) return ["", ""];
    return [form, this.ev.megaAbility(species, form, ability) || ""];
  }

  // --- the base score (V378) --------------------------------------------------------

  checkQuality(snapshot) {
    const rows = snapshot?.rows || [];
    if (!rows.length) return 50;
    const points = rows.reduce((s, row) => s + (severityOf(row) === "good" ? 1 : severityOf(row) === "yellow" ? 0.5 : 0), 0);
    return (100 * points) / rows.length;
  }

  badChecks(snapshot) {
    const out = new Map();
    for (const row of snapshot?.rows || []) {
      const sev = severityOf(row);
      if (sev === "good") continue;
      const k = String(row.check_id || row.kind || row.check_label || row.label || "").trim();
      if (k) out.set(k, [String(row.check_label || pyTitle(k.replace(/_/g, " "))).trim(), sev]);
    }
    return out;
  }

  /**
   * _v378_type_fit (+ V494: an answer that loses the real matchup is taken back).
   * `calcs`, when given, receives each listed answer's matchup: {threat, kept, incoming, outgoing}.
   */
  typeFit(payload, profile, calcs = null) {
    const moveTypes = [...(profile.damaging_types || [])].map(pyTitle);
    const ownTypes = (profile.types || []).map(pyTitle);
    const threats = [...(payload.threats || [])].map((t, i) => [t, i]).sort((a, b) => -(Number(a[0].score) || 0) - -(Number(b[0].score) || 0) || a[1] - b[1]).map(([t]) => t);
    let wOff = 0;
    let wDef = 0;
    let total = 0;
    const answers = [];
    for (const threat of threats.slice(0, 16)) {
      const threatTypes = this.synergy.metaTypes(threat);
      if (!threatTypes.length) continue;
      const bestAttack = Math.max(...(moveTypes.length ? moveTypes.map((t) => this.ev.engine.typeMultiplier(t, threatTypes)) : [1]));
      const worstIncoming = Math.max(...threatTypes.map((t) => this.ev.engine.typeMultiplier(t, ownTypes)));
      const offense = bestAttack >= 4 ? 100 : bestAttack > 1 ? 82 : bestAttack === 1 ? 42 : 10;
      const defense = worstIncoming === 0 ? 100 : worstIncoming <= 0.5 ? 88 : worstIncoming <= 1 ? 50 : worstIncoming <= 2 ? 18 : 4;
      const weight = 1 + Math.max(0, (Number(threat.score ?? 40) || 0) - 40) / 30;
      wOff += offense * weight;
      wDef += defense * weight;
      total += weight;
      if (bestAttack > 1 || (bestAttack >= 1 && worstIncoming <= 0.5)) {
        const label = String(threat.name || threat.base_name || "Threat");
        if (!answers.includes(label)) answers.push(label);
      }
    }
    if (total <= 0) return [50, 50, []];
    let offense = wOff / total;
    const listed = answers.slice(0, 5);
    const byName = new Map((payload.threats || []).map((t) => [String(t.name || t.base_name || ""), t]));
    const kept = [];
    let struck = 0;
    for (const n of listed) {
      const threat = byName.get(n);
      const matchup = threat ? this.threatMatchup(profile, threat) : null;
      if (calcs) calcs.push({ threat: n, kept: !matchup?.loses, incoming: matchup?.incoming || null, outgoing: matchup?.outgoing || null });
      if (threat && matchup.loses) {
        struck += 1;
        continue;
      }
      kept.push(n);
    }
    if (struck) offense = Math.max(0, offense - struck * 8);
    return [offense, wDef / total, kept];
  }

  /** _v494_profile_loses_to_threat: the matchup itself, speed order included. */
  losesToThreat(profile, threat) {
    return this.threatMatchup(profile, threat).loses;
  }

  /** The matchup behind losesToThreat, with its two calcs kept (compact copies, shared through the cache). */
  threatMatchup(profile, threat) {
    const none = { loses: false, incoming: null, outgoing: null };
    const species = String(profile.pokemon || profile.name || "").trim();
    const threatName = String(threat.name || threat.base_name || "").trim();
    if (!species || !threatName) return none;
    // Everything the verdict depends on (the app's V509 key): the set, the threat's data and the evaluator mode.
    const cacheKey = [compact(species), compact(profile.form || ""), compact(profile.item || ""), (profile.moves || []).map(compact).join(","), compact(threatName),
      (threat._v124_strict_top_items || threat.top_items || []).map(compact).join(","), (threat.top_moves || []).map(compact).join(","), this.ev.perMoveAttacks ? 1 : 0].join("|");
    if (this.lossCache.has(cacheKey)) return this.lossCache.get(cacheKey);
    let result = none;
    try {
      const threatVariants = this.threatVariantsForSuggestion(threat);
      const candidateVariants = this.candidateVariants(species, profile.item, profile.moves);
      if (threatVariants.length && candidateVariants.length) {
        const rawIn = this.ev.bestBetween(threatVariants, candidateVariants);
        const rawOut = this.ev.bestBetween(candidateVariants, threatVariants);
        const [incoming, outgoing] = this.ev.applySpeedOrder(rawIn, rawOut);
        result = { loses: !this.isRealAnswer(incoming, outgoing), incoming: compactResult(incoming), outgoing: compactResult(outgoing) };
      }
    } catch {
      result = none;
    }
    this.lossCache.set(cacheKey, result);
    return result;
  }

  /** _v52_threat_variants_for_suggestion */
  threatVariantsForSuggestion(threat) {
    const itemLimit = this.ev.settings.calc_item_limit;
    const moveLimit = this.ev.settings.calc_move_limit;
    const name = String(threat.base_name || threat.name || "").trim();
    if (!name) return [];
    const base = this.ev.commonMon(name, name);
    let items = uniqueNames(threat._v124_strict_top_items || [], itemLimit);
    if (!items.length) items = uniqueNames(threat.top_items || [], itemLimit);
    if (!items.length && base.item) items = [base.item];
    if (!this.ev.settings.use_held_items) items = items.slice(0, 1);
    let moves = uniqueNames(threat.top_moves || [], moveLimit);
    if (!moves.length) moves = uniqueNames(this.ev.commonMoves(name, base.moves || [], moveLimit), moveLimit);
    return this.ev.threatVariants(base, items, moves).map((v) => ({ ...v, analysis_side: "threat" }));
  }

  /** _v61_candidate_variants (V494 Mega) filtered to the row's item and moves (V77). */
  candidateVariants(name, item, moves) {
    const itemLimit = this.ev.settings.calc_item_limit;
    const moveLimit = this.ev.settings.calc_move_limit;
    const base = this.ev.commonMon(name, name);
    const common = this.ev.commonSet(name);
    if (common.ability) base.ability = common.ability;
    if (common.nature_name) base.nature_name = common.nature_name;
    if (common.bonuses) base.bonuses = [...common.bonuses];
    const items = [];
    if (common.item) items.push(common.item);
    items.push(...this.usage(name, "held_item", itemLimit));
    const moveList = uniqueNames([...(common.moves || [])], 99).slice(0, moveLimit);
    let variants = this.ev.variantsForMon(base, items.slice(0, itemLimit).length ? items.slice(0, itemLimit) : null, moveList, itemLimit, moveLimit);
    variants = variants.map((v) => {
      const out = { ...v, analysis_side: "team", nature_name: common.nature_name ? base.nature_name : v.nature_name, bonuses: [...base.bonuses], moves: (v.moves?.length ? v.moves : moveList).slice(0, moveLimit) };
      this.ev.applyStages(out, this.ev.settings.my_stages);
      return this.ev.asMegaVariant(out);
    });
    if (!variants.length) variants = [base];
    const itemKey = compact(item);
    const chosen = variants.filter((v) => !itemKey || compact(v.item) === itemKey).map((v) => (moves?.length ? { ...v, moves: moves.slice(0, 4) } : v));
    return chosen.length ? chosen : variants;
  }

  /** _v35_best_rank_from_result: hits to remove, 1-3 or 6 ("no reliable KO"). */
  hitRank(result) {
    return [1, 2, 3].includes(Number.parseInt(result?.hits, 10)) ? Number.parseInt(result.hits, 10) : 6;
  }

  /** _v494_move_order: (we move first, the threat moves first) under the current settings. */
  moveOrder(outgoing, incoming) {
    const s = this.ev.settings;
    if (!s.use_speed_tiers) return [false, false];
    let outSpeed = Number(outgoing?.attacker_speed) || 0;
    let inSpeed = Number(incoming?.attacker_speed) || 0;
    if (["My Team", "Both"].includes(s.tailwind)) outSpeed *= 2;
    if (["Threat Team", "Both"].includes(s.tailwind)) inSpeed *= 2;
    if (s.trick_room) return [outSpeed < inSpeed, inSpeed < outSpeed];
    return [outSpeed > inSpeed, inSpeed > outSpeed];
  }

  /** _v494_is_real_answer */
  isRealAnswer(incoming, outgoing) {
    const inHits = this.hitRank(incoming);
    const outHits = this.hitRank(outgoing);
    const [oursFirst, theirsFirst] = this.moveOrder(outgoing, incoming);
    if (theirsFirst && inHits === 1) return false;
    const wins = outHits < inHits;
    const matchesFaster = outHits === inHits && oursFirst;
    if (outHits <= 2 && (wins || matchesFaster)) return true;
    return inHits >= 4 && wins;
  }

  /**
   * V511 `_matchup_evidence`: hits both ways and who moves first, from the engine the Team
   * Evaluation uses (the same two calcs `threatMatchup` runs, so they share its cache).
   * @returns {null|{outHits: number, inHits: number, oursFirst: boolean, theirsFirst: boolean}}
   *   null when the matchup could not be built at all (nothing to measure).
   */
  matchupEvidence(profile, threat) {
    const matchup = this.threatMatchup(profile, threat);
    if (!matchup.incoming && !matchup.outgoing) return null;
    const [oursFirst, theirsFirst] = this.moveOrder(matchup.outgoing, matchup.incoming);
    return { outHits: this.hitRank(matchup.outgoing), inHits: this.hitRank(matchup.incoming), oursFirst, theirsFirst };
  }

  /** V511 `_type_chart_says_good`: whether typing alone would have listed this as an answer. */
  typeChartSaysGood(profile, threat) {
    const threatTypes = this.synergy.metaTypes(threat);
    if (!threatTypes.length) return false;
    const moveTypes = [...(profile.damaging_types || [])].map(pyTitle);
    const ownTypes = (profile.types || []).map(pyTitle);
    const bestAttack = Math.max(...(moveTypes.length ? moveTypes.map((t) => this.ev.engine.typeMultiplier(t, threatTypes)) : [1]));
    const worstIncoming = Math.max(...threatTypes.map((t) => this.ev.engine.typeMultiplier(t, ownTypes)));
    return bestAttack > 1 || (bestAttack >= 1 && worstIncoming <= 0.5);
  }

  /** _v378_team_fit: covers for shared weaknesses, stacked weaknesses, new attacking types. */
  teamFit(teamProfiles, profile) {
    const ownTypes = (profile.types || []).map(pyTitle);
    const covers = [];
    const stacks = [];
    for (const type of TYPES) {
      const weak = teamProfiles.filter((p) => this.ev.engine.typeMultiplier(type, p.types || []) > 1).length;
      if (weak < 2) continue;
      const m = this.ev.engine.typeMultiplier(type, ownTypes);
      if (m <= 0.5) covers.push(type);
      else if (m > 1) stacks.push(type);
    }
    const existing = new Set(teamProfiles.flatMap((p) => [...(p.damaging_types || [])].map(pyTitle)));
    const fresh = new Set([...(profile.damaging_types || [])].map(pyTitle).filter((t) => !existing.has(t)));
    const fit = 50 + Math.min(24, 5 * covers.length) - Math.min(20, 4 * stacks.length) + Math.min(12, 3 * fresh.size);
    return [clamp(fit), covers.slice(0, 4), stacks.slice(0, 4)];
  }

  speedFit(profile) {
    let score = 35 + Math.min(30, (Number(profile.speed) || 0) / 5);
    if (profile.speed_control) score += 24;
    if (profile.priority) score += 10;
    return clamp(score);
  }

  scoreFromPayload(payload, k) {
    if (k === "synergy") return clamp(payload.synergy_score ?? payload.synergy?.score ?? 50);
    if (k === "speed") return clamp(payload.speed?.score ?? 50);
    return clamp(payload[`${k}_score`] ?? 50);
  }

  /** Check snapshot of a projected team (_v378_snapshot_without_cache). */
  snapshotFor(slots, selection) {
    const profiles = slots.map(({ entry, mon }) => this.synergy.profile(entry, mon));
    const tailwind = tailwindBeneficiaries(profiles, this.synergy.metaSpeedRows());
    return this.checks.snapshot(slots, selection, { tailwind });
  }

  /** with_tailwind_payoff(_v403_archetype_features) for a list of slots. */
  featuresFor(slots) {
    const profiles = slots.map(({ entry, mon }) => this.synergy.profile(entry, mon));
    return this.checks.archetypeFeatures(this.checks.profiles(slots), { tailwind: tailwindBeneficiaries(profiles, this.synergy.metaSpeedRows()) });
  }

  /** V378 base row for one candidate. */
  baseRow(meta, context) {
    const { payload, teamSlots, teamEntries, emptySlot, selection } = context;
    let { swapTarget } = context;
    const name = String(meta.name || meta.form || meta.pokemon || "").trim();
    if (!name) return null;
    // The field gate reads the team on screen (_v494_field_support_available), which during Auto Build is the start team.
    const set = meta._candidate_set_v113 ? structuredClone(meta._candidate_set_v113) : this.commonCandidateSet(meta, context.fieldEntries || teamEntries);
    const entry = this.candidateEntry(meta, set);
    const candidateSlot = this.slotFor(entry, teamSlots.length);
    const profile = this.checks.profile(candidateSlot.entry, candidateSlot.mon);
    let simSlots;
    let actionKind;
    let slotIndex;
    let action;
    if (emptySlot !== null) {
      simSlots = [...teamSlots, candidateSlot];
      actionKind = "add";
      slotIndex = emptySlot;
      swapTarget = "";
      action = `Add ${name}`;
    } else {
      slotIndex = this.entryIndexForSwap(teamEntries, swapTarget);
      slotIndex = Math.max(0, Math.min(Math.max(0, teamSlots.length - 1), slotIndex));
      simSlots = [...teamSlots];
      if (simSlots.length) simSlots[slotIndex] = candidateSlot;
      actionKind = "swap";
      action = `Swap ${swapTarget} -> ${name}`;
    }
    const before = payload.checks;
    const after = this.snapshotFor(simSlots, selection);
    const beforeQuality = this.checkQuality(before);
    const afterQuality = this.checkQuality(after);
    const beforeBad = this.badChecks(before);
    const afterBad = this.badChecks(after);
    const fixed = [...beforeBad].filter(([k]) => !afterBad.has(k)).map(([, [label]]) => label);
    const introduced = [...afterBad].filter(([k]) => !beforeBad.has(k)).map(([, [label]]) => label);
    const answerCalcs = [];
    const [offenseFit, defenseFit, answers] = this.typeFit(payload, profile, answerCalcs);
    const teamProfiles = teamSlots.map(({ entry, mon }) => this.checks.profile(entry, mon));
    const [synergyFit, covered, stacked] = this.teamFit(teamProfiles, profile);
    const speedFit = this.speedFit(profile);
    const current = Object.fromEntries(["synergy", "offense", "defense", "speed"].map((k) => [k, this.scoreFromPayload(payload, k)]));
    const projected = {
      synergy: clamp(current.synergy + (synergyFit - 50) * 0.34 + (afterQuality - beforeQuality) * 0.1),
      offense: clamp(current.offense + (offenseFit - 50) * 0.32),
      defense: clamp(current.defense + (defenseFit - 50) * 0.32),
      speed: clamp(current.speed + (speedFit - 50) * 0.32),
    };
    const position = Math.max(1, Number(meta.position ?? meta.column_position ?? 999999) || 999999);
    const rankBonus = Math.max(0, 4 - Math.log10(position + 1) * 1.35);
    const score = clamp((projected.synergy + projected.offense + projected.defense + projected.speed) / 4 + (afterQuality - beforeQuality) * 0.12 + rankBonus);
    const components = Object.fromEntries(["synergy", "offense", "defense", "speed"].map((k) => [k, { current: r1(current[k]), projected: r1(projected[k]), delta: r1(projected[k] - current[k]) }]));
    const details = [];
    const sev = {};
    const add = (text, s) => {
      details.push(text);
      sev[text.toLowerCase()] = s;
    };
    if (fixed.length) add(`Improves Team Building Checks: ${fixed.slice(0, 4).join(", ")}`, "good");
    if (answers.length) add(`Adds type-based counterplay into ${answers.slice(0, 5).join(", ")}`, "good");
    if (covered.length) add(`Adds safer switch options for shared ${covered.join(", ")} weaknesses`, "good");
    if (profile.speed_control || profile.priority) add(`Adds ${[profile.speed_control ? "direct Speed control" : "", profile.priority ? "priority" : ""].filter(Boolean).join(" and ")}`, "good");
    if (introduced.length) add(`Tradeoff: may introduce ${introduced.slice(0, 3).join(", ")}`, "red");
    if (stacked.length) add(`Tradeoff: shares existing ${stacked.join(", ")} weaknesses`, "yellow");
    if (actionKind === "swap" && swapTarget) add(`Replaces ${swapTarget}; review any role unique to that slot`, "yellow");
    const sum = (o) => o.synergy + o.offense + o.defense + o.speed;
    return {
      name, action, action_kind: actionKind, slot_index: Math.max(0, Math.min(TEAM_SIZE - 1, slotIndex)), swap_target: swapTarget,
      score: r1(score), position,
      item: String(set.item || entry.item || "").trim(), ability: String(set.ability || entry.ability || "").trim(),
      moves: (set.moves?.length ? set.moves : entry.moves).slice(0, 4),
      spread_label: String(set.spread?.nature_name || set.spread?.name || set.spread_label || "Most common set"),
      answers, candidate_entry: entry, candidate_spread: structuredClone(set.spread || {}), _candidate_set_v113: set, _candidate_meta_v378: meta,
      _candidate_slot: candidateSlot, _candidate_profile: profile, _after_slots: simSlots,
      _before_check_rows: before?.rows || [], _after_check_rows: after?.rows || [], _fixed_requirements: fixed,
      details, _v104_detail_severities: sev,
      checks_component: r1(afterQuality), threat_component: r1((offenseFit + defenseFit) / 2), synergy_component: r1(synergyFit), speed_component: r1(speedFit),
      total_component: r1(score), projected_total: r1(sum(projected) / 4), total_delta: r1((sum(projected) - sum(current)) / 4),
      projected_synergy_score: r1(projected.synergy), projected_offense_score: r1(projected.offense), projected_defense_score: r1(projected.defense),
      speed_delta: r1(projected.speed - current.speed), suggestion_score_components_v318: components,
      // The calcs behind the listed answers (display only): a struck one is a type matchup the calc does not back.
      answer_calcs_v494: answerCalcs,
    };
  }

  entryIndexForSwap(teamEntries, swapTarget) {
    const target = compact(swapTarget);
    const index = teamEntries.findIndex((entry) => target && compact(entry.pokemon) === target);
    return index >= 0 ? index : Math.max(0, teamEntries.length - 1);
  }

  // --- the layers ------------------------------------------------------------------

  /** V418: newly failed and worsened checks cost ranking. */
  v418(row) {
    const snap = (rows) => {
      const bad = rows.filter((r) => severityOf(r) !== "good");
      const pressure = bad.reduce((s, r) => s + (Number(r.pressure) || 0), 0);
      return { rows, warnings: bad.length, red_count: bad.filter((r) => severityOf(r) === "red").length, yellow_count: bad.filter((r) => severityOf(r) === "yellow").length, check_pressure: pressure };
    };
    const before = snap(row._before_check_rows);
    const after = snap(row._after_check_rows);
    const badMap = (s) => {
      const out = new Map();
      for (const r of s.rows) {
        if (severityValue(r) <= 0) continue;
        const k = String(r.kind || "").trim().toLowerCase();
        if (!k) continue;
        const old = out.get(k);
        if (!old || severityValue(r) > severityValue(old) || (severityValue(r) === severityValue(old) && (Number(r.pressure) || 0) > (Number(old.pressure) || 0))) out.set(k, r);
      }
      return out;
    };
    const bm = badMap(before);
    const am = badMap(after);
    const improvedRows = [];
    const worsenedRows = [];
    const newRows = [];
    let newPenalty = 0;
    let worsenedPenalty = 0;
    const pressure = (r) => Number(r.pressure) || 0;
    for (const [k, b] of bm) {
      const a = am.get(k);
      if (!a) {
        improvedRows.push(b);
        continue;
      }
      if (severityValue(a) < severityValue(b) || pressure(b) - pressure(a) >= 0.65) improvedRows.push(b);
      else if (severityValue(a) > severityValue(b) || pressure(a) - pressure(b) >= 0.65) {
        worsenedRows.push(a);
        worsenedPenalty += Math.max(0.7, pressure(a) - pressure(b)) + Math.max(0, severityValue(a) - severityValue(b)) * 1.8;
      }
    }
    for (const [k, a] of am) {
      if (bm.has(k)) continue;
      newRows.push(a);
      newPenalty += pressure(a) * (severityValue(a) >= 2 ? 1.35 : 0.85);
    }
    const introducedPenalty = newPenalty + worsenedPenalty;
    let component = 50 + (before.check_pressure - after.check_pressure) * 5 + (before.warnings - after.warnings) * 3 + (before.red_count - after.red_count) * 7 + (before.yellow_count - after.yellow_count) * 1.2 - introducedPenalty * 4.2 - Math.max(0, after.red_count - before.red_count) * 6;
    component = clamp(component);
    const label = (r) => this.checkLabelText(r);
    const improved = [...new Set(improvedRows.map(label))];
    const worsened = [...new Set([...worsenedRows, ...newRows].map(label))];
    const details = (row.details || []).filter((v) => !/^(improves team building checks:|tradeoff: may introduce|worsens team building checks:)/i.test(String(v)));
    const sev = { ...(row._v104_detail_severities || {}) };
    if (improved.length) {
      const text = `Improves Team Building Checks: ${improved.join(", ")}`;
      details.unshift(text);
      sev[text.toLowerCase()] = "good";
    }
    if (worsened.length) {
      const text = `Worsens Team Building Checks: ${worsened.join(", ")}`;
      details.push(text);
      sev[text.toLowerCase()] = "red";
    }
    const penalty = Math.min(28, introducedPenalty * 3.2);
    const score = Math.max(0, row.score - penalty);
    Object.assign(row, {
      score: r1(score), total_component: r1(score), checks_component: r1(component), total_delta: r1(row.total_delta - penalty / 8),
      _fixed_requirements: improved, _worsened_requirements: worsened, details, _v104_detail_severities: sev, _raw_adjust: -penalty,
    });
    return row;
  }

  /** _v418_check_label (-> _v100_check_label): the row text, cut at 96 characters. */
  checkLabelText(r) {
    const strip = (v) => String(v ?? "").replace(/^[ .]+|[ .]+$/g, "");
    let text = strip(String(r.text || "").trim().replace(/My Teams Movepool/g, "Your Teams Movepool").replace(/\s+/g, " "));
    if (text.length > 96) text = `${text.slice(0, 93).trimEnd()}…`;
    text = strip(text.replace(/\s+/g, " "));
    if (text) return text;
    return strip(r.check_label || r.summary || r.text || "Team requirement");
  }

  /** V419: no "review any role" note. */
  v419(row) {
    row.details = (row.details || []).filter((v) => !String(v).toLowerCase().includes("review any role unique to that slot"));
    return row;
  }

  /** V429 archetype coverage: requirement ratio, critical ones weigh 2.4. */
  archetypeCoverage(row) {
    const requirements = row?.archetype_requirements_v403 || [];
    let total = 0;
    let covered = 0;
    const indexed = new Map();
    for (const req of requirements) {
      const label = String(req.label || "requirement").trim().replace(/\s+/g, " ").toLowerCase();
      const weight = req.critical ? 2.4 : 1;
      total += weight;
      covered += this.requirementRatio(req) * weight;
      indexed.set(label, req);
    }
    return [total > 0 ? covered / total : 1, indexed];
  }

  requirementRatio(req) {
    const current = Number(req.current) || 0;
    const target = Number(req.target) || 0;
    if (String(req.display || "").toLowerCase().includes("max")) return current <= target ? 1 : Math.max(0, 1 - (current - target) / Math.max(1, target + 1));
    if (target <= 0) return req.met ? 1 : 0;
    return Math.max(0, Math.min(1, current / target));
  }

  archetypeRow(rows) {
    return (rows || []).find((r) => String(r.check_id || r.kind || "").trim().toLowerCase() === "archetype_fit") || null;
  }

  v429(row) {
    const beforeRow = this.archetypeRow(row._before_check_rows);
    const afterRow = this.archetypeRow(row._after_check_rows);
    if (!beforeRow || !afterRow) return row;
    const [beforeCov, beforeReq] = this.archetypeCoverage(beforeRow);
    const [afterCov, afterReq] = this.archetypeCoverage(afterRow);
    const improved = [];
    const worsened = [];
    let criticalFixed = 0;
    let criticalWorsened = 0;
    for (const k of [...new Set([...beforeReq.keys(), ...afterReq.keys()])].sort()) {
      const b = beforeReq.get(k) || {};
      const a = afterReq.get(k) || {};
      const br = Object.keys(b).length ? this.requirementRatio(b) : 0;
      const ar = Object.keys(a).length ? this.requirementRatio(a) : 0;
      const label = String((Object.keys(a).length ? a : b).label || k);
      if (ar > br + 0.001) {
        improved.push(label);
        if ((Object.keys(a).length ? a : b).critical && !b.met && a.met) criticalFixed += 1;
      } else if (ar + 0.001 < br) {
        worsened.push(label);
        if ((Object.keys(a).length ? a : b).critical) criticalWorsened += 1;
      }
    }
    const delta = afterCov - beforeCov;
    const adjustment = Math.max(-30, Math.min(30, delta * 52 + criticalFixed * 5 - criticalWorsened * 8));
    const score = clamp(row.score + adjustment);
    row._raw_adjust = adjustment;
    row.score = r1(score);
    row.total_component = r1(score);
    row.total_delta = r1(row.total_delta + adjustment / 8);
    row.archetype_component_v429 = r1(afterCov * 100);
    row.archetype_delta_v429 = r1(delta * 100);
    row.suggestion_score_components_v318 = { ...row.suggestion_score_components_v318, archetype: { current: r1(beforeCov * 100), projected: r1(afterCov * 100), delta: r1(delta * 100), weight: 52 } };
    const archetype = String(afterRow.archetype || beforeRow.archetype || "current archetype");
    if (improved.length) {
      const text = `Improves ${archetype} fit: ${improved.join(", ")}`;
      row.details.unshift(text);
      row._v104_detail_severities[text.toLowerCase()] = "good";
    }
    if (worsened.length) {
      const text = `Worsens ${archetype} fit: ${worsened.join(", ")}`;
      row.details.push(text);
      row._v104_detail_severities[text.toLowerCase()] = "red";
    }
    return row;
  }

  /** _v433_check_penalty */
  checkPenalty(row) {
    if (rowKey(row) === "archetype_fit") {
      const [coverage, requirements] = this.archetypeCoverage(row);
      const criticalMissing = [...requirements.values()].filter((r) => r.critical && !r.met).length;
      return Math.max(0, (1 - coverage) * 14 + criticalMissing * 2.5);
    }
    const base = { good: 0, yellow: 4, red: 12 }[severityOf(row)];
    return Math.max(base, Number(row.pressure) || 0);
  }

  /** _v433_check_metrics (selected = null: every row) / _v451_enabled_check_metrics */
  checkMetrics(rows, selected = null) {
    const indexed = new Map();
    for (const raw of rows || []) {
      const k = rowKey(raw);
      if (!k || k === "checks_disabled") continue;
      if (selected && selected.size && !selected.has(k)) continue;
      indexed.set(k, raw);
    }
    const penalties = new Map([...indexed].map(([k, r]) => [k, this.checkPenalty(r)]));
    return {
      rows: indexed, penalties, total: [...penalties.values()].reduce((s, v) => s + v, 0),
      red: [...indexed.values()].filter((r) => severityOf(r) === "red").length,
      yellow: [...indexed.values()].filter((r) => severityOf(r) === "yellow").length,
      selected: [...indexed.keys()].sort(),
    };
  }

  checkChanges(before, after) {
    const improved = [];
    const worsened = [];
    for (const k of [...new Set([...before.rows.keys(), ...after.rows.keys()])].sort()) {
      const old = before.rows.get(k);
      const now = after.rows.get(k);
      const op = before.penalties.get(k) || 0;
      const np = after.penalties.get(k) || 0;
      const r = now || old;
      const label = String(r.check_label || "").trim() || this.checks.labels[k] || pyTitle(k.replace(/_/g, " ")) || "Team Check";
      const os = old ? severityOf(old) : "good";
      const ns = now ? severityOf(now) : "good";
      if (np < op - 0.05) improved.push([label, os, ns]);
      else if (np > op + 0.05) worsened.push([label, os, ns]);
    }
    return [improved, worsened];
  }

  changeText(changes) {
    const status = (v) => ({ red: "Problem", yellow: "Watch", good: "Covered" })[v] || pyTitle(v);
    return changes.map(([label, old, now]) => (old !== now ? `${label} (${status(old)} → ${status(now)})` : label)).join(", ");
  }

  /** V433 (all checks) and V451 (enabled checks): before/after penalty adjustment, then the details. */
  checkAdjust(row, context, selected) {
    const before = this.checkMetrics(row._before_check_rows, selected);
    const after = this.checkMetrics(row._after_check_rows, selected);
    const [improved, worsened] = this.checkChanges(before, after);
    const gain = before.total - after.total;
    const fixedRed = improved.filter(([, o, n]) => o === "red" && n !== "red").length;
    const introducedRed = worsened.filter(([, o, n]) => n === "red" && o !== "red").length;
    const adjustment = Math.max(-18, Math.min(18, gain * 1.15 + fixedRed * 6 - introducedRed * 8));
    const score = clamp(row.score + adjustment);
    row._raw_adjust = adjustment;
    row.score = r1(score);
    row.total_component = r1(score);
    row.team_check_before_penalty_v433 = r3(before.total);
    row.team_check_after_penalty_v433 = r3(after.total);
    row.team_check_delta_v433 = r3(gain);
    row.team_check_improved_v433 = improved.map(([l]) => l);
    row.team_check_worsened_v433 = worsened.map(([l]) => l);
    if (selected) row.team_checks_considered_v451 = before.selected.length ? before.selected : after.selected;
    this.replaceDetails(row, context, improved, worsened);
    return row;
  }

  /** _v433_replace_details */
  replaceDetails(row, context, improved, worsened) {
    const kept = [];
    for (const text of (row.details || []).map((v) => String(v).trim()).filter(Boolean)) {
      const low = text.toLowerCase();
      if (low.startsWith("improves team building checks:") || low.startsWith("tradeoff: may introduce")) continue;
      if (low.startsWith("adds direct speed control") || low.startsWith("adds priority")) continue;
      if (low.startsWith("replaces ") && low.includes("review any role unique")) continue;
      if (row.action_kind === "swap" && (low.startsWith("adds type-based counterplay") || low.startsWith("adds safer switch options") || low.startsWith("tradeoff: shares existing"))) continue;
      kept.push(text);
    }
    const oldSev = row._v104_detail_severities || {};
    const sev = {};
    for (const text of kept) sev[text.toLowerCase()] = String(oldSev[text.toLowerCase()] || "neutral");
    const prefix = [];
    const suffix = [];
    if (improved.length) prefix.push([`Improves Team Building Checks: ${this.changeText(improved)}`, "good"]);
    if (worsened.length) suffix.push([`Worsens Team Building Checks: ${this.changeText(worsened)}`, "red"]);
    const { teamSlots, payload } = context;
    const slot = Number(row.slot_index) || 0;
    if (row.action_kind === "swap" && teamSlots[slot]) {
      const outgoing = this.checks.profile(teamSlots[slot].entry, teamSlots[slot].mon);
      const candidate = row._candidate_profile;
      const candAnswers = this.typeFit(payload, candidate)[2];
      const outAnswers = new Set(this.typeFit(payload, outgoing)[2].map((v) => v.toLowerCase()));
      const net = candAnswers.filter((v) => !outAnswers.has(v.toLowerCase()));
      if (net.length) prefix.push([`Adds type-based counterplay into ${net.slice(0, 5).join(", ")}`, "good"]);
      const baseProfiles = teamSlots.filter((_, i) => i !== Math.max(0, Math.min(teamSlots.length - 1, slot))).map(({ entry, mon }) => this.checks.profile(entry, mon));
      const [, cCovers, cStacks] = this.teamFit(baseProfiles, candidate);
      const [, oCovers, oStacks] = this.teamFit(baseProfiles, outgoing);
      const oc = new Set(oCovers.map((v) => v.toLowerCase()));
      const os = new Set(oStacks.map((v) => v.toLowerCase()));
      const netCovers = cCovers.filter((v) => !oc.has(v.toLowerCase()));
      const netStacks = cStacks.filter((v) => !os.has(v.toLowerCase()));
      if (netCovers.length) prefix.push([`Adds safer switch options for shared ${netCovers.join(", ")} weaknesses`, "good"]);
      if (netStacks.length) suffix.push([`Tradeoff: adds shared ${netStacks.join(", ")} weaknesses`, "yellow"]);
    }
    const features = (rows) => this.archetypeRow(rows)?.archetype_features_v403 || {};
    const bf = features(row._before_check_rows);
    const af = features(row._after_check_rows);
    const delta = (k) => (Number(af[k]) || 0) - (Number(bf[k]) || 0);
    const added = [];
    const lost = [];
    if (delta("speed_control") > 0) added.push("direct Speed control");
    else if (delta("speed_control") < 0) lost.push("direct Speed control");
    if (delta("priority") > 0) added.push("priority");
    else if (delta("priority") < 0) lost.push("priority");
    if (added.length) prefix.push([`Adds ${added.join(" and ")}`, "good"]);
    if (lost.length) suffix.push([`Tradeoff: loses ${lost.join(" and ")}`, "red"]);
    const ordered = [];
    const seen = new Set();
    for (const [text, s] of [...prefix, ...kept.map((v) => [v, sev[v.toLowerCase()] || "neutral"]), ...suffix]) {
      const n = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!n || seen.has(n)) continue;
      seen.add(n);
      ordered.push(text);
      sev[text.toLowerCase()] = s;
    }
    row.details = ordered;
    row._v104_detail_severities = sev;
  }

  /** The projected team with the candidate in its slot (_v477_project_candidate_team). */
  projectedSlots(context, row) {
    const slots = [...context.teamSlots];
    const target = compact(row.swap_target || "");
    if (target) {
      const index = context.teamEntries.findIndex((e) => compact(e.pokemon) === target);
      if (index >= 0) {
        slots[index] = row._candidate_slot;
        return slots;
      }
    }
    if (slots.length < TEAM_SIZE) slots.push(row._candidate_slot);
    return slots;
  }

  /**
   * known_team_prediction, the outermost wrap of _v466_apply_strategy_fit: a candidate
   * that completes a saved tournament team (five of ours already in it) gets +14 and
   * that team's own item, Ability, moves and Nature.
   */
  knownTeamFit(row, context) {
    // The library holds Doubles tournament teams: in Singles their sets (Fake Out,
    // Follow Me, Helping Hand...) are not what a Singles player runs, so no bonus.
    if (!this.known || !row || this.ev.format === "Singles") return row;
    // The app reads base_name, pokemon and form off the row; a suggestion row carries
    // none of them, so both are its name -- a Mega candidate never matches a file.
    const species = String(row.name || "");
    const found = this.known.completingMember(context.payload?.team || [], species, species);
    if (!found) return row;
    const [team, member] = found;
    const out = { ...row, found_in_team_v496: String(team.name || "") };
    out.score = Number(pyFixed(Math.max(0, Math.min(100, (Number(row.score) || 0) + this.known.bonus)), 1));
    out._raw_adjust = this.known.bonus;
    out.total_component = out.score;
    if (member.item) out.item = member.item;
    if (member.ability) out.ability = member.ability;
    const moves = (member.moves || []).map(String).filter((m) => m.trim());
    if (moves.length) out.moves = moves.slice(0, 4);
    // "Use" applies candidate_entry, so it carries the same set the row shows (V509).
    out.candidate_entry = this.knownTeamEntry(row.candidate_entry, member, moves);
    if (member.nature) {
      out.nature = member.nature;
      // candidate_spread is what applying the row writes, so the Nature comes with it.
      const spread = this.spreadForNature(species, member.nature);
      if (spread) out.candidate_spread = spread;
    }
    const note = `${FOUND_IN_TEAM_NOTE} (${team.name})`;
    const details = [...(out.details || [])];
    if (!details.includes(note)) details.unshift(note);
    out.details = details;
    out._v104_detail_severities = { ...(out._v104_detail_severities || {}), [note.toLowerCase()]: "good" };
    return out;
  }

  /** known_team_prediction.team_entry: the saved set, its Mega form following the item. */
  knownTeamEntry(entry, member, moves) {
    if (!entry || !String(entry.pokemon || "").trim()) return entry;
    const item = member.item || entry.item;
    let ability = member.ability || entry.ability;
    let form = /^mega\s/i.test(String(entry.form || "")) ? entry.pokemon : entry.form;
    const [megaForm, megaAbility] = this.megaIdentity(entry.pokemon, item, ability);
    if (megaForm) {
      form = megaForm;
      ability = megaAbility || ability;
    }
    return { pokemon: entry.pokemon, item, form, ability, moves: (moves.length ? moves : entry.moves || []).slice(0, 4) };
  }

  /**
   * known_team_prediction.spread_for_nature over common_stat_alignment_spreads(species, 10).
   * Each Nature keeps the most used Stat Points it does not contradict (spreadPointsForNature).
   */
  spreadForNature(species, nature) {
    const record = this.ev.record(species);
    const natures = (record?.natures || []).slice(0, 10);
    const points = record?.spreads || [];
    const table = this.ev.engine.natures || {};
    const spreads = natures.map(([name, pct], index) => {
      const natureName = String(name || "Serious").trim() || "Serious";
      const point = spreadPointsForNature(points, table[natureName]);
      return {
        name: natureName, nature_name: natureName, nature: [...(table[natureName] || ["", ""])],
        bonuses: [...(point?.[1] || [0, 0, 0, 0, 0, 0])],
        percentage: Number(pct) || 0, stat_points_percentage: Number(point?.[0]) || 0, rank: index + 1,
      };
    });
    const wanted = String(nature || "").trim().toLowerCase();
    const hit = spreads.find((spread) => wanted && spread.nature_name.trim().toLowerCase() === wanted);
    if (hit) return { ...hit, nature: [...hit.nature], bonuses: [...hit.bonuses] };
    if (!wanted) return spreads[0] ? { ...spreads[0] } : null;
    // A Nature the usage file never saw still gets Stat Points that suit it, not the top Nature's.
    const title = String(nature).trim().toLowerCase().replace(/(^|[^a-z])([a-z])/g, (m, a, b) => a + b.toUpperCase());
    const effect = table[title] || ["", ""];
    const point = spreadPointsForNature(points, effect);
    return {
      ...(spreads[0] || { bonuses: [] }), name: title, nature_name: title, nature: [...effect],
      bonuses: [...(point?.[1] || spreads[0]?.bonuses || [])], stat_points_percentage: Number(point?.[0]) || 0,
    };
  }

  /** V466 and the installers wrapped round it: the team's strategy. */
  strategyFit(row, context) {
    const { payload } = context;
    // part_115 base (_v466_actual_archetype): a chosen Auto Build archetype is authoritative.
    const beforeArchetype = this.archetypeRow(row._before_check_rows);
    let archetype = String(context.archetype?.key || beforeArchetype?.archetype_key_v403 || beforeArchetype?.archetype || "").trim().toLowerCase();
    if (!archetype) archetype = classifyArchetype(this.featuresFor(context.teamSlots))[1] || "balanced";
    const teamFeatures = this.featuresFor(context.teamSlots);
    const fit = archetypeSpeedControlFit(archetype, row.moves?.length ? row.moves : row.candidate_entry.moves, Number(teamFeatures.trick_room_setters) || 0, Number(teamFeatures.tailwind_setters) || 0);
    const res = checkResolution(row._before_check_rows, row._after_check_rows);
    const adjustment = fit.adjustment + res.fixes * 5 - res.worsened * 9;
    // The breakdown's share of each piece (the score ledger); nothing reads it back.
    const pieces = [];
    const piece = (key, label, before, raw) => {
      if (Math.abs(row.score - before) >= 0.05 || Math.abs(raw) >= 0.05) pieces.push({ key, label, delta: r1(row.score - before), raw: r1(raw) });
    };
    let before = row.score;
    row.score = r1(clamp(row.score + adjustment));
    piece("speed_plan", res.fixes || res.worsened ? "Speed plan and Speed Control" : "Speed plan", before, adjustment);
    row.total_component = row.score;
    row.archetype_speed_fit_v466 = r1(50 + fit.adjustment);
    row.counter_archetype_speed_control_v466 = fit.conflict;
    row.role_fixes_v466 = res.fixes;
    row.role_worsened_v466 = res.worsened;
    row.strategy_archetype_v466 = archetype;
    if (fit.reason && !row.details.includes(fit.reason)) {
      if (fit.conflict) row.details.push(fit.reason);
      else row.details.unshift(fit.reason);
      row._v104_detail_severities[fit.reason.toLowerCase()] = fit.conflict ? "red" : "good";
    }
    const projected = this.projectedSlots(context, row);
    const projectedProfiles = projected.map(({ entry, mon }) => this.synergy.profile(entry, mon));
    // team_strategy: a redundant Trick Room setter costs 18.
    const room = roomPlan(projectedProfiles, this.synergy.metaSpeedRows());
    if (room.redundant) {
      row.counter_archetype_speed_control_v466 = true;
      before = row.score;
      row.score = Math.max(0, row.score - 18 * room.redundant);
      piece("trick_room", "A Trick Room setter the team cannot use", before, -18 * room.redundant);
      row.total_component = row.score;
      row.details.push("Multiple Trick Room setters need at least two slow attacking partners.");
    }
    // field_synergy: a terrain that misses more than one teammate.
    const reach = this.terrainReach(projected);
    if (reach.excess) {
      before = row.score;
      row.score = Math.max(0, row.score - 12 * reach.excess);
      piece("terrain", "Terrain that misses teammates", before, -12 * reach.excess);
      row.total_component = row.score;
      row.details.push(`${reach.terrains.join("/").replace(/\b\w/g, (c) => c.toUpperCase())} Terrain misses ${reach.unreachable.length} of the team (${reach.unreachable.join(", ")}).`);
    }
    // archetype_payoff: turning the plan on, cashing it in, not fighting it.
    const condition = CONDITION_BY_ARCHETYPE[archetype];
    if (condition) {
      const plan = payoff(condition, teamFeatures, this.featuresFor(projected));
      if (plan.adjustment || plan.reason) {
        row.archetype_payoff_v496 = plan;
        before = row.score;
        row.score = r1(clamp(row.score + plan.adjustment));
        piece("payoff", "Archetype payoff", before, plan.adjustment);
        row.total_component = row.score;
        if (plan.conflict) row.counter_archetype_speed_control_v466 = true;
        if (plan.reason && !row.details.includes(plan.reason)) {
          if (plan.conflict || plan.adjustment < 0) row.details.push(plan.reason);
          else row.details.unshift(plan.reason);
          row._v104_detail_severities[plan.reason.toLowerCase()] = plan.adjustment < 0 ? "red" : "good";
        }
      }
    }
    before = row.score;
    this.conditionalValue(row, context, projected);
    if (row.conditional_dependence_v499 && row._conditional_value_applied) piece("conditional", "Relies on a condition the team does not set", before, -(Number(row.conditional_dependence_v499.cost) || 0));
    row._strategy_ledger = pieces;
    return row;
  }

  /** field_synergy.terrain_reach */
  terrainReach(slots) {
    const terrains = [];
    const unreachable = [];
    const setters = [["grassy", ["grassyterrain", "grassysurge"]], ["psychic", ["psychicterrain", "psychicsurge"]], ["electric", ["electricterrain", "electricsurge", "hadronengine"]], ["misty", ["mistyterrain", "mistysurge"]]];
    for (const { entry } of slots) {
      const keys = new Set([compact(entry.ability), ...(entry.moves || []).map(compact)]);
      for (const [condition, list] of setters) if (list.some((k) => keys.has(k)) && !terrains.includes(condition)) terrains.push(condition);
      const types = this.ev.engine.pokemon(entry.pokemon, entry.form || entry.pokemon)?.types || [];
      const grounded = !types.some((t) => compact(t) === "flying") && compact(entry.ability) !== "levitate" && compact(entry.item) !== "airballoon";
      if (!grounded) unreachable.push(String(entry.pokemon));
    }
    return { terrains, unreachable, excess: terrains.length ? Math.max(0, unreachable.length - 1) : 0 };
  }

  /** conditional_value: a species whose defining move needs a condition the team lacks. */
  conditionalValue(row, context, projected) {
    if (row._conditional_value_applied) return row;
    const species = String(row.base_name || row.pokemon || row.name || "");
    if (!species) return row;
    const needing = { ...MOVES_NEEDING_SUPPORT };
    const available = this.fieldSupport(projected.map(({ entry }) => entry));
    const usage = this.ev.usagePairs(this.ev.baseSpeciesFromDisplay(species), "move", 12);
    const partners = projected.filter(({ entry }) => entry.pokemon && this.speciesId(entry.pokemon) !== this.speciesId(species));
    const moves = new Set((row.candidate_entry?.moves || row.moves || []).map(compact));
    const alreadyPenalized = moves.has("trickroom") && row.counter_archetype_speed_control_v466;
    const dependence = (need) => {
      let worst = [0, "", ""];
      for (const [move, percent] of usage) {
        const needed = need[compact(move)];
        if (!needed || available.has(needed)) continue;
        const share = (Number(percent) || 0) / 100;
        if (share > worst[0]) worst = [share, String(move), needed];
      }
      return worst;
    };
    const roomShare = dependence({ trickroom: "partners" })[0];
    if (roomShare >= 0.9 && partners.length && !alreadyPenalized) {
      const profiles = partners.map(({ entry, mon }) => this.synergy.profile(entry, mon));
      const plan = speedModePlan(profiles, this.synergy.metaSpeedRows());
      if ((partners.length >= 3 && !plan.room_supported) || plan.mode === "tailwind") needing.trickroom = "slow attacking partners for Trick Room";
    }
    const [share, move, condition] = dependence(needing);
    const cost = share < 0.25 ? 0 : r2(34 * share);
    if (!cost) return row;
    row._conditional_value_applied = true;
    row.conditional_dependence_v499 = { share: r3(share), move, condition, cost };
    row.score = r1(Math.max(0, row.score - cost));
    row.total_component = row.score;
    let note = ["psychic", "grassy", "electric", "misty", "terrain"].includes(condition)
      ? `${move} is ${pyRound(share * 100)}% of this Pokemon's usage and needs ${condition} terrain, which this team does not set.`
      : `${move} is ${pyRound(share * 100)}% of this Pokemon's usage and needs ${condition}, which this team does not set.`;
    if (compact(move) === "trickroom") {
      row.counter_archetype_speed_control_v466 = true;
      row.archetype_speed_fit_v466 = r1(50 - cost);
      note = `Trick Room appears in ${pyRound(share * 100)}% of this Pokemon's sets, but these partners do not support that speed plan. Replacing it with another move loses its main role; priority protection and other support must earn the slot on their own.`;
    }
    if (!row.details.includes(note)) row.details.push(note);
    row._v104_detail_severities[note.toLowerCase()] = "red";
    return row;
  }

  /** V480 Item Clause: two slots may not hold the same item. */
  obeysItemClause(row, context) {
    const keys = [];
    const team = [...context.teamEntries];
    while (team.length < TEAM_SIZE) team.push(null);
    team[Math.max(0, Math.min(TEAM_SIZE - 1, Number(row.slot_index) || 0))] = row.candidate_entry;
    for (const entry of team) {
      if (!entry || !String(entry.pokemon || "").trim()) continue;
      const k = compact(entry.item);
      if (k) keys.push(k);
    }
    return keys.length === new Set(keys).size;
  }

  /**
   * `_coverage_correction`: (correction, requirement label) for the archetype move charged
   * twice. Reads the two archetype-fit check rows the candidate already carries, so no check
   * is recomputed and a row that never had them is left alone.
   * @returns {[number, string]}
   */
  archetypeMoveCorrection(row, archetype) {
    const label = speedPlanRequirement(archetype);
    if (!label) return [0, ""];
    const beforeRow = this.archetypeRow(row._before_check_rows);
    const afterRow = this.archetypeRow(row._after_check_rows);
    if (!beforeRow || !afterRow) return [0, ""];
    const after = afterRow.archetype_requirements_v403 || [];
    const correction = archetypeMoveDoublePayment(
      beforeRow.archetype_requirements_v403 || [], after,
      (req) => this.requirementRatio(req), archetype, this.suggestionScoring,
    );
    if (correction >= -1e-9) return [0, ""];
    const named = after.find((req) => requirementLabel(req) === label);
    return [correction, String(named?.label || label)];
  }

  /**
   * V511 stage one (`_rescore_stage_one`): applied after every existing layer, so the numbers
   * it corrects are the ones the row ends the chain with.
   *
   *   (a)  the archetype speed plan, damped by the setters the team already has;
   *   (a2) and the coverage layer not charging for that same move a second time;
   *   (b)  speed fit pointed the way the team's plan points.
   *
   * Every conflict penalty, the Tailwind branch and the fast-control credit are untouched.
   */
  rescoreStageOne(row, context) {
    const archetype = String(row.strategy_archetype_v466 || "").trim().toLowerCase();
    const features = this.featuresFor(context.teamSlots);
    const trSetters = Number(features.trick_room_setters) || 0;
    const twSetters = Number(features.tailwind_setters) || 0;
    const pieces = [];
    let score = Number(row.score) || 0;

    // (a) the archetype is one term among several, not the whole ranking.
    const fit = archetypeSpeedControlFit(archetype, row.moves?.length ? row.moves : row.candidate_entry.moves, trSetters, twSetters);
    const [after, reason] = dampedSpeedPlan(fit, archetype, trSetters, this.suggestionScoring);
    if (Math.abs(after - fit.adjustment) > 1e-9) {
      score += after - fit.adjustment;
      // `conditionalValue` (and the payoff) write this flag when they strip a Trick Room the
      // team cannot support; where they have spoken, the field is theirs.
      if (!row.counter_archetype_speed_control_v466) row.archetype_speed_fit_v466 = r1(50 + after);
      const details = (row.details || []).filter((line) => String(line) !== String(fit.reason || ""));
      if (reason && !details.includes(reason)) details.unshift(reason);
      row.details = details;
      const severities = { ...(row._v104_detail_severities || {}) };
      delete severities[String(fit.reason || "").toLowerCase()];
      if (reason) severities[reason.toLowerCase()] = after > 0 ? "good" : "yellow";
      row._v104_detail_severities = severities;
      pieces.push({ key: "speed_plan_v511", label: "Fits the speed plan", delta: r1(after - fit.adjustment), raw: r1(after - fit.adjustment), detail: reason });
    }

    // (a2) and the coverage layer does not charge for that same move a second time.
    // `archetype_component_v429` is the projected team's real coverage and is left alone:
    // the team would genuinely hold those setters. What changes is only what the candidate
    // is *paid* for holding the move.
    const [correction, requirement] = this.archetypeMoveCorrection(row, archetype);
    if (correction < -1e-9) {
      score += correction;
      row.archetype_move_double_payment_v511 = r2(correction);
      pieces.push({
        key: "archetype_double_v511",
        label: "Archetype fit, minus the speed plan",
        delta: r1(correction),
        raw: r1(correction),
        detail: `The archetype's "${requirement}" requirement is the speed plan above, so closing it is not paid for twice.`,
      });
    }

    // (b) a Trick Room team wants the slow half of the speed tiers, and a candidate whose only
    // speed control is Trick Room stops being paid for it twice. Only where the base row really
    // folded a speed fit in: a row without one has nothing to correct.
    const profile = row._candidate_profile;
    if (profile && row.speed_component !== undefined && row.speed_component !== null) {
      const before = Number(row.speed_component);
      const directed = directedSpeedFit(profile, archetype, trSetters);
      const move = (directed - before) * SPEED_FIT_TO_SCORE;
      if (Math.abs(move) > 1e-9) {
        score += move;
        row.speed_component = r1(directed);
        row.speed_fit_directed_v511 = r1(directed);
        pieces.push({
          key: "speed_direction_v511",
          label: "Speed against the team's plan",
          delta: r1(move),
          raw: r1(move),
          detail: archetype === "trick room" ? "A Trick Room team wants the slow half of the speed tiers." : "Speed and speed control against the team's plan.",
        });
      }
    }
    row.score = r1(clamp(score));
    row.total_component = row.score;
    row.stage_one_score_v511 = row.score;
    row._strategy_ledger = pieces;
    return row;
  }

  /**
   * V511 stage two (`_score_on_calcs`): this candidate measured against the team's worst
   * threats with the engine the Team Evaluation uses. Writes the verdicts the breakdown reads
   * and moves the score by three terms: what it answers, what it covers that the team has
   * nothing for, and what removes it first.
   * @param {Map<string, boolean>} gaps  threat name -> nothing on the team answers it today
   */
  scoreOnCalcs(row, threats, totalWeight, gaps) {
    if (row.calc_scored_v511) return row; // a row already measured keeps the terms it was given
    const profile = row._candidate_profile;
    if (!profile) return row;
    const entries = [];
    let answerValue = 0;
    let gapValue = 0;
    let loseWeight = 0;
    let measured = 0;
    for (const threat of threats) {
      const name = String(threat.name || threat.base_name || "Threat");
      const score = threatScore(threat);
      const weight = Math.max(1, Number.isFinite(score) ? score : 40) / totalWeight;
      const evidence = this.matchupEvidence(profile, threat);
      if (!evidence) continue;
      measured += 1;
      const verdict = verdictFor(evidence.outHits, evidence.inHits, evidence.oursFirst, evidence.theirsFirst);
      const value = VERDICT_VALUE[verdict] ?? 0.3;
      const fillsAGap = Boolean(gaps.get(name));
      answerValue += weight * value;
      if (fillsAGap && (verdict === "beats" || verdict === "walls")) gapValue += weight * value;
      if (verdict === "loses") loseWeight += weight;
      const entry = {
        threat: name, threat_score: r1(Number.isFinite(score) ? score : 0), verdict,
        out_hits: evidence.outHits, in_hits: evidence.inHits, ours_first: evidence.oursFirst, theirs_first: evidence.theirsFirst,
        fills_a_gap: fillsAGap,
        sentence: verdictSentence(name, verdict, evidence.outHits, evidence.inHits, evidence.oursFirst, evidence.theirsFirst),
      };
      // Threats whose typing flatters this Pokémon while the calc disagrees.
      if (verdict !== "beats" && verdict !== "walls") entry.type_chart_says_good = this.typeChartSaysGood(profile, threat);
      entries.push(entry);
    }
    if (!measured) return row;

    const answeredShare = 100 * answerValue;
    const answerTerm = Math.max(-ANSWER_SPAN, Math.min(ANSWER_SPAN, (answeredShare - ANSWER_MIDPOINT) * ANSWER_SCALE));
    const gapTerm = Math.max(0, Math.min(GAP_SPAN, GAP_SPAN * gapValue * 2));
    const vulnerableTerm = -Math.max(0, Math.min(VULNERABLE_SPAN, VULNERABLE_SPAN * loseWeight * 1.6));
    // Sorted by how convincingly it wins, not by how scary the threat is.
    entries.sort((a, b) => (VERDICT_SORT[a.verdict] ?? 9) - (VERDICT_SORT[b.verdict] ?? 9)
      || (a.out_hits - a.in_hits) - (b.out_hits - b.in_hits)
      || (Number(b.threat_score) || 0) - (Number(a.threat_score) || 0));
    const beaten = entries.filter((e) => e.verdict === "beats" || e.verdict === "walls");
    const removedFirst = entries.filter((e) => e.verdict === "loses").length;
    row.threat_verdicts_v511 = entries;
    row.threat_answers_v511 = beaten;
    row.type_matchup_only_v511 = entries.filter((e) => e.type_chart_says_good);
    row.threats_measured_v511 = measured;
    row.answered_share_v511 = r1(answeredShare);
    row.gaps_filled_v511 = beaten.filter((e) => e.fills_a_gap).length;
    row.removed_first_v511 = removedFirst;
    row.calc_scored_v511 = true;
    // The closed row's "Helps vs" list and the open breakdown's answers were two different
    // lists; both are this one now.
    if (beaten.length) row.answers = beaten.map((e) => e.threat).slice(0, 5);

    // The app keeps its own `score_ledger_v511` because it had no score ledger at all; this
    // engine already builds one per layer, so the three calc terms join it with the same
    // labels and the same wording, and the ledger still adds up to the score.
    const ledger = [...(row.score_ledger || [])];
    ledger.push({ key: "answers_v511", label: "Answers the team's threats", delta: r1(answerTerm), raw: r1(answerTerm), detail: `Beats or walls ${beaten.length} of the ${measured} worst threats, weighted by how bad each one is.` });
    if (gapTerm) ledger.push({ key: "gaps_v511", label: "Covers what the team is missing", delta: r1(gapTerm), raw: r1(gapTerm), detail: `${row.gaps_filled_v511} of those are threats nothing on the team answers today.` });
    if (vulnerableTerm) ledger.push({ key: "vulnerable_v511", label: "Survives the same threats", delta: r1(vulnerableTerm), raw: r1(vulnerableTerm), detail: `${removedFirst} of them ${removedFirst === 1 ? "removes" : "remove"} it first.` });
    row.score_ledger = ledger;
    row.score = r1(clamp((Number(row.score) || 0) + answerTerm + gapTerm + vulnerableTerm));
    row.score_uncapped = r1(ledger.reduce((sum, item) => sum + (item.value ?? item.raw ?? item.delta ?? 0), 0));
    row.total_component = row.score;
    row.answered_threat_component_v511 = r1(clamp(answeredShare));
    row.verdict_line_v511 = verdictLine(row);
    return row;
  }

  /**
   * V511 stage two over the finished pool: the best 40 by stage-one score are measured against
   * the team's 8 worst threats and re-ranked, then the list the page shows is cut from that.
   * @param {Array} pool  every candidate's best row, already in (-score, position, name) order
   * @param {number} limit  how many rows the list shows
   * @returns {Array|null} the re-ranked rows, or null when there is nothing to measure against
   */
  deepRank(pool, payload, limit, onProgress) {
    const threats = (payload.threats || []).filter((t) => t && typeof t === "object")
      .map((t, i) => [t, i]).sort((a, b) => -(Number(a[0].score) || 0) - -(Number(b[0].score) || 0) || a[1] - b[1])
      .map(([t]) => t).slice(0, DEEP_THREATS);
    if (!threats.length) return null;
    const totalWeight = threats.reduce((sum, t) => {
      const score = threatScore(t);
      return sum + Math.max(1, Number.isFinite(score) ? score : 40);
    }, 0) || 1;
    const gaps = teamGapThreats(threats);
    const shortlist = pool.slice(0, SHORTLIST);
    const tail = pool.slice(SHORTLIST);
    shortlist.forEach((row, index) => {
      this.scoreOnCalcs(row, threats, totalWeight, gaps);
      onProgress?.(index + 1, shortlist.length, row.name);
    });
    const ranked = [...shortlist].sort((a, b) => b.score - a.score || a.position - b.position
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return [...ranked, ...tail].slice(0, limit).map((row) => this.namedAction(row));
  }

  /**
   * The full chain for one candidate (_v378_fast_suggestion_for_candidate).
   *
   * Suggestions never enforce Item Clause while ranking (V482 restored the
   * pre-V480 evaluator): a clash is repaired when the suggestion is applied.
   * `context.autoBuild` switches on the Auto Build layers: V432 archetype
   * priority, the V433 check sort key, V462's Prioritize Meta flag, V472's
   * hard-check metrics and forced final Mega, V477's chosen-archetype metrics,
   * V482's first non-clashing set, and the three rules for a finished team
   * (defensive warnings, Trick Room plan, terrain reach).
   */
  evaluateCandidate(meta, context) {
    // species_identity: never offer the Pokemon being replaced.
    if (context.swapTarget && this.speciesId(meta.form || meta.name || meta.base_name) === this.speciesId(context.swapTarget)) return null;
    const auto = Boolean(context.autoBuild);
    const inner = (m) => {
      const evaluated = auto ? this.forceFinalMegaMeta(m, context) : m;
      let row = this.baseRow(evaluated, context);
      if (!row) return null;
      // The score ledger: what each layer added, for the breakdown. Only fields are
      // written; no score and no order depends on them.
      const ledger = [{ key: "team", label: "Team fit (projected scores, checks, meta rank)", value: row.score }];
      const layer = (key, label, apply) => {
        const before = Number(row.score) || 0;
        row._raw_adjust = undefined;
        row._strategy_ledger = undefined;
        row = apply(row);
        const delta = (Number(row.score) || 0) - before;
        if (Array.isArray(row._strategy_ledger)) ledger.push(...row._strategy_ledger);
        else if (Math.abs(delta) >= 0.05 || (row._raw_adjust !== undefined && Math.abs(row._raw_adjust) >= 0.05)) ledger.push({ key, label, delta: r1(delta), raw: r1(row._raw_adjust ?? delta) });
        delete row._raw_adjust;
        delete row._strategy_ledger;
      };
      layer("checks_new", "New or worse Team Building Checks", (r) => this.v418(r));
      row = this.v419(row);
      layer("archetype", "Archetype fit", (r) => this.v429(r));
      if (auto) layer("archetype_priority", "Archetype priority (Auto Build)", (r) => this.v432(r));
      // V451 replaces V433: the before/after check penalty over the enabled checks only.
      layer("checks", "Team Building Checks", (r) => this.checkAdjust(r, context, context.selected));
      layer("strategy", "Strategy", (r) => this.strategyFit(r, context));
      layer("known_team", "Found in a tournament team", (r) => this.knownTeamFit(r, context));
      // V511 stage one, after every layer above it (Auto Build keeps the old weights).
      if (!auto && this.suggestionScoring) layer("scoring_v511", "Speed plan", (r) => this.rescoreStageOne(r, context));
      row.score_ledger = ledger;
      row.score_uncapped = r1(ledger.reduce((sum, item) => sum + (item.value ?? item.raw ?? item.delta ?? 0), 0));
      if (auto) {
        // V462: Prioritize Meta Pokemon marks the Top-X meta.
        if (context.metaKeys) {
          const member = [m.name, m.base_name, m._v124_base_species].some((v) => v && context.metaKeys.has(compact(v)));
          row.prioritized_meta_member_v462 = member;
          row.meta_priority_component_v462 = member ? 100 : 0;
        }
        this.v472Metrics(row, context);
        // V477: a chosen archetype measures what the completed team would still miss.
        if (context.archetype?.key) context.archetype.metrics(row, context);
      }
      return row;
    };
    let row = inner(meta);
    if (auto) {
      // V482: Auto Build takes the first set whose item no untouched teammate holds.
      if (row && this.obeysItemClause(row, context)) {
        row.item_clause_valid_v482 = true;
      } else {
        const alternatives = this.nonconflictingSets(meta, context);
        if (!alternatives.length) return null;
        const set = alternatives[0];
        let candidate = inner(this.metaWithSet(structuredClone(meta), set));
        if (!candidate || !this.obeysItemClause(candidate, context)) return null;
        candidate = this.applySetFields(candidate, set);
        candidate.item_clause_valid_v482 = true;
        row = candidate;
      }
    }
    if (!row) return null;
    // V494: a Mega Stone candidate is named as its Mega.
    const species = String(meta.base_name || meta.pokemon || meta.name || "");
    const [form, ability] = this.megaIdentity(this.ev.baseSpeciesFromDisplay(species), row.item, row.ability);
    if (form) {
      row.form = form;
      row.mega_form_v494 = form;
      if (compact(row.name) === compact(species)) {
        row.name = form;
        if (row.action.toLowerCase().startsWith("add ")) row.action = `Add ${form}`;
      }
      if (ability) row.ability = ability;
    }
    return auto ? this.autoBuildFilters(row, context) : row;
  }

  // --- the Auto Build layers --------------------------------------------------------

  /** V432: with an Auto Build archetype, archetype coverage gained or lost weighs heavily. */
  v432(row) {
    const before = this.archetypeRow(row._before_check_rows);
    const after = this.archetypeRow(row._after_check_rows);
    if (!before || !after) return row;
    const [beforeCov, beforeReq] = this.archetypeCoverage(before);
    const [afterCov, afterReq] = this.archetypeCoverage(after);
    const gain = afterCov - beforeCov;
    let fixed = 0;
    let worsened = 0;
    for (const k of new Set([...beforeReq.keys(), ...afterReq.keys()])) {
      const old = beforeReq.get(k) || {};
      const now = afterReq.get(k) || {};
      const critical = Boolean((Object.keys(now).length ? now : old).critical);
      if (critical && !old.met && now.met) fixed += 1;
      if (critical && old.met && !now.met) worsened += 1;
    }
    let adjustment = gain * 105 + fixed * 14 - worsened * 22;
    if (beforeCov < 0.999 && gain <= 0.001) adjustment -= 24;
    row._raw_adjust = adjustment;
    row.score = r1(clamp(row.score + adjustment));
    row.total_component = row.score;
    row.auto_build_archetype_priority_v432 = r1(adjustment);
    return row;
  }

  /** V472 (+ V451's Auto Build sort key): the enabled checks still failing after the addition. */
  v472Metrics(row, context) {
    const before = this.checkMetrics(row._before_check_rows, context.selected);
    const after = this.checkMetrics(row._after_check_rows, context.selected);
    const gain = before.total - after.total;
    row._auto_build_check_priority_v433 = true;
    row._auto_build_check_sort_v433 = [after.red, Number(pyFixed(after.total, 5)), after.yellow, -Number(pyFixed(gain, 5))];
    const mega = after.rows.get("mega");
    const active = (context.payloadTeam || context.teamEntries).filter((e) => e && String(e.pokemon || "").trim()).length;
    row._auto_build_v472 = true;
    row._hard_red_checks_v472 = after.red;
    row._hard_yellow_checks_v472 = after.yellow;
    row._hard_check_pressure_v472 = after.total;
    row._mega_red_v472 = mega && severityOf(mega) === "red" ? 1 : 0;
    row._last_empty_slot_v472 = TEAM_SIZE - active <= 1;
    row._manual_archetype_v472 = context.archetype?.key || "";
    row._manual_archetype_fit_v472 = Number(row.archetype_component_v429 ?? 50);
    return row;
  }

  /** _v472_force_final_mega_meta: on the last open slot of a team with no Mega, a stone holder carries it. */
  forceFinalMegaMeta(meta, context) {
    const team = context.teamSlots;
    if (TEAM_SIZE - team.length > 1 || this.checks.megaCount(team)[0] > 0) return meta;
    const stone = this.megaItemForCandidate(meta);
    if (!stone) return meta;
    const forced = structuredClone(meta);
    const fieldEntries = context.fieldEntries || context.teamEntries;
    let set = forced._candidate_set_v113 ? structuredClone(forced._candidate_set_v113) : this.commonCandidateSet(forced, fieldEntries);
    Object.assign(set, { item: stone, rank: 1, evaluated_count: 1, total_sets: 1 });
    // The stone brings the Mega's Ability, which may turn on a guaranteed move's weather.
    set = this.guaranteeSet(String(meta.name || ""), set, fieldEntries, set.archetype_anchor_v494 ? [set.archetype_anchor_v494] : []);
    Object.assign(forced, { _candidate_set_v113: set, top_item: stone, top_items: [stone], forced_mega_for_last_slot_v472: true });
    return forced;
  }

  /** _v472_mega_item_for_candidate: a real stone for this species, never a suffix guess. */
  megaItemForCandidate(meta) {
    const base = String(meta.base_name || meta.pokemon || meta.pokemon_name || meta.name || "").trim();
    if (!base) return "";
    const values = [meta._candidate_set_v113?.item, meta.top_item, ...(meta._v124_strict_top_items || []), ...(meta.top_items || []), this.common(base).item];
    for (const value of values) {
      const item = String(value || "").trim();
      if (item && this.ev.engine.isMegaStone(item) && this.ev.isMegaItemForSpecies(base, item)) return item;
    }
    return "";
  }

  /** The hard filters Auto Build puts round the evaluator, innermost first. */
  autoBuildFilters(row, context) {
    const projected = this.projectedSlots(context, row);
    const full = projected.length >= TEAM_SIZE;
    // team_build_constraints: at most two attacking types without a switch-in.
    const profiles = this.checks.profiles(projected);
    const defensive = this.checks.checkDefensiveSwitchIns(profiles);
    const count = new Set((defensive.type_rows_v251 || []).filter((r) => ["yellow", "red"].includes(r.severity)).map((r) => r.type)).size;
    row.defensive_switch_warning_count = count;
    if (!full) return row;
    const synergyProfiles = projected.map(({ entry, mon }) => this.synergy.profile(entry, mon));
    // The app rejects a finished team on any rule below. Here a candidate that breaks
    // one is only marked, and Auto Build falls back to it when no candidate keeps them
    // all: the build's own earlier picks can make that impossible (a forced Pelipper on a
    // Grassy Surge team, two forced Ice types), and the app then stops with no team.
    const misses = [];
    if (count > MAX_DEFENSIVE_WARNINGS) {
      misses.push(`${count} attacking types without a switch-in`);
      row._finish_over_cap = count;
    }
    // team_strategy: a finished team does not carry a Trick Room it cannot use - unless
    // Trick Room is the archetype the team was asked to be.
    if (context.archetype?.key !== "trick room" || context.strictFinishFilters) {
      if (roomPlan(synergyProfiles, this.synergy.metaSpeedRows()).redundant) misses.push("a Trick Room it cannot use");
    }
    // field_synergy: nor a terrain that misses half of it.
    if (this.terrainReach(projected).excess) misses.push("a terrain that misses half of it");
    if (!misses.length) return row;
    if (context.strictFinishFilters) return null;
    row._finish_filter_misses = misses;
    return row;
  }

  /** _v480_nonconflicting_candidate_sets: the V449 sets whose item no untouched teammate holds. */
  nonconflictingSets(meta, context) {
    const used = new Set();
    const replace = context.emptySlot === null ? this.entryIndexForSwap(context.teamEntries, context.swapTarget) : null;
    context.teamEntries.forEach((entry, i) => {
      if (i === replace || !String(entry.pokemon || "").trim()) return;
      const k = compact(entry.item);
      if (k) used.add(k);
    });
    const clean = { ...meta };
    delete clean._candidate_set_v113;
    return this.v449Sets(clean, context).filter((set) => !used.has(compact(set.item)));
  }

  /** _v449_meta_with_set (_v123_meta_with_forced_set) */
  metaWithSet(meta, set) {
    const forced = { ...set, rank: 1, evaluated_count: 1, total_sets: 1, _common_gate_v123: true };
    const out = { ...meta, _candidate_set_v113: forced };
    if (forced.item) Object.assign(out, { top_item: forced.item, top_items: [forced.item] });
    if (forced.moves?.length) out.moves = forced.moves.slice(0, 4);
    if (forced.ability) out.ability = forced.ability;
    out._candidate_set_v113 = structuredClone(set);
    return out;
  }

  /** _v449_apply_set_fields (_v113_apply_set_fields_to_row) */
  applySetFields(row, set) {
    row._candidate_set_v113 = structuredClone(set);
    row._candidate_sets_evaluated_v113 = Number(set.evaluated_count || set.total_sets || 1);
    if (set.item !== undefined && set.item !== null) row.item = String(set.item || row.item || "");
    if (set.ability !== undefined && set.ability !== null) row.ability = String(set.ability || row.ability || "");
    const moves = (set.moves || []).map((m) => String(m).trim()).filter(Boolean);
    if (moves.length) row.moves = moves.slice(0, 4);
    if (set.spread && Object.keys(set.spread).length) {
      row.candidate_spread = set.spread;
      row.spread_label = String(set.spread.nature_name || "Suggested stats");
    }
    const entry = this.candidateEntry({ ...(row._candidate_meta_v378 || {}), name: row.name, form: row.form || row.name }, { item: row.item, ability: row.ability, moves: row.moves });
    row.candidate_entry = entry;
    row.item = entry.item;
    row.ability = entry.ability;
    row.moves = entry.moves.slice(0, 4);
    return row;
  }

  // --- candidate sets (_v449 / _v113 and their guards) ---------------------------------

  /** _v94_move_bucket, as the app exports it: [type, category, power]. */
  moveBucket(move) {
    return this.ev.engine.moveRecord(move)?.analysis?.bucket || ["Normal", "", 0];
  }

  isAttack(move) {
    return ["physical", "special"].includes(String(this.moveBucket(move)[1] || "").toLowerCase());
  }

  /** The V494 guard round a move-package builder: no move whose condition the team cannot set. */
  guardedPackages(builder, name, meta, common, limit, fieldEntries) {
    const have = this.fieldSupport(fieldEntries, [common.ability, ...(meta.top_abilities || []).slice(0, 4)]);
    const blocked = new Set(Object.entries(MOVES_NEEDING_SUPPORT).filter(([, need]) => !have.has(need)).map(([m]) => m));
    if (!blocked.size) return builder(name, meta, common, limit);
    const without = (list) => (list || []).filter((m) => !blocked.has(compact(m)));
    const packages = builder(name, { ...meta, moves: without(meta.moves) }, { ...common, moves: without(common.moves) }, limit);
    const pool = [];
    for (const pkg of packages) for (const m of without(pkg)) if (!pool.some((x) => compact(x) === compact(m))) pool.push(m);
    const cleaned = [];
    const seen = new Set();
    for (const pkg of packages) {
      const kept = without(pkg);
      for (const m of pool) {
        if (kept.length >= 4) break;
        if (!kept.some((x) => compact(x) === compact(m))) kept.push(m);
      }
      const signature = kept.map(compact).join(",");
      if (kept.length && !seen.has(signature)) {
        seen.add(signature);
        cleaned.push(kept.slice(0, 4));
      }
    }
    return cleaned.length ? cleaned : packages;
  }

  /** _v113_move_packages: the common four, damage-first, type-diverse, then rotations. */
  v113MovePackages(name, meta, common, limit) {
    let base = uniqueNames([...(common.moves || []), ...(meta.moves || []), ...this.usage(name, "move", 8)], 10);
    if (!base.length) base = uniqueNames(this.ev.commonMoves(this.usageName(name), [], 6), 6);
    const packages = [];
    const seen = new Set();
    const add = (moves) => {
      let pkg = uniqueNames(moves, 4);
      if (pkg.length < 4) pkg = uniqueNames([...pkg, ...base], 4);
      const k = pkg.map(compact).join(",");
      if (pkg.length && !seen.has(k)) {
        seen.add(k);
        packages.push(pkg.slice(0, 4));
        return true;
      }
      return false;
    };
    add(base.slice(0, 4));
    const damaging = base.filter((m) => this.isAttack(m));
    const utility = base.filter((m) => !this.isAttack(m));
    add([...damaging.slice(0, 4), ...utility.slice(0, 1)]);
    const diverse = [];
    const types = new Set();
    for (const move of base) {
      if (!this.isAttack(move)) continue;
      const k = compact(this.moveBucket(move)[0]);
      if (k && !types.has(k)) {
        types.add(k);
        diverse.push(move);
      }
    }
    add([...diverse, ...base]);
    while (packages.length < Math.max(1, limit)) {
      if (!add([...base.slice(packages.length), ...base.slice(0, packages.length)])) break;
      if (packages.length >= base.length || !base.length) break;
    }
    const out = packages.slice(0, limit);
    return out.length ? out : [base.slice(0, 4)];
  }

  /** _v449_move_packages: every move the calc pool admits appears in some package. */
  v449MovePackages(name, meta, common, moveLimit, fieldEntries) {
    let pool = uniqueNames([...(common.moves || []), ...(meta.moves || []), ...this.usage(name, "move", moveLimit)], moveLimit);
    if (!pool.length) pool = uniqueNames(this.ev.commonMoves(this.usageName(name), [], moveLimit), moveLimit);
    if (!pool.length) return [[]];
    const packages = [];
    const seen = new Set();
    const add = (values) => {
      let pkg = uniqueNames(values, 4);
      if (pkg.length < 4) pkg = uniqueNames([...pkg, ...pool], 4);
      if (!pkg.length) return;
      const k = pkg.map(compact).join(",");
      if (seen.has(k)) return;
      seen.add(k);
      packages.push(pkg.slice(0, 4));
    };
    const basePackage = pool.slice(0, 4);
    add(basePackage);
    const moveMeta = { ...meta, moves: [...pool] };
    for (const pkg of this.guardedPackages((n, m, c, l) => this.v113MovePackages(n, m, c, l), name, moveMeta, common, Math.max(3, moveLimit), fieldEntries)) add(pkg);
    pool.forEach((move, index) => {
      if (packages.some((pkg) => pkg.some((x) => compact(x) === compact(move)))) return;
      const pkg = [...basePackage];
      if (pkg.length < 4) pkg.push(move);
      else pkg[Math.max(0, Math.min(pkg.length - 1, 3 - (index % 2)))] = move;
      add(pkg);
    });
    return packages.length ? packages : [basePackage];
  }

  /**
   * The common set's Nature with the Stat Points it goes with: the first spread every
   * candidate set is built on. The usage file's common set reads the top Nature and the top
   * Stat Points off two separate lists, so on a Pokemon whose most used Nature is not the
   * one its most used distribution was built for that pair contradicts itself
   * (builder/nature-spreads.js). With the rule off it stays as the file has it.
   */
  commonSpread(name, common) {
    const nature = String(common.nature_name || "Serious").trim() || "Serious";
    const bonuses = [...(common.bonuses || [0, 0, 0, 0, 0, 0])];
    if (!this.pairedSpreads) return { name: nature, nature_name: nature, bonuses, rank: 1 };
    const points = this.ev.record(this.usageName(name))?.spreads || [];
    const point = spreadPointsForNature(points, this.ev.engine.natures?.[nature] || ["", ""]);
    return { name: nature, nature_name: nature, bonuses: [...(point?.[1] || bonuses)], rank: 1 };
  }

  /** _v113_spread_options: the common spread, then the recorded nature / Stat Point pairs. */
  spreadOptions(name, common, limit) {
    const fallback = this.commonSpread(name, common);
    const spreads = [fallback, ...this.ev.commonSpreads(this.usageName(name), limit, this.pairedSpreads)];
    const out = [];
    const seen = new Set();
    for (const spread of spreads) {
      const nature = String(spread.nature_name || spread.name || "Serious");
      const bonuses = [...(spread.bonuses || [0, 0, 0, 0, 0, 0])];
      const k = `${nature.toLowerCase()}:${bonuses.join(",")}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...spread, nature_name: nature, bonuses });
      if (out.length >= limit) break;
    }
    return out.length ? out : [fallback];
  }

  /** _v449_candidate_sets: a bounded beam, one axis at a time, then an aligned combination. */
  v449Beam(meta, fieldEntries) {
    const name = String(meta.name || meta.form || meta.pokemon || "").trim();
    if (!name) return [];
    const s = this.ev.settings;
    const itemLimit = Math.max(1, Math.min(5, Number.parseInt(s.calc_item_limit, 10) || 3));
    const moveLimit = Math.max(1, Math.min(10, Number.parseInt(s.calc_move_limit, 10) || 6));
    const common = this.common(name);
    let items = uniqueNames(meta._v124_strict_top_items || [], itemLimit);
    if (!items.length) items = uniqueNames([common.item, meta.top_item, ...(meta.top_items || []), ...this.usage(name, "held_item", itemLimit)], itemLimit);
    if (!items.length) items = [String(common.item || meta.top_item || "")];
    if (s.use_held_items === false) items = items.slice(0, 1);
    let abilities = uniqueNames([common.ability, ...(meta.top_abilities || []), ...this.usage(name, "ability", 3)], 3);
    if (!abilities.length) abilities = [String(meta.ability || "")];
    if (s.use_other_abilities === false && s.use_weather_abilities === false) abilities = abilities.slice(0, 1);
    let packages = this.guardedPackages((n, m, c, l) => this.v449MovePackages(n, m, c, l, fieldEntries), name, meta, common, moveLimit, fieldEntries);
    let spreads = this.spreadOptions(name, common, 3);
    if (!items.length) items = [""];
    if (!abilities.length) abilities = [""];
    if (!packages.length) packages = [(common.moves || []).slice(0, 4)];
    if (!spreads.length) spreads = [{}];
    const sets = [];
    const seen = new Set();
    const add = (item, ability, moves, spread, source) => {
      const set = { item: String(item || ""), ability: String(ability || ""), moves: uniqueNames(moves, 4), spread: structuredClone(spread || {}), source_v449: source };
      const k = [compact(set.item), compact(set.ability), set.moves.map(compact).join(","), String(set.spread.nature_name || set.spread.name || "").toLowerCase(), (set.spread.bonuses || []).join(",")].join("|");
      if (seen.has(k)) return;
      seen.add(k);
      sets.push(set);
    };
    add(items[0], abilities[0], packages[0], spreads[0], "most-common");
    for (const item of items.slice(1)) add(item, abilities[0], packages[0], spreads[0], "item-alternative");
    for (const ability of abilities.slice(1)) add(items[0], ability, packages[0], spreads[0], "ability-alternative");
    for (const pkg of packages.slice(1)) add(items[0], abilities[0], pkg, spreads[0], "move-package");
    for (const spread of spreads.slice(1)) add(items[0], abilities[0], packages[0], spread, "stat-distribution");
    const aligned = Math.max(items.length, abilities.length, packages.length, spreads.length);
    const at = (list, i) => list[Math.min(i, list.length - 1)];
    for (let i = 1; i < aligned; i += 1) {
      add(at(items, i), at(abilities, i), at(packages, i), at(spreads, i), "combined-alternative");
      if (sets.length >= MAX_STRUCTURAL_SETS) break;
    }
    const out = sets.slice(0, MAX_STRUCTURAL_SETS);
    out.forEach((set, i) => Object.assign(set, { rank: i + 1, evaluated_count: out.length, total_sets: out.length }));
    return out;
  }

  /** _v450_normalize_spread: the candidate's spread, completed from the species' common one. */
  normalizeSpread(species, spread) {
    const candidate = { ...(spread || {}) };
    const common = this.common(species);
    const nature = String(candidate.nature_name || candidate.name || common.nature_name || "Serious").trim() || "Serious";
    const bonuses = Array.isArray(candidate.bonuses) && candidate.bonuses.length >= 6 ? candidate.bonuses.slice(0, 6) : [...(common.bonuses || [0, 0, 0, 0, 0, 0])];
    const pair = candidate.nature || this.ev.engine.natures?.[nature] || ["", ""];
    return { name: common.nature_name || "Serious", nature_name: common.nature_name || "Serious", bonuses: [...(common.bonuses || [0, 0, 0, 0, 0, 0])], ...candidate, name: nature, nature_name: nature, nature: [...pair].slice(0, 2), bonuses: bonuses.map((v) => Math.max(0, Math.min(32, Number.parseInt(v, 10) || 0))) };
  }

  /** _v450_base_species_for_candidate */
  baseSpeciesForCandidate(meta) {
    const explicit = String(meta._v124_base_species || meta.base_name || meta.pokemon_name || "").trim();
    const name = String(meta.name || meta.form || "").trim();
    const isMega = Boolean(meta._v124_is_mega) || /(^|[^a-z0-9])mega([^a-z0-9]|$)/.test(name.toLowerCase());
    if (isMega && explicit) return explicit;
    if (isMega) return this.ev.baseSpeciesFromDisplay(name) || explicit || name;
    return explicit || name;
  }

  /** _v449_candidate_sets as the runtime holds it: field guard(V483 Trick Room natures(V450 Mega usage(V449 beam))). */
  v449Sets(meta, context) {
    const fieldEntries = context.fieldEntries || context.teamEntries;
    const name = String(meta.name || "").trim();
    const base = this.baseSpeciesForCandidate(meta);
    const isMega = Boolean(meta._v124_is_mega) || /(^|[^a-z0-9])mega([^a-z0-9]|$)/.test(name.toLowerCase());
    const generation = isMega && base ? { ...meta, name: base, pokemon_name: base, base_name: base } : { ...meta };
    const species = base || name;
    let sets = this.v449Beam(generation, fieldEntries).map((set) => ({
      ...set, spread: this.normalizeSpread(species, set.spread), ...(isMega ? { base_species_v450: species, mega_candidate_v450: true } : {}),
    }));
    sets = this.trickRoomNatures(sets, meta, context);
    // V494: the archetype's defining move is offered to every candidate that can learn it.
    if (context.anchorArchetype) sets = context.anchorArchetype.candidateSets(sets, meta, fieldEntries);
    return this.guardSets(name, sets, fieldEntries);
  }

  /** _v113_candidate_sets as the runtime holds it (the set refinement enumerates these). */
  v113Sets(meta, limit, context) {
    const fieldEntries = context.fieldEntries || context.teamEntries;
    const name = String(meta.name || "").trim();
    if (!name) return [];
    const common = this.common(name);
    let items = uniqueNames([common.item, meta.top_item, ...(meta.top_items || []), ...this.usage(name, "held_item", 3)], 3);
    let abilities = uniqueNames([common.ability, ...this.usage(name, "ability", 3)], 3);
    const packages = this.guardedPackages((n, m, c, l) => this.v113MovePackages(n, m, c, l), name, meta, common, limit, fieldEntries);
    const spreads = this.spreadOptions(name, common, limit);
    if (!items.length) items = [""];
    if (!abilities.length) abilities = [String(this.ev.commonMon(this.usageName(name), this.usageName(name)).ability || "")];
    const out = [];
    const seen = new Set();
    const at = (list, i) => (list.length ? list[Math.min(i, list.length - 1)] : undefined);
    for (let i = 0; i < Math.max(1, limit); i += 1) {
      const spread = at(spreads, i) || {};
      const moves = at(packages, i) || [];
      const item = at(items, i) || "";
      const ability = at(abilities, i) || "";
      const k = [compact(item), compact(ability), String(spread.nature_name || ""), (spread.bonuses || []).join(","), moves.map(compact).join(",")].join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ rank: i + 1, item, ability, moves: moves.slice(0, 4), spread, total_sets: Math.max(1, limit) });
    }
    return this.guardSets(name, out.slice(0, limit), fieldEntries);
  }

  /** V483: a Trick Room context puts a Speed-reducing nature variant of the first sets first. */
  trickRoomNatures(sets, meta, context) {
    if (!sets.length || !this.trickRoomContext(meta, context)) return sets;
    const signature = (set) => [compact(set.item), compact(set.ability), (set.moves || []).map(compact).join(","), String(set.spread?.nature_name || set.spread?.name || "").toLowerCase(), (set.spread?.bonuses || []).join(",")].join("|");
    const existing = new Set(sets.map(signature));
    const variants = [];
    for (const set of sets.slice(0, 3)) {
      const spread = set.spread || {};
      const current = String(spread.nature_name || spread.name || "").trim();
      const [, reduced] = this.ev.engine.natures?.[current] || ["", ""];
      if (String(reduced || "").toUpperCase() === "SPE") continue;
      const nature = speedReducingNature(spread, this.ev.engine.natures || {});
      const variant = { ...structuredClone(set), spread: { ...structuredClone(spread), name: nature, nature_name: nature, nature: [...(this.ev.engine.natures?.[nature] || ["", "SPE"])], trick_room_speed_nature_v483: true }, source_v449: "trick-room-speed-nature", trick_room_nature_bias_v483: true };
      const k = signature(variant);
      if (existing.has(k)) continue;
      existing.add(k);
      variants.push(variant);
      if (variants.length >= 2) break;
    }
    if (!variants.length) return sets;
    const merged = [...variants, ...sets].slice(0, MAX_STRUCTURAL_SETS);
    merged.forEach((set, i) => Object.assign(set, { rank: i + 1, evaluated_count: merged.length, total_sets: merged.length }));
    return merged;
  }

  /** _v483_trick_room_context */
  trickRoomContext(meta, context) {
    const norm = (v) => String(v || "").replace(/[_-]/g, " ").trim().toLowerCase().split(/\s+/).join(" ");
    if ([context.archetypeKey, context.resolvedArchetype].some((v) => norm(v) === "trick room")) return true;
    const team = context.fieldEntries || context.teamEntries;
    if (team.some((entry) => (entry.moves || []).some((m) => String(m || "").trim().toLowerCase() === "trick room"))) return true;
    for (const source of [meta.moves, meta.top_moves, meta._candidate_set_v113?.moves]) {
      if ((source || []).some((m) => String(m || "").trim().toLowerCase() === "trick room")) return true;
    }
    return false;
  }

  /** field_synergy's guard round a set builder: stand-ins for blocked items, then the per-set repair. */
  guardSets(name, sets, fieldEntries) {
    if (!name) return sets;
    const available = this.fieldSupport(fieldEntries);
    const types = this.ev.engine.pokemon(this.usageName(name), this.usageName(name))?.types || [];
    const grounded = (ability, item, setTypes) => !(setTypes || types).some((t) => compact(t) === "flying") && compact(ability) !== "levitate" && compact(item) !== "airballoon";
    const blockedItems = (have, isGrounded) => {
      const out = new Set(Object.entries(ITEM_SUPPORT).filter(([, need]) => !have.has(need)).map(([k]) => k));
      if (!isGrounded) for (const [k, need] of Object.entries(ITEM_SUPPORT)) if (TERRAIN_CONDITIONS.includes(need) || need === "terrain") out.add(k);
      return out;
    };
    const itemMap = new Map();
    const offered = [];
    for (const set of sets) {
      const held = String(set.item || "");
      const setTypes = this.ev.engine.pokemon(this.usageName(name), set.form || this.usageName(name))?.types || types;
      if (held && blockedItems(available, grounded(set.ability, held, setTypes)).has(compact(held)) && !offered.includes(compact(held))) offered.push(compact(held));
    }
    if (offered.length) {
      const blockedAll = blockedItems(available, true);
      const standIns = [];
      for (const option of this.usage(name, "held_item", 12)) {
        if (blockedAll.has(compact(option)) || standIns.some((x) => compact(x) === compact(option))) continue;
        standIns.push(option);
        if (standIns.length >= Math.max(1, offered.length)) break;
      }
      offered.forEach((k, i) => {
        if (standIns.length) itemMap.set(k, standIns[Math.min(i, standIns.length - 1)]);
      });
    }
    const repaired = sets.map((set) => this.repairSetFields(name, set, fieldEntries, itemMap));
    return this.guaranteeSets(name, repaired, fieldEntries);
  }

  /**
   * Guaranteed moves on every set of a candidate list (the archetype's anchor move stays
   * where it was offered); sets that become the same are kept once and renumbered.
   */
  guaranteeSets(name, sets, fieldEntries) {
    if (!(this.guaranteedShare > 0) || !sets.length) return sets;
    let changed = false;
    const out = [];
    const seen = new Set();
    for (const set of sets) {
      const next = this.guaranteeSet(name, set, fieldEntries, set.archetype_anchor_v494 ? [set.archetype_anchor_v494] : []);
      if (next !== set) changed = true;
      const k = [compact(next.item), compact(next.ability), (next.moves || []).map(compact).join(","), String(next.spread?.nature_name || next.spread?.name || "").toLowerCase(), (next.spread?.bonuses || []).join(",")].join("|");
      if (seen.has(k)) {
        changed = true;
        continue;
      }
      seen.add(k);
      out.push(next);
    }
    if (!changed) return sets;
    return out.map((set, i) => (set.rank !== undefined ? { ...set, rank: i + 1, evaluated_count: out.length, total_sets: out.length } : set));
  }

  /** _v476_three_worst_targets: the members the failing checks point at, up to three. */
  swapTargets(context) {
    const problems = (context.payload.checks?.rows || []).filter((r) => ["red", "yellow"].includes(String(r.severity || "").toLowerCase()));
    const profiles = context.teamSlots.map(({ entry, mon }) => this.checks.profile(entry, mon));
    let fromChecks = [];
    if (problems.length) {
      const scored = profiles.map((profile, i) => [this.problemSlotScore(profile, problems), i, profile.name]);
      scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
      fromChecks = scored.filter(([score]) => score > 0).slice(0, 3).map(([, , n]) => n);
      if (!fromChecks.length) fromChecks = scored.slice(0, 3).map(([, , n]) => n);
    }
    const values = [...fromChecks, ...context.activeNames.slice(0, 3), ...context.activeNames];
    const out = [];
    const seen = new Set();
    for (const value of values) {
      const text = String(value || "").trim();
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      out.push(text);
      if (out.length >= 3) break;
    }
    return out;
  }

  /** _v202_problem_slot_score: how much a member contributes to the failing checks. */
  problemSlotScore(profile, problems) {
    let score = 0;
    for (const row of problems) {
      const id = rowKey(row);
      const sev = String(row.severity || "yellow").toLowerCase();
      const weight = sev === "red" ? 4 : 2.25;
      const speed = Number(profile.speed) || 0;
      if (id === "speed_control") {
        if (!profile.speed_control) score += weight;
        if (!profile.priority && speed < 110) score += weight * 0.35;
      } else if (id === "protect_positioning") {
        if (!profile.protect && !profile.positioning) score += weight;
        else if (!profile.protect) score += weight * 0.45;
      } else if (id === "spread_damage") {
        if (!profile.spread) score += weight;
      } else if (id === "priority_cleanup") {
        if (!profile.priority && speed < 120) score += weight;
      } else if (id === "physical_damage") {
        if (!profile.physical.length) score += weight;
      } else if (id === "special_damage") {
        if (!profile.special.length) score += weight;
      } else if (id === "utility_disruption") {
        if (!profile.utility.size) score += weight;
      } else if (id === "defensive_switch_ins") {
        const weak = row.weak_counts || {};
        const resist = row.resist_counts || {};
        for (const [type, count] of Object.entries(weak)) {
          const w = Number(count) || 0;
          const r = Number(resist[type]) || 0;
          const problematic = w >= 4 || (w >= 3 && r === 0) || (sev === "yellow" && (w >= 3 || (w >= 2 && r === 0)));
          if (problematic && this.ev.engine.typeMultiplier(type, profile.types) > 1) score += weight * 0.75;
        }
      } else if (id === "field_weather_consistency") {
        const problemText = (row.problems || []).map((x) => String(x).toLowerCase()).join(" ");
        const tokens = [...profile.weather_set, ...profile.weather_use, ...profile.terrain_set];
        if (tokens.length || ["earthquake", "bulldoze", "magnitude"].some((k) => profile.move_keys.has(k))) {
          if (!problemText || [...tokens, "priority", "ground"].some((t) => problemText.includes(t))) score += weight * 0.8;
        }
      }
    }
    return score;
  }

  /**
   * _v307_suggestion_worker: every candidate, ranked.
   * @param {object} payload   the evaluation payload (TeamEvaluation.evaluate)
   * @param {object} options   {selection, onProgress(done, total, name), box, candidates}
   *   box: the Box's sets - only those are tried (the app's "Only Box" scope);
   *   candidates: a ready candidate list in place of the ranked meta.
   */
  run(payload, { selection = null, onProgress, box = null, candidates: given = null } = {}) {
    const teamSlots = (payload.slots || []).map(({ entry, mon }) => ({ entry: { ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }, mon }));
    const teamEntries = teamSlots.map(({ entry }) => entry);
    const activeNames = teamSlots.map(({ entry, mon }) => this.name(mon.form_name || entry.form || entry.pokemon));
    const emptySlot = teamSlots.length < TEAM_SIZE ? teamSlots.length : null;
    const selected = this.checks.selectedIds(selection);
    const context = { payload, teamSlots, teamEntries, activeNames, emptySlot, selection, selected, swapTarget: "" };
    const targets = emptySlot !== null ? [""] : this.swapTargets(context);
    const candidates = given || (box ? boxCandidates(this, box, activeNames) : this.candidates(payload, activeNames));
    const best = new Map();
    candidates.forEach((meta, index) => {
      const rows = [];
      for (const target of targets) {
        const row = this.evaluateCandidate(structuredClone(meta), { ...context, swapTarget: target });
        if (row && row.score > 0) {
          if (emptySlot === null) {
            row.swap_target = target;
            row.action_kind = "swap";
            row.action = `Swap ${target} -> ${row.name || meta.name}`;
          }
          rows.push(row);
        }
      }
      if (rows.length) {
        const pick = this.sorted(rows, { filter: false })[0];
        pick.evaluated_switch_targets_v476 = targets;
        pick.candidate_scan_index_v476 = index + 1;
        best.set(compact(meta.name || meta.form || meta.pokemon), pick);
      }
      onProgress?.(index + 1, candidates.length, meta.name);
    });
    let rows = this.sorted([...best.values()], { teamEntries }).slice(0, ROW_LIMIT);
    // V511: the best 40 of the whole pool are then measured against the team's worst threats
    // with real calcs, and the shown list is cut from that ranking. The shortlist is inside
    // the rule's gate too: with the rule off, the ordering above is the final one.
    if (this.suggestionScoring && rows.length) {
      const pool = [...best.values()].sort((a, b) => b.score - a.score || a.position - b.position
        || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const deep = this.deepRank(pool, payload, rows.length, (done, total, name) => onProgress?.(done, total, name, "measuring"));
      if (deep) rows = deep;
    }
    return { rows, scanned: candidates.length, targets, empty_slot: emptySlot };
  }

  /**
   * The suggestion checked against the full Team Evaluation of the team it would make
   * (display only, never part of the ranking): the four scores before and after, the
   * critical threats whose scores fall or rise (the app's V308 idea) and the critical
   * threats the newcomer really answers in that evaluation, with the calcs.
   * @param {object} row      a suggestion row (candidate_entry, candidate_spread, action_kind, swap_target)
   * @param {Array} sets      the builder's six slots (null = open)
   * @param {object} before   the current team's evaluation payload
   */
  projectedDetail(row, sets, before, { checkSelection = null } = {}) {
    const entry = row?.candidate_entry;
    if (!entry || !String(entry.pokemon || "").trim()) return null;
    const team = Array.from({ length: TEAM_SIZE }, (_, i) => (sets[i] && String(sets[i].species || "").trim() ? sets[i] : null));
    let index = -1;
    if (row.action_kind === "swap" && row.swap_target) {
      const wanted = this.speciesId(row.swap_target);
      index = team.findIndex((set) => set && [set.species, set.form].some((v) => this.speciesId(v) === wanted || compact(this.name(v)) === compact(this.name(row.swap_target))));
      if (index < 0) {
        const filled = team.map((set, i) => (set ? i : -1)).filter((i) => i >= 0);
        index = filled[Number(row.slot_index) || 0] ?? -1;
      }
    } else index = team.findIndex((set) => !set);
    if (index < 0) return null;
    // Item Clause as "Use" applies it (_v482_suggestion_unique_item).
    const used = new Set(team.filter((set, i) => set && i !== index && set.item).map((set) => compact(set.item)));
    let item = String(entry.item || "");
    if (compact(item) && used.has(compact(item))) item = uniqueNames([this.common(entry.pokemon).item, ...this.usage(entry.pokemon, "held_item", 30)], 99).find((o) => !used.has(compact(o))) || "";
    const spread = row.candidate_spread || {};
    team[index] = {
      species: entry.pokemon, form: entry.form || entry.pokemon, item, ability: entry.ability || "", moves: (entry.moves || []).slice(0, 4),
      nature: spread.nature_name || spread.name || "Serious", bonuses: [...(spread.bonuses || [0, 0, 0, 0, 0, 0])],
    };
    const after = this.evaluation.evaluate(team, { checkSelection });
    const scores = (p) => ({ synergy: r1(p.synergy_score), offense: r1(p.offense_score), defense: r1(p.defense_score), speed: r1(p.speed?.score) });
    const threatMap = (p) => new Map((p.threats || []).map((t) => [String(t.name), Number(t.score) || 0]));
    const was = threatMap(before);
    const now = threatMap(after);
    const lowered = [];
    const raised = [];
    for (const [threat, old] of was) {
      const next = now.get(threat);
      if (next === undefined) lowered.push({ threat, before: r1(old), after: null, drop: old });
      else if (next < old - 0.5) lowered.push({ threat, before: r1(old), after: r1(next), drop: old - next });
    }
    for (const [threat, next] of now) {
      const old = was.get(threat);
      if (old === undefined) raised.push({ threat, before: null, after: r1(next), rise: next });
      else if (next > old + 0.5) raised.push({ threat, before: r1(old), after: r1(next), rise: next - old });
    }
    lowered.sort((a, b) => b.drop - a.drop);
    raised.sort((a, b) => b.rise - a.rise);
    // The newcomer's own rows in the new evaluation: where it wins the matchup.
    const position = team.slice(0, index).filter(Boolean).length;
    const slot = (after.slots || [])[position];
    const member = slot ? this.ev.display(slot.mon) : "";
    const answers = [];
    for (const threat of after.threats || []) {
      for (const breakdown of threat.breakdown || []) {
        if (!member || breakdown.team_mon !== member || !this.isRealAnswer(breakdown.incoming_result, breakdown.outgoing_result)) continue;
        answers.push({ threat: String(threat.name), score: r1(threat.score), first: breakdown.first_result || "", incoming: compactResult(breakdown.incoming_result), outgoing: compactResult(breakdown.outgoing_result) });
        break;
      }
    }
    answers.sort((a, b) => b.score - a.score);
    const strip = (list, k) => list.slice(0, 5).map((x) => Object.fromEntries(Object.entries(x).filter(([name]) => name !== k)));
    return {
      member, item_changed: compact(item) !== compact(entry.item) ? item : "",
      scores: { before: scores(before), after: scores(after) },
      critical: { before: (before.threats || []).length, after: (after.threats || []).length },
      lowered: strip(lowered, "drop"), raised: strip(raised, "rise"),
      answers: answers.slice(0, 6),
    };
  }

  /** _v57_sort_suggestions (score, rank, name) then V466 (no speed conflicts first, Speed Control fixes). */
  sorted(rows, { filter = true, teamEntries = [] } = {}) {
    const present = new Set(teamEntries.map((e) => this.speciesId(e.form || e.pokemon)).filter(Boolean));
    const possible = (row) => {
      if (!filter || !present.size) return true;
      const target = String(row.swap_target || "").trim();
      const targetKey = target ? this.speciesId(target) : "";
      if (target && !present.has(targetKey)) return false;
      const candidateKey = this.speciesId(String(row.form || row.name || row.base_name || ""));
      return !(candidateKey && present.has(candidateKey) && candidateKey !== targetKey);
    };
    const first = [...rows].sort((a, b) => b.score - a.score || a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.action < b.action ? -1 : a.action > b.action ? 1 : 0)).slice(0, ROW_LIMIT);
    return first.map((row, i) => [row, i]).sort((x, y) => (x[0].counter_archetype_speed_control_v466 ? 1 : 0) - (y[0].counter_archetype_speed_control_v466 ? 1 : 0) || (y[0].role_fixes_v466 || 0) - (x[0].role_fixes_v466 || 0) || x[1] - y[1]).map(([row]) => this.namedAction(row)).filter(possible);
  }

  /** species_identity: a copy of the row with its action text in Showdown spelling. */
  namedAction(row) {
    let action = row.action;
    for (const raw of [...new Set(["name", "form", "swap_target", "base_name", "pokemon"].map((f) => String(row[f] || "").trim()).filter(Boolean))].sort((a, b) => b.length - a.length)) {
      const shown = this.name(raw);
      if (shown && shown !== raw && action.includes(raw)) action = action.replace(raw, shown);
    }
    return { ...row, action };
  }
}
