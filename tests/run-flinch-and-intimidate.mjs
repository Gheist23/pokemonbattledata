// FAKE OUT INTO A FLINCH-PROOF FOE, AND THE INTIMIDATE THAT DID NOTHING.
//
// Both reported from one played game on 20 Nov 2026, and both trace to the same opposing
// Dragonite holding Inner Focus:
//
//   "why is Dragonite's Attack not lowered?"   -- correct, and the log said nothing
//   "why can't I target Dragonite with Fake Out from my Incineroar?"  -- a real bug
//
// THE BUG WAS A PAIR, and either half fixed alone is worse than neither:
//
//   * solver.js slotCandidates `continue`d on a flinch-proof foe, deleting the action, so the
//     move could not be aimed at one of the two Pokemon standing opposite. Fake Out is a 40 BP
//     priority attack; Inner Focus, Own Tempo, Shield Dust and Covert Cloak stop the FLINCH and
//     nothing else.
//   * tournament-test.js then set `target.flinch = true` UNCONDITIONALLY. Nothing had ever
//     reached it with a flinch-proof target, because of the line above -- so simply letting the
//     move be chosen would have started flinching Inner Focus.
//
// And the silence: Intimidate hits BOTH foes, so a doubles log that names one of them reads as
// a bug whatever the truth is. It now says what it did not do, and why a stat went UP.
//
//   node tests/run-flinch-and-intimidate.mjs
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
const knownRaw = read("data", "builder", "known-teams.json");
const meta = read("data", "builder", `meta-${FORMAT.toLowerCase()}.json`);
const effects = read("data", "builder", "move-effects.json");

const data = new BuilderData(appData);
data.ingestMeta(FORMAT, meta);
const engine = new DamageEngine(appData);
const ev = new TeamEvaluator(data, engine, FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
ev.setMetaRecords(meta.pokemon || []);
const evaluation = new TeamEvaluation(ev);
const known = new KnownTeams(knownRaw);
const newSolver = () => new Solver(new TournamentTest(evaluation, known, new TeamSuggestions(evaluation), { effects }));

/** A set built by hand so the Ability under test is the one on the field, not the one the
 *  current usage data happens to favour this week. */
const mon = (species, ability, moves, item = "") => makeSet({
  species, form: species, ability, item, moves,
  nature: "Adamant", level: 50,
});

const INCINEROAR = () => mon("Incineroar", "Intimidate", ["Fake Out", "Flare Blitz", "Parting Shot", "Protect"]);
const FILLER = () => mon("Gholdengo", "Good as Gold", ["Make It Rain", "Shadow Ball", "Protect", "Nasty Plot"]);
// The two sides of the question: identical Dragonite, one Ability apart.
const DRAGONITE_PROOF = () => mon("Dragonite", "Inner Focus", ["Dragon Claw", "Earthquake", "Protect", "Extreme Speed"]);
const DRAGONITE_OPEN = () => mon("Dragonite", "Multiscale", ["Dragon Claw", "Earthquake", "Protect", "Extreme Speed"]);
const FOE_PARTNER = () => mon("Rillaboom", "Grassy Surge", ["Wood Hammer", "Fake Out", "Protect", "U-turn"]);

function opened(foeLead) {
  const game = new PlayGame(newSolver(), data, FORMAT, library, { sheet: "open" });
  game.start({
    player: [INCINEROAR(), FILLER(), FILLER(), FILLER()],
    foe: [foeLead(), FOE_PARTNER(), FILLER(), FILLER()],
    seed: 7,
  });
  return game;
}

/* ============================================================ 1. the move can be aimed */

{
  const game = opened(DRAGONITE_PROOF);
  const slot = game.options()[0];
  const fakeOuts = slot.actions.filter((a) => a.move === "Fake Out");
  ok("Fake Out is offered at BOTH foes, not only the one that can flinch",
    fakeOuts.length === 2, `${fakeOuts.length} action(s): ${JSON.stringify(fakeOuts.map((a) => a.targetName))}`);
  ok("...and one of them is the Inner Focus Pokemon",
    fakeOuts.some((a) => /Dragonite/.test(a.targetName)),
    JSON.stringify(fakeOuts.map((a) => a.targetName)));
  notes.push(`Fake Out targets offered: ${fakeOuts.map((a) => a.targetName).join(", ")}`);
}

/* =================================================== 2. it damages but does not flinch */

/** One turn, driven the way the page drives it: our joint from the chosen action ids, and an
 *  empty joint for the opponent so the test does not depend on a search. The assertions are on
 *  the RENDERED log, because an event nobody prints is not a fix. */
function playFakeOutAt(game, matcher) {
  const options = game.options();
  const pick = options[0].actions.find((a) => a.move === "Fake Out" && matcher(a.targetName));
  if (!pick) return null;
  const chosen = [pick.id];
  const second = options[1] && !options[1].empty ? options[1].actions.find((a) => a.move === "Protect") : null;
  if (second) chosen[1] = second.id;
  game.resolve(game.jointFrom(options, chosen), []);
  return game.log[game.log.length - 1];
}

{
  const game = opened(DRAGONITE_PROOF);
  const target = game.state.active[1].find((m) => /Dragonite/.test(m.u.species));
  const hpBefore = target.hp;
  const entry = playFakeOutAt(game, (n) => /Dragonite/.test(n));
  ok("the turn runs with Fake Out aimed at the Inner Focus Pokemon", Boolean(entry));
  const notesText = ((entry && entry.notes) || []).join(" | ");
  ok("the log says the flinch did not happen rather than saying nothing",
    /did not flinch|could not flinch/i.test(notesText), notesText);
  const after = game.state.active[1].find((m) => /Dragonite/.test(m.u.species));
  ok("the Inner Focus Pokemon is NOT flinched", after && !after.flinch, String(after && after.flinch));
  ok("...but it still took the damage, because only the flinch is blocked",
    after && after.hp < hpBefore, `${hpBefore} -> ${after && after.hp}`);
  notes.push(`Inner Focus Dragonite: ${hpBefore}% -> ${after && after.hp}%, flinched=${Boolean(after && after.flinch)}`);
}

{
  // The control. Same Pokemon, same move, an Ability that does not stop a flinch.
  const game = opened(DRAGONITE_OPEN);
  const target = game.state.active[1].find((m) => /Dragonite/.test(m.u.species));
  const hpBefore = target.hp;
  const entry = playFakeOutAt(game, (n) => /Dragonite/.test(n));
  ok("the control turn runs", Boolean(entry));
  const after = game.state.active[1].find((m) => /Dragonite/.test(m.u.species));
  // NOT `after.flinch`: the engine clears that flag at the end of the turn it applied it in
  // (`m.flinch = false` in tournament-test.js), so reading it here is always false whichever
  // Ability is on the field -- a check that can only pass. The differential on the rendered log
  // is the thing that actually distinguishes the two.
  const controlText = ((entry && entry.notes) || []).join(" | ");
  ok("a Multiscale Dragonite is NOT excused the flinch, so the guard keys on the Ability",
    !/did not flinch|could not flinch/i.test(controlText), controlText);
  ok("...and it took damage too", after && after.hp < hpBefore, `${hpBefore} -> ${after && after.hp}`);
}

/* ========================================= 3. Intimidate says what it did not do */

{
  const game = opened(DRAGONITE_PROOF);
  // The leads arriving is turn 0 in the log, rendered by the same path every other turn uses.
  const opening = (game.log[0] && game.log[0].notes) || [];
  const text = opening.join(" | ");
  ok("Intimidate still lowers the foe that has no answer to it",
    /lowered .*Attack/i.test(text), text);
  ok("...and NAMES the one it could not touch, instead of a silence that reads as a bug",
    /was not affected|not lowered/i.test(text), text);
  ok("...and the one it names is the Inner Focus Pokemon",
    /Dragonite/.test(text), text);
  notes.push(`opening log: ${text}`);
}

/* ======================================== 4. the sources still say why, for the next reader */

const solverSource = readFileSync(join(root, "builder", "solver.js"), "utf8");
const turnSource = readFileSync(join(root, "builder", "tournament-test.js"), "utf8");
const playSource = readFileSync(join(root, "builder", "play-game.js"), "utf8");

ok("slotCandidates no longer drops the action for a flinch-proof foe",
  !/if \(foe\.k\.flinchProof\) continue;/.test(solverSource));
ok("the flinch itself is refused where it is applied",
  /if \(target\.k\.flinchProof\) \{/.test(turnSource));
ok("...and that is where the reason is written down",
  /only the FLINCH is stopped/.test(turnSource));
ok("the Play log can say all three Intimidate outcomes",
  /intimidateblocked/.test(playSource) && /intimidateraised/.test(playSource)
  && /flinchproof/.test(playSource));

if (failures.length) {
  console.error(`run-flinch-and-intimidate: ${failures.length} of ${checked} checks FAILED`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
for (const line of notes) console.log(`  ${line}`);
console.log(`run-flinch-and-intimidate: ${checked} checks passed`);
