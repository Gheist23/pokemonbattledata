// Sucker Punch and Upper Hand: the two moves that read what the TARGET is about to do.
//
// Sucker Punch's own text in the game's archive is: "This move fails unless the target has
// chosen an attack AND HAS NOT YET ATTACKED during the turn this move is used." Upper Hand's is
// "Makes the target flinch. This move fails if the target isn't about to use a priority move."
//
// Neither condition reached the browser. `requires_target_damaging_move` and
// `requires_target_priority_move` were not on the exporter's WEB_MOVE_OPS list, and because
// that op is Sucker Punch's ONLY one the move was dropped from move-effects.json altogether --
// so on the website a 70 BP, +1 priority move could not fail at all, and Upper Hand's +3 landed
// whatever the target had chosen. The Companion had both halves right the whole time
// (`mcts/engine.py`, the `requirement_ops` block).
//
// What is checked here:
//
//   1. the data: both ops ship, and Sucker Punch is in the file at all;
//   2. it lands when the target really is about to attack;
//   3. IT FAILS WHEN THE TARGET ALREADY ATTACKED -- the half that is easy to miss, because the
//      move usually moves first. A target using Extreme Speed (+2) goes before Sucker Punch
//      (+1), so by the time it resolves the target has had its turn;
//   4. it fails when the target chose a status move, and when the target chose Protect;
//   5. Upper Hand lands on a priority move and fails on an ordinary one;
//   6. the turn says "fails" rather than silently doing nothing.
//
//   node tests/run-sucker-punch.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

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
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const knownRaw = JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8"));
const effects = JSON.parse(readFileSync(join(root, "data", "builder", "move-effects.json"), "utf8"));

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

function makeSolver({ format = "Doubles", withEffects = true } = {}) {
  const engine = new DamageEngine(appData);
  const meta = JSON.parse(readFileSync(join(root, "data", "builder", `meta-${format.toLowerCase()}.json`), "utf8"));
  const ev = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const tournament = new TournamentTest(evaluation, new KnownTeams(knownRaw), new TeamSuggestions(evaluation),
    withEffects ? { effects, liveHpRule: 1, chargeRule: 1 } : { liveHpRule: 1, chargeRule: 1 });
  const solver = new Solver(tournament);
  // The expectation rather than a random roll, so "did it land" is a fact and not a die.
  solver.t.rollHit = (hit) => hit.frac;
  return solver;
}

const set = (species, item, ability, nature, moves, bonuses, form) => ({
  species, form: form || species, item, ability, nature, moves, bonuses: [...bonuses],
});
const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });
const board = (ourRows, theirRows, field = {}) => ({ sides: [ourRows, theirRows], field });
const lost = (r) => +((1 - r.hp) * 100).toFixed(3);

// Black Glasses on both sides is inert for these types, so nothing heals or chips between the
// readings (a Leftovers tick is worth more than some of the differences measured here).
const PUNCHER = set("Kingambit", "Black Glasses", "Defiant", "Adamant",
  ["Sucker Punch", "Iron Head", "Protect", "Kowtow Cleave"], [32, 32, 0, 0, 2, 0]);
// Extreme Speed is +2 and Sucker Punch is +1, so this target ALWAYS attacks first.
const SPEEDER = set("Dragonite", "Black Glasses", "Inner Focus", "Adamant",
  ["Extreme Speed", "Dragon Claw", "Thunder Wave", "Protect"], [32, 32, 0, 0, 2, 0]);
const PARTNER = set("Amoonguss", "Black Glasses", "Regenerator", "Calm",
  ["Spore", "Pollen Puff", "Rage Powder", "Protect"], [32, 0, 2, 0, 32, 0]);
// Upper Hand is +3 (the move table says 0, which is the stale value `movePriority` corrects).
const HANDER = set("Blaziken", "Black Glasses", "Blaze", "Adamant",
  ["Upper Hand", "Close Combat", "Protect", "Flare Blitz"], [32, 32, 0, 0, 2, 0]);

/** One turn, each side's action chosen by name rather than by the planner. */
function playTurn(solver, state, ourMove, theirMove = null, turn = 1) {
  const events = [];
  const pickFor = (s, name) => {
    if (!name) return [];
    const list = solver.slotCandidates(state, s, 0, { cap: 0 });
    // AIMED AT THE FRONT SEAT. `slotCandidates` offers one action per foe, ordered by value, so
    // a plain find-by-name can pick the one pointed at the PARTNER -- which made Sucker Punch
    // fail here for the honest reason that the partner was not attacking, and said nothing
    // about the rule under test.
    const found = list.find((a) => a.move === name && a.target === 0)
      || list.find((a) => a.move === name);
    return found ? [found] : [];
  };
  const plans = [
    solver.planFor(state, pickFor(0, ourMove), 0),
    solver.planFor(state, pickFor(1, theirMove), 1),
  ];
  solver.t.plannedTurn(state.active, state.board, state.slower, turn, events, null, plans);
  return events;
}

/** A 1v1-shaped Doubles board: the puncher and its target, plus a partner each. */
const faceOff = (solver, theirSet) => solver.buildState(board(
  [row(PUNCHER, { front: true }), row(PARTNER, { front: true })],
  [row(theirSet, { front: true }), row(PARTNER, { front: true })],
));

// ---------------------------------------------------------------------------
// 1. the data
// ---------------------------------------------------------------------------
{
  for (const op of ["requires_target_damaging_move", "requires_target_priority_move"]) {
    ok(`the exporter ships ${op}`, (effects.moveOps || []).includes(op));
  }
  const punch = (effects.moves || {}).suckerpunch || [];
  ok("Sucker Punch is in the file at all", punch.length > 0,
    "its only op was off the list, so the whole move was dropped");
  ok("and carries its condition", punch.some((fx) => fx.op === "requires_target_damaging_move"), JSON.stringify(punch));
  const upper = (effects.moves || {}).upperhand || [];
  ok("Upper Hand carries its condition", upper.some((fx) => fx.op === "requires_target_priority_move"), JSON.stringify(upper));

  const t = makeSolver().t;
  ok("the condition is read off the move", t.requirementOf(t.moveInfo("Sucker Punch")) === "requires_target_damaging_move");
  ok("and off Upper Hand", t.requirementOf(t.moveInfo("Upper Hand")) === "requires_target_priority_move");
  ok("an ordinary move has none", t.requirementOf(t.moveInfo("Iron Head")) === "");
  // The priority the engine really orders by, which is NOT the move table's own field.
  ok("Upper Hand is +3 for turn order", t.moveInfo("Upper Hand").priority === 3,
    String(t.moveInfo("Upper Hand").priority));
  ok("Sucker Punch is +1", t.moveInfo("Sucker Punch").priority === 1);
  ok("Extreme Speed is +2, so it goes first", t.moveInfo("Extreme Speed").priority === 2);
}

// ---------------------------------------------------------------------------
// 2. it lands when the target is about to attack
// ---------------------------------------------------------------------------
let landed = 0;
{
  const solver = makeSolver();
  const state = faceOff(solver, SPEEDER);
  const events = playTurn(solver, state, "Sucker Punch", "Dragon Claw");
  landed = lost(state.active[1][0]);
  ok("Sucker Punch lands on a target about to attack", landed > 0, String(landed));
  ok("and the turn does not report a failure",
    !events.some((e) => e.kind === "fails" && e.move === "Sucker Punch"), JSON.stringify(events.map((e) => e.kind)));
  notes.push(`lands for ${landed.toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
// 3. IT FAILS WHEN THE TARGET HAS ALREADY ATTACKED
// ---------------------------------------------------------------------------
{
  // Extreme Speed is +2 and Sucker Punch +1, so the target has had its turn by the time the
  // punch resolves. It chose an attack -- the first half of the condition is met -- and the
  // move still fails, which is the half the website had no way to express.
  const solver = makeSolver();
  const state = faceOff(solver, SPEEDER);
  const events = playTurn(solver, state, "Sucker Punch", "Extreme Speed");
  ok("the target really went first", state.active[0][0].hp < 1,
    "Extreme Speed should have landed on the puncher");
  ok("Sucker Punch fails against a target that already attacked", lost(state.active[1][0]) === 0,
    `${lost(state.active[1][0])}% dealt, expected 0`);
  ok("and the turn says so", events.some((e) => e.kind === "fails" && e.move === "Sucker Punch"),
    JSON.stringify(events.map((e) => `${e.kind}:${e.move || ""}`)));

  // The control: with the registry off the old behaviour is back, which is what proves the
  // check above is doing the work rather than something else on the board.
  const bare = makeSolver({ withEffects: false });
  const plain = faceOff(bare, SPEEDER);
  playTurn(bare, plain, "Sucker Punch", "Extreme Speed");
  ok("...and without the registry it would still have landed, as it used to",
    lost(plain.active[1][0]) > 0, String(lost(plain.active[1][0])));
}

// ---------------------------------------------------------------------------
// 4. it fails when the target is not attacking at all
// ---------------------------------------------------------------------------
{
  for (const [move, why] of [["Thunder Wave", "a status move"], ["Protect", "Protect"]]) {
    const solver = makeSolver();
    const state = faceOff(solver, SPEEDER);
    const events = playTurn(solver, state, "Sucker Punch", move);
    ok(`Sucker Punch fails against ${why}`, lost(state.active[1][0]) === 0,
      `${lost(state.active[1][0])}% dealt against ${move}`);
    ok(`and says so against ${why}`, events.some((e) => e.kind === "fails" && e.move === "Sucker Punch"));
  }
  // ...and a target that chose nothing at all is not an attack either.
  const idle = makeSolver();
  const state = faceOff(idle, SPEEDER);
  playTurn(idle, state, "Sucker Punch", null);
  ok("and fails against a target that chose nothing", lost(state.active[1][0]) === 0,
    String(lost(state.active[1][0])));
}

// ---------------------------------------------------------------------------
// 5. Upper Hand asks for a PRIORITY move
// ---------------------------------------------------------------------------
{
  const hit = makeSolver();
  const a = hit.buildState(board(
    [row(HANDER, { front: true }), row(PARTNER, { front: true })],
    [row(SPEEDER, { front: true }), row(PARTNER, { front: true })],
  ));
  playTurn(hit, a, "Upper Hand", "Extreme Speed");
  ok("Upper Hand lands on a target about to use a priority move", lost(a.active[1][0]) > 0,
    String(lost(a.active[1][0])));

  const miss = makeSolver();
  const b = miss.buildState(board(
    [row(HANDER, { front: true }), row(PARTNER, { front: true })],
    [row(SPEEDER, { front: true }), row(PARTNER, { front: true })],
  ));
  const events = playTurn(miss, b, "Upper Hand", "Dragon Claw");
  ok("and fails on an ordinary one", lost(b.active[1][0]) === 0, String(lost(b.active[1][0])));
  ok("and says so", events.some((e) => e.kind === "fails" && e.move === "Upper Hand"));
}

for (const note of notes) console.log(`   ${note}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(`\n${checked} checked, ${failures.length} failed.`);
process.exit(failures.length ? 1 : 0);
