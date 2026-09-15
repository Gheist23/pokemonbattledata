// POST {"key":"PCT-XXXXX-..."} -> a signed token the app verifies offline.
//
// The app calls this once when the key is pasted, and then quietly every few
// days while it is running. Each call returns a token whose expiry is the paid
// period plus a grace window, so:
//
//   * a machine that never goes online again keeps working until that expiry;
//   * a cancelled or refunded subscription simply stops being re-issued, and
//     the last token dies on its own.
//
// That is the whole revocation mechanism -- no kill switch to reach the client.

import {
  getRecord, graceExpiry, json, emailHash, mintToken, normaliseKey, putRecord,
  subscriptionPeriodEnd,
} from "./_lib.js";

const ACTIVE = new Set(["active", "trialing"]);

async function refreshFromStripe(env, record) {
  // Webhooks keep KV current; this is the belt-and-braces path for a record
  // whose period has already lapsed (a missed webhook should not extend a
  // subscription, but it must not cancel a paying one either).
  if (!record.stripeSubscription || !env.STRIPE_SECRET_KEY) return record;
  try {
    const response = await fetch(
      `https://api.stripe.com/v1/subscriptions/${record.stripeSubscription}`,
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );
    if (!response.ok) return record;
    const subscription = await response.json();
    return {
      ...record,
      status: ACTIVE.has(subscription.status) ? "active" : subscription.status,
      periodEnd: subscriptionPeriodEnd(subscription) || record.periodEnd,
    };
  } catch {
    return record;
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected JSON" }, 400);
  }

  const key = normaliseKey(body.key);
  if (!key) return json({ error: "That does not look like a licence key." }, 400);

  let record = await getRecord(env, key);
  if (!record) return json({ error: "Unknown licence key." }, 404);

  const now = Math.floor(Date.now() / 1000);
  // Missing as well as lapsed. A record written before the Stripe period-field
  // move carries periodEnd 0, and asking Stripe once repairs it in place
  // instead of leaving that licence on a rolling grace window for ever.
  if (!Number(record.periodEnd) || Number(record.periodEnd) < now) {
    const refreshed = await refreshFromStripe(env, record);
    if (refreshed.periodEnd !== record.periodEnd || refreshed.status !== record.status) {
      // Also backfills the customer index that refunds look up.
      await putRecord(env, refreshed);
    }
    record = refreshed;
  }
  if (!ACTIVE.has(record.status)) {
    return json({ error: `This licence is ${record.status}.`, status: record.status }, 403);
  }

  const expires = graceExpiry(record.periodEnd);
  const token = await mintToken(env, {
    v: 1,
    sub: await emailHash(record.email),
    key: record.key,
    plan: record.plan,
    edition: "pro",
    iat: now,
    exp: expires,
  });
  return json({ token, expires, plan: record.plan, status: record.status });
}
