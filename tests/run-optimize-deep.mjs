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
//  5. the time: Quick and Deep within their budgets (Top 30, Node);
//  7. the guaranteed moves: a move at least GUARANTEED_MOVE_SHARE percent of a Pokemon's
//     teams run is never offered away (not in the suggestion, the move options, the
//     trade-off or the alternatives), a set missing one is offered it, and a weather or
//     terrain move the team cannot switch on is never offered. What counts as guaranteed
//     is read from the meta records here, not from builder/guaranteed-moves.js;
//  8. the guaranteed move counts towards what the player is shown: the headline, the
//     counts and the change rows are measured from the moves the set was saved with, and
//     the block only says "the spread stays as it is" when the suggestion really keeps
//     the spread and the Nature, and the Stat Points & Nature button names the added move
//     instead of promising the spread "only";
//  9. the panel: every "What changes in battle" row is listed on the side its own
//     sentences say (never on the sign of the matchup score, which adds up every item
//     set of a threat and both sides of the fight at once), and the Previously and now
//     block keeps every number, opens with a sentence built from those numbers, marks
//     only the stats that moved, shows the direction with a tip on the bar and an arrow
//     rather than with colour, and collapses when nothing in the spread moves.
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
import { MOVES_NEEDING_SUPPORT } from "../builder/team-suggest.js";
import { GUARANTEED_MOVE_SHARE } from "../builder/guaranteed-moves.js";

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

/**
 * The moves at least GUARANTEED_MOVE_SHARE percent of this Pokemon's teams run, straight
 * from the meta records: {move key -> share}. A Mega reads its base species, as the usage
 * data is filed that way.
 */
const guaranteedShares = (name) => {
  const record = ev.record(name) || ev.record(ev.baseSpeciesFromDisplay(String(name || "")));
  const out = new Map();
  for (const [move, pct] of record?.moves || []) {
    const k = compact(move);
    if (!out.has(k) && Number(pct) >= GUARANTEED_MOVE_SHARE) out.set(k, Number(pct));
  }
  return out;
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
  // The guaranteed-moves rule adds a move on its recorded usage, not on the learnset CSVs
  // (they are narrow), so those additions are not held to the two checks below.
  const forced = new Set((result.guaranteed?.added || []).map((a) => compact(a.move)));
  for (const move of result.added || []) {
    if (forced.has(compact(move))) continue;
    const record = engine.moveRecord(move);
    check(legal.has(compact(move)), `${name}: ${move} is not in its learnset`);
    check(!suggestBlock(record, { sun: true, rain: true, stab: true }) || suggestBlock(record, { sun: true, rain: true, stab: true }) === "needs Sun", `${name}: ${move} should never be suggested (${suggestBlock(record, { sun: true, rain: true, stab: true })})`);
  }
  for (const kept of result.moves_tested?.kept || []) check(after.moves.includes(kept.move), `${name}: kept move ${kept.move} was dropped`);
  for (const move of set.moves) {
    if (!optimizer.opt.damaging(move) || UTILITY_ATTACKS.has(compact(move)) || ev.movePriority(move) > 0) check(after.moves.includes(move), `${name}: ${move} (support, utility or priority) was dropped`);
  }
  // A move nearly every team of this Pokemon runs stays on the set, and is never offered
  // away in the move options, the trade-off or the alternatives. Weather and terrain moves
  // are left out here: whether one counts depends on the team, which section 7 checks.
  const shares = guaranteedShares(set.form || set.species);
  for (const move of set.moves || []) {
    const k = compact(move);
    if (!shares.has(k) || MOVES_NEEDING_SUPPORT[k]) continue;
    const label = `${name}: ${move} (on ${shares.get(k)}% of its teams)`;
    check(after.moves.some((m) => compact(m) === k), `${label} was dropped from the suggestion`);
    check((result.moves_tested?.kept || []).some((x) => compact(x.move) === k), `${label} is not in the kept list`);
    for (const option of result.moves_tested?.options || []) check(!option.removed.some((m) => compact(m) === k), `${label} is offered away by a move option (+${option.added.join("/")})`);
    if (result.trade_off) check(result.trade_off.moves.some((m) => compact(m) === k), `${label} is dropped by the trade-off`);
    for (const alt of result.alternatives || []) check((alt.moves || []).some((m) => compact(m) === k), `${label} is dropped by the ${alt.kind} alternative`);
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

// --- 7. the guaranteed moves ---------------------------------------------------------------
// The rule Auto Build and Suggestions follow (builder/guaranteed-moves.js), on Optimize's
// move test: a move nearly every team of this Pokemon runs is never offered away, a set
// missing one is offered it, and a weather or terrain move the team cannot switch on is
// never offered as a new attack. The named moves are checked against the meta records first,
// so a data change fails loudly here instead of making the cases pass for nothing.
{
  const runCase = async (team, slot, override, depth) => {
    const sets = teamSets(team, slot, override);
    const result = await new DeepOptimizer(evaluation).run(sets, slot, { depth, topX: TOP }, {});
    return { result, label: `${team}/${depth} ${TEAMS[team][slot].species}${override ? " (saved without it)" : ""}` };
  };
  const offered = (result) => [...(result.added || []), ...(result.moves_tested?.options || []).flatMap((o) => o.added)];

  // a) A member that has its guaranteed moves keeps them, at both depths.
  const holds = [
    ["rough", 1, ["Kowtow Cleave", "Sucker Punch"]],   // Kingambit
    ["rough", 2, ["Grassy Glide", "Fake Out"]],        // Rillaboom: its own Grassy Surge powers Grassy Glide
    ["sun", 5, ["Make It Rain", "Shadow Ball"]],       // Gholdengo
  ];
  for (const [team, slot, moves] of holds) {
    const shares = guaranteedShares(TEAMS[team][slot].form || TEAMS[team][slot].species);
    for (const move of moves) check(shares.has(compact(move)), `data: ${TEAMS[team][slot].species} ${move} is no longer at ${GUARANTEED_MOVE_SHARE}%+ usage - pick another move for this case`);
    // One case of each group also runs Deep: the rule has to hold at both depths.
    for (const depth of team === "rough" && slot === 1 ? ["quick", "deep"] : ["quick"]) {
      const { result, label } = await runCase(team, slot, null, depth);
      for (const move of moves) {
        check(result.after.moves.some((m) => compact(m) === compact(move)), `${label}: ${move} is not on the suggested set (${result.after.moves.join(", ")})`);
        check(!(result.removed || []).some((m) => compact(m) === compact(move)), `${label}: ${move} was taken away`);
        check((result.moves_tested?.kept || []).some((k) => compact(k.move) === compact(move)), `${label}: ${move} is not in the kept list`);
        for (const option of result.moves_tested?.options || []) check(!option.removed.some((m) => compact(m) === compact(move)), `${label}: a move option offers ${move} away (+${option.added.join("/")})`);
      }
      console.log(`   ${label.padEnd(34)} keeps ${moves.join(", ")}`);
    }
  }

  // b) A saved set missing one is offered it, and says so.
  const missing = [
    ["rough", 2, { moves: ["Fake Out", "Wood Hammer", "U-turn", "High Horsepower"] }, "Grassy Glide"],
    ["sun", 5, { moves: ["Make It Rain", "Focus Blast", "Thunderbolt", "Protect"] }, "Shadow Ball"],
  ];
  for (const [team, slot, override, move] of missing) {
    for (const depth of team === "rough" && slot === 2 ? ["quick", "deep"] : ["quick"]) {
      const { result, label } = await runCase(team, slot, override, depth);
      const added = result.guaranteed?.added || [];
      check(result.ok === true, `${label}: not offered at all (${result.message || ""})`);
      check(result.after.moves.some((m) => compact(m) === compact(move)), `${label}: ${move} is not on the suggested set (${result.after.moves.join(", ")})`);
      check((result.added || []).some((m) => compact(m) === compact(move)), `${label}: ${move} is not marked as new`);
      check(added.some((a) => compact(a.move) === compact(move) && a.share >= GUARANTEED_MOVE_SHARE), `${label}: ${move} is not reported as a guaranteed move (${JSON.stringify(added)})`);
      check(/always kept on the final set/.test(result.guaranteed?.note || ""), `${label}: no plain note for the breakdown (${result.guaranteed?.note || "none"})`);
      // Previously keeps the set as it was saved, so the breakdown shows what changed.
      check(JSON.stringify(result.before.moves) === JSON.stringify(override.moves), `${label}: Previously should list the saved moves, got ${result.before.moves.join(", ")}`);
      check(result.moves_changed === true, `${label}: the moves changed but moves_changed is ${result.moves_changed}`);
      console.log(`   ${label.padEnd(34)} offers ${move}: ${result.guaranteed?.note || ""}`);
    }
  }

  // c) The field gate on new moves: Hatterene's Expanding Force needs Psychic Terrain and
  // this team sets none, so it is never offered; Torkoal's Solar Beam needs sun, which the
  // team's own Drought does set, so it still is.
  const gated = await runCase("tr", 0, { moves: ["Dazzling Gleam", "Trick Room", "Psychic", "Protect"] }, "quick");
  check(MOVES_NEEDING_SUPPORT.expandingforce === "psychic", "data: Expanding Force no longer needs Psychic Terrain - pick another move for this case");
  check(!offered(gated.result).some((m) => compact(m) === "expandingforce"), `${gated.label}: Expanding Force was offered although nothing sets Psychic Terrain`);
  const powered = await runCase("tr", 1, null, "quick");
  check(MOVES_NEEDING_SUPPORT.solarbeam === "sun", "data: Solar Beam no longer needs sun - pick another move for this case");
  check(offered(powered.result).some((m) => compact(m) === "solarbeam"), `${powered.label}: Solar Beam is no longer offered although Drought sets the sun (the gate is too wide)`);

  // d) The same runs with the rule switched off (`guaranteedMoveShare: null`, how a
  // recording made before it replays) must still do the old thing. Without this the checks
  // above could pass because nothing ever wanted those moves, and would never fail again.
  const without = async (team, slot, override) => new DeepOptimizer(evaluation)
    .run(teamSets(team, slot, override), slot, { depth: "quick", topX: TOP, guaranteedMoveShare: null }, {});
  {
    const r = await without("rough", 1, null);
    const kept = (r.moves_tested?.kept || []).some((k) => compact(k.move) === "kowtowcleave");
    const taken = (r.moves_tested?.options || []).some((o) => o.removed.some((m) => compact(m) === "kowtowcleave"));
    check(!kept && taken, `rule off: Kingambit's Kowtow Cleave should still be kept-by-nothing (${kept}) and offered away (${taken}); the checks above would hold for the wrong reason`);
  }
  {
    const r = await without("rough", 2, { moves: ["Fake Out", "Wood Hammer", "U-turn", "High Horsepower"] });
    check(!r.guaranteed && !r.after.moves.some((m) => compact(m) === "grassyglide"), `rule off: Rillaboom should not be offered Grassy Glide back (${r.after.moves.join(", ")})`);
  }
  {
    const r = await without("tr", 0, { moves: ["Dazzling Gleam", "Trick Room", "Psychic", "Protect"] });
    check(offered(r).some((m) => compact(m) === "expandingforce"), "rule off: Hatterene should still be offered Expanding Force without Psychic Terrain; the gate check above would hold for the wrong reason");
  }
  console.log("7. guaranteed moves: kept at both depths, offered when missing, field gate both ways, and each check proved against the rule switched off");
}

// --- 8. the guaranteed move is part of what Apply changes -------------------------------------
// Two fixes from the review, both about the panel and its own numbers:
//   a) the headline "Matchup score X -> Y" and everything under it are measured from the set
//      the player actually saved (their own moves, Nature and spread), so the change covers
//      everything Apply writes - the guaranteed move the rule adds included. The search keeps
//      its own reference set (the saved moves with that move in), which is what "Moves tested"
//      is scored against;
//   b) the note "no Stat Point or Nature change scored clearly better" only appears when the
//      suggestion really leaves the spread and the Nature alone.
// The scores here come from a second objective built independently over the same team, not
// from anything the result carries.
{
  const reader = new DeepOptimizer(evaluation);
  const scorerFor = (sets, slot) => {
    const objective = new OptimizeObjective(new TeamOptimizer(evaluation), sets, slot, { topX: TOP });
    const plan = reader.planContext(objective);
    return (nature, bonuses, moves) => {
      const list = objective.moveSet((moves || []).filter(Boolean));
      return {
        score: objective.score(nature, bonuses, list, { rows: objective.rows }),
        counts: reader.counts(objective.score(nature, bonuses, list, { detail: true, rows: objective.rows }), plan),
      };
    };
  };

  // a) A saved set missing a guaranteed move: "Previously" is scored from the saved moves.
  for (const [team, slot, override, move] of [
    ["rough", 2, { moves: ["Fake Out", "Wood Hammer", "U-turn", "High Horsepower"] }, "Grassy Glide"],
    ["sun", 5, { moves: ["Make It Rain", "Focus Blast", "Thunderbolt", "Protect"] }, "Shadow Ball"],
  ]) {
    const sets = teamSets(team, slot, override);
    const set = sets[slot];
    const r = await new DeepOptimizer(evaluation).run(sets, slot, { depth: "quick", topX: TOP }, {});
    const label = `headline ${team}/${slot} ${set.species} (+${move})`;
    check((r.guaranteed?.added || []).some((a) => compact(a.move) === compact(move)), `${label}: the case no longer adds ${move}`);
    const scoreAt = scorerFor(sets, slot);
    // The saved set, the search's reference set (the saved moves with the guaranteed move
    // in place of the one it replaced) and the suggestion, all on this member's own board.
    const reference = override.moves.map((m) => ((r.guaranteed?.added || []).some((a) => compact(a.replaced) === compact(m)) ? move : m));
    const saved = scoreAt(set.nature, set.bonuses, override.moves);
    const withMove = scoreAt(set.nature, set.bonuses, reference);
    const suggested = scoreAt(r.after.nature, r.after.bonuses, r.after.moves);
    // The two references have to be far enough apart that this check can tell them apart.
    check(Math.abs(saved.score - withMove.score) > 0.25, `${label}: the saved set and the search's reference set score the same (${saved.score.toFixed(2)} vs ${withMove.score.toFixed(2)}) - pick another case, this check cannot fail`);
    check(Math.abs(r.before.score - saved.score) < 1e-6, `${label}: Previously is scored ${r.before.score.toFixed(2)}, the saved moves score ${saved.score.toFixed(2)} (the reference set with ${move} scores ${withMove.score.toFixed(2)})`);
    // What the added move alone is worth, which is what the card's explanation reads.
    check(Math.abs((r.guaranteed?.delta ?? NaN) - (withMove.score - saved.score)) < 1e-6, `${label}: adding ${move} alone is reported as ${Number(r.guaranteed?.delta).toFixed(2)}, it is worth ${(withMove.score - saved.score).toFixed(2)}`);
    check(Math.abs(r.after.score - suggested.score) < 1e-6, `${label}: Now is scored ${r.after.score.toFixed(2)}, the suggested set scores ${suggested.score.toFixed(2)}`);
    check(Math.abs(r.delta - (suggested.score - saved.score)) < 1e-6, `${label}: the headline change is ${r.delta.toFixed(2)}, everything Apply changes is worth ${(suggested.score - saved.score).toFixed(2)}`);
    // The chips over the table and the "What changes in battle" rows read the same side.
    check(JSON.stringify(r.before.counts) === JSON.stringify(saved.counts), `${label}: the counts beside Previously are ${JSON.stringify(r.before.counts)}, the saved moves give ${JSON.stringify(saved.counts)}`);
    const sum = (r.changes || []).reduce((total, c) => total + c.points, 0);
    check(Math.abs(sum - r.delta) < 0.25, `${label}: the change rows add up to ${sum.toFixed(2)}, the headline says ${r.delta.toFixed(2)}`);
    console.log(`   ${label.padEnd(42)} ${r.before.score.toFixed(2)} -> ${r.after.score.toFixed(2)} (${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(2)}); the search measured from ${withMove.score.toFixed(2)}`);
  }

  // a2) A set that already has its guaranteed moves reports exactly what it always did: its
  // own moves are the reference, so nothing above can shift an ordinary run.
  {
    const sets = teamSets("rough", 1);
    const set = sets[1];
    const r = await new DeepOptimizer(evaluation).run(sets, 1, { depth: "quick", topX: TOP }, {});
    check(!r.guaranteed, `no move added: ${set.species} should not need one (${JSON.stringify(r.guaranteed?.added || [])})`);
    const saved = scorerFor(sets, 1)(set.nature, set.bonuses, set.moves);
    check(Math.abs(r.before.score - saved.score) < 1e-6, `no move added: Previously is ${r.before.score.toFixed(2)}, its own moves score ${saved.score.toFixed(2)}`);
    check(JSON.stringify(r.before.counts) === JSON.stringify(saved.counts), `no move added: the counts beside Previously are ${JSON.stringify(r.before.counts)}, its own moves give ${JSON.stringify(saved.counts)}`);
  }

  // b) The rendered card: the note under Apply must not deny a change the table above shows.
  // Just enough DOM for ui.js h() and the Optimize card.
  {
    class El {
      constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.kids = [];
        this.attrs = {};
        this.listeners = {};
        this.dataset = {};
        this.style = { setProperty() {} };
        this.className = "";
      }
      setAttribute(key, value) { this.attrs[key] = String(value); }
      addEventListener(type, fn) { this.listeners[type] = fn; }
      append(...kids) { for (const kid of kids) this.kids.push(kid); }
      set innerHTML(value) { this.kids = [new Txt(String(value))]; }
      get classes() { return String(this.className || "").split(" ").filter(Boolean); }
      get classList() {
        const el = this;
        return {
          add: (name) => { el.className = [...new Set([...el.classes, name])].join(" "); },
          remove: (name) => { el.className = el.classes.filter((c) => c !== name).join(" "); },
          contains: (name) => el.classes.includes(name),
        };
      }
      replaceChildren(...kids) { this.kids = [...kids]; }
      get textContent() { return this.kids.map((kid) => kid.textContent).join(""); }
      all(cls) { const out = []; const walk = (el) => { for (const kid of el.kids) { if (kid.classes?.includes(cls)) out.push(kid); walk(kid); } }; walk(this); return out; }
    }
    class Txt extends El {
      constructor(text) { super("#text"); this.text = text; }
      get textContent() { return this.text; }
    }
    globalThis.Node = El;
    globalThis.document = { createElement: (tag) => new El(tag), createTextNode: (text) => new Txt(text) };
    const { optimizeView, OPTIMIZE_DEFAULTS } = await import("../builder/optimize-view.js");
    const noop = () => {};
    const cardFor = (set, result) => optimizeView({
      members: [{ slot: 0, name: set.species, sprite: "", set, state: { result }, kept: new Set() }],
      options: { ...OPTIMIZE_DEFAULTS, depth: "quick" }, topX: TOP, spriteFor: () => "",
      onOptions: noop, onRun: noop, onStop: noop, onApply: noop, onDiscard: noop, onKeepMove: noop,
    });
    const blockOf = (set, result) => cardFor(set, result).all("bd-opt-compare")[0]?.textContent || "";

    const sets = teamSets("rough", 2, { moves: ["Fake Out", "Wood Hammer", "U-turn", "High Horsepower"] });
    const real = await new DeepOptimizer(evaluation).run(sets, 2, { depth: "quick", topX: TOP }, {});
    check(real.moves_changed === true && (real.guaranteed?.added || []).length > 0, "card: the case no longer adds a guaranteed move");
    check(!(real.alternatives || []).some((a) => a.kind === "stats"), "card: the case now offers a Stat Points & Nature alternative, which hides the note - pick another");
    const spreadMoved = String(real.before.bonuses) !== String(real.after.bonuses) || real.before.nature !== real.after.nature;
    check(spreadMoved, "card: the case no longer changes the spread or the Nature - pick another, this check cannot fail");
    check(!/The spread stays as it is/.test(blockOf(sets[2], real)), `card: the block says the spread stays as it is over a change it shows (${real.before.nature} ${real.before.bonuses.join("/")} -> ${real.after.nature} ${real.after.bonuses.join("/")})`);

    // The same result with the spread and the Nature left alone: there it is the whole story,
    // so the block collapses to one spread instead of printing the same numbers twice.
    const kept = { ...real, after: { ...real.after, nature: real.before.nature, bonuses: [...real.before.bonuses] } };
    check(/The spread stays as it is/.test(blockOf(sets[2], kept)), `card: with only the moves changing the block does not say the spread stays as it is: "${blockOf(sets[2], kept).slice(0, 160)}"`);
    // A headline that comes out below the saved set's says why, and only then.
    const costLine = "scores less against the Top Meta than the move it replaces";
    check(real.delta < 0 && real.guaranteed.delta < 0, `card: the case no longer loses score to the added move (${real.delta.toFixed(2)}, the move alone ${Number(real.guaranteed?.delta).toFixed(2)}) - pick another`);
    check(cardFor(sets[2], real).textContent.includes(costLine), "card: a headline below the saved set's does not say the guaranteed move is why");
    const gains = { ...real, delta: Math.abs(real.delta), guaranteed: { ...real.guaranteed, delta: Math.abs(real.guaranteed.delta) } };
    check(!cardFor(sets[2], gains).textContent.includes(costLine), "card: a suggestion that scores better still blames the guaranteed move");

    // The "Stat Points & Nature" button applies the moves the search started from, which is
    // the saved set plus any move the rule added, so its label has to name that move: with
    // one added it may not promise Stat Points and the Nature "only".
    const statsAlt = { kind: "stats", nature: real.after.nature, nature_text: real.after.nature, bonuses: [...real.after.bonuses], speed: 0, moves: [...(real.after.moves || [])], score: real.after.score, delta: 1.2 };
    const buttons = (result) => cardFor(sets[2], result).all("ghost-button").map((el) => el.textContent);
    const added = (real.guaranteed?.added || []).map((a) => a.move);
    const withMove = buttons({ ...real, alternatives: [statsAlt] });
    check(withMove.some((t) => t.startsWith("Apply Stat Points, Nature & ") && added.every((m) => t.includes(m))),
      `card: the Stat Points & Nature button does not name the added ${added.join(", ")}: ${JSON.stringify(withMove)}`);
    check(!withMove.some((t) => t.includes("Apply Stat Points & Nature only")),
      `card: the Stat Points & Nature button still says "only" although it writes ${added.join(", ")}: ${JSON.stringify(withMove)}`);
    const noMove = buttons({ ...real, guaranteed: null, alternatives: [statsAlt] });
    check(noMove.some((t) => t.startsWith("Apply Stat Points & Nature only")),
      `card: with no move added the button should say "only": ${JSON.stringify(noMove)}`);
    console.log(`   card: the Stat Points & Nature button names the move it writes ("${withMove.find((t) => t.startsWith("Apply Stat Points"))}")`);
    console.log(`   card: "the spread stays as it is" only when it does (${real.before.nature} ${real.before.bonuses.join("/")} -> ${real.after.nature} ${real.after.bonuses.join("/")} does not print it); a lower score says why`);
  }
  console.log("8. the added guaranteed move counts towards the headline, the counts and the change rows; the block follows the spread");
}

// --- 9. what the panel says about a change ----------------------------------------------
//   a) every "What changes in battle" row sits on the side its own sentences say. The
//      matchup score may not decide it: it adds up every item set of a threat and both
//      sides of the fight at once, so it can rise while the one set the row shows only
//      has a sentence that says the Pokemon hits softer - and the row was then listed
//      under Better against its own words. A row that pulls both ways - in its own
//      sentences, or in the one-on-one chance beside them - is marked "both ways", and
//      one whose sentences split prints one of each;
//   b) the Previously and now block keeps every number (the Stat Points and the final
//      stat at level 50 on both sides, the total out of 66, both Natures with what each
//      raises and lowers), opens with a sentence assembled from those two sides, marks
//      only the stats that moved, says which way each one went with a tip on its bar as
//      well as an arrow and a sign, prints one spread instead of two when neither the
//      Nature nor a Stat Point moves, and never paints a direction: trading Speed for
//      bulk is a trade, not a loss. The Speed section opens on Normal, not on the team's
//      own Trick Room.
{
  let changeRows = 0;
  let trades = 0;
  let scoreDisagrees = 0;
  for (const run of runs) {
    for (const row of run.result.changes || []) {
      changeRows += 1;
      const good = row.lines.filter((l) => l.tone === "good");
      const bad = row.lines.filter((l) => l.tone === "bad");
      const said = row.lines.map((l) => `${l.tone}: ${l.text}`).join(" | ") || "(nothing)";
      const where = `${run.name}: #${row.rank} ${row.name}`;
      check(row.lines.length <= 2, `${where} prints ${row.lines.length} lines`);
      check(!(row.tone === "better" && bad.length && !good.length), `${where} is listed under Better and every line it shows says worse: ${said}`);
      check(!(row.tone === "worse" && good.length && !bad.length), `${where} is listed under Worse and every line it shows says better: ${said}`);
      // "Both ways" is every row that pulls in two directions: its own lines, or the
      // one-on-one chance printed beside them moving against the side it is listed on.
      const raceAgainst = Math.abs(row.win_after - row.win_before) >= 0.1 && (row.win_after > row.win_before) !== (row.tone === "better");
      check(Boolean(row.trade) === Boolean((good.length && bad.length) || raceAgainst),
        `${where} is${row.trade ? "" : " not"} marked "both ways" but shows ${said} with the 1-on-1 at ${Math.round(row.win_before * 100)}% → ${Math.round(row.win_after * 100)}%`);
      if (row.trade) {
        trades += 1;
        if (good.length && bad.length) check(good.length === 1 && bad.length === 1, `${where} is marked "both ways" but does not show one line of each: ${said}`);
      }
      if ((row.points > 0) !== (row.tone === "better")) scoreDisagrees += 1;
    }
  }
  check(changeRows > (quickOnly ? 10 : 40), `only ${changeRows} change rows to check`);
  // The whole point of the rule: the side a row is listed on is not the sign of its
  // matchup score. Without a row where the two differ the checks above cannot fail.
  if (!quickOnly) check(scoreDisagrees > 0, "no row is listed against the sign of its matchup score, so the side checks above cannot fail - pick another team");

  // b) the rendered block (the mini DOM from section 8 is still installed).
  const { optimizeView, OPTIMIZE_DEFAULTS } = await import("../builder/optimize-view.js");
  const walk = (node, fn) => { for (const kid of node.kids || []) { fn(kid); walk(kid, fn); } };
  const classesOf = (node) => String(node?.className || "").split(" ").filter(Boolean);
  const pick = (root, cls) => { const out = []; walk(root, (n) => { if (classesOf(n).includes(cls)) out.push(n); }); return out; };
  const noop = () => {};
  const cardFor = (set, result) => optimizeView({
    members: [{ slot: 0, name: set.species, sprite: "", set, state: { result }, kept: new Set() }],
    options: { ...OPTIMIZE_DEFAULTS, depth: "quick" }, topX: TOP, spriteFor: () => "",
    onOptions: noop, onRun: noop, onStop: noop, onApply: noop, onDiscard: noop, onKeepMove: noop,
  });
  const blockFor = (set, result) => pick(cardFor(set, result), "bd-opt-compare")[0];
  const labels = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];
  // The words the opening sentence uses, where the bars use the short labels above.
  const words = ["HP", "Attack", "Defense", "Special Attack", "Special Defense", "Speed"];
  const spread = runs.find((r) => r.result.ok && String(r.result.before.bonuses) === String(TEAMS.rough[0].bonuses));
  check(Boolean(spread), `card: no run over the rough Garchomp (${TEAMS.rough[0].bonuses.join("/")}) to draw - pick another case`);
  if (spread) {
    const { before, after } = spread.result;
    const set = teamSets("rough")[0];
    const compare = blockFor(set, spread.result);
    check(Boolean(compare), "card: the Previously and now block is missing");
    const text = compare?.textContent || "";
    const rows = pick(compare, "bd-opt-srow");
    const rowFor = (label) => rows.find((row) => (row.kids[0]?.textContent || "") === label);
    check(before.bonuses.some((v, i) => v !== after.bonuses[i]) && before.nature !== after.nature,
      `card: the case no longer changes the spread and the Nature (${before.nature} ${before.bonuses.join("/")} -> ${after.nature} ${after.bonuses.join("/")}) - the checks below cannot fail`);
    check(labels.some((_, i) => before.stats[i] === after.stats[i] && before.bonuses[i] === after.bonuses[i]),
      "card: the case no longer leaves a stat alone, so the check on the quiet rows cannot fail");
    for (const [i, label] of labels.entries()) {
      // Every number the old table had is still there: the Stat Points and the final stat,
      // on both sides ("22 · 183" now, "was 32 · 193" beside it).
      check(text.includes(`${before.bonuses[i]} · ${before.stats[i]}`), `card: the block does not show ${label} as it was, ${before.bonuses[i]} · ${before.stats[i]}`);
      check(text.includes(`${after.bonuses[i]} · ${after.stats[i]}`), `card: the block does not show ${label} as it now is, ${after.bonuses[i]} · ${after.stats[i]}`);
      const row = rowFor(label);
      check(Boolean(row), `card: no ${label} row`);
      if (!row) continue;
      const moved = before.bonuses[i] !== after.bonuses[i] || before.stats[i] !== after.stats[i];
      check(classesOf(row).includes(moved ? "changed" : "same"), `card: the ${label} row is marked ${classesOf(row).join(" ") || "nothing"} but it ${moved ? "moved" : "did not move"}`);
      const delta = after.stats[i] - before.stats[i];
      if (delta) {
        check(row.textContent.includes(delta > 0 ? "↑" : "↓"), `card: the ${label} row (${before.stats[i]} -> ${after.stats[i]}) shows no arrow for the way it went: "${row.textContent}"`);
        check(row.textContent.includes(`${delta > 0 ? "+" : "−"}${Math.abs(delta)}`), `card: the ${label} row does not print the change ${delta}: "${row.textContent}"`);
        // The bar's own tip carries the direction without colour: ink for the part it
        // gained, an outline past the end of the bar for the part it gave up.
        check(pick(row, delta > 0 ? "bd-opt-gain" : "bd-opt-loss").length === 1, `card: the ${label} bar has no tip for the ${delta > 0 ? "part it gained" : "part it gave up"}`);
        check(!pick(row, delta > 0 ? "bd-opt-loss" : "bd-opt-gain").length, `card: the ${label} bar carries the tip of the other direction`);
      } else if (!moved) {
        check(/same/.test(row.textContent), `card: the unchanged ${label} row does not say so: "${row.textContent}"`);
        check(!/[↑↓]/.test(row.textContent), `card: the unchanged ${label} row shows a direction arrow: "${row.textContent}"`);
      }
    }
    check(text.includes(`${before.total}/66`) && text.includes(`${after.total}/66`), `card: the Stat Point total out of 66 is gone (${before.total} -> ${after.total})`);
    // Both Natures, each with what it raises and lowers.
    const natures = pick(compare, "bd-opt-natures")[0];
    check(Boolean(natures) && natures.textContent.includes(before.nature) && natures.textContent.includes(after.nature),
      `card: the Nature panel does not name ${before.nature} and ${after.nature}: "${natures?.textContent || ""}"`);
    const natureText = natures?.textContent || "";
    for (const side of [before, after]) {
      const [up, down] = side.nature_effect || [-1, -1];
      if (up < 0) continue;
      check(natureText.includes(`▲${labels[up]}`) && natureText.includes(`▼${labels[down]}`),
        `card: the Nature panel does not say that ${side.nature} raises ${labels[up]} and lowers ${labels[down]}: "${natureText}"`);
    }
    // The sentence the block opens with is assembled from the two sides, never written by
    // hand, so it cannot drift from the bars: every stat it names moved, every stat that
    // moved is named, each number it prints is that stat's own change, and it only says
    // "paid for with" when there is both a gain and a cost.
    const lead = pick(compare, "bd-opt-story-lead")[0];
    check(Boolean(lead), "card: the block does not open with the change in a sentence");
    const said = lead?.textContent || "";
    // "Special Attack" ends in "Attack", so a stat only counts as named where its own
    // number sits in front of its own whole name.
    const namedAs = (size, word) => new RegExp(`(^|\\s)${size} (?:more |less )?${word}($|[\\s.,])`).test(said);
    let gains = 0;
    let costs = 0;
    for (const [i, word] of words.entries()) {
      const delta = after.stats[i] - before.stats[i];
      if (delta > 0) gains += 1;
      if (delta < 0) costs += 1;
      check(namedAs("\\d+", word) === Boolean(delta), `card: ${word} ${delta ? "moved but the sentence does not name it" : "did not move but the sentence names it"}: "${said}"`);
      if (delta) check(namedAs(Math.abs(delta), word), `card: the sentence does not give ${word} its own change of ${Math.abs(delta)}: "${said}"`);
    }
    check(gains > 0 && costs > 0, `card: the case is no longer a trade (${gains} up, ${costs} down), so the "paid for with" check cannot fail`);
    check(/paid for with/.test(said) === Boolean(gains && costs), `card: the sentence ${gains && costs ? "does not say" : "says"} "paid for with" for ${gains} stats up and ${costs} down: "${said}"`);
    check(said.includes(before.nature) && said.includes(after.nature), `card: the sentence does not name ${before.nature} and ${after.nature}: "${said}"`);
    // Under it, the quiet line that captions the two panels: the Stat Points, the Nature.
    const detail = pick(compare, "bd-opt-story-detail")[0];
    check(Boolean(detail) && /Stat Point/.test(detail.textContent), `card: the quiet line does not say where the Stat Points went: "${detail?.textContent}"`);
    // A stat change is not a good or a bad thing (less Speed for more bulk is a trade),
    // so the block may not use the green/red score chip for one.
    check(!pick(compare, "bd-opt-delta").length, "card: the Previously and now block marks a stat change with the good/bad score chip");
    console.log(`   card: ${before.nature} ${before.bonuses.join("/")} -> ${after.nature} ${after.bonuses.join("/")} reads as "${said}"`);

    // The shapes the block takes when less than everything moves. One search will not hand
    // us all three, so these are the real result with one side shaped: what is checked is
    // what the view does with each shape.
    const shaped = (over) => ({ ...spread.result, after: { ...spread.result.after, ...over } });

    // Only the Nature changes: both Natures, every number still there, and the budget bar
    // says outright that the points did not move.
    const natureOnly = blockFor(set, shaped({ bonuses: [...before.bonuses], total: before.total }));
    const nt = natureOnly?.textContent || "";
    check(!classesOf(natureOnly).includes("bd-opt-unchanged"), "card: a Nature change collapses the block, but a Nature change is a change");
    check(nt.includes(before.nature) && nt.includes(after.nature), `card: the Nature-only block does not name ${before.nature} and ${after.nature}`);
    check(/the same points, in the same stats/.test(nt), `card: the Nature-only block does not say the Stat Points stayed where they were: "${nt.slice(0, 200)}"`);
    check(nt.includes(`${before.total}/66`), "card: the Nature-only block drops the Stat Point total out of 66");
    for (const [i, label] of labels.entries()) {
      check(nt.includes(`${before.bonuses[i]} · ${after.stats[i]}`), `card: the Nature-only block does not show ${label} as ${before.bonuses[i]} · ${after.stats[i]}`);
    }

    // Nothing in the spread moves: no two-sided comparison at all. The same numbers side by
    // side would be the same numbers twice, so the set is printed once.
    const nothing = blockFor(set, shaped({ nature: before.nature, nature_effect: before.nature_effect, bonuses: [...before.bonuses], stats: [...before.stats], total: before.total }));
    const ut = nothing?.textContent || "";
    check(classesOf(nothing).includes("bd-opt-unchanged"), "card: with neither the Nature nor a Stat Point moving the block still prints two sides");
    check(/The spread stays as it is/.test(ut), `card: the unchanged block does not say so: "${ut.slice(0, 160)}"`);
    check(pick(nothing, "bd-opt-once").length === 1 && !pick(nothing, "bd-opt-srow").length, "card: the unchanged block still draws the two-sided comparison");
    check(!/[↑↓]/.test(ut) && !/was /.test(ut), `card: the unchanged block still marks a direction or prints a "was" side: "${ut.slice(0, 200)}"`);
    check(ut.includes(`${before.total}/66`), "card: the unchanged block drops the Stat Point total out of 66");
    check(ut.includes(before.nature), `card: the unchanged block does not name ${before.nature}`);
    for (const [i, label] of labels.entries()) {
      check(ut.includes(`${before.bonuses[i]} · ${before.stats[i]}`), `card: the unchanged block does not show ${label} as ${before.bonuses[i]} · ${before.stats[i]}`);
    }

    // The Speed section opens on Normal, whatever the team's own speed plan is, because the
    // heading above it ("Speed 97 → 120") reads Normal's numbers. The team's own context
    // stays one tap away.
    const tier = (name, rank, speed) => ({ name, species: name, form: "", item: "", variant: "", speed, rank });
    const trickRoomTeam = {
      ...spread.result,
      plan_context: { id: "trick-room", label: "Trick Room", trick_room: true },
      speed: {
        before: 97, after: 120, changed: true, top_meta: TOP,
        // Trick Room first, and the team's own plan: both of the ways the old code picked.
        contexts: [
          { id: "trick-room", label: "Trick Room", trick_room: true, before: 97, after: 120, now_faster: [], now_slower: [tier("Pelipper", 1, 117)], now_tied: [], still_faster: 0, still_slower: 1, still_tied: 0 },
          { id: "normal", label: "Normal", trick_room: false, before: 97, after: 120, now_faster: [tier("Pelipper", 1, 117)], now_slower: [], now_tied: [], still_faster: 1, still_slower: 0, still_tied: 0 },
        ],
      },
    };
    const speedCard = cardFor(set, trickRoomTeam);
    const speedLine = pick(speedCard, "bd-opt-speed-line")[0]?.textContent || "";
    check(/^Normal: Speed/.test(speedLine), `card: the Speed section does not open on Normal, it opens on "${speedLine}"`);
    const speedBlock = pick(speedCard, "bd-opt-speed")[0];
    check(Boolean(speedBlock) && speedBlock.textContent.includes("Trick Room"), "card: the team's own Trick Room tab is no longer reachable from the Speed section");
    console.log(`   card: the Speed section opens on "${speedLine}" for a Trick Room team, with its Trick Room tab beside it`);
  }
  // Direction is ink against no ink - a striped tip for the part a stat gained, a hollow
  // outline past the end of the bar for the part it gave up - plus ↑ ↓ plus the sign.
  // Never colour on its own: up is not always better, and the site ships one dark theme.
  {
    const css = readFileSync(join(root, "builder", "optimize.css"), "utf8");
    // (a match reaches back over whatever precedes its selector, comments included)
    const named = (selector) => selector.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ").trim();
    const marks = [...css.matchAll(/([^{}]*\.bd-opt-(?:gain|loss)\b[^{}]*)\{([^}]*)\}/g)];
    check(marks.length >= 2, "css: nothing draws what a stat gained or gave up at all - this check cannot fail");
    for (const [, selector, body] of marks) {
      check(!/var\(--bd-(?:good|bad)\)/.test(body), `css: ${named(selector)} paints what a stat gained or gave up with the good/bad colour (${body.trim()}); up is not always better`);
      check(/repeating-linear-gradient|dashed|dotted/.test(body), `css: ${named(selector)} separates a gain from a loss without a pattern (${body.trim()}); colour alone is not readable for everyone`);
      check(!/(^|;|\s)color\s*:/.test(body), `css: ${named(selector)} gives a gain or a loss its own text colour (${body.trim()})`);
    }
    const directional = [...css.matchAll(/([^{}]*\.bd-opt-(?:shift|gain|loss)[a-z-]*\.(?:up|down)[^{}]*)\{([^}]*)\}/g)];
    for (const [, selector, body] of directional) {
      check(!/(^|;|\s)(color|background|border-color)\s*:/.test(body), `css: ${named(selector)} paints the direction of a stat change (${body.trim()}); up is not always better and colour alone is not readable for everyone`);
    }
  }
  console.log(`9. ${changeRows} change rows all on the side their own lines say (${trades} marked "both ways", ${scoreDisagrees} against the sign of their score); the Previously and now block keeps every number`);
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
