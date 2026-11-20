// WHICH MOVE AND ABILITY OPS DOES THE ENGINE ACTUALLY READ?
//
// The compiled registry (`data/builder/move-effects.json`) ships 50 move ops and 38 ability ops.
// The turn engine runs some through `RUNNABLE_OPS`, implements others by NAME in dedicated code,
// and reads the rest not at all. The third set is invisible: the move is selectable, it does its
// damage, and the part the op describes silently never happens. That is how Parting Shot came to
// drop two stats and switch nobody out for as long as it did.
//
// This is the bounded version of "audit every move and ability". It asks one checkable question
// per op and ranks what is left by how much the CURRENT meta actually uses it, because an op
// nobody can reach is not a defect worth anyone's afternoon.
//
//   node tests/run-op-coverage.mjs            # report + fail on a NEW gap
//   node tests/run-op-coverage.mjs --report   # just print, never fail
//
// THREE THINGS IT DELIBERATELY DOES NOT CLAIM:
//
//   1. "Not in RUNNABLE_OPS" is not "unimplemented". Protect, recoil, drain, crit_stage and a
//      dozen more are handled by dedicated paths; counting those as missing would have produced
//      a 22-item scare list, most of it wrong.
//   2. "The op string is nowhere" is not "unimplemented" either. Intimidate's immunity list,
//      Chlorophyll's speed and Guts's attack are all hard-coded by ABILITY NAME. So a holder
//      whose name appears anywhere in builder/ is treated as implemented-by-hand.
//   3. A name match is evidence, not proof. This tool narrows ~90 ops to a handful to read by
//      hand; it does not read them for you.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const reportOnly = process.argv.includes("--report");

const effects = JSON.parse(readFileSync(join(root, "data", "builder", "move-effects.json"), "utf8"));

/** Every builder module, lowercased, as one blob: the engine's whole vocabulary. */
const SOURCE = readdirSync(join(root, "builder"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => readFileSync(join(root, "builder", f), "utf8"))
  .join("\n")
  .toLowerCase();

const runnable = new Set(
  (SOURCE.match(/export const runnable_ops = new set\(\[([\s\S]*?)\]\)/) || ["", ""])[1]
    .match(/"([a-z_0-9]+)"/g)?.map((s) => s.slice(1, -1)) || [],
);

const compact = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Is this move or Ability named anywhere in the engine, in any ordinary spelling? */
function namedByHand(key) {
  if (SOURCE.includes(key)) return true;
  for (let i = 3; i < key.length - 2; i += 1) {
    for (const sep of [" ", "-", "'"]) {
      if (SOURCE.includes(key.slice(0, i) + sep + key.slice(i))) return true;
    }
  }
  return false;
}

/** Does the op name appear in the engine outside the whitelist line itself? */
function opIsRead(op) {
  const at = SOURCE.indexOf(`"${op}"`);
  if (at < 0) return false;
  let from = 0;
  for (;;) {
    const found = SOURCE.indexOf(`"${op}"`, from);
    if (found < 0) return false;
    const lineStart = SOURCE.lastIndexOf("\n", found) + 1;
    const line = SOURCE.slice(lineStart, SOURCE.indexOf("\n", found));
    if (!line.includes("runnable_ops") && !line.trimStart().startsWith("//")) return true;
    from = found + 1;
  }
}

/** The highest usage any meta Pokemon gives this move, across both formats. */
function usageTable() {
  const index = JSON.parse(readFileSync(join(root, "data", "meta", "index.json"), "utf8"));
  const season = (index.seasons || [])[0];
  const best = new Map();
  for (const format of season?.formats || []) {
    let table;
    try {
      table = JSON.parse(readFileSync(
        join(root, "data", "meta", season.season, season.dates[0], `${format}.json`), "utf8")).pokemon;
    } catch { continue; }
    for (const [mon, entry] of Object.entries(table || {})) {
      for (const row of entry.move || []) {
        const key = compact(row[0]);
        const share = Number(row[1]) || 0;
        if (share > (best.get(key)?.share ?? -1)) best.set(key, { share, who: mon });
      }
    }
  }
  return best;
}

const usage = usageTable();

function holdersOf(section, op) {
  const out = new Set();
  for (const [name, ops] of Object.entries(effects[section] || {})) {
    for (const entry of ops || []) {
      if (entry && entry.op === op) out.add(name);
    }
  }
  return [...out].sort();
}

const gaps = [];
for (const section of ["moves", "abilities"]) {
  const ops = new Set();
  for (const list of Object.values(effects[section] || {})) {
    for (const entry of list || []) if (entry && entry.op) ops.add(entry.op);
  }
  for (const op of [...ops].sort()) {
    if (runnable.has(op) || opIsRead(op)) continue;
    for (const holder of holdersOf(section, op)) {
      if (namedByHand(holder)) continue;
      const hit = usage.get(holder);
      gaps.push({ section, op, holder, share: hit?.share ?? 0, who: hit?.who ?? "" });
    }
  }
}

gaps.sort((a, b) => b.share - a.share || a.holder.localeCompare(b.holder));
const reachable = gaps.filter((g) => g.share > 0);

/**
 * WHAT WAS ALREADY KNOWN WHEN THIS TOOL WAS WRITTEN (20 Nov 2026).
 *
 * The point of the baseline is that a NEW gap fails the suite. These are not accepted as
 * correct -- they are accepted as already-reported. Delete a line when it is fixed, so the
 * tool starts guarding it.
 */
const KNOWN = new Set([
  "clear_screen:psychicfangs",     // breaks Light Screen / Reflect / Aurora Veil
  "clear_screen:brickbreak",
  "hp_cost:clangoroussoul",        // the `stage` half runs; the 1/3 HP cost does not
  "cure_status:sparklingaria",     // cures the target's burn
  "cure_status:pyroball",          // self-thaw; reachable only behind a freeze
  "cure_status:scorchingsands",
  "cure_status:burnup",
]);

const unknown = reachable.filter((g) => !KNOWN.has(`${g.op}:${g.holder}`));

console.log(`op coverage: ${gaps.length} op/holder pairs the engine neither runs nor names`);
console.log(`             ${reachable.length} of them are reachable in the current meta\n`);
for (const g of reachable) {
  const mark = KNOWN.has(`${g.op}:${g.holder}`) ? "known" : "NEW  ";
  console.log(`  ${mark}  ${String(g.share.toFixed(1)).padStart(5)}%  ${g.op.padEnd(16)} ${g.holder.padEnd(18)} ${g.who}`);
}
const unreachable = gaps.length - reachable.length;
console.log(`\n  (${unreachable} further pairs exist but nobody in either format runs them)`);

if (!reportOnly && unknown.length) {
  console.error(`\nrun-op-coverage: ${unknown.length} NEW reachable gap(s) since the baseline`);
  for (const g of unknown) console.error(`  - ${g.op} on ${g.holder} (${g.who}, ${g.share}%)`);
  process.exit(1);
}
console.log(`\nrun-op-coverage: no new reachable gaps`);
