// Team Evaluation as one payload, assembled the way the Companion app does it
// (TeamAnalysisPanel.compute_analysis_payload_v36 and its layers):
//
//   v45/v101  filled slots, Exclude Pokemon removed
//   team_threats            builder/team-eval.js (threat rows, pressure overview)
//   speed_control           builder/team-speed.js, scaled by active slots / 6 (v47)
//   v49       which weather/terrain each threat's calcs used, the threat's item
//   v188      Offense/Defense from the pressure overview
//   v241      Team Synergy (builder/team-synergy.js)
//   v377      move-order prose removed from the calc rows
//   v462      only 1-3HKO threats stay in Critical Threats
//   v466/v494 a condition banner only when the condition changes the result
//   checks    Team Building Checks and the archetype (builder/team-checks.js)

import { compact } from "./engine.js";
import { TeamChecks, tailwindBeneficiaries } from "./team-checks.js";
import { TeamSpeed } from "./team-speed.js";
import { TeamSynergy } from "./team-synergy.js";
import { coloredThreats, percentBounds, koTier, PROTECT_FAMILY_FROM_RULE } from "./team-eval.js";

const TEAM_SIZE = 6;
const ORDER_NOTE_KEYS = new Set(["speed_note", "speed_tier_note", "move_order_note", "order_note"]);
const PRIMARY_CONDITIONS = ["Rain", "Sun", "Sand", "Snow", "Trick Room", "Tailwind", "Electric Terrain", "Grassy Terrain", "Psychic Terrain", "Misty Terrain"];
const SPEED_CONDITIONS = ["Trick Room", "Tailwind"];

function clamp(value, low = 0, high = 100) {
  const v = Number(value);
  return Math.max(low, Math.min(high, Number.isFinite(v) ? v : 0));
}

/** team_evaluation_v462.qualifies_critical_damage_threat */
export function isCriticalThreat(row) {
  if (!row || typeof row !== "object") return false;
  const best = row.their_best;
  if (best && typeof best === "object" && Object.keys(best).length) {
    const hits = Number.parseInt(best.hits ?? 99, 10) || 99;
    return [1, 2, 3].includes(hits) && (Number(best.chance) || 0) > 0;
  }
  let strongestHits = 99;
  let strongestChance = 0;
  for (const breakdown of row.breakdown || []) {
    const result = breakdown?.incoming_result || {};
    const hits = Number.parseInt(result.hits ?? 99, 10) || 99;
    const chance = Number(result.chance) || 0;
    if (chance <= 0) continue;
    if (hits < strongestHits || (hits === strongestHits && chance > strongestChance)) {
      strongestHits = hits;
      strongestChance = chance;
    }
  }
  return [1, 2, 3].includes(strongestHits) && strongestChance > 0;
}

/** _v367_clean_ko_label */
export function cleanKoLabel(text) {
  return String(text ?? "").trim().replace(/\b0(?:\.0+)?%\s+(?:chance\s+)?(?:to\s+)?(OHKO|[2-9]HKO)\b/gi, (_m, ko) => `Less than 1% chance to ${ko}`);
}

/** team_evaluation_v465.display_result_copy: a >=100% range reads as a Guaranteed OHKO. */
export function displayResultCopy(result) {
  const data = { ...(result || {}) };
  const [low] = percentBounds(data.percent);
  if (low >= 100) {
    data.label = "Guaranteed OHKO";
    data.full_label = "Guaranteed OHKO";
    data.hits = 1;
  }
  return data;
}

function percentAndLabel(data) {
  const percent = String(data?.percent || "").trim();
  const label = cleanKoLabel(data?.label || data?.full_label || "No damage");
  if (percent && label && label.toLowerCase() !== "no damage") return `${percent} ${label}`;
  return percent || label || "No damage";
}

/** _v35_best_rank_from_result through _v420_hit_rank */
function hitRank(result, baseline = false) {
  const base = result?.baseline_result_v420;
  const data = baseline && base && typeof base === "object" ? base : result || {};
  const hits = Number.parseInt(data.hits, 10);
  return [1, 2, 3].includes(hits) ? hits : 6;
}

function firstSide(incoming, outgoing, settings, baseline) {
  const inPriority = Number.parseInt(incoming.move_priority ?? 0, 10) || 0;
  const outPriority = Number.parseInt(outgoing.move_priority ?? 0, 10) || 0;
  if (inPriority !== outPriority) return inPriority > outPriority ? "threat" : "team";
  const k = baseline ? "baseline_speed_v420" : "attacker_speed";
  const inSpeed = Number(incoming[k] ?? incoming.attacker_speed ?? 0) || 0;
  const outSpeed = Number(outgoing[k] ?? outgoing.attacker_speed ?? 0) || 0;
  if (inSpeed === outSpeed) return "tie";
  const trickRoom = Boolean(settings.trick_room) && !baseline;
  return (trickRoom ? inSpeed < outSpeed : inSpeed > outSpeed) ? "threat" : "team";
}

function winnerUnderOrder(incoming, outgoing, first, baseline) {
  const inHits = hitRank(incoming, baseline);
  const outHits = hitRank(outgoing, baseline);
  const inEvent = inHits < 99 ? inHits * 2 - (first === "threat" ? 1 : 0) : 9999;
  const outEvent = outHits < 99 ? outHits * 2 - (first === "team" ? 1 : 0) : 9999;
  return inEvent < outEvent ? "threat" : outEvent < inEvent ? "team" : "tie";
}

/** _v420_race_winner */
function raceWinner(incoming, outgoing, settings, baseline) {
  return winnerUnderOrder(incoming, outgoing, firstSide(incoming, outgoing, settings, baseline), baseline);
}

function conditionNames(incoming, outgoing, settings) {
  const values = [];
  for (const value of [...(incoming.condition_names_v420 || []), ...(outgoing.condition_names_v420 || [])]) {
    const text = String(value ?? "").trim();
    if (text && !values.includes(text)) values.push(text);
  }
  if (settings.trick_room && !values.includes("Trick Room")) values.push("Trick Room");
  return values;
}

function primaryCondition(names) {
  for (const wanted of PRIMARY_CONDITIONS) {
    for (const value of names) if (String(value).toLowerCase() === wanted.toLowerCase()) return wanted;
  }
  return names.length ? String(names[0]) : "The active condition";
}

export class TeamEvaluation {
  /** @param {TeamEvaluator} evaluator */
  constructor(evaluator) {
    this.ev = evaluator;
    this.checks = new TeamChecks(evaluator);
    this.synergy = new TeamSynergy(evaluator, this.checks);
    this.speed = new TeamSpeed(evaluator, this.checks, this.synergy);
  }

  name(value) {
    return this.checks.showdownName(value);
  }

  /** _v101_team_entry_keys */
  entryKeys(entry, mon) {
    const keys = new Set();
    const add = (value) => {
      const text = String(value ?? "").trim();
      if (!text) return;
      const variants = new Set([text, text.replace(/-/g, " "), text.replace(/_/g, " ")]);
      if (/^mega[ -]/i.test(text)) variants.add(text.slice(5).trim());
      for (const v of variants) if (compact(v)) keys.add(compact(v));
    };
    add(entry.pokemon);
    add(entry.form);
    add(this.name(entry.form || entry.pokemon));
    if (entry.item && mon) {
      add(mon.form_name);
      add(this.name(mon.form_name));
    }
    return keys;
  }

  /**
   * The filled slots as the app reads them: valid, Exclude Pokemon removed.
   * @param {Array<object|null>} sets  website sets (species, form, item, ability, moves, nature, bonuses)
   */
  slots(sets) {
    const excluded = this.ev.excludedPokemonKeys();
    const out = [];
    (sets || []).slice(0, TEAM_SIZE).forEach((set) => {
      if (!set || !String(set.species || "").trim()) return;
      const entry = { pokemon: set.species, item: set.item || "", form: set.form || set.species, ability: set.ability || "", moves: (set.moves || []).filter(Boolean).slice(0, 4) };
      const mon = this.ev.teamMon(set, out.length);
      if (excluded.size && [...this.entryKeys(entry, mon)].some((k) => excluded.has(k))) return;
      out.push({ entry, mon, set });
    });
    out.forEach((slot, i) => {
      slot.mon.analysis_slot = i;
    });
    return out;
  }

  /** v494: a condition banner only when it flips the winner or moves the winner's KO stage. */
  conditionOutcome(breakdown, settings) {
    const clean = { ...(settings || {}), trick_room: false };
    const data = breakdown || {};
    const pick = (a, b) => (a && Object.keys(a).length ? a : b && Object.keys(b).length ? b : {});
    const incoming = { ...pick(data.raw_incoming_result, data.incoming_result) };
    const outgoing = { ...pick(data.raw_outgoing_result, data.outgoing_result) };
    const conditions = conditionNames(incoming, outgoing, clean);
    if (!conditions.length) return null;
    const before = raceWinner(incoming, outgoing, clean, true);
    const now = raceWinner(incoming, outgoing, clean, false);
    const condition = primaryCondition(conditions);
    const flips = before !== now && now !== "tie";
    if (flips && this.flippedBySpeedCondition(incoming, outgoing, clean, conditions)) return null;
    if (flips) {
      const side = (which) => (which === "team" ? outgoing : which === "threat" ? incoming : null);
      const describe = (which, useBaseline) => {
        const result = side(which);
        if (!result) return "the race was too close to call";
        const attacker = this.name(String(result.attacker || result.attacker_mon || "Pokemon"));
        const move = String(result.move || "—");
        let tail;
        if (useBaseline) {
          const baseline = result.baseline_result_v420 && Object.keys(result.baseline_result_v420).length ? result.baseline_result_v420 : result;
          tail = percentAndLabel(displayResultCopy(baseline));
        } else tail = percentAndLabel(displayResultCopy(result));
        return `${attacker} uses ${move} -> ${tail}`;
      };
      return {
        text: `${condition} changes the outcome.\nWithout ${condition}, ${describe(before, true)}. With ${condition}, ${describe(now, false)}.`,
        severity: now === "threat" ? "critical" : "helpful",
      };
    }
    const relevant = now === "team" ? outgoing : now === "threat" ? incoming : null;
    if (!relevant || !this.koStageChanged(relevant)) return null;
    let text = `${condition} changes the outcome.`;
    const line = this.beforeAfterLine(relevant, condition);
    if (line) text += `\n${line}`;
    return { text, severity: now === "threat" ? "critical" : "helpful" };
  }

  flippedBySpeedCondition(incoming, outgoing, settings, conditions) {
    const speedCondition = SPEED_CONDITIONS.find((wanted) => conditions.some((n) => String(n).trim().toLowerCase() === wanted.toLowerCase()));
    if (!speedCondition) return "";
    const beforeFirst = firstSide(incoming, outgoing, settings, true);
    const nowFirst = firstSide(incoming, outgoing, settings, false);
    if (beforeFirst === nowFirst) return "";
    const before = raceWinner(incoming, outgoing, settings, true);
    return winnerUnderOrder(incoming, outgoing, beforeFirst, false) !== before ? "" : speedCondition;
  }

  koStageChanged(result) {
    if (!result?.baseline_result_v420 || typeof result.baseline_result_v420 !== "object") return false;
    return koTier(result, true) !== koTier(result, false);
  }

  beforeAfterLine(chosen, condition) {
    const attacker = this.name(String(chosen.attacker || chosen.attacker_mon || "Pokemon"));
    const defender = this.name(String(chosen.defender || chosen.defender_mon || "the target"));
    const move = String(chosen.move || "—");
    const current = percentAndLabel(displayResultCopy(chosen));
    const baseline = chosen.baseline_result_v420 || {};
    if (!Object.keys(baseline).length) return `${attacker} uses ${move} against ${defender} -> ${current}`;
    const before = percentAndLabel(displayResultCopy(baseline));
    if (before === current) return `${attacker} uses ${move} against ${defender} -> ${current}`;
    return `${attacker} uses ${move} against ${defender} -> ${before} without ${condition}, ${current} with ${condition}`;
  }

  /** v49: the weather/terrain a threat's calcs used, its item and moves for display. */
  enrichThreat(threat) {
    const weather = new Set();
    const terrain = new Set();
    let bestItem = "";
    for (const k of ["their_best", "our_best", "our_best_speed_adjusted"]) {
      const result = threat[k] || {};
      if (result.weather && result.weather !== "None") weather.add(String(result.weather));
      if (result.terrain && result.terrain !== "None") terrain.add(String(result.terrain));
      if (k === "their_best" && result.attacker_item) bestItem = String(result.attacker_item);
    }
    for (const row of threat.breakdown || []) {
      for (const k of ["incoming_result", "outgoing_result", "raw_incoming_result", "raw_outgoing_result"]) {
        const result = row[k] || {};
        if (result.weather && result.weather !== "None") weather.add(String(result.weather));
        if (result.terrain && result.terrain !== "None") terrain.add(String(result.terrain));
        if (!bestItem && String(result.attacker_side || "").toLowerCase() === "threat" && result.attacker_item) bestItem = String(result.attacker_item);
      }
    }
    threat.weather_used = [...weather].sort();
    threat.terrain_used = [...terrain].sort();
    if (bestItem) threat.threat_item = bestItem;
    else if ((threat.top_items || []).length) threat.threat_item = String(threat.top_items[0] || "");
    threat.threat_moves_display = (threat.top_moves || []).map((m) => String(m).trim()).filter(Boolean).slice(0, 6).join(", ");
    return threat;
  }

  /** v377: display-only move-order prose goes; the KO adjustment stays. */
  removeOrderNotes(value) {
    if (Array.isArray(value)) value.forEach((child) => this.removeOrderNotes(child));
    else if (value && typeof value === "object") {
      for (const k of Object.keys(value)) {
        if (ORDER_NOTE_KEYS.has(k)) value[k] = "";
        else if (k === "details" && Array.isArray(value[k])) value[k] = value[k].filter((item) => !/^\s*(?:move order|speed tie)\s*:/i.test(String(item ?? "")));
        else this.removeOrderNotes(value[k]);
      }
    }
    return value;
  }

  /**
   * mega_count / protect_count, as the payload reports them.
   *
   * VERSION-SELECTED. From `score_composition` version 2 this is the app's own eight-move
   * `_SIMPLE_PROTECT_V187` family, read from the exported table rather than hand-copied (the
   * hand-copied duplicate here was the only place in either codebase that had forked it).
   * Below version 2 it is `_team_analysis_protect_count_v35`'s exact "Protect" test, which is
   * what a recording stamped 1 - or an unstamped one - was made with.
   */
  counts(team) {
    const [megaCount, megaNames] = this.checks.megaCount(team);
    const family = this.ev.scoreRules >= PROTECT_FAMILY_FROM_RULE
      ? this.checks.groups.protect
      : new Set(["protect"]);
    const protect = team.filter(({ entry }) => (entry.moves || []).some((m) => family.has(compact(m))));
    return { mega_count: megaCount, mega_names: megaNames, protect_count: protect.length, protect_names: protect.map(({ entry }) => String(entry.pokemon)) };
  }

  /**
   * compute_analysis_payload_v36 for the website.
   * @param {Array<object|null>} sets
   * @param {object} options  {checkSelection, onProgress(done, total, name)}
   */
  evaluate(sets, { checkSelection = null, onProgress } = {}) {
    const settings = this.ev.settings;
    const team = this.slots(sets);
    if (!team.length) {
      return {
        ok: true, settings, team: [], threats: [], offense_score: 0, defense_score: 0,
        speed: { score: 0, summary: "No active Pokémon in the team.", trick_room: 0, opposing_tailwind: 0, standard: 0, priority: 0, trick_lines: [], tailwind_lines: [], standard_lines: [], priority_lines: [] },
        synergy: null, synergy_score: 50, checks: this.checks.snapshot([], checkSelection), mega_count: 0, mega_names: [], protect_count: 0, protect_names: [],
      };
    }
    const teamMons = team.map(({ mon }) => mon);
    const evaluation = this.ev.teamThreats(teamMons, { onProgress });
    const factor = Math.max(0, Math.min(1, team.length / TEAM_SIZE));

    const synergyProfiles = team.map(({ entry, mon }) => this.synergy.profile(entry, mon));
    const checkProfiles = this.checks.profiles(team);
    const tailwind = tailwindBeneficiaries(synergyProfiles, this.synergy.metaSpeedRows());
    const features = this.checks.archetypeFeatures(checkProfiles, { tailwind });
    const speed = this.speed.control(team, { profiles: synergyProfiles, features });
    speed.score = clamp(speed.score * factor);

    const threats = evaluation.threats.map((row) => this.enrichThreat(row));
    this.removeOrderNotes(threats);
    const critical = threats.filter(isCriticalThreat).map((row) => structuredClone(row));
    for (const threat of critical) {
      const outcomes = [];
      for (const breakdown of threat.breakdown || []) {
        const outcome = this.conditionOutcome(breakdown, settings);
        if (outcome) {
          breakdown.conditional_outcome_v420 = outcome;
          outcomes.push(outcome);
        } else delete breakdown.conditional_outcome_v420;
      }
      threat.condition_outcomes_v420 = outcomes;
    }
    // The app scored the "Top Meta" pair line against whatever evaluation was on
    // screen before; both now use this evaluation's critical threats.
    const synergy = this.synergy.team(team, { threats: critical, format: this.ev.format });
    const snapshot = this.checks.snapshot(team, checkSelection, { tailwind });
    return {
      ok: true,
      settings,
      team: team.map(({ entry }) => entry),
      slots: team,
      threats: critical,
      all_top_meta_threat_rows_v462: threats.length,
      critical_damage_only_v462: true,
      offense_score: clamp(evaluation.offense),
      defense_score: clamp(evaluation.defense),
      pressure_overview_v188: evaluation.overview,
      critical_threats_for_suggested_calcs_v188: coloredThreats(critical),
      speed,
      synergy,
      synergy_score: Number(synergy.score ?? 50),
      synergy_members: this.synergy.memberRows(synergy),
      checks: snapshot,
      archetype: snapshot.archetype_check_v403,
      features,
      meta_speed_rows: this.synergy.metaSpeedRows(),
      ...this.counts(team),
    };
  }
}
