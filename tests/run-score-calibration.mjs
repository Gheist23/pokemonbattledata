// The percentile standing under a Team Evaluation score (builder/score-calibration.js):
//
//   node tests/run-score-calibration.mjs
//
// This module shipped on the website first and had no suite at all, while the Companion's port
// of it ended up with 97 tests -- because porting it is what turned up the defects. Three of
// those four defects CANNOT happen here and this suite says so out loud rather than leaving the
// agreement to luck:
//
//   1. The Companion calibrated the tile's ROUNDED text ("43" for a score of 43.17), which is
//      the 5th percentile against the 12th. Section 7 proves rounding really does move a
//      percentile on the shipped table, and that the call site passes the raw score.
//   2. The Companion's Synergy tile is built as "Total" and retitled afterwards, so a hook on
//      its construction never saw a Synergy tile. Here `scoreButton("Synergy", ...)` carries
//      the label from the start -- section 7 checks all four call sites by name.
//   3. The Companion's anchor generator skipped a handover the live payload path makes and
//      wrote a plausible table that was six points low on one axis. This generator calls the
//      full `TeamEvaluation.evaluate`, so it cannot skip it -- but section 8 tests the refusal
//      that was the real lesson: judge the OUTPUT, and refuse rather than write something
//      plausible.
//
// The fourth was a wording drift between the two codebases, which is why section 5 pins the
// sentence the tooltip says.
//
// WHAT CHANGED AFTER THAT. The table is cut from every one of the library's 1945 complete teams
// rather than 240 of them; the ring draws the STANDING instead of the score; and the panel says
// it in one short sentence instead of three long ones. Each of those is a thing a later edit
// could quietly undo, so section 1 pins the population, section 5 pins the length and section 7
// pins which number reaches the ring.
//
// Nothing here loads the engine, the meta or the library: the module is pure and the shipped
// table is read off disk, so this is a fast suite that can run anywhere.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANCHOR_TEAM_SIZE,
  AXES,
  GOOD_AT,
  MAX_ANCHOR_FAILURE_SHARE,
  MID_AT,
  MIN_ANCHOR_TEAMS,
  PARTIAL_LABEL,
  PARTIAL_SENTENCE,
  PARTIAL_TITLE,
  QUANTILES,
  RING_NOTE,
  WEAK_AT,
  anchorTableRefusal,
  calibrate,
  calibratedTone,
  isAnchorTable,
  loadScoreAnchors,
  ordinal,
  percentileOf,
  percentileSentence,
  percentileTitle,
  scoreAnchors,
  standingAria,
} from "../builder/score-calibration.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const failures = [];
let total = 0;

function check(label, condition, detail = "") {
  total += 1;
  if (!condition) failures.push(`${label}${detail ? `\n    ${detail}` : ""}`);
}

const ANCHOR_FILE = join(root, "data", "builder", "score-anchors.json");
const table = JSON.parse(readFileSync(ANCHOR_FILE, "utf8"));
const source = readFileSync(join(root, "builder", "score-calibration.js"), "utf8");
const page = readFileSync(join(root, "builder", "builder-page.js"), "utf8");
const css = readFileSync(join(root, "builder", "builder.css"), "utf8");

// --- 1. the shipped table ------------------------------------------------------------------
// A table the module rejects is a table the panel silently ignores, which is the one failure
// this feature is allowed to have and the one nobody would notice.

check("the shipped table is one the module accepts", isAnchorTable(table));
check("every axis has one entry per percentile point",
  AXES.every((axis) => table.axes[axis]?.length === QUANTILES),
  AXES.map((axis) => `${axis} ${table.axes[axis]?.length}`).join(", "));
check("every quantile is a finite number",
  AXES.every((axis) => table.axes[axis].every((value) => Number.isFinite(value))));
check("every axis is sorted, so q[p] really is the p-th percentile",
  AXES.every((axis) => table.axes[axis].every((value, i, q) => i === 0 || value >= q[i - 1])));
check("every axis actually spreads, so a percentile distinguishes teams",
  AXES.every((axis) => table.axes[axis][QUANTILES - 1] > table.axes[axis][0]));
check("the table says what it was cut from",
  Number(table.teams) >= MIN_ANCHOR_TEAMS
    && /^\d{4}-\d{2}-\d{2}$/.test(String(table.generated)) && table.format === "Doubles",
  `teams ${table.teams}, library ${table.library}, generated ${table.generated}, format ${table.format}`);
// Not a sample any more, and that is the point: a percentile off this table is a rank among ALL
// the complete teams in the library rather than among one team in eight of them. The 240-team
// sample agreed with the full cut about the quartiles and was far out at the ends, where the
// teams that define the range are rare by construction -- Synergy's floor was 46.7 against the
// real 30.9. If this ever fails because the shipped table was cut with `--sample`, re-cut it
// with the default rather than weakening the check.
check("the shipped table is the whole library, not a sample of it",
  Number(table.teams) === Number(table.library),
  `teams ${table.teams} of library ${table.library} -- run the generator with its default --sample all`);
check("the table is scored against the Top 30, like the panel's default", Number(table.top_meta) === 30,
  `top_meta ${table.top_meta}`);

// A table missing one axis, or one point, is refused whole rather than used in part.
check("a 100-point axis is not a table",
  !isAnchorTable({ ...table, axes: { ...table.axes, speed: table.axes.speed.slice(1) } }));
check("a missing axis is not a table",
  !isAnchorTable({ ...table, axes: { ...table.axes, defense: undefined } }));
check("junk is not a table",
  !isAnchorTable(null) && !isAnchorTable({}) && !isAnchorTable([]) && !isAnchorTable("{}"));

// --- 2. the header documents the table it ships with ---------------------------------------
// The defect this catches has happened in both codebases: score-calibration.js quoted an
// 80-team pilot run while the shipped table was cut from 240, and the Companion's installer
// comment quoted the WEBSITE's figures as if they were the app's. Numbers in a comment are a
// measurement with nothing watching it, so this recomputes them from the file beside it.

const tone = (score) => (score >= 70 ? "good" : score >= 50 ? "mid" : "bad");
const HEADER_ROW = /^\/\/\s+(synergy|offense|defense|speed)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)% green \/\s*(\d+)% amber \/\s*(\d+)% red\s*$/gm;
const documented = new Map();
for (const row of source.matchAll(HEADER_ROW)) {
  documented.set(row[1], { points: row.slice(2, 7), bands: row.slice(7, 10).map(Number) });
}
check("the header's distribution table parses", documented.size === AXES.length,
  `found ${documented.size} of ${AXES.length} rows -- if the header was reformatted, keep the`
  + " columns 'axis min p25 med p75 max  N% green / N% amber / N% red' so this stays checkable");

for (const axis of AXES) {
  const row = documented.get(axis);
  if (!row) continue;
  const q = table.axes[axis];
  const measured = [q[0], q[25], q[50], q[75], q[100]].map((value) => value.toFixed(1));
  check(`the header's ${axis} range is the shipped table's`,
    row.points.join(" ") === measured.join(" "),
    `header ${row.points.join(" ")} / table ${measured.join(" ")}`);
  const counts = { good: 0, mid: 0, bad: 0 };
  for (let p = 0; p < QUANTILES; p += 1) counts[tone(q[p])] += 1;
  check(`the header's ${axis} old-tone shares are the shipped table's`,
    row.bands.join(" ") === [counts.good, counts.mid, counts.bad].join(" "),
    `header ${row.bands.join(" ")} / table ${counts.good} ${counts.mid} ${counts.bad}`);
}

// And the claim the whole feature rests on: the ends of the dial are unreachable.
check("no sampled team reaches a green Offense or Defense under the old thresholds",
  table.axes.offense[QUANTILES - 1] < 70 && table.axes.defense[QUANTILES - 1] < 70,
  `offense max ${table.axes.offense[QUANTILES - 1]}, defense max ${table.axes.defense[QUANTILES - 1]}`);

// --- 3. percentileOf -----------------------------------------------------------------------

check("a score below every sampled team is the 0th percentile",
  percentileOf(table, "offense", table.axes.offense[0] - 1) === 0);
check("the minimum itself is the 0th percentile",
  percentileOf(table, "offense", table.axes.offense[0]) === 0);
check("a score at or above every sampled team is the 100th percentile",
  percentileOf(table, "offense", table.axes.offense[QUANTILES - 1]) === 100
  && percentileOf(table, "offense", 999) === 100);
check("an anchor point reports its own percentile",
  AXES.every((axis) => [1, 17, 50, 83, 99].every((p) => {
    const found = percentileOf(table, axis, table.axes[axis][p]);
    // Ties are honest: several percentile points can hold the same score, and the rule is the
    // HIGHEST p at or below the score, so the answer is >= p and ties to the same value.
    return found >= p && table.axes[axis][found] === table.axes[axis][p];
  })));
check("the percentile never falls as the score rises",
  AXES.every((axis) => {
    let last = -1;
    for (let score = 0; score <= 100; score += 0.25) {
      const found = percentileOf(table, axis, score);
      if (found < last) return false;
      last = found;
    }
    return true;
  }));
check("a score that is not a number has no percentile",
  [NaN, Infinity, null, undefined, "", {}].every((value) => percentileOf(table, "speed", value) === null),
  "null is the signal to show nothing, which is what a missing score must do");
check("a numeric string is still a score",
  percentileOf(table, "speed", String(table.axes.speed[50])) === percentileOf(table, "speed", table.axes.speed[50]),
  "the Companion reads one off a tile when its payload carries no number, and both must agree");
check("a table without the axis has no percentile",
  percentileOf(table, "nonsense", 50) === null && percentileOf(null, "speed", 50) === null
  && percentileOf({ axes: { speed: [1, 2] } }, "speed", 50) === null);

// --- 4. the bands, and the colours they ask for --------------------------------------------
// The same four bands the Companion's `score_calibration_v563` uses, so the two products agree
// about what a colour MEANS even though each keeps its own palette.

check("the bands are the ones both codebases declare",
  GOOD_AT === 70 && MID_AT === 45 && WEAK_AT === 30, `${GOOD_AT}/${MID_AT}/${WEAK_AT}`);
check("the bands switch exactly at their thresholds",
  calibratedTone(70) === "good" && calibratedTone(69) === "mid"
  && calibratedTone(45) === "mid" && calibratedTone(44) === "orange"
  && calibratedTone(30) === "orange" && calibratedTone(29) === "bad");
check("the top and bottom of the range get the best and worst tone",
  calibratedTone(100) === "good" && calibratedTone(0) === "bad");
check("a percentile that is not a number has no tone",
  calibratedTone(null) === null && calibratedTone(NaN) === null);

// A tone with no CSS rule is an uncoloured ring, and `orange` is the one the old three-band
// `scoreTone` never had -- it is 15% of the sampled population on every axis by construction.
const tones = [...new Set([0, 29, 30, 44, 45, 69, 70, 100].map((p) => calibratedTone(p)))];
check("every tone the module can ask for has a ring colour in builder.css",
  tones.every((name) => css.includes(`.bd-ring-${name} `) || css.includes(`.bd-ring-${name}{`)),
  tones.map((name) => `${name}: ${css.includes(`.bd-ring-${name} `) ? "styled" : "MISSING"}`).join(", "));

// --- 5. the words ---------------------------------------------------------------------------

check("ordinals read correctly, including the teens",
  [[1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [11, "11th"], [12, "12th"], [13, "13th"],
    [21, "21st"], [22, "22nd"], [23, "23rd"], [100, "100th"], [101, "101st"], [111, "111th"]]
    .every(([value, want]) => ordinal(value) === want),
  [1, 2, 3, 11, 12, 13, 21, 111].map((v) => ordinal(v)).join(" "));
// The ring holds the percentile, so the word under it has to say that is what it is. Without it
// the card reads "Offense 23" in the same place it used to read "Offense 46".
check("the word under the ring says what the ring is", RING_NOTE === "percentile");

// THE VISIBLE LINE. One sentence, no date, no range, no clause about stat spreads -- all of
// which are still in the hover below. Pinned by length as well as by content, because the way
// this line goes wrong is by growing a clause at a time until it is three sentences again.
const sentence = percentileSentence(table, 23);
check("the visible line is one short sentence",
  sentence === `Better than 23% of ${table.teams} complete tournament teams.`, sentence);
check("the visible line stays short enough to read in a glance",
  sentence.length <= 60 && sentence.split(". ").length === 1, `${sentence.length} chars: ${sentence}`);
check("the visible line carries no date and no range",
  !sentence.includes(String(table.generated)) && !sentence.includes("not 0 to 100"), sentence);
check("the ends of the distribution are not described as a percentage of it",
  percentileSentence(table, 0) === `Below all ${table.teams} complete tournament teams.`
  && percentileSentence(table, 100) === `Above all ${table.teams} complete tournament teams.`,
  "\"Better than 0%\" and \"Better than 100%\" are both wrong, the second one twice over");
check("no percentile means no line",
  percentileSentence(table, null) === "" && percentileSentence(table, NaN) === "");

// WHAT A SCREEN READER GETS. Both numbers, each named. The ring element itself only knows the
// number it was handed, so without this it would be read out as "Offense 23 out of 100".
const spoken = standingAria("Offense", { percentile: 23 }, 46.2);
check("the spoken label names the standing and the score separately",
  spoken === "Offense: 23rd percentile of real teams, score 46 out of 100", spoken);
check("nothing is spoken for a card with no standing",
  standingAria("Offense", { percentile: null }, 46.2) === "" && standingAria("Offense", null, 46.2) === "");

// THE HOVER. Everything the visible line dropped, still reachable, including the Top-X the
// table was cut at: a panel set to another Top-X scored the team against a different meta.
const title = percentileTitle(table, "offense", 52.4, 68);
check("the hover names the axis, the score it came from and the standing",
  title.startsWith("Offense scored 52.4 of 100, at the 68th percentile of"), title);
check("the hover keeps the score unrounded, since that is what was calibrated",
  title.includes("52.4") && !title.includes("Offense scored 52 "), title);
check("the hover names the meta the table was cut against",
  title.includes(`against the Top ${table.top_meta} Meta`), title);
check("the hover names the population the way the Companion's does",
  title.includes(`${table.teams} complete tournament teams from the team library, on their most common stat spreads`),
  // Pinned on purpose. The app and the site must describe the same population in the same
  // words, and a one-sided reword is invisible to every parity suite: both halves stay
  // internally consistent while telling the reader two different things.
  title);
check("the hover gives the range the axis really covers, not 0 to 100",
  title.includes(`Offense runs ${table.axes.offense[0].toFixed(0)} to ${table.axes.offense[QUANTILES - 1].toFixed(0)}, not 0 to 100`),
  title);
check("the hover dates the reference cut, so staleness is still visible somewhere",
  title.includes(`Reference cut ${table.generated}`), title);
check("the ends of the distribution are described as ends",
  percentileTitle(table, "speed", 0, 0).includes("below all")
  && percentileTitle(table, "speed", 99, 100).includes("at or above all"));
check("no hover without a percentile", percentileTitle(table, "speed", 50, null) === "");

// --- 6. a partial team gets no standing ----------------------------------------------------
// The anchors describe complete sixes. Offense is a mean over the members present and Defense
// is 100 minus the meta's pressure into them, so both FALL as slots fill: one bulky Pokemon
// alone scores a Defense above every complete team in the library, and "99th pct" there would
// be the same kind of lie this module exists to remove.

check("the anchors describe a six", ANCHOR_TEAM_SIZE === 6);
for (const size of [0, 1, 2, 3, 4, 5]) {
  const partial = calibrate(table, "defense", 90, size);
  check(`a team of ${size} is told it needs six instead of being given a percentile`,
    partial?.percentile === null && partial?.note === PARTIAL_LABEL && partial?.tone === "",
    JSON.stringify(partial));
  // `ring: null` is what sends the raw score to the ring instead of a standing. A number here
  // would be drawn in the same place a percentile is, meaning something else.
  check(`a team of ${size} puts no number of its own in the ring`, partial?.ring === null,
    JSON.stringify(partial));
}
check("the partial label and sentence are the ones the panel shows",
  PARTIAL_LABEL === "needs 6" && PARTIAL_SENTENCE === "No standing until the team is full."
  && PARTIAL_TITLE.startsWith("No standing is shown until the team is full."));
check("a partial team gets the short sentence too, with the long one on hover",
  PARTIAL_SENTENCE.length < PARTIAL_TITLE.length && PARTIAL_SENTENCE.split(". ").length === 1);
check("a complete team does get a standing",
  calibrate(table, "defense", 90, 6)?.percentile === 100);
check("no table means no standing at all, not a default one",
  calibrate(null, "defense", 50, 6) === null && calibrate({}, "defense", 50, 6) === null);
check("an axis the table does not carry gets nothing",
  calibrate(table, "nonsense", 50, 6) === null);
check("calibrate assumes a complete team when it is not told otherwise",
  JSON.stringify(calibrate(table, "speed", 60)) === JSON.stringify(calibrate(table, "speed", 60, 6)));

// --- 7. the score, not the text on it -------------------------------------------------------
// The Companion's defect, which cannot happen here -- and this is the section that keeps it
// that way. `scoreRing` rounds for DISPLAY; the standing must be read off the raw score.

let moved = null;
for (const axis of AXES) {
  for (let score = table.axes[axis][0]; score <= table.axes[axis][QUANTILES - 1]; score += 0.07) {
    const raw = percentileOf(table, axis, score);
    const rounded = percentileOf(table, axis, Math.round(score));
    if (raw !== rounded) { moved = { axis, score: Number(score.toFixed(2)), raw, rounded }; break; }
  }
  if (moved) break;
}
check("rounding a score really does move its percentile on the shipped table", moved !== null,
  moved ? `${moved.axis} ${moved.score} is the ${moved.raw}th percentile, ${Math.round(moved.score)} is the ${moved.rounded}th`
    : "no score in the whole table changed percentile when rounded, so this section proves nothing");

check("the ring rounds for display", /Math\.round\(score \|\| 0\)/.test(readFileSync(join(root, "builder", "ui.js"), "utf8")));
const axisCalibration = page.slice(page.indexOf("function axisCalibration"), page.indexOf("function ensureScoreAnchors"));
check("the standing does not round", axisCalibration.includes("calibrate(") && !/round/i.test(axisCalibration),
  axisCalibration.trim());

// All four cards, by name, each handing the standing the same unrounded expression it hands
// the ring. A card built under one label and retitled later -- which is exactly what the
// Companion's Synergy tile does -- would not match here.
for (const [label, expression] of [["Synergy", "result.synergy_score"], ["Offense", "result.offense_score"],
  ["Defense", "result.defense_score"], ["Speed", "result.speed.score"]]) {
  check(`the ${label} card is built as ${label} and stands on ${expression}`,
    page.includes(`scoreButton("${label}", ${expression},`) && page.includes(`stand("${label}", ${expression})`),
    `looked for scoreButton("${label}", ${expression}, ...) and stand("${label}", ${expression})`);
}

// WHICH NUMBER REACHES THE RING. `calibrate` decides, in one place, and `ring` is null exactly
// when there is no standing -- so a ring is never handed a percentile that the card then labels
// as a score, or the other way round. This is the check that keeps the two cases apart.
const standing = calibrate(table, "offense", 46.2, 6);
check("a complete team's ring is handed the standing, not the score",
  standing.ring === standing.percentile && standing.ring !== Math.round(46.2),
  JSON.stringify(standing));
check("the standing still comes from the unrounded score",
  standing.percentile === percentileOf(table, "offense", 46.2), JSON.stringify(standing));
check("the page draws the ring from the calibration and falls back to the raw score",
  page.includes("scoreRing(standing ? calibration.ring : value, label, {"),
  "builder-page.js axisRing is the one place that decides which number a score ring holds");
check("the word under the ring comes from the calibration, not from the score",
  page.includes("}, calibration.note) : null,"),
  "builder-page.js scoreText");
const view = readFileSync(join(root, "builder", "evaluation-view.js"), "utf8");
check("the dialogs' rings do the same, so a card and its dialog cannot disagree",
  view.includes("scoreRing(has ? standing.ring : score, label,"),
  "evaluation-view.js standingRing");

// TWO LINES, NOT THREE. The dialog shows what the number is and where it stands; the formula it
// was scored with and the per-matchup method are hovers. A payload recorded before V512 has no
// standing wording to fall back on, so with no standing the first line is still the formula --
// which is the only place the 70/30 sentence can be read.
check("the pressure dialog's visible lines are the headline and the standing",
  view.includes("title: stands ? formula : null }, headline)") && view.includes("standingNote(standing),"),
  "evaluation-view.js openPressureDialog");
check("the per-matchup method is kept, on the heading it describes",
  view.includes("bd-field-label\", title: method }"),
  "evaluation-view.js openPressureDialog -- dropped rather than demoted would lose it");
check("the standing note shows the short sentence with the long one on hover",
  view.includes("title: standing.title || null }, standing.sentence)"),
  "evaluation-view.js standingNote");

// --- 8. what the generator may not write ----------------------------------------------------

const axes = table.axes;
check("the shipped table is one the generator would write",
  anchorTableRefusal({ scored: table.teams, attempted: table.teams, failed: 0, axes }) === "",
  anchorTableRefusal({ scored: table.teams, attempted: table.teams, failed: 0, axes }));
check("the floor is the generator's own --sample floor", MIN_ANCHOR_TEAMS === 40,
  "generate-score-anchors.mjs clamps with Math.max(40, ...), so the two must agree");
check("a run that salvaged a handful of teams is refused",
  anchorTableRefusal({ scored: 7, attempted: 240, failed: 233, axes }).includes("under the 40"));
check("a sample that mostly failed is refused even above the floor",
  anchorTableRefusal({ scored: 100, attempted: 240, failed: 140, axes }).includes("not the library's distribution"));
check("a few failures do not stop a refresh",
  anchorTableRefusal({ scored: 234, attempted: 240, failed: 6, axes }) === "",
  `6 of 240 is under the ${Math.round(MAX_ANCHOR_FAILURE_SHARE * 100)}% allowed`);
check("a degenerate table is refused -- this is the plausible-but-wrong one",
  anchorTableRefusal({ scored: 240, attempted: 240, failed: 0,
    axes: { ...axes, synergy: Array(QUANTILES).fill(61.8) } }).includes("every sampled team scored the same synergy"),
  "101 identical points is the shape the panel expects, so only the generator can catch it");
check("an unsorted axis is refused",
  anchorTableRefusal({ scored: 240, attempted: 240, failed: 0,
    axes: { ...axes, speed: [...axes.speed].reverse() } }).includes("not sorted"));
check("a missing axis is refused",
  anchorTableRefusal({ scored: 240, attempted: 240, failed: 0, axes: { ...axes, defense: null } })
    .includes("defense produced no distribution"));
check("a NaN in the distribution is refused",
  anchorTableRefusal({ scored: 240, attempted: 240, failed: 0,
    axes: { ...axes, offense: axes.offense.map((v, i) => (i === 40 ? NaN : v)) } }).includes("not a number"));
check("called with nothing, it refuses", anchorTableRefusal() !== "" && anchorTableRefusal({}) !== "");
check("the generator uses the refusal rather than its own guard",
  (() => {
    const generator = readFileSync(join(root, "tools", "generate-score-anchors.mjs"), "utf8");
    return generator.includes("anchorTableRefusal({") && generator.includes("process.exit(1)")
      && !generator.includes("refusing to write a partial table");
  })());

// --- 9. a missing table is invisible, not an error ------------------------------------------
// The promise the module makes: whatever happens to the fetch, the panel shows exactly what it
// showed before this module existed. There is no off switch on the website because this IS the
// off switch -- remove data/builder/score-anchors.json and every standing disappears cleanly.

const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  if (String(url).includes("-singles")) throw new Error("no such file");
  return { ok: true, json: async () => JSON.parse(readFileSync(ANCHOR_FILE, "utf8")) };
};

check("nothing is in hand before the fetch", scoreAnchors("Doubles") === null,
  "a render that happens first must show no standing rather than wait");
const loaded = await loadScoreAnchors("Doubles");
check("the table loads", isAnchorTable(loaded));
check("and is then available to a synchronous render", isAnchorTable(scoreAnchors("Doubles")));
await loadScoreAnchors("Doubles");
await loadScoreAnchors("Doubles");
check("it is fetched once however many times it is asked for", fetched.length === 1,
  `fetched ${fetched.length} times: ${fetched.join(", ")}`);

const singles = await loadScoreAnchors("Singles");
check("a format with no table resolves to null instead of throwing", singles === null);
check("and stays null for a synchronous render", scoreAnchors("Singles") === null);
check("the Singles table is simply absent, which is why Singles shows no standing",
  !existsSync(join(root, "data", "builder", "score-anchors-singles.json"))
  || isAnchorTable(JSON.parse(readFileSync(join(root, "data", "builder", "score-anchors-singles.json"), "utf8"))),
  "if one is ever generated it must be a valid table; until then this documents the hole");

for (const failure of failures) console.log(failure);
console.log(`\n${total} checked, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
