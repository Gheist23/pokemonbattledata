// THREE THINGS A REAL GAME GOT WRONG, all of them in the turn the Solver and /play/ share
// (builder/solver.js, builder/play-game.js, builder/tournament-test.js).
//
// Reported from one match, and each one looked like the engine simply not doing its job:
//
//   1. "Sneasler went back, and out came Tyranitar" -- AND NO SAND. A Pokemon that has stood on
//      the field once could never trigger its entry Ability again, because the flag that says
//      "its Ability has fired" was the same flag as "the opponent has seen this Pokemon", and
//      the second of those must never be taken back. So every returning Drizzle, Drought, Sand
//      Stream, Snow Warning, Intimidate and Surge holder was silently inert for the rest of the
//      game. `entryDone` is now the first of the two and is cleared at every door off the field.
//   2. "Dragapult didn't do anything" -- the last Pokemon of a side, standing beside a seat
//      nothing could fill, with three of its four knocked out. `buildState` seats the ones
//      standing at the FRONT and pads with null; the live board leaves the hole where it fell.
//      So the search answered "seat 0" about a Pokemon that really stands in seat 1, and
//      `planFor` found an empty seat and planned nothing. `readJoint` translates it now.
//   3. Mega Evolution was searched as a real choice on every stone, so half of each slot's
//      budget went on proving that a hundred extra base stat points are worth having. It is
//      forced now -- EXCEPT where the Mega sets weather or terrain, which is the one case where
//      WHEN to evolve decides whose field is on the board, and except where two stone holders
//      are standing and the question is which of them gets the one stone.
//
//   node tests/run-mega-timing-and-reentry.mjs
//
// Not deployed: tests/ is in tools/pages-excludes.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData, makeSet } from "../builder/common.js";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest, ACTION_KINDS, WEATHERS as BOARD_WEATHERS } from "../builder/tournament-test.js";
import { Solver, SWITCH } from "../builder/solver.js";
import { PlayGame } from "../builder/play-game.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));

const FORMAT = "Doubles";
const appData = read("data", "builder", "app-data.json");
const meta = read("data", "builder", `meta-${FORMAT.toLowerCase()}.json`);
const effects = read("data", "builder", "move-effects.json");
const library = read("data", "builder", "pokemon-sets.json").sets;
const knownRaw = read("data", "builder", "known-teams.json");

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

// EXACTLY the options analysis-worker.js gives a played game. Without `fieldTurnsRule` the
// weather has no count to refresh and the whole Mega-timing question disappears.
const PLAY_OPTS = {
  effects, liveHpRule: 1, chargeRule: 1, berryRule: 1, stagesRule: 1, confusionRule: 1, ppRule: 1,
  rberryRule: 1, bailRule: 1, shieldRule: 1, fieldTurnsRule: 1, abilityOpsRule: 1, hazardsRule: 1,
  pivotRule: 1, selfRollRule: 1, actionRollRule: 1,
};

function makeSolver(opts = PLAY_OPTS) {
  const engine = new DamageEngine(appData);
  const ev = new TeamEvaluator(null, engine, FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const tournament = new TournamentTest(evaluation, new KnownTeams(knownRaw),
    new TeamSuggestions(evaluation), opts);
  return new Solver(tournament);
}

const set = (species, item, ability, nature, moves, bonuses, form) => ({
  species, form: form || species, item, ability, nature, moves, bonuses: [...bonuses],
});
const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });
const board = (ourRows, theirRows, field = {}) => ({ sides: [ourRows, theirRows], field });

const FAST = set("Dragapult", "Life Orb", "Clear Body", "Jolly", ["Dragon Darts", "Phantom Force", "Protect", "Tailwind"], [2, 32, 0, 0, 0, 32]);
const BULKY = set("Amoonguss", "Sitrus Berry", "Regenerator", "Calm", ["Spore", "Pollen Puff", "Rage Powder", "Protect"], [32, 0, 2, 0, 32, 0]);
const HITTER = set("Garchomp", "Life Orb", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]);
const SUPPORT = set("Whimsicott", "Focus Sash", "Prankster", "Timid", ["Tailwind", "Moonblast", "Encore", "Protect"], [2, 0, 0, 32, 0, 32]);
const CAT = set("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"], [32, 0, 2, 0, 32, 0]);

/** Sand Stream, so "has this Pokemon arrived on the field?" can be read straight off the weather. */
const SAND = set("Tyranitar", "Assault Vest", "Sand Stream", "Adamant", ["Rock Slide", "Crunch", "Low Kick", "Protect"], [32, 32, 0, 0, 2, 0]);
/** A stone whose Mega sets the weather (Drought), and two whose Megas set nothing. */
const SUN_STONE = set("Charizard", "Charizardite Y", "Blaze", "Timid", ["Heat Wave", "Protect", "Solar Beam", "Air Slash"], [2, 0, 0, 32, 0, 32]);
const PLAIN_STONE = set("Garchomp", "Garchompite", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]);
const OTHER_STONE = set("Salamence", "Salamencite", "Intimidate", "Jolly", ["Dragon Claw", "Double-Edge", "Tailwind", "Protect"], [2, 32, 0, 0, 0, 32]);

const solver = makeSolver();
const weatherOf = (state) => BOARD_WEATHERS[state.board.w] || "None";
const realArms = (arms) => arms.filter((a) => a.kind !== SWITCH && !a.wait);

// ---------------------------------------------------------------------------
// 1. MEGA EVOLUTION IS NORMALLY NOT A CHOICE
// ---------------------------------------------------------------------------
{
  const state = solver.buildState(board(
    [row(PLAIN_STONE, { front: true }), row(BULKY, { front: true }), row(FAST), row(SUPPORT)],
    [row(HITTER, { front: true }), row(CAT, { front: true }), row(SUPPORT), row(FAST)],
  ));
  const holder = state.active[0][0];
  // ASSERTED, NOT ASSUMED: this whole section is about a Mega with no field Ability, and an
  // app-data change that gave Mega Garchomp one would otherwise retire it in silence.
  ok("the board really offers a stone", Boolean(holder.mega), String(holder.u.form));
  ok("Mega Garchomp still sets no weather and no terrain",
    !holder.mega.kit.weather && !holder.mega.kit.terrain,
    `${holder.mega.kit.weather || "-"} / ${holder.mega.kit.terrain || "-"}`);
  ok("it stands in its base form until it is used", !/^mega\b/i.test(String(holder.u.form)),
    String(holder.u.form));

  const arms = solver.slotCandidates(state, 0, 0);
  ok("the search is given something to do", realArms(arms).length > 0);
  ok("EVERY move the search looks at uses the stone",
    realArms(arms).every((a) => a.mega),
    realArms(arms).filter((a) => !a.mega).map((a) => a.move).join(", "));
  ok("...and switching out is still on offer, which never Mega Evolves",
    arms.some((a) => a.kind === SWITCH) && arms.every((a) => !(a.mega && a.kind === SWITCH)));
  ok("the four moves are all still there", new Set(realArms(arms).map((a) => a.move)).size >= 4,
    realArms(arms).map((a) => a.move).join(", "));

  // THE PERSON PLAYING IS NOT THE SEARCH. `cap: 0` is their own uncut list, and holding the
  // stone back is a legal thing to do with a turn however rarely it is right.
  const mine = solver.slotCandidates(state, 0, 0, { cap: 0 });
  ok("the player keeps both halves of the choice",
    realArms(mine).some((a) => a.mega) && realArms(mine).some((a) => !a.mega),
    `${realArms(mine).filter((a) => a.mega).length} with, ${realArms(mine).filter((a) => !a.mega).length} without`);

  const joints = solver.jointsFor(state, 0, 400);
  ok("the side has turns to play", joints.length > 0, String(joints.length));
  ok("and never two stones in one of them",
    joints.every((j) => j.filter((a) => a.mega).length <= 1));
  notes.push(`forced: ${realArms(arms).length} searched arms, all Mega; the player is offered ${realArms(mine).length}`);
}

// ---------------------------------------------------------------------------
// 2. ...EXCEPT WHEN THE MEGA SETS THE FIELD
// ---------------------------------------------------------------------------
{
  const state = solver.buildState(board(
    [row(SUN_STONE, { front: true }), row(BULKY, { front: true }), row(FAST), row(SUPPORT)],
    [row(HITTER, { front: true }), row(CAT, { front: true }), row(SUPPORT), row(FAST)],
    { weather: "Rain" },
  ));
  const holder = state.active[0][0];
  ok("Mega Charizard Y still has Drought", holder.mega?.kit.weather === "Sun",
    String(holder.mega?.kit.weather));
  const arms = solver.slotCandidates(state, 0, 0);
  ok("using the stone is on offer", realArms(arms).some((a) => a.mega));
  ok("AND HOLDING IT BACK IS TOO -- the timing is the decision",
    realArms(arms).some((a) => !a.mega),
    realArms(arms).map((a) => `${a.move}${a.mega ? "*" : ""}`).join(", "));

  // The reason both arms are worth searching: evolving replaces the weather on the board.
  const chosen = [realArms(arms).find((a) => a.mega), { position: 1, kind: 0, value: 0, wait: true }];
  const events = [];
  solver.applyChosenTurn(state, chosen, [], 1, events);
  ok("evolving takes the weather over", weatherOf(state) === "Sun", weatherOf(state));
  ok("and the trace says so", events.some((e) => e.kind === "weather" && e.value === "Sun"));
}

// ---------------------------------------------------------------------------
// 3. ...AND EXCEPT WHEN TWO STONE HOLDERS ARE STANDING
// ---------------------------------------------------------------------------
{
  const state = solver.buildState(board(
    [row(PLAIN_STONE, { front: true }), row(OTHER_STONE, { front: true }), row(FAST), row(SUPPORT)],
    [row(HITTER, { front: true }), row(CAT, { front: true }), row(SUPPORT), row(FAST)],
  ));
  ok("both seats hold a stone", Boolean(state.active[0][0].mega) && Boolean(state.active[0][1].mega));
  for (const seat of [0, 1]) {
    const arms = solver.slotCandidates(state, 0, seat);
    ok(`seat ${seat} keeps a base-form arm, because only one of the two can use it`,
      realArms(arms).some((a) => !a.mega), realArms(arms).map((a) => a.move).join(", "));
  }
  // The point of keeping them: `jointsFor` refuses a joint with two Mega Evolutions in it, so
  // forcing both seats would leave this side with no turn at all.
  const joints = solver.jointsFor(state, 0, 400);
  ok("THE SIDE STILL HAS A TURN TO PLAY", joints.length > 0, String(joints.length));
  ok("one of them uses a stone", joints.some((j) => j.some((a) => a.mega)));
  ok("none of them uses two", joints.every((j) => j.filter((a) => a.mega).length <= 1));
}

// ---------------------------------------------------------------------------
// 4. A POKEMON THAT COMES BACK IN TRIGGERS ITS ABILITY AGAIN
// ---------------------------------------------------------------------------
{
  const state = solver.buildState(board(
    [row(FAST, { front: true }), row(BULKY, { front: true }), row(SAND), row(SUPPORT)],
    [row(HITTER, { front: true }), row(CAT, { front: true }), row(SUPPORT), row(FAST)],
    { weather: "None" },
  ));
  ok("Tyranitar's set still has Sand Stream", state.sides[0][2].k.weather === "Sand",
    String(state.sides[0][2].k.weather));
  ok("the board opens clear", weatherOf(state) === "None", weatherOf(state));

  const seatOf = (species) => state.sides[0].findIndex((m) => m && m.u.species === species);
  const wait = { position: 1, kind: 0, value: 0, wait: true };
  const switchTo = (species) => [
    { position: 0, kind: SWITCH, into: seatOf(species), move: `-> ${species}`, value: 1 }, wait];

  // IN. Side 1 is given an empty joint on purpose: nothing hits anybody, so the only thing
  // that can move the weather is the arrival itself.
  solver.applyChosenTurn(state, switchTo("Tyranitar"), [], 1, []);
  ok("a Pokemon switched in sets its weather", weatherOf(state) === "Sand", weatherOf(state));
  ok("...and it is the one standing there now", state.active[0][0].u.species === "Tyranitar",
    String(state.active[0][0].u.species));

  // OUT, with the weather wiped so the next arrival has to put it back itself.
  state.board.w = 0;
  state.board.wt = 0;
  solver.applyChosenTurn(state, switchTo("Dragapult"), [], 2, []);
  ok("whoever came in instead does not set it", weatherOf(state) === "None", weatherOf(state));
  ok("and Tyranitar really did leave", state.active[0][0].u.species === "Dragapult",
    String(state.active[0][0].u.species));

  // ...AND BACK IN. This is the reported bug: before `entryDone` this stayed clear for the rest
  // of the game, because the flag that had been set the first time was never cleared.
  const events = [];
  solver.applyChosenTurn(state, switchTo("Tyranitar"), [], 3, events);
  ok("A POKEMON THAT COMES BACK SETS ITS WEATHER AGAIN", weatherOf(state) === "Sand", weatherOf(state));
  ok("and the trace says who did it",
    events.some((e) => e.kind === "weather" && e.value === "Sand"),
    events.map((e) => e.kind).join(" "));
  ok("the Pokemon is still on record as seen", state.active[0][0].entered === true);
}

// ---------------------------------------------------------------------------
// 5. THE LAST POKEMON OF A SIDE, BESIDE A SEAT NOTHING CAN FILL
// ---------------------------------------------------------------------------
{
  const data = new BuilderData(appData);
  data.ingestMeta(FORMAT, meta);
  const gameSolver = makeSolver();
  const game = new PlayGame(gameSolver, data, FORMAT, library);
  const team = [FAST, BULKY, HITTER, SUPPORT].map((s) => makeSet({ ...s, moves: [...s.moves] }));
  const foes = [SAND, CAT, SUPPORT, FAST].map((s) => makeSet({ ...s, moves: [...s.moves] }));
  game.sheet = "open";
  game.start({ player: team, foe: foes, seed: 11 });

  // The board this bug needs: the opponent down to its last Pokemon, with the empty seat in
  // FRONT of it. `refill` puts null in the seat of a Pokemon it cannot replace, which is
  // exactly what happens once the rest of a bring is knocked out.
  const survivor = game.state.active[1][1];
  for (const m of game.state.sides[1]) {
    if (m === survivor) continue;
    m.hp = 0;
    m.out = true;
  }
  game.state.active[1][0] = null;
  ok("the opponent stands in its second seat with the first one empty",
    game.state.active[1][0] === null && game.state.active[1][1] === survivor);

  // The board the search is actually handed, built the way `possibleBoards` builds it.
  const rebuilt = gameSolver.buildState({
    sides: [game.seatOrder(1).map((m) => game.rowOf(m, 1, game.setOf(m))),
      game.seatOrder(0).map((m) => game.rowOf(m, 0, game.setOf(m)))],
    field: game.fieldOf(),
  });
  ok("THE REBUILT BOARD SEATS IT FIRST, which is the whole mismatch",
    Boolean(rebuilt.active[0][0]) && rebuilt.active[0][1] === null);

  // What the search answers about that board, and what it has to become.
  const raw = [{ position: 0, kind: ACTION_KINDS.ATTACK, slot: 0, target: 0, value: 1 }];
  ok("UNTRANSLATED, THE SURVIVOR DOES NOTHING AT ALL",
    gameSolver.planFor(game.state, raw, 1).length === 0);
  const read = game.readJoint(raw);
  ok("read back, the seat is where the Pokemon really stands", read[0].position === 1,
    String(read[0].position));
  const plan = gameSolver.planFor(game.state, read, 1);
  ok("so it has something to do", plan.length === 1, `${plan.length} planned`);
  ok("and it is the survivor doing it", plan[0]?.m === survivor);

  // The mirror of it: OUR side can be down to one with a hole in front of it too, and then the
  // opponent's attack was aimed at the empty seat.
  const ourSurvivor = game.state.active[0][1];
  game.state.active[0][0] = null;
  const aimed = game.readJoint([{ position: 0, kind: ACTION_KINDS.ATTACK, slot: 0, target: 0, value: 1 }]);
  ok("the foe it is aimed at is translated too", aimed[0].target === 1, String(aimed[0].target));
  ok("...which is the Pokemon we actually have standing",
    gameSolver.planFor(game.state, aimed, 1)[0]?.target === ourSurvivor);
  ok("a spread move keeps its -1 and is not aimed anywhere",
    game.readJoint([{ position: 0, kind: ACTION_KINDS.ATTACK, slot: 0, target: -1, value: 1 }])[0].target === -1);
  notes.push(`seats: live [null, ${gameSolver.label(survivor.u)}] searched as seat 0, read back as seat 1`);
}

for (const line of notes) console.log(`  ${line}`);
if (failures.length) {
  console.error(`\nFAIL  ${failures.length} of ${checked}`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`${checked} checked, 0 failed.`);
