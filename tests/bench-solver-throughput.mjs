// HOW MANY LINES A SECOND DOES THE WEBSITE'S SOLVER ACTUALLY PLAY?
//
// Asked because the Companion reports ~24-32 lines/s on the same kind of board and the gap
// needed a measured number on this side rather than a remembered one. Both call a "line" the
// same thing -- one position played out -- and both default to a 4-turn horizon
// (`DEFAULT_LOOKAHEAD = 4` here, `turns_ahead: int = 4` there), so the units are comparable.
//
//   node tests/bench-solver-throughput.mjs
//
// A benchmark, not a check: it asserts nothing and is not part of the suite. Not deployed.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest } from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => JSON.parse(readFileSync(join(root, ...p), "utf8"));
const appData = read("data", "builder", "app-data.json");
const knownRaw = read("data", "builder", "known-teams.json");
const meta = read("data", "builder", "meta-doubles.json");

const engine = new DamageEngine(appData);
const ev = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }));
ev.setMetaRecords(meta.pokemon || []);
const evaluation = new TeamEvaluation(ev);
const solver = new Solver(new TournamentTest(evaluation, new KnownTeams(knownRaw), new TeamSuggestions(evaluation)));

const set = (species, item, ability, nature, moves, bonuses) => ({
  species, form: species, item, ability, nature, moves, bonuses: [...bonuses],
});
// Four a side, same shape as the Companion board this was measured against.
const OURS = [
  set("Salamence", "Salamencite", "Intimidate", "Adamant", ["Draco Meteor", "Hyper Voice", "Protect", "Flamethrower"], [2, 32, 0, 32, 0, 0]),
  set("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Fake Out", "Flare Blitz", "Parting Shot", "Knock Off"], [32, 0, 2, 0, 32, 0]),
  set("Gholdengo", "Choice Specs", "Good as Gold", "Modest", ["Make It Rain", "Shadow Ball", "Nasty Plot", "Protect"], [32, 0, 0, 32, 2, 0]),
  set("Rillaboom", "Assault Vest", "Grassy Surge", "Adamant", ["Grassy Glide", "Wood Hammer", "Fake Out", "U-turn"], [32, 32, 0, 0, 2, 0]),
];
const THEIRS = [
  set("Garchomp", "Life Orb", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Protect", "Rock Slide"], [2, 32, 0, 0, 0, 32]),
  set("Torkoal", "Charcoal", "Drought", "Quiet", ["Eruption", "Heat Wave", "Protect", "Body Press"], [32, 0, 2, 32, 0, 0]),
  set("Amoonguss", "Sitrus Berry", "Regenerator", "Calm", ["Spore", "Rage Powder", "Pollen Puff", "Protect"], [32, 0, 2, 0, 32, 0]),
  set("Urshifu", "Focus Sash", "Unseen Fist", "Jolly", ["Surging Strikes", "Close Combat", "Protect", "Aqua Jet"], [2, 32, 0, 0, 0, 32]),
];
const row = (s, front) => ({ set: s, hp: 100, front });
const boardOf = () => ({
  sides: [OURS.map((s, i) => row(s, i < 2)), THEIRS.map((s, i) => row(s, i < 2))],
  field: {},
});

// Warm: the first lines pay for caches the rest reuse, exactly as on the other side.
await solver.search(boardOf(), { iterations: 400, lookahead: 4, seed: 1 });

for (const iterations of [4000, 20000]) {
  const result = await solver.search(boardOf(), { iterations, lookahead: 4, seed: 7 });
  const rate = result.played / Math.max(1e-9, result.seconds);
  const calcs = result.calcs ?? -1;
  console.log(`  iterations ${String(iterations).padStart(6)} -> ${String(result.played).padStart(6)} lines`
    + ` in ${result.seconds.toFixed(2)}s = ${Math.round(rate).toLocaleString().padStart(7)} lines/s`
    + `   damage calcs: ${calcs} (${(calcs / Math.max(1, result.played)).toFixed(4)} per line)`);
}
