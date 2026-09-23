// Auto Build's deeper search. The app's own Auto Build is greedy: every open slot
// commits its first pick, and no two complete teams are ever compared (its deeper
// stages, V459 finalist sets and Phase-2 "Adjust against Meta", are switched off by
// V467 and V469). This module is the website's own search on top of the ported
// engine (builder/team-autobuild.js), in four steps:
//
//   anchor    the greedy path, unchanged (TeamAutoBuild.buildSlots' pieces): every
//             open slot screened in turn, one pick each. It warms the damage caches,
//             is always one of the compared teams and is the result when nothing
//             beats it - or when the build is stopped.
//   beam      the same slots again over a few partial teams at once. Every team keeps
//             the greedy pick and the next best candidates as children; the best
//             children across all teams go on (the anchor's own line always does).
//             Side branches screen a shortlist - the best candidates of the slot
//             before and of the anchor's screening of the same slot - instead of the
//             whole pool, and alternative picks try up to N sets (V449/V459, which the
//             app switched off) ranked by the app's structural key.
//   compare   every complete team goes through the same finish chain and the real
//             Team Evaluation. Another team replaces the anchor only when it wins on
//             the objective (beats(): red checks, yellow checks, a chosen archetype's
//             critical requirements, Prioritize Meta's Top X, then a materially better
//             score: the mean of the four scores minus a point per red threat).
//   repair    (Medium/Deep) one member Auto Build added may be swapped for the best
//             alternative the Auto Build ranking offers, under the same rule. Members
//             the user kept are never replaced.
//
// The work is bounded by counts (beam, children, shortlists, sets, repair sizes), so the
// same input gives the same team on a fast or a slow machine. The clock is only a safety
// cap (`capMs`, about twice what a cold Deep build needs in Node): when it cuts a step,
// result.search.capped says so.
//
// The run is async: it yields between chunks of about 0.1 s, so a worker can answer
// other requests and a Stop in between. The evaluator's per-move mode (V458, which
// screening needs) is switched on only inside those synchronous chunks, so nothing
// that runs between them sees it.

import { compact } from "./engine.js";
import { archetypeDisplay, topMetaSize } from "./autobuild-archetype.js";
import { archetypeRequirements } from "./team-checks.js";

const TEAM_SIZE = 6;
const MAX_DEFENSIVE_WARNINGS = 2;
const CHUNK_MS = 100;
const PROGRESS_MS = 120;

/**
 * Search sizes per depth - these, not the clock, bound the work. `depth` is the greedy
 * profile the anchor runs (pool budget and finalists, AUTO_BUILD_PROFILES); `beam` teams
 * go on per slot (the anchor's line included), each with up to `children` picks for the
 * first `widenLevels` open slots and only its greedy pick after that; side branches screen
 * `shortlist` candidates while the beam widens and `narrow` once it only finishes its
 * lines; alternative picks try `finalistSets` sets; the repair swaps one of
 * `repairTargets` added members for one of `repairCandidates` alternatives out of
 * `repairPool`. `capMs` is only a safety cap on the whole run (see run()).
 */
export const SEARCH_PROFILES = {
  fast: { key: "fast", depth: "fast", beam: 2, children: 2, widenLevels: 6, shortlist: 30, narrow: 15, finalistSets: 1, repairTargets: 0, repairCandidates: 0, repairPool: 0, capMs: 24000 },
  medium: { key: "medium", depth: "medium", beam: 3, children: 3, widenLevels: 6, shortlist: 40, narrow: 20, finalistSets: 2, repairTargets: 2, repairCandidates: 4, repairPool: 60, capMs: 44000 },
  // Deep's shortlist and repair were cut from 60 / 3 targets / 6 of 100 after a cold build of
  // an empty team took 45-54 s in Node, and on nine warm test builds the kept teams scored no
  // worse (4 better, 5 the same). The sizes have stood since: when the times crept back up
  // (66 s cold in Node on 2026-09-23) the work came off builder/engine.js instead, whose
  // name normalisers, Mega / form lookups and per-move `move_meta` base are now memoised -
  // 41 s cold for the same compared teams and the same scores.
  deep: { key: "deep", depth: "deep", beam: 4, children: 3, widenLevels: 6, shortlist: 45, narrow: 20, finalistSets: 3, repairTargets: 2, repairCandidates: 5, repairPool: 80, capMs: 66000 },
};

/**
 * The objective for complete teams, compared in order (beats()): failing enabled checks
 * (red, then yellow), unmet critical requirements of a chosen archetype, with Prioritize
 * Meta the members Auto Build added from outside the Top X, then
 * T = mean(Synergy, Offense, Defense, Speed) - redThreatWeight x red threats.
 * Another team replaces the anchor on T only when it is at least `margin` higher.
 */
export const SEARCH_OBJECTIVE = { redThreatWeight: 1.0, margin: 1.0, redThreat: 70, yellowThreat: 45 };

const valid = (entry) => Boolean(entry && String(entry.pokemon || "").trim());
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
const r1 = (value) => Math.round((Number(value) || 0) * 10) / 10;
const rowId = (row) => String(row?.check_id || row?.kind || "").trim();
const severity = (row) => String(row?.severity || "good").toLowerCase();

function compareKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === "string" || typeof y === "string") return String(x) < String(y) ? -1 : 1;
    return (x ?? 0) - (y ?? 0);
  }
  return 0;
}

function sortBy(list, keyOf) {
  return list.map((item, i) => [item, keyOf(item), i]).sort(([, a, ia], [, b, ib]) => compareKeys(a, b) || ia - ib).map(([item]) => item);
}

/** A copy of a branch's forcing state; the archetype helper is shared, the log is not. */
function cloneState(state) {
  return { ...state, log: [...(state.log || [])] };
}

/** The complete set objects a team's entries and spreads make (the builder's set shape). */
export function teamSets(entries, spreads) {
  return entries.map((entry, i) => (valid(entry) ? {
    species: entry.pokemon, form: entry.form || entry.pokemon, item: entry.item || "", ability: entry.ability || "", moves: (entry.moves || []).slice(0, 4),
    nature: spreads[i]?.nature_name || spreads[i]?.name || "Serious", bonuses: [...(spreads[i]?.bonuses || [0, 0, 0, 0, 0, 0])],
  } : null));
}

/**
 * The Team Evaluation numbers a complete team is judged by (kept small; the full payload
 * is 1 MB+). `metaOutside` is the number of members Auto Build added from outside the
 * Top X meta (counted only with Prioritize Meta; 0 otherwise).
 */
export function teamSummary(payload, manualKey = "", objective = SEARCH_OBJECTIVE, { metaOutside = 0 } = {}) {
  const rows = (payload?.checks?.rows || []).filter((row) => !["archetype_fit", "checks_disabled"].includes(rowId(row)));
  const scores = {
    synergy: Number(payload?.synergy_score) || 0, offense: Number(payload?.offense_score) || 0,
    defense: Number(payload?.defense_score) || 0, speed: Number(payload?.speed?.score) || 0,
  };
  const threatScores = (payload?.threats || []).map((t) => Number(t.score) || 0);
  const threatsRed = threatScores.filter((s) => s >= objective.redThreat).length;
  const threatsYellow = threatScores.filter((s) => s >= objective.yellowThreat && s < objective.redThreat).length;
  let archetypeUnmet = 0;
  if (manualKey && payload?.features) {
    try {
      archetypeUnmet = archetypeRequirements(manualKey, payload.features).filter((req) => req && req.critical && !req.met).length;
    } catch {
      archetypeUnmet = 0;
    }
  }
  const mean = (scores.synergy + scores.offense + scores.defense + scores.speed) / 4;
  return {
    scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, r1(v)])),
    checksRed: rows.filter((row) => severity(row) === "red").length,
    checksYellow: rows.filter((row) => severity(row) === "yellow").length,
    failing: rows.filter((row) => ["red", "yellow"].includes(severity(row))).map((row) => ({ id: rowId(row), label: String(row.check_label || rowId(row)), severity: severity(row) })),
    threatsRed, threatsYellow, critical: threatScores.length, archetypeUnmet, metaOutside: Number(metaOutside) || 0,
    mean: r1(mean), T: Number((mean - objective.redThreatWeight * threatsRed).toFixed(3)),
  };
}

/** One member Auto Build added, as the page shows it ("Why it was added"): no engine objects. */
export function additionForPage(addition) {
  const row = addition?.row || {};
  const details = (row.details || []).slice(0, 5);
  const severities = row._v104_detail_severities || {};
  return {
    slot: addition.slot, name: addition.name, score: addition.score, swapped: addition.swapped || "",
    answers: row.answers || [], details, severities: Object.fromEntries(details.map((text) => [String(text).toLowerCase(), severities[String(text).toLowerCase()] || "neutral"])),
    components: row.suggestion_score_components_v318 || null, ledger: row.score_ledger || null, found_in_team: row.found_in_team_v496 || "",
  };
}

/** The tiers beats() compares, in order (T, the score, last and only by `margin`). */
export const OBJECTIVE_TIERS = ["checksRed", "checksYellow", "archetypeUnmet", "metaOutside"];

/**
 * Whether team `a` should replace team `b`: red checks, then yellow checks, then a chosen
 * archetype's unmet critical requirements, then (Prioritize Meta) added members outside
 * the Top X - fewer wins each - and only when all of those tie, T by at least `margin`.
 */
export function beats(a, b, margin = SEARCH_OBJECTIVE.margin) {
  if (!b) return true;
  if (!a) return false;
  for (const tier of OBJECTIVE_TIERS) {
    const x = Number(a[tier]) || 0;
    const y = Number(b[tier]) || 0;
    if (x !== y) return x < y;
  }
  return a.T >= b.T + margin;
}

/** The tier on which `a` differs from `b` first ("T" when only the score does, "" when nothing does). */
export function beatReason(a, b) {
  if (!a || !b) return "";
  for (const tier of OBJECTIVE_TIERS) if ((Number(a[tier]) || 0) !== (Number(b[tier]) || 0)) return tier;
  return a.T !== b.T ? "T" : "";
}

export class AutoBuildSearch {
  /**
   * @param {import("./team-autobuild.js").TeamAutoBuild} builder
   * @param {object} profiles  AUTO_BUILD_PROFILES (the greedy pool budgets and finalists)
   */
  constructor(builder, profiles) {
    this.b = builder;
    this.profiles = profiles;
    this.sg = builder.sg;
    this.ev = builder.ev;
    this.evaluation = builder.evaluation;
    this.objective = SEARCH_OBJECTIVE;
  }

  // --- bookkeeping ------------------------------------------------------------------

  elapsed() {
    return now() - this.started;
  }

  stopped() {
    if (!this.stopRequested && this.shouldStop?.()) this.stopRequested = true;
    return this.stopRequested;
  }

  /**
   * The safety cap: past `capMs` the step `step` (branches, compare, repair) is skipped and
   * recorded, so a run the cap cut can be told apart from a reproducible one.
   */
  capped(step) {
    if (this.elapsed() <= this.capMs) return false;
    this.cut[step] = true;
    return true;
  }

  /** Whether a screened row is outside the Top X meta while Prioritize Meta is on (V462's mark). */
  outsideMeta(row, entry = null) {
    const keys = this.metaKeys;
    if (!keys?.size) return false;
    if (typeof row?.prioritized_meta_member_v462 === "boolean") return !row.prioritized_meta_member_v462;
    const names = [row?.name, row?.base_name, entry?.pokemon, entry?.form].filter(Boolean);
    return !names.some((name) => keys.has(compact(name)) || keys.has(compact(this.ev.baseSpeciesFromDisplay(String(name)))));
  }

  /** Members Auto Build added from outside the Top X (Prioritize Meta's tier of the objective). */
  metaOutside(additions) {
    if (!this.metaKeys?.size) return 0;
    return (additions || []).filter((a) => this.outsideMeta(a.row, a.entry)).length;
  }

  /**
   * Screens candidates in chunks of about CHUNK_MS, yielding in between; per-move mode is
   * on only inside a chunk. Returns the rows scored so far and whether it was stopped.
   */
  async screen(prepared, onCandidate = null) {
    const rows = [];
    const { candidates, context } = prepared;
    let i = 0;
    while (i < candidates.length) {
      if (this.stopped()) return { rows, stopped: true };
      const start = now();
      this.ev.perMoveAttacks = true;
      try {
        while (i < candidates.length) {
          const meta = candidates[i];
          const row = this.b.screenCandidate(meta, context);
          if (row) {
            row._search_meta_name = meta.name;
            rows.push(row);
          }
          i += 1;
          onCandidate?.(i, candidates.length, meta.name);
          if (now() - start > CHUNK_MS) break;
        }
      } finally {
        this.ev.perMoveAttacks = false;
      }
      this.stats.chunks += 1;
      await tick();
    }
    this.stats.screenings += 1;
    return { rows, stopped: false };
  }

  /** The finish filter run on a scratch state, so its log line and cap can go to every child. */
  filtered(rows) {
    const scratch = { log: [], overCap: 0 };
    return { ranked: this.b.finishFilter(rows, scratch), scratch };
  }

  applyScratch(state, scratch) {
    if (scratch?.overCap) state.overCap = scratch.overCap;
    if (scratch?.log?.length) state.log.push(...scratch.log);
    return state;
  }

  /** Candidate rows by the hard checks, the archetype, Prioritize Meta, check pressure, then score (not cut to 14). */
  searchOrder(rows) {
    const manual = rows.some((row) => row._manual_archetype_v477);
    return sortBy(rows, (row) => [
      (Number(row.defensive_switch_warning_count) || 0) > MAX_DEFENSIVE_WARNINGS ? 1 : 0,
      row._hard_red_checks_v472 ?? 999, row._hard_yellow_checks_v472 ?? 999,
      row.counter_archetype_speed_control_v466 ? 1 : 0,
      manual ? row._archetype_critical_unmet_v477 ?? 999 : 0,
      this.outsideMeta(row) ? 1 : 0,
      Number(Number(row._hard_check_pressure_v472 ?? 9999).toFixed(4)),
      -(Number(row.score) || 0), Number(row.position) || 999999,
    ]);
  }

  /** The app's _v459_structural_key with V464's band (the finalist-set ranking it switched off). */
  structuralKey(row) {
    const check = row._auto_build_check_sort_v433 || [999, 9999, 999, 9999];
    const threat = Number(row.threat_component) || 0;
    const band = threat >= 72 ? 0 : threat >= 60 ? 1 : threat >= 48 ? 2 : threat >= 36 ? 3 : 4;
    const round = (v, n) => Number((Number(v) || 0).toFixed(n));
    return [
      Number(check[0]) || 0, Number(check[2]) || 0, band, -(Number(row.urgent_meta_answers_v464) || 0), -round(threat, 4), round(check[1], 5),
      -round(row.archetype_component_v429 ?? 50, 5), -round(row.synergy_component ?? 50, 5), -round(row.speed_component ?? 50, 5),
      -round(row.score, 5), Number(row.position) || 999999, String(row.name || ""),
    ];
  }

  /** Up to `limit` sets of an alternative pick (V449 beam, Item Clause), the best by the structural key. */
  bestSet(row, context, limit) {
    if (limit <= 1) return row;
    const meta = row._candidate_meta_v378;
    if (!meta) return row;
    let best = row;
    let bestKey = this.structuralKey(row);
    this.ev.perMoveAttacks = true;
    try {
      const sets = this.sg.nonconflictingSets(structuredClone(meta), context).slice(0, limit);
      for (const set of sets) {
        const tried = this.sg.evaluateCandidate(this.sg.metaWithSet(structuredClone(meta), set), context);
        if (!tried || !(tried.score > 0) || tried._finish_filter_misses) continue;
        const applied = this.sg.applySetFields(tried, set);
        applied._search_meta_name = row._search_meta_name;
        const key = this.structuralKey(applied);
        if (compareKeys(key, bestKey) < 0) [best, bestKey] = [applied, key];
      }
    } catch {
      // keep the representative set
    } finally {
      this.ev.perMoveAttacks = false;
    }
    return best;
  }

  seedMean(seed) {
    const value = (v) => (Number.isFinite(Number(v)) ? Number(v) : 50);
    return (value(seed.synergy_score) + value(seed.offense_score) + value(seed.defense_score) + value(seed.speed?.score)) / 4;
  }

  /**
   * A key that compares partial teams across parents: the pick's hard checks, the members
   * added so far from outside the Top X (Prioritize Meta only), then the projected scores.
   */
  childKey(row, seed, manual, outside = 0) {
    return [
      (Number(row.defensive_switch_warning_count) || 0) > MAX_DEFENSIVE_WARNINGS ? 1 : 0,
      row._hard_red_checks_v472 ?? 999, row._hard_yellow_checks_v472 ?? 999,
      manual ? row._archetype_critical_unmet_v477 ?? 999 : 0,
      outside,
      Number(Number(row._hard_check_pressure_v472 ?? 9999).toFixed(2)),
      -Number(this.seedMean(seed).toFixed(3)),
    ];
  }

  teamKey(entries) {
    return entries.filter(valid).map((e) => compact(e.form || e.pokemon)).sort().join("|");
  }

  /** A child team: the parent with `row` in the open slot. */
  child(node, screened, row, state, ctx, { alternative = false } = {}) {
    const next = this.b.applyPick(node, screened.slotIndex, row, ctx.selection);
    if (alternative) {
      // The forcing (V494) follows the team this branch actually has.
      state.megaNeeded = this.b.megaStoneSlots(next.entries).length === 0;
      Object.assign(state, ctx.chosen.forcing(next.entries.filter(valid)));
    }
    this.ids += 1;
    const outside = (node.outside || 0) + (this.outsideMeta(row) ? 1 : 0);
    return {
      id: this.ids, parent: node.id, anchor: false, entries: next.entries, spreads: next.spreads, seed: next.seed, state,
      additions: [...node.additions, next.addition], path: [...node.path, row.name], ranked: screened.ranked, outside,
      key: this.childKey(row, next.seed, ctx.manual, outside),
    };
  }

  /**
   * The candidates a side branch screens: the best of its parent's screening (the slot
   * before) and of the anchor's screening of this slot, plus the Megas and archetype
   * specialists the full pool would reserve.
   */
  shortlist(node, level, ctx, size = ctx.search.shortlist) {
    const b = this.b;
    const slots = b.slotsFor(node.entries, node.spreads);
    const activeNames = b.names(slots);
    const pool = b.slotPool(ctx.shared.frozen, slots, activeNames, ctx.profile, ctx.shared.options);
    const wanted = new Set();
    for (const source of [node.ranked || [], level?.ranked || []]) {
      for (const row of this.searchOrder(source)) {
        if (wanted.size >= size) break;
        wanted.add(compact(row._search_meta_name || row.name));
      }
    }
    const megaWanted = b.checks.megaCount(slots)[0] <= 0;
    let megas = 0;
    return pool.filter((row) => {
      if (wanted.has(compact(row.name))) return true;
      if (row.archetype_anchor_reserved_v477) return true;
      if (megaWanted && megas < 3 && b.isMegaCandidate(row)) {
        megas += 1;
        return true;
      }
      return false;
    });
  }

  /** A node's children: its greedy pick, then (while the beam still widens) the next best rows. */
  children(node, screened, ctx, { anchorChild = null, widen = true } = {}) {
    const out = [];
    const taken = new Set();
    if (anchorChild) {
      out.push(anchorChild);
      taken.add(compact(anchorChild.pick._search_meta_name || anchorChild.pick.name));
    } else if (!node.anchor) {
      const state = this.applyScratch(cloneState(node.state), screened.scratch);
      const best = this.b.pickFromRanked(screened.ranked, ctx.profile, state);
      if (best) {
        const child = this.child(node, screened, best, state, ctx);
        out.push(child);
        taken.add(compact(best._search_meta_name || best.name));
      }
    }
    if (!widen) return out;
    const ordered = [...this.b.order(screened.ranked.map((row) => ({ ...row }))), ...this.searchOrder(screened.ranked)];
    for (const row of ordered) {
      if (out.length >= ctx.search.children) break;
      const k = compact(row._search_meta_name || row.name);
      if (taken.has(k)) continue;
      taken.add(k);
      let pick = this.b.representative(structuredClone(row));
      pick._search_meta_name = row._search_meta_name;
      pick = this.bestSet(pick, screened.context, ctx.search.finalistSets);
      const state = this.applyScratch(cloneState(node.state), screened.scratch);
      out.push(this.child(node, screened, pick, state, ctx, { alternative: true }));
    }
    return out;
  }

  /**
   * The anchor's line always, then the best children by key, no team twice and at most
   * half the beam per lineage (the first pick a branch made). Capping by parent alone let
   * the greedy line's own siblings - best by construction on the per-slot key - crowd out
   * every other first pick, and the beam ended with near-copies of the anchor.
   */
  select(children, beam) {
    const kept = [];
    const seen = new Set();
    const perLineage = new Map();
    const cap = Math.max(1, Math.ceil(beam / 2));
    const lineage = (c) => compact(c.path[0] || "");
    const take = (c) => {
      kept.push(c);
      seen.add(this.teamKey(c.entries));
      perLineage.set(lineage(c), (perLineage.get(lineage(c)) || 0) + 1);
    };
    const anchor = children.find((c) => c.anchor);
    if (anchor) take(anchor);
    for (const c of sortBy(children.filter((x) => !x.anchor), (x) => x.key)) {
      if (kept.length >= beam) break;
      if (seen.has(this.teamKey(c.entries)) || (perLineage.get(lineage(c)) || 0) >= cap) continue;
      take(c);
    }
    // A lineage cap that leaves places empty gives them back to the best of the rest.
    for (const c of sortBy(children.filter((x) => !x.anchor), (x) => x.key)) {
      if (kept.length >= beam) break;
      if (!seen.has(this.teamKey(c.entries))) take(c);
    }
    return kept;
  }

  /** Fills what is left of a stopped build from the first dozen candidates per slot. */
  quickFill(node, ctx, partial = null) {
    const b = this.b;
    let current = node;
    let rows = partial;
    for (let guard = 0; guard < TEAM_SIZE; guard += 1) {
      const slotIndex = current.entries.findIndex((e) => !valid(e));
      if (slotIndex < 0) break;
      const slots = b.slotsFor(current.entries, current.spreads);
      const pool = b.slotPool(ctx.shared.frozen, slots, b.names(slots), { ...ctx.profile, budget: 12 }, ctx.shared.options);
      const prepared = b.prepareSlot(current, ctx.shared, { candidates: pool });
      if (!rows || !rows.length) {
        rows = [];
        this.ev.perMoveAttacks = true;
        try {
          for (const meta of prepared.candidates) {
            const row = b.screenCandidate(meta, prepared.context);
            if (row) rows.push(row);
          }
        } finally {
          this.ev.perMoveAttacks = false;
        }
      }
      const state = cloneState(current.state);
      const best = b.pickFromRanked(b.finishFilter(rows, state), { ...ctx.profile, finalists: 1 }, state);
      rows = null;
      if (!best) return null;
      const next = b.applyPick(current, slotIndex, best, ctx.selection);
      current = { ...current, entries: next.entries, spreads: next.spreads, seed: next.seed, state, additions: [...current.additions, next.addition], path: [...current.path, best.name] };
    }
    return current;
  }

  /**
   * The finish chain and the real Team Evaluation of one complete team. `quick` (a build
   * stopped before its first team was complete) runs only the rule-keeping finish steps
   * and no evaluation, so Stop answers within about a second even on a cold start.
   */
  judge(leaf, ctx, label, { quick = false } = {}) {
    const b = this.b;
    const entries = leaf.entries.map((e) => ({ ...e, moves: [...(e.moves || [])] }));
    const spreads = leaf.spreads.map((s) => (s ? { ...s, bonuses: [...(s.bonuses || [])] } : null));
    const log = [...(leaf.state?.log || [])];
    // team_build_constraints.validate_completed_team, as runGreedy checks it.
    const warnings = b.defensiveWarnings(b.slotsFor(entries, spreads));
    if (!quick && warnings > MAX_DEFENSIVE_WARNINGS && !leaf.state?.overCap) {
      return { leaf, label, error: `Auto Build could not finish with at most ${MAX_DEFENSIVE_WARNINGS} defensive switch-in warnings (${warnings} remain). Broaden the candidate pool or free another slot.` };
    }
    // userSlots: the members the user kept, left as written unless a finish step changed them.
    b.finish(entries, spreads, log, () => {}, { anchorArchetype: ctx.options.anchorArchetype, box: ctx.box, archetype: ctx.manual, quick, userSlots: ctx.kept });
    const sets = teamSets(entries, spreads);
    if (quick) return { leaf, label, entries, spreads, log, sets, payload: null, summary: null, quick: true };
    const payload = this.evaluation.evaluate(sets, { checkSelection: ctx.selection });
    this.stats.teams += 1;
    return { leaf, label, entries, spreads, log, sets, payload, summary: teamSummary(payload, ctx.manual, this.objective, { metaOutside: this.metaOutside(leaf.additions) }) };
  }

  // --- the run ----------------------------------------------------------------------

  async run(sets, {
    selection = null, depth = "deep", cachedPayload = null, cachedScores = null, onlyBox = false, box = [], optimizeStats = false,
    archetype = "automatic", teamArchetype = "", prioritizeMeta = false, onProgress, shouldStop = null,
  } = {}) {
    const b = this.b;
    const search = SEARCH_PROFILES[depth] || SEARCH_PROFILES.deep;
    const profile = this.profiles[search.depth] || this.profiles.medium;
    this.started = now();
    this.shouldStop = shouldStop;
    this.stopRequested = false;
    this.ids = 0;
    this.stats = { screenings: 0, chunks: 0, teams: 0 };
    // The safety cap and where it cut the search short (a run it did not cut is reproducible).
    this.capMs = Number(search.capMs) || Infinity;
    this.cut = { branches: false, compare: false, repair: false };
    let lastProgress = -Infinity;
    const progress = (fraction, message, force = false) => {
      const t = now();
      if (!force && t - lastProgress < PROGRESS_MS) return;
      lastProgress = t;
      onProgress?.(Math.max(0, Math.min(1, fraction)), message);
    };

    // Preflight, exactly as runGreedy.
    const entries = Array.from({ length: TEAM_SIZE }, (_, i) => b.entryFromSet(sets[i]));
    const spreads = Array.from({ length: TEAM_SIZE }, (_, i) => (sets[i]?.species ? { nature_name: sets[i].nature || "Serious", bonuses: [...(sets[i].bonuses || [0, 0, 0, 0, 0, 0])] } : null));
    const log = b.finalizeExisting(entries, spreads);
    const selected = b.checks.selectedIds(selection);
    const startEntries = entries.filter(valid).map((e) => ({ ...e }));
    const kept = entries.map((e, i) => (valid(e) ? i : -1)).filter((i) => i >= 0);
    const slots = b.slotsFor(entries, spreads);
    const { manual, chosen, options } = b.runOptions(entries, slots, { archetype, teamArchetype, prioritizeMeta });
    // Prioritize Meta's Top X, for its tier of the search order and the objective.
    this.metaKeys = options.metaKeys?.size ? options.metaKeys : null;
    this.metaTop = this.metaKeys ? topMetaSize(this.ev) : 0;
    const state = { megaNeeded: b.megaStoneSlots(entries).length === 0, log, archetype: chosen, ...chosen.forcing(entries.filter(valid)) };
    const seed = b.seedPayload(slots, selection, cachedScores ? { ...cachedScores, slots } : cachedPayload);
    const frozen = onlyBox ? b.boxPool(box, b.names(slots)) : b.frozenPool(b.names(slots));
    const label = manual ? archetypeDisplay(manual) : "";
    const base = { archetype: label, compared: [], search: null, payload: null };
    if (onlyBox && !frozen.length) return { ...base, entries, spreads, additions: [], log, error: "Your Box has no Pokémon that are not already on the team." };
    const shared = { selection, selected, profile, frozen, startEntries, options };
    const ctx = { search, profile, shared, selection, manual, chosen, options, box, kept };
    const open = entries.filter((e) => !valid(e)).length;
    const root = { id: 0, parent: -1, anchor: true, entries, spreads, seed, state, additions: [], path: [], ranked: null };

    // 1. The anchor: the greedy path, one screening per open slot.
    const levels = [];
    const line = [root];
    let node = root;
    let anchorError = "";
    for (let d = 0; d < open; d += 1) {
      const prepared = b.prepareSlot(node, shared);
      if (!prepared) break;
      const screened = await this.screen(prepared, (i, total, name) => progress(((d + i / total) / open) * 0.4, `Building slot ${d + 1}/${open}: screening ${i}/${total} · ${name}`));
      if (screened.stopped) {
        // Stopped before the first team was complete: the rest comes from a quick fill.
        const filled = this.quickFill(node, ctx, screened.rows);
        return this.finalize(filled ? [this.judge(filled, ctx, "anchor", { quick: true })] : [], null, ctx, { stoppedEarly: true, error: filled ? "" : "Auto Build was stopped before it had a team." });
      }
      const { ranked, scratch } = this.filtered(screened.rows);
      const stateNext = this.applyScratch(cloneState(node.state), scratch);
      const best = b.pickFromRanked(ranked, profile, stateNext);
      levels.push({ ...prepared, ranked, scratch, pick: best });
      if (!best) {
        anchorError = "Auto Build did not find a structurally fitting Pokemon for an empty slot.";
        break;
      }
      best._search_meta_name ||= ranked.find((row) => compact(row.name) === compact(best.name))?._search_meta_name || best.name;
      const next = b.applyPick(node, prepared.slotIndex, best, selection);
      const outside = (node.outside || 0) + (this.outsideMeta(best) ? 1 : 0);
      node = {
        id: -(d + 1), parent: node.id, anchor: true, entries: next.entries, spreads: next.spreads, seed: next.seed, state: stateNext,
        additions: [...node.additions, next.addition], path: [...node.path, best.name], ranked, pick: best, outside, key: this.childKey(best, next.seed, manual, outside),
      };
      line.push(node);
      progress(((d + 1) / open) * 0.4, `Built slot ${d + 1}/${open}: ${best.name}`, true);
    }
    const judged = [];
    let leader = null;
    if (!anchorError && line.length === open + 1) {
      progress(0.42, "Finishing the first team and running its Team Evaluation", true);
      await tick();
      const anchor = this.judge(line[open], ctx, "anchor");
      judged.push(anchor);
      if (!anchor.error) leader = anchor;
    }

    // 2. The beam over partial teams. Its size is fixed by the profile's counts: every
    // side branch screens its shortlist and the beam widens for `widenLevels` slots, so
    // the same input always searches the same teams. Only the safety cap may drop the
    // remaining side branches (recorded in search.cut).
    let beamLeaves = [];
    if (open > 0 && search.beam > 1 && !this.stopped()) {
      let nodes = [root];
      for (let d = 0; d < open && nodes.length; d += 1) {
        const widen = d < search.widenLevels;
        const children = [];
        for (const current of nodes) {
          if (this.stopped()) break;
          let screened;
          if (current.anchor) {
            if (!levels[d]) continue;
            screened = levels[d];
          } else {
            if (this.capped("branches")) continue;
            const prepared = b.prepareSlot(current, shared, { candidates: this.shortlist(current, levels[d], ctx, widen ? search.shortlist : search.narrow) });
            if (!prepared) continue;
            const done = await this.screen(prepared, (i, total, name) => progress(0.45 + ((d + (i / total)) / open) * 0.3, `Trying other picks for slot ${d + 1}: ${name}`));
            if (done.stopped) break;
            screened = { ...prepared, ...this.filtered(done.rows) };
          }
          const anchorChild = current.anchor && line[d + 1] ? line[d + 1] : null;
          children.push(...this.children(current, screened, ctx, { anchorChild, widen }));
        }
        if (this.stopped()) break;
        nodes = this.select(children, search.beam);
        progress(0.45 + ((d + 1) / open) * 0.3, `Trying other picks: slot ${d + 1}/${open} done, ${nodes.length} teams kept`, true);
      }
      if (!this.stopped()) beamLeaves = nodes.filter((n) => !n.anchor && n.entries.every(valid));
    }

    // 3. Every complete team through the finish chain and the Team Evaluation.
    for (const [k, leaf] of beamLeaves.entries()) {
      if (this.stopped()) break;
      // The best alternative is always judged; the rest unless the safety cap has passed.
      if (leader && k > 0 && this.capped("compare")) break;
      progress(0.75 + (k / Math.max(1, beamLeaves.length)) * 0.15, `Comparing complete teams ${k + 1}/${beamLeaves.length}`, true);
      await tick();
      const result = this.judge(leaf, ctx, "alternative");
      judged.push(result);
      if (result.error) continue;
      // The anchor keeps its place unless another team is materially better.
      if (!leader || beats(result.summary, leader.summary, leader.label === "anchor" ? this.objective.margin : 0.001)) leader = result;
    }

    // 4. The repair: one added member swapped, when the Team Evaluation says so.
    if (leader && search.repairTargets > 0 && !this.stopped() && !this.capped("repair")) {
      const repaired = await this.repair(leader, ctx, progress);
      if (repaired) {
        judged.push(repaired);
        leader = repaired;
      }
    }
    return this.finalize(judged, leader, ctx, { error: anchorError, optimizeStats, progress });
  }

  /**
   * One pass over the members Auto Build added (`repairTargets` of them, two at Medium and Deep): each is
   * screened as a swap with the Auto Build ranking, the best alternatives are finished
   * and evaluated, and the best one replaces the member if it beats the team.
   */
  async repair(leader, ctx, progress) {
    const b = this.b;
    const leaf = leader.leaf;
    const added = new Set((leaf.additions || []).map((a) => a.slot));
    if (!added.size) return null;
    const slots = b.slotsFor(leaf.entries, leaf.spreads);
    if (slots.length < TEAM_SIZE) return null;
    const teamEntries = slots.map((s) => s.entry);
    const activeNames = b.names(slots);
    const problems = (leaf.seed.checks?.rows || []).filter((row) => ["red", "yellow"].includes(severity(row)));
    const targets = sortBy([...added], (slot) => [-this.sg.problemSlotScore(b.checks.profile(slots[slot].entry, slots[slot].mon), problems), slot]).slice(0, ctx.search.repairTargets);
    const found = [];
    for (const [n, slot] of targets.entries()) {
      if (this.stopped()) return null;
      const target = teamEntries[slot].pokemon;
      const others = slots.filter((_, i) => i !== slot);
      const pool = b.slotPool(ctx.shared.frozen, others, activeNames, { ...ctx.profile, budget: ctx.search.repairPool || ctx.profile.budget }, ctx.shared.options)
        .filter((row) => this.sg.speciesId(row.name || row.form || row.base_name) !== this.sg.speciesId(target));
      const context = {
        payload: leaf.seed, teamSlots: slots, teamEntries, activeNames, emptySlot: null, selection: ctx.selection, selected: ctx.shared.selected,
        swapTarget: target, autoBuild: true, fieldEntries: ctx.shared.startEntries, ...ctx.shared.options,
      };
      const done = await this.screen({ candidates: pool, context }, (i, total, name) => progress(0.9 + ((n + i / total) / targets.length) * 0.03, `Checking one swap for ${target}: ${name}`));
      if (done.stopped) return null;
      const { ranked } = this.filtered(done.rows);
      for (const row of this.b.order(ranked.map((r) => ({ ...r }))).slice(0, ctx.search.repairCandidates)) found.push([slot, row]);
    }
    // With Prioritize Meta, the Top X alternatives are tried first (the objective's tier).
    const tries = sortBy(found, ([, row]) => [
      row._hard_red_checks_v472 ?? 999, row._hard_yellow_checks_v472 ?? 999, this.outsideMeta(row) ? 1 : 0,
      Number(Number(row._hard_check_pressure_v472 ?? 9999).toFixed(4)), -(Number(row.score) || 0),
    ]).slice(0, ctx.search.repairCandidates);
    let best = null;
    for (const [k, [slot, row]] of tries.entries()) {
      if (this.stopped()) break;
      if (this.capped("repair")) break;
      progress(0.93 + (k / Math.max(1, tries.length)) * 0.04, `Checking one swap: ${teamEntries[slot].pokemon} for ${row.name} (${k + 1}/${tries.length})`, true);
      await tick();
      const pick = b.representative(structuredClone(row));
      // the team it joins (without the member it replaces): what its guaranteed moves are judged on
      const [entry, spread] = b.completeSelected(pick, leaf.entries.filter((e, i) => i !== slot && valid(e)));
      const entries = [...leaf.entries];
      const spreads = [...leaf.spreads];
      entries[slot] = entry;
      spreads[slot] = spread;
      const additions = leaf.additions.map((a) => (a.slot === slot ? { slot, entry, spread, score: pick.score, name: pick.name, row: pick, swapped: leaf.entries[slot].form || leaf.entries[slot].pokemon } : a));
      const swapped = { ...leaf, id: -100 - k, entries, spreads, additions, path: [...leaf.path, `swap ${pick.name}`] };
      const result = this.judge(swapped, ctx, "swap");
      if (result.error) continue;
      result.swap = { slot, out: leaf.entries[slot].form || leaf.entries[slot].pokemon, in: pick.name };
      if (beats(result.summary, (best || leader).summary, best ? 0.001 : this.objective.margin)) best = result;
    }
    if (!best) return null;
    const a = leader.summary;
    const z = best.summary;
    const moved = ["synergy", "offense", "defense", "speed"].filter((k) => Math.abs(z.scores[k] - a.scores[k]) >= 0.5).map((k) => `${k[0].toUpperCase()}${k.slice(1)} ${a.scores[k]} → ${z.scores[k]}`);
    best.log.push(`Swapped ${best.swap.out} for ${best.swap.in}: ${[
      ...moved, `red threats ${a.threatsRed} → ${z.threatsRed}`,
      z.checksRed !== a.checksRed || z.checksYellow !== a.checksYellow ? `failing checks ${a.checksRed + a.checksYellow} → ${z.checksRed + z.checksYellow}` : "",
      z.archetypeUnmet !== a.archetypeUnmet ? `unmet critical archetype requirements ${a.archetypeUnmet} → ${z.archetypeUnmet}` : "",
      z.metaOutside !== a.metaOutside ? `added from outside the Top ${this.metaTop} Meta ${a.metaOutside} → ${z.metaOutside}` : "",
    ].filter(Boolean).join(", ")}.`);
    return best;
  }

  /** Why the chosen team replaced the anchor, as one sentence of the log (the tier beats() decided on). */
  replacedBecause(chosen, anchor, archetype) {
    const reason = beatReason(chosen, anchor);
    if (reason === "checksRed") return "fails fewer red Team Building Checks";
    if (reason === "checksYellow") return "fails as many red and fewer yellow Team Building Checks";
    if (reason === "archetypeUnmet") return `fails as many Team Building Checks and misses fewer critical ${archetype || "archetype"} requirements`;
    if (reason === "metaOutside") return `fails as many Team Building Checks and adds fewer Pokémon from outside the Top ${this.metaTop} Meta`;
    const gain = Math.round((chosen.T - anchor.T) * 10) / 10;
    return `fails as many Team Building Checks and scores ${gain.toFixed(1)} points more (the average of the four scores, minus 1 per threat at 70 or more)`;
  }

  /** The chosen team as the result, with every compared team summarised. */
  finalize(judged, leader, ctx, { stoppedEarly = false, error = "", optimizeStats = false, progress = () => {} } = {}) {
    const b = this.b;
    const chosen = leader || judged.find((j) => !j.error) || null;
    const anchor = judged.find((j) => j.label === "anchor" && !j.error) || null;
    const compared = judged.filter((j) => !j.error && j.summary).map((j) => ({
      key: this.teamKey(j.entries), label: j.label, chosen: j === chosen, anchor: j.label === "anchor",
      members: j.entries.map((e, i) => (valid(e) ? { species: e.pokemon, form: e.form, item: e.item, added: !ctx.kept.includes(i) } : null)).filter(Boolean),
      sets: j.sets, summary: j.summary, swap: j.swap || null,
    }));
    const search = {
      profile: ctx.search.key, teams: compared.length, screenings: this.stats.screenings, seconds: Number((this.elapsed() / 1000).toFixed(2)),
      stoppedEarly: stoppedEarly || this.stopRequested, beatAnchor: Boolean(chosen && anchor?.summary && chosen !== anchor), repaired: chosen?.label === "swap",
      anchor: anchor?.summary || null,
      // A team finished in a hurry after an early Stop carries no Team Evaluation (the page runs none either).
      unevaluated: Boolean(chosen?.quick),
      // The steps the safety cap cut short; empty for a run the counts alone bounded.
      cut: Object.keys(this.cut || {}).filter((k) => this.cut[k]),
      capped: Object.values(this.cut || {}).some(Boolean),
      // The rule the compared teams were ranked by, for the page's note (beats()).
      objective: {
        archetype: ctx.manual ? archetypeDisplay(ctx.manual) : "", metaTop: this.metaKeys ? this.metaTop : 0,
        margin: this.objective.margin, redThreatWeight: this.objective.redThreatWeight, redThreat: this.objective.redThreat,
      },
    };
    if (!chosen) {
      const failed = judged.find((j) => j.error);
      const leaf = failed?.leaf;
      return {
        entries: leaf?.entries || [], spreads: leaf?.spreads || [], additions: leaf?.additions || [], log: leaf?.state?.log || [],
        archetype: ctx.manual ? archetypeDisplay(ctx.manual) : "", error: error || failed?.error || "Auto Build did not find a team.", compared, search, payload: null,
      };
    }
    const log = [...chosen.log];
    if (compared.length > 1 || (!anchor && compared.length)) {
      if (!anchor) log.push(`The best pick per slot could not be finished within the team rules; kept the best of the other ${compared.length} complete team${compared.length === 1 ? "" : "s"}.`);
      else if (search.beatAnchor) log.push(`Compared ${compared.length} complete teams with the Team Evaluation; kept one that ${this.replacedBecause(chosen.summary, anchor.summary, search.objective.archetype)} than the best pick per slot.`);
      else log.push(`Compared ${compared.length} complete teams with the Team Evaluation; the best pick per slot stayed the best.`);
    }
    if (chosen.quick) {
      log.push("Auto Build was stopped before its first team was complete: the remaining slots were filled from the most-used candidates, and the team was neither fine-tuned nor scored. Run the Team Evaluation on it, or build again.");
    } else if (search.stoppedEarly) {
      log.push("Auto Build was stopped; this is the best team it had found by then.");
    }
    let { entries, spreads, payload } = chosen;
    if (optimizeStats && !search.stoppedEarly) {
      entries = entries.map((e) => ({ ...e }));
      spreads = spreads.map((s) => (s ? { ...s } : null));
      b.finetune(entries, spreads, log, progress);
      payload = this.evaluation.evaluate(teamSets(entries, spreads), { checkSelection: ctx.selection });
      const entry = compared.find((c) => c.chosen);
      if (entry) {
        entry.sets = teamSets(entries, spreads);
        entry.summary = teamSummary(payload, ctx.manual, this.objective, { metaOutside: this.metaOutside(chosen.leaf.additions) });
      }
    }
    progress(1, "Auto Build finished", true);
    search.seconds = Number((this.elapsed() / 1000).toFixed(2));
    return {
      entries, spreads, additions: chosen.leaf.additions, log, archetype: ctx.manual ? archetypeDisplay(ctx.manual) : "",
      error: "", compared, search, payload, summary: compared.find((c) => c.chosen)?.summary || chosen.summary,
    };
  }
}
