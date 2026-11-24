// V559: one Mega happens, so the third stone is a promise the team cannot keep.
//
// The port of the app's `mega_exclusivity_v559.py`, function for function. Read that file for
// the complaint and the reasoning; what follows is only what a reader of THIS file needs.
//
// THE DEFECT, on the owner's sand six (Mega Salamence / Mega Tyranitar / Corviknight /
// Excadrill / Indeedee / Sneasler). The Suggestions list offered
//
//     Swap Corviknight -> Dragonite-Mega          93.6
//     Syn +5.1   Off +10.9   Def +7.1   Spe +12.5
//
// -- a THIRD Mega Stone -- and priced the candidate as its Mega: Multiscale, the Mega's typing,
// the Mega's Speed. That is where the +12.5 Speed comes from.
//
// This codebase already knows better, twice, in its own words:
//
//   * `analysis.js:390` -- "One Mega Evolution per battle: two stones is flexibility, three is
//     waste" -- and the Explorer's beam search REFUSES a Mega candidate once two are placed;
//   * `team-autobuild.js:291` drops Mega-stone candidates once `MAX_MEGA_STONES` are held, and
//     the app's `_v494_trim_excess_mega_stones` STRIPS the third stone off a finished team.
//
// Suggestions obeys neither. It is the one place in the builder that hands you a third stone.
//
// HOW BIG THE PROMISE IS, measured rather than assumed: all 81 Mega forms in `app-data.json`
// are EXACTLY +100 base-stat points over their base form (74 measurable base/Mega pairs,
// min = median = max = 100). The same size for every Mega there is -- which is why a flat grade
// per dead stone is the honest shape and no per-species measurement is needed.
//
// WHAT THIS ADDS, in two places:
//
//   1. `team-suggest.js` -- a swap that would leave the team over the cap is not offered at
//      that target. `run()` already evaluates every target for a candidate and keeps its best
//      row, so the Mega candidate is still offered, at a target that frees a stone. Measured on
//      the owner's team the row becomes "Swap Salamence-Mega -> Dragonite-Mega", which is the
//      row the breakdown itself pointed at ("replacing Salamence-Mega starts level").
//   2. `team-synergy.js` -- a team carrying a dead stone is charged V402's own HARD_GRADE
//      (10.0, the grade it gives "Swift Swim without any Rain setter"), because a stone that
//      cannot be used is the same thing: an item that does nothing, plus 100 base-stat points
//      of profile that will not appear. A team at or under the cap is untouched.
//
// NO ROUNDING ANYWHERE. Every number here is an integer or an integer quotient: the charge is
// `-min(20, 10 * dead)` and the share is `1 / k`. The V556 trap (`round(4.795, 2)` is 4.79 in
// Python and 4.8 in JS) cannot arise, and the parity suite asserts the charge at 17 significant
// figures anyway.
//
// THE GATE. `megaExclusivityRule`, the same shape as `fieldDependencyRule`: absent means
// production (on), an explicit 0/false/"off" means off. Every recorded evaluation, suggestion
// and Auto Build vector was made before this rule, so those suites replay with it off.

export const MEGA_EXCLUSIVITY_RULE = 1;

/** `megaExclusivityRule` as a flag: absent means production (on), 0/false/"off" means off. */
export function megaExclusivityRuleOption(value) {
  if (value === undefined || value === null) return MEGA_EXCLUSIVITY_RULE;
  if (value === false) return 0;
  const text = String(value).trim().toLowerCase();
  if (!text || text === "0" || text === "off" || text === "false" || text === "no" || text === "none") return 0;
  return 1;
}

/** Whether the rule is on for this evaluator. */
export function megaExclusivityOn(ev) {
  return Boolean(megaExclusivityRuleOption(ev?.megaExclusivityRule));
}

// --- the constants, all three quoted -------------------------------------------------------

/** `MAX_MEGA_STONES` (team-autobuild.js:40) and `_V494_MAX_MEGA_STONES` (part_140.py:8631). */
export const MAX_STONES = 2;

/** One Mega Evolution happens per battle, whatever the team carries. The whole rule. */
export const USED_PER_BATTLE = 1;

/** V402's `HARD_GRADE`, quoted through V556 (`field-dependency.js` HARD_GRADE). */
export const DEAD_STONE_GRADE = 10.0;

/** Two dead stones. V402's own terms are all bounded. */
export const WASTE_CAP = 20.0;

/** Every Mega form in this format is +100 base-stat points over its base form. */
export const MEGA_STAT_UPGRADE = 100;

export const ROW_REFUSAL_FIELD = "mega_exclusivity_refused_v559";
export const TEAM_TERM_FIELD = "mega_exclusivity_v559";
export const TEAM_ADJUST_FIELD = "mega_exclusivity_waste_penalty";

const key = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

// --- pure: who carries a stone -------------------------------------------------------------
//
// A member here is two things, because two is all this rule reads: the name it is shown under
// and whether its item is a Mega Stone. The classification is never done in this file -- it is
// handed in by `engine.isMegaStone`, which is the same test the app's `_v494_mega_stone_slots`
// makes (`_v124_is_mega_stone` on the item alone, deliberately NOT `analysis.js`'s stricter
// `megaCapable`, which also asks whether the form resolves), so both codebases count the same
// stones on the same team.

/** @returns {{name: string, stone: boolean, item: string}} */
export function megaMember(name, stone = false, item = "") {
  return { name: String(name ?? "").trim(), stone: Boolean(stone), item: String(item ?? "").trim() };
}

/** How many of these members carry a Mega Stone. */
export function stoneCount(members) {
  return (members || []).reduce((sum, row) => sum + (row && row.stone ? 1 : 0), 0);
}

export function stoneNames(members) {
  return (members || []).filter((row) => row && row.stone).map((row) => String(row.name || ""));
}

/**
 * The stone count after one slot is replaced by the candidate.
 * A `slot` outside the team is an ADD, which keeps every existing stone.
 */
export function projectedCount(members, slot, candidateIsStone) {
  const rows = members || [];
  const held = stoneCount(rows);
  const index = Number(slot);
  const outgoing = index >= 0 && index < rows.length ? Boolean(rows[index] && rows[index].stone) : false;
  return held - (outgoing ? 1 : 0) + (candidateIsStone ? 1 : 0);
}

/** Stones beyond the cap: the promises the team cannot keep. */
export function waste(count) {
  return Math.max(0, Math.trunc(num(count)) - MAX_STONES);
}

/**
 * Megas the team carries and cannot bring: `k - 1` at any k >= 1. Not what is charged -- the
 * charge is `waste()`, because the builder calls two stones flexibility and prices the choice,
 * not the loss. This is the number the sentence quotes.
 */
export function brokenPromises(count) {
  return Math.max(0, Math.max(0, Math.trunc(num(count))) - USED_PER_BATTLE);
}

/** The share of a battle any one of `count` stones gets to be the Mega. */
export function usableShare(count) {
  const held = Math.max(0, Math.trunc(num(count)));
  return held <= 0 ? 0 : USED_PER_BATTLE / held;
}

export function overCap(count) {
  return waste(count) > 0;
}

/**
 * Would this swap leave the team over the cap?
 *
 * A swap that is already over the cap and does not make it worse is NOT refused: the rule is
 * about what a suggestion ADDS, and a team that already carries three stones must still be
 * offered a way out of it.
 */
export function refuses(members, slot, candidateIsStone) {
  if (!candidateIsStone) return false;
  const before = stoneCount(members);
  const after = projectedCount(members, slot, true);
  return after > MAX_STONES && after > before;
}

/** The Synergy charge for a team's dead stones. @returns {[number, number, number]} */
export function teamTerm(count) {
  const dead = waste(count);
  if (dead <= 0) return [0, 0, brokenPromises(count)];
  return [-Math.min(WASTE_CAP, DEAD_STONE_GRADE * dead), dead, brokenPromises(count)];
}

/** `teamTerm` over a member list, with the names for the sentence. */
export function teamAdjustment(members) {
  const held = stoneCount(members);
  const [adjustment, dead, broken] = teamTerm(held);
  const names = stoneNames(members);
  return { stones: held, dead, broken, adjustment, names,
    usable_share: usableShare(held), sentence: wasteSentence(held, names) };
}

// --- pure: what the user reads -------------------------------------------------------------

function join(names, limit = 6) {
  const clean = (names || []).map((v) => String(v ?? "").trim()).filter(Boolean);
  if (!clean.length) return "";
  if (clean.length <= limit) return clean.join(", ");
  return `${clean.slice(0, limit).join(", ")} and ${clean.length - limit} more`;
}

/** The line a three-stone team gets in its Synergy calculation. */
export function wasteSentence(count, names = []) {
  const dead = waste(count);
  if (dead <= 0) return "";
  const held = Math.max(0, Math.trunc(num(count)));
  const listed = join(names);
  const subject = listed ? `${dead} of ${listed}` : `${dead} ${dead === 1 ? "stone" : "stones"}`;
  return `${held} Mega Stones and one Mega per battle: ${subject} ${dead === 1 ? "is" : "are"} `
    + `dead weight (every Mega is +${MEGA_STAT_UPGRADE} base-stat points).`;
}

/**
 * Why a row was not offered at this target. Kept on the refused row so a reader of the scan
 * log sees the rule fire rather than a silent gap.
 */
export function refusalSentence(name, outgoing, count, names = []) {
  const held = Math.max(0, Math.trunc(num(count)));
  const listed = join(names);
  const target = String(outgoing ?? "").trim() || "the outgoing member";
  return `${String(name ?? "This Pokemon").trim()} would be Mega Stone ${held} and only one `
    + `Mega happens per battle, so taking ${target}, which carries none, leaves a stone that `
    + `can never be used${listed ? ` (already: ${listed}).` : "."}`;
}

// --- the runtime seam: classification, always the engine's own -----------------------------

/** The team slots as this rule's member view. `entries` are builder entries with item/pokemon. */
export function membersFromEntries(engine, entries) {
  return (entries || []).map((entry) => {
    const row = entry || {};
    const item = String(row.item ?? "").trim();
    const name = String(row.form || row.pokemon || row.name || "").trim();
    let stone = false;
    try {
      stone = Boolean(name && item && engine && engine.isMegaStone(item));
    } catch {
      stone = false;
    }
    return megaMember(name, stone, item);
  });
}

/**
 * Does this suggestion row hand its slot a Mega Stone?
 *
 * Read off the row's own item, not the species' common set, because the row is scored on the
 * set it carries. `mega_form_v494` is trusted when a later layer has resolved the Mega name.
 */
export function rowIsStone(engine, row) {
  const data = row || {};
  if (String(data.mega_form_v494 ?? "").trim()) return true;
  try {
    return Boolean(engine && engine.isMegaStone(String(data.item ?? "")));
  } catch {
    return false;
  }
}

/** Which slot the row would take among `entries`. -1 means an add. */
export function slotOf(row, entries, swapTarget) {
  const target = String(swapTarget ?? (row || {}).swap_target ?? "").trim();
  if (!target) return -1;
  const wanted = key(target);
  const rows = entries || [];
  for (let i = 0; i < rows.length; i += 1) {
    const entry = rows[i] || {};
    if (key(entry.form || entry.pokemon || entry.name) === wanted) return i;
  }
  const index = Number((row || {}).slot_index);
  return Number.isInteger(index) ? index : -1;
}

/**
 * `[refused, why]` for one produced suggestion row.
 *
 * Only a swap: an empty `swapTarget` is an add, and the add path keeps the builder's existing
 * soft handling, because Auto Build trims a third stone itself and a hard refusal there could
 * starve a slot whose whole candidate list holds stones.
 */
export function refusesRow(engine, row, entries, swapTarget) {
  const target = String(swapTarget ?? (row || {}).swap_target ?? "").trim();
  if (!target) return [false, ""];
  if (!rowIsStone(engine, row)) return [false, ""];
  const members = membersFromEntries(engine, entries);
  const slot = slotOf(row, entries, target);
  if (!refuses(members, slot, true)) return [false, ""];
  const after = projectedCount(members, slot, true);
  return [true, refusalSentence((row || {}).name, target, after, stoneNames(members))];
}
