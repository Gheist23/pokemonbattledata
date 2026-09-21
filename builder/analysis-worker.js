// Runs the Team Builder's analysis off the main thread so Team Evaluation and
// Auto Build never freeze the page (they are thousands of damage calculations).
//
// Everything here is the port of the Companion app's own analysis
// (builder/team-eval.js and its companions), checked against app recordings.
//
// Messages in:  { id, type: "overview" | "evaluate" | "speedTiers" | "suggestions" | "optimize" | "autobuild" | "tournament", payload }
//               { type: "cancel", payload: { target } } stops a running "tournament" request
// Messages out: { id, progress } while running, then { id, ok, result | error }

import { BuilderData, makeSet } from "./common.js";
import { teamOverview } from "./team-overview.js";
import { KnownTeams, mostSimilarTeam } from "./known-teams.js";
import { TournamentTest } from "./tournament-test.js";
import { TeamEvaluator, normalizeSettings } from "./team-eval.js";
import { TeamEvaluation } from "./team-payload.js";
import { SpeedTiers } from "./speed-tiers.js";
import { TeamSuggestions } from "./team-suggest.js";
import { TeamAutoBuild } from "./team-autobuild.js";
import { TeamOptimizer } from "./team-optimize.js";

let dataPromise = null;
let knownTeamsPromise = null;

/** The tournament-team library Suggestions and Auto Build recognise (loaded on first use). */
function knownTeams() {
  knownTeamsPromise ||= fetch("/data/builder/known-teams.json", { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => (payload ? new KnownTeams(payload) : null))
    .catch(() => null);
  return knownTeamsPromise;
}
const evaluators = new Map();

/** One evaluator per format and settings, so its damage caches carry over between runs. */
async function appEvaluation(format, settings) {
  dataPromise ||= BuilderData.load();
  const data = await dataPromise;
  const meta = await data.loadMeta(format);
  const clean = normalizeSettings(settings || {});
  const key = `${format}|${JSON.stringify(clean)}|${meta.generatedAt || ""}`;
  if (!evaluators.has(key)) {
    if (evaluators.size > 4) evaluators.delete(evaluators.keys().next().value);
    const evaluator = new TeamEvaluator(data, data.engine, format, clean);
    evaluator.setMetaRecords(meta.pokemon || []);
    evaluators.set(key, new TeamEvaluation(evaluator));
  }
  return { data, evaluation: evaluators.get(key) };
}

/** A structured-clone-safe copy of the evaluation payload (no engine objects). */
function transferable(payload) {
  const { slots, ...rest } = payload;
  return { ...rest, slots: (slots || []).map(({ entry, mon }) => ({ entry, mon })) };
}

const cancelled = new Set();

/** The closest tournament team, with the Stat Points its Natures go with (so it can be loaded as a team). */
function similarTeam(evaluation, built) {
  const known = evaluation.knownTeams;
  if (!known) return null;
  const entries = built.filter(Boolean).map((set) => ({ pokemon: set.species, form: set.form, item: set.item, moves: set.moves }));
  const similar = mostSimilarTeam(known, entries);
  if (!similar) return null;
  const suggestions = new TeamSuggestions(evaluation);
  for (const member of similar.members) {
    const spread = suggestions.spreadForNature(member.species, member.nature || "");
    member.bonuses = [...(spread?.bonuses || [0, 0, 0, 0, 0, 0])];
  }
  return similar;
}

self.addEventListener("message", async (event) => {
  const { id, type, payload } = event.data || {};
  if (type === "cancel") {
    cancelled.add(payload?.target);
    return;
  }
  const progress = (value) => self.postMessage({ id, progress: value });
  try {
    const sets = (payload.sets || []).map((set) => (set && set.species ? makeSet(set) : null));
    let result;
    if (type === "evaluate") {
      const { evaluation } = await appEvaluation(payload.format, payload.settings);
      const started = Date.now();
      result = transferable(evaluation.evaluate(sets, {
        checkSelection: payload.checks ?? null,
        onProgress: (done, total, name) => progress({ fraction: done / Math.max(1, total), message: `Calculating ${name}` }),
      }));
      result.seconds = (Date.now() - started) / 1000;
      self.postMessage({ id, ok: true, result });
      return;
    }
    if (type === "suggestions") {
      // The app's Suggested Pokemon: every ranked Pokemon tried in the open slot,
      // or in place of the three weakest members when the team is full.
      const { evaluation } = await appEvaluation(payload.format, payload.settings);
      evaluation.knownTeams ||= await knownTeams();
      const current = evaluation.evaluate(sets, { checkSelection: payload.checks ?? null });
      const suggestions = new TeamSuggestions(evaluation);
      const run = suggestions.run(current, {
        selection: payload.checks ?? null,
        onProgress: (done, total, name) => progress({ fraction: done / Math.max(1, total), message: `Testing ${name} (${done}/${total})` }),
      });
      result = {
        scanned: run.scanned, targets: run.targets, empty_slot: run.empty_slot,
        rows: run.rows.map((row) => ({
          name: row.name, action: row.action, action_kind: row.action_kind, slot_index: row.slot_index, swap_target: row.swap_target,
          score: row.score, position: row.position, item: row.item, ability: row.ability, moves: row.moves, spread_label: row.spread_label,
          answers: row.answers, details: row.details, severities: row._v104_detail_severities, candidate_entry: row.candidate_entry,
          spread: row.candidate_spread, form: row.form || row.candidate_entry?.form, components: row.suggestion_score_components_v318,
          found_in_team: row.found_in_team_v496 || "",
          archetype: row.strategy_archetype_v466, fixed: row._fixed_requirements, worsened: row._worsened_requirements,
          // _v480_item_options: what "Use" may swap a clashing item for (V482 applies Item Clause on apply).
          item_options: [...new Set([row.candidate_entry?.item, suggestions.common(row.candidate_entry?.pokemon || row.name).item, ...suggestions.usage(row.candidate_entry?.pokemon || row.name, "held_item", 30)].filter(Boolean))],
        })),
      };
      self.postMessage({ id, ok: true, result });
      return;
    }
    if (type === "speedTiers") {
      const { evaluation } = await appEvaluation(payload.format, payload.settings);
      const tiers = new SpeedTiers(evaluation.ev).rows(sets, payload.state);
      result = {
        summary: tiers.summary,
        maximum: tiers.maximum,
        rows: tiers.rows.map(({ speed, mon, info, ours }) => ({
          speed, ours,
          species: mon.pokemon_name, form: mon.form_name, item: mon.item, ability: mon.ability,
          name: evaluation.name(mon.form_name || mon.pokemon_name),
          variant: info.variant_label || "", position: info.position, points: info.speed_points || 0, nature: info.nature || "Serious",
        })),
      };
      self.postMessage({ id, ok: true, result });
      return;
    }
    if (type === "optimize") {
      // The Companion's Optimize: one member's Stat Points (and, when asked, Nature)
      // tuned against the Top-X threats with its moves held.
      const { evaluation } = await appEvaluation(payload.format, payload.settings);
      const started = Date.now();
      const out = new TeamOptimizer(evaluation).optimize(sets, Number(payload.slot) || 0, {
        optimizeNature: Boolean(payload.optimizeNature),
        onProgress: (fraction, message) => progress({ fraction, message }),
      });
      const clean = (row) => ({ kind: row.kind, threat: row.threat, previous: row.previous, now: row.now, detail: row.detail, score: row.score, meta_rank: row.meta_rank });
      result = {
        ok: Boolean(out.ok), message: out.message || "", score: out.score || 0, spread: out.spread, original: out.original,
        damage: out.damage_score_v404 || 0, speed: out.speed_order_score_v404 || 0, speed_before: out.speed_before, speed_after: out.speed_after,
        // Both variants of a threat often change the same way; show each change once.
        comparisons: [...new Map((out.comparisons || []).map((row) => [`${row.threat}|${row.detail}|${row.previous}|${row.now}`, clean(row)])).values()].slice(0, 40),
        improved: out.improved || 0, worsened: out.worsened || 0,
        top_meta: out.top_meta, targets: out.target_count, tested: out.tested_spreads, seconds: (Date.now() - started) / 1000,
      };
      self.postMessage({ id, ok: true, result });
      return;
    }
    if (type === "autobuild") {
      // The Companion's Auto Build: frozen pool, per-slot Suggestions scoring, the finish chain.
      const { evaluation } = await appEvaluation(payload.format, payload.settings);
      evaluation.knownTeams ||= await knownTeams();
      const started = Date.now();
      const run = new TeamAutoBuild(evaluation).run(sets, {
        selection: payload.checks ?? null,
        depth: payload.depth || "medium",
        cachedScores: payload.cachedScores || null,
        onlyBox: Boolean(payload.onlyBox),
        optimizeStats: Boolean(payload.optimizeStats),
        archetype: payload.archetype || "automatic",
        teamArchetype: payload.teamArchetype || "",
        prioritizeMeta: Boolean(payload.prioritizeMeta),
        box: (payload.box || []).map((set) => (set && set.species ? makeSet(set) : null)).filter(Boolean),
        onProgress: (fraction, message) => progress({ fraction, message }),
      });
      const built = run.entries.map((entry, i) => (entry.pokemon ? {
        species: entry.pokemon, form: entry.form, item: entry.item, ability: entry.ability, moves: entry.moves,
        nature: run.spreads[i]?.nature_name || "Serious", bonuses: run.spreads[i]?.bonuses || [0, 0, 0, 0, 0, 0],
      } : null));
      result = {
        error: run.error || "",
        sets: built,
        seconds: (Date.now() - started) / 1000,
        additions: run.additions.map((a) => ({ slot: a.slot, name: a.name, score: a.score, answers: a.row?.answers || [], details: a.row?.details || [] })),
        log: run.log,
        archetype: run.archetype || "",
        evaluation: run.error ? null : transferable(evaluation.evaluate(built.map((set) => (set ? makeSet(set) : null)), { checkSelection: payload.checks ?? null })),
        similar: run.error ? null : similarTeam(evaluation, built),
      };
      self.postMessage({ id, ok: true, result });
      return;
    }
    if (type === "tournament") {
      // Test against Tournament Teams: the fast Matchup Matrix against the first N
      // shipped tournament teams, with a fresh analysis after every batch.
      const { evaluation } = await appEvaluation(payload.format, payload.settings);
      evaluation.knownTeams ||= await knownTeams();
      if (!evaluation.knownTeams) throw new Error("The tournament teams could not be loaded. Check the connection and try again.");
      evaluation.tournament ||= new TournamentTest(evaluation, evaluation.knownTeams, new TeamSuggestions(evaluation));
      try {
        result = await evaluation.tournament.run(sets, {
          limit: Math.max(1, Number(payload.limit) || 1000),
          onSnapshot: (snapshot) => progress({ fraction: snapshot.tested / Math.max(1, snapshot.total), snapshot }),
          shouldStop: () => cancelled.has(id),
        });
      } finally {
        cancelled.delete(id);
      }
      self.postMessage({ id, ok: true, result });
      return;
    }
    if (type === "overview") {
      // The app's Team Builder dashboard (_v300_dashboard_overview): type and power
      // pressure both ways against the Speed tab's Top-X.
      const { evaluation } = await appEvaluation(payload.format, payload.settings);
      result = teamOverview(evaluation, sets, payload.top || 30);
      self.postMessage({ id, ok: true, result });
      return;
    }
    throw new Error(`Unknown request: ${type}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.stack || error?.message || error) });
  }
});
