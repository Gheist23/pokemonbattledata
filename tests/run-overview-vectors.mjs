// Checks the Team Overview against the Companion app (tests/overview-vectors.json):
// the ranked Speed list (SpeedTiers.rows, _v409_prepare_speed_rows) under several
// conditions, and the Offense/Defense charts (teamOverview, _v300_dashboard_overview).
//
//   node tests/run-overview-vectors.mjs [speed|overview|all] [limit]

// Terrain seeds (builder/engine.js): a recording made with the rule carries
// record.rules.terrain_seeds and replays with it; one without the stamp was made before
// the rule and replays with it off, so a held Electric/Grassy/Misty/Psychic Seed adds no
// stage. TERRAIN_SEEDS=1 / =0 replays every recording either way.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, fieldRequirementOption, koLabelOption, ateDragonizeOption, moveFlagsOption, selfStatChangeOption, terrainSeedOption } from "../builder/engine.js";
import { SpeedTiers } from "../builder/speed-tiers.js";
import { TeamEvaluator } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { teamOverview } from "../builder/team-overview.js";
import { pokemonRecord } from "../tools/builder-meta.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const cases = JSON.parse(readFileSync(join(here, "overview-vectors.json"), "utf8"));
const evalCases = Object.fromEntries(JSON.parse(readFileSync(join(here, "eval-vectors.json"), "utf8")).map((c) => [c.name, c]));
const engine = new DamageEngine(appData);
/** The recording's terrain-seed stamp (null: recorded before the rule, replayed with it off).
 *  TERRAIN_SEEDS=0 / =1 replays every recording either way. */
const seedStamp = (testCase) => testCase.record?.rules?.terrain_seeds ?? testCase.rules?.terrain_seeds ?? null;
const seedRule = (testCase) => terrainSeedOption(process.env.TERRAIN_SEEDS === undefined ? seedStamp(testCase) : process.env.TERRAIN_SEEDS);
// V521: Steel Roller fails with no terrain up. A recording made before the rule carries
// no `field_requirements` stamp and replays with it off, so recorded answers stay the
// answers the app gave when they were made.
const fieldStamp = (testCase) => testCase.record?.rules?.field_requirements ?? testCase.rules?.field_requirements ?? null;
const fieldRule = (testCase) => fieldRequirementOption(
  process.env.FIELD_REQUIREMENTS === undefined ? fieldStamp(testCase) : process.env.FIELD_REQUIREMENTS);
/** V525: a move changes its user's own stats before the answer lands. A recording made
    before the rule carries no `self_stat_change` stamp and replays with it off. */
/** V527: every move learned the flags the game's archive does not publish -- contact,
    punch, bite, slicing, pulse -- so Tough Claws, Iron Fist, Strong Jaw, Sharpness,
    Reckless, Mega Launcher, Fluffy and Punk Rock stopped being inert. A vector recorded
    before the rule carries no `move_flags` stamp and replays with it off. */
/** V528: Dragonize joined the `-ate` table, so a Mega Feraligatr's Normal moves became
    Dragon moves at 1.2x. A vector recorded before the rule carries no `ate_dragonize`
    stamp and replays with the four-entry table. */
const ateDragonizeStamp = (testCase) => testCase.record?.rules?.ate_dragonize ?? testCase.rules?.ate_dragonize ?? null;
const ateDragonizeRule = (testCase) => ateDragonizeOption(
  process.env.ATE_DRAGONIZE === undefined ? ateDragonizeStamp(testCase) : process.env.ATE_DRAGONIZE);
const moveFlagsStamp = (testCase) => testCase.record?.rules?.move_flags ?? testCase.rules?.move_flags ?? null;
const moveFlagsRule = (testCase) => moveFlagsOption(
  process.env.MOVE_FLAGS === undefined ? moveFlagsStamp(testCase) : process.env.MOVE_FLAGS);
const selfStatStamp = (testCase) => testCase.record?.rules?.self_stat_change ?? testCase.rules?.self_stat_change ?? null;
const selfStatRule = (testCase) => selfStatChangeOption(
  process.env.SELF_STAT_CHANGE === undefined ? selfStatStamp(testCase) : process.env.SELF_STAT_CHANGE);
// V523: the threat KO line reads like the Damage Calculator's. A recording made
// before the rule carries no `ko_label` stamp and replays with the old tier label.
const koLabelStamp = (testCase) => testCase.record?.rules?.ko_label ?? testCase.rules?.ko_label ?? null;
const koLabelRule = (testCase) => koLabelOption(
  process.env.KO_LABEL === undefined ? koLabelStamp(testCase) : process.env.KO_LABEL);

const aliases = appData.usageAliases || {};
const stage = process.argv[2] || "all";
const limit = Number(process.argv[3]) || 30;
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) <= tol * Math.max(1, Math.abs(Number(a)));

// One known label difference: the app's Speed list and Team Overview keep a form
// holding its own Mega Stone under the form's name (Floette-Eternal @ Floettite,
// Flower Veil) while computing the Mega's Speed; the web names the Mega, as both
// Team Evaluations do. Same Speed, item and position; only the label differs.
const megaLabelOnly = (app, web) => app && web && engine.isMegaStone(app.item) && !/mega/i.test(app.form || app.name || "") && /mega/i.test(web.form || web.name || "")
  && app.speed === web.speed && app.item === web.item && app.position === web.position && (app.variant || "") === (web.variant || "");
let labelOnly = 0;
const failures = [];
let total = 0;
for (const testCase of cases) {
  engine.terrainSeeds = seedRule(testCase);
  engine.fieldRequirements = fieldRule(testCase);
  engine.selfStatChange = selfStatRule(testCase);
  engine.moveFlags = moveFlagsRule(testCase);
  engine.ateDragonize = ateDragonizeRule(testCase);
  const evalCase = evalCases[testCase.name];
  const records = testCase.ranked.map((entry) => pokemonRecord(String(entry.rows[0]?.pokemon || entry.name), entry.rows, aliases));
  // The pairing rule (builder/nature-spreads.js) as the recording ran it: without the
  // `paired_spreads` stamp, with the usage file's index zip.
  const stamp = testCase.record?.rules?.paired_spreads ?? testCase.rules?.paired_spreads ?? evalCase?.record?.rules?.paired_spreads ?? null;
  const scoreStamp = testCase.record?.rules?.score_composition ?? testCase.rules?.score_composition ?? evalCase?.record?.rules?.score_composition ?? null;
  const ev = new TeamEvaluator(null, engine, "Doubles", evalCase?.settings || {}, { pairedSpreads: stamp, scoreRules: scoreStamp, checkRules: testCase.record?.rules?.team_checks ?? evalCase?.record?.rules?.team_checks ?? null, selfCost: testCase.record?.rules?.self_cost ?? evalCase?.record?.rules?.self_cost ?? null });
  ev.setMetaRecords(records);
  const entries = evalCase ? evalCase.record.team_mons.at(-1).mons : [];
  const sets = entries.map((m) => ({ species: m.pokemon_name, form: m.form_name, item: m.item, ability: m.ability, moves: m.moves, nature: m.nature_name, bonuses: m.bonuses }));

  if (stage === "speed" || stage === "all") {
    const tiers = new SpeedTiers(ev);
    for (const want of testCase.speed) {
      // The recorded teams had no saved Stat Points, so the app's Speed list read
      // Serious / 0 for our side; give the web the spreads the app used.
      const ours = new Map(want.rows.filter((r) => r.source === "our").map((r) => [r.position - 1, r]));
      const speedSets = sets.map((set, i) => (ours.has(i) ? { ...set, nature: ours.get(i).nature, bonuses: [...ours.get(i).bonuses] } : set));
      const got = tiers.rows(speedSets, want.state).rows;
      const label = `${testCase.name} Top ${want.state.top_x} ${JSON.stringify(want.state)}`;
      total += 1;
      const key = (r) => `${r.speed} ${r.source === "our" || r.ours ? "our" : "meta"}#${r.position} ${r.item || "-"} / ${r.ability || "-"}${r.variant ? ` [${r.variant}]` : ""}`;
      const webRows = got.map((r) => ({ speed: r.speed, ours: r.ours, position: r.info.position, item: r.mon.item, ability: r.mon.ability, variant: r.info.variant_label, form: r.mon.form_name }));
      const w = want.rows.map(key);
      const g = webRows.map(key);
      const first = w.findIndex((row, i) => {
        if (row === g[i]) return false;
        if (megaLabelOnly(want.rows[i], webRows[i])) {
          labelOnly += 1;
          return false;
        }
        return true;
      });
      if (first >= 0 || w.length !== g.length) {
        const i = first >= 0 ? first : Math.min(w.length, g.length);
        failures.push(`${label}: ${w.length} app rows, ${g.length} web rows; first difference at #${i}
    app ${w.slice(i, i + 3).join(" | ")}
    web ${g.slice(i, i + 3).join(" | ")}`);
      }
    }
  }

  if (stage === "overview" || stage === "all") {
    const evaluation = new TeamEvaluation(ev);
    for (const [topX, want] of Object.entries(testCase.overview)) {
      const got = teamOverview(evaluation, sets, Number(topX));
      const label = `${testCase.name} Top ${topX}`;
      for (const side of ["offense_chart", "defense_chart"]) {
        total += 1;
        const bad = Object.entries(want[side]).filter(([type, v]) => (v === null) !== (got[side][type] === null) || (v !== null && !near(v, got[side][type])));
        if (bad.length) failures.push(`${label} ${side}: ${bad.slice(0, 4).map(([t, v]) => `${t} app ${v} web ${got[side][t]}`).join("; ")}`);
      }
      for (const direction of ["team_to_meta", "meta_to_team"]) {
        total += 1;
        const w = want[direction];
        const g = got[direction];
        const diffs = [];
        if (!near(w.score, g.score, 1e-6)) diffs.push(`score app ${w.score} web ${g.score}`);
        for (const [type, row] of Object.entries(w.type_summary)) {
          const other = g.type_summary[type] || {};
          if (!near(row.count, other.count) || !near(row.pressure, other.pressure, 1e-6) || !near(row.multiplier, other.multiplier)) diffs.push(`${type} app ${row.count}/${row.pressure.toFixed(4)}/${row.multiplier} web ${other.count}/${Number(other.pressure).toFixed(4)}/${other.multiplier}`);
        }
        if (diffs.length) failures.push(`${label} ${direction}: ${diffs.slice(0, 4).join("; ")}`);
      }
      total += 1;
      const names = (profile) => profile.records.map((r) => `${r.name}:${r.mon?.item || r.item || ""}:${(r.moves || []).join("+")}`);
      const wm = names(want.meta);
      const gm = names(got.meta);
      const i = wm.findIndex((row, k) => {
        if (row === gm[k]) return false;
        const a = want.meta.records[k];
        const b = got.meta.records[k];
        const item = a?.mon?.item || "";
        if (b && engine.isMegaStone(item) && !/mega/i.test(a.name) && /mega/i.test(b.name) && item === b.item && (a.moves || []).join() === (b.moves || []).join()) {
          labelOnly += 1;
          return false;
        }
        return true;
      });
      if (i >= 0 || wm.length !== gm.length) failures.push(`${label} meta records differ at #${i}: app ${wm[i]} | web ${gm[i]} (${wm.length} vs ${gm.length})`);
    }
  }
}
for (const failure of failures.slice(0, limit)) console.log(failure);
console.log(`\n${total} checked, ${failures.length} mismatched${labelOnly ? ` (${labelOnly} rows differ only in the known Mega label)` : ""}.`);
process.exitCode = failures.length ? 1 : 0;
