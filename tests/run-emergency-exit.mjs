// Emergency Exit in the turn engine (TOURNAMENT_BAIL).
//
// Golisopod's defining Ability did nothing here. It was one of twelve missing from the compiled
// registry and the only expensive one: Golisopod is rank 8 in Doubles and rank 5 in Singles and
// stands in 164 of the 1,946 registered teams.
//
// AT THE END OF THE TURN, deliberately. This engine has no forced switch at all, and one in the
// middle of a turn breaks seat rule 1 -- every decision is taken against the state before ANY
// action and the choices are applied together, which is what keeps a team's score against
// itself exactly 50 and a seat swap exactly 100. So the hit FLAGS it and `refill` moves it, with
// the same swap `applySwitches` makes: onto the bench, keeping its HP, able to come back. What
// the approximation loses is escaping a second hit in the same turn; the Companion gets that
// exactly, because the Eject Button already resolved at the moment of the hit over there.
//
// What is checked here:
//
//   1. the rule is 0 by default, and under rule 0 nothing moves;
//   2. the kit reads the Ability -- off the COMPACT spelling, which is what the first attempt
//      got wrong, leaving the flag false for every Golisopod;
//   3. under rule 1 a hit that takes it below half puts it on the bench and brings somebody in;
//   4. it keeps its HP, so it is a switch and not a knockout;
//   5. the THRESHOLD IS CROSSED, not stood below: a holder already under half stays, and a hit
//      that does not reach half does nothing;
//   6. with nothing on the bench it stays, and a fainted holder does not "bail" anywhere;
//   7. it is the BASE form's: Mega Golisopod has Tough Claws, and every team that brings a
//      Golisopod brings the stone, so this fires before the stone is used.
//
//   node tests/run-emergency-exit.mjs
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
import { TournamentTest, TOURNAMENT_BAIL, tournamentBailOption } from "../builder/tournament-test.js";
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

const appData = read("data", "builder", "app-data.json");
const meta = read("data", "builder", "meta-doubles.json");
const effects = read("data", "builder", "move-effects.json");
const knownRaw = read("data", "builder", "known-teams.json");
const data = new BuilderData(appData);
data.ingestMeta("Doubles", meta);

function makeSolver(bailRule) {
  const engine = new DamageEngine(appData);
  const ev = new TeamEvaluator(data, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Solver(new TournamentTest(evaluation, new KnownTeams(knownRaw),
    new TeamSuggestions(evaluation), { effects, liveHpRule: 1, bailRule }));
}

const GOLI = data.commonSet("Doubles", "Golisopod", "Golisopod");
const OTHER = data.commonSet("Doubles", "Garchomp", "Garchomp");
const row = (s, extra = {}) => ({ set: makeSet({ ...s, moves: [...s.moves] }), hp: 100, front: false, ...extra });
/** A landed hit of exactly `frac` of the target's max HP, so the threshold is the only variable. */
const hit = (frac) => ({ slot: 0, frac, lo: frac, hi: frac, odds: 1, rollLo: frac, rollHigh: frac,
  priority: 0, spread: false, self: 0, rberry: false });

function board(bailRule, { hp = 100, bench = 2 } = {}) {
  const solver = makeSolver(bailRule);
  const ours = [row(GOLI, { front: true, hp }), row(OTHER, { front: true })];
  for (let i = 0; i < bench; i += 1) ours.push(row(OTHER));
  const state = solver.buildState({
    sides: [ours, [row(OTHER, { front: true }), row(OTHER, { front: true })]],
    field: {},
  });
  return { solver, state, goli: state.active[0][0], foe: state.active[1][0] };
}

// ---------------------------------------------------------------------------
// 1-2. the rule, and the Ability being read at all
// ---------------------------------------------------------------------------
{
  ok("Golisopod's own set really has the Ability", /emergency exit/i.test(GOLI.ability), GOLI.ability);
  ok("TOURNAMENT_BAIL is 0", TOURNAMENT_BAIL === 0, String(TOURNAMENT_BAIL));
  ok("the option reader turns it off for an older recording",
    tournamentBailOption(null) === 0 && tournamentBailOption(1) === 1);

  const { solver, state, goli, foe } = board(0);
  // The COMPACT spelling. `compact(mon.ability)` has no space in it, so comparing against
  // "emergency exit" matched nothing and the flag was false for every Golisopod -- which is
  // exactly how this went wrong the first time.
  ok("the kit reads the Ability", goli.k.emergencyExit === true, String(goli.k.emergencyExit));
  ok("and an engine built with the default does not model it", solver.t.bailOn === false);
  solver.t.deal(foe, goli, hit(0.6), null);
  ok("rule 0: the hit does not flag it", goli.bailing === false);
  solver.t.refill(state.active, state.sides, state.next, state.board);
  ok("rule 0: so it stays on the field", state.active[0].includes(goli));
  notes.push(`Golisopod's set: ${GOLI.ability} holding ${GOLI.item}`);
}

// ---------------------------------------------------------------------------
// 3-4. under rule 1: onto the bench, with its HP
// ---------------------------------------------------------------------------
{
  const { solver, state, goli, foe } = board(1);
  const replacement = state.sides[0][2];
  solver.t.deal(foe, goli, hit(0.6), null);
  ok("the hit flags it", goli.bailing === true);
  ok("and it is below half but alive", goli.hp > 0 && goli.hp <= 0.5, String(goli.hp));
  solver.t.refill(state.active, state.sides, state.next, state.board);
  ok("it is off the field", !state.active[0].includes(goli));
  ok("somebody came in", Boolean(state.active[0][0]) && state.active[0][0] !== goli);
  ok("and it is the first one off the bench", state.active[0][0] === replacement,
    solver.label(state.active[0][0].u));
  ok("the arrival is marked as just in, so its entry triggers", state.active[0][0].justIn === true);
  // A SWITCH, not a knockout: the HP is exactly what the hit left.
  ok("Golisopod keeps its HP", Math.abs(goli.hp - 0.4) < 1e-9, String(goli.hp));
  ok("and is not out", goli.out !== true);
  ok("it is on the bench, so it can come back", state.sides[0].includes(goli));
  ok("the flag is spent", goli.bailing === false);
  // Its stages and volatiles went with it, as they do on any switch.
  ok("its stages are cleared", goli.atk === 0 && goli.spa === 0 && goli.spe === 0
    && goli.def === 0 && goli.spd === 0);
  notes.push(`rule 1: hit for 60% -> seat 0 is ${solver.label(state.active[0][0].u)}, Golisopod on the bench at ${(goli.hp * 100).toFixed(0)}%`);
}

// ---------------------------------------------------------------------------
// 5. the threshold is crossed, not stood below
// ---------------------------------------------------------------------------
{
  // A hit that leaves it above half does nothing.
  const high = board(1);
  high.solver.t.deal(high.foe, high.goli, hit(0.3), null);
  high.solver.t.refill(high.state.active, high.state.sides, high.state.next, high.state.board);
  ok("a hit that leaves it above half does nothing", high.state.active[0].includes(high.goli),
    String(high.goli.hp));

  // ALREADY below half: a further hit must not bail it out again. The short condition
  // (`hp <= 0.5`) would have, which is a worse bug than the one being fixed.
  const low = board(1, { hp: 40 });
  ok("it starts below half", low.goli.hp <= 0.5, String(low.goli.hp));
  low.solver.t.deal(low.foe, low.goli, hit(0.1), null);
  ok("a further hit does not flag it", low.goli.bailing === false);
  low.solver.t.refill(low.state.active, low.state.sides, low.state.next, low.state.board);
  ok("so it stays", low.state.active[0].includes(low.goli), String(low.goli.hp));

  // Exactly half counts as below, which is what "drops to half or less" means for the berries
  // and what "below half" has to mean here too for the two to agree on the same boundary.
  const edge = board(1);
  edge.solver.t.deal(edge.foe, edge.goli, hit(0.5), null);
  edge.solver.t.refill(edge.state.active, edge.state.sides, edge.state.next, edge.state.board);
  ok("a hit to exactly half takes it off", !edge.state.active[0].includes(edge.goli),
    String(edge.goli.hp));
}

// ---------------------------------------------------------------------------
// 6. nothing to switch to, and a fainted holder
// ---------------------------------------------------------------------------
{
  const { solver, state, goli, foe } = board(1, { bench: 0 });
  solver.t.deal(foe, goli, hit(0.6), null);
  solver.t.refill(state.active, state.sides, state.next, state.board);
  ok("with nothing on the bench it stays", state.active[0].includes(goli));
  ok("and the flag is still spent rather than left set", goli.bailing === false);

  const dead = board(1);
  dead.solver.t.deal(dead.foe, dead.goli, hit(1.2), null);
  ok("a hit that knocks it out does not flag it", dead.goli.bailing === false,
    `${dead.goli.hp} / ${dead.goli.out}`);
}

// ---------------------------------------------------------------------------
// 7. it belongs to the base form
// ---------------------------------------------------------------------------
{
  // Mega Golisopod has Tough Claws. Every registered team that brings a Golisopod also brings
  // Golisopite, so the Ability lives on the turns before the stone is used -- and for a whole
  // game on a side that spends its one Mega Evolution somewhere else.
  const species = appData.species.find((e) => e.name === "Golisopod");
  const base = species?.forms?.find((f) => f.form === "Golisopod");
  const mega = species?.forms?.find((f) => /^Mega /.test(f.form || ""));
  ok("the base form has Emergency Exit", (base?.abilities || []).includes("Emergency Exit"),
    JSON.stringify(base?.abilities));
  ok("and the Mega does not", !(mega?.abilities || []).includes("Emergency Exit"),
    JSON.stringify(mega?.abilities));
  ok("the Mega has Tough Claws instead", (mega?.abilities || []).includes("Tough Claws"),
    JSON.stringify(mega?.abilities));

  const source = readFileSync(join(root, "builder", "tournament-test.js"), "utf8");
  ok("the kit compares the compact spelling",
    /emergencyExit: ability === "emergencyexit",/.test(source));
  ok("the hit reads the share BEFORE it lands",
    /const wasAboveHalf = this\.bailOn && target\.k\.emergencyExit && target\.hp > 0\.5;/.test(source));
  ok("and refill is where it actually moves",
    /if \(!out \|\| !out\.bailing\) continue;/.test(source));
  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  ok("the played game asks for the rule at both sites",
    (worker.match(/bailRule: 1/g) || []).length === 2);
}

// ---------------------------------------------------------------------------

if (notes.length) notes.forEach((n) => console.log(`  ${n}`));
if (failures.length) {
  failures.forEach((f) => console.log(`FAIL ${f}`));
  console.log(`${checked} checked, ${failures.length} failed.`);
  process.exit(1);
}
console.log(`${checked} checked, 0 failed.`);
