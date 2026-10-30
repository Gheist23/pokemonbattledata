// Choosing who comes in next, and the field banner (builder/play-game.js, builder/play-page.js).
//
// TWO THINGS A PLAYED GAME GOT WRONG.
//
// 1. WHO COMES IN. `refill` took the next Pokemon off the bench, so the order a team was typed
//    in decided who replaced a knocked-out one. That is a real choice in the game and it was
//    never offered. The hard part is seat rule 1: everyone replaced in a turn is on the field
//    before ANY of them triggers, and they trigger in entry-Speed order -- so filling only our
//    side first would send the opponent's Intimidate at an empty seat. The WHOLE refill is held
//    instead, and runs once the choice is made, both sides together.
//
// 2. THE FIELD BANNER SHOWED A NUMBER. `view().field.weather` handed over `board.w`, a position
//    in WEATHERS, while the page prints what it is given -- so with Pelipper's Drizzle up the
//    banner read "2" instead of "Rain". `rowOf`'s board, which the opponent searches, has said
//    it in words all along, so only the player's own side was wrong. And neither carried the
//    remaining turns, so a Trick Room about to end looked the same as one with four to run.
//
// What is checked here:
//
//   1. a game with one on the bench is NOT asked -- there is nothing to choose, and every
//      existing game and test behaves exactly as before;
//   2. with two or more it IS asked, the turn waits, and no actions are offered meanwhile;
//   3. the Pokemon chosen is the one that comes in -- both when it is the one `refill` would
//      have taken anyway and when it is not, which is the half that proves the choice is read;
//   4. a tag that is not on offer is refused and the question stays open;
//   5. the replacement keeps its HP and arrives marked as just in, so its entry Ability runs;
//   6. the field banner says words, not indices, and carries the turns left where there are any.
//
//   node tests/run-play-replacement.mjs
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
import { TournamentTest, WEATHERS } from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";
import { PlayGame, teamFromKnown } from "../builder/play-game.js";

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

function freshGame({ pickReplacement = true } = {}) {
  const solver = new Solver(new TournamentTest(evaluation, known, new TeamSuggestions(evaluation), { effects }));
  return { solver, game: new PlayGame(solver, data, FORMAT, library, { pickReplacement }) };
}

const setFor = (record) => {
  const set = data.commonSet(FORMAT, record.species, record.form);
  return set && set.moves?.length ? makeSet({ ...set, moves: [...set.moves] }) : null;
};
const ranked = meta.pokemon.map(setFor).filter(Boolean);
const FOE = teamFromKnown(data, FORMAT, known.teams[0]).slice(0, 6);

/** Play until the game asks for a replacement, or the turn budget runs out. */
function playUntilAsked(game, solver, { team, seed = 5, cap = 30 }) {
  let view = game.start({ player: team, foe: FOE, seed });
  let turns = 0;
  let offeredWhileWaiting = null;
  while (!game.over() && turns < cap) {
    if (view.replacement) {
      offeredWhileWaiting = game.options();
      break;
    }
    turns += 1;
    const options = game.options();
    const chosen = options.filter((o) => !o.empty).map((o) => o.actions[0]?.id).filter(Boolean);
    if (!chosen.length) break;
    const foeOptions = [0, 1].map((p) => solver.slotCandidates(game.state, 1, p, { cap: 0 }));
    game.resolve(game.jointFrom(options, chosen),
      solver.planFor(game.state, foeOptions.map((l) => l[0]).filter(Boolean), 1));
    view = game.view();
  }
  return { view, turns, offeredWhileWaiting };
}

// ---------------------------------------------------------------------------
// 1. nothing to choose, nothing asked
// ---------------------------------------------------------------------------
{
  // Three Pokemon in Doubles: two stand, one on the bench. A knockout has exactly one answer,
  // so the game must not stop to ask -- which is also what keeps every older game unchanged.
  const { solver, game } = freshGame();
  const { view } = playUntilAsked(game, solver, { team: ranked.slice(0, 3) });
  ok("with one on the bench the game is never asked", view.replacement === null || view.replacement === undefined,
    JSON.stringify(view.replacement));
  ok("and `replacementNeeded` says so", game.replacementNeeded() === false);
}

// ---------------------------------------------------------------------------
// 2-3. asked, waiting, and the choice is read
// ---------------------------------------------------------------------------
{
  const outcomes = [];
  for (const [label, pickFrom] of [["the last candidate", (c) => c[c.length - 1]],
    ["the first candidate", (c) => c[0]]]) {
    const { solver, game } = freshGame();
    const { view, offeredWhileWaiting } = playUntilAsked(game, solver, { team: ranked.slice(0, 6) });
    ok(`${label}: the game asks`, Boolean(view.replacement), JSON.stringify(view.replacement));
    if (!view.replacement) continue;
    const choices = view.replacement.choices;
    ok(`${label}: more than one is offered`, choices.length > 1, String(choices.length));
    ok(`${label}: each carries a name and its HP`,
      choices.every((c) => c.name && Number.isInteger(c.hp) && Number.isInteger(c.tag)),
      JSON.stringify(choices));
    // NOTHING IS OFFERED WHILE IT WAITS. A seat is empty, so actions for it would be actions
    // for nobody -- the worker returns [] for the same reason.
    const live = (offeredWhileWaiting || []).filter((slot) => !slot.empty);
    ok(`${label}: an empty seat offers nothing`, live.length < 2, String(live.length));

    const pick = pickFrom(choices);
    ok(`${label}: the choice is accepted`, game.chooseReplacement(pick.tag) === true);
    const after = game.view();
    const standing = after.standing[0]
      .map((tag) => after.sides[0].find((m) => m.tag === tag))
      .filter(Boolean);
    ok(`${label}: the chosen one is standing`, standing.some((m) => m.tag === pick.tag),
      `${pick.name} vs ${standing.map((m) => m.name).join(", ")}`);
    ok(`${label}: the question is closed`, !after.replacement);
    // A SWITCH, not a revival: it arrives with the HP it had on the bench.
    const arrived = standing.find((m) => m.tag === pick.tag);
    ok(`${label}: it keeps its HP`, arrived.hp === pick.hp, `${arrived.hp} vs ${pick.hp}`);
    ok(`${label}: and arrives just in, so its entry Ability runs`, arrived.justIn === true);
    outcomes.push(`${label} -> ${pick.name}`);
  }
  // THE HALF THAT PROVES IT. If the choice were ignored, both runs would bring the same Pokemon
  // in -- whichever `refill` would have taken.
  ok("the two choices bring in different Pokemon", new Set(outcomes.map((o) => o.split("-> ")[1])).size === 2,
    outcomes.join(" | "));
  outcomes.forEach((o) => notes.push(o));
}

// ---------------------------------------------------------------------------
// 3b. OFF by default, so no existing caller can stall
// ---------------------------------------------------------------------------
{
  // A caller that does not look at `view.replacement` would sit on a turn that never finishes,
  // and several already exist -- the suites play whole games in a loop. So the choice is opt-in:
  // only the worker running the real game, where a person is there to answer, turns it on.
  const { solver, game } = freshGame({ pickReplacement: false });
  const { view, turns } = playUntilAsked(game, solver, { team: ranked.slice(0, 6), cap: 40 });
  ok("with the option off the game is never asked", !view.replacement, JSON.stringify(view.replacement));
  ok("and `replacementNeeded` refuses outright", game.replacementNeeded() === false);
  ok("so the game keeps playing", turns > 1, String(turns));
  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  ok("and the worker is the one that turns it on", /pickReplacement: true/.test(worker));
}

// ---------------------------------------------------------------------------
// 4. a tag that is not on offer
// ---------------------------------------------------------------------------
{
  const { solver, game } = freshGame();
  const { view } = playUntilAsked(game, solver, { team: ranked.slice(0, 6) });
  if (view.replacement) {
    const offered = new Set(view.replacement.choices.map((c) => c.tag));
    const standingTag = view.standing[0].find((tag) => tag !== null && !offered.has(tag));
    ok("a Pokemon already standing is refused", game.chooseReplacement(standingTag) === false,
      String(standingTag));
    ok("a tag that does not exist is refused", game.chooseReplacement(999) === false);
    ok("and the question stays open", Boolean(game.view().replacement));
    ok("so the right answer still works", game.chooseReplacement([...offered][0]) === true);
  } else {
    ok("the game asked for a replacement", false, "never asked");
  }
}

// ---------------------------------------------------------------------------
// 5-6. the field banner
// ---------------------------------------------------------------------------
{
  const { solver, game } = freshGame();
  const rainer = ranked.find((set) => /drizzle/i.test(set.ability || ""));
  ok("a weather setter was found in the meta", Boolean(rainer), rainer?.species || "none");
  const team = [rainer, ...ranked.filter((s) => s !== rainer).slice(0, 3)];
  const view = game.start({ player: team, foe: FOE, seed: 3 });

  // IN WORDS. This handed over `board.w`, a position in WEATHERS, and the page prints what it
  // is given -- so the banner read "2".
  ok("the weather is a word", typeof view.field.weather === "string", String(view.field.weather));
  ok("and it is the right one", view.field.weather === "Rain", String(view.field.weather));
  ok("not the index", view.field.weather !== WEATHERS.indexOf("Rain"));
  ok("the terrain is a word too", typeof view.field.terrain === "string", String(view.field.terrain));
  ok("and reads None when there is none", view.field.terrain === "None", String(view.field.terrain));

  // WITH THE TURNS LEFT, where the engine has any. Weather and terrain have none: an Ability
  // sets them and nothing counts them down, so there is no number to show and none is claimed.
  ok("Trick Room carries its turns", "trickRoomTurns" in view.field);
  ok("and Tailwind carries both sides'", Array.isArray(view.field.tailwindTurns)
    && view.field.tailwindTurns.length === 2, JSON.stringify(view.field.tailwindTurns));
  game.state.board.tr = 4;
  game.state.board.tw[0] = 3;
  const up = game.view().field;
  ok("a Trick Room with four turns says four", up.trickRoomTurns === 4, String(up.trickRoomTurns));
  ok("a Tailwind with three says three", up.tailwindTurns[0] === 3, String(up.tailwindTurns[0]));
  ok("and the booleans still agree", up.trickRoom === true && up.tailwind[0] === true);
  game.state.board.tr = 1;
  game.state.board.tw[0] = 0;
  const low = game.view().field;
  ok("one turn left says one", low.trickRoomTurns === 1, String(low.trickRoomTurns));
  ok("and a Tailwind that has run out is gone", low.tailwind[0] === false && low.tailwindTurns[0] === 0);

  // The page prints them, which is the half the view cannot prove.
  const page = readFileSync(join(root, "builder", "play-page.js"), "utf8");
  ok("the page shows the Trick Room turns", /Trick Room\$\{left\(view\.field\.trickRoomTurns\)\}/.test(page));
  ok("and both Tailwinds", /Your Tailwind\$\{left\(tw\[0\]\)\}/.test(page)
    && /Their Tailwind\$\{left\(tw\[1\]\)\}/.test(page));
  ok("and it has a panel for the replacement", /function renderReplacement\(view\)/.test(page));
  ok("which sends it to the worker", /action: "replace"/.test(page));
  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  ok("the worker answers that command", /payload\.action === "replace"/.test(worker));
  ok("and offers no actions while the choice is open",
    /options: view\.over \|\| view\.replacement \? \[\] : game\.options\(\)/.test(worker));
  notes.push(`field with Drizzle up: ${JSON.stringify(view.field)}`);
}

// ---------------------------------------------------------------------------

if (notes.length) notes.forEach((n) => console.log(`  ${n}`));
if (failures.length) {
  failures.forEach((f) => console.log(`FAIL ${f}`));
  console.log(`${checked} checked, ${failures.length} failed.`);
  process.exit(1);
}
console.log(`${checked} checked, 0 failed.`);
