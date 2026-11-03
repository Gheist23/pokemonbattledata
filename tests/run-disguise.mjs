// Mimikyu's Disguise in the turn engine (TOURNAMENT_SHIELD).
//
// THE FINDING. A Mimikyu in /play/ took the first hit in full. The Companion has modelled
// Disguise since the effect registry shipped -- `first_damage_shield` in
// `mcts/data/ability_effects.json`, read by `mcts/engine.py _survival_adjust_damage` -- but the
// op was not on the exporter's WEB_ABILITY_OPS whitelist, so the website was never sent it:
// `move-effects.json` carried 60 Abilities and Disguise was not one of them. Mimikyu therefore
// reached the website as an Ability with no effects at all. Reported 3 Nov 2026.
//
// That is the shape the whitelist produces every time: a mechanic the app has had for months is
// missing on the website because of a one-line list, not because of any difference in the
// engines. This suite checks BOTH halves -- that the op is shipped and that it is read.
//
// What is checked:
//
//   1. Mimikyu's own set really has the Ability, and the shipped registry carries its op;
//   2. with the rule off the first hit lands in full -- the A/B that proves the rule is doing it;
//   3. with the rule on the first hit costs exactly an eighth of the maximum, whatever the move
//      would have done, and the SECOND one lands in full;
//   4. a Mimikyu already below an eighth goes down to the hit that breaks the disguise, which is
//      how the Companion caps it (`min(before, hp_cost_fraction)`) and how the game plays it;
//   5. the disguise is spent once per Pokemon, not once per turn;
//   6. a Pokemon without the Ability is untouched, and so is a Focus Sash holder -- Disguise
//      runs first, so the sash is still unspent afterwards;
//   7. both engines a person plays against -- the game's and the Solver's -- ask for the rule,
//      while the Tournament Test proper, which the recorded vectors pin, does not.
//
//   node tests/run-disguise.mjs
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
import { TournamentTest, TOURNAMENT_SHIELD, tournamentShieldOption } from "../builder/tournament-test.js";
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
const data = new BuilderData(appData);
data.ingestMeta("Doubles", meta);

function makeSolver(shieldRule) {
  const engine = new DamageEngine(appData);
  const ev = new TeamEvaluator(data, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Solver(new TournamentTest(evaluation, new KnownTeams(knownRaw),
    new TeamSuggestions(evaluation), { effects, liveHpRule: 1, shieldRule }));
}

const MIMIKYU = data.commonSet("Doubles", "Mimikyu", "Mimikyu");
const OTHER = data.commonSet("Doubles", "Garchomp", "Garchomp");
const row = (s, extra = {}) => ({ set: makeSet({ ...s, moves: [...s.moves] }), hp: 100, front: false, ...extra });
/** A landed hit of exactly `frac` of the target's max HP, so the share is the only variable. */
const hit = (frac) => ({ slot: 0, frac, lo: frac, hi: frac, odds: 1, rollLo: frac, rollHigh: frac,
  priority: 0, spread: false, self: 0, rberry: false });

function board(shieldRule, { hp = 100, item = null } = {}) {
  const solver = makeSolver(shieldRule);
  const mine = item === null ? MIMIKYU : { ...MIMIKYU, item };
  const ours = [row(mine, { front: true, hp }), row(OTHER, { front: true })];
  const state = solver.buildState({
    sides: [ours, [row(OTHER, { front: true }), row(OTHER, { front: true })]],
    field: {},
  });
  return { solver, state, mimikyu: state.active[0][0], foe: state.active[1][0] };
}

const EIGHTH = 0.125;

/* -------------------------------------------- 1. the Ability, and the op being shipped */
{
  ok("Mimikyu's own set really has the Ability", /disguise/i.test(MIMIKYU.ability), MIMIKYU.ability);
  ok("TOURNAMENT_SHIELD is 0", TOURNAMENT_SHIELD === 0, String(TOURNAMENT_SHIELD));
  ok("the option reader turns it off for an older recording",
    tournamentShieldOption(null) === 0 && tournamentShieldOption(1) === 1);
  // The half that was actually missing: the registry on disk.
  ok("the exporter ships the op", (effects.abilityOps || []).includes("first_damage_shield"),
    (effects.abilityOps || []).join(","));
  const fx = (effects.abilities || {}).disguise || [];
  ok("and Disguise's own entry is in it", fx.some((e) => e.op === "first_damage_shield"), JSON.stringify(fx));
  const cost = fx.find((e) => e.op === "first_damage_shield")?.hp_cost_fraction;
  ok("costing an eighth, as the Companion has it", Math.abs(Number(cost) - EIGHTH) < 1e-9, String(cost));
  notes.push(`Mimikyu: ${MIMIKYU.ability}, ${(Number(cost) * 100).toFixed(1)}% of its maximum`);
}

/* -------------------------------------------- 2. with the rule off, the hit lands in full */
{
  const { solver, mimikyu, foe } = board(0);
  ok("the kit reads the Ability", mimikyu.k.shield === EIGHTH, String(mimikyu.k.shield));
  ok("an engine built with the default does not model it", solver.t.shieldOn === false);
  solver.t.deal(foe, mimikyu, hit(0.6), null);
  ok("rule 0: a 60% hit takes 60%", Math.abs(mimikyu.hp - 0.4) < 1e-9, String(mimikyu.hp));
  ok("rule 0: and nothing is marked broken", !mimikyu.busted);
}

/* -------------------------------------------- 3. with the rule on: an eighth, once */
{
  const { solver, mimikyu, foe } = board(1);
  ok("the engine models it", solver.t.shieldOn === true);
  solver.t.deal(foe, mimikyu, hit(0.6), null);
  ok("the first hit costs an eighth, not 60%", Math.abs(mimikyu.hp - (1 - EIGHTH)) < 1e-9, String(mimikyu.hp));
  ok("and the disguise is broken", mimikyu.busted === true);
  solver.t.deal(foe, mimikyu, hit(0.6), null);
  ok("the second hit lands in full", Math.abs(mimikyu.hp - (1 - EIGHTH - 0.6)) < 1e-9, String(mimikyu.hp));
  notes.push(`rule 1: two 60% hits leave ${(mimikyu.hp * 100).toFixed(1)}%, rule 0 would leave 0%`);
}

/* -------------------------------------------- 4. the cap, and a big hit */
{
  // Whatever the move would have done, the first one costs an eighth: a hit that would knock it
  // out twice over still only breaks the disguise.
  const { solver, mimikyu, foe } = board(1);
  solver.t.deal(foe, mimikyu, hit(3), null);
  ok("even a hit three times its HP only breaks the disguise",
    Math.abs(mimikyu.hp - (1 - EIGHTH)) < 1e-9, String(mimikyu.hp));
  ok("so it is still standing", mimikyu.out !== true);
}
{
  // ...but a Mimikyu already under an eighth goes down to the hit that breaks it, which is the
  // cap the Companion applies (`min(before, hp_cost_fraction)`).
  const { solver, mimikyu, foe } = board(1, { hp: 5 });
  ok("it starts under an eighth", mimikyu.hp < EIGHTH, String(mimikyu.hp));
  solver.t.deal(foe, mimikyu, hit(0.9), null);
  ok("the hit that breaks the disguise takes the rest", mimikyu.hp === 0 && mimikyu.out === true,
    `${mimikyu.hp} out=${mimikyu.out}`);
}

/* -------------------------------------------- 5. once per Pokemon, not once per turn */
{
  const { solver, mimikyu, foe } = board(1);
  for (let i = 0; i < 4; i += 1) solver.t.deal(foe, mimikyu, hit(0.1), null);
  // an eighth for the first, then three tenths
  const want = 1 - EIGHTH - 0.3;
  ok("four small hits spend the disguise exactly once",
    Math.abs(mimikyu.hp - want) < 1e-9, `${mimikyu.hp} want ${want}`);
}

/* -------------------------------------------- 6. everybody else, and the sash */
{
  const solver = makeSolver(1);
  const state = solver.buildState({
    sides: [[row(OTHER, { front: true }), row(OTHER, { front: true })],
      [row(OTHER, { front: true }), row(OTHER, { front: true })]],
    field: {},
  });
  const plain = state.active[0][0];
  ok("a Pokemon without the Ability has no shield", plain.k.shield === 0, String(plain.k.shield));
  solver.t.deal(state.active[1][0], plain, hit(0.6), null);
  ok("and takes the hit in full", Math.abs(plain.hp - 0.4) < 1e-9, String(plain.hp));
}
{
  // Disguise runs BEFORE the sash, because the hit does not land at all -- so the sash is still
  // there afterwards for the hit that would really have knocked it out.
  const { solver, mimikyu, foe } = board(1, { item: "Focus Sash" });
  ok("the Mimikyu is holding the sash", mimikyu.sash === true);
  solver.t.deal(foe, mimikyu, hit(3), null);
  ok("the disguise took the hit", mimikyu.busted === true && Math.abs(mimikyu.hp - (1 - EIGHTH)) < 1e-9,
    String(mimikyu.hp));
  ok("and the sash is unspent", mimikyu.sash === true);
}

/* -------------------------------------------- 7. who asks for the rule */
{
  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  const built = worker.match(/new TournamentTest\([\s\S]*?\);/g) || [];
  ok("the worker builds the three Tournament Tests it is known to", built.length === 3, String(built.length));
  const asking = built.filter((call) => /shieldRule:\s*1/.test(call));
  ok("two of them model Disguise: the played game and the Solver", asking.length === 2, String(asking.length));
  // `evaluation.tournament` is the Tournament Test proper and is pinned by the recorded parity
  // vectors, so it stays on the default -- the same split `effects`, `liveHpRule` and the rest use.
  const proper = built.find((call) => !/shieldRule/.test(call)) || "";
  ok("and the recorded Tournament Test is left on the default",
    /effects: await moveEffects\(\) \}\)/.test(proper), proper.replace(/\s+/g, " ").slice(0, 120));
}

for (const note of notes) console.log(`   ${note}`);
console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
