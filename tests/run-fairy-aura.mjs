// Fairy Aura in the damage engine (builder/engine.js).
//
// The game's own text, as the compiled registry has it: "Boosts the power of the Fairy-type
// moves of all Pokemon on the field by 33%." Neither codebase applied it anywhere a person
// could see: the compiled op `field_type_power` had exactly ONE reader in the whole project,
// the Companion's rollout, so the Damage Calculator, Team Evaluation, the threat matrix and
// Suggestions were all a third low on every Fairy cell involving Mega Floette -- its own
// Moonblast and anyone else's Fairy move thrown at it alike.
//
// Its only holder is MEGA FLOETTE. The base Floette carries Flower Veil and Symbiosis, so the
// Ability is reached through the stone and `effectiveMegaMon` has to resolve both mons first.
//
// What is checked here:
//
//   1. the rule gate: FAIRY_AURA_ON is on, and an engine built with it off gives the old number;
//   2. no aura on the field changes nothing, and a non-Fairy move is never lifted;
//   3. BOTH SIDES lift: the defender's aura and the attacker's, the latter only reachable
//      through the stone;
//   4. a Normal move Pixilate has turned Fairy is lifted, one that stays Normal is not;
//   5. IT DOES NOT STACK: two holders on the field are one multiplier, not two;
//   6. the exact numbers the Companion gives, pinned side by side -- this is a parity rule and
//      a drift of one point is the whole thing it has to catch.
//
//   node tests/run-fairy-aura.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, makeMon, makeContext, FAIRY_AURA_ON, fairyAuraOption } from "../builder/engine.js";

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

const mon = (species, form, item, ability, moves) => makeMon({
  pokemon_name: species, form_name: form, item, ability, nature_name: "Modest",
  bonuses: [0, 0, 2, 32, 32, 0], moves, current_hp_percent: 100,
});

const FLO = mon("Floette", "Floette", "Floettite", "Flower Veil",
  ["Moonblast", "Dazzling Gleam", "Protect", "Moonlight"]);
const SYL = mon("Sylveon", "Sylveon", "Leftovers", "Pixilate",
  ["Hyper Voice", "Moonblast", "Protect", "Wish"]);
const SYL_PLAIN = mon("Sylveon", "Sylveon", "Leftovers", "Cute Charm",
  ["Hyper Voice", "Moonblast", "Protect", "Wish"]);
const CHOMP = mon("Garchomp", "Garchomp", "Leftovers", "Rough Skin",
  ["Earthquake", "Protect", "Dragon Claw", "Rock Slide"]);

function engineWith(fairyAura) {
  const e = new DamageEngine(appData);
  e.fairyAura = fairyAuraOption(fairyAura);
  return e;
}

const roll = (e, a, d, move) => e.calculate(a, d, makeContext({ move_name: move })).range;
const low = (range) => Number(String(range).split("-")[0]);

// ---------------------------------------------------------------------------
// 1. the stone, and the rule gate
// ---------------------------------------------------------------------------
{
  const e = engineWith(true);
  const id = e.megaIdentityForMon(FLO);
  ok("the stone resolves Floette to its Mega", id.form_name === "Mega Floette", id.form_name);
  ok("and the Mega is the one carrying Fairy Aura", id.ability === "Fairy Aura", id.ability);
  // The trap worth stating: the RAW mon does not have it, so anything reading the un-resolved
  // Ability would never fire. That is exactly how the attacker-side half was first missed.
  ok("while the raw Floette does not", FLO.ability === "Flower Veil", FLO.ability);

  ok("FAIRY_AURA_ON is on", FAIRY_AURA_ON === true, String(FAIRY_AURA_ON));
  ok("an engine built with the default has it on", new DamageEngine(appData).fairyAura === true);
  ok("and the option reader turns it off for an older recording",
    engineWith(null).fairyAura === false && engineWith("0").fairyAura === false);
  notes.push(`Floettite -> ${id.form_name} / ${id.ability}`);
}

// ---------------------------------------------------------------------------
// 2-5. the seven cases
// ---------------------------------------------------------------------------
{
  const on = engineWith(true);
  const off = engineWith(false);
  const cases = [
    ["no aura on the field", SYL, CHOMP, "Moonblast", false],
    ["the DEFENDER's aura", SYL, FLO, "Moonblast", true],
    ["the ATTACKER's aura, via the stone", FLO, CHOMP, "Moonblast", true],
    ["a Ground move into the holder", CHOMP, FLO, "Earthquake", false],
    ["a Normal move Pixilate turned Fairy", SYL, FLO, "Hyper Voice", true],
    ["a Normal move that stays Normal", SYL_PLAIN, FLO, "Hyper Voice", false],
    ["two holders on the field", FLO, FLO, "Moonblast", true],
  ];
  for (const [label, a, d, move, lifted] of cases) {
    const before = roll(off, a, d, move);
    const after = roll(on, a, d, move);
    if (lifted) {
      ok(`${label} is lifted`, low(after) > low(before), `${before} -> ${after}`);
      const factor = low(after) / low(before);
      ok(`${label} is lifted by about a third`, factor > 1.28 && factor < 1.36,
        `x${factor.toFixed(3)} (${before} -> ${after})`);
    } else {
      ok(`${label} is NOT lifted`, after === before, `${before} -> ${after}`);
    }
    notes.push(`${label.padEnd(36)} ${String(before).padEnd(9)} -> ${after}`);
  }

  // It does not stack. Two holders standing is ONE multiplier: 1.33 squared would be 1.77, and
  // that is the number this has to exclude rather than merely "something changed".
  const bothBefore = low(roll(off, FLO, FLO, "Moonblast"));
  const bothAfter = low(roll(on, FLO, FLO, "Moonblast"));
  ok("two auras do not stack", bothAfter / bothBefore < 1.5,
    `x${(bothAfter / bothBefore).toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 6. the Companion's own numbers, pinned
// ---------------------------------------------------------------------------
{
  // Recorded from the Companion with the layer on and off (tests/test_fairy_aura_v542.py holds
  // the same table). The two engines chain the multiplier in 4096ths and round once, so they
  // agree exactly -- applying it to the finished power instead would round twice and drift by
  // a point, and a point turns a guaranteed KO into a roll.
  const PINNED = [
    ["Sylveon Moonblast -> Garchomp", SYL, CHOMP, "Moonblast", "140-168", "140-168"],
    ["Sylveon Moonblast -> Mega Floette", SYL, FLO, "Moonblast", "49-58", "64-76"],
    ["Mega Floette Moonblast -> Garchomp", FLO, CHOMP, "Moonblast", "180-212", "236-278"],
    ["Garchomp Earthquake -> Mega Floette", CHOMP, FLO, "Earthquake", "52-63", "52-63"],
    ["Sylveon(Pixilate) Hyper Voice -> Floette", SYL, FLO, "Hyper Voice", "42-49", "54-64"],
    ["Sylveon(Cute Charm) Hyper Voice -> Floette", SYL_PLAIN, FLO, "Hyper Voice", "23-28", "23-28"],
    ["Mega Floette Moonblast -> Mega Floette", FLO, FLO, "Moonblast", "61-73", "81-96"],
  ];
  const on = engineWith(true);
  const off = engineWith(false);
  for (const [label, a, d, move, expectOff, expectOn] of PINNED) {
    ok(`${label}, rule off, matches the Companion`, roll(off, a, d, move) === expectOff,
      `${roll(off, a, d, move)} vs ${expectOff}`);
    ok(`${label}, rule on, matches the Companion`, roll(on, a, d, move) === expectOn,
      `${roll(on, a, d, move)} vs ${expectOn}`);
  }
}

// ---------------------------------------------------------------------------

if (notes.length) notes.forEach((n) => console.log(`  ${n}`));
if (failures.length) {
  failures.forEach((f) => console.log(`FAIL ${f}`));
  console.log(`${checked} checked, ${failures.length} failed.`);
  process.exit(1);
}
console.log(`${checked} checked, 0 failed.`);
