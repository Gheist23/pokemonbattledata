// Optimize's spread search: what it is allowed to try, and the answer it owes the player.
//
// The request was "test the spreads more deeply to find out if it's better than the current
// one". The first half of that turned out to be already true, and it was worth measuring
// before writing any code: the production search is not shallow. On a six-member Doubles
// team it uses 1,068-4,022 of its own 12,000-evaluation budget, and re-running the identical
// objective with a 15x-100x wider search (random restarts and two-pair transfers, 60,000-224,000
// evaluations, 47-216 s per member against 13 s) finds at most +0.26 matchup-score points, and
// nothing at all on some members. Raising the budget or bolting on a polish round buys a
// rounding difference for several seconds a member, so this rule does none of that.
//
// What was actually missing was narrower, and each piece of it is cheap:
//
//  A. The support-Nature filter was a blanket rule: a support Pokemon was offered no Nature
//     that raises Attack or Sp. Attack at all, even when the set attacks with that very stat.
//     Incineroar (Fake Out / Parting Shot / Flare Blitz / Knock Off) is a support set whose
//     two attacks are both physical, and Adamant beat its own Careful by +0.21 after margins
//     once the Nature was allowed to be tried - more than the 100x wider spread search found
//     anywhere. The rule is now the test `natureList` already makes: keep a Nature that raises
//     the category the set really attacks with, drop one that raises a category it never uses
//     (so a +Sp. Attack Nature is still never offered to a physical set). The set's own Nature
//     is never dropped.
//
//  B. Optimize already knew whether the current spread was the better one - it scores the best
//     option of all, margins aside - and threw the answer away unless it cleared a whole point
//     over the current set, twice the bar the suggestion itself has to clear. A +0.7 option
//     vanished silently, which is exactly the question being asked. The gate is now the same
//     MARGINS.minimum the pick clears, and when nothing is suggested the card leads with the
//     trade-off in plain English instead of "no change did clearly better".
//
//  C. Where the search STARTS from (a start is a seed, not an answer: the Stat Point search
//     tunes on from it). "Just enough Speed to pass X" spreads were only ever built on the
//     player's own spread and only for normal play, so a usage spread or a role template
//     never got a Speed benchmark, and a team that plays under its own Tailwind or against
//     one never got a benchmark for that. Now every start seeds them, in the two speed
//     contexts the score weighs most, capped at SPEED_START_CAP together. Over ten members
//     that is worth +0.13 at Quick (where the search is short, which is where a start
//     matters) and +0.02 at Deep, for +0.24 s and +0.31 s a member.
//
//     A bulk counterpart was built and measured beside it - for the heaviest threats, the
//     fewest HP + Defence and HP + Sp. Defence points that turn a measured one-hit KO into a
//     two-hit KO, fed in as extra starts - and it is NOT here, because over the same ten
//     members it changed exactly nothing (+0.000 at both depths) while costing +0.12 s a
//     member at Quick and +0.17 s at Deep. The spreads it produced were already inside the
//     search's reach: the role templates start at 32 HP with a defence, and the Stat Point
//     search walks the rest. Do not build it again without a case where it bites.
//
// `options.optimizeSpreadDepth` switches the whole rule: 0 / null / false / "off" restores
// the blanket Nature filter, the one-point trade-off gate and the narrower starts, which is
// what Optimize looked like before this rule, so a recording made before it replays
// byte-identically at its own stamp.
//
// The Companion has the same blanket Nature filter (pokemon_champions_tool/optimize_deep_v511.py);
// mirroring it there is a separate change.

/** The rule version; the app stamps it as `rules.optimize_spread_depth`. */
export const OPTIMIZE_SPREAD_DEPTH = 1;

/** How many "just enough Speed" starts all contexts and all base spreads may add together. */
export const SPEED_START_CAP = 12;
/** How many speed contexts benchmarks are read from: the two the score weighs most. */
export const SPEED_CONTEXTS = 2;

/** `undefined` keeps the default; 0 / null / false / "off" switch the rule off. */
export function spreadDepthOption(value) {
  if (value === undefined) return OPTIMIZE_SPREAD_DEPTH;
  if (value === null || value === false) return 0;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (!raw) return OPTIMIZE_SPREAD_DEPTH;
    if (["off", "false", "no", "none", "0"].includes(raw)) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : OPTIMIZE_SPREAD_DEPTH;
  }
  return Number(value) > 0 ? Math.trunc(Number(value)) : 0;
}

/**
 * A: which Natures a support Pokemon may be tried on.
 *
 * A support set is not turned into an attacker, so a Nature that raises a category the set
 * never attacks with is dropped. One that raises the category it does attack with stays: a
 * support Pokemon still has to hit with the attacks it carries. Its own Nature always stays.
 *
 * @param {string[]} natures   the list `natureList` made
 * @param {{current: string, indexOf: (name: string) => number, physical: boolean, special: boolean}} set
 *        `indexOf` is the index of the stat a Nature raises (-1 for a neutral one);
 *        `physical` / `special` say which categories the set's own attacks use
 */
export function supportNatures(natures, { current, indexOf, physical, special }) {
  return natures.filter((name) => {
    if (name === current) return true;
    const up = indexOf(name);
    if (up === 1) return Boolean(physical);
    if (up === 3) return Boolean(special);
    return true;
  });
}

/**
 * C1: the speed contexts benchmark starts are read from, heaviest first.
 * @returns {Array<{index: number, weight: number, ourTW: boolean}>}
 */
export function speedContexts(contexts, count = SPEED_CONTEXTS) {
  return (contexts || [])
    .map((context, index) => ({ index, weight: Number(context.weight) || 0, ourTW: Boolean(context.ourTW) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .slice(0, Math.max(1, count));
}
