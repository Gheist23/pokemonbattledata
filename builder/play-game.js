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
import { ACTION_KINDS, ACTIVE_BY_FORMAT, AIMED_AT_FOE, BRING_BY_FORMAT, TERRAINS, WEATHERS, alive } from "./tournament-test.js";
import { SOLVER_SLEEP_TURNS, SWITCH } from "./solver.js";
import { pointsForNature } from "./nature-spreads.js";
import { makeSet } from "./common.js";
import { compact } from "./engine.js";

/** How many possible versions of the player's team the opponent searches over. */
export const PLAY_POOL = 16;

/**
 * How many ways the player's unrevealed back is allowed to be, on an OPEN team sheet.
 *
 * Two standing out of four brought, from six, is C(4,2) = 6 ways at the start of a game and
 * fewer after that, so the cap is only ever reached on a board where almost nothing has been
 * shown. Each way is a whole board the opponent searches, so this multiplies its thinking.
 */
export const OPEN_BACK_BOARDS = 8;

/** Every way to choose `k` of `sets`, in order, up to `cap`. */
function chooseSets(sets, k, cap) {
  if (k <= 0) return [[]];
  if (sets.length < k) return [];
  const out = [];
  const pick = (start, acc) => {
    if (out.length >= cap) return;
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < sets.length && out.length < cap; i += 1) {
      acc.push(sets[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}
/** How long the opponent is given to choose, in milliseconds. A game is not a study. */
export const THINK_MS = 2600;

/**
 * The bounds a dynamic search plan may move between (`PlayGame.planSearch`).
 *
 * The opponent used to spend exactly THINK_MS on every turn of every game, whether the position
 * was a forced recapture or a four-way branch with both sides at full health. The budget is the
 * same on average; it is spent where it buys something.
 */
export const THINK_RANGE = [1200, 5200];
/** Turns of look-ahead the plan may ask for. The first two are SEARCHED (solver.js SEARCH_DEPTH);
 *  the rest are played out by the heuristic planner, which is cheap -- so a longer tail costs
 *  little and is worth most when the board is narrow enough for a line to mean something. */
export const LOOKAHEAD_BAND = [6, 12];
/** Turns ahead the opponent looks. */
export const PLAY_LOOKAHEAD = 10;
/** Nobody wants a game that never ends; past this the fuller side wins on what is left. */
export const TURN_LIMIT = 40;

/**
 * The six conditions, as the model's probability slot, the board's boolean, and a sentence.
 *
 * `applyStatus` decides WHICH slot from the move's own word; this maps that slot to everything
 * else that has to change when the condition becomes a fact.
 */
const STATUS_SLOT = {
  burn: "brn", poison: "psn", badly_poisoned: "tox", toxic: "tox",
  paralysis: "par", sleep: "slp", freeze: "frz",
};
const CONDITIONS = {
  brn: { said: "was burned" },
  psn: { said: "was poisoned" },
  tox: { said: "was badly poisoned" },
  slp: { said: "fell asleep" },
  frz: { said: "was frozen solid" },
  par: { said: "was paralysed" },
};

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
/** A condition that really landed this turn, rolled from the chance the engine would have added. */
const STATUS = "play:status";
/**
 * The registry ops a played turn can carry out, and so the ones that make a move choosable.
 *
 * A screen and a hazard are deliberately absent: this model has no Reflect and no Stealth Rock,
 * and offering the move would be offering one that does nothing. The move is still DRAWN on the
 * sheet -- all four always are -- and says it cannot be used.
 */
// `electric_boost` is here for a reason worth stating: `:549` requires EVERY op of a move to
// be runnable, and Charge's ops are now [electric_boost, stage]. Shipping the op without adding
// it here would have taken Charge OUT of the played game's move sheet -- a data-only change
// would have been strictly worse than not shipping it at all.
const RUNNABLE_OPS = new Set(["status", "stage", "heal", "weather_heal", "flinch", "electric_boost"]);
// `volatile` is deliberately NOT in that set, which is worth stating because Attract DOES ship
// with its clause intact -- data/builder/move-effects.json carries
// `attract: [{op: "volatile", status: "infatuation", condition: "opposite_gender"}]`, because
// `volatile` has always been on the exporter's WEB_MOVE_OPS list. Four things would each have to
// change before adding it here meant anything, and any one of them alone is fatal:
//   * there is no gender anywhere in the site's data. app-data.json's species carry none, and
//     neither the turn engine, the Solver nor this file has a gender field -- so a ported
//     `opposite_gender` could only answer "unknown" and pass, exactly as the Companion's does;
//   * `runEffectOps` has no `volatile` branch, so the op would run and do nothing;
//   * the per-row condition vector (`tournament-test.js` `st`) has six slots -- brn, psn, tox,
//     par, slp, frz -- and no volatile slot to record infatuation in;
//   * `actionScale` is the only place an action is reduced, and it multiplies flinch, sleep,
//     freeze and paralysis; an infatuation that costs a share of a turn would have to join it.
// Adding the op to this set without those would offer Attract in the move sheet and have it do
// nothing, which is worse than not offering it.

/**
 * The moves the SEARCH already has a kind for, by name.
 *
 * Nothing here may ever be re-offered as an EFFECT: when one of these is missing from a slot's
 * candidates it is missing because a RULE OF THE GAME removed it this turn -- Protect cannot be
 * used twice running, Fake Out only works on the turn its user came in -- and handing it back
 * is handing back a rule. The slot-indexed kinds (Fake Out, the sleep move, Taunt, Encore,
 * Will-O-Wisp, the stat drops) are read off the unit's own kit instead, which is where the
 * search records which slot each of them is.
 */
const MODELLED_MOVES = new Set(["tailwind", "trickroom", "helpinghand", "wideguard", "quickguard",
  "followme", "ragepowder", "taunt", "encore", "willowisp", "fakeout", "firstimpression"]);
/** What a registry op DID, for the line that reports it. A condition says itself; these do not. */
const EFFECT_SAID = { heal: "and regained health", flinch: "and made it flinch" };
/** The registry's words for an op aimed at the other side, as opposed to at the user's own. */
/** The chance a frozen Pokemon thaws at the end of a turn, as the games have it: one in five. */
const FREEZE_THAW = 0.2;
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
/**
 * A condition a played turn has pinned to certainty, in the two vocabularies that need it:
 * what the SCREEN says, and the key `STATUS_EFFECTS` in solver.js is indexed by, which is what
 * a board handed to the opponent's search must carry.
 */
const PINNED_SAID = [["slp", "Asleep", "sleep"], ["frz", "Frozen", "freeze"], ["brn", "Burned", "burn"],
  ["tox", "Badly poisoned", "toxic"], ["psn", "Poisoned", "poison"], ["par", "Paralysed", "paralysis"]];
/** The same condition as the key a row carries into `buildState`. */
function pinnedKey(m) {
  const st = m.st;
  if (!st) return "";
  if ((m.idle || 0) > 0 && (st.slp || 0) > 0) return "sleep";
  for (const [slot, , key] of PINNED_SAID) if ((st[slot] || 0) >= 1) return key;
  return "";
}
function pinned(m) {
  const st = m.st;
  if (!st) return "";
  // A SLEEP IS COUNTED IN TURNS, NOT IN SHARE. `endOfTurn` halves `st.slp` every turn, which is
  // how the expectation layer models a sleep wearing off -- so by the time the turn is over and
  // the screen is drawn, a Pokemon that has just been put to sleep holds 0.5, not 1. What makes
  // it a FACT in a played game is `idle`, the number of turns it will not act for, and that is
  // what the tile has to read. Reading the share alone showed nothing on a sleeping Pokemon.
  if ((m.idle || 0) > 0 && (st.slp || 0) > 0) return "Asleep";
  for (const [slot, said] of PINNED_SAID) if ((st[slot] || 0) >= 1) return said;
  return "";
}

function monView(m, full, record) {
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
    ability: full ? held.mon?.ability || "" : "",
    // Separate from `item`/`ability`/`moves`, which stay empty for a side whose sheet we do not
    // have. This is the part of it the game has SHOWN us, and it is all a tile may reveal.
    revealed: full ? null : {
      moves: [...(record?.moves || [])],
      item: record?.item || "",
      ability: record?.ability || "",
    },
    hp: Math.max(0, Math.round(m.hp * 100)),
    out: Boolean(m.out),
    // EVERY condition is read off the probability slot, because in a played game that is where
    // every condition lives: `applyStatus` pins the slot to 1 and writes no boolean beside it.
    // Reading the booleans first showed nothing at all -- a Pokemon put to sleep by a Sleep
    // Powder had `st.slp === 1` and an empty `status` on its tile. The booleans are still read
    // after, because they are what the engine sets with the effects registry off.
    status: pinned(m) || (m.sleep ? "Asleep" : m.frozen ? "Frozen" : m.burn ? "Burned"
      : m.tox ? "Badly poisoned" : m.psn ? "Poisoned" : ""),
    // Why a move may be refused this turn, so the screen can say so rather than dropping it.
    guardedLast: Boolean(m.guardedLast),
    justIn: Boolean(m.justIn),
    atk: m.atk || 0,
    spa: m.spa || 0,
    spe: m.spe || 0,
    def: m.def || 0,
    // The Sp. Def stage, which `fresh` has always kept and this has never passed on -- so an
    // Acid Spray or a Calm Mind was invisible on the one screen that lists the stages.
    spd: m.spd || 0,
    // The rest of the sheet, for a side whose sheet we have: the Nature and the Stat Points,
    // which decide every number on the Pokemon and were the one part of "all the info" the
    // panel could not say. `stat_spread_label` is the evaluator's own formatting of the pair.
    nature: full ? held.mon?.nature_name || "" : "",
    spread: full ? held.mon?.stat_spread_label || "" : "",
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
    /**
     * And the mirror: what the PLAYER has seen of the opponent's team, by team position.
     *
     * The same rules in the same direction -- a move is learnt by being used, an item by being
     * spent, an Ability by doing something. This is what "all known info" means on their side,
     * and it is the whole of what their tile and their sheet may show. It is kept whatever sheet
     * is being played, because on an open sheet it is a subset of what is already on the table.
     */
    this.shown = [];
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
    // The player's WHOLE six, not just the four they brought. Team preview shows both sides all
    // six, so the Solver legitimately knows them; what it must not know is which of them are
    // sitting in the back (`possibleBoards`).
    this.playerTeam = player.map((set) => set);
    this.shown = foe.map(() => ({ moves: [] }));
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

  /**
   * Everything the player's screen needs. Their own sheet in full, and ours too when the sheet
   * is OPEN -- that is what an open sheet means, and it was only ever honoured in one
   * direction: the Solver was handed the player's real sets while the player was still shown
   * "not shown yet" for every one of ours. `revealed` is still filled in for a closed sheet.
   */
  view() {
    const open = this.sheet === "open";
    const sides = this.state.sides.map((list, s) =>
      list.map((m) => monView(m, s === 0 || open, s === 1 ? this.shown[m.tag] : null)));
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
      const actions = this.slotActions(position, this.solver.slotCandidates(this.state, 0, position, { cap: 0 }));
      return {
        position,
        empty: false,
        name: this.solver.label(m.u),
        tag: m.tag,
        actions: actions.filter((a) => !a.wait).map((a, i) => ({
          id: `${position}:${i}`,
          kind: a.kind,
          move: a.move,
          ops: a.ops || null,
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

  /**
   * The search's candidates, plus one for every move on the sheet the search has no bid for.
   *
   * The search generates actions for the kinds it can PRICE. Measured over ten turns, that left
   * a Thunder Wave, a Toxic and a Nasty Plot with no action at all -- so the slot offered three
   * moves and the fourth could not be chosen, which is the whole of the "only three moves" bug.
   * Each of those gets an `EFFECT` action here, which the turn machinery runs off the registry.
   * One per live foe for a move aimed at a foe, one for a move aimed at its user.
   */
  slotActions(position, candidates) {
    const m = this.state.active[0][position];
    if (!m) return candidates;
    // Locked into landing a two-turn move: `slotCandidates` has already cut the list to that one
    // move, and this function's whole job is to ADD moves the search has no kind for -- which
    // would hand the lock straight back (TOURNAMENT_CHARGE).
    if (m.charging) return candidates;
    const offered = new Set(candidates.map((a) => (a.move ? compact(a.move) : "")).filter(Boolean));
    const modelled = this.modelledSlots(m);
    const extra = [];
    (m.u.moves || []).forEach((info, slot) => {
      if (!info?.name || offered.has(compact(info.name))) return;
      // A MOVE THE SEARCH HAS NO KIND FOR, never one it declined this turn. Three gates, and
      // each of them was a real bug before it was there:
      //   * an ATTACK is already a kind, so a damaging move is never missing for want of one.
      //     Without this, Fake Out came back every turn as a free certain flinch at +3 priority
      //     and a Thunderbolt aimed at a Ground type still paralysed it, because the EFFECT
      //     path runs a move's secondary without the damage and without any of the gates that
      //     go with it (Sheer Force, Shield Dust, a Covert Cloak, "can this even touch it").
      //   * a move whose slot or name the kit records IS priced; its absence is a game rule.
      //   * every one of its ops has to be runnable, not merely one of them. Rest is
      //     cure_status + heal + sleep: running the two we have left it healing to full and
      //     then failing to sleep, which is the opposite of what Rest is for.
      if (info.damaging || info.attack) return;
      if (modelled.has(slot) || MODELLED_MOVES.has(compact(info.name))) return;
      const ops = info.fx || [];
      if (!ops.length || !ops.every((fx) => RUNNABLE_OPS.has(String(fx.op || "")))) return;
      const aimed = ops.some((fx) => AIMED_AT_FOE.has(String(fx.target || "")));
      if (!aimed) {
        extra.push({ kind: ACTION_KINDS.EFFECT, slot, ops, move: info.name, target: null, pr: info.priority || 0 });
        return;
      }
      this.state.active[1].forEach((foe, i) => {
        if (!alive(foe)) return;
        extra.push({ kind: ACTION_KINDS.EFFECT, slot, ops, move: info.name, target: i, pr: info.priority || 0 });
      });
    });
    if (!extra.length) return candidates;
    // The same mega twins `slotCandidates` adds to everything else, and for the same reason:
    // Mega Evolution is a flag on whatever the Pokemon was going to do, not an action of its
    // own. Without them, arming the stone made every status move vanish from the sheet and a
    // Pokemon holding four of them never showed a Mega Evolve button at all.
    const twins = this.solver.canMega(this.state, 0, position)
      ? extra.map((a) => ({ ...a, mega: true })) : [];
    return [...candidates, ...extra, ...twins];
  }

  /**
   * The move slots this Pokemon's kit already accounts for.
   *
   * The kit is where `unitFor` writes down which slot holds the Fake Out, the sleep move, the
   * Taunt, the Encore, the Will-O-Wisp and the stat drops. A slot in here has a kind, so the
   * search can price it, so its absence from a slot's candidates is a decision and not a gap.
   */
  modelledSlots(m) {
    const k = m.k || {};
    const slots = new Set();
    for (const slot of [k.fakeOut, k.firstImpression, k.sleep, k.taunt, k.encore, k.wisp, k.speedDrop]) {
      if (Number.isInteger(slot) && slot >= 0) slots.add(slot);
    }
    for (const slot of k.lowers || []) if (Number.isInteger(slot) && slot >= 0) slots.add(slot);
    // Protect and its family are recorded as a flag rather than a slot, so they go by name.
    (m.u.moves || []).forEach((info, slot) => {
      if (info?.name && this.solver.t.protectMoves.has(compact(info.name))) slots.add(slot);
    });
    return slots;
  }

  /**
   * Whether the opponent has SEEN this Pokemon of the player's.
   *
   * `entered` is set when a Pokemon first stands on the field and is never cleared, so it is
   * exactly "has this been shown". A Pokemon that came in and went back out stays revealed,
   * which is right -- the opponent watched it.
   */
  revealed(m) {
    return Boolean(m && (m.entered || this.state.active[0].includes(m)));
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
      // An open sheet means the SETS are open, not the bring. Team preview shows all six of
      // each side and never says which four came or which two are waiting, so a Pokemon that
      // has not stood on the field yet is still a question -- and handing the opponent the
      // real one let it play around a Pokemon it had no way of knowing was there.
      //
      // So: everything it has seen is true, and each Pokemon it has NOT seen is one of the
      // player's six that is still unaccounted for. One board per way that could be, capped.
      const seenRows = playerRows.filter((m) => this.revealed(m));
      const unseen = playerRows.filter((m) => !this.revealed(m));
      const used = new Set(seenRows.map((m) => compact(m.u.species)));
      const spare = (this.playerTeam || [])
        .filter((set) => !used.has(compact(set.species)))
        .slice(0, 6);
      const ours = foeRows.map((m) => this.rowOf(m, 1, this.setOf(m)));
      const known = seenRows.map((m) => this.rowOf(m, 0, this.setOf(m)));
      const ways = chooseSets(spare, unseen.length, OPEN_BACK_BOARDS);
      if (!unseen.length || !ways.length) {
        return [{ sides: [ours, playerRows.map((m) => this.rowOf(m, 0, this.setOf(m)))], field: this.fieldOf() }];
      }
      return ways.map((sets) => ({
        sides: [ours, [...known, ...unseen.map((m, i) => this.rowOf(m, 0, sets[i]))]],
        field: this.fieldOf(),
      }));
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
      // THE PINNED SLOT FIRST, and paralysis at all.
      //
      // This is the one bridge from the live board to the boards the opponent searches
      // (`possibleBoards` -> `searchClosed` -> `buildState`, which rebuilds every row from
      // `row.status`). It read only the legacy booleans, and a played game sets none of them --
      // every condition lives in the probability slot -- so a Pokemon the player had just put
      // to sleep was handed to the opponent wide awake. It searched every line with its own
      // paralysed Pokemon at full Speed, and with the player's burned Pokemon dealing full
      // physical damage and taking no end-of-turn chip.
      status: pinnedKey(m) || (m.sleep ? "sleep" : m.frozen ? "freeze" : m.burn ? "burn"
        : m.tox ? "toxic" : m.psn ? "poison" : ""),
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
      // An Oran still uneaten, and how much of a cure berry is left (a share, not a flag: a
      // condition here is a probability and the berry is spent in proportion). Without these
      // the opponent searched every board as though a Lum Berry that cured a Spore three turns
      // ago were still in hand -- the same defect `sash` and `berry` above were given.
      oran: Boolean(m.oran),
      cure: Math.min(1, Math.max(0, Number(m.cure) || 0)),
      // How long the bad poison has been on, because that damage grows. A board that cannot say
      // starts it at one turn, which is wrong for a Pokemon six turns in.
      toxTurns: Math.max(0, Math.trunc(Number(m.toxTurns) || 0)),
      // Focus Energy and Dragon Cheer, which raise the crit stage for the rest of the battle.
      critStage: Math.max(0, Math.trunc(Number(m.critStage) || 0)),
      // Part-way through a two-turn move, as a move KEY. Without it every board the opponent
      // searches has a Pokemon that is free to act -- and one that is away on Fly standing there
      // to be hit. `buildState` finds the slot again from the key.
      charging: m.charging || "",
      // Carrying Charge's Electric Boost, restored by `buildState` (builder/solver.js). Without
      // it the one bridge from the live board to the boards the opponent searches dropped the
      // flag, so the opponent planned against an Electric move priced at half what it will do --
      // and the restore on the other side was dead code in production.
      charged: Boolean(m.charged),
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
  learnFrom(events, heldBefore, side, into) {
    const show = (m, key, value) => {
      if (!m || !value) return;
      const seen = (into[m.tag] ||= { moves: [] });
      if (!seen[key]) seen[key] = value;
    };

    for (const m of this.state.sides[side]) {
      const was = heldBefore.get(m.tag);
      if (!was) continue;
      // A Mega Evolution shows the stone and the Mega's own Ability at once.
      if (was.mega && !m.mega) {
        show(m, "item", m.u.item || "");
        show(m, "ability", m.u.mon?.ability || "");
      }
      // A Focus Sash that broke, or a berry that was eaten, shows which it was -- an Oran and
      // a cure berry as much as a Sitrus. `cure` is compared as a share: any of it spent is
      // the berry showing itself, which is what the player sees happen.
      if ((was.sash && !m.sash) || (was.berry && !m.berry) || (was.oran && !m.oran)
        || ((was.cure || 0) > (m.cure || 0))) show(m, "item", m.u.item || "");
    }

    // Abilities that DID something: the weather, the terrain, an Intimidate, a redirection. The
    // engine attributes each of those to the unit that caused it.
    for (const event of events || []) {
      if (!event || !event.actor) continue;
      if (!ABILITY_TELLS.has(event.kind)) continue;
      const m = this.monFor(event.actor.u || event.actor, side);
      if (m) show(m, "ability", m.u.mon?.ability || "");
    }
  }

  /**
   * A condition is still a FACT at the end of the turn, or it is over.
   *
   * `endOfTurn` wears a sleep off by decaying it -- `st.slp *= 0.5`, `st.frz *= 0.8` -- which is
   * how the expectation layer prices "it will wake up soon" without ever deciding when. In a
   * played game that leaves a Pokemon neither asleep nor awake: the tile stopped saying
   * "Asleep" while `actionScale` still took a quarter of its turn away, and the half-free
   * status slot read as a 50% chance that the next Thunder Wave would land and wipe the sleep.
   *
   * So the two that decay are decided here instead, once a turn, the way the game decides them:
   * a sleep lasts the turns `idle` counts and then ends; a freeze thaws one turn in five.
   * Everything else is permanent and is simply held at the certainty it was pinned to.
   */
  settleConditions() {
    for (const side of this.state.sides) {
      for (const m of side) {
        const st = m.st;
        if (!st) continue;
        if (st.slp > 0) {
          if ((m.idle || 0) > 0) st.slp = 1;
          else st.slp = 0;
        }
        if (st.frz > 0 && st.frz < 1) {
          if (this.rng() < FREEZE_THAW) { st.frz = 0; m.frozen = false; } else st.frz = 1;
        }
      }
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
    // The COUNTS, not whether they are up. `buildState` takes a number of turns for each of
    // these; flattening them to booleans handed the opponent a board where a Trick Room with one
    // turn left had its full four, so it searched lines that outlast a Trick Room which is about
    // to end -- and planned around a Tailwind it was going to lose.
    return {
      weather: WEATHERS[board.w] || "None",
      terrain: TERRAINS[board.t] || "None",
      trickRoom: board.tr > 0,
      trickRoomTurns: Math.max(0, board.tr || 0),
      tailwind: [Math.max(0, board.tw[0] || 0), Math.max(0, board.tw[1] || 0)],
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

  /**
   * How hard to think about THIS turn, and how far ahead to look.
   *
   * Three things about the position are read, all of them already computed for other reasons:
   *
   *   `width`  -- how many distinct actions the opponent actually has here, summed over the
   *               Pokemon it has standing. This is the branching factor, and it is what decides
   *               whether a fixed number of lines is a thorough search or a glance.
   *   `boards` -- how many possible versions of the player's team it is searching at once. Every
   *               line has to be played on one of them, so the work is width x boards.
   *   `alive`  -- how much game is left. A 1v1 endgame is a different question from a full board.
   *
   * The plan: spend the time where the branching is, and look further ahead when the board is
   * narrow enough for a long line to still mean something. A settle window is passed as well, so
   * a position with one obvious answer stops early instead of burning the whole deadline -- the
   * player gets the turn back, and the answer is the same one.
   *
   * The caller's values are CEILINGS, never floors: the tests drive this with thinkMs 100-400.
   */
  planSearch({ thinkMs = THINK_MS, lookahead = PLAY_LOOKAHEAD, pool = PLAY_POOL } = {}) {
    const boards = this.possibleBoards(pool);
    const state = this.state;
    let width = 0;
    state.active[1].forEach((m, position) => {
      if (!alive(m)) return;
      try {
        width += this.solver.slotCandidates(state, 1, position, { cap: 0 }).length;
      } catch { width += 1; }
    });
    const alive0 = state.sides[0].filter(alive).length;
    const alive1 = state.sides[1].filter(alive).length;
    const left = alive0 + alive1;
    // The work one line costs, relative to a plain board: wide positions and big pools both
    // mean the same fixed number of lines says less about any one action.
    const load = Math.max(0.5, (width / 12) * Math.max(1, boards.length / 3));
    // Time goes UP with the load and DOWN as the game empties out: an endgame is narrow, and the
    // same budget settles it several times over. The multiplier is deliberately capped well
    // short of double, so a busy board is a little slower rather than a wait -- measured, a full
    // Doubles board comes out near 3.5s and a 1v1 endgame at the floor, against the flat 2.6s
    // every turn of every game used to get.
    const wanted = THINK_MS * Math.min(1.35, Math.max(0.55, load * 0.45)) * (left <= 3 ? 0.55 : left <= 5 ? 0.8 : 1);
    const ms = Math.round(Math.max(THINK_RANGE[0], Math.min(THINK_RANGE[1], Math.min(wanted, thinkMs * 2))));
    // A narrow board can afford a longer tail; a wide one should buy more lines instead.
    const depth = width <= 10 ? LOOKAHEAD_BAND[1] : width <= 20 ? lookahead : LOOKAHEAD_BAND[0];
    return {
      boards,
      thinkMs: Math.min(ms, Math.max(200, thinkMs * 2)),
      lookahead: Math.max(LOOKAHEAD_BAND[0], Math.min(LOOKAHEAD_BAND[1], depth)),
      // Stop once the leading action has held for this many lines. Scaled to the load so a wide
      // board is not called settled on the strength of a few hundred lines.
      settleLines: Math.round(Math.max(400, 900 * load)),
      why: { width, boards: boards.length, alive: [alive1, alive0], load: Number(load.toFixed(2)) },
    };
  }

  async chooseFoe({ thinkMs = THINK_MS, lookahead = PLAY_LOOKAHEAD, pool = PLAY_POOL } = {}) {
    const plan = this.planSearch({ thinkMs, lookahead, pool });
    const result = await this.solver.searchClosed(plan.boards, {
      lookahead: plan.lookahead,
      iterations: 100000000,
      seed: (this.seed ^ ((this.turn + 1) * 0x9e3779b1)) >>> 0,
      deadline: Date.now() + Math.max(200, plan.thinkMs),
      settleLines: plan.settleLines,
    });
    if (result.error || !result.ours?.length) return { joint: [], thinking: { ...result, plan } };
    return { joint: this.readJoint(result.ours[0].raw || []), thinking: { ...result, plan } };
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
        // The registry ops an EFFECT action runs. They travel with the action because
        // `statusMove` reads them off it rather than looking the move up again.
        ops: pick.ops || null,
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
    // What each side showed the other this turn. A move is only revealed by being used, which is
    // exactly the information a real opponent gets -- and exactly what a real player gets back.
    const showMoves = (joint, side, into) => {
      for (const action of joint) {
        if (!action || action.wait || !action.move || action.kind === -1) continue;
        const m = this.state.active[side][action.position];
        if (!m) continue;
        const list = (into[m.tag] ||= { moves: [] }).moves;
        if (!list.some((move) => compact(move) === compact(action.move))) list.push(action.move);
      }
    };
    showMoves(ourJoint, 0, this.seen);
    showMoves(theirJoint, 1, this.shown);
    // What each side is carrying into this turn, so an item that is spent during it can be told
    // apart from one that was already gone.
    const heldBefore = this.state.sides.map((list) =>
      new Map(list.map((m) => [m.tag, { sash: m.sash, berry: m.berry, oran: m.oran, cure: m.cure, mega: Boolean(m.mega) }])));
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
    this.settleConditions();
    this.learnFrom(events, heldBefore[0], 0, this.seen);
    this.learnFrom(events, heldBefore[1], 1, this.shown);
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
      // A numeric seat is the only thing that counts as aimed: `action.target >= 0` is true for
      // the `null` a self-aimed action carries, because null coerces to 0 (see `aimedSeat` in
      // builder/solver.js, where the same coercion dropped the action outright). Harmless here
      // -- an out-of-range read gives undefined and the line below turns that into null -- and
      // written out so the next reader does not have to work that out.
      const seat = typeof action.target === "number" && action.target >= 0 ? action.target : -1;
      const aim = seat >= 0 ? this.state.active[1 - s][seat] : null;
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
        // A move that shares its hits out has no ONE target either, even though it is not a
        // spread move: Dragon Darts into two foes was declared as a single-target attack, so
        // the page named one of them and lunged at it while both were being hit. `seat < 0` is
        // the test and not `splitsHits` alone, because with one foe left the solver aims the
        // move normally and that one really is its target.
        // KNOWN AND ACCEPTED: this is decided BEFORE the turn resolves, so if a foe Protects
        // and the darts collapse onto the survivor, the caption still reads as shared and the
        // lunge still has no one target. It is cosmetic -- the `hit` steps below say which
        // Pokemon lost how much -- and naming a foe here instead would name one of the two in
        // the genuinely split case, which is the thing this flag exists to stop.
        shared: Boolean(seat < 0 && this.solver.t.splitsHits(info)),
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
    let rawDart = null;
    decorate("hitOn", (was) => {
      rawHitOn = was;
      return function hitOn(...args) {
        const hit = was.apply(this, args);
        lastAsked = { args, hit, halved: false };
        return hit;
      };
    });

    // A split move (Dragon Darts) halves the hit `hitOn` returned, and `dart` returns a COPY --
    // so the identity check below stopped matching and every critical dart was silently dropped
    // back to its ordinary damage. The record follows the copy, and remembers that it was
    // halved so the re-priced critical hit can be halved the same way: `rawHitOn` prices BOTH
    // darts into one target, so re-pricing without halving would make a critical dart land at
    // full two-dart strength, which is further wrong than dropping the crit was.
    decorate("dart", (was) => {
      rawDart = was;
      return function dart(hit) {
        const half = was.call(this, hit);
        if (lastAsked && lastAsked.hit === hit && half !== hit) {
          lastAsked = { args: lastAsked.args, hit: half, halved: true };
        }
        return half;
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
          const full = rawHitOn.apply(this, [...lastAsked.args.slice(0, 6), true]);
          const priced = lastAsked.halved && full && rawDart ? rawDart.call(this, full) : full;
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
          // Part-way through Fly, Dig, Dive, Bounce or Phantom Force: it is not there to be
          // hit, which is a different sentence from "it had no effect on it".
          : target.hidden ? "away"
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

    // A CONDITION IS ROLLED, ONCE, AND THEN IT IS A FACT. `applyStatus` is called first and does
    // all the work that is not the chance -- the move's word to a slot, the Ability immunities,
    // the "already has one" check -- and returns how much room it took. That number IS the
    // chance this turn, so it is what gets rolled; on a miss the room is handed straight back.
    // THE ROLL AN EFFECT MOVE USES. `runEffectOps` has no randomness of its own -- it lives in
    // the engine, which prices rather than rolls -- so a played turn lends it this one and takes
    // it back in `release`, exactly as it does with the decorated methods.
    const hadRoll = Object.prototype.hasOwnProperty.call(t, "effectRoll");
    const wasRoll = t.effectRoll;
    t.effectRoll = () => game.rng();
    undo.push(() => { if (hadRoll) t.effectRoll = wasRoll; else delete t.effectRoll; });

    decorate("applyStatus", (was) => function applyStatus(target, status, chance) {
      // ONE CONDITION AT A TIME, and a Pokemon that has one cannot take another.
      //
      // `statusFree` cannot be asked this, because the expectation layer WEARS A SLEEP OFF by
      // decaying it -- `endOfTurn` does `st.slp *= 0.5` -- so a Pokemon this game pinned asleep
      // reads as half free the next turn. That leftover room was being rolled as the chance a
      // new status lands: a Thunder Wave on a sleeping Pokemon succeeded about half the time,
      // wiped the sleep, and handed the opponent back the turns it was going to lose.
      if (target?.st && Object.keys(target.st).some((key) => (target.st[key] || 0) >= 1)) return 0;
      const room = was.call(this, target, status, chance);
      if (!(room > 0) || !target || !target.st) return room;
      const field = STATUS_SLOT[String(status || "").toLowerCase()] || "";
      if (!field) return room;
      if (game.rng() >= room) {
        // It did not happen. Give the room back so nothing downstream prices a chance that was
        // already resolved.
        target.st[field] = Math.max(0, (target.st[field] || 0) - room);
        return 0;
      }
      for (const key of Object.keys(target.st)) target.st[key] = 0;
      target.st[field] = 1;
      // NO BOOLEAN IS SET BESIDE IT. `m.burn` and `m.sleep` are the representation the engine
      // uses with the effects registry OFF, and writing both counts the condition twice: a burn
      // chipped a sixteenth for `st.brn` and another sixteenth for `m.burn`, so a burned Pokemon
      // lost an eighth a turn, and `statusFree` went negative. The slot is the whole of it --
      // `speed()`, the end-of-turn chip, the burn's halving of a physical attack and the damage
      // cache's `conditionOf` all read it, and at 1 every one of them prices a fact.
      if (field === "tox") target.toxTurns = Math.max(1, target.toxTurns || 1);
      if (field === "slp") target.idle = Math.max(target.idle || 0, SOLVER_SLEEP_TURNS);
      events.push({ kind: STATUS, mon: target, field });
      return room;
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
      let target = decl.spread || decl.shared ? null : aim || decl.target;
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
    // Steps waiting for the action that caused them to be announced first. See the STATUS
    // branch above; flushed by `release` after any event that pushes a step of its own.
    const pending = [];
    // Each remembers how long the list was when it was held, so it waits for a step of its own
    // action to be pushed and no longer.
    const release = () => {
      while (pending.length && pending[0].at < steps.length) {
        const { step } = pending.shift();
        steps.push(step);
      }
    };
    const releaseAll = () => { while (pending.length) steps.push(pending.shift().step); };

    /**
     * WHY a Pokemon's health moved at the end of the turn.
     *
     * `endOfTurn` knows the cause and keeps none of it -- it settles everything owed into one
     * number -- so the same four questions it asked are asked again here, in its order, against
     * the same board. Without this the turn ends with "was worn down", which is true of a burn,
     * a sandstorm and a Rocky Helmet alike and tells the player nothing about which.
     */
    const causeOf = (m) => {
      const st = m.st || {};
      if ((st.brn || 0) >= 1) return "burn";
      if ((st.tox || 0) >= 1) return "tox";
      if ((st.psn || 0) >= 1) return "psn";
      const field = this.state.board;
      if (m.k?.chippedBy && field.w === m.k.chippedBy) return WEATHERS[field.w] || "";
      if (field.t === TERRAINS.indexOf("Grassy") && m.u?.grounded) return "grassy";
      if (m.k?.leftovers) return "leftovers";
      return "";
    };

    let settled = false;
    const settle = () => {
      settled = true;
      // EVERYTHING HELD COMES OUT FIRST. A condition from a move's secondary has no event of
      // its own to release it -- `secondaries` calls `applyStatus` and pushes nothing -- so a
      // burn from the turn's LAST attack stayed held, and the end-of-turn chip was drawn before
      // the line saying it had been burned. The end of the turn is the last moment at which
      // "after the thing that caused it" still means anything.
      releaseAll();
      for (let s = 0; s < 2; s += 1) {
        for (const m of this.state.sides[s]) {
          const key = seatKey(s, m.tag);
          if (!hp.has(key)) continue;
          const now = percent(m.hp);
          if (now !== hp.get(key)) {
            steps.push({ kind: "residual", side: s, tag: m.tag, from: hp.get(key), to: now, cause: causeOf(m) });
            hp.set(key, now);
          }
          if (m.out) faint(m);
        }
      }
    };

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      // A held status goes out as soon as the action that caused it has said anything of its
      // own. `release` is called before each event rather than after, so the step that triggers
      // it -- the "X used Y" or the note -- is already on the list.
      release();
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
        } else if (event.refused === "away") {
          steps.push({ kind: "note", ...who, text: `${this.solver.label(target.u)} is out of reach` });
        } else if (event.refused === "nothing") {
          steps.push({ kind: "note", ...who, text: `${move} had no effect on ${this.solver.label(target.u)}` });
        } else if (!event.refused && event.roll !== undefined && event.roll <= 0) {
          // The roll to hit came up short. `odds` is the move's accuracy folded with its
          // cooldown, so this is "it did not happen" rather than strictly "it missed".
          steps.push({ kind: "miss", ...who });
        }
        continue;
      }
      // A STATUS MOVE THAT MISSED. `runEffectOps` rolls the move's accuracy once for the whole
      // move, and a miss has to be shown -- it is the same thing a missed attack is, and
      // without a step for it the move simply did nothing on screen with nothing said.
      if (event.kind === "missed") {
        const actor = this.monFor(event.actor, event.s);
        const victim = event.target ? this.monFor(event.target, 1 - event.s) : null;
        if (actor) ensureMove(actor);
        // Keyed on whoever it missed, exactly as the attack path keys it: `sentenceFor` reads
        // the step's side and tag to say "It missed X". A move aimed at its own user that
        // missed has nobody to name, so it is keyed on the user.
        const at = victim || actor;
        if (at) steps.push({ kind: "miss", side: at.s, tag: at.tag });
        continue;
      }
      if (event.kind === STATUS) {
        // HELD, not pushed. A status move deals no damage, so nothing has triggered the "X used
        // Y" step yet -- `ensureMove` is lazy and fires on a consequence. Pushing here put the
        // sleep on screen before the Sleep Powder that caused it. It goes out as soon as
        // anything else about this action does.
        if (event.mon) {
          pending.push({
            at: steps.length,
            step: { kind: "status", side: event.mon.s, tag: event.mon.tag, condition: event.field },
          });
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
      // A Mega Evolution gets a step of its own as well as its line, because the sprite has to
      // change on screen at that moment rather than when the turn is over.
      //
      // NOT by `monFor(event.actor)`: the event's actor is the unit as it was BEFORE evolving,
      // and by the time this runs the board holds the Mega -- so matching on the unit found
      // nothing and no step was ever emitted. The event carries its own side and the Mega's
      // label, which between them name exactly one standing Pokemon.
      if (event.kind === "mega" && event.s !== undefined) {
        const m = (this.state.active[event.s] || [])
          .find((x) => x && this.solver.label(x.u) === event.value);
        // THE MEGA'S NAME AND ITS FORM TRAVEL ON THE STEP. The animation would otherwise read
        // them off whichever board the page is holding, and during a playout that is the board
        // the turn STARTED from -- where this Pokemon has not evolved. Asking it for a sprite
        // returned the base artwork, which is what was already on the tile, so the swap was a
        // no-op for the opponent and only looked right for us by accident of timing.
        if (m) {
          pending.push({
            at: steps.length,
            step: {
              kind: "mega",
              side: m.s,
              tag: m.tag,
              name: event.value || this.solver.label(m.u),
              species: m.u.species,
              form: m.u.form || "",
            },
          });
        }
      }
      const text = this.noteFor(event);
      if (!text) continue;
      const actor = this.monFor(event.actor, event.s);
      if (ACTING.has(event.kind)) ensureMove(actor);
      steps.push(actor ? { kind: "note", text, side: actor.s, tag: actor.tag } : { kind: "note", text });
    }
    if (!settled) settle();
    releaseAll();
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
      // A move run straight off the registry. The CONDITION it inflicts gets its own step and
      // says itself, so this line is about the move being used -- and it has to exist, because
      // it is the step the pending condition waits for. Without it the poison was announced
      // after the poison damage had already been shown.
      case "effect": {
        const did = (event.did || []).filter((word) => !STATUS_SLOT[String(word).toLowerCase()]);
        const said = did.map((word) => EFFECT_SAID[word] || word).join(" and ");
        if (event.target) return `${by} used ${event.move} on ${name(event.target)}`;
        return said ? `${by} used ${event.move} — ${said}` : `${by} used ${event.move}`;
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
