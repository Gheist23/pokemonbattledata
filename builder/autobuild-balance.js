// Auto Build's objective, BALANCED: a complete team is judged by where its four scores stand
// among real teams, and its weakest standing counts on its own.
//
// THE COMPLAINT. A Deep build handed the owner Mega Dragonite / Manectric / Torterra / Cinderace /
// Sneasler / Milotic, whose tiles read Synergy 16th, Offense 44th, Defense 24th and Speed 97th
// percentile -- "Speed dominates the scores". It was not one unlucky build. On four of five test
// starts the search's chosen team had an axis at or below the 45th percentile (13th, 19th, 22nd,
// 45th), and from an empty team it picked Speed 97th / Defense 22nd / Offense 29th.
//
// THE CAUSE. The search compared complete teams by T = mean(Synergy, Offense, Defense, Speed)
// minus one point per red threat, on the RAW 0-100 scores. The four axes do not spread alike:
// across all 1945 library teams Speed's middle half is 11.4 points wide, Offense's 6.6,
// Synergy's 5.6 and Defense's 4.7 (data/builder/score-anchors.json). An average of numbers with
// unequal spread is not an equal weighting -- one raw point is the 3rd percentile of Speed and
// the 11th of Defense -- so the search was in effect half a Speed optimiser, and it traded
// Synergy and Defense away for Speed whenever it could (the critique measured Speed at 47% of
// the objective's variance and Defense at 9%). The one-swap repair made it worse: from
// Garchomp / Rillaboom / Sylveon it swapped Mega Chandelure for Armarouge on "+1.1", which was
// Speed 73 -> 80 paid for with Synergy 60.5 -> 59.1 and Offense 55.3 -> 53.8, i.e. the Synergy
// standing 31st -> 19th.
//
// THE RULE. Each score becomes its STANDING, the percentile among the library's complete teams
// that the tiles already show (builder/score-calibration.js), read continuously between the
// table's 101 points so two close teams are not tied. Every axis is then uniform on 0-100 across
// real teams, which is what makes "equal weights" true. A team's balance is
//
//     two thirds of the average standing + one third of the weakest standing
//
// and T is that minus BALANCE_OBJECTIVE.redThreatWeight per threat at 70 or more. The weakest
// term is what the owner asked for -- "high on all four, not one" -- and a third is enough for
// it to decide between teams of a similar average (80/80/80/20 loses to 62/62/62/62) without
// letting it refuse a team that is excellent on three axes and fair on the fourth
// (99/99/99/40 still beats 62 across). The tiers ahead of T (red checks, the archetype, the
// Top X, yellow checks) are unchanged.
//
// THE CLIMB. Re-weighting alone is not enough, because the search only ever compared four or
// five teams and they were all built by the same per-slot ranking. So the repair step becomes a
// climb: every member Auto Build added is screened as a swap against the leading team's REAL
// Team Evaluation (the old repair screened against the projected seed, whose threats are the
// meta list of an empty team), the best few per member are run through the real Team Evaluation,
// and the best of those -- finished and evaluated again like every compared team -- replaces
// the leader when it wins on the objective. Then again, from the new team, up to `rounds` times.
// Proxies are the real evaluation, not the Suggestions projection: measured over 72 swaps the
// projected change correlates with the real one at 0.15 (Offense) to 0.53 (Defense), too weak
// to choose by.
//
// MEASURED, Deep, against the old objective and repair on the same five starts: the balance of
// the chosen team rose from a mean of 55.6 to 72.8 and its weakest standing from the 34th to
// the 62nd percentile; the sun start was already balanced and did not move. Cold in Node a Deep
// build of an empty team went from 40 s to 53 s. See tests/run-autobuild-balance.mjs.
//
// AND WHAT IT IS NOT. On the tournament test (each pick playing 60 tournament teams) the five
// picks averaged 55.2 before and 55.0 after: neutral, not better. +5.3 and +3.8 on two starts,
// -9.4 on Garchomp / Rillaboom / Sylveon, whose balanced pick carries a second Mega Stone that
// Team Evaluation scores as a second Mega although only one can Mega Evolve in a game. That is
// the honest limit of this rule: it balances the four numbers the page shows, and Synergy and
// Defense as they are computed today do not predict a game (see BALANCE_OBJECTIVE).
//
// WHERE IT APPLIES. Only to the website's own search (builder/autobuild-search.js). The greedy
// path the recorded vectors replay (`search: "companion"`) is untouched, and so is every score:
// this reads the numbers Team Evaluation produced. It needs the anchor table, which exists for
// Doubles; a format without one (Singles today) keeps the raw-score objective, and the result
// says which it used (`search.objective.basis`). `autobuildBalance: 0` restores the old objective
// and the old repair exactly.

import { AXES, QUANTILES, isAnchorTable } from "./score-calibration.js";

/** The rule version; a recording stamps it as `rules.autobuild_balance`. */
export const AUTOBUILD_BALANCE = 1;

/** The recording key the stamp is filed under. */
export const BALANCE_STAMP = "autobuild_balance";

/** `undefined` keeps the default; 0 / null / false / "off" switch the rule off. */
export function balanceOption(value) {
  if (value === undefined) return AUTOBUILD_BALANCE;
  if (value === null || value === false) return 0;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (!raw) return AUTOBUILD_BALANCE;
    if (["off", "false", "no", "none", "0"].includes(raw)) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : AUTOBUILD_BALANCE;
  }
  return Number(value) > 0 ? Math.trunc(Number(value)) : 0;
}

/** Whether the rule is on for this option value. */
export const balanceOn = (value) => balanceOption(value) > 0;

/**
 * The balanced objective. `margin` is in standing points, the unit T is now in: the anchor (the
 * best pick per slot) keeps its place unless another team is at least this much better. Two
 * points of balance is about half a raw point of Speed or a sixth of a raw point of Defense --
 * the old margin of 1 raw point of the mean was worth about 5 standing points and kept the
 * anchor against teams that were clearly better balanced.
 *
 * `redThreatWeight` is in standing points too, and it is the term that keeps the balance honest.
 * Measured on 120 library teams, each playing 60 tournament teams (the tournament test, the one
 * yardstick none of these numbers see): Offense predicts the result (r 0.30), the count of
 * threats scoring 70+ predicts it more strongly (-0.35) and is mostly an Offense signal itself
 * (-0.66 with the Offense standing), Speed weakly (0.11), and Synergy (0.01) and Defense (-0.04)
 * not at all. So a balance with no threat charge correlates with the yardstick at 0.13, and
 * four points per red threat brings it to 0.26 -- about the weight the old objective's one raw
 * point carried (one raw point of the mean is roughly five standing points). The old objective
 * correlated at 0.35, mostly through that same charge: balancing the four tiles is what was
 * asked for, and the charge is what stops it costing games.
 */
export const BALANCE_OBJECTIVE = Object.freeze({
  basis: "standing", meanWeight: 2 / 3, weakestWeight: 1 / 3, redThreatWeight: 4, margin: 2, redThreat: 70, yellowThreat: 45,
});

/**
 * The climb's size per depth -- counts, not the clock, bound it, so the same input gives the
 * same team on any machine. `pool` candidates are screened per added member and the best
 * `perTarget` of each are run through the real Team Evaluation in the first round; a later round
 * re-tries only the `carry` that came closest. The best `finalists` of a round are finished and
 * evaluated as complete teams, and it stops after `rounds` accepted swaps or the first round
 * that finds none.
 */
//
// Sized by measurement, cold in Node, five starts. Deep at 60/5/8/2 reached a mean balance of
// 72.8 against 69.0 at 40/4/6/2 and 66.8 at 40/3/4/1, for about 14 s of climbing against 11 and
// 9 -- worth it on the depth that exists to be thorough. Medium at 30/3/4/2 found the same four
// teams as at 45/4/6/2, 2-3 s sooner. Fast does not climb: it exists to answer in about ten
// seconds and one round cost it six (11.0 -> 17.2 s); it still compares its teams by balance.
export const BALANCE_CLIMB = Object.freeze({
  fast: null,
  medium: Object.freeze({ rounds: 2, pool: 30, perTarget: 3, carry: 4, finalists: 2 }),
  deep: Object.freeze({ rounds: 3, pool: 60, perTarget: 5, carry: 8, finalists: 2 }),
});

/** Whether `table` can rank teams of this evaluator's format. */
export function anchorsFit(table, format = "Doubles") {
  if (!isAnchorTable(table)) return false;
  return !table.format || String(table.format) === String(format || "Doubles");
}

/**
 * Where `score` stands on `axis`, read CONTINUOUSLY between the table's percentile points: 0
 * below the lowest library team, 100 at or above the highest, and in between the percentile
 * point at or below the score plus how far it is towards the next one -- so its whole part is
 * exactly `percentileOf`, the number on the tile.
 *
 * Not `percentileOf`, which answers the whole percentile a tile shows: as an objective that ties
 * every pair of teams inside one percentile band and makes a 0.1-point gain worth either nothing
 * or a full point depending on where the band edge falls. A flat run in the table (several
 * percentile points with the same score) is skipped to its last point, so the reading never
 * divides by zero and never goes backwards.
 */
export function standingOf(table, axis, score) {
  const q = table?.axes?.[axis];
  if (!Array.isArray(q) || q.length !== QUANTILES) return null;
  const value = typeof score === "number" ? score : (typeof score === "string" && score.trim() !== "" ? Number(score) : NaN);
  if (!Number.isFinite(value)) return null;
  // `<`, not `<=`, so a score equal to the bottom point lands where percentileOf puts it (the
  // last point of a flat run) and the whole part of the two always agrees.
  if (value < q[0]) return 0;
  if (value >= q[QUANTILES - 1]) return 100;
  let low = 0;
  let high = QUANTILES - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (q[mid] <= value) low = mid;
    else high = mid - 1;
  }
  return low + (value - q[low]) / (q[low + 1] - q[low]);
}

/**
 * A team's four standings and its balance, or null without a table (or with a score missing).
 * @param {object} table   an anchor table (data/builder/score-anchors.json)
 * @param {{synergy, offense, defense, speed}} scores  the raw Team Evaluation scores
 */
export function balanceOf(table, scores, objective = BALANCE_OBJECTIVE) {
  if (!isAnchorTable(table) || !scores) return null;
  const standings = {};
  for (const axis of AXES) {
    const standing = standingOf(table, axis, scores[axis]);
    if (standing === null) return null;
    standings[axis] = standing;
  }
  const values = AXES.map((axis) => standings[axis]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const weakest = Math.min(...values);
  const weakestAxis = AXES[values.indexOf(weakest)];
  return { standings, mean, weakest, weakestAxis, value: objective.meanWeight * mean + objective.weakestWeight * weakest };
}

const ORDINALS = { 1: "st", 2: "nd", 3: "rd" };
/** 1 -> "1st", 68 -> "68th": the same words as the tiles. */
export function standingWord(standing) {
  const n = Math.max(0, Math.min(100, Math.floor(Number(standing) || 0)));
  return `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ORDINALS[n % 10] || "th"}`;
}
