// The damage engine NAMES the modifiers it applies (builder/engine.js, V548).
//
// Four multipliers reached every damage roll with a label attached and the label thrown away.
// The app built `[("Spread move", 0.75), ("Sun", 1.5), ("Rain", 0.5), ("Critical", 1.5)]` and
// spent it as `for _label, modifier in general_mods` (`part_022.py:1383`); this engine did the
// same at `generalMods`. Three of the four have a control somewhere on the panel, so a user
// could at least guess; the spread reduction has none -- its only input is the Singles/Doubles
// switch, and nothing said that switching to Doubles takes a quarter off every spread move.
//
// Both engines now publish one `details` entry per applied modifier and the joined
// `modifier_line`, and `run-calc-vectors` compares that field on all 3000 recorded vectors.
//
// WHY THIS SUITE AS WELL. The line is only worth having if it is true where it is hardest to
// be true, and the recorded vectors do not reach those places:
//
//   1. a SUPPRESSED weather must not be named. Air Lock, Cloud Nine and Utility Umbrella blank
//      the weather, and the app reads the blanked value because its wrapper sits inside the one
//      try block where `ctx.weather` holds it (`part_022.py:1192`). A line built from the raw
//      context would announce a Sun boost that was never applied;
//   2. a REFUSED crit must not be named. Battle Armor and Shell Armor mean no critical hit, so
//      the Crit button and the five always-crit moves name nothing against those defenders;
//   3. and every line is pinned to the number beside it, recorded from the app on 2026-11-01,
//      so a wrong multiplier cannot hide behind a right-looking label.
//
//   node tests/run-modifier-line.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, makeMon, makeContext, modifierLine, MODIFIER_PREFIX, MODIFIER_SEPARATOR } from "../builder/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const engine = new DamageEngine(appData);

let checked = 0;
const failures = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const mon = (name, ability, item = "") => makeMon({
  pokemon_name: name, form_name: name, ability, item,
  nature_name: "Serious", bonuses: [0, 0, 0, 0, 0, 0],
});

function run(attacker, defender, move, fields) {
  return engine.calculate(attacker, defender, makeContext({ move_name: move, spread_move: false, ...fields }));
}

/* ------------------------------------------- 1. the app's own lines, with their numbers */

// Recorded from the Companion on 2026-11-01 with V548 installed: same species, same abilities,
// Serious nature, no stat points, no items unless named. `range` is pinned beside every line so
// a label cannot be right while the multiplier behind it is wrong.
const PINNED = [
  ["Garchomp/Rough Skin", "Gholdengo/Good as Gold", "Earthquake", { battle_format: "Singles" }, "150-176", ""],
  ["Garchomp/Rough Skin", "Gholdengo/Good as Gold", "Earthquake", { battle_format: "Doubles" }, "110-132", "Spread move ×0.75"],
  ["Garchomp/Rough Skin", "Gholdengo/Good as Gold", "Earthquake", { battle_format: "Doubles", critical: true }, "168-198", "Spread move ×0.75  ·  Critical ×1.5"],
  ["Greninja/Protean", "Gholdengo/Good as Gold", "Surf", { battle_format: "Singles", weather: "Rain" }, "84-100", "Rain ×1.5"],
  ["Charizard/Blaze", "Gholdengo/Good as Gold", "Flamethrower", { battle_format: "Singles", weather: "Rain" }, "60-72", "Rain ×0.5"],
  ["Charizard/Blaze", "Gholdengo/Good as Gold", "Flamethrower", { battle_format: "Singles", weather: "Sun" }, "182-216", "Sun ×1.5"],
  // 1. the suppressed weather: the number is the no-weather one and the line says nothing.
  ["Charizard/Blaze", "Gholdengo/Good as Gold/Utility Umbrella", "Flamethrower", { battle_format: "Singles", weather: "Rain" }, "120-144", ""],
  ["Charizard/Blaze", "Rayquaza/Air Lock", "Flamethrower", { battle_format: "Singles", weather: "Rain" }, "93-111", ""],
  // 2. the refused crit, both halves: the Crit button and a move that always crits.
  ["Garchomp/Rough Skin", "Blissey/Natural Cure", "Surging Strikes", { battle_format: "Singles" }, "93-111", "Critical ×1.5"],
  ["Garchomp/Rough Skin", "Torkoal/Shell Armor", "Surging Strikes", { battle_format: "Singles" }, "60-72", ""],
  ["Garchomp/Rough Skin", "Torkoal/Battle Armor", "Earthquake", { battle_format: "Doubles", critical: true }, "80-96", "Spread move ×0.75"],
];
for (const [attackerSpec, defenderSpec, move, fields, wantRange, wantLine] of PINNED) {
  const [aName, aAbility, aItem] = attackerSpec.split("/");
  const [dName, dAbility, dItem] = defenderSpec.split("/");
  const result = run(mon(aName, aAbility, aItem || ""), mon(dName, dAbility, dItem || ""), move, fields);
  const label = `${aName} ${move} -> ${dName} ${JSON.stringify(fields)}`;
  ok(`${label} range`, result.range === wantRange, `app=${wantRange} web=${result.range}`);
  ok(`${label} line`, result.modifier_line === wantLine, `app=${JSON.stringify(wantLine)} web=${JSON.stringify(result.modifier_line)}`);
}

/* ------------------------------------------- 2. the line is derived, never invented */

// The `details` entries ARE the source; the line is the same text joined. If these two could
// disagree, the page could show a modifier the calculation never had.
const sample = run(mon("Garchomp", "Rough Skin"), mon("Gholdengo", "Good as Gold"), "Earthquake",
  { battle_format: "Doubles", critical: true });
const entries = (sample.details || []).filter((text) => String(text).startsWith(MODIFIER_PREFIX));
ok("one details entry per named modifier", entries.length === 2, JSON.stringify(entries));
ok("the line is exactly those entries joined",
  sample.modifier_line === entries.map((t) => String(t).slice(MODIFIER_PREFIX.length)).join(MODIFIER_SEPARATOR),
  `${JSON.stringify(sample.modifier_line)} vs ${JSON.stringify(entries)}`);
ok("modifierLine() ignores every other detail",
  modifierLine(["Attack used: 405", "Reflect active", `${MODIFIER_PREFIX}Rain ×0.5`]) === "Rain ×0.5");
ok("and returns empty for a result that applied none", modifierLine(["Attack used: 405"]) === "");

/* ------------------------------------------- 3. a status move and an immune target say nothing */

for (const [move, fields, why] of [
  ["Swords Dance", { battle_format: "Doubles" }, "a status move never reaches the formula"],
  // The shape `run-calc-vectors` caught on the first run after V548 was written: three vectors
  // (Tail Whip, Sand Attack, Work Up) thrown in Doubles with `spread_move` set had the app
  // naming a 0.75 spread reduction on a move that deals no damage. This engine was right by
  // accident of structure -- its status return happens before `generalMods` exists -- so the
  // case is pinned here rather than left to the three random vectors that found it.
  ["Tail Whip", { battle_format: "Doubles", spread_move: true }, "a status move with spread_move set"],
  ["Work Up", { battle_format: "Doubles", spread_move: true, critical: true }, "the same with the crit on"],
  ["Seismic Toss", { battle_format: "Doubles", critical: true }, "fixed damage never reaches the formula"],
]) {
  const result = run(mon("Garchomp", "Rough Skin"), mon("Gholdengo", "Good as Gold"), move, fields);
  ok(`${move}: ${why}`, result.modifier_line === "", JSON.stringify(result.modifier_line));
}
const immune = run(mon("Garchomp", "Rough Skin"), mon("Charizard", "Blaze"), "Earthquake", { battle_format: "Doubles" });
ok("an airborne target is named as immune, not as reduced", immune.modifier_line === "",
  JSON.stringify([immune.range, immune.modifier_line]));

/* ------------------------------------------- 4. every spread move names the reduction */

const spreadMoves = Object.keys(appData.moves || {}).filter((name) => appData.moves[name].spread).sort();
const unnamed = [];
for (const move of spreadMoves) {
  const result = run(mon("Garchomp", "Rough Skin"), mon("Blissey", "Natural Cure"), move, { battle_format: "Doubles" });
  const reduced = Number(String(result.range).split("-").pop()) > 0;
  const named = String(result.modifier_line || "").includes("Spread move ×0.75");
  if (reduced !== named) unnamed.push(`${move}: range=${result.range} line=${JSON.stringify(result.modifier_line)}`);
}
ok(`all ${spreadMoves.length} spread moves name the 0.75 exactly when they take it`,
  unnamed.length === 0, unnamed.slice(0, 6).join("; "));

/* ------------------------------------------- 5. the calc page shows it */

const page = readFileSync(join(root, "builder", "calc-page.js"), "utf8");
ok("calc-page.js renders the line", page.includes("modifier_line"));

console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
