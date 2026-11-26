// Where a Team Evaluation score STANDS, next to where it sits on the 0-100 dial.
//
// THE PROBLEM THIS SOLVES. Measured over all 1945 complete library teams the shipped table is
// cut from (26 Nov 2026), the four scores occupy about a sixth of 0-100, and their ends are
// structurally unreachable rather than merely unoccupied: Offense tops out near 60 because
// scoring 100 would need every member's two best moves to average 100% damage against all
// 30 meta Pokemon, and Defense tops out there for the mirror reason. So:
//
//   axis      min   p25   med   p75   max      `scoreTone` across that distribution
//   synergy  30.9  59.8  62.7  65.4  77.7       3% green /  97% amber /   1% red
//   offense  25.6  46.4  50.3  53.0  63.6       0% green /  53% amber /  48% red
//   defense  29.1  45.5  48.1  50.2  61.4       0% green /  27% amber /  74% red
//   speed    33.4  60.6  67.0  72.0  87.9      38% green /  59% amber /   4% red
//
// No real team could ever show a green Offense or Defense, three quarters of them were shown a
// red Defense, and Synergy was amber for 96%. A score's place on the dial and its place among
// real teams disagreed, and only the dial was shown.
//
// Those are the numbers in data/builder/score-anchors.json itself rather than a separate
// measurement -- the shares are over the table's own 101 quantile points, one per percentile of
// the library, which is what tests/run-score-calibration.mjs recomputes. An earlier version of
// this header quoted an 80-team pilot while the shipped table was cut from 240, and then 240
// while it was cut from all 1945; the Companion's installer comment had the same defect in the
// other direction (it quoted THIS codebase's figures as if they were the app's). A comment
// carrying measured numbers from a different population than the file beside it is the one kind
// of staleness nothing can catch, which is why a suite recomputes this table from the JSON.
//
// A SAMPLE NO LONGER. The table was cut from 240 of the library's 1945 complete teams because
// scoring one team takes about two seconds and 1945 of them is an hour. `--jobs` in the
// generator splits the library across processes -- a team's score depends on nothing but that
// team -- so the whole library is a few minutes, and the shipped table is now every complete
// team in it. The quartiles hardly moved (Offense p25 45.9 -> 46.4, p50 50.2 -> 50.3), which is
// what a 240-team sample is good at; the ENDS moved a long way (Synergy's floor 46.7 -> 30.9,
// Speed's 43.0 -> 33.4), because the teams that define them are rare by construction and a
// sample of one team in eight mostly misses them. The bottom of the scale is real now.
//
// What that is worth to a reader, measured rather than assumed: a DISPLAYED percentile moved by
// a median of 1 point between the two tables, 2-3 at the 90th and at most 6. The ends move a
// long way precisely because almost nobody is standing out there to be mis-ranked. Worth having
// -- it costs six minutes -- but it is a sharpening, not a correction.
//
// THE RING SHOWS THE STANDING. A card used to show the score in the ring and the standing in
// small text under it, which is two numbers for one fact with the less useful one drawn big.
// The ring now shows the percentile and says so underneath; the score it came from is in the
// hover, with the range and the date. Where there is no standing -- a partial team, a format
// with no table -- the ring keeps the raw score, so `ring` is null in that case rather than a
// number that would mean something else in the same place.
//
// WHAT THIS IS NOT. It changes no score. `TeamEvaluation.evaluate` is untouched and every
// recorded vector replays unchanged; this module only reads the numbers it is handed. The
// reference distribution lives in data/builder/score-anchors.json, written by
// tools/generate-score-anchors.mjs.
//
// Imported by that generator too, which runs under Node, so nothing here may touch `window`
// or `fetch` at module scope -- see champions-node-check-misses-module-scope for why a
// `node --check` pass is not evidence that it does not.

export const AXES = ["synergy", "offense", "defense", "speed"];

/** Entries in an axis's quantile array: q[0]..q[100], one per percentile point. */
export const QUANTILES = 101;

/** The team size the anchors describe. Below it a percentile would be a lie -- see below. */
export const ANCHOR_TEAM_SIZE = 6;

const ANCHOR_URL = (format) => `/data/builder/score-anchors${format === "Singles" ? "-singles" : ""}.json`;
const cache = new Map();
const settled = new Map();

/**
 * The anchor table for a format, or null when there is none.
 *
 * Resolves to null rather than throwing: a missing or unreadable table must leave the panel
 * showing exactly what it showed before this module existed, never an error.
 */
export async function loadScoreAnchors(format = "Doubles") {
  const url = ANCHOR_URL(format);
  if (!cache.has(url)) {
    const promise = fetch(url, { cache: "no-cache" })
      .then((response) => (response.ok ? response.json() : null))
      .then((table) => (isAnchorTable(table) ? table : null))
      .catch(() => null);
    // A render cannot await a promise, so each one records its own answer on settle and
    // `scoreAnchors` reads that. One object carries both, so there is nothing to keep in step.
    promise.then((table) => { settled.set(url, table); });
    cache.set(url, promise);
  }
  return cache.get(url);
}

/** The table if it is already in hand, else null -- for a synchronous render. */
export function scoreAnchors(format = "Doubles") {
  return settled.get(ANCHOR_URL(format)) ?? null;
}

export function isAnchorTable(table) {
  if (!table || typeof table !== "object" || !table.axes) return false;
  return AXES.every((axis) => Array.isArray(table.axes[axis]) && table.axes[axis].length === QUANTILES);
}

/**
 * The percentile of `score` on `axis`: the highest p whose anchor is at or below the score.
 *
 * 0 means below every sampled library team, 100 means at or above all of them. Returns null
 * when there is no table for the axis, which is the caller's signal to show nothing.
 */
export function percentileOf(table, axis, score) {
  const q = table?.axes?.[axis];
  if (!Array.isArray(q) || q.length !== QUANTILES) return null;
  // NOT `Number(score)`: `Number(null)` and `Number("")` are 0, which is a real score here and
  // would be read as "below every team in the library" -- a card with no score would be given
  // the worst standing there is rather than none, which is the kind of lie this module removes.
  // A numeric string is still accepted: the Companion reads one off a tile when its payload has
  // no number, and the two implementations answer the same question the same way.
  const value = typeof score === "number"
    ? score
    : (typeof score === "string" && score.trim() !== "" ? Number(score) : NaN);
  if (!Number.isFinite(value)) return null;
  if (value < q[0]) return 0;
  let low = 0;
  let high = QUANTILES - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (q[mid] <= value) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * The ring tone for a percentile: the top 30% of real teams gets the best colour, the bottom
 * 30% the worst, and the middle 40% splits at the median.
 *
 * A split CHOSEN rather than inherited, and the same four bands the Companion's
 * `score_calibration_v563` uses, so the two UIs agree about what a colour means even though
 * each keeps its own palette. `scoreTone`'s absolute cuts (>=70, >=50) were a different split
 * on every axis: on Defense "nobody is green and three quarters are red", on Synergy "almost
 * everybody is amber".
 */
export const GOOD_AT = 70;
export const MID_AT = 45;
export const WEAK_AT = 30;

export function calibratedTone(percentile) {
  if (!Number.isFinite(percentile)) return null;
  if (percentile >= GOOD_AT) return "good";
  if (percentile >= MID_AT) return "mid";
  if (percentile >= WEAK_AT) return "orange";
  return "bad";
}

const ORDINALS = { 1: "st", 2: "nd", 3: "rd" };

/** 1 -> "1st", 11 -> "11th", 72 -> "72nd". */
export function ordinal(value) {
  const n = Math.round(Number(value) || 0);
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ORDINALS[n % 10] || "th";
  return `${n}${suffix}`;
}

/** The word under the ring, because the ring's number is the standing and not the score. */
export const RING_NOTE = "percentile";

/**
 * Where the score stands, in one short sentence -- the line a reader actually gets.
 *
 * Deliberately short. What it replaced named the population, the range the axis really covers
 * and the date the table was cut: three sentences of true things, none of which is what anyone
 * wants in the second it takes to read a card. All of it is still one hover away in
 * `percentileTitle`, which is where a number that needs defending belongs.
 */
export function percentileSentence(table, percentile) {
  if (!Number.isFinite(percentile)) return "";
  const teams = Number(table?.teams) || 0;
  const population = `${teams} complete tournament teams`;
  // The ends are named rather than computed: "Better than 0%" and "Better than 100%" are both
  // wrong, the second one twice over, since the top percentile is at-or-above rather than above.
  if (percentile <= 0) return `Below all ${population}.`;
  if (percentile >= 100) return `Above all ${population}.`;
  return `Better than ${percentile}% of ${population}.`;
}

/**
 * The detail behind that sentence, shown on hover: the score the standing was read from, the
 * range the axis really covers, and when and how the table was cut.
 *
 * Hover-only by design, and `top_meta` is in it for a reason -- the table is cut at the default
 * Top-30 meta, while a panel set to another Top-X scored the team against that one instead.
 * Measured over four library teams the gap is under 0.7 of Offense and under 1.2 of Synergy, so
 * it is drift rather than a different measurement, but it is recoverable here instead of
 * nowhere.
 */
export function percentileTitle(table, axis, score, percentile) {
  const q = table?.axes?.[axis];
  if (!Array.isArray(q) || !Number.isFinite(percentile)) return "";
  const name = `${axis[0].toUpperCase()}${axis.slice(1)}`;
  const teams = Number(table.teams) || q.length;
  // "on their most common stat spreads" is not filler: the library records no stat points, so
  // the reference teams are scored on the usual competitive spread for each Pokemon. A team
  // imported from a paste with no EV lines is scored at zero investment and really does sit
  // near the bottom of this distribution -- which the reader should be able to work out.
  const population = `${teams} complete tournament teams from the team library, on their most common stat spreads`;
  const where = percentile <= 0
    ? `below all ${population}`
    : percentile >= 100
      ? `at or above all ${population}`
      : `at the ${ordinal(percentile)} percentile of ${population}`;
  return `${name} scored ${Number(score).toFixed(1)} of 100, ${where}.`
    + ` Across those teams ${name} runs ${q[0].toFixed(0)} to ${q[QUANTILES - 1].toFixed(0)}, not 0 to 100.`
    + ` Reference cut ${table.generated || "unknown"} against the Top ${table.top_meta || "?"} Meta.`;
}

/**
 * Everything a card needs for one axis, or null when no percentile may be shown.
 *
 * `teamSize` is why this takes more than a score. The anchors describe complete sixes, and a
 * partial team is not measured the same way: Offense is a mean over the members present and
 * Defense is 100 minus the meta's pressure into them, so both FALL as slots fill -- one bulky
 * Pokemon alone scores a Defense above every complete team in the library. Showing "99th pct"
 * there would be the same kind of lie this module exists to remove, so a partial team gets no
 * percentile at all.
 */
export const PARTIAL_LABEL = "needs 6";
export const PARTIAL_SENTENCE = "No standing until the team is full.";
export const PARTIAL_TITLE = "No standing is shown until the team is full."
  + " Offense is measured over the Pokémon present and Defense is 100 minus the meta's pressure"
  + " into them, so both FALL as slots fill, and Speed is scaled by the empty slots — a partial"
  + " team's scores are not comparable with a complete team's.";

export function calibrate(table, axis, score, teamSize = ANCHOR_TEAM_SIZE) {
  if (!isAnchorTable(table) || !AXES.includes(axis)) return null;
  // Says "needs 6" rather than nothing, and leaves `tone` unset so the ring keeps its old
  // absolute colour: there is no standing to colour it by yet. Same answer as the Companion's
  // `score_calibration_v563.calibrate`.
  if (Number(teamSize) !== ANCHOR_TEAM_SIZE) {
    return { percentile: null, tone: "", ring: null, note: PARTIAL_LABEL, sentence: PARTIAL_SENTENCE, title: PARTIAL_TITLE };
  }
  const percentile = percentileOf(table, axis, score);
  if (percentile === null) return null;
  return {
    percentile,
    tone: calibratedTone(percentile),
    // The number the ring shows. Null above means "show the raw score instead", so every ring
    // on the page takes its number from one place and nothing has to infer which it is holding.
    ring: percentile,
    note: RING_NOTE,
    sentence: percentileSentence(table, percentile),
    title: percentileTitle(table, axis, score, percentile),
    aria: standingAria(`${axis[0].toUpperCase()}${axis.slice(1)}`, { percentile }, score),
  };
}

/**
 * What a screen reader says for a ring showing a standing: both numbers, each named.
 *
 * Without it the ring is read out as "Offense 23 out of 100", which is the old sentence about a
 * new number -- exactly the misreading this change exists to stop.
 */
export function standingAria(label, calibration, score) {
  if (!calibration || calibration.percentile === null) return "";
  return `${label}: ${ordinal(calibration.percentile)} percentile of real teams, score ${Math.round(Number(score))} out of 100`;
}

// --- what the generator may not write ------------------------------------------------------
// Here rather than in tools/generate-score-anchors.mjs so a suite can import the rule without
// loading the engine, the meta and the library -- the same reason the Companion moved its own
// production guard out of its generator and into `score_calibration_v563`.

/**
 * The smallest sample the anchors may be cut from, and the generator's own floor:
 * `generate-score-anchors.mjs` clamps `--sample` with `Math.max(40, ...)`, so a table built
 * from fewer than this was never asked for, it was salvaged out of a run that mostly failed.
 */
export const MIN_ANCHOR_TEAMS = 40;

/** How much of a sample may fail before what survived is not the library's distribution. */
export const MAX_ANCHOR_FAILURE_SHARE = 0.05;

/**
 * Why this table may not be written, or "" when it may be -- REFUSED, NOT DEFAULTED.
 *
 * The generator's first guard asked only whether every axis produced SOME distribution, and
 * every failure below passes that. `quantiles` will happily build 101 points out of one
 * surviving team, or out of 240 teams that all scored the same, and what comes out has exactly
 * the shape the panel expects, so nothing downstream can tell. The panel would then print
 * "100th pct" under every team on earth and look precisely as authoritative as the real thing.
 *
 * That failure mode is not hypothetical, and the Companion is where it happened: its generator
 * skipped one assignment the live payload path makes, every pair silently lost the Top-Meta
 * interaction, and the whole Synergy column came out six points low -- a plausible table of
 * wrong numbers, which the other three axes reproducing the panel exactly did nothing to
 * reveal. What ports here is not the assignment (this generator calls the full
 * `TeamEvaluation.evaluate`, so it cannot skip it) but the discipline: guard at the point of
 * production, on the OUTPUT, and refuse rather than write something plausible.
 */
export function anchorTableRefusal({ scored = 0, attempted = 0, failed = 0, axes = null } = {}) {
  if (!Number.isFinite(scored) || scored < MIN_ANCHOR_TEAMS) {
    return `only ${scored} team${scored === 1 ? "" : "s"} of ${attempted} scored, under the ${MIN_ANCHOR_TEAMS} this table needs`;
  }
  if (attempted > 0 && failed / attempted > MAX_ANCHOR_FAILURE_SHARE) {
    return `${failed} of ${attempted} teams failed to score, over ${Math.round(MAX_ANCHOR_FAILURE_SHARE * 100)}%, so what is left is not the library's distribution`;
  }
  for (const axis of AXES) {
    const q = axes?.[axis];
    if (!Array.isArray(q) || q.length !== QUANTILES) return `${axis} produced no distribution`;
    if (!q.every((value) => Number.isFinite(value))) return `${axis} has a quantile that is not a number`;
    // Sortedness FIRST, so each refusal gives the reason it really has: a descending array also
    // has q[100] below q[0], and reporting that as "every team scored the same" would send
    // whoever reads the log looking for a scoring bug instead of a sorting one.
    for (let p = 1; p < QUANTILES; p += 1) {
      if (q[p] < q[p - 1]) return `${axis} quantiles are not sorted (q[${p}] ${q[p]} below q[${p - 1}] ${q[p - 1]})`;
    }
    // The degenerate table: every sampled team scored the same, so every percentile is 0 or
    // 100 and the line under the card is noise wearing a measurement's clothes.
    if (!(q[QUANTILES - 1] > q[0])) return `every sampled team scored the same ${axis} (${q[0]}), so a percentile means nothing`;
  }
  return "";
}
