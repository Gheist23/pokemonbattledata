// A replacement is scored against the team it would leave behind
// (builder/team-suggest.js, the port of the app's suggestion_swap_basis_v524).
//
// The owner's report: "when i run Suggestions with a full team, it shows me swapping out
// Rillaboom for Persian as best option. When i remove Rillaboom from the team, it shows me to
// add Typhlosion as best suggestion. Generally, the suggested options are better when the
// pokemon is removed first instead of running the suggestions on a full team, make sure that
// the calcs are equally good and show the same Pokemon."
//
// Both lists describe the same six Pokemon. They scored them differently because only the
// `after` side of a suggestion was the projected team: the checks, the threats, the four axis
// scores, the typing and synergy fit, the speed plan, the archetype payoff, the known-team
// evidence and the field a candidate's set may rely on were all still measured with the
// Pokemon being removed still on the team.
//
// Measured on the APP, on the owner's own team, removing Rillaboom - the numbers this suite
// exists to stop coming back:
//
//     candidate      swap on six   add to five      gap
//     Persian               55.4          73.2    -17.8
//     Incineroar            59.4          86.3    -26.9
//     Kingambit             62.2          85.5    -23.3
//     Azumarill             56.9          84.1    -27.2
//     Typhlosion             8.6          55.1    -46.5
//     Gholdengo              9.2          58.2    -49.0
//
// The spread is the fault rather than the size: the same removal cost Persian 17.8 points and
// Gholdengo 49.0, so the error re-ordered the list instead of shifting it.
//
// What is checked here, and why it is not in run-suggest-vectors.mjs (which replays the app's
// recorded answers and so can only check what was recorded - and every recording on disk is
// stamped at version 5 or below, which is exactly why they all stay green):
//
//   1. the gate: production is version 6, and 5, 4, 3, 2 and an unstamped recording all keep
//      the baselines they were recorded with;
//   2. the basis itself: the team minus the member the swap removes, evaluated in full, with
//      its own checks / threats / Offense / Speed / Synergy - and refused outright for a
//      target it cannot place, rather than built on the wrong member leaving;
//   3. THE INVARIANT, on the owner's own team and the site's own meta data:
//
//          score(swap X -> Y) == score(add Y to the team without X) + outgoingRoleCost
//
//      for every member of a full team as the swap target. `outgoingRoleCost` is a genuine
//      cost of replacing rather than a baseline error, which is why the invariant is net of it;
//   4. that it does NOT hold at version 5, so check 3 bites rather than passing on a tautology;
//   5. the row is still a swap: the wording, the target, the slot and the replacement cost are
//      untouched.
//
//   node tests/run-swap-basis.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, compact } from "../builder/engine.js";
import { SUGGESTION_SCORING, TeamSuggestions, ruleTable, trickRoomReward } from "../builder/team-suggest.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));

const { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } = await import("../builder/team-eval.js");
const { TeamEvaluation } = await import("../builder/team-payload.js");
const { KnownTeams } = await import("../builder/known-teams.js");
const { makeSet } = await import("../builder/common.js");

const appData = read("data", "builder", "app-data.json");
const meta = read("data", "builder", "meta-doubles.json");
const known = new KnownTeams(read("data", "builder", "known-teams.json"));
const ranked = (meta.pokemon || []).filter((row) => Number(row.position) < 999999).length;

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} != ${JSON.stringify(want)}`);

// ---------------------------------------------------------------------------
// 1. the gate
// ---------------------------------------------------------------------------
ok("production runs version 6", SUGGESTION_SCORING === 6, String(SUGGESTION_SCORING));
// `ruleTable` falls back to `[SUGGESTION_SCORING]`; a missing 6: row is `undefined` and throws
eq("version 6 has its own damping row", ruleTable(6), [22, 10, 0]);
eq("and it is version 5's row, because no weight moved", ruleTable(6), ruleTable(5));
eq("the table the app states", [0, 1, 2].map((n) => trickRoomReward(n, 6)), [22, 10, 0]);

// ---------------------------------------------------------------------------
// the harness, built exactly as run-suggest-scoring.mjs builds it
// ---------------------------------------------------------------------------

// The owner's own six slots, as this suite already records them: three Trick Room setters, so
// every suggestion is a swap rather than a fill.
const OWNER_TEAM = [
  { species: "Malamar", form: "Mega Malamar", item: "Malamarite", ability: "Contrary", nature: "Relaxed", moves: ["Superpower", "Protect", "Knock Off", "Trick Room"], bonuses: [32, 32, 2, 0, 0, 0] },
  { species: "Indeedee", form: "Indeedee Female", item: "Colbur Berry", ability: "Psychic Surge", nature: "Relaxed", moves: ["Follow Me", "Trick Room", "Helping Hand", "Psychic"], bonuses: [32, 0, 32, 0, 2, 0] },
  { species: "Milotic", form: "Milotic", item: "Leftovers", ability: "Competitive", nature: "Modest", moves: ["Protect", "Scald", "Ice Beam", "Icy Wind"], bonuses: [32, 0, 32, 0, 2, 0] },
  { species: "Sylveon", form: "Sylveon", item: "Fairy Feather", ability: "Pixilate", nature: "Modest", moves: ["Hyper Voice", "Hyper Beam", "Quick Attack", "Detect"], bonuses: [32, 0, 2, 32, 0, 0] },
  { species: "Farigiraf", form: "Farigiraf", item: "Sitrus Berry", ability: "Armor Tail", nature: "Bold", moves: ["Trick Room", "Helping Hand", "Psychic", "Thunderbolt"], bonuses: [27, 0, 20, 0, 19, 0] },
  { species: "Rillaboom", form: "Rillaboom", item: "Miracle Seed", ability: "Grassy Surge", nature: "Adamant", moves: ["Grassy Glide", "Fake Out", "Wood Hammer", "U-turn"], bonuses: [32, 32, 0, 0, 0, 2] },
].map(makeSet);

const suggesterFor = (scoring, format = "Doubles") => {
  const ev = new TeamEvaluator(null, new DamageEngine(appData), format, normalizeSettings({ ...DEFAULT_SETTINGS }, ranked));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  evaluation.knownTeams = known;
  // The diversity rule reshapes which rows are SHOWN; it is off here so the comparison is one
  // row against the same row rather than a shaped list against a shaped list.
  return new TeamSuggestions(evaluation, { suggestionScoring: scoring, suggestionDiversity: false });
};

/** The scan context `run` builds, for a list of sets. */
function contextFor(suggester, sets) {
  const filled = Array.from({ length: 6 }, (_, i) => sets[i] || null);
  const payload = suggester.evaluation.evaluate(filled, { checkSelection: null });
  const teamSlots = (payload.slots || []).map(({ entry, mon, set }) => ({
    entry: { ...entry, form: mon.form_name || entry.form, ability: mon.ability || entry.ability }, mon, set,
  }));
  const teamEntries = teamSlots.map(({ entry }) => entry);
  const activeNames = teamSlots.map(({ entry, mon }) => suggester.name(mon.form_name || entry.form || entry.pokemon));
  return {
    payload, teamSlots, teamEntries, activeNames,
    emptySlot: teamSlots.length < 6 ? teamSlots.length : null,
    selection: null, selected: suggester.checks.selectedIds(null), swapTarget: "",
  };
}

const scoreOf = (row) => Number(row?.score) || 0;
const costOf = (row) => Number(row?.outgoing_role_cost_v512) || 0;

/**
 * One candidate scored both ways: as a swap on the whole team, and as an add to the same team
 * with the swap target taken out. The two build the identical projected team, so net of the
 * replacement cost they must agree.
 *
 * `evaluateCandidate` is called directly rather than through `run`, for the same reason the
 * app probe calls `_v378_fast_suggestion_for_candidate` directly: `run` only offers the three
 * targets `swapTargets` picks, and the invariant is about every member.
 */
function bothWays(suggester, sets, index, candidateName) {
  const six = contextFor(suggester, sets);
  const sixMeta = suggester.candidates(six.payload, six.activeNames).find((row) => String(row.name) === candidateName);
  if (!sixMeta) return null;
  const target = six.activeNames[index];
  suggester._basisCache = new Map();
  const basis = suggester.basisFor(six, target);
  const swap = suggester.evaluateCandidate(structuredClone(sixMeta), {
    ...six, swapTarget: target,
    basisPayload: basis?.payload, basisSlots: basis?.slots, basisEntries: basis?.entries,
  });

  const five = contextFor(suggester, sets.filter((_, i) => i !== index));
  const fiveMeta = suggester.candidates(five.payload, five.activeNames).find((row) => String(row.name) === candidateName);
  if (!fiveMeta) return null;
  const add = suggester.evaluateCandidate(structuredClone(fiveMeta), { ...five, swapTarget: "" });
  if (!swap || !add) return null;
  return { target, basis, swap, add, gap: scoreOf(swap) - costOf(swap) - scoreOf(add) };
}

// ---------------------------------------------------------------------------
// 2. the basis
// ---------------------------------------------------------------------------
{
  const suggester = suggesterFor(6);
  const context = contextFor(suggester, OWNER_TEAM);
  const target = context.activeNames[5];
  notes.push(`the team on screen: ${context.activeNames.join(", ")}`);
  const basis = suggester.basisFor(context, target);
  ok("a basis is built for a swap", !!basis);
  ok("it is the team minus one", (basis?.slots || []).length === 5, String((basis?.slots || []).length));
  ok("the member the swap removes is the one missing",
     !(basis?.entries || []).some((entry) => suggester.speciesId(entry.form || entry.pokemon) === suggester.speciesId("Rillaboom")));
  ok("it is a full evaluation of its own", !!basis?.payload?.checks && !!basis?.payload?.speed);
  // and it really is a different payload: a basis that silently fell back to the whole team
  // would pass every check above
  const baselines = ["offense_score", "synergy_score"];
  const moved = baselines.filter((key) => Math.abs((Number(basis?.payload?.[key]) || 0) - (Number(context.payload[key]) || 0)) > 1e-9);
  ok("its axis baselines are not the whole team's", moved.length === baselines.length, moved.join(", "));
  ok("its Speed baseline is not the whole team's",
     Math.abs(Number(basis?.payload?.speed?.score) - Number(context.payload.speed?.score)) > 1e-9,
     `${basis?.payload?.speed?.score} vs ${context.payload.speed?.score}`);
  ok("its checks are not the whole team's",
     JSON.stringify(basis?.payload?.checks?.rows) !== JSON.stringify(context.payload.checks?.rows));
  notes.push(`basis without ${target}: offense ${Number(basis?.payload?.offense_score).toFixed(2)} `
    + `(team ${Number(context.payload.offense_score).toFixed(2)}), speed ${Number(basis?.payload?.speed?.score).toFixed(2)} `
    + `(team ${Number(context.payload.speed?.score).toFixed(2)}), threats ${(basis?.payload?.threats || []).length} `
    + `(team ${(context.payload.threats || []).length})`);
  // built once per target, and never for an add or a target it cannot place
  ok("a target it cannot place gets no basis at all", suggester.basisFor(context, "Nothing-Like-This") === null);
  ok("an empty target gets none", suggester.basisFor(context, "") === null);
  ok("an add gets none", suggester.basisFor({ ...context, emptySlot: 5 }, target) === null);
  ok("Auto Build gets none", suggester.basisFor({ ...context, autoBuild: true }, target) === null);
  ok("it is built at most once per target", suggester.basisFor(context, target) === basis);
  // and no version below 6 builds one, which is what keeps every recording on disk green
  for (const version of [2, 3, 4, 5]) {
    ok(`version ${version} keeps its own baselines`, suggesterFor(version).basisFor(contextFor(suggesterFor(version), OWNER_TEAM), target) === null);
  }
  const unstamped = suggesterFor(null);
  ok("an unstamped recording keeps its own baselines", unstamped.basisFor(contextFor(unstamped, OWNER_TEAM), target) === null);
}

// ---------------------------------------------------------------------------
// 3 + 4. the invariant
// ---------------------------------------------------------------------------
const CANDIDATES = ["Incineroar", "Amoonguss", "Kingambit", "Azumarill", "Gholdengo", "Dragapult", "Urshifu", "Persian"];

for (const version of [6, 5]) {
  const suggester = suggesterFor(version);
  const present = new Set(OWNER_TEAM.map((set) => suggester.speciesId(set.species)));
  let worst = 0;
  let pairs = 0;
  const lines = [];
  for (let index = 0; index < OWNER_TEAM.length; index += 1) {
    for (const name of CANDIDATES) {
      if (present.has(suggester.speciesId(name))) continue;
      const result = bothWays(suggester, OWNER_TEAM, index, name);
      if (!result) continue;
      pairs += 1;
      if (Math.abs(result.gap) > Math.abs(worst)) worst = result.gap;
      lines.push(`    ${result.target} -> ${name}: swap ${scoreOf(result.swap).toFixed(1)} `
        + `add ${scoreOf(result.add).toFixed(1)} cost ${costOf(result.swap).toFixed(2)} gap ${result.gap.toFixed(1)}`);
    }
  }
  notes.push(`version ${version}: ${pairs} pairs, worst gap ${worst.toFixed(2)}`);
  if (version === 6) {
    ok("enough pairs to mean something", pairs >= 12, String(pairs));
    // Both arms round to a tenth and the cost to a hundredth, so a tenth is the tightest
    // honest tolerance.
    ok("a swap scores what the equivalent add scores", Math.abs(worst) <= 0.1 + 1e-9, worst.toFixed(2));
    if (Math.abs(worst) > 0.1) notes.push(...lines.filter((line) => !/gap -?0\.0$/.test(line)));
  } else {
    ok("without the rule it does not hold", Math.abs(worst) > 5, worst.toFixed(2));
    notes.push(...lines.slice(0, 6));
  }
}

// ---------------------------------------------------------------------------
// 5. the row is still a swap
// ---------------------------------------------------------------------------
{
  const suggester = suggesterFor(6);
  const result = bothWays(suggester, OWNER_TEAM, 5, "Incineroar");
  ok("the swap row exists", !!result);
  if (result) {
    eq("it is still a swap", String(result.swap.action_kind), "swap");
    ok("it still names the member it replaces",
       suggester.speciesId(result.swap.swap_target) === suggester.speciesId("Rillaboom"), String(result.swap.swap_target));
    ok("it still says Swap", String(result.swap.action || "").startsWith("Swap "), String(result.swap.action));
    ok("it still replaces that slot", Number(result.swap.slot_index) === 5, String(result.swap.slot_index));
    // V433 deliberately replaces "Replaces X; review any role unique to that slot" with the
    // net before/after wording, so the warning is the ledger's, not that line's.
    ok("the swap carries a replacement cost line or a net-change line",
       (result.swap.details || []).length > 0, JSON.stringify(result.swap.details));
    // the one term that legitimately separates a swap from an add
    ok("the add row carries no replacement cost", !result.add.outgoing_role_cost_v512);
    // the candidate's set is built against the field the remaining team can still turn on
    const have = suggester.fieldSupport(result.basis?.entries || []);
    ok("the swap cannot be handed a move the remaining team cannot support",
       !(result.swap.moves || []).some((move) => compact(move) === "grassyglide") || have.has("grassy"),
       JSON.stringify(result.swap.moves));
    notes.push(`Rillaboom -> Incineroar: swap ${scoreOf(result.swap).toFixed(1)}, `
      + `add ${scoreOf(result.add).toFixed(1)}, cost ${costOf(result.swap).toFixed(2)}`);
  }
}

for (const line of notes) console.log(line);
if (failures.length) {
  console.error(`\n${checked} checks, ${failures.length} failed:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\n${checked} checks, all passed.`);
