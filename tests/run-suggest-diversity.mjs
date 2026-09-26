// The V517 Suggestions diversity rule (builder/suggest-diversity.js), and the V517 Optimize
// usage rule (builder/optimize-usage-moves.js). Small fixtures only -- no full scan:
//
//   1. the cap arithmetic: ceil(limit / offered targets), and that one less cannot fill the list;
//   2. selection over synthetic rows: ordered by merit, one row per candidate, no target over the
//      cap unless the margin was exceeded, and the list is never shortened;
//   3. the margin, both directions: 18.1 above the best allowed row keeps it, 17.9 yields;
//   4. inert cases: an open slot (one pseudo-target ""), and a pool where only one target has a
//      viable row -- both return today's list unchanged, with no padding;
//   5. the switch: diversityOption off / on, and the rule version a recording stamps;
//   6. Optimize: a new attack must be recorded, the set's own moves stay testable at any share,
//      a Pokemon with no record is not restricted, and a barely-played Pokemon still has
//      something to test.
//
//   node tests/run-suggest-diversity.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { diversityOption, perTargetCap, selectDiverse, SUGGESTION_DIVERSITY, targetOf } from "../builder/suggest-diversity.js";
import { OPTIMIZE_USAGE_MOVES, testableMove, usageOption } from "../builder/optimize-usage-moves.js";

let checked = 0;
const failures = [];
const ok = (label, pass, detail = "") => {
  checked += 1;
  if (!pass) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const MARGIN = 18; // ANSWER_SPAN, the span stage two can move any row
const keyOf = (row) => row.key;

/** `n` candidates, each with a row at every target, the dominant one worth `offset` more. */
function pool({ candidates, targets, offset = 0, top = 100, step = 2 }) {
  const rows = [];
  const alternates = new Map();
  for (let i = 0; i < candidates; i += 1) {
    const key = `c${i}`;
    const base = top - i * step;
    const list = targets.map((t, j) => ({ key, name: key, position: i + 1, swap_target: t, score: base + (j === 0 ? offset : 0) - j * 0.1 }));
    list.sort((a, b) => b.score - a.score);
    rows.push(list[0]);
    alternates.set(key, list.slice(1));
  }
  rows.sort((a, b) => b.score - a.score || a.position - b.position);
  return { rows, alternates };
}
const shareOf = (rows) => {
  const counts = new Map();
  for (const r of rows) counts.set(targetOf(r), (counts.get(targetOf(r)) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

// --- 1. the cap ---------------------------------------------------------------------------
eq("cap(14, 3) = 5, the smallest that can fill 14 rows from 3 targets", perTargetCap(14, 3), 5);
ok("a cap of 4 could only reach 12 of the 14 rows", 4 * 3 < 14);
ok("and 5 x 3 reaches all 14", 5 * 3 >= 14);
eq("cap(14, 2) = 7", perTargetCap(14, 2), 7);
eq("cap(14, 1) = 14, so one offered target makes the rule inert", perTargetCap(14, 1), 14);
eq("cap(13, 3) = 5", perTargetCap(13, 3), 5);
eq("cap(14, 0) is treated as one bucket", perTargetCap(14, 0), 14);
ok("5 of 14 is about a third, not a magic constant", Math.abs(5 / 14 - 1 / 3) < 0.03, `${(5 / 14 * 100).toFixed(1)}%`);

// --- 2. selection over synthetic rows -----------------------------------------------------
{
  // A dominant target worth +9 to every candidate: exactly the shape the owner's team has.
  const { rows, alternates } = pool({ candidates: 40, targets: ["A", "B", "C"], offset: 9 });
  eq("today's list is one target over and over", shareOf(rows.slice(0, 14))[0], ["a", 14]);
  const report = {};
  const shaped = selectDiverse(rows, alternates, 14, MARGIN, keyOf, report);
  eq("the shaped list is the same length", shaped.length, 14);
  eq("the cap it derived", [report.cap, report.offered], [5, 3]);
  const counts = shareOf(shaped);
  ok("no target takes more than the cap", counts.every(([, n]) => n <= 5), JSON.stringify(counts));
  ok("all three targets are represented", counts.length === 3, JSON.stringify(counts));
  ok("the list stays ordered by merit", shaped.every((r, i) => i === 0 || shaped[i - 1].score >= r.score),
    shaped.map((r) => r.score).join(" "));
  eq("each candidate appears once", new Set(shaped.map(keyOf)).size, 14);
  ok("every shown row is a real row of its candidate",
    shaped.every((r) => r === rows.find((x) => keyOf(x) === keyOf(r)) || (alternates.get(keyOf(r)) || []).includes(r)));
  ok("the cap never had to give way at a +9 offset", report.yielded.length === 0, JSON.stringify(report.yielded));
}

// --- 3. the margin, both directions -------------------------------------------------------
{
  // Three offered targets and a 6-row list, so the cap is 2. Candidate a2 is worth 95 at the
  // full target A and 95 - gap at B: the only question is whether the cap gives way for it.
  const make = (gap) => {
    const rows = [];
    const alternates = new Map();
    const add = (key, target, score, position, others = []) => {
      rows.push({ key, name: key, position, swap_target: target, score });
      alternates.set(key, others);
    };
    add("a0", "A", 100, 1);
    add("a1", "A", 99, 2);
    add("a2", "A", 95, 3, [{ key: "a2", name: "a2", position: 3, swap_target: "B", score: 95 - gap }]);
    add("b0", "B", 60, 4);
    add("b1", "B", 59, 5);
    add("c0", "C", 58, 6);
    add("c1", "C", 57, 7);
    rows.sort((a, b) => b.score - a.score || a.position - b.position);
    return { rows, alternates };
  };
  for (const [gap, keeps] of [[18.1, true], [17.9, false]]) {
    const { rows, alternates } = make(gap);
    const report = {};
    const shaped = selectDiverse(rows, alternates, 6, MARGIN, keyOf, report);
    eq(`the cap for 6 rows over 3 targets (gap ${gap})`, [report.cap, report.offered], [2, 3]);
    const atA = shaped.filter((r) => targetOf(r) === "a").length;
    ok(`a ${gap}-point loss ${keeps ? "keeps the forbidden row" : "yields to the cap"}`,
      atA === (keeps ? 3 : 2), `A took ${atA}/6, yielded ${JSON.stringify(report.yielded)}`);
    ok(`and a2 is shown at ${keeps ? "A" : "B"}`,
      targetOf(shaped.find((r) => keyOf(r) === "a2")) === (keeps ? "a" : "b"),
      shaped.map((r) => `${r.name}@${r.swap_target} ${r.score}`).join(", "));
    ok(`every recorded yield really exceeded the margin (gap ${gap})`,
      report.yielded.every(([taken, allowed]) => allowed === null || taken - allowed > MARGIN),
      JSON.stringify(report.yielded));
    eq(`and the list is still 6 rows (gap ${gap})`, shaped.length, 6);
  }
}

// --- 4. inert cases: no padding -----------------------------------------------------------
{
  // An open slot: every row is an `add`, so there is one bucket and the rule cannot bite.
  const { rows, alternates } = pool({ candidates: 20, targets: [""] });
  const report = {};
  const shaped = selectDiverse(rows, alternates, 14, MARGIN, keyOf, report);
  eq("an open-slot list is returned unchanged", shaped.map((r) => r.name), rows.slice(0, 14).map((r) => r.name));
  eq("with the cap inert", report.cap, 14);
}
{
  // A genuinely one-sided team: only target A has a viable row at all.
  const rows = [];
  const alternates = new Map();
  for (let i = 0; i < 20; i += 1) {
    const key = `c${i}`;
    rows.push({ key, name: key, position: i + 1, swap_target: "A", score: 90 - i });
    alternates.set(key, []);
  }
  const report = {};
  const shaped = selectDiverse(rows, alternates, 14, MARGIN, keyOf, report);
  eq("a one-sided team keeps today's list", shaped.map((r) => r.name), rows.slice(0, 14).map((r) => r.name));
  eq("because only one target is offered", [report.cap, report.offered], [14, 1]);
  ok("and nothing was padded in", shaped.every((r) => r.score >= 77), shaped.map((r) => r.score).join(" "));
}
{
  // One-sided in the other sense: rival targets exist but their rows are far worse. The margin,
  // not the target count, is what refuses to pad here.
  const rows = [];
  const alternates = new Map();
  for (let i = 0; i < 14; i += 1) {
    const key = `c${i}`;
    rows.push({ key, name: key, position: i + 1, swap_target: "A", score: 90 - i });
    // each has a B row 40 points down -- worth having on the list only if the cap were absolute
    alternates.set(key, [{ key, name: key, position: i + 1, swap_target: "B", score: 50 - i }]);
  }
  const report = {};
  const shaped = selectDiverse(rows, alternates, 14, MARGIN, keyOf, report);
  const worst = Math.min(...shaped.map((r) => r.score));
  ok("rows 40 points down are not padded in", worst >= 77, `worst shown ${worst}`);
  ok("the cap gave way instead, and said so", report.yielded.length > 0
    && report.yielded.every(([taken, allowed]) => allowed === null || taken - allowed > MARGIN),
    JSON.stringify(report.yielded));
  eq("and the list is still 14 rows", shaped.length, 14);
}
{
  const { rows, alternates } = pool({ candidates: 6, targets: ["A", "B", "C"], offset: 9 });
  const shaped = selectDiverse(rows, alternates, 14, MARGIN, keyOf, {});
  eq("a pool smaller than the limit is not lengthened", shaped.length, 6);
}

// --- 5. the switch ------------------------------------------------------------------------
eq("the rule version production runs", SUGGESTION_DIVERSITY, 1);
eq("left out, production's version", diversityOption(undefined), 1);
eq("an unstamped recording replays with it off", diversityOption(null), 0);
eq('"off" switches it off', diversityOption("off"), 0);
eq('"0" switches it off', diversityOption("0"), 0);
eq("a stamp selects that version", diversityOption(1), 1);

// --- 6. Optimize: only recorded attacks ----------------------------------------------------
eq("the Optimize rule version", OPTIMIZE_USAGE_MOVES, 1);
eq("left out, production's version", usageOption(undefined), 1);
eq("0 restores the full-learnset pool", usageOption(0), 0);
eq('"off" restores the full-learnset pool', usageOption("off"), 0);
{
  const recorded = new Set(["grassyglide", "fakeout", "woodhammer", "highhorsepower", "knockoff"]);
  const held = new Set(["grassyglide", "fakeout", "woodhammer", "uturn"]);
  ok("a recorded attack is testable", testableMove("knockoff", recorded, held));
  ok("an unrecorded attack is not", !testableMove("drumbeating", recorded, held));
  ok("the set's OWN move is testable even when it is not recorded", testableMove("uturn", recorded, held));
  ok("a Pokemon with no record at all is not restricted", testableMove("drumbeating", null, held));
  ok("nor is one whose record came back empty", testableMove("drumbeating", new Set(), held));
}
{
  // A barely-played Pokemon: one recorded attack, and a set of four. It still has something to
  // test, because its own moves seed the pool before anything is ranked.
  const recorded = new Set(["foulplay"]);
  const held = new Set(["foulplay", "willowisp", "fakeout", "protect"]);
  const testable = [...held, "knockoff", "shadowsneak"].filter((k) => testableMove(k, recorded, held));
  eq("its own four moves stay testable, and nothing new is invented", testable.sort(),
    ["fakeout", "foulplay", "protect", "willowisp"]);
  ok("so the pool is never smaller than the set it started from", testable.length >= 4);
}

// --- 7. the app port agrees, number for number ---------------------------------------------
//
// 200 randomised row sets from a 32-bit xorshift that Python reproduces exactly, hashed with
// FNV-1a over "cap/offered/yields|key@target:score,..." per case. The APP asserts the SAME
// literal in tests/test_suggestion_diversity_v517.py, so a change made on one side only fails
// on BOTH sides -- which is the only kind of parity guard that cannot drift.
const PARITY_DIGEST = "c7ba04ff";
{
  let s32 = 0x2da5;
  const rnd = () => {
    s32 ^= (s32 << 13) >>> 0; s32 >>>= 0;
    s32 ^= s32 >>> 17;
    s32 ^= (s32 << 5) >>> 0; s32 >>>= 0;
    return s32 / 4294967296;
  };
  const order = (a, b) => b.score - a.score || a.position - b.position
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const parts = [];
  for (let c = 0; c < 200; c += 1) {
    const targets = ["A", "B", "C"].slice(0, 1 + Math.floor(rnd() * 3));
    if (rnd() < 0.15) targets[0] = "";
    const n = 1 + Math.floor(rnd() * 30);
    const limit = 1 + Math.floor(rnd() * 16);
    const rows = [];
    const alts = new Map();
    for (let i = 0; i < n; i += 1) {
      const key = `k${i}`;
      const group = [];
      for (const t of targets) {
        if (rnd() < 0.8) group.push({ key, name: key, position: i + 1, swap_target: t, score: Math.floor(rnd() * 1000) / 10 });
      }
      if (!group.length) group.push({ key, name: key, position: i + 1, swap_target: targets[0], score: Math.floor(rnd() * 1000) / 10 });
      group.sort(order);
      rows.push(group[0]);
      if (group.length > 1) alts.set(key, group.slice(1));
    }
    rows.sort(order);
    const report = {};
    const shaped = selectDiverse(rows, alts, limit, MARGIN, keyOf, report);
    parts.push(`${report.cap}/${report.offered}/${report.yielded.length}|`
      + shaped.map((r) => `${r.key}@${r.swap_target}:${r.score}`).join(","));
  }
  const text = parts.join(";");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  eq("the 200-case parity digest the app asserts too", [h.toString(16), text.length], [PARITY_DIGEST, 16171]);
}

console.log(`${checked} checked, ${failures.length} failed.`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
