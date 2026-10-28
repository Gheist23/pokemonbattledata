// The berries in a played game (builder/tournament-test.js).
//
// The game has exactly 28 berries -- one item icon each, and game8's Pokemon Champions berry
// list names the same 28 and none besides. Of those, 18 halve a super-effective hit of their
// type (Chilan halves ANY Normal hit) and 10 heal, cure or restore. This engine knew ONE of
// them: the Sitrus Berry. Everything else was simply absent.
//
// What that cost, measured on the shipped battle data (summed usage share across every species
// and format): Sitrus 4867 on 400 species, then the resistance berries (Chople 293, Colbur 292,
// Shuca 195, Occa 133, Roseli 114, ...), then Lum 290 on 79 species and Chesto 140 on 29. So the
// third and fourth most carried berries in the format did nothing at all: a Lum Berry holder sat
// through a Spore, and a Chesto holder stayed asleep.
//
// What is checked here:
//
//   1. the data: 18 resistance berries, Chilan on plain Normal;
//   2. Oran restores a FLAT 10 HP, which is a different share for every holder -- not the 10% a
//      percentage scale would read and not Sitrus's quarter;
//   3. each cure berry clears its OWN status and leaves every other one standing;
//   4. a cure berry is spent IN PROPORTION, because a condition here is a probability: four 30%
//      burns use up one Rawst, and the fourth one sticks;
//   5. Persim cures confusion -- it has since TOURNAMENT_CONFUSION gave the engine a `cnf`
//      field -- and with the confusion rule off there is still nothing for it to cure, which is
//      the state this suite's engine is in;
//   6. a cured status reports as not landed, so the turn says "fails" rather than "slept";
//   7. both states survive a round trip through a described board, like `sash` and `berry`.
//
//   node tests/run-berries.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, RESIST_BERRIES } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest, TOURNAMENT_BERRY } from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const knownRaw = JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8"));
const effects = JSON.parse(readFileSync(join(root, "data", "builder", "move-effects.json"), "utf8"));

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/** A Solver whose turn engine models the berries, as the played game builds it. */
function makeSolver({ format = "Doubles", berry = 1 } = {}) {
  const engine = new DamageEngine(appData);
  const meta = JSON.parse(readFileSync(join(root, "data", "builder", `meta-${format.toLowerCase()}.json`), "utf8"));
  const ev = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const tournament = new TournamentTest(evaluation, new KnownTeams(knownRaw), new TeamSuggestions(evaluation),
    { effects, liveHpRule: 1, berryRule: berry });
  return new Solver(tournament);
}

const set = (species, item, ability, nature, moves, bonuses, form) => ({
  species, form: form || species, item, ability, nature, moves, bonuses: [...bonuses],
});

const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });
const board = (ourRows, theirRows, field = {}) => ({ sides: [ourRows, theirRows], field });

const MOVES = ["Pollen Puff", "Rage Powder", "Spore", "Protect"];
const EVS = [32, 0, 2, 0, 32, 0];
/** Amoonguss, holding whichever berry the case is about. */
const holder = (item) => set("Amoonguss", item, "Regenerator", "Calm", MOVES, EVS);
const FOE = set("Garchomp", "Life Orb", "Rough Skin", "Jolly",
  ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]);

/** One row on the field, holding `item`, plus the solver it belongs to. */
function standing(item, hp = 100) {
  const solver = makeSolver();
  const state = solver.buildState(board(
    [row(holder(item), { front: true, hp }), row(FOE, { front: true })],
    [row(FOE, { front: true }), row(FOE, { front: true })],
  ));
  return { solver, state, m: state.active[0][0] };
}

// ---------------------------------------------------------------------------
// 1. the data
// ---------------------------------------------------------------------------
{
  ok("18 resistance berries ship", Object.keys(RESIST_BERRIES).length === 18,
    String(Object.keys(RESIST_BERRIES).length));
  ok("and Chilan is the one that answers plain Normal", RESIST_BERRIES["chilan berry"] === "Normal",
    String(RESIST_BERRIES["chilan berry"]));
  const { m } = standing("Sitrus Berry");
  ok("the effects model is on, so the status fields exist", Boolean(m.st));
  ok("and a condition is a share rather than a flag",
    m.st && ["brn", "psn", "tox", "par", "slp", "frz"].every((f) => m.st[f] === 0));
  notes.push(`st fields: ${m.st ? Object.keys(m.st).join(", ") : "none"}`);
}

// ---------------------------------------------------------------------------
// 1b. the rule is off by default, so the published numbers do not move
// ---------------------------------------------------------------------------
{
  // Same reason as TOURNAMENT_LIVE_HP and TOURNAMENT_CHARGE: the Tournament Test's numbers are
  // published and the recorded parity vectors pin them. The played game asks for version 1.
  ok("TOURNAMENT_BERRY is 0", TOURNAMENT_BERRY === 0, String(TOURNAMENT_BERRY));
  const off = makeSolver({ berry: 0 });
  ok("and an instance built without it does not model the berries", off.t.berryOn === false);
  ok("while the played game's instance does", makeSolver().t.berryOn === true);

  // With the rule off, a Lum Berry holder is put to sleep exactly as before.
  const state = off.buildState(board(
    [row(holder("Lum Berry"), { front: true }), row(FOE, { front: true })],
    [row(FOE, { front: true }), row(FOE, { front: true })],
  ));
  const m = state.active[0][0];
  const landed = off.t.applyStatus(m, "sleep", 1);
  ok("rule 0: the Spore lands on the Lum Berry holder", landed === 1 && m.st.slp === 1,
    `${landed} / ${m.st.slp}`);
  ok("rule 0: and the berry is untouched", m.cure === 1, String(m.cure));

  // ...and an Oran holder at half health heals nothing.
  const oran = off.buildState(board(
    [row(holder("Oran Berry"), { front: true, hp: 50 }), row(FOE, { front: true })],
    [row(FOE, { front: true }), row(FOE, { front: true })],
  ));
  const o = oran.active[0][0];
  const before = o.hp;
  off.t.berry(o);
  ok("rule 0: the Oran Berry does not heal", near(o.hp, before), `${o.hp} vs ${before}`);

  // The one berry that was always there keeps working under rule 0, which is the proof that
  // this rule gates only what it says it gates.
  const sit = off.buildState(board(
    [row(holder("Sitrus Berry"), { front: true, hp: 50 }), row(FOE, { front: true })],
    [row(FOE, { front: true }), row(FOE, { front: true })],
  ));
  const s = sit.active[0][0];
  const sitBefore = s.hp;
  off.t.berry(s);
  ok("rule 0: the Sitrus Berry still heals its quarter", near(s.hp, sitBefore + 0.25),
    `${s.hp} vs ${sitBefore + 0.25}`);
}

// ---------------------------------------------------------------------------
// 2. Oran restores a flat 10 HP
// ---------------------------------------------------------------------------
{
  const { solver, m } = standing("Oran Berry", 50);
  const maxHp = solver.t.ev.engine.finalStats(m.u.mon).hp;
  ok("the kit knows Oran's share of THIS holder's maximum", near(m.k.oran, 10 / maxHp),
    `${m.k.oran} vs ${10 / maxHp}`);
  ok("which is not the 10% a percentage scale would read", !near(m.k.oran, 0.1),
    `maxHp ${maxHp}`);
  ok("and not Sitrus's quarter", !near(m.k.oran, 0.25));
  const before = m.hp;
  solver.t.berry(m);
  ok("it heals exactly that share at half HP", near(m.hp, before + 10 / maxHp),
    `${m.hp} vs ${before + 10 / maxHp}`);
  ok("and is gone afterwards", m.oran === false);
  const once = m.hp;
  solver.t.berry(m);
  ok("so a second trigger does nothing", near(m.hp, once));
  notes.push(`Oran on Amoonguss: ${maxHp} max HP, so ${(1000 / maxHp).toFixed(2)}% a berry`);
}

{
  // The crisp proof that this is a flat 10 HP and not a percentage: give the SAME berry to a
  // much bulkier holder and the share has to come out smaller. A percentage would be identical
  // on both, which is exactly the reading the old code had.
  const LAX = set("Snorlax", "Oran Berry", "Thick Fat", "Careful",
    ["Body Slam", "Crunch", "Protect", "Yawn"], [0, 32, 2, 0, 32, 0]);
  const solver = makeSolver();
  const state = solver.buildState(board(
    [row(LAX, { front: true, hp: 50 }), row(FOE, { front: true })],
    [row(FOE, { front: true }), row(FOE, { front: true })],
  ));
  const lax = state.active[0][0];
  const laxMax = solver.t.ev.engine.finalStats(lax.u.mon).hp;
  const thin = standing("Oran Berry", 50);
  const thinMax = thin.solver.t.ev.engine.finalStats(thin.m.u.mon).hp;
  ok("the bulkier holder really is bulkier", laxMax > thinMax * 1.5, `${laxMax} vs ${thinMax}`);
  ok("so the same Oran Berry heals it a SMALLER share", lax.k.oran < thin.m.k.oran,
    `${lax.k.oran} vs ${thin.m.k.oran}`);
  ok("and both are a flat 10 HP of their own maximum",
    near(lax.k.oran, 10 / laxMax) && near(thin.m.k.oran, 10 / thinMax));
  const before = lax.hp;
  solver.t.berry(lax);
  ok("the bulky holder heals its own share", near(lax.hp, before + 10 / laxMax),
    `${lax.hp} vs ${before + 10 / laxMax}`);
  notes.push(`Oran: ${(1000 / thinMax).toFixed(2)}% on ${thinMax} HP vs ${(1000 / laxMax).toFixed(2)}% on ${laxMax} HP`);
}

{
  // The quarter is Sitrus's, whoever holds it, and must not have moved.
  const { solver, m } = standing("Sitrus Berry", 50);
  const before = m.hp;
  solver.t.berry(m);
  ok("Sitrus still restores a quarter of the maximum", near(m.hp, before + 0.25),
    `${m.hp} vs ${before + 0.25}`);
  ok("and is eaten once", m.berry === false);
}

{
  // Above half, neither of them fires.
  for (const item of ["Oran Berry", "Sitrus Berry"]) {
    const { solver, m } = standing(item, 51);
    const before = m.hp;
    solver.t.berry(m);
    ok(`${item} holds until half HP`, near(m.hp, before), `${m.hp} vs ${before}`);
  }
}

// ---------------------------------------------------------------------------
// 3. each cure berry clears its own status and no other
// ---------------------------------------------------------------------------
{
  const FIELDS = ["brn", "psn", "tox", "par", "slp", "frz"];
  const CASES = [
    ["Rawst Berry", "burn", "brn"],
    ["Cheri Berry", "paralysis", "par"],
    ["Pecha Berry", "poison", "psn"],
    ["Pecha Berry", "toxic", "tox"],
    ["Aspear Berry", "freeze", "frz"],
    ["Chesto Berry", "sleep", "slp"],
  ];
  for (const [item, status, field] of CASES) {
    const { solver, m } = standing(item);
    const landed = solver.t.applyStatus(m, status, 1);
    ok(`${item} cures ${status}`, m.st[field] === 0, `${field}=${m.st[field]}`);
    ok(`and ${item} reports that nothing landed`, landed === 0, String(landed));
    ok(`and ${item} is used up`, near(m.cure, 0), String(m.cure));
    ok(`and ${item} leaves every other condition untouched`,
      FIELDS.every((f) => m.st[f] === 0));
  }
  // Each one is blind to the other five.
  const WRONG = [
    ["Rawst Berry", "paralysis", "par"],
    ["Cheri Berry", "burn", "brn"],
    ["Aspear Berry", "poison", "psn"],
    ["Chesto Berry", "freeze", "frz"],
    ["Pecha Berry", "sleep", "slp"],
  ];
  for (const [item, status, field] of WRONG) {
    const { solver, m } = standing(item);
    const landed = solver.t.applyStatus(m, status, 1);
    ok(`${item} does NOT cure ${status}`, m.st[field] === 1, `${field}=${m.st[field]}`);
    ok(`so ${item} reports it landed`, landed === 1, String(landed));
    ok(`and ${item} is still in hand`, near(m.cure, 1), String(m.cure));
  }
}

{
  // Lum takes any of the six, one of them.
  for (const [status, field] of [["burn", "brn"], ["poison", "psn"], ["toxic", "tox"],
    ["paralysis", "par"], ["sleep", "slp"], ["freeze", "frz"]]) {
    const { solver, m } = standing("Lum Berry");
    const landed = solver.t.applyStatus(m, status, 1);
    ok(`Lum cures ${status}`, m.st[field] === 0 && landed === 0, `${field}=${m.st[field]}`);
    ok(`and is then gone, so a second ${status} sticks`, near(m.cure, 0));
    const again = solver.t.applyStatus(m, status, 1);
    ok(`the second ${status} lands on the spent Lum`, again === 1 && m.st[field] === 1,
      `${again} / ${m.st[field]}`);
  }
}

// ---------------------------------------------------------------------------
// 4. a cure berry is spent in proportion
// ---------------------------------------------------------------------------
{
  // A condition here is a PROBABILITY. "Cures the first status and disappears" therefore spends
  // the berry in the same proportion: with chance 0.3 the berry was the thing that got used. A
  // boolean would cure a 30% burn outright AND throw the whole berry away -- wrong both ways.
  const { solver, m } = standing("Rawst Berry");
  const shares = [];
  for (let i = 0; i < 3; i += 1) {
    solver.t.applyStatus(m, "burn", 0.3);
    shares.push(Number(m.cure.toFixed(6)));
    ok(`burn ${i + 1} of 0.3 is cured whole`, near(m.st.brn, 0, 1e-9), String(m.st.brn));
  }
  ok("three 30% burns leave a tenth of the Rawst", near(m.cure, 0.1, 1e-9), shares.join(" -> "));
  const landed = solver.t.applyStatus(m, "burn", 0.3);
  ok("the fourth is only cured as far as the berry goes", near(m.st.brn, 0.2, 1e-9), String(m.st.brn));
  ok("and the rest of it lands", near(landed, 0.2, 1e-9), String(landed));
  ok("with the berry now empty", near(m.cure, 0, 1e-9), String(m.cure));
}

// ---------------------------------------------------------------------------
// 5. Persim is deliberately absent
// ---------------------------------------------------------------------------
{
  // THIS SECTION USED TO SAY THE OPPOSITE. Persim cures confusion only, and when the berries
  // landed `st` had no `cnf` field, so its holder deliberately got no cure -- mapping it to an
  // empty list would have read as "modelled, and does nothing". TOURNAMENT_CONFUSION gave the
  // engine a confusion, so Persim now cures what it says it cures, and what is left of the old
  // note is the part that is still true: with the confusion rule OFF there is nothing to cure.
  const { solver, m } = standing("Persim Berry");
  ok("a Persim holder now carries a cure", (m.k.cures || []).includes("cnf"),
    JSON.stringify(m.k.cures));
  ok("and a cure budget", m.cure === 1, String(m.cure));
  ok("`st` has a confusion field", m.st && "cnf" in m.st, Object.keys(m.st || {}).join(","));
  // With the confusion rule off -- which is this suite's engine -- it still cures nothing,
  // because nothing can confuse anybody.
  ok("but this engine models no confusion", solver.t.confusionOn === false);
  ok("so the Persim Berry stays in hand", solver.t.confuse(m, 1) === 0 && m.cure === 1);
  const landed = solver.t.applyStatus(m, "burn", 1);
  ok("and a burn lands on it as on any other item", landed === 1 && m.st.brn === 1);
  ok("with the Persim Berry untouched", m.cure === 1, String(m.cure));
  // Leppa restores PP, which is TOURNAMENT_PP's business and not a cure: no `cures` entry.
  const pp = standing("Leppa Berry");
  ok("a Leppa holder carries no cure", pp.m.k.cures === null, JSON.stringify(pp.m.k.cures));
  ok("it carries a PP restore instead", pp.m.k.leppa === true && pp.m.leppa === true);
}

// ---------------------------------------------------------------------------
// 6. a cured status reports as not landed
// ---------------------------------------------------------------------------
{
  // Spore into a Lum Berry: the status move has to come back as a failure, because the only
  // thing the turn can honestly say is that nothing stuck.
  const solver = makeSolver();
  const state = solver.buildState(board(
    [row(holder("Lum Berry"), { front: true }), row(FOE, { front: true })],
    [row(holder("Sitrus Berry"), { front: true }), row(FOE, { front: true })],
  ));
  const target = state.active[0][0];
  const events = [];
  const pickFor = (s, name) => {
    const list = solver.slotCandidates(state, s, 0, { cap: 0 });
    const found = list.find((a) => a.move === name && a.target === 0);
    return found ? [found] : [];
  };
  solver.t.plannedTurn(state.active, state.board, state.slower, 1, events, null, [
    solver.planFor(state, [], 0),
    solver.planFor(state, pickFor(1, "Spore"), 1),
  ]);
  ok("the Lum Berry holder is not asleep", near(target.st.slp, 0), String(target.st.slp));
  ok("the Lum Berry is spent", near(target.cure, 0), String(target.cure));
  ok("and the turn does not claim it slept",
    !events.some((e) => e.kind === "sleep" && e.target === target.u));
  notes.push(`Spore into a Lum Berry: ${events.map((e) => e.kind).join(",") || "no events"}`);
}

// ---------------------------------------------------------------------------
// 7. both states survive a described board
// ---------------------------------------------------------------------------
{
  // `fresh` reads the berry off the KIT, which is a fact about the set and not about this
  // battle. A board describing a game in progress therefore has to be able to say the berry is
  // already gone -- exactly the reason `sash` and `berry` are restored there.
  const solver = makeSolver();
  const spent = solver.buildState(board(
    [row(holder("Lum Berry"), { front: true, cure: 0 }), row(FOE, { front: true })],
    [row(FOE, { front: true }), row(FOE, { front: true })],
  ));
  const m = spent.active[0][0];
  ok("a board can say the Lum Berry is already eaten", m.cure === 0, String(m.cure));
  const landed = solver.t.applyStatus(m, "burn", 1);
  ok("so the burn lands", landed === 1 && m.st.brn === 1);

  const half = solver.buildState(board(
    [row(holder("Lum Berry"), { front: true, cure: 0.4 }), row(FOE, { front: true })],
    [row(FOE, { front: true }), row(FOE, { front: true })],
  ));
  ok("and a half-spent berry comes back as a SHARE, not rounded to whole",
    near(half.active[0][0].cure, 0.4), String(half.active[0][0].cure));

  const gone = solver.buildState(board(
    [row(holder("Oran Berry"), { front: true, hp: 40, oran: false }), row(FOE, { front: true })],
    [row(FOE, { front: true }), row(FOE, { front: true })],
  ));
  const o = gone.active[0][0];
  const before = o.hp;
  solver.t.berry(o);
  ok("an Oran a board says is eaten does not heal again", near(o.hp, before),
    `${o.hp} vs ${before}`);

  // And a board that says nothing still gets the berry, because the set holds it.
  const fresh = solver.buildState(board(
    [row(holder("Lum Berry"), { front: true }), row(FOE, { front: true })],
    [row(FOE, { front: true }), row(FOE, { front: true })],
  ));
  ok("a board that says nothing hands the berry over whole", fresh.active[0][0].cure === 1);
}

// ---------------------------------------------------------------------------

if (notes.length) notes.forEach((n) => console.log(`  ${n}`));
if (failures.length) {
  failures.forEach((f) => console.log(`FAIL ${f}`));
  console.log(`${checked} checked, ${failures.length} failed.`);
  process.exit(1);
}
console.log(`${checked} checked, 0 failed.`);
