/**
 * THE CHECK THE PUBLISHER NEVER HAD.
 *
 *   node tools/preflight.mjs
 *
 * publish_champions_data.py `publish()` is: generate-manifest -> `git add .` -> commit -> push
 * -> deploy. Not one of the 85 suites in tests/ runs anywhere in that chain, and `git add .`
 * stages the whole worktree -- so a half-written file that happens to be on disk at 06:00 is
 * committed and deployed without anything looking at it. That has happened: a Pages Function
 * that PARSED but would not IMPORT failed the entire site build, and `node --check` had passed
 * it, because `--check` does not evaluate module scope.
 *
 * So this is not a test runner and deliberately not one. The suites are the wrong gate for a
 * DATA publish: several of them are pinned to bundled meta values and go red on a data refresh
 * with no code defect, and a publisher that stops because the meta shifted would leave the site
 * stale for the one reason that is not a defect at all.
 *
 * What it does instead is the one class of failure that is always a defect, never data, and
 * always fatal in production: EVERY module and EVERY Pages Function must actually IMPORT. That
 * is seconds, it has no data dependency, and it is precisely what `node --check` cannot see.
 *
 * Exit 0 to publish, non-zero to stop. Printing is deliberately plain: this runs unattended at
 * six in the morning and its output ends up in a log nobody is reading until something breaks.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** Every .js under a directory, recursively. */
function scripts(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...scripts(full));
    else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

// `builder/` is the module graph the whole site runs on, and `functions/` is every Pages
// Function -- the half that takes money among them. A Worker module reads `self` and the
// Functions runtime's globals at import time, so they are provided here rather than letting a
// perfectly healthy file fail for want of a browser.
globalThis.self ||= globalThis;
globalThis.addEventListener ||= () => {};
globalThis.postMessage ||= () => {};

const targets = [
  ...scripts(join(root, "builder")),
  ...scripts(join(root, "functions")),
  // Not app.js: it is a classic script, not a module, and importing it runs the Explorer
  // against a document that is not there. `node --check` is the right tool for that one.
];

/**
 * A page's entry module BOOTS when it is imported -- `builder-page.js` and its three siblings
 * reach for `document` on the last line -- so "document is not defined" means the module and
 * every module it imports loaded correctly and then asked for a browser. That is a pass here.
 *
 * Only that exact shape is forgiven, and only for a missing browser global. A SyntaxError, a
 * module that cannot be resolved, a const read before its initialisation -- the failures that
 * have actually reached production -- all throw something else and are still fatal. The four
 * page modules are imported against a real DOM by tests/run-calc-page.mjs and friends, which is
 * where their boot belongs; this is only asking whether the graph loads.
 */
const BROWSER_ONLY = /^(document|window|navigator|location|localStorage|sessionStorage) is not defined$/;

const failures = [];
let booted = 0;
for (const file of targets) {
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    const message = String(error?.message || error);
    if (error instanceof ReferenceError && BROWSER_ONLY.test(message)) {
      booted += 1;
      continue;
    }
    failures.push([relative(root, file).split("\\").join("/"), message]);
  }
}

if (failures.length) {
  console.error(`preflight: ${failures.length} of ${targets.length} module(s) will not import.`);
  console.error("NOTHING HAS BEEN COMMITTED OR DEPLOYED.");
  for (const [file, message] of failures) console.error(`  ${file}\n    ${message}`);
  process.exit(1);
}
console.log(`preflight: ${targets.length} modules and Pages Functions all import cleanly`
  + (booted ? ` (${booted} of them reached for a browser global, which is what a page's entry module does).` : "."));
