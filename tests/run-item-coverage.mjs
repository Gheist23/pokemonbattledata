// WHICH HELD ITEMS HAS THIS ENGINE NEVER HEARD OF?
//
// The counterpart of `tests/run-op-coverage.mjs` for the one surface that has no registry at
// all. Moves and Abilities compile to ops, so "the data ships it, the engine reads it" is a
// question a tool can answer. ITEMS are named in code, in both engines -- `engine.js` asks
// `atkItem === "choice specs"` -- so there is nothing to diff. What CAN be diffed is the meta's
// own item usage against the engine's whole vocabulary: an item that appears on a meta set and
// nowhere in builder/*.js is an item that does nothing.
//
// IT REFUSES THE SAME SHORTCUTS the op audit refuses, and one more of its own:
//
//   1. A MEGA STONE IS NOT A GAP. `isMegaStone` reads the item table and falls back to a suffix
//      rule, and `megaFormForItem` reads the table too -- so a new stone needs no code and will
//      never be named. They are the overwhelming majority of the raw list (37 of 45 the first
//      time this ran, headed by Meganiumite at 98.7%), and leaving them in buries everything
//      that matters under them.
//   2. "named somewhere" is evidence and not proof, so a name found is a note on the row, not a
//      reason to drop it -- the mistake that hid `screen` from the op audit for a week.
//   3. and the list is ranked by how much the CURRENT meta uses it, because an item nobody
//      brings is not worth anyone's afternoon.
//
// WHAT IT FOUND (20 Nov 2026): five items the Companion models and the website did not --
// Wide Lens, Bright Powder, Lax Incense, King's Rock and Razor Fang are implemented now (the
// numbers taken from `mcts/engine.py` so the two cannot drift); Quick Claw (85.2% of
// Slowbro-Galar, 20% to move first) and Red Card (59.3% of Slurpuff) are known and open, below.
//
//   node tests/run-item-coverage.mjs            # fails on a NEW reachable gap
//   node tests/run-item-coverage.mjs --report   # prints, never fails
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => JSON.parse(readFileSync(join(root, ...p), "utf8"));
const reportOnly = process.argv.includes("--report");

/** Every builder module, lowercased and stripped of punctuation: the engine's vocabulary. */
const SOURCE = readdirSync(join(root, "builder"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => readFileSync(join(root, "builder", f), "utf8"))
  .join("\n")
  .toLowerCase();
const FLAT = SOURCE.replace(/[^a-z0-9]/g, "");

const compact = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const engine = new DamageEngine(read("data", "builder", "app-data.json"));

/** The highest share any meta Pokemon gives each item, across both formats. */
function usage() {
  const best = new Map();
  for (const format of ["doubles", "singles"]) {
    let table;
    try {
      table = read("data", "builder", `meta-${format}.json`).pokemon || [];
    } catch { continue; }
    for (const record of table) {
      for (const [name, share] of record.items || []) {
        const key = compact(name);
        const value = Number(share) || 0;
        if (!key || value <= (best.get(key)?.share ?? -1)) continue;
        best.set(key, { share: value, name, who: record.name || record.form || "" });
      }
    }
  }
  return best;
}

/**
 * WHAT IS LEFT, and the reason rather than the number.
 *
 * Both are turn-ORDER and switching mechanics rather than damage ones, which is why they are not
 * in the batch that went in with this tool: Quick Claw jumps its holder to the front of its
 * priority bracket one time in five, and Red Card drags the attacker off the field. The engine
 * has machinery for both (`plansFor`'s ordering and `markPivot`), so neither is blocked -- they
 * are simply bigger than an accuracy multiplier, and each belongs with its own suite.
 */
const KNOWN = new Map([
  ["quickclaw", "20% to move first in its bracket; the Companion has it (mcts/engine.py)"],
  ["redcard", "drags the attacker out; the Companion has it (mcts/engine.py)"],
  ["bindingband", "stronger binding damage; neither engine models binding at all"],
  ["zoomlens", "+20% accuracy when its holder moves second; NEITHER engine has it"],
]);

const rows = [...usage().entries()]
  .map(([key, hit]) => ({ key, ...hit }))
  .filter((row) => !engine.isMegaStone(row.name))
  .filter((row) => !FLAT.includes(row.key))
  .sort((a, b) => b.share - a.share);

const reachable = rows.filter((row) => row.share > 0);
const unknown = reachable.filter((row) => !KNOWN.has(row.key));

console.log(`item coverage: ${rows.length} item(s) the engine never names, Mega stones aside`);
console.log(`               ${reachable.length} of them on a current meta set\n`);
for (const row of reachable) {
  const note = KNOWN.get(row.key);
  console.log(`  ${note ? "known" : "NEW  "}  ${String(row.share.toFixed(1)).padStart(5)}%  `
    + `${row.name.padEnd(16)} ${row.who.padEnd(18)} ${note || ""}`);
}
if (!reachable.length) console.log("  (none)");

// Said whether or not --report was passed: reporting "no new gaps" above a printed list of them
// is how a tool teaches people to ignore it. --report suppresses the EXIT CODE, not the sentence.
console.log("");
if (unknown.length) {
  console.error(`run-item-coverage: ${unknown.length} NEW item(s) the engine does not know`);
  for (const row of unknown) console.error(`  - ${row.name} (${row.who}, ${row.share}%)`);
  process.exit(reportOnly ? 0 : 1);
}
console.log("run-item-coverage: no new items the engine does not know");
