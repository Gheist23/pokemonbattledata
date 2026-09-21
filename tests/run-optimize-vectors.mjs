// Checks builder/team-optimize.js against Optimize runs recorded from the Companion
// app (tests/optimize-vectors.json): the single-move calcs it rests on, every
// spread the search evaluated with its score, and the result.
//
//   node tests/run-optimize-vectors.mjs [limit]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, makeMon } from "../builder/engine.js";
import { TeamEvaluator } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamOptimizer } from "../builder/team-optimize.js";
import { pokemonRecord } from "../tools/builder-meta.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const cases = JSON.parse(readFileSync(join(here, "optimize-vectors.json"), "utf8"));
const siteMeta = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));
const evalCases = Object.fromEntries(JSON.parse(readFileSync(join(here, "eval-vectors.json"), "utf8")).map((c) => [c.name, c]));
let suggestCases = [];
try {
  suggestCases = JSON.parse(readFileSync(join(here, "suggest-vectors.json"), "utf8"));
} catch {
  suggestCases = [];
}
const engine = new DamageEngine(appData);
const aliases = appData.usageAliases || {};
const limit = Number(process.argv[2]) || 30;
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) <= tol * Math.max(1, Math.abs(Number(a)));

const failures = [];
let total = 0;
for (const testCase of cases) {
  const evalCase = evalCases[testCase.name];
  const records = new Map();
  for (const row of evalCase?.record.meta[0]?.rows || []) {
    const stem = String(row.pokemon || row.base_name || row.name);
    if (!records.has(stem) && (row.rows || []).length) records.set(stem, pokemonRecord(stem, row.rows, aliases));
  }
  // The app's whole ranked list, from the Suggestions recording of the same team.
  const appPool = suggestCases.find((c) => c.name === testCase.name)?.record.rows || [];
  for (const call of appPool) {
    const stem = String(call.meta.base_name || call.meta.pokemon || call.meta.name);
    if (!records.has(stem) && (call.meta.rows || []).length) records.set(stem, pokemonRecord(stem, call.meta.rows, aliases));
  }
  if (!appPool.length) for (const record of siteMeta.pokemon) if (!records.has(record.name)) records.set(record.name, record);
  const ev = new TeamEvaluator(null, engine, "Doubles", testCase.settings);
  ev.setMetaRecords([...records.values()]);
  const optimizer = new TeamOptimizer(new TeamEvaluation(ev));
  const label = `${testCase.name} slot ${testCase.slot} ${testCase.entry[0]}`;

  // 1. the single-move calcs
  for (const [i, calc] of testCase.calcs.entries()) {
    total += 1;
    const got = optimizer.calcOne(makeMon(calc.attacker), makeMon(calc.defender), calc.move);
    const want = calc.result;
    const diffs = ["hits", "chance", "score", "move_priority", "current_hp"].filter((k) => want[k] !== undefined && want[k] !== null && !near(want[k], got[k] ?? 0));
    if (JSON.stringify(want.rolls) !== JSON.stringify(got.rolls || [])) diffs.push("rolls");
    if (diffs.length) failures.push(`${label} calc #${i} ${calc.attacker.form_name} ${calc.move} -> ${calc.defender.form_name}: ${diffs.map((k) => `${k} app ${JSON.stringify(want[k])} | web ${JSON.stringify(got[k])}`).join("; ")}`);
  }

  // 2. the search and the result, from the team as the app held it
  const entries = evalCase ? evalCase.record.team_mons.at(-1).mons : [];
  const builderSets = entries.map((m) => ({ species: m.pokemon_name, form: m.form_name, item: m.item, ability: m.ability, moves: m.moves, nature: m.nature_name, bonuses: m.bonuses }));
  if (testCase.start_spread && builderSets[testCase.slot]) {
    builderSets[testCase.slot] = { ...builderSets[testCase.slot], nature: testCase.start_spread.nature_name, bonuses: [...testCase.start_spread.bonuses] };
  }
  const trail = [];
  const original = optimizer.evaluateSpread.bind(optimizer);
  optimizer.evaluateSpread = (...args) => {
    const out = original(...args);
    if (!args[8]) trail.push({ nature: args[3].nature_name, bonuses: [...args[3].bonuses], score: out.score });
    return out;
  };
  const result = optimizer.optimize(builderSets, testCase.slot, { optimizeNature: testCase.optimize_nature });
  // the Top-X rows the search scores against
  (testCase.rows || []).forEach((want, i) => {
    total += 1;
    const got = optimizer.lastRows?.[i];
    const pick = (r) => r && `${r.move}:${r.hits}:${Number(r.chance || 0).toFixed(4)}`;
    const w = `${want.threat.form_name}@${want.threat.item}/${want.threat.ability}/${(want.threat.moves || []).join("+")}/${want.threat.nature_name} in ${pick(want.incoming)} out ${pick(want.outgoing)}`;
    const g = got ? `${got.threat.form_name}@${got.threat.item}/${got.threat.ability}/${(got.threat.moves || []).join("+")}/${got.threat.nature_name} in ${pick(got.incoming)} out ${pick(got.outgoing)}` : "none";
    if (w !== g) failures.push(`${label} row ${i} (#${want.rank})
    app ${w}
    web ${g}`);
  });
  total += 1;
  const wantTrail = testCase.evaluations;
  const firstDiff = wantTrail.findIndex((e, i) => !trail[i] || e.nature !== trail[i].nature || JSON.stringify(e.bonuses) !== JSON.stringify(trail[i].bonuses) || !near(e.score, trail[i].score, 1e-4));
  if (firstDiff >= 0) {
    const w = wantTrail[firstDiff];
    const g = trail[firstDiff];
    failures.push(`${label} search diverges at evaluation ${firstDiff}/${wantTrail.length}: app ${w.nature} ${w.bonuses} = ${w.score} | web ${g ? `${g.nature} ${g.bonuses} = ${g.score}` : "none"}`);
  }
  total += 1;
  const want = testCase.result;
  const same = want.ok === result.ok && JSON.stringify(want.spread?.bonuses) === JSON.stringify(result.spread?.bonuses) && (want.spread?.nature_name || "") === (result.spread?.nature_name || "") && near(want.score, result.score, 1e-4);
  if (!same) failures.push(`${label} result: app ok ${want.ok} ${want.spread?.nature_name} ${want.spread?.bonuses} score ${want.score} | web ok ${result.ok} ${result.spread?.nature_name} ${result.spread?.bonuses} score ${result.score}`);
}
for (const failure of failures.slice(0, limit)) console.log(failure);
console.log(`\n${total} checked, ${failures.length} mismatched.`);
process.exitCode = failures.length ? 1 : 0;
