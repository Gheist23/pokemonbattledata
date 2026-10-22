// A game you play against the Solver.
//
// The Solver already is a battle engine: it builds a board, offers both sides every action the
// turn machinery can resolve, plays a turn with both sides' choices and hands back what happened.
// A game is that, with one of the two sides chosen by a person instead of by a search.
//
// WHO KNOWS WHAT, which is the whole point of playing against this particular opponent:
//
//   * the GAME knows everything. There is one true board here and it is the only authority on
//     what is standing, what it is holding and how much HP it has.
//   * the PLAYER sees their own team in full and only what the game has revealed of ours.
//   * the SOLVER sees its own team in full and does NOT see the player's sets. It searches the
//     Closed Team Sheet way -- a pool of possible versions of the player's team, rolled from the
//     usage data -- and it pins what it has actually seen. Every move the player uses is pinned
//     on that Pokemon from then on, so the opponent genuinely learns over the course of a game
//     rather than starting each turn equally ignorant.
//
// That last part is not decoration. A search that samples the hidden team afresh every turn, with
// no memory of what it has been shown, keeps "maybe it has Protect" alive after watching the
// Pokemon fail to Protect four times. Pinning the revealed moves is the only belief-updating this
// model has, and without it the opponent plays worse the longer the game goes on.

import { HiddenSets } from "./hidden-sets.js";
import { ACTIVE_BY_FORMAT, BRING_BY_FORMAT, TERRAINS, WEATHERS, alive } from "./tournament-test.js";
import { SWITCH } from "./solver.js";
import { pointsForNature } from "./nature-spreads.js";
import { makeSet } from "./common.js";
import { compact } from "./engine.js";

/** How many possible versions of the player's team the opponent searches over. */
export const PLAY_POOL = 16;
/** How long the opponent is given to choose, in milliseconds. A game is not a study. */
export const THINK_MS = 2600;
/** Turns ahead the opponent looks. */
export const PLAY_LOOKAHEAD = 10;
/** Nobody wants a game that never ends; past this the fuller side wins on what is left. */
export const TURN_LIMIT = 40;

/**
 * The chance a hit is critical, by critical-hit stage. The game's own table.
 *
 * Only a played game reads it. The Tournament Test prices no crit at all and must not start:
 * its expectations are what keep it even. See the note at the top of this file.
 */
export const CRIT_CHANCE = [1 / 24, 1 / 8, 1 / 2, 1];

/**
 * The engine events that are an Ability doing something a watching opponent would see.
 *
 * Deliberately short. A Pokemon that merely HAS Drought has shown nothing; one that has just put
 * the sun up has shown everything.
 */
const ABILITY_TELLS = new Set(["weather", "terrain", "intimidate", "redirect"]);

/**
 * Held items that sharpen a critical hit by one stage.
 *
 * Checked against this game's own item list rather than copied from the mainline: Razor Claw is
 * not an item here at all, and Leek is -- it is on more than three quarters of recorded
 * Sirfetch'd. A Leek is +2 and only for Farfetch'd and Sirfetch'd, which is why it is a map of
 * stages rather than a set.
 */
const CRIT_ITEMS = new Map([["scopelens", 1], ["leek", 2]]);
/** The only two the Leek sharpens. Anybody else holding one gets nothing from it. */
const LEEK_HOLDERS = new Set(["farfetchd", "sirfetchd", "farfetchdgalar"]);

// --- a turn as a stream of steps --------------------------------------------------------------
//
// `turnRecord` describes a turn as four buckets -- plays, notes, damage, fainted -- with no
// ordering between them, and its damage is the difference between two HP snapshots taken either
// side of the WHOLE turn. That is an honest summary and it cannot be animated: it cannot say
// which attack took which HP, in what order, or that anything missed.
//
// So a turn also comes back as `stream`: the same turn as an ordered list of small plain steps,
// one per thing that happened, in the order it happened. Nothing is taken away -- the four
// buckets are built exactly as before and the page still prints them beside the animation.
//
// HOW THE ORDER IS GUARANTEED, which is the only part that matters:
//
// The engine already pushes its notable events into one array as the turn resolves, so their
// relative order is already right. Hits and misses were simply not among them. Rather than
// collect them separately and try to merge two lists afterwards -- which is guesswork -- the
// watch pushes its own markers INTO THAT SAME ARRAY as the turn runs. A marker between two
// engine events really did happen between them. The stream is then one walk over one array.
//
// WHAT THE ENGINE CANNOT SAY is left out rather than invented. There is no critical hit in this
// model at all, and no discrete flinch outside Fake Out: a chance to flinch, a paralysis and a
// sleep are folded into the damage as a fraction of an action (`TournamentTest.actionScale`), so
// a Pokemon never visibly loses its turn to them. Animating either would be a lie.

/**
 * The marker kinds the watch pushes into the engine's own ordered event array.
 *
 * Namespaced, and deliberately carrying no `actor`: `Solver.turnRecord` walks the very same
 * array to build the log's notes and skips any entry that has no `actor`, so a marker can never
 * turn into a log line or move a recorded parity number.
 */
const ATTEMPT = "play:attempt";
const ENTERED = "play:entered";
const SETTLED = "play:settled";

/**
 * The engine events that mean "this Pokemon is taking its action, now".
 *
 * A `move` step is emitted lazily -- the first time a Pokemon is seen doing something -- which
 * is what puts it in the order the turn RESOLVED rather than the order the actions were chosen.
 * So this set matters: `weather`, `terrain` and `intimidate` are entry Abilities and not moves
 * at all, `mega` resolves before anybody acts, `heldback` is pushed for the whole turn before
 * the first action, and `recoil`, `residual` and `burnout` are the end of the turn. Emitting a
 * move step for any of those would put it before moves that really went first.
 *
 * `taunted` is not here either, and that is not an oversight: it is the event for a move that
 * was REFUSED, so there is nothing to animate but the note.
 */
const ACTING = new Set(["protect", "wideguard", "quickguard", "helpinghand", "fakeout",
  "tailwind", "trickroom", "redirect", "speeddrop", "lower", "sleep", "burn", "taunt",
  "encore", "encorefail", "blocked", "fails", "ko"]);

/** The stats an event lowered, when the event does not carry them itself. */
const DROPPED = { speeddrop: ["spe"], intimidate: ["atk"], lower: null };
const STAT_WORDS = { atk: "Attack", spa: "Sp. Atk", spe: "Speed", def: "Defense", spd: "Sp. Def" };

/** Whole percent, the way `monView` and the page's HP bar read it. */
const percent = (share) => Math.max(0, Math.round(share * 100));
/** One Pokemon, for the sets this walk keeps. `tag` is unique per side, not across both. */
const seatKey = (side, tag) => side * 16 + tag;

/** mulberry32, the same one the search uses, so a game is reproducible from its seed. */
export function randomFrom(seed) {
  let state = (seed >>> 0) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A tournament team as sets that can be played.
 *
 * The recorded teams carry everything but the Stat Points -- a sheet says what it brought, not
 * how it spent its points -- so the points come from the usage data, paired to the Nature the
 * sheet names. Drawing them independently of the Nature is what puts points into the stat a
 * Pokemon's own Nature lowers, which real teams never do.
 */
export function teamFromKnown(data, format, team) {
  return (team.members || []).map((member) => {
    const [species, form] = data.resolve(member.species, member.form || member.species);
    const usage = data.usage(format, species, form);
    const nature = member.nature || usage?.set?.nature || "Serious";
    const paired = pointsForNature(usage?.spreads, nature, data.natures);
    const moves = (member.moves || []).filter(Boolean).slice(0, 4);
    return makeSet({
      species,
      form,
      item: member.item || "",
      ability: member.ability || data.abilities(species, form)[0] || "",
      nature,
      bonuses: paired?.[1] || usage?.set?.bonuses || [0, 0, 0, 0, 0, 0],
      moves: moves.length ? moves : [...(usage?.set?.moves || [])],
    });
  });
}

/** One Pokemon as the page draws it. `full` is for the side whose sheet you are allowed to see. */
function monView(m, full) {
  const held = m.mega || m.u;
  // `m.u` is whatever is STANDING THERE: the base form until it Mega Evolves and the Mega
  // afterwards, because `applyMegas` swaps the two over. So the form is the one to draw and the
  // one to name -- the species never changes and naming by it left a Mega Charizard Y labelled
  // "Charizard" on the field while its own move list called it Mega Charizard Y.
  const evolved = !m.mega && /^mega\b/i.test(String(m.u.form || ""));
  return {
    tag: m.tag,
    species: m.u.species,
    form: m.u.form,
    name: m.u.form || m.u.species,
    // Whether it has already used its stone. The page draws the Mega sprite from the FORM, and
    // must not pass the item to `data.sprite` -- that upgrades a stone holder to its Mega before
    // it has evolved.
    mega: evolved,
    item: full ? held.item || "" : "",
    hp: Math.max(0, Math.round(m.hp * 100)),
    out: Boolean(m.out),
    status: m.sleep ? "Asleep" : m.frozen ? "Frozen" : m.burn ? "Burned" : m.tox ? "Badly poisoned" : m.psn ? "Poisoned" : "",
    atk: m.atk || 0,
    spa: m.spa || 0,
    spe: m.spe || 0,
    def: m.def || 0,
    moves: full ? [...(held.mon?.moves || [])] : [],
  };
}

export class PlayGame {
  /**
   * @param {object} solver    a Solver, whose TournamentTest the game plays its turns through
   * @param {object} data      a loaded BuilderData
   * @param {string} format    "Doubles" or "Singles"
   * @param {object|null} library the real-set library, for rolling the player's hidden team
   * @param {object} [options]
   * @param {"open"|"closed"} [options.sheet] whether the opponent is shown the player's sets.
   *   "open" is the default and is what the ladder rates: it is the same game every time, so a
   *   rating means something. "closed" is the harder-to-read opponent, and is not rated.
   */
  constructor(solver, data, format, library = null, { sheet = "open" } = {}) {
    this.solver = solver;
    this.data = data;
    this.format = format;
    this.sheet = sheet === "closed" ? "closed" : "open";
    this.hidden = new HiddenSets(data, format, library);
    this.active = ACTIVE_BY_FORMAT[format];
    this.bring = BRING_BY_FORMAT[format];
    this.turn = 0;
    this.log = [];
    /** What the opponent has actually seen of the player's team, by team position. */
    this.seen = [];
  }

  /**
   * Start a game. `player` and `foe` are lists of sets in the order they were brought: the first
   * `ACTIVE` of each stand, the rest are the back.
   */
  start({ player, foe, seed = 1 }) {
    this.rng = randomFrom(seed);
    this.seed = seed;
    this.turn = 0;
    this.log = [];
    this.seen = player.map(() => ({ moves: [] }));
    this.board = {
      sides: [
        player.slice(0, this.bring).map((set, i) => ({ set, hp: 100, front: i < this.active, justIn: i < this.active })),
        foe.slice(0, this.bring).map((set, i) => ({ set, hp: 100, front: i < this.active, justIn: i < this.active })),
      ],
      field: {},
    };
    this.state = this.solver.buildState(this.board);
    // Turn 1 is the turn the leads came in on, so their entry Abilities have already resolved on
    // a board a person set up -- but this board was not set up, it was dealt, and nothing has
    // entered yet. Running them now is what puts the Intimidate and the weather on the field
    // before the first choice is made.
    const events = [];
    const before = this.solver.snapshot(this.state);
    // Watched like any other turn, so the leads coming out are `send` steps in the order they
    // arrive and each one's Ability is a note where it fired, from the one piece of code that
    // builds a stream rather than a second, nearly-identical one for the opening.
    const watch = this.watchTurn(events);
    try {
      this.enterLeads(events);
    } finally {
      watch.release();
    }
    this.log.push({
      turn: 0,
      plays: [],
      notes: this.noteLines(events),
      damage: [],
      fainted: [],
      stream: this.streamFrom({ events, before }),
    });
    return this.view();
  }

  /** The leads arrive: entry Abilities, fastest first, exactly as a replacement arrives. */
  enterLeads(events) {
    const arriving = [];
    for (let s = 0; s < 2; s += 1) {
      // `buildState` marks whoever is standing as having entered already, because a Solver board
      // describes a game in progress and re-running Intimidate on it would lower an Attack that
      // was lowered before the person described it. A game has not started yet, so here the
      // leads really have NOT entered, and saying so is what puts the first Intimidate, weather
      // and terrain on the board before anybody chooses anything.
      for (const m of this.state.active[s]) if (m) m.entered = false;
      for (const m of this.state.active[s]) if (m && !m.entered) { m.entered = true; arriving.push(m); }
    }
    arriving.sort((a, b) => this.solver.t.entrySpeedOf(b.u) - this.solver.t.entrySpeedOf(a.u));
    for (const m of arriving) this.solver.t.enter(m, this.state.active, this.state.board, events);
  }

  /** Everything the player's screen needs. Their own sheet in full; ours only as revealed. */
  view() {
    const sides = this.state.sides.map((list, s) => list.map((m) => monView(m, s === 0)));
    const standing = this.state.active.map((row) => row.map((m) => (m ? m.tag : null)));
    const board = this.state.board;
    return {
      format: this.format,
      turn: this.turn,
      sides,
      standing,
      field: {
        weather: board.w,
        terrain: board.t,
        trickRoom: board.tr > 0,
        tailwind: [board.tw[0] > 0, board.tw[1] > 0],
      },
      value: Math.round(this.solver.valueOf(this.state) * 10) / 10,
      over: this.over(),
      log: this.log,
    };
  }

  /** null while the game is on, else who won and why. */
  over() {
    const left = this.state.sides.map((list) => list.filter((m) => !m.out).length);
    if (!left[0] && !left[1]) return { winner: "draw", why: "Both sides went down together." };
    if (!left[0]) return { winner: 1, why: "You have nothing left standing." };
    if (!left[1]) return { winner: 0, why: "Their last Pokemon went down." };
    if (this.turn >= TURN_LIMIT) {
      const hp = this.state.sides.map((list) => list.reduce((sum, m) => sum + Math.max(0, m.hp), 0));
      if (Math.abs(hp[0] - hp[1]) < 1e-9) return { winner: "draw", why: `${TURN_LIMIT} turns, and nothing between you.` };
      return { winner: hp[0] > hp[1] ? 0 : 1, why: `${TURN_LIMIT} turns: the fuller side takes it.` };
    }
    return null;
  }

  /**
   * Every action the player may take this turn, by slot.
   *
   * The whole list, not the search's shortlist: a person is entitled to every move their Pokemon
   * really has, even the one the search would never look at.
   */
  options() {
    return this.state.active[0].map((m, position) => {
      if (!alive(m)) return { position, empty: true, actions: [] };
      const actions = this.solver.slotCandidates(this.state, 0, position, { cap: 0 });
      return {
        position,
        empty: false,
        name: this.solver.label(m.u),
        tag: m.tag,
        actions: actions.filter((a) => !a.wait).map((a, i) => ({
          id: `${position}:${i}`,
          kind: a.kind,
          move: a.move,
          slot: a.slot ?? null,
          target: a.target ?? -1,
          targetName: a.target >= 0 && this.state.active[1][a.target]
            ? this.solver.label(this.state.active[1][a.target].u) : "",
          into: a.into ?? null,
          intoName: a.into !== undefined && a.into !== null && this.state.sides[0][a.into]
            ? this.solver.label(this.state.sides[0][a.into].u) : "",
          partner: a.partner ?? null,
          pr: a.pr ?? 0,
          spread: Boolean(a.spread),
          mega: Boolean(a.mega),
        })),
      };
    });
  }

  /** The pool of possible boards the opponent searches: our team as it is, theirs as it might be. */
  possibleBoards(pool = PLAY_POOL) {
    const boards = [];
    // In SEAT order, not sides order: `buildState` re-seats its rows as [standing..., bench...]
    // and the live board does not, so handing over the sides order built a board whose seats were
    // in a different order from the real one. See `seatOrder`.
    const playerRows = this.seatOrder(0);
    const foeRows = this.seatOrder(1);
    // An open sheet is the closed search with nothing hidden: one board, the true one, and no
    // sampling. Rolling a pool of sixteen identical boards would only make the opponent think
    // sixteen times as slowly for the same answer.
    if (this.sheet === "open") {
      return [{
        sides: [
          foeRows.map((m) => this.rowOf(m, 1, this.setOf(m))),
          playerRows.map((m) => this.rowOf(m, 0, this.setOf(m))),
        ],
        field: this.fieldOf(),
      }];
    }
    for (let d = 0; d < pool; d += 1) {
      const rolled = this.hidden.rollSide(playerRows.map((m) => ({
        species: m.u.species,
        form: m.u.form,
        // Everything the opponent has watched this Pokemon do. Not what it IS -- what it has
        // SHOWN. `HiddenSets.honours` pins each of these, so a Pokemon that has Mega Evolved is
        // no longer sampled with some other item.
        fixed: {
          moves: [...(this.seen[m.tag]?.moves || [])],
          item: this.seen[m.tag]?.item || "",
          ability: this.seen[m.tag]?.ability || "",
        },
      })), this.rng);
      boards.push({
        // Side 0 is the opponent in its own search, because the Solver scores side 0.
        sides: [
          foeRows.map((m) => this.rowOf(m, 1, this.setOf(m))),
          playerRows.map((m, i) => this.rowOf(m, 0, rolled[i].set)),
        ],
        field: this.fieldOf(),
      });
    }
    return boards;
  }

  /** One live Pokemon as a board row the Solver can rebuild from. */
  rowOf(m, side, set) {
    return {
      set: set || this.setOf(m),
      hp: Math.max(0, Math.round(m.hp * 100)),
      front: this.state.active[side].includes(m),
      justIn: Boolean(m.justIn),
      status: m.sleep ? "sleep" : m.frozen ? "freeze" : m.burn ? "burn" : m.tox ? "toxic" : m.psn ? "poison" : "",
      atk: m.atk || 0, spa: m.spa || 0, spe: m.spe || 0, def: m.def || 0,
      // Protected on the turn just ended, so it cannot protect on this one. Without this every
      // board the opponent searched said it had not, and it protected every turn of the game
      // while the player -- whose options come off the real board -- correctly could not.
      guardedLast: Boolean(m.guardedLast),
      // A Focus Sash is used once and a Sitrus Berry is eaten once. `fresh` reads both off the
      // KIT, which is a fact about the set rather than about this battle, so every board the
      // opponent searched handed them back -- and it planned around a Sash that had already
      // broken turns ago.
      sash: Boolean(m.sash),
      berry: Boolean(m.berry),
      // How long the bad poison has been on, because that damage grows. A board that cannot say
      // starts it at one turn, which is wrong for a Pokemon six turns in.
      toxTurns: Math.max(0, Math.trunc(Number(m.toxTurns) || 0)),
      // Focus Energy and Dragon Cheer, which raise the crit stage for the rest of the battle.
      critStage: Math.max(0, Math.trunc(Number(m.critStage) || 0)),
      // Already Mega Evolved. The set above is always the base one, so this is the only thing
      // saying the stone has been spent and the Pokemon is standing there in its Mega form.
      mega: this.alreadyMega(m),
    };
  }

  /**
   * One side's rows in the order `buildState` will seat them: standing first, then the bench.
   *
   * `buildState` re-seats whatever it is given as [standing..., bench...]. The live board does
   * NOT: `refill` puts a replacement in whichever seat fell empty and leaves its place in the
   * sides list alone. Handing over the sides order therefore produced a board whose seats were
   * in a different order from the real one, and the search's answer -- which names a SEAT -- was
   * then applied to the wrong Pokemon.
   */
  seatOrder(side) {
    const standing = this.state.active[side].filter(Boolean);
    return [...standing, ...this.state.sides[side].filter((m) => !standing.includes(m))];
  }

  /** The set a standing Pokemon really has, read back off its unit. */
  /**
   * A live battler, as the set it was built from.
   *
   * It has to ROUND-TRIP: `buildState` turns this straight back into a unit, and a set that
   * describes a Pokemon which cannot exist produces a board that is not the game. Before a Mega
   * Evolution `m.u` is the base and `m.mega` is the Mega; after one they have swapped, and
   * reading the species off `m.u` while reading everything else off the Mega emitted the base
   * species with the MEGA form name and the stone still held -- a Pokemon in its Mega form that
   * has not used its stone. Rebuilt, it came back un-evolved, with base stats, the wrong
   * Ability, and its one Mega Evolution still to spend.
   *
   * So the set is always the BASE one, which is what a team sheet holds, and whether it has
   * already evolved travels separately (`rowOf`'s `mega`).
   */
  setOf(m) {
    const held = m.mega || m.u;
    return makeSet({
      species: m.u.species,
      // `baseForm` and `baseAbility` are what the team SHEET said, and they are correct on both
      // units of a stone holder -- the base one and the Mega one are built from the same set.
      // `m.u.form` is not: after a Mega Evolution it is the Mega's form name, which paired with
      // the base species described a Pokemon that cannot exist. And `held.mon.ability` is the
      // MEGA's Ability, which became the un-evolved Pokemon's `baseAbility` when rebuilt.
      form: m.u.baseForm || m.u.form,
      ability: m.u.baseAbility || held.mon?.ability || "",
      // Whichever of the two is holding it; a Mega unit's item is the stone it used.
      item: held.item || m.u.item || "",
      nature: held.mon?.nature_name || "Serious",
      bonuses: [...(held.mon?.bonuses || [0, 0, 0, 0, 0, 0])],
      moves: [...(held.mon?.moves || [])],
    });
  }

  /**
   * Record what our side SHOWED the opponent this turn: an item that was spent, an Ability that
   * did something visible. See the note at the top of this file for what counts.
   */
  learnFrom(events, heldBefore) {
    const show = (m, key, value) => {
      if (!m || !value) return;
      const seen = (this.seen[m.tag] ||= { moves: [] });
      if (!seen[key]) seen[key] = value;
    };

    for (const m of this.state.sides[0]) {
      const was = heldBefore.get(m.tag);
      if (!was) continue;
      // A Mega Evolution shows the stone and the Mega's own Ability at once.
      if (was.mega && !m.mega) {
        show(m, "item", m.u.item || "");
        show(m, "ability", m.u.mon?.ability || "");
      }
      // A Focus Sash that broke, or a Sitrus Berry that was eaten, shows which it was.
      if ((was.sash && !m.sash) || (was.berry && !m.berry)) show(m, "item", m.u.item || "");
    }

    // Abilities that DID something: the weather, the terrain, an Intimidate, a redirection. The
    // engine attributes each of those to the unit that caused it.
    for (const event of events || []) {
      if (!event || !event.actor) continue;
      if (!ABILITY_TELLS.has(event.kind)) continue;
      const m = this.monFor(event.actor.u || event.actor, 0);
      if (m) show(m, "ability", m.u.mon?.ability || "");
    }
  }

  /** Has this one already Mega Evolved? True once `applyMegas` has swapped it over. */
  alreadyMega(m) {
    return !m.mega && /^mega\b/i.test(String(m.u?.form || ""));
  }

  fieldOf() {
    const board = this.state.board;
    // The engine's OWN lists, imported and never retyped. `board.w` and `board.t` are indices
    // into them, so a copy of the same words in a different order is a different list: this had
    // Psychic and Misty the other way round, which did not merely mislabel the field -- this
    // field goes into the boards the opponent searches, so a game under Psychic Terrain was
    // being played out by the opponent under Misty.
    return {
      weather: WEATHERS[board.w] || "None",
      terrain: TERRAINS[board.t] || "None",
      trickRoom: board.tr > 0,
      tailwind: [board.tw[0] > 0, board.tw[1] > 0],
    };
  }

  /**
   * What the opponent plays this turn.
   *
   * It searches its own side of a pool of possible boards and takes the row it played most, which
   * is the same rule the Solver's own answer uses.
   */
  /**
   * The search's answer, in the game's own terms.
   *
   * The search names a SEAT (`position`) and a place in its own side list (`into`). Its board is
   * the seat-ordered one, so a position already means the right seat -- but `into` is an index
   * into that same re-ordered list, and the live board's `sides[1]` is in its original order.
   * Applying it untranslated switched in whichever Pokemon happened to sit at that index.
   */
  readJoint(joint) {
    const order = this.seatOrder(1);
    return (joint || []).map((action) => {
      if (!action || action.into === null || action.into === undefined) return action;
      const target = order[action.into];
      const at = target ? this.state.sides[1].indexOf(target) : -1;
      // A switch we cannot place is dropped rather than aimed at Pokemon zero.
      if (at < 0) return { ...action, wait: true, into: null };
      return { ...action, into: at };
    });
  }

  async chooseFoe({ thinkMs = THINK_MS, lookahead = PLAY_LOOKAHEAD, pool = PLAY_POOL } = {}) {
    const boards = this.possibleBoards(pool);
    const result = await this.solver.searchClosed(boards, {
      lookahead,
      iterations: 100000000,
      seed: (this.seed ^ ((this.turn + 1) * 0x9e3779b1)) >>> 0,
      deadline: Date.now() + Math.max(200, thinkMs),
    });
    if (result.error || !result.ours?.length) return { joint: [], thinking: result };
    return { joint: this.readJoint(result.ours[0].raw || []), thinking: result };
  }

  /** The player's chosen action ids, back into the actions they name. */
  /**
   * The player's chosen ids, as a joint action the turn can be played with.
   *
   * It also has to REFUSE what the game cannot do, because the screen offers each seat its own
   * list and neither list knows what the other chose:
   *   * one Mega Evolution a side. Both seats could be armed, and `applyMegas` then evolved the
   *     first and silently ignored the second;
   *   * one Pokemon cannot be switched into twice. Both seats could name the same one on the
   *     bench, and the engine then switched it in and straight back out again -- a wasted turn
   *     that looked like a bug in the game rather than in the choice.
   * Both are dropped to a plain wait, which is what the engine does with an action it cannot
   * carry out, rather than being silently mangled into something else.
   */
  jointFrom(options, chosen) {
    const joint = [];
    const taken = new Set();
    let megaSpent = false;
    options.forEach((slot, position) => {
      if (slot.empty) { joint.push({ position, kind: 0, wait: true }); return; }
      const pick = slot.actions.find((a) => a.id === chosen[position]) || slot.actions[0];
      if (!pick) { joint.push({ position, kind: 0, wait: true }); return; }
      // Two seats cannot bring the same Pokemon in.
      if (pick.into !== null && pick.into !== undefined) {
        if (taken.has(pick.into)) { joint.push({ position, kind: 0, wait: true }); return; }
        taken.add(pick.into);
      }
      const mega = Boolean(pick.mega) && !megaSpent;
      if (mega) megaSpent = true;
      joint.push({
        position, kind: pick.kind, slot: pick.slot, target: pick.target,
        into: pick.into, partner: pick.partner, pr: pick.pr, move: pick.move,
        spread: pick.spread, mega,
      });
    });
    return joint;
  }

  /** Resolve one turn with both sides' choices, and write down what happened. */
  /**
   * Give this board's Pokemon fresh engine ids.
   *
   * `searchClosed` begins by resetting the engine's caches, which bumps its generation, restarts
   * the unit numbering at zero and empties the damage cache. The search then files thousands of
   * damage numbers under ids 1..N for ITS OWN units -- and the live board, whose units still
   * carry ids from the previous generation, reads those entries for whichever of its Pokemon
   * happens to share a number. Measured before this: the same Rock Slide was 28.9% before the
   * opponent thought and 39.3% after.
   *
   * `prepare` renumbers exactly the units whose generation is stale, continuing from where the
   * search stopped, so nothing collides afterwards.
   */
  renumber() {
    const t = this.solver.t;
    for (const side of this.state.sides) {
      for (const m of side) {
        if (m.u) t.prepare(m.u);
        if (m.mega) t.prepare(m.mega);
      }
    }
  }

  resolve(ourJoint, theirJoint) {
    // The opponent has just searched, and a search resets the engine's caches. See `renumber`.
    this.renumber();
    this.turn += 1;
    const before = this.solver.snapshot(this.state);
    const chosen = [
      ...this.solver.describe(ourJoint, this.state, 0),
      ...this.solver.describe(theirJoint, this.state, 1),
    ];
    // Focus Energy and Dragon Cheer: a `crit_stage` op that names a target raises somebody's
    // crit stage for the rest of the battle rather than describing the move's own ratio. Applied
    // here, where the move has just been used, and cleared by `refill` when a Pokemon leaves.
    for (const side of [ourJoint, theirJoint]) {
      const s = side === ourJoint ? 0 : 1;
      for (const action of side || []) {
        if (!action || action.wait || !action.move || action.kind === SWITCH) continue;
        const m = this.state.active[s][action.position];
        if (!m) continue;
        for (const op of this.solver.t.effectsOf(action.move) || []) {
          if (!op || op.op !== "crit_stage" || !op.target) continue;
          const amount = Number(op.target === "ally_side" ? (op.dragon_amount ?? op.amount) : op.amount) || 0;
          if (op.target === "user") m.critStage = (m.critStage || 0) + amount;
          else if (op.target === "ally_side") {
            for (const mate of this.state.active[s]) if (mate) mate.critStage = (mate.critStage || 0) + amount;
          }
        }
      }
    }
    // What the player showed us this turn. A move is only revealed by being used, which is
    // exactly the information a real opponent gets.
    for (const action of ourJoint) {
      if (!action || action.wait || !action.move || action.kind === -1) continue;
      const m = this.state.active[0][action.position];
      if (!m) continue;
      const list = (this.seen[m.tag] ||= { moves: [] }).moves;
      if (!list.some((move) => compact(move) === compact(action.move))) list.push(action.move);
    }
    // What our side is carrying into this turn, so an item that is spent during it can be told
    // apart from one that was already gone.
    const heldBefore = new Map(this.state.sides[0].map((m) => [m.tag, { sash: m.sash, berry: m.berry, mega: Boolean(m.mega) }]));
    // Read BEFORE the turn, because this is the only moment either survives: a joint action's
    // `position` means what it says until `applySwitches` moves Pokemon between the field and
    // the bench, and `ix` is where each Pokemon sits in its side's list before that same swap.
    const declared = [this.declare(ourJoint, 0), this.declare(theirJoint, 1)];
    const ixWas = this.state.sides.map((list) => new Map(list.map((m) => [m.tag, m.ix])));
    const events = [];
    const watch = this.watchTurn(events);
    // THE TURN GETS ITS OWN ROLL STREAM. The hit and damage rolls do not come from `this.rng` --
    // they come from `Solver.random` through `t.rollHit` -- and `searchClosed` re-seeds that at
    // the start of every one of the opponent's turns. So a game replayed from its seed, with the
    // same choices, did NOT play out the same way: the rolls depended on how long the opponent
    // had been given to think. Derived from the game's seed and the turn number instead, it is
    // the same every time, and the search's own stream is handed back untouched.
    const borrowed = this.solver.random;
    this.solver.random = randomFrom((this.seed ^ ((this.turn + 1) * 0x85ebca6b)) >>> 0);
    try {
      this.solver.applyChosenTurn(this.state, ourJoint, theirJoint, this.turn, events);
    } finally {
      // Whatever happens, the engine goes back exactly as it was found. A turn that left
      // `onHit` wrapped would be a game that quietly stops Stamina working after turn one.
      this.solver.random = borrowed;
      watch.release();
    }
    this.learnFrom(events, heldBefore);
    // Focus Energy is lost the moment its user leaves the field. Kept on the row, which follows
    // a Pokemon onto the bench, it would still be there when it came back.
    for (let s = 0; s < 2; s += 1) {
      for (const m of this.state.sides[s]) {
        if (m.critStage && !this.state.active[s].includes(m)) m.critStage = 0;
      }
    }
    const record = this.solver.turnRecord(this.turn, chosen, events, before, this.solver.snapshot(this.state));
    // Additive, and last: the four buckets above are built from the same events and the same
    // snapshots they always were.
    record.stream = this.streamFrom({ events, before, declared, ixWas });
    this.log.push(record);
    return record;
  }

  /**
   * What each of one side's Pokemon declared this turn, by `tag`.
   *
   * A switch is not in here. It is not a move, the stream says it with a `switch` step of its
   * own, and a Pokemon that switched in does not act on the turn it arrives.
   */
  declare(joint, s) {
    const map = new Map();
    for (const action of joint || []) {
      if (!action || action.wait || !action.kind || action.kind === SWITCH) continue;
      const m = this.state.active[s][action.position];
      if (!m) continue;
      const aim = action.target >= 0 ? this.state.active[1 - s][action.target] : null;
      // Whether the move actually strikes something, which the page needs to animate it: a
      // Pokemon using Protect must not charge across the field. It cannot be inferred from the
      // step -- a spread move carries no target either, and an attack stopped by Protect lands
      // no hit to read backwards from -- so it is taken from the engine's own classification.
      // `varPower` is in it because those moves are listed at 0 power and get their power from
      // the board, so `damaging` alone calls Eruption a status move.
      const info = action.move ? this.solver.t.moveInfo(action.move) : null;
      map.set(m.tag, {
        move: action.move || "",
        attack: Boolean(info && (info.damaging || info.varPower)),
        // A spread move has no one target, so the step says none rather than naming whichever
        // of the two or three it happened to resolve against first.
        spread: Boolean(action.spread),
        target: aim ? { side: 1 - s, tag: aim.tag } : null,
      });
    }
    return map;
  }

  /**
   * Watch one turn resolve, and put the engine back exactly as it was found.
   *
   * Four properties of the shared TournamentTest are decorated for the length of ONE
   * synchronous turn. Nothing is replaced: every one of them calls through to what was there,
   * with the same arguments, and returns what it returned.
   *
   *   * `deal` is the one place every hit in the game passes through, so it is where a hit can
   *     be SEEN and attributed. The hit object itself comes out of a cache keyed on ids and
   *     knows neither attacker nor target; `deal` is handed both. It also knows the three ways
   *     a hit comes to nothing that nothing else records at all -- a Protect, a target already
   *     down, a move that does nothing to it -- because it turns them away at the door and says
   *     so only by returning false. A move stopped by Protect pushes NO event anywhere, which
   *     is why the attack a Protect stopped could not be animated before this.
   *   * `rollHit` is the Solver's roll-to-hit, and the only place a miss can be seen: a hit that
   *     does not land never reaches the damage. Called exactly once, because rolling it twice
   *     would take two numbers out of the game's own random stream.
   *   * `enter` is observed, and given somewhere to put its events: `refill` calls it with no
   *     array at all, so a replacement arriving -- and its Intimidate -- was invisible.
   *   * `refill` marks the boundary between "all HP settled" and "replacements arrive", which is
   *     where the end-of-turn chip belongs.
   *
   * `onHit` IS NOT TOUCHED. It is the Solver's own and it is Stamina, and a game that quietly
   * dropped it would stop Archaludon's Defense going up for the rest of the game with nothing
   * looking wrong about any single turn. `deal`'s own return value says whether a hit landed and
   * its target says what it took, so there was nothing left for `onHit` to add.
   *
   * `deal`, `enter` and `refill` are prototype methods rather than designed seams, so the
   * restore DELETES the shadow it put on the instance; `rollHit` is a property the Solver's own
   * constructor set, so that one is assigned back. Getting the two the wrong way round would
   * leave a game either without its damage rolls or with a decoration on the class.
   */
  watchTurn(events) {
    const t = this.solver.t;
    // The decorated functions are called with `this` bound to the TournamentTest, so the game
    // itself is captured by name here -- the critical-hit roll belongs to the game (it is the
    // game's seeded RNG that decides it), not to the engine it is decorating.
    const game = this;
    const watch = { last: null };
    const undo = [];
    const decorate = (name, make) => {
      const own = Object.prototype.hasOwnProperty.call(t, name);
      const was = t[name];
      t[name] = make(was);
      undo.push(() => { if (own) t[name] = was; else delete t[name]; });
    };

    // Every `deal` is preceded by the `hitOn` that produced its hit, at every call site. The
    // arguments are kept so the same hit can be asked for again, priced as a critical one --
    // `deal` itself is handed the finished number and has no idea what produced it.
    let lastAsked = null;
    let rawHitOn = null;
    decorate("hitOn", (was) => {
      rawHitOn = was;
      return function hitOn(...args) {
        const hit = was.apply(this, args);
        lastAsked = { args, hit };
        return hit;
      };
    });

    decorate("deal", (was) => function deal(...args) {
      const target = args[1];
      let hit = args[2];
      // A critical hit. Rolled only when the hit is actually going to land -- a Protected or
      // already-fainted target is turned away below without the roll being spent, so the game's
      // random stream does not depend on how many hits were refused.
      let crit = false;
      const info = args[0]?.u?.moves?.[hit?.slot];
      const landing = target && !target.out && !target.guard && hit && hit.frac > 0;
      if (landing && info && game.rollCrit(args[0], target, info)) {
        // Priced AGAIN as a critical hit rather than multiplied: a crit also ignores a Reflect
        // and the defender's Defense boosts, which a multiplier cannot express. `lastAsked` is
        // checked by identity -- if the hit did not come from the call we recorded, we do not
        // know how to re-price it and the crit is dropped rather than guessed.
        if (lastAsked && lastAsked.hit === hit && rawHitOn) {
          const priced = rawHitOn.apply(this, [...lastAsked.args.slice(0, 6), true]);
          if (priced && priced.frac > 0) {
            crit = true;
            hit = priced;
            args[2] = priced;
          }
        }
      }
      // Pushed BEFORE the engine looks at it, so the step sits in the array exactly where the
      // hit happened -- before the knockout event that may follow it, and before the next
      // Pokemon acts. What it did is written into this same object on the way back out.
      const step = {
        kind: ATTEMPT,
        att: args[0],
        target,
        from: target ? target.hp : 0,
        // Why nothing will happen, if nothing will: `deal`'s own door, asked in `deal`'s own
        // order, while the answers are still true. "" means the hit goes through to the roll.
        refused: !target ? "gone" : target.out ? "gone" : target.guard ? "guarded"
          : !hit || hit.frac <= 0 ? "nothing" : "",
        roll: undefined,
        crit,
        landed: false,
        to: target ? target.hp : 0,
      };
      watch.last = step;
      events.push(step);
      const landed = was.apply(this, args);
      if (target) {
        step.landed = Boolean(landed);
        step.to = target.hp;
      }
      return landed;
    });

    decorate("rollHit", (was) => function rollHit(...args) {
      const roll = was.apply(this, args);
      if (watch.last) watch.last.roll = roll;
      return roll;
    });

    decorate("enter", (was) => function enter(m, active, board, evs) {
      events.push({ kind: ENTERED, mon: m });
      // A caller that brought its own array keeps it, so nothing it does is changed; one that
      // brought none -- `refill` -- gets ours, which it cannot tell apart from a real one.
      return was.call(this, m, active, board, evs === null || evs === undefined ? events : evs);
    });

    decorate("refill", (was) => function refill(...args) {
      events.push({ kind: SETTLED });
      return was.apply(this, args);
    });

    return { release: () => { for (const back of [...undo].reverse()) back(); } };
  }

  /**
   * The Pokemon an event names, as a row of the board.
   *
   * An event carries the unit (`m.u`), which is what the damage calculator reads, and the stream
   * needs the row, which is what has a `tag`. The standing one is preferred because two rows of
   * one side share a cached unit when their sets are identical -- the same species with the same
   * item, Ability, Nature, points and moves, which the format's own clauses rule out, but the
   * preference costs nothing.
   */
  monFor(unit, side) {
    if (!unit) return null;
    const rows = this.state.sides[side] || [];
    const standing = this.state.active[side] || [];
    return rows.find((m) => m.u === unit && standing.includes(m)) || rows.find((m) => m.u === unit) || null;
  }

  /**
   * One turn as an ordered list of steps: one walk, over one array, in order.
   *
   * `before` is the HP snapshot the turn started from, `declared` what each side chose and
   * `ixWas` where everybody sat before the switches. The opening has neither of the last two.
   */
  streamFrom({ events, before, declared = [null, null], ixWas = null }) {
    const steps = [];
    const moved = new Set();
    const gone = new Set();
    const arrived = new Set();
    const replaced = new Map();
    // What the stream has last SAID about each Pokemon's HP, which is what the next step has to
    // carry on from if the page is to animate one bar moving rather than a set of numbers.
    const hp = new Map();
    for (let s = 0; s < 2; s += 1) {
      for (const row of (before && before[s]) || []) {
        hp.set(seatKey(s, row.tag), row.hp);
        // Whoever was already down before this turn started. Without this the end-of-turn pass
        // knocked out every Pokemon that had EVER gone down, once more every turn, because
        // being out is a lasting fact about a board and going down is an event.
        if (row.out) gone.add(seatKey(s, row.tag));
      }
    }

    // Switches first, because `applySwitches` is the first thing a turn does -- and it pushes no
    // event, so this is read off the board instead. `ix` is where a Pokemon sits in its side's
    // list, the switch is the only thing that ever moves it, and it swaps the leaver's with the
    // arriver's: so the arriver is whichever of a swapped pair ended up with the LOWER index,
    // because the standing Pokemon are the front of that list. Read rather than re-derived, so
    // a switch the engine refused does not appear here as one that happened.
    if (ixWas) {
      for (let s = 0; s < 2; s += 1) {
        for (const m of this.state.sides[s]) {
          const was = ixWas[s].get(m.tag);
          if (was === undefined || m.ix >= was) continue;
          const left = this.state.sides[s].find((o) => o !== m && o.ix === was);
          if (!left) continue;
          steps.push({ kind: "switch", side: s, outTag: left.tag, inTag: m.tag });
          arrived.add(seatKey(s, m.tag));
          replaced.set(seatKey(s, left.tag), m.tag);
        }
      }
    }

    const faint = (m) => {
      if (!m || gone.has(seatKey(m.s, m.tag))) return;
      gone.add(seatKey(m.s, m.tag));
      steps.push({ kind: "faint", side: m.s, tag: m.tag });
    };

    /** The move a Pokemon chose this turn, for the lines that name it. */
    const moveNameOf = (m) => (m && declared[m.s] ? declared[m.s].get(m.tag)?.move || "its attack" : "its attack");

    /**
     * "X used Y", once per Pokemon per turn, the first time that Pokemon is seen doing anything.
     *
     * `aim` is where the move actually went, which is the truth and not always what was aimed
     * at: a target that switched out is replaced before the move resolves, and a redirector
     * takes it instead. Without one, the declared target is carried through this turn's switches
     * so the step names whoever is standing in that seat now rather than a Pokemon on the bench.
     */
    const ensureMove = (m, aim = null) => {
      if (!m || moved.has(seatKey(m.s, m.tag))) return;
      const decl = declared[m.s] ? declared[m.s].get(m.tag) : null;
      moved.add(seatKey(m.s, m.tag));
      if (!decl || !decl.move) return;
      let target = decl.spread ? null : aim || decl.target;
      if (target && !aim && replaced.has(seatKey(target.side, target.tag))) {
        target = { side: target.side, tag: replaced.get(seatKey(target.side, target.tag)) };
      }
      steps.push({
        kind: "move",
        side: m.s,
        tag: m.tag,
        move: decl.move,
        attack: Boolean(decl.attack),
        targetSide: target ? target.side : null,
        targetTag: target ? target.tag : null,
      });
    };

    /**
     * The end of the turn, for everybody.
     *
     * The engine events a chip only when it KNOCKS OUT, and `Solver.residual` does not event
     * even that, so what the conditions took and what Leftovers gave back is read as the
     * difference between the last thing the stream said about a Pokemon and where the turn
     * actually left it. Run at the one moment that is true for everyone: `refill`, which is
     * after every drop of HP has been settled and before the first replacement arrives.
     */
    let settled = false;
    const settle = () => {
      settled = true;
      for (let s = 0; s < 2; s += 1) {
        for (const m of this.state.sides[s]) {
          const key = seatKey(s, m.tag);
          if (!hp.has(key)) continue;
          const now = percent(m.hp);
          if (now !== hp.get(key)) {
            steps.push({ kind: "residual", side: s, tag: m.tag, from: hp.get(key), to: now });
            hp.set(key, now);
          }
          if (m.out) faint(m);
        }
      }
    };

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event.kind === ATTEMPT) {
        const target = event.target;
        if (!target) continue;
        const who = { side: target.s, tag: target.tag };
        ensureMove(event.att, who);
        const move = moveNameOf(event.att);
        if (event.landed) {
          // `deal` returns true for a knockout as well, and leaves the target on 0. The faint
          // step comes from the knockout event in the next slot of this array.
          const to = percent(event.to);
          steps.push({ kind: "hit", ...who, from: percent(event.from), to, crit: Boolean(event.crit) });
          hp.set(seatKey(target.s, target.tag), to);
        } else if (event.refused === "guarded") {
          // Nothing anywhere records this. `deal` turns a hit away for a Protect without a word,
          // so the attack a Protect stopped was simply missing from the turn.
          steps.push({ kind: "note", ...who, text: `${this.solver.label(target.u)} blocked ${move}` });
        } else if (event.refused === "nothing") {
          steps.push({ kind: "note", ...who, text: `${move} had no effect on ${this.solver.label(target.u)}` });
        } else if (!event.refused && event.roll !== undefined && event.roll <= 0) {
          // The roll to hit came up short. `odds` is the move's accuracy folded with its
          // cooldown, so this is "it did not happen" rather than strictly "it missed".
          steps.push({ kind: "miss", ...who });
        }
        continue;
      }
      if (event.kind === ENTERED) {
        const m = event.mon;
        // A Pokemon that switched in already has a step that says where it came from. One that
        // did not is a replacement for something that went down, or a lead.
        if (m && !arrived.has(seatKey(m.s, m.tag))) steps.push({ kind: "send", side: m.s, tag: m.tag });
        continue;
      }
      if (event.kind === SETTLED) {
        settle();
        continue;
      }
      if (event.kind === "ko" || event.kind === "partnerko") {
        const was = events[i - 1];
        // The hit that did it is the step immediately before, which names the row rather than
        // the unit; the lookup is only there for a knockout that arrives another way.
        const victim = was && was.kind === ATTEMPT && was.target.u === event.target
          ? was.target
          : this.monFor(event.target, event.kind === "partnerko" ? event.s : 1 - event.s);
        ensureMove(this.monFor(event.actor, event.s));
        if (victim) hp.set(seatKey(victim.s, victim.tag), 0);
        faint(victim);
        continue;
      }
      if (event.kind === "recoil" || event.kind === "residual" || event.kind === "burnout") {
        const victim = this.monFor(event.actor, event.s);
        if (victim) {
          const key = seatKey(victim.s, victim.tag);
          if (hp.get(key) > 0) steps.push({ kind: "residual", side: victim.s, tag: victim.tag, from: hp.get(key), to: 0 });
          hp.set(key, 0);
        }
        faint(victim);
        continue;
      }
      if (event.kind === "protect") {
        const m = this.monFor(event.actor, event.s);
        ensureMove(m);
        if (m) steps.push({ kind: "protect", side: m.s, tag: m.tag });
        continue;
      }
      if (event.kind === "fakeout") {
        ensureMove(this.monFor(event.actor, event.s));
        // The one flinch this model has as a fact rather than a share of an action. The hit is
        // the step before this: `deal` runs before the flinch is set.
        const victim = this.monFor(event.target, 1 - event.s);
        if (victim) steps.push({ kind: "flinch", side: victim.s, tag: victim.tag });
        continue;
      }
      const text = this.noteFor(event);
      if (!text) continue;
      const actor = this.monFor(event.actor, event.s);
      if (ACTING.has(event.kind)) ensureMove(actor);
      steps.push(actor ? { kind: "note", text, side: actor.s, tag: actor.tag } : { kind: "note", text });
    }
    if (!settled) settle();
    return steps;
  }

  /**
   * One engine event in words, or "" for the ones the stream says with a step of its own.
   *
   * `turnRecord` has its own, de-duplicated, for the log that is printed beside the animation.
   * This one is positional: it is said where it happened.
   */
  noteFor(event) {
    if (!event || !event.actor) return "";
    const name = (unit) => this.solver.label(unit);
    const list = (units) => (units || []).map(name).join(" and ");
    const by = name(event.actor);
    switch (event.kind) {
      case "weather": return `${by} set ${event.value}`;
      case "terrain": return `${by} set ${event.value} Terrain`;
      case "mega": return `${by} Mega Evolved`;
      case "intimidate": return `${by} lowered ${list(event.targets)}'s Attack`;
      case "speeddrop":
      case "lower": {
        const stats = (DROPPED[event.kind] || event.stats || []).map((key) => STAT_WORDS[key] || key);
        const said = stats.length ? stats.join(" and ") : "stats";
        const lines = [];
        if ((event.targets || []).length) lines.push(`${by} dropped ${list(event.targets)}'s ${said}`);
        if ((event.own || []).length) lines.push(`${by} also dropped ${list(event.own)}'s ${said}`);
        return lines.join("; ");
      }
      case "blocked": return `${by}'s ${event.move} was blocked${event.by ? ` by ${event.by}` : ""}`;
      case "fails": return `${by}'s ${event.move} failed`;
      case "taunted": return `${by} is taunted and could not use ${event.move}`;
      case "heldback": return `${by} held back ${event.move}`;
      case "sleep": return `${by} put ${name(event.target)} to sleep`;
      case "burn": return `${by} burned ${name(event.target)}`;
      case "taunt": return `${by} taunted ${name(event.target)}`;
      case "encore": return `${by} locked ${name(event.target)} with Encore`;
      case "encorefail": return `${by}'s Encore failed`;
      case "helpinghand": return `${by} helped ${name(event.target)}`;
      case "tailwind": return `${by} set Tailwind`;
      case "trickroom": return `${by} turned Trick Room ${event.on ? "on" : "off"}`;
      case "redirect": return `${by} drew the attacks in`;
      case "wideguard": return `${by} used Wide Guard`;
      case "quickguard": return `${by} used Quick Guard`;
      default: return "";
    }
  }

  /**
   * Does this hit crit?
   *
   * Everything is read from the compiled registry (`crit_stage`, `guaranteed_crit`,
   * `critical_stage`, `crit_if_target_status`, `critical_immunity`) rather than from a list
   * written out here, so the website and the Companion cannot disagree about which moves have a
   * high ratio or which Abilities answer a crit.
   *
   * @param {object} att    the attacking row
   * @param {object} target the defending row
   * @param {object} info   the move, as `moveInfo` describes it
   */
  rollCrit(att, target, info) {
    if (!info || !att?.u || !target?.u) return false;
    const t = this.solver.t;
    const abilityOps = (name) => (t.abilityEffects?.[compact(String(name || ""))] || []);
    const has = (ops, op) => ops.some((entry) => entry && entry.op === op);

    // Nothing crits through Battle Armor or Shell Armor -- unless the attacker is a Mold
    // Breaker, which ignores the Ability as it ignores every other one. `moldBreaker` is set on
    // every unit by `prepare`, so this is the same answer the damage engine gives.
    if (!att.u.moldBreaker && has(abilityOps(target.u.mon?.ability), "critical_immunity")) return false;

    const moveOps = t.effectsOf(info.name) || [];
    if (has(moveOps, "guaranteed_crit")) return true;

    // Merciless. The model carries a status as the PROBABILITY of carrying it, so the question
    // "is this target poisoned" is itself a roll -- and answering it any other way would make
    // Merciless either always or never fire against a target that is 40% poisoned.
    const attackOps = abilityOps(att.u.mon?.ability);
    const merciless = attackOps.find((entry) => entry && entry.op === "crit_if_target_status");
    if (merciless) {
      const wanted = new Set((merciless.statuses || []).map((s) => String(s).toLowerCase()));
      const st = target.st || {};
      let chance = 0;
      if (wanted.has("poison")) chance += st.psn || 0;
      if (wanted.has("toxic")) chance += st.tox || 0;
      if (chance > 0 && this.rng() < chance) return true;
    }

    let stage = Math.max(0, Math.trunc(Number(att.critStage) || 0));
    // The move's OWN ratio. A `crit_stage` op that names a target is not that -- it is Focus
    // Energy or Dragon Cheer raising somebody's stage for the rest of the battle, which is
    // counted on the row above and applied when the move is used, not when it is read.
    for (const op of moveOps) {
      if (op && op.op === "crit_stage" && !op.target) stage += Number(op.amount) || 0;
    }
    for (const op of attackOps) if (op && op.op === "critical_stage") stage += Number(op.amount) || 0;
    const item = compact(String(att.u.mon?.item || ""));
    if (CRIT_ITEMS.has(item)) {
      const species = compact(String(att.u.mon?.pokemon_name || ""));
      if (item !== "leek" || LEEK_HOLDERS.has(species)) stage += CRIT_ITEMS.get(item);
    }
    return this.rng() < CRIT_CHANCE[Math.min(CRIT_CHANCE.length - 1, Math.max(0, stage))];
  }

  /** `turnRecord` builds its own notes; this is for the opening, which has no actions. */
  noteLines(events) {
    const out = [];
    for (const event of events || []) {
      if (event.kind !== "weather" && event.kind !== "terrain" && event.kind !== "intimidate") continue;
      const line = this.noteFor(event);
      if (line) out.push(line);
    }
    return out;
  }
}
