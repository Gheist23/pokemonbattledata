import { fetchPokemonEntry, getFormatPath, normalizeFormat, fetchAssetText, parseCsv, jsonResponse, optionsResponse, errorResponse } from '../../_common.js';

export const onRequestOptions = () => optionsResponse();

export async function onRequestGet({ env, request, params }) {
  try {
    const format = normalizeFormat(params.format);
    if (!format) return errorResponse('Unknown format. Use Singles or Doubles.', 400, { format: params.format });
    const season = new URL(request.url).searchParams.get('season') || undefined;

    const entry = await fetchPokemonEntry(env, request, params.name);
    if (!entry) return errorResponse('Pokemon not found.', 404, { name: params.name });

    const battleDataCsv = getFormatPath(entry, format, season);
    if (!battleDataCsv) return errorResponse('Battle data not found for this format.', 404, { name: entry.name, format, season });

    const text = await fetchAssetText(env, request, battleDataCsv.path);
    const parsed = parseCsv(text);
    const rows = parsed.rows.map((row) => {
      const percentage = String(row.percentage || '').trim();
      const percentageValue = percentage.endsWith('%') ? Number(percentage.slice(0, -1)) : null;
      return {
        ...row,
        percentage_value: Number.isFinite(percentageValue) ? percentageValue : null
      };
    });

    return jsonResponse({
      pokemon: entry.name,
      format,
      season: battleDataCsv.season,
      source: battleDataCsv.path,
      columns: parsed.columns,
      rows
    });
  } catch (error) {
    return errorResponse('Could not load battle data.', 500, { details: error.message });
  }
}
