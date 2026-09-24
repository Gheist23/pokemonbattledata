// Suggestion scoring (builder/team-suggest.js, the port of the app's suggestion_scoring_v511)
// and the breakdown it feeds (builder/suggest-view.js).
//
//   node tests/run-suggest-scoring.mjs            everything (the measured run takes a few minutes)
//   node tests/run-suggest-scoring.mjs --quick    the arithmetic, the switch and the views only
//
// The complaint this answers, in the owner's words: on a Trick Room team the Suggestions list
// was "every Pokemon with Trick Room". One number started it - `archetypeSpeedControlFit` paid a
// Trick Room carrier a flat +22 on a Trick Room team however many setters the team already had,
// while the Tailwind branch four lines above it damps to +4 once the team has one.
//
// Version 3 answers the owner's second report ("the suggestions still show just Trick Room
// users"). Damping that number was not enough, because the archetype pays for the same move
// twice: its requirement list *is* the speed plan ("Trick Room setters, at least 2, critical"),
// so `v429`'s coverage layer paid a carrier +14.75 more, undamped - more than the damped speed
// plan itself - and every carrier got the identical number, so the list was carriers ranked by
// nothing at all.
//
// What is checked here, and why it is not in tests/run-suggest-vectors.mjs (which replays the
// app's own recorded answers and so can only check what was recorded):
//
//   1. the rule's own arithmetic - the damping table, the coverage correction, the speed
//      direction, the double payment, the verdicts and the sentences they are said in -
//      against the numbers the app's module states, so the two implementations are read off
//      the same spec;
//   2. the switch: production is version 3, an unstamped recording replays with the rule off,
//      and "off"/"0"/"false"/"no"/"none" switch it off;
//   3. the scope: an Auto Build calculation is never re-scored, which is what keeps
//      run-autobuild-vectors replaying against its recording;
//   4. the ratio the complaint was really about: the archetype can pay at most 22 points, the
//      calcs 68, so the archetype is one term among several rather than the whole ranking;
//   5. the measurement, on the site's own meta data, on three real teams: the one the first
//      report was about (Indeedee-F / Hatterene / Incineroar / Gholdengo, one open slot), the
//      owner's own six slots full (three setters, so every suggestion is a swap), and a Trick
//      Room team one setter short, which is the shape the fault really lived in;
//   6. the breakdown the owner called hard to read: the three views each say what they measure
//      and in what unit, the numbers that moved stand out, a trade is never coloured as a win,
//      and one row shows at most one sprite.
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
const near = (label, got, want, tolerance = 1e-9) => ok(label, Math.abs(Number(got) - Number(want)) <= tolerance, `${got} vs ${want}`);

const suggest = await import("../builder/team-suggest.js");
const {
  SUGGESTION_SCORING, VERDICT_VALUE, archetypeMoveDoublePayment, coverageAdjustment,
  dampedSpeedPlan, directedSpeedFit, hitsFromLabel, ruleTable, speedPlanRequirement,
  suggestionScoringOption, teamGapThreats, trickRoomReward, verdictFor, verdictLine, verdictSentence,
} = suggest;

// ---------------------------------------------------------------- 1. the arithmetic

// The whole complaint, as arithmetic: another setter is never worth more than the first, and
// once the plan runs the move buys nothing at all - a carrier and a non-carrier start level.
eq("a Trick Room carrier is worth less once the plan runs", [0, 1, 2, 5].map((n) => trickRoomReward(n)), [22, 10, 0, 0]);

// A stamp selects behaviour, not just on or off: every version the app has shipped stays
// available here, so a recording replays exactly as the build that made it scored.
eq("version 2 is still scored the way version 2 scored", [0, 1, 2, 5].map((n) => trickRoomReward(n, 2)), [22, 12, 2, 2]);
eq("and version 3 the way version 3 does", [0, 1, 2, 5].map((n) => trickRoomReward(n, 3)), [22, 10, 0, 0]);
eq("left out, production's table", ruleTable(undefined), ruleTable(SUGGESTION_SCORING));
eq("a recording from a build ahead of this one replays on the newest weights", ruleTable(99), ruleTable(SUGGESTION_SCORING));
ok("and the reason line is the one that version said",
  dampedSpeedPlan({ adjustment: 22, reason: "x", has_trick_room: true }, "trick room", 2, 2)[1].includes("adds little")
  && dampedSpeedPlan({ adjustment: 22, reason: "x", has_trick_room: true }, "trick room", 2, 3)[1].includes("adds nothing"));

// `archetypeSpeedControlFit` is not exported; the rule reads its answer, so the shapes it can
// produce are written out here exactly as that function returns them.
const fitFor = (adjustment, reason, extra = {}) => ({ conflict: false, adjustment, reason, has_trick_room: true, has_tailwind: false, ...extra });
for (const [setters, expected] of [[0, 22], [1, 10], [2, 0], [3, 0]]) {
  const [adjustment, reason] = dampedSpeedPlan(fitFor(22, "Trick Room reinforces the team's primary speed plan."), "trick room", setters);
  near(`the damping matches the Tailwind branch at ${setters} setter(s)`, adjustment, expected);
  ok(`the reason is said at ${setters} setter(s)`, Boolean(reason));
}
ok("the reason changes its tune once the plan is covered",
  dampedSpeedPlan(fitFor(22, "x"), "trick room", 2)[1].includes("already sets Trick Room"));
ok("at one setter it says the plan becomes reliable",
  dampedSpeedPlan(fitFor(22, "x"), "trick room", 1)[1] === "A second Trick Room setter makes the speed plan reliable.");

// --------------------------------------------- 1b. the same move, charged once
//
// The archetype's requirement list *is* the speed plan: one of the requirements `v429` scores
// a candidate against is "Trick Room setters, at least 2, critical". Version 2 damped
// `archetypeSpeedControlFit` and stopped there, so a carrier still collected v429's reward for
// the same move - undamped, and more than the damped speed plan itself.
{
  const minimum = (label, current, target, critical = false) => ({
    label, current, target, display: `${current}/${target}`, met: current >= target, critical,
  });
  const requirements = (setters, protect = 3) => [
    minimum("Trick Room setters", setters, 2, true), minimum("Slow attackers", 4, 3),
    minimum("Protect users", protect, 4), minimum("Spread attackers", 1, 1), minimum("Priority users", 1, 1),
  ];
  const ratio = (req) => (Number(req.target) > 0 ? Math.max(0, Math.min(1, Number(req.current) / Number(req.target))) : (req.met ? 1 : 0));

  // one setter -> two: the critical requirement goes 0.5 -> 1.0 and weighs 2.4 of the 6.4
  // total, so 0.5 * 2.4 / 6.4 * 52 = 9.75, plus v429's flat 5 for a critical requirement met.
  near("the coverage arithmetic is v429's own", coverageAdjustment(requirements(1), requirements(2), ratio), 14.75, 1e-9);
  near("holding it withholds exactly that", coverageAdjustment(requirements(1), requirements(2), ratio, "trick room setters"), 0, 1e-9);
  near("and nothing else it brought", coverageAdjustment(requirements(1), requirements(2, 4), ratio, "trick room setters"), (0.25 / 6.4) * 52, 1e-9);
  near("the archetype move is not charged for twice", archetypeMoveDoublePayment(requirements(1), requirements(2), ratio, "trick room"), -14.75, 1e-9);
  ok("which was more than the damped speed plan pays at one setter", 14.75 > trickRoomReward(1));
  // Version 2 left that payment in place, so a recording stamped 2 still gets it.
  eq("a version 2 replay keeps the payment version 2 made", archetypeMoveDoublePayment(requirements(1), requirements(2), ratio, "trick room", 2), 0);
  near("and a version 3 replay withholds it", archetypeMoveDoublePayment(requirements(1), requirements(2), ratio, "trick room", 3), -14.75, 1e-9);
  // Only the reward is withheld: swapping away a setter the plan needs is a real cost.
  near("a worsening stands", coverageAdjustment(requirements(2), requirements(1), ratio, "trick room setters"),
    coverageAdjustment(requirements(2), requirements(1), ratio), 1e-9);
  ok("and it really is a penalty", coverageAdjustment(requirements(2), requirements(1), ratio) < 0);
  eq("nothing is taken from a team whose plan already runs", archetypeMoveDoublePayment(requirements(2), requirements(3), ratio, "trick room"), 0);
  eq("an archetype whose requirements are not one move is untouched", speedPlanRequirement("balanced"), "");
  eq("and so is its coverage", archetypeMoveDoublePayment(requirements(1), requirements(2), ratio, "balanced"), 0);
  eq("Tailwind has the identical shape, so it gets the identical treatment", speedPlanRequirement("tailwind"), "tailwind setters");
}

// A conflict penalty is a refusal: refusing Trick Room on a fast team was always right.
near("a Trick Room conflict on a fast team is never damped",
  dampedSpeedPlan(fitFor(-54, "conflict", { conflict: true }), "hyper offense", 2)[0], -54);
near("an isolated Tailwind on a room plan is never damped",
  dampedSpeedPlan(fitFor(-28, "conflict", { conflict: true, has_trick_room: false, has_tailwind: true }), "trick room", 2)[0], -28);
for (const archetype of ["trick room", "tailwind", "balanced", "hyper offense"]) {
  const fit = fitFor(7, "flexible", { has_trick_room: false });
  const [adjustment, reason] = dampedSpeedPlan(fit, archetype, 2);
  near(`a candidate with no Trick Room is untouched (${archetype})`, adjustment, 7);
  eq(`its reason is untouched (${archetype})`, reason, "flexible");
}

// Speed fit points the way the team's plan points.
ok("a Trick Room team wants the slow one", directedSpeedFit({ speed: 30 }, "trick room", 2) > directedSpeedFit({ speed: 200 }, "trick room", 2));
ok("every other plan wants the fast one", directedSpeedFit({ speed: 200 }, "balanced", 0) > directedSpeedFit({ speed: 30 }, "balanced", 0));
near("a non-room team gets the original formula", directedSpeedFit({ speed: 200 }, "balanced", 0), 35 + Math.min(30, 200 / 5));
{
  // +22 for the archetype and +24 again for being "speed control" was the same move paid twice.
  const carrier = { speed: 40, speed_control: true, moves: ["Trick Room", "Psychic"] };
  const tailwinder = { speed: 40, speed_control: true, moves: ["Tailwind", "Moonblast"] };
  const covered = directedSpeedFit(carrier, "trick room", 2);
  const first = directedSpeedFit(carrier, "trick room", 0);
  ok("the second credit is only withdrawn once the plan runs", covered < first);
  near("and it is withdrawn by exactly the credit", covered, first - 24 + 8);
  near("a Pokemon whose speed control is not the archetype move keeps it",
    directedSpeedFit(tailwinder, "trick room", 2), directedSpeedFit(tailwinder, "trick room", 0));
}

// The verdicts, read off the Team Evaluation's own labels.
eq("hits are read off the Team Evaluation's labels",
  ["OHKO", "Guaranteed OHKO", "2HKO", "possible 3HKO", "No reliable KO", ""].map(hitsFromLabel), [1, 1, 2, 3, 99, 99]);
eq("a verdict is the app's real-answer rule, graded", [
  verdictFor(1, 1, false, true), verdictFor(1, 3, false, false), verdictFor(2, 2, true, false),
  verdictFor(2, 2, false, true), verdictFor(3, 5, false, false), verdictFor(3, 2, false, false), verdictFor(4, 4, false, false),
], ["loses", "beats", "beats", "trades", "walls", "loses", "trades"]);
eq("the verdicts are valued in that order", Object.entries(VERDICT_VALUE).sort((a, b) => b[1] - a[1]).map(([k]) => k),
  ["beats", "walls", "chips", "trades", "loses"]);
{
  const text = verdictSentence("Rillaboom", "beats", 1, 4, false, false);
  ok("the verdict is said in words before any number", text.startsWith("Beats Rillaboom"), text);
  ok("and the hits are said in words too", text.includes("one hit") && text.includes("4 hits"), text);
  ok("move order is only mentioned where it decides the exchange", !text.includes("moves second"), text);
  ok("where it does decide it, it is said", verdictSentence("Rillaboom", "trades", 2, 2, false, true).includes("moves second"));
  eq("a Pokemon removed before it acts is said plainly",
    verdictSentence("Rillaboom", "loses", 2, 1, false, true), "Loses to Rillaboom: it moves first and removes this in one hit.");
}
{
  const gaps = teamGapThreats([
    { name: "Answered", breakdown: [{ outgoing_label: "OHKO", incoming_label: "3HKO" }, { outgoing_label: "No reliable KO", incoming_label: "OHKO" }] },
    { name: "Unanswered", breakdown: [{ outgoing_label: "3HKO", incoming_label: "2HKO" }, { outgoing_label: "No reliable KO", incoming_label: "OHKO" }] },
    { name: "Walled", breakdown: [{ outgoing_label: "3HKO", incoming_label: "5HKO" }] },
  ]);
  eq("a threat nothing on the team answers is found from the breakdown",
    [...gaps.entries()], [["Answered", false], ["Unanswered", true], ["Walled", false]]);
}
eq("the verdict line names the counts the groups below repeat",
  verdictLine({ threats_measured_v511: 8, gaps_filled_v511: 2, removed_first_v511: 1, threat_answers_v511: [{ verdict: "beats" }, { verdict: "walls" }] }),
  "Answers 2 of the team's 8 worst threats; 2 of those nothing on the team answers today; 1 of them removes it first.");
eq("an unmeasured row says nothing at all", verdictLine({}), "");

// ------------------------------------------------------------------- 2. the switch

eq("production runs version 3", SUGGESTION_SCORING, 3);
eq("left out, the rule is on at production's version", suggestionScoringOption(undefined), SUGGESTION_SCORING);
eq("a recording with no stamp replays with the rule off", suggestionScoringOption(null), 0);
for (const off of ["off", "0", "false", "no", "none", ""]) eq(`"${off}" switches it off`, suggestionScoringOption(off), 0);
eq("a version pins that version", suggestionScoringOption(3), 3);
eq("a stamp read from JSON as a string pins it too", suggestionScoringOption("3"), 3);

// ------------------------------------------------- 4. the ratio the complaint was about

{
  const answerSpan = 2 * 18;                       // ANSWER_SPAN, both ways
  const calcSpan = answerSpan + 18 + 14;           // + GAP_SPAN + VULNERABLE_SPAN
  ok("the archetype never pays more than the answers alone move", trickRoomReward(0) <= answerSpan);
  ok("one setter short it stays under what the answers alone move", trickRoomReward(1) < 18);
  eq("on a team whose plan already runs it pays nothing at all", trickRoomReward(2), 0);
  ok("and the calcs span at least twice the archetype's best case", calcSpan >= 2 * trickRoomReward(0), `${calcSpan}`);
}

// --------------------------------------------------------------------- 6. the views

// A DOM small enough to render one suggestion row into, and enough of one to see what the
// reader would see: classes, text, tag names and nesting.
class NodeBase {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
}
class TextNode extends NodeBase {
  constructor(value) { super(); this.value = String(value); }
  get textContent() { return this.value; }
}
class El extends NodeBase {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.attrs = {};
    this.className = "";
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { add: () => {}, remove: () => {}, toggle: () => {} };
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  addEventListener() {}
  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }
}
globalThis.Node = NodeBase;
globalThis.document = { createElement: (tag) => new El(tag), createTextNode: (value) => new TextNode(value) };

const all = (node, test) => {
  const found = [];
  const walk = (n) => {
    if (!(n instanceof El)) return;
    if (test(n)) found.push(n);
    n.childNodes.forEach(walk);
  };
  walk(node);
  return found;
};
const withClass = (node, name) => all(node, (n) => String(n.className || "").split(/\s+/).includes(name));
const sectionTitles = (node) => all(node, (n) => n.tagName === "H4").map((n) => n.textContent);

const { suggestionRow } = await import("../builder/suggest-view.js");

/** A shown row as builder/team-suggest.js `suggestionForPage` hands it to the page. */
const shownRow = (overrides = {}) => ({
  key: "Add Mega Dragonite", name: "Mega Dragonite", action: "Add Mega Dragonite", action_kind: "add", slot_index: 4, swap_target: "",
  score: 93.4, score_uncapped: 93.4, position: 61, meta_rank: 61, source: "meta",
  item: "Dragonitite", ability: "Multiscale", moves: ["Dragon Dance", "Extreme Speed", "Earthquake", "Protect"], spread_label: "Adamant",
  answers: ["Rillaboom", "Kingambit"], details: ["Improves Team Building Checks: Speed Control"], severities: {},
  candidate_entry: { pokemon: "Dragonite", item: "Dragonitite", form: "Mega Dragonite", ability: "Multiscale", moves: [] },
  spread: { nature_name: "Adamant", bonuses: [32, 32, 0, 0, 2, 0] }, form: "Mega Dragonite",
  components: { synergy: { current: 60, projected: 64, delta: 4 }, offense: { current: 50, projected: 58, delta: 8 } },
  checks: [], archetype_changes: { archetype: "trick room", gained: [], lost: [] }, answer_calcs: [],
  verdict_line: "Answers 2 of the team's 8 worst threats; 1 of those nothing on the team answers today; 1 of them removes it first.",
  threats_measured: 8, gaps_filled: 1, removed_first: 1,
  threat_answers: [
    { threat: "Rillaboom", verdict: "beats", out_hits: 1, in_hits: 4, ours_first: true, theirs_first: false, fills_a_gap: true, sentence: "Beats Rillaboom: removes it in one hit, and takes 4 hits to be removed." },
    { threat: "Kingambit", verdict: "walls", out_hits: 3, in_hits: 6, ours_first: false, theirs_first: false, fills_a_gap: false, sentence: "Walls Kingambit: it needs 6 hits to remove this, which removes it in 3 hits." },
  ],
  threat_verdicts: [
    { threat: "Rillaboom", verdict: "beats", out_hits: 1, in_hits: 4, ours_first: true, theirs_first: false, fills_a_gap: true, sentence: "Beats Rillaboom." },
    { threat: "Kingambit", verdict: "walls", out_hits: 3, in_hits: 6, ours_first: false, theirs_first: false, fills_a_gap: false, sentence: "Walls Kingambit." },
    { threat: "Incineroar", verdict: "trades", out_hits: 2, in_hits: 2, ours_first: false, theirs_first: false, fills_a_gap: false, sentence: "Even with Incineroar.", type_chart_says_good: true },
    { threat: "Arcanine-Hisui", verdict: "loses", out_hits: 2, in_hits: 1, ours_first: false, theirs_first: true, fills_a_gap: true, sentence: "Loses to Arcanine-Hisui.", type_chart_says_good: true },
  ],
  type_matchup_only: [
    { threat: "Arcanine-Hisui", verdict: "loses", out_hits: 2, in_hits: 1, ours_first: false, theirs_first: true, type_chart_says_good: true },
  ],
  ledger: [
    { key: "team", label: "Team fit (projected scores, checks, meta rank)", value: 78.2 },
    { key: "speed_plan_v511", label: "Fits the speed plan", delta: -20, raw: -20, detail: "The team already sets Trick Room, so another setter adds little to the speed plan; what it does against the threats decides this." },
    { key: "answers_v511", label: "Answers the team's threats", delta: 11.4, raw: 11.4, detail: "Beats or walls 2 of the 8 worst threats, weighted by how bad each one is." },
    { key: "vulnerable_v511", label: "Survives the same threats", delta: -3.1, raw: -3.1, detail: "1 of them removes it first." },
  ],
  projected: {
    member: "Dragonite-Mega", item_changed: "", critical: { before: 9, after: 7 },
    scores: { before: { synergy: 60, offense: 50, defense: 55, speed: 40 }, after: { synergy: 64, offense: 58, defense: 55, speed: 42 } },
    lowered: [{ threat: "Rillaboom", before: 88, after: 61 }, { threat: "Kingambit", before: 78, after: 52 }],
    raised: [{ threat: "Milotic", before: 40, after: 56 }],
    answers: [],
  },
  ...overrides,
});

const helpers = { spriteFor: () => "/sprite.png", onUse: () => {}, ui: { open: new Set(), all: new Set() }, name: (v) => v, text: (v) => v };
const rendered = suggestionRow(shownRow(), helpers, { checking: false, rows: [] });
const titles = sectionTitles(rendered);

ok("the breakdown leads with what it does", titles[0] === "What it does", titles.join(" | "));
ok("view 1 says the true count, not a cap",
  titles.includes("Answers in the full Team Evaluation (2 of the 8 worst threats)"), titles.join(" | "));
ok("view 2 is there under the name the owner used", titles.includes("Threat scores after adding it"), titles.join(" | "));
ok("view 3 is there under the name the owner used", titles.includes("Type matchup only"), titles.join(" | "));
ok("and the score ledger is still last", titles.at(-1) === "How the score is built", titles.join(" | "));

const text = rendered.textContent;
ok("view 1 says what it measures and in what unit",
  /played out both ways with the same calcs the Team Evaluation runs/.test(text) && /hits needed to remove/.test(text), "");
ok("view 2 says what a threat score is and which way is better",
  /out of 100, and lower is better/.test(text), "");
ok("view 3 says the type chart and the calc disagree", /The type chart says this Pokémon is good into these, and the calc disagrees/.test(text));
ok("view 2 splits lowered from raised, each with its own count",
  /Threat scores it lowers — better \(2\)/.test(text) && /Threat scores it raises — worse \(1\)/.test(text), "");
ok("view 2 gives a net figure over everything that moved",
  /Across every threat that moved/.test(text) && text.includes("−37.0"), text.match(/Across every threat that moved[^.]*\./)?.[0] || "");
ok("a threat that stops being critical says so in words", /no longer critical/.test(text));
ok("view 1 marks a threat nothing on the team answers", /Team has no answer/.test(text));
ok("view 3 gives the one clause that explains the disagreement",
  /Arcanine-Hisui.*the typing looks good, but the calc says it moves first and removes this in one hit/.test(text.replace(/\s+/g, " ")),
  text.replace(/\s+/g, " ").match(/Arcanine-Hisui[^.]*\./)?.[0] || "");
ok("the ledger names each calc term in the words the groups above use",
  /Answers the team's threats/.test(text) && /Survives the same threats/.test(text) && /Fits the speed plan/.test(text));
ok("the ledger says what each term measured", /Beats or walls 2 of the 8 worst threats/.test(text));

// Honesty: a trade is a trade. Only a plain win or a plain loss may carry a colour.
const verdictCards = withClass(rendered, "bd-sg-vd");
eq("every measured matchup is shown", verdictCards.length, 4); // the 2 answers, then the 2 it does not answer
const toneOf = (card) => ["good", "bad", "flat"].find((t) => String(card.className).split(/\s+/).includes(t));
const cardTone = new Map(verdictCards.map((card) => [card.textContent.match(/(Beats|Walls|Chips|Even|Loses to)\s*(\S+)/)?.[2] || "?", toneOf(card)]));
ok("a trade is not coloured as a win", [...verdictCards].every((card) => !(/Even with|Even\s/.test(card.textContent) && toneOf(card) === "good")),
  [...cardTone.entries()].map(([k, v]) => `${k}=${v}`).join(" "));
ok("a beat is marked as good and a loss as bad",
  verdictCards.some((c) => /Beats/.test(c.textContent) && toneOf(c) === "good")
  && verdictCards.some((c) => /Loses to/.test(c.textContent) && toneOf(c) === "bad"));
ok("every verdict card carries a tone class, so none is silently unstyled", verdictCards.every((c) => toneOf(c)));

// The hit counts are the numbers that moved the score, so they are the ones set in <b>.
const hitFigures = withClass(rendered, "bd-sg-vd-hits").flatMap((n) => all(n, (x) => x.tagName === "B").map((x) => x.textContent));
ok("the hit counts stand out as the figures", hitFigures.length === 2 * verdictCards.length && hitFigures.includes("1 hit") && hitFigures.includes("3 hits"), hitFigures.join(" | "));
// The engine only counts 1, 2 and 3 exactly; everything slower is one bucket, so it is not
// dressed up as a measurement ("6 hits") that nobody made.
ok("anything slower than a 3HKO is shown as a bucket, not as a count",
  hitFigures.includes("4+ hits") && !hitFigures.some((v) => /^[4-9]\d* hits$/.test(v)), hitFigures.join(" | "));

// At most one sprite per row, at any width.
eq("one row shows one sprite", all(rendered, (n) => n.tagName === "IMG" && String(n.className).includes("bd-sprite")).length, 1);

// A row from before the rule (or with it off) falls back to the earlier view rather than being
// rendered against an empty one.
{
  const old = shownRow({
    verdict_line: "", threats_measured: 0, threat_answers: [], threat_verdicts: [], type_matchup_only: [],
    answer_calcs: [{ threat: "Rillaboom", kept: false, incoming: { attacker: "Rillaboom", move: "Grassy Glide", hits: 1, label: "OHKO", percent: "100-118%" }, outgoing: null }],
    ledger: [{ key: "team", label: "Team fit (projected scores, checks, meta rank)", value: 78.2 }],
  });
  const node = suggestionRow(old, helpers, { checking: false, rows: [] });
  const oldTitles = sectionTitles(node);
  ok("an unmeasured row has no \"What it does\"", !oldTitles.includes("What it does"), oldTitles.join(" | "));
  ok("it still gets the three views by name",
    oldTitles.includes("Answers in the full Team Evaluation") && oldTitles.includes("Threat scores after adding it") && oldTitles.includes("Type matchup only"),
    oldTitles.join(" | "));
  ok("and the struck type matchups it does have are still shown", /Rillaboom/.test(node.textContent));
}

// The CSS the views need, including the 390px column.
{
  const css = readFileSync(join(root, "builder", "suggest.css"), "utf8");
  for (const name of ["bd-sg-verdict", "bd-sg-verdicts", "bd-sg-vd", "bd-sg-vd-hits", "bd-sg-vd-tag", "bd-sg-typeonly", "bd-sg-net", "bd-sg-tsg"]) {
    ok(`suggest.css styles .${name}`, css.includes(`.${name}`));
  }
  ok("the hit counts are larger than the words around them", /\.bd-sg-vd-hits b \{[^}]*font-size: 0\.86rem/.test(css));
  ok("the words around them recede", /\.bd-sg-vd-hits \{[^}]*color: var\(--muted\)/.test(css));
  ok("a neutral verdict gets the plain border, not a green one", /\.bd-sg-vd\.flat \{[^}]*border-left-color: var\(--bd-line\)/.test(css));
  const narrow = css.slice(css.lastIndexOf("@media"));
  ok("the narrow column collapses the threat lists to one column", /grid-template-columns: minmax\(0, 1fr\)/.test(narrow));
  ok("and lets the hit counts and threat rows wrap rather than overflow",
    /\.bd-sg-vd-hits \{/.test(narrow) && /\.bd-sg-threat-moves li \{[^}]*flex-wrap: wrap/.test(narrow), "");
  // Everything the views draw wraps rather than pushing the column wider.
  ok("nothing in the new views is nowrap except the short hit figures",
    !/\.bd-sg-typeonly[^{]*\{[^}]*white-space: nowrap/.test(css));
}

// ------------------------------------------------- 3 and 5: the engine and the measurement

if (quick) {
  notes.push("--quick: the Auto Build scope check and the measured Trick Room run were skipped.");
} else {
  const { DamageEngine, compact } = await import("../builder/engine.js");
  const { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } = await import("../builder/team-eval.js");
  const { TeamEvaluation } = await import("../builder/team-payload.js");
  const { KnownTeams } = await import("../builder/known-teams.js");
  const { makeSet } = await import("../builder/common.js");
  const { TeamSuggestions } = suggest;
  const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));
  const appData = read("data", "builder", "app-data.json");
  const meta = read("data", "builder", "meta-doubles.json");
  const known = new KnownTeams(read("data", "builder", "known-teams.json"));
  const ranked = (meta.pokemon || []).filter((r) => Number(r.position) < 999999).length;

  // The team the first report was about: a real Trick Room team with two setters and one open slot.
  const TEAM = [
    { species: "Indeedee-F", form: "Indeedee-F", item: "Psychic Seed", ability: "Psychic Surge", nature: "Sassy", moves: ["Follow Me", "Psychic", "Helping Hand", "Trick Room"], bonuses: [32, 0, 2, 0, 32, 0] },
    { species: "Hatterene", form: "Hatterene", item: "Life Orb", ability: "Magic Bounce", nature: "Quiet", moves: ["Expanding Force", "Dazzling Gleam", "Trick Room", "Protect"], bonuses: [32, 0, 2, 32, 0, 0] },
    { species: "Incineroar", form: "Incineroar", item: "Assault Vest", ability: "Intimidate", nature: "Careful", moves: ["Fake Out", "Knock Off", "Flare Blitz", "U-turn"], bonuses: [32, 0, 2, 0, 32, 0] },
    { species: "Gholdengo", form: "Gholdengo", item: "Choice Specs", ability: "Good as Gold", nature: "Quiet", moves: ["Make It Rain", "Shadow Ball", "Power Gem", "Trick"], bonuses: [32, 0, 2, 32, 0, 0] },
  ];
  // The owner's own team when they reported it a second time: six slots full, three of them
  // carrying Trick Room, so every suggestion is a swap rather than a fill.
  const OWNER_TEAM = [
    { species: "Malamar", form: "Mega Malamar", item: "Malamarite", ability: "Contrary", nature: "Relaxed", moves: ["Superpower", "Protect", "Knock Off", "Trick Room"], bonuses: [32, 32, 2, 0, 0, 0] },
    { species: "Indeedee", form: "Indeedee Female", item: "Colbur Berry", ability: "Psychic Surge", nature: "Relaxed", moves: ["Follow Me", "Trick Room", "Helping Hand", "Psychic"], bonuses: [32, 0, 32, 0, 2, 0] },
    { species: "Milotic", form: "Milotic", item: "Leftovers", ability: "Competitive", nature: "Modest", moves: ["Protect", "Scald", "Ice Beam", "Icy Wind"], bonuses: [32, 0, 32, 0, 2, 0] },
    { species: "Sylveon", form: "Sylveon", item: "Fairy Feather", ability: "Pixilate", nature: "Modest", moves: ["Hyper Voice", "Hyper Beam", "Quick Attack", "Detect"], bonuses: [32, 0, 2, 32, 0, 0] },
    { species: "Farigiraf", form: "Farigiraf", item: "Sitrus Berry", ability: "Armor Tail", nature: "Bold", moves: ["Trick Room", "Helping Hand", "Psychic", "Thunderbolt"], bonuses: [27, 0, 20, 0, 19, 0] },
    { species: "Rillaboom", form: "Rillaboom", item: "Miracle Seed", ability: "Grassy Surge", nature: "Adamant", moves: ["Grassy Glide", "Fake Out", "Wood Hammer", "U-turn"], bonuses: [32, 32, 0, 0, 0, 2] },
  ];
  // The shape the complaint really lives in: a Trick Room team one setter short. Here the
  // archetype's own requirement ("Trick Room setters, at least 2, critical") is unmet, so
  // before version 3 the coverage layer paid every carrier +14.75 for closing it on top of
  // the damped speed plan, and the whole list was carriers tied at one number.
  const ONE_SETTER = [OWNER_TEAM[1], OWNER_TEAM[2], OWNER_TEAM[3], OWNER_TEAM[5]];
  const sets = Array.from({ length: 6 }, (_, i) => (TEAM[i] ? makeSet(TEAM[i]) : null));

  const evaluationFor = () => {
    const ev = new TeamEvaluator(null, new DamageEngine(appData), "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }, ranked));
    ev.setMetaRecords(meta.pokemon || []);
    const evaluation = new TeamEvaluation(ev);
    evaluation.knownTeams = known;
    return evaluation;
  };

  /** The whole pool ranked as the tab ranks it, `top` deep, with or without the rule. */
  function rank(scoring, top) {
    const evaluation = evaluationFor();
    const payload = evaluation.evaluate(sets, { checkSelection: null });
    const sg = new TeamSuggestions(evaluation, { suggestionScoring: scoring });
    const teamSlots = (payload.slots || []).map(({ entry, mon }) => ({ entry: { ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }, mon }));
    const teamEntries = teamSlots.map(({ entry }) => entry);
    const activeNames = teamSlots.map(({ entry, mon }) => sg.name(mon.form_name || entry.form || entry.pokemon));
    const context = { payload, teamSlots, teamEntries, activeNames, emptySlot: teamSlots.length, selection: null, selected: sg.checks.selectedIds(null), swapTarget: "" };
    const best = new Map();
    for (const candidate of sg.candidates(payload, activeNames)) {
      const row = sg.evaluateCandidate(structuredClone(candidate), context);
      if (row && row.score > 0) best.set(compact(row.name), row);
    }
    const pool = [...best.values()].sort((a, b) => b.score - a.score || a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const rows = scoring ? sg.deepRank(pool, payload, top) : pool.slice(0, top);
    return { rows, pool, archetype: String(pool[0]?.strategy_archetype_v466 || "") };
  }

  /**
   * The rows the tab really shows for `team`, through the whole chain the page runs
   * (`TeamSuggestions.run`): every candidate against every swap target, then the calc-backed
   * re-rank. This is the only way to measure a full six-slot team, where a suggestion is a
   * swap rather than a fill.
   */
  function shownRows(team, scoring) {
    const evaluation = evaluationFor();
    const payload = evaluation.evaluate(Array.from({ length: 6 }, (_, i) => (team[i] ? makeSet(team[i]) : null)), { checkSelection: null });
    const sg = new TeamSuggestions(evaluation, { suggestionScoring: scoring });
    const out = sg.run(payload, { selection: null });
    const slots = (payload.slots || []).map(({ entry, mon }) => ({ entry: { ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }, mon }));
    return { ...out, setters: Number(sg.featuresFor(slots).trick_room_setters) || 0 };
  }

  const carriesTrickRoom = (row) => (row.moves || []).some((m) => compact(m) === "trickroom");
  const started = Date.now();
  const before = rank(null, 20);
  const after = rank(SUGGESTION_SCORING, 20);
  const seconds = Math.round((Date.now() - started) / 1000);

  ok("the team the complaint was about is detected as Trick Room", before.archetype === "trick room", before.archetype);
  const poolCarriers = before.pool.filter(carriesTrickRoom).length;
  const beforeTop = before.rows.filter(carriesTrickRoom);
  const afterTop = after.rows.filter(carriesTrickRoom);
  notes.push(`Trick Room team, ${before.pool.length} candidates scored (${poolCarriers} carry Trick Room), ${seconds}s:`);
  notes.push(`  top 20 carrying Trick Room: before ${beforeTop.length}/20 (${beforeTop.map((r) => r.name).join(", ") || "none"})`);
  notes.push(`                               after ${afterTop.length}/20 (${afterTop.map((r) => r.name).join(", ") || "none"})`);
  notes.push(`  top 10: before ${before.rows.slice(0, 10).filter(carriesTrickRoom).length}/10, after ${after.rows.slice(0, 10).filter(carriesTrickRoom).length}/10`);
  notes.push(`  before, best 8: ${before.rows.slice(0, 8).map((r) => `${r.name} ${r.score.toFixed(1)}`).join(", ")}`);
  notes.push(`  after,  best 8: ${after.rows.slice(0, 8).map((r) => `${r.name} ${r.score.toFixed(1)} (${(r.threat_answers_v511 || []).length}/${r.threats_measured_v511 || 0})`).join(", ")}`);

  ok("the pool really is full of Trick Room carriers", poolCarriers >= 10, `${poolCarriers}`);
  ok("before the rule, the top 20 was full of them", beforeTop.length >= 5, `${beforeTop.length}/20`);
  ok("after it, far fewer of them are there", afterTop.length * 2 < beforeTop.length, `before ${beforeTop.length}, after ${afterTop.length}`);
  ok("every shown row was measured against the team's worst threats",
    after.rows.every((row) => Number(row.threats_measured_v511) > 0), `${after.rows.filter((r) => !r.threats_measured_v511).map((r) => r.name).join(", ")}`);
  ok("the shown rows are in score order", after.rows.every((row, i) => i === 0 || after.rows[i - 1].score >= row.score));
  ok("the list spreads out rather than sitting in one point",
    after.rows[0].score - after.rows.at(-1).score > before.rows[0].score - before.rows.at(-1).score,
    `before ${(before.rows[0].score - before.rows.at(-1).score).toFixed(1)}, after ${(after.rows[0].score - after.rows.at(-1).score).toFixed(1)}`);
  ok("the closed row's \"Helps vs\" list is the calc-backed one",
    after.rows.every((row) => !(row.threat_answers_v511 || []).length
      || (row.answers || []).every((name) => (row.threat_answers_v511 || []).some((e) => e.threat === name))));
  ok("a measured row carries the ledger the breakdown reads",
    after.rows.every((row) => (row.score_ledger || []).some((item) => item.key === "answers_v511")));

  // ---- 5b. the owner's own six-slot team, and the shape the complaint lives in ----
  //
  // Six slots full is a different path: every suggestion is a swap, and the setter count the
  // damping reads includes the Pokémon being swapped away.
  for (const [label, team, expectations] of [
    ["the owner's six-slot team (3 setters, swaps)", OWNER_TEAM, { maxShown: 2 }],
    ["a Trick Room team one setter short (fills)", ONE_SETTER, { maxShown: 6, everyCarrierAnswers: true }],
  ]) {
    const plain = shownRows(team, null);
    const scored = shownRows(team, SUGGESTION_SCORING);
    const plainCarriers = plain.rows.filter(carriesTrickRoom);
    const carriers = scored.rows.filter(carriesTrickRoom);
    notes.push(`${label}: ${scored.setters} setters, ${scored.scanned} candidates, ${scored.targets.length} target(s)`);
    notes.push(`  shown rows carrying Trick Room: rule off ${plainCarriers.length}/${plain.rows.length}, on ${carriers.length}/${scored.rows.length}`);
    notes.push(`  best 6: ${scored.rows.slice(0, 6).map((r) => `${carriesTrickRoom(r) ? "[TR]" : ""}${r.name} ${r.score.toFixed(1)} (${(r.threat_answers_v511 || []).length}/${r.threats_measured_v511 || 0})`).join(", ")}`);
    ok(`${label}: the list is no longer mostly Trick Room users`,
      carriers.length <= expectations.maxShown, `${carriers.length}/${scored.rows.length}: ${carriers.map((r) => r.name).join(", ")}`);
    ok(`${label}: the rule really is what moved it`,
      plainCarriers.length > carriers.length, `off ${plainCarriers.length}, on ${carriers.length}`);
    ok(`${label}: every shown row was measured against the worst threats`,
      scored.rows.every((row) => Number(row.threats_measured_v511) > 0));
    if (expectations.everyCarrierAnswers) {
      // The owner's point: a Pokémon may be suggested for what it does, and a setter that
      // answers nothing at all is not doing anything.
      ok(`${label}: no shown Pokémon answers none of the eight worst threats`,
        scored.rows.every((row) => (row.threat_answers_v511 || []).length > 0),
        scored.rows.filter((r) => !(r.threat_answers_v511 || []).length).map((r) => r.name).join(", "));
    }
  }

  // The scope: an Auto Build calculation keeps the weights it was tuned with, which is what
  // keeps run-autobuild-vectors replaying against its recording.
  {
    const evaluation = evaluationFor();
    const payload = evaluation.evaluate(sets, { checkSelection: null });
    const teamSlots = (payload.slots || []).map(({ entry, mon }) => ({ entry: { ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }, mon }));
    const teamEntries = teamSlots.map(({ entry }) => entry);
    const activeNames = teamSlots.map(({ entry, mon }) => entry.pokemon && mon ? String(mon.form_name || entry.form || entry.pokemon) : "");
    const base = { payload, teamSlots, teamEntries, activeNames, emptySlot: teamSlots.length, selection: null, swapTarget: "" };
    const on = new TeamSuggestions(evaluation, { suggestionScoring: SUGGESTION_SCORING });
    const off = new TeamSuggestions(evaluation, { suggestionScoring: null });
    const carrier = on.candidates(payload, activeNames).find((m) => {
      const row = off.evaluateCandidate(structuredClone(m), { ...base, selected: off.checks.selectedIds(null) });
      return row && (row.moves || []).some((move) => compact(move) === "trickroom");
    });
    ok("a Trick Room carrier is in the pool to test the scope with", Boolean(carrier), "");
    if (carrier) {
      const plain = off.evaluateCandidate(structuredClone(carrier), { ...base, selected: off.checks.selectedIds(null) });
      const scored = on.evaluateCandidate(structuredClone(carrier), { ...base, selected: on.checks.selectedIds(null) });
      const auto = on.evaluateCandidate(structuredClone(carrier), { ...base, autoBuild: true, selected: on.checks.selectedIds(null), fieldEntries: teamEntries, payloadTeam: teamEntries });
      ok("the rule really moves a Trick Room carrier on this team", Math.abs(scored.score - plain.score) > 0.05, `${plain.score} -> ${scored.score}`);
      ok("an Auto Build calculation is never re-scored", !auto.stage_one_score_v511, `${auto.stage_one_score_v511}`);
      ok("and it keeps the archetype fit it was tuned with",
        Math.abs(Number(auto.archetype_speed_fit_v466) - Number(plain.archetype_speed_fit_v466)) < 0.05,
        `auto ${auto.archetype_speed_fit_v466} vs old ${plain.archetype_speed_fit_v466}`);
      ok("while plain Suggestions damp it", Number(scored.archetype_speed_fit_v466) < Number(plain.archetype_speed_fit_v466),
        `${plain.archetype_speed_fit_v466} -> ${scored.archetype_speed_fit_v466}`);
    }
  }
}

// ------------------------------------------------------------------------- report

for (const note of notes) console.log(note);
if (failures.length) {
  console.error(`FAIL ${failures.length}/${checked}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`OK ${checked}/${checked} checks - suggestion scoring (arithmetic, switch, scope${quick ? "" : ", the measured Trick Room run"}) and the three breakdown views`);
