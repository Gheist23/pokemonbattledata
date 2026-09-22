// Checks the deep Optimize (builder/optimize-deep.js and its pieces):
//
//  1. the damage memo: every calc it hands back equals a fresh engine calc for that
//     exact spread (random spreads, every threat set and move), so keying calcs by the
//     few stats they read never mixes two different calcs up;
//  2. koProfile equals Team Evaluation's chanceForHits for hits 1-4;
//  3. the result: Stat Points within 0-32 and 66, a score never below the current set's,
//     the same answer twice, kept moves kept, every new move learnable and allowed,
//     Keep Nature / Keep Speed respected;
//  4. the Speed lists agree with an independent Speed Tiers ordering;
//  5. the time: Quick and Deep within their budgets (Top 30, Node).
//
//   node tests/run-optimize-deep.mjs [--quick]     (--quick: fewer members, no Deep run)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, compact, makeMon } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS, chanceForHits } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamOptimizer } from "../builder/team-optimize.js";
import { SpeedTiers } from "../builder/speed-tiers.js";
import { makeSet } from "../builder/common.js";
import { OptimizeObjective } from "../builder/optimize-objective.js";
import { DamageMemo, koProfile, rollsForHit, pointTotal } from "../builder/optimize-core.js";
import { DeepOptimizer, DEPTHS } from "../builder/optimize-deep.js";
import { suggestBlock, UTILITY_ATTACKS } from "../builder/move-traits.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const quickOnly = process.argv.includes("--quick");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const meta = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));
const engine = new DamageEngine(appData);
const TOP = 30;
const ev = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: TOP }, 1000));
ev.setMetaRecords(meta.pokemon);
const evaluation = new TeamEvaluation(ev);

const TEAMS = {
  sun: [
    { species: "Charizard", form: "Mega Charizard Y", item: "Charizardite Y", ability: "Drought", nature: "Timid", moves: ["Heat Wave", "Weather Ball", "Solar Beam", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Venusaur", item: "Focus Sash", ability: "Chlorophyll", nature: "Modest", moves: ["Energy Ball", "Sludge Bomb", "Sleep Powder", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Incineroar", item: "Sitrus Berry", ability: "Intimidate", nature: "Careful", moves: ["Fake Out", "Parting Shot", "Flare Blitz", "Knock Off"], bonuses: [32, 0, 2, 0, 32, 0] },
    { species: "Garchomp", item: "Life Orb", ability: "Rough Skin", nature: "Jolly", moves: ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
    { species: "Whimsicott", item: "Focus Sash", ability: "Prankster", nature: "Timid", moves: ["Tailwind", "Moonblast", "Encore", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Gholdengo", item: "Choice Specs", ability: "Good as Gold", nature: "Modest", moves: ["Make It Rain", "Shadow Ball", "Focus Blast", "Thunderbolt"], bonuses: [2, 0, 0, 32, 0, 32] },
  ],
  // A poorly spread team: the optimiser should find real improvements here.
  rough: [
    { species: "Garchomp", item: "Life Orb", ability: "Rough Skin", nature: "Bold", moves: ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], bonuses: [10, 10, 10, 10, 10, 10] },
    { species: "Kingambit", item: "Black Glasses", ability: "Supreme Overlord", nature: "Modest", moves: ["Sucker Punch", "Kowtow Cleave", "Iron Head", "Protect"], bonuses: [0, 0, 0, 0, 0, 0] },
    { species: "Rillaboom", item: "Assault Vest", ability: "Grassy Surge", nature: "Adamant", moves: ["Fake Out", "Grassy Glide", "Wood Hammer", "U-turn"], bonuses: [32, 32, 0, 0, 0, 2] },
  ],
  // A Trick Room team with a fast Torkoal: slowing it down is the plan, not a loss.
  tr: [
    { species: "Hatterene", item: "Life Orb", ability: "Magic Bounce", nature: "Quiet", moves: ["Dazzling Gleam", "Trick Room", "Expanding Force", "Protect"], bonuses: [32, 0, 2, 32, 0, 0] },
    { species: "Torkoal", item: "Charcoal", ability: "Drought", nature: "Timid", moves: ["Eruption", "Heat Wave", "Earth Power", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Farigiraf", item: "Sitrus Berry", ability: "Armor Tail", nature: "Bold", moves: ["Trick Room", "Helping Hand", "Psychic", "Thunderbolt"], bonuses: [32, 0, 32, 0, 2, 0] },
    { species: "Incineroar", item: "Safety Goggles", ability: "Intimidate", nature: "Careful", moves: ["Fake Out", "Parting Shot", "Flare Blitz", "Knock Off"], bonuses: [32, 0, 2, 0, 32, 0] },
  ],
};
const teamSets = (name, slot = -1, override = null) => {
  const list = TEAMS[name].map((s, i) => makeSet(i === slot && override ? { ...s, ...override } : s));
  while (list.length < 6) list.push(null);
  return list;
};

const failures = [];
let checks = 0;
const check = (ok, message) => {
  checks += 1;
  if (!ok) failures.push(message);
};

// Deterministic random numbers.
let seed = 12345;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const randomPoints = () => {
  const points = [0, 0, 0, 0, 0, 0];
  let left = 66;
  for (let i = 0; i < 80 && left > 0; i += 1) {
    const stat = Math.floor(random() * 6);
    const add = Math.min(left, 32 - points[stat], 1 + Math.floor(random() * 16));
    points[stat] += add;
    left -= add;
  }
  return points;
};
const natureNames = Object.keys(engine.natures);
const sameRolls = (a, b) => JSON.stringify(rollsForHit(a, 0)) === JSON.stringify(rollsForHit(b, 0))
  && JSON.stringify(rollsForHit(a, 1)) === JSON.stringify(rollsForHit(b, 1))
  && (a.move_accuracy_factor ?? 1) === (b.move_accuracy_factor ?? 1);

// --- 1. the damage memo -----------------------------------------------------------------
{
  const opt = new TeamOptimizer(evaluation);
  const sets = teamSets("sun");
  let compared = 0;
  for (const slot of [0, 2, 3]) {
    const objective = new OptimizeObjective(opt, sets, slot, { memo: new DamageMemo(), topX: 20 });
    const moveSet = objective.moveSet(sets[slot].moves);
    // Fill the memo from many spreads, then compare what it returns with fresh calcs.
    const spreads = Array.from({ length: 12 }, () => [natureNames[Math.floor(random() * natureNames.length)], randomPoints()]);
    for (const [nature, points] of spreads) objective.score(nature, points, moveSet);
    for (const [nature, points] of spreads.slice(0, 6)) {
      const mon = objective.mon(nature, points);
      const fs = engine.finalStats(mon);
      for (const row of objective.rows.filter((_, i) => i % 3 === 0)) {
        for (const fieldId of objective.fields) {
          for (const attack of moveSet.attacks) {
            const cached = objective.outgoing(row, attack, fs, mon, fieldId).raw;
            const fresh = objective.calc(mon, row.threat, attack.move, fieldId);
            compared += 1;
            check(sameRolls(cached, fresh), `memo out ${sets[slot].species} ${nature} ${points} ${attack.move} -> ${row.name} (${fieldId})`);
          }
          for (const attack of row.moves) {
            const cached = objective.incomingRaw(row, attack, fs, mon, fieldId);
            const fresh = objective.calc(row.threat, mon, attack.move, fieldId);
            compared += 1;
            check(sameRolls(cached, fresh), `memo in ${row.name} ${attack.move} -> ${sets[slot].species} ${nature} ${points} (${fieldId})`);
          }
        }
      }
    }
  }
  console.log(`1. memo: ${compared} cached calcs compared with fresh ones`);
}

// --- 2. koProfile = chanceForHits -------------------------------------------------------
{
  let compared = 0;
  let worst = 0;
  for (let i = 0; i < 2500; i += 1) {
    const hp = 40 + Math.floor(random() * 320);
    const base = 5 + Math.floor(random() * hp * 0.9);
    const rolls = Array.from({ length: 16 }, (_, k) => Math.floor(base * (0.85 + (0.15 * k) / 15)));
    const result = { rolls, current_hp: hp, max_hp: hp, move_accuracy_factor: random() < 0.4 ? 0.7 + random() * 0.3 : 1 };
    if (random() < 0.2) {
      result.rolls_with_resist_berry = rolls.map((r) => Math.floor(r / 2));
      result.rolls_without_resist_berry = rolls;
    }
    const acc = result.move_accuracy_factor;
    const profile = koProfile([rollsForHit(result, 0), rollsForHit(result, 1)], hp, acc);
    for (let n = 1; n <= 4; n += 1) {
      const want = chanceForHits(result, n, acc);
      worst = Math.max(worst, Math.abs(want - profile[n]));
      compared += 1;
      check(Math.abs(want - profile[n]) <= 1e-12, `koProfile hit ${n}: ${profile[n]} vs chanceForHits ${want} (hp ${hp}, acc ${acc})`);
    }
  }
  console.log(`2. koProfile: ${compared} values, largest difference ${worst.toExponential(2)}`);
}

// --- 3, 4, 5. the result ------------------------------------------------------------------
const learnable = (optimizer, set) => new Set(optimizer.learnset(set.species, set.form || set.species).map((m) => compact(engine.canonicalMoveName(m))));
const plainResult = (r) => JSON.stringify({ before: r.before, after: r.after, delta: r.delta, changes: r.changes, speed: r.speed, alternatives: r.alternatives, moves_tested: r.moves_tested, trade_off: r.trade_off });

async function runOne(teamName, slot, options, label) {
  const sets = teamSets(teamName);
  const optimizer = new DeepOptimizer(evaluation);
  const t0 = performance.now();
  const result = await optimizer.run(sets, slot, { topX: TOP, ...options }, {});
  const seconds = (performance.now() - t0) / 1000;
  const set = sets[slot];
  const name = `${label} ${set.species}`;
  const { before, after } = result;
  check(after.bonuses.every((v) => Number.isInteger(v) && v >= 0 && v <= 32), `${name}: Stat Points out of 0-32: ${after.bonuses}`);
  check(pointTotal(after.bonuses) <= 66, `${name}: more than 66 Stat Points: ${after.bonuses}`);
  check(after.score >= before.score - 1e-9, `${name}: score dropped ${before.score} -> ${after.score}`);
  if (options.keepNature) check(after.nature === before.nature, `${name}: Keep Nature changed ${before.nature} -> ${after.nature}`);
  if (options.keepSpeed) check(after.speed >= before.speed, `${name}: Keep Speed lowered ${before.speed} -> ${after.speed}`);
  const legal = learnable(optimizer, set);
  for (const move of result.added || []) {
    const record = engine.moveRecord(move);
    check(legal.has(compact(move)), `${name}: ${move} is not in its learnset`);
    check(!suggestBlock(record, { sun: true, rain: true, stab: true }) || suggestBlock(record, { sun: true, rain: true, stab: true }) === "needs Sun", `${name}: ${move} should never be suggested (${suggestBlock(record, { sun: true, rain: true, stab: true })})`);
  }
  for (const kept of result.moves_tested?.kept || []) check(after.moves.includes(kept.move), `${name}: kept move ${kept.move} was dropped`);
  for (const move of set.moves) {
    if (!optimizer.opt.damaging(move) || UTILITY_ATTACKS.has(compact(move)) || ev.movePriority(move) > 0) check(after.moves.includes(move), `${name}: ${move} (support, utility or priority) was dropped`);
  }
  // 4. The Speed lists against Speed Tiers' own ordering (normal play).
  const tiers = new SpeedTiers(ev);
  const speedOf = (nature, bonuses) => tiers.rows([{ ...set, nature, bonuses }], { top_x: TOP }).rows.find((r) => r.ours).speed;
  const metaRows = tiers.rows([], { top_x: TOP }).rows;
  const was = speedOf(before.nature, before.bonuses);
  const now = speedOf(after.nature, after.bonuses);
  const normal = result.speed.contexts.find((c) => c.id === "normal");
  const expectFaster = metaRows.filter((r) => !(was > r.speed) && now > r.speed).length;
  const expectSlower = metaRows.filter((r) => !(was < r.speed) && now < r.speed).length;
  check(normal.before === was && normal.after === now, `${name}: Speed ${normal.before}->${normal.after} vs Speed Tiers ${was}->${now}`);
  check(normal.now_faster.length === expectFaster, `${name}: now faster than ${normal.now_faster.length}, Speed Tiers says ${expectFaster}`);
  check(normal.now_slower.length === expectSlower, `${name}: now slower than ${normal.now_slower.length}, Speed Tiers says ${expectSlower}`);
  return { result, seconds, name };
}

const runs = [];
const jobs = quickOnly
  ? [["sun", 3, { depth: "quick" }], ["rough", 0, { depth: "quick" }]]
  : [
    ["sun", 0, { depth: "quick" }], ["sun", 2, { depth: "quick" }], ["sun", 3, { depth: "quick" }], ["sun", 4, { depth: "quick" }],
    ["rough", 0, { depth: "quick" }], ["rough", 1, { depth: "quick" }], ["rough", 2, { depth: "quick" }],
    ["rough", 0, { depth: "quick", keepNature: true }], ["rough", 0, { depth: "quick", keepSpeed: true }], ["sun", 1, { depth: "quick", testMoves: false }],
    ["rough", 0, { depth: "deep" }], ["sun", 3, { depth: "deep" }],
  ];
for (const [team, slot, options] of jobs) {
  const run = await runOne(team, slot, options, `${team}/${options.depth}${options.keepNature ? "/keepNature" : ""}${options.keepSpeed ? "/keepSpeed" : ""}${options.testMoves === false ? "/noMoves" : ""}`);
  runs.push(run);
  const r = run.result;
  console.log(`   ${run.name.padEnd(34)} ${run.seconds.toFixed(1).padStart(5)} s  ${r.before.nature} ${r.before.bonuses.join("/")} -> ${r.after.nature} ${r.after.bonuses.join("/")}  score ${r.before.score.toFixed(2)} -> ${r.after.score.toFixed(2)}${r.moves_changed ? `  moves: ${r.removed.join("+")} -> ${r.added.join("+")}` : ""}`);
}
// Deterministic: the same run twice gives the same answer (a fresh evaluation, so no warm memo).
{
  const again = async () => {
    const e = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: TOP }, 1000));
    e.setMetaRecords(meta.pokemon);
    return new DeepOptimizer(new TeamEvaluation(e)).run(teamSets("rough"), 0, { depth: "quick", topX: TOP }, {});
  };
  const [a, b] = [await again(), await again()];
  check(plainResult(a) === plainResult(b), "the same Quick run twice gave different results");
}
// 6. Regressions from the review: Stat Point totals over and under 66, never-miss moves,
// the trade-off reasons, a Trick Room team's speed plan and a member with no moves.
{
  const quick = { depth: "quick", topX: TOP };
  const legalSpread = (points) => Array.isArray(points) && points.every((v) => Number.isInteger(v) && v >= 0 && v <= 32) && pointTotal(points) <= 66;
  // Never-miss moves (accuracy: true) are not "inaccurate".
  for (const move of ["Aerial Ace", "Aura Sphere", "Swift", "Smart Strike"]) {
    check(suggestBlock(engine.moveRecord(move), { stab: false, doubles: true }) === "", `${move} (never misses) is blocked: ${suggestBlock(engine.moveRecord(move), { stab: false, doubles: true })}`);
  }
  check(suggestBlock(engine.moveRecord("Focus Blast"), { stab: false }) === "", "Focus Blast (70%) should stay allowed");
  check(suggestBlock(engine.moveRecord("Zap Cannon"), { stab: false }) === "inaccurate", "Zap Cannon (50%) should be inaccurate");
  // Over 66 (a Showdown paste of 4 HP / 252 Atk / 252 Spe): a legal spread is always suggested.
  const overJobs = quickOnly ? [[[4, 32, 0, 0, 0, 32], {}]] : [[[4, 32, 0, 0, 0, 32], {}], [[32, 32, 0, 0, 0, 32], {}], [[4, 32, 0, 0, 0, 32], { keepSpeed: true }]];
  for (const [bonuses, extra] of overJobs) {
    const r = await new DeepOptimizer(evaluation).run(teamSets("sun", 3, { bonuses }), 3, { ...quick, ...extra }, {});
    const name = `over 66 ${bonuses.join("/")}${extra.keepSpeed ? " keepSpeed" : ""}`;
    check(r.ok === true && r.points?.kind === "legal", `${name}: not reported as a required change (ok ${r.ok}, kind ${r.points?.kind})`);
    check(legalSpread(r.after.bonuses), `${name}: suggested spread is not legal: ${r.after.bonuses}`);
    check(!r.moves_tested?.spread || legalSpread(r.moves_tested.spread.bonuses), `${name}: moves-tested spread is not legal: ${r.moves_tested?.spread?.bonuses}`);
    check(!r.trade_off || legalSpread(r.trade_off.bonuses), `${name}: trade-off spread is not legal: ${r.trade_off?.bonuses}`);
    for (const a of r.alternatives || []) check(legalSpread(a.bonuses), `${name}: alternative spread is not legal: ${a.bonuses}`);
    check(JSON.stringify(r.before.bonuses) === JSON.stringify(bonuses), `${name}: Previously should show the set's own spread, got ${r.before.bonuses}`);
    if (extra.keepSpeed) check(r.after.speed >= r.before.speed, `${name}: Keep Speed lowered ${r.before.speed} -> ${r.after.speed}`);
    if (bonuses[0] === 4) check(r.after.speed === r.before.speed, `${name}: a 2-point trim should not cost Speed (${r.before.speed} -> ${r.after.speed})`);
  }
  // Under 66: the unused points are always offered, even for a small gain.
  const under = await new DeepOptimizer(evaluation).run(teamSets("sun", 3, { bonuses: [0, 32, 0, 0, 0, 32] }), 3, quick, {});
  check(under.ok === true && pointTotal(under.after.bonuses) === 66, `under 66: unused points not offered (ok ${under.ok}, after ${under.after.bonuses})`);
  check(under.after.bonuses.every((v, i) => v >= [0, 32, 0, 0, 0, 32][i]) || under.delta >= 0.5, `under 66: a small gain took points from a stat: ${under.after.bonuses}`);
  if (!quickOnly) {
    // The trade-off's reasons compare it with the suggestion: nothing the two share.
    const rough = await new DeepOptimizer(evaluation).run(teamSets("rough"), 0, quick, {});
    const trade = rough.trade_off;
    if (rough.ok && trade) {
      check(trade.compared_with === "suggestion", "trade-off: should be compared with the suggestion");
      if (trade.nature === rough.after.nature) check(!trade.reasons.some((r) => r.includes("instead of")), `trade-off: lists a Nature both share: ${trade.reasons.join("; ")}`);
      check(Math.abs(trade.over_pick - (trade.score - rough.after.score)) < 1e-6, "trade-off: over_pick is not its gain over the suggestion");
    }
    // A Trick Room team: slowing down counts as moving first in Trick Room.
    const room = await new DeepOptimizer(evaluation).run(teamSets("tr"), 1, quick, {});
    check(room.plan_context?.trick_room === true, `Trick Room team: speed plan is ${room.plan_context?.label}`);
    if (room.ok && room.after.speed < room.before.speed) {
      check(room.after.counts.outspeeds >= room.before.counts.outspeeds, `Trick Room team: moving first ${room.before.counts.outspeeds} -> ${room.after.counts.outspeeds} after slowing down`);
      const slower = room.changes.flatMap((c) => c.lines).filter((l) => l.tone === "bad" && /moves second|ties on Speed/.test(l.text));
      check(!slower.length, `Trick Room team: slowing down reads as worse: ${slower.map((l) => l.text).join(" | ")}`);
    }
    // No moves: the common set's moves are shown as added, never as the set's own.
    const bare = await new DeepOptimizer(evaluation).run(teamSets("rough", 0, { moves: [] }), 0, { ...quick, testMoves: false }, {});
    check(bare.before.moves.length === 0, `no moves: Previously lists ${bare.before.moves.join(", ")}`);
    if (bare.ok) check(bare.moves_changed && bare.added.length === bare.after.moves.filter(Boolean).length, `no moves: the moves Apply writes are not all marked new (${bare.added})`);
  }
  console.log("6. over/under 66, never-miss moves, trade-off reasons, Trick Room plan, no moves: checked");
}

// 5. Time (Node): the work is bounded by counts, the clock only caps slow machines
// (2.5x the nominal seconds). Over the nominal time is reported, not failed, since it
// depends on how busy the machine is.
for (const run of runs) {
  const depth = run.result.stats.depth;
  const nominal = DEPTHS[depth].seconds;
  check(run.seconds <= nominal * 2.6, `${run.name}: ${run.seconds.toFixed(1)} s is over the ${depth} safety cap of ${(nominal * 2.5).toFixed(0)} s`);
  if (run.seconds > nominal * 1.35) console.log(`   note: ${run.name} took ${run.seconds.toFixed(1)} s (nominal ${nominal} s) - a busy machine?`);
}
const deltas = runs.map((r) => r.result.delta);
console.log(`3-5. ${runs.length} runs; score changes ${deltas.map((d) => d.toFixed(2)).join(" ")}; slowest ${Math.max(...runs.map((r) => r.seconds)).toFixed(1)} s`);

for (const failure of failures.slice(0, 40)) console.log(`FAIL ${failure}`);
console.log(`\n${checks} checked, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
