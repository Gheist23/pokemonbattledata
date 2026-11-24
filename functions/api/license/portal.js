// THE WAY BACK IN AFTER A CARD FAILS.
//
//   POST {"email":"..."}   -> mails a link to Stripe's billing portal, same answer either way
//   GET  ?t=<token>        -> 302 straight into that portal, session minted at click time
//
// WHY THIS EXISTS. Measured 24 Nov 2026 on the live account: EUR 205 of invoices
// billed and never collected against EUR 270 ever collected -- 43% of the book --
// and `cancellation_details.reason` says `payment_failed` on 7 of the 20 dead
// subscriptions. In the one cohort that came off a creator video it was the ONLY
// cause of churn: 16 signups, 11 still paying, 4 killed by a declined card, zero
// cancellations and zero trial drop-outs. Nobody in that cohort chose to leave.
//
// AND NOBODY COULD GET BACK. Stripe retried nine times and gave up; the webhook
// wrote `past_due` onto the licence record; activate.js answered the Companion
// with 403 `This licence is past_due.` -- a status word and no route -- and there
// was no `billing_portal` anywhere in this repo to send anybody to. A paying
// customer whose card expired was locked out of a tool they still wanted.
//
// The cards themselves say what the real problem is, and it is not Stripe being
// strict: 51 of 68 failed attempts were declined by the issuer or the wallet, 27
// of them `insufficient_funds` and 17 `partner_insufficient_funds`, and 27 of the
// failures came from PREPAID cards, which have never once paid successfully on
// this account. Those customers need to switch to PayPal, Klarna or Amazon Pay --
// which have never failed here -- and this endpoint is how they are let do it.
//
// WHY A MAILED LINK AND NOT AN ANSWER ON THE PAGE. Returning the portal URL to
// whoever asks would turn this into a "does this address subscribe?" oracle, the
// same reason resend.js answers identically for every address. Mailing it also
// happens to be the fix: the customer who does not KNOW their payment failed is
// the one losing the subscription, and the webhook sends this unprompted.
//
// WHY THE SESSION IS MINTED ON CLICK. A Stripe portal session is short-lived, so
// a URL baked into an email is dead by the time anybody reads it. The token in the
// mail is ours, lasts TOKEN_DAYS, and is exchanged for a fresh session at the
// moment it is followed. It is deliberately NOT single-use: mail clients prefetch
// links, and a token burned by a prefetch would lock out the person it was for.
//
// THE PORTAL ITSELF IS ALREADY SET UP -- checked against the live account on
// 24 Nov 2026: one configuration, `active`, `is_default`, with
// `payment_method_update` enabled, which is the feature that matters here. So
// this needs nothing done in the dashboard. What DOES need doing is the webhook
// event: the endpoint was subscribed to five events and `invoice.payment_failed`
// was not one of them, so the handler in functions/api/stripe/webhook.js cannot
// fire until it is ticked. That is the whole reason EUR 205 went uncollected in
// silence, and it is one checkbox.
//
// THERE IS ALSO A HOSTED PORTAL LOGIN LINK, in builder/pro.js as STRIPE_PORTAL,
// shown in the Team Builder's Pro dialog. It works, but only for somebody whose
// licence is ALREADY active in the app -- which a locked-out customer's is not --
// and it asks them to type their address and wait for a Stripe magic link. The
// session minted below skips that, because the mail already knows who they are.
// It is kept as the fallback for when Stripe will not mint a session, so this
// never dead-ends.

import { getRecord, getRecordByEmail, json, normaliseEmail } from "./_lib.js";

const SAME_ANSWER = {
  ok: true,
  message: "If that address has a subscription, a link to update the payment method is on its way.",
};
const COOLDOWN_SECONDS = 300;
const TOKEN_DAYS = 14;
const SITE = "https://championsbattledata.com";
const HELP = "https://discord.gg/k93eVQzj8c";
// The hosted portal login page, same link as STRIPE_PORTAL in builder/pro.js.
// Used only when Stripe will not mint a session for this customer: it asks for
// an email and sends its own magic link, which is slower but never dead-ends.
const HOSTED_PORTAL = "https://billing.stripe.com/p/login/3cIaEX7TQfju0rIei157W00";

function token() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A page rather than a JSON error: whoever follows this link is a paying
 *  customer whose tool stopped working, and they are owed a sentence. */
function page(title, body, status = 200) {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${title} - Champions Battle Data</title>
<link rel="stylesheet" href="/styles.css" /></head>
<body class="page-tool"><main><section class="section-shell tool-section">
<div class="panel-heading"><div><p class="eyebrow eyebrow-pro">Pro</p><h1>${title}</h1></div></div>
<div class="licence-card"><p>${body}</p>
<p class="licence-plan">Still stuck? Ask in the <a href="${HELP}">Discord</a> and it will be sorted by hand.</p>
</div></section></main></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** A fresh portal session for this customer, or "" if Stripe will not make one. */
async function portalUrl(env, record) {
  if (!record.stripeCustomer || !env.STRIPE_SECRET_KEY) return "";
  try {
    const response = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        customer: record.stripeCustomer,
        return_url: `${SITE}/pro-tool/key/`,
      }),
    });
    if (!response.ok) return "";
    const session = await response.json();
    return String(session.url || "");
  } catch {
    return "";
  }
}

/** Mint a token for this record and mail the link. Exported so the Stripe webhook
 *  can send the same mail unprompted the moment a payment fails -- which is the
 *  case that actually loses subscriptions, because the customer does not know. */
export async function sendRecoveryEmail(env, record, { reason = "" } = {}) {
  if (!env.RESEND_API_KEY || !record?.email) return { skipped: "no mailer or no address" };
  const value = token();
  await env.LICENSES.put(`portal:${value}`, record.key, {
    expirationTtl: TOKEN_DAYS * 86400,
  });
  const link = `${SITE}/api/license/portal?t=${value}`;
  const lead = reason === "payment_failed"
    ? "Your card was declined, so your Companion Pro subscription is on hold rather than cancelled."
    : "Here is the link to update the payment method on your Companion Pro subscription.";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.LICENSE_FROM_EMAIL || "Champions Battle Data <keys@championsbattledata.com>",
      to: [record.email],
      subject: reason === "payment_failed"
        ? "Your Companion Pro payment did not go through"
        : "Update your Companion Pro payment method",
      html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;line-height:1.55">
        <p>${lead}</p>
        <p><a href="${link}" style="display:inline-block;background:#0f1827;color:#e7f6ff;
           padding:.8rem 1.15rem;border-radius:10px;text-decoration:none">Update the payment method</a></p>
        <p style="color:#55606e;font-size:.93rem">Nothing is lost in the meantime -- your teams, your Box and
        your licence key all stay exactly as they are, and Pro starts working again as soon as a payment
        goes through. A prepaid card that has run out is the most common reason this happens; PayPal,
        Klarna and Amazon Pay are all on the same page if that is easier.</p>
        <p style="color:#55606e;font-size:.93rem">The link works for ${TOKEN_DAYS} days. If it has expired,
        ask for a new one at <a href="${SITE}/pro-tool/key/">${SITE.replace("https://", "")}/pro-tool/key/</a>.</p>
      </div>`,
    }),
  });
  return { sent: response.ok, status: response.status };
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected JSON" }, 400);
  }
  const email = normaliseEmail(body.email);
  if (!email || !email.includes("@")) return json({ error: "Enter an email address." }, 400);

  // One send per address per cooldown, so this cannot be used to mail-bomb.
  const throttleKey = `portalsend:${email}`;
  if (await env.LICENSES.get(throttleKey)) return json(SAME_ANSWER);
  await env.LICENSES.put(throttleKey, "1", { expirationTtl: COOLDOWN_SECONDS });

  const record = await getRecordByEmail(env, email);
  // Same answer whether or not there is a record, whether or not it has a Stripe
  // customer, and whether or not the mail went out.
  if (record) await sendRecoveryEmail(env, record);
  return json(SAME_ANSWER);
}

export async function onRequestGet({ request, env }) {
  const value = String(new URL(request.url).searchParams.get("t") || "")
    .toLowerCase().replace(/[^0-9a-f]/g, "");
  if (value.length !== 32) {
    return page("That link is not right",
      `Ask for a fresh one on the <a href="${SITE}/pro-tool/key/">licence page</a>.`, 400);
  }
  const key = await env.LICENSES.get(`portal:${value}`);
  if (!key) {
    return page("That link has expired",
      `Links last ${TOKEN_DAYS} days. Ask for a fresh one on the `
      + `<a href="${SITE}/pro-tool/key/">licence page</a> and it will be mailed straight back.`, 410);
  }
  const record = await getRecord(env, key);
  if (!record) {
    return page("That subscription could not be found",
      "Nothing is lost -- this needs a human. Ask in the Discord with your Stripe receipt to hand.", 404);
  }
  // Either Stripe would not mint a session, or this record predates the customer
  // id being stored. Fall back to the hosted login page rather than dead-ending
  // somebody whose tool has stopped working: it costs them one extra step.
  const url = await portalUrl(env, record) || HOSTED_PORTAL;
  return new Response(null, { status: 302, headers: { Location: url, "cache-control": "no-store" } });
}
