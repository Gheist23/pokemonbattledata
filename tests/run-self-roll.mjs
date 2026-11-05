// What a move costs its own user is charged IN FULL when it lands (TOURNAMENT_SELF_ROLL).
//
// THE FINDING, measured 4 Nov 2026 from a real /play/ turn the user reported: a meta Mimikyu
// holds LIFE ORB. It used Play Rough -- 90% accurate -- and was charged 0.1 * 0.9 = 9% of its
// own HP instead of 10%. With a Disguise absorbing an Armor Cannon (-12.5%) and Grassy Terrain
// healing it (+6.25%) it stood at 84.75%, shown as 85%, where the game has it at 83.75% -- 84%.
// The Disguise was never the bug; the item was being discounted.
//
// The cause: `hit.self` is an EXPECTATION, the share times `rate` (accuracy AND cooldown). That
// is right for the Tournament Test, which fires every move every turn and rolls nothing. It is
// wrong for an engine that rolls, and both live ones do -- `Solver.rollDamage` rolls `hit.odds`
// (which IS `rate`) and returns 0 on a miss, so `deal` returns false and no owe site is even
// reached. A miss already cost nothing; a LANDED hit was discounted for missing anyway.
//
// Every Life Orb holder in /play/ and on the Solver board was paying 0.9x-0.99x of its item, and
// a recoil move the same. `selfFull` is the share with no `rate` in it, and `selfShare` is the
// one reader all five owe sites go through.
//
//   node tests/run-self-roll.mjs
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
import { TournamentTest, TOURNAMENT_SELF_ROLL, tournamentSelfRollOption } from "../builder/tournament-test.js";
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

function makeSolver(selfRollRule) {
  const ev = new TeamEvaluator(data, new DamageEngine(appData), FORMAT,
    normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Solver(new TournamentTest(evaluation, new KnownTeams(knownRaw),
    new TeamSuggestions(evaluation),
    { effects, liveHpRule: 1, abilityOpsRule: 1, shieldRule: 1, selfRollRule }));
}
function setFor(species, extra = {}) {
  for (const r of meta.pokemon) {
    if (String(r.species).toLowerCase() !== species.toLowerCase()) continue;
    const base = data.commonSet(FORMAT, r.species, r.form);
    if (base && base.moves?.length) return makeSet({ ...base, moves: [...base.moves], ...extra });
  }
  return null;
}
const withMove = (set, move) =>
  makeSet({ ...set, moves: [move, ...set.moves.filter((n) => n !== move)].slice(0, 4) });
const row = (set, extra = {}) => ({ set, hp: 100, front: false, ...extra });
function board(rule, lead, foeSet) {
  const solver = makeSolver(rule);
  const state = solver.buildState({
    sides: [[row(lead, { front: true }), row(foeSet, { front: true })],
      [row(foeSet, { front: true }), row(foeSet, { front: true })]],
    field: {},
  });
  return { solver, state, me: state.active[0][0], foe: state.active[1][0] };
}

/* ------------------------------------------------- 1. the rule, and the reader */
{
  ok("TOURNAMENT_SELF_ROLL is 0", TOURNAMENT_SELF_ROLL === 0, String(TOURNAMENT_SELF_ROLL));
  ok("an older recording replays with it off", tournamentSelfRollOption(null) === 0);
  ok("and production asks for 1", tournamentSelfRollOption(1) === 1);
}

/* ------------------------------------------------- 2. the user's own Mimikyu */
const mimikyu = setFor("Mimikyu");
const armarouge = setFor("Armarouge");
{
  ok("the meta Mimikyu is the one the user met", mimikyu && mimikyu.item === "Life Orb",
    JSON.stringify(mimikyu && { ability: mimikyu.ability, item: mimikyu.item }));
  ok("and it is a Disguise set", mimikyu && mimikyu.ability === "Disguise", mimikyu?.ability);
  notes.push(`meta Mimikyu: ${mimikyu?.ability} / ${mimikyu?.item} / ${mimikyu?.moves?.join(", ")}`);
}

/* ------------------------------------------------- 3. the hit row carries both shares */
{
  const lead = withMove(mimikyu, "Play Rough");
  const { solver, state, me, foe } = board(1, lead, armarouge);
  const slot = me.u.moves.findIndex((i) => i?.key === "playrough");
  ok("the lead really has Play Rough", slot >= 0, String(slot));
  if (slot >= 0) {
    const h = solver.t.hitOn(me, foe, slot, state.board, false, me);
    ok("the discounted share is on the row", h.self > 0, String(h.self));
    ok("the undiscounted one too", h.selfFull > 0, String(h.selfFull));
    // Life Orb takes floor(maxHP / 10) HP, so its share is a shade UNDER a tenth -- the game
    // floors it too, and 16 of this Mimikyu's 162 is 0.0988.
    ok("Life Orb costs about a tenth, undiscounted",
      h.selfFull > 0.095 && h.selfFull <= 0.1, String(h.selfFull));
    ok("and the discount really was the accuracy", Math.abs(h.self - h.selfFull * h.odds) < 1e-12,
      `${h.self} vs ${h.selfFull * h.odds}`);
    ok("so the rule is worth exactly the tenth of the item it was losing",
      Math.abs(h.selfFull - h.self - h.selfFull * 0.1) < 1e-12, String(h.selfFull - h.self));
    ok("which is Play Rough's 90%", Math.abs(h.odds - 0.9) < 1e-9, String(h.odds));
    notes.push(`Play Rough w/ Life Orb: self ${h.self.toFixed(4)}, selfFull ${h.selfFull.toFixed(4)}, odds ${h.odds}`);
  }
}

/* ------------------------------------------------- 4. selfShare picks by the rule */
{
  const lead = withMove(mimikyu, "Play Rough");
  for (const rule of [0, 1]) {
    const { solver, state, me, foe } = board(rule, lead, armarouge);
    const slot = me.u.moves.findIndex((i) => i?.key === "playrough");
    if (slot < 0) continue;
    const h = solver.t.hitOn(me, foe, slot, state.board, false, me);
    const want = rule === 1 ? h.selfFull : h.self;
    ok(`rule ${rule}: selfShare returns the right one`,
      Math.abs(solver.t.selfShare(h) - want) < 1e-12,
      `${solver.t.selfShare(h)} vs ${want}`);
    ok(`rule ${rule}: and the flag agrees`, solver.t.selfRollOn === (rule === 1));
  }
  ok("selfShare survives no hit at all", makeSolver(1).t.selfShare(null) === 0);
}

/* ------------------------------------------------- 5. and it reaches the Pokemon's HP */
{
  const lead = withMove(mimikyu, "Play Rough");
  const paid = {};
  for (const rule of [0, 1]) {
    const { solver, state, me, foe } = board(rule, lead, armarouge);
    const slot = me.u.moves.findIndex((i) => i?.key === "playrough");
    if (slot < 0) continue;
    // Land it for certain: no roll, just the expected hit, so only the owed share can differ.
    solver.t.rollHit = (hit) => hit.frac;
    const h = solver.t.hitOn(me, foe, slot, state.board, false, me);
    solver.t.deal(me, foe, h, null, false, null, state.active[0], state.board);
    solver.t.oweSelf(me, solver.t.selfShare(h));
    const before = me.hp;
    solver.t.endOfTurn(state.active, state.board);
    paid[rule] = before - me.hp;
  }
  ok("with the rule off the Life Orb is discounted by the accuracy",
    Math.abs(paid[0] - paid[1] * 0.9) < 1e-6, `${paid[0]} vs ${paid[1] * 0.9}`);
  ok("with it on the holder pays the item in full",
    paid[1] > 0.095 && paid[1] <= 0.1, String(paid[1]));
  ok("and that really is more than it used to pay", paid[1] > paid[0] + 0.009,
    `${paid[1]} vs ${paid[0]}`);
  notes.push(`Life Orb paid: rule 0 ${(paid[0] * 100).toFixed(2)}%, rule 1 ${(paid[1] * 100).toFixed(2)}%`);
}

/* ------------------------------------------------- 6. a miss still costs nothing */
{
  const lead = withMove(mimikyu, "Play Rough");
  const { solver, state, me, foe } = board(1, lead, armarouge);
  const slot = me.u.moves.findIndex((i) => i?.key === "playrough");
  if (slot >= 0) {
    solver.t.rollHit = () => 0;                       // a miss, exactly as rollDamage reports one
    const h = solver.t.hitOn(me, foe, slot, state.board, false, me);
    const landed = solver.t.deal(me, foe, h, null, false, null, state.active[0], state.board);
    ok("a miss does not land", landed === false, String(landed));
    if (!landed) {
      const before = me.hp;
      solver.t.endOfTurn(state.active, state.board);
      ok("and owes no Life Orb", Math.abs(before - me.hp) < 1e-9, String(before - me.hp));
    }
  }
}

/* ------------------------------------------------- 7. the whole turn the user saw */
{
  // 100% -> Disguise absorbs the Armor Cannon -> its own Life Orb -> Grassy Terrain heals.
  const disguise = 0.125, orb = 16 / 162, grassy = 1 / 16;   // 16 of this Mimikyu's 162 HP
  const withRule = 1 - disguise - orb + grassy;
  const without = 1 - disguise - orb * 0.9 + grassy;
  ok("the old number is the 85% the user saw", Math.round(without * 100) === 85,
    `${(without * 100).toFixed(2)}%`);
  ok("and the fixed one is the game's 84%", Math.round(withRule * 100) === 84,
    `${(withRule * 100).toFixed(2)}%`);
  notes.push(`the reported turn: was ${(without * 100).toFixed(2)}% (85%), now ${(withRule * 100).toFixed(2)}% (84%)`);
}

/* ------------------------------------------------- 8. nothing reads the raw share any more */
{
  const src = readFileSync(join(root, "builder", "tournament-test.js"), "utf8");
  const code = src.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
  // `selfShare`'s own body is the one place allowed to read it.
  const raw = code.filter((l) => /\b(h|hit|fakeHit)\.self\b/.test(l) && !/selfRollOn/.test(l));
  ok("every owe site goes through selfShare, none reads hit.self", raw.length === 0,
    JSON.stringify(raw.map((l) => l.trim())));
  const shares = code.filter((l) => /this\.selfShare\(/.test(l));
  ok("and there are the five of them", shares.length === 5, String(shares.length));
  ok("selfFull is published exactly once", code.filter((l) => /selfFull =/.test(l)).length === 1);
}

/* ------------------------------------------------- 9. the wiring */
{
  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  const built = worker.match(/new TournamentTest\([\s\S]*?\);/g) || [];
  ok("both live engines ask for the rule",
    built.filter((c) => /selfRollRule:\s*1/.test(c)).length === 2,
    String(built.filter((c) => /selfRollRule:\s*1/.test(c)).length));
  ok("and the recorded Tournament Test does not", built.some((c) => !/selfRollRule/.test(c)));
}

for (const note of notes) console.log(`   ${note}`);
console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
