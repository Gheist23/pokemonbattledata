// Seasons that have stopped collecting snapshots and whose raw dated CSVs are
// no longer uploaded to Cloudflare Pages, which rejects any deployment above
// 20,000 files. No rows are lost: generate-manifest.mjs mirrors every dated row
// into data/api/pokemon/<slug>.json, which is what the JSON API reads, so
// ?season=<name>&days= keeps returning exactly what those CSVs held.
//
// tools/deploy.mjs uses this to decide what to leave out of an upload and
// tools/generate-manifest.mjs uses it to mark the affected sources, so add a
// season here and both stay in step.
// Empty since 2026-09-15: every past season was pruned to its single closing
// snapshot, which took the deployment from ~20,400 files to ~11,000 -- far
// under the cap, so nothing needs leaving out. Parking M4 here would now
// break the season dropdown: app.js has no handling for `archived` and
// ensureBattleData throws on the 404 rather than falling back to the API
// mirror. Re-add a season only if a deployment approaches 20,000 files.
export const archivedSeasons = [];

export const archivedSeasonPaths = archivedSeasons.map(
  (season) => `pokemon_champions_assets/battle_data/${season}`
);

export function isArchivedSeason(season) {
  return archivedSeasons.some((entry) => entry.toLowerCase() === String(season || "").toLowerCase());
}
