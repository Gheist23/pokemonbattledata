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
      const hit = usage.get(holder);
      // THE OP LITERAL IS THE GATE, and the holder's NAME is only a note on the row.
      //
      // Dropping a row because the engine mentions the move's name somewhere was far too
      // permissive and it hid the biggest gap there was: `screen` has no branch and is not
      // runnable, so Reflect, Light Screen and Aurora Veil cannot be used AT ALL -- and all
      // three were silently excused, because the engine does say "reflect", "lightscreen" and
      // "auroraveil": in `TournamentTest.calc`'s read of `solverField`, which is the STATIC
      // board the Solver page starts from and has nothing to do with the move. Three names at
      // 87.7%, 89.5% and 94.9% usage, invisible to the audit that exists to find them.
      //
      // `tools/op_coverage.py` in the Companion was given the same fix for the same reason
      // (there a 14.5 MB blob matched nearly every move name and excused every gap), and it is
      // the shortcut this file's own header promises to refuse: "a name match is evidence, not
      // proof". Evidence belongs in the row, not in the filter.
      gaps.push({
        section, op, holder, share: hit?.share ?? 0,
        who: [hit?.who ?? "", namedByHand(holder) ? "holder named by hand" : ""].filter(Boolean).join(" "),
      });
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
  // EMPTY. Every op anybody in the current meta actually brings is run or named.
  //
  // It was 25 pairs and 8 reachable when this tool was written, and the second filter was
  // hiding five more: `namedByHand` dropped a row when the engine mentioned the move's NAME
  // anywhere, and the engine does say "reflect", "lightscreen" and "auroraveil" -- for the
  // static board side-channel, not for the move. That filter is an annotation now.
  //
  // RESOLVED since the baseline, kept here only as a record of what the list used to hold:
  //   hp_cost:clangoroussoul  -- `tests/run-hp-cost.mjs`. It needed `set_stage` as well: Belly
  //                              Drum is the two together, and the exporter's whitelist shipped
  //                              only the cost, so running it alone would have put a move on
  //                              the sheet that spends half a health bar for nothing.
  //   cure_status:*           -- `tests/run-cure-status.mjs`, 20 move holders in one branch,
  //                              which also unblocked Rest, Heal Bell, Aromatherapy, Refresh,
  //                              Purify, Jungle Healing, Lunar Blessing, Sparkly Swirl and
  //                              Take Heart -- all nine refused outright before it.
  //   screen:*, clear_screen:* -- `tests/run-screens.mjs`. The board had no screen at all, so
  //                              Reflect (87.7%), Light Screen (89.3%) and Aurora Veil (94.9%)
  //                              could not be CLICKED. They are `board.sc` now, turns a side,
  //                              and a screened hit has its own damage-cache store.
  //   break_protect:feint     -- Feint hit through a Protect and left it standing, so the
  //                              partner's move was still blocked. 70.1% of Pinsir.
  // Every name is OUT of the set, so the tool guards all of them from here on.
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
