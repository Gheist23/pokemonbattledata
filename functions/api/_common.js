const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400'
};
const defaultSeason = 'Current';

export function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
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

export function parseDaysParam(value, maxDays = 31) {
  if (value === null || value === undefined || value === '') return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > maxDays) return null;
  return days;
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

export async function fetchAssetJson(env, request, path) {
  return JSON.parse(await fetchAssetText(env, request, path));
}

export async function jsonAssetResponse(env, request, path, extraHeaders = {}) {
  const cleanPath = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const assetUrl = new URL(`/${cleanPath}`, request.url);
  const response = await env.ASSETS.fetch(assetUrl.toString());
  if (!response.ok) throw new Error(`Asset not found: ${cleanPath}`);
  const headers = new Headers(response.headers);
  Object.entries({
    ...corsHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=120, s-maxage=1800',
    ...extraHeaders
  }).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}


export async function fetchPokemonEntry(env, request, rawName) {
  const wanted = normalize(decodeURIComponent(rawName || ''));
  if (!wanted) return null;
  const lookup = await fetchAssetJson(env, request, 'data/api/lookup.json');
  const slug = lookup.aliases?.[wanted];
  if (!slug) return null;
  return fetchAssetJson(env, request, `data/api/pokemon/${slug}.json`);
}

function parseDailyDate(value) {
  const match = String(value || '').match(/^(\d{2})_(\d{2})_(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function compareDailySource(a, b) {
  const ad = parseDailyDate(a.date);
  const bd = parseDailyDate(b.date);
  if (ad !== null && bd !== null && ad !== bd) return bd - ad;
  if (ad !== null && bd === null) return -1;
  if (ad === null && bd !== null) return 1;
  return String(b.season || '').localeCompare(String(a.season || ''), undefined, { numeric: true, sensitivity: 'base' });
}

export function getDailyFormatPaths(entry, format, { season, days } = {}) {
  const cleanFormat = normalizeFormat(format);
  if (!cleanFormat) return [];
  const cleanSeason = season ? normalize(season) : '';
  const sources = (entry.battleDataCsvs || [])
    .filter((item) => item?.daily && item?.date && normalizeFormat(item.format) === cleanFormat)
    .filter((item) => !cleanSeason || normalize(item.season) === cleanSeason)
    .sort(compareDailySource);
  return Number.isInteger(days) ? sources.slice(0, days) : sources;
}

export function getDailyFormatSummaries(entry, format, { season, days } = {}) {
  const cleanFormat = normalizeFormat(format);
  if (!cleanFormat) return [];
  return getDailyFormatPaths(entry, cleanFormat, { season, days }).map((source) => ({
    season: source.season,
    date: source.date,
    format: cleanFormat,
    source: source.path,
    summary: entry.summary?.dailyBattleSummary?.[source.season]?.[source.date]?.[cleanFormat] || null
  }));
}

export function getFormatPath(entry, format, season) {
  const cleanFormat = normalizeFormat(format);
  if (!cleanFormat) return null;
  const hasExplicitSeason = season !== undefined && season !== null && String(season).trim() !== '';
  const cleanSeason = normalizeSeason(season);
  const sources = entry.battleDataCsvs || [];
  const exact = sources.find((item) => {
    if (item.daily) return false;
    if (normalizeFormat(item.format) !== cleanFormat) return false;
    if (normalize(item.season) === normalize(cleanSeason)) return true;
    return normalize(item.season) === 'current' && normalize(cleanSeason) === normalize(defaultSeason);
  });
  if (exact) return normalize(exact.season) === 'current' ? { ...exact, season: defaultSeason } : exact;
  if (hasExplicitSeason) {
    const daily = getDailyFormatPaths(entry, cleanFormat, { season: cleanSeason, days: 1 })[0];
    return daily || null;
  }
  const legacy = sources.find((item) => !item.daily && normalizeFormat(item.format) === cleanFormat && (!item.season || normalize(item.season) === 'current'));
  if (legacy) return { ...legacy, season: defaultSeason };
  return sources.find((item) => !item.daily && normalizeFormat(item.format) === cleanFormat) || null;
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
