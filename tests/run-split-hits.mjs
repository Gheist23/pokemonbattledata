// Dragon Darts: one dart each, not two into one (split_hits_across_targets).
//
// The move's own text is "The user attacks twice in a row. If there are 2 opposing Pokemon each
// of them is attacked once." The website had the first sentence and not the second: app-data.json
// carries moves["Dragon Darts"].hits = 2 and the damage engine multiplies by it, so a lone foe
// always took the right amount -- but in Doubles both darts went into whichever foe was aimed at,
// and the other one was never touched. The clause compiled to nothing because
// `split_hits_across_targets` was not on the exporter's WEB_MOVE_OPS list.
//
// What is checked here:
//
//   1. the data: the op ships, and the hit count still comes from app-data.json (not twice);
//   2. the gate: on in Doubles with the registry, off in Singles, off with the registry off;
//   3. `dart()` halves every roll field, because a played game reads rollLo/rollHigh and not frac;
//   4. two foes standing take a dart each, and each takes about half of what a lone foe takes;
//   5. a lone foe still takes both darts -- the number the Damage Calculator shows is unchanged;
//   6. it is not a spread move: Wide Guard does not block it and no 0.75 multiplier is applied,
//      and hitting two foes pays each one's contact answer -- the one number besides the damage
//      that the split moves;
//   7. the Solver offers it as ONE action with no target to choose when two foes stand.
//
//   node tests/run-split-hits.mjs
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
  return new Solver(tournament);
}

const set = (species, item, ability, nature, moves, bonuses, form) => ({
  species, form: form || species, item, ability, nature, moves, bonuses: [...bonuses],
});
const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });
const board = (ourRows, theirRows, field = {}) => ({ sides: [ourRows, theirRows], field });

const PULT = set("Dragapult", "Choice Band", "Clear Body", "Jolly",
  ["Dragon Darts", "Phantom Force", "U-turn", "Protect"], [2, 32, 0, 0, 0, 32]);
// Two identical targets, so "a dart each" can be compared with "both into one".
const TARGET = set("Amoonguss", "Sitrus Berry", "Regenerator", "Calm",
  ["Spore", "Pollen Puff", "Rage Powder", "Protect"], [32, 0, 2, 0, 32, 0]);
const GUARD = set("Corviknight", "Leftovers", "Pressure", "Impish",
  ["Wide Guard", "Brave Bird", "Roost", "Protect"], [32, 2, 32, 0, 0, 0]);
const QUAKER = set("Garchomp", "Life Orb", "Rough Skin", "Jolly",
  ["Rock Slide", "Dragon Claw", "Earthquake", "Protect"], [2, 32, 0, 0, 0, 32]);
// Sections 4 and 5 compare MAGNITUDES, so neither reading may touch the 100% ceiling: a
// Choice Band Dragapult knocks Amoonguss out with either half, and "100 vs 100" says nothing
// about whether the darts were shared. An unboosted user into a Steel type that resists Dragon
// and takes physical hits well leaves both readings well short of the cap.
// Black Glasses, not Leftovers: section 6b measures what the ATTACKER pays for the contact, and
// a Leftovers heal of 1/16 exactly cancels one foe's Iron Barbs charge of 1/16 -- which made the
// one-foe reading 0% and the two-foe reading 12.5%, for a reason that has nothing to do with the
// split. The item is Dark-typed and Dragon Darts is not, so no damage number moves.
const PLAIN = set("Dragapult", "Black Glasses", "Clear Body", "Jolly",
  ["Dragon Darts", "Phantom Force", "U-turn", "Protect"], [2, 32, 0, 0, 0, 32]);
// Black Glasses and not Leftovers: an item that heals at the end of the turn is subtracted from
// BOTH readings, so a half dart behind one looked like a sixth rather than a half (7.77% dealt
// less 6.25% healed is 1.52%). Nothing this target holds may touch its HP.
const TOUGH = set("Corviknight", "Black Glasses", "Pressure", "Impish",
  ["Brave Bird", "Roost", "Iron Head", "Protect"], [32, 2, 32, 0, 0, 0]);

/**
 * Plays the turn out on the EXPECTED damage instead of a random roll.
 *
 * A Solver replaces the turn engine's `rollHit` with `rollDamage` (builder/solver.js), which
 * misses on the accuracy roll and then samples one of the 16 damage rolls -- so the same board
 * played twice gives two different numbers, and comparing one foe's loss with another's measures
 * the dice. Sections 4 to 6 compare magnitudes, so they put the expectation back.
 */
const steady = (solver) => { solver.t.rollHit = (hit) => hit.frac; return solver; };

/** A row's damage so far, as a percentage: a row's `hp` is a share of its maximum, not a percent. */
const lost = (row) => (1 - row.hp) * 100;

/** One turn, each side's action chosen by name rather than by the planner. */
function playTurn(solver, state, ourMove, theirMove = null, turn = 1) {
  const events = [];
  const pickFor = (s, name) => {
    if (!name) return [];
    const list = solver.slotCandidates(state, s, 0, { cap: 0 });
    const found = list.find((a) => a.move === name);
    return found ? [found] : [];
  };
  const plans = [
    solver.planFor(state, pickFor(0, ourMove), 0),
    solver.planFor(state, pickFor(1, theirMove), 1),
  ];
  solver.t.plannedTurn(state.active, state.board, state.slower, turn, events, null, plans);
  return events;
}

// ---------------------------------------------------------------------------
// 1. the data
// ---------------------------------------------------------------------------
{
  ok("the exporter ships split_hits_across_targets", (effects.moveOps || []).includes("split_hits_across_targets"));
  const darts = (effects.moves || {}).dragondarts || [];
  ok("Dragon Darts carries it", darts.some((fx) => fx.op === "split_hits_across_targets"), JSON.stringify(darts));
  // The hit count reaches the browser through app-data.json, so shipping it again in the effects
  // file would put a second, unread copy of the same number in a second place.
  ok("and the hit count is NOT shipped twice", !darts.some((fx) => fx.op === "fixed_multi_hit"), JSON.stringify(darts));
  const rec = (appData.moves || {})["Dragon Darts"] || {};
  ok("app-data.json still carries hits: 2", rec.hits === 2, String(rec.hits));
  ok("and Dragon Darts is not a spread move", rec.spread === false, String(rec.spread));
  notes.push(`${Object.keys(effects.moves || {}).length} moves carry a modelled effect`);
}

// ---------------------------------------------------------------------------
// 2. the gate
// ---------------------------------------------------------------------------
{
  const doubles = makeSolver();
  const info = doubles.t.moveInfo("Dragon Darts");
  ok("the move's cached info carries splitHits", info.splitHits === true);
  ok("and splitsHits says yes in Doubles", doubles.t.splitsHits(info) === true);
  // "If there are 2 opposing Pokemon" -- in Singles there is one, attacked twice, which is what
  // the move already did.
  const singles = makeSolver({ format: "Singles" });
  ok("no in Singles", singles.t.splitsHits(singles.t.moveInfo("Dragon Darts")) === false);
  const bare = makeSolver({ withEffects: false });
  ok("and no with the registry off", bare.t.splitsHits(bare.t.moveInfo("Dragon Darts")) === false);
  ok("a move without the op is never split", doubles.t.splitsHits(doubles.t.moveInfo("Brave Bird")) === false);
  ok("and neither is nothing at all", doubles.t.splitsHits(null) === false);
}

// ---------------------------------------------------------------------------
// 3. dart() halves every roll field
// ---------------------------------------------------------------------------
{
  const t = makeSolver().t;
  const whole = { slot: 0, frac: 0.6, lo: 0.5, hi: 0.7, odds: 0.9, rollLo: 0.52, rollHigh: 0.68, priority: 0, spread: false, self: 0.1 };
  const half = t.dart(whole);
  for (const field of ["frac", "lo", "hi", "rollLo", "rollHigh"]) {
    ok(`dart() halves ${field}`, Math.abs(half[field] - whole[field] / 2) < 1e-12, `${half[field]} vs ${whole[field] / 2}`);
  }
  // Per move USE, not per dart: the accuracy roll is one roll and the recoil is owed once.
  for (const field of ["odds", "priority", "self", "spread", "slot"]) {
    ok(`and leaves ${field} alone`, half[field] === whole[field], `${half[field]} vs ${whole[field]}`);
  }
  ok("a hit that does nothing is returned untouched", t.dart({ frac: 0 }).frac === 0);
  ok("and so is nothing at all", t.dart(null) === null);

  // The same thing on a hit the engine really priced, rather than one written out here.
  const live = steady(makeSolver());
  const state = live.buildState(board(
    [row(PLAIN, { front: true }), row(GUARD, { front: true })],
    [row(TOUGH, { front: true }), row(TOUGH, { front: true })],
  ));
  const pult = state.active[0][0];
  const real = live.t.hitOn(pult, state.active[1][0], 0, state.board);
  const one = live.t.dart(real);
  ok("a priced Dragon Darts hit is worth something", real.frac > 0, String(real.frac));
  ok("and one dart of it is exactly half", Math.abs(one.frac - real.frac / 2) < 1e-12,
    `${one.frac} vs ${real.frac / 2}`);
}

// ---------------------------------------------------------------------------
// 4 & 5. a dart each, and a lone foe still takes both
// ---------------------------------------------------------------------------
{
  const solver = steady(makeSolver());
  const alone = solver.buildState(board(
    [row(PLAIN, { front: true }), row(GUARD, { front: true })],
    [row(TOUGH, { front: true })],
  ));
  playTurn(solver, alone, "Dragon Darts");
  const lone = lost(alone.active[1][0]);
  ok("a lone foe takes both darts", lone > 0, String(lone));
  ok("and is not knocked out by them, so the shares can be compared", lone < 99, String(lone));

  const pair = steady(makeSolver());
  const both = pair.buildState(board(
    [row(PLAIN, { front: true }), row(GUARD, { front: true })],
    [row(TOUGH, { front: true }), row(TOUGH, { front: true })],
  ));
  playTurn(pair, both, "Dragon Darts");
  const first = lost(both.active[1][0]);
  const second = lost(both.active[1][1]);
  ok("with two standing the first foe is hit", first > 0, String(first));
  ok("and so is the second, which used to be untouched", second > 0, String(second));
  ok("both take the same dart", Math.abs(first - second) < 1e-6, `${first} vs ${second}`);
  // Half each, not half the pair: the two darts still add up to the whole move.
  ok("each takes exactly half of what a lone foe takes",
    Math.abs(first - lone / 2) < 1e-9, `${first.toFixed(4)} vs ${(lone / 2).toFixed(4)}`);
  ok("and the two together come to what a lone foe took",
    Math.abs(first + second - lone) < 1e-9, `${(first + second).toFixed(4)} vs ${lone.toFixed(4)}`);
  notes.push(`a lone foe loses ${lone.toFixed(1)}%, two foes lose ${first.toFixed(1)}% each`);
}

// ---------------------------------------------------------------------------
// 6. it is not a spread move
// ---------------------------------------------------------------------------
{
  const solver = steady(makeSolver());
  const state = solver.buildState(board(
    [row(PULT, { front: true }), row(TARGET, { front: true })],
    [row(GUARD, { front: true }), row(TARGET, { front: true })],
  ));
  const events = playTurn(solver, state, "Dragon Darts", "Wide Guard");
  const blocked = events.filter((e) => e.kind === "blocked" && e.by === "Wide Guard");
  ok("Wide Guard does not block it", blocked.length === 0, JSON.stringify(blocked));
  ok("and both foes still take a dart behind it",
    state.active[1][0].hp < 1 && state.active[1][1].hp < 1,
    `${state.active[1][0].hp} / ${state.active[1][1].hp}`);
  // A real spread move in the same seat, as the control: that one IS blocked.
  const control = steady(makeSolver());
  const cs = control.buildState(board(
    [row(QUAKER, { front: true }), row(TARGET, { front: true })],
    [row(GUARD, { front: true }), row(TARGET, { front: true })],
  ));
  const ce = playTurn(control, cs, "Rock Slide", "Wide Guard");
  ok("while a spread move in the same seat is",
    ce.some((e) => e.kind === "blocked" && e.by === "Wide Guard"),
    JSON.stringify(ce.filter((e) => e.kind === "blocked")));
}

// ---------------------------------------------------------------------------
// 6b. what hitting two foes costs the attacker
// ---------------------------------------------------------------------------
{
  // Dragon Darts makes contact, and `deal` charges the target's contact answer -- a flat 1/8 for
  // Iron Barbs and Rough Skin -- once per landed hit. Hitting two foes therefore pays it twice,
  // once per foe, which is right for two targets and is a change from hitting one; it is the one
  // number in the split that moves for a reason other than the damage, so it is pinned here
  // rather than left to be discovered.
  //
  // (What a LONE foe pays is unchanged by the split and is modelled low: the two darts reach it
  // as one priced hit, so one contact is charged where the games charge two. That is the
  // pre-existing shape of `answerContact`, which does not read the hit count.)
  const solver = steady(makeSolver());
  // Bulky enough to SURVIVE both darts: `deal` returns at the knockout, before it charges the
  // contact answer, so a foe that faints answers nothing and the two readings would be 0% and
  // 12.5% for that reason rather than for the one being measured.
  const SPIKY = set("Ferrothorn", "Black Glasses", "Iron Barbs", "Relaxed",
    ["Gyro Ball", "Power Whip", "Leech Seed", "Protect"], [32, 0, 32, 0, 2, 0]);
  const two = solver.buildState(board(
    [row(PLAIN, { front: true }), row(GUARD, { front: true })],
    [row(SPIKY, { front: true }), row(SPIKY, { front: true })],
  ));
  playTurn(solver, two, "Dragon Darts");
  solver.t.endOfTurn(two.active, [], two.board);
  const paidTwice = lost(two.active[0][0]);

  const one = steady(makeSolver());
  const lone = one.buildState(board(
    [row(PLAIN, { front: true }), row(GUARD, { front: true })],
    [row(SPIKY, { front: true })],
  ));
  playTurn(one, lone, "Dragon Darts");
  one.t.endOfTurn(lone.active, [], lone.board);
  const paidOnce = lost(lone.active[0][0]);

  ok("hitting one foe costs the attacker something", paidOnce > 0, String(paidOnce));
  ok("and hitting two Iron Barbs foes costs it twice that, once per foe",
    Math.abs(paidTwice - paidOnce * 2) < 1e-9, `${paidTwice.toFixed(4)} vs ${(paidOnce * 2).toFixed(4)}`);
  notes.push(`Iron Barbs costs the attacker ${paidOnce.toFixed(1)}% for one foe, ${paidTwice.toFixed(1)}% for two`);
}

// ---------------------------------------------------------------------------
// 6c. a dart nobody can take is not thrown away
// ---------------------------------------------------------------------------
{
  // The split is decided on the foes that can actually TAKE a dart, not on the ones standing.
  // Deciding it on `alive` alone meant an immune foe, a Protecting foe or one away mid-Fly
  // silently ATE one dart: the move did half its damage and the other half landed on nothing,
  // which is strictly worse than before the split existed.
  const base = steady(makeSolver());
  const both = base.buildState(board(
    [row(PLAIN, { front: true }), row(GUARD, { front: true })],
    [row(TOUGH, { front: true }), row(TOUGH, { front: true })],
  ));
  playTurn(base, both, "Dragon Darts");
  const oneDart = lost(both.active[1][0]);

  // (a) immunity: Dragon does nothing to a Fairy type, so the other foe takes BOTH darts.
  const FAIRY = set("Hatterene", "Black Glasses", "Magic Bounce", "Quiet",
    ["Dazzling Gleam", "Psychic", "Trick Room", "Protect"], [32, 0, 2, 32, 0, 0]);
  const imm = steady(makeSolver());
  const si = imm.buildState(board(
    [row(PLAIN, { front: true }), row(GUARD, { front: true })],
    [row(TOUGH, { front: true }), row(FAIRY, { front: true })],
  ));
  playTurn(imm, si, "Dragon Darts");
  ok("a Fairy type takes nothing from a Dragon move", lost(si.active[1][1]) === 0, String(lost(si.active[1][1])));
  ok("and the foe that CAN be hit takes both darts, not one",
    Math.abs(lost(si.active[1][0]) - oneDart * 2) < 1e-9,
    `${lost(si.active[1][0]).toFixed(4)} vs ${(oneDart * 2).toFixed(4)}`);

  // (b) Protect: the same, for a foe that is there but cannot be reached this turn.
  const pro = steady(makeSolver());
  const sp = pro.buildState(board(
    [row(PLAIN, { front: true }), row(GUARD, { front: true })],
    [row(TOUGH, { front: true }), row(TOUGH, { front: true })],
  ));
  sp.active[1][1].guard = true;
  playTurn(pro, sp, "Dragon Darts");
  ok("a Protecting foe takes nothing", lost(sp.active[1][1]) === 0, String(lost(sp.active[1][1])));
  ok("and the open foe takes both darts",
    Math.abs(lost(sp.active[1][0]) - oneDart * 2) < 1e-9,
    `${lost(sp.active[1][0]).toFixed(4)} vs ${(oneDart * 2).toFixed(4)}`);

  // (c) away mid-Fly: not on the field to be hit.
  const fly = steady(makeSolver());
  const sf = fly.buildState(board(
    [row(PLAIN, { front: true }), row(GUARD, { front: true })],
    [row(TOUGH, { front: true }), row(TOUGH, { front: true })],
  ));
  sf.active[1][1].hidden = true;
  playTurn(fly, sf, "Dragon Darts");
  ok("a foe part-way through Fly takes nothing", lost(sf.active[1][1]) === 0);
  ok("and the one on the field takes both darts",
    Math.abs(lost(sf.active[1][0]) - oneDart * 2) < 1e-9,
    `${lost(sf.active[1][0]).toFixed(4)} vs ${(oneDart * 2).toFixed(4)}`);
  notes.push(`one dart ${oneDart.toFixed(1)}%, both into one foe ${(oneDart * 2).toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
// 6d. a redirected Dragon Darts follows the redirect, whole
// ---------------------------------------------------------------------------
{
  // Redirection is resolved ABOVE the split. Splitting first asked the redirector nothing at
  // all, so Follow Me and Rage Powder could not pull the move at the partner's expense.
  const solver = steady(makeSolver());
  const PULLER = set("Amoonguss", "Black Glasses", "Regenerator", "Calm",
    ["Rage Powder", "Spore", "Pollen Puff", "Protect"], [32, 0, 2, 0, 32, 0]);
  const state = solver.buildState(board(
    [row(PLAIN, { front: true }), row(GUARD, { front: true })],
    [row(PULLER, { front: true }), row(TOUGH, { front: true })],
  ));
  const events = playTurn(solver, state, "Dragon Darts", "Rage Powder");
  const pulled = lost(state.active[1][0]);
  const partner = lost(state.active[1][1]);
  ok("the redirector takes the move", pulled > 0, String(pulled));
  ok("and its partner is not touched at all", partner === 0, String(partner));
  ok("and the redirect really happened", events.some((e) => e.kind === "redirect" || e.move === "Rage Powder")
    || pulled > 0, JSON.stringify(events.map((e) => e.kind)));
}

// ---------------------------------------------------------------------------
// 7. one action, no target to choose
// ---------------------------------------------------------------------------
{
  const solver = makeSolver();
  const two = solver.buildState(board(
    [row(PULT, { front: true }), row(GUARD, { front: true })],
    [row(TARGET, { front: true }), row(TARGET, { front: true })],
  ));
  const offered = solver.slotCandidates(two, 0, 0, { cap: 0 }).filter((a) => a.move === "Dragon Darts");
  ok("with two foes standing it is offered once", offered.length === 1, `${offered.length} option(s)`);
  ok("with no target to choose", offered[0]?.target === -1, String(offered[0]?.target));
  ok("and it is not flagged as a spread move", !offered[0]?.spread);
  ok("worth more than nothing", (offered[0]?.value || 0) > 0, String(offered[0]?.value));

  const one = solver.buildState(board(
    [row(PULT, { front: true }), row(GUARD, { front: true })],
    [row(TARGET, { front: true })],
  ));
  const single = solver.slotCandidates(one, 0, 0, { cap: 0 }).filter((a) => a.move === "Dragon Darts");
  ok("with one foe standing it is aimed at that foe", single.length === 1 && single[0].target >= 0,
    `${single.length} option(s), target ${single[0]?.target}`);
}

for (const note of notes) console.log(`   ${note}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(`\n${checked} checked, ${failures.length} failed.`);
process.exit(failures.length ? 1 : 0);
