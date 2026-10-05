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

// --- the live season's own history ------------------------------------------------------
//
// The season that is still collecting adds one dated snapshot a day, and a snapshot is 524
// files. Measured on 5 Oct 2026 the upload had reached 20,486 -- 486 OVER the cap, so every
// deploy was already failing, this one and the daily pipeline's alike, and a one-off
// `--exclude` would have fixed exactly one of them.
//
// So the retention is computed rather than listed: the newest KEEP_DAILY_SNAPSHOTS dated
// snapshots of each season go up and the older ones are parked. Nothing is deleted -- the
// files stay on disk and in git -- and nothing is lost, because every row in them is
// mirrored inside data/api/pokemon/<slug>.json, which is what
// functions/api/_common.js:getEmbeddedDailyRows answers a dated request from. That mirror
// was written for this. Verified before switching it on: all 8,326 CSVs in the 16 oldest M6
// snapshots are mirrored, with no gaps.
//
// 7 keeps the upload around 12,200 files, which is about fifteen days of headroom. Raise it
// if you want a longer raw history on the CDN and the file count allows; the deploy prints
// the count and refuses above 20,000 either way.
export const KEEP_DAILY_SNAPSHOTS = 7;

/** A dated folder name (`03_10_2026`) as a sortable number, or null if it is not one. */
function snapshotOrder(name) {
  const match = /^(\d{2})_(\d{2})_(\d{4})$/.exec(String(name || ""));
  return match ? Number(`${match[3]}${match[2]}${match[1]}`) : null;
}

/**
 * The dated snapshot folders to leave out of an upload: everything but the newest
 * KEEP_DAILY_SNAPSHOTS of each season.
 *
 * @param {(path: string) => string[]} listDirectory  readdirSync, injected so this file stays
 *   importable from anywhere without reaching for the filesystem itself.
 * @param {string} root  the site root
 */
export function parkedSnapshotPaths(listDirectory, root) {
  const base = `${root}/pokemon_champions_assets/battle_data`;
  let seasons = [];
  try {
    seasons = listDirectory(base);
  } catch {
    return [];
  }
  const parked = [];
  for (const season of seasons) {
    let dated = [];
    try {
      dated = listDirectory(`${base}/${season}`)
        .map((name) => [name, snapshotOrder(name)])
        .filter(([, order]) => order !== null)
        .sort((a, b) => b[1] - a[1]);
    } catch {
      continue;
    }
    for (const [name] of dated.slice(KEEP_DAILY_SNAPSHOTS)) {
      parked.push(`pokemon_champions_assets/battle_data/${season}/${name}`);
    }
  }
  return parked;
}
