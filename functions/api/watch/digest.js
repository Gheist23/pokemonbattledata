// POST /api/watch/digest?key=<DIGEST_KEY>
//
//   {format, asOf, since, risers:[[name,from,to],...], fallers:[[name,from,to],...]}
//   -> {ok, format, considered, matched, due, sent, skipped}
//
// The weekly mail.  Called once a day by the publisher (tools/meta_digest.py,
// run from publish_champions_data.py) and it is SAFE TO CALL EVERY DAY: each
// record carries `lastSentAt` and anybody mailed inside MIN_GAP_DAYS is skipped,
// so a daily trigger produces a weekly list.  That is deliberately the rule
// rather than a cron expression somewhere -- the pipeline already runs daily and
// knows when the data actually changed, and Pages has no scheduler.
//
// WHY THE RANKS ARRIVE IN THE BODY INSTEAD OF BEING READ HERE.  The snapshots
// this diff comes from are `data/meta/<season>/<date>/<Format>.json`, and each
// is about 340 KB of nested arrays.  Parsing two of them would blow a free-tier
// Worker's CPU budget on its own, before a single mail was rendered.  The
// publisher has the whole tree on disk and a Python interpreter already running,
// so it does the arithmetic and posts a few hundred bytes.  This endpoint stays
// a renderer and a sender, which is also what makes it testable with a synthetic
// payload (tests/run-watch.mjs).
//
// NOTHING MOVED IS A VALID ANSWER.  If the payload carries no movement the run
// reports `skipped: "nothing moved"` and mails nobody.  The promise made at the
// capture box is "only when something actually moved", and a weekly mail saying
// nothing happened is how a list is taught to ignore you.

import {
  MIN_GAP_DAYS, cleanFormat, liveKey, json, sendBatch, siteOrigin, store, unsubscribeLink,
  writeRecord,
} from "./_lib.js";

const MAX_LIST_PAGES = 25;     // 25,000 records; beyond that the answer says so
const SHOWN = 6;               // movers named in the lead, per direction
const AROUND = 3;              // risers named per team
const MAX_MOVERS = 40;

export async function onRequestPost({ request, env }) {
  const bucket = store(env);
  if (!bucket) return json({ error: "The watch list is not configured on this server." }, 503);

  // Unlike the campaign counter, which ships open because it only exposes
  // counts, this one SENDS MAIL. With no key configured it refuses outright
  // rather than defaulting to open.
  const required = env.DIGEST_KEY ? String(env.DIGEST_KEY) : "";
  if (!required) return json({ error: "DIGEST_KEY is not set on this server." }, 503);
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== required) return json({ error: "Wrong or missing key." }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected JSON" }, 400);
  }

  const format = cleanFormat(body?.format);
  const asOf = text(body?.asOf, 20);
  const since = text(body?.since, 20);
  const risers = movers(body?.risers);
  const fallers = movers(body?.fallers);
  const dryRun = url.searchParams.get("dryRun") === "1" || !env.RESEND_API_KEY;

  if (!risers.length && !fallers.length) {
    return json({ ok: true, format, sent: 0, skipped: "nothing moved" });
  }

  const origin = siteOrigin(request, env);
  const now = Date.now();
  const gap = MIN_GAP_DAYS * 24 * 60 * 60 * 1000;
  const subject = subjectLine(format, risers, fallers);

  const messages = [];
  const records = [];
  let considered = 0;
  let matched = 0;
  let cursor;
  let truncated = false;

  for (let pageIndex = 0; pageIndex < MAX_LIST_PAGES; pageIndex += 1) {
    const listed = await bucket.list({ prefix: "watch/live/", cursor, limit: 1000 });
    for (const object of listed.objects) {
      considered += 1;
      let record;
      try {
        const stored = await bucket.get(object.key);
        if (!stored) continue;
        record = JSON.parse(await stored.text());
      } catch {
        continue; // a half-written object is not worth failing the whole run for
      }
      if (!record?.email || !record?.token) continue;
      if (cleanFormat(record.format) !== format) continue;
      matched += 1;
      if (now - Number(record.lastSentAt || 0) < gap) continue;

      const unsubscribe = unsubscribeLink(origin, object.key.split("/").pop(), record.token);
      messages.push({
        to: record.email,
        subject,
        html: render({ record, format, asOf, since, risers, fallers, origin, unsubscribe }),
        headers: {
          "List-Unsubscribe": `<${unsubscribe}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      records.push({ key: object.key, record });
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
    if (pageIndex === MAX_LIST_PAGES - 1) truncated = true;
  }

  if (dryRun) {
    return json({
      ok: true, format, asOf, since, considered, matched, due: messages.length, sent: 0,
      skipped: env.RESEND_API_KEY ? "dryRun=1" : "no RESEND_API_KEY", subject, truncated,
    });
  }

  const sent = await sendBatch(env, messages);

  // Stamped only for the messages that actually went, so a chunk Resend
  // refused is retried on the next run instead of being silently dropped.
  const delivered = new Set(sent.map((message) => message.to));
  for (const { key, record } of records) {
    if (!delivered.has(record.email)) continue;
    try {
      await writeRecord(bucket, key, { ...record, lastSentAt: now });
    } catch {
      // Worst case this person hears from us twice next week. Better that than
      // failing the run for everybody after the mail has already gone out.
    }
  }

  return json({
    ok: true, format, asOf, since, considered, matched,
    due: messages.length, sent: sent.length, subject, truncated,
  });
}

/* ------------------------------------------------------------------ payload */

function text(value, limit) {
  return String(value || "").replace(/[^\w .:/-]/g, "").slice(0, limit);
}

/** [[name, from, to], ...] -- ranks are 1-based positions in the usage table, so
 *  a SMALLER number is more used and a riser has `to` below `from`. */
function movers(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw.slice(0, MAX_MOVERS)) {
    if (!Array.isArray(row)) continue;
    const name = String(row[0] || "").slice(0, 40);
    const from = Number(row[1]);
    const to = Number(row[2]);
    if (!name || !Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (from < 1 || to < 1 || from > 9999 || to > 9999) continue;
    out.push({ name, from, to, move: from - to });
  }
  return out;
}

/** The subject carries the single biggest move in each direction. A subject that
 *  names a Pokemon is opened; "Your weekly meta update" is not. */
function subjectLine(format, risers, fallers) {
  const up = risers[0];
  const down = fallers[0];
  const parts = [];
  if (up) parts.push(`${up.name} up ${Math.abs(up.move)}`);
  if (down) parts.push(`${down.name} down ${Math.abs(down.move)}`);
  return parts.length ? `${format} meta: ${parts.join(", ")}` : `${format} meta moved`;
}

/* ------------------------------------------------------------------- render */

const WRAP = `font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;line-height:1.6;color:#0f1827`;
const MUTED = "color:#4a5568;font-size:.92rem";

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

function arrow(mover) {
  return `#${mover.from} &rarr; #${mover.to}`;
}

function moverList(list) {
  return list.slice(0, SHOWN)
    .map((mover) => `<li><strong>${esc(mover.name)}</strong> <span style="${MUTED}">${arrow(mover)}</span></li>`)
    .join("");
}

function render({ record, format, asOf, since, risers, fallers, origin, unsubscribe }) {
  const teams = Array.isArray(record.teams) ? record.teams : [];
  const byName = new Map();
  for (const mover of [...risers, ...fallers]) byName.set(mover.name.toLowerCase(), mover);

  const teamBlocks = teams.map((team) => {
    const members = Array.isArray(team.members) ? team.members : [];
    const held = new Set(members.map((name) => String(name).toLowerCase()));
    const own = members.map((name) => byName.get(String(name).toLowerCase())).filter(Boolean);
    const around = risers.filter((mover) => !held.has(mover.name.toLowerCase())).slice(0, AROUND);
    if (!own.length && !around.length) return "";
    const ownLine = own.length
      ? `<p style="margin:.2rem 0">Your own: ${own.map((mover) => `<strong>${esc(mover.name)}</strong> ${arrow(mover)}`).join(", ")}</p>`
      : "";
    const aroundLine = around.length
      ? `<p style="margin:.2rem 0;${MUTED}">Rising around it: ${around.map((mover) => `${esc(mover.name)} ${arrow(mover)}`).join(", ")}</p>`
      : "";
    return `<div style="margin:.9rem 0;padding:.75rem .9rem;background:#f4f7fb;border-radius:10px">
      <p style="margin:0 0 .25rem;font-weight:600">${esc(team.title)}</p>${ownLine}${aroundLine}</div>`;
  }).filter(Boolean).join("");

  // `since` arrives display-ready from tools/meta_digest.py ("12 Nov"), because the date a
  // snapshot folder is named by ("12_11_2026") is not a date anybody reads.
  const window = since ? ` since ${esc(since)}` : "";

  return `<div style="${WRAP}">
  <p>The <strong>${esc(format)}</strong> meta moved${window}.</p>
  ${risers.length ? `<p style="margin-bottom:.2rem"><strong>Climbing</strong></p><ul style="margin:.2rem 0 .9rem">${moverList(risers)}</ul>` : ""}
  ${fallers.length ? `<p style="margin-bottom:.2rem"><strong>Falling</strong></p><ul style="margin:.2rem 0 .9rem">${moverList(fallers)}</ul>` : ""}
  ${teamBlocks ? `<p style="margin-top:1.2rem"><strong>What that means for your teams</strong></p>${teamBlocks}` : ""}
  <p style="margin-top:1.4rem"><a href="${origin}/team-builder/"
     style="display:inline-block;background:#0f1827;color:#e7f6ff;padding:.7rem 1.1rem;border-radius:10px;
     text-decoration:none;font-weight:600">Re-run Team Evaluation</a></p>
  <p style="${MUTED};margin-top:1.6rem">You are getting this because you asked us to watch
  ${teams.length ? `${teams.length} team${teams.length === 1 ? "" : "s"}` : "the meta"} for you.
  <a href="${unsubscribe}">Unsubscribe</a> — it deletes the record outright.</p>
</div>`;
}

export function onRequestGet() {
  return json({ error: "POST the diff here, with ?key=." }, 405);
}
