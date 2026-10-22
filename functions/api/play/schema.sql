-- The ladder behind /play/.
--
-- Three tables, because the page asks three different questions: who is the best PLAYER, whose
-- TEAM is the best, and which of the Solver's tournament teams is hardest to beat. A player and
-- their team are rated separately on purpose -- a good player on a new team should not drag the
-- team's record with them, and a strong team in new hands should not inherit the wins.
--
-- A team's identity is the CONTENTS of the team, not a name, so bringing a different team to the
-- challenge is automatically a new entry starting at the default rating with no record. That is
-- what "submit a new team and the Elo resets" means here, and it cannot be gamed by renaming.
--
-- Applied with:
--   npx wrangler d1 execute cbd-play --remote --file functions/api/play/schema.sql
--
-- EVERY STATEMENT IN THIS FILE IS SAFE TO RUN AGAIN. It creates nothing that already exists. The
-- MIGRATIONS at the bottom are not in it, because ALTER TABLE is not: they are listed there, in
-- order, to be run by hand.

-- A player is rated PER FORMAT. Doubles and Singles are different games, and a rating earned in
-- one of them printed on the other board -- beside a win rate counted across both -- says
-- something that is not true about either.
CREATE TABLE IF NOT EXISTS players (
  id       TEXT NOT NULL,             -- the browser's own random id
  format   TEXT NOT NULL,
  name     TEXT NOT NULL,
  elo      REAL NOT NULL DEFAULT 1000,
  wins     INTEGER NOT NULL DEFAULT 0,
  losses   INTEGER NOT NULL DEFAULT 0,
  draws    INTEGER NOT NULL DEFAULT 0,
  games    INTEGER NOT NULL DEFAULT 0,
  updated  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, format)
);

CREATE TABLE IF NOT EXISTS teams (
  id       TEXT PRIMARY KEY,          -- a hash of the side, the format and the team itself
  side     TEXT NOT NULL,             -- 'player' or 'solver'
  owner    TEXT NOT NULL,             -- the player's id, or 'solver'
  format   TEXT NOT NULL,
  name     TEXT NOT NULL,
  elo      REAL NOT NULL DEFAULT 1000,
  wins     INTEGER NOT NULL DEFAULT 0,
  losses   INTEGER NOT NULL DEFAULT 0,
  draws    INTEGER NOT NULL DEFAULT 0,
  games    INTEGER NOT NULL DEFAULT 0,
  updated  INTEGER NOT NULL DEFAULT 0
);

-- `id` is the GAME's own id, not a fresh one per request: a hash of the device and the client's
-- id for that game (gameKeyOf in _lib.js). That is what makes the primary key refuse a second
-- report of the same game -- it is the first statement of the batch that writes a result, so a
-- repeat takes the whole transaction down and no rating moves.
CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  format      TEXT NOT NULL,
  player      TEXT NOT NULL,
  playerTeam  TEXT NOT NULL,
  solverTeam  TEXT NOT NULL,
  result      TEXT NOT NULL,          -- from the player's side: 'win', 'loss' or 'draw'
  turns       INTEGER NOT NULL DEFAULT 0,
  resigned    INTEGER NOT NULL DEFAULT 0,
  playerElo   REAL NOT NULL DEFAULT 0,
  solverElo   REAL NOT NULL DEFAULT 0,
  -- 'open' or 'closed'. Only open-sheet games are rated, so every row written from now on says
  -- 'open'; the default is what every row that predates the rule was.
  sheet       TEXT NOT NULL DEFAULT 'closed',
  meta        TEXT,                   -- JSON: the teams, the lookahead, the pool, the seed
  log         TEXT                    -- JSON: the whole turn log
);

-- The leaderboards read by rating inside a format, and the history reads by player and by time.
CREATE INDEX IF NOT EXISTS teams_board ON teams (format, side, elo DESC);
CREATE INDEX IF NOT EXISTS players_board ON players (format, elo DESC);
CREATE INDEX IF NOT EXISTS games_player ON games (player, at DESC);
CREATE INDEX IF NOT EXISTS games_when ON games (at DESC);


-- ---------------------------------------------------------------------------
-- MIGRATIONS TO RUN BY HAND, IN THIS ORDER
-- ---------------------------------------------------------------------------
--
-- Nothing below runs from this file: `CREATE TABLE IF NOT EXISTS` does not touch a table that
-- already exists, so a column added to the definition above does NOT appear on a database that
-- was created before it. It has to be added, once, by hand.
--
-- 1. ADD THE SHEET COLUMN -- BEFORE deploying the report route that writes it.
--
--    Every insert in report.js names `games.sheet`. Until this has run, every report of a
--    finished game fails with a 500 on the live database, so this is the first step and the
--    deploy is the second. (The leaderboard is the other way round and needs no care: it falls
--    back to counting every game when the column is not there yet.)
--
--      npx wrangler d1 execute cbd-play --remote \
--        --command "ALTER TABLE games ADD COLUMN sheet TEXT NOT NULL DEFAULT 'closed'"
--
--    Every row already in the table is a game played before only-open-sheet games were rated,
--    and every one of them was a CLOSED-sheet game: the toggle did not exist and the worker
--    played the closed sheet. The column's default says exactly that, so the existing rows need
--    no UPDATE. Check it with:
--
--      npx wrangler d1 execute cbd-play --remote \
--        --command "SELECT sheet, COUNT(*) FROM games GROUP BY sheet"
--
-- 2. DEPLOY. From here on `games` records which sheet each game was, and the board's total
--    counts the open ones -- which are the only games any of the three boards is made of.
--
-- 3. DECIDE WHAT TO DO WITH THE RATINGS THE CLOSED GAMES LEFT BEHIND. This is a judgement, not
--    a migration, which is why it is not written as one. The `players` and `teams` rows were
--    moved by those closed-sheet games, and no column records which part of a rating came from
--    where, so the boards still show ratings that an Open-only board cannot explain. Either:
--
--    (a) leave them, and treat the closed games as the ladder's early history; or
--    (b) start the rated ladder clean, keeping every game ever played as the record of it:
--
--      npx wrangler d1 execute cbd-play --remote --command "DELETE FROM players"
--      npx wrangler d1 execute cbd-play --remote --command "DELETE FROM teams"
--
--    (b) deliberately does NOT touch `games`: the log of every game is the one thing on this
--    ladder that cannot be re-derived, and a rating can.
--
-- 4. THERE IS NOTHING TO MIGRATE FOR THE GAME IDS. Rows written before `games.id` became the
--    game's own id are random uuids; they clash with nothing and are simply never matched by a
--    replay check, which is correct -- those games cannot be re-reported by a client that has
--    long since closed.
