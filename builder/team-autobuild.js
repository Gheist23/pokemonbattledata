// Auto Build, ported from the Companion app.
//
//   preflight   the existing members' sets are completed and Item Clause is
//               repaired (V477/V480); the candidate pool is frozen once (the
//               ranked meta minus the team, cut to the depth's budget, with a
//               Mega kept in when the team has none) and so is the seed payload:
//               the Top-X meta rows as threats and neutral 50 scores unless the
//               same team was just evaluated (_v452_fast_autobuild_payload).
//   phase 1     every open slot in turn: each pooled Pokemon is scored by the
//               Suggestions engine in its Auto Build mode, ranked by the enabled
//               Team Building Checks it still fails first and its score second
//               (V468 -> V472 -> team_build_constraints), a Mega is forced into
//               the first pick when the team has none (V494), and the winner's
//               set is completed (V467/V450/V444).
//               A preferred archetype (V477/V494) and Prioritize Meta Pokemon
//               (V462) reshape the pool, the order and the first picks - see
//               builder/autobuild-archetype.js.
//   phase 2     "Adjust against Meta" - a no-op in the app since V469.
//   finish      Mega stones trimmed to two or one handed out (V494), the chosen
//               archetype's move taught or brought in from the Box (V494), Mega forms
//               normalised, the team's own field conditions re-tuned, the Mega
//               pair balanced, the speed mode settled and every set refined for
//               the team it ended up on (field_synergy, mega_balance_v505,
//               speed_mode_v505, team_set_refinement_v505).

import { compact } from "./engine.js";
import { AutoBuildSearch, additionForPage } from "./autobuild-search.js";
import { AutoBuildArchetype, archetypeDisplay, archetypeKey, candidateKey, manualArchetype, resolveAutomaticArchetype, topMetaKeys } from "./autobuild-archetype.js";
import { TeamOptimizer } from "./team-optimize.js";
import { MOVES_NEEDING_SUPPORT, TeamSuggestions, boxCandidates, speedModePlan, uniqueNames } from "./team-suggest.js";

const TEAM_SIZE = 6;
const MAX_DEFENSIVE_WARNINGS = 2;
const MAX_MEGA_STONES = 2;
const MEGA_ITEM_LOOKUP_DEPTH = 12;
const SUGGESTION_LIMIT = 14;

/** V453 depth profiles as V472 left them: candidate budget and Phase-1 finalists. */
export const AUTO_BUILD_PROFILES = {
  fast: { key: "fast", label: "Fast", budget: 40, finalists: 1 },
  medium: { key: "medium", label: "Medium", budget: 100, finalists: 2 },
  deep: { key: "deep", label: "Deep", budget: null, finalists: 4 },
};

const blankEntry = () => ({ pokemon: "", item: "", form: "", ability: "", moves: [] });
const valid = (entry) => Boolean(entry && String(entry.pokemon || "").trim());

export class TeamAutoBuild {
  /** @param {TeamEvaluation} evaluation */
  constructor(evaluation) {
    this.evaluation = evaluation;
    this.ev = evaluation.ev;
    this.checks = evaluation.checks;
    this.synergy = evaluation.synergy;
    this.sg = new TeamSuggestions(evaluation);
  }

  /** One added member as the page shows it (see builder/autobuild-search.js additionForPage). */
  static additionForPage(addition) {
    return additionForPage(addition);
  }

  // --- conversions ----------------------------------------------------------------

  entryFromSet(set) {
    if (!set || !String(set.species || "").trim()) return blankEntry();
    return { pokemon: set.species, item: set.item || "", form: set.form || set.species, ability: set.ability || "", moves: (set.moves || []).filter(Boolean).slice(0, 4) };
  }

  /** A damage-engine slot for an entry and its spread. */
  slot(entry, spread, index) {
    const set = {
      species: entry.pokemon, form: entry.form || entry.pokemon, item: entry.item, ability: entry.ability, moves: entry.moves,
      nature: spread?.nature_name || spread?.name || "Serious", bonuses: spread?.bonuses || [0, 0, 0, 0, 0, 0],
    };
    const mon = this.ev.teamMon(set, index);
    return { entry: { ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }, mon, set };
  }

  slotsFor(entries, spreads) {
    const out = [];
    entries.forEach((entry, i) => {
      if (valid(entry)) out.push(this.slot(entry, spreads[i], out.length));
    });
    return out;
  }

  names(slots) {
    return slots.map(({ entry, mon }) => this.sg.name(mon.form_name || entry.form || entry.pokemon));
  }

  // --- set completion (_v444_complete_auto_build_set / _v472_finalize_auto_entry) ---

  learnable(species, form) {
    const sets = this.ev.engine.data?.learnsets || {};
    const direct = sets[`${species}|${form || species}`];
    if (direct?.length) return direct;
    for (const [key, list] of Object.entries(sets)) if (key.startsWith(`${species}|`) && list.length) return list;
    return [];
  }

  /** Missing item, Ability, moves (to four) and spread, from the common set, usage, then the learnset. */
  completeSet(entry, spread) {
    const pokemon = String(entry.pokemon || "").trim();
    const form = String(entry.form || pokemon).trim() || pokemon;
    const common = this.sg.common(pokemon);
    let item = String(entry.item || "").trim() || String(common.item || "").trim() || this.sg.usage(pokemon, "held_item", 12)[0] || "";
    let ability = String(entry.ability || "").trim() || String(common.ability || "").trim() || this.sg.usage(pokemon, "ability", 8)[0] || "";
    let moves = uniqueNames([...(entry.moves || []), ...(common.moves || []), ...this.sg.usage(pokemon, "move", 20)], 4);
    if (moves.length < 4) moves = uniqueNames([...moves, ...this.learnable(pokemon, form)], 4);
    if (!item) item = "Sitrus Berry";
    const clean = { pokemon, item, form, ability, moves: moves.slice(0, 4) };
    return [clean, this.completeSpread(pokemon, spread)];
  }

  /** _v462_complete_spread */
  completeSpread(pokemon, spread) {
    const data = { ...(spread || {}) };
    const common = this.sg.common(pokemon);
    const nature = String(data.nature_name || data.name || common.nature_name || "Serious").trim() || "Serious";
    const pair = data.nature || this.ev.engine.natures?.[nature] || ["", ""];
    const bonuses = Array.isArray(data.bonuses) && data.bonuses.length >= 6 ? data.bonuses : common.bonuses || [0, 0, 0, 0, 0, 0];
    return { ...data, name: nature, nature_name: nature, nature: [...pair].slice(0, 2), bonuses: bonuses.slice(0, 6).map((v) => Math.max(0, Math.min(32, Number.parseInt(v, 10) || 0))) };
  }

  /** _v480_item_options: the current item, the common one, then recorded usage. */
  itemOptions(pokemon, current) {
    return uniqueNames([current, this.sg.common(pokemon).item, ...this.sg.usage(pokemon, "held_item", 30)], 99);
  }

  /** V477 + V480: complete the members already on the team; a repeated item is replaced. */
  finalizeExisting(entries, spreads) {
    const used = new Set();
    const log = [];
    entries.forEach((entry, slot) => {
      if (!valid(entry)) return;
      let [clean, spread] = this.completeSet(entry, spreads[slot]);
      const k = compact(clean.item);
      if (k && used.has(k)) {
        const replacement = this.itemOptions(clean.pokemon, clean.item).find((o) => !used.has(compact(o))) || "";
        log.push(`${clean.pokemon}: ${clean.item} is already held by a teammate, so it holds ${replacement || "no item"}.`);
        clean = { ...clean, item: replacement };
      }
      if (compact(clean.item)) used.add(compact(clean.item));
      entries[slot] = clean;
      spreads[slot] = spread;
    });
    return log;
  }

  // --- the seed payload and the pool --------------------------------------------------

  /** _v452_fast_autobuild_payload: Top-X meta definitions as threats; scores only from the same team. */
  seedPayload(slots, selection, cachedPayload) {
    const payload = { ok: true, settings: { ...this.ev.settings } };
    if (cachedPayload && this.signature(cachedPayload.slots || []) === this.signature(slots)) {
      for (const k of ["synergy_score", "offense_score", "defense_score"]) if (cachedPayload[k] !== undefined) payload[k] = cachedPayload[k];
      if (cachedPayload.speed) payload.speed = { ...cachedPayload.speed };
    }
    payload.threats = this.ev.topMeta(this.ev.settings.top_meta).map((row, index) => {
      const position = Number(row.position ?? index + 1) || index + 1;
      return { ...row, score: Math.max(38, 86 - Math.min(48, position * 1.35)), base_name: String(row.base_name || row.name || ""), form: String(row.form || row.name || "") };
    });
    payload.checks = this.sg.snapshotFor(slots, selection);
    return payload;
  }

  signature(slots) {
    return JSON.stringify(slots.map(({ entry }) => [compact(entry.pokemon), compact(entry.item), compact(entry.form), compact(entry.ability), (entry.moves || []).map(compact)]));
  }

  /** The pool frozen at preflight: every ranked Pokemon whose name is not on the team (V203). */
  frozenPool(activeNames) {
    const team = new Set(activeNames.map(compact).filter(Boolean));
    const excluded = this.ev.excludedPokemonKeys();
    const nameKeys = (value) => {
      const text = String(value || "").trim();
      const variants = new Set([text, text.replace(/-/g, " "), text.replace(/_/g, " ")]);
      if (/^mega[ -]/i.test(text)) variants.add(text.slice(5).trim());
      return [...variants].map(compact).filter(Boolean);
    };
    const seen = new Set();
    const out = [];
    this.sg.allMeta().forEach((meta, index) => {
      const name = String(meta.name || meta.base_name || meta.pokemon || "").trim();
      const k = compact(name);
      if (!k || seen.has(k) || team.has(k) || excluded.has(k)) return;
      if (excluded.size && nameKeys(name).some((v) => excluded.has(v))) return;
      seen.add(k);
      out.push({ ...meta, name, position: Number(meta.position) || index + 1, _suggestion_candidate_source_v203: "All available Pokemon", candidate_source: "All available Pokemon" });
    });
    return out.sort((x, y) => x.position - y.position || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  }

  /**
   * "Only Box" (_v321_box_suggestion_candidates + V494): each Box entry with its saved
   * set forced; an entry saved without moves gets its usage set instead, because
   * Only Box limits the species, not the moveset.
   */
  boxPool(box, activeNames) {
    return boxCandidates(this.sg, box, activeNames);
  }

  /**
   * One slot's candidates from the frozen pool: off the team by name, cut to the
   * budget with a Mega kept in (V471/V472), off the team by species and past two
   * stones (V494), then stone holders named as their Mega (V494).
   */
  slotPool(frozen, slots, activeNames, profile, { metaKeys = null, archetype = null } = {}) {
    const active = new Set(activeNames.map(compact).filter(Boolean));
    const rows = frozen.filter((row) => !active.has(compact(row.name || row.form || row.base_name)));
    let selected = [];
    if (profile.budget === null || rows.length <= profile.budget) selected = [...rows];
    else {
      const seen = new Set();
      // V471: with Prioritize Meta, the Top-X meta is screened before the rest.
      if (metaKeys?.size) {
        for (const row of rows) {
          const k = candidateKey(row);
          if (!k || !metaKeys.has(k) || seen.has(k)) continue;
          seen.add(k);
          selected.push(row);
          if (selected.length >= profile.budget) break;
        }
      }
      for (const row of rows) {
        if (selected.length >= profile.budget) break;
        const k = compact(row.name || row.base_name || row.form || row._v124_base_species);
        if (seen.has(k)) continue;
        seen.add(k);
        selected.push(row);
      }
    }
    if (this.checks.megaCount(slots)[0] <= 0 && rows.length && !selected.some((row) => this.isMegaCandidate(row))) {
      const mega = rows.find((row) => this.isMegaCandidate(row));
      if (mega) {
        if (profile.budget === null) selected.push(mega);
        else if (selected.length) selected[selected.length - 1] = mega;
        else selected = [mega];
      }
    }
    // V477: a chosen archetype's specialists replace the tail of the bounded pool.
    if (archetype?.key) selected = archetype.reserveSpecialists(selected, rows);
    const unique = new Set();
    selected = selected.filter((row) => {
      const k = compact(row.name || row.base_name || row.form);
      if (!k || unique.has(k)) return false;
      unique.add(k);
      return true;
    });
    const species = new Set(activeNames.map((n) => this.sg.speciesId(n)).filter(Boolean));
    if (species.size) selected = selected.filter((row) => !species.has(this.sg.speciesId(row.name || row.form || row.base_name)));
    if (this.megaStoneSlots(slots.map((s) => s.entry)).length >= MAX_MEGA_STONES) {
      const kept = selected.filter((row) => !this.ev.engine.isMegaStone(row._candidate_set_v113?.item || row.top_item || ""));
      if (kept.length) selected = kept;
    }
    return selected.map((row) => this.nameMega(row));
  }

  /** _v494_name_mega_candidates */
  nameMega(row) {
    const item = String(row._candidate_set_v113?.item || row.top_item || "");
    const species = String(row.base_name || row.name || "");
    if (!item || !species || !this.ev.engine.isMegaStone(item) || !this.ev.isMegaItemForSpecies(this.ev.baseSpeciesFromDisplay(species), item)) return row;
    const mega = this.ev.megaFormForItem(this.ev.baseSpeciesFromDisplay(species), item);
    if (!mega || compact(mega) === compact(species)) return row;
    return { ...row, form: mega, name: mega, mega_form_v494: mega };
  }

  isMegaCandidate(row) {
    return Boolean(this.sg.megaItemForCandidate(row));
  }

  // --- ranking (_v468_suggestion_order as Auto Build runs it) -----------------------

  order(rows) {
    // V468: the Suggestions order on rows without the Auto Build sort markers - and,
    // like the Suggestions list, only its first 14 rows (SUGGESTION_RESULT_LIMIT_V307).
    const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    let ordered = rows.map((row, i) => [row, i]).sort(([a, ia], [b, ib]) => b.score - a.score || a.position - b.position || text(String(a.name), String(b.name)) || text(String(a.action || ""), String(b.action || "")) || ia - ib).map(([row]) => row).slice(0, SUGGESTION_LIMIT);
    ordered = ordered.map((row, i) => [row, i]).sort(([a, ia], [b, ib]) => (a.counter_archetype_speed_control_v466 ? 1 : 0) - (b.counter_archetype_speed_control_v466 ? 1 : 0) || (b.role_fixes_v466 || 0) - (a.role_fixes_v466 || 0) || ia - ib).map(([row]) => row);
    // V472: failing enabled checks first, then (with a chosen archetype) its fit, then check pressure.
    // Prioritize Meta Pokemon (V462/V468) ranks the Top-X meta ahead once the hard checks
    // are settled. In the app that tier sits where the V472 sort above it overwrites it,
    // so the option never changes a pick there; here it stands where V468 meant it to.
    const lastSlot = ordered.some((row) => row._last_empty_slot_v472);
    const manual = ordered.find((row) => row._manual_archetype_v472)?._manual_archetype_v472 || "";
    const metaPriority = ordered.some((row) => row.prioritized_meta_member_v462);
    const key = (row) => [
      lastSlot ? row._mega_red_v472 || 0 : 0, row._hard_red_checks_v472 ?? 999, row._hard_yellow_checks_v472 ?? 999, row.counter_archetype_speed_control_v466 ? 1 : 0,
      manual ? -Number(Number(row._manual_archetype_fit_v472 ?? 50).toFixed(4)) : 0,
      metaPriority && !row.prioritized_meta_member_v462 ? 1 : 0,
      Number(Number(row._hard_check_pressure_v472 ?? 9999).toFixed(5)),
    ];
    const sortBy = (list, keyOf) => list.map((row, i) => [row, keyOf(row), i]).sort(([, ka, ia], [, kb, ib]) => {
      for (let j = 0; j < ka.length; j += 1) if (ka[j] !== kb[j]) return ka[j] - kb[j];
      return ia - ib;
    }).map(([row]) => row);
    ordered = sortBy(ordered, key);
    if (ordered.some((row) => row._manual_archetype_v477)) {
      // V477: the chosen archetype is a construction target - the fewest unmet requirements first.
      ordered = sortBy(ordered, (row) => [
        row._hard_red_checks_v472 ?? 999, row._hard_yellow_checks_v472 ?? 999,
        row._archetype_final_complete_v477 && !row._archetype_final_match_v477 ? 1 : 0,
        row._archetype_critical_unmet_v477 ?? 999, row._archetype_total_unmet_v477 ?? 999,
        Number(Number(row._archetype_deficit_v477 ?? 9999).toFixed(4)),
      ]);
      // V494: an unmet critical archetype requirement outranks everything.
      ordered = sortBy(ordered, (row) => [row._archetype_critical_unmet_v477 ?? 999]);
    }
    // team_build_constraints: over the defensive-warning cap last.
    const coverage = (row) => Math.max(0, (Number(row.defensive_switch_warning_count) || 0) - MAX_DEFENSIVE_WARNINGS);
    ordered = ordered.map((row, i) => [row, i]).sort(([a, ia], [b, ib]) => coverage(a) - coverage(b) || ia - ib).map(([row]) => row);
    ordered.forEach((row, i) => {
      row.auto_build_suggestion_rank_v468 = i + 1;
    });
    return ordered;
  }

  /**
   * _v459_select_structural_finalists with V494's forcing: until the team has its
   * archetype members (a setter first, then a beneficiary) and a Mega, the best row
   * that plays that role is the only finalist.
   */
  finalists(ranked, profile, state) {
    const wantsArchetype = (state.needed || 0) > 0 && Boolean(state.archetype?.key);
    const wantsMega = Boolean(state.megaNeeded);
    if (wantsArchetype || wantsMega) {
      const breaks = (row) => (Number(row.defensive_switch_warning_count) || 0) > MAX_DEFENSIVE_WARNINGS && row.defensive_switch_warning_count !== undefined;
      const bestBy = (scorer, pool) => {
        const within = pool.filter((row) => !breaks(row));
        for (const tier of [within, pool]) {
          let winner = null;
          let best = 0;
          for (const row of tier) {
            const score = Number(scorer(row)) || 0;
            if (score > best) [winner, best] = [row, score];
          }
          if (winner) return winner;
        }
        return null;
      };
      const archetype = state.archetype;
      const pickForArchetype = (pool) => {
        const setter = (row) => archetype.roleScore(row);
        const beneficiary = (row) => archetype.beneficiaryScore(row);
        if (state.haveSetter) {
          const found = bestBy(beneficiary, pool);
          return found ? [found, "beneficiary"] : [bestBy(setter, pool), "setter"];
        }
        const found = bestBy(setter, pool);
        return found ? [found, "setter"] : [bestBy(beneficiary, pool), "beneficiary"];
      };
      const megas = ranked.filter((row) => row._candidate_set_v113?.item && this.ev.engine.isMegaStone(row._candidate_set_v113.item));
      let pick = null;
      let kind = "";
      if (wantsArchetype && wantsMega) {
        [pick, kind] = pickForArchetype(megas);
        if (pick) kind = `${kind}, Mega`;
      }
      if (!pick && wantsArchetype) [pick, kind] = pickForArchetype(ranked);
      if (!pick && wantsMega && megas.length) {
        const clean = megas.filter((row) => !breaks(row));
        [pick, kind] = [(clean.length ? clean : megas)[0], "Mega"];
      }
      if (pick) {
        if (kind.includes("Mega")) state.megaNeeded = false;
        if (kind !== "Mega") state.needed = Math.max(0, (state.needed || 0) - 1);
        if (kind.includes("setter")) state.haveSetter = true;
        const outstanding = [];
        if ((state.needed || 0) > 0 && archetype?.key) outstanding.push(`${state.needed} more ${archetype.key} member(s)`);
        if (state.megaNeeded) outstanding.push("a Mega");
        state.log.push(`Auto Build is taking ${pick.name || "a candidate"} (${kind})${outstanding.length ? `; still wanted: ${outstanding.join(", ")}` : "; nothing else forced."}`);
        return [structuredClone(pick)];
      }
    }
    return this.order(ranked.map((row) => ({ ...row }))).slice(0, Math.max(1, profile.finalists)).map((row) => structuredClone(row));
  }

  /** _v467_representative_set_row: the common set the row was screened with, applied. */
  representative(row) {
    const set = row._candidate_set_v113 || this.sg.commonCandidateSet(row._candidate_meta_v378 || { name: row.name }, []);
    const out = this.sg.applySetFields(structuredClone(row), set);
    if (!out.candidate_spread || !Object.keys(out.candidate_spread).length) out.candidate_spread = structuredClone(set.spread || {});
    return out;
  }

  // --- the run ----------------------------------------------------------------------

  /**
   * @param {Array<object|null>} sets     the six builder slots (null or no species = open)
   * @param {object} options  {selection, depth, cachedPayload, onProgress(fraction, message)}
   *   search: "companion" (default) runs the app's greedy path below and returns its
   *   result; any other value runs builder/autobuild-search.js (the anchored beam and the
   *   Team Evaluation comparison) and returns a Promise of the same shape plus
   *   {compared, search, payload}. shouldStop() ends a search early with its best team.
   * @returns {{entries, spreads, additions, log, error?}}
   */
  run(sets, options = {}) {
    if (options.search && options.search !== "companion") return new AutoBuildSearch(this, AUTO_BUILD_PROFILES).run(sets, options);
    return this.runGreedy(sets, options);
  }

  /** The app's own Auto Build: one committed pick per slot, then the finish chain. */
  runGreedy(sets, { selection = null, depth = "medium", cachedPayload = null, cachedScores = null, onlyBox = false, box = [], optimizeStats = false, archetype = "automatic", teamArchetype = "", prioritizeMeta = false, onProgress } = {}) {
    const profile = AUTO_BUILD_PROFILES[depth] || AUTO_BUILD_PROFILES.medium;
    const entries = Array.from({ length: TEAM_SIZE }, (_, i) => this.entryFromSet(sets[i]));
    const spreads = Array.from({ length: TEAM_SIZE }, (_, i) => (sets[i]?.species ? { nature_name: sets[i].nature || "Serious", bonuses: [...(sets[i].bonuses || [0, 0, 0, 0, 0, 0])] } : null));
    const log = this.finalizeExisting(entries, spreads);
    const selected = this.checks.selectedIds(selection);
    const startEntries = entries.filter(valid).map((e) => ({ ...e }));
    const slots = this.slotsFor(entries, spreads);
    const { manual, chosen, options } = this.runOptions(entries, slots, { archetype, teamArchetype, prioritizeMeta });
    const state = { megaNeeded: this.megaStoneSlots(entries).length === 0, log, archetype: chosen, ...chosen.forcing(entries.filter(valid)) };
    // The app reuses Team Evaluation's scores only when they are of this very team.
    const seed = this.seedPayload(slots, selection, cachedScores ? { ...cachedScores, slots } : cachedPayload);
    const frozen = onlyBox ? this.boxPool(box, this.names(slots)) : this.frozenPool(this.names(slots));
    if (onlyBox && !frozen.length) return { entries, spreads, additions: [], log, error: "Your Box has no Pokémon that are not already on the team." };
    const additions = [];
    const progress = (fraction, message) => onProgress?.(Math.max(0, Math.min(1, fraction)), message);
    // While Auto Build screens candidates the app scores each move on its own (V458).
    this.ev.perMoveAttacks = true;
    let error = "";
    try {
      error = this.buildSlots({ entries, spreads, selection, selected, profile, state, seed, frozen, startEntries, additions, progress, options });
    } finally {
      this.ev.perMoveAttacks = false;
    }
    if (error) return { entries, spreads, additions, log, error };
    // team_build_constraints.validate_completed_team
    const finalSlots = this.slotsFor(entries, spreads);
    const warnings = this.defensiveWarnings(finalSlots);
    // The last slot already said it could not do better (buildSlots); the team is still returned.
    if (warnings > MAX_DEFENSIVE_WARNINGS && !state.overCap) {
      return { entries, spreads, additions, log, error: `Auto Build could not finish with at most ${MAX_DEFENSIVE_WARNINGS} defensive switch-in warnings (${warnings} remain). Broaden the candidate pool or free another slot.` };
    }
    progress(0.92, "Finalizing Mega items and abilities");
    this.finish(entries, spreads, log, progress, { anchorArchetype: options.anchorArchetype, box, archetype: manual });
    if (optimizeStats) this.finetune(entries, spreads, log, progress);
    progress(1, "Auto Build finished");
    // _v494_label_team_with_archetype: the chosen archetype, or the one the team reads as.
    const label = manual ? archetypeDisplay(manual) : "";
    return { entries, spreads, additions, log, archetype: label };
  }

  /**
   * The preferred archetype and Prioritize Meta, as every candidate's context carries them.
   * The chosen archetype steers the ranking (V477); the move it is named after is offered
   * and guaranteed for it - or, on Automatically, for the team's own label (V494).
   */
  runOptions(entries, slots, { archetype = "automatic", teamArchetype = "", prioritizeMeta = false } = {}) {
    const manual = manualArchetype(archetype);
    const chosen = new AutoBuildArchetype(this.sg, manual);
    const anchorKey = manual || manualArchetype(teamArchetype);
    const anchorArchetype = anchorKey === manual ? chosen : new AutoBuildArchetype(this.sg, anchorKey);
    const saved = archetypeKey(teamArchetype);
    const resolved = manual ? "" : resolveAutomaticArchetype(this.sg.featuresFor(slots), saved === "automatic" ? "balanced" : saved, (req) => this.sg.requirementRatio(req));
    return {
      manual,
      chosen,
      options: {
        archetype: manual ? chosen : null, anchorArchetype: anchorArchetype.anchor ? anchorArchetype : null,
        archetypeKey: manual, resolvedArchetype: resolved, metaKeys: prioritizeMeta ? topMetaKeys(this.ev) : null,
      },
    };
  }

  /** Phase 1: every open slot in turn, scored against the team as it stands (V459). */
  buildSlots({ entries, spreads, selection, selected, profile, state, seed, frozen, startEntries, additions, progress, options = {} }) {
    const shared = { selection, selected, profile, frozen, startEntries, options };
    const open = entries.filter((e) => !valid(e)).length;
    let node = { entries, spreads, seed, state };
    for (let done = 0; done < open; done += 1) {
      const screened = this.screenSlot(node, shared, (index, total, name) => {
        if (index % 6 === 0 || index === total - 1) {
          progress(((done + (index + 1) / total) / open) * 0.9, `Building slot ${done + 1}/${open}: screening ${index + 1}/${total} · ${name}`);
        }
      });
      if (!screened) break;
      const best = this.pickFromRanked(screened.ranked, profile, state);
      if (!best) return "Auto Build did not find a structurally fitting Pokemon for an empty slot.";
      const next = this.applyPick(node, screened.slotIndex, best, selection);
      entries[screened.slotIndex] = next.entries[screened.slotIndex];
      spreads[screened.slotIndex] = next.spreads[screened.slotIndex];
      additions.push(next.addition);
      // The next slot is scored against the projected team and its projected scores.
      node = { entries, spreads, seed: next.seed, state };
      progress(((done + 1) / open) * 0.9, `Built slot ${done + 1}/${open}: ${best.name}`);
    }
    return "";
  }

  // --- the pieces of one slot (shared by buildSlots and builder/autobuild-search.js) ---

  /**
   * The first open slot of a partial team and what every candidate for it is scored
   * against. `node` is {entries, spreads, seed}; `shared` is the run's fixed inputs
   * {selection, selected, profile, frozen, startEntries, options}. `candidates`
   * replaces the pool (the search screens a shortlist on its side branches).
   */
  prepareSlot(node, shared, { candidates = null } = {}) {
    const slotIndex = node.entries.findIndex((e) => !valid(e));
    if (slotIndex < 0) return null;
    const slots = this.slotsFor(node.entries, node.spreads);
    const activeNames = this.names(slots);
    const pool = candidates || this.slotPool(shared.frozen, slots, activeNames, shared.profile, shared.options);
    const context = {
      payload: node.seed, teamSlots: slots, teamEntries: slots.map((s) => s.entry), activeNames,
      emptySlot: slots.length, selection: shared.selection, selected: shared.selected, swapTarget: "", autoBuild: true, fieldEntries: shared.startEntries, ...shared.options,
    };
    return { slotIndex, slots, activeNames, candidates: pool, context };
  }

  /** One candidate scored for the slot (null when it scores nothing). */
  screenCandidate(meta, context) {
    const row = this.sg.evaluateCandidate(structuredClone(meta), context);
    return row && row.score > 0 ? row : null;
  }

  /**
   * The last slot keeps only candidates that pass the finished-team rules, and falls
   * back to the ones breaking the fewest when none does (see autoBuildFilters).
   */
  finishFilter(ranked, state) {
    const clean = ranked.filter((row) => !row._finish_filter_misses);
    if (clean.length || !ranked.length) return clean;
    // Within the switch-in limit first, then the fewest types left unanswered, then the fewest rules broken.
    const cost = (row) => [row._finish_over_cap || 0, row._finish_filter_misses.length];
    const best = ranked.map(cost).sort((a, b) => a[0] - b[0] || a[1] - b[1])[0];
    const kept = ranked.filter((row) => cost(row)[0] === best[0] && cost(row)[1] === best[1]);
    if (best[0]) state.overCap = best[0];
    const misses = [...new Set(kept.flatMap((row) => row._finish_filter_misses))];
    state.log.push(`No Pokémon for the last slot avoids leaving the team with ${misses.join(" or ")}; Auto Build takes the best of them instead of stopping.`);
    return kept;
  }

  /** prepareSlot, every candidate screened, then finishFilter: {slotIndex, slots, activeNames, candidates, context, ranked}. */
  screenSlot(node, shared, onCandidate = null) {
    const prepared = this.prepareSlot(node, shared);
    if (!prepared) return null;
    const ranked = [];
    prepared.candidates.forEach((meta, index) => {
      const row = this.screenCandidate(meta, prepared.context);
      if (row) ranked.push(row);
      onCandidate?.(index, prepared.candidates.length, meta.name);
    });
    return { ...prepared, ranked: this.finishFilter(ranked, node.state) };
  }

  /** The slot's pick: the finalists (with V494's forcing, which updates `state`), their common set, the best rank. */
  pickFromRanked(ranked, profile, state) {
    const finalists = this.finalists(ranked, profile, state);
    if (!finalists.length) return null;
    const refined = finalists.map((row) => this.representative(row));
    const coverage = (row) => Math.max(0, (Number(row.defensive_switch_warning_count) || 0) - MAX_DEFENSIVE_WARNINGS);
    const ranks = (row) => [row.auto_build_suggestion_rank_v468 === undefined ? 1 : 0, row.auto_build_suggestion_rank_v468 ?? 999999];
    return refined.map((row, i) => [row, i]).sort(([a, ia], [b, ib]) => coverage(a) - coverage(b) || ranks(a)[0] - ranks(b)[0] || ranks(a)[1] - ranks(b)[1] || ia - ib)[0][0];
  }

  /**
   * The team with `best` in `slotIndex`, as a new node: copied entries and spreads,
   * and a seed with the projected team's checks and the pick's projected scores.
   * The input node is left as it was.
   */
  applyPick(node, slotIndex, best, selection) {
    const [entry, spread] = this.completeSelected(best);
    const entries = [...node.entries];
    const spreads = [...node.spreads];
    entries[slotIndex] = entry;
    spreads[slotIndex] = spread;
    const seed = { ...node.seed, speed: node.seed.speed ? { ...node.seed.speed } : node.seed.speed };
    seed.checks = this.sg.snapshotFor(this.slotsFor(entries, spreads), selection);
    this.projectScores(seed, best);
    return { entries, spreads, seed, addition: { slot: slotIndex, entry, spread, score: best.score, name: best.name, row: best } };
  }

  /** _v450_complete_selected_auto_set */
  completeSelected(best) {
    const e = best.candidate_entry || {};
    const entry = { pokemon: e.pokemon || best.name, item: e.item || best.item || "", form: e.form || best.form || e.pokemon || best.name, ability: e.ability || best.ability || "", moves: (e.moves || best.moves || []).slice(0, 4) };
    const spread = this.sg.normalizeSpread(entry.pokemon, best.candidate_spread || best._candidate_set_v113?.spread || {});
    return this.completeSet(entry, spread);
  }

  /** _v427_project_scores: the next slot starts from this pick's projected scores. */
  projectScores(payload, row) {
    const components = row.suggestion_score_components_v318 || {};
    for (const k of ["synergy", "offense", "defense", "speed"]) {
      let projected = components[k]?.projected;
      if (projected === undefined || projected === null) projected = row[`projected_${k}_score`];
      if (projected === undefined || projected === null || !Number.isFinite(Number(projected))) continue;
      if (k === "speed") payload.speed = { ...(payload.speed || {}), score: Number(projected) };
      else payload[`${k}_score`] = Number(projected);
    }
  }

  // --- the finish chain ---------------------------------------------------------------

  /**
   * Everything _v427_auto_build_finished runs over the applied team, in order.
   * `quick` (a build stopped before its first team was complete) keeps the rules - Mega
   * stones, Mega forms, spreads, field conditions, speed mode - and skips the two passes
   * that run damage calcs: the Mega pair balance and the set refinement.
   */
  finish(entries, spreads, log, progress = () => {}, { anchorArchetype = null, box = [], archetype = "", quick = false } = {}) {
    // A Trick Room or Tailwind team keeps the speed control it was built around.
    const preferredMode = { "trick room": "trickroom", tailwind: "tailwind" }[archetype] || "";
    this.trimExcessMegaStones(entries, log);
    this.ensureMegaHolder(entries, log);
    if (anchorArchetype) this.installAnchor(entries, spreads, log, anchorArchetype, box);
    this.normaliseMegas(entries, log);
    this.completeMissingSpreads(entries, spreads);
    this.retuneForConditions(entries, log);
    if (!quick) {
      const board = this.threatBoard(30);
      this.balanceMegas(entries, board, log);
    }
    progress(0.95, "Checking team speed-control moves");
    this.resolveSpeedMode(entries, log, preferredMode);
    if (quick) return;
    progress(0.97, "Moves, Items and Abilities");
    this.refineSets(entries, spreads, log, preferredMode);
  }

  /** _v494_install_archetype_anchor: the finished team carries the move its archetype is named after. */
  installAnchor(entries, spreads, log, archetype, box) {
    const speedOf = (entry, i) => {
      try {
        return this.checks.profile(entry, this.slot(entry, spreads[i], i).mon).speed;
      } catch {
        return 0;
      }
    };
    for (const slot of archetype.install(entries, { box, speedOf, log })) {
      // The newcomer brings its own Box spread, or its usage spread - not the old member's.
      const incoming = (box || []).find((set) => compact(set.form || set.species) === compact(entries[slot].form));
      spreads[slot] = incoming && (incoming.bonuses || []).some((v) => Number(v))
        ? this.completeSpread(entries[slot].pokemon, { nature_name: incoming.nature, bonuses: [...incoming.bonuses] })
        : this.completeSpread(entries[slot].pokemon, {});
    }
  }

  usageShare(species, category, name, limit = MEGA_ITEM_LOOKUP_DEPTH) {
    const pair = this.ev.usagePairs(this.sg.usageName(species), category, limit).find(([n]) => compact(n) === compact(name));
    return pair ? Number(pair[1]) || 0 : 0;
  }

  /** _v494_trim_excess_mega_stones: at most two stones; the least used go. */
  trimExcessMegaStones(entries, log) {
    const slots = this.megaStoneSlots(entries);
    if (slots.length <= MAX_MEGA_STONES) return;
    const ranked = slots.map((i) => [i, this.usageShare(entries[i].pokemon, "held_item", entries[i].item)]).sort((a, b) => b[1] - a[1]).map(([i]) => i);
    const removed = [];
    for (const i of ranked.slice(MAX_MEGA_STONES)) {
      removed.push(`${entries[i].pokemon}'s ${entries[i].item}`);
      entries[i] = { ...entries[i], item: "" };
    }
    log.push(`Auto Build produced ${slots.length} Mega Stones; only one Mega can be active, so ${removed.join(" and ")} ${removed.length > 1 ? "were" : "was"} removed.`);
  }

  /** _v494_ensure_user_mega_holder: a team of four or more gets one stone, the most used one. */
  ensureMegaHolder(entries, log) {
    const populated = entries.filter(valid);
    if (populated.length < 4 || this.megaStoneSlots(entries).length) return;
    let best = [-1, "", -1];
    entries.forEach((entry, i) => {
      if (!valid(entry)) return;
      for (const [stone, share] of this.ev.usagePairs(this.sg.usageName(entry.pokemon), "held_item", MEGA_ITEM_LOOKUP_DEPTH)) {
        if (!stone || !this.ev.engine.isMegaStone(stone) || !this.ev.isMegaItemForSpecies(entry.pokemon, stone)) continue;
        if ((Number(share) || 0) > best[2]) best = [i, stone, Number(share) || 0];
        break;
      }
    });
    if (best[0] < 0) return;
    const entry = entries[best[0]];
    log.push(`Auto Build returned no Mega. Giving ${entry.pokemon} its ${best[1]} (${best[2].toFixed(1)}% usage) in place of ${entry.item || "no item"}.`);
    entries[best[0]] = { ...entry, item: best[1] };
  }

  /** _v494_normalise_megas_in_team: a stone holder is saved as its Mega with a legal Ability. */
  normaliseMegas(entries, log) {
    entries.forEach((entry, i) => {
      if (!valid(entry) || !entry.item || !this.ev.engine.isMegaStone(entry.item)) return;
      const holder = (this.ev.engine.megaStones.get(compact(entry.item)) || [])[0];
      const base = holder?.species || "";
      const megaForm = this.sg.megaFormForStone(entry.item);
      if (!base || !megaForm || ![compact(base), compact(megaForm)].includes(compact(entry.pokemon))) return;
      const allowed = this.ev.engine.formRecord(base, megaForm)?.abilities || [];
      const ability = allowed.length && !allowed.some((a) => compact(a) === compact(entry.ability)) ? allowed[0] : entry.ability;
      if (compact(entry.pokemon) === compact(base) && compact(entry.form) === compact(megaForm) && compact(ability) === compact(entry.ability)) return;
      if (compact(ability) !== compact(entry.ability)) log.push(`${megaForm} holds its ${entry.item}, so its Ability is ${ability}, not ${entry.ability || "unset"}.`);
      entries[i] = { ...entry, pokemon: base, form: megaForm, ability };
    });
  }

  /** _v494_complete_missing_spreads */
  completeMissingSpreads(entries, spreads) {
    entries.forEach((entry, i) => {
      if (!valid(entry)) return;
      if ((spreads[i]?.bonuses || []).some((v) => Number(v))) return;
      const filled = this.completeSpread(entry.pokemon, {});
      if (filled.bonuses.some((v) => Number(v))) spreads[i] = filled;
    });
  }

  /** field_synergy.retune_entries: once the team is final, re-pick what its conditions now allow. */
  retuneForConditions(entries, log) {
    const available = this.sg.fieldSupport(entries.filter(valid));
    const t = this.ev.engine.data?.analysisTables || {};
    const setterKeys = new Set([...Object.values(t._SIMPLE_WEATHER_SETTERS_V187 || {}), ...Object.values(t._SIMPLE_TERRAIN_SETTERS_V187 || {})].flat());
    const keep = new Set(["protect", "detect", "wideguard", "quickguard", "fakeout", "followme", "ragepowder"]);
    entries.forEach((entry, i) => {
      if (!valid(entry)) return;
      let moves = [...entry.moves];
      const pool = this.sg.usage(entry.pokemon, "move", 14);
      const legal = new Set(this.learnable(entry.pokemon, entry.form).map(compact));
      const held = new Set(moves.map(compact));
      const upgrades = pool.filter((move) => {
        const need = MOVES_NEEDING_SUPPORT[compact(move)];
        return need && available.has(need) && !held.has(compact(move)) && (!legal.size || legal.has(compact(move)));
      });
      let changed = false;
      const order = new Map(pool.map((m, idx) => [compact(m), idx]));
      for (const upgrade of upgrades) {
        const droppable = moves.filter((m) => !keep.has(compact(m)) && !setterKeys.has(compact(m)) && !MOVES_NEEDING_SUPPORT[compact(m)]);
        if (!droppable.length) break;
        const worst = droppable.reduce((a, b) => ((order.get(compact(b)) ?? 99) > (order.get(compact(a)) ?? 99) ? b : a));
        if ((order.get(compact(upgrade)) ?? 99) >= (order.get(compact(worst)) ?? 99)) continue;
        moves = moves.map((m) => (m === worst ? upgrade : m));
        log.push(`Team synergy: ${entry.pokemon}: ${worst} -> ${upgrade}`);
        changed = true;
      }
      const repaired = this.sg.repairSetFields(entry.pokemon, { item: entry.item, ability: entry.ability, form: entry.form }, entries.filter(valid));
      let { item, ability } = entry;
      if (String(repaired.item || "") !== String(item || "")) {
        log.push(`Team synergy: ${entry.pokemon}: ${item || "no item"} -> ${repaired.item || "no item"}`);
        item = String(repaired.item || "");
        changed = true;
      }
      if (String(repaired.ability || "") !== String(ability || "")) {
        log.push(`Team synergy: ${entry.pokemon}: ${ability} -> ${repaired.ability}`);
        ability = String(repaired.ability || "");
        changed = true;
      }
      if (changed) entries[i] = { ...entry, item, ability, moves: moves.slice(0, 4) };
    });
  }

  /** team_set_refinement_v505.threat_board: the top meta as Pokemon, with their top item and moves. */
  threatBoard(limit) {
    // top_meta_pokemon(limit) reads the Top-X setting, not its argument (_v223); the
    // board is then cut to `limit` - so never more than the Top-X threats.
    const topX = Math.max(1, Math.min(100, Number.parseInt(this.ev.settings.top_meta, 10) || 30));
    return this.ev.topMeta(topX).slice(0, limit).map((meta, index) => {
      const name = String(meta.base_name || meta.name || "").trim();
      const mon = this.ev.commonMon(name, this.ev.megaFormForItem(name, meta.top_item || "") || name);
      if (meta.top_item) mon.item = meta.top_item;
      const moves = (meta.moves || []).filter((m) => String(m).trim());
      mon.moves = moves.length ? moves.slice(0, 4) : mon.moves?.length ? mon.moves : this.sg.usage(name, "move", 4);
      return [mon, Number(meta.position ?? index + 1) || index + 1];
    }).filter(([mon]) => mon?.pokemon_name);
  }

  threatWeight(position) {
    const rank = Number(position);
    if (!Number.isFinite(rank) || rank <= 0 || rank >= 9999) return 0;
    return 1 / Math.sqrt(rank);
  }

  score(attacker, defender, moves) {
    try {
      return Number(this.ev.bestAttack(attacker, defender, moves)?.score) || 0;
    } catch {
      return 0;
    }
  }

  /** mega_balance_v505.coverage: the threats this Mega answers (decisive and the better of it). */
  coverage(mon, board) {
    const own = compact(mon.pokemon_name);
    const found = new Map();
    for (const [threat, position] of board) {
      if (compact(threat.pokemon_name) === own) continue;
      const ours = this.score(mon, threat, mon.moves);
      const theirs = this.score(threat, mon, threat.moves);
      if (ours >= 50 && ours > theirs) found.set(String(threat.form_name || ""), position);
    }
    return found;
  }

  megaMon(species, stone) {
    const form = this.ev.megaFormForItem(species, stone);
    const mon = this.ev.commonMon(species, form);
    mon.item = stone;
    mon.ability = this.ev.megaAbility(species, form, mon.ability) || mon.ability;
    if (!mon.moves?.length) mon.moves = this.sg.usage(species, "move", 4);
    return mon;
  }

  complementary(first, second, total, minimum = 0.06) {
    const share = (mine, theirs) => [...mine.keys()].filter((k) => !theirs.has(k)).reduce((sum, k) => sum + this.threatWeight(mine.get(k)), 0) / (total || 1);
    const a = share(first, second);
    const b = share(second, first);
    const only = (mine, theirs) => [...mine.keys()].filter((k) => !theirs.has(k)).sort((x, y) => mine.get(x) - mine.get(y));
    return {
      first_share: a, second_share: b, first_only: only(first, second), second_only: only(second, first),
      shared: [...first.keys()].filter((k) => second.has(k)).sort(), keep_both: Math.min(a, b) >= minimum, weaker: a <= b ? 0 : 1,
    };
  }

  /** mega_balance_v505: two Megas only when each answers what the other cannot; a single one may gain a partner. */
  balanceMegas(entries, board, log) {
    if (!board.length) return;
    const slots = this.megaStoneSlots(entries);
    const total = board.reduce((sum, [, position]) => sum + this.threatWeight(position), 0) || 1;
    if (slots.length === 1) {
      const held = slots[0];
      const incumbent = this.megaMon(entries[held].pokemon, entries[held].item);
      const heldCoverage = this.coverage(incumbent, board);
      let best = null;
      entries.forEach((entry, slot) => {
        if (slot === held || !valid(entry)) return;
        const pair = this.ev.usagePairs(this.sg.usageName(entry.pokemon), "held_item", 12).find(([item]) => this.ev.isMegaItemForSpecies(entry.pokemon, item));
        if (!pair || (Number(pair[1]) || 0) < 5) return;
        const mon = this.megaMon(entry.pokemon, pair[0]);
        const verdict = this.complementary(heldCoverage, this.coverage(mon, board), total);
        if (!verdict.keep_both) return;
        if (!best || verdict.second_share > best.second_share) best = { ...verdict, slot, stone: pair[0], names: [incumbent.form_name, mon.form_name] };
      });
      if (!best) return;
      const entry = entries[best.slot];
      const form = this.ev.megaFormForItem(entry.pokemon, best.stone);
      entries[best.slot] = { ...entry, item: best.stone, form, ability: this.ev.megaAbility(entry.pokemon, form, "") || entry.ability };
      log.push(`Mega balance: ${entry.pokemon} takes a ${best.stone} in place of ${entry.item || "no item"}. ${best.names[1]} alone answers ${best.second_only.join(", ") || "nothing"}, which ${best.names[0]} does not.`);
      return;
    }
    if (slots.length < 2) return;
    const pair = slots.slice(0, 2);
    const mons = pair.map((i) => this.megaMon(entries[i].pokemon, entries[i].item));
    const verdict = this.complementary(this.coverage(mons[0], board), this.coverage(mons[1], board), total);
    const names = mons.map((m) => m.form_name);
    if (verdict.keep_both) {
      log.push(`Mega balance: keeping both stones. ${names[0]} alone answers ${verdict.first_only.join(", ") || "nothing"}; ${names[1]} alone answers ${verdict.second_only.join(", ") || "nothing"}.`);
      return;
    }
    const slot = pair[verdict.weaker];
    const entry = entries[slot];
    const taken = new Set(entries.filter((e, i) => i !== slot && valid(e)).map((e) => compact(e.item)));
    const ability = this.sg.usage(entry.pokemon, "ability", 4)[0] || "";
    const replacement = this.sg.usage(entry.pokemon, "held_item", 12).find((item) => {
      const k = compact(item);
      return k && !taken.has(k) && !this.ev.engine.isMegaStone(item) && !/ite[xyz]?$/.test(k);
    }) || "";
    entries[slot] = { ...entry, item: replacement, form: entry.pokemon, ability };
    const only = verdict.weaker === 0 ? verdict.first_only : verdict.second_only;
    log.push(`Mega balance: ${entry.pokemon} gives up its ${entry.item} for ${replacement || "no item"}. ${names[verdict.weaker]} answers ${only.length ? `only ${only.join(", ")}` : "nothing the other does not"} that ${names[1 - verdict.weaker]} does not, and they share ${verdict.shared.length}.`);
  }

  /** speed_mode_v505: one speed mode per team; a setter for the other one trades that move. */
  resolveSpeedMode(entries, log, preferredMode = "") {
    const live = entries.map((e, i) => [e, i]).filter(([e]) => valid(e));
    if (!live.length) return;
    const slots = live.map(([e], n) => this.slot(e, null, n));
    const profiles = slots.map(({ entry, mon }) => this.synergy.profile(entry, mon));
    const plan = speedModePlan(profiles, this.synergy.metaSpeedRows());
    // speed_mode_v505 decides from the team's speeds alone; a chosen Trick Room or
    // Tailwind archetype is authoritative, as it is for the strategy fit (_v466_actual_archetype).
    if (preferredMode) plan.mode = preferredMode;
    const wrong = new Map();
    if (plan.mode !== "trickroom") for (const name of plan.trick_room) wrong.set(compact(name), "Trick Room");
    if (plan.mode !== "tailwind") for (const name of plan.tailwind) wrong.set(compact(name), "Tailwind");
    if (!wrong.size) return;
    // Each entry is paired with its own profile (named by its form: "Chandelure-Mega").
    for (const [n, [entry, i]] of live.entries()) {
      const move = wrong.get(compact(profiles[n].name)) || wrong.get(compact(entry.pokemon));
      if (!move) continue;
      const doomed = entry.moves.find((m) => compact(m) === compact(move));
      if (!doomed) continue;
      const legal = new Set(this.learnable(entry.pokemon, entry.form).map(compact));
      const held = new Set(entry.moves.map(compact));
      const swap = this.sg.usage(entry.pokemon, "move", 14).find((m) => !held.has(compact(m)) && !["trickroom", "tailwind"].includes(compact(m)) && (!legal.size || legal.has(compact(m))));
      if (!swap) continue;
      entries[i] = { ...entry, moves: entry.moves.map((m) => (m === doomed ? swap : m)) };
      log.push(`Speed mode: ${entry.pokemon}: ${doomed} -> ${swap}`);
    }
  }

  // --- team_set_refinement_v505 ---------------------------------------------------------

  /** mon_for: the set as the candidate-variant builder makes it (V113 forced set, then V494 Mega). */
  monFor(name, item, ability, spread, moves) {
    const species = this.sg.usageName(name);
    const mon = this.ev.commonMon(species, species);
    if (item) mon.item = item;
    if (ability) mon.ability = ability;
    if (moves?.length) mon.moves = moves.slice(0, 4);
    if (spread && Object.keys(spread).length) {
      mon.nature_name = String(spread.nature_name || spread.name || mon.nature_name || "Serious");
      mon.bonuses = (spread.bonuses || mon.bonuses || [0, 0, 0, 0, 0, 0]).slice(0, 6);
    }
    mon.analysis_side = "team";
    for (const stat of ["attack_stage", "defense_stage", "sp_attack_stage", "sp_defense_stage", "speed_stage"]) if (stat in mon) mon[stat] = 0;
    this.ev.applyStages(mon, this.ev.settings.my_stages);
    if (mon.item && this.ev.engine.isMegaStone(mon.item) && this.ev.isMegaItemForSpecies(mon.pokemon_name, mon.item)) {
      const form = this.ev.megaFormForItem(mon.pokemon_name, mon.item);
      if (form) {
        mon.form_name = form;
        mon.ability = this.ev.megaAbility(mon.pokemon_name, form, mon.ability);
      }
    }
    return this.ev.asMegaVariant(mon);
  }

  moveTable(mon, board, pool) {
    const table = new Map();
    const priority = new Map();
    for (const move of pool) {
      table.set(move, board.map(([threat]) => {
        try {
          const result = this.ev.bestAttack(mon, threat, [move]) || {};
          priority.set(compact(move), Math.max(priority.get(compact(move)) || 0, Number(result.move_priority) || 0));
          return Number(result.score) || 0;
        } catch {
          return 0;
        }
      }));
    }
    return { table, priority };
  }

  incomingScore(mon, board, weights) {
    let total = 0;
    let used = 0;
    board.forEach(([threat], i) => {
      if (weights[i] <= 0) return;
      total += weights[i] * this.score(threat, mon, threat.moves);
      used += weights[i];
    });
    return used > 0 ? total / used : 0;
  }

  outgoingScore({ table }, moves, weights) {
    const rows = moves.map((m) => table.get(m)).filter(Boolean);
    if (!rows.length) return 0;
    let total = 0;
    let used = 0;
    weights.forEach((w, i) => {
      if (w <= 0) return;
      total += w * Math.max(0, ...rows.map((r) => r[i] ?? 0));
      used += w;
    });
    return used > 0 ? total / used : 0;
  }

  tradeable(tables, move) {
    const row = tables.table.get(move) || [];
    if (!row.some((v) => v > 0)) return false;
    if (compact(move) === "fakeout") return false;
    if ((tables.priority.get(compact(move)) || 0) > 0) return false;
    const record = this.ev.engine.moveRecord(move);
    if (this.ev.format !== "Singles" && (record?.spread || record?.registry_spread)) return false;
    return true;
  }

  bestAttacks(tables, pool, slots, weights) {
    const options = pool.filter((m) => this.tradeable(tables, m));
    if (slots <= 0 || !options.length) return [];
    if (options.length <= slots) return [...options];
    let best = [-1, []];
    const choose = (start, picked) => {
      if (picked.length === slots) {
        const score = this.outgoingScore(tables, picked, weights);
        if (score > best[0]) best = [score, [...picked]];
        return;
      }
      for (let i = start; i < options.length; i += 1) {
        picked.push(options[i]);
        choose(i + 1, picked);
        picked.pop();
      }
    };
    choose(0, []);
    return best[1];
  }

  /** ability_is_visible: does the damage engine model this Ability at all? */
  abilityVisible(name, item, ability, spread, moves, board, weights) {
    if (!String(ability || "").trim()) return true;
    const withIt = this.monFor(name, item, ability, spread, moves);
    const without = this.monFor(name, item, ability, spread, moves);
    without.ability = "";
    const here = this.moveTable(withIt, board, moves).table;
    const there = this.moveTable(without, board, moves).table;
    for (const move of moves) if (JSON.stringify(here.get(move)) !== JSON.stringify(there.get(move))) return true;
    return this.incomingScore(withIt, board, weights) !== this.incomingScore(without, board, weights);
  }

  /** refine_team: each slot's set for the team it is on; kept unless 3 points better against the board. */
  refineSets(entries, spreads, log, preferredMode = "") {
    const board = this.threatBoard(12);
    if (!board.length) return;
    const weights = board.map(([, position]) => this.threatWeight(position));
    const liveSlots = this.slotsFor(entries, spreads);
    const plan = speedModePlan(liveSlots.map(({ entry, mon }) => this.synergy.profile(entry, mon)), this.synergy.metaSpeedRows());
    // As in resolveSpeedMode: the Trick Room / Tailwind a chosen archetype is built on stays.
    if (preferredMode) plan.mode = preferredMode;
    const context = { teamEntries: entries.filter(valid), fieldEntries: entries.filter(valid) };
    for (let slotIndex = 0; slotIndex < entries.length; slotIndex += 1) {
      const entry = entries[slotIndex];
      if (!valid(entry)) continue;
      const { pokemon: name, item, form, ability, moves } = entry;
      const sets = this.sg.v113Sets({ name, form }, 6, context);
      const legal = new Set(this.learnable(name, form).map(compact));
      const pool = [];
      for (const move of [...moves, ...sets.flatMap((row) => row.moves || []), ...this.sg.usage(name, "move", 10)]) {
        const k = compact(move);
        if (!k || pool.some((m) => compact(m) === k)) continue;
        if (legal.size && !legal.has(k) && !moves.some((m) => compact(m) === k)) continue;
        pool.push(move);
        if (pool.length >= 10) break;
      }
      if (!pool.length) continue;
      const spread = { nature_name: spreads[slotIndex]?.nature_name || "Serious", bonuses: spreads[slotIndex]?.bonuses || [0, 0, 0, 0, 0, 0] };
      const lockedItem = item && this.ev.engine.isMegaStone(item) ? item : "";
      let lockedAbility = lockedItem ? this.ev.megaAbility(name, form, ability) || ability : "";
      if (!lockedAbility && !this.abilityVisible(name, item, ability, spread, moves, board, weights)) lockedAbility = ability;
      const taken = new Set(entries.filter((e, i) => i !== slotIndex && valid(e) && e.item).map((e) => compact(e.item)));
      const options = [];
      const seen = new Set();
      const add = (optItem, optAbility) => {
        const it = String(lockedItem || optItem || "");
        const ab = String(lockedAbility || optAbility || "");
        if (compact(it) && taken.has(compact(it))) return;
        if (!lockedItem && it && this.ev.engine.isMegaStone(it)) return;
        const k = `${compact(it)}|${compact(ab)}`;
        if (seen.has(k)) return;
        seen.add(k);
        options.push({ item: it, ability: ab });
      };
      add(item, ability);
      for (const row of sets) add(row.item, ability);
      for (const row of sets) add(item, row.ability);
      let best = null;
      let baseline = null;
      options.forEach((option, index) => {
        const mon = this.monFor(name, option.item, option.ability, spread, moves);
        const tables = this.moveTable(mon, board, pool);
        const keep = moves.filter((m) => !this.tradeable(tables, m) && !(["trickroom", "tailwind"].includes(compact(m)) && compact(m) !== plan.mode));
        const chosen = [...keep, ...this.bestAttacks(tables, pool, Math.max(0, 4 - keep.length), weights)];
        const incoming = this.incomingScore(mon, board, weights);
        const score = this.outgoingScore(tables, chosen, weights) - incoming;
        if (index === 0) baseline = this.outgoingScore(tables, moves, weights) - incoming;
        if (baseline === null || score < baseline + 3) return;
        if (best && score <= best.score) return;
        best = { item: option.item, ability: option.ability, moves: chosen.slice(0, 4), score, gain: score - baseline };
      });
      if (!best) continue;
      const lost = moves.filter((m) => !best.moves.some((x) => compact(x) === compact(m)));
      const gained = best.moves.filter((m) => !moves.some((x) => compact(x) === compact(m)));
      const parts = lost.map((m, i) => (gained[i] ? `${m} -> ${gained[i]}` : `-${m}`)).concat(gained.slice(lost.length).map((m) => `+${m}`));
      if (compact(best.item) !== compact(item)) parts.push(`${item || "no item"} -> ${best.item || "no item"}`);
      if (compact(best.ability) !== compact(ability)) parts.push(`${ability || "no ability"} -> ${best.ability}`);
      log.push(`Auto Build retuned ${name}: ${parts.join(", ") || "no visible change"} (+${best.gain.toFixed(1)} against the current threats)`);
      entries[slotIndex] = { ...entry, item: best.item, ability: best.ability, moves: best.moves };
    }
  }


  /**
   * autobuild_finetune_v504 (the dialog's "Optimize Stat Points"): each member's Stat
   * Points and Nature tuned by Optimize, kept when it gains at least 1.5.
   */
  finetune(entries, spreads, log, progress) {
    const optimizer = new TeamOptimizer(this.evaluation);
    const sets = entries.map((e, i) => (valid(e) ? { species: e.pokemon, form: e.form, item: e.item, ability: e.ability, moves: e.moves, nature: spreads[i]?.nature_name || "Serious", bonuses: [...(spreads[i]?.bonuses || [0, 0, 0, 0, 0, 0])] } : null));
    entries.forEach((entry, slot) => {
      if (!valid(entry)) return;
      const result = optimizer.optimize(sets, slot, {
        optimizeNature: true,
        onProgress: (fraction, message) => progress(0.97 + (0.03 * (slot + fraction)) / TEAM_SIZE, `Stat Points and Nature · ${entry.pokemon} · ${message}`),
      });
      if (!result.ok || !(result.score >= 1.5) || !(result.spread?.bonuses || []).length) return;
      spreads[slot] = { ...result.spread };
      sets[slot] = { ...sets[slot], nature: result.spread.nature_name, bonuses: [...result.spread.bonuses] };
      log.push(`Auto Build tuned ${entry.pokemon}: ${result.spread.nature_name} nature, tuned spread (+${result.score.toFixed(1)} against the Top Meta)`);
    });
  }

  defensiveWarnings(slots) {
    const row = this.checks.checkDefensiveSwitchIns(this.checks.profiles(slots));
    return new Set((row.type_rows_v251 || []).filter((r) => ["yellow", "red"].includes(r.severity)).map((r) => r.type)).size;
  }

  megaStoneSlots(entries) {
    return entries.map((e, i) => (valid(e) && e.item && this.ev.engine.isMegaStone(e.item) ? i : -1)).filter((i) => i >= 0);
  }
}

export { MAX_MEGA_STONES, MEGA_ITEM_LOOKUP_DEPTH };
