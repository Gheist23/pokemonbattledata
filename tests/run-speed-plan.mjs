// V557: a team cannot run two speed plans in one game, so stop paying it for both.
//
// WHY THIS SUITE EXISTS. Every recorded vector was made while the flat credit for OWNING Trick
// Room was paid unconditionally, so the replay suites pass `speedPlanRule: 0` and none of them
// exercises the rule ON. Section 6 asserts they really do pass it off.
//
// THE RULE TOOK THREE PASSES AND THE RECORDED SUITES CORRECTED IT TWICE. Both corrections are
// pinned below, because each is a team the rule must NOT charge:
//   * scaling by `fastTeam / team` charged a legitimate Room six 25% for one fast attacker;
//   * counting any Icy Wind as a rival plan charged a THREE-setter Room six for a flex move.
// What survives is: a hedge counts only when the fast investment matches or exceeds the Room's.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { BuilderData } from "../builder/common.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import {
  OWN_TRICK_ROOM_CREDIT, OWN_TRICK_ROOM_TAILWIND_CREDIT, SPEED_PLAN_RULE, roomPlan,
  speedPlanRuleOption,
} from "../builder/team-speed.js";

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
const near = (a, b, tol = 0.051) => Math.abs(Number(a) - Number(b)) <= tol;

const data = new BuilderData(appData);
data.ingestMeta("Doubles", metaData);
const engine = new DamageEngine(appData);
const set = (s, f, i, a, n, b, m) => ({ species: s, form: f || s, item: i, ability: a, nature: n, bonuses: b, moves: m });

/** The owner's Auto-Built six: ONE Trick Room setter against Icy Wind and an Unburden sweeper. */
const HEDGE = [
  set("Milotic", "", "Leftovers", "Competitive", "Calm", [32, 0, 17, 8, 5, 4], ["Protect", "Scald", "Ice Beam", "Icy Wind"]),
  set("Sneasler", "", "White Herb", "Unburden", "Adamant", [2, 32, 0, 0, 0, 32], ["Close Combat", "Dire Claw", "Protect", "Fake Out"]),
  set("Luxray", "", "Shuca Berry", "Intimidate", "Adamant", [32, 0, 2, 0, 32, 0], ["Protect", "Snarl", "Superpower", "Wild Charge"]),
  set("Arcanine", "", "Life Orb", "Intimidate", "Adamant", [32, 32, 0, 0, 0, 2], ["Extreme Speed", "Flare Blitz", "Protect", "Snarl"]),
  set("Dragonite", "Dragonite-Mega", "Dragoninite", "Multiscale", "Modest", [2, 0, 0, 32, 0, 32], ["Protect", "Extreme Speed", "Heat Wave", "Draco Meteor"]),
  set("Slowking", "Slowking-Galar", "Colbur Berry", "Regenerator", "Quiet", [32, 0, 2, 32, 0, 0], ["Trick Room", "Sludge Bomb", "Chilly Reception", "Psychic"]),
];

/** Two setters, no Tailwind, no Speed-lowering move: the Room is plainly the plan. */
const COMMITTED = [
  set("Slowking", "Slowking-Galar", "Colbur Berry", "Regenerator", "Quiet", [32, 0, 2, 32, 0, 0], ["Trick Room", "Sludge Bomb", "Chilly Reception", "Psychic"]),
  set("Gourgeist", "Gourgeist-Super", "Leftovers", "Frisk", "Brave", [32, 32, 2, 0, 0, 0], ["Trick Room", "Shadow Sneak", "Protect", "Seed Bomb"]),
  set("Rillaboom", "", "Assault Vest", "Grassy Surge", "Brave", [32, 32, 2, 0, 0, 0], ["Grassy Glide", "Wood Hammer", "U-turn", "Fake Out"]),
  set("Incineroar", "", "Sitrus Berry", "Intimidate", "Brave", [32, 32, 2, 0, 0, 0], ["Flare Blitz", "Knock Off", "Fake Out", "Parting Shot"]),
  set("Luxray", "", "Shuca Berry", "Intimidate", "Adamant", [32, 0, 2, 0, 32, 0], ["Protect", "Snarl", "Superpower", "Wild Charge"]),
  set("Arcanine", "", "Life Orb", "Intimidate", "Brave", [32, 32, 0, 0, 0, 2], ["Flare Blitz", "Snarl", "Protect", "Will-O-Wisp"]),
];

function speedOf(team, extra = {}) {
  const ev = new TeamEvaluator(data, engine, "Doubles",
    normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: 30 }), extra);
  ev.setMetaRecords(metaData.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const payload = evaluation.evaluate(team, { checkSelection: null });
  const slots = evaluation.slots(team);
  const profiles = slots.map(({ entry, mon }) => evaluation.synergy.profile(entry, mon));
  return {
    speed: payload.speed, plan: roomPlan(profiles, evaluation.synergy.metaSpeedRows(), engine),
    note: (payload.speed?.trick_lines || []).find((l) => /speed plan can be run|cannot run it/.test(l)) || "",
  };
}

// --- 1. the gate -------------------------------------------------------------------------
{
  ok("production is on", SPEED_PLAN_RULE === 1);
  ok("an absent option means production", speedPlanRuleOption(undefined) === 1 && speedPlanRuleOption(null) === 1);
  for (const off of [0, "0", false, "off", "false", "no", "none", ""]) {
    ok(`${JSON.stringify(off)} turns it off`, speedPlanRuleOption(off) === 0, String(speedPlanRuleOption(off)));
  }
  for (const on of [1, "1", true, "on"]) ok(`${JSON.stringify(on)} leaves it on`, speedPlanRuleOption(on) === 1);
  ok("the two credits are the numbers v42 paid before the rule",
    OWN_TRICK_ROOM_CREDIT === 25.0 && OWN_TRICK_ROOM_TAILWIND_CREDIT === 20.0,
    `${OWN_TRICK_ROOM_CREDIT} / ${OWN_TRICK_ROOM_TAILWIND_CREDIT}`);
}

// --- 2. a COMMITTED Trick Room team is not touched --------------------------------------
// The whole risk of this rule is charging real Room teams. It must cost them nothing.
{
  const off = speedOf(COMMITTED, { speedPlanRule: 0 });
  const on = speedOf(COMMITTED);
  ok("the committed six really has two setters", on.plan.setters === 2, String(on.plan.setters));
  ok("and no Speed-lowering move or Tailwind to compete with its Room", on.note === "", on.note);
  ok("its Trick Room component is unchanged", near(on.speed.trick_room, off.speed.trick_room),
    `${off.speed.trick_room} -> ${on.speed.trick_room}`);
  ok("its Opposing Speed Control is unchanged", near(on.speed.opposing_tailwind, off.speed.opposing_tailwind),
    `${off.speed.opposing_tailwind} -> ${on.speed.opposing_tailwind}`);
  ok("and so is its Speed score", near(on.speed.score, off.speed.score), `${off.speed.score} -> ${on.speed.score}`);
}

// --- 3. a HEDGING team is charged, and only partly -------------------------------------
{
  const off = speedOf(HEDGE, { speedPlanRule: 0 });
  const on = speedOf(HEDGE);
  ok("the hedging six has ONE setter against a Speed-lowering move", on.plan.setters === 1, String(on.plan.setters));
  ok("its Room IS supported, so this is not the unusable-Room arm",
    on.plan.supported === true, JSON.stringify(on.plan));
  ok("it says why the credit was withheld", /speed plan can be run/.test(on.note), on.note);
  // One competing piece (Icy Wind) withholds 25% of each flat credit, and nothing else moves.
  ok("25% of the Trick Room credit is withheld",
    near(on.speed.trick_room, off.speed.trick_room - OWN_TRICK_ROOM_CREDIT * 0.25),
    `${off.speed.trick_room} -> ${on.speed.trick_room}`);
  ok("and 25% of the Opposing Speed Control credit",
    near(on.speed.opposing_tailwind, off.speed.opposing_tailwind - OWN_TRICK_ROOM_TAILWIND_CREDIT * 0.25),
    `${off.speed.opposing_tailwind} -> ${on.speed.opposing_tailwind}`);
  ok("the Speed score falls", on.speed.score < off.speed.score, `${off.speed.score} -> ${on.speed.score}`);
  ok("but never by more than the two credits are worth",
    off.speed.score - on.speed.score <= (OWN_TRICK_ROOM_CREDIT + OWN_TRICK_ROOM_TAILWIND_CREDIT) * 0.5,
    String(off.speed.score - on.speed.score));
  // Standard Speed is a fact about the team's own Speeds, not about either plan.
  ok("Standard Speed is untouched", near(on.speed.standard, off.speed.standard),
    `${off.speed.standard} -> ${on.speed.standard}`);
}

// --- 4. THE TWO CORRECTIONS THE RECORDED SUITES FORCED --------------------------------
// Each of these is a shape an earlier version of the rule charged and must not.
{
  // (a) A fast attacker is not a plan. Three setters, one fast member, nothing speed-lowering.
  const roomWithFlex = [...COMMITTED];
  roomWithFlex[4] = set("Sneasler", "", "Focus Sash", "Unburden", "Adamant", [2, 32, 0, 0, 0, 32],
    ["Close Combat", "Dire Claw", "Protect", "Fake Out"]);
  const flex = speedOf(roomWithFlex);
  const flexOff = speedOf(roomWithFlex, { speedPlanRule: 0 });
  ok("a Room team carrying one fast attacker keeps its credit",
    near(flex.speed.trick_room, flexOff.speed.trick_room),
    `${flexOff.speed.trick_room} -> ${flex.speed.trick_room} (setters ${flex.plan.setters})`);

  // (b) A flex Icy Wind under MORE setters than competing pieces is not a hedge.
  const roomWithIcyWind = [...COMMITTED];
  roomWithIcyWind[4] = set("Milotic", "", "Leftovers", "Competitive", "Calm", [32, 0, 17, 8, 5, 4],
    ["Protect", "Scald", "Ice Beam", "Icy Wind"]);
  const icy = speedOf(roomWithIcyWind);
  const icyOff = speedOf(roomWithIcyWind, { speedPlanRule: 0 });
  ok("two setters against one Icy Wind is still a Room team",
    icy.plan.setters === 2 && near(icy.speed.trick_room, icyOff.speed.trick_room),
    `setters ${icy.plan.setters}: ${icyOff.speed.trick_room} -> ${icy.speed.trick_room}`);
}

// --- 5. with the rule OFF, nothing moves at all ---------------------------------------
{
  for (const [label, team] of [["the hedging six", HEDGE], ["the committed six", COMMITTED]]) {
    const a = speedOf(team, { speedPlanRule: 0 });
    const b = speedOf(team, { speedPlanRule: 0 });
    ok(`${label} replays identically with the rule off`,
      near(a.speed.score, b.speed.score) && a.note === "" && b.note === "", `${a.speed.score} / ${b.speed.score}`);
  }
}

// --- 6. the recorded suites replay the world they were recorded in --------------------
{
  for (const name of ["run-eval-vectors.mjs", "run-suggest-vectors.mjs", "run-autobuild-vectors.mjs"]) {
    const source = readFileSync(join(here, name), "utf8");
    ok(`${name} replays with the old speed-plan credit`, /speedPlanRule:\s*0/.test(source));
  }
}

console.log(`${checked} checked, ${failures.length} failed`);
for (const line of failures) console.log(`  FAIL ${line}`);
process.exit(failures.length ? 1 : 0);
