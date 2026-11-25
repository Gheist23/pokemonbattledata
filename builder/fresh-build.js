// V561: Auto Build starts a NEW team when the selected team is already full.
//
// THE DEFECT. Auto Build fills the open slots. With six Pokemon on the team there are none,
// so every phase of the search was skipped and it handed back the team it was given:
// `run()`'s anchor loop is `for (let d = 0; d < open; d += 1)`, the beam is gated on
// `open > 0`, and the one-swap repair only looks at slots Auto Build itself added
// (`if (!added.size) return null`). The user pressed Start Auto Build and got their own
// team back, scored, with nothing added and nothing compared -- and "Keep the current
// team" was on by default, so this was the normal way to meet it.
//
// THE RULE. A full team means there is nothing to keep, so the seed is dropped and Auto
// Build searches from scratch. It is not destructive: the result is shown with "Save as
// new team" and "Replace current team", exactly as any other build, and the team on the
// page is untouched until one of those is pressed. Improving a team the user wants to
// keep is what Suggestions is for.
//
// WHY THE SEED PAYLOAD GOES WITH IT. `cachedScores` and `cachedPayload` are Team
// Evaluation's answer FOR THE SEEDED TEAM (_v452_fast_autobuild_payload). Dropping the
// seed without dropping them would start the search from an empty team carrying the full
// team's Synergy/Offense/Defense/Speed as its baseline, so every candidate would be
// measured against scores no team in the search has. That is the trap this module exists
// to close as much as the empty seed is.

/** Production is on. A replay harness turns it off to match what it recorded. */
export const FRESH_BUILD_RULE = 1;

/** The slots a team has. Matches TEAM_SIZE in team-autobuild.js and autobuild-search.js. */
export const FULL_TEAM_SIZE = 6;

/** The log line, and what the page shows as a caveat (builder-page.js filters on it). */
export const FRESH_BUILD_NOTE = "Your team was already full, so Auto Build searched for a completely new team instead of filling slots. Your current team is unchanged until you save or replace it.";

/** `freshBuildRule` as a flag: absent means production (on), an explicit 0/false means off. */
export function freshBuildRuleOption(value) {
  if (value === undefined || value === null) return FRESH_BUILD_RULE;
  if (value === false) return 0;
  const text = String(value).trim().toLowerCase();
  if (!text || text === "0" || text === "off" || text === "false" || text === "no" || text === "none") return 0;
  return 1;
}

/**
 * Is every slot taken?
 *
 * The filled test is `set.species`, the SAME one runGreedy and AutoBuildSearch.run use to
 * build their spreads (`sets[i]?.species ? ... : null`). Being looser here than the engine
 * is the dangerous direction: the rule would throw away a seed the engine still considers
 * partly open.
 */
export function teamIsFull(sets, size = FULL_TEAM_SIZE) {
  if (!(size > 0)) return false;
  const list = Array.isArray(sets) ? sets : [];
  let filled = 0;
  for (let i = 0; i < size; i += 1) {
    if (String(list[i]?.species ?? "").trim()) filled += 1;
  }
  return filled === size;
}

/** The seed a fresh build starts from: nothing. */
export function freshSeed(size = FULL_TEAM_SIZE) {
  return Array.from({ length: Math.max(0, size) }, () => null);
}

/**
 * The run options a fresh build takes: the caller's, minus the seeded team's cached
 * Team Evaluation.
 */
export function freshOptions(options = {}) {
  return { ...options, cachedPayload: null, cachedScores: null };
}

/** The result, with the note at the top of its log so the page can show it. */
export function stampFresh(result) {
  if (!result || typeof result !== "object") return result;
  result.freshBuild = true;
  result.log = [FRESH_BUILD_NOTE, ...(Array.isArray(result.log) ? result.log : [])];
  return result;
}
