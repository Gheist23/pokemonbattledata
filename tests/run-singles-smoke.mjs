// Singles smoke test: every Team Builder analysis once in Singles (meta-singles.json),
// checked for sane output and for the Singles rules the site adds on top of the app's
// Doubles-first analysis:
//   - no Spread Damage check, no "Spread attackers" / "Redirection / Fake Out" archetype
//     requirements, Perish Trap asks for trapping; partner-only moves count for no group
//   - no Synergy that needs both Pokemon on the field (friendly fire, Fake Out or
//     redirection covering a turn, Helping Hand, ally Abilities, Commander)
//   - no Plus/Minus partner condition, no "Found in similar team" bonus (Doubles library)
//   - Top X capped at the Singles ranked count, Speed list from the Singles meta
// It also runs the same team in Doubles to make sure those rules stay Singles-only.
//
//   node tests/run-singles-smoke.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, makeContext } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamChecks, archetypeRequirements } from "../builder/team-checks.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { TeamAutoBuild } from "../builder/team-autobuild.js";
import { DeepOptimizer } from "../builder/optimize-deep.js";
import { SpeedTiers } from "../builder/speed-tiers.js";
import { teamOverview } from "../builder/team-overview.js";
import { topMetaSize } from "../builder/autobuild-archetype.js";
import { KnownTeams } from "../builder/known-teams.js";
import { makeSet } from "../builder/common.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));
const appData = read("data", "builder", "app-data.json");
const known = new KnownTeams(read("data", "builder", "known-teams.json"));
const engine = new DamageEngine(appData);
const TOP = 30;

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const finite = (v, lo = 0, hi = 100) => Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;
const time = async (label, fn) => {
  const started = Date.now();
  const out = await fn();
  console.log(`  ${label}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return out;
};

function evaluationFor(format, top = TOP) {
  const meta = read("data", "builder", `meta-${format.toLowerCase()}.json`);
  const ranked = (meta.pokemon || []).filter((r) => Number(r.position) < 999999).length;
  const ev = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: top }, ranked));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  evaluation.knownTeams = known;
  return { ev, evaluation, meta, ranked };
}

// A Singles-style core with the moves the Singles rules are about: a spread move
// (Earthquake), a partner-only move (Helping Hand), pivoting, Fake Out, Intimidate.
const TEAM = [
  { species: "Garchomp", form: "Garchomp", item: "Rocky Helmet", ability: "Rough Skin", nature: "Jolly", moves: ["Earthquake", "Dragon Claw", "Stealth Rock", "Swords Dance"], bonuses: [2, 32, 0, 0, 0, 32] },
  { species: "Primarina", form: "Primarina", item: "Sitrus Berry", ability: "Liquid Voice", nature: "Modest", moves: ["Moonblast", "Sparkling Aria", "Aqua Jet", "Helping Hand"], bonuses: [32, 0, 0, 32, 2, 0] },
  { species: "Corviknight", form: "Corviknight", item: "Leftovers", ability: "Pressure", nature: "Impish", moves: ["Roost", "Body Press", "U-turn", "Iron Defense"], bonuses: [32, 0, 32, 0, 2, 0] },
  { species: "Incineroar", form: "Incineroar", item: "Assault Vest", ability: "Intimidate", nature: "Careful", moves: ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"], bonuses: [32, 0, 2, 0, 32, 0] },
];
const sets = [...TEAM.map((s) => makeSet(s)), null, null];

const S = evaluationFor("Singles");
const D = evaluationFor("Doubles");
console.log(`Singles meta: ${S.ranked} ranked Pokémon, Top ${S.ev.settings.top_meta}`);

// --- Team Evaluation ---------------------------------------------------------------------
const singles = await time("Singles evaluation", () => S.evaluation.evaluate(sets));
const doubles = await time("Doubles evaluation (same team)", () => D.evaluation.evaluate(sets));
for (const key of ["synergy_score", "offense_score", "defense_score"]) check(`Singles ${key} is a score`, finite(singles[key]), String(singles[key]));
check("Singles Speed score is a score", finite(singles.speed?.score), String(singles.speed?.score));
check("Singles evaluation lists critical threats", Array.isArray(singles.threats) && singles.threats.length > 0, String(singles.threats?.length));
// Each threat is the Singles meta's row at its rank (a Mega or regional form carries its species' name).
const key = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const fromSingles = (t) => {
  const row = S.meta.pokemon.find((r) => Number(r.position) === Number(t.position));
  return Boolean(row) && Number(t.position) <= TOP && key(t.name).includes(key(row.species));
};
check("Singles threats come from the Singles Top 30", singles.threats.every(fromSingles), singles.threats.filter((t) => !fromSingles(t)).map((t) => `${t.name}#${t.position}`).join(", "));
const rowIds = (payload) => payload.checks.rows.map((r) => r.check_id);
check("Singles has no Spread Damage check", !rowIds(singles).includes("spread_damage"), rowIds(singles).join(","));
check("Doubles keeps the Spread Damage check", rowIds(doubles).includes("spread_damage"), rowIds(doubles).join(","));
const singlesText = singles.checks.rows.map((r) => [r.text, r.why_v203, r.fix_v203].join(" ")).join(" ");
check("Singles check texts do not talk about Doubles", !/doubles|\bVGC\b|redirection|Follow Me|both opposing/i.test(singlesText), (singlesText.match(/[^.]*(doubles|VGC|redirection|Follow Me|both opposing)[^.]*/i) || [""])[0]);
const archetype = singles.checks.rows.find((r) => r.check_id === "archetype_fit");
check("Singles archetype row is there", Boolean(archetype));
check("Singles archetype has no spread or redirection requirement",
  !(archetype?.archetype_requirements_v403 || []).some((r) => /spread|redirection/i.test(r.label)), (archetype?.archetype_requirements_v403 || []).map((r) => r.label).join(", "));

// Profiles: Helping Hand counts for nothing, Earthquake is no spread move.
const checksS = new TeamChecks(S.ev);
const checksD = new TeamChecks(D.ev);
const [garchompS] = singles.slots;
const profileS = checksS.profile(garchompS.entry, garchompS.mon);
const profileD = checksD.profile(garchompS.entry, garchompS.mon);
check("Earthquake is a spread move only in Doubles", profileS.spread === false && profileD.spread === true, `${profileS.spread}/${profileD.spread}`);
const primS = checksS.profile(singles.slots[1].entry, singles.slots[1].mon);
const primD = checksD.profile(singles.slots[1].entry, singles.slots[1].mon);
check("Helping Hand is utility only in Doubles", !primS.utility.has("Damage Support") && primD.utility.has("Damage Support"), `${[...primS.utility]} / ${[...primD.utility]}`);

// Archetype requirements: the Singles lists.
const featuresS = { ...checksS.archetypeFeatures(checksS.profiles(singles.slots.map(({ entry, mon }) => ({ entry, mon })))) };
check("Singles features carry the Singles flag", featuresS.singles === true && !("singles" in checksD.archetypeFeatures(checksD.profiles(doubles.slots))));
for (const key of ["offense", "hyper offense", "trick room", "tailwind", "setup"]) {
  const labels = archetypeRequirements(key, featuresS).map((r) => r.label);
  check(`Singles ${key} requirements drop spread/redirection`, !labels.some((l) => /spread|redirection/i.test(l)), labels.join(", "));
}
const perish = archetypeRequirements("perish trap", featuresS).map((r) => r.label);
check("Singles Perish Trap asks for trapping", perish.includes("Trapping users") && !perish.includes("Redirection users"), perish.join(", "));
check("Doubles Perish Trap keeps redirection", archetypeRequirements("perish trap", checksD.archetypeFeatures(checksD.profiles(doubles.slots))).some((r) => r.label === "Redirection users"));
const list = new TeamChecks({ engine, format: "Singles" }).checkList();
check("Customize list says Spread Damage is Doubles only in Singles", /Doubles only/.test(list.find((c) => c.id === "spread_damage")?.description || ""));
check("Customize list keeps the app's text in Doubles", !/Doubles only/.test(new TeamChecks({ engine }).checkList().find((c) => c.id === "spread_damage")?.description || ""));

// V514: the two new rows, and the one that has no meaning with one Pokemon a side.
check("Doubles has the Coverage Gaps row", rowIds(doubles).includes("coverage_gaps"), rowIds(doubles).join(","));
check("Doubles has the Speed Tiers row", rowIds(doubles).includes("speed_tiers"), rowIds(doubles).join(","));
check("Doubles has the Lead Viability row", rowIds(doubles).includes("lead_viability"), rowIds(doubles).join(","));
check("Singles keeps Coverage Gaps and Speed Tiers",
  rowIds(singles).includes("coverage_gaps") && rowIds(singles).includes("speed_tiers"), rowIds(singles).join(","));
check("Singles has no Lead Viability row (there is no pair to score)",
  !rowIds(singles).includes("lead_viability"), rowIds(singles).join(","));
// AND THE CUSTOMIZE LIST SAYS SO. A skipped check that is still offered, still tickable and
// still described in terms of fifteen lead PAIRS leaves the player with a check they switched
// on and no row -- the silent state SINGLES_DESCRIPTIONS exists to prevent, and which
// spread_damage has had a sentence for since the Singles rules landed.
{
  const singlesList = new TeamChecks({ engine, format: "Singles" }).checkList();
  const lead = singlesList.find((c) => c.id === "lead_viability")?.description || "";
  check("Customize list says Lead Viability is Doubles only in Singles", /^Doubles only:/.test(lead), lead);
  check("and says it is skipped", /this check is skipped/.test(lead), lead);
  // The "Doubles only" qualifier comes BEFORE the fifteen pairs, so a Singles player never
  // reads a promise about their lead pairs without it -- the same shape spread_damage uses.
  check("the Doubles-only qualifier comes before the fifteen pairs",
    lead.indexOf("Doubles only") === 0 && lead.indexOf("fifteen lead pairs") > 0, lead);
  const doublesLead = new TeamChecks({ engine }).checkList().find((c) => c.id === "lead_viability")?.description || "";
  check("Doubles keeps the app's own Lead Viability text", !/Doubles only/.test(doublesLead), doublesLead);
  // The gate is inside the check, the layer the app gates at, so a direct call agrees too.
  check("calling checkLeadViability directly in Singles returns no row",
    new TeamChecks({ engine, format: "Singles" }).checkLeadViability([]) === null);
}
// The price of declaring the V514 ids, labels and descriptions locally instead of waiting
// for the app-data.json export (deviation D14): a test holds the two declarations together.
// The fixture's `labels` map was written by the app.
{
  const fixture = read("tests", "team-check-fixture-v514.json");
  const onList = new TeamChecks({ engine }).checkList();
  for (const [id, label] of Object.entries(fixture.labels)) {
    const entry = onList.find((c) => c.id === id);
    check(`the website's label for ${id} is the app's`, entry?.label === label, `${entry?.label} vs ${label}`);
  }
  check("Shared Weakness keeps the id defensive_switch_ins",
    onList.some((c) => c.id === "defensive_switch_ins" && c.label === "Shared Weakness"));
}

// Synergy: nothing that needs both Pokemon on the field.
const pairRows = (payload) => (payload.synergy?.pairs || payload.synergy_pairs?.pairs || []).flatMap((p) => [...p.interactions, ...p.conflicts]);
const synergyS = singles.synergy || {};
check("Singles evaluation has Synergy pairs", (synergyS.pairs || []).length === 6, String((synergyS.pairs || []).length));
const together = /friendly-fire|adjacent partner|partner super effectively|Fake Out creates|redirects single-target|Helping Hand|both opponents' Attack|also hits|beside/i;
const bad = pairRows(singles).filter((r) => together.test(`${r.title} ${r.detail}`) || r.mechanism === "spread" || r.category === "spread");
check("Singles Synergy has no partner-on-the-field interactions", bad.length === 0, bad.map((r) => r.title).slice(0, 4).join(" | "));
check("Doubles Synergy still has them for this team", pairRows(doubles).some((r) => together.test(`${r.title} ${r.detail}`) || r.mechanism === "spread" || r.category === "spread"));

// Plus/Minus needs a partner.
const plusAxes = (evx) => evx.conditionAxes({ ability: "Plus" }, { ability: "" }, makeContext({ move_name: "Thunderbolt", battle_format: evx.format })).map(([name]) => name);
check("No Plus/Minus partner condition in Singles", !plusAxes(S.ev).includes("plus_minus_partner") && plusAxes(D.ev).includes("plus_minus_partner"), `${plusAxes(S.ev)} / ${plusAxes(D.ev)}`);

// --- Top X and Speed ---------------------------------------------------------------------
const all = evaluationFor("Singles", 100000);
check("Top X is capped at the Singles ranked count", all.ev.settings.top_meta === S.ranked && topMetaSize(all.ev) === S.ranked, `${all.ev.settings.top_meta} / ${topMetaSize(all.ev)} / ${S.ranked}`);
const tiers = new SpeedTiers(S.ev).rows(TEAM.map((s) => makeSet(s)), { top_x: TOP });
const ours = tiers.rows.filter((r) => r.ours);
check("Speed list has our four and the Top 30", ours.length === 4 && tiers.rows.length >= TOP + 4, `${ours.length} ours, ${tiers.rows.length} rows`);
check("Speed list is fastest first", tiers.rows.every((r, i) => i === 0 || tiers.rows[i - 1].speed >= r.speed));
check("Speed list reads the Singles meta", tiers.rows.some((r) => !r.ours && r.info.position === 1 && r.mon.pokemon_name === S.meta.pokemon[0].species), S.meta.pokemon[0].species);
const room = new SpeedTiers(S.ev).rows(TEAM.map((s) => makeSet(s)), { top_x: TOP, trick_room: true });
check("Trick Room order is slowest first", room.rows.every((r, i) => i === 0 || room.rows[i - 1].speed <= r.speed));

// --- Team Overview -----------------------------------------------------------------------
const overview = teamOverview(S.evaluation, sets, TOP);
check("Overview is scored against the Top 30", overview.top_x === TOP && !overview.empty, `${overview.top_x} ${overview.empty}`);
check("Overview charts cover the 18 types", Object.keys(overview.offense_chart || {}).length === 18 && Object.keys(overview.defense_chart || {}).length === 18);
check("Overview pressure is a score", finite(overview.team_to_meta?.score) && finite(overview.meta_to_team?.score), `${overview.team_to_meta?.score} ${overview.meta_to_team?.score}`);

// --- Suggestions ---------------------------------------------------------------------------
const suggestions = new TeamSuggestions(S.evaluation);
const run = await time("Singles suggestions", () => suggestions.run(singles, { selection: null }));
check("Suggestions returns rows", run.rows.length > 0, String(run.rows.length));
check("Suggestion scores are scores", run.rows.every((r) => finite(r.score)), run.rows.map((r) => r.score).join(","));
check("Suggestions fill the open slot", run.empty_slot === 4, String(run.empty_slot));
check("No 'Found in similar team' bonus in Singles", run.rows.every((r) => !r.found_in_team_v496), run.rows.filter((r) => r.found_in_team_v496).map((r) => r.name).join(", "));
const reasons = run.rows.flatMap((r) => r.details || []).join(" | ");
check("Suggestion reasons never name the Spread Damage check", !/Spread Damage/i.test(reasons), (reasons.match(/[^|]*Spread Damage[^|]*/i) || [""])[0]);
const top = run.rows[0];
const detail = await time("projected detail of the first suggestion", () => suggestions.projectedDetail(top, sets, singles, {}));
check("Projected detail has before/after scores", finite(detail?.scores?.before?.synergy) && finite(detail?.scores?.after?.synergy), JSON.stringify(detail?.scores || detail).slice(0, 200));

// --- Optimize (Quick) ---------------------------------------------------------------------
const optimized = await time("Singles Optimize Quick (Garchomp)", () => new DeepOptimizer(S.evaluation).run(sets, 0, { depth: "quick", topX: TOP }, {}));
check("Optimize finishes", optimized.ok === true, optimized.message || "");
check("Optimize keeps a legal spread", (optimized.after?.bonuses || []).reduce((a, b) => a + b, 0) <= 66 && optimized.after.bonuses.every((v) => v >= 0 && v <= 32), JSON.stringify(optimized.after?.bonuses));
check("Optimize never scores worse than the set", Number(optimized.delta) >= -1e-9, String(optimized.delta));
check("Optimize speed contexts are Singles-safe", (optimized.contexts || []).length > 0 && optimized.contexts.every((c) => !/spread|partner/i.test(c.label)), JSON.stringify(optimized.contexts));

// --- Auto Build (Fast) --------------------------------------------------------------------
const built = await time("Singles Auto Build Fast", () => new TeamAutoBuild(S.evaluation).run(sets, { search: "fast", depth: "fast", selection: null }));
const entries = built.entries.filter((e) => e.pokemon);
check("Auto Build finishes without an error", !built.error, built.error || "");
check("Auto Build fills six slots", entries.length === 6, entries.map((e) => e.pokemon).join(", "));
check("Auto Build keeps the four", TEAM.every((m) => entries.some((e) => e.pokemon === m.species)));
const items = entries.map((e) => e.item).filter(Boolean);
check("Auto Build keeps Item Clause", new Set(items).size === items.length, items.join(", "));
check("Auto Build adds no duplicate species", new Set(entries.map((e) => e.pokemon)).size === entries.length);
check("Auto Build compared complete teams", (built.compared || []).length >= 1 && built.payload && finite(built.payload.synergy_score), String((built.compared || []).length));
check("Auto Build's evaluation has no Spread Damage check", built.payload && !built.payload.checks.rows.some((r) => r.check_id === "spread_damage"));

console.log(`\n${checked} checked, ${failures.length} failed.`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
