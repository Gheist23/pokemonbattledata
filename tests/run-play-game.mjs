// A game against the Solver (builder/play-game.js).
//
// What is checked here is that it is a GAME: both sides choose, the turn resolves through the
// same machinery every other page uses, somebody eventually wins, and neither side is told
// anything it has not been shown.
//
//   1. a game starts, both leads enter, and their entry Abilities are on the board;
//   2. the player is offered every move their Pokemon really has, not the search's shortlist;
//   3. a turn resolves, HP moves, and the log says what happened;
//   4. the opponent only ever learns a move by watching it used;
//   5. a whole game finishes with a winner, inside the turn limit;
//   6. the player's screen never carries the opponent's sheet;
//   7. a played turn comes back as an ORDERED stream of steps, so it can be animated: every
//      step where it happened, every hit on the Pokemon that really took it, and nothing in it
//      that the engine cannot actually say;
//   8. an OPEN team sheet shows the opponent the player's real sets and nothing else changes,
//      while a CLOSED one still hides them -- the two differ in exactly one thing, and the
//      default is open, because that is the game the ladder rates;
//   9. CRITICAL HITS happen in a played game, at the game's own rates, blocked by the Abilities
//      that block them, priced by calculating the hit as a critical one rather than by scaling
//      it -- and the Tournament Test that every other page reads still has none at all.
//
//   node tests/run-play-game.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData, makeSet } from "../builder/common.js";
import { compact, DamageEngine } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { ACTION_KINDS, TournamentTest } from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";
import { PlayGame, OPEN_BACK_BOARDS, THINK_RANGE, LOOKAHEAD_BAND, TURN_LIMIT, teamFromKnown } from "../builder/play-game.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const FORMAT = "Doubles";
const appData = read("data", "builder", "app-data.json");
const library = read("data", "builder", "pokemon-sets.json").sets;
const knownRaw = read("data", "builder", "known-teams.json");
const meta = read("data", "builder", `meta-${FORMAT.toLowerCase()}.json`);

const data = new BuilderData(appData);
data.ingestMeta(FORMAT, meta);

const engine = new DamageEngine(appData);
const ev = new TeamEvaluator(data, engine, FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
ev.setMetaRecords(meta.pokemon || []);
const evaluation = new TeamEvaluation(ev);
const known = new KnownTeams(knownRaw);
// WITH the compiled move and Ability effects, because that is how the worker builds it
// (analysis-worker.js loads /data/builder/move-effects.json and passes it in). Without them the
// game here would have no flinches, no secondary statuses and no critical-hit data at all -- a
// different game from the one the site plays, which is not worth testing.
const effects = read("data", "builder", "move-effects.json");
const solver = new Solver(new TournamentTest(evaluation, known, new TeamSuggestions(evaluation), { effects }));

const game = new PlayGame(solver, data, FORMAT, library);

/**
 * A team off the top of the ladder.
 *
 * By rank and not by name: a Pokemon that has dropped out of the meta has no usage record, and
 * `commonSet` then hands back a set with no item and no moves at all -- which is a real trap for
 * anything that builds a team from names, and was how this test first failed.
 */
const topTeam = (count) => meta.pokemon.slice(0, count).map((record) => {
  const set = data.commonSet(FORMAT, record.species, record.form);
  return makeSet({ ...set, moves: [...set.moves] });
});

/** One ranked Pokemon by name, or null when it has dropped off the ladder. */
const named = (name) => {
  const [species, form] = data.resolve(name, name);
  if (!data.usage(FORMAT, species, form)) return null;
  const set = data.commonSet(FORMAT, species, form);
  return set.moves.length ? makeSet({ ...set, moves: [...set.moves] }) : null;
};

const PLAYER = topTeam(4);
const FOE = teamFromKnown(data, FORMAT, known.teams[0]).slice(0, 4);

// ---------------------------------------------------------------------------
// 1. a game starts
// ---------------------------------------------------------------------------
{
  const view = game.start({ player: PLAYER, foe: FOE, seed: 11 });
  ok("a game starts", Boolean(view) && view.turn === 0);
  ok("both sides brought four", view.sides[0].length === 4 && view.sides[1].length === 4,
    `${view.sides[0].length} vs ${view.sides[1].length}`);
  ok("two a side are standing", view.standing[0].filter((t) => t !== null).length === 2
    && view.standing[1].filter((t) => t !== null).length === 2);
  ok("everything starts on full HP", view.sides.every((side) => side.every((m) => m.hp === 100)));
  ok("the game is not over before it starts", view.over === null);

  // Whether an entry Ability fires depends on who leads, so this is asked of a board built to
  // answer it: an Intimidate holder in the front must have lowered the other side's Attack
  // before the first choice is made. `buildState` marks a standing Pokemon as already entered --
  // a Solver board is a game in progress -- and a game that starts from it would otherwise open
  // with every lead's Ability silently skipped.
  const cat = named("Incineroar");
  if (cat) {
    const entry = new PlayGame(solver, data, FORMAT, library);
    const opening = entry.start({ player: [cat, ...topTeam(4).slice(0, 3)], foe: FOE, seed: 15 });
    ok("an Intimidate lead lowers the other side's Attack before the first choice",
      opening.sides[1].some((m) => m.atk < 0), JSON.stringify(opening.sides[1].map((m) => [m.name, m.atk])));
    ok("and the opening is written into the log", opening.log[0].notes.length > 0,
      JSON.stringify(opening.log[0].notes));
    notes.push(`start: ${opening.log[0].notes.join(" | ") || "(nothing on entry)"}`);
  }
}

// ---------------------------------------------------------------------------
// 1b. open and closed team sheets
// ---------------------------------------------------------------------------
{
  // The default matters: it is what somebody who never touches the toggle plays, and it is the
  // only kind of game the ladder counts.
  const byDefault = new PlayGame(solver, data, FORMAT, library);
  ok("a game is Open Team Sheet unless asked otherwise", byDefault.sheet === "open", byDefault.sheet);
  ok("a rubbish sheet value falls back to open",
    new PlayGame(solver, data, FORMAT, library, { sheet: "banana" }).sheet === "open");
  ok("closed is still available",
    new PlayGame(solver, data, FORMAT, library, { sheet: "closed" }).sheet === "closed");

  const shown = new PlayGame(solver, data, FORMAT, library, { sheet: "open" });
  shown.start({ player: PLAYER, foe: FOE, seed: 21 });
  const hiddenGame = new PlayGame(solver, data, FORMAT, library, { sheet: "closed" });
  hiddenGame.start({ player: PLAYER, foe: FOE, seed: 21 });

  // An open sheet has exactly ONE possible board, because nothing is unknown. Rolling a pool of
  // identical boards would only make the opponent think many times over for the same answer.
  // Four brought from four: nothing about the bring is in doubt, so there is one board.
  const openBoards = shown.possibleBoards();
  ok("an open sheet with nothing left to guess searches one board", openBoards.length === 1,
    String(openBoards.length));
  ok("a closed sheet searches a pool", hiddenGame.possibleBoards().length > 1,
    String(hiddenGame.possibleBoards().length));

  // ...but a real game brings FOUR OF SIX, and which two are waiting in the back is not on the
  // team sheet. An open sheet opens the SETS; it does not say who came.
  const six = topTeam(6);
  const bringer = new PlayGame(solver, data, FORMAT, library, { sheet: "open" });
  bringer.start({ player: six, foe: FOE, seed: 21 });
  const ways = bringer.possibleBoards();
  ok("with two of six still unseen the opponent searches several boards", ways.length > 1,
    String(ways.length));
  ok("and never more than the cap", ways.length <= OPEN_BACK_BOARDS, String(ways.length));
  // The two STANDING are the same on every board -- those it has watched come out.
  const fronts = ways.map((b) => b.sides[1].filter((r) => r.front).map((r) => r.set.species).join(","));
  ok("the Pokemon it has seen are the same on every board", new Set(fronts).size === 1,
    JSON.stringify(fronts));
  // The back is not.
  const backs = ways.map((b) => b.sides[1].filter((r) => !r.front).map((r) => r.set.species).sort().join(","));
  ok("the back is different on every board", new Set(backs).size === ways.length,
    JSON.stringify(backs));
  // Every guess is drawn from the player's own six, never invented.
  const sixNames = new Set(six.map((s) => s.species));
  ok("and every guess is one of the player's own six",
    ways.every((b) => b.sides[1].every((r) => sixNames.has(r.set.species))),
    JSON.stringify(backs));

  // Once a Pokemon has actually stood on the field it stops being a guess.
  const seenAll = new PlayGame(solver, data, FORMAT, library, { sheet: "open" });
  seenAll.start({ player: six, foe: FOE, seed: 21 });
  for (const m of seenAll.state.sides[0]) m.entered = true;
  ok("when everything has been shown there is one board again",
    seenAll.possibleBoards().length === 1, String(seenAll.possibleBoards().length));

  // In the opponent's own board, side 1 is the player (the Solver scores side 0 as itself).
  const asSeen = openBoards[0].sides[1];
  ok("the open board carries the player's whole team", asSeen.length === PLAYER.length,
    `${asSeen.length} vs ${PLAYER.length}`);
  const realMoves = PLAYER.map((set) => set.moves.filter(Boolean).map(compact).sort().join(","));
  const seenMoves = asSeen.map((row) => (row.set?.moves || row.moves || []).filter(Boolean).map(compact).sort().join(","));
  ok("and the real moves, not a guess at them",
    realMoves.every((moves, i) => moves === seenMoves[i]),
    JSON.stringify({ real: realMoves, seen: seenMoves }));
  const realItems = PLAYER.map((set) => compact(set.item || ""));
  const seenItems = asSeen.map((row) => compact((row.set?.item ?? row.item) || ""));
  ok("and the real items", realItems.every((item, i) => item === seenItems[i]),
    JSON.stringify({ real: realItems, seen: seenItems }));

  // The closed sheet must still be hiding something, or the toggle does nothing. Compared over
  // several rolls, because one roll can land on the truth by luck.
  let differed = false;
  for (let i = 0; i < 6 && !differed; i += 1) {
    const guesses = hiddenGame.possibleBoards().map((board) =>
      board.sides[1].map((row) => (row.set?.moves || row.moves || []).filter(Boolean).map(compact).sort().join(",")).join("|"));
    if (guesses.some((guess) => guess !== realMoves.join("|"))) differed = true;
  }
  ok("a closed sheet is still guessing", differed, "every rolled board matched the real team");

  // The search must actually run over a single board rather than falling over on a pool of one.
  const answer = await shown.chooseFoe({ thinkMs: 400, lookahead: 2, pool: 4 });
  ok("the opponent can choose with an open sheet", Array.isArray(answer.joint),
    JSON.stringify(answer.thinking?.error || answer.joint?.length));
  ok("and it chose something", (answer.joint || []).length > 0,
    JSON.stringify(answer.thinking?.error || ""));
}

// ---------------------------------------------------------------------------
// 9. critical hits
// ---------------------------------------------------------------------------
{
  const crit = new PlayGame(solver, data, FORMAT, library);
  crit.start({ player: PLAYER, foe: FOE, seed: 31 });
  const me = crit.state.sides[0][0];
  const you = crit.state.sides[1][0];
  const t = solver.t;

  /** Run the roll many times over a fixed stream and report the share that crit. */
  const rateOf = (attacker, defender, info, runs = 24000) => {
    let state = 1234567;
    crit.rng = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let z = state;
      z = Math.imul(z ^ (z >>> 15), z | 1);
      z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
      return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
    let hits = 0;
    for (let i = 0; i < runs; i += 1) if (crit.rollCrit(attacker, defender, info)) hits += 1;
    return hits / runs;
  };
  const near = (label, got, want, tol) => ok(label, Math.abs(got - want) <= tol,
    `${got.toFixed(4)} vs ${want.toFixed(4)} (+-${tol})`);

  // An ordinary move: one in twenty-four.
  const plain = t.moveInfo("Dragon Claw");
  near("an ordinary move crits about 1 in 24", rateOf(me, you, plain), 1 / 24, 0.006);

  // A high-ratio move: one in eight. Stone Edge is in the registry as crit_stage +1.
  const sharp = t.moveInfo("Stone Edge");
  ok("Stone Edge is a high-ratio move in the registry",
    (t.effectsOf("Stone Edge") || []).some((op) => op.op === "crit_stage"),
    JSON.stringify(t.effectsOf("Stone Edge")));
  near("a high-ratio move crits about 1 in 8", rateOf(me, you, sharp), 1 / 8, 0.012);

  // The five that always do.
  for (const name of ["Wicked Blow", "Frost Breath", "Storm Throw", "Surging Strikes", "Flower Trick"]) {
    const info = t.moveInfo(name);
    ok(`${name} always crits`, rateOf(me, you, info, 200) === 1);
  }

  // Battle Armor and Shell Armor stop every one of them, including the guaranteed ones.
  const armoured = { ...you, u: { ...you.u, mon: { ...you.u.mon, ability: "Battle Armor" } } };
  ok("Battle Armor is never critically hit", rateOf(me, armoured, plain, 4000) === 0);
  ok("and not even by a move that always crits",
    rateOf(me, armoured, t.moveInfo("Wicked Blow"), 400) === 0);
  const shelled = { ...you, u: { ...you.u, mon: { ...you.u.mon, ability: "Shell Armor" } } };
  ok("Shell Armor too", rateOf(me, shelled, plain, 4000) === 0);

  // Super Luck is +1, and a Scope Lens is +1 -- so together they take an ordinary move to 1/2.
  const lucky = { ...me, u: { ...me.u, mon: { ...me.u.mon, ability: "Super Luck" } } };
  near("Super Luck lifts an ordinary move to 1 in 8", rateOf(lucky, you, plain), 1 / 8, 0.012);
  const scoped = { ...me, u: { ...me.u, mon: { ...me.u.mon, item: "Scope Lens" } } };
  near("a Scope Lens does the same", rateOf(scoped, you, plain), 1 / 8, 0.012);
  const both = { ...me, u: { ...me.u, mon: { ...me.u.mon, ability: "Super Luck", item: "Scope Lens" } } };
  near("the two together reach one in two", rateOf(both, you, plain), 1 / 2, 0.02);
  const stacked = { ...both, u: { ...both.u, mon: { ...both.u.mon, ability: "Super Luck", item: "Scope Lens" } } };
  ok("and a high-ratio move on top of those always crits",
    rateOf(stacked, you, sharp, 500) === 1);

  // A crit must be PRICED as one, not scaled: it also ignores a Reflect and the defender's
  // Defense boosts, so against a raised defender it is worth considerably more than x1.5.
  const board = crit.state.board;
  const slot = me.u.moves.findIndex((m) => m && m.damaging);
  if (slot >= 0) {
    const normal = t.hitOn(me, you, slot, board, false);
    const critical = t.hitOn(me, you, slot, board, false, me, true);
    ok("a critical hit is asked for and answered", critical && critical.frac > 0,
      JSON.stringify({ normal: normal?.frac, critical: critical?.frac }));
    ok("and it hurts more", critical.frac > normal.frac,
      `${critical.frac} vs ${normal.frac}`);
    notes.push(`crit: ${me.u.moves[slot].name} ${(normal.frac * 100).toFixed(1)}% -> ${(critical.frac * 100).toFixed(1)}%`);
    // Against a defender standing at +2 Defense the ordinary hit is cut and the crit is not, so
    // the gap must be WIDER than the plain 1.5 the multiplier alone would give.
    const raised = { ...you, def: 2 };
    const softened = t.hitOn(me, raised, slot, board, false);
    const throughIt = t.hitOn(me, raised, slot, board, false, me, true);
    if (softened.frac > 0) {
      ok("a crit ignores the defender's Defense boosts",
        throughIt.frac / softened.frac > critical.frac / normal.frac + 0.05,
        `boosted ratio ${(throughIt.frac / softened.frac).toFixed(3)} vs plain ${(critical.frac / normal.frac).toFixed(3)}`);
    }
    // And asking for an ordinary hit again must give the ordinary number back: the crit must not
    // have been written into the shared damage cache.
    ok("the normal hit is unchanged afterwards",
      t.hitOn(me, you, slot, board, false).frac === normal.frac,
      "the crit leaked into the cache");
  }

  // The thing that must NOT have changed: the Tournament Test prices no crit at all, because its
  // expectations are what keep every evaluation on the site even.
  ok("the evaluation still asks for no critical hit",
    readFileSync(join(root, "builder", "tournament-test.js"), "utf8")
      .split("\n").filter((line) => /ctx\.critical/.test(line)).length === 1,
    "tournament-test.js should set ctx.critical in exactly one place, behind the flag");
}

/** A form name that names a Mega. Written out rather than a regex, which a patch ate once. */
const isMegaForm = (form) => String(form || "").trim().toLowerCase().startsWith("mega ");

// ---------------------------------------------------------------------------
// 10. the board the opponent searches describes the game it was copied from
// ---------------------------------------------------------------------------
{
  const copy = new PlayGame(solver, data, FORMAT, library);
  copy.start({ player: PLAYER, foe: FOE, seed: 41 });
  const t = solver.t;

  // (a) SEAT ORDER after a replacement. `buildState` re-seats rows as [standing, bench]; the live
  // board does not, because `refill` leaves a replacement where it sits in the sides list. When
  // the two disagree the search's answer -- which names a seat -- lands on the wrong Pokemon.
  const foe = copy.state.sides[1];
  foe[0].hp = 0; foe[0].out = true;              // knock the front one out...
  copy.state.active[1][0] = null;
  t.refill(copy.state.active, copy.state.sides, copy.state.board, []);  // ...and let one in
  const standing = copy.state.active[1].filter(Boolean).map((m) => m.u.species);
  // In the opponent's own board side 0 is the opponent: the Solver always scores side 0.
  const rebuilt = solver.buildState(copy.possibleBoards(1)[0]);
  const seated = rebuilt.active[0].filter(Boolean).map((m) => m.u.species);
  ok("after a replacement the searched board seats the same Pokemon, in the same order",
    standing.join(",") === seated.join(","), `real [${standing}] vs searched [${seated}]`);

  // (b) and a switch the search chooses comes back pointing at the right Pokemon.
  const order = copy.seatOrder(1);
  const benchAt = order.findIndex((m, i) => i >= copy.state.active[1].filter(Boolean).length && !m.out);
  if (benchAt >= 0) {
    const [read] = copy.readJoint([{ position: 0, kind: 2, into: benchAt }]);
    ok("a chosen switch names the Pokemon the search meant",
      copy.state.sides[1][read.into] === order[benchAt],
      `into ${benchAt} -> ${read.into}: ${copy.state.sides[1][read.into]?.u?.species} vs ${order[benchAt]?.u?.species}`);
  }

  // (c) PROTECT. A Pokemon that protected last turn must not be offered Protect on the searched
  // board either -- the opponent was protecting every turn while the player could not.
  const guard = new PlayGame(solver, data, FORMAT, library);
  guard.start({ player: PLAYER, foe: FOE, seed: 42 });
  guard.state.active[1][0].guardedLast = true;
  const guardRow = guard.possibleBoards(1)[0].sides[0][0];
  ok("the row says it protected last turn", guardRow.guardedLast === true, JSON.stringify(guardRow.guardedLast));
  const guardBuilt = solver.buildState(guard.possibleBoards(1)[0]);
  ok("and the rebuilt board agrees", guardBuilt.active[0][0].guardedLast === true,
    String(guardBuilt.active[0][0].guardedLast));

  // (d) MEGA EVOLUTION. After one, the searched board must show the Mega -- not the base form
  // holding an unspent stone.
  const zard = named("Charizard") || PLAYER.find((s) => data.engine.isMegaStone(s.item));
  const stoned = (PLAYER.find((s) => data.engine.isMegaStone(s.item)) ? PLAYER : [zard, ...PLAYER.slice(1)]).filter(Boolean);
  const holder = stoned.findIndex((s) => data.engine.isMegaStone(s.item));
  if (holder >= 0) {
    const evo = new PlayGame(solver, data, FORMAT, library);
    evo.start({ player: stoned.slice(0, 4), foe: FOE, seed: 43 });
    const mine = evo.state.sides[0].find((m) => m.mega);
    if (mine) {
      const beforeForm = mine.u.form;
      // Mega Evolve it the way a turn does.
      mine.u = mine.mega; mine.mega = null; evo.state.megaUsed[0] = true;
      ok("it really changed form", mine.u.form !== beforeForm, `${beforeForm} -> ${mine.u.form}`);
      const row = evo.possibleBoards(1)[0].sides[1].find((r) => r.mega);
      ok("the row says it has already Mega Evolved", Boolean(row), "no row carried mega:true");
      if (row) {
        ok("and the set it carries is the BASE one, with the stone",
          !isMegaForm(row.set.form) && data.engine.isMegaStone(row.set.item),
          JSON.stringify({ form: row.set.form, item: row.set.item, ability: row.set.ability }));
        const back = solver.buildState(evo.possibleBoards(1)[0]);
        const asSeen = back.sides[1].find((m) => isMegaForm(m.u.form));
        ok("and the rebuilt board stands it in its Mega form", Boolean(asSeen),
          JSON.stringify(back.sides[1].map((m) => m.u.form)));
        ok("with the Mega's own Ability", !asSeen || asSeen.u.mon.ability === mine.u.mon.ability,
          `${asSeen?.u?.mon?.ability} vs ${mine.u.mon.ability}`);
        ok("and that side's Mega Evolution spent", back.megaUsed[1] === true, String(back.megaUsed[1]));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 11. a hit is priced against the Pokemon actually standing there
// ---------------------------------------------------------------------------
{
  // Two engines over the same board: the published rule (full health, no status) and the live
  // one the played game asks for. The first must not move at all; the second must.
  const make = (opts) => new Solver(new TournamentTest(evaluation, known, new TeamSuggestions(evaluation), { effects, ...opts }));
  const plain = make({});
  const live = make({ liveHpRule: 1 });
  ok("the rule is off by default", plain.t.liveHpRule === 0, String(plain.t.liveHpRule));
  ok("and the played game turns it on", live.t.liveHpRule === 1, String(live.t.liveHpRule));

  const dragon = named("Dragonite");
  const run = (s, hurt, who) => {
    const g = new PlayGame(s, data, FORMAT, library);
    g.start({ player: PLAYER, foe: dragon ? [dragon, ...FOE.slice(1)] : FOE, seed: 61 });
    const me = g.state.sides[0][0];
    const you = g.state.sides[1][0];
    if (who === "defender") you.hp = hurt; else me.hp = hurt;
    const slot = me.u.moves.findIndex((m) => m && m.damaging);
    return slot < 0 ? null : s.t.hitOn(me, you, slot, g.state.board, false).frac;
  };

  // MULTISCALE halves damage at FULL health only. Below it, the same hit must hurt more.
  if (dragon && String(dragon.ability || "").toLowerCase().includes("multiscale")) {
    const full = run(live, 1, "defender");
    const hurt = run(live, 0.3, "defender");
    ok("Multiscale stops halving damage once the defender is hurt", hurt > full,
      `full ${full} vs hurt ${hurt}`);
    const before = run(plain, 1, "defender");
    const after = run(plain, 0.3, "defender");
    ok("and the published rule still prices both the same", before === after,
      `${before} vs ${after}`);
    notes.push(`live HP: Multiscale ${(full * 100).toFixed(1)}% at full -> ${(hurt * 100).toFixed(1)}% at 30%`);
  } else {
    notes.push("live HP: no Multiscale holder on the ladder to test against");
  }

  // THE ATTACKER's health: Blaze, Torrent, Overgrow and Swarm need their user below a third, so
  // none of them had ever activated. A pinch attacker must hit harder than a healthy one.
  const pinch = PLAYER.findIndex((s) => /blaze|torrent|overgrow|swarm/i.test(String(s.ability || "")));
  if (pinch >= 0) {
    const healthy = run(live, 1, "attacker");
    const cornered = run(live, 0.2, "attacker");
    ok("a pinch Ability can activate at last", cornered >= healthy, `${healthy} -> ${cornered}`);
  }

  // And the cache must tell the two apart: asking at one health then another must not hand back
  // the first answer for both.
  const g = new PlayGame(live, data, FORMAT, library);
  g.start({ player: PLAYER, foe: FOE, seed: 62 });
  const me = g.state.sides[0][0];
  const you = g.state.sides[1][0];
  const slot = me.u.moves.findIndex((m) => m && m.damaging);
  if (slot >= 0) {
    you.hp = 1;
    const atFull = live.t.hitOn(me, you, slot, g.state.board, false).frac;
    you.hp = 0.25;
    const atQuarter = live.t.hitOn(me, you, slot, g.state.board, false).frac;
    you.hp = 1;
    const backAtFull = live.t.hitOn(me, you, slot, g.state.board, false).frac;
    ok("the damage cache tells two healths apart", atFull === backAtFull,
      `${atFull} then ${atQuarter} then ${backAtFull}`);
  }
}

// ---------------------------------------------------------------------------
// 12. the game refuses what it cannot do, and remembers what it has spent
// ---------------------------------------------------------------------------
{
  const law = new PlayGame(solver, data, FORMAT, library);
  law.start({ player: PLAYER, foe: FOE, seed: 71 });
  const options = law.options();

  // ONE POKEMON CANNOT BE SWITCHED INTO TWICE. Each seat is offered its own list and neither
  // knows what the other chose, so both could name the same one on the bench -- and the engine
  // then switched it in and straight back out, a wasted turn that looks like the game's fault.
  const switches = options.map((slot) => (slot.actions || []).filter((a) => a.into !== null && a.into !== undefined));
  if (switches[0]?.length && switches[1]?.length) {
    const shared = switches[0].find((a) => switches[1].some((b) => b.into === a.into));
    if (shared) {
      const mate = switches[1].find((b) => b.into === shared.into);
      const joint = law.jointFrom(options, [shared.id, mate.id]);
      const into = joint.filter((a) => a.into !== null && a.into !== undefined).map((a) => a.into);
      ok("two seats cannot switch into the same Pokemon", into.length <= 1,
        `both named ${JSON.stringify(into)}`);
      ok("and the seat that lost out simply waits", joint[1].wait === true || joint[1].into === undefined,
        JSON.stringify(joint[1]));
    }
  }

  // ONE MEGA EVOLUTION A SIDE. Both seats could be armed and the second was silently ignored.
  const megas = options.map((slot) => (slot.actions || []).find((a) => a.mega));
  if (megas[0] && megas[1]) {
    const joint = law.jointFrom(options, [megas[0].id, megas[1].id]);
    ok("only one Mega Evolution a side survives the choice",
      joint.filter((a) => a.mega).length === 1,
      JSON.stringify(joint.map((a) => Boolean(a.mega))));
  }

  // A SPENT FOCUS SASH AND AN EATEN BERRY STAY SPENT on the board the opponent searches. `fresh`
  // reads both off the kit, which is a fact about the SET, so they used to come back every turn.
  const kept = new PlayGame(solver, data, FORMAT, library);
  kept.start({ player: PLAYER, foe: FOE, seed: 72 });
  const one = kept.state.sides[0][0];
  const hadSash = one.sash;
  one.sash = false;
  one.berry = false;
  one.toxTurns = 6;
  const row = kept.possibleBoards(1)[0].sides[1][0];
  ok("the row says the Sash is gone", row.sash === false, String(row.sash));
  ok("and the Berry is eaten", row.berry === false, String(row.berry));
  ok("and how long the poison has been on", row.toxTurns === 6, String(row.toxTurns));
  const rebuilt = solver.buildState(kept.possibleBoards(1)[0]);
  ok("and the rebuilt board does not hand them back",
    rebuilt.sides[1][0].sash === false && rebuilt.sides[1][0].berry === false,
    JSON.stringify({ sash: rebuilt.sides[1][0].sash, berry: rebuilt.sides[1][0].berry, hadSash }));

  // FOCUS ENERGY raises the crit stage for the rest of the battle, and is lost on switching out.
  const focus = new PlayGame(solver, data, FORMAT, library);
  focus.start({ player: PLAYER, foe: FOE, seed: 73 });
  const user = focus.state.sides[0][0];
  const foe = focus.state.sides[1][0];
  const plainMove = solver.t.moveInfo("Dragon Claw");
  const base = (() => {
    let hits = 0;
    let state = 99;
    focus.rng = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
    for (let i = 0; i < 12000; i += 1) if (focus.rollCrit(user, foe, plainMove)) hits += 1;
    return hits / 12000;
  })();
  user.critStage = 2;
  const lifted = (() => {
    let hits = 0;
    let state = 99;
    focus.rng = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
    for (let i = 0; i < 12000; i += 1) if (focus.rollCrit(user, foe, plainMove)) hits += 1;
    return hits / 12000;
  })();
  ok("a raised crit stage really raises the rate", lifted > base + 0.2,
    `${base.toFixed(4)} -> ${lifted.toFixed(4)}`);
  // And the move's OWN ratio must not be confused with it: a crit_stage op that names a target
  // is Focus Energy, not a high-ratio move.
  const targeted = (solver.t.effectsOf("Focus Energy") || []).filter((op) => op.op === "crit_stage");
  if (targeted.length) {
    ok("Focus Energy's own op names a target", Boolean(targeted[0].target), JSON.stringify(targeted[0]));
    user.critStage = 0;
    const asMove = (() => {
      let hits = 0;
      let state = 99;
      focus.rng = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
      const info = solver.t.moveInfo("Focus Energy");
      for (let i = 0; i < 4000; i += 1) if (focus.rollCrit(user, foe, info)) hits += 1;
      return hits / 4000;
    })();
    ok("and is not read as the move's own ratio", asMove < 0.1, String(asMove));
  }
}

// ---------------------------------------------------------------------------
// 13. the same seed and the same choices play out the same way
// ---------------------------------------------------------------------------
{
  // The hit and damage rolls come from `Solver.random`, which `searchClosed` re-seeds every time
  // the opponent thinks -- so a replay used to depend on how long it had been given, which makes
  // the kept log unreplayable and the seed a lie.
  const playOut = (seed, thinkFirst) => {
    const g = new PlayGame(solver, data, FORMAT, library);
    g.start({ player: PLAYER, foe: FOE, seed });
    const marks = [];
    for (let turn = 0; turn < 4 && !g.over(); turn += 1) {
      const options = g.options();
      if (!options.some((slot) => !slot.empty)) break;
      // The opponent "thinking" is what re-seeds the shared stream. One run does it, one does not.
      if (thinkFirst) solver.random = (() => { let s = turn + 7; return () => { s = (s * 48271) % 2147483647; return s / 2147483647; }; })();
      const ours = g.jointFrom(options, options.map((slot) => (slot.empty ? undefined : slot.actions[0]?.id)));
      const theirs = (g.options ? [] : []);
      const record = g.resolve(ours, theirs);
      marks.push((record.damage || []).map((d) => `${d.name}:${d.from}->${d.to}`).join(","));
    }
    return marks.join(" | ");
  };
  const quiet = playOut(81, false);
  const noisy = playOut(81, true);
  ok("the same seed plays out the same way however long the opponent thought",
    quiet === noisy, `
  without thinking: ${quiet}
  after thinking:   ${noisy}`);
  const other = playOut(82, false);
  ok("and a different seed really is a different game", quiet !== other,
    "two seeds produced identical games");
  notes.push(`seed 81: ${quiet.slice(0, 90)}`);
}

// ---------------------------------------------------------------------------
// 14. a closed sheet learns an item and an Ability, by being shown them
// ---------------------------------------------------------------------------
{
  const hidden = new PlayGame(solver, data, FORMAT, library, { sheet: "closed" });
  hidden.start({ player: PLAYER, foe: FOE, seed: 91 });
  const mine = hidden.state.sides[0][0];

  // Nothing is known before anything has happened. The whole point of the closed sheet is that
  // the opponent has to find out; a guess it did not earn is the same defect as showing it the
  // sheet outright.
  ok("nothing is known at the start", !hidden.seen[mine.tag]?.item && !hidden.seen[mine.tag]?.ability,
    JSON.stringify(hidden.seen[mine.tag] || null));
  const blind = hidden.possibleBoards(1)[0].sides[1][0];
  // `|| true` made this one unfailable. What it is really for: before anything has been shown,
  // the record the pool is built from is EMPTY -- a rolled board gets a sampled set precisely
  // because there is nothing pinned yet.
  ok("the pool is given a set to roll from", Boolean(blind && blind.set));
  ok("and nothing has been shown to pin it with",
    hidden.seen.every((r) => !r.item && !r.ability && (r.moves || []).length === 0),
    JSON.stringify(hidden.seen));

  // A Focus Sash that breaks, or a Sitrus Berry that is eaten, shows which item it was.
  //
  // The Pokemon has to be one that actually HOLDS one: `learnFrom` compares the before and
  // after, so clearing a flag that was already false teaches nothing, correctly. This used to
  // take `sides[0][0]` on faith -- and the day the usage file put a White Herb on the top of
  // the ladder instead of a Focus Sash, it failed for a reason that had nothing to do with the
  // code. The usage file is rebuilt daily (data/builder/meta-doubles.json), so anything pinned
  // to what the metagame happens to be holding is pinned to the weather.
  const spender = hidden.state.sides[0].find((m) => m.sash) || hidden.state.sides[0].find((m) => m.berry);
  const before = new Map(hidden.state.sides[0].map((m) => [m.tag, { sash: m.sash, berry: m.berry, mega: Boolean(m.mega) }]));
  if (spender) {
    if (spender.sash) spender.sash = false; else spender.berry = false;
    hidden.learnFrom([], before, 0, hidden.seen);
    ok("an item that was spent is learned", hidden.seen[spender.tag]?.item === spender.u.item,
      JSON.stringify({ learned: hidden.seen[spender.tag]?.item, real: spender.u.item }));
  } else {
    notes.push("no Focus Sash or Sitrus on the ladder team today; the spent-item check had nothing to spend");
  }

  // An Ability that DID something -- the weather, the terrain, an Intimidate -- is learned; one
  // that merely exists is not.
  const quiet = new PlayGame(solver, data, FORMAT, library, { sheet: "closed" });
  quiet.start({ player: PLAYER, foe: FOE, seed: 92 });
  const actor = quiet.state.sides[0][0];
  quiet.learnFrom([{ kind: "intimidate", actor: actor.u }], new Map(), 0, quiet.seen);
  ok("an Ability that did something is learned",
    quiet.seen[actor.tag]?.ability === (actor.u.mon?.ability || ""),
    JSON.stringify({ learned: quiet.seen[actor.tag]?.ability, real: actor.u.mon?.ability }));

  const mute = new PlayGame(solver, data, FORMAT, library, { sheet: "closed" });
  mute.start({ player: PLAYER, foe: FOE, seed: 93 });
  const still = mute.state.sides[0][0];
  // A hit is not an Ability showing itself.
  mute.learnFrom([{ kind: "hit", actor: still.u }], new Map(), 0, mute.seen);
  ok("an Ability that merely exists is NOT learned", !mute.seen[still.tag]?.ability,
    JSON.stringify(mute.seen[still.tag] || null));

  // BOTH ARGUMENTS HAVE TO MATTER. Every call above passes side 0 and `seen`, so a `learnFrom`
  // that ignored them and wrote to `this.seen` for side 0 regardless would satisfy all of them.
  // The mirror -- side 1, into `shown` -- is what the player's "look at this Pokemon" dialog
  // reads, and it is only correct if the side and the table are both honoured.
  const theirs = new PlayGame(solver, data, FORMAT, library, { sheet: "closed" });
  theirs.start({ player: PLAYER, foe: FOE, seed: 96 });
  const foeMon = theirs.state.sides[1][0];
  theirs.learnFrom([{ kind: "intimidate", actor: foeMon.u }], new Map(), 1, theirs.shown);
  ok("an Ability the OPPONENT shows is filed under what we have seen of them",
    theirs.shown[foeMon.tag]?.ability === (foeMon.u.mon?.ability || ""),
    JSON.stringify({ learned: theirs.shown[foeMon.tag]?.ability, real: foeMon.u.mon?.ability }));
  ok("and not under what they have seen of us",
    theirs.seen.every((r) => !r.ability), JSON.stringify(theirs.seen));
  // And the side really is read: the same event filed as side 0 must find nobody, because that
  // unit stands on side 1.
  const crossed = new PlayGame(solver, data, FORMAT, library, { sheet: "closed" });
  crossed.start({ player: PLAYER, foe: FOE, seed: 97 });
  crossed.learnFrom([{ kind: "intimidate", actor: crossed.state.sides[1][0].u }], new Map(), 0, crossed.seen);
  ok("an event attributed to the wrong side learns nothing",
    crossed.seen.every((r) => !r.ability), JSON.stringify(crossed.seen));

  // And what is learned reaches the pool, where `HiddenSets.honours` pins it.
  const told = new PlayGame(solver, data, FORMAT, library, { sheet: "closed" });
  told.start({ player: PLAYER, foe: FOE, seed: 94 });
  const shown = told.state.sides[0][0];
  told.seen[shown.tag] = { moves: [], item: shown.u.item || "Leftovers", ability: shown.u.mon?.ability || "Levitate" };
  const row = told.possibleBoards(1)[0].sides[1].find((r) => r);
  ok("the pool is told what was shown", Boolean(row), "no row came back");
  const boards = told.possibleBoards(6);
  const pinned = boards.every((board) => {
    const seat = board.sides[1][0];
    return compact(seat.set.item || "") === compact(told.seen[shown.tag].item);
  });
  ok("and every rolled board honours the item it was shown", pinned,
    JSON.stringify(boards.slice(0, 3).map((b) => b.sides[1][0].set.item)));
}

// ---------------------------------------------------------------------------
// 15. the opponent is told how long the field conditions have left
// ---------------------------------------------------------------------------
{
  // `buildState` takes a NUMBER of turns for Trick Room and each side's Tailwind. Handing it
  // booleans gave a Trick Room with one turn left its full four, so the opponent searched lines
  // that outlast a Trick Room about to end.
  const field = new PlayGame(solver, data, FORMAT, library);
  field.start({ player: PLAYER, foe: FOE, seed: 95 });
  field.state.board.tr = 1;
  field.state.board.tw = [2, 0];
  const seen = field.fieldOf();
  ok("one turn of Trick Room is reported as one", seen.trickRoomTurns === 1, String(seen.trickRoomTurns));
  ok("and it is still reported as being up", seen.trickRoom === true, String(seen.trickRoom));
  ok("a two-turn Tailwind is reported as two", seen.tailwind[0] === 2, JSON.stringify(seen.tailwind));
  ok("and a side with none as none", seen.tailwind[1] === 0, JSON.stringify(seen.tailwind));
  // And it survives the rebuild, which is the only thing that matters.
  const built = solver.buildState(field.possibleBoards(1)[0]);
  ok("the rebuilt board keeps the one turn", built.board.tr === 1, String(built.board.tr));
  ok("and the two", built.board.tw[0] === 2, JSON.stringify(built.board.tw));
  field.state.board.tr = 0;
  ok("and no Trick Room stays no Trick Room",
    solver.buildState(field.possibleBoards(1)[0]).board.tr === 0);
}

// ---------------------------------------------------------------------------
// 2. the player sees every move they have
// ---------------------------------------------------------------------------
{
  const options = game.options();
  ok("one option list per slot", options.length === 2, String(options.length));
  ok("both slots can act", options.every((slot) => !slot.empty && slot.actions.length > 0));
  // Garchomp's own four moves must all be offered somewhere in its list, however bad the search
  // thinks they are.
  const mine = options[0];
  const offered = new Set(mine.actions.map((a) => compact(a.move)));
  const real = PLAYER[0].moves.filter(Boolean);
  const missing = real.filter((move) => !offered.has(compact(move)));
  ok("every move the Pokemon really has is offered", missing.length === 0, missing.join(", "));
  ok("switches are offered too", mine.actions.some((a) => a.into !== null && a.into !== undefined));
  ok("an action that names a target names which one",
    mine.actions.filter((a) => a.target >= 0).every((a) => a.targetName));
  notes.push(`options: ${mine.name} has ${mine.actions.length} actions, ${offered.size} distinct moves`);
}

// ---------------------------------------------------------------------------
// 3. a turn resolves
// ---------------------------------------------------------------------------
{
  const options = game.options();
  const chosen = options.map((slot) => slot.actions.find((a) => a.target >= 0)?.id || slot.actions[0]?.id);
  const ourJoint = game.jointFrom(options, chosen);
  const theirJoint = game.jointFrom(options, chosen).map((a) => ({ ...a }));
  // Their side plays its own slot-0 action rather than a search, so this test stays fast.
  const theirOptions = [0, 1].map((position) => solver.slotCandidates(game.state, 1, position, { cap: 0 }));
  const foeJoint = theirOptions.map((list, position) => {
    const pick = list.find((a) => !a.wait) || { kind: 0, wait: true };
    return { ...pick, position };
  });
  const before = game.view();
  const record = game.resolve(ourJoint, foeJoint);
  const after = game.view();
  ok("the turn number moves", after.turn === before.turn + 1);
  ok("the turn is written down", Boolean(record) && record.turn === after.turn);
  ok("something happened", record.plays.length > 0, JSON.stringify(record.plays));
  // Not on turn 1 necessarily -- both sides may Protect -- but a game in which nothing ever
  // happens is not a game. Play on until something lands.
  let moved = after.sides.flat().some((m, i) => m.hp !== before.sides.flat()[i].hp);
  for (let more = 0; more < 6 && !moved && !game.over(); more += 1) {
    const next = game.options();
    const pick = next.map((slot) => slot.actions.find((a) => a.target >= 0)?.id || slot.actions[0]?.id);
    const was = game.view();
    const foe = [0, 1].map((position) => {
      const list = solver.slotCandidates(game.state, 1, position, { cap: 0 });
      const choice = list.find((a) => a.target >= 0) || list.find((a) => !a.wait) || { kind: 0, wait: true };
      return { ...choice, position };
    });
    game.resolve(game.jointFrom(next, pick), foe);
    const now = game.view();
    moved = now.sides.flat().some((m, i) => m.hp !== was.sides.flat()[i].hp);
  }
  ok("HP moves once an attack lands", moved);
  notes.push(`turn 1: ${record.plays.map((p) => p.text).join(" | ")}`);
}

// ---------------------------------------------------------------------------
// 4. the opponent only learns what it is shown
// ---------------------------------------------------------------------------
{
  const fresh = new PlayGame(solver, data, FORMAT, library);
  fresh.start({ player: PLAYER, foe: FOE, seed: 12 });
  ok("it starts knowing nothing about the player's moves",
    fresh.seen.every((row) => row.moves.length === 0));

  const options = fresh.options();
  const attack = options[0].actions.find((a) => a.target >= 0);
  const chosen = [attack.id, options[1].actions[0].id];
  const ourJoint = fresh.jointFrom(options, chosen);
  const foeJoint = [0, 1].map((position) => {
    const list = solver.slotCandidates(fresh.state, 1, position, { cap: 0 });
    const pick = list.find((a) => !a.wait) || { kind: 0, wait: true };
    return { ...pick, position };
  });
  fresh.resolve(ourJoint, foeJoint);
  const learned = fresh.seen.flatMap((row) => row.moves);
  ok("a move the player used is now known to it", learned.some((move) => compact(move) === compact(attack.move)),
    `${JSON.stringify(learned)} should contain ${attack.move}`);
  ok("and nothing else is", learned.length <= 2, JSON.stringify(learned));

  // Which means every possible board it searches has that move on that Pokemon.
  const boards = fresh.possibleBoards(8);
  const tag = fresh.state.active[0][0].tag;
  const hasIt = boards.every((b) => (b.sides[1][tag]?.set.moves || []).some((move) => compact(move) === compact(attack.move)));
  ok("every possible version of the player's team now carries it", hasIt,
    JSON.stringify(boards.map((b) => b.sides[1][tag]?.set.moves)));
  notes.push(`learning: after one turn the opponent knows ${JSON.stringify(learned)}`);
}

// ---------------------------------------------------------------------------
// 5. a whole game finishes
// ---------------------------------------------------------------------------
{
  const run = new PlayGame(solver, data, FORMAT, library);
  run.start({ player: PLAYER, foe: FOE, seed: 13 });
  let turns = 0;
  while (!run.over() && turns < TURN_LIMIT + 2) {
    const options = run.options();
    // Both sides play their best-valued legal action, which is enough to end a game.
    const chosen = options.map((slot) => slot.actions[0]?.id);
    const ourJoint = run.jointFrom(options, chosen);
    const foeJoint = [0, 1].map((position) => {
      const list = solver.slotCandidates(run.state, 1, position, { cap: 0 });
      const pick = list.find((a) => !a.wait) || { kind: 0, wait: true };
      return { ...pick, position };
    });
    run.resolve(ourJoint, foeJoint);
    turns += 1;
  }
  const over = run.over();
  ok("a game played out ends", Boolean(over), `${turns} turns and still going`);
  ok("and it ends inside the turn limit", turns <= TURN_LIMIT, String(turns));
  ok("with a winner or an honest draw", over && [0, 1, "draw"].includes(over.winner), JSON.stringify(over));
  ok("the log has a line for every turn", run.log.length === turns + 1, `${run.log.length} vs ${turns + 1}`);
  notes.push(`game: ${turns} turns, ${over ? `winner ${over.winner} (${over.why})` : "unfinished"}`);
}

// ---------------------------------------------------------------------------
// 5b. the pool the opponent searches lines up with the real board
// ---------------------------------------------------------------------------
{
  // The opponent's chosen actions come back as INDICES -- which seat acted, which bench slot a
  // switch takes -- and they are applied to the real board. They only mean the same thing on
  // both boards while the two lists are in the same order, and `buildState` reorders its rows to
  // put whoever is standing first. `applySwitches` keeps the real list in that order too, so the
  // two coincide; if it ever stopped doing that, the opponent would switch to the wrong Pokemon
  // and nothing would look wrong about the turn.
  const lined = new PlayGame(solver, data, FORMAT, library);
  lined.start({ player: PLAYER, foe: FOE, seed: 31 });
  const check = (when) => {
    const boards = lined.possibleBoards(4);
    for (const board of boards) {
      // Side 0 of a possible board is the OPPONENT, which is side 1 of the real one.
      const theirs = board.sides[0].map((row) => row.set.species);
      const real = lined.state.sides[1].map((m) => m.u.species);
      ok(`${when}: the opponent's rows are in the board's own order`,
        JSON.stringify(theirs) === JSON.stringify(real), `${JSON.stringify(theirs)} vs ${JSON.stringify(real)}`);
      checked -= 1;
      const mine = board.sides[1].map((row) => row.set.species);
      const realMine = lined.state.sides[0].map((m) => m.u.species);
      ok(`${when}: and so are ours`, JSON.stringify(mine) === JSON.stringify(realMine),
        `${JSON.stringify(mine)} vs ${JSON.stringify(realMine)}`);
      checked -= 1;
    }
    checked += 2;
  };
  check("at the start");

  // Now make both sides switch, which is what moves rows around in the first place.
  const options = lined.options();
  const swap = options[0].actions.find((a) => a.into !== null && a.into !== undefined);
  if (swap) {
    const ourJoint = lined.jointFrom(options, [swap.id, options[1].actions[0]?.id]);
    const foeJoint = [0, 1].map((position) => {
      const list = solver.slotCandidates(lined.state, 1, position, { cap: 0 });
      const pick = list.find((a) => a.into !== null && a.into !== undefined) || list.find((a) => !a.wait) || { kind: 0, wait: true };
      return { ...pick, position };
    });
    lined.resolve(ourJoint, foeJoint);
    check("after both sides switch");
  }
}

// ---------------------------------------------------------------------------
// 5c. a mirror match says which side a target is on
// ---------------------------------------------------------------------------
{
  // Both sides bringing the same Pokemon is normal, and the log then read "Rillaboom: Wood
  // Hammer -> Rillaboom", which is a Pokemon hitting itself as far as anybody reading it knows.
  const mirror = new PlayGame(solver, data, FORMAT, library);
  mirror.start({ player: PLAYER, foe: PLAYER, seed: 41 });
  const options = mirror.options();
  const attack = options[0].actions.find((a) => a.target >= 0);
  const ourJoint = mirror.jointFrom(options, [attack.id, options[1].actions[0]?.id]);
  const foeJoint = [0, 1].map((position) => {
    const list = solver.slotCandidates(mirror.state, 1, position, { cap: 0 });
    const pick = list.find((a) => a.target >= 0) || list.find((a) => !a.wait) || { kind: 0, wait: true };
    return { ...pick, position };
  });
  const record = mirror.resolve(ourJoint, foeJoint);
  const aimed = record.plays.filter((play) => play.text.includes("→"));
  ok("a mirror match still prints the turn", aimed.length > 0, JSON.stringify(record.plays));
  // And a switch is said in words rather than with the same arrow an attack uses: in a list of
  // things that happened, "Sneasler -> Rillaboom" reads as Sneasler hitting Rillaboom.
  {
    const withSwitch = new PlayGame(solver, data, FORMAT, library);
    withSwitch.start({ player: PLAYER, foe: FOE, seed: 43 });
    const opts = withSwitch.options();
    const out = opts[0].actions.find((a) => a.into !== null && a.into !== undefined);
    if (out) {
      const joint = withSwitch.jointFrom(opts, [out.id, opts[1].actions[0]?.id]);
      const foe = [0, 1].map((position) => {
        const list = solver.slotCandidates(withSwitch.state, 1, position, { cap: 0 });
        const pick = list.find((a) => !a.wait) || { kind: 0, wait: true };
        return { ...pick, position };
      });
      const rec = withSwitch.resolve(joint, foe);
      const line = rec.plays.find((play) => /switched out for/.test(play.text));
      ok("a switch is written as a switch", Boolean(line), JSON.stringify(rec.plays.map((p) => p.text)));
      ok("and it names who came in", line && new RegExp("switched out for .+$").test(line.text), line?.text);
      ok("with no arrow left in it to read as an attack", line && !line.text.includes("→"), line?.text);
    }
  }
  ok("and every target across the field is named as the opposing one",
    aimed.every((play) => /the opposing /.test(play.text)), JSON.stringify(aimed.map((p) => p.text)));

  // ...and it is NOT said when there is nothing to tell apart.
  const plain = new PlayGame(solver, data, FORMAT, library);
  plain.start({ player: PLAYER, foe: FOE, seed: 42 });
  const theirs = plain.options();
  const hit = theirs[0].actions.find((a) => a.target >= 0);
  const joint = plain.jointFrom(theirs, [hit.id, theirs[1].actions[0]?.id]);
  const other = [0, 1].map((position) => {
    const list = solver.slotCandidates(plain.state, 1, position, { cap: 0 });
    const pick = list.find((a) => a.target >= 0) || list.find((a) => !a.wait) || { kind: 0, wait: true };
    return { ...pick, position };
  });
  const before = plain.view();
  const flat = plain.resolve(joint, other);
  // Not "never said on two different teams" -- two different teams often share a Pokemon, and
  // when they do it has to be said. The rule is that it is said for exactly the names that are
  // on both sides and for no others.
  const onBoth = new Set(before.sides[0].map((m) => m.name)
    .filter((name) => before.sides[1].some((m) => m.name === name)));
  const wrong = flat.plays.filter((play) => {
    const named = new RegExp("\u2192 (?:the opposing )?(.+)$").exec(play.text);
    if (!named) return false;
    return /the opposing /.test(play.text) !== onBoth.has(named[1]);
  });
  ok("the extra words are used for exactly the names that are on both sides, and no others",
    wrong.length === 0, `${JSON.stringify(wrong.map((p) => p.text))}; shared: ${JSON.stringify([...onBoth])}`);
  notes.push(`mirror: ${aimed[0]?.text} | plain: ${flat.plays.find((p) => p.text.includes("→"))?.text}`);
}

/** The same set with a different four moves, for a sheet the search has no bid for. */
const withMoves = (set, moves) => makeSet({ ...set, moves: [...moves] });
const compactName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ---------------------------------------------------------------------------
// 6. a CLOSED sheet does not carry the opponent's sheet; an OPEN one carries both
// ---------------------------------------------------------------------------
{
  // A CLOSED sheet. This block used to be run on the DEFAULT game, which is an OPEN sheet, so
  // it pinned the hiding as though it were unconditional -- and that is what made the open
  // sheet one-directional: the Solver was handed the player's real sets while the player was
  // shown "not shown yet" for every one of the Solver's.
  const peek = new PlayGame(solver, data, FORMAT, library, { sheet: "closed" });
  const view = peek.start({ player: PLAYER, foe: FOE, seed: 14 });
  ok("our own sets are on our own side", view.sides[0].every((m) => m.moves.length > 0),
    JSON.stringify(view.sides[0].map((m) => [m.name, m.moves.length])));
  ok("and on a closed sheet theirs are not on theirs", view.sides[1].every((m) => m.moves.length === 0),
    JSON.stringify(view.sides[1].map((m) => m.moves)));
  ok("their items are not either", view.sides[1].every((m) => !m.item));
  ok("what IS shown is what a player can see", view.sides[1].every((m) =>
    typeof m.species === "string" && typeof m.hp === "number"));

  // ...but what the game HAS shown is on the view, separately, so a player can look a Pokemon up
  // and see exactly the moves it has used. The mirror of what the opponent learns about us.
  ok("their tile carries a revealed record, and it starts empty",
    view.sides[1].every((m) => m.revealed && m.revealed.moves.length === 0 && !m.revealed.item),
    JSON.stringify(view.sides[1].map((m) => m.revealed)));
  ok("ours carries none, because ours is all known",
    view.sides[0].every((m) => m.revealed === null));

  // An OPEN sheet is open in BOTH directions. The Solver is given the player's real sets
  // (`possibleBoards` returns the one true board, checked in 1b); this is the other half.
  const shown = new PlayGame(solver, data, FORMAT, library, { sheet: "open" });
  const open = shown.start({ player: PLAYER, foe: FOE, seed: 14 });
  ok("on an open sheet their moves are on their side too",
    open.sides[1].every((m) => m.moves.length > 0),
    JSON.stringify(open.sides[1].map((m) => [m.name, m.moves.length])));
  ok("their items as well", open.sides[1].every((m) => typeof m.item === "string"));
  ok("their Ability as well", open.sides[1].every((m) => m.ability));
  // The rest of the sheet, which no amount of watching ever reveals.
  ok("and the Nature and Stat Points, on both sides",
    open.sides[0].every((m) => m.nature) && open.sides[1].every((m) => m.nature),
    JSON.stringify(open.sides[1].map((m) => [m.name, m.nature, m.spread])));
  ok("a Sp. Def stage is carried, which the view never used to pass on",
    open.sides[0].every((m) => typeof m.spd === "number"));
  ok("nothing is left to reveal, because nothing is hidden",
    open.sides[1].every((m) => m.revealed === null));
  // A closed sheet must NOT have gained any of it.
  ok("a closed sheet still says nothing about their Nature",
    view.sides[1].every((m) => !m.nature && !m.spread),
    JSON.stringify(view.sides[1].map((m) => [m.name, m.nature, m.spread])));
}

// ---------------------------------------------------------------------------
// 6b. a move is learnt by being used, in BOTH directions
// ---------------------------------------------------------------------------
{
  const mirror = new PlayGame(solver, data, FORMAT, library);
  mirror.start({ player: PLAYER, foe: FOE, seed: 31 });
  const usedByThem = new Set();
  for (let turn = 0; turn < 6 && !mirror.over(); turn += 1) {
    const options = mirror.options();
    if (!options.some((slot) => !slot.empty)) break;
    const ours = mirror.jointFrom(options, options.map((slot) => (slot.empty ? undefined : slot.actions[0]?.id)));
    // THEIR joint comes from the opponent, not from `jointFrom`: `options` and `jointFrom` are
    // the PLAYER's, they take no side, and feeding side 0's options in as side 1's choices
    // resolves a turn in which the opponent's Pokemon use whatever move happens to sit in the
    // same slot. `chooseFoe` is the only thing that speaks for side 1.
    const { joint: theirs } = await mirror.chooseFoe({ thinkMs: 120, lookahead: 1, pool: 1 });
    // A SWITCH is not a move, and its `move` field carries the arriving Pokemon's NAME -- so
    // counting it put "Grimmsnarl" in the list of moves they had used.
    for (const action of theirs) {
      if (!action?.move || action.wait || action.kind === -1 || action.into !== null) continue;
      usedByThem.add(compactName(action.move));
    }
    mirror.resolve(ours, theirs);
  }
  const learnt = new Set(mirror.shown.flatMap((r) => (r?.moves || []).map(compactName)));
  ok("every move they used is now on our record of them",
    [...usedByThem].every((move) => learnt.has(move)),
    `used ${JSON.stringify([...usedByThem])} learnt ${JSON.stringify([...learnt])}`);
  ok("and nothing they did NOT use is", [...learnt].every((move) => usedByThem.has(move)),
    JSON.stringify([...learnt].filter((move) => !usedByThem.has(move))));
  ok("our own record of us is kept at the same time", mirror.seen.some((r) => r.moves.length > 0));
  notes.push(`mirror: we learnt ${learnt.size} of their moves`);
}

// ---------------------------------------------------------------------------
// 6c. every move on the sheet can be chosen, and a status move really lands
// ---------------------------------------------------------------------------
{
  // Four moves the SEARCH has no bid for: a paralysis, a poison, a self-boost and a heal. Before
  // the EFFECT action kind each produced no action at all, so the slot offered three moves and
  // the fourth could not be picked. See ACTION_KINDS.EFFECT in tournament-test.js.
  const sheet = ["Thunder Wave", "Toxic", "Nasty Plot", "Recover"];
  const caster = withMoves(PLAYER[0], sheet);
  const player = [caster, PLAYER[1], PLAYER[2], PLAYER[3]];
  const game = new PlayGame(solver, data, FORMAT, library);
  game.start({ player, foe: FOE, seed: 21 });
  const slot = game.options()[0];
  const offered = new Set((slot.actions || []).map((a) => compactName(a.move || "")));
  const missing = sheet.filter((move) => !offered.has(compactName(move)));
  ok("every move the search cannot price is still offered", missing.length === 0,
    `missing ${JSON.stringify(missing)} of ${JSON.stringify([...offered])}`);
  ok("and each carries the registry ops that make it work",
    sheet.every((move) => {
      const action = (slot.actions || []).find((a) => compactName(a.move || "") === compactName(move));
      return action && Array.isArray(action.ops) && action.ops.length > 0;
    }));

  // Chosen, it LANDS -- and it is said before the damage it causes.
  let pinned = 0;
  let saidBeforeChip = 0;
  for (let seed = 1; seed <= 12; seed += 1) {
    const one = new PlayGame(solver, data, FORMAT, library);
    one.start({ player: [withMoves(PLAYER[0], ["Thunder Wave", "Protect", ...sheet.slice(2)]), PLAYER[1], PLAYER[2], PLAYER[3]], foe: FOE, seed: seed * 29 });
    const options = one.options();
    const wave = (options[0].actions || []).find((a) => compactName(a.move || "") === "thunderwave");
    if (!wave) continue;
    const ours = one.jointFrom(options, [wave.id, options[1]?.actions?.[0]?.id]);
    const { joint } = await one.chooseFoe({ thinkMs: 100, lookahead: 1, pool: 1 });
    const rec = one.resolve(ours, joint);
    const steps = rec.stream || [];
    const at = steps.findIndex((s) => s.kind === "status");
    if (at < 0) continue;
    pinned += 1;
    // THE CONDITION COMES AFTER THE MOVE THAT CAUSED IT. This is the whole point of the
    // pending/release hold in `streamFrom`, and it has to be checked against something the
    // hold actually moves. It was checked against a residual carrying `cause: "par"`, and no
    // residual can ever carry that -- paralysis takes no HP -- so the index was always -1 and
    // the assertion could not fail: deleting the entire hold left the suite green.
    //
    // Our caster's own "X used Y" is the step the hold waits for, so its index is the test.
    const caster = steps.findIndex((s) => s.kind === "move" && s.side === 0 && s.tag === options[0].tag);
    const casterSaid = steps.findIndex((s) => s.kind === "note" && s.side === 0
      && /thunder wave/i.test(s.text || ""));
    const after = Math.max(caster, casterSaid);
    if (after >= 0 && at > after) saidBeforeChip += 1;
    notes.push(`effect order: ${steps.slice(0, Math.min(at + 2, steps.length)).map((s) => s.kind).join(" ")}`);
    const hit = one.view().sides[1].find((m) => m.status === "Paralysed");
    ok(`a landed paralysis is on the tile (seed ${seed * 29})`, Boolean(hit),
      JSON.stringify(one.view().sides[1].map((m) => [m.name, m.status])));
    break;
  }
  ok("a 90%-accurate paralysis lands when it is chosen", pinned > 0);
  ok("and it is announced after the move that caused it", pinned > 0 && saidBeforeChip === pinned,
    `${saidBeforeChip} of ${pinned}`);
  notes.push(`effect moves: all ${sheet.length} offered, paralysis pinned`);
}

// ---------------------------------------------------------------------------
// 7. the turn as an ordered stream
// ---------------------------------------------------------------------------

/** Both sides' chosen actions as a joint, with one side's choice made by a picker. */
const foeJointBy = (state, pick) => [0, 1].map((position) => {
  const list = solver.slotCandidates(state, 1, position, { cap: 0 });
  const choice = pick(list, position) || list.find((a) => !a.wait) || { kind: 0, wait: true };
  return { ...choice, position };
});

/** A plain attack: one target, no priority, no stone, so Speed alone decides when it goes. */
const plainAttack = (state, s, position) => {
  const m = state.active[s][position];
  if (!m) return null;
  return solver.slotCandidates(state, s, position, { cap: 0 }).find((a) => a.kind === ACTION_KINDS.ATTACK
    && a.target >= 0 && !a.spread && !a.mega && (m.u.moves[a.slot]?.priority || 0) === 0) || null;
};

const stepsFor = (stream, kinds, side, tag) => stream.filter((step) => kinds.includes(step.kind)
  && step.side === side && step.tag === tag);
/** Every step that says where a Pokemon's HP went. */
const hpSteps = (stream, side, tag) => stepsFor(stream, ["hit", "residual"], side, tag);
const tagOf = (record, side, name) => {
  const rows = (record.hp[side] || []).filter((row) => row.name === name);
  return rows.length === 1 ? rows[0].tag : null;
};

{
  const open = new PlayGame(solver, data, FORMAT, library);
  const view = open.start({ player: PLAYER, foe: FOE, seed: 71 });
  const stream = open.log[0].stream;
  ok("the opening is a stream too", Array.isArray(stream) && stream.length > 0);
  const sends = stream.filter((step) => step.kind === "send");
  ok("with one send step per Pokemon that came out", sends.length === 4, JSON.stringify(sends));
  ok("and every one of them is a Pokemon that is standing", sends.every((step) =>
    view.standing[step.side].includes(step.tag)), JSON.stringify(view.standing));
  ok("and nothing is sent out twice", new Set(sends.map((s) => `${s.side}:${s.tag}`)).size === 4);
  ok("every step is a plain object the worker can post", stream.every((step) =>
    Object.values(step).every((value) => value === null || ["string", "number", "boolean"].includes(typeof value))),
    JSON.stringify(stream));
}

// 7a. ORDER: both sides attack, and the slower one moves second.
{
  const race = new PlayGame(solver, data, FORMAT, library);
  race.start({ player: PLAYER, foe: FOE, seed: 72 });
  const options = race.options();
  const ours = [0, 1].map((position) => plainAttack(race.state, 0, position));
  const theirs = [0, 1].map((position) => plainAttack(race.state, 1, position));
  ok("four plain attacks to race", ours.every(Boolean) && theirs.every(Boolean));
  // The Speed the turn machinery will order them by, read off the same board, before anything
  // moves. Nothing in this turn switches, Mega-Evolves or sets Trick Room, so this IS the order.
  const speeds = new Map();
  for (let s = 0; s < 2; s += 1) {
    for (let position = 0; position < 2; position += 1) {
      const m = race.state.active[s][position];
      speeds.set(`${s}:${m.tag}`, solver.t.speed(m, race.state.board));
    }
  }
  const ourJoint = race.jointFrom(options, ours.map((a, position) => options[position].actions
    .find((o) => o.kind === a.kind && o.slot === a.slot && o.target === a.target)?.id));
  const foeJoint = theirs.map((a, position) => ({ ...a, position }));
  const record = race.resolve(ourJoint, foeJoint);
  const stream = record.stream;
  const moves = stream.filter((step) => step.kind === "move");
  const place = new Map(moves.map((step, i) => [`${step.side}:${step.tag}`, i]));
  // Four plain attacks were chosen, but a Pokemon that is knocked out before its turn comes does
  // not get one -- which is correct, and happens on this board now that the compiled effects are
  // loaded. So each of the four must either have moved or have fainted first.
  const fainted = new Set(stream.filter((s) => s.kind === "faint").map((s) => `${s.side}:${s.tag}`));
  const silent = [...speeds.keys()].filter((key) => !place.has(key) && !fainted.has(key));
  ok("each of the four either moved or was knocked out before it could", silent.length === 0,
    `${silent.join(", ")} did neither; stream: ${JSON.stringify(stream.map((s) => s.kind))}`);
  ok("at least two of them moved, or this proves nothing about order", moves.length >= 2,
    JSON.stringify(moves));
  const wrong = [];
  for (const [fast, fastSpeed] of speeds) {
    for (const [slow, slowSpeed] of speeds) {
      if (fastSpeed <= slowSpeed) continue;
      // Only pairs where BOTH moved: `undefined > 2` is false, so comparing a Pokemon that never
      // acted would pass this silently whatever the order was.
      if (!place.has(fast) || !place.has(slow)) continue;
      if (place.get(fast) > place.get(slow)) wrong.push(`${fast} (${Math.round(fastSpeed)}) after ${slow} (${Math.round(slowSpeed)})`);
    }
  }
  ok("and the faster Pokemon's move is in the stream before the slower one's", wrong.length === 0, wrong.join("; "));
  // ...and what a move did is attached to it, not collected at the end of the turn.
  const strays = moves.filter((step, i) => {
    const next = stream[stream.indexOf(step) + 1];
    return !next || !["hit", "miss", "protect", "note", "faint"].includes(next.kind);
  });
  ok("and what each move did follows it immediately", strays.length === 0,
    JSON.stringify(stream.map((s) => s.kind)));
  notes.push(`order: ${moves.map((s) => `${s.side}:${s.tag}@${Math.round(speeds.get(`${s.side}:${s.tag}`))}`).join(" > ")}`);

  // 7b. a hit's from and to are the HP the view really reports.
  const after = race.view();
  const off = [];
  for (let s = 0; s < 2; s += 1) {
    for (const mon of after.sides[s]) {
      const steps = hpSteps(stream, s, mon.tag);
      if (!steps.length) continue;
      if (steps[steps.length - 1].to !== mon.hp) off.push(`${mon.name}: stream ${steps[steps.length - 1].to} vs view ${mon.hp}`);
    }
  }
  ok("the last thing the stream says about a Pokemon's HP is what the view reports", off.length === 0, off.join("; "));
}

// 7c. ATTRIBUTION: a Pokemon that switched out is not the one that took the hit.
{
  const away = new PlayGame(solver, data, FORMAT, library);
  away.start({ player: PLAYER, foe: FOE, seed: 73 });
  const options = away.options();
  const attack = options[0].actions.find((a) => a.target === 0 && !a.spread);
  const ourJoint = away.jointFrom(options, [attack?.id, options[1].actions[0]?.id]);
  // Their front Pokemon leaves, which happens BEFORE the move resolves -- so the attack lands on
  // whoever came in, and the stream has to say so.
  const foeJoint = foeJointBy(away.state, (list, position) => (position === 0
    ? list.find((a) => a.into !== null && a.into !== undefined) : list.find((a) => !a.wait)));
  const record = away.resolve(ourJoint, foeJoint);
  const stream = record.stream;
  const swap = stream.find((step) => step.kind === "switch" && step.side === 1);
  ok("a switch is a step of its own", Boolean(swap), JSON.stringify(stream.map((s) => s.kind)));
  if (swap) {
    ok("the switch step names who left and who came in",
      swap.outTag !== swap.inTag && typeof swap.outTag === "number" && typeof swap.inTag === "number",
      JSON.stringify(swap));
    ok("nothing in the stream says the Pokemon that left took a hit",
      stepsFor(stream, ["hit", "miss"], 1, swap.outTag).length === 0,
      JSON.stringify(stepsFor(stream, ["hit", "miss"], 1, swap.outTag)));
    // And it is the one that came in that took it, not merely "not the one that left".
    const landed = stepsFor(stream, ["hit"], 1, swap.inTag);
    ok("the Pokemon that came in is the one that took it", landed.length > 0,
      JSON.stringify(stream.filter((s) => s.kind === "hit")));
    ok("and the bucket agrees about how much it took", landed.length === 0
      || record.damage.concat(record.fainted).some((row) => tagOf(record, 1, row.name) === swap.inTag),
      JSON.stringify(record.damage));
    // ...unless the hit it took knocked it out, which is a legitimate outcome of the very hit
    // the assertions above require it to have taken.
    const inView = away.view().sides[1].find((m) => m.tag === swap.inTag);
    ok("the Pokemon that came in is on the field afterwards, or it fainted taking the hit",
      away.view().standing[1].includes(swap.inTag) || Boolean(inView?.out),
      JSON.stringify({ standing: away.view().standing[1], inTag: swap.inTag, out: inView?.out, hp: inView?.hp }));
  }
}

// 7d. a protected Pokemon gets a protect step and no hit step.
{
  const wall = new PlayGame(solver, data, FORMAT, library);
  wall.start({ player: PLAYER, foe: FOE, seed: 74 });
  const options = wall.options();
  const attack = options[0].actions.find((a) => a.target === 0 && !a.spread);
  const ourJoint = wall.jointFrom(options, [attack?.id, options[1].actions[0]?.id]);
  const foeJoint = foeJointBy(wall.state, (list, position) => (position === 0
    ? list.find((a) => a.kind === ACTION_KINDS.PROTECT) : list.find((a) => !a.wait)));
  const guarded = wall.state.active[1][0].tag;
  const record = wall.resolve(ourJoint, foeJoint);
  const stream = record.stream;
  ok("a Protect is a step of its own", stepsFor(stream, ["protect"], 1, guarded).length === 1,
    JSON.stringify(stream.map((s) => `${s.kind}${s.tag ?? ""}`)));
  ok("and the Pokemon behind it is not hit", stepsFor(stream, ["hit", "miss"], 1, guarded).length === 0,
    JSON.stringify(stepsFor(stream, ["hit", "miss"], 1, guarded)));
  ok("and its HP did not move", wall.view().sides[1].find((m) => m.tag === guarded).hp === 100);
  // The Protect goes out before the attack it stops, because it was used first.
  const protectAt = stream.findIndex((step) => step.kind === "protect");
  const attackAt = stream.findIndex((step) => step.kind === "move" && step.side === 0);
  ok("and the Protect is in the stream before the attack it stopped", protectAt >= 0 && protectAt < attackAt,
    `${protectAt} vs ${attackAt}`);
}

// 7e. a faint, and the replacement that comes out after it.
{
  const down = new PlayGame(solver, data, FORMAT, library);
  down.start({ player: PLAYER, foe: FOE, seed: 75 });
  let record = null;
  for (let turn = 0; turn < 8 && !down.over(); turn += 1) {
    const options = down.options();
    const chosen = options.map((slot) => slot.actions.find((a) => a.target >= 0)?.id || slot.actions[0]?.id);
    const foeJoint = foeJointBy(down.state, (list) => list.find((a) => a.target >= 0));
    record = down.resolve(down.jointFrom(options, chosen), foeJoint);
    if (record.fainted.length) break;
  }
  ok("a turn with a knockout in it", Boolean(record) && record.fainted.length > 0);
  const stream = record.stream;
  const missing = record.fainted.filter((row) => {
    const tag = tagOf(record, row.side, row.name);
    return tag === null || !stepsFor(stream, ["faint"], row.side, tag).length;
  });
  ok("every Pokemon the record says went down has a faint step", missing.length === 0,
    JSON.stringify(missing));
  // The hit that did it is in the stream before the faint, and it takes the bar to nothing.
  for (const row of record.fainted) {
    const tag = tagOf(record, row.side, row.name);
    if (tag === null) continue;
    const faintAt = stream.findIndex((step) => step.kind === "faint" && step.side === row.side && step.tag === tag);
    const last = stream.slice(0, faintAt).filter((step) => (step.kind === "hit" || step.kind === "residual")
      && step.side === row.side && step.tag === tag).pop();
    ok(`${row.name} is taken to nothing before it goes down`, Boolean(last) && last.to === 0,
      JSON.stringify({ faintAt, last }));
    checked -= 1;
  }
  checked += 1;
  // The replacement comes out AFTER the faint, because that is when it comes out.
  const sends = stream.filter((step) => step.kind === "send");
  const early = sends.filter((step) => {
    const sendAt = stream.indexOf(step);
    return stream.some((other, i) => other.kind === "faint" && other.side === step.side && i > sendAt);
  });
  ok("a replacement is sent out after the Pokemon it replaces went down", early.length === 0,
    JSON.stringify(stream.map((s) => s.kind)));
  notes.push(`faint: ${stream.map((s) => s.kind).join(" ")}`);
}

// 7f. a miss can be seen at all, and it is the only thing `rollHit` can tell us.
{
  const air = new PlayGame(solver, data, FORMAT, library);
  air.start({ player: PLAYER, foe: FOE, seed: 76 });
  const options = air.options();
  const chosen = options.map((slot) => slot.actions.find((a) => a.target >= 0 && !a.spread)?.id);
  const foeJoint = foeJointBy(air.state, (list) => list.find((a) => a.target >= 0 && !a.spread));
  // Every roll to hit comes up short. Set on the instance the game plays through, which also
  // proves the watch WRAPS `rollHit` rather than replacing it: if it replaced it, this would
  // never be called and everything would land.
  const realRoll = solver.t.rollHit;
  solver.t.rollHit = () => 0;
  let record = null;
  try {
    record = air.resolve(air.jointFrom(options, chosen), foeJoint);
  } finally {
    solver.t.rollHit = realRoll;
  }
  const stream = record.stream;
  ok("a hit that rolls to nothing is a miss", stream.some((step) => step.kind === "miss"),
    JSON.stringify(stream.map((s) => s.kind)));
  ok("and nothing is reported as having landed", !stream.some((step) => step.kind === "hit"));
  ok("and no HP moved", record.damage.length === 0 && record.fainted.length === 0,
    JSON.stringify(record.damage));
  ok("a miss names a Pokemon on the other side from the one that aimed at it",
    stream.filter((step) => step.kind === "miss").every((step) => {
      const before = stream.slice(0, stream.indexOf(step)).filter((other) => other.kind === "move").pop();
      return before && before.side !== step.side;
    }), JSON.stringify(stream));
  ok("and the watch gave `rollHit` back", solver.t.rollHit === realRoll);
}

// 7g. the end of a turn: what a condition took is a step too, so the bar never jumps.
{
  const sick = new PlayGame(solver, data, FORMAT, library);
  sick.start({ player: PLAYER, foe: FOE, seed: 77 });
  // A burn, set on the board the way a described board sets one (`buildState` reads it off the
  // row). `endOfTurn` takes a sixteenth for it, and nothing events a chip that does not kill.
  sick.state.active[0][0].burn = true;
  const burned = sick.state.active[0][0].tag;
  const options = sick.options();
  const chosen = options.map((slot) => slot.actions.find((a) => a.target >= 0)?.id || slot.actions[0]?.id);
  const foeJoint = foeJointBy(sick.state, (list) => list.find((a) => a.kind === ACTION_KINDS.PROTECT) || list.find((a) => !a.wait));
  const record = sick.resolve(sick.jointFrom(options, chosen), foeJoint);
  const chip = stepsFor(record.stream, ["residual"], 0, burned);
  ok("a burn at the end of the turn is a step", chip.length === 1, JSON.stringify(record.stream));
  ok("and it ends where the view says the Pokemon ended",
    chip.length === 1 && chip[0].to === sick.view().sides[0].find((m) => m.tag === burned).hp,
    JSON.stringify(chip));
  ok("and it is the last thing in the turn, after everything that was aimed at anybody",
    chip.length === 1 && record.stream.indexOf(chip[0]) > record.stream.findIndex((s) => s.kind === "move"));
}

// 7h. nothing the old buckets said is lost, and nothing is invented.
{
  const whole = new PlayGame(solver, data, FORMAT, library);
  whole.start({ player: PLAYER, foe: FOE, seed: 78 });
  const lost = [];
  const invented = [];
  let turns = 0;
  while (!whole.over() && turns < TURN_LIMIT + 2) {
    const options = whole.options();
    const chosen = options.map((slot, position) => (position === 0
      ? options[0].actions.find((a) => a.target >= 0)?.id : slot.actions[0]?.id) || slot.actions[0]?.id);
    const ourJoint = whole.jointFrom(options, chosen);
    const foeJoint = foeJointBy(whole.state, (list, position) => (position === 1
      ? list.find((a) => a.into !== null && a.into !== undefined) : list.find((a) => a.target >= 0)));
    const record = whole.resolve(ourJoint, foeJoint);
    turns += 1;
    const stream = record.stream;
    // Everything the buckets said happened is in the stream, and the stream's numbers add up to
    // the buckets' own: the first step picks up where the turn started and the last leaves it
    // where the turn ended.
    for (const row of record.damage) {
      const tag = tagOf(record, row.side, row.name);
      if (tag === null) continue;
      const steps = hpSteps(stream, row.side, tag);
      if (!steps.length) { lost.push(`turn ${record.turn}: ${row.name} ${row.from}->${row.to} has no step`); continue; }
      if (steps[0].from !== row.from) lost.push(`turn ${record.turn}: ${row.name} starts at ${steps[0].from} not ${row.from}`);
      if (steps[steps.length - 1].to !== row.to) lost.push(`turn ${record.turn}: ${row.name} ends at ${steps[steps.length - 1].to} not ${row.to}`);
    }
    for (const row of record.fainted) {
      const tag = tagOf(record, row.side, row.name);
      if (tag === null) continue;
      if (!stepsFor(stream, ["faint"], row.side, tag).length) lost.push(`turn ${record.turn}: ${row.name} went down with no faint step`);
    }
    for (const play of record.plays) {
      const switched = /switched out for/.exec(play.text);
      if (!switched) continue;
      if (!stream.some((step) => step.kind === "switch" && step.side === play.side)) {
        lost.push(`turn ${record.turn}: "${play.text}" has no switch step`);
      }
    }
    // Nothing in the stream that nobody did: every move step is a Pokemon the log says acted.
    for (const step of stream.filter((s) => s.kind === "move")) {
      const said = record.plays.some((play) => play.side === step.side && play.text.startsWith(`${(record.hp[step.side].find((row) => row.tag === step.tag) || {}).name}: `));
      if (!said) invented.push(`turn ${record.turn}: ${JSON.stringify(step)} is in no play`);
    }
  }
  ok("a whole game's streams lose nothing the buckets said", lost.length === 0, lost.slice(0, 4).join("; "));
  ok("and invent nothing the log does not", invented.length === 0, invented.slice(0, 4).join("; "));
  notes.push(`whole game: ${turns} turns streamed, ${whole.log.reduce((sum, entry) => sum + entry.stream.length, 0)} steps`);
}

// 7i. the engine is handed back exactly as it was found.
{
  const t = solver.t;
  const wasOnHit = t.onHit;
  const wasRollHit = t.rollHit;
  const wasHitOn = Object.prototype.hasOwnProperty.call(t, "hitOn");
  const wasEnter = Object.prototype.hasOwnProperty.call(t, "enter");
  const wasRefill = Object.prototype.hasOwnProperty.call(t, "refill");
  const give = new PlayGame(solver, data, FORMAT, library);
  give.start({ player: PLAYER, foe: FOE, seed: 79 });
  const options = give.options();
  give.resolve(give.jointFrom(options, options.map((slot) => slot.actions[0]?.id)),
    foeJointBy(give.state, (list) => list.find((a) => !a.wait)));
  ok("the turn gives `onHit` back, so Stamina still works for the rest of the game", t.onHit === wasOnHit);
  ok("and `rollHit`, so the game still rolls its damage", t.rollHit === wasRollHit);
  ok("and leaves no shadow on the methods it watched",
    Object.prototype.hasOwnProperty.call(t, "hitOn") === wasHitOn
    && Object.prototype.hasOwnProperty.call(t, "enter") === wasEnter
    && Object.prototype.hasOwnProperty.call(t, "refill") === wasRefill);
  // Including when the turn blows up halfway through, which is the case nobody writes down.
  const realApply = solver.applyChosenTurn;
  solver.applyChosenTurn = () => { throw new Error("the turn fell over"); };
  let threw = false;
  try {
    give.resolve(give.jointFrom(options, options.map((slot) => slot.actions[0]?.id)),
      foeJointBy(give.state, (list) => list.find((a) => !a.wait)));
  } catch {
    threw = true;
  } finally {
    solver.applyChosenTurn = realApply;
  }
  ok("a turn that throws still gives the engine back", threw && t.onHit === wasOnHit && t.rollHit === wasRollHit);
  ok("and still leaves no shadow", Object.prototype.hasOwnProperty.call(t, "hitOn") === wasHitOn
    && Object.prototype.hasOwnProperty.call(t, "enter") === wasEnter
    && Object.prototype.hasOwnProperty.call(t, "refill") === wasRefill);
  // And Stamina is not merely the same function: it still does what it does.
  const stamina = { out: false, u: { mon: { ability: "Stamina", defense_stage: 0 } }, def: 0 };
  t.onHit(stamina, null, null);
  ok("and Stamina still answers a hit", stamina.def === 1, JSON.stringify(stamina.def));
}

for (const line of notes) console.log(line);
// ---------------------------------------------------------------------------
// 16. the search plan is chosen from the position, not fixed
// ---------------------------------------------------------------------------
{
  const planner = new PlayGame(solver, data, FORMAT, library, { sheet: "open" });
  planner.start({ player: topTeam(6), foe: FOE, seed: 41 });
  const full = planner.planSearch();
  ok("a plan says what it read off the board",
    full.why && typeof full.why.width === "number" && typeof full.why.boards === "number",
    JSON.stringify(full.why));
  ok("it stays inside the time band",
    full.thinkMs >= THINK_RANGE[0] && full.thinkMs <= THINK_RANGE[1], String(full.thinkMs));
  ok("and inside the look-ahead band",
    full.lookahead >= LOOKAHEAD_BAND[0] && full.lookahead <= LOOKAHEAD_BAND[1], String(full.lookahead));
  ok("it asks for a settle window, so an obvious board can stop early", full.settleLines > 0,
    String(full.settleLines));
  ok("the width it measured is the opponent's real action count", full.why.width > 0, String(full.why.width));

  // An emptier board is a narrower question: fewer Pokemon, so less time and a longer tail.
  const endgame = new PlayGame(solver, data, FORMAT, library, { sheet: "open" });
  endgame.start({ player: topTeam(6), foe: FOE, seed: 41 });
  for (const m of endgame.state.sides[0].slice(1)) { m.hp = 0; m.out = true; }
  for (const m of endgame.state.sides[1].slice(1)) { m.hp = 0; m.out = true; }
  const small = endgame.planSearch();
  ok("an endgame is given less time than a full board", small.thinkMs <= full.thinkMs,
    `${small.thinkMs} vs ${full.thinkMs}`);
  ok("and is allowed to look further ahead", small.lookahead >= full.lookahead,
    `${small.lookahead} vs ${full.lookahead}`);
  console.log(`plan: full board ${full.thinkMs}ms depth ${full.lookahead} (width ${full.why.width}, ${full.why.boards} boards)`
    + ` | endgame ${small.thinkMs}ms depth ${small.lookahead} (width ${small.why.width})`);

  // The caller's value is a CEILING: the suites drive this with 100-400ms and must stay quick.
  const tiny = planner.planSearch({ thinkMs: 200 });
  ok("a caller asking for 200ms is not given seconds", tiny.thinkMs <= 400, String(tiny.thinkMs));
}

// ---------------------------------------------------------------------------
// 17. a move with no effect on what is standing there is still a legal choice
// ---------------------------------------------------------------------------
{
  // The opponent may switch before it lands, and then it matters: a Fighting move aimed at a
  // Ghost becomes a Fighting move aimed at whatever replaced it. The SEARCH still prunes it --
  // for the search the board is fixed and the damage really is zero -- so the two lists differ.
  const immune = new PlayGame(solver, data, FORMAT, library, { sheet: "open" });
  const press = makeSet({ ...data.commonSet(FORMAT, "Archaludon", "Archaludon"),
    moves: ["Body Press", "Flash Cannon", "Dragon Pulse", "Electro Shot"] });
  const ghost = makeSet({ ...data.commonSet(FORMAT, "Dragapult", "Dragapult"),
    moves: ["Dragon Darts", "Phantom Force", "Protect", "Tailwind"] });
  immune.start({ player: [press, press], foe: [ghost, ghost], seed: 5 });
  const state = immune.state;
  const frac = solver.t.hitOn(state.active[0][0], state.active[1][0], 0, state.board).frac;
  ok("Body Press really does nothing to a Ghost", frac === 0, String(frac));

  const uncut = solver.slotCandidates(state, 0, 0, { cap: 0 });
  const searched = solver.slotCandidates(state, 0, 0, {});
  const offered = uncut.filter((a) => a.move === "Body Press");
  ok("the player is still offered it", offered.length > 0, JSON.stringify(uncut.map((a) => a.move)));
  ok("and it is marked as having no effect", offered.every((a) => a.noEffect === true && a.value === 0),
    JSON.stringify(offered));
  ok("the search does not waste a line on it", !searched.some((a) => a.move === "Body Press"),
    JSON.stringify(searched.map((a) => a.move)));

  // ...and playing it says so, rather than the move vanishing from the turn.
  const options = immune.options();
  const pick = options[0]?.actions?.find((a) => a.move === "Body Press");
  ok("it reaches the player's own action sheet", Boolean(pick),
    JSON.stringify((options[0]?.actions || []).map((a) => a.move)));
  if (pick) {
    const ours = immune.jointFrom(options, [pick.id, options[1]?.actions?.[0]?.id]);
    const theirs = foeJointBy(immune.state, (list) => list.find((a) => !a.wait));
    const record = immune.resolve(ours, theirs);
    const said = record.stream.filter((s) => s.kind === "note" && /had no effect on/i.test(s.text || ""));
    ok("the play-out says it had no effect", said.length > 0,
      JSON.stringify(record.stream.filter((s) => s.kind === "note").map((s) => s.text)));
  }
}

if (failures.length) {
  console.error(`\n${checked} checks, ${failures.length} failed:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\n${checked} checks, all passed.`);
