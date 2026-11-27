// Checks builder/autobuild-balance.js and the climb it drives in builder/autobuild-search.js:
// Auto Build ranks complete teams by where their four scores STAND among real teams (two thirds
// of the average percentile plus a third of the weakest, minus a charge per red threat), and
// swaps the members it added while that balance improves.
//
//   1. standingOf: 0 / 100 at the ends, continuous and never decreasing in between, and its
//      whole part is exactly the percentile a tile shows (score-calibration.js percentileOf)
//   2. balanceOf / BALANCE_OBJECTIVE: the weakest term decides between similar averages and does
//      not veto an excellent team; balanceOption parses like every other rule switch
//   3. teamSummary: T is the balance minus the red-threat charge with a table, the raw mean minus
//      one per red threat without one (byte-for-byte the old summary)
//   4. Deep builds with and without the rule on the same starts: the rule's pick is never less
//      balanced than the old pick by more than the margin, and better on average -- the
//      complaint was a 97th-percentile Speed beside a 16th-percentile Synergy
//   5. every accepted climb step beats the team before it, kept members are never swapped, and
//      the finished-team rules hold (Item Clause, two stones, complete, switch-in warnings)
//   6. no table (Singles today) or `autobuildBalance: 0` is the old search exactly: the same team,
//      the same compared teams, basis "score", no climb
//   7. the same input gives the same team twice (counts bound the climb), and a Stop during the
//      climb answers within about a second with a complete team
//
//   node tests/run-autobuild-balance.mjs        (about 8 minutes)
//   QUICK=1 node tests/run-autobuild-balance.mjs  sections 1-3 and one build pair

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, compact } from "../builder/engine.js";
import { TeamEvaluator, DEFAULT_SETTINGS, normalizeSettings } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TeamAutoBuild } from "../builder/team-autobuild.js";
import { teamSummary, beats, SEARCH_OBJECTIVE } from "../builder/autobuild-search.js";
import { AXES, QUANTILES, percentileOf } from "../builder/score-calibration.js";
import {
  AUTOBUILD_BALANCE, BALANCE_CLIMB, BALANCE_OBJECTIVE, anchorsFit, balanceOf, balanceOn, balanceOption, standingOf, standingWord,
} from "../builder/autobuild-balance.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const appData = read("data/builder/app-data.json");
const knownPayload = read("data/builder/known-teams.json");
const anchors = read("data/builder/score-anchors.json");
const quick = Boolean(process.env.QUICK);

const failures = [];
let checked = 0;
const check = (ok, message) => {
  checked += 1;
  if (!ok) failures.push(message);
};
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// --- 1. standingOf ---------------------------------------------------------------------------
{
  for (const axis of AXES) {
    const q = anchors.axes[axis];
    check(standingOf(anchors, axis, q[0] - 5) === 0, `${axis}: a score below every library team stands at 0`);
    check(standingOf(anchors, axis, q[0]) === 0, `${axis}: the lowest library team's score stands at 0`);
    check(standingOf(anchors, axis, q[QUANTILES - 1]) === 100, `${axis}: the highest library team's score stands at 100`);
    check(standingOf(anchors, axis, q[QUANTILES - 1] + 5) === 100, `${axis}: a score above every library team stands at 100`);
    // A sweep across the whole range: never decreasing, and its whole part is the tile's percentile.
    let last = -1;
    let monotone = true;
    let agree = 0;
    let total = 0;
    for (let v = q[0] - 1; v <= q[QUANTILES - 1] + 1; v += 0.037) {
      const s = standingOf(anchors, axis, v);
      if (s < last - 1e-12) monotone = false;
      last = s;
      const p = percentileOf(anchors, axis, v);
      total += 1;
      if (Math.floor(s) === p) agree += 1;
    }
    check(monotone, `${axis}: standingOf decreased somewhere in the sweep`);
    check(agree === total, `${axis}: standingOf's whole part disagrees with percentileOf on ${total - agree} of ${total} scores`);
    // Continuous: halfway between two distinct quantile points reads halfway.
    const p = q.findIndex((x, i) => i > 0 && i < 99 && q[i + 1] > x);
    const mid = (q[p] + q[p + 1]) / 2;
    check(close(standingOf(anchors, axis, mid), p + 0.5, 1e-9), `${axis}: halfway between q[${p}] and q[${p + 1}] should stand at ${p + 0.5}, got ${standingOf(anchors, axis, mid)}`);
  }
  check(standingOf(anchors, "synergy", null) === null && standingOf(anchors, "synergy", "") === null && standingOf(anchors, "synergy", NaN) === null, "standingOf: no score is no standing, never 0");
  check(standingOf(anchors, "synergy", "62.5") === standingOf(anchors, "synergy", 62.5), "standingOf: a numeric string reads like the number");
  check(standingOf(null, "synergy", 60) === null && standingOf(anchors, "nonsense", 60) === null, "standingOf: no table / no axis is null");
  check(standingWord(0) === "0th" && standingWord(1.9) === "1st" && standingWord(22.4) === "22nd" && standingWord(13) === "13th" && standingWord(100) === "100th", "standingWord: the tiles' ordinals, from the whole part");
}

// --- 2. balanceOf, the objective, the option ---------------------------------------------------
{
  // A table where a score IS its standing, so the arithmetic can be read directly.
  const identity = { axes: Object.fromEntries(AXES.map((axis) => [axis, Array.from({ length: QUANTILES }, (_, i) => i)])), format: "Doubles" };
  const team = (s, o, d, sp) => balanceOf(identity, { synergy: s, offense: o, defense: d, speed: sp });
  const lopsided = team(80, 80, 80, 20);
  const even = team(62, 62, 62, 62);
  const excellent = team(99, 99, 99, 40);
  check(close(lopsided.value, (2 / 3) * 65 + (1 / 3) * 20), `balanceOf: 80/80/80/20 is ${lopsided.value}`);
  check(even.value > lopsided.value, "the weakest term: 62 across must beat 80/80/80/20");
  check(excellent.value > even.value, "the weakest term must not veto 99/99/99/40 against 62 across");
  check(lopsided.weakestAxis === "speed" && lopsided.weakest === 20, "balanceOf names the weakest axis");
  // The complaint's own tiles, 16 / 44 / 24 / 97: a team BELOW the median on every axis must
  // still rank above it, because nothing high can make up for a 16th percentile.
  const complaint = team(16, 44, 24, 97);
  const belowMedian = team(45, 45, 45, 45);
  check(belowMedian.value > complaint.value, `the complaint's 16/44/24/97 (${complaint.value.toFixed(1)}) must rank below 45 across (${belowMedian.value.toFixed(1)})`);
  check(balanceOf(null, { synergy: 1, offense: 1, defense: 1, speed: 1 }) === null, "balanceOf: no table is null");
  check(balanceOf(identity, { synergy: 50, offense: 50, defense: 50 }) === null, "balanceOf: a missing score is null, not a zero standing");
  check(close(BALANCE_OBJECTIVE.meanWeight + BALANCE_OBJECTIVE.weakestWeight, 1), "the two balance weights sum to 1");
  check(BALANCE_OBJECTIVE.basis === "standing" && SEARCH_OBJECTIVE.redThreatWeight === 1 && SEARCH_OBJECTIVE.margin === 1, "the old objective is untouched");
  check(balanceOption(undefined) === AUTOBUILD_BALANCE && balanceOption(0) === 0 && balanceOption("off") === 0 && balanceOption(null) === 0 && balanceOption(false) === 0 && balanceOption("2") === 2, "balanceOption parses like the other rule switches");
  check(balanceOn(undefined) && !balanceOn(0), "balanceOn");
  check(anchorsFit(anchors, "Doubles") && !anchorsFit(anchors, "Singles") && !anchorsFit(null, "Doubles") && !anchorsFit({ axes: {} }, "Doubles"), "anchorsFit: a Doubles table ranks Doubles teams only");
  // Fast does not climb (it exists to answer in about ten seconds); Medium and Deep do.
  check(BALANCE_CLIMB.fast === null, "BALANCE_CLIMB.fast is null: Fast compares by balance but does not climb");
  for (const depth of ["medium", "deep"]) {
    const size = BALANCE_CLIMB[depth];
    check(size && size.rounds >= 1 && size.pool > 0 && size.perTarget > 0 && size.finalists >= 1 && size.carry >= 0, `BALANCE_CLIMB.${depth} is a usable size`);
  }
  check(BALANCE_CLIMB.deep.pool >= BALANCE_CLIMB.medium.pool && BALANCE_CLIMB.deep.rounds >= BALANCE_CLIMB.medium.rounds, "Deep climbs at least as far as Medium");
}

// --- 3. teamSummary -------------------------------------------------------------------------------
{
  const threats = [72, 71, 64, 30].map((score, i) => ({ name: `T${i}`, score }));
  const payload = { synergy_score: 62.7, offense_score: 50.3, defense_score: 48.1, speed: { score: 67 }, threats, checks: { rows: [] } };
  const plain = teamSummary(payload, "", SEARCH_OBJECTIVE);
  check(close(plain.T, Number(((62.7 + 50.3 + 48.1 + 67) / 4 - 2).toFixed(3))) && plain.standings === undefined && plain.balance === undefined, `teamSummary without a table is the old summary (T ${plain.T})`);
  const balanced = teamSummary(payload, "", BALANCE_OBJECTIVE, { anchors });
  const b = balanceOf(anchors, { synergy: 62.7, offense: 50.3, defense: 48.1, speed: 67 });
  check(close(balanced.T, Number((b.value - BALANCE_OBJECTIVE.redThreatWeight * 2).toFixed(3))), `teamSummary with a table: T ${balanced.T} should be ${b.value.toFixed(3)} - ${BALANCE_OBJECTIVE.redThreatWeight} x 2`);
  check(balanced.threatsRed === 2 && balanced.mean === plain.mean, "teamSummary keeps the raw mean and the red-threat count");
  check(AXES.every((axis) => Number.isFinite(balanced.standings?.[axis])) && balanced.weakest === b.weakestAxis, "teamSummary carries the standings and the weakest axis");
}

// --- the builds ---------------------------------------------------------------------------------
const set = (species, item, ability, nature, moves, bonuses, form = species) => ({ species, form, item, ability, nature, moves, bonuses });
const STARTS = {
  empty: [],
  single: [set("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"], [32, 0, 14, 0, 20, 0])],
  partial: [
    set("Garchomp", "Garchompite Z", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]),
    set("Rillaboom", "Assault Vest", "Grassy Surge", "Adamant", ["Fake Out", "Grassy Glide", "Wood Hammer", "U-turn"], [32, 32, 0, 0, 2, 0]),
    set("Sylveon", "Throat Spray", "Pixilate", "Modest", ["Hyper Voice", "Moonblast", "Quick Attack", "Protect"], [32, 0, 0, 32, 2, 0]),
  ],
  // The complaint's own lead: a Tailwind Mega Dragonite.
  dragonite: [set("Dragonite", "Dragoninite", "Multiscale", "Modest", ["Protect", "Tailwind", "Heat Wave", "Draco Meteor"], [2, 0, 0, 32, 0, 32], "Mega Dragonite")],
};
const teamOf = (name) => Array.from({ length: 6 }, (_, i) => STARTS[name][i] || null);

function makeEvaluation(format = "Doubles", { withAnchors = true } = {}) {
  const engine = new DamageEngine(appData);
  const evaluator = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }));
  evaluator.setMetaRecords(read(`data/builder/meta-${format.toLowerCase()}.json`).pokemon);
  const evaluation = new TeamEvaluation(evaluator);
  evaluation.knownTeams = new KnownTeams(knownPayload);
  // As the worker does: the table the tiles read (Singles has none, so it stays null there).
  if (withAnchors) evaluation.scoreAnchors = format === "Doubles" ? anchors : null;
  return evaluation;
}

async function build(evaluation, start, options = {}) {
  const t0 = performance.now();
  let stopAt = 0;
  const shouldStop = options.stopAfterMs ? () => {
    if (performance.now() - t0 < options.stopAfterMs) return false;
    stopAt ||= performance.now();
    return true;
  } : null;
  const run = await new TeamAutoBuild(evaluation).run(teamOf(start), { search: options.depth || "deep", depth: options.depth || "deep", shouldStop, ...options });
  const end = performance.now();
  return { run, seconds: (end - t0) / 1000, afterStop: stopAt ? (end - stopAt) / 1000 : null };
}
const teamText = (entries) => (entries || []).filter((e) => e?.pokemon).map((e) => `${e.form || e.pokemon} @ ${e.item || "-"}`).join(", ");
const balanceText = (s) => `${AXES.map((a) => standingWord(s.standings?.[a] ?? balanceOf(anchors, s.scores)?.standings[a])).join("/")}`;

function finishedRules(label, run, evaluation, start) {
  const entries = run.entries || [];
  check(entries.filter((e) => e?.pokemon).length === 6, `${label}: the team is not complete`);
  const items = entries.filter((e) => e?.pokemon && e.item).map((e) => compact(e.item));
  check(items.length === new Set(items).size, `${label}: Item Clause broken (${items.join(", ")})`);
  const stones = entries.filter((e) => e?.pokemon && e.item && evaluation.ev.engine.isMegaStone(e.item)).length;
  check(stones <= 2, `${label}: ${stones} Mega Stones`);
  const b = new TeamAutoBuild(evaluation);
  const warnings = b.defensiveWarnings(b.slotsFor(entries, run.spreads));
  check(warnings <= 2 || run.log.some((line) => /^No Pokémon for the last slot/.test(line)), `${label}: ${warnings} defensive switch-in warnings without the recorded fallback`);
  teamOf(start).forEach((s, i) => {
    if (s) check(compact(entries[i]?.pokemon) === compact(s.species), `${label}: kept slot ${i} ${s.species} became ${entries[i]?.pokemon}`);
  });
}

const evaluation = makeEvaluation();
const plainEvaluation = makeEvaluation("Doubles", { withAnchors: false });
const pairs = [];
for (const start of quick ? ["empty"] : Object.keys(STARTS)) {
  const on = await build(evaluation, start);
  const off = await build(evaluation, start, { autobuildBalance: 0 });
  const label = `deep ${start}`;
  if (on.run.error || off.run.error) {
    failures.push(`${label}: ${on.run.error || off.run.error}`);
    continue;
  }
  const chosenOn = on.run.compared.find((t) => t.chosen);
  const chosenOff = off.run.compared.find((t) => t.chosen);
  // 4. Both picks on the same yardstick: the balanced objective.
  const bOn = balanceOf(anchors, chosenOn.summary.scores);
  const bOff = balanceOf(anchors, chosenOff.summary.scores);
  pairs.push({ start, on: bOn, off: bOff, secondsOn: on.seconds, secondsOff: off.seconds, climb: on.run.search.climb });
  check(on.run.search.objective.basis === "standing" && off.run.search.objective.basis === "score", `${label}: basis ${on.run.search.objective.basis} / ${off.run.search.objective.basis}`);
  check(bOn.value + BALANCE_OBJECTIVE.margin >= bOff.value - BALANCE_OBJECTIVE.redThreatWeight * Math.max(0, chosenOff.summary.threatsRed - chosenOn.summary.threatsRed) - 1e-9,
    `${label}: the balanced pick (${bOn.value.toFixed(1)}, ${balanceText(chosenOn.summary)}) is less balanced than the old pick (${bOff.value.toFixed(1)}, ${balanceText(chosenOff.summary)})`);
  // 5. The climb: each step beats the one before; kept members stay.
  const steps = on.run.compared.filter((t) => t.label === "swap");
  const anchorOn = on.run.compared.find((t) => t.anchor);
  check(!anchorOn || on.run.compared.find((t) => t.chosen) === anchorOn || beats(chosenOn.summary, anchorOn.summary, 0), `${label}: the result is worse than the anchor by the objective`);
  for (const [i, step] of steps.entries()) {
    check(step.swaps?.length === i + 1, `${label}: climb step ${i + 1} records ${step.swaps?.length} swaps`);
    if (i) check(beats(step.summary, steps[i - 1].summary, BALANCE_OBJECTIVE.margin - 1e-9), `${label}: climb step ${i + 1} (T ${step.summary.T}) does not beat step ${i} (T ${steps[i - 1].summary.T}) by the margin`);
    else if (anchorOn) check(beats(step.summary, anchorOn.summary, 0), `${label}: the first climb step is worse than the anchor`);
    for (const swap of step.swaps || []) check(!STARTS[start][swap.slot], `${label}: the climb swapped kept slot ${swap.slot}`);
  }
  if (steps.length) {
    const lines = on.run.log.filter((l) => /^Swapped .* to balance the team: /.test(l));
    check(chosenOn.label !== "swap" || lines.length === chosenOn.swaps.length, `${label}: ${lines.length} climb lines in the log for ${chosenOn.swaps?.length} swaps`);
  }
  check(chosenOn.label !== "swap" || on.run.search.climb?.accepted === chosenOn.swaps.length, `${label}: search.climb (${JSON.stringify(on.run.search.climb)}) does not account for the chosen team's ${chosenOn.swaps?.length} swaps`);
  check(!off.run.search.climb && !off.run.compared.some((t) => (t.swaps?.length || 0) > 1), `${label}: the rule is off but a climb ran`);
  finishedRules(`${label} (balance)`, on.run, evaluation, start);
  // Times are not compared here: the first build of a start warms the caches for the second.
  // run-autobuild-search.mjs times cold builds in fresh processes.
  console.log(`${label}: balance ${bOff.value.toFixed(1)} -> ${bOn.value.toFixed(1)}, weakest ${bOff.weakest.toFixed(0)} -> ${bOn.weakest.toFixed(0)} (${balanceText(chosenOff.summary)} -> ${balanceText(chosenOn.summary)}), red threats ${chosenOff.summary.threatsRed} -> ${chosenOn.summary.threatsRed}${on.run.search.climb ? `; climb ${on.run.search.climb.seconds} s (${on.run.search.climb.tried} tried, ${on.run.search.climb.judged} finished, ${on.run.search.climb.accepted} kept)` : ""}`);
  console.log(`    ${teamText(off.run.entries)}\n -> ${teamText(on.run.entries)}`);

  // 6. No table: the old search exactly.
  if (start === "partial" || quick) {
    const none = await build(plainEvaluation, start);
    const keys = (r) => (r.run.compared || []).map((t) => `${t.label}:${t.key}${t.chosen ? "*" : ""}`).join(" ");
    check(teamText(none.run.entries) === teamText(off.run.entries) && keys(none) === keys(off), `${label}: no table and autobuildBalance 0 must be the same old search\n    ${keys(none)}\n    ${keys(off)}`);
    check(none.run.search.objective.basis === "score" && !none.run.search.climb, `${label}: no table must keep the raw-score objective`);
  }
}
if (pairs.length > 1) {
  const mean = (f) => pairs.reduce((a, p) => a + f(p), 0) / pairs.length;
  const gain = mean((p) => p.on.value - p.off.value);
  const weakest = mean((p) => p.on.weakest - p.off.weakest);
  console.log(`\nbalance: ${mean((p) => p.off.value).toFixed(1)} -> ${mean((p) => p.on.value).toFixed(1)} on average (+${gain.toFixed(1)}), weakest standing ${mean((p) => p.off.weakest).toFixed(1)} -> ${mean((p) => p.on.weakest).toFixed(1)}`);
  check(gain > 0, `the rule made the picks LESS balanced on average (${gain.toFixed(1)})`);
  check(weakest > 0, `the rule made the picks' weakest standing LOWER on average (${weakest.toFixed(1)})`);
}

// 6. Singles: no table, so the raw-score objective and no climb.
if (!quick) {
  const singles = makeEvaluation("Singles");
  const { run } = await build(singles, "single", { depth: "medium" });
  check(!run.error && run.search.objective.basis === "score" && !run.search.climb, `Singles: basis ${run.search?.objective?.basis}, climb ${JSON.stringify(run.search?.climb)}${run.error ? `, error ${run.error}` : ""}`);
}

// 7. Determinism and Stop.
if (!quick) {
  const one = await build(evaluation, "single", { depth: "medium" });
  const two = await build(evaluation, "single", { depth: "medium" });
  const keys = (r) => (r.run.compared || []).map((t) => `${t.label}:${t.key}${t.chosen ? "*" : ""}`).join(" ");
  if (one.run.search.capped || two.run.search.capped) console.log("note: the safety cap cut a determinism run");
  else check(teamText(one.run.entries) === teamText(two.run.entries) && keys(one) === keys(two), `determinism medium single:\n    ${keys(one)}\n    ${keys(two)}`);
  // A Stop while the climb runs, triggered by the climb's own progress line. A clock-based Stop
  // is vacuous here: a warm build can finish before it fires, and then nothing was tested.
  let climbing = 0;
  let stopAt = 0;
  const t0 = performance.now();
  const run = await new TeamAutoBuild(evaluation).run(teamOf("empty"), {
    search: "deep", depth: "deep",
    onProgress: (fraction, message) => { if (/^Balancing the team/.test(String(message))) climbing ||= performance.now(); },
    shouldStop: () => {
      if (!climbing || performance.now() - climbing < 300) return false;
      stopAt ||= performance.now();
      return true;
    },
  });
  const afterStop = stopAt ? (performance.now() - stopAt) / 1000 : null;
  check(climbing > 0 && stopAt > 0, "the Stop test never reached the climb, so it tested nothing");
  check(!run.error && run.entries.filter((e) => e?.pokemon).length === 6 && afterStop !== null && afterStop <= 1.5,
    `a Stop during the climb answered after ${afterStop?.toFixed(2)} s with ${run.entries.filter((e) => e?.pokemon).length} members${run.error ? `: ${run.error}` : ""}`);
  check(run.search.stoppedEarly && run.log.some((l) => /stopped; this is the best team/.test(l)), "a Stop during the climb must say so in the log");
  console.log(`warm deep empty: the climb began at ${((climbing - t0) / 1000).toFixed(1)} s, Stop answered ${afterStop?.toFixed(2)} s after it`);
}

for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(`\n${checked} checked, ${failures.length} failed.`);
process.exit(failures.length ? 1 : 0);
