import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

const assetRoot = "pokemon_champions_assets";
const cwd = process.cwd();
const assetRootPath = join(cwd, assetRoot);
const battleDir = join(assetRootPath, "battle_data");
const metadataDir = join(assetRootPath, "metadata");
const preferredFormatOrder = ["Doubles", "Singles"];
const statColumns = ["hp_points", "attack_points", "defense_points", "sp_atk_points", "sp_def_points", "speed_points"];
const categories = ["move", "held_item", "teammate", "stat_alignment", "stat_points", "ability"];
const statAliases = {
  hp: ["hp", "health"],
  attack: ["attack", "atk"],
  defense: ["defense", "def"],
  sp_attack: ["sp_attack", "spattack", "sp_atk", "spa", "spatk", "special_attack"],
  sp_defense: ["sp_defense", "spdefense", "sp_def", "spd", "spdef", "special_defense"],
  speed: ["speed", "spe"],
  base_stat_total: ["base_stat_total", "baseStatTotal", "bst", "total", "stats"]
};
const metadataAliases = {
  pokemon_name: ["pokemon_name", "base_name", "title", "name", "pokemon"],
  dex_number: ["dex_number", "dex", "national_dex"],
  base_dex_url: ["base_dex_url", "dex_url", "url"],
  image_path: ["image_path", "sprite", "sprite_path", "image"],
  form_name: ["saved_name", "form_name", "title", "name"],
  form_kind: ["form_kind", "form"],
  types: ["types", "type"],
  abilities: ["abilities", "ability"],
  hidden_ability: ["hidden_ability", "hidden", "hidden_abilities"]
};

if (!existsSync(assetRootPath)) {
  console.error("Could not find pokemon_champions_assets/ in the current directory.");
  process.exit(1);
}
if (!existsSync(battleDir)) {
  console.error(`Expected ${assetRoot}/battle_data/ to exist.`);
  process.exit(1);
}

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").split(sep).join("/").replace(/\/+/g, "/");
}

function titleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function recordKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function csvFilesRecursive(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) files.push(...csvFilesRecursive(fullPath));
    else if (extname(entry).toLowerCase() === ".csv") files.push(fullPath);
  }
  return files;
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift().map((header) => header.replace(/^\uFEFF/, "").trim());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function normalizeHeader(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function readField(row, aliases) {
  if (!row) return "";
  const keys = Array.isArray(aliases) ? aliases : [aliases];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== null && row[key] !== undefined && row[key] !== "") return row[key];
  }
  const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
  for (const key of keys) {
    const value = normalized.get(normalizeHeader(key));
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return "";
}

function metadataNumber(row, canonicalKey, aliases = []) {
  return numberOrNull(readField(row, [canonicalKey, ...(aliases || [])]));
}

function metadataStatValue(row, canonicalKey) {
  return metadataNumber(row, canonicalKey, statAliases[canonicalKey] || [canonicalKey]);
}

function splitTypes(value) {
  return unique(String(value || "").split(/[\/|,]/).map((type) => titleCase(type.trim())).filter(Boolean));
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function parsePercent(value) {
  if (!value) return null;
  const parsed = Number(String(value).replace("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatFromBattlePath(fullPath) {
  const rel = normalizePath(relative(battleDir, fullPath));
  const parts = rel.split("/");
  if (parts.length > 1) return titleCase(parts[0]);
  return "Battle";
}

function normalizeMetadataRow(row) {
  const types = splitTypes(readField(row, metadataAliases.types));
  const baseName = readField(row, ["base_name", "pokemon_name", "pokemon", "title", "name"]) || "";
  const savedName = readField(row, ["saved_name", "form_name", "title", "name"]) || baseName || "Unknown form";
  const formKind = readField(row, metadataAliases.form_kind) || "";
  const normalized = {
    pokemon_name: baseName,
    dex_number: metadataNumber(row, "dex_number", metadataAliases.dex_number),
    base_dex_url: readField(row, metadataAliases.base_dex_url) || "",
    image_path: normalizePath(readField(row, metadataAliases.image_path) || ""),
    form_name: savedName,
    saved_name: savedName,
    form_kind: formKind || (savedName === baseName ? "Base" : "Form"),
    types,
    types_raw: readField(row, metadataAliases.types) || "",
    abilities: readField(row, metadataAliases.abilities) || "",
    hidden_ability: readField(row, metadataAliases.hidden_ability) || ""
  };
  Object.keys(statAliases).forEach((key) => {
    normalized[key] = metadataStatValue(row, key);
  });
  return normalized;
}

function normalizeBattleRow(row) {
  const normalized = {
    category: row.category || "",
    rank: numberOrNull(row.rank),
    name: row.name || "",
    percentage: row.percentage || "",
    percentage_value: parsePercent(row.percentage),
    stat_up: row.stat_up || "",
    stat_down: row.stat_down || ""
  };
  for (const key of statColumns) normalized[key] = numberOrNull(row[key]);
  return normalized;
}

function rowLabel(row) {
  if (!row) return "";
  if (row.name) return row.name;
  if (row.category === "stat_points") {
    const labels = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];
    return statColumns.map((key, index) => `${labels[index]} ${row[key] ?? "—"}`).join(" / ");
  }
  return "";
}

function compactBattleRow(row) {
  const compact = {
    category: row.category,
    rank: row.rank,
    name: row.name,
    percentage: row.percentage,
    percentage_value: row.percentage_value,
    stat_up: row.stat_up,
    stat_down: row.stat_down
  };
  for (const key of statColumns) {
    if (row[key] !== null && row[key] !== undefined) compact[key] = row[key];
  }
  return compact;
}

function battleSummary(rows) {
  const summary = { top: {}, values: {}, rows: [] };
  for (const category of categories) {
    const ranked = rows.filter((row) => row.category === category).sort((a, b) => {
      const rankDelta = numberOrZero(a.rank) - numberOrZero(b.rank);
      if (rankDelta) return rankDelta;
      return numberOrZero(b.percentage_value) - numberOrZero(a.percentage_value);
    });
    const usageSorted = [...ranked].sort((a, b) => {
      const usageDelta = numberOrZero(b.percentage_value) - numberOrZero(a.percentage_value);
      if (usageDelta) return usageDelta;
      return numberOrZero(a.rank) - numberOrZero(b.rank);
    });
    if (usageSorted[0]) summary.top[category] = compactBattleRow(usageSorted[0]);
    summary.values[category] = unique(ranked.map(rowLabel).filter(Boolean));
    summary.rows.push(...ranked.map(compactBattleRow));
  }
  return summary;
}

function compareFormat(a, b) {
  const ai = preferredFormatOrder.indexOf(a.format || a);
  const bi = preferredFormatOrder.indexOf(b.format || b);
  if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  return String(a.format || a).localeCompare(String(b.format || b));
}

const records = new Map();
function ensureRecord(key, fallbackName = "") {
  if (!records.has(key)) records.set(key, { key, name: titleCase(fallbackName || key), metadataCsv: null, metadataRows: [], battleDataCsvs: [], battleSummary: {} });
  const record = records.get(key);
  if (fallbackName && (!record.name || record.name === titleCase(key))) record.name = titleCase(fallbackName);
  return record;
}

for (const file of csvFilesRecursive(metadataDir)) {
  const rows = parseCSV(readFileSync(file, "utf8"));
  const inferredName = readField(rows[0], ["base_name", "pokemon_name", "pokemon", "title", "name"]) || basename(file, ".csv");
  const key = recordKey(inferredName || basename(file, ".csv"));
  const record = ensureRecord(key, inferredName);
  record.metadataCsv = normalizePath(relative(cwd, file));
  record.metadataRows = rows.map(normalizeMetadataRow);
}

for (const file of csvFilesRecursive(battleDir)) {
  const rows = parseCSV(readFileSync(file, "utf8"));
  const inferredName = rows[0]?.pokemon || basename(file, ".csv");
  const key = recordKey(inferredName || basename(file, ".csv"));
  const record = ensureRecord(key, inferredName);
  const format = formatFromBattlePath(file);
  const normalizedRows = rows.map(normalizeBattleRow).filter((row) => row.category);
  record.battleDataCsvs.push({ format, path: normalizePath(relative(cwd, file)) });
  record.battleSummary[format] = battleSummary(normalizedRows);
}

const pokemon = [...records.values()]
  .filter((record) => record.battleDataCsvs.length)
  .map((record) => {
    const primary = record.metadataRows.find((form) => /base/i.test(form.form_kind || "") || !form.form_kind || form.form_name === record.name || form.saved_name === record.name) || record.metadataRows[0] || {};
    const allTypes = unique(record.metadataRows.flatMap((form) => form.types || []));
    const sprite = primary.image_path || `${assetRoot}/pokemon/${record.name}.png`;
    return {
      name: record.name,
      metadataCsv: record.metadataCsv,
      battleDataCsvs: record.battleDataCsvs.sort(compareFormat),
      summary: {
        dex: primary.dex_number ?? null,
        sprite,
        types: allTypes,
        primary,
        forms: record.metadataRows,
        baseStats: {
          hp: metadataStatValue(primary, "hp") ?? null,
          attack: metadataStatValue(primary, "attack") ?? null,
          defense: metadataStatValue(primary, "defense") ?? null,
          sp_attack: metadataStatValue(primary, "sp_attack") ?? null,
          sp_defense: metadataStatValue(primary, "sp_defense") ?? null,
          speed: metadataStatValue(primary, "speed") ?? null
        },
        baseStatTotal: metadataStatValue(primary, "base_stat_total") ?? null,
        battleSummary: record.battleSummary
      }
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

const skippedMetadataOnly = [...records.values()].filter((record) => !record.battleDataCsvs.length).map((record) => record.name);

mkdirSync(join(cwd, "data"), { recursive: true });
writeFileSync(join(cwd, "data", "pokemon-index.json"), `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  assetRoot,
  pokemon
}, null, 2)}\n`);

console.log(`Generated data/pokemon-index.json with ${pokemon.length} Pokémon.`);
if (skippedMetadataOnly.length) console.warn(`Skipped ${skippedMetadataOnly.length} metadata-only name(s): ${skippedMetadataOnly.join(", ")}`);
