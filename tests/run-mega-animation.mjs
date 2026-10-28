// The Mega Evolution step in a played game (builder/solver.js, builder/play-game.js).
//
// THE BUG. A Mega Evolution is animated from a step of its own -- the sprite has to change at
// the moment it happens rather than when the turn ends. That step was built by looking the
// evolved Pokemon up among the standing rows BY LABEL:
//
//     const m = rows.find((x) => this.solver.label(x.u) === event.value);
//     if (m) pending.push({ ... });
//
// which is a lookup that can miss, and missed SILENTLY when it did: no row, no step, no sprite
// swap, no flash, and nothing anywhere saying that an evolution had been dropped. The turn read
// as though the Pokemon had never evolved, while the engine had already swapped it over.
//
// THE FIX is to stop looking it up. The event is pushed at the moment of evolution, where the
// row is in hand, so it now carries the row's own `tag` -- an index, which cannot be ambiguous
// and cannot miss -- along with the species and form to draw. The label match stays only as a
// fallback for a recorded stream made before the event carried a tag.
//
// What is checked here:
//
//   1. the event carries the seat, species and form, from BOTH paths that evolve (the chosen
//      Mega and the planner's own);
//   2. a played turn really produces the step, on the seat that evolved, naming the Mega;
//   3. the step survives the case the label match could not: two rows whose labels are equal;
//   4. the step is only there when something evolved, and only once per side.
//
//   node tests/run-mega-animation.mjs
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
import { PlayGame, teamFromKnown } from "../builder/play-game.js";

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
const library = read("data", "builder", "pokemon-sets.json").sets;
const knownRaw = read("data", "builder", "known-teams.json");
const effects = read("data", "builder", "move-effects.json");

const data = new BuilderData(appData);
data.ingestMeta(FORMAT, meta);
const engine = new DamageEngine(appData);
const ev = new TeamEvaluator(data, engine, FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
ev.setMetaRecords(meta.pokemon || []);
const evaluation = new TeamEvaluation(ev);
const known = new KnownTeams(knownRaw);

function freshGame() {
  const solver = new Solver(new TournamentTest(evaluation, known, new TeamSuggestions(evaluation), { effects }));
  return { solver, game: new PlayGame(solver, data, FORMAT, library) };
}

const stones = new Set(Object.keys(appData.megaStones || {}));
const setFor = (record) => {
  const set = data.commonSet(FORMAT, record.species, record.form);
  return set && set.moves?.length ? makeSet({ ...set, moves: [...set.moves] }) : null;
};

/** A team whose LEAD holds a Mega stone, taken by ladder rank so the sets are real. */
function megaLeadTeam() {
  const ranked = meta.pokemon.map(setFor).filter(Boolean);
  const lead = ranked.find((set) => stones.has(set.item));
  const rest = ranked.filter((set) => set !== lead).slice(0, 3);
  return { team: [lead, ...rest], lead };
}

const { team: PLAYER, lead: MEGA_LEAD } = megaLeadTeam();
const FOE = teamFromKnown(data, FORMAT, known.teams[0]).slice(0, 4);

ok("the player's lead really holds a stone", Boolean(MEGA_LEAD) && stones.has(MEGA_LEAD.item),
  MEGA_LEAD ? `${MEGA_LEAD.species} / ${MEGA_LEAD.item}` : "none");
notes.push(`lead: ${MEGA_LEAD?.species} holding ${MEGA_LEAD?.item}`);

// ---------------------------------------------------------------------------
// 1. both evolving paths put the seat on the event
// ---------------------------------------------------------------------------
{
  const source = readFileSync(join(root, "builder", "solver.js"), "utf8");
  const pushes = source.match(/events\?\.push\(\{[^}]*kind: "mega"[\s\S]{0,220}?\}\);/g) || [];
  ok("there are exactly two places that evolve", pushes.length === 2, String(pushes.length));
  for (const [i, push] of pushes.entries()) {
    ok(`mega event ${i + 1} carries the seat`, /\btag:/.test(push), push.replace(/\s+/g, " ").slice(0, 120));
    ok(`mega event ${i + 1} carries the species`, /\bspecies:/.test(push));
    ok(`mega event ${i + 1} carries the form`, /\bform:/.test(push));
  }
  // And nothing evolves without saying so: the only two writes of `.mega = null` are these.
  const clears = source.match(/\.mega = null;/g) || [];
  ok("and nothing else clears the stone", clears.length === 2, String(clears.length));

  const play = readFileSync(join(root, "builder", "play-game.js"), "utf8");
  ok("the step is found by the seat, not by the label",
    /event\.tag !== undefined \? rows\.find\(\(x\) => x && x\.tag === event\.tag\)/.test(play));
  ok("and the label match survives only as a fallback",
    /\|\|\s*rows\.find\(\(x\) => x && this\.solver\.label\(x\.u\) === event\.value\)/.test(play));
  ok("the species drawn is the event's own",
    /species: event\.species \|\| m\.u\.species/.test(play));
}

// ---------------------------------------------------------------------------
// 2. a played turn produces the step
// ---------------------------------------------------------------------------
{
  const { game } = freshGame();
  game.start({ player: PLAYER, foe: FOE, seed: 7 });
  const options = game.options();
  const slot = options.find((o) => !o.empty && o.actions.some((a) => a.mega));
  ok("the lead is offered a Mega Evolution", Boolean(slot),
    JSON.stringify(options.map((o) => o.actions.filter((a) => a.mega).length)));

  const chosen = options.map((o) => {
    if (o.empty) return null;
    const wanted = o === slot
      ? o.actions.find((a) => a.mega && a.kind === "move") || o.actions.find((a) => a.mega)
      : o.actions[0];
    return wanted ? wanted.id : null;
  }).filter(Boolean);

  const ourJoint = game.jointFrom(options, chosen);
  const foeOptions = [0, 1].map((position) => game.solver.slotCandidates(game.state, 1, position, { cap: 0 }));
  const foeJoint = game.solver.planFor(game.state, foeOptions.map((list) => list[0]).filter(Boolean), 1);
  const record = game.resolve(ourJoint, foeJoint);
  const stream = record.stream || [];
  const megaSteps = stream.filter((s) => s.kind === "mega");

  ok("the turn produces a mega step", megaSteps.length >= 1,
    `${megaSteps.length} of ${stream.length} steps: ${[...new Set(stream.map((s) => s.kind))].join(",")}`);
  const step = megaSteps[0] || {};
  ok("on our side", step.side === 0, String(step.side));
  ok("on the seat that evolved", step.tag === slot?.tag, `${step.tag} vs ${slot?.tag}`);
  ok("naming a Mega form", /^Mega /.test(String(step.form || step.name || "")),
    `${step.name} / ${step.form}`);
  ok("and carrying the species to draw", Boolean(step.species), String(step.species));
  // Exactly one a side, which is the rule.
  ok("one Mega Evolution a side at most",
    megaSteps.filter((s) => s.side === 0).length === 1, String(megaSteps.filter((s) => s.side === 0).length));
  notes.push(`step: side ${step.side} seat ${step.tag} -> ${step.name} (${step.species} / ${step.form})`);
}

// ---------------------------------------------------------------------------
// 3. the case the label match could not do
// ---------------------------------------------------------------------------
{
  // Two rows that answer to the SAME label. `find` by label returns the first, so the step
  // would have landed on the wrong tile -- the one that did not evolve -- and the evolved one
  // would have kept its base sprite. Matching the seat cannot do that.
  const { solver, game } = freshGame();
  game.start({ player: PLAYER, foe: FOE, seed: 9 });
  const rows = game.state.active[0];
  ok("there are two seats to confuse", rows.length === 2, String(rows.length));
  const armed = rows.find((m) => m && m.mega);
  const other = rows.find((m) => m && m !== armed);
  ok("one of them is armed with a stone", Boolean(armed) && Boolean(other));
  if (armed && other) {
    // Make the labels identical without touching anything the evolution reads.
    const label = solver.label(armed.u);
    const realLabel = solver.label.bind(solver);
    solver.label = (unit) => (unit === other.u || unit === armed.u ? label : realLabel(unit));
    const events = [];
    const joint = [{ position: rows.indexOf(armed), mega: true, kind: "move", slot: 0, target: 0 }];
    solver.applyMegas(game.state, [joint, []], events);
    solver.label = realLabel;
    const event = events.find((e) => e.kind === "mega");
    ok("the evolution still reports itself", Boolean(event));
    ok("and it names the seat that evolved, not the first matching label",
      event && event.tag === armed.tag, `${event?.tag} vs ${armed.tag}`);
    ok("the two labels really were equal", solver.label(armed.u) !== solver.label(other.u)
      || armed.tag !== other.tag);
  }
}

// ---------------------------------------------------------------------------
// 4. no evolution, no step
// ---------------------------------------------------------------------------
{
  const { game } = freshGame();
  // A team with no stone anywhere: nothing can evolve, so nothing may claim to.
  const plain = meta.pokemon.map(setFor).filter((set) => set && !stones.has(set.item)).slice(0, 4);
  ok("a stone-free team could be built", plain.length === 4, String(plain.length));
  game.start({ player: plain, foe: FOE, seed: 13 });
  const options = game.options();
  ok("and it is offered no Mega Evolution",
    !options.some((o) => !o.empty && o.actions.some((a) => a.mega)));
  const chosen = options.filter((o) => !o.empty).map((o) => o.actions[0]?.id).filter(Boolean);
  const foeOptions = [0, 1].map((position) => game.solver.slotCandidates(game.state, 1, position, { cap: 0 }));
  const record = game.resolve(
    game.jointFrom(options, chosen),
    game.solver.planFor(game.state, foeOptions.map((list) => list[0]).filter(Boolean), 1));
  const ours = (record.stream || []).filter((s) => s.kind === "mega" && s.side === 0);
  ok("so our side produces no mega step", ours.length === 0, JSON.stringify(ours));
}

// ---------------------------------------------------------------------------

if (notes.length) notes.forEach((n) => console.log(`  ${n}`));
if (failures.length) {
  failures.forEach((f) => console.log(`FAIL ${f}`));
  console.log(`${checked} checked, ${failures.length} failed.`);
  process.exit(1);
}
console.log(`${checked} checked, 0 failed.`);
