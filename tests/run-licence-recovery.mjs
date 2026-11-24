// GETTING BACK IN AFTER A CARD FAILS.
//
//   node tests/run-licence-recovery.mjs
//   node tests/run-licence-recovery.mjs --verbose
//
// WHY THIS EXISTS, IN NUMBERS.  Measured on the live Stripe account 24 Nov 2026:
// EUR 205 of invoices billed and never collected against EUR 270 ever collected
// -- 43% of the book -- and `cancellation_details.reason` reads `payment_failed`
// on 7 of the 20 subscriptions that are no longer live.  In the one cohort that
// came off a creator video it was the ONLY cause: 16 signups, 11 still paying,
// 4 killed by a declined card, 1 still dunning, zero cancellations and zero trial
// drop-outs.  Nobody in that cohort chose to leave.
//
// And nobody could come back.  The webhook wrote `past_due` onto the licence,
// activate.js refused with `This licence is past_due.` and no route, and the word
// `billing_portal` appeared nowhere in the repository.  What this suite holds to:
//
//   1. THE REFUSAL OFFERS A WAY OUT.  A recoverable status (past_due, unpaid,
//      incomplete) must come back marked recoverable, with somewhere to go.  A
//      cancelled or refunded one must NOT -- that is a closed account, and
//      inviting it to pay again is a different thing.
//
//   2. THE CUSTOMER IS TOLD WITHOUT ASKING.  `invoice.payment_failed` is handled,
//      and it mails the address on the record.  This is the half that recovers
//      money, because the customer who does not KNOW is the one who is lost.
//
//   3. IT CANNOT BECOME A MAIL CANNON.  Stripe fires that event on every one of
//      nine retries.  Two mails per invoice at most, and the throttle on the
//      public endpoint is per address.
//
//   4. IT CANNOT BECOME AN ORACLE.  The public endpoint answers identically
//      whether or not an address has a subscription, like resend.js, and the
//      portal URL is never returned to the caller -- only mailed.
//
//   5. THE TOKEN IS A TOKEN.  32 hex characters, checked for length, exchanged
//      for a FRESH Stripe session at click time (a session minted into an email
//      is expired by the time anybody reads it) and NOT burned on first use,
//      because mail clients prefetch links.
//
// Source text, no browser and no network: this is a set of pairings between files
// and a Stripe dashboard setting, which is the only thing that can drift.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const verbose = process.argv.includes("--verbose");

let checked = 0;
const failures = [];
const ok = (label, passed, detail = "") => {
  checked += 1;
  if (!passed) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  else if (verbose) console.log(`  ok   ${label}`);
};
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const portal = read("functions", "api", "license", "portal.js");
const activate = read("functions", "api", "license", "activate.js");
const webhook = read("functions", "api", "stripe", "webhook.js");
const keyPage = read("pro-tool", "key", "index.html");
const resend = read("functions", "api", "license", "resend.js");

/* ---------------------------------------------- 1. the refusal offers a way out */

ok("activate still refuses a non-active licence", /ACTIVE\.has\(record\.status\)/.test(activate));
ok("...but says a payment failure is recoverable", /recoverable/.test(activate));
for (const status of ["past_due", "unpaid", "incomplete"]) {
  ok(`${status} counts as recoverable`, new RegExp(`"${status}"`).test(activate));
}
// The statuses that must NOT be invited to pay again: a cancelled subscription is
// a closed account and a refund was a decision, not an accident.
for (const status of ["cancelled", "refunded"]) {
  ok(`${status} is not treated as recoverable`,
    !new RegExp(`recoverable[\\s\\S]{0,200}"${status}"`).test(activate));
}
ok("the refusal carries a page a human can open", /pro-tool\/key\//.test(activate));
ok("...and the endpoint that mails a link", /api\/license\/portal/.test(activate));

/* ------------------------------------- 2. the customer is told without asking */

ok("the webhook handles invoice.payment_failed", /case "invoice\.payment_failed"/.test(webhook));
ok("...and mails the recovery link from it",
  /invoice\.payment_failed[\s\S]{0,1400}sendRecoveryEmail/.test(webhook));
ok("...passing the reason, so the mail can say what happened",
  /reason: "payment_failed"/.test(webhook));
ok("the handler imports the mailer rather than duplicating it",
  /import \{ sendRecoveryEmail \} from "\.\.\/license\/portal\.js"/.test(webhook));
// The dashboard half cannot be tested from here, so it is written down where
// somebody reconnecting the webhook will read it.
ok("the file says the event must be ticked in the Stripe dashboard",
  /invoice\.payment_failed[\s\S]{0,400}(dashboard|DASHBOARD)/.test(webhook));
ok("the subscription is resolved through the sub: index",
  /recordForSubscription/.test(webhook) && /sub:\$\{subscriptionId\}/.test(webhook));
// Stripe moved the subscription id on invoices; reading only the old spelling
// would make every one of these a no-op and nothing would say so.
ok("both spellings of the invoice's subscription are read",
  /object\.subscription[\s\S]{0,120}parent\?\.subscription_details/.test(webhook));

/* ------------------------------------------- 3. it cannot become a mail cannon */

ok("the mail is deduped per invoice", /failmail:\$\{object\.id\}/.test(webhook));
ok("...with at most two stages, not one per retry",
  /attempt_count/.test(webhook) && /attempt >= 5 \? "late" : "first"/.test(webhook));
ok("...and the dedupe key expires rather than growing for ever",
  /failmail[\s\S]{0,200}expirationTtl/.test(webhook));
ok("the public endpoint throttles per address", /portalsend:\$\{email\}/.test(portal));
ok("...with a cooldown", /COOLDOWN_SECONDS/.test(portal));

/* ----------------------------------------------- 4. it cannot become an oracle */

ok("the endpoint has one answer for every address", /SAME_ANSWER/.test(portal));
// Both exits -- the throttled one and the real one -- must give that same answer,
// or the difference between them IS the oracle.
const sameAnswerReturns = (portal.match(/return json\(SAME_ANSWER\)/g) || []).length;
ok("...on every exit from the POST", sameAnswerReturns >= 2, `${sameAnswerReturns} found`);
ok("the portal URL is never returned to the caller",
  !/json\(\{[^}]*url/.test(portal) && !/return json\([^)]*portalUrl/.test(portal));
ok("it follows the same pattern resend.js set", /SAME_ANSWER/.test(resend));
ok("a record with no Stripe customer still answers the same way",
  /if \(record\) await sendRecoveryEmail/.test(portal));

/* ---------------------------------------------------- 5. the token is a token */

ok("the token is 16 random bytes", /new Uint8Array\(16\)/.test(portal));
ok("...and checked for length before use", /value\.length !== 32/.test(portal));
ok("...and filtered to hex, so it cannot name anything else",
  /replace\(\/\[\^0-9a-f\]\/g, ""\)/.test(portal));
ok("...and expires", /expirationTtl: TOKEN_DAYS \* 86400/.test(portal));
// NOT single-use, deliberately: a mail client that prefetches links would burn
// the token before the person it was for ever clicked it.
ok("the token is not deleted on use", !/LICENSES\.delete\(`portal:/.test(portal));
ok("the file says why it is not single-use", /prefetch/i.test(portal));
ok("the Stripe session is created at click time, not baked into the mail",
  /billing_portal\/sessions/.test(portal)
  && /onRequestGet[\s\S]{0,1200}portalUrl\(env, record\)/.test(portal));
ok("the mail carries the token, not a Stripe URL",
  /api\/license\/portal\?t=\$\{value\}/.test(portal));

/* ------------------------------------------------------ 6. a human can find it */

ok("the key page has a billing form", /id="billingForm"/.test(keyPage));
ok("...pointed at the portal endpoint", /\/api\/license\/portal/.test(keyPage));
ok("...and says the non-card methods, which are the ones that do not fail here",
  /PayPal/.test(keyPage) && /Klarna/.test(keyPage));
ok("...and reassures them nothing is lost", /[Nn]othing is lost/.test(keyPage));
ok("the page's own description mentions the payment case", /payment/i.test(
  (/<meta name="description" content="([^"]*)"/.exec(keyPage) || [])[1] || ""));
ok("the Pro gate links to it in words that cover both problems",
  /Lost your key or payment failed\?/.test(read("builder", "builder-page.js")));

/* ---------------------------------------------- 7. it degrades instead of 500ing */

// A customer whose tool has stopped working must never reach a dead end, so a
// Stripe that will not mint a session falls through to the hosted login page
// (the same link builder/pro.js shows in the Pro dialog) rather than erroring.
ok("a Stripe failure falls back to the hosted portal instead of failing",
  /portalUrl\(env, record\) \|\| HOSTED_PORTAL/.test(portal));
ok("...and that fallback is the same link the Team Builder already uses",
  /billing\.stripe\.com\/p\/login\//.test(portal)
  && portal.includes((/const STRIPE_PORTAL = "([^"]+)"/.exec(read("builder", "pro.js")) || [])[1] || "\u0000"));
ok("an expired token says so and says what to do", /has expired/.test(portal) && /410/.test(portal));
ok("no mailer configured is not an error", /no mailer or no address/.test(portal));
ok("the portal call cannot throw out of the handler",
  /portalUrl[\s\S]{0,900}catch \{\s*return "";/.test(portal));

if (failures.length) {
  console.error(`run-licence-recovery: ${failures.length} of ${checked} checks failed`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`run-licence-recovery: ${checked} checks passed`);
