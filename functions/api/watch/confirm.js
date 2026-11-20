// GET /api/watch/confirm?e=<emailhash>&t=<token>
//
// Step two of two: the only thing in this codebase that can move a record from
// `watch/pending/` to `watch/live/`, and therefore the only thing that can make
// an address mailable.  Opened from the person's own inbox, which is the whole
// point -- see _lib.js.
//
// The token is checked against the pending record rather than trusted, so
// knowing (or guessing) the hash of somebody's address is not enough to sign
// them up: the random half only ever existed in the mail sent to that address.
// A link older than CONFIRM_TTL_MS is refused and the stale record dropped, so
// an abandoned request leaves nothing behind.
//
// This answers HTML and not JSON because a person is looking at it.

import {
  CONFIRM_TTL_MS, cleanHash, cleanToken, liveKey, page, pendingKey, readRecord, store,
  writeRecord,
} from "./_lib.js";

const SORRY = `<p>That confirmation link is not valid any more.</p>
<p>It may already have been used, or it may be more than a week old. Opening the
Team Builder and asking again takes a moment.</p>`;

export async function onRequestGet({ request, env }) {
  const bucket = store(env);
  if (!bucket) return page("Not available", "<p>The watch list is not configured on this server.</p>", 503);

  const url = new URL(request.url);
  const hash = cleanHash(url.searchParams.get("e"));
  const token = cleanToken(url.searchParams.get("t"));
  if (!hash || !token) return page("Link not valid", SORRY, 400);

  const pending = await readRecord(bucket, pendingKey(hash));

  // Already confirmed, and the link opened twice -- a mail client prefetching,
  // or somebody clicking again a week later. Say the reassuring true thing
  // rather than the technically accurate confusing one.
  if (!pending) {
    const live = await readRecord(bucket, liveKey(hash));
    if (live && live.token === token) return page("Already set up", done(live));
    return page("Link not valid", SORRY, 400);
  }

  if (pending.token !== token) return page("Link not valid", SORRY, 400);
  if (Date.now() - Number(pending.createdAt || 0) > CONFIRM_TTL_MS) {
    try { await bucket.delete(pendingKey(hash)); } catch { /* it expires either way */ }
    return page("Link expired", SORRY, 400);
  }

  const record = {
    token: pending.token,
    email: pending.email,
    format: pending.format,
    teams: pending.teams || [],
    confirmedAt: Date.now(),
    lastSentAt: 0,
  };
  await writeRecord(bucket, liveKey(hash), record);
  // Only now, so a failed write above cannot lose the pending record and leave
  // the person with neither a watch nor a way back.
  try { await bucket.delete(pendingKey(hash)); } catch { /* harmless: live wins */ }

  return page("You are on the list", done(record));
}

function done(record) {
  const count = (record.teams || []).length;
  const teams = count
    ? `We are watching <strong>${count}</strong> team${count === 1 ? "" : "s"} in ${record.format}.`
    : `We are watching the ${record.format} meta for you.`;
  return `<p>${teams}</p>
<p>You will hear from us at most once a week, and only when something actually moved —
a Pokémon climbing or falling in usage that one of your teams has to deal with.</p>
<p style="color:#4a5568;font-size:.92rem">Every mail has an unsubscribe link that deletes the
record outright. Nothing is kept but your address and the species names in those teams.</p>`;
}
