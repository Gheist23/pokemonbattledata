// DIRE CLAW: a 30% chance of ONE of poison, paralysis or sleep.
//
// Found by tests/run-op-coverage.mjs: `random_status` was read nowhere, and a damaging move's
// ops are seen only by `TournamentTest.secondaries`, which knew seven ops and not this one. So
// the move 93.7% of Sneaslers carry was 80 BP and silence.
//
// WHAT "ONE OF THREE" MEANS IN EACH LAYER, which is the part worth pinning:
//
//   * a turn being PLAYED has already spent its roll on the 30%, so exactly one of the three
//     happens and it happens whole;
//   * a SEARCH prices rather than rolls, so each is worth a third of the chance -- 0.1 apiece.
//     Picking one at random there would make the opponent answer the same board differently
//     each time it was asked, which is the property the whole model rests on.
//
// Conditions are PROBABILITIES in this engine (`applyStatus` writes `target.st.psn` etc.), so
// the search layer is checked by reading those shares directly.
//
//   node tests/run-random-status.mjs
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
const near = (label, got, want, tol, detail = "") =>
  ok(label, Math.abs(got - want) <= tol, `${got} vs ${want}${detail ? ` (${detail})` : ""}`);

const appData = read("data", "builder", "app-data.json");
const meta = read("data", "builder", "meta-doubles.json");
const effects = read("data", "builder", "move-effects.json");
const data = new BuilderData(appData);
data.ingestMeta("Doubles", meta);
const engine = new DamageEngine(appData);
const ev = new TeamEvaluator(data, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }));
ev.setMetaRecords(meta.pokemon || []);
const evaluation = new TeamEvaluation(ev);
const known = new KnownTeams(read("data", "builder", "known-teams.json"));
const LIVE = {
  effects, liveHpRule: 1, chargeRule: 1, berryRule: 1, stagesRule: 1, confusionRule: 1, ppRule: 1,
  rberryRule: 1, bailRule: 1, shieldRule: 1, fieldTurnsRule: 1, abilityOpsRule: 1, hazardsRule: 1,
  pivotRule: 1, selfRollRule: 1, actionRollRule: 1, selfStatRule: 1,
};
const newSolver = () => new Solver(new TournamentTest(evaluation, known, new TeamSuggestions(evaluation), LIVE));

const mon = (species, moves, ability = "") => makeSet({
  species, form: species, ability, item: "", moves, nature: "Adamant", level: 50,
});
const row = (s, front) => ({ set: s, hp: 100, front });

// A target with none of the three proofs, so nothing is refused for a reason other than the op.
const FOE = () => mon("Garchomp", ["Earthquake", "Dragon Claw", "Protect", "Rock Slide"], "Rough Skin");

function boardWith(attacker) {
  return {
    sides: [
      [row(attacker, true), row(mon("Gholdengo", ["Make It Rain", "Shadow Ball", "Protect", "Nasty Plot"]), true)],
      [row(FOE(), true), row(mon("Torkoal", ["Eruption", "Heat Wave", "Protect", "Body Press"]), true)],
    ],
    field: {},
  };
}

/* ================================================= 1. the move is offered and lands */

{
  const solver = newSolver();
  const state = solver.buildState(boardWith(mon("Sneasler", ["Dire Claw", "Close Combat", "Protect", "Fake Out"], "Unburden")));
  const options = solver.slotCandidates(state, 0, 0, { cap: 0 });
  const claw = options.filter((a) => a.move === "Dire Claw");
  ok("Dire Claw is offered", claw.length > 0, options.map((a) => a.move).join(", "));
  ok("...at a named target", claw.some((a) => a.target >= 0), JSON.stringify(claw.map((a) => a.target)));
}

/* ========================= 2. priced as a third of the chance each, not all or nothing */

{
  const solver = newSolver();
  const state = solver.buildState(boardWith(mon("Sneasler", ["Dire Claw", "Close Combat", "Protect", "Fake Out"], "Unburden")));
  const claw = solver.slotCandidates(state, 0, 0, { cap: 0 }).find((a) => a.move === "Dire Claw" && a.target === 0);
  const target = state.active[1][0];
  const before = { ...target.st };
  // `given` is a pair of plans, and a plan action's `target` is the mon ROW, not the index
  // slotCandidates returns -- the engine reads `a.target.out` and `a.target.u`.
  const act = { ...claw, m: state.active[0][0], s: 0, target };
  solver.t.plannedTurn(state.active, state.board, state.slower, 1, null, null, [[act], []]);
  const after = target.st;
  const moved = ["psn", "par", "slp"].map((key) => (after[key] || 0) - (before[key] || 0));
  notes.push(`Dire Claw priced: poison ${moved[0].toFixed(3)}, paralysis ${moved[1].toFixed(3)}, sleep ${moved[2].toFixed(3)}`);
  ok("all three conditions moved, so it is not all-or-nothing",
    moved.every((v) => v > 0), JSON.stringify(moved));
  near("...poison is a third of the 30%", moved[0], 0.1, 0.035, "accuracy is folded in");
  near("...paralysis is a third of the 30%", moved[1], 0.1, 0.035);
  // SLEEP IS HALVED BY THE SAME TURN'S END, and that is correct rather than a shortfall: a
  // two-turn sleep is modelled as a share that halves each turn (`st.slp *= 0.5` in endOfTurn),
  // and `plannedTurn` runs the end of the turn it just played. So the 0.1 that landed is 0.05
  // by the time it can be read. Pinned at the halved value on purpose -- asserting 0.1 here
  // would be asserting that the sleep timer does not run.
  near("...sleep lands at a third too, and is half gone by the end of the turn",
    moved[2], 0.05, 0.02, "endOfTurn halves it");
  const total = moved.reduce((a, b) => a + b, 0);
  near("...so the three together come to the chance less that one decay", total, 0.25, 0.05);
}

/* ================================== 3. an immune target is still refused, per condition */

{
  // Garchomp is Ground: Thunder Wave cannot paralyse it, and `applyStatus`'s proofs are what
  // this leans on. A Steel type refuses the poison; the point is that the op goes through the
  // SAME gate as every other status rather than around it.
  const solver = newSolver();
  const board = boardWith(mon("Sneasler", ["Dire Claw", "Close Combat", "Protect", "Fake Out"], "Unburden"));
  board.sides[1][0] = row(mon("Gholdengo", ["Make It Rain", "Shadow Ball", "Protect", "Nasty Plot"], "Good as Gold"), true);
  const state = solver.buildState(board);
  const claw = solver.slotCandidates(state, 0, 0, { cap: 0 }).find((a) => a.move === "Dire Claw" && a.target === 0);
  const target = state.active[1][0];
  const before = target.st.psn || 0;
  // `given` is a pair of plans, and a plan action's `target` is the mon ROW, not the index
  // slotCandidates returns -- the engine reads `a.target.out` and `a.target.u`.
  const act = { ...claw, m: state.active[0][0], s: 0, target };
  solver.t.plannedTurn(state.active, state.board, state.slower, 1, null, null, [[act], []]);
  ok("a Steel type takes no poison from it", (target.st.psn || 0) - before <= 1e-9,
    String((target.st.psn || 0) - before));
  notes.push(`Steel target: poison moved ${((target.st.psn || 0) - before).toFixed(4)}`);
}

/* ====================================================== 4. the source still says why */

const source = readFileSync(join(root, "builder", "tournament-test.js"), "utf8");
ok("secondaries reads random_status", /fx\.op === "random_status"/.test(source));
ok("...and records that a damaging move's ops only arrive there",
  /Found by tests\/run-op-coverage\.mjs/.test(source));

if (failures.length) {
  console.error(`run-random-status: ${failures.length} of ${checked} checks FAILED`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
for (const line of notes) console.log(`  ${line}`);
console.log(`run-random-status: ${checked} checks passed`);
