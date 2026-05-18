import { fetchIndex, jsonResponse, optionsResponse, errorResponse } from './_common.js';

export const onRequestOptions = () => optionsResponse();

export async function onRequestGet({ env, request }) {
  try {
    const index = await fetchIndex(env, request);
    return jsonResponse(index, 200, { 'Cache-Control': 'public, max-age=120, s-maxage=1800' });
  } catch (error) {
    return errorResponse('Could not load Pokemon index.', 500, { details: error.message });
  }
}
