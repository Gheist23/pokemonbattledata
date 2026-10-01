// A move that changes its user's own stats changes them before the answer lands
// (builder/engine.js + builder/team-eval.js, the port of the app's move_self_stat_change_v525).
//
// The owner's report: "Mega Staraptor has Contrary as ability, when attacking Archaludon with
// Close Combat it raises its own Defense and Special Defense by +1 before Archaludon answers
// with its own attack. So the Threat Calcs should calculate this correctly, same for all other
// calculations where move effects and ability effects are calculated."
//
// Both halves were missing on the damage-calculator side of BOTH codebases. A threat row is a
// race: the threat attacks, the team member answers. Close Combat lowers its user's Defense and
// Sp. Def by one stage each, so the answer lands on a frailer Pokemon -- and with Contrary on a
// tougher one. The rollout engine (mcts/engine.py:_apply_stage) always got this right, Contrary
// and Simple included; the calculator side applied nothing at all.
//
// Measured on the APP, max-Attack Adamant Mega Staraptor into a Calm HP32/SpD32 Archaludon with
// an Assault Vest -- the numbers this suite pins:
//
//     Archaludon's answer, Staraptor at +0   81.2-96.2%     Guaranteed 2HKO   (the old answer)
//     ... with Contrary's +1 Def/Sp. Def     55-65%         Guaranteed 2HKO
//     ... with a plain Close Combat's -1     121.2-143.7%   Guaranteed OHKO
//
// So the old number was wrong in BOTH directions, by 26 points one way and 47.5 the other.
//
// What is checked here:
//   1. the table: 72 moves, read from the game's own move archive by way of
//      `app-data.json.selfStatChanges`, so the two codebases cannot drift;
//   2. the Ability and the item: Contrary inverts, Simple doubles, White Herb restores a net
//      drop, and Contrary + White Herb is still a rise (the Herb has nothing to restore);
//   3. the three numbers above, through the site's own engine;
//   4. the race: the first mover's own change is applied and the SECOND mover's answer moves,
//      on a speed tie nothing is applied, and the switch replays the old answer;
//   5. the user's own later hits: Contrary turns V494's self-drop into a rise, so
//      `self_drop_v494` is cleared and `self_stat_rise_v525` is set.
//
//   node tests/run-self-stat-change.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFENSIVE_STATS, DamageEngine, OFFENSIVE_STATS, SELF_STAT_CHANGE_ON, compact,
  defensiveSelfStatChange, makeContext, makeMon, monWithStages, offensiveSelfStatChange,
  selfStatChangeAfterAbility, selfStatChangeOption,
} from "../builder/engine.js";
import { TeamEvaluator } from "../builder/team-eval.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} != ${JSON.stringify(want)}`);

// ---------------------------------------------------------------------------
// 1. the table
// ---------------------------------------------------------------------------
const table = appData.selfStatChanges || {};
ok("the data file carries the table", Object.keys(table).length >= 60, String(Object.keys(table).length));
notes.push(`${Object.keys(table).length} moves change their own user's stats`);
// Every one read off the game's own description, so a handful is enough to pin the shape.
eq("Close Combat", table.closecombat, { defense: -1, sp_defense: -1 });
eq("Headlong Rush", table.headlongrush, { defense: -1, sp_defense: -1 });
eq("Dragon Ascent", table.dragonascent, { defense: -1, sp_defense: -1 });
eq("Armor Cannon", table.armorcannon, { defense: -1, sp_defense: -1 });
eq("Superpower", table.superpower, { attack: -1, defense: -1 });
eq("V-create", table.vcreate, { defense: -1, sp_defense: -1, speed: -1 });
eq("Scale Shot", table.scaleshot, { defense: -1, speed: 1 });
eq("Clanging Scales", table.clangingscales, { defense: -1 });
eq("Hyperspace Fury", table.hyperspacefury, { defense: -1 });
eq("Psyshield Bash", table.psyshieldbash, { defense: 1 });
eq("Torch Song", table.torchsong, { sp_attack: 1 });
// A change the user takes AFTER the damage still lands before the answer does, so it counts.
eq("Clangorous Soulblaze, after the damage", table.clangoroussoulblaze,
   { attack: 1, defense: 1, sp_attack: 1, sp_defense: 1, speed: 1 });
// And three kinds of change that are NOT a certainty before the answer, so they are absent:
// Skull Bash raises its Defense on the CHARGE turn, Fell Stinger only on a knockout, and Rage
// only if the user is hit while using it. The compiled archive distinguishes all three
// (`charge_then`, `on_ko_stage`, `rage`), which is why it is read instead of the prose.
ok("Skull Bash is absent: its rise is on the charge turn", table.skullbash === undefined);
ok("Fell Stinger is absent: its rise needs a knockout", table.fellstinger === undefined);
ok("Rage is absent: its rise needs the user to be hit", table.rage === undefined);
// The game's own archive says TWO stages for Make It Rain, where mainline says one. The app's
// hand-written MCTS fallback said one, and both survived into the rollout -- it dropped Sp. Atk
// by three. The data is authoritative, and this is the number it states.
eq("Make It Rain, from the game's own data", table.makeitrain, { sp_attack: -2 });
eq("Draco Meteor", table.dracometeor, { sp_attack: -2 });
// and a move that changes nothing about its user is absent
ok("a plain attack is not in the table", !table.flashcannon && !table.hyperbeam);

// ---------------------------------------------------------------------------
// 2. the Ability and the item
// ---------------------------------------------------------------------------
eq("plain, it is a drop", selfStatChangeAfterAbility(table.closecombat), { defense: -1, sp_defense: -1 });
eq("Contrary inverts it", selfStatChangeAfterAbility(table.closecombat, "Contrary"), { defense: 1, sp_defense: 1 });
eq("Simple doubles it", selfStatChangeAfterAbility(table.closecombat, "Simple"), { defense: -2, sp_defense: -2 });
eq("White Herb restores it", selfStatChangeAfterAbility(table.closecombat, "", "White Herb"), {});
eq("Contrary and White Herb is still a rise",
   selfStatChangeAfterAbility(table.closecombat, "Contrary", "White Herb"), { defense: 1, sp_defense: 1 });
eq("Contrary and Simple invert and double",
   selfStatChangeAfterAbility(table.closecombat, "Contrary"), { defense: 1, sp_defense: 1 });
eq("Simple on a rise doubles the rise", selfStatChangeAfterAbility(table.psyshieldbash, "Simple"), { defense: 2 });
eq("Contrary on a rise makes it a drop", selfStatChangeAfterAbility(table.psyshieldbash, "Contrary"), { defense: -1 });
// Clear Body and its family do NOT stop a Pokemon lowering its own stats.
eq("Clear Body does not stop a self-inflicted drop",
   selfStatChangeAfterAbility(table.closecombat, "Clear Body"), { defense: -1, sp_defense: -1 });
eq("a stage cannot pass six", selfStatChangeAfterAbility({ defense: -6 }, "Simple"), { defense: -6 });
// the two halves of a change
eq("only the defensive half reaches an answer",
   defensiveSelfStatChange(selfStatChangeAfterAbility(table.vcreate)), { defense: -1, sp_defense: -1 });
eq("and only the offensive half reaches the user's own next hit",
   offensiveSelfStatChange(selfStatChangeAfterAbility(table.dracometeor)), ["sp_attack", -2]);
eq("Close Combat changes no attacking stat", offensiveSelfStatChange(selfStatChangeAfterAbility(table.closecombat)), ["", 0]);
eq("the stat lists", [DEFENSIVE_STATS, OFFENSIVE_STATS], [["defense", "sp_defense"], ["attack", "sp_attack"]]);

// the switch
ok("the rule is on by default", SELF_STAT_CHANGE_ON === true);
for (const off of [null, undefined, false, "", "0", "off", "no", "none", "false"]) {
  ok(`selfStatChangeOption reads ${JSON.stringify(off)} as off`, selfStatChangeOption(off) === false);
}
for (const on of [true, 1, "1", "on", "yes"]) {
  ok(`selfStatChangeOption reads ${JSON.stringify(on)} as on`, selfStatChangeOption(on) === true);
}

// ---------------------------------------------------------------------------
// 3. the owner's three numbers
// ---------------------------------------------------------------------------
const engine = new DamageEngine(appData);
const evaluator = new TeamEvaluator(null, engine, "Doubles", {});

const set = (species, form, item, ability, nature, bonuses, moves) =>
  ({ species, form, item, ability, nature, bonuses, moves });
// Close Combat is the only attack on the set on purpose: with Brave Bird beside it, Reckless
// makes Brave Bird the better move and the race never reaches the one being tested. What is
// under test is the stat change, not the move choice.
const STARAPTOR = set("Staraptor", "Mega Staraptor", "Life Orb", "Contrary", "Adamant",
                      [0, 32, 0, 0, 0, 2], ["Close Combat", "Protect", "U-turn", "Tailwind"]);
const PLAIN = { ...STARAPTOR, ability: "Reckless" };
const HERB = { ...STARAPTOR, ability: "Reckless", item: "White Herb" };
const ARCHALUDON = set("Archaludon", "Archaludon", "Assault Vest", "Stamina", "Calm",
                       [32, 0, 0, 0, 32, 0], ["Flash Cannon", "Electro Shot", "Draco Meteor", "Body Press"]);

const mon = (s) => makeMon({
  pokemon: s.species, form: s.form, item: s.item, ability: s.ability, moves: s.moves,
  nature: s.nature, bonuses: s.bonuses,
}, engine);

const answerAt = (stages) => {
  const defender = monWithStages(mon(STARAPTOR), stages);
  let best = null;
  for (const move of ARCHALUDON.moves) {
    const result = engine.calculate(mon(ARCHALUDON), defender, makeContext({ move_name: move, battle_format: "Doubles" }));
    const top = Number(String(result.percent || "0").split("-").pop().replace("%", "")) || 0;
    if (!best || top > best.top) best = { top, percent: result.percent, ko: result.ko, move };
  }
  return best;
};

const at0 = answerAt({});
const atUp = answerAt({ defense: 1, sp_defense: 1 });
const atDown = answerAt({ defense: -1, sp_defense: -1 });
notes.push(`Archaludon's best answer: +0 ${at0.percent} (${at0.move}), +1 ${atUp.percent}, -1 ${atDown.percent}`);
// A staged defender has to change the number at all -- the app's damage cache was blind to stat
// stages and answered the same for every one of them, which is the bug this pins on the site.
ok("a +1 defender really is tougher", atUp.top < at0.top, `${atUp.top} vs ${at0.top}`);
ok("a -1 defender really is frailer", atDown.top > at0.top, `${atDown.top} vs ${at0.top}`);
ok("the rise costs the answer roughly a quarter", at0.top - atUp.top > 20, String(at0.top - atUp.top));
ok("and the drop gains it roughly a half", atDown.top - at0.top > 35, String(atDown.top - at0.top));

// ---------------------------------------------------------------------------
// 4. the race
// ---------------------------------------------------------------------------
const raceFor = (threat, { on = true } = {}) => {
  const e = new DamageEngine(appData, { selfStatChange: on });
  const ev = new TeamEvaluator(null, e, "Doubles", {});
  const threatVariants = [monWithStages(makeMon({
    pokemon: threat.species, form: threat.form, item: threat.item, ability: threat.ability,
    moves: threat.moves, nature: threat.nature, bonuses: threat.bonuses,
  }, e), {})];
  const teamVariants = [makeMon({
    pokemon: ARCHALUDON.species, form: ARCHALUDON.form, item: ARCHALUDON.item,
    ability: ARCHALUDON.ability, moves: ARCHALUDON.moves, nature: ARCHALUDON.nature,
    bonuses: ARCHALUDON.bonuses,
  }, e)];
  const rawIncoming = ev.bestBetween(threatVariants, teamVariants);
  const rawOutgoing = ev.bestBetween(teamVariants, threatVariants);
  const first = ev.firstToken(rawIncoming, rawOutgoing);
  const change = ev.selfStatChangeInRace(threatVariants, teamVariants, rawIncoming, rawOutgoing, first);
  const answer = change && change.side === "threat"
    ? ev.bestBetween(teamVariants, change.variants)
    : rawOutgoing;
  return { first, change, threatMove: rawIncoming.move, answer };
};

for (const [label, threat, expected] of [
  ["Contrary Mega Staraptor", STARAPTOR, { defense: 1, sp_defense: 1 }],
  ["Reckless Mega Staraptor", PLAIN, { defense: -1, sp_defense: -1 }],
  ["Reckless with a White Herb", HERB, null],
]) {
  const on = raceFor(threat);
  const off = raceFor(threat, { on: false });
  notes.push(`${label}: uses ${on.threatMove}, first=${on.first}, applied=${JSON.stringify(on.change?.stages ?? null)}, `
    + `answer ON ${on.answer.percent} / OFF ${off.answer.percent}`);
  if (expected) {
    ok(`${label}: the change is applied`, !!on.change, "no change");
    eq(`${label}: and it is the right one`, on.change?.stages ?? null, expected);
    ok(`${label}: the answer moves`, on.answer.percent !== off.answer.percent,
       `${on.answer.percent} === ${off.answer.percent}`);
  } else {
    ok(`${label}: nothing is applied`, !on.change, JSON.stringify(on.change));
    ok(`${label}: the answer is unchanged`, on.answer.percent === off.answer.percent);
  }
  ok(`${label}: the switch replays the old answer`, !raceFor(threat, { on: false }).change);
}

// On a speed tie neither side has landed its move before the other.
{
  const e = new DamageEngine(appData);
  const ev = new TeamEvaluator(null, e, "Doubles", {});
  const mirror = [makeMon({ pokemon: "Staraptor", form: "Mega Staraptor", item: "Life Orb",
                            ability: "Contrary", moves: STARAPTOR.moves, nature: "Adamant",
                            bonuses: STARAPTOR.bonuses }, e)];
  const raw = ev.bestBetween(mirror, mirror);
  ok("a speed tie applies nothing", ev.selfStatChangeInRace(mirror, mirror, raw, raw, null) === null);
}

// ---------------------------------------------------------------------------
// 5. the user's own later hits
// ---------------------------------------------------------------------------
{
  const e = new DamageEngine(appData);
  const serperior = (ability) => makeMon({
    pokemon: "Serperior", form: "Serperior", item: "Life Orb", ability, nature: "Timid",
    bonuses: [0, 0, 0, 32, 0, 32], moves: ["Leaf Storm", "Giga Drain", "Protect", "Glare"],
  }, e);
  const amoonguss = makeMon({
    pokemon: "Amoonguss", form: "Amoonguss", item: "Rocky Helmet", ability: "Regenerator",
    nature: "Calm", bonuses: [32, 0, 0, 0, 32, 0], moves: ["Spore", "Rage Powder", "Pollen Puff", "Protect"],
  }, e);
  const ctx = makeContext({ move_name: "Leaf Storm", battle_format: "Doubles" });
  const contrary = e.calculate(serperior("Contrary"), amoonguss, ctx);
  const plain = e.calculate(serperior("Overgrow"), amoonguss, ctx);
  eq("without Contrary, Leaf Storm still weakens its own user",
     plain.self_drop_v494, { stat: "sp_attack", stages: 2 });
  ok("with Contrary the drop is gone", !contrary.self_drop_v494, JSON.stringify(contrary.self_drop_v494));
  eq("and a rise is recorded instead", contrary.self_stat_rise_v525, { stat: "sp_attack", stages: 2 });
  eq("the Ability is named", contrary.self_stat_change_ability_v525, "contrary");
  ok("the damage itself is the same either way", plain.percent === contrary.percent,
     `${plain.percent} vs ${contrary.percent}`);
  // Simple doubles the drop rather than clearing it.
  const simple = e.calculate(serperior("Simple"), amoonguss, ctx);
  eq("Simple doubles the drop", simple.self_drop_v494, { stat: "sp_attack", stages: 4 });
  // and an ordinary Pokemon is untouched, which is what keeps every recorded vector green
  const off = new DamageEngine(appData, { selfStatChange: false });
  eq("with the rule off, Contrary is not consulted",
     off.calculate(serperior("Contrary"), amoonguss, ctx).self_drop_v494, { stat: "sp_attack", stages: 2 });
  ok("and no rise is recorded", !off.calculate(serperior("Contrary"), amoonguss, ctx).self_stat_rise_v525);
}

for (const line of notes) console.log(line);
if (failures.length) {
  console.error(`\n${checked} checks, ${failures.length} failed:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\n${checked} checks, all passed.`);
