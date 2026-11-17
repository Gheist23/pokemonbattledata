// WHAT A DEPLOYMENT LEAVES OUT, in one place.
//
// Two things publish this site and they must leave out exactly the same files: tools/deploy.mjs,
// which parks them for the length of a manual upload and puts them back, and
// tools/prune-for-pages.mjs, which deletes them from a Cloudflare Pages build checkout. Written
// twice they would drift, and the drift would show up as a site that is missing something only
// when it is published one of the two ways.
import { archivedSeasonPaths, parkedSnapshotPaths } from "./archived-seasons.mjs";

/**
 * Local-only scaffolding that must never become a public asset.
 *
 * Wrangler already skips .git, node_modules and .wrangler. `tests` holds the damage-engine
 * parity vectors (several MB of JSON) and their runner; they are for development, not for the
 * published site.
 */
export const devOnlyPaths = [".claude", ".dev.vars", ".license-private-key.txt", "tests"];

/**
 * Those, plus the archived seasons, plus the live season's older dated snapshots.
 *
 * The last of these is what keeps a deployment under Cloudflare's 20,000-file cap without
 * anyone having to remember a flag: `parkedSnapshotPaths` keeps the newest few days of each
 * season and leaves out the rest, so the upload stays a fixed size however long a season runs.
 *
 * `listDirectory` is passed in rather than imported so a caller can hand over its own reader,
 * and `root` is the tree being published, with forward slashes.
 */
export function excludedPathsFor(listDirectory, root) {
  return [...devOnlyPaths, ...archivedSeasonPaths, ...parkedSnapshotPaths(listDirectory, root)];
}
