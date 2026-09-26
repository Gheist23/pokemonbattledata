// Runs the Team Builder's analysis off the main thread so Team Evaluation and
// Auto Build never freeze the page (they are thousands of damage calculations).
//
// Team Evaluation, Suggestions and the Auto Build anchor are the port of the Companion
// app's analysis (builder/team-eval.js and its companions), checked against app
// recordings; the Auto Build search, Optimize and the Tournament Test go further.
//
// Messages in:  { id, type: "overview" | "evaluate" | "speedTiers" | "suggestions" | "optimize" | "autobuild" | "tournament", payload }
//               { type: "cancel", payload: { target } } stops a running "tournament", "optimize" or
//               "autobuild" request (it answers with the best result so far) and the Suggestions check
// Messages out: { id, progress } while running, then { id, ok, result | error }

import { BuilderData, makeSet } from "./common.js";
import { teamOverview } from "./team-overview.js";
import { KnownTeams, mostSimilarTeam } from "./known-teams.js";
import { TournamentTest } from "./tournament-test.js";
import { TeamEvaluator, normalizeSettings } from "./team-eval.js";
import { TeamEvaluation } from "./team-payload.js";
import { SpeedTiers } from "./speed-tiers.js";
import { SUGGESTION_DIVERSITY, SUGGESTION_SCORING, TeamSuggestions } from "./team-suggest.js";
import { TeamAutoBuild } from "./team-autobuild.js";
import { DeepOptimizer } from "./optimize-deep.js";

let dataPromise = null;
let knownTeamsPromise = null;

/**
 * The tournament-team library Suggestions and Auto Build recognise (loaded on first use).
 * A failed load is not kept: the next request tries again, instead of the whole session
 * running without the "Found in similar team" bonus.
 */
function knownTeams() {
  knownTeamsPromise ||= fetch("/data/builder/known-teams.json", { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => (payload ? new KnownTeams(payload) : null))
    .catch(() => null)
    .then((known) => {
      if (!known) {
        knownTeamsPromise = null;
        console.warn("The tournament-team library could not be loaded; it is tried again on the next request.");
      }
      return known;
    });
  return knownTeamsPromise;
}

const yieldWorker = () => new Promise((resolve) => setTimeout(resolve, 0));
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
      // Suggested Pokémon: every ranked Pokémon (or, with onlyBox, every Box Pokémon) tried
      // in the open slot, or in place of the three members the failing checks point at.
      // The ranked list goes out first ({progress: {ranked}}); then each shown row is
      // checked against the full Team Evaluation of the team it would make, one
      // {progress: {detail}} at a time (display only - the order never changes).
      const { evaluation } = await appEvaluation(payload.format, payload.settings);
      evaluation.knownTeams ||= await knownTeams();
      // A run the page dropped before it started (the team or settings changed) is not ranked:
      // the ranking itself cannot be interrupted once it runs.
      await yieldWorker();
      if (cancelled.has(id)) {
        cancelled.delete(id);
        self.postMessage({ id, ok: true, result: { scanned: 0, targets: [], empty_slot: null, scope: payload.onlyBox ? "box" : "all", rows: [], checking: false, cancelled: true } });
        return;
      }
      const selection = payload.checks ?? null;
      const current = evaluation.evaluate(sets, { checkSelection: selection });
      // V511 (`suggestion_scoring`): production ranks on the damped archetype reward and the
      // calc-backed terms. V517 (`suggestion_diversity`) then shapes the shown list so one swap
      // target cannot take all of it. A recorded run replays with the versions its stamp names.
      const suggestions = new TeamSuggestions(evaluation, { suggestionScoring: SUGGESTION_SCORING, suggestionDiversity: SUGGESTION_DIVERSITY });
      const box = payload.onlyBox ? (payload.box || []).map((set) => (set && set.species ? makeSet(set) : null)).filter(Boolean) : null;
      const run = suggestions.run(current, {
        selection,
        box,
        onProgress: (done, total, name, phase) => progress({
          fraction: done / Math.max(1, total),
          message: phase === "measuring" ? `Measuring ${name} against the team's worst threats (${done}/${total})` : `Testing ${name} (${done}/${total})`,
        }),
      });
      const selected = evaluation.checks.selectedIds(selection);
      const rows = run.rows.map((row) => suggestions.forPage(row, selected));
      const head = { scanned: run.scanned, targets: run.targets, empty_slot: run.empty_slot, scope: box ? "box" : "all", known_teams: Boolean(evaluation.knownTeams) };
      progress({ ranked: { ...head, rows, checking: rows.length > 0 } });
      try {
        for (const [i, row] of run.rows.entries()) {
          // Other requests (a new evaluation after "Use") and a cancel may arrive in between.
          await yieldWorker();
          if (cancelled.has(id)) break;
          let projected;
          try {
            projected = suggestions.projectedDetail(row, sets, current, { checkSelection: selection });
          } catch (error) {
            projected = { error: String(error?.message || error).split("\n")[0] };
          }
          rows[i].projected = projected;
          progress({ detail: { key: rows[i].key, projected }, fraction: (i + 1) / run.rows.length, message: `Checking suggestion ${i + 1} of ${run.rows.length} against the full Team Evaluation` });
        }
      } finally {
        cancelled.delete(id);
      }
      result = { ...head, rows, checking: false };
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
      // Optimize (builder/optimize-deep.js): one member's Nature, Stat Points and, when
      // asked, attacking moves, searched against the Team Evaluation's Top X. Like the
      // tournament test it yields between batches, so a "cancel" stops it with the best
      // result found so far.
      const { evaluation } = await appEvaluation(payload.format, payload.settings);
      try {
        result = await new DeepOptimizer(evaluation).run(sets, Number(payload.slot) || 0, {
          depth: payload.depth === "quick" ? "quick" : "deep",
          testMoves: payload.testMoves !== false,
          keepNature: Boolean(payload.keepNature),
          keepSpeed: Boolean(payload.keepSpeed),
          lockedMoves: Array.isArray(payload.lockedMoves) ? payload.lockedMoves : [],
          topX: Number(payload.topX) || Number(payload.settings?.top_meta) || 0,
        }, {
          onProgress: (fraction, message, phase) => progress({ fraction, message, phase }),
          shouldStop: () => cancelled.has(id),
        });
      } finally {
        cancelled.delete(id);
      }
      self.postMessage({ id, ok: true, result });
      return;
    }
    if (type === "autobuild") {
      // Auto Build: the greedy pick per slot, then a search over alternative teams that
      // are finished and compared by the full Team Evaluation (builder/autobuild-search.js).
      // It is async: other requests may run between its chunks, and it switches the shared
      // evaluator's per-move mode on only inside a chunk, so they never see it. A cancel
      // (Stop) returns the best team found so far.
      const { evaluation } = await appEvaluation(payload.format, payload.settings);
      evaluation.knownTeams ||= await knownTeams();
      const started = Date.now();
      const selection = payload.checks ?? null;
      let run;
      try {
        run = await new TeamAutoBuild(evaluation).run(sets, {
          search: payload.search || payload.depth || "deep",
          selection,
          depth: payload.depth || "deep",
          cachedScores: payload.cachedScores || null,
          onlyBox: Boolean(payload.onlyBox),
          optimizeStats: Boolean(payload.optimizeStats),
          archetype: payload.archetype || "automatic",
          teamArchetype: payload.teamArchetype || "",
          prioritizeMeta: Boolean(payload.prioritizeMeta),
          box: (payload.box || []).map((set) => (set && set.species ? makeSet(set) : null)).filter(Boolean),
          onProgress: (fraction, message) => progress({ fraction, message }),
          shouldStop: () => cancelled.has(id),
        });
      } finally {
        cancelled.delete(id);
      }
      const built = run.entries.map((entry, i) => (entry.pokemon ? {
        species: entry.pokemon, form: entry.form, item: entry.item, ability: entry.ability, moves: entry.moves,
        nature: run.spreads[i]?.nature_name || "Serious", bonuses: run.spreads[i]?.bonuses || [0, 0, 0, 0, 0, 0],
      } : null));
      // The search already evaluated the team it chose (none for a build stopped before
      // its first team was complete, so Stop answers at once); the greedy path did not.
      const chosen = run.error || run.search?.unevaluated ? null : run.payload || evaluation.evaluate(built.map((set) => (set ? makeSet(set) : null)), { checkSelection: selection });
      result = {
        error: run.error || "",
        sets: built,
        seconds: (Date.now() - started) / 1000,
        additions: run.additions.map((a) => TeamAutoBuild.additionForPage(a)),
        log: run.log,
        archetype: run.archetype || "",
        evaluation: chosen ? transferable(chosen) : null,
        similar: run.error ? null : similarTeam(evaluation, built),
        compared: run.compared || [],
        search: run.search || null,
      };
      self.postMessage({ id, ok: true, result });
      return;
    }
    if (type === "tournament") {
      // Test against Tournament Teams: short games (turn 1, then the fight that follows)
      // against the first N shipped tournament teams, with a fresh analysis after every
      // batch. The format decides how many each side brings and whether the lead matrix
      // is 2 vs 2 or 1 vs 1 (TeamEvaluator.format); the snapshot also carries the most
      // similar tournament team, so no separate lookup is needed here.
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
      // The Team Overview charts: type and power pressure both ways against the
      // overview's Top-X. Only what the page draws is sent back (a few KB at Top 262).
      const { evaluation } = await appEvaluation(payload.format, payload.settings);
      const ov = teamOverview(evaluation, sets, payload.top || 30);
      result = {
        empty: ov.empty,
        top_x: ov.top_x,
        offense_chart: ov.offense_chart,
        defense_chart: ov.defense_chart,
        team_to_meta: ov.team_to_meta ? { score: ov.team_to_meta.score, type_summary: ov.team_to_meta.type_summary } : null,
        meta_to_team: ov.meta_to_team ? { score: ov.meta_to_team.score, type_summary: ov.meta_to_team.type_summary } : null,
        weaknesses: ov.weaknesses,
      };
      self.postMessage({ id, ok: true, result });
      return;
    }
    throw new Error(`Unknown request: ${type}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.stack || error?.message || error) });
  }
});
