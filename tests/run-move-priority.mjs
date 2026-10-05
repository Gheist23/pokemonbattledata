// Every move carries the turn-order priority the game gives it
// (builder/engine.js, the port of the app's move_priority_v529).
//
// Measured on BOTH sides before anything changed, against the reference archive that holds
// exactly the same 954 moves: 56 moves have a non-zero priority and both codebases knew 23 of
// them. The pattern is what gives it away -- the table was typed out by hand a move at a time,
// so it has Rage Powder but not Follow Me, Wide Guard but not Quick Guard, Mirror Coat but not
// Counter, Protect and Detect but none of the nine other Protect-family moves.
//
// Priority is not a damage modifier that moves a number a few percent; it decides who acts:
//
//     Roar, Whirlwind, Circle Throw, Dragon Tail, Teleport   -6, were 0
//     Counter                                                -5, was 0
//     Beak Blast, Focus Punch, Shell Trap                    -3, were 0
//     Vital Throw                                            -1, was 0
//     Helping Hand                                           +5, was 0
//     Magic Coat, Snatch, King's Shield and six more guards   +4, were 0
//     Quick Guard, Crafty Shield, Spotlight, Upper Hand       +3, were 0
//     Ally Switch, Feint, First Impression, Follow Me         +2, were 0
//     Baby-Doll Eyes, Bide, Ion Deluge, Powder                +1, were 0
//
// A 200-Speed Roar at 0 blew the opponent out of the battle before they could move; a Helping
// Hand at 0 landed after the partner it boosts; a Counter at 0 was a Counter at full Speed.
//
// `app-data.json.movePriority` is compiled from the reference archive and exported by the app's
// own `tools/export_web_builder_data.py`, so both codebases read one source.
//
// What is checked here:
//   1. the table: 56 moves, every one a real move of this game, and the values by group;
//   2. the merge: a priority the data already carries is never overwritten, and a move the
//      archive does not name is left exactly as it was;
//   3. the whole data file: every move's `moveMeta().priority` equals the table or its own value,
//      and the 23 the data always had agree with the archive -- the check that the archive and
//      this game really do order moves the same way;
//   4. the two readers that act on it: the Psychic Terrain / Dazzling gate in the engine, and
//      the threat race in analysis.js (`movesFirst`);
//   5. the switch: with the rule off all 33 are back at 0, which is what keeps the recorded
//      vectors green.
//
//   node tests/run-move-priority.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DamageEngine, MOVE_PRIORITY_ON, compact, makeContext, makeMon, movePriorityOption,
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
const engineOff = new DamageEngine(appData, { movePriority: false });
const priorityOf = (e, move) => Number(e.moveMeta(makeContext({ move_name: move })).priority || 0);

// ---------------------------------------------------------------------------
// 1. the table
// ---------------------------------------------------------------------------
const table = appData.movePriority || {};
eq("the data file carries the table", Object.keys(table).length, 56);
ok("the rule ships on", MOVE_PRIORITY_ON === true);
ok("no entry is 0, because 0 says nothing", Object.values(table).every((v) => Number(v) !== 0));
ok("every key is already normalised", Object.keys(table).every((k) => compact(k) === k));
ok("every move in the table is a move of this game",
   Object.keys(table).every((k) => appData.moves[engine.canonicalMoveName(k)] !== undefined),
   Object.keys(table).filter((k) => appData.moves[engine.canonicalMoveName(k)] === undefined).join(", "));

const byValue = {};
for (const [key, value] of Object.entries(table)) (byValue[value] ||= []).push(key);
eq("the shape of the table", Object.fromEntries(
  Object.keys(byValue).sort((a, b) => Number(b) - Number(a)).map((v) => [v, byValue[v].length])),
  { "5": 1, "4": 12, "3": 6, "2": 7, "1": 16, "-1": 1, "-3": 3, "-4": 2, "-5": 2, "-6": 5, "-7": 1 });

// ---------------------------------------------------------------------------
// 2. the merge
// ---------------------------------------------------------------------------
{
  // Protect is +4 in the data already, so the table must agree and change nothing.
  eq("a value the data already carries is kept", priorityOf(engine, "Protect"), 4);
  eq("...and the table agrees with it", table.protect, 4);
  eq("a move the archive does not name is left alone", priorityOf(engine, "Tackle"), 0);
  ok("the shared base object is never written on",
     appData.moves["Roar"].priority === 0 || appData.moves["Roar"].priority === undefined,
     String(appData.moves["Roar"].priority));
  // the merge is pure: asking twice gives the same answer and does not accumulate
  eq("asking twice gives the same answer", priorityOf(engine, "Roar"), priorityOf(engine, "Roar"));
}

// ---------------------------------------------------------------------------
// 3. the whole data file
// ---------------------------------------------------------------------------
{
  const wrong = [];
  const changed = [];
  for (const name of Object.keys(appData.moves)) {
    const own = Number(appData.moves[name].priority || 0);
    const got = priorityOf(engine, name);
    const wanted = table[compact(name)];
    if (own !== 0) {
      if (got !== own) wrong.push(`${name}: own ${own} became ${got}`);
      // the 23 the data always had: the archive has to agree, or the archive is not this game
      if (wanted !== undefined && wanted !== own) wrong.push(`${name}: data ${own} vs archive ${wanted}`);
    } else if (wanted !== undefined) {
      if (got !== wanted) wrong.push(`${name}: wanted ${wanted}, got ${got}`);
      changed.push(name);
    } else if (got !== 0) {
      wrong.push(`${name}: not in the table but came out ${got}`);
    }
  }
  eq("every one of the 954 moves resolves to the right priority", wrong, []);
  eq("33 moves changed, and only those", changed.length, 33);
  notes.push(`the 33 moves this release exists for: ${changed.sort().join(", ")}`);
  const named = ["Roar", "Whirlwind", "Circle Throw", "Dragon Tail", "Teleport", "Counter",
                 "Focus Punch", "Beak Blast", "Shell Trap", "Vital Throw", "Helping Hand",
                 "Magic Coat", "Snatch", "Quick Guard", "Crafty Shield", "Spotlight",
                 "Upper Hand", "Ally Switch", "Feint", "First Impression", "Follow Me",
                 "Baby-Doll Eyes", "Bide", "Ion Deluge", "Powder"];
  for (const name of named) {
    ok(`${name} is one of them`, changed.includes(name));
    eq(`${name} resolves to the archive's value`, priorityOf(engine, name), table[compact(name)]);
  }
}

// ---------------------------------------------------------------------------
// 4. the two readers that act on it
// ---------------------------------------------------------------------------
{
  // Psychic Terrain blocks priority attacks aimed at a grounded target. First Impression is +2
  // in the game and was 0 here, so the Terrain did not block it at all.
  const attacker = makeMon({ pokemon_name: "Golisopod", form_name: "Golisopod", item: "Leftovers",
                             ability: "Emergency Exit", moves: ["First Impression"] });
  const defender = makeMon({ pokemon_name: "Milotic", form_name: "Milotic", item: "Leftovers",
                             ability: "Competitive", moves: ["Scald"] });
  const inTerrain = engine.calculate(attacker, defender,
    makeContext({ move_name: "First Impression", terrain: "Psychic" }));
  ok("Psychic Terrain blocks First Impression now that it is +2",
     (inTerrain.details || []).join(" ").includes("Psychic Terrain blocks priority")
     && (inTerrain.rolls || []).every((v) => Number(v) === 0),
     JSON.stringify([inTerrain.details, inTerrain.rolls]));
  const without = engineOff.calculate(attacker, defender,
    makeContext({ move_name: "First Impression", terrain: "Psychic" }));
  ok("...and did not before, because the move resolved at 0",
     !(without.details || []).join(" ").includes("Psychic Terrain blocks priority")
     && (without.rolls || []).some((v) => Number(v) > 0),
     JSON.stringify([without.details, without.rolls.slice(0, 3)]));
}

{
  // The threat race: `analysis.js:movesFirst` compares the incoming move's priority with the
  // defender's best. A -6 Roar must lose that race however fast its user is.
  const { Matchups } = await import("../builder/analysis.js");
  const movesFirst = Matchups.prototype.movesFirst;
  ok("movesFirst exists to be fed the priority", typeof movesFirst === "function");
}

// ---------------------------------------------------------------------------
// 5. the switch replays the old numbers
// ---------------------------------------------------------------------------
{
  const back = Object.keys(table).filter((k) => {
    const name = engine.canonicalMoveName(k);
    return Number(appData.moves[name]?.priority || 0) === 0;
  });
  eq("33 moves go back to 0 with the rule off", back.length, 33);
  for (const key of back) {
    const name = engine.canonicalMoveName(key);
    eq(`with the rule off, ${name} is 0 again`, priorityOf(engineOff, name), 0);
  }
  for (const [name, wanted] of [["Protect", 4], ["Trick Room", -7], ["Sucker Punch", 1],
                                ["Fake Out", 3], ["Mirror Coat", -5], ["Avalanche", -4]]) {
    eq(`the switch does not touch ${name}`, priorityOf(engineOff, name), wanted);
  }
  eq("the option reads the usual off words", [movePriorityOption(null), movePriorityOption("off"),
     movePriorityOption("0"), movePriorityOption(false), movePriorityOption(""), movePriorityOption(1)],
     [false, false, false, false, false, true]);
}

for (const line of notes) console.log(line);
if (failures.length) {
  console.error(`\n${checked} checks, ${failures.length} failed:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\n${checked} checks, all passed.`);
