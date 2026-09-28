// Guards the share endpoints: functions/api/share/{index,[code]}.js,
// functions/api/share/img/[code].js, functions/api/share/_lib.js and the
// /share/ page template.
//
//   node tests/run-share-endpoints.mjs [--verbose]
//
// The handlers are called exactly as Pages calls them -- ({request, env, params,
// next}) -- against an in-memory R2 bucket that records every operation, and an
// ASSETS stub that reads the real share/index.html off disk.  That is enough to
// pin the things that would actually hurt:
//
//   * a record that carries something fetchable, an id, or anything from a
//     licence.  The allowlist is the whole privacy story, so it is tested with a
//     deliberately hostile digest and by searching the STORED BYTES.
//   * a PNG that is not a PNG, is the wrong size, is truncated, or is enormous.
//   * a crawler getting a broken image, or a relative og:image.
//   * a crafted code reaching storage.
//
// What it cannot see: Cloudflare's own routing (there is no _routes.json in the
// tree and Pages generates it), real R2 semantics, and whether a browser's
// canvas.toBlob output decodes -- those are facts about the platform, and the
// suite says so rather than pretending.

import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CARD, MAX_CARD_BYTES as CARD_MAX_BYTES } from "../builder/share-card.js";
import { setToShowdown } from "../builder/common.js";
import { showdownFor } from "../share/share-page.js";
import {
  CARD_H, CARD_W, MAX_BODY_BYTES, MAX_CARD_BYTES, MAX_NEW_BYTES_PER_DAY, MAX_RECORD_CHARS,
  TTL_DAYS, TTL_MS, cardDescription, cleanDigest, escapeHtml, fallbackPng, imageKey, newCode,
  normaliseCode, recordKey, usageKey, validatePng,
} from "../functions/api/share/_lib.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const verbose = process.argv.includes("--verbose");
const failures = [];
const notes = [];
let checks = 0;

function ok(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
  else if (verbose) console.log(`  ok  ${message}`);
  return Boolean(condition);
}

function note(message) {
  notes.push(message);
}

const create = await import(pathToFileURL(join(root, "functions/api/share/index.js")).href);
const readCode = await import(pathToFileURL(join(root, "functions/api/share/[code].js")).href);
const readImage = await import(pathToFileURL(join(root, "functions/api/share/img/[code].js")).href);

// --- a real PNG --------------------------------------------------------------
// Built here rather than committed, so the suite can make a 1200x631 one, a
// truncated one and one with a corrupt header without carrying four fixtures.

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function png(width, height, noise = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0;
    p += 1;
    for (let x = 0; x < width; x += 1) {
      raw[p] = noise ? (x * 7 + y * 13 + noise) & 0xff : 0x0a;
      raw[p + 1] = noise ? (x * 3 + y * 5) & 0xff : 0x17;
      raw[p + 2] = 0x10;
      p += 3;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: noise ? 1 : 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CARD_PNG = png(CARD_W, CARD_H);
const BUSY_PNG = png(CARD_W, CARD_H, 1);
const WRONG_SIZE_PNG = png(CARD_W, CARD_H + 1);
const TRUNCATED_PNG = CARD_PNG.subarray(0, CARD_PNG.length - 20);
note(`fixtures: a flat 1200x630 PNG is ${CARD_PNG.length} bytes, a BUSY one (every pixel different, which is what six sprites and eighteen bars look like to deflate) is ${BUSY_PNG.length}, the 1200x631 reject is ${WRONG_SIZE_PNG.length}`);
note(`the byte cap is ${MAX_CARD_BYTES}: ${(MAX_CARD_BYTES / BUSY_PNG.length).toFixed(2)}x the busy card measured here and 1.88x the 319,274-byte worst case stage 1 rendered in a real browser`);

// --- the stubs ---------------------------------------------------------------

function makeBucket() {
  const store = new Map();
  const ops = [];
  const object = (key, entry) => ({
    key,
    size: entry.bytes.length,
    httpEtag: `"${key.slice(-8)}"`,
    httpMetadata: entry.httpMetadata || {},
    customMetadata: entry.customMetadata || {},
    body: entry.bytes,
    async text() { return new TextDecoder().decode(entry.bytes); },
    async arrayBuffer() { return entry.bytes.buffer.slice(entry.bytes.byteOffset, entry.bytes.byteOffset + entry.bytes.byteLength); },
  });
  return {
    store,
    ops,
    async head(key) {
      ops.push(`head ${key}`);
      const entry = store.get(key);
      return entry ? object(key, entry) : null;
    },
    async get(key) {
      ops.push(`get ${key}`);
      const entry = store.get(key);
      return entry ? object(key, entry) : null;
    },
    async put(key, value, options = {}) {
      ops.push(`put ${key}`);
      const bytes = typeof value === "string"
        ? new TextEncoder().encode(value)
        : new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer ? value : new Uint8Array(value));
      store.set(key, { bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), ...options });
      return { key };
    },
    async delete(key) {
      ops.push(`delete ${key}`);
      store.delete(key);
    },
  };
}

const ASSETS = {
  async fetch(url) {
    const path = new URL(url).pathname.replace(/^\/+/, "");
    try {
      return new Response(readFileSync(join(root, path)), { status: 200 });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
};

function envFor(bucket) {
  return { SHARES: bucket, ASSETS, LICENSES: { get() { throw new Error("the share routes must never touch the licence namespace"); } } };
}

const SITE = "https://championsbattledata.com";

function postRequest(body, { origin = SITE, contentType = "application/json", url = `${SITE}/api/share` } = {}) {
  const headers = { "content-type": contentType };
  if (origin) headers.origin = origin;
  return new Request(url, { method: "POST", headers, body });
}

function jsonPost(payload, options = {}) {
  return postRequest(JSON.stringify(payload), options);
}

function getRequest(url, headers = {}) {
  return new Request(url, { method: "GET", headers });
}

// --- the digests -------------------------------------------------------------

const ENTRY = (over = {}) => ({
  name: "Salamence-Mega",
  species: "Salamence",
  form: "Mega Salamence",
  item: "Salamencite",
  ability: "Aerilate",
  nature: "Jolly",
  natureUp: "SPE",
  natureDown: "SPA",
  moves: ["Double-Edge", "Dragon Claw", "Earthquake", "Protect"],
  bonuses: [0, 20, 0, 0, 8, 32],
  stats: { hp: 175, attack: 200, defense: 140, sp_attack: 120, sp_defense: 130, speed: 189 },
  ...over,
});

const TEAM_DIGEST = {
  v: 1,
  kind: "team",
  title: "Doubles ladder team",
  format: "Doubles",
  archetype: "Hyper Offense",
  team: [
    ENTRY(),
    ENTRY({ name: "Froslass", species: "Froslass", form: "Froslass", item: "Focus Sash", ability: "Cursed Body", nature: "Timid", natureUp: "SPE", natureDown: "ATK", moves: ["Icy Wind", "Taunt", "Destiny Bond", "Shadow Ball"] }),
    ENTRY({ name: "Kingambit", species: "Kingambit", form: "Kingambit", item: "Rare Poke Ball Guaranteed Ticket", ability: "Supreme Overlord", nature: "Adamant", natureUp: "ATK", natureDown: "SPA", moves: ["Sucker Punch", "Kowtow Cleave", "Iron Head", "Protect"] }),
    ENTRY({ name: "Farigiraf", species: "Farigiraf", form: "Farigiraf", item: "Electric Seed", ability: "Armor Tail", nature: "Relaxed", natureUp: "DEF", natureDown: "SPE", moves: ["Trick Room", "Psychic Noise", "Helping Hand", "Protect"] }),
    ENTRY({ name: "Milotic", species: "Milotic", form: "Milotic", item: "Leftovers", ability: "Competitive", nature: "Calm", natureUp: "SPD", natureDown: "ATK", moves: ["Muddy Water", "Recover", "Icy Wind", "Protect"] }),
    ENTRY({ name: "Paldean Tauros Combat Breed", species: "Paldean Tauros Combat Breed", form: "Paldean Tauros Combat Breed", item: "Choice Band", ability: "Intimidate", nature: "Jolly", natureUp: "SPE", natureDown: "SPA", moves: ["Close Combat", "Rock Slide", "Throat Chop", "Raging Bull"] }),
  ],
};

const EVAL_DIGEST = {
  v: 1,
  kind: "eval",
  title: "Doubles ladder team",
  format: "Doubles",
  archetype: "Hyper Offense",
  scores: { synergy: 61, offense: 55, defense: 51, speed: 88 },
  topMeta: 20,
  threatCount: 20,
  team: TEAM_DIGEST.team,
  checks: Array.from({ length: 12 }, (_, i) => ({ label: `Field / Weather Consistency ${i + 1}`, severity: i === 3 ? "red" : i === 5 ? "yellow" : "good" })),
  checkCounts: { good: 10, yellow: 1, red: 1 },
  threats: [
    { name: "Flutter Mane", species: "Flutter Mane", form: "Flutter Mane", item: "Choice Specs", score: 80 },
    { name: "Incineroar", species: "Incineroar", form: "Incineroar", item: "Sitrus Berry", score: 71 },
    { name: "Rillaboom", species: "Rillaboom", form: "Rillaboom", item: "Assault Vest", score: 58 },
  ],
};

// 1. the caps are the measured ones, and they are the card renderer's ------------
{
  ok(MAX_CARD_BYTES === CARD_MAX_BYTES, `MAX_CARD_BYTES ${MAX_CARD_BYTES} is share-card.js's ${CARD_MAX_BYTES}`);
  ok(CARD_W === CARD.W && CARD_H === CARD.H, `the accepted card size ${CARD_W}x${CARD_H} is share-card.js's CARD ${CARD.W}x${CARD.H}`);
  ok(MAX_BODY_BYTES >= Math.ceil((MAX_CARD_BYTES * 4) / 3) + MAX_RECORD_CHARS,
    `the body cap ${MAX_BODY_BYTES} clears a base64 card (${Math.ceil((MAX_CARD_BYTES * 4) / 3)}) plus a full record (${MAX_RECORD_CHARS})`);
  ok(TTL_MS === TTL_DAYS * 86400000, "TTL_MS is TTL_DAYS");
  const ceiling = (MAX_NEW_BYTES_PER_DAY * TTL_DAYS) / 1e9;
  ok(ceiling <= 10, `the daily byte budget x the TTL is ${ceiling.toFixed(1)} GB, inside R2's free 10 GB`);
  const teamChars = JSON.stringify(cleanDigest(TEAM_DIGEST)).length;
  const evalChars = JSON.stringify(cleanDigest(EVAL_DIGEST)).length;
  ok(teamChars < MAX_RECORD_CHARS && evalChars < MAX_RECORD_CHARS,
    `a six-slot team digest is ${teamChars} chars and a full evaluation digest ${evalChars}, both under ${MAX_RECORD_CHARS}`);
  note(`record sizes: team ${teamChars} chars, eval ${evalChars} chars (cap ${MAX_RECORD_CHARS})`);
}

// 2. codes ----------------------------------------------------------------------
{
  const code = newCode();
  ok(/^CBS-[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/.test(code), `a new code looks like ${code}`);
  ok(normaliseCode(code.toLowerCase().replace(/-/g, " ")) === code, "a code survives lower case and stray spaces");
  ok(normaliseCode("ABCD-ABCD-ABCD-ABCD") === "CBS-ABCD-ABCD-ABCD-ABCD",
    "a bare 16-character body is accepted and given its prefix back");
  ok(normaliseCode("CBD-ABCD-ABCD-ABCD-ABCD") === "",
    "a SYNC code is NOT a share code: the two prefixes cannot be pasted into each other's box");
  for (const hostile of ["", "../../etc/passwd", "CBS-ABCD", "share/x", null, undefined, "CBS-ABCD-ABCD-ABCD-ABC0", "%2e%2e%2f", "A".repeat(400)]) {
    ok(normaliseCode(hostile) === "", `${JSON.stringify(hostile)} is not a share code`);
  }
  const codes = new Set(Array.from({ length: 400 }, () => newCode()));
  ok(codes.size === 400, "400 codes, no repeat");
}

// 3. validatePng -- the content type is never trusted ---------------------------
{
  ok(validatePng(new Uint8Array(CARD_PNG)).length === CARD_PNG.length, "a real 1200x630 PNG is accepted");
  const rejects = [
    ["an empty body", new Uint8Array(0)],
    ["a 99-byte body", new Uint8Array(99)],
    ["a JPEG", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)])],
    ["an HTML error page saved as .png", Buffer.from(`<!doctype html><html><body>404</body></html>${"x".repeat(200)}`)],
    ["a 1200x631 PNG", new Uint8Array(WRONG_SIZE_PNG)],
    ["a PNG with a corrupt IHDR crc", (() => { const b = Buffer.from(CARD_PNG); b[30] ^= 0xff; return new Uint8Array(b); })()],
    ["a truncated PNG", new Uint8Array(CARD_PNG.subarray(0, CARD_PNG.length - 20))],
    ["a PNG over the byte cap", (() => { const b = Buffer.alloc(MAX_CARD_BYTES + 1); Buffer.from(CARD_PNG).copy(b); return new Uint8Array(b); })()],
    ["a PNG whose magic is one byte off", (() => { const b = Buffer.from(CARD_PNG); b[3] = 0x48; return new Uint8Array(b); })()],
  ];
  for (const [label, bytes] of rejects) {
    let threw = null;
    try { validatePng(bytes); } catch (error) { threw = error; }
    ok(threw && (threw.status === 400 || threw.status === 413), `${label} is refused (${threw ? `${threw.status} ${threw.message}` : "accepted!"})`);
  }
}

// 4. the allowlist: nothing fetchable, nothing identifying ----------------------
{
  const hostile = {
    v: 3,
    kind: "team",
    title: 'Team "><script>alert(1)</script>',
    format: "Ubers",
    archetype: "Balance",
    // everything a producer might carelessly spread into the digest
    id: "team-9f2",
    updated: 1730000000000,
    pristine: false,
    build_source: "auto_build_v427",
    confidence: 0.91,
    licence: { key: "CBD-LIVE-KEY-0001", email: "owner@example.com" },
    email: "owner@example.com",
    machineId: "b1a326ac",
    settings: { topX: 40 },
    syncCode: "CBD-ABCD-ABCD-ABCD-ABCD",
    team: [
      {
        ...ENTRY(),
        sprite: "https://evil.example/x.png",
        icon: "//evil.example/y.png",
        url: "http://evil.example/z",
        image_path: "pokemon_champions_assets/pokemon/Salamence.png",
        id: "slot-1",
        bonuses: [99, -5, 0, 0, 0, 0],
        stats: { hp: 99999, attack: -3, defense: 140, sp_attack: 120, sp_defense: 130, speed: 189 },
        natureUp: "WAT",
        moves: ["A", "B", "C", "D", "E", "F"],
      },
    ],
  };
  const cleaned = cleanDigest(hostile);
  const text = JSON.stringify(cleaned);
  for (const forbidden of ["evil.example", "http", "sprite", "icon", "image_path", "build_source", "confidence",
    "licence", "CBD-LIVE-KEY-0001", "owner@example.com", "machineId", "b1a326ac", "settings", "syncCode",
    "CBD-ABCD-ABCD-ABCD-ABCD", "pristine", '"id"', '"updated"']) {
    ok(!text.includes(forbidden), `the cleaned digest carries no ${forbidden}`);
  }
  ok(cleaned.format === "Doubles", "an unknown format falls back to Doubles rather than passing through");
  ok(cleaned.team[0].moves.length === 4, "a fifth move is dropped");
  ok(cleaned.team[0].bonuses[0] === 32 && cleaned.team[0].bonuses[1] === 0, "Stat Points are clamped to 0..32");
  ok(cleaned.team[0].stats.hp === 999 && cleaned.team[0].stats.attack === 0, "stats are clamped to 0..999");
  ok(cleaned.team[0].natureUp === "", "a nature axis that is not a stat code is dropped");
  ok(cleaned.title.length <= 80 && cleaned.title.includes("<script>"), "the title is kept verbatim (escaping is the page's job, not the store's)");
  ok(Object.keys(cleaned).sort().join(",") === "archetype,format,kind,team,title,v", `a team digest has exactly the allowed keys: ${Object.keys(cleaned).sort().join(",")}`);

  const cleanedEval = cleanDigest({ ...EVAL_DIGEST, id: "x", scores: { synergy: 1e9, offense: -4, defense: "61", speed: null } });
  ok(cleanedEval.scores.synergy === 100 && cleanedEval.scores.offense === 0 && cleanedEval.scores.defense === 61 && cleanedEval.scores.speed === 0,
    "evaluation scores are coerced and clamped to 0..100");
  ok(Object.keys(cleanedEval).sort().join(",") === "archetype,checkCounts,checks,format,kind,scores,team,threatCount,threats,title,topMeta,v",
    `an evaluation digest has exactly the allowed keys: ${Object.keys(cleanedEval).sort().join(",")}`);
  ok(cleanDigest({ ...EVAL_DIGEST, checks: Array.from({ length: 40 }, () => ({ label: "x", severity: "red" })) }).checks.length === 16,
    "at most sixteen checks survive");
  ok(cleanDigest({ ...EVAL_DIGEST, threats: Array.from({ length: 40 }, () => ({ name: "x", score: 50 })) }).threats.length === 6,
    "at most six threats survive");

  let threw = null;
  try { cleanDigest({ kind: "team", team: [] }); } catch (error) { threw = error; }
  ok(threw?.status === 400, "a team digest with no Pokemon is refused");
  threw = null;
  try { cleanDigest(null); } catch (error) { threw = error; }
  ok(threw?.status === 400, "a missing digest is refused");
  threw = null;
  try { cleanDigest({ kind: "team", title: "x".repeat(200), team: [ENTRY({ ability: "y".repeat(9000) })] }); } catch (error) { threw = error; }
  ok(threw === null, "long fields are truncated rather than refused");
  // The biggest digest the allowlist can possibly emit, to show the record cap
  // can never refuse a legitimate share -- it is there to catch a future change
  // to the allowlist, and this is the assertion that would catch it.
  const biggest = cleanDigest({
    kind: "eval",
    title: "t".repeat(200),
    archetype: "a".repeat(200),
    format: "Doubles",
    scores: { synergy: 100, offense: 100, defense: 100, speed: 100 },
    topMeta: 1000,
    threatCount: 100000,
    checks: Array.from({ length: 30 }, () => ({ label: "z".repeat(200), severity: "yellow" })),
    checkCounts: { good: 999, yellow: 999, red: 999 },
    threats: Array.from({ length: 30 }, () => ({ name: "n".repeat(200), species: "s".repeat(200), form: "f".repeat(200), item: "i".repeat(200), score: 100 })),
    team: Array.from({ length: 12 }, () => ENTRY({
      name: "n".repeat(200), species: "s".repeat(200), form: "f".repeat(200), item: "i".repeat(200),
      ability: "b".repeat(200), nature: "Adamant", moves: Array.from({ length: 12 }, () => "m".repeat(200)),
      bonuses: [32, 32, 32, 32, 32, 32], stats: { hp: 999, attack: 999, defense: 999, sp_attack: 999, sp_defense: 999, speed: 999 },
    })),
  });
  const biggestChars = JSON.stringify(biggest).length;
  ok(biggestChars < MAX_RECORD_CHARS,
    `the largest digest the allowlist can emit is ${biggestChars} chars, inside the ${MAX_RECORD_CHARS} cap, so the cap can never refuse a real share`);
  note(`the allowlist's own ceiling is ${biggestChars} chars against a ${MAX_RECORD_CHARS} cap`);
}

// 5. create, then read it back -------------------------------------------------
let liveCode = "";
let liveBucket = null;
{
  const bucket = makeBucket();
  liveBucket = bucket;
  const response = await create.onRequestPost({
    request: jsonPost({ record: TEAM_DIGEST, imageBase64: CARD_PNG.toString("base64") }),
    env: envFor(bucket),
  });
  const body = await response.json();
  ok(response.status === 201, `POST /api/share creates a share (${response.status})`);
  ok(/^CBS-[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/.test(body.code || ""), `the code comes back: ${body.code}`);
  liveCode = body.code;
  ok(body.pageUrl === `${SITE}/api/share/${liveCode}`, `pageUrl is absolute: ${body.pageUrl}`);
  ok(body.imageUrl === `${SITE}/api/share/img/${liveCode}`, `imageUrl is absolute: ${body.imageUrl}`);
  ok(body.recordUrl === `${SITE}/api/share/${liveCode}?format=json`, `recordUrl asks for JSON explicitly: ${body.recordUrl}`);
  ok(body.bytes === CARD_PNG.length, `the stored byte count is the real one (${body.bytes})`);
  ok(Math.abs(body.expiresAt - body.createdAt - TTL_MS) < 5, `the share expires ${TTL_DAYS} days after it was made`);
  ok(response.headers.get("cache-control") === "no-store", "a create is never cached");

  const keys = [...bucket.store.keys()];
  ok(keys.some((key) => /^share\/[0-9a-f]{64}\.png$/.test(key)), "the PNG is stored under a hash of the code");
  ok(keys.some((key) => /^share\/[0-9a-f]{64}\.json$/.test(key)), "the record is stored under the same hash");
  ok(!keys.some((key) => key.includes(liveCode)), "no stored KEY contains the code, so listing the bucket reveals nothing usable");
  const storedRecord = new TextDecoder().decode(bucket.store.get(await recordKey(liveCode)).bytes);
  for (const forbidden of ["origin", "content-type", "127.0.0.1", "licence", "@", "user-agent", "cf-connecting-ip"]) {
    ok(!storedRecord.toLowerCase().includes(forbidden), `the stored record carries no ${forbidden}`);
  }
  note(`stored record is ${storedRecord.length} bytes; stored PNG is ${bucket.store.get(await imageKey(liveCode)).bytes.length} bytes`);
  ok(bucket.store.get(await imageKey(liveCode)).httpMetadata?.contentType === "image/png", "the stored object declares image/png");
  ok(Number(bucket.store.get(await imageKey(liveCode)).customMetadata?.expiresAt) > Date.now(), "the image object carries its own expiry, so serving a card costs one read");

  // the record, as JSON
  const recordResponse = await readCode.onRequestGet({
    request: getRequest(`${SITE}/api/share/${liveCode}?format=json`),
    params: { code: liveCode },
    env: envFor(bucket),
  });
  const record = await recordResponse.json();
  ok(recordResponse.status === 200, "GET ?format=json returns the record");
  ok(recordResponse.headers.get("content-type").includes("application/json"), "the record is JSON");
  ok(recordResponse.headers.get("cache-control") === "public, max-age=300", "the record is cached briefly");
  ok(record.digest.team.length === 6 && record.digest.title === TEAM_DIGEST.title, "the digest round-trips");
  ok(record.digest.team[2].item === "Rare Poke Ball Guaranteed Ticket", "the longest real item survives the round trip");
  ok(record.code === liveCode && record.format === "cbd-share/1", "the record names its own code and format");

  // ONE URL, ONE REPRESENTATION.  Cloudflare keys its cache on the URL and
  // ignores Vary except for Accept-Encoding, so if the Accept header chose the
  // representation, a cached JSON body would eventually be served to a crawler
  // (no card at all) or a cached page to the Companion.  The query string is the
  // only switch, and this is the assertion that keeps it that way.
  const acceptResponse = await readCode.onRequestGet({
    request: getRequest(`${SITE}/api/share/${liveCode}`, { accept: "application/json" }),
    params: { code: liveCode },
    env: envFor(bucket),
  });
  ok(acceptResponse.headers.get("content-type").includes("text/html"),
    "Accept: application/json does NOT switch representation -- the URL decides, so a shared cache can never serve the wrong one");
  const htmlParam = await readCode.onRequestGet({
    request: getRequest(`${SITE}/api/share/${liveCode}?format=html`, { accept: "application/json" }),
    params: { code: liveCode },
    env: envFor(bucket),
  });
  ok(htmlParam.headers.get("content-type").includes("text/html"), "?format=html is the page too");
}

// 6. the page a crawler lands on ------------------------------------------------
{
  const response = await readCode.onRequestGet({
    request: getRequest(`${SITE}/api/share/${liveCode}`, { accept: "*/*", "user-agent": "facebookexternalhit/1.1" }),
    params: { code: liveCode },
    env: envFor(liveBucket),
  });
  const html = await response.text();
  ok(response.status === 200, `an unfurler asking for */* gets the page (${response.status})`);
  ok(response.headers.get("content-type").includes("text/html"), "the page is HTML");
  const tag = (name, attr = "property") => html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1] ?? "";
  const image = tag("og:image");
  ok(image === `${SITE}/api/share/img/${liveCode}`, `og:image is ABSOLUTE: ${image}`);
  ok(/^https:\/\//.test(image), "og:image is https");
  ok(tag("og:image:width") === "1200" && tag("og:image:height") === "630", "og:image:width/height are 1200x630");
  ok(tag("og:image:type") === "image/png", "og:image:type is image/png");
  ok(tag("og:url") === `${SITE}/api/share/${liveCode}`, `og:url is absolute: ${tag("og:url")}`);
  ok(tag("og:type") === "website" && tag("og:site_name") === "Pokemon Champions Battle Data", "og:type and og:site_name match the other pages");
  ok(tag("og:title").includes("Doubles ladder team"), `og:title carries the team's name: ${tag("og:title")}`);
  ok(tag("og:description").includes("Salamence-Mega") && tag("og:description").includes("Doubles"), `og:description names the team: ${tag("og:description")}`);
  ok(tag("twitter:card", "name") === "summary_large_image", "twitter:card is summary_large_image");
  ok(tag("twitter:image", "name") === image, "twitter:image is the same absolute URL");
  ok(new RegExp(`<link rel="canonical" href="${SITE}/api/share/${liveCode}"`).test(html), "the canonical URL is absolute");
  ok(tag("robots", "name") === "noindex, follow", "a share page is not offered to the search index");
  ok(html.includes('<script type="application/json" id="shareData">'), "the record is inlined, so the page needs no second request");
  ok(html.includes("<noscript>") && html.includes(`<img src="${image}"`), "a reader with no JavaScript still gets the picture");
  ok(!html.includes("<!--SHARE:META-->\n  <title>Shared team"), "the default head block was replaced, not appended");
  ok((html.match(/<title>/g) || []).length === 1, "exactly one <title> survives the injection");
  ok((html.match(/og:image"/g) || []).length === 1, "exactly one og:image survives the injection");
  ok(html.includes('src="/share/share-page.js"'), "the page still loads its script from an absolute path, so it works at either mount point");
  note(`the injected page is ${html.length} bytes`);

  // HEAD is the same handler
  const head = await readCode.onRequestHead({
    request: new Request(`${SITE}/api/share/${liveCode}`, { method: "HEAD" }),
    params: { code: liveCode },
    env: envFor(liveBucket),
  });
  ok(head.status === 200, "HEAD works (some unfurlers ask first)");
}

// 7. a hostile title cannot break out of the head ------------------------------
{
  const bucket = makeBucket();
  const created = await create.onRequestPost({
    request: jsonPost({
      record: { ...TEAM_DIGEST, title: '"><script>alert(1)</script>', archetype: "</title><img src=x onerror=alert(2)>" },
      imageBase64: CARD_PNG.toString("base64"),
    }),
    env: envFor(bucket),
  });
  const { code } = await created.json();
  const response = await readCode.onRequestGet({
    request: getRequest(`${SITE}/api/share/${code}`),
    params: { code },
    env: envFor(bucket),
  });
  const html = await response.text();
  ok(!html.includes("<script>alert(1)"), "the hostile title is not executable in the page");
  ok(!html.includes("<img src=x"), "the hostile archetype cannot become a tag (its angle brackets are gone everywhere, including inside the inlined JSON)");
  ok(!html.includes("</title><img"), "an injected </title> cannot end the title early");
  const BACKSLASH = String.fromCharCode(92);
  ok(html.includes(`${BACKSLASH}u003cimg src=x`), "and inside the JSON block its angle brackets are escaped rather than dropped");
  ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the title is escaped and still readable");
  ok((html.match(/<\/title>/g) || []).length === 1, "exactly one </title>");
  ok(escapeHtml(`<a href="x">&'`) === "&lt;a href=&quot;x&quot;&gt;&amp;&#39;", "escapeHtml covers < > \" ' &");
}

// 8. serve the image -----------------------------------------------------------
{
  const response = await readImage.onRequestGet({ params: { code: liveCode }, env: envFor(liveBucket) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  ok(response.status === 200, "the card is served");
  ok(response.headers.get("content-type") === "image/png", "with content-type image/png");
  ok(response.headers.get("cache-control") === "public, max-age=31536000, immutable", `and an immutable year-long cache (${response.headers.get("cache-control")})`);
  ok(response.headers.get("x-share-card") === "card", "and marked as a real card");
  ok(Boolean(response.headers.get("etag")), "with an etag");
  ok(bytes.length === CARD_PNG.length && bytes[1] === 0x50, `the bytes are the PNG that was uploaded (${bytes.length})`);
  ok(validatePng(bytes).length === CARD_PNG.length, "what comes out still validates as a 1200x630 PNG");
}

// 9. an unknown, malformed or expired code never yields a broken image ----------
{
  const bucket = makeBucket();
  for (const [label, code] of [["unknown", newCode()], ["malformed", "../../secret"], ["empty", ""]]) {
    const response = await readImage.onRequestGet({ params: { code }, env: envFor(bucket) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    ok(response.status === 200, `a ${label} code still answers 200 (a crawler must never get a broken image)`);
    ok(response.headers.get("content-type") === "image/png", `a ${label} code answers with image/png`);
    ok(response.headers.get("x-share-card") === "fallback", `a ${label} code is marked as the fallback card`);
    ok(response.headers.get("cache-control") === "public, max-age=300", `a ${label} code is cached only briefly`);
    let valid = true;
    try { validatePng(bytes); } catch { valid = false; }
    ok(valid, `the fallback is itself a valid 1200x630 PNG (${bytes.length} bytes)`);
  }
  ok(fallbackPng().length === 190, `the built-in fallback card is ${fallbackPng().length} bytes, small enough to be a literal`);
  const malformed = makeBucket();
  await readImage.onRequestGet({ params: { code: "../../secret" }, env: envFor(malformed) });
  ok(malformed.ops.length === 0, "a malformed code reaches storage not at all");
}

// 10. expiry -------------------------------------------------------------------
{
  const bucket = makeBucket();
  const created = await create.onRequestPost({
    request: jsonPost({ record: EVAL_DIGEST, imageBase64: CARD_PNG.toString("base64") }),
    env: envFor(bucket),
  });
  const { code } = await created.json();
  const key = await recordKey(code);
  const record = JSON.parse(new TextDecoder().decode(bucket.store.get(key).bytes));
  record.expiresAt = Date.now() - 1000;
  bucket.store.get(key).bytes = new TextEncoder().encode(JSON.stringify(record));
  bucket.store.get(await imageKey(code)).customMetadata.expiresAt = String(Date.now() - 1000);

  const asJson = await readCode.onRequestGet({ request: getRequest(`${SITE}/api/share/${code}?format=json`), params: { code }, env: envFor(bucket) });
  ok(asJson.status === 410, `an expired record is 410 Gone for the API (${asJson.status})`);
  const asPage = await readCode.onRequestGet({ request: getRequest(`${SITE}/api/share/${code}`), params: { code }, env: envFor(bucket) });
  const html = await asPage.text();
  ok(asPage.status === 410, "and 410 for the page");
  ok(html.includes("expired"), "the page says so in words");
  ok(html.includes("assets/tool/team-builder.webp"), "an expired page falls back to a real site image rather than a dead card URL");
  // ...and it must DESCRIBE that file, not the card's shape.  Announcing a WEBP
  // as a 1200x630 image/png is three claims a crawler can check and find false.
  {
    const tag = (name) => html.match(new RegExp(`<meta property="${name}" content="([^"]*)"`))?.[1] ?? "";
    const asset = readFileSync(join(root, "assets/tool/team-builder.webp"));
    ok(asset.subarray(0, 4).toString("ascii") === "RIFF" && asset.subarray(8, 12).toString("ascii") === "WEBP",
      "the fallback asset really is a WEBP on disk");
    const vp8 = asset.subarray(12, 16).toString("ascii");
    ok(vp8 === "VP8 ", `the fallback asset is a lossy VP8 chunk (${JSON.stringify(vp8)})`);
    const realW = asset.readUInt16LE(26) & 0x3fff;
    const realH = asset.readUInt16LE(28) & 0x3fff;
    ok(tag("og:image:type") === "image/webp", `a miss declares image/webp, not PNG (${tag("og:image:type")})`);
    ok(Number(tag("og:image:width")) === realW && Number(tag("og:image:height")) === realH,
      `a miss declares the asset's REAL size ${realW}x${realH} (declared ${tag("og:image:width")}x${tag("og:image:height")})`);
    note(`the miss image is ${realW}x${realH} (${(realW / realH).toFixed(3)}:1, ${asset.length} bytes)`);
  }
  const asImage = await readImage.onRequestGet({ params: { code }, env: envFor(bucket) });
  ok(asImage.headers.get("x-share-card-reason") === "expired", "the card route knows it expired without reading the record");
}

// 11. unknown code, as a page and as JSON --------------------------------------
{
  const bucket = makeBucket();
  const code = newCode();
  const asJson = await readCode.onRequestGet({ request: getRequest(`${SITE}/api/share/${code}?format=json`), params: { code }, env: envFor(bucket) });
  ok(asJson.status === 404, "an unknown code is 404 for the API");
  ok((await asJson.json()).error === "Unknown share code.", "with a plain message");
  const asPage = await readCode.onRequestGet({ request: getRequest(`${SITE}/api/share/${code}`), params: { code }, env: envFor(bucket) });
  const html = await asPage.text();
  ok(asPage.status === 404, "and 404 for the page");
  ok(html.includes("does not exist"), "which says so");
  ok(asPage.headers.get("cache-control") === "public, max-age=300", "a miss is cached only briefly");
  ok(html.includes('property="og:image"'), "even a miss carries og tags, so a dead link unfurls to something");
  ok(/<title>That share link does not exist - Pokemon Champions<\/title>/.test(html),
    `a miss names itself in the tab title rather than calling itself a Team: ${html.match(/<title>([^<]*)</)?.[1]}`);
  ok(!html.includes("has expired"), "and an unknown code is not described as expired");
}

// 12. a crafted code never reaches storage ------------------------------------
{
  const bucket = makeBucket();
  const asJson = await readCode.onRequestGet({
    request: getRequest(`${SITE}/api/share/..%2F..%2Fshare%2Fsecret?format=json`),
    params: { code: "../../share/secret" },
    env: envFor(bucket),
  });
  ok(asJson.status === 400, `a crafted code is 400 (${asJson.status})`);
  ok(bucket.ops.length === 0, "and storage was never touched");

  const asPage = await readCode.onRequestGet({
    request: getRequest(`${SITE}/api/share/%00`),
    params: { code: "\u0000" },
    env: envFor(bucket),
  });
  ok(asPage.status === 404 && bucket.ops.length === 0, "a NUL byte is a 404 page and still no storage call");
}

// 13. the fallthrough that makes the prettier /share/<code> route possible ------
{
  const bucket = makeBucket();
  let called = false;
  const response = await readCode.onRequestGet({
    request: getRequest(`${SITE}/share/share-page.js`),
    params: { code: "share-page.js" },
    env: envFor(bucket),
    next: async () => { called = true; return new Response("the static asset", { status: 200 }); },
  });
  ok(called && (await response.text()) === "the static asset",
    "mounted outside /api, a path that is not a code falls through to the static asset (so /share/share-page.js keeps working)");
  ok(bucket.ops.length === 0, "and that fallthrough touches no storage");
  const onApi = await readCode.onRequestGet({
    request: getRequest(`${SITE}/api/share/nonsense?format=json`),
    params: { code: "nonsense" },
    env: envFor(bucket),
    next: async () => new Response("must not be called", { status: 200 }),
  });
  ok(onApi.status === 400, "on /api/share a bad code is still a 400 and never falls through");
}

// 14. refusing the bad create ---------------------------------------------------
{
  const bucket = makeBucket();
  const env = envFor(bucket);
  const cases = [
    ["a too-large PNG", { record: TEAM_DIGEST, imageBase64: Buffer.alloc(MAX_CARD_BYTES + 32).toString("base64") }, 413],
    ["a PNG that is not a PNG", { record: TEAM_DIGEST, imageBase64: Buffer.from(`<!doctype html>${"x".repeat(400)}`).toString("base64") }, 400],
    ["a 1200x631 PNG", { record: TEAM_DIGEST, imageBase64: WRONG_SIZE_PNG.toString("base64") }, 400],
    ["a truncated PNG", { record: TEAM_DIGEST, imageBase64: TRUNCATED_PNG.toString("base64") }, 400],
    ["a malformed record", { record: { kind: "team", team: "not a list" }, imageBase64: CARD_PNG.toString("base64") }, 400],
    ["no record at all", { imageBase64: CARD_PNG.toString("base64") }, 400],
    ["no image at all", { record: TEAM_DIGEST }, 400],
    ["base64 that is not base64", { record: TEAM_DIGEST, imageBase64: "!!!! not base64 !!!!" }, 400],
    ["a record that is not an object", { record: "TEAM", imageBase64: CARD_PNG.toString("base64") }, 400],
  ];
  for (const [label, payload, status] of cases) {
    const response = await create.onRequestPost({ request: jsonPost(payload), env });
    const body = await response.json();
    ok(response.status === status, `${label} is refused with ${status} (got ${response.status}: ${body.error})`);
  }
  const notJson = await create.onRequestPost({ request: postRequest("<xml/>", {}), env });
  ok((await notJson.json()) && notJson.status === 400, "a body that is not JSON is refused");

  // A body of exactly `null` parses, and reading `.record` off it used to throw
  // a TypeError whose internal message went back to the caller verbatim.  The
  // refusal must be the endpoint's own sentence, not a JavaScript one.
  for (const [label, raw] of [["null", "null"], ["a bare number", "7"], ["a bare string", '"hello"'], ["a top-level array", "[]"]]) {
    const response = await create.onRequestPost({ request: postRequest(raw, {}), env });
    const body = await response.json();
    ok(response.status === 400, `a body that is ${label} is refused with 400 (got ${response.status})`);
    ok(!/Cannot read propert|undefined is not|TypeError|\bof null\b/.test(String(body.error)),
      `...and the message is the endpoint's own, not a JavaScript error: ${JSON.stringify(body.error)}`);
  }
  ok(bucket.store.size === 0, "not one refused create stored anything");

  // The real guarantee: a body over the cap is refused however it arrives.
  const oversized = await create.onRequestPost({
    request: jsonPost({ record: TEAM_DIGEST, filler: "x".repeat(MAX_BODY_BYTES + 100), imageBase64: CARD_PNG.toString("base64") }),
    env,
  });
  ok(oversized.status === 413, `a body over the ${MAX_BODY_BYTES}-character cap is refused (${oversized.status})`);
  // And the cheaper guard in front of it, when the runtime lets a caller declare
  // a length (undici drops the header on a constructed Request, so this is a
  // probe rather than an assertion).
  const declared = new Request(`${SITE}/api/share`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SITE, "content-length": String(MAX_BODY_BYTES + 1) },
    body: JSON.stringify({ record: TEAM_DIGEST, imageBase64: CARD_PNG.toString("base64") }),
  });
  if (declared.headers.get("content-length")) {
    const early = await create.onRequestPost({ request: declared, env });
    ok(early.status === 413, "a declared content-length over the body cap is refused before the body is read");
  } else {
    note("this runtime strips a hand-set content-length, so the pre-read size guard is unexercised here; the body-length guard above covers it");
  }
  ok(bucket.store.size === 0, "and still nothing stored");
}

// 15. the multipart path (what the browser posts) -------------------------------
{
  const bucket = makeBucket();
  const form = new FormData();
  form.set("record", JSON.stringify(EVAL_DIGEST));
  form.set("image", new Blob([CARD_PNG], { type: "image/png" }), "card.png");
  const response = await create.onRequestPost({
    request: new Request(`${SITE}/api/share`, { method: "POST", headers: { origin: SITE }, body: form }),
    env: envFor(bucket),
  });
  const body = await response.json();
  ok(response.status === 201, `multipart/form-data creates a share too (${response.status})`);
  ok(body.kind === "eval", "and the evaluation kind survives");
  const page = await readCode.onRequestGet({ request: getRequest(`${SITE}/api/share/${body.code}`), params: { code: body.code }, env: envFor(bucket) });
  const html = await page.text();
  ok(html.includes("Synergy 61"), `an evaluation's og:description leads with the scores: ${html.match(/og:description" content="([^"]*)"/)?.[1]}`);
  ok(cardDescription(cleanDigest(EVAL_DIGEST)).startsWith("Synergy 61 - Offense 55 - Defense 51 - Speed 88"), "the evaluation description is the four scores");

  const noImage = new FormData();
  noImage.set("record", JSON.stringify(TEAM_DIGEST));
  const refused = await create.onRequestPost({
    request: new Request(`${SITE}/api/share`, { method: "POST", headers: { origin: SITE }, body: noImage }),
    env: envFor(bucket),
  });
  ok(refused.status === 400, "multipart with no image field is refused");
}

// 15b. a realistic, busy card goes through untouched --------------------------
{
  const bucket = makeBucket();
  const response = await create.onRequestPost({
    request: jsonPost({ record: TEAM_DIGEST, imageBase64: BUSY_PNG.toString("base64") }),
    env: envFor(bucket),
  });
  const body = await response.json();
  ok(response.status === 201, `a ${BUSY_PNG.length}-byte card (the realistic size) is accepted`);
  ok(body.bytes === BUSY_PNG.length, "and its byte count is reported exactly");
  const served = await readImage.onRequestGet({ params: { code: body.code }, env: envFor(bucket) });
  const bytes = new Uint8Array(await served.arrayBuffer());
  ok(bytes.length === BUSY_PNG.length && Buffer.from(bytes).equals(BUSY_PNG), "and it comes back byte for byte");
}

// 16. abuse: what bounds growth ------------------------------------------------
{
  // a repeat of the same share is the same share
  const bucket = makeBucket();
  const payload = { record: TEAM_DIGEST, imageBase64: CARD_PNG.toString("base64") };
  const first = await (await create.onRequestPost({ request: jsonPost(payload), env: envFor(bucket) })).json();
  const objects = bucket.store.size;
  const second = await create.onRequestPost({ request: jsonPost(payload), env: envFor(bucket) });
  const secondBody = await second.json();
  ok(second.status === 200 && secondBody.code === first.code, `pressing Share twice returns the same code (${secondBody.code})`);
  ok(secondBody.reused === true, "and says so");
  ok(bucket.store.size === objects, "and stores nothing new");

  // the day's byte budget
  const budget = makeBucket();
  await budget.put(usageKey(), JSON.stringify({ bytes: MAX_NEW_BYTES_PER_DAY - 10, count: 3 }));
  const refused = await create.onRequestPost({
    request: jsonPost({ record: TEAM_DIGEST, imageBase64: CARD_PNG.toString("base64") }),
    env: envFor(budget),
  });
  ok(refused.status === 429, `a day that has spent its byte budget refuses with 429 (${refused.status})`);
  ok(!(await budget.head(await recordKey("CBS-AAAA-AAAA-AAAA-AAAA"))) && budget.store.size === 1, "and nothing was written");
  const counted = makeBucket();
  await create.onRequestPost({ request: jsonPost({ record: TEAM_DIGEST, imageBase64: CARD_PNG.toString("base64") }), env: envFor(counted) });
  const usage = JSON.parse(new TextDecoder().decode(counted.store.get(usageKey()).bytes));
  ok(usage.bytes === CARD_PNG.length && usage.count === 1, `the day's usage counts the real bytes (${usage.bytes})`);

  // a foreign page cannot drive a visitor's browser into minting shares
  const foreign = makeBucket();
  const blocked = await create.onRequestPost({
    request: jsonPost({ record: TEAM_DIGEST, imageBase64: CARD_PNG.toString("base64") }, { origin: "https://evil.example" }),
    env: envFor(foreign),
  });
  ok(blocked.status === 403, `a cross-origin create is refused (${blocked.status})`);
  ok(foreign.ops.length === 0, "and never reaches storage");
  const noOrigin = await create.onRequestPost({
    request: jsonPost({ record: TEAM_DIGEST, imageBase64: CARD_PNG.toString("base64") }, { origin: "" }),
    env: envFor(makeBucket()),
  });
  ok(noOrigin.status === 201, "the Companion, which sends no Origin at all, is unaffected");

  // there is no writer
  const writable = makeBucket();
  for (const method of ["onRequestPut", "onRequestPatch", "onRequestDelete"]) {
    const response = await readCode[method]({ request: getRequest(`${SITE}/api/share/${liveCode}`), params: { code: liveCode }, env: envFor(writable) });
    ok(response.status === 405, `${method} is refused: a pasted link's card can never be swapped`);
  }
  ok(typeof create.onRequestGet !== "function" && typeof create.onRequestPut !== "function", "the create route answers POST and nothing else");
}

// 17. no binding, no pretending ------------------------------------------------
{
  const env = { ASSETS };
  ok((await create.onRequestPost({ request: jsonPost({ record: TEAM_DIGEST, imageBase64: CARD_PNG.toString("base64") }), env })).status === 503,
    "without the R2 binding a create is 503, exactly as sync is without its namespace");
  ok((await readCode.onRequestGet({ request: getRequest(`${SITE}/api/share/${liveCode}?format=json`), params: { code: liveCode }, env })).status === 503,
    "and a read is 503");
  const unconfiguredPage = await readCode.onRequestGet({ request: getRequest(`${SITE}/api/share/${liveCode}`), params: { code: liveCode }, env });
  ok(unconfiguredPage.status === 503 && unconfiguredPage.headers.get("content-type").includes("text/html"),
    "while a person or a crawler gets a page saying so, not a naked JSON error");
  ok((await unconfiguredPage.text()).includes("not switched on yet"), "which says what is wrong");
  const image = await readImage.onRequestGet({ params: { code: liveCode }, env });
  ok(image.status === 200 && image.headers.get("x-share-card-reason") === "not-configured",
    "but the image route still answers with a real PNG, so nothing unfurls broken while the bucket is being created");
}

// 18. absolute URLs on other hosts ---------------------------------------------
{
  const bucket = makeBucket();
  const local = await create.onRequestPost({
    request: jsonPost({ record: TEAM_DIGEST, imageBase64: CARD_PNG.toString("base64") },
      { origin: "http://127.0.0.1:8790", url: "http://127.0.0.1:8790/api/share" }),
    env: envFor(bucket),
  });
  const body = await local.json();
  ok(body.pageUrl.startsWith("http://127.0.0.1:8790/api/share/"), `the dev server keeps its own absolute origin: ${body.pageUrl}`);
  const preview = await create.onRequestPost({
    request: jsonPost({ record: TEAM_DIGEST, imageBase64: CARD_PNG.toString("base64") },
      { origin: "https://abc123.pokemonbattledata.pages.dev", url: "https://abc123.pokemonbattledata.pages.dev/api/share" }),
    env: envFor(makeBucket()),
  });
  const previewBody = await preview.json();
  ok(previewBody.pageUrl.startsWith("https://abc123.pokemonbattledata.pages.dev/api/share/"), `a preview deployment keeps its own origin: ${previewBody.pageUrl}`);
  const wwwPage = await readCode.onRequestGet({
    request: getRequest(`https://www.championsbattledata.com/api/share/${liveCode}`),
    params: { code: liveCode },
    env: envFor(liveBucket),
  });
  const html = await wwwPage.text();
  ok(html.includes(`content="${SITE}/api/share/img/${liveCode}"`), "www. collapses onto the canonical host, so one card has one URL");
}

// 19. the template, and the page that does not need it -------------------------
{
  const template = readFileSync(join(root, "share/index.html"), "utf8");
  for (const marker of ["<!--SHARE:META-->", "<!--/SHARE:META-->", "<!--SHARE:DATA-->", "<!--/SHARE:DATA-->", "<!--SHARE:NOSCRIPT-->", "<!--/SHARE:NOSCRIPT-->"]) {
    ok(template.includes(marker), `share/index.html carries the ${marker} marker`);
  }
  ok(/<link rel="canonical" href="https:\/\/championsbattledata\.com\/share\/"/.test(template), "the bare /share/ page has its own absolute canonical");
  ok(template.includes('content="https://championsbattledata.com/assets/tool/team-builder.webp"'), "and a real absolute fallback og:image");
  ok(template.includes('class="page-share"'), "every style rule is scoped under .page-share");
  ok(!/<link[^>]*builder\.css/.test(template), "the page does not pull 67 KB of builder CSS for six colours");
  ok(template.includes('src="/share/share-page.js"') && template.includes('href="/styles.css"'), "its script and stylesheet are root-absolute, so the same HTML works at /share/ and at /api/share/<code>");

  // with no template the page still stands up
  const brokenAssets = { async fetch() { return new Response("nope", { status: 404 }); } };
  const response = await readCode.onRequestGet({
    request: getRequest(`${SITE}/api/share/${liveCode}`),
    params: { code: liveCode },
    env: { SHARES: liveBucket, ASSETS: brokenAssets },
  });
  const html = await response.text();
  ok(response.status === 200 && html.startsWith("<!doctype html>"), "a missing template degrades to a self-contained page, not a 500");
  ok(html.includes(`content="${SITE}/api/share/img/${liveCode}"`), "and it still carries the absolute og:image");
  const throwingAssets = { async fetch() { throw new Error("ASSETS is unavailable"); } };
  const thrown = await readCode.onRequestGet({
    request: getRequest(`${SITE}/api/share/${liveCode}`),
    params: { code: liveCode },
    env: { SHARES: liveBucket, ASSETS: throwingAssets },
  });
  ok(thrown.status === 200, "and an ASSETS binding that throws does not take the page down");
}

// 20. the page's Showdown paste is the builder's own format ---------------------
{
  const data = { displayName: (species, form) => (form && form !== species ? form : species) };
  for (const entry of cleanDigest(TEAM_DIGEST).team) {
    const set = {
      species: entry.species, form: entry.form, item: entry.item, ability: entry.ability,
      nature: entry.nature, bonuses: entry.bonuses, moves: entry.moves,
    };
    const mine = showdownFor({ ...entry, name: data.displayName(entry.species, entry.form) });
    const theirs = setToShowdown(set, data);
    ok(mine === theirs, `the share page's paste for ${entry.species} is byte-identical to builder/common.js setToShowdown`);
  }
  const withNoPoints = showdownFor({ name: "Milotic", species: "Milotic", item: "", ability: "", nature: "", moves: [], bonuses: [0, 0, 0, 0, 0, 0] });
  ok(!withNoPoints.includes("EVs:") && withNoPoints.includes("Serious Nature"), "a blank spread writes no EVs line and the neutral nature");
}

// 21. deploy safety -------------------------------------------------------------
{
  const deploy = readFileSync(join(root, "tools/deploy.mjs"), "utf8");
  const devOnly = deploy.match(/const devOnlyPaths = \[([^\]]*)\]/)?.[1] || "";
  ok(!devOnly.includes("share"), `deploy.mjs's devOnlyPaths does not exclude /share/: ${devOnly.trim()}`);
  ok(devOnly.includes('"tests"'), "and tests/ is still excluded, so this suite is never deployed");
  ok(deploy.includes('rootIgnored = new Set(["_worker.js", "_redirects", "_headers", "_routes.json", "functions"])'),
    "functions/ is not counted against the 20,000-file Pages cap, so the four new Function files cost nothing");
  const redirects = readFileSync(join(root, "_redirects"), "utf8");
  ok(!/^\/share/m.test(redirects), "no _redirects rule shadows /share/");
  const dynamic = redirects.split("\n").filter((line) => /^\/\S*\*/.test(line)).length;
  ok(dynamic === 0, `this feature adds no dynamic redirect; the file still has ${dynamic} of the 100 Cloudflare honours`);
  const wrangler = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  const parsed = JSON.parse(wrangler.replace(/^[ \t]*\/\/[^\n]*/gm, ""));
  ok(parsed.kv_namespaces?.[0]?.binding === "LICENSES" && parsed.kv_namespaces[0].id === "88038110bbeb4f709e4cf614f67acc3d",
    "the LICENSES KV binding is untouched");
  ok(Array.isArray(parsed.r2_buckets), "wrangler.jsonc has an r2_buckets array");
  ok(parsed.r2_buckets.length === 0, "which is EMPTY on purpose: this worktree deploys itself every few hours, and a binding naming a bucket that does not exist yet would go live before anyone could create it");
  ok(wrangler.includes("wrangler r2 bucket create cbd-shares") && wrangler.includes('"binding": "SHARES", "bucket_name": "cbd-shares"'),
    "and the two steps to switch it on are written down beside it");
  ok(parsed.compatibility_flags?.includes("nodejs_compat"), "nodejs_compat is still set");
}

// 22. the source itself: no way out of the Function -----------------------------
//
// The worst mistake available here is a record whose value ends up in a fetch --
// that turns the card pipeline into an open proxy.  The allowlist is the first
// guard; this is the second, and it reads the shipped source rather than
// trusting a comment.
{
  const sources = [
    ["functions/api/share/_lib.js", readFileSync(join(root, "functions/api/share/_lib.js"), "utf8")],
    ["functions/api/share/index.js", readFileSync(join(root, "functions/api/share/index.js"), "utf8")],
    ["functions/api/share/[code].js", readFileSync(join(root, "functions/api/share/[code].js"), "utf8")],
    ["functions/api/share/img/[code].js", readFileSync(join(root, "functions/api/share/img/[code].js"), "utf8")],
  ];
  let fetches = 0;
  for (const [name, source] of sources) {
    const calls = source.match(/[\w.]*fetch\s*\(/g) || [];
    fetches += calls.length;
    ok(!/console\.(log|info|warn|error)/.test(source), `${name} logs nothing, so no request data reaches a log line`);
    ok(!/LICENSES|SYNC|licen[cs]e/i.test(source.replace(/^\s*[/*].*$/gm, "")), `${name} never touches the licence or sync bindings`);
  }
  ok(fetches === 1, `the whole feature makes exactly ${fetches} fetch call`);
  const pageSource = sources[2][1];
  ok(/const TEMPLATE_PATH = "\/share\/index\.html";/.test(pageSource), "and its path is a literal constant");
  ok(/env\.ASSETS\.fetch\(new URL\(TEMPLATE_PATH, request\.url\)/.test(pageSource),
    "resolved against this site's own origin -- never a string out of a request body");
  // and the routes never widen CORS on the write path
  ok(!/access-control-allow-origin/i.test(sources[1][1]), "the create route sends no CORS header, so a third-party page cannot read its answer");
}

for (const line of notes) console.log(`note: ${line}`);
for (const failure of failures.slice(0, 40)) console.log(`FAILED ${failure}`);
console.log(`\n${checks} checks, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
