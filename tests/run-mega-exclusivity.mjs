// V559: one Mega happens, so the third stone is a promise the team cannot keep
// (builder/mega-exclusivity.js, the port of the app's `mega_exclusivity_v559.py`), and the
// three places it is spent.
//
//   node tests/run-mega-exclusivity.mjs            everything
//   node tests/run-mega-exclusivity.mjs --quick    the arithmetic and the gate only
//
// THE COMPLAINT, in the owner's words: on their sand six the Suggestions list offered
//
//     Swap Corviknight -> Dragonite-Mega          93.6
//     Syn +5.1   Off +10.9   Def +7.1   Spe +12.5
//
// "but this make the team have 3 Megas which is bad".
//
// They are right and this codebase already says so, twice, in its own words:
// `analysis.js:390` ("One Mega Evolution per battle: two stones is flexibility, three is
// waste") refuses a Mega candidate in the Explorer's beam search once two are placed, and
// `team-autobuild.js:291` drops Mega-stone candidates at MAX_MEGA_STONES. Suggestions obeyed
// neither -- and it priced the candidate as its MEGA, which is where the +12.5 Speed came from.
//
// What is checked here:
//
//   1. the arithmetic, with no data: who carries a stone, the count after a swap, the waste
//      beyond the cap, the share of a battle each stone gets, and the two sentences;
//   2. the three constants, each against the thing it quotes (MAX_MEGA_STONES, V402's
//      HARD_GRADE through V556, and the +100 measured over all 81 Mega forms in app-data);
//   3. BIT PARITY with the app's own pure core -- the floats below were printed by
//      `mega_exclusivity_v559.py` at 17 significant figures;
//   4. the gate: the option coercion, and that the recorded suites replay with it off;
//   5. the three payments, measured end to end on the owner's team through this site's own
//      evaluation: the Suggestions refusal, the checks layer that could not see the Mega row,
//      and the Synergy charge;
//   6. that "Why it fits" shows every reason, with no cap and no toggle.
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

const mx = await import("../builder/mega-exclusivity.js");
const {
  DEAD_STONE_GRADE, MAX_STONES, MEGA_EXCLUSIVITY_RULE, MEGA_STAT_UPGRADE, USED_PER_BATTLE,
  WASTE_CAP, brokenPromises, megaExclusivityOn, megaExclusivityRuleOption, megaMember,
  membersFromEntries, overCap, projectedCount, refusalSentence, refuses, refusesRow, rowIsStone,
  slotOf, stoneCount, stoneNames, teamAdjustment, teamTerm, usableShare, waste, wasteSentence,
} = mx;

// --- 1. the arithmetic ---------------------------------------------------------------------

const SIX = [
  megaMember("Salamence-Mega", true, "Salamencite"),
  megaMember("Tyranitar-Mega", true, "Tyranitarite"),
  megaMember("Corviknight", false, "Psychic Seed"),
  megaMember("Excadrill", false, "Focus Sash"),
  megaMember("Indeedee", false, "Choice Scarf"),
  megaMember("Sneasler", false, "Mental Herb"),
];

eq("the owner's team carries two stones", stoneCount(SIX), 2);
eq("and they are named", stoneNames(SIX), ["Salamence-Mega", "Tyranitar-Mega"]);
eq("a stone for a stone keeps the count", projectedCount(SIX, 0, true), 2);
eq("a stone for a NON-stone raises it", projectedCount(SIX, 2, true), 3);
eq("a non-stone for a stone lowers it", projectedCount(SIX, 0, false), 1);
eq("an add keeps every stone", projectedCount(SIX, -1, true), 3);
eq("a slot past the team is an add", projectedCount(SIX, 99, true), 3);

eq("nothing is wasted at or under the cap", [waste(0), waste(1), waste(2)], [0, 0, 0]);
eq("the third stone is the first waste", waste(3), 1);
eq("and the fourth is the second", waste(4), 2);
ok("over_cap agrees with waste", !overCap(2) && overCap(3) && overCap(6));

// `broken_promises` is k - 1, which is NOT what is charged: two stones is the price of
// choosing, and the builder calls that flexibility.
eq("one stone breaks no promise", brokenPromises(1), 0);
eq("two break one", brokenPromises(2), 1);
eq("three break two", brokenPromises(3), 2);
ok("but two are charged nothing", teamTerm(2)[0] === 0, String(teamTerm(2)[0]));

eq("a lone stone is the Mega every battle", usableShare(1), 1);
eq("two share it", usableShare(2), 0.5);
eq("no stone, no share", usableShare(0), 0);

eq("the charge at three stones", teamTerm(3), [-10, 1, 2]);
eq("the charge at four", teamTerm(4), [-20, 2, 3]);
eq("the cap binds at five", teamTerm(5), [-WASTE_CAP, 3, 4]);
ok("and it is the only bound that binds", teamTerm(6)[0] === -WASTE_CAP);

// The refusal. A swap that does not ADD a stone is never refused, and neither is a swap that
// leaves an over-cap team no worse -- a team already carrying three must still be shown a
// way out of it.
ok("a candidate with no stone is never refused", !refuses(SIX, 2, false));
ok("a stone for a stone is not refused", !refuses(SIX, 0, true));
ok("a stone for a NON-stone on a two-stone team is", refuses(SIX, 2, true));
const ONE = [SIX[0], ...SIX.slice(2)];
ok("the same swap on a ONE-stone team is not", !refuses(ONE, 1, true), String(stoneCount(ONE)));
const THREE = [SIX[0], SIX[1], megaMember("Dragonite-Mega", true, "Dragoninite"), ...SIX.slice(3)];
ok("a three-stone team keeps its way out", !refuses(THREE, 2, true), String(stoneCount(THREE)));
ok("but is refused a FOURTH", refuses(THREE, 3, true));

eq("a team at the cap gets no sentence", wasteSentence(2, stoneNames(SIX)), "");
eq("a three-stone team names its stones", wasteSentence(3, stoneNames(THREE)),
  "3 Mega Stones and one Mega per battle: 1 of Salamence-Mega, Tyranitar-Mega, Dragonite-Mega "
  + "is dead weight (every Mega is +100 base-stat points).");
eq("the refusal says which stone and whose slot",
  refusalSentence("Mega Dragonite", "Corviknight", 3, stoneNames(SIX)),
  "Mega Dragonite would be Mega Stone 3 and only one Mega happens per battle, so taking "
  + "Corviknight, which carries none, leaves a stone that can never be used "
  + "(already: Salamence-Mega, Tyranitar-Mega).");

eq("the report over a member list", (({ sentence, ...rest }) => rest)(teamAdjustment(THREE)),
  { stones: 3, dead: 1, broken: 2, adjustment: -10,
    names: ["Salamence-Mega", "Tyranitar-Mega", "Dragonite-Mega"], usable_share: 1 / 3 });

// --- 2. the constants, each against what it quotes -----------------------------------------

const autobuild = await import("../builder/team-autobuild.js");
eq("MAX_STONES is MAX_MEGA_STONES", MAX_STONES, autobuild.MAX_MEGA_STONES);
const fd = await import("../builder/field-dependency.js");
eq("the grade is V402's HARD_GRADE, quoted through V556", DEAD_STONE_GRADE, fd.HARD_GRADE);
eq("one Mega happens per battle", USED_PER_BATTLE, 1);
eq("the cap is two dead stones", WASTE_CAP, 2 * DEAD_STONE_GRADE);

// The +100 is a MEASUREMENT, so it is re-measured here rather than trusted. Every Mega form in
// app-data is exactly this much above its base form; if a future data drop breaks that, the
// flat grade stops being the honest shape and this check says so.
{
  const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
  const forms = new Map();
  for (const rec of appData.species || []) for (const f of rec.forms || []) forms.set(String(f.form).toLowerCase(), f);
  const total = (name) => {
    const f = forms.get(String(name).toLowerCase());
    return f ? Object.values(f.stats).reduce((a, b) => a + Number(b || 0), 0) : null;
  };
  const megas = [...forms.values()].filter((f) => /mega/i.test(String(f.kind || "")));
  const ups = [];
  for (const m of megas) {
    const base = total(String(m.form).replace(/^Mega\s+/i, ""));
    const mega = total(m.form);
    if (base && mega) ups.push(mega - base);
  }
  notes.push(`Mega forms: ${megas.length}, measurable pairs: ${ups.length}, `
    + `upgrades: ${[...new Set(ups)].sort((a, b) => a - b).join("/")}`);
  ok("there are 81 Mega forms", megas.length === 81, String(megas.length));
  ok("every measurable one is +100 base-stat points",
    ups.length >= 70 && ups.every((v) => v === MEGA_STAT_UPGRADE),
    `${ups.length} pairs, distinct ${[...new Set(ups)].join("/")}`);
}

// --- 3. bit parity with the app's own core -------------------------------------------------
//
// Printed by `mega_exclusivity_v559.py`. Every number this rule produces is an integer or an
// integer quotient, so the V556 rounding trap (`round(4.795, 2)` is 4.79 in Python and 4.8 in
// JS) cannot arise here -- these are asserted anyway, because that is cheaper than arguing it.

bits("the charge at three stones", teamTerm(3)[0], "-10.000000000000000");
bits("the charge at four", teamTerm(4)[0], "-20.000000000000000");
bits("the share at three", usableShare(3), "0.33333333333333331");
bits("the share at five", usableShare(5), "0.20000000000000001");
bits("the share at six", usableShare(6), "0.16666666666666666");

// --- 4. the gate ---------------------------------------------------------------------------

ok("an absent option means production", megaExclusivityRuleOption(undefined) === MEGA_EXCLUSIVITY_RULE
  && megaExclusivityRuleOption(null) === MEGA_EXCLUSIVITY_RULE);
for (const off of [0, "0", false, "off", "false", "no", "none", ""]) {
  ok(`${JSON.stringify(off)} turns it off`, megaExclusivityRuleOption(off) === 0,
    String(megaExclusivityRuleOption(off)));
}
for (const on of [1, "1", true, "on", 2]) {
  ok(`${JSON.stringify(on)} leaves it on`, megaExclusivityRuleOption(on) === 1);
}
ok("the evaluator is read, not a global", megaExclusivityOn({ megaExclusivityRule: 0 }) === false
  && megaExclusivityOn({}) === true && megaExclusivityOn(null) === true);

for (const suite of ["run-eval-vectors.mjs", "run-suggest-vectors.mjs", "run-autobuild-vectors.mjs"]) {
  const text = readFileSync(join(root, "tests", suite), "utf8");
  ok(`${suite} replays with the rule off`, text.includes("megaExclusivityRule: 0"));
}

// --- 6. the view shows every reason --------------------------------------------------------
//
// A source check and not a rendered one: `suggest-view.js` builds DOM through `ui.js`, which
// needs a document. What is asserted is the requirement itself -- there is no cap and no
// toggle -- rather than a count of lines some fixture happens to produce.
{
  const raw = readFileSync(join(root, "builder", "suggest-view.js"), "utf8");
  // Comments stripped first: this file's own history is written in them, and a check that a
  // button is gone must not be satisfiable by deleting the sentence that explains why.
  const view = raw.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, "")).join("\n");
  ok("the impact list has no cap", !/IMPACT_LIMIT/.test(view));
  ok("and no Show all / Show fewer button", !/Show all|Show fewer|bd-sg-more/.test(view),
    (view.match(/.*(Show all|Show fewer|bd-sg-more).*/) || [""])[0].trim());
  ok("Why it fits maps every impact", /section\("Why it fits", list\)/.test(view));
  const css = readFileSync(join(root, "builder", "suggest.css"), "utf8");
  ok("the toggle's styling went with it", !/bd-sg-more/.test(css));
}

if (quick) {
  report();
} else {
  // --- 5. the three payments, end to end --------------------------------------------------
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
  // The team the refused row would have made: Corviknight's Psychic Seed swapped for a third
  // stone. The set is the one the owner was shown.
  const DRAGONITE = { species: "Dragonite", form: "Mega Dragonite", item: "Dragoninite", ability: "Multiscale", nature: "Modest", moves: ["Protect", "Dragon Pulse", "Tailwind", "Heat Wave"], bonuses: [2, 0, 0, 32, 0, 32] };
  const THREE_STONES = [SAND[0], SAND[1], DRAGONITE, ...SAND.slice(3)];

  const evaluationFor = (rule) => {
    const ev = new TeamEvaluator(null, new DamageEngine(appData), "Doubles",
      normalizeSettings({ ...DEFAULT_SETTINGS }, ranked), { megaExclusivityRule: rule });
    ev.setMetaRecords(meta.pokemon || []);
    const evaluation = new TeamEvaluation(ev);
    evaluation.knownTeams = known;
    return evaluation;
  };
  const payloadFor = (team, rule) => evaluationFor(rule).evaluate(
    Array.from({ length: 6 }, (_, i) => makeSet(team[i])), { checkSelection: null });

  // --- payment one: the Synergy charge ----------------------------------------------------
  const twoOff = payloadFor(SAND, 0).synergy;
  const twoOn = payloadFor(SAND, undefined).synergy;
  const threeOff = payloadFor(THREE_STONES, 0).synergy;
  const threeOn = payloadFor(THREE_STONES, undefined).synergy;
  notes.push(`Synergy  two stones: ${twoOff.score} -> ${twoOn.score}   `
    + `three stones: ${threeOff.score} -> ${threeOn.score}`);
  eq("a team at the cap is untouched", twoOn.score, twoOff.score);
  ok("a three-stone team is charged the dead stone",
    Math.abs((threeOff.score - threeOn.score) - DEAD_STONE_GRADE) < 0.051,
    `${threeOff.score} -> ${threeOn.score}`);
  eq("the calculation names the charge",
    threeOn.calculation.mega_exclusivity_waste_penalty, -DEAD_STONE_GRADE);
  eq("and how many stones it counted", threeOn.calculation.mega_stones_held, 3);
  eq("the rule off writes no penalty into the calculation",
    [threeOff.calculation.mega_exclusivity_waste_penalty, Boolean(threeOff.mega_exclusivity_v559)],
    [undefined, false]);
  eq("the report rides on the payload", (({ ...r }) => r)(threeOn.mega_exclusivity_v559),
    { stones: 3, dead: 1, broken: 2, adjustment: -10 });
  // A two-stone team still gets the report, saying it owes nothing -- a reader of the payload
  // can tell "no stones counted" from "the rule did not run".
  eq("a team at the cap still reports its count",
    (({ ...r }) => r)(twoOn.mega_exclusivity_v559), { stones: 2, dead: 0, broken: 1, adjustment: 0 });

  // --- payment two: the checks layer that could not see the Mega row ----------------------
  //
  // "mega" is in neither `allCheckIds()` nor `checkList()`, and `snapshot()` counts pressure,
  // warnings and reds over the SELECTED ids only -- so the Mega Options row was shown and
  // scored zero. Of the two layers that price a check movement on a suggestion row, only
  // V418's `checks_new` ever saw a team go from two Megas to three.
  const checksOf = (rule) => {
    const sg = new TeamSuggestions(evaluationFor(rule), { suggestionScoring: SUGGESTION_SCORING });
    return sg.checks;
  };
  const tcOff = checksOf(0);
  const tcOn = checksOf(undefined);
  ok("the Mega row was unselectable", !tcOff.allCheckIds().includes("mega")
    && !tcOff.selectedIds(null).has("mega") && !tcOff.selectedIds(["mega"]).has("mega"));
  ok("with the rule on it is always selected", tcOn.selectedIds(null).has("mega")
    && tcOn.selectedIds(["speed_tiers"]).has("mega"));
  ok("an empty selection stays empty, so `checks_disabled` is still reachable",
    tcOn.selectedIds([]).size === 0);
  eq("Customize is not given a new row", tcOn.checkList().map((c) => c.id),
    tcOff.checkList().map((c) => c.id));
  // The one caller that COUNTS the selection rather than reading it: `checksSummary` in
  // builder-page.js is "N of 13 in use", and "mega" is selected but not listed, so counting
  // the whole set would have read "14 of 13".
  {
    const listed = (tc) => tc.checkList().filter((row) => tc.selectedIds(null).has(row.id)).length;
    eq("the Customize summary still counts the listed checks", [listed(tcOn), tcOn.checkList().length],
      [listed(tcOff), tcOff.checkList().length]);
    ok("and the selected set really is one larger",
      tcOn.selectedIds(null).size === tcOff.selectedIds(null).size + 1,
      `${tcOff.selectedIds(null).size} -> ${tcOn.selectedIds(null).size}`);
    const page = readFileSync(join(root, "builder", "builder-page.js"), "utf8");
    ok("and builder-page counts over the list", /checkList\(\)\.filter\(\(row\) => selected\.has\(row\.id\)\)/.test(page));
  }
  {
    const slotsOf = (payload) => (payload.slots || []).map(({ entry, mon, set }) => ({
      entry: { ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }, mon, set }));
    const snapOff = tcOff.snapshot(slotsOf(payloadFor(THREE_STONES, 0)), null, {});
    const snapOn = tcOn.snapshot(slotsOf(payloadFor(THREE_STONES, undefined)), null, {});
    notes.push(`three-stone checks  reds ${snapOff.red_count} -> ${snapOn.red_count}, `
      + `pressure ${snapOff.check_pressure.toFixed(2)} -> ${snapOn.check_pressure.toFixed(2)}`);
    eq("the red the Mega row always was now counts", snapOn.red_count, snapOff.red_count + 1);
    ok("and its pressure with it",
      Math.abs((snapOn.check_pressure - snapOff.check_pressure) - 4.4) < 0.001,
      `${snapOff.check_pressure} -> ${snapOn.check_pressure}`);
    const megaRow = (snapOn.rows || []).find((r) => String(r.check_id || r.kind || "").toLowerCase() === "mega");
    ok("the row itself is unchanged", Boolean(megaRow) && megaRow.severity === "red"
      && /too many competing Mega options/.test(String(megaRow.text || megaRow.summary || "")));
  }
  // The OTHER red this check has always shown and never scored: a team with no Mega at all.
  // `_v494_mega_stone_slots` is what lineup generation reads, so a team with no stone cannot
  // produce a Lead/Back plan -- that red is worth counting too, and counting it is how a
  // Suggestions row that fixes it finally gets credit.
  {
    const NO_MEGA = [SAND[2], SAND[3], SAND[4], SAND[5],
      { species: "Milotic", form: "Milotic", item: "Sitrus Berry", ability: "Competitive", nature: "Bold", moves: ["Scald", "Icy Wind", "Recover", "Protect"], bonuses: [32, 0, 32, 0, 2, 0] },
      { species: "Rillaboom", form: "Rillaboom", item: "Assault Vest", ability: "Grassy Surge", nature: "Adamant", moves: ["Fake Out", "Grassy Glide", "Wood Hammer", "U-turn"], bonuses: [32, 32, 0, 0, 2, 0] }];
    const off = payloadFor(NO_MEGA, 0);
    const on = payloadFor(NO_MEGA, undefined);
    notes.push(`no-Mega team  reds ${off.checks.red_count} -> ${on.checks.red_count}, `
      + `pressure ${off.checks.check_pressure.toFixed(2)} -> ${on.checks.check_pressure.toFixed(2)}`);
    eq("the missing Mega is a red that now counts too", on.checks.red_count, off.checks.red_count + 1);
    ok("at the check's own pressure",
      Math.abs((on.checks.check_pressure - off.checks.check_pressure) - 5.2) < 0.001,
      `${off.checks.check_pressure} -> ${on.checks.check_pressure}`);
    eq("and Synergy is untouched, because nothing is wasted", on.synergy.score, off.synergy.score);
  }

  // --- payment three: the row is not offered at a target that breaks the cap ---------------
  const rowFor = (rule, target, candidateName) => {
    const payload = payloadFor(SAND, rule);
    const sg = new TeamSuggestions(evaluationFor(rule), { suggestionScoring: SUGGESTION_SCORING });
    const teamSlots = (payload.slots || []).map(({ entry, mon, set }) => ({
      entry: { ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }, mon, set }));
    const activeNames = teamSlots.map(({ entry, mon }) => sg.name(mon.form_name || entry.form || entry.pokemon));
    const context = { payload, teamSlots, teamEntries: teamSlots.map(({ entry }) => entry),
      activeNames, emptySlot: null, selection: null, selected: sg.checks.selectedIds(null), swapTarget: "" };
    const candidate = [...sg.candidates(payload, activeNames)]
      .find((m) => new RegExp(candidateName, "i").test(String(m.name || "")));
    if (!candidate) return null;
    const basis = sg.basisFor(context, target);
    return sg.evaluateCandidate(structuredClone(candidate), { ...context, swapTarget: target,
      basisPayload: basis?.payload, basisSlots: basis?.slots, basisEntries: basis?.entries });
  };
  const offeredOff = rowFor(0, "Corviknight", "Dragonite");
  const offeredOn = rowFor(undefined, "Corviknight", "Dragonite");
  notes.push(`Dragonite-Mega for Corviknight: ${offeredOff ? offeredOff.score : "-"} -> `
    + `${offeredOn ? offeredOn.score : "refused"}`);
  ok("the row the owner saw is the row the old rule produced",
    Boolean(offeredOff) && offeredOff.score > 60, String(offeredOff && offeredOff.score));
  ok("and it is not offered any more", offeredOn === null, JSON.stringify(offeredOn && offeredOn.score));
  // The candidate is not refused -- only that TARGET is. Replacing a stone keeps the count.
  const atMega = rowFor(undefined, "Salamence-Mega", "Dragonite");
  ok("the same candidate is still offered where it replaces a stone",
    Boolean(atMega) && atMega.swap_target === undefined ? true : Boolean(atMega),
    String(atMega && atMega.score));
  ok("which is the row the breakdown itself pointed at, and scores far lower",
    Boolean(atMega) && atMega.score < offeredOff.score - 15,
    `${offeredOff.score} at Corviknight vs ${atMega && atMega.score} at Salamence-Mega`);
  // A non-Mega candidate at the same target is untouched either way.
  const innocent = [rowFor(0, "Corviknight", "Milotic"), rowFor(undefined, "Corviknight", "Milotic")];
  ok("a candidate with no stone is scored identically",
    Boolean(innocent[0]) && Boolean(innocent[1]) && innocent[0].score === innocent[1].score,
    `${innocent[0] && innocent[0].score} vs ${innocent[1] && innocent[1].score}`);

  // --- and the shown list, which is what the owner reads ----------------------------------
  const listFor = (rule) => {
    const payload = payloadFor(SAND, rule);
    const sg = new TeamSuggestions(evaluationFor(rule), { suggestionScoring: SUGGESTION_SCORING });
    const out = sg.run(payload, {});
    const third = (row) => {
      const after = (row._after_check_rows || []).find((r) => String(r.kind || r.check_id || "").toLowerCase() === "mega");
      const before = (row._before_check_rows || []).find((r) => String(r.kind || r.check_id || "").toLowerCase() === "mega");
      return Boolean(after && before && after.severity === "red" && before.severity !== "red");
    };
    return { rows: out.rows, offenders: out.rows.filter(third).map((r) => r.name) };
  };
  const before = listFor(0);
  const after = listFor(undefined);
  notes.push(`shown list  rule off: ${before.rows.length} rows, ${before.offenders.length} hand over a `
    + `third stone (${before.offenders.join(", ") || "none"})`);
  notes.push(`shown list  rule ON : ${after.rows.length} rows, ${after.offenders.length} do`);
  ok("the old list handed over a third stone", before.offenders.length > 0, before.offenders.join(", "));
  eq("the new one never does", after.offenders, []);
  ok("and it is still a full list", after.rows.length === before.rows.length,
    `${before.rows.length} -> ${after.rows.length}`);
  // The duplicate "Worsens Team Building Checks" line V433 forgot to drop.
  const dupes = (rows) => rows.filter((row) => (row.details || [])
    .filter((d) => /^worsens team building checks:/i.test(String(d))).length > 1).length;
  notes.push(`rows with the line twice  rule off: ${dupes(before.rows)}  rule ON: ${dupes(after.rows)}`);
  ok("the old list printed it twice on some rows", dupes(before.rows) > 0, String(dupes(before.rows)));
  eq("the new one never does", dupes(after.rows), 0);

  // --- and Auto Build, which the owner named too ------------------------------------------
  //
  // It already holds the line and this says so by measurement rather than by reading the
  // filter: from a seed that already carries two stones, three open slots are filled and no
  // third stone appears -- the same six Pokemon with the rule on and off. Auto Build was never
  // the place that handed one over; Suggestions was.
  {
    const { TeamAutoBuild } = await import("../builder/team-autobuild.js");
    const seed = [makeSet(SAND[0]), makeSet(SAND[1]), makeSet(SAND[3]), null, null, null];
    const built = [];
    for (const rule of [0, undefined]) {
      const run = await new TeamAutoBuild(evaluationFor(rule))
        .run(seed.map((s) => (s ? { ...s } : null)), { search: "fast", depth: "fast", archetype: "automatic" });
      const entries = (run.entries || run.team || []).filter(Boolean);
      const engine = evaluationFor(rule).ev.engine;
      built.push({ names: entries.map((e) => e.form || e.pokemon),
        stones: entries.filter((e) => e.item && engine.isMegaStone(e.item)).length });
    }
    notes.push(`Auto Build from a two-stone seed  rule off: ${built[0].stones} stones  `
      + `rule ON: ${built[1].stones} stones`);
    eq("Auto Build never adds a third stone", [built[0].stones, built[1].stones], [2, 2]);
    eq("and the rule does not change what it builds", built[1].names, built[0].names);
    ok("it really filled the open slots", built[1].names.length === 6, built[1].names.join(", "));
  }

  report();
}

function report() {
  for (const note of notes) console.log(`  ${note}`);
  if (failures.length) {
    console.error(`\nmega exclusivity: ${failures.length} of ${checked} checks FAILED\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\nmega exclusivity: ${checked} checks passed${quick ? " (--quick)" : ""}`);
}
