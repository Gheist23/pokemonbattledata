// A Nature and the Stat Points it is shown with.
//
// A usage file ranks Natures and Stat Points as two separate lists and never records which
// distribution a Nature was used with, so the second most common Nature has nothing to do
// with the second most common distribution. Reading the two lists side by side (natures[i]
// with spreads[i]) handed a Jolly Garchomp - a Nature that lowers Sp. Atk - 32 Sp. Atk and
// no Attack. The rule instead takes, for each Nature, the most used distribution that Nature
// does not contradict: nothing in the stat it lowers and, when the data offers one,
// something in the stat it raises.
//
// One rule, used by every step that puts a Nature and Stat Points together:
//   team-eval.js     commonSpreads      the candidate spreads Auto Build, Suggestions and the
//                                       threat stat distributions read
//   team-suggest.js  spreadOptions      the candidate sets' spreads (the V449 beam, the V113
//                                       sets) and their fallback, the common set's Nature
//                    spreadForNature    the Stat Points a saved tournament team's Nature gets
//
// The usage record's own `set` (tools/builder-meta.mjs) is left as the file has it: it is the
// app's common_set, top row of each list, and the recorded parity suites compare it field by
// field. Where a candidate set is built on it, TeamSuggestions.commonSpread re-pairs it.
//
// The option `pairedSpreads` (TeamEvaluator, TeamSuggestions, TeamAutoBuild) switches the
// rule off, the way `guaranteedMoveShare` switches the guaranteed-move rule off: production
// runs it on, and a recorded run that was made before the rule (no `paired_spreads` stamp in
// its `rules`) replays with the old index zip, so the parity suites stay at 0 mismatches.

/** The default: production pairs a Nature with Stat Points it does not contradict. */
export const PAIRED_SPREADS = true;

/** An option as a flag: false for null / undefined / false / "" / 0 / "off" / "no". */
export function pairedOption(value) {
  if (value === null || value === undefined || value === false) return false;
  const text = String(value).trim().toLowerCase();
  if (!text || text === "0" || text === "off" || text === "false" || text === "no" || text === "none") return false;
  return true;
}

const STAT_SLOT = { HP: 0, ATK: 1, DEF: 2, SPA: 3, SPD: 4, SPE: 5 };

// The answer for one Nature sign, per Stat Point list. `commonSpreads` is asked for the same
// species over and over in a single analysis (every threat variant, every candidate set), and
// a record's rows do not change while a run holds them - the same reason guaranteed-moves.js
// caches per usage record.
const picked = new WeakMap();

/**
 * The Stat Points a Nature goes with.
 *
 * `points` is the record's usage-ranked [percentage, bonuses] list, `effect` the
 * Nature's [raised, lowered] pair. Returns one of those rows, or null when there are none.
 */
export function spreadPointsForNature(points, effect) {
  const up = String(effect?.[0] || "").trim().toUpperCase();
  const down = String(effect?.[1] || "").trim().toUpperCase();
  if (!points || typeof points !== "object") return choosePoints(points, up, down);
  let byEffect = picked.get(points);
  if (!byEffect) {
    byEffect = new Map();
    picked.set(points, byEffect);
  }
  const key = `${up}|${down}`;
  if (!byEffect.has(key)) byEffect.set(key, choosePoints(points, up, down));
  return byEffect.get(key);
}

/** The rule itself, on the raised / lowered stat names. */
function choosePoints(points, upStat, downStat) {
  const rows = (points || []).filter((row) => Array.isArray(row?.[1]) && row[1].length >= 6);
  if (!rows.length) return null;
  const up = STAT_SLOT[upStat];
  const down = STAT_SLOT[downStat];
  // A neutral Nature contradicts nothing, so the most common distribution stands.
  if (up === undefined || down === undefined || up === down) return rows[0];
  const fits = rows.filter((row) => !(Number(row[1][down]) > 0));
  if (fits.length) return fits.find((row) => Number(row[1][up]) > 0) || fits[0];
  // Nothing recorded leaves the lowered stat alone, so take what leans on it least
  // (the list is in usage order and the sort keeps it, so the most used of those wins).
  const lean = (row) => [Number(row[1][down]) || 0, Number(row[1][up]) > 0 ? 0 : 1];
  return [...rows].sort((a, b) => {
    const [aDown, aUp] = lean(a);
    const [bDown, bUp] = lean(b);
    return aDown - bDown || aUp - bUp;
  })[0];
}

/**
 * The [percentage, bonuses] row to show with `nature`: the rule when `paired`, and otherwise
 * the row at `index` - the usage file's index zip, which is what a run recorded before the
 * rule replays with.
 *
 * @param {Array<[number, number[]]>} points  the record's usage-ranked Stat Point list
 * @param {string} nature                     the Nature's name
 * @param {Record<string, string[]>} natures  the Nature table ([raised, lowered] per name)
 * @param {{paired?: boolean, index?: number}} options
 * @returns {[number, number[]]|null}
 */
export function pointsForNature(points, nature, natures, { paired = PAIRED_SPREADS, index = 0 } = {}) {
  const rows = points || [];
  if (!paired) return rows[index] || null;
  return spreadPointsForNature(rows, natures?.[String(nature || "").trim()] || ["", ""]);
}
