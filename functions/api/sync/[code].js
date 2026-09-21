// GET /api/sync/CBD-XXXX-XXXX-XXXX-XXXX           -> {revision, updatedAt, document}
// PUT /api/sync/CBD-...  {baseRevision, document}  -> {revision, updatedAt}
//
// A PUT based on an older revision is refused with 409 and the current copy,
// so the client merges it and tries again instead of overwriting the other
// device's changes.  Both the website and the Companion merge the same way:
// by id, newest `updated` wins, tombstones beat older copies.

import { cleanDocument, json, normaliseCode, readBody, storageKey, store } from "./_lib.js";

async function load(kv, code) {
  const raw = await kv.get(await storageKey(code));
  return raw ? JSON.parse(raw) : null;
}

export async function onRequestGet({ params, env }) {
  const kv = store(env);
  if (!kv) return json({ error: "Sync is not configured on this server." }, 503);
  const code = normaliseCode(params.code);
  if (!code) return json({ error: "That is not a sync code." }, 400);
  const record = await load(kv, code);
  if (!record) return json({ error: "Unknown sync code." }, 404);
  return json(record);
}

export async function onRequestPut({ params, request, env }) {
  const kv = store(env);
  if (!kv) return json({ error: "Sync is not configured on this server." }, 503);
  const code = normaliseCode(params.code);
  if (!code) return json({ error: "That is not a sync code." }, 400);
  let body;
  let document;
  try {
    body = await readBody(request);
    document = cleanDocument(body.document);
  } catch (error) {
    return json({ error: error.message }, error.status || 400);
  }
  const current = await load(kv, code);
  if (!current) return json({ error: "Unknown sync code." }, 404);
  if (Number(body.baseRevision) !== Number(current.revision)) {
    return json({ error: "The synced data changed; merge and retry.", ...current }, 409);
  }
  const record = { revision: Number(current.revision) + 1, updatedAt: Date.now(), document };
  await kv.put(await storageKey(code), JSON.stringify(record));
  return json({ revision: record.revision, updatedAt: record.updatedAt });
}
