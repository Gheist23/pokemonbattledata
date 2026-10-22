// Shared by the two /api/play routes.
//
// The ladder is optional. Without the D1 binding every route answers 503 and says so, exactly as
// the sync and share routes do without theirs, and the game goes on being playable -- it needs
// no server at all.

export const DEFAULT_ELO = 1000;
/** How much one game can move a rating. 24 is a compromise: a new team finds its level inside a
 *  dozen games, and a settled one does not swing on a single lucky crit. */
export const K = 24;
/** Nothing below this many games is ranked, so one lucky win does not top the board. */
export const MIN_GAMES = 3;

/**
 * The game's own turn ceiling, MIRRORED from builder/play-game.js.
 *
 * It is copied rather than imported on purpose: that module is the whole battle engine and
 * pulling it into the Worker bundle to read one number would cost every request the parse of it.
 * The copy is not left to trust -- tests/run-play-ladder.mjs reads both files and fails if the
 * two numbers ever drift apart.
 */
export const TURN_LIMIT = 40;

/** How long one device must wait between reporting two DIFFERENT games.
 *
 *  This is a floor on accidents and casual tampering, not a referee: it is what makes the
 *  header's claim that a device cannot report two games in the same second actually true. Five
 *  seconds is under the quickest honest game -- deal, bring four, resign, each of which is a
 *  round trip through the worker that thinks -- and well under a played-out one.
 *
 *  Deployments can tune it with the PLAY_REPORT_GAP_MS variable, and 0 switches it off. */
export const REPORT_GAP_MS = 5000;

export function reportGap(env) {
  const raw = env ? env.PLAY_REPORT_GAP_MS : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === "") return REPORT_GAP_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : REPORT_GAP_MS;
}

export function json(body, status = 200, cacheControl = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // The board is read far more often than it changes, and a minute of staleness on a
      // leaderboard is nothing. Anything that answers ONE caller about ONE game passes
      // "no-store" rather than taking that default.
      "Cache-Control": cacheControl || (status === 200 ? "public, max-age=60" : "no-store"),
    },
  });
}

/** The database, or null when the ladder is not switched on for this deployment. */
export function store(env) {
  return env && env.PLAY ? env.PLAY : null;
}

/**
 * One of the two formats, or "" for anything else.
 *
 * It used to answer "Doubles" to everything that was not exactly "Singles", which meant a
 * typo, a missing field or a made-up format was quietly RATED as Doubles -- on the Doubles
 * board, against Doubles teams, in a game that was not a Doubles game. The callers decide what
 * to do with "": the report refuses it, and the leaderboard still defaults a request that asks
 * for no format at all.
 */
export function cleanFormat(value) {
  const asked = String(value ?? "").trim().toLowerCase();
  if (asked === "singles") return "Singles";
  if (asked === "doubles") return "Doubles";
  return "";
}

/** A display name that cannot be used to draw anything but letters. */
export function cleanName(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N} '_.-]/gu, "")
    .trim()
    .slice(0, 24);
}

/** The browser's own id: sixteen hex characters and nothing else. */
export function cleanId(value) {
  const clean = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{16}$/.test(clean) ? clean : "";
}

/**
 * The client's own id for ONE game, as it comes off the wire.
 *
 * It is whatever the page's worker minted for that game ("g7", a uuid, anything short), so this
 * only has to make it safe and comparable rather than recognise a format. It is never used on
 * its own -- see `gameKeyOf` -- because the worker's ids restart with every page load and would
 * collide across devices.
 */
export function cleanGameId(value) {
  const clean = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, "");
  return clean.slice(0, 64);
}

/** A short, stable id for a string: the team's contents become the team's identity. */
export async function hashOf(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The games row's primary key for one reported game.
 *
 * The device is part of it because the client's id is only unique WITHIN a browser: the page's
 * worker numbers its games from one on every load, so two visitors both finishing their third
 * game of the session send the same id, and keying on that alone would silently drop the second
 * player's game as a replay of the first player's.
 */
export function gameKeyOf(device, clientGameId) {
  return hashOf(`game|${device}|${clientGameId}`);
}

/**
 * Elo, both sides.
 *
 * `score` is from A's point of view: 1 for a win, 0.5 for a draw, 0 for a loss.
 */
export function elo(a, b, score, k = K) {
  const expected = 1 / (1 + 10 ** ((b - a) / 400));
  const move = k * (score - expected);
  return [a + move, b - move];
}

/** A row as the leaderboard prints it, with the winrate worked out here rather than on the page. */
export function boardRow(row) {
  const games = Number(row.games) || 0;
  return {
    name: row.name,
    elo: Math.round(Number(row.elo) || DEFAULT_ELO),
    wins: Number(row.wins) || 0,
    losses: Number(row.losses) || 0,
    draws: Number(row.draws) || 0,
    games,
  };
}
