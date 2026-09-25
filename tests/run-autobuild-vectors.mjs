// Checks builder/team-autobuild.js against Auto Build runs recorded from the
// Companion app (tests/autobuild-vectors.json, written by the app-side recorder):
// the seed threats, the frozen candidate pool per slot, every candidate's row,
// the finalists, each pick and the finished team.
//
//   node tests/run-autobuild-vectors.mjs [limit]
//
// Guaranteed moves (builder/guaranteed-moves.js): a recording made with the rule carries
// record.rules.guaranteed_move_share and replays with it; one without the stamp was made
// before the rule and replays with it off. For a stamped recording the app's own picks and
// finished members must also carry their guaranteed moves (computed from the recording's
// rows), so a regression shows even where both sides agree. GUARANTEED_MOVE_SHARE=95
// replays every recording with the rule on (diagnostic: shows what the rule changes).
//
// Nature / Stat Point pairing (builder/nature-spreads.js): a recording made with the rule
// carries record.rules.paired_spreads and replays with it; one without the stamp was made
// before the rule and replays with each Nature on the distribution at its own place in the
// usage file's other list. PAIRED_SPREADS=0 / =1 replays every recording either way.

// Terrain seeds (builder/engine.js): a recording made with the rule carries
// record.rules.terrain_seeds and replays with it; one without the stamp was made before
// the rule and replays with it off, so a held Electric/Grassy/Misty/Psychic Seed adds no
// stage. TERRAIN_SEEDS=1 / =0 replays every recording either way.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, terrainSeedOption } from "../builder/engine.js";
import { TeamEvaluator } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TeamAutoBuild } from "../builder/team-autobuild.js";
import { missingLocked } from "../builder/guaranteed-moves.js";
import { pokemonRecord } from "../tools/builder-meta.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
// autobuild-vectors-options.json: the same team built with a preferred archetype and/or
// Prioritize Meta Pokemon (the recorder's second argument and AUTOBUILD_META=1).
// autobuild-vectors-guaranteed.json: the same runs recorded again after the guaranteed-move
// rule, so they carry the stamp and replay with the rule on.
const cases = ["autobuild-vectors.json", "autobuild-vectors-options.json", "autobuild-vectors-guaranteed.json"]
  .filter((file) => existsSync(join(here, file)))
  .flatMap((file) => JSON.parse(readFileSync(join(here, file), "utf8")));
const siteMeta = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));
const evalCases = Object.fromEntries(JSON.parse(readFileSync(join(here, "eval-vectors.json"), "utf8")).map((c) => [c.name, c]));
// The Suggestions recordings of the same teams (the app's own ranked list, see below).
const suggestCases = ["suggest-vectors.json", "suggest-vectors-guaranteed.json"]
  .filter((file) => existsSync(join(here, file)))
  .flatMap((file) => {
    try {
      return JSON.parse(readFileSync(join(here, file), "utf8"));
    } catch {
      return [];
    }
  });
const engine = new DamageEngine(appData);
/** The recording's terrain-seed stamp (null: recorded before the rule, replayed with it off).
 *  TERRAIN_SEEDS=0 / =1 replays every recording either way. */
const seedStamp = (testCase) => testCase.record?.rules?.terrain_seeds ?? testCase.rules?.terrain_seeds ?? null;
const seedRule = (testCase) => terrainSeedOption(process.env.TERRAIN_SEEDS === undefined ? seedStamp(testCase) : process.env.TERRAIN_SEEDS);

const knownTeams = new KnownTeams(JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8")));
const aliases = appData.usageAliases || {};
const limit = Number(process.argv[2]) || 40;

function same(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a));
  return JSON.stringify(a) === JSON.stringify(b);
}
const asEntry = (e) => (Array.isArray(e) ? { pokemon: e[0], item: e[1], form: e[2], ability: e[3], moves: e[4] || [] } : e);
const entryText = (e) => (e && e.pokemon ? `${e.pokemon} @ ${e.item} [${e.form}] ${e.ability} / ${(e.moves || []).join(", ")}` : "(empty)");
/** The recording's guaranteed-moves stamp (null: recorded before the rule, replayed without it). */
const stampOf = (testCase) => testCase.record?.rules?.guaranteed_move_share ?? testCase.rules?.guaranteed_move_share ?? null;
const ruleShare = (testCase) => (process.env.GUARANTEED_MOVE_SHARE ? Number(process.env.GUARANTEED_MOVE_SHARE) : stampOf(testCase));
const lacks = (sg, entry, team) => missingLocked(sg, entry, team).map((l) => `${l.move} ${l.share}%`);
/** The recording's Nature / Stat Point pairing stamp (null: recorded before the rule, replayed
 *  with the usage file's index zip). PAIRED_SPREADS=0 / =1 replays every recording either way. */
const pairedStamp = (testCase) => testCase.record?.rules?.paired_spreads ?? testCase.rules?.paired_spreads ?? null;
/** The V512 scoring stamp (null: recorded before the rule, replayed with it off). */
const scoreRule = (testCase) => (process.env.SCORE_RULES === undefined
  ? (testCase.record?.rules?.score_composition ?? testCase.rules?.score_composition ?? null)
  : process.env.SCORE_RULES);
const pairedRule = (testCase) => (process.env.PAIRED_SPREADS === undefined ? pairedStamp(testCase) : process.env.PAIRED_SPREADS);
/** The recording's V514 Team Building Checks stamp (null: recorded before the rule, so the ten
 *  pre-V514 ids, the label "Defensive Switch-ins" and the V251 thresholds replay).
 *  TEAM_CHECK_RULES=0 / =1 replays every recording either way. */
const checkRule = (testCase) => (process.env.TEAM_CHECK_RULES === undefined
  ? (testCase?.record?.rules?.team_checks ?? testCase?.rules?.team_checks ?? null)
  : process.env.TEAM_CHECK_RULES);


const failures = [];
const byField = new Map();
let total = 0;
for (const testCase of cases) {
  engine.terrainSeeds = seedRule(testCase);
  const rec = testCase.record;
  const archetype = testCase.archetype_key || "automatic";
  const prioritizeMeta = Boolean(testCase.dialog?.checkboxes?.autoBuildPrioritizeMetaV462);
  const label = `${testCase.name}/${archetype}${prioritizeMeta ? "+meta" : ""}${stampOf(testCase) ? " guaranteed" : ""}`;
  const failCount = failures.length;
  const records = new Map();
  // A recording of a start team that has no evaluation / Suggestions recording of its own
  // names the recorded team whose rows the site's meta records are rebuilt from (the meta
  // is the format's, not the team's), so nothing from the site's newer meta is mixed in.
  const metaCase = testCase.meta_case || testCase.name;
  for (const row of evalCases[metaCase]?.record.meta[0]?.rows || []) {
    const stem = String(row.pokemon || row.base_name || row.name);
    if (!records.has(stem) && (row.rows || []).length) records.set(stem, pokemonRecord(stem, row.rows, aliases));
  }
  for (const pool of rec._v202_top_x_suggestion_candidates) {
    for (const meta of pool.rows) {
      const stem = String(meta.base_name || meta.pokemon || meta.name);
      if (!records.has(stem) && (meta.rows || []).length) records.set(stem, pokemonRecord(stem, meta.rows, aliases));
    }
  }
  // The Suggestions recording of the same team holds the app's whole ranked list; with
  // it, nothing from the site's own (newer) meta is mixed in.
  const appPool = suggestCases.find((c) => c.name === metaCase)?.record.rows || [];
  for (const call of appPool) {
    const meta = call.meta;
    const stem = String(meta.base_name || meta.pokemon || meta.name);
    if (!records.has(stem) && (meta.rows || []).length) records.set(stem, pokemonRecord(stem, meta.rows, aliases));
  }
  if (!appPool.length) for (const record of siteMeta.pokemon) if (!records.has(record.name)) records.set(record.name, record);
  const settings = rec._v452_fast_autobuild_payload[0].snapshot?.settings || testCase.settings;
  const evaluator = new TeamEvaluator(null, engine, "Doubles", settings, { pairedSpreads: pairedRule(testCase), scoreRules: scoreRule(testCase), checkRules: checkRule(testCase) });
  evaluator.setMetaRecords([...records.values()]);
  const evaluation = new TeamEvaluation(evaluator);
  evaluation.knownTeams = knownTeams;
  const builder = new TeamAutoBuild(evaluation, { guaranteedMoveShare: ruleShare(testCase) });

  // The start team as the builder holds it; the recorded spreads are the case's.
  const start = rec.start[0].team.map(asEntry);
  const caseSpreads = testCase.spreads_in || [];
  const sets = start.map((e, i) => (e.pokemon ? { species: e.pokemon, form: e.form, item: e.item, ability: e.ability, moves: e.moves, nature: caseSpreads[i]?.nature_name, bonuses: caseSpreads[i]?.bonuses } : null));

  // 1. finalised existing members
  const entries = sets.map((s) => builder.entryFromSet(s));
  const spreads = sets.map((s) => (s ? { nature_name: s.nature || "Serious", bonuses: s.bonuses || [0, 0, 0, 0, 0, 0] } : null));
  builder.finalizeExisting(entries, spreads);
  const wantFinal = rec._v477_finalize_existing_team[0].team.map(asEntry);
  entries.forEach((e, i) => {
    total += 1;
    if (e.pokemon && !same([e.pokemon, e.item, e.ability, e.moves], [wantFinal[i].pokemon, wantFinal[i].item, wantFinal[i].ability, wantFinal[i].moves])) failures.push(`finalize slot ${i}: app ${entryText(wantFinal[i])} | web ${entryText(e)}`);
  });

  // 2. the seed threats
  const slots = builder.slotsFor(entries, spreads);
  const { chosen, options } = builder.runOptions(entries, slots, { archetype, prioritizeMeta });
  const seed = builder.seedPayload(slots, null, null);
  const wantThreats = rec._v452_fast_autobuild_payload[0].threats;
  total += 1;
  const names = (rows) => rows.map((t) => `${t.name}:${Number(t.score).toFixed(2)}`).join(", ");
  if (names(seed.threats) !== names(wantThreats)) failures.push(`seed threats\n    app ${names(wantThreats)}\n    web ${names(seed.threats)}`);

  // 3. the frozen pool
  const profile = { key: "medium", budget: 100, finalists: 2 };
  const frozen = builder.frozenPool(builder.names(slots));
  const poolEntries = entries.map((e) => ({ ...e }));
  const poolSpreads = spreads.map((s) => (s ? { ...s } : null));
  rec._v202_top_x_suggestion_candidates.forEach((want, slotNo) => {
    total += 1;
    if (slotNo > 0) {
      const at = poolEntries.findIndex((e) => !e.pokemon);
      const pick = rec._v450_complete_selected_auto_set[slotNo - 1];
      poolEntries[at] = asEntry(pick.entry);
      poolSpreads[at] = pick.spread;
    }
    const poolSlots = builder.slotsFor(poolEntries, poolSpreads);
    const got = builder.slotPool(frozen, poolSlots, want.active || builder.names(poolSlots), profile, options).map((r) => r.name);
    const app = want.rows.map((r) => r.name);
    if (got.join("|") !== app.join("|")) {
      failures.push(`pool slot ${slotNo}: app ${app.length} | web ${got.length}; missing ${app.filter((n) => !got.includes(n)).slice(0, 8)}; extra ${got.filter((n) => !app.includes(n)).slice(0, 8)}; first diff at ${app.findIndex((n, i) => got[i] !== n)}`);
    }
  });

  // 4. each candidate call, against the recorded team at that point
  const FIELDS = ["name", "score", "item", "ability", "moves", "answers", "checks_component", "threat_component", "synergy_component", "speed_component",
    "archetype_component_v429", "auto_build_archetype_priority_v432", "team_check_delta_v433", "role_fixes_v466", "_hard_red_checks_v472", "_hard_yellow_checks_v472",
    "_hard_check_pressure_v472", "_mega_red_v472", "defensive_switch_warning_count", "prioritized_meta_member_v462", "_manual_archetype_v472",
    "_manual_archetype_v477", "_archetype_critical_unmet_v477", "_archetype_total_unmet_v477", "_archetype_deficit_v477", "_archetype_final_match_v477", "_archetype_final_complete_v477"];
  const calls = rec._v378_fast_suggestion_for_candidate;
  const picks = rec._v450_complete_selected_auto_set.map((p) => ({ entry: asEntry(p.entry), spread: p.spread }));
  let slotNo = 0;
  const webRowsBySlot = [];
  let context = null;
  let lastTeam = "";
  const seedNow = builder.seedPayload(slots, null, null);
  const liveEntries = entries.map((e) => ({ ...e }));
  const liveSpreads = spreads.map((s) => (s ? { ...s } : null));
  const startEntries = liveEntries.filter((e) => e.pokemon).map((e) => ({ ...e }));
  // Auto Build screens with the per-move evaluator (V458), as run() does.
  builder.ev.perMoveAttacks = true;
  for (const [index, call] of calls.entries()) {
    const teamKey = JSON.stringify(call.team.map((e) => e[0]));
    if (teamKey !== lastTeam) {
      if (lastTeam) {
        // the previous slot was filled with the app's pick
        const pick = picks[slotNo];
        const at = liveEntries.findIndex((e) => !e.pokemon);
        liveEntries[at] = pick.entry;
        liveSpreads[at] = pick.spread;
        const pickRow = { ...rec._v459_select_structural_finalists[slotNo].finalists[0] };
        // Older recordings keep only the scalar fields: rebuild the Speed projection from its delta.
        if (!pickRow.suggestion_score_components_v318 && pickRow.speed_delta !== undefined) {
          pickRow.projected_speed_score = Number(seedNow.speed?.score ?? 50) + Number(pickRow.speed_delta);
        }
        builder.projectScores(seedNow, pickRow);
        slotNo += 1;
      }
      lastTeam = teamKey;
      const liveSlots = builder.slotsFor(liveEntries, liveSpreads);
      seedNow.checks = builder.sg.snapshotFor(liveSlots, null);
      context = {
        payload: seedNow, teamSlots: liveSlots, teamEntries: liveSlots.map((s) => s.entry), activeNames: builder.names(liveSlots),
        emptySlot: liveSlots.length, selection: null, selected: builder.checks.selectedIds(null), swapTarget: "", autoBuild: true, fieldEntries: startEntries, ...options,
        // The app's finished-team rules reject outright; the site falls back instead (see autoBuildFilters).
        strictFinishFilters: true,
      };
    }
    total += 1;
    const meta = rec._v202_top_x_suggestion_candidates[slotNo].rows.find((r) => r.name === call.meta);
    const got = meta ? builder.sg.evaluateCandidate(structuredClone(meta), context) : null;
    if (got && got.score > 0) (webRowsBySlot[slotNo] ||= []).push(got);
    const want = call.row;
    if (!want && !got) continue;
    if (!want || !got) {
      failures.push(`slot ${slotNo} #${index} ${call.meta}: app ${want ? want.score : "none"} | web ${got ? got.score : "none"}${got ? ` (warnings ${got.defensive_switch_warning_count})` : ""}`);
      continue;
    }
    const diffs = [];
    for (const f of FIELDS) {
      if (want[f] === undefined && got[f] === undefined) continue;
      if (!same(want[f], got[f])) {
        diffs.push(`${f}: app ${JSON.stringify(want[f])} | web ${JSON.stringify(got[f])}`);
        byField.set(f, (byField.get(f) || 0) + 1);
      }
    }
    if (diffs.length) failures.push(`slot ${slotNo} #${index} ${call.meta}\n    ${diffs.join("\n    ")}`);
  }

  builder.ev.perMoveAttacks = false;

  // 4b. the finalists, from the web's own rows for each slot's recorded candidates
  {
    const byTeam = new Map();
    for (const call of calls) {
      const k = JSON.stringify(call.team.map((e) => e[0]));
      if (!byTeam.has(k)) byTeam.set(k, []);
      byTeam.get(k).push(call);
    }
    // The forcing state carries over from slot to slot, as in run().
    const state = { megaNeeded: builder.megaStoneSlots(entries).length === 0, log: [], archetype: chosen, ...chosen.forcing(entries.filter((e) => e.pokemon)) };
    [...byTeam.values()].forEach((slotCalls, n) => {
      const want = rec._v459_select_structural_finalists[n];
      if (!want) return;
      const forced = state.megaNeeded || (state.needed > 0 && chosen.key);
      // Prioritize Meta ranks by design where V468 meant it to (see order()); forced picks still compare.
      if (prioritizeMeta && !forced) return;
      total += 1;
      const appRanked = (want.ranked || []).length;
      const webRows = webRowsBySlot[n] || [];
      const got = builder.finalists(webRows, profile, state).map((r) => `${r.name}:${r.score}:${r._hard_red_checks_v472}/${r._hard_yellow_checks_v472}/${Number(r._hard_check_pressure_v472).toFixed(2)}`);
      const app = want.finalists.map((r) => `${r.name}:${r.score}:${r._hard_red_checks_v472}/${r._hard_yellow_checks_v472}/${Number(r._hard_check_pressure_v472).toFixed(2)}`);
      if (got.join(" | ") !== app.join(" | ")) failures.push(`finalists slot ${n} (app ranked ${appRanked}, web ${webRows.length})
    app ${app.join(" | ")}
    web ${got.join(" | ")}`);
    });
  }

  // 5. the whole run
  const run = builder.run(sets, { selection: null, depth: "medium", archetype, prioritizeMeta });
  if (process.env.SHOW_LOG) console.log(`${label}\n${run.log.join("\n")}`);
  if (!prioritizeMeta) {
    total += 1;
    const deadlock = testCase.finished?.ok === false && /structurally fitting Pokemon/.test(testCase.finished.error || "");
    // Where the app deadlocked, its picks up to that point are what the site's must start with.
    const got = run.additions.map((a) => entryText(a.entry)).slice(0, deadlock ? picks.length : undefined);
    const want = picks.map((p) => entryText(p.entry));
    if (got.join(" || ") !== want.join(" || ")) failures.push(`picks\n    app ${want.join("\n        ")}\n    web ${got.join("\n        ")}${run.error ? `\n    web error: ${run.error}` : ""}`);
    // 6. the finished team, after the finish passes (Megas, field, speed mode, sets) - or the same failure
    if (testCase.finished && testCase.finished.ok === false) {
      // The site finishes where the app deadlocks on its last slot - by design, and saying so.
      total += 1;
      if (!run.error && !deadlock) failures.push(`the app's build failed (${testCase.finished.error}) | web finished`);
      if (deadlock && run.error) failures.push(`the app deadlocked on its last slot and so did the site: ${run.error}`);
    } else {
      (testCase.final_team || []).map(asEntry).forEach((wantEntry, i) => {
        total += 1;
        if (entryText(wantEntry) !== entryText(run.entries[i])) failures.push(`finished slot ${i}\n    app ${entryText(wantEntry)}\n    web ${entryText(run.entries[i])}`);
      });
    }
  }

  // 7. guaranteed moves, on a recording made with the rule: every pick carries its guaranteed
  // moves on the start team (the field gate the candidates were screened with), and every
  // finished member on the finished team - except a member of the user's no step changed.
  if (Number(stampOf(testCase)) > 0) {
    const startTeam = wantFinal.filter((e) => e.pokemon);
    picks.forEach((pick, n) => {
      total += 1;
      const missing = lacks(builder.sg, pick.entry, startTeam);
      if (missing.length) failures.push(`guaranteed moves: pick ${n} ${entryText(pick.entry)} lacks ${missing.join(", ")}`);
    });
    const finalTeam = (testCase.final_team || []).map(asEntry);
    const members = finalTeam.filter((e) => e && e.pokemon);
    finalTeam.forEach((member, i) => {
      if (!member?.pokemon) return;
      const own = wantFinal[i];
      const untouched = own?.pokemon && own.pokemon === member.pokemon && (own.moves || []).join("|") === (member.moves || []).join("|");
      if (untouched) return;
      total += 1;
      const missing = lacks(builder.sg, member, members);
      if (missing.length) failures.push(`guaranteed moves: finished slot ${i} ${entryText(member)} lacks ${missing.join(", ")}`);
    });
  }
  for (let i = failCount; i < failures.length; i += 1) failures[i] = `[${label}] ${failures[i]}`;
}
for (const failure of failures.slice(0, limit)) console.log(failure);
console.log(`\n${total} checked, ${failures.length} mismatched.`);
if (byField.size) console.log("by field:", Object.fromEntries([...byField.entries()].sort((a, b) => b[1] - a[1])));
process.exitCode = failures.length ? 1 : 0;
