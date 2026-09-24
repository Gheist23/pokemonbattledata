// The Trick Room Speed score (builder/team-speed.js `trickRoomSpeedMetrics`), against the
// Companion app's V494 rule.
//
//   node tests/run-trick-room-speed.mjs
//
// A team the app classifies as a Trick Room archetype is scored under its own Trick Room
// instead of on raw Speed. v465 built that score as a composite:
//
//     coverage * 78 + setter_reliability * 15 + slow_share * 7
//
// so a team collected up to 22 points for owning the setters and for being slow, whatever
// those slow Pokemon achieved against the meta. V494 (_v494_trick_room_speed_metrics, the
// app's final binding of the name) replaced it: the score is the measured coverage - the
// share of selected Top-X speed matchups the team wins under its own Trick Room, and the
// number the panel's summary line prints beside it - gated by whether the team can reliably
// get Trick Room up at all. `slow_share` is still reported and no longer paid for.
//
// The site was ported before V494 and kept the composite, which made every Trick Room team
// score too high (the recorded team below: 50.55 against the app's 47.5) and, through the
// four-score average, every suggestion on such a team about 0.8 too high.
//
// Checked here: the rule itself, and the recorded Trick Room team end to end - its whole
// `payload.speed` against what the app recorded for it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, terrainSeedOption } from "../builder/engine.js";
import { TeamEvaluator } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { KnownTeams } from "../builder/known-teams.js";
import { trickRoomSpeedMetrics } from "../builder/team-speed.js";
import { pokemonRecord } from "../tools/builder-meta.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const failures = [];
let total = 0;

function check(label, want, got) {
  total += 1;
  const same = typeof want === "number" && typeof got === "number"
    ? Math.abs(want - got) < 1e-6 * Math.max(1, Math.abs(want))
    : JSON.stringify(want) === JSON.stringify(got);
  if (!same) failures.push(`${label}\n    app ${JSON.stringify(want)}\n    web ${JSON.stringify(got)}`);
}

// --- 1. the rule -------------------------------------------------------------------
// Two attackers slower than three of the four Top-X rows: coverage 6/8 = 75%.
const OWN = [["Slow A", 50], ["Slow B", 60]];
const META = [["M1", 100], ["M2", 120], ["M3", 90], ["M4", 45]];

const twoSetters = trickRoomSpeedMetrics(OWN, META, 2, 3, 4);
check("coverage is the measured quantity", 75, twoSetters.coverage);
// With the setters secured (reliability 100%) the score IS the coverage: no flat points for
// owning them, and none for `slow_share`, which is reported beside it untouched.
check("two setters: the score is the coverage", twoSetters.coverage, twoSetters.score);
check("slow_share is still reported", 75, twoSetters.slow_share);

const oneSetter = trickRoomSpeedMetrics(OWN, META, 1, 3, 4);
check("one setter gates the coverage to 72%", 54, oneSetter.score);
check("one setter does not change the coverage", 75, oneSetter.coverage);

// No setter: the team cannot turn the turn order around, so nothing it would win counts.
check("no setter scores nothing", 0, trickRoomSpeedMetrics(OWN, META, 0, 3, 4).score);
// And a team fast enough to win nothing under its own Trick Room earns nothing either.
check("a team that wins no matchup scores nothing", 0, trickRoomSpeedMetrics([["Fast", 200]], META, 2, 0, 6).score);

// --- 2. the recorded Trick Room team ----------------------------------------------
// eval-vectors-scoring.json holds the evaluations recorded beside suggest-vectors-scoring.json;
// `trickroom` is Indeedee-F / Hatterene / Incineroar / Gholdengo.
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const siteMeta = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));
const knownTeams = new KnownTeams(JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8")));
const cases = JSON.parse(readFileSync(join(here, "eval-vectors-scoring.json"), "utf8"));
const testCase = cases.find((entry) => entry.name === "trickroom");
if (!testCase) failures.push("eval-vectors-scoring.json no longer carries the `trickroom` recording");
else {
  const aliases = appData.usageAliases || {};
  const engine = new DamageEngine(appData);
  engine.terrainSeeds = terrainSeedOption(testCase.record?.rules?.terrain_seeds ?? null);
  // The site's meta records are rebuilt from exactly the battle-data rows the app scored.
  const records = new Map();
  for (const row of testCase.record.meta[0]?.rows || []) {
    const stem = String(row.pokemon || row.base_name || row.name);
    if (!records.has(stem) && (row.rows || []).length) records.set(stem, pokemonRecord(stem, row.rows, aliases));
  }
  for (const record of siteMeta.pokemon) if (!records.has(record.name)) records.set(record.name, record);

  const evaluator = new TeamEvaluator(null, engine, "Doubles", testCase.settings, { pairedSpreads: testCase.record?.rules?.paired_spreads ?? null });
  evaluator.setMetaRecords([...records.values()]);
  const evaluation = new TeamEvaluation(evaluator);
  evaluation.knownTeams = knownTeams;
  const recordedMons = testCase.record.team_mons.at(-1)?.mons || [];
  const sets = (testCase.extra?.simple_profiles || []).map((profile, i) => {
    const [species, item, form, ability, moves] = profile.entry;
    const source = recordedMons[i] || {};
    return { species, item, form, ability, moves, nature: source.nature_name, bonuses: source.bonuses };
  });
  const speed = evaluation.evaluate(sets, { checkSelection: testCase.extra?.selected_checks }).speed;
  const want = testCase.payload.speed || {};
  check("trickroom is still scored under its own Trick Room", "trick_room", speed.archetype_speed_mode_v465);
  for (const key of Object.keys(want)) check(`trickroom payload speed.${key}`, want[key], speed[key]);
}

for (const failure of failures) console.log(failure);
console.log(`\n${total} checked, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
