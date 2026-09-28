// POST /api/share   ->  201 {code, pageUrl, imageUrl, recordUrl, expiresAt}
//
// Creates ONE share: the digest and the card bytes arrive together, in a single
// request, and the server picks the code.  That is deliberate:
//
//   * there is no window in which a code exists with no image, so a crawler
//     that unfurls the link the moment it is pasted always finds a real PNG;
//   * a share is immutable -- nobody can swap the card under a link that has
//     already been posted, because there is no route that writes to an existing
//     code at all;
//   * nothing about the caller is read or stored.  No licence, no e-mail, no
//     machine id, no IP, no header.  Only the cleaned digest and the bytes.
//
// Two body shapes, because two very different clients produce them:
//   multipart/form-data   record=<json>            image=<png file>   (browser)
//   application/json      {record:{...}, imageBase64:"..."}           (Companion)
//
// The Function never rasterises and never fetches anything from a request body.

import {
  MAX_BODY_BYTES, MAX_CARD_BYTES, MAX_NEW_BYTES_PER_DAY, cleanDigest, dedupeKey, imageKey,
  imageUrl, json, makeRecord, newCode, pageUrl, recordKey, store, usageKey, validatePng,
} from "./_lib.js";

/** A browser may only create a share from this site.  The Companion sends no
 *  Origin at all, so it is unaffected; a page on someone else's domain that
 *  tries to drive a visitor's browser into minting shares is refused. */
function originAllowed(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (host === "championsbattledata.com" || host === "www.championsbattledata.com") return true;
  if (host.endsWith(".pages.dev")) return true;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function tooBig(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  return Number.isFinite(declared) && declared > MAX_BODY_BYTES;
}

function decodeBase64(raw) {
  const cleaned = String(raw || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!cleaned) throw Object.assign(new Error("missing image"), { status: 400 });
  // Refuse before decoding, so an oversized string is never expanded in memory.
  if (cleaned.length > Math.ceil((MAX_CARD_BYTES * 4) / 3) + 8) {
    throw Object.assign(new Error(`A card must be at most ${MAX_CARD_BYTES} bytes.`), { status: 413 });
  }
  let binary;
  try {
    binary = atob(cleaned);
  } catch {
    throw Object.assign(new Error("The image is not valid base64."), { status: 400 });
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readSubmission(request) {
  const type = String(request.headers.get("content-type") || "").toLowerCase();
  if (type.includes("multipart/form-data")) {
    // formData() buffers the whole body and takes no size argument, so a
    // declared content-length over MAX_BODY_BYTES (refused above) is the only
    // cheap guard there is.  A body sent without one is bounded by the
    // platform's own request limit and costs no storage, because validatePng
    // still refuses anything over MAX_CARD_BYTES before a single write.
    // Requiring content-length here would be stricter, and was tried: undici
    // does not surface it on a constructed Request, so it could not be tested,
    // and an untested guard on the only path the website uses is worse than the
    // risk it removes.
    const form = await request.formData();
    const rawRecord = form.get("record") ?? form.get("digest");
    const rawImage = form.get("image") ?? form.get("card");
    const recordText = typeof rawRecord === "string" ? rawRecord : await rawRecord?.text?.();
    if (!recordText) throw Object.assign(new Error("expected a record field"), { status: 400 });
    if (!rawImage || typeof rawImage.arrayBuffer !== "function") {
      throw Object.assign(new Error("expected an image field"), { status: 400 });
    }
    let parsed;
    try {
      parsed = JSON.parse(recordText);
    } catch {
      throw Object.assign(new Error("expected JSON in the record field"), { status: 400 });
    }
    return { raw: parsed, bytes: new Uint8Array(await rawImage.arrayBuffer()) };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw Object.assign(new Error("That is more data than a share can hold."), { status: 413 });
  }
  let body;
  try {
    // `|| {}` because JSON.parse("null") is null, and `body.record` on it threw
    // a TypeError whose internal message was handed straight back to the caller.
    body = JSON.parse(text || "{}") || {};
  } catch {
    throw Object.assign(new Error("expected JSON"), { status: 400 });
  }
  if (typeof body !== "object") throw Object.assign(new Error("expected JSON"), { status: 400 });
  return { raw: body.record ?? body.digest, bytes: decodeBase64(body.imageBase64 ?? body.image) };
}

/** The day's byte budget: the only thing that bounds storage growth against an
 *  anonymous writer.  Read, compare, write -- approximate under concurrency and
 *  documented as such in _lib.js. */
async function checkBudget(bucket, bytes, now) {
  const key = usageKey(now);
  let used = { bytes: 0, count: 0 };
  const current = await bucket.get(key);
  if (current) {
    try {
      const parsed = JSON.parse(await current.text());
      used = { bytes: Number(parsed.bytes) || 0, count: Number(parsed.count) || 0 };
    } catch {
      used = { bytes: 0, count: 0 };
    }
  }
  if (used.bytes + bytes > MAX_NEW_BYTES_PER_DAY) return null;
  return { key, next: { bytes: used.bytes + bytes, count: used.count + 1 } };
}

export async function onRequestPost({ request, env }) {
  const bucket = store(env);
  if (!bucket) return json({ error: "Sharing is not configured on this server." }, 503);
  if (!originAllowed(request)) return json({ error: "Shares can only be created from this site." }, 403);
  if (tooBig(request)) return json({ error: "That is more data than a share can hold." }, 413);

  let submission;
  let digest;
  let bytes;
  try {
    submission = await readSubmission(request);
    digest = cleanDigest(submission.raw);
    bytes = validatePng(submission.bytes);
  } catch (error) {
    return json({ error: error.message || "Bad request" }, error.status || 400);
  }

  const now = Date.now();
  const record = makeRecord(digest, bytes.length, now);
  const recordText = JSON.stringify(record);

  // Pressing Share twice on the same team is the same share: the pointer is a
  // content address, so a repeat costs one read and no new storage.
  const pointer = await dedupeKey(JSON.stringify(digest), bytes);
  const existing = await bucket.get(pointer);
  if (existing) {
    const known = (await existing.text()).trim();
    if (known && (await bucket.head(await recordKey(known)))) {
      return json({
        code: known,
        kind: digest.kind,
        reused: true,
        pageUrl: pageUrl(request, known),
        imageUrl: imageUrl(request, known),
        recordUrl: `${pageUrl(request, known)}?format=json`,
        bytes: bytes.length,
      }, 200);
    }
  }

  const budget = await checkBudget(bucket, bytes.length, now);
  if (!budget) {
    return json({ error: "Sharing has hit today's limit on this server; please try again tomorrow." }, 429);
  }

  let code = "";
  for (let attempt = 0; attempt < 3 && !code; attempt += 1) {
    const candidate = newCode();
    if (!(await bucket.head(await recordKey(candidate)))) code = candidate;
  }
  if (!code) return json({ error: "Could not allocate a share code, please try again." }, 500);

  await Promise.all([
    bucket.put(await imageKey(code), bytes, {
      httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" },
      // The image route reads the expiry from here, so serving a card costs one
      // read and not two (functions/api/share/img/[code].js).
      customMetadata: { expiresAt: String(record.expiresAt) },
    }),
    bucket.put(await recordKey(code), recordText, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    }),
  ]);
  await Promise.all([
    bucket.put(pointer, code, { httpMetadata: { contentType: "text/plain; charset=utf-8" } }),
    bucket.put(budget.key, JSON.stringify(budget.next), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    }),
  ]);

  return json({
    code,
    kind: digest.kind,
    reused: false,
    pageUrl: pageUrl(request, code),
    imageUrl: imageUrl(request, code),
    recordUrl: `${pageUrl(request, code)}?format=json`,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    bytes: bytes.length,
  }, 201);
}
