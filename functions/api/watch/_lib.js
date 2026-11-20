// Shared helpers for the meta watch list -- the only way this site can speak to
// somebody who has not bought anything.
//
// WHY THIS EXISTS.  Until now the site had no email capture at all: the only
// `type="email"` fields anywhere were the licence-key lookup and Stripe's own
// checkout.  So a visitor who tried the Team Builder and left was gone for good,
// and a trial that lapsed could never be followed up.  Measured 20 Nov 2026,
// about forty real people a day open a tool here and roughly one in sixty of
// them ever buys; every one of the other fifty-nine was a single shot.
//
// WHY A WATCH LIST AND NOT A NEWSLETTER.  The churn signal says the product is
// a project tool, not a habit: of ten yearly plans ever sold six turned off
// auto-renew, and seven of thirty-five signups quit inside the trial.  The shape
// is "I needed a team, I got a team, I am done".  A newsletter does not answer
// that.  A note saying THE META MOVED UNDER THE TEAM YOU BUILT does, and the
// daily pipeline already computes it -- see tools/meta_digest.py.
//
// WHAT IS STORED, AND WHERE.  R2 (`env.SHARES`), keyed by a hash of the address
// so the bucket cannot be listed for addresses:
//
//   watch/pending/<emailhash>   {token, email, format, teams, createdAt}
//   watch/live/<emailhash>      {token, email, format, teams, confirmedAt, lastSentAt}
//
// R2 and not KV for the reason share/_lib.js and campaign/[code].js both give:
// the free KV allowance is 1,000 writes a day for the WHOLE account and the
// licence and sync endpoints already spend from it.
//
// Keying `pending` by the address rather than by the token is what makes a
// cooldown possible without a second store: a repeat subscribe overwrites the
// one object instead of minting a new one, so this cannot be used to mail-bomb
// an address, and there is never more than one pending record per person.
//
// CONFIRMED OPT-IN IS NOT OPTIONAL.  The operator is a German sole trader, so
// sending to an address that has not been confirmed from that address's own
// inbox is not something to get wrong.  POST only ever writes `pending` and
// sends one confirmation; nothing reaches `live`, and so nothing can be mailed,
// until the link in that confirmation is opened.  Every digest carries a
// one-click unsubscribe that deletes the record outright rather than flagging
// it, and the token in both links is what stops somebody who can guess an
// address's hash from confirming or cancelling it for them.

import { emailHash, json, normaliseEmail } from "../license/_lib.js";

export { emailHash, json, normaliseEmail };

/** One subscribe attempt per address per this long. */
export const COOLDOWN_MS = 10 * 60 * 1000;
/** A pending record older than this is treated as never having existed. */
export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Nobody is mailed twice inside this, so the publisher may POST every day and
 *  the list still only ever hears from us weekly. */
export const MIN_GAP_DAYS = 6;

export const MAX_TEAMS = 12;
export const MAX_MEMBERS = 6;

// THE ADDRESS THAT IS KNOWN TO WORK, not the nicest one.
//
// Resend will only send from a verified domain, and `keys@championsbattledata.com` is the
// address the licence mail has been delivering from since September -- so it is the one address
// here that is PROVEN. `meta@` on the same domain should work too, since verification is
// per-domain, but "should" is not good enough for the single call the whole feature depends on:
// get it wrong and every digest fails silently with the list none the wiser.
//
// To use `meta@` instead, set WATCH_FROM_EMAIL in the Pages project and send one digest with
// ?dryRun=0 to a single test subscriber before trusting it.
export const FROM = "Champions Battle Data <keys@championsbattledata.com>";

export function store(env) {
  return env && env.SHARES ? env.SHARES : null;
}

export function fromAddress(env) {
  return env.WATCH_FROM_EMAIL || env.LICENSE_FROM_EMAIL || FROM;
}

/** A deliberately dull check: the address is proved by the confirmation mail,
 *  not by a regex, and a clever pattern here only ever rejects a real person. */
export function validEmail(email) {
  return typeof email === "string" && email.length >= 6 && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function newToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "" for anything that is not one of our tokens, checked BEFORE any storage
 *  call so a crafted query can never reach R2 (campaign/[code].js:cleanCode). */
export function cleanToken(raw) {
  const value = String(raw || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return value.length === 32 ? value : "";
}

/** Likewise for the hash, which appears in a URL and so is attacker-supplied. */
export function cleanHash(raw) {
  const value = String(raw || "").replace(/[^A-Za-z0-9_-]/g, "");
  return value.length === 22 ? value : "";
}

export function cleanFormat(raw) {
  return String(raw || "") === "Singles" ? "Singles" : "Doubles";
}

/** The watched teams, reduced to the only thing a digest needs: a title and the
 *  species names.  Nothing about sets, spreads or items is taken, because
 *  nothing about them is used -- and what is never stored cannot leak. */
export function cleanTeams(raw) {
  if (!Array.isArray(raw)) return [];
  const teams = [];
  for (const team of raw.slice(0, MAX_TEAMS)) {
    const title = String(team?.title || "Team").slice(0, 80);
    const members = (Array.isArray(team?.members) ? team.members : [])
      .map((name) => String(name || "").slice(0, 40))
      .filter(Boolean)
      .slice(0, MAX_MEMBERS);
    if (members.length) teams.push({ title, members });
  }
  return teams;
}

export async function readRecord(bucket, key) {
  try {
    const object = await bucket.get(key);
    if (!object) return null;
    return JSON.parse(await object.text());
  } catch {
    return null;
  }
}

export async function writeRecord(bucket, key, record) {
  await bucket.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

export function pendingKey(hash) { return `watch/pending/${hash}`; }
export function liveKey(hash) { return `watch/live/${hash}`; }

export function siteOrigin(request, env) {
  if (env && env.SITE_ORIGIN) return String(env.SITE_ORIGIN).replace(/\/+$/, "");
  try { return new URL(request.url).origin; } catch { return "https://championsbattledata.com"; }
}

export function confirmLink(origin, hash, token) {
  return `${origin}/api/watch/confirm?e=${encodeURIComponent(hash)}&t=${encodeURIComponent(token)}`;
}

export function unsubscribeLink(origin, hash, token) {
  return `${origin}/api/watch/unsubscribe?e=${encodeURIComponent(hash)}&t=${encodeURIComponent(token)}`;
}

/** One Resend call. Returns true only on a 2xx, so a caller can count honestly. */
export async function sendMail(env, { to, subject, html, headers }) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: fromAddress(env), to: [to], subject, html, headers }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Resend takes up to 100 messages in one call, which is what keeps a digest
 *  run inside a single request's budget as the list grows. */
export const BATCH_SIZE = 100;

/** Returns the messages that actually went -- NOT a count.
 *
 *  The caller stamps `lastSentAt` from this, and a count cannot say WHICH chunk
 *  Resend refused. Returning the number would mean either stamping people who
 *  were never mailed (they hear nothing for a week and the list quietly rots)
 *  or stamping nobody (everyone who did get it is mailed twice). */
export async function sendBatch(env, messages) {
  if (!env.RESEND_API_KEY || !messages.length) return [];
  const sent = [];
  for (let index = 0; index < messages.length; index += BATCH_SIZE) {
    const slice = messages.slice(index, index + BATCH_SIZE);
    const chunk = slice.map((message) => ({
      from: fromAddress(env),
      to: [message.to],
      subject: message.subject,
      html: message.html,
      headers: message.headers,
    }));
    try {
      const response = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(chunk),
      });
      if (response.ok) sent.push(...slice);
    } catch {
      // A transient Resend error loses this chunk and no more: nothing in it is
      // stamped, so the next run picks exactly these people up again.
    }
  }
  return sent;
}

const SHELL = `font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:3rem auto;
padding:0 1.25rem;line-height:1.6;color:#0f1827`;

/** The two pages a person actually lands on -- confirm and unsubscribe. Plain
 *  HTML and no module graph, because they must work when nothing else does. */
export function page(title, body, status = 200) {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} &middot; Champions Battle Data</title></head>
<body style="${SHELL}">
<h1 style="font-size:1.4rem">${title}</h1>
${body}
<p style="margin-top:2rem"><a href="/team-builder/">Back to the Team Builder</a></p>
</body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
