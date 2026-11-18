// WHO IS STANDING WHERE, in a played game (builder/play-game.js, builder/solver.js,
// builder/tournament-test.js).
//
// Every check here is a bug reported from a real game on the website, and almost all of them came
// out of one mistake: `refill` was handed a filtered COPY of the side lists to pick a replacement
// from, and it does not only READ that list -- a bail-out or a pivot move SWAPS two entries in it.
// The array writes went into the copy and were thrown away; the `ix` they belong with went onto
// the rows themselves and survived. From then on `ix`, which every reader takes to mean "where
// this Pokemon sits in its side's list", was wrong.
//
// What that looked like to a player:
//
//   * "Golisopod went back, and out came Rillaboom", and then Golisopod took both of that turn's
//     Rock Slides. The stream worked switches out from the `ix` it could see AFTERWARDS, so an
//     Emergency Exit at the end of the turn was announced at the start of it;
//   * that same line naming the wrong Pokemon, because two switches on one side in one turn swap
//     two pairs of indices at once and the pairing came out crossed;
//   * "After Archaludon fainted, Salamence is not brought out" -- stranded in front of the
//     watermark `refill` picks from, where nothing could reach it again, so the game could
//     neither be finished nor won;
//   * one Pokemon standing in BOTH of a side's seats, because the pick list was a snapshot taken
//     before the swap that had just put it on the field;
//   * one Pokemon leaving one seat and walking straight into the other on the same turn, which
//     the game does not allow;
//   * and one that is not about seats at all: Stamina raised Archaludon's Defense correctly --
//     measured, four hits took 6.66%, 4.42%, 3.29%, 2.77%, which is the Defense-stage ladder
//     exactly -- and said nothing, so from the outside the Ability looked dead.
//
//   node tests/run-play-seats.mjs
//
// Not deployed: tests/ is in tools/pages-excludes.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData, makeSet } from "../builder/common.js";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest } from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";
import { PlayGame, teamFromKnown } from "../builder/play-game.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));

let checked = 0;
const failures = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const FORMAT = "Doubles";
const appData = read("data", "builder", "app-data.json");
const meta = read("data", "builder", `meta-${FORMAT.toLowerCase()}.json`);
const effects = read("data", "builder", "move-effects.json");
const library = read("data", "builder", "pokemon-sets.json").sets;
const data = new BuilderData(appData);
data.ingestMeta(FORMAT, meta);
const ev = new TeamEvaluator(data, new DamageEngine(appData), FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
ev.setMetaRecords(meta.pokemon || []);
const evaluation = new TeamEvaluation(ev);
const known = new KnownTeams(read("data", "builder", "known-teams.json"));

// EXACTLY the options analysis-worker.js builds the played game with. Without `bailRule` and
// `pivotRule` none of this is reachable: Emergency Exit never fires, nothing ever swaps inside
// `refill`, and a game plays through without touching the code these checks are about. The first
// attempt at reproducing the reported bug left them out and found nothing wrong at all.
const PLAY_OPTS = {
  effects, liveHpRule: 1, chargeRule: 1, berryRule: 1, stagesRule: 1, confusionRule: 1, ppRule: 1,
  rberryRule: 1, bailRule: 1, shieldRule: 1, fieldTurnsRule: 1, abilityOpsRule: 1, hazardsRule: 1,
  pivotRule: 1, selfRollRule: 1, actionRollRule: 1,
};

const compact = (word) => String(word || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const named = (name, item) => {
  const [species, form] = data.resolve(name, name);
  const set = data.commonSet(FORMAT, species, form);
  if (!set || !set.moves?.length) return null;
  return makeSet({ ...set, moves: [...set.moves], item: item || set.item });
};

/**
 * The reported team, and it has to be this one.
 *
 * Golisopod has EMERGENCY EXIT, which is the only way a Pokemon leaves the field in the middle of
 * `refill` without having fainted, and Archaludon has STAMINA. A team with neither plays
 * thousands of clean turns and proves nothing, so the two abilities are asserted rather than
 * assumed: a usage change that moves either set would otherwise retire this whole suite silently.
 */
const REPORTED = [named("Salamence", "Salamencite"), named("Golisopod"), named("Rillaboom"), named("Archaludon")];
ok("the reported team's four are all still in the meta", REPORTED.every(Boolean),
  REPORTED.map((set, i) => (set ? "" : `slot ${i}`)).filter(Boolean).join(", "));
ok("Golisopod's common set still has Emergency Exit", compact(REPORTED[1]?.ability) === "emergencyexit",
  String(REPORTED[1]?.ability));
ok("Archaludon's common set still has Stamina", compact(REPORTED[3]?.ability) === "stamina",
  String(REPORTED[3]?.ability));

const nameOf = (solver, m) => (m ? solver.label(m.u) : "EMPTY");

/** One game, every choice taken at random, with the board and the stream checked every turn. */
function play(seed, player, foe, where) {
  const solver = new Solver(new TournamentTest(evaluation, known, new TeamSuggestions(evaluation), PLAY_OPTS));
  const game = new PlayGame(solver, data, FORMAT, library);
  let x = (seed * 2654435761) >>> 0;
  const rng = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  game.start({ player, foe, seed });
  const found = { bails: 0, late: 0, stamina: 0, switches: 0 };

  for (let turn = 1; turn <= 14 && !game.over(); turn += 1) {
    const options = game.options();
    const chosen = options.map((slot) => {
      if (slot.empty) return null;
      const pick = slot.actions[Math.floor(rng() * slot.actions.length)] || slot.actions[0];
      return pick ? pick.id : null;
    });
    const ourJoint = game.jointFrom(options, chosen);
    const theirJoint = [0, 1]
      .map((position) => solver.slotCandidates(game.state, 1, position, { cap: 0 })[0])
      .filter(Boolean);
    const stream = game.resolve(ourJoint, theirJoint).stream;
    const at = `${where} turn ${turn}`;
    const asking = Boolean(game.view().replacement);

    for (let s = 0; s < 2; s += 1) {
      // ONE POKEMON, ONE SEAT.
      const standing = game.state.active[s].filter(Boolean);
      ok(`${at}: side ${s} has one Pokemon per seat`, new Set(standing).size === standing.length,
        standing.map((m) => nameOf(solver, m)).join(" + "));
      // `ix` IS a row's place in its side's list. Everything that moves a Pokemon reads it.
      const strayed = game.state.sides[s].filter((m, i) => m && m.ix !== i);
      ok(`${at}: side ${s} carries a true ix`, strayed.length === 0,
        strayed.map((m) => `${nameOf(solver, m)} says ix ${m.ix}`).join(", "));
      // NOBODY IS STRANDED: an empty seat with a healthy Pokemon on the bench is a game that
      // cannot be finished -- unless the player is being asked who comes in.
      const holes = game.state.active[s].filter((m) => !m || m.out || m.hp <= 0).length;
      const bench = game.state.sides[s].filter((m) => m && !m.out && m.hp > 0 && !game.state.active[s].includes(m));
      ok(`${at}: side ${s} leaves no seat empty while it has a bench`, !holes || !bench.length || asking,
        `${holes} empty, bench holds ${bench.map((m) => nameOf(solver, m)).join(", ")}`);
    }

    // NOTHING HAPPENS TO A POKEMON THE STREAM HAS SAID IS OFF THE FIELD. Walked in order, so one
    // that goes back and is sent in again later in the same turn counts as on the field again.
    const off = new Set();
    stream.forEach((step, i) => {
      if (step.kind === "switch") {
        off.add(`${step.side}:${step.outTag}`);
        off.delete(`${step.side}:${step.inTag}`);
        found.switches += 1;
        if (step.why) found.late += 1;
        return;
      }
      if (step.kind === "send") {
        off.delete(`${step.side}:${step.tag}`);
        return;
      }
      if (!["hit", "residual", "flinch", "move", "protect"].includes(step.kind)) return;
      ok(`${at}: nothing happens to a Pokemon that has gone back`, !off.has(`${step.side}:${step.tag}`),
        `${step.kind} on side ${step.side} tag ${step.tag} at step ${i}`);
    });

    // A BAIL-OUT OR A PIVOT IS AN END-OF-TURN THING, so it is said after the moves and never
    // before them. This is the whole of the reported "Golisopod went back, and out came
    // Rillaboom" followed by Golisopod taking two Rock Slides.
    const firstMove = stream.findIndex((step) => step.kind === "move");
    stream.forEach((step, i) => {
      if (step.kind !== "switch" || !step.why) return;
      found.bails += 1;
      ok(`${at}: a ${step.why} is reported after the moves`, firstMove < 0 || i > firstMove,
        `step ${i}, first move at step ${firstMove}`);
    });

    // ONE POKEMON CANNOT LEAVE ONE SEAT AND WALK INTO THE OTHER ON THE SAME CHOICE. A chosen
    // switch and an end-of-turn bail-out are different moments, so a Pokemon that went back at
    // the start and is sent in by a bail-out at the end is allowed -- it was on the bench when
    // the bail-out looked for somebody. `why` is what tells the two apart.
    const leftByChoice = new Set();
    for (const step of stream) {
      if (step.kind !== "switch" || step.why) continue;
      ok(`${at}: a chosen switch does not bring in the Pokemon the other seat is sending away`,
        !leftByChoice.has(`${step.side}:${step.inTag}`), `tag ${step.inTag} on side ${step.side}`);
      leftByChoice.add(`${step.side}:${step.outTag}`);
    }

    for (const step of stream) {
      if (step.kind === "note" && /Stamina/.test(step.text || "")) found.stamina += 1;
    }
    if (asking) break;
  }

  // A GAME THAT CANNOT BE PLAYED ON IS OVER. However it stopped, either it is finished, or the
  // player is being asked something, or both sides still have somebody on the field to move.
  if (!game.over() && !game.view().replacement) {
    for (let s = 0; s < 2; s += 1) {
      ok(`${where}: an unfinished game has side ${s} on the field`,
        game.state.active[s].some((m) => m && !m.out && m.hp > 0),
        `side ${s} has an empty field and the game is not over`);
    }
  }
  return found;
}

const totals = { bails: 0, late: 0, stamina: 0, switches: 0 };
let games = 0;
for (let seed = 1; seed <= 24; seed += 1) {
  const foe = teamFromKnown(data, FORMAT, known.teams[seed % known.teams.length]).slice(0, 4);
  const found = play(seed, REPORTED, foe, `reported team, seed ${seed}`);
  for (const key of Object.keys(totals)) totals[key] += found[key];
  games += 1;
}
for (let seed = 101; seed <= 112; seed += 1) {
  const ours = teamFromKnown(data, FORMAT, known.teams[seed % known.teams.length]).slice(0, 4);
  const theirs = teamFromKnown(data, FORMAT, known.teams[(seed * 7) % known.teams.length]).slice(0, 4);
  const found = play(seed, ours, theirs, `known teams, seed ${seed}`);
  for (const key of Object.keys(totals)) totals[key] += found[key];
  games += 1;
}

// THE CHECKS ABOVE MUST HAVE HAD SOMETHING TO BITE ON. Every one of them passes on a board where
// nobody switches, nobody bails out and nothing holds Stamina, so without these four the suite
// could go green having proved nothing -- which is how a data change quietly retires a test.
ok("the games actually contained switches", totals.switches > 0, String(totals.switches));
ok("the games actually contained a bail-out or a pivot", totals.bails > 0, String(totals.bails));
ok("every late switch carried the reason that places it", totals.late === totals.bails,
  `${totals.late} carried a reason, ${totals.bails} were late`);
ok("Stamina said so at least once", totals.stamina > 0, String(totals.stamina));

console.log(`  ${games} games: ${totals.switches} switches, ${totals.bails} of them bail-outs or pivots, `
  + `${totals.stamina} Stamina lines.`);
if (failures.length) {
  console.error(`\nFAIL  ${failures.length} of ${checked}`);
  for (const line of failures.slice(0, 25)) console.error(`  - ${line}`);
  if (failures.length > 25) console.error(`  ...and ${failures.length - 25} more`);
  process.exit(1);
}
console.log(`${checked} checked, 0 failed.`);
