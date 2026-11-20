// A PIVOT MOVE SENDS ITS OWN USER BACK -- AND THE PLAYER SAYS WHO REPLACES IT.
//
// Reported from a played game on 20 Nov 2026: "parting shot switches out the Pokemon that used
// Parting Shot when not being blocked, the player needs to have a choice for switch in".
//
// Both halves were real and both were small, because the machinery already existed:
//
//   * `PlayGame.replacementNeeded()` asked for an EMPTY seat, which a knockout leaves and a
//     pivot does not -- the Pokemon is alive and still standing in its own seat when `refill`
//     runs. So the hold that lets the player choose never fired for a pivot and the engine took
//     the next one off the bench, which means the order the team was typed in decided it. The
//     pivot swap happens inside that very same `refill` loop, so the hold covers it already.
//   * `noteFor` had no case for the `pivot` event at all, so Parting Shot read as a stat drop
//     and then the board quietly held a different Pokemon with nothing in between.
//
//   node tests/run-pivot-switch.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData, makeSet } from "../builder/common.js";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest } from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";
import { PlayGame } from "../builder/play-game.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const FORMAT = "Doubles";
const appData = read("data", "builder", "app-data.json");
const library = read("data", "builder", "pokemon-sets.json").sets;
const meta = read("data", "builder", `meta-${FORMAT.toLowerCase()}.json`);
const effects = read("data", "builder", "move-effects.json");

const data = new BuilderData(appData);
data.ingestMeta(FORMAT, meta);
const engine = new DamageEngine(appData);
const ev = new TeamEvaluator(data, engine, FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
ev.setMetaRecords(meta.pokemon || []);
const evaluation = new TeamEvaluation(ev);
const known = new KnownTeams(read("data", "builder", "known-teams.json"));

// The live rules, exactly as builder/analysis-worker.js builds them for /play/ and /solver/.
// WITHOUT pivotRule the move under test does nothing at all, so a suite built on the defaults
// would pass while testing the wrong engine.
const LIVE_RULES = {
  effects, liveHpRule: 1, chargeRule: 1, berryRule: 1, stagesRule: 1, confusionRule: 1, ppRule: 1,
  rberryRule: 1, bailRule: 1, shieldRule: 1, fieldTurnsRule: 1, abilityOpsRule: 1, hazardsRule: 1,
  pivotRule: 1, selfRollRule: 1, actionRollRule: 1, selfStatRule: 1,
};
const newSolver = () => new Solver(new TournamentTest(evaluation, known, new TeamSuggestions(evaluation), LIVE_RULES));

const mon = (species, ability, moves) => makeSet({
  species, form: species, ability, item: "", moves, nature: "Adamant", level: 50,
});

function opened() {
  // `pickReplacement` is what the real page passes; off everywhere else, because a caller that
  // never answers would sit on an unfinished turn for ever.
  const game = new PlayGame(newSolver(), data, FORMAT, library, { sheet: "open", pickReplacement: true });
  game.start({
    player: [
      mon("Incineroar", "Intimidate", ["Parting Shot", "Fake Out", "Flare Blitz", "Protect"]),
      mon("Gholdengo", "Good as Gold", ["Make It Rain", "Shadow Ball", "Protect", "Nasty Plot"]),
      // The two on the bench, deliberately different species so "which one came in" is readable.
      mon("Rillaboom", "Grassy Surge", ["Wood Hammer", "Fake Out", "Protect", "U-turn"]),
      mon("Milotic", "Competitive", ["Scald", "Recover", "Protect", "Ice Beam"]),
    ],
    foe: [
      mon("Dragonite", "Multiscale", ["Dragon Claw", "Earthquake", "Protect", "Extreme Speed"]),
      mon("Gholdengo", "Good as Gold", ["Make It Rain", "Shadow Ball", "Protect", "Nasty Plot"]),
      mon("Gholdengo", "Good as Gold", ["Make It Rain", "Shadow Ball", "Protect", "Nasty Plot"]),
      mon("Gholdengo", "Good as Gold", ["Make It Rain", "Shadow Ball", "Protect", "Nasty Plot"]),
    ],
    seed: 5,
  });
  return game;
}

function partingShot(game) {
  const options = game.options();
  const pick = options[0].actions.find((a) => a.move === "Parting Shot");
  if (!pick) return null;
  const chosen = [pick.id];
  const second = options[1] && !options[1].empty ? options[1].actions.find((a) => a.move === "Protect") : null;
  if (second) chosen[1] = second.id;
  game.resolve(game.jointFrom(options, chosen), []);
  return pick;
}

/* ========================================================= 1. the move is on offer at all */

{
  const game = opened();
  const moves = game.options()[0].actions.map((a) => a.move);
  ok("Parting Shot is offered", moves.includes("Parting Shot"), moves.join(", "));
}

/* ================================================ 2. the turn stops and asks who comes in */

{
  const game = opened();
  const used = partingShot(game);
  ok("the turn runs", Boolean(used));
  ok("the turn is HELD for a choice rather than filling the seat itself",
    game.replacementNeeded() === true || Boolean(game.heldRefill),
    `needed=${game.replacementNeeded()} held=${Boolean(game.heldRefill)}`);
  const choices = game.replacementChoices();
  ok("...and offers both benched Pokemon", choices.length === 2,
    JSON.stringify(choices.map((c) => c.name)));
  ok("...and offers neither of the two already standing",
    !choices.some((c) => /Incineroar|Gholdengo/.test(c.name)), JSON.stringify(choices.map((c) => c.name)));
  notes.push(`offered: ${choices.map((c) => c.name).join(", ")}`);
}

/* ================================== 3. the one chosen is the one that comes in, both ways */

for (const wanted of ["Rillaboom", "Milotic"]) {
  const game = opened();
  partingShot(game);
  const choices = game.replacementChoices();
  const pick = choices.find((c) => new RegExp(wanted).test(c.name));
  ok(`${wanted} is choosable`, Boolean(pick), JSON.stringify(choices.map((c) => c.name)));
  if (!pick) continue;
  game.chooseReplacement(pick.tag);
  const standing = game.state.active[0].filter(Boolean).map((m) => m.u.species);
  ok(`choosing ${wanted} brings ${wanted} in, not whoever the bench order put first`,
    standing.some((n) => new RegExp(wanted).test(n)), standing.join(", "));
  ok(`...and the Pokemon that used Parting Shot is no longer standing`,
    !standing.some((n) => /Incineroar/.test(n)), standing.join(", "));
  notes.push(`chose ${wanted} -> standing: ${standing.join(", ")}`);
}

/* ============================================================ 4. the log says it happened */

{
  const game = opened();
  partingShot(game);
  const choices = game.replacementChoices();
  if (choices.length) game.chooseReplacement(choices[choices.length - 1].tag);
  const entry = game.log[game.log.length - 1];
  const text = ((entry && entry.notes) || []).join(" | ");
  ok("the log names the switch the move caused, instead of a silent board change",
    /went back/i.test(text), text);
  notes.push(`log: ${text}`);
}

/* =========================================== 5. the sources still say why, for the next reader */

const playSource = readFileSync(join(root, "builder", "play-game.js"), "utf8");
ok("replacementNeeded looks for a pivot as well as an empty seat",
  /m\.pivoting/.test(playSource));
ok("...and records that the hold was already there", /the knockout path already holds/.test(playSource));
ok("noteFor has a case for the pivot event", /case "pivot":/.test(playSource));

if (failures.length) {
  console.error(`run-pivot-switch: ${failures.length} of ${checked} checks FAILED`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
for (const line of notes) console.log(`  ${line}`);
console.log(`run-pivot-switch: ${checked} checks passed`);
