// Checks builder/engine.js against damage results recorded from the Companion.
//
//   python ../../pct_tool94/tools/export_web_builder_data.py --vectors 4000
//   node tests/run-calc-vectors.mjs
//
// Every vector holds the exact attacker, defender and context the app was given
// and the fields it answered with. Any difference is printed with the inputs so
// the failing layer can be found; the exit code is the number of mismatches.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, makeContext, makeMon, pyFixed, pyRound } from "../builder/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const vectors = JSON.parse(readFileSync(join(here, "calc-vectors.json"), "utf8"));
const engine = new DamageEngine(appData);

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
