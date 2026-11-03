// Mega Evolution in /play/: which Pokemon evolves (builder/play-choice.js, builder/play-game.js).
//
// THE FINDING. In Doubles with a stone on each of the two standing Pokemon, arming the second
// one evolved the FIRST. `PlayGame.jointFrom` spends the side's one Mega Evolution on the lowest
// seat that asks for it -- correct as a backstop -- and the page's toggle cleared the other
// seat's `state.mega` without clearing the action it had ALREADY chosen, which still carried
// `mega: true`. So the player watched the Pokemon they had just armed stay as it was, with
// nothing said about it. Reported 3 Nov 2026 from a played game.
//
// WHY IT WAS NOT CAUGHT. `run-play-game.mjs` has had "only one Mega Evolution a side survives
// the choice" for as long as the rule has existed, and it is guarded by
// `if (megas[0] && megas[1])` -- which that suite's team never satisfies, because it brings one
// stone. A check that cannot run reads exactly like a check that passes. And the question it
// asks is HOW MANY survive, never WHICH: the defect lives entirely in the second question.
//
// What is checked:
//
//   1. `armMega` on its own, over hand-made options -- it always runs, whatever any team brings;
//   2. a real two-stone board: both seats are offered the stone, and `jointFrom` gives it to the
//      lowest seat, which is why the page has to disarm the other;
//   3. end to end: arm seat 0, arm seat 1, and seat 1 is the one that comes out Mega;
//   4. and the page is wired to it, rather than clearing the toggles on its own.
//
//   node tests/run-play-mega.mjs
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
import { PlayGame, teamFromKnown } from "../builder/play-game.js";
import { armMega } from "../builder/play-choice.js";

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
const meta = read("data", "builder", `meta-${FORMAT.toLowerCase()}.json`);
const effects = read("data", "builder", "move-effects.json");
const knownRaw = read("data", "builder", "known-teams.json");
const library = read("data", "builder", "pokemon-sets.json").sets;

const data = new BuilderData(appData);
data.ingestMeta(FORMAT, meta);
const engine = new DamageEngine(appData);
const ev = new TeamEvaluator(data, engine, FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
ev.setMetaRecords(meta.pokemon || []);
const evaluation = new TeamEvaluation(ev);
const known = new KnownTeams(knownRaw);
const freshSolver = () => new Solver(new TournamentTest(evaluation, known, new TeamSuggestions(evaluation), { effects }));

/* -------------------------------------------- 1. the rule on its own */

// Hand-made, in the shape `PlayGame.options()` returns: two seats, each with a plain action and
// its Mega twin. Nothing here depends on which Pokemon any team happens to bring, so unlike the
// check in run-play-game.mjs this one cannot quietly stop running.
const twoSeats = () => ([
  {
    position: 0,
    actions: [
      { id: "0:0", kind: 6, move: "Earthquake", target: -1, mega: false },
      { id: "0:1", kind: 6, move: "Dragon Claw", target: 0, mega: false },
      { id: "0:2", kind: 6, move: "Earthquake", target: -1, mega: true },
      { id: "0:3", kind: 6, move: "Dragon Claw", target: 0, mega: true },
    ],
  },
  {
    position: 1,
    actions: [
      { id: "1:0", kind: 6, move: "Fake Out", target: 1, mega: false },
      { id: "1:1", kind: 6, move: "Fake Out", target: 1, mega: true },
    ],
  },
]);

{
  const options = twoSeats();
  // Seat 0 armed and chosen, then the player arms seat 1.
  const after = armMega(options, ["0:3", "1:0"], 1);
  ok("arming seat 1 takes the stone off seat 0's pick", after[0] === "0:1", JSON.stringify(after));
  ok("and leaves seat 0 doing the same move at the same target", after[0] === "0:1");
  ok("seat 1's own pick is untouched", after[1] === "1:0", JSON.stringify(after));

  // The other direction.
  const back = armMega(options, ["0:0", "1:1"], 0);
  ok("arming seat 0 takes the stone off seat 1's pick", back[1] === "1:0", JSON.stringify(back));

  // Nothing to do.
  ok("a seat with no Mega pick is left alone",
    JSON.stringify(armMega(options, ["0:0", "1:0"], 1)) === JSON.stringify(["0:0", "1:0"]));
  ok("an unchosen seat is left alone",
    JSON.stringify(armMega(options, [undefined, "1:1"], 1)) === JSON.stringify([undefined, "1:1"]));
  ok("the seat being armed is never touched", armMega(options, ["0:3", "1:1"], 0)[0] === "0:3");
  ok("the input is not modified", (() => {
    const chosen = ["0:3", "1:0"];
    armMega(options, chosen, 1);
    return chosen[0] === "0:3";
  })());

  // A pick with no plain twin becomes unchosen rather than something the player did not ask for.
  const odd = [{ position: 0, actions: [{ id: "0:0", kind: 6, move: "Explosion", target: -1, mega: true }] },
    { position: 1, actions: [{ id: "1:0", kind: 6, move: "Fake Out", target: 1, mega: true }] }];
  ok("a pick with no plain twin becomes unchosen, never substituted",
    armMega(odd, ["0:0", undefined], 1)[0] === undefined);
}

/* -------------------------------------------- 2+3. a real board with two stones */

const stones = appData.megaStones || {};
function stoneFor(species) {
  for (const [stone, holders] of Object.entries(stones)) {
    const list = Array.isArray(holders) ? holders : [holders];
    if (list.some((h) => String(h?.species ?? h).toLowerCase() === String(species).toLowerCase())) return stone;
  }
  return "";
}
function setOf(record, { withStone = false } = {}) {
  const base = data.commonSet(FORMAT, record.species, record.form);
  if (!base || !base.moves?.length) return null;
  const stone = withStone ? stoneFor(record.species) : "";
  if (withStone && !stone) return null;
  return makeSet({ ...base, moves: [...base.moves], ...(stone ? { item: stone } : {}) });
}

const holders = [];
const plain = [];
for (const record of meta.pokemon) {
  const armed = setOf(record, { withStone: true });
  if (armed && holders.length < 2 && !holders.some((s) => s.species === armed.species)) { holders.push(armed); continue; }
  const bare = setOf(record);
  if (bare && plain.length < 2) plain.push(bare);
}
ok("the meta has two different Pokemon that can hold a stone", holders.length === 2,
  holders.map((s) => `${s.species}@${s.item}`).join(", "));

if (holders.length === 2) {
  notes.push(`two stones: ${holders.map((s) => `${s.species} @ ${s.item}`).join(" and ")}`);
  const FOE = teamFromKnown(data, FORMAT, known.teams[0]).slice(0, 6);
  const team = [holders[0], holders[1], ...plain];

  const solver = freshSolver();
  const game = new PlayGame(solver, data, FORMAT, library, { pickReplacement: false });
  game.start({ player: team, foe: FOE, seed: 7 });
  const options = game.options();
  const megaOf = (i) => (options[i]?.actions || []).find((a) => a.mega);
  ok("both standing Pokemon are offered the stone", Boolean(megaOf(0)) && Boolean(megaOf(1)),
    JSON.stringify([Boolean(megaOf(0)), Boolean(megaOf(1))]));

  if (megaOf(0) && megaOf(1)) {
    // The engine's backstop, and the reason the page has to disarm: the LOWEST seat wins.
    const both = game.jointFrom(options, [megaOf(0).id, megaOf(1).id]);
    ok("with both armed only one survives", both.filter((a) => a.mega).length === 1,
      JSON.stringify(both.map((a) => Boolean(a.mega))));
    ok("and it is the lowest seat, not the one armed last",
      both[0].mega === true && both[1].mega === false,
      JSON.stringify(both.map((a) => Boolean(a.mega))));

    // What the page now sends after `armMega`.
    const chosen = armMega(options, [megaOf(0).id, megaOf(1).id], 1);
    const after = game.jointFrom(options, chosen);
    ok("after arming seat 1 the stone is seat 1's", after[0].mega === false && after[1].mega === true,
      JSON.stringify(after.map((a) => Boolean(a.mega))));

    // ...and it really evolves, on the board, which is the thing the player was watching for.
    const names = [0, 1].map((i) => `${game.state.active[0][i].u.species}/${game.state.active[0][i].u.form}`);
    const foeOptions = [0, 1].map((p) => solver.slotCandidates(game.state, 1, p, { cap: 0 }));
    game.resolve(after, solver.planFor(game.state, foeOptions.map((l) => l[0]).filter(Boolean), 1));
    const nowForm = (i) => String(game.state.active[0][i]?.u?.form || "");
    ok("seat 1 is the one standing in its Mega form", /^mega\b/i.test(nowForm(1)),
      `${names[1]} -> ${nowForm(1)}`);
    ok("and seat 0 is still its base form", !/^mega\b/i.test(nowForm(0)), `${names[0]} -> ${nowForm(0)}`);
    ok("the side's one Mega Evolution is spent", game.state.megaUsed[0] === true);
    notes.push(`armed seat 1: ${names[1]} -> ${nowForm(1)}, seat 0 stayed ${nowForm(0)}`);
  }
}

/* -------------------------------------------- 4. the page is wired to it */
{
  const page = readFileSync(join(root, "builder", "play-page.js"), "utf8");
  ok("the page imports the rule", /import \{ armMega \} from "\.\/play-choice\.js"/.test(page));
  // The toggle must not clear `state.mega` without taking the stone off the other seat's pick:
  // that pairing is the whole defect.
  const handler = page.match(/if \(!megaOn\) \{[\s\S]*?\}/);
  ok("and uses it where the toggles are cleared",
    Boolean(handler) && /armMega\(state\.options, state\.chosen, slot\.position\)/.test(handler[0]),
    handler ? handler[0].replace(/\s+/g, " ").slice(0, 120) : "no `if (!megaOn) {` block");
}

for (const note of notes) console.log(`   ${note}`);
console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
