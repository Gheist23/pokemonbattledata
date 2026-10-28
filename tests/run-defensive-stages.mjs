// A defensive stat change is priced on the stat it changed (TOURNAMENT_STAGES).
//
// THE BUG. `shiftStages` has written `unit.spd` since TOURNAMENT_EFFECTS added it, and nothing
// read it. `hitOn` passed `target.def` whatever the move was, and `calc` wrote it to
// `defense_stage`. So a Sp. Def change made DURING a turn -- an Acid Spray, the Sp. Def half of
// a Calm Mind, the self-drop of a Close Combat -- was tracked on the row and then ignored by
// every number. Measured: a special hit into a defender at Sp. Def -2 came out at 83.39% of its
// max HP, exactly what it was against an untouched one. The stage was there and the attack went
// straight through it.
//
// The tile said nothing either: `monView` has passed `spd` on all along and the chip row counted
// atk, spa, spe and def, so the field disagreed with the detail panel, which lists all five.
//
// What is checked here:
//
//   1. the rule is 0 by default, and under rule 0 every number is EXACTLY what it was;
//   2. under rule 1 a special hit reads the Sp. Def stage: 83.39% -> 166.36%;
//   3. and only that one -- a physical hit is blind to Sp. Def, a special hit blind to Defense;
//   4. the stage goes to its own field, so a Sp. Def drop never lands on Defense;
//   5. the tile shows all five stages, and the played game asks for the rule.
//
//   node tests/run-defensive-stages.mjs
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
import { TournamentTest, TOURNAMENT_STAGES, tournamentStagesOption } from "../builder/tournament-test.js";
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

function makeSolver(stagesRule) {
  const engine = new DamageEngine(appData);
  const ev = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Solver(new TournamentTest(evaluation, new KnownTeams(knownRaw),
    new TeamSuggestions(evaluation), { effects, liveHpRule: 1, stagesRule }));
}

const set = (species, item, ability, nature, moves, bonuses) =>
  ({ species, form: species, item, ability, nature, moves, bonuses: [...bonuses] });
// Archaludon carries both a special attack (Flash Cannon) and a physical one (Body Press), so
// one attacker tests both halves and nothing else differs between them.
const ATTACKER = set("Archaludon", "Assault Vest", "Stamina", "Modest",
  ["Flash Cannon", "Body Press", "Dragon Pulse", "Protect"], [32, 0, 0, 32, 2, 0]);
const DEFENDER = set("Amoonguss", "Sitrus Berry", "Regenerator", "Calm",
  ["Pollen Puff", "Spore", "Rage Powder", "Protect"], [32, 0, 2, 0, 32, 0]);
const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });

/** Every reading for one rule version, as a percentage of the defender's max HP. */
function readings(stagesRule) {
  const solver = makeSolver(stagesRule);
  const state = solver.buildState({
    sides: [[row(ATTACKER, { front: true }), row(ATTACKER, { front: true })],
      [row(DEFENDER, { front: true }), row(DEFENDER, { front: true })]],
    field: {},
  });
  const a = state.active[0][0];
  const target = state.active[1][0];
  const untouched = state.active[1][1];
  const special = a.u.moves.findIndex((m) => m && /flash cannon/i.test(m.name || ""));
  const physical = a.u.moves.findIndex((m) => m && /body press/i.test(m.name || ""));
  const pct = (m, d, slot) => Number((solver.t.hitOn(m, d, slot, state.board).frac * 100).toFixed(2));

  const out = { base: pct(a, untouched, special), basePhys: pct(a, untouched, physical) };
  // The stage exactly as a turn sets it -- through `shiftStages`, not onto the mon.
  solver.t.shiftStages(target, ["sp_defense"], -2);
  out.spdApplied = target.spd;
  out.specialAfterSpd = pct(a, target, special);
  out.physicalAfterSpd = pct(a, target, physical);
  solver.t.shiftStages(target, ["sp_defense"], 2);
  solver.t.shiftStages(target, ["defense"], -2);
  out.defApplied = target.def;
  out.physicalAfterDef = pct(a, target, physical);
  out.specialAfterDef = pct(a, target, special);
  return out;
}

const off = readings(0);
const on = readings(1);

// ---------------------------------------------------------------------------
// 1. the rule, and rule 0 moving nothing
// ---------------------------------------------------------------------------
{
  ok("TOURNAMENT_STAGES is 0", TOURNAMENT_STAGES === 0, String(TOURNAMENT_STAGES));
  // A VERSION, not a flag: `ruleVersion` is how every TOURNAMENT_* rule reads its option, so an
  // unstamped recording comes back as the default 0 and a caller can ask for a later version.
  ok("the option reader turns it off for an older recording",
    tournamentStagesOption(null) === 0 && tournamentStagesOption("0") === 0
    && tournamentStagesOption(undefined) === 0);
  ok("and on when asked", tournamentStagesOption(1) === 1 && tournamentStagesOption("1") === 1);
  ok("an engine built with the default has it off",
    makeSolver(undefined).t.stagesOn === false);

  // `shiftStages` really writes the stage -- otherwise the whole test would pass vacuously.
  ok("the Sp. Def stage is written by shiftStages", off.spdApplied === -2, String(off.spdApplied));
  ok("the Defense stage too", off.defApplied === -2, String(off.defApplied));

  // Under rule 0 the Sp. Def stage does nothing, which is the defect, pinned so a later change
  // cannot quietly alter what a recording made before the rule replays as.
  ok("rule 0: a Sp. Def drop does nothing to a special hit",
    off.specialAfterSpd === off.base, `${off.specialAfterSpd} vs ${off.base}`);
  ok("rule 0: and the numbers are the published ones",
    off.base === 83.39 && off.basePhys === 67.65 && off.physicalAfterDef === 133.82,
    JSON.stringify(off));
}

// ---------------------------------------------------------------------------
// 2-4. under rule 1
// ---------------------------------------------------------------------------
{
  ok("rule 1: an untouched defender reads exactly as before",
    on.base === off.base && on.basePhys === off.basePhys, `${on.base}/${on.basePhys}`);
  ok("rule 1: a Sp. Def drop doubles a special hit",
    on.specialAfterSpd === 166.36, String(on.specialAfterSpd));
  ok("which is twice the untouched reading", Math.abs(on.specialAfterSpd / on.base - 2) < 0.01,
    `${on.specialAfterSpd} / ${on.base}`);

  // No cross-talk, in either direction. This is what sending the stage to its own field buys:
  // writing a Sp. Def drop into `defense_stage` would be worse than ignoring it.
  ok("a physical hit is blind to the Sp. Def stage",
    on.physicalAfterSpd === off.basePhys, `${on.physicalAfterSpd} vs ${off.basePhys}`);
  ok("a special hit is blind to the Defense stage",
    on.specialAfterDef === on.base, `${on.specialAfterDef} vs ${on.base}`);
  ok("and the Defense stage still works for a physical hit",
    on.physicalAfterDef === 133.82, String(on.physicalAfterDef));

  notes.push(`special hit, untouched        ${off.base}% -> ${on.base}%`);
  notes.push(`special hit, Sp. Def -2       ${off.specialAfterSpd}% -> ${on.specialAfterSpd}%`);
  notes.push(`physical hit, Sp. Def -2      ${off.physicalAfterSpd}% -> ${on.physicalAfterSpd}%`);
  notes.push(`physical hit, Defense -2      ${off.physicalAfterDef}% -> ${on.physicalAfterDef}%`);
  notes.push(`special hit, Defense -2       ${off.specialAfterDef}% -> ${on.specialAfterDef}%`);
}

// ---------------------------------------------------------------------------
// 5. shown as well as used
// ---------------------------------------------------------------------------
{
  const page = readFileSync(join(root, "builder", "play-page.js"), "utf8");
  const chipRow = page.match(/for \(const \[key, label\] of \[\[("atk"[\s\S]*?)\]\]\) \{/);
  ok("the tile's chip row is there", Boolean(chipRow));
  const keys = [...(chipRow?.[1] || "").matchAll(/"([a-z]+)", "/g)].map((m) => m[1]);
  ok("and it shows all five stages", keys.join(",") === "atk,spa,spe,def,spd", keys.join(","));

  const view = readFileSync(join(root, "builder", "play-game.js"), "utf8");
  ok("the view has carried spd all along", /\n    spd: m\.spd \|\| 0,/.test(view));

  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  const asks = (worker.match(/stagesRule: 1/g) || []).length;
  ok("the played game asks for the rule at both of its construction sites", asks === 2, String(asks));
}

// ---------------------------------------------------------------------------

if (notes.length) notes.forEach((n) => console.log(`  ${n}`));
if (failures.length) {
  failures.forEach((f) => console.log(`FAIL ${f}`));
  console.log(`${checked} checked, ${failures.length} failed.`);
  process.exit(1);
}
console.log(`${checked} checked, 0 failed.`);
