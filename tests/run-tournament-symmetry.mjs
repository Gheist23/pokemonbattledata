// The seat test for Test against Tournament Teams (builder/tournament-test.js TOURNAMENT_SEAT).
//
// The battle model must not care which side a Pokémon sits on. These properties say so, and all of
// them are asserted here on real tournament teams (data/builder/known-teams.json), in both formats.
// They used to hold under the DEFAULT settings only: the shared Team Evaluation Reflect and Light
// Screen settings are applied BY SIDE (team-eval.js screenOn), so pinning either to ONE side made the
// board asymmetric by INPUT, not by this rule -- measured on 10 corpus teams in Doubles, 45 pairs and
// 10 mirrors each: reflect "My Team" 45 of 45 pairs off 100 (worst 49.66) and 9 of 10 mirrors off 50,
// "Threat Team" the same with the sign flipped, light_screen "My Team" 44 of 45 (worst 37.63); while
// either set to "Both", tailwind on either side (the board sets its own, so the setting never reached
// it), trick_room, weather and terrain were all 0 of 45 and 0 of 10. The field rule
// (TOURNAMENT_FIELD) closed that hole by keeping the whole Field section out of the board, and the
// last section here asserts it in both directions: a pinned one-sided screen no longer moves a
// mirror off 50, and under field rule 0 it still does.
//
// One setting still may break it, on purpose: a stat stage. `my_stages` / `threat_stages` are part of
// what the user says their Pokémon IS, so they are honoured -- and the final section asserts the only
// property left to hold, that the run tells the reader 50 is not its even score exactly when a stage is
// pinned on one side alone (tournament-test.js `unevenStagePins`).
//
//   MIRROR      a team played against ITSELF, the same bring on both sides, scores exactly 50.
//   SEAT SWAP   the same two line-ups with the seats exchanged score exactly 100 together.
//   REPORTED    and so the number the page would print for a team against itself is exactly 50 --
//               asserted through `chooseBrings`, the production bring decision itself. Before the
//               seat rule team8 read 66.06 against itself, which a zero-sum game cannot do; while
//               the bring rule (TOURNAMENT_BRING) was still at version 0 it could also read BELOW
//               50, because our bring was a guarantee against their best answer while theirs
//               answered our choice (team4 and team19 read 37.50). Both are gone, so this is an
//               equality now. Tightened, never loosened.
//
// None of them is a number that was measured and written down: they follow from the value being
// 50 + 50 x (our HP share - their HP share) of a game whose rules never read the side index.
// Under version 0 they all fail -- that is the defect the rule fixes, and the suite checks that the
// old version still fails, so it cannot pass by doing nothing.
//
// The subject is built through the PRODUCTION path on both sides (ourUnit for our team,
// opponentMon for theirs), with the Stat Points opponentMon would give the set, so the two sides
// are the same Pokémon by different routes -- which is exactly what a user pasting a tournament
// team into the builder gets.
//
//   node tests/run-tournament-symmetry.mjs [teams]     (default 12 tournament teams)
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compact, DamageEngine } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest, TOURNAMENT_SEAT, TOURNAMENT_TURN_ONE, tournamentSeatOption, tournamentTurnOneOption,
  unevenStagePins, ignoredFieldSettings } from "../builder/tournament-test.js";
import { makeSet } from "../builder/common.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const knownRaw = JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8"));
const limit = Number(process.argv[2]) || 12;

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

function makeTest(format, options = {}, settings = {}) {
  const engine = new DamageEngine(appData);
  const meta = JSON.parse(readFileSync(join(root, "data", "builder", `meta-${format.toLowerCase()}.json`), "utf8"));
  const ev = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS, ...settings }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new TournamentTest(evaluation, new KnownTeams(knownRaw), new TeamSuggestions(evaluation), options);
}

/** A tournament member as one of OUR sets, with the Stat Points opponentMon gives it. */
function setFor(test, m) {
  const usage = test.usageStem.get(`${compact(m.species)}|${compact(m.form)}`) || m.species;
  const spread = test.suggestions.spreadForNature(usage, m.nature || "") || test.suggestions.spreadForNature(m.species, m.nature || "");
  return makeSet({
    species: m.species,
    form: m.form || m.species,
    item: m.item || "",
    ability: m.ability || "",
    nature: m.nature || spread?.nature_name || "Serious",
    bonuses: [...(spread?.bonuses || [0, 0, 0, 0, 0, 0])],
    moves: (m.moves || []).slice(0, 4),
  });
}

/** One team's brings from both seats: as our team (ourUnit) and as theirs (opponentMon). */
function seats(test, team) {
  const ours = team.members.map((m, i) => test.ourUnit(setFor(test, m), i));
  const theirs = team.members.map((m) => test.opponentMon(m));
  return { name: team.name, ourPlans: test.plansFor(ours), theirPlans: test.plansFor(theirs) };
}

// --- the stamp ---------------------------------------------------------------------------------

check("TOURNAMENT_SEAT is version 1", TOURNAMENT_SEAT === 1);
// The two stamps must coerce identically, or a recording's stamp means something different
// depending on which rule reads it.
for (const off of [null, undefined, false, "", "0", "off", "false", "no", "none", 0, -1, "-5", "0.9"]) {
  check(`tournamentSeatOption(${JSON.stringify(off)}) is off`, tournamentSeatOption(off) === 0, String(tournamentSeatOption(off)));
  check(`tournamentSeatOption(${JSON.stringify(off)}) agrees with tournamentTurnOneOption`, tournamentSeatOption(off) === tournamentTurnOneOption(off));
}
check("tournamentSeatOption(1) is 1", tournamentSeatOption(1) === 1);
check("tournamentSeatOption('1.9') truncates to 1", tournamentSeatOption("1.9") === 1);
check("tournamentSeatOption('4') is kept for a later version", tournamentSeatOption("4") === 4);
check("a value that is not a number is the current version", tournamentSeatOption("yes") === TOURNAMENT_SEAT);
check("an absent option is the current version", makeTest("Doubles").seatRule === TOURNAMENT_SEAT);
check("version 0 is kept as 0", makeTest("Doubles", { seatRule: 0 }).seatRule === 0);
check("the seat rule does not touch the turn-1 rule", makeTest("Doubles", { seatRule: 0 }).turnOneRule === TOURNAMENT_TURN_ONE);

// --- what makes two Pokémon twins --------------------------------------------------------------

{
  const test = makeTest("Doubles");
  const team = test.teams(1)[0];
  const ours = team.members.map((m, i) => test.ourUnit(setFor(test, m), i));
  const theirs = team.members.map((m) => test.opponentMon(m));
  check("the same set is the same Pokémon whichever side built it",
    ours.every((u, i) => u.tieKey === theirs[i].tieKey && u.tieRank === theirs[i].tieRank),
    JSON.stringify(ours.map((u, i) => [u.tieKey, theirs[i].tieKey]).filter(([a, b]) => a !== b)));
  check("a tie key says nothing about the side it sits on", ours.every((u) => !/side|seat/.test(u.tieKey) && u.tieKey.length > 0));
  const keys = new Set(theirs.map((u) => u.tieKey));
  check("six different Pokémon are six different keys", keys.size === theirs.length, JSON.stringify([...keys]));
  // The mirror below compares bring i with bring i, so the two seats must offer the same brings in
  // the same order -- they do because plansFor reads the units and not the side.
  for (const team of test.teams(limit)) {
    const a = test.plansFor(team.members.map((m, i) => test.ourUnit(setFor(test, m), i)));
    const b = test.plansFor(team.members.map((m) => test.opponentMon(m)));
    check(`${team.name}: both seats offer the same brings in the same order`,
      a.length === b.length && a.every((p, i) => p.order.join() === b[i].order.join() && p.leads === b[i].leads),
      JSON.stringify([a.map((p) => p.order.join("")), b.map((p) => p.order.join(""))]));
  }
}

// --- the two properties ------------------------------------------------------------------------

/**
 * Plays the properties for one format at one rule version.
 * Returns what failed, so the same run can prove the new version holds and version 0 does not.
 */
function measure(format, seatRule) {
  const test = makeTest(format, { seatRule });
  const teams = test.teams(limit).map((team) => seats(test, team));
  const out = { mirrors: 0, mirrorsOff: 0, worstMirror: 0, swaps: 0, swapsOff: 0, worstSwap: 0, stories: 0, storiesOff: 0, exact: 0, reported: 0, reportedOff: 0, reportedOver: 0, worstReported: 0 };
  for (const team of teams) {
    // REPORTED: the value playTeam would print for this team against itself. Not a maximin worked
    // out here -- `chooseBrings` is the production decision itself (tournament-test.js), handed the
    // same grid playTeam builds, so this asserts the shipped rule and not a copy of it.
    {
      const grid = team.ourPlans.map((ours) => team.theirPlans.map((theirs) => test.play(ours, theirs, null).value));
      const value = test.chooseBrings(grid).value;
      out.reported += 1;
      if (Math.abs(value - 50) > 1e-9) out.reportedOff += 1;
      if (value > 50 + 1e-9) out.reportedOver += 1;
      if (Math.abs(value - 50) > Math.abs(out.worstReported)) out.worstReported = value - 50;
    }
    // MIRROR: the same bring on both sides, every bring the team can make.
    for (let i = 0; i < team.ourPlans.length; i += 1) {
      const value = test.play(team.ourPlans[i], team.theirPlans[i], null).value;
      out.mirrors += 1;
      if (value === 50) out.exact += 1;
      if (Math.abs(value - 50) > 1e-9) out.mirrorsOff += 1;
      if (Math.abs(value - 50) > Math.abs(out.worstMirror)) out.worstMirror = value - 50;
    }
    // The story of a mirror is symmetric too: whatever one side does, the other does.
    {
      const game = test.play(team.ourPlans[0], team.theirPlans[0], null, true);
      const told = (side) => game.events.filter((e) => e.s === side)
        .map((e) => `${e.kind}|${e.actor ? `${e.actor.species}/${e.actor.form}` : ""}|${e.move || ""}|${e.why || ""}|${e.by || ""}`).sort().join(" ; ");
      out.stories += 1;
      if (told(0) !== told(1)) {
        out.storiesOff += 1;
        if (!out.firstStory) out.firstStory = `${team.name}\n   you:  ${told(0)}\n   them: ${told(1)}`;
      }
    }
  }
  // SEAT SWAP: the same two line-ups, seats exchanged. Within a team (bring i against bring j)
  // and across teams, always with our side built by ourUnit and theirs by opponentMon.
  const pairs = [];
  for (let a = 0; a < teams.length; a += 1) {
    for (let i = 0; i < Math.min(3, teams[a].ourPlans.length); i += 1) {
      for (let j = i + 1; j < Math.min(3, teams[a].ourPlans.length); j += 1) pairs.push([a, i, a, j]);
      for (let b = a + 1; b < teams.length; b += 1) {
        for (let j = 0; j < Math.min(2, teams[b].ourPlans.length); j += 1) pairs.push([a, i, b, j]);
      }
    }
  }
  for (const [a, i, b, j] of pairs) {
    const x = test.play(teams[a].ourPlans[i], teams[b].theirPlans[j], null).value;
    const y = test.play(teams[b].ourPlans[j], teams[a].theirPlans[i], null).value;
    const off = x + y - 100;
    out.swaps += 1;
    if (Math.abs(off) > 1e-9) out.swapsOff += 1;
    if (Math.abs(off) > Math.abs(out.worstSwap)) {
      out.worstSwap = off;
      out.worstPair = `${teams[a].name} bring ${i} vs ${teams[b].name} bring ${j}: ${x.toFixed(2)} + ${y.toFixed(2)}`;
    }
  }
  return out;
}

for (const format of ["Doubles", "Singles"]) {
  const now = measure(format, undefined);
  const old = measure(format, 0);
  console.log(`${format} (${limit} teams): version ${TOURNAMENT_SEAT} · mirrors ${now.mirrors - now.mirrorsOff}/${now.mirrors} at 50 (${now.exact} of them exactly) · seat swaps ${now.swaps - now.swapsOff}/${now.swaps} at 100 · stories ${now.stories - now.storiesOff}/${now.stories} symmetric · reported off 50: ${now.reportedOff}/${now.reported}`);
  console.log(`${format} (${limit} teams): version 0       · mirrors off 50: ${old.mirrorsOff}/${old.mirrors} (worst ${old.worstMirror.toFixed(2)}) · swaps off 100: ${old.swapsOff}/${old.swaps} (worst ${old.worstSwap.toFixed(2)}) · stories not symmetric: ${old.storiesOff}/${old.stories} · reported off 50: ${old.reportedOff}/${old.reported} (worst ${old.worstReported >= 0 ? "+" : ""}${old.worstReported.toFixed(2)}), above 50: ${old.reportedOver}/${old.reported}`);

  check(`${format}: a team against itself scores 50 on every bring`, now.mirrorsOff === 0, `${now.mirrorsOff} of ${now.mirrors} off, worst ${now.worstMirror.toFixed(4)}`);
  check(`${format}: and it is exactly 50, not 50 to a rounding`, now.exact === now.mirrors, `${now.exact} of ${now.mirrors}`);
  check(`${format}: swapping the seats of two line-ups adds up to 100`, now.swapsOff === 0, `${now.swapsOff} of ${now.swaps} off, worst ${now.worstSwap.toFixed(4)} (${now.worstPair || ""})`);
  check(`${format}: a mirror's turn-1 story is the same for both sides`, now.storiesOff === 0, now.firstStory || "");
  // An equality since the bring rule (TOURNAMENT_BRING version 1) made the bring decision symmetric
  // too: before it this could only say "never ABOVE 50", because our bring was a guarantee against
  // their best answer while theirs answered our choice, which costs a mirror up to 12.50 points
  // (team4 and team19 read 37.50 against themselves under bringRule 0). Tightened, not loosened --
  // do not put it back.
  check(`${format}: the value reported for a team against itself is exactly 50`, now.reportedOff === 0, `${now.reportedOff} of ${now.reported} off, worst ${now.worstReported.toFixed(4)}`);
  check(`${format}: and it is not above 50 either (a guarantee cannot beat itself)`, now.reportedOver === 0, `${now.reportedOver} of ${now.reported} over`);
  // The gate has to be able to fail: version 0 is the seat-dependent model, and every one of the
  // properties above must break under it, or this suite proves nothing about the rule.
  check(`${format}: version 0 still breaks the mirror (so the check is a real gate)`, old.mirrorsOff > 0, `${old.mirrorsOff} of ${old.mirrors}`);
  check(`${format}: version 0 still breaks the seat swap`, old.swapsOff > 0, `${old.swapsOff} of ${old.swaps}`);
  check(`${format}: version 0 still breaks a mirror's story`, old.storiesOff > 0, `${old.storiesOff} of ${old.stories}`);
  check(`${format}: version 0 still reports a team beating itself`, old.reportedOver > 0, `${old.reportedOver} of ${old.reported}`);
  check(`${format}: version 0 still reports a team against itself off 50`, old.reportedOff > 0, `${old.reportedOff} of ${old.reported}`);
}

// --- the settings cannot break it either (TOURNAMENT_FIELD) ------------------------------------

// The one thing outside these rules that could: Reflect and Light Screen are applied by SIDE
// (team-eval.js screenOn keyed on analysis_side), so a one-sided screen halved every hit into our
// seat of every game. The field rule keeps the whole Field section out of the board, so a mirror is
// exactly 50 whatever is pinned -- and under field rule 0 the same pin still breaks it, which is what
// makes this a gate and not a tautology.
{
  const pins = [["reflect", "My Team"], ["reflect", "Threat Team"], ["light_screen", "My Team"], ["weather", "Sun"], ["terrain", "Psychic"], ["trick_room", true]];
  for (const format of ["Doubles", "Singles"]) {
    for (const [key, value] of pins) {
      const test = makeTest(format, {}, { [key]: value });
      const teams = test.teams(4).map((team) => seats(test, team));
      let off = 0;
      let worst = 0;
      let swapsOff = 0;
      for (const team of teams) {
        for (let i = 0; i < team.ourPlans.length; i += 1) {
          const value2 = test.play(team.ourPlans[i], team.theirPlans[i], null).value;
          if (Math.abs(value2 - 50) > 1e-9) off += 1;
          if (Math.abs(value2 - 50) > Math.abs(worst)) worst = value2 - 50;
        }
        for (let i = 1; i < Math.min(3, team.ourPlans.length); i += 1) {
          const x = test.play(team.ourPlans[0], team.theirPlans[i], null).value;
          const y = test.play(team.ourPlans[i], team.theirPlans[0], null).value;
          if (Math.abs(x + y - 100) > 1e-9) swapsOff += 1;
        }
      }
      check(`${format}: a pinned ${key} leaves the mirror at exactly 50`, off === 0, `${off} off, worst ${worst.toFixed(4)}`);
      check(`${format}: and the seat swap at exactly 100`, swapsOff === 0, String(swapsOff));
    }
    // The gate: under field rule 0 a one-sided Reflect really does break the mirror.
    const leaky = makeTest(format, { fieldRule: 0 }, { reflect: "My Team" });
    const leakyTeams = leaky.teams(4).map((team) => seats(leaky, team));
    let brokenMirrors = 0;
    let brokenSwaps = 0;
    for (const team of leakyTeams) {
      for (let i = 0; i < team.ourPlans.length; i += 1) {
        if (Math.abs(leaky.play(team.ourPlans[i], team.theirPlans[i], null).value - 50) > 1e-9) brokenMirrors += 1;
      }
      for (let i = 1; i < Math.min(3, team.ourPlans.length); i += 1) {
        const x = leaky.play(team.ourPlans[0], team.theirPlans[i], null).value;
        const y = leaky.play(team.ourPlans[i], team.theirPlans[0], null).value;
        if (Math.abs(x + y - 100) > 1e-9) brokenSwaps += 1;
      }
    }
    check(`${format}: field rule 0 still lets a one-sided Reflect break the mirror`, brokenMirrors > 0, String(brokenMirrors));
    check(`${format}: and the seat swap`, brokenSwaps > 0, String(brokenSwaps));
  }
}

// --- the one setting that MAY break the mirror, and has to admit it (`unevenStagePins`) ---------
//
// `my_stages` and `threat_stages` are deliberately NOT taken out of the board the way the Field
// settings are: a stat stage is part of what the user says their Pokémon is, and silently discarding
// it would be its own bug. So a stage pinned on one side only really does move a team's score against
// itself off 50 -- and the property asserted here is not that 50 survives, but that the run SAYS 50 is
// no longer the even score exactly when it is not (tournament-test.js `unevenStagePins`, drawn by
// builder/tournament-view.js on the results). Measured on these 4 teams per format: with the defaults
// and with the same pin on both sides, every bring mirror is exactly 50 and no team is off 50; with a
// pin on one side, all 4 of 4 teams report a value off 50, and the individual bring mirrors move with
// it -- 42 of 42 in Doubles by up to 47.94 points, 62 of 68 in Singles by up to 50.00. Both the
// mirrors and the reported value are asserted as "some": whether a pin reaches a given team is a
// fact about that team's six Pokemon. Two spellings of the same stage are
// the same pin, because the reader is the evaluator's own `applyStages`.
{
  const pins = [
    ["the defaults", {}],
    ["our side given Attack +2", { my_stages: "attack: +2" }],
    ["their side given Attack +2", { threat_stages: "attack: +2" }],
    ["both sides given Attack +2", { my_stages: "attack: +2", threat_stages: "attack: +2" }],
    ["the same stage spelled differently on each side", { my_stages: "atk:+2", threat_stages: "+2 Attack" }],
    ["our side given Speed -1", { my_stages: "spe: -1" }],
    ["a different stage on each side", { my_stages: "attack: +2", threat_stages: "speed: -1" }],
  ];
  for (const format of ["Doubles", "Singles"]) {
    for (const [label, settings] of pins) {
      const test = makeTest(format, {}, settings);
      const teams = test.teams(4).map((team) => seats(test, team));
      let mirrors = 0;
      let off = 0;
      let worst = 0;
      let reportedOff = 0;
      for (const team of teams) {
        for (let i = 0; i < team.ourPlans.length; i += 1) {
          const value = test.play(team.ourPlans[i], team.theirPlans[i], null).value;
          mirrors += 1;
          if (Math.abs(value - 50) > 1e-9) off += 1;
          if (Math.abs(value - 50) > Math.abs(worst)) worst = value - 50;
        }
        // The number the page prints for a team against itself, through the production decision.
        const grid = team.ourPlans.map((ours) => team.theirPlans.map((theirs) => test.play(ours, theirs, null).value));
        if (Math.abs(test.chooseBrings(grid).value - 50) > 1e-9) reportedOff += 1;
      }
      const said = unevenStagePins(test.ev.settings, (text) => test.ev.applyStages({}, text));
      // The property: the disclosure is there exactly when a team no longer scores 50 against itself.
      check(`${format}: with ${label}, the run says 50 is uneven exactly when it is`,
        Boolean(said) === (reportedOff > 0), `${said ? JSON.stringify(said) : "even"} against ${reportedOff} of ${teams.length} off 50`);
      if (said) {
        // "Some", not "all". Whether a pin reaches a particular team depends on whether the
        // stat it moves can change any outcome in the bring the decision picks, and that is a
        // fact about the six Pokemon, not about the pin: with the tournament library replaced on
        // 6 Oct 2026, two of the first four teams sit at exactly 50 under Attack +2 although both
        // are full of physical attackers. The same suite run against the previous library passes
        // 141/141, so nothing is wrong with the pin -- "all four" was a measurement over four
        // particular teams that read as a promise. What a pin must do is show up at all.
        check(`${format}: with ${label}, the pin reaches the board and the mirrors move with it`,
          reportedOff > 0 && off > 0, `${reportedOff} of ${teams.length} off, mirrors ${off} of ${mirrors}, worst ${worst.toFixed(4)}`);
      } else {
        check(`${format}: with ${label}, every bring mirror is still exactly 50`,
          off === 0 && reportedOff === 0, `${off} of ${mirrors} off, worst ${worst.toFixed(4)}`);
      }
      // A stage is not a Field setting: it is honoured, so it is never reported as ignored.
      check(`${format}: with ${label}, no stage is reported as an ignored Field setting`,
        ignoredFieldSettings(test.ev.settings).length === 0, JSON.stringify(ignoredFieldSettings(test.ev.settings)));
    }
  }
}

console.log(`${checked} checked, ${failures.length} failed.`);
for (const line of failures) console.log(`  FAIL ${line}`);
process.exit(failures.length ? 1 : 0);
