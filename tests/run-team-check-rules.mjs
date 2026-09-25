// The V514 Team Building Checks, both sides of the stamp.
//
//   node tests/run-team-check-rules.mjs
//
// Fast by construction: no evaluation, no damage calculation, no meta rebuild. The
// verdicts are checked against tests/team-check-fixture-v514.json, a byte-identical
// copy of the Companion's own tests/team-check-fixture-v514.json. Both copies carry
// the same `fixture_id` and both suites assert the constant below, so regenerating
// one without the other fails on both sides.
//
// That fixture is the ONLY parity guarantee available for a brand-new check: no app
// recording of coverage_gaps / speed_tiers / lead_viability exists yet, so the
// recorded vector suites (tests/run-eval-vectors.mjs) cannot compare them. What the
// recorded suites DO prove is the other half of the contract -- every recording on
// disk still replays byte-identically with the rule off.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, compact } from "../builder/engine.js";
import { TeamChecks, TEAM_CHECK_RULES, V514_CHECKS, V514_NEW_IDS, V514_RELABELLED, teamCheckRulesOption } from "../builder/team-checks.js";
import { TeamEvaluator } from "../builder/team-eval.js";

/** The shared fixture's content hash; tests/test_team_check_rules_v514.py asserts it too. */
const FIXTURE_ID = "3c1c4d7fec648a2bcb8b928c096e8bbf";

/** The ten ids the Customize list offered before V514, in order. */
const PRE_V514_IDS = [
  "archetype_fit", "speed_control", "protect_positioning", "spread_damage",
  "priority_cleanup", "physical_damage", "special_damage", "utility_disruption",
  "defensive_switch_ins", "field_weather_consistency",
];

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(here, "team-check-fixture-v514.json"), "utf8"));
const engine = new DamageEngine(appData);

let failures = 0;
let checked = 0;
function check(label, condition, detail = "") {
  checked += 1;
  if (!condition) {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}
/** Canonical JSON: Sets become sorted arrays and object keys are sorted, so a
 *  comparison is about the values and not about the order the two ports built them in. */
function canonical(value) {
  if (value instanceof Set) return [...value].map(String).sort();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}
const json = (value) => JSON.stringify(canonical(value));
function same(label, want, got) {
  check(label, json(want) === json(got), `want ${json(want)}\n      got  ${json(got)}`);
}

check("the shared fixture is the one both suites were written against",
  fixture.fixture_id === FIXTURE_ID,
  `fixture ${fixture.fixture_id} | expected ${FIXTURE_ID}`);

// --- the fixture's inputs really are the app's tables ----------------------------
// The price of declaring the V514 ids and labels locally (deviation D14) is that a
// test has to hold the two declarations together. This is the input half of it.
const T = appData.analysisTables || {};
const sortedTable = (values) => [...(values || [])].sort();
same("_V250_FAKE_OUT", fixture.tables.fake_out, sortedTable(T._V250_FAKE_OUT));
same("_V403_REDIRECTION_MOVES", fixture.tables.redirection, sortedTable(T._V403_REDIRECTION_MOVES));
same("_SIMPLE_SPEED_V187", fixture.tables.speed, sortedTable(T._SIMPLE_SPEED_V187));
same("_SIMPLE_PRIORITY_V187", fixture.tables.priority, sortedTable(T._SIMPLE_PRIORITY_V187));
same("_SIMPLE_SPREAD_V187", fixture.tables.spread, sortedTable(T._SIMPLE_SPREAD_V187));
same("_SIMPLE_PROTECT_V187", fixture.tables.protect, sortedTable(T._SIMPLE_PROTECT_V187));
same("_SIMPLE_WEATHER_SETTERS_V187", fixture.tables.weather_setters,
  Object.fromEntries(Object.entries(T._SIMPLE_WEATHER_SETTERS_V187 || {}).map(([k, v]) => [k, sortedTable(v)])));
same("_SIMPLE_TERRAIN_SETTERS_V187", fixture.tables.terrain_setters,
  Object.fromEntries(Object.entries(T._SIMPLE_TERRAIN_SETTERS_V187 || {}).map(([k, v]) => [k, sortedTable(v)])));
same("the 18 types", fixture.types, appData.types);

// --- the move readings the fixture was measured with ------------------------------
const realEv = new TeamEvaluator(null, engine, "Doubles", { top_meta: fixture.meta.top_x });
for (const [move, want] of Object.entries(fixture.move_info)) {
  const got = realEv.simpleMoveInfo(move);
  check(`simpleMoveInfo(${move})`, json(want) === json(got), `want ${json(want)} | got ${json(got)}`);
}

// --- the stamp coercion ----------------------------------------------------------
check("TEAM_CHECK_RULES is version 1", TEAM_CHECK_RULES === 1);
for (const off of [null, undefined, false, "", "0", "off", "false", "no", "none"]) {
  check(`teamCheckRulesOption(${JSON.stringify(off)}) is off`, teamCheckRulesOption(off) === 0);
}
check("teamCheckRulesOption(1) is 1", teamCheckRulesOption(1) === 1);
check("teamCheckRulesOption(true) is the current version", teamCheckRulesOption(true) === TEAM_CHECK_RULES);
check("the evaluator carries the rule", new TeamEvaluator(null, engine, "Doubles", {}).checkRules === TEAM_CHECK_RULES);
check("the evaluator can replay it off",
  new TeamEvaluator(null, engine, "Doubles", {}, { checkRules: null }).checkRules === 0);

// --- the Customize list, both sides of the stamp -----------------------------------
const listOff = new TeamChecks({ engine, format: "Doubles", checkRules: 0 });
same("rule off: the ten pre-V514 ids, in order", PRE_V514_IDS, listOff.allCheckIds());
check("rule off: the old label", listOff.labels.defensive_switch_ins === "Defensive Switch-ins",
  listOff.labels.defensive_switch_ins);
check("rule off: no new check has a verdict function",
  V514_NEW_IDS.every((id) => listOff.checkFor(id) === undefined || !listOff.baseIds.includes(id)));

const listOn = new TeamChecks({ engine, format: "Doubles" });
same("rule on: the twelve ids plus Archetype", [...PRE_V514_IDS, ...V514_NEW_IDS], listOn.allCheckIds());
check("rule on: the new label", listOn.labels.defensive_switch_ins === "Shared Weakness");
for (const [id, label, description] of V514_CHECKS) {
  const entry = listOn.checkList().find((c) => c.id === id);
  check(`Customize offers ${id}`, Boolean(entry));
  check(`${id} label`, entry?.label === label, entry?.label);
  check(`${id} description`, entry?.description === description, entry?.description);
}
for (const [id, [label, description]] of Object.entries(V514_RELABELLED)) {
  const entry = listOn.checkList().find((c) => c.id === id);
  check(`${id} keeps its id and gains its new label`, entry?.label === label, entry?.label);
  check(`${id} description`, entry?.description === description, entry?.description);
}
// A default the app also grants: `selectedIds(null)` is everything.
check("nothing saved means every check", listOn.selectedIds(null).size === listOn.allCheckIds().length);
// The saved nine keep working through the rename (the id never moved).
const saved = listOn.selectedIds(PRE_V514_IDS.slice(1));
check("a saved selection with the old id still enables the row", saved.has("defensive_switch_ins"));
// D12: the id never moved, so the pre-V201 name still maps forward to it.
check("the pre-V201 id shared_weaknesses still maps to defensive_switch_ins",
  listOn.selectedIds(["shared_weaknesses"]).has("defensive_switch_ins"));

// --- the meta context, then the five verdicts --------------------------------------
const records = fixture.meta.records;
const stub = (rules) => ({
  engine,
  format: "Doubles",
  checkRules: rules,
  settings: { top_meta: fixture.meta.top_x },
  simpleMoveInfo: (move) => (fixture.move_info[String(move).trim()] || ["Normal", "status", 0]),
  metaPressureRecords: () => records,
});
const checksOn = new TeamChecks(stub(1));
const context = checksOn.metaContext();
check("the meta context exists", Boolean(context));
check("damaging move total", context.damaging_move_total === fixture.context.damaging_move_total,
  `${context.damaging_move_total} vs ${fixture.context.damaging_move_total}`);
same("the contested Speed band", fixture.context.speed_band, context.speed_band);
for (const [type, weight] of Object.entries(fixture.context.type_weights)) {
  check(`meta weight ${type}`, Math.abs(context.type_weights[type] - weight) < 1e-12,
    `${context.type_weights[type]} vs ${weight}`);
}

/** The fixture's canned profiles as a verdict function reads them (Sets, not arrays). */
function profilesFor(team) {
  return fixture.teams[team].map((row) => {
    const keys = new Set(row.move_keys);
    const physical = [];
    const special = [];
    for (const move of row.moves) {
      const [, category, power] = fixture.move_info[String(move).trim()] || ["Normal", "status", 0];
      if (power > 0 && category === "physical") physical.push(move);
      else if (power > 0 && category === "special") special.push(move);
    }
    const hits = (table) => (fixture.tables[table] || []).some((k) => keys.has(compact(k)));
    return {
      ...row,
      move_keys: keys,
      damaging_types: new Set(row.damaging_types),
      weather_set: new Set(row.weather_set),
      weather_use: new Set(row.weather_use),
      terrain_set: new Set(row.terrain_set),
      // The fields the OTHER seven checks read, so baseRows() can run the whole list.
      physical,
      special,
      damaging_count: physical.length + special.length,
      protect: hits("protect"),
      speed_control: hits("speed"),
      positioning: compact(row.ability || "") === "intimidate",
      spread: hits("spread"),
      utility: new Set(),
      item: "",
      stats: { attack: row._v514_attack, sp_attack: row._v514_sp_attack, speed: row.speed },
      _v514_meta: context,
    };
  });
}

/** Record the raw arguments every verdict hands to `row`, so the comparison is of the
 *  wording the two ports produce and not of the shared assembly around it. */
function runTeam(team) {
  const checks = new TeamChecks(stub(1));
  checks._metaCtx.set(fixture.meta.top_x, context);
  const calls = {};
  const realRow = checks.row.bind(checks);
  checks.row = (checkId, severity, summary, why, fix = "", pressure = 0, threshold = "", extra = {}) => {
    calls[checkId] = { check_id: checkId, severity, summary, why, fix, pressure, threshold, extra };
    return realRow(checkId, severity, summary, why, fix, pressure, threshold, extra);
  };
  const profiles = profilesFor(team);
  checks.checkCoverageGaps(profiles);
  checks.checkSpeedTiers(profiles);
  checks.checkLeadViability(profiles);
  checks.checkFieldWeatherConsistency(profiles);
  checks.checkDefensiveSwitchIns(profiles);
  return calls;
}

for (const team of Object.keys(fixture.expect)) {
  const got = runTeam(team);
  const want = fixture.expect[team];
  same(`${team}: the same five checks produced a row`, Object.keys(want).sort(), Object.keys(got).sort());
  for (const [id, expected] of Object.entries(want)) {
    const actual = got[id] || {};
    for (const field of ["severity", "summary", "why", "fix", "threshold"]) {
      check(`${team}/${id}/${field}`, String(actual[field] ?? "") === String(expected[field] ?? ""),
        `app  ${JSON.stringify(expected[field])}\n      web  ${JSON.stringify(actual[field])}`);
    }
    check(`${team}/${id}/pressure`, Number(actual.pressure) === Number(expected.pressure),
      `app ${expected.pressure} | web ${actual.pressure}`);
    same(`${team}/${id}/extra`, expected.extra, actual.extra);
  }
}

// --- rule off reproduces the V251 reading on the same profiles ----------------------
{
  const checks = new TeamChecks(stub(0));
  const profiles = profilesFor("owner").map((p) => ({ ...p, _v514_meta: undefined }));
  const row = checks.checkDefensiveSwitchIns(profiles);
  check("rule off: the owner's team is still RED on Bug", row.severity === "red", row.severity);
  same("rule off: the V251 type rows", [
    { type: "Bug", weak: 4, switch_ins: 1, immunities: 0, severity: "red" },
    { type: "Poison", weak: 2, switch_ins: 0, immunities: 0, severity: "yellow" },
  ], row.type_rows_v251);
  check("rule off: the old row label", row.check_label === "Defensive Switch-ins", row.check_label);
  const field = checks.checkFieldWeatherConsistency(profiles);
  check("rule off: only the pre-V514 field problem", field.problems.length === 1
    && field.problems[0] === "Psychic Terrain can block the team's priority attacks", json(field.problems));
  check("rule off: the field row stays yellow", field.severity === "yellow", field.severity);
}

// --- Singles: there is no pair to score --------------------------------------------
{
  const singles = new TeamChecks({ ...stub(1), format: "Singles" });
  check("Singles skips lead_viability", singles.singles === true);
  const rows = singles.baseRows(profilesFor("cluster").map((p) => ({ ...p })), new Set(singles.baseIds));
  const ids = rows.map((r) => r.check_id);
  check("Singles has no lead_viability row", !ids.includes("lead_viability"), json(ids));
  check("Singles keeps coverage_gaps and speed_tiers",
    ids.includes("coverage_gaps") && ids.includes("speed_tiers"), json(ids));
  const banned = /both opposing|doubles|VGC|redirection/i;
  for (const row of rows.filter((r) => V514_NEW_IDS.includes(r.check_id) || r.check_id === "defensive_switch_ins")) {
    check(`Singles wording: ${row.check_id}`, !banned.test(String(row.text || "")), row.text);
  }
}

console.log(`${checked - failures}/${checked} checks passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("OK: the V514 Team Building Checks agree with the Companion on both sides of the stamp.");
