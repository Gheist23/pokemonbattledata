// Checks builder/team-suggest.js against Suggested Pokemon runs recorded from the
// Companion app (tests/suggest-vectors.json, written by the app-side recorder).
//
//   node tests/run-suggest-vectors.mjs [case] [limit]
//
// Every candidate the app scored carries its raw battle-data rows, so the site's
// meta records are rebuilt from exactly those; the team's evaluation payload is
// recomputed by the site and compared first.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { pokemonRecord } from "../tools/builder-meta.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const cases = JSON.parse(readFileSync(join(here, "suggest-vectors.json"), "utf8"));
const siteMeta = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));
// The team's saved spreads are in the evaluation recording of the same team.
const evalCases = Object.fromEntries(JSON.parse(readFileSync(join(here, "eval-vectors.json"), "utf8")).map((c) => [c.name, c]));
const engine = new DamageEngine(appData);
const knownTeams = new KnownTeams(JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8")));
const aliases = appData.usageAliases || {};
const only = process.argv[2] && process.argv[2] !== "all" ? process.argv[2] : null;
const limit = Number(process.argv[3] || 15);

function same(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a));
  return JSON.stringify(a) === JSON.stringify(b);
}

const failures = [];
const byField = new Map();
let total = 0;
for (const testCase of cases) {
  if (only && testCase.name !== only) continue;
  const calls = testCase.record.rows;
  const records = new Map();
  // The evaluation recording of the same team carries the full Top-X rows (and their meta
  // positions); candidates outside it come from the candidate rows.
  for (const row of evalCases[testCase.name]?.record.meta[0]?.rows || []) {
    const stem = String(row.pokemon || row.base_name || row.name);
    if (!records.has(stem) && (row.rows || []).length) records.set(stem, pokemonRecord(stem, row.rows, aliases));
  }
  for (const call of calls) {
    const meta = call.meta;
    const stem = String(meta.base_name || meta.pokemon || meta.name);
    if (!records.has(stem) && (meta.rows || []).length) records.set(stem, pokemonRecord(stem, meta.rows, aliases));
  }
  for (const record of siteMeta.pokemon) if (!records.has(record.name)) records.set(record.name, record);
  const evaluator = new TeamEvaluator(null, engine, "Doubles", testCase.settings);
  evaluator.setMetaRecords([...records.values()]);
  const evaluation = new TeamEvaluation(evaluator);
  evaluation.knownTeams = knownTeams;
  const recordedMons = evalCases[testCase.name]?.record.team_mons.at(-1)?.mons || [];
  const sets = testCase.team.filter((e) => e[0]).map(([species, item, form, ability, moves], i) => (
    { species, item, form, ability, moves, nature: recordedMons[i]?.nature_name, bonuses: recordedMons[i]?.bonuses }));
  const payload = evaluation.evaluate(sets, { checkSelection: null });
  const names = (rows) => (rows || []).map((r) => r.name).join(",");
  if (names(payload.threats) !== names(testCase.payload.threats)) failures.push(`${testCase.name} payload threats differ\n    app ${names(testCase.payload.threats)}\n    web ${names(payload.threats)}`);
  for (const k of ["synergy_score", "offense_score", "defense_score"]) if (!same(payload[k], testCase.payload[k])) failures.push(`${testCase.name} payload ${k}: app ${testCase.payload[k]} | web ${payload[k]}`);
  if (!same(payload.speed.score, testCase.payload.speed.score)) failures.push(`${testCase.name} payload speed: app ${testCase.payload.speed.score} | web ${payload.speed.score}`);

  const suggest = new TeamSuggestions(evaluation);
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
    failures.push(`${testCase.name} candidate pool: app ${appPool.length} | web ${webPool.length}; missing ${missing.slice(0, 8)}; extra ${extra.slice(0, 8)}`);
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
      failures.push(`${testCase.name} #${index} ${call.meta.name}: app ${want ? want.score : "none"} | web ${got ? got.score : "none"}`);
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
    if (diffs.length) failures.push(`${testCase.name} #${index} ${call.meta.name}\n    ${diffs.join("\n    ")}`);
  });
  total += 1;
  const run = suggest.run(payload, {});
  const final = (rows) => rows.map((r) => `${r.name} ${r.score}`).join(" | ");
  if (final(run.rows) !== final(testCase.finished.rows)) failures.push(`${testCase.name} final ranking\n    app ${final(testCase.finished.rows)}\n    web ${final(run.rows)}`);
}
for (const failure of failures.slice(0, limit)) console.log(failure);
console.log(`\n${total} checked, ${failures.length} mismatched.`);
if (byField.size) console.log("by field:", Object.fromEntries([...byField.entries()].sort((a, b) => b[1] - a[1])));
process.exitCode = failures.length ? 1 : 0;
