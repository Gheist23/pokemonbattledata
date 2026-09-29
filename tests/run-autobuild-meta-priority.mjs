// Checks autobuild_meta_priority (builder/autobuild-meta-priority.js): "Prioritize Meta
// Pokemon" ranks the Top X ahead of everything but the RED Team Building Checks.
//
//   node tests/run-autobuild-meta-priority.mjs
//
// The owner reported regular Arcanine (usage rank 118) still being added with the box
// ticked. Before the rule the option only reordered inside a tier that sat BELOW the yellow
// checks, so one yellow check anywhere outranked being in the Top X and the option could
// change a pick only when two candidates were otherwise exactly equal. The fix is a tier
// move in four places, and this suite holds one guard per place that goes red if that one
// move is reverted:
//
//   1. beats() / the objective tiers complete teams are compared by
//   2. TeamAutoBuild.order()          the per-slot candidate ranking
//   3. AutoBuildSearch.searchOrder()  the search's own candidate ranking
//   4. AutoBuildSearch.repairOrder()  the order the one-swap repair tries alternatives in
//
// Sections 1-8 are synthetic, so they cannot stop biting when the meta data changes.
// Section 9 screens a real slot on the site's own meta and section 10 runs two real Auto
// Builds, so the numbers the owner sees are the ones measured.
//
// The switch: `options.autobuildMetaPriority` (0 / null / false / "off" restores exactly the
// order before the rule). A recording stamps `rules.autobuild_meta_priority`, read the way
// the vector suites read terrain_seeds / team_checks; AUTOBUILD_META_PRIORITY=0|1 in the
// environment replays every case either way.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, compact } from "../builder/engine.js";
import { TeamEvaluator, DEFAULT_SETTINGS, normalizeSettings } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TeamAutoBuild, AUTO_BUILD_PROFILES } from "../builder/team-autobuild.js";
import { AutoBuildSearch, OBJECTIVE_TIERS, OBJECTIVE_TIERS_META_FIRST, beatReason, beats } from "../builder/autobuild-search.js";
import {
  AUTOBUILD_META_PRIORITY, META_PRIORITY_STAMP, metaPriorityOn, metaPriorityOption,
  metaPriorityStamp, objectiveTiers, promoteMetaTier,
} from "../builder/autobuild-meta-priority.js";
import { usageOption } from "../builder/optimize-usage-moves.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const failures = [];
let checked = 0;
const check = (ok, message) => {
  checked += 1;
  if (!ok) failures.push(message);
};
const eq = (what, got, want) => check(JSON.stringify(got) === JSON.stringify(want), `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// --- 1. the switch ----------------------------------------------------------------------
eq("the rule version", AUTOBUILD_META_PRIORITY, 1);
eq("left out, production's version", metaPriorityOption(undefined), 1);
eq("an unstamped recording replays with it off", metaPriorityOption(null), 0);
eq("0 restores the order before the rule", metaPriorityOption(0), 0);
eq("false restores the order before the rule", metaPriorityOption(false), 0);
eq('"off" restores the order before the rule', metaPriorityOption("off"), 0);
eq('"0" restores the order before the rule', metaPriorityOption("0"), 0);
eq("a stamp selects that version", metaPriorityOption(1), 1);
eq("a later version selects itself", metaPriorityOption(3), 3);
eq("metaPriorityOn reads the version", [metaPriorityOn(undefined), metaPriorityOn(0), metaPriorityOn("off"), metaPriorityOn(2)], [true, false, false, true]);
// The helper is shaped exactly like optimize-usage-moves.js's, which has the same default,
// so the two must agree on every value a stamp or an environment override can carry.
for (const value of [undefined, null, false, true, 0, 1, 2, -1, "", " ", "off", "OFF", "false", "no", "none", "0", "1", "2", "banana"]) {
  eq(`the coercion matches usageOption for ${JSON.stringify(value)}`, metaPriorityOption(value), usageOption(value));
}

// --- 2. the recording stamp -------------------------------------------------------------
eq("the stamp key", META_PRIORITY_STAMP, "autobuild_meta_priority");
eq("a recorded rules block", metaPriorityStamp({ record: { rules: { autobuild_meta_priority: 1 } } }), 1);
eq("a case-level rules block", metaPriorityStamp({ rules: { autobuild_meta_priority: 2 } }), 2);
eq("no stamp at all", metaPriorityStamp({ record: { rules: {} } }), null);
eq("nothing at all", metaPriorityStamp(undefined), null);

// --- 3. the tier order ------------------------------------------------------------------
eq("the tiers before the rule", objectiveTiers(0), ["checksRed", "checksYellow", "archetypeUnmet", "metaOutside"]);
eq("the tiers with the rule", objectiveTiers(1), ["checksRed", "archetypeUnmet", "metaOutside", "checksYellow"]);
eq("autobuild-search exports the old order", OBJECTIVE_TIERS, objectiveTiers(0));
eq("autobuild-search exports the new order", OBJECTIVE_TIERS_META_FIRST, objectiveTiers(1));
for (const rule of [0, 1]) {
  eq(`the red checks stay first at rule ${rule}`, objectiveTiers(rule)[0], "checksRed");
  eq(`rule ${rule} compares the same four tiers`, [...objectiveTiers(rule)].sort(), [...objectiveTiers(0)].sort());
}
check(objectiveTiers(1).indexOf("metaOutside") < objectiveTiers(1).indexOf("checksYellow"), "the rule must put the Top X above the yellow checks");
check(objectiveTiers(0).indexOf("metaOutside") > objectiveTiers(0).indexOf("checksYellow"), "without the rule the yellow checks must stay above the Top X");

// --- 4. promoteMetaTier -----------------------------------------------------------------
eq("the element moves up", promoteMetaTier([0, 1, 2, 3, 4, 5, 6], 5, 2, 1), [0, 1, 5, 2, 3, 4, 6]);
eq("the repair key moves up", promoteMetaTier([0, 1, 2, 3, 4], 2, 1, 1), [0, 2, 1, 3, 4]);
eq("the rule off leaves the key alone", promoteMetaTier([0, 1, 2, 3, 4, 5, 6], 5, 2, 0), [0, 1, 2, 3, 4, 5, 6]);
eq("an element already in place is left alone", promoteMetaTier([0, 1, 2], 1, 1, 1), [0, 1, 2]);
eq("an index past the key is left alone", promoteMetaTier([0, 1], 5, 2, 1), [0, 1]);
{
  const original = [0, 1, 2, 3, 4, 5, 6];
  const moved = promoteMetaTier(original, 5, 2, 1);
  check(moved !== original, "promoteMetaTier must not sort the caller's key in place");
  eq("the caller's key is untouched", original, [0, 1, 2, 3, 4, 5, 6]);
}

// --- 5. move 1: the objective (beats / beatReason) --------------------------------------
{
  const team = (over) => ({ checksRed: 0, checksYellow: 0, archetypeUnmet: 0, metaOutside: 0, T: 60, ...over });
  // The whole point: one yellow check must no longer buy a Pokemon from outside the Top X.
  const yellowOnly = team({ checksYellow: 1, T: 55 });
  const outsideOnly = team({ metaOutside: 1, T: 80 });
  check(beats(yellowOnly, outsideOnly, 1, 1), "rule on: a yellow check must beat a member from outside the Top X");
  eq("rule on: the Top X decides before the yellow checks", beatReason(yellowOnly, outsideOnly, 1), "metaOutside");
  check(!beats(yellowOnly, outsideOnly, 1, 0), "rule off: the yellow check must still lose to the Top X (the old order)");
  eq("rule off: the yellow checks decide first", beatReason(yellowOnly, outsideOnly, 0), "checksYellow");
  // Production runs the rule, so the default argument must select it.
  check(beats(yellowOnly, outsideOnly), "the default objective must be the rule's order");
  eq("the default beatReason must be the rule's order", beatReason(yellowOnly, outsideOnly), "metaOutside");
  // The red checks still come first, at both versions: the option makes a team meta, not broken.
  for (const rule of [0, 1]) {
    check(!beats(team({ checksRed: 1, T: 99 }), team({ metaOutside: 2, checksYellow: 3 }), 1, rule), `rule ${rule}: a red check must still lose to everything else`);
    eq(`rule ${rule}: a red check decides first`, beatReason(team({ checksRed: 1 }), team({ metaOutside: 2, checksYellow: 3 })), "checksRed");
    check(!beats(team({ archetypeUnmet: 1, T: 99 }), team({ metaOutside: 1 }), 1, rule), `rule ${rule}: an unmet critical archetype requirement must stay above the Top X`);
    check(!beats(team({ T: 60.9 }), team({}), 1, rule) && beats(team({ T: 61 }), team({}), 1, rule), `rule ${rule}: the score still needs the margin of 1 point`);
  }
}

// --- the synthetic rows sections 6-8 rank -----------------------------------------------
// A Top-X row that still fails one yellow check against a cheaper filler outside the Top X
// that fails none and scores much better - the owner's Arcanine, in two rows.
const metaRow = () => ({
  name: "MetaMon", action: "", score: 50, position: 5, prioritized_meta_member_v462: true,
  _hard_red_checks_v472: 0, _hard_yellow_checks_v472: 1, _hard_check_pressure_v472: 5, defensive_switch_warning_count: 0,
});
const fillerRow = () => ({
  name: "Filler", action: "", score: 90, position: 118, prioritized_meta_member_v462: false,
  _hard_red_checks_v472: 0, _hard_yellow_checks_v472: 0, _hard_check_pressure_v472: 1, defensive_switch_warning_count: 0,
});
const names = (rows) => rows.map((row) => row.name);
const stubSearch = (rule) => {
  const search = new AutoBuildSearch({ sg: null, ev: null, evaluation: null }, AUTO_BUILD_PROFILES);
  search.metaKeys = new Set(["metamon"]);
  search.metaPriority = rule;
  return search;
};

// --- 9/10 need the real evaluator; build it once ----------------------------------------
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const meta = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));
const knownPayload = JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8"));
function makeEvaluation() {
  const engine = new DamageEngine(appData);
  const evaluator = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }));
  evaluator.setMetaRecords(meta.pokemon);
  const evaluation = new TeamEvaluation(evaluator);
  evaluation.knownTeams = new KnownTeams(knownPayload);
  return evaluation;
}
const evaluation = makeEvaluation();
const set = (species, item, ability, nature, moves, bonuses, form = species) => ({ species, form, item, ability, nature, moves, bonuses });
const STARTS = {
  mixed: [
    set("Froslass", "Froslassite", "Snow Warning", "Timid", ["Blizzard", "Shadow Ball", "Icy Wind", "Protect"], [2, 0, 0, 32, 0, 32], "Mega Froslass"),
    set("Sneasler", "White Herb", "Unburden", "Adamant", ["Close Combat", "Dire Claw", "Fake Out", "Protect"], [2, 32, 0, 0, 0, 32]),
    set("Salamence", "Salamencite", "Aerilate", "Timid", ["Hyper Voice", "Tailwind", "Draco Meteor", "Protect"], [2, 0, 0, 32, 0, 32], "Mega Salamence"),
  ],
  sun: [
    set("Charizard", "Charizardite Y", "Drought", "Modest", ["Heat Wave", "Solar Beam", "Air Slash", "Protect"], [2, 0, 0, 32, 0, 32], "Mega Charizard Y"),
    set("Venusaur", "Focus Sash", "Chlorophyll", "Modest", ["Leaf Storm", "Sludge Bomb", "Sleep Powder", "Protect"], [2, 0, 0, 32, 0, 32]),
    set("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"], [32, 0, 14, 0, 20, 0]),
  ],
  partial: [
    set("Garchomp", "Garchompite Z", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]),
    set("Rillaboom", "Assault Vest", "Grassy Surge", "Adamant", ["Fake Out", "Grassy Glide", "Wood Hammer", "U-turn"], [32, 32, 0, 0, 2, 0]),
    set("Sylveon", "Throat Spray", "Pixilate", "Modest", ["Hyper Voice", "Moonblast", "Quick Attack", "Protect"], [32, 0, 0, 32, 2, 0]),
  ],
  single: [set("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"], [32, 0, 14, 0, 20, 0])],
};
const teamOf = (name = "mixed") => Array.from({ length: 6 }, (_, i) => STARTS[name][i] || null);

// --- 6. move 2: TeamAutoBuild.order() ---------------------------------------------------
{
  const builder = new TeamAutoBuild(evaluation);
  eq("the builder's default is production's version", builder.metaPriority, AUTOBUILD_META_PRIORITY);
  eq("the constructor takes the rule", new TeamAutoBuild(evaluation, { autobuildMetaPriority: 0 }).metaPriority, 0);
  builder.metaPriority = 1;
  eq("order() rule on: the Top X comes first despite its yellow check", names(builder.order([fillerRow(), metaRow()])), ["MetaMon", "Filler"]);
  builder.metaPriority = 0;
  eq("order() rule off: the yellow check still sinks the Top X", names(builder.order([fillerRow(), metaRow()])), ["Filler", "MetaMon"]);
  // A red check still decides, at both versions.
  for (const rule of [0, 1]) {
    builder.metaPriority = rule;
    const red = { ...metaRow(), _hard_red_checks_v472: 1 };
    eq(`order() rule ${rule}: a red check still sinks the Top X`, names(builder.order([red, fillerRow()])), ["Filler", "MetaMon"]);
  }
  // With Prioritize Meta off no row carries the mark, so both versions must rank identically.
  const plain = (name, yellow, score) => ({ name, action: "", score, position: 10, _hard_red_checks_v472: 0, _hard_yellow_checks_v472: yellow, _hard_check_pressure_v472: yellow, defensive_switch_warning_count: 0 });
  const rows = [plain("A", 1, 90), plain("B", 0, 50), plain("C", 2, 99)];
  builder.metaPriority = 1;
  const on = names(builder.order(rows.map((r) => ({ ...r }))));
  builder.metaPriority = 0;
  eq("Prioritize Meta off: the rule changes no order at all", on, names(builder.order(rows.map((r) => ({ ...r })))));
  eq("Prioritize Meta off: the yellow checks still rank the list", on, ["B", "A", "C"]);
}

// --- 7. move 3: AutoBuildSearch.searchOrder() -------------------------------------------
{
  eq("searchOrder() rule on: the Top X comes first despite its yellow check", names(stubSearch(1).searchOrder([fillerRow(), metaRow()])), ["MetaMon", "Filler"]);
  eq("searchOrder() rule off: the yellow check still sinks the Top X", names(stubSearch(0).searchOrder([fillerRow(), metaRow()])), ["Filler", "MetaMon"]);
  for (const rule of [0, 1]) {
    const red = { ...metaRow(), _hard_red_checks_v472: 1 };
    eq(`searchOrder() rule ${rule}: a red check still sinks the Top X`, names(stubSearch(rule).searchOrder([red, fillerRow()])), ["Filler", "MetaMon"]);
  }
  // Prioritize Meta off (no Top X at all): outsideMeta() is false for every row, so both agree.
  const noMeta = (rule) => {
    const search = stubSearch(rule);
    search.metaKeys = null;
    return search;
  };
  eq("Prioritize Meta off: searchOrder ranks the same either way", names(noMeta(1).searchOrder([fillerRow(), metaRow()])), names(noMeta(0).searchOrder([fillerRow(), metaRow()])));
}

// --- 8. move 4: AutoBuildSearch.repairOrder() -------------------------------------------
{
  const found = [[0, fillerRow()], [1, metaRow()]];
  const tried = (rule) => stubSearch(rule).repairOrder(found.map(([slot, row]) => [slot, { ...row }])).map(([, row]) => row.name);
  eq("repairOrder() rule on: the Top X alternative is tried first", tried(1), ["MetaMon", "Filler"]);
  eq("repairOrder() rule off: the yellow check still sinks it", tried(0), ["Filler", "MetaMon"]);
  const reds = [[0, fillerRow()], [1, { ...metaRow(), _hard_red_checks_v472: 1 }]];
  for (const rule of [0, 1]) {
    eq(`repairOrder() rule ${rule}: a red check is still tried first`, stubSearch(rule).repairOrder(reds.map(([slot, row]) => [slot, { ...row }])).map(([, row]) => row.name), ["Filler", "MetaMon"]);
  }
}

// --- 9. one real slot, screened on the site's own meta ----------------------------------
// The regression the owner saw, on real data: the ranked list for one open slot with
// Prioritize Meta on. With the rule the top row must be in the Top X whenever a Top-X row
// fails as few red checks as the best row of all - which is what the option promises.
{
  let changed = 0;
  let comparable = 0;
  for (const start of ["mixed", "sun", "partial", "single"]) {
    const builder = new TeamAutoBuild(evaluation);
    const sets = teamOf(start);
    const entries = sets.map((s) => builder.entryFromSet(s));
    const spreads = sets.map((s) => (s?.species ? { nature_name: s.nature || "Serious", bonuses: [...(s.bonuses || [0, 0, 0, 0, 0, 0])] } : null));
    builder.finalizeExisting(entries, spreads);
    const live = entries.filter((e) => e.pokemon);
    const slots = builder.slotsFor(entries, spreads);
    const { chosen, options } = builder.runOptions(entries, slots, { archetype: "automatic", prioritizeMeta: true });
    check(Boolean(options.metaKeys?.size), `${start}: Prioritize Meta must give the screening a Top X to rank by`);
    const seed = builder.seedPayload(slots, null, null);
    const state = { megaNeeded: builder.megaStoneSlots(entries).length === 0, log: [], archetype: chosen, ...chosen.forcing(live) };
    const shared = {
      selection: null, selected: builder.checks.selectedIds(null), profile: AUTO_BUILD_PROFILES.deep,
      frozen: builder.frozenPool(builder.names(slots)), startEntries: live.map((e) => ({ ...e })), options,
    };
    const rows = builder.screenSlot({ entries, spreads, seed, state }, shared)?.ranked || [];
    check(rows.length > 20, `${start}: the screening produced only ${rows.length} rows`);
    const minRed = Math.min(...rows.map((row) => Number(row._hard_red_checks_v472 ?? 999)));
    const cleanestTopX = rows.filter((row) => row.prioritized_meta_member_v462 && Number(row._hard_red_checks_v472 ?? 999) === minRed);
    const describe = (row) => `${row.name}${row.prioritized_meta_member_v462 ? "" : " (outside the Top X)"} red ${row._hard_red_checks_v472} yellow ${row._hard_yellow_checks_v472} score ${Number(row.score).toFixed(1)}`;
    const top = (rule) => {
      builder.metaPriority = rule;
      return builder.order(rows.map((row) => ({ ...row })));
    };
    const withRule = top(1);
    const without = top(0);
    console.log(`${start}: one real slot, ${rows.length} rows, fewest red checks ${minRed}`);
    console.log(`  with the rule:    ${withRule.slice(0, 3).map(describe).join(" | ")}`);
    console.log(`  without the rule: ${without.slice(0, 3).map(describe).join(" | ")}`);
    if (cleanestTopX.length) {
      comparable += 1;
      // The promise of the option: once the red checks are settled, the Top X comes first.
      check(Boolean(withRule[0]?.prioritized_meta_member_v462), `${start}: with the rule the slot's best row is outside the Top X: ${describe(withRule[0])} (${cleanestTopX.length} Top-X rows fail as few red checks)`);
    } else {
      console.log("  note: no Top-X row fails as few red checks as the best row, so the Top X may lose here by design");
    }
    const outsideBefore = without.slice(0, 3).filter((row) => !row.prioritized_meta_member_v462).length;
    const outsideAfter = withRule.slice(0, 3).filter((row) => !row.prioritized_meta_member_v462).length;
    check(outsideAfter <= outsideBefore, `${start}: the rule pushed MORE Pokemon from outside the Top X into the best three (${outsideBefore} -> ${outsideAfter})`);
    if (outsideAfter < outsideBefore || without[0]?.name !== withRule[0]?.name) changed += 1;
    builder.metaPriority = AUTOBUILD_META_PRIORITY;
  }
  check(comparable > 0, "no screened slot had a Top-X row failing as few red checks as the best row: the real-data section cannot bite");
  console.log(`the rule changed the best three of ${changed} of 4 screened slots`);
}

// --- 10. two real Auto Builds ------------------------------------------------------------
// The tier order really reaches the result the page reads, and what the rule changes on a
// real build is printed with the usage rank of every added member.
{
  const rankOf = new Map();
  for (const record of meta.pokemon) if (!rankOf.has(compact(record.name))) rankOf.set(compact(record.name), Number(record.position) || 999);
  for (const record of meta.pokemon) for (const value of [record.form, record.species]) if (value && !rankOf.has(compact(value))) rankOf.set(compact(value), Number(record.position) || 999);
  const rankFor = (entry, row) => rankOf.get(compact(entry?.form || entry?.pokemon || "")) ?? rankOf.get(compact(row?.base_name || entry?.pokemon || "")) ?? Number(row?.position) ?? 999;
  const outcomes = [];
  for (const rule of [0, 1]) {
    const run = await new TeamAutoBuild(evaluation).run(teamOf(), {
      search: "medium", depth: "medium", archetype: "automatic", prioritizeMeta: true, autobuildMetaPriority: rule,
    });
    check(!run.error, `rule ${rule}: the build failed (${run.error})`);
    eq(`rule ${rule}: the result carries the tier order it was compared by`, run.search?.objective?.tiers, objectiveTiers(rule));
    eq(`rule ${rule}: the result carries the rule version`, run.search?.objective?.metaPriority, rule);
    check(Number(run.search?.objective?.metaTop) > 0, `rule ${rule}: Prioritize Meta is on but the objective has no Top X`);
    const added = (run.additions || []).map((a) => ({ name: a.entry?.form || a.entry?.pokemon || a.name, rank: rankFor(a.entry, a.row) }));
    outcomes.push({ rule, added, metaOutside: run.summary?.metaOutside ?? null, past100: added.filter((x) => x.rank > 100) });
    console.log(`rule ${rule}: added ${added.map((x) => `${x.name} #${x.rank}`).join(", ") || "(nothing)"} — ${run.summary?.metaOutside ?? "?"} from outside the Top ${run.search.objective.metaTop}`);
  }
  const [off, on] = outcomes;
  check(on.metaOutside <= off.metaOutside, `the rule added MORE members from outside the Top X (${off.metaOutside} -> ${on.metaOutside})`);
  check(on.past100.length <= off.past100.length, `the rule added more members ranked past 100 (${off.past100.map((x) => x.name).join(", ")} -> ${on.past100.map((x) => x.name).join(", ")})`);
}

console.log(`${checked} checked, ${failures.length} failed.`);
for (const line of failures) console.log(`  FAIL ${line}`);
process.exit(failures.length ? 1 : 0);
