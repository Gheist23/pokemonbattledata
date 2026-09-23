// Guaranteed moves (builder/guaranteed-moves.js) end to end, on the site's own meta data:
// a move that at least 95% of a Pokémon's teams run is on every set Auto Build and
// Suggested Pokémon put forward for it.
//
// Auto Build - the app's greedy path (Fast and Medium) and the search the page runs - in
// Doubles and Singles, over start teams x archetypes:
//   1. no finished member lacks a guaranteed move (judged on the finished team); a member
//      of the user's that no step changed stays as written and is not counted
//   2. no finished member carries a weather / terrain move its team cannot turn on, unless
//      the user wrote it on that member, and none is left with an empty move slot
//   3. every pick carries its guaranteed moves on the start team (the field gate its
//      candidates were screened with)
//   4. the run does not crash (a build error is listed, not counted: the rule does not
//      change which slots can be filled)
// Suggested Pokémon on several teams, in both formats:
//   5. every shown row's set, and the set "Use" would add (Item Clause applied as the page
//      applies it), carries its guaranteed moves
// And once, without building anything:
//   6. the sentences the rule writes read word for word the ones the app writes
//      (`guaranteed_moves.describe`), the share to one decimal
//
//   node tests/run-guaranteed-moves.mjs          the default matrix (about 1-3 minutes)
//   node tests/run-guaranteed-moves.mjs --full   every start x archetype x path, both formats
//   WORKERS=n                                    parallel workers (default: cores - 1, at most 8)
//   GUARANTEED_MOVE_SHARE=0                      build with the rule off, check as if it were on
//                                                (what the rule is worth; expected to fail)
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const S = (species, item, ability, nature, moves, bonuses, form = species) => ({ species, form, item, ability, nature, moves, bonuses });
const STARTS = {
  empty: [],
  partial: [
    S("Garchomp", "Garchompite Z", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]),
    S("Rillaboom", "Assault Vest", "Grassy Surge", "Adamant", ["Fake Out", "Grassy Glide", "Wood Hammer", "U-turn"], [32, 32, 0, 0, 2, 0]),
    S("Sylveon", "Throat Spray", "Pixilate", "Modest", ["Hyper Voice", "Moonblast", "Quick Attack", "Protect"], [32, 0, 0, 32, 2, 0]),
  ],
  incineroar: [S("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Fake Out", "Parting Shot", "Flare Blitz", "Knock Off"], [32, 0, 2, 0, 32, 0])],
  sneasler: [S("Sneasler", "White Herb", "Unburden", "Jolly", ["Close Combat", "Dire Claw", "Fake Out", "Protect"], [2, 32, 0, 0, 0, 32])],
  farigiraf: [S("Farigiraf", "Sitrus Berry", "Armor Tail", "Quiet", ["Trick Room", "Psychic", "Hyper Voice", "Protect"], [32, 0, 2, 32, 0, 0])],
  whimsi_gambit: [
    S("Whimsicott", "Focus Sash", "Prankster", "Timid", ["Tailwind", "Moonblast", "Encore", "Protect"], [2, 0, 0, 32, 0, 32]),
    S("Kingambit", "Black Glasses", "Defiant", "Adamant", ["Kowtow Cleave", "Sucker Punch", "Iron Head", "Protect"], [32, 32, 0, 0, 2, 0]),
  ],
  rain_core: [
    S("Pelipper", "Focus Sash", "Drizzle", "Modest", ["Hurricane", "Weather Ball", "Tailwind", "Wide Guard"], [2, 0, 0, 32, 0, 32]),
    S("Archaludon", "Assault Vest", "Stamina", "Modest", ["Electro Shot", "Draco Meteor", "Flash Cannon", "Body Press"], [32, 0, 0, 32, 2, 0]),
  ],
  gholdengo: [S("Gholdengo", "Choice Specs", "Good as Gold", "Modest", ["Make It Rain", "Shadow Ball", "Nasty Plot", "Protect"], [2, 0, 0, 32, 0, 32])],
  // a Mega Froslass the user wrote: its Blizzard is guaranteed only while it holds its stone
  froslass: [S("Froslass", "Froslassite", "Snow Warning", "Timid", ["Blizzard", "Shadow Ball", "Icy Wind", "Protect"], [2, 0, 0, 32, 0, 32], "Mega Froslass")],
};
const full6 = [
  S("Charizard", "Charizardite Y", "Drought", "Timid", ["Heat Wave", "Solar Beam", "Air Slash", "Protect"], [2, 0, 0, 32, 0, 32], "Mega Charizard Y"),
  S("Venusaur", "Focus Sash", "Chlorophyll", "Modest", ["Leaf Storm", "Sludge Bomb", "Sleep Powder", "Protect"], [2, 0, 0, 32, 0, 32]),
  S("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"], [32, 2, 0, 0, 32, 0]),
  S("Garchomp", "Life Orb", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]),
  S("Whimsicott", "Focus Sash", "Prankster", "Timid", ["Tailwind", "Moonblast", "Encore", "Protect"], [2, 0, 0, 32, 0, 32]),
  S("Gholdengo", "Choice Specs", "Good as Gold", "Modest", ["Make It Rain", "Shadow Ball", "Focus Blast", "Thunderbolt"], [2, 0, 0, 32, 0, 32]),
];
const SUGGEST_TEAMS = {
  empty: [],
  partial: STARTS.partial,
  incineroar: STARTS.incineroar,
  sun3: full6.slice(0, 3),
  full6,
  trickroom: [STARTS.farigiraf[0], S("Torkoal", "Charcoal", "Drought", "Quiet", ["Eruption", "Heat Wave", "Solar Beam", "Protect"], [32, 0, 0, 32, 2, 0])],
  rain: [STARTS.rain_core[0]],
  psychic: [S("Indeedee-F", "Psychic Seed", "Psychic Surge", "Bold", ["Follow Me", "Helping Hand", "Psychic", "Protect"], [32, 0, 32, 0, 2, 0])],
};

// --- the matrix ------------------------------------------------------------------------------

function jobs(full) {
  const ALL = ["automatic", "balanced", "offense", "bulky offense", "hyper offense", "goodstuff", "trick room", "tailwind", "rain", "sun", "sand", "snow", "screens", "setup", "terrain", "perish trap", "stall", "semi-stall"];
  const out = [];
  const add = (format, path, depth, starts, archetypes) => {
    for (const start of starts) for (const archetype of archetypes) out.push({ kind: "autobuild", format, path, depth, start, archetype });
  };
  const starts = Object.keys(STARTS);
  if (full) {
    for (const format of ["Doubles", "Singles"]) {
      add(format, "greedy", "fast", starts, ALL);
      add(format, "greedy", "medium", starts, ALL);
      add(format, "search", "fast", starts, ALL);
      add(format, "search", "medium", starts, ["automatic", "trick room", "rain"]);
    }
  } else {
    // A spread of archetypes: every one the rule interacts with (the anchor-move ones, the
    // weather and terrain ones), plus automatic and one without an anchor.
    add("Doubles", "greedy", "fast", starts, ["automatic", "balanced", "trick room", "tailwind", "rain", "sun", "snow", "screens", "terrain", "perish trap"]);
    add("Doubles", "greedy", "medium", starts, ["automatic", "trick room", "tailwind"]);
    add("Doubles", "search", "fast", starts, ["automatic", "trick room"]);
    const singles = ["empty", "partial", "incineroar", "farigiraf", "rain_core", "froslass"];
    add("Singles", "greedy", "fast", singles, ["automatic", "trick room", "tailwind", "rain"]);
    add("Singles", "search", "fast", singles, ["automatic"]);
  }
  for (const format of ["Doubles", "Singles"]) {
    const teams = format === "Doubles" || full ? Object.keys(SUGGEST_TEAMS) : ["empty", "partial", "trickroom", "rain"];
    for (const team of teams) out.push({ kind: "suggest", format, team });
  }
  // the slow ones first, so the pool ends together
  const cost = (j) => (j.kind === "suggest" ? 3 : 0) + (j.path === "search" ? 4 : 0) + (j.depth === "medium" ? 2 : 0);
  return out.sort((a, b) => cost(b) - cost(a));
}

/**
 * The sentences the rule writes, word for word the ones the app writes
 * (`guaranteed_moves.describe`, pinned there by
 * `test_one_wording_for_every_line_the_rule_writes`), so a player who reads both logs reads
 * the same sentence. The share is one decimal on both sides.
 */
async function wordingFailures() {
  const { describeChanges, formatShare } = await import(new URL("../builder/guaranteed-moves.js", import.meta.url).href);
  const want = [
    "Guaranteed move: Rillaboom keeps Grassy Glide (97.8% usage) in place of High Horsepower.",
    "Guaranteed move: Rillaboom keeps Grassy Glide (97.8% usage) in a free move slot.",
    "Guaranteed move: Farigiraf keeps Trick Room (100.0% usage) in a free move slot.",
  ];
  const got = describeChanges("Rillaboom", [
    { move: "Grassy Glide", share: 97.8, replaced: "High Horsepower" },
    { move: "Grassy Glide", share: 97.8, replaced: "" },
  ]).concat(describeChanges("Farigiraf", [{ move: "Trick Room", share: 100, replaced: "" }]));
  const out = want.flatMap((line, i) => (got[i] === line ? [] : [`wording: "${got[i]}" should read "${line}"`]));
  // `f"{share:.1f}"`: one decimal, whole numbers included.
  if (formatShare(98) !== "98.0" || formatShare(99.96) !== "100.0") {
    out.push(`wording: the share reads ${formatShare(98)} / ${formatShare(99.96)}, not 98.0 / 100.0`);
  }
  return out;
}

// --- one worker -------------------------------------------------------------------------------

async function workerMain() {
  const imp = (p) => import(new URL(`../builder/${p}`, import.meta.url).href);
  const { DamageEngine, compact } = await imp("engine.js");
  const { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } = await imp("team-eval.js");
  const { TeamEvaluation } = await imp("team-payload.js");
  const { TeamAutoBuild } = await imp("team-autobuild.js");
  const { TeamSuggestions } = await imp("team-suggest.js");
  const { KnownTeams } = await imp("known-teams.js");
  const { makeSet } = await imp("common.js");
  const { GUARANTEED_MOVE_SHARE, effectiveAbility, lockedMoves, missingLocked } = await imp("guaranteed-moves.js");
  // The share the engines build with: production's by default. GUARANTEED_MOVE_SHARE=0 builds
  // with the rule off, to show what it is worth (the checks below always ask for 95).
  const built = process.env.GUARANTEED_MOVE_SHARE === undefined ? undefined : Number(process.env.GUARANTEED_MOVE_SHARE);
  const options = built === undefined ? {} : { guaranteedMoveShare: built };
  const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));
  const appData = read("data", "builder", "app-data.json");
  const known = read("data", "builder", "known-teams.json");
  // One evaluation per format and worker, as the page's worker keeps one (its calc caches stay warm).
  const evaluations = {};
  const evaluationFor = (format) => {
    if (evaluations[format]) return evaluations[format];
    const meta = read("data", "builder", `meta-${format.toLowerCase()}.json`);
    const ranked = (meta.pokemon || []).filter((r) => Number(r.position) < 999999).length;
    const ev = new TeamEvaluator(null, new DamageEngine(appData), format, normalizeSettings({ ...DEFAULT_SETTINGS }, ranked));
    ev.setMetaRecords(meta.pokemon || []);
    const evaluation = new TeamEvaluation(ev);
    evaluation.knownTeams = new KnownTeams(known);
    evaluations[format] = evaluation;
    return evaluation;
  };
  const valid = (e) => Boolean(e && String(e.pokemon || "").trim());
  const text = (e) => `${e.form || e.pokemon} @ ${e.item || "-"} ${e.ability || "-"} [${(e.moves || []).join(", ")}]`;
  const lacks = (sg, entry, team) => missingLocked(sg, entry, team, GUARANTEED_MOVE_SHARE).map((l) => `${l.move} ${l.share}%`);
  const lockedFor = (sg, entry, team) => lockedMoves(sg, entry.pokemon, entry, team, GUARANTEED_MOVE_SHARE);

  async function autobuild(job) {
    const out = { failures: [], notes: [], members: 0, locked: 0, forced: 0, keptMode: 0, gateRepairs: 0, picks: 0, anchorShort: 0 };
    const evaluation = evaluationFor(job.format);
    const builder = new TeamAutoBuild(evaluation, options); // production: the rule on at its default share
    const sg = builder.sg;
    const list = STARTS[job.start];
    const sets = Array.from({ length: 6 }, (_, i) => (list[i] ? makeSet(list[i]) : null));
    const startTeam = list.map((s) => builder.entryFromSet(s));
    let run = builder.run(sets, { depth: job.depth, archetype: job.archetype, search: job.path === "search" ? job.depth : undefined, selection: null, box: [] });
    if (run && typeof run.then === "function") run = await run;
    if (run.error) out.notes.push(`build error: ${run.error}`);
    const team = run.entries.filter(valid);
    run.entries.forEach((entry, i) => {
      if (!valid(entry)) return;
      out.members += 1;
      const own = i < list.length ? startTeam[i] : null;
      const same = own && compact(own.pokemon) === compact(entry.pokemon);
      const untouched = same && own.moves.map(compact).join(",") === (entry.moves || []).map(compact).join(",");
      if (lockedFor(sg, entry, team).length) out.locked += 1;
      const missing = lacks(sg, entry, team);
      if (missing.length && !untouched) out.failures.push(`finished ${text(entry)} lacks ${missing.join(", ")}`);
      if (missing.length && untouched) out.notes.push(`the user's ${text(entry)} lacks ${missing.join(", ")} (kept as written)`);
      const have = sg.fieldSupport(team, [effectiveAbility(sg, entry.pokemon, entry.ability, entry.item)].filter(Boolean));
      const written = new Set(same ? own.moves.map(compact) : []);
      const off = (entry.moves || []).filter((m) => sg.moveCondition(m) && !have.has(sg.moveCondition(m)) && !written.has(compact(m)));
      if (off.length) out.failures.push(`finished ${text(entry)} carries ${off.map((m) => `${m} (needs ${sg.moveCondition(m)})`).join(", ")} without its condition`);
      // No step may leave a move slot empty (the gate repair puts a move the team can power in
      // its place) - as far as the Pokémon has moves to fill it: Ditto only learns Transform.
      const filled = (entry.moves || []).filter((m) => String(m || "").trim()).length;
      const room = Math.min(4, builder.learnable(entry.pokemon, entry.form).length || 4);
      if (filled < room && !(untouched && own.moves.length < room)) out.failures.push(`finished ${text(entry)} has only ${filled} move${filled === 1 ? "" : "s"} (it can run ${room})`);
    });
    for (const addition of run.additions || []) {
      out.picks += 1;
      const missing = lacks(sg, addition.entry, startTeam);
      if (missing.length) out.failures.push(`pick ${text(addition.entry)} lacks ${missing.join(", ")} on the start team`);
    }
    for (const line of run.log || []) {
      if (line.startsWith("Guaranteed move:")) out.forced += 1;
      if (/^Speed mode: .* keeps /.test(line)) out.keptMode += 1;
      if (line.startsWith("Field conditions:")) out.gateRepairs += 1;
      // What the rule costs the archetype: a member whose every free slot is guaranteed
      // cannot be taught the archetype's move (counted, not a failure).
      if (/could not reach \d+|Auto Build reached \d+ of \d+/.test(line)) out.anchorShort += 1;
    }
    return out;
  }

  async function suggest(job) {
    const out = { failures: [], notes: [], rows: 0, locked: 0 };
    const evaluation = evaluationFor(job.format);
    const list = SUGGEST_TEAMS[job.team];
    const sets = Array.from({ length: 6 }, (_, i) => (list[i] ? makeSet(list[i]) : null));
    const payload = evaluation.evaluate(sets);
    const sg = new TeamSuggestions(evaluation, options);
    const run = sg.run(payload);
    const teamEntries = sg.teamEntries(payload);
    const selected = sg.checks.selectedIds(null);
    const key = (v) => compact(v);
    for (const row of run.rows) {
      out.rows += 1;
      const page = sg.forPage(row, selected);
      const entry = page.candidate_entry;
      if (lockedFor(sg, entry, teamEntries).length) out.locked += 1;
      const missing = lacks(sg, entry, teamEntries);
      if (missing.length) out.failures.push(`shown "${page.action}" ${text(entry)} lacks ${missing.join(", ")}`);
      // "Use" (builder-page.js useSuggestion): the candidate's set; a clashing item becomes the first free option.
      const slot = page.action_kind === "swap" ? teamEntries.findIndex((e) => sg.speciesId(e.form || e.pokemon) === sg.speciesId(page.swap_target)) : -1;
      const used = new Set(teamEntries.filter((e, i) => i !== slot && e.item).map((e) => key(e.item)));
      let use = { ...entry };
      if (key(use.item) && used.has(key(use.item))) use = { ...use, item: (page.item_options || []).find((o) => key(o) && !used.has(key(o))) || "" };
      const after = teamEntries.filter((_, i) => i !== slot).concat([use]);
      const missingUse = lacks(sg, use, teamEntries).concat(lacks(sg, use, after)).filter((v, i, a) => a.indexOf(v) === i);
      if (missingUse.length) out.failures.push(`"Use ${page.name}" would add ${text(use)}, lacking ${missingUse.join(", ")}`);
    }
    return out;
  }

  parentPort.on("message", async (job) => {
    if (!job) process.exit(0);
    const started = Date.now();
    let result;
    try {
      result = job.kind === "suggest" ? await suggest(job) : await autobuild(job);
    } catch (error) {
      result = { failures: [`crash: ${String(error?.stack || error).split("\n").slice(0, 4).join(" / ")}`], notes: [] };
    }
    parentPort.postMessage({ job, seconds: (Date.now() - started) / 1000, ...result });
  });
  parentPort.postMessage({ ready: true });
}

// --- the pool -----------------------------------------------------------------------------------

async function main() {
  const full = process.argv.includes("--full");
  const queue = jobs(full);
  const size = Math.max(1, Math.min(queue.length, Number(process.env.WORKERS) || Math.min(8, Math.max(1, availableParallelism() - 1))));
  const started = Date.now();
  const wording = await wordingFailures();
  const results = [];
  console.log(`${queue.length} jobs (${full ? "full" : "default"} matrix) on ${size} workers`);
  await new Promise((resolve, reject) => {
    let running = 0;
    const next = (worker) => {
      const job = queue.shift();
      if (!job) {
        worker.postMessage(null);
        if (--running === 0) resolve();
        return;
      }
      worker.postMessage(job);
    };
    for (let i = 0; i < size; i += 1) {
      running += 1;
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { worker: true } });
      worker.on("error", reject);
      worker.on("message", (message) => {
        if (message.ready) return next(worker);
        results.push(message);
        const j = message.job;
        const label = j.kind === "suggest" ? `${j.format} suggest ${j.team}` : `${j.format} ${j.path} ${j.depth} ${j.start} / ${j.archetype}`;
        if (message.failures.length || process.env.VERBOSE) console.log(`${message.failures.length ? "FAIL" : "ok  "} ${label} (${message.seconds.toFixed(1)} s)${message.failures.map((f) => `\n     ${f}`).join("")}`);
        return next(worker);
      });
    }
  });
  const sum = (k, kind) => results.filter((r) => r.job.kind === kind).reduce((s, r) => s + (r[k] || 0), 0);
  const failures = [...wording, ...results.flatMap((r) => r.failures.map((f) => `${r.job.format} ${r.job.kind === "suggest" ? `suggest ${r.job.team}` : `${r.job.path} ${r.job.depth} ${r.job.start}/${r.job.archetype}`}: ${f}`))];
  const notes = [...new Set(results.flatMap((r) => r.notes.map((n) => `${r.job.format} ${r.job.start || r.job.team}${r.job.archetype ? `/${r.job.archetype}` : ""}: ${n}`)))];
  const builds = results.filter((r) => r.job.kind === "autobuild");
  console.log(`\nAuto Build: ${builds.length} runs, ${sum("members", "autobuild")} finished members (${sum("locked", "autobuild")} with a guaranteed move), ${sum("picks", "autobuild")} picks; `
    + `${sum("forced", "autobuild")} moves put back at the end, ${sum("keptMode", "autobuild")} Trick Room / Tailwind kept against the speed mode, ${sum("gateRepairs", "autobuild")} unpowered weather / terrain moves replaced, ${sum("anchorShort", "autobuild")} runs short of their archetype's move.`);
  console.log(`Suggestions: ${sum("rows", "suggest")} shown rows (${sum("locked", "suggest")} with a guaranteed move).`);
  if (notes.length) console.log(`Notes:\n  ${notes.slice(0, 20).join("\n  ")}${notes.length > 20 ? `\n  ... ${notes.length - 20} more` : ""}`);
  const slowest = [...results].sort((a, b) => b.seconds - a.seconds)[0];
  const groups = new Map();
  for (const r of results) {
    const k = `${r.job.format} ${r.job.kind === "suggest" ? "Suggestions" : `${r.job.path} ${r.job.depth}`}`;
    const g = groups.get(k) || [0, 0];
    groups.set(k, [g[0] + 1, g[1] + r.seconds]);
  }
  console.log(`Jobs: ${[...groups].map(([k, [n, s]]) => `${k} ${n} (${s.toFixed(0)} s)`).join(", ")}.`);
  console.log(`Wall time ${((Date.now() - started) / 1000).toFixed(0)} s; slowest job ${slowest ? `${slowest.seconds.toFixed(1)} s` : "-"}.`);
  // one check per finished member, pick and crash-free run, two per shown row (its set and
  // "Use"), plus the four sentences the rule writes
  const checked = sum("members", "autobuild") + sum("picks", "autobuild") + builds.length + 2 * sum("rows", "suggest") + 4;
  console.log(`\n${checked} checked, ${failures.length} failed.`);
  process.exitCode = failures.length ? 1 : 0;
}

if (isMainThread) await main();
else if (workerData?.worker) await workerMain();
