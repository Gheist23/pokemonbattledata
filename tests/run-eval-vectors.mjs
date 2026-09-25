// Checks builder/team-eval.js against Team Evaluation results recorded from the
// Companion app (tests/eval-vectors.json and every stamped eval-vectors-*.json
// beside it, written by the app-side recorder).
//
//   node tests/run-eval-vectors.mjs [stage]      stage: attack | between | all
//
// Each stage compares one layer of the evaluation on the app's exact inputs, so
// a mismatch points at the layer that differs rather than at the final score.
//
// Nature / Stat Point pairing (builder/nature-spreads.js): a recording made with the rule
// carries record.rules.paired_spreads and replays with it; one without the stamp was made
// before the rule and replays with each Nature on the distribution at its own place in the
// usage file's other list. PAIRED_SPREADS=0 / =1 replays every recording either way.

// Terrain seeds (builder/engine.js): a recording made with the rule carries
// record.rules.terrain_seeds and replays with it; one without the stamp was made before
// the rule and replays with it off, so a held Electric/Grassy/Misty/Psychic Seed adds no
// stage. TERRAIN_SEEDS=1 / =0 replays every recording either way.

// Every stamped recording beside the main file is replayed too (eval-vectors-*.json), each
// with its own rules stamp, exactly the way tests/run-suggest-vectors.mjs replays the
// suggestion recordings. Those files are Team Evaluation runs and belong to this suite: the
// evaluation recorded beside suggest-vectors-scoring.json used to be checked nowhere, so a
// Team Evaluation difference could only ever surface as an UPSTREAM note in the suggestion
// suite. A recording from an older app run carries an older rules stamp and still replays
// with exactly the rules it was made with, so adding a file cannot disturb the others.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, makeMon, terrainSeedOption } from "../builder/engine.js";
import { TeamEvaluator } from "../builder/team-eval.js";
import { TeamChecks, classifyArchetype, tailwindBeneficiaries } from "../builder/team-checks.js";
import { TeamSynergy } from "../builder/team-synergy.js";
import { TeamSpeed } from "../builder/team-speed.js";
import { TeamEvaluation, isCriticalThreat } from "../builder/team-payload.js";
import { pokemonRecord } from "../tools/builder-meta.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const MAIN_FILE = "eval-vectors.json";
/** The main recording first, then every stamped one beside it, in file-name order. */
const files = [MAIN_FILE, ...readdirSync(here).filter((f) => /^eval-vectors-.+\.json$/.test(f)).sort()]
  .filter((file) => existsSync(join(here, file)));
const cases = files.flatMap((file) => JSON.parse(readFileSync(join(here, file), "utf8"))
  .map((testCase) => Object.assign(testCase, { file })));
/** A case's name, with the recording it came from when that is not the main file. */
const caseLabel = (testCase) => (testCase.file === MAIN_FILE || !testCase.file
  ? testCase.name
  : `${testCase.name} [${testCase.file.replace(/^eval-vectors-|\.json$/g, "")}]`);
const engine = new DamageEngine(appData);
/** The recording's terrain-seed stamp (null: recorded before the rule, replayed with it off).
 *  TERRAIN_SEEDS=0 / =1 replays every recording either way. */
const seedStamp = (testCase) => testCase.record?.rules?.terrain_seeds ?? testCase.rules?.terrain_seeds ?? null;
const seedRule = (testCase) => terrainSeedOption(process.env.TERRAIN_SEEDS === undefined ? seedStamp(testCase) : process.env.TERRAIN_SEEDS);

const aliases = appData.usageAliases || {};
const MON_FIELDS = ["pokemon_name", "form_name", "item", "ability", "nature_name", "bonuses", "moves", "analysis_side"];
const stage = process.argv[2] || "all";
/** The recording's Nature / Stat Point pairing stamp (null: recorded before the rule, replayed
 *  with the usage file's index zip). PAIRED_SPREADS=0 / =1 replays every recording either way. */
const pairedStamp = (testCase) => testCase.record?.rules?.paired_spreads ?? testCase.rules?.paired_spreads ?? null;
/** The recording's V512 scoring stamp (null: recorded before the rule, replayed with it off).
 *  SCORE_RULES=0 / =1 replays every recording either way. */
const scoreStamp = (testCase) => testCase.record?.rules?.score_composition ?? testCase.rules?.score_composition ?? null;
const scoreRule = (testCase) => (process.env.SCORE_RULES === undefined ? scoreStamp(testCase) : process.env.SCORE_RULES);
/** The recording's V514 Team Building Checks stamp (null: recorded before the rule, so the
 *  ten pre-V514 ids, the label "Defensive Switch-ins" and the V251 thresholds replay).
 *  TEAM_CHECK_RULES=0 / =1 replays every recording either way. */
const checkStamp = (testCase) => testCase.record?.rules?.team_checks ?? testCase.rules?.team_checks ?? null;
const checkRule = (testCase) => (process.env.TEAM_CHECK_RULES === undefined ? checkStamp(testCase) : process.env.TEAM_CHECK_RULES);
const pairedRule = (testCase) => (process.env.PAIRED_SPREADS === undefined ? pairedStamp(testCase) : process.env.PAIRED_SPREADS);
const limit = Number(process.argv[3] || 12);

const ATTACK_FIELDS = [
  "move", "label", "full_label", "percent", "ko", "hits", "chance", "full_hits", "full_chance", "score",
  "weather", "terrain", "attacker_speed", "defender_speed", "baseline_speed_v420", "move_priority",
  "speed_tiers_used", "effective_attacker_speed", "condition_names_v420", "baseline_result_v420",
  "condition_range", "range_min_percent", "range_max_percent", "range_min_condition", "range_max_condition",
  "threat_score_condition_v377", "effective_move_type_v447", "move_category_v447", "move_power_v447",
  "weather_source_v447", "tailwind_active_v447", "recharge_move", "raw_hits", "self_ko_move_v432",
];

function same(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a));
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(label, fields, want, got, failures) {
  const diffs = [];
  for (const field of fields) {
    const w = want?.[field];
    const g = got?.[field];
    if (w === undefined && (g === undefined || g === false || g === null)) continue;
    if (!same(w, g)) diffs.push(`${field}: app ${JSON.stringify(w)} | web ${JSON.stringify(g)}`);
  }
  if (diffs.length) failures.push(`${label}\n    ${diffs.join("\n    ")}`);
  return diffs;
}

let total = 0;
const failures = [];
const byField = new Map();
for (const testCase of cases) {
  engine.terrainSeeds = seedRule(testCase);
  const evaluator = new TeamEvaluator(null, engine, "Doubles", testCase.settings, { pairedSpreads: pairedRule(testCase), scoreRules: scoreRule(testCase), checkRules: checkRule(testCase) });
  // The app's meta rows carry their raw battle-data rows; build the site's meta
  // records from exactly those, so data freshness cannot hide a logic difference.
  const metaRows = testCase.record.meta[0]?.rows || [];
  const records = metaRows.map((row) => pokemonRecord(String(row.pokemon || row.base_name || row.name), row.rows || [], aliases));
  evaluator.setMetaRecords(records);

  if (stage === "meta" || stage === "all") {
    const got = evaluator.topMeta(testCase.settings.top_meta);
    metaRows.forEach((row, index) => {
      total += 1;
      compare(`${caseLabel(testCase)} meta #${index}`, ["name", "base_name", "position", "top_item", "top_items", "moves", "_v124_is_mega", "_v124_base_species"], row, got[index], failures);
    });
  }
  if (stage === "common" || stage === "all") {
    for (const [index, row] of testCase.record.common.entries()) {
      if (row.error || !evaluator.record(evaluator.baseSpeciesFromDisplay(row.args[0]))) continue;
      total += 1;
      const got = evaluator.commonMon(row.args[0], row.args[1]);
      compare(`${caseLabel(testCase)} common #${index} ${row.args[0]}`, MON_FIELDS, row.mon, got, failures);
    }
  }
  if (stage === "variants" || stage === "all") {
    for (const [index, row] of testCase.record.variants.entries()) {
      if (row.error) continue;
      total += 1;
      const got = evaluator.threatVariants(makeMon(row.base), row.items, row.moves);
      if (got.length !== row.variants.length) {
        failures.push(`${caseLabel(testCase)} variants #${index} ${row.base.form_name}: app ${row.variants.length} variants | web ${got.length}`);
        continue;
      }
      row.variants.forEach((want, i) => compare(`${caseLabel(testCase)} variants #${index}.${i} ${row.base.form_name}`, [...MON_FIELDS, "stat_spread_label"], want, got[i], failures));
    }
  }
  if (stage === "threats" || stage === "all") {
    const teamMons = (testCase.record.team_mons.at(-1)?.mons || []).map(makeMon);
    // payload.threats is the critical subset (V462); the payload stage checks the filter itself.
    const got = evaluator.teamThreats(teamMons).threats.filter(isCriticalThreat);
    const want = testCase.payload.threats || [];
    total += want.length;
    if (got.length !== want.length) failures.push(`${caseLabel(testCase)} threats: app ${want.length} rows | web ${got.length}`);
    want.forEach((row, i) => {
      const mine = got.find((r) => r.name === row.name) || got[i];
      compare(`${caseLabel(testCase)} threat ${row.name}`, ["name", "base_name", "position", "score", "threat_counts", "answer_counts", "weather_used", "top_items", "top_moves", "threat_spread_label", "threat_ability"], row, mine, failures);
      for (const side of ["their_best", "our_best", "our_best_speed_adjusted"]) {
        compare(`${caseLabel(testCase)} threat ${row.name} ${side}`, ["attacker", "defender", "move", "label", "hits", "chance", "percent", "score", "speed_tier_suppressed"], row[side], mine?.[side], failures);
      }
    });
  }
  if (stage === "overview" || stage === "all") {
    const teamMons = (testCase.record.team_mons.at(-1)?.mons || []).map(makeMon);
    const got = evaluator.teamThreats(teamMons);
    const want = testCase.payload.pressure_overview_v188 || {};
    total += 1;
    const pick = (o) => ({
      offense: o.offense_score, defense: o.defense_score, out: o.team_to_meta?.score, in: o.meta_to_team?.score,
      answer: o.critical?.answer_score, safety: o.critical?.safety_score, count: o.critical?.count, meta_count: o.meta_count,
      team_moves: o.team_to_meta?.move_count, meta_moves: o.meta_to_team?.move_count,
    });
    compare(`${caseLabel(testCase)} overview`, ["offense", "defense", "out", "in", "answer", "safety", "count", "meta_count", "team_moves", "meta_moves"], pick(want), pick(got.overview), failures);
    compare(`${caseLabel(testCase)} payload scores`, ["offense_score", "defense_score"], testCase.payload, { offense_score: got.offense, defense_score: got.defense }, failures);
  }
  if (stage === "attack" || stage === "all") {
    for (const [index, row] of testCase.record.attack.entries()) {
      if (row.error) continue;
      total += 1;
      const got = evaluator.bestAttack(makeMon(row.attacker), makeMon(row.defender), row.moves);
      const diffs = compare(`${caseLabel(testCase)} attack #${index}: ${row.attacker.form_name} -> ${row.defender.form_name}`, ATTACK_FIELDS, row.result, got, failures);
      for (const d of diffs) byField.set(d.split(":")[0], (byField.get(d.split(":")[0]) || 0) + 1);
    }
  }
  if (stage === "between" || stage === "all") {
    for (const [index, row] of testCase.record.between.entries()) {
      if (row.error) continue;
      total += 1;
      const got = evaluator.bestBetween(row.a.map(makeMon), row.b.map(makeMon));
      const diffs = compare(`${caseLabel(testCase)} between #${index}: ${row.a[0]?.form_name} -> ${row.b[0]?.form_name}`, [...ATTACK_FIELDS, "attacker", "defender", "item"], row.result, got, failures);
      for (const d of diffs) byField.set(`between.${d.split(":")[0]}`, (byField.get(`between.${d.split(":")[0]}`) || 0) + 1);
    }
  }
  if (stage === "order" || stage === "all") {
    for (const [index, row] of testCase.record.order.entries()) {
      if (row.error) continue;
      total += 1;
      const [inc, out] = evaluator.applySpeedOrder(row.incoming, row.outgoing);
      const fields = ["hits", "chance", "score", "label", "speed_tier_suppressed", "pre_speed_tier_label", "pre_speed_tier_hits", "speed_tier_note", "speed_tiers_used"];
      compare(`${caseLabel(testCase)} order #${index} incoming`, fields, row.result[0], inc, failures);
      compare(`${caseLabel(testCase)} order #${index} outgoing`, fields, row.result[1], out, failures);
    }
  }
  if (stage === "quality" || stage === "all") {
    for (const [index, row] of testCase.record.quality.entries()) {
      if (row.error) continue;
      total += 1;
      const got = evaluator.matchupQuality({ ...row.outgoing }, { ...row.incoming });
      if (!same(row.quality, got)) failures.push(`${caseLabel(testCase)} quality #${index}: app ${row.quality} | web ${got}`);
    }
  }
  if (stage === "checks" || stage === "all") {
    const extra = testCase.extra || {};
    const recordedMons = testCase.record.team_mons.at(-1)?.mons || [];
    const team = (extra.simple_profiles || []).map((profile, i) => {
      const [pokemon, item, form, ability, moves] = profile.entry;
      const source = recordedMons[i] || {};
      const entry = { pokemon, item, form, ability, moves };
      const mon = evaluator.teamMon({ species: pokemon, form, item, ability, moves, nature: source.nature_name, bonuses: source.bonuses }, i);
      return { entry, mon };
    });
    const checks = new TeamChecks(evaluator);
    const profiles = checks.profiles(team);
    const sorted = (v) => [...(v || [])].sort();
    const PROFILE_SETS = ["move_keys", "damaging_types", "utility", "weather_set", "weather_use", "terrain_set"];
    (extra.simple_profiles || []).forEach((want, i) => {
      total += 1;
      const got = { ...profiles[i] };
      const wantN = { ...want };
      for (const f of PROFILE_SETS) { got[f] = sorted(got[f]); wantN[f] = sorted(wantN[f]); }
      compare(`${caseLabel(testCase)} profile ${want.name}`, ["name", "pokemon", "item", "ability", "types", "moves", "physical", "special", "damaging_count", "protect", "speed_control", "priority", "positioning", "spread", "speed", ...PROFILE_SETS], wantN, got, failures);
    });
    const tailwind = tailwindBeneficiaries(extra.profiles_252 || [], extra.meta_speed_rows || []);
    const features = checks.archetypeFeatures(profiles, { tailwind });
    const { evidence: _e1, ...wantFeatures } = extra.features || {};
    total += 1;
    compare(`${caseLabel(testCase)} archetype features`, Object.keys(wantFeatures), wantFeatures, features, failures);
    total += 1;
    const [display, key, scores] = classifyArchetype(features);
    compare(`${caseLabel(testCase)} archetype`, ["0", "1", "2"], { 0: extra.archetype[0], 1: extra.archetype[1], 2: extra.archetype[2] }, { 0: display, 1: key, 2: scores }, failures);
    const snapshot = checks.snapshot(team, extra.selected_checks, { tailwind });
    const want = extra.checks || [];
    total += want.length;
    if (snapshot.rows.length !== want.length) failures.push(`${caseLabel(testCase)} checks: app ${want.map((r) => r.check_id).join(",")} | web ${snapshot.rows.map((r) => r.check_id).join(",")}`);
    want.forEach((row, i) => compare(`${caseLabel(testCase)} check #${i} ${row.check_id}`, ["check_id", "severity", "pressure", "text", "check_label", "summary_v203", "why_v203", "fix_v203", "score_explanation", "type_rows_v251", "mega_names", "archetype_requirements_v403"], row, snapshot.rows[i], failures));
    total += 1;
    const snapWant = extra.check_snapshot || {};
    compare(`${caseLabel(testCase)} check snapshot`, ["warnings", "red_count", "yellow_count", "check_pressure", "red_units", "active", "protect", "utility", "utility_moves", "selected_team_checks", "current_archetype_v403"], snapWant, snapshot, failures);
  }
  if (stage === "synergy" || stage === "all") {
    const extra = testCase.extra || {};
    const recordedMons = testCase.record.team_mons.at(-1)?.mons || [];
    const team = (extra.simple_profiles || []).map((profile, i) => {
      const [pokemon, item, form, ability, moves] = profile.entry;
      const source = recordedMons[i] || {};
      return { entry: { pokemon, item, form, ability, moves }, mon: evaluator.teamMon({ species: pokemon, form, item, ability, moves, nature: source.nature_name, bonuses: source.bonuses }, i) };
    });
    const synergy = new TeamSynergy(evaluator, new TeamChecks(evaluator));
    total += 1;
    const speeds = synergy.metaSpeedRows();
    if (!same(speeds, extra.meta_speed_rows)) failures.push(`${caseLabel(testCase)} meta speeds
    app ${JSON.stringify(extra.meta_speed_rows)}
    web ${JSON.stringify(speeds)}`);
    const plain = (v) => (v instanceof Set ? [...v].sort() : v);
    (extra.profiles_252 || []).forEach((want, i) => {
      total += 1;
      const got = synergy.profile(team[i].entry, team[i].mon);
      const g = {};
      const w = {};
      for (const k of Object.keys(want)) {
        if (k === "entry") continue;
        g[k] = Array.isArray(got[k]) ? [...got[k]].sort() : plain(got[k]);
        w[k] = Array.isArray(want[k]) ? [...want[k]].sort() : want[k];
      }
      compare(`${caseLabel(testCase)} synergy profile ${want.name}`, Object.keys(w), w, g, failures);
    });
    const got = synergy.team(team, { threats: [] });
    const want = extra.team_synergy_final || {};
    total += 1;
    compare(`${caseLabel(testCase)} team synergy`, ["score", "pair_count", "members", "interaction_count", "calculation"], want, got, failures);
    (want.pairs || []).forEach((pair, i) => {
      total += 1;
      const mine = got.pairs[i] || {};
      const brief = (rows) => (rows || []).map((r) => `${r.title} [${r.impact}]`);
      compare(`${caseLabel(testCase)} pair ${pair.first} + ${pair.second}`, ["first", "second", "score", "interactions", "conflicts"],
        { ...pair, interactions: brief(pair.interactions), conflicts: brief(pair.conflicts) },
        { ...mine, interactions: brief(mine.interactions), conflicts: brief(mine.conflicts) }, failures);
    });
  }
  if (stage === "speed" || stage === "all") {
    const extra = testCase.extra || {};
    const recordedMons = testCase.record.team_mons.at(-1)?.mons || [];
    const team = (extra.simple_profiles || []).map((profile, i) => {
      const [pokemon, item, form, ability, moves] = profile.entry;
      const source = recordedMons[i] || {};
      return { entry: { pokemon, item, form, ability, moves }, mon: evaluator.teamMon({ species: pokemon, form, item, ability, moves, nature: source.nature_name, bonuses: source.bonuses }, i) };
    });
    const checks = new TeamChecks(evaluator);
    const synergy = new TeamSynergy(evaluator, checks);
    const speedCalc = new TeamSpeed(evaluator, checks, synergy);
    const profiles = team.map(({ entry, mon }) => synergy.profile(entry, mon));
    const features = checks.archetypeFeatures(checks.profiles(team), { tailwind: tailwindBeneficiaries(profiles, synergy.metaSpeedRows()) });
    const got = speedCalc.control(team, { profiles, features });
    got.score = Math.max(0, Math.min(100, got.score * Math.min(1, team.length / 6)));
    const want = testCase.payload.speed || {};
    total += 1;
    compare(`${caseLabel(testCase)} speed`, Object.keys(want), want, got, failures);
  }
  if (stage === "payload" || stage === "all") {
    const extra = testCase.extra || {};
    const recordedMons = testCase.record.team_mons.at(-1)?.mons || [];
    const sets = (extra.simple_profiles || []).map((profile, i) => {
      const [species, item, form, ability, moves] = profile.entry;
      const source = recordedMons[i] || {};
      return { species, item, form, ability, moves, nature: source.nature_name, bonuses: source.bonuses };
    });
    const got = new TeamEvaluation(evaluator).evaluate(sets, { checkSelection: extra.selected_checks });
    const want = testCase.payload;
    total += 1;
    compare(`${caseLabel(testCase)} payload scores`, ["offense_score", "defense_score", "all_top_meta_threat_rows_v462", "mega_count", "mega_names", "protect_count", "protect_names"], want, got, failures);
    compare(`${caseLabel(testCase)} payload speed`, ["score"], want.speed, got.speed, failures);
    total += 1;
    const names = (rows) => (rows || []).map((r) => r.name);
    if (!same(names(want.threats), names(got.threats))) failures.push(`${caseLabel(testCase)} critical threats
    app ${JSON.stringify(names(want.threats))}
    web ${JSON.stringify(names(got.threats))}`);
    (want.threats || []).forEach((row) => {
      total += 1;
      const mine = got.threats.find((r) => r.name === row.name) || {};
      compare(`${caseLabel(testCase)} threat ${row.name} display`, ["weather_used", "terrain_used", "threat_item", "threat_moves_display", "condition_outcomes_v420"], row, mine, failures);
      (row.breakdown || []).forEach((b, i) => {
        const mb = (mine.breakdown || [])[i] || {};
        if (!same(b.conditional_outcome_v420, mb.conditional_outcome_v420)) failures.push(`${caseLabel(testCase)} ${row.name} breakdown #${i} outcome
    app ${JSON.stringify(b.conditional_outcome_v420)}
    web ${JSON.stringify(mb.conditional_outcome_v420)}`);
      });
    });
  }
}
for (const failure of failures.slice(0, limit)) console.log(failure);
console.log(`\n${total} checked, ${failures.length} mismatched (${cases.length} recorded evaluations from ${files.join(", ")}).`);
if (byField.size) console.log("by field:", Object.fromEntries([...byField.entries()].sort((a, b) => b[1] - a[1])));
process.exitCode = failures.length ? 1 : 0;
