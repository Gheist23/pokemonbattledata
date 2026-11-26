// Builds data/builder/score-anchors.json: what the four Team Evaluation scores actually look
// like across the shipped team library, so the panel can say where a score stands instead of
// only where it sits on an arbitrary 0-100 dial.
//
//   node tools/generate-score-anchors.mjs [--sample all] [--format Doubles] [--jobs 12]
//
// WHY THIS FILE EXISTS. Measured over the 240 library teams the shipped table is cut from
// (25 Nov 2026), the four scores occupy about a sixth of 0-100 and their ends are structurally
// unreachable, not merely unoccupied: Offense cannot pass ~60 (it would need every member's two
// best moves to average 100% damage against all 30 meta Pokemon) and Defense cannot either. So
// the old `scoreTone` thresholds (>=70 green, >=50 amber) gave NO real team a green Offense or
// Defense, showed a red Defense to three quarters of them and a red Offense to half, and made
// Synergy amber for 96%. The number's place on the dial and its place among real teams
// disagreed, and only the dial was shown. The per-axis figures are in score-calibration.js,
// recomputed from the shipped table by tests/run-score-calibration.mjs.
//
// WHAT IT IS NOT. This changes no score. The anchors are a reference distribution for display
// only; `TeamEvaluation.evaluate` is untouched and every recorded vector replays unchanged.
//
// REFRESHING IT. The scores drift with the meta, so re-run this when the meta data is re-cut
// in a way that moves scores -- NOT daily. A stale table degrades gracefully (percentiles
// drift by a point or two) and `generated` is shown in the panel's tooltip so staleness is
// visible. Deliberately not wired into the daily publish: an hour-long run inside the morning
// pipeline would be a new way for the publish to fail, and `--jobs` makes it quick enough to
// run by hand that it never needs to be.

import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { KnownTeams } from "../builder/known-teams.js";
import { AXES, QUANTILES, anchorTableRefusal } from "../builder/score-calibration.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
// `all` by default: the shipped table is cut from every complete team in the library, so a
// percentile read against it is a rank among all of them rather than among a sample of them.
const sampleArg = arg("sample", "all");
const sample = sampleArg === "all" ? Infinity : Math.max(40, Number(sampleArg) || 240);
const format = arg("format", "Doubles");
// An absolute `--out` is left alone, so a trial table can be written somewhere outside the
// worktree: everything in here is committed and deployed by the morning publish.
const outArg = arg("out", "data/builder/score-anchors.json");
const out = isAbsolute(outArg) ? outArg : join(root, outArg);
const jobs = Math.max(1, Math.min(32, Number(arg("jobs", 1)) || 1));
// Set by the parent on a worker, never by hand: score this slice of the library and leave the
// raw scores in a file for the parent to merge.
const slice = arg("slice", "");
const scoresOut = arg("scores-out", "");

const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const metaKey = format === "Singles" ? "singles" : "doubles";
const siteMeta = JSON.parse(readFileSync(join(root, "data", "builder", `meta-${metaKey}.json`), "utf8"));
const known = new KnownTeams(JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8")));

// Complete sixes only. The anchors describe finished teams, which is the only population a
// percentile can honestly be read against: a partial team's Offense and Defense are measured
// over the members present, so one bulky Pokemon alone scores a Defense higher than every
// complete tournament team in the library. The panel suppresses the percentile below six.
const library = known.teams.filter((team) => (team.members || []).length === 6);
const step = Math.max(1, Math.floor(library.length / sample));
const picked = library.filter((_, i) => i % step === 0).slice(0, sample);

const scores = Object.fromEntries(AXES.map((axis) => [axis, []]));
let failed = 0;

function scoreTeam(team) {
  // A fresh evaluator per team, the way every harness builds one: the evaluator caches damage
  // per (attacker, defender, move) and the Speed layers hold per-run state on the instance.
  const engine = new DamageEngine(appData);
  const evaluator = new TeamEvaluator(null, engine, format, {});
  evaluator.setMetaRecords(siteMeta.pokemon);
  const evaluation = new TeamEvaluation(evaluator);
  evaluation.knownTeams = known;
  try {
    // NO `bonuses` KEY, AND THAT IS THE CHOICE THIS FILE TURNS ON. The library records a
    // Pokemon's species, item, ability, nature and moves but not its stat points, and
    // `TeamEvaluator.teamMon` reads a missing `bonuses` as "use this Pokemon's most common
    // spread". Passing `[0,0,0,0,0,0]` instead -- which is what `makeSet` gives a Showdown
    // paste with no EV lines -- scores the same team six points of Offense lower (team1:
    // 44.28 against 38.28, measured both ways). These are real tournament teams that really
    // had stat points, so the most common spread is the best reconstruction available and a
    // zero-investment reference would describe a population that does not exist, flattering
    // every team measured against it.
    const payload = evaluation.evaluate(team.members.map((m) => ({
      species: m.species, form: m.form, item: m.item, ability: m.ability, moves: m.moves, nature: m.nature,
    })));
    scores.synergy.push(Number(payload.synergy_score));
    scores.offense.push(Number(payload.offense_score));
    scores.defense.push(Number(payload.defense_score));
    scores.speed.push(Number(payload.speed?.score ?? 0));
  } catch (error) {
    failed += 1;
    process.stderr.write(`
${team.name}: ${error.message}
`);
  }
}

function scoreAll(list, label) {
  for (const [index, team] of list.entries()) {
    scoreTeam(team);
    if ((index + 1) % 25 === 0) process.stderr.write(`${label}${index + 1}/${list.length}
`);
  }
}

// --- one process, or several -------------------------------------------------------------------
// WHY `--jobs` EXISTS AND WHY IT MOVES NO NUMBER. A team's four scores are a measurement of that
// team alone: a fresh engine and evaluator per team, nothing shared between teams and nothing
// accumulated across them. So the library splits across processes and the merged result is the
// same multiset of scores one process would have produced -- `quantiles` sorts it, so not even
// the order survives to matter. That is what makes the WHOLE library affordable rather than a
// 240-team sample of it: at about two seconds a team, 1945 teams is an hour in one process and a
// few minutes across twelve. Sliced `index % jobs` rather than in contiguous blocks, so every
// worker draws the same mix of teams and they finish together. Checked rather than argued:
// `--sample 48 --jobs 4` and `--sample 48 --jobs 1` wrote tables identical on all 101 points of
// all four axes.
if (slice) {
  const [index, count] = slice.split("/").map(Number);
  scoreAll(picked.filter((_, i) => i % count === index), `slice ${index}: `);
  writeFileSync(scoresOut, JSON.stringify({ scores, failed }), "utf8");
  process.exit(0);
}

if (jobs > 1) {
  const dir = mkdtempSync(join(tmpdir(), "score-anchors-"));
  const self = fileURLToPath(import.meta.url);
  // A worker that dies takes the run down instead of quietly shrinking the population: a table
  // cut from eleven twelfths of the library would still look exactly like a finished one.
  const parts = await Promise.all(Array.from({ length: jobs }, (_, index) => new Promise((resolve, reject) => {
    const file = join(dir, `slice-${index}.json`);
    const child = fork(self, ["--slice", `${index}/${jobs}`, "--scores-out", file, "--sample", String(sampleArg), "--format", format]);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`worker ${index} exited ${code}`));
      try { resolve(JSON.parse(readFileSync(file, "utf8"))); } catch (error) { reject(error); }
    });
  })));
  for (const part of parts) {
    for (const axis of AXES) scores[axis].push(...part.scores[axis]);
    failed += part.failed;
  }
  rmSync(dir, { recursive: true, force: true });
} else {
  scoreAll(picked, "");
}

/** Nearest-rank quantiles, 0..100 inclusive, so `q[p]` is the score at the p-th percentile. */
function quantiles(values) {
  const v = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return Array.from({ length: QUANTILES }, (_, p) => {
    const at = Math.round((p / (QUANTILES - 1)) * (v.length - 1));
    // Six decimals: enough that two adjacent quantiles never collapse into one another, and
    // short enough that the file stays a few kilobytes. Nothing on a SCORING path is rounded
    // (see champions-field-dependency-value); this is a display reference, not a score.
    return Number(v[at].toFixed(6));
  });
}

const axes = {};
for (const axis of AXES) {
  const q = quantiles(scores[axis]);
  if (q) axes[axis] = q;
}
// REFUSED, NOT DEFAULTED -- and judged on the OUTPUT, not on the run. The guard this replaces
// asked whether every axis produced some distribution, which a run that scored a single team
// passes, and so does a run in which every team scored identically. `anchorTableRefusal` says
// why not, in a sentence meant for a log nobody reads until the table is already wrong.
const refusal = anchorTableRefusal({ scored: scores.offense.length, attempted: picked.length, failed, axes });
if (refusal) {
  console.error(`Refusing to write ${out}: ${refusal}.`);
  process.exit(1);
}

const payload = {
  version: 1,
  generated: new Date().toISOString().slice(0, 10),
  format,
  top_meta: new TeamEvaluator(null, new DamageEngine(appData), format, {}).settings.top_meta,
  teams: scores.offense.length,
  library: library.length,
  source: "known-teams.json, complete sixes, full TeamEvaluation.evaluate",
  spreads: "each Pokemon's most common stat spread (the library records no stat points)",
  note: "Display only. q[p] is the score at the p-th percentile of the library teams scored.",
  axes,
};
writeFileSync(out, `${JSON.stringify(payload, null, 1)}\n`, "utf8");

console.log(`\nWrote ${out}`);
console.log(`${payload.teams} of ${picked.length} teams scored${failed ? ` (${failed} failed)` : ""}, library ${library.length}`);
for (const axis of AXES) {
  const q = axes[axis];
  console.log(` ${axis.padEnd(8)} p0 ${q[0].toFixed(1)}  p25 ${q[25].toFixed(1)}  p50 ${q[50].toFixed(1)}  p75 ${q[75].toFixed(1)}  p100 ${q[100].toFixed(1)}`);
}
