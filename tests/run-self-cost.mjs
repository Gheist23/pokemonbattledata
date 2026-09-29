// What a move costs ITS OWN USER (builder/self-cost.js, the `self_cost` stamp).
//
//   node tests/run-self-cost.mjs
//
// Two owner reports, one cause: nothing shared a definition of "this move hurts the Pokemon
// that uses it".
//
//   "Fix the Recoil issue."  The engine computed recoil correctly and published it as STRINGS
//   only -- `recoil_hp_range` in the ATTACKER's HP points, beside a `max_hp` that belongs to the
//   DEFENDER -- so a scoring consumer holding a result could not turn it into a share of the
//   user's HP. Of eleven consumers only the manual Damage Calculator and the deep Optimize
//   objective charged it, and the objective re-derived the fractions itself and got Rock Head
//   wrong. Tournament Test, Team Evaluation, Suggestions, Team Building Checks, Auto Build and
//   the shallow TeamOptimizer all priced Life Orb's 1.3x and Flare Blitz's power at nothing.
//
//   "Final Gambit shows as best answer to multiple threats but it leaves out the fact that it
//   KOs itself."  The one rule that priced the class (team-eval.js V432) only fires when the
//   self-KO move needs TWO OR MORE hits. A self-KO move that lands a one-hit KO was a clean,
//   free answer everywhere.
//
// What is checked here, and why it is not in the recorded vector suites (which replay the app's
// own answers and so can only check what was recorded before the rule):
//
//   1. the stamp: production is version 1, an unstamped recording replays with the rule off,
//      and it coerces exactly as `scoreRulesOption` does, value for value;
//   2. the shared name set, against each move's OWN description in this game's data, so a name
//      can never be in the set on a hunch;
//   3. the classifier's arithmetic, including the two Abilities that are not the same Ability:
//      Rock Head cancels only the share of the damage dealt, Magic Guard cancels the block;
//   4. the engine's new NUMERIC recoil, agreeing with the strings it did not touch;
//   5. Suggestions, on the owner's own report: a Squawkabilly carrying Final Gambit measured
//      against a real team's eight worst threats, before and after;
//   6. Team Evaluation's label and matchup quality, Team Building Checks' `attackOf`, and the
//      deep Optimize objective's Rock Head;
//   7. Tournament Test: the recoil really moves a real team's average, and the two invariants
//      that may never move -- a team against itself scores exactly 50, and a pair of line-ups
//      exactly 100 together.
//
// Every "before" number is stated next to its "after", so reverting any half fails here.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, compact } from "../builder/engine.js";
import {
  SELF_COST, SELF_CRASH_MOVES, SELF_HP_COSTS, SELF_KO_MOVES, SELF_KO_MOVES_V432, SELF_MAX_HP_RECOIL,
  resultRecoilShare, selfCostOption, selfDamageFraction, selfHpFraction, selfKo, selfMaxHpFraction,
} from "../builder/self-cost.js";
import { DEFAULT_SETTINGS, SCORE_RULES, SELF_KO_NOTE, TeamEvaluator, normalizeSettings, scoreRulesOption } from "../builder/team-eval.js";
import { SELF_COST_ATTACK_RULE, TEAM_CHECK_RULES, TeamChecks } from "../builder/team-checks.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions, VERDICT_VALUE, teamGapThreats, verdictFor, verdictSentence } from "../builder/team-suggest.js";
import { TeamOptimizer } from "../builder/team-optimize.js";
import { OptimizeObjective } from "../builder/optimize-objective.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest } from "../builder/tournament-test.js";
import { makeSet } from "../builder/common.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const meta = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));
const knownRaw = JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8"));
const ranked = (meta.pokemon || []).length;

let checked = 0;
const failures = [];
const notes = [];
function ok(label, condition, detail = "") {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
}
function eq(label, got, want) {
  checked += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) failures.push(`${label}\n     got  ${a}\n     want ${b}`);
}
const near = (label, got, want, tolerance = 1e-9) => ok(label, Math.abs(Number(got) - Number(want)) <= tolerance, `${got} vs ${want}`);

function evaluatorFor(selfCost, settings = {}) {
  const ev = new TeamEvaluator(null, new DamageEngine(appData), "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS, ...settings }, ranked), { selfCost });
  ev.setMetaRecords(meta.pokemon || []);
  return ev;
}

// ------------------------------------------------------------------ 1. the stamp

ok("the rule is on by default", evaluatorFor(undefined).selfCost === SELF_COST, String(evaluatorFor(undefined).selfCost));
ok("production is version 1", SELF_COST === 1, String(SELF_COST));
ok("an unstamped recording replays with the rule off", evaluatorFor(null).selfCost === 0);
ok("a stamped recording replays with its own version", selfCostOption(1) === 1 && selfCostOption("1") === 1);
// The whole job of the option pair is to be the same coercion the other stamps use, so a
// recording's stamp cannot mean one thing to one rule and another to the next. The two differ in
// exactly one thing, on purpose: the version they fall back to is their own rule's current one.
// A value that names no version falls back, and there the two differ by their own constant.
const FALLS_BACK = new Set([true, -1, "-5", "later", "yes"]);
for (const value of [null, undefined, false, true, "", "0", "off", "false", "no", "none", 0, 1, 2, -1, "-5", "0.4", "1.9", "later", "yes"]) {
  const want = FALLS_BACK.has(value) ? SELF_COST : scoreRulesOption(value);
  ok(`selfCostOption(${JSON.stringify(value)}) coerces as scoreRulesOption does`,
    selfCostOption(value) === want, `${selfCostOption(value)} vs ${want}`);
}
eq("a version this build has never heard of is kept, so a newer recording replays as itself",
  [selfCostOption(2), selfCostOption("7")], [2, 7]);

// ----------------------------------------------- 2. the shared self-KO name set

eq("the eight names, in one place", [...SELF_KO_MOVES].sort(),
  ["explosion", "finalgambit", "grudge", "healingwish", "lunardance", "memento", "mistyexplosion", "selfdestruct"]);
eq("version 0 restores the four names team-eval.js carried", [...SELF_KO_MOVES_V432].sort(),
  ["explosion", "finalgambit", "mistyexplosion", "selfdestruct"]);
ok("the old set is a subset of the new one", [...SELF_KO_MOVES_V432].every((k) => SELF_KO_MOVES.has(k)));
// Nothing is in the set on a hunch: every name's own description in this game's data says the
// user faints. `grudge` is the one conditional wording ("If the user faints, ...") and is in the
// set deliberately -- see builder/self-cost.js.
{
  const byKey = new Map(Object.values(appData.moves || {}).map((record) => [compact(record.name), record]));
  for (const key of SELF_KO_MOVES) {
    const record = byKey.get(key);
    ok(`${key} is a move this game has`, Boolean(record));
    const text = String(record?.description || "").toLowerCase();
    ok(`${key}'s own description says the user faints`, /user faints|the user faints/.test(text), JSON.stringify(text.slice(0, 80)));
  }
}
// Final Gambit was always one of the four names: what version 0 restores is not "Final Gambit is
// harmless" but every consumer that never asked -- the answer column, Suggestions, the checks.
eq("Final Gambit is a self-KO move at both versions", [selfKo("Final Gambit", 1), selfKo("Final Gambit", 0)], [true, true]);
eq("the four names the new set adds are new at version 1 only",
  ["Memento", "Healing Wish", "Lunar Dance", "Grudge"].map((m) => [selfKo(m, 1), selfKo(m, 0)]),
  [[true, false], [true, false], [true, false], [true, false]]);
eq("spelling does not matter", [selfKo("Self-Destruct"), selfKo("selfdestruct"), selfKo("Misty Explosion")], [true, true, true]);
eq("an ordinary attack is not one", [selfKo("Brave Bird"), selfKo("Flare Blitz"), selfKo(""), selfKo(null)], [false, false, false, false]);
// The evaluator's own test is the name set plus the move table's flags, and it follows the stamp.
eq("TeamEvaluator.selfDestructs follows the stamp",
  [evaluatorFor(1).selfDestructs("Grudge"), evaluatorFor(null).selfDestructs("Grudge"),
    evaluatorFor(1).selfDestructs("Explosion"), evaluatorFor(null).selfDestructs("Explosion")],
  [true, false, true, true]);

// ---------------------------------------------- 3. the classifier's arithmetic

const record = (name) => appData.moves[name] || Object.values(appData.moves).find((r) => compact(r.name) === compact(name));
const flareBlitz = record("Flare Blitz");
const steelBeam = record("Steel Beam");
const highJumpKick = record("High Jump Kick");

near("Flare Blitz gives back a third of the damage it deals", selfDamageFraction(flareBlitz), 1 / 3);
near("Rock Head cancels that share", selfDamageFraction(flareBlitz, { rockHead: true }), 0);
near("and so does Magic Guard", selfDamageFraction(flareBlitz, { magicGuard: true }), 0);
near("a bare `recoil` flag is a third", selfDamageFraction({ name: "Made Up", flags: ["recoil"] }), 1 / 3);
near("Knock Off gives back nothing", selfDamageFraction(record("Knock Off")), 0);

near("Steel Beam costs half the user's max HP", selfMaxHpFraction(steelBeam), 1 / 2);
// The bug this closes: the deep objective treated Rock Head and Magic Guard as one Ability, so a
// Rock Head Pokemon was handed Steel Beam and Life Orb for free. The engine has it right.
near("Rock Head does NOT cancel Steel Beam", selfMaxHpFraction(steelBeam, { rockHead: true }), 1 / 2);
near("Magic Guard does", selfMaxHpFraction(steelBeam, { magicGuard: true }), 0);
near("Life Orb costs a tenth on an attack", selfMaxHpFraction(record("Knock Off"), { lifeOrb: true }), 1 / 10);
near("Rock Head does NOT cancel Life Orb", selfMaxHpFraction(record("Knock Off"), { lifeOrb: true, rockHead: true }), 1 / 10);
near("Magic Guard does", selfMaxHpFraction(record("Knock Off"), { lifeOrb: true, magicGuard: true }), 0);
near("Life Orb costs nothing on a status move", selfMaxHpFraction(record("Protect"), { lifeOrb: true }), 0);
near("High Jump Kick costs half its max HP on the tenth of the time it misses",
  selfMaxHpFraction(highJumpKick), 0.5 * (1 - 0.9));
near("with accuracies turned off it costs nothing", selfMaxHpFraction(highJumpKick, { accuracy: 1 }), 0);
near("Belly Drum costs half, and Magic Guard does not stop it", selfMaxHpFraction(record("Belly Drum"), { magicGuard: true }), 1 / 2);
near("Substitute costs a quarter", selfMaxHpFraction(record("Substitute")), 1 / 4);
near("Shed Tail costs half", selfMaxHpFraction(record("Shed Tail")), 1 / 2);
near("Struggle's quarter is unconditional", selfMaxHpFraction(record("Struggle") || { name: "Struggle" }, { magicGuard: true, rockHead: true }), 1 / 4);
near("Curse costs half on a Ghost", selfMaxHpFraction(record("Curse"), { userTypes: ["Ghost"] }), 1 / 2);
near("and nothing on anything else", selfMaxHpFraction(record("Curse"), { userTypes: ["Normal"] }), 0);
eq("the four crash moves", Object.keys(SELF_CRASH_MOVES).sort(), ["axekick", "highjumpkick", "jumpkick", "supercellslam"]);
eq("the three max-HP recoil moves", Object.keys(SELF_MAX_HP_RECOIL).sort(), ["chloroblast", "mindblown", "steelbeam"]);
ok("the outright costs name Belly Drum, Substitute, Shed Tail, Curse and Struggle",
  ["bellydrum", "substitute", "shedtail", "curse", "struggle"].every((k) => k in SELF_HP_COSTS), JSON.stringify(Object.keys(SELF_HP_COSTS)));

near("the whole cost adds the damage share to the flat one",
  selfHpFraction(flareBlitz, 0.9, { lifeOrb: true }), 1 / 10 + 0.9 / 3);
near("and a move that costs its user nothing is 0", selfHpFraction(record("Protect"), 0.9), 0);

// ---------------------------------------- 4. the engine's numeric recoil fields

{
  const ev = evaluatorFor(1);
  const mon = (species, item, ability, moves) => ({
    pokemon_name: species, form_name: species, level: 50, item, ability,
    nature_name: "Adamant", bonuses: [32, 32, 0, 0, 0, 2], moves, current_hp_percent: 100,
  });
  const target = mon("Amoonguss", "Sitrus Berry", "Regenerator", ["Spore"]);
  const calc = (species, item, ability, move) => {
    const attacker = mon(species, item, ability, [move]);
    return ev.calculate(attacker, target, ev.calcContext(attacker, target, move));
  };
  const cases = [
    ["Staraptor", "Life Orb", "Intimidate", "Brave Bird"],
    ["Aggron", "Life Orb", "Rock Head", "Double-Edge"],
    ["Aggron", "Leftovers", "Rock Head", "Steel Beam"],
    ["Magnezone", "Leftovers", "Sturdy", "Steel Beam"],
    ["Incineroar", "Life Orb", "Intimidate", "Knock Off"],
  ];
  for (const [species, item, ability, move] of cases) {
    const result = calc(species, item, ability, move);
    const label = `${species} @${item} ${ability} ${move}`;
    // The numbers agree with the strings the Damage Calculator reads, which did not move.
    const points = (String(result.recoil_hp_range || "").match(/\d+/g) || []).map(Number);
    eq(`${label}: the numeric range is the string range`, [result.recoil_hp_lo, result.recoil_hp_hi], [points[0], points[points.length - 1]]);
    ok(`${label}: the attacker's own max HP is published`, Number(result.recoil_attacker_max_hp) > 0, String(result.recoil_attacker_max_hp));
    near(`${label}: the low share is the low points over the attacker's max HP`,
      result.recoil_share_lo, result.recoil_hp_lo / result.recoil_attacker_max_hp);
    near(`${label}: the high share likewise`, result.recoil_share_hi, result.recoil_hp_hi / result.recoil_attacker_max_hp);
    ok(`${label}: the mean share sits between them`,
      result.recoil_share >= result.recoil_share_lo - 1e-12 && result.recoil_share <= result.recoil_share_hi + 1e-12,
      `${result.recoil_share_lo} <= ${result.recoil_share} <= ${result.recoil_share_hi}`);
    near(`${label}: the shared reader agrees`, resultRecoilShare(result), result.recoil_share);
    // The string the Damage Calculator pins is still exactly the old shape.
    ok(`${label}: recoil_percent is still a percent string`, /^\d+(\.\d+)?(-\d+(\.\d+)?)?%$/.test(String(result.recoil_percent)), String(result.recoil_percent));
    ok(`${label}: display_percent still ends in the recoil clause`, String(result.display_percent).endsWith(`(${result.recoil_text})`), String(result.display_percent));
  }
  // Rock Head, measured: the damage share is gone and Life Orb's tenth is not.
  {
    const orb = calc("Aggron", "Life Orb", "Rock Head", "Double-Edge");
    const maxHp = Number(orb.recoil_attacker_max_hp);
    eq("Rock Head keeps Life Orb's tenth and drops the damage share", orb.recoil_hp_lo, Math.floor(maxHp / 10));
    const beam = calc("Aggron", "Leftovers", "Rock Head", "Steel Beam");
    eq("Rock Head keeps Steel Beam's half", beam.recoil_hp_lo, Math.ceil(Number(beam.recoil_attacker_max_hp) / 2));
  }
  // Magic Guard, and a move with no self cost at all: no strings AND no numbers, so a consumer
  // reading the numeric fields sees exactly what a consumer reading the strings saw.
  for (const [label, result] of [
    ["Magic Guard", calc("Clefable", "Life Orb", "Magic Guard", "Double-Edge")],
    ["a plain attack", calc("Incineroar", "Leftovers", "Intimidate", "Knock Off")],
  ]) {
    ok(`${label}: no recoil string`, result.recoil_hp_range === undefined && result.recoil_percent === undefined);
    ok(`${label}: and no recoil number`, result.recoil_hp_lo === undefined && result.recoil_share === undefined);
    near(`${label}: the shared reader says zero`, resultRecoilShare(result), 0);
  }
}

// ------------------------------------------------ 5. Suggestions (the owner's report)

near("a trade is worth 0.15, which is what the new verdict leans on", VERDICT_VALUE.trades, 0.15);
// The grading: a self-KO move can never be graded a clean answer, whatever the hits say.
eq("a one-hit KO that faints its user is a trade, not a win",
  [verdictFor(1, 3, false, false, false), verdictFor(1, 3, false, false, true)], ["beats", "trades"]);
eq("and a wall that faints its user is a trade too",
  [verdictFor(3, 6, false, false, false), verdictFor(3, 6, false, false, true)], ["walls", "trades"]);
eq("a matchup it loses is still lost", verdictFor(3, 1, false, false, true), "loses");
eq("being outsped and removed in one hit still loses", verdictFor(1, 1, false, true, true), "loses");
eq("nothing moves when the move does not faint its user",
  [1, 2, 3, 6].flatMap((out) => [1, 2, 3, 6].flatMap((inn) => [[false, false], [true, false], [false, true]]
    .map(([a, b]) => verdictFor(out, inn, a, b)))),
  [1, 2, 3, 6].flatMap((out) => [1, 2, 3, 6].flatMap((inn) => [[false, false], [true, false], [false, true]]
    .map(([a, b]) => verdictFor(out, inn, a, b, false)))));
eq("the sentence says both halves of the trade",
  verdictSentence("Arcanine-Hisui", "trades", 1, 6, false, false, true),
  "Trades with Arcanine-Hisui: removes it in one hit, but faints doing it.");
ok("the ordinary trade sentence is untouched",
  verdictSentence("Rillaboom", "trades", 2, 2, false, true).includes("moves second"),
  verdictSentence("Rillaboom", "trades", 2, 2, false, true));

// `isRealAnswer` itself, which is the one line the rest of the site reads: threatMatchup's
// `loses`, typeFit's V494 strike-back and losesToThreat all ask it, and Auto Build reads
// those, so nothing else here covers it -- deleting its self-KO line left every other check
// in this file green. Asked directly, at both versions, so the line cannot go missing again.
{
  const sgOn = new TeamSuggestions(new TeamEvaluation(evaluatorFor(1)));
  const sgOff = new TeamSuggestions(new TeamEvaluation(evaluatorFor(null)));
  // A guaranteed one-hit KO from the faster side against a threat that needs three: the
  // cleanest "yes" the rule has, so the only thing deciding it is the move's own cost.
  const incoming = { hits: 3, chance: 1, move: "Moonblast", attacker_speed: 100 };
  const gambit = { hits: 1, chance: 1, move: "Final Gambit", attacker_speed: 200 };
  const braveBird = { hits: 1, chance: 1, move: "Brave Bird", attacker_speed: 200 };
  eq("isRealAnswer: before the rule a Final Gambit one-hit KO was a real answer",
    sgOff.isRealAnswer(incoming, gambit), true);
  eq("isRealAnswer: with the rule it is not", sgOn.isRealAnswer(incoming, gambit), false);
  eq("isRealAnswer: a move that does NOT faint its user is untouched at both versions",
    [sgOff.isRealAnswer(incoming, braveBird), sgOn.isRealAnswer(incoming, braveBird)], [true, true]);
  // Every name in the shared set, not just Final Gambit, and only under version 1.
  const byName = (sg) => [...SELF_KO_MOVES].filter((name) => sg.isRealAnswer(incoming, { ...gambit, move: name }));
  eq("isRealAnswer: with the rule not one of the eight self-KO moves is an answer", byName(sgOn), []);
  eq("isRealAnswer: with it off all eight still are", byName(sgOff).length, SELF_KO_MOVES.size);
  eq("outgoingSelfKo is the question it asks, and it is off at version 0",
    [sgOn.outgoingSelfKo(gambit), sgOff.outgoingSelfKo(gambit), sgOn.outgoingSelfKo(braveBird)], [true, false, false]);
}

// The report itself, measured. The team is the one the Suggestions complaint was first made
// about (tests/run-suggest-scoring.mjs's TEAM), and the candidate is the Squawkabilly the pool
// really offers, carrying the Final Gambit the meta data gives it.
const REPORT_TEAM = [
  { species: "Indeedee", form: "Indeedee Female", item: "Psychic Seed", ability: "Psychic Surge", nature: "Relaxed", moves: ["Follow Me", "Trick Room", "Helping Hand", "Psychic"], bonuses: [32, 0, 32, 0, 2, 0] },
  { species: "Hatterene", form: "Hatterene", item: "Life Orb", ability: "Magic Bounce", nature: "Quiet", moves: ["Expanding Force", "Dazzling Gleam", "Trick Room", "Protect"], bonuses: [32, 0, 2, 32, 0, 0] },
  { species: "Incineroar", form: "Incineroar", item: "Assault Vest", ability: "Intimidate", nature: "Careful", moves: ["Fake Out", "Knock Off", "Flare Blitz", "U-turn"], bonuses: [32, 0, 2, 0, 32, 0] },
  { species: "Gholdengo", form: "Gholdengo", item: "Choice Specs", ability: "Good as Gold", nature: "Quiet", moves: ["Make It Rain", "Shadow Ball", "Power Gem", "Trick"], bonuses: [32, 0, 2, 32, 0, 0] },
];
function gambitRows(selfCost) {
  const ev = evaluatorFor(selfCost);
  const evaluation = new TeamEvaluation(ev);
  evaluation.knownTeams = new KnownTeams(knownRaw);
  const sets = Array.from({ length: 6 }, (_, i) => (REPORT_TEAM[i] ? makeSet(REPORT_TEAM[i]) : null));
  const payload = evaluation.evaluate(sets, { checkSelection: null });
  const sg = new TeamSuggestions(evaluation);
  const teamSlots = (payload.slots || []).map(({ entry, mon }) => ({ entry: { ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }, mon }));
  const teamEntries = teamSlots.map(({ entry }) => entry);
  const activeNames = teamSlots.map(({ entry, mon }) => sg.name(mon.form_name || entry.form || entry.pokemon));
  const context = { payload, teamSlots, teamEntries, activeNames, emptySlot: teamSlots.length, selection: null, selected: sg.checks.selectedIds(null), swapTarget: "" };
  const rows = [];
  for (const candidate of sg.candidates(payload, activeNames)) {
    const row = sg.evaluateCandidate(structuredClone(candidate), context);
    if (row && (row.moves || []).some((move) => compact(move) === "finalgambit")) rows.push(row);
  }
  const threats = (payload.threats || []).filter((t) => t && typeof t === "object")
    .map((t, i) => [t, i]).sort((a, b) => (Number(b[0].score) || 0) - (Number(a[0].score) || 0) || a[1] - b[1])
    .map(([t]) => t).slice(0, 8);
  const totalWeight = threats.reduce((sum, t) => sum + Math.max(1, Number(t.score) || 40), 0) || 1;
  const gaps = teamGapThreats(threats);
  for (const row of rows) sg.scoreOnCalcs(row, threats, totalWeight, gaps);
  return { rows, threats };
}
{
  const before = gambitRows(null);
  const after = gambitRows(1);
  ok("the pool really offers a Final Gambit carrier on this team", before.rows.length > 0 && after.rows.length === before.rows.length,
    `${before.rows.length} vs ${after.rows.length}`);
  ok("and the team's eight worst threats are the same either way",
    JSON.stringify(before.threats.map((t) => t.name)) === JSON.stringify(after.threats.map((t) => t.name)));
  const clean = (row) => (row.threat_verdicts_v511 || []).filter((e) => e.verdict === "beats" || e.verdict === "walls").length;
  const trades = (row) => (row.threat_verdicts_v511 || []).filter((e) => e.verdict === "trades" && e.out_self_ko).length;
  for (let i = 0; i < after.rows.length; i += 1) {
    const b = before.rows[i];
    const a = after.rows[i];
    const label = String(a.name);
    ok(`${label} was offered as a clean answer to most of the eight before the rule`, clean(b) >= 5, `${clean(b)} of 8`);
    ok(`${label} is not any more`, clean(a) < clean(b), `${clean(b)} -> ${clean(a)}`);
    ok(`${label}'s Final Gambit answers became trades`, trades(a) >= 5 && trades(b) === 0, `before ${trades(b)}, after ${trades(a)}`);
    ok(`${label} scores lower for it`, Number(a.score) < Number(b.score) - 1, `${b.score} -> ${a.score}`);
    ok(`${label} answers a smaller share of the threats`, Number(a.answered_share_v511) < Number(b.answered_share_v511),
      `${b.answered_share_v511} -> ${a.answered_share_v511}`);
    const sentence = (a.threat_verdicts_v511 || []).find((e) => e.out_self_ko)?.sentence || "";
    ok(`${label} says why in plain words`, /but faints doing it\.$/.test(sentence), sentence);
    notes.push(`   ${label}: clean answers ${clean(b)}/8 -> ${clean(a)}/8, ${trades(a)} trades, score ${b.score} -> ${a.score}, answered share ${b.answered_share_v511} -> ${a.answered_share_v511}`);
  }
}

// ------------------------------- 6. Team Evaluation, Team Checks, Optimize

// The label: a self-KO move that DOES remove the threat in one hit keeps its KO, because it
// really does remove it, but it stops pretending the exchange was free. The note is APPENDED,
// so "Guaranteed OHKO" still reads out of it.
{
  const on = evaluatorFor(1);
  const off = evaluatorFor(null);
  const attacker = { ...on.commonMon("Staraptor", "Staraptor"), item: "Focus Sash", analysis_side: "my" };
  const defender = { ...on.commonMon("Gardevoir", "Gardevoir"), analysis_side: "threat" };
  const moves = ["Final Gambit", "Brave Bird"];
  const b = off.bestV432({ ...attacker }, { ...defender }, moves);
  const a = on.bestV432({ ...attacker }, { ...defender }, moves);
  ok("Staraptor's best move into Gardevoir is Final Gambit", b.move === "Final Gambit" && a.move === "Final Gambit", `${b.move} / ${a.move}`);
  eq("before the rule the label said nothing about the cost", [b.label, b.self_ko_move_v432], ["Guaranteed OHKO", undefined]);
  eq("after it, the same KO says who faints", [a.label, a.self_ko_move_v432], [`Guaranteed OHKO${SELF_KO_NOTE}`, true]);
  ok("and the hits still read 1 out of the label", /\bOHKO\b/.test(String(a.label)) && Number(a.hits) === 1, `${a.label} / ${a.hits}`);
  eq("the note is added once, not twice", String(a.full_label).split(SELF_KO_NOTE).length - 1, 1);
  // The matchup quality: a trade may not rank above an even matchup. `incoming` is a threat that
  // needs three hits, which before the rule made this a +300 matchup.
  const incoming = { hits: 3, chance: 1, move: "Moonblast", attacker_speed: 1 };
  ok("before the rule a self-KO OHKO was the best matchup there is", off.matchupQuality({ ...b, attacker_speed: 2 }, incoming) > 0,
    String(off.matchupQuality({ ...b, attacker_speed: 2 }, incoming)));
  ok("after it, it cannot rank above an even matchup", on.matchupQuality({ ...a, attacker_speed: 2 }, incoming) <= 0,
    String(on.matchupQuality({ ...a, attacker_speed: 2 }, incoming)));
  ok("an ordinary OHKO is untouched",
    on.matchupQuality({ hits: 1, chance: 1, move: "Brave Bird", attacker_speed: 2 }, incoming)
    === off.matchupQuality({ hits: 1, chance: 1, move: "Brave Bird", attacker_speed: 2 }, incoming));
}

// Team Building Checks: `attackOf` under the existing `team_checks` stamp, at version 3.
{
  ok("the team_checks stamp is at the self-cost version", TEAM_CHECK_RULES === SELF_COST_ATTACK_RULE && SELF_COST_ATTACK_RULE === 3,
    `${TEAM_CHECK_RULES} / ${SELF_COST_ATTACK_RULE}`);
  const member = { entry: { pokemon: "Staraptor", form: "Staraptor", item: "Focus Sash", ability: "Intimidate", moves: ["Final Gambit", "Seismic Toss", "Protect", "Tailwind"] } };
  const profileAt = (rules) => {
    const ev = evaluatorFor(1);
    const checks = new TeamChecks({ engine: ev.engine, format: "Doubles", checkRules: rules, settings: { top_meta: 10 }, simpleMoveInfo: (move) => ev.simpleMoveInfo(move), metaPressureRecords: () => (meta.pokemon || []).slice(0, 10), typesFor: (mon) => ev.typesFor(mon), statsFor: (mon) => ev.statsFor(mon), showdownName: (name) => String(name) });
    const mon = ev.teamMon({ species: member.entry.pokemon, form: member.entry.form, item: member.entry.item, ability: member.entry.ability, moves: member.entry.moves }, 0);
    return checks.profiles([{ entry: member.entry, mon }])[0];
  };
  const oldRule = profileAt(1);
  const newRule = profileAt(3);
  eq("before the rule a 1-power placeholder was the team's best power", oldRule._v514_best_power, 1);
  eq("after it, a self-KO move and a 1-power record are not attacks at all", newRule._v514_best_power, 0);
  ok("and no attacking type is lost, because coverage is the union with damaging_types",
    (newRule._v514_coverage_types || []).length >= (oldRule._v514_coverage_types || []).length - 0
    && (oldRule._v514_coverage_types || []).every((t) => (newRule._v514_coverage_types || []).includes(t)),
    `${JSON.stringify(oldRule._v514_coverage_types)} -> ${JSON.stringify(newRule._v514_coverage_types)}`);
  // A real attack is still an attack, at either version.
  const real = { entry: { pokemon: "Staraptor", form: "Staraptor", item: "Life Orb", ability: "Intimidate", moves: ["Brave Bird", "Close Combat", "U-turn", "Protect"] } };
  const bestOf = (rules) => {
    const ev = evaluatorFor(1);
    const checks = new TeamChecks({ engine: ev.engine, format: "Doubles", checkRules: rules, settings: { top_meta: 10 }, simpleMoveInfo: (move) => ev.simpleMoveInfo(move), metaPressureRecords: () => (meta.pokemon || []).slice(0, 10), typesFor: (mon) => ev.typesFor(mon), statsFor: (mon) => ev.statsFor(mon), showdownName: (name) => String(name) });
    const mon = ev.teamMon({ species: real.entry.pokemon, form: real.entry.form, item: real.entry.item, ability: real.entry.ability, moves: real.entry.moves }, 0);
    return checks.profiles([{ entry: real.entry, mon }])[0]._v514_best_power;
  };
  eq("Brave Bird is the same attack at both versions", [bestOf(1), bestOf(3)], [bestOf(1), bestOf(1)]);
  ok("and it is a real base power", bestOf(3) >= 100, String(bestOf(3)));
}

// The deep Optimize objective: Rock Head is not Magic Guard.
{
  const TEAM = [
    { species: "Aggron", form: "Mega Aggron", item: "Aggronite", ability: "Filter", nature: "Adamant", moves: ["Heavy Slam", "Double-Edge", "Stomping Tantrum", "Protect"], bonuses: [32, 32, 0, 0, 0, 2] },
    { species: "Incineroar", form: "Incineroar", item: "Assault Vest", ability: "Intimidate", nature: "Careful", moves: ["Fake Out", "Knock Off", "Flare Blitz", "U-turn"], bonuses: [32, 0, 2, 0, 32, 0] },
  ];
  const objectiveFor = (selfCost, ability, item) => {
    const ev = evaluatorFor(selfCost);
    const evaluation = new TeamEvaluation(ev);
    evaluation.knownTeams = new KnownTeams(knownRaw);
    const sets = [makeSet({ ...TEAM[0], form: "Aggron", item, ability }), makeSet(TEAM[1])];
    return new OptimizeObjective(new TeamOptimizer(evaluation), sets, 0, { topX: 6 });
  };
  const rockHeadOrb = objectiveFor(1, "Rock Head", "Life Orb");
  const rockHeadOrbOld = objectiveFor(null, "Rock Head", "Life Orb");
  ok("before the rule Rock Head cancelled Life Orb", rockHeadOrbOld.lifeOrb === false);
  ok("after it, Rock Head pays Life Orb", rockHeadOrb.lifeOrb === true);
  ok("Magic Guard still does not", objectiveFor(1, "Magic Guard", "Life Orb").lifeOrb === false);
  const beam = record("Steel Beam");
  near("before the rule Rock Head cancelled Steel Beam's half", rockHeadOrbOld.recoilOf(beam, { rolls: [1] }).recoilMaxHp, 0);
  near("after it, it does not", rockHeadOrb.recoilOf(beam, { rolls: [1] }).recoilMaxHp, 1 / 2);
  near("and Magic Guard still cancels it", objectiveFor(1, "Magic Guard", "Leftovers").recoilOf(beam, { rolls: [1] }).recoilMaxHp, 0);
  // The crash moves: the engine cannot model a miss, so nothing charged the half a miss costs.
  const crash = record("High Jump Kick");
  const missRaw = { rolls: [1], move_accuracy_factor: 0.9 };
  near("before the rule a High Jump Kick miss was free", rockHeadOrbOld.recoilOf(crash, missRaw).recoilMaxHp, 0);
  near("after it, it costs half the user's max HP a tenth of the time", rockHeadOrb.recoilOf(crash, missRaw).recoilMaxHp, 0.5 * (1 - 0.9));
  near("with accuracies off it is free again", rockHeadOrb.recoilOf(crash, { rolls: [1], move_accuracy_factor: 1 }).recoilMaxHp, 0);
  // The self-KO turn: survive is 0 and the race is capped at what a tie is worth.
  const selfKoObjective = objectiveFor(1, "Sturdy", "Focus Sash");
  const oldObjective = objectiveFor(null, "Sturdy", "Focus Sash");
  const moveSet = (objective) => objective.moveSet(["Explosion", "Heavy Slam", "Stomping Tantrum", "Protect"]);
  const scoreOf = (objective) => objective.score("Adamant", [32, 32, 0, 0, 0, 2], moveSet(objective));
  const withRule = scoreOf(selfKoObjective);
  const withoutRule = scoreOf(oldObjective);
  ok("an Explosion set scores lower once the turn is priced as a trade", withRule < withoutRule,
    `${withoutRule} -> ${withRule}`);
  notes.push(`   deep Optimize, an Explosion set: ${withoutRule.toFixed(3)} -> ${withRule.toFixed(3)}`);
}

// --------------------------------------------------- 7. Tournament Test

{
  // Three Life Orbs and three recoil moves: the shape the recoil report is about.
  const RECOIL_TEAM = [
    { species: "Staraptor", item: "Life Orb", ability: "Intimidate", nature: "Jolly", moves: ["Brave Bird", "Close Combat", "U-turn", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
    { species: "Incineroar", item: "Life Orb", ability: "Intimidate", nature: "Adamant", moves: ["Flare Blitz", "Knock Off", "Fake Out", "Parting Shot"], bonuses: [32, 32, 0, 0, 2, 0] },
    { species: "Rillaboom", item: "Life Orb", ability: "Grassy Surge", nature: "Adamant", moves: ["Wood Hammer", "Grassy Glide", "Fake Out", "U-turn"], bonuses: [32, 32, 0, 0, 0, 2] },
    { species: "Whimsicott", item: "Focus Sash", ability: "Prankster", nature: "Timid", moves: ["Tailwind", "Moonblast", "Encore", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Gholdengo", item: "Choice Specs", ability: "Good as Gold", nature: "Modest", moves: ["Make It Rain", "Shadow Ball", "Power Gem", "Trick"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Milotic", item: "Leftovers", ability: "Competitive", nature: "Calm", moves: ["Scald", "Icy Wind", "Recover", "Protect"], bonuses: [32, 0, 0, 2, 32, 0] },
  ];
  const testFor = (selfCost) => {
    const ev = evaluatorFor(selfCost);
    const evaluation = new TeamEvaluation(ev);
    return new TournamentTest(evaluation, new KnownTeams(knownRaw), new TeamSuggestions(evaluation));
  };
  const sets = RECOIL_TEAM.map((entry) => makeSet(entry));
  const runFor = async (selfCost) => (await testFor(selfCost).run(sets.map((set) => ({ ...set })), { limit: 24 })).average;
  const before = await runFor(null);
  const after = await runFor(1);
  ok("charging a Life Orb / recoil team its own cost really moves its average", after < before - 0.5,
    `${Number(before).toFixed(2)} -> ${Number(after).toFixed(2)}`);
  notes.push(`   Tournament Test, a three-Life-Orb team over 24 opponents: ${Number(before).toFixed(2)} -> ${Number(after).toFixed(2)}`);

  // The invariants. Both sides are built the way the page builds them -- ours through `ourUnit`,
  // theirs through `opponentMon` -- so the two seats hold the same Pokemon by different routes.
  const test = testFor(1);
  const setFor = (m) => {
    const usage = test.usageStem.get(`${compact(m.species)}|${compact(m.form)}`) || m.species;
    const spread = test.suggestions.spreadForNature(usage, m.nature || "") || test.suggestions.spreadForNature(m.species, m.nature || "");
    return makeSet({
      species: m.species, form: m.form || m.species, item: m.item || "", ability: m.ability || "",
      nature: m.nature || spread?.nature_name || "Serious", bonuses: [...(spread?.bonuses || [0, 0, 0, 0, 0, 0])],
      moves: (m.moves || []).slice(0, 4),
    });
  };
  const seats = (team) => ({
    name: team.name,
    ourPlans: test.plansFor(team.members.map((m, i) => test.ourUnit(setFor(m), i))),
    theirPlans: test.plansFor(team.members.map((m) => test.opponentMon(m))),
  });
  const teams = test.teams(6).map(seats);
  let mirrors = 0;
  let offFifty = 0;
  let swaps = 0;
  let offHundred = 0;
  for (const team of teams) {
    for (let i = 0; i < team.ourPlans.length; i += 1) {
      const value = test.play(team.ourPlans[i], team.theirPlans[i], null).value;
      mirrors += 1;
      if (value !== 50) offFifty += 1;
    }
  }
  for (let a = 0; a < teams.length; a += 1) {
    for (let b = 0; b < teams.length; b += 1) {
      if (a === b) continue;
      const one = test.play(teams[a].ourPlans[0], teams[b].theirPlans[0], null).value;
      const other = test.play(teams[b].ourPlans[0], teams[a].theirPlans[0], null).value;
      swaps += 1;
      if (Math.abs(one + other - 100) > 1e-9) offHundred += 1;
    }
  }
  ok("a team against itself still scores exactly 50, with recoil charged", offFifty === 0 && mirrors > 0, `${offFifty} of ${mirrors} off 50`);
  ok("and a pair of line-ups still exactly 100 together", offHundred === 0 && swaps > 0, `${offHundred} of ${swaps} off 100`);
  notes.push(`   Tournament Test invariants with recoil charged: ${mirrors} mirrors all exactly 50, ${swaps} seat swaps all exactly 100`);
}

// ------------------------------------------------------------------------- report

for (const note of notes) console.log(note);
if (failures.length) {
  console.error(`FAIL ${failures.length}/${checked}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`${checked} checked, 0 failed.`);
console.log("OK: a move's cost to its own user is priced everywhere, and version 0 still prices it nowhere.");
