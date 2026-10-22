// Runs the Team Builder's analysis off the main thread so Team Evaluation and
// Auto Build never freeze the page (they are thousands of damage calculations).
//
// Team Evaluation, Suggestions and the Auto Build anchor are the port of the Companion
// app's analysis (builder/team-eval.js and its companions), checked against app
// recordings; the Auto Build search, Optimize and the Tournament Test go further.
//
// Messages in:  { id, type: "overview" | "evaluate" | "speedTiers" | "suggestions" | "optimize" | "autobuild" | "tournament" | "solver", payload }
//               { type: "cancel", payload: { target } } stops a running "tournament", "optimize",
//               "autobuild" or "solver" request (it answers with the best result so far) and the
//               Suggestions check
// Messages out: { id, progress } while running, then { id, ok, result | error }

import { BuilderData, makeSet } from "./common.js";
import { teamOverview } from "./team-overview.js";
import { KnownTeams, mostSimilarTeam } from "./known-teams.js";
import { BRING_BY_FORMAT, TERRAINS, TournamentTest, WEATHERS } from "./tournament-test.js";
import { Solver } from "./solver.js";
import { HiddenSets } from "./hidden-sets.js";
import { PLAY_LOOKAHEAD, PLAY_POOL, PlayGame, THINK_MS, teamFromKnown } from "./play-game.js";
import { loadSetLibrary } from "./pokemon-sets.js";
import { TeamEvaluator, normalizeSettings } from "./team-eval.js";
import { TeamEvaluation } from "./team-payload.js";
import { SpeedTiers } from "./speed-tiers.js";
import { SUGGESTION_DIVERSITY, SUGGESTION_SCORING, TeamSuggestions } from "./team-suggest.js";
import { TeamAutoBuild } from "./team-autobuild.js";
import { DeepOptimizer } from "./optimize-deep.js";
import { OPTIMIZE_SPREAD_DEPTH } from "./optimize-spread-depth.js";

let dataPromise = null;
let knownTeamsPromise = null;

/**
 * The tournament-team library Suggestions and Auto Build recognise (loaded on first use).
 * A failed load is not kept: the next request tries again, instead of the whole session
 * running without the "Found in similar team" bonus.
 */
/**
 * The compiled move and Ability effects the Tournament Test models (loaded on first use).
 *
 * A failed load is not kept, the way the team library's is not: the next request tries again
 * rather than leaving the whole session running a simpler simulation than it says it does.
 */
let moveEffectsPromise = null;
function moveEffects() {
  moveEffectsPromise ||= fetch("/data/builder/move-effects.json", { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((payload) => {
      if (!payload) {
        moveEffectsPromise = null;
        console.warn("The move and Ability effects could not be loaded; they are tried again on the next request.");
      }
      return payload;
    });
  return moveEffectsPromise;
}

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

/**
 * The games in play, by id.
 *
 * A tab plays one at a time, but a reload leaves the old one behind, so the map is capped and the
 * oldest is dropped rather than held for ever.
 */
const games = new Map();

function keepGame(id, game) {
  if (games.size > 4) games.delete(games.keys().next().value);
  games.set(id, game);
}

/** The opponent's whole team: one real tournament team, all six of it. */
function foeTeam(data, format, known, rng) {
  const teams = known?.teams || [];
  if (!teams.length) return { name: "", sets: [] };
  const team = teams[Math.min(teams.length - 1, Math.floor(rng() * teams.length))];
  return { name: team.name || "", sets: teamFromKnown(data, format, team) };
}

/**
 * The four of the six the opponent brings, and the order it leads in.
 *
 * Which four is not arbitrary -- a sheet brings the four that suit the matchup -- but choosing
 * them properly means searching every bring against every bring, which is the Tournament Test's
 * whole job and far too slow to put in front of somebody waiting for a battle. They are taken by
 * ladder rank instead, which is the one thing this side knows about its own team for nothing.
 */
function foeBring(data, format, sets) {
  const bring = BRING_BY_FORMAT[format];
  return sets
    .map((set, index) => ({ set, index, at: data.usage(format, set.species, set.form)?.position ?? 9999 }))
    .sort((a, b) => a.at - b.at)
    .slice(0, bring)
    .sort((a, b) => a.index - b.index)
    .map((row) => row.set);
}

/** What a team preview is allowed to say about the other side: who, and nothing else. */
function previewMon(data, set) {
  return {
    species: set.species,
    form: set.form,
    name: data.setName ? data.setName(set) : set.species,
    sprite: data.sprite(set.species, set.form, ""),
  };
}

/** Teams dealt but not yet brought, by id. A reload leaves one behind, so the map is capped. */
const previews = new Map();

/**
 * The view, with the weather and the terrain said in words.
 *
 * `view.field.weather` and `.terrain` are INDICES into the engine's own ordered lists, and the
 * page used to carry its own copy of those lists to read them with. That copy had Psychic and
 * Misty the other way round, so Indeedee's Psychic Surge came up on screen as Misty Terrain.
 *
 * The translation belongs here rather than on the page because the lists live in
 * tournament-test.js, and importing that into the page would drag the whole engine -- some four
 * hundred kilobytes of it -- into the main thread for the sake of two arrays of five strings.
 * The worker already has it. So the field arrives already named, and the page has no order of
 * its own to get wrong.
 */
function named(view) {
  return {
    ...view,
    field: {
      ...view.field,
      weather: WEATHERS[view.field.weather] || "None",
      terrain: TERRAINS[view.field.terrain] || "None",
    },
  };
}

/** mulberry32, the same one the search uses: a run carries its seed, so its pool is reproducible. */
function rollerFrom(seed) {
  let state = (seed >>> 0) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The pool of possible boards a Closed Team Sheet search runs over.
 *
 * Same Pokemon, same HP, same stages, same field -- a different roll of what each one is
 * carrying. A row's `fixed` is what the person has pinned on its tile, and every roll honours
 * all of it; the rest comes from the sets real teams brought, or from the usage percentages when
 * that Pokemon has none on file.
 */
async function possibleBoards(data, format, board, pool, seed) {
  const library = await loadSetLibrary();
  const hidden = new HiddenSets(data, format, library);
  const rng = rollerFrom(seed);
  const boards = [];
  for (let d = 0; d < pool; d += 1) {
    const sides = board.sides.map((rows) => {
      const rolled = hidden.rollSide(rows.map((row) => ({
        species: row.set?.species, form: row.set?.form, fixed: row.fixed || null,
      })), rng);
      return rows.map((row, i) => ({ ...row, set: rolled[i].set }));
    });
    boards.push({ ...board, sides });
  }
  return boards;
}

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
          optimizeSpreadDepth: OPTIMIZE_SPREAD_DEPTH,
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
          // Prioritize Meta's tier above the yellow checks (builder/autobuild-meta-priority.js).
          // Left out of the request, production's version; 0 restores the order before the rule.
          autobuildMetaPriority: payload.autobuildMetaPriority,
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
      evaluation.tournament ||= new TournamentTest(evaluation, evaluation.knownTeams, new TeamSuggestions(evaluation),
        { effects: await moveEffects() });
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
    if (type === "play") {
      // A game against the Solver. Everything about it lives here: the board, whose turn it is,
      // what the opponent has been shown of the player's team, and the log.
      const { data, evaluation } = await appEvaluation(payload.format, payload.settings);
      evaluation.knownTeams ||= await knownTeams();
      // A game gets its OWN engine, for two reasons.
      //
      // It must have the compiled move and Ability effects. `solverTournament` is built without
      // them, so a played game had no flinches, no secondary burns or paralysis and no
      // critical-hit data at all -- the registry was shipped and never read. The Solver page
      // shares that instance, so adding them there would have changed every answer the Solver
      // gives, which is a different decision from this one.
      //
      // And it must not share a cache with a search that resets it. `searchClosed` begins by
      // clearing the caches and restarting the unit numbering those caches are keyed on, so a
      // board held across a search reads whatever the search filed under its old numbers.
      evaluation.playTournament ||= new TournamentTest(
        evaluation,
        evaluation.knownTeams || new KnownTeams({ teams: [] }),
        new TeamSuggestions(evaluation),
        // A battle prices a hit against the Pokemon actually standing there: its live HP and its
        // status. The evaluation deliberately does not (TOURNAMENT_LIVE_HP), because its numbers
        // are published and compared against the Companion; a played game's are neither.
        { effects: await moveEffects(), liveHpRule: 1 },
      );
      evaluation.playSolver ||= new Solver(evaluation.playTournament);
      const library = await loadSetLibrary();

      if (payload.action === "new") {
        // A page cached before the team preview existed. It sends the four it brings and expects
        // a started game back, so it gets one; see the note on this handler above.
        const seed = Number(payload.seed) || 1;
        const foe = foeTeam(data, payload.format, evaluation.knownTeams, rollerFrom(seed));
        // A page cached from before the toggle existed played the closed sheet, which is what it
        // still gets -- and closed games are not rated, which is the right answer for a client
        // that does not know the rule.
        const game = new PlayGame(evaluation.playSolver, data, payload.format, library, { sheet: "closed" });
        const view = game.start({
          player: payload.team || [],
          foe: foeBring(data, payload.format, foe.sets),
          seed,
        });
        game.foeName = foe.name;
        const gameId = `g${id}`;
        keepGame(gameId, game);
        self.postMessage({ id, ok: true, result: { gameId, view: named(view), options: game.options(), foeName: foe.name } });
        return;
      }

      if (payload.action === "preview") {
        // The teams are dealt here and remembered, so the four you pick are brought against the
        // very team you were shown rather than against a fresh roll.
        const seed = Number(payload.seed) || 1;
        const foe = foeTeam(data, payload.format, evaluation.knownTeams, rollerFrom(seed));
        const previewId = `p${id}`;
        if (previews.size > 4) previews.delete(previews.keys().next().value);
        previews.set(previewId, { foe, seed, format: payload.format });
        self.postMessage({
          id,
          ok: true,
          result: {
            previewId,
            foeName: foe.name,
            foe: foe.sets.map((set) => previewMon(data, set)),
          },
        });
        return;
      }

      if (payload.action === "start") {
        const prep = previews.get(payload.previewId);
        if (!prep) {
          self.postMessage({ id, ok: true, result: { error: "Those teams are gone. Deal again." } });
          return;
        }
        const game = new PlayGame(evaluation.playSolver, data, payload.format, library,
          { sheet: payload.sheet === "closed" ? "closed" : "open" });
        // `payload.team` is the four you picked, in the order you picked them: the first
        // ACTIVE_BY_FORMAT of them lead and the rest wait behind, which is exactly what
        // PlayGame.start already means by the order of the list.
        const view = game.start({
          player: payload.team || [],
          foe: foeBring(data, payload.format, prep.foe.sets),
          seed: prep.seed,
        });
        game.foeName = prep.foe.name;
        const gameId = `g${id}`;
        keepGame(gameId, game);
        previews.delete(payload.previewId);
        self.postMessage({
          id,
          ok: true,
          // `sheet` comes back from the GAME rather than from the request, so the page shows what
          // is actually being played rather than what it asked for.
          result: { gameId, view: named(view), options: game.options(), foeName: prep.foe.name, sheet: game.sheet },
        });
        return;
      }

      const game = games.get(payload.gameId);
      if (!game) {
        self.postMessage({ id, ok: true, result: { error: "That game is over. Start a new one." } });
        return;
      }
      if (payload.action === "turn") {
        const options = game.options();
        const ourJoint = game.jointFrom(options, payload.chosen || []);
        progress({ stage: "thinking" });
        const { joint, thinking } = await game.chooseFoe({
          thinkMs: Math.max(300, Math.min(10000, Number(payload.thinkMs) || THINK_MS)),
          lookahead: Math.max(2, Math.min(12, Math.trunc(Number(payload.lookahead) || PLAY_LOOKAHEAD))),
          pool: Math.max(2, Math.min(32, Math.trunc(Number(payload.pool) || PLAY_POOL))),
        });
        const record = game.resolve(ourJoint, joint);
        const view = game.view();
        self.postMessage({
          id,
          ok: true,
          result: {
            view: named(view),
            options: view.over ? [] : game.options(),
            record,
            thinking: { played: thinking?.played || 0, pool: thinking?.pool || 0, seconds: thinking?.seconds || 0 },
          },
        });
        if (view.over) games.delete(payload.gameId);
        return;
      }
      if (payload.action === "resign") {
        games.delete(payload.gameId);
        self.postMessage({ id, ok: true, result: { resigned: true } });
        return;
      }
      self.postMessage({ id, ok: true, result: { error: "Unknown play action." } });
      return;
    }
    if (type === "solver") {
      // The Solver: one board, searched. Every line is played through the Tournament Test's turn
      // machinery, so the search runs here for the same reason that one does -- thousands of
      // damage calculations must not freeze the page. The board arrives as sets and numbers,
      // which is all structured clone can carry.
      const { data, evaluation } = await appEvaluation(payload.format, payload.settings);
      evaluation.knownTeams ||= await knownTeams();
      // The Solver gets a TournamentTest of its OWN, never the one the Tournament Test uses.
      // It replaces `rollHit` on the instance it is handed -- its playouts roll to hit and roll
      // the damage where the Tournament Test wants the expected share -- and an evaluator is
      // kept and reused across requests, so sharing one instance would leave random damage on
      // the next Test against Tournament Teams in this worker. That would move numbers the
      // recorded parity vectors pin, silently, and only after someone had opened the Solver.
      evaluation.solverTournament ||= new TournamentTest(evaluation, evaluation.knownTeams || new KnownTeams({ teams: [] }), new TeamSuggestions(evaluation));
      evaluation.solver ||= new Solver(evaluation.solverTournament);
      // A closed sheet is not one board but many: the sets are rolled, and the answer is the move
      // that does best across the possible boards rather than against one guess at theirs.
      const closed = payload.sheet === "closed";
      const pool = closed
        ? await possibleBoards(data, payload.format, payload.board,
          Math.max(2, Math.min(64, Math.trunc(Number(payload.pool) || 24))), Number(payload.seed) || 1)
        : null;
      try {
        const run = closed
          ? (options) => evaluation.solver.searchClosed(pool, options)
          : (options) => evaluation.solver.search(payload.board, options);
        result = await run({
          lookahead: payload.lookahead,
          iterations: Math.max(1, Number(payload.iterations) || 20000),
          seed: Number(payload.seed) || 1,
          // The run normally ends when its answer stops changing. These two are the walls
          // behind that: the deadline is the only one that bounds a board which never settles,
          // so it is kept even though it is no longer what usually ends the run.
          settleLines: Math.max(0, Math.trunc(Number(payload.settleLines) || 0)),
          deadline: Number(payload.seconds) > 0 ? Date.now() + Number(payload.seconds) * 1000 : 0,
          onProgress: (value) => progress(value),
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
