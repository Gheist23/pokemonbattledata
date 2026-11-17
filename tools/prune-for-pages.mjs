// Prunes a Cloudflare Pages BUILD CHECKOUT down to what the site actually deploys.
//
// Why this exists: Pages refuses any deployment holding more than 20,000 files, and this repo
// holds about 44,000 -- the dated battle-data snapshots alone are most of them. A manual deploy
// goes through tools/deploy.mjs, which PARKS the excess inside .wrangler for the length of the
// upload and puts it straight back. A Pages build has no such step, so every build from git
// failed at "Validating asset output directory" with:
//
//     Error: Pages only supports up to 20,000 files in a deployment.
//
// and since the project builds on every push to main, every push left a failed production
// deployment behind. The site was never affected -- a build that fails never deploys -- but a
// list of nothing but failures is also a list in which a real failure cannot be seen.
//
// The exclusion list is deploy.mjs's own (tools/pages-excludes.mjs), so the two paths cannot
// drift: what a build publishes is what a manual deploy publishes.
//
// DELETES, where deploy.mjs parks and restores. That is safe HERE and only here: a Pages build
// runs against a throwaway clone. The guard below refuses to run anywhere else, because the
// same code pointed at a working tree would delete a season of battle data.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { excludedPathsFor } from "./pages-excludes.mjs";

const cwd = process.cwd();
const root = cwd.split(/[\\/]/).join("/");

// Cloudflare sets CF_PAGES=1 in a Pages build. `--force` is for trying this by hand against a
// COPY of the tree; there is deliberately no way to run it unguarded by accident.
const inPagesBuild = process.env.CF_PAGES === "1" || process.env.CF_PAGES === "true";
const forced = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");

if (!inPagesBuild && !forced && !dryRun) {
  console.error("PRUNE: refusing to run outside a Pages build.");
  console.error("PRUNE: this DELETES files. Pass --dry-run to see what it would remove,");
  console.error("PRUNE: or --force only against a throwaway copy of the tree.");
  process.exit(1);
}

// Counted the way Pages counts, so the number printed here is the number it will check.
function countFiles(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".wrangler") continue;
      total += countFiles(join(dir, entry.name));
    } else total += 1;
  }
  return total;
}

const excluded = excludedPathsFor((dir) => readdirSync(dir), root);
let removed = 0;
let wouldDrop = 0;
for (const relative of excluded) {
  const path = join(cwd, relative);
  if (!existsSync(path)) continue;
  removed += 1;
  if (dryRun) {
    // Counted, not deleted -- otherwise the total below would be the tree as it stands and the
    // dry run would report the very number it is meant to predict away.
    wouldDrop += countFiles(path);
    continue;
  }
  rmSync(path, { recursive: true, force: true });
}

const left = countFiles(cwd) - wouldDrop;
const LIMIT = 20000;
console.log(`PRUNE: ${dryRun ? "would remove" : "removed"} ${removed} excluded path(s)`);
console.log(`PRUNE: ${left} files ${dryRun ? "would remain" : "remain"} (Cloudflare Pages allows ${LIMIT})`);

// Fails the build rather than letting it fail later with a message about an output directory.
if (!dryRun && left > LIMIT) {
  console.error(`PRUNE: still over the limit by ${left - LIMIT} files.`);
  console.error("PRUNE: add the new tree to tools/pages-excludes.mjs, or archive a season.");
  process.exit(1);
}
