// GET /api/rankings — the ladder ordering itself, for one format and one season.
//
// WHY THIS EXISTS. /api/pokemon/<name> answers "what is this species doing", and the question
// people bring to a ladder is the other way round: "who is at position 7". Reaching that
// through the species endpoint means one request per species and then a sort on the client --
// around 260 requests per format, which is exactly the load this is here to remove. The
// endpoint is a RANK, not a Pokemon.
//
// Past seasons are served too. `summary.battleSummary` used to hold only "Current", because a
// season-level figure is written by a non-daily battle-data CSV and only the live season has
// one; every archived season is a run of daily snapshots. The generator now folds each
// season's LAST snapshot into `battleSummary[season]`, so M1 through M7 answer here as well as
// in /api/pokemon/<name>.
//
//   /api/rankings                                  Doubles, Current, the whole list
//   /api/rankings?format=Singles                   Singles, Current
//   /api/rankings?season=M6&format=Doubles         as season M6 closed
//   /api/rankings?limit=20                         the top 20
//   /api/rankings?limit=20&offset=20               positions 21-40
//   /api/rankings?name=garchomp                    just that one entry, with its position
//
// Nothing here is new DATA -- `position` is the game's own column order, which is the ranking.

import { fetchAssetJson, jsonResponse, normalizeFormat, optionsResponse, errorResponse } from '../_common.js';

export const onRequestOptions = () => optionsResponse();

const DEFAULT_FORMAT = 'Doubles';
const DEFAULT_SEASON = 'Current';
/** A cap, so one request cannot ask for an unbounded slice. The whole list is ~262 entries. */
const MAX_LIMIT = 1000;

function parseBound(value, { min, max, fallback }) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return null;
  return number;
}

/** The season key that matches `wanted`, case-insensitively, or null. */
function resolveSeason(available, wanted) {
  const text = String(wanted || '').trim();
  if (!text) return DEFAULT_SEASON;
  return available.find((season) => String(season).toLowerCase() === text.toLowerCase()) || null;
}

export async function onRequestGet({ env, request }) {
  try {
    const url = new URL(request.url);
    const payload = await fetchAssetJson(env, request, 'data/api/rankings.json');
    const available = Array.isArray(payload.seasons) ? payload.seasons : Object.keys(payload.rankings || {});

    const requestedFormat = url.searchParams.get('format');
    const format = requestedFormat ? normalizeFormat(requestedFormat) : DEFAULT_FORMAT;
    if (!format) {
      return errorResponse('Unknown format. Use Doubles or Singles.', 400,
        { format: requestedFormat, formats: payload.formats || [] });
    }

    const requestedSeason = url.searchParams.get('season');
    const season = resolveSeason(available, requestedSeason);
    if (!season) {
      return errorResponse('Unknown season.', 400, { season: requestedSeason, seasons: available });
    }

    const list = payload.rankings?.[season]?.[format];
    if (!Array.isArray(list)) {
      return errorResponse('No ranking for that season and format.', 404,
        { season, format, seasons: available, formats: payload.formats || [] });
    }

    // One name asked about: answer with its own position rather than making the caller scan.
    const wantedName = url.searchParams.get('name');
    if (wantedName) {
      const key = String(wantedName).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
      const match = list.find((entry) => [entry.slug, entry.name, entry.battleName, entry.showdownId]
        .some((value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '') === key));
      if (!match) return errorResponse('Not ranked in that season and format.', 404, { name: wantedName, season, format });
      return jsonResponse({
        generatedAt: payload.generatedAt,
        dataVersion: payload.dataVersion,
        season,
        format,
        total: list.length,
        rankings: [match]
      });
    }

    const limit = parseBound(url.searchParams.get('limit'), { min: 1, max: MAX_LIMIT, fallback: list.length });
    if (limit === null) return errorResponse(`Invalid limit. Use an integer from 1 to ${MAX_LIMIT}.`, 400, { limit: url.searchParams.get('limit') });
    const offset = parseBound(url.searchParams.get('offset'), { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
    if (offset === null) return errorResponse('Invalid offset. Use an integer of 0 or more.', 400, { offset: url.searchParams.get('offset') });

    const slice = list.slice(offset, offset + limit);
    return jsonResponse({
      generatedAt: payload.generatedAt,
      dataVersion: payload.dataVersion,
      season,
      format,
      seasons: available,
      formats: payload.formats || [],
      total: list.length,
      offset,
      count: slice.length,
      rankings: slice
    });
  } catch (error) {
    return errorResponse('Could not load rankings.', 500, { details: error.message });
  }
}
