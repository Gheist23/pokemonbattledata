// What Optimize needs to know about moves that the move table does not say: which
// moves do a job beyond their damage (so they are never swapped out), which moves
// are never worth suggesting (locked-in, charging, conditional, self-KO...), and
// which moves only work with the team's weather or terrain.
//
// The move records carry no lock-in or charge flags, so these lists are curated by
// hand; add new moves here as they arrive.

import { compact } from "./engine.js";

const keys = (text) => new Set(text.split(",").map((m) => compact(m)).filter(Boolean));

/** Damaging moves that only work on the first turn out. */
export const FIRST_TURN_ONLY = keys("Fake Out, First Impression");

/** Damaging moves kept for their effect, not their damage: never replaced. */
export const UTILITY_ATTACKS = keys([
  "Fake Out, First Impression",
  // pivots
  "U-turn, Volt Switch, Flip Turn",
  // Speed control and stat drops on the target
  "Icy Wind, Electroweb, Rock Tomb, Bulldoze, Mud Shot, Low Sweep, Pounce, Drum Beating, Nuzzle, Snarl, Struggle Bug, Breaking Swipe, Lunge, Mystical Fire, Spirit Break, Chilling Water, Trop Kick, Skitter Smack, Apple Acid, Grav Apple, Fire Lash, Thunderous Kick, Bitter Malice",
  // item and field utility
  "Knock Off, Rapid Spin, Mortal Spin, Clear Smog, Throat Chop, Pollen Puff, Beat Up, Feint, Incinerate, Covet, Thief, Salt Cure",
].join(","));

/** Moves Optimize never suggests (it may keep them when the set already runs them). */
export const NEVER_SUGGEST = keys([
  // locked in for several turns
  "Outrage, Thrash, Petal Dance, Raging Fury, Uproar, Rollout, Ice Ball",
  // a charging turn first
  "Dig, Fly, Bounce, Dive, Phantom Force, Shadow Force, Sky Attack, Skull Bash, Meteor Beam, Razor Wind, Freeze Shock, Ice Burn, Sky Drop",
  // only work in a narrow situation
  "Focus Punch, Dream Eater, Belch, Last Resort, Snore, Spit Up, Natural Gift, Fling, Synchronoise, Steel Roller, Burn Up, Double Shock, Future Sight, Doom Desire, Upper Hand, Fake Out, First Impression, Retaliate, Echoed Voice, Round, Fury Cutter, Hyperspace Fury, Hyperspace Hole",
  // hit back only after being hit
  "Counter, Mirror Coat, Metal Burst, Bide, Comeuppance, Avalanche, Revenge",
  // the user faints, or pays half its HP
  "Explosion, Self-Destruct, Misty Explosion, Final Gambit, Memento, Steel Beam, Mind Blown, Chloroblast",
  // random
  "Present, Magnitude, Psywave, Fickle Beam",
  "Struggle",
].join(","));

/** Moves that need a recharge turn after they hit. */
const RECHARGE = keys("Hyper Beam, Giga Impact, Frenzy Plant, Blast Burn, Hydro Cannon, Rock Wrecker, Roar of Time, Prismatic Laser, Eternabeam, Meteor Assault");

/** Moves that need Sun to skip their charging turn. */
const SUN_CHARGE = keys("Solar Beam, Solar Blade");
/** Moves that need Rain to skip their charging turn. */
const RAIN_CHARGE = keys("Electro Shot");

/** Moves a team's weather or terrain is built around: kept while the team sets it. */
export const FIELD_PLAN_MOVES = {
  sun: keys("Weather Ball, Solar Beam, Solar Blade, Heat Wave, Eruption"),
  rain: keys("Weather Ball, Hurricane, Thunder, Electro Shot, Water Spout, Hydro Steam"),
  sand: keys("Weather Ball, Shore Up"),
  snow: keys("Weather Ball, Blizzard, Aurora Veil"),
  electric: keys("Rising Voltage, Terrain Pulse, Psyblade"),
  grassy: keys("Grassy Glide, Terrain Pulse"),
  psychic: keys("Expanding Force, Terrain Pulse"),
  misty: keys("Misty Explosion, Terrain Pulse"),
};

/** Moves that are not real attacks for a one-on-one: first-turn-only moves. */
export function isFirstTurnOnly(move) {
  return FIRST_TURN_ONLY.has(compact(move));
}

/**
 * Why a move may not be suggested, or "" when it may.
 * @param {object} record  the move record
 * @param {{sun?: boolean, rain?: boolean, stab?: boolean, doubles?: boolean}} team
 */
export function suggestBlock(record, { sun = false, rain = false, stab = false, doubles = true } = {}) {
  const k = compact(record?.name || "");
  if (!k) return "unknown move";
  if (NEVER_SUGGEST.has(k)) return "situational";
  if (RECHARGE.has(k)) return "needs a recharge turn";
  if (doubles && record.target === "allAdjacent") return "hits your partner too";
  if (SUN_CHARGE.has(k) && !sun) return "needs Sun";
  if (RAIN_CHARGE.has(k) && !rain) return "needs Rain";
  if (record.fixed_damage || record.fixed_damage_fraction || record.level_damage_min) return "fixed damage";
  if (String(record.special || "") === "ohko") return "one-hit KO move";
  if (/^(max|g-max)\s/i.test(record.name || "")) return "not usable";
  // Never-miss moves (Aerial Ace, Aura Sphere, Swift...) store `accuracy: true`, which is not a percentage.
  const accuracy = record.accuracy === true ? 100 : Number(record.accuracy ?? record.acc);
  if (Number.isFinite(accuracy) && accuracy > 0 && accuracy < 70 && !stab) return "inaccurate";
  return "";
}

/** A move that hits both opponents in Doubles. */
export function isSpreadMove(record) {
  return Boolean(record?.spread);
}

/** A move that hits more than once (it breaks Focus Sash and Sturdy). */
export function isMultiHit(record) {
  return Boolean(record?.hit_range) || Number(record?.hits) > 1 || ["triple_axel", "triple_kick", "party_multi_hit"].includes(String(record?.special || ""));
}

/** Moves that are not an attack but still a job (support roles). */
export const SUPPORT_MOVES = keys("Fake Out, Follow Me, Rage Powder, Ally Switch, Parting Shot, Tailwind, Trick Room, Helping Hand, Wide Guard, Quick Guard, Spore, Sleep Powder, Yawn, Thunder Wave, Will-O-Wisp, Encore, Taunt, Icy Wind, Electroweb, Snarl, Light Screen, Reflect, Aurora Veil, Haze, Coaching, Decorate, Pollen Puff, Life Dew, Heal Pulse, Instruct, After You, Feint, Imprison, Disable, Hypnosis, Nuzzle, Screech, Scary Face, Charm, Fake Tears, Memento");

/** Share of the damage dealt a move gives back to its user as HP. */
export const DRAIN_FRACTIONS = Object.fromEntries([
  ["Absorb", 0.5], ["Mega Drain", 0.5], ["Giga Drain", 0.5], ["Drain Punch", 0.5], ["Horn Leech", 0.5], ["Leech Life", 0.5],
  ["Parabolic Charge", 0.5], ["Matcha Gotcha", 0.5], ["Bitter Blade", 0.5], ["Dream Eater", 0.5], ["Draining Kiss", 0.75], ["Oblivion Wing", 0.75],
].map(([move, share]) => [compact(move), share]));

/** Moves that draw attacks to the user. */
export const REDIRECTION_MOVES = keys("Follow Me, Rage Powder, Spotlight");

/** Moves that are not a role at all (everyone runs them). */
export const NEUTRAL_STATUS = keys("Protect, Detect, Endure, Substitute, Spiky Shield, Baneful Bunker, King's Shield, Obstruct, Silk Trap, Burning Bulwark");
