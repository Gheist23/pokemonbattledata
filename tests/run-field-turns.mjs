// Weather and terrain run out, and the moves that set them work (TOURNAMENT_FIELD_TURNS).
//
// TWO HALVES OF ONE GAP, both measured 3 Nov 2026 in a played game.
//
// 1. NOTHING EVER ENDED. `board.w` and `board.t` were set and never counted down. Tailwind
//    (`board.tw`) and Trick Room (`board.tr`) have had timers all along, so the hole was these
//    two alone: played nine turns with a Pelipper lead and it was still raining. Weather is in
//    most Doubles games, so this changed how every one of them went.
// 2. THE MOVES DID NOTHING. Rain Dance, Sunny Day, Sandstorm, Snowscape, Hail, Chilly Reception
//    and the four terrain moves all compiled to `weather` / `terrain` ops, both of which are on
//    the exporter's WEB_MOVE_OPS list and have been shipped for as long as the registry has --
//    and `runEffectOps` had no branch for either, so using one did nothing at all. They were not
//    even offered: `play-game.js` only offers a status move whose every op it can run, so a
//    Pelipper's Rain Dance came out greyed with "Not available this turn".
//
// Five turns, or eight when the setter holds the matching rock or a Terrain Extender -- the
// Companion's own numbers (`mcts/engine.py`, `_WEATHER_ROCKS`, `terrain_turns`).
//
// What is checked:
//
//   1. the rule, and that a count of 0 means NO TIMER rather than "gone" -- a pinned field must
//      not rain itself off, and under rule 0 nothing anywhere expires;
//   2. an entry Ability: five turns, then the weather is gone;
//   3. a rock makes it eight, and a Terrain Extender does the same for terrain;
//   4. the moves set the field, and set it for the right number of turns;
//   5. a terrain move run by a holder of the Extender gets the eight as well;
//   6. the played game shows the counts, and hands them to the opponent's search;
//   7. all three engines ask for the rule.
//
//   node tests/run-field-turns.mjs
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
import { TournamentTest, TOURNAMENT_FIELD_TURNS, tournamentFieldTurnsOption, WEATHERS, TERRAINS } from "../builder/tournament-test.js";
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
const known = new KnownTeams(knownRaw);

function makeSolver(fieldTurnsRule) {
  const ev = new TeamEvaluator(data, new DamageEngine(appData), FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Solver(new TournamentTest(evaluation, known, new TeamSuggestions(evaluation),
    { effects, liveHpRule: 1, fieldTurnsRule }));
}

const setOf = (species, form, extra = {}) => {
  const base = data.commonSet(FORMAT, species, form);
  return base && base.moves?.length ? makeSet({ ...base, moves: [...base.moves], ...extra }) : null;
};
const row = (set, extra = {}) => ({ set, hp: 100, front: false, ...extra });

// A Drizzle holder and a plain partner, both from the real meta.
const DRIZZLE = (() => {
  for (const r of meta.pokemon) {
    const s = setOf(r.species, r.form);
    if (s && /drizzle/i.test(s.ability)) return r;
  }
  return null;
})();
ok("the meta has a weather Ability to test with", Boolean(DRIZZLE), "no Drizzle holder");
const PLAIN = meta.pokemon.map((r) => setOf(r.species, r.form)).filter(Boolean)
  .filter((s) => s.species !== setOf(DRIZZLE.species, DRIZZLE.form)?.species);

function fieldAfter(rule, { item = "", turns = 12 } = {}) {
  const solver = makeSolver(rule);
  const setter = setOf(DRIZZLE.species, DRIZZLE.form, item ? { item } : {});
  const state = solver.buildState({
    sides: [[row(setter, { front: true }), row(PLAIN[0], { front: true })],
      [row(PLAIN[1], { front: true }), row(PLAIN[2], { front: true })]],
    field: {},
  });
  // the lead's entry Ability, exactly as a game starts it
  for (const m of state.active[0]) if (m) { m.entered = false; }
  solver.t.enter(state.active[0][0], state.active, state.board, null);
  const seen = [];
  for (let i = 0; i < turns; i += 1) {
    seen.push(`${WEATHERS[state.board.w]}:${state.board.wt}`);
    solver.t.tickField(state.board);
  }
  return { board: state.board, seen };
}

/* -------------------------------------------- 1. the rule itself */
{
  ok("TOURNAMENT_FIELD_TURNS is 0", TOURNAMENT_FIELD_TURNS === 0, String(TOURNAMENT_FIELD_TURNS));
  ok("the option reader turns it off for an older recording",
    tournamentFieldTurnsOption(null) === 0 && tournamentFieldTurnsOption(1) === 1);
  const solver = makeSolver(0);
  ok("an engine built with the default does not model it", solver.t.fieldTurnsOn === false);
  // A pinned field, or any board carrying 0: no timer, and `tickField` leaves it alone.
  const on = makeSolver(1);
  const pinned = { w: 2, t: 1, tw: [0, 0], tr: 0, wt: 0, tt: 0 };
  for (let i = 0; i < 9; i += 1) on.t.tickField(pinned);
  ok("a count of 0 means NO TIMER, so a pinned field never blows out",
    pinned.w === 2 && pinned.t === 1, JSON.stringify(pinned));
}

/* -------------------------------------------- 2. an entry Ability, five turns */
{
  const off = fieldAfter(0);
  ok("rule 0: the weather never ends", off.board.w !== 0 && off.seen.every((s) => !s.startsWith("None")),
    off.seen.join(" "));

  const on = fieldAfter(1);
  ok("rule 1: it starts at five", on.seen[0].endsWith(":5"), on.seen.join(" "));
  ok("and counts down one a turn", on.seen.slice(0, 5).map((s) => s.split(":")[1]).join(",") === "5,4,3,2,1",
    on.seen.join(" "));
  ok("and is gone on the sixth", on.seen[5].startsWith("None"), on.seen.join(" "));
  ok("and stays gone", on.board.w === 0 && on.board.wt === 0, JSON.stringify([on.board.w, on.board.wt]));
  notes.push(`entry Ability: ${on.seen.slice(0, 7).join(" ")}`);
}

/* -------------------------------------------- 3. the rocks */
{
  const plain = fieldAfter(1);
  const rock = fieldAfter(1, { item: "Damp Rock" });
  ok("a Damp Rock makes the Rain eight turns", rock.seen[0].endsWith(":8"), rock.seen.join(" "));
  ok("and it really lasts longer than the plain five",
    rock.seen.filter((s) => !s.startsWith("None")).length
      === plain.seen.filter((s) => !s.startsWith("None")).length + 3,
    `${rock.seen.length} vs ${plain.seen.length}`);
  // the WRONG rock does nothing
  const wrong = fieldAfter(1, { item: "Heat Rock" });
  ok("a Heat Rock does nothing for Rain", wrong.seen[0].endsWith(":5"), wrong.seen.join(" "));
  notes.push(`Damp Rock: ${rock.seen.slice(0, 9).join(" ")}`);
}

/* -------------------------------------------- 4+5. the moves */
/** Use one field move, from a Pokemon that really has it in its four. */
function runMove(moveName, { item = "", rule = 1 } = {}) {
  const solver = makeSolver(rule);
  // The move has to be ON the set: `runEffectOps` reads `m.u.moves[a.slot]` for the accuracy.
  const base = data.commonSet(FORMAT, DRIZZLE.species, DRIZZLE.form);
  const moves = [moveName, ...base.moves.filter((n) => n !== moveName)].slice(0, 4);
  const setter = makeSet({ ...base, moves, ...(item ? { item } : {}) });
  const state = solver.buildState({
    sides: [[row(setter, { front: true }), row(PLAIN[0], { front: true })],
      [row(PLAIN[1], { front: true }), row(PLAIN[2], { front: true })]],
    field: {},
  });
  const m = state.active[0][0];
  const ops = solver.t.effectsOf(moveName) || [];
  const { did } = solver.t.runEffectOps(m, null, { slot: 0, ops }, state.active, null, state.board);
  return { board: state.board, did };
}
{
  const fx = effects.moves || {};
  ok("Rain Dance is shipped as a weather op", Boolean(fx.raindance?.some((e) => e.op === "weather")));
  for (const [move, want] of [["Sunny Day", "Sun"], ["Sandstorm", "Sand"], ["Snowscape", "Snow"]]) {
    const { board } = runMove(move);
    ok(`${move} sets ${want}`, WEATHERS[board.w] === want, WEATHERS[board.w]);
    ok(`${move} sets it for five turns`, board.wt === 5, String(board.wt));
  }
  const { board: offBoard } = runMove("Sunny Day", { rule: 0 });
  ok("rule 0: a weather move still does nothing", WEATHERS[offBoard.w] !== "Sun", WEATHERS[offBoard.w]);

  const { board: rocked } = runMove("Sunny Day", { item: "Heat Rock" });
  ok("a Heat Rock makes Sunny Day eight turns", rocked.wt === 8, String(rocked.wt));

  for (const [move, want] of [["Grassy Terrain", "Grassy"], ["Psychic Terrain", "Psychic"]]) {
    const { board } = runMove(move);
    ok(`${move} sets ${want} Terrain`, TERRAINS[board.t] === want, TERRAINS[board.t]);
    ok(`${move} sets it for five turns`, board.tt === 5, String(board.tt));
  }
  const { board: extended } = runMove("Grassy Terrain", { item: "Terrain Extender" });
  ok("a Terrain Extender makes it eight", extended.tt === 8, String(extended.tt));
  notes.push("moves: Sunny Day/Sandstorm/Snowscape and the terrain moves all land");
}

/* -------------------------------------------- 6. the played game */
{
  const solver = makeSolver(1);
  const setter = setOf(DRIZZLE.species, DRIZZLE.form);
  const game = new PlayGame(solver, data, FORMAT, library, { pickReplacement: false });
  const FOE = teamFromKnown(data, FORMAT, known.teams[0]).slice(0, 6);
  let view = game.start({ player: [setter, PLAIN[0], PLAIN[1], PLAIN[2]], foe: FOE, seed: 4 });
  ok("the game opens with the count on the view", view.field.weatherTurns === 5,
    JSON.stringify(view.field));
  const seen = [`${view.field.weather}:${view.field.weatherTurns}`];
  for (let turn = 1; turn <= 6 && !game.over(); turn += 1) {
    const options = game.options();
    const chosen = options.filter((o) => !o.empty).map((o) => o.actions[0]?.id).filter(Boolean);
    if (!chosen.length) break;
    const foeOptions = [0, 1].map((p) => solver.slotCandidates(game.state, 1, p, { cap: 0 }));
    game.resolve(game.jointFrom(options, chosen),
      solver.planFor(game.state, foeOptions.map((l) => l[0]).filter(Boolean), 1));
    view = game.view();
    seen.push(`${view.field.weather}:${view.field.weatherTurns}`);
  }
  ok("and the rain really stops during the game", seen.some((s) => s.startsWith("None")), seen.join(" "));
  // ...and the opponent searches a board that knows it
  const boards = game.possibleBoards(1);
  const field = boards?.[0]?.field || {};
  ok("the board the opponent searches carries the counts",
    Object.prototype.hasOwnProperty.call(field, "weatherTurns")
      && Object.prototype.hasOwnProperty.call(field, "terrainTurns"),
    JSON.stringify(field));
  notes.push(`played: ${seen.join(" ")}`);
}

/* -------------------------------------------- 7. who asks for the rule */
{
  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  const built = worker.match(/new TournamentTest\([\s\S]*?\);/g) || [];
  const asking = built.filter((call) => /fieldTurnsRule:\s*1/.test(call));
  // V549: all THREE engines ask for it. The Tournament Test used to be built with
  // `{ effects }` alone, so every modelling rule added since was on in the two live
  // engines and off in the one that produces the Test against Tournament Teams numbers.
  ok("all three engines ask for the rule", asking.length === 3, String(asking.length));
  const page = readFileSync(join(root, "builder", "play-game.js"), "utf8");
  ok("and the weather moves are offered on the sheet",
    /RUNNABLE_OPS[\s\S]{0,260}"weather"[\s\S]{0,40}"terrain"/.test(page));
}

for (const note of notes) console.log(`   ${note}`);
console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
