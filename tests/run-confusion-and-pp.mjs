// Confusion and PP in the turn engine (TOURNAMENT_CONFUSION, TOURNAMENT_PP).
//
// TWO THINGS THE ENGINE DID NOT HAVE, both with their data already in the browser.
//
// CONFUSION. Twenty moves ship a `volatile` confusion op -- Axe Kick, Confuse Ray, Dynamic
// Punch, Water Pulse and the rest -- and the engine did nothing with `volatile` ops at all. The
// secondary effect of all twenty was inert, `st` had no field for it, and the Persim Berry was
// documented as unmodellable because there was nothing for it to cure.
//
// PP. `app-data.json` has carried a `pp` for all 955 moves from the first export, and
// `moveInfo` dropped the field: the row had no counter and every move could be used for ever.
// The Leppa Berry had nothing to restore. It really binds -- a played game runs 40 turns and 177
// of the game's moves have 8 PP.
//
// What is checked here:
//
//   1. both rules are 0 by default, and under rule 0 nothing moves at all;
//   2. a confusion lands, costs a third of an action, wears off, and is NOT a major status --
//      it stacks with a burn, which is the thing that would have been easy to get wrong;
//   3. Own Tempo refuses it, and the Persim and Lum Berries cure it;
//   4. PP come off the move used, a depleted move leaves BOTH action generators, and the
//      Pokemon keeps its switches rather than being stuck;
//   5. a Leppa Berry restores 10 PP to the move that ran out, capped at its own maximum;
//   6. a two-turn move pays on the turn it is started and not again when it lands;
//   7. both survive a round trip through a described board.
//
//   node tests/run-confusion-and-pp.mjs
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
import { TournamentTest, TOURNAMENT_CONFUSION, TOURNAMENT_PP } from "../builder/tournament-test.js";
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
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const appData = read("data", "builder", "app-data.json");
const meta = read("data", "builder", "meta-doubles.json");
const effects = read("data", "builder", "move-effects.json");
const knownRaw = read("data", "builder", "known-teams.json");

function makeSolver(rules = {}) {
  const engine = new DamageEngine(appData);
  const ev = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Solver(new TournamentTest(evaluation, new KnownTeams(knownRaw),
    new TeamSuggestions(evaluation), { effects, liveHpRule: 1, berryRule: 1, ...rules }));
}

const set = (species, item, ability, nature, moves, bonuses) =>
  ({ species, form: species, item, ability, nature, moves, bonuses: [...bonuses] });
const MOVES = ["Flash Cannon", "Body Press", "Dragon Pulse", "Protect"];
const EVS = [32, 0, 0, 32, 2, 0];
const PLAIN = set("Archaludon", "Leftovers", "Stamina", "Modest", MOVES, EVS);
const LEPPA = set("Archaludon", "Leppa Berry", "Stamina", "Modest", MOVES, EVS);
const PERSIM = set("Archaludon", "Persim Berry", "Stamina", "Modest", MOVES, EVS);
const LUM = set("Archaludon", "Lum Berry", "Stamina", "Modest", MOVES, EVS);
/** Slowbro-Galar is not guaranteed to be in the meta; Own Tempo is taken from a real set. */
const ownTempoSet = () => {
  for (const record of meta.pokemon) {
    const s = appData.species.find((e) => e.name === record.species);
    const form = s?.forms?.find((f) => f.form === record.form);
    if (form?.abilities?.includes("Own Tempo")) {
      return set(record.species, "Leftovers", "Own Tempo", "Modest", MOVES, EVS);
    }
  }
  return null;
};
const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });

function board(solver, ourSets, theirSets, field = {}) {
  return solver.buildState({
    sides: [ourSets.map((s) => row(s, { front: true })), theirSets.map((s) => row(s, { front: true }))],
    field,
  });
}

// ---------------------------------------------------------------------------
// 1. the rules are off by default
// ---------------------------------------------------------------------------
{
  ok("TOURNAMENT_CONFUSION is 0", TOURNAMENT_CONFUSION === 0, String(TOURNAMENT_CONFUSION));
  ok("TOURNAMENT_PP is 0", TOURNAMENT_PP === 0, String(TOURNAMENT_PP));
  const off = makeSolver();
  ok("an engine built with the defaults has neither",
    off.t.confusionOn === false && off.t.ppOn === false);
  const on = makeSolver({ confusionRule: 1, ppRule: 1 });
  ok("and one asked for them has both", on.t.confusionOn === true && on.t.ppOn === true);

  const state = board(off, [PLAIN, LEPPA], [PLAIN, PLAIN]);
  const m = state.active[0][0];
  ok("rule 0: a confusion does not land", off.t.confuse(m, 1) === 0 && (m.st.cnf || 0) === 0,
    String(m.st.cnf));
  ok("rule 0: and costs no action", near(off.t.actionScale(m), 1));
  const lep = state.active[0][1];
  const full = lep.pp[0];
  for (let i = 0; i < full + 2; i += 1) off.t.spendPp(lep, 0);
  ok("rule 0: PP do not come off", lep.pp[0] === full, `${lep.pp[0]} vs ${full}`);
  ok("rule 0: and nothing is ever out of PP", off.t.hasPp(lep, 0) === true);
}

// ---------------------------------------------------------------------------
// 2. a confusion lands, costs a third, wears off, and stacks with a status
// ---------------------------------------------------------------------------
{
  const solver = makeSolver({ confusionRule: 1 });
  const state = board(solver, [PLAIN, PLAIN], [PLAIN, PLAIN]);
  const m = state.active[0][0];
  ok("the st object has a confusion slot", "cnf" in m.st, Object.keys(m.st).join(","));
  ok("a whole confusion lands", solver.t.confuse(m, 1) === 1 && near(m.st.cnf, 1), String(m.st.cnf));
  ok("and it costs exactly a third of an action", near(solver.t.actionScale(m), 2 / 3, 1e-9),
    String(solver.t.actionScale(m)));
  ok("a second one cannot stack past a whole", solver.t.confuse(m, 1) === 0 && near(m.st.cnf, 1));

  // IT IS NOT A MAJOR STATUS. This is the one that would have been easy to get wrong: putting
  // `cnf` in `statusFree` would have let a confusion block a Will-O-Wisp, which the game does
  // not do.
  ok("a confused Pokemon can still be burned", near(solver.t.statusFree(m), 1),
    String(solver.t.statusFree(m)));
  ok("and the burn lands", solver.t.applyStatus(m, "burn", 1) === 1 && near(m.st.brn, 1));
  ok("while the confusion is still there", near(m.st.cnf, 1), String(m.st.cnf));
  ok("and both cost their own share of the action",
    near(solver.t.actionScale(m), 2 / 3, 1e-9), String(solver.t.actionScale(m)));

  // A partial confusion is a partial cost, which is what the expectation model means.
  const other = state.active[0][1];
  solver.t.confuse(other, 0.3);
  ok("a 30% confusion costs a tenth of an action", near(solver.t.actionScale(other), 1 - 0.1, 1e-9),
    String(solver.t.actionScale(other)));
  notes.push(`confused: actionScale 1 -> ${solver.t.actionScale(m).toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 3. Own Tempo, and the berries that cure it
// ---------------------------------------------------------------------------
{
  const solver = makeSolver({ confusionRule: 1 });
  const tempo = ownTempoSet();
  ok("a real Own Tempo holder was found in the meta", Boolean(tempo), tempo?.species || "none");
  if (tempo) {
    const state = board(solver, [tempo, PLAIN], [PLAIN, PLAIN]);
    const m = state.active[0][0];
    ok("the kit knows it refuses a confusion", m.k.confusionProof === true, String(m.k.confusionProof));
    ok("so no confusion lands on it", solver.t.confuse(m, 1) === 0 && (m.st.cnf || 0) === 0);
    notes.push(`Own Tempo: ${tempo.species}`);
  }

  for (const [label, carrier] of [["Persim", PERSIM], ["Lum", LUM]]) {
    const state = board(solver, [carrier, PLAIN], [PLAIN, PLAIN]);
    const m = state.active[0][0];
    ok(`${label} holder carries a cure for cnf`, (m.k.cures || []).includes("cnf"),
      JSON.stringify(m.k.cures));
    ok(`${label} cures the confusion`, solver.t.confuse(m, 1) === 0 && (m.st.cnf || 0) === 0,
      String(m.st.cnf));
    ok(`and ${label} is spent`, near(m.cure, 0), String(m.cure));
    ok(`so a second confusion sticks on the spent ${label}`,
      solver.t.confuse(m, 1) === 1 && near(m.st.cnf, 1));
  }
  // Persim cures ONLY confusion -- it is the one cure berry with a single volatile.
  const state = board(solver, [PERSIM, PLAIN], [PLAIN, PLAIN]);
  const m = state.active[0][0];
  ok("Persim does not cure a burn", solver.t.applyStatus(m, "burn", 1) === 1 && near(m.st.brn, 1));
  ok("and is still in hand", near(m.cure, 1), String(m.cure));
}

// ---------------------------------------------------------------------------
// 4-5. PP, and the Leppa Berry
// ---------------------------------------------------------------------------
{
  const solver = makeSolver({ ppRule: 1 });
  const state = board(solver, [LEPPA, PLAIN], [PLAIN, PLAIN]);
  const lep = state.active[0][0];
  const plain = state.active[0][1];

  ok("moveInfo carries each move's PP",
    (lep.u.moves || []).every((info) => Number.isInteger(info.pp) && info.pp > 0),
    JSON.stringify((lep.u.moves || []).map((i) => i.pp)));
  ok("and the row is seeded from it",
    JSON.stringify(lep.pp) === JSON.stringify((lep.u.moves || []).map((i) => i.pp)),
    `${JSON.stringify(lep.pp)} vs ${JSON.stringify((lep.u.moves || []).map((i) => i.pp))}`);
  const max = plain.pp[0];
  ok("the move really has a finite PP", max > 0 && max < 100, String(max));

  // One per use, off the move used and no other.
  solver.t.spendPp(plain, 0);
  ok("one PP comes off the move used", plain.pp[0] === max - 1, String(plain.pp[0]));
  ok("and off no other", plain.pp[1] === plain.u.moves[1].pp);

  for (let i = 1; i < max; i += 1) solver.t.spendPp(plain, 0);
  ok("the move runs out", plain.pp[0] === 0, String(plain.pp[0]));
  ok("and is then refused", solver.t.hasPp(plain, 0) === false);
  ok("while the others are not", solver.t.hasPp(plain, 1) === true);
  ok("a use past empty cannot go negative", (solver.t.spendPp(plain, 0), plain.pp[0] === 0),
    String(plain.pp[0]));

  // The Leppa Berry.
  // The count is taken FIRST: `i < lep.pp[0]` re-reads a counter that is going down, so the
  // two meet in the middle and the loop stops half way -- which is how this test first read 6.
  const lepFull = lep.pp[0];
  for (let i = 0; i < lepFull; i += 1) solver.t.spendPp(lep, 0);
  ok("the Leppa Berry restores 10 PP", lep.pp[0] === Math.min(10, lep.u.moves[0].pp),
    String(lep.pp[0]));
  ok("and is then gone", lep.leppa === false);
  ok("so the move is usable again", solver.t.hasPp(lep, 0) === true);
  const lepAgain = lep.pp[0];
  for (let i = 0; i < lepAgain; i += 1) solver.t.spendPp(lep, 0);
  ok("and the second time it runs out it stays out", lep.pp[0] === 0 && !solver.t.hasPp(lep, 0));
  notes.push(`PP: ${JSON.stringify(plain.u.moves.map((i) => i.pp))}, Leppa restored to ${Math.min(10, lep.u.moves[0].pp)}`);

  // The depleted move leaves the action list, and the Pokemon is not stuck.
  const offered = solver.slotCandidates(state, 0, 1, { cap: 0 }).filter((a) => a.move);
  const names = [...new Set(offered.map((a) => a.move))];
  ok("the empty move is not offered", !names.includes(plain.u.moves[0].name), names.join(","));
  ok("but the others still are", names.length >= 2, names.join(","));
  ok("and nothing is ever offered with no PP",
    solver.slotCandidates(state, 0, 1, { cap: 0 })
      .every((a) => a.slot === undefined || a.slot < 0 || solver.t.hasPp(plain, a.slot)));

  // Rule 0 keeps the full list, which is the proof the gate is the rule and not an accident.
  const free = makeSolver();
  const freeState = board(free, [PLAIN, PLAIN], [PLAIN, PLAIN]);
  const freeNames = [...new Set(free.slotCandidates(freeState, 0, 1, { cap: 0 })
    .filter((a) => a.move).map((a) => a.move))];
  ok("rule 0 offers every move", freeNames.length >= names.length, `${freeNames.length} vs ${names.length}`);
}

// ---------------------------------------------------------------------------
// 6. a two-turn move pays once
// ---------------------------------------------------------------------------
{
  const source = readFileSync(join(root, "builder", "tournament-test.js"), "utf8");
  // The spend sits BEFORE the charge branch and is skipped while `m.charging` is set, which is
  // what makes the charge turn pay and the release turn not.
  const spend = source.indexOf("if (this.ppOn && !m.charging) this.spendPp(");
  const charge = source.indexOf("if (this.chargeOn) {\n        const slot = a.hit ? a.hit.slot : a.slot;");
  ok("the PP spend is in the action loop", spend > 0);
  ok("and it comes before the charge branch", spend > 0 && charge > 0 && spend < charge,
    `${spend} vs ${charge}`);
  ok("and it is skipped on the landing turn", /!m\.charging\) this\.spendPp\(/.test(source));
}

// ---------------------------------------------------------------------------
// 7. both survive a described board
// ---------------------------------------------------------------------------
{
  const solver = makeSolver({ confusionRule: 1, ppRule: 1 });
  const state = solver.buildState({
    sides: [[row(LEPPA, { front: true, confused: 0.5, pp: [3, 0, 12, 8], leppa: false }),
      row(PLAIN, { front: true })], [row(PLAIN, { front: true }), row(PLAIN, { front: true })]],
    field: {},
  });
  const m = state.active[0][0];
  ok("a board can say how confused a Pokemon is", near(m.st.cnf, 0.5), String(m.st.cnf));
  ok("and it costs the right share of an action", near(solver.t.actionScale(m), 1 - 0.5 / 3, 1e-9),
    String(solver.t.actionScale(m)));
  ok("a board can say how much PP is left", m.pp[0] === 3 && m.pp[1] === 0,
    JSON.stringify(m.pp));
  ok("so the empty move is refused", solver.t.hasPp(m, 1) === false);
  ok("and a board can say the Leppa Berry is already eaten", m.leppa === false);
  // It cannot claim MORE PP than the move has: that would be a board describing an impossibility.
  const greedy = solver.buildState({
    sides: [[row(PLAIN, { front: true, pp: [999, 999, 999, 999] }), row(PLAIN, { front: true })],
      [row(PLAIN, { front: true }), row(PLAIN, { front: true })]],
    field: {},
  });
  const g = greedy.active[0][0];
  ok("and never more than the move's own maximum",
    JSON.stringify(g.pp) === JSON.stringify(g.u.moves.map((i) => i.pp)), JSON.stringify(g.pp));

  const play = readFileSync(join(root, "builder", "play-game.js"), "utf8");
  ok("the view carries the confusion", /confused: Number\(m\.st\?\.cnf\) \|\| 0,/.test(play));
  ok("the row carries the PP", /pp: Array\.isArray\(m\.pp\)/.test(play));
  ok("and an eaten Leppa Berry shows itself", /was\.leppa && !m\.leppa/.test(play));
  const page = readFileSync(join(root, "builder", "play-page.js"), "utf8");
  ok("the tile says Confused", /chips\.push\("Confused"\)/.test(page));
  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  ok("the played game asks for both rules at both sites",
    (worker.match(/confusionRule: 1/g) || []).length === 2
    && (worker.match(/ppRule: 1/g) || []).length === 2);
}

// ---------------------------------------------------------------------------

if (notes.length) notes.forEach((n) => console.log(`  ${n}`));
if (failures.length) {
  failures.forEach((f) => console.log(`FAIL ${f}`));
  console.log(`${checked} checked, ${failures.length} failed.`);
  process.exit(1);
}
console.log(`${checked} checked, 0 failed.`);
