// GET /api/license/session?session_id=cs_...
//
// What the thank-you page calls to show the buyer their key straight away,
// instead of making them go and find the email.
//
// The Checkout session id is the authorisation here: Stripe only ever puts it
// in the buyer's own redirect URL, and it is not guessable. It is the same
// pattern Stripe documents for showing order details on a success page. The
// reply carries the key and the plan and nothing else -- no email, no customer
// id -- so a leaked URL cannot be turned into anything but the key its owner
// already has.
//
// The webhook and the redirect race each other, and the redirect usually wins
// by a second or two. "not ready yet" is therefore a normal answer, not an
// error, and the page polls until it arrives.

import { getRecord, json, normaliseKey } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const sessionId = String(url.searchParams.get("session_id") || "").trim();

  // Stripe ids are opaque but well-shaped; refusing anything else keeps junk
  // out of KV lookups.
  if (!/^cs_[A-Za-z0-9_]{10,120}$/.test(sessionId)) {
    return json({ error: "Missing or malformed session id." }, 400);
  }

  const key = normaliseKey(await env.LICENSES.get(`session:${sessionId}`));
  if (!key) {
    // Either the webhook has not landed yet, or this session was never paid
    // for. The page cannot tell the difference and does not need to: it polls
    // for a while and then points at the email.
    return json({ ready: false }, 202);
  }

  const record = await getRecord(env, key);
  if (!record) return json({ ready: false }, 202);

  return json({
    ready: true,
    key: record.key,
    plan: record.plan || "",
    status: record.status || "active",
  });
}
