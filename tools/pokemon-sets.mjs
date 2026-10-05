// data/builder/pokemon-sets.json: the distinct sets each Pokemon is really played with.
//
// Two sources, combined (builder/pokemon-sets.js reads the result):
//
//   * the registered tournament teams, data/builder/known-teams.json -- real sets real players
//     brought, with the held item, ability, nature and four moves they chose. They are grouped by
//     what makes one a DIFFERENT set (the item, and the role its nature and moves put it in) and
//     the groups are ranked by how many teams ran them;
//   * data/builder/meta-<format>.json for the Stat Points, because a tournament sheet does not
//     record them. The nature and the distribution are paired by the project's own rule
//     (builder/nature-spreads.js), which never gives a nature points in the stat it lowers.
//
// Within a group the moves are the most common four of that group, counted move by move, so a
// set reads as the thing people actually run rather than as whichever sheet happened to be first.
//
//   node tools/pokemon-sets.mjs
//
// Deployed: the Damage Calculator and the Solver fetch it. It is small (a few tens of KB) because
// only the groups worth offering survive: at least MIN_TEAMS teams, and at most PER_POKEMON of
// them per Pokemon.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spreadPointsForNature } from "../builder/nature-spreads.js";
import { roleLabel } from "../builder/pokemon-sets.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** A group has to be a real alternative, not one person's experiment. */
const MIN_TEAMS = 3;
/** How many alternatives one Pokemon offers beyond its blank and most common set. */
const PER_POKEMON = 6;

const compact = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function read(path) {
  const full = join(root, path);
  return existsSync(full) ? JSON.parse(readFileSync(full, "utf8")) : null;
}

export function writePokemonSets() {
const known = read("data/builder/known-teams.json");
if (!known) {
  console.warn("Skipped pokemon-sets.json: data/builder/known-teams.json is missing.");
  return 0;
}
const appData = read("data/builder/app-data.json") || {};
const natureTable = appData.natures || {};
const aliases = appData.usageAliases || {};
/** showdown stem -> [species, form], so a usage record can be found from a team sheet's name. */
const usageByStem = new Map(Object.entries(aliases).map(([stem, [species, form]]) => [compact(stem), `${compact(species)}|${compact(form)}`]));

const out = {};
let groups = 0;

for (const format of ["Doubles", "Singles"]) {
  const meta = read(`data/builder/meta-${format.toLowerCase()}.json`);
  if (!meta) continue;
  // The usage record for a Pokemon, by species|form and by its showdown name.
  const records = new Map();
  for (const record of meta.pokemon || []) {
    records.set(`${compact(record.species)}|${compact(record.form)}`, record);
    records.set(compact(record.name), record);
  }
  const buckets = new Map();
  for (const [, members] of known.teams || []) {
    for (const member of members || []) {
      const [species, form, item, ability, nature, moves] = member;
      if (!species) continue;
      const key = `${compact(species)}|${compact(form || species)}`;
      const label = `${String(item || "").trim()}|${roleLabel(nature, moves)}`;
      const byKey = buckets.get(key) || new Map();
      const group = byKey.get(label) || {
        item: String(item || "").trim(), nature: String(nature || "").trim(),
        abilities: new Map(), natures: new Map(), moves: new Map(), teams: 0,
      };
      group.teams += 1;
      group.abilities.set(ability, (group.abilities.get(ability) || 0) + 1);
      group.natures.set(nature, (group.natures.get(nature) || 0) + 1);
      for (const move of moves || []) group.moves.set(move, (group.moves.get(move) || 0) + 1);
      byKey.set(label, group);
      buckets.set(key, byKey);
    }
  }
  const top = (counts) => [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const perFormat = {};
  for (const [key, byLabel] of buckets) {
    const record = records.get(key) || records.get(key.split("|")[0]) || records.get(usageByStem.get(key.split("|")[0]) || "");
    const total = [...byLabel.values()].reduce((sum, group) => sum + group.teams, 0);
    const rows = [...byLabel.values()]
      .filter((group) => group.teams >= MIN_TEAMS)
      .sort((a, b) => b.teams - a.teams)
      .slice(0, PER_POKEMON)
      .map((group) => {
        const nature = top(group.natures)[0]?.[0] || group.nature || "Serious";
        const points = spreadPointsForNature(record?.spreads || [], natureTable[nature]);
        return {
          item: group.item,
          ability: top(group.abilities)[0]?.[0] || "",
          nature,
          moves: top(group.moves).slice(0, 4).map(([name]) => name),
          bonuses: [...(points?.[1] || [0, 0, 0, 0, 0, 0])],
          teams: group.teams,
          share: Math.round((group.teams / Math.max(1, total)) * 1000) / 10,
        };
      });
    if (rows.length) {
      perFormat[key] = rows;
      groups += rows.length;
    }
  }
  out[format] = perFormat;
}

const target = join(root, "data", "builder", "pokemon-sets.json");
const payload = { generatedAt: new Date().toISOString(), minTeams: MIN_TEAMS, perPokemon: PER_POKEMON, sets: out };
writeFileSync(target, `${JSON.stringify(payload)}\n`);
const count = Object.values(out).reduce((sum, perFormat) => sum + Object.keys(perFormat).length, 0);
console.log(`Wrote ${groups} sets for ${count} Pokemon-and-format pairs to data/builder/pokemon-sets.json `
  + `(${Math.round(JSON.stringify(payload).length / 1024)} KB).`);


  return groups;
}

// Runnable on its own as well as from the manifest build.
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("tools/pokemon-sets.mjs")) writePokemonSets();