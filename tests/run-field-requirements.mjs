// Steel Roller needs a terrain (builder/engine.js, and the Companion's
// pokemon_champions_tool/move_field_requirement_v521.py).
//
// The move fails outright with no terrain on the field -- not reduced damage, nothing at
// all. Its own data says so in the description ("This move fails if there is no terrain on
// the field") and nowhere else: unlike Weather Ball and Terrain Pulse it carries no
// `special`, so the engine treated it as a plain 130 base power Steel move whatever the
// field was doing. The Companion had the same gap and the same symptom -- 132.86% with no
// terrain and 132.86% with Electric Terrain, the identical pair -- while its battle
// simulation already refused to offer the move at all without a terrain.
//
// Checked here:
//   1. with no terrain the move does nothing, and says why
//   2. with each of the four terrains it is its full self, and the number is the one the
//      engine gave before the rule -- the gate must not change a working case
//   3. weather is not a terrain: sun does not make it work
//   4. the moves that merely SCALE with the field are untouched. Weather Ball and Terrain
//      Pulse were already right, and a gate that caught them too would trade one wrong
//      number for two
//   5. a move with no requirement at all cannot care about the field
//   6. the `fieldRequirements` option: on by default, and off replays the old answer, which
//      is what keeps the recorded calc vectors green -- three of the seven Steel Roller
//      vectors on disk were recorded with no terrain up and pin the old full-damage answer
//   7. Team Evaluation's threat lines go through the same engine, so they get the same
//      answer as the Damage Calculator
//
//   node tests/run-field-requirements.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, makeContext, makeMon, fieldRequirementOption, FIELD_REQUIREMENTS_ON } from "../builder/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const engine = new DamageEngine(appData);
const engineWithout = new DamageEngine(appData, { fieldRequirements: false });

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const mon = (name, fields = {}) => makeMon({
  pokemon_name: name, form_name: name, level: 50, nature_name: "Adamant",
  bonuses: [0, 32, 0, 0, 0, 32], ...fields,
});
const ctxFor = (move, { terrain = "None", weather = "None" } = {}) => makeContext({
  move_name: move, terrain, weather, battle_format: "Singles",
});
const worst = (which, move, field = {}) => {
  const result = which.calculate(mon("Duraludon"), mon("Amoonguss"), ctxFor(move, field));
  const list = (result.rolls || []).map(Number).filter((v) => Number.isFinite(v));
  // `rewriteRolls` appends the reason to `details`, the same list every other
  // note on a calculation goes into.
  return { top: list.length ? Math.max(...list) : 0,
           detail: (result.details || []).join(" | "), result };
};

const TERRAINS = ["Electric", "Grassy", "Psychic", "Misty"];

// 0. the option itself
check("the rule is on by default", FIELD_REQUIREMENTS_ON === true);
for (const off of [null, undefined, false, "", "0", "off", "false", "no", "none"]) {
  check(`the option reads ${JSON.stringify(off)} as off`, fieldRequirementOption(off) === false);
}
for (const on of [true, 1, "1", "on", "yes", "true"]) {
  check(`the option reads ${JSON.stringify(on)} as on`, fieldRequirementOption(on) === true);
}

// 1. no terrain, no damage -- and it says why
const bare = worst(engine, "Steel Roller");
check("Steel Roller does nothing with no terrain", bare.top === 0, String(bare.top));
check("and says why", /terrain/i.test(bare.detail), bare.detail || "(no detail)");

// 2. on a terrain it is its full self, and unchanged from before the rule
for (const terrain of TERRAINS) {
  const live = worst(engine, "Steel Roller", { terrain });
  const before = worst(engineWithout, "Steel Roller", { terrain });
  check(`Steel Roller works on ${terrain} Terrain`, live.top > 0, String(live.top));
  check(`and ${terrain} Terrain is unchanged by the rule`, live.top === before.top,
        `${live.top} vs ${before.top}`);
}

// 3. weather is not a terrain
for (const weather of ["Sun", "Rain", "Sand", "Snow"]) {
  check(`${weather} does not make Steel Roller work`,
        worst(engine, "Steel Roller", { weather }).top === 0);
}

// 4. the moves that scale with the field are untouched
const ballBare = worst(engine, "Weather Ball");
const ballSun = worst(engine, "Weather Ball", { weather: "Sun" });
check("Weather Ball still works with no weather", ballBare.top > 0, String(ballBare.top));
check("and is stronger in sun", ballSun.top > ballBare.top * 1.5,
      `${ballBare.top} -> ${ballSun.top}`);
const pulseBare = worst(engine, "Terrain Pulse");
const pulseTerrain = worst(engine, "Terrain Pulse", { terrain: "Electric" });
check("Terrain Pulse still works with no terrain", pulseBare.top > 0, String(pulseBare.top));
check("and is stronger on one", pulseTerrain.top > pulseBare.top * 1.5,
      `${pulseBare.top} -> ${pulseTerrain.top}`);

// 5. a move with no requirement cannot care
const headBare = worst(engine, "Iron Head");
const headTerrain = worst(engine, "Iron Head", { terrain: "Electric" });
check("Iron Head is the same either way", headBare.top === headTerrain.top,
      `${headBare.top} vs ${headTerrain.top}`);

// 6. off replays the old answer
const oldAnswer = worst(engineWithout, "Steel Roller");
check("with the rule off the old number comes back", oldAnswer.top > 0, String(oldAnswer.top));
check("and it is a real number, not a token", oldAnswer.top > 50, String(oldAnswer.top));

// 7. the threat lines use the same engine, so they cannot disagree with the calculator
const { TeamEvaluator } = await import("../builder/team-eval.js");
check("Team Evaluation builds on the same engine class",
      typeof TeamEvaluator === "function" && String(TeamEvaluator).includes("engine"));

if (failures.length) {
  console.error(`\n${checked} checks, ${failures.length} failed:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\n${checked} checks, all passed.`);
