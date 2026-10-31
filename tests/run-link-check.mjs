// Link check: no page on this site points at something that is not there.
//
//   Nothing checked this before, and 348 links had rotted: every one of the 87 Pokemon
//   FORM pages -- the Megas, Aegislash-Blade, the Castform weathers -- offered "<form>
//   moves and usage", "held items", "teammates" and "team building" under its OWN slug,
//   while `writeSeoPages` only ever writes those four under the RECORD's slug. The form
//   pages are exactly the ones with least on them, so the dead links sat where a reader
//   was most likely to click. `subpageLinks` in tools/generate-manifest.mjs now points
//   them at the record that holds the data, and this suite is what keeps them pointed.
//
//   It also checks the head of every page -- a canonical that names the page itself, a
//   title, a description -- and the redirect table, whose targets have to exist too.
//
//   node tests/run-link-check.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SITE = "https://championsbattledata.com";

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

/* ---------------------------------------------------------------- what exists */

// `.git` and `.wrangler` are not served; everything else is, assets included -- they are
// link TARGETS even though no HTML is read out of them.
const SKIP = new Set([".git", "node_modules", ".wrangler"]);
const NO_HTML = new Set(["pokemon_champions_assets", "data"]);
const present = new Set();
const htmlFiles = [];
(function walk(dir, rel) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, rel ? `${rel}/${name}` : name);
    else {
      const path = `/${rel ? `${rel}/` : ""}${name}`;
      present.add(path);
      if (name.endsWith(".html") && !NO_HTML.has(rel.split("/")[0])) htmlFiles.push([full, path]);
    }
  }
})(root, "");

const redirectRows = readFileSync(join(root, "_redirects"), "utf8")
  .split(/\r?\n/).map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => line.split(/\s+/));
const redirectFrom = new Set(redirectRows.map((row) => row[0]));

/** Would a request for `target` be answered -- as a file, a directory index, or a redirect? */
function resolves(target) {
  if (present.has(target)) return true;
  if (present.has(target.endsWith("/") ? `${target}index.html` : `${target}/index.html`)) return true;
  if (present.has(`${target}.html`)) return true;
  if (redirectFrom.has(target) || redirectFrom.has(target.replace(/\/$/, ""))) return true;
  // The Pages Functions under functions/api answer these themselves.
  return /^\/api(\/|$)/.test(target);
}

/* ------------------------------------------------------------- the links */

// `&#39;` inside a filename carries a `#`, so the entities have to go before the fragment
// is cut off, or `King&#39;s Rock.png` becomes `King&`. And `<base href="/">` is on every
// generated page, which is what relative targets resolve against there.
const unescapeHtml = (value) => value
  .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const ATTR = /\b(?:href|src)\s*=\s*"([^"]+)"/g;
const broken = new Map();
const headProblems = [];
const canonicalOf = new Map();

for (const [file, where] of htmlFiles) {
  const text = readFileSync(file, "utf8");
  const baseDir = text.match(/<base\s+href\s*=\s*"([^"]*)"/i)?.[1] ?? `${posix.dirname(where)}/`;

  for (const match of text.matchAll(ATTR)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("data:") || raw.startsWith("mailto:")
        || raw.startsWith("tel:") || /^[a-z]+:\/\//i.test(raw) || raw.startsWith("//")) continue;
    let target = unescapeHtml(raw).split("#")[0].split("?")[0];
    try { target = decodeURI(target); } catch { /* a broken escape stays as written */ }
    if (!target) continue;
    const abs = target.startsWith("/") ? target : posix.normalize(posix.join(baseDir, target));
    if (resolves(abs)) continue;
    broken.set(abs, [...(broken.get(abs) || []), where]);
  }

  const ownUrl = where.endsWith("/index.html") ? SITE + where.slice(0, -"index.html".length) : SITE + where;
  const canonical = text.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
  const title = text.match(/<title>([^<]*)<\/title>/)?.[1];
  const description = text.match(/<meta name="description" content="([^"]*)"/)?.[1];
  // 404.html is served for addresses that do not exist, so it has no address of its own.
  if (!where.endsWith("/404.html")) {
    if (!canonical) headProblems.push(`${where} has no canonical`);
    else {
      canonicalOf.set(canonical, [...(canonicalOf.get(canonical) || []), where]);
      // api.html used to be a second, drifting copy of api_guide.html and pointed here;
      // it is gone, and nothing else may claim another page's address. Pages serves
      // `/api_guide.html` at `/api_guide`, so the extensionless form is the same page.
      if (canonical !== ownUrl && canonical !== ownUrl.replace(/\.html$/, "")) {
        headProblems.push(`${where} claims ${canonical}`);
      }
    }
  }
  if (!title || !title.trim()) headProblems.push(`${where} has no title`);
  if (!description || !description.trim()) headProblems.push(`${where} has no description`);
}

check(`every internal link resolves (${htmlFiles.length} pages)`, broken.size === 0,
  [...broken].slice(0, 8).map(([target, from]) => `${target} (${from.length}x, e.g. ${from[0]})`).join("; "));

check("every page's head names itself", headProblems.length === 0, headProblems.slice(0, 8).join("; "));

const sharedCanonical = [...canonicalOf].filter(([, pages]) => pages.length > 1);
check("no two pages claim one canonical", sharedCanonical.length === 0,
  sharedCanonical.slice(0, 5).map(([url, pages]) => `${url} <- ${pages.join(", ")}`).join("; "));

/* ------------------------------------------------------------- the sitemap */

// A page either invites indexing and is submitted, or says `noindex` and is left out.
// /play/ was the one page on the wrong side of that: `robots: index, follow` in its head and
// absent from the sitemap, so the Play tool was invisible to search while every one of its
// siblings -- Team Builder, Damage Calculator, Solver, Meta -- was listed.
const SITEMAP_URLS = new Set([...readFileSync(join(root, "sitemap.xml"), "utf8")
  .matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].slice(SITE.length) || "/"));
const indexedButUnlisted = [];
const listedButNoindex = [];
for (const [file, where] of htmlFiles) {
  const text = readFileSync(file, "utf8");
  const noindex = /content="[^"]*noindex/i.test(text);
  const pretty = where.endsWith("/index.html") ? where.slice(0, -"index.html".length) : where;
  const listed = SITEMAP_URLS.has(pretty) || SITEMAP_URLS.has(where)
    || SITEMAP_URLS.has(pretty.replace(/\.html$/, ""));
  if (!noindex && !listed) indexedButUnlisted.push(where);
  if (noindex && listed) listedButNoindex.push(where);
}
check(`every indexable page is in the sitemap (${SITEMAP_URLS.size} URLs)`, indexedButUnlisted.length === 0,
  indexedButUnlisted.slice(0, 8).join(", "));
check("and nothing marked noindex is", listedButNoindex.length === 0, listedButNoindex.slice(0, 8).join(", "));

const unreachable = [...SITEMAP_URLS].filter((url) => !resolves(url));
check("every sitemap URL resolves", unreachable.length === 0, unreachable.slice(0, 8).join(", "));

/* ------------------------------------------------------------- the redirects */

const deadTargets = [];
const chains = [];
for (const [from, to] of redirectRows) {
  if (!to) continue;
  const target = to.split("?")[0];
  if (!resolves(target)) deadTargets.push(`${from} -> ${to}`);
  // Cloudflare does not follow a redirect to a redirect; the second hop is simply lost.
  if (redirectFrom.has(target) && target !== from) chains.push(`${from} -> ${to} -> ...`);
}
check(`every redirect has somewhere to go (${redirectRows.length} rules)`, deadTargets.length === 0,
  deadTargets.slice(0, 8).join("; "));
check("no redirect points at another redirect", chains.length === 0, chains.slice(0, 8).join("; "));

/* ------------------------------------------- the rule the form pages broke */

// Pinned on its own, because the link check above only notices it once a page is generated:
// a subpage belongs to the RECORD, so a form page must never offer one under its own slug.
const formPagesWithOwnSubpageLinks = [];
for (const dir of readdirSync(join(root, "pokemon"))) {
  const file = join(root, "pokemon", dir, "index.html");
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const segment of ["moves", "items", "teammates"]) {
    if (text.includes(`href="/pokemon/${dir}/${segment}/"`) && !existsSync(join(root, "pokemon", dir, segment, "index.html"))) {
      formPagesWithOwnSubpageLinks.push(`${dir}/${segment}`);
    }
  }
  if (text.includes(`href="/teams/${dir}/"`) && !existsSync(join(root, "teams", dir, "index.html"))) {
    formPagesWithOwnSubpageLinks.push(`teams/${dir}`);
  }
}
check("no page offers a subpage that was never written", formPagesWithOwnSubpageLinks.length === 0,
  formPagesWithOwnSubpageLinks.slice(0, 8).join(", "));

console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
