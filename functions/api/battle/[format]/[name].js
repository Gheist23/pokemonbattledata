import { fetchPokemonEntry, getFormatPath, getDailyFormatPaths, normalizeFormat, fetchAssetText, parseCsv, parseDaysParam, jsonResponse, optionsResponse, errorResponse } from '../../_common.js';

export const onRequestOptions = () => optionsResponse();

function rowsWithPercentages(parsed) {
  return parsed.rows.map((row) => {
    const percentage = String(row.percentage || '').trim();
    const percentageValue = percentage.endsWith('%') ? Number(percentage.slice(0, -1)) : null;
    return {
      ...row,
      percentage_value: Number.isFinite(percentageValue) ? percentageValue : null
    };
  });
}

export async function onRequestGet({ env, request, params }) {
  try {
    const format = normalizeFormat(params.format);
    if (!format) return errorResponse('Unknown format. Use Singles or Doubles.', 400, { format: params.format });
    const url = new URL(request.url);
    const season = url.searchParams.get('season') || undefined;
    const daysRaw = url.searchParams.get('days');
    const days = parseDaysParam(daysRaw);
    if (daysRaw !== null && days === null) return errorResponse('Invalid days value. Use an integer from 1 to 31.', 400, { days: daysRaw });

    const entry = await fetchPokemonEntry(env, request, params.name);
    if (!entry) return errorResponse('Pokemon not found.', 404, { name: params.name });

    if (days !== null) {
      const dailySources = getDailyFormatPaths(entry, format, { season, days });
      if (!dailySources.length) return errorResponse('Daily battle data not found for this request.', 404, { name: entry.name, format, season, days });
      const daily = await Promise.all(dailySources.map(async (source) => {
        const text = await fetchAssetText(env, request, source.path);
        const parsed = parseCsv(text);
        return {
          season: source.season,
          date: source.date,
          source: source.path,
          columns: parsed.columns,
          rows: rowsWithPercentages(parsed)
        };
      }));
      return jsonResponse({
        pokemon: entry.name,
        showdownId: entry.showdownId || null,
        format,
        requestedDays: days,
        season: season || null,
        daily
      });
    }

    const battleDataCsv = getFormatPath(entry, format, season);
    if (!battleDataCsv) return errorResponse('Battle data not found for this format.', 404, { name: entry.name, format, season });

    const text = await fetchAssetText(env, request, battleDataCsv.path);
    const parsed = parseCsv(text);
    const rows = rowsWithPercentages(parsed);

    return jsonResponse({
      pokemon: entry.name,
      showdownId: entry.showdownId || null,
      format,
      season: battleDataCsv.season,
      date: battleDataCsv.date || null,
      source: battleDataCsv.path,
      columns: parsed.columns,
      rows
    });
  } catch (error) {
    return errorResponse('Could not load battle data.', 500, { details: error.message });
  }
}
