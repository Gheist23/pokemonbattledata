// GET or POST /api/watch/unsubscribe?e=<emailhash>&t=<token>
//
// Deletes the record.  Not a flag, not a `status: "unsubscribed"` field that a
// later bug can read the wrong way round -- the object is removed, and with it
// the address and the team names.  A pending record for the same address goes
// too, so an unconfirmed request cannot outlive an unsubscribe.
//
// POST IS SUPPORTED FOR A REASON.  Every digest carries
// `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, which Gmail and Outlook
// honour by POSTing this URL themselves when the recipient uses the client's
// own unsubscribe button.  Without a POST handler that button appears and then
// fails, which is worse than not offering it: a recipient who cannot get off a
// list marks the sender as spam instead, and that is charged against every
// future mail from this domain.
//
// It is deliberately idempotent and never says whether the address was on the
// list -- the same reason /api/watch answers one sentence (see index.js).

import { cleanHash, cleanToken, liveKey, page, pendingKey, readRecord, store } from "./_lib.js";

const GONE = `<p>You are unsubscribed. The record has been deleted, along with the
team names that were in it.</p>
<p>No further mail will be sent. If you want it back later, the Team Builder can set it up again
in a moment.</p>`;

async function remove(request, env) {
  const bucket = store(env);
  const url = new URL(request.url);
  const hash = cleanHash(url.searchParams.get("e"));
  const token = cleanToken(url.searchParams.get("t"));
  if (!bucket || !hash || !token) return;

  // The token still has to match, so a guessed hash cannot cancel somebody
  // else's watch -- a small thing, but the hash travels in a URL and the token
  // only ever reached that address's own inbox.
  for (const key of [liveKey(hash), pendingKey(hash)]) {
    const record = await readRecord(bucket, key);
    if (record && record.token === token) {
      try { await bucket.delete(key); } catch { /* reported as done either way */ }
    }
  }
}

export async function onRequestGet({ request, env }) {
  await remove(request, env);
  return page("Unsubscribed", GONE);
}

/** One-click unsubscribe from the mail client. The body is not read: RFC 8058
 *  sends `List-Unsubscribe=One-Click` and the URL already carries both halves. */
export async function onRequestPost({ request, env }) {
  await remove(request, env);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
