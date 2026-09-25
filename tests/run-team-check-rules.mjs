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
import { TeamChecks, TEAM_CHECK_RULES, V514_CHECKS, V514_NEW_IDS, V514_RELABELLED, COVERAGE_EXTRA_ATTACKS, teamCheckRulesOption } from "../builder/team-checks.js";
import { TeamEvaluator } from "../builder/team-eval.js";

/** The shared fixture's content hash; tests/test_team_check_rules_v514.py asserts it too. */
const FIXTURE_ID = "2c4a82637daf404a8faabdade3985478";

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
// The coercion's whole job is to be identical to `active_rule`, and two cases were not.
// A negative version used to fall through to the current version here while the app read it
// as off, and a fractional one used to stay fractional here while the app truncated it.
for (const negative of ["-1", "-5", -1, 0, "0.4"]) {
  check(`teamCheckRulesOption(${JSON.stringify(negative)}) is off, as the app reads it`,
    teamCheckRulesOption(negative) === 0, String(teamCheckRulesOption(negative)));
}
check("a fractional version truncates, as the app truncates it", teamCheckRulesOption("1.9") === 1,
  String(teamCheckRulesOption("1.9")));
check("an unparseable version replays on the newest rule", teamCheckRulesOption("later") === TEAM_CHECK_RULES);
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
// --- the one decision the two ports have to agree on --------------------------------
// A NEW CHECK IS OFF FOR A USER WHO ALREADY SAVED A SELECTION, and the Companion now agrees
// (team_check_rules_v514.derived_selection is an identity, and its own test asserts the same
// three cases). The app used to union V514_NEW_IDS onto a saved list, so the same person's
// Companion and browser disagreed about their own settings, and a user who had switched every
// check off got three back.
//
// A default the app also grants: `selectedIds(null)` is everything, including the new rows,
// which is how a user who never opened Customize gets them.
check("nothing saved means every check", listOn.selectedIds(null).size === listOn.allCheckIds().length);
check("and that includes the three new rows",
  V514_NEW_IDS.every((id) => listOn.selectedIds(null).has(id)));
// The saved nine keep working through the rename (the id never moved)...
const saved = listOn.selectedIds(PRE_V514_IDS.slice(1));
check("a saved selection with the old id still enables the row", saved.has("defensive_switch_ins"));
// ...and gain nothing.
same("a saved selection is taken literally: nothing is added to it",
  PRE_V514_IDS.slice(1), [...saved]);
check("so a new check is OFF for a user who already saved a selection",
  V514_NEW_IDS.every((id) => !saved.has(id)), json([...saved]));
// An explicit empty selection stays empty: this page has a row for that state.
check("an explicit empty selection stays empty", listOn.selectedIds([]).size === 0, json([...listOn.selectedIds([])]));
check("and an empty saved string too", listOn.selectedIds("").size === 0);
// A saved list that names some new rows and not others round-trips exactly.
same("turning one new check on and another off sticks",
  ["coverage_gaps", "speed_control"], [...listOn.selectedIds(["speed_control", "coverage_gaps"])].sort());
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

/** The teams the fixture judges with NO Top Meta, so the sentences a check says when it
 *  cannot measure are compared across the ports instead of asserted separately on each. */
const NO_CONTEXT = new Set(fixture.no_context_teams || []);

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
      _v514_meta: NO_CONTEXT.has(team) ? undefined : context,
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

// --- D22: power decides whether a move is an attack, not the reported category ------
{
  // Five real attacks are filed as "status" because they also lower a stat, and every
  // genuine status move in the same table reports power 0, so power separates them
  // exactly. The regression this pins: reading `damaging_types` alone drops the owner's
  // only Dark attack (Knock Off) and reports Gholdengo and Metagross -- which Knock Off
  // hits for 2x -- as having no super-effective answer.
  same("D22: the app reads Knock Off as a status move with power",
    ["Dark", "status", 65], fixture.move_info["Knock Off"]);
  for (const name of ["Protect", "Trick Room", "Follow Me", "Helping Hand", "Detect"]) {
    check(`D22: ${name} has no power`, Number(fixture.move_info[name][2]) === 0, json(fixture.move_info[name]));
  }
  const checks = new TeamChecks(stub(1));
  checks._metaCtx.set(fixture.meta.top_x, context);
  const wide = checks.checkCoverageGaps(profilesFor("owner"));
  check("D22: Dark is in the owner's attacking types",
    (wide.coverage_attacking_types_v514 || []).includes("Dark"), json(wide.coverage_attacking_types_v514));
  const narrow = checks.checkCoverageGaps(profilesFor("owner").map((p) => {
    const clone = { ...p };
    delete clone._v514_coverage_types;
    return clone;
  }));
  const names = (narrow.coverage_rows_v514 || []).map((r) => r.name);
  check("D22: without it the owner loses Dark",
    !(narrow.coverage_attacking_types_v514 || []).includes("Dark"), json(narrow.coverage_attacking_types_v514));
  check("D22: without it Gholdengo and Metagross are falsely reported",
    names.includes("Gholdengo") && names.includes("Metagross"), json(names));
  check("D22: and the verdict is a yellow the owner cannot act on",
    narrow.severity === "yellow", narrow.severity);
}

// --- the shared table that keeps the two attacking sets identical -------------------
{
  // "power > 0" was not enough: the Companion's live move reader returns 0 for 14 of these
  // nineteen (the app's own `_v94_move_bucket` forces a stat-lowering attack to status/0 and
  // only five have curated metadata that restores the power), while this site's app-data.json
  // keeps the real power in `simple`. 507 of 2827 real six-slot teams carry one of the 14, so
  // the two products could reach different Coverage Gaps verdicts on 17.9% of real teams.
  // The table is the fix and this is the parity assertion for the table itself.
  const mine = Object.fromEntries(Object.entries(COVERAGE_EXTRA_ATTACKS).map(([k, v]) => [k, [v[0], v[1]]]));
  same("the shared extra-attacks table is the app's", fixture.coverage_extra_attacks, mine);
  check("it is exactly the moves whose `simple` and `analysis.bucket` triples differ in the export",
    Object.keys(mine).sort().join(",") === Object.values(appData.moves || {})
      .filter((m) => m.simple && m.analysis?.bucket && JSON.stringify(m.simple) !== JSON.stringify(m.analysis.bucket))
      .map((m) => compact(m.name)).sort().join(","));
  // Every pair is the app's own exported number, not an invented one.
  for (const [key, [type, power]] of Object.entries(mine)) {
    const entry = Object.values(appData.moves || {}).find((m) => compact(m.name) === key);
    check(`${key} is the app's own ${type} ${power}`,
      entry && String(entry.simple[0]) === type && Number(entry.simple[2]) === Number(power),
      json(entry?.simple));
  }
}

/** One verdict's raw `row()` arguments, so an assertion is about the wording the check chose
 *  and not about the assembled row (whose `why_v203` is blanked on a good row). */
function callOf(checks, method, profiles) {
  let call = null;
  const realRow = checks.row.bind(checks);
  checks.row = (checkId, severity, summary, why, fix = "", pressure = 0, threshold = "", extra = {}) => {
    call = { severity, summary, why, fix, pressure, threshold, extra };
    return realRow(checkId, severity, summary, why, fix, pressure, threshold, extra);
  };
  try {
    const row = checks[method](profiles);
    return { ...(call || {}), row };
  } finally {
    checks.row = realRow;
  }
}

// --- Speed Tiers may only name a Pokemon that actually has Tailwind -----------------
{
  // The shipped fixture used to say "One Tailwind from Milotic (Speed 101) moves it past all
  // four in the same turn." Milotic's set in the same fixture is Protect / Scald / Ice Beam /
  // Icy Wind. The flip candidate was chosen on Speed alone, with no move test.
  const withTailwind = (records, name) => records.map((r) => (String(r.name) === name
    ? { ...r, moves: ["Tailwind", ...(r.moves || []).slice(0, 3)] } : r));
  const cluster = fixture.expect.cluster.speed_tiers;
  check("with no Tailwind user in range, nobody is named",
    !Object.keys(cluster.extra.speed_flip_v514).length && !/One Tailwind from/.test(cluster.why), cluster.why);
  check("and the row says the honest generic sentence instead",
    /One Tailwind or Icy Wind changes the order/.test(cluster.why), cluster.why);
  // Give one member of the Top X that really is in range a Tailwind and it IS named.
  const ceiling = cluster.extra.speed_cluster_v514.high;
  const inRange = records.find((r) => {
    const s = Number(r.stats?.speed ?? r.speed) || 0;
    return s > 0 && s <= ceiling && s * 2 > ceiling;
  });
  check("the fixture has a Top-X member inside the flip window at all", Boolean(inRange), String(ceiling));
  const ev2 = { ...stub(1), metaPressureRecords: () => withTailwind(records, String(inRange.name)) };
  const checks2 = new TeamChecks(ev2);
  const got = callOf(checks2, "checkSpeedTiers",
    profilesFor("cluster").map((p) => ({ ...p, _v514_meta: checks2.metaContext() })));
  check("a Tailwind carrier in range IS named", got.extra.speed_flip_v514?.name === String(inRange.name),
    json(got.extra.speed_flip_v514));
  check("and the sentence credits it with the move it has",
    String(got.why).includes(`One Tailwind from ${inRange.name}`), got.why);
}

// --- a check that cannot run says so, instead of reporting a positive conclusion ----
{
  // Before the first sync, or in a format with no meta rows, `speed_band` is (0, 0) and gate 2
  // rejects every cluster: Speed Tiers used to answer "the team's Speeds are spread out enough
  // that one Tailwind cannot reorder all of it at once" off a measurement that never ran, and
  // Shared Weakness used to say "no attacking type the meta actually uses" while every weight
  // was the 1.0 placeholder.
  const checks = new TeamChecks({ ...stub(1), metaPressureRecords: () => [] });
  const bare = profilesFor("cluster").map((p) => ({ ...p, _v514_meta: undefined }));
  const speed = callOf(checks, "checkSpeedTiers", bare);
  check("no Top Meta: Speed Tiers says it could not measure", speed.extra.speed_gate_v514 === "no_meta", speed.extra.speed_gate_v514);
  check("and does not claim the Speeds are spread out enough",
    !/spread out enough/.test(`${speed.summary} ${speed.why}`), speed.summary);
  check("and the sentence the player reads is the honest one",
    /not loaded yet/.test(String(speed.row.text)), speed.row.text);
  const coverage = callOf(checks, "checkCoverageGaps", bare);
  check("no Top Meta: Coverage Gaps says the same", /not loaded yet/.test(String(coverage.summary)), coverage.summary);
  const shared = callOf(checks, "checkSharedWeakness", bare);
  check("no Top Meta: Shared Weakness says the reading is unweighted",
    shared.extra.meta_weighted_v514 === false && /equally common/.test(`${shared.summary} ${shared.why}`),
    `${shared.summary} | ${shared.why}`);
  check("and never claims to know what the meta attacks with",
    !/the meta actually uses|rarely attacks with/.test(`${shared.summary} ${shared.why}`), shared.summary);

  // A cluster that is real but sits outside the contested range is excused with its OWN
  // sentence: six members at Speed 30-35 under a band of (70, 167) are not spread out, they
  // are simply not in the race.
  const slow = profilesFor("cluster").map((p, i) => ({ ...p, speed: 30 + i, move_keys: new Set([...p.move_keys].filter((k) => k !== "trickroom")) }));
  const gated = new TeamChecks(stub(1));
  gated._metaCtx.set(fixture.meta.top_x, context);
  const row = callOf(gated, "checkSpeedTiers", slow.map((p) => ({ ...p, _v514_meta: context })));
  check("outside the contested band: its own honest sentence", row.extra.speed_gate_v514 === "outside_band", row.extra.speed_gate_v514);
  check("and it names the band it is outside of",
    row.severity === "good" && /outside the Speed range the Top 30 contests/.test(String(row.summary)), row.summary);
  check("and never says spread out enough", !/spread out enough/.test(`${row.summary} ${row.why}`), row.why);
}

// --- a type the Top X never attacks with can still be raised -------------------------
{
  // The weight used to be `count / average` with no floor, so a type with no observed move had
  // weight EXACTLY 0 and its exposure was 0 however many members were weak to it. Reachable
  // from the Top X spinner alone.
  // `top_meta` is a QSpinBox with range 1-100, so a small Top X is a user setting, not a
  // theoretical case. Ten of the fixture's own Top 30 records are enough to produce one.
  const small = new TeamChecks({ ...stub(1), settings: { top_meta: 10 }, metaPressureRecords: () => records.slice(0, 10) });
  const smallContext = small.metaContext();
  const zero = Object.entries(smallContext.damaging_move_counts).filter(([, n]) => n === 0).map(([t]) => t);
  check("a Top 10 really has types it never attacks with", zero.length > 0, json(zero));
  for (const type of zero) {
    check(`${type} is floored rather than deleted`, smallContext.type_weights[type] >= 0.5, String(smallContext.type_weights[type]));
  }
  // Six members weak to it, no resist: 6 * 0.5 = 3.0, exactly the yellow bar.
  const weakTo = (type, weak) => {
    const checks = new TeamChecks({ ...stub(1), settings: { top_meta: 10 } });
    checks.defensiveCounts = () => [{ [type]: weak }, {}, {}];
    return callOf(checks, "checkSharedWeakness",
      profilesFor("cluster").map((p) => ({ ...p, _v514_meta: smallContext })));
  };
  for (const type of zero) {
    const row = weakTo(type, 6);
    check(`the whole team weak to ${type} is raised`, row.severity !== "good",
      `${row.severity} ${json(row.extra.type_rows_v251)}`);
  }
  // Three members weak to an unused type is still not worth a row.
  for (const type of zero) {
    const row = weakTo(type, 3);
    check(`three members weak to ${type} stays green`, row.severity === "good", row.severity);
    check(`but it is reported in gated_types_v514`, (row.extra.gated_types_v514 || []).some((r) => r.type === type),
      json(row.extra.gated_types_v514));
  }
}

// --- the moves table, and the two Pokemon case ---------------------------------------
{
  // Removed after verification: terrainpulse (a 50 BP Normal special without a terrain -- the
  // same shape as Weather Ball, which the table excluded for that reason), mistyexplosion,
  // risingvoltage, psyblade (multipliers only) and steelroller (the terrain it needs is the
  // OPPONENT's, so "nothing on the team sets it" is the intended state).
  const checks = new TeamChecks(stub(1));
  const base = profilesFor("cluster")[0];
  const carrying = (move) => {
    const one = { ...base, moves: [move], move_keys: new Set([compact(move)]), weather_set: new Set(), weather_use: new Set(), terrain_set: new Set() };
    return checks.checkFieldWeatherConsistency([one]).problems || [];
  };
  for (const move of ["Terrain Pulse", "Misty Explosion", "Rising Voltage", "Psyblade", "Steel Roller", "Weather Ball", "Blizzard"]) {
    check(`${move} is not flagged for a missing condition`, carrying(move).length === 0, json(carrying(move)));
  }
  for (const move of ["Aurora Veil", "Grassy Glide", "Expanding Force"]) {
    check(`${move} still is`, carrying(move).length === 1, json(carrying(move)));
  }
  // Field severity is a weight, so one added rule cannot promote a team on its own.
  const owner = fixture.expect.owner.field_weather_consistency;
  check("two conflicts the team can play around are a yellow, not a red",
    owner.severity === "yellow" && owner.extra.field_weight_v514 === 1.0 && owner.extra.problems.length === 2,
    `${owner.severity} ${owner.extra.field_weight_v514}`);
  check("and a broken dependency on its own is a yellow too",
    fixture.expect.cluster.field_weather_consistency.extra.field_weight_v514 === 1.0);

  // Two Pokemon: the one pair IS the lead, and the row used to deny it existed while its own
  // payload said lead_pair_count_v514 = 1.
  const lead = callOf(checks, "checkLeadViability", profilesFor("owner").slice(0, 2));
  check("two Pokemon: the one pair is judged",
    lead.extra.lead_pair_count_v514 === 1 && !/no lead pair/.test(String(lead.summary)),
    `${lead.extra.lead_pair_count_v514} ${lead.summary}`);
  check("and the row is about that pair", /your (one|only) lead pair/.test(String(lead.summary)), lead.summary);
  const one = callOf(checks, "checkLeadViability", profilesFor("owner").slice(0, 1));
  check("one Pokemon: there is genuinely no pair yet", /no lead pair to judge yet/.test(String(one.summary)), one.summary);
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
