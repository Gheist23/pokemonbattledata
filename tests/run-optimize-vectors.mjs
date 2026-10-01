// Checks builder/team-optimize.js against Optimize runs recorded from the Companion
// app (tests/optimize-vectors.json): the single-move calcs it rests on, every
// spread the search evaluated with its score, and the result.
//
//   node tests/run-optimize-vectors.mjs [limit]
//
// Nature / Stat Point pairing (builder/nature-spreads.js): a recording made with the rule
// carries record.rules.paired_spreads and replays with it; one without the stamp was made
// before the rule and replays with each Nature on the distribution at its own place in the
// usage file's other list. PAIRED_SPREADS=0 / =1 replays every recording either way.

// Terrain seeds (builder/engine.js): a recording made with the rule carries
// record.rules.terrain_seeds and replays with it; one without the stamp was made before
// the rule and replays with it off, so a held Electric/Grassy/Misty/Psychic Seed adds no
// stage. TERRAIN_SEEDS=1 / =0 replays every recording either way.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, fieldRequirementOption, koLabelOption, makeMon, moveFlagsOption, selfStatChangeOption, terrainSeedOption } from "../builder/engine.js";
import { TeamEvaluator } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamOptimizer } from "../builder/team-optimize.js";
import { pokemonRecord } from "../tools/builder-meta.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
/** The recording's `self_cost` stamp (null: recorded before the rule, so a move that faints its
 *  own user is still counted as a clean answer and the engine's recoil is still free).
 *  SELF_COST=0 / =1 replays every recording either way. */
const selfCostRule = (testCase) => (process.env.SELF_COST === undefined
  ? (testCase?.record?.rules?.self_cost ?? testCase?.rules?.self_cost ?? null)
  : process.env.SELF_COST);

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
/** The recording's terrain-seed stamp (null: recorded before the rule, replayed with it off).
 *  TERRAIN_SEEDS=0 / =1 replays every recording either way. */
const seedStamp = (testCase) => testCase.record?.rules?.terrain_seeds ?? testCase.rules?.terrain_seeds ?? null;
const seedRule = (testCase) => terrainSeedOption(process.env.TERRAIN_SEEDS === undefined ? seedStamp(testCase) : process.env.TERRAIN_SEEDS);
// V521: Steel Roller fails with no terrain up. A recording made before the rule carries
// no `field_requirements` stamp and replays with it off, so recorded answers stay the
// answers the app gave when they were made.
const fieldStamp = (testCase) => testCase.record?.rules?.field_requirements ?? testCase.rules?.field_requirements ?? null;
const fieldRule = (testCase) => fieldRequirementOption(
  process.env.FIELD_REQUIREMENTS === undefined ? fieldStamp(testCase) : process.env.FIELD_REQUIREMENTS);
/** V525: a move changes its user's own stats before the answer lands. A recording made
    before the rule carries no `self_stat_change` stamp and replays with it off. */
/** V527: every move learned the flags the game's archive does not publish -- contact,
    punch, bite, slicing, pulse -- so Tough Claws, Iron Fist, Strong Jaw, Sharpness,
    Reckless, Mega Launcher, Fluffy and Punk Rock stopped being inert. A vector recorded
    before the rule carries no `move_flags` stamp and replays with it off. */
const moveFlagsStamp = (testCase) => testCase.record?.rules?.move_flags ?? testCase.rules?.move_flags ?? null;
const moveFlagsRule = (testCase) => moveFlagsOption(
  process.env.MOVE_FLAGS === undefined ? moveFlagsStamp(testCase) : process.env.MOVE_FLAGS);
const selfStatStamp = (testCase) => testCase.record?.rules?.self_stat_change ?? testCase.rules?.self_stat_change ?? null;
const selfStatRule = (testCase) => selfStatChangeOption(
  process.env.SELF_STAT_CHANGE === undefined ? selfStatStamp(testCase) : process.env.SELF_STAT_CHANGE);
// V523: the threat KO line reads like the Damage Calculator's. A recording made
// before the rule carries no `ko_label` stamp and replays with the old tier label.
const koLabelStamp = (testCase) => testCase.record?.rules?.ko_label ?? testCase.rules?.ko_label ?? null;
const koLabelRule = (testCase) => koLabelOption(
  process.env.KO_LABEL === undefined ? koLabelStamp(testCase) : process.env.KO_LABEL);

const aliases = appData.usageAliases || {};
const limit = Number(process.argv[2]) || 30;
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) <= tol * Math.max(1, Math.abs(Number(a)));
/** The recording's Nature / Stat Point pairing stamp (null: recorded before the rule, replayed
 *  with the usage file's index zip). PAIRED_SPREADS=0 / =1 replays every recording either way. */
const pairedStamp = (testCase) => testCase.record?.rules?.paired_spreads ?? testCase.rules?.paired_spreads ?? null;
const pairedRule = (testCase) => (process.env.PAIRED_SPREADS === undefined ? pairedStamp(testCase) : process.env.PAIRED_SPREADS);

const failures = [];
let total = 0;
for (const testCase of cases) {
  engine.terrainSeeds = seedRule(testCase);
  engine.fieldRequirements = fieldRule(testCase);
  engine.selfStatChange = selfStatRule(testCase);
  engine.moveFlags = moveFlagsRule(testCase);
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
  const ev = new TeamEvaluator(null, engine, "Doubles", testCase.settings, { pairedSpreads: pairedRule(testCase), scoreRules: testCase.record?.rules?.score_composition ?? testCase.rules?.score_composition ?? null, checkRules: testCase.record?.rules?.team_checks ?? testCase.rules?.team_checks ?? null, selfCost: selfCostRule(testCase), koLabel: koLabelRule(testCase) });
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
