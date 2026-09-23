// A Nature and the Stat Points it is shown with (builder/nature-spreads.js:
// spreadPointsForNature / pointsForNature, through TeamEvaluator.commonSpreads,
// TeamSuggestions.spreadOptions and TeamSuggestions.spreadForNature).
//
// A usage file ranks Natures and Stat Points as two separate lists and never records which
// distribution a Nature was used with, so the second most common Nature has nothing to do
// with the second most common distribution.  Reading them side by side handed a Jolly
// Garchomp - a Nature that lowers Sp. Atk - 32 Sp. Atk and no Attack, and the player met
// that set on the Tournament Test's most similar team, in the Suggestions row that says a
// candidate completes a tournament team, and as the opponents the Tournament Test plays.
// The same zip decided the candidate spreads every Auto Build pick and Suggestions row is
// built on, so the player also met it on the sets those put forward.
//
// Checked here:
//   1. the rule itself, on hand-made rows: the lowered stat decides, the raised stat breaks
//      the tie, a neutral Nature takes the most used distribution, and when every recorded
//      distribution invests in the lowered stat the one that leans on it least wins
//   1b. the cases the Companion's own tests pin for the same rule, answered the same here
//   2. Garchomp, the case from the report: Jolly and Adamant get Attack, Modest and Timid
//      get Sp. Atk, and each of them is a distribution the file actually records
//   3. every (species, Nature) pair the tournament library holds: when the file records any
//      distribution that leaves the Nature's lowered stat alone, the one handed back is one
//      of those - and it is always a distribution the file really records
//   4. the same for a Nature the file never saw for that Pokemon, and for a Pokemon the
//      file has nothing on at all
//   5. the two callers that write the pairing into a team: the Tournament Test's most
//      similar team, and the Suggestions row for a candidate that completes a known team
//   6. the candidate spreads Auto Build and Suggestions build every set on
//      (TeamEvaluator.commonSpreads through TeamSuggestions.spreadOptions): over every
//      Pokemon in the Doubles and the Singles meta, no candidate set puts Stat Points in
//      the stat its Nature lowers, and every one of them is a distribution the file
//      records.  The same list read the old way (the option off, which is how a run
//      recorded before the rule replays) must still contradict itself, so the check bites.
//   7. the option itself: TeamEvaluator / TeamSuggestions / TeamAutoBuild default to the
//      rule and hand it down, and switching it off gives the usage file's index zip back
//
//   node tests/run-nature-spreads.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { TeamAutoBuild } from "../builder/team-autobuild.js";
import { spreadPointsForNature } from "../builder/nature-spreads.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest } from "../builder/tournament-test.js";
import { makeSet } from "../builder/common.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const readJson = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));
const appData = readJson("data", "builder", "app-data.json");
const engine = new DamageEngine(appData);
const knownRaw = readJson("data", "builder", "known-teams.json");

const SLOT = { HP: 0, ATK: 1, DEF: 2, SPA: 3, SPD: 4, SPE: 5 };
const slotOf = (stat) => SLOT[String(stat || "").trim().toUpperCase()];

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

function suggestionsFor(format) {
  const meta = readJson("data", "builder", `meta-${format.toLowerCase()}.json`);
  const ev = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  return { meta, ev, sg: new TeamSuggestions(new TeamEvaluation(ev)) };
}

// --- 1. the rule on hand-made rows ---------------------------------------------------

{
  // [usage percentage, HP / Atk / Def / SpA / SpD / Spe], most used first.
  const rows = [
    [40, [2, 0, 0, 32, 0, 32]],
    [30, [32, 0, 16, 0, 18, 0]],
    [20, [2, 32, 0, 0, 0, 32]],
  ];
  check("the lowered stat is left alone", spreadPointsForNature(rows, ["SPE", "SPA"])[1].join("/") === "2/32/0/0/0/32");
  check("the raised stat breaks the tie", spreadPointsForNature(rows, ["ATK", "SPA"])[1].join("/") === "2/32/0/0/0/32");
  check("the most used distribution fits when nothing contradicts", spreadPointsForNature(rows, ["SPA", "ATK"])[1].join("/") === "2/0/0/32/0/32");
  check("a neutral Nature takes the most used distribution", spreadPointsForNature(rows, ["", ""])[1].join("/") === "2/0/0/32/0/32");
  check("no rows, no answer", spreadPointsForNature([], ["ATK", "SPA"]) === null && spreadPointsForNature(null, ["ATK", "SPA"]) === null);
  // Nothing here leaves Attack alone, so the one that leans on it least wins.
  const physical = [[50, [0, 32, 0, 0, 0, 32]], [10, [32, 12, 0, 0, 20, 0]], [5, [0, 20, 0, 0, 0, 32]]];
  check("the least contradicting distribution when every one invests", spreadPointsForNature(physical, ["SPA", "ATK"])[1].join("/") === "32/12/0/0/20/0");
}

// --- 1b. the Companion's own cases, answered here ------------------------------------
//
// The same rule runs in the app (pokemon_champions_tool/nature_spread_pairing_v510.py
// `points_for_nature`). These are the cases its own tests pin
// (pct_tool94/tests/test_nature_spread_pairing_v510.py), with the answers they expect, so
// the two codebases cannot drift apart without one of the two suites saying so.

{
  const ranked = (list) => list.map((bonuses, i) => [100 - i, bonuses]);
  const answer = (rows, up, down) => (spreadPointsForNature(ranked(rows), [up, down])?.[1] || []).join("/");
  const garchomp = [[2, 32, 0, 0, 0, 32], [2, 0, 0, 32, 0, 32], [0, 0, 5, 31, 0, 30], [8, 0, 6, 21, 1, 30]];
  const tie = [[32, 0, 16, 0, 18, 0], [2, 32, 0, 0, 0, 32]];
  const everyone = [[0, 32, 0, 0, 0, 32], [32, 12, 0, 0, 20, 0], [0, 20, 0, 0, 0, 32]];
  const cases = [
    ["Jolly Garchomp", garchomp, "SPE", "SPA", "2/32/0/0/0/32"],
    ["Adamant Garchomp", garchomp, "ATK", "SPA", "2/32/0/0/0/32"],
    ["Modest Garchomp", garchomp, "SPA", "ATK", "2/0/0/32/0/32"],
    ["Timid Garchomp", garchomp, "SPE", "ATK", "2/0/0/32/0/32"],
    ["Adamant takes the attacking one", tie, "ATK", "SPA", "2/32/0/0/0/32"],
    ["Careful takes the bulky one", tie, "SPD", "SPA", "32/0/16/0/18/0"],
    ["a neutral Nature", garchomp, "", "", "2/32/0/0/0/32"],
    ["a Nature that raises and lowers the same stat", garchomp, "ATK", "ATK", "2/32/0/0/0/32"],
    ["a stat neither side knows", garchomp, "Nonsense", "Nonsense", "2/32/0/0/0/32"],
    ["every distribution invests", everyone, "SPA", "ATK", "32/12/0/0/20/0"],
    ["a tie keeps the usage order", [[0, 32, 0, 0, 0, 32], [4, 32, 0, 0, 0, 28]], "SPA", "ATK", "0/32/0/0/0/32"],
  ];
  for (const [label, rows, up, down, want] of cases) check(`the app's case: ${label}`, answer(rows, up, down) === want, answer(rows, up, down));
  check("the app's case: nothing recorded, no answer",
    spreadPointsForNature([], ["ATK", "SPA"]) === null && spreadPointsForNature(null, ["ATK", "SPA"]) === null && spreadPointsForNature([[1, [2, 3]]], ["ATK", "SPA"]) === null);
}

// --- 2. Garchomp, the case from the report -------------------------------------------

{
  const { meta, sg } = suggestionsFor("Doubles");
  const record = (meta.pokemon || []).find((row) => row.name === "Garchomp");
  const recorded = new Set((record?.spreads || []).map(([, bonuses]) => bonuses.join("/")));
  check("Garchomp is in the Doubles data", Boolean(record) && recorded.size > 1);
  for (const [nature, stat] of [["Jolly", "Atk"], ["Adamant", "Atk"], ["Modest", "SpA"], ["Timid", "SpA"]]) {
    const spread = sg.spreadForNature("Garchomp", nature);
    const bonuses = spread?.bonuses || [];
    const [up, down] = engine.natures[nature] || ["", ""];
    check(`Garchomp ${nature} keeps ${stat}`, Number(bonuses[SLOT[stat.toUpperCase()]]) > 0, bonuses.join("/"));
    check(`Garchomp ${nature} puts nothing in the stat it lowers (${down})`, !(Number(bonuses[slotOf(down)]) > 0), bonuses.join("/"));
    check(`Garchomp ${nature} invests in the stat it raises (${up})`, Number(bonuses[slotOf(up)]) > 0, bonuses.join("/"));
    check(`Garchomp ${nature} is a recorded distribution`, recorded.has(bonuses.join("/")), bonuses.join("/"));
    check(`Garchomp ${nature} names itself`, spread?.nature_name === nature, String(spread?.nature_name));
  }
}

// --- 3. and 4. every pair the library and the usage files hold ------------------------

for (const format of ["Doubles", "Singles"]) {
  const { meta, sg } = suggestionsFor(format);
  const known = new KnownTeams(knownRaw);
  const pairs = new Map();
  for (const team of known.teams) {
    for (const member of team.members || []) if (member.nature) pairs.set(`${member.species}|${member.nature}`, [member.species, member.nature]);
  }
  for (const record of meta.pokemon || []) {
    for (const [nature] of record.natures || []) if (nature) pairs.set(`${record.name}|${nature}`, [record.name, nature]);
  }
  let seen = 0;
  const contradictions = [];
  const invented = [];
  for (const [species, nature] of pairs.values()) {
    const record = (meta.pokemon || []).find((row) => row.name === species);
    const rows = record?.spreads || [];
    if (!rows.length) continue;
    seen += 1;
    const bonuses = sg.spreadForNature(species, nature)?.bonuses || [];
    const down = slotOf((engine.natures[nature] || ["", ""])[1]);
    if (!rows.some(([, b]) => b.join("/") === bonuses.join("/"))) invented.push(`${species} ${nature} -> ${bonuses.join("/")}`);
    if (down === undefined || !(Number(bonuses[down]) > 0)) continue;
    // It only counts against the pairing when the file did record a distribution that fits.
    if (rows.some(([, b]) => !(Number(b[down]) > 0))) contradictions.push(`${species} ${nature} -> ${bonuses.join("/")}`);
  }
  check(`${format}: pairs to check`, seen > 200, String(seen));
  check(`${format}: no Nature is given Stat Points it contradicts`, contradictions.length === 0, `${contradictions.length} of ${seen}, e.g. ${contradictions.slice(0, 4).join("; ")}`);
  check(`${format}: every answer is a distribution the file records`, invented.length === 0, `${invented.length} of ${seen}, e.g. ${invented.slice(0, 4).join("; ")}`);
}

{
  const { sg } = suggestionsFor("Doubles");
  // A Nature the file never saw on this Pokémon still gets Stat Points that suit it.
  const bold = sg.spreadForNature("Garchomp", "bold");
  check("an unseen Nature is named as asked", bold?.nature_name === "Bold", String(bold?.nature_name));
  check("an unseen Nature puts nothing in the stat it lowers", !(Number(bold?.bonuses?.[SLOT.ATK]) > 0), (bold?.bonuses || []).join("/"));
  // A Pokémon the file has nothing on: an answer with a name, and no crash.
  const unknown = sg.spreadForNature("Notapokemon", "Jolly");
  check("an unknown Pokémon still answers", unknown?.nature_name === "Jolly", JSON.stringify(unknown));
  check("an unknown Pokémon with no Nature answers nothing", sg.spreadForNature("Notapokemon", "") === null);
}

// --- 5. the two callers that write the pairing into a team ----------------------------

{
  const { sg, ev } = suggestionsFor("Doubles");
  const known = new KnownTeams(knownRaw);
  const test = new TournamentTest(new TeamEvaluation(ev), known, sg);
  const ours = [
    { species: "Incineroar", item: "Sitrus Berry", ability: "Intimidate", nature: "Careful", moves: ["Fake Out", "Knock Off", "Parting Shot", "Flare Blitz"], bonuses: [32, 0, 2, 0, 32, 0] },
    { species: "Garchomp", item: "Life Orb", ability: "Rough Skin", nature: "Jolly", moves: ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
    { species: "Rillaboom", item: "Assault Vest", ability: "Grassy Surge", nature: "Adamant", moves: ["Grassy Glide", "Wood Hammer", "Fake Out", "U-turn"], bonuses: [32, 32, 0, 0, 2, 0] },
    { species: "Amoonguss", item: "Rocky Helmet", ability: "Regenerator", nature: "Calm", moves: ["Spore", "Rage Powder", "Pollen Puff", "Protect"], bonuses: [32, 0, 16, 0, 18, 0] },
  ].map((set, slot) => ({ slot, set: makeSet(set) }));
  const similar = test.similarTeam(ours);
  check("the most similar team is found", Boolean(similar?.members?.length), JSON.stringify(similar && { number: similar.number, overlap: similar.overlap }));
  const wrong = (similar?.members || []).filter((member) => {
    const down = slotOf((engine.natures[member.nature] || ["", ""])[1]);
    return down !== undefined && Number(member.bonuses?.[down]) > 0 && (ev.record(member.species)?.spreads || []).some(([, b]) => !(Number(b[down]) > 0));
  });
  check("the loadable similar team has no Nature fighting its Stat Points", wrong.length === 0,
    wrong.map((m) => `${m.species} ${m.nature} ${m.bonuses.join("/")}`).join("; "));
  check("every similar-team member carries six Stat Points", (similar?.members || []).every((m) => m.bonuses?.length === 6));

  // The Suggestions row for a candidate that completes a tournament team carries the same pairing.
  const team = known.teams.find((t) => (t.members || []).some((m) => m.species === "Garchomp" && m.nature && engine.natures[m.nature]?.[1]));
  const member = team?.members?.find((m) => m.species === "Garchomp" && m.nature && engine.natures[m.nature]?.[1]);
  check("a tournament team names a Garchomp with a Nature", Boolean(member), String(member?.nature));
  if (member) {
    const spread = sg.spreadForNature("Garchomp", member.nature);
    const down = slotOf(engine.natures[member.nature][1]);
    check(`the row's Stat Points suit its ${member.nature}`, !(Number(spread.bonuses[down]) > 0), spread.bonuses.join("/"));
  }
}

// --- 6. the candidate spreads every Auto Build pick and Suggestions row is built on ---

for (const format of ["Doubles", "Singles"]) {
  const { meta, sg } = suggestionsFor(format);
  // The same evaluator with the rule off: the usage file's index zip, which is what a run
  // recorded before the rule replays with (tests/run-suggest-vectors.mjs and friends).
  const plainEv = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }), { pairedSpreads: null });
  plainEv.setMetaRecords(meta.pokemon || []);
  const plain = new TeamSuggestions(new TeamEvaluation(plainEv));
  let seen = 0;
  let species = 0;
  const contradictions = [];
  const invented = [];
  const oldContradictions = [];
  // A Nature contradicts its Stat Points only when the file did record a distribution that
  // fits it; where every recorded one invests in the lowered stat, the least of them stands.
  const contradicts = (rows, natureName, bonuses) => {
    const down = slotOf((engine.natures[String(natureName || "").trim()] || ["", ""])[1]);
    if (down === undefined || !(Number(bonuses[down]) > 0)) return false;
    return rows.some(([, b]) => !(Number(b[down]) > 0));
  };
  for (const record of meta.pokemon || []) {
    const rows = (record.spreads || []).filter(([, b]) => Array.isArray(b) && b.length >= 6);
    if (!rows.length || !(record.natures || []).length) continue;
    species += 1;
    const recorded = new Set(rows.map(([, b]) => b.join("/")));
    for (const spread of sg.spreadOptions(record.name, sg.common(record.name), 3)) {
      seen += 1;
      const bonuses = [...(spread.bonuses || [])];
      if (!recorded.has(bonuses.join("/"))) invented.push(`${record.name} ${spread.nature_name} -> ${bonuses.join("/")}`);
      if (contradicts(rows, spread.nature_name, bonuses)) contradictions.push(`${record.name} ${spread.nature_name} -> ${bonuses.join("/")}`);
    }
    for (const spread of plain.spreadOptions(record.name, plain.common(record.name), 3)) {
      if (contradicts(rows, spread.nature_name, [...(spread.bonuses || [])])) oldContradictions.push(`${record.name} ${spread.nature_name} -> ${(spread.bonuses || []).join("/")}`);
    }
  }
  check(`${format}: candidate spreads to check`, species > 100 && seen > 300, `${seen} spreads over ${species} Pokemon`);
  check(`${format}: no candidate set invests in the stat its Nature lowers`, contradictions.length === 0,
    `${contradictions.length} of ${seen}, e.g. ${contradictions.slice(0, 4).join("; ")}`);
  check(`${format}: every candidate spread is a distribution the file records`, invented.length === 0,
    `${invented.length} of ${seen}, e.g. ${invented.slice(0, 4).join("; ")}`);
  // Without this the two checks above could pass on data that never had the problem.
  check(`${format}: the index zip it replaces really did contradict itself`, oldContradictions.length > 0,
    `${oldContradictions.length}, e.g. ${oldContradictions.slice(0, 4).join("; ")}`);
}

// --- 7. the option, threaded like the guaranteed-move share ---------------------------

{
  const { meta, ev, sg } = suggestionsFor("Doubles");
  check("the evaluator pairs by default", ev.pairedSpreads === true);
  check("Suggestions follow the evaluator", sg.pairedSpreads === true);
  check("Auto Build hands the rule down", new TeamAutoBuild(new TeamEvaluation(ev)).sg.pairedSpreads === true);
  check("Auto Build hands a switched-off rule down", new TeamAutoBuild(new TeamEvaluation(ev), { pairedSpreads: null }).sg.pairedSpreads === false);
  const off = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }), { pairedSpreads: null });
  off.setMetaRecords(meta.pokemon || []);
  check("a switched-off evaluator says so", off.pairedSpreads === false);
  // A Pokemon whose top Nature and top distribution disagree: the two ways must differ, and
  // the file's own index zip must come back unchanged with the rule off.
  const record = (meta.pokemon || []).find((row) => {
    const [nature] = row.natures?.[0] || [];
    const down = slotOf((engine.natures[nature] || ["", ""])[1]);
    return down !== undefined && Number(row.spreads?.[0]?.[1]?.[down]) > 0 && (row.spreads || []).some(([, b]) => !(Number(b[down]) > 0));
  });
  check("the meta has a Pokemon whose top Nature and top distribution disagree", Boolean(record), String(record?.name));
  if (record) {
    const paired = ev.commonSpreads(record.name, 3);
    const zipped = off.commonSpreads(record.name, 3);
    // `rank` says which Nature each row is, so a deduplicated list still lines up.
    check("with the rule off the file's own pairs come back", zipped.every((spread) => spread.bonuses.join("/") === (record.spreads[spread.rank - 1]?.[1] || []).join("/")),
      zipped.map((s) => `${s.rank}:${s.bonuses.join("/")}`).join(" | "));
    check("with the rule on the first candidate spread changes", paired[0].bonuses.join("/") !== zipped[0].bonuses.join("/"),
      `${paired[0].bonuses.join("/")} vs ${zipped[0].bonuses.join("/")}`);
    check("the third argument overrides the evaluator", ev.commonSpreads(record.name, 3, false)[0].bonuses.join("/") === zipped[0].bonuses.join("/"));
  }
}

console.log(failures.length ? `\n${failures.map((f) => `FAIL ${f}`).join("\n")}\n` : "");
console.log(`${checked} checked, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
