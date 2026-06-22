const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400'
};
const defaultSeason = 'Season M-2';

export function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=120, s-maxage=900',
      ...extraHeaders
    }
  });
}

export function errorResponse(message, status = 404, details = {}) {
  return jsonResponse({ error: message, ...details }, status, {
    'Cache-Control': 'public, max-age=30, s-maxage=60'
  });
}

export function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function normalizeFormat(value) {
  const normalized = normalize(value);
  if (normalized === 'single' || normalized === 'singles') return 'Singles';
  if (normalized === 'double' || normalized === 'doubles') return 'Doubles';
  return null;
}

export function normalizeSeason(value) {
  const raw = String(value || '').trim();
  return raw || defaultSeason;
}

export async function fetchAssetText(env, request, path) {
  const cleanPath = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const assetUrl = new URL(`/${cleanPath}`, request.url);
  const response = await env.ASSETS.fetch(assetUrl.toString());
  if (!response.ok) {
    throw new Error(`Asset not found: ${cleanPath}`);
  }
  return response.text();
}

export async function fetchIndex(env, request) {
  const text = await fetchAssetText(env, request, 'data/pokemon-index.json');
  return JSON.parse(text);
}

export function findPokemon(index, rawName) {
  const wanted = normalize(decodeURIComponent(rawName || ''));
  if (!wanted) return null;
  return (index.pokemon || []).find((entry) => {
    if (normalize(entry.name) === wanted) return true;
    const summary = entry.summary || {};
    if (normalize(summary.primary?.pokemon_name) === wanted) return true;
    if (normalize(summary.primary?.base_name) === wanted) return true;
    return (summary.forms || []).some((form) => (
      normalize(form.saved_name) === wanted ||
      normalize(form.form_name) === wanted ||
      normalize(form.pokemon_name) === wanted ||
      normalize(form.base_name) === wanted ||
      normalize(form.title) === wanted
    ));
  }) || null;
}

export function getFormatPath(entry, format, season) {
  const cleanFormat = normalizeFormat(format);
  if (!cleanFormat) return null;
  const hasExplicitSeason = season !== undefined && season !== null && String(season).trim() !== '';
  const cleanSeason = normalizeSeason(season);
  const sources = entry.battleDataCsvs || [];
  const exact = sources.find((item) => normalizeFormat(item.format) === cleanFormat && normalize(item.season) === normalize(cleanSeason));
  if (exact) return exact;
  if (hasExplicitSeason) return null;
  const legacy = sources.find((item) => normalizeFormat(item.format) === cleanFormat && !item.season);
  if (legacy) return { ...legacy, season: cleanSeason, path: pathForSeason(legacy.path, cleanSeason) };
  return sources.find((item) => normalizeFormat(item.format) === cleanFormat) || null;
}

function pathForSeason(path, season) {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const index = parts.findIndex((part) => normalize(part) === 'battledata');
  if (index === -1 || !parts[index + 1] || /^season\b/i.test(parts[index + 1])) return parts.join('/');
  parts.splice(index + 1, 0, season);
  return parts.join('/');
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function coerceValue(key, value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed === '') return '';
  const numericKeys = new Set([
    'column_position', 'position', 'rank', 'hp', 'atk', 'def', 'spa', 'spd', 'spe', 'total',
    'hp_points', 'attack_points', 'defense_points', 'sp_atk_points',
    'sp_def_points', 'speed_points', 'source_time_seconds'
  ]);
  if (numericKeys.has(key)) {
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : trimmed;
  }
  if (key === 'percentage_value') {
    const number = Number(trimmed.replace('%', ''));
    return Number.isFinite(number) ? number : trimmed;
  }
  return trimmed;
}

export function parseCsv(text) {
  const cleanText = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!cleanText) return { columns: [], rows: [] };
  const lines = cleanText.split('\n').filter((line) => line.trim().length > 0);
  const columns = splitCsvLine(lines.shift()).map((column) => column.trim());
  const rows = lines.map((line) => {
    const cells = splitCsvLine(line);
    return columns.reduce((record, column, index) => {
      const key = column.trim();
      record[key] = coerceValue(key, cells[index] ?? '');
      return record;
    }, {});
  });
  return { columns, rows };
}
