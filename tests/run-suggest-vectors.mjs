// Checks builder/team-suggest.js against Suggested Pokemon runs recorded from the
// Companion app (tests/suggest-vectors.json, written by the app-side recorder).
//
//   node tests/run-suggest-vectors.mjs [case] [limit]
//
// Every candidate the app scored carries its raw battle-data rows, so the site's
// meta records are rebuilt from exactly those; the team's evaluation payload is
// recomputed by the site and compared first.
//
// Guaranteed moves (builder/guaranteed-moves.js): a recording made with the rule carries
// record.rules.guaranteed_move_share and replays with it; one without the stamp was made
// before the rule and replays with it off. For a stamped recording every row the app
// showed must also carry its guaranteed moves (from the recording's rows).
// GUARANTEED_MOVE_SHARE=95 replays every recording with the rule on (diagnostic).
//
// Nature / Stat Point pairing (builder/nature-spreads.js): a recording made with the rule
// carries record.rules.paired_spreads and replays with it; one without the stamp was made
// before the rule and replays with each Nature on the distribution at its own place in the
// usage file's other list. PAIRED_SPREADS=0 / =1 replays every recording either way.

// Terrain seeds (builder/engine.js): a recording made with the rule carries
// record.rules.terrain_seeds and replays with it; one without the stamp was made before
// the rule and replays with it off, so a held Electric/Grassy/Misty/Psychic Seed adds no
// stage. TERRAIN_SEEDS=1 / =0 replays every recording either way.

// Suggestion scoring (builder/team-suggest.js, the app's suggestion_scoring_v511): a recording made
// with the rule carries record.rules.suggestion_scoring and replays with that version; one without the
// stamp was made before the rule and replays with the old weights, which is what keeps the 2097 rows of
// suggest-vectors.json and suggest-vectors-guaranteed.json at 0 mismatches. SUGGESTION_SCORING=off / =2
// replays every recording either way (forcing it off on a stamped recording must mismatch).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, terrainSeedOption } from "../builder/engine.js";
import { TeamEvaluator } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { missingLocked } from "../builder/guaranteed-moves.js";
import { pokemonRecord } from "../tools/builder-meta.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
// suggest-vectors-guaranteed.json: the same runs recorded again after the guaranteed-move
// rule, so they carry the stamp and replay with the rule on.
// suggest-vectors-scoring.json: recorded again after the V511 suggestion scoring, so those runs
// carry `suggestion_scoring` and replay on the damped archetype reward and the calc-backed
// ranking terms. One of its cases is a real Trick Room team, which is where the rule bites.
const cases = ["suggest-vectors.json", "suggest-vectors-guaranteed.json", "suggest-vectors-scoring.json"]
  .filter((file) => existsSync(join(here, file)))
  .flatMap((file) => JSON.parse(readFileSync(join(here, file), "utf8")));
const siteMeta = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));
// The team's saved spreads are in the evaluation recording of the same team, and so are the Top-X
// rows the site rebuilds its meta records from. Those rows are the app's bundled battle-data
// snapshot, and the snapshot moves: between the V510 and the V511 recordings Kingambit went from
// meta position 5 to 6 and Arcanine-Hisui from 23 to 18. So an evaluation recording only pairs with
// a suggestion recording from the same app run - eval-vectors-scoring.json holds the evaluations
// made beside suggest-vectors-scoring.json, and its entries win where a name appears in both.
const evalByFile = (file) => (existsSync(join(here, file))
  ? Object.fromEntries(JSON.parse(readFileSync(join(here, file), "utf8")).map((c) => [c.name, c]))
  : {});
const evalCases = evalByFile("eval-vectors.json");
const scoringEvalCases = evalByFile("eval-vectors-scoring.json");
/** The evaluation recorded beside this suggestion recording (never one from another app run). */
const evalFor = (testCase) => (scoringStamp(testCase) ? scoringEvalCases[testCase.name] : null) ?? evalCases[testCase.name];
const engine = new DamageEngine(appData);
/** The recording's terrain-seed stamp (null: recorded before the rule, replayed with it off).
 *  TERRAIN_SEEDS=0 / =1 replays every recording either way. */
const seedStamp = (testCase) => testCase.record?.rules?.terrain_seeds ?? testCase.rules?.terrain_seeds ?? null;
const seedRule = (testCase) => terrainSeedOption(process.env.TERRAIN_SEEDS === undefined ? seedStamp(testCase) : process.env.TERRAIN_SEEDS);

const knownTeams = new KnownTeams(JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8")));
const aliases = appData.usageAliases || {};
const only = process.argv[2] && process.argv[2] !== "all" ? process.argv[2] : null;
const limit = Number(process.argv[3] || 15);

function same(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a));
  return JSON.stringify(a) === JSON.stringify(b);
}
/** The recording's guaranteed-moves stamp (null: recorded before the rule, replayed without it). */
const stampOf = (testCase) => testCase.record?.rules?.guaranteed_move_share ?? testCase.rules?.guaranteed_move_share ?? null;
const ruleShare = (testCase) => (process.env.GUARANTEED_MOVE_SHARE ? Number(process.env.GUARANTEED_MOVE_SHARE) : stampOf(testCase));
/** The recording's Nature / Stat Point pairing stamp (null: recorded before the rule, replayed
 *  with the usage file's index zip). PAIRED_SPREADS=0 / =1 replays every recording either way. */
const pairedStamp = (testCase) => testCase.record?.rules?.paired_spreads ?? testCase.rules?.paired_spreads ?? null;
const pairedRule = (testCase) => (process.env.PAIRED_SPREADS === undefined ? pairedStamp(testCase) : process.env.PAIRED_SPREADS);
/** The recording's V511 suggestion-scoring stamp (null: recorded before the rule, replayed with the
 *  old weights). SUGGESTION_SCORING=off / =2 replays every recording either way. */
const scoringStamp = (testCase) => testCase.record?.rules?.suggestion_scoring ?? testCase.rules?.suggestion_scoring ?? null;
const scoringRule = (testCase) => (process.env.SUGGESTION_SCORING === undefined ? scoringStamp(testCase) : process.env.SUGGESTION_SCORING);
const asEntry = (e) => (Array.isArray(e) ? { pokemon: e[0], item: e[1], form: e[2], ability: e[3], moves: e[4] || [] } : e);

const failures = [];
/** Differences that belong to another suite (the Team Evaluation's own scores), reported in full. */
const upstream = [];
const byField = new Map();
let total = 0;
for (const testCase of cases) {
  engine.terrainSeeds = seedRule(testCase);
  if (only && testCase.name !== only) continue;
  // A recording made with the guaranteed-move rule says so in its label.
  const label = `${testCase.name}${stampOf(testCase) ? " guaranteed" : ""}${scoringStamp(testCase) ? ` scoring v${scoringStamp(testCase)}` : ""}`;
  const calls = testCase.record.rows;
  const records = new Map();
  // The evaluation recording of the same team carries the full Top-X rows (and their meta
  // positions); candidates outside it come from the candidate rows.
  for (const row of evalFor(testCase)?.record.meta[0]?.rows || []) {
    const stem = String(row.pokemon || row.base_name || row.name);
    if (!records.has(stem) && (row.rows || []).length) records.set(stem, pokemonRecord(stem, row.rows, aliases));
  }
  for (const call of calls) {
    const meta = call.meta;
    const stem = String(meta.base_name || meta.pokemon || meta.name);
    if (!records.has(stem) && (meta.rows || []).length) records.set(stem, pokemonRecord(stem, meta.rows, aliases));
  }
  for (const record of siteMeta.pokemon) if (!records.has(record.name)) records.set(record.name, record);
  const evaluator = new TeamEvaluator(null, engine, "Doubles", testCase.settings, { pairedSpreads: pairedRule(testCase) });
  evaluator.setMetaRecords([...records.values()]);
  const evaluation = new TeamEvaluation(evaluator);
  evaluation.knownTeams = knownTeams;
  const recordedMons = evalFor(testCase)?.record.team_mons.at(-1)?.mons || [];
  const sets = testCase.team.filter((e) => e[0]).map(([species, item, form, ability, moves], i) => (
    { species, item, form, ability, moves, nature: recordedMons[i]?.nature_name, bonuses: recordedMons[i]?.bonuses }));
  const payload = evaluation.evaluate(sets, { checkSelection: null });
  const names = (rows) => (rows || []).map((r) => r.name).join(",");
  if (names(payload.threats) !== names(testCase.payload.threats)) failures.push(`${label} payload threats differ\n    app ${names(testCase.payload.threats)}\n    web ${names(payload.threats)}`);
  // The four team scores are a precondition for everything below: every candidate's score is
  // the average of the four projected ones, so a difference here moves every row by the same
  // amount and says nothing about the suggestion layer. They belong to the Team Evaluation
  // (tests/run-eval-vectors.mjs). On a recording that carries a rule this suite is here to
  // check, a difference is reported as an upstream note and the app's own value is used, so
  // the rows below still measure the rule. Without such a stamp it is a plain mismatch.
  for (const [k, appValue, webValue] of [
    ["synergy_score", testCase.payload.synergy_score, payload.synergy_score],
    ["offense_score", testCase.payload.offense_score, payload.offense_score],
    ["defense_score", testCase.payload.defense_score, payload.defense_score],
    ["speed", testCase.payload.speed.score, payload.speed.score],
  ]) {
    if (same(appValue, webValue)) continue;
    if (!scoringStamp(testCase)) {
      failures.push(`${label} payload ${k}: app ${appValue} | web ${webValue}`);
      continue;
    }
    upstream.push(`${label} payload ${k}: app ${appValue} | web ${webValue} - the Team Evaluation's own number, upstream of the suggestion scoring; the app's value is used below`);
    if (k === "speed") payload.speed = { ...payload.speed, score: appValue };
    else payload[k] = appValue;
  }

  const suggest = new TeamSuggestions(evaluation, { guaranteedMoveShare: ruleShare(testCase), suggestionScoring: scoringRule(testCase) });
  const teamSlots = (payload.slots || []).map(({ entry, mon }) => ({ entry: { ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }, mon }));
  const teamEntries = teamSlots.map(({ entry }) => entry);
  const activeNames = calls[0]?.active || [];
  const context = { payload, teamSlots, teamEntries, activeNames, emptySlot: teamSlots.length < 6 ? teamSlots.length : null, selection: null, selected: suggest.checks.selectedIds(null), swapTarget: calls[0]?.swap || "" };

  const pool = suggest.candidates(payload, activeNames);
  total += 1;
  const appPool = [...new Set(calls.map((c) => c.meta.name))];
  const webPool = pool.map((m) => m.name);
  if (appPool.join("|") !== webPool.join("|")) {
    const missing = appPool.filter((n) => !webPool.includes(n));
    const extra = webPool.filter((n) => !appPool.includes(n));
    failures.push(`${label} candidate pool: app ${appPool.length} | web ${webPool.length}; missing ${missing.slice(0, 8)}; extra ${extra.slice(0, 8)}`);
  }
  const FIELDS = ["name", "action", "score", "item", "ability", "moves", "answers", "checks_component", "threat_component", "synergy_component", "speed_component",
    "archetype_component_v429", "team_check_delta_v433", "archetype_speed_fit_v466", "role_fixes_v466", "details",
    "found_in_team_v496", "nature"];
  calls.forEach((call, index) => {
    total += 1;
    const want = call.row;
    // A full team is screened against up to three swap targets; each call names its own.
    const got = suggest.evaluateCandidate(structuredClone(call.meta), { ...context, swapTarget: call.swap || "" });
    if (!want && !got) return;
    if (!want || !got) {
      failures.push(`${label} #${index} ${call.meta.name}: app ${want ? want.score : "none"} | web ${got ? got.score : "none"}`);
      return;
    }
    const diffs = [];
    const setWant = want._candidate_set_v113 || {};
    const setGot = got._candidate_set_v113 || {};
    for (const f of ["item", "ability", "moves"]) if (!same(setWant[f], setGot[f])) diffs.push(`set.${f}: app ${JSON.stringify(setWant[f])} | web ${JSON.stringify(setGot[f])}`);
    for (const f of FIELDS) {
      if (want[f] === undefined && got[f] === undefined) continue;
      if (!same(want[f], got[f])) {
        diffs.push(`${f}: app ${JSON.stringify(want[f])} | web ${JSON.stringify(got[f])}`);
        byField.set(f, (byField.get(f) || 0) + 1);
      }
    }
    if (diffs.length) failures.push(`${label} #${index} ${call.meta.name}\n    ${diffs.join("\n    ")}`);
  });
  total += 1;
  const run = suggest.run(payload, {});
  const final = (rows) => rows.map((r) => `${r.name} ${r.score}`).join(" | ");
  if (final(run.rows) !== final(testCase.finished.rows)) failures.push(`${label} final ranking\n    app ${final(testCase.finished.rows)}\n    web ${final(run.rows)}`);
  // V511, on a recording made with the rule: every shown row's verdict on each of the team's worst
  // threats (the three terms that decide the order are read straight off these).
  if (Number(scoringStamp(testCase)) > 0) {
    const byName = new Map(run.rows.map((row) => [String(row.name), row]));
    const verdicts = (row) => (row.threat_verdicts_v511 || []).map((e) => `${e.threat} ${e.verdict} ${e.out_hits}/${e.in_hits}${e.fills_a_gap ? " gap" : ""}${e.type_chart_says_good ? " type" : ""}`).join(" | ");
    for (const want of testCase.finished.rows || []) {
      total += 1;
      const got = byName.get(String(want.name));
      if (!got) {
        failures.push(`${label} ${want.name}: shown by the app, not by the site`);
        continue;
      }
      if (verdicts(want) !== verdicts(got)) failures.push(`${label} ${want.name} threat verdicts\n    app ${verdicts(want)}\n    web ${verdicts(got)}`);
      total += 1;
      if (!same(want.answers, got.answers)) failures.push(`${label} ${want.name} answers: app ${JSON.stringify(want.answers)} | web ${JSON.stringify(got.answers)}`);
      for (const f of ["threats_measured_v511", "gaps_filled_v511", "removed_first_v511", "answered_share_v511"]) {
        total += 1;
        if (!same(want[f], got[f])) failures.push(`${label} ${want.name} ${f}: app ${JSON.stringify(want[f])} | web ${JSON.stringify(got[f])}`);
      }
    }
  }
  // Guaranteed moves, on a recording made with the rule: every shown row's set (what "Use" adds) carries them.
  if (Number(stampOf(testCase)) > 0) {
    for (const row of testCase.finished.rows || []) {
      total += 1;
      const entry = asEntry(row.candidate_entry) || { pokemon: row.name, item: row.item, ability: row.ability, moves: row.moves };
      const missing = missingLocked(suggest, entry, teamEntries).map((l) => `${l.move} ${l.share}%`);
      if (missing.length) failures.push(`${label} guaranteed moves: shown ${row.action} [${(entry.moves || []).join(", ")}] lacks ${missing.join(", ")}`);
    }
  }
}
for (const failure of failures.slice(0, limit)) console.log(failure);
for (const note of upstream) console.log(`UPSTREAM ${note}`);
console.log(`\n${total} checked, ${failures.length} mismatched${upstream.length ? `, ${upstream.length} upstream Team Evaluation difference${upstream.length === 1 ? "" : "s"} (listed above)` : ""}.`);
if (byField.size) console.log("by field:", Object.fromEntries([...byField.entries()].sort((a, b) => b[1] - a[1])));
process.exitCode = failures.length ? 1 : 0;
