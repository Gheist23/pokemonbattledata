import { fetchIndex, findPokemon, fetchAssetText, parseCsv, jsonResponse, optionsResponse, errorResponse } from '../_common.js';

export const onRequestOptions = () => optionsResponse();

export async function onRequestGet({ env, request, params }) {
  try {
    const index = await fetchIndex(env, request);
    const entry = findPokemon(index, params.name);
    if (!entry) return errorResponse('Pokemon not found.', 404, { name: params.name });
    if (!entry.metadataCsv) return errorResponse('Metadata CSV not found for this Pokemon.', 404, { name: entry.name });

    const text = await fetchAssetText(env, request, entry.metadataCsv);
    const parsed = parseCsv(text);
    return jsonResponse({
      pokemon: entry.name,
      source: entry.metadataCsv,
      columns: parsed.columns,
      rows: parsed.rows
    });
  } catch (error) {
    return errorResponse('Could not load metadata.', 500, { details: error.message });
  }
}
