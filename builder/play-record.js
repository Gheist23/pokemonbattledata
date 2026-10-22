// Who you are on the ladder, and what you have done on it.
//
// No account and no email. A name you pick and a random id this browser invented for itself,
// which is the lightest identity that can hold a leaderboard up. The cost is honest and worth
// saying out loud on the page: clearing your browser data loses the record, and nothing stops
// somebody making a second name.
//
// The local record is the authority for what this browser shows even when the ladder is not
// reachable, so a game is never lost because a request failed. Reporting to the server is a
// separate, silent attempt: a counter that can interrupt a game is worse than no counter.

const ID_KEY = "cbd.play.id";
const NAME_KEY = "cbd.play.name";
const RECORD_KEY = "cbd.play.record.v1";
/** The Fetch standard's ceiling on a `keepalive` body, shared across all of them in flight. */
const KEEPALIVE_LIMIT = 60000;

function read(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing with storage off: the game still plays, it just is not remembered.
  }
}

/** This browser's own id. Random, local, and sent only to this site's own endpoint. */
export function deviceId() {
  try {
    const kept = localStorage.getItem(ID_KEY);
    if (kept && /^[0-9a-f]{16}$/.test(kept)) return kept;
  } catch {
    // fall through to a fresh one
  }
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const made = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem(ID_KEY, made); } catch { /* nothing to do */ }
  return made;
}

export function playerName() {
  try {
    return String(localStorage.getItem(NAME_KEY) || "").slice(0, 24);
  } catch {
    return "";
  }
}

export function setPlayerName(value) {
  const clean = String(value || "").replace(/[^\p{L}\p{N} '_.-]/gu, "").trim().slice(0, 24);
  try { localStorage.setItem(NAME_KEY, clean); } catch { /* nothing to do */ }
  return clean;
}

export function loadRecord() {
  return read(RECORD_KEY, { wins: 0, losses: 0, draws: 0, games: [], elo: null, teamElo: null });
}

/**
 * Write one finished game down, and tell the ladder about it.
 *
 * The local half happens first and always. The report is fire-and-forget: it carries `keepalive`
 * because a person who closes the tab on the result screen has still played the game.
 */
export function recordGame(game) {
  const record = loadRecord();
  if (game.result === "win") record.wins += 1;
  else if (game.result === "loss") record.losses += 1;
  else record.draws += 1;
  const entry = { ...game, at: Date.now() };
  record.games = [entry, ...(record.games || [])].slice(0, 50);
  write(RECORD_KEY, record);
  // The rating comes back from the ladder, so it arrives after the result screen is already up.
  // The caller is handed the promise and can fill the number in when it lands, rather than the
  // screen waiting on a request that may never answer.
  const reported = report(entry).then((answer) => {
    if (!answer) return null;
    const latest = loadRecord();
    latest.elo = answer.player?.elo ?? latest.elo;
    latest.teamElo = answer.team?.elo ?? latest.teamElo;
    write(RECORD_KEY, latest);
    return answer;
  });
  return { record, reported };
}

function report(entry) {
  const name = playerName();
  // Nobody unnamed goes on the ladder, and nothing is sent for them either.
  if (!name) return Promise.resolve(null);
  // Only an Open Team Sheet game is rated. A Closed one is a different game -- the opponent is
  // guessing, and what it guesses differs from run to run -- so two players bringing the same
  // team would be rated on two different opponents. It is not sent at all rather than sent and
  // refused, so a practice game costs nothing and tells the ladder nothing.
  if (entry.sheet !== "open") return Promise.resolve(null);
  try {
    let body = JSON.stringify({ ...entry, device: deviceId(), name });
    // `keepalive` is what lets a result outlive the tab somebody closes on the result screen --
    // but the Fetch standard caps a keepalive body at 64 KiB, and the quota is SHARED across
    // every keepalive request in flight. A forty-turn game's log goes well past that, and the
    // request was simply never sent: the longest games, which are the ones worth having, were
    // the ones that silently never reached the ladder.
    //
    // So the log is dropped when the body is too big, rather than the game. The log is the audit
    // trail; the result, the teams and the ratings are the point, and they are a few hundred
    // bytes. A body that is still too big after that is sent WITHOUT keepalive -- it then needs
    // the tab to stay open for a moment, which is far better than not being sent at all.
    let keepalive = true;
    if (body.length > KEEPALIVE_LIMIT) {
      body = JSON.stringify({ ...entry, log: [], logDropped: true, device: deviceId(), name });
      if (body.length > KEEPALIVE_LIMIT) keepalive = false;
    }
    return fetch("/api/play/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive,
    }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  } catch {
    // No network, a blocker, an endpoint that is not there yet: none of it is worth a broken game.
    return Promise.resolve(null);
  }
}
