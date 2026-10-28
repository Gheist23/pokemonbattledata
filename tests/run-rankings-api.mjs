// GET /api/rankings, and the per-season ranks in /api/pokemon/<name>.
//
// TWO REQUESTS, BOTH ABOUT THE SAME GAP. The API answered "what is this species doing" and had
// no way to answer "who is at position 7" -- the endpoint is a RANK, not a Pokemon. And
// `summary.battleSummary` carried exactly one key, "Current", because a season-level figure is
// written by a non-daily battle-data CSV and only the live season has one; every archived
// season is a run of daily snapshots. Getting M6's standings therefore meant ~260 requests per
// format and a sort on the client, which is the load this removes.
//
// What is checked here:
//
//   1. the data file: every season and both formats, ordered, no gaps and no duplicates;
//   2. it is REAL history and not the current list relabelled -- M6's top is not Current's;
//   3. the endpoint: defaults, format, season, limit/offset, name lookup, and the errors;
//   4. `summary.battleSummary.<season>.<format>.position` exists for every season, which is
//      the exact path that was asked for;
//   5. nothing already published moved: the keys the old responses carried are all still there.
//
//   node tests/run-rankings-api.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFile, readFileSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

// The same asset stand-in tests/dev-server.mjs uses: the binding reads straight off disk.
const env = {
  ASSETS: {
    async fetch(request) {
      const path = decodeURIComponent(new URL(typeof request === "string" ? request : request.url).pathname)
        .replace(/^[/\\]+/, "");
      try {
        return new Response(await read(join(root, path)), { status: 200 });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  },
};

const rankingsApi = await import(pathToFileURL(join(root, "functions/api/rankings/index.js")).href);

async function get(query = "") {
  const request = new Request(`https://championsbattledata.com/api/rankings${query}`);
  const response = await rankingsApi.onRequestGet({ env, request });
  return { status: response.status, body: await response.json() };
}

const payload = JSON.parse(readFileSync(join(root, "data", "api", "rankings.json"), "utf8"));

// ---------------------------------------------------------------------------
// 1. the data file
// ---------------------------------------------------------------------------
{
  ok("every season is published", payload.seasons.length >= 2, JSON.stringify(payload.seasons));
  ok("Current is one of them", payload.seasons.includes("Current"));
  ok("both formats are published", payload.formats.join(",") === "Doubles,Singles", payload.formats.join(","));
  for (const season of payload.seasons) {
    for (const format of payload.formats) {
      const list = payload.rankings?.[season]?.[format];
      ok(`${season}/${format} has a list`, Array.isArray(list) && list.length > 0, `${list?.length}`);
      if (!Array.isArray(list)) continue;
      // Ordered, gapless and unique: a ranking with a hole or a repeat is not a ranking.
      const positions = list.map((entry) => entry.position);
      ok(`${season}/${format} is in position order`,
        positions.every((value, i) => i === 0 || value >= positions[i - 1]));
      ok(`${season}/${format} has no duplicate position`, new Set(positions).size === positions.length,
        `${positions.length} entries, ${new Set(positions).size} distinct`);
      ok(`${season}/${format} starts at 1`, positions[0] === 1, String(positions[0]));
      ok(`${season}/${format} is gapless`, positions[positions.length - 1] === positions.length,
        `${positions[positions.length - 1]} vs ${positions.length}`);
      ok(`${season}/${format} entries carry what a follow-up needs`,
        list.every((e) => e.name && e.slug && typeof e.showdownId === "string"));
    }
  }
  notes.push(`seasons: ${payload.seasons.join(", ")}`);
  notes.push(`counts: ${JSON.stringify(payload.counts)}`);
}

// ---------------------------------------------------------------------------
// 2. it is real history
// ---------------------------------------------------------------------------
{
  // If a past season were the current list wearing a different label this would be identical,
  // and the whole feature would be a lie that no count check could see.
  const current = payload.rankings.Current.Doubles.slice(0, 5).map((e) => e.name).join(",");
  const past = payload.seasons.filter((s) => s !== "Current");
  const different = past.filter((season) =>
    payload.rankings[season].Doubles.slice(0, 5).map((e) => e.name).join(",") !== current);
  ok("at least one past season's top five differs from Current's", different.length > 0,
    `${past.length} past seasons, ${different.length} differ`);
  // And the oldest seasons had fewer ranked Pokemon, which is the other way the data shows it
  // is really theirs.
  const sizes = new Set(past.map((season) => payload.rankings[season].Doubles.length));
  ok("not every season has the same number of ranked Pokemon", sizes.size > 1, JSON.stringify([...sizes]));
  notes.push(`Current top 3: ${payload.rankings.Current.Doubles.slice(0, 3).map((e) => `${e.position} ${e.name}`).join(", ")}`);
  for (const season of past.slice(0, 2)) {
    notes.push(`${season} top 3:      ${payload.rankings[season].Doubles.slice(0, 3).map((e) => `${e.position} ${e.name}`).join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// 3. the endpoint
// ---------------------------------------------------------------------------
{
  const plain = await get();
  ok("no query answers 200", plain.status === 200, String(plain.status));
  ok("and defaults to Doubles/Current", plain.body.format === "Doubles" && plain.body.season === "Current",
    `${plain.body.format}/${plain.body.season}`);
  ok("with the whole list", plain.body.count === plain.body.total && plain.body.total > 100,
    `${plain.body.count}/${plain.body.total}`);
  ok("and position 1 first", plain.body.rankings[0].position === 1);

  const singles = await get("?format=Singles");
  ok("format=Singles answers Singles", singles.body.format === "Singles", singles.body.format);
  const lower = await get("?format=singles");
  ok("and the format is case-insensitive", lower.body.format === "Singles", lower.body.format);

  const past = payload.seasons.find((s) => s !== "Current");
  const seasonal = await get(`?season=${past}`);
  ok(`season=${past} answers that season`, seasonal.body.season === past, seasonal.body.season);
  const lowerSeason = await get(`?season=${String(past).toLowerCase()}`);
  ok("and the season is case-insensitive", lowerSeason.body.season === past, lowerSeason.body.season);

  const slice = await get("?limit=20&offset=20");
  ok("limit and offset take a slice", slice.body.count === 20, String(slice.body.count));
  ok("and the slice starts where it was asked to", slice.body.rankings[0].position === 21,
    String(slice.body.rankings[0].position));
  ok("the slice still reports the full total", slice.body.total === plain.body.total);

  const named = await get("?name=garchomp");
  ok("name= answers one entry", named.body.rankings.length === 1, String(named.body.rankings.length));
  ok("and it is the one asked for", named.body.rankings[0].slug === "garchomp", named.body.rankings[0].slug);
  ok("with its position", Number.isInteger(named.body.rankings[0].position));
  const bySlug = plain.body.rankings.find((e) => e.slug === "garchomp");
  ok("matching the position in the full list", named.body.rankings[0].position === bySlug.position,
    `${named.body.rankings[0].position} vs ${bySlug.position}`);

  // The refusals, each with the list a caller needs to correct itself.
  const badFormat = await get("?format=Triples");
  ok("an unknown format is a 400", badFormat.status === 400, String(badFormat.status));
  ok("and it says which formats exist", Array.isArray(badFormat.body.formats));
  const badSeason = await get("?season=M99");
  ok("an unknown season is a 400", badSeason.status === 400, String(badSeason.status));
  ok("and it says which seasons exist", Array.isArray(badSeason.body.seasons) && badSeason.body.seasons.length > 1);
  const badLimit = await get("?limit=0");
  ok("limit=0 is a 400", badLimit.status === 400, String(badLimit.status));
  const badOffset = await get("?offset=-1");
  ok("a negative offset is a 400", badOffset.status === 400, String(badOffset.status));
  const unranked = await get("?name=notapokemon");
  ok("an unranked name is a 404", unranked.status === 404, String(unranked.status));
  const farOffset = await get("?offset=100000");
  ok("an offset past the end is an empty list, not an error",
    farOffset.status === 200 && farOffset.body.count === 0, `${farOffset.status}/${farOffset.body.count}`);
}

// ---------------------------------------------------------------------------
// 4. the path that was asked for
// ---------------------------------------------------------------------------
{
  const entry = JSON.parse(readFileSync(join(root, "data", "api", "pokemon", "garchomp.json"), "utf8"));
  const bySeason = entry.summary?.battleSummary || {};
  ok("battleSummary is keyed by season and holds more than Current",
    Object.keys(bySeason).length > 1, Object.keys(bySeason).join(","));
  const missing = [];
  for (const season of Object.keys(bySeason)) {
    for (const format of Object.keys(bySeason[season] || {})) {
      const position = bySeason[season][format]?.position;
      if (!Number.isInteger(position) || position < 1) missing.push(`${season}/${format}=${position}`);
    }
  }
  ok("summary.battleSummary.<season>.<format>.position is there for every one", missing.length === 0,
    missing.join(" "));
  const line = Object.keys(bySeason).map((s) => `${s}:${bySeason[s].Doubles?.position}`).join(" ");
  notes.push(`Garchomp Doubles rank by season -> ${line}`);
  // And it agrees with the rankings file, so the two are one fact rather than two.
  for (const season of Object.keys(bySeason)) {
    const list = payload.rankings?.[season]?.Doubles;
    if (!list) continue;
    const fromList = list.find((e) => e.slug === "garchomp")?.position;
    ok(`${season}: the two sources agree on Garchomp's rank`,
      fromList === bySeason[season].Doubles?.position,
      `${fromList} vs ${bySeason[season].Doubles?.position}`);
  }
}

// ---------------------------------------------------------------------------
// 5. nothing published moved
// ---------------------------------------------------------------------------
{
  // The request was explicit that the API must not break. These are the keys the old responses
  // carried; adding `position` and the extra seasons beside them must not have cost any of them.
  const entry = JSON.parse(readFileSync(join(root, "data", "api", "pokemon", "garchomp.json"), "utf8"));
  for (const key of ["name", "battleName", "slug", "showdownId", "showdownName", "metadataCsv",
    "battleDataCsvs", "learnableMoveNames", "summary"]) {
    ok(`/api/pokemon still carries ${key}`, key in entry);
  }
  for (const key of ["dex", "sprite", "types", "primary", "forms", "baseStats", "baseStatTotal",
    "battleSummary", "dailyBattleSummary"]) {
    ok(`summary still carries ${key}`, key in entry.summary, Object.keys(entry.summary).join(","));
  }
  const current = entry.summary.battleSummary.Current?.Doubles || {};
  for (const key of ["top", "values", "rows"]) {
    ok(`a season summary still carries ${key}`, key in current, Object.keys(current).join(","));
  }
  const index = JSON.parse(readFileSync(join(root, "data", "api", "index.json"), "utf8"));
  for (const key of ["generatedAt", "dataVersion", "assetRoot", "battleDataFolders",
    "dailyDataFolders", "seasons", "defaultSeason", "topicPages", "pokemonPages", "pokemon"]) {
    ok(`/api/index still carries ${key}`, key in index, Object.keys(index).join(","));
  }
}

// ---------------------------------------------------------------------------

if (notes.length) notes.forEach((n) => console.log(`  ${n}`));
if (failures.length) {
  failures.forEach((f) => console.log(`FAIL ${f}`));
  console.log(`${checked} checked, ${failures.length} failed.`);
  process.exit(1);
}
console.log(`${checked} checked, 0 failed.`);
