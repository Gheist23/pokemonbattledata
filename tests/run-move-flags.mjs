// Every move carries the flags the game's own archive does not publish
// (builder/engine.js, the port of the app's move_flags_v527).
//
// Measured on the APP before anything changed: of the game's 954 moves, 855 carried no flags at
// all, and of the 577 damaging physical moves 531 had no `contact` flag. This port read the same
// data and so had the same hole -- Tackle, Crunch, Drain Punch, Night Slash and Double-Edge all
// answered with an empty list. Every mechanic that asks what KIND of move this is was therefore
// inert for the great majority of moves, in the Damage Calculator and in Team Evaluation alike:
//
//     Tough Claws into Crunch          x1.000   should be x1.3
//     Iron Fist into Drain Punch       x1.000   should be x1.2
//     Strong Jaw into Crunch           x1.000   should be x1.5
//     Sharpness into Night Slash       x1.000   should be x1.5
//     Reckless into Double-Edge        x1.000   should be x1.2
//     Mega Launcher into Water Pulse   x1.000   should be x1.5
//     Fluffy against Crunch            x1.000   should be x0.5
//     Punk Rock against Boomburst      x0.500   already worked -- `sound` was one of the few
//                                               flags the data did carry, for 11 of its 33 moves
//
// The game's archive cannot supply them: a move's CSV carries power, accuracy, PP and one
// sentence, and `Crunch.csv` says nothing about biting. `app-data.json.moveFlags` is compiled
// from the reference archive this project already uses to settle form ordering, which holds
// exactly the same 954 moves and does publish them, and is exported by the app's own
// `tools/export_web_builder_data.py` so the two codebases read one source.
//
// What is checked here:
//   1. the table: 479 moves and the measured count of each flag, from `app-data.json`;
//   2. the merge: a flag is only ever added, the shared base object is never written on, and a
//      move the archive does not name is left exactly as it was;
//   3. the eight abilities above, through the site's own engine, as a share of the plain roll;
//   4. the contact-dependent mechanics beyond damage -- Long Reach removes contact, a Punching
//      Glove removes it from a punch, and Unseen Fist goes through Protect;
//   5. the switch: with the rule off every one of them is inert again, which is what keeps the
//      recorded vectors green.
//
//   node tests/run-move-flags.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DamageEngine, MOVE_FLAGS_ON, compact, makeContext, makeMon, moveFlagsOption,
} from "../builder/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `${JSON.stringify(got)} != ${JSON.stringify(want)}`);

const engine = new DamageEngine(appData);
const engineOff = new DamageEngine(appData, { moveFlags: false });

// ---------------------------------------------------------------------------
// 1. the table
// ---------------------------------------------------------------------------
{
  const table = appData.moveFlags || {};
  ok("the data file carries the table", Object.keys(table).length > 0,
     "no `moveFlags` key -- re-export with tools/export_web_builder_data.py");
  eq("479 moves carry a flag", Object.keys(table).length, 479);
  const counts = {};
  for (const flags of Object.values(table)) {
    for (const flag of flags) counts[flag] = (counts[flag] || 0) + 1;
  }
  eq("and each flag is on the measured number of moves",
     Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]])),
     {
       ballistics: 26, bite: 10, contact: 278, crash: 4, dance: 12, powder: 8, pulse: 7,
       punch: 24, recoil: 12, secondary: 211, slicing: 26, sound: 33, wind: 17,
     });
  // every name in it is a move the site knows, or the entry is a silent no-op
  const unknown = Object.keys(table).filter((key) => !engine.moveByCompact.has(key));
  eq("every move it names is a real move", unknown, []);
  // the moves the defect was about
  eq("Tackle", table[compact("Tackle")], ["contact"]);
  eq("Crunch", table[compact("Crunch")], ["bite", "contact", "secondary"]);
  eq("Drain Punch", table[compact("Drain Punch")], ["contact", "punch"]);
  eq("Night Slash", table[compact("Night Slash")], ["contact", "slicing"]);
  eq("Double-Edge", table[compact("Double-Edge")], ["contact", "recoil"]);
  eq("Water Pulse", table[compact("Water Pulse")], ["pulse", "secondary"]);
  eq("High Jump Kick", table[compact("High Jump Kick")], ["contact", "crash"]);
  // Struggle is left out of Reckless, exactly as the game leaves it out
  ok("Struggle has no recoil flag", !(table[compact("Struggle")] || []).includes("recoil"));
  // and a special move never gains contact
  for (const name of ["Absorb", "Giga Drain", "Flamethrower", "Surf", "Thunderbolt", "Moonblast"]) {
    ok(`${name} does not make contact`, !(table[compact(name)] || []).includes("contact"));
  }
  notes.push(`table: ${Object.keys(table).length} moves, ${Object.values(table).flat().length} move/flag pairs`);
}

// ---------------------------------------------------------------------------
// 2. the merge
// ---------------------------------------------------------------------------
{
  const meta = engine.moveMeta(makeContext({ move_name: "Crunch", battle_format: "Doubles" }));
  eq("the flags reach the metadata", [...(meta.flags || [])].sort(),
     ["bite", "contact", "secondary"]);
  // Close Combat already had `contact` in the data, so nothing is withdrawn
  const already = engine.moveMeta(makeContext({ move_name: "Close Combat", battle_format: "Doubles" }));
  ok("a flag the data already had is kept", [...(already.flags || [])].includes("contact"),
     JSON.stringify(already.flags));
  // the shared base object is never written on
  const base = engine.moveMetaBase(engine.canonicalMoveName("Crunch"));
  ok("the shared base is left alone", !(base.flags || []).includes("bite"),
     `moveMetaBase was mutated: ${JSON.stringify(base.flags)}`);
  const again = engine.moveMeta(makeContext({ move_name: "Crunch", battle_format: "Doubles" }));
  eq("and a second read is the same", [...(again.flags || [])].sort(),
     ["bite", "contact", "secondary"]);
  // a move the archive does not name keeps exactly what it had
  const quake = engine.moveMeta(makeContext({ move_name: "Earthquake", battle_format: "Doubles" }));
  const quakeOff = engineOff.moveMeta(makeContext({ move_name: "Earthquake", battle_format: "Doubles" }));
  eq("a move with no flags is untouched", quake.flags ?? null, quakeOff.flags ?? null);
  // with the rule off, nothing is added
  const off = engineOff.moveMeta(makeContext({ move_name: "Crunch", battle_format: "Doubles" }));
  ok("with the rule off there are no flags", !(off.flags || []).length, JSON.stringify(off.flags));
  // the option reads like the others
  ok("the option is on by default", MOVE_FLAGS_ON === true);
  for (const value of [null, undefined, false, "", "0", "off", "false", "no", "none"]) {
    ok(`moveFlagsOption(${JSON.stringify(value)}) is off`, moveFlagsOption(value) === false);
  }
  for (const value of [true, 1, "1", "on", "yes"]) {
    ok(`moveFlagsOption(${JSON.stringify(value)}) is on`, moveFlagsOption(value) === true);
  }
}

// ---------------------------------------------------------------------------
// 3. the eight abilities, through the engine
// ---------------------------------------------------------------------------
const card = (ability, moves = ["Tackle", "Crunch", "Shadow Ball", "Drain Punch"]) => makeMon({
  pokemon_name: "Mew", form_name: "Mew", item: "Leftovers", ability,
  nature_name: "Serious", bonuses: [0, 0, 0, 0, 0, 0], moves,
});

const average = (which, attackAbility, defendAbility, move) => {
  const result = which.calculate(card(attackAbility), card(defendAbility),
    makeContext({ move_name: move, battle_format: "Doubles" }));
  const rolls = (result?.rolls || []).map(Number);
  return rolls.length ? rolls.reduce((a, b) => a + b, 0) / rolls.length : 0;
};

const CASES = [
  ["Tough Claws", "Synchronize", "Crunch", 1.3],
  ["Iron Fist", "Synchronize", "Drain Punch", 1.2],
  ["Strong Jaw", "Synchronize", "Crunch", 1.5],
  ["Sharpness", "Synchronize", "Night Slash", 1.5],
  ["Reckless", "Synchronize", "Double-Edge", 1.2],
  ["Mega Launcher", "Synchronize", "Water Pulse", 1.5],
  ["Synchronize", "Fluffy", "Crunch", 0.5],
  ["Synchronize", "Punk Rock", "Boomburst", 0.5],
];
{
  for (const [attackAbility, defendAbility, move, wanted] of CASES) {
    const plain = average(engine, "Synchronize", "Synchronize", move);
    const got = plain ? average(engine, attackAbility, defendAbility, move) / plain : 0;
    // Within 4%: the game truncates at each step, so an average roll lands just under.
    ok(`${attackAbility === "Synchronize" ? defendAbility : attackAbility} on ${move}`,
       Math.abs(got - wanted) / wanted < 0.04, `x${got.toFixed(3)} not x${wanted}`);
  }
  notes.push(`abilities: ${CASES.length} checked through the site's own engine`);
}

// ---------------------------------------------------------------------------
// 4. the contact mechanics that are not damage multipliers
// ---------------------------------------------------------------------------
{
  const plain = average(engine, "Synchronize", "Fluffy", "Crunch");
  const reach = average(engine, "Long Reach", "Fluffy", "Crunch");
  ok("Long Reach takes the contact away, so Fluffy does not halve",
     reach > plain * 1.9, `${plain.toFixed(2)} -> ${reach.toFixed(2)}`);
  // A Punching Glove removes contact from a punch and adds its own 1.1.
  const fist = engine.calculate(
    makeMon({ pokemon_name: "Mew", form_name: "Mew", item: "Punching Glove",
              ability: "Synchronize", nature_name: "Serious",
              bonuses: [0, 0, 0, 0, 0, 0], moves: ["Drain Punch"] }),
    card("Fluffy"), makeContext({ move_name: "Drain Punch", battle_format: "Doubles" }));
  const bare = engine.calculate(card("Synchronize", ["Drain Punch"]), card("Fluffy"),
    makeContext({ move_name: "Drain Punch", battle_format: "Doubles" }));
  const gloveRolls = (fist?.rolls || []).map(Number);
  const bareRolls = (bare?.rolls || []).map(Number);
  const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
  ok("a Punching Glove takes the contact off a punch",
     mean(gloveRolls) > mean(bareRolls) * 1.9,
     `${mean(bareRolls).toFixed(2)} -> ${mean(gloveRolls).toFixed(2)}`);
  // Unseen Fist reaches through Protect, and only a contact move does.
  const guarded = makeContext({ move_name: "Crunch", battle_format: "Doubles", protect: true });
  const through = engine.calculate(card("Unseen Fist"), card("Synchronize"), guarded);
  const blocked = engine.calculate(card("Synchronize"), card("Synchronize"), guarded);
  ok("Protect still blocks an ordinary move", (blocked?.rolls || []).every((v) => Number(v) === 0)
     || /protect/i.test(String(blocked?.summary || "") + String((blocked?.details || []).join(" "))),
     JSON.stringify(blocked?.summary));
  ok("Unseen Fist reaches through it with a contact move",
     (through?.rolls || []).some((v) => Number(v) > 0), JSON.stringify(through?.summary));
}

// ---------------------------------------------------------------------------
// 5. the switch replays the old numbers
// ---------------------------------------------------------------------------
{
  for (const [attackAbility, defendAbility, move, wanted] of CASES) {
    const plain = average(engineOff, "Synchronize", "Synchronize", move);
    const got = plain ? average(engineOff, attackAbility, defendAbility, move) / plain : 0;
    // Punk Rock is the one of the eight that already worked, because `sound` was
    // one of the few flags the data did carry.
    const expected = move === "Boomburst" ? wanted : 1;
    ok(`with the rule off, ${attackAbility === "Synchronize" ? defendAbility : attackAbility} on ${move} is as it was`,
       Math.abs(got - expected) / expected < 0.04, `x${got.toFixed(3)} not x${expected}`);
  }
}

for (const line of notes) console.log(line);
if (failures.length) {
  console.error(`\n${checked} checks, ${failures.length} failed:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\n${checked} checks, all passed.`);
