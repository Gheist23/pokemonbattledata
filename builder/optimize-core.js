// The fast pieces the deep Optimize (builder/optimize-deep.js) is built from:
//
//  - koProfile: the chance a Pokemon is knocked out by its attacker's 1st, 2nd, 3rd
//    and 4th hit, from the damage rolls (the same maths as Team Evaluation's
//    chanceForHits: a resist berry on the first hit, misses from the move's accuracy);
//  - raceValue: who wins a one-on-one race to the KO, given both KO profiles and who
//    moves first;
//  - DamageMemo: damage calcs kept by the few final stats they read, so thousands of
//    Stat Point spreads share a handful of calcs;
//  - the Stat Point helpers (fill to 66, legal spreads, Nature effects).

import { MAX_BONUS_POINTS_PER_STAT, MAX_BONUS_STAT_POINTS } from "./engine.js";

/** Hits (or actions) a KO profile follows. */
export const PROFILE_HITS = 4;

const numericRolls = (list) => Array.from(list || []).filter((v) => typeof v === "number" && Number.isFinite(v)).map((v) => Math.trunc(v));

/** The rolls of one hit of a result, as team-eval's rollsForHit reads them. */
export function rollsForHit(result, hitIndex) {
  const r = result || {};
  const field = hitIndex <= 0
    ? (r.rolls_with_resist_berry && r.rolls_with_resist_berry.length ? "rolls_with_resist_berry" : "rolls")
    : (r.rolls_without_resist_berry && r.rolls_without_resist_berry.length ? "rolls_without_resist_berry" : "rolls");
  let rolls = numericRolls(r[field]);
  if (!rolls.length && field !== "rolls") rolls = numericRolls(r.rolls);
  return rolls;
}

/**
 * P(knocked out by hit n), n = 1..PROFILE_HITS (index 0 is always 0).
 * @param {Array<number[]>} hitRolls  the rolls of each hit; the last entry repeats
 * @param {number} hp                 the defender's HP
 * @param {number} accuracy           0..1, a miss deals nothing
 * @param {number|Array<[number, number]>} extra  damage taken every hit whether it lands
 *                                    or not (chip from the rest of the field): a fixed
 *                                    amount or [amount, chance] outcomes
 * @param {number} later              more fixed damage from the second hit on (Life Orb
 *                                    and recoil, which follow the defender's own attack;
 *                                    negative for HP drained back)
 */
export function koProfile(hitRolls, hp, accuracy = 1, extra = 0, later = 0) {
  const out = new Float64Array(PROFILE_HITS + 1);
  const target = Math.trunc(hp);
  if (target <= 0 || !hitRolls.length || !hitRolls[0].length) return out;
  const acc = Math.max(0, Math.min(1, Number.isFinite(accuracy) ? accuracy : 1));
  const miss = acc < 0.999999 ? 1 - acc : 0;
  const extras = (Array.isArray(extra) ? extra : [[extra, 1]])
    .map(([amount, chance]) => [Math.max(0, Math.trunc(amount) || 0), Number(chance) || 0])
    .filter(([, chance]) => chance > 0);
  const plain = extras.length === 1 && extras[0][0] === 0 && !later;
  const shift = Math.trunc(later) || 0;
  let dist = new Float64Array(target + 1);
  dist[0] = 1;
  for (let n = 1; n <= PROFILE_HITS; n += 1) {
    const rolls = hitRolls[Math.min(n - 1, hitRolls.length - 1)];
    if (!rolls.length) {
      for (let k = n; k <= PROFILE_HITS; k += 1) out[k] = out[n - 1];
      break;
    }
    const next = new Float64Array(target + 1);
    next[target] = dist[target];
    if (plain && !miss && rolls.length === 1 && rolls[0] <= 0) {
      out[n] = out[n - 1];
      continue;
    }
    const p = acc / rolls.length;
    for (let t = 0; t < target; t += 1) {
      const mass = dist[t];
      if (!mass) continue;
      for (const [amount, chance] of extras) {
        const base = Math.max(0, t + amount + (n > 1 ? shift : 0));
        const weight = mass * chance;
        if (miss) next[base >= target ? target : base] += weight * miss;
        const share = weight * p;
        for (let i = 0; i < rolls.length; i += 1) {
          const to = base + rolls[i];
          next[to >= target ? target : to] += share;
        }
      }
    }
    dist = next;
    out[n] = Math.min(1, dist[target]);
  }
  return out;
}

/** A result's KO profile against `hp` (defaults to the result's own current HP). */
export function resultProfile(result, hp = null, extraHits = null) {
  const first = rollsForHit(result, 0);
  const later = rollsForHit(result, 1);
  const hits = extraHits ? [first, ...extraHits] : [first, later];
  const raw = result?.move_accuracy_factor;
  const acc = raw === undefined || raw === null ? 1 : Number(raw);
  return koProfile(hits, hp ?? Math.trunc(result?.current_hp || result?.max_hp || 0), acc);
}

/**
 * Map a per-hit profile to a per-action one: a recharge move lands its n-th hit on
 * action 2n-1, a charging move on action 2n, and a move that makes the user faint
 * only ever gets one hit.
 */
export function actionProfile(hits, { recharge = false, charge = false, selfKo = false } = {}) {
  if (!recharge && !charge && !selfKo) return hits;
  const out = new Float64Array(PROFILE_HITS + 1);
  for (let t = 1; t <= PROFILE_HITS; t += 1) {
    if (selfKo) out[t] = hits[1];
    else if (recharge) out[t] = hits[Math.floor((t + 1) / 2)];
    else out[t] = hits[Math.floor(t / 2)];
  }
  return out;
}

/** The chance the attacker wins a race where both keep attacking: A ours, B theirs. */
export function raceValue(A, B, weFirst) {
  let win = 0;
  let lose = 0;
  for (let t = 1; t <= PROFILE_HITS; t += 1) {
    const a = A[t] - A[t - 1];
    const b = B[t] - B[t - 1];
    if (weFirst) {
      win += a * (1 - B[t - 1]);
      lose += b * (1 - A[t]);
    } else {
      win += a * (1 - B[t]);
      lose += b * (1 - A[t - 1]);
    }
  }
  return win + 0.5 * Math.max(0, 1 - win - lose);
}

/** The first action on which a profile reaches 50% (PROFILE_HITS + 1 if never). */
export function turnsToKo(profile) {
  for (let t = 1; t <= PROFILE_HITS; t += 1) if (profile[t] >= 0.5) return t;
  return PROFILE_HITS + 1;
}

/**
 * Damage calcs kept by the stats they read. A calc lives in a cell (direction, move,
 * threat, field) under a number made of our final stats that calc reads.
 */
export class DamageMemo {
  constructor(limit = 80000) {
    this.limit = limit;
    this.cells = new Map();
    this.size = 0;
    this.calcs = 0;
  }

  cell(key) {
    let cell = this.cells.get(key);
    if (!cell) {
      cell = new Map();
      this.cells.set(key, cell);
    }
    return cell;
  }

  /**
   * Start counting the distinct calcs one run asks for (`requested`, found in the memo or
   * not), so a budget counted in calcs gives the same answer whether the memo starts
   * cold or warm ("Run again").
   */
  beginRun() {
    this.seen = new WeakMap();
    this.requested = 0;
  }

  /** The entry for `statKey` in `cell`, calculating it with `make` when missing. */
  get(cell, statKey, make) {
    if (this.seen) {
      let keys = this.seen.get(cell);
      if (!keys) {
        keys = new Set();
        this.seen.set(cell, keys);
      }
      if (!keys.has(statKey)) {
        keys.add(statKey);
        this.requested += 1;
      }
    }
    let entry = cell.get(statKey);
    if (entry === undefined) {
      if (this.size >= this.limit) this.reset();
      entry = make();
      this.calcs += 1;
      cell.set(statKey, entry);
      this.size += 1;
    }
    return entry;
  }

  reset() {
    for (const cell of this.cells.values()) cell.clear();
    this.size = 0;
  }
}

/**
 * The fields of an engine result the optimiser keeps, compactly (a run keeps tens of
 * thousands): the rolls as typed arrays, the resist-berry rolls only when there are any.
 */
export function minimalResult(result, extra = {}) {
  const pack = (list) => Int32Array.from(numericRolls(list));
  const out = {
    rolls: pack(result?.rolls),
    move_accuracy_factor: result?.move_accuracy_factor,
    max_hp: result?.max_hp,
    current_hp: result?.current_hp,
    ...extra,
  };
  if (result?.rolls_with_resist_berry?.length) out.rolls_with_resist_berry = pack(result.rolls_with_resist_berry);
  if (result?.rolls_without_resist_berry?.length) out.rolls_without_resist_berry = pack(result.rolls_without_resist_berry);
  return out;
}

// --- Stat Points -----------------------------------------------------------------------

export const STAT_NAMES = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];
const NATURE_STAT_INDEX = { ATK: 1, DEF: 2, SPA: 3, SPD: 4, SPE: 5 };

/** [raised stat index, lowered stat index] of a Nature (-1 for neutral). */
export function natureIndices(natures, name) {
  const [up, down] = natures?.[name] || ["", ""];
  const u = NATURE_STAT_INDEX[String(up || "").toUpperCase()] ?? -1;
  const d = NATURE_STAT_INDEX[String(down || "").toUpperCase()] ?? -1;
  return u === d ? [-1, -1] : [u, d];
}

export const pointTotal = (points) => points.reduce((sum, v) => sum + (Number(v) || 0), 0);

export function legalPoints(points) {
  return points.length === 6 && points.every((v) => Number.isInteger(v) && v >= 0 && v <= MAX_BONUS_POINTS_PER_STAT) && pointTotal(points) <= MAX_BONUS_STAT_POINTS;
}

/** Clamp to 0..32 each and spend any points left up to 66: HP first, then the defences. */
export function fillPoints(points, order = [0, 2, 4, 1, 3, 5]) {
  const out = Array.from({ length: 6 }, (_, i) => Math.max(0, Math.min(MAX_BONUS_POINTS_PER_STAT, Math.trunc(Number(points?.[i]) || 0))));
  let over = pointTotal(out) - MAX_BONUS_STAT_POINTS;
  for (let i = 5; over > 0 && i >= 0; i -= 1) {
    const cut = Math.min(over, out[i]);
    out[i] -= cut;
    over -= cut;
  }
  let left = MAX_BONUS_STAT_POINTS - pointTotal(out);
  for (const i of order) {
    if (left <= 0) break;
    const add = Math.min(left, MAX_BONUS_POINTS_PER_STAT - out[i]);
    out[i] += add;
    left -= add;
  }
  return out;
}

/** A spread with Speed set to `speed` points, the difference taken from (or given to) the bulkiest-invested stats. */
export function withSpeedPoints(points, speed) {
  const out = [...points];
  out[5] = Math.max(0, Math.min(MAX_BONUS_POINTS_PER_STAT, speed));
  let over = pointTotal(out) - MAX_BONUS_STAT_POINTS;
  while (over > 0) {
    let donor = -1;
    for (const i of [0, 2, 4, 1, 3]) if (out[i] > 0 && (donor < 0 || out[i] > out[donor])) donor = i;
    if (donor < 0) break;
    out[donor] -= 1;
    over -= 1;
  }
  return fillPoints(out);
}

export const pointsKey = (points) => points.join(",");

/** A promise that lets the worker read its message queue (a Stop) between batches. */
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
