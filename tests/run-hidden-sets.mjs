// Rolling a hidden Pokemon (builder/hidden-sets.js).
//
// The Closed Team Sheet rolls a set for a Pokemon whose sheet you cannot see. What is checked
// here is that a hundred rolls look like a hundred Pokemon the format really brings:
//
//   1. the maths: the conditional Poisson draw reproduces the inclusion rates it was fitted to,
//      exactly, and the projection onto a feasible target is the only error it has;
//   2. the tiers: a real set when one exists, a graft when a pin empties the library, the usage
//      percentages when there is nothing on file -- and every pin honoured in all three;
//   3. the rules the usage data knows nothing about: one Mega Stone a side, no foreign stone,
//      66 stat points, and points that do not fight their own Nature.
//
//   node tests/run-hidden-sets.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData } from "../builder/common.js";
import { compact } from "../builder/engine.js";
import { HiddenSets, calibrate, draft, inclusion, projectRates } from "../builder/hidden-sets.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const near = (label, got, want, tolerance, detail = "") =>
  ok(label, Math.abs(got - want) <= tolerance, `${got} vs ${want} (tolerance ${tolerance})${detail ? ` ${detail}` : ""}`);

// A seeded generator, so a failure can be reproduced exactly.
function randomFrom(seed) {
  let state = (seed >>> 0) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// --- the data, the way the page loads it ------------------------------------------------------

const appData = read("data", "builder", "app-data.json");
const library = read("data", "builder", "pokemon-sets.json").sets;
const data = new BuilderData(appData);
for (const format of ["Doubles", "Singles"]) {
  data.ingestMeta(format, read("data", "builder", `meta-${format.toLowerCase()}.json`));
}
const hidden = new HiddenSets(data, "Doubles", library);

// ---------------------------------------------------------------------------
// 1. the projection onto a feasible target
// ---------------------------------------------------------------------------
{
  // Four moves a set, so every move's inclusion rate must add to 400 points. The published ten
  // do not, because the source publishes ten rows and the tail is real.
  const garchomp = data.usage("Doubles", "Garchomp", "Garchomp");
  const published = garchomp.moves.map(([, percent]) => percent / 100);
  const sum = published.reduce((a, b) => a + b, 0);
  near("Garchomp's published rates fall short of four moves", sum, 3.732, 0.001);
  const q = projectRates(published, 4);
  near("the projection puts them back on exactly four", q.reduce((a, b) => a + b, 0), 4, 1e-9);
  ok("and nothing is above certainty", q.every((value) => value <= 1 + 1e-12));
  ok("the order is kept", q[0] >= q[1] && q[1] >= q[2]);

  // Kangaskhan's Fake Out is published at 96.3% and scales past certainty, so the clamp has to
  // hold it at 1 and spread the rest over the others.
  const kanga = data.usage("Doubles", "Kangaskhan", "Kangaskhan");
  if (kanga) {
    const rates = kanga.moves.map(([, percent]) => percent / 100);
    const projected = projectRates(rates, 4);
    ok("a rate that scales past certainty is clamped at it", projected.every((value) => value <= 1 + 1e-12),
      `max ${Math.max(...projected)}`);
    near("and the total is still four", projected.reduce((a, b) => a + b, 0), 4, 1e-9);
  }

  // Fewer moves listed than slots: everything is taken.
  const few = projectRates([1, 0.5], 4);
  ok("a Pokemon with fewer moves than slots takes all of them", few.every((value) => value === 1));
}

// ---------------------------------------------------------------------------
// 2. the fitted draw is exact
// ---------------------------------------------------------------------------
{
  // The whole point of calibrating: the realised inclusion rates ARE the target, not something
  // near it. A plain weighted draw without replacement is not -- it pulls everything toward
  // uniform, which is what this test exists to tell apart.
  for (const name of ["Garchomp", "Incineroar", "Rillaboom", "Indeedee-F", "Amoonguss"]) {
    const usage = data.usage("Doubles", name, name);
    if (!usage || (usage.moves || []).length < 5) continue;
    const rates = usage.moves.map(([, percent]) => percent / 100);
    const q = projectRates(rates, 4);
    const w = calibrate(q, 4);
    const pi = inclusion(w, 4);
    const worst = Math.max(...pi.map((value, i) => Math.abs(value - q[i])));
    ok(`${name}: the fitted weights hit the target exactly`, worst < 1e-9, `worst ${worst.toExponential(2)}`);
  }

  // And the sampler draws the law the weights describe.
  const usage = data.usage("Doubles", "Garchomp", "Garchomp");
  const q = projectRates(usage.moves.map(([, percent]) => percent / 100), 4);
  const w = calibrate(q, 4);
  const rng = randomFrom(7);
  const counts = new Array(usage.moves.length).fill(0);
  const RUNS = 40000;
  for (let i = 0; i < RUNS; i += 1) {
    const picked = draft(w, 4, rng);
    ok("every draw is exactly four moves", picked.length === 4, String(picked.length));
    checked -= 1; // counted once below rather than forty thousand times
    for (const index of picked) counts[index] += 1;
  }
  checked += 1;
  const worst = Math.max(...counts.map((count, i) => Math.abs(count / RUNS - q[i])));
  ok("40,000 draws reproduce the fitted rates", worst < 0.012, `worst ${(worst * 100).toFixed(2)} points`);
  notes.push(`draw: Garchomp over ${RUNS.toLocaleString()} sets, worst inclusion error ${(worst * 100).toFixed(2)} points`);

  // The failure the calibration exists to prevent, measured on the same data: a plain weighted
  // draw without replacement.
  const plain = new Array(usage.moves.length).fill(0);
  const rates = usage.moves.map(([, percent]) => percent / 100);
  const rng2 = randomFrom(11);
  for (let i = 0; i < 20000; i += 1) {
    const pool = rates.map((value, index) => ({ value, index }));
    for (let slot = 0; slot < 4 && pool.length; slot += 1) {
      const total = pool.reduce((sum, entry) => sum + entry.value, 0);
      let roll = rng2() * total;
      let at = 0;
      while (at < pool.length - 1 && (roll -= pool[at].value) > 0) at += 1;
      plain[pool[at].index] += 1;
      pool.splice(at, 1);
    }
  }
  const plainWorst = Math.max(...plain.map((count, i) => Math.abs(count / 20000 - q[i])));
  ok("a plain weighted draw does NOT reproduce them, which is why it is not used",
    plainWorst > 0.05, `worst ${(plainWorst * 100).toFixed(2)} points`);
  notes.push(`plain weighted draw for the same Pokemon: worst ${(plainWorst * 100).toFixed(2)} points off`);
}

// ---------------------------------------------------------------------------
// 3. the tiers
// ---------------------------------------------------------------------------
{
  const rng = randomFrom(3);
  // Nothing pinned, a Pokemon with sets on file: a real set every time.
  const tiers = new Map();
  for (let i = 0; i < 300; i += 1) {
    const { tier, set } = hidden.rollOne("Garchomp", "Garchomp", null, rng);
    tiers.set(tier, (tiers.get(tier) || 0) + 1);
    ok("a rolled set always has moves", set.moves.length > 0 && set.moves.length <= 4);
    checked -= 1;
  }
  checked += 1;
  ok("a Pokemon with sets on file rolls real sets", tiers.get("real") === 300, JSON.stringify([...tiers]));

  // Every real set it can produce is one the library really holds.
  const realMoves = new Set(hidden.realSets("Garchomp", "Garchomp").map((row) => row.moves.map(compact).sort().join("+")));
  let fromLibrary = 0;
  for (let i = 0; i < 200; i += 1) {
    const { set } = hidden.rollOne("Garchomp", "Garchomp", null, rng);
    if (realMoves.has(set.moves.map(compact).sort().join("+"))) fromLibrary += 1;
  }
  ok("and the moveset is one a real team brought", fromLibrary === 200, `${fromLibrary} of 200`);

  // A pinned move the library has: still tier 1, and the pin is honoured.
  const withPin = hidden.realSets("Garchomp", "Garchomp").flatMap((row) => row.moves)[0];
  let honoured = 0;
  for (let i = 0; i < 200; i += 1) {
    const { set } = hidden.rollOne("Garchomp", "Garchomp", { moves: [withPin] }, rng);
    if (set.moves.some((move) => compact(move) === compact(withPin))) honoured += 1;
  }
  ok(`a pinned move the library knows (${withPin}) is always there`, honoured === 200, `${honoured} of 200`);

  // A pinned move NO real set has: the graft tier keeps a real body and the user's move.
  const grafts = new Map();
  let grafted = 0;
  for (let i = 0; i < 200; i += 1) {
    const { tier, set } = hidden.rollOne("Garchomp", "Garchomp", { moves: ["Flamethrower"] }, rng);
    grafts.set(tier, (grafts.get(tier) || 0) + 1);
    if (set.moves.some((move) => compact(move) === "flamethrower")) grafted += 1;
  }
  ok("a pin no real set has still honours the pin", grafted === 200, `${grafted} of 200`);
  ok("and it falls to the graft rather than throwing the library away",
    (grafts.get("graft") || 0) === 200, JSON.stringify([...grafts]));

  // Four moves whenever the Pokemon has four to give.
  for (let i = 0; i < 100; i += 1) {
    const { set } = hidden.rollOne("Garchomp", "Garchomp", { moves: ["Flamethrower"] }, rng);
    ok("a graft still fills all four slots", set.moves.length === 4, set.moves.join(", "));
    checked -= 1;
  }
  checked += 1;
  notes.push(`tiers: Garchomp unpinned ${JSON.stringify([...tiers])}, pinned Flamethrower ${JSON.stringify([...grafts])}`);
}

// ---------------------------------------------------------------------------
// 4. the rules the usage data knows nothing about
// ---------------------------------------------------------------------------
{
  const rng = randomFrom(5);
  // One Mega Stone a side. Rolled independently a four-Pokemon side carries two almost always.
  const side = [
    { species: "Garchomp", form: "Garchomp" },
    { species: "Charizard", form: "Charizard" },
    { species: "Gardevoir", form: "Gardevoir" },
    { species: "Incineroar", form: "Incineroar" },
  ];
  let worstStones = 0;
  for (let i = 0; i < 400; i += 1) {
    const rolled = hidden.rollSide(side, rng);
    const stones = rolled.filter(({ set }) => data.engine.isMegaStone(set.item)).length;
    worstStones = Math.max(worstStones, stones);
  }
  ok("a rolled side never carries two Mega Stones", worstStones <= 1, `worst ${worstStones}`);

  // A stone pinned by the user is the one that is kept.
  let pinnedKept = 0;
  for (let i = 0; i < 200; i += 1) {
    const rolled = hidden.rollSide([
      { species: "Garchomp", form: "Garchomp" },
      { species: "Charizard", form: "Charizard", fixed: { item: "Charizardite Y" } },
    ], rng);
    const stones = rolled.filter(({ set }) => data.engine.isMegaStone(set.item));
    if (stones.length === 1 && compact(stones[0].set.item) === "charizarditey") pinnedKept += 1;
  }
  ok("a stone the user pinned is the side's stone", pinnedKept === 200, `${pinnedKept} of 200`);

  // Legal stat points, and points that do not fight their own Nature.
  let shortPoints = 0;
  let contradictions = 0;
  const RUNS = 600;
  for (let i = 0; i < RUNS; i += 1) {
    const { set } = hidden.rollOne("Garchomp", "Garchomp", null, rng);
    const total = set.bonuses.reduce((a, b) => a + b, 0);
    if (total !== 66) shortPoints += 1;
    const [, down] = data.natures[set.nature] || ["", ""];
    const index = { hp: 0, attack: 1, defense: 2, "sp attack": 3, "sp defense": 4, speed: 5 }[String(down || "").toLowerCase()];
    if (index !== undefined && set.bonuses[index] > 0) contradictions += 1;
  }
  ok("every rolled spread totals the game's 66 points", shortPoints === 0, `${shortPoints} of ${RUNS} did not`);
  ok("and none of them invests in the stat its own Nature lowers", contradictions === 0, `${contradictions} of ${RUNS}`);

  // A Pokemon with nothing on file falls to the usage tier and still comes out legal.
  const bare = [...data.meta.Doubles.pokemon].reverse()
    .find((row) => hidden.realSets(row.species, row.form).length === 0 && (row.moves || []).length >= 4);
  if (bare) {
    let legal = 0;
    for (let i = 0; i < 200; i += 1) {
      const { tier, set } = hidden.rollOne(bare.species, bare.form, null, rng);
      if (tier === "usage" && set.moves.length === 4 && set.bonuses.reduce((a, b) => a + b, 0) === 66) legal += 1;
    }
    ok(`a Pokemon with no sets on file (${bare.name}) rolls a legal set from the percentages`,
      legal === 200, `${legal} of 200`);
    notes.push(`fallback: ${bare.name} has no recorded sets and rolls from the percentages`);
  }
}

// ---------------------------------------------------------------------------
// 5. how much of the ladder each tier has to carry
// ---------------------------------------------------------------------------
{
  const rows = data.meta.Doubles.pokemon;
  const covered = rows.filter((row) => hidden.realSets(row.species, row.form).length > 0).length;
  const topHundred = rows.slice(0, 100).filter((row) => hidden.realSets(row.species, row.form).length > 0).length;
  ok("the set library covers most of the Pokemon people actually face", topHundred >= 80,
    `${topHundred} of the top 100`);
  notes.push(`coverage: real sets on file for ${covered} of ${rows.length} ranked Doubles Pokemon, ${topHundred} of the top 100`);
}

for (const line of notes) console.log(line);
if (failures.length) {
  console.error(`\n${checked} checks, ${failures.length} failed:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\n${checked} checks, all passed.`);
