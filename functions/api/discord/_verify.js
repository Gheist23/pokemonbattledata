// Ed25519 verification for the Discord interactions endpoint.
//
// Discord signs `timestamp + rawBody` with the application's key and sends the
// signature in `X-Signature-Ed25519`. Everything that fails must answer 401,
// including the PING Discord sends when the endpoint URL is saved: Discord only
// accepts the URL if a deliberately corrupted signature is rejected, and an
// endpoint that answered 200 to an unsigned body would take anyone's traffic.
//
// The freshness window is ours, not Discord's. A correctly signed body stays
// valid forever on its own, so a captured request could be replayed at any
// time; a captured body older than the window is refused even though its
// signature is genuine.
//
// The public key is a raw 32-byte Ed25519 key, written as 64 hex characters in
// the Discord developer portal (DISCORD_PUBLIC_KEY). It is not a secret.

export const SIGNATURE_HEADER = 'x-signature-ed25519';
export const TIMESTAMP_HEADER = 'x-signature-timestamp';
export const MAX_SIGNATURE_AGE_SECONDS = 300;

const keyCache = new Map();

export function hexToBytes(hex) {
  const clean = String(hex ?? '').trim().toLowerCase();
  if (!clean || clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function importPublicKey(publicKeyHex) {
  const cached = keyCache.get(publicKeyHex);
  if (cached) return cached;
  const raw = hexToBytes(publicKeyHex);
  if (!raw || raw.length !== 32) return null;
  const pending = crypto.subtle
    .importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
    .catch(() => null);
  keyCache.set(publicKeyHex, pending);
  const key = await pending;
  if (!key) keyCache.delete(publicKeyHex);
  return key;
}

/** Verify one signed body. Returns { ok, reason } and never throws. */
export async function verifySignature({
  rawBody,
  signature,
  timestamp,
  publicKey,
  now = Date.now(),
  maxAgeSeconds = MAX_SIGNATURE_AGE_SECONDS
}) {
  if (!publicKey) return { ok: false, reason: 'missing public key' };
  if (!signature || !timestamp) return { ok: false, reason: 'missing signature headers' };

  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || !/^\d+$/.test(String(timestamp).trim())) {
    return { ok: false, reason: 'bad timestamp' };
  }
  // Both directions: an old body is a replay, a far-future one is a forged clock.
  const ageSeconds = Math.abs(Math.floor(now / 1000) - sent);
  if (ageSeconds > maxAgeSeconds) return { ok: false, reason: 'stale timestamp' };

  const signatureBytes = hexToBytes(signature);
  if (!signatureBytes || signatureBytes.length !== 64) return { ok: false, reason: 'bad signature encoding' };

  const key = await importPublicKey(publicKey);
  if (!key) return { ok: false, reason: 'bad public key' };

  const signed = new TextEncoder().encode(`${timestamp}${rawBody}`);
  let verified = false;
  try {
    verified = await crypto.subtle.verify({ name: 'Ed25519' }, key, signatureBytes, signed);
  } catch {
    verified = false;
  }
  return verified ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/** Read a request's body and verify it. Returns { ok, status, reason, rawBody }. */
export async function readSignedBody(request, publicKey, options = {}) {
  const rawBody = await request.text();
  const result = await verifySignature({
    rawBody,
    signature: request.headers.get(SIGNATURE_HEADER),
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    publicKey,
    ...options
  });
  if (!result.ok) return { ok: false, status: publicKey ? 401 : 500, reason: result.reason, rawBody };
  return { ok: true, status: 200, rawBody };
}
