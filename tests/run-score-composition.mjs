// The V512 scoring rule (the app's `score_composition_v512`), on both halves:
//
//   node tests/run-score-composition.mjs
//
//   1. A Trick Room team's Speed score is Trick Room, Opposing Speed Control and Standard
//      Speed weighted, not the measured Trick Room number on its own (builder/team-speed.js).
//   2. Offense and Defense are each their own measurement at full weight, instead of 70% of
//      it plus 30% of the Critical Threat answer / safety shown beside them
//      (builder/team-eval.js `pressureOverview`).
//
// Both halves are checked on the app's own recorded Trick Room team (tests/eval-vectors-
// scoring.json, `trickroom` = Indeedee-F / Hatterene / Incineroar / Gholdengo, Top 20), run
// twice through the same evaluator: once with `scoreRules: 1` and once with `scoreRules: null`,
// which is how a recording made before the rule replays. The "before" numbers are stated next
// to the "after" ones, so reverting either half fails here.
//
// The words are checked too: `pressureFormula` and `speedParts` (builder/evaluation-view.js)
// are what the dialogs render, and neither may describe a score it no longer computes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, terrainSeedOption } from "../builder/engine.js";
import { DEFAULT_SETTINGS, SCORE_RULES, TeamEvaluator, normalizeSettings, scoreRulesOption } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TRICK_ROOM_WEIGHTS } from "../builder/team-speed.js";
import { KnownTeams } from "../builder/known-teams.js";
import { pressureFormula, speedParts } from "../builder/evaluation-view.js";
import { pokemonRecord } from "../tools/builder-meta.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const failures = [];
let total = 0;

function check(label, condition, detail = "") {
  total += 1;
  if (!condition) failures.push(`${label}${detail ? `\n    ${detail}` : ""}`);
}
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) <= tol * Math.max(1, Math.abs(Number(a)));

// --- 1. the option and the defaults -------------------------------------------------------
// An evaluator built the way production builds it - no option - runs with the rule on; the
// option itself reads a recording's stamp, where "absent" means "recorded before the rule".
check("the rule is on by default",
  new TeamEvaluator(null, new DamageEngine({}), "Doubles", {}).scoreRules === SCORE_RULES);
check("an unstamped recording replays with the rule off",
  scoreRulesOption(null) === 0 && scoreRulesOption(undefined) === 0 && scoreRulesOption("0") === 0 && scoreRulesOption("off") === 0);
check("a stamped recording replays with its own version", scoreRulesOption(1) === 1);
check("Team Evaluation scores against the Top 30 by default", DEFAULT_SETTINGS.top_meta === 30, `got ${DEFAULT_SETTINGS.top_meta}`);
check("settings with no Top X fall back to 30", normalizeSettings({}).top_meta === 30, `got ${normalizeSettings({}).top_meta}`);
check("a saved Top X is kept", normalizeSettings({ top_meta: 12 }).top_meta === 12);
check("the Trick Room weights lead on Trick Room and sum to 1",
  TRICK_ROOM_WEIGHTS[0] === 0.46 && TRICK_ROOM_WEIGHTS[1] === 0.27 && TRICK_ROOM_WEIGHTS[2] === 0.27,
  JSON.stringify(TRICK_ROOM_WEIGHTS));

// --- 2. the recorded Trick Room team, with the rule on and off ----------------------------
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const siteMeta = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));
const knownTeams = new KnownTeams(JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8")));
const aliases = appData.usageAliases || {};
const cases = JSON.parse(readFileSync(join(here, "eval-vectors-scoring.json"), "utf8"));

function evaluate(testCase, scoreRules) {
  const engine = new DamageEngine(appData);
  engine.terrainSeeds = terrainSeedOption(testCase.record?.rules?.terrain_seeds ?? null);
  const records = new Map();
  for (const row of testCase.record.meta[0]?.rows || []) {
    const stem = String(row.pokemon || row.base_name || row.name);
    if (!records.has(stem) && (row.rows || []).length) records.set(stem, pokemonRecord(stem, row.rows, aliases));
  }
  for (const record of siteMeta.pokemon) if (!records.has(record.name)) records.set(record.name, record);
  const evaluator = new TeamEvaluator(null, engine, "Doubles", testCase.settings, {
    pairedSpreads: testCase.record?.rules?.paired_spreads ?? null,
    scoreRules,
  });
  evaluator.setMetaRecords([...records.values()]);
  const evaluation = new TeamEvaluation(evaluator);
  evaluation.knownTeams = knownTeams;
  const recordedMons = testCase.record.team_mons.at(-1)?.mons || [];
  const sets = (testCase.extra?.simple_profiles || []).map((profile, i) => {
    const [species, item, form, ability, moves] = profile.entry;
    const source = recordedMons[i] || {};
    return { species, item, form, ability, moves, nature: source.nature_name, bonuses: source.bonuses };
  });
  return evaluation.evaluate(sets, { checkSelection: testCase.extra?.selected_checks });
}

const room = cases.find((entry) => entry.name === "trickroom");
if (!room) failures.push("eval-vectors-scoring.json no longer carries the `trickroom` recording");
else {
  const on = evaluate(room, 1);
  const off = evaluate(room, null);

  // --- the Speed score ---------------------------------------------------------------
  check("the team is still scored as a Trick Room archetype", on.speed.archetype_speed_mode_v465 === "trick_room");
  for (const part of ["standard", "opposing_tailwind", "trick_room"]) {
    check(`Speed keeps its ${part} part`, Number(on.speed[part]) > 0, `${part} = ${on.speed[part]}`);
  }
  check("Standard Speed keeps the general path's lines", (on.speed.standard_lines || []).length > 0);
  check("Opposing Speed Control keeps the general path's lines", (on.speed.tailwind_lines || []).length > 0);
  check("Trick Room shows the measured matchups", (on.speed.trick_lines || []).length > 0);
  // Before V512 all three of those were 0 with empty line lists.
  check("before the rule, the other two parts were zero with no lines",
    off.speed.standard === 0 && off.speed.opposing_tailwind === 0
    && (off.speed.standard_lines || []).length === 0 && (off.speed.tailwind_lines || []).length === 0);
  check("the Trick Room component is unchanged by the rule",
    near(on.speed.trick_room, off.speed.trick_room), `${on.speed.trick_room} vs ${off.speed.trick_room}`);

  // The score is the three parts weighted, then scaled by active slots / 6 (v47).
  const factor = Math.min(1, (room.extra?.simple_profiles || []).length / 6);
  const [trW, twW, stdW] = TRICK_ROOM_WEIGHTS;
  const want = (on.speed.trick_room * trW + on.speed.opposing_tailwind * twW + on.speed.standard * stdW) * factor;
  check("the Speed score is the three parts weighted", near(on.speed.score, want),
    `web ${on.speed.score} | trick_room*${trW} + opposing*${twW} + standard*${stdW} scaled = ${want}`);
  check("the Speed score is no longer the Trick Room number alone",
    !near(on.speed.score, off.speed.score), `${on.speed.score} vs ${off.speed.score}`);
  check("a real Trick Room team still scores above what the general path alone would give it",
    on.speed.score > (on.speed.standard * 0.46 + on.speed.opposing_tailwind * 0.27 + on.speed.trick_room * 0.27) * factor - 1e-9,
    `${on.speed.score}`);
  // The app's own numbers for this recording (Top 20): 47.50 before, 36.10 after.
  check("the recorded Trick Room team scores what the app scores it", near(on.speed.score, room.payload.speed.score),
    `web ${on.speed.score} | app ${room.payload.speed.score}`);

  // --- Offense and Defense -----------------------------------------------------------
  const ovOn = on.pressure_overview_v188;
  const ovOff = off.pressure_overview_v188;
  check("Offense is the team's pressure at full weight", near(on.offense_score, ovOn.team_to_meta.score),
    `${on.offense_score} vs ${ovOn.team_to_meta.score}`);
  check("Defense is the pressure resistance at full weight", near(on.defense_score, ovOn.defense_pressure_resistance),
    `${on.defense_score} vs ${ovOn.defense_pressure_resistance}`);
  check("the weights say so", ovOn.pressure_weight === 1 && ovOn.critical_weight === 0 && ovOn.score_rule_v512 === 1);
  check("before the rule, Offense borrowed 30% from the critical answer",
    near(ovOff.offense_score, ovOff.team_to_meta.score * 0.7 + ovOff.critical.answer_score * 0.3)
    && !near(ovOff.offense_score, on.offense_score),
    `${ovOff.offense_score} vs ${on.offense_score}`);
  check("before the rule, Defense borrowed 30% from critical safety",
    near(ovOff.defense_score, ovOff.defense_pressure_resistance * 0.7 + ovOff.critical.safety_score * 0.3)
    && !near(ovOff.defense_score, on.defense_score),
    `${ovOff.defense_score} vs ${on.defense_score}`);
  // The information itself is kept, exactly where it is shown.
  check("the Critical Threat numbers are still reported in full",
    Number(ovOn.critical.answer_score) > 0 && Number(ovOn.critical.safety_score) > 0
    && ovOn.critical.count === ovOff.critical.count
    && (ovOn.critical.critical_rows || []).length === (ovOff.critical.critical_rows || []).length
    && near(ovOn.critical.answer_score, ovOff.critical.answer_score)
    && near(ovOn.critical.safety_score, ovOff.critical.safety_score));
  check("Offense and Defense match what the app recorded",
    near(on.offense_score, room.payload.offense_score) && near(on.defense_score, room.payload.defense_score),
    `web ${on.offense_score}/${on.defense_score} | app ${room.payload.offense_score}/${room.payload.defense_score}`);

  // --- the words ---------------------------------------------------------------------
  for (const which of ["offense", "defense"]) {
    const text = pressureFormula(on, which);
    check(`the ${which} formula no longer claims a 70/30 split`, !/70%|30%/.test(text), text);
    check(`the ${which} formula still names the critical-threat number`, /critical/i.test(text), text);
    check(`a payload recorded before the rule is still described as 70/30`, /70%/.test(pressureFormula(off, which)));
  }
  const partsOn = speedParts(on.speed).map((p) => p.label);
  check("Speed Control shows all three parts for a Trick Room team",
    JSON.stringify(partsOn) === JSON.stringify(["Trick Room", "Opposing Speed Control", "Standard Speed"]), JSON.stringify(partsOn));
  const partsOff = speedParts(off.speed).map((p) => p.label);
  check("a payload recorded before the rule still shows Trick Room alone",
    JSON.stringify(partsOff) === JSON.stringify(["Trick Room"]), JSON.stringify(partsOff));
}

// A normal-Speed team is untouched by the Speed half of the rule.
const fast = cases.find((entry) => entry.name === "sun");
if (fast) {
  const on = evaluate(fast, 1);
  const off = evaluate(fast, null);
  check("a normal-Speed team's Speed score is unchanged by the rule", near(on.speed.score, off.speed.score),
    `${on.speed.score} vs ${off.speed.score}`);
  check("a normal-Speed team still shows Standard Speed first",
    speedParts(on.speed)[0].label === "Standard Speed");
  check("a normal-Speed team's Offense drops the borrowed 30%", !near(on.offense_score, off.offense_score),
    `${on.offense_score} vs ${off.offense_score}`);
}

for (const failure of failures) console.log(failure);
console.log(`\n${total} checked, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
