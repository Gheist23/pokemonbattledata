// A pivot move switches its user out (TOURNAMENT_PIVOT).
//
// THE BIGGEST SINGLE DIFFERENCE BETWEEN /play/ AND THE GAME, measured 3 Nov 2026:
// **1,530 appearances across the registered teams** -- Parting Shot 856, U-turn 515, Flip Turn
// 110, Volt Switch 25, Baton Pass 20, Chilly Reception 3, Shed Tail 1 -- and not one of them left
// the field. The `pivot` op was never on the exporter's WEB_MOVE_OPS list, so the website was
// never sent it: a U-turn was an ordinary 70 BP attack whose user then just stood there.
//
// It went unnoticed by the earlier Ability audit because the three commonest pivots are DAMAGING
// moves -- a scan for "status moves with no model" cannot see them -- and pivoting is not an
// Ability. The lesson is in `champions-play-page`: audit by MECHANIC, not by the shape of the
// thing that carries it.
//
// The user is FLAGGED and swapped by `refill`, which is how Emergency Exit already leaves the
// field (TOURNAMENT_BAIL): a Pokemon taken off in the middle of a turn breaks seat rule 1, and
// `refill` is the one place that moves Pokemon safely. Both flags are read by the same loop.
//
//   node tests/run-pivot.mjs
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
import { TournamentTest, TOURNAMENT_PIVOT, tournamentPivotOption } from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";

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
const data = new BuilderData(appData);
data.ingestMeta(FORMAT, meta);

function makeSolver(pivotRule) {
  const ev = new TeamEvaluator(data, new DamageEngine(appData), FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Solver(new TournamentTest(evaluation, new KnownTeams(knownRaw),
    new TeamSuggestions(evaluation), { effects, liveHpRule: 1, abilityOpsRule: 1, pivotRule }));
}
function setFor(species, extra = {}) {
  for (const r of meta.pokemon) {
    if (String(r.species).toLowerCase() !== species.toLowerCase()) continue;
    const base = data.commonSet(FORMAT, r.species, r.form);
    if (base && base.moves?.length) return makeSet({ ...base, moves: [...base.moves], ...extra });
  }
  return null;
}
const A = setFor("Garchomp");
const B = setFor("Dragonite");
const withMove = (set, move) => makeSet({ ...set, moves: [move, ...set.moves.filter((n) => n !== move)].slice(0, 4) });
const row = (set, extra = {}) => ({ set, hp: 100, front: false, ...extra });
function board(rule, lead, bench = 2) {
  const solver = makeSolver(rule);
  const ours = [row(lead, { front: true }), row(B, { front: true })];
  for (let i = 0; i < bench; i += 1) ours.push(row(B));
  const state = solver.buildState({
    sides: [ours, [row(B, { front: true }), row(A, { front: true }), row(A), row(A)]],
    field: {},
  });
  return { solver, state, me: state.active[0][0], foe: state.active[1][0] };
}

/* ---------------------------------------------------- 1. the rule, and the op */
{
  ok("TOURNAMENT_PIVOT is 0", TOURNAMENT_PIVOT === 0, String(TOURNAMENT_PIVOT));
  ok("the option reader turns it off for an older recording",
    tournamentPivotOption(null) === 0 && tournamentPivotOption(1) === 1);
  const fx = effects.moves || {};
  for (const key of ["uturn", "partingshot", "flipturn", "voltswitch", "batonpass"]) {
    ok(`${key} ships its pivot op`, (fx[key] || []).some((e) => e.op === "pivot"), JSON.stringify(fx[key]));
  }
  ok("Baton Pass is the one that carries its state",
    (fx.batonpass || []).some((e) => e.op === "pivot" && e.pass_state),
    JSON.stringify(fx.batonpass));
}

/* ---------------------------------------------------- 2. a damaging pivot */
const pivotSlot = (m, key) => m.u.moves.findIndex((i) => i?.key === key);
{
  for (const rule of [0, 1]) {
    const { solver, state, me } = board(rule, withMove(A, "U-turn"));
    const slot = pivotSlot(me, "uturn");
    ok(`rule ${rule}: the test lead really has U-turn`, slot >= 0, String(slot));
    if (slot < 0) continue;
    ok(`rule ${rule}: pivotOf reads it`, Boolean(solver.t.pivotOf(me.u.moves[slot])) === (rule === 1),
      JSON.stringify(solver.t.pivotOf(me.u.moves[slot])));
    solver.t.markPivot(me, me.u.moves[slot], state.sides, state.active);
    solver.t.refill(state.active, state.sides, state.next, state.board);
    const standing = state.active[0][0];
    if (rule === 0) {
      ok("rule 0: the user stays exactly where it was", standing === me, standing.u.species);
    } else {
      ok("rule 1: somebody else is in the seat", standing !== me, standing.u.species);
      ok("and the user is on the bench, not gone", state.sides[0].includes(me));
      ok("with its HP intact", me.hp === 1 && me.out !== true, String(me.hp));
      ok("and the arrival is marked just in", standing.justIn === true);
      notes.push(`U-turn: ${me.u.species} out, ${standing.u.species} in`);
    }
  }
}

/* ---------------------------------------------------- 3. a status pivot */
{
  const lead = withMove(A, "Parting Shot");
  const { solver, state, me } = board(1, lead);
  const slot = pivotSlot(me, "partingshot");
  ok("the test lead really has Parting Shot", slot >= 0, String(slot));
  if (slot >= 0) {
    ok("pivotOf reads it", Boolean(solver.t.pivotOf(me.u.moves[slot])));
    solver.t.markPivot(me, me.u.moves[slot], state.sides, state.active);
    solver.t.refill(state.active, state.sides, state.next, state.board);
    ok("Parting Shot takes its user off the field", state.active[0][0] !== me,
      state.active[0][0].u.species);
  }
}

/* ---------------------------------------------------- 4. Baton Pass keeps the stages */
{
  const { solver, state, me } = board(1, withMove(A, "Baton Pass"));
  const slot = pivotSlot(me, "batonpass");
  ok("the test lead really has Baton Pass", slot >= 0, String(slot));
  if (slot >= 0) {
    me.atk = 2; me.spe = 1;
    solver.t.markPivot(me, me.u.moves[slot], state.sides, state.active);
    solver.t.refill(state.active, state.sides, state.next, state.board);
    const into = state.active[0][0];
    ok("the Pokemon that comes in has the passed stages", into.atk === 2 && into.spe === 1,
      JSON.stringify([into.atk, into.spe]));
    ok("and the one that left has none", (me.atk || 0) === 0 && (me.spe || 0) === 0);
    notes.push(`Baton Pass: +2 Atk and +1 Spe passed to ${into.u.species}`);
  }
}
{
  // ...and a U-turn does NOT pass them, which is the whole difference between the two.
  const { solver, state, me } = board(1, withMove(A, "U-turn"));
  const slot = pivotSlot(me, "uturn");
  if (slot >= 0) {
    me.atk = 2;
    solver.t.markPivot(me, me.u.moves[slot], state.sides, state.active);
    solver.t.refill(state.active, state.sides, state.next, state.board);
    ok("U-turn passes nothing on", (state.active[0][0].atk || 0) === 0,
      String(state.active[0][0].atk));
  }
}

/* ---------------------------------------------------- 5. nowhere to go */
{
  const { solver, state, me } = board(1, withMove(A, "U-turn"), 0);
  const slot = pivotSlot(me, "uturn");
  if (slot >= 0) {
    // only the two standing, nothing behind them
    const flagged = solver.t.markPivot(me, me.u.moves[slot], state.sides, state.active);
    ok("with nobody on the bench the move does not flag a switch", flagged === false, String(flagged));
    solver.t.refill(state.active, state.sides, state.next, state.board);
    ok("and the user stays on the field", state.active[0][0] === me, state.active[0][0].u.species);
  }
}

/* ---------------------------------------------------- 6. a plain move never pivots */
{
  const { solver, state, me } = board(1, A);
  const plain = me.u.moves.findIndex((i) => i?.damaging && i.key !== "uturn" && i.key !== "flipturn");
  if (plain >= 0) {
    ok("a move with no pivot op reads as none", solver.t.pivotOf(me.u.moves[plain]) === null);
    ok("and flags nothing", solver.t.markPivot(me, me.u.moves[plain], state.sides, state.active) === false);
  }
}

/* ---------------------------------------------------- 7. the wiring */
{
  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  const built = worker.match(/new TournamentTest\([\s\S]*?\);/g) || [];
    // V549: all THREE engines ask for it now. The Tournament Test used to be built with
  // `{{ effects }}` alone, so every modelling rule added since was on in the two live engines
  // and off in the one that produces the numbers on the Test against Tournament Teams screen.
  // What it must still NOT have is either ROLLING rule: it prices expectations and rolls
  // nothing, and a rolling cost handed to an expectation engine is counted twice.
  ok("all three engines ask for the rule, the Tournament Test included",
    built.filter((c) => /pivotRule:\s*1/.test(c)).length === 3,
    String(built.filter((c) => /pivotRule:\s*1/.test(c)).length));
  const tourney = built.find((c) => !/playTournament|solverTournament/.test(c)) || "";
  ok("and the Tournament Test still rolls nothing",
    Boolean(tourney) && !/selfRollRule/.test(tourney) && !/actionRollRule/.test(tourney),
    tourney.slice(0, 160));
  const page = readFileSync(join(root, "builder", "play-game.js"), "utf8");
  // The whole declaration, however long its comments have grown: from `const RUNNABLE_OPS`
  // to the `]);` that closes it.
  const at = page.indexOf("const RUNNABLE_OPS");
  const runnable = page.slice(at, page.indexOf("]);", at));
  ok("the status pivots are offered on the sheet", runnable.includes('"pivot"'),
    runnable.replace(/\s+/g, " ").slice(-140));
}

for (const note of notes) console.log(`   ${note}`);
console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
