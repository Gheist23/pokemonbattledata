import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

const assetRoot = "pokemon_champions_assets";
const cwd = process.cwd();
const assetRootPath = join(cwd, assetRoot);
const battleDir = join(assetRootPath, "battle_data");
const metadataDir = join(assetRootPath, "metadata");
const learnableMovesDir = join(assetRootPath, "learnable_moves");
const defaultSeason = "Season M-3";
const preferredFormatOrder = ["Doubles", "Singles"];
const siteUrl = "https://championsbattledata.com";
const siteName = "Pokemon Champions Battle Data";
const licenseUrl = `${siteUrl}/license.html`;
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

function slugify(value) {
  return recordKey(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function battleInfoFromPath(fullPath) {
  const rel = normalizePath(relative(battleDir, fullPath));
  const parts = rel.split("/").filter(Boolean);
  if (parts.length >= 3 && /^season\b/i.test(parts[0])) {
    return { season: parts[0], format: titleCase(parts[1]) };
  }
  if (parts.length > 1) return { season: "Current", format: titleCase(parts[0]) };
  return { season: "Current", format: "Battle" };
}

function compareSeason(a, b) {
  if (a === defaultSeason) return -1;
  if (b === defaultSeason) return 1;
  const am = String(a || "").match(/M-(\d+)/i);
  const bm = String(b || "").match(/M-(\d+)/i);
  if (am && bm) return Number(bm[1]) - Number(am[1]);
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
}

function normalizeMetadataRow(row) {
  const types = splitTypes(readField(row, metadataAliases.types));
  const baseName = readField(row, ["base_name", "pokemon_name", "pokemon", "title", "name"]) || "";
  const savedName = readField(row, ["saved_name", "form_name", "title", "name"]) || baseName || "Unknown form";
  const title = readField(row, ["title"]) || savedName;
  const formKind = readField(row, metadataAliases.form_kind) || "";
  const normalized = {
    pokemon_name: baseName,
    title,
    dex_number: metadataNumber(row, "dex_number", metadataAliases.dex_number),
    base_dex_url: readField(row, metadataAliases.base_dex_url) || "",
    image_path: normalizePath(readField(row, metadataAliases.image_path) || ""),
    form_name: savedName,
    saved_name: savedName,
    slug: slugify(savedName),
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
  const columnPosition = numberOrNull(readField(row, ["column_position", "columnPosition", "columnposition"]));
  const normalized = {
    pokemon: readField(row, ["pokemon"]) || "",
    column_position: columnPosition,
    position: columnPosition ?? numberOrNull(readField(row, ["position", "pos"])),
    category: readField(row, ["category"]) || "",
    rank: numberOrNull(readField(row, ["rank"])),
    name: readField(row, ["name"]) || "",
    percentage: readField(row, ["percentage"]) || "",
    percentage_value: parsePercent(readField(row, ["percentage"])),
    stat_up: readField(row, ["stat_up"]) || "",
    stat_down: readField(row, ["stat_down"]) || ""
  };
  for (const key of statColumns) normalized[key] = numberOrNull(readField(row, [key]));
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
    pokemon: row.pokemon,
    column_position: row.column_position,
    position: row.position,
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
const metadataBySavedName = new Map();
function ensureRecord(key, fallbackName = "") {
  if (!records.has(key)) records.set(key, { key, name: titleCase(fallbackName || key), metadataCsv: null, metadataRows: [], battleDataCsvs: [], battleSummary: {}, learnableMoveNames: [] });
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
  for (const row of record.metadataRows) {
    const savedKey = recordKey(row.saved_name || row.form_name);
    if (savedKey) {
      metadataBySavedName.set(savedKey, {
        metadataCsv: record.metadataCsv,
        metadataRows: record.metadataRows
      });
    }
  }
}

if (existsSync(learnableMovesDir)) {
  for (const file of csvFilesRecursive(learnableMovesDir)) {
    const inferredName = basename(file, ".csv");
    const key = recordKey(inferredName);
    const rows = parseCSV(readFileSync(file, "utf8"));
    const moveNames = unique(rows.map((row) => readField(row, ["move_name", "move", "name"])).filter(Boolean));
    ensureRecord(key, inferredName).learnableMoveNames = moveNames;
  }
}

for (const file of csvFilesRecursive(battleDir)) {
  const rows = parseCSV(readFileSync(file, "utf8"));
  const inferredName = rows[0]?.pokemon || basename(file, ".csv");
  const key = recordKey(inferredName || basename(file, ".csv"));
  const record = ensureRecord(key, inferredName);
  if (inferredName) record.name = inferredName;
  const metadataMatch = metadataBySavedName.get(recordKey(inferredName));
  if (metadataMatch) {
    record.metadataCsv = metadataMatch.metadataCsv;
    record.metadataRows = metadataMatch.metadataRows;
  }
  const { season, format } = battleInfoFromPath(file);
  const normalizedRows = rows.map(normalizeBattleRow).filter((row) => row.category);
  record.battleDataCsvs.push({ season, format, path: normalizePath(relative(cwd, file)) });
  record.battleSummary[season] ||= {};
  record.battleSummary[season][format] = battleSummary(normalizedRows);
}

const battleDataFolders = existsSync(battleDir)
  ? readdirSync(battleDir)
    .filter((entry) => statSync(join(battleDir, entry)).isDirectory())
    .sort(compareSeason)
  : [];
const availableSeasons = [...new Set([
  ...battleDataFolders,
  ...[...records.values()].flatMap((record) => record.battleDataCsvs.map((source) => source.season))
])].sort(compareSeason);

const pokemon = [...records.values()]
  .filter((record) => record.battleDataCsvs.length)
  .map((record) => {
    const recordNameKey = recordKey(record.name);
    const primary = record.metadataRows.find((form) => recordKey(form.saved_name || form.form_name) === recordNameKey) ||
      record.metadataRows.find((form) => /base/i.test(form.form_kind || "") || !form.form_kind || form.form_name === record.name || form.saved_name === record.name) ||
      record.metadataRows[0] || {};
    const allTypes = unique((primary.types && primary.types.length ? primary.types : record.metadataRows.flatMap((form) => form.types || [])));
    const sprite = primary.image_path || `${assetRoot}/pokemon/${record.name}.png`;
    return {
      name: record.name,
      battleName: record.name,
      slug: slugify(record.name),
      metadataCsv: record.metadataCsv,
      battleDataCsvs: record.battleDataCsvs.sort((a, b) => compareSeason(a.season, b.season) || compareFormat(a, b)),
      learnableMoveNames: record.learnableMoveNames,
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeXml(value) {
  return escapeHtml(value).replace(/&#039;/g, "&apos;");
}

function percentNumber(value) {
  return numberOrZero(String(value || "").replace("%", ""));
}

function rowName(row) {
  if (!row) return "";
  if (row.name) return row.name;
  if (row.category === "stat_points") {
    const labels = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];
    return statColumns.map((key, index) => `${labels[index]} ${row[key] ?? "-"}`).join(" / ");
  }
  return "";
}

function categoryRows(summary, category) {
  return (summary?.rows || [])
    .filter((row) => row.category === category)
    .sort((a, b) => numberOrZero(a.rank) - numberOrZero(b.rank) || percentNumber(b.percentage) - percentNumber(a.percentage));
}

function summaryFor(record, format = "Doubles") {
  const bySeason = record.summary?.battleSummary || {};
  const current = bySeason.Current?.[format] || bySeason["Season M-3"]?.[format];
  if (current) return current;
  for (const season of Object.keys(bySeason)) {
    if (bySeason[season]?.[format]) return bySeason[season][format];
  }
  for (const season of Object.keys(bySeason)) {
    const first = Object.values(bySeason[season] || {})[0];
    if (first) return first;
  }
  return { top: {}, values: {}, rows: [] };
}

function battlePositionFor(record, format = "Doubles") {
  const rows = summaryFor(record, format).rows || [];
  const positions = rows.map((row) => numberOrNull(row.column_position ?? row.position)).filter((value) => Number.isFinite(value));
  return positions.length ? Math.min(...positions) : null;
}

function rankedPokemon(format = "Doubles", limit = 30) {
  return pokemon
    .map((record) => ({ record, position: battlePositionFor(record, format) }))
    .filter((entry) => Number.isFinite(entry.position))
    .sort((a, b) => a.position - b.position || a.record.name.localeCompare(b.record.name, undefined, { sensitivity: "base" }))
    .slice(0, limit);
}

function aggregateCategory(category, format = "Doubles", limit = 40) {
  const values = new Map();
  for (const record of pokemon) {
    for (const row of categoryRows(summaryFor(record, format), category).slice(0, 4)) {
      const name = rowName(row);
      if (!name) continue;
      const entry = values.get(name) || { name, appearances: 0, totalPercent: 0, pokemon: [] };
      entry.appearances += 1;
      entry.totalPercent += percentNumber(row.percentage);
      if (entry.pokemon.length < 8) entry.pokemon.push(record.name);
      values.set(name, entry);
    }
  }
  return [...values.values()]
    .sort((a, b) => b.appearances - a.appearances || b.totalPercent - a.totalPercent || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function topSpeedTiers(limit = 50) {
  return [...pokemon]
    .map((record) => ({ record, speed: numberOrZero(metadataStatValue(record.summary?.primary || {}, "speed")) }))
    .filter((entry) => entry.speed > 0)
    .sort((a, b) => b.speed - a.speed || a.record.name.localeCompare(b.record.name, undefined, { sensitivity: "base" }))
    .slice(0, limit);
}

function pageDescription(page) {
  return `${page.name} Pokemon Champions battle data with usage stats, common moves, held items, abilities, teammates, stat spreads, and learnable moves.`;
}

function pageKeywords(page) {
  return unique([
    page.name,
    `${page.name} Pokemon Champions`,
    `${page.name} moveset`,
    `${page.name} best item`,
    `${page.name} usage stats`,
    "Pokemon Champions battle data",
    "Pokemon Champions meta",
    "Pokemon Champions API",
    ...(page.types || []).map((type) => `${type} Pokemon Champions`)
  ]);
}

function pokemonLink(recordOrPage) {
  const slug = recordOrPage.slug || slugify(recordOrPage.name || recordOrPage.battleName);
  const label = recordOrPage.name || recordOrPage.battleName || slug;
  return `<a href="/pokemon/${escapeHtml(slug)}/">${escapeHtml(label)}</a>`;
}

function simpleTable(headers, rows) {
  if (!rows.length) return `<p>No ranked data is available yet.</p>`;
  return `<div class="data-table-wrap static-table-wrap"><table class="data-table static-seo-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function rankedPokemonTable(format, limit = 20) {
  return simpleTable(["Rank", "Pokemon", "Top move", "Top item", "Ability"], rankedPokemon(format, limit).map(({ record, position }) => {
    const summary = summaryFor(record, format);
    return `<tr><td>${escapeHtml(position)}</td><td>${pokemonLink(record)}</td><td>${escapeHtml(rowName(summary.top?.move) || "-")}</td><td>${escapeHtml(rowName(summary.top?.held_item) || "-")}</td><td>${escapeHtml(rowName(summary.top?.ability) || "-")}</td></tr>`;
  }));
}

function speedTierTable(limit = 35) {
  return simpleTable(["Speed", "Pokemon", "Types", "Doubles rank", "Singles rank"], topSpeedTiers(limit).map(({ record, speed }) => {
    return `<tr><td>${escapeHtml(speed)}</td><td>${pokemonLink(record)}</td><td>${escapeHtml((record.summary?.types || []).join(" / ") || "-")}</td><td>${escapeHtml(battlePositionFor(record, "Doubles") ?? "-")}</td><td>${escapeHtml(battlePositionFor(record, "Singles") ?? "-")}</td></tr>`;
  }));
}

function aggregateTable(category, format = "Doubles", limit = 35) {
  return simpleTable(["Name", "Top appearances", "Average usage", "Example Pokemon"], aggregateCategory(category, format, limit).map((entry) => {
    const average = entry.appearances ? `${(entry.totalPercent / entry.appearances).toFixed(1)}%` : "-";
    return `<tr><td>${escapeHtml(entry.name)}</td><td>${escapeHtml(entry.appearances)}</td><td>${escapeHtml(average)}</td><td>${escapeHtml(entry.pokemon.join(", "))}</td></tr>`;
  }));
}

function addPokemonPage(pages, page) {
  if (!page.slug || pages.has(page.slug)) return;
  pages.set(page.slug, {
    ...page,
    url: `${siteUrl}/pokemon/${page.slug}/`,
    description: pageDescription(page),
    keywords: pageKeywords(page)
  });
}

function buildPokemonPages(pokemonRecords) {
  const pages = new Map();
  for (const record of pokemonRecords) {
    const recordTypes = unique(record.summary?.types || record.summary?.primary?.types || []);
    const recordName = record.battleName || record.name;
    addPokemonPage(pages, {
      name: recordName,
      slug: record.slug || slugify(recordName),
      battleName: recordName,
      sourceRecord: record,
      baseName: record.summary?.primary?.pokemon_name || record.name,
      types: recordTypes,
      isForm: false
    });
    for (const form of record.summary?.forms || []) {
      const formName = form.saved_name || form.form_name || form.title || form.pokemon_name || "";
      const formSlug = form.slug || slugify(formName);
      if (!formName || !formSlug) continue;
      addPokemonPage(pages, {
        name: formName,
        slug: formSlug,
        battleName: recordName,
        sourceRecord: record,
        form,
        baseName: form.pokemon_name || record.summary?.primary?.pokemon_name || record.name,
        types: form.types?.length ? form.types : recordTypes,
        formKind: form.form_kind || "",
        isForm: formSlug !== (record.slug || slugify(recordName))
      });
    }
  }
  return [...pages.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function pokemonPageJsonLd(page) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${page.url}#webpage`,
        url: page.url,
        name: `${page.name} - ${siteName}`,
        description: page.description,
        isPartOf: { "@id": `${siteUrl}/#website` },
        about: { "@id": `${page.url}#dataset` },
        breadcrumb: {
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: `${siteUrl}/` },
            { "@type": "ListItem", position: 2, name: page.name, item: page.url }
          ]
        }
      },
      {
        "@type": "Dataset",
        "@id": `${page.url}#dataset`,
        url: page.url,
        name: `${page.name} Pokemon Champions Battle Data`,
        description: page.description,
        keywords: page.keywords,
        creator: {
          "@type": "Organization",
          name: siteName,
          url: `${siteUrl}/`
        },
        license: licenseUrl,
        isAccessibleForFree: true,
        isPartOf: { "@id": `${siteUrl}/#dataset` },
        distribution: [
          {
            "@type": "DataDownload",
            encodingFormat: "application/json",
            contentUrl: `${siteUrl}/data/pokemon-index.json`
          }
        ]
      }
    ]
  };
}

function pokemonStaticContent(page) {
  const record = page.sourceRecord;
  const primary = page.form || record.summary?.primary || {};
  const doubles = summaryFor(record, "Doubles");
  const singles = summaryFor(record, "Singles");
  const stats = [
    ["HP", metadataStatValue(primary, "hp")],
    ["Attack", metadataStatValue(primary, "attack")],
    ["Defense", metadataStatValue(primary, "defense")],
    ["Sp. Attack", metadataStatValue(primary, "sp_attack")],
    ["Sp. Defense", metadataStatValue(primary, "sp_defense")],
    ["Speed", metadataStatValue(primary, "speed")],
    ["Total", metadataStatValue(primary, "base_stat_total")]
  ];
  const rows = [
    ["Types", (page.types || []).join(" / ") || "-"],
    ["Base Pokemon", page.baseName || "-"],
    ["Doubles rank", battlePositionFor(record, "Doubles") ?? "-"],
    ["Singles rank", battlePositionFor(record, "Singles") ?? "-"],
    ["Top Doubles move", rowName(doubles.top?.move) || "-"],
    ["Top Doubles item", rowName(doubles.top?.held_item) || "-"],
    ["Top Doubles ability", rowName(doubles.top?.ability) || "-"],
    ["Top Singles move", rowName(singles.top?.move) || "-"],
    ["Top teammate", rowName(doubles.top?.teammate) || rowName(singles.top?.teammate) || "-"],
    ...stats.map(([label, value]) => [label, value ?? "-"])
  ];
  const topMoves = categoryRows(doubles, "move").slice(0, 8);
  const topItems = categoryRows(doubles, "held_item").slice(0, 8);
  const forms = (record.summary?.forms || [])
    .map((form) => ({ name: form.saved_name || form.form_name || form.title || form.pokemon_name, slug: form.slug || slugify(form.saved_name || form.form_name || form.title || form.pokemon_name) }))
    .filter((form) => form.name && form.slug && form.slug !== page.slug)
    .slice(0, 16);
  return `<section class="section-shell static-seo-content" aria-label="${escapeHtml(page.name)} static battle data">
    <div class="content-area static-seo-panel">
      <p class="eyebrow">Pokemon Champions profile</p>
      <h1>${escapeHtml(page.name)} Pokemon Champions Battle Data</h1>
      <p>${escapeHtml(page.description)}</p>
      <div class="static-seo-grid">
        ${simpleTable(["Field", "Value"], rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`))}
        ${simpleTable(["Move", "Usage"], topMoves.map((row) => `<tr><td>${escapeHtml(rowName(row))}</td><td>${escapeHtml(row.percentage || "-")}</td></tr>`))}
        ${simpleTable(["Held item", "Usage"], topItems.map((row) => `<tr><td>${escapeHtml(rowName(row))}</td><td>${escapeHtml(row.percentage || "-")}</td></tr>`))}
      </div>
      ${forms.length ? `<h2>Related forms</h2><ul class="static-link-list">${forms.map((form) => `<li><a href="/pokemon/${escapeHtml(form.slug)}/">${escapeHtml(form.name)}</a></li>`).join("")}</ul>` : ""}
    </div>
  </section>`;
}

function basePageHtml({ title, description, keywords, canonicalUrl, jsonLd, staticContent, pokemonSlug = "" }) {
  const template = readFileSync(join(cwd, "index.html"), "utf8");
  let html = template
    .replace('<meta name="viewport" content="width=device-width, initial-scale=1" />', '<meta name="viewport" content="width=device-width, initial-scale=1" />\n  <base href="/" />')
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escapeHtml(description)}" />`)
    .replace(/<meta name="keywords" content="[^"]*" \/>/, `<meta name="keywords" content="${escapeHtml(keywords)}" />`)
    .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`)
    .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`)
    .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${escapeHtml(title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${escapeHtml(description)}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${escapeHtml(title)}" />`)
    .replace(/<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${escapeHtml(description)}" />`)
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, `<script type="application/ld+json">\n  ${JSON.stringify(jsonLd, null, 2).replace(/\n/g, "\n  ")}\n  </script>`)
    .replace('<main>', `<main>\n    ${staticContent}`);
  if (pokemonSlug) {
    html = html.replace('<script src="app.js" defer></script>', `<script>window.__POKEMON_SLUG__ = ${JSON.stringify(pokemonSlug)};</script>\n  <script src="app.js" defer></script>`);
  }
  return html;
}

function pokemonPageHtml(page) {
  return basePageHtml({
    title: `${page.name} - ${siteName}`,
    description: page.description,
    keywords: page.keywords.join(", "),
    canonicalUrl: page.url,
    jsonLd: pokemonPageJsonLd(page),
    staticContent: pokemonStaticContent(page),
    pokemonSlug: page.slug
  });
}

function writePokemonPages(pages) {
  const pokemonDir = join(cwd, "pokemon");
  if (existsSync(pokemonDir)) rmSync(pokemonDir, { recursive: true, force: true });
  for (const page of pages) {
    const pageDir = join(pokemonDir, page.slug);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, "index.html"), pokemonPageHtml(page));
  }
}

const topicPageDefinitions = [
  {
    slug: "pokemon-champions-battle-data",
    query: "pokemon champions battle data",
    title: "Pokemon Champions Battle Data",
    description: "Pokemon Champions battle data with ranked usage, Singles and Doubles meta trends, movesets, held items, abilities, teammates, stat spreads, and API access.",
    render: () => `<h2>Doubles ranked usage</h2>${rankedPokemonTable("Doubles", 20)}<h2>Singles ranked usage</h2>${rankedPokemonTable("Singles", 20)}`
  },
  {
    slug: "pokemon-champions-ranked-usage",
    query: "pokemon champions ranked usage",
    title: "Pokemon Champions Ranked Usage",
    description: "Pokemon Champions ranked usage tables for the current Singles and Doubles battle data.",
    render: () => `<h2>Doubles usage ranking</h2>${rankedPokemonTable("Doubles", 30)}<h2>Singles usage ranking</h2>${rankedPokemonTable("Singles", 30)}`
  },
  {
    slug: "pokemon-champions-doubles-usage",
    query: "pokemon champions doubles usage",
    title: "Pokemon Champions Doubles Usage",
    description: "Pokemon Champions Doubles usage rankings with top moves, held items, and abilities for each ranked Pokemon.",
    render: () => rankedPokemonTable("Doubles", 50)
  },
  {
    slug: "pokemon-champions-singles-usage",
    query: "pokemon champions singles usage",
    title: "Pokemon Champions Singles Usage",
    description: "Pokemon Champions Singles usage rankings with top moves, held items, and abilities for each ranked Pokemon.",
    render: () => rankedPokemonTable("Singles", 50)
  },
  {
    slug: "pokemon-champions-api",
    query: "pokemon champions api",
    title: "Pokemon Champions API",
    description: "Pokemon Champions API reference for battle data, metadata, ranked usage, movesets, held items, teammates, stat spreads, and learnable moves.",
    render: () => `<p>The API exposes the same generated battle data used by the explorer. Use it to fetch Pokemon Champions usage stats, metadata, and profile data for tools or analysis.</p><ul class="static-link-list"><li><a href="/api_guide">Open the API guide</a></li><li><a href="/data/pokemon-index.json">Download the generated Pokemon index</a></li></ul>`
  },
  {
    slug: "pokemon-champions-best-pokemon",
    query: "best pokemon champions ranked",
    title: "Best Pokemon Champions Ranked Pokemon",
    description: "Best Pokemon Champions ranked Pokemon based on current battle-data usage positions and common movesets.",
    render: () => `<h2>Best ranked Pokemon in Doubles</h2>${rankedPokemonTable("Doubles", 30)}<h2>Best ranked Pokemon in Singles</h2>${rankedPokemonTable("Singles", 30)}`
  },
  {
    slug: "pokemon-champions-speed-tiers",
    query: "pokemon champions speed tiers",
    title: "Pokemon Champions Speed Tiers",
    description: "Pokemon Champions speed tiers sorted by base Speed, with Singles and Doubles usage ranks for quick competitive comparison.",
    render: () => speedTierTable(60)
  },
  {
    slug: "pokemon-champions-movesets",
    query: "pokemon champions movesets",
    title: "Pokemon Champions Movesets",
    description: "Pokemon Champions movesets from current battle data, showing the most common moves across ranked Pokemon.",
    render: () => `<h2>Common Doubles moves</h2>${aggregateTable("move", "Doubles", 50)}<h2>Common Singles moves</h2>${aggregateTable("move", "Singles", 50)}`
  },
  {
    slug: "pokemon-champions-held-items",
    query: "pokemon champions held items",
    title: "Pokemon Champions Held Items",
    description: "Pokemon Champions held item usage from current ranked battle data, including common items and example Pokemon.",
    render: () => `<h2>Common Doubles held items</h2>${aggregateTable("held_item", "Doubles", 50)}<h2>Common Singles held items</h2>${aggregateTable("held_item", "Singles", 50)}`
  },
  {
    slug: "pokemon-champions-teammates",
    query: "pokemon champions teammates",
    title: "Pokemon Champions Teammates",
    description: "Pokemon Champions teammate usage from ranked battle data, showing common partners and example Pokemon.",
    render: () => aggregateTable("teammate", "Doubles", 50)
  },
  {
    slug: "pokemon-champions-abilities",
    query: "pokemon champions abilities",
    title: "Pokemon Champions Abilities",
    description: "Pokemon Champions ability usage from current ranked battle data with common abilities and example Pokemon.",
    render: () => `<h2>Common Doubles abilities</h2>${aggregateTable("ability", "Doubles", 50)}<h2>Common Singles abilities</h2>${aggregateTable("ability", "Singles", 50)}`
  },
  {
    slug: "pokemon-champions-stat-spreads",
    query: "pokemon champions stat spreads",
    title: "Pokemon Champions Stat Spreads",
    description: "Pokemon Champions stat spreads and nature usage from current ranked battle data.",
    render: () => `<h2>Common natures</h2>${aggregateTable("stat_alignment", "Doubles", 50)}<h2>Common stat spreads</h2>${aggregateTable("stat_points", "Doubles", 50)}`
  }
];

function topicPageJsonLd(page) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        "@id": `${page.url}#webpage`,
        url: page.url,
        name: page.title,
        description: page.description,
        isPartOf: { "@id": `${siteUrl}/#website` },
        about: { "@id": `${siteUrl}/#dataset` }
      },
      {
        "@type": "Dataset",
        "@id": `${page.url}#dataset`,
        url: page.url,
        name: page.title,
        description: page.description,
        keywords: [page.query, "Pokemon Champions", "Pokemon Champions battle data", "Pokemon Champions ranked usage"],
        creator: { "@type": "Organization", name: siteName, url: `${siteUrl}/` },
        license: licenseUrl,
        isAccessibleForFree: true,
        isPartOf: { "@id": `${siteUrl}/#dataset` }
      }
    ]
  };
}

function topicStaticContent(page) {
  const links = topicPageDefinitions
    .filter((candidate) => candidate.slug !== page.slug)
    .slice(0, 8)
    .map((candidate) => `<li><a href="/${candidate.slug}/">${escapeHtml(candidate.title)}</a></li>`)
    .join("");
  return `<section class="section-shell static-seo-content" aria-label="${escapeHtml(page.title)}">
    <div class="content-area static-seo-panel">
      <p class="eyebrow">${escapeHtml(page.query)}</p>
      <h1>${escapeHtml(page.title)}</h1>
      <p>${escapeHtml(page.description)}</p>
      ${page.render()}
      <h2>Related Pokemon Champions resources</h2>
      <ul class="static-link-list">${links}</ul>
    </div>
  </section>`;
}

function buildTopicPages() {
  return topicPageDefinitions.map((definition) => ({
    ...definition,
    url: `${siteUrl}/${definition.slug}/`,
    keywords: unique([definition.query, definition.title, "Pokemon Champions", "Pokemon Champions battle data", "Pokemon Champions ranked usage"])
  }));
}

function writeTopicPages(pages) {
  for (const page of pages) {
    const pageDir = join(cwd, page.slug);
    if (existsSync(pageDir)) rmSync(pageDir, { recursive: true, force: true });
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, "index.html"), basePageHtml({
      title: page.title,
      description: page.description,
      keywords: page.keywords.join(", "),
      canonicalUrl: page.url,
      jsonLd: topicPageJsonLd(page),
      staticContent: topicStaticContent(page)
    }));
  }
}

function writeSitemap(pokemonPages, topicPages, generatedAt) {
  const lastmod = generatedAt.slice(0, 10);
  const urls = [
    `${siteUrl}/`,
    `${siteUrl}/api_guide`,
    licenseUrl,
    ...topicPages.map((page) => page.url),
    ...pokemonPages.map((page) => page.url)
  ];
  const entries = urls.map((url) => `  <url>\n    <loc>${escapeXml(url)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`).join("\n");
  writeFileSync(join(cwd, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`);
}

const skippedMetadataOnly = [...records.values()].filter((record) => !record.battleDataCsvs.length).map((record) => record.name);

const generatedAt = new Date().toISOString();
const dataVersion = generatedAt.replace(/\D/g, "");
const pokemonPages = buildPokemonPages(pokemon);
const topicPages = buildTopicPages();

mkdirSync(join(cwd, "data"), { recursive: true });
writeFileSync(join(cwd, "data", "pokemon-index.json"), `${JSON.stringify({
  generatedAt,
  dataVersion,
  assetRoot,
  battleDataFolders,
  seasons: availableSeasons,
  defaultSeason: availableSeasons.includes(defaultSeason) ? defaultSeason : availableSeasons[0] || "Current",
  topicPages: topicPages.map(({ title, slug, url, query }) => ({ title, slug, url, query })),
  pokemonPages: pokemonPages.map(({ name, slug, url, battleName, baseName, isForm }) => ({ name, slug, url, battleName, baseName, isForm })),
  pokemon
}, null, 2)}\n`);
writePokemonPages(pokemonPages);
writeTopicPages(topicPages);
writeSitemap(pokemonPages, topicPages, generatedAt);

console.log(`Generated data/pokemon-index.json with ${pokemon.length} Pokemon, ${pokemonPages.length} profile page(s), and ${topicPages.length} topic page(s).`);
if (skippedMetadataOnly.length) console.warn(`Skipped ${skippedMetadataOnly.length} metadata-only name(s): ${skippedMetadataOnly.join(", ")}`);