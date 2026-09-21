// Optimize, ported from the Companion app (stat_optimization.install_stat_optimization
// over the V159-V178 slot optimiser).
//
// One team member's Stat Points are tuned against every Top-X threat (two
// variants each): each 8, 4, 2 and 1-point transfer between invested stats is
// tried, and a transfer is kept only when it improves the rank-weighted score -
// OHKO/2HKO thresholds and odds, in and out, plus a Speed term worth at most 10
// points for passing threats the old spread did not. The moves stay as they are;
// Auto Build's optional pass also searches the Nature.

import { compact, makeMon } from "./engine.js";
import { TeamSuggestions } from "./team-suggest.js";

const TOP_MOVE_LIMIT = 6; // _V175_TOP_MOVE_LIMIT: 8, lowered to 6 by the fast-calc defaults (part_018)
const MAX_POINTS = 32; // MAX_BONUS_POINTS_PER_STAT

/** stat_optimization.matchup_weight: rank 1 counts three times, the tail once. */
export function matchupWeight(rank) {
  const r = Math.max(1, Number.parseInt(rank, 10) || 9999);
  return 1 + 2 / (1 + (r - 1) / 8);
}

function* transferCandidates(points, step, maximum = MAX_POINTS) {
  for (let donor = 0; donor < points.length; donor += 1) {
    if (points[donor] <= step) continue;
    for (let recipient = 0; recipient < 6; recipient += 1) {
      if (donor === recipient || points[recipient] + step > maximum) continue;
      const candidate = [...points];
      candidate[donor] -= step;
      candidate[recipient] += step;
      yield candidate;
    }
  }
}

/** stat_optimization.refine_points: coarse-to-fine coordinate ascent; ties keep the current spread. */
export function refinePoints(points, evaluate, maximum = MAX_POINTS, progress = null) {
  let current = [...points];
  const cache = new Map();
  const score = (candidate) => {
    const k = candidate.join(",");
    if (!cache.has(k)) cache.set(k, evaluate(candidate));
    return cache.get(k);
  };
  let best = score(current);
  for (const step of [8, 4, 2, 1]) {
    for (;;) {
      let winner = null;
      let value = best;
      for (const candidate of transferCandidates(current, step, maximum)) {
        const v = score(candidate);
        if (v > value + 0.01) {
          winner = candidate;
          value = v;
        }
      }
      progress?.(cache.size, step);
      if (!winner) break;
      current = winner;
      best = value;
    }
  }
  return [current, best, cache.size];
}

/** stat_optimization.choose_nature: every Nature on the same investment; ties keep the current one. */
export function chooseNature(spread, evaluate, effects, progress = null) {
  let best = structuredClone(spread);
  let score = evaluate(best);
  const list = Object.entries(effects || {});
  list.forEach(([name, pair], index) => {
    const candidate = { ...spread, name, nature_name: name, nature: [...pair] };
    const value = evaluate(candidate);
    if (value > score + 0.01) {
      best = candidate;
      score = value;
    }
    progress?.(index + 1, list.length, name);
  });
  return [best, score, list.length + 1];
}

/** _v175_chance_for_hits: the chance that `hits` hits add up to the defender's HP. */
export function chanceForHits(result, hits) {
  const hp = Number.parseInt(result?.current_hp || result?.max_hp || 0, 10) || 0;
  if (hp <= 0) return 0;
  let dist = new Map([[0, 1]]);
  for (let hit = 0; hit < Math.max(1, hits); hit += 1) {
    let key = "rolls";
    if (hit <= 0) key = result.rolls_with_resist_berry?.length ? "rolls_with_resist_berry" : "rolls";
    else key = result.rolls_without_resist_berry?.length ? "rolls_without_resist_berry" : "rolls";
    let rolls = (result[key] || []).map((r) => Math.trunc(Number(r))).filter((r) => Number.isFinite(r));
    if (!rolls.length && key !== "rolls") rolls = (result.rolls || []).map((r) => Math.trunc(Number(r)));
    if (!rolls.length) return 0;
    const per = 1 / rolls.length;
    const next = new Map();
    for (const [total, prob] of dist) {
      for (const damage of rolls) next.set(total + damage, (next.get(total + damage) || 0) + prob * per);
    }
    dist = next;
  }
  let sum = 0;
  for (const [total, prob] of dist) if (total >= hp) sum += prob;
  return Math.max(0, Math.min(1, sum));
}

const hitRank = (result) => {
  const hits = Number.parseInt(result?.hits ?? 99, 10) || 99;
  return hits > 0 ? hits : 99;
};

const speedSuppressed = (result) => {
  if (!result || typeof result !== "object") return false;
  if (result.speed_tier_suppressed) return true;
  const label = String(result.label || result.full_label || result.ko || "").toLowerCase();
  return label.includes("no ko before fainting") || label.includes("knocked out before it can ko");
};

/** _v178_threshold_delta */
function thresholdDelta(direction, oldHits, newHits) {
  if (direction === "defense") {
    if (oldHits === 1 && newHits >= 2) return 98;
    if (oldHits === 2 && newHits >= 3) return 64;
    if (oldHits >= 3 && newHits === 2) return -68;
    if (oldHits >= 2 && newHits === 1) return -95;
  } else {
    if (oldHits === 2 && newHits === 1) return 96;
    if (oldHits >= 3 && newHits === 2) return 52;
    if (oldHits === 1 && newHits >= 2) return -100;
    if (oldHits === 2 && newHits >= 3) return -66;
  }
  return 0;
}

const noDamage = (move = "", label = "No damaging move") => ({ hits: 99, chance: 0, label, full_label: label, move, score: 0, percent: "0-0%" });

export class TeamOptimizer {
  /** @param {TeamEvaluation} evaluation */
  constructor(evaluation) {
    this.evaluation = evaluation;
    this.ev = evaluation.ev;
    this.sg = new TeamSuggestions(evaluation);
  }

  get settings() {
    return this.ev.settings;
  }

  /** _v159_damaging_move */
  damaging(move) {
    const record = this.ev.engine.moveRecord(move);
    if (!record) return false;
    return ["physical", "special"].includes(String(record.category || "").toLowerCase()) && (Number(record.power) || 0) > 0;
  }

  /** _v166_calc_moves: damaging, not excluded, unique, up to `limit`. */
  calcMoves(moves, limit = 12) {
    const excluded = new Set(String(this.settings.exclude_moves || "").split(/[,;]/).map((m) => m.trim().toLowerCase()).filter(Boolean));
    const out = [];
    const seen = new Set();
    for (const move of moves || []) {
      const clean = String(move || "").trim();
      const k = clean.toLowerCase();
      if (!clean || seen.has(k) || excluded.has(k) || !this.damaging(clean)) continue;
      seen.add(k);
      out.push(clean);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * _v159_calc_one: the optimiser's own single-move calc - the matchup context, the
   * engine, the KO summary and the recharge/cooldown turns; not Team Evaluation's
   * best-attack stack (so a charge move counts its charge turn here).
   */
  calcOne(attacker, defender, move) {
    if (!move || !this.damaging(move)) return noDamage(move, "Ignored non-damaging move");
    try {
      const ctx = this.ev.calcContext(attacker, defender, move);
      const result = this.ev.calculate(attacker, defender, ctx);
      const raw = this.ev.applyCooldown(move, this.ev.koSummary(result), result);
      const full = this.ev.fullKoSummary(move, result, 10);
      return {
        hits: hitRank(raw), chance: Number(raw.chance) || 0, label: String(raw.label || full.label || "No damage"),
        full_label: String(full.label || raw.label || "No damage"), move, percent: String(result.percent || "0-0%"), score: Number(raw.score) || 0,
        attacker_speed: this.ev.engine.effectiveSpeed(makeMon(attacker), {}), move_priority: this.ev.movePriority(move),
        rolls: [...(result.rolls || [])], current_hp: result.current_hp, max_hp: result.max_hp, one_time_resist_berry: result.one_time_resist_berry || "",
        rolls_with_resist_berry: [...(result.rolls_with_resist_berry || [])], rolls_without_resist_berry: [...(result.rolls_without_resist_berry || [])],
      };
    } catch (error) {
      return { hits: 99, chance: 0, label: String(error?.message || error), move, score: 0 };
    }
  }

  /** _v159_best_for_moves: fewest hits, then priority (with Speed Tiers), chance and score. */
  bestForMoves(attacker, defender, moves) {
    const calc = this.calcMoves(moves, Math.max(4, TOP_MOVE_LIMIT + 4));
    let best = noDamage();
    if (!calc.length) return best;
    const usePriority = this.settings.use_speed_tiers !== false;
    const key = (r) => [-hitRank(r), usePriority ? Number.parseInt(r.move_priority, 10) || 0 : 0, Number(r.chance) || 0, Number(r.score) || 0];
    for (const move of calc) {
      const result = this.calcOne(attacker, defender, move);
      const a = key(result);
      const b = key(best);
      let greater = false;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
          greater = a[i] > b[i];
          break;
        }
      }
      if (greater) best = result;
    }
    return best;
  }

  /** _v175_threat_calc_moves: its moves, then its most used damaging moves. */
  threatCalcMoves(threat) {
    const base = [...(threat.moves || [])];
    const name = String(threat.pokemon_name || "");
    const pool = [...this.ev.commonMoves(name, base, TOP_MOVE_LIMIT), ...this.sg.usage(name, "move", TOP_MOVE_LIMIT), ...this.sg.usage(name, "move", TOP_MOVE_LIMIT)];
    const top = [];
    const seen = new Set();
    for (const move of pool) {
      const k = compact(move);
      if (!k || seen.has(k) || !this.damaging(move)) continue;
      seen.add(k);
      top.push(move);
      if (top.length >= TOP_MOVE_LIMIT) break;
    }
    return this.calcMoves([...base, ...top], 4 + TOP_MOVE_LIMIT);
  }

  /** _v166_best_pair: both directions, in Speed order. */
  bestPair(threat, mon, lockedCalcMoves) {
    const incoming = this.bestForMoves(threat, mon, this.threatCalcMoves(threat));
    const outgoing = this.bestForMoves(mon, threat, lockedCalcMoves);
    if (this.settings.use_speed_tiers === false) return [incoming, outgoing];
    const [inc, out] = this.ev.applySpeedOrder(incoming, outgoing);
    return [inc || {}, out || {}];
  }

  /** _v159_mon_for_entry */
  monFor(set, slot, spread, moves) {
    return this.ev.teamMon({ ...set, moves: moves?.length ? moves : set.moves, nature: spread.nature_name || spread.name || "Serious", bonuses: spread.bonuses }, slot);
  }

  speed(mon) {
    return Math.max(1, Math.trunc(this.ev.engine.effectiveSpeed(structuredClone(mon), {}) || 1));
  }

  /** _v178_spread_score_comparison, re-weighted by stat_optimization.matchup_weight. */
  comparison(direction, baseName, threatName, oldResult, newResult, rank, topLimit) {
    const oldHits = hitRank(oldResult);
    const newHits = hitRank(newResult);
    if (!(oldHits <= 2 || newHits <= 2) || speedSuppressed(oldResult) || speedSuppressed(newResult)) return [0, null];
    const oldOhko = chanceForHits(oldResult, 1);
    const newOhko = chanceForHits(newResult, 1);
    const old2 = chanceForHits(oldResult, 2);
    const new2 = chanceForHits(newResult, 2);
    const threshold = thresholdDelta(direction, oldHits, newHits);
    let gain;
    let loss;
    if (direction === "defense") {
      gain = Math.max(0, oldOhko - newOhko) * 105 + Math.max(0, old2 - new2) * 42;
      loss = Math.max(0, newOhko - oldOhko) * 110 + Math.max(0, new2 - old2) * 48;
    } else {
      gain = Math.max(0, newOhko - oldOhko) * 100 + Math.max(0, new2 - old2) * 36;
      loss = Math.max(0, oldOhko - newOhko) * 108 + Math.max(0, old2 - new2) * 44;
    }
    const weight = 1 + Math.max(0, (topLimit - rank) / Math.max(1, topLimit));
    let delta = (threshold + gain - loss) * weight;
    if (Math.abs(delta) < 0.01) return [0, null];
    delta *= matchupWeight(rank) / weight;
    const line = (attacker, defender, result) => `${attacker} ${result?.move || "best move"} -> ${defender}: ${result?.label || result?.ko || "No damage"}${result?.percent && !String(result.label || "").startsWith("Guaranteed") ? ` | ${result.percent}` : ""}`;
    const [previous, now] = direction === "defense"
      ? [line(threatName, baseName, oldResult), line(threatName, baseName, newResult)]
      : [line(baseName, threatName, oldResult), line(baseName, threatName, newResult)];
    const pct = (v) => Math.round(v * 100);
    return [delta, {
      kind: direction === "defense" ? "Defensive score" : "Offensive score", threat: threatName, previous, now, score: delta, meta_rank: rank,
      detail: `Top ${rank}: ${direction === "defense" ? "incoming" : "outgoing"} score ${delta > 0 ? "improved" : "worsened"} ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}. OHKO ${pct(oldOhko)}% -> ${pct(newOhko)}%, 2HKO ${pct(old2)}% -> ${pct(new2)}%.`,
    }];
  }

  /** _v171_evaluate_spread */
  evaluateSpread(rows, set, slot, spread, moves, calcMoves, baseName, topLimit, keep) {
    const mon = this.monFor(set, slot, spread, moves);
    let score = 0;
    const comparisons = [];
    for (const row of rows) {
      const [newIn, newOut] = this.bestPair(row.threat, mon, calcMoves);
      const [d, dRow] = this.comparison("defense", baseName, row.name, row.incoming, newIn, row.rank, topLimit);
      const [o, oRow] = this.comparison("offense", baseName, row.name, row.outgoing, newOut, row.rank, topLimit);
      score += d + o;
      if (keep) {
        if (dRow) comparisons.push(dRow);
        if (oRow) comparisons.push(oRow);
      }
    }
    comparisons.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    return { score, comparisons };
  }

  /**
   * _v181_optimize_slot_core (stat_optimization)
   * @param {Array<object|null>} sets  the team (builder sets)
   * @param {number} slot              the member to tune
   */
  optimize(sets, slot, { optimizeNature = false, onProgress } = {}) {
    const set = sets[slot];
    if (!set?.species) return { ok: false, message: "This slot is empty." };
    const common = this.ev.commonSet(this.sg.usageName(set.species)) || {};
    let current = { name: set.nature || "Serious", nature_name: set.nature || "Serious", nature: [...(this.ev.engine.natures?.[set.nature || "Serious"] || ["", ""])], bonuses: [...(set.bonuses || [0, 0, 0, 0, 0, 0])] };
    if (!current.bonuses.some(Number)) {
      const nature = common.nature_name || "Serious";
      current = { name: "Most common set", nature_name: nature, nature: [...(this.ev.engine.natures?.[nature] || ["", ""])], bonuses: [...(common.bonuses || [0, 0, 0, 0, 0, 0])], rank: 1 };
    }
    const points = [...current.bonuses];
    if (!points.some(Number)) return { ok: false, message: "No common stat distribution is available for this Pokemon.", spread: current };
    const moves = ((set.moves || []).filter(Boolean).length ? set.moves : common.moves || []).filter(Boolean).slice(0, 4);
    const calcMoves = this.calcMoves(moves, 4);
    const topLimit = Math.max(1, Math.min(100, Number.parseInt(this.settings.top_meta, 10) || 30));
    const baseName = this.sg.name(set.form || set.species);
    const progress = (fraction, message) => onProgress?.(Math.max(0, Math.min(1, fraction)), message);

    // _v168_all_meta_rows_for_slot: two variants of every Top-X threat, against the current spread.
    const lockedMoves = [...new Set((set.moves || []).filter(Boolean))].slice(0, 4);
    const currentMon = this.monFor(set, slot, current, lockedMoves);
    const meta = this.ev.topMeta(topLimit).slice(0, topLimit);
    const rows = [];
    meta.forEach((threatRow, index) => {
      if (index === 0 || (index + 1) % 8 === 0) progress((0.2 * index) / Math.max(1, meta.length), `Preparing Top ${topLimit} meta threats (${index + 1}/${meta.length})`);
      const variants = this.sg.threatVariantsForSuggestion(threatRow).slice(0, 2);
      for (const threat of variants) {
        const [incoming, outgoing] = this.bestPair(threat, currentMon, calcMoves);
        rows.push({ threat, rank: index + 1, name: this.sg.name(threat.form_name || threat.pokemon_name), incoming, outgoing });
      }
    });
    this.lastRows = rows;
    if (!rows.length) return { ok: false, message: "No meta matchups were available.", spread: current };

    const original = structuredClone(current);
    const originalSpeed = this.speed(this.monFor(set, slot, original, moves));
    const benchmarks = rows.map((row) => [this.speed(row.threat), matchupWeight(row.rank)]);
    const totalWeight = benchmarks.reduce((sum, [, w]) => sum + w, 0) || 1;
    const relation = (own, other) => (own > other ? 1 : own === other ? 0.5 : 0);
    const details = new Map();
    let tested = 0;
    const evaluate = (candidate) => {
      const spread = { ...current, bonuses: [...candidate] };
      const damage = this.evaluateSpread(rows, set, slot, spread, moves, calcMoves, baseName, topLimit, false).score;
      const speed = this.speed(this.monFor(set, slot, spread, moves));
      // At most 10 points across the entire meta; no per-context stacking.
      const speedGain = (10 * benchmarks.reduce((sum, [other, w]) => sum + (relation(speed, other) - relation(originalSpeed, other)) * w, 0)) / totalWeight;
      details.set(candidate.join(","), [damage, speedGain]);
      return damage + speedGain;
    };
    const stepProgress = (start, end) => (count) => progress(start + ((end - start) * count) / (count + 30), `Testing Stat Point transfers; ${count} spreads checked`);
    let [best, score, count] = refinePoints(points, evaluate, MAX_POINTS, stepProgress(0.2, optimizeNature ? 0.65 : 0.99));
    tested += count;
    current.bonuses = best;
    if (optimizeNature) {
      const natureScore = (spread) => {
        Object.assign(current, spread);
        return evaluate(best);
      };
      const [nature, , natureCount] = chooseNature({ ...current }, natureScore, this.ev.engine.natures || {}, (done, total, name) => progress(0.65 + (0.15 * done) / total, `Comparing ${name} Nature`));
      Object.assign(current, nature);
      tested += natureCount;
      [best, score, count] = refinePoints(best, evaluate, MAX_POINTS, stepProgress(0.8, 0.99));
      current.bonuses = best;
      tested += count;
    }
    const damageEval = this.evaluateSpread(rows, set, slot, current, moves, calcMoves, baseName, topLimit, true);
    const [damageScore, speedScore] = details.get(best.join(",")) || [0, 0];
    const result = {
      ok: score > 0.01, name: set.species, score, spread: current, original, moves, current_moves: moves, locked_moves: true,
      comparisons: damageEval.comparisons, damage_score_v404: damageScore, speed_order_score_v404: speedScore,
      speed_before: originalSpeed, speed_after: this.speed(this.monFor(set, slot, current, moves)),
      top_meta: topLimit, meta_seen: meta.length, target_count: rows.length, tested_spreads: tested,
      search_method: "Rank-weighted 8/4/2/1-point transfers across all invested stats",
    };
    result.improved = result.comparisons.filter((row) => row.score > 0.01).length;
    result.worsened = result.comparisons.filter((row) => row.score < -0.01).length;
    if (!result.ok) result.message = "No gradual transfer improves the ranked matchups; keep the current investment.";
    progress(1, "Done");
    return result;
  }
}
