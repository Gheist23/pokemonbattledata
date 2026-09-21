// Shared helpers for the Box/Team sync endpoints.
//
// One sync code names one document: the Team Builder's teams and boxes in the
// Companion's own shapes.  The code is the only credential, so it carries 80
// random bits, and the document is stored under a SHA-256 of it -- listing the
// namespace never reveals a usable code.
//
//   sync:<sha256(code)>  ->  { revision, updatedAt, document }
//
// The binding is SYNC when a dedicated namespace exists, otherwise the
// licence namespace (the keys are prefixed, so the two never collide).

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
export const MAX_BYTES = 1_000_000;
export const MAX_TEAMS = 500;
export const MAX_BOXES = 60;
export const MAX_BOX_ENTRIES = 600;

export function store(env) {
  return env.SYNC || env.LICENSES || null;
}

export function newCode() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `CBD-${chars.match(/.{4}/g).join("-")}`;
}

export function normaliseCode(raw) {
  const cleaned = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = cleaned.startsWith("CBD") ? cleaned.slice(3) : cleaned;
  if (!/^[A-HJ-NP-Z2-9]{16}$/.test(body)) return "";
  return `CBD-${body.match(/.{4}/g).join("-")}`;
}

export async function storageKey(code) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cbd-sync:${code}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sync:${hex}`;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Read a JSON body without trusting its size. */
export async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BYTES) throw Object.assign(new Error("That is more data than a sync can hold."), { status: 413 });
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw Object.assign(new Error("expected JSON"), { status: 400 });
  }
}

/** Keep only the shapes the builder and the app use; reject anything else. */
export function cleanDocument(raw) {
  if (!raw || typeof raw !== "object") throw Object.assign(new Error("missing document"), { status: 400 });
  const teams = Array.isArray(raw.teams) ? raw.teams : [];
  const boxes = Array.isArray(raw.boxes) ? raw.boxes : [];
  if (teams.length > MAX_TEAMS) throw Object.assign(new Error(`At most ${MAX_TEAMS} teams can be synced.`), { status: 413 });
  if (boxes.length > MAX_BOXES) throw Object.assign(new Error(`At most ${MAX_BOXES} boxes can be synced.`), { status: 413 });
  for (const box of boxes) {
    if (Array.isArray(box?.box) && box.box.length > MAX_BOX_ENTRIES) throw Object.assign(new Error(`A box can hold at most ${MAX_BOX_ENTRIES} Pokemon.`), { status: 413 });
  }
  const tombstones = raw.tombstones && typeof raw.tombstones === "object" ? raw.tombstones : {};
  return {
    format: "cbd-sync/1",
    updatedAt: Date.now(),
    teams: teams.filter((team) => team && typeof team === "object" && typeof team.id === "string"),
    boxes: boxes.filter((box) => box && typeof box === "object" && typeof box.id === "string"),
    tombstones: {
      teams: tombstones.teams && typeof tombstones.teams === "object" ? tombstones.teams : {},
      boxes: tombstones.boxes && typeof tombstones.boxes === "object" ? tombstones.boxes : {},
    },
  };
}
