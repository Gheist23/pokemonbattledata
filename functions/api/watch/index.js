// POST /api/watch   {email, format, teams:[{title, members:[...]}]}  -> {ok:true, message}
//
// Step one of two.  This writes a PENDING record and sends one confirmation; it
// never writes to `watch/live/`, so nothing here can cause a digest to be sent
// to an address that has not opened the link in its own inbox.  See _lib.js for
// why that is not negotiable and what the bucket holds.
//
// THE ANSWER IS ALWAYS THE SAME, exactly as license/resend.js does it: a reply
// that differed between "you are already on the list", "you are in cooldown"
// and "that address is new" would turn this endpoint into a "does this person
// use the site?" oracle for anybody willing to ask it in a loop.  The visitor
// is told to check their inbox and that is all, whichever of the three it was.
//
// NOT CONFIGURED IS NOT AN ERROR for the page: without the R2 binding this
// answers the same sentence and writes nothing, because a capture box must
// never be able to break the Team Builder it sits in.  It does NOT pretend
// when the mailer is missing, though -- see the RESEND_API_KEY branch.

import {
  COOLDOWN_MS, cleanFormat, cleanTeams, confirmLink, emailHash, json, liveKey, newToken,
  normaliseEmail, pendingKey, readRecord, sendMail, siteOrigin, store, unsubscribeLink,
  validEmail, writeRecord,
} from "./_lib.js";

const SAME_ANSWER = {
  ok: true,
  message: "Check your inbox — there is a link to confirm. Nothing is sent until you open it.",
};

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected JSON" }, 400);
  }

  const email = normaliseEmail(body?.email);
  // The one thing worth saying plainly, because the visitor can fix it and is
  // looking at the box right now.
  if (!validEmail(email)) return json({ error: "Enter an email address." }, 400);

  const bucket = store(env);
  if (!bucket) return json(SAME_ANSWER);

  const hash = await emailHash(email);
  const format = cleanFormat(body?.format);
  const teams = cleanTeams(body?.teams);
  const now = Date.now();

  // Already confirmed: refresh the watched teams, which is the useful half of a
  // repeat subscribe, and send nothing.
  const live = await readRecord(bucket, liveKey(hash));
  if (live) {
    await writeRecord(bucket, liveKey(hash), { ...live, format, teams, updatedAt: now });
    return json(SAME_ANSWER);
  }

  // One confirmation per address per cooldown. Because `pending` is keyed by the
  // address, this is a read of the single object that can exist for it.
  const pending = await readRecord(bucket, pendingKey(hash));
  if (pending && now - Number(pending.createdAt || 0) < COOLDOWN_MS) {
    // Keep the newer teams, but do not mail again.
    await writeRecord(bucket, pendingKey(hash), { ...pending, format, teams });
    return json(SAME_ANSWER);
  }

  // If there is no mailer the record would sit pending for ever and the visitor
  // would wait for a confirmation that cannot arrive. Checked BEFORE the write,
  // so the sentence below is true: nothing is stored, rather than an orphan
  // record left behind by an endpoint that then says it stored nothing.
  if (!env.RESEND_API_KEY) {
    return json({ error: "Email is not configured on this server yet. Nothing was stored." }, 503);
  }

  const token = newToken();
  await writeRecord(bucket, pendingKey(hash), { token, email, format, teams, createdAt: now });

  const origin = siteOrigin(request, env);
  const link = confirmLink(origin, hash, token);
  const teamLine = teams.length === 1
    ? `the team you are watching (<strong>${escape(teams[0].title)}</strong>)`
    : `the ${teams.length} teams you are watching`;

  await sendMail(env, {
    to: email,
    subject: "Confirm your meta watch",
    headers: { "List-Unsubscribe": `<${unsubscribeLink(origin, hash, token)}>` },
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;line-height:1.6;color:#0f1827">
  <p>You asked Champions Battle Data to tell you when the ${cleanFormat(format)} meta moves against
  ${teams.length ? teamLine : "your teams"}.</p>
  <p><a href="${link}" style="display:inline-block;background:#0f1827;color:#e7f6ff;padding:.75rem 1.15rem;
     border-radius:10px;text-decoration:none;font-weight:600">Confirm the watch</a></p>
  <p style="color:#4a5568;font-size:.92rem">One mail a week at most, only when something actually
  moved, and every one of them has an unsubscribe link. We keep your address and the species names
  in those teams, nothing else. If you did not ask for this, ignore this mail — without the link
  above nothing is ever sent, and the request is forgotten within a week.</p>
</div>`,
  });

  return json(SAME_ANSWER);
}

/** Team titles are the visitor's own text and go into an HTML mail. */
function escape(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

export function onRequestGet() {
  return json({ error: "POST {email, format, teams} here." }, 405);
}
