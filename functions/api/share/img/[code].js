// GET /api/share/img/<code>  ->  the card, image/png
//
// This route does no work beyond one hash and one R2 read, which is what keeps
// it inside the Workers free plan's 10 ms of CPU per request.  It NEVER
// rasterises: the bytes were drawn by the client that made the share and
// uploaded with it, which is also why a crawler that runs no JavaScript still
// gets a real picture.
//
// A whole path segment holds the code -- /api/share/img/<code>, in the shape
// every other dynamic route in this tree uses (functions/api/pokemon/[name].js,
// functions/api/battle/[format]/[name].js).  Not "<code>.png": an extension
// inside a single segment has no precedent here and Pages generates the routing
// itself.  og:image is resolved by the content type, not by the URL's tail, and
// og:image:type is declared anyway.
//
// A CRAWLER MUST NEVER GET A BROKEN IMAGE.  So an unknown, malformed or expired
// code is answered with 200 and the built-in 1200x630 fallback card, on a short
// cache, and marked with x-share-card: fallback for anyone debugging.  A real
// card is immutable -- there is no route that can overwrite one -- so it is
// served with a one-year immutable cache.

import { fallbackPng, imageKey, normaliseCode, store } from "../_lib.js";

const IMMUTABLE = "public, max-age=31536000, immutable";
const SHORT = "public, max-age=300";

function fallback(reason) {
  const bytes = fallbackPng();
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "content-length": String(bytes.length),
      "cache-control": SHORT,
      "x-share-card": "fallback",
      "x-share-card-reason": reason,
      "access-control-allow-origin": "*",
    },
  });
}

export async function onRequestGet({ params, env }) {
  const code = normaliseCode(params?.code);
  if (!code) return fallback("not-a-code");

  const bucket = store(env);
  if (!bucket) return fallback("not-configured");

  const object = await bucket.get(await imageKey(code));
  if (!object) return fallback("unknown");

  // An expired share stops showing its card even before a bucket lifecycle rule
  // gets round to deleting the object.  The expiry rides on the image object's
  // own metadata, so this route still costs exactly one read -- reading the
  // record here would double the ops on the hottest route in the feature.
  const expiresAt = Number(object.customMetadata?.expiresAt || 0);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() >= expiresAt) return fallback("expired");

  const headers = {
    "content-type": "image/png",
    "cache-control": IMMUTABLE,
    "x-share-card": "card",
    "access-control-allow-origin": "*",
  };
  if (object.httpEtag) headers.etag = object.httpEtag;
  if (Number.isFinite(Number(object.size))) headers["content-length"] = String(object.size);
  return new Response(object.body ?? object, { status: 200, headers });
}

export const onRequestHead = onRequestGet;
