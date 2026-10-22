// POST /api/play/report  {device, name, format, result, turns, team, foeName, log, clientGameId}
//
// One finished game: the record, the ratings and the whole log of it.
//
// WHAT IS TRUSTED AND WHAT IS NOT. The client reports its own result, which is the only thing it
// can do -- the game is played in the visitor's own browser and there is no server-side referee.
// So this is a ladder, not a tournament: it is worth exactly what the honesty of the people on
// it is worth, and the log is kept for every game so a result that looks impossible can be read
// back. What IS enforced here is shape and CONSISTENCY: a result is one of three words, a turn
// count is no larger than the game's own limit, a name is letters, the opponent is one of the
// Solver's real tournament teams, one game moves the ratings exactly once, and one device cannot
// report two different games inside REPORT_GAP_MS. None of that makes a reported result true. It
// is what stops an accident, a double-send or somebody with the network tab open from leaving
// the board in a state the games in it cannot explain.
//
// ONE GAME, ONE REPORT. The row in `games` is keyed on the client's own id for the game (see
// `gameKeyOf`), and that INSERT is the FIRST statement of the batch and a plain INSERT, so a
// second report of the same game fails the whole transaction and not one counter moves. A repeat
// is then answered 200 with `duplicate: true` and the rating that game already earned, which is
// the case that matters for a CLIENT: `report` in play-record.js is fire-and-forget over
// `keepalive`, so a retry after a dropped connection must leave the player with their game and
// their rating rather than an error. A page cached from before `clientGameId` existed sends none
// and falls back to a fresh id per request -- it keeps working, with the per-device floor as its
// only protection.
//
// ONLY AN OPEN TEAM SHEET IS RATED. A closed-sheet opponent does not know the player's sets: it
// samples them from the usage data, differently on every run, so two players who bring the same
// team are rated against two different opponents. The page already refuses to send those, and
// this refuses them again -- in particular for a page cached from before the toggle existed,
// which plays the closed sheet and says nothing about it. A refusal is a 409 with
// `ranked: false` rather than a 200: the game really happened, the player's own record should
// keep it, and there is nothing for them to fix.
//
// THE SHEET COLUMN HAS TO EXIST BEFORE THIS IS DEPLOYED. `games.sheet` is written by every
// insert below; on a database where the column has not been added yet every report fails with a
// 500. The ordered steps are at the bottom of schema.sql and have to be run by hand FIRST.

import { fetchAssetText } from "../_common.js";
import {
  DEFAULT_ELO, K, TURN_LIMIT, cleanFormat, cleanGameId, cleanId, cleanName, elo, gameKeyOf,
  hashOf, json, reportGap, store,
} from "./_lib.js";

/** The smallest sensible game. Anything shorter is a mis-send, not a battle. */
const MIN_TURNS = 1;
/** The game cannot go past its own limit, so neither can a report of one. */
const MAX_TURNS = TURN_LIMIT;
/** A log longer than this is not a game, it is a payload. */
const MAX_LOG = 200000;
/** The metadata is six sets and a handful of numbers. This is already twenty times that. */
const MAX_META = 20000;
/** Bigger than any body that could hold both of those, plus room for the rest of the fields. */
const MAX_BODY = MAX_LOG + MAX_META + 4096;

/** The tournament-team library, kept per isolate against the asset binding that served it.
 *  A failure is deliberately NOT cached: a library that cannot be read right now costs one
 *  fetch per report (and no parse), rather than blinding this isolate for its whole life. */
const libraryCache = new WeakMap();

/**
 * The names of the Solver's tournament teams, or null when the library cannot be read.
 *
 * `foeName` arrives from the client, and the client is the one thing on this route that cannot
 * be trusted: believing it lets anybody put a row of their own on "Best Solver teams" and rank
 * themselves against it. The real library is deployed beside the page, so it is read and the
 * name is RESOLVED against it -- and what gets stored is the library's own spelling, never the
 * client's string.
 */
async function tournamentTeams(env, request) {
  const binding = env && env.ASSETS;
  if (!binding || typeof binding !== "object") return null;
  const cached = libraryCache.get(binding);
  if (cached) return cached;
  try {
    const text = await fetchAssetText(env, request, "data/builder/known-teams.json");
    const payload = JSON.parse(text);
    const names = new Map();
    for (const row of payload.teams || []) {
      const name = String((Array.isArray(row) ? row[0] : row && row.name) || "").trim();
      if (name) names.set(name.toLowerCase(), name);
    }
    if (!names.size) return null;
    libraryCache.set(binding, names);
    return names;
  } catch {
    return null;
  }
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error("That game is too big to store."), { status: 413 });
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("That is not a game."), { status: 400 });
  }
}

/** Read a row, or invent the starting one. */
async function rowOr(db, sql, args, blank) {
  const found = await db.prepare(sql).bind(...args).first();
  return found || blank;
}

/** What a game that is already on the ladder is answered with, so a retry keeps its rating. */
async function alreadyReported(db, gameId) {
  const row = await db.prepare(`SELECT g.id, g.playerElo, g.solverElo,
      (SELECT games FROM players WHERE id = g.player AND format = g.format) AS playerGames,
      (SELECT name  FROM teams   WHERE id = g.playerTeam) AS teamName,
      (SELECT elo   FROM teams   WHERE id = g.playerTeam) AS teamElo,
      (SELECT games FROM teams   WHERE id = g.playerTeam) AS teamGames,
      (SELECT name  FROM teams   WHERE id = g.solverTeam) AS solverName,
      (SELECT elo   FROM teams   WHERE id = g.solverTeam) AS solverTeamElo,
      (SELECT games FROM teams   WHERE id = g.solverTeam) AS solverGames
    FROM games g WHERE g.id = ?`).bind(gameId).first();
  if (!row) return null;
  return json({
    ok: true,
    // Said out loud so a client can tell "your game is on the ladder" from "your game has just
    // been put on the ladder". Either way it has its rating and nothing is lost.
    duplicate: true,
    gameId,
    // The rating the GAME earned, as it was recorded at the time -- not a second helping of it.
    player: { elo: Math.round(Number(row.playerElo) || DEFAULT_ELO), games: Number(row.playerGames) || 0 },
    team: { elo: Math.round(Number(row.teamElo) || DEFAULT_ELO), games: Number(row.teamGames) || 0 },
    solverTeam: {
      name: row.solverName || "",
      elo: Math.round(Number(row.solverTeamElo) || DEFAULT_ELO),
      games: Number(row.solverGames) || 0,
    },
    // One caller, one game: nothing about this answer is shareable.
  }, 200, "no-store");
}

export async function onRequestPost({ request, env }) {
  const db = store(env);
  if (!db) return json({ error: "The ladder is not configured on this server." }, 503);

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return json({ error: error.message }, error.status || 400);
  }

  const device = cleanId(body.device);
  const name = cleanName(body.name);
  if (!device) return json({ error: "No player id." }, 400);
  if (!name) return json({ error: "No name." }, 400);

  // A format this server does not run is refused rather than rated as Doubles: the format
  // decides which board the rating lands on, and guessing puts a game on a board it was never
  // played on.
  const format = cleanFormat(body.format);
  if (!format) return json({ error: "That is not a format." }, 400);
  const result = ["win", "loss", "draw"].includes(body.result) ? body.result : "";
  if (!result) return json({ error: "That is not a result." }, 400);
  const turns = Math.max(MIN_TURNS, Math.min(MAX_TURNS, Math.trunc(Number(body.turns) || 0)));
  const resigned = body.resigned ? 1 : 0;

  // Anything that is not explicitly an open sheet is treated as closed, so a client that says
  // nothing cannot be rated by accident.
  if (body.sheet !== "open") {
    // 409, not 200. A 200 is an ANSWER, and both clients read an answer as a rating: they do
    // `answer.player.elo` on it, and a body with no `player` on it throws inside the render that
    // shows the result -- blanking the whole page on exactly the old cached client this branch
    // exists for. A non-2xx makes `report` yield null, which every caller already handles.
    return json({
      ranked: false,
      reason: "Only Open Team Sheet games count towards the leaderboard.",
    }, 409);
  }

  // The opponent is resolved against the shipped library, and only then does it name a row.
  const askedFoe = String(body.foeName || "").trim();
  if (!askedFoe) return json({ error: "That game names no opponent." }, 400);
  const library = await tournamentTeams(env, request);
  // When the library cannot be read the name is believed rather than every game being refused:
  // a missing asset is this server's problem, not the player's. The game says so, so a row that
  // was never checked can be found again.
  const foeChecked = Boolean(library);
  const solverName = library ? library.get(askedFoe.toLowerCase()) || "" : cleanName(askedFoe);
  if (!solverName) return json({ error: "That is not one of the Solver's tournament teams." }, 400);

  // The team's CONTENTS are its identity, so a different team is a different entry with its own
  // rating and its own record -- which is what resets a team's Elo when a new one is brought.
  const teamText = JSON.stringify(body.team || []);
  // The OWNER is part of a team's identity as well as its contents. Two people who happen to
  // bring the same six would otherwise share one ladder entry and one rating, and the second of
  // them would inherit the first's record -- which is not what "my team's Elo" means, and it
  // would let anybody adopt somebody else's rating by copying their sheet.
  const playerTeamId = await hashOf(`player|${device}|${format}|${teamText}`);
  const solverTeamId = await hashOf(`solver|${format}|${solverName}`);
  const at = Date.now();

  // One game, one id. `clientGameId` comes from the page's own worker, which mints one per game;
  // without it (a page cached from before it was sent) there is nothing to recognise a repeat by
  // and a fresh id per request is the old behaviour.
  const clientGameId = cleanGameId(body.clientGameId);
  const gameId = clientGameId
    ? await gameKeyOf(device, clientGameId)
    : crypto.randomUUID().replace(/-/g, "");

  // Refused, not trimmed. `.slice()` on a JSON string leaves the column holding something that
  // is not JSON at all, which makes the one record of a suspicious game unreadable -- and the
  // log is the entire reason a self-reported result is worth keeping.
  const meta = JSON.stringify({
    team: body.team || [], teamName: cleanName(body.teamName), foeName: solverName,
    foeChecked,
    clientGameId: clientGameId || null,
    lookahead: body.lookahead || null, pool: body.pool || null, resigned: Boolean(resigned),
    sheet: "open",
  });
  if (meta.length > MAX_META) return json({ error: "That game is too big to store." }, 413);
  const log = JSON.stringify(body.log || []);
  if (log.length > MAX_LOG) return json({ error: "That game is too big to store." }, 413);

  // Two questions in one round trip: is this game already on the ladder, and when did this
  // device last put one on it.
  let standing = null;
  try {
    standing = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM games WHERE id = ?) AS already,
        (SELECT MAX(at) FROM games WHERE player = ?) AS lastAt`).bind(gameId, device).first();
  } catch (error) {
    return json({ error: "The ladder could not record that game." }, 500);
  }

  // A repeat is answered with the rating it already has. This is BEFORE the floor on purpose: a
  // client retrying a game that did go through must get its rating back, however fast it retries.
  if (Number(standing?.already) > 0) {
    const answer = await alreadyReported(db, gameId);
    if (answer) return answer;
  }

  // The floor. A second DIFFERENT game this soon is refused outright -- it is kept in the
  // browser's own record, which is the authority for what the player sees, but it is not rated.
  const gap = reportGap(env);
  const lastAt = Number(standing?.lastAt) || 0;
  if (gap > 0 && lastAt && Math.abs(at - lastAt) < gap) {
    return json({
      ranked: false,
      reason: "That is too soon after your last game to be rated.",
    }, 429);
  }

  const player = await rowOr(db, "SELECT * FROM players WHERE id = ? AND format = ?", [device, format],
    { id: device, format, name, elo: DEFAULT_ELO, wins: 0, losses: 0, draws: 0, games: 0 });
  const mine = await rowOr(db, "SELECT * FROM teams WHERE id = ?", [playerTeamId],
    { id: playerTeamId, side: "player", owner: device, format, name: "", elo: DEFAULT_ELO, wins: 0, losses: 0, draws: 0, games: 0 });
  const theirs = await rowOr(db, "SELECT * FROM teams WHERE id = ?", [solverTeamId],
    { id: solverTeamId, side: "solver", owner: "solver", format, name: solverName, elo: DEFAULT_ELO, wins: 0, losses: 0, draws: 0, games: 0 });

  // Whatever the team was last called. Bound as the row was READ it could never change: the
  // upsert wrote the OLD name back over itself, so a team kept the first name it was ever
  // reported under and renaming it never showed on the board.
  const teamName = cleanName(body.teamName) || mine.name || "A team";

  const score = result === "win" ? 1 : result === "draw" ? 0.5 : 0;
  // The player is rated against the team they beat, and the two TEAMS are rated against each
  // other. Rating the player against the Solver's player rating would make one opponent of every
  // tournament team, which is the opposite of what the board is for.
  const theirsWas = Number(theirs.elo) || DEFAULT_ELO;
  const playerWas = Number(player.elo) || DEFAULT_ELO;
  const mineWas = Number(mine.elo) || DEFAULT_ELO;
  const [playerElo, solverPlayerElo] = elo(playerWas, theirsWas, score, K);
  const [mineElo, theirsElo] = elo(mineWas, theirsWas, score, K);
  // What is written is the MOVEMENT, not the new number. A rating worked out from a read and
  // written back as an absolute loses the other game entirely when two finish together -- and
  // every single game on the ladder touches the same Solver-team row, so that is not a rare
  // case. The movement is still worked out from the rating this report could see, which is the
  // one approximation left: two games finishing together each move the row by what they were
  // worth against the rating they met, and both movements land.
  const playerMove = playerElo - playerWas;
  const mineMove = mineElo - mineWas;
  const theirsMove = theirsElo - theirsWas;

  const flag = (which) => ({
    wins: which === "win" ? 1 : 0,
    losses: which === "loss" ? 1 : 0,
    draws: which === "draw" ? 1 : 0,
  });
  const flip = result === "win" ? "loss" : result === "loss" ? "win" : "draw";
  const p = flag(result);
  const m = flag(result);
  const t = flag(flip);

  let written;
  try {
    written = await db.batch([
      // FIRST, and a plain INSERT: this is what makes a replay impossible. The id is the game's
      // own, so a second report of it fails here and the whole batch -- every counter, every
      // rating -- is rolled back with it.
      db.prepare(`INSERT INTO games
                  (id, at, format, player, playerTeam, solverTeam, result, turns, resigned, playerElo, solverElo, sheet, meta, log)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
        .bind(gameId, at, format, device, playerTeamId, solverTeamId, result, turns, resigned,
          playerElo, theirsElo, meta, log),
      db.prepare(`INSERT INTO players (id, format, name, elo, wins, losses, draws, games, updated)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
                  ON CONFLICT(id, format) DO UPDATE SET
                    name = excluded.name,
                    elo = players.elo + ?,
                    wins = players.wins + excluded.wins,
                    losses = players.losses + excluded.losses,
                    draws = players.draws + excluded.draws,
                    games = players.games + 1,
                    updated = excluded.updated`)
        .bind(device, format, name, DEFAULT_ELO + playerMove, p.wins, p.losses, p.draws, at, playerMove),
      db.prepare(`INSERT INTO teams (id, side, owner, format, name, elo, wins, losses, draws, games, updated)
                  VALUES (?, 'player', ?, ?, ?, ?, ?, ?, ?, 1, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    elo = teams.elo + ?,
                    wins = teams.wins + excluded.wins,
                    losses = teams.losses + excluded.losses,
                    draws = teams.draws + excluded.draws,
                    games = teams.games + 1,
                    updated = excluded.updated`)
        .bind(playerTeamId, device, format, teamName, DEFAULT_ELO + mineMove, m.wins, m.losses, m.draws, at, mineMove),
      db.prepare(`INSERT INTO teams (id, side, owner, format, name, elo, wins, losses, draws, games, updated)
                  VALUES (?, 'solver', 'solver', ?, ?, ?, ?, ?, ?, 1, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    elo = teams.elo + ?,
                    wins = teams.wins + excluded.wins,
                    losses = teams.losses + excluded.losses,
                    draws = teams.draws + excluded.draws,
                    games = teams.games + 1,
                    updated = excluded.updated`)
        .bind(solverTeamId, format, solverName, DEFAULT_ELO + theirsMove, t.wins, t.losses, t.draws, at, theirsMove),
      // Read back inside the same transaction, so the page is told what the ladder actually
      // holds rather than what this request worked out before anybody else's game landed.
      db.prepare("SELECT elo, games FROM players WHERE id = ? AND format = ?").bind(device, format),
      db.prepare("SELECT id, elo, games FROM teams WHERE id = ? OR id = ?").bind(playerTeamId, solverTeamId),
    ]);
  } catch (error) {
    // The one error worth telling apart: two reports of the SAME game in flight together, where
    // this is the one that lost. The game is on the ladder, so the client is told its rating
    // instead of being told the ladder broke.
    const answer = await alreadyReported(db, gameId).catch(() => null);
    if (answer) return answer;
    return json({ error: "The ladder could not record that game." }, 500);
  }

  const playerRow = written?.[4]?.results?.[0] || {};
  const teamRows = written?.[5]?.results || [];
  const mineRow = teamRows.find((row) => row.id === playerTeamId) || {};
  const theirsRow = teamRows.find((row) => row.id === solverTeamId) || {};
  const standingOf = (row, fallbackElo) => ({
    elo: Math.round(Number(row.elo ?? fallbackElo) || DEFAULT_ELO),
    games: Number(row.games) || 0,
  });

  return json({
    ok: true,
    gameId,
    player: standingOf(playerRow, playerElo),
    team: standingOf(mineRow, mineElo),
    solverTeam: { name: solverName, ...standingOf(theirsRow, theirsElo) },
    // Kept out of the ladder maths deliberately: it is here so the page can show how the player
    // would have been rated against the Solver as a single opponent, which is not what the board
    // ranks.
    againstSolver: Math.round(solverPlayerElo),
  }, 201);
}
