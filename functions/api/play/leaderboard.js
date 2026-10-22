// GET /api/play/leaderboard?format=Doubles
//
// Three boards, because the page asks three different questions:
//
//   players      -- who wins most against the Solver, whatever they bring
//   playerTeams  -- which team brought to the challenge holds up best
//   solverTeams  -- which of the Solver's tournament teams is hardest to beat
//
// A rating with two games behind it is noise, so nothing under MIN_GAMES is ranked; the count is
// printed beside every row so the number can be judged rather than trusted.
//
// The total is the number of games the board is MADE of, which is the Open Team Sheet ones --
// the only ones that are rated. The live database also holds closed-sheet games from before that
// rule, and counting those under three boards that none of them is on says a number the boards
// cannot account for.

import { MIN_GAMES, boardRow, cleanFormat, json, store } from "./_lib.js";

const LIMIT = 25;

/** Switched off for this isolate if `games.sheet` has not been added yet (see schema.sql): a
 *  board that over-counts its total is better than no board at all while a migration is due. */
let sheetColumn = true;

function boards(db, format) {
  return db.batch([
    // Per format, because that is what the rating is. A player who has only played Doubles is
    // simply not on the Singles board.
    db.prepare(`SELECT name, elo, wins, losses, draws, games
                FROM players
                WHERE format = ? AND games >= ?
                ORDER BY elo DESC
                LIMIT ?`).bind(format, MIN_GAMES, LIMIT),
    db.prepare(`SELECT name, elo, wins, losses, draws, games
                FROM teams
                WHERE side = 'player' AND format = ? AND games >= ?
                ORDER BY elo DESC
                LIMIT ?`).bind(format, MIN_GAMES, LIMIT),
    db.prepare(`SELECT name, elo, wins, losses, draws, games
                FROM teams
                WHERE side = 'solver' AND format = ? AND games >= ?
                ORDER BY elo DESC
                LIMIT ?`).bind(format, MIN_GAMES, LIMIT),
    sheetColumn
      ? db.prepare("SELECT COUNT(*) AS games FROM games WHERE format = ? AND sheet = 'open'").bind(format)
      : db.prepare("SELECT COUNT(*) AS games FROM games WHERE format = ?").bind(format),
  ]);
}

export async function onRequestGet({ request, env }) {
  const db = store(env);
  if (!db) return json({ error: "The ladder is not configured on this server." }, 503);
  const asked = new URL(request.url).searchParams.get("format");
  // Asking for no format at all is the page's own default view, which is Doubles. Asking for a
  // format that is not one is refused rather than answered with the Doubles board under the
  // heading that was asked for.
  const format = asked === null || String(asked).trim() === "" ? "Doubles" : cleanFormat(asked);
  if (!format) return json({ error: "That is not a format." }, 400);

  try {
    let read;
    try {
      read = await boards(db, format);
    } catch (error) {
      if (!sheetColumn || !/\bsheet\b/i.test(String(error && error.message))) throw error;
      sheetColumn = false;
      read = await boards(db, format);
    }
    const [players, playerTeams, solverTeams, totals] = read;

    return json({
      format,
      minGames: MIN_GAMES,
      games: Number(totals.results?.[0]?.games) || 0,
      players: (players.results || []).map(boardRow),
      playerTeams: (playerTeams.results || []).map(boardRow),
      // The Solver's side of a game is the opposite of the player's, so its wins are the
      // player's losses. They are stored that way round already; this only says so.
      solverTeams: (solverTeams.results || []).map(boardRow),
    });
  } catch (error) {
    return json({ error: "The ladder could not be read." }, 500);
  }
}
