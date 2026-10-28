// Checks builder/engine.js against damage results recorded from the Companion.
//
//   python ../../pct_tool94/tools/export_web_builder_data.py --vectors 4000
//   node tests/run-calc-vectors.mjs
//
// Every vector holds the exact attacker, defender and context the app was given
// and the fields it answered with. Any difference is printed with the inputs so
// the failing layer can be found; the exit code is the number of mismatches.

// Terrain seeds (builder/engine.js): each vector carries the rules the app ran with, so a
// vector stamped `rules.terrain_seeds` is replayed with a held Electric/Grassy/Misty/Psychic
// Seed adding its stage and one recorded before the rule is replayed without it.
// TERRAIN_SEEDS=1 / =0 replays every vector either way.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, fieldRequirementOption, makeContext, makeMon, pyFixed, pyRound, ateDragonizeOption, formTypeOption, gravityPowerOption, auraGuardOption, fairyAuraOption, guardDogOption, moveFlagsOption, movePriorityOption, roomPlanOption, selfStatChangeOption, terrainSeedOption } from "../builder/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const vectors = JSON.parse(readFileSync(join(here, "calc-vectors.json"), "utf8"));
const engine = new DamageEngine(appData);
const seedRule = (vector) => terrainSeedOption(process.env.TERRAIN_SEEDS === undefined ? (vector.rules?.terrain_seeds ?? null) : process.env.TERRAIN_SEEDS);
// V521: Steel Roller fails with no terrain. A vector recorded before the rule
// carries no `field_requirements` stamp and replays with it off, so the three
// no-terrain Steel Roller vectors keep the answer the app gave when they were made.
const fieldRule = (vector) => fieldRequirementOption(
  process.env.FIELD_REQUIREMENTS === undefined
    ? (vector.rules?.field_requirements ?? null)
    : process.env.FIELD_REQUIREMENTS);
/** V525: Contrary turns a self-lowering move into a self-raising one, which is what
    `self_drop_v494` says -- a compared field below. A vector recorded before the rule
    carries no `self_stat_change` stamp and replays with it off. */
/** V527: every move learned the flags the game's archive does not publish -- contact,
    punch, bite, slicing, pulse -- so Tough Claws, Iron Fist, Strong Jaw, Sharpness,
    Reckless, Mega Launcher, Fluffy and Punk Rock stopped being inert. A vector recorded
    before the rule carries no `move_flags` stamp and replays with it off. */
/** V528: Dragonize joined the `-ate` table, so a Mega Feraligatr's Normal moves became
    Dragon moves at 1.2x. A vector recorded before the rule carries no `ate_dragonize`
    stamp and replays with the four-entry table. */
/** Raging Bull takes its user's form's type (Paldean Tauros: Combat/Blaze/Aqua Breed become
    Fighting/Fire/Water). A vector recorded before the rule carries no `form_type` stamp and
    replays with the move's listed Normal, which is what it was recorded at. */
/** Gravity raises Grav Apple's power by half. A vector recorded before the rule carries no
    `gravity_power` stamp and replays with the flat power. */
/** Aura Guard halves the contact damage its holder takes. A vector recorded before the rule
    carries no `aura_guard` stamp and replays un-halved. */
/** Guard Dog turns Intimidate round instead of taking the drop. A vector recorded before the
    rule carries no `guard_dog` stamp and replays with the -1. */
const guardDogRule = (vector) => guardDogOption(
  process.env.GUARD_DOG === undefined
    ? (vector.rules?.guard_dog ?? vector.record?.rules?.guard_dog ?? null)
    : process.env.GUARD_DOG);
/** Fairy Aura lifts every Fairy-type attack on the field by a third. A vector recorded
    before the rule carries no `fairy_aura` stamp and replays with the un-boosted
    number -- in both directions, because either side's aura counts. */
const fairyAuraRule = (vector) => fairyAuraOption(
  process.env.FAIRY_AURA === undefined
    ? (vector.rules?.fairy_aura ?? vector.record?.rules?.fairy_aura ?? null)
    : process.env.FAIRY_AURA);
const auraGuardRule = (vector) => auraGuardOption(
  process.env.AURA_GUARD === undefined
    ? (vector.rules?.aura_guard ?? vector.record?.rules?.aura_guard ?? null)
    : process.env.AURA_GUARD);
const gravityPowerRule = (vector) => gravityPowerOption(
  process.env.GRAVITY_POWER === undefined
    ? (vector.rules?.gravity_power ?? vector.record?.rules?.gravity_power ?? null)
    : process.env.GRAVITY_POWER);
const formTypeRule = (vector) => formTypeOption(
  process.env.FORM_TYPE === undefined
    ? (vector.rules?.form_type ?? vector.record?.rules?.form_type ?? null)
    : process.env.FORM_TYPE);
const ateDragonizeRule = (vector) => ateDragonizeOption(
  process.env.ATE_DRAGONIZE === undefined
    ? (vector.rules?.ate_dragonize ?? vector.record?.rules?.ate_dragonize ?? null)
    : process.env.ATE_DRAGONIZE);
/** V529: 33 moves learned the turn-order priority they really have, so Roar, Dragon Tail,
    Teleport (-6), Counter (-5), Focus Punch (-3), Helping Hand (+5), Quick Guard (+3) and
    Follow Me (+2) stopped resolving at 0. Turn order decides who acts, so a vector recorded
    before the rule carries no `move_priority` stamp and replays with the 23 hand-written
    values. */
/** V530: a Trick Room plan has to outweigh the attackers the Room turns round, so an
    ordinary Tailwind team is no longer scored under the Trick Room regime. `supported`
    picks the whole speed scoring regime, so a vector recorded before the rule carries no
    `room_plan` stamp and replays with the two older clauses. */
const roomPlanRule = (vector) => roomPlanOption(
  process.env.ROOM_PLAN === undefined
    ? (vector.rules?.room_plan ?? vector.record?.rules?.room_plan ?? null)
    : process.env.ROOM_PLAN);
const movePriorityRule = (vector) => movePriorityOption(
  process.env.MOVE_PRIORITY === undefined
    ? (vector.rules?.move_priority ?? vector.record?.rules?.move_priority ?? null)
    : process.env.MOVE_PRIORITY);
const moveFlagsRule = (vector) => moveFlagsOption(
  process.env.MOVE_FLAGS === undefined
    ? (vector.rules?.move_flags ?? vector.record?.rules?.move_flags ?? null)
    : process.env.MOVE_FLAGS);
const selfStatRule = (vector) => selfStatChangeOption(
  process.env.SELF_STAT_CHANGE === undefined
    ? (vector.rules?.self_stat_change ?? vector.record?.rules?.self_stat_change ?? null)
    : process.env.SELF_STAT_CHANGE);

// Formatting helpers first: they carry most of the Python/JS divergence risk.
const formatCases = [[6.25, "6.2"], [18.75, "18.8"], [31.25, "31.2"], [0.05, "0.1"], [2.675, "2.7"], [100, "100.0"], [43.75, "43.8"]];
for (const [value, expected] of formatCases) {
  const got = pyFixed(value, 1);
  if (got !== expected) throw new Error(`pyFixed(${value}) = ${got}, expected ${expected}`);
}
for (const [value, expected] of [[0.5, 0], [1.5, 2], [2.5, 2], [3.5, 4], [2.4999, 2], [-0.5, -0]]) {
  if (pyRound(value) !== expected) throw new Error(`pyRound(${value}) = ${pyRound(value)}`);
}

const FIELDS = [
  "rolls", "range", "percent", "ko", "display_percent", "recoil_hp_range", "recoil_percent",
  "hit_count", "move_accuracy_percent", "attacker_speed", "defender_speed", "speed_tie",
  "focus_sash_active", "sturdy_active", "sitrus_berry_active", "sitrus_heal", "max_hp",
  "current_hp", "summary", "charged_state_active", "recharge_move", "self_drop_v494",
];

let failures = 0;
let checked = 0;
const byField = new Map();
/**
 * NOTHING IS SKIPPED.
 *
 * Battle Armor and Shell Armor mean a Pokemon cannot be critically hit, and this suite used to
 * skip the vectors that turned on. First six of them, because the Companion crit through those
 * Abilities and this engine did not; then three, once the Companion was fixed and the vectors
 * re-recorded, because of the last difference between the two -- a Pokemon standing in a MEGA
 * FORM while its set records some other Ability (a randomly generated Mega Scolipede carrying
 * Delphoxite with Purifying Salt). The Companion resolved the Mega and saw its Shell Armor;
 * this engine read the Ability the set named.
 *
 * Those three are now checked like every other vector, because `DamageEngine.critProofAbility`
 * resolves the same Mega the Companion does. That matters beyond tidiness: those three were the
 * ONLY vectors in the file that exercised the crit-immunity read in `attackDefenseValues`, so
 * while they were skipped that fix could be reverted and this suite stayed green.
 */
for (const [index, vector] of vectors.entries()) {
  if (vector.error) continue;
  engine.terrainSeeds = seedRule(vector);
  engine.fieldRequirements = fieldRule(vector);
  engine.selfStatChange = selfStatRule(vector);
  engine.moveFlags = moveFlagsRule(vector);
  engine.movePriority = movePriorityRule(vector);
  engine.roomPlan = roomPlanRule(vector);
  engine.ateDragonize = ateDragonizeRule(vector);
  engine.formType = formTypeRule(vector);
  engine.gravityPower = gravityPowerRule(vector);
  engine.auraGuard = auraGuardRule(vector);
  engine.fairyAura = fairyAuraRule(vector);
  engine.guardDog = guardDogRule(vector);
  const attacker = makeMon(vector.attacker);
  const defender = makeMon(vector.defender);
  const ctx = makeContext(vector.ctx);
  let result;
  try {
    result = engine.calculate(attacker, defender, ctx);
  } catch (error) {
    failures += 1;
    console.log(`#${index} threw: ${error.stack}`);
    continue;
  }
  checked += 1;
  const expected = vector.expected;
  const diffs = [];
  for (const field of FIELDS) {
    const want = expected[field];
    const got = result[field];
    if (want === undefined && (got === undefined || got === false)) continue;
    if (JSON.stringify(want) !== JSON.stringify(got)) diffs.push([field, want, got]);
  }
  if ((result.warnings || []).length !== expected.warning_count) diffs.push(["warning_count", expected.warning_count, (result.warnings || []).length]);
  if (diffs.length) {
    failures += 1;
    for (const [field] of diffs) byField.set(field, (byField.get(field) || 0) + 1);
    if (failures <= 12) {
      console.log(`\n#${index} ${vector.attacker.pokemon_name}/${vector.attacker.form_name} ${vector.ctx.move_name} -> ${vector.defender.pokemon_name}/${vector.defender.form_name}`);
      for (const [field, want, got] of diffs) console.log(`   ${field}: app=${JSON.stringify(want)} web=${JSON.stringify(got)}`);
    }
  }
}
console.log(`\n${checked} vectors checked, ${failures} mismatched.`);
if (byField.size) console.log("Mismatched fields:", Object.fromEntries(byField));
process.exitCode = Math.min(failures, 255);
