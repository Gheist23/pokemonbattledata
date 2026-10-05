// The Solver: recreate any position and search it.
//
// This is not "an AI suggests a move". The board is played out thousands of times, with both
// sides choosing at the same time and neither seeing the other's choice, and the answer is
// whatever comes out ahead across those lines -- which is why it gets better the longer it runs.
//
// THE SEARCH
// ----------
// Both sides have a set of joint actions at the root (what each Pokemon on the field does this
// turn, plus the switches). One iteration:
//
//   1. each side picks one of its own joint actions by UCB1 over its OWN statistics, and
//      independently of the other -- *decoupled* UCB. Read as a reply to the other side it would
//      be one-sided, and a board would stop scoring 50 against itself;
//   2. the turn is played with those two joint actions, through the very turn machinery the
//      Tournament Test plays its games with (`plannedTurn`, given the plans rather than deciding
//      them). Switches resolve first, as they do in the game;
//   3. the rest of the look-ahead is played by the planner, which is the same machinery again;
//   4. the line's value is 50 + 50 x (our HP left - their HP left), each side's HP as a share of
//      what it brought, and it is backed up to both sides' statistics -- ours as it stands,
//      theirs as 100 minus it.
//
// So every number the Solver prints is a count of real played lines: an action's share is the
// share of the lines it was played in, and its score is the mean those lines came out at. UCB
// spends the iterations on the actions that keep looking good, which is what makes the ranking
// sharpen as the search runs rather than just getting noisier.
//
// WHAT IT SHARES WITH THE TOURNAMENT TEST
// ---------------------------------------
// Everything that resolves a turn. Damage is the calc engine's expected damage for the board's
// weather, terrain, stages, burn and Helping Hand; Protect, the guards, redirection, Fake Out,
// sleep, Taunt, Encore, Helping Hand, Tailwind, Trick Room, Intimidate, Focus Sash, Sitrus Berry
// and the Speed order are the Tournament Test's own (builder/tournament-test.js). The Solver adds
// the action space, the switches and the search over them, and nothing else -- so the two can
// never disagree about what a turn does.
//
// Not shared: the Tournament Test starts every game from a fresh board with both sides leading.
// The Solver starts from the board you give it, at any point in a game.

import {
  ACTION_KINDS, ACTIVE_BY_FORMAT, BRING_BY_FORMAT, TURN_CAP_BY_FORMAT, alive, clampStage,
} from "./tournament-test.js";
import { compact } from "./engine.js";

const { FAKE_OUT, TAILWIND, TRICK_ROOM, REDIRECT, ATTACK, PROTECT, HELPING_HAND,
  WIDE_GUARD, QUICK_GUARD, SLEEP, TAUNT, ENCORE, LOWER, BURN } = ACTION_KINDS;

/** A switch is not one of the turn's actions: it resolves before all of them. */
export const SWITCH = -1;
/** The free-run feature name this shares with Team Evaluation, Auto Build and the Tournament Test. */
export const SOLVER_FEATURE = "solver";
/** Turns of the game the search looks at, including the one it is choosing. */
export const DEFAULT_LOOKAHEAD = 4;
export const LOOKAHEAD_RANGE = [2, 8];
/** How many of a Pokemon's own actions are kept, best first, so the statistics stay meaningful. */
export const TOP_PER_SLOT = 8;
/** The cap on one side's joint actions, after the per-slot cut. */
export const MAX_JOINTS = 72;
/**
 * How many turns are SEARCHED rather than played by the planner.
 *
 * Every searched turn multiplies the tree: the root already offers up to 72 x 72 pairs, and a
 * second searched turn gives each of those its own node. Past two the statistics are spread so
 * thin that the planner -- which is a strong policy, not a random one -- gives the better
 * answer for the same budget. So the search goes two turns deep and the planner takes the tail.
 */
export const SEARCH_DEPTH = 2;
/** The joint-action cap below the root, where the visits per node are far fewer. */
export const MAX_JOINTS_DEEP = 16;
/** A damage roll is one of sixteen, evenly spaced from the lowest to the highest. */
const DAMAGE_ROLLS = 16;
/**
 * UCB1's exploration weight. Values run 0..100, so this is on that scale: at 14 an action two
 * points worse than the best is still revisited for a long time, which is what a board where two
 * lines are nearly equal needs -- and nearly equal is the normal case.
 */
export const EXPLORATION = 14;
/** How long one slice of the search may hold the thread before the page is given back. */
export const SLICE_MS = 55;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

/**
 * mulberry32: a small, fast, seeded generator.
 *
 * The search is stochastic now, so it needs a source of randomness -- and a seeded one, or the
 * same board would give a different answer every time with no way to tell a real difference
 * from noise. A run carries its seed, so a result can be reproduced exactly.
 */
function randomFrom(seed) {
  let state = (seed >>> 0) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Pokemon as the result names it. */
const who = (unit) => ({ species: unit.species, form: unit.form, item: unit.item });

/**
 * One board to search.
 *
 * `sides[s]` is what that side BROUGHT -- the page sends only the Pokemon in the simulation, not
 * the whole team of six. `front` marks the ones standing on the field (the format's count) and
 * the rest are in the back. `justIn` lets a Pokemon use Fake Out and First Impression, which
 * only work on the turn their user came in.
 *
 * `status` is any of the game's conditions, not only the two the turn model tracks itself: burn
 * and sleep change what happens DURING the turn, and the rest change the damage, so they are
 * put on the Pokemon the calculator reads instead.
 *
 * @typedef {{set: object, hp: number, front: boolean, justIn?: boolean, status?: string,
 *            atk?: number, def?: number, spa?: number, spd?: number, spe?: number}} SolverRow
 * @typedef {{weather?: string, terrain?: string, trickRoom?: boolean, tailwind?: boolean[],
 *            reflect?: boolean[], lightScreen?: boolean[], auroraVeil?: boolean[],
 *            friendGuard?: boolean[], faintedAllies?: number[], timesHit?: number[],
 *            items?: boolean, abilities?: boolean, weatherAbilities?: boolean}} SolverField
 * @typedef {{sides: SolverRow[][], field: SolverField}} SolverSetup
 */

/** The game's conditions, and what each one is to the two readers that care.
 *  `turn` is what the turn model carries itself; `mon` is what the damage calculator reads. */
export const STATUS_EFFECTS = Object.freeze({
  "": { turn: "", mon: "" },
  burn: { turn: "burn", mon: "Burned" },
  sleep: { turn: "sleep", mon: "Asleep" },
  poison: { turn: "", mon: "Poisoned" },
  toxic: { turn: "", mon: "Badly Poisoned" },
  paralysis: { turn: "", mon: "Paralyzed" },
  freeze: { turn: "", mon: "Frozen" },
});

export class Solver {
  /**
   * @param {import("./tournament-test.js").TournamentTest} tournament  every calculation is its own
   */
  constructor(tournament) {
    this.t = tournament;
    this.ev = tournament.ev;
    this.format = tournament.format;
    this.activeCount = ACTIVE_BY_FORMAT[this.format];
    this.bring = BRING_BY_FORMAT[this.format];
    this.turnCap = TURN_CAP_BY_FORMAT[this.format];
    this.unitCache = new Map();
    this.random = randomFrom(1);
    // The turn machinery asks this for every hit it lands. The Tournament Test's own answer is
    // the expected share; the Solver's rolls to hit and then rolls the damage, which is what
    // decides whether a line actually works.
    this.t.rollHit = (hit) => this.rollDamage(hit);
  }

  /**
   * One hit, played the way the game plays it.
   *
   * Two rolls, in the order the game makes them. `odds` is the move's accuracy folded with its
   * cooldown -- a move that fires every other turn is modelled as firing half the time -- and
   * the damage is one of sixteen evenly spaced rolls between the lowest and the highest, which
   * is the spread the calculator returns.
   *
   * This is the whole difference between an average and a line. On expectation a move that
   * takes 94% of a Pokemon never knocks it out; across real rolls it does, better than half the
   * time, and whether it does is usually the entire question.
   */
  rollDamage(hit) {
    if (hit.odds === undefined) return hit.frac;
    if (hit.odds < 1 && this.random() >= hit.odds) return 0;
    const low = Number(hit.rollLo) || 0;
    const high = Number(hit.rollHigh) || 0;
    if (high <= low) return high;
    const step = Math.floor(this.random() * DAMAGE_ROLLS);
    return low + ((high - low) * step) / (DAMAGE_ROLLS - 1);
  }

  // --- the board -------------------------------------------------------------------------

  /**
   * One row as a unit. Not `TournamentTest.ourUnit`, because that caches on the set alone and the
   * board's Defense and Sp. Def stages have to be part of the key: they live on the Pokemon the
   * calculator reads (the turn model carries only Attack, Sp. Atk and Speed itself), so two rows
   * of the same set with different stages are different Pokemon to the damage cache.
   */
  unitFor(row, index, side) {
    // Switching an item or an Ability off blanks it on the set BEFORE the Pokemon is built, so
    // it is gone from the turn model as well: no Focus Sash, no Sitrus Berry, no Intimidate, no
    // weather setter. Blanking it only in the damage context would have left all of those alive,
    // which is not what "off" means to the person who clicked it.
    const off = row.itemOff || row.abilityOff;
    const set = off
      ? { ...row.set, item: row.itemOff ? "" : row.set.item, ability: row.abilityOff ? "" : row.set.ability }
      : row.set;
    const mon = this.ev.teamMon(set, index);
    mon.defense_stage = clampStage(Math.trunc(Number(row.def) || 0));
    mon.sp_defense_stage = clampStage(Math.trunc(Number(row.spd) || 0));
    mon.attack_stage = 0;
    mon.sp_attack_stage = 0;
    mon.speed_stage = 0;
    mon.status = (STATUS_EFFECTS[String(row.status || "")] || STATUS_EFFECTS[""]).mon;
    const baseForm = set.form || set.species;
    // The side is part of the key: `TournamentTest.calc` reads `unit.side` for the Solver's own
    // per-side field (screens, Friend Guard, the two counters), so a mirror board must not share
    // one unit between the two sides.
    // Everything that changes a damage number has to be in this key. The damage cache is keyed
    // on unit ids, so two rows that differ only in a counter would otherwise share one answer.
    const faintedAllies = Math.max(0, Math.min(5, Math.trunc(Number(row.faintedAllies) || 0)));
    const timesHit = Math.max(0, Math.min(6, Math.trunc(Number(row.timesHit) || 0)));
    const key = ["solver", side, mon.pokemon_name, mon.form_name, mon.item, mon.ability, baseForm,
      set.ability || "", mon.nature_name, (mon.bonuses || []).join(","), (mon.moves || []).join("+"),
      mon.defense_stage, mon.sp_defense_stage, mon.status,
      row.itemOff ? "i-" : "i+", row.abilityOff ? "a-" : "a+", faintedAllies, timesHit].join("|");
    let unit = this.unitCache.get(key);
    if (!unit) {
      unit = {
        key, mon, side, species: set.species, form: mon.form_name, item: set.item || "",
        display: `${compact(set.species)}|${compact(mon.form_name)}`,
        baseForm, baseAbility: set.ability || "",
        faintedAllies, timesHit,
      };
      this.unitCache.set(key, unit);
    }
    return this.t.prepare(unit);
  }

  /**
   * The board as the turn machinery wants it: `sides[s]` with the ones on the field first (which
   * is what `refill` assumes), `active[s]` pointing into it, and `next[s]` past them.
   */
  buildState(setup) {
    const sides = [];
    const active = [];
    const next = [];
    for (let s = 0; s < 2; s += 1) {
      const rows = (setup.sides[s] || []).filter((row) => row && row.set && row.set.species).slice(0, this.bring);
      const onField = rows.filter((row) => row.front).slice(0, this.activeCount);
      const back = rows.filter((row) => !onField.includes(row));
      const ordered = [...onField, ...back];
      const list = ordered.map((row, i) => {
        const unit = this.unitFor(row, i, s);
        const m = this.t.fresh(unit, s, i < onField.length);
        m.ix = i;
        m.hp = clamp01(Number(row.hp === undefined ? 100 : row.hp) / 100);
        m.out = m.hp <= 0;
        m.atk = clampStage(Math.trunc(Number(row.atk) || 0));
        m.spa = clampStage(Math.trunc(Number(row.spa) || 0));
        m.spe = clampStage(Math.trunc(Number(row.spe) || 0));
        const condition = (STATUS_EFFECTS[String(row.status || "")] || STATUS_EFFECTS[""]).turn;
        m.burn = condition === "burn" && !m.k.burnProof;
        m.idle = condition === "sleep" ? Math.max(1, m.k.sleepTurns || 2) : 0;
        m.sleep = condition === "sleep";
        m.justIn = Boolean(row.justIn);
        // Already on the field, so already entered: the board describes a game in progress and
        // its entry Abilities resolved before the person described it. Without this the first
        // searched turn re-ran every one of them, which re-applied Intimidate and let a Drought
        // or Drizzle holder overwrite the Weather chosen in the Field popup.
        if (i < onField.length) m.entered = true;
        return m;
      });
      sides.push(list);
      active.push(list.slice(0, this.activeCount).map((m) => m || null));
      next.push(Math.min(this.activeCount, list.length));
    }
    const field = setup.field || {};
    // Everything the board itself does not carry -- screens, Friend Guard, the rule switches and
    // the two conditional counters -- is handed to the damage calculation instead, which is the
    // only reader that can honour it (`TournamentTest.solverField`).
    this.t.solverField = {
      reflect: [Boolean(field.reflect?.[0]), Boolean(field.reflect?.[1])],
      lightScreen: [Boolean(field.lightScreen?.[0]), Boolean(field.lightScreen?.[1])],
      auroraVeil: [Boolean(field.auroraVeil?.[0]), Boolean(field.auroraVeil?.[1])],
      friendGuard: [Boolean(field.friendGuard?.[0]), Boolean(field.friendGuard?.[1])],
    };
    const weathers = ["None", "Sun", "Rain", "Sand", "Snow"];
    const terrains = ["None", "Electric", "Grassy", "Misty", "Psychic"];
    const board = {
      w: Math.max(0, weathers.indexOf(String(field.weather || "None"))),
      t: Math.max(0, terrains.indexOf(String(field.terrain || "None"))),
      tw: [Number(field.tailwind?.[0]) || 0, Number(field.tailwind?.[1]) || 0],
      tr: field.trickRoom ? 4 : 0,
      trBy: field.trickRoom ? 0 : -1,
      wide: 0,
      quick: 0,
    };
    const mean = (list) => {
      const live = list.filter(alive);
      return live.length ? live.reduce((sum, m) => sum + (m.u.entrySpeed || 0), 0) / live.length : 0;
    };
    const slower = [mean(sides[0]) < mean(sides[1]), mean(sides[1]) < mean(sides[0])];
    return { sides, active, next, board, slower };
  }

  /** A copy that a line can be played on without touching the board it came from. */
  cloneState(base) {
    const sides = base.sides.map((list) => list.map((m) => ({ ...m })));
    const active = base.active.map((row, s) => row.map((m) => (m ? sides[s][m.ix] : null)));
    return {
      sides,
      active,
      next: [...base.next],
      board: { ...base.board, tw: [...base.board.tw] },
      slower: [...base.slower],
    };
  }

  // --- the action space ------------------------------------------------------------------

  label(unit) {
    return this.ev.displayName
      ? this.ev.displayName(unit.species, unit.form) || unit.form || unit.species
      : unit.form || unit.species;
  }

  /**
   * Everything one Pokemon on the field could do this turn, best first.
   *
   * Only the actions the turn machinery knows how to resolve are offered: a move it cannot model
   * is not in the list rather than in the list doing nothing. `value` is a rough ordering, used
   * only to decide which actions survive the per-slot cut -- the search itself ignores it.
   */
  slotCandidates(state, s, position) {
    const m = state.active[s][position];
    if (!alive(m)) return [{ kind: 0, label: "", value: 0, wait: true }];
    const t = this.t;
    const u = m.u;
    const k = m.k;
    const foes = state.active[1 - s];
    const mine = state.active[s];
    const liveFoes = foes.map((f, i) => [f, i]).filter(([f]) => alive(f));
    const out = [];
    const add = (entry) => out.push({ position, ...entry });

    u.moves.forEach((info, slot) => {
      if (!info || !info.name) return;
      const key = info.key;
      if (key === "fakeout") {
        if (!m.justIn) return;
        for (const [foe, fp] of liveFoes) {
          if (foe.k.flinchProof) continue;
          if (t.hitOn(m, foe, slot, state.board, false).frac <= 0) continue;
          add({ kind: FAKE_OUT, slot, target: fp, move: info.name, value: 6 + t.threatTo(foe, mine, state.board) });
        }
        return;
      }
      if (info.attack || key === "firstimpression") {
        if (key === "firstimpression" && !m.justIn) return;
        if (info.spread) {
          const frac = liveFoes.reduce((sum, [foe]) => sum + t.hitOn(m, foe, slot, state.board).frac, 0);
          if (frac > 0) add({ kind: ATTACK, slot, target: -1, move: info.name, spread: true, value: frac * 10 });
          return;
        }
        for (const [foe, fp] of liveFoes) {
          const hit = t.hitOn(m, foe, slot, state.board);
          if (hit.frac <= 0) continue;
          add({ kind: ATTACK, slot, target: fp, move: info.name, value: t.hitScore(hit.frac, foe) });
        }
        return;
      }
      // --- the status moves the turn machinery resolves ---------------------------------
      if (t.protectMoves.has(key)) {
        if (t.guardRule >= 1 && m.guardedLast) return;
        add({ kind: PROTECT, slot, move: info.name, value: 4 });
        return;
      }
      if (key === "wideguard" && this.activeCount > 1) { add({ kind: WIDE_GUARD, slot, move: info.name, value: 2 }); return; }
      if (key === "quickguard") { add({ kind: QUICK_GUARD, slot, move: info.name, value: 1.5 }); return; }
      if (key === "helpinghand" && this.activeCount > 1) {
        const partner = t.partnerOf(m, mine);
        if (partner) add({ kind: HELPING_HAND, slot, move: info.name, partner: mine.indexOf(partner), value: 3 });
        return;
      }
      if (key === "tailwind") { add({ kind: TAILWIND, slot, move: info.name, pr: k.prankster ? 1 : 0, value: state.board.tw[s] > 0 ? 0.2 : 5 }); return; }
      if (key === "trickroom") { add({ kind: TRICK_ROOM, slot, move: info.name, pr: k.prankster ? -6 : -7, value: 5 }); return; }
      if (t.redirectMoves.has(key) && this.activeCount > 1) { add({ kind: REDIRECT, slot, move: info.name, value: 2.5 }); return; }
      if (k.sleep === slot) {
        for (const [foe, fp] of liveFoes) {
          if (foe.k.sleepProof || (k.powder && foe.k.powderProof)) continue;
          add({ kind: SLEEP, slot, target: fp, move: info.name, value: 4 + (k.sleepTurns || 0) });
        }
        return;
      }
      if (k.taunt === slot) {
        for (const [foe, fp] of liveFoes) {
          if (foe.k.tauntProof) continue;
          add({ kind: TAUNT, slot, target: fp, move: info.name, pr: k.prankster ? 1 : 0, value: 3 });
        }
        return;
      }
      if (k.encore === slot) {
        for (const [foe, fp] of liveFoes) add({ kind: ENCORE, slot, target: fp, move: info.name, pr: k.prankster ? 1 : 0, value: 2.5 });
        return;
      }
      if (k.wisp === slot) {
        for (const [foe, fp] of liveFoes) {
          if (foe.k.burnProof) continue;
          add({ kind: BURN, slot, target: fp, move: info.name, pr: k.prankster ? 1 : 0, value: 3 });
        }
        return;
      }
      if (k.lowers.includes(slot)) {
        if (info.spread) add({ kind: LOWER, slot, target: -1, move: info.name, spread: true, value: 2.5 });
        else for (const [, fp] of liveFoes) add({ kind: LOWER, slot, target: fp, move: info.name, pr: k.prankster && !info.damaging ? 1 : 0, value: 2 });
      }
    });

    // Switches resolve before every move, so they are offered whatever else this Pokemon has.
    //
    // "On the bench" is asked of the field, not of the index. `sides` is NOT kept with the ones
    // standing at the front of it: `refill` takes the next unused Pokemon and advances a pointer
    // rather than moving it up, so after a replacement comes in, a Pokemon that is standing can
    // still be sitting at a high index -- and it was then offered as something to switch TO. The
    // line that followed had the same Pokemon on the field twice, which is not a board the game
    // can reach, and the report of it read the same name in both of a side's slots.
    //
    // Walking the whole list rather than from `activeCount` also fixes the mirror of that: a
    // Pokemon really on the bench can sit at a low index after a switch swapped it down, and
    // those were never offered at all.
    for (let i = 0; i < state.sides[s].length; i += 1) {
      const back = state.sides[s][i];
      if (!alive(back)) continue;
      if (state.active[s].includes(back)) continue;
      add({ kind: SWITCH, into: i, move: `→ ${this.label(back.u)}`, value: 1 });
    }

    if (!out.length) out.push({ position, kind: 0, value: 0, wait: true });
    out.sort((a, b) => b.value - a.value);
    return out.slice(0, TOP_PER_SLOT);
  }

  /** Every combination of what the Pokemon on the field could do, capped.
   *  `cap` is lower below the root, where each node sees far fewer visits and a wide list would
   *  only spread them until none of it meant anything. */
  jointsFor(state, s, cap = MAX_JOINTS) {
    const perSlot = state.active[s].map((m, position) => this.slotCandidates(state, s, position));
    let joints = [[]];
    for (const options of perSlot) {
      const next = [];
      for (const prefix of joints) for (const option of options) next.push([...prefix, option]);
      joints = next;
    }
    // A pair of switches that would both take the same Pokemon off the back is not a turn.
    joints = joints.filter((joint) => {
      const taken = joint.filter((a) => a.kind === SWITCH).map((a) => a.into);
      return new Set(taken).size === taken.length;
    });
    joints.sort((a, b) => b.reduce((sum, x) => sum + x.value, 0) - a.reduce((sum, x) => sum + x.value, 0));
    return joints.slice(0, Math.max(1, cap));
  }

  // --- playing one line ------------------------------------------------------------------

  /** The switches of a joint action, which resolve before anything else on the turn. */
  applySwitches(state, joint, s) {
    for (const action of joint) {
      if (action.kind !== SWITCH) continue;
      const out = state.active[s][action.position];
      const into = state.sides[s][action.into];
      // `out` is never empty for an action that was offered (a slot with nothing in it offers
      // no switch), but the swap below would put a hole in `sides` if it ever were, and
      // `valueOf` reduces over that list.
      // A cached action list can reach a board where the Pokemon it names has since come back
      // on, so this is checked again at the moment of play rather than only when offered.
      if (!out || !into || !alive(into) || state.active[s].includes(into)) continue;
      // Swap the two in `sides` so the one that left sits on the back and `refill` still works:
      // everything before `next[s]` is in play, and that is exactly what the swap preserves.
      const outIx = out.ix;
      state.sides[s][outIx] = into;
      state.sides[s][action.into] = out;
      out.ix = action.into;
      into.ix = outIx;
      into.justIn = true;
      state.active[s][action.position] = into;
    }
  }

  /** A joint action as the plan `plannedTurn` executes (the switches already gone). */
  planFor(state, joint, s) {
    const plan = [];
    for (const action of joint) {
      if (action.kind === SWITCH || action.wait || !action.kind) continue;
      const m = state.active[s][action.position];
      if (!alive(m)) continue;
      const info = m.u.moves[action.slot];
      if (!info) continue;
      const foes = state.active[1 - s];
      const target = action.target >= 0 ? foes[action.target] : null;
      if (action.target >= 0 && !alive(target)) continue;
      const entry = {
        m,
        s,
        kind: action.kind,
        slot: action.slot,
        move: info.name,
        target,
        hit: null,
        value: action.value,
        pr: action.pr === undefined ? info.priority : action.pr,
        sp: this.t.speed(m, state.board),
      };
      if (action.kind === PROTECT) entry.pr = 4;
      if (action.kind === FAKE_OUT) entry.pr = 3;
      if (action.kind === WIDE_GUARD || action.kind === QUICK_GUARD) entry.pr = 3;
      if (action.kind === HELPING_HAND) {
        entry.pr = 5;
        entry.partner = state.active[s][action.partner];
        if (!alive(entry.partner)) continue;
      }
      if (action.kind === ATTACK) entry.hit = { slot: action.slot, spread: Boolean(info.spread) };
      plan.push(entry);
    }
    return plan;
  }

  /** The value of a board, from our side: 50 is even. */
  valueOf(state) {
    const share = (list) => (list.length ? list.reduce((sum, m) => sum + Math.max(0, m.hp), 0) / list.length : 0);
    return Math.max(0, Math.min(100, 50 + 50 * (share(state.sides[0]) - share(state.sides[1]))));
  }

  /**
   * One line: the chosen turn, then `lookahead - 1` turns the planner decides, then the value.
   *
   * The whole turn goes through `plannedTurn`, which is the Tournament Test's own, so a searched
   * turn and a played turn resolve through one piece of code.
   */
  /** What each side is about to do, in words, for the trace. */
  describe(joint, state, s) {
    const out = [];
    for (const action of joint) {
      if (action.wait || !action.kind) continue;
      const m = state.active[s][action.position];
      if (!alive(m)) continue;
      const foes = state.active[1 - s];
      const target = action.target >= 0 && foes[action.target] ? this.label(foes[action.target].u) : "";
      out.push({
        side: s,
        name: this.label(m.u),
        move: action.kind === SWITCH ? action.move : action.move,
        target,
        kind: action.kind,
      });
    }
    return out;
  }

  /** Everyone's HP, as whole percentages, for a before-and-after. */
  snapshot(state) {
    return state.sides.map((list) => list.map((m) => ({ name: this.label(m.u), hp: Math.round(m.hp * 100), out: Boolean(m.out) })));
  }

  /**
   * One turn played with both sides' actions already chosen, on a state that is carried on.
   *
   * Pulled out of `playLine` so the tree can apply a turn, look at where it got to, and choose
   * the next one from there -- which is what searching a turn means, as against letting the
   * planner decide it.
   */
  applyChosenTurn(state, ourJoint, theirJoint, turn, events) {
    const { active, sides, next, board, slower } = state;
    this.applySwitches(state, ourJoint, 0);
    this.applySwitches(state, theirJoint, 1);
    // A Pokemon that came in this turn gets its entry Ability, exactly as a replacement does.
    for (let s = 0; s < 2; s += 1) {
      for (const m of active[s]) if (m && m.justIn && !m.entered) { m.entered = true; this.t.enter(m, active, board, null); }
    }
    const plans = [this.planFor(state, ourJoint, 0), this.planFor(state, theirJoint, 1)];
    this.t.plannedTurn(active, board, slower, turn, events, null, plans);
    this.tickBoard(state);
  }

  /** The planner's turn, for the tail below the searched depth. Returns what it chose. */
  applyPlannedTurn(state, turn, events) {
    const { active, board, slower } = state;
    const plans = this.t.plannedTurn(active, board, slower, turn, events, null);
    this.tickBoard(state);
    return plans;
  }

  /**
   * The planner's own plans, in the shape `describe` returns for a searched turn.
   *
   * A planner entry names the Pokemon and the target as objects rather than as positions, which
   * is why `describe` cannot read one: it indexes into `state.active`. Both have to come out as
   * the same `{side, name, move, target, kind}` because `turnRecord` formats them into the plain
   * strings the worker can post back -- a plan entry itself holds live unit and trait objects
   * and would not survive a structured clone.
   */
  tell(plans) {
    const out = [];
    for (let s = 0; s < 2; s += 1) {
      for (const a of (plans && plans[s]) || []) {
        if (!a || !a.kind || !a.m || !a.m.u) continue;
        const aim = a.target || a.partner || null;
        out.push({
          side: s,
          name: this.label(a.m.u),
          move: a.move || "",
          target: aim && aim.u ? this.label(aim.u) : "",
          kind: a.kind,
        });
      }
    }
    return out;
  }

  /** The counters that run down at the end of every turn, and the empty slots filled. */
  tickBoard(state) {
    const { active, sides, next, board } = state;
    if (board.tw[0]) board.tw[0] -= 1;
    if (board.tw[1]) board.tw[1] -= 1;
    if (board.tr) board.tr -= 1;
    // Standing through a turn spends "just switched in". Nothing used to clear it -- not
    // `refill`, not `fresh` -- so a Pokemon marked just-in was offered Fake Out and First
    // Impression at EVERY searched turn, and one that switched in during the search kept the
    // flag for the rest of the line.
    const before = active.map((row) => row.map((m) => (m && !m.out ? m.u.id : null)));
    for (const row of active) for (const m of row) if (m) m.justIn = false;
    this.t.refill(active, sides, next, board);
    // A replacement sent out to fill a gap has only just arrived, so it gets what the game gives
    // a Pokemon that has only just arrived -- including its entry Ability, on the turn it acts.
    active.forEach((row, s) => row.forEach((m, i) => {
      if (m && !m.out && before[s][i] !== m.u.id) m.justIn = true;
    }));
  }

  /** Whether there is anything left to play. */
  stillPlaying(state) {
    return state.active[0].some(alive) && state.active[1].some(alive);
  }

  playLine(base, ourJoint, theirJoint, lookahead, { trace = false } = {}) {
    const state = this.cloneState(base);
    const turns = trace ? [] : null;
    const before = trace ? this.snapshot(state) : null;
    const chosen = trace
      ? [...this.describe(ourJoint, state, 0), ...this.describe(theirJoint, state, 1)]
      : null;
    const events = trace ? [] : null;
    this.applyChosenTurn(state, ourJoint, theirJoint, 1, events);
    if (trace) turns.push(this.turnRecord(1, chosen, events, before, this.snapshot(state)));
    for (let turn = 2; turn <= lookahead; turn += 1) {
      if (!this.stillPlaying(state)) break;
      const was = trace ? this.snapshot(state) : null;
      const later = trace ? [] : null;
      const plans = this.applyPlannedTurn(state, turn, later);
      if (trace) turns.push(this.turnRecord(turn, this.tell(plans), later, was, this.snapshot(state)));
    }
    const value = this.valueOf(state);
    return trace ? { value, turns } : value;
  }

  /**
   * Play out a whole path of chosen turns, then let the planner finish it.
   *
   * `path` is one joint pair per searched turn. Everything after it is the planner's, which is
   * the tail of the search: a strong default policy rather than a random playout, which is why
   * a shallow tree over it beats a deep tree with nothing in the leaves.
   */
  playPath(base, path, lookahead, { trace = false } = {}) {
    const state = this.cloneState(base);
    const turns = trace ? [] : null;
    let turn = 1;
    for (const [ourJoint, theirJoint] of path) {
      if (!this.stillPlaying(state)) break;
      const before = trace ? this.snapshot(state) : null;
      const chosen = trace
        ? [...this.describe(ourJoint, state, 0), ...this.describe(theirJoint, state, 1)]
        : null;
      const events = trace ? [] : null;
      this.applyChosenTurn(state, ourJoint, theirJoint, turn, events);
      if (trace) turns.push(this.turnRecord(turn, chosen, events, before, this.snapshot(state)));
      turn += 1;
    }
    for (; turn <= lookahead; turn += 1) {
      if (!this.stillPlaying(state)) break;
      const before = trace ? this.snapshot(state) : null;
      const events = trace ? [] : null;
      const plans = this.applyPlannedTurn(state, turn, events);
      if (trace) turns.push(this.turnRecord(turn, this.tell(plans), events, before, this.snapshot(state)));
    }
    const value = this.valueOf(state);
    return trace ? { value, turns } : value;
  }

  /**
   * One turn of the trace: what was played, what it cost, and who went down.
   *
   * The turn machinery has no "attacked" event -- only the notable plays are evented -- so the
   * damage is read from the HP either side of the turn instead. That is the honest reading
   * anyway: it is what the turn did, whoever did it.
   */
  turnRecord(turn, chosen, events, before, after) {
    const plays = (chosen || []).map((play) => ({
      side: play.side,
      text: play.kind === SWITCH ? `${play.name} ${play.move}` : `${play.name}: ${play.move}${play.target ? ` \u2192 ${play.target}` : ""}`,
    }));
    const NOTABLE = {
      protect: "protected", wideguard: "used Wide Guard", quickguard: "used Quick Guard",
      helpinghand: "used Helping Hand", fakeout: "flinched the target with Fake Out",
      tailwind: "set Tailwind", trickroom: "turned Trick Room", redirect: "drew the attacks in",
      intimidate: "lowered Attack with Intimidate", sleep: "put the target to sleep",
      taunt: "taunted the target", encore: "locked the target with Encore",
      burn: "burned the target", speeddrop: "dropped Speed", blocked: "was blocked",
    };
    const notes = [];
    for (const event of events || []) {
      const what = NOTABLE[event.kind];
      if (!what || !event.actor) continue;
      const line = `${this.label(event.actor)} ${what}`;
      if (!notes.includes(line)) notes.push(line);
    }
    const damage = [];
    const fainted = [];
    for (let s = 0; s < 2; s += 1) {
      for (let i = 0; i < after[s].length; i += 1) {
        const was = before[s][i];
        const now = after[s][i];
        if (now.out && !was.out) fainted.push({ side: s, name: now.name });
        else if (was.hp !== now.hp) damage.push({ side: s, name: now.name, from: was.hp, to: now.hp });
      }
    }
    return { turn, plays, notes, damage, fainted, hp: after };
  }

  // --- the search ------------------------------------------------------------------------

  /** UCB1 over one side's own statistics. Unvisited actions come first, in their own order. */
  select(stats, total) {
    let best = -1;
    let bestScore = -Infinity;
    const logTotal = Math.log(Math.max(2, total));
    for (let i = 0; i < stats.length; i += 1) {
      const entry = stats[i];
      if (!entry.n) return i;
      const score = entry.sum / entry.n + EXPLORATION * Math.sqrt(logTotal / entry.n);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best < 0 ? 0 : best;
  }

  /** A joint action's identity, so a reported row can be matched back to the action it came from. */
  keyOf(joint) {
    return joint.map((a) => `${a.position}:${a.kind}:${a.slot ?? ""}:${a.target ?? ""}:${a.into ?? ""}`).join("|");
  }

  /** What one side's statistics say, best first. */
  report(joints, stats, state, s, total) {
    const rows = joints.map((joint, i) => ({
      key: this.keyOf(joint),
      actions: joint.filter((a) => !a.wait).map((a) => ({
        who: who(state.active[s][a.position].u),
        name: this.label(state.active[s][a.position].u),
        move: a.kind === SWITCH ? a.move : a.move,
        target: a.target >= 0 && state.active[1 - s][a.target]
          ? this.label(state.active[1 - s][a.target].u)
          : a.kind === HELPING_HAND && state.active[s][a.partner]
            ? this.label(state.active[s][a.partner].u)
            : "",
        kind: a.kind,
      })),
      played: stats[i].n,
      share: total ? stats[i].n / total : 0,
      score: stats[i].n ? stats[i].sum / stats[i].n : 0,
    }));
    rows.sort((a, b) => b.played - a.played || b.score - a.score);
    return rows;
  }

  /**
   * What a node's action list depends on: who is standing where, who is still in, who is on the
   * bench to switch to, and the two flags that decide whether Fake Out and Protect are offered.
   *
   * This has to be part of the node's key, and the reason is the whole point of the change that
   * introduced it. While every hit did its average damage, the path of chosen actions decided
   * the board completely, so a path was a safe name for a node. Now that hits roll, the same
   * path reaches a DIFFERENT board on different iterations -- someone survives on one roll and
   * faints on another -- and a node's cached actions would then name slots belonging to a
   * Pokemon that is no longer in that position. It does not read across as a subtle bias; it
   * throws.
   *
   * HP is deliberately NOT in the signature. Two boards that differ only in how much damage was
   * dealt offer the same actions, and sharing their statistics is exactly the transposition
   * worth having.
   */
  shapeOf(state) {
    const parts = [];
    for (let s = 0; s < 2; s += 1) {
      parts.push(state.active[s].map((m) => (m
        ? `${m.u.id}${m.out ? "x" : ""}${m.justIn ? "j" : ""}${m.guardedLast ? "g" : ""}`
        : "-")).join("."));
      parts.push(state.sides[s].map((m) => `${m.u.id}${m.out ? "x" : ""}`).join("."));
    }
    return parts.join("/");
  }

  /**
   * A node of the tree: the actions each side has here, and what each one has been worth.
   *
   * Keyed by the path of chosen action indices AND the shape of the board it reached, for the
   * reason `shapeOf` gives.
   */
  nodeAt(nodes, key, state, depth) {
    let node = nodes.get(key);
    if (node) return node;
    const cap = depth === 0 ? MAX_JOINTS : MAX_JOINTS_DEEP;
    const joints = [this.jointsFor(state, 0, cap), this.jointsFor(state, 1, cap)];
    if (!joints[0].length || !joints[1].length) return null;
    node = {
      joints,
      stats: joints.map((list) => list.map(() => ({ n: 0, sum: 0 }))),
      total: 0,
    };
    nodes.set(key, node);
    return node;
  }

  /**
   * Search one board.
   *
   * One iteration walks down the tree choosing a joint action for each side at each searched
   * turn by UCB over that node's own statistics, plays those turns out, lets the planner finish
   * the look-ahead, and backs the value up every node it passed through. Both sides choose
   * independently at every node -- decoupled UCB -- because they choose at the same time in the
   * game, and a search that read one as a reply to the other would stop a board scoring 50
   * against itself.
   *
   * The playout is stochastic: every hit rolls to land and then rolls its damage. So an
   * iteration is a SAMPLE, not a measurement, and the answer is the average over samples. That
   * costs iterations -- an average needs none -- and buys the thing an average cannot give: a
   * line is scored by how often it works, not by what it does on a roll nobody gets.
   *
   * @param {SolverSetup} setup
   * @param {{lookahead?:number, iterations?:number, deadline?:number, seed?:number,
   *          onProgress?:(progress:object)=>void, shouldStop?:()=>boolean}} options
   */
  async search(setup, { lookahead = DEFAULT_LOOKAHEAD, iterations = 4000, deadline = 0, seed = 1,
    onProgress = null, shouldStop = null } = {}) {
    this.t.resetCaches();
    this.unitCache.clear();
    this.random = randomFrom(seed);
    const base = this.buildState(setup);
    const depthWanted = Math.max(LOOKAHEAD_RANGE[0], Math.min(LOOKAHEAD_RANGE[1], Math.trunc(lookahead) || DEFAULT_LOOKAHEAD));
    if (!base.active[0].some(alive) || !base.active[1].some(alive)) {
      return { error: "Both sides need at least one Pokemon on the field." };
    }
    const searched = Math.min(SEARCH_DEPTH, depthWanted);
    const nodes = new Map();
    const root = this.nodeAt(nodes, "", base, 0);
    if (!root) return { error: "Neither side has an action on this board." };

    let played = 0;
    let total = 0;
    const started = Date.now();
    let sliceStart = started;
    while (played < iterations) {
      const state = this.cloneState(base);
      const walked = [];
      let key = "";
      let node = root;
      for (let depth = 0; depth < searched && node; depth += 1) {
        const a = this.select(node.stats[0], node.total);
        const b = this.select(node.stats[1], node.total);
        walked.push([node, a, b]);
        this.applyChosenTurn(state, node.joints[0][a], node.joints[1][b], depth + 1, null);
        key = `${key}${a},${b}|`;
        node = this.stillPlaying(state) && depth + 1 < searched
          ? this.nodeAt(nodes, `${key}${this.shapeOf(state)}`, state, depth + 1)
          : null;
      }
      for (let turn = walked.length + 1; turn <= depthWanted; turn += 1) {
        if (!this.stillPlaying(state)) break;
        this.applyPlannedTurn(state, turn, null);
      }
      const value = this.valueOf(state);
      for (const [visited, a, b] of walked) {
        visited.stats[0][a].n += 1;
        visited.stats[0][a].sum += value;
        visited.stats[1][b].n += 1;
        visited.stats[1][b].sum += 100 - value;
        visited.total += 1;
      }
      total += value;
      played += 1;
      if (Date.now() - sliceStart >= SLICE_MS) {
        if (onProgress) {
          onProgress({
            played, iterations, value: total / played,
            elapsed: (Date.now() - started) / 1000,
            calcs: this.t.calcs,
            nodes: nodes.size,
          });
        }
        await tick();
        sliceStart = Date.now();
        if (shouldStop && shouldStop()) break;
        if (deadline && Date.now() >= deadline) break;
      }
    }

    const ours = this.report(root.joints[0], root.stats[0], base, 0, played);
    const theirs = this.report(root.joints[1], root.stats[1], base, 1, played);
    // The best line, played out once with a trace, so the answer can show how the game goes on
    // from here. The path follows the best action at each searched turn, then the planner.
    let story = null;
    if (ours.length && theirs.length) {
      try {
        story = this.bestLine(nodes, base, searched, depthWanted);
      } catch {
        story = null;
      }
    }
    return {
      format: this.format,
      lookahead: depthWanted,
      searchedTurns: searched,
      nodes: nodes.size,
      seed,
      story,
      played,
      seconds: (Date.now() - started) / 1000,
      calcs: this.t.calcs,
      value: played ? total / played : 50,
      ours,
      theirs,
      space: [root.joints[0].length, root.joints[1].length],
    };
  }

  /**
   * The line the search settled on, played out once and written down as it goes.
   *
   * Chosen and played in ONE pass, which is the whole point. It used to collect the most played
   * joint at each turn and then replay that list from the start -- and a replay is a different
   * game: the playouts roll to hit and roll their damage, so the second pass reached a different
   * board, and a turn-2 action chosen for the first board was applied to the second. An action
   * names its Pokemon by position and its switch by a place on the bench, so on the wrong board
   * those indices point at whoever happens to be standing there. The report could then show one
   * Pokemon twice -- both of our slots reading "Sneasler: Protect" -- which is not a board the
   * game can reach.
   *
   * Walking and tracing together, every action is applied to the board it was chosen for, and
   * the node is found by `key + shapeOf(state)`, so its cached actions are indices into exactly
   * this arrangement of Pokemon.
   */
  bestLine(nodes, base, searched, lookahead) {
    const state = this.cloneState(base);
    const turns = [];
    const pick = (stats) => {
      let best = 0;
      for (let i = 1; i < stats.length; i += 1) {
        if (stats[i].n > stats[best].n
          || (stats[i].n === stats[best].n && stats[i].n && stats[i].sum / stats[i].n > stats[best].sum / stats[best].n)) best = i;
      }
      return best;
    };
    let key = "";
    let node = nodes.get("");
    let turn = 1;
    for (let depth = 0; depth < searched && node; depth += 1, turn += 1) {
      const a = pick(node.stats[0]);
      const b = pick(node.stats[1]);
      const before = this.snapshot(state);
      const chosen = [...this.describe(node.joints[0][a], state, 0), ...this.describe(node.joints[1][b], state, 1)];
      const events = [];
      this.applyChosenTurn(state, node.joints[0][a], node.joints[1][b], turn, events);
      turns.push(this.turnRecord(turn, chosen, events, before, this.snapshot(state)));
      key = `${key}${a},${b}|`;
      node = this.stillPlaying(state) ? nodes.get(`${key}${this.shapeOf(state)}`) : null;
    }
    for (; turn <= lookahead; turn += 1) {
      if (!this.stillPlaying(state)) break;
      const before = this.snapshot(state);
      const events = [];
      const plans = this.applyPlannedTurn(state, turn, events);
      turns.push(this.turnRecord(turn, this.tell(plans), events, before, this.snapshot(state)));
    }
    return { value: this.valueOf(state), turns };
  }

}
