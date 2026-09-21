// POST /api/sync  {document}  ->  {code, revision}
// Creates a new sync code holding the caller's teams and boxes.

import { cleanDocument, json, newCode, readBody, storageKey, store } from "./_lib.js";

export async function onRequestPost({ request, env }) {
  const kv = store(env);
  if (!kv) return json({ error: "Sync is not configured on this server." }, 503);
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return json({ error: error.message }, error.status || 400);
  }
  let document;
  try {
    document = cleanDocument(body.document || { teams: [], boxes: [] });
  } catch (error) {
    return json({ error: error.message }, error.status || 400);
  }
  // A fresh random code colliding with an existing one is astronomically
  // unlikely, but checking costs one read.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = newCode();
    const key = await storageKey(code);
    if (await kv.get(key)) continue;
    const record = { revision: 1, updatedAt: Date.now(), document };
    await kv.put(key, JSON.stringify(record));
    return json({ code, revision: record.revision, updatedAt: record.updatedAt }, 201);
  }
  return json({ error: "Could not allocate a sync code, please try again." }, 500);
}
