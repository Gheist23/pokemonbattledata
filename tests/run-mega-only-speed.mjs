// V562: the Speed list shows only the Mega for a species that almost never plays without its stone.
//
// THE DEFECT. Every Top-X Pokemon gets a row for its common set and another for each of its top
// five held items that matters, Choice Scarf among them. Salamence holds Salamencite 96.6% of the
// time in Doubles and Choice Scarf 0.3%, so the list carried a "Salamence @ Choice Scarf" row --
// and at 250 Speed it was the FASTEST row in the whole list, i.e. the Speed Tiers panel's answer
// to "what do I need to outrun" was a set almost nobody brings.
//
// WHAT THIS SUITE IS FOR. `run-overview-vectors` compares `rows()` against app recordings made
// before this rule, so it replays with the rule off (section 7 asserts that stamp is still
// there); nothing else exercises the rule at all. Everything above section 7 is its only cover.
//
// THE ASSERTIONS ARE RELATIVE, NOT PINNED PERCENTAGES. The bundled battle data is refreshed
// daily on the site, so "Salamence is 96.6%" would go red on a data change with no defect behind
// it. What is pinned instead is the SHAPE: a species above the cutoff has only Mega rows, one
// below it keeps its others, and the cutoff itself is 95.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, compact } from "../builder/engine.js";
import { BuilderData } from "../builder/common.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { MEGA_ONLY_RULE, MEGA_ONLY_SHARE, SpeedTiers, megaOnlyRuleOption } from "../builder/speed-tiers.js";
import { GUARANTEED_MOVE_SHARE } from "../builder/guaranteed-moves.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => JSON.parse(readFileSync(join(root, ...p), "utf8"));
const appData = read("data", "builder", "app-data.json");

let checked = 0;
const failures = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const isMega = (form) => /^mega[\s-]/i.test(String(form || ""));
const TOP = 30;

function world(format, metaFile) {
  const metaData = read("data", "builder", metaFile);
  const data = new BuilderData(appData);
  data.ingestMeta(format, metaData);
  const engine = new DamageEngine(appData);
  const make = (off) => {
    const ev = new TeamEvaluator(data, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: TOP }), {});
    ev.setMetaRecords(metaData.pokemon || []);
    if (off) ev.megaOnlyRule = 0;
    return new SpeedTiers(ev, data);
  };
  return { metaData, data, engine, on: make(false), off: make(true) };
}

const doubles = world("Doubles", "meta-doubles.json");
/** One of our own, so `ourVariants` is exercised alongside the meta list. */
const OURS = [{ species: "Milotic", form: "Milotic", item: "Leftovers", ability: "Competitive", nature: "Calm", bonuses: [32, 0, 17, 8, 5, 4], moves: ["Scald"] }];
const rowKey = (r) => `${r.ours ? "our" : "meta"} ${r.mon.form_name} @ ${r.mon.item || "-"} / ${r.mon.ability}${r.info.variant_label ? ` [${r.info.variant_label}]` : ""}`;

// --- 1. the gate --------------------------------------------------------------------------
{
  ok("production is on", MEGA_ONLY_RULE === 1);
  ok("the cutoff is 95", MEGA_ONLY_SHARE === 95);
  // Not a coincidence worth losing: this is the project's existing "almost everybody" cutoff.
  ok("and it is the same cutoff as the guaranteed-move rule", MEGA_ONLY_SHARE === GUARANTEED_MOVE_SHARE,
    `${MEGA_ONLY_SHARE} vs ${GUARANTEED_MOVE_SHARE}`);
  ok("an absent option means production", megaOnlyRuleOption(undefined) === 1 && megaOnlyRuleOption(null) === 1);
  for (const off of [0, "0", false, "off", "false", "no", "none", ""]) {
    ok(`${JSON.stringify(off)} turns it off`, megaOnlyRuleOption(off) === 0, String(megaOnlyRuleOption(off)));
  }
  for (const on of [1, "1", true, "on"]) ok(`${JSON.stringify(on)} leaves it on`, megaOnlyRuleOption(on) === 1);
  // Both channels: the constructor's own option, and the evaluator every caller already holds.
  const viaCtor = new SpeedTiers(doubles.on.ev, doubles.data, { megaOnlyRule: 0 });
  ok("the constructor option turns it off", viaCtor.megaOnlySpecies(TOP).size === 0);
  ok("the evaluator turns it off", doubles.off.megaOnlySpecies(TOP).size === 0);
  ok("and production catches somebody", doubles.on.megaOnlySpecies(TOP).size > 0);
}

// --- 2. the share is SUMMED over the species' own stones ----------------------------------
{
  const record = { items: [["Charizardite X", 50], ["Charizardite Y", 48], ["Life Orb", 2]] };
  ok("two stones for one species add up", doubles.on.stoneShare(record, "Charizard") === 98,
    String(doubles.on.stoneShare(record, "Charizard")));
  ok("a non-stone is not counted", doubles.on.stoneShare({ items: [["Life Orb", 90]] }, "Charizard") === 0);
  ok("another species' stone is not counted",
    doubles.on.stoneShare({ items: [["Salamencite", 99]] }, "Charizard") === 0,
    String(doubles.on.stoneShare({ items: [["Salamencite", 99]] }, "Charizard")));
  ok("no items is zero, not a crash", doubles.on.stoneShare({}, "Charizard") === 0 && doubles.on.stoneShare(null, "Charizard") === 0);
  ok("a malformed row is skipped", doubles.on.stoneShare({ items: [null, ["", 50], ["Salamencite", "x"]] }, "Salamence") === 0);
}

// --- 3. the cutoff is doing real work -----------------------------------------------------
// Every Top-X record, split by the rule, and every one checked against its own measured share:
// nothing above the cutoff may be missed and nothing below it may be caught.
{
  const caught = doubles.on.megaOnlySpecies(TOP);
  const records = (doubles.on.ev.metaRecords || []).filter((r) => Number(r.position) < 999999).slice(0, TOP);
  let above = 0;
  let below = 0;
  for (const record of records) {
    const species = String(record.species || record.name);
    const share = doubles.on.stoneShare(record, species);
    const inSet = caught.has(compact(species));
    if (share >= MEGA_ONLY_SHARE) {
      above += 1;
      ok(`${species} at ${share.toFixed(1)}% is caught`, inSet);
    } else {
      below += 1;
      ok(`${species} at ${share.toFixed(1)}% is not caught`, !inSet);
    }
  }
  ok("some species are above the cutoff", above > 0, String(above));
  // The interesting half: if nothing were below it, the cutoff would be decoration.
  ok("and some are below it, so the cutoff is not a no-op", below > 0, String(below));
  ok("a species that holds no stone at all is never caught",
    records.filter((r) => doubles.on.stoneShare(r, String(r.species || r.name)) === 0)
      .every((r) => !caught.has(compact(String(r.species || r.name)))));
}

// --- 4. what the shown list loses, and what it must not lose ------------------------------
{
  const off = doubles.off.rows(OURS, { top_x: TOP });
  const on = doubles.on.rows(OURS, { top_x: TOP });
  const offKeys = off.rows.map(rowKey);
  const onKeys = on.rows.map(rowKey);
  const removed = offKeys.filter((k) => !onKeys.includes(k));
  const added = onKeys.filter((k) => !offKeys.includes(k));

  ok("the rule only removes rows, never adds one", added.length === 0, added.join(" | "));
  ok("and it removes some", removed.length > 0, String(removed.length));
  // Every removed row has to be a non-Mega row of a caught species. Anything else is collateral.
  const caught = doubles.on.megaOnlySpecies(TOP);
  for (const r of off.rows) {
    const key = compact(r.mon.pokemon_name);
    const gone = !onKeys.includes(rowKey(r));
    const should = !r.ours && caught.has(key) && !isMega(r.mon.form_name);
    ok(`${rowKey(r)} is ${should ? "removed" : "kept"}`, gone === should);
  }
  // No caught species may VANISH from the list, and what is left of it must be its Mega.
  for (const key of caught) {
    const mine = on.rows.filter((r) => !r.ours && compact(r.mon.pokemon_name) === key);
    ok(`${key} is still in the list`, mine.length > 0);
    ok(`${key} is shown only as its Mega`, mine.every((r) => isMega(r.mon.form_name)),
      mine.map((r) => r.mon.form_name).join(", "));
  }
  ok("the Top X in the summary is unchanged", on.summary === off.summary, `${on.summary} vs ${off.summary}`);
  ok("and the list is still sorted fastest first",
    on.rows.every((r, i) => i === 0 || on.rows[i - 1].speed >= r.speed));
}

// --- 5. our own team is never filtered ----------------------------------------------------
// "the pokemon that are not on our team" is settled by WHICH list the filter is applied to:
// `metaVariants` is the opponent's side, `ourVariants` is the team as the player built it.
{
  const caught = [...doubles.on.megaOnlySpecies(TOP)];
  ok("there is a caught species to build one of", caught.length > 0);
  // A Scarf Salamence of our own: the exact row the rule deletes from the opponent's side.
  const mine = [{ species: "Salamence", form: "Salamence", item: "Choice Scarf", ability: "Intimidate", nature: "Jolly", bonuses: [2, 32, 0, 0, 0, 32], moves: ["Dragon Claw"] }];
  const rows = doubles.on.rows(mine, { top_x: TOP }).rows.filter((r) => r.ours);
  ok("our own non-Mega set is kept", rows.length === 1, String(rows.length));
  ok("as itself, not turned into a Mega", rows[0] && !isMega(rows[0].mon.form_name) && compact(rows[0].mon.item) === "choicescarf",
    rows[0] ? rowKey(rows[0]) : "no row");
}

// --- 6. the benchmark list the Optimize objective tunes against is untouched ---------------
// builder/optimize-objective.js and builder/optimize-deep.js call metaVariants() directly. What
// a BENCHMARK list should hold is a different question from what a panel should show, so the
// rule deliberately stops at `rows()`. If that ever changes, those two read a shorter list and
// their recorded suites move -- so this is the assertion that says the decision still holds.
{
  const onRows = doubles.on.metaVariants(TOP).map(([mon, info]) => rowKey({ mon, info, ours: false }));
  const offRows = doubles.off.metaVariants(TOP).map(([mon, info]) => rowKey({ mon, info, ours: false }));
  ok("metaVariants is identical with the rule on and off", onRows.join("|") === offRows.join("|"),
    `${onRows.length} vs ${offRows.length}`);
  ok("and it still holds the rows rows() drops", onRows.length > doubles.on.rows(OURS, { top_x: TOP }).rows.filter((r) => !r.ours).length);
}

// --- 7. the species can never vanish, even with no Mega row to keep -----------------------
// Nothing in today's data reaches this: all of the caught species have a Mega row. It is one
// upstream change away, though -- the baseline row is base-formed when the common Ability is a
// Speed Ability -- and a Pokemon silently leaving the Speed list is worse than a stale row.
{
  const species = new Set(["fakemon"]);
  const base = [[{ pokemon_name: "Fakemon", form_name: "Fakemon", item: "Choice Scarf", ability: "Blaze" }, { position: 1, variant_label: "" }]];
  const kept = doubles.on.keepMegaOnly(base, species);
  ok("a caught species with no Mega row keeps its row", kept.length === 1, String(kept.length));
  const mixed = [
    [{ pokemon_name: "Fakemon", form_name: "Fakemon", item: "Choice Scarf", ability: "Blaze" }, { position: 1, variant_label: "Choice Scarf" }],
    [{ pokemon_name: "Fakemon", form_name: "Mega Fakemon", item: "Fakemonite", ability: "Drought" }, { position: 1, variant_label: "" }],
    [{ pokemon_name: "Other", form_name: "Other", item: "Life Orb", ability: "Blaze" }, { position: 2, variant_label: "" }],
  ];
  const trimmed = doubles.on.keepMegaOnly(mixed, species);
  ok("with a Mega row present the base one goes", trimmed.length === 2);
  ok("the Mega is the one kept", trimmed.some(([m]) => m.form_name === "Mega Fakemon"));
  ok("and another species is untouched", trimmed.some(([m]) => m.pokemon_name === "Other"));
  ok("an empty caught set is a no-op", doubles.on.keepMegaOnly(mixed, new Set()) === mixed);
}

// --- 8. per format, and the recorded suite replays its own world ---------------------------
{
  // The same Pokemon can be Mega-only in one format and not the other, which is the clearest
  // sign the rule is reading usage rather than a hard-coded list.
  let singles = null;
  try {
    singles = world("Singles", "meta-singles.json");
  } catch {
    singles = null;
  }
  ok("Singles data is available", Boolean(singles));
  if (singles) {
    const d = doubles.on.megaOnlySpecies(TOP);
    const s = singles.on.megaOnlySpecies(TOP);
    ok("Singles catches somebody too", s.size > 0);
    const differs = [...d].some((k) => !s.has(k)) || [...s].some((k) => !d.has(k));
    ok("and the two formats do not catch the same set", differs,
      `doubles ${[...d].join(",")} vs singles ${[...s].join(",")}`);
  }

  const suite = readFileSync(join(here, "run-overview-vectors.mjs"), "utf8");
  ok("run-overview-vectors replays with the rule off", /megaOnlyRule\s*=\s*0|megaOnlyRule:\s*0/.test(suite));
}

console.log(`${checked} checked, ${failures.length} failed`);
for (const line of failures) console.log(`  FAIL ${line}`);
process.exit(failures.length ? 1 : 0);
