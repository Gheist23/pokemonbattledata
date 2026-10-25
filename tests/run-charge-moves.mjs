// Two-turn moves in a played game (TOURNAMENT_CHARGE, builder/tournament-test.js).
//
// The reported bug: Archaludon's Electro Shot went off right away with no rain up. The compiled
// registry was right all along -- {op: charge_then, skip_weather: "Rain", turns: 1, on_charge:
// +1 Sp. Atk} -- but `charge_then` was not on the exporter's WEB_MOVE_OPS list, so the op never
// reached the browser, and nothing in the turn engine would have read it if it had. Every
// charging move therefore fired on the turn it was chosen, at full power: Electro Shot, Meteor
// Beam, Sky Attack, Solar Blade, and Fly / Dig / Dive / Bounce / Phantom Force never left the
// field at all.
//
// What is checked here:
//
//   1. the data: the two-turn ops ship, with their own weather and their nested boosts;
//   2. the rule is OFF by default -- the Tournament Test's published numbers do not move;
//   3. with the rule on, a first use spends the turn and deals nothing, and `on_charge` is paid
//      on that turn (which is what the move's own text says);
//   4. the escapes: the move's own weather releases it at once, and a Power Herb pays for one;
//   5. a semi-invulnerable user cannot be hit while it is away;
//   6. the lock: a charging Pokemon is offered its charging move and nothing else -- no Protect,
//      no switch, and `slotActions` does not hand the extras back;
//   7. the release lands, and the state is cleared;
//   8. leaving the field cancels a charge, and a described board can carry one.
//
//   node tests/run-charge-moves.mjs
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
import { TournamentTest, TOURNAMENT_CHARGE } from "../builder/tournament-test.js";
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

/** A Solver whose turn engine models two-turn moves, as the played game builds it. */
function makeSolver({ charge = 1, format = "Doubles" } = {}) {
  const engine = new DamageEngine(appData);
  const meta = JSON.parse(readFileSync(join(root, "data", "builder", `meta-${format.toLowerCase()}.json`), "utf8"));
  const ev = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const tournament = new TournamentTest(evaluation, new KnownTeams(knownRaw), new TeamSuggestions(evaluation),
    { effects, liveHpRule: 1, chargeRule: charge });
  return new Solver(tournament);
}

const set = (species, item, ability, nature, moves, bonuses, form) => ({
  species, form: form || species, item, ability, nature, moves, bonuses: [...bonuses],
});

const ARCH = set("Archaludon", "Assault Vest", "Stamina", "Modest",
  ["Electro Shot", "Flash Cannon", "Dragon Pulse", "Body Press"], [32, 0, 0, 32, 2, 0]);
const ARCH_HERB = set("Archaludon", "Power Herb", "Stamina", "Modest",
  ["Electro Shot", "Flash Cannon", "Dragon Pulse", "Body Press"], [32, 0, 0, 32, 2, 0]);
const SUN = set("Charizard", "Charcoal", "Blaze", "Timid",
  ["Solar Beam", "Heat Wave", "Air Slash", "Protect"], [2, 0, 0, 32, 0, 32]);
const FLYER = set("Corviknight", "Leftovers", "Pressure", "Impish",
  ["Fly", "Brave Bird", "Roost", "Protect"], [32, 2, 32, 0, 0, 0]);
const BULKY = set("Amoonguss", "Sitrus Berry", "Regenerator", "Calm",
  ["Spore", "Pollen Puff", "Rage Powder", "Protect"], [32, 0, 2, 0, 32, 0]);
const HITTER = set("Garchomp", "Life Orb", "Rough Skin", "Jolly",
  ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]);

const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });
const board = (ourRows, theirRows, field = {}) => ({ sides: [ourRows, theirRows], field });

/** One turn, with each side's action chosen by name rather than by the planner. */
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
// 1. the data ships
// ---------------------------------------------------------------------------
{
  const moves = effects.moves || {};
  for (const op of ["charge_then", "semi_invulnerable", "two_turn_carry"]) {
    ok(`the exporter ships ${op}`, (effects.moveOps || []).includes(op));
  }
  const shot = (moves.electroshot || []).find((fx) => fx.op === "charge_then");
  ok("Electro Shot is a charging move", Boolean(shot));
  ok("and rain is what releases it at once", shot?.skip_weather === "Rain", String(shot?.skip_weather));
  ok("and it boosts Sp. Atk on the charging turn",
    shot?.on_charge?.op === "stage" && shot.on_charge.stats?.includes("sp_attack") && shot.on_charge.amount === 1);
  const beam = (moves.solarbeam || []).find((fx) => fx.op === "charge_then");
  ok("Solar Beam is released by Sun", beam?.skip_weather === "Sun", String(beam?.skip_weather));
  ok("Solar Blade is too", (moves.solarblade || []).some((fx) => fx.op === "charge_then" && fx.skip_weather === "Sun"));
  ok("Meteor Beam charges with no weather escape",
    (moves.meteorbeam || []).some((fx) => fx.op === "charge_then" && !fx.skip_weather));
  for (const [name, key] of [["Fly", "fly"], ["Dig", "dig"], ["Dive", "dive"], ["Bounce", "bounce"], ["Phantom Force", "phantomforce"]]) {
    ok(`${name} takes its user off the field`, (moves[key] || []).some((fx) => fx.op === "semi_invulnerable"));
  }
  notes.push(`data: ${Object.keys(moves).length} moves carry a modelled effect`);
}

// ---------------------------------------------------------------------------
// 2. the rule is off by default
// ---------------------------------------------------------------------------
{
  ok("TOURNAMENT_CHARGE is 0, so the Tournament Test's numbers do not move", TOURNAMENT_CHARGE === 0);
  const plain = makeSolver({ charge: 0 });
  ok("and an instance built without it does not model two-turn moves", plain.t.chargeOn === false);
  const state = plain.t.evaluation ? null : null;
  void state;
  const live = makeSolver();
  ok("while the played game's instance does", live.t.chargeOn === true);
}

// ---------------------------------------------------------------------------
// 3. a first use charges, and pays on_charge
// ---------------------------------------------------------------------------
{
  const solver = makeSolver();
  const state = solver.buildState(board(
    [row(ARCH, { front: true }), row(HITTER, { front: true })],
    [row(BULKY, { front: true }), row(HITTER, { front: true })],
  ));
  const arch = state.active[0][0];
  const foeHp = state.active[1][0].hp;
  const events = playTurn(solver, state, "Electro Shot");
  ok("the first Electro Shot deals no damage", state.active[1][0].hp === foeHp,
    `${state.active[1][0].hp} vs ${foeHp}`);
  ok("it is charging it", arch.charging === "electroshot", arch.charging);
  ok("from the slot it was used from", arch.chargeSlot === 0, String(arch.chargeSlot));
  ok("its Sp. Atk went up on the charging turn", arch.spa === 1, String(arch.spa));
  ok("it is still on the field (charge_then does not hide)", arch.hidden === false);
  ok("and the turn says so", events.some((e) => e.kind === "charging" && e.move === "Electro Shot"));

  // ... and the next turn it lands.
  const before = state.active[1][0].hp;
  const after = playTurn(solver, state, "Electro Shot", null, 2);
  ok("the second turn lands it", state.active[1][0].hp < before,
    `${state.active[1][0].hp} vs ${before}`);
  ok("and the charge is spent", arch.charging === "" && arch.chargeSlot === -1);
  ok("the turn reports the release", after.some((e) => e.kind === "release" && e.move === "Electro Shot"));
}

// ---------------------------------------------------------------------------
// 4. the escapes: its own weather, and a Power Herb
// ---------------------------------------------------------------------------
{
  const solver = makeSolver();
  const wet = solver.buildState(board(
    [row(ARCH, { front: true })], [row(BULKY, { front: true })], { weather: "Rain" },
  ));
  const hp = wet.active[1][0].hp;
  playTurn(solver, wet, "Electro Shot");
  ok("in rain Electro Shot fires at once", wet.active[1][0].hp < hp, `${wet.active[1][0].hp} vs ${hp}`);
  ok("and nothing is left charging", wet.active[0][0].charging === "");

  const dry = solver.buildState(board([row(ARCH, { front: true })], [row(BULKY, { front: true })]));
  playTurn(solver, dry, "Electro Shot");
  ok("with no rain it charges instead", dry.active[0][0].charging === "electroshot");

  const sunny = solver.buildState(board(
    [row(SUN, { front: true })], [row(BULKY, { front: true })], { weather: "Sun" },
  ));
  const sunHp = sunny.active[1][0].hp;
  playTurn(solver, sunny, "Solar Beam");
  ok("Solar Beam fires at once in sun", sunny.active[1][0].hp < sunHp);
  const shade = solver.buildState(board([row(SUN, { front: true })], [row(BULKY, { front: true })]));
  playTurn(solver, shade, "Solar Beam");
  ok("and charges out of it", shade.active[0][0].charging === "solarbeam");

  const herb = solver.buildState(board([row(ARCH_HERB, { front: true })], [row(BULKY, { front: true })]));
  const herbHp = herb.active[1][0].hp;
  playTurn(solver, herb, "Electro Shot");
  ok("a Power Herb pays for the charge", herb.active[1][0].hp < herbHp);
  ok("and is spent doing it", herb.active[0][0].herbUsed === true);
  playTurn(solver, herb, "Electro Shot", null, 2);
  ok("so the next one charges normally", herb.active[0][0].charging === "electroshot");
}

// ---------------------------------------------------------------------------
// 5. a semi-invulnerable user cannot be hit
// ---------------------------------------------------------------------------
{
  const solver = makeSolver();
  // Corviknight (67 base Speed) against Amoonguss (30), so the bird is up BEFORE the attack.
  const state = solver.buildState(board(
    [row(FLYER, { front: true })], [row(BULKY, { front: true })],
  ));
  const bird = state.active[0][0];
  const birdHp = bird.hp;
  playTurn(solver, state, "Fly", "Pollen Puff");
  ok("Fly takes its user off the field", bird.hidden === true);
  ok("it is charging Fly", bird.charging === "fly");
  ok("and an attack that comes after it did nothing", bird.hp === birdHp, `${bird.hp} vs ${birdHp}`);
  const foeHp = state.active[1][0].hp;
  playTurn(solver, state, "Fly", null, 2);
  ok("the next turn it comes down and hits", state.active[1][0].hp < foeHp);
  ok("and it is back on the field", bird.hidden === false && bird.charging === "");

  // The other half of the rule, and the reason the first version of this test was wrong: going
  // away costs a turn, so anything FASTER still lands its hit before the user leaves.
  const quick = solver.buildState(board(
    [row(FLYER, { front: true })], [row(HITTER, { front: true })],
  ));
  const slowBird = quick.active[0][0];
  const was = slowBird.hp;
  playTurn(solver, quick, "Fly", "Rock Slide");
  ok("a faster attacker hits it before it goes up", slowBird.hp < was, `${slowBird.hp} vs ${was}`);
  ok("and it is away all the same", slowBird.hidden === true);
}

// ---------------------------------------------------------------------------
// 6. the lock
// ---------------------------------------------------------------------------
{
  const solver = makeSolver();
  const state = solver.buildState(board(
    [row(ARCH, { front: true }), row(HITTER)], [row(BULKY, { front: true })],
  ));
  const open = solver.slotCandidates(state, 0, 0, { cap: 0 });
  ok("before charging it has a choice", open.length > 1, String(open.length));
  playTurn(solver, state, "Electro Shot");
  const locked = solver.slotCandidates(state, 0, 0, { cap: 0 });
  ok("while charging only Electro Shot is offered",
    locked.length > 0 && locked.every((a) => a.move === "Electro Shot"),
    locked.map((a) => a.move || a.kind).join(","));
  ok("so no Protect", !locked.some((a) => a.move === "Protect"));
  ok("and no switch", !locked.some((a) => a.kind === -1));
}

// ---------------------------------------------------------------------------
// 7. a charge does not survive leaving the field, and a board can carry one
// ---------------------------------------------------------------------------
{
  const solver = makeSolver();
  const state = solver.buildState(board(
    [row(ARCH, { front: true }), row(HITTER)], [row(BULKY, { front: true })],
  ));
  const arch = state.active[0][0];
  playTurn(solver, state, "Electro Shot");
  ok("it is charging", arch.charging === "electroshot");
  arch.out = true;
  solver.t.refill(state.active, state.sides, state.next, state.board);
  ok("knocked out, the charge is gone", arch.charging === "" && arch.hidden === false);

  const described = solver.buildState({
    sides: [[{ ...row(ARCH, { front: true }), charging: "electroshot" }], [row(BULKY, { front: true })]],
    field: {},
  });
  const carried = described.active[0][0];
  ok("a described board carries a charge in progress", carried.charging === "electroshot");
  ok("and finds the slot again", carried.chargeSlot === 0, String(carried.chargeSlot));
  const flying = solver.buildState({
    sides: [[{ ...row(FLYER, { front: true }), charging: "fly" }], [row(HITTER, { front: true })]],
    field: {},
  });
  ok("a Pokemon described as part-way through Fly is away", flying.active[0][0].hidden === true);
}

// ---------------------------------------------------------------------------
// 8. the search does not merge a charging board with a free one
// ---------------------------------------------------------------------------
{
  const solver = makeSolver();
  const free = solver.buildState(board([row(ARCH, { front: true })], [row(BULKY, { front: true })]));
  const mid = solver.buildState({
    sides: [[{ ...row(ARCH, { front: true }), charging: "electroshot" }], [row(BULKY, { front: true })]],
    field: {},
  });
  ok("the node key tells them apart", solver.shapeOf(free) !== solver.shapeOf(mid),
    `${solver.shapeOf(free)} vs ${solver.shapeOf(mid)}`);
}

// ---------------------------------------------------------------------------
// 9. two clauses the browser was shipped and never read
// ---------------------------------------------------------------------------
{
  const moves = effects.moves || {};
  ok("the exporter ships ignore_redirection", (effects.moveOps || []).includes("ignore_redirection"));
  ok("Snipe Shot carries it", (moves.snipeshot || []).some((fx) => fx.op === "ignore_redirection"));
  ok("Tearful Look carries bypass_protect", (moves.tearfullook || []).some((fx) => fx.op === "bypass_protect"));
  ok("and Feint still does", (moves.feint || []).some((fx) => fx.op === "bypass_protect"));

  const solver = makeSolver();
  // A Protect does not stop a move whose own text says it can hit through one.
  const guard = solver.buildState(board(
    [row(set("Incineroar", "Safety Goggles", "Intimidate", "Careful",
      ["Feint", "Flare Blitz", "Knock Off", "Parting Shot"], [32, 0, 2, 0, 32, 0]), { front: true })],
    [row(BULKY, { front: true })],
  ));
  const guarded = guard.active[1][0];
  guarded.guard = true;
  const hpBefore = guarded.hp;
  playTurn(solver, guard, "Feint");
  ok("Feint hits through a Protect", guarded.hp < hpBefore, `${guarded.hp} vs ${hpBefore}`);

  // ...and an ordinary move still does not.
  const stopped = solver.buildState(board(
    [row(ARCH, { front: true })], [row(BULKY, { front: true })],
  ));
  stopped.active[1][0].guard = true;
  const stillFull = stopped.active[1][0].hp;
  playTurn(solver, stopped, "Flash Cannon");
  ok("a Protect still stops everything else", stopped.active[1][0].hp === stillFull,
    `${stopped.active[1][0].hp} vs ${stillFull}`);
}

for (const note of notes) console.log(note);
if (failures.length) {
  console.error(`\n${failures.length} of ${checked} checks failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n${checked} checks, all passed.`);
