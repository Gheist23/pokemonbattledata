// Deploys the site to Cloudflare Pages.
//
// Pages refuses any deployment holding more than 20,000 files, and the raw
// dated battle-data CSVs alone cross that line. Finished seasons are therefore
// "parked" inside .wrangler/ for the duration of the upload: wrangler's Pages
// walker skips .wrangler outright, git ignores it, and the CSVs are moved back
// the moment the deploy returns, so every local build step (which reads them)
// keeps working. Parking is a rename on the same volume, so it costs nothing
// even for ~8,000 files.
//
// Usage: node tools/deploy.mjs [--project-name <name>] [--keep <relative/path>]
//        [--exclude <relative/path>] [--dry-run] [-- <extra wrangler args>]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { archivedSeasonPaths } from "./archived-seasons.mjs";

const cwd = process.cwd();
const parkRoot = join(cwd, ".wrangler", "deploy-excluded");
const pagesFileLimit = 20000;

// Local-only scaffolding that must never become a public asset, plus the
// archived seasons. Wrangler already skips .git, node_modules and .wrangler.
const devOnlyPaths = [".claude"];
const defaultExcludedPaths = [...devOnlyPaths, ...archivedSeasonPaths];

function parseArgs(argv) {
  const options = { projectName: "pokemonbattledata", excluded: [...defaultExcludedPaths], extra: [], dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.extra = argv.slice(index + 1);
      break;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--project-name") {
      options.projectName = argv[index + 1];
      index += 1;
    } else if (arg === "--keep") {
      // Re-include a path that would otherwise be parked.
      const keep = argv[index + 1]?.split(/[\\/]/).join("/");
      options.excluded = options.excluded.filter((entry) => entry !== keep);
      index += 1;
    } else if (arg === "--exclude") {
      options.excluded.push(argv[index + 1]?.split(/[\\/]/).join("/"));
      index += 1;
    } else {
      options.extra.push(arg);
    }
  }
  return options;
}

function livePathFor(relativePath) {
  return join(cwd, ...relativePath.split("/"));
}

function parkedPathFor(relativePath) {
  return join(parkRoot, ...relativePath.split("/"));
}

// What wrangler's own Pages walker leaves out, so the count below is the count
// it will arrive at: metafiles and the Functions source at the root, plus these
// directories wherever they appear.
const rootIgnored = new Set(["_worker.js", "_redirects", "_headers", "_routes.json", "functions"]);
const alwaysIgnored = new Set([".git", ".wrangler", "node_modules", ".DS_Store"]);

function countFiles(dir, { applyRootIgnores = false } = {}) {
  let total = 0;
  const stack = [[dir, true]];
  while (stack.length) {
    const [current, isRoot] = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (alwaysIgnored.has(entry.name)) continue;
      if (isRoot && applyRootIgnores && rootIgnored.has(entry.name)) continue;
      if (entry.isDirectory()) stack.push([join(current, entry.name), false]);
      else if (entry.isFile()) total += 1;
    }
  }
  return total;
}

function move(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

// Anything still parked belongs to an interrupted run; put it back before doing
// anything else so a crashed deploy can never leave the tree incomplete.
function restore(relativePath) {
  const parked = parkedPathFor(relativePath);
  if (!existsSync(parked)) return false;
  const live = livePathFor(relativePath);
  if (existsSync(live)) {
    console.error(`DEPLOY: ${relativePath} exists in both places; leaving the parked copy at ${parked}`);
    return false;
  }
  move(parked, live);
  console.log(`DEPLOY: restored ${relativePath}`);
  return true;
}

function park(relativePath) {
  const live = livePathFor(relativePath);
  if (!existsSync(live)) return false;
  const files = countFiles(live);
  move(live, parkedPathFor(relativePath));
  console.log(`DEPLOY: parked ${relativePath} (${files.toLocaleString()} file${files === 1 ? "" : "s"}) outside the upload`);
  return true;
}

const options = parseArgs(process.argv.slice(2));
const excluded = options.excluded.filter(Boolean);

for (const relativePath of excluded) restore(relativePath);

const parked = [];
let status = 1;
try {
  for (const relativePath of excluded) {
    if (park(relativePath)) parked.push(relativePath);
  }

  const fileCount = countFiles(cwd, { applyRootIgnores: true });
  console.log(`DEPLOY: uploading ${fileCount.toLocaleString()} files (Cloudflare Pages allows ${pagesFileLimit.toLocaleString()})`);
  if (fileCount > pagesFileLimit) {
    console.error(
      `DEPLOY: ${(fileCount - pagesFileLimit).toLocaleString()} files over the Pages limit. ` +
        "Park another finished season with --exclude <relative/path> before deploying."
    );
    status = 1;
  } else if (options.dryRun) {
    console.log(`DEPLOY: --dry-run, skipping "wrangler pages deploy . --project-name ${options.projectName}"`);
    status = 0;
  } else {
    const args = ["--yes", "wrangler", "pages", "deploy", ".", "--project-name", options.projectName, ...options.extra];
    // Node refuses to spawn npx.cmd directly on Windows, so go through the
    // shell there and quote every argument ourselves.
    const onWindows = process.platform === "win32";
    const result = onWindows
      ? spawnSync(`npx.cmd ${args.map((arg) => `"${arg}"`).join(" ")}`, { cwd, stdio: "inherit", shell: true })
      : spawnSync("npx", args, { cwd, stdio: "inherit" });
    if (result.error) throw result.error;
    status = result.status ?? 1;
  }
} finally {
  for (const relativePath of parked.reverse()) restore(relativePath);
  // Restoring leaves the empty parent chain behind; drop it, but only once no
  // parked file is left to lose.
  if (existsSync(parkRoot) && countFiles(parkRoot) === 0) rmSync(parkRoot, { recursive: true, force: true });
}

process.exit(status);
