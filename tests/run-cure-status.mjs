// THE BOARD'S CONDITION, AND THE MOVES THAT TAKE IT OFF.
//
// Two findings, one cause. `tests/run-op-coverage.mjs` named `cure_status` as an op the engine
// never read; following it down showed that the condition it was meant to remove was not really
// there in the first place.
//
//   1. `Solver.buildState` recorded a board's condition as a BOOLEAN (`m.burn`, `m.psn`, `m.tox`,
//      `m.frozen`, `m.sleep`) and left the probability slot `st` at zero. The booleans are not
//      vestigial -- they are what the board's OWN per-turn path reads, and that path works:
//      `Solver.residual` chips a poison and a bad poison, `Solver.thaw` draws a freeze's
//      one-in-five, `TournamentTest.endOfTurn` pays a burn, `m.idle` counts a sleep, and the
//      damage CALCULATOR halves a burned physical attack and a paralysed Speed off `mon.status`
//      (and knows Guts and Facade, which the turn model does not).
//
//      What the empty slot cost was the four readers that only read `st`: `statusFree`, so a
//      second condition could always be laid on a poisoned Pokemon; `Solver.drag`, so the
//      position score could not see any condition the board arrived with; `actionScale`'s
//      paralysis term, which is the one mechanic that was missing outright -- a board-paralysed
//      Pokemon never lost its one turn in four, as the Solver's own comment admitted; and
//      `cure_status`, which has nothing to cure if the slot is empty.
//
//      So the slot is now pinned BESIDE the boolean, and every per-turn reader of the slot
//      stands down for a board condition (`TournamentTest.baked`). Writing both without that
//      charges the condition twice: a burn took an eighth a turn and a poison a quarter, and
//      `statusFree` went negative. Measured below, each one on its own.
//
//   2. `cure_status` had no branch at all, and `Solver.effectActions` refuses a status move
//      unless EVERY one of its ops is runnable -- so Rest, Heal Bell, Aromatherapy, Refresh,
//      Purify, Jungle Healing, Lunar Blessing, Sparkly Swirl and Take Heart were all off the
//      sheet entirely, and on the damaging side Scald, Flare Blitz, Pyro Ball, Sacred Fire,
//      Scorching Sands, Steam Eruption, Flame Wheel, Burn Up, Sparkling Aria, Smelling Salts and
//      Wake-Up Slap all silently skipped the half of themselves that cures.
//
//   node tests/run-cure-status.mjs
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
import { TournamentTest, ACTION_KINDS, STATUS_SLOTS, statusField } from "../builder/tournament-test.js";
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

// The live rules, exactly as builder/analysis-worker.js builds them for /play/ and /solver/.
// WITHOUT `effects` none of this runs at all, and a suite built on the defaults would pass while
// testing the wrong engine.
const LIVE_RULES = {
  effects, liveHpRule: 1, chargeRule: 1, berryRule: 1, stagesRule: 1, confusionRule: 1, ppRule: 1,
  rberryRule: 1, bailRule: 1, shieldRule: 1, fieldTurnsRule: 1, abilityOpsRule: 1, hazardsRule: 1,
  pivotRule: 1, selfRollRule: 1, actionRollRule: 1, selfStatRule: 1,
};

function makeSolver(rules = LIVE_RULES) {
  const engine = new DamageEngine(appData);
  const ev = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(metaDoubles.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const t = new TournamentTest(evaluation, new KnownTeams(knownRaw), new TeamSuggestions(evaluation), rules);
  return new Solver(t);
}

const set = (species, item, ability, nature, moves, bonuses) => ({
  species, form: species, item, ability, nature, moves, bonuses: [...bonuses],
});

const CHOMP = set("Garchomp", "", "Rough Skin", "Adamant",
  ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]);
const WALL = set("Amoonguss", "", "Regenerator", "Calm",
  ["Spore", "Pollen Puff", "Rage Powder", "Protect"], [32, 0, 2, 0, 32, 0]);
/** Rest, and a bulky body to make the heal readable. */
const RESTER = set("Gastrodon", "", "Storm Drain", "Calm",
  ["Rest", "Earth Power", "Ice Beam", "Protect"], [32, 0, 2, 0, 32, 0]);
const BELLER = set("Sylveon", "", "Pixilate", "Calm",
  ["Heal Bell", "Hyper Voice", "Protect", "Calm Mind"], [32, 0, 2, 0, 32, 0]);
const REFRESHER = set("Milotic", "", "Competitive", "Calm",
  ["Refresh", "Scald", "Recover", "Protect"], [32, 0, 2, 0, 32, 0]);
const AQUA = set("Primarina", "", "Torrent", "Modest",
  ["Sparkling Aria", "Moonblast", "Protect", "Hydro Pump"], [2, 0, 0, 32, 32, 0]);
/**
 * SOMETHING THAT SURVIVES THE HIT, for the halving measurement below.
 *
 * `deal` caps the damage at what the target has left, so a hit that would knock the target out
 * reads as a whole bar whether it was halved or not: against Amoonguss the clean Earthquake was
 * 125.6% of a bar, both answers clipped to 100%, and the ratio came out 0.64 instead of 0.5.
 */
const TANK = set("Dondozo", "", "Unaware", "Impish",
  ["Wave Crash", "Earthquake", "Protect", "Curse"], [32, 0, 32, 0, 2, 0]);
/** A Fire type, which cannot be burned however insistently a board says it is. */
const FIRE = set("Incineroar", "", "Intimidate", "Careful",
  ["Flare Blitz", "Fake Out", "Knock Off", "Parting Shot"], [32, 0, 2, 0, 32, 0]);

const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });
const boardOf = (ours, theirs, field = {}) => ({ sides: [ours, theirs], field });

// ---------------------------------------------------------------------------
// 1. THE BOARD'S CONDITION REACHES THE TURN MODEL AT ALL
// ---------------------------------------------------------------------------

const solver = makeSolver();
const t = solver.t;
ok("the live registry is on, so this suite tests the engine /solver/ runs", t.effectsOn === true);

const WORDS = { burn: "brn", poison: "psn", toxic: "tox", paralysis: "par", sleep: "slp", freeze: "frz" };
for (const [word, slot] of Object.entries(WORDS)) {
  const state = solver.buildState(boardOf(
    [row(CHOMP, { front: true, status: word }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  const m = state.active[0][0];
  ok(`a board that says "${word}" pins st.${slot}`, (m.st?.[slot] || 0) === 1, JSON.stringify(m.st));
  ok(`...and every other slot stays empty for "${word}"`,
    STATUS_SLOTS.filter((x) => x !== slot).every((x) => (m.st[x] || 0) === 0), JSON.stringify(m.st));
  // BOTH REPRESENTATIONS, which is the point: the boolean is what the board's own per-turn path
  // reads and the slot is what the four readers above read. Paralysis has no boolean -- nothing
  // anywhere had one for it, which is exactly why its turn was never taken.
  const expected = { brn: "burn", slp: "sleep", psn: "psn", tox: "tox", frz: "frozen" }[slot] || "";
  ok(`...and the boolean the board's own path reads is set too ("${word}")`,
    !expected || m[expected] === true,
    `${expected}=${m[expected]} (burn=${m.burn} sleep=${m.sleep} psn=${m.psn} tox=${m.tox} frozen=${m.frozen})`);
  ok(`...and no OTHER boolean is ("${word}")`,
    ["burn", "sleep", "psn", "tox", "frozen"].filter((k) => k !== expected).every((k) => !m[k]),
    `burn=${m.burn} sleep=${m.sleep} psn=${m.psn} tox=${m.tox} frozen=${m.frozen}`);
  ok(`...so the status slot is full ("${word}")`, t.statusFree(m) === 0, String(t.statusFree(m)));
  ok(`...and the engine says which one it is ("${word}")`, m.bakedStatus === slot, String(m.bakedStatus));
}

// The immunity, which was asked for the burn and for nothing else.
{
  const state = solver.buildState(boardOf(
    [row(FIRE, { front: true, status: "burn" }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  const m = state.active[0][0];
  ok("a Fire type a board says is burned is not burned", (m.st?.brn || 0) === 0, JSON.stringify(m.st));
  ok("...and nothing claims it is", m.bakedStatus === "", String(m.bakedStatus));
}

// ---------------------------------------------------------------------------
// 2. AND IT COSTS SOMETHING, which is the half that was missing
// ---------------------------------------------------------------------------

/**
 * ONE TURN'S RESIDUAL, through BOTH halves of the path a real turn takes.
 *
 * A turn is `Solver.thaw` -> the actions (which end in `TournamentTest.endOfTurn`) ->
 * `Solver.tickBoard` (which calls `Solver.residual`). The two chips are split between the last
 * two on purpose and the code says so: `residual`'s own comment is "Burn is paid by
 * `TournamentTest.endOfTurn` ... Poison and bad poison are the Solver's, so they are paid here."
 *
 * Asking only one of them is how this suite first came to assert that a board poison chipped
 * from `endOfTurn`. It does not and never did; the first version of the fix moved it there and
 * broke `tests/run-solver.mjs` and `tests/run-play-game.mjs` for its trouble.
 */
function afterOneTurn(status) {
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(CHOMP, { front: true, status }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  s.t.endOfTurn(state.active, null, state.board);
  s.residual(state);
  return state.active[0][0].hp;
}

near("a clean Pokemon loses nothing at the end of a turn", afterOneTurn(""), 1, 1e-9);
// A SIXTEENTH, NOT AN EIGHTH. Both the `st` chip and the legacy `m.burn` chip existed; pinning
// the slot without standing the legacy one down took two.
near("a burned Pokemon loses a sixteenth", afterOneTurn("burn"), 1 - 1 / 16, 1e-9);
// An EIGHTH, and it was zero: nothing anywhere chipped `m.psn`.
near("a poisoned Pokemon loses an eighth", afterOneTurn("poison"), 1 - 1 / 8, 1e-9);
// A badly poisoned Pokemon on its first turn: a sixteenth per turn elapsed.
near("a badly poisoned Pokemon loses a sixteenth per turn elapsed",
  afterOneTurn("toxic"), 1 - 2 / 16, 1e-9, "toxTurns starts at 1 and this turn counts");

// THE LOST TURN. `actionScale` is what the search multiplies an action by.
{
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(CHOMP, { front: true, status: "paralysis" }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  near("a paralysed Pokemon gets three quarters of its action",
    s.t.actionScale(state.active[0][0]), 0.75, 1e-9);
}
{
  // A BOARD FREEZE IS `Solver.thaw`'S, not the slot's: it draws its own one chance in five and
  // otherwise spends a turn of `idle`, which is the counter the turn machinery already skips a
  // Pokemon by. `actionScale` stands down for it (`baked`) so the turn is not taken twice.
  let stuck = 0;
  let thawed = 0;
  for (let i = 0; i < 200; i += 1) {
    const s = makeSolver();
    const state = s.buildState(boardOf(
      [row(CHOMP, { front: true, status: "freeze" }), row(WALL, { front: true })],
      [row(WALL, { front: true }), row(WALL, { front: true })]));
    const m = state.active[0][0];
    s.thaw(state);
    if (m.frozen) stuck += 1; else thawed += 1;
    if (m.frozen) {
      ok("a frozen Pokemon that stayed frozen cannot act", (m.idle || 0) > 0, String(m.idle));
      ok("...and the slot still says it is frozen, undecayed", (m.st.frz || 0) === 1,
        JSON.stringify(m.st));
      break;
    }
  }
  ok("a board freeze mostly holds and sometimes thaws", stuck > 0 || thawed > 0,
    `${stuck} stuck, ${thawed} thawed`);
  // AND THE SLOT IS NOT CHARGED FOR IT A SECOND TIME. With `baked` removed this returned 0 --
  // the turn taken by `idle` and taken again by the slot.
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(CHOMP, { front: true, status: "freeze" }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  ok("the slot does not take the turn as well", s.t.actionScale(state.active[0][0]) === 1,
    String(s.t.actionScale(state.active[0][0])));
}

// ---------------------------------------------------------------------------
// 3. ...AND NOT TWICE. The calculator already priced the stat side.
// ---------------------------------------------------------------------------

/**
 * THE HP A PHYSICAL HIT ACTUALLY TAKES OFF, through `deal`.
 *
 * Not `hitOn`: that is the damage CALCULATOR's answer, which carries the burn from
 * `mon.status` and would read 0.5 whether or not the second halving in `deal` fires. Measuring
 * it there left the double count unguarded -- proved by removing the guard and watching this
 * suite stay green. `deal` is where the two meet, so `deal` is what has to be asked.
 */
function dealt(status) {
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(CHOMP, { front: true, status }), row(WALL, { front: true })],
    [row(TANK, { front: true }), row(WALL, { front: true })]));
  const me = state.active[0][0];
  const foe = state.active[1][0];
  // Earthquake is physical, which is the half a burn takes.
  const slot = me.u.moves.findIndex((mv) => mv && mv.name === "Earthquake");
  const hit = s.t.hitOn(me, foe, slot, state.board, false);
  const before = foe.hp;
  s.t.deal(me, foe, hit, null, false, me, [me], state.board);
  return before - foe.hp;
}
{
  const clean = dealt("");
  const burned = dealt("burn");
  // Neither answer may be clipped, or the ratio below means nothing.
  ok("the measuring hit does not knock the target out", clean < 0.98, String(clean));
  ok("a board-burned physical attacker does less", burned < clean, `${burned} vs ${clean}`);
  // HALVED ONCE. Quartered is the double count: the calculator halves it from `mon.status` and
  // `deal` halves it again from `st.brn` unless `bakedStatus` stands it down.
  near("...and exactly halved, not quartered", burned / clean, 0.5, 0.02,
    "the calculator's halving is the only one");
}
{
  const s = makeSolver();
  const clean = s.buildState(boardOf(
    [row(CHOMP, { front: true }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  const para = s.buildState(boardOf(
    [row(CHOMP, { front: true, status: "paralysis" }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  const fast = s.t.speed(clean.active[0][0], clean.board);
  const slow = s.t.speed(para.active[0][0], para.board);
  near("a board-paralysed Pokemon is halved once, not quartered", slow / fast, 0.5, 0.02,
    `${slow} vs ${fast}`);
}

// ---------------------------------------------------------------------------
// 4. THE MOVES ARE ON THE SHEET
// ---------------------------------------------------------------------------

/**
 * The moves offered to the first seat.
 *
 * TWO DIFFERENT LISTS, and the difference matters here. `cap: 0` is the person's own sheet and
 * keeps every LEGAL move, worthless or not -- `effectActions` says so: "The person playing keeps
 * the option anyway; the search drops it, because for the search the board is fixed." So a move
 * that is merely pointless is dropped from the SEARCH list and kept on the sheet, and a move the
 * game itself refuses is caught in `runEffectOps` instead (Rest at full health, tested below).
 */
function offered(aSet, status = "", hp = 100, { forSearch = false } = {}) {
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(aSet, { front: true, status, hp }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  const opts = forSearch ? {} : { cap: 0 };
  return s.slotCandidates(state, 0, 0, opts).map((a) => a.move).filter(Boolean);
}

for (const [label, aSet, move] of [
  ["Rest", RESTER, "Rest"], ["Heal Bell", BELLER, "Heal Bell"], ["Refresh", REFRESHER, "Refresh"],
]) {
  const names = offered(aSet, "burn", 50);
  ok(`${label} is offered on a hurt and statused Pokemon`, names.includes(move), names.join(", "));
}
// REST'S OWN RULE, and the reason it needs one: /play/ hands the player every legal move, so a
// Rest at full health would have put a healthy Pokemon to sleep for nothing in return.
ok("the SEARCH does not waste a turn on Rest at full health with nothing to cure",
  !offered(RESTER, "", 100, { forSearch: true }).includes("Rest"),
  offered(RESTER, "", 100, { forSearch: true }).join(", "));
ok("...but the search does take it once there is health to get back",
  offered(RESTER, "", 50, { forSearch: true }).includes("Rest"),
  offered(RESTER, "", 50, { forSearch: true }).join(", "));
ok("...while the person's own sheet keeps it either way, as it keeps every legal move",
  offered(RESTER, "", 100).includes("Rest"), offered(RESTER, "", 100).join(", "));
ok("the SEARCH does not waste a turn on Heal Bell over a clean party",
  !offered(BELLER, "", 100, { forSearch: true }).includes("Heal Bell"),
  offered(BELLER, "", 100, { forSearch: true }).join(", "));
ok("...and does take it when somebody is statused",
  offered(BELLER, "burn", 100, { forSearch: true }).includes("Heal Bell"),
  offered(BELLER, "burn", 100, { forSearch: true }).join(", "));

// ---------------------------------------------------------------------------
// 5. AND THEY DO WHAT THEY SAY
// ---------------------------------------------------------------------------

/** Run one move's registry ops as a PLAYED turn (a roll in hand, so everything happens whole). */
function runMove(aSet, move, { status = "", hp = 100, bench = [], foeStatus = "" } = {}) {
  const s = makeSolver();
  const ours = [row(aSet, { front: true, status, hp }), row(WALL, { front: true }),
    ...bench.map(([b, st]) => row(b, { status: st }))];
  const state = s.buildState(boardOf(ours,
    [row(WALL, { front: true, status: foeStatus }), row(WALL, { front: true })]));
  const m = state.active[0][0];
  const slot = m.u.moves.findIndex((mv) => mv && mv.name === move);
  if (slot < 0) return { missing: true, s, state, m };
  const ops = m.u.moves[slot].fx || [];
  s.t.effectRoll = () => 0; // a played turn: the move lands and every chance fires
  // `benchPool` is the side-channel the Solver sets for the two things that need the bench;
  // `party` is the third, and without it Heal Bell reaches the field only.
  s.t.benchPool = state.sides;
  const out = s.t.runEffectOps(m, state.active[1][0], { slot, ops }, state.active, [], state.board);
  s.t.effectRoll = null;
  return { out, s, state, m, ops };
}

{
  const { out, m, ops } = runMove(BELLER, "Heal Bell", { status: "burn" });
  ok("Heal Bell's op list is the one this suite thinks it is",
    ops.some((fx) => fx.op === "cure_status" && String(fx.target) === "party"), JSON.stringify(ops));
  ok("Heal Bell takes the burn off its user", (m.st.brn || 0) === 0, JSON.stringify(m.st));
  ok("...and says it did", (out.did || []).length > 0, JSON.stringify(out));
}
// THE BENCH, which is what `party` means and what the move is for. `ally_side` would have
// reached the field only.
{
  const { state } = runMove(BELLER, "Heal Bell", { bench: [[CHOMP, "paralysis"]] });
  const benched = state.sides[0].find((x) => x && /Garchomp/i.test(String(x.u?.form || "")));
  ok("Heal Bell reaches a team-mate on the BENCH", Boolean(benched) && (benched.st.par || 0) === 0,
    benched ? JSON.stringify(benched.st) : "no Garchomp on the bench");
}
// REFRESH NAMES ITS OWN LIST: burn, poison, toxic and paralysis. Not sleep -- which is exactly
// why "no list means all of them" must not be read as "all of them always".
ok("Refresh cures a burn",
  (runMove(REFRESHER, "Refresh", { status: "burn" }).m.st.brn || 0) === 0);
ok("Refresh does NOT cure a sleep",
  (runMove(REFRESHER, "Refresh", { status: "sleep" }).m.st.slp || 0) === 1);
// REST: all three ops, in order.
{
  const { m } = runMove(RESTER, "Rest", { status: "poison", hp: 40 });
  ok("Rest clears the condition it came in with", (m.st.psn || 0) === 0, JSON.stringify(m.st));
  near("...heals to full", m.hp, 1, 1e-9);
  ok("...and puts its user to sleep", (m.st.slp || 0) === 1, JSON.stringify(m.st));
}
{
  // The rule, read through the move rather than through the sheet.
  const { m, out } = runMove(RESTER, "Rest", { hp: 100 });
  ok("Rest at full health does nothing at all",
    (m.st.slp || 0) === 0 && (out.did || []).length === 0,
    `${JSON.stringify(m.st)} ${JSON.stringify(out)}`);
}
// PURIFY'S CONDITION, which the registry states and nothing read: it heals only if there was
// something to cure.
{
  const PURIFIER = set("Mareanie", "", "Merciless", "Calm",
    ["Purify", "Sludge Bomb", "Protect", "Recover"], [32, 0, 2, 0, 32, 0]);
  const dirty = runMove(PURIFIER, "Purify", { hp: 50, foeStatus: "burn" });
  const clean = runMove(PURIFIER, "Purify", { hp: 50, foeStatus: "" });
  if (dirty.missing || clean.missing) {
    notes.push("Purify is not a legal move for the probe set; its condition is untested here");
  } else {
    ok("Purify heals when the Pokemon it cured had something to cure", dirty.m.hp > 0.5,
      String(dirty.m.hp));
    ok("...and does not when it did not", Math.abs(clean.m.hp - 0.5) < 1e-9, String(clean.m.hp));
  }
}

// ---------------------------------------------------------------------------
// 6. THE DAMAGING HALF, which never reaches runEffectOps
// ---------------------------------------------------------------------------

{
  // SPARKLING ARIA takes the burn off what it hits. A damaging move, so its ops arrive in
  // `secondaries` -- the trap Dire Claw was in.
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(AQUA, { front: true }), row(WALL, { front: true })],
    [row(WALL, { front: true, status: "burn" }), row(WALL, { front: true })]));
  const me = state.active[0][0];
  const foe = state.active[1][0];
  const slot = me.u.moves.findIndex((mv) => mv && mv.name === "Sparkling Aria");
  ok("Sparkling Aria is on the probe set", slot >= 0);
  if (slot >= 0) {
    ok("...and its registry entry cures",
      (me.u.moves[slot].fx || []).some((fx) => fx.op === "cure_status"),
      JSON.stringify(me.u.moves[slot].fx));
    const before = foe.st.brn;
    s.t.secondaries(me, foe, { slot });
    ok("Sparkling Aria takes the burn off what it hits", before === 1 && (foe.st.brn || 0) === 0,
      `${before} -> ${foe.st.brn}`);
  }
}
{
  // THE FIRE MOVES THAW THEIR OWN USER (`target: "user"`, `before_action`).
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(REFRESHER, { front: true, status: "freeze" }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  const me = state.active[0][0];
  const slot = me.u.moves.findIndex((mv) => mv && mv.name === "Scald");
  ok("Scald is on the probe set", slot >= 0);
  if (slot >= 0) {
    s.t.secondaries(me, state.active[1][0], { slot });
    ok("Scald thaws its own user", (me.st.frz || 0) === 0, JSON.stringify(me.st));
  }
}

// ---------------------------------------------------------------------------
// 7. THE SEARCH LAYER: a cure is worth a SHARE, like everything else
// ---------------------------------------------------------------------------

{
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(BELLER, { front: true, status: "burn" }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  const m = state.active[0][0];
  // Half the condition, the way a 50% secondary is priced at half.
  const freed = s.t.clearStatus(m, 0.5, ["brn"]);
  near("a half-likely cure takes half the burn", m.st.brn, 0.5, 1e-9);
  near("...and reports what it freed", freed, 0.5, 1e-9);
  ok("...and does not touch anything else", (m.st.psn || 0) === 0 && (m.st.slp || 0) === 0);
}
{
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(BELLER, { front: true, status: "sleep" }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  const m = state.active[0][0];
  ok("a seeded sleep has turns on it", (m.idle || 0) > 0, String(m.idle));
  s.t.clearStatus(m, 1, null);
  ok("a whole cure clears the slot", (m.st.slp || 0) === 0, JSON.stringify(m.st));
  ok("...and the turns it had left with it", (m.idle || 0) === 0, String(m.idle));
  ok("...and curing nothing frees nothing", s.t.clearStatus(m, 1, null) === 0);
}

// ---------------------------------------------------------------------------
// 8. WHAT A CURE CANNOT GIVE BACK, recorded so it cannot change quietly
// ---------------------------------------------------------------------------

{
  // A condition the BOARD arrived with was handed to the damage calculator too, and those
  // numbers are baked into the prepared unit. Curing frees the slot and stops the chip; it does
  // not hand the halved attack back. That under-values the cure and does not misreport the
  // board -- and it is strictly better than the move being unselectable, which is where this
  // started. Undoing it means rebuilding the unit mid-search, which is a larger change.
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(CHOMP, { front: true, status: "burn" }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  const m = state.active[0][0];
  const foe = state.active[1][0];
  const slot = m.u.moves.findIndex((mv) => mv && mv.name === "Earthquake");
  const before = s.t.hitOn(m, foe, slot, state.board, false).frac;
  s.t.clearStatus(m, 1, null);
  const after = s.t.hitOn(m, foe, slot, state.board, false).frac;
  ok("the slot is free after the cure", (m.st.brn || 0) === 0, JSON.stringify(m.st));
  near("the BAKED halving stays, which is the recorded limit", after, before, 1e-9,
    "a board-seeded burn is in the prepared unit's own numbers");
  notes.push("recorded limit: curing a board-seeded burn frees the slot, not the calculator's halving");
}

// ---------------------------------------------------------------------------
// 9. the table itself
// ---------------------------------------------------------------------------

ok("statusField maps both spellings of a bad poison",
  statusField("toxic") === "tox" && statusField("badly_poisoned") === "tox");
ok("statusField refuses a word it has no slot for", statusField("confusion") === "");
ok("STATUS_SLOTS is the whole list", STATUS_SLOTS.length === 6);
ok("the action kinds are still importable", Number.isInteger(ACTION_KINDS.EFFECT));

// ---------------------------------------------------------------------------

for (const line of notes) console.log(`  note: ${line}`);
if (failures.length) {
  console.error(`\nrun-cure-status: ${failures.length} of ${checked} checks FAILED`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\nrun-cure-status: ${checked} checks passed`);
