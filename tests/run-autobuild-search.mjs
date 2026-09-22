// Checks builder/autobuild-search.js, the Auto Build search the page runs (the greedy
// path as the anchor, the beam over partial teams, the Team Evaluation comparison and
// the one-swap repair), on the site's own meta data:
//
//   1. the result is never worse than the anchor by the search's own objective, the log
//      names the tier that decided, and with Prioritize Meta the result never adds more
//      Pokémon from outside the Top X than the anchor unless a check or the archetype
//      decided (plus unit checks of beats()/beatReason() and topMetaKeys above Top 100)
//   2. members the user kept keep their species; the repair only swaps added members
//   3. Item Clause, at most two Mega Stones, at most two attacking types without a
//      switch-in (unless the log records the last-slot fallback)
//   4. the same input gives the same team, also with the clock running 1.5x slower (the
//      counts bound the search; only the safety cap may cut it, and a capped run says so)
//   5. cold timings: Deep on an empty team within ~50 s, Medium within ~25 s, and the
//      safety cap does not cut a cold build in Node
//   6. Stop returns a complete team within about a second
//   7. Suggestions say "capped at 100" only of a score of 100 (suggest-view.js cappedAt100)
//
// It prints how often and by how much the search beats the anchor, and how the choice
// would change under other objective weights. With TOUR=N every compared team also
// plays the first N tournament teams (builder/tournament-test.js), a yardstick the
// objective does not see, to judge those weights.
//
//   node tests/run-autobuild-search.mjs            quick matrix (about 6-8 minutes)
//   node tests/run-autobuild-search.mjs full       every start x archetype x meta x depth
//   TOUR=150 node tests/run-autobuild-search.mjs   plus the tournament yardstick

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, compact } from "../builder/engine.js";
import { TeamEvaluator, DEFAULT_SETTINGS, normalizeSettings } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TeamAutoBuild } from "../builder/team-autobuild.js";
import { SEARCH_OBJECTIVE, beatReason, beats } from "../builder/autobuild-search.js";
import { topMetaKeys } from "../builder/autobuild-archetype.js";
import { cappedAt100 } from "../builder/suggest-view.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const metaFor = (format) => JSON.parse(readFileSync(join(root, "data", "builder", `meta-${format.toLowerCase()}.json`), "utf8"));
const knownPayload = JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8"));

const set = (species, item, ability, nature, moves, bonuses, form = species) => ({ species, form, item, ability, nature, moves, bonuses });
const STARTS = {
  partial: [
    set("Garchomp", "Garchompite Z", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]),
    set("Rillaboom", "Assault Vest", "Grassy Surge", "Adamant", ["Fake Out", "Grassy Glide", "Wood Hammer", "U-turn"], [32, 32, 0, 0, 2, 0]),
    set("Sylveon", "Throat Spray", "Pixilate", "Modest", ["Hyper Voice", "Moonblast", "Quick Attack", "Protect"], [32, 0, 0, 32, 2, 0]),
  ],
  single: [set("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"], [32, 0, 14, 0, 20, 0])],
  empty: [],
  mixed: [
    set("Froslass", "Froslassite", "Snow Warning", "Timid", ["Blizzard", "Shadow Ball", "Icy Wind", "Protect"], [2, 0, 0, 32, 0, 32], "Mega Froslass"),
    set("Sneasler", "White Herb", "Unburden", "Adamant", ["Close Combat", "Dire Claw", "Fake Out", "Protect"], [2, 32, 0, 0, 0, 32]),
    set("Salamence", "Salamencite", "Aerilate", "Timid", ["Hyper Voice", "Tailwind", "Draco Meteor", "Protect"], [2, 0, 0, 32, 0, 32], "Mega Salamence"),
  ],
  sun: [
    set("Charizard", "Charizardite Y", "Drought", "Modest", ["Heat Wave", "Solar Beam", "Air Slash", "Protect"], [2, 0, 0, 32, 0, 32], "Mega Charizard Y"),
    set("Venusaur", "Focus Sash", "Chlorophyll", "Modest", ["Leaf Storm", "Sludge Bomb", "Sleep Powder", "Protect"], [2, 0, 0, 32, 0, 32]),
    set("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"], [32, 0, 14, 0, 20, 0]),
  ],
  special: [
    set("Garchomp", "Garchompite Z", "Levitate", "Jolly", ["Draco Meteor", "Earth Power", "Fire Blast", "Protect"], [2, 32, 0, 0, 0, 32], "Mega Garchomp Z"),
    set("Rillaboom", "Assault Vest", "Grassy Surge", "Adamant", ["Fake Out", "Grassy Glide", "Wood Hammer", "U-turn"], [32, 32, 0, 0, 2, 0]),
    set("Sylveon", "Throat Spray", "Pixilate", "Modest", ["Hyper Voice", "Moonblast", "Quick Attack", "Protect"], [32, 0, 2, 32, 0, 0]),
  ],
};
const teamOf = (name) => Array.from({ length: 6 }, (_, i) => STARTS[name][i] || null);

function makeEvaluation(format = "Doubles") {
  const engine = new DamageEngine(appData);
  const evaluator = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }));
  evaluator.setMetaRecords(metaFor(format).pokemon);
  const evaluation = new TeamEvaluation(evaluator);
  evaluation.knownTeams = new KnownTeams(knownPayload);
  return evaluation;
}

/** One build; `clock` runs the search's clock that many times faster (a device that much slower). */
async function build(evaluation, start, { depth = "deep", archetype = "automatic", prioritizeMeta = false, stopAfterMs = 0, clock = 1 } = {}) {
  const realNow = performance.now.bind(performance);
  if (clock !== 1) {
    const base = realNow();
    performance.now = () => base + (realNow() - base) * clock;
  }
  try {
    const t0 = realNow();
    let stopAt = 0;
    const shouldStop = stopAfterMs ? () => {
      if (realNow() - t0 < stopAfterMs) return false;
      stopAt ||= realNow();
      return true;
    } : null;
    const run = await new TeamAutoBuild(evaluation).run(teamOf(start), { search: depth, depth, archetype, prioritizeMeta, shouldStop });
    const end = realNow();
    return { run, seconds: (end - t0) / 1000, afterStop: stopAt ? (end - stopAt) / 1000 : null };
  } finally {
    if (clock !== 1) performance.now = realNow;
  }
}

const teamText = (entries) => (entries || []).filter((e) => e?.pokemon).map((e) => `${e.form || e.pokemon} @ ${e.item || "-"}`).join(", ");

// --- a cold child: one build in a fresh process, for the timings -------------------
if (process.argv[2] === "--child") {
  const [, , , start, depth, stopAfter] = process.argv;
  const { run, seconds, afterStop } = await build(makeEvaluation(), start, { depth, stopAfterMs: Number(stopAfter) || 0 });
  console.log(JSON.stringify({ seconds, afterStop, error: run.error || "", complete: (run.entries || []).filter((e) => e?.pokemon).length, search: run.search }));
  process.exit(0);
}

const full = process.argv[2] === "full";
const tourLimit = Number(process.env.TOUR || 0);
const failures = [];
const notes = [];
let checked = 0;
const check = (ok, message) => {
  checked += 1;
  if (!ok) failures.push(message);
};

// 1 + 7, unit checks: the objective's order, the tier names, Prioritize Meta above Top 100
// and the "capped at 100" wording.
{
  const team = (over) => ({ checksRed: 0, checksYellow: 0, archetypeUnmet: 0, metaOutside: 0, T: 60, ...over });
  // Red first: 0 red / 1 yellow beats 1 red / 0 yellow, even when it scores lower.
  check(beats(team({ checksYellow: 1, T: 60.2 }), team({ checksRed: 1, T: 60.3 })), "beats(): fewer red checks must win over a higher score");
  check(beatReason(team({ checksYellow: 1 }), team({ checksRed: 1 })) === "checksRed", "beatReason(): red checks decide first");
  check(!beats(team({ checksYellow: 2, T: 80 }), team({ checksYellow: 1 })), "beats(): more yellow checks must lose at equal red");
  check(!beats(team({ archetypeUnmet: 1, T: 80 }), team({})), "beats(): an unmet critical archetype requirement must lose at equal checks");
  // Prioritize Meta: a team with a member from outside the Top X loses at equal checks,
  // whatever it scores; the score counts only when every tier ties.
  check(!beats(team({ metaOutside: 1, T: 70 }), team({ T: 58 })), "beats(): an added member outside the Top X must lose at equal checks");
  check(beats(team({ checksRed: 0, metaOutside: 1 }), team({ checksRed: 1 })), "beats(): the checks come before Prioritize Meta");
  check(beatReason(team({ metaOutside: 0 }), team({ metaOutside: 1 })) === "metaOutside", "beatReason(): metaOutside");
  check(!beats(team({ T: 60.9 }), team({})) && beats(team({ T: 61 }), team({})), "beats(): the score needs the margin of 1 point");
  // topMetaKeys: the Top X up to the ranked list's length (the app capped it at 100).
  const meta = metaFor("Doubles").pokemon;
  for (const top of [150, meta.length, meta.length + 50]) {
    const ev = new TeamEvaluator(null, new DamageEngine(appData), "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: top }, 1000));
    ev.setMetaRecords(meta);
    const keys = topMetaKeys(ev);
    const ranked = ev.topMeta(Math.min(top, meta.length));
    const missing = ranked.filter((m) => ![m.name, m.base_name, m._v124_base_species].some((v) => v && keys.has(compact(v))));
    check(ranked.length === Math.min(top, meta.length) && !missing.length, `topMetaKeys at Top ${top}: ${missing.length} of ${ranked.length} not prioritised (${missing.slice(0, 3).map((m) => m.name).join(", ")})`);
  }
  // "capped at 100" only of a score of 100 whose layers added up to more.
  check(!cappedAt100({ score: 89.8, score_uncapped: 94 }), "cappedAt100(): 89.8 with 94.0 raw is not capped");
  check(cappedAt100({ score: 100, score_uncapped: 104.2 }), "cappedAt100(): 100 with 104.2 raw is capped");
  check(!cappedAt100({ score: 100, score_uncapped: 100 }), "cappedAt100(): exactly 100 is not capped");
}

/** The words the log's "Compared N complete teams" sentence uses for each tier (replacedBecause). */
const TIER_WORDS = { checksRed: "fewer red", checksYellow: "fewer yellow", archetypeUnmet: "misses fewer critical", metaOutside: "outside the Top", T: "points more" };

// 5 + 6 cold: in fresh processes.
function child(start, depth, stopAfter = 0) {
  const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", start, depth, String(stopAfter)], { encoding: "utf8", maxBuffer: 1 << 24 });
  const line = (out.stdout || "").trim().split("\n").filter(Boolean).pop() || "{}";
  try {
    return JSON.parse(line);
  } catch {
    return { error: `child failed: ${(out.stderr || "").slice(0, 400)}` };
  }
}
if (!process.env.SKIP_COLD) {
  // The counts bound the work; in Node the safety cap (capMs) must not cut a cold build.
  for (const [start, depth, limit] of [["empty", "deep", 50], ["partial", "deep", 45], ["partial", "medium", 26], ["empty", "fast", 16]]) {
    const r = child(start, depth);
    console.log(`cold ${depth} ${start}: ${r.seconds?.toFixed(1)} s, ${r.search?.teams} teams compared${r.search?.cut?.length ? `, capped: ${r.search.cut.join("/")}` : ""}${r.error ? ` ERROR ${r.error}` : ""}`);
    check(!r.error && r.seconds <= limit, `cold ${depth} ${start} took ${r.seconds?.toFixed(1)} s (limit ${limit} s)${r.error ? `: ${r.error}` : ""}`);
    check(!r.search?.capped, `cold ${depth} ${start}: the safety cap cut ${r.search?.cut?.join("/")}`);
  }
  const stopped = child("empty", "deep", 4000);
  console.log(`cold deep empty stopped at 4 s: answered ${stopped.afterStop?.toFixed(2)} s after Stop, ${stopped.complete}/6 members`);
  check(!stopped.error && stopped.complete === 6 && stopped.afterStop <= 1.5, `a cold Stop answered after ${stopped.afterStop?.toFixed(2)} s with ${stopped.complete} members${stopped.error ? `: ${stopped.error}` : ""}`);
}

// The matrix, warm (one evaluator, as the worker keeps one per format and settings).
const evaluations = new Map();
const evaluationFor = (format = "Doubles") => {
  if (!evaluations.has(format)) evaluations.set(format, makeEvaluation(format));
  return evaluations.get(format);
};
const evaluation = evaluationFor("Doubles");
const cases = [];
if (full) {
  for (const start of Object.keys(STARTS)) {
    for (const archetype of ["automatic", "trick room", "rain", "tailwind"]) {
      for (const prioritizeMeta of [false, true]) for (const depth of ["fast", "medium", "deep"]) cases.push({ start, archetype, prioritizeMeta, depth });
    }
  }
} else {
  for (const start of Object.keys(STARTS)) cases.push({ start, archetype: "automatic", prioritizeMeta: false, depth: "deep" });
  for (const archetype of ["trick room", "rain", "tailwind"]) cases.push({ start: "partial", archetype, prioritizeMeta: false, depth: "deep" });
  cases.push({ start: "partial", archetype: "automatic", prioritizeMeta: true, depth: "deep" });
  cases.push({ start: "empty", archetype: "tailwind", prioritizeMeta: true, depth: "medium" });
  cases.push({ start: "empty", archetype: "automatic", prioritizeMeta: false, depth: "deep", format: "Singles" });
  cases.push({ start: "single", archetype: "automatic", prioritizeMeta: false, depth: "medium", format: "Singles" });
  for (const depth of ["fast", "medium"]) for (const start of ["partial", "empty"]) cases.push({ start, archetype: "automatic", prioritizeMeta: false, depth });
}

const records = [];
let tournament = null;
async function tourAverage(sets) {
  if (!tourLimit) return null;
  const { TournamentTest } = await import("../builder/tournament-test.js");
  const { TeamSuggestions } = await import("../builder/team-suggest.js");
  tournament ||= new TournamentTest(evaluation, evaluation.knownTeams, new TeamSuggestions(evaluation));
  const out = await tournament.run(sets, { limit: tourLimit });
  return Number(out.average ?? out.value ?? NaN);
}

for (const c of cases) {
  const label = `${c.format === "Singles" ? "Singles " : ""}${c.depth} ${c.start} ${c.archetype}${c.prioritizeMeta ? " +meta" : ""}`;
  const { run, seconds } = await build(evaluationFor(c.format), c.start, c);
  if (run.error) {
    notes.push(`${label}: no team (${run.error})`);
    console.log(`${label}: ERROR ${run.error}`);
    continue;
  }
  const chosen = (run.compared || []).find((t) => t.chosen);
  const anchor = (run.compared || []).find((t) => t.anchor);
  // 1. never worse than the anchor; the log names the tier that decided
  if (anchor && chosen) check(chosen === anchor || beats(chosen.summary, anchor.summary, 0), `${label}: the result is worse than the anchor by the objective`);
  if (anchor && chosen && chosen !== anchor) {
    const reason = beatReason(chosen.summary, anchor.summary);
    const line = run.log.find((l) => /^Compared \d+ complete teams/.test(l)) || "";
    check(line.includes(TIER_WORDS[reason] || "?"), `${label}: decided by ${reason}, but the log says "${line}"`);
    // Prioritize Meta: more members from outside the Top X only when a check or the archetype decided.
    if (c.prioritizeMeta) check(chosen.summary.metaOutside <= anchor.summary.metaOutside || ["checksRed", "checksYellow", "archetypeUnmet"].includes(reason), `${label}: Prioritize Meta overridden (${anchor.summary.metaOutside} -> ${chosen.summary.metaOutside} outside the Top X, decided by ${reason})`);
  }
  if (c.prioritizeMeta) check(Number(run.search?.objective?.metaTop) > 0, `${label}: Prioritize Meta is on but the objective has no Top X tier`);
  // 2. kept members
  const start = teamOf(c.start);
  start.forEach((s, i) => {
    if (!s) return;
    check(compact(run.entries[i]?.pokemon) === compact(s.species), `${label}: kept slot ${i} ${s.species} became ${run.entries[i]?.pokemon}`);
  });
  if (chosen?.swap) check(!start[chosen.swap.slot], `${label}: the repair swapped a kept member (slot ${chosen.swap.slot})`);
  // 3. the finished-team rules
  const items = run.entries.filter((e) => e?.pokemon && e.item).map((e) => compact(e.item));
  check(items.length === new Set(items).size, `${label}: Item Clause broken (${items.join(", ")})`);
  const stones = run.entries.filter((e) => e?.pokemon && e.item && evaluation.ev.engine.isMegaStone(e.item)).length;
  check(stones <= 2, `${label}: ${stones} Mega Stones`);
  const builder = new TeamAutoBuild(evaluationFor(c.format));
  const warnings = builder.defensiveWarnings(builder.slotsFor(run.entries, run.spreads));
  check(warnings <= 2 || run.log.some((line) => /^No Pokémon for the last slot/.test(line)), `${label}: ${warnings} defensive switch-in warnings without the recorded fallback`);
  check((run.entries || []).filter((e) => e?.pokemon).length === 6, `${label}: the team is not complete`);
  const rec = { label, seconds, search: run.search, compared: run.compared.map((t) => ({ label: t.label, chosen: t.chosen, anchor: t.anchor, summary: t.summary, sets: t.sets, team: teamText(t.sets.map((s) => s && { pokemon: s.species, form: s.form, item: s.item })) })) };
  if (tourLimit && c.format !== "Singles") for (const t of rec.compared) t.tour = await tourAverage(t.sets);
  records.push(rec);
  const s = chosen?.summary;
  const a = anchor?.summary;
  console.log(`${label}: ${seconds.toFixed(1)} s, ${run.search.teams} teams${run.search.cut?.length ? ` (cut: ${run.search.cut.join("/")})` : ""}; ${chosen?.label || "?"}${chosen && a && chosen !== anchor ? ` beats the anchor: checks ${a.checksRed}R/${a.checksYellow}Y -> ${s.checksRed}R/${s.checksYellow}Y, mean ${a.mean} -> ${s.mean}, threats 70+ ${a.threatsRed} -> ${s.threatsRed}, T ${a.T} -> ${s.T}` : ""}`);
}

// 4. the same input twice (warm), the second time on a clock running 1.5x faster (a device
// that much slower): the counts bound the search, so the same teams are compared and the
// same one is kept. Only the safety cap may cut a run, and then search.capped says so.
for (const c of [
  { start: "partial", archetype: "automatic", prioritizeMeta: false, depth: "medium" },
  { start: "empty", archetype: "automatic", prioritizeMeta: false, depth: "deep" },
]) {
  const one = await build(evaluation, c.start, c);
  const two = await build(evaluation, c.start, { ...c, clock: 1.5 });
  const keys = (r) => (r.run.compared || []).map((t) => `${t.label}:${t.key}${t.chosen ? "*" : ""}`).join(" ");
  const capped = [one, two].filter((r) => r.run.search?.capped);
  check(capped.every((r) => r.run.search.cut.length > 0), `determinism ${c.depth} ${c.start}: capped without naming the step`);
  if (capped.length) notes.push(`determinism ${c.depth} ${c.start}: the safety cap cut ${capped.map((r) => r.run.search.cut.join("/")).join(" and ")}, so the runs may differ`);
  else {
    check(teamText(one.run.entries) === teamText(two.run.entries), `determinism ${c.depth} ${c.start} (clock x1.5) gave\n    ${teamText(one.run.entries)}\n    ${teamText(two.run.entries)}`);
    check(keys(one) === keys(two), `determinism ${c.depth} ${c.start} (clock x1.5) compared other teams:\n    ${keys(one)}\n    ${keys(two)}`);
  }
  console.log(`determinism ${c.depth} ${c.start}: ${one.seconds.toFixed(1)} s and ${two.seconds.toFixed(1)} s (clock x1.5), ${one.run.search?.teams} teams each, ${capped.length ? "capped" : "same result"}`);
}

// 6. Stop, warm: while the beam or the comparison runs.
{
  const { run, afterStop } = await build(evaluation, "empty", { depth: "deep", stopAfterMs: 1500 });
  console.log(`warm deep empty stopped at 1.5 s: answered ${afterStop?.toFixed(2)} s after Stop; ${run.search?.teams} teams`);
  check(!run.error && run.entries.filter((e) => e?.pokemon).length === 6 && afterStop <= 1.5, `a warm Stop answered after ${afterStop?.toFixed(2)} s${run.error ? `: ${run.error}` : ""}`);
}

// --- the report --------------------------------------------------------------------
const withAnchor = records.filter((r) => r.compared.some((t) => t.anchor) && r.compared.length > 1);
const differ = withAnchor.filter((r) => !r.compared.find((t) => t.chosen)?.anchor);
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
console.log(`\n${records.length} builds; ${withAnchor.length} compared more than one team; the search kept another team than the anchor in ${differ.length}.`);
if (differ.length) {
  const d = (k) => mean(differ.map((r) => (r.compared.find((t) => t.chosen).summary[k] ?? 0) - (r.compared.find((t) => t.anchor).summary[k] ?? 0)));
  console.log(`  average change where it did: checks red ${d("checksRed").toFixed(2)}, yellow ${d("checksYellow").toFixed(2)}, mean score ${d("mean").toFixed(2)}, threats 70+ ${d("threatsRed").toFixed(2)}, T ${d("T").toFixed(2)}`);
}

// Other weights on the same compared teams: how the pick would change.
function pick(teams, weight, margin) {
  const T = (t) => t.summary.mean - weight * t.summary.threatsRed;
  const withT = teams.map((t) => ({ ...t, summary: { ...t.summary, T: T(t) } }));
  let leader = withT.find((t) => t.anchor) || withT[0];
  for (const t of withT) {
    if (t === leader || t.label === "swap") continue;
    if (beats(t.summary, leader.summary, leader.anchor ? margin : 0.001)) leader = t;
  }
  return leader;
}
console.log("\nweights (red-threat weight / margin): builds that leave the anchor, and their average change");
for (const weight of [0, 0.5, 1, 1.5, 2]) {
  for (const margin of [0.5, 1, 2]) {
    const moved = withAnchor.map((r) => [r, pick(r.compared, weight, margin)]).filter(([, p]) => !p.anchor);
    const change = (k) => mean(moved.map(([r, p]) => p.summary[k] - r.compared.find((t) => t.anchor).summary[k]));
    const tour = tourLimit ? ` · tournament ${mean(moved.map(([r, p]) => (p.tour ?? 0) - (r.compared.find((t) => t.anchor).tour ?? 0))).toFixed(2)}` : "";
    console.log(`  ${weight.toFixed(1)} / ${margin.toFixed(1)}${weight === SEARCH_OBJECTIVE.redThreatWeight && margin === SEARCH_OBJECTIVE.margin ? " (current)" : ""}: ${moved.length}/${withAnchor.length} · mean ${change("mean").toFixed(2)} · threats 70+ ${change("threatsRed").toFixed(2)} · checks ${(change("checksRed") + change("checksYellow")).toFixed(2)}${tour}`);
  }
}
if (tourLimit) {
  // How often the objective ranks two compared teams in the same order as the tournament.
  let agree = 0;
  let pairs = 0;
  for (const r of records) {
    const teams = r.compared.filter((t) => Number.isFinite(t.tour));
    for (let i = 0; i < teams.length; i += 1) {
      for (let j = i + 1; j < teams.length; j += 1) {
        if (Math.abs(teams[i].tour - teams[j].tour) < 0.5) continue;
        pairs += 1;
        const objective = beats(teams[i].summary, teams[j].summary, 0) ? i : j;
        const tourBetter = teams[i].tour > teams[j].tour ? i : j;
        if (objective === tourBetter) agree += 1;
      }
    }
  }
  console.log(`\ntournament yardstick: the objective orders ${agree}/${pairs} team pairs the way the tournament average does.`);
}

for (const note of notes) console.log(`note: ${note}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(`\n${checked} checked, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
