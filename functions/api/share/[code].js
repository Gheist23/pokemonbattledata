// GET /api/share/<code>              -> the share PAGE (HTML, with the og tags)
// GET /api/share/<code>?format=json  -> the share RECORD (JSON)
//
// One URL, two representations, and HTML is the default because this URL is the
// one people paste.  Every unfurler that matters -- facebookexternalhit,
// Twitterbot, Discordbot, Slackbot -- asks for `*/*` rather than `text/html`,
// so a content type negotiated the other way round would hand a crawler JSON
// and the share would have no card at all.  A caller that wants the record says
// so, with `?format=json` or `Accept: application/json`, and the create
// endpoint hands back that exact URL as `recordUrl`.
//
// The page is the static template at /share/index.html with three marked blocks
// replaced: the head (og:*, twitter:*, canonical, title), the record as inline
// JSON so the page needs no second request, and a <noscript> hero.  Reusing the
// template is what keeps the served page and /share/?c=<code> the same page.
//
// This handler is mount-point agnostic on purpose.  At /api/share/<code> a
// malformed code is a 400; anywhere else (if the prettier /share/<code> route
// is ever mounted) it falls through to the static asset, which is how
// /share/share-page.js would keep working underneath it.

import {
  SITE_ORIGIN, cardDescription, cardTitle, escapeHtml, escapeJsonForHtml, imageUrl, isExpired,
  json, normaliseCode, pageUrl, recordKey, store,
} from "./_lib.js";

const TEMPLATE_PATH = "/share/index.html";
const META_OPEN = "<!--SHARE:META-->";
const META_CLOSE = "<!--/SHARE:META-->";
const DATA_OPEN = "<!--SHARE:DATA-->";
const DATA_CLOSE = "<!--/SHARE:DATA-->";
const NOSCRIPT_OPEN = "<!--SHARE:NOSCRIPT-->";
const NOSCRIPT_CLOSE = "<!--/SHARE:NOSCRIPT-->";

const KIND_WORD = { eval: "Team Evaluation", team: "Team" };

/** What a page with no card unfurls to: a real, already-deployed site asset
 *  rather than a dead card URL.  Its type and its true pixel size are declared
 *  here so the og:image:* trio is never a claim about a different file --
 *  assets/tool/team-builder.webp is a 1600x862 WEBP (1.856:1, so
 *  twitter:card=summary_large_image still crops correctly).  If that asset is
 *  ever replaced, these three lines move with it; the endpoints suite reads the
 *  file off disk and fails on a mismatch. */
const MISS_IMAGE = Object.freeze({
  url: `${SITE_ORIGIN}/assets/tool/team-builder.webp`,
  type: "image/webp",
  width: 1600,
  height: 862,
});

function htmlResponse(body, status = 200, cacheControl = "public, max-age=3600") {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": cacheControl },
  });
}

/** Every tag a crawler reads, with the image URL absolute -- a relative
 *  og:image is resolved inconsistently and by some unfurlers not at all.
 *  Consistent with pro-tool/index.html:11-20 and team-builder/index.html:11-20:
 *  og:type, og:url, og:title, og:description, og:site_name, og:image, then the
 *  twitter:* trio. */
function metaBlock({ title, description, page, image, kind, imageType = "image/png", imageW = 1200, imageH = 630 }) {
  // A miss has no kind to name, and calling it a "Team" in the tab title while
  // the page says the link is gone reads like a bug.
  const heading = kind
    ? `${title} - ${KIND_WORD[kind] || KIND_WORD.team} - Pokemon Champions`
    : `${title} - Pokemon Champions`;
  return [
    `  <title>${escapeHtml(heading)}</title>`,
    `  <meta name="description" content="${escapeHtml(description)}" />`,
    // A share is one person's team, not a page this site wants in the index;
    // `follow` still lets the links out.  Unfurlers ignore this tag, so the
    // card is unaffected.
    '  <meta name="robots" content="noindex, follow" />',
    `  <link rel="canonical" href="${escapeHtml(page)}" />`,
    '  <meta property="og:type" content="website" />',
    `  <meta property="og:url" content="${escapeHtml(page)}" />`,
    `  <meta property="og:title" content="${escapeHtml(heading)}" />`,
    `  <meta property="og:description" content="${escapeHtml(description)}" />`,
    '  <meta property="og:site_name" content="Pokemon Champions Battle Data" />',
    `  <meta property="og:image" content="${escapeHtml(image)}" />`,
    `  <meta property="og:image:secure_url" content="${escapeHtml(image)}" />`,
    // Declared from the image actually referenced, not from the card's shape:
    // the miss page falls back to a real site asset, and a .webp announced as a
    // 1200x630 PNG is three claims a crawler can check and find false.
    `  <meta property="og:image:type" content="${escapeHtml(imageType)}" />`,
    `  <meta property="og:image:width" content="${Number(imageW)}" />`,
    `  <meta property="og:image:height" content="${Number(imageH)}" />`,
    `  <meta property="og:image:alt" content="${escapeHtml(description)}" />`,
    '  <meta name="twitter:card" content="summary_large_image" />',
    `  <meta name="twitter:title" content="${escapeHtml(heading)}" />`,
    `  <meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `  <meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ].join("\n");
}

function noscriptBlock({ title, description, image }) {
  return [
    "<noscript>",
    `  <h1>${escapeHtml(title)}</h1>`,
    `  <p>${escapeHtml(description)}</p>`,
    `  <p><img src="${escapeHtml(image)}" width="1200" height="630" alt="${escapeHtml(description)}" /></p>`,
    '  <p>Built with <a href="https://championsbattledata.com/">championsbattledata.com</a></p>',
    "</noscript>",
  ].join("\n");
}

function replaceBlock(html, open, close, replacement) {
  const from = html.indexOf(open);
  if (from < 0) return html;
  const to = html.indexOf(close, from);
  if (to < 0) return html;
  return `${html.slice(0, from + open.length)}${replacement}${html.slice(to)}`;
}

/** A page that stands on its own if the template cannot be read, so a missing
 *  or renamed asset degrades to a plain card instead of a 500. */
function standalonePage(meta, noscript, dataScript) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    meta,
    '  <link rel="stylesheet" href="/styles.css" />',
    "</head>",
    '<body class="page-share">',
    "  <main>",
    noscript,
    "  </main>",
    dataScript,
    '  <script type="module" src="/share/share-page.js"></script>',
    "</body>",
    "</html>",
  ].join("\n");
}

async function template(env, request) {
  try {
    const response = await env.ASSETS.fetch(new URL(TEMPLATE_PATH, request.url).toString());
    if (!response.ok) return "";
    const text = await response.text();
    return text.includes(META_OPEN) ? text : "";
  } catch {
    return "";
  }
}

async function page(env, request, { record, code, status, note }) {
  const digest = record?.digest || null;
  const fallbackTitle = String(note || "This share link is not available").replace(/\.$/, "");
  const title = digest ? cardTitle(digest) : fallbackTitle;
  const description = digest
    ? cardDescription(digest)
    : note || "Share a Pokemon Champions team or a Team Evaluation result as a picture.";
  const image = digest ? imageUrl(request, code) : MISS_IMAGE.url;
  const meta = metaBlock({
    title, description, page: pageUrl(request, code), image, kind: digest?.kind || "",
    imageType: digest ? "image/png" : MISS_IMAGE.type,
    imageW: digest ? 1200 : MISS_IMAGE.width,
    imageH: digest ? 630 : MISS_IMAGE.height,
  });
  const noscript = noscriptBlock({ title, description, image });
  const payload = escapeJsonForHtml(JSON.stringify({
    code,
    status: status === 200 ? "ok" : "gone",
    note: note || "",
    pageUrl: pageUrl(request, code),
    imageUrl: digest ? imageUrl(request, code) : "",
    record: record || null,
  }));
  const dataScript = `<script type="application/json" id="shareData">${payload}</script>`;
  const shell = await template(env, request);
  if (!shell) {
    return htmlResponse(standalonePage(meta, noscript, dataScript), status,
      status === 200 ? "public, max-age=3600" : "public, max-age=300");
  }
  let html = replaceBlock(shell, META_OPEN, META_CLOSE, `\n${meta}\n`);
  html = replaceBlock(html, DATA_OPEN, DATA_CLOSE, dataScript);
  html = replaceBlock(html, NOSCRIPT_OPEN, NOSCRIPT_CLOSE, `\n${noscript}\n`);
  return htmlResponse(html, status, status === 200 ? "public, max-age=3600" : "public, max-age=300");
}

/**
 * ONE URL, ONE REPRESENTATION -- the query string decides, never the Accept
 * header.  Both answers are public and cacheable, and Cloudflare's cache keys
 * on the URL and ignores `Vary` on everything except Accept-Encoding, so an
 * Accept-negotiated pair at one URL would eventually serve a cached JSON body
 * to a crawler (no card) or a cached HTML body to the Companion (no record).
 * `?format=json` is a different URL and cannot do that.  The create endpoint
 * hands every client that exact URL back as `recordUrl`.
 */
function wantsJson(request) {
  return String(new URL(request.url).searchParams.get("format") || "").toLowerCase() === "json";
}

export async function onRequestGet(context) {
  const { params, env, request, next } = context;
  const onApiRoute = new URL(request.url).pathname.startsWith("/api/share");
  const code = normaliseCode(params?.code);
  if (!code) {
    // Mounted anywhere but /api/share, a path that is not a code belongs to the
    // static assets underneath (/share/share-page.js, /share/index.html).
    if (!onApiRoute && typeof next === "function") return next();
    return wantsJson(request)
      ? json({ error: "That is not a share code." }, 400)
      : page(env, request, { record: null, code: "", status: 404, note: "That is not a share link." });
  }

  const bucket = store(env);
  if (!bucket) {
    // The binding is added only after the bucket exists, so this is the state
    // the feature ships in.  An API caller gets the same 503 the sync routes
    // give (functions/api/sync/index.js:8); a person or a crawler gets a page
    // that says so, rather than a naked JSON error.
    return wantsJson(request)
      ? json({ error: "Sharing is not configured on this server." }, 503)
      : page(env, request, { record: null, code, status: 503, note: "Sharing is not switched on yet." });
  }

  const stored = await bucket.get(await recordKey(code));
  let record = null;
  if (stored) {
    try {
      record = JSON.parse(await stored.text());
    } catch {
      record = null;
    }
  }
  if (!record) {
    return wantsJson(request)
      ? json({ error: "Unknown share code." }, 404)
      : page(env, request, { record: null, code, status: 404, note: "That share link does not exist." });
  }
  if (isExpired(record)) {
    return wantsJson(request)
      ? json({ error: "That share link has expired." }, 410)
      : page(env, request, { record: null, code, status: 410, note: "That share link has expired." });
  }
  if (wantsJson(request)) {
    return json({ code, ...record }, 200, {
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    });
  }
  return page(env, request, { record, code, status: 200 });
}

export const onRequestHead = onRequestGet;

/** Read-only, immutable, and deliberately without a writer: there is no PUT, no
 *  PATCH and no DELETE, so a link that has been pasted can never change under
 *  the people who clicked it.  Named so the reason is in the file rather than in
 *  the absence of code. */
export function onRequestPut() {
  return json({ error: "A share is immutable; create a new one instead." }, 405);
}
export const onRequestPatch = onRequestPut;
export const onRequestDelete = onRequestPut;
