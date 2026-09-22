// Naming checks: every page names a Pokemon by its Pokemon Showdown name.
//
//   Team Builder (builder/common.js): the ladder's names are the labels (the app's
//   Floette is Floette-Eternal), a pasted Showdown name becomes the same (species, form)
//   pair the picker stores, every app form survives an export and re-import, and a Mega
//   the app files once for both genders is named after the holder (Meowstic-F-Mega).
//   Tournament library (builder/known-teams.js): two app spellings of one Pokemon count
//   as the same roster member.  Team Evaluation names (TeamChecks.showdownName).
//   /meta/ snapshots (data/meta, written by tools/generate-manifest.mjs): no Pokemon is
//   filed under two names on different days of the current season, which would read as
//   one leaving the ranking and a "new" one entering.
//   Explorer pages (data/pokemon-index.json): a forme's page is its own, not its species'.
//
//   node tests/run-naming-checks.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData, makeSet, parseShowdown, setToShowdown } from "../builder/common.js";
import { KnownTeams, mostSimilarTeam } from "../builder/known-teams.js";
import { TeamChecks } from "../builder/team-checks.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const readJson = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));
const data = new BuilderData(readJson("data", "builder", "app-data.json"));
data.meta.Doubles = readJson("data", "builder", "meta-doubles.json");
data.metaByUsage.Doubles = new Map(data.meta.Doubles.pokemon.map((row) => [row.name.toLowerCase().replace(/[^a-z0-9]/g, ""), row]));
const known = new KnownTeams(readJson("data", "builder", "known-teams.json"));

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const pairOf = (set) => (set ? `${set.species}|${set.form}` : "(none)");

// Ladder names are the builder's labels, the picker finds them and a paste imports them.
for (const [name, pair, isLabel] of [
  ["Floette-Eternal", "Floette|Floette", true],
  ["Maushold-Four", "Maushold|Maushold", true],
  ["Vivillon-Fancy", "Vivillon|Vivillon Icy Snow Pattern", true],
  // The app has one Squawkabilly for both ladder rows: it keeps its own name, the second one finds it.
  ["Squawkabilly-Yellow", "Squawkabilly|Squawkabilly", false],
]) {
  const row = data.searchSpecies(name, { format: "Doubles", limit: 1 })[0];
  check(`picker finds ${name}`, row && `${row.species}|${row.form}` === pair, row ? `${row.species}|${row.form}` : "no row");
  const set = parseShowdown(`${name} @ Leftovers\n- Protect`, data)[0];
  check(`paste of ${name} imports`, pairOf(set) === pair, pairOf(set));
  if (isLabel && set) {
    check(`${name} is the label`, data.displayName(set.species, set.form) === name, data.displayName(set.species, set.form));
    check(`${name} is the export name`, setToShowdown(set, data).startsWith(`${name} @`), setToShowdown(set, data).split("\n")[0]);
  }
}

// A pasted Showdown name is the pair the picker stores.
for (const name of ["Basculegion", "Basculegion-F", "Rotom-Heat", "Rotom-Wash", "Aegislash", "Aegislash-Blade", "Palafin", "Palafin-Hero", "Florges", "Furfrou", "Indeedee-F", "Meowstic-F", "Ninetales-Alola", "Charizard-Mega-Y"]) {
  const row = data.searchSpecies(name, { format: "Doubles", limit: 1 })[0];
  const set = parseShowdown(`${name} @ Leftovers\n- Protect`, data)[0];
  check(`paste of ${name} matches the picker`, row && set && row.label === name && `${row.species}|${row.form}` === pairOf(set), `${pairOf(set)} vs picker ${row?.label} ${row?.species}|${row?.form}`);
}
const gendered = parseShowdown("Meowstic (F)\n- Psychic\n\nBasculegion (F)\n- Wave Crash", data).map(pairOf).join(", ");
check("a (F) marker picks the female forme", gendered === "Meowstic|Meowstic Female, Basculegion|Basculegion Female", gendered);

// Every app form survives an export and a re-import under its own name.
const lost = [];
for (const form of data.forms) {
  const set = makeSet({ species: form.species, form: form.form });
  const back = parseShowdown(setToShowdown(set, data), data)[0];
  if (!back || data.displayName(back.species, back.form) !== data.displayName(set.species, set.form)) lost.push(`${form.species}|${form.form} -> ${pairOf(back)}`);
}
check("every app form round-trips through a Showdown export", !lost.length, lost.slice(0, 5).join("; "));
const labels = data.searchSpecies("", { limit: 1000 }).map((row) => row.label);
check("no two picker rows share a label", labels.length === new Set(labels).size);

// Gendered Megas.
for (const [form, want] of [["Meowstic Female", "Meowstic-F-Mega"], ["Meowstic", "Meowstic-M-Mega"]]) {
  const name = data.setName(makeSet({ species: "Meowstic", form, item: "Meowsticite" }));
  check(`Meowstic|${form} @ Meowsticite is ${want}`, name === want, name);
}
check("Charizard @ Charizardite Y is Charizard-Mega-Y", data.setName(makeSet({ species: "Charizard", form: "Charizard", item: "Charizardite Y" })) === "Charizard-Mega-Y");
const pastedMega = parseShowdown("Meowstic-F-Mega @ Meowsticite\n- Psychic", data)[0];
check("a pasted Meowstic-F-Mega is a female Meowstic", pairOf(pastedMega) === "Meowstic|Meowstic Female" && data.setName(pastedMega) === "Meowstic-F-Mega", pairOf(pastedMega));

// Team Evaluation names.
const checks = new TeamChecks({ engine: data.engine });
for (const [raw, want] of [["Mega Meowstic", "Meowstic-M-Mega"], ["Mega Meowstic-F", "Meowstic-F-Mega"], ["Mega Charizard Y", "Charizard-Mega-Y"], ["Basculegion Male", "Basculegion"]]) {
  check(`threat name ${raw}`, checks.showdownName(raw) === want, checks.showdownName(raw));
}

// Tournament library: both app spellings of a Pokemon are the same roster member.
const team1471 = (form) => [
  { pokemon: "Garchomp", form: "Garchomp", item: "Life Orb", moves: [] },
  { pokemon: "Incineroar", form: "Incineroar", item: "", moves: [] },
  { pokemon: "Whimsicott", form: "Whimsicott", item: "", moves: [] },
  { pokemon: "Sylveon", form: "Sylveon", item: "", moves: [] },
  { pokemon: "Basculegion", form, item: "Mystic Water", moves: [] },
];
for (const form of ["Basculegion", "Basculegion Male"]) {
  const found = known.completingMember(team1471(form), "Charizard", "Charizard");
  const similar = mostSimilarTeam(known, team1471(form));
  check(`Basculegion|${form} completes team1471`, found?.[0].name === "team1471.txt", found?.[0].name || "not found");
  check(`Basculegion|${form} is shared with the similar team`, similar && !similar.notInIt.length, similar?.notInIt.map((e) => e.form).join(", "));
}
check("Rotom Heat and Heat Rotom are one roster member", JSON.stringify(known.rosterCounts([{ pokemon: "Rotom", form: "Rotom Heat" }])) === JSON.stringify(known.rosterCounts([{ pokemon: "Heat Rotom", form: "Heat Rotom" }])));
check("Indeedee and Indeedee-F stay two roster members", JSON.stringify(known.rosterCounts([{ pokemon: "Indeedee", form: "Indeedee" }])) !== JSON.stringify(known.rosterCounts([{ pokemon: "Indeedee", form: "Indeedee Female" }])));

// /meta/: no Pokemon under two names on different days of the current season.
const species = readJson("tools", "showdown-species.json");
const baseOf = new Map(Object.values(species).map((s) => [s.name, s.baseSpecies || s.name]));
const base = (name) => baseOf.get(name) || String(name).split("-")[0];
const index = readJson("data", "meta", "index.json");
const season = index.seasons[0];
for (const format of season.formats) {
  const days = new Map();
  for (const date of season.dates) {
    let snapshot;
    try { snapshot = readJson("data", "meta", season.season, date, `${format}.json`); } catch { continue; }
    const note = (name) => { if (!days.has(name)) days.set(name, new Set()); days.get(name).add(date); };
    for (const [name, entry] of Object.entries(snapshot.pokemon)) {
      note(name);
      for (const row of entry.teammate || []) note(row[0]);
    }
  }
  const names = [...days.keys()];
  const split = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const [a, b] = [names[i], names[j]];
      if (base(a) !== base(b) || [...days.get(a)].some((date) => days.get(b).has(date))) continue;
      split.push(`${a} / ${b}`);
    }
  }
  check(`${season.season} ${format}: no Pokemon filed under two names on different days`, !split.length, split.join("; "));
}

// Explorer pages (data/pokemon-index.json, written by tools/generate-manifest.mjs): a
// species' metadata lists its regional and gendered formes under their Showdown names,
// which are battle-data Pokemon of their own, so each such page must be that Pokemon's
// own page (/pokemon/ninetales-alola/ once showed the Kantonian Ninetales' data).
const manifest = readJson("data", "pokemon-index.json");
const pageBySlug = new Map(manifest.pokemonPages.map((page) => [page.slug, page]));
const borrowed = manifest.pokemon.filter((record) => pageBySlug.get(record.slug)?.battleName !== record.battleName)
  .map((record) => `${record.slug} shows ${pageBySlug.get(record.slug)?.battleName || "nothing"}`);
check("every battle-data Pokemon's page shows its own data", !borrowed.length, borrowed.slice(0, 8).join("; "));
// The app catalogue's only Floette is Floette-Eternal: no second page, the old URL redirects.
const redirects = readFileSync(join(root, "_redirects"), "utf8");
check("/pokemon/floette/ folds into /pokemon/floette-eternal/", !pageBySlug.has("floette") && pageBySlug.has("floette-eternal") && /^\/pokemon\/floette\/ \/pokemon\/floette-eternal\/ 301$/m.test(redirects));

console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
