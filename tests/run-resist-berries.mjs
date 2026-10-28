// A type resistance berry halves ONE hit (TOURNAMENT_RBERRY).
//
// THE BUG. The 18 resistance berries are applied by the damage engine from the defender's item,
// and the turn engine never took one away: a Chople Berry holder took half from every Fighting
// move for the whole game, where the game gives it half from one. Measured, three Close Combats
// into the same holder: 85.27%, 85.27%, 85.27% -- against 170.54% for the same Pokemon with no
// berry. After Sitrus these are the most carried berries in the format (Chople 293 usage points,
// Colbur 292, Shuca 195, Occa 133, Roseli 114, around 1,030 together), so this was the largest
// berry defect left.
//
// HOW THE UN-HALVED NUMBER IS ASKED FOR. The engine halves from `defender.item`, so `calc` hands
// it a defender with no item once the berry is gone -- safe, because a Pokemon holding a
// resistance berry holds nothing else. It needs a second damage store, for the reason Charge's
// Electric Boost needed one: the cache key is already past the integer range a double holds
// exactly and cannot take another factor.
//
// What is checked here:
//
//   1. the rule is 0 by default, and under rule 0 every hit is halved exactly as before;
//   2. under rule 1 the FIRST hit is halved and the rest are not;
//   3. the un-halved number is EXACT -- equal to the same Pokemon holding no berry, not an
//      approximation of it, which is the whole point of asking the engine rather than doubling;
//   4. the berry answers only its own type, and only a super-effective hit (Chilan excepted);
//   5. `hit.rberry` comes from the damage engine, so the turn engine consults no type chart;
//   6. it survives a round trip through a described board.
//
//   node tests/run-resist-berries.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, RESIST_BERRIES } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest, TOURNAMENT_RBERRY, tournamentRberryOption } from "../builder/tournament-test.js";
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

function makeSolver(rberryRule) {
  const engine = new DamageEngine(appData);
  const ev = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Solver(new TournamentTest(evaluation, new KnownTeams(knownRaw),
    new TeamSuggestions(evaluation), { effects, liveHpRule: 1, rberryRule }));
}

const set = (species, item, ability, nature, moves, bonuses) =>
  ({ species, form: species, item, ability, nature, moves, bonuses: [...bonuses] });
const ATTACKER = set("Machamp", "Life Orb", "No Guard", "Adamant",
  ["Close Combat", "Knock Off", "Protect", "Bullet Punch"], [2, 32, 0, 0, 0, 32]);
/** Incineroar is Fire/Dark, so Fighting is super-effective on it and Chople answers. */
const CHOPLE = set("Incineroar", "Chople Berry", "Intimidate", "Adamant",
  ["Fake Out", "Knock Off", "Flare Blitz", "Protect"], [32, 32, 2, 0, 0, 0]);
const WRONG_TYPE = set("Incineroar", "Occa Berry", "Intimidate", "Adamant",
  ["Fake Out", "Knock Off", "Flare Blitz", "Protect"], [32, 32, 2, 0, 0, 0]);
const NO_BERRY = set("Incineroar", "Leftovers", "Intimidate", "Adamant",
  ["Fake Out", "Knock Off", "Flare Blitz", "Protect"], [32, 32, 2, 0, 0, 0]);
const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });

function stand(rberryRule, theirSets) {
  const solver = makeSolver(rberryRule);
  const state = solver.buildState({
    sides: [[row(ATTACKER, { front: true }), row(ATTACKER, { front: true })],
      theirSets.map((s) => row(s, { front: true }))],
    field: {},
  });
  const a = state.active[0][0];
  const slot = a.u.moves.findIndex((m) => m && /close combat/i.test(m.name || ""));
  return { solver, state, a, slot };
}

/** Three hits into the same target, as percentages, with the berry eaten along the way. */
function threeHits(solver, a, target, slot, board) {
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    const hit = solver.t.hitOn(a, target, slot, board);
    out.push({ pct: Number((hit.frac * 100).toFixed(2)), flagged: Boolean(hit.rberry), left: target.rberry });
    solver.t.deal(a, target, hit, null);
    // Put it back on its feet so the next hit is comparable; only the berry carries over.
    target.hp = 1;
    target.took = 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. the table, the rule, and rule 0
// ---------------------------------------------------------------------------
{
  ok("all 18 resistance berries are in the shared table", Object.keys(RESIST_BERRIES).length === 18,
    String(Object.keys(RESIST_BERRIES).length));
  ok("TOURNAMENT_RBERRY is 0", TOURNAMENT_RBERRY === 0, String(TOURNAMENT_RBERRY));
  ok("the option reader turns it off for an older recording",
    tournamentRberryOption(null) === 0 && tournamentRberryOption(1) === 1);
  ok("an engine built with the default has it off", makeSolver(undefined).t.resistBerryOn === false);

  const { solver, state, a, slot } = stand(0, [CHOPLE, NO_BERRY]);
  const ch = state.active[1][0];
  ok("the kit reads the berry's type off the shared table", ch.k.rberry === "Fighting", ch.k.rberry);
  ok("and the row starts with it uneaten", ch.rberry === true);
  const hits = threeHits(solver, a, ch, slot, state.board);
  ok("rule 0: every hit is halved", hits.every((h) => h.pct === hits[0].pct),
    JSON.stringify(hits.map((h) => h.pct)));
  ok("rule 0: and the berry is never eaten", hits.every((h) => h.left === true));
  notes.push(`rule 0: ${hits.map((h) => `${h.pct}%`).join(", ")}`);
}

// ---------------------------------------------------------------------------
// 2-3. under rule 1: the first hit only, and the exact number after
// ---------------------------------------------------------------------------
{
  const { solver, state, a, slot } = stand(1, [CHOPLE, NO_BERRY]);
  const ch = state.active[1][0];
  const plain = state.active[1][1];
  const bare = Number((solver.t.hitOn(a, plain, slot, state.board).frac * 100).toFixed(2));
  const hits = threeHits(solver, a, ch, slot, state.board);

  ok("rule 1: the first hit is halved", hits[0].pct < bare, `${hits[0].pct} vs ${bare}`);
  ok("and halved is half", Math.abs(hits[0].pct * 2 - bare) <= 0.02, `${hits[0].pct} x2 vs ${bare}`);
  ok("rule 1: the second is not", hits[1].pct > hits[0].pct, `${hits[1].pct} vs ${hits[0].pct}`);
  ok("nor the third", hits[2].pct === hits[1].pct, `${hits[2].pct} vs ${hits[1].pct}`);
  ok("the berry is gone after the hit it halved",
    hits[0].left === true && hits[1].left === false && hits[2].left === false,
    JSON.stringify(hits.map((h) => h.left)));

  // EXACT, not approximate. This is the whole reason the engine is asked for the number with the
  // item cleared rather than the halved number being doubled: doubling would land within a point
  // and this lands ON it.
  ok("the un-halved number is exactly the no-berry number", hits[1].pct === bare,
    `${hits[1].pct} vs ${bare}`);
  notes.push(`rule 1: ${hits.map((h) => `${h.pct}%`).join(", ")} (no berry: ${bare}%)`);
}

// ---------------------------------------------------------------------------
// 4-5. only its own type, and the flag comes from the engine
// ---------------------------------------------------------------------------
{
  const { solver, state, a, slot } = stand(1, [WRONG_TYPE, NO_BERRY]);
  const occa = state.active[1][0];
  const plain = state.active[1][1];
  ok("an Occa Berry answers Fire", occa.k.rberry === "Fire", occa.k.rberry);
  const hit = solver.t.hitOn(a, occa, slot, state.board);
  const bare = solver.t.hitOn(a, plain, slot, state.board);
  ok("so a Fighting move is not halved by it",
    Number((hit.frac * 100).toFixed(2)) === Number((bare.frac * 100).toFixed(2)),
    `${hit.frac} vs ${bare.frac}`);
  ok("and the engine does not flag it", hit.rberry === false, String(hit.rberry));
  solver.t.deal(a, occa, hit, null);
  ok("so the berry is not eaten", occa.rberry === true);

  // The flag is the damage engine's answer, not a type chart in the turn engine.
  const engineSource = readFileSync(join(root, "builder", "engine.js"), "utf8");
  ok("engine.js reports whether the berry halved the hit",
    /resist_berry_active: resistBerryUsed/.test(engineSource));
  const turnSource = readFileSync(join(root, "builder", "tournament-test.js"), "utf8");
  ok("and the hit carries it through", /rberry: Boolean\(result\.resist_berry_active\)/.test(turnSource));
  ok("deal eats the berry on the flagged hit",
    /if \(this\.resistBerryOn && hit\.rberry && target\.rberry\) target\.rberry = false;/.test(turnSource));
  ok("there are four damage stores, two bits",
    /this\.spentBerryHits = new Map\(\);/.test(turnSource)
    && /this\.chargedSpentBerryHits = new Map\(\);/.test(turnSource));
  ok("and the spent defender is handed over with no item", /if \(spentBerry\) defender\.item = "";/.test(turnSource));
}

// ---------------------------------------------------------------------------
// 6. a described board
// ---------------------------------------------------------------------------
{
  const solver = makeSolver(1);
  const state = solver.buildState({
    sides: [[row(ATTACKER, { front: true }), row(ATTACKER, { front: true })],
      [row(CHOPLE, { front: true, rberry: false }), row(CHOPLE, { front: true })]],
    field: {},
  });
  const a = state.active[0][0];
  const eaten = state.active[1][0];
  const whole = state.active[1][1];
  const slot = a.u.moves.findIndex((m) => m && /close combat/i.test(m.name || ""));
  ok("a board can say the berry is already eaten", eaten.rberry === false);
  ok("and one that says nothing hands it over whole", whole.rberry === true);
  const eatenHit = solver.t.hitOn(a, eaten, slot, state.board);
  const wholeHit = solver.t.hitOn(a, whole, slot, state.board);
  ok("so the eaten one takes full damage", eatenHit.frac > wholeHit.frac,
    `${eatenHit.frac} vs ${wholeHit.frac}`);

  const play = readFileSync(join(root, "builder", "play-game.js"), "utf8");
  ok("the row carries it out", /rberry: Boolean\(m\.rberry\),/.test(play));
  ok("and an eaten one shows itself", /was\.rberry && !m\.rberry/.test(play));
  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  ok("the played game asks for the rule at both sites",
    (worker.match(/rberryRule: 1/g) || []).length === 2);
}

// ---------------------------------------------------------------------------

if (notes.length) notes.forEach((n) => console.log(`  ${n}`));
if (failures.length) {
  failures.forEach((f) => console.log(`FAIL ${f}`));
  console.log(`${checked} checked, ${failures.length} failed.`);
  process.exit(1);
}
console.log(`${checked} checked, 0 failed.`);
