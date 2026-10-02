// Checks builder/engine.js against damage results recorded from the Companion.
//
//   python ../../pct_tool94/tools/export_web_builder_data.py --vectors 4000
//   node tests/run-calc-vectors.mjs
//
// Every vector holds the exact attacker, defender and context the app was given
// and the fields it answered with. Any difference is printed with the inputs so
// the failing layer can be found; the exit code is the number of mismatches.

// Terrain seeds (builder/engine.js): each vector carries the rules the app ran with, so a
// vector stamped `rules.terrain_seeds` is replayed with a held Electric/Grassy/Misty/Psychic
// Seed adding its stage and one recorded before the rule is replayed without it.
// TERRAIN_SEEDS=1 / =0 replays every vector either way.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, fieldRequirementOption, makeContext, makeMon, pyFixed, pyRound, ateDragonizeOption, moveFlagsOption, selfStatChangeOption, terrainSeedOption } from "../builder/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const vectors = JSON.parse(readFileSync(join(here, "calc-vectors.json"), "utf8"));
const engine = new DamageEngine(appData);
const seedRule = (vector) => terrainSeedOption(process.env.TERRAIN_SEEDS === undefined ? (vector.rules?.terrain_seeds ?? null) : process.env.TERRAIN_SEEDS);
// V521: Steel Roller fails with no terrain. A vector recorded before the rule
// carries no `field_requirements` stamp and replays with it off, so the three
// no-terrain Steel Roller vectors keep the answer the app gave when they were made.
const fieldRule = (vector) => fieldRequirementOption(
  process.env.FIELD_REQUIREMENTS === undefined
    ? (vector.rules?.field_requirements ?? null)
    : process.env.FIELD_REQUIREMENTS);
/** V525: Contrary turns a self-lowering move into a self-raising one, which is what
    `self_drop_v494` says -- a compared field below. A vector recorded before the rule
    carries no `self_stat_change` stamp and replays with it off. */
/** V527: every move learned the flags the game's archive does not publish -- contact,
    punch, bite, slicing, pulse -- so Tough Claws, Iron Fist, Strong Jaw, Sharpness,
    Reckless, Mega Launcher, Fluffy and Punk Rock stopped being inert. A vector recorded
    before the rule carries no `move_flags` stamp and replays with it off. */
/** V528: Dragonize joined the `-ate` table, so a Mega Feraligatr's Normal moves became
    Dragon moves at 1.2x. A vector recorded before the rule carries no `ate_dragonize`
    stamp and replays with the four-entry table. */
const ateDragonizeRule = (vector) => ateDragonizeOption(
  process.env.ATE_DRAGONIZE === undefined
    ? (vector.rules?.ate_dragonize ?? vector.record?.rules?.ate_dragonize ?? null)
    : process.env.ATE_DRAGONIZE);
const moveFlagsRule = (vector) => moveFlagsOption(
  process.env.MOVE_FLAGS === undefined
    ? (vector.rules?.move_flags ?? vector.record?.rules?.move_flags ?? null)
    : process.env.MOVE_FLAGS);
const selfStatRule = (vector) => selfStatChangeOption(
  process.env.SELF_STAT_CHANGE === undefined
    ? (vector.rules?.self_stat_change ?? vector.record?.rules?.self_stat_change ?? null)
    : process.env.SELF_STAT_CHANGE);

// Formatting helpers first: they carry most of the Python/JS divergence risk.
const formatCases = [[6.25, "6.2"], [18.75, "18.8"], [31.25, "31.2"], [0.05, "0.1"], [2.675, "2.7"], [100, "100.0"], [43.75, "43.8"]];
for (const [value, expected] of formatCases) {
  const got = pyFixed(value, 1);
  if (got !== expected) throw new Error(`pyFixed(${value}) = ${got}, expected ${expected}`);
}
for (const [value, expected] of [[0.5, 0], [1.5, 2], [2.5, 2], [3.5, 4], [2.4999, 2], [-0.5, -0]]) {
  if (pyRound(value) !== expected) throw new Error(`pyRound(${value}) = ${pyRound(value)}`);
}

const FIELDS = [
  "rolls", "range", "percent", "ko", "display_percent", "recoil_hp_range", "recoil_percent",
  "hit_count", "move_accuracy_percent", "attacker_speed", "defender_speed", "speed_tie",
  "focus_sash_active", "sturdy_active", "sitrus_berry_active", "sitrus_heal", "max_hp",
  "current_hp", "summary", "charged_state_active", "recharge_move", "self_drop_v494",
];

let failures = 0;
let checked = 0;
const byField = new Map();
for (const [index, vector] of vectors.entries()) {
  if (vector.error) continue;
  engine.terrainSeeds = seedRule(vector);
  engine.fieldRequirements = fieldRule(vector);
  engine.selfStatChange = selfStatRule(vector);
  engine.moveFlags = moveFlagsRule(vector);
  engine.ateDragonize = ateDragonizeRule(vector);
  const attacker = makeMon(vector.attacker);
  const defender = makeMon(vector.defender);
  const ctx = makeContext(vector.ctx);
  let result;
  try {
    result = engine.calculate(attacker, defender, ctx);
  } catch (error) {
    failures += 1;
    console.log(`#${index} threw: ${error.stack}`);
    continue;
  }
  checked += 1;
  const expected = vector.expected;
  const diffs = [];
  for (const field of FIELDS) {
    const want = expected[field];
    const got = result[field];
    if (want === undefined && (got === undefined || got === false)) continue;
    if (JSON.stringify(want) !== JSON.stringify(got)) diffs.push([field, want, got]);
  }
  if ((result.warnings || []).length !== expected.warning_count) diffs.push(["warning_count", expected.warning_count, (result.warnings || []).length]);
  if (diffs.length) {
    failures += 1;
    for (const [field] of diffs) byField.set(field, (byField.get(field) || 0) + 1);
    if (failures <= 12) {
      console.log(`\n#${index} ${vector.attacker.pokemon_name}/${vector.attacker.form_name} ${vector.ctx.move_name} -> ${vector.defender.pokemon_name}/${vector.defender.form_name}`);
      for (const [field, want, got] of diffs) console.log(`   ${field}: app=${JSON.stringify(want)} web=${JSON.stringify(got)}`);
    }
  }
}
console.log(`\n${checked} vectors checked, ${failures} mismatched.`);
if (byField.size) console.log("Mismatched fields:", Object.fromEntries(byField));
process.exitCode = Math.min(failures, 255);
