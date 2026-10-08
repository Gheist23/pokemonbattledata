// Fill in a campaign file from the Showdown pastes somebody put in it.
//
//   node tools/build-campaign.mjs giuseppe
//   node tools/build-campaign.mjs giuseppe --check     (changes nothing; exits 1 if stale)
//
// Paste each team into data/campaigns/<code>.json under teams[].showdown, give
// it a title, and run this. It resolves every paste through the SAME reader the
// Team Builder uses (builder/common.js parseShowdown) and writes back each
// team's members -- display name, sprite, item, types.
//
// That list is not decoration: it is the PROOF that every paste resolves, and
// tests/run-campaign.mjs fails when a team has a paste but no members. A name
// the app spells differently ("Urshifu-Rapid-Strike", "Indeedee-F") otherwise
// drops one Pokemon out of a six-Pokemon team in silence, and the first anybody
// hears of it is a five-Pokemon team in front of everyone who watched the video.
// It is also what a share card or a future landing page would draw from.
//
// It never invents a team and never edits `showdown`: the paste is the source
// and everything else in the file is derived from it.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData, parseShowdown } from "../builder/common.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const args = process.argv.slice(2);
const check = args.includes("--check");
const code = (args.find((value) => !value.startsWith("-")) || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
if (!code) {
  console.error("Usage: node tools/build-campaign.mjs <code> [--check]");
  process.exit(2);
}

const file = join(root, "data", "campaigns", `${code}.json`);
let campaign;
try {
  campaign = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`Could not read ${file}: ${error.message}`);
  process.exit(2);
}

const data = new BuilderData(JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8")));

const problems = [];
let filled = 0;

const teams = Array.isArray(campaign.teams) ? campaign.teams : [];
teams.forEach((team, index) => {
  const paste = String(team?.showdown || "").trim();
  if (!paste) {
    team.members = [];
    return;
  }
  const sets = parseShowdown(paste, data);
  const pasted = paste.split(/\n\s*\n/).filter((block) => block.trim()).length;
  if (sets.length !== pasted) {
    // Every block that did not resolve is a Pokemon that would have gone
    // missing from the card and from the team, silently.
    problems.push(`team ${index + 1} ("${team.title || "untitled"}"): ${pasted} pasted, ${sets.length} resolved`);
  }
  if (!sets.length) {
    team.members = [];
    return;
  }
  filled += 1;
  team.members = sets.slice(0, 6).map((set) => ({
    name: data.setName(set),
    sprite: data.sprite(set.species, set.form, set.item),
    item: set.item || "",
    types: data.types(set.species, set.form, set.item),
  }));
  const missingSprite = team.members.filter((member) => !member.sprite).map((member) => member.name);
  if (missingSprite.length) problems.push(`team ${index + 1}: no sprite for ${missingSprite.join(", ")}`);
});

campaign.generatedAt = new Date().toISOString();

const next = `${JSON.stringify(campaign, null, 2)}\n`;
const current = readFileSync(file, "utf8");
// Everything but the stamp, so --check does not fail merely because time passed.
const withoutStamp = (text) => text.replace(/"generatedAt":\s*"[^"]*"/, '"generatedAt": ""');

if (check) {
  const stale = withoutStamp(current) !== withoutStamp(next);
  for (const problem of problems) console.error(`  ${problem}`);
  if (stale) console.error(`${file} is out of date: run node tools/build-campaign.mjs ${code}`);
  process.exit(stale || problems.length ? 1 : 0);
}

writeFileSync(file, next);
console.log(`${code}: ${filled} team(s) with members written to data/campaigns/${code}.json`);
for (const problem of problems) console.warn(`  WARNING  ${problem}`);
process.exit(problems.length ? 1 : 0);
