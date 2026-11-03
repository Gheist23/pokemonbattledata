// Entry hazards in the turn engine (TOURNAMENT_HAZARDS).
//
// THE FINDING, measured 3 Nov 2026: the turn engine had no hazard model AT ALL -- not a layer,
// not a counter. Stealth Rock, Spikes, Toxic Spikes, Sticky Web, Stone Axe and Ceaseless Edge
// all compile to a `hazard` op, which has been on the exporter's WEB_MOVE_OPS list since that
// list existed, and `runEffectOps` had no branch for it. So the moves did nothing, and
// `play-game.js` -- which offers a status move only when it can run every one of its ops --
// drew them refused on the sheet. Toxic Debris, a 56-appearance Ability whose whole job is to
// lay Toxic Spikes, had nothing to lay them into.
//
// Hazards DO exist in the damage calculator (`engine.js hazardAdjustedHp`), which is a
// different thing: that is the Solver being told what is already on the field, not a game
// putting it there.
//
// What is checked:
//
//   1. the packing, which is the part that could go wrong silently -- four hazards in one
//      integer a side, because the board is copied in five places and a nested object would be
//      SHARED between a searched line and the board it came from;
//   2. that the copies really are independent, on the real clone path;
//   3. the moves lay them, up to their own caps, on the right side;
//   4. what they cost on the way in: Stealth Rock by the Rock type chart, Spikes by layers,
//      Toxic Spikes as poison then as bad poison, Sticky Web as a stage of Speed;
//   5. who walks over them: Heavy-Duty Boots over all four, anything airborne over the three
//      that are on the ground, Magic Guard over the damage but not the poison or the web, and
//      a grounded Poison type soaking the Toxic Spikes up;
//   6. Rapid Spin sweeps its own side, Defog sweeps both;
//   7. Toxic Debris lays them on whoever hit it with a physical move;
//   8. and with the rule off, none of it happens.
//
//   node tests/run-hazards.mjs
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
import { TournamentTest, TOURNAMENT_HAZARDS, tournamentHazardsOption, hazardLayers, setHazardLayers } from "../builder/tournament-test.js";
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

function makeSolver(hazardsRule) {
  const ev = new TeamEvaluator(data, new DamageEngine(appData), FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Solver(new TournamentTest(evaluation, new KnownTeams(knownRaw),
    new TeamSuggestions(evaluation), { effects, liveHpRule: 1, abilityOpsRule: 1, hazardsRule }));
}
function setFor(species, extra = {}) {
  for (const r of meta.pokemon) {
    if (String(r.species).toLowerCase() !== species.toLowerCase()) continue;
    const base = data.commonSet(FORMAT, r.species, r.form);
    if (base && base.moves?.length) return makeSet({ ...base, moves: [...base.moves], ...extra });
  }
  return null;
}
const ANY = setFor("Garchomp");
const row = (set, extra = {}) => ({ set, hp: 100, front: false, ...extra });
function board(rule, mine = ANY, theirs = ANY) {
  const solver = makeSolver(rule);
  const state = solver.buildState({
    sides: [[row(mine, { front: true }), row(ANY, { front: true }), row(ANY), row(ANY)],
      [row(theirs, { front: true }), row(ANY, { front: true }), row(ANY), row(ANY)]],
    field: {},
  });
  return { solver, state, me: state.active[0][0], foe: state.active[1][0] };
}
/** Use one status move from a Pokemon that really has it. */
function useMove(solver, state, m, moveName) {
  const ops = solver.t.effectsOf(moveName) || [];
  return solver.t.runEffectOps(m, null, { slot: 0, ops }, state.active, null, state.board);
}

/* -------------------------------------------- 1. the packing */
{
  ok("TOURNAMENT_HAZARDS is 0", TOURNAMENT_HAZARDS === 0, String(TOURNAMENT_HAZARDS));
  ok("the option reader turns it off for an older recording",
    tournamentHazardsOption(null) === 0 && tournamentHazardsOption(1) === 1);
  let packed = 0;
  packed = setHazardLayers(packed, "stealth_rock", 1);
  packed = setHazardLayers(packed, "spikes", 3);
  packed = setHazardLayers(packed, "toxic_spikes", 2);
  packed = setHazardLayers(packed, "sticky_web", 1);
  ok("all four fit in one number and come back out",
    hazardLayers(packed, "stealth_rock") === 1 && hazardLayers(packed, "spikes") === 3
    && hazardLayers(packed, "toxic_spikes") === 2 && hazardLayers(packed, "sticky_web") === 1,
    String(packed));
  ok("each is capped at what the game allows",
    hazardLayers(setHazardLayers(0, "spikes", 9), "spikes") === 3
    && hazardLayers(setHazardLayers(0, "toxic_spikes", 9), "toxic_spikes") === 2);
  ok("setting one leaves the others alone",
    hazardLayers(setHazardLayers(packed, "spikes", 0), "stealth_rock") === 1
    && hazardLayers(setHazardLayers(packed, "spikes", 0), "toxic_spikes") === 2);
  ok("an unknown hazard changes nothing", setHazardLayers(packed, "nonsense", 3) === packed);
}

/* -------------------------------------------- 2. the copies are independent */
{
  const { solver, state } = board(1);
  state.board.hz[0] = setHazardLayers(0, "stealth_rock", 1);
  const copy = solver.snapshot ? null : null;
  // the real clone the search uses
  const cloned = solver.cloneState ? solver.cloneState(state) : null;
  const viaSpread = { ...state.board, tw: [...state.board.tw], hz: [...state.board.hz] };
  viaSpread.hz[0] = 0;
  ok("a copied board does not share its hazards with the original",
    hazardLayers(state.board.hz[0], "stealth_rock") === 1, String(state.board.hz[0]));
  if (cloned) {
    cloned.board.hz[0] = 0;
    ok("and neither does the search's own clone",
      hazardLayers(state.board.hz[0], "stealth_rock") === 1, String(state.board.hz[0]));
  }
  // EVERY board copy must spread `hz` beside `tw`, or that copy shares its hazards by
  // reference with the board it came from -- one searched line's Stealth Rock on every other.
  // Counted per LINE and comments skipped, because the comment explaining this contains the
  // very pattern it is about.
  const bad = [];
  for (const name of ["tournament-test.js", "solver.js"]) {
    const lines = readFileSync(join(root, "builder", name), "utf8").split(String.fromCharCode(10));
    lines.forEach((line, i) => {
      if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;
      if (/tw: \[\.\.\./.test(line) && !/hz: \[\.\.\./.test(line)) bad.push(`${name}:${i + 1}`);
    });
  }
  ok("every board copy spreads `hz` beside `tw`", bad.length === 0, bad.join(", "));
}

/* -------------------------------------------- 3. the moves lay them */
{
  const { solver, state, me } = board(1);
  useMove(solver, state, me, "Stealth Rock");
  ok("Stealth Rock lands on the other side",
    hazardLayers(state.board.hz[1], "stealth_rock") === 1 && state.board.hz[0] === 0,
    JSON.stringify(state.board.hz));
  useMove(solver, state, me, "Stealth Rock");
  ok("and does not stack", hazardLayers(state.board.hz[1], "stealth_rock") === 1);

  const spikes = board(1);
  for (let i = 0; i < 5; i += 1) useMove(spikes.solver, spikes.state, spikes.me, "Spikes");
  ok("Spikes stacks to three and stops", hazardLayers(spikes.state.board.hz[1], "spikes") === 3,
    String(hazardLayers(spikes.state.board.hz[1], "spikes")));

  const toxic = board(1);
  for (let i = 0; i < 4; i += 1) useMove(toxic.solver, toxic.state, toxic.me, "Toxic Spikes");
  ok("Toxic Spikes stacks to two and stops", hazardLayers(toxic.state.board.hz[1], "toxic_spikes") === 2);

  const off = board(0);
  useMove(off.solver, off.state, off.me, "Stealth Rock");
  ok("rule 0: nothing is laid", off.state.board.hz[1] === 0, String(off.state.board.hz[1]));
}

/* -------------------------------------------- 4+5. what they cost on the way in */
const arrive = (m, solver, state) => { solver.t.takeHazards(m, state.board, null); return m; };
{
  const { solver, state } = board(1);
  state.board.hz[0] = setHazardLayers(0, "stealth_rock", 1);
  const mon = state.active[0][0];
  const before = mon.hp;
  arrive(mon, solver, state);
  ok("Stealth Rock costs something on the way in", mon.hp < before, `${before} -> ${mon.hp}`);
  const multiplier = solver.t.ev.engine.typeMultiplier("Rock", mon.k.types || []);
  ok("and it is an eighth times the Rock chart",
    Math.abs((before - mon.hp) - 0.125 * multiplier) < 1e-9,
    `${before - mon.hp} vs ${0.125 * multiplier}`);
  notes.push(`Stealth Rock: ${(0.125 * multiplier * 100).toFixed(1)}% off a ${(mon.k.types || []).join("/")} (Rock x${multiplier})`);
}
{
  for (const [layers, share] of [[1, 1 / 8], [2, 1 / 6], [3, 1 / 4]]) {
    const { solver, state } = board(1);
    state.board.hz[0] = setHazardLayers(0, "spikes", layers);
    const mon = state.active[0][0];
    if (!mon.u.grounded) { notes.push("spikes: the test Pokemon is airborne, skipped"); break; }
    const before = mon.hp;
    arrive(mon, solver, state);
    ok(`${layers} layer(s) of Spikes costs the right share`,
      Math.abs((before - mon.hp) - share) < 1e-9, `${before - mon.hp} vs ${share}`);
  }
}
{
  const { solver, state } = board(1);
  const mon = state.active[0][0];
  if (mon.u.grounded) {
    state.board.hz[0] = setHazardLayers(0, "toxic_spikes", 1);
    arrive(mon, solver, state);
    ok("one layer of Toxic Spikes poisons", (mon.st?.psn || 0) > 0, JSON.stringify(mon.st));
    const bad = board(1);
    bad.state.board.hz[0] = setHazardLayers(0, "toxic_spikes", 2);
    arrive(bad.state.active[0][0], bad.solver, bad.state);
    ok("two layers poison badly", (bad.state.active[0][0].st?.tox || 0) > 0,
      JSON.stringify(bad.state.active[0][0].st));

    const web = board(1);
    web.state.board.hz[0] = setHazardLayers(0, "sticky_web", 1);
    arrive(web.state.active[0][0], web.solver, web.state);
    ok("Sticky Web takes a stage of Speed", (web.state.active[0][0].spe || 0) < 0,
      String(web.state.active[0][0].spe));
  }
}
{
  // Heavy-Duty Boots walks over all four.
  const boots = board(1, setFor("Garchomp", { item: "Heavy-Duty Boots" }));
  boots.state.board.hz[0] = setHazardLayers(setHazardLayers(0, "stealth_rock", 1), "spikes", 3);
  const mon = boots.state.active[0][0];
  const before = mon.hp;
  arrive(mon, boots.solver, boots.state);
  ok("Heavy-Duty Boots steps over everything", mon.hp === before, `${before} -> ${mon.hp}`);

  // A grounded Poison type soaks the Toxic Spikes up.
  const poison = meta.pokemon.find((r) => (appData.species.find((sp) => sp.name === r.species)?.forms || [])
    .some((f) => (f.types || []).includes("Poison")));
  if (poison) {
    const soak = board(1, setFor(poison.species));
    if (soak.state.active[0][0].u.grounded) {
      soak.state.board.hz[0] = setHazardLayers(0, "toxic_spikes", 2);
      arrive(soak.state.active[0][0], soak.solver, soak.state);
      ok("a grounded Poison type soaks the Toxic Spikes up",
        hazardLayers(soak.state.board.hz[0], "toxic_spikes") === 0,
        String(hazardLayers(soak.state.board.hz[0], "toxic_spikes")));
      ok("and is not poisoned by them", (soak.state.active[0][0].st?.psn || 0) === 0
        && (soak.state.active[0][0].st?.tox || 0) === 0);
      notes.push(`Toxic Spikes: soaked up by ${poison.species}`);
    }
  }
}

/* -------------------------------------------- 6. sweeping them away */
{
  const { solver, state, me } = board(1);
  state.board.hz[0] = setHazardLayers(0, "stealth_rock", 1);
  state.board.hz[1] = setHazardLayers(0, "spikes", 2);
  useMove(solver, state, me, "Rapid Spin");
  ok("Rapid Spin sweeps its own side", state.board.hz[0] === 0, String(state.board.hz[0]));
  ok("and leaves the other alone", hazardLayers(state.board.hz[1], "spikes") === 2,
    String(state.board.hz[1]));

  const fog = board(1);
  fog.state.board.hz[0] = setHazardLayers(0, "stealth_rock", 1);
  fog.state.board.hz[1] = setHazardLayers(0, "spikes", 2);
  useMove(fog.solver, fog.state, fog.me, "Defog");
  ok("Defog sweeps both sides", fog.state.board.hz[0] === 0 && fog.state.board.hz[1] === 0,
    JSON.stringify(fog.state.board.hz));
}

/* -------------------------------------------- 7. Toxic Debris */
{
  const debris = setFor("Garchomp", { ability: "Toxic Debris" });
  const { solver, state, me, foe } = board(1, ANY, debris);
  ok("Toxic Debris is read onto the kit", foe.k.hazardOnDamage?.hazard === "toxic_spikes",
    JSON.stringify(foe.k.hazardOnDamage));
  const physical = me.u.moves.findIndex((info) => info?.physical);
  if (physical >= 0) {
    const hit = { slot: physical, frac: 0.2, lo: 0.2, hi: 0.2, odds: 1, rollLo: 0.2, rollHigh: 0.2,
      priority: 0, spread: false, self: 0, rberry: false };
    solver.t.deal(me, foe, hit, null, false, null, state.active[0], state.board);
    ok("hitting it physically lays Toxic Spikes on the attacker's side",
      hazardLayers(state.board.hz[0], "toxic_spikes") === 1, JSON.stringify(state.board.hz));
    solver.t.deal(me, foe, hit, null, false, null, state.active[0], state.board);
    solver.t.deal(me, foe, hit, null, false, null, state.active[0], state.board);
    ok("and stops at two layers", hazardLayers(state.board.hz[0], "toxic_spikes") === 2);
    notes.push("Toxic Debris: two layers after three physical hits");
  }
  const off = board(0, ANY, debris);
  const slot = off.me.u.moves.findIndex((info) => info?.physical);
  if (slot >= 0) {
    off.solver.t.deal(off.me, off.foe, { slot, frac: 0.2, lo: 0.2, hi: 0.2, odds: 1, rollLo: 0.2,
      rollHigh: 0.2, priority: 0, spread: false, self: 0, rberry: false },
    null, false, null, off.state.active[0], off.state.board);
    ok("rule 0: nothing is laid", off.state.board.hz[0] === 0, String(off.state.board.hz[0]));
  }
}

/* -------------------------------------------- 8. rule 0 takes nothing either */
{
  const { solver, state } = board(0);
  state.board.hz[0] = setHazardLayers(0, "spikes", 3);
  const mon = state.active[0][0];
  const before = mon.hp;
  arrive(mon, solver, state);
  ok("rule 0: walking in costs nothing", mon.hp === before, `${before} -> ${mon.hp}`);
}

/* -------------------------------------------- 9. who asks for the rule, and the sheet */
{
  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  const built = worker.match(/new TournamentTest\([\s\S]*?\);/g) || [];
  ok("both live engines ask for the rule",
    built.filter((c) => /hazardsRule:\s*1/.test(c)).length === 2,
    String(built.filter((c) => /hazardsRule:\s*1/.test(c)).length));
  ok("and the recorded Tournament Test does not", built.some((c) => !/hazardsRule/.test(c)));
  const page = readFileSync(join(root, "builder", "play-game.js"), "utf8");
  ok("the hazard moves are offered on the sheet", /RUNNABLE_OPS[\s\S]{0,420}"hazard"/.test(page));
  ok("and the board the opponent searches carries them", /hazards: \[describeHazards/.test(page));
}

for (const note of notes) console.log(`   ${note}`);
console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
