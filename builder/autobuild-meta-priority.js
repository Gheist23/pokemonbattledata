// "Prioritize Meta Pokemon" really ranks the Top X ahead of everything but the red checks.
//
// The owner reported regular Arcanine (usage rank 118) still being added with the box ticked.
// It is not a data or pool bug. Arcanine is an unusually cheap Team Building Check filler:
// Intimidate + Extreme Speed + Snarl + Flare Blitz turns Coverage Gaps, Physical Damage,
// Priority-or-Cleanup and Utility/Disruption green in ONE slot. Measured against that, usage
// rank barely competes -- it reaches a candidate's score only as
//
//     rankBonus = max(0, 4 - log10(position + 1) * 1.35)        (team-suggest.js)
//
// a total spread of 2.86 points out of 100 across all 262 ranked Pokemon, while the check
// layer can move a single row by up to 18 points. And before this rule the option only
// REORDERED inside a tier that sat BELOW the yellow checks, so one yellow check anywhere in
// the list outranked being in the Top X entirely. The option could be seen to do something
// only when two candidates were otherwise exactly equal, which is almost never.
//
// THE RULE (a tier move only -- no score, no pool and no filter is touched):
//
//   Prioritize Meta's tier moves up to sit immediately after the hard RED checks, so it
//   outranks the yellow checks. Red checks still come first everywhere: the option makes a
//   team meta, it does not make it broken. Four places rank by that tier and all four move:
//
//     1. the objective complete teams are compared by (autobuild-search.js beats()):
//        checksRed, archetypeUnmet, metaOutside, checksYellow -- instead of
//        checksRed, checksYellow, archetypeUnmet, metaOutside
//     2. the per-slot candidate ranking (team-autobuild.js TeamAutoBuild.order())
//     3. the search's own candidate ranking (autobuild-search.js searchOrder())
//     4. the order the one-swap repair tries alternatives in (autobuild-search.js repair())
//
//   Nothing outside Prioritize Meta changes: with the option off every one of those keys
//   holds a constant 0 in that position, so moving it is a no-op and a build without the
//   box ticked is byte-identical.
//
// Measured over 22 Auto Build runs (11 starts x Deep/Medium, Prioritize Meta on, Doubles):
// additions with a usage rank past 100 fell from 4 of 22 to 1 of 22, and regular Arcanine
// from 2 of 22 to 0 of 22. tests/run-autobuild-meta-priority.mjs holds the guard.
//
// `options.autobuildMetaPriority` switches it: 0 / null / false / "off" restores exactly the
// order above the rule, which is what a recording made before the rule replays with. A
// recording stamps it as `rules.autobuild_meta_priority`.

/** The rule version; a recording stamps it as `rules.autobuild_meta_priority`. */
export const AUTOBUILD_META_PRIORITY = 1;

/** The recording key the stamp is filed under. */
export const META_PRIORITY_STAMP = "autobuild_meta_priority";

/** `undefined` keeps the default; 0 / null / false / "off" switch the rule off. */
export function metaPriorityOption(value) {
  if (value === undefined) return AUTOBUILD_META_PRIORITY;
  if (value === null || value === false) return 0;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (!raw) return AUTOBUILD_META_PRIORITY;
    if (["off", "false", "no", "none", "0"].includes(raw)) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : AUTOBUILD_META_PRIORITY;
  }
  return Number(value) > 0 ? Math.trunc(Number(value)) : 0;
}

/** Whether the rule is on for this option value. */
export const metaPriorityOn = (value) => metaPriorityOption(value) > 0;

/**
 * A recording's stamp, or `null` when it was made before the rule (which replays with the
 * rule off). Read exactly as the vector suites read `terrain_seeds` / `team_checks`.
 */
export function metaPriorityStamp(testCase) {
  return testCase?.record?.rules?.[META_PRIORITY_STAMP] ?? testCase?.rules?.[META_PRIORITY_STAMP] ?? null;
}

/** The tiers beats() compares with the rule off: Prioritize Meta last, below the yellow checks. */
export const OBJECTIVE_TIERS_PLAIN = ["checksRed", "checksYellow", "archetypeUnmet", "metaOutside"];

/** The tiers beats() compares with the rule on: only the red checks outrank the Top X. */
export const OBJECTIVE_TIERS_META_FIRST = ["checksRed", "archetypeUnmet", "metaOutside", "checksYellow"];

/** The tier order the objective compares complete teams by, for this option value. */
export function objectiveTiers(value) {
  return metaPriorityOn(value) ? OBJECTIVE_TIERS_META_FIRST : OBJECTIVE_TIERS_PLAIN;
}

/**
 * A sort key with Prioritize Meta's element promoted: the element at index `at` moves to
 * index `to` (immediately after the hard red checks), the rest keeping their order. With
 * the rule off the key is returned unchanged, which is what every recording before the
 * rule replays with -- and with the option off that element is a constant 0 anyway, so
 * the promotion cannot change an order it was not meant to change.
 *
 * @param {Array} key   the key as it stands without the rule
 * @param {number} at   the index Prioritize Meta's element sits at
 * @param {number} to   the index it moves to (must be above `at`)
 * @param {*} value     the option value (`options.autobuildMetaPriority`)
 */
export function promoteMetaTier(key, at, to, value) {
  if (!metaPriorityOn(value)) return key;
  if (!Array.isArray(key) || !(at > to) || to < 0 || at >= key.length) return key;
  const moved = key.slice();
  const [element] = moved.splice(at, 1);
  moved.splice(to, 0, element);
  return moved;
}
