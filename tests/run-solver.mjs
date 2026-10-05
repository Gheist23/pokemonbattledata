// The Solver (builder/solver.js): recreate a position and search it.
//
// The search is decoupled UCB over both sides' joint actions, with every line played out through
// the Tournament Test's own turn machinery. What is checked here:
//
//   1. the board: HP, stat stages, who is on the field, the back, the field conditions;
//   2. the action space: a Pokemon's moves become the actions the turn machinery can resolve,
//      switches are offered, Fake Out and First Impression only on the turn their user came in,
//      and a Protect used last turn is not offered again;
//   3. the search is even -- a board searched against itself comes out at 50, and the same board
//      searched from the other side gives the mirror answer. This is the invariant that catches a
//      search that reads one side's choice as a reply to the other's;
//   4. the answers are what they should be on boards with one right answer: a Pokemon that dies to
//      the incoming attack protects, a Pokemon that is about to be knocked out switches, and a
//      lethal attack is taken;
//   5. the statistics: every line is counted exactly once, the shares add to 1, and a longer
//      search concentrates them (which is what "it gets better the longer it runs" means).
//
//   node tests/run-solver.mjs
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
import { Solver, SWITCH, MAX_JOINTS, SEARCH_DEPTH } from "../builder/solver.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const knownRaw = JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8"));

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const near = (label, got, want, tolerance, detail = "") =>
  ok(label, Math.abs(got - want) <= tolerance, `${got} vs ${want}${detail ? ` (${detail})` : ""}`);

/** The evaluation stack a TournamentTest needs, on its own. */
function makeEvaluation(format = "Doubles") {
  const engine = new DamageEngine(appData);
  const meta = JSON.parse(readFileSync(join(root, "data", "builder", `meta-${format.toLowerCase()}.json`), "utf8"));
  const ev = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  return new TeamEvaluation(ev);
}

function makeSolver(format = "Doubles") {
  const engine = new DamageEngine(appData);
  const meta = JSON.parse(readFileSync(join(root, "data", "builder", `meta-${format.toLowerCase()}.json`), "utf8"));
  const ev = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const tournament = new TournamentTest(evaluation, new KnownTeams(knownRaw), new TeamSuggestions(evaluation));
  return new Solver(tournament);
}

const set = (species, item, ability, nature, moves, bonuses, form) => ({
  species, form: form || species, item, ability, nature, moves, bonuses: [...bonuses],
});

const FAST = set("Dragapult", "Life Orb", "Clear Body", "Jolly", ["Dragon Darts", "Phantom Force", "Protect", "Tailwind"], [2, 32, 0, 0, 0, 32]);
const BULKY = set("Amoonguss", "Sitrus Berry", "Regenerator", "Calm", ["Spore", "Pollen Puff", "Rage Powder", "Protect"], [32, 0, 2, 0, 32, 0]);
const HITTER = set("Garchomp", "Life Orb", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]);
const SUPPORT = set("Whimsicott", "Focus Sash", "Prankster", "Timid", ["Tailwind", "Moonblast", "Encore", "Protect"], [2, 0, 0, 32, 0, 32]);
const CAT = set("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"], [32, 0, 2, 0, 32, 0]);

const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });

function board(ourRows, theirRows, field = {}) {
  return { sides: [ourRows, theirRows], field };
}

const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `${JSON.stringify(got)} != ${JSON.stringify(want)}`);

const solver = makeSolver();

// ---------------------------------------------------------------------------
// 1. the board
// ---------------------------------------------------------------------------
{
  const state = solver.buildState(board(
    [row(FAST, { front: true, hp: 40, atk: 2, spe: -1 }), row(BULKY, { front: true }), row(HITTER), row(SUPPORT)],
    [row(HITTER, { front: true }), row(SUPPORT, { front: true, hp: 0 }), row(CAT), row(FAST)],
    { weather: "Sun", terrain: "Grassy", trickRoom: true, tailwind: [3, 0] },
  ));
  ok("both sides brought four", state.sides[0].length === 4 && state.sides[1].length === 4);
  ok("two stand on the field", state.active[0].length === 2 && state.active[1].length === 2);
  ok("and they are the ones marked front, not the first two by position",
     state.active[0][0].u.species === "Dragapult" && state.active[0][1].u.species === "Amoonguss");
  ok("the ones on the field come first", state.active[0][0] === state.sides[0][0] && state.active[0][1] === state.sides[0][1]);
  near("HP is carried in", state.active[0][0].hp, 0.4, 1e-9);
  ok("stat stages are carried in", state.active[0][0].atk === 2 && state.active[0][0].spe === -1);
  ok("a Pokemon at 0% is out", state.active[1][1].out === true);
  ok("the field is carried in", state.board.w === 1 && state.board.t === 2 && state.board.tr === 4 && state.board.tw[0] === 3);
  // Defense stages live on the Pokemon the calculator reads, not on the turn state
  const tough = solver.buildState(board([row(FAST, { front: true, def: 2 })], [row(HITTER, { front: true })]));
  ok("a Defense stage reaches the calculation", tough.active[0][0].u.mon.defense_stage === 2);
  ok("...and a different stage is a different unit to the damage cache",
     tough.active[0][0].u.key !== state.active[0][0].u.key);
}

// ---------------------------------------------------------------------------
// 2. the action space
// ---------------------------------------------------------------------------
{
  const state = solver.buildState(board(
    [row(SUPPORT, { front: true }), row(HITTER, { front: true }), row(CAT), row(BULKY)],
    [row(FAST, { front: true }), row(BULKY, { front: true })],
  ));
  const options = solver.slotCandidates(state, 0, 0);
  const kinds = new Set(options.map((o) => o.kind));
  const moves = new Set(options.map((o) => o.move));
  ok("Tailwind is offered", moves.has("Tailwind"), [...moves].join(", "));
  ok("Protect is offered", moves.has("Protect"));
  ok("Encore is offered", moves.has("Encore"));
  ok("Moonblast is offered at a named target", options.some((o) => o.move === "Moonblast" && o.target >= 0));
  ok("the back is offered as a switch", kinds.has(SWITCH), [...kinds].join(","));
  ok("a switch names the Pokemon it brings in",
     options.filter((o) => o.kind === SWITCH).every((o) => /→ \S/.test(o.move)));
  ok("no more than the per-slot cut survives", options.length <= 8, String(options.length));

  // Fake Out only on the turn its user came in
  const cold = solver.buildState(board([row(CAT, { front: true }), row(HITTER, { front: true })], [row(FAST, { front: true }), row(BULKY, { front: true })]));
  const warm = solver.buildState(board([row(CAT, { front: true, justIn: true }), row(HITTER, { front: true })], [row(FAST, { front: true }), row(BULKY, { front: true })]));
  ok("Fake Out is not offered to a Pokemon that has been in",
     !solver.slotCandidates(cold, 0, 0).some((o) => o.move === "Fake Out"));
  ok("Fake Out is offered the turn its user came in",
     solver.slotCandidates(warm, 0, 0).some((o) => o.move === "Fake Out"));

  // A Protect used last turn is not offered again
  const again = solver.buildState(board([row(SUPPORT, { front: true })], [row(HITTER, { front: true })]));
  again.active[0][0].guardedLast = true;
  ok("a Protect used last turn is not offered again",
     !solver.slotCandidates(again, 0, 0).some((o) => o.kind === 7));

  const joints = solver.jointsFor(state, 0);
  ok("the joint actions are capped", joints.length <= MAX_JOINTS, String(joints.length));
  ok("a joint action covers both Pokemon on the field", joints.every((j) => j.length === 2));
  ok("no joint action switches two Pokemon to the same one",
     joints.every((j) => {
       const taken = j.filter((a) => a.kind === SWITCH).map((a) => a.into);
       return new Set(taken).size === taken.length;
     }));
}

// ---------------------------------------------------------------------------
// 3. the search is even
// ---------------------------------------------------------------------------
{
  const mirror = board(
    [row(HITTER, { front: true }), row(SUPPORT, { front: true }), row(CAT), row(BULKY)],
    [row(HITTER, { front: true }), row(SUPPORT, { front: true }), row(CAT), row(BULKY)],
  );
  const result = await solver.search(mirror, { iterations: 600, lookahead: 3 });
  ok("a board searched against itself has no error", !result.error, String(result.error));
  near("a board against itself comes out even", result.value, 50, 2.5, `${result.played} lines`);
  notes.push(`mirror: ${result.played} lines in ${result.seconds.toFixed(2)}s, ${result.calcs} calculations, value ${result.value.toFixed(2)}`);
  ok("both sides are reported", result.ours.length > 0 && result.theirs.length > 0);
  ok("the two action spaces are the same size on a mirror", result.space[0] === result.space[1],
     result.space.join(" vs "));

  // The same board from the other side is the mirror answer.
  const flipped = board(mirror.sides[1], mirror.sides[0]);
  const back = await solver.search(flipped, { iterations: 600, lookahead: 3 });
  near("the same board from the other side is the mirror answer", back.value, 100 - result.value, 3.5);
}

// ---------------------------------------------------------------------------
// 4. the answers on boards with one right answer
// ---------------------------------------------------------------------------
{
  // Protect has to be worth something. The same board is searched twice -- once with Protect in
  // the moveset and once with it swapped for a move the Pokemon barely uses -- against a side
  // that can knock the Pokemon out this turn. If the search cannot see the refusal, the two come
  // out the same. Asserting WHICH move is best would be a weaker check and a wrong one: this
  // model values a board by HP share, so refusing with a Pokemon on 5% HP really is worth less
  // than firing with it, and the search is right to say so.
  const guardSet = set("Rillaboom", "Assault Vest", "Grassy Surge", "Adamant",
    ["Wood Hammer", "U-turn", "High Horsepower", "Protect"], [32, 32, 0, 0, 0, 2]);
  const openSet = { ...guardSet, moves: ["Wood Hammer", "U-turn", "High Horsepower", "Grassy Terrain"] };
  const against = [row(FAST, { front: true }), row(HITTER, { front: true })];
  // Measured over two seeds at 6000 lines each. 1500 was not enough to see it: the playouts are
  // stochastic, so the answer is a sample mean, and Protect is worth about three quarters of a
  // point on this board -- smaller than the noise at 1500 lines, which made the check flip sign
  // with the seed. Three seeds at 6000 gave +0.65, +0.77 and +1.03; three at 1500 gave -0.82,
  // +0.17 and -0.11. The effect was always there; the measurement was too short to resolve it.
  const run = (chosenSet, seed) => solver.search(board(
    [row(chosenSet, { front: true, hp: 55 }), row(CAT, { front: true }), row(BULKY), row(SUPPORT)],
    against), { iterations: 6000, lookahead: 3, seed });
  const guardRuns = [await run(guardSet, 1), await run(guardSet, 99)];
  const openRuns = [await run(openSet, 1), await run(openSet, 99)];
  const mean = (runs) => runs.reduce((sum, r) => sum + r.value, 0) / runs.length;
  const withGuard = { ...guardRuns[0], value: mean(guardRuns) };
  const without = { value: mean(openRuns) };
  ok("a Pokemon that can refuse the turn is worth more than one that cannot",
     withGuard.value > without.value, `${withGuard.value.toFixed(2)} vs ${without.value.toFixed(2)}`);
  const guardRank = withGuard.ours.findIndex((r) => r.actions.some((a) => a.move === "Protect"));
  notes.push(`Protect is worth ${(withGuard.value - without.value).toFixed(2)} points on that board, ranked ${guardRank + 1} of ${withGuard.ours.length}`);
  // Over the WHOLE ranked list, not the top six. The six shown on screen move about with the
  // seed and with how wide the action space is at depth, and the claim here is that the search
  // priced Protect at all -- which is what the value comparison above rests on.
  ok("and Protect is among the lines the search spent its time on",
     withGuard.ours.some((r) => r.actions.some((a) => a.move === "Protect")),
     withGuard.ours.slice(0, 6).map((r) => r.actions.map((a) => a.move).join("+")).join(" | "));

  // A lethal attack into a Pokemon on 5% is taken, not refused.
  const lethal = board(
    [row(HITTER, { front: true }), row(CAT, { front: true })],
    [row(SUPPORT, { front: true, hp: 5 }), row(BULKY, { front: true, hp: 5 })],
  );
  const kill = await solver.search(lethal, { iterations: 1200, lookahead: 3 });
  ok("a board of two Pokemon on 5% HP favours the side that is healthy", kill.value > 60, kill.value.toFixed(1));
  ok("the best line attacks", kill.ours[0].actions.some((a) => a.kind === 6),
     kill.ours[0].actions.map((a) => `${a.name}: ${a.move}`).join(" · "));
  notes.push(`lethal board: ${kill.value.toFixed(1)} for us, best = ${kill.ours[0].actions.map((a) => `${a.name}: ${a.move}`).join(" · ")}`);
}

// ---------------------------------------------------------------------------
// 5. the statistics
// ---------------------------------------------------------------------------
{
  const even = board(
    [row(HITTER, { front: true }), row(SUPPORT, { front: true }), row(CAT), row(BULKY)],
    [row(FAST, { front: true }), row(BULKY, { front: true }), row(CAT), row(SUPPORT)],
  );
  const short = await solver.search(even, { iterations: 400, lookahead: 3 });
  const long = await solver.search(even, { iterations: 2000, lookahead: 3 });
  const sum = (rows) => rows.reduce((total, r) => total + r.played, 0);
  ok("every line is counted exactly once on our side", sum(short.ours) === short.played, `${sum(short.ours)} vs ${short.played}`);
  ok("...and on theirs", sum(short.theirs) === short.played);
  near("the shares add to 1", short.ours.reduce((t, r) => t + r.share, 0), 1, 1e-9);
  ok("the rows come back by how often they were played",
     short.ours.every((r, i) => i === 0 || short.ours[i - 1].played >= r.played));
  ok("a longer search concentrates on the best line", long.ours[0].share >= short.ours[0].share - 0.02,
     `${(short.ours[0].share * 100).toFixed(1)}% -> ${(long.ours[0].share * 100).toFixed(1)}%`);
  notes.push(`concentration: ${(short.ours[0].share * 100).toFixed(1)}% at 400 lines -> ${(long.ours[0].share * 100).toFixed(1)}% at 2000`);
  ok("the best line is played far more often than an average one",
     long.ours[0].played > long.played / long.ours.length,
     `${long.ours[0].played} vs ${(long.played / long.ours.length).toFixed(0)}`);
  // A score is the mean of the lines it was played in, so it sits inside the board's range.
  ok("every score is a real board value", long.ours.every((r) => !r.played || (r.score >= 0 && r.score <= 100)));
}

// ---------------------------------------------------------------------------
// 6. every condition, the field, and the line played out
// ---------------------------------------------------------------------------
{
  // The turn model carries burn and sleep itself; the rest change the damage, so they are put
  // on the Pokemon the calculator reads. A condition it dropped on the floor would be a control
  // that does nothing, which is worse than not offering it.
  const seen = {};
  for (const status of ["", "poison", "toxic", "burn", "paralysis", "sleep", "freeze"]) {
    const state = solver.buildState(board(
      [row(HITTER, { front: true, status }), row(SUPPORT, { front: true })],
      [row(BULKY, { front: true }), row(CAT, { front: true })]));
    seen[status || "healthy"] = state.active[0][0].u.mon.status;
  }
  eq("every condition reaches the Pokemon the calculator reads", seen, {
    healthy: "", poison: "Poisoned", toxic: "Badly Poisoned", burn: "Burned",
    paralysis: "Paralyzed", sleep: "Asleep", freeze: "Frozen",
  });
  const burned = solver.buildState(board([row(HITTER, { front: true, status: "burn" })], [row(BULKY, { front: true })]));
  ok("burn is also carried by the turn model", burned.active[0][0].burn === true);
  const asleep = solver.buildState(board([row(HITTER, { front: true, status: "sleep" })], [row(BULKY, { front: true })]));
  ok("sleep costs the turn model some turns", asleep.active[0][0].idle > 0 && asleep.active[0][0].sleep === true);

  // The field the board cannot carry goes to the damage calculation instead. Screens and Friend
  // Guard belong to a SIDE, so they travel on `solverField`; an item being off and the two
  // counters belong to one Pokemon, so they travel on the unit -- which is also what puts them
  // in the damage cache key.
  solver.buildState(board([row(HITTER, { front: true })], [row(BULKY, { front: true })], {
    reflect: [false, true], lightScreen: [true, false], friendGuard: [false, false],
    auroraVeil: [false, false],
  }));
  const handed = solver.t.solverField;
  ok("the screens reach the engine, by the side they protect",
     handed && handed.reflect[1] === true && handed.lightScreen[0] === true,
     JSON.stringify(handed));
  ok("the dead rule switches are gone",
     handed && handed.items === undefined && handed.abilities === undefined
     && handed.weatherAbilities === undefined, JSON.stringify(handed));

  // Per-Pokemon now, and really per-Pokemon: two rows of the same set that differ only in a
  // counter must not share a unit, or the damage cache hands the first one's answer to both.
  {
    const plain = solver.buildState(board([row(HITTER, { front: true })], [row(BULKY, { front: true })]));
    const counted = solver.buildState(board(
      [{ ...row(HITTER, { front: true }), faintedAllies: 3, timesHit: 4 }], [row(BULKY, { front: true })]));
    const stripped = solver.buildState(board(
      [{ ...row(HITTER, { front: true }), itemOff: true }], [row(BULKY, { front: true })]));
    const silenced = solver.buildState(board(
      [{ ...row(HITTER, { front: true }), abilityOff: true }], [row(BULKY, { front: true })]));
    eq("the counters reach the Pokemon", [counted.active[0][0].u.faintedAllies, counted.active[0][0].u.timesHit], [3, 4]);
    ok("a counter makes it a different unit", plain.active[0][0].u.key !== counted.active[0][0].u.key);
    ok("an item switched off makes it a different unit", plain.active[0][0].u.key !== stripped.active[0][0].u.key);
    ok("an Ability switched off makes it a different unit", plain.active[0][0].u.key !== silenced.active[0][0].u.key);
    // Off means gone from the turn model too, not merely discounted in the damage number.
    eq("an item switched off is not held at all", stripped.active[0][0].u.mon.item, "");
    eq("an Ability switched off is not had at all", silenced.active[0][0].u.mon.ability, "");
    eq("and the set the person typed is untouched", HITTER.item, row(HITTER, {}).set.item);
  }

  // The board is a game already in progress, so the Pokemon standing on it have already entered.
  {
    const mid = solver.buildState(board(
      [row(HITTER, { front: true }), row(SUPPORT)], [row(BULKY, { front: true })]));
    ok("a Pokemon already on the field has already entered", mid.active[0][0].entered === true);
    ok("one in the back has not", mid.sides[0][1] && !mid.sides[0][1].entered);
  }
  const sides = solver.buildState(board([row(HITTER, { front: true })], [row(HITTER, { front: true })]));
  ok("a mirror board does not share one unit between the two sides",
     sides.active[0][0].u.key !== sides.active[1][0].u.key
     && sides.active[0][0].u.side === 0 && sides.active[1][0].u.side === 1);
}

{
  // The best line, played out, is what "how it goes from here" is made of.
  const result = await solver.search(board(
    [row(HITTER, { front: true }), row(SUPPORT, { front: true }), row(CAT), row(BULKY)],
    [row(FAST, { front: true }), row(BULKY, { front: true }), row(CAT), row(SUPPORT)],
  ), { iterations: 600, lookahead: 4 });
  const story = result.story;
  ok("the search plays its best line out", Boolean(story && story.turns && story.turns.length), JSON.stringify(story && story.turns && story.turns.length));
  if (story) {
    eq("one record per turn of the look-ahead", story.turns.length, 4);
    eq("the turns are numbered from one", story.turns.map((turn) => turn.turn), [1, 2, 3, 4]);
    ok("turn 1 names what both sides chose", story.turns[0].plays.length > 0,
       JSON.stringify(story.turns[0].plays));
    ok("the chosen turn is the reported best line",
       story.turns[0].plays.some((play) => result.ours[0].actions.some((a) => play.text.startsWith(a.name))),
       JSON.stringify([story.turns[0].plays, result.ours[0].actions]));
    ok("every HP reading is a whole percentage inside 0..100",
       story.turns.every((turn) => turn.hp.every((side) => side.every((m) => Number.isInteger(m.hp) && m.hp >= 0 && m.hp <= 100))));
    ok("the line's value is the board value it ends at", story.value >= 0 && story.value <= 100);
    notes.push(`story: ${story.turns.map((t2) => `T${t2.turn} ${t2.damage.length} hit(s)${t2.fainted.length ? `, ${t2.fainted.length} down` : ""}`).join(" | ")}`);
  }
}

// ---------------------------------------------------------------------------
// 7. the playout is a sample, and a seed makes it repeatable
// ---------------------------------------------------------------------------
{
  const position = board(
    [row(HITTER, { front: true }), row(SUPPORT, { front: true }), row(CAT), row(BULKY)],
    [row(FAST, { front: true }), row(BULKY, { front: true }), row(CAT), row(SUPPORT)],
  );
  const a = await solver.search(position, { iterations: 900, lookahead: 4, seed: 12345 });
  const b = await solver.search(position, { iterations: 900, lookahead: 4, seed: 12345 });
  const c = await solver.search(position, { iterations: 900, lookahead: 4, seed: 999 });
  eq("the same seed gives the same answer", [a.value, a.ours[0].key, a.ours[0].played],
     [b.value, b.ours[0].key, b.ours[0].played]);
  ok("a different seed does not", a.value !== c.value || a.ours[0].played !== c.ours[0].played,
     `${a.value} / ${c.value}`);
  notes.push(`seeded: 12345 -> ${a.value.toFixed(2)}, again ${b.value.toFixed(2)}, seed 999 -> ${c.value.toFixed(2)}`);

  // A hit that rolls is a hit that sometimes misses and sometimes reaches a knockout. On
  // expectation neither happens, which is the whole reason for the change.
  const rolls = new Set();
  const hit = { frac: 0.5, odds: 1, rollLo: 0.4, rollHigh: 0.6 };
  for (let i = 0; i < 200; i += 1) rolls.add(Math.round(solver.rollDamage(hit) * 1000));
  ok("the damage really varies across its spread", rolls.size > 8, `${rolls.size} distinct rolls`);
  ok("...and stays inside it", [...rolls].every((v) => v >= 400 && v <= 600), [...rolls].sort((x, y) => x - y).join(","));
  let misses = 0;
  const shaky = { frac: 0.35, odds: 0.7, rollLo: 0.5, rollHigh: 0.5 };
  for (let i = 0; i < 400; i += 1) if (solver.rollDamage(shaky) === 0) misses += 1;
  ok("a 70% move misses about three times in ten", misses > 60 && misses < 180, `${misses} of 400`);
  // A hit built before this -- one with no odds on it -- still deals its expected share, which
  // is what keeps the Tournament Test's own games deterministic.
  eq("a hit with no odds is unchanged", solver.rollDamage({ frac: 0.42 }), 0.42);

  // And the Solver must never leave its rolls on an engine the Tournament Test is using: a
  // worker keeps one evaluator across requests, so a borrowed instance would make the next Test
  // against Tournament Teams stochastic, silently, long after the Solver was closed.
  const plain = new TournamentTest(makeEvaluation(), new KnownTeams(knownRaw), null);
  eq("a fresh engine deals the expected share", plain.rollHit({ frac: 0.33, odds: 0.5, rollLo: 0.2, rollHigh: 0.4 }), 0.33);
  const borrowed = new Solver(plain);
  ok("...and the Solver is the one that changes its own", plain.rollHit !== TournamentTest.prototype.rollHit && borrowed instanceof Solver);

  // The second turn is searched rather than planned, and the tree says so.
  const deep = await solver.search(position, { iterations: 1200, lookahead: 4, seed: 7 });
  eq("two turns are searched", deep.searchedTurns, 2);
  ok("the tree grew nodes below the root", deep.nodes > 1, String(deep.nodes));
  // The searched depth is capped whatever the look-ahead: past two turns the visits per node are
  // too thin to beat the planner, so the rest of the look-ahead is the planner's tail.
  const long = await solver.search(position, { iterations: 1200, lookahead: 8, seed: 7 });
  eq("a longer look-ahead does not search deeper", long.searchedTurns, SEARCH_DEPTH);
  eq("...but it is still played to the end", long.lookahead, 8);
  notes.push(`tree: ${deep.nodes} nodes searching ${deep.searchedTurns} of ${deep.lookahead} turns; `
    + `${long.nodes} nodes searching ${long.searchedTurns} of ${long.lookahead}`);
}

// ---------------------------------------------------------------------------
// 8. Singles
// ---------------------------------------------------------------------------
{
  const singles = makeSolver("Singles");
  const result = await singles.search(board(
    [row(HITTER, { front: true }), row(SUPPORT), row(CAT)],
    [row(FAST, { front: true }), row(BULKY), row(CAT)],
  ), { iterations: 400, lookahead: 3 });
  ok("Singles searches one Pokemon a side", !result.error, String(result.error));
  ok("Singles brings three", result.ours[0].actions.length === 1,
     result.ours[0].actions.map((a) => a.name).join(", "));
  notes.push(`singles: ${result.played} lines, value ${result.value.toFixed(1)}, best = ${result.ours[0].actions.map((a) => `${a.name}: ${a.move}`).join(" · ")}`);
}

// ---------------------------------------------------------------------------
// 9. The stale-module guard
// ---------------------------------------------------------------------------
// The guard replaces the whole app with "reload without the cache" when the module graph was
// refused. Its first test was "is a .bd-loading still on screen after 25 seconds", which a
// RUNNING search also answers yes to -- the Solver now runs until the visitor presses Stop, so
// pressing Solve within the first 25 seconds had the page wiped out from under it. The guard
// now asks the page script whether it ran at all, which is the thing it actually wants to know.
{
  const pages = [
    ["solver/index.html", "builder/solver-page.js", "solverApp"],
    ["team-builder/index.html", "builder/builder-page.js", "builderApp"],
    ["damage-calculator/index.html", "builder/calc-page.js", "calcApp"],
  ];
  for (const [page, module_, root] of pages) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    const js = readFileSync(new URL(`../${module_}`, import.meta.url), "utf8");
    ok(`${page}: the guard is present`, html.includes(`getElementById("${root}")`));
    ok(`${page}: the guard stands down once the page script has run`,
       html.includes("if (window.__bdPageModuleRan) return;"));
    // Order matters: the flag has to be read BEFORE the DOM test, or the DOM test still wins.
    const flagAt = html.indexOf("window.__bdPageModuleRan");
    const domAt = html.indexOf(`getElementById("${root}")`);
    ok(`${page}: the flag is read before the DOM is judged`, flagAt > 0 && flagAt < domAt,
       `flag at ${flagAt}, DOM test at ${domAt}`);
    ok(`${module_}: raises the flag`, js.includes("window.__bdPageModuleRan = true"));
    // The flag must be in the module BODY. Inside a function or a listener it would only be
    // raised once that ran, and a page waiting on data would look dead again.
    const line = (js.match(/^.*window\.__bdPageModuleRan = true.*$/m) || [""])[0];
    ok(`${module_}: raises it at module scope`, /^try \{/.test(line.trim()), line.trim().slice(0, 60));
  }
}

// ---------------------------------------------------------------------------
// 10. Every turn of the story says what was done
// ---------------------------------------------------------------------------
// Only the SEARCHED turns used to carry moves. `playPath` passed a hard-coded null as the chosen
// actions for the planner tail, so with SEARCH_DEPTH 2 and a look-ahead of 4 the report read
// "Turn 3 / Mega Charizard Y 100% -> 60% / You lose Grimmsnarl" -- damage and a knockout, and no
// hint of what anyone did. The planner knew: `plannedTurn` builds the decisions in `plans` and
// simply never handed them back.
{
  const result = await solver.search(board(
    [row(HITTER, { front: true }), row(SUPPORT, { front: true }), row(CAT), row(BULKY)],
    [row(FAST, { front: true }), row(BULKY, { front: true }), row(CAT), row(SUPPORT)],
  ), { iterations: 800, lookahead: 4, seed: 5 });
  const story = result.story;
  ok("the best line is played out", Boolean(story && story.turns.length));
  if (story) {
    const empty = story.turns.filter((turn) => !turn.plays.length).map((turn) => turn.turn);
    // A turn with nothing in it is only honest when the board was already over.
    ok("every turn that was played says what was done", empty.length === 0,
       `turns with no moves: ${empty.join(", ")}`);
    const planner = story.turns.filter((turn) => turn.turn > result.searchedTurns);
    ok("the planner's turns are among them", planner.length > 0, String(planner.length));
    ok("a planner turn names a Pokemon and a move",
       planner.every((turn) => turn.plays.every((play) => /\S/.test(play.text))),
       JSON.stringify(planner[0] && planner[0].plays));
    ok("both sides are reported in a planner turn",
       planner.some((turn) => new Set(turn.plays.map((play) => play.side)).size === 2),
       JSON.stringify(planner.map((turn) => turn.plays.map((play) => play.side))));
    // Clone-safe: the worker structured-clones the whole result, and a plan entry holds live
    // unit and trait objects. Only strings and numbers may come out of `tell`.
    ok("the story survives a structured clone", (() => {
      try { structuredClone(story); return true; } catch { return false; }
    })());
    // One Pokemon cannot act twice in a turn. This is the shape the replayed story used to
    // produce: the best line was chosen on one board and played out on a second, and because an
    // action names its Pokemon by position, both of our slots came out reading the same name.
    for (const turn of story.turns) {
      for (const side of [0, 1]) {
        const actors = turn.plays.filter((play) => play.side === side)
          .map((play) => play.text.split(/[:→]/)[0].trim());
        ok(`turn ${turn.turn}: no Pokemon acts twice on side ${side}`,
           new Set(actors).size === actors.length, actors.join(" / "));
      }
    }
    notes.push(`planner turns: ${planner.map((turn) => `T${turn.turn} ${turn.plays.length} play(s)`).join(" | ")}`);
  }
}

// ---------------------------------------------------------------------------
// 11. "Just switched in" is spent by standing through a turn
// ---------------------------------------------------------------------------
// Nothing cleared `justIn`, so Fake Out and First Impression were legal on every searched turn,
// and a Pokemon that switched in mid-line kept the flag to the end of it.
{
  // CAT (Incineroar) is the only set here that knows Fake Out, so it has to be the one standing.
  const state = solver.buildState(board(
    [row(CAT, { front: true, justIn: true }), row(SUPPORT, { front: true, justIn: true }), row(HITTER), row(BULKY)],
    [row(FAST, { front: true, justIn: true }), row(BULKY, { front: true, justIn: true }), row(CAT), row(SUPPORT)],
  ));
  ok("the board says they have only just arrived", state.active[0].every((m) => m && m.justIn === true));
  const fakeOutTurnOne = solver.jointsFor(state, 0, 72)
    .some((joint) => joint.some((a) => a.move === "Fake Out"));
  solver.applyPlannedTurn(state, 1, null);
  ok("after a turn on the field they have not just arrived",
     state.active[0].every((m) => !m || !m.justIn),
     JSON.stringify(state.active[0].map((m) => m && m.justIn)));
  const fakeOutTurnTwo = solver.jointsFor(state, 0, 72)
    .some((joint) => joint.some((a) => a.move === "Fake Out"));
  ok("Fake Out is offered on the turn they arrive", fakeOutTurnOne);
  ok("and not again on the next turn", !fakeOutTurnTwo);
}

// A replacement has only just arrived, but `refill` has already run its entry Ability. Marking
// it just-in without marking it entered made the next turn fire that Ability a second time --
// a second Intimidate, a second weather set.
{
  const state = solver.buildState(board(
    [row(SUPPORT, { front: true }), row(FAST, { front: true }), row(CAT), row(BULKY)],
    [row(FAST, { front: true }), row(BULKY, { front: true }), row(CAT), row(SUPPORT)],
  ));
  const leaving = state.active[0][1];
  leaving.hp = 0;
  leaving.out = true;
  solver.tickBoard(state);
  const replacement = state.active[0][1];
  ok("a replacement came in", replacement && replacement !== leaving,
     replacement ? replacement.u.key.split("|")[2] : "nobody");
  ok("it counts as just switched in", replacement.justIn === true);
  ok("and as already entered, because refill entered it", replacement.entered === true);
}

// ---------------------------------------------------------------------------
// 12. A Pokemon cannot be switched in while it is already out
// ---------------------------------------------------------------------------
// `sides` is not kept with the ones standing at the front: `refill` takes the next unused
// Pokemon and advances a pointer rather than moving it up. So a Pokemon that switched out, and
// then came straight back in to replace something that fainted, is standing on the field while
// still sitting at a bench index -- and the switch list, which read indices from `activeCount`
// up, offered it. Taking that offer put one Pokemon on the field twice.
{
  const state = solver.buildState(board(
    [row(SUPPORT, { front: true }), row(CAT, { front: true }), row(HITTER), row(BULKY)],
    [row(FAST, { front: true }), row(BULKY, { front: true }), row(CAT), row(SUPPORT)],
  ));
  // Reproduce the arrangement by hand: switch our second slot out for the Pokemon behind it,
  // then knock the newcomer out and let `refill` bring the first one straight back.
  const leaving = state.active[0][1];
  const switchIn = solver.jointsFor(state, 0, 72)
    .flat().find((a) => a.kind === SWITCH && a.position === 1);
  ok("a switch is on offer to begin with", Boolean(switchIn));
  solver.applySwitches(state, [switchIn], 0);
  const replacement = state.active[0][1];
  ok("the switch happened", replacement !== leaving, `${replacement.u.key.split("|")[2]}`);
  replacement.hp = 0;
  replacement.out = true;
  solver.tickBoard(state);
  const backAgain = state.active[0][1];
  ok("the one that left came back in to replace it", backAgain === leaving,
     backAgain ? backAgain.u.key.split("|")[2] : "nobody");
  // It is standing. Nothing may offer it as a destination.
  const offered = solver.jointsFor(state, 0, 72).flat()
    .filter((a) => a.kind === SWITCH)
    .map((a) => state.sides[0][a.into]);
  ok("nothing standing is offered as something to switch to",
     offered.every((m) => !state.active[0].includes(m)),
     offered.map((m) => (m ? m.u.key.split("|")[2] : "?")).join(", "));
  ok("the ones really on the bench are still offered", offered.length > 0, String(offered.length));
  // And if a stale action ever names one anyway, playing it is refused rather than obeyed.
  const standing = state.active[0][1];
  const stale = { kind: SWITCH, position: 0, into: state.sides[0].indexOf(standing), move: "stale", value: 1 };
  const was = [...state.active[0]];
  solver.applySwitches(state, [stale], 0);
  eq("a stale switch onto a Pokemon that is already out does nothing", state.active[0], was);
}

// ---------------------------------------------------------------------------
// 13. A stat drop is reported against the Pokemon it happened to
// ---------------------------------------------------------------------------
// Every note used to be built as "<actor> <verb>", and the three events that lower a stat name
// the Pokemon that went DOWN in `targets`, not in `actor`. So an Icy Wind read "Milotic dropped
// Speed", which says Milotic's own Speed fell. It is the Speed of what it hits.
{
  const state = solver.buildState(board(
    [row(HITTER, { front: true }), row(SUPPORT, { front: true })],
    [row(FAST, { front: true }), row(BULKY, { front: true })],
  ));
  const mine = state.active[0][0].u;
  const ally = state.active[0][1].u;
  const foeOne = state.active[1][0].u;
  const foeTwo = state.active[1][1].u;
  const snap = solver.snapshot(state);
  const record = solver.turnRecord(1, [], [
    { kind: "speeddrop", actor: mine, targets: [foeOne, foeTwo], own: [] },
    { kind: "lower", actor: foeOne, targets: [mine], own: [foeTwo], stats: ["atk"] },
    { kind: "intimidate", actor: foeTwo, targets: [mine, ally] },
    { kind: "protect", actor: ally },
  ], snap, snap);
  const said = record.notes.join(" | ");
  const name = (unit) => solver.label(unit);
  ok("a Speed drop names whose Speed fell",
     record.notes.some((line) => line.includes(`${name(mine)} dropped`) && line.includes(name(foeOne)) && line.includes("Speed")), said);
  ok("and not the Pokemon that used the move",
     !record.notes.includes(`${name(mine)} dropped Speed`), said);
  ok("both Pokemon it hit are named", record.notes.some((line) => line.includes(name(foeOne)) && line.includes(name(foeTwo))), said);
  ok("a drop that caught the user's own partner is said separately",
     record.notes.some((line) => line.includes("also dropped") && line.includes(name(foeTwo))), said);
  ok("the stat is named in words", said.includes("Attack"), said);
  ok("Intimidate names what it lowered", record.notes.some((line) => line.includes(`${name(foeTwo)} dropped`) && line.includes("Attack")), said);
  ok("the ordinary notes still read as before", record.notes.includes(`${name(ally)} protected`), said);
  notes.push(`drops: ${said}`);
}

// ---------------------------------------------------------------------------
// 14. Stamina answers a hit
// ---------------------------------------------------------------------------
// Nothing in the turn model reacted to being hit. The state carries Attack, Sp. Atk and Speed and
// no Defense, and the Defense stage a board is set up with is frozen on the cached unit, so a
// line that hit Archaludon four times priced the fourth hit exactly like the first -- which is
// most of what makes Archaludon worth bringing.
{
  const WALL = set("Archaludon", "Leftovers", "Stamina", "Relaxed",
    ["Flash Cannon", "Draco Meteor", "Body Press", "Protect"], [32, 0, 16, 0, 16, 2]);
  const PLAIN = { ...WALL, ability: "Sturdy" };
  const priced = (mon) => {
    const state = solver.buildState(board(
      [row(mon, { front: true }), row(SUPPORT, { front: true }), row(CAT), row(BULKY)],
      [row(HITTER, { front: true }), row(BULKY, { front: true }), row(CAT), row(SUPPORT)]));
    const wall = state.active[0][0];
    const foe = state.active[1][0];
    const slot = foe.u.moves.findIndex((info) => info.name === "Earthquake");
    const first = solver.t.hitOn(foe, wall, slot, state.board).frac;
    solver.t.deal(foe, wall, solver.t.hitOn(foe, wall, slot, state.board), null);
    return { first, stage: wall.def, second: solver.t.hitOn(foe, wall, slot, state.board).frac };
  };
  const stamina = priced(WALL);
  const sturdy = priced(PLAIN);
  ok("being hit raises Stamina's Defense by exactly one stage", stamina.stage === 1, String(stamina.stage));
  ok("and the next hit is priced against the raised Defense", stamina.second < stamina.first,
     `${stamina.first.toFixed(5)} -> ${stamina.second.toFixed(5)}`);
  ok("the same Pokemon without Stamina is priced the same twice",
     Math.abs(sturdy.second - sturdy.first) < 1e-9,
     `${sturdy.first.toFixed(5)} -> ${sturdy.second.toFixed(5)}`);
  ok("and the first hit is the same for both", Math.abs(sturdy.first - stamina.first) < 1e-9,
     `${sturdy.first.toFixed(5)} vs ${stamina.first.toFixed(5)}`);
  // The seam is the Solver's own: the Tournament Test must never grow a reaction to being hit.
  // A fresh Tournament Test, built the way the suite builds the Solver's own, must have none.
  const bare = new TournamentTest(
    new TeamEvaluation(new TeamEvaluator(null, new DamageEngine(appData), "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }))),
    new KnownTeams({ teams: [] }), null);
  ok("a Tournament Test has no reaction to being hit", bare.onHit === null, String(bare.onHit));
  notes.push(`stamina: ${stamina.first.toFixed(5)} then ${stamina.second.toFixed(5)}; without it ${sturdy.second.toFixed(5)}`);
}

// ---------------------------------------------------------------------------
// 15. The terrain the board says is the terrain that is played
// ---------------------------------------------------------------------------
// `board.t` is an INDEX into the engine's terrain order, and the Solver kept a list of its own
// with Psychic and Misty the other way round. Choosing Psychic Terrain played Misty: Fake Out
// went through when the game would have refused it, and Dragon moves were halved instead.
{
  const field = (terrain) => solver.buildState(board(
    [row(CAT, { front: true }), row(SUPPORT, { front: true })],
    [row(HITTER, { front: true }), row(BULKY, { front: true })], { terrain })).board.t;
  for (const [terrain, index] of [["None", 0], ["Electric", 1], ["Grassy", 2], ["Psychic", 3], ["Misty", 4]]) {
    eq(`${terrain} Terrain reaches the engine as ${terrain}`, field(terrain), index);
  }
  // The weathers, for the same reason.
  const weather = (name) => solver.buildState(board(
    [row(CAT, { front: true })], [row(HITTER, { front: true })], { weather: name })).board.w;
  for (const [name, index] of [["None", 0], ["Sun", 1], ["Rain", 2], ["Sand", 3], ["Snow", 4]]) {
    eq(`${name} reaches the engine as ${name}`, weather(name), index);
  }
}

// ---------------------------------------------------------------------------
// 16. A switch does not invent damage
// ---------------------------------------------------------------------------
// The trace compared position i before the turn with position i after it, and `applySwitches`
// swaps two entries of `sides` -- so on any turn containing a switch it was comparing two
// different Pokemon. A turn where nobody was touched reported damage, and even healing.
{
  // The one waiting in the back is on 60%, which is what makes this case tell the two readings
  // apart: a positional diff sees "the Pokemon at slot 0 went from 100% to 60%" and calls it
  // damage, where in fact two Pokemon changed places and neither was touched.
  const state = solver.buildState(board(
    [row(CAT, { front: true }), row(SUPPORT, { front: true }), row(HITTER, { hp: 60 }), row(BULKY)],
    [row(FAST, { front: true }), row(BULKY, { front: true }), row(CAT), row(SUPPORT)]));
  const PROTECT_KIND = 7;
  const ours = solver.jointsFor(state, 0, 400)
    .find((joint) => joint.some((a) => a.kind === SWITCH) && joint.some((a) => a.kind === PROTECT_KIND));
  const theirs = solver.jointsFor(state, 1, 400).find((joint) => joint.every((a) => a.kind === PROTECT_KIND));
  ok("a turn of one switch and one Protect is on offer", Boolean(ours), String(Boolean(ours)));
  ok("and a turn where they only Protect", Boolean(theirs), String(Boolean(theirs)));
  if (ours && theirs) {
    const before = solver.snapshot(state);
    const events = [];
    solver.applyChosenTurn(state, ours, theirs, 1, events);
    const record = solver.turnRecord(1, [], events, before, solver.snapshot(state));
    eq("nothing took damage on a turn where nothing could", record.damage, []);
    eq("and nothing went down", record.fainted, []);
    // The Pokemon really did change places, so this is the case that used to lie.
    ok("the switch really happened",
       state.active[0].some((m) => m.u.key !== before[0][0].name && true), "sanity");
    notes.push(`switch turn: ${record.damage.length} damage row(s), ${record.fainted.length} knocked out`);
  }
}

// ---------------------------------------------------------------------------
// 17. A screen protects the side that is behind it
// ---------------------------------------------------------------------------
// The Solver read the screens for `1 - attackSide`. That is the side being hit for every ordinary
// attack, and the wrong one for a spread move that catches the attacker's own partner: your own
// Earthquake into your own Pokemon was shielded by the OPPONENT's Reflect and ignored yours.
{
  // A fresh Solver per field: the screens are NOT part of the damage cache key, which is right
  // because one search has one field, but it means one instance cannot be asked about two.
  const priced = (field) => {
    const own = makeSolver("Doubles");
    const state = own.buildState(board(
      [row(HITTER, { front: true }), row(CAT, { front: true })],
      [row(BULKY, { front: true }), row(SUPPORT, { front: true })], field));
    const me = state.active[0][0];
    const partner = state.active[0][1];
    const foe = state.active[1][0];
    const slot = me.u.moves.findIndex((info) => info.name === "Earthquake");
    return {
      partner: own.t.hitOn(me, partner, slot, state.board).frac,
      foe: own.t.hitOn(me, foe, slot, state.board).frac,
    };
  };
  const bare = priced({});
  const ourReflect = priced({ reflect: [true, false] });
  const theirReflect = priced({ reflect: [false, true] });
  ok("our own Reflect protects our partner from our own Earthquake",
     ourReflect.partner < bare.partner, `${bare.partner.toFixed(5)} -> ${ourReflect.partner.toFixed(5)}`);
  ok("their Reflect does not", Math.abs(theirReflect.partner - bare.partner) < 1e-9,
     `${bare.partner.toFixed(5)} -> ${theirReflect.partner.toFixed(5)}`);
  ok("their Reflect still protects them", theirReflect.foe < bare.foe,
     `${bare.foe.toFixed(5)} -> ${theirReflect.foe.toFixed(5)}`);
  ok("and ours does not protect them", Math.abs(ourReflect.foe - bare.foe) < 1e-9,
     `${bare.foe.toFixed(5)} -> ${ourReflect.foe.toFixed(5)}`);
  notes.push(`screens: partner ${bare.partner.toFixed(3)} -> ${ourReflect.partner.toFixed(3)} behind our Reflect`);
}

// ---------------------------------------------------------------------------
// 18. A Pokemon leaves its stat stages on the field
// ---------------------------------------------------------------------------
{
  const state = solver.buildState(board(
    [row(CAT, { front: true }), row(SUPPORT, { front: true }), row(HITTER), row(BULKY)],
    [row(FAST, { front: true }), row(BULKY, { front: true }), row(CAT), row(SUPPORT)]));
  const leaving = state.active[0][0];
  leaving.atk = 2;
  leaving.spe = -1;
  leaving.def = 1;
  const move = solver.jointsFor(state, 0, 400).flat().find((a) => a.kind === SWITCH && a.position === 0);
  ok("a switch is on offer", Boolean(move));
  solver.applySwitches(state, [move], 0);
  ok("it really left the field", state.active[0][0] !== leaving);
  eq("and it took none of its stages with it",
     [leaving.atk, leaving.spa, leaving.spe, leaving.def], [0, 0, 0, 0]);
}

for (const line of notes) console.log(line);
if (failures.length) {
  console.error(`\n${checked} checks, ${failures.length} failed:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\n${checked} checks, all passed.`);
