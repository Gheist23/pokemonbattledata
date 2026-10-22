// The /play/ ladder (functions/api/play/*).
//
// The endpoints are run against an in-memory stand-in for D1 -- node:sqlite, with the same
// `prepare().bind().first()/run()/all()` surface the Workers binding has, and a `batch` that is a
// real TRANSACTION like D1's is -- so the SQL, the Elo and the shapes are all really exercised
// without a deployment.
//
// What is checked:
//   1. without the binding every route answers 503 and says so, and nothing throws;
//   2. a reported game writes the player, both teams and the game itself;
//   3. Elo moves the right way, by the right amount, and both teams move opposite each other;
//   4. a different team is a NEW entry at the default rating -- which is what "submit a new team
//      and it resets" means;
//   5. rubbish is refused by shape: no id, no name, a made-up result, a 10,000-turn game;
//   6. the leaderboard ranks by rating, hides anything under the minimum, and is per format;
//   7. ONLY an Open Team Sheet game is rated. A closed one, or one that says nothing -- which is
//      what a page cached from before the toggle existed sends -- is refused with a 409 and left
//      off the ladder entirely, writing no player, no team and no game. The status matters: a
//      200 would be read as a rating by both clients and would blank the result screen.
//   8. a game cannot be reported TWICE. The same `clientGameId` from the same device moves the
//      ratings once and ever after is answered with the rating it already earned, so a client
//      retrying after a network error keeps its game instead of being rated for it again. And one
//      device cannot report two DIFFERENT games inside the floor, which is what the file's header
//      has always claimed;
//   9. two games finishing together both count. The counters are increments in SQL rather than
//      absolutes worked out from a read, so the later writer cannot overwrite the earlier one on
//      the Solver-team row that every single game touches;
//  10. every game records WHICH SHEET it was, and an open-only board counts only open games --
//      including the closed ones already in the live database from before the rule;
//  11. `foeName` is resolved against the shipped tournament-team library rather than believed, so
//      the client cannot invent a row on "Best Solver teams" or rank itself on it. A library that
//      cannot be read degrades to believing the name rather than refusing every game;
//  12. a body that would not fit in the audit columns is REFUSED rather than stored half-written,
//      the turn ceiling is the game's own, and an unrecognised format is refused rather than
//      quietly rated as Doubles;
//  13. renaming a team shows on the board.
//
//   node tests/run-play-ladder.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ELO, K, elo } from "../functions/api/play/_lib.js";
import { onRequestPost } from "../functions/api/play/report.js";
import { onRequestGet } from "../functions/api/play/leaderboard.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const near = (label, got, want, tolerance) =>
  ok(label, Math.abs(got - want) <= tolerance, `${got} vs ${want} (+-${tolerance})`);

/** Enough of a D1 binding for these two routes, over node:sqlite.
 *  Statements remember their own SQL and arguments, because `batch` has to really execute them
 *  and D1 hands the prepared statements to it rather than the strings.
 *
 *  `holdFirstBatch` is how check 9 interleaves two reports WITHOUT depending on how the event
 *  loop happens to fall: the first report's writes are held until the second has done all of its
 *  reads, which is exactly the read-modify-write race. Left out, nothing is held. */
function tracingDb({ holdFirstBatch = null, withoutSheet = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(join(root, "functions", "api", "play", "schema.sql"), "utf8");
  // `withoutSheet` is the live database as it stands BEFORE the migration at the bottom of
  // schema.sql has been run by hand.
  db.exec(withoutSheet ? schema.replace(/^\s*sheet\s+TEXT.*$/m, "") : schema);
  let hold = holdFirstBatch;
  const make = (sql) => {
    const api = {
      _sql: sql,
      _args: [],
      bind(...values) { api._args = values; return api; },
      async first() { return db.prepare(sql).all(...api._args)[0] || null; },
      async all() { return { results: db.prepare(sql).all(...api._args) }; },
      async run() { db.prepare(sql).run(...api._args); return { success: true }; },
    };
    return api;
  };
  return {
    prepare: make,
    // D1's batch is ONE transaction: a statement that fails takes the whole batch down with it
    // and nothing it had already written stays. The replay check depends on that being true here
    // too -- the point of the fix is that a repeat fails the first INSERT and no rating moves.
    //
    // There is no `await` between BEGIN and COMMIT on purpose: this body runs to completion in
    // one go, so two batches in flight together cannot nest a transaction inside each other.
    async batch(list) {
      if (hold) {
        const waiting = hold;
        hold = null;
        await waiting;
      }
      db.exec("BEGIN");
      const out = [];
      try {
        for (const entry of list) {
          if (/^\s*select/i.test(entry._sql)) out.push({ results: db.prepare(entry._sql).all(...entry._args) });
          else {
            db.prepare(entry._sql).run(...entry._args);
            out.push({ success: true });
          }
        }
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      db.exec("COMMIT");
      return out;
    },
    _raw: db,
  };
}

// The real tournament-team library, served the way Pages serves it. `foeName` is resolved
// against this rather than believed, so the test has to hand the route the real file.
const knownTeamsText = readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8");
const KNOWN_TEAMS = JSON.parse(knownTeamsText).teams;
const KNOWN_TEAM = KNOWN_TEAMS[0][0];

function assets({ broken = false } = {}) {
  return {
    async fetch(url) {
      if (broken) return new Response("no", { status: 500 });
      const path = new URL(url).pathname.replace(/^\/+/, "");
      if (path === "data/builder/known-teams.json") return new Response(knownTeamsText, { status: 200 });
      return new Response("not found", { status: 404 });
    },
  };
}

/** A server with the ladder switched on.
 *  `gap` is the per-device floor in milliseconds; the checks that post a dozen games in the same
 *  millisecond switch it off, and check 8 is the one that leaves it at its shipped default. */
const serverWith = ({ gap = 0, holdFirstBatch = null, broken = false, withoutSheet = false } = {}) => ({
  PLAY: tracingDb({ holdFirstBatch, withoutSheet }),
  ASSETS: assets({ broken }),
  ...(gap === null ? {} : { PLAY_REPORT_GAP_MS: String(gap) }),
});

const post = (env, body) => onRequestPost({
  request: new Request("https://example.com/api/play/report", { method: "POST", body: JSON.stringify(body) }),
  env,
});
const get = (env, format) => onRequestGet({
  request: new Request(format === undefined
    ? "https://example.com/api/play/leaderboard"
    : `https://example.com/api/play/leaderboard?format=${encodeURIComponent(format)}`),
  env,
});

const TEAM = [
  { species: "Garchomp", form: "Garchomp", item: "Life Orb", ability: "Rough Skin", nature: "Jolly", moves: ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"] },
  { species: "Incineroar", form: "Incineroar", item: "Sitrus Berry", ability: "Intimidate", nature: "Careful", moves: ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"] },
];

// One per call, as the client mints one per game. The replay checks keep a body and send that
// same one twice rather than calling this twice.
let gameNo = 0;
const game = (extra = {}) => ({
  device: "a1b2c3d4e5f60718",
  name: "Tester",
  format: "Doubles",
  result: "win",
  turns: 9,
  teamName: "My team",
  // The opponent is one of the Solver's tournament teams, by its name in the shipped library.
  foeName: KNOWN_TEAM,
  // Only an Open Team Sheet game is rated, so the default payload is one.
  sheet: "open",
  clientGameId: `g${(gameNo += 1)}`,
  team: TEAM,
  log: [{ turn: 1, plays: [{ side: 0, text: "Garchomp: Earthquake" }] }],
  ...extra,
});

/** Let everything that is already in flight get as far as it can. */
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };

const rows = (env, sql) => env.PLAY._raw.prepare(sql).all();
/** The first row, or an empty one. A check that reads a column of a row that is not there must
 *  report a failed check rather than throw and take the other 119 with it. */
const one = (env, sql) => rows(env, sql)[0] || {};
const countOf = (env, table) => Number(one(env, `SELECT COUNT(*) AS n FROM ${table}`).n) || 0;

// ---------------------------------------------------------------------------
// 1. not configured
// ---------------------------------------------------------------------------
{
  const report = await post({}, game());
  ok("without a database the report answers 503", report.status === 503, String(report.status));
  const body = await report.json();
  ok("and says why in words", /not configured/i.test(body.error || ""), JSON.stringify(body));
  const board = await get({}, "Doubles");
  ok("the leaderboard answers 503 too", board.status === 503, String(board.status));
}

// ---------------------------------------------------------------------------
// 7. only an open sheet is rated
// ---------------------------------------------------------------------------
{
  for (const [label, sheet] of [["a closed sheet", "closed"], ["no sheet at all", undefined], ["a made-up one", "banana"]]) {
    const env = serverWith();
    const payload = game();
    if (sheet === undefined) delete payload.sheet;
    else payload.sheet = sheet;
    const response = await post(env, payload);
    // 409, deliberately not 200: a 2xx is an ANSWER, and both clients read an answer as a
    // rating and reach into `answer.player.elo`. A body with no player on it then throws inside
    // the render that shows the result, blanking the page on the very client this branch is for.
    ok(`${label} is refused with a non-2xx`, response.status === 409, String(response.status));
    ok(`${label} is not ok, so the client yields null`, response.ok === false, String(response.ok));
    const body = await response.json();
    ok(`${label} is not rated`, body.ranked === false, JSON.stringify(body));
    ok(`${label} says why in words`, /open team sheet/i.test(body.reason || ""), JSON.stringify(body));
    // Nothing at all may be written: a rating that counts half a game is worse than one that
    // counts none of it.
    ok(`${label} writes no player`, countOf(env, "players") === 0);
    ok(`${label} writes no team`, countOf(env, "teams") === 0);
    ok(`${label} writes no game`, countOf(env, "games") === 0);
  }
  // And the open one still goes through, so the gate is not simply refusing everything.
  const env = serverWith();
  const through = await post(env, game({ sheet: "open" }));
  ok("an open sheet is still accepted", through.status === 201, String(through.status));
  ok("and is recorded as open",
    JSON.parse(one(env, "SELECT * FROM games").meta || "{}").sheet === "open");
}

// ---------------------------------------------------------------------------
// 2 + 3. a game is recorded, and the ratings move
// ---------------------------------------------------------------------------
{
  const env = serverWith();
  const response = await post(env, game());
  ok("a reported game is accepted", response.status === 201, String(response.status));
  const body = await response.json();

  const players = rows(env, "SELECT * FROM players");
  const teams = rows(env, "SELECT * FROM teams ORDER BY side");
  const games = rows(env, "SELECT * FROM games");
  ok("the player is on the ladder", players.length === 1 && (players[0] || {}).name === "Tester", JSON.stringify(players));
  ok("both teams are", teams.length === 2, JSON.stringify(teams.map((t) => t.side)));
  ok("and the game itself is kept", games.length === 1, String(games.length));
  ok("with its log", JSON.parse((games[0] || {}).log || "[]").length === 1);
  ok("and its metadata", JSON.parse((games[0] || {}).meta || "{}").foeName === KNOWN_TEAM);

  // A win from 1000 against 1000 is half of K.
  const [expected] = elo(DEFAULT_ELO, DEFAULT_ELO, 1, K);
  near("a win from level moves the player by half of K", (players[0] || {}).elo, expected, 1e-9);
  near("and it is 12 points", (players[0] || {}).elo - DEFAULT_ELO, K / 2, 1e-9);
  const mine = teams.find((t) => t.side === "player") || {};
  const theirs = teams.find((t) => t.side === "solver") || {};
  near("the winning team gains", mine.elo, DEFAULT_ELO + K / 2, 1e-9);
  near("and the losing team loses exactly as much", DEFAULT_ELO - theirs.elo, K / 2, 1e-9);
  ok("the records are kept both ways round",
    mine.wins === 1 && mine.losses === 0 && theirs.wins === 0 && theirs.losses === 1,
    JSON.stringify([mine.wins, mine.losses, theirs.wins, theirs.losses]));
  ok("the answer tells the page the new ratings", body.player?.elo === Math.round(expected), JSON.stringify(body));
  notes.push(`elo: a win from level is ${Math.round(expected)} for the player, ${Math.round(theirs.elo)} for the team beaten`);

  // A draw against the same team moves nothing much, and a loss gives it back.
  await post(env, game({ result: "draw", turns: 40 }));
  await post(env, game({ result: "loss" }));
  const after = one(env, "SELECT * FROM players");
  ok("three games are three games", after.games === 3, String(after.games));
  ok("win, draw and loss are each counted",
    after.wins === 1 && after.draws === 1 && after.losses === 1,
    JSON.stringify([after.wins, after.draws, after.losses]));
}

// ---------------------------------------------------------------------------
// 4. a different team is a different entry
// ---------------------------------------------------------------------------
{
  const env = serverWith();
  await post(env, game());
  await post(env, game({ result: "win" }));
  const before = rows(env, "SELECT * FROM teams WHERE side = 'player'");
  ok("the same team twice is one entry", before.length === 1, String(before.length));
  ok("with two games on it", (before[0] || {}).games === 2, String((before[0] || {}).games));

  // One move changed, and it is a new team with a fresh record.
  const changed = TEAM.map((set, i) => (i ? set : { ...set, moves: ["Earthquake", "Dragon Claw", "Rock Slide", "Swords Dance"] }));
  await post(env, game({ team: changed, teamName: "My team v2" }));
  const after = rows(env, "SELECT * FROM teams WHERE side = 'player' ORDER BY games DESC");
  ok("a team with one move changed is a NEW entry", after.length === 2, JSON.stringify(after.map((t) => t.name)));
  const fresh = after.find((t) => t.games === 1) || {};
  ok("starting from the default rating plus its first result", fresh.games === 1, JSON.stringify(fresh));
  near("which is one game's worth of movement, not two", fresh.elo - DEFAULT_ELO, K / 2, 1.5);
  notes.push(`teams: changing one move made a second entry at ${Math.round(fresh.elo)} with 1 game`);
}

// ---------------------------------------------------------------------------
// 5. rubbish is refused
// ---------------------------------------------------------------------------
{
  const env = serverWith();
  const cases = [
    ["no player id", { device: "" }],
    ["a player id that is not one", { device: "not-a-real-id" }],
    ["no name", { name: "" }],
    ["a result that is not a result", { result: "brilliant" }],
  ];
  for (const [label, patch] of cases) {
    const response = await post(env, game(patch));
    ok(`${label} is refused`, response.status === 400, String(response.status));
  }
  // A turn count out of range is clamped rather than refused: it is a mis-send, not an attack.
  await post(env, game({ turns: 99999 }));
  const kept = rows(env, "SELECT turns FROM games");
  ok("an impossible turn count is clamped, not stored", kept.every((row) => row.turns <= 40),
    JSON.stringify(kept.map((r) => r.turns)));
  ok("and nothing refused was written", countOf(env, "games") === 1, String(countOf(env, "games")));

  // A name with markup in it comes back as letters.
  const dirty = await post(env, game({ device: "ffffffffffffffff", name: "<img src=x onerror=1>Bob" }));
  ok("a name with markup is accepted after it is cleaned", dirty.status === 201, String(dirty.status));
  const named = one(env, "SELECT name FROM players WHERE id = 'ffffffffffffffff'");
  ok("and what is stored has no markup in it", !/[<>]/.test(named.name || ""), String(named.name));
  notes.push(`names: "<img src=x onerror=1>Bob" is stored as "${named.name}"`);
}

// ---------------------------------------------------------------------------
// 6. the leaderboard
// ---------------------------------------------------------------------------
{
  const env = serverWith();
  // Three players, different records, enough games to be ranked.
  const people = [
    ["1111111111111111", "Winner", ["win", "win", "win", "win"]],
    ["2222222222222222", "Middle", ["win", "loss", "win", "loss"]],
    ["3333333333333333", "Loser", ["loss", "loss", "loss", "loss"]],
    ["4444444444444444", "TooFew", ["win"]],
  ];
  for (const [device, name, results] of people) {
    for (const result of results) await post(env, game({ device, name, result, teamName: `${name}'s team` }));
  }
  // And one Singles game, which must not show on the Doubles board.
  await post(env, game({ device: "5555555555555555", name: "SinglesOnly", format: "Singles" }));

  const response = await get(env, "Doubles");
  ok("the board answers", response.status === 200, String(response.status));
  const board = await response.json();
  ok("it names the format", board.format === "Doubles", board.format);
  ok("the best player is first", board.players[0]?.name === "Winner", JSON.stringify(board.players.map((p) => p.name)));
  ok("and the worst is last", board.players[board.players.length - 1]?.name === "Loser", JSON.stringify(board.players.map((p) => p.name)));
  ok("a player with too few games is not ranked", !board.players.some((p) => p.name === "TooFew"),
    JSON.stringify(board.players.map((p) => p.name)));
  ok("nor is somebody who only played the other format",
    !board.players.some((p) => p.name === "SinglesOnly"), JSON.stringify(board.players.map((p) => p.name)));
  ok("the ratings are in order",
    board.players.every((row, i) => i === 0 || board.players[i - 1].elo >= row.elo),
    JSON.stringify(board.players.map((p) => p.elo)));
  ok("every row carries its record", board.players.every((row) => typeof row.games === "number" && row.games >= 3));
  ok("each player's team is its own entry, not one shared by everyone who brings the same six",
    board.playerTeams.length === 3, JSON.stringify(board.playerTeams.map((t) => `${t.name} ${t.games}`)));
  ok("and the Solver's teams are", board.solverTeams.length >= 1, JSON.stringify(board.solverTeams.map((t) => t.name)));
  ok("every reported game is kept, none lost to a clashing id", board.games === 13, String(board.games));

  const singles = await (await get(env, "Singles")).json();
  ok("the other format is its own board", singles.games === 1, String(singles.games));

  // A player is rated per format, so somebody who wins in one and loses in the other carries two
  // different ratings rather than one averaged over games that were not the same game.
  for (const result of ["win", "win", "win"]) {
    await post(env, game({ device: "6666666666666666", name: "Both", result, format: "Doubles" }));
  }
  for (const result of ["loss", "loss", "loss"]) {
    await post(env, game({ device: "6666666666666666", name: "Both", result, format: "Singles" }));
  }
  const d = await (await get(env, "Doubles")).json();
  const s = await (await get(env, "Singles")).json();
  const inD = d.players.find((row) => row.name === "Both");
  const inS = s.players.find((row) => row.name === "Both");
  ok("the same player is on both boards", Boolean(inD) && Boolean(inS),
    JSON.stringify([d.players.map((p) => p.name), s.players.map((p) => p.name)]));
  ok("with a different rating on each", inD && inS && inD.elo > 1000 && inS.elo < 1000,
    JSON.stringify([inD?.elo, inS?.elo]));
  ok("and a record counted only from that format's games",
    inD && inS && inD.wins === 3 && inD.losses === 0 && inS.wins === 0 && inS.losses === 3,
    JSON.stringify([inD?.wins, inD?.losses, inS?.wins, inS?.losses]));
  notes.push(`per format: the same player is ${Math.round(inD?.elo)} in Doubles and ${Math.round(inS?.elo)} in Singles`);
  notes.push(`board: ${board.players.length} ranked players, ${board.playerTeams.length} teams, ${board.games} Doubles games`);

  // The board defaults to Doubles when it is asked without a format, and refuses one it does not
  // know rather than answering with the Doubles board under a Singles heading.
  const bare = await get(env, undefined);
  ok("the board with no format asked is the Doubles one", (await bare.json()).format === "Doubles");
  const nonsense = await get(env, "Triples");
  ok("a format the board does not know is refused", nonsense.status === 400, String(nonsense.status));
}

// ---------------------------------------------------------------------------
// 8. a game can be reported only once, and not too often
// ---------------------------------------------------------------------------
{
  const env = serverWith();
  const body = game({ clientGameId: "g77" });
  const first = await post(env, body);
  ok("the first report of a game is accepted", first.status === 201, String(first.status));
  const firstAnswer = await first.json();
  const afterFirst = one(env, "SELECT * FROM players");

  // The same body again, exactly as a captured one replayed or a client retrying would send it.
  const again = await post(env, body);
  ok("the same game reported twice is one game", countOf(env, "games") === 1, String(countOf(env, "games")));
  const afterSecond = one(env, "SELECT * FROM players");
  ok("and the ratings have not moved a second time",
    afterSecond.elo === afterFirst.elo && afterSecond.games === 1,
    JSON.stringify([afterFirst.elo, afterSecond.elo, afterSecond.games]));
  ok("nor has the team's record", one(env, "SELECT * FROM teams WHERE side = 'player'").games === 1);
  // A legitimate client that retries after a network error must not LOSE its game: the repeat is
  // answered with the rating the game already earned, which is what the result screen fills in.
  ok("a repeat is answered rather than failed", again.status === 200 && again.ok === true, String(again.status));
  const repeat = await again.json();
  ok("it says it is a repeat", repeat.duplicate === true, JSON.stringify(repeat));
  ok("and carries the rating the game already earned",
    repeat.player?.elo === firstAnswer.player?.elo && repeat.team?.elo === firstAnswer.team?.elo,
    JSON.stringify([repeat.player, firstAnswer.player]));

  // Ten more replays of the same body, which is the attack: N reports used to move the rating N
  // times and could set any number on the board.
  for (let i = 0; i < 10; i += 1) await post(env, body);
  const afterMany = one(env, "SELECT * FROM players");
  ok("ten replays move nothing at all",
    afterMany.elo === afterFirst.elo && afterMany.games === 1 && countOf(env, "games") === 1,
    JSON.stringify([afterMany.elo, afterMany.games, countOf(env, "games")]));

  // The id is only an id WITHIN a device. Two people whose games are both the worker's third
  // game of the session must both count.
  const two = serverWith();
  const a = await post(two, game({ device: "aaaaaaaaaaaaaaaa", name: "Ay", clientGameId: "g3" }));
  const b = await post(two, game({ device: "bbbbbbbbbbbbbbbb", name: "Bee", clientGameId: "g3" }));
  ok("the same id from two devices is two games",
    a.status === 201 && b.status === 201 && countOf(two, "games") === 2,
    JSON.stringify([a.status, b.status, countOf(two, "games")]));

  // An older cached page sends no id at all. It still works -- it simply has the floor rather
  // than the id protecting it.
  const old = serverWith();
  const noId = game();
  delete noId.clientGameId;
  const oldOne = await post(old, noId);
  ok("a page that sends no game id is still accepted", oldOne.status === 201, String(oldOne.status));

  // The floor, at its shipped default: one device, two different games, the same millisecond.
  const floor = serverWith({ gap: null });
  const kept = game({ clientGameId: "gf1" });
  const inFirst = await post(floor, kept);
  ok("the first game goes through with the floor on", inFirst.status === 201, String(inFirst.status));
  const quick = await post(floor, game({ clientGameId: "gf2" }));
  ok("a second game in the same second is refused", quick.status === 429, String(quick.status));
  const quickBody = await quick.json();
  ok("and is not rated", quickBody.ranked === false, JSON.stringify(quickBody));
  ok("nothing was written for it",
    countOf(floor, "games") === 1 && one(floor, "SELECT * FROM players").games === 1,
    JSON.stringify([countOf(floor, "games"), one(floor, "SELECT * FROM players").games]));
  // ...but a retry of the game that DID go through is still recognised, floor or no floor, so a
  // network error never costs a player their game.
  const retry = await post(floor, kept);
  ok("a retry inside the floor is still answered with its rating",
    retry.status === 200 && (await retry.json()).duplicate === true, String(retry.status));
  notes.push("replay: twelve reports of one captured body moved the rating once");
}

// ---------------------------------------------------------------------------
// 9. two games finishing together both count
// ---------------------------------------------------------------------------
{
  // Both games are against the SAME tournament team, which is the row that every game on the
  // ladder touches and the one an absolute write loses increments on.
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const env = serverWith({ holdFirstBatch: held });

  // The first report reads, then stops with its writes still in its hand.
  const firstReport = post(env, game({ device: "1212121212121212", name: "One", result: "win", clientGameId: "x1" }));
  await settle();
  // The second now reads the very same rows -- neither of them can see the other's game.
  const secondReport = post(env, game({ device: "3434343434343434", name: "Two", result: "win", clientGameId: "x2" }));
  await settle();
  release();
  const [a, b] = await Promise.all([firstReport, secondReport]);
  ok("both reports are accepted", a.status === 201 && b.status === 201, JSON.stringify([a.status, b.status]));
  ok("both games are kept", countOf(env, "games") === 2, String(countOf(env, "games")));
  const solver = rows(env, "SELECT * FROM teams WHERE side = 'solver'");
  ok("the Solver's team is one row", solver.length === 1, String(solver.length));
  ok("with BOTH games counted on it", (solver[0] || {}).games === 2, String((solver[0] || {}).games));
  ok("and both losses", (solver[0] || {}).losses === 2, String((solver[0] || {}).losses));
  // Both read the row at 1000, so both deltas are half of K: the increments add up even though
  // neither report could see the other's.
  near("its rating moved for both games, not one", DEFAULT_ELO - (solver[0] || {}).elo, K, 1.5);
  ok("each player got their own row", countOf(env, "players") === 2, String(countOf(env, "players")));
  notes.push(`atomicity: two games finishing together left the Solver row at ${Math.round((solver[0] || {}).elo)} with ${(solver[0] || {}).games} games`);
}

// ---------------------------------------------------------------------------
// 10. which sheet a game was
// ---------------------------------------------------------------------------
{
  const env = serverWith();
  await post(env, game());
  const row = one(env, "SELECT * FROM games");
  ok("a game records which sheet it was played on", row.sheet === "open", String(row.sheet));

  // A row of the kind the live database is already full of: a Closed-sheet game from before the
  // rule. An Open-only board must not count it.
  let planted = "";
  try {
    env.PLAY._raw.prepare(`INSERT INTO games
      (id, at, format, player, playerTeam, solverTeam, result, turns, resigned, playerElo, solverElo, sheet, meta, log)
      VALUES ('old', 1, 'Doubles', 'a1b2c3d4e5f60718', 'p', 's', 'win', 7, 0, 1000, 1000, 'closed', '{}', '[]')`).run();
  } catch (error) {
    planted = String(error.message || error);
  }
  ok("a closed game from before the rule can be stored at all", planted === "", planted);
  const board = await (await get(env, "Doubles")).json();
  ok("the board counts only the games it rates", board.games === 1, String(board.games));

  const schema = readFileSync(join(root, "functions", "api", "play", "schema.sql"), "utf8");
  ok("the schema file says what has to be run against the live database by hand",
    /ALTER TABLE games\s+ADD COLUMN sheet/i.test(schema) && /by hand/i.test(schema));
  ok("and in what order", /^--\s*1\./m.test(schema));
}

// ---------------------------------------------------------------------------
// 11. the opponent is resolved, not believed
// ---------------------------------------------------------------------------
{
  const env = serverWith();
  const real = await post(env, game({ foeName: KNOWN_TEAM }));
  ok("a real tournament team is accepted", real.status === 201, String(real.status));
  ok("and is the name on the board", one(env, "SELECT * FROM teams WHERE side = 'solver'").name === KNOWN_TEAM);

  const invented = await post(env, game({ device: "dddddddddddddddd", foeName: "My own team" }));
  ok("a made-up opponent is refused", invented.status === 400, String(invented.status));
  ok("and writes nothing", countOf(env, "games") === 1, String(countOf(env, "games")));
  ok("the board has no row for it", countOf(env, "teams") === 2, String(countOf(env, "teams")));

  const missing = await post(env, game({ device: "eeeeeeeeeeeeeeee", foeName: "" }));
  ok("so is no opponent at all", missing.status === 400, String(missing.status));

  // The same team under another casing is the same row, not a second one.
  const cased = await post(env, game({ device: "cdcdcdcdcdcdcdcd", foeName: KNOWN_TEAM.toUpperCase() }));
  ok("a differently cased name is accepted", cased.status === 201, String(cased.status));
  const solverRows = rows(env, "SELECT * FROM teams WHERE side = 'solver'");
  ok("and lands on the same row under the library's own spelling",
    solverRows.length === 1 && (solverRows[0] || {}).name === KNOWN_TEAM && (solverRows[0] || {}).games === 2,
    JSON.stringify(solverRows.map((t) => `${t.name} ${t.games}`)));

  // The library not being readable must not take the whole ladder down with it.
  const blind = serverWith({ broken: true });
  const degraded = await post(blind, game({ foeName: "Some Team" }));
  ok("a library that cannot be read still rates the game", degraded.status === 201, String(degraded.status));
  ok("and the game says the name was not checked",
    JSON.parse(one(blind, "SELECT * FROM games").meta || "{}").foeChecked === false,
    one(blind, "SELECT * FROM games").meta);
  notes.push(`opponents: "${KNOWN_TEAM}" is resolved against ${KNOWN_TEAMS.length} library teams; "My own team" is refused`);
}

// ---------------------------------------------------------------------------
// 12. a body that will not fit is refused, not cut in half
// ---------------------------------------------------------------------------
{
  const env = serverWith();
  // Big enough to overflow the audit column, small enough to pass the whole-body size check:
  // exactly the window in which the column used to be filled with unparseable JSON.
  const hugeLog = [{ turn: 1, text: "x".repeat(205000) }];
  const big = await post(env, game({ log: hugeLog }));
  ok("a log too big for its column is refused", big.status === 413, String(big.status));
  ok("and nothing is written for it", countOf(env, "games") === 0, String(countOf(env, "games")));

  const hugeTeam = [{ species: "Garchomp", form: "x".repeat(205000), item: "", ability: "", nature: "", moves: [] }];
  const bigMeta = await post(env, game({ team: hugeTeam }));
  ok("so is a team too big for the metadata column", bigMeta.status === 413, String(bigMeta.status));

  // What IS stored is always valid JSON, which is the whole point of refusing.
  await post(env, game());
  const stored = one(env, "SELECT meta, log FROM games");
  let parsed = true;
  try { JSON.parse(stored.meta); JSON.parse(stored.log); } catch { parsed = false; }
  ok("what is stored parses", parsed, JSON.stringify(stored).slice(0, 120));

  // The ceiling on a turn count is the GAME's own limit, not a number twice as big.
  const limitSource = readFileSync(join(root, "builder", "play-game.js"), "utf8");
  const theirs = Number((limitSource.match(/export const TURN_LIMIT\s*=\s*(\d+)/) || [])[1]);
  const libSource = readFileSync(join(root, "functions", "api", "play", "_lib.js"), "utf8");
  const ours = Number((libSource.match(/TURN_LIMIT\s*=\s*(\d+)/) || [])[1]);
  ok("the ladder's turn ceiling is the game's own", Boolean(theirs) && ours === theirs, `${ours} vs ${theirs}`);
  await post(env, game({ turns: 99999 }));
  const turns = rows(env, "SELECT turns FROM games ORDER BY at DESC").map((r) => r.turns);
  ok("and a turn count beyond it is clamped to it", Math.max(...turns) === theirs, JSON.stringify(turns));

  // A format nobody plays is refused rather than quietly rated as Doubles.
  const wrong = await post(env, game({ device: "0f0f0f0f0f0f0f0f", format: "Triples" }));
  ok("a format that is not one is refused", wrong.status === 400, String(wrong.status));
  const none = game();
  delete none.format;
  ok("so is none at all", (await post(env, none)).status === 400);
  const lower = await post(env, game({ device: "1f1f1f1f1f1f1f1f", format: "singles" }));
  ok("a known format in the wrong case is accepted and canonical", lower.status === 201, String(lower.status));
  ok("and lands on that format's board",
    one(env, "SELECT format FROM players WHERE id = '1f1f1f1f1f1f1f1f'").format === "Singles");
}

// ---------------------------------------------------------------------------
// 13. renaming a team shows
// ---------------------------------------------------------------------------
{
  const env = serverWith();
  await post(env, game({ teamName: "First name" }));
  await post(env, game({ teamName: "Second name" }));
  const renamed = rows(env, "SELECT * FROM teams WHERE side = 'player'");
  ok("a renamed team is one entry, not two", renamed.length === 1, String(renamed.length));
  ok("under its new name", (renamed[0] || {}).name === "Second name", (renamed[0] || {}).name);

  // ...and a report that says nothing about the name keeps the one it had rather than resetting
  // it to the default.
  const quiet = game();
  delete quiet.teamName;
  await post(env, quiet);
  ok("a report with no name keeps the name it had",
    one(env, "SELECT * FROM teams WHERE side = 'player'").name === "Second name",
    one(env, "SELECT * FROM teams WHERE side = 'player'").name);
  notes.push("names: a team's board name is whatever it was last reported as");
}

// ---------------------------------------------------------------------------
// 14. the board still answers on a database the migration has not reached
// ---------------------------------------------------------------------------
//
// MUST STAY LAST. Reading a board whose `games` table has no `sheet` column switches the
// filtered total off for the rest of the process, exactly as it would for the rest of a Worker
// isolate's life, so any check that counts games has to run before this one.
{
  const env = serverWith({ withoutSheet: true });
  ok("the column really is missing", !/sheet/i.test(
    rows(env, "SELECT name FROM pragma_table_info('games')").map((r) => r.name).join(",")));
  env.PLAY._raw.prepare(`INSERT INTO games
      (id, at, format, player, playerTeam, solverTeam, result, turns, resigned, playerElo, solverElo, meta, log)
      VALUES ('one', 1, 'Doubles', 'x', 'p', 's', 'win', 5, 0, 1000, 1000, '{}', '[]')`).run();
  const response = await get(env, "Doubles");
  ok("the board answers rather than breaking", response.status === 200, String(response.status));
  const board = await response.json();
  ok("and counts what it can", board.games === 1, String(board.games));
  notes.push("migration: a board on an unmigrated database still answers, counting every game");
}

for (const line of notes) console.log(line);
if (failures.length) {
  console.error(`\n${checked} checks, ${failures.length} failed:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\n${checked} checks, all passed.`);
