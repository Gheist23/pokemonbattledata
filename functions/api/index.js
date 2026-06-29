import { jsonAssetResponse, optionsResponse, errorResponse } from './_common.js';

export const onRequestOptions = () => optionsResponse();

export async function onRequestGet({ env, request }) {
  try {
    return await jsonAssetResponse(env, request, 'data/api/index.json');
  } catch (error) {
    return errorResponse('Could not load Pokemon index.', 500, { details: error.message });
  }
}
