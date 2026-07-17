import { fetchPokemonEntry, getFormatPath, getDailyFormatPaths, normalizeFormat, parseDaysParam, jsonResponse, optionsResponse, errorResponse } from '../_common.js';

export const onRequestOptions = () => optionsResponse();

export async function onRequestGet({ env, request, params }) {
  try {
    const entry = await fetchPokemonEntry(env, request, params.name);
    if (!entry) return errorResponse('Pokemon not found.', 404, { name: params.name });

    const url = new URL(request.url);
    const requestedFormat = normalizeFormat(url.searchParams.get('format'));
    const requestedSeason = url.searchParams.get('season') || undefined;
    const daysRaw = url.searchParams.get('days');
    const requestedDays = parseDaysParam(daysRaw);
    if (daysRaw !== null && requestedDays === null) return errorResponse('Invalid days value. Use an integer from 1 to 31.', 400, { days: daysRaw });
    const payload = { ...entry };

    if (requestedFormat) {
      const battleDataCsv = getFormatPath(entry, requestedFormat, requestedSeason);
      payload.requestedFormat = requestedFormat;
      payload.requestedSeason = battleDataCsv?.season || requestedSeason || 'Current';
      payload.battleDataCsv = battleDataCsv;
      payload.battleSummary = entry.summary?.battleSummary?.[payload.requestedSeason]?.[requestedFormat] ||
        entry.summary?.battleSummary?.[requestedFormat] ||
        null;
      if (requestedDays !== null) {
        payload.requestedDays = requestedDays;
        payload.dailyBattleDataCsvs = getDailyFormatPaths(entry, requestedFormat, { season: requestedSeason, days: requestedDays });
      }
    }

    return jsonResponse(payload);
  } catch (error) {
    return errorResponse('Could not load Pokemon record.', 500, { details: error.message });
  }
}
