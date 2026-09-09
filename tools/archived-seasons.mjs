// Seasons that have stopped collecting snapshots and whose raw dated CSVs are
// no longer uploaded to Cloudflare Pages, which rejects any deployment above
// 20,000 files. No rows are lost: generate-manifest.mjs mirrors every dated row
// into data/api/pokemon/<slug>.json, which is what the JSON API reads, so
// ?season=<name>&days= keeps returning exactly what those CSVs held.
//
// tools/deploy.mjs uses this to decide what to leave out of an upload and
// tools/generate-manifest.mjs uses it to mark the affected sources, so add a
// season here and both stay in step.
export const archivedSeasons = ["M4"];

export const archivedSeasonPaths = archivedSeasons.map(
  (season) => `pokemon_champions_assets/battle_data/${season}`
);

export function isArchivedSeason(season) {
  return archivedSeasons.some((entry) => entry.toLowerCase() === String(season || "").toLowerCase());
}
