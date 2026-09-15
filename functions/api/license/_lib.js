// Shared licence helpers for the Pages Functions.
//
// Two different strings are involved and they do different jobs:
//
//   licence key   PCT-XXXXX-XXXXX-XXXXX-XXXXX
//                 Short, random, human-typeable. Means nothing by itself: it is
//                 a lookup into KV. This is what the buyer receives.
//
//   token         <base64url payload>.<base64url Ed25519 signature>
//                 Issued when a key is activated or refreshed. The app verifies
//                 it OFFLINE against a public key baked into the build, so the
//                 app starts with no network. It carries an expiry a grace
//                 period past the paid period, so a cancelled subscription
//                 stops working without the app ever needing to be online at
//                 the moment of cancellation.
//
// Only the private key can mint tokens, and it never leaves Cloudflare.

const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
const KEY_GROUPS = 4;
const KEY_GROUP_LEN = 5;

export const GRACE_DAYS = 7;

export function newLicenceKey() {
  const bytes = new Uint8Array(KEY_GROUPS * KEY_GROUP_LEN);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => KEY_ALPHABET[b % KEY_ALPHABET.length]);
  const groups = [];
  for (let i = 0; i < KEY_GROUPS; i += 1) {
    groups.push(chars.slice(i * KEY_GROUP_LEN, (i + 1) * KEY_GROUP_LEN).join(""));
  }
  return `PCT-${groups.join("-")}`;
}

export function normaliseKey(raw) {
  const cleaned = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = cleaned.startsWith("PCT") ? cleaned.slice(3) : cleaned;
  if (body.length !== KEY_GROUPS * KEY_GROUP_LEN) return "";
  const groups = body.match(/.{1,5}/g) || [];
  return `PCT-${groups.join("-")}`;
}

export function normaliseEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}

function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pkcs8Base64) {
  const raw = Uint8Array.from(atob(pkcs8Base64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", raw, { name: "Ed25519" }, false, ["sign"]);
}

/** Sign a payload into the offline token the app verifies. */
export async function mintToken(env, payload) {
  const key = await importPrivateKey(env.LICENSE_PRIVATE_KEY);
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, body));
  return `${b64url(body)}.${b64url(signature)}`;
}

/** Hash an email so the token can be tied to a buyer without carrying it. */
export async function emailHash(email) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normaliseEmail(email)));
  return b64url(new Uint8Array(digest)).slice(0, 22);
}

/** When the paid period ends, whichever Stripe API version answered.
 *
 * Stripe moved `current_period_end` off the Subscription object and onto each
 * subscription item in API version 2025-03-31.basil. An account defaulting to
 * that version or later returns `undefined` at the top level, which silently
 * became a period end of 0 -- so read the item first and keep the old location
 * as the fallback.
 */
export function subscriptionPeriodEnd(subscription) {
  const items = subscription?.items?.data || [];
  const fromItems = items
    .map((item) => Number(item?.current_period_end) || 0)
    .filter(Boolean);
  if (fromItems.length) return Math.max(...fromItems);
  return Number(subscription?.current_period_end) || 0;
}

export function graceExpiry(periodEndSeconds) {
  const base = Number(periodEndSeconds) || (Date.now() / 1000);
  return Math.floor(base + GRACE_DAYS * 86400);
}

// --- KV records -----------------------------------------------------------
// licence:<KEY>   -> the record
// email:<email>   -> the key, so "resend my key" works without scanning

export async function putRecord(env, record) {
  await env.LICENSES.put(`licence:${record.key}`, JSON.stringify(record));
  if (record.email) await env.LICENSES.put(`email:${normaliseEmail(record.email)}`, record.key);
  // charge.refunded only carries a customer id, so without this index a refund
  // could never find the licence it was meant to revoke.
  if (record.stripeCustomer) {
    await env.LICENSES.put(`customer:${record.stripeCustomer}`, record.key);
  }
}

export async function getRecord(env, key) {
  const normalised = normaliseKey(key);
  if (!normalised) return null;
  const raw = await env.LICENSES.get(`licence:${normalised}`);
  return raw ? JSON.parse(raw) : null;
}

export async function getRecordByEmail(env, email) {
  const key = await env.LICENSES.get(`email:${normaliseEmail(email)}`);
  return key ? getRecord(env, key) : null;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
