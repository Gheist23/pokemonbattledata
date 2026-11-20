// THE META WATCH LIST, DRIVEN END TO END.
//
// This is the first thing on the site that sends mail to people who have not
// bought anything, so the failure modes are not "a number is wrong" -- they are
// "somebody was mailed who never confirmed", "unsubscribe did not work" and
// "the whole list was mailed twice". None of those can be checked by reading the
// source, so this suite imports the four endpoints and runs the real flow
// against a stub R2 bucket and a stub fetch.
//
//   node tests/run-watch.mjs
//
// No network and no browser: the stub fetch records what WOULD have been sent,
// which is also how the "nobody is mailed before confirming" check is possible
// at all. Not deployed -- tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

let checked = 0;
const failures = [];
const notes = [];
function ok(label, condition, detail = "") {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
}

/* ------------------------------------------------------------ the stubs */

/** Enough of R2 for these endpoints: get/put/delete/list over a Map. */
function fakeBucket() {
  const data = new Map();
  return {
    data,
    async get(key) {
      if (!data.has(key)) return null;
      const value = data.get(key);
      return { async text() { return value; } };
    },
    async put(key, value) { data.set(key, String(value)); },
    async delete(key) { data.delete(key); },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = keys.slice(start, start + limit);
      const end = start + slice.length;
      return {
        objects: slice.map((key) => ({ key })),
        truncated: end < keys.length,
        cursor: String(end),
      };
    },
  };
}

/** Records every outbound mail instead of sending it. */
function fakeMailer() {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    let body = null;
    try { body = JSON.parse(options.body); } catch { /* not ours */ }
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify({ id: "stub" }), { status: 200 });
  };
  return calls;
}

const ENV = () => ({
  SHARES: fakeBucket(),
  RESEND_API_KEY: "re_stub",
  DIGEST_KEY: "digest-secret",
  SITE_ORIGIN: "https://championsbattledata.com",
});

const post = (url, body) => new Request(url, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const get = (url) => new Request(url, { method: "GET" });

const TEAMS = [
  { title: "Sun", members: ["Torkoal", "Lilligant", "Milotic", "Incineroar"] },
  { title: "Rain", members: ["Pelipper", "Barraskewda", "Rillaboom"] },
];

const RISERS = [["Milotic", 17, 15], ["Toxapex", 103, 74]];
const FALLERS = [["Rillaboom", 6, 19]];

/* ------------------------------------------------------- the modules */

const subscribe = await import("../functions/api/watch/index.js");
const confirm = await import("../functions/api/watch/confirm.js");
const unsubscribe = await import("../functions/api/watch/unsubscribe.js");
const digest = await import("../functions/api/watch/digest.js");
const lib = await import("../functions/api/watch/_lib.js");

const HASH = await lib.emailHash("Player@Example.COM");

/* ========================================================= 1. subscribing */

{
  const env = ENV();
  const mail = fakeMailer();
  const response = await subscribe.onRequestPost({
    request: post("https://x/api/watch", { email: "Player@Example.COM", format: "Doubles", teams: TEAMS }),
    env,
  });
  ok("subscribing answers 200", response.status === 200, String(response.status));

  const keys = [...env.SHARES.data.keys()];
  ok("it writes exactly one pending record", keys.length === 1, keys.join(","));
  ok("...keyed by a hash of the address, not the address",
    keys[0] === `watch/pending/${HASH}`, keys[0]);
  ok("...and the address is normalised (case, spaces)",
    JSON.parse(env.SHARES.data.get(keys[0])).email === "player@example.com");

  // THE CHECK THIS WHOLE SUITE EXISTS FOR.
  ok("NOTHING is written to watch/live/ before the link is opened",
    !keys.some((key) => key.startsWith("watch/live/")), keys.join(","));

  ok("exactly one mail is sent", mail.length === 1, String(mail.length));
  ok("...and it is the confirmation, not the digest",
    mail[0]?.body?.subject === "Confirm your meta watch", String(mail[0]?.body?.subject));
  ok("...to the address that asked", mail[0]?.body?.to?.[0] === "player@example.com");
  ok("...carrying the confirm link", /\/api\/watch\/confirm\?e=[^&]+&t=[0-9a-f]{32}/.test(mail[0]?.body?.html || ""));
  ok("...and saying plainly that nothing is sent until it is opened",
    /nothing is ever sent/i.test(mail[0]?.body?.html || ""));
  ok("...and naming what is kept",
    /address and the species names/i.test(mail[0]?.body?.html || ""));
}

/* ------------------------------------------- a bad address, and the cooldown */

{
  const env = ENV();
  const mail = fakeMailer();
  const bad = await subscribe.onRequestPost({
    request: post("https://x/api/watch", { email: "not-an-address", teams: TEAMS }), env,
  });
  ok("a malformed address is refused", bad.status === 400, String(bad.status));
  ok("...and nothing is stored for it", env.SHARES.data.size === 0, String(env.SHARES.data.size));
  ok("...and no mail is sent", mail.length === 0, String(mail.length));
}

{
  // No mailer: the refusal says "nothing was stored", so nothing may be stored.
  const env = ENV();
  fakeMailer();
  const response = await subscribe.onRequestPost({
    request: post("https://x/api/watch", { email: "player@example.com", teams: TEAMS }),
    env: { ...env, RESEND_API_KEY: "" },
  });
  ok("with no mailer configured the box says so", response.status === 503, String(response.status));
  ok("...and leaves no orphan pending record behind, as that reply claims",
    env.SHARES.data.size === 0, [...env.SHARES.data.keys()].join(","));
}

{
  const env = ENV();
  const mail = fakeMailer();
  const body = { email: "player@example.com", format: "Doubles", teams: TEAMS };
  await subscribe.onRequestPost({ request: post("https://x/api/watch", body), env });
  await subscribe.onRequestPost({ request: post("https://x/api/watch", body), env });
  await subscribe.onRequestPost({ request: post("https://x/api/watch", body), env });
  ok("three subscribes in a row send ONE mail, so this cannot mail-bomb an address",
    mail.length === 1, String(mail.length));
  ok("...and still hold only one pending record", env.SHARES.data.size === 1, String(env.SHARES.data.size));
}

/* ========================================================== 2. confirming */

async function confirmed() {
  const env = ENV();
  const mail = fakeMailer();
  await subscribe.onRequestPost({
    request: post("https://x/api/watch", { email: "player@example.com", format: "Doubles", teams: TEAMS }),
    env,
  });
  const token = JSON.parse(env.SHARES.data.get(`watch/pending/${HASH}`)).token;
  return { env, mail, token };
}

{
  const { env, token } = await confirmed();
  const wrong = await confirm.onRequestGet({
    request: get(`https://x/api/watch/confirm?e=${HASH}&t=${"0".repeat(32)}`), env,
  });
  ok("a wrong token cannot confirm an address", wrong.status === 400, String(wrong.status));
  ok("...and the pending record survives it", env.SHARES.data.has(`watch/pending/${HASH}`));
  ok("...and no live record appears",
    ![...env.SHARES.data.keys()].some((key) => key.startsWith("watch/live/")));

  const missing = await confirm.onRequestGet({ request: get("https://x/api/watch/confirm"), env });
  ok("a link with no parameters is refused", missing.status === 400, String(missing.status));

  const right = await confirm.onRequestGet({
    request: get(`https://x/api/watch/confirm?e=${HASH}&t=${token}`), env,
  });
  ok("the real token confirms", right.status === 200, String(right.status));
  const live = JSON.parse(env.SHARES.data.get(`watch/live/${HASH}`) || "null");
  ok("...writing the live record", Boolean(live));
  ok("...with the teams carried over", live?.teams?.length === 2, String(live?.teams?.length));
  ok("...and lastSentAt starting at zero so the first digest reaches them",
    live?.lastSentAt === 0, String(live?.lastSentAt));
  ok("...and the pending record cleared", !env.SHARES.data.has(`watch/pending/${HASH}`));

  const again = await confirm.onRequestGet({
    request: get(`https://x/api/watch/confirm?e=${HASH}&t=${token}`), env,
  });
  ok("opening the link twice is not an error (mail clients prefetch)",
    again.status === 200, String(again.status));
}

/* ============================================================= 3. the digest */

async function listReady() {
  const { env } = await confirmed();
  const token = JSON.parse(env.SHARES.data.get(`watch/pending/${HASH}`)).token;
  await confirm.onRequestGet({ request: get(`https://x/api/watch/confirm?e=${HASH}&t=${token}`), env });
  return { env, token };
}

{
  const { env } = await listReady();

  const noKey = await digest.onRequestPost({
    request: post("https://x/api/watch/digest", { format: "Doubles", risers: RISERS }),
    env: { ...env, DIGEST_KEY: "" },
  });
  ok("the digest refuses to run with no DIGEST_KEY set", noKey.status === 503, String(noKey.status));

  const wrongKey = await digest.onRequestPost({
    request: post("https://x/api/watch/digest?key=nope", { format: "Doubles", risers: RISERS }),
    env,
  });
  ok("...and refuses a wrong key", wrongKey.status === 403, String(wrongKey.status));

  const quiet = await digest.onRequestPost({
    request: post("https://x/api/watch/digest?key=digest-secret", { format: "Doubles", risers: [], fallers: [] }),
    env,
  });
  ok("a week where nothing moved mails nobody",
    (await quiet.json()).skipped === "nothing moved");
}

{
  const { env } = await listReady();
  const mail = fakeMailer();
  const response = await digest.onRequestPost({
    request: post("https://x/api/watch/digest?key=digest-secret", {
      format: "Doubles", asOf: "19_11_2026", since: "12_11_2026", risers: RISERS, fallers: FALLERS,
    }),
    env,
  });
  const result = await response.json();
  ok("the digest sends to the confirmed subscriber", result.sent === 1, JSON.stringify(result));
  ok("...with a subject naming the biggest mover in each direction",
    result.subject === "Doubles meta: Milotic up 2, Rillaboom down 13", String(result.subject));
  notes.push(`digest subject: ${result.subject}`);

  const sent = mail.find((call) => call.url.includes("/emails/batch"));
  ok("...through the batch endpoint, so one request covers the whole list", Boolean(sent));
  const message = sent?.body?.[0];
  ok("...carrying a List-Unsubscribe header",
    Boolean(message?.headers?.["List-Unsubscribe"]), JSON.stringify(message?.headers || {}));
  ok("...and the one-click form Gmail and Outlook honour",
    message?.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
  ok("...and a visible unsubscribe link in the body",
    /\/api\/watch\/unsubscribe\?e=/.test(message?.html || ""));
  ok("the mail names the subscriber's own mover",
    /Milotic/.test(message?.html || ""));
  ok("...and their team by title", /Sun/.test(message?.html || "") && /Rain/.test(message?.html || ""));
  ok("...and shows risers they do NOT have as what is rising around them",
    /Rising around it/.test(message?.html || ""));

  // The reason the publisher may run this every single day.
  const immediately = await digest.onRequestPost({
    request: post("https://x/api/watch/digest?key=digest-secret", {
      format: "Doubles", risers: RISERS, fallers: FALLERS,
    }),
    env,
  });
  const second = await immediately.json();
  ok("running it again the same day mails nobody a second time",
    second.sent === 0 && second.due === 0, JSON.stringify(second));
  ok("...while still counting them as on the list", second.matched === 1, JSON.stringify(second));
}

{
  // A Singles subscriber must not get the Doubles mail.
  const { env } = await listReady();
  const live = JSON.parse(env.SHARES.data.get(`watch/live/${HASH}`));
  await env.SHARES.put(`watch/live/${HASH}`, JSON.stringify({ ...live, format: "Singles" }));
  fakeMailer();
  const response = await digest.onRequestPost({
    request: post("https://x/api/watch/digest?key=digest-secret", { format: "Doubles", risers: RISERS }),
    env,
  });
  const result = await response.json();
  ok("a Singles subscriber is not sent the Doubles digest",
    result.matched === 0 && result.sent === 0, JSON.stringify(result));
}

{
  // No mailer configured: count, do not pretend.
  const { env } = await listReady();
  const response = await digest.onRequestPost({
    request: post("https://x/api/watch/digest?key=digest-secret", { format: "Doubles", risers: RISERS }),
    env: { ...env, RESEND_API_KEY: "" },
  });
  const result = await response.json();
  ok("with no RESEND_API_KEY the run reports what it would have sent",
    result.sent === 0 && result.due === 1 && result.skipped === "no RESEND_API_KEY",
    JSON.stringify(result));
}

/* ========================================================= 4. unsubscribing */

{
  const { env, token } = await listReady();
  const wrong = await unsubscribe.onRequestGet({
    request: get(`https://x/api/watch/unsubscribe?e=${HASH}&t=${"1".repeat(32)}`), env,
  });
  ok("a wrong token cannot unsubscribe somebody else", wrong.status === 200, String(wrong.status));
  ok("...and the record survives", env.SHARES.data.has(`watch/live/${HASH}`));

  const right = await unsubscribe.onRequestGet({
    request: get(`https://x/api/watch/unsubscribe?e=${HASH}&t=${token}`), env,
  });
  ok("the real token unsubscribes", right.status === 200, String(right.status));
  ok("...and the record is DELETED, not flagged",
    !env.SHARES.data.has(`watch/live/${HASH}`), [...env.SHARES.data.keys()].join(","));
  ok("...leaving nothing behind at all", env.SHARES.data.size === 0, String(env.SHARES.data.size));

  const twice = await unsubscribe.onRequestGet({
    request: get(`https://x/api/watch/unsubscribe?e=${HASH}&t=${token}`), env,
  });
  ok("unsubscribing twice is not an error", twice.status === 200, String(twice.status));
}

{
  const { env, token } = await listReady();
  const oneClick = await unsubscribe.onRequestPost({
    request: post(`https://x/api/watch/unsubscribe?e=${HASH}&t=${token}`, {}), env,
  });
  ok("one-click POST unsubscribe answers 204", oneClick.status === 204, String(oneClick.status));
  ok("...and removes the record", !env.SHARES.data.has(`watch/live/${HASH}`));
}

/* =========================================== 5. what is stored, and bounds */

{
  ok("cleanTeams drops teams with no members",
    lib.cleanTeams([{ title: "x", members: [] }]).length === 0);
  ok("...caps the number of teams",
    lib.cleanTeams(Array.from({ length: 50 }, () => ({ title: "t", members: ["A"] }))).length === lib.MAX_TEAMS);
  ok("...caps the members per team",
    lib.cleanTeams([{ title: "t", members: Array.from({ length: 30 }, (_, i) => `P${i}`) }])[0].members.length === lib.MAX_MEMBERS);
  ok("...and keeps only titles and species names, never sets or items",
    JSON.stringify(lib.cleanTeams([{ title: "t", members: ["A"], ev_spreads: { A: 1 }, item: "x" }]))
      === JSON.stringify([{ title: "t", members: ["A"] }]));
  ok("a crafted token cannot reach storage", lib.cleanToken("../../etc/passwd") === "");
  ok("...nor a crafted hash", lib.cleanHash("../../live/aaa") === "");
  ok("an unknown format falls back to Doubles rather than creating a third list",
    lib.cleanFormat("Triples") === "Doubles" && lib.cleanFormat("Singles") === "Singles");
}

{
  // The sender. Resend refuses an unverified domain, so the fallback has to be an
  // address that is already delivering -- not the prettiest one.
  ok("the default sender is the address the licence mail already uses",
    lib.fromAddress({}) === "Champions Battle Data <keys@championsbattledata.com>", lib.fromAddress({}));
  ok("...and the licence project's own setting wins over the hard-coded one",
    lib.fromAddress({ LICENSE_FROM_EMAIL: "a@b.c" }) === "a@b.c");
  ok("...and WATCH_FROM_EMAIL wins over both",
    lib.fromAddress({ LICENSE_FROM_EMAIL: "a@b.c", WATCH_FROM_EMAIL: "m@b.c" }) === "m@b.c");
}

/* ============================================ 6. the promises in the copy */
// The capture box makes four claims. Each is a thing the code must keep doing,
// so each is pinned here: a change that quietly breaks one should fail a test,
// not be discovered by a recipient.

const watch = read("builder", "watch.js");
const subscribeSource = read("functions", "api", "watch", "index.js");
const digestSource = read("functions", "api", "watch", "digest.js");

ok('the box promises "one mail a week at most"', /One mail a week at most/.test(watch));
ok("...and the endpoint enforces a gap that makes that true",
  /MIN_GAP_DAYS/.test(digestSource) && /MIN_GAP_DAYS = 6/.test(read("functions", "api", "watch", "_lib.js")));
ok('the box promises "only when something actually moved"', /only when something actually moved/.test(watch));
ok("...and the endpoint returns early when nothing did",
  /nothing moved/.test(digestSource));
ok("the box promises a confirmation first", /nothing is sent until you open it/i.test(watch));
ok("...and the subscribe endpoint only ever writes a pending record",
  !/liveKey\([^)]*\)\s*,\s*\{[^}]*confirmedAt/.test(subscribeSource));
ok("the box promises the unsubscribe deletes the lot",
  /deletes the lot/.test(watch) && /bucket\.delete/.test(read("functions", "api", "watch", "unsubscribe.js")));
ok("the box only appears once there is a team to watch",
  /if \(!teams\.length\) return null;/.test(watch));
ok("...and never counts a pristine placeholder team as one",
  /!team\.pristine/.test(watch));

/* ------------------------------------- the one header without which none of this runs */
// Cloudflare refuses "Python-urllib/..." on this zone with 403 / error 1010 before the request
// reaches the Function at all, so the digest would compute correctly every morning and never be
// delivered. Verified live 20 Nov 2026. Pinned here because nothing else would notice.
const digestTool = read("tools", "meta_digest.py");
ok("the digest poster sends a User-Agent at all", /"User-Agent": USER_AGENT/.test(digestTool));
ok("...a plain client name, not an address or anything identifying the operator",
  /^USER_AGENT = "[a-z0-9-]+\/\d+"$/m.test(digestTool));
ok("...and records that Cloudflare is why", /1010/.test(digestTool));

/* ---------------------------------------------- the publisher actually calls it */
// publish_champions_data.py lives in PokemonChampionsData/, one level ABOVE this repo, and that
// folder is not under version control -- so on a fresh clone it simply is not there. Checked
// when present (it is what makes the digest weekly rather than never) and reported as skipped
// when absent, because a missing file outside the repo is not a defect in the repo.
let publisher = "";
try {
  publisher = read("..", "publish_champions_data.py");
} catch {
  notes.push("publish_champions_data.py is not beside this repo -- 3 publisher checks skipped");
}
if (publisher) {
  ok("the daily publisher sends the digest", /meta_digest\.py/.test(publisher));
  ok("...after the deploy, not before it",
    publisher.indexOf("tools/deploy.mjs") < publisher.indexOf("send_meta_digest()"));
  ok("...and cannot fail the publish by doing so", /check=False/.test(publisher));
}

if (failures.length) {
  console.error(`run-watch: ${failures.length} of ${checked} checks FAILED`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
for (const line of notes) console.log(`  ${line}`);
console.log(`run-watch: ${checked} checks passed`);
