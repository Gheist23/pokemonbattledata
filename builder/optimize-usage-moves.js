// Optimize only tests attacks the Pokémon is RECORDED with.
//
// The request was "only test moves that have a usage percentage for this Pokémon above 0%".
// The data cannot express that literally: across all 262 records of both formats not one move
// row has a share of 0 -- the lowest anywhere is 0.2% (Doubles) / 0.6% (Singles) -- because the
// game's own panel only ever publishes a Pokémon's ten most-used moves (261 of 262 records carry
// exactly ten rows; Ditto carries one). convert_champions_json_to_csv.py says so at the source.
//
// So "above 0%" really means "in the game's top ten for this Pokémon", and that is a much harder
// cut than 0% sounds: the implicit threshold is whatever tenth place is worth, a median of 8.3%
// and up to 100% for a one-row record. The rule is named for what it does rather than for the
// wording, and the threshold is the record itself.
//
// The rule, in one place for both sides (pokemon_champions_tool/optimize_usage_moves_v517.py):
//
//   A NEW attack is only offered to the move search when the Pokémon's own battle-data record
//   lists it. A move the set ALREADY has is always testable, recorded or not -- a player's own
//   set is not a hypothesis. A Pokémon with no recorded rows at all is not restricted: an empty
//   record means "we have no data for this Pokémon in this format", which is not the same claim
//   as "nobody plays these moves".
//
// The pool can never fall below the number of free slots, because the current moves seed it
// before anything is ranked and the combination trim refuses to drop one of them. The degenerate
// case is a pool that equals the set it started from: one combination, which is the base set, so
// the search has nothing to offer and says so.
//
// This is a restoration rather than an invention. The older V209 / V160 Optimize path never left
// recorded usage (`_v159_candidate_moves` intersects the learnset with the common set), and so
// does the site's own `commonMoves`. Only the V511 deep search widened the pool to the whole
// learnset.
//
// `options.optimizeUsageMoves` switches it: 0 / null / false restores the full-learnset pool,
// which is what Optimize looked like before this rule.

import { compact } from "./engine.js";

/** The rule version; the app stamps it as `rules.optimize_usage_moves`. */
export const OPTIMIZE_USAGE_MOVES = 1;

// Enough rows to read every move a species is recorded with (records hold ten).
export const USAGE_ROWS = 60;

/** `undefined` keeps the default; 0 / null / false / "off" switch the rule off. */
export function usageOption(value) {
  if (value === undefined) return OPTIMIZE_USAGE_MOVES;
  if (value === null || value === false) return 0;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (!raw) return OPTIMIZE_USAGE_MOVES;
    if (["off", "false", "no", "none", "0"].includes(raw)) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : OPTIMIZE_USAGE_MOVES;
  }
  return Number(value) > 0 ? Math.trunc(Number(value)) : 0;
}

/**
 * The compact keys of every move this Pokémon is recorded with, or `null` when it has no
 * record at all (which switches the rule off for it rather than emptying its pool).
 * The same table the 95% guaranteed-move rule reads, so a locked move is always inside it.
 * @param {object} sg    the evaluator (usagePairs)
 * @param {string} name  the species or form the battle data is filed under
 */
export function recordedMoveKeys(sg, name) {
  let pairs = [];
  try {
    // Through the suggestions' own name mapping, so this is the identical table the 95%
    // guaranteed-move rule reads: a locked move is inside the filtered set by construction.
    pairs = typeof sg.usageName === "function"
      ? sg.ev.usagePairs(sg.usageName(name), "move", USAGE_ROWS) || []
      : sg.usagePairs(name, "move", USAGE_ROWS) || [];
  } catch {
    return null;
  }
  const keys = new Set();
  for (const row of pairs) {
    const move = Array.isArray(row) ? row[0] : row;
    const share = Array.isArray(row) ? Number(row[1]) || 0 : 1;
    const key = compact(move);
    if (key && share > 0) keys.add(key);
  }
  return keys.size ? keys : null;
}

/**
 * Whether a candidate attack may be tested.
 * @param {string} key       the candidate's compact key
 * @param {Set|null} recorded  recordedMoveKeys(...) -- `null` means "no data, do not restrict"
 * @param {Set} held         the compact keys the set already has
 */
export function testableMove(key, recorded, held) {
  if (!recorded || !recorded.size) return true; // no data for this Pokemon: do not restrict
  return recorded.has(key) || held.has(key);
}
