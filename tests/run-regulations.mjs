// The rulesets the site says it covers, and the ~2,300 generated pages that say it.
//
//   node tests/run-regulations.mjs
//   node tests/run-regulations.mjs --verbose
//
// WHY THIS SUITE EXISTS.  A regulation change is the one moment every player's
// teams stop being legal at once, so it is the year's biggest spike in search
// demand -- and the thing that has to be carrying the new term is the generated
// page surface, because that is what is already indexed.  Until 24 Nov 2026 the
// regulation list and the sentence naming it were hand-written and hand-edited,
// which means the day a fourth regulation landed the site would have been silent
// on the only phrase anybody was typing and NOTHING WOULD HAVE FAILED.  This
// suite is that missing failure.
//
// What it holds to:
//
//   1. EVERY REGULATION IS IN THE KEYWORD SET, announced ones included, both
//      bare and prefixed with the game's name.
//
//   2. THE NOTE IS A CLAIM ABOUT THE DATA, so it names what the ladder has
//      actually been played under and not the regulation that starts next week.
//      It must take the new one in by itself on the day it starts -- the date
//      logic is checked on both sides of the boundary, because a function that
//      ignored the date would otherwise pass this suite by being constant.
//
//   3. THE PAGES REALLY CARRY IT.  Asserted against generated HTML on disk, not
//      against the constant -- a keyword list nothing reads is not reach.
//
// No browser and no network.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NEXT_REGULATION, REGULATIONS, REGULATION_FOOTER_PATTERN, REGULATION_KEYWORDS,
  regulationFooter, regulationNote, startedRegulations,
} from "../tools/seo-pages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const verbose = process.argv.includes("--verbose");

let checked = 0;
const failures = [];
const ok = (label, passed, detail = "") => {
  checked += 1;
  if (!passed) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  else if (verbose) console.log(`  ok   ${label}`);
};
const same = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

// --- 1. the list itself -------------------------------------------------------------------

ok("there is at least one regulation", REGULATIONS.length > 0);
ok("no regulation is named twice", new Set(REGULATIONS).size === REGULATIONS.length,
  REGULATIONS.join(", "));
for (const name of REGULATIONS) {
  ok(`${name} looks like a ruleset name`, /^[A-Z]-[A-Z0-9]+$/.test(name), name);
}

if (NEXT_REGULATION) {
  const { name, from } = NEXT_REGULATION;
  ok("the next regulation is named", Boolean(name));
  ok(`${name} looks like a ruleset name`, /^[A-Z]-[A-Z0-9]+$/.test(String(name)), String(name));
  ok(`${name} has a start date`, /^\d{4}-\d{2}-\d{2}$/.test(String(from)), String(from));
  ok(`${name}'s start date is a real day`, Number.isFinite(Date.parse(`${from}T00:00:00Z`)));
  // The edit a future regulation change gets wrong: moving the name into
  // REGULATIONS and forgetting to clear or advance NEXT_REGULATION, which would
  // name it twice in the sentence.
  ok(`${name} is not also in REGULATIONS`, !REGULATIONS.includes(name),
    "move it out of NEXT_REGULATION or out of REGULATIONS, not both");
}

// --- 2. the keyword set -------------------------------------------------------------------

const announced = [...REGULATIONS, ...(NEXT_REGULATION ? [NEXT_REGULATION.name] : [])];
for (const name of announced) {
  // A keyword names a regulation BEFORE it starts: the searching begins while
  // people are still guessing at the rules, and indexing takes days.
  ok(`"Regulation ${name}" is a keyword`, REGULATION_KEYWORDS.includes(`Regulation ${name}`));
  ok(`"Pokemon Champions Regulation ${name}" is a keyword`,
    REGULATION_KEYWORDS.includes(`Pokemon Champions Regulation ${name}`));
}
ok("the plain plural is a keyword", REGULATION_KEYWORDS.includes("Pokemon Champions regulations"));
ok("no keyword is repeated", new Set(REGULATION_KEYWORDS).size === REGULATION_KEYWORDS.length);

// --- 3. the note, on both sides of the start date -----------------------------------------

const started = startedRegulations();
for (const name of REGULATIONS) {
  ok(`${name} counts as started`, started.includes(name));
}
const noteNow = regulationNote();
for (const name of started) {
  ok(`the note names Regulation ${name}`, noteNow.includes(`Regulation ${name}`), noteNow);
}

if (NEXT_REGULATION) {
  const { name, from } = NEXT_REGULATION;
  const dayBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000);
  const dayOf = new Date(`${from}T00:00:00Z`);
  const before = regulationNote(dayBefore);
  const after = regulationNote(dayOf);
  ok(`the day before ${from} the note does NOT claim ${name}`, !before.includes(`Regulation ${name}`),
    before);
  ok(`on ${from} the note does claim ${name}`, after.includes(`Regulation ${name}`), after);
  // Guard the guard: if the two sides ever came out identical the pair of checks
  // above could both pass on a function that ignored the date entirely.
  ok("the start date actually changes the sentence", before !== after);
  same(`${name} is not started before ${from}`, startedRegulations(dayBefore).includes(name), false);
  same(`${name} is started on ${from}`, startedRegulations(dayOf).includes(name), true);
}

// One sentence, and it reads as one: no dangling comma, no "and and".
ok("the note is a single sentence", (noteNow.match(/\./g) || []).length === 1, noteNow);
ok("the note has no empty list slot", !/,\s*\)|\(\s*\)|and\s+and/.test(noteNow), noteNow);
same("the note is plural when more than one regulation has started",
  noteNow.includes(started.length === 1 ? "current regulation (" : "current regulations ("), true);

// --- 4. the pages really carry it ---------------------------------------------------------
//
// The constant being right is not the deliverable: the indexed HTML carrying it
// is. These read generated files off disk.

const sampleDirs = ["abilities", "moves", "items"];
const pages = [];
for (const dir of sampleDirs) {
  const base = join(root, dir);
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base).slice(0, 40)) {
    const file = join(base, entry, "index.html");
    if (existsSync(file)) pages.push([`${dir}/${entry}`, readFileSync(file, "utf8")]);
  }
}
// tools/deploy.mjs parks whole trees out of the working directory while it
// uploads, so a glob-driven suite can otherwise report green having read nothing
// at all. The count is the check.
ok("generated pages were found to read", pages.length >= 20, `found ${pages.length}`);

let withNote = 0;
let withKeyword = 0;
for (const [name, html] of pages) {
  if (html.includes(noteNow)) withNote += 1;
  if (html.includes(`Regulation ${announced[announced.length - 1]}`)) withKeyword += 1;
  else if (verbose) console.log(`  --   ${name} carries no ${announced[announced.length - 1]} keyword`);
}
ok("every sampled page carries the current note", withNote === pages.length,
  `${withNote} of ${pages.length} -- regenerate with node tools/generate-manifest.mjs`);
ok(`every sampled page carries the newest regulation keyword`, withKeyword === pages.length,
  `${withKeyword} of ${pages.length} -- regenerate with node tools/generate-manifest.mjs`);

// --- 5. NO PAGE ANYWHERE IS LEFT BEHIND ---------------------------------------------------
//
// The footer sentence and the keyword meta are on every page on the site, and both used to be
// hand-written -- ten hand-written pages each with their own copy, plus a template that 2,700
// generated pages inherit. tools/generate-manifest.mjs now rewrites them from one place on every
// build. This is the check that says so, and it is the check that caught `meta/index.html`: the
// first version of that sweep skipped directories it assumed were generated, and exactly one
// page out of 2,709 kept the obsolete sentence.

const skipDirs = new Set([
  "node_modules", ".git", ".wrangler", ".claude", "tests", "data", "builder",
  "pokemon_champions_assets",
]);
const wantFooter = regulationFooter();
let scanned = 0;
const staleFooter = [];
const staleKeywords = [];
const walk = (dir, depth) => {
  if (depth > 4) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(join(dir, entry.name), depth + 1);
      continue;
    }
    if (!entry.name.endsWith(".html")) continue;
    scanned += 1;
    const html = readFileSync(join(dir, entry.name), "utf8");
    const path = join(dir, entry.name).slice(root.length + 1);
    REGULATION_FOOTER_PATTERN.lastIndex = 0;
    if (html.replace(REGULATION_FOOTER_PATTERN, wantFooter) !== html) staleFooter.push(path);
    const keywords = /<meta name="keywords" content="([^"]*)"/.exec(html);
    // Only pages that list regulations at all: a 404 has no keyword meta and should not grow one.
    if (keywords && /Regulation /.test(keywords[1])
      && REGULATION_KEYWORDS.some((keyword) => !keywords[1].includes(keyword))) {
      staleKeywords.push(path);
    }
  }
};
walk(root, 1);

// The count again, for the same reason as above: a deploy in flight moves whole trees out of the
// working directory, and a sweep that found nothing would otherwise report perfect health.
ok("there are pages to sweep", scanned >= 2000, `scanned ${scanned}`);
ok("no page carries an out-of-date footer", staleFooter.length === 0,
  `${staleFooter.length} stale, e.g. ${staleFooter.slice(0, 3).join(", ")} -- run node tools/generate-manifest.mjs`);
ok("no page is missing a regulation keyword", staleKeywords.length === 0,
  `${staleKeywords.length} stale, e.g. ${staleKeywords.slice(0, 3).join(", ")} -- run node tools/generate-manifest.mjs`);
// The footer names ONE regulation and the newest one, which is where the search demand is.
ok("the footer names the regulation being played now", wantFooter.includes(`Regulation ${started[started.length - 1]},`),
  wantFooter);
ok("...and not the whole list", !/Regulation [^,]*, Regulation /.test(wantFooter), wantFooter);

// --- report --------------------------------------------------------------------------------

if (failures.length) {
  console.error(`run-regulations: ${failures.length} of ${checked} checks failed`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`run-regulations: ${checked} checks passed`);
