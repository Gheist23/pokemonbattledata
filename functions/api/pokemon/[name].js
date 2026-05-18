import { fetchIndex, findPokemon, getFormatPath, normalizeFormat, jsonResponse, optionsResponse, errorResponse } from '../_common.js';

export const onRequestOptions = () => optionsResponse();

export async function onRequestGet({ env, request, params }) {
  try {
    const index = await fetchIndex(env, request);
    const entry = findPokemon(index, params.name);
    if (!entry) return errorResponse('Pokemon not found.', 404, { name: params.name });

    const url = new URL(request.url);
    const requestedFormat = normalizeFormat(url.searchParams.get('format'));
    const payload = { ...entry };

    if (requestedFormat) {
      const battleDataCsv = getFormatPath(entry, requestedFormat);
      payload.requestedFormat = requestedFormat;
      payload.battleDataCsv = battleDataCsv;
      payload.battleSummary = entry.summary?.battleSummary?.[requestedFormat] || null;
    }

    return jsonResponse(payload);
  } catch (error) {
    return errorResponse('Could not load Pokemon record.', 500, { details: error.message });
  }
}
