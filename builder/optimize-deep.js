// Optimize (Team Evaluation > Optimize): a deep search for one team member's best
// Nature, Stat Points and attacking moves against the Top-X meta.
//
//  1. Natures: every Nature that does not lower the stat the member attacks with
//     (or its Speed, unless the team plays Trick Room), each tried on a set of
//     starting spreads: the current one, the most used ones, role templates and
//     "just enough Speed to pass X" spreads.
//  2. Stat Points: from the best starts of the best Natures, every transfer of
//     1-32 points between two stats is tried and the best one kept, until none helps
//     (each stat stays within 0-32, the total at 66).
//  3. Moves (optional): attacks the member can learn are ranked against the meta and
//     every combination for the free move slots is scored; support moves, pivots,
//     priority moves and the moves the team's weather or terrain is built around are
//     never swapped out, and locked-in, charging, situational and self-KO moves are
//     never suggested. The Stat Points are then tuned again for the best move sets.
//
// Every option is scored by builder/optimize-objective.js. A change is only worth it
// when it clearly scores better than what the set already has: another Nature, less
// Speed (more so the more of the meta it no longer outspeeds) and new moves each
// have to earn their place first (MARGINS), so a set is never turned upside down for
// a rounding gain. Two exceptions: a set over 66 Stat Points (a Showdown EV paste) is
// never kept, a legal spread is always suggested; and unused Stat Points are always
// spent, since that costs nothing. The search is budgeted (Quick / Deep), reports its
// progress and can be stopped: a stopped run returns the best result found so far.

import { SpeedTiers } from "./speed-tiers.js";
import { ATE_ABILITIES, MAX_BONUS_POINTS_PER_STAT, MAX_BONUS_STAT_POINTS, compact } from "./engine.js";
import { TeamOptimizer, identityKey } from "./team-optimize.js";
import { OptimizeObjective, WORKING_SET_RANKS } from "./optimize-objective.js";
import { DamageMemo, STAT_NAMES, fillPoints, legalPoints, natureIndices, pointTotal, pointsKey, tick, withSpeedPoints } from "./optimize-core.js";
import { UTILITY_ATTACKS, suggestBlock } from "./move-traits.js";

/**
 * How much better (in matchup-score points, 0-100) a change must score before it is
 * suggested: another Nature; any loss of Speed, plus `speedShare` times the share of
 * the Top-X Speed list no longer outsped; `perPoint` for every Stat Point taken
 * from a stat; new moves, plus `stab` when an attacking type of its own is lost and
 * `spread` for each move hitting both opponents that is dropped in Doubles, `role`
 * when a physical attacker's moves turn mostly special or the other way round (a
 * support Pokemon's move margin counts `supportMoves` times: its attacks are there
 * for their effect more than their damage); and `minimum` for any change at all.
 */
export const MARGINS = { nature: 0.4, speed: 1.5, speedShare: 15, perPoint: 0.04, moves: 2.0, stab: 2.5, spread: 1.5, role: 2.0, supportMoves: 2, minimum: 0.5 };

/**
 * The two search depths. The work is bounded by `evaluations` (spreads tried: the
 * Nature screening may use up to SCREEN_SHARE of them, the Stat Point search and the
 * re-tune for new moves the rest) and `combos` (move sets), so the same input always
 * gives the same answer; `seconds` is only a safety cap for slow devices (the Stat
 * Point search stops at 2.5x of it, or 1.75x when moves are still to be tested, the
 * move search at 2.5x). `usage`, `templates` and `speedStarts` say how many starting
 * spreads each Nature is tried on.
 */
export const DEPTHS = {
  quick: { seconds: 6, evaluations: 2500, natures: 2, starts: 1, beam: 1, amounts: [2, 4, 8, 16], movePool: 12, combos: 700, moveSets: 1, usage: 3, templates: 4, speedStarts: 3 },
  deep: { seconds: 25, evaluations: 12000, natures: 4, starts: 2, beam: 2, amounts: [1, 2, 3, 4, 6, 8, 12, 16, 24, 32], movePool: 16, combos: 3000, moveSets: 2, usage: 5, templates: 7, speedStarts: 8 },
};

const TEMPLATES = [[2, 32, 0, 0, 0, 32], [2, 0, 0, 32, 0, 32], [32, 32, 0, 0, 2, 0], [32, 0, 0, 32, 2, 0], [32, 0, 32, 0, 2, 0], [32, 0, 2, 0, 32, 0], [32, 2, 16, 0, 16, 0]];
const MEMO_MEMBERS = 1; // the member whose calcs stay cached for "Run again" (tens of MB)
const EPSILON = 1e-9;
const SCREEN_SHARE = 0.4; // of the evaluations, at most, for screening Natures and starts

class Stop extends Error {}

/** `next` in the slots of `original`: kept moves stay where they were, new ones fill the gaps. */
export function orderMoves(original, next) {
  const left = next.filter((m) => !original.some((x) => compact(x) === compact(m)));
  const out = original.map((m) => (next.some((x) => compact(x) === compact(m)) ? m : left.shift() || ""));
  return [...out.filter(Boolean), ...left].slice(0, 4);
}

const moveDiff = (from, to) => ({
  added: to.filter((m) => !from.some((x) => compact(x) === compact(m))),
  removed: from.filter((m) => !to.some((x) => compact(x) === compact(m))),
});

export class DeepOptimizer {
  /** @param {import("./team-payload.js").TeamEvaluation} evaluation */
  constructor(evaluation) {
    this.evaluation = evaluation;
    this.ev = evaluation.ev;
    this.engine = this.ev.engine;
    this.opt = new TeamOptimizer(evaluation);
    this.sg = this.opt.sg;
  }

  /** The damage memo of one member, kept on the evaluation so a second run starts warm. */
  memoFor(template) {
    const store = (this.evaluation.optimizeMemo ||= new Map());
    const key = identityKey(template);
    let memo = store.get(key);
    if (memo) store.delete(key);
    else memo = new DamageMemo();
    store.set(key, memo);
    while (store.size > MEMO_MEMBERS) store.delete(store.keys().next().value);
    return memo;
  }

  /** The moves a member can learn (the form's list, else another form's). */
  learnset(species, form) {
    const sets = this.engine.data?.learnsets || {};
    const [s, f] = this.engine.resolve(species, form || species);
    const direct = sets[`${s}|${f}`];
    if (direct?.length) return direct;
    for (const candidate of this.engine.speciesEntry(s)?.forms || []) {
      const list = sets[`${s}|${candidate.form}`];
      if (list?.length) return list;
    }
    return [];
  }

  /**
   * @param {Array<object|null>} sets   the team (builder sets, makeSet'd)
   * @param {number} slot
   * @param {{depth?: "quick"|"deep", testMoves?: boolean, keepNature?: boolean, keepSpeed?: boolean, lockedMoves?: string[], topX?: number}} options
   * @param {{onProgress?: (fraction:number, message:string, phase:string) => void, shouldStop?: () => boolean}} hooks
   */
  async run(sets, slot, options = {}, { onProgress, shouldStop } = {}) {
    const started = Date.now();
    const set = sets[slot];
    if (!set?.species) return { ok: false, message: "This slot is empty." };
    const depth = DEPTHS[options.depth] ? options.depth : "deep";
    const budget = DEPTHS[depth];
    const keepNature = Boolean(options.keepNature);
    const keepSpeed = Boolean(options.keepSpeed);
    const testMoves = options.testMoves !== false;
    const topX = Math.max(1, Number(options.topX) || Number(this.ev.settings.top_meta) || 30);

    const run = { stopped: false, outOfBudget: false, clockCut: false, evaluations: 0, phase: "board", lastTick: Date.now() };
    const report = (fraction, message) => onProgress?.(Math.max(0, Math.min(1, fraction)), message, run.phase);
    const pause = async () => {
      if (Date.now() - run.lastTick < 25) return;
      await tick();
      run.lastTick = Date.now();
      if (!run.stopped && shouldStop?.()) run.stopped = true;
      if (run.stopped) throw new Stop();
    };
    const searchEnd = started + budget.seconds * 1000 * (testMoves ? 1.75 : 2.5);
    const movesEnd = started + budget.seconds * 1000 * 2.5;
    // The counts bound the work; the clock only stops a device too slow to finish in time
    // (run.clockCut: then the answer may differ from a faster device's).
    const overBudget = () => {
      if (!run.outOfBudget) {
        if (run.evaluations >= budget.evaluations) run.outOfBudget = true;
        else if (Date.now() >= searchEnd) run.outOfBudget = run.clockCut = true;
      }
      return run.outOfBudget;
    };
    const screenLimit = budget.evaluations * SCREEN_SHARE;
    const screenOver = () => {
      if (run.evaluations >= screenLimit) return true;
      if (Date.now() < searchEnd) return false;
      run.clockCut = true;
      return true;
    };
    const movesOver = () => {
      if (Date.now() < movesEnd) return false;
      run.outOfBudget = run.clockCut = true;
      return true;
    };
    const guarded = async (work) => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof Stop) return null;
        throw error;
      }
    };

    // --- the member and its board ---------------------------------------------------------
    report(0, "Preparing the Top Meta threats…");
    const common = this.ev.commonSet(this.sg.usageName(set.species)) || {};
    const ownMoves = (set.moves || []).filter(Boolean).slice(0, 4);
    // A member without moves is tested with its most common moves; the result shows them as new.
    const currentMoves = (ownMoves.length ? ownMoves : common.moves || []).filter(Boolean).slice(0, 4);
    const movesFromCommon = !ownMoves.length && currentMoves.length > 0;
    const currentNature = this.engine.natures?.[set.nature] ? set.nature : "Serious";
    // The set's own Stat Points, each within 0-32. More than 66 in total (a Showdown EV
    // paste such as 252 HP / 4 Atk / 252 SpD) is not a legal spread: the search then
    // starts from the best legal version of it, and a legal spread is always suggested.
    const setPoints = Array.from({ length: 6 }, (_, i) => Math.max(0, Math.min(MAX_BONUS_POINTS_PER_STAT, Math.trunc(Number(set.bonuses?.[i]) || 0))));
    const setTotal = pointTotal(setPoints);
    const overBy = Math.max(0, setTotal - MAX_BONUS_STAT_POINTS);
    const member = { ...set, moves: currentMoves, nature: currentNature, bonuses: setPoints };
    const team = sets.map((s, i) => (i === slot ? member : s));
    const template = this.opt.monFor(member, slot, { nature_name: currentNature, bonuses: setPoints }, currentMoves);
    const memo = this.memoFor(template);
    memo.beginRun();
    const calcsBefore = memo.calcs;
    const objective = new OptimizeObjective(this.opt, team, slot, { memo, topX });
    if (!objective.rows.length) return { ok: false, message: "No meta matchups were available for this format." };
    await tick();

    const baseSet = objective.moveSet(currentMoves);
    const speedOf = (nature, points) => Math.trunc(this.engine.effectiveSpeed(objective.mon(nature, points), {})) || 1;
    const currentSpeed = speedOf(currentNature, setPoints);
    // Every option the search keeps is a legal spread (0-32 each, 66 in total at most).
    const allowed = (nature, points) => legalPoints(points) && (!keepSpeed || speedOf(nature, points) >= currentSpeed) && (!keepNature || nature === currentNature);
    // What a lower Speed costs a change (see MARGINS; nothing under the team's Trick Room).
    const speedCost = (nature, points) => {
      const speed = speedOf(nature, points);
      return speed < currentSpeed && objective.speedMode !== "trickroom" ? MARGINS.speed + MARGINS.speedShare * objective.speedLossShare(currentSpeed, speed) : 0;
    };
    // The reference every change is measured against: the set, made legal when it is not.
    const currentPoints = overBy ? this.legalStart(objective, currentNature, setPoints, baseSet, { keepSpeed, run, cost: speedCost }) : setPoints;

    // The matchup score, and the score a change has to beat after its margins.
    const raw = new Map();
    const bests = new Map(); // move set id -> its best option
    let bestRaw = null; // the best score of all, margins aside
    const score = (nature, points, moveSet) => {
      const key = `${nature}|${pointsKey(points)}|${moveSet.id}`;
      let value = raw.get(key);
      if (value === undefined) {
        value = objective.score(nature, points, moveSet);
        raw.set(key, value);
        run.evaluations += 1;
        const option = { nature, points: [...points], moveSet, score: value, value: value - penalty(nature, points, moveSet) };
        const known = bests.get(moveSet.id);
        if (allowed(nature, points) && (!known || option.value > known.value + EPSILON)) bests.set(moveSet.id, option);
        if (allowed(nature, points) && (!bestRaw || value > bestRaw.score + EPSILON)) bestRaw = option;
      }
      return value;
    };
    const ownTypes = new Set((this.engine.pokemon(template.pokemon_name, template.form_name)?.types || []).map(compact));
    // A Normal move under Pixilate, Aerilate and the like counts as the type it becomes.
    const ate = ATE_ABILITIES[String(template.ability || "").trim().toLowerCase()];
    const moveType = (record) => compact(ate && compact(record.type) === "normal" ? ate : record.type);
    const stabTypes = (moveSet) => new Set(moveSet.attacks.map(({ record }) => moveType(record)).filter((t) => ownTypes.has(t)));
    const baseStab = stabTypes(baseSet);
    const leaning = (moveSet) => {
      let physical = 0;
      let special = 0;
      for (const { record } of moveSet.attacks) {
        const category = String(record.category || "").toLowerCase();
        if (category === "physical") physical += 1;
        else if (category === "special") special += 1;
      }
      return physical > special ? "physical" : special > physical ? "special" : "mixed";
    };
    const baseLeaning = leaning(baseSet);
    function penalty(nature, points, moveSet) {
      let total = nature !== currentNature ? MARGINS.nature : 0;
      const speed = speedOf(nature, points);
      if (speed < currentSpeed && objective.speedMode !== "trickroom") total += MARGINS.speed + MARGINS.speedShare * objective.speedLossShare(currentSpeed, speed);
      let moved = 0;
      for (let i = 0; i < 6; i += 1) moved += Math.max(0, currentPoints[i] - points[i]);
      total += MARGINS.perPoint * moved;
      if (moveSet.id !== baseSet.id) {
        total += MARGINS.moves * (objective.support ? MARGINS.supportMoves : 1);
        const stab = stabTypes(moveSet);
        if ([...baseStab].some((t) => !stab.has(t))) total += MARGINS.stab;
        if (baseLeaning !== "mixed" && leaning(moveSet) !== baseLeaning) total += MARGINS.role;
        const kept = new Set(moveSet.attacks.map(({ move }) => compact(move)));
        total += MARGINS.spread * baseSet.attacks.filter((a) => a.spread && !kept.has(compact(a.move))).length;
      }
      return total;
    }
    const value = (nature, points, moveSet) => score(nature, points, moveSet) - penalty(nature, points, moveSet);

    const before = score(currentNature, currentPoints, baseSet);

    // --- 1. Natures ----------------------------------------------------------------------
    run.marks = { board: memo.requested };
    run.phase = "natures";
    const natures = this.natureList(currentNature, baseSet, objective, keepNature);
    if (objective.support) {
      // A support Pokemon is not turned into an attacker: no Nature that raises an attack
      // stat unless its own already does.
      const [up] = natureIndices(this.engine.natures, currentNature);
      if (up !== 1 && up !== 3) natures.splice(0, natures.length, ...natures.filter((n) => ![1, 3].includes(natureIndices(this.engine.natures, n)[0])));
    }
    const starts = this.starts(member, currentPoints, budget);
    const screened = [];
    await guarded(async () => {
      for (const [index, nature] of natures.entries()) {
        if (screenOver()) break;
        report(0.05 + (0.2 * index) / natures.length, `Trying ${nature} (${index + 1} of ${natures.length} Natures)`);
        const tried = [];
        for (const start of [...starts, ...this.speedStarts(nature, currentPoints, objective, budget.speedStarts)]) {
          if (!allowed(nature, start)) continue;
          tried.push([start, value(nature, start, baseSet)]);
          if (screenOver()) break;
          await pause();
        }
        tried.sort((a, b) => b[1] - a[1]);
        const distinct = [];
        for (const [points, v] of tried) if (!distinct.some(([p]) => pointsKey(p) === pointsKey(points))) distinct.push([points, v]);
        if (distinct.length) screened.push({ nature, starts: distinct.slice(0, budget.starts), value: distinct[0][1] });
      }
    });
    screened.sort((a, b) => b.value - a.value);
    const kept = screened.slice(0, budget.natures);
    const own = screened.find((n) => n.nature === currentNature);
    if (own && !kept.includes(own)) kept.push(own);

    // --- 2. Stat Points ------------------------------------------------------------------
    run.marks.natures = memo.requested;
    run.phase = "spreads";
    // `over` says when to stop: the Stat Point search's budget, or the re-tune's (below).
    const refine = async (nature, start, moveSet, from, to, label, over = overBudget) => {
      const first = allowed(nature, fillPoints(start)) ? fillPoints(start) : [...start];
      let beam = [[first, value(nature, first, moveSet)]];
      let best = beam[0];
      for (let round = 0; round < 40 && !over(); round += 1) {
        const found = new Map();
        // The budget is checked after every spread, so the counts bound this phase exactly
        // (a round cut short still keeps the best spread it found).
        scan: for (const [points] of beam) {
          for (let donor = 0; donor < 6; donor += 1) {
            if (!points[donor]) continue;
            for (let recipient = 0; recipient < 6; recipient += 1) {
              if (recipient === donor || points[recipient] >= MAX_BONUS_POINTS_PER_STAT) continue;
              for (const amount of budget.amounts) {
                if (amount > points[donor] || points[recipient] + amount > MAX_BONUS_POINTS_PER_STAT) continue;
                const next = [...points];
                next[donor] -= amount;
                next[recipient] += amount;
                const key = pointsKey(next);
                if (found.has(key) || !allowed(nature, next)) continue;
                found.set(key, [next, value(nature, next, moveSet)]);
                if (over()) break scan;
                await pause();
              }
            }
          }
        }
        const ranked = [...found.values()].sort((a, b) => b[1] - a[1]);
        if (!ranked.length || ranked[0][1] <= best[1] + EPSILON) break;
        best = ranked[0];
        beam = ranked.slice(0, budget.beam);
        report(from + (to - from) * Math.min(1, run.evaluations / budget.evaluations), `${label} · ${run.evaluations.toLocaleString("en-US")} spreads tried`);
      }
      return best;
    };
    await guarded(async () => {
      const jobs = kept.flatMap((n) => n.starts.map(([points]) => [n.nature, points]));
      for (const [index, [nature, start]] of jobs.entries()) {
        if (overBudget()) break;
        const from = 0.25 + (0.45 * index) / Math.max(1, jobs.length);
        const to = 0.25 + (0.45 * (index + 1)) / Math.max(1, jobs.length);
        await refine(nature, start, baseSet, from, to, `Tuning ${nature}`);
      }
    });

    // --- 3. Moves ------------------------------------------------------------------------
    run.marks.spreads = memo.requested;
    run.phase = "moves";
    let moveReport = null;
    if (testMoves && !run.stopped) {
      // The re-tune for new moves runs on what is left of the evaluations, against the
      // move search's clock (the Stat Point search's clock may already have passed by then).
      const retuneOver = () => {
        if (run.outOfBudget) return true;
        if (run.evaluations >= budget.evaluations) {
          run.outOfBudget = true;
          return true;
        }
        return movesOver();
      };
      moveReport = await guarded(() => this.testMoves({ objective, member, baseSet, budget, bests, score, value, refine, report, pause, overBudget: movesOver, retuneOver, options, kept }));
    }

    // --- the pick ------------------------------------------------------------------------
    run.marks.moves = memo.requested;
    run.phase = "final";
    report(0.9, "Checking the result against every threat…");
    const leader = [...bests.values()].sort((a, b) => b.value - a.value || b.score - a.score)[0];
    const keep = { nature: currentNature, points: currentPoints, moveSet: baseSet, score: before };
    let pick = leader ? this.trim(leader, score, value, allowed) : keep;

    // The whole Top X (the search may have used the 50 most common threats).
    const full = objective.rows.length !== objective.workingRows.length;
    const scoreAll = (nature, points, moveSet) => (full ? objective.score(nature, points, moveSet, { rows: objective.rows }) : score(nature, points, moveSet));
    const beforeAll = scoreAll(currentNature, currentPoints, baseSet);
    // The set as it is (its own spread even when that is over 66): the "Previously" side.
    const setAll = overBy ? objective.score(currentNature, setPoints, baseSet, { rows: objective.rows }) : beforeAll;
    let afterAll = scoreAll(pick.nature, pick.points, pick.moveSet);
    const same = (option) => option.nature === currentNature && pointsKey(option.points) === pointsKey(currentPoints) && option.moveSet.id === baseSet.id;
    // Only spends unused points: the same Nature and moves, no stat lower than before.
    const fillsOnly = (option) => option.nature === currentNature && option.moveSet.id === baseSet.id
      && option.points.every((v, i) => v >= currentPoints[i]) && pointTotal(option.points) > pointTotal(currentPoints);
    // Why a pick is suggested although it may not clear the minimum gain: the set is not
    // legal ("legal": a change is required anyway, so the best legal option after its
    // margins is taken, else the set's own spread made legal), or it only spends points
    // the set leaves unused ("fill").
    let kind = overBy ? "legal" : "";
    if (overBy && (same(pick) || afterAll < beforeAll - EPSILON)) {
      pick = keep;
      afterAll = beforeAll;
    } else if (!overBy && (same(pick) || afterAll < beforeAll + MARGINS.minimum)) {
      // Not clearly better. Unused Stat Points are still worth spending: they cost nothing.
      const fill = setTotal < MAX_BONUS_STAT_POINTS ? (fillsOnly(pick) ? pick : this.fillUnspent(currentNature, currentPoints, baseSet, score, allowed)) : null;
      const fillAll = fill ? scoreAll(fill.nature, fill.points, fill.moveSet) : -Infinity;
      if (fill && fillAll >= beforeAll - EPSILON) {
        pick = fill;
        afterAll = fillAll;
        kind = "fill";
      } else {
        pick = keep;
        afterAll = beforeAll;
      }
    } else if (!overBy && fillsOnly(pick)) {
      kind = "fill";
    }
    const statsOnly = pick.moveSet.id !== baseSet.id ? bests.get(baseSet.id) : null;
    const result = this.describe({
      objective, member, template, currentNature, setPoints, setTotal, baseSet, pick, setAll, beforeAll, afterAll, moveReport, statsOnly, scoreAll, kind, movesFromCommon,
    });
    if (run.stopped && !result.ok) result.message = "Stopped before anything clearly better was found. Run it again and let it finish for the full search.";
    result.trade_off = this.tradeOff({ objective, bestRaw, pick, baseSet, beforeAll, setAll, afterAll, scoreAll, speedOf, suggested: result.ok });
    result.stats = {
      depth, spreads: run.evaluations, natures: screened.length, move_sets: moveReport?.combos || 0, calcs: memo.calcs - calcsBefore, calc_requests: memo.requested, phase_calcs: run.marks,
      seconds: (Date.now() - started) / 1000, top_meta: objective.topX, threat_sets: objective.rows.length,
      working_set: objective.workingRows.length, working_ranks: Math.min(objective.topX, WORKING_SET_RANKS), stopped: run.stopped, out_of_budget: run.outOfBudget,
      clock_cut: run.clockCut, contexts: objective.contexts.map((c) => c.label), support: objective.support,
    };
    report(1, run.stopped ? "Stopped" : "Done");
    return result;
  }

  // --- search pieces ----------------------------------------------------------------------

  natureList(current, moveSet, objective, keepNature) {
    if (keepNature) return [current];
    const natures = this.engine.natures || {};
    const physical = moveSet.attacks.some(({ record }) => String(record.category || "").toLowerCase() === "physical");
    const special = moveSet.attacks.some(({ record }) => String(record.category || "").toLowerCase() === "special");
    const room = objective.speedMode === "trickroom";
    const out = [current];
    let neutral = natureIndices(natures, current)[0] < 0;
    for (const name of Object.keys(natures)) {
      const [up, down] = natureIndices(natures, name);
      if (up < 0) {
        if (!neutral) out.push(natures.Serious ? "Serious" : name);
        neutral = true;
        continue;
      }
      if (physical && !special && down === 1) continue;
      if (special && !physical && down === 3) continue;
      if (down === 5 && !room) continue;
      if (up === 5 && room) continue;
      out.push(name);
    }
    return [...new Set(out)];
  }

  starts(member, currentPoints, budget) {
    const out = [fillPoints(currentPoints)];
    const record = this.ev.record(this.sg.usageName(member.species));
    for (const [, points] of (record?.spreads || []).slice(0, budget.usage)) if (Array.isArray(points)) out.push(fillPoints(points));
    for (const points of TEMPLATES.slice(0, budget.templates)) out.push(fillPoints(points));
    const seen = new Set();
    return out.filter((p) => !seen.has(pointsKey(p)) && seen.add(pointsKey(p)));
  }

  /** "Just enough Speed" starts: the fewest Speed points that pass each of the most common threats in reach. */
  speedStarts(nature, currentPoints, objective, limit = 8) {
    if (objective.speedMode === "trickroom") return [withSpeedPoints(fillPoints(currentPoints), 0)];
    const speeds = [];
    for (let sp = 0; sp <= MAX_BONUS_POINTS_PER_STAT; sp += 1) {
      const points = [...currentPoints];
      points[5] = sp;
      speeds.push(Math.trunc(this.engine.effectiveSpeed(objective.mon(nature, points), {})) || 1);
    }
    const targets = new Map();
    for (const row of objective.workingRows) {
      const theirs = row.speeds[0];
      if (theirs < speeds[0] || theirs >= speeds[MAX_BONUS_POINTS_PER_STAT]) continue;
      targets.set(theirs, (targets.get(theirs) || 0) + row.weight);
    }
    const out = [];
    for (const [theirs] of [...targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
      const sp = speeds.findIndex((s) => s > theirs);
      if (sp >= 0) out.push(withSpeedPoints(fillPoints(currentPoints), sp));
    }
    return out;
  }

  /**
   * Lower attack points that change nothing (a stray 3 Atk on a special attacker) and
   * give them where they help most, else to HP and the defences.
   */
  trim(option, score, value, allowed) {
    const { nature, moveSet } = option;
    let points = [...option.points];
    let freed = 0;
    for (const stat of [1, 3]) {
      while (points[stat] > 0) {
        const next = [...points];
        next[stat] -= 1;
        if (score(nature, next, moveSet) < score(nature, points, moveSet) - EPSILON) break;
        points = next;
        freed += 1;
      }
    }
    while (freed > 0) {
      let best = null;
      for (const stat of [0, 2, 4, 5, 1, 3]) {
        if (points[stat] >= MAX_BONUS_POINTS_PER_STAT) continue;
        const next = [...points];
        next[stat] += 1;
        if (!allowed(nature, next)) continue;
        const v = value(nature, next, moveSet);
        if (!best || v > best[1] + EPSILON) best = [next, v];
      }
      if (!best) break;
      points = best[0];
      freed -= 1;
    }
    const trimmed = { ...option, points, score: score(nature, points, moveSet), value: value(nature, points, moveSet) };
    return trimmed.value >= option.value - EPSILON ? trimmed : option;
  }

  /** Test new attacks in the free move slots, then re-tune the spread for the best sets. */
  async testMoves({ objective, member, baseSet, budget, bests, score, value, refine, report, pause, overBudget, retuneOver = overBudget, options, kept }) {
    const leader = bests.get(baseSet.id);
    if (!leader) return null;
    const userLocked = new Set((options.lockedMoves || []).map(compact));
    const planMoves = objective.fieldPlanMoves();
    const lockReason = (move) => {
      const k = compact(move);
      if (userLocked.has(k)) return "kept by you";
      if (!this.opt.damaging(move)) return "support move";
      if (UTILITY_ATTACKS.has(k)) return "utility attack";
      if (this.ev.movePriority(move) > 0) return "priority move";
      if (planMoves.has(k)) return "works with your team's field";
      return "";
    };
    const moves = member.moves;
    const lockedMoves = moves.filter((m) => lockReason(m));
    const freeMoves = moves.filter((m) => !lockReason(m));
    const slots = 4 - lockedMoves.length;
    const out = { kept: lockedMoves.map((move) => ({ move, reason: lockReason(move) })), free: slots, tested: 0, combos: 0, results: [], note: "" };
    if (slots <= 0) {
      out.note = "Every move does a job the damage numbers cannot see, so all four were kept.";
      return out;
    }
    const types = new Set((this.engine.pokemon(objective.template.pokemon_name, objective.template.form_name)?.types || []).map(compact));
    const excluded = new Set(String(this.ev.settings.exclude_moves || "").split(/[,;]/).map((m) => compact(m)).filter(Boolean));
    const learnable = new Map();
    for (const name of this.learnset(member.species, member.form || member.species)) {
      const move = this.engine.canonicalMoveName(name);
      const record = this.engine.moveRecord(move);
      const k = compact(move);
      if (!record || !this.opt.damaging(move) || excluded.has(k) || lockedMoves.some((m) => compact(m) === k)) continue;
      if (UTILITY_ATTACKS.has(k) || this.ev.movePriority(move) > 0) continue; // kept when present, never added
      if (suggestBlock(record, { sun: objective.sunTeam, rain: objective.rainTeam, stab: types.has(compact(record.type)), doubles: objective.doubles })) continue;
      learnable.set(k, move);
    }
    const usage = this.sg.usage(member.species, "move", 12).map((m) => learnable.get(compact(m))).filter(Boolean).slice(0, 8);
    report(0.7, `Ranking the ${learnable.size} attacks ${member.species} can learn…`);
    const ranked = [];
    for (const move of learnable.values()) {
      if (overBudget()) break;
      ranked.push([move, objective.moveValue(move, leader.nature, leader.points)]);
      await pause();
    }
    ranked.sort((a, b) => b[1] - a[1]);
    const pool = [...new Set([...freeMoves, ...ranked.slice(0, budget.movePool).map(([m]) => m), ...usage])];
    const choose = (n, k) => {
      let c = 1;
      for (let i = 0; i < k; i += 1) c = (c * (n - i)) / (i + 1);
      return c;
    };
    while (pool.length > slots && choose(pool.length, slots) > budget.combos) {
      // Drop the lowest-ranked candidate that is not one of the current moves.
      let index = -1;
      for (let i = pool.length - 1; i >= 0; i -= 1) if (!freeMoves.includes(pool[i])) {
        index = i;
        break;
      }
      if (index < 0) break;
      pool.splice(index, 1);
    }
    out.tested = pool.length;
    const size = Math.min(slots, pool.length);
    const combos = [];
    const pick = (start, chosen) => {
      if (chosen.length === size) {
        combos.push([...chosen]);
        return;
      }
      for (let i = start; i < pool.length; i += 1) pick(i + 1, [...chosen, pool[i]]);
    };
    pick(0, []);
    const current = score(leader.nature, leader.points, baseSet);
    const results = [];
    for (const [index, combo] of combos.entries()) {
      if (overBudget()) {
        out.combos = index;
        break;
      }
      const moveSet = objective.moveSet([...lockedMoves, ...combo]);
      if (moveSet.id !== baseSet.id) results.push({ moveSet, score: score(leader.nature, leader.points, moveSet) });
      if (index % 25 === 0) report(0.72 + (0.12 * index) / combos.length, `Testing move sets · ${index.toLocaleString("en-US")} of ${combos.length.toLocaleString("en-US")}`);
      await pause();
    }
    out.combos ||= combos.length;
    results.sort((a, b) => b.score - a.score);
    // Re-tune the spread for the best new move sets: a new attack may want other stats.
    const natures = [leader.nature, ...kept.map((n) => n.nature)].filter((n, i, a) => a.indexOf(n) === i).slice(0, 2);
    for (const [index, option] of results.slice(0, budget.moveSets).entries()) {
      if (option.score < current + 0.5 * MARGINS.moves || retuneOver()) break;
      for (const nature of natures) {
        await refine(nature, leader.points, option.moveSet, 0.84 + 0.03 * index, 0.87 + 0.03 * index, `Re-tuning for ${option.moveSet.moves.join(", ")}`, retuneOver);
      }
    }
    out.current = current;
    out.results = results.slice(0, 6);
    out.spread = { nature: leader.nature, bonuses: [...leader.points] };
    return out;
  }

  /**
   * The best-scoring option the margins held back (a lower Speed, another Nature or new
   * moves that did not score clearly enough better), so the player can still weigh it.
   * Its reasons are what it changes compared with the pick (the suggested change, or
   * the current set when nothing is suggested), so nothing the two share is listed.
   */
  tradeOff({ objective, bestRaw, pick, baseSet, beforeAll, setAll, afterAll, scoreAll, speedOf, suggested }) {
    if (!bestRaw) return null;
    const same = bestRaw.nature === pick.nature && pointsKey(bestRaw.points) === pointsKey(pick.points) && bestRaw.moveSet.id === pick.moveSet.id;
    if (same) return null;
    const value = scoreAll(bestRaw.nature, bestRaw.points, bestRaw.moveSet);
    if (value < afterAll + 0.5 || value < beforeAll + 1) return null;
    const speed = speedOf(bestRaw.nature, bestRaw.points);
    const pickSpeed = speedOf(pick.nature, pick.points);
    const list = objective.speedList();
    const lost = speed < pickSpeed ? list.filter((s) => pickSpeed > s && speed <= s).length : 0;
    const reasons = [];
    // Under the team's Trick Room less Speed is the plan, not a cost.
    if (speed < pickSpeed && objective.speedMode !== "trickroom") reasons.push(`Speed ${pickSpeed} → ${speed}${lost ? `: slower than ${lost} more of the Top ${objective.topX} Speed list` : ""}`);
    if (bestRaw.nature !== pick.nature) reasons.push(`${this.natureText(bestRaw.nature)} instead of ${pick.nature}`);
    const diff = moveDiff(pick.moveSet.moves, bestRaw.moveSet.moves);
    if (diff.added.length) reasons.push(diff.removed.length ? `${diff.added.join(" and ")} in place of ${diff.removed.join(" and ")}` : `adds ${diff.added.join(" and ")}`);
    let moved = 0;
    for (let i = 0; i < 6; i += 1) moved += Math.max(0, pick.points[i] - bestRaw.points[i]);
    if (moved >= 12 || (moved > 0 && !reasons.length)) reasons.push(`${moved} Stat Point${moved === 1 ? "" : "s"} moved`);
    return {
      nature: bestRaw.nature, nature_text: this.natureText(bestRaw.nature), bonuses: [...bestRaw.points],
      moves: orderMoves(baseSet.moves, bestRaw.moveSet.moves), speed, score: value, delta: value - setAll, over_pick: value - afterAll, reasons,
      compared_with: suggested ? "suggestion" : "current",
    };
  }

  /**
   * A spread over 66 Stat Points made legal: one point at a time (four while far over)
   * is taken from the stat that loses least by it, lost Speed costing its margin
   * (`cost`), the least invested first on a tie (a stray 4 Atk), never Speed with Keep
   * Speed on.
   */
  legalStart(objective, nature, points, moveSet, { keepSpeed = false, run, cost = () => 0 }) {
    let out = [...points];
    let over = pointTotal(out) - MAX_BONUS_STAT_POINTS;
    while (over > 0) {
      const amount = over > 12 ? 4 : 1;
      const order = [0, 1, 2, 3, 4, 5].filter((stat) => out[stat] > 0 && !(keepSpeed && stat === 5)).sort((a, b) => out[a] - out[b] || a - b);
      let best = null;
      for (const stat of order) {
        const cut = Math.min(amount, out[stat], over);
        const next = [...out];
        next[stat] -= cut;
        const v = objective.score(nature, next, moveSet) - cost(nature, next);
        run.evaluations += 1;
        if (!best || v > best[1] + EPSILON) best = [next, v, cut];
      }
      if (!best) return fillPoints(out);
      out = best[0];
      over -= best[2];
    }
    return out;
  }

  /** The set's unused Stat Points, spent a few at a time where they score best (nothing else changes). */
  fillUnspent(nature, points, moveSet, score, allowed) {
    let out = [...points];
    let left = MAX_BONUS_STAT_POINTS - pointTotal(out);
    while (left > 0) {
      const amount = left > 12 ? 4 : 1;
      let best = null;
      for (const stat of [0, 2, 4, 1, 3, 5]) {
        const add = Math.min(amount, left, MAX_BONUS_POINTS_PER_STAT - out[stat]);
        if (add <= 0) continue;
        const next = [...out];
        next[stat] += add;
        if (!allowed(nature, next)) continue;
        const v = score(nature, next, moveSet);
        if (!best || v > best[1] + EPSILON) best = [next, v, add];
      }
      if (!best) break;
      out = best[0];
      left -= best[2];
    }
    if (pointsKey(out) === pointsKey(points)) return null;
    return { nature, points: out, moveSet, score: score(nature, out, moveSet) };
  }

  // --- the result ---------------------------------------------------------------------------

  natureText(name) {
    const [up, down] = natureIndices(this.engine.natures, name);
    return up < 0 ? `${name} (neutral)` : `${name} (+${STAT_NAMES[up]} −${STAT_NAMES[down]})`;
  }

  side(objective, nature, points, moveSet, value, counts) {
    const mon = objective.mon(nature, points);
    const effective = this.engine.effectiveMegaMon(mon);
    const fs = this.engine.finalStats(mon);
    const [up, down] = natureIndices(this.engine.natures, nature);
    return {
      nature, nature_text: this.natureText(nature), nature_effect: [up, down],
      bonuses: [...points], total: pointTotal(points),
      stats: [fs.hp, fs.attack, fs.defense, fs.sp_attack, fs.sp_defense, fs.speed],
      speed: Math.trunc(this.engine.effectiveSpeed(mon, {})) || 1,
      form: effective.form_name, moves: orderMoves(this.baseMoves || moveSet.moves, moveSet.moves), score: value, counts,
    };
  }

  /**
   * The speed context the team plays for: the one the score weighs most (normal play,
   * or Trick Room for a Trick Room team), where "moves first" is read.
   */
  planContext(objective) {
    let index = 0;
    objective.contexts.forEach((context, i) => {
      if (context.weight > objective.contexts[index].weight + EPSILON) index = i;
    });
    const context = objective.contexts[index];
    return { index, id: context.id, label: context.label, trick_room: Boolean(context.trickRoom) };
  }

  /**
   * How many threats (their most common set) we survive a hit from, OHKO, 2HKO and move
   * before on Speed alone (in the team's speed plan: under Trick Room the slower moves first).
   */
  counts(detail, plan) {
    const firsts = detail.per.filter(({ row }) => row.variant === 0);
    return {
      threats: firsts.length,
      survives: firsts.filter(({ inc }) => inc.prof[1] < 0.5).length,
      ohkos: firsts.filter(({ out }) => out.prof[1] >= 0.5).length,
      twohkos: firsts.filter(({ out }) => out.prof[2] >= 0.5).length,
      outspeeds: firsts.filter(({ contexts }) => {
        const c = contexts[plan.index];
        return c.ours !== c.theirs && (c.ours > c.theirs) !== plan.trick_room;
      }).length,
    };
  }

  describe({ objective, member, template, currentNature, setPoints, setTotal, baseSet, pick, setAll, beforeAll, afterAll, moveReport, statsOnly, scoreAll, kind, movesFromCommon }) {
    const rows = objective.rows;
    this.baseMoves = baseSet.moves;
    const plan = this.planContext(objective);
    // "Previously" is the set as it is: its own spread, and no moves when it had none.
    const beforeDetail = objective.score(currentNature, setPoints, baseSet, { detail: true, rows });
    const afterDetail = objective.score(pick.nature, pick.points, pick.moveSet, { detail: true, rows });
    const before = this.side(objective, currentNature, setPoints, baseSet, setAll, this.counts(beforeDetail, plan));
    const after = this.side(objective, pick.nature, pick.points, pick.moveSet, afterAll, this.counts(afterDetail, plan));
    if (movesFromCommon) before.moves = [];
    const movesChanged = pick.moveSet.id !== baseSet.id || movesFromCommon;
    const changed = movesChanged || pick.nature !== currentNature || pointsKey(pick.points) !== pointsKey(setPoints);
    const unspent = Math.max(0, MAX_BONUS_STAT_POINTS - setTotal);
    const result = {
      ok: changed && (afterAll >= beforeAll + MARGINS.minimum || kind === "legal" || kind === "fill"),
      member: { species: member.species, form: member.form || member.species, item: member.item || "", name: this.sg.name(template.form_name || template.pokemon_name) },
      before, after, delta: afterAll - setAll, moves_changed: movesChanged,
      ...moveDiff(before.moves, after.moves),
      support: objective.support,
      contexts: objective.contexts.map(({ id, label, weight }) => ({ id, label, weight })),
      plan_context: plan,
      // The set's Stat Point total, what it is over 66 or leaves unused, and why the pick is
      // suggested when that is the reason ("legal", "fill").
      points: { total: setTotal, over: Math.max(0, setTotal - MAX_BONUS_STAT_POINTS), unspent, kind },
      moves_from_common: movesFromCommon ? [...baseSet.moves] : null,
    };
    if (!result.ok) {
      result.message = "Your current set already plays these matchups best: no Stat Point, Nature or move change we tried did clearly better.";
      if (unspent) result.message += ` Its ${unspent} unused Stat Point${unspent === 1 ? "" : "s"} did not help in any stat either.`;
      if (movesFromCommon) result.message += ` It has no moves yet, so it was tested with its most common ones (${baseSet.moves.join(", ")}).`;
    }
    result.changes = this.changes(objective, beforeDetail, afterDetail, plan);
    result.speed = this.speedLists(objective, member, currentNature, setPoints, pick);
    result.alternatives = [];
    if (statsOnly && movesChanged && !movesFromCommon) {
      const value = scoreAll(statsOnly.nature, statsOnly.points, baseSet);
      if (value >= beforeAll + MARGINS.minimum || (kind === "legal" && value >= beforeAll - EPSILON)) {
        result.alternatives.push({
          kind: "stats", nature: statsOnly.nature, nature_text: this.natureText(statsOnly.nature), bonuses: [...statsOnly.points], speed: statsOnly.points ? Math.trunc(this.engine.effectiveSpeed(objective.mon(statsOnly.nature, statsOnly.points), {})) || 1 : 0,
          moves: [...baseSet.moves], score: value, delta: value - setAll,
        });
      }
    }
    result.moves_tested = moveReport ? {
      free: moveReport.free, tested: moveReport.tested, combos: moveReport.combos, note: moveReport.note, kept: moveReport.kept,
      spread: moveReport.spread || null,
      options: (moveReport.results || []).slice(0, 3).map(({ moveSet, score }) => ({
        moves: orderMoves(baseSet.moves, moveSet.moves), delta: score - (moveReport.current ?? score), ...moveDiff(baseSet.moves, moveSet.moves),
      })),
    } : null;
    return result;
  }

  /**
   * What changes in battle, threat by threat (its most changed set), biggest first. Who
   * moves first and the one-on-one race are read in the team's speed plan (`plan`).
   */
  changes(objective, beforeDetail, afterDetail, plan = this.planContext(objective)) {
    const groups = new Map();
    beforeDetail.per.forEach((b, i) => {
      const a = afterDetail.per[i];
      const row = b.row;
      const group = groups.get(row.rank) || { weight: 0, pick: null, pickDelta: -1 };
      group.weight += row.weight * (a.value - b.value);
      if (Math.abs(a.value - b.value) > group.pickDelta) {
        group.pick = [b, a];
        group.pickDelta = Math.abs(a.value - b.value);
      }
      groups.set(row.rank, group);
    });
    const total = beforeDetail.per.reduce((sum, p) => sum + p.row.weight, 0) || 1;
    const out = [];
    for (const group of groups.values()) {
      const [b, a] = group.pick;
      const lines = this.changeLines(objective, b, a, plan);
      const winBefore = b.contexts[plan.index].race;
      const winAfter = a.contexts[plan.index].race;
      if (Math.abs(group.weight) * 100 / total < 0.005) continue;
      if (!lines.length && Math.abs(winAfter - winBefore) < 0.1) continue;
      const row = b.row;
      out.push({
        rank: row.rank, name: row.name, species: row.species, form: row.form, item: row.item,
        points: (100 * group.weight) / total, tone: group.weight > 0 ? "better" : "worse",
        lines: lines.filter((l) => (group.weight > 0 ? l.tone === "good" : l.tone === "bad")).concat(lines.filter((l) => (group.weight > 0 ? l.tone !== "good" : l.tone !== "bad"))).slice(0, 2),
        win_before: winBefore, win_after: winAfter,
      });
    }
    out.sort((x, y) => Math.abs(y.points) - Math.abs(x.points));
    return out;
  }

  changeLines(objective, b, a, plan = this.planContext(objective)) {
    const lines = [];
    const threatHp = (x) => Math.trunc(x.out.raw?.current_hp || x.out.raw?.max_hp || 0);
    // Their attack on us.
    if (a.inc.move || b.inc.move) {
      const was = objective.koLabel(b.inc.move, b.inc.raw, b.hp);
      const now = objective.koLabel(a.inc.move, a.inc.raw, a.hp);
      const move = a.inc.move || b.inc.move;
      const detail = `${was.label} → ${now.label}`;
      if (was.hits === 1 && now.hits > 1) lines.push({ tone: "good", text: `Now survives ${move}`, detail });
      else if (was.hits > 1 && now.hits === 1) lines.push({ tone: "bad", text: `Now knocked out in one hit by ${move}`, detail });
      else if (was.hits === 2 && now.hits > 2) lines.push({ tone: "good", text: `Now survives two hits of ${move}`, detail });
      else if (was.hits > 2 && was.hits < 99 && now.hits === 2) lines.push({ tone: "bad", text: `Now knocked out in two hits by ${move}`, detail });
      else if (was.hits === now.hits && now.hits <= 3 && Math.abs(now.chance - was.chance) >= 0.15) {
        lines.push({ tone: now.chance < was.chance ? "good" : "bad", text: now.chance < was.chance ? `Takes ${move} better` : `Takes more from ${move}`, detail });
      }
    }
    // Our attack on them.
    if (a.out.move || b.out.move) {
      const was = objective.koLabel(b.out.move, b.out.raw, threatHp(b));
      const now = objective.koLabel(a.out.move, a.out.raw, threatHp(a));
      const move = a.out.move || b.out.move;
      const detail = `${was.label} → ${now.label}`;
      if (now.hits === 1 && was.hits > 1) lines.push({ tone: "good", text: `Now OHKOs with ${move}`, detail });
      else if (was.hits === 1 && now.hits > 1) lines.push({ tone: "bad", text: `No longer OHKOs with ${b.out.move || move}`, detail });
      else if (now.hits === 2 && was.hits > 2) lines.push({ tone: "good", text: `Now 2HKOs with ${move}`, detail });
      else if (was.hits === 2 && now.hits > 2) lines.push({ tone: "bad", text: `No longer 2HKOs with ${b.out.move || move}`, detail });
      else if (was.hits === now.hits && now.hits <= 3 && Math.abs(now.chance - was.chance) >= 0.15) {
        lines.push({ tone: now.chance > was.chance ? "good" : "bad", text: now.chance > was.chance ? `Hits harder with ${move}` : `Hits softer with ${move}`, detail });
      }
    }
    // Who moves first (same priority) in the team's speed plan: under the team's Trick
    // Room the slower Pokemon moves first, so slowing down there reads as a gain.
    const pb = b.contexts[plan.index];
    const pa = a.contexts[plan.index];
    const bf = pb.first;
    const af = pa.first;
    if (bf !== af && b.out.prio === b.inc.prio && a.out.prio === a.inc.prio) {
      const where = plan.trick_room ? " in Trick Room" : plan.index ? ` (${plan.label})` : "";
      const detail = `Speed ${pb.ours} → ${pa.ours} vs ${pa.theirs}`;
      if (af > bf) lines.push({ tone: "good", text: af > 0 ? `Now moves first${where}` : `Now ties on Speed${where}`, detail });
      else lines.push({ tone: "bad", text: af < 0 ? `Now moves second${where}` : `Now ties on Speed${where}`, detail });
    }
    return lines;
  }

  /** The Top-X Speed list rows now passed and now lost, in normal play and each team speed context. */
  speedLists(objective, member, currentNature, currentPoints, pick) {
    const tiers = new SpeedTiers(this.ev);
    let meta = [];
    try {
      meta = tiers.metaVariants(objective.topX);
    } catch {
      meta = [];
    }
    const ours = (nature, points) => tiers.ourVariants([{ ...member, nature, bonuses: points }])[0][0];
    const beforeMon = ours(currentNature, currentPoints);
    const afterMon = ours(pick.nature, pick.points);
    const contexts = [{ id: "normal", label: "Normal", weather: "None", tailwind: false, trickRoom: false }];
    if (objective.hasTailwind) contexts.push({ id: "tailwind", label: "Your Tailwind", weather: "None", tailwind: true, trickRoom: false });
    if (objective.hasTrickRoom) contexts.push({ id: "trick-room", label: "Trick Room", weather: "None", tailwind: false, trickRoom: true });
    const own = { drought: "Sun", drizzle: "Rain", sandstream: "Sand", snowwarning: "Snow", orichalcumpulse: "Sun", desolateland: "Sun", primordialsea: "Rain" }[objective.ownAbility];
    const weather = objective.teamField?.weather || own || "";
    if (weather) contexts.push({ id: `weather-${compact(weather)}`, label: `In ${weather}`, weather, tailwind: false, trickRoom: false });
    const speed = (mon, state) => {
      try {
        return Math.max(1, Math.trunc(this.engine.effectiveSpeed(mon, state)));
      } catch {
        return Math.max(1, Number(this.engine.finalStats(mon).speed) || 1);
      }
    };
    const out = [];
    for (const context of contexts) {
      const was = speed(beforeMon, { weather: context.weather, tailwind: context.tailwind });
      const now = speed(afterMon, { weather: context.weather, tailwind: context.tailwind });
      const lists = { now_faster: [], now_slower: [], now_tied: [], still_faster: 0, still_slower: 0, still_tied: 0 };
      // "Faster" means moving first: under Trick Room the slower Pokemon does.
      const rel = (a, b) => (a === b ? 0 : (a > b) !== context.trickRoom ? 1 : -1);
      for (const [mon, info] of meta) {
        const theirs = speed(mon, { weather: context.weather, tailwind: false, unburden: info.variant_label === "Unburden" });
        const r0 = rel(was, theirs);
        const r1 = rel(now, theirs);
        const row = {
          name: this.sg.name(mon.form_name || mon.pokemon_name), species: mon.pokemon_name, form: mon.form_name, item: mon.item || "",
          variant: info.variant_label || "", speed: theirs, rank: Number(info.position) || 0,
        };
        if (r1 === r0) {
          if (r1 > 0) lists.still_faster += 1;
          else if (r1 < 0) lists.still_slower += 1;
          else lists.still_tied += 1;
        } else if (r1 > 0) lists.now_faster.push(row);
        else if (r1 < 0) lists.now_slower.push(row);
        else lists.now_tied.push(row);
      }
      const order = (x, y) => (context.trickRoom ? x.speed - y.speed : y.speed - x.speed) || x.rank - y.rank;
      lists.now_faster.sort(order);
      lists.now_slower.sort(order);
      lists.now_tied.sort(order);
      out.push({ id: context.id, label: context.label, trick_room: context.trickRoom, before: was, after: now, ...lists });
    }
    return { before: out[0]?.before || 0, after: out[0]?.after || 0, changed: out.some((c) => c.before !== c.after), contexts: out, top_meta: objective.topX };
  }
}
