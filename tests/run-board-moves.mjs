// Six moves that act on the BOARD rather than on a target slot (TOURNAMENT_ABILITY_OPS).
//
// Psych Up, Topsy-Turvy, Pain Split, Aqua Ring, Leech Seed and Revival Blessing each compiled to
// an op `runEffectOps` had no branch for, so using one did nothing at all -- and `play-game.js`
// offers a status move only when it can run every one of its ops, so they were drawn refused on
// the sheet with "Not available this turn". Between them they are brought 52 times across the
// registered teams.
//
// They are handled ABOVE the per-target loop, with the weather and the hazards, because none of
// them is an effect applied to each target in turn: Psych Up writes to the user from the target,
// Pain Split writes to both, Revival Blessing writes to the bench.
//
//   node tests/run-board-moves.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData, makeSet } from "../builder/common.js";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest } from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";

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

const FORMAT = "Doubles";
const appData = read("data", "builder", "app-data.json");
const meta = read("data", "builder", `meta-${FORMAT.toLowerCase()}.json`);
const effects = read("data", "builder", "move-effects.json");
const knownRaw = read("data", "builder", "known-teams.json");
const data = new BuilderData(appData);
data.ingestMeta(FORMAT, meta);

function makeSolver(abilityOpsRule) {
  const ev = new TeamEvaluator(data, new DamageEngine(appData), FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Solver(new TournamentTest(evaluation, new KnownTeams(knownRaw),
    new TeamSuggestions(evaluation), { effects, liveHpRule: 1, abilityOpsRule }));
}
function setFor(species, extra = {}) {
  for (const r of meta.pokemon) {
    if (String(r.species).toLowerCase() !== species.toLowerCase()) continue;
    const base = data.commonSet(FORMAT, r.species, r.form);
    if (base && base.moves?.length) return makeSet({ ...base, moves: [...base.moves], ...extra });
  }
  return null;
}
const A = setFor("Garchomp");
const B = setFor("Dragonite");
const row = (set, extra = {}) => ({ set, hp: 100, front: false, ...extra });
function board(rule) {
  const solver = makeSolver(rule);
  const state = solver.buildState({
    sides: [[row(A, { front: true }), row(B, { front: true }), row(B), row(B)],
      [row(B, { front: true }), row(A, { front: true }), row(A), row(A)]],
    field: {},
  });
  return { solver, state, me: state.active[0][0], foe: state.active[1][0] };
}
const use = (solver, state, m, target, moveName) => {
  const ops = solver.t.effectsOf(moveName) || [];
  return solver.t.runEffectOps(m, target, { slot: 0, ops }, state.active, null, state.board);
};
const shipped = (name) => (effects.moves || {})[name.toLowerCase().replace(/[^a-z0-9]/g, "")] || null;

/* ---------------------------------------------------- they are all shipped */
for (const name of ["Psych Up", "Topsy-Turvy", "Pain Split", "Aqua Ring", "Leech Seed", "Revival Blessing"]) {
  ok(`${name} ships its op`, Boolean(shipped(name)), name);
}

/* ---------------------------------------------------- Psych Up */
{
  const { solver, state, me, foe } = board(1);
  foe.atk = 2; foe.spe = -1; foe.def = 1;
  use(solver, state, me, foe, "Psych Up");
  ok("Psych Up takes the target's stages", me.atk === 2 && me.spe === -1 && me.def === 1,
    JSON.stringify([me.atk, me.spe, me.def]));
  ok("and leaves the target with its own", foe.atk === 2);
  const off = board(0);
  off.foe.atk = 2;
  use(off.solver, off.state, off.me, off.foe, "Psych Up");
  ok("rule 0: it does nothing", (off.me.atk || 0) === 0, String(off.me.atk));
}

/* ---------------------------------------------------- Topsy-Turvy */
{
  const { solver, state, me, foe } = board(1);
  foe.atk = 2; foe.spe = -1;
  use(solver, state, me, foe, "Topsy-Turvy");
  ok("Topsy-Turvy turns every stage round", foe.atk === -2 && foe.spe === 1,
    JSON.stringify([foe.atk, foe.spe]));
  ok("and the user keeps its own", (me.atk || 0) === 0);
}

/* ---------------------------------------------------- Pain Split */
{
  const { solver, state, me, foe } = board(1);
  me.hp = 0.2;
  foe.hp = 1;
  const mine = me.k.maxHp;
  const theirs = foe.k.maxHp;
  const pool = (0.2 * mine + 1 * theirs) / 2;
  use(solver, state, me, foe, "Pain Split");
  ok("Pain Split averages the two in POINTS, not in shares",
    Math.abs(me.hp - pool / mine) < 1e-9 && Math.abs(foe.hp - pool / theirs) < 1e-9,
    `${me.hp} / ${foe.hp}`);
  ok("the hurt one gained and the healthy one lost", me.hp > 0.2 && foe.hp < 1);
  notes.push(`Pain Split: ${(me.hp * 100).toFixed(1)}% and ${(foe.hp * 100).toFixed(1)}% of their own maxima`);
}

/* ---------------------------------------------------- Aqua Ring */
{
  const { solver, state, me } = board(1);
  use(solver, state, me, null, "Aqua Ring");
  ok("Aqua Ring is remembered on the Pokemon", me.aquaRing === true);
  me.hp = 0.5;
  solver.t.endOfTurn(state.active, null, state.board);
  ok("and gives a sixteenth back at the end of the turn", Math.abs(me.hp - (0.5 + 1 / 16)) < 1e-9,
    String(me.hp));
}

/* ---------------------------------------------------- Leech Seed */
{
  const { solver, state, me, foe } = board(1);
  const grass = (foe.k.types || []).includes("Grass");
  use(solver, state, me, foe, "Leech Seed");
  if (!grass) {
    ok("Leech Seed sticks to the target", foe.seededBy === 0, String(foe.seededBy));
    foe.hp = 0.9;
    me.hp = 0.5;
    solver.t.endOfTurn(state.active, null, state.board);
    ok("the seeded one loses an eighth", Math.abs(foe.hp - (0.9 - 1 / 8)) < 1e-9, String(foe.hp));
    ok("and the side that seeded it gains", me.hp > 0.5, String(me.hp));
    notes.push(`Leech Seed: ${(0.9 - foe.hp) * 100}% off the target, ${((me.hp - 0.5) * 100).toFixed(1)}% to the seeder`);
  }
  // a Grass type cannot be seeded
  const grassy = meta.pokemon.find((r) => (appData.species.find((sp) => sp.name === r.species)?.forms || [])
    .some((f) => (f.types || []).includes("Grass")));
  if (grassy) {
    const g = board(1);
    const gset = setFor(grassy.species);
    const gstate = g.solver.buildState({
      sides: [[row(A, { front: true }), row(B, { front: true })], [row(gset, { front: true }), row(B, { front: true })]],
      field: {},
    });
    use(g.solver, gstate, gstate.active[0][0], gstate.active[1][0], "Leech Seed");
    ok("a Grass type cannot be seeded", gstate.active[1][0].seededBy === undefined,
      String(gstate.active[1][0].seededBy));
    notes.push(`Leech Seed: ${grassy.species} is immune`);
  }
}

/* ---------------------------------------------------- Revival Blessing */
{
  const { solver, state, me } = board(1);
  const fallen = state.sides[0].find((x) => x && !state.active[0].includes(x));
  fallen.out = true;
  fallen.hp = 0;
  use(solver, state, me, null, "Revival Blessing");
  ok("Revival Blessing brings a team-mate back", fallen.out === false, String(fallen.out));
  ok("at half its maximum", Math.abs(fallen.hp - 0.5) < 1e-9, String(fallen.hp));

  // ...and says so when there is nobody to bring back
  const none = board(1);
  const { did } = use(none.solver, none.state, none.me, null, "Revival Blessing");
  ok("with nobody down it reports that, rather than doing nothing silently",
    (did || []).some((line) => /nobody/i.test(String(line))), JSON.stringify(did));

  const off = board(0);
  const down = off.state.sides[0].find((x) => x && !off.state.active[0].includes(x));
  down.out = true;
  down.hp = 0;
  use(off.solver, off.state, off.me, null, "Revival Blessing");
  ok("rule 0: nobody comes back", down.out === true);
}

/* ---------------------------------------------------- the three that change an Ability */
{
  // The kit is computed from the Ability when the unit is built, so each of these rebuilds
  // the unit (`setAbility` -> `abilityUnit`). Checked on the KIT, not just the name, because
  // a name that changes while the kit does not is the bug this shape invites.
  const { solver, state, me, foe } = board(1);
  const mine = me.u.mon.ability;
  const theirs = foe.u.mon.ability;
  ok("the two start with different Abilities", mine !== theirs, `${mine} / ${theirs}`);
  use(solver, state, me, foe, "Skill Swap");
  ok("Skill Swap trades them", me.u.mon.ability === theirs && foe.u.mon.ability === mine,
    `${me.u.mon.ability} / ${foe.u.mon.ability}`);
  ok("and the kit was rebuilt with it", me.k === me.u.kit && me.k.types.length > 0);

  const ent = board(1);
  const entMine = ent.me.u.mon.ability;
  use(ent.solver, ent.state, ent.me, ent.foe, "Entrainment");
  ok("Entrainment gives the target the user's Ability", ent.foe.u.mon.ability === entMine,
    `${entMine} -> ${ent.foe.u.mon.ability}`);
  ok("and the user keeps its own", ent.me.u.mon.ability === entMine);

  const role = board(1);
  const roleTheirs = role.foe.u.mon.ability;
  use(role.solver, role.state, role.me, role.foe, "Role Play");
  ok("Role Play takes the target's", role.me.u.mon.ability === roleTheirs,
    `${role.me.u.mon.ability} / ${roleTheirs}`);

  const off = board(0);
  const offMine = off.me.u.mon.ability;
  use(off.solver, off.state, off.me, off.foe, "Skill Swap");
  ok("rule 0: nothing is swapped", off.me.u.mon.ability === offMine, off.me.u.mon.ability);
  notes.push(`Skill Swap: ${mine} <-> ${theirs}`);
}
{
  // MUMMY, on the contact seam.
  const solver = makeSolver(1);
  const mummy = makeSet({ ...B, moves: [...B.moves], ability: "Mummy" });
  const state = solver.buildState({
    sides: [[row(A, { front: true }), row(B, { front: true })],
      [row(mummy, { front: true }), row(A, { front: true })]],
    field: {},
  });
  const me = state.active[0][0];
  const foe = state.active[1][0];
  ok("Mummy is read onto the kit", foe.k.contactAbility === "Mummy", String(foe.k.contactAbility));
  const slot = me.u.moves.findIndex((i) => i?.contact);
  if (slot >= 0) {
    const hit = { slot, frac: 0.2, lo: 0.2, hi: 0.2, odds: 1, rollLo: 0.2, rollHigh: 0.2,
      priority: 0, spread: false, self: 0, rberry: false };
    solver.t.deal(me, foe, hit, null, false, null, state.active[0], state.board);
    ok("touching a Mummy makes the attacker one too", /mummy/i.test(me.u.mon.ability),
      me.u.mon.ability);
    notes.push(`Mummy: the attacker became ${me.u.mon.ability}`);
  }
}

/* ---------------------------------------------------- the item changes hands */
{
  // KNOCK OFF is a DAMAGING move, so its op arrives through `secondaries` and not through
  // `runEffectOps` -- the trap Cursed Body fell into once already.
  const solver = makeSolver(1);
  const sashed = makeSet({ ...B, moves: [...B.moves], item: "Focus Sash" });
  const knocker = makeSet({ ...A, moves: ["Knock Off", ...A.moves.filter((n) => n !== "Knock Off")].slice(0, 4) });
  const state = solver.buildState({
    sides: [[row(knocker, { front: true }), row(B, { front: true })],
      [row(sashed, { front: true }), row(A, { front: true })]],
    field: {},
  });
  const me = state.active[0][0];
  const foe = state.active[1][0];
  const slot = me.u.moves.findIndex((i) => i?.key === "knockoff");
  ok("the test attacker really has Knock Off", slot >= 0, String(slot));
  ok("and the target really holds a Focus Sash", foe.u.mon.item === "Focus Sash" && foe.sash === true,
    `${foe.u.mon.item} sash=${foe.sash}`);
  if (slot >= 0) {
    solver.t.secondaries(me, foe, { slot, frac: 0.2 });
    ok("Knock Off takes the item", !foe.u.mon.item, String(foe.u.mon.item));
    ok("and the sash really stops working -- the flag goes with it", foe.sash === false,
      String(foe.sash));
    notes.push("Knock Off: the Focus Sash is gone, and so is the flag that made it work");
  }
}
{
  // TRICK is a status move, so it comes through `runEffectOps`.
  const solver = makeSolver(1);
  const tricker = makeSet({ ...A, moves: ["Trick", ...A.moves.filter((n) => n !== "Trick")].slice(0, 4), item: "Choice Scarf" });
  const holder = makeSet({ ...B, moves: [...B.moves], item: "Leftovers" });
  const state = solver.buildState({
    sides: [[row(tricker, { front: true }), row(B, { front: true })],
      [row(holder, { front: true }), row(A, { front: true })]],
    field: {},
  });
  const me = state.active[0][0];
  const foe = state.active[1][0];
  use(solver, state, me, foe, "Trick");
  ok("Trick swaps the two items", me.u.mon.item === "Leftovers" && foe.u.mon.item === "Choice Scarf",
    `${me.u.mon.item} / ${foe.u.mon.item}`);
  ok("and the kits went with them", me.k.leftovers === true, String(me.k.leftovers));
  notes.push("Trick: Choice Scarf <-> Leftovers, kits included");

  const off = makeSolver(0);
  const offState = off.buildState({
    sides: [[row(tricker, { front: true }), row(B, { front: true })],
      [row(holder, { front: true }), row(A, { front: true })]],
    field: {},
  });
  use(off, offState, offState.active[0][0], offState.active[1][0], "Trick");
  ok("rule 0: nothing is swapped", offState.active[0][0].u.mon.item === "Choice Scarf",
    offState.active[0][0].u.mon.item);
}

/* ---------------------------------------------------- offered on the sheet */
{
  const page = readFileSync(join(root, "builder", "play-game.js"), "utf8");
  for (const op of ["copy_stages", "invert_stages", "pain_split", "aqua_ring", "leech_seed", "revive_ally",
    "swap_abilities", "set_ability", "copy_ability"]) {
    ok(`${op} is runnable, so its move is offered`, page.includes(`"${op}"`), op);
  }
}

for (const note of notes) console.log(`   ${note}`);
console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
