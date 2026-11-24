// V556: a field is worth what it switches on (builder/field-dependency.js, the port of the
// app's `field_dependency_v556.py`), and the three places it is spent.
//
//   node tests/run-field-dependency.mjs            everything
//   node tests/run-field-dependency.mjs --quick    the arithmetic and the gate only
//
// THE COMPLAINT, in the owner's words: on their sand six the Suggestions list opened with
// "Swap Tyranitar-Mega -> Dragonite-Mega" at 100.0. Mega Tyranitar's Sand Stream is what makes
// Excadrill's Sand Rush 2x Speed, and the whole charge for taking it away was -0.9 -- less than
// the 1.48 the same term charges for losing Sneasler's Coaching.
//
// The app had a term for exactly this and lost it: `_v402_team_synergy` ends
// `+ support_bonus - unsupported_penalty` and the app's own V465 re-implemented team synergy in
// a later runtime part without carrying it forward. THIS SITE copied V465 and so never had the
// term at all -- which is why every recorded parity suite was green on it.
//
// What is checked here:
//
//   1. the graph: who sets what, who needs what, and the two things that are NOT dependencies
//      (a terrain under a Flying-type, a move that needs *any* field);
//   2. the measurement: the two races the field wins, and that a doubler buying nothing is
//      graded at V402's floor rather than its ceiling;
//   3. the term, in V402's shape, with every constant quoted from it;
//   4. BIT PARITY with the app's own pure core on the owner's team -- the floats below were
//      printed by `field_dependency_v556.py` at 17 significant figures;
//   5. the gate: a recorded replay computes nothing, and the recorded suites say so;
//   6. the three payments, measured end to end on the owner's team through this site's own
//      evaluation: the Synergy score, the swap target list, and the suggestion row's ledger.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const quick = process.argv.includes("--quick");

let checked = 0;
const failures = [];
const notes = [];
function ok(label, condition, detail = "") {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
}
function eq(label, got, want) {
  checked += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) failures.push(`${label}\n     got  ${a}\n     want ${b}`);
}
/** Bit equality, as the app printed it: 17 significant figures. */
function bits(label, got, want) {
  checked += 1;
  const a = Number(got).toPrecision(17);
  if (a !== want) failures.push(`${label}\n     got  ${a}\n     want ${want}`);
}

const fd = await import("../builder/field-dependency.js");
const {
  ABILITY_SUPPORT, AXES, HARD_GRADE, ITEM_SUPPORT, MOVE_SUPPORT, PLAIN_GRADE,
  PROBLEM_YELLOW_WEIGHT, SETTER_TABLE, SPEED_DOUBLERS, STRAND_CAP, SUPPORT_CAP,
  SUPPORT_CEILING, SUPPORT_FLOOR, SUPPORT_SHARE, SELF_CEILING, SELF_FLOOR, SELF_SHARE,
  WASTE_SHARE, abilityGrade, dependencies, dependencyDelta, fieldDependencyRuleOption,
  fieldGainSentence, fieldMember, fieldsSetBy, grounded, measure, measuredSeverity,
  outspeedCounts, payoffFromCounts, problemCredit, removalLoads, strandSentence, teamAdjustment,
} = fd;

// --- the owner's team, at the Speeds the app reports for these sets ------------------------
const META = [172, 154, 107, 70, 80, 152, 105, 184, 200, 195, 137, 117, 178, 80, 114, 135, 105,
  60, 189, 90, 80, 154, 152, 127, 140, 143, 80, 161, 189, 152];
const ownerTeam = () => [
  fieldMember("Salamence-Mega", ["Dragon", "Flying"], "Aerilate", "Salamencite",
    ["Hyper Voice", "Draco Meteor", "Flamethrower", "Protect"], 189),
  fieldMember("Tyranitar-Mega", ["Rock", "Dark"], "Sand Stream", "Tyranitarite",
    ["Rock Slide", "Knock Off", "Low Kick", "Protect"], 135),
  fieldMember("Corviknight", ["Flying", "Steel"], "Mirror Armor", "Psychic Seed",
    ["Brave Bird", "Power Trip", "Bulk Up", "Roost"], 104),
  fieldMember("Excadrill", ["Ground", "Steel"], "Sand Rush", "Focus Sash",
    ["Iron Head", "Protect", "Rock Slide", "High Horsepower"], 140),
  fieldMember("Indeedee", ["Psychic", "Normal"], "Psychic Surge", "Choice Scarf",
    ["Expanding Force", "Mystical Fire", "Trick", "Protect"], 161),
  fieldMember("Sneasler", ["Fighting", "Poison"], "Unburden", "Mental Herb",
    ["Dire Claw", "Close Combat", "Coaching", "Protect"], 172),
];
const dragonite = () => fieldMember("Dragonite-Mega", ["Dragon", "Flying"], "Multiscale",
  "Dragoninite", ["Protect", "Dragon Pulse", "Tailwind", "Heat Wave"], 152);
const afterTheSwap = () => { const team = ownerTeam(); team[1] = dragonite(); return team; };

// ---------------------------------------------------------------- 1. the graph

eq("the setter is found by its Ability", fieldsSetBy(ownerTeam()), { sand: [1], psychic: [4] });
{
  const moved = ownerTeam();
  moved[1] = fieldMember("Gigalith", ["Rock"], "Sturdy", "Leftovers",
    ["Sandstorm", "Rock Slide", "Protect", "Wide Guard"], 55);
  eq("...and by a move, from the same V187 table", fieldsSetBy(moved).sand, [1]);
}
{
  const rows = dependencies(ownerTeam());
  const sand = rows.filter((row) => row.field === "sand");
  ok("the sand engine is one dependency with one setter", sand.length === 1, JSON.stringify(sand));
  eq("...pointing at Excadrill's Sand Rush",
    [sand[0].slot, sand[0].name, sand[0].kind, sand[0].label, sand[0].setters, sand[0].self_set],
    [3, "Excadrill", "speed", "Sand Rush", [1], false]);
  // Corviknight's Psychic Seed is dead on this team whatever Indeedee does, and the rule that
  // says so is the one that refuses a Flying-type a terrain seed in the set builder.
  ok("a terrain cannot reach a Flying-type", grounded(["Flying", "Steel"]) === false);
  eq("...so there is no dependency to strand", rows.filter((row) => row.slot === 2), []);
  const psychic = rows.filter((row) => row.field === "psychic");
  eq("a move dependency is a share of the holder's moves",
    [psychic.length, psychic[0].kind, psychic[0].label, psychic[0].grade, psychic[0].self_set],
    [1, "move", "Expanding Force", PLAIN_GRADE / 4, true]);
}
{
  const team = ownerTeam();
  team[0] = fieldMember("Torkoal", ["Fire"], "Drought", "Charcoal",
    ["Weather Ball", "Eruption", "Protect", "Body Press"], 40);
  eq("a move needing *any* field is not a dependency on one setter",
    dependencies(team).filter((row) => row.slot === 0), []);
}
{
  const team = ownerTeam();
  team[3] = fieldMember("Excadrill", ["Ground", "Steel"], "Sand Rush", "Smooth Rock",
    ["Iron Head", "Protect", "Rock Slide", "High Horsepower"], 140);
  const rows = dependencies(team).filter((row) => row.slot === 3);
  eq("one member needing the same field twice is one dependency at the higher grade",
    [rows.length, rows[0].kind, rows[0].grade], [1, "speed", HARD_GRADE]);
}

// ---------------------------------------------------------------- 2. the measurement

{
  const counts = outspeedCounts(140, 2.0, META);
  eq("the payoff is the two races the field wins",
    [counts.meta, counts.plain_without, counts.plain_with, counts.tailwind_without,
      counts.tailwind_with, counts.gained, counts.gained_tailwind],
    [30, 15, 30, 1, 15, 15, 14]);
  bits("...and the share of them", payoffFromCounts(counts), (29 / 60).toPrecision(17));
}
ok("a doubler that buys nothing measures nothing",
  payoffFromCounts(outspeedCounts(500, 2.0, META)) === 0
  && measuredSeverity(HARD_GRADE, 0) === PLAIN_GRADE);
ok("a doubler that buys everything keeps V402's own number",
  measuredSeverity(HARD_GRADE, 1) === HARD_GRADE
  && measuredSeverity(HARD_GRADE, 0.5) > PLAIN_GRADE
  && measuredSeverity(HARD_GRADE, 0.5) < HARD_GRADE);
eq("only the five Speed Abilities are measured", Object.keys(SPEED_DOUBLERS).sort(),
  ["chlorophyll", "sandrush", "slushrush", "surgesurfer", "swiftswim"]);
eq("...and every other field Ability keeps V402's flat grade",
  [abilityGrade("sandforce"), abilityGrade("solarpower"), abilityGrade("raindish"),
    abilityGrade("sandrush")], [6.0, 7.0, PLAIN_GRADE, HARD_GRADE]);
{
  const team = ownerTeam();
  team[3] = fieldMember("Excadrill", ["Ground", "Steel"], "Sand Force", "Focus Sash",
    ["Iron Head", "Protect", "Rock Slide", "High Horsepower"], 140);
  const row = measure(dependencies(team), team, META).find((r) => r.field === "sand");
  eq("...unmeasured, at its own grade", [row.kind, row.payoff, row.severity], ["ability", null, 6.0]);
}

// ---------------------------------------------------------------- 3. the term, in V402's shape

eq("every constant in the term is V402's",
  [SUPPORT_SHARE, SUPPORT_FLOOR, SUPPORT_CEILING, SELF_SHARE, SELF_FLOOR, SELF_CEILING,
    SUPPORT_CAP, STRAND_CAP, PLAIN_GRADE, HARD_GRADE],
  [0.55, 2.0, 6.0, 0.22, 1.0, 2.5, 14.0, 24.0, 4.0, 10.0]);
{
  const team = ownerTeam();
  team[0] = fieldMember("Gigalith", ["Rock"], "Sand Stream", "Leftovers",
    ["Rock Slide", "Protect", "Wide Guard", "Body Press"], 55);
  const after = [...team];
  after[1] = dragonite();
  ok("a second setter makes the swap free",
    dependencyDelta(teamAdjustment(team, META), teamAdjustment(after, META)) === 0);
}
{
  const stranded = afterTheSwap();
  const repaired = [...stranded];
  repaired[1] = fieldMember("Tyranitar", ["Rock", "Dark"], "Sand Stream", "Assault Vest",
    ["Rock Slide", "Knock Off", "Low Kick", "Crunch"], 81);
  ok("a candidate that brings a missing field is PAID for it -- the term is a measurement, not a tax",
    dependencyDelta(teamAdjustment(stranded, META), teamAdjustment(repaired, META)) > 0);
  eq("...and says so", fieldGainSentence(teamAdjustment(stranded, META).dependencies, "Tyranitar"),
    "Tyranitar sets sand, which Excadrill's Sand Rush has been waiting for.");
}
{
  const team = Array.from({ length: 6 }, (_, i) => fieldMember(`Drill ${i}`, ["Ground"],
    "Sand Rush", "Focus Sash", ["Iron Head", "Protect"], 100));
  ok("V402's caps are the caps, and they bind",
    teamAdjustment(team, META).stranded === STRAND_CAP);
  const supported = [...team];
  supported[0] = fieldMember("Tyranitar-Mega", ["Rock", "Dark"], "Sand Stream", "Tyranitarite",
    ["Rock Slide", "Protect"], 135);
  ok("...on the support side too", teamAdjustment(supported, META).support === SUPPORT_CAP);
}
eq("a dependent that is removed costs half of one that is stranded", WASTE_SHARE, 0.5);
eq("the load is worth at most one yellow check, which is what removing a sole setter breaks",
  [PROBLEM_YELLOW_WEIGHT, problemCredit(0), problemCredit(HARD_GRADE), problemCredit(1000)],
  [2.25, 0, 2.25, 2.25]);
eq("a row reaches the score at the quarter weight every axis already gets", AXES, 4);

// ------------------------------------- 4. BIT PARITY with the app's own pure core
//
// Printed by `field_dependency_v556.py` on the same team at 17 significant figures. The
// rounding is the reason this is asserted at all: `round(4.795, 2)` is 4.79 in Python and
// `Math.round(4.795 * 100) / 100` is 4.8 in JavaScript, and the owner's support bonus is
// exactly 4.795 -- so nothing on the scoring path is rounded on either side.
{
  const before = teamAdjustment(ownerTeam(), META);
  const after = teamAdjustment(afterTheSwap(), META);
  bits("the support bonus is the app's, to the bit", before.support, "4.7949999999999999");
  bits("nothing is stranded before the swap", before.stranded, "0.0000000000000000");
  bits("the stranded penalty is the app's, to the bit", after.stranded, "6.9000000000000004");
  bits("the adjustment after the swap", after.adjustment, "-5.9000000000000004");
  bits("the delta the suggestion is charged", dependencyDelta(before, after), "-10.695000000000000");
  eq("the removal loads are the app's, to the bit",
    removalLoads(ownerTeam(), META).map((value) => Number(value).toPrecision(17)),
    ["0.0000000000000000", "6.9000000000000004", "0.0000000000000000", "3.4500000000000002",
      "0.50000000000000000", "0.0000000000000000"]);
  eq("and so is the sentence", strandSentence(after.dependencies, "Tyranitar-Mega"),
    "Tyranitar-Mega is the team's only sand, and Excadrill's Sand Rush needs it "
    + "-- worth 15 of 30 Top-Meta Speed tiers and 14 of 30 into an opposing Tailwind.");
  eq("nothing stranded says nothing",
    [strandSentence(before.dependencies, "Tyranitar-Mega"),
      fieldGainSentence(before.dependencies, "Anything")], ["", ""]);
}

// ---------------------------------------------------------------- 5. the gate

ok("an absent option means production", fieldDependencyRuleOption(undefined) === 1
  && fieldDependencyRuleOption(null) === 1);
for (const off of [0, "0", false, "off", "false", "no", "none", ""]) {
  ok(`${JSON.stringify(off)} turns it off`, fieldDependencyRuleOption(off) === 0,
    String(fieldDependencyRuleOption(off)));
}
for (const on of [1, "1", true, "7"]) {
  ok(`${JSON.stringify(on)} leaves it on`, fieldDependencyRuleOption(on) === 1);
}
{
  // Every recorded vector was made by the Companion before this rule, so the three suites that
  // replay one must switch it off -- a recording judged by a rule it predates is compared
  // against a world that never existed.
  for (const suite of ["run-eval-vectors.mjs", "run-suggest-vectors.mjs", "run-autobuild-vectors.mjs"]) {
    const text = readFileSync(join(here, suite), "utf8");
    ok(`${suite} replays with the rule off`, text.includes("fieldDependencyRule: 0"));
  }
  // ...and the swap-basis invariant is stated net of this term, because it is a replacement
  // cost and not a baseline error.
  const basis = readFileSync(join(here, "run-swap-basis.mjs"), "utf8");
  ok("run-swap-basis states the invariant net of the term",
    basis.includes("field_dependency_term_v556"));
}
{
  // The tables moved into this module so the graph and the set repair cannot read two
  // different vocabularies; `team-suggest.js` re-exports the move table under its old name.
  const suggest = await import("../builder/team-suggest.js");
  eq("the move table is the one team-autobuild.js imports", suggest.MOVES_NEEDING_SUPPORT, MOVE_SUPPORT);
  eq("the three tables are the ones field_synergy carries",
    [Object.keys(ABILITY_SUPPORT).length, Object.keys(ITEM_SUPPORT).length,
      Object.keys(MOVE_SUPPORT).length, Object.keys(SETTER_TABLE).length], [12, 9, 13, 8]);
  ok("sand is set by Sand Stream, Sand Spit and Sandstorm",
    SETTER_TABLE.sand.includes("sandstream") && SETTER_TABLE.sand.includes("sandstorm"));
}

// ---------------------------------------------------------------- 6. the three payments, measured

if (quick) {
  notes.push("--quick: the measured run on the owner's team was skipped.");
} else {
  const { DamageEngine } = await import("../builder/engine.js");
  const { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } = await import("../builder/team-eval.js");
  const { TeamEvaluation } = await import("../builder/team-payload.js");
  const { KnownTeams } = await import("../builder/known-teams.js");
  const { makeSet } = await import("../builder/common.js");
  const { TeamSuggestions, SUGGESTION_SCORING } = await import("../builder/team-suggest.js");
  const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));
  const appData = read("data", "builder", "app-data.json");
  const meta = read("data", "builder", "meta-doubles.json");
  const known = new KnownTeams(read("data", "builder", "known-teams.json"));
  const ranked = (meta.pokemon || []).filter((r) => Number(r.position) < 999999).length;

  const SAND = [
    { species: "Salamence", form: "Mega Salamence", item: "Salamencite", ability: "Aerilate", nature: "Timid", moves: ["Hyper Voice", "Draco Meteor", "Flamethrower", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Tyranitar", form: "Mega Tyranitar", item: "Tyranitarite", ability: "Sand Stream", nature: "Jolly", moves: ["Rock Slide", "Knock Off", "Low Kick", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
    { species: "Corviknight", form: "Corviknight", item: "Psychic Seed", ability: "Mirror Armor", nature: "Careful", moves: ["Brave Bird", "Power Trip", "Bulk Up", "Roost"], bonuses: [0, 32, 0, 0, 2, 32] },
    { species: "Excadrill", form: "Excadrill", item: "Focus Sash", ability: "Sand Rush", nature: "Adamant", moves: ["Iron Head", "Protect", "Rock Slide", "High Horsepower"], bonuses: [0, 32, 1, 0, 1, 32] },
    { species: "Indeedee", form: "Indeedee", item: "Choice Scarf", ability: "Psychic Surge", nature: "Modest", moves: ["Expanding Force", "Mystical Fire", "Trick", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Sneasler", form: "Sneasler", item: "Mental Herb", ability: "Unburden", nature: "Adamant", moves: ["Dire Claw", "Close Combat", "Coaching", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
  ];
  const DRAGONITE = { species: "Dragonite", form: "Mega Dragonite", item: "Dragoninite", ability: "Multiscale", nature: "Modest", moves: ["Protect", "Dragon Pulse", "Tailwind", "Heat Wave"], bonuses: [2, 0, 0, 32, 0, 32] };

  const evaluationFor = (rule) => {
    const ev = new TeamEvaluator(null, new DamageEngine(appData), "Doubles",
      normalizeSettings({ ...DEFAULT_SETTINGS }, ranked), { fieldDependencyRule: rule });
    ev.setMetaRecords(meta.pokemon || []);
    const evaluation = new TeamEvaluation(ev);
    evaluation.knownTeams = known;
    return evaluation;
  };
  const payloadFor = (team, rule) => evaluationFor(rule).evaluate(
    Array.from({ length: 6 }, (_, i) => makeSet(team[i])), { checkSelection: null });

  // --- payment one: the Synergy score -----------------------------------------------------
  const projected = [SAND[0], DRAGONITE, ...SAND.slice(2)];
  const offBefore = payloadFor(SAND, 0).synergy;
  const offAfter = payloadFor(projected, 0).synergy;
  const onBefore = payloadFor(SAND, undefined).synergy;
  const onAfter = payloadFor(projected, undefined).synergy;
  notes.push(`Synergy  rule off: ${offBefore.score} -> ${offAfter.score} `
    + `(${(offAfter.score - offBefore.score).toFixed(1)})`);
  notes.push(`Synergy  rule ON : ${onBefore.score} -> ${onAfter.score} `
    + `(${(onAfter.score - onBefore.score).toFixed(1)})`);
  ok("with the rule off the sand engine is worth nothing to Synergy",
    Math.abs(offAfter.score - offBefore.score) < 4.0,
    `${offBefore.score} -> ${offAfter.score}`);
  ok("with it on, losing the sand costs four times as much",
    (onBefore.score - onAfter.score) > 3 * (offBefore.score - offAfter.score),
    `${onBefore.score} -> ${onAfter.score}`);
  ok("the live engine is paid for", onBefore.score > offBefore.score,
    `${offBefore.score} vs ${onBefore.score}`);
  ok("and the stranded one is charged", onAfter.score < offAfter.score,
    `${offAfter.score} vs ${onAfter.score}`);
  ok("the rule off writes no field at all", !offBefore.field_dependency_v556
    && !offBefore.field_dependencies && Boolean(onBefore.field_dependency_v556));
  eq("the numbers V402 wrote and V465 dropped are back in `calculation`",
    [typeof onBefore.calculation.field_support_bonus,
      typeof onBefore.calculation.unsupported_field_ability_penalty],
    ["number", "number"]);

  // --- payment two: which slots are offered as swap targets -------------------------------
  const targetsFor = (rule) => {
    const payload = payloadFor(SAND, rule);
    const sg = new TeamSuggestions(evaluationFor(rule), { suggestionScoring: SUGGESTION_SCORING });
    const teamSlots = (payload.slots || []).map(({ entry, mon, set }) => ({
      entry: { ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }, mon, set }));
    return sg.swapTargets({
      payload, teamSlots, teamEntries: teamSlots.map(({ entry }) => entry),
      activeNames: teamSlots.map(({ entry, mon }) => sg.name(mon.form_name || entry.form || entry.pokemon)),
    });
  };
  const targetsOff = targetsFor(0);
  const targetsOn = targetsFor(undefined);
  notes.push(`swap targets  rule off: ${targetsOff.join(", ")}`);
  notes.push(`swap targets  rule ON : ${targetsOn.join(", ")}`);
  ok("the old target list offered the team's only sand setter",
    targetsOff.includes("Tyranitar-Mega"), targetsOff.join(", "));
  ok("the new one does not", !targetsOn.includes("Tyranitar-Mega"), targetsOn.join(", "));
  ok("it still offers three real slots", targetsOn.length === 3
    && targetsOn.every((name) => ["Salamence-Mega", "Tyranitar-Mega", "Corviknight", "Excadrill",
      "Indeedee", "Sneasler"].includes(name)), targetsOn.join(", "));

  // --- payment three: the suggestion row --------------------------------------------------
  //
  // Scored at the target the old list offered, so the row the owner actually saw is the row
  // measured here -- `run` would no longer produce it, which is the point of payment two.
  const rowFor = (rule, target, candidateName) => {
    const payload = payloadFor(SAND, rule);
    const sg = new TeamSuggestions(evaluationFor(rule), { suggestionScoring: SUGGESTION_SCORING });
    const teamSlots = (payload.slots || []).map(({ entry, mon, set }) => ({
      entry: { ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }, mon, set }));
    const activeNames = teamSlots.map(({ entry, mon }) => sg.name(mon.form_name || entry.form || entry.pokemon));
    const context = { payload, teamSlots, teamEntries: teamSlots.map(({ entry }) => entry),
      activeNames, emptySlot: null, selection: null, selected: sg.checks.selectedIds(null), swapTarget: "" };
    const candidate = [...sg.candidates(payload, activeNames)]
      .find((meta) => new RegExp(candidateName, "i").test(String(meta.name || "")));
    if (!candidate) return null;
    const basis = sg.basisFor(context, target);
    return sg.evaluateCandidate(structuredClone(candidate), { ...context, swapTarget: target,
      basisPayload: basis?.payload, basisSlots: basis?.slots, basisEntries: basis?.entries });
  };
  const rowOff = rowFor(0, "Tyranitar-Mega", "Dragonite");
  const rowOn = rowFor(undefined, "Tyranitar-Mega", "Dragonite");
  ok("the row exists both ways", Boolean(rowOff) && Boolean(rowOn));
  if (rowOff && rowOn) {
    const synOff = rowOff.suggestion_score_components_v318?.synergy || {};
    const synOn = rowOn.suggestion_score_components_v318?.synergy || {};
    notes.push(`Dragonite for Tyranitar-Mega: score ${rowOff.score} -> ${rowOn.score}, `
      + `Syn delta ${synOff.delta} -> ${synOn.delta}, term ${rowOn.field_dependency_term_v556}`);
    ok("the old row read the swap as a Synergy GAIN", Number(synOff.delta) > 0, String(synOff.delta));
    ok("the new one reads it as the loss it is", Number(synOn.delta) < 0, String(synOn.delta));
    ok("the row is charged the term", Number(rowOn.field_dependency_term_v556) < -1.0,
      String(rowOn.field_dependency_term_v556));
    ok("and the score falls by it", rowOn.score < rowOff.score, `${rowOff.score} -> ${rowOn.score}`);
    const piece = (rowOn.score_ledger || []).find((row) => row.key === "field_dependency_v556");
    ok("the ledger names what is stranded", Boolean(piece)
      && String(piece.detail).includes("Excadrill's Sand Rush"), JSON.stringify(piece));
    ok("the old ledger says nothing about it",
      !(rowOff.score_ledger || []).some((row) => row.key === "field_dependency_v556"));
    // the term and the component cannot disagree: both are the same delta
    ok("the Syn line and the ledger line are the same number",
      Math.abs((Number(synOn.delta) - Number(synOff.delta)) / AXES
        - Number(rowOn.field_dependency_term_v556)) < 0.06,
      `${synOff.delta} ${synOn.delta} ${rowOn.field_dependency_term_v556}`);
  }
  // A swap that strands nothing is charged nothing, measured on the same team.
  const innocent = rowFor(undefined, "Corviknight", "Dragonite");
  ok("a swap that strands nothing is charged nothing",
    Boolean(innocent) && !innocent.field_dependency_term_v556,
    String(innocent && innocent.field_dependency_term_v556));
}

for (const line of notes) console.log(line);
if (failures.length) {
  console.error(`\n${failures.length} of ${checked} checks failed:\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nall ${checked} checks passed`);
