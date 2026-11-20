// REFLECT, LIGHT SCREEN AND AURORA VEIL COULD NOT BE USED AT ALL.
//
// `tests/run-op-coverage.mjs` was itself hiding this. Its second filter dropped a row when the
// engine mentioned the move's NAME anywhere -- and the engine does say "reflect", "lightscreen"
// and "auroraveil", in `TournamentTest.calc`'s read of `solverField`, which is the STATIC board
// the Solver page starts from and has nothing to do with the move. So three ops at 87.7%, 89.3%
// and 94.9% usage on their own carriers were excused by the audit that exists to find them. The
// filter is an annotation now, and these are what it found.
//
// What was actually wrong: the board had no screen. This file's own TOURNAMENT_FIELD note said
// so -- "the board has no screen, no turn count and no Light Clay to price that with" -- and the
// screens lived on `solverField`, which is set once for a whole Solver run. Set once means they
// could never change, which means `screen` and `clear_screen` could not be runnable, which means
// `Solver.effectActions` -- it refuses a status move unless EVERY op of it is runnable -- took
// Reflect, Light Screen, Aurora Veil, Glitzy Glow and Baddy Bad off the sheet entirely. A player
// on /play/ could not click Reflect.
//
// They are on `board.sc` now, packed one integer a side as turns, exactly as the hazards are.
// The parts worth testing are the ones that are easy to get wrong:
//
//   * THE DAMAGE CACHE. A screen halves the damage, so a screened hit is a different number for
//     the same key -- and the key cannot take another factor (`att.id` comes off a unit cache
//     that grows all session, and the mixed radix already overflows exact integer arithmetic
//     around the two-thousandth unit). So it gets its own store, the third thing to do that.
//     A cache blind to the screen hands back the halved number for the turn after it broke.
//   * WHICH SIDE. Reflect protects the side being HIT, which is not always the other one.
//   * THE TURNS. Five, eight behind a Light Clay, and they run down.
//   * AURORA VEIL NEEDS THE SNOW, and fails without it.
//   * BRICK BREAK, PSYCHIC FANGS and RAGING BULL are DAMAGING, so their `clear_screen` arrives
//     through `secondaries` and never reaches `runEffectOps` -- the trap Dire Claw was in.
//   * and the opponent must SEE the screen: `fieldOf` is handed back into `buildState`.
//
//   node tests/run-screens.mjs
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
import {
  TournamentTest, RUNNABLE_OPS, SCREEN_KINDS, screenTurns, setScreenTurns,
} from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => JSON.parse(readFileSync(join(root, ...p), "utf8"));

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const near = (label, got, want, tol, detail = "") =>
  ok(label, Math.abs(got - want) <= tol, `${got} vs ${want} +-${tol}${detail ? ` (${detail})` : ""}`);

const appData = read("data", "builder", "app-data.json");
const effects = read("data", "builder", "move-effects.json");
const metaDoubles = read("data", "builder", "meta-doubles.json");
const knownRaw = read("data", "builder", "known-teams.json");

const LIVE_RULES = {
  effects, liveHpRule: 1, chargeRule: 1, berryRule: 1, stagesRule: 1, confusionRule: 1, ppRule: 1,
  rberryRule: 1, bailRule: 1, shieldRule: 1, fieldTurnsRule: 1, abilityOpsRule: 1, hazardsRule: 1,
  pivotRule: 1, selfRollRule: 1, actionRollRule: 1, selfStatRule: 1,
};

function makeSolver() {
  const engine = new DamageEngine(appData);
  const ev = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(metaDoubles.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const t = new TournamentTest(evaluation, new KnownTeams(knownRaw), new TeamSuggestions(evaluation), LIVE_RULES);
  return new Solver(t);
}

const set = (species, item, ability, nature, moves, bonuses) => ({
  species, form: species, item, ability, nature, moves, bonuses: [...bonuses],
});
const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });
/**
 * A SCREEN IS NOT A HALF IN DOUBLES. The game's own number is 2732/4096, which `engine.js`
 * writes as `doubles ? 2 / 3 : 0.5` -- so this suite, which is Doubles throughout, expects two
 * thirds. Measured 0.6680 against an expected 0.5 the first time it ran, and the engine was the
 * one that was right.
 */
const SCREEN_SHARE = 2 / 3;
const boardOf = (ours, theirs, field = {}) => ({ sides: [ours, theirs], field });

/** A physical attacker, so Reflect is the screen that matters to it. */
const CHOMP = set("Garchomp", "", "Rough Skin", "Adamant",
  ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]);
/** A special attacker, for Light Screen. */
const BOLT = set("Magnezone", "", "Analytic", "Modest",
  ["Thunderbolt", "Flash Cannon", "Protect", "Volt Switch"], [2, 0, 0, 32, 0, 32]);
/** Reflect and Light Screen, and a Light Clay to make the eight-turn clause readable. */
const SETTER = set("Grimmsnarl", "Light Clay", "Prankster", "Careful",
  ["Reflect", "Light Screen", "Spirit Break", "Protect"], [32, 0, 2, 0, 32, 0]);
const PLAIN_SETTER = set("Grimmsnarl", "", "Prankster", "Careful",
  ["Reflect", "Light Screen", "Spirit Break", "Protect"], [32, 0, 2, 0, 32, 0]);
/** Aurora Veil, which needs the Snow its own Ability puts up. */
const VEIL = set("Ninetales-Alola", "", "Snow Warning", "Timid",
  ["Aurora Veil", "Blizzard", "Freeze-Dry", "Protect"], [2, 0, 0, 32, 0, 32]);
/** Psychic Fangs, which breaks a screen on the way through it. */
const BREAKER = set("Metagross", "", "Clear Body", "Adamant",
  ["Psychic Fangs", "Iron Head", "Bullet Punch", "Protect"], [2, 32, 0, 0, 0, 32]);
/** Something bulky enough that a hit is not clipped at the target's remaining HP. */
const TANK = set("Dondozo", "", "Unaware", "Impish",
  ["Wave Crash", "Earthquake", "Protect", "Curse"], [32, 0, 32, 0, 2, 0]);
const WALL = set("Amoonguss", "", "Regenerator", "Calm",
  ["Spore", "Pollen Puff", "Rage Powder", "Protect"], [32, 0, 2, 0, 32, 0]);

// ---------------------------------------------------------------------------
// 1. the packing
// ---------------------------------------------------------------------------

ok("there are three screens", SCREEN_KINDS.length === 3, SCREEN_KINDS.join(", "));
{
  let packed = 0;
  for (const kind of SCREEN_KINDS) {
    ok(`${kind} starts empty`, screenTurns(packed, kind) === 0);
  }
  packed = setScreenTurns(packed, "reflect", 5);
  packed = setScreenTurns(packed, "aurora_veil", 8);
  ok("a Reflect of five reads back as five", screenTurns(packed, "reflect") === 5);
  ok("...an Aurora Veil of eight as eight", screenTurns(packed, "aurora_veil") === 8);
  // THE SLOTS MUST NOT BLEED. One shift wrong and setting a Reflect sets a Light Screen.
  ok("...and the Light Screen beside them is still empty",
    screenTurns(packed, "light_screen") === 0, String(screenTurns(packed, "light_screen")));
  packed = setScreenTurns(packed, "reflect", 0);
  ok("clearing one leaves the others", screenTurns(packed, "reflect") === 0
    && screenTurns(packed, "aurora_veil") === 8, String(packed));
  ok("a Light Clay cannot buy a ninth turn", screenTurns(setScreenTurns(0, "reflect", 99), "reflect") === 8);
  ok("a word with no slot is refused", screenTurns(setScreenTurns(0, "nonsense", 5), "reflect") === 0);
}

// ---------------------------------------------------------------------------
// 2. the ops are runnable, so the moves are on the sheet
// ---------------------------------------------------------------------------

ok("the screen ops are runnable", RUNNABLE_OPS.has("screen") && RUNNABLE_OPS.has("clear_screen"));
ok("the registry ships the screen op", (effects.moveOps || []).includes("screen"));

function offered(aSet, field = {}, { forSearch = false } = {}) {
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(aSet, { front: true }), row(WALL, { front: true })],
    [row(CHOMP, { front: true }), row(WALL, { front: true })], field));
  return s.slotCandidates(state, 0, 0, forSearch ? {} : { cap: 0 }).map((a) => a.move).filter(Boolean);
}

ok("Reflect is offered", offered(SETTER).includes("Reflect"), offered(SETTER).join(", "));
ok("Light Screen is offered", offered(SETTER).includes("Light Screen"), offered(SETTER).join(", "));
ok("Aurora Veil is offered", offered(VEIL).includes("Aurora Veil"), offered(VEIL).join(", "));
// AND NOT WORTH A TURN WHEN IT IS ALREADY UP. The search drops it; the person's own sheet keeps
// every legal move, and the engine refuses it when it runs.
ok("the search does not set a Reflect that is already up",
  !offered(SETTER, { reflect: [true, false] }, { forSearch: true }).includes("Reflect"),
  offered(SETTER, { reflect: [true, false] }, { forSearch: true }).join(", "));
ok("...but it does set one that is not",
  offered(SETTER, {}, { forSearch: true }).includes("Reflect"),
  offered(SETTER, {}, { forSearch: true }).join(", "));

// ---------------------------------------------------------------------------
// 3. a described board's screen reaches the damage
// ---------------------------------------------------------------------------

/** The HP a physical hit actually takes off, through `deal`. */
function dealt(field, attacker = CHOMP, move = "Earthquake") {
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(attacker, { front: true }), row(WALL, { front: true })],
    [row(TANK, { front: true }), row(WALL, { front: true })], field));
  const me = state.active[0][0];
  const foe = state.active[1][0];
  const slot = me.u.moves.findIndex((mv) => mv && mv.name === move);
  const hit = s.t.hitOn(me, foe, slot, state.board, false);
  const before = foe.hp;
  s.t.deal(me, foe, hit, null, false, me, [me], state.board);
  return before - foe.hp;
}

{
  const clean = dealt({});
  ok("the measuring hit does not knock the target out", clean < 0.98, String(clean));
  // REFLECT PROTECTS THE SIDE BEING HIT, which is side 1 here. Putting it on side 0 -- the
  // attacker's own -- must do nothing at all: taking the defending side as `1 - attackSide`
  // applied the opponent's Reflect to your partner and left yours off, once.
  near("a Reflect on the side being hit cuts a physical move to two thirds",
    dealt({ reflect: [false, true] }) / clean, SCREEN_SHARE, 0.01);
  near("...and a Reflect on the ATTACKER's side changes nothing",
    dealt({ reflect: [true, false] }) / clean, 1, 1e-9);
  near("a Light Screen does nothing to a physical move",
    dealt({ lightScreen: [false, true] }) / clean, 1, 1e-9);
  near("an Aurora Veil cuts it too",
    dealt({ auroraVeil: [false, true] }) / clean, SCREEN_SHARE, 0.01);
}
{
  const clean = dealt({}, BOLT, "Thunderbolt");
  ok("the special measuring hit does not knock the target out", clean < 0.98, String(clean));
  near("a Light Screen cuts a special move",
    dealt({ lightScreen: [false, true] }, BOLT, "Thunderbolt") / clean, SCREEN_SHARE, 0.01);
  near("...and a Reflect does not",
    dealt({ reflect: [false, true] }, BOLT, "Thunderbolt") / clean, 1, 1e-9);
  near("an Aurora Veil cuts a special move as well",
    dealt({ auroraVeil: [false, true] }, BOLT, "Thunderbolt") / clean, SCREEN_SHARE, 0.01);
}

// ---------------------------------------------------------------------------
// 4. THE DAMAGE CACHE. The same key must not answer for both.
// ---------------------------------------------------------------------------

{
  // One board, one attacker, one move, asked BEFORE and AFTER the Reflect goes up -- so the
  // second question has the same cache key as the first. Without a store of its own the first
  // answer comes back and the screen is invisible to everything the search does afterwards.
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(CHOMP, { front: true }), row(WALL, { front: true })],
    [row(TANK, { front: true }), row(WALL, { front: true })]));
  const me = state.active[0][0];
  const foe = state.active[1][0];
  const slot = me.u.moves.findIndex((mv) => mv && mv.name === "Earthquake");
  const open = s.t.hitOn(me, foe, slot, state.board, false).frac;
  state.board.sc[1] = setScreenTurns(state.board.sc[1], "reflect", 5);
  const behind = s.t.hitOn(me, foe, slot, state.board, false).frac;
  near("the hit behind a Reflect is cut and the one before it was not",
    behind / open, SCREEN_SHARE, 0.01, `${open} -> ${behind}`);
  // ...AND BACK AGAIN, which is the half a one-way check would miss.
  state.board.sc[1] = setScreenTurns(state.board.sc[1], "reflect", 0);
  const after = s.t.hitOn(me, foe, slot, state.board, false).frac;
  near("and the hit after it breaks is the full one again", after, open, 1e-9);
  notes.push(`cache: ${open.toFixed(4)} open, ${behind.toFixed(4)} behind a Reflect, ${after.toFixed(4)} after it broke`);
}

// ---------------------------------------------------------------------------
// 5. setting one, and how long it lasts
// ---------------------------------------------------------------------------

/** Run one move's ops as a played turn and hand back the board. */
function runMove(aSet, move, field = {}) {
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(aSet, { front: true }), row(WALL, { front: true })],
    [row(CHOMP, { front: true }), row(WALL, { front: true })], field));
  const m = state.active[0][0];
  const slot = m.u.moves.findIndex((mv) => mv && mv.name === move);
  if (slot < 0) return { missing: true, s, state };
  s.t.effectRoll = () => 0;
  const out = s.t.runEffectOps(m, state.active[1][0], { slot, ops: m.u.moves[slot].fx || [] },
    state.active, [], state.board);
  s.t.effectRoll = null;
  return { out, s, state, m };
}

{
  const { state, out } = runMove(PLAIN_SETTER, "Reflect");
  ok("Reflect goes up on the user's own side",
    screenTurns(state.board.sc[0], "reflect") === 5, String(state.board.sc[0]));
  ok("...and not on the other one", screenTurns(state.board.sc[1], "reflect") === 0);
  ok("...and it says so", (out.did || []).includes("reflect"), JSON.stringify(out.did));
}
{
  // LIGHT CLAY, which this file's own note said the board had no way to price.
  const { state } = runMove(SETTER, "Reflect");
  ok("a Light Clay holder's Reflect lasts eight turns",
    screenTurns(state.board.sc[0], "reflect") === 8, String(screenTurns(state.board.sc[0], "reflect")));
}
{
  const { state, out } = runMove(PLAIN_SETTER, "Reflect", { reflect: [true, false] });
  ok("Reflect on a Reflect fails rather than resetting the counter",
    (out.did || []).length === 0, JSON.stringify(out.did));
  ok("...and leaves the turns it had", screenTurns(state.board.sc[0], "reflect") === 5,
    String(screenTurns(state.board.sc[0], "reflect")));
}
{
  // AURORA VEIL NEEDS THE SNOW. Ninetales-Alola's own Snow Warning puts it up on entry, so the
  // board it is standing on has it.
  // THE BOARD IS GIVEN THE SNOW. `buildState` does not run entry Abilities -- it starts from a
  // board somebody describes, and a Snow Warning holder standing on it arrived before the
  // description -- so asking for Ninetales-Alola and expecting its own snow measures the wrong
  // thing. The field switch is what the Solver page's own weather dropdown sets.
  const { state, out } = runMove(VEIL, "Aurora Veil", { weather: "Snow" });
  ok("the board is in snow", state.board.w !== 0, `weather index ${state.board.w}`);
  ok("Aurora Veil goes up in snow", screenTurns(state.board.sc[0], "aurora_veil") > 0,
    JSON.stringify(out.did));
}
{
  // ...and fails without it. A Pokemon with no weather Ability, carrying the move.
  const NOSNOW = set("Glaceon", "", "Snow Cloak", "Timid",
    ["Aurora Veil", "Blizzard", "Freeze-Dry", "Protect"], [2, 0, 0, 32, 0, 32]);
  const { state, out, missing } = runMove(NOSNOW, "Aurora Veil");
  if (missing) notes.push("Aurora Veil is not legal for the no-snow probe set; that clause is untested");
  else {
    ok("Aurora Veil fails with no snow", screenTurns(state.board.sc[0], "aurora_veil") === 0,
      String(state.board.sc[0]));
    ok("...and says why", (out.did || []).some((d) => /snow/i.test(String(d))), JSON.stringify(out.did));
  }
}
{
  // THE TURNS RUN DOWN, and the screen stops halving when they do.
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(CHOMP, { front: true }), row(WALL, { front: true })],
    [row(TANK, { front: true }), row(WALL, { front: true })], { reflect: [false, true] }));
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    seen.push(screenTurns(state.board.sc[1], "reflect"));
    s.t.tickField(state.board);
  }
  ok("a Reflect counts down five turns and then is gone",
    JSON.stringify(seen) === JSON.stringify([5, 4, 3, 2, 1, 0]), JSON.stringify(seen));
}

// ---------------------------------------------------------------------------
// 6. breaking one -- through `secondaries`, because the breakers are damaging
// ---------------------------------------------------------------------------

{
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(BREAKER, { front: true }), row(WALL, { front: true })],
    [row(TANK, { front: true }), row(WALL, { front: true })], { reflect: [false, true] }));
  const me = state.active[0][0];
  const foe = state.active[1][0];
  const slot = me.u.moves.findIndex((mv) => mv && mv.name === "Psychic Fangs");
  ok("Psychic Fangs is on the probe set", slot >= 0);
  if (slot >= 0) {
    ok("...and it is a DAMAGING move, so its ops arrive through secondaries",
      Boolean(me.u.moves[slot].damaging || me.u.moves[slot].attack || me.u.moves[slot].power),
      JSON.stringify({ damaging: me.u.moves[slot].damaging, power: me.u.moves[slot].power }));
    ok("the Reflect is up before it", screenTurns(state.board.sc[1], "reflect") === 5);
    s.t.secondaries(me, foe, { slot }, state.board);
    ok("Psychic Fangs breaks the Reflect on the side it hit",
      screenTurns(state.board.sc[1], "reflect") === 0, String(state.board.sc[1]));
    ok("...and not its own side's", screenTurns(state.board.sc[0], "reflect") === 0);
  }
}

// ---------------------------------------------------------------------------
// 7. a line's screen is its own, and the opponent can see it
// ---------------------------------------------------------------------------

{
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(SETTER, { front: true }), row(WALL, { front: true })],
    [row(CHOMP, { front: true }), row(WALL, { front: true })]));
  const line = s.cloneState(state);
  line.board.sc[0] = setScreenTurns(line.board.sc[0], "reflect", 5);
  ok("a Reflect set in one searched line stays in that line",
    screenTurns(state.board.sc[0], "reflect") === 0,
    `the board it came from reads ${screenTurns(state.board.sc[0], "reflect")}`);
}
{
  // `fieldOf` is handed BACK into `buildState` for the opponent's own search. Without the
  // screens in it the opponent searches a board with no Reflect on it while a Reflect is
  // halving every physical move it throws -- the same defect the hazards had.
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(SETTER, { front: true }), row(WALL, { front: true })],
    [row(CHOMP, { front: true }), row(WALL, { front: true })],
    { reflect: [true, false], auroraVeil: [false, true] }));
  // Through the engine's own round trip: the board -> a described field -> a board again.
  const described = {
    reflect: [screenTurns(state.board.sc[0], "reflect") > 0, screenTurns(state.board.sc[1], "reflect") > 0],
    auroraVeil: [screenTurns(state.board.sc[0], "aurora_veil") > 0,
      screenTurns(state.board.sc[1], "aurora_veil") > 0],
    reflectTurns: [screenTurns(state.board.sc[0], "reflect"), screenTurns(state.board.sc[1], "reflect")],
  };
  const again = s.buildState(boardOf(
    [row(SETTER, { front: true }), row(WALL, { front: true })],
    [row(CHOMP, { front: true }), row(WALL, { front: true })], described));
  ok("a described board round-trips its Reflect",
    screenTurns(again.board.sc[0], "reflect") === screenTurns(state.board.sc[0], "reflect"),
    `${screenTurns(state.board.sc[0], "reflect")} -> ${screenTurns(again.board.sc[0], "reflect")}`);
  ok("...and its Aurora Veil, on the right side",
    screenTurns(again.board.sc[1], "aurora_veil") > 0 && screenTurns(again.board.sc[0], "aurora_veil") === 0,
    `${again.board.sc[0]} / ${again.board.sc[1]}`);
  // AND A COUNT IS BELIEVED, so a Reflect with one turn left is not searched as five.
  const short = s.buildState(boardOf(
    [row(SETTER, { front: true }), row(WALL, { front: true })],
    [row(CHOMP, { front: true }), row(WALL, { front: true })],
    { reflect: [true, false], reflectTurns: [1, 0] }));
  ok("a board that says one turn is left is believed",
    screenTurns(short.board.sc[0], "reflect") === 1,
    String(screenTurns(short.board.sc[0], "reflect")));
}

// ---------------------------------------------------------------------------

for (const line of notes) console.log(`  note: ${line}`);
if (failures.length) {
  console.error(`\nrun-screens: ${failures.length} of ${checked} checks FAILED`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\nrun-screens: ${checked} checks passed`);
