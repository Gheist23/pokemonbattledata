// Stripe -> licence key. Point a Stripe webhook endpoint at
// https://championsbattledata.com/api/stripe/webhook and subscribe to:
//
//   checkout.session.completed      a new purchase: mint a key and email it
//   invoice.paid                    a renewal: push the expiry out
//   invoice.payment_failed          a declined card: mail the customer a way to fix it
//   customer.subscription.deleted   cancelled: stop refreshing
//   customer.subscription.updated   catches past_due / unpaid / resumed
//   charge.refunded                 refunded: revoke immediately
//
// `invoice.payment_failed` MUST BE TICKED IN THE STRIPE DASHBOARD -- it was not,
// and nothing failed to say so, which is how EUR 205 of invoices went uncollected
// with nobody told. tests/run-licence-recovery.mjs holds the handler to existing;
// only the dashboard can decide whether the event is ever sent.
//
// The signature is checked with Web Crypto rather than the stripe-node SDK:
// the SDK pulls a large dependency into the Worker for what is one HMAC.

import {
  emailHash, getRecord, graceExpiry, json, mintToken,
  newLicenceKey, normaliseEmail, putRecord, subscriptionPeriodEnd,
} from "../license/_lib.js";
import { sendRecoveryEmail } from "../license/portal.js";

const SIGNATURE_TOLERANCE_SECONDS = 300;

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyStripeSignature(rawBody, header, secret) {
  const parts = Object.fromEntries(
    String(header || "").split(",").map((p) => p.split("=").map((s) => s.trim()))
  );
  const timestamp = Number(parts.t);
  if (!timestamp || !parts.v1) return false;
  // Reject replays of an old, legitimately signed body.
  if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, parts.v1);
}

async function stripeGet(env, path) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!response.ok) throw new Error(`stripe ${path} -> ${response.status}`);
  return response.json();
}

async function sendKeyEmail(env, record) {
  if (!env.RESEND_API_KEY) return { skipped: "no RESEND_API_KEY" };
  const download = env.DOWNLOAD_URL || "https://championsbattledata.com/pro-tool/download/";
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;line-height:1.55">
      <h2 style="margin:0 0 .6rem">Your Companion Pro licence</h2>
      <p style="margin:0 0 1rem">Thanks for subscribing. Here is everything you need.</p>
      <p style="margin:0 0 .3rem;font-weight:600">Licence key</p>
      <p style="font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:1.25rem;
                letter-spacing:.06em;background:#0f1827;color:#e7f6ff;padding:.9rem 1rem;
                border-radius:10px;margin:0 0 1.2rem">${record.key}</p>
      <p style="margin:0 0 1.2rem">
        <a href="${download}" style="background:#58dcc4;color:#071018;font-weight:700;
           padding:.7rem 1.1rem;border-radius:999px;text-decoration:none">Download the Companion</a>
      </p>
      <p style="margin:0 0 1rem">Unzip it anywhere and run <strong>PokemonChampionsTool.exe</strong>.
         Click <strong>Upgrade</strong> in the sidebar, then <strong>I have a key</strong>, and paste
         the key in. The app restarts once and Pro is on. It only needs the internet for that one
         check; after that it runs offline and re-checks quietly in the background.</p>
      <p style="margin:0;color:#667">Lost the key? Request it again at
         <a href="https://championsbattledata.com/pro-tool/key/">championsbattledata.com/pro-tool/key</a>
         using this email address.</p>
    </div>`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.LICENSE_FROM_EMAIL || "Champions Battle Data <keys@championsbattledata.com>",
      to: [record.email],
      subject: "Your Companion Pro licence key",
      html,
    }),
  });
  return { ok: response.ok, status: response.status };
}

async function onCheckoutCompleted(env, session) {
  const email = normaliseEmail(
    session.customer_details?.email || session.customer_email || ""
  );
  if (!email) return { ignored: "no email on session" };

  // A retried webhook must not mint a second key for the same purchase.
  const existingKey = await env.LICENSES.get(`session:${session.id}`);
  if (existingKey) return { deduped: existingKey };

  let periodEnd = 0;
  let plan = "unknown";
  if (session.subscription) {
    const subscription = await stripeGet(env, `subscriptions/${session.subscription}`);
    periodEnd = subscriptionPeriodEnd(subscription);
    plan = subscription.items?.data?.[0]?.price?.recurring?.interval === "year" ? "yearly" : "monthly";
  }

  const record = {
    key: newLicenceKey(),
    email,
    plan,
    status: "active",
    stripeCustomer: session.customer || "",
    stripeSubscription: session.subscription || "",
    periodEnd,
    createdAt: Math.floor(Date.now() / 1000),
    // WHERE THE SALE CAME FROM, which no record written before 19 Nov 2026 says.
    //
    // Thirty-four sales in two months and not one of them could be traced to a page, because a
    // Stripe Payment Link carries nothing from the click that opened it. It does carry
    // `client_reference_id`, which pro-tool/plans/index.html now sets to the plan plus a short
    // source label -- "monthly-gate-evaluation", "yearly-pokemon", "monthly-direct".
    //
    // It is a LABEL and never the visitor id the funnel counter uses: counting anonymous steps
    // is one thing, and joining a browsing id to an email address in a stored record is another.
    // Cleaned here rather than trusted, because this field arrives from the open internet -- a
    // crafted link can put anything in it, and it is stored and later displayed.
    source: String(session.client_reference_id || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64),
  };
  await putRecord(env, record);
  await env.LICENSES.put(`session:${session.id}`, record.key);
  if (record.stripeSubscription) {
    await env.LICENSES.put(`sub:${record.stripeSubscription}`, record.key);
  }
  const mail = await sendKeyEmail(env, record);
  return { issued: record.key, mail };
}

/** The licence behind a subscription id, or null. Same `sub:` index
 *  updateBySubscription uses, pulled out because the payment-failure branch needs
 *  the record itself (an address to write to) rather than just somewhere to write. */
async function recordForSubscription(env, subscriptionId) {
  if (!subscriptionId) return null;
  const key = await env.LICENSES.get(`sub:${subscriptionId}`);
  return key ? getRecord(env, key) : null;
}

async function updateBySubscription(env, subscriptionId, changes) {
  const key = await env.LICENSES.get(`sub:${subscriptionId}`);
  if (!key) return { ignored: "unknown subscription" };
  const record = await getRecord(env, key);
  if (!record) return { ignored: "unknown key" };
  await putRecord(env, { ...record, ...changes });
  return { updated: key, ...changes };
}

export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();
  const valid = await verifyStripeSignature(
    rawBody, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET
  );
  if (!valid) return json({ error: "bad signature" }, 400);

  const event = JSON.parse(rawBody);
  const object = event.data?.object || {};
  try {
    switch (event.type) {
      case "checkout.session.completed":
        return json(await onCheckoutCompleted(env, object));
      case "invoice.paid": {
        const changes = { status: "active" };
        const invoiceEnd = Number(object.lines?.data?.[0]?.period?.end) || 0;
        if (invoiceEnd) changes.periodEnd = invoiceEnd;
        return json(await updateBySubscription(env, object.subscription, changes));
      }
      case "customer.subscription.updated": {
        const changes = {
          status: ["active", "trialing"].includes(object.status) ? "active" : object.status,
        };
        // Only carry a period end we actually resolved. Writing 0 here would
        // erase a good expiry and cut a paying subscriber back to the grace
        // window on their next refresh.
        const updatedEnd = subscriptionPeriodEnd(object);
        if (updatedEnd) changes.periodEnd = updatedEnd;
        return json(await updateBySubscription(env, object.id, changes));
      }
      // THE EVENT THAT WAS NOT LISTENED FOR, AND IT IS THE EXPENSIVE ONE.
      //
      // Measured on the live account 24 Nov 2026: EUR 205 invoiced and never collected against
      // EUR 270 ever collected, and `payment_failed` is why 7 of 20 dead subscriptions died. In
      // the cohort that came off the October creator video it was the ONLY cause -- 16 signups,
      // 11 still paying, 4 killed by a declined card, not one cancellation and not one trial
      // drop-out. Stripe retried nine times and gave up; nothing ever told the customer, and
      // there was nowhere for them to go if it had.
      //
      // So the moment a charge fails, the person it failed for hears about it and gets a link
      // straight into Stripe's billing portal (functions/api/license/portal.js).
      case "invoice.payment_failed": {
        const subscription = object.subscription
          || object.parent?.subscription_details?.subscription || "";
        const record = await recordForSubscription(env, subscription);
        if (!record) return json({ ignored: "unknown subscription" });
        // Stripe fires this on EVERY retry -- nine of them, over three to four weeks -- and nine
        // identical mails is a spam complaint, not a recovery. One when it first fails, one more
        // late in the dunning run in case the first was missed or filed as junk, and no others.
        const attempt = Number(object.attempt_count) || 1;
        const stage = attempt >= 5 ? "late" : "first";
        const mailKey = `failmail:${object.id}:${stage}`;
        if (await env.LICENSES.get(mailKey)) return json({ deduped: mailKey });
        await env.LICENSES.put(mailKey, "1", { expirationTtl: 60 * 86400 });
        const mail = await sendRecoveryEmail(env, record, { reason: "payment_failed" });
        return json({ notified: stage, attempt, mail });
      }
      case "customer.subscription.deleted":
        return json(await updateBySubscription(env, object.id, { status: "cancelled" }));
      case "charge.refunded": {
        const key = object.customer && await env.LICENSES.get(`customer:${object.customer}`);
        if (!key) return json({ ignored: "no licence for customer" });
        const record = await getRecord(env, key);
        if (record) await putRecord(env, { ...record, status: "refunded" });
        return json({ revoked: key });
      }
      default:
        return json({ ignored: event.type });
    }
  } catch (error) {
    // 500 makes Stripe retry, which is what we want for a transient failure.
    return json({ error: String(error && error.message || error) }, 500);
  }
}
