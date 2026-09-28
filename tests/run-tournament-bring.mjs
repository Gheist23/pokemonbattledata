// The bring test for Test against Tournament Teams (builder/tournament-test.js TOURNAMENT_BRING).
//
// Under the shipped rule before this one, OUR bring was the one whose worst answer is best while
// THEIR bring was the answer that hurts our choice most -- a best response to a commitment they can
// see. Since max-min <= min-max the number reported was below even: measured on a round robin of the
// first 20 tournament teams (380 ordered pairs, Doubles, default settings) the reported average was
// 45.17 while the average over every bring pair -- the value with no decision in it -- is exactly
// 50.0000, and 170 of the 190 unordered pairs did not add up to 100 (mean 10.80, max 31.55). Version
// 1 gives their bring our own rule, chosen blind, and the same round robin reports exactly 50.00
// with all 190 pairs adding up to 100.
//
// What is asserted here:
//   STAMP        `tournamentBringOption` coerces exactly as the other two stamps do, and the option
//                selects behaviour BY VERSION, so a recording made before the rule still replays.
//   THE RULE     `chooseBrings` is the decision itself, so it is asserted directly: on hand-made
//                grids that pin both sides' picks and every step of both tie-breaks, and on random
//                grids for the property the tie-break exists for -- transposing a grid and
//                reflecting it through 100 (which is what swapping the seats does) must swap the two
//                picks and make the two values add up to 100.
//   THE TEAMS    on real tournament teams: A against B plus B against A is exactly 100, and a team
//                against itself reports exactly 50.
//   IT IS FREE   the same run plays the same number of games under both versions, and picks the same
//                bring for us -- only their bring, and so the game the matchup is scored in, changes.
//   THE CARD     `bestBrings[].value` is now the game each bring plays against the bring they commit
//                to, which is what the page says it is, and it is never the per-team worst case again.
// Every one of them is also run under version 0, which must FAIL it -- or the check proves nothing.
//
//   node tests/run-tournament-bring.mjs [teams]     (default 10 tournament teams)
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
import { TournamentTest, TOURNAMENT_BRING, TOURNAMENT_SEAT, TOURNAMENT_TURN_ONE, tournamentBringOption, tournamentSeatOption, tournamentTurnOneOption } from "../builder/tournament-test.js";
import { makeSet } from "../builder/common.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const knownRaw = JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8"));
const limit = Number(process.argv[2]) || 10;

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

function makeTest(format, options = {}) {
  const engine = new DamageEngine(appData);
  const meta = JSON.parse(readFileSync(join(root, "data", "builder", `meta-${format.toLowerCase()}.json`), "utf8"));
  const ev = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }));
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

// --- the stamp ---------------------------------------------------------------------------------

check("TOURNAMENT_BRING is version 1", TOURNAMENT_BRING === 1);
// An ABSENT stamp on a recording means "made before the rule", so it must resolve to 0 -- the same
// way for all three stamps, or one recording's stamp means different things to different rules.
for (const off of [null, undefined, false, "", "0", "off", "false", "no", "none", 0, -1, "-5", "0.9"]) {
  check(`tournamentBringOption(${JSON.stringify(off)}) is off`, tournamentBringOption(off) === 0, String(tournamentBringOption(off)));
  check(`tournamentBringOption(${JSON.stringify(off)}) agrees with the other two stamps`,
    tournamentBringOption(off) === tournamentTurnOneOption(off) && tournamentBringOption(off) === tournamentSeatOption(off));
}
check("tournamentBringOption(1) is 1", tournamentBringOption(1) === 1);
check("tournamentBringOption('1.9') truncates to 1", tournamentBringOption("1.9") === 1);
check("tournamentBringOption('4') is kept for a later version", tournamentBringOption("4") === 4);
check("a value that is not a number is the current version", tournamentBringOption("yes") === TOURNAMENT_BRING);
check("an absent option is the current version", makeTest("Doubles").bringRule === TOURNAMENT_BRING);
check("version 0 is kept as 0", makeTest("Doubles", { bringRule: 0 }).bringRule === 0);
check("the bring rule does not touch the other two rules",
  makeTest("Doubles", { bringRule: 0 }).seatRule === TOURNAMENT_SEAT && makeTest("Doubles", { bringRule: 0 }).turnOneRule === TOURNAMENT_TURN_ONE);
check("the seat rule does not touch the bring rule", makeTest("Doubles", { seatRule: 0 }).bringRule === TOURNAMENT_BRING);

// --- the rule, on grids that say exactly what it must do ---------------------------------------

const now = makeTest("Doubles");
const old = makeTest("Doubles", { bringRule: 0 });

{
  // Ours is the row whose lowest value is highest; theirs, under version 1, the column whose
  // highest value is lowest. Here those are different columns, so the two versions must differ.
  const grid = [[100, 50, 0], [30, 60, 70]];
  const a = now.chooseBrings(grid);
  const b = old.chooseBrings(grid);
  check("version 1: our bring is the row whose worst answer is best", a.c === 1, JSON.stringify(a));
  check("version 1: their bring is the column whose best case for us is worst", a.d === 1 && a.value === 60, JSON.stringify(a));
  check("version 0: their bring is the answer to ours", b.c === 1 && b.d === 0 && b.value === 30, JSON.stringify(b));
  check("version 0 is never the kinder of the two", b.value <= a.value + 1e-9, `${b.value} vs ${a.value}`);
  check("version 1's totals are the games played against the bring they commit to", JSON.stringify(a.totals) === JSON.stringify([50, 60]), JSON.stringify(a.totals));
  check("version 0's totals are each bring's own worst case", JSON.stringify(b.totals) === JSON.stringify([0, 30]), JSON.stringify(b.totals));
}
{
  // Our tie-break: the same worst case, so the better average, then the lower line-up.
  check("our tie goes to the better average over their brings", now.chooseBrings([[40, 60], [40, 80]]).c === 1);
  check("our tie then goes to the lower line-up", now.chooseBrings([[40, 60], [40, 60]]).c === 0);
  // Theirs is the mirror: the same best case for us, so OUR lower average, then their lower line-up.
  const mean = now.chooseBrings([[50, 50], [20, 40]]);
  check("their tie goes to the average that is better for them", mean.d === 0, JSON.stringify(mean));
  check("their tie then goes to their lower line-up", now.chooseBrings([[50, 50], [20, 20]]).d === 0);
}
{
  // The property the tie-break exists for. Swapping the seats transposes the grid and reflects it
  // through 100 (the seat rule, TOURNAMENT_SEAT, is what makes that true of the games themselves),
  // so the two picks must swap and the two values must add up to 100. Random grids, in halves so
  // 100 - v is exact, with a fixed seed so a failure can be reproduced.
  let seed = 20260928;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const swap = (grid) => grid[0].map((_, d) => grid.map((row) => 100 - row[d]));
  let bad = 0; let badOld = 0; let first = "";
  for (let n = 0; n < 400; n += 1) {
    const rows = 1 + Math.floor(rnd() * 6);
    const cols = 1 + Math.floor(rnd() * 6);
    // Deliberately coarse values, so exact ties happen often and the tie-break is what is tested.
    const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => Math.round(rnd() * 8) * 12.5));
    for (const [test, count] of [[now, () => { bad += 1; }], [old, () => { badOld += 1; }]]) {
      const a = test.chooseBrings(grid);
      const b = test.chooseBrings(swap(grid));
      const ok = a.c === b.d && a.d === b.c && Math.abs(a.value + b.value - 100) < 1e-9;
      if (!ok) {
        count();
        if (test === now && !first) first = `${JSON.stringify(grid)} -> ours ${JSON.stringify([a.c, a.d, a.value])} theirs ${JSON.stringify([b.c, b.d, b.value])}`;
      }
    }
  }
  check("version 1: swapping the seats swaps the two picks and the two values add up to 100", bad === 0, `${bad} of 400 grids${first ? ` · first ${first}` : ""}`);
  check("version 0 does not (so the check is a real gate)", badOld > 0, `${badOld} of 400 grids`);
}

// --- the rule, on real tournament teams ---------------------------------------------------------

/** Every bring of team A (as ours) against every bring of team B (as theirs). */
function grid(test, a, b) {
  return a.ourPlans.map((ours) => b.theirPlans.map((theirs) => test.play(ours, theirs, null).value));
}

function seats(test, team) {
  return {
    name: team.name,
    ourPlans: test.plansFor(team.members.map((m, i) => test.ourUnit(setFor(test, m), i))),
    theirPlans: test.plansFor(team.members.map((m) => test.opponentMon(m))),
  };
}

for (const format of ["Doubles", "Singles"]) {
  const test = makeTest(format);
  const before = makeTest(format, { bringRule: 0 });
  const teams = test.teams(limit).map((team) => seats(test, team));
  const out = { pairs: 0, off: 0, worst: 0, worstPair: "", mirrors: 0, mirrorsOff: 0, worstMirror: 0 };
  const was = { off: 0, worst: 0, mirrorsOff: 0, worstMirror: 0, lower: 0 };
  for (const team of teams) {
    const g = grid(test, team, team);
    const value = test.chooseBrings(g).value;
    const oldValue = before.chooseBrings(g).value;
    out.mirrors += 1;
    if (Math.abs(value - 50) > 1e-9) out.mirrorsOff += 1;
    if (Math.abs(value - 50) > Math.abs(out.worstMirror)) out.worstMirror = value - 50;
    if (Math.abs(oldValue - 50) > 1e-9) was.mirrorsOff += 1;
    if (Math.abs(oldValue - 50) > Math.abs(was.worstMirror)) was.worstMirror = oldValue - 50;
    if (oldValue + 1e-9 < value) was.lower += 1;
  }
  for (let i = 0; i < teams.length; i += 1) {
    for (let j = i + 1; j < teams.length; j += 1) {
      const ab = grid(test, teams[i], teams[j]);
      const ba = grid(test, teams[j], teams[i]);
      const sum = test.chooseBrings(ab).value + test.chooseBrings(ba).value - 100;
      const oldSum = before.chooseBrings(ab).value + before.chooseBrings(ba).value - 100;
      out.pairs += 1;
      if (Math.abs(sum) > 1e-9) {
        out.off += 1;
        if (Math.abs(sum) > Math.abs(out.worst)) {
          out.worst = sum;
          out.worstPair = `${teams[i].name} vs ${teams[j].name}`;
        }
      }
      if (Math.abs(oldSum) > 1e-9) {
        was.off += 1;
        if (Math.abs(oldSum) > Math.abs(was.worst)) was.worst = oldSum;
      }
    }
  }
  console.log(`${format} (${limit} teams): version ${TOURNAMENT_BRING} · A+B at 100: ${out.pairs - out.off}/${out.pairs} · mirrors at 50: ${out.mirrors - out.mirrorsOff}/${out.mirrors}`);
  console.log(`${format} (${limit} teams): version 0       · A+B off 100: ${was.off}/${out.pairs} (worst ${was.worst.toFixed(2)}) · mirrors off 50: ${was.mirrorsOff}/${out.mirrors} (worst ${was.worstMirror.toFixed(2)}) · version 0 reads lower on ${was.lower}/${out.mirrors} mirrors`);
  check(`${format}: A against B plus B against A is exactly 100`, out.off === 0, `${out.off} of ${out.pairs} off, worst ${out.worst.toFixed(4)} (${out.worstPair})`);
  check(`${format}: a team against itself reports exactly 50`, out.mirrorsOff === 0, `${out.mirrorsOff} of ${out.mirrors} off, worst ${out.worstMirror.toFixed(4)}`);
  check(`${format}: version 0 still breaks the sum (so the check is a real gate)`, was.off > 0, `${was.off} of ${out.pairs}`);
  check(`${format}: version 0 still reports a mirror away from 50`, was.mirrorsOff > 0, `${was.mirrorsOff} of ${out.mirrors}`);
  // And it is pessimism, not noise: every mirror version 0 gets wrong, it gets wrong DOWNWARDS.
  check(`${format}: version 0 is the pessimistic one, never the kinder`, was.lower === was.mirrorsOff && was.mirrorsOff > 0, `lower on ${was.lower}, off on ${was.mirrorsOff}`);
}

// --- what it costs, and the card, through a real run -------------------------------------------

const BENCH = [
  { species: "Charizard", form: "Mega Charizard Y", item: "Charizardite Y", ability: "Drought", nature: "Modest", moves: ["Heat Wave", "Weather Ball", "Solar Beam", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
  { species: "Incineroar", item: "Sitrus Berry", ability: "Intimidate", nature: "Careful", moves: ["Fake Out", "Parting Shot", "Flare Blitz", "Knock Off"], bonuses: [32, 0, 2, 0, 32, 0] },
  { species: "Garchomp", item: "Life Orb", ability: "Rough Skin", nature: "Jolly", moves: ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
  { species: "Whimsicott", item: "Focus Sash", ability: "Prankster", nature: "Timid", moves: ["Tailwind", "Moonblast", "Encore", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
  { species: "Gholdengo", item: "Choice Specs", ability: "Good as Gold", nature: "Modest", moves: ["Make It Rain", "Shadow Ball", "Power Gem", "Trick"], bonuses: [2, 0, 0, 32, 0, 32] },
];

{
  const teams = 40;
  const sets = BENCH.map((set) => makeSet(set));
  const a = await makeTest("Doubles", { bringRule: 0 }).run(sets, { limit: teams });
  const b = await makeTest("Doubles").run(sets, { limit: teams });
  console.log(`Doubles run (${teams} teams): version 0 headline ${a.average.toFixed(2)}, card ${a.bestBrings[0].value.toFixed(2)} · version ${TOURNAMENT_BRING} headline ${b.average.toFixed(2)}, card ${b.bestBrings[0].value.toFixed(2)} · games ${a.games} / ${b.games}`);
  check("the rule costs no games: the same run plays the same number under both versions", a.games === b.games, `${a.games} vs ${b.games}`);
  // Our own bring is untouched: the same line-ups are the best choice against the same share of
  // teams. Keyed on the line-up, not the order, because the options are sorted by their score too.
  const rate = (s) => JSON.stringify(s.bestBrings.map((x) => `${x.members.map((m) => m.slot).join(",")}@${x.bestRate}`).sort());
  check("our recommended bring does not change: only their answer does", rate(a) === rate(b), `${rate(a)} vs ${rate(b)}`);
  check("the headline cannot fall: their blind bring is never a better answer than their best one", b.average >= a.average - 1e-9, `${a.average} vs ${b.average}`);
  check("the headline does rise on a real team (or the rule would be doing nothing)", b.average > a.average + 0.1, `${a.average} -> ${b.average}`);
  // The card. Version 1's number is the game each bring plays against the bring they commit to, so
  // it can only be at or above the per-team worst case version 0 averaged.
  check("every bring option's score rises or holds", b.bestBrings.every((x, i) => x.value >= a.bestBrings[i].value - 1e-9),
    JSON.stringify([a.bestBrings.map((x) => x.value), b.bestBrings.map((x) => x.value)]));
  check("and at least one rises, so the card is no longer the per-team worst case",
    b.bestBrings.some((x, i) => x.value > a.bestBrings[i].value + 0.1), JSON.stringify([a.bestBrings.map((x) => x.value), b.bestBrings.map((x) => x.value)]));
  check("a bring option's score is a score", b.bestBrings.every((x) => x.value >= 0 && x.value <= 100), JSON.stringify(b.bestBrings.map((x) => x.value)));
}

console.log(`${checked} checked, ${failures.length} failed.`);
for (const line of failures) console.log(`  FAIL ${line}`);
process.exit(failures.length ? 1 : 0);
