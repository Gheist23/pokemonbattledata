// ONE SEARCHED LINE'S CONDITIONS AND PP MUST NOT BE EVERY LINE'S.
//
// `Solver.cloneState` is how the search gets a board to play a line out on, and it copied each
// Pokemon with a spread -- `{ ...m }`. A spread copies a reference, so the two MUTABLE objects
// hanging off a Pokemon were one object shared between a board and every board searched from it:
//
//   `st`  the seven condition slots. A Thunder Wave landed in one line paralysed the same
//         Pokemon on every other line; a Spore put it to sleep on all of them; a Toxic's
//         counter ran on all of them at once; and a cure in one line cured all of them.
//   `pp`  the four PP counters. The PP one line spent was spent on every other line, so a
//         four-turn search could run a move out of PP on a board that never used it.
//
// Found while adding `cure_status` (tests/run-cure-status.mjs), which writes to `st` far more
// often than anything before it did, and measured the plainest way there is: set `brn` on a
// clone and read it back off the original. It came back 1.
//
// `u`, `k` and `mega` are the prepared unit, its kit and its Mega form. Those are read-only and
// ARE shared on purpose -- a deep copy would rebuild them on every clone, and the search makes
// millions -- so this suite checks that they still are, because "fix it with structuredClone"
// is the obvious wrong answer and it would cost more than the bug.
//
//   node tests/run-state-clone.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest } from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => JSON.parse(readFileSync(join(root, ...p), "utf8"));

let checked = 0;
const failures = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const appData = read("data", "builder", "app-data.json");
const metaDoubles = read("data", "builder", "meta-doubles.json");
const LIVE_RULES = {
  effects: read("data", "builder", "move-effects.json"),
  liveHpRule: 1, chargeRule: 1, berryRule: 1, stagesRule: 1, confusionRule: 1, ppRule: 1,
  rberryRule: 1, bailRule: 1, shieldRule: 1, fieldTurnsRule: 1, abilityOpsRule: 1, hazardsRule: 1,
  pivotRule: 1, selfRollRule: 1, actionRollRule: 1, selfStatRule: 1,
};

function makeSolver() {
  const engine = new DamageEngine(appData);
  const ev = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(metaDoubles.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const t = new TournamentTest(evaluation, new KnownTeams(read("data", "builder", "known-teams.json")),
    new TeamSuggestions(evaluation), LIVE_RULES);
  return new Solver(t);
}

const set = (species, moves) => ({
  species, form: species, item: "", ability: "", nature: "Adamant", moves,
  bonuses: [2, 32, 0, 0, 0, 32],
});
const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });
const CHOMP = set("Garchomp", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"]);
const WALL = set("Amoonguss", ["Spore", "Pollen Puff", "Rage Powder", "Protect"]);

const solver = makeSolver();
const base = solver.buildState({
  sides: [[row(CHOMP, { front: true }), row(WALL, { front: true })],
    [row(WALL, { front: true }), row(WALL, { front: true })]],
  field: {},
});

// ---------------------------------------------------------------------------
// 1. the two that must be copied
// ---------------------------------------------------------------------------

{
  const clone = solver.cloneState(base);
  const original = base.active[0][0];
  const copy = clone.active[0][0];

  ok("the conditions are their own object", copy.st !== original.st);
  ok("...with the same contents", JSON.stringify(copy.st) === JSON.stringify(original.st),
    `${JSON.stringify(original.st)} vs ${JSON.stringify(copy.st)}`);
  // THE MEASUREMENT THE BUG WAS FOUND BY, in one line.
  copy.st.brn = 1;
  ok("a condition landed in a searched line does NOT reach the board it came from",
    (original.st.brn || 0) === 0, `original reads ${original.st.brn}`);
  original.st.par = 1;
  ok("...and not the other way round either", (copy.st.par || 0) === 0,
    `clone reads ${copy.st.par}`);
  original.st.par = 0;

  ok("the PP counters are their own array", copy.pp !== original.pp);
  ok("...with the same contents", JSON.stringify(copy.pp) === JSON.stringify(original.pp),
    `${JSON.stringify(original.pp)} vs ${JSON.stringify(copy.pp)}`);
  const had = original.pp[0];
  copy.pp[0] = 0;
  ok("the PP one line spends is not spent on the board it came from", original.pp[0] === had,
    `${had} -> ${original.pp[0]}`);
}

// ---------------------------------------------------------------------------
// 2. and the three that must NOT be, because they are read-only and large
// ---------------------------------------------------------------------------

{
  const clone = solver.cloneState(base);
  const original = base.active[0][0];
  const copy = clone.active[0][0];
  ok("the prepared unit is still shared", copy.u === original.u);
  ok("...and its kit", copy.k === original.k);
  // `mega` is null on a Pokemon with no stone, which is this one; the check is that it was not
  // deep-copied into a new object.
  ok("...and its Mega form", copy.mega === original.mega);
}

// ---------------------------------------------------------------------------
// 3. NOTHING MUTABLE IS SHARED, which is the invariant rather than the two names
// ---------------------------------------------------------------------------

{
  const clone = solver.cloneState(base);
  const original = base.active[0][0];
  const copy = clone.active[0][0];
  const allowed = new Set(["u", "k", "mega"]);
  const shared = [];
  for (const key of Object.keys(original)) {
    const value = original[key];
    if (!value || typeof value !== "object") continue;
    if (allowed.has(key)) continue;
    if (copy[key] === value) shared.push(key);
  }
  // A NEW mutable field on a unit fails here rather than leaking quietly for however long `st`
  // and `pp` did. If the new field really is read-only, its name goes in `allowed` above.
  ok("no mutable field is shared between a board and its clone", shared.length === 0,
    `shared: ${shared.join(", ")}`);
}

// ---------------------------------------------------------------------------
// 4. the board's own objects, which were already copied and must stay copied
// ---------------------------------------------------------------------------

{
  const clone = solver.cloneState(base);
  ok("the weather and terrain counters are copied", clone.board !== base.board);
  ok("...Tailwind's counters too", clone.board.tw !== base.board.tw);
  ok("...and the hazard layers", clone.board.hz !== base.board.hz);
  ok("...and which side has spent its Mega", clone.megaUsed !== base.megaUsed);
  ok("...and who moves second", clone.slower !== base.slower);
  ok("...and how far down each bench has been drawn", clone.next !== base.next);
}

// ---------------------------------------------------------------------------
// 5. end to end: a status laid in a played line stays in that line
// ---------------------------------------------------------------------------

{
  // Spore, from the Pokemon that carries it, onto the board's own Garchomp -- through the
  // search's own entry point rather than by writing `st` by hand.
  const s = makeSolver();
  const start = s.buildState({
    sides: [[row(CHOMP, { front: true }), row(WALL, { front: true })],
      [row(WALL, { front: true }), row(WALL, { front: true })]],
    field: {},
  });
  const before = JSON.stringify(start.active[0][0].st);
  const line = s.cloneState(start);
  const sleeper = line.active[1][0];
  const slot = sleeper.u.moves.findIndex((mv) => mv && mv.name === "Spore");
  ok("Spore is on the probe set", slot >= 0);
  if (slot >= 0) {
    s.t.effectRoll = () => 0;
    s.t.applyStatus(line.active[0][0], "sleep", 1);
    s.t.effectRoll = null;
    ok("the line's Garchomp is asleep", (line.active[0][0].st.slp || 0) === 1,
      JSON.stringify(line.active[0][0].st));
    ok("...and the board it was cloned from is not",
      JSON.stringify(start.active[0][0].st) === before,
      `${before} -> ${JSON.stringify(start.active[0][0].st)}`);
  }
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\nrun-state-clone: ${failures.length} of ${checked} checks FAILED`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\nrun-state-clone: ${checked} checks passed`);
