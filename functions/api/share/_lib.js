// Shared helpers for the share endpoints: codes, keys, validation, HTML.
//
// A share is NOT a sync record.  Sync holds one mutable, revision-checked
// document that two devices write to, and its code is a credential.  A share is
// a TINY, IMMUTABLE, PUBLIC, READ-ONLY snapshot: the digest a card was drawn
// from, plus the PNG that was drawn from it.  It reuses sync's code shape and
// its "store under a hash of the code" scheme (functions/api/sync/_lib.js:13-41)
// and nothing else.
//
//   share/<sha256("cbd-share:" + code)>.json   the digest record
//   share/<sha256("cbd-share:" + code)>.png    the card bytes
//   dedupe/<sha256(record) + sha256(image)>    -> the code, so pressing Share
//                                                 twice does not store twice
//   meta/usage-<YYYY-MM-DD>                    the day's byte budget
//
// Everything lives in ONE R2 bucket (binding SHARES).  Not KV: the free KV
// allowance is 1,000 writes a day for the whole account and the licence and
// sync endpoints already spend from it (README.md:576-578), while R2's free
// tier is 10 GB with 1,000,000 Class A operations a month.
//
// The Function NEVER rasterises anything and NEVER fetches a URL that came out
// of a request body.  The client that already has a text renderer draws the PNG
// and uploads the bytes with the record, which is also why a crawler that runs
// no JavaScript still gets a real image.

// --- codes ---------------------------------------------------------------------

/** sync/_lib.js:13 -- no I/O/0/1, so a code can be read down a phone. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** `CBS-` (share), never `CBD-` (sync), so the two can never be pasted into
 *  each other's box and quietly 404. */
export const CODE_PREFIX = "CBS";

/** 16 alphabet characters = 80 bits.  A share is public but unlisted, so the
 *  code has to be unguessable: at 80 bits it cannot be enumerated. */
const CODE_LENGTH = 16;

export function newCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${CODE_PREFIX}-${chars.match(/.{4}/g).join("-")}`;
}

/** "" for anything that is not a share code.  Called BEFORE any storage read,
 *  exactly as sync/[code].js:19-20 does, so a crafted path never reaches R2. */
export function normaliseCode(raw) {
  const cleaned = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = cleaned.startsWith(CODE_PREFIX) ? cleaned.slice(CODE_PREFIX.length) : cleaned;
  if (!/^[A-HJ-NP-Z2-9]{16}$/.test(body)) return "";
  return `${CODE_PREFIX}-${body.match(/.{4}/g).join("-")}`;
}

async function sha256Hex(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The object prefix for one share.  Listing the bucket never shows a code. */
export async function storageKey(code) {
  return `share/${await sha256Hex(`cbd-share:${code}`)}`;
}

export async function recordKey(code) {
  return `${await storageKey(code)}.json`;
}

export async function imageKey(code) {
  return `${await storageKey(code)}.png`;
}

/** Content address for the dedupe pointer: the same record and the same bytes
 *  always land on the same key, so pressing Share twice costs no new storage. */
export async function dedupeKey(recordText, imageBytes) {
  return `dedupe/${await sha256Hex(recordText)}${await sha256Hex(imageBytes)}`;
}

export function usageKey(now = Date.now()) {
  return `meta/usage-${new Date(now).toISOString().slice(0, 10)}`;
}

// --- the bucket ----------------------------------------------------------------

export function store(env) {
  return env?.SHARES || null;
}

// --- limits --------------------------------------------------------------------
//
// Every one of these is enforced, and every one of them is a measurement rather
// than a round number picked to look careful:

/** The whole request body.  The same cap sync uses (sync/_lib.js:15), and it
 *  clears the largest legal payload: 600,000 PNG bytes are 800,000 base64
 *  characters, plus a record under 8,000 and the JSON around it. */
export const MAX_BODY_BYTES = 1_000_000;

/** The PNG.  builder/share-card.js:52 MAX_CARD_BYTES, kept in step by
 *  tests/run-share-endpoints.mjs, which imports both and fails on a
 *  difference.  The largest card actually rendered in stage 1 was 319,274
 *  bytes, so this is 1.88x the measured worst case. */
export const MAX_CARD_BYTES = 600_000;

/** The cleaned record, serialised.  A team digest measures 898 characters and a
 *  full evaluation digest 1,596; this is roughly five times the larger one, and
 *  a record that needs more than this is not a card, it is a payload. */
export const MAX_RECORD_CHARS = 8_000;

/** builder/share-card.js:48 CARD -- the card is an og:image, so its shape is
 *  fixed at Facebook's 1.91:1 and a PNG of any other size is refused. */
export const CARD_W = 1200;
export const CARD_H = 630;

/** How long a share lives.  Chosen so the free tier bounds itself:
 *  MAX_NEW_BYTES_PER_DAY x TTL_DAYS = 9 GB, inside R2's free 10 GB, whatever
 *  happens.  Long enough that a link pasted into a Discord thread is still good
 *  six months later; short enough that a team someone regrets does not outlive
 *  their interest in it. */
export const TTL_DAYS = 180;
export const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

/** The storage budget, and the only thing that bounds growth against an
 *  anonymous writer.  50 MB of new cards a day is ~330 cards at the 150 KB a
 *  real card measures, and 83 at the 600 KB cap.  Approximate on purpose: two
 *  creates in the same millisecond can both read the same counter, which makes
 *  this a budget and not a security boundary. */
export const MAX_NEW_BYTES_PER_DAY = 50_000_000;

// --- responses -----------------------------------------------------------------

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

/** Safe inside a <script type="application/json"> block: the only sequence that
 *  can end one early is a literal `</script`, and U+2028/9 break older parsers. */
export function escapeJsonForHtml(text) {
  return String(text)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/ /g, "\\u2028")
    .replace(/ /g, "\\u2029");
}

/** The site's own origin, absolute, because a crawler does not resolve a
 *  relative og:image reliably.  The production hostnames collapse onto the
 *  canonical one; a preview deployment or the dev server keeps its own. */
export const SITE_ORIGIN = "https://championsbattledata.com";
const PRODUCTION_HOSTS = new Set(["championsbattledata.com", "www.championsbattledata.com"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function originFor(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return SITE_ORIGIN;
  }
  if (PRODUCTION_HOSTS.has(url.hostname)) return SITE_ORIGIN;
  const scheme = LOCAL_HOSTS.has(url.hostname) ? url.protocol.replace(":", "") : "https";
  return `${scheme}://${url.host}`;
}

/** Where a share lives.  PAGE_PATH is the one line to change if the prettier
 *  /share/<code> route is ever mounted (see the README note and the wiring
 *  report): the handler in [code].js already works at both mount points. */
export const PAGE_PATH = "/api/share/";
export const IMAGE_PATH = "/api/share/img/";

export function pageUrl(request, code) {
  return `${originFor(request)}${PAGE_PATH}${code}`;
}

export function imageUrl(request, code) {
  return `${originFor(request)}${IMAGE_PATH}${code}`;
}

// --- the fallback card ---------------------------------------------------------
//
// A crawler must never be handed a broken image, and there is no rasteriser on
// the server, so the miss case serves this: a real 1200x630 PNG, one-bit
// paletted, filled with the card's own backdrop colour (#0a1710, share-card.js
// PALETTE.pageTop).  190 bytes, which is why it is a literal here instead of an
// asset -- nothing to deploy, nothing to keep in step, and it cannot 404.

const FALLBACK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAABLAAAAJ2AQMAAAB1jukfAAAABlBMVEUKFxBy/6sDcL2IAAAAc0lEQVR42u3BAQ0AAA" +
  "DCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXg1zqQAB6RqMPAAAAABJRU5ErkJggg==";

let fallbackBytes = null;

export function fallbackPng() {
  if (!fallbackBytes) {
    const binary = atob(FALLBACK_PNG_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    fallbackBytes = bytes;
  }
  return fallbackBytes;
}

// --- is it really a PNG? -------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, from, to) {
  let c = 0xffffffff;
  for (let i = from; i < to; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readU32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/**
 * Prove the upload is a PNG of exactly the card's size, by reading it -- the
 * content type is the caller's claim and is never trusted.  Cheap enough for
 * the CPU budget: eight magic bytes, one 17-byte CRC, and the tail.
 *
 * @returns Uint8Array the same bytes, so a caller cannot forget to use them
 */
export function validatePng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (bytes.length < 100) throw bad("That image is too small to be a card.");
  if (bytes.length > MAX_CARD_BYTES) {
    throw bad(`A card must be at most ${MAX_CARD_BYTES} bytes; that one is ${bytes.length}.`, 413);
  }
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (bytes[i] !== PNG_MAGIC[i]) throw bad("That is not a PNG.");
  }
  if (readU32(bytes, 8) !== 13) throw bad("That PNG has no header chunk.");
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") {
    throw bad("That PNG has no header chunk.");
  }
  if (crc32(bytes, 12, 29) !== readU32(bytes, 29)) throw bad("That PNG's header is corrupt.");
  const width = readU32(bytes, 16);
  const height = readU32(bytes, 20);
  if (width !== CARD_W || height !== CARD_H) {
    throw bad(`A card must be ${CARD_W}x${CARD_H}; that one is ${width}x${height}.`);
  }
  const depth = bytes[24];
  const colourType = bytes[25];
  if (![1, 2, 4, 8, 16].includes(depth) || ![0, 2, 3, 4, 6].includes(colourType)) {
    throw bad("That PNG's header is corrupt.");
  }
  const tail = String.fromCharCode(...bytes.slice(bytes.length - 8, bytes.length - 4));
  if (tail !== "IEND") throw bad("That PNG is truncated.");
  return bytes;
}

// --- the digest ----------------------------------------------------------------
//
// An ALLOWLIST, in the shape of sync/_lib.js:62-81's cleanDocument but stricter:
// a key that is not named here does not survive, so no id, no updated, no
// build_source, no confidence, no settings blob, no licence, no email, and --
// the one that would actually be dangerous -- no sprite path and no URL.  The
// renderer resolves every sprite from the species and form name through the
// local index (builder/share-card.js spriteRequests), so a record has nothing
// fetchable in it and the card pipeline cannot become an open proxy.

const FORMATS = new Set(["Doubles", "Singles"]);
const STAT_CODES = new Set(["HP", "ATK", "DEF", "SPA", "SPD", "SPE"]);
const SEVERITIES = new Set(["good", "yellow", "red"]);
const STAT_KEYS = ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"];

const LIMITS = {
  title: 80,
  format: 10,
  archetype: 48,
  name: 48,   // the longest species key is 27 ("Paldean Tauros Combat Breed")
  item: 48,   // the longest item is 32 ("Rare Poke Ball Guaranteed Ticket")
  ability: 32,
  nature: 16,
  move: 40,   // the longest move is 27
  label: 90,
  team: 6,
  moves: 4,
  bonuses: 6,
  checks: 16,
  threats: 6,
};

/** One line of plain text: no control characters, no runaway whitespace, no
 *  surprises in an og:description. */
function text(value, max) {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f  ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function int(value, lo, hi, fallback = 0) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(lo, Math.min(hi, number));
}

function statCode(value) {
  const code = String(value ?? "").toUpperCase().trim();
  return STAT_CODES.has(code) ? code : "";
}

function cleanFormat(value) {
  const name = text(value, LIMITS.format);
  return FORMATS.has(name) ? name : "Doubles";
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const species = text(raw.species, LIMITS.name);
  if (!species) return null;
  const moves = (Array.isArray(raw.moves) ? raw.moves : [])
    .slice(0, LIMITS.moves)
    .map((move) => text(move, LIMITS.move));
  const bonuses = [];
  for (let i = 0; i < LIMITS.bonuses; i += 1) {
    bonuses.push(int(Array.isArray(raw.bonuses) ? raw.bonuses[i] : 0, 0, 32));
  }
  const rawStats = raw.stats && typeof raw.stats === "object" ? raw.stats : {};
  const stats = {};
  for (const key of STAT_KEYS) stats[key] = int(rawStats[key], 0, 999);
  return {
    name: text(raw.name, LIMITS.name) || species,
    species,
    form: text(raw.form, LIMITS.name) || species,
    item: text(raw.item, LIMITS.item),
    ability: text(raw.ability, LIMITS.ability),
    nature: text(raw.nature, LIMITS.nature),
    natureUp: statCode(raw.natureUp),
    natureDown: statCode(raw.natureDown),
    moves,
    bonuses,
    stats,
  };
}

function cleanTeamList(raw) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, LIMITS.team)
    .map(cleanEntry)
    .filter(Boolean);
}

export function cleanTeamDigest(raw) {
  if (!raw || typeof raw !== "object") throw bad("missing digest");
  const team = cleanTeamList(raw.team);
  if (!team.length) throw bad("A share needs at least one Pokemon.");
  const digest = {
    v: int(raw.v, 1, 99, 1),
    kind: "team",
    title: text(raw.title, LIMITS.title) || "Pokemon Champions Team",
    format: cleanFormat(raw.format),
    team,
  };
  const archetype = text(raw.archetype, LIMITS.archetype);
  if (archetype) digest.archetype = archetype;
  return digest;
}

export function cleanEvalDigest(raw) {
  if (!raw || typeof raw !== "object") throw bad("missing digest");
  const scores = raw.scores && typeof raw.scores === "object" ? raw.scores : {};
  const counts = raw.checkCounts && typeof raw.checkCounts === "object" ? raw.checkCounts : {};
  return {
    v: int(raw.v, 1, 99, 1),
    kind: "eval",
    title: text(raw.title, LIMITS.title) || "Team Evaluation",
    format: cleanFormat(raw.format),
    archetype: text(raw.archetype, LIMITS.archetype),
    scores: {
      synergy: int(scores.synergy, 0, 100),
      offense: int(scores.offense, 0, 100),
      defense: int(scores.defense, 0, 100),
      speed: int(scores.speed, 0, 100),
    },
    topMeta: int(raw.topMeta, 0, 1000),
    threatCount: int(raw.threatCount, 0, 100000),
    team: cleanTeamList(raw.team),
    checks: (Array.isArray(raw.checks) ? raw.checks : [])
      .slice(0, LIMITS.checks)
      .map((row) => ({
        label: text(row?.label, LIMITS.label),
        severity: SEVERITIES.has(String(row?.severity)) ? String(row.severity) : "good",
      }))
      .filter((row) => row.label),
    checkCounts: {
      good: int(counts.good, 0, 999),
      yellow: int(counts.yellow, 0, 999),
      red: int(counts.red, 0, 999),
    },
    threats: (Array.isArray(raw.threats) ? raw.threats : [])
      .slice(0, LIMITS.threats)
      .map((row) => ({
        name: text(row?.name, LIMITS.name),
        species: text(row?.species, LIMITS.name) || text(row?.name, LIMITS.name),
        form: text(row?.form, LIMITS.name) || text(row?.species, LIMITS.name) || text(row?.name, LIMITS.name),
        item: text(row?.item, LIMITS.item),
        score: int(row?.score, 0, 100),
      }))
      .filter((row) => row.name),
  };
}

/** Clean by kind, then refuse anything over the record cap. */
export function cleanDigest(raw) {
  const kind = String(raw?.kind || "").toLowerCase() === "eval" ? "eval" : "team";
  const digest = kind === "eval" ? cleanEvalDigest(raw) : cleanTeamDigest(raw);
  const serialised = JSON.stringify(digest);
  if (serialised.length > MAX_RECORD_CHARS) {
    throw bad(`A share record must be at most ${MAX_RECORD_CHARS} characters.`, 413);
  }
  return digest;
}

/** What is actually stored.  No request header, no IP, no licence, no user:
 *  the only thing that comes from the caller is the cleaned digest. */
export function makeRecord(digest, bytes, now = Date.now()) {
  return {
    format: "cbd-share/1",
    kind: digest.kind,
    createdAt: now,
    expiresAt: now + TTL_MS,
    bytes,
    digest,
  };
}

export function isExpired(record, now = Date.now()) {
  const expires = Number(record?.expiresAt);
  return Number.isFinite(expires) && expires > 0 && now >= expires;
}

// --- what the card and the page say -------------------------------------------

/** The names in slot order, which is what a person wants to read in a preview. */
export function teamNames(digest) {
  return (Array.isArray(digest?.team) ? digest.team : [])
    .map((entry) => entry?.name || entry?.species)
    .filter(Boolean);
}

export function cardTitle(digest) {
  const title = text(digest?.title, LIMITS.title);
  if (digest?.kind === "eval") return title || "Team Evaluation";
  return title || "Pokemon Champions Team";
}

export function cardDescription(digest) {
  const format = cleanFormat(digest?.format);
  if (digest?.kind === "eval") {
    const scores = digest.scores || {};
    const parts = [
      `Synergy ${int(scores.synergy, 0, 100)}`,
      `Offense ${int(scores.offense, 0, 100)}`,
      `Defense ${int(scores.defense, 0, 100)}`,
      `Speed ${int(scores.speed, 0, 100)}`,
    ];
    const names = teamNames(digest);
    const tail = [format, names.length ? names.join(", ") : ""].filter(Boolean).join(" - ");
    return `${parts.join(" - ")}${tail ? ` - ${tail}` : ""}`.slice(0, 300);
  }
  const names = teamNames(digest);
  return `${names.join(", ") || "A Pokemon Champions team"} - ${format}`.slice(0, 300);
}
