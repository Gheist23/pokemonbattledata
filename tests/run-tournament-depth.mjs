// Guards for the four rules that deepened Test against Tournament Teams (builder/tournament-test.js):
//
//   TOURNAMENT_DEPTH      the game that scores is FOUR planned turns (version 2; two under version 1)
//                         and is searched: each side picks one of three turn-1 stances, every pairing
//                         is played, and each side takes the one that holds up best against all three
//                         of the other side's. The lead matrix is that same searched game.
//   TOURNAMENT_GUARD      Protect fails when its user protected the turn before.
//   TOURNAMENT_VAR_POWER  a physical or special move the table lists at 0 power is still an attack
//                         when the engine prices it (Low Kick, Gyro Ball and the rest of that set).
//   TOURNAMENT_FALLOFF    Eruption, Water Spout and Dragon Energy are as strong as the HP their user
//                         has left, instead of always full power.
//
// What this suite is for: all four CHANGE SCORES, so each must (a) replay its old behaviour at
// version 0, (b) actually move something at its shipped version, and (c) leave the test even -- a team
// still scores exactly 50 against itself and A against B plus B against A still make exactly 100. (c)
// is the one that caught the first attempt at the search: reading their stance as a reply to ours,
// instead of as their own blind choice, broke it.
//
//   node tests/run-tournament-depth.mjs [teams]     (default 60)
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, compact } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import {
  TournamentTest, SNAPSHOT_VERSION, TOURNAMENT_DEPTH, TOURNAMENT_FALLOFF, TOURNAMENT_GUARD, TOURNAMENT_VAR_POWER,
  tournamentDepthOption, tournamentFalloffOption, tournamentGuardOption, tournamentVarPowerOption,
} from "../builder/tournament-test.js";
import { makeSet } from "../builder/common.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const knownRaw = JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8"));
const limit = Number(process.argv[2]) || 60;

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

function makeTest(opts = {}, format = "Doubles") {
  const engine = new DamageEngine(appData);
  const meta = JSON.parse(readFileSync(join(root, "data", "builder", `meta-${format.toLowerCase()}.json`), "utf8"));
  const ev = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new TournamentTest(evaluation, new KnownTeams(knownRaw), new TeamSuggestions(evaluation), opts);
}

// Every rule of this suite off, so each one can be switched on by itself. An explicit baseline and
// not `{}`: with four rules in play, leaving one at its shipped version would price another against
// a run that already has it.
const ALL_OFF = { depthRule: 0, falloffRule: 0, guardRule: 0, varPowerRule: 0 };
const withRules = (opts) => makeTest({ ...ALL_OFF, ...opts });

// The Trick Room + Drought team this work started from: it is the shape all four rules answer.
// Kingambit's Low Kick is what TOURNAMENT_VAR_POWER has to notice.
const TEAM = [
  { species: "Farigiraf", item: "Colbur Berry", ability: "Armor Tail", nature: "Bold", moves: ["Trick Room", "Helping Hand", "Protect", "Psychic"], bonuses: [27, 0, 20, 0, 19, 0] },
  { species: "Torkoal", item: "Life Orb", ability: "Drought", nature: "Quiet", moves: ["Eruption", "Protect", "Weather Ball", "Ancient Power"], bonuses: [32, 0, 0, 32, 2, 0] },
  { species: "Dragonite", form: "Mega Dragonite", item: "Dragoninite", ability: "Multiscale", nature: "Modest", moves: ["Protect", "Heat Wave", "Extreme Speed", "Draco Meteor"], bonuses: [2, 0, 0, 32, 0, 32] },
  { species: "Incineroar", item: "Chople Berry", ability: "Intimidate", nature: "Sassy", moves: ["Fake Out", "Flare Blitz", "Parting Shot", "Darkest Lariat"], bonuses: [32, 0, 14, 0, 20, 0] },
  { species: "Golisopod", form: "Mega Golisopod", item: "Golisopite", ability: "Tough Claws", nature: "Adamant", moves: ["Leech Life", "Iron Head", "Protect", "Swords Dance"], bonuses: [32, 32, 0, 0, 2, 0] },
  { species: "Kingambit", item: "Black Glasses", ability: "Defiant", nature: "Brave", moves: ["Kowtow Cleave", "Sucker Punch", "Protect", "Low Kick"], bonuses: [32, 32, 0, 0, 2, 0] },
];
const sets = () => TEAM.map((s) => makeSet(s));

// --- the stamps coerce like every other one -----------------------------------------------------
check("TOURNAMENT_DEPTH plays four planned turns", TOURNAMENT_DEPTH >= 2, String(TOURNAMENT_DEPTH));
check("TOURNAMENT_FALLOFF is on", TOURNAMENT_FALLOFF >= 1);
check("TOURNAMENT_GUARD is on", TOURNAMENT_GUARD >= 1);
check("TOURNAMENT_VAR_POWER is on", TOURNAMENT_VAR_POWER >= 1);
check("the snapshot version moved with them", SNAPSHOT_VERSION === 10, String(SNAPSHOT_VERSION));
for (const [name, fn, current] of [
  ["depth", tournamentDepthOption, TOURNAMENT_DEPTH],
  ["falloff", tournamentFalloffOption, TOURNAMENT_FALLOFF],
  ["guard", tournamentGuardOption, TOURNAMENT_GUARD],
  ["var power", tournamentVarPowerOption, TOURNAMENT_VAR_POWER],
]) {
  check(`${name}: an absent stamp is off`, fn(undefined) === 0 && fn(null) === 0 && fn("") === 0 && fn(false) === 0);
  check(`${name}: "0" and "off" are off`, fn("0") === 0 && fn("off") === 0 && fn("no") === 0);
  check(`${name}: a version is the integer`, fn(1) === 1 && fn("2") === 2 && fn(2.7) === 2);
  check(`${name}: an unreadable value falls back to what production runs`, fn("banana") === current);
  check(`${name}: a negative version is off`, fn(-3) === 0);
}

// --- 1. version 0 replays, each version moves ---------------------------------------------------
const off = await withRules({}).run(sets(), { limit });
const depth1 = await withRules({ depthRule: 1 }).run(sets(), { limit });
const depth2 = await withRules({ depthRule: 2 }).run(sets(), { limit });
const fallOnly = await withRules({ falloffRule: 1 }).run(sets(), { limit });
const deepAndFall = await withRules({ depthRule: 2, falloffRule: 1 }).run(sets(), { limit });
const guardAtOne = await withRules({ guardRule: 1 }).run(sets(), { limit });
const guardAtFour = await withRules({ depthRule: 2, guardRule: 1 }).run(sets(), { limit });
const varOnly = await withRules({ varPowerRule: 1 }).run(sets(), { limit });
const both = await makeTest().run(sets(), { limit });
check("every rule off is the shipped model", off.average > 0);
check("the depth rule moves the score", Math.abs(depth2.average - off.average) > 1e-9, `${off.average} -> ${depth2.average}`);
// Version 2 is the point of the work: four planned turns must say something two did not.
check("four planned turns take more off this team than two did", depth2.average < depth1.average - 1,
  `two ${depth1.average.toFixed(4)} -> four ${depth2.average.toFixed(4)}`);
check("the falloff rule moves the score", Math.abs(fallOnly.average - off.average) > 1e-9, `${off.average} -> ${fallOnly.average}`);
check("and the depth and falloff rules together move it further than either alone",
  deepAndFall.average < Math.min(depth2.average, fallOnly.average) + 1e-9,
  `off ${off.average.toFixed(3)} depth ${depth2.average.toFixed(3)} falloff ${fallOnly.average.toFixed(3)} both ${deepAndFall.average.toFixed(3)}`);
// The guard rule cannot possibly bite when only turn 1 is planned -- nothing has protected before
// turn 1, and no later turn asks. So it must be an exact no-op at depth 0, and must move at depth 2.
check("the guard rule changes nothing while only turn 1 is planned", guardAtOne.average === off.average,
  `depth 0 ${off.average} -> ${guardAtOne.average}`);
check("the guard rule moves the score once four turns are planned", Math.abs(guardAtFour.average - depth2.average) > 1e-9,
  `${depth2.average.toFixed(4)} -> ${guardAtFour.average.toFixed(4)}`);
// Kingambit's Low Kick is priced at nothing under version 0 and is an attack under version 1.
check("the variable-power rule moves the score", Math.abs(varOnly.average - off.average) > 1e-9,
  `${off.average.toFixed(4)} -> ${varOnly.average.toFixed(4)}`);
// The direction is the point of the work: this team was over-rated, so it must come DOWN.
check("the deepened test rates the Trick Room team lower, not higher", both.average < off.average - 1,
  `${off.average.toFixed(3)} -> ${both.average.toFixed(3)}`);
check("the snapshot says 10 whatever the rules", off.version === 10 && both.version === 10);

// --- 2. the search really runs, four turns deep -------------------------------------------------
{
  const test = makeTest();
  let deepCalls = 0;
  let playouts = 0;
  const plannedAt = new Map();
  const origDeep = test.playDeep.bind(test);
  test.playDeep = (o, t) => {
    const r = origDeep(o, t);
    deepCalls += 1;
    playouts += r.grid.length * r.grid[0].length;
    return r;
  };
  const origTurn = test.plannedTurn.bind(test);
  test.plannedTurn = (a, b, c, turn, e, s) => {
    plannedAt.set(turn, (plannedAt.get(turn) || 0) + 1);
    return origTurn(a, b, c, turn, e, s);
  };
  const run = await test.run(sets(), { limit: 8 });
  check("the scoring games are searched", deepCalls > 0, `${deepCalls} calls`);
  check("nine playouts per searched game", playouts === deepCalls * 9, `${playouts} of ${deepCalls * 9}`);
  check("turn 2 is a planned turn", (plannedAt.get(2) || 0) >= deepCalls, `${plannedAt.get(2)} planned second turns`);
  check("so are turns 3 and 4", (plannedAt.get(3) || 0) > 0 && (plannedAt.get(4) || 0) > 0,
    `turn 3 ${plannedAt.get(3) || 0}, turn 4 ${plannedAt.get(4) || 0}`);
  check("and turn 5 is not: four turns are planned, the rest are the attack-only fight",
    !plannedAt.has(5), [...plannedAt.keys()].sort((x, y) => x - y).join(","));
  // The deeper plan must not lengthen the game: the turn budget is TURN_CAP, 10 in Doubles.
  const games = [...(run.hardest || []), ...(run.easiest || [])];
  check("the turn budget is unchanged (no recorded game runs past turn 10)",
    games.length > 0 && games.every((g) => (g.result?.turns || 0) <= 10),
    `longest ${Math.max(0, ...games.map((g) => g.result?.turns || 0))}`);
  // Version 1 plans turn 2 and stops there; version 0 plans nothing after turn 1.
  const twoOnly = makeTest({ depthRule: 1 });
  const twoAt = new Map();
  const origTwo = twoOnly.plannedTurn.bind(twoOnly);
  twoOnly.plannedTurn = (a, b, c, turn, e, s) => {
    twoAt.set(turn, (twoAt.get(turn) || 0) + 1);
    return origTwo(a, b, c, turn, e, s);
  };
  await twoOnly.run(sets(), { limit: 8 });
  check("version 1 plans exactly two turns", (twoAt.get(2) || 0) > 0 && !twoAt.has(3),
    [...twoAt.keys()].sort((x, y) => x - y).join(","));
  const plain = makeTest({ depthRule: 0 });
  const plainAt = new Map();
  const origPlain = plain.plannedTurn.bind(plain);
  plain.plannedTurn = (a, b, c, turn, e, s) => {
    plainAt.set(turn, (plainAt.get(turn) || 0) + 1);
    return origPlain(a, b, c, turn, e, s);
  };
  await plain.run(sets(), { limit: 8 });
  check("version 0 plans one turn only", !plainAt.has(2), [...plainAt.keys()].sort((x, y) => x - y).join(","));
  // The lead matrix belongs to version 2: version 1 keeps the one unsearched turn it was drawn with,
  // byte for byte, because a matrix cell is a number in the snapshot like any other.
  // A pair of line-ups the two models disagree about, so the check can tell them apart at all. Many
  // pairs end the same way whatever is planned; the first that does not is the one to ask.
  const telling = (test) => {
    const plan = (a, b) => test.fixedPlan([a, b].map((i) => test.ourUnit(makeSet(TEAM[i]), i)));
    for (let a = 0; a < TEAM.length; a += 1) for (let b = a + 1; b < TEAM.length; b += 1) {
      for (let c = 0; c < TEAM.length; c += 1) for (let d = c + 1; d < TEAM.length; d += 1) {
        const ours = plan(a, b);
        const theirs = plan(c, d);
        const flat = test.play(ours, theirs).value;
        const searched = test.playDeep(ours, theirs).value;
        if (Math.abs(flat - searched) > 1e-9) return { ours, theirs, flat, searched };
      }
    }
    return null;
  };
  for (const [label, rule] of [["version 1", 1], ["version 2", 2]]) {
    const test = makeTest({ depthRule: rule });
    const found = telling(test);
    check(`${label}: some pair of line-ups the two models disagree about`, Boolean(found));
    if (!found) continue;
    const cell = test.cellValue(found.ours, found.theirs);
    check(`${label}: the lead matrix is ${rule >= 2 ? "the searched game" : "one unsearched turn"}`,
      cell === (rule >= 2 ? found.searched : found.flat), `${cell} (flat ${found.flat}, searched ${found.searched})`);
  }
}

// --- 3. the test is still even ------------------------------------------------------------------
// The guard that caught the first attempt. A team must score exactly 50 against itself and two teams
// must still add up to exactly 100, at EVERY version of EVERY rule here -- the four planned turns and
// the searched lead matrix are a different game, and the guard and variable-power rules are different
// numbers, but none of them may put a thumb on either side of the scale.
{
  const probe = makeTest();
  const byName = new Map(knownRaw.teams.map(([n, r]) => [n, r]));
  const rowSets = (rows) => rows.map(([species, form, item, ability, nature, moves]) => {
    const usage = probe.usageStem.get(`${compact(species)}|${compact(form || "")}`) || species;
    const spread = probe.suggestions.spreadForNature(usage, nature || "") || probe.suggestions.spreadForNature(species, nature || "");
    return makeSet({ species, form: form || "", item, ability, nature: nature || spread?.nature_name || "Serious", moves: moves || [], bonuses: [...(spread?.bonuses || [0, 0, 0, 0, 0, 0])] });
  });
  const valuesOf = async (rows, opts) => {
    const test = makeTest(opts);
    const seen = new Map();
    const orig = test.playTeam.bind(test);
    test.playTeam = (state, team) => {
      orig(state, team);
      seen.set(team.name, state.results[state.results.length - 1].value);
    };
    await test.run(rowSets(rows), { limit: 24 });
    return seen;
  };
  const names = [...(await valuesOf(byName.get("team1.txt"), ALL_OFF)).keys()];
  const picks = [names[0], names[3], names[9], names[17]].filter(Boolean);
  const configs = [
    ["everything off", ALL_OFF],
    ["two planned turns", { ...ALL_OFF, depthRule: 1 }],
    ["four planned turns", { ...ALL_OFF, depthRule: 2 }],
    ["four planned turns + the guard rule", { ...ALL_OFF, depthRule: 2, guardRule: 1 }],
    ["four planned turns + variable power", { ...ALL_OFF, depthRule: 2, varPowerRule: 1 }],
    ["production", {}],
  ];
  for (const [label, opts] of configs) {
    const table = new Map();
    for (const name of picks) table.set(name, await valuesOf(byName.get(name), opts));
    for (const name of picks) {
      check(`${label}: ${name} scores exactly 50 against itself`, table.get(name).get(name) === 50, String(table.get(name).get(name)));
    }
    for (let i = 0; i < picks.length; i += 1) {
      for (let j = i + 1; j < picks.length; j += 1) {
        const a = table.get(picks[i]).get(picks[j]);
        const b = table.get(picks[j]).get(picks[i]);
        check(`${label}: ${picks[i]} and ${picks[j]} add up to exactly 100`, a + b === 100, `${a} + ${b} = ${a + b}`);
      }
    }
  }
}

// --- 4. the falloff, move by move ---------------------------------------------------------------
{
  const foeMember = { species: "Snorlax", form: "", item: "Sitrus Berry", ability: "Thick Fat", nature: "Careful", moves: ["Body Slam", "Protect", "Yawn", "Curse"] };
  const read = (rule, moveName) => {
    const test = makeTest({ falloffRule: rule });
    const torkoal = makeSet(TEAM[1]);
    const unit = test.ourUnit(torkoal, 1);
    const foe = test.opponentMon(foeMember);
    const board = test.freshBoard();
    board.w = 1; // its own Drought
    const slot = torkoal.moves.indexOf(moveName);
    const m = test.fresh(unit, 0, true);
    const target = { u: foe, k: foe.kit || {}, mon: foe.mon, grounded: true };
    const out = {};
    for (const hp of [1, 0.75, 0.5, 0.25, 0.1]) {
      m.hp = hp;
      out[hp] = test.hitOn(m, target, slot, board, false).frac;
    }
    return out;
  };
  const flat = read(0, "Eruption");
  const scaled = read(1, "Eruption");
  check("version 0 is the defect: Eruption is full power at any HP",
    flat[1] === flat[0.5] && flat[1] === flat[0.1], JSON.stringify(flat));
  check("version 1 keeps a HEALTHY attacker's number byte-identical", scaled[1] === flat[1], `${scaled[1]} vs ${flat[1]}`);
  check("version 1 weakens it as its user is hurt",
    scaled[0.75] < scaled[1] && scaled[0.5] < scaled[0.75] && scaled[0.25] < scaled[0.5] && scaled[0.1] < scaled[0.25],
    JSON.stringify(scaled));
  // Roughly proportional: at half HP it is about half, which is what the move does.
  check("and about proportionally: half the HP is about half the damage",
    Math.abs(scaled[0.5] / scaled[1] - 0.5) < 0.06, `${(scaled[0.5] / scaled[1]).toFixed(4)}`);
  // A move that does NOT read its user's HP must not move at all.
  const plainOff = read(0, "Weather Ball");
  const plainOn = read(1, "Weather Ball");
  check("a move that does not read its user's HP is untouched by the rule",
    plainOff[0.1] === plainOn[0.1] && plainOff[1] === plainOn[1], `${plainOff[0.1]} vs ${plainOn[0.1]}`);
}

// --- 5. the repeat Protect ----------------------------------------------------------------------
// Counted inside the games, because the headline alone cannot tell the rule from noise: it takes the
// free refusal off BOTH sides at once.
{
  const count = async (guardRule) => {
    const test = makeTest({ depthRule: 2, guardRule });
    let protects = 0;
    let repeats = 0;
    const orig = test.plannedTurn.bind(test);
    test.plannedTurn = (active, board, slower, turn, events, stances) => {
      const r = orig(active, board, slower, turn, events, stances);
      for (const side of active) {
        for (const m of side) {
          if (!m || !m.guard) continue;
          protects += 1;
          if (m.guardedLast) repeats += 1;
        }
      }
      return r;
    };
    const out = await test.run(sets(), { limit: 8 });
    return { protects, repeats, average: out.average };
  };
  const free = await count(0);
  const ruled = await count(1);
  check("version 0 lets a Pokémon protect two turns running, and often", free.repeats > 0 && free.repeats / free.protects > 0.1,
    `${free.repeats} of ${free.protects} Protects`);
  check("version 1 leaves not one of them", ruled.repeats === 0, `${ruled.repeats} of ${ruled.protects} Protects`);
  check("and it is the repeats it takes away, not Protect itself", ruled.protects > 0 && ruled.protects < free.protects,
    `${free.protects} -> ${ruled.protects}`);
  // `guardedLast` has to be set before `guard` is cleared, or the rule reads a blank and does nothing.
  const test = makeTest();
  const unit = test.prepare(test.ourUnit(makeSet(TEAM[0]), 0));
  const m = test.fresh(unit, 0, true);
  check("a fresh Pokémon has not protected yet", m.guardedLast === false);
  m.guard = true;
  test.refill([[m], [null]], [[m], []], [1, 0], test.freshBoard());
  check("refill remembers the Protect it clears", m.guardedLast === true && m.guard === false, `${m.guardedLast} / ${m.guard}`);
  test.refill([[m], [null]], [[m], []], [1, 0], test.freshBoard());
  check("and forgets it the turn after", m.guardedLast === false);
  // The stance search must not hand out a Protect the turn itself would refuse.
  const plan = [{ m, s: 0, kind: 6, pr: 0, sp: 0, value: 1, target: null, hit: null, slot: 0, move: "Psychic" }];
  m.guardedLast = true;
  test.applyStance(plan, 1, [[m], []], test.freshBoard());
  check("STANCE_GUARD skips a Pokémon that protected last turn", plan[0].move !== "Protect", plan[0].move);
  m.guardedLast = false;
  test.applyStance(plan, 1, [[m], []], test.freshBoard());
  check("and gives it Protect when it did not", plan[0].move === "Protect", plan[0].move);
}

// --- 6. the variable-power attacks --------------------------------------------------------------
{
  const named = ["Low Kick", "Grass Knot", "Heavy Slam", "Heat Crash", "Gyro Ball", "Electro Ball", "Reversal", "Flail", "Beat Up", "Hard Press", "Fling"];
  const on = makeTest({ varPowerRule: 1 });
  const offTest = makeTest({ varPowerRule: 0 });
  check("the move table really lists all eleven at 0 power",
    named.every((n) => Math.trunc(Number(on.ev.meta(n).power) || 0) === 0), named.filter((n) => Math.trunc(Number(on.ev.meta(n).power) || 0) !== 0).join(", "));
  check("version 0 treats every one of them as no attack at all",
    named.every((n) => offTest.moveInfo(n).attack === false), named.filter((n) => offTest.moveInfo(n).attack).join(", "));
  check("version 1 makes every one of them an attack",
    named.every((n) => on.moveInfo(n).attack === true), named.filter((n) => !on.moveInfo(n).attack).join(", "));
  // A NAMED set, not a relaxation: the power>0 test is also what keeps status moves out.
  const statuses = ["Protect", "Trick Room", "Tailwind", "Spore", "Taunt", "Helping Hand", "Wide Guard", "Encore", "Will-O-Wisp", "Follow Me"];
  check("and nothing else: a status move is no attack under either version",
    statuses.every((n) => on.moveInfo(n).attack === false && offTest.moveInfo(n).attack === false),
    statuses.filter((n) => on.moveInfo(n).attack).join(", "));
  check("a move with a listed power is untouched by the rule",
    ["Close Combat", "Body Press", "Make It Rain"].every((n) => on.moveInfo(n).attack === offTest.moveInfo(n).attack && on.moveInfo(n).varPower === false));
  // And the nine the engine can price really do damage now. Beat Up reads the user's party and Fling
  // its held item, neither of which is on this board, so those two stay at 0 -- they are named so the
  // rule covers them the day the engine can price them, and the suite says which is which.
  const priced = [["Low Kick", "Machamp"], ["Grass Knot", "Venusaur"], ["Heavy Slam", "Steelix"], ["Heat Crash", "Emboar"], ["Gyro Ball", "Forretress"], ["Electro Ball", "Raichu"], ["Reversal", "Machamp"], ["Flail", "Tauros"], ["Hard Press", "Archaludon"]];
  const foe = on.opponentMon({ species: "Snorlax", form: "", item: "Sitrus Berry", ability: "Thick Fat", nature: "Careful", moves: ["Body Slam", "Protect", "Yawn", "Curse"] });
  const target = { u: foe, k: foe.kit || {}, mon: foe.mon, grounded: true };
  const board = on.freshBoard();
  const fracOf = (test, moveName, species) => {
    const set = makeSet({ species, item: "Life Orb", ability: "", nature: "Adamant", moves: [moveName, "Protect", "Protect", "Protect"], bonuses: [32, 32, 0, 0, 2, 0] });
    const m = test.fresh(test.ourUnit(set, 0), 0, true);
    return test.hitOn(m, target, 0, board, false).frac;
  };
  const dead = priced.filter(([moveName, species]) => !(fracOf(on, moveName, species) > 0));
  check("the nine the engine can price all do damage", dead.length === 0, dead.map(([m]) => m).join(", "));
  check("Beat Up and Fling are named but still price at nothing, so the rule costs nothing there",
    fracOf(on, "Beat Up", "Weavile") === 0 && fracOf(on, "Fling", "Weavile") === 0);
  // And under version 0 the same Pokémon has no attack to reach for.
  const machamp = makeSet({ species: "Machamp", item: "Life Orb", ability: "Guts", nature: "Adamant", moves: ["Low Kick", "Protect", "Protect", "Protect"], bonuses: [32, 32, 0, 0, 2, 0] });
  check("version 0 leaves a Pokémon whose only attack is Low Kick with nothing to do",
    offTest.prepare(offTest.ourUnit(machamp, 0)).attacks.length === 0
    && on.prepare(on.ourUnit(machamp, 0)).attacks.length === 1);
}

console.log(`\n${checked} checked, ${failures.length} failed.`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
