// Weight, and the four moves whose power IS a weight (builder/engine.js).
//
// THE FINDING, measured 3 Nov 2026: Low Kick, Grass Knot, Heavy Slam and Heat Crash all list
// power 0 in the move table -- their power comes off the scales -- and the two operations that
// supply it were stripped by the exporter, so `app-data.json` carried `power: 0` and no ops at
// all. **All four dealt nothing. 227 appearances across the registered teams**, Low Kick alone
// 206.
//
// The weights were there the whole time: `app-data.json` has one for 355 of the game's 358
// forms, in kilograms (Mimikyu 0.7, Mudsdale 920, Mega Metagross 942.9).
//
// They ride on `conditional_power_ops` and NOT in move-effects.json, because their reader is the
// damage engine and that engine is never handed the effects registry -- the same reasoning the
// exporter already records for `power_if_gravity`. Heavy Metal and Light Metal reach it through
// a small `abilityWeights` table for the same reason.
//
//   node tests/run-weight.mjs
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

const mon = (name, ability = "", form = null) => makeMon({
  pokemon_name: name, form_name: form || name, ability,
  nature_name: "Serious", bonuses: [0, 0, 0, 0, 0, 0],
});

/* -------------------------------------------- 1. the data is there */
{
  const forms = appData.species.flatMap((s) => s.forms);
  const weighed = forms.filter((f) => Number(f.weight) > 0);
  ok("nearly every form carries a weight", weighed.length >= forms.length - 5,
    `${weighed.length} of ${forms.length}`);
  ok("and they are kilograms, not some other unit",
    Math.abs(engine.weightOf(mon("Mimikyu")) - 0.7) < 0.1
    && engine.weightOf(mon("Mudsdale")) > 900,
    `${engine.weightOf(mon("Mimikyu"))} / ${engine.weightOf(mon("Mudsdale"))}`);
  notes.push(`weights: ${weighed.length} of ${forms.length} forms`);
}

/* -------------------------------------------- 2. the two Abilities */
{
  ok("the exporter ships the Ability weights",
    appData.abilityWeights && appData.abilityWeights["Heavy Metal"] === 2
    && appData.abilityWeights["Light Metal"] === 0.5,
    JSON.stringify(appData.abilityWeights));
  const plain = engine.weightOf(mon("Mudsdale"));
  ok("Heavy Metal doubles it",
    Math.abs(engine.weightOf(mon("Mudsdale", "Heavy Metal")) - plain * 2) < 1e-6);
  ok("Light Metal halves it",
    Math.abs(engine.weightOf(mon("Mudsdale", "Light Metal")) - plain / 2) < 1e-6);
  ok("and nothing weighs less than the floor", engine.weightOf(mon("Nonexistent Pokemon")) >= 0.1);
}

/* -------------------------------------------- 3. the tables, exactly as the Companion has them */
{
  for (const [kg, want] of [[5, 20], [9.9, 20], [10, 40], [24.9, 40], [25, 60], [49.9, 60],
    [50, 80], [99.9, 80], [100, 100], [199.9, 100], [200, 120], [1000, 120]]) {
    ok(`${kg} kg is ${want} BP`, engine.weightPower(kg) === want, String(engine.weightPower(kg)));
  }
  for (const [mine, theirs, want] of [[500, 100, 120], [400, 100, 100], [300, 100, 80],
    [200, 100, 60], [199, 100, 40], [50, 100, 40]]) {
    ok(`${mine}:${theirs} is ${want} BP`, engine.weightRatioPower(mine, theirs) === want,
      String(engine.weightRatioPower(mine, theirs)));
  }
}

/* -------------------------------------------- 4. the ops reach app-data */
{
  for (const [name, op] of [["Low Kick", "power_by_target_weight"], ["Grass Knot", "power_by_target_weight"],
    ["Heavy Slam", "power_by_weight_ratio"], ["Heat Crash", "power_by_weight_ratio"]]) {
    const ops = appData.moves[name]?.conditional_power_ops || [];
    ok(`${name} carries ${op}`, ops.some((e) => e.op === op), JSON.stringify(ops));
  }
}

/* -------------------------------------------- 5. and the damage really lands */
{
  const heavy = mon("Mudsdale");
  const light = mon("Mimikyu");
  const calc = (att, def, move) => engine.calculate(att, def,
    makeContext({ move_name: move, battle_format: "Singles" }));

  // Low Kick into something heavy: 120 BP, so a real number.
  const big = calc(light, heavy, "Low Kick");
  ok("Low Kick into a 920 kg target does real damage", Number(big.range.split("-")[1]) > 0, big.range);
  ok("and says what it weighed", (big.details || []).some((d) => /kg -> 120 BP/.test(String(d))),
    JSON.stringify((big.details || []).filter((d) => /kg/.test(String(d)))));

  // ...and a lighter target is hit for less.
  const mid = mon("Garchomp");
  const small = calc(light, mid, "Low Kick");
  const bigTop = Number(big.range.split("-")[1]);
  const smallTop = Number(small.range.split("-")[1]);
  ok("a lighter target takes less from Low Kick than a heavier one", smallTop < bigTop || smallTop === 0,
    `${small.range} vs ${big.range}`);

  // Heavy Slam from something enormous onto something tiny: the top of the table.
  const slam = calc(heavy, mid, "Heavy Slam");
  ok("Heavy Slam does real damage", Number(slam.range.split("-")[1]) > 0, slam.range);
  ok("and says the ratio it used", (slam.details || []).some((d) => /kg vs .* kg -> \d+ BP/.test(String(d))),
    JSON.stringify((slam.details || []).filter((d) => /kg/.test(String(d)))));
  notes.push(`Low Kick into Mudsdale ${big.range}; Heavy Slam Mudsdale -> Garchomp ${slam.range}`);

  // Heavy Metal on the TARGET makes Low Kick hit harder; Light Metal makes it weaker.
  const heavier = calc(light, mon("Garchomp", "Heavy Metal"), "Low Kick");
  const lighter = calc(light, mon("Garchomp", "Light Metal"), "Low Kick");
  ok("Heavy Metal makes its holder take more from Low Kick",
    Number(heavier.range.split("-")[1]) >= Number(small.range.split("-")[1]),
    `${heavier.range} vs ${small.range}`);
  ok("and Light Metal less",
    Number(lighter.range.split("-")[1]) <= Number(small.range.split("-")[1]),
    `${lighter.range} vs ${small.range}`);
  notes.push(`Garchomp: plain ${small.range}, Heavy Metal ${heavier.range}, Light Metal ${lighter.range}`);
}

for (const note of notes) console.log(`   ${note}`);
console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
