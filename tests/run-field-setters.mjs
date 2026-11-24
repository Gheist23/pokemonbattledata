// V558: a weather or terrain archetype wants the ABILITY, not the move.
//
// WHY THIS SUITE EXISTS. `run-autobuild-vectors` replays with `fieldSetterRule: 0` -- 147 of its
// 2,599 comparisons move with the rule on, because the recordings predate it -- so no vector
// suite exercises this rule at all. Section 7 asserts that flag is still there; everything above
// it is the only coverage the rule has.
//
// THE DEFECT IT FIXES. `TeamChecks.profile` built its weather set from
// `allKeys = [...moveKeys, abilityKey]`, so Pelipper's Drizzle and a Rain Dance user were
// recorded identically and `weather_setters.rain` counted them the same. They are not the same:
// an Ability sets the field on entry, free, every switch-in, costing no slot and no turn; a move
// costs a slot and a turn and can be Taunted, Protected around or outsped.
//
// (`weather_use` is a DIFFERENT question that already existed -- abilities that BENEFIT from the
// weather, like Swift Swim. The old "<Weather> ability users" requirement is about those, which
// is why nothing here was already answering this one.)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { BuilderData } from "../builder/common.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { FIELD_SETTER_RULE, archetypeRequirements, fieldSetterRuleOption } from "../builder/team-checks.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => JSON.parse(readFileSync(join(root, ...p), "utf8"));
const appData = read("data", "builder", "app-data.json");
const metaData = read("data", "builder", "meta-doubles.json");

let checked = 0;
const failures = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const data = new BuilderData(appData);
data.ingestMeta("Doubles", metaData);
const engine = new DamageEngine(appData);
const set = (s, f, i, a, n, b, m) => ({ species: s, form: f || s, item: i, ability: a, nature: n, bonuses: b, moves: m });

/** Four slots that set no field themselves, so the setter under test is the only one. */
const FILLER = [
  set("Incineroar", "", "Sitrus Berry", "Intimidate", "Adamant", [32, 32, 2, 0, 0, 0], ["Flare Blitz", "Knock Off", "Fake Out", "Parting Shot"]),
  set("Barraskewda", "", "Choice Band", "Swift Swim", "Adamant", [2, 32, 0, 0, 0, 32], ["Liquidation", "Close Combat", "Aqua Jet", "Protect"]),
  set("Basculegion", "", "Mystic Water", "Swift Swim", "Modest", [2, 0, 0, 32, 0, 32], ["Hydro Pump", "Shadow Ball", "Protect", "Ice Beam"]),
  set("Luxray", "", "Shuca Berry", "Intimidate", "Adamant", [32, 0, 2, 0, 32, 0], ["Protect", "Snarl", "Superpower", "Wild Charge"]),
  set("Arcanine", "", "Life Orb", "Intimidate", "Adamant", [32, 32, 0, 0, 0, 2], ["Flare Blitz", "Snarl", "Protect", "Extreme Speed"]),
];
const RAIN_BY_ABILITY = [set("Pelipper", "", "Focus Sash", "Drizzle", "Modest", [32, 0, 2, 32, 0, 0], ["Hurricane", "Weather Ball", "Tailwind", "Protect"]), ...FILLER];
const RAIN_BY_MOVE = [set("Milotic", "", "Leftovers", "Competitive", "Calm", [32, 0, 17, 8, 5, 4], ["Rain Dance", "Scald", "Ice Beam", "Protect"]), ...FILLER];
const GRASS_BY_ABILITY = [set("Rillaboom", "", "Assault Vest", "Grassy Surge", "Adamant", [32, 32, 2, 0, 0, 0], ["Grassy Glide", "Wood Hammer", "U-turn", "Fake Out"]), ...FILLER];
const GRASS_BY_MOVE = [set("Milotic", "", "Leftovers", "Competitive", "Calm", [32, 0, 17, 8, 5, 4], ["Grassy Terrain", "Scald", "Ice Beam", "Protect"]), ...FILLER];

function look(team, extra = {}) {
  const ev = new TeamEvaluator(data, engine, "Doubles",
    normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: 30 }), extra);
  ev.setMetaRecords(metaData.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const slots = evaluation.slots(team);
  const payload = evaluation.evaluate(team, { checkSelection: null });
  return {
    setter: evaluation.checks.profile(slots[0].entry, slots[0].mon),
    features: payload.features || {},
    reqs: (key) => archetypeRequirements(key, payload.features || {}),
  };
}
const req = (reqs, pattern) => reqs.find((r) => pattern.test(String(r.label || r.name || "")));

// --- 1. the gate -------------------------------------------------------------------------
{
  ok("production is on", FIELD_SETTER_RULE === 1);
  ok("an absent option means production", fieldSetterRuleOption(undefined) === 1 && fieldSetterRuleOption(null) === 1);
  for (const off of [0, "0", false, "off", "false", "no", "none", ""]) {
    ok(`${JSON.stringify(off)} turns it off`, fieldSetterRuleOption(off) === 0, String(fieldSetterRuleOption(off)));
  }
  for (const on of [1, "1", true, "on"]) ok(`${JSON.stringify(on)} leaves it on`, fieldSetterRuleOption(on) === 1);
}

// --- 2. the profile records WHERE the field comes from ----------------------------------
// Fails for the real reason: build the sets from `allKeys` again and the move arm goes red.
{
  const byAbility = look(RAIN_BY_ABILITY).setter;
  const byMove = look(RAIN_BY_MOVE).setter;
  ok("both set rain at all", byAbility.weather_set.has("rain") && byMove.weather_set.has("rain"));
  ok("the Ability setter is recorded as one", byAbility.weather_set_by_ability.has("rain"));
  ok("the MOVE setter is NOT", !byMove.weather_set_by_ability.has("rain"),
    [...byMove.weather_set_by_ability].join(","));
  ok("a terrain Ability is recorded the same way",
    look(GRASS_BY_ABILITY).setter.terrain_set_by_ability.size > 0);
  ok("and a terrain MOVE is not",
    look(GRASS_BY_MOVE).setter.terrain_set_by_ability.size === 0);
  // `weather_use` is the other question and must be untouched by any of this.
  ok("Swift Swim is still a weather USER, not a setter",
    look(RAIN_BY_ABILITY).features.weather_users?.rain >= 2,
    String(look(RAIN_BY_ABILITY).features.weather_users?.rain));
}

// --- 3. the features count them apart, and vanish with the rule off --------------------
{
  const on = look(RAIN_BY_MOVE);
  const off = look(RAIN_BY_MOVE, { fieldSetterRule: 0 });
  ok("the move team still counts one rain setter", on.features.weather_setters?.rain === 1,
    String(on.features.weather_setters?.rain));
  ok("but zero of them by Ability", on.features.weather_ability_setters?.rain === 0,
    String(on.features.weather_ability_setters?.rain));
  ok("the ability team counts one by Ability",
    look(RAIN_BY_ABILITY).features.weather_ability_setters?.rain === 1);
  // WITH THE RULE OFF THE COUNT IS ABSENT, not zero: `archetypeRequirements` gates on the field
  // being present, so undefined is what makes a recording replay in the world it was recorded in.
  ok("with the rule off the count is absent entirely",
    off.features.weather_ability_setters === undefined,
    JSON.stringify(off.features.weather_ability_setters));
  ok("and so is the terrain count", off.features.terrain_ability_setters === undefined);
}

// --- 4. the requirement is CRITICAL and flips -----------------------------------------
// Critical is the whole point: Auto Build ranks a candidate on the chosen archetype's unmet
// requirements and weights a critical one 2.4x. Non-critical would be a preference, not a
// priority, and the owner asked for the Ability to be heavily prioritised.
{
  const byAbility = look(RAIN_BY_ABILITY);
  const byMove = look(RAIN_BY_MOVE);
  const a = req(byAbility.reqs("rain"), /from an Ability/);
  const m = req(byMove.reqs("rain"), /from an Ability/);
  ok("the rain archetype asks for an Ability setter", Boolean(a) && Boolean(m));
  ok("and asks critically", a?.critical === true, JSON.stringify(a));
  ok("an Ability setter MEETS it", a?.met === true, JSON.stringify(a));
  ok("a move setter does NOT", m?.met === false, JSON.stringify(m));
  for (const key of ["sun", "sand", "snow"]) {
    ok(`${key} asks for one too`, Boolean(req(look(RAIN_BY_ABILITY).reqs(key), /from an Ability/)));
  }
  // The terrain archetype, same shape.
  const t = req(look(GRASS_BY_ABILITY).reqs("terrain"), /from an Ability/);
  const tm = req(look(GRASS_BY_MOVE).reqs("terrain"), /from an Ability/);
  ok("terrain asks for an Ability, critically", t?.critical === true, JSON.stringify(t));
  ok("a Surge meets it", t?.met === true, JSON.stringify(t));
  ok("the move does not", tm?.met === false, JSON.stringify(tm));
  // And with the rule off the requirement is not there at all.
  ok("with the rule off no such requirement exists",
    !req(look(RAIN_BY_MOVE, { fieldSetterRule: 0 }).reqs("rain"), /from an Ability/));
  ok("the old requirements are untouched",
    Boolean(req(byMove.reqs("rain"), /^Rain setters$/))
    && Boolean(req(byMove.reqs("rain"), /Rain ability users/)));
}

// --- 5. TRICK ROOM IS DELIBERATELY EXCLUDED -------------------------------------------
// No Ability sets Trick Room, so asking for one would be an unmeetable critical requirement
// that every Trick Room team fails forever. This is the one field the rule cannot apply to.
{
  const room = [
    set("Slowking", "Slowking-Galar", "Colbur Berry", "Regenerator", "Quiet", [32, 0, 2, 32, 0, 0], ["Trick Room", "Sludge Bomb", "Chilly Reception", "Psychic"]),
    ...FILLER,
  ];
  const reqs = look(room).reqs("trick room");
  ok("the trick room archetype asks for no Ability setter",
    !req(reqs, /from an Ability/), JSON.stringify(reqs.map((r) => r.label)));
  ok("it still asks for its setters", Boolean(req(reqs, /Trick Room setters/)));
}

// --- 6. a team with no field at all is unaffected -------------------------------------
{
  const plain = look(FILLER);
  ok("no setters, so none by Ability", plain.features.weather_ability_setters?.rain === 0,
    String(plain.features.weather_ability_setters?.rain));
  ok("and no terrain by Ability", plain.features.terrain_ability_setters === 0,
    String(plain.features.terrain_ability_setters));
}

// --- 7. the recorded suite replays the world it was recorded in -----------------------
{
  // BOTH of them. Suggestions reads the same `archetypeRequirements` as Auto Build, so it moves
  // too -- 484 of its 5,430 comparisons. Flagging only the Auto Build suite left the suggest one
  // red, which is the mistake this guard exists to stop repeating.
  for (const name of ["run-autobuild-vectors.mjs", "run-suggest-vectors.mjs"]) {
    const source = readFileSync(join(here, name), "utf8");
    ok(`${name} replays with the old field-setter rule`, /fieldSetterRule:\s*0/.test(source));
  }
}

console.log(`${checked} checked, ${failures.length} failed`);
for (const line of failures) console.log(`  FAIL ${line}`);
process.exit(failures.length ? 1 : 0);
