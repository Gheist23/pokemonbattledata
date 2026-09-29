// What a move costs ITS OWN USER, in one place.
//
// Two separate holes in the scoring shared one cause: nothing shared a definition of
// "this move hurts the Pokemon that uses it", so every consumer either re-derived it or
// dropped it.
//
//   1. RECOIL was published by the engine as STRINGS only (`recoil_hp_range`,
//      `recoil_percent`, `recoil_text`), in the ATTACKER's HP points, beside a
//      `max_hp` that belongs to the DEFENDER. A consumer holding a result could not
//      recover the fraction, so of eleven consumers only the manual Damage Calculator
//      and the deep Optimize objective charged it at all -- and the objective
//      re-derived the fractions itself and got Rock Head wrong. Tournament Test, Team
//      Evaluation, Suggestions, Team Building Checks, Auto Build and the shallow
//      TeamOptimizer all priced Life Orb's 1.3x and Flare Blitz's power at zero cost.
//      `builder/engine.js` now also publishes the numbers (`recoil_hp_lo` /
//      `recoil_hp_hi` / `recoil_share*`), and this file is where the record-only part
//      of the cost lives.
//
//   2. A SELF-KO move that lands a one-hit KO was counted as a clean, free answer.
//      The one rule that priced the class (`team-eval.js` V432) only fires when the
//      move needs TWO OR MORE hits, so a Final Gambit carrier was offered as an answer
//      to five of a team's eight worst threats, and Sirfetch'd / Lucario / Staraptor /
//      Squawkabilly Final Gambit each scored a perfect 100 "Guaranteed OHKO" against
//      four top-40 meta Pokemon. Removing something and being removed for it is a
//      trade, not an answer, and `selfKo` is the one name every consumer now asks.
//
// The rule is behind a `self_cost` stamp, exactly like `score_composition` and
// `team_checks`: version 0 restores today's behaviour byte for byte, so every recording
// made before the rule replays at its own stamp. The evaluator carries it
// (`TeamEvaluator.selfCost`), so Team Evaluation, Suggestions, Team Building Checks,
// Optimize and Tournament Test all read one value and cannot drift apart.

/**
 * The `self_cost` rule as a version number:
 *
 *   * a move whose user faints is never a clean answer -- Suggestions grade it "trades",
 *     `isRealAnswer` refuses it (which is also what Auto Build reads), Team Evaluation
 *     caps the matchup and says so in the label, Team Building Checks stops counting its
 *     power and coverage, and the deep Optimize objective scores its turn as a trade;
 *   * Tournament Test charges the attacker its own recoil and Life Orb;
 *   * the eight-name self-KO set is shared instead of being written out four times.
 *
 * On in production. A run recorded before the rule carries no `self_cost` stamp and
 * replays with it off, so the recorded parity suites stay at 0 mismatches.
 */
export const SELF_COST = 1;

/** A `self_cost` stamp as a version: 0 (off) for null / undefined / false / "" / "0".
 *
 *  Coerces exactly as `scoreRulesOption` (team-eval.js) does, which is the whole job of
 *  the pair: an ABSENT value means "no stamp on this recording", i.e. a recording made
 *  before the rule, so it is off; anything unreadable falls back to the version
 *  production runs. */
export function selfCostOption(value) {
  if (value === null || value === undefined || value === false) return 0;
  const text = String(value).trim().toLowerCase();
  if (!text || text === "0" || text === "off" || text === "false" || text === "no" || text === "none") return 0;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : SELF_COST;
}

/**
 * The moves whose OWN description in this game's data says the user faints.
 *
 * The site had this list twice and disagreed with itself: `team-eval.js` carried four
 * names and `optimize-objective.js` read that same four through `selfDestructs`, while
 * the Companion's `optimize_objective_v511.SELF_DESTRUCTS` carries seven. All of them
 * are here, and every name is the game's own wording:
 *
 *   Explosion / Self-Destruct / Misty Explosion  "The user faints upon using this move."
 *   Final Gambit                                 "The user faints."
 *   Memento                                      "The user faints upon using this move."
 *   Healing Wish                                 "The user faints."
 *   Lunar Dance                                  "User faints."
 *   Grudge                                       "If the user faints, ..."
 *
 * Grudge is the one conditional wording, and it is in the set deliberately: this game's
 * data files Grudge as an 80-power PHYSICAL move (and Lunar Dance likewise), which is a
 * placeholder, not an attack. Pricing Grudge as a free 80-power Normal attack -- which
 * is what every consumer did -- is the larger of the two errors, and a Pokemon only ever
 * clicks Grudge in the turn it expects to faint.
 */
export const SELF_KO_MOVES = new Set([
  "explosion", "selfdestruct", "mistyexplosion", "finalgambit",
  "memento", "healingwish", "lunardance", "grudge",
]);

/** The four names `team-eval.js` carried before the rule: what version 0 restores. */
export const SELF_KO_MOVES_V432 = new Set(["explosion", "selfdestruct", "mistyexplosion", "finalgambit"]);

/**
 * Whether this move's user faints, BY NAME.
 *
 * The flag-and-description half of the test stays in `TeamEvaluator.selfDestructs`,
 * which asks this first: the name set is the part that was written out twice.
 * @param {string} move
 * @param {number} [version]  the `self_cost` version; 0 restores the four V432 names
 */
export function selfKo(move, version = SELF_COST) {
  const k = String(move || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!k) return false;
  return (version >= 1 ? SELF_KO_MOVES : SELF_KO_MOVES_V432).has(k);
}

/** Share of the user's own max HP a move costs it outright, whatever it does to the target.
 *  Every value is the number in the move's own description in this game's data. */
export const SELF_HP_COSTS = {
  bellydrum: 1 / 2,
  substitute: 1 / 4,
  shedtail: 1 / 2,
  // Ghost-type Curse only; `selfHpFraction` checks the type, because the non-Ghost branch
  // of the same move is a stat change that costs nothing.
  curse: 1 / 2,
  // Struggle is unconditional in the engine: it is the one branch Magic Guard and Rock Head
  // never reach, and it is a quarter of the user's own max HP, not of the damage dealt.
  struggle: 1 / 4,
};

/** Share of the user's own max HP a move costs it AFTER it lands (engine.js MAX_HP_RECOIL_FRACTIONS,
 *  by compact key so a record from either product's tables answers). */
export const SELF_MAX_HP_RECOIL = { steelbeam: 1 / 2, mindblown: 1 / 2, chloroblast: 1 / 2 };

/** Share of the user's own max HP a move costs it when it MISSES (the crash moves). */
export const SELF_CRASH_MOVES = { highjumpkick: 1 / 2, jumpkick: 1 / 2, supercellslam: 1 / 2, axekick: 1 / 2 };

/** engine.js DAMAGE_RECOIL_FRACTIONS by compact key: share of the DAMAGE DEALT the user takes back. */
export const SELF_DAMAGE_RECOIL = {
  bravebird: 1 / 3, doubleedge: 1 / 3, flareblitz: 1 / 3, lightofruin: 1 / 2, headsmash: 1 / 2,
  takedown: 1 / 4, submission: 1 / 4, volttackle: 1 / 3, wavecrash: 1 / 3, wildcharge: 1 / 4,
  woodhammer: 1 / 3, headcharge: 1 / 4,
};

const compactKey = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A record's accuracy as a 0..1 factor (`true` means "cannot miss" in this game's data). */
function accuracyFactor(record) {
  const raw = record?.accuracy ?? record?.acc;
  if (raw === true || raw === undefined || raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

/**
 * The share of the DAMAGE DEALT this move gives back to its user as recoil.
 *
 * Mirrors `engine.js` `_calcV289` exactly: an explicit `recoil_fraction` on the record
 * wins, then the name table, then the bare `recoil` flag at one third. Rock Head
 * suppresses THIS part and nothing else -- which is the bug in
 * `optimize-objective.js`'s own copy, where Rock Head also cancelled Life Orb and the
 * max-HP recoil of Steel Beam, Mind Blown and Chloroblast. It cancels neither.
 */
export function selfDamageFraction(record, { rockHead = false, magicGuard = false } = {}) {
  if (rockHead || magicGuard) return 0;
  const name = compactKey(record?.name);
  let fraction = record && "recoil_fraction" in record ? record.recoil_fraction : SELF_DAMAGE_RECOIL[name];
  if ((fraction === undefined || fraction === null) && (record?.flags || []).some((f) => String(f).toLowerCase() === "recoil")) fraction = 1 / 3;
  const n = Number(fraction);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The share of the user's own MAX HP one use of this move costs, not counting the part
 * that is a share of the damage dealt (`selfDamageFraction`).
 *
 * Three kinds, and they are suppressed by different things, exactly as the engine has it:
 *   * recoil after the hit (Steel Beam, Mind Blown, Chloroblast) and Life Orb --
 *     suppressed by Magic Guard only, NOT by Rock Head;
 *   * the crash moves (High Jump Kick, Jump Kick, Supercell Slam, Axe Kick), charged at
 *     their chance to MISS -- suppressed by Magic Guard only;
 *   * an outright HP cost (Belly Drum, Substitute, Shed Tail, Ghost-type Curse, and
 *     Struggle's quarter) -- suppressed by nothing at all, because it is not damage.
 *
 * @param {object} record          the move record (app-data `moves` entry or engine meta)
 * @param {object} [options]
 * @param {boolean} [options.magicGuard]  the user has Magic Guard
 * @param {boolean} [options.lifeOrb]     the user holds a Life Orb (a flat 1/10 per attack)
 * @param {number}  [options.accuracy]    accuracy as a 0..1 factor; the record's own by default,
 *                                        1 when the run has move accuracies turned off
 * @param {string[]} [options.userTypes]  the user's types, for Ghost-type Curse
 */
export function selfMaxHpFraction(record, { magicGuard = false, lifeOrb = false, accuracy = null, userTypes = null } = {}) {
  const name = compactKey(record?.name);
  let share = 0;
  const cost = SELF_HP_COSTS[name];
  if (cost !== undefined) {
    // Curse costs HP only on a Ghost-type user; on anything else it is a stat change.
    if (name !== "curse" || !userTypes || userTypes.some((t) => compactKey(t) === "ghost")) share += cost;
  }
  if (magicGuard) return share;
  const after = record && "recoil_max_hp_fraction" in record ? Number(record.recoil_max_hp_fraction) : SELF_MAX_HP_RECOIL[name];
  if (Number.isFinite(Number(after)) && Number(after) > 0) share += Number(after);
  const crash = SELF_CRASH_MOVES[name];
  if (crash !== undefined) {
    const acc = accuracy === null || accuracy === undefined ? accuracyFactor(record) : Math.max(0, Math.min(1, Number(accuracy) || 0));
    share += crash * (1 - acc);
  }
  if (lifeOrb && isAttack(record)) share += 1 / 10;
  return share;
}

/** Whether Life Orb would charge its 1/10 for this record (it charges on a damaging move). */
function isAttack(record) {
  const category = String(record?.category || "").toLowerCase();
  if (category === "physical" || category === "special") return true;
  return (Number(record?.power) || 0) > 0;
}

/**
 * The whole share of the user's MAX HP one use of this move costs it: the outright cost and
 * the recoil after the hit, plus the damage-relative recoil applied to `dealtShare`.
 *
 * `dealtShare` is the damage this use deals, ALREADY EXPRESSED AS A SHARE OF THE USER'S OWN
 * max HP -- which is the conversion nothing could do before, because a damage result carries
 * the DEFENDER's `max_hp`. `engine.js` now publishes `recoil_share_lo` / `recoil_share_hi` /
 * `recoil_share` for exactly this, so a consumer holding a result should prefer those; this
 * function is for a consumer that holds only a move record.
 *
 * A self-KO move is NOT 1 here: its cost is structural (the user is gone, so there is no
 * second turn), and every consumer prices that through `selfKo` instead of as HP.
 */
export function selfHpFraction(record, dealtShare = 0, options = {}) {
  const dealt = Number(dealtShare) || 0;
  return selfMaxHpFraction(record, options) + selfDamageFraction(record, options) * Math.max(0, dealt);
}

/** The recoil a damage result charges its attacker, as a share of the ATTACKER's max HP.
 *  Reads the numeric fields `engine.js` publishes and falls back to the strings a result
 *  recorded before those fields still carries (`recoil_hp_range` is in attacker HP points).
 *  @param {object} result  a `DamageEngine.calculate` result
 *  @param {"mean"|"lo"|"hi"} [pick] */
export function resultRecoilShare(result, pick = "mean") {
  if (!result) return 0;
  const direct = pick === "lo" ? result.recoil_share_lo : pick === "hi" ? result.recoil_share_hi : result.recoil_share;
  const n = Number(direct);
  if (Number.isFinite(n) && n > 0) return n;
  const maxHp = Number(result.recoil_attacker_max_hp) || 0;
  if (!(maxHp > 0)) return 0;
  const points = (String(result.recoil_hp_range || "").match(/\d+/g) || []).map(Number);
  if (!points.length) return 0;
  const value = pick === "lo" ? points[0] : pick === "hi" ? points[points.length - 1] : (points[0] + points[points.length - 1]) / 2;
  return value / maxHp;
}
