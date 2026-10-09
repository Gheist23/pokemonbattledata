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
  WEATHERS as BOARD_WEATHERS, TERRAINS as BOARD_TERRAINS,
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
/** How long a Pokemon a board calls Asleep stays asleep. Two, as a Spore gives. */
export const SOLVER_SLEEP_TURNS = 2;
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
/**
 * How many lines the leading move on BOTH sides must hold before the answer counts as settled.
 *
 * It is a count of lines and not a number of seconds on purpose: settling is a property of how
 * much the search has seen, so a slower machine should take longer to get there rather than
 * answer from less work. The search may not stop before twice this many lines in total.
 *
 * 150,000 was measured, not guessed: over 15 runs (four Doubles boards -- even, mirror, one side
 * nearly dead, and a wide one -- plus a Singles board, each on three seeds) the leader on one
 * board last changed 207,000 lines in, so a shorter window would have answered early there. At
 * this window every one of the 15 agreed with a full 30-second run; the next window down
 * (100,000) disagreed on one of them.
 *
 * 300,000 is twice that, and it was asked for rather than measured into: a longer window is a
 * stricter test of "the order has stopped changing". What WAS measured is the cost, over 27 runs
 * on six boards -- even, wide, nearly decided, the widest the page can build, a Singles board
 * and a Doubles board with one Pokemon standing alone -- at both the default look-ahead and the
 * deepest the page offers. Every one of them still settles, and the time roughly doubles: a
 * Doubles board that answered in 8 or 9 seconds answers in 15 to 24. On most runs it is the
 * FLOOR that ends them rather than the window -- the leader stopped moving long before 600,000
 * lines and the rest is waiting the floor out.
 *
 * SEARCH_CAP_SECONDS moved with it, 90 seconds to 180. The floor is a count of LINES, so how
 * much slower than this desktop a client may be and still reach it is arithmetic: emulating
 * slower clients by shrinking the budget, 150,000 settled at 5x slower and first failed at 6x,
 * while 300,000 fails at 4x. Headroom of about 3x is a phone, and what that client lost was not
 * the answer -- it is the same search stopped later -- but the right to be told its answer had
 * settled. Doubling the wall puts the headroom back where the old window had it. The wall is
 * only ever reached by a board that is NOT settling, which is the board worth more search.
 *
 * What the longer window buys: on 3 of 11 board-and-seed pairs the leading line changed after
 * 300,000 lines, which the shorter window was structurally unable to see. Be honest about what
 * that is worth. On an even board the board value barely moved with the name (49.94 to 49.95),
 * so there it is a steadier choice between near-ties rather than a different verdict about the
 * position; on the board with one side standing alone the two lines differed in kind -- switch
 * out and attack, against Protect and Tailwind.
 */
export const SETTLE_LINES = 300000;

/**
 * Has the answer stood still long enough to stop?
 *
 * Two conditions, and both matter. The window is the real test: the leading line on both sides
 * has not changed for `settleLines` lines. The floor -- twice that in total -- is what stops a
 * board answering off its first few thousand lines just because nothing had moved yet; early on,
 * nothing having moved means almost nothing has been tried.
 *
 * It is a function rather than two terms inside the loop so that it can be read directly: the
 * loop only consults it when a slice hands the thread back, so a suite watching from outside
 * cannot tell the two conditions apart.
 */
export function hasSettled(played, heldSince, settleLines) {
  if (!(settleLines > 0)) return false;
  return played >= 2 * settleLines && played - heldSince >= settleLines;
}

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
  poison: { turn: "poison", mon: "Poisoned" },
  toxic: { turn: "toxic", mon: "Badly Poisoned" },
  // Paralysis is already modelled where it matters: the Pokemon is built with the condition on
  // it and the engine halves its Speed. Only the one-in-four lost turn is missing.
  paralysis: { turn: "", mon: "Paralyzed" },
  freeze: { turn: "freeze", mon: "Frozen" },
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
    // And this is what a Pokemon does about being hit. The Tournament Test leaves it unset.
    this.t.onHit = (target) => this.afterBeingHit(target);
  }

  /**
   * An Ability that answers a hit.
   *
   * Stamina is the one that matters on a board: Archaludon's Defense goes up a stage every time
   * something lands on it, which is most of what makes it worth bringing. Nothing modelled it --
   * the turn state carries Attack, Sp. Atk and Speed and no Defense, and the Defense stage the
   * board starts with is frozen on the cached unit -- so a line that hit Archaludon four times
   * priced the fourth hit exactly like the first.
   *
   * `m.def` is a DELTA on top of the stage the board was set up with, which is why it starts at
   * zero and why `hitOn` adds the two together rather than replacing one with the other.
   */
  afterBeingHit(target) {
    if (!target || target.out) return;
    if (compact(target.u.mon.ability || "") !== "stamina") return;
    // +6 is the ceiling the game has, and the stage the board was set up with counts towards it.
    const base = target.u.mon.defense_stage || 0;
    target.def = clampStage(base + (target.def || 0) + 1) - base;
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
   * The same Pokemon before its stone is used.
   *
   * `prepare` already builds `unit.base` -- the Tournament Test has always known that a stone
   * holder walks in as its base form -- and `baseFormUnit` wraps it. What that wrapper does not
   * carry is the three fields the Solver's own damage branch reads off a unit, so they are added
   * here: without `side` the screens of side 0 would protect both sides, and without the two
   * counters Last Respects and Rage Fist would price at nothing.
   */
  baseUnitFor(unit, side) {
    const bare = this.t.baseFormUnit(unit);
    if (bare === unit) return unit;
    bare.side = side;
    bare.faintedAllies = unit.faintedAllies;
    bare.timesHit = unit.timesHit;
    return this.t.prepare(bare);
  }

  /** Whether this Pokemon is holding a stone its side has not used yet. */
  canMega(state, s, position) {
    const m = state.active[s][position];
    return Boolean(m && !m.out && m.mega && !state.megaUsed[s]);
  }

  /**
   * The board as the turn machinery wants it: `sides[s]` with the ones on the field first (which
   * is what `refill` assumes), `active[s]` pointing into it, and `next[s]` past them.
   *
   * A side may stand with FEWER than the format's count -- a Doubles board where somebody is
   * down to their last Pokemon -- and then the other seat is empty. Empty, not "whoever is next
   * on the bench": seating the first `activeCount` of the list put a BENCH Pokemon on the field,
   * which is a board the game cannot be in, and the report then named a move for a Pokemon the
   * person had left in the back.
   *
   * `next` counted seats the same way, which is why the two errors hid each other: the Pokemon
   * the pointer skipped was the one that had been wrongly seated. They have to move together.
   * Pad the seats without moving the pointer and the first Pokemon on the bench can never be
   * sent out as a replacement at all.
   *
   * Padded with null rather than left short, because `refill` walks `active[s]` by its CURRENT
   * length: a seat that is not there cannot be filled later, so a side standing alone with a
   * Pokemon still on the bench would never get it onto the field.
   */
  buildState(setup) {
    const sides = [];
    const active = [];
    const next = [];
    const megaUsed = [false, false];
    for (let s = 0; s < 2; s += 1) {
      const rows = (setup.sides[s] || []).filter((row) => row && row.set && row.set.species).slice(0, this.bring);
      const onField = rows.filter((row) => row.front).slice(0, this.activeCount);
      const back = rows.filter((row) => !onField.includes(row));
      const ordered = [...onField, ...back];
      const list = ordered.map((row, i) => {
        const mega = this.unitFor(row, i, s);
        // Everything stands in its base form: a stone does nothing until its owner chooses to
        // use it, and choosing is what the search now does.
        const unit = this.baseUnitFor(mega, s);
        // A board can also be described with a Pokemon ALREADY in its Mega form -- someone
        // recreating the middle of a game -- and then that side's one Mega Evolution is gone.
        if (unit === mega && /^mega\b/i.test(String(mega.form || ""))) megaUsed[s] = true;
        const m = this.t.fresh(unit, s, i < onField.length);
        m.mega = unit === mega ? null : mega;
        m.ix = i;
        m.hp = clamp01(Number(row.hp === undefined ? 100 : row.hp) / 100);
        m.out = m.hp <= 0;
        m.atk = clampStage(Math.trunc(Number(row.atk) || 0));
        m.spa = clampStage(Math.trunc(Number(row.spa) || 0));
        m.spe = clampStage(Math.trunc(Number(row.spe) || 0));
        const condition = (STATUS_EFFECTS[String(row.status || "")] || STATUS_EFFECTS[""]).turn;
        m.burn = condition === "burn" && !m.k.burnProof;
        // Not `m.k.sleepTurns`: that is how long THIS Pokemon's own sleep move puts somebody
        // ELSE out -- Spore two turns, the rest one -- which is a fact about its moveset and has
        // nothing to do with how long it has been asleep. An Amoonguss carrying Sleep Powder woke
        // a full turn earlier than the identical Amoonguss carrying Spore. A board does not say
        // how many turns are left, so it gets the model's own sleep, which is also what every
        // Pokemon with no sleep move was already getting.
        m.idle = condition === "sleep" ? SOLVER_SLEEP_TURNS : 0;
        // The three the turn model had no idea about. Each costs something every turn, and a
        // board that says a Pokemon is poisoned meant nothing at all until now.
        m.psn = condition === "poison";
        m.tox = condition === "toxic";
        // A badly poisoned Pokemon has been poisoned for some number of turns already and the
        // board cannot say how many, so it starts where the game starts: one sixteenth.
        m.toxTurns = condition === "toxic" ? 1 : 0;
        m.frozen = condition === "freeze";
        m.sleep = condition === "sleep";
        m.justIn = Boolean(row.justIn);
        // Already on the field, so already entered: the board describes a game in progress and
        // its entry Abilities resolved before the person described it. Without this the first
        // searched turn re-ran every one of them, which re-applied Intimidate and let a Drought
        // or Drizzle holder overwrite the Weather chosen in the Field popup.
        if (i < onField.length) m.entered = true;
        // The Defense stage this line has added, on top of the one the board was set up with.
        m.def = 0;
        // Which Pokemon this is, for the whole line. `ix` is where it is STANDING and a switch
        // changes it; this never changes, so the trace can tell what happened to whom.
        m.tag = i;
        return m;
      });
      sides.push(list);
      // The seats, in order, and an empty one is null. `list` is the ones on the field followed
      // by the bench, so the first `onField.length` of it are exactly the ones standing.
      active.push(Array.from({ length: this.activeCount }, (_, i) => (i < onField.length ? list[i] : null)));
      // The bench begins where the field ends -- the number of Pokemon STANDING, not the number
      // of seats the format has.
      next.push(onField.length);
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
    const board = {
      // BOARD_WEATHERS and BOARD_TERRAINS are the engine's own order. A list of the same words in
      // a different order is not the same list: these are indices.
      w: Math.max(0, BOARD_WEATHERS.indexOf(String(field.weather || "None"))),
      t: Math.max(0, BOARD_TERRAINS.indexOf(String(field.terrain || "None"))),
      tw: [Number(field.tailwind?.[0]) || 0, Number(field.tailwind?.[1]) || 0],
      tr: field.trickRoom ? 4 : 0,
      trBy: field.trickRoom ? 0 : -1,
      wide: 0,
      quick: 0,
    };
    // `entrySpeedOf`, not `u.entrySpeed`: that field is null for everything that is not a stone
    // holder, so this read 0 for an ordinary side and judged whichever side happened to carry a
    // stone the faster one. Now that nothing stands in its Mega form it would have been 0 for
    // both sides always, and `planSide` reads it for its Trick Room and setup decisions.
    const mean = (list) => {
      const live = list.filter(alive);
      return live.length ? live.reduce((sum, m) => sum + this.t.entrySpeedOf(m.u), 0) / live.length : 0;
    };
    const slower = [mean(sides[0]) < mean(sides[1]), mean(sides[1]) < mean(sides[0])];
    return { sides, active, next, board, slower, megaUsed };
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
      // Copied, not shared: one line's Mega Evolution must not be spent for every other line.
      megaUsed: [...base.megaUsed],
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
    const kept = out.slice(0, TOP_PER_SLOT);
    // Mega Evolution does not take the turn, so it is not an action of its own: it is a flag on
    // whatever this Pokemon was going to do anyway. Added AFTER the cut so that offering the
    // choice never pushes a real move off the list -- the Pokemon keeps every option it had, and
    // gains the same options again with the stone used.
    //
    // Not on a switch: a Pokemon that is leaving the field does not Mega Evolve on its way out.
    if (!this.canMega(state, s, position)) return kept;
    const evolving = kept
      .filter((a) => a.kind !== SWITCH && !a.wait)
      .map((a) => ({ ...a, mega: true }));
    return [...kept, ...evolving];
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
    // One Mega Evolution a side, for the whole battle. Both Pokemon reaching for the stone in the
    // same turn is not a turn either.
    joints = joints.filter((joint) => joint.filter((a) => a.mega).length <= 1);
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
      // Stat stages are lost the moment a Pokemon leaves the field. Nothing cleared them, so a
      // Pokemon that had been lowered or boosted kept it on the bench and brought it back in.
      // The stage the BOARD was set up with stays on the unit: that is the person's description
      // of the position, not something this line did, and it is in the damage cache key.
      out.atk = 0;
      out.spa = 0;
      out.spe = 0;
      out.def = 0;
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
      if (action.kind === ATTACK) {
        entry.hit = { slot: action.slot, spread: Boolean(info.spread) };
        // Priority the static move table does not list. Grassy Glide is +1 in Grassy Terrain for
        // a grounded user, and only the computed hit knows it -- the planner's own entries read
        // `pick.hit.priority`, so a PLANNED Grassy Glide moved first and a SEARCHED one moved
        // last on the very same board. A spread move has no single target, so it is priced
        // against the first live foe, which is where `plannedTurn` aims it anyway; the terrain
        // bonus does not depend on which foe it is.
        const aim = target || foes.find(alive) || null;
        if (aim) {
          const hit = this.t.hitOn(m, aim, action.slot, state.board, m.helped);
          if (hit && hit.priority !== undefined) entry.pr = hit.priority;
        }
      }
      plan.push(entry);
    }
    return plan;
  }

  /** The value of a board, from our side: 50 is even. */
  valueOf(state) {
    // ONE denominator for both sides. A mean over each side's OWN bring made a knockout worth a
    // different number of points to each of them: with two brought against four, losing one of
    // ours cost 25 and losing one of theirs gained 12.5, and the board still opened at an even
    // 50 -- which said a two-against-four board was level. Now a knockout is worth 50/n whoever
    // loses it, and a short side starts behind, which is what being short means.
    const total = (list) => list.reduce((sum, m) => sum + Math.max(0, m.hp), 0);
    const n = Math.max(1, state.sides[0].length, state.sides[1].length);
    return Math.max(0, Math.min(100, 50 + (50 * (total(state.sides[0]) - total(state.sides[1]))) / n));
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
    return state.sides.map((list) => list.map((m) => ({
      tag: m.tag, name: this.label(m.u), hp: Math.round(m.hp * 100), out: Boolean(m.out),
    })));
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
    // A Pokemon that came in this turn gets its entry Ability, exactly as a replacement does --
    // and in the same order `refill` uses, fastest first, so that the SLOWER one's weather is the
    // one left on the board. Walking the seats instead meant side 1 always won a weather war.
    const arriving = [];
    for (let s = 0; s < 2; s += 1) {
      for (const m of active[s]) if (m && m.justIn && !m.entered) { m.entered = true; arriving.push(m); }
    }
    arriving.sort((a, b) => this.t.entrySpeedOf(b.u) - this.t.entrySpeedOf(a.u));
    for (const m of arriving) this.t.enter(m, active, board, events);
    this.applyMegas(state, [ourJoint, theirJoint], events);
    this.thaw(state);
    const plans = [this.planFor(state, ourJoint, 0), this.planFor(state, theirJoint, 1)];
    this.t.plannedTurn(active, board, slower, turn, events, null, plans);
    this.tickBoard(state);
  }

  /**
   * The Mega Evolutions chosen this turn, in the order the game resolves them.
   *
   * After the switches and after the entry Abilities, before any move: that is where the game
   * puts it, and it is what makes the user's example come out right. Pelipper is standing with
   * Drizzle, so the board is already Rain; Charizard then Mega-Evolves and Drought replaces it
   * with Sun. Running it any earlier would have let the Rain overwrite the Sun.
   *
   * The faster Pokemon evolves first when both sides do it at once, so the slower one's weather
   * is the one left standing -- the same rule `refill` uses for two replacements arriving
   * together.
   */
  applyMegas(state, joints, events) {
    const { active, board } = state;
    const going = [];
    for (let s = 0; s < 2; s += 1) {
      for (const action of joints[s] || []) {
        if (!action || !action.mega) continue;
        const m = active[s][action.position];
        if (!m || m.out || !m.mega || state.megaUsed[s]) continue;
        state.megaUsed[s] = true;
        going.push(m);
        break;
      }
    }
    if (!going.length) return;
    going.sort((a, b) => this.t.entrySpeedOf(b.u) - this.t.entrySpeedOf(a.u));
    for (const m of going) {
      const was = m.u;
      const hadIntimidate = Boolean(m.k.intimidate);
      m.u = this.t.prepare(m.mega);
      m.k = m.u.kit;
      m.mega = null;
      events?.push({ s: m.s, kind: "mega", actor: was, value: this.label(m.u) });
      this.t.megaEnter(m, active, board, events, hadIntimidate);
    }
  }

  /**
   * The planner's own Mega Evolution, for the turns below the searched depth.
   *
   * The planner has no opinion about a stone, so without this a line would stay in its base form
   * for ever after the second turn -- which would make the base form look better than it is. It
   * takes the one on the field with the most to gain, which is what a player does by default.
   */
  autoMega(state, events) {
    const { active, board } = state;
    for (let s = 0; s < 2; s += 1) {
      if (state.megaUsed[s]) continue;
      let best = null;
      for (const m of active[s]) {
        if (!m || m.out || !m.mega) continue;
        if (!best || this.t.megaValue(m.mega) > this.t.megaValue(best.mega)) best = m;
      }
      if (!best) continue;
      state.megaUsed[s] = true;
      const was = best.u;
      const hadIntimidate = Boolean(best.k.intimidate);
      best.u = this.t.prepare(best.mega);
      best.k = best.u.kit;
      best.mega = null;
      events?.push({ s: best.s, kind: "mega", actor: was, value: this.label(best.u) });
      this.t.megaEnter(best, active, board, events, hadIntimidate);
    }
  }

  /** The planner's turn, for the tail below the searched depth. Returns what it chose. */
  applyPlannedTurn(state, turn, events) {
    const { active, board, slower } = state;
    this.autoMega(state, events);
    this.thaw(state);
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
  /**
   * The conditions that take HP at the end of a turn.
   *
   * Burn is paid by `TournamentTest.endOfTurn`, which is the Tournament Test's own and must not
   * learn anything new. Poison and bad poison are the Solver's, so they are paid here -- an
   * eighth, and a sixteenth more each turn to a ceiling of fifteen sixteenths, which is where the
   * game stops counting.
   */
  residual(state) {
    for (const row of state.active) {
      for (const m of row) {
        if (!m || m.out) continue;
        let cost = 0;
        if (m.psn) cost = 1 / 8;
        else if (m.tox) {
          m.toxTurns = Math.min(15, (m.toxTurns || 1) + 1);
          cost = Math.min(15, m.toxTurns) / 16;
        }
        if (!cost) continue;
        m.hp -= cost;
        if (m.hp <= 1e-9) {
          m.hp = 0;
          m.out = true;
        } else {
          this.t.berry(m);
        }
      }
    }
  }

  /**
   * Thawing, before anything is chosen.
   *
   * A frozen Pokemon does not act, and has one chance in five of thawing each turn. The turn
   * machinery already knows how to skip a Pokemon that cannot act -- it is the counter sleep
   * uses -- so freezing borrows it rather than growing a second one.
   */
  thaw(state) {
    for (const row of state.active) {
      for (const m of row) {
        if (!m || m.out || !m.frozen) continue;
        if (this.random() < 0.2) {
          m.frozen = false;
          continue;
        }
        m.idle = Math.max(m.idle, 1);
      }
    }
  }

  tickBoard(state) {
    // Not `sides`: what goes to `refill` is `benchFor(state)`, and a binding left here would
    // read as though the raw list still did.
    const { active, next, board } = state;
    // Before the empty slots are filled, so a Pokemon that goes down to its own poison is
    // replaced on the same turn as one that was knocked out by a move.
    this.residual(state);
    if (board.tw[0]) board.tw[0] -= 1;
    if (board.tw[1]) board.tw[1] -= 1;
    if (board.tr) board.tr -= 1;
    // Standing through a turn spends "just switched in". Nothing used to clear it -- not
    // `refill`, not `fresh` -- so a Pokemon marked just-in was offered Fake Out and First
    // Impression at EVERY searched turn, and one that switched in during the search kept the
    // flag for the rest of the line.
    const before = active.map((row) => row.map((m) => (m && !m.out ? m.u.id : null)));
    for (const row of active) for (const m of row) if (m) m.justIn = false;
    this.t.refill(active, this.benchFor(state), next, board);
    // A replacement sent out to fill a gap has only just arrived, so it gets what the game gives
    // a Pokemon that has only just arrived: Fake Out and First Impression on the turn it acts.
    //
    // `entered` is set with it, because `refill` has ALREADY run its entry Ability (it calls
    // `enter` on everything it brings in). Without this the next turn would see `justIn` with no
    // `entered` and fire that Ability a second time -- a second Intimidate, a second weather set.
    active.forEach((row, s) => row.forEach((m, i) => {
      if (m && !m.out && before[s][i] !== m.u.id) {
        m.justIn = true;
        m.entered = true;
      }
    }));
  }

  /**
   * `sides`, with the bench narrowed to the Pokemon that can still be sent out.
   *
   * `refill` takes whatever is next off the bench without asking whether it is still standing,
   * and `enter` then fires that Pokemon's entry Ability. So the bodies walked onto the field one
   * a turn, each one setting its weather and its Intimidate: measured, a fainted Pelipper put up
   * Rain and then a fainted Incineroar lowered both of the other side's Attack.
   *
   * READ THIS BEFORE ASSUMING IT IS ONLY ABOUT THE NEW CASE. It is not. Any board with a
   * knocked-out Pokemon behind the field reaches it, which the HP slider produces on an ordinary
   * two-standing board, and over 357 page-shaped boards (6,325 turns) 41 walk-ons fired -- not
   * one of them on a board with a side standing alone. Boards people have already answered
   * answer differently now: measured on one, the value moved 32.04 to 29.93 and the top line
   * changed which Pokemon it aimed at. That is the fix working, and it is still a change to
   * answers that were given before.
   *
   * Narrowing what is handed over rather than teaching `refill` to check: that method is the
   * Tournament Test's own and every recorded game was played through it exactly as it is.
   *
   * The first `next[s]` entries are passed through untouched, because `next` indexes into this
   * list and nothing may shift under it. Only the bench behind that is filtered, and it drops
   * both the fainted and anyone already standing -- the second is what keeps a Pokemon that a
   * switch moved down the list from being sent out while it is on the field.
   */
  benchFor({ sides, active, next }) {
    return sides.map((list, s) => [
      ...list.slice(0, next[s]),
      ...list.slice(next[s]).filter((m) => !m.out && !active[s].includes(m)),
    ]);
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
      sleep: "put the target to sleep", taunt: "taunted the target",
      encore: "locked the target with Encore", burn: "burned the target", blocked: "was blocked",
    };
    /**
     * The events that lower a stat, and whose stat it is.
     *
     * These three name the Pokemon that went DOWN in `targets` (the other side) and `own` (this
     * side, when a spread move catches the partner) -- never in `actor`, which is the one that
     * used the move. Rendering them as "actor + verb" like the rest produced "Milotic dropped
     * Speed" for an Icy Wind, which reads as Milotic dropping its own: Icy Wind drops the Speed
     * of what it hits. `null` means the stats are on the event itself.
     */
    const DROPS = { speeddrop: ["spe"], intimidate: ["atk"], lower: null };
    const STAT_WORDS = { atk: "Attack", spa: "Sp. Atk", spe: "Speed", def: "Defense", spd: "Sp. Def" };
    const notes = [];
    const add = (line) => { if (line && !notes.includes(line)) notes.push(line); };
    /** "Garchomp's", "Garchomp's and Amoonguss's". */
    const whose = (names) => names.map((name) => `${name}${name.endsWith("s") ? "'" : "'s"}`)
      .join(" and ");
    for (const event of events || []) {
      if (!event.actor) continue;
      // Mega Evolution, and the weather or terrain it brings with it. Worth saying out loud now
      // that it is a choice the search makes rather than something true from the first turn.
      if (event.kind === "mega") {
        add(`${this.label(event.actor)} Mega Evolved`);
        continue;
      }
      if (event.kind === "weather" || event.kind === "terrain") {
        add(`${this.label(event.actor)} set ${event.value}`);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(DROPS, event.kind)) {
        const stats = (DROPS[event.kind] || event.stats || []).map((key) => STAT_WORDS[key] || key);
        const said = stats.length ? stats.join(" and ") : "stats";
        const by = this.label(event.actor);
        const hit = (event.targets || []).map((unit) => this.label(unit));
        const mine = (event.own || []).map((unit) => this.label(unit));
        if (hit.length) add(`${by} dropped ${whose(hit)} ${said}`);
        // A spread move catches the partner too, and that drop is worth saying out loud.
        if (mine.length) add(`${by} also dropped ${whose(mine)} ${said}`);
        continue;
      }
      const what = NOTABLE[event.kind];
      if (!what) continue;
      add(`${this.label(event.actor)} ${what}`);
    }
    const damage = [];
    const fainted = [];
    // Matched by Pokemon, not by position. A switch swaps two entries of `sides`, so comparing
    // position i before the turn with position i after it compared two DIFFERENT Pokemon and
    // printed the difference as damage -- a turn where nobody healed reported "Sneasler 75% ->
    // 100%", and the Pokemon that really took the hit was never mentioned.
    for (let s = 0; s < 2; s += 1) {
      const was = new Map(before[s].map((m) => [m.tag, m]));
      for (const now of after[s]) {
        const then = was.get(now.tag);
        if (!then) continue;
        if (now.out && !then.out) fainted.push({ side: s, name: now.name });
        else if (then.hp !== now.hp) damage.push({ side: s, name: now.name, from: then.hp, to: now.hp });
      }
    }
    return { turn, plays, notes, damage, fainted, hp: after };
  }

  // --- the search ------------------------------------------------------------------------

  /**
   * Which action one side is leading with, by the same key `report` ranks by: lines played
   * first, mean second.
   *
   * -1 while any action is still unplayed, because `select` hands the first visit out one action
   * at a time -- until every one has a line the order is an artefact of that walk, not an answer,
   * and a settle test that trusted it would stop on the first slice.
   */
  leaderOf(stats) {
    let best = -1;
    let bestPlayed = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < stats.length; i += 1) {
      const entry = stats[i];
      if (!entry.n) return -1;
      const score = entry.sum / entry.n;
      if (entry.n > bestPlayed || (entry.n === bestPlayed && score > bestScore)) {
        bestPlayed = entry.n;
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

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
  /** Two lines that differ only in whether the stone was used are two different lines. */
  keyOf(joint) {
    // The stone is part of the identity, not only of the display: the comment above has always
    // said so and the key did not carry it, so a line and the same line with the stone used --
    // two rows with two different scores -- came out with one key between them.
    return joint.map((a) => `${a.position}:${a.kind}:${a.slot ?? ""}:${a.target ?? ""}:${a.into ?? ""}:${a.mega ? "M" : ""}`).join("|");
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
        // Whether this line spends the stone. Two joints that differ only in that are two
        // different lines with two different scores, so the page has to be able to tell them
        // apart -- without it the answer showed the same row twice.
        mega: Boolean(a.mega),
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
   * `settleLines` turns on the settle test: 0 (the default) leaves the search exactly as it was,
   * bounded by `iterations`, `deadline` and `shouldStop` and nothing else.
   *
   * @param {{lookahead?:number, iterations?:number, deadline?:number, seed?:number,
   *          settleLines?:number,
   *          onProgress?:(progress:object)=>void, shouldStop?:()=>boolean}} options
   */
  async search(setup, { lookahead = DEFAULT_LOOKAHEAD, iterations = 4000, deadline = 0, seed = 1,
    settleLines = 0, onProgress = null, shouldStop = null } = {}) {
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
    // What is watched is the ORDER of the top lines -- the row the page prints first for each
    // side -- not the board value beside it. The value is a running mean over every line played,
    // so its step shrinks as 1/played whatever the search is doing: it goes quiet early on a
    // board that is still changing its mind, which would stop the run on the wrong thing.
    let leading = [-1, -1];
    let heldSince = 0;
    let settled = false;
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
        let holding = false;
        let settling = 0;
        if (settleLines > 0) {
          const ourLead = this.leaderOf(root.stats[0]);
          const theirLead = this.leaderOf(root.stats[1]);
          if (ourLead < 0 || theirLead < 0 || ourLead !== leading[0] || theirLead !== leading[1]) {
            // Both -1 tests are needed. Without them a slice where one side is still handing out
            // first visits matches the starting [-1, -1] and the hold begins before the order
            // means anything.
            leading = [ourLead, theirLead];
            heldSince = played;
          } else {
            // Both conditions, not just the window: this is 1 exactly when `hasSettled` is
            // true, so the page can never show a finished number on a run that continues.
            settling = Math.min(1, (played - heldSince) / settleLines, played / (2 * settleLines));
            holding = hasSettled(played, heldSince, settleLines);
          }
        }
        if (onProgress) {
          onProgress({
            played, iterations, value: total / played,
            elapsed: (Date.now() - started) / 1000,
            calcs: this.t.calcs,
            nodes: nodes.size,
            settling,
          });
        }
        await tick();
        sliceStart = Date.now();
        // Order matters: a run the person ended, or one that hit its wall, is never reported as
        // settled.
        if (shouldStop && shouldStop()) break;
        if (deadline && Date.now() >= deadline) break;
        if (holding) {
          settled = true;
          break;
        }
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
      settled,
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
