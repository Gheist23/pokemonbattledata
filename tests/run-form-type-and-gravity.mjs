// Two damage-engine clauses the Companion's rollout read and nothing else did.
//
// Both were in the compiled registry and both were honoured by the Companion's simulation
// engine, so each app disagreed with itself: a simulated turn applied them and every screen that
// reads a damage number did not.
//
//   Raging Bull  "This move's type depends on the user's form."  Priced as the Normal the move
//                table lists, so a Paldean breed lost its STAB and read the type chart wrongly
//                in both directions -- against a Ghost type it said "no effect" where a Fire or
//                Water breed lands, which inverts a KO verdict outright.
//   Grav Apple   "power is boosted by 50% when the Gravity status is active."
//
// What is checked here:
//
//   1. the stamps exist, default on, and switch off the way every other rule's reader does;
//   2. Raging Bull takes each breed's type, and with the rule off goes back to Normal;
//   3. the retyping is a real type and not a licence to hit: Fighting is as useless into a Ghost
//      type as Normal was;
//   4. Aura Wheel says the same sentence and is deliberately NOT retyped;
//   5. Grav Apple is half again as strong under Gravity and flat without it;
//   6. the data it reads really ships (`conditional_power_ops` in app-data.json);
//   7. a move with neither clause is untouched by either rule.
//
//   node tests/run-form-type-and-gravity.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DamageEngine, FORM_TYPE_ON, GRAVITY_POWER_ON, formTypeOption, gravityPowerOption,
  makeContext, makeMon,
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

const engineWith = (options) => new DamageEngine(appData, options);

/** One damage answer: the rolls and the details the calculator would show. */
function answer(engine, { species, form, move, defender, defenderForm, gravity = false, ability = "Intimidate" }) {
  const attacker = makeMon({
    pokemon_name: species, form_name: form, level: 50, item: "Leftovers",
    ability, nature_name: "Adamant", bonuses: [0, 0, 0, 0, 0, 0],
    moves: [move], current_hp_percent: 100,
  });
  const target = makeMon({
    pokemon_name: defender, form_name: defenderForm || defender, level: 50, item: "Leftovers",
    ability: "Intimidate", nature_name: "Adamant", bonuses: [0, 0, 0, 0, 0, 0],
    moves: ["Tackle"], current_hp_percent: 100,
  });
  const ctx = makeContext({ move_name: move, gravity });
  const result = engine.calculate(attacker, target, ctx);
  return {
    rolls: [...(result.rolls || [])],
    range: String(result.range || ""),
    said: (result.details || []).filter((d) => /Raging Bull:|power_if_gravity/.test(String(d))),
    all: (result.details || []).map(String),
  };
}

// ---------------------------------------------------------------------------
// 1. the stamps
// ---------------------------------------------------------------------------
{
  ok("FORM_TYPE_ON is on by default", FORM_TYPE_ON === true);
  ok("GRAVITY_POWER_ON is on by default", GRAVITY_POWER_ON === true);
  for (const off of [null, undefined, false, 0, "0", "off", "false", "no", "none", ""]) {
    ok(`formTypeOption(${JSON.stringify(off)}) is off`, formTypeOption(off) === false, String(formTypeOption(off)));
    ok(`gravityPowerOption(${JSON.stringify(off)}) is off`, gravityPowerOption(off) === false, String(gravityPowerOption(off)));
  }
  for (const on of [1, "1", true, "on", "yes"]) {
    ok(`formTypeOption(${JSON.stringify(on)}) is on`, formTypeOption(on) === true);
    ok(`gravityPowerOption(${JSON.stringify(on)}) is on`, gravityPowerOption(on) === true);
  }
  // An engine built with the rule off is what replays a recording made before it.
  ok("an engine can be built with form typing off", engineWith({ formType: 0 }).formType === false);
  ok("and with the Gravity boost off", engineWith({ gravityPower: 0 }).gravityPower === false);
  ok("and both are on by default", engineWith({}).formType === true && engineWith({}).gravityPower === true);
}

// ---------------------------------------------------------------------------
// 2, 3 & 4. Raging Bull
// ---------------------------------------------------------------------------
{
  const on = engineWith({});
  const off = engineWith({ formType: 0 });
  // Mega Greninja is Water/Dark: Normal is neutral into it and the Aqua Breed's Water is
  // RESISTED, so the typed move does less -- the direction that proves the type really changed
  // rather than that the move simply got better.
  const aqua = answer(on, { species: "Tauros", form: "Paldean Tauros Aqua Breed", move: "Raging Bull", defender: "Greninja", defenderForm: "Mega Greninja" });
  const aquaOff = answer(off, { species: "Tauros", form: "Paldean Tauros Aqua Breed", move: "Raging Bull", defender: "Greninja", defenderForm: "Mega Greninja" });
  ok("the Aqua Breed makes Raging Bull Water", aqua.said.some((d) => /makes it Water/.test(d)), JSON.stringify(aqua.said));
  ok("and with the rule off it says nothing", aquaOff.said.length === 0, JSON.stringify(aquaOff.said));
  ok("the typed move is resisted where the Normal one was not",
    aqua.rolls[0] < aquaOff.rolls[0], `${aqua.rolls[0]} vs ${aquaOff.rolls[0]}`);
  notes.push(`Raging Bull into Mega Greninja: ${aquaOff.range} as Normal, ${aqua.range} as the breed's Water`);

  // The inverted verdict: a Ghost type takes nothing at all from a Normal move.
  const blaze = answer(on, { species: "Tauros", form: "Paldean Tauros Blaze Breed", move: "Raging Bull", defender: "Gengar" });
  const ghostOff = answer(off, { species: "Tauros", form: "Paldean Tauros Blaze Breed", move: "Raging Bull", defender: "Gengar" });
  ok("a Ghost type takes nothing from the Normal pricing", ghostOff.range === "0-0", ghostOff.range);
  ok("and the Blaze Breed's Fire lands on it", blaze.rolls.length > 0 && blaze.rolls[0] > 0, blaze.range);
  ok("which it says", blaze.said.some((d) => /makes it Fire/.test(d)), JSON.stringify(blaze.said));

  // ...and the retyping is a real type: Fighting is as useless into a Ghost type as Normal was.
  const combatGhost = answer(on, { species: "Tauros", form: "Paldean Tauros Combat Breed", move: "Raging Bull", defender: "Gengar" });
  ok("the Combat Breed's Fighting still cannot touch a Ghost type", combatGhost.range === "0-0", combatGhost.range);
  // Grass/Steel resists Normal and is weak to Fighting, so there the breed does MORE.
  const steelOn = answer(on, { species: "Tauros", form: "Paldean Tauros Combat Breed", move: "Raging Bull", defender: "Ferrothorn" });
  const steelOff = answer(off, { species: "Tauros", form: "Paldean Tauros Combat Breed", move: "Raging Bull", defender: "Ferrothorn" });
  ok("and into Grass/Steel it does more than the Normal pricing",
    steelOn.rolls[0] > steelOff.rolls[0], `${steelOn.rolls[0]} vs ${steelOff.rolls[0]}`);

  // A plain Tauros carries no breed token, so nothing happens either way.
  const plain = answer(on, { species: "Tauros", form: "Tauros", move: "Raging Bull", defender: "Ferrothorn" });
  const plainOff = answer(off, { species: "Tauros", form: "Tauros", move: "Raging Bull", defender: "Ferrothorn" });
  ok("a formless Tauros is unaffected by the rule", plain.rolls[0] === plainOff.rolls[0] && plain.said.length === 0,
    `${plain.rolls[0]} vs ${plainOff.rolls[0]}`);

  // Aura Wheel says the same sentence and is deliberately not in the table: Morpeko has one
  // form in this game, so its listed Electric is already right.
  const wheel = answer(on, { species: "Morpeko", form: "Morpeko", move: "Aura Wheel", defender: "Ferrothorn" });
  const wheelOff = answer(off, { species: "Morpeko", form: "Morpeko", move: "Aura Wheel", defender: "Ferrothorn" });
  ok("Aura Wheel is deliberately not retyped", wheel.rolls[0] === wheelOff.rolls[0] && wheel.said.length === 0,
    `${wheel.rolls[0]} vs ${wheelOff.rolls[0]}`);
}

// ---------------------------------------------------------------------------
// 4b. an -ate Ability does not convert a move the form already typed
// ---------------------------------------------------------------------------
{
  // Pixilate converts a NORMAL move to Fairy and charges 1.2x for doing it. A Paldean breed's
  // Raging Bull is not a Normal move, so there is nothing to convert -- but the conversion ran
  // first and the form rule then overrode the type, leaving `_ate_converted` set: the move kept
  // a power boost for a conversion that had been thrown away, and the details claimed it had
  // become a type it had not become.
  const on = engineWith({});
  const breed = { species: "Tauros", form: "Paldean Tauros Aqua Breed", move: "Raging Bull", defender: "Ferrothorn" };
  const plainMon = { species: "Tauros", form: "Tauros", move: "Raging Bull", defender: "Ferrothorn" };

  const ate = answer(on, { ...breed, ability: "Pixilate" });
  const neutral = answer(on, { ...breed, ability: "Intimidate" });
  ok("the breed's type wins over Pixilate", ate.said.some((d) => /makes it Water/.test(d)), JSON.stringify(ate.said));
  ok("and Pixilate does not claim to have converted it",
    !ate.all.some((d) => /Normal move becomes/.test(d)), JSON.stringify(ate.all.filter((d) => /becomes/.test(d))));
  ok("so the 1.2x for that conversion is not charged",
    ate.rolls[0] === neutral.rolls[0], `${ate.rolls[0]} vs ${neutral.rolls[0]} (Pixilate vs a plain Ability)`);

  // ...and a formless Tauros really does have a Normal move, so -ate still applies to it.
  const plainAte = answer(on, { ...plainMon, ability: "Pixilate" });
  const plainNeutral = answer(on, { ...plainMon, ability: "Intimidate" });
  ok("a formless Tauros is still converted by Pixilate",
    plainAte.all.some((d) => /Normal move becomes Fairy/.test(d)), JSON.stringify(plainAte.all.filter((d) => /becomes/.test(d))));
  // ...and still charged the 1.2x for it. The converted move does LESS here, which is right and
  // is why the check is a ratio and not "more": Tauros is a Normal type, so converting its
  // Normal move to Fairy costs it STAB. Into Grass/Steel both types are resisted equally, so
  // the whole difference is 1.2 (the -ate boost) over 1.5 (the STAB it gave up) = 0.8. Without
  // the boost it would be 1/1.5 = 0.667, so this number is what proves the 1.2x is charged.
  ok("and is still charged the 1.2x for it",
    Math.abs(plainAte.rolls[0] / plainNeutral.rolls[0] - 0.8) < 0.02,
    `${plainAte.rolls[0]} / ${plainNeutral.rolls[0]} = ${(plainAte.rolls[0] / plainNeutral.rolls[0]).toFixed(3)}, expected 0.8`);
  notes.push(`Pixilate: breed ${ate.range} (unconverted, = ${neutral.range}), plain Tauros ${plainAte.range} vs ${plainNeutral.range}`);

  // Normalize is the other way round: it converts EVERY move and is charged its own 1.2x, so it
  // wins over the form. The Companion's V537 layer is ordered to agree with this.
  const norm = answer(on, { ...breed, ability: "Normalize" });
  ok("Normalize still wins over the form",
    !norm.said.some((d) => /makes it Water/.test(d)), JSON.stringify(norm.said));
}

// ---------------------------------------------------------------------------
// 5, 6 & 7. Grav Apple
// ---------------------------------------------------------------------------
{
  const record = (appData.moves || {})["Grav Apple"] || {};
  const ops = (record.conditional_power_ops || []).filter((op) => op && op.op === "power_if_gravity");
  ok("app-data.json carries the op the branch reads", ops.length === 1, JSON.stringify(record.conditional_power_ops));
  ok("and it asks for half again", ops[0] && ops[0].multiplier === 1.5, JSON.stringify(ops[0]));
  // The move-effects file is read by the TURN engine and never by the damage engine, so the op
  // must NOT be there as well -- it would be an op no reader consumes.
  const effects = JSON.parse(readFileSync(join(root, "data", "builder", "move-effects.json"), "utf8"));
  ok("and it is not shipped in move-effects.json, which no damage reader sees",
    !(effects.moveOps || []).includes("power_if_gravity"), "power_if_gravity is on WEB_MOVE_OPS");

  const on = engineWith({});
  const off = engineWith({ gravityPower: 0 });
  const up = answer(on, { species: "Appletun", form: "Appletun", move: "Grav Apple", defender: "Garchomp", gravity: true });
  const flat = answer(on, { species: "Appletun", form: "Appletun", move: "Grav Apple", defender: "Garchomp", gravity: false });
  const upOff = answer(off, { species: "Appletun", form: "Appletun", move: "Grav Apple", defender: "Garchomp", gravity: true });
  ok("Gravity raises the move", up.rolls[0] > flat.rolls[0], `${up.rolls[0]} vs ${flat.rolls[0]}`);
  ok("by about half again", Math.abs(up.rolls[0] / flat.rolls[0] - 1.5) < 0.1, String(up.rolls[0] / flat.rolls[0]));
  ok("and it says so", up.said.some((d) => /power_if_gravity/.test(d)), JSON.stringify(up.said));
  ok("without Gravity it says nothing", flat.said.length === 0, JSON.stringify(flat.said));
  ok("and with the rule off Gravity changes nothing",
    upOff.rolls[0] === flat.rolls[0] && upOff.said.length === 0, `${upOff.rolls[0]} vs ${flat.rolls[0]}`);
  notes.push(`Grav Apple into Garchomp: ${flat.range} flat, ${up.range} under Gravity`);

  // A move with no such clause is untouched by Gravity, which is the control for the whole loop.
  const otherUp = answer(on, { species: "Appletun", form: "Appletun", move: "Apple Acid", defender: "Garchomp", gravity: true });
  const otherFlat = answer(on, { species: "Appletun", form: "Appletun", move: "Apple Acid", defender: "Garchomp", gravity: false });
  ok("a move without the clause is unaffected by Gravity",
    otherUp.rolls[0] === otherFlat.rolls[0], `${otherUp.rolls[0]} vs ${otherFlat.rolls[0]}`);
}

for (const note of notes) console.log(`   ${note}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(`\n${checked} checked, ${failures.length} failed.`);
process.exit(failures.length ? 1 : 0);
