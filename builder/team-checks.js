// Team Building Checks and archetype detection, ported from the Companion app.
//
// The app builds its checks in layers; the final behaviour is reproduced here:
//   profiles      _simple_profile_v187 (+ V303: the Mega a stone turns into)
//   check rows    _v201_check_* (+ V251 switch-ins) with the V201/V203 text
//   selection     V218 partial-team rows, V221 filter/sort, V403/V462 archetype
//                 row first, V418 Mega row second, V433 archetype toggle
//   archetype     _v403_archetype_features (+ V494 redirection, tailwind payoff)
//                 classified by team_evaluation_v462.classify_archetype_features
//
// The move groups come from the app's own tables (app-data analysisTables), so a
// rule change in the app reaches the website with the next export.

import { compact } from "./engine.js";

export const ARCHETYPE_CHECK_ID = "archetype_fit";

// --- V514 Team Building Checks (pokemon_champions_tool/team_check_rules_v514.py) ------
//
// Two new rows (Coverage Gaps, Speed Tiers, Lead Viability), "Defensive Switch-ins"
// relabelled "Shared Weakness" and rethresholded on a meta-weighted exposure, and three
// added Field / Weather rules. One stamp, `team_checks`, selects BEHAVIOUR: a recording
// made before the rule (no stamp) replays with the ten pre-V514 ids, the old label and the
// V251 thresholds, byte for byte.
//
// The ids, labels and descriptions are declared HERE rather than read from
// app-data.json's analysisTables, following the precedent already in this file
// (ARCHETYPE_CHECK_ID, the archetype entry in checkList(), SINGLES_DESCRIPTIONS, the
// "mega" row). The deployed data/builder/app-data.json is version 20260921172816 and is
// already behind the app -- it contains neither _V494_MOVES_NEEDING_SUPPORT nor
// V510_GUARANTEED_MOVE_SHARE although tools/export_web_builder_data.py lists both -- and
// regenerating it rewrites a multi-megabyte file in a worktree the owner's pipeline
// commits and deploys every few hours. tests/run-singles-smoke.mjs asserts these strings
// still equal the app's, so the duplication is paid for by a test.
export const TEAM_CHECK_RULES = 1;

/** A `team_checks` stamp as a version: 0 (off) for null / undefined / false / "" / "0".
 *
 *  Coerces exactly as `team_check_rules_v514.active_rule` does, which is the whole job of
 *  the pair. Two asymmetries were measured and both are gone: a NEGATIVE version ("-1",
 *  "-5") used to fall through to the current version here while the app read it as off, and
 *  a FRACTIONAL one ("1.9") used to stay 1.9 here while the app truncated it to 1. A
 *  version is a non-negative integer, so it is truncated and a non-positive one is off.
 *
 *  The one remaining difference is deliberate and belongs to the two domains: an ABSENT
 *  value means "no stamp on this recording", i.e. a recording made before the rule, so it
 *  is off; an absent environment variable in the app means production, so it is on. */
export function teamCheckRulesOption(value) {
  if (value === null || value === undefined || value === false) return 0;
  const text = String(value).trim().toLowerCase();
  if (!text || text === "0" || text === "off" || text === "false" || text === "no" || text === "none") return 0;
  const n = Number(text);
  if (!Number.isFinite(n)) return TEAM_CHECK_RULES;
  const version = Math.trunc(n);
  return version > 0 ? version : 0;
}

/** team_check_rules_v514.V514_NEW_IDS -- the ids this rule adds to the catalogue.
 *
 *  They are NOT unioned onto a saved selection: see `selectedIds`. */
export const V514_NEW_IDS = ["coverage_gaps", "speed_tiers", "lead_viability"];

/** team_check_rules_v514.V514_CHECK_ROWS */
export const V514_CHECKS = [
  ["coverage_gaps", "Coverage Gaps",
    "Checks whether the team has a super-effective answer to the Pokemon it will actually meet, and names the ones it can only hit for normal damage."],
  ["speed_tiers", "Speed Tiers",
    "Checks whether too many of the team sit at almost the same Speed, so one opposing Tailwind or Icy Wind changes the turn order for all of them at once."],
  ["lead_viability", "Lead Viability",
    "Estimates how many of your fifteen lead pairs are worth bringing, from the turn-one tools each pair has. It is an estimate, not a played-out game."],
];

/** The id does NOT change: every saved selection and all eight other references stay. */
export const V514_RELABELLED = {
  defensive_switch_ins: ["Shared Weakness",
    "Checks whether three or more of the team lose to the same attacking type, weighted by how often the Top X actually attacks with it."],
  field_weather_consistency: ["Field / Weather Consistency",
    "Checks that the team's weather and terrain choices support it instead of fighting each other, its own priority, or a move that needs a condition nobody sets."],
};

// Thresholds, every one measured over 2827 complete six-slot real tournament teams
// (data/builder/known-teams.json) against the Top 30 of 2026-09-25.
// scratchpad/checks/measure.mjs .. measure5b.mjs are the derivation.
const COVERAGE_RED_FRACTION = 0.27;      // 8 of 30 -> 4.3% of real teams
const COVERAGE_YELLOW_FRACTION = 0.17;   // 5 of 30 -> 18.5%
const COVERAGE_RED_FLOOR = 3;
const COVERAGE_YELLOW_FLOOR = 2;
const SPEED_TIGHT_BAND = 10;
const SPEED_WIDE_BAND = 20;
const SPEED_TIGHT_RED = 4;               // 0.6% after the two gates
const SPEED_WIDE_RED = 5;
const SPEED_WIDE_YELLOW = 4;             // 3.0% after the two gates
const SPEED_BAND_LOW_QUANTILE = 0.10;
const SPEED_BAND_HIGH_QUANTILE = 0.90;
const SHARED_WEAK_GATE = 3;              // the user's literal condition, kept as a gate
const SHARED_RESIST_DISCOUNT = 0.5;
const SHARED_RED_EXPOSURE = 4.0;         // 5.4%
const SHARED_YELLOW_EXPOSURE = 3.0;      // 23.9% cumulative
const LEAD_BAR = 5.6;                    // 25th percentile of 42,405 real lead pairs
const LEAD_RED_FRACTION = 0.27;          // <= 4 of 15 -> 1.7%
const LEAD_YELLOW_FRACTION = 0.55;       // <= 8 of 15 -> 11.9% cumulative
// V514 revision: field severity is a WEIGHT, not a line count. `problems.length >= 2 -> red`
// is what the app's pre-V514 rule did, so adding one rule mechanically promoted any team that
// already had one problem -- the owner's own Doubles Trick Room team went yellow -> red on
// Indeedee's Psychic Terrain plus Rillaboom's Grassy Terrain, and because Suggestions prices a
// candidate on the check pressure a swap removes, a 12-point field red at one slot made almost
// every suggestion say "remove Indeedee-F" (tests/run-suggest-scoring.mjs, the V512 sole-source
// guards). HARD = a dependency that does not work; SOFT = a conflict the team can play around.
// Red needs 2.0: two broken dependencies, or one plus two playable conflicts, or four playable
// conflicts. MEASURED over the same 2827 complete six-slot teams in known-teams.json: counting
// lines flags 4.7% red / 27.1% yellow, weighing them flags 1.5% red / 30.4% yellow -- 93 teams
// (3.3 points) move from red to yellow, nothing moves the other way, and the total flagged
// share is unchanged. The owner's own team is one of the 93.
const FIELD_HARD_WEIGHT = 1.0;
const FIELD_SOFT_WEIGHT = 0.5;
const FIELD_RED_WEIGHT = 2.0;
// The meta type weight is smoothed and floored; see META_WEIGHT_SMOOTHING in the app module
// for the derivation. `count / average` gave a type the Top X never attacks with weight
// EXACTLY 0, so its exposure was 0 however many members were weak to it -- reachable from the
// Top X spinner alone (at Top 10 Electric, Ice, Flying and Fairy were all 0). Smoothing with
// k = 1 leaves weight == 1.0 exactly at the average, so the calibration point of the 3.0 / 4.0
// bars does not move; the floor is the yellow bar divided by the largest weak count a six-slot
// team can have (6 * 0.5 = 3.0), so "every member loses to it" is the minimum condition under
// which an unused type can still be raised. MEASURED: at Top 30 the correction changes the
// Shared Weakness verdict of ONE of 2827 real six-slot teams (red 153 -> 153, yellow 523 ->
// 522), while at Top 20 it rescues Fairy, at Top 10 Electric / Ice / Flying / Fairy and at Top 4
// ten of the eighteen types from weight exactly 0.
const META_WEIGHT_SMOOTHING = 1.0;
const META_WEIGHT_FLOOR = 0.5;

/** MEASURED over the 2827 real six-slot teams: the eight fired on 8.4% of them, these three
 *  fire on 7.7%. Per removed entry: steelroller 0.5% (14 teams, every one a false positive by
 *  construction), risingvoltage 0.2%, terrainpulse 0.1%, mistyexplosion 0.03%, psyblade 0. What
 *  the check is for is untouched: auroraveil with no snow is 5.1% of teams on its own.
 *
 *  A move is flagged only when its condition changes what the move DOES -- it fails, or it
 *  loses its priority, or it loses its spread -- never when the condition is only a damage
 *  multiplier.  Removed after verification, each one by that rule: `terrainpulse` (without a
 *  terrain it is a 50 BP Normal special, the same shape as Weather Ball, which this table
 *  excluded for exactly that reason), `mistyexplosion` (a working 100 BP Fairy attack that
 *  loses a 1.5x), `risingvoltage` and `psyblade` (ditto), and `steelroller` (the terrain it
 *  needs is usually the OPPONENT's -- the move is brought to remove a terrain, so "nothing on
 *  the team sets it" is the intended state and flagging it was a false positive by
 *  construction).  Still excluded, unchanged: Blizzard / Thunder / Hurricane (accuracy only),
 *  Weather Ball, Solar Beam / Solar Blade (charge), Electro Shot. */
const MOVES_NEEDING_CONDITION = {
  auroraveil: "snow", grassyglide: "grassy", expandingforce: "psychic",
};

/** (attacking type, base power) for the nineteen attacks the app files as status because
 *  they also lower a stat.  Identical to `COVERAGE_EXTRA_ATTACKS` in
 *  pokemon_champions_tool/team_check_rules_v514.py, and carried in the shared fixture so
 *  both suites can assert their own copy against it.
 *
 *  Why a table and not "power > 0". `_v94_move_bucket` (`part_010.py:487`) forces every
 *  member of `_SUPPORT_STATUS_MOVE_KEYS_V95` back to power 0.0 and the app restores the
 *  power only for the five the curated `_v196` table happens to carry (Knock Off, Bulldoze,
 *  Icy Wind, Snarl, Fake Out), while this site's exported app-data.json keeps a real power
 *  in `simple` for all nineteen.  So "power > 0" admitted 14 attacking types here that the
 *  Companion dropped, and 507 of the 2827 real six-slot teams in known-teams.json (17.9%)
 *  carry at least one of them -- the two products could reach different Coverage Gaps
 *  verdicts on nearly a fifth of real teams, and the shared fixture could not see it.
 *  Nothing is invented: every pair is the `simple` triple in the app's own export, i.e. the
 *  set of moves whose `simple` and `analysis.bucket` triples differ there. */
export const COVERAGE_EXTRA_ATTACKS = {
  acidspray: ["Poison", 40], breakingswipe: ["Dragon", 60], bulldoze: ["Ground", 60],
  chillingwater: ["Water", 50], clearsmog: ["Poison", 50], electroweb: ["Electric", 55],
  fakeout: ["Normal", 40], icywind: ["Ice", 55], knockoff: ["Dark", 65],
  lowsweep: ["Fighting", 65], lunge: ["Bug", 80], mudshot: ["Ground", 55],
  mysticalfire: ["Fire", 75], nuzzle: ["Electric", 20], rocktomb: ["Rock", 60],
  skittersmack: ["Bug", 70], snarl: ["Dark", 55], spiritbreak: ["Fairy", 75],
  strugglebug: ["Bug", 50],
};

/** ONE definition of "this move attacks", shared by the team's coverage, its best power and
 *  the meta's type weights, so the three cannot drift apart.  Mirrors `attack_of`. */
function attackOf(move, reading) {
  const extra = COVERAGE_EXTRA_ATTACKS[compact(move)];
  if (extra) return [pyTitleWord(String(extra[0])), Number(extra[1])];
  if (!reading) return null;
  const [type, , power] = reading;
  const bp = Number(power) || 0;
  if (!(bp > 0)) return null;
  return [pyTitleWord(String(type || "")), bp];
}

/** Said once, by every meta-relative row, while the Top X can still move. */
const PROVISIONAL_NOTE = "The Top Meta is still syncing, so this reading can change once it finishes.";
/** Whether there is a Top X to measure against at all. */
const metaLoaded = (context) => Boolean(context && (context.members || []).length);
const metaProvisional = (context) => Boolean(context && context.provisional);
const withNote = (text, context) => {
  if (!metaProvisional(context)) return text;
  const body = String(text || "").trim();
  return body ? `${body} ${PROVISIONAL_NOTE}` : PROVISIONAL_NOTE;
};
/** `_SIMPLE_WEATHER_SETTERS_V187["snow"]` omits Hail, whose own description in this
 *  game's data is "For 5 turns, hail crashes down."  The exported table is generated and
 *  is not edited, so the extra source is declared beside the needs table on both sides. */
const EXTRA_SNOW_SETTERS = ["hail"];
const CONDITION_WORDS = {
  snow: "snow", sun: "sun", rain: "rain", sand: "sand", grassy: "Grassy Terrain",
  psychic: "Psychic Terrain", electric: "Electric Terrain", misty: "Misty Terrain",
  terrain: "a terrain", weather: "weather",
};
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six"];

/** `floor(x + 0.5)`.  NOT Math.round: Python rounds a .5 to even and JavaScript rounds
 *  it up, so at Top X = 50 `round(0.17 * X)` is 8 there and 9 here.  Both sides use this. */
function halfUp(value) {
  return Math.floor(Number(value) + 0.5);
}

/** The corpus scripts' quantile: `a[trunc(p * (n - 1))]` on ascending values. */
function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.max(0, Math.min(sorted.length - 1, Math.trunc(Number(p) * (sorted.length - 1))));
  return Number(sorted[i]);
}

function countWord(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(value);
}

/** A Speed as the row prints it: 97, not 97.0 (matching `_speed_text`). */
function speedText(value) {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Python's `f"{value:.2f}"`. */
function fixed2(value) {
  return (Number(value) || 0).toFixed(2);
}

const TYPES = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy"];
const WEATHERS = ["rain", "sun", "sand", "snow"];
const SEVERITY_ORDER = { red: 0, yellow: 1, good: 2, green: 2 };

// Singles (the website's own rule; the app's checks are written for Doubles). With one
// Pokemon a side there is no partner to help and no second target: a spread move hits
// one Pokemon, so the Spread Damage check and the "Spread attackers" archetype
// requirements are skipped, and these partner-only moves count for no check group.
const SINGLES_NO_EFFECT = new Set(["followme", "ragepowder", "spotlight", "helpinghand", "coaching", "decorate", "allyswitch", "afteryou", "aromaticmist", "holdhands"]);
// V514: lead_viability joins the list, and the Companion now agrees -- its
// `CheckRules.lead_viability` returns None in a Singles format, which removes the row there
// too. Every term in that check is about a PAIR (fifteen pairs, only one Fake Out lands, two
// Trick Room setters in one lead, Wide Guard, Helping Hand, redirection); a Singles lead is one
// Pokemon, so "an estimated N of your 15 lead pairs are worth bringing" is a number about
// something the format does not have. There is a real Singles lead question, but this check
// does not measure it and answering a different question under the same name would be
// dishonest. coverage_gaps and speed_tiers are format-neutral and stay.
const SINGLES_SKIPPED_CHECKS = new Set(["spread_damage", "lead_viability"]);

/** The archetype texts that name spread pressure or redirection, as they read in Singles. */
const SINGLES_ARCHETYPE_WHY = {
  offense: "Offense needs several immediate attackers and enough speed or priority to keep tempo.",
  setup: "Setup teams need multiple win conditions and protection through disruption, screens, or safe switches.",
};

/** The Customize list's descriptions where the app's text is about Doubles. */
const SINGLES_DESCRIPTIONS = {
  protect_positioning: "Checks for Protect-style moves and safe switching tools such as pivoting moves, Fake Out or Intimidate.",
  spread_damage: "Doubles only: checks whether the team can pressure both opposing slots with spread attacks. In Singles every move hits one Pokémon, so this check is skipped.",
  utility_disruption: "Checks for utility such as Fake Out, Taunt, Haze, Encore, status, healing, screens, pivoting or other disruption.",
};

/** Whether an evaluator (or a stand-in with a `format`) is in Singles. */
function isSingles(evaluator) {
  return String(evaluator?.format || "").toLowerCase().startsWith("single");
}

// part_016 _V201_SCORE_THRESHOLDS (the fallback when a row has no threshold)
const SCORE_THRESHOLDS = {
  good: "",
  yellow: "Needs Attention, usable, but shallow or dependent on too few Pokemon.",
  red: "Problem, missing or very fragile; fix this before trusting the team.",
};

const ARCHETYPE_DISPLAY = {
  "trick room": "Trick Room", "bulky offense": "Bulky Offense", "hyper offense": "Hyper Offense",
  "semi-stall": "Semi-Stall", goodstuff: "Goodstuff", "perish trap": "Perish Trap",
};

/** The archetypes Auto Build and the check can name, in the app's order (V432). */
export const ARCHETYPES = [
  ["Balanced", "balanced"], ["Offense", "offense"], ["Bulky Offense", "bulky offense"], ["Hyper Offense", "hyper offense"],
  ["Stall", "stall"], ["Semi-Stall", "semi-stall"], ["Goodstuff", "goodstuff"], ["Trick Room", "trick room"],
  ["Tailwind", "tailwind"], ["Rain", "rain"], ["Sun", "sun"], ["Sand", "sand"], ["Snow", "snow"],
  ["Terrain", "terrain"], ["Screens", "screens"], ["Setup", "setup"], ["Perish Trap", "perish trap"],
];

function asSet(values) {
  return new Set((values || []).map((v) => String(v)));
}

/** A move-group table normalised the way `_simple_key_v187` normalises a move name. */
function compactSet(values) {
  return new Set((values || []).map((v) => compact(String(v))).filter(Boolean));
}

function intersects(set, other) {
  for (const value of set) if (other.has(value)) return true;
  return false;
}

function pyTitleWord(text) {
  return String(text).replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/** _simple_join_v187 */
export function simpleJoin(values, limit = 6) {
  const clean = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value ?? "").trim();
    const k = text.toLowerCase();
    if (text && !seen.has(k)) {
      seen.add(k);
      clean.push(text);
    }
  }
  const shown = clean.slice(0, Math.max(1, Number(limit) || 1));
  const suffix = clean.length > shown.length ? ` +${clean.length - shown.length} more` : "";
  return shown.join(", ") + suffix;
}

/** _v203_sentence */
function sentence(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ");
}

/** _v201_status_label */
export function statusLabel(severity) {
  const sev = String(severity || "good").toLowerCase();
  return sev === "red" ? "Problem" : sev === "yellow" ? "Needs Attention" : "Good";
}

/** _v203_clean_score_phrase */
function cleanScorePhrase(severity, threshold = "") {
  const sev = String(severity || "good").toLowerCase();
  if (sev === "good") return "";
  let text = sentence(threshold);
  if (!text) text = SCORE_THRESHOLDS[sev] || "";
  text = text.replace(/^Good\s*=\s*/i, "").trim();
  text = text.replace(/^(?:Needs\s+Attention|Need\s+Attention)\s*=\s*/i, "Needs Attention, ").trim();
  text = text.replace(/^Problem\s*=\s*/i, "Problem, ").trim();
  text = text.replace(/\bNeed\s+Attention\b/gi, "Needs Attention");
  return text.replaceAll("Needs Attention —", "Needs Attention,").replaceAll("Needs Attention -", "Needs Attention,");
}

function severityRank(row) {
  return SEVERITY_ORDER[String(row?.severity || "good").toLowerCase()] ?? 2;
}

function rowId(row) {
  return String(row?.check_id || row?.kind || "").trim();
}

function stableSort(rows, keyFn) {
  return rows
    .map((row, index) => [keyFn(row), index, row])
    .sort((a, b) => {
      for (let i = 0; i < a[0].length; i += 1) {
        if (a[0][i] < b[0][i]) return -1;
        if (a[0][i] > b[0][i]) return 1;
      }
      return a[1] - b[1];
    })
    .map(([, , row]) => row);
}

/** team_evaluation_v462.classify_archetype_features */
export function classifyArchetype(features) {
  const f = features || {};
  const n = (field) => Number(f[field]) || 0;
  const setters = f.weather_setters || {};
  const users = f.weather_users || {};
  const beneficiaries = f.weather_beneficiaries || {};
  const teamSize = Math.max(1, n("team"));
  const trSet = n("trick_room_setters");
  const slow = n("slow_attackers");
  const twSet = n("tailwind_setters");
  const fast = n("fast");
  const scores = { balanced: 35.0 };
  scores["trick room"] = trSet * 48 + slow * 11 + n("protect") * 2 + n("spread") * 3;
  scores.tailwind = twSet * 46 + fast * 9 + n("spread") * 3;
  for (const weather of WEATHERS) {
    scores[weather] = (Number(setters[weather]) || 0) * 46 + (Number(users[weather]) || 0) * 11 + (Number(beneficiaries[weather]) || 0) * 7 - Math.max(0, n("weather_types") - 1) * 18;
  }
  scores.terrain = n("terrain_setters") * 48 + n("terrain_beneficiaries") * 12;
  scores.screens = n("screens_distinct") * 26 + n("screen_providers") * 14 + n("light_clay") * 12 + n("setup") * 5;
  scores["perish trap"] = n("perish_song") * 55 + n("trap_sources") * 32 + n("protect") * 4;
  scores.setup = n("setup") * 22 + n("redirection_fakeout") * 9 + n("speed_control") * 4;
  scores.stall = n("bulky") * 9 + n("recovery") * 14 + n("denial") * 9 + n("protect") * 4;
  scores["semi-stall"] = n("bulky") * 8 + n("recovery") * 10 + n("denial") * 6 + n("attackers") * 3;
  scores["hyper offense"] = n("attackers") * 9 + fast * 8 + n("speed_control") * 6 + n("priority") * 4;
  scores.offense = n("attackers") * 8 + fast * 5 + n("spread") * 4 + n("speed_control") * 5;
  scores["bulky offense"] = n("attackers") * 7 + n("bulky") * 8 + n("sustain_pivot") * 5;
  scores.goodstuff = n("attackers") * 5 + n("utility_categories") * 8 + n("positioning") * 6 + n("speed_control") * 5;
  scores.balanced += Math.min(n("physical"), 2) * 5 + Math.min(n("special"), 2) * 5 + n("utility_providers") * 4 + n("bulky") * 3;

  const allowed = new Set(["balanced", "offense", "bulky offense", "hyper offense", "stall", "semi-stall", "goodstuff"]);
  if ((trSet >= 2 && slow >= 2) || (trSet >= 1 && slow >= Math.max(4, teamSize - 2))) allowed.add("trick room");
  if ((twSet >= 2 && fast >= 2) || (twSet >= 1 && fast >= 4)) allowed.add("tailwind");
  for (const weather of WEATHERS) {
    if ((Number(setters[weather]) || 0) >= 1 && (Number(beneficiaries[weather]) || 0) >= 2) allowed.add(weather);
  }
  if (n("terrain_setters") >= 1 && n("terrain_beneficiaries") >= 2) allowed.add("terrain");
  if (n("screens_distinct") >= 2 && n("screen_providers") >= 1) allowed.add("screens");
  if (n("perish_song") >= 1 && n("trap_sources") >= 1) allowed.add("perish trap");
  if (n("setup") >= 2) allowed.add("setup");

  // max(allowed, key=(score, name)): the higher score, then the later name.
  let best = null;
  for (const candidate of allowed) {
    const score = Number(scores[candidate]) || 0;
    if (best === null || score > best[0] || (score === best[0] && candidate > best[1])) best = [score, candidate];
  }
  const key = best ? best[1] : "balanced";
  return [archetypeDisplay(key), key, scores];
}

export function archetypeDisplay(key) {
  return ARCHETYPE_DISPLAY[key] || pyTitleWord(key);
}

function minRequirement(label, current, target, critical = false) {
  const c = Math.trunc(Number(current) || 0);
  const t = Math.trunc(Number(target) || 0);
  return { label, current: c, target: t, display: `${c}/${t}`, met: c >= t, critical: Boolean(critical) };
}

function maxRequirement(label, current, target, critical = false) {
  const c = Math.trunc(Number(current) || 0);
  const t = Math.trunc(Number(target) || 0);
  return { label, current: c, target: t, display: `${c} (max ${t})`, met: c <= t, critical: Boolean(critical) };
}

/** _v403_archetype_requirements (+ V494: Perish Trap wants redirection; Singles: see below) */
export function archetypeRequirements(key, f) {
  const specs = doublesRequirements(key, f);
  if (!f?.singles) return specs;
  // Singles: no spread moves and no partner to redirect for or to protect while it sets
  // up, so those requirements go; Perish Trap keeps its target in with trapping instead.
  return specs
    .filter((req) => !["Spread attackers", "Redirection / Fake Out"].includes(req.label))
    .map((req) => (req.label === "Redirection users" ? minRequirement("Trapping users", f.trap_sources || 0, 1, true) : req));
}

function doublesRequirements(key, f) {
  const minimum = (label, field, target, critical = false) => minRequirement(label, f[field] || 0, target, critical);
  const weather = f.weather_setters || {};
  const weatherUsers = f.weather_users || {};
  const beneficiaries = f.weather_beneficiaries || {};
  const conflicts = (desired) => Math.max(0, (Number(f.weather_types) || 0) - (weather[desired] ? 1 : 0));
  const mixedDamage = Math.min(Number(f.physical) || 0, 1) + Math.min(Number(f.special) || 0, 1);
  const specs = {
    balanced: [
      minimum("Physical attackers", "physical", 2), minimum("Special attackers", "special", 2),
      minimum("Speed-control users", "speed_control", 1, true), minimum("Utility providers", "utility_providers", 2),
      minimum("Protect / positioning users", "protect_positioning", 4), minimum("Bulky members", "bulky", 2),
    ],
    offense: [
      minimum("Immediate attackers", "attackers", 4), minimum("Speed-control users", "speed_control", 1, true),
      minimum("Spread attackers", "spread", 2), minimum("Fast attackers", "fast", 2),
      minimum("Priority users", "priority", 1), minimum("Positioning users", "positioning", 2),
    ],
    "bulky offense": [
      minimum("Attackers", "attackers", 3), minimum("Bulky members", "bulky", 3),
      minimum("Speed-control users", "speed_control", 1, true), minimum("Protect users", "protect", 3),
      minimum("Recovery / pivot users", "sustain_pivot", 2), minRequirement("Mixed damage modes", mixedDamage, 2),
    ],
    "hyper offense": [
      minimum("Attackers", "attackers", 5, true), minimum("Fast attackers", "fast", 4),
      minimum("Speed-control users", "speed_control", 2, true), minimum("Spread attackers", "spread", 2),
      minimum("Priority users", "priority", 2),
    ],
    stall: [
      minimum("Bulky members", "bulky", 4, true), minimum("Recovery users", "recovery", 3),
      minimum("Protect users", "protect", 4), minimum("Disruption users", "denial", 3),
      minimum("Speed / board control", "speed_control", 1),
    ],
    "semi-stall": [
      minimum("Bulky members", "bulky", 3), minimum("Recovery users", "recovery", 2),
      minimum("Protect users", "protect", 3), minimum("Disruption users", "denial", 2),
      minimum("Attackers", "attackers", 2),
    ],
    goodstuff: [
      minimum("Attackers", "attackers", 3), minimum("Physical damage", "physical", 1),
      minimum("Special damage", "special", 1), minimum("Utility categories", "utility_categories", 3),
      minimum("Positioning users", "positioning", 3), minimum("Speed-control users", "speed_control", 1),
    ],
    "trick room": [
      minimum("Trick Room setters", "trick_room_setters", 2, true), minimum("Slow attackers", "slow_attackers", 3),
      minimum("Protect users", "protect", 4), minimum("Spread attackers", "spread", 1),
      minimum("Priority users", "priority", 1),
    ],
    tailwind: [
      minimum("Tailwind setters", "tailwind_setters", 2, true), minimum("Fast attackers", "fast", 4),
      minimum("Spread attackers", "spread", 2), minimum("Priority users", "priority", 1),
      minimum("Positioning users", "positioning", 2),
    ],
    screens: [
      minimum("Distinct screens", "screens_distinct", 2, true), minimum("Screen providers", "screen_providers", 2),
      minimum("Light Clay users", "light_clay", 1), minimum("Setup users", "setup", 2),
      minimum("Protect / positioning", "protect_positioning", 3),
    ],
    setup: [
      minimum("Setup users", "setup", 2, true), minimum("Redirection / Fake Out", "redirection_fakeout", 2),
      minimum("Speed-control users", "speed_control", 1), minimum("Protect users", "protect", 3),
      minimum("Attackers", "attackers", 3),
    ],
    terrain: [
      minimum("Terrain setters", "terrain_setters", 1, true), minimum("Terrain beneficiaries", "terrain_beneficiaries", 2),
      maxRequirement("Conflicting terrains", f.terrain_types || 0, 1), minimum("Positioning users", "positioning", 2),
    ],
    "perish trap": [
      minimum("Perish Song users", "perish_song", 1, true), minimRedirection(f),
      minimum("Protect users", "protect", 3), minimum("Sustain / pivot users", "sustain_pivot", 2),
      minimum("Speed-control users", "speed_control", 1),
    ],
  };
  for (const [desired, display] of [["rain", "Rain"], ["sun", "Sun"], ["sand", "Sand"], ["snow", "Snow"]]) {
    const setterTarget = desired === "rain" || desired === "sun" ? 2 : 1;
    specs[desired] = [
      minRequirement(`${display} setters`, weather[desired] || 0, setterTarget, true),
      minRequirement(`${display} beneficiaries`, beneficiaries[desired] || 0, 3),
      minRequirement(`${display} ability users`, weatherUsers[desired] || 0, 1),
      minimum("Protect users", "protect", 3),
      maxRequirement("Competing weather setters", conflicts(desired), 0, true),
    ];
  }
  return specs[key] || specs.balanced;
}

// V494 replaced Perish Trap's Singles trapping requirement with redirection.
function minimRedirection(f) {
  return minRequirement("Redirection users", f.redirection_users || 0, 1, true);
}

/** archetype_payoff.fast_tier: the meta's fast quarter. */
export function fastTier(metaSpeeds) {
  const speeds = (metaSpeeds || []).map(([, speed]) => Number(speed) || 0).filter((s) => s > 0).sort((a, b) => a - b);
  if (!speeds.length) return 130.0;
  return speeds[Math.trunc(0.75 * (speeds.length - 1))];
}

/** archetype_payoff.tailwind_beneficiaries */
export function tailwindBeneficiaries(profiles, metaSpeeds) {
  const tier = fastTier(metaSpeeds);
  let count = 0;
  for (const profile of profiles || []) {
    if (!(profile.has_damage || profile.damage_pressure || Number(profile.damaging_count))) continue;
    const speed = Number(profile.effective_speed ?? profile.speed ?? 0) || 0;
    if (speed > 0 && speed < tier && tier <= speed * 2) count += 1;
  }
  return count;
}

export class TeamChecks {
  /**
   * @param {TeamEvaluator} evaluator  supplies stats, types, move data and names
   */
  constructor(evaluator) {
    this.ev = evaluator;
    this.singles = isSingles(evaluator);
    const data = evaluator.engine.data || {};
    const tables = data.analysisTables || {};
    this.tables = tables;
    this.abilityFields = data.abilityFields || {};
    this.displayNames = new Map(Object.entries(data.displayNames || {}).map(([name, shown]) => [compact(name), shown]));
    // V514: the stamp. `evaluator.checkRules` is the carrier, so nothing else needs a new
    // argument; builder-page.js constructs TeamChecks with a stand-in `{engine, format}`
    // and no evaluator, and the `??` default is what makes Customize show the new rows.
    this.rules = teamCheckRulesOption(evaluator?.checkRules ?? TEAM_CHECK_RULES);
    const baseRows = (tables._SIMPLE_CHECKS_V187 || []).map(([id, label, description]) =>
      (this.rules && V514_RELABELLED[id] ? [id, V514_RELABELLED[id][0], V514_RELABELLED[id][1]] : [id, label, description]));
    const known = new Set(baseRows.map(([id]) => id));
    const rows = [...baseRows, ...(this.rules ? V514_CHECKS.filter(([id]) => !known.has(id)) : [])];
    this.checks = rows.map(([id, label, description]) => ({ id, label, description }));
    this.baseIds = this.checks.map((c) => c.id);
    this.labels = Object.fromEntries(this.checks.map((c) => [c.id, c.label]));
    this._metaCtx = new Map();
    this.oldMap = tables._V201_OLD_CHECK_MAP || {};
    this.groups = {
      protect: asSet(tables._SIMPLE_PROTECT_V187),
      speed: asSet(tables._SIMPLE_SPEED_V187),
      priority: asSet(tables._SIMPLE_PRIORITY_V187),
      positioning: asSet(tables._SIMPLE_POSITIONING_V187),
      spread: asSet(tables._SIMPLE_SPREAD_V187),
      // `_V250_FAKE_OUT` is `["fake out"]` -- a DISPLAY spelling, while a profile's
      // move_keys are compacted -- so reading it through asSet() would never match.
      fakeOut: compactSet(tables._V250_FAKE_OUT || ["fakeout"]),
    };
    this.utilityGroups = Object.entries(tables._SIMPLE_UTILITY_GROUPS_V187 || {}).map(([label, keys]) => [label, asSet(keys)]);
    const keyed = (table) => Object.entries(table || {}).map(([name, keys]) => [name, asSet(keys)]);
    this.weatherSetters = keyed(tables._SIMPLE_WEATHER_SETTERS_V187);
    this.weatherUsers = keyed(tables._SIMPLE_WEATHER_USERS_V187);
    this.terrainSetters = keyed(tables._SIMPLE_TERRAIN_SETTERS_V187);
    this.archetypeSets = {
      setup: asSet(tables._V403_SETUP_MOVES),
      recovery: asSet(tables._V403_RECOVERY_MOVES),
      denial: asSet(tables._V403_DENIAL_MOVES),
      screen: asSet(tables._V403_SCREEN_MOVES),
      redirection: asSet(tables._V403_REDIRECTION_MOVES),
      pivot: asSet(tables._V403_PIVOT_MOVES),
      trapMoves: asSet(tables._V403_TRAP_MOVES),
      trapAbilities: asSet(tables._V403_TRAP_ABILITIES),
    };
    this.descriptions = tables._V403_ARCHETYPE_DESCRIPTIONS || {};
  }

  /** Every check the Customize list offers (V433: Archetype first). */
  allCheckIds() {
    return [ARCHETYPE_CHECK_ID, ...this.baseIds.filter((id) => id !== ARCHETYPE_CHECK_ID)];
  }

  /** The Customize list: id, label and the app's description. */
  checkList() {
    return [
      { id: ARCHETYPE_CHECK_ID, label: "Archetype", description: "Checks the current archetype's setters, payoffs, Speed plan, support, and other archetype-specific requirements." },
      ...this.checks.filter((c) => c.id !== ARCHETYPE_CHECK_ID).map((c) => (this.singles ? { ...c, description: SINGLES_DESCRIPTIONS[c.id] || c.description } : c)),
    ];
  }

  /** _v200_selected_check_ids: every check when nothing was saved; old ids mapped forward.
   *
   *  A SAVED SELECTION IS TAKEN LITERALLY, and the Companion now agrees (see
   *  `derived_selection` in team_check_rules_v514.py, which is an identity for this reason).
   *  Nothing saved -> every check, including the three V514 rows, which is how a user who
   *  never opened Customize gets them. A saved list -> exactly that list, mapped forward. An
   *  explicit [] -> nothing, because "I turned every check off" is a supported state and this
   *  page has a row for it. The app used to union V514_NEW_IDS onto a saved list, so the
   *  same person's Companion and browser disagreed about their own settings, and a user who
   *  had turned everything off got three checks back. */
  selectedIds(raw) {
    if (raw === undefined || raw === null) return new Set(this.allCheckIds());
    const values = typeof raw === "string" ? raw.split(",").map((v) => v.trim()).filter(Boolean) : [...raw];
    const selected = new Set();
    for (const value of values) {
      const k = String(value || "").trim();
      if (this.baseIds.includes(k)) selected.add(k);
      for (const mapped of this.oldMap[k] || []) if (this.baseIds.includes(mapped)) selected.add(mapped);
    }
    if (values.includes(ARCHETYPE_CHECK_ID)) selected.add(ARCHETYPE_CHECK_ID);
    return selected;
  }

  /** pokemon_display_name: the Showdown spelling of a form.  A Mega the table
   *  has no entry for gets Showdown's gendered name: the app's single "Mega
   *  Meowstic" is Meowstic-M-Mega, and the evaluation's threat "Mega
   *  Meowstic-F" (the female meta row holding the stone) is Meowstic-F-Mega. */
  showdownName(name) {
    const text = String(name ?? "").trim();
    const shown = this.displayNames.get(compact(text));
    if (shown) return shown;
    const mega = text.match(/^Mega\s+(.+)$/i);
    if (mega) {
      const base = this.showdownName(mega[1]);
      const gendered = this.displayNames.get(compact(`${base}-Mega`)) || this.displayNames.get(compact(`${base}-M-Mega`));
      if (gendered) return gendered;
    }
    return text;
  }

  /**
   * One team slot as the checks read it.
   * @param {object} entry  {pokemon, item, form, ability, moves}: the slot as saved
   * @param {object} mon    the evaluator's team mon for that slot (Mega applied)
   */
  profile(entry, mon) {
    const moves = (entry.moves || []).map((m) => String(m ?? "").trim()).filter(Boolean).slice(0, 4);
    const moveKeys = new Set(moves.map(compact));
    const ability = String(mon.ability || "");
    const abilityKey = compact(ability);
    const physical = [];
    const special = [];
    const damagingTypes = new Set();
    for (const move of moves) {
      const [type, category, power] = this.ev.simpleMoveInfo(move);
      if (category === "physical" && power > 0) {
        physical.push(move);
        damagingTypes.add(type);
      } else if (category === "special" && power > 0) {
        special.push(move);
        damagingTypes.add(type);
      }
    }
    const allKeys = new Set([...moveKeys, abilityKey]);
    const weatherSet = new Set(this.weatherSetters.filter(([, keys]) => intersects(allKeys, keys)).map(([w]) => w));
    const weatherUse = new Set(this.weatherUsers.filter(([, keys]) => keys.has(abilityKey)).map(([w]) => w));
    const terrainSet = new Set(this.terrainSetters.filter(([, keys]) => intersects(allKeys, keys)).map(([t]) => t));
    // V303: the Ability's own field, as _v51 reads it.
    const [weather, terrain] = this.abilityFields[ability] || this.abilityFields[pyTitleWord(ability)] || ["", ""];
    if (weather) weatherSet.add(weather.toLowerCase());
    if (terrain) terrainSet.add(terrain.toLowerCase().replace(" terrain", ""));
    const stats = this.ev.statsFor(mon);
    // Singles: partner-only moves count for no group, and nothing is a spread move.
    const groupKeys = this.singles ? new Set([...moveKeys].filter((k) => !SINGLES_NO_EFFECT.has(k))) : moveKeys;
    return {
      entry,
      mon,
      name: this.showdownName(mon.form_name || mon.pokemon_name),
      pokemon: String(entry.pokemon || mon.pokemon_name || ""),
      item: String(entry.item || "").trim(),
      ability,
      types: this.ev.typesFor(mon),
      moves,
      move_keys: moveKeys,
      physical,
      special,
      damaging_count: physical.length + special.length,
      damaging_types: damagingTypes,
      protect: intersects(groupKeys, this.groups.protect),
      speed_control: intersects(groupKeys, this.groups.speed),
      priority: intersects(groupKeys, this.groups.priority),
      positioning: intersects(groupKeys, this.groups.positioning) || abilityKey === "intimidate",
      spread: !this.singles && intersects(groupKeys, this.groups.spread),
      utility: new Set(this.utilityGroups.filter(([, keys]) => intersects(groupKeys, keys)).map(([label]) => label)),
      speed: Number(stats.speed) || 0,
      stats,
      weather_set: weatherSet,
      weather_use: weatherUse,
      terrain_set: terrainSet,
    };
  }

  /**
   * Everything the two meta-relative checks need, from records the evaluation already
   * built (`pressureOverview` calls `metaPressureRecords(topX)` once per evaluation, so
   * the records cost nothing).  Mirrors `team_check_rules_v514.build_meta_context`.
   */
  metaContext() {
    const topX = Number(this.ev?.settings?.top_meta) || 30;
    if (this._metaCtx.has(topX)) return this._metaCtx.get(topX);
    let records = [];
    try {
      records = this.ev.metaPressureRecords(topX) || [];
    } catch {
      records = [];
    }
    let context = null;
    if (records.length) {
      const members = [];
      const counts = Object.fromEntries(TYPES.map((t) => [t, 0]));
      let total = 0;
      for (const record of records) {
        const types = (record.types || []).map((t) => pyTitleWord(String(t))).filter((t) => TYPES.includes(t));
        const recordMoves = (record.moves || []).slice(0, 4);
        members.push({
          name: String(record.name || record.form || record.pokemon || "Pokemon"),
          types,
          speed: Number(record.stats?.speed ?? record.speed) || 0,
          // Speed Tiers names an opposing Pokemon and says one Tailwind from it reorders
          // the cluster. It may only name one that HAS Tailwind.
          tailwind: recordMoves.some((m) => compact(m) === "tailwind"),
        });
        for (const move of recordMoves) {
          // D22 again, through the ONE shared definition: `attackOf` puts the meta's Knock
          // Off, Rock Tomb, Mystical Fire and the other seventeen back into the totals with
          // the same type and power the Companion reads, so the weights cannot drift.
          const attack = attackOf(move, this.ev.simpleMoveInfo(move));
          if (attack && counts[attack[0]] !== undefined) {
            counts[attack[0]] += 1;
            total += 1;
          }
        }
      }
      const average = total && TYPES.length ? total / TYPES.length : 0;
      // Smoothed and floored; see META_WEIGHT_SMOOTHING above.
      const weights = Object.fromEntries(TYPES.map((t) => [t, average > 0
        ? Math.max(META_WEIGHT_FLOOR, (counts[t] + META_WEIGHT_SMOOTHING) / (average + META_WEIGHT_SMOOTHING))
        : 1]));
      const speeds = members.map((m) => m.speed).filter((s) => s > 0).sort((a, b) => a - b);
      context = {
        top_x: topX,
        members,
        type_weights: weights,
        damaging_move_counts: counts,
        damaging_move_total: total,
        speed_band: speeds.length ? [quantile(speeds, SPEED_BAND_LOW_QUANTILE), quantile(speeds, SPEED_BAND_HIGH_QUANTILE)] : [0, 0],
        // The site's meta file is a finished build, not a cache that fills while the page
        // runs, so a website reading is never provisional. The app sets this from
        // `_v223_battle_cache_signature(panel)[3]`, whose Top X can still move mid-session.
        provisional: false,
      };
    }
    this._metaCtx.set(topX, context);
    return context;
  }

  profiles(team) {
    const rows = team.map(({ entry, mon }) => this.profile(entry, mon));
    if (!this.rules) return rows;
    // V514 (deviation D19): the meta context is stamped onto each profile because every
    // verdict function is fn(profiles) and `team_build_constraints` calls one of them
    // directly, so the signature cannot change. The recorded vector runners compare a
    // named field list, so the extra keys are invisible to them.
    const context = this.metaContext();
    for (const profile of rows) {
      profile._v514_meta = context;
      profile._v514_attack = Number(profile.stats?.attack) || 0;
      profile._v514_sp_attack = Number(profile.stats?.sp_attack) || 0;
      // V514 deviation D22: "this move attacks" is decided by `attackOf`, i.e. by power and,
      // for the nineteen attacks the app files as status because they also lower a stat, by
      // the shared COVERAGE_EXTRA_ATTACKS table. The table rather than "power > 0" is what
      // keeps the two products' attacking sets identical: the Companion's live move reader
      // returns power 0 for 14 of the nineteen (Rock Tomb, Mystical Fire, Spirit Break,
      // Struggle Bug, Electroweb, Acid Spray, Breaking Swipe, Lunge, Clear Smog, Low Sweep,
      // Nuzzle, Chilling Water, Skitter Smack, Mud Shot) while this site's app-data.json
      // keeps their real power. `damaging_types` / `physical` / `special` / `damaging_count`
      // are left alone, so no pre-V514 check and no recording moves -- only these two keys.
      let best = 0;
      const coverage = new Set(Array.from(profile.damaging_types || [], (t) => String(t)));
      for (const move of profile.moves || []) {
        const attack = attackOf(move, this.ev.simpleMoveInfo(move));
        if (attack) {
          best = Math.max(best, attack[1]);
          if (attack[0]) coverage.add(attack[0]);
        }
      }
      profile._v514_best_power = best;
      profile._v514_coverage_types = [...coverage].sort();
    }
    return rows;
  }

  // --- V201 rows -----------------------------------------------------------------

  requirementText(checkId, severity, summary, why, fix = "", threshold = "") {
    const label = this.labels[checkId] || pyTitleWord(String(checkId || "").replace(/_/g, " "));
    const sev = String(severity || "good").toLowerCase();
    const summaryText = sentence(summary);
    const parts = [summaryText ? `${label}: ${statusLabel(sev)}, ${summaryText}` : `${label}: ${statusLabel(sev)}`];
    if (sev !== "good") {
      const whyText = sentence(why);
      const fixText = sentence(fix);
      if (whyText) parts.push(whyText);
      if (fixText) parts.push(`Fix, ${fixText}`);
      const score = cleanScorePhrase(sev, threshold);
      if (score) parts.push(`Score, ${score}`);
    }
    return parts.filter((p) => String(p).trim()).map((p) => `${p.replace(/\.+$/, "")}.`).join(" ");
  }

  row(checkId, severity, summary, why, fix = "", pressure = 0, threshold = "", extra = {}) {
    let sev = String(severity || "good").toLowerCase();
    if (!["good", "yellow", "red"].includes(sev)) sev = "good";
    return {
      kind: checkId,
      check_id: checkId,
      check_label: this.labels[checkId] || checkId,
      severity: sev,
      text: this.requirementText(checkId, sev, summary, why, fix, threshold),
      pressure: sev === "good" ? 0 : Math.max(0, Number(pressure) || 0),
      check_system: "simple_custom_v187",
      ...extra,
      status_label: statusLabel(sev),
      score_explanation: cleanScorePhrase(sev, threshold),
      team_requirement_v201: true,
      summary_v203: sentence(summary),
      why_v203: sev === "good" ? "" : sentence(why),
      fix_v203: sev === "good" ? "" : sentence(fix),
      threshold_v203: cleanScorePhrase(sev, threshold),
    };
  }

  checkSpeedControl(profiles) {
    const direct = names(profiles, (p) => p.speed_control);
    const priority = names(profiles, (p) => p.priority);
    const fast = names(profiles, (p) => p.speed >= 110);
    const extra = { direct, priority, fast };
    if (direct.length) {
      return this.row("speed_control", "good", `direct Speed control is present on ${simpleJoin(direct, 5)}.`,
        "Move order is actively controllable instead of relying only on base Speed.", "", 0,
        "Good = at least one direct control move such as Tailwind, Trick Room, Icy Wind, Electroweb, Thunder Wave, or similar.", extra);
    }
    if (priority.length >= 2 || fast.length >= 2) {
      const pieces = [];
      if (priority.length) pieces.push(`priority on ${simpleJoin(priority, 4)}`);
      if (fast.length) pieces.push(`natural Speed on ${simpleJoin(fast, 4)}`);
      return this.row("speed_control", "yellow", `no direct Speed control; the team relies on ${simpleJoin(pieces, 2)}.`,
        "This can work, but opposing Tailwind, Trick Room, or speed drops can still take control of turns.",
        "Add one direct speed-control move, or make sure the team has a deliberate fast-offense plan.", 2.4,
        "Needs attention = no direct control, but at least two priority users or two naturally fast Pokémon.", extra);
    }
    return this.row("speed_control", "red", "the team has no reliable way to change or bypass move order.",
      this.singles ? "Most teams need some way to move first at key moments." : "Most doubles teams need some way to move first at key moments.",
      "Add Tailwind, Trick Room, Icy Wind, Electroweb, Thunder Wave, Fake Out plus priority, or another clear speed plan.", 5.5,
      "Problem = no direct control and fewer than two priority/fast backup options.", extra);
  }

  checkProtectPositioning(profiles) {
    const protect = names(profiles, (p) => p.protect);
    const positioning = names(profiles, (p) => p.positioning);
    const active = profiles.filter(Boolean).length;
    const extra = { protect, positioning };
    if (protect.length >= 3 || (protect.length >= 2 && positioning.length >= 2)) {
      return this.row("protect_positioning", "good", `${protect.length} Protect user(s) and ${positioning.length} positioning user(s) are available.`,
        this.singles ? "The team can scout turns, stall field effects, and bring in the right Pokémon safely." : "The team can scout turns, stall field effects, and protect vulnerable slots while partner Pokémon act.", "", 0,
        "Good = 3+ Protect users, or 2 Protect users plus 2+ positioning tools.", extra);
    }
    if (protect.length >= 1 || positioning.length >= 2 || active < 4) {
      return this.row("protect_positioning", "yellow", `only ${protect.length} Protect user(s) and ${positioning.length} positioning user(s) are visible.`,
        "The team has some safe-turn tools, but they may be concentrated on too few slots.",
        this.singles ? "Add another Protect-style move or a reliable positioning tool such as a pivoting move (U-turn, Volt Switch, Parting Shot), Fake Out, or Intimidate."
          : "Add another Protect-style move or a reliable positioning tool such as Fake Out, Follow Me/Rage Powder, pivoting, or Intimidate.", 2.5,
        "Needs attention = at least one Protect or two positioning tools, but below the good threshold.", extra);
    }
    return this.row("protect_positioning", "red", this.singles ? "there is almost no way to scout a turn or switch safely." : "there is almost no way to protect a slot or reposition safely.",
      "Without these tools, reads become all-or-nothing and setup/support turns are hard to create.",
      this.singles ? "Add Protect to key attackers and at least one switching tool such as a pivoting move, Fake Out, or Intimidate."
        : "Add Protect to key attackers and at least one board-control tool such as Fake Out, redirection, pivoting, or Intimidate.", 5.4,
      "Problem = no Protect and fewer than two positioning tools.", extra);
  }

  checkSpreadDamage(profiles) {
    const spread = names(profiles, (p) => p.spread);
    const active = profiles.filter(Boolean).length;
    const extra = { spread };
    if (spread.length >= 2 || (active <= 3 && spread.length >= 1)) {
      return this.row("spread_damage", "good", `spread pressure is available on ${simpleJoin(spread, 4)}.`,
        "Spread moves punish both opposing slots and stop the team from needing perfect single-target reads every turn.", "", 0,
        "Good = 2+ spread users on a full team, or at least one while the team is still incomplete.", extra);
    }
    if (spread.length === 1) {
      return this.row("spread_damage", "yellow", `only ${simpleJoin(spread, 1)} currently pressures both opposing slots.`,
        "One spread option is useful but can be denied by typing, positioning, or losing that Pokémon early.",
        "Add a second spread attack if the team wants consistent board pressure.", 2.0,
        "Needs attention = exactly one spread user on a mostly complete team.", extra);
    }
    return this.row("spread_damage", "red", "no common spread attack is selected.",
      "The team may struggle to punish two threats at once or clean low-health boards efficiently.",
      "Add a spread move such as Heat Wave, Rock Slide, Dazzling Gleam, Earthquake, Hyper Voice, Blizzard, or similar if it fits the Pokémon.", 4.4,
      "Problem = zero detected spread-damage users.", extra);
  }

  checkPriorityCleanup(profiles) {
    const priority = names(profiles, (p) => p.priority);
    const fast = names(profiles, (p) => p.speed >= 120 && p.damaging_count > 0);
    const extra = { priority, fast };
    if (priority.length >= 2) {
      return this.row("priority_cleanup", "good", `priority cleanup is available on ${simpleJoin(priority, 4)}.`,
        "Priority lets the team finish weakened targets even when speed control is unfavorable.", "", 0,
        "Good = 2+ priority users.", extra);
    }
    if (priority.length === 1 || fast.length >= 2) {
      const summary = priority.length ? `priority is limited to ${simpleJoin(priority, 2)}.` : `cleanup relies on fast attackers: ${simpleJoin(fast, 3)}.`;
      return this.row("priority_cleanup", "yellow", summary,
        "The team has a way to clean, but losing one slot or facing opposing speed control may remove it.",
        "Add another priority move or a second dedicated fast cleaner.", 2.1,
        "Needs attention = one priority user, or no priority but at least two very fast damaging attackers.", extra);
    }
    return this.row("priority_cleanup", "red", "no priority or clear cleanup plan is visible.",
      "Low-health opposing Pokémon may still move first if they win the Speed-control exchange.",
      "Add priority, Fake Out support, or a fast cleaner that reliably threatens weakened targets.", 4.6,
      "Problem = no priority and fewer than two very fast damaging attackers.", extra);
  }

  checkPhysicalDamage(profiles) {
    const physical = names(profiles, (p) => p.physical.length);
    const extra = { physical };
    if (physical.length >= 2) {
      return this.row("physical_damage", "good", `physical pressure is available on ${simpleJoin(physical, 5)}.`,
        "The team can punish specially bulky targets and does not rely only on special attacks.", "", 0,
        "Good = 2+ physical attackers.", extra);
    }
    if (physical.length === 1) {
      return this.row("physical_damage", "yellow", `only ${simpleJoin(physical, 1)} provides physical damage.`,
        "One physical attacker can be enough, but the team becomes easier to wall or intimidate around.",
        "Add a second physical attacker or make sure this slot is protected and reliable.", 2.2,
        "Needs attention = exactly one physical attacker.", extra);
    }
    return this.row("physical_damage", "red", "no physical damage source is selected.",
      "Purely special teams can struggle into special walls, Assault Vest users, or special-defense boosts.",
      "Add at least one reliable physical attacker, preferably two on a full team.", 5.0,
      "Problem = zero detected physical attackers.", extra);
  }

  checkSpecialDamage(profiles) {
    const special = names(profiles, (p) => p.special.length);
    const extra = { special };
    if (special.length >= 2) {
      return this.row("special_damage", "good", `special pressure is available on ${simpleJoin(special, 5)}.`,
        "The team can punish physically bulky targets and does not rely only on contact/physical attacks.", "", 0,
        "Good = 2+ special attackers.", extra);
    }
    if (special.length === 1) {
      return this.row("special_damage", "yellow", `only ${simpleJoin(special, 1)} provides special damage.`,
        "One special attacker can work, but the team becomes easier to wall with physical bulk or Intimidate cycling.",
        "Add a second special attacker or make sure this slot covers the team’s key defensive matchups.", 2.2,
        "Needs attention = exactly one special attacker.", extra);
    }
    return this.row("special_damage", "red", "no special damage source is selected.",
      "Purely physical teams can struggle into Intimidate, burns, Defense boosts, or physically bulky Pokémon.",
      "Add at least one reliable special attacker, preferably two on a full team.", 5.0,
      "Problem = zero detected special attackers.", extra);
  }

  checkUtilityDisruption(profiles) {
    const categories = [...new Set(profiles.flatMap((p) => [...p.utility]))].sort();
    const providers = names(profiles, (p) => p.utility.size);
    const extra = { categories, providers };
    if (categories.length >= 3 && providers.length >= 2) {
      return this.row("utility_disruption", "good", `${simpleJoin(categories, 7)} are covered across ${providers.length} Pokémon.`,
        "The team has multiple ways to interrupt the opponent beyond raw damage.", "", 0,
        "Good = 3+ utility categories across 2+ providers.", extra);
    }
    if (categories.length >= 2 || providers.length >= 2) {
      return this.row("utility_disruption", "yellow", `utility is limited to ${simpleJoin(categories, 7) || "a small number of tools"} across ${providers.length} Pokémon.`,
        "The team has support options, but may not be able to disrupt varied opposing plans.",
        this.singles ? "Add another utility category such as Taunt, Haze, Encore, status, healing, screens, or pivoting."
          : "Add another utility category such as Fake Out, redirection, Taunt, Haze, Encore, status, healing, or screens.", 2.4,
        "Needs attention = 2 categories or 2 providers, but not both enough for good.", extra);
    }
    return this.row("utility_disruption", "red", "very little utility or disruption is selected.",
      this.singles ? "Teams that only attack often struggle when the opponent sets up or controls the game first."
        : "Teams that only attack often struggle when the opponent sets up, redirects, or controls the board first.",
      this.singles ? "Add useful tools such as Taunt, Haze, Encore, status, healing, screens, or pivoting."
        : "Add useful doubles tools such as Fake Out, redirection, Taunt, Haze, Encore, status, healing, screens, or pivoting.", 5.2,
      "Problem = fewer than 2 utility categories and fewer than 2 utility providers.", extra);
  }

  /** _v201_defensive_counts */
  defensiveCounts(profiles) {
    const weak = {};
    const resist = {};
    const immune = {};
    for (const attacking of TYPES) {
      let w = 0;
      let r = 0;
      let i = 0;
      for (const profile of profiles) {
        if (!profile.types.length) continue;
        const mult = this.ev.engine.typeMultiplier(attacking, profile.types);
        if (mult === 0) {
          i += 1;
          r += 1;
        } else if (mult < 1) r += 1;
        else if (mult > 1) w += 1;
      }
      weak[attacking] = w;
      resist[attacking] = r;
      immune[attacking] = i;
    }
    return [weak, resist, immune];
  }

  /** The meta context off the first profile that carries one (`context_of`). */
  contextOf(profiles) {
    for (const profile of profiles || []) if (profile && profile._v514_meta) return profile._v514_meta;
    return null;
  }

  /** The meta weight per attacking type; 1.0 everywhere when there is no context. */
  metaWeights(context) {
    if (context && context.type_weights) return Object.fromEntries(TYPES.map((t) => [t, Number(context.type_weights[t] ?? 1) || 0]));
    return Object.fromEntries(TYPES.map((t) => [t, 1]));
  }

  /** V514 coverage_gaps: how thin the team's super-effective coverage is over the Top X. */
  checkCoverageGaps(profiles) {
    const filled = (profiles || []).filter(Boolean);
    const context = this.contextOf(filled);
    const topX = Number(context?.top_x) || 30;
    const members = (context?.members || []).filter((m) => m.types.length);
    const seen = new Set();
    // D22: the attacks the team really has. `_v514_coverage_types` is stamped by
    // profiles() and is a superset of `damaging_types`; the fallback keeps a
    // hand-built profile working.
    for (const profile of filled) {
      const source = profile._v514_coverage_types?.length ? profile._v514_coverage_types : (profile.damaging_types || []);
      for (const t of source) if (TYPES.includes(String(t))) seen.add(String(t));
    }
    const attacking = TYPES.filter((t) => seen.has(t));

    const gaps = [];
    for (const member of members) {
      let best = 0;
      for (const type of attacking) best = Math.max(best, Number(this.ev.engine.typeMultiplier(type, member.types)));
      if (best < 2) gaps.push({ name: member.name, types: [...member.types], best_multiplier: best });
    }
    gaps.sort((a, b) => a.best_multiplier - b.best_multiplier || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const resisted = gaps.filter((g) => g.best_multiplier < 1);
    const redBar = Math.max(COVERAGE_RED_FLOOR, halfUp(COVERAGE_RED_FRACTION * topX));
    const yellowBar = Math.max(COVERAGE_YELLOW_FLOOR, halfUp(COVERAGE_YELLOW_FRACTION * topX));

    let fixes = [];
    for (const type of TYPES) {
      const covers = gaps.filter((g) => Number(this.ev.engine.typeMultiplier(type, g.types)) >= 2).length;
      if (covers) fixes.push({ type, covers });
    }
    fixes = stableSort(fixes, (f) => [-f.covers, TYPES.indexOf(f.type)]).slice(0, 3);

    const extra = {
      coverage_rows_v514: gaps.slice(0, 6),
      best_added_types_v514: fixes,
      coverage_gap_count_v514: gaps.length,
      coverage_resisted_count_v514: resisted.length,
      coverage_top_x_v514: topX,
      coverage_attacking_types_v514: attacking,
      coverage_bars_v514: { yellow: yellowBar, red: redBar },
      meta_provisional_v514: metaProvisional(context),
    };
    const fix = fixes.length
      ? (fixes.length > 1 && fixes[1].covers === fixes[0].covers
        ? `a ${fixes[0].type} or ${fixes[1].type} attack would cover ${fixes[0].covers} of them`
        : `a ${fixes[0].type} attack would cover ${fixes[0].covers} of them`)
      : "replace one attack with a type that hits them, or add a member that does";
    // The names go in the text, not only in the payload: a bare count is not actionable.
    const named = simpleJoin(gaps.map((g) => g.name), 4);
    const why = withNote(`${gaps.length ? `The team can only hit ${named} for neutral damage. ` : ""}`
      + "Without a super-effective answer it has to break them with neutral damage, which usually costs a turn it does not have.", context);

    if (resisted.length || gaps.length >= redBar) {
      const summary = resisted.length
        ? `${resisted.length} of the Top ${topX} resist every attack the team carries, and ${gaps.length} in total have no super-effective answer`
        : `${gaps.length} of the Top ${topX} have no super-effective answer on this team`;
      return this.row("coverage_gaps", "red", summary, why, fix, 5.6,
        `Problem = at least one of the Top ${topX} the team only resists, or ${redBar} or more with no super-effective answer.`, extra);
    }
    if (gaps.length >= yellowBar) {
      return this.row("coverage_gaps", "yellow", `${gaps.length} of the Top ${topX} have no super-effective answer on this team`,
        why, fix, 2.5, `Needs attention = ${yellowBar} or more of the Top ${topX} with no super-effective answer.`, extra);
    }
    // The green branch names the gap members too: they are the most actionable thing the row
    // knows, and withholding them exactly when the verdict is good left coverage_rows_v514
    // payload-only with no way for a player to read it.
    if (!members.length) {
      return this.row("coverage_gaps", "good",
        "the Top Meta is not loaded yet, so coverage cannot be measured",
        "Nothing has been measured here: sync the Top Meta, or pick a format that has one.", "", 0,
        "Not measured = there is no Top Meta to compare the team's attacks against.", extra);
    }
    const summary = gaps.length
      ? `only ${gaps.length} of the Top ${topX} ${gaps.length === 1 ? "lacks" : "lack"} a super-effective answer (${named}), which is a normal amount to live with`
      : `every one of the Top ${topX} has a super-effective answer somewhere on the team`;
    return this.row("coverage_gaps", "good", summary,
      withNote("The team can bring super-effective damage to almost everything it will meet."
        + (gaps.length ? ` The ${gaps.length < NUMBER_WORDS.length ? countWord(gaps.length) : gaps.length} it cannot ${gaps.length === 1 ? "is" : "are"} listed so you can decide whether to live with them.` : ""), context),
      "", 0,
      `Good = fewer than ${yellowBar} of the Top ${topX} without a super-effective answer.`, extra);
  }

  /** V514 speed_tiers: too many members in one Speed band, after two gates. */
  checkSpeedTiers(profiles) {
    const filled = (profiles || []).filter(Boolean);
    const context = this.contextOf(filled);
    const topX = Number(context?.top_x) || 30;
    const [lowEdge, highEdge] = context?.speed_band || [0, 0];

    // GATE 1. 39.3% of real teams set Trick Room; under it a tight band is the plan.
    if (filled.some((p) => p.move_keys.has("trickroom"))) {
      return this.row("speed_tiers", "good",
        "Trick Room sets the order, so sitting close together on Speed does not decide your turns",
        "The team inverts the turn order on purpose, which is exactly what a tight Speed band is for.", "", 0,
        "Good = the team sets Trick Room, so a shared Speed tier is deliberate.",
        { speed_gate_v514: "trick_room", speed_cluster_v514: {}, speed_flip_v514: {}, speed_band_v514: [lowEdge, highEdge], meta_provisional_v514: metaProvisional(context) });
    }

    // GATE 0. Both remaining gates are relative to the Speed range the Top X contests, and
    // without a Top X there is no range: the band is (0, 0), every cluster is rejected and the
    // row used to answer "the team's Speeds are spread out enough that one Tailwind cannot
    // reorder all of it at once" -- a positive conclusion from a measurement that never ran.
    if (!metaLoaded(context)) {
      return this.row("speed_tiers", "good",
        "the Top Meta is not loaded yet, so the contested Speed range cannot be measured",
        "Nothing has been measured here: this check compares the team's Speeds against the range the Top Meta contests, and there is no Top Meta to compare them with.",
        "", 0, "Not measured = there is no Top Meta, so there is no contested Speed range.",
        { speed_gate_v514: "no_meta", speed_cluster_v514: {}, speed_flip_v514: {}, speed_band_v514: [lowEdge, highEdge], meta_provisional_v514: metaProvisional(context) });
    }

    const entries = stableSort(filled.map((p) => [Number(p.speed) || 0, String(p.name || "Pokemon")]), (e) => [e[0], e[1]]);
    const bestCluster = (width, gated = true) => {
      let best = null;
      for (let start = 0; start < entries.length; start += 1) {
        let stop = start;
        while (stop < entries.length && entries[stop][0] - entries[start][0] <= width) stop += 1;
        const size = stop - start;
        if (size <= 1) continue;
        const low = entries[start][0];
        const high = entries[stop - 1][0];
        // GATE 2. A block slower than the whole field is not in a Speed race.
        if (gated && !(high >= lowEdge && low <= highEdge)) continue;
        if (!best || size > best.size) best = { size, low, high, width: high - low, members: entries.slice(start, stop).map((e) => e[1]) };
      }
      return best;
    };
    const tight = bestCluster(SPEED_TIGHT_BAND);
    const wide = bestCluster(SPEED_WIDE_BAND);
    const tightSize = tight?.size || 0;
    const wideSize = wide?.size || 0;
    const red = tightSize >= SPEED_TIGHT_RED || wideSize >= SPEED_WIDE_RED;
    const yellow = wideSize >= SPEED_WIDE_YELLOW;
    const cluster = tightSize >= SPEED_TIGHT_RED && tightSize >= wideSize ? tight : wide;

    // The Top X members an opposing Tailwind moves past the whole cluster at once: not faster
    // than all of it now, faster than all of it doubled -- and CARRYING TAILWIND. Without that
    // last test the row named a Pokemon and credited it with a move it does not have ("One
    // Tailwind from Milotic (Speed 101)", whose set is Protect / Scald / Ice Beam / Icy Wind).
    // If no Tailwind user in the Top X can make the flip, nobody is named.
    let flip = {};
    let flipCount = 0;
    if (cluster) {
      const ceiling = Number(cluster.high);
      for (const member of context?.members || []) {
        if (!member.tailwind) continue;
        const speed = Number(member.speed) || 0;
        if (speed <= 0 || speed > ceiling || speed * 2 <= ceiling) continue;
        flipCount += 1;
        if (!flip.name || speed > Number(flip.speed)) flip = { name: String(member.name || "Pokemon"), speed };
      }
    }
    if (flip.name) flip.count = flipCount;

    const extra = {
      speed_gate_v514: "",
      speed_cluster_v514: cluster
        ? { members: [...cluster.members], low: cluster.low, high: cluster.high, width: cluster.width, band: [lowEdge, highEdge] }
        : {},
      speed_flip_v514: flip,
      speed_band_v514: [lowEdge, highEdge],
      meta_provisional_v514: metaProvisional(context),
    };
    if (red || yellow) {
      const word = countWord(cluster.size);
      const summary = `${word} of your ${countWord(filled.length)} sit between ${speedText(cluster.low)} and ${speedText(cluster.high)}`;
      const named = simpleJoin([...cluster.members], 6);
      const why = withNote(flip.name
        ? `${named}. One Tailwind from ${flip.name} (Speed ${speedText(flip.speed)}) moves it past all ${word} in the same turn.`
        : `${named}. One Tailwind or Icy Wind changes the order for all ${word} at once.`, context);
      const fix = "move one attacker clearly above or below the group, or carry your own Tailwind or Trick Room";
      if (red) {
        return this.row("speed_tiers", "red", summary, why, fix, 4.0,
          `Problem = ${SPEED_TIGHT_RED} or more members inside ${SPEED_TIGHT_BAND} Speed points, or ${SPEED_WIDE_RED} or more inside ${SPEED_WIDE_BAND}, in the range the Top ${topX} contests.`, extra);
      }
      return this.row("speed_tiers", "yellow", summary, why, fix, 1.8,
        `Needs attention = ${SPEED_WIDE_YELLOW} or more members inside ${SPEED_WIDE_BAND} Speed points, in the range the Top ${topX} contests.`, extra);
    }
    // GATE 2 said its own sentence. A block of six at Speed 30-35 under a contested band of
    // (70, 167) is excused correctly, but telling that team its Speeds are "spread out enough"
    // is false -- they are not spread out, they are simply not in the race.
    const outside = bestCluster(SPEED_WIDE_BAND, false);
    if ((outside?.size || 0) >= SPEED_WIDE_YELLOW) {
      const word = countWord(outside.size);
      return this.row("speed_tiers", "good",
        `${word} of your ${countWord(filled.length)} sit between ${speedText(outside.low)} and ${speedText(outside.high)}, which is outside the Speed range the Top ${topX} contests`,
        withNote(`${simpleJoin([...outside.members], 6)}. They share a Speed tier, but the Top ${topX} contests ${speedText(lowEdge)} to ${speedText(highEdge)}, so a Tailwind aimed at that range does not decide their turns.`, context),
        "", 0,
        `Good = the shared Speed tier sits outside ${speedText(lowEdge)} to ${speedText(highEdge)}, the range the Top ${topX} contests.`,
        { ...extra,
          speed_gate_v514: "outside_band",
          speed_cluster_v514: { members: [...outside.members], low: outside.low, high: outside.high, width: outside.width, band: [lowEdge, highEdge] } });
    }
    return this.row("speed_tiers", "good",
      "the team's Speeds are spread out enough that one Tailwind cannot reorder all of it at once",
      withNote("No large group of the team shares a Speed tier inside the range the meta contests.", context), "", 0,
      `Good = no group of ${SPEED_WIDE_YELLOW} sits inside ${SPEED_WIDE_BAND} Speed points in the range the Top ${topX} contests.`, extra);
  }

  /** V514 lead_viability: an explicit estimate from each pair's turn-one tools. */
  leadScore(profile) {
    const keys = profile.move_keys;
    const ability = compact(profile.ability || "");
    const hits = (group) => intersects(keys, group);
    let score = 0;
    if (hits(this.groups.fakeOut)) score += 3;
    if (keys.has("tailwind")) score += 3;
    if (keys.has("trickroom")) score += 3;
    if (ability === "intimidate") score += 2;
    if (hits(this.archetypeSets.redirection)) score += 1.5;
    if (hits(this.groups.speed)) score += 1.5;
    if (keys.has("firstimpression")) score += 1.5;
    if (hits(this.groups.priority)) score += 1;
    if (hits(this.groups.spread)) score += 1;
    if (keys.has("helpinghand")) score += 1;
    if (keys.has("wideguard")) score += 1;
    if (keys.has("taunt")) score += 1;
    if (hits(this.groups.protect)) score += 0.5;
    return score + Math.max(Number(profile._v514_attack) || 0, Number(profile._v514_sp_attack) || 0) / 150;
  }

  leadPairScore(a, b) {
    let score = this.leadScore(a) + this.leadScore(b);
    if (intersects(a.move_keys, this.groups.fakeOut) && intersects(b.move_keys, this.groups.fakeOut)) score -= 3;
    if ((a.move_keys.has("trickroom") && b.move_keys.has("trickroom")) || (a.move_keys.has("tailwind") && b.move_keys.has("tailwind"))) score -= 3;
    if (![a, b].some((p) => (Number(p._v514_best_power) || 0) >= 60)) score -= 3;
    return score;
  }

  checkLeadViability(profiles) {
    const filled = (profiles || []).filter(Boolean);
    let pairs = [];
    for (let i = 0; i < filled.length; i += 1) {
      for (let j = i + 1; j < filled.length; j += 1) {
        const score = this.leadPairScore(filled[i], filled[j]);
        pairs.push({ members: [String(filled[i].name), String(filled[j].name)], score, playable: score >= LEAD_BAR });
      }
    }
    pairs = stableSort(pairs, (p) => [-p.score, p.members[0], p.members[1]]);
    const total = pairs.length;
    const playable = pairs.filter((p) => p.playable).length;
    const redBar = halfUp(LEAD_RED_FRACTION * total);
    const yellowBar = halfUp(LEAD_YELLOW_FRACTION * total);
    const extra = {
      lead_pairs_v514: pairs,
      lead_playable_v514: playable,
      lead_pair_count_v514: total,
      lead_bar_v514: LEAD_BAR,
      lead_severity_bars_v514: { yellow: yellowBar, red: redBar },
    };
    const honest = "This is an estimate from each pair's turn-one tools, not a played-out game.";
    if (total === 0) {
      return this.row("lead_viability", "good", "there is no lead pair to judge yet", "", "", 0,
        "Good = not enough Pokemon to form a lead pair.", extra);
    }
    if (total === 1) {
      // Two Pokemon: the one pair IS the lead, and it was scored. The row used to say "there is
      // no lead pair to judge yet" while its own payload reported lead_pair_count_v514 = 1 --
      // the one case where the player knows their lead exactly. The fraction bars are
      // meaningless at n = 1 (halfUp(0.55 * 1) = 1, so a playable pair would have read yellow).
      const only = pairs[0];
      const names = `${only.members[0]} with ${only.members[1]}`;
      if (only.playable) {
        return this.row("lead_viability", "good",
          `your one lead pair, ${names}, has a turn-one tool to open with`, honest, "", 0,
          `Good = the only lead pair reaches the playable bar of ${LEAD_BAR}.`, extra);
      }
      return this.row("lead_viability", "yellow",
        `your only lead pair, ${names}, has little more than raw damage between it`,
        `With two Pokemon there is no other opening to fall back on. ${honest}`,
        "give one of the two a turn-one tool, or add a third Pokemon so there is a choice", 2.0,
        `Needs attention = the only lead pair misses the playable bar of ${LEAD_BAR}.`, extra);
    }
    if (playable <= redBar || playable <= yellowBar) {
      const pieces = pairs.slice(0, 2).map((p) => `${p.members[0]} with ${p.members[1]}`);
      const weak = pairs.filter((p) => !p.playable);
      let why = `Your best openings are ${simpleJoin(pieces, 2)}.`;
      if (weak.length) {
        why += ` ${weak.length < NUMBER_WORDS.length ? countWord(weak.length) : weak.length} pair${weak.length !== 1 ? "s" : ""} have little more than raw damage between them.`;
      }
      why += ` ${honest}`;
      const fix = "give another Pokemon a turn-one tool so more pairs can open";
      const summary = `an estimated ${playable} of your ${total} lead pairs are worth bringing`;
      if (playable <= redBar) {
        return this.row("lead_viability", "red", summary, why, fix, 4.4,
          `Problem = ${redBar} or fewer of the ${total} lead pairs reach the playable bar.`, extra);
      }
      return this.row("lead_viability", "yellow", summary, why, fix, 2.0,
        `Needs attention = ${yellowBar} or fewer of the ${total} lead pairs reach the playable bar.`, extra);
    }
    return this.row("lead_viability", "good",
      `an estimated ${playable} of your ${total} lead pairs are worth bringing, judged from each pair's turn-one tools rather than a played-out game`,
      "Most openings have a turn-one tool, so the lead choice stays a real choice.", "", 0,
      `Good = more than ${yellowBar} of the ${total} lead pairs reach the playable bar.`, extra);
  }

  /** V514 Shared Weakness: the same id, weighted by how often the meta attacks with it. */
  checkSharedWeakness(profiles) {
    const filled = (profiles || []).filter(Boolean);
    const context = this.contextOf(filled);
    const topX = Number(context?.top_x) || 30;
    const weights = this.metaWeights(context);
    const [weakCounts, resistCounts, immuneCounts] = this.defensiveCounts(filled);
    let typeRows = [];
    let gated = [];
    for (const type of TYPES) {
      const weak = weakCounts[type] || 0;
      const switchIns = resistCounts[type] || 0;
      const weight = Number(weights[type] ?? 1);
      const exposure = Math.max(0, weak - SHARED_RESIST_DISCOUNT * switchIns) * weight;
      if (weak < SHARED_WEAK_GATE) continue;
      const severity = exposure >= SHARED_RED_EXPOSURE ? "red" : exposure >= SHARED_YELLOW_EXPOSURE ? "yellow" : "";
      if (!severity) {
        // The user's literal condition held and the weighting excused it. Recorded rather than
        // dropped, so "three of my six lose to Ground and the row is green" has an answer.
        gated.push({ type, weak, switch_ins: switchIns, immunities: immuneCounts[type] || 0, meta_weight: weight, exposure });
        continue;
      }
      typeRows.push({ type, weak, switch_ins: switchIns, immunities: immuneCounts[type] || 0, severity, meta_weight: weight, exposure });
    }
    typeRows = stableSort(typeRows, (r) => [r.severity === "red" ? 0 : 1, -r.exposure, -r.weak, r.switch_ins, r.type]);
    gated = stableSort(gated, (r) => [-r.exposure, -r.weak, r.type]);
    const severe = typeRows.filter((r) => r.severity === "red");
    const exposed = typeRows.filter((r) => r.severity === "yellow");
    const loaded = metaLoaded(context);
    const extra = {
      weak_counts: weakCounts, resist_counts: resistCounts, immune_counts: immuneCounts,
      severe, exposed, type_rows_v251: typeRows, gated_types_v514: gated,
      meta_type_weights_v514: Object.fromEntries(TYPES.map((t) => [t, Number(weights[t] ?? 1)])),
      meta_weighted_v514: loaded,
      meta_provisional_v514: metaProvisional(context),
    };
    if (typeRows.length) {
      const worst = typeRows[0];
      const others = typeRows.slice(1).map((r) => r.type);
      let summary = `${countWord(worst.weak)} of your ${countWord(filled.length)} lose to ${worst.type}`;
      // The rate clause is only said when it says something: "1.00 times the average rate" is
      // two decimals of resolution a 72-move sample does not have and, at exactly average, no
      // information at all; and without a Top X every weight is the 1.0 placeholder, so the
      // clause would be a claim about a meta this row never looked at.
      const rate = Math.round(Number(worst.meta_weight) * 10) / 10;
      if (loaded && rate !== 1) summary += `, a type the Top ${topX} attacks with ${rate.toFixed(1)} times the average rate`;
      if (others.length) summary += `, and the same is true of ${simpleJoin(others, 3)}`;
      const why = withNote("One Pokemon with that attacking type can threaten most of the team in a single turn, which is the classic reason a team folds to one opponent."
        + (loaded ? "" : " The Top Meta is not loaded, so this is the unweighted reading: every attacking type was treated as equally common."), context);
      const fix = `add a ${worst.type} resist or immunity, or replace one of the ${worst.weak} that share the weakness`;
      if (severe.length) {
        return this.row("defensive_switch_ins", "red", summary, why, fix, 5.8,
          `Problem = ${SHARED_WEAK_GATE} or more members weak to one type, and that type's meta-weighted exposure reaches ${SHARED_RED_EXPOSURE.toFixed(1)}.`, extra);
      }
      return this.row("defensive_switch_ins", "yellow", summary, why, fix, 2.6,
        `Needs attention = ${SHARED_WEAK_GATE} or more members weak to one type, and that type's meta-weighted exposure reaches ${SHARED_YELLOW_EXPOSURE.toFixed(1)}.`, extra);
    }
    // The green text may only claim what was measured. Without a Top X the weights are all the
    // 1.0 placeholder, so "the types the Top Meta rarely attacks with" would be a statement
    // about a meta this row never read.
    if (!loaded) {
      return this.row("defensive_switch_ins", "good",
        "no attacking type hits enough of the team to matter, counting every type as equally common",
        "The Top Meta is not loaded, so this is the unweighted reading: nothing was measured about how often the meta actually attacks with these types.",
        "", 0,
        `Good, unweighted = no attacking type reaches the exposure bar with ${SHARED_WEAK_GATE} or more members weak to it.`, extra);
    }
    return this.row("defensive_switch_ins", "good",
      "no attacking type the meta actually uses hits enough of the team to matter",
      withNote("The weaknesses the team does share belong to types the Top Meta rarely attacks with."
        + (gated.length ? ` ${simpleJoin(gated.map((r) => r.type), 3)} ${gated.length === 1 ? "is" : "are"} shared by ${gated.length === 1 ? countWord(gated[0].weak) : "several"} of the team but excused by how rarely the meta brings them.` : ""), context),
      "", 0,
      `Good = no attacking type reaches the weighted exposure bar with ${SHARED_WEAK_GATE} or more members weak to it.`, extra);
  }

  /** _v251_check_defensive_switch_ins */
  checkDefensiveSwitchIns(profiles) {
    if (this.rules) return this.checkSharedWeakness(profiles);
    const [weakCounts, resistCounts, immuneCounts] = this.defensiveCounts(profiles);
    let typeRows = [];
    for (const type of TYPES) {
      const weak = weakCounts[type] || 0;
      const switchIns = resistCounts[type] || 0;
      const severity = weak >= 4 || (weak >= 3 && switchIns === 0) ? "red" : weak >= 3 || (weak >= 2 && switchIns === 0) ? "yellow" : "";
      if (severity) typeRows.push({ type, weak, switch_ins: switchIns, immunities: immuneCounts[type] || 0, severity });
    }
    typeRows = stableSort(typeRows, (r) => [r.severity === "red" ? 0 : 1, -r.weak, r.switch_ins, r.type]);
    const severe = typeRows.filter((r) => r.severity === "red");
    const exposed = typeRows.filter((r) => r.severity === "yellow");
    const plural = typeRows.length !== 1 ? "s" : "";
    const extra = { weak_counts: weakCounts, resist_counts: resistCounts, immune_counts: immuneCounts, severe, exposed, type_rows_v251: typeRows };
    if (severe.length) {
      return this.row("defensive_switch_ins", "red", `${typeRows.length} attacking type${plural} need defensive attention. See the separate type rows below.`,
        "A switch in is a teammate that resists or is immune to that attacking type.",
        "Add a resist or immunity for the listed types, or remove one Pokemon that stacks the weakness.", 5.8,
        "Problem = 4+ weaknesses to a type, or 3+ weaknesses with no switch in.", extra);
    }
    if (exposed.length) {
      return this.row("defensive_switch_ins", "yellow", `${typeRows.length} attacking type${plural} have shallow switch-in coverage. See the separate type rows below.`,
        "Repeated attacks of these types can force awkward turns because too few teammates enter safely.",
        "Add another resist or immunity, or make sure speed and board control stop these attacks from landing freely.", 2.6,
        "Needs attention = 3 shared weaknesses, or 2+ weaknesses with no switch in.", extra);
    }
    return this.row("defensive_switch_ins", "good", "No attacking type creates an obvious shared-weakness gap.",
      "The team has reasonable resistance or immunity pivots for its current typings.", "", 0,
      "Good = no type reaches the yellow or red switch-in threshold.", { ...extra, severe: [], exposed: [], type_rows_v251: [] });
  }

  checkFieldWeatherConsistency(profiles) {
    const union = (field) => new Set(profiles.flatMap((p) => [...p[field]]));
    const weatherSet = union("weather_set");
    const weatherUse = union("weather_use");
    const terrainSet = union("terrain_set");
    const moveKeys = union("move_keys");
    const priority = names(profiles, (p) => p.priority);
    // (text, weight) while the rule is on: HARD = the dependency does not work, SOFT = a
    // conflict the team chose and can play around. See FIELD_HARD_WEIGHT.
    const weighted = [];
    const add = (text, weight) => weighted.push([text, weight]);
    const unsupported = [...weatherUse].filter((w) => !weatherSet.has(w)).sort();
    if (unsupported.length) add(`missing setter for ${simpleJoin(unsupported.map(pyTitleWord), 4)}`, FIELD_HARD_WEIGHT);
    const ownerOf = (field, condition) => {
      const found = (profiles || []).find((p) => p && p[field].has(condition));
      return found ? String(found.name || "One Pokemon") : "One Pokemon";
    };
    /** One sentence for two weathers or two terrains, in one voice. The pre-V514 weather line
     *  hedged ("multiple weather setters may fight each other") while the added terrain line
     *  was definite and named its owners; two setters of the same kind DO replace each other,
     *  so with the rule on both say so and both name who brought them. */
    const twoSetters = (kind, set, field) => {
      if (set.size < 2) return;
      const ordered = [...set].sort();
      const suffix = kind ? ` ${kind}` : "";
      let text = `${ownerOf(field, ordered[0])}'s ${pyTitleWord(ordered[0])}${suffix} and ${ownerOf(field, ordered[1])}'s ${pyTitleWord(ordered[1])}${suffix} replace each other`;
      if (set.size > 2) text += ` (+${set.size - 2} more${suffix || " setter"})`;
      add(text, FIELD_SOFT_WEIGHT);
    };
    if (weatherSet.size >= 2) {
      if (this.rules) twoSetters("", weatherSet, "weather_set");
      else add("multiple weather setters may fight each other", FIELD_SOFT_WEIGHT);
    }
    // V514 NEW RULE A: two terrain setters. The half of "two setters fighting each other"
    // that did not exist -- only weather was checked. 2.6% of real teams.
    if (this.rules) twoSetters("Terrain", terrainSet, "terrain_set");
    if (terrainSet.has("psychic") && priority.length) add("Psychic Terrain can block the team's priority attacks", FIELD_SOFT_WEIGHT);
    if (terrainSet.has("grassy") && ["earthquake", "bulldoze", "magnitude"].some((k) => moveKeys.has(k))) add(this.singles ? "Grassy Terrain weakens the team's Earthquake-style Ground attacks" : "Grassy Terrain weakens the team's Ground spread attacks", FIELD_SOFT_WEIGHT);
    // V514 NEW RULE B: a move whose condition the team cannot set, derived from THESE
    // profiles (never from the builder's global team).  NEW RULE C: Hail counts as snow.
    const available = new Set([...weatherSet, ...terrainSet]);
    const hasHail = EXTRA_SNOW_SETTERS.some((k) => moveKeys.has(k));
    if (hasHail) available.add("snow");
    if (weatherSet.size || hasHail) available.add("weather");
    if (terrainSet.size) available.add("terrain");
    if (this.rules) {
      for (const profile of profiles || []) {
        for (const move of profile.moves || []) {
          const need = MOVES_NEEDING_CONDITION[compact(move)];
          if (!need || !profile.move_keys.has(compact(move)) || available.has(need)) continue;
          add(`${String(profile.name)}'s ${String(move).trim()} needs ${CONDITION_WORDS[need] || need} and nothing on the team sets it`, FIELD_HARD_WEIGHT);
        }
      }
    }
    const problems = weighted.map(([text]) => text);
    const totalWeight = Math.round(weighted.reduce((s, [, w]) => s + w, 0) * 1000) / 1000;
    const extra = this.rules
      ? { problems,
        field_available_v514: [...available].sort(),
        field_problem_weights_v514: weighted.map(([, w]) => w),
        field_weight_v514: totalWeight }
      : { problems };
    const fix = this.rules
      ? "Drop one of the competing setters, or give the move's owner the condition it needs."
      : "Remove the conflict or add the missing weather/terrain support.";
    const why = this.rules
      ? "Conflicting field choices can make the team's own tools unreliable."
      : "Conflicting field choices can make the team’s own tools unreliable.";
    // Rule off replays the pre-V514 line count exactly; rule on uses the weight.
    const isRed = this.rules ? totalWeight >= FIELD_RED_WEIGHT : problems.length >= 2;
    if (isRed) {
      return this.row("field_weather_consistency", "red", `${simpleJoin(problems, 4)}.`, why, fix, 5.0,
        this.rules
          ? `Problem = the field problems together reach ${FIELD_RED_WEIGHT.toFixed(1)}, counting ${FIELD_HARD_WEIGHT.toFixed(1)} for a dependency that cannot work and ${FIELD_SOFT_WEIGHT.toFixed(1)} for a conflict the team can play around.`
          : "Problem = two or more field/weather conflicts.", extra);
    }
    if (problems.length) {
      return this.row("field_weather_consistency", "yellow", `${simpleJoin(problems, 4)}.`,
        "The field plan mostly works, but one dependency or conflict needs attention.",
        "Fix the listed conflict or confirm it is an intentional matchup-specific choice.", 2.4,
        this.rules
          ? `Needs attention = the field problems together stay under ${FIELD_RED_WEIGHT.toFixed(1)}, counting ${FIELD_HARD_WEIGHT.toFixed(1)} for a dependency that cannot work and ${FIELD_SOFT_WEIGHT.toFixed(1)} for a conflict the team can play around.`
          : "Needs attention = one detected field/weather issue.", extra);
    }
    if (weatherSet.size || weatherUse.size || terrainSet.size) {
      return this.row("field_weather_consistency", "good", "weather and terrain choices have no obvious internal conflict.",
        "The detected field tools support the current team instead of blocking it.", "", 0,
        "Good = field dependencies have matching support and no detected conflict.", extra);
    }
    return this.row("field_weather_consistency", "good", "the team does not depend on weather or terrain, so no field support is required.",
      "No field plan is also valid for many balance or offense teams.", "", 0,
      "Good = no weather or terrain dependency needs support.", extra);
  }

  checkFor(id) {
    return {
      speed_control: this.checkSpeedControl,
      protect_positioning: this.checkProtectPositioning,
      spread_damage: this.checkSpreadDamage,
      priority_cleanup: this.checkPriorityCleanup,
      physical_damage: this.checkPhysicalDamage,
      special_damage: this.checkSpecialDamage,
      utility_disruption: this.checkUtilityDisruption,
      defensive_switch_ins: this.checkDefensiveSwitchIns,
      field_weather_consistency: this.checkFieldWeatherConsistency,
      coverage_gaps: this.checkCoverageGaps,
      speed_tiers: this.checkSpeedTiers,
      lead_viability: this.checkLeadViability,
    }[id];
  }

  // --- the check list -------------------------------------------------------------

  /** V201 base: the selected requirement rows, red first. */
  baseRows(profiles, selected) {
    const base = new Set([...selected].filter((id) => this.baseIds.includes(id)));
    if (!base.size) {
      return [{ kind: "checks_disabled", check_id: "checks_disabled", check_label: "checks_disabled", severity: "good", pressure: 0, check_system: "simple_custom_v187",
        text: "No Team Building Checks are enabled. Use Customize to select the requirements used by Team Building Checks, Suggestion Calcs, and Optimize Calcs." }];
    }
    const rows = this.baseIds.filter((id) => base.has(id) && !(this.singles && SINGLES_SKIPPED_CHECKS.has(id))).map((id) => this.checkFor(id).call(this, profiles));
    const order = Object.fromEntries(this.baseIds.map((id, i) => [id, i]));
    return stableSort(rows.filter((r) => String(r.text || "").trim()), (r) => [severityRank(r), order[rowId(r)] ?? 99]);
  }

  /** _v218_partial_team_check_rows: what a one-Pokemon team still gets told. */
  partialRows(team) {
    const count = team.length;
    if (count === 0) {
      return [{ check_id: "team_size", check_label: "Team Size", severity: "yellow", text: "Team Size: Needs Attention - add your first Pokemon to start checking team structure." }];
    }
    const hasMove = (list) => {
      const wanted = new Set(list);
      return team.some(({ entry }) => (entry.moves || []).some((m) => wanted.has(String(m ?? "").trim().toLowerCase())));
    };
    const rows = [{
      check_id: "team_size", check_label: "Team Size", severity: count < 6 ? "yellow" : "good",
      text: `Team Size: ${count < 6 ? "Needs Attention" : "Covered"} - ${count}/6 Pokemon selected. Suggested Pokemon can add teammates until the team is full.`,
    }];
    const protect = hasMove(["protect", "detect", "spiky shield", "king's shield", "baneful bunker", "silk trap", "burning bulwark"]);
    rows.push({ check_id: "protect_positioning", check_label: "Protect / Positioning", severity: protect ? "good" : "yellow",
      text: protect ? "Protect / Positioning: Covered - at least one selected Pokemon has a Protect-style tool."
        : this.singles ? "Protect / Positioning: Needs Attention - add Protect, a pivoting move, Fake Out, Intimidate, or similar switching support."
          : "Protect / Positioning: Needs Attention - add Protect, Fake Out, redirection, pivoting, Intimidate, or similar board-control support." });
    const speed = hasMove(["tailwind", "trick room", "icy wind", "electroweb", "thunder wave", "scary face", "bulldoze", "quash"]);
    rows.push({ check_id: "speed_control", check_label: "Speed Control", severity: speed ? "good" : "yellow",
      text: speed ? "Speed Control: Covered - at least one selected Pokemon has a speed-control move." : "Speed Control: Needs Attention - add Tailwind, Trick Room, speed-lowering moves, priority, or naturally fast teammates." });
    let physical = 0;
    let special = 0;
    for (const { entry } of team) {
      for (const move of entry.moves || []) {
        const category = String(this.ev.meta(move).category || "").toLowerCase();
        if (category === "physical") physical += 1;
        else if (category === "special") special += 1;
      }
    }
    if (physical && special) rows.push({ check_id: "damage_mix", check_label: "Damage Mix", severity: "good", text: "Damage Mix: Covered - the current team already has both physical and special pressure." });
    else if (count <= 1) rows.push({ check_id: "damage_mix", check_label: "Damage Mix", severity: "yellow", text: "Damage Mix: Needs Attention - one Pokemon cannot establish a complete physical/special damage profile yet. Add teammates that cover the missing side." });
    else rows.push({ check_id: "damage_mix", check_label: "Damage Mix", severity: "yellow", text: "Damage Mix: Needs Attention - the current team leans too heavily toward one attacking side. Add physical or special pressure to balance it." });
    if (!this.singles) {
      const spread = hasMove(["heat wave", "rock slide", "earthquake", "dazzling gleam", "hyper voice", "blizzard", "muddy water", "eruption", "water spout", "discharge", "surf", "icy wind", "snarl"]);
      rows.push({ check_id: "spread_damage", check_label: "Spread Damage", severity: spread ? "good" : "yellow",
        text: spread ? "Spread Damage: Covered - the current team has at least one spread-pressure option." : "Spread Damage: Needs Attention - add spread attacks so the team can pressure both opposing slots." });
    }
    const utility = hasMove(this.singles
      ? ["fake out", "taunt", "haze", "encore", "will-o-wisp", "parting shot", "snarl", "quick guard"]
      : ["fake out", "follow me", "rage powder", "taunt", "haze", "encore", "will-o-wisp", "parting shot", "snarl", "helping hand", "wide guard", "quick guard"]);
    rows.push({ check_id: "utility_disruption", check_label: "Utility / Disruption", severity: utility ? "good" : "yellow",
      text: utility ? "Utility / Disruption: Covered - at least one selected Pokemon has a disruption or support tool."
        : this.singles ? "Utility / Disruption: Needs Attention - add Taunt, Haze, Encore, Parting Shot, status, screens, or similar support."
          : "Utility / Disruption: Needs Attention - add Fake Out, redirection, Taunt, Haze, Parting Shot, status, screens, or similar support." });
    return rows;
  }

  /** _v403_archetype_features (+ V494 redirection users, + the Tailwind payoff count). */
  archetypeFeatures(profiles, { tailwind = null } = {}) {
    const s = this.archetypeSets;
    const weatherSetters = { rain: 0, sun: 0, sand: 0, snow: 0 };
    const weatherUsers = { rain: 0, sun: 0, sand: 0, snow: 0 };
    const weatherBeneficiaries = { rain: 0, sun: 0, sand: 0, snow: 0 };
    const terrainTypes = new Set();
    let terrainBeneficiaries = 0;
    const utility = new Set();
    const values = {
      team: profiles.length, attackers: 0, physical: 0, special: 0, fast: 0, slow_attackers: 0, protect: 0, speed_control: 0,
      priority: 0, positioning: 0, protect_positioning: 0, spread: 0, utility_providers: 0, bulky: 0, setup: 0, recovery: 0,
      denial: 0, screen_providers: 0, screens_distinct: 0, redirection_fakeout: 0, pivots: 0, tailwind_setters: 0,
      trick_room_setters: 0, perish_song: 0, trap_sources: 0, light_clay: 0, sustain_pivot: 0,
    };
    const screens = new Set();
    const evidence = {};
    const mark = (feature, profile) => {
      const list = evidence[feature] || (evidence[feature] = []);
      if (!list.includes(profile.name)) list.push(profile.name);
    };
    const has = (moves, set) => intersects(moves, set);
    for (const profile of profiles) {
      const moves = profile.move_keys;
      const ability = compact(profile.ability);
      const item = compact(profile.item);
      const types = new Set(profile.types.map((t) => t.toLowerCase()));
      const damaging = profile.damaging_count > 0;
      const speed = profile.speed;
      // _v403_profile_stats reads "special-defense"/"special_defense"/"spd"; the
      // engine's key is "sp_defense", so Special Defense never counts here.
      const hp = Number(profile.stats.hp) || 0;
      const defense = Number(profile.stats.defense) || 0;
      const finalStats = Math.max(hp, defense, 0, speed) > 150;
      const bulky = hp + defense >= (finalStats ? 355 : 270);
      const flags = {
        attackers: damaging,
        physical: profile.physical.length > 0,
        special: profile.special.length > 0,
        fast: damaging && speed >= (finalStats ? 150 : 110),
        slow_attackers: damaging && speed <= (finalStats ? 110 : 80),
        protect: profile.protect,
        speed_control: profile.speed_control,
        priority: profile.priority,
        positioning: profile.positioning,
        protect_positioning: profile.protect || profile.positioning,
        spread: profile.spread,
        utility_providers: profile.utility.size > 0,
        bulky,
        setup: has(moves, s.setup),
        recovery: has(moves, s.recovery),
        denial: has(moves, s.denial),
        screen_providers: has(moves, s.screen),
        redirection_fakeout: (!this.singles && has(moves, s.redirection)) || moves.has("fakeout"),
        pivots: has(moves, s.pivot),
        tailwind_setters: moves.has("tailwind"),
        trick_room_setters: moves.has("trickroom"),
        perish_song: moves.has("perishsong"),
        trap_sources: has(moves, s.trapMoves) || s.trapAbilities.has(ability),
        light_clay: item === "lightclay",
      };
      for (const [feature, active] of Object.entries(flags)) {
        if (active) {
          values[feature] += 1;
          mark(feature, profile);
        }
      }
      if (flags.recovery || flags.pivots || ["regenerator", "intimidate", "hospitality"].includes(ability)) {
        values.sustain_pivot += 1;
        mark("sustain_pivot", profile);
      }
      for (const u of profile.utility) utility.add(u);
      for (const m of moves) if (s.screen.has(m)) screens.add(m);
      for (const weather of WEATHERS) {
        if (profile.weather_set.has(weather)) {
          weatherSetters[weather] += 1;
          mark(`${weather}_setters`, profile);
        }
        if (profile.weather_use.has(weather)) {
          weatherUsers[weather] += 1;
          mark(`${weather}_users`, profile);
        }
        let benefit = profile.weather_use.has(weather);
        if (weather === "rain") benefit = benefit || (damaging && types.has("water")) || ["thunder", "hurricane", "weatherball"].some((m) => moves.has(m));
        else if (weather === "sun") benefit = benefit || (damaging && types.has("fire")) || ["solarbeam", "solarblade", "weatherball"].some((m) => moves.has(m));
        else if (weather === "sand") benefit = benefit || ["rock", "ground", "steel"].some((t) => types.has(t));
        else if (weather === "snow") benefit = benefit || types.has("ice") || moves.has("auroraveil");
        if (benefit) {
          weatherBeneficiaries[weather] += 1;
          mark(`${weather}_beneficiaries`, profile);
        }
      }
      for (const t of profile.terrain_set) terrainTypes.add(t);
      if (profile.terrain_set.size) mark("terrain_setters", profile);
      let payoff = ["risingvoltage", "expandingforce", "grassyglide", "terrainpulse"].some((m) => moves.has(m));
      payoff = payoff || ["surgesurfer", "quarkdrive"].includes(ability) || item.endsWith("seed");
      if (payoff) {
        terrainBeneficiaries += 1;
        mark("terrain_beneficiaries", profile);
      }
    }
    values.utility_categories = utility.size;
    values.screens_distinct = screens.size;
    values.terrain_setters = profiles.filter((p) => p.terrain_set.size).length;
    values.terrain_types = terrainTypes.size;
    values.terrain_beneficiaries = terrainBeneficiaries;
    values.weather_setters = weatherSetters;
    values.weather_users = weatherUsers;
    values.weather_beneficiaries = weatherBeneficiaries;
    values.weather_types = Object.values(weatherSetters).filter(Boolean).length;
    values.utility_category_names = [...utility].sort();
    values.evidence = evidence;
    values.redirection_users = this.singles ? 0 : profiles.filter((p) => has(p.move_keys, s.redirection)).length;
    values.tailwind_beneficiaries = typeof tailwind === "function" ? tailwind() : Number(tailwind) || 0;
    // Read by archetypeRequirements (only set in Singles, so Doubles features are unchanged).
    if (this.singles) values.singles = true;
    return values;
  }

  /** V462 _v403_archetype_check_row: the detected archetype and what it still misses. */
  archetypeRow(features) {
    const [display, key, scores] = classifyArchetype(features);
    const requirements = archetypeRequirements(key, features);
    const missing = requirements.filter((r) => !r.met);
    const passed = Math.max(0, requirements.length - missing.length);
    let summary = `Detected ${display}. ${passed}/${requirements.length} archetype requirements are covered.`;
    if (missing.length) summary += ` Missing: ${missing.slice(0, 4).map((r) => r.label || "requirement").join(", ")}.`;
    return {
      check_id: ARCHETYPE_CHECK_ID,
      kind: ARCHETYPE_CHECK_ID,
      check_label: `Archetype: ${display}`,
      archetype: display,
      archetype_key_v403: key,
      archetype_requirements_v403: requirements,
      archetype_features_v403: features,
      detected_archetype_v462: true,
      archetype_scores_v462: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      summary_v203: summary,
      summary,
      text: summary,
      why_v203: String((this.singles && SINGLES_ARCHETYPE_WHY[key]) || this.descriptions[key] || ""),
      fix_v203: missing.length ? `Improve ${missing.map((r) => r.label || "requirement").join(", ")}.` : "No archetype-specific changes are needed.",
      score_explanation: "",
      threshold_v203: "",
      severity: missing.length ? "yellow" : "good",
      status: missing.length ? "Watch Recommendation" : "OK",
      pressure: missing.length ? Math.min(2.4, 0.45 + 0.32 * missing.length) : 0,
    };
  }

  /** TeamAnalysisPanel.mega_count (V494: a Mega form counts, and so does any Mega Stone). */
  megaCount(team) {
    const labels = [];
    for (const { entry, mon } of team) {
      const base = String(entry.pokemon || "").trim();
      if (!base) continue;
      let item = String(entry.item || "").trim();
      if (!item) item = String(this.ev.commonSet(base)?.item || "");
      const formIsMega = this.formIsMega(base, entry.form);
      if (!formIsMega && !(item && this.ev.engine.isMegaStone(item))) continue;
      // The website keeps the species as the slot's form and lets the stone pick
      // the Mega, where the Companion saves the Mega form itself: name the Mega.
      const label = formIsMega ? String(entry.form).trim() : this.formIsMega(base, mon?.form_name) ? String(mon.form_name) : "";
      labels.push(label || base || "Unknown");
    }
    return [labels.length, labels];
  }

  formIsMega(base, form) {
    const name = String(form || "").trim();
    if (!name) return false;
    const record = this.ev.engine.formRecord(base, name);
    const kind = String(record?.kind || "").trim().toLowerCase();
    if (record && compact(record.form) === compact(name) && kind) return kind === "mega" || kind.startsWith("mega ");
    return name.toLowerCase().startsWith("mega ");
  }

  /** _v418_mega_check_row */
  megaRow(team) {
    const [count, megaNames] = this.megaCount(team);
    let severity = "good";
    let status = "OK";
    let summary;
    let fix;
    let pressure = 0;
    if (count === 0) {
      severity = "red";
      status = "Problem";
      summary = "0 Mega-capable Pokemon — add at least one Mega Stone user.";
      fix = "Add a Pokemon with a compatible Mega Stone so the team has a Mega option.";
      pressure = 5.2;
    } else if (count >= 3) {
      severity = "red";
      status = "Problem";
      summary = `${count} Mega-capable Pokemon — too many competing Mega options.`;
      fix = "Keep one or two flexible Mega options and free the remaining item slots.";
      pressure = 4.4 + Math.max(0, count - 3) * 0.6;
    } else {
      summary = `${count} Mega-capable Pokemon provide${count === 1 ? "s" : ""} a practical Mega option.`;
      fix = "No Mega-option change is required.";
    }
    const evidence = megaNames.length ? megaNames.join(", ") : "No Mega-capable Pokemon detected";
    return {
      check_id: "mega", kind: "mega", check_label: "Mega Options", severity, status,
      summary_v203: summary, summary, text: summary,
      why_v203: `${this.singles ? "A team" : "A VGC team"} needs a usable Mega option, while three or more Mega users compete for the one Mega Evolution available in battle. ${evidence}.`,
      fix_v203: fix,
      score_explanation: "0 Mega options and 3 or more Mega options are structural Team Building Problems; 1 or 2 are healthy.",
      pressure, mega_count: count, mega_names: megaNames,
    };
  }

  /**
   * The Team Building Checks card, in the app's final order.
   * @param {Array<{entry, mon}>} team   filled slots (Exclude Pokemon already applied)
   * @param {Iterable<string>|null} selection  saved check ids (null = everything)
   * @param {object} options  {tailwind}: the Tailwind payoff count or a function for it
   */
  rows(team, selection = null, options = {}) {
    const selected = this.selectedIds(selection);
    const profiles = this.profiles(team);
    // V201 base, then V218's partial-team rows for a one-Pokemon team.
    let rows = this.baseRows(profiles, selected);
    if (team.length <= 1 || !rows.length) {
      const seen = new Set(rows.map((r) => String(r.check_id || r.kind || r.check_label || "").toLowerCase()));
      for (const row of this.partialRows(team)) {
        const k = String(row.check_id || row.check_label || "").toLowerCase();
        if (!seen.has(k)) {
          rows.push(row);
          seen.add(k);
        }
      }
    }
    // V221: only enabled checks, red first, then the Customize order.
    const allIds = [...this.allCheckIds(), "mega"];
    const oldMap = { ...this.oldMap, damage_options: this.oldMap.damage_options || ["physical_damage", "special_damage"], damage_mix: this.oldMap.damage_mix || ["physical_damage", "special_damage"] };
    if (!selected.size) {
      rows = [{ check_id: "checks_disabled", check_label: "Team Building Checks", severity: "good",
        text: "No Team Building Checks are enabled. Use Customize to activate the checks used by Team Building Checks, Suggestion Calcs, and Optimize Calcs.",
        score_explanation: "Disabled checks are ignored by Team Building Checks, Suggested Pokemon, and Optimize calculations." }];
    } else {
      rows = rows.filter((row) => {
        const id = rowId(row);
        if (allIds.includes(id)) return selected.has(id);
        if (oldMap[id]) return oldMap[id].some((mapped) => selected.has(mapped));
        return false;
      });
      const order = Object.fromEntries(allIds.map((id, i) => [id, i]));
      rows = stableSort(rows, (r) => [severityRank(r), order[rowId(r)] ?? 999, String(r.check_label || r.text || "")]);
    }
    // V403/V462: the archetype row leads; V418: the Mega row follows it.
    const archetype = this.archetypeRow(this.archetypeFeatures(profiles, options));
    rows = [archetype, ...rows.filter((r) => rowId(r) !== ARCHETYPE_CHECK_ID && rowId(r) !== "mega")];
    rows.splice(1, 0, this.megaRow(team));
    // V433: Archetype is a check like the others; "disabled" only when nothing is on.
    if (!selected.has(ARCHETYPE_CHECK_ID)) rows = rows.filter((r) => rowId(r) !== ARCHETYPE_CHECK_ID);
    if (selected.size) rows = rows.filter((r) => rowId(r) !== "checks_disabled");
    return { rows, profiles, archetype, selected };
  }

  /** _v77_team_check_snapshot: what Suggestions and Auto Build score against. */
  snapshot(team, selection = null, options = {}) {
    const { rows, profiles, archetype, selected } = this.rows(team, selection, options);
    const scoredBase = rows.filter((r) => this.baseIds.includes(rowId(r)) && selected.has(rowId(r)) && String(r.severity || "good").toLowerCase() !== "good");
    const scored = rows.filter((r) => selected.has(rowId(r)) && !["good", "green", "ok"].includes(String(r.severity || "good").toLowerCase()));
    const pressure = scored.reduce((sum, r) => sum + (Number(r.pressure) || 0), 0);
    const utility = [...new Set(profiles.flatMap((p) => [...p.utility]))].sort();
    return {
      rows,
      warnings: scored.length,
      red_count: scored.filter((r) => String(r.severity).toLowerCase() === "red").length,
      yellow_count: scored.filter((r) => String(r.severity).toLowerCase() === "yellow").length,
      penalty: pressure,
      weighted_penalty: pressure,
      red_units: pressure / 3,
      check_pressure: pressure,
      role_balance: scoredBase.filter((r) => ["physical_damage", "special_damage", "utility_disruption"].includes(rowId(r))),
      type_coverage: scoredBase.filter((r) => rowId(r) === "defensive_switch_ins"),
      role: [],
      type: [],
      active: team.length,
      protect: profiles.filter((p) => p.protect).length,
      mega: 0,
      utility: utility.length,
      utility_moves: utility,
      selected_team_checks: this.allCheckIds().filter((id) => selected.has(id)),
      current_archetype_v403: String(archetype.archetype || "Balanced"),
      archetype_check_v403: rows.find((r) => rowId(r) === ARCHETYPE_CHECK_ID) || {},
    };
  }
}

function names(profiles, predicate) {
  return profiles.filter((p) => p && predicate(p)).map((p) => String(p.name || "Pokémon"));
}
