// A turn is either HAD or LOST, not discounted (TOURNAMENT_ACTION_ROLL).
//
// THE FINDING, measured 4 Nov 2026, and it is two faults at once.
//
// 1. `actionScale` prices an action as an EXPECTATION. With the rule off:
//      * a PARALYSED Pokemon did 0.75x damage every single turn, instead of acting in full and
//        losing one turn in four;
//      * a CONFUSED one did 0.667x every turn;
//      * a 30% chance to FLINCH cost 0.7x damage for the rest of the game -- `flinchP` is
//        accumulated as a probability (tournament-test.js:3312) and NOTHING ever rolled it.
//
// 2. `outScale`, the field that carries that number, HAS EXACTLY ONE READER: `deal`, on damage.
//    The action dispatch never consults it. So Protect, Trick Room, Tailwind, Follow Me and
//    every status move landed at FULL effect from a Pokemon that was frozen solid. No scale
//    factor can express that -- you cannot set three quarters of a Trick Room -- which is why
//    the rule SKIPS THE ACTION rather than scaling it.
//
// SLEEP is deliberately not rolled: it runs through `idle` and the loop `continue`s on that
// first, so rolling it again would charge one lost turn twice. BURN is not affected either --
// `applyStatus` rolls a status to a hard 1 in a played game, so its 0.5 halving of a physical
// move is a fact and not a share.
//
//   node tests/run-action-roll.mjs
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
import {
  TournamentTest, TOURNAMENT_ACTION_ROLL, tournamentActionRollOption,
} from "../builder/tournament-test.js";
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

function makeSolver(actionRollRule) {
  const ev = new TeamEvaluator(data, new DamageEngine(appData), FORMAT,
    normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Solver(new TournamentTest(evaluation, new KnownTeams(knownRaw),
    new TeamSuggestions(evaluation),
    { effects, liveHpRule: 1, abilityOpsRule: 1, confusionRule: 1, actionRollRule }));
}
function setFor(species) {
  for (const r of meta.pokemon) {
    if (String(r.species).toLowerCase() !== species.toLowerCase()) continue;
    const base = data.commonSet(FORMAT, r.species, r.form);
    if (base && base.moves?.length) return makeSet({ ...base, moves: [...base.moves] });
  }
  return null;
}
const A = setFor("Garchomp");
const B = setFor("Dragonite");
const row = (set, extra = {}) => ({ set, hp: 100, front: false, ...extra });
function board(rule) {
  const solver = makeSolver(rule);
  const state = solver.buildState({
    sides: [[row(A, { front: true }), row(B, { front: true })],
      [row(B, { front: true }), row(A, { front: true })]],
    field: {},
  });
  return { solver, state, me: state.active[0][0] };
}
const clean = () => ({ st: { slp: 0, frz: 0, par: 0, cnf: 0 }, flinchP: 0 });

/* ------------------------------------------------ 1. the rule and the reader */
{
  ok("TOURNAMENT_ACTION_ROLL is 0", TOURNAMENT_ACTION_ROLL === 0, String(TOURNAMENT_ACTION_ROLL));
  ok("an older recording replays with it off", tournamentActionRollOption(null) === 0);
  ok("and production asks for 1", tournamentActionRollOption(1) === 1);
}

/* ------------------------------------------------ 2. what the expectation was */
{
  const { solver } = board(0);
  const t = solver.t;
  const cases = [
    ["par", 1, 0.75, "paralysis"],
    ["cnf", 1, 2 / 3, "confusion"],
    ["slp", 1, 0, "sleep"],
    ["frz", 1, 0, "freeze"],
  ];
  for (const [key, value, want, label] of cases) {
    const pre = clean();
    pre.st[key] = value;
    ok(`${label} was priced as ${want.toFixed(3)}`, Math.abs(t.actionScale(pre) - want) < 1e-9,
      String(t.actionScale(pre)));
  }
  const flinching = clean();
  flinching.flinchP = 0.3;
  ok("a 30% flinch chance was priced as 0.7",
    Math.abs(t.actionScale(flinching) - 0.7) < 1e-9, String(t.actionScale(flinching)));
  notes.push("expectation: par 0.75, cnf 0.667, flinchP 0.3 -> 0.7");
}

/* ------------------------------------------------ 3. no roller, no change */
{
  const { solver } = board(1);
  ok("a bare engine has no roller", solver.t.effectRoll === undefined);
  const pre = clean();
  pre.st.par = 1;
  ok("so actionLost answers null and the caller keeps its expectation",
    solver.t.actionLost(pre) === null, String(solver.t.actionLost(pre)));
  ok("and actionScale is untouched", Math.abs(solver.t.actionScale(pre) - 0.75) < 1e-9);
}

/* ------------------------------------------------ 4. with a roller it is had or lost */
{
  const { solver } = board(1);
  const t = solver.t;
  // A roller we drive ourselves, so each draw is a known number rather than a sample.
  let queue = [];
  t.effectRoll = () => (queue.length ? queue.shift() : 0.999);

  const probe = (key, value, draw) => {
    const pre = clean();
    if (key === "flinchP") pre.flinchP = value; else pre.st[key] = value;
    queue = [draw, draw, draw, draw];
    return t.actionLost(pre);
  };
  // Paralysis: one turn in four. 0.10 is inside the quarter, 0.80 is outside it.
  ok("paralysis takes the turn on a low draw", probe("par", 1, 0.10) === "paralysis",
    String(probe("par", 1, 0.10)));
  ok("and leaves it on a high one", probe("par", 1, 0.80) === "", String(probe("par", 1, 0.80)));
  // Confusion: one turn in three.
  ok("confusion takes the turn on a low draw", probe("cnf", 1, 0.10) === "confusion");
  ok("and leaves it on a high one", probe("cnf", 1, 0.80) === "");
  // Freeze is total, so any draw below 1 loses the turn.
  ok("freeze always takes it", probe("frz", 1, 0.99) === "freeze");
  // Flinch, the one nothing ever rolled.
  ok("a 30% flinch lands on a low draw", probe("flinchP", 0.3, 0.10) === "flinch");
  ok("and not on a high one", probe("flinchP", 0.3, 0.80) === "");
  // A clean Pokemon never loses a turn, whatever the draw.
  queue = [0, 0, 0, 0];
  ok("a healthy Pokemon keeps its turn on the lowest draw there is", t.actionLost(clean()) === "");
  ok("and actionLost survives no state at all", t.actionLost(null) === null);
  // SLEEP IS NOT ROLLED HERE -- `idle` already took that turn.
  const sleeping = clean();
  sleeping.st.slp = 1;
  queue = [0, 0, 0, 0];
  ok("sleep is not rolled here, so it is not charged twice",
    t.actionLost(sleeping) === "", String(t.actionLost(sleeping)));
}

/* ------------------------------------------------ 5. the mean is preserved */
{
  // The point of a roll is to pick one outcome, not to change the average. Over many draws the
  // share of turns kept must come back to the factor it replaced.
  const { solver } = board(1);
  const t = solver.t;
  let seed = 12345;
  t.effectRoll = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const share = (key, value) => {
    let kept = 0;
    const runs = 40000;
    for (let i = 0; i < runs; i += 1) {
      const pre = clean();
      if (key === "flinchP") pre.flinchP = value; else pre.st[key] = value;
      if (t.actionLost(pre) === "") kept += 1;
    }
    return kept / runs;
  };
  for (const [key, value, want, label] of [["par", 1, 0.75, "paralysis"],
    ["cnf", 1, 2 / 3, "confusion"], ["flinchP", 0.3, 0.7, "a 30% flinch"]]) {
    const got = share(key, value);
    ok(`${label} keeps the turn ${(want * 100).toFixed(1)}% of the time`,
      Math.abs(got - want) < 0.015, `${(got * 100).toFixed(2)}% vs ${(want * 100).toFixed(1)}%`);
    notes.push(`${label}: kept ${(got * 100).toFixed(2)}% of 40,000 turns (expectation ${(want * 100).toFixed(1)}%)`);
  }
}

/* ------------------------------------------------ 6. the hole outScale could not reach */
{
  // `outScale` multiplies DAMAGE. It is read in exactly one place, so it could never have cost
  // a status move anything -- which is the whole reason the rule skips the action instead.
  const src = readFileSync(join(root, "builder", "tournament-test.js"), "utf8");
  const code = src.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
  const readers = code.filter((l) => /outScale/.test(l) && !/outScale\s*[:=]/.test(l));
  ok("outScale still has exactly one reader", readers.length === 1,
    JSON.stringify(readers.map((l) => l.trim())));
  ok("and that reader is the damage line in deal", /damage \*=/.test(readers[0] || ""),
    String(readers[0] || "").trim());
  // ...so the rule has to leave the action loop, not scale it.
  const callers = code.filter((l) => /this\.actionLost\(pre\)/.test(l));
  ok("both action loops ask actionLost", callers.length === 2, String(callers.length));
  ok("and only one of them defines it",
    code.filter((l) => /^\s*actionLost\(pre\) \{/.test(l)).length === 1);
  ok("the planned turn reports it, so the turn is not silently empty",
    /kind: "lostturn"/.test(src), "no lostturn event");
}

/* ------------------------------------------------ 7. the player is told */
{
  const play = readFileSync(join(root, "builder", "play-game.js"), "utf8");
  ok("the lost turn has words for every reason it can have",
    ["flinch", "paralysis", "freeze", "confusion"]
      .every((why) => new RegExp(`${why}:\\s*"`).test(play)), "a reason has no sentence");
  ok("it reaches the turn log", /case "lostturn":/.test(play));
  // The handler reads the engine's event and pushes a flinch step carrying its own sentence.
  const at = play.indexOf('event.kind === "lostturn"');
  const handler = at >= 0 ? play.slice(at, at + 600) : "";
  ok("the engine's event is handled at all", at >= 0, String(at));
  ok("and it gets a step, so something happens on screen",
    /kind: "flinch"/.test(handler), handler.replace(/\s+/g, " ").slice(0, 160));
  ok("the step carries the reason as its own text",
    /text:/.test(handler) && /LOST_TURN_SAID/.test(handler));
  // It used no move, so it must NOT be in ACTING -- that set is what emits a "used X" line.
  const acting = play.slice(play.indexOf("const ACTING"), play.indexOf("]);", play.indexOf("const ACTING")));
  ok("a Pokemon that lost its turn is not reported as having acted",
    !/lostturn/.test(acting), acting.replace(/\s+/g, " ").slice(0, 120));
  const anim = readFileSync(join(root, "builder", "play-anim.js"), "utf8");
  ok("and the flinch step it reuses really exists in the animation",
    /case "flinch":/.test(anim) && /step\.text/.test(anim));
}

/* ------------------------------------------------ 8. the wiring */
{
  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  const built = worker.match(/new TournamentTest\([\s\S]*?\);/g) || [];
  ok("both live engines ask for the rule",
    built.filter((c) => /actionRollRule:\s*1/.test(c)).length === 2,
    String(built.filter((c) => /actionRollRule:\s*1/.test(c)).length));
  ok("and the recorded Tournament Test does not", built.some((c) => !/actionRollRule/.test(c)));
}

/* ------------------------------------------------ 9. end to end: it costs a STATUS move */
{
  // THE DECISIVE ONE. A paralysed Pokemon whose turn is taken must not set Trick Room -- and
  // with the rule off it did, every time, because `outScale` never reached the action dispatch.
  const mimikyu = setFor("Mimikyu");          // the meta set carries Trick Room
  const result = {};
  for (const rule of [0, 1]) {
    const solver = makeSolver(rule);
    const state = solver.buildState({
      sides: [[row(mimikyu, { front: true }), row(B, { front: true })],
        [row(B, { front: true }), row(A, { front: true })]],
      field: {},
    });
    const me = state.active[0][0];
    // Paralysed, and a roller that always takes the turn.
    me.st = { slp: 0, frz: 0, par: 1, cnf: 0 };
    me.flinchP = 0;
    solver.t.effectRoll = () => 0;
    const pick = solver.slotCandidates(state, 0, 0, { cap: 0 }).find((a) => a.move === "Trick Room");
    if (!pick) { result[rule] = "no Trick Room on the sheet"; continue; }
    const events = [];
    solver.t.plannedTurn(state.active, state.board, state.slower, 1, events,
      null, [solver.planFor(state, [pick], 0), solver.planFor(state, [], 1)]);
    result[rule] = { tr: state.board.tr, outScale: me.outScale,
      lost: events.filter((e) => e.kind === "lostturn").map((e) => e.why) };
  }
  ok("the test really found Trick Room", typeof result[0] === "object", String(result[0]));
  if (typeof result[0] === "object") {
    ok("WITH THE RULE OFF a paralysed Pokemon still set Trick Room", result[0].tr > 0,
      JSON.stringify(result[0]));
    ok("with it ON the lost turn sets nothing", result[1].tr === 0, JSON.stringify(result[1]));
    ok("and the turn is reported as lost to paralysis",
      result[1].lost.join(",") === "paralysis", JSON.stringify(result[1].lost));
    notes.push(`Trick Room while paralysed: rule 0 -> board.tr ${result[0].tr}, rule 1 -> ${result[1].tr} (${result[1].lost.join(",") || "acted"})`);
  }
}

/* ------------------------------------------------ 10. ...and it still acts when it keeps the turn */
{
  const mimikyu = setFor("Mimikyu");
  const solver = makeSolver(1);
  const state = solver.buildState({
    sides: [[row(mimikyu, { front: true }), row(B, { front: true })],
      [row(B, { front: true }), row(A, { front: true })]],
    field: {},
  });
  const me = state.active[0][0];
  me.st = { slp: 0, frz: 0, par: 1, cnf: 0 };
  me.flinchP = 0;
  solver.t.effectRoll = () => 0.99;           // a draw that keeps the turn
  const pick = solver.slotCandidates(state, 0, 0, { cap: 0 }).find((a) => a.move === "Trick Room");
  if (pick) {
    const events = [];
    solver.t.plannedTurn(state.active, state.board, state.slower, 1, events,
      null, [solver.planFor(state, [pick], 0), solver.planFor(state, [], 1)]);
    ok("a kept turn still sets Trick Room", state.board.tr > 0, String(state.board.tr));
    ok("and it acts at FULL strength, not 0.75", me.outScale === 1, String(me.outScale));
    ok("with nothing reported as lost",
      events.every((e) => e.kind !== "lostturn"));
    notes.push(`kept turn while paralysed: board.tr ${state.board.tr}, outScale ${me.outScale}`);
  }
}

for (const note of notes) console.log(`   ${note}`);
console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
