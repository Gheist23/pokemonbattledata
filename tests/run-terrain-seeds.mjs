// Terrain seeds (builder/engine.js: TERRAIN_SEEDS / terrainSeedMon, through
// DamageEngine.attackDefenseValues).
//
// Four held items do nothing until their terrain is on the field and then, once, raise one
// defence by a stage: Electric Seed and Grassy Seed raise Defense, Misty Seed and Psychic
// Seed raise Special Defense. The site modelled none of them, so a Sneasler holding a
// Psychic Seed under Indeedee's Psychic Terrain -- its most common item -- was calculated
// with its bare Special Defense everywhere: the Damage Calculator, Team Evaluation's threat
// lines, the Auto Build / Suggestions scoring, Optimize and the Tournament Test all resolve
// their numbers through the one method this rule sits in.
//
// The app is the source of truth here (pokemon_champions_tool/terrain_seeds_v511.py) and
// tests/calc-vectors.json is re-recorded from it, so this file checks the shape of the rule
// rather than the numbers: which stat, which terrain, who the terrain reaches, and the
// option that replays a recording made before the rule.
//
// Checked here:
//   1. each seed in its terrain is worth exactly one stage of the right stat -- the same
//      answer as typing +1 in by hand, and a different answer from holding nothing
//   2. off its terrain, and in the three other terrains, it is worth nothing
//   3. it raises its own stat only: Psychic Seed does not soften a physical hit
//   4. terrain reaches grounded Pokemon only: a Flying type and a Levitate holder collect
//      nothing, and Gravity puts the Flying type back in the terrain
//   5. Body Press hits with the user's own Defense, so the attacker's seed is part of it
//   6. a critical hit and an Unaware attacker ignore the seed's stage, like any other
//   7. Simple doubles it
//   8. the `terrainSeeds` option: on by default, and off replays the old answer
//   9. the Tournament Test keys its damage cache on the terrain for a seed holder, so the
//      calc made on a terrainless board is not reused where the terrain is up
//
//   node tests/run-terrain-seeds.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, makeContext, makeMon, TERRAIN_SEEDS, terrainSeedOption } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest } from "../builder/tournament-test.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const engine = new DamageEngine(appData);

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const mon = (name, fields = {}) => makeMon({ pokemon_name: name, form_name: name, level: 50, nature_name: "Serious", bonuses: [0, 0, 0, 0, 0, 0], ...fields });
const ctxFor = (move, terrain, fields = {}) => makeContext({ move_name: move, terrain, battle_format: "Doubles", ...fields });
const rolls = (attacker, defender, ctx) => engine.calculate(attacker, defender, ctx).rolls.join(",");

const CASES = [
  ["Electric Seed", "Electric", "defense_stage", "Body Slam"],
  ["Grassy Seed", "Grassy", "defense_stage", "Body Slam"],
  ["Misty Seed", "Misty", "sp_defense_stage", "Dark Pulse"],
  ["Psychic Seed", "Psychic", "sp_defense_stage", "Dark Pulse"],
];
const TERRAINS = ["None", "Electric", "Grassy", "Psychic", "Misty"];

// 0. the table itself
check("four seeds are modelled", Object.keys(TERRAIN_SEEDS).length === 4, Object.keys(TERRAIN_SEEDS).join(" "));
for (const [item, terrain, stage] of CASES) {
  const entry = TERRAIN_SEEDS[item.toLowerCase().replace(/[^a-z0-9]/g, "")];
  check(`${item} is in the table`, Boolean(entry), item);
  check(`${item} waits for ${terrain} Terrain`, entry?.terrain === terrain, String(entry?.terrain));
  check(`${item} raises ${stage}`, `${entry?.stat}_stage` === stage, String(entry?.stat));
}

// 1-3. what the boost is worth, and what it is not worth
const attacker = mon("Garchomp");
for (const [item, terrain, stage, move] of CASES) {
  const holder = mon("Garchomp", { item });
  const bare = mon("Garchomp");
  const byHand = mon("Garchomp", { [stage]: 1 });
  const ctx = ctxFor(move, terrain);
  const seeded = rolls(attacker, holder, ctx);
  check(`${item} is exactly +1 ${stage}`, seeded === rolls(attacker, byHand, ctx), seeded);
  check(`${item} changes the number at all`, seeded !== rolls(attacker, bare, ctx), seeded);

  for (const other of TERRAINS) {
    if (other === terrain) continue;
    const off = ctxFor(move, other);
    check(`${item} is worth nothing in ${other}`, rolls(attacker, holder, off) === rolls(attacker, bare, off));
  }

  // The other half of the defence is untouched: a Defense seed against a special move,
  // a Special Defense seed against a physical one.
  const otherMove = stage === "defense_stage" ? "Dark Pulse" : "Body Slam";
  const crossed = ctxFor(otherMove, terrain);
  check(`${item} guards one stat only`, rolls(attacker, holder, crossed) === rolls(attacker, bare, crossed));
}

// 4. terrain reaches the ground and nothing above it
{
  const ctx = ctxFor("Body Slam", "Grassy");
  for (const [name, ability] of [["Salamence", "Intimidate"], ["Bronzong", "Levitate"]]) {
    const holder = mon(name, { item: "Grassy Seed", ability });
    const bare = mon(name, { ability });
    check(`${name} floats over the terrain`, rolls(attacker, holder, ctx) === rolls(attacker, bare, ctx));
  }
  const heavy = ctxFor("Body Slam", "Grassy", { gravity: true });
  const flier = mon("Salamence", { item: "Grassy Seed", ability: "Intimidate" });
  const plainFlier = mon("Salamence", { ability: "Intimidate" });
  check("Gravity puts a Flying holder back in the terrain", rolls(attacker, flier, heavy) !== rolls(attacker, plainFlier, heavy));
}

// 5. Body Press hits with the user's own Defense
{
  const ctx = ctxFor("Body Press", "Electric");
  const holder = mon("Garchomp", { item: "Electric Seed" });
  const bare = mon("Garchomp");
  const target = mon("Garchomp");
  const withSeed = engine.calculate(holder, target, ctx).rolls;
  const without = engine.calculate(bare, target, ctx).rolls;
  check("Body Press carries the attacker's own seed", Math.max(...withSeed) > Math.max(...without), `${Math.max(...withSeed)} vs ${Math.max(...without)}`);
}

// 6. a critical hit and Unaware ignore it, like any other positive stage
{
  const holder = mon("Garchomp", { item: "Grassy Seed" });
  const bare = mon("Garchomp");
  const crit = ctxFor("Body Slam", "Grassy", { critical: true });
  check("a critical hit ignores the seed", rolls(attacker, holder, crit) === rolls(attacker, bare, crit));
  const unaware = mon("Garchomp", { ability: "Unaware" });
  const ctx = ctxFor("Body Slam", "Grassy");
  check("an Unaware attacker ignores the seed", rolls(unaware, holder, ctx) === rolls(unaware, bare, ctx));
}

// 7. Simple doubles the stage
{
  const ctx = ctxFor("Body Slam", "Grassy");
  const simple = mon("Bibarel", { item: "Grassy Seed", ability: "Simple" });
  const simpleByHand = mon("Bibarel", { ability: "Simple", defense_stage: 1 });
  const twoStages = mon("Bibarel", { defense_stage: 2 });
  check("Simple doubles the seed's stage", rolls(attacker, simple, ctx) === rolls(attacker, twoStages, ctx), rolls(attacker, simple, ctx));
  check("which is what Simple does to a hand-typed +1", rolls(attacker, simpleByHand, ctx) === rolls(attacker, twoStages, ctx));
}

// 8. the option
{
  check("the option reads a stamp", terrainSeedOption(true) === true && terrainSeedOption(null) === false && terrainSeedOption("off") === false && terrainSeedOption("0") === false);
  check("the engine applies the rule by default", engine.terrainSeeds === true);
  const off = new DamageEngine(appData, { terrainSeeds: null });
  check("a switched-off engine says so", off.terrainSeeds === false);
  const ctx = ctxFor("Body Slam", "Grassy");
  const holder = mon("Garchomp", { item: "Grassy Seed" });
  const bare = mon("Garchomp");
  const offRolls = off.calculate(holder, bare, ctx).rolls.join(",");
  const offBare = off.calculate(bare, bare, ctx).rolls.join(",");
  check("with the rule off the old answer comes back", off.calculate(attacker, holder, ctx).rolls.join(",") === off.calculate(attacker, bare, ctx).rolls.join(","));
  check("and the switched-off engine still calculates", offRolls.length > 0 && offBare.length > 0);
}

// 9. the Tournament Test's damage cache
{
  const meta = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));
  const known = JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8"));
  const ev = new TeamEvaluator(null, new DamageEngine(appData), "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const test = new TournamentTest(evaluation, new KnownTeams(known), new TeamSuggestions(evaluation));
  const unitFor = (item) => test.prepare({ mon: makeMon({ pokemon_name: "Garchomp", form_name: "Garchomp", level: 50, item, ability: "Rough Skin", nature_name: "Serious", bonuses: [0, 0, 0, 0, 0, 0], moves: ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"] }) });
  check("a seed holder's damage depends on the board's terrain", unitFor("Psychic Seed").terrainSense === true);
  check("a plain holder's does not", unitFor("Leftovers").terrainSense === false);
}

console.log(failures.length ? `\n${failures.map((f) => `FAIL ${f}`).join("\n")}\n` : "");
console.log(`${checked} checked, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
