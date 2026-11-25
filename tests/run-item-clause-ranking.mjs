// V560: a suggestion is ranked on the set you can actually have
// (builder/item-clause-ranking.js, the port of the app's `item_clause_ranking_v560.py`).
//
//   node tests/run-item-clause-ranking.mjs            everything
//   node tests/run-item-clause-ranking.mjs --quick    the arithmetic, the gate and the source
//
// THE DEFECT, measured on the owner's sand six (Mega Salamence / Mega Tyranitar /
// Corviknight / Excadrill / Indeedee / Sneasler). Of the fourteen rows the Suggestions list
// showed, TEN were scored on an item a REMAINING teammate already holds:
//
//     Swap Corviknight -> Noivern      74.6   Focus Sash   (Excadrill holds it)
//     Swap Corviknight -> Whimsicott   73.6   Focus Sash
//     Swap Corviknight -> Meowscarada  73.4   Choice Scarf (Indeedee holds it)
//     ... ten of fourteen, and 184 of the 638 rows produced, 28.8%
//
// Press Use and the Item Clause swaps the item for the first free one in the same Pokemon's
// battle data, so the set you GET was never the set that was ranked. `suggest-view.js:249`
// says so out loud -- "Another member already holds X, so the check used Y (as Use would)" --
// which is the projection and the ranking disagreeing in the UI.
//
// What is checked here:
//
//   1. the arithmetic, with no data: the item key, who holds what once the swap target is
//      gone, the first free item, the veto, the decision and the two sentences;
//   2. the one constant against the thing it quotes (the 30 held items `projectedImpact` and
//      the app's `_v480_item_options` both ask for);
//   3. the gate: the option coercion, and that the recorded suites replay with it off;
//   4. the SOURCE: the seam is non-auto, stands before V559, and vetoes a replacement V559
//      would refuse -- the three things that make the rule correct rather than merely active;
//   5. end to end on the owner's team, both ways: the ten rows, the 184, the substitutions
//      the list now names, that nothing is lost, and that the projection has stopped
//      apologising.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const quick = process.argv.includes("--quick");

let checked = 0;
const failures = [];
const notes = [];
function ok(label, condition, detail = "") {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
}
function eq(label, got, want) {
  checked += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) failures.push(`${label}\n     got  ${a}\n     want ${b}`);
}
/** A source file with its own comments stripped, so a comment can never satisfy a check. */
function code(...parts) {
  return readFileSync(join(root, ...parts), "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/^\s*\*.*$/, ""))
    .join("\n");
}

const icr = await import("../builder/item-clause-ranking.js");
const {
  DETAIL_SEVERITY, ITEM_CLAUSE_RANKING_RULE, REFUSAL_FIELD, REPLACED_FIELD, ROW_FIELD,
  USAGE_DEPTH, addItemDetail, decideItem, firstFree, forcedSetFor, heldElsewhere,
  itemClauseRankingOn, itemClauseRankingRuleOption, itemKey, itemMember,
  itemMembersFromEntries, itemRefusalSentence, itemSlotOf, substitutionSentence,
} = icr;

// --- 1. the arithmetic ---------------------------------------------------------------------

eq("the item key is the builder's compact", itemKey("Choice Scarf"), "choicescarf");
eq("and it folds punctuation away", itemKey("King's Rock"), "kingsrock");
eq("nothing is nothing", itemKey(null), "");

const SIX = [
  itemMember("Salamence-Mega", "Salamencite"),
  itemMember("Tyranitar-Mega", "Tyranitarite"),
  itemMember("Corviknight", "Psychic Seed"),
  itemMember("Excadrill", "Focus Sash"),
  itemMember("Indeedee", "Choice Scarf"),
  itemMember("Sneasler", "Mental Herb"),
];

// Slot 2 is Corviknight: the row replaces it, so its Psychic Seed is FREED and the other five
// items are not. That is the V524 rule (a row is judged against the team it would leave
// behind) applied to items, and it is the whole reason the swap target's slot is excluded.
const usedAt2 = heldElsewhere(SIX, 2);
eq("the five remaining items are held", [...usedAt2.keys()],
  ["salamencite", "tyranitarite", "focussash", "choicescarf", "mentalherb"]);
eq("and each names its holder", usedAt2.get("focussash"), "Excadrill");
ok("the outgoing Pokemon's item is free", !usedAt2.has("psychicseed"));
ok("an add frees nothing", heldElsewhere(SIX, -1).has("psychicseed"));
eq("an empty slot holds nothing", [...heldElsewhere([itemMember("", "Leftovers"), itemMember("A", "Life Orb")], -1).keys()], ["lifeorb"]);

eq("the first free item is the first one free", firstFree(["Focus Sash", "Life Orb"], usedAt2), "Life Orb");
eq("order is the pool's own", firstFree(["Life Orb", "Leftovers"], usedAt2), "Life Orb");
eq("nothing free is nothing", firstFree(["Focus Sash", "Choice Scarf"], usedAt2), "");
eq("blanks are skipped", firstFree(["", "   ", "Life Orb"], usedAt2), "Life Orb");
// The veto: the other structural rules get to refuse a replacement before it is taken.
eq("a vetoed item is skipped", firstFree(["Aerodactylite", "King's Rock"], usedAt2, (i) => i !== "Aerodactylite"), "King's Rock");
eq("everything vetoed is nothing", firstFree(["Aerodactylite"], usedAt2, () => false), "");

eq("a free item is left exactly alone", decideItem("Life Orb", ["Life Orb"], usedAt2),
  { item: "Life Orb", changed: false, refused: false, holder: "", dropped: "" });
eq("no item at all is nothing to enforce", decideItem("", ["Life Orb"], usedAt2),
  { item: "", changed: false, refused: false, holder: "", dropped: "" });
eq("a held item is replaced, and the holder is named",
  decideItem("Focus Sash", ["Focus Sash", "Life Orb"], usedAt2),
  { item: "Life Orb", changed: true, refused: false, holder: "Excadrill", dropped: "Focus Sash" });
eq("a held item with nothing free is refused",
  decideItem("Focus Sash", ["Focus Sash", "Choice Scarf"], usedAt2),
  { item: "", changed: false, refused: true, holder: "Excadrill", dropped: "Focus Sash" });
// The pool is never consulted when there is nothing to fix, which is why 71.2% of the rows
// on the owner's team cost this rule nothing at all.
let asked = 0;
const counted = new Proxy([], { get(t, k) { if (k === Symbol.iterator) asked += 1; return t[k]; } });
decideItem("Leftovers", counted, usedAt2);
eq("a legal row never reads the pool", asked, 0);

eq("the substitution sentence names all three",
  substitutionSentence("Life Orb", "Focus Sash", "Excadrill"),
  "Scored on Life Orb, not Focus Sash, which Excadrill already holds");
eq("an unnamed holder is still a teammate",
  substitutionSentence("Life Orb", "Focus Sash", ""),
  "Scored on Life Orb, not Focus Sash, which a teammate already holds");
eq("nothing to say is said as nothing", substitutionSentence("", "Focus Sash", "Excadrill"), "");
eq("the refusal sentence says why it is a dead end",
  itemRefusalSentence("Noivern", "Focus Sash", "Excadrill"),
  "not offered: Excadrill already holds Focus Sash and no other item in Noivern's battle data is free");

eq("the members come from the entries under their form name",
  itemMembersFromEntries([{ pokemon: "Tyranitar", form: "Mega Tyranitar", item: "Tyranitarite" }, null]),
  [{ name: "Mega Tyranitar", item: "Tyranitarite" }, { name: "", item: "" }]);
eq("the slot is the row's own, clamped", [itemSlotOf({ slot_index: 2 }, 6), itemSlotOf({ slot_index: 99 }, 6), itemSlotOf({}, 6)], [2, 5, 0]);

// The forced set is the row's OWN set with the item replaced and nothing else touched,
// because that is exactly what Use changes (`_v482_suggestion_unique_item`).
eq("the row's set is reused with one field moved",
  forcedSetFor({ _candidate_set_v113: { item: "Focus Sash", ability: "Frisk", moves: ["Hurricane"], spread: { nature_name: "Timid" } } }, "Life Orb"),
  { item: "Life Orb", ability: "Frisk", moves: ["Hurricane"], spread: { nature_name: "Timid" }, rank: 1, evaluated_count: 1, total_sets: 1 });
eq("a row with no set is rebuilt from the entry it carries",
  forcedSetFor({ candidate_entry: { ability: "Frisk", moves: ["Hurricane", "Draco Meteor", "Protect", "Tailwind", "Roost"] } }, "Life Orb"),
  { ability: "Frisk", moves: ["Hurricane", "Draco Meteor", "Protect", "Tailwind"], item: "Life Orb", rank: 1, evaluated_count: 1, total_sets: 1 });

const detailed = addItemDetail({ details: ["Improves Team Building Checks"] }, "Scored on Life Orb, not Focus Sash, which Excadrill already holds");
eq("the line joins Why it fits", detailed.details.length, 2);
eq("and it is neutral, so it sorts last and colours nothing",
  detailed._v104_detail_severities["scored on life orb, not focus sash, which excadrill already holds"], DETAIL_SEVERITY);
eq("twice is once", addItemDetail(detailed, "Scored on Life Orb, not Focus Sash, which Excadrill already holds").details.length, 2);
eq("nothing to add adds nothing", addItemDetail({ details: ["a"] }, "").details, ["a"]);

// --- 2. the constant, against what it quotes -----------------------------------------------
//
// Three places pick an item out of the same pool and they have to ask for the same depth, or
// the ranking still would not be the ranking Use delivers.
// The pool is recognised by its shape, not by the word "held_item": a replacement pool is a
// `uniqueNames([<the set's item>, ...usage(..., "held_item", N)], 99)` whose first free element
// is taken. Other held-item lookups in this file ask for 3 or 12 and are not pools -- they
// feed candidate sets and threat items, where picking "the first one nobody holds" is not the
// question. Two replacement pools exist: this rule's and `projectedDetail`'s.
const suggestSource = code("builder", "team-suggest.js");
const pools = [...suggestSource.matchAll(/uniqueNames\(\[[^\]]*"held_item",\s*([A-Z_]+|\d+)\)\],\s*99\)/g)]
  .map((m) => m[1]);
eq("there are exactly two replacement pools", pools.length, 2);
ok("and both ask for the same depth this rule quotes",
  pools.every((d) => d === "ITEM_USAGE_DEPTH" || Number(d) === USAGE_DEPTH), JSON.stringify(pools));
eq("the depth is the app's own `_v480_item_options` depth", USAGE_DEPTH, 30);

// --- 3. the gate ---------------------------------------------------------------------------

eq("the rule version", ITEM_CLAUSE_RANKING_RULE, 1);
eq("absent means production", itemClauseRankingRuleOption(undefined), 1);
eq("null means production", itemClauseRankingRuleOption(null), 1);
eq("0 is off", itemClauseRankingRuleOption(0), 0);
eq("false is off", itemClauseRankingRuleOption(false), 0);
eq("\"off\" is off", itemClauseRankingRuleOption("off"), 0);
eq("\"OFF\" is off too", itemClauseRankingRuleOption("OFF"), 0);
eq("an empty string is off", itemClauseRankingRuleOption(""), 0);
eq("1 is on", itemClauseRankingRuleOption(1), 1);
eq("an evaluator with no option is on", itemClauseRankingOn({}), true);
eq("an evaluator switched off is off", itemClauseRankingOn({ itemClauseRankingRule: 0 }), false);

// Every recorded vector was made before this rule, and it moves 28.8% of the rows a scan
// produces -- so a recorded suite that did NOT replay with it off would be comparing a new
// answer against an old recording and calling the difference a regression.
for (const suite of ["run-eval-vectors.mjs", "run-suggest-vectors.mjs", "run-autobuild-vectors.mjs"]) {
  const text = code("tests", suite);
  ok(`${suite} replays with the rule off`, /itemClauseRankingRule:\s*0/.test(text));
}

// --- 4. the source: the three things that make it correct ----------------------------------

const seam = suggestSource.slice(suggestSource.indexOf("let row = inner(meta);"));
const v560At = seam.indexOf("itemClauseRankingOn(this.ev)");
const v559At = seam.indexOf("megaExclusivityOn(this.ev)");
ok("the seam exists", v560At > 0);
ok("it is outside Auto Build", /!auto\s*&&\s*itemClauseRankingOn\(this\.ev\)/.test(seam));
// BEFORE V559, so V559 judges the row this has already fixed. The other order loses rows: a
// candidate whose ranked item is a Mega Stone a teammate holds would be refused as a Mega
// before this rule ever took the stone off it.
ok("and it stands before the Mega cap", v560At > 0 && v559At > v560At, `${v560At} vs ${v559At}`);
ok("a replacement V559 would refuse is vetoed", /megaRefusesRow\([^)]*\{\s*item\b/.test(seam));
ok("the re-evaluation re-enters the same inner pass", /inner\(this\.metaWithSet\(structuredClone\(meta\),\s*set\)\)/.test(seam));
ok("the forced item has to have landed", /compact\(candidate\.item\)\s*!==\s*compact\(verdict\.item\)/.test(seam));
ok("and the clause itself has the last word", /!this\.obeysItemClause\(candidate,\s*context\)/.test(seam));
// Auto Build keeps V482's own handling, which takes a whole non-conflicting SET.
ok("Auto Build still takes a whole set", /nonconflictingSets\(meta,\s*context\)/.test(suggestSource));

if (quick) {
  report();
} else {
  // --- 5. end to end on the owner's team ---------------------------------------------------
  const { DamageEngine, compact } = await import("../builder/engine.js");
  const { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } = await import("../builder/team-eval.js");
  const { TeamEvaluation } = await import("../builder/team-payload.js");
  const { KnownTeams } = await import("../builder/known-teams.js");
  const { makeSet } = await import("../builder/common.js");
  const { TeamSuggestions, SUGGESTION_SCORING } = await import("../builder/team-suggest.js");
  const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));
  const appData = read("data", "builder", "app-data.json");
  const meta = read("data", "builder", "meta-doubles.json");
  const known = new KnownTeams(read("data", "builder", "known-teams.json"));
  const ranked = (meta.pokemon || []).filter((r) => Number(r.position) < 999999).length;

  const SAND = [
    { species: "Salamence", form: "Mega Salamence", item: "Salamencite", ability: "Aerilate", nature: "Timid", moves: ["Hyper Voice", "Draco Meteor", "Flamethrower", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Tyranitar", form: "Mega Tyranitar", item: "Tyranitarite", ability: "Sand Stream", nature: "Jolly", moves: ["Rock Slide", "Knock Off", "Low Kick", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
    { species: "Corviknight", form: "Corviknight", item: "Psychic Seed", ability: "Mirror Armor", nature: "Careful", moves: ["Brave Bird", "Power Trip", "Bulk Up", "Roost"], bonuses: [0, 32, 0, 0, 2, 32] },
    { species: "Excadrill", form: "Excadrill", item: "Focus Sash", ability: "Sand Rush", nature: "Adamant", moves: ["Iron Head", "Protect", "Rock Slide", "High Horsepower"], bonuses: [0, 32, 1, 0, 1, 32] },
    { species: "Indeedee", form: "Indeedee", item: "Choice Scarf", ability: "Psychic Surge", nature: "Modest", moves: ["Expanding Force", "Mystical Fire", "Trick", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Sneasler", form: "Sneasler", item: "Mental Herb", ability: "Unburden", nature: "Adamant", moves: ["Dire Claw", "Close Combat", "Coaching", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
  ];

  const scan = (rule) => {
    const ev = new TeamEvaluator(null, new DamageEngine(appData), "Doubles",
      normalizeSettings({ ...DEFAULT_SETTINGS }, ranked), { itemClauseRankingRule: rule });
    ev.setMetaRecords(meta.pokemon || []);
    const mk = () => { const e = new TeamEvaluation(ev); e.knownTeams = known; return e; };
    const payload = mk().evaluate(Array.from({ length: 6 }, (_, i) => makeSet(SAND[i])), { checkSelection: null });
    const sg = new TeamSuggestions(mk(), { suggestionScoring: SUGGESTION_SCORING });
    const base = Object.getPrototypeOf(sg).evaluateCandidate;
    const produced = [];
    let clashes = 0;
    sg.evaluateCandidate = function (m, ctx) {
      const row = base.call(this, m, ctx);
      if (row) {
        produced.push(`${String(m.name)}|${String(ctx.swapTarget || "ADD")}`);
        if (!this.obeysItemClause(row, ctx)) clashes += 1;
      }
      return row;
    };
    const out = sg.run(payload, {});
    return { out, produced, clashes, sg, payload, sets: Array.from({ length: 6 }, (_, i) => makeSet(SAND[i])) };
  };

  const off = scan(0);
  const on = scan(undefined);
  const shownClashes = ({ out }) => out.rows.filter((row) => {
    const slot = itemSlotOf(row, 6);
    return SAND.some((s, i) => i !== slot && compact(s.item) === compact(row.item));
  }).length;

  notes.push(`shown rows on an item a teammate holds: ${shownClashes(off)} of ${off.out.rows.length}`
    + ` -> ${shownClashes(on)} of ${on.out.rows.length}`);
  notes.push(`rows produced: ${off.produced.length} -> ${on.produced.length}`
    + `   clashing: ${off.clashes} -> ${on.clashes}`);

  eq("the defect is still exactly what was reported: ten of fourteen", shownClashes(off), 10);
  eq("and the rule leaves none of them", shownClashes(on), 0);
  eq("the scan's own clash count, measured", off.clashes, 184);
  eq("and the rule leaves none of those either", on.clashes, 0);
  // Correcting a row must not COST a row. The first free item for Aerodactyl, Blaziken and
  // Audino on this team is their own Mega Stone, and before the V559 veto was wired into the
  // replacement choice all three lost both their rows to the Mega cap.
  eq("nothing is lost", on.produced.length, off.produced.length);
  eq("and nothing is invented", [...new Set(on.produced)].filter((k) => !new Set(off.produced).has(k)), []);
  for (const name of ["Aerodactyl", "Blaziken", "Audino"]) {
    ok(`${name} is still offered, on an item that is not its own stone`,
      on.produced.includes(`${name}|Corviknight`));
  }

  // The rows the owner was shown, and what they are now scored on. These are the measurement,
  // so they are named: the order changed in BOTH directions, which is why re-ranking was the
  // fix and a flat penalty would not have been.
  const rowFor = (run, name) => run.out.rows.find((r) => compact(r.name) === compact(name));
  for (const [name, from, to] of [["Noivern", "Focus Sash", "Life Orb"],
    ["Decidueye", "Focus Sash", "Life Orb"], ["Meowscarada", "Choice Scarf", "Life Orb"],
    ["Talonflame", "Focus Sash", "Sharp Beak"], ["Pelipper", "Focus Sash", "Damp Rock"]]) {
    const was = rowFor(off, name);
    const now = rowFor(on, name);
    ok(`${name} was ranked on ${from}`, was && compact(was.item) === compact(from), was?.item);
    ok(`${name} is now ranked on ${to}`, now && compact(now.item) === compact(to), now?.item);
    eq(`${name} says which item it swapped and whose it was`,
      now?.[REPLACED_FIELD], { from, to, holder: name === "Meowscarada" ? "Indeedee" : "Excadrill" });
    ok(`${name} says so in Why it fits`,
      (now?.details || []).includes(substitutionSentence(to, from, now?.[REPLACED_FIELD]?.holder)));
  }
  // Up as well as down: a flat charge for "the item is taken" could not have done this.
  ok("Decidueye rose once it was scored on the item it gets",
    rowFor(on, "Decidueye").score > rowFor(off, "Decidueye").score,
    `${rowFor(off, "Decidueye").score} -> ${rowFor(on, "Decidueye").score}`);
  ok("Squawkabilly fell", rowFor(on, "Squawkabilly").score < rowFor(off, "Squawkabilly").score,
    `${rowFor(off, "Squawkabilly").score} -> ${rowFor(on, "Squawkabilly").score}`);
  ok("and the order of the list changed with them",
    off.out.rows.map((r) => r.name).join(",") !== on.out.rows.map((r) => r.name).join(","));
  ok("a row that never conflicted is untouched",
    rowFor(off, "Milotic").score === rowFor(on, "Milotic").score,
    `${rowFor(off, "Milotic").score} -> ${rowFor(on, "Milotic").score}`);
  eq("and it is marked as checked rather than changed",
    [rowFor(on, "Milotic")[ROW_FIELD], rowFor(on, "Milotic")[REPLACED_FIELD]], [true, undefined]);
  eq("the rule off marks nothing", [rowFor(off, "Milotic")[ROW_FIELD], rowFor(off, "Noivern")[REPLACED_FIELD]], [undefined, undefined]);
  ok("no shown row was refused", on.out.rows.every((row) => row[REFUSAL_FIELD] === undefined));

  // The projection has stopped apologising. `projectedDetail` picks the honest item for the
  // Team Evaluation preview; once the ranking picks the same one, `item_changed` is empty --
  // which is the ranking and the projection agreeing, stated as a measurement.
  const apologies = (run) => run.out.rows
    .map((row) => run.sg.projectedDetail(row, run.sets, run.payload, { checkSelection: null })?.item_changed)
    .filter(Boolean).length;
  const was = apologies(off);
  const now = apologies(on);
  notes.push(`projection "already holds" notes: ${was} -> ${now}`);
  eq("the projection apologised on ten rows", was, 10);
  eq("and now on none", now, 0);

  report();
}

function report() {
  for (const note of notes) console.log(`  ${note}`);
  if (failures.length) {
    console.error(`\nitem clause ranking: ${failures.length} of ${checked} checks FAILED\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\nitem clause ranking: ${checked} checks passed${quick ? " (--quick)" : ""}`);
}
