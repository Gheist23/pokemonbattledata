// V560: a suggestion is ranked on the set you can actually have.
//
// The port of the app's `item_clause_ranking_v560.py`, function for function. Read that file
// for the full reasoning; what follows is what a reader of THIS file needs.
//
// THE DEFECT, measured on the owner's sand six (Mega Salamence / Mega Tyranitar /
// Corviknight / Excadrill / Indeedee / Sneasler). The Suggestions list showed fourteen rows
// and TEN of them were scored on an item a REMAINING teammate already holds:
//
//     Swap Corviknight -> Noivern      74.6   Focus Sash   (Excadrill holds it)
//     Swap Corviknight -> Whimsicott   73.6   Focus Sash
//     Swap Corviknight -> Meowscarada  73.4   Choice Scarf (Indeedee holds it)
//     ... ten of fourteen
//
// Over the whole scan it is 184 of the 638 rows `evaluateCandidate` produced, 28.8%.
//
// Press Use and the Item Clause swaps the item for the first free one in the same Pokemon's
// battle data, so the set you GET is not the set that was ranked. This file's own codebase
// says so out loud in `suggest-view.js:249`:
//
//     "Another member already holds Focus Sash, so the check used Leftovers (as Use would)."
//
// That note is the projection and the ranking disagreeing in the UI. `projectedDetail`
// (team-suggest.js, "Item Clause as Use applies it") already picks the honest item for the
// Team Evaluation preview -- downstream of the score, and only for the row you expand.
//
// WHY IT WAS LIKE THIS. V480 enforced the clause during the scan by evaluating every alternate
// SET of a conflicting candidate; V482 took that back out of normal Suggestions because of what
// it cost and kept it for Auto Build, which is why `evaluateCandidate`'s clause block sits
// inside `if (auto)`. So three of the four places enforce it -- Auto Build, the Explorer's beam
// search (`autobuild-search.js:343`), and Use -- and the ranking does not.
//
// WHAT THIS ADDS. One thing, in `evaluateCandidate`: the row is evaluated on the item Use
// would give it. Not a new choice -- the SAME choice, out of the same pool in the same order
// (the set's own item, then the common set's item, then the Pokemon's top-30 held items). The
// item nobody holds costs nothing; the item a teammate holds costs one more `inner()` pass;
// a Pokemon with no free item at all is not offered, because Use already refuses that row.
//
// NO ROUNDING ANYWHERE. This file compares item keys and picks list elements. It computes no
// number, so the V556 trap (`round(4.795, 2)` differing between Python and JS) cannot arise.
//
// THE GATE. `itemClauseRankingRule`, the same shape as `megaExclusivityRule`: absent means
// production (on), an explicit 0/false/"off" means off. Every recorded evaluation, suggestion
// and Auto Build vector was made before this rule, so those suites replay with it off.

export const ITEM_CLAUSE_RANKING_RULE = 1;

/** `itemClauseRankingRule` as a flag: absent means production (on), 0/false/"off" means off. */
export function itemClauseRankingRuleOption(value) {
  if (value === undefined || value === null) return ITEM_CLAUSE_RANKING_RULE;
  if (value === false) return 0;
  const text = String(value).trim().toLowerCase();
  if (!text || text === "0" || text === "off" || text === "false" || text === "no" || text === "none") return 0;
  return 1;
}

/** Whether the rule is on for this evaluator. */
export function itemClauseRankingOn(ev) {
  return Boolean(itemClauseRankingRuleOption(ev?.itemClauseRankingRule));
}

// --- the constants, both quoted ------------------------------------------------------------

/**
 * `_v480_item_options` (part_129.py:683) asks `_v444_usage_names` for this many held items,
 * and `_v482_suggestion_unique_item` picks the first free one out of that list. This rule has
 * to offer the same pool in the same order or the score still would not be the score you get,
 * so the number is quoted, not chosen. `projectedDetail` uses the same 30.
 */
export const USAGE_DEPTH = 30;

export const ROW_FIELD = "item_clause_ranked_v560";
export const REPLACED_FIELD = "item_clause_replaced_v560";
export const REFUSAL_FIELD = "item_clause_ranking_refused_v560";

/**
 * The substitution is a fact, not a win or a problem, so it sorts last in "Why it fits"
 * rather than colouring the row. `IMPACT_ORDER` in `suggest-view.js` is
 * {good: 0, yellow: 1, red: 2, neutral: 3}.
 */
export const DETAIL_SEVERITY = "neutral";

// --- pure: who holds what ------------------------------------------------------------------
//
// A member is two strings, because two is all this rule reads: the name it is shown under and
// the item it holds. The key is the builder's own `compact`, so the rule can never disagree
// with the Item Clause itself about whether two items are the same item.

/** `_v480_item_key` / `compact`. */
export function itemKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `member`. */
export function itemMember(name = "", item = "") {
  return { name: String(name ?? ""), item: String(item ?? "") };
}

/**
 * `held_elsewhere`: `{item key: holder name}` for every member except the one at `slot`.
 *
 * The excluded slot is where the candidate lands, so on a swap the outgoing Pokemon's item is
 * FREED -- the V524 rule (a row is judged against the team it would leave behind) applied to
 * items. On an add the slot is empty and nothing is freed.
 * @returns {Map<string, string>}
 */
export function heldElsewhere(members, slot) {
  const out = new Map();
  (members || []).forEach((entry, index) => {
    if (index === Number(slot)) return;
    if (!entry || !String(entry.name ?? "").trim()) return;
    const key = itemKey(entry.item);
    if (key && !out.has(key)) out.set(key, String(entry.name ?? ""));
  });
  return out;
}

/**
 * `first_free`: the first option nobody else holds, in the pool's own order.
 *
 * `allow` is the other structural rules' veto, and it is why this is not simply "the first
 * free item". Measured on the owner's sand six: the first free item for Aerodactyl, Blaziken
 * and Audino is their OWN Mega Stone, and the team already holds two -- so handing them that
 * stone had V559 refuse the row and the candidate vanished from the list entirely. Skipping
 * the stone keeps the row, on the next ordinary item in the same list (Aerodactyl on King's
 * Rock in this snapshot), and keeps the ranking honest, because Use never re-picks:
 * `_v482_suggestion_unique_item` only acts when the ranked item is already held, and after
 * this rule it never is.
 */
export function firstFree(options, used, allow = null) {
  for (const option of options || []) {
    const text = String(option ?? "").trim();
    const key = itemKey(text);
    if (!text || !key || used.has(key)) continue;
    if (typeof allow === "function" && !allow(text)) continue;
    return text;
  }
  return "";
}

/**
 * `decide`: what the row's item must be.
 *
 * A candidate with no item at all is nothing to enforce: the Item Clause counts held items,
 * and two empty hands are not a duplicate.
 * @returns {{item: string, changed: boolean, refused: boolean, holder: string, dropped: string}}
 */
export function decideItem(current, options, used, allow = null) {
  const text = String(current ?? "").trim();
  const key = itemKey(text);
  if (!key || !used.has(key)) return { item: text, changed: false, refused: false, holder: "", dropped: "" };
  const replacement = firstFree(options, used, allow);
  if (!replacement) return { item: "", changed: false, refused: true, holder: used.get(key), dropped: text };
  return { item: replacement, changed: true, refused: false, holder: used.get(key), dropped: text };
}

/** `substitution_sentence`: the line the reader gets instead of the projection's apology. */
export function substitutionSentence(taken, dropped, holder) {
  const item = String(taken ?? "").trim();
  const gone = String(dropped ?? "").trim();
  const name = String(holder ?? "").trim();
  if (!item || !gone) return "";
  if (name) return `Scored on ${item}, not ${gone}, which ${name} already holds`;
  return `Scored on ${item}, not ${gone}, which a teammate already holds`;
}

/** `refusal_sentence`. */
export function itemRefusalSentence(name, dropped, holder) {
  const species = String(name ?? "").trim() || "this Pokemon";
  const gone = String(dropped ?? "").trim();
  const who = String(holder ?? "").trim() || "a teammate";
  if (gone) return `not offered: ${who} already holds ${gone} and no other item in ${species}'s battle data is free`;
  return `not offered: no item in ${species}'s battle data is free`;
}

// --- the team and the pool -----------------------------------------------------------------

/**
 * `members_for`: the team entries as `{name, item}`, shown under their form name.
 *
 * The form name is what the reader sees ("Mega Tyranitar"), so it is what the sentence names;
 * the Item Clause itself only ever reads the item.
 */
export function itemMembersFromEntries(entries) {
  return (entries || []).map((entry) => {
    if (!entry || !String(entry.pokemon ?? "").trim()) return itemMember("", entry?.item);
    return itemMember(entry.form || entry.pokemon, entry.item);
  });
}

/**
 * `slot_of`: where the candidate lands.
 *
 * `row.slot_index`, exactly as `obeysItemClause` and `_v480_projected_row_team` read it, so
 * this rule and the clause agree about which item is freed.
 */
export function itemSlotOf(row, size) {
  const limit = Math.max(1, Number(size) || 6);
  const slot = Number(row?.slot_index) || 0;
  return Math.max(0, Math.min(limit - 1, slot));
}

/**
 * `forced_set_for`: the row's OWN set with the item replaced, and nothing else touched.
 *
 * Use keeps the ranked Ability, moves and spread and swaps the item alone
 * (`_v482_suggestion_unique_item`), so that is what has to be re-evaluated.
 */
export function forcedSetFor(row, item) {
  const existing = row?._candidate_set_v113;
  const out = existing && typeof existing === "object"
    ? structuredClone(existing)
    : {
      ability: String(row?.candidate_entry?.ability || row?.ability || ""),
      moves: [...(row?.candidate_entry?.moves || row?.moves || [])].slice(0, 4),
      ...(row?.candidate_spread && Object.keys(row.candidate_spread).length ? { spread: structuredClone(row.candidate_spread) } : {}),
    };
  out.item = String(item ?? "");
  out.rank = 1;
  out.evaluated_count = 1;
  out.total_sets = 1;
  return out;
}

/** `add_detail`: append the substitution line to "Why it fits", once. */
export function addItemDetail(row, sentence) {
  const text = String(sentence ?? "").trim();
  if (!text || !row) return row;
  const details = [...(row.details || [])].map((value) => String(value));
  if (!details.includes(text)) details.push(text);
  row.details = details;
  row._v104_detail_severities = { ...(row._v104_detail_severities || {}), [text.toLowerCase()]: DETAIL_SEVERITY };
  return row;
}
