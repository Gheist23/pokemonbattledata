// POST /api/campaign/<code>   {step, visitor}  -> 204
// GET  /api/campaign/<code>                    -> {code, days:{...}, steps:{...}, total}
//
// The funnel behind a creator collaboration, counted first-party.  The link read
// out in the video (championsbattledata.com/giuseppe) redirects straight into
// the Team Builder, so every step below is sent from there by
// builder/campaign-track.js -- there is no landing page in between.  Nothing
// third-party runs on the page: no analytics script, no cookie, no consent
// banner, and nothing that could identify a person is sent or stored.
//
// WHAT IS STORED.  One EMPTY object per (campaign, day, step, visitor):
//
//   campaign/<code>/<YYYY-MM-DD>/<step>/<visitor>
//
// `visitor` is 16 hex characters the browser makes up for itself and keeps in
// its own localStorage.  It is not derived from anything about the person, it
// never leaves this one site, and the server never sees an IP, a header or a
// referrer written anywhere.  Because the key is the whole record, a visitor
// who reloads the page ten times overwrites the same key ten times: counting
// the keys counts PEOPLE PER STEP PER DAY, which is the number a campaign is
// actually judged on, and nothing finer can be recovered from the bucket.
//
// WHY R2 AND NOT KV.  Same reason the share endpoints use it (share/_lib.js:16):
// the free KV allowance is 1,000 writes a day for the whole account and the
// licence and sync endpoints already spend from it, while R2's free tier is
// 1,000,000 Class A operations a month.  A campaign that converts 2,500 people
// spends on the order of 10,000 of them.
//
// NOT CONFIGURED is not an error.  Without the R2 binding every POST answers
// 204 and the page carries on exactly as before -- a counter must never be able
// to break the thing it counts.
//
// READING THE NUMBERS.  GET returns counts only.  Set a CAMPAIGN_KEY environment
// variable in the Pages project to require `?key=` on it; with none set the
// counts are open, which is the state this ships in.

// The funnel, in order. `land` is the click the video bought; `builder` means
// the teams really arrived; the last two are the visitor asking the site to do
// something with one. `land` without `builder` is the failure worth seeing.
const STEPS = ["land", "builder", "evaluation", "autobuild"];
const MAX_LIST_PAGES = 25; // 25,000 objects; beyond that the answer says so rather than lying

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-store",
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

function store(env) {
  return env && env.SHARES ? env.SHARES : null;
}

/** "" for anything that is not a campaign code, checked BEFORE any storage call
 *  so a crafted path can never reach R2 (sync/[code].js:19 does the same). */
function cleanCode(raw) {
  const code = String(raw || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return code.length >= 2 && code.length <= 32 ? code : "";
}

/** The visitor's own id, or "" -- 16 hex characters and nothing else, so the
 *  key space one caller can reach is bounded by what it is willing to invent. */
function cleanVisitor(raw) {
  const id = String(raw || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return id.length === 16 ? id : "";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers });
}

export async function onRequestPost({ params, request, env }) {
  const bucket = store(env);
  const code = cleanCode(params.code);
  // Every refusal below is a 204, not an error: the browser is told nothing
  // went wrong because, as far as the visitor is concerned, nothing did.
  if (!bucket || !code) return new Response(null, { status: 204, headers });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 204, headers });
  }
  const step = STEPS.includes(String(body?.step)) ? String(body.step) : "";
  const visitor = cleanVisitor(body?.visitor);
  if (!step || !visitor) return new Response(null, { status: 204, headers });

  try {
    await bucket.put(`campaign/${code}/${today()}/${step}/${visitor}`, new Uint8Array(0));
  } catch {
    // A full bucket, a transient R2 error: the page is not the place to hear it.
  }
  return new Response(null, { status: 204, headers });
}

export async function onRequestGet({ params, request, env }) {
  const bucket = store(env);
  if (!bucket) return json({ error: "Campaign tracking is not configured on this server." }, 503);
  const code = cleanCode(params.code);
  if (!code) return json({ error: "That is not a campaign code." }, 400);

  const required = env.CAMPAIGN_KEY ? String(env.CAMPAIGN_KEY) : "";
  if (required && new URL(request.url).searchParams.get("key") !== required) {
    return json({ error: "Wrong or missing key." }, 403);
  }

  const prefix = `campaign/${code}/`;
  const days = {};
  const steps = {};
  let total = 0;
  let cursor;
  let truncated = false;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of listed.objects) {
      // campaign/<code>/<day>/<step>/<visitor>
      const [, , day, step] = object.key.split("/");
      if (!day || !step) continue;
      days[day] = days[day] || {};
      days[day][step] = (days[day][step] || 0) + 1;
      steps[step] = (steps[step] || 0) + 1;
      total += 1;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
    if (page === MAX_LIST_PAGES - 1) truncated = true;
  }

  return json({ code, total, steps, days, truncated });
}
