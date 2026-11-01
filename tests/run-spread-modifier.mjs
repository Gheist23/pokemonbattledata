// The spread modifier in the damage engine (builder/engine.js).
//
// A spread move is reduced to 0.75 in Doubles -- all of them, or none of them. Until V547
// neither codebase managed that. The app's V445 declared the Damage Calculator a one-target
// panel and cleared `meta.spread`, but the description registry wraps the same `move_meta`
// from `architecture/install.py` and so runs OUTSIDE it, writing each move's own `spread`
// straight back. Measured over all 955 moves: of the 71 the data calls spread moves, 68 carry
// a `spread` key in their registry row and kept the modifier, and of the three that do not --
// Haze, Perish Song, Make It Rain -- only the last deals damage. So the entire effect of the
// rule was Gholdengo's Make It Rain reading 132-156 where its 68 siblings read 99-117, decided
// by nothing but whether a CSV row happened to mention spreading. This engine mirrored that
// exception set exactly, through a `registry_spread` flag the exporter wrote for no other
// purpose.
//
// WHY THIS SUITE EXISTS AT ALL. `run-calc-vectors` holds 61 Doubles rows with a single target
// and a spread move, and not one of them could see this: 59 are among the 68, and of the two
// that are not, Perish Song deals no damage and the single Make It Rain row happens to be an
// Ampharos that rolls 0. Re-recording all 3000 after the fix moved NOT ONE NUMBER. A recording
// that large reads like coverage and was blind, so the rule is pinned here by hand instead.
//
// What is checked:
//
//   1. the exact numbers the Companion gives, pinned side by side -- Make It Rain among them;
//   2. THE INVARIANT, over every spread move the data has: one target, two targets and no
//      target count at all must all give the same answer, so no exception set can come back;
//   3. and the modifier is really still there -- Doubles below Singles for the damaging ones;
//   4. a move that is not a spread move is untouched in either format;
//   5. the mirror is gone from the source, not just quiet.
//
//   node tests/run-spread-modifier.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, makeMon, makeContext } from "../builder/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const engine = new DamageEngine(appData);

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const MONS = {
  Gholdengo: makeMon({
    pokemon_name: "Gholdengo", form_name: "Gholdengo", ability: "Good as Gold",
    nature_name: "Modest", bonuses: [2, 0, 0, 32, 0, 32],
  }),
  Garchomp: makeMon({
    pokemon_name: "Garchomp", form_name: "Garchomp", ability: "Rough Skin",
    nature_name: "Adamant", bonuses: [0, 32, 0, 0, 0, 32],
  }),
};

/** `targets` of null means the field is absent, as it is everywhere outside the panel. */
function range(attacker, defender, move, format, targets) {
  const fields = { move_name: move, battle_format: format, spread_move: false };
  if (targets !== null) fields.actual_spread_targets_v445 = targets;
  return engine.calculate(MONS[attacker], MONS[defender], makeContext(fields)).range;
}

/* --------------------------------------------- 1. the Companion's own numbers */

// Recorded from the app on 2026-11-01 with V547 installed, same mons, same contexts.
// Make It Rain is the move the rule used to miss: 99-117 at one target where it read 132-156.
const PINNED = [
  ["Gholdengo", "Garchomp", "Make It Rain", "Doubles", 1, "99-117"],
  ["Gholdengo", "Garchomp", "Make It Rain", "Doubles", 2, "99-117"],
  ["Gholdengo", "Garchomp", "Make It Rain", "Doubles", null, "99-117"],
  ["Gholdengo", "Garchomp", "Make It Rain", "Singles", 1, "132-156"],
  ["Gholdengo", "Garchomp", "Shadow Ball", "Doubles", 1, "88-105"],
  ["Gholdengo", "Garchomp", "Shadow Ball", "Singles", 1, "88-105"],
  ["Garchomp", "Gholdengo", "Earthquake", "Doubles", 1, "146-174"],
  ["Garchomp", "Gholdengo", "Earthquake", "Doubles", 2, "146-174"],
  ["Garchomp", "Gholdengo", "Earthquake", "Singles", 1, "198-234"],
  ["Garchomp", "Gholdengo", "Rock Slide", "Doubles", 1, "18-22"],
  ["Garchomp", "Gholdengo", "Rock Slide", "Singles", 1, "25-29"],
  ["Garchomp", "Gholdengo", "Dragon Claw", "Doubles", 1, "39-47"],
  ["Garchomp", "Gholdengo", "Dragon Claw", "Singles", 1, "39-47"],
];
for (const [attacker, defender, move, format, targets, want] of PINNED) {
  const got = range(attacker, defender, move, format, targets);
  ok(`${attacker} ${move} -> ${defender} ${format} t=${targets}`, got === want, `app=${want} web=${got}`);
}

/* ------------------------------------- 2+3. the invariant, over every spread move */

const spreadMoves = Object.keys(appData.moves || {}).filter((name) => appData.moves[name].spread).sort();
const withoutRegistryRow = spreadMoves.filter((name) => !appData.moves[name].registry_spread);
notes.push(`${spreadMoves.length} spread moves, ${withoutRegistryRow.length} with no \`spread\` in their registry row`
  + (withoutRegistryRow.length ? ` (${withoutRegistryRow.join(", ")})` : ""));

const uneven = [];
const unreduced = [];
for (const move of spreadMoves) {
  const one = range("Garchomp", "Gholdengo", move, "Doubles", 1);
  const two = range("Garchomp", "Gholdengo", move, "Doubles", 2);
  const none = range("Garchomp", "Gholdengo", move, "Doubles", null);
  if (one !== two || one !== none) uneven.push(`${move}: t1=${one} t2=${two} absent=${none}`);
  const singles = range("Garchomp", "Gholdengo", move, "Singles", 1);
  const top = (text) => Number(String(text).split("-").pop());
  // Status moves and anything the attacker cannot hurt this defender with roll 0 either way.
  if (top(singles) > 0 && !(top(one) < top(singles))) unreduced.push(`${move}: doubles=${one} singles=${singles}`);
}
ok(`one target, two targets and none agree for all ${spreadMoves.length} spread moves`,
  uneven.length === 0, uneven.slice(0, 6).join("; "));
ok("and every damaging one is still reduced in Doubles", unreduced.length === 0,
  unreduced.slice(0, 6).join("; "));

/* --------------------------------------------- 4. a move that is not a spread move */

const plainUntouched = [];
for (const move of ["Dragon Claw", "Shadow Ball", "Outrage", "Iron Head", "Crunch"]) {
  const doubles = range("Garchomp", "Gholdengo", move, "Doubles", 1);
  const singles = range("Garchomp", "Gholdengo", move, "Singles", 1);
  if (doubles !== singles) plainUntouched.push(`${move}: doubles=${doubles} singles=${singles}`);
}
ok("a single-target move reads the same in both formats", plainUntouched.length === 0,
  plainUntouched.join("; "));

/* --------------------------------------------- 5. the mirror is gone from the source */

const source = readFileSync(join(root, "builder", "engine.js"), "utf8");
ok("engine.js no longer reads `registry_spread`", !/registry_spread\s*\)/.test(source)
  && !/!\s*meta\.registry_spread/.test(source));
// The exporter still writes the flag and team-autobuild.js still reads it as an alias of
// `spread`; that is the only reader left, and this says so out loud.
const autobuild = readFileSync(join(root, "builder", "team-autobuild.js"), "utf8");
ok("team-autobuild.js is the only reader left", autobuild.includes("registry_spread"));

for (const note of notes) console.log(`   ${note}`);
console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
