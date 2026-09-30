// A threat row says what it was holding, and its KO line reads like the Damage Calculator's
// (builder/team-eval.js koLineFromRolls, builder/team-payload.js enrichThreat,
// builder/evaluation-view.js rowItem — mirroring the Companion's
// threat_item_shown_v522.py and threat_ko_label_v523.py).
//
// The owner reported two Team Evaluation numbers as wrong. Neither was; both were right
// about inputs he could not see.
//
//   1. Sylveon Hyper Beam into Archaludon read "93.9-110.6% · 51% to OHKO" under a header
//      that said Fairy Feather. It was calculated with Life Orb — a threat is priced with
//      each of its top three meta items and the worst kept, and Life Orb (5.0% usage) beat
//      Fairy Feather (87.4%) because a one-hit KO outranks a two-hit KO. The winning item is
//      recorded as `item`; the header read `attacker_item`, which nothing on that row sets,
//      so it fell through to `top_items[0]` — the most USED item.
//
//   2. Archaludon Flash Cannon read "Guaranteed 3HKO" where the calculator says
//      "23.4% chance to 2HKO · Guaranteed 3HKO". `koSummary` returns the first hit count
//      whose chance reaches one half, which is right for the number scoring reads and hides
//      anything between 0 and 50%. It also multiplied its percentages by move accuracy,
//      which belongs in the score and not in a sentence about what the rolls do.
//
// Checked here:
//   1. the KO line names the first real chance and then the first certainty, from raw rolls
//   2. `score`, `hits` and `chance` are untouched — nothing re-ranks, no recorded score moves
//   3. accuracy is out of the words and still in the number scoring reads
//   4. the header takes its item from the row its number came from, and the usage list is
//      left alone
//   5. a row with no item recorded is unchanged, and nothing is named twice
//   6. both options: on by default, off replays the old words
//
//   node tests/run-threat-display.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, KO_LABEL_ON, koLabelOption, THREAT_ITEM_ON, threatItemOption } from "../builder/engine.js";
import { TeamEvaluator, chanceForHits, koLineFromRolls } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const engine = new DamageEngine(appData);

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const evaluator = (opts = {}) => new TeamEvaluator(null, engine, "Doubles", {}, opts);

// Archaludon Flash Cannon into a 202 HP Sylveon: two minimum rolls are 180, so a 2HKO is
// real and not certain — the tier the old label threw away.
const FLASH = {
  rolls: [90, 91, 92, 93, 94, 95, 96, 98, 99, 100, 101, 102, 103, 104, 106, 107],
  current_hp: 202, max_hp: 202, move_accuracy_factor: 1,
};
// Sylveon Hyper Beam into a 197 HP Archaludon with Life Orb: 9 of 16 reach it, and the move
// is 90% accurate.
const HYPER = {
  rolls: [185, 187, 189, 191, 193, 195, 196, 198, 200, 202, 204, 206, 208, 210, 212, 218],
  current_hp: 197, max_hp: 197, move_accuracy_factor: 0.9,
};

// 0. the options
check("the KO line rule is on by default", KO_LABEL_ON === true);
check("the threat item rule is on by default", THREAT_ITEM_ON === true);
for (const off of [null, undefined, false, "", "0", "off", "no"]) {
  check(`koLabelOption reads ${JSON.stringify(off)} as off`, koLabelOption(off) === false);
  check(`threatItemOption reads ${JSON.stringify(off)} as off`, threatItemOption(off) === false);
}

// 1-3. the KO line, and the numbers behind it
const ev = evaluator();
const flash = ev.koSummary(FLASH);
const hyper = ev.koSummary(HYPER);
check("the hidden 2HKO is named", flash.label === "25.8% chance to 2HKO  ·  Guaranteed 3HKO", flash.label);
check("raw roll odds, not accuracy-scaled", hyper.label === "56.2% chance to OHKO  ·  Guaranteed 2HKO", hyper.label);
check("Flash Cannon hits unchanged", flash.hits === 3, String(flash.hits));
check("Flash Cannon chance unchanged", Math.abs(flash.chance - 1) < 1e-9, String(flash.chance));
check("Flash Cannon score unchanged", Math.abs(flash.score - 40) < 1e-9, String(flash.score));
// 9 of 16 rolls is 56.25%, × Hyper Beam's 90% accuracy = 0.50625. Accuracy stays in the
// number the ranking reads, which is where accuracy belongs.
check("Hyper Beam hits unchanged", hyper.hits === 1, String(hyper.hits));
check("Hyper Beam keeps the accuracy-scaled chance", Math.abs(hyper.chance - 0.50625) < 1e-6, String(hyper.chance));
check("raw and scaled really do differ here",
      Math.abs(chanceForHits(HYPER, 1, 1) - chanceForHits(HYPER, 1, 0.9)) > 0.05);
check("no damage stays no damage",
      ev.koSummary({ rolls: new Array(16).fill(0), current_hp: 202, max_hp: 202 }).label === "No damage");

// the line builder on its own
check("a certain 2HKO says so",
      koLineFromRolls({ rolls: new Array(16).fill(101), current_hp: 202, max_hp: 202 }) === "Guaranteed 2HKO");
check("a certain OHKO says so",
      koLineFromRolls({ rolls: new Array(16).fill(250), current_hp: 202, max_hp: 202 }) === "Guaranteed OHKO");

// 6a. off replays the old words
const old = evaluator({ koLabel: false });
check("off, the accuracy-scaled tier label comes back", old.koSummary(HYPER).label === "51% to OHKO",
      old.koSummary(HYPER).label);
check("off, the hidden 2HKO is hidden again", old.koSummary(FLASH).label === "Guaranteed 3HKO",
      old.koSummary(FLASH).label);

// 4-5. the header item
const ROW = {
  attacker: "Sylveon", move: "Hyper Beam", item: "Life Orb", attacker_side: "threat",
  percent: "93.9-110.6%", label: "51% to OHKO",
};
const threatOf = (extra = {}, opts = {}) => new TeamEvaluation(evaluator(), opts).enrichThreat({
  name: "Sylveon", top_items: ["Fairy Feather", "Life Orb", "Leftovers"],
  threat_item: "Fairy Feather", their_best: { ...ROW }, breakdown: [], ...extra,
});
const fixed = threatOf();
check("the header takes the winning item", fixed.threat_item === "Life Orb", fixed.threat_item);
check("the usage list is untouched", (fixed.top_items || []).join(",") === "Fairy Feather,Life Orb,Leftovers");
const bare = threatOf({ their_best: { attacker: "Sylveon", move: "Hyper Beam" } });
check("a row with no item keeps the old header", bare.threat_item === "Fairy Feather", bare.threat_item);
const offItem = threatOf({}, { threatItem: false });
check("off, the header reads the usage item again", offItem.threat_item === "Fairy Feather", offItem.threat_item);
// `attacker_item` still wins when something does set it, which is the strict-items layer.
const strict = threatOf({ their_best: { ...ROW, attacker_item: "Choice Specs" } });
check("an explicit attacker_item still wins", strict.threat_item === "Choice Specs", strict.threat_item);

if (failures.length) {
  console.error(`\n${checked} checks, ${failures.length} failed:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\n${checked} checks, all passed.`);
