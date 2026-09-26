// Suggestions: no single swap target may take the whole shown list.
//
// The owner's six-slot Trick Room team showed "Swap Indeedee-F -> ..." in 13 of the 14 shown
// rows. That is not a scoring bug: each row was ranked correctly. It is the SHAPE of the list.
// The swap target contributes a near-constant offset to every candidate, so whichever slot has
// the biggest offset wins every row even when its edge over the closest rival slot is small.
//
// A scoring term cannot fix that, and the history proves it: version 5 only re-tuned the
// per-candidate outgoing price and the owner's list went from 7/14 to 13/14. A per-candidate
// term cannot see how many rows a target has already taken, so it cannot bound a share; a term
// that could read the partial list is a selection rule with a different name.
//
// THE RULE (presentation only -- scoring, the shortlist and the threats are untouched):
//
//   cap = ceil(limit / offered_targets), the SMALLEST per-target cap that can still fill the
//   list from the targets on offer. With the 14 rows Suggestions shows and the at most 3 swap
//   targets `swapTargets` returns, that is ceil(14/3) = 5 rows = 35.7% -- "about a third" comes
//   out of the list geometry rather than being chosen (a cap of 4 could only reach 12 rows).
//   `offered_targets` counts the targets that really have a viable row, so a one-sided team and
//   an open-slot team (one pseudo-target "") get cap = limit and the rule is inert.
//
//   The cap GIVES WAY when the best row it forbids is more than ANSWER_SPAN (18) points better
//   than the best row it allows. 18 is the span stage two can move any row, and the cap has to
//   clear the per-target offset to bite at all. This is what stops a genuinely one-sided team
//   being padded with rows that are not worth showing.
//
// The mechanism is iterative merit selection with per-target capacity, never truncation:
// repeatedly take the best row among {each not-yet-shown candidate's best row at a target that
// still has room}. A candidate whose preferred slot is full re-enters with ITS OWN already-scored
// row at another slot, so a displaced row becomes "the same Pokemon offered at a different slot"
// rather than disappearing. Every shown row is a row `evaluateCandidate` really produced at that
// slot; nothing is synthesised and the list is never shortened. The selected set is then sorted
// by score, so the list stays ordered by merit.
//
// `options.suggestionDiversity` switches it: 0 / null / false is the old shape, which is what an
// unstamped recording replays with.

/** The rule version production runs; a recording stamps it as `rules.suggestion_diversity`. */
export const SUGGESTION_DIVERSITY = 1;

/** `undefined` keeps the default; null / 0 / false / "off" switch the rule off. */
export function diversityOption(value) {
  if (value === undefined) return SUGGESTION_DIVERSITY;
  if (value === null || value === "" || value === false) return 0;
  if (value === true) return SUGGESTION_DIVERSITY;
  const text = String(value).trim().toLowerCase();
  if (["off", "false", "no", "none", "0"].includes(text)) return 0;
  const version = Number.parseInt(text, 10);
  if (Number.isFinite(version)) return version > 0 ? version : 0;
  return SUGGESTION_DIVERSITY;
}

/** The target a row is offered at ("" for an open slot, which is one bucket). */
export const targetOf = (row) => String(row?.swap_target || "").trim().toLowerCase();

/**
 * The smallest per-target cap that can still fill `limit` rows from `targets` buckets.
 * ceil(14/3) = 5, ceil(14/2) = 7, ceil(14/1) = 14 (inert).
 */
export function perTargetCap(limit, targets) {
  const rows = Math.max(0, Math.trunc(limit));
  const buckets = Math.max(1, Math.trunc(targets));
  return Math.ceil(rows / buckets);
}

/** score desc, then position, then name -- the order the list already sorts by. */
const better = (a, b) => (b.score - a.score) || (a.position - b.position)
  || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Shape a ranked row list so no swap target takes more than its share.
 *
 * @param {Array<object>} rows   the ranked rows, best first -- one per candidate, as today
 * @param {Map<string, Array<object>>} alternates  candidate key -> that candidate's OTHER
 *        already-scored rows (the same Pokemon offered at the other targets)
 * @param {number} limit         how many rows the list shows
 * @param {number} margin        ANSWER_SPAN: the loss at which the cap gives way
 * @param {(row: object) => string} keyOf  a candidate's identity (one row per candidate)
 * @param {object|null} report  filled with {cap, offered, limit, yielded} -- `yielded` is one
 *        [taken, best_allowed] pair per time the cap gave way (`best_allowed` null: nothing
 *        admissible was left). A test can then check the rule's own definition on a real team.
 * @returns {Array<object>} the shaped list, same length, ordered by merit
 */
export function selectDiverse(rows, alternates, limit, margin, keyOf, report = null) {
  const take = Math.min(Math.max(0, Math.trunc(limit)), rows.length);
  if (report) Object.assign(report, { cap: take, offered: 0, limit: take, yielded: [] });
  if (take <= 0) return [];
  // Each candidate's rows, its best first. A candidate that only ever had one row keeps it.
  const byCandidate = [];
  const seen = new Set();
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    const others = (alternates?.get(key) || []).filter((r) => r && r !== row && Number.isFinite(r.score));
    byCandidate.push({ key, rows: [row, ...others].sort(better) });
  }
  // How many targets really have a viable row: this is what makes the cap inert on a one-sided
  // team and on an open slot (one pseudo-target "").
  const offered = new Set();
  for (const { rows: list } of byCandidate) for (const row of list) offered.add(targetOf(row));
  const cap = perTargetCap(take, offered.size);
  if (report) Object.assign(report, { cap, offered: offered.size, limit: take });
  if (cap >= take) return rows.slice(0, take);

  const used = new Map();
  const taken = new Set();
  const out = [];
  while (out.length < take) {
    let admissible = null;
    let forbidden = null;
    for (const { key, rows: list } of byCandidate) {
      if (taken.has(key)) continue;
      if (!forbidden || better(list[0], forbidden.row) < 0) forbidden = { key, row: list[0] };
      const open = list.find((row) => (used.get(targetOf(row)) || 0) < cap);
      if (open && (!admissible || better(open, admissible.row) < 0)) admissible = { key, row: open };
    }
    // Every target full, or the cap costs more than stage two could ever move a row: yield.
    const pickForbidden = !admissible
      || (forbidden && forbidden.row.score > admissible.row.score + margin);
    const pick = pickForbidden ? forbidden : admissible;
    if (!pick) break;
    if (report && pickForbidden) report.yielded.push([pick.row.score, admissible ? admissible.row.score : null]);
    taken.add(pick.key);
    const target = targetOf(pick.row);
    used.set(target, (used.get(target) || 0) + 1);
    out.push(pick.row);
  }
  return out.sort(better);
}
