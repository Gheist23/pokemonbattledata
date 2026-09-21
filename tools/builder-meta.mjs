// Daily meta files for the Team Builder and Damage Calculator pages.
//
// The builder pages score a team against the ranked meta the same way the
// Companion does: each ranked Pokemon is played with its most common set, which
// the app assembles from the top row of each usage category (four moves, the
// held item, the ability, the nature and the stat points -- PokemonBattleApiClient
// .common_set).  This reads the current battle_data CSVs the site already
// publishes and writes one compact file per format:
//
//   data/builder/meta-doubles.json
//   data/builder/meta-singles.json
//
// Each usage file is named the Showdown way (Ninetales-Alola); app-data.json's
// usageAliases maps that back to the app's own species and form, which is what
// the damage engine and synced teams use.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STAT_COLUMNS = ["hp_points", "attack_points", "defense_points", "sp_atk_points", "sp_def_points", "speed_points"];
// Natures and Stat Points as deep as the app reads them (common_stat_alignment_spreads: 10 and 12).
const LIMITS = { move: 12, held_item: 10, ability: 4, teammate: 10, stat_alignment: 10, stat_points: 12 };

function number(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(value) {
  const parsed = number(value);
  return parsed === null ? 0 : Math.round(parsed * 10) / 10;
}

function rank(row, fallback) {
  const parsed = number(row.rank);
  return parsed === null ? fallback : parsed;
}

function byCategory(rows) {
  const out = {};
  rows.forEach((row, index) => {
    const category = String(row.category || "").trim().toLowerCase();
    if (!category) return;
    (out[category] ||= []).push({ ...row, _index: index });
  });
  for (const list of Object.values(out)) list.sort((a, b) => rank(a, a._index + 1) - rank(b, b._index + 1));
  return out;
}

function statPoints(row) {
  return STAT_COLUMNS.map((key) => Math.max(0, Math.min(32, Math.trunc(number(row?.[key]) ?? 0))));
}

export function pokemonRecord(stem, rows, aliases) {
  const groups = byCategory(rows);
  const first = rows[0] || {};
  const position = number(first.column_position ?? first.position) ?? 9999;
  const names = (category) => (groups[category] || []).map((row) => String(row.name || "").trim()).filter(Boolean);
  const pairs = (category) => (groups[category] || [])
    .filter((row) => String(row.name || "").trim())
    .slice(0, LIMITS[category])
    .map((row) => [String(row.name).trim(), percent(row.percentage)]);
  const nature = (groups.stat_alignment || [])[0];
  const spread = (groups.stat_points || [])[0];
  const [species, form] = aliases[stem] || [stem, stem];
  return {
    name: stem,
    species,
    form,
    position,
    set: {
      moves: names("move").slice(0, 4),
      item: names("held_item")[0] || "",
      ability: names("ability")[0] || "",
      nature: String(nature?.name || "Serious").trim() || "Serious",
      bonuses: statPoints(spread),
    },
    moves: pairs("move"),
    items: pairs("held_item"),
    abilities: pairs("ability"),
    teammates: names("teammate").slice(0, LIMITS.teammate),
    natures: (groups.stat_alignment || []).slice(0, LIMITS.stat_alignment).map((row) => [String(row.name || "").trim(), percent(row.percentage)]),
    spreads: (groups.stat_points || []).slice(0, LIMITS.stat_points).map((row) => [percent(row.percentage), statPoints(row)]),
  };
}

export function writeBuilderMeta({ cwd, parseCSV, generatedAt }) {
  const builderDir = join(cwd, "data", "builder");
  const appDataPath = join(builderDir, "app-data.json");
  if (!existsSync(appDataPath)) {
    console.warn("Skipped builder meta: data/builder/app-data.json is missing (run pct_tool94/tools/export_web_builder_data.py).");
    return 0;
  }
  const aliases = JSON.parse(readFileSync(appDataPath, "utf8")).usageAliases || {};
  mkdirSync(builderDir, { recursive: true });
  let written = 0;
  for (const format of ["Doubles", "Singles"]) {
    const dir = join(cwd, "pokemon_champions_assets", "battle_data", format);
    if (!existsSync(dir)) continue;
    const pokemon = [];
    for (const file of readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".csv")).sort()) {
      const rows = parseCSV(readFileSync(join(dir, file), "utf8"));
      if (!rows.length) continue;
      pokemon.push(pokemonRecord(file.replace(/\.csv$/i, ""), rows, aliases));
    }
    pokemon.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    writeFileSync(join(builderDir, `meta-${format.toLowerCase()}.json`), `${JSON.stringify({ generatedAt, format, pokemon })}\n`);
    written += pokemon.length;
  }
  return written;
}
