// The turn-1 rule of Test against Tournament Teams (builder/tournament-test.js
// TOURNAMENT_TURN_ONE). Version 1 (planSetup): Tailwind and Trick Room are PRICED on turn 1
// instead of simply used. Before the rule a lead that carried Trick Room used it whenever its
// side was the slower one and a lead that carried Tailwind always used it, so a Trick Room team
// got its defining condition free in every one of the ~2,827 matches. Version 2 (duelBoard):
// the quick duels are fought on a fresh field instead of on the board the chosen game left after
// turn 1, so a turn-1 Trick Room no longer inverts who strikes first in them.
//
// Checked here, on hand-made leads so it stays fast (no corpus run):
//   - the stamp coerces exactly as team-checks' does, and version 0 replays the forced branches;
//   - the condition IS still set when the team's plan depends on it and the setter is safe;
//   - it is NOT set when the inversion buys nothing, when the setter is knocked out first, when
//     Fake Out would stop it, when the other side's Trick Room would cancel it, and a slow side
//     does not set Tailwind into its own Trick Room;
//   - the decision is symmetric: the identical function prices side 1 the same way as side 0;
//   - the results say which move was held back and why;
//   - the duel board carries no Trick Room and no Tailwind but does carry the two duellists' own
//     weather and terrain (the slower setter's, as on entry; never over a pinned field), so a
//     duel is the same number whatever board the caller holds -- and version 1 still is not.
//
//   node tests/run-tournament-turn-one.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest, TOURNAMENT_TURN_ONE, tournamentTurnOneOption } from "../builder/tournament-test.js";
import { makeSet } from "../builder/common.js";
import { storyLine } from "../builder/tournament-view.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const knownRaw = JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8"));
const meta = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

function makeTest(turnOneRule, settings = {}) {
  const engine = new DamageEngine(appData);
  const ev = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS, ...settings }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new TournamentTest(evaluation, new KnownTeams(knownRaw), new TeamSuggestions(evaluation), { turnOneRule });
}

const priced = makeTest(TOURNAMENT_TURN_ONE);
const forced = makeTest(0);

const member = (species, item, ability, nature, moves, form = "") => ({ species, form: form || species, item, ability, nature, moves });

/** One game between two hand-made leads-only brings; returns the recorded game. */
function game(test, oursSets, theirMembers) {
  const ours = oursSets.map((set, i) => test.ourUnit(makeSet(set), i));
  const theirs = theirMembers.map((m) => test.opponentMon(m));
  const [our] = test.plansFor(ours).filter((plan) => plan.members.length === ours.length);
  const [their] = test.plansFor(theirs).filter((plan) => plan.members.length === theirs.length);
  return test.play(our, their, null, true);
}
const events = (g, side, kind) => g.events.filter((e) => (side === null || e.s === side) && e.kind === kind);
const heldWhy = (g, side, move) => events(g, side, "heldback").filter((e) => e.move === move).map((e) => e.why).join(",");

// --- the stamp ----------------------------------------------------------------------------------

check("TOURNAMENT_TURN_ONE is version 2", TOURNAMENT_TURN_ONE === 2);
for (const off of [null, undefined, false, "", "0", "off", "false", "no", "none", 0, -1, "-5", "0.9"]) {
  check(`tournamentTurnOneOption(${JSON.stringify(off)}) is off`, tournamentTurnOneOption(off) === 0, String(tournamentTurnOneOption(off)));
}
check("tournamentTurnOneOption(1) is 1", tournamentTurnOneOption(1) === 1);
check("tournamentTurnOneOption('1.9') truncates to 1", tournamentTurnOneOption("1.9") === 1);
check("tournamentTurnOneOption('2') is 2", tournamentTurnOneOption("2") === 2);
check("tournamentTurnOneOption('3') is kept for a later version", tournamentTurnOneOption("3") === 3);
check("a value that is not a number is the current version", tournamentTurnOneOption("yes") === TOURNAMENT_TURN_ONE);
check("the default option is the current version", makeTest(undefined).turnOneRule === TOURNAMENT_TURN_ONE);
check("version 0 is kept as 0", forced.turnOneRule === 0);
check("version 1 is kept as 1", makeTest(1).turnOneRule === 1);

// --- the fixtures -------------------------------------------------------------------------------

// A slow Trick Room pair whose plan depends on the inversion, and a fast pair to play it against.
const farigiraf = { species: "Farigiraf", item: "Sitrus Berry", ability: "Armor Tail", nature: "Relaxed", moves: ["Psychic", "Helping Hand", "Trick Room", "Protect"], bonuses: [32, 0, 32, 0, 2, 0] };
const torkoal = { species: "Torkoal", item: "Charcoal", ability: "Drought", nature: "Quiet", moves: ["Eruption", "Weather Ball", "Earth Power", "Protect"], bonuses: [32, 0, 0, 32, 2, 0] };
const whimsicott = { species: "Whimsicott", item: "Focus Sash", ability: "Prankster", nature: "Timid", moves: ["Tailwind", "Moonblast", "Encore", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] };
// A fast Trick Room carrier: the inversion would cost it the order it already has.
const fastRoomer = { species: "Indeedee", form: "Indeedee Female", item: "Psychic Seed", ability: "Inner Focus", nature: "Timid", moves: ["Trick Room", "Psychic", "Dazzling Gleam", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] };
const fastFoes = [
  member("Garchomp", "Life Orb", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"]),
  member("Sneasler", "Focus Sash", "Unburden", "Jolly", ["Dire Claw", "Close Combat", "Gunk Shot", "Protect"]),
];
const slowFoes = [
  member("Torkoal", "Charcoal", "Drought", "Quiet", ["Eruption", "Weather Ball", "Earth Power", "Protect"]),
  member("Sinistcha", "Sitrus Berry", "Hospitality", "Relaxed", ["Matcha Gotcha", "Shadow Ball", "Trick Room", "Protect"]),
];

// --- 1. it must STILL set up when the plan depends on it and the setter is safe ------------------

{
  const g = game(priced, [farigiraf, torkoal], fastFoes);
  check("A committed Trick Room team still sets Trick Room", g.after.trickRoom === 4 && g.after.trickRoomBy === "you", `${JSON.stringify(g.after.trickRoom)} / ${g.after.trickRoomBy} / held ${heldWhy(g, 0, "Trick Room")}`);
  check("And it moves first on turn 2", g.after.faster === "you", g.after.faster);
  check("Nothing is reported as held back when the move was used", events(g, 0, "heldback").length === 0, JSON.stringify(events(g, 0, "heldback").map((e) => `${e.move}:${e.why}`)));
  const forcedGame = game(forced, [farigiraf, torkoal], fastFoes);
  check("Version 0 sets it too (the case both rules agree on)", forcedGame.after.trickRoom === 4 && forcedGame.after.trickRoomBy === "you", JSON.stringify(forcedGame.after.trickRoom));
  check("Version 0 reports nothing held back", forcedGame.events.every((e) => e.kind !== "heldback"));
}

// --- 2. it must NOT set up when the inversion buys nothing ---------------------------------------

{
  // A fast Trick Room carrier against a slower pair: inverting the order would hand it away.
  const g = game(priced, [fastRoomer, whimsicott], slowFoes);
  check("A faster side does not set Trick Room", !g.after.trickRoom || g.after.trickRoomBy !== "you", `${g.after.trickRoom} by ${g.after.trickRoomBy}`);
  check("And it says why: the order would not improve", heldWhy(g, 0, "Trick Room").includes("nogain"), heldWhy(g, 0, "Trick Room") || "(nothing held back)");
  // Version 0's own gate already refused this one (slower[s] was false), so the two agree here --
  // which is exactly why the gate had to be replaced by a measurement rather than removed.
  const forcedGame = game(forced, [fastRoomer, whimsicott], slowFoes);
  check("Version 0 refuses it through the old slower gate", !forcedGame.after.trickRoom || forcedGame.after.trickRoomBy !== "you");
}

// --- 3. Tailwind is priced the same way ---------------------------------------------------------

{
  // Whimsicott's Tailwind against a pair it already outruns: doubling its Speed changes no pair.
  const alreadyFaster = [
    member("Torkoal", "Charcoal", "Drought", "Quiet", ["Eruption", "Weather Ball", "Earth Power", "Protect"]),
    member("Farigiraf", "Sitrus Berry", "Armor Tail", "Relaxed", ["Psychic", "Helping Hand", "Trick Room", "Protect"]),
  ];
  const fastPair = [{ ...whimsicott }, { species: "Sneasler", item: "Focus Sash", ability: "Unburden", nature: "Jolly", moves: ["Dire Claw", "Close Combat", "Gunk Shot", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] }];
  const g = game(priced, fastPair, alreadyFaster);
  check("Tailwind is not set when it changes no Speed pair", !g.after.tailwind.you, JSON.stringify(g.after.tailwind));
  check("And it says why", heldWhy(g, 0, "Tailwind").includes("nogain"), heldWhy(g, 0, "Tailwind") || "(nothing held back)");
  const forcedGame = game(forced, fastPair, alreadyFaster);
  check("Version 0 sets that pointless Tailwind (the forced branch)", forcedGame.after.tailwind.you === 3, JSON.stringify(forcedGame.after.tailwind));
}

// --- 4. a slow side does not set Tailwind INTO its own Trick Room --------------------------------

{
  // Both carriers on the field, both bids priced: whichever wins, the other is re-priced on the
  // board it leaves, and a side that inverted the order does not then double its own Speed.
  const slowWhimsicott = { ...whimsicott, nature: "Relaxed", bonuses: [32, 0, 32, 0, 2, 0] };
  const g = game(priced, [farigiraf, slowWhimsicott], fastFoes);
  check("The Trick Room the team is built for still goes up", g.after.trickRoom === 4 && g.after.trickRoomBy === "you", JSON.stringify(g.after.trickRoom));
  check("And the Tailwind that would undo it does not", g.after.tailwind.you === 0, JSON.stringify(g.after.tailwind));
  check("The held-back Tailwind is reported", heldWhy(g, 0, "Tailwind") === "nogain", heldWhy(g, 0, "Tailwind") || "(nothing held back)");
  const forcedGame = game(forced, [farigiraf, slowWhimsicott], fastFoes);
  check("Version 0 sets both and fights its own Speed plan", forcedGame.after.trickRoom === 4 && forcedGame.after.tailwind.you === 3, `TR ${forcedGame.after.trickRoom} TW ${JSON.stringify(forcedGame.after.tailwind)}`);
}

{
  // Two Trick Room carriers on the field: one condition per side, so the second one is told the
  // job is already taken rather than spending its turn on a move that does nothing.
  const secondRoomer = { species: "Sinistcha", item: "Sitrus Berry", ability: "Hospitality", nature: "Relaxed", moves: ["Trick Room", "Matcha Gotcha", "Shadow Ball", "Protect"], bonuses: [32, 0, 32, 0, 2, 0] };
  const g = game(priced, [farigiraf, secondRoomer], fastFoes);
  check("One of two Trick Room carriers sets it", g.after.trickRoom === 4 && g.after.trickRoomBy === "you", JSON.stringify(g.after.trickRoom));
  check("The other is told the Speed order is already decided", heldWhy(g, 0, "Trick Room") === "taken", heldWhy(g, 0, "Trick Room") || "(nothing held back)");
}

// --- 5. Fake Out on the only setter ------------------------------------------------------------

{
  // Their Fake Out on our only setup carrier, which is not flinch-proof and has no priority
  // blocker beside it: risk 1 / 1 carrier, so the bid is worth nothing.
  const flinchable = { species: "Cresselia", item: "Sitrus Berry", ability: "Levitate", nature: "Relaxed", moves: ["Trick Room", "Psychic", "Moonblast", "Protect"], bonuses: [32, 0, 32, 0, 2, 0] };
  const withFakeOut = [
    member("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"]),
    member("Sneasler", "Focus Sash", "Unburden", "Jolly", ["Dire Claw", "Close Combat", "Gunk Shot", "Protect"]),
  ];
  const g = game(priced, [flinchable, torkoal], withFakeOut);
  check("A lone setter that Fake Out can stop holds Trick Room back", heldWhy(g, 0, "Trick Room") === "fakeout", heldWhy(g, 0, "Trick Room") || "(nothing held back)");
  check("So Trick Room never goes up for us", !g.after.trickRoom, String(g.after.trickRoom));
}

// --- 6. the two risks, priced directly ----------------------------------------------------------

// setupRisk is the one part of the rule that is about what the turn does ANYWAY, so it is asserted
// on its own: a frail setter that both foes together take out before -7, and the same setter with
// an unbroken Focus Sash, which survives to use it.
{
  const board = { w: 0, t: 0, tw: [0, 0], tr: 0, trBy: -1, wide: 0, quick: 0 };
  const lead = (set, i, s) => priced.fresh(priced.ourUnit(makeSet(set), i), s, true);
  const frailSetter = { species: "Whimsicott", item: "Life Orb", ability: "Prankster", nature: "Timid", moves: ["Trick Room", "Moonblast", "Encore", "Protect"], bonuses: [0, 0, 0, 32, 0, 32] };
  const heavy = [
    { species: "Chien-Pao", item: "Life Orb", ability: "Sword of Ruin", nature: "Jolly", moves: ["Icicle Crash", "Sucker Punch", "Sacred Sword", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
    { species: "Flutter Mane", item: "Choice Specs", ability: "Protosynthesis", nature: "Timid", moves: ["Moonblast", "Shadow Ball", "Dazzling Gleam", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
  ];
  const mine = [lead(frailSetter, 0, 0), lead(torkoal, 1, 0)];
  const foes = heavy.map((set, i) => lead(set, 2 + i, 1));
  const risk = priced.setupRisk(mine[0], mine, foes, board, -6);
  check("A setter both foes take out before it moves is priced at 0.9 / ko", risk.p === 0.9 && risk.why === "ko", JSON.stringify(risk));
  // A Focus Sash at full HP survives the turn, so the knockout risk does not apply.
  const sashed = [lead({ ...frailSetter, item: "Focus Sash" }, 4, 0), mine[1]];
  const sashRisk = priced.setupRisk(sashed[0], sashed, foes, board, -6);
  check("An unbroken Focus Sash removes the knockout risk", sashRisk.why !== "ko", JSON.stringify(sashRisk));
  // The mirror: our leads already own the order on the field but our BRING is the slower one, and
  // a foe lead carries Trick Room -- whoever moves second at -7 would turn it straight off again.
  // Version 0 could never reach this case, because `slower` was mutually exclusive and a slow
  // side's Trick Room was structurally uncancellable.
  const ours = [lead(fastRoomer, 5, 0), lead(torkoal, 6, 0)];
  const theirs = [lead(torkoal, 7, 1), lead({ species: "Sinistcha", item: "Sitrus Berry", ability: "Hospitality", nature: "Relaxed", moves: ["Trick Room", "Matcha Gotcha", "Shadow Ball", "Protect"], bonuses: [32, 0, 32, 0, 2, 0] }, 8, 1)];
  const mirror = priced.planSetup(0, ours, theirs, board, [true, false]);
  check("A Trick Room the other side would cancel is not set", mirror.setup.size === 0, JSON.stringify([...mirror.setup.values()].map((v) => v.move)));
  check("And the reason given is the mirror", [...mirror.held.values()].some((v) => v.move === "Trick Room" && v.why === "mirror"), JSON.stringify([...mirror.held.values()]));
}

// --- 7. symmetry: the identical function prices side 1 the same way -----------------------------

{
  // planSetup is called once per side from turnOne, so the same leads must get the same decision
  // whichever side they are on. Nothing in the rule reads which side is the user's.
  const mineUnits = [farigiraf, torkoal].map((set, i) => priced.ourUnit(makeSet(set), i));
  const foeUnits = fastFoes.map((m) => priced.opponentMon(m));
  const board = { w: 0, t: 0, tw: [0, 0], tr: 0, trBy: -1, wide: 0, quick: 0 };
  const asSide0 = priced.planSetup(0, mineUnits.map((u) => priced.fresh(u, 0, true)), foeUnits.map((u) => priced.fresh(u, 1, true)), board, [true, false]);
  const asSide1 = priced.planSetup(1, mineUnits.map((u) => priced.fresh(u, 1, true)), foeUnits.map((u) => priced.fresh(u, 0, true)), board, [false, true]);
  const shape = (r) => [...r.setup.values()].map((v) => `${v.move}@${v.value.toFixed(6)}`).sort().join("|");
  const backs = (r) => [...r.held.values()].map((v) => `${v.move}:${v.why}`).sort().join("|");
  check("The same leads get the same setup on either side", shape(asSide0) === shape(asSide1), `${shape(asSide0)} vs ${shape(asSide1)}`);
  check("And the same reasons on either side", backs(asSide0) === backs(asSide1), `${backs(asSide0)} vs ${backs(asSide1)}`);
  check("The committed side actually set something", shape(asSide0) !== "", shape(asSide0));
  // Their setter is priced too: two slow sides both carrying Trick Room, and the one the rule
  // refuses is the one whose bring is not the slower -- something version 0's gate decided for it.
  const g = game(priced, [farigiraf, torkoal], slowFoes);
  check("Their own setter is priced by the same rule", heldWhy(g, 1, "Trick Room") !== "", JSON.stringify(events(g, 1, "heldback").map((e) => `${e.move}:${e.why}`)));
  const forcedGame = game(forced, [farigiraf, torkoal], slowFoes);
  check("Version 0 never prices their setter at all", events(forcedGame, 1, "heldback").length === 0);
}

// --- 8. the story says what happened ------------------------------------------------------------

{
  const g = game(priced, [fastRoomer, whimsicott], slowFoes);
  const story = g.events
    .filter((e) => e.kind === "heldback")
    .map((e) => storyLine({ side: e.s === 0 ? "you" : "them", kind: e.kind, actor: e.actor, move: e.move || "", why: e.why || "", target: null }, (m) => m.species));
  check("Every held-back move produces a line", story.length > 0 && story.every((line) => line && line.includes("holds")), JSON.stringify(story));
  check("The line names the move and the side", story.some((line) => line.startsWith("Your ") && line.includes("Trick Room")), JSON.stringify(story));
  const unknown = storyLine({ side: "you", kind: "heldback", actor: { species: "Farigiraf" }, move: "Trick Room", why: "a reason from a later version", target: null }, (m) => m.species);
  check("An unknown reason prints nothing rather than half a sentence", unknown === "", unknown);
}

// --- 9. the duel board (version 2) --------------------------------------------------------------

// `playTeam` used to duel on `game.board`, the board the chosen game left AFTER turn 1, so a
// Trick Room set on turn 1 inverted `duel`'s Speed comparison and a Tailwind sped up every one of
// that side's slots -- including the ones that game never brought. Version 2 duels on
// `duelBoard`: a fresh field plus the weather and terrain the two duellists themselves bring.
{
  const afterV1 = makeTest(1);
  const now = makeTest(TOURNAMENT_TURN_ONE);
  // The two constant tables of tournament-test.js, by index (nothing exports them).
  const WEATHERS = ["None", "Sun", "Rain", "Sand", "Snow", "Strong Winds"];
  const TERRAINS = ["None", "Electric", "Grassy", "Psychic", "Misty"];

  // --- what is on the board -------------------------------------------------------------------
  const unitsOf = (test) => ({
    ours: [farigiraf, torkoal, whimsicott, fastRoomer].map((set, i) => test.ourUnit(makeSet(set), i)),
    theirs: [...fastFoes, ...slowFoes].map((m) => test.opponentMon(m)),
  });
  {
    const { ours, theirs } = unitsOf(now);
    const boards = ours.flatMap((o) => theirs.map((t) => now.duelBoard(o, t)));
    check("No duel board carries a Trick Room", boards.every((b) => b.tr === 0 && b.trBy === -1));
    check("No duel board carries a Tailwind", boards.every((b) => b.tw[0] === 0 && b.tw[1] === 0));
    check("No duel board carries a turn-1 guard", boards.every((b) => b.wide === 0 && b.quick === 0));
  }

  // --- the weather and terrain that DO belong: the duellists' own -----------------------------
  {
    const { ours } = unitsOf(now);
    const ourTorkoal = ours[1];
    const theirGarchomp = now.opponentMon(fastFoes[0]);
    check("A duellist's own Drought is on its duel board",
      WEATHERS[now.duelBoard(ourTorkoal, theirGarchomp).w] === "Sun", WEATHERS[now.duelBoard(ourTorkoal, theirGarchomp).w]);
    check("And it is there whichever side holds it",
      WEATHERS[now.duelBoard(ours[0], now.opponentMon(slowFoes[0])).w] === "Sun");
    // Two setters: the entry order of `turnOne` is fastest first, each overwriting, so the
    // SLOWER one's field stands. Torkoal (base Speed 20) comes in after Abomasnow (60).
    const abomasnow = member("Abomasnow", "Icy Rock", "Snow Warning", "Modest", ["Blizzard", "Energy Ball", "Aurora Veil", "Protect"]);
    check("Between two weather setters the slower one's weather stands",
      WEATHERS[now.duelBoard(ourTorkoal, now.opponentMon(abomasnow)).w] === "Sun",
      WEATHERS[now.duelBoard(ourTorkoal, now.opponentMon(abomasnow)).w]);
    const fastDrought = now.ourUnit(makeSet({ species: "Charizard", form: "Mega Charizard Y", item: "Charizardite Y", ability: "Drought", nature: "Modest", moves: ["Heat Wave", "Weather Ball", "Solar Beam", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] }), 40);
    check("And the faster setter's weather does not",
      WEATHERS[now.duelBoard(fastDrought, now.opponentMon(abomasnow)).w] === "Snow",
      WEATHERS[now.duelBoard(fastDrought, now.opponentMon(abomasnow)).w]);
    // Terrain rides along the same way.
    const indeedee = member("Indeedee", "Psychic Seed", "Psychic Surge", "Timid", ["Expanding Force", "Dazzling Gleam", "Trick Room", "Protect"], "Indeedee Female");
    check("A duellist's own terrain is on its duel board",
      TERRAINS[now.duelBoard(ourTorkoal, now.opponentMon(indeedee)).t] === "Psychic",
      TERRAINS[now.duelBoard(ourTorkoal, now.opponentMon(indeedee)).t]);
    // A pinned field is the user's: `kit.weather` is already "" then, so nothing can override it.
    const pinned = makeTest(TOURNAMENT_TURN_ONE, { weather: "Rain", terrain: "Grassy" });
    const pinnedBoard = pinned.duelBoard(pinned.ourUnit(makeSet(torkoal), 0), pinned.opponentMon(indeedee));
    check("A weather the settings pin is not overridden by a duellist's Ability",
      WEATHERS[pinnedBoard.w] === "Rain" && TERRAINS[pinnedBoard.t] === "Grassy",
      `${WEATHERS[pinnedBoard.w]} / ${TERRAINS[pinnedBoard.t]}`);
  }

  // --- the bias itself: version 1 reads the caller's board, version 2 does not -----------------
  {
    const v1 = unitsOf(afterV1);
    const v2 = unitsOf(now);
    const trickRoom = { w: 0, t: 0, tw: [0, 0], tr: 4, trBy: 0, wide: 0, quick: 0 };
    const ourTailwind = { w: 0, t: 0, tw: [3, 0], tr: 0, trBy: -1, wide: 0, quick: 0 };
    const fresh = afterV1.freshBoard();
    let invertedByTrickRoom = 0;
    let movedByTailwind = 0;
    let stable = true;
    let matchesDuelBoard = true;
    for (let i = 0; i < v1.ours.length; i += 1) {
      for (let j = 0; j < v1.theirs.length; j += 1) {
        const [o1, t1] = [v1.ours[i], v1.theirs[j]];
        const [o2, t2] = [v2.ours[i], v2.theirs[j]];
        if (afterV1.duel(o1, t1, trickRoom) !== afterV1.duel(o1, t1, fresh)) invertedByTrickRoom += 1;
        if (afterV1.duel(o1, t1, ourTailwind) !== afterV1.duel(o1, t1, fresh)) movedByTailwind += 1;
        // Version 2 ignores whatever board it is handed...
        const value = now.duel(o2, t2, trickRoom);
        if (value !== now.duel(o2, t2, ourTailwind) || value !== now.duel(o2, t2, fresh)) stable = false;
        // ...and scores exactly the duel version 1 scores on `duelBoard`.
        if (value !== afterV1.duel(o1, t1, afterV1.duelBoard(o1, t1))) matchesDuelBoard = false;
      }
    }
    check("Version 1 really is inverted by a Trick Room on the board it is handed", invertedByTrickRoom > 0, String(invertedByTrickRoom));
    check("Version 1 really is moved by a Tailwind on the board it is handed", movedByTailwind > 0, String(movedByTailwind));
    check("Version 2 gives the same duel whatever board it is handed", stable);
    check("Version 2's duel is version 1's duel on the fresh duel board", matchesDuelBoard);
  }

  // --- end to end: the board a real turn 1 leaves no longer reaches the duel -------------------
  {
    const g = game(now, [farigiraf, torkoal], fastFoes);
    check("The fixture still puts Trick Room up on turn 1", g.after.trickRoom === 4 && g.after.trickRoomBy === "you", JSON.stringify(g.after));
    check("But that board has a Trick Room to leak", g.board.tr > 0, JSON.stringify(g.board));
    const { ours, theirs } = unitsOf(now);
    const onGameBoard = ours.map((o) => theirs.map((t) => now.duel(o, t, g.board)));
    const onFresh = ours.map((o) => theirs.map((t) => now.duel(o, t, now.freshBoard())));
    check("Version 2's duels are unchanged by it", JSON.stringify(onGameBoard) === JSON.stringify(onFresh));
    const old = makeTest(1);
    const oldUnits = unitsOf(old);
    const oldOnGameBoard = oldUnits.ours.map((o) => oldUnits.theirs.map((t) => old.duel(o, t, g.board)));
    const oldOnFresh = oldUnits.ours.map((o) => oldUnits.theirs.map((t) => old.duel(o, t, old.freshBoard())));
    check("Version 1's are not", JSON.stringify(oldOnGameBoard) !== JSON.stringify(oldOnFresh));
  }
}

console.log(`${checked} checked, ${failures.length} failed.`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
