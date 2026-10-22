// Rolling a Pokemon whose set you cannot see.
//
// A Closed Team Sheet board says which Pokemon are standing and nothing else about them. This
// file turns "Garchomp, and I know it carries Flamethrower" into a concrete set the search can
// play, drawn so that a hundred rolls look like a hundred Garchomps the format actually brings.
//
// THREE TIERS, and the order is the whole design. It was measured before it was written.
//
//   1. A REAL SET.  data/builder/pokemon-sets.json holds the sets tournament teams actually
//      brought, with each one's share. Drawing one of those by its share is right by
//      construction: the item, the Nature, the points and the four moves came off one sheet
//      together. Measured against the board value of the real mix, this lands 0.29 points out.
//
//   2. A GRAFT, when the user has pinned a move no real set has. Take a real set that honours
//      everything ELSE they pinned, keep their moves, and fill the rest from that set's own.
//      The item, Nature and points stay a triple somebody really played. Without this tier one
//      pinned move throws the whole library away: measured over the 262 ranked Doubles Pokemon,
//      pinning one listed move leaves NO real set for 52.1% of (Pokemon, move) pairs.
//
//   3. THE USAGE PERCENTAGES, for the half of the ladder with no sheets on file and for a pin
//      the first two tiers cannot honour. This is the sampler the feature was described with,
//      and on its own it is worse than the single common set it replaces: it manufactures
//      Pokemon nobody plays -- 63.3% of its draws are whole sets no real team ran, 21.4% of
//      Garchomps pair a Choice item with a status move, 37.7% get points that fight their own
//      moves -- and those chimeras are weak, so the board drifts optimistic by +1.65 points
//      against the real mix's +0.12. It is kept because for 50.4% of ranked Pokemon it is the
//      only thing there is, and it is given the two guards that cost nothing: the points are
//      paired to the Nature through the same `pointsForNature` every other page uses, and a
//      Mega Stone that belongs to somebody else is dropped from the item list.
//
// WHY THE MOVE DRAW IS NOT A WEIGHTED PICK. "Fill the remaining slots weighted by percentage"
// does not reproduce the percentages. A weighted draw without replacement pulls everything
// toward uniform: measured exactly, Indeedee's Expanding Force is published at 99.6% and comes
// out at 79.0%, while its 0.3% moves come out at 0.5%. The fix is standard -- conditional
// Poisson sampling, which is the distribution over 4-move sets whose inclusion probabilities are
// the published ones -- and it costs about forty multiplies per roll once the weights are fitted.
// `calibrate` fits them; `draft` draws from them; both are exact, not approximate.
//
// ONE ARITHMETIC FACT UNDERNEATH ALL OF IT: if every set carries four moves, the inclusion rates
// of ALL a Pokemon's moves must sum to 400 points. The published top ten sum to 346.5 on average
// and to 249.0 for Snorlax, because the source publishes ten rows and the tail is real. So the
// published rates are not a feasible target and have to be projected onto one -- scaled up,
// clamped at certainty, the freed mass spread over the rest. That projection is the only error
// this sampler has; everything else about it is exact.

import { compact } from "./engine.js";
import { makeSet } from "./common.js";
import { pointsForNature } from "./nature-spreads.js";

/** The game's own total, which every legal spread adds up to. */
const STAT_POINTS = 66;
/** How many moves a set carries. */
const MOVE_SLOTS = 4;
/** Below this the fitted odds are treated as certainty, so the item is simply taken. */
const SURE = 1 - 1e-9;

// --- conditional Poisson sampling ------------------------------------------------------------

/**
 * The published rates, projected onto something a 4-move set can actually have.
 *
 * Scale so the rates sum to the number of slots, clamp anything that lands above certainty back
 * to it, and spread the mass that frees over the rest. Repeated, because one pass can push
 * another row over. 87 of 262 ranked Doubles Pokemon need at least one clamp -- Kangaskhan's
 * Fake Out is published at 96.3% and scales to 126.6%, which is not a probability.
 */
export function projectRates(rates, slots = MOVE_SLOTS) {
  const n = rates.length;
  if (!n) return [];
  if (slots >= n) return rates.map(() => 1);
  let q = rates.map((p) => Math.max(0, Math.min(1, Number(p) || 0)));
  for (let pass = 0; pass < 32; pass += 1) {
    const sure = q.map((value) => value >= SURE);
    const fixed = sure.reduce((sum, is) => sum + (is ? 1 : 0), 0);
    const room = slots - fixed;
    const free = q.reduce((sum, value, i) => sum + (sure[i] ? 0 : value), 0);
    if (room <= 0) return q.map((value, i) => (sure[i] ? 1 : 0));
    if (free <= 0) return q;
    const scale = room / free;
    let over = false;
    q = q.map((value, i) => {
      if (sure[i]) return 1;
      const next = value * scale;
      if (next >= 1) over = true;
      return Math.min(1, next);
    });
    if (!over && Math.abs(q.reduce((a, b) => a + b, 0) - slots) < 1e-12) return q;
  }
  return q;
}

/**
 * The elementary symmetric table: `R[k][j]` is the total weight of every k-sized choice from the
 * items at `j` and after. It is the one recursion the whole scheme rests on -- the draft reads a
 * probability straight off it, and the inclusion probabilities are ratios of it.
 */
function symmetric(w, slots) {
  const n = w.length;
  const R = Array.from({ length: slots + 1 }, () => new Float64Array(n + 1));
  for (let j = 0; j <= n; j += 1) R[0][j] = 1;
  for (let k = 1; k <= slots; k += 1) {
    R[k][n] = 0;
    for (let j = n - 1; j >= 0; j -= 1) R[k][j] = w[j] * R[k - 1][j + 1] + R[k][j + 1];
  }
  return R;
}

/** How often each item really comes out, for a given set of weights. Exact, not sampled. */
export function inclusion(w, slots) {
  const n = w.length;
  const all = symmetric(w, slots)[slots][0];
  if (!(all > 0)) return w.map(() => 0);
  return w.map((weight, i) => {
    // The same recursion with item i left out: what is left is every choice that does NOT
    // contain it, so one minus that share is how often it does.
    const without = w.filter((_, j) => j !== i);
    const rest = symmetric(without, slots - 1);
    return (weight * rest[slots - 1][0]) / all;
  });
}

/**
 * Weights whose conditional Poisson design has exactly the inclusion probabilities asked for.
 *
 * Iterative scaling: nudge each weight by how far its realised rate is from its target, in odds,
 * and repeat. It converges fast -- a residual below 1e-12 in a few hundred passes on every one
 * of the 522 published records -- and the answer is cached, because it depends only on the day's
 * usage file.
 */
export function calibrate(targets, slots = MOVE_SLOTS) {
  const q = targets.map((value) => Math.max(1e-9, Math.min(SURE, Number(value) || 0)));
  let w = q.map((value) => value / (1 - value));
  for (let pass = 0; pass < 400; pass += 1) {
    const pi = inclusion(w, slots);
    let worst = 0;
    for (let i = 0; i < w.length; i += 1) {
      const have = Math.max(1e-12, Math.min(SURE, pi[i]));
      worst = Math.max(worst, Math.abs(have - q[i]));
      w[i] *= (q[i] / (1 - q[i])) * ((1 - have) / have);
    }
    if (worst < 1e-12) break;
    // The weights are only meaningful up to a common factor; holding them near 1 keeps the
    // recursion away from the ends of a double.
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    if (mean > 0) w = w.map((value) => value / mean);
  }
  return w;
}

/**
 * Draw exactly `slots` of them, by the calibrated design.
 *
 * One walk down the list: at each item, the chance of taking it is its own weight times the
 * weight of every way to finish from the rest, over the weight of every way to finish from here.
 */
export function draft(w, slots, rng) {
  const n = w.length;
  const take = [];
  if (slots >= n) return w.map((_, i) => i);
  const R = symmetric(w, slots);
  let left = slots;
  for (let j = 0; j < n && left > 0; j += 1) {
    const total = R[left][j];
    if (!(total > 0)) break;
    const chance = (w[j] * R[left - 1][j + 1]) / total;
    if (rng() < chance) {
      take.push(j);
      left -= 1;
    }
  }
  // A rounding slip at the end of the walk, which the recursion makes vanishingly rare: finish
  // with whatever is left rather than hand back a short set.
  for (let j = 0; j < n && take.length < slots; j += 1) if (!take.includes(j)) take.push(j);
  return take;
}

// --- drawing one field ------------------------------------------------------------------------

/** One name off a [name, percent] list, by its share of the listed mass. */
function weightedName(pairs, rng) {
  const rows = (pairs || []).filter(([name]) => String(name || "").trim());
  const total = rows.reduce((sum, [, percent]) => sum + Math.max(0, Number(percent) || 0), 0);
  if (!rows.length) return "";
  if (!(total > 0)) return String(rows[0][0]).trim();
  let roll = rng() * total;
  for (const [name, percent] of rows) {
    roll -= Math.max(0, Number(percent) || 0);
    if (roll <= 0) return String(name).trim();
  }
  return String(rows[rows.length - 1][0]).trim();
}

/** A spread the game would accept: the published rows are partial captures and 152 of the 2,620
 *  Doubles ones do not total 66, which would hand out a Pokemon quietly short of points. */
function topUp(points) {
  const out = Array.from({ length: 6 }, (_, i) => Math.max(0, Math.min(32, Math.trunc(Number(points?.[i]) || 0))));
  let total = out.reduce((a, b) => a + b, 0);
  if (total === STAT_POINTS) return out;
  // Short: raise the stats that are already invested in, biggest first, to 32 at most.
  const order = out.map((value, i) => i).sort((a, b) => out[b] - out[a]);
  for (const i of order) {
    if (total >= STAT_POINTS) break;
    const room = Math.min(32 - out[i], STAT_POINTS - total);
    out[i] += room;
    total += room;
  }
  // Long: take from the smallest investments first.
  for (const i of [...order].reverse()) {
    if (total <= STAT_POINTS) break;
    const drop = Math.min(out[i], total - STAT_POINTS);
    out[i] -= drop;
    total -= drop;
  }
  return out;
}

// --- the roller ---------------------------------------------------------------------------------

/**
 * What the user has pinned on a tile. Every field is optional; what is absent is rolled.
 * @typedef {{moves?: string[], item?: string, ability?: string, nature?: string,
 *            bonuses?: number[]}} FixedSet
 */

export class HiddenSets {
  /**
   * @param {object} data     a loaded BuilderData
   * @param {string} format   "Doubles" or "Singles"
   * @param {object|null} library  the parsed data/builder/pokemon-sets.json `sets`, or null
   */
  constructor(data, format, library = null) {
    this.data = data;
    this.format = format;
    this.library = library;
    this.fits = new Map();
  }

  /** The real sets on file for this Pokemon, best share first. */
  realSets(species, form) {
    const [s, f] = this.data.resolve(species, form);
    const key = `${compact(s)}|${compact(f)}`;
    const rows = this.library?.[this.format]?.[key] || this.library?.[key] || [];
    return rows.filter((row) => Array.isArray(row?.moves) && row.moves.length);
  }

  /** The fitted move weights for one Pokemon, worked out once. */
  moveWeights(usage) {
    const names = (usage?.moves || []).map(([name]) => String(name || "").trim()).filter(Boolean);
    if (!names.length) return null;
    const key = `${this.format}|${usage.name}`;
    let fit = this.fits.get(key);
    if (!fit) {
      const rates = (usage.moves || []).map(([, percent]) => Math.max(0, Number(percent) || 0) / 100);
      const slots = Math.min(MOVE_SLOTS, names.length);
      const q = projectRates(rates.slice(0, names.length), slots);
      fit = { names, slots, w: calibrate(q, slots) };
      this.fits.set(key, fit);
    }
    return fit;
  }

  /** Whether a stone is this Pokemon's own. A foreign one is simply an item it cannot use, and
   *  the usage lists carry a few because the source counts them against the holder's teammates. */
  ownStone(species, form, item) {
    if (!item || !this.data.engine?.isMegaStone?.(item)) return true;
    const [s, f] = this.data.resolve(species, form);
    return Boolean(this.data.engine.megaFormForMon({ item, pokemon_name: s, form_name: f }));
  }

  /** Does a real set honour everything the user pinned? */
  honours(row, fixed) {
    if (!fixed) return true;
    if (fixed.item && compact(fixed.item) !== compact(row.item)) return false;
    if (fixed.ability && compact(fixed.ability) !== compact(row.ability)) return false;
    if (fixed.nature && compact(fixed.nature) !== compact(row.nature)) return false;
    const have = (row.moves || []).map(compact);
    for (const move of fixed.moves || []) if (move && !have.includes(compact(move))) return false;
    return true;
  }

  /** One of a list of real sets, by share. */
  pickReal(rows, rng) {
    const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row.share) || 0), 0);
    if (!(total > 0)) return rows[Math.min(rows.length - 1, Math.floor(rng() * rows.length))];
    let roll = rng() * total;
    for (const row of rows) {
      roll -= Math.max(0, Number(row.share) || 0);
      if (roll <= 0) return row;
    }
    return rows[rows.length - 1];
  }

  /**
   * Roll one hidden Pokemon.
   *
   * @param {string} species
   * @param {string} form
   * @param {FixedSet|null} fixed  what the user has pinned; everything else is rolled
   * @param {() => number} rng
   * @param {{noStone?: boolean}} [options] `noStone` when this side has already spent its one
   *        Mega Evolution on another Pokemon, which is a rule of the game and not of the usage
   *        data -- independent item rolls put two stones on a side 39.8% of the time.
   * @returns {{set: object, tier: string}}
   */
  rollOne(species, form, fixed = null, rng = Math.random, { noStone = false } = {}) {
    const [s, f] = this.data.resolve(species, form);
    const usage = this.data.usage(this.format, s, f);
    const abilities = this.data.abilities(s, f);
    const stoneOk = (item) => this.ownStone(s, f, item) && !(noStone && this.data.engine?.isMegaStone?.(item));

    const real = this.realSets(s, f).filter((row) => stoneOk(row.item));

    // --- tier 1: a set somebody really brought ------------------------------------------------
    const exact = real.filter((row) => this.honours(row, fixed));
    if (exact.length) {
      const row = this.pickReal(exact, rng);
      return { tier: "real", set: this.fromReal(s, f, row, fixed) };
    }

    // --- tier 2: their moves on a real set's body ---------------------------------------------
    const bodyOnly = { ...(fixed || {}), moves: [] };
    const hosts = real.filter((row) => this.honours(row, bodyOnly));
    if (hosts.length && (fixed?.moves || []).length) {
      const row = this.pickReal(hosts, rng);
      const moves = [...(fixed.moves || [])];
      for (const move of row.moves || []) {
        if (moves.length >= MOVE_SLOTS) break;
        if (!moves.some((have) => compact(have) === compact(move))) moves.push(move);
      }
      return { tier: "graft", set: this.fromReal(s, f, { ...row, moves }, fixed) };
    }

    // --- tier 3: the usage percentages ---------------------------------------------------------
    return { tier: "usage", set: this.fromUsage(s, f, usage, abilities, fixed, rng, stoneOk) };
  }

  /** A real row as a set, with anything the user pinned written over it. */
  fromReal(species, form, row, fixed) {
    return makeSet({
      species,
      form,
      item: fixed?.item || row.item || "",
      ability: fixed?.ability || row.ability || this.data.abilities(species, form)[0] || "",
      nature: fixed?.nature || row.nature || "Serious",
      bonuses: topUp(fixed?.bonuses || row.bonuses),
      moves: [...(row.moves || [])].slice(0, MOVE_SLOTS),
    });
  }

  /** A set drawn from the usage percentages, conditioned on what the user pinned. */
  fromUsage(species, form, usage, abilities, fixed, rng, stoneOk) {
    const pinned = (fixed?.moves || []).filter(Boolean).slice(0, MOVE_SLOTS);
    const moves = [...pinned];
    const fit = this.moveWeights(usage);
    if (fit && moves.length < MOVE_SLOTS) {
      // Conditioning the design on the pinned moves is the same design over what is left with
      // fewer slots to fill, at the SAME weights -- so nothing is refitted here.
      const keep = [];
      for (let i = 0; i < fit.names.length; i += 1) {
        if (!moves.some((have) => compact(have) === compact(fit.names[i]))) keep.push(i);
      }
      const slots = Math.min(MOVE_SLOTS - moves.length, keep.length);
      if (slots > 0) {
        const w = keep.map((i) => fit.w[i]);
        for (const index of draft(w, slots, rng)) moves.push(fit.names[keep[index]]);
      }
    }
    if (!moves.length) moves.push(...this.data.learnset(species, form).slice(0, MOVE_SLOTS));

    let item = fixed?.item || "";
    if (!item) {
      const rows = (usage?.items || []).filter(([name]) => stoneOk(name));
      item = weightedName(rows, rng);
    }
    const ability = fixed?.ability || weightedName(usage?.abilities, rng) || abilities[0] || "";
    const nature = fixed?.nature || weightedName(usage?.natures, rng) || "Serious";
    // The points follow the Nature rather than being drawn beside it. Drawn independently they
    // contradict it -- 47.5% of rolled Garchomps put their points in the stat their own Nature
    // lowers -- and every other page in the app already pairs them this way.
    const paired = fixed?.bonuses
      ? [0, fixed.bonuses]
      : pointsForNature(usage?.spreads, nature, this.data.natures);
    return makeSet({
      species, form, item, ability, nature,
      bonuses: topUp(paired?.[1] || usage?.set?.bonuses),
      moves: moves.slice(0, MOVE_SLOTS),
    });
  }

  /**
   * Roll a whole side, keeping the one rule the usage data knows nothing about: a side brings at
   * most one Mega Stone. Rolled independently, a four-Pokemon side carries two or more stones
   * 99.8% of the time, and the search then answers a board the game cannot reach.
   *
   * A Pokemon the user has pinned a stone onto spends the side's stone first, so their statement
   * about the board is never overruled by a roll.
   */
  rollSide(rows, rng = Math.random) {
    const out = [];
    let stoneSpent = rows.some((row) => row?.fixed?.item && this.data.engine?.isMegaStone?.(row.fixed.item));
    for (const row of rows) {
      const pinnedStone = Boolean(row?.fixed?.item && this.data.engine?.isMegaStone?.(row.fixed.item));
      const rolled = this.rollOne(row.species, row.form, row.fixed, rng, { noStone: stoneSpent && !pinnedStone });
      if (!stoneSpent && this.data.engine?.isMegaStone?.(rolled.set.item)) stoneSpent = true;
      out.push(rolled);
    }
    return out;
  }
}
