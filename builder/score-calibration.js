// Where a Team Evaluation score STANDS, next to where it sits on the 0-100 dial.
//
// THE PROBLEM THIS SOLVES. Measured over 80 teams sampled from the shipped library
// (25 Nov 2026), the four scores occupy about a sixth of 0-100, and their ends are
// structurally unreachable rather than merely unoccupied: Offense tops out near 60 because
// scoring 100 would need every member's two best moves to average 100% damage against all
// 30 meta Pokemon, and Defense tops out there for the mirror reason. So:
//
//   axis      min   p25   med   p75   max      old tone over those 80 teams
//   synergy  46.7  59.7  62.9  65.4  74.0      4 green / 75 amber /  1 red
//   offense  26.0  46.1  50.3  52.3  59.0      0 green / 44 amber / 36 red
//   defense  35.7  44.8  48.1  50.2  58.6      0 green / 20 amber / 60 red
//   speed    47.5  60.6  67.5  71.6  85.9     31 green / 47 amber /  2 red
//
// No real team could ever show a green Offense or Defense, three quarters of real teams were
// shown a red Defense, and Synergy was amber for 94% of them. A score's place on the dial and
// its place among real teams disagreed, and only the dial was shown.
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
  const value = Number(score);
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

/** The compact line under a score card: "75th pct". */
export function percentileLabel(percentile) {
  return Number.isFinite(percentile) ? `${ordinal(percentile)} pct` : "";
}

/**
 * The sentence behind that line. It names the population, the date the table was cut and the
 * range the axis actually covers, because the range is the thing the 0-100 dial hides.
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
  return `${name} ${Math.round(Number(score))} is ${where}.`
    + ` Across those teams ${name} runs ${q[0].toFixed(0)} to ${q[QUANTILES - 1].toFixed(0)}, not 0 to 100.`
    + ` Reference cut ${table.generated || "unknown"}.`;
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
    return { percentile: null, tone: "", label: PARTIAL_LABEL, title: PARTIAL_TITLE };
  }
  const percentile = percentileOf(table, axis, score);
  if (percentile === null) return null;
  return {
    percentile,
    tone: calibratedTone(percentile),
    label: percentileLabel(percentile),
    title: percentileTitle(table, axis, score, percentile),
  };
}
