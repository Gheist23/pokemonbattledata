// Charge: "The user gains the Electric Boost status" (electric_boost).
//
// The website's damage engine has applied the doubling the whole time -- builder/engine.js reads
// `attacker_state.charged` and doubles an Electric move's power -- but nothing in any turn engine
// could SET it. `electric_boost` was not on the exporter's WEB_MOVE_OPS list, so the op never
// reached the browser, and the flag had no producer: Charge was a +1 Sp. Def status move and
// nothing more. 34 learnset entries have it.
//
// What is checked here:
//
//   1. the data: both of Charge's ops ship, and the op is runnable in the played game -- which
//      matters, because `play-game.js:549` needs EVERY op of a move to be runnable or the move
//      is not offered at all, so shipping the op without that would have been a REGRESSION;
//   2. Charge sets the boost and still gives its +1 Sp. Def;
//   3. a charged Electric move hits twice as hard, and a non-Electric one is untouched;
//   4. what spends it: any Electric move whatever its category (the Companion clears on type
//      alone, so Thunder Wave spends it too), and nothing else does;
//   5. two Charges running keep the boost -- the clear happens before the ops are applied;
//   6. leaving the field loses it, because it is a volatile;
//   7. the state survives a described board and joins the search tree's node key;
//   8. the cache: a charged hit does not poison the uncharged number, and the other way round;
//   9. the rest of that path. Charge could not be the only casualty, and it was not: `planFor`
//      dropped EVERY self-aimed EFFECT action, because such an action carries `target: null` and
//      `null >= 0` is true, so it read as "aimed at the foe in seat 0" and was then dropped for
//      having no live target there. Moonlight, Morning Sun and Synthesis were offered in the
//      played game and did nothing -- and `weather_heal` would have thrown a ReferenceError if it
//      had ever been reached, because `runEffectOps` read a `board` it had no parameter for.
//
//   node tests/run-electric-boost.mjs
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
import { ACTION_KINDS, TournamentTest } from "../builder/tournament-test.js";
import { Solver, SWITCH } from "../builder/solver.js";
import { PlayGame } from "../builder/play-game.js";

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

function makeSolver({ format = "Doubles" } = {}) {
  const engine = new DamageEngine(appData);
  const meta = JSON.parse(readFileSync(join(root, "data", "builder", `meta-${format.toLowerCase()}.json`), "utf8"));
  const ev = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const tournament = new TournamentTest(evaluationOf(ev), new KnownTeams(knownRaw), new TeamSuggestions(evaluationOf(ev)),
    { effects, liveHpRule: 1, chargeRule: 1 });
  const solver = new Solver(tournament);
  // The expectation rather than a random roll, so a magnitude can be compared with another.
  solver.t.rollHit = (hit) => hit.frac;
  return solver;
}
const payloads = new WeakMap();
function evaluationOf(ev) {
  let found = payloads.get(ev);
  if (!found) { found = new TeamEvaluation(ev); payloads.set(ev, found); }
  return found;
}

const set = (species, item, ability, nature, moves, bonuses, form) => ({
  species, form: form || species, item, ability, nature, moves, bonuses: [...bonuses],
});
const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });
const board = (ourRows, theirRows, field = {}) => ({ sides: [ourRows, theirRows], field });

// Charge, a single-target Electric attack, a non-Electric attack, and an Electric STATUS move --
// the four things every check below needs, on one Pokemon that really learns all of them.
const AMPH = set("Ampharos", "Black Glasses", "Static", "Modest",
  ["Charge", "Thunderbolt", "Dragon Pulse", "Thunder Wave"], [2, 0, 0, 32, 0, 32]);
// Neutral to Electric and bulky, with an item that does nothing to its HP: the doubling has to
// be measurable, and against a Steel/FLYING target Thunderbolt already took 95% -- where a
// doubled hit and an undoubled one are both "all of it" and the check proves nothing.
const TARGET = set("Amoonguss", "Black Glasses", "Regenerator", "Calm",
  ["Spore", "Pollen Puff", "Rage Powder", "Protect"], [32, 0, 2, 0, 32, 0]);
const PARTNER = set("Garchomp", "Black Glasses", "Rough Skin", "Jolly",
  ["Dragon Claw", "Earthquake", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]);

/**
 * The action for a move the SEARCH has no kind for, built the way the played game builds it.
 *
 * This is the whole reachability of Charge, and it is worth stating plainly: `slotCandidates`
 * has branches for attacks, Protect, the Guards, Helping Hand, Tailwind, Trick Room, the
 * redirects, the sleep move, Taunt, Encore, Will-O-Wisp and the stat drops, and NO generic
 * fallback -- so Charge is offered in exactly one place, `PlayGame.options`
 * (builder/play-game.js:552), as an EFFECT action. Team Evaluation, Auto Build, Suggestions and
 * Optimize therefore never use Charge and the mechanic stays inert for them; the played game and
 * a board described to the Solver are where it is real. Giving the search a kind and a valuation
 * for it would move published numbers and is separate work.
 */
function effectAction(state, side, name) {
  const m = state.active[side][0];
  const slot = (m.u.moves || []).findIndex((info) => info && info.name === name);
  if (slot < 0) return null;
  const info = m.u.moves[slot];
  const ops = info.fx || [];
  // `position` is where the Pokemon STANDS. `planFor` reads `state.active[s][action.position]`,
  // so an action without it is dropped before it is planned -- silently, as an empty plan.
  return { kind: ACTION_KINDS.EFFECT, position: 0, slot, ops, move: info.name, target: null, pr: info.priority || 0 };
}

/** One turn, each side's action chosen by name rather than by the planner. */
function playTurn(solver, state, ourMove, theirMove = null, turn = 1) {
  const events = [];
  const pickFor = (s, name) => {
    if (!name) return [];
    const list = solver.slotCandidates(state, s, 0, { cap: 0 });
    const found = list.find((a) => a.move === name);
    if (found) return [found];
    // Not a kind the search has: the played game's own EFFECT action, or nothing.
    const effect = effectAction(state, s, name);
    return effect ? [effect] : [];
  };
  const plans = [
    solver.planFor(state, pickFor(0, ourMove), 0),
    solver.planFor(state, pickFor(1, theirMove), 1),
  ];
  solver.t.plannedTurn(state.active, state.board, state.slower, turn, events, null, plans);
  return events;
}

const twoVsTwo = (solver, extra = {}) => solver.buildState(board(
  [row(AMPH, { front: true, ...extra }), row(PARTNER, { front: true })],
  [row(TARGET, { front: true }), row(TARGET, { front: true })],
));

// ---------------------------------------------------------------------------
// 1. the data, and the op being runnable
// ---------------------------------------------------------------------------
{
  ok("the exporter ships electric_boost", (effects.moveOps || []).includes("electric_boost"));
  const charge = (effects.moves || {}).charge || [];
  ok("Charge carries it", charge.some((fx) => fx.op === "electric_boost"), JSON.stringify(charge));
  ok("and still carries its own +1 Sp. Def",
    charge.some((fx) => fx.op === "stage" && (fx.stats || []).includes("sp_defense") && fx.amount === 1),
    JSON.stringify(charge));
  // The regression this would have been: play-game.js:549 needs EVERY op of a move runnable,
  // and Charge's ops are now two. Checked against the real set rather than by playing a game,
  // because that gate is what the set IS.
  const runnable = charge.every((fx) => ["status", "stage", "heal", "weather_heal", "flinch", "electric_boost"]
    .includes(String(fx.op || "")));
  ok("every one of Charge's ops is runnable, so the played game still offers it", runnable,
    JSON.stringify(charge.map((fx) => fx.op)));
  // And the move really is one the search has no kind for, which is why the gate above matters.
  const solver = makeSolver();
  const state = twoVsTwo(solver);
  const offered = solver.slotCandidates(state, 0, 0, { cap: 0 }).map((a) => a.move);
  ok("and it is not one of the search's own kinds", !offered.includes("Charge"), offered.join(", "));
}

// ---------------------------------------------------------------------------
// 2 & 3. it is set, it doubles an Electric move, and nothing else
// ---------------------------------------------------------------------------
{
  const solver = makeSolver();
  const state = twoVsTwo(solver);
  const amph = state.active[0][0];
  const foe = state.active[1][0];
  const beforeBolt = solver.t.hitOn(amph, foe, 1, state.board).frac;
  const beforePulse = solver.t.hitOn(amph, foe, 2, state.board).frac;
  ok("Thunderbolt does something to begin with", beforeBolt > 0, String(beforeBolt));
  ok("Ampharos is not charged to begin with", amph.charged === false, String(amph.charged));

  const events = playTurn(solver, state, "Charge");
  ok("Charge sets the boost", amph.charged === true, String(amph.charged));
  ok("and still raises its Sp. Def", amph.spd === 1, String(amph.spd));
  ok("and the turn says it did something", events.some((e) => e.kind !== "fails"), JSON.stringify(events.slice(0, 3)));

  const afterBolt = solver.t.hitOn(amph, foe, 1, state.board).frac;
  const afterPulse = solver.t.hitOn(amph, foe, 2, state.board).frac;
  ok("a charged Electric move hits about twice as hard",
    Math.abs(afterBolt / beforeBolt - 2) < 0.05, `${afterBolt} vs ${beforeBolt}`);
  ok("and a move of another type is untouched",
    Math.abs(afterPulse - beforePulse) < 1e-12, `${afterPulse} vs ${beforePulse}`);
  notes.push(`Thunderbolt ${(beforeBolt * 100).toFixed(1)}% -> ${(afterBolt * 100).toFixed(1)}% charged`);
}

// ---------------------------------------------------------------------------
// 4. what spends it
// ---------------------------------------------------------------------------
{
  // An Electric ATTACK spends it.
  const a = makeSolver();
  const sa = twoVsTwo(a, { charged: true });
  ok("a described board can start charged", sa.active[0][0].charged === true);
  playTurn(a, sa, "Thunderbolt");
  ok("an Electric attack spends the boost", sa.active[0][0].charged === false);

  // An Electric STATUS move spends it too: the Companion clears on the move's TYPE alone,
  // regardless of category, so Thunder Wave and Volt Switch spend it as well.
  const b = makeSolver();
  const sb = twoVsTwo(b, { charged: true });
  playTurn(b, sb, "Thunder Wave");
  ok("and so does an Electric status move", sb.active[0][0].charged === false);

  // A move of another type does not.
  const c = makeSolver();
  const sc = twoVsTwo(c, { charged: true });
  playTurn(c, sc, "Dragon Pulse");
  ok("a move of another type does not spend it", sc.active[0][0].charged === true);
}

// ---------------------------------------------------------------------------
// 5. two Charges running keep it
// ---------------------------------------------------------------------------
{
  const solver = makeSolver();
  const state = twoVsTwo(solver);
  const amph = state.active[0][0];
  playTurn(solver, state, "Charge");
  ok("the first Charge sets it", amph.charged === true);
  playTurn(solver, state, "Charge", null, 2);
  // Charge is itself an Electric move, so the clear fires -- and the op runs after it, which is
  // the Companion's ordering too (it clears before the ops are applied).
  ok("and a second Charge leaves it set rather than cancelling it", amph.charged === true,
    String(amph.charged));
  ok("and the Sp. Def went up again", amph.spd === 2, String(amph.spd));
}

// ---------------------------------------------------------------------------
// 6. leaving the field loses it
// ---------------------------------------------------------------------------
{
  const solver = makeSolver();
  const state = solver.buildState(board(
    [row(AMPH, { front: true, charged: true }), row(PARTNER, { front: true }), row(TARGET)],
    [row(TARGET, { front: true }), row(TARGET, { front: true })],
  ));
  const amph = state.active[0][0];
  ok("it starts charged", amph.charged === true);
  amph.out = true;
  solver.t.refill(state.active, state.sides, state.next, state.board);
  ok("and a Pokemon that leaves the field loses the boost", amph.charged === false, String(amph.charged));
}

// ---------------------------------------------------------------------------
// 6b. a CHOSEN switch loses it too, not only fainting
// ---------------------------------------------------------------------------
{
  // `refill` clears the boost on the faint path. A voluntary switch does not go through
  // `refill` at all -- it goes through `Solver.applySwitches`, which both the search and the
  // played game use -- so a Charge user could step out, come back, and still double its next
  // Electric move, which the games do not allow.
  const solver = makeSolver();
  const state = solver.buildState(board(
    [row(AMPH, { front: true, charged: true }), row(PARTNER, { front: true }), row(TARGET)],
    [row(TARGET, { front: true }), row(TARGET, { front: true })],
  ));
  const amph = state.active[0][0];
  ok("it starts charged", amph.charged === true);
  solver.applySwitches(state, [{ kind: SWITCH, position: 0, into: 2 }], 0);
  ok("and a chosen switch clears the boost", amph.charged === false, String(amph.charged));
  ok("the switch really happened", state.active[0][0] !== amph, "the same Pokemon is still out");
}

// ---------------------------------------------------------------------------
// 6c. the live board tells the search about the boost
// ---------------------------------------------------------------------------
{
  // `PlayGame.rowOf` is the one bridge from the live board to the boards the opponent searches.
  // It did not carry `charged`, so `buildState`'s restore was dead code in production and the
  // opponent planned against an Electric move priced at half what it would really do.
  const solver = makeSolver();
  const state = solver.buildState(board(
    [row(AMPH, { front: true, charged: true }), row(PARTNER, { front: true })],
    [row(TARGET, { front: true }), row(TARGET, { front: true })],
  ));
  const game = new PlayGame(solver, appData, "Doubles");
  game.state = state;
  const carried = game.rowOf(state.active[0][0], 0, AMPH);
  ok("rowOf carries the boost", carried.charged === true, JSON.stringify(Object.keys(carried)));
  // ...and the whole round trip: a described board built from that row is charged again.
  const rebuilt = makeSolver().buildState(board(
    [{ ...carried, front: true }, row(PARTNER, { front: true })],
    [row(TARGET, { front: true }), row(TARGET, { front: true })],
  ));
  ok("and a board rebuilt from it is charged", rebuilt.active[0][0].charged === true);
  // The control: an uncharged row does not come back charged.
  const plainGame = new PlayGame(solver, appData, "Doubles");
  plainGame.state = solver.buildState(board(
    [row(AMPH, { front: true }), row(PARTNER, { front: true })],
    [row(TARGET, { front: true }), row(TARGET, { front: true })],
  ));
  ok("an uncharged row stays uncharged",
    plainGame.rowOf(plainGame.state.active[0][0], 0, AMPH).charged === false);
}

// ---------------------------------------------------------------------------
// 7. the node key
// ---------------------------------------------------------------------------
{
  const solver = makeSolver();
  const plain = twoVsTwo(solver);
  const charged = twoVsTwo(solver, { charged: true });
  const a = solver.shapeOf(plain);
  const b = solver.shapeOf(charged);
  ok("a charged board is a different search node", a !== b, `${a} === ${b}`);
  ok("and the difference is the boost", b.includes("e"), b);
}

// ---------------------------------------------------------------------------
// 8. the damage cache is not poisoned either way
// ---------------------------------------------------------------------------
{
  // Charged first, then uncharged, on the SAME engine: the charged hit must not leave its
  // doubled number behind under the uncharged key, nor the other way round.
  const solver = makeSolver();
  const state = twoVsTwo(solver);
  const amph = state.active[0][0];
  const foe = state.active[1][0];
  amph.charged = true;
  const hot = solver.t.hitOn(amph, foe, 1, state.board).frac;
  amph.charged = false;
  const cold = solver.t.hitOn(amph, foe, 1, state.board).frac;
  amph.charged = true;
  const hotAgain = solver.t.hitOn(amph, foe, 1, state.board).frac;
  ok("the uncharged number is not the charged one", Math.abs(cold - hot) > 1e-9, `${cold} vs ${hot}`);
  ok("and asking again gives the same charged number", Math.abs(hotAgain - hot) < 1e-12, `${hotAgain} vs ${hot}`);
  ok("and the charged number is twice the uncharged one",
    Math.abs(hot / cold - 2) < 0.05, `${hot} / ${cold}`);
}

// ---------------------------------------------------------------------------
// 9. the rest of that path, which was broken in the same two ways
// ---------------------------------------------------------------------------
{
  // Charge could not be the only casualty: `planFor` dropped EVERY self-aimed EFFECT action,
  // and the one op already on that path -- `weather_heal` (Moonlight, Morning Sun, Synthesis) --
  // additionally read a `board` that was not a parameter of `runEffectOps` and had no enclosing
  // binding, so it would have thrown a ReferenceError the moment it was reached. Both are fixed,
  // and this is the check that says so: a hurt Clefable using Moonlight gets its health back.
  const solver = makeSolver();
  const CLEF = set("Clefable", "Black Glasses", "Magic Guard", "Bold",
    ["Moonlight", "Moonblast", "Protect", "Follow Me"], [32, 0, 32, 0, 2, 0]);
  const state = solver.buildState(board(
    [row(CLEF, { front: true, hp: 40 }), row(PARTNER, { front: true })],
    [row(TARGET, { front: true }), row(TARGET, { front: true })],
  ));
  const clef = state.active[0][0];
  const before = clef.hp;
  ok("Clefable starts hurt", before < 0.5, String(before));
  const events = playTurn(solver, state, "Moonlight");
  ok("Moonlight heals it", clef.hp > before, `${clef.hp} vs ${before}`);
  // Half of its maximum in no weather, which is what the registry's clause says.
  ok("by about half its maximum", Math.abs(clef.hp - before - 0.5) < 0.02, `${clef.hp - before}`);
  ok("and the turn does not report a failure",
    !events.some((e) => e.kind === "fails"), JSON.stringify(events));
  notes.push(`Moonlight: ${(before * 100).toFixed(0)}% -> ${(clef.hp * 100).toFixed(0)}%`);
}

for (const note of notes) console.log(`   ${note}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(`\n${checked} checked, ${failures.length} failed.`);
process.exit(failures.length ? 1 : 0);
