// THE FOUR MOVES THAT BUY WHAT THEY DO WITH HP, AND WHY ONE OP WAS NOT ENOUGH.
//
// `tests/run-op-coverage.mjs` ranked `hp_cost` as the top remaining reachable gap: Clangorous
// Soul is 45% of the Kommo-o in the current meta and the move could not be chosen at all,
// because `Solver.effectActions` refuses a status move unless EVERY one of its ops is runnable.
// Belly Drum, Fillet Away and Shed Tail were off the sheet for the same reason.
//
// It could not be fixed by making `hp_cost` runnable on its own, and that is the finding worth
// keeping. BELLY DRUM IS TWO OPS -- `hp_cost` and `set_stage` -- and the app's registry has
// carried both since it was compiled ("boost its Attack stat to its sixth stage" is the game's
// own wording). The WEBSITE had only the cost, because `tools/export_web_builder_data.py`'s
// whitelist shipped `hp_cost` and not `set_stage`. So a website that ran `hp_cost` would have
// put a move on the person's sheet that spends half a health bar for nothing whatever.
//
//   * `set_stage` is now whitelisted and exported, and this suite checks the DATA as well as the
//     engine, because the engine reading an op the data does not carry proves nothing.
//   * `set_stage` SETS the stage rather than adding to it: Belly Drum on a Pokemon already at +4
//     is worth two stages, not six, and at +6 it is worth none. A `stage` op cannot say that.
//   * the move FAILS when the user cannot pay, which both Belly Drum's and Clangorous Soul's own
//     text says in as many words. Without it the move knocked its own user out for a stat boost.
//   * the DAMAGING holders (Steel Beam, Mind Blown, Chloroblast) are charged by NAME in the
//     damage calculator and must NOT be charged again here. That is checked too, because taking
//     the half twice is the obvious way to get this wrong.
//
//   node tests/run-hp-cost.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, MAX_HP_RECOIL_FRACTIONS } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest, RUNNABLE_OPS, stageField } from "../builder/tournament-test.js";
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
const boardOf = (ours, theirs, field = {}) => ({ sides: [ours, theirs], field });

const DRUMMER = set("Azumarill", "", "Huge Power", "Adamant",
  ["Belly Drum", "Aqua Jet", "Play Rough", "Protect"], [32, 32, 0, 0, 2, 0]);
const SOUL = set("Kommo-o", "", "Overcoat", "Adamant",
  ["Clangorous Soul", "Close Combat", "Drain Punch", "Protect"], [32, 32, 0, 0, 2, 0]);
const WALL = set("Amoonguss", "", "Regenerator", "Calm",
  ["Spore", "Pollen Puff", "Rage Powder", "Protect"], [32, 0, 2, 0, 32, 0]);

// ---------------------------------------------------------------------------
// 1. THE DATA. An engine that reads an op the registry does not carry fixes nothing.
// ---------------------------------------------------------------------------

ok("the exported registry declares set_stage as an op it ships",
  (effects.moveOps || []).includes("set_stage"), (effects.moveOps || []).join(", "));
{
  const drum = effects.moves?.bellydrum || [];
  const ops = drum.map((fx) => fx.op);
  ok("Belly Drum carries its HP cost", ops.includes("hp_cost"), JSON.stringify(drum));
  // THE HALF THAT WAS MISSING. Without this Belly Drum is pure harm, which is why `hp_cost`
  // could not be made runnable until the whitelist learnt `set_stage`.
  ok("...AND the Attack it buys with it", ops.includes("set_stage"), JSON.stringify(drum));
  const setter = drum.find((fx) => fx.op === "set_stage");
  ok("...to the sixth stage, as its own text says", setter && Number(setter.value) === 6,
    JSON.stringify(setter));
  ok("...on its own Attack", setter && stageField(setter.value === 6 ? setter.stat : "") === "atk",
    JSON.stringify(setter));
}
ok("both ops are runnable, so a move carrying them can be chosen",
  RUNNABLE_OPS.has("hp_cost") && RUNNABLE_OPS.has("set_stage"));
// THE THREE `ally` TARGETS, which the same re-export would have quietly changed to `ally_side`.
// Coaching, Dragon Cheer and Gear Up say "allies" and not "the user and its allies", so they do
// not reach the Pokemon that used them -- the engine's own note on `effectTargets` records a
// Coaching having boosted its own user once already.
for (const [key, op] of [["coaching", "stage"], ["dragoncheer", "crit_stage"], ["gearup", "stage"]]) {
  const entry = (effects.moves?.[key] || []).find((fx) => fx.op === op);
  ok(`${key} reaches an ALLY and not the whole side`, entry && entry.target === "ally",
    JSON.stringify(entry));
}
ok("...while Howl, whose text does say \"the user and its allies\", reaches the side",
  (effects.moves?.howl || []).some((fx) => fx.target === "ally_side"),
  JSON.stringify(effects.moves?.howl));

// ---------------------------------------------------------------------------
// 2. THE MOVES ARE ON THE SHEET
// ---------------------------------------------------------------------------

function offered(aSet, hp = 100, { forSearch = false } = {}) {
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(aSet, { front: true, hp }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  return s.slotCandidates(state, 0, 0, forSearch ? {} : { cap: 0 }).map((a) => a.move).filter(Boolean);
}

ok("Belly Drum is offered at full health", offered(DRUMMER, 100).includes("Belly Drum"),
  offered(DRUMMER, 100).join(", "));
ok("Clangorous Soul is offered at full health", offered(SOUL, 100).includes("Clangorous Soul"),
  offered(SOUL, 100).join(", "));
// AND NOT WHEN IT CANNOT BE PAID FOR. The search prices the cost, so it drops the move itself;
// the person's own sheet keeps every legal move and the engine refuses it when it runs.
ok("the search does not take Belly Drum at half health or less",
  !offered(DRUMMER, 40, { forSearch: true }).includes("Belly Drum"),
  offered(DRUMMER, 40, { forSearch: true }).join(", "));

// ---------------------------------------------------------------------------
// 3. AND THEY DO WHAT THEY SAY
// ---------------------------------------------------------------------------

/** Run one move's ops as a PLAYED turn, from a given starting HP and Attack stage. */
function runMove(aSet, move, { hp = 100, atk = 0 } = {}) {
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(aSet, { front: true, hp, atk }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  const m = state.active[0][0];
  const slot = m.u.moves.findIndex((mv) => mv && mv.name === move);
  if (slot < 0) return { missing: true, m, s, state };
  const ops = m.u.moves[slot].fx || [];
  s.t.effectRoll = () => 0;
  const out = s.t.runEffectOps(m, state.active[1][0], { slot, ops }, state.active, [], state.board);
  s.t.effectRoll = null;
  return { out, m, s, state, ops };
}

{
  const { m, out, ops } = runMove(DRUMMER, "Belly Drum", { hp: 100 });
  ok("Belly Drum's ops reach the engine", (ops || []).length === 2, JSON.stringify(ops));
  near("Belly Drum spends half a health bar", m.hp, 0.5, 1e-9);
  ok("...and maximises its Attack", m.atk === 6, String(m.atk));
  ok("...and says it did both", (out.did || []).length === 2, JSON.stringify(out.did));
}
{
  // SETS, NOT ADDS. From +4 the step is two, and the stage lands on six either way -- which is
  // the whole reason the registry has a word for it that `stage` cannot express.
  const { m } = runMove(DRUMMER, "Belly Drum", { hp: 100, atk: 4 });
  ok("Belly Drum from +4 still lands on +6, not +10", m.atk === 6, String(m.atk));
}
{
  const { m, out } = runMove(DRUMMER, "Belly Drum", { hp: 100, atk: 6 });
  ok("Belly Drum at +6 raises nothing", m.atk === 6, String(m.atk));
  ok("...and says only that it spent the HP", (out.did || []).length === 1, JSON.stringify(out.did));
  near("...which it does spend", m.hp, 0.5, 1e-9);
}
{
  // THE FAILURE RULE, in its own words: "This move fails if the user doesn't have enough
  // remaining HP". Exactly half is not enough.
  const { m, out } = runMove(DRUMMER, "Belly Drum", { hp: 50 });
  near("Belly Drum at exactly half health takes nothing", m.hp, 0.5, 1e-9);
  ok("...raises nothing", m.atk === 0, String(m.atk));
  ok("...and does nothing at all", (out.did || []).length === 0, JSON.stringify(out.did));
}
{
  const { m } = runMove(DRUMMER, "Belly Drum", { hp: 49 });
  near("...and below half it still fails rather than fainting its user", m.hp, 0.49, 0.005);
  ok("...with its user still standing", !m.out && m.hp > 0, `hp=${m.hp} out=${m.out}`);
}
{
  const { m, out } = runMove(SOUL, "Clangorous Soul", { hp: 100 });
  near("Clangorous Soul spends a third", m.hp, 1 - 1 / 3, 1e-6);
  ok("...and raises all five stages by one",
    m.atk === 1 && m.spa === 1 && m.def === 1 && m.spd === 1 && m.spe === 1,
    `atk=${m.atk} spa=${m.spa} def=${m.def} spd=${m.spd} spe=${m.spe}`);
  ok("...and says it did both halves", (out.did || []).length >= 2, JSON.stringify(out.did));
}
{
  const { m, out } = runMove(SOUL, "Clangorous Soul", { hp: 30 });
  ok("Clangorous Soul below a third fails", (out.did || []).length === 0, JSON.stringify(out.did));
  ok("...and raises nothing", m.atk === 0, String(m.atk));
}

// ---------------------------------------------------------------------------
// 4. AND THE DAMAGING HOLDERS ARE NOT CHARGED TWICE
// ---------------------------------------------------------------------------

// Steel Beam, Mind Blown and Chloroblast carry the same `hp_cost` op, and the damage CALCULATOR
// already charges them by name -- which reaches every consumer and knows Rock Head. They are
// damaging, so they never reach `runEffectOps`; `secondaries` is deliberately left without a
// branch so that the half is taken once.
for (const name of ["Steel Beam", "Mind Blown", "Chloroblast"]) {
  ok(`the calculator charges ${name} by name`, Number(MAX_HP_RECOIL_FRACTIONS[name]) === 0.5,
    String(MAX_HP_RECOIL_FRACTIONS[name]));
  ok(`...and its registry entry marks the cost after_damage, so nothing else charges it`,
    (effects.moves?.[name.toLowerCase().replace(/[^a-z]/g, "")] || [])
      .some((fx) => fx.op === "hp_cost" && fx.after_damage === true),
    JSON.stringify(effects.moves?.[name.toLowerCase().replace(/[^a-z]/g, "")]));
}
{
  const BEAMER = set("Magnezone", "", "Analytic", "Modest",
    ["Steel Beam", "Thunderbolt", "Protect", "Flash Cannon"], [32, 0, 0, 32, 2, 0]);
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(BEAMER, { front: true }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]));
  const m = state.active[0][0];
  const slot = m.u.moves.findIndex((mv) => mv && mv.name === "Steel Beam");
  ok("Steel Beam is on the probe set", slot >= 0);
  if (slot >= 0) {
    const hit = s.t.hitOn(m, state.active[1][0], slot, state.board, false);
    near("Steel Beam's self cost is a half and not a whole", s.t.selfShare(hit), 0.5, 0.02,
      "charged once, by the calculator");
    notes.push(`Steel Beam self share ${s.t.selfShare(hit).toFixed(4)}`);
  }
}

// ---------------------------------------------------------------------------

for (const line of notes) console.log(`  note: ${line}`);
if (failures.length) {
  console.error(`\nrun-hp-cost: ${failures.length} of ${checked} checks FAILED`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\nrun-hp-cost: ${checked} checks passed`);
