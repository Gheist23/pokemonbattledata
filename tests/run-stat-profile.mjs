// V553 on the website: a Pokemon's stats are worth something, and a team's stats have a shape.
//
// WHY THIS SUITE EXISTS SEPARATELY. Every recorded vector in this directory predates the rule --
// `grep stat_profile tests/*-vectors*.json` finds nothing in any of the nine -- so those suites
// replay with `statProfileRule: 0`, which means NOT ONE of them exercises this rule. Section 13
// asserts they really do pass it off (so the gate cannot be quietly dropped), and everything
// above it is the only coverage the rule has.
//
// The assertions are arithmetic and invariants, not pinned scores: a pinned row score goes red on
// a battle-data refresh with no defect behind it, and the bundled harvest moves every day.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { BuilderData } from "../builder/common.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import {
  STAT_AXES, BALANCE_PENALTY_CAP, BALANCE_SCORE_CAP, BALANCE_SCORE_PER_POINT, DEFAULT_ALLOWANCE,
  FRAIL_BULK, FRAIL_STEP, POWERLESS_STAT, POWERLESS_STEP, RATING_GAIN, SLOW_PLAN_PIVOT,
  STAT_FIT_SPAN, STAT_PROFILE_RULE, allowanceFor, attackingStat, balanceScoreDelta, bulkValues,
  candidateDeltas, candidateLine, directedSpeedFitFromBase, fitDelta, memberFromProfile,
  memberRatings, rating, slowPlan, statProfileRuleOption, teamBalance,
} from "../builder/stat-profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => JSON.parse(readFileSync(join(root, ...p), "utf8"));
const appData = read("data", "builder", "app-data.json");
const metaData = read("data", "builder", "meta-doubles.json");

let checked = 0;
const failures = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const near = (a, b, tol = 0.051) => Math.abs(Number(a) - Number(b)) <= tol;

const data = new BuilderData(appData);
data.ingestMeta("Doubles", metaData);
const engine = new DamageEngine(appData);

const set = (species, form, item, ability, nature, bonuses, moves) =>
  ({ species, form: form || species, item, ability, nature, bonuses, moves });

/** The regional-winning team, exactly as it was reported. */
const REGIONAL = [
  set("Salamence", "Salamence-Mega", "Salamencite", "Aerilate", "Timid", [2, 0, 0, 32, 0, 32], ["Hyper Voice", "Draco Meteor", "Flamethrower", "Protect"]),
  set("Tyranitar", "Tyranitar-Mega", "Tyranitarite", "Sand Stream", "Jolly", [2, 32, 0, 0, 0, 32], ["Rock Slide", "Knock Off", "Low Kick", "Protect"]),
  set("Corviknight", "", "Psychic Seed", "Mirror Armor", "Careful", [0, 32, 0, 0, 2, 32], ["Brave Bird", "Power Trip", "Bulk Up", "Roost"]),
  set("Excadrill", "", "Focus Sash", "Sand Rush", "Adamant", [0, 32, 1, 0, 1, 32], ["Iron Head", "Protect", "Rock Slide", "High Horsepower"]),
  set("Indeedee", "", "Choice Scarf", "Psychic Surge", "Modest", [2, 0, 0, 32, 0, 32], ["Expanding Force", "Mystical Fire", "Trick", "Protect"]),
  set("Sneasler", "", "Mental Herb", "Unburden", "Adamant", [2, 32, 0, 0, 0, 32], ["Dire Claw", "Close Combat", "Coaching", "Protect"]),
];

function evaluationFor(extra = {}) {
  const ev = new TeamEvaluator(data, engine, "Doubles",
    normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: 30 }), extra);
  ev.setMetaRecords(metaData.pokemon || []);
  return new TeamEvaluation(ev);
}

function rowsFor(team, extra = {}) {
  const evaluation = evaluationFor(extra);
  const payload = evaluation.evaluate(team, { checkSelection: null });
  const suggest = new TeamSuggestions(evaluation, {});
  return { payload, evaluation, ...suggest.run(payload, { selection: null }) };
}

function membersOf(team, extra = {}) {
  const evaluation = evaluationFor(extra);
  return evaluation.slots(team).map(({ entry, mon }) => memberFromProfile(evaluation.checks.profile(entry, mon)));
}

// --- 1. the ratings are against the FORMAT -------------------------------------------------
// p10 -> 10, median -> 50, p90 -> 90, on every axis. That is the whole point of two spans per
// axis: with one half-span these land at 18 on one axis and 98 on another.
{
  for (const [axis, [median, below, above]] of Object.entries(STAT_AXES)) {
    ok(`${axis}: its p10 rates 10`, near(rating(median - below, axis), 10), String(rating(median - below, axis)));
    ok(`${axis}: its median rates 50`, near(rating(median, axis), 50), String(rating(median, axis)));
    ok(`${axis}: its p90 rates 90`, near(rating(median + above, axis), 90), String(rating(median + above, axis)));
  }
  ok("the gain is 40 points per span", RATING_GAIN === 40.0);
  ok("a rating cannot leave 0..100", rating(-9999, "bulk") === 0 && rating(9999, "bulk") === 100);
  // An unknown axis falls back to a (50, 50, 50) axis, so ITS median rates 50 -- it does not
  // answer 50 for everything. The app's `AXES.get(axis, (50.0, 50.0, 50.0))` does exactly the
  // same, and a value far off that axis saturates in both. "Neutral" would be a different rule
  // that neither side implements.
  ok("an unknown axis falls back to a 50/50/50 axis, it does not throw",
    rating(50, "nonsense") === 50 && rating(123, "nonsense") === 100,
    `${rating(50, "nonsense")} / ${rating(123, "nonsense")}`);
}

// --- 2. bulk is the HARMONIC mean, so one soft side is a frailty ---------------------------
{
  const even = bulkValues({ hp: 150, defense: 100, sp_defense: 100 });
  const lopsided = bulkValues({ hp: 150, defense: 180, sp_defense: 20 });
  ok("an even spread's combined bulk is its two sides", near(even[2], 15, 0.01), String(even[2]));
  // Arithmetic would give the lopsided one 15 too -- the same as the even one.
  const arithmetic = (lopsided[0] + lopsided[1]) / 2;
  ok("a lopsided spread is NOT rescued by its strong side",
    lopsided[2] < arithmetic - 5, `${lopsided[2].toFixed(2)} vs arithmetic ${arithmetic.toFixed(2)}`);
  ok("and it rates frail where the even one does not",
    lopsided[2] < FRAIL_BULK && even[2] >= FRAIL_BULK, `${lopsided[2].toFixed(2)} / ${even[2].toFixed(2)}`);
  ok("a zero side cannot produce a positive combined bulk",
    bulkValues({ hp: 150, defense: 0, sp_defense: 200 })[2] === 0);
}

// --- 3. the attacking stat is the one its MOVES use ---------------------------------------
{
  const stats = { attack: 200, sp_attack: 60 };
  ok("a physical set is rated on Attack", JSON.stringify(attackingStat(stats, 2, 0)) === JSON.stringify([200, "physical"]));
  ok("a special set is rated on Sp. Attack", JSON.stringify(attackingStat(stats, 0, 2)) === JSON.stringify([60, "special"]));
  ok("a mixed set takes the better of the two", JSON.stringify(attackingStat(stats, 1, 1)) === JSON.stringify([200, "mixed"]));
  ok("a set with no damaging move answers none", JSON.stringify(attackingStat(stats, 0, 0)) === JSON.stringify([0, "none"]));
  ok("and that is what POWERLESS_STAT catches", memberRatings(stats, 0, 0).powerless === true);
  ok("a big attacker is not powerless", memberRatings({ ...stats, hp: 150, defense: 100, sp_defense: 100 }, 2, 0).powerless === false);
}

// --- 4. THE TWO PROFILE SHAPES, which is where this went wrong -----------------------------
// `TeamChecks.profile` gives `physical`/`special` as ARRAYS OF MOVE NAMES and its stats under
// `stats`; `TeamSynergy.profile` gives COUNTS and `battle_stats`. Both reach `memberFromProfile`,
// and `Number([...])` is NaN -- which rated EVERY candidate offence 0 and POWERLESS, Mega
// Salamence included, while every assertion about bulk still passed. Fails for the real reason:
// drop the normalisation and the arrays arm goes red.
{
  const stats = { hp: 150, attack: 200, defense: 100, sp_attack: 60, sp_defense: 100, speed: 120 };
  const asArrays = memberFromProfile({ name: "A", stats, physical: ["Rock Slide", "Iron Head"], special: [] });
  const asCounts = memberFromProfile({ name: "A", battle_stats: stats, physical: 2, special: 0 });
  ok("the array shape and the count shape agree exactly",
    JSON.stringify(asArrays) === JSON.stringify(asCounts), `${JSON.stringify(asArrays)} vs ${JSON.stringify(asCounts)}`);
  ok("and the array shape really found the physical side",
    asArrays.attacking_side === "physical" && asArrays.offense > 50, JSON.stringify(asArrays));
  ok("an empty array is no damaging move, not a missing field",
    memberFromProfile({ stats, physical: [], special: [] }).attacking_side === "none");
}

// --- 5. an unstamped profile is NOT a frail, powerless member -----------------------------
// With no stats `bulkValues` answers 0, so a missing profile would be charged for both flags.
{
  ok("no stats at all answers null", memberFromProfile({ name: "B" }) === null);
  ok("an empty profile answers null", memberFromProfile({}) === null);
  ok("null answers null", memberFromProfile(null) === null);
  ok("zero HP answers null", memberFromProfile({ stats: { hp: 0, defense: 100, sp_defense: 100 } }) === null);
  ok("and teamBalance drops it the way it drops an empty slot",
    teamBalance([memberFromProfile({}), memberRatings({ hp: 150, defense: 100, sp_defense: 100 }, 2, 0)], "").count === 1);
}

// --- 6. the gate -------------------------------------------------------------------------
{
  ok("production is on", STAT_PROFILE_RULE === 1);
  ok("an absent option means production", statProfileRuleOption(undefined) === 1 && statProfileRuleOption(null) === 1);
  for (const off of [0, "0", false, "off", "false", "no", "none", ""]) {
    ok(`${JSON.stringify(off)} turns it off`, statProfileRuleOption(off) === 0, String(statProfileRuleOption(off)));
  }
  for (const on of [1, "1", true, "on", 2]) {
    ok(`${JSON.stringify(on)} leaves it on`, statProfileRuleOption(on) === 1, String(statProfileRuleOption(on)));
  }
}

// --- 7. the team's shape, and the allowances ----------------------------------------------
{
  const frail = { name: "frail", frail: true, powerless: false, offense: 80, bulk: 10 };
  const passenger = { name: "pass", frail: false, powerless: true, offense: 0, bulk: 80 };
  const fine = { name: "fine", frail: false, powerless: false, offense: 60, bulk: 60 };

  ok("the default allowance is 2 frail and 1 passenger",
    JSON.stringify(allowanceFor("balanced")) === JSON.stringify(DEFAULT_ALLOWANCE) && JSON.stringify(DEFAULT_ALLOWANCE) === "[2,1]");
  ok("two frail members are free", teamBalance([frail, frail, fine, fine], "balanced").penalty === 0);
  ok("the third costs one step", teamBalance([frail, frail, frail, fine], "balanced").penalty === FRAIL_STEP);
  ok("and the fourth costs two", teamBalance([frail, frail, frail, frail], "balanced").penalty === FRAIL_STEP * 2);
  ok("one passenger is free", teamBalance([passenger, fine, fine, fine], "balanced").penalty === 0);
  ok("the second costs its own step", teamBalance([passenger, passenger, fine], "balanced").penalty === POWERLESS_STEP);
  ok("the penalty is capped",
    teamBalance([frail, frail, frail, frail, frail, frail].map((m, i) => ({ ...m, name: `f${i}`, powerless: true })), "balanced").penalty === BALANCE_PENALTY_CAP);

  // AN ARCHETYPE CAN ONLY BUY MORE TOLERANCE, never less: the corpus has no archetype labels, so
  // a stricter-than-measured allowance would be an unmeasured hunch that punishes real teams.
  for (const key of Object.keys({ "hyper offense": 1, offense: 1, screens: 1, stall: 1, "semi-stall": 1, "perish trap": 1 })) {
    const [f, p] = allowanceFor(key);
    ok(`${key} is no stricter than the default`, f >= DEFAULT_ALLOWANCE[0] && p >= DEFAULT_ALLOWANCE[1], `${f}/${p}`);
  }
  ok("hyper offense buys two more frail slots", JSON.stringify(allowanceFor("hyper offense")) === "[4,1]");
  ok("stall buys two more passengers", JSON.stringify(allowanceFor("stall")) === "[2,3]");
  ok("an unknown archetype is the measured default", JSON.stringify(allowanceFor("nonsense")) === JSON.stringify(DEFAULT_ALLOWANCE));
  ok("the archetype is matched case-insensitively", JSON.stringify(allowanceFor("Hyper Offense")) === "[4,1]");

  // Only FILLED slots count: a four-Pokemon team is judged as a four-Pokemon team.
  const four = teamBalance([frail, frail, frail, fine], "balanced");
  ok("the count is the filled slots", four.count === 4);
  ok("the summary names who and what the archetype allows",
    four.lines.length === 1 && four.summary.includes("3 of 4 are frail") && four.summary.includes("allows 2"), four.summary);
  ok("a balanced team says so", teamBalance([fine, fine], "balanced").summary.includes("balanced for its archetype"));
}

// --- 8. what a candidate's own stats are worth --------------------------------------------
{
  ok("the median is worth nothing", fitDelta(50) === 0);
  ok("the top of the format is worth the whole span", fitDelta(100) === STAT_FIT_SPAN);
  ok("the bottom costs the whole span", fitDelta(0) === -STAT_FIT_SPAN);
  ok("and it is linear in between", near(fitDelta(75), STAT_FIT_SPAN / 2, 0.001));
  ok("a rating outside 0..100 cannot exceed the span", fitDelta(1000) === STAT_FIT_SPAN && fitDelta(-1000) === -STAT_FIT_SPAN);
  ok("a candidate is rated on offence and bulk, in that order",
    JSON.stringify(candidateDeltas({ offense: 100, bulk: 0 })) === JSON.stringify([STAT_FIT_SPAN, -STAT_FIT_SPAN]));

  // A fit point is 0.32/4 = 0.08 of a row score, so the span is 2.4 score points either way.
  ok("one axis spans 2.4 row-score points", near((STAT_FIT_SPAN * 0.32) / 4, 2.4, 0.001));

  ok("removing a 6-point penalty is worth 3 score points",
    balanceScoreDelta({ penalty: 6 }, { penalty: 0 }) === FRAIL_STEP * BALANCE_SCORE_PER_POINT);
  ok("adding one costs the same", balanceScoreDelta({ penalty: 0 }, { penalty: 6 }) === -FRAIL_STEP * BALANCE_SCORE_PER_POINT);
  ok("no change is worth nothing", balanceScoreDelta({ penalty: 6 }, { penalty: 6 }) === 0);
  ok("the term is capped both ways",
    balanceScoreDelta({ penalty: 100 }, { penalty: 0 }) === BALANCE_SCORE_CAP
    && balanceScoreDelta({ penalty: 0 }, { penalty: 100 }) === -BALANCE_SCORE_CAP);
  ok("and the cap is smaller than the threat terms it breaks ties under", BALANCE_SCORE_CAP < 18);
}

// --- 9. the speed fit points the way the plan points --------------------------------------
{
  ok("trick room is the slow plan", slowPlan("trick room") && slowPlan("Trick Room"));
  ok("nothing else is", !slowPlan("sand") && !slowPlan("balanced") && !slowPlan(""));
  ok("a plan that is not slow is left alone", directedSpeedFitFromBase(180, "sand", 71) === 71);
  // Only the raw-Speed term moves: 35 + min(30, speed/5) out, min(30, (125-speed)/4) in.
  const fast = directedSpeedFitFromBase(180, "trick room", 71);
  const slow = directedSpeedFitFromBase(25, "trick room", 40);
  ok("a fast Pokemon loses its raw-Speed credit on a room team", fast < 71, String(fast));
  ok("and a slow one gains it", slow > 40, String(slow));
  ok("the exchange is exactly the two terms",
    near(fast, 71 - Math.min(30, 180 / 5) + Math.min(30, Math.max(0, SLOW_PLAN_PIVOT - 180) / 4), 0.001), String(fast));
  ok("the pivot is V511's, so Auto Build and Suggestions agree", SLOW_PLAN_PIVOT === 125.0);
  ok("the directed fit cannot leave 0..100",
    directedSpeedFitFromBase(0, "trick room", 100) <= 100 && directedSpeedFitFromBase(400, "trick room", 0) >= 0);
}

// --- 10. the sentence cannot disagree with the score --------------------------------------
// The FLAGS come first: a line calling a Pokemon average while the penalty charges for it would
// be worse than no line at all.
{
  const frail = memberRatings({ hp: 100, attack: 200, defense: 60, sp_defense: 60, speed: 100 }, 2, 0);
  ok("a frail member's line says so", candidateLine(frail).includes("frail for this meta"), candidateLine(frail));
  const none = memberRatings({ hp: 200, attack: 200, defense: 150, sp_defense: 150 }, 0, 0);
  ok("no damaging move is said plainly", candidateLine(none).includes("no damaging move"), candidateLine(none));
  ok("a powerless attacker is named as such",
    candidateLine(memberRatings({ hp: 200, attack: 50, defense: 150, sp_defense: 150 }, 2, 0)).includes("too low to threaten"));
  ok("the side is named for a physical set", candidateLine(frail).includes("its physical"), candidateLine(frail));
  ok("a repaired balance is mentioned", candidateLine(frail, 2).includes("repairs the team's stat balance"));
  ok("a worsened one too", candidateLine(frail, -2).includes("worsens the team's stat balance"));
  ok("an unremarkable member says nothing at all",
    candidateLine(memberRatings({ hp: 170, attack: 165, defense: 100, sp_defense: 100 }, 2, 0)) === "");
}

// --- 11. the live path: the app's own numbers, and the gate -------------------------------
{
  const members = membersOf(REGIONAL);
  ok("every member of a real team is rated", members.every(Boolean), String(members.filter(Boolean).length));
  const sneasler = members.find((m) => m && String(m.name).startsWith("Sneasler"));
  // Derived from the Companion's own documented invested line for this set,
  // 157/200/80/54/100/172 -- the arithmetic, not a number copied off a screen:
  //   bulk  2/(1/(157*80/1000) + 1/(157*100/1000)) = 13.95 -> 50 - 40*(17.5-13.95)/5  = 21.6
  //   off   Attack 200                                     -> 50 + 40*(200-160)/34    = 97.1
  //   spe   Speed 172                                      -> 50 + 40*(172-120)/57    = 86.5
  if (sneasler) {
    ok("Sneasler's bulk is the app's 21.6", near(sneasler.bulk, 21.6), String(sneasler.bulk));
    ok("its offence is the app's 97.1", near(sneasler.offense, 97.1), String(sneasler.offense));
    ok("its speed is the app's 86.5", near(sneasler.speed, 86.5), String(sneasler.speed));
    ok("and it is frail, which is the flag the penalty counts", sneasler.frail === true);
  } else {
    ok("Sneasler is in the shipped data (skipped)", true);
  }
  ok("the stats are INVESTED, not base: a base-stat read would rate this team far lower",
    members.filter(Boolean).some((m) => m.offense >= 95), JSON.stringify(members.filter(Boolean).map((m) => m.offense)));

  const on = rowsFor(REGIONAL);
  const off = rowsFor(REGIONAL, { statProfileRule: 0 });
  ok("the rule attaches its working to every row it prices",
    on.rows.length > 0 && on.rows.every((r) => r.stat_profile_v553), String(on.rows.filter((r) => r.stat_profile_v553).length));
  ok("with the rule off NO row carries it",
    off.rows.length > 0 && off.rows.every((r) => !r.stat_profile_v553));
  ok("with the rule off no row shows a Stats: sentence",
    off.rows.every((r) => !(r.details || []).some((d) => String(d).startsWith("Stats: "))));
  ok("with the rule on some row does",
    on.rows.some((r) => (r.details || []).some((d) => String(d).startsWith("Stats: "))));
  ok("and the rule moves the list", on.rows.some((r) => {
    const was = off.rows.find((o) => o.name === r.name);
    return was && Math.abs(was.score - r.score) >= 0.05;
  }));
  // THE SCORE DIFFERENCE IS NOT BOUNDED BY THE RULE'S OWN TERMS, and asserting that it is would
  // be a trap. The direct terms are small -- offence and bulk are 2.4 row-score points each and
  // the balance term is capped at 6 -- but `typeFit`'s offence also feeds V511's STAGE-TWO
  // re-rank, which measures the best of the pool against the team's worst threats with real
  // calcs and cuts the shown list from that ranking. A changed order there moves a score by much
  // more: measured on the regional six, Decidueye goes 60.0 -> 70.3 with a balance delta of 0.
  // A bound of 2.4+2.4+6 passes that by 0.65 points today and would go red on a data refresh
  // with no defect behind it. So bound what the rule actually RECORDS, which is exact.
  for (const row of on.rows) {
    const s = row.stat_profile_v553;
    if (!s) continue;
    ok(`${row.name}'s recorded balance term is within the cap`,
      Math.abs(Number(s.balance_score_delta) || 0) <= BALANCE_SCORE_CAP, String(s.balance_score_delta));
    const [dOff, dDef] = candidateDeltas(s.member);
    ok(`${row.name}'s own fit deltas are within the span`,
      Math.abs(dOff) <= STAT_FIT_SPAN && Math.abs(dDef) <= STAT_FIT_SPAN, `${dOff} / ${dDef}`);
  }
  // ONCE PER ROW: the recorded delta must equal what the member's own balance change is worth.
  for (const row of on.rows.slice(0, 6)) {
    const sp = row.stat_profile_v553;
    if (!sp) continue;
    ok(`${row.name}'s balance term is charged once`,
      near(sp.balance_score_delta, balanceScoreDelta({ penalty: sp.balance_before }, { penalty: sp.balance_after }), 0.011),
      `${sp.balance_score_delta} vs ${sp.balance_before}->${sp.balance_after}`);
  }
}

// --- 12. a team that is actually over its allowance ---------------------------------------
// Found by SEARCH and built from each species' OWN COMMON SET, not hard-coded. Two traps, both
// hit writing this:
//   * a hard-coded team goes red on a battle-data refresh with no defect behind it; and
//   * `TeamChecks.profile` reads `entry.moves` with no common-set fallback, so a team built with
//     empty movesets makes every member POWERLESS as well as frail. That pins the penalty at its
//     cap of 18, where no candidate can move it and `hyper offense` cannot be told from
//     `balanced` -- which looked like two defects in the rule and was one in the harness.
// So the team is exactly ONE member over the frail allowance, and nobody is a passenger.
{
  const ev = new TeamEvaluator(data, engine, "Doubles",
    normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: 30 }), {});
  ev.setMetaRecords(metaData.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const withCommonSet = (name) => {
    const common = ev.commonSet(name) || {};
    return set(name, name, common.item || "", common.ability || "", common.nature_name || "Serious",
      common.bonuses || [0, 0, 0, 0, 0, 0], common.moves || []);
  };
  const rated = [];
  for (const meta of (metaData.pokemon || []).slice(0, 150)) {
    const name = String(meta.name || meta.base_name || "").trim();
    if (!name) continue;
    try {
      const entry = withCommonSet(name);
      const slots = evaluation.slots([entry]);
      const member = memberFromProfile(evaluation.checks.profile(slots[0].entry, slots[0].mon));
      if (member && !member.powerless) rated.push([name, member, entry]);
    } catch { /* a species this build cannot construct */ }
  }
  const frail = rated.filter(([, m]) => m.frail);
  const sturdy = rated.filter(([, m]) => !m.frail);
  ok("the shipped meta has frail species with real sets", frail.length >= 5, `${frail.length} of ${rated.length}`);
  ok("and a sturdy one to fill the last slot", sturdy.length >= 1, `${sturdy.length} of ${rated.length}`);
  if (frail.length >= 5 && sturdy.length >= 1) {
    // FIVE frail, not three. The team is judged against the archetype it CLASSIFIES as, and a
    // pile of frail attackers classifies as `hyper offense`, which buys an allowance of 4 -- so a
    // three-frail team is legitimately free and the term correctly reads 0. Five is over even
    // that, and still two steps under the cap of 18, where the number can move.
    const team = [...frail.slice(0, 5), ...sturdy.slice(0, 1)].map(([, , entry]) => entry);
    const members = membersOf(team).filter(Boolean);
    const balance = teamBalance(members, "balanced");
    ok("the team is six rated members", members.length === 6, String(members.length));
    ok("nobody on it is a passenger", balance.powerless === 0, `${balance.powerless} powerless`);
    ok("five frail against an allowance of two is charged",
      balance.penalty > 0, `penalty ${balance.penalty} from ${balance.frail} frail`);
    ok("and the summary says which ones and what is allowed",
      balance.summary.includes("are frail for this meta") && balance.summary.includes("allows 2"), balance.summary);
    // An archetype can only buy MORE tolerance, so the lenient one is charged less -- and both
    // are below the cap here, which is the only reason the two can be told apart at all.
    ok("hyper offense is charged less for the same six",
      teamBalance(members, "hyper offense").penalty < balance.penalty,
      `${teamBalance(members, "hyper offense").penalty} vs ${balance.penalty}`);

    // THE LIVE TERM, DRIVEN DIRECTLY. Going through `run()` and hoping a frail candidate reaches
    // the shown list tests nothing when it does not: the top-ranked candidates are the good ones,
    // which are rarely the frail ones, so every shown delta was legitimately 0. Calling the method
    // with a pinned archetype and a known-frail candidate makes the arithmetic exact.
    if (frail.length >= 4 && sturdy.length >= 2) {
      const suggest = new TeamSuggestions(evaluation, {});
      const basisTeam = [...frail.slice(0, 3), ...sturdy.slice(0, 2)].map(([, , e]) => e);
      const basisSlots = evaluation.slots(basisTeam);
      const candidateEntry = frail[3][2];
      const candidateSlot = evaluation.slots([candidateEntry])[0];
      const candidateProfile = evaluation.checks.profile(candidateSlot.entry, candidateSlot.mon);
      const row = {
        name: "probe", score: 50, details: [], _v104_detail_severities: {},
        _candidate_profile: candidateProfile, strategy_archetype_v466: "balanced",
        _before_check_rows: [],
      };
      suggest.statBalanceFit(row, { basisSlots, teamSlots: basisSlots, teamEntries: basisTeam });
      const s = row.stat_profile_v553;
      // Three frail in the basis against an allowance of 2 is one step (6); a fourth makes two
      // steps (12); half a penalty point per score point is -3.
      ok("the basis of three frail is charged one step", s && s.balance_before === FRAIL_STEP,
        `${s?.balance_before}`);
      ok("adding a fourth frail member charges two", s && s.balance_after === FRAIL_STEP * 2,
        `${s?.balance_after}`);
      ok("so the candidate is charged exactly half of what it added",
        s && near(s.balance_score_delta, -FRAIL_STEP * BALANCE_SCORE_PER_POINT, 0.011), `${s?.balance_score_delta}`);
      ok("and the row's score moved by that much", near(row.score, 50 - FRAIL_STEP * BALANCE_SCORE_PER_POINT), String(row.score));
      ok("the archetype it was pinned to is the one it used", s?.archetype === "balanced", String(s?.archetype));
      ok("it says so in the row's details",
        row.details.some((d) => String(d).includes("are frail for this meta")), JSON.stringify(row.details));
      ok("and the candidate's own line calls it frail",
        row.details.some((d) => String(d).startsWith("Stats: ") && d.includes("frail")), JSON.stringify(row.details));
      // ONCE PER ROW: a second pass must not charge it again.
      const scoreAfterFirst = row.score;
      suggest.statBalanceFit(row, { basisSlots, teamSlots: basisSlots, teamEntries: basisTeam });
      ok("a second pass over the same row charges nothing", row.score === scoreAfterFirst,
        `${scoreAfterFirst} -> ${row.score}`);
      ok("and does not duplicate its sentences",
        new Set(row.details).size === row.details.length, JSON.stringify(row.details));
    } else {
      ok("four frail and two sturdy species were available (skipped)", true, `${frail.length}/${sturdy.length}`);
    }

    // And over the live list: whatever each row was priced against, its own numbers must agree.
    const on = rowsFor(team);
    const priced = on.rows.filter((r) => r.stat_profile_v553);
    ok("every shown row carries its working", priced.length === on.rows.length, `${priced.length}/${on.rows.length}`);
    const deltas = priced.map((r) => Number(r.stat_profile_v553.balance_score_delta) || 0);
    ok("never by more than the cap", deltas.every((d) => Math.abs(d) <= BALANCE_SCORE_CAP),
      String(Math.max(...deltas.map(Math.abs))));
    // Rows may legitimately be priced against DIFFERENT archetypes: a swap's basis is the team
    // without the member it replaces, so each row has its own `archetype_fit` check row. What must
    // hold is that each row's recorded penalties are what its OWN archetype produces.
    for (const r of priced.slice(0, 8)) {
      const s = r.stat_profile_v553;
      ok(`${r.name}'s delta is its own two penalties`,
        near(s.balance_score_delta, balanceScoreDelta({ penalty: s.balance_before }, { penalty: s.balance_after }), 0.011),
        `${s.balance_score_delta} from ${s.balance_before}->${s.balance_after}`);
    }

    // THE SIGN IS A PROPERTY OF V524'S BASIS, not an accident, and it is the app's too.
    // With a basis active, `before` is the team the row would leave behind -- the outgoing member
    // already removed -- and `after` is that team PLUS the candidate. Appending can only add frail
    // or powerless members, never remove one, so on this path the term is only ever <= 0: a swap
    // that takes a frail member out has that improvement baked into its `before` rather than
    // credited as a delta. The positive case belongs to the legacy slot-projection path, where
    // `projected_members` REPLACES at the slot. Candidates for one slot are still ranked against
    // each other correctly, which is what the term is for.
    ok("on the basis path the term is never a bonus",
      deltas.every((d) => d <= 1e-9), `deltas ${deltas.filter((d) => d > 0).join(",")}`);
    for (const row of priced.slice(0, 8)) {
      const s = row.stat_profile_v553;
      ok(`${row.name}: its after-team is its basis plus itself, never fewer frail`,
        Number(s.frail_after) >= Number(s.frail_before), `${s.frail_before} -> ${s.frail_after}`);
    }
  } else {
    ok("enough frail and sturdy species were available to build the team (skipped)", true,
      `frail ${frail.length}, sturdy ${sturdy.length}`);
  }
}

// --- 13. the recorded suites replay the world they were recorded in -----------------------
// Not one of the nine recordings carries a `stat_profile` stamp, so every suite that replays one
// must pass the rule OFF. Without this guard, dropping that flag turns a real divergence into a
// green suite -- and this rule has no vector coverage of its own to catch it.
{
  for (const name of ["run-suggest-vectors.mjs", "run-autobuild-vectors.mjs"]) {
    const source = readFileSync(join(here, name), "utf8");
    ok(`${name} replays with no stat profile`, /statProfileRule:\s*0/.test(source));
  }
  for (const name of ["suggest-vectors.json", "suggest-vectors-v5.json", "suggest-vectors-scoring.json",
    "autobuild-vectors.json", "eval-vectors.json", "overview-vectors.json"]) {
    const text = readFileSync(join(here, name), "utf8");
    ok(`${name} really has no stat_profile stamp to honour`, !text.includes("stat_profile"));
  }
}

// --- 14. one rule in two languages --------------------------------------------------------
// A threshold changed in one and not the other is a silent divergence no vector suite can see,
// because every recorded suite replays with the rule off.
{
  const appModule = join(root, "..", "..", "pct_tool94", "pokemon_champions_tool", "stat_profile_v553.py");
  let app = "";
  try { app = readFileSync(appModule, "utf8"); } catch { /* a checkout without the app */ }
  if (app) {
    ok("the Companion rates on the same gain", /RATING_GAIN\s*=\s*40\.0/.test(app));
    ok("and calls the same bulk frail", new RegExp(`FRAIL_BULK\\s*=\\s*${FRAIL_BULK}`).test(app));
    ok("and the same attack powerless", new RegExp(`POWERLESS_STAT\\s*=\\s*${POWERLESS_STAT}`).test(app));
    ok("and charges the same steps", new RegExp(`FRAIL_STEP\\s*=\\s*${FRAIL_STEP}`).test(app)
      && new RegExp(`POWERLESS_STEP\\s*=\\s*${POWERLESS_STEP}`).test(app));
    ok("and caps the penalty at the same point", new RegExp(`BALANCE_PENALTY_CAP\\s*=\\s*${BALANCE_PENALTY_CAP}`).test(app));
    ok("and spans a candidate's fit the same way", new RegExp(`STAT_FIT_SPAN\\s*=\\s*${STAT_FIT_SPAN}`).test(app));
    ok("and pays the same per balance point", new RegExp(`BALANCE_SCORE_PER_POINT\\s*=\\s*${BALANCE_SCORE_PER_POINT}`).test(app)
      && new RegExp(`BALANCE_SCORE_CAP\\s*=\\s*${BALANCE_SCORE_CAP}`).test(app));
    ok("and pivots its slow plan at the same speed", new RegExp(`SLOW_PLAN_PIVOT\\s*=\\s*${SLOW_PLAN_PIVOT}`).test(app));
    ok("and measures the same three axes", /"bulk":\s*\(17\.5,\s*5\.0,\s*7\.5\)/.test(app)
      && /"offense":\s*\(160\.0,\s*45\.0,\s*34\.0\)/.test(app)
      && /"speed":\s*\(120\.0,\s*65\.0,\s*57\.0\)/.test(app));
    ok("and buys the same archetype tolerances", /"hyper offense":\s*\(4,\s*1\)/.test(app)
      && /"stall":\s*\(2,\s*3\)/.test(app) && /DEFAULT_ALLOWANCE[^=]*=\s*\(2,\s*1\)/.test(app));
    ok("and takes bulk as the harmonic mean of the two sides", /2\.0\s*\/\s*\(1\.0\s*\/\s*physical\s*\+\s*1\.0\s*\/\s*special\)/.test(app));
  } else {
    ok("the Companion module was not readable from here (skipped)", true);
  }
}

console.log(`${checked} checked, ${failures.length} failed`);
for (const line of failures) console.log(`  FAIL ${line}`);
process.exit(failures.length ? 1 : 0);
