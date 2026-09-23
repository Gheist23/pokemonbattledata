// Guaranteed moves: a move that at least GUARANTEED_MOVE_SHARE percent of a Pokémon's
// teams run (this format's battle data) is on every set Auto Build and Suggested
// Pokémon put forward for it.
//
// One rule, used by every step that makes or changes a set:
//   team-suggest.js        the common set and every candidate set (Suggestions rows,
//                          Auto Build picks, Item Clause alternatives, the set refinement's
//                          choices, the search's alternative sets)
//   autobuild-archetype.js the archetype's anchor move never takes a locked move's slot
//   team-autobuild.js      set completion, field retune, speed mode, set refinement, and
//                          the end of the finish chain as the backstop
//   optimize-deep.js       Optimize's move test: it never offers to drop one, never
//                          offers a field move the team cannot power, and offers a
//                          guaranteed move a saved set does not have yet
//
//   lockedMoves  which moves count: usage >= the share for the Pokémon's battle-data name
//                (a Mega reads its base species, a form with its own data reads that),
//                minus a weather or terrain move whose condition neither the team nor the
//                set's own Ability turns on (a Mega Stone holder is judged with its Mega's
//                Ability). Once the team turns the condition on, the move is locked.
//   enforce      every locked move present: a missing one takes the place of the unlocked
//                move with the lowest usage share (a move outside the usage list counts as
//                0; on a tie the later slot goes). A locked move and a protected one (the
//                archetype's anchor move) are never removed.
//
// The share is an option of TeamSuggestions / TeamAutoBuild: production runs with 95;
// null or 0 switches the rule off (the parity suites replay recordings made before it).

import { compact } from "./engine.js";

/**
 * The default share, in percent (inclusive). The app runs the same cutoff; it is a hand copy
 * here, like MOVES_NEEDING_SUPPORT in team-suggest.js, until the exporter carries it in
 * `appData.analysisTables` - read it from there once it is in the data.
 */
export const GUARANTEED_MOVE_SHARE = 95;

const valid = (entry) => Boolean(entry && String(entry.pokemon || "").trim());

/** A share option as a number: > 0 is the rule's cutoff, 0 is off (null, 0, negative, not a number). */
export function shareOption(value) {
  if (value === null || value === undefined || value === false || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Per usage record: its moves at or above the share, and every move's share by key.
const recordCache = new WeakMap();

function recordShares(record, share) {
  let byShare = recordCache.get(record);
  if (!byShare) {
    byShare = new Map();
    recordCache.set(record, byShare);
  }
  let out = byShare.get(share);
  if (!out) {
    const shares = new Map();
    const top = [];
    for (const [move, pct] of record.moves || []) {
      const k = compact(move);
      if (!k || shares.has(k)) continue;
      const value = Number(pct) || 0;
      shares.set(k, value);
      if (value >= share) top.push({ move: String(move).trim(), share: value });
    }
    out = { shares, top };
    byShare.set(share, out);
  }
  return out;
}

/** The usage record a Pokémon (or Mega) name is filed under, or null. */
function usageRecord(sg, name) {
  const text = String(name || "").trim();
  if (!text) return null;
  return sg.ev.record(sg.usageName(text)) || null;
}

/** The Ability the set really plays with: a Mega Stone holder's Mega Ability, else its own. */
export function effectiveAbility(sg, name, ability, item) {
  const own = String(ability || "").trim();
  if (!String(item || "").trim()) return own;
  const species = sg.ev.baseSpeciesFromDisplay(sg.usageName(String(name || "").trim()));
  const [form, megaAbility] = sg.megaIdentity(species, item, own);
  return form && megaAbility ? megaAbility : own;
}

/** Every move's usage share for this Pokémon, by move key (for enforce's choice of slot). */
export function moveShares(sg, name) {
  const record = usageRecord(sg, name);
  return record ? recordShares(record, Number.POSITIVE_INFINITY).shares : new Map();
}

/**
 * "May this set run that move?": false only for a weather or terrain move whose condition
 * neither the team nor the set's own Ability turns on. The gate `lockedMoves` applies, for
 * the steps that also choose new moves (Optimize's move test).
 * @param {import("./team-suggest.js").TeamSuggestions} sg
 * @param {string} name        the Pokémon (species, form or Mega name)
 * @param {object} set         {ability, item} of the set
 * @param {object[]} teamEntries the team whose weather / terrain counts (app entries)
 * @returns {(move: string) => boolean}
 */
export function fieldGate(sg, name, { ability = "", item = "" } = {}, teamEntries = []) {
  let have = null;
  return (move) => {
    const need = sg.moveCondition(move);
    if (!need) return true;
    have ||= sg.fieldSupport((teamEntries || []).filter(valid), [effectiveAbility(sg, name, ability, item)].filter(Boolean));
    return have.has(need);
  };
}

/**
 * The moves a set of this Pokémon must carry, most used first: [{move, share}].
 * @param {import("./team-suggest.js").TeamSuggestions} sg
 * @param {string} name        the Pokémon (species, form or Mega name)
 * @param {object} set         {ability, item} of the set
 * @param {object[]} teamEntries the team whose weather / terrain counts (app entries)
 */
export function lockedMoves(sg, name, { ability = "", item = "" } = {}, teamEntries = [], share = sg.guaranteedShare) {
  if (!(share > 0)) return [];
  const record = usageRecord(sg, name);
  if (!record) return [];
  const { top } = recordShares(record, share);
  if (!top.length) return [];
  const powered = fieldGate(sg, name, { ability, item }, teamEntries);
  return top.filter((entry) => powered(entry.move));
}

/**
 * The moves with every locked move in. A new list; `changes` says what moved.
 * @param {string[]} moves
 * @param {{move: string, share: number}[]} locked
 * @param {{shares?: Map<string, number>, protect?: string[]}} options
 * @returns {{moves: string[], changes: {move: string, share: number, replaced: string}[]}}
 */
export function enforce(moves, locked, { shares = new Map(), protect = [] } = {}) {
  const out = (moves || []).map((m) => String(m ?? "").trim()).filter(Boolean);
  const changes = [];
  if (!(locked || []).length) return { moves: out, changes };
  const fixed = new Set([...locked.map((l) => compact(l.move)), ...(protect || []).map(compact)].filter(Boolean));
  for (const { move, share } of locked) {
    if (out.some((m) => compact(m) === compact(move))) continue;
    if (out.length < 4) {
      out.push(move);
      changes.push({ move, share, replaced: "" });
      continue;
    }
    let drop = -1;
    out.forEach((m, i) => {
      if (i >= 4 || fixed.has(compact(m))) return;
      // the lowest share goes; "<=" lets the later slot go on a tie
      if (drop < 0 || (shares.get(compact(m)) ?? 0) <= (shares.get(compact(out[drop])) ?? 0)) drop = i;
    });
    if (drop < 0) break;
    changes.push({ move, share, replaced: out[drop] });
    out[drop] = move;
  }
  return { moves: out.slice(0, 4), changes };
}

/** The guaranteed moves an entry ({pokemon, item, ability, moves}) lacks on this team. */
export function missingLocked(sg, entry, teamEntries, share = sg.guaranteedShare) {
  const have = new Set((entry?.moves || []).map(compact));
  return lockedMoves(sg, entry?.pokemon || entry?.name || "", entry || {}, teamEntries, share).filter((l) => !have.has(compact(l.move)));
}

/** The keys of a locked list, for the steps that only need to know "may this move go?". */
export function lockedKeys(locked) {
  return new Set((locked || []).map((l) => compact(l.move)));
}

/**
 * One log line per forced change, in plain English.
 *
 * One wording for the whole rule, word for word the one `guaranteed_moves.py`
 * writes, so a player who reads both logs reads the same sentence:
 *
 *   Guaranteed move: Rillaboom keeps Grassy Glide (97.8% usage) in place of High Horsepower.
 *   Guaranteed move: Rillaboom keeps Grassy Glide (97.8% usage) in a free move slot.
 *
 * The speed mode says the same about a move it wanted to swap ("Farigiraf keeps Trick Room
 * (96.1% usage), although the team plays Tailwind."), and the field gate about one it may
 * not keep ("... which needs sun and the finished team does not set it up").
 */
export function describeChanges(who, changes) {
  return (changes || []).map(({ move, share, replaced }) => `Guaranteed move: ${who} keeps ${move} (${formatShare(share)}% usage) ${replaced ? `in place of ${replaced}` : "in a free move slot"}.`);
}

/** One decimal, the way `guaranteed_moves.describe` writes it (`f"{share:.1f}"`). */
export function formatShare(share) {
  return (Number(share) || 0).toFixed(1);
}
