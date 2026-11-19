// A MOVE THAT LOWERS ITS OWN USER'S STATS DOES SO (TOURNAMENT_SELF_STAT).
//
// The owner's report: "Make it Rain doesn't reduce the attacker's special attack." `secondaries`
// -- the one place a DAMAGING move's registry ops are read -- applied `stage` aimed at the user
// only when the amount was POSITIVE, so every self-boost worked and every self-drop was dropped
// on the floor. Twelve moves, 2,741 appearances across the 1,945 registered teams.
//
// What this guards, beyond "the stage moved":
//   * ONCE PER MOVE USE. Make It Rain is a spread move and the per-target loop would have
//     lowered Sp. Atk twice in Doubles.
//   * NOT A SECONDARY. A Covert Cloak on the target does not stop it, and nor does knocking the
//     target out -- `secondaries` returns early on both.
//   * CLEAR BODY DOES NOT STOP IT, Contrary inverts it, a White Herb refuses it ONCE and is
//     spent doing so -- the same three answers `engine.js selfStatChangeAfterAbility` gives the
//     Damage Calculator, because both read them from there.
//   * RULE OFF IS THE OLD ENGINE, exactly: self-boosts per target, self-drops ignored.
//
//   node tests/run-self-stat-turn.mjs
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
import { TournamentTest, TOURNAMENT_SELF_STAT } from "../builder/tournament-test.js";
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

const LIVE = {
  effects, liveHpRule: 1, chargeRule: 1, berryRule: 1, stagesRule: 1, confusionRule: 1,
  ppRule: 1, rberryRule: 1, bailRule: 1, shieldRule: 1, fieldTurnsRule: 1, abilityOpsRule: 1,
  hazardsRule: 1, pivotRule: 1,
};
const mkEv = () => {
  const ev = new TeamEvaluator(data, new DamageEngine(appData), FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  return ev;
};
const makeSolver = (extra = {}) => new Solver(new TournamentTest(new TeamEvaluation(mkEv()),
  new KnownTeams(knownRaw), new TeamSuggestions(new TeamEvaluation(mkEv())), { ...LIVE, ...extra }));

function setFor(species) {
  for (const r of meta.pokemon) {
    if (String(r.species).toLowerCase() !== species.toLowerCase()) continue;
    const base = data.commonSet(FORMAT, r.species, r.form);
    if (base && base.moves?.length) return base;
  }
  return null;
}
const FIELDS = ["atk", "spa", "def", "spd", "spe"];
const STAT_FIELD = { attack: "atk", sp_attack: "spa", defense: "def", sp_defense: "spd", speed: "spe" };
const row = (set, extra = {}) => ({ set, hp: 100, front: false, ...extra });
const filler = makeSet({ ...setFor("Garchomp"), moves: [...setFor("Garchomp").moves] });

/** One move used once, by a Pokemon built to order, against one or two standing foes. */
function use(species, move, { item, ability, rule = 1, foes = 2, foeHp = 100, foeItem } = {}) {
  const solver = makeSolver({ selfStatRule: rule });
  const mine = makeSet({
    ...(setFor(species) || setFor("Garchomp")),
    moves: [move, "Protect", "Protect", "Protect"],
    ...(item !== undefined ? { item } : {}),
    ...(ability ? { ability } : {}),
  });
  const foe = foeItem === undefined ? filler
    : makeSet({ ...setFor("Garchomp"), item: foeItem, moves: [...setFor("Garchomp").moves] });
  const state = solver.buildState({
    sides: [
      [row(mine, { front: true }), row(filler, { front: true }), row(filler), row(filler)],
      [row(foe, { front: true, hp: foeHp }), row(foe, { front: foes > 1 }), row(foe), row(foe)],
    ],
    field: {},
  });
  const t = solver.t;
  const m = state.active[0][0];
  const live = state.active[1].filter(Boolean);
  const hit = t.hitOn(m, live[0], 0, state.board);
  const events = [];
  t.attack(m, live[0], { ...hit, slot: 0 }, live, state.active[0], state.board, null, events);
  const stages = {};
  for (const key of FIELDS) if (m[key]) stages[key] = m[key];
  return { stages, item: m.u.mon.item || "", said: events.filter((e) => e.kind === "selfstat") };
}

/* ---------------------------------------------------- the rule ships off */
ok("the rule is off by default", TOURNAMENT_SELF_STAT === 0, String(TOURNAMENT_SELF_STAT));

/* ---------------------------------------------------- Make It Rain, the report */
{
  const two = use("Gholdengo", "Make It Rain", { item: "" });
  ok("Make It Rain lowers its user's Sp. Atk", two.stages.spa === -2, JSON.stringify(two.stages));
  ok("...by TWO stages and not four, with two foes standing",
    Object.keys(two.stages).join() === "spa", JSON.stringify(two.stages));
  ok("...and the log says so", two.said.length === 1 && two.said[0].lowered.join() === "spa",
    JSON.stringify(two.said));
  const one = use("Gholdengo", "Make It Rain", { item: "", foes: 1 });
  ok("...the same against one foe as against two", one.stages.spa === -2, JSON.stringify(one.stages));
  const off = use("Gholdengo", "Make It Rain", { item: "", rule: 0 });
  ok("rule 0: nothing moves, which is the bug this fixes", !Object.keys(off.stages).length,
    JSON.stringify(off.stages));
  ok("rule 0: and nothing is said either", off.said.length === 0, JSON.stringify(off.said));
}

/* ---------------------------------------------------- the others */
for (const [species, move, want] of [
  ["Sneasler", "Close Combat", { def: -1, spd: -1 }],
  ["Dragonite", "Draco Meteor", { spa: -2 }],
  ["Delphox", "Overheat", { spa: -2 }],
  ["Garchomp", "Superpower", { atk: -1, def: -1 }],
]) {
  const r = use(species, move, { item: "" });
  const got = Object.fromEntries(Object.keys(want).map((k) => [k, r.stages[k]]));
  ok(`${move} lowers ${Object.keys(want).join("/")}`,
    JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(r.stages)} wanted ${JSON.stringify(want)}`);
}

/* ---------------------------------------------------- a move that does BOTH */
{
  const r = use("Garchomp", "Scale Shot", { item: "" });
  ok("Scale Shot lowers Defense and raises Speed in one use",
    r.stages.def === -1 && r.stages.spe === 1, JSON.stringify(r.stages));
  ok("...and says both halves",
    r.said[0]?.lowered.join() === "def" && r.said[0]?.raised.join() === "spe", JSON.stringify(r.said));
}

/* ---------------------------------------------------- the three answers to it */
{
  const herb = use("Sneasler", "Close Combat", { item: "White Herb" });
  ok("a White Herb refuses the drop", !Object.keys(herb.stages).length, JSON.stringify(herb.stages));
  ok("...and is spent doing it", herb.item === "", herb.item);
  ok("...quietly, because nothing moved", herb.said.length === 0, JSON.stringify(herb.said));

  const clear = use("Metagross", "Close Combat", { item: "", ability: "Clear Body" });
  ok("Clear Body does NOT stop a Pokemon lowering its own stats",
    clear.stages.def === -1 && clear.stages.spd === -1, JSON.stringify(clear.stages));

  const contrary = use("Malamar", "Close Combat", { item: "", ability: "Contrary" });
  ok("Contrary turns the drop into a rise",
    contrary.stages.def === 1 && contrary.stages.spd === 1, JSON.stringify(contrary.stages));
  ok("...and the log says RAISED",
    contrary.said[0]?.raised.length === 2 && !contrary.said[0]?.lowered.length, JSON.stringify(contrary.said));
}

/* ---------------------------------------------------- it is not a secondary effect */
{
  // A Covert Cloak answers secondaries and has nothing to say about what a move does to the
  // Pokemon that used it; `secondaries` returns early on `target.k.secondaryProof`, which is
  // why this is applied beside `oweSelf` and not in there.
  const cloak = use("Gholdengo", "Make It Rain", { item: "", foeItem: "Covert Cloak" });
  ok("a Covert Cloak on the TARGET does not keep the user's own Sp. Atk",
    cloak.stages.spa === -2, JSON.stringify(cloak.stages));
  // ...and nor does knocking it out: `!alive(target)` would have skipped it.
  const ko = use("Sneasler", "Close Combat", { item: "", foes: 1, foeHp: 1 });
  ok("a knockout does not cancel the user's own drop", ko.stages.def === -1, JSON.stringify(ko.stages));
}

/* ---------------------------------------------------- one source with the calculator */
{
  const engine = new DamageEngine(appData);
  let agreed = 0;
  for (const [move, species] of [["Close Combat", "Sneasler"], ["Make It Rain", "Gholdengo"],
    ["Draco Meteor", "Dragonite"], ["Overheat", "Delphox"], ["Leaf Storm", "Rillaboom"]]) {
    const want = engine.selfStatChangeFor(move, "", "");
    const got = use(species, move, { item: "" }).stages;
    const entries = Object.entries(want);
    const same = entries.length > 0
      && entries.every(([stat, amount]) => (got[STAT_FIELD[stat]] || 0) === amount);
    ok(`${move} matches the calculator's own V525 table`, same,
      `${JSON.stringify(want)} vs ${JSON.stringify(got)}`);
    if (same) agreed += 1;
  }
  notes.push(`${agreed} of 5 moves agree with engine.selfStatChangeFor exactly`);
}

if (failures.length) {
  console.error(`run-self-stat-turn: ${failures.length} of ${checked} checks FAILED`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
for (const line of notes) console.log(`  ${line}`);
console.log(`run-self-stat-turn: ${checked} checks passed`);
