// Scenario checks for Test against Tournament Teams (builder/tournament-test.js):
// hand-made leads for turn 1, the bring size per format, the snapshot shape (version 3:
// the lead matrix, the bring options, the most similar team), and that Tailwind / Fake Out /
// Intimidate actually move the result. Also: Earthquake-type moves hit the partner (and the
// choice and Protect account for it), Speed drops skip immune targets, Grassy Glide / First
// Impression priority, Helping Hand, Wide Guard, Quick Guard against Fake Out, Snarl, Spore,
// Taunt, Encore and Will-O-Wisp, and the lines and sections of the results view. Also that the
// duel numbers no longer read what turn 1 left on the board (TOURNAMENT_TURN_ONE version 2).
//
//   node tests/run-tournament-smoke.mjs [teams]     (default 150 tournament teams per run)
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
import { TournamentTest, SNAPSHOT_VERSION } from "../builder/tournament-test.js";
import { makeSet } from "../builder/common.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const knownRaw = JSON.parse(readFileSync(join(root, "data", "builder", "known-teams.json"), "utf8"));
const limit = Number(process.argv[2]) || 150;

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

/** A TournamentTest that also keeps every team's matchup value (for the spread check). */
class Probe extends TournamentTest {
  playTeam(state, team) {
    super.playTeam(state, team);
    (this.values ||= []).push(state.results[state.results.length - 1].value);
  }
}

function makeTest(format) {
  const engine = new DamageEngine(appData);
  const meta = JSON.parse(readFileSync(join(root, "data", "builder", `meta-${format.toLowerCase()}.json`), "utf8"));
  const ev = new TeamEvaluator(null, engine, format, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Probe(evaluation, new KnownTeams(knownRaw), new TeamSuggestions(evaluation));
}

const BENCH = [
  { species: "Charizard", form: "Mega Charizard Y", item: "Charizardite Y", ability: "Drought", nature: "Modest", moves: ["Heat Wave", "Weather Ball", "Solar Beam", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
  { species: "Venusaur", item: "Focus Sash", ability: "Chlorophyll", nature: "Modest", moves: ["Energy Ball", "Sludge Bomb", "Sleep Powder", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
  { species: "Incineroar", item: "Sitrus Berry", ability: "Intimidate", nature: "Careful", moves: ["Fake Out", "Parting Shot", "Flare Blitz", "Knock Off"], bonuses: [32, 0, 2, 0, 32, 0] },
  { species: "Garchomp", item: "Life Orb", ability: "Rough Skin", nature: "Jolly", moves: ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
  { species: "Whimsicott", item: "Focus Sash", ability: "Prankster", nature: "Timid", moves: ["Tailwind", "Moonblast", "Encore", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
  { species: "Gholdengo", item: "Choice Specs", ability: "Good as Gold", nature: "Modest", moves: ["Make It Rain", "Shadow Ball", "Power Gem", "Trick"], bonuses: [2, 0, 0, 32, 0, 32] },
];

// A tournament-style member (the test gives it the Stat Points usage pairs with its Nature).
const member = (species, item, ability, nature, moves, form = "") => ({ species, form: form || species, item, ability, nature, moves });

/** One game between two hand-made leads-only brings; returns the recorded game. */
function game(test, oursSets, theirMembers) {
  const ours = oursSets.map((set, i) => test.ourUnit(makeSet(set), i));
  const theirs = theirMembers.map((m) => test.opponentMon(m));
  const [our] = test.plansFor(ours).filter((plan) => plan.members.length === ours.length);
  const [their] = test.plansFor(theirs).filter((plan) => plan.members.length === theirs.length);
  return test.play(our, their, null, true);
}
const events = (g, side, kind) => g.events.filter((e) => (side === null || e.s === side) && e.kind === kind);
const kinds = (log) => log.map((e) => `${e.s}:${e.kind}:${e.actor?.species || ""}${e.move ? `(${e.move})` : ""}`).join(" ");

// --- turn 1 scenarios (Doubles) ----------------------------------------------------------
{
  const test = makeTest("Doubles");
  const incineroar = BENCH[2];
  const garchomp = BENCH[3];
  // (b) Fake Out cannot flinch Inner Focus or a Ghost type.
  let g = game(test, [incineroar, garchomp], [
    member("Dragonite", "Life Orb", "Inner Focus", "Adamant", ["Dragon Claw", "Low Kick", "Extreme Speed", "Protect"]),
    member("Gholdengo", "Life Orb", "Good as Gold", "Timid", ["Make It Rain", "Shadow Ball", "Nasty Plot", "Protect"]),
  ]);
  check("Fake Out skips Inner Focus and Ghost types", events(g, 0, "fakeout").length === 0, JSON.stringify(events(g, 0, "fakeout").map((e) => e.target.form)));
  // (b) Armor Tail on their side stops Fake Out on both of them.
  g = game(test, [incineroar, garchomp], [
    member("Farigiraf", "Sitrus Berry", "Armor Tail", "Calm", ["Psychic", "Helping Hand", "Trick Room", "Imprison"]),
    member("Garchomp", "Life Orb", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"]),
  ]);
  check("Armor Tail stops Fake Out", events(g, 0, "fakeout").length === 0);
  // (b) Psychic Terrain protects grounded targets from Fake Out; a Flying target can still be hit.
  g = game(test, [incineroar, garchomp], [
    member("Indeedee", "Psychic Seed", "Psychic Surge", "Bold", ["Follow Me", "Helping Hand", "Psychic", "Trick Room"]),
    member("Garchomp", "Life Orb", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"]),
  ]);
  check("Psychic Terrain is up after entry", g.after.terrain === "Psychic", g.after.terrain);
  check("Psychic Terrain stops Fake Out on grounded targets", events(g, 0, "fakeout").length === 0);
  g = game(test, [incineroar, garchomp], [
    member("Indeedee", "Psychic Seed", "Psychic Surge", "Bold", ["Follow Me", "Helping Hand", "Psychic", "Trick Room"]),
    member("Talonflame", "Life Orb", "Gale Wings", "Jolly", ["Protect", "Tailwind", "Brave Bird", "Flare Blitz"]),
  ]);
  const flyingHit = events(g, 0, "fakeout");
  check("Fake Out still hits a Flying target under Psychic Terrain", flyingHit.length === 1 && flyingHit[0].target.species === "Talonflame", JSON.stringify(flyingHit.map((e) => e.target.form)));
  // Fake Out goes for their Tailwind setter first.
  g = game(test, [incineroar, garchomp], [
    member("Whimsicott", "Focus Sash", "Prankster", "Timid", ["Moonblast", "Tailwind", "Encore", "Protect"]),
    member("Garchomp", "Life Orb", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"]),
  ]);
  const onSetter = events(g, 0, "fakeout");
  check("Fake Out targets the Tailwind setter", onSetter.length === 1 && onSetter[0].target.species === "Whimsicott", JSON.stringify(onSetter.map((e) => e.target.form)));
  check("A flinched setter sets no Tailwind", events(g, 1, "tailwind").length === 0 && !g.after.tailwind.them);
  // Intimidate lowers both of their leads on entry.
  check("Intimidate triggers on entry", events(g, 0, "intimidate").length === 1);

  // (c) A slower Trick Room side sets Trick Room and moves first on turn 2.
  const farigiraf = { species: "Farigiraf", item: "Sitrus Berry", ability: "Armor Tail", nature: "Relaxed", moves: ["Psychic", "Helping Hand", "Trick Room", "Protect"], bonuses: [32, 0, 32, 0, 2, 0] };
  const torkoal = { species: "Torkoal", item: "Charcoal", ability: "Drought", nature: "Quiet", moves: ["Eruption", "Weather Ball", "Earth Power", "Protect"], bonuses: [32, 0, 0, 32, 2, 0] };
  const fast = [
    member("Garchomp", "Life Orb", "Rough Skin", "Jolly", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"]),
    member("Sneasler", "Focus Sash", "Unburden", "Jolly", ["Dire Claw", "Close Combat", "Gunk Shot", "Protect"]),
  ];
  g = game(test, [farigiraf, torkoal], fast);
  check("Trick Room goes up for the slower side", g.after.trickRoom === 4 && g.after.trickRoomBy === "you", JSON.stringify(g.after));
  check("Under Trick Room the slower side moves first on turn 2", g.after.faster === "you", g.after.faster);
  check("Drought sets harsh sunlight", g.after.weather === "Sun", g.after.weather);

  // (d) Prankster Tailwind turns the turn-2 order around.
  const whimsicott = BENCH[4];
  const noTailwind = { ...whimsicott, moves: ["Moonblast", "Energy Ball", "Encore", "Protect"] };
  const garchompSlow = { ...garchomp, nature: "Adamant", bonuses: [32, 32, 2, 0, 0, 0] };
  const foes = [
    member("Sneasler", "Focus Sash", "Unburden", "Jolly", ["Dire Claw", "Close Combat", "Gunk Shot", "Protect"]),
    member("Dragapult", "Choice Specs", "Infiltrator", "Timid", ["Draco Meteor", "Shadow Ball", "Flamethrower", "U-turn"]),
  ];
  const withTw = game(test, [whimsicott, garchompSlow], foes);
  const withoutTw = game(test, [noTailwind, garchompSlow], foes);
  check("Prankster Tailwind is up after turn 1", withTw.after.tailwind.you === 3, JSON.stringify(withTw.after.tailwind));
  check("Tailwind makes us faster on turn 2", withTw.after.faster === "you" && withoutTw.after.faster !== "you", `${withTw.after.faster} / ${withoutTw.after.faster}`);

  // Hand-set boards for the checks below: a side's state at a given HP (no Sitrus Berry then).
  const state = (unit, s, hp = 1) => Object.assign(test.fresh(unit, s, true), hp < 1 ? { hp, berry: false } : {});
  const board = (terrain = "None", weather = "None") => ({ w: ["None", "Sun", "Rain", "Sand", "Snow", "Strong Winds"].indexOf(weather), t: ["None", "Electric", "Grassy", "Psychic", "Misty"].indexOf(terrain), tw: [0, 0], tr: 0, trBy: -1, wide: 0, quick: 0 });
  const ours = (...list) => list.map((set, i) => state(test.ourUnit(makeSet(set), i), 0));
  const theirs = (...list) => list.map((m) => state(test.opponentMon(m), 1));
  const kingambit = member("Kingambit", "Black Glasses", "Defiant", "Adamant", ["Kowtow Cleave", "Sucker Punch", "Iron Head", "Protect"]);
  const tyranitar = member("Tyranitar", "Assault Vest", "Sand Stream", "Adamant", ["Rock Slide", "Knock Off", "Low Kick", "Protect"]);
  const sinistcha = member("Sinistcha", "Sitrus Berry", "Hospitality", "Bold", ["Matcha Gotcha", "Rage Powder", "Trick Room", "Protect"]);

  // (f) Earthquake and the other "every Pokémon next to the user" moves hit the partner too.
  const chomp = test.ourUnit(makeSet(garchomp), 0);
  const groundedPartner = { species: "Incineroar", item: "Sitrus Berry", ability: "Blaze", nature: "Careful", moves: ["Parting Shot", "Knock Off", "Flare Blitz", "Protect"], bonuses: [32, 0, 2, 0, 32, 0] };
  const flyingPartner = { species: "Talonflame", item: "Sharp Beak", ability: "Gale Wings", nature: "Jolly", moves: ["Brave Bird", "Flare Blitz", "Tailwind", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] };
  const moveNext = (partnerSet, foeMembers) => {
    const g = state(chomp, 0);
    const pick = test.pickTarget(g, foeMembers.map((f) => state(test.opponentMon(f), 1)), board(), [g, state(test.ourUnit(makeSet(partnerSet), 1), 0)]);
    return pick ? chomp.moves[pick.hit.slot].name : "none";
  };
  const nextToGrounded = moveNext(groundedPartner, [kingambit, sinistcha]);
  const nextToFlying = moveNext(flyingPartner, [kingambit, sinistcha]);
  check("Earthquake is left out when it costs the partner more than it does to the foes", nextToGrounded !== "Earthquake", nextToGrounded);
  check("Earthquake is used next to a Flying partner", nextToFlying === "Earthquake", nextToFlying);
  {
    const g = state(chomp, 0);
    const partner = state(test.ourUnit(makeSet(groundedPartner), 1), 0, 0.2);
    const foes = [kingambit, tyranitar].map((f) => state(test.opponentMon(f), 1));
    const log = [];
    test.attack(g, foes[1], test.moveHit(g.u, foes[1].u, 0, board(), 0, 0), foes, [g, partner], board(), null, log);
    check("Earthquake hits the user's partner", partner.out, `partner HP ${partner.hp}`);
    check("A partner knocked out by its own side is nobody's KO", g.kos === 0 && !log.some((e) => e.kind === "ko") && log.some((e) => e.kind === "partnerko" && e.move === "Earthquake"), JSON.stringify(log.map((e) => e.kind)));
  }
  {
    // The foes only set up, so our own Earthquake is the only thing that can knock our partner out.
    const g = state(chomp, 0);
    const partner = state(test.ourUnit(makeSet(groundedPartner), 1), 0, 0.5);
    const foes = [
      state(test.opponentMon(member("Kingambit", "Black Glasses", "Defiant", "Adamant", ["Swords Dance", "Iron Defense"])), 1, 0.3),
      state(test.opponentMon(member("Tyranitar", "Assault Vest", "Sand Stream", "Adamant", ["Dragon Dance", "Iron Defense"])), 1, 0.6),
    ];
    const log = [];
    test.turnOne([[g, partner], foes], board(), [false, false], log);
    check("The partner protects from its own side's Earthquake", log.some((e) => e.kind === "protect" && e.actor === partner.u) && partner.hp === 0.5 && foes.every((f) => f.out) && g.kos === 2,
      `${kinds(log)} | partner ${partner.hp}`);
  }

  // (g) A spread Speed drop only lowers the Pokémon it damages (Electroweb does nothing to a Ground type).
  {
    const ampharos = { species: "Ampharos", item: "Focus Sash", ability: "Static", nature: "Quiet", moves: ["Electroweb", "Dazzling Gleam", "Thunderbolt", "Protect"], bonuses: [32, 0, 0, 32, 2, 0] };
    const venusaur = { species: "Venusaur", item: "Sitrus Berry", ability: "Overgrow", nature: "Bold", moves: ["Giga Drain", "Sludge Bomb", "Protect", "Leaf Storm"], bonuses: [32, 0, 32, 0, 2, 0] };
    const side = ours(ampharos, venusaur);
    const foes = theirs(
      member("Garchomp", "Choice Scarf", "Rough Skin", "Timid", ["Dragon Pulse", "Protect"]),
      member("Sneasler", "Focus Sash", "Unburden", "Jolly", ["Fake Tears", "Protect"]),
    );
    const log = [];
    test.turnOne([side, foes], board(), [false, false], log);
    const drop = log.find((e) => e.kind === "speeddrop");
    check("A Speed drop skips a target it cannot damage", drop && foes[0].spe === 0 && foes[1].spe === -1 && drop.targets.length === 1 && drop.targets[0] === foes[1].u,
      `${drop ? drop.targets.map((t) => t.species).join("+") : "no Speed drop"} | stages ${foes.map((f) => f.spe).join("/")} | ${kinds(log)}`);
  }

  // (h) Grassy Glide is +1 in Grassy Terrain; First Impression is +2, on turn 1 only.
  {
    const rillaboom = test.opponentMon(member("Rillaboom", "Assault Vest", "Grassy Surge", "Adamant", ["Grassy Glide", "Wood Hammer", "High Horsepower", "U-turn"]));
    const basculegion = test.ourUnit(makeSet({ species: "Basculegion", item: "Choice Scarf", ability: "Adaptability", nature: "Adamant", moves: ["Wave Crash", "Last Respects", "Aqua Jet", "Flip Turn"], bonuses: [2, 32, 0, 0, 0, 32] }), 0);
    const armorTail = test.ourUnit(makeSet(farigiraf), 1);
    check("Grassy Glide is +1 in Grassy Terrain only", test.moveHit(rillaboom, basculegion, 0, board("Grassy"), 0, 0).priority === 1 && test.moveHit(rillaboom, basculegion, 0, board(), 0, 0).priority === 0);
    check("Armor Tail stops Grassy Glide in Grassy Terrain", test.moveHit(rillaboom, armorTail, 0, board("Grassy"), 0, 0).frac === 0 && test.moveHit(rillaboom, armorTail, 0, board(), 0, 0).frac > 0);
    const golisopod = test.opponentMon(member("Golisopod", "Choice Band", "Emergency Exit", "Adamant", ["First Impression", "Leech Life", "Liquidation", "Sucker Punch"]));
    const indeedee = test.ourUnit(makeSet({ species: "Indeedee", form: "Indeedee Female", item: "Psychic Seed", ability: "Inner Focus", nature: "Bold", moves: ["Follow Me", "Helping Hand", "Psychic", "Trick Room"], bonuses: [32, 0, 32, 0, 2, 0] }), 0);
    const turnOnePick = test.pickTarget(state(golisopod, 1), [state(indeedee, 0)], board(), null, true);
    const laterPick = test.pickTarget(state(golisopod, 1), [state(indeedee, 0)], board(), null, false);
    const moveName = (pick) => (pick ? golisopod.moves[pick.hit.slot].name : "none");
    check("First Impression on turn 1 at +2", moveName(turnOnePick) === "First Impression" && turnOnePick.hit.priority === 2, `${moveName(turnOnePick)} +${turnOnePick?.hit.priority}`);
    check("No First Impression after turn 1", moveName(laterPick) !== "First Impression", moveName(laterPick));
    check("Psychic Terrain stops First Impression on a grounded target", test.moveHit(golisopod, indeedee, 0, board("Psychic"), 0, 0).frac === 0);
  }

  // (j) Helping Hand: a weak attacker boosts its partner's spread move instead (x1.5 power).
  {
    const helper = { species: "Indeedee", form: "Indeedee Female", item: "Sitrus Berry", ability: "Own Tempo", nature: "Bold", moves: ["Helping Hand", "Dazzling Gleam", "Protect", "Imprison"], bonuses: [32, 0, 32, 0, 2, 0] };
    const side = ours(helper, BENCH[5]);
    const foes = theirs(
      member("Garchomp", "Life Orb", "Rough Skin", "Jolly", ["Dragon Claw", "Rock Slide", "Protect", "Swords Dance"]),
      member("Dragonite", "Choice Band", "Multiscale", "Adamant", ["Extreme Speed", "Iron Head", "Protect", "Dragon Dance"]),
    );
    const log = [];
    test.turnOne([side, foes], board(), [false, false], log);
    const hh = log.find((e) => e.kind === "helpinghand");
    check("Helping Hand boosts the partner's attack", hh && hh.s === 0 && hh.target === side[1].u, kinds(log));
    const gho = side[1].u;
    const plain = test.moveHit(gho, foes[0].u, 0, board(), 0, 0, 0).frac;
    const helped = test.moveHit(gho, foes[0].u, 0, board(), 0, 0, 1).frac;
    check("Helping Hand is about x1.5 damage", helped / plain > 1.4 && helped / plain < 1.6, `${plain.toFixed(3)} -> ${helped.toFixed(3)}`);
    const singles = makeTest("Singles");
    check("No Helping Hand in Singles", !singles.ourUnit(makeSet(helper), 0).kit.helpingHand);
  }

  // (k) Wide Guard blocks their spread moves for both of ours.
  {
    const gallade = { species: "Gallade", item: "Sitrus Berry", ability: "Sharpness", nature: "Adamant", moves: ["Wide Guard", "Sacred Sword", "Protect", "Leaf Blade"], bonuses: [32, 32, 2, 0, 0, 0] };
    const ally = { species: "Kingambit", item: "Black Glasses", ability: "Defiant", nature: "Adamant", moves: ["Kowtow Cleave", "Iron Head", "Sucker Punch", "Protect"], bonuses: [32, 32, 2, 0, 0, 0] };
    const side = ours(gallade, ally);
    const foes = theirs(
      // Only spread attacks, so Wide Guard is the answer (against single-target knockouts Protect is).
      member("Charizard", "Charizardite Y", "Drought", "Modest", ["Heat Wave", "Protect"]),
      member("Gholdengo", "Life Orb", "Good as Gold", "Modest", ["Make It Rain", "Protect"]),
    );
    const log = [];
    test.turnOne([side, foes], board("None", "Sun"), [false, false], log);
    const guard = log.find((e) => e.kind === "wideguard");
    const blocked = log.filter((e) => e.kind === "blocked" && e.by === "Wide Guard" && e.s === 1);
    check("Wide Guard goes up against two spread attackers", guard && guard.s === 0, kinds(log));
    // Their spread moves are blocked for both of ours (Sitrus Berry aside, both stay at full HP).
    check("Wide Guard blocks their spread moves", blocked.length >= 1 && side.every((m) => m.hp === 1), `${kinds(log)} | HP ${side.map((m) => m.hp.toFixed(2)).join("/")}`);
  }

  // (l) Quick Guard from a faster Pokémon stops their Fake Out.
  {
    const talonflame = { species: "Talonflame", item: "Sharp Beak", ability: "Flame Body", nature: "Jolly", moves: ["Quick Guard", "Brave Bird", "Flare Blitz", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] };
    const side = ours(talonflame, garchomp);
    const foes = theirs(
      member("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"]),
      member("Kingambit", "Black Glasses", "Defiant", "Adamant", ["Kowtow Cleave", "Sucker Punch", "Iron Head", "Protect"]),
    );
    const log = [];
    test.turnOne([side, foes], board(), [false, false], log);
    const qg = log.find((e) => e.kind === "quickguard");
    const stopped = log.find((e) => e.kind === "blocked" && e.move === "Fake Out" && e.by === "Quick Guard");
    check("Quick Guard goes up against Fake Out", qg && qg.s === 0, kinds(log));
    check("Quick Guard stops their Fake Out", stopped && !log.some((e) => e.kind === "fakeout" && e.s === 1) && side.every((m) => !m.flinch || m.out), kinds(log));
  }

  // (m) Snarl lowers both special attackers' Sp. Atk (and is picked for it over a weak attack).
  {
    const snarler = { species: "Incineroar", item: "Sitrus Berry", ability: "Blaze", nature: "Careful", moves: ["Snarl", "U-turn", "Parting Shot", "Protect"], bonuses: [32, 0, 2, 0, 32, 0] };
    const ally = { species: "Farigiraf", item: "Sitrus Berry", ability: "Armor Tail", nature: "Relaxed", moves: ["Psychic", "Protect", "Imprison", "Helping Hand"], bonuses: [32, 0, 32, 0, 2, 0] };
    const side = ours(snarler, ally);
    const foes = theirs(
      member("Gholdengo", "Choice Specs", "Good as Gold", "Modest", ["Make It Rain", "Shadow Ball", "Power Gem", "Trick"]),
      member("Sylveon", "Choice Specs", "Pixilate", "Modest", ["Hyper Voice", "Moonblast", "Shadow Ball", "Quick Attack"]),
    );
    const log = [];
    test.turnOne([side, foes], board(), [false, false], log);
    const snarl = log.find((e) => e.kind === "lower" && e.move === "Snarl");
    check("Snarl lowers their Sp. Atk", snarl && snarl.s === 0 && foes.every((f) => f.out || f.spa === -1) && snarl.stats.includes("spa"), `${kinds(log)} | SpA ${foes.map((f) => f.spa).join("/")}`);
    const sheer = test.ourUnit(makeSet({ ...snarler, ability: "Sheer Force" }), 0);
    check("Sheer Force removes Snarl's drop", !sheer.kit.lowers.some((slot) => sheer.moves[slot].key === "snarl") && sheer.kit.lowers.some((slot) => sheer.moves[slot].key === "partingshot"));
  }

  // (n) Spore puts the most dangerous non-Grass foe to sleep; it loses its next turns. (A Venusaur
  // with Spore, so the sleep lasts two turns; Sleep Powder, 75% accurate, costs one.)
  {
    const amoonguss = { species: "Venusaur", item: "Focus Sash", ability: "Chlorophyll", nature: "Bold", moves: ["Spore", "Sludge Bomb", "Protect", "Energy Ball"], bonuses: [32, 0, 32, 0, 2, 0] };
    const rillaboom = member("Rillaboom", "Assault Vest", "Grassy Surge", "Adamant", ["Wood Hammer", "High Horsepower", "Knock Off", "U-turn"]);
    const porygon2 = member("Kingambit", "Black Glasses", "Defiant", "Adamant", ["Kowtow Cleave", "Iron Head", "Low Kick", "Protect"]);
    // Next to Gholdengo (no Earthquake into its own partner).
    const side = ours(amoonguss, BENCH[5]);
    const foes = theirs(rillaboom, porygon2);
    const log = [];
    test.turnOne([side, foes], board(), [false, false], log);
    const spore = log.find((e) => e.kind === "sleep");
    check("Spore skips a Grass type and puts the other foe to sleep", spore && spore.s === 0 && spore.target.species === "Kingambit" && foes[1].sleep && foes[1].idle >= 1, `${kinds(log)} | idle ${foes.map((f) => f.idle).join("/")}`);
    const g = game(test, [amoonguss, BENCH[5]], [rillaboom, porygon2]);
    check("A sleeping Pokémon shows as asleep after turn 1", g.after.status.them.includes("asleep"), JSON.stringify(g.after.status));
    const electric = [];
    const sideE = ours(amoonguss, BENCH[5]);
    const foesE = theirs(porygon2, tyranitar);
    test.turnOne([sideE, foesE], board("Electric"), [false, false], electric);
    check("No sleep for a grounded Pokémon in Electric Terrain", !electric.some((e) => e.kind === "sleep"), kinds(electric));
  }

  // (o) Taunt stops their Trick Room.
  {
    const grimmsnarl = { species: "Grimmsnarl", item: "Light Clay", ability: "Prankster", nature: "Careful", moves: ["Taunt", "Spirit Break", "Reflect", "Thunder Wave"], bonuses: [32, 0, 2, 0, 32, 0] };
    // A partner that only redirects, so their setter is still in when Trick Room would go up.
    const clefable = { species: "Clefable", item: "Sitrus Berry", ability: "Unaware", nature: "Bold", moves: ["Follow Me", "Moonblast", "Protect", "Helping Hand"], bonuses: [32, 0, 32, 0, 2, 0] };
    const g2 = game(test, [grimmsnarl, clefable], [
      member("Sinistcha", "Sitrus Berry", "Hospitality", "Relaxed", ["Trick Room", "Matcha Gotcha", "Shadow Ball", "Protect"]),
      member("Torkoal", "Charcoal", "Drought", "Quiet", ["Eruption", "Heat Wave", "Earth Power", "Protect"]),
    ]);
    const taunt = events(g2, 0, "taunt");
    const failed = events(g2, 1, "taunted");
    check("Taunt goes on their Trick Room setter", taunt.length === 1 && taunt[0].target.species === "Sinistcha", kinds(g2.events));
    check("A taunted setter cannot use Trick Room", failed.length === 1 && failed[0].move === "Trick Room" && !g2.after.trickRoom, `${kinds(g2.events)} | TR ${g2.after.trickRoom}`);
    // Prankster status moves fail on Dark types.
    const dark = game(test, [grimmsnarl, garchomp], [
      member("Incineroar", "Sitrus Berry", "Intimidate", "Careful", ["Trick Room", "Flare Blitz", "Knock Off", "Parting Shot"]),
      member("Torkoal", "Charcoal", "Drought", "Quiet", ["Eruption", "Heat Wave", "Earth Power", "Protect"]),
    ]);
    check("Prankster Taunt is not aimed at a Dark type", !events(dark, 0, "taunt").some((e) => e.target.species === "Incineroar"), kinds(dark.events));
  }

  // (p) Encore after their Fake Out: the Fake Out user is stuck and loses its next turns.
  {
    const encorer = { species: "Whimsicott", item: "Focus Sash", ability: "Prankster", nature: "Timid", moves: ["Encore", "Moonblast", "Protect", "Energy Ball"], bonuses: [2, 0, 0, 32, 0, 32] };
    const g2 = game(test, [encorer, garchomp], [
      member("Rillaboom", "Assault Vest", "Grassy Surge", "Adamant", ["Fake Out", "Grassy Glide", "Wood Hammer", "U-turn"]),
      kingambit,
    ]);
    const encore = events(g2, 0, "encore");
    check("Encore locks their Fake Out user", encore.length === 1 && encore[0].target.species === "Rillaboom" && g2.after.status.them[0] === "stuck", `${kinds(g2.events)} | ${JSON.stringify(g2.after.status)}`);
  }

  // (r) A Mega Stone holder comes in as its base form: the base form's entry Ability fires,
  // and the base form's Speed decides the entry order. The Mega's Ability runs the turn.
  {
    const sala = (item) => ({ species: "Salamence", form: "Salamence", item, ability: "Intimidate", nature: "Jolly", moves: ["Double-Edge", "Dragon Claw", "Protect", "Roost"], bonuses: [2, 32, 0, 0, 0, 32] });
    const theirs = [
      member("Gholdengo", "Life Orb", "Good as Gold", "Timid", ["Make It Rain", "Shadow Ball", "Nasty Plot", "Protect"]),
      member("Rillaboom", "Assault Vest", "Grassy Surge", "Adamant", ["Grassy Glide", "Wood Hammer", "U-turn", "Fake Out"]),
    ];
    const mega = game(test, [sala("Salamencite"), garchomp], theirs);
    const plain = game(test, [sala("Life Orb"), garchomp], theirs);
    check("A Mega Stone holder still Intimidates on the way in (Salamence @ Salamencite)",
      events(mega, 0, "intimidate").length === 1 && events(plain, 0, "intimidate").length === 1, kinds(mega.events));
    // Some sets name the Mega form and its Ability outright; the base form still comes in first.
    const named = game(test, [{ ...sala("Salamencite"), form: "Mega Salamence", ability: "Aerilate" }, garchomp], theirs);
    check("A set that already names the Mega form still Intimidates on the way in",
      events(named, 0, "intimidate").length === 1, kinds(named.events));
    // The Mega's own Ability still runs the turn: Mega Charizard Y's Drought puts the sun up.
    const sun = game(test, [{ species: "Charizard", form: "Charizard", item: "Charizardite Y", ability: "Blaze", nature: "Modest", moves: ["Heat Wave", "Weather Ball", "Solar Beam", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] }, garchomp], theirs);
    check("The Mega's own Ability still runs the turn (Charizardite Y brings the sun)", sun.after.weather === "Sun", sun.after.weather);
    // Mega Manectric gains Intimidate as it Mega-Evolves, so it fires even though the base has none.
    const manectric = game(test, [{ species: "Manectric", form: "Manectric", item: "Manectite", ability: "Lightning Rod", nature: "Timid", moves: ["Thunderbolt", "Overheat", "Volt Switch", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] }, garchomp], theirs);
    check("A Mega that gains Intimidate still fires it (Manectric @ Manectite)", events(manectric, 0, "intimidate").length === 1, kinds(manectric.events));
    // The target is still its base form too: Mega Mawile's Hyper Cutter blocks Intimidate.
    const mawile = game(test, [BENCH[2], garchomp], [member("Mawile", "Mawilite", "Hyper Cutter", "Adamant", ["Play Rough", "Sucker Punch", "Protect", "Iron Head"]), theirs[0]]);
    const lowered = events(mawile, 0, "intimidate").flatMap((e) => e.targets.map((t) => t.species));
    check("Hyper Cutter on the base form blocks Intimidate (Mawile @ Mawilite)", lowered.length > 0 && !lowered.includes("Mawile"), JSON.stringify(lowered));
    // Entry order uses the base form's Speed (Salamence 100, Mega Salamence 120).
    const unit = test.ourUnit(makeSet(sala("Salamencite")), 0);
    check("Entry order uses the base form's Speed", unit.base?.form_name === "Salamence" && test.entrySpeedOf(unit) < test.speedOf(unit, 0, false, 0),
      `${unit.base?.form_name} ${test.entrySpeedOf(unit)} vs ${test.speedOf(unit, 0, false, 0)}`);
  }

  // (q) Will-O-Wisp halves a physical attacker's damage.
  {
    const kg = test.opponentMon(kingambit);
    const target = test.ourUnit(makeSet(BENCH[4]), 0);
    const plain = test.moveHit(kg, target, 2, board(), 0, 0, 0).frac;
    const burned = test.moveHit(kg, target, 2, board(), 0, 0, 2).frac;
    check("A burn halves physical damage", burned > 0 && burned / plain > 0.45 && burned / plain < 0.55, `${plain.toFixed(3)} -> ${burned.toFixed(3)}`);
  }
}

// --- one Mega Evolution a side ------------------------------------------------------------
//
// Only one Pokémon per side Mega-Evolves, so no bring carries a second Mega Stone, and when
// a line-up must hold two (a named lead pair), one Mega-Evolves and the other plays its own
// base form -- base stats, base Ability, base Speed -- with the stone still in hand.
const TWO_STONES = [
  { species: "Salamence", item: "Salamencite", ability: "Intimidate", nature: "Jolly", moves: ["Double-Edge", "Dragon Claw", "Protect", "Tailwind"], bonuses: [2, 32, 0, 0, 0, 32] },
  { species: "Arcanine", item: "Sitrus Berry", ability: "Intimidate", nature: "Adamant", moves: ["Flare Blitz", "Extreme Speed", "Snarl", "Protect"], bonuses: [32, 32, 0, 0, 2, 0] },
  { species: "Blastoise", item: "Blastoisinite", ability: "Torrent", nature: "Modest", moves: ["Water Spout", "Ice Beam", "Protect", "Fake Out"], bonuses: [2, 0, 0, 32, 0, 32] },
  { species: "Milotic", item: "Leftovers", ability: "Competitive", nature: "Calm", moves: ["Scald", "Icy Wind", "Recover", "Protect"], bonuses: [32, 0, 0, 2, 32, 0] },
  { species: "Gholdengo", item: "Choice Specs", ability: "Good as Gold", nature: "Modest", moves: ["Make It Rain", "Shadow Ball", "Power Gem", "Trick"], bonuses: [2, 0, 0, 32, 0, 32] },
  { species: "Rillaboom", item: "Assault Vest", ability: "Grassy Surge", nature: "Adamant", moves: ["Grassy Glide", "Wood Hammer", "Fake Out", "U-turn"], bonuses: [32, 32, 0, 0, 2, 0] },
];
// Five holders in six: a bring cannot avoid a second stone, and still only one Mega-Evolves.
const FIVE_STONES = [
  { species: "Salamence", item: "Salamencite", ability: "Intimidate", nature: "Jolly", moves: ["Double-Edge", "Dragon Claw", "Protect", "Tailwind"], bonuses: [2, 32, 0, 0, 0, 32] },
  { species: "Blastoise", item: "Blastoisinite", ability: "Torrent", nature: "Modest", moves: ["Water Spout", "Ice Beam", "Protect", "Fake Out"], bonuses: [2, 0, 0, 32, 0, 32] },
  { species: "Garchomp", item: "Garchompite", ability: "Rough Skin", nature: "Jolly", moves: ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
  { species: "Metagross", item: "Metagrossite", ability: "Clear Body", nature: "Adamant", moves: ["Iron Head", "Zen Headbutt", "Bullet Punch", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
  { species: "Tyranitar", item: "Tyranitarite", ability: "Sand Stream", nature: "Adamant", moves: ["Rock Slide", "Crunch", "Low Kick", "Protect"], bonuses: [32, 32, 0, 0, 2, 0] },
  { species: "Milotic", item: "Leftovers", ability: "Competitive", nature: "Calm", moves: ["Scald", "Icy Wind", "Recover", "Protect"], bonuses: [32, 0, 0, 2, 32, 0] },
];
// A line-up names a Mega by the form it plays; a holder that did not Mega-Evolve is named by
// its base form and carries the stone under `stone` instead of `item`.
const megasIn = (list) => (list || []).filter((m) => /^mega /i.test(String(m.form || ""))).length;
const megaBoard = () => ({ w: 0, t: 0, tw: [0, 0], tr: 0, trBy: -1, wide: 0, quick: 0 });

// --- the bring size per format, the snapshot, and the spread of results -------------------
const runs = {};
for (const format of ["Doubles", "Singles"]) {
  const test = makeTest(format);
  const started = Date.now();
  let snapshots = 0;
  let firstMatrix = null;
  const s = await test.run(BENCH.map((set) => makeSet(set)), { limit, onSnapshot: (snap) => { snapshots += 1; firstMatrix ||= snap.matrix; } });
  runs[format] = { s, seconds: (Date.now() - started) / 1000, values: test.values };
  const size = format === "Singles" ? 3 : 4;
  const doubles = format === "Doubles";
  check(`${format}: snapshot version ${SNAPSHOT_VERSION}`, s.version === 4 && SNAPSHOT_VERSION === 4);
  check(`${format}: brings ${size}`, s.bring === size && s.bestBrings.every((b) => b.members.length === size) && s.hardest.every((t) => t.bring.length === size && t.against.length === size),
    JSON.stringify(s.bestBrings.map((b) => b.members.length)));
  check(`${format}: at most ${size} bring options, each the best choice somewhere`, s.bestBrings.length >= 1 && s.bestBrings.length <= size && s.bestBrings.slice(1).every((b) => b.bestRate > 0) && s.bestBrings.every((b) => b.leads.length === (doubles ? 2 : 1)),
    JSON.stringify(s.bestBrings.map((b) => [b.members.length, b.leads.length, b.bestRate])));
  check(`${format}: leads per side`, s.hardest.every((t) => t.leads === (doubles ? 2 : 1)));
  check(`${format}: progress after every batch`, snapshots >= Math.floor(limit / 8));
  check(`${format}: values within 0..100`, test.values.every((v) => v >= 0 && v <= 100));
  const deciles = Array(10).fill(0);
  for (const v of test.values) deciles[Math.min(9, Math.floor(v / 10))] += 1;
  check(`${format}: no decile above 40%`, Math.max(...deciles) <= 0.4 * test.values.length, JSON.stringify(deciles));
  check(`${format}: bands add up`, s.bands.favourable + s.bands.even + s.bands.unfavourable === s.tested);
  check(`${format}: threats have an answer`, s.threats.every((t) => t.answer && t.answer.species && t.answer.win >= 0 && t.answer.win <= 1));
  if (doubles) check("Doubles: threats have a best lead pair (2 vs 2)", s.threats.length > 0 && s.threats.every((t) => t.pairAnswer && t.pairAnswer.members.length === 2 && t.pairAnswer.value >= 0 && t.pairAnswer.value <= 100 && t.pairAnswer.partner?.species),
    JSON.stringify(s.threats.map((t) => t.pairAnswer)));
  // The lead matrix: 2 vs 2 pairs in Doubles (all 15 of ours), 1 vs 1 in Singles.
  const mx = s.matrix;
  const width = doubles ? 2 : 1;
  check(`${format}: lead matrix is ${doubles ? "2 vs 2" : "1 vs 1"}`, mx && mx.kind === (doubles ? "pairs" : "single") && mx.columns.length === (doubles ? 15 : 6)
    && mx.columns.every((c) => c.members.length === width) && mx.rows.length > 10 && mx.rows.length <= 40 && mx.rows.every((row) => row.members.length === width && row.cells.length === mx.columns.length && row.cells.every((v) => v >= 0 && v <= 100)),
  `${mx?.kind} ${mx?.columns.length} x ${mx?.rows.length}`);
  check(`${format}: matrix rows by how often they lead (or appear)`, mx.rows.every((row, i) => i === 0 || row.count <= mx.rows[i - 1].count || (doubles && row.count === 0)), JSON.stringify(mx.rows.map((r) => r.count)));
  check(`${format}: matrix columns led with most first`, mx.columns.every((c, i) => i === 0 || c.leads <= mx.columns[i - 1].leads + 1e-9));
  check(`${format}: matrix is there from the first snapshot`, firstMatrix && firstMatrix.rows.length > 0);
  if (doubles) {
    check("Doubles: every Pokémon has a best partner", s.pokemon.every((p) => p.partner && p.partner.slot !== p.slot && p.pairScore >= 0 && p.pairScore <= 100), JSON.stringify(s.pokemon.map((p) => [p.partner?.species, p.pairScore])));
    check("Doubles: trouble pairs are pairs they lead with", s.pokemon.every((p) => p.weakPairs.every((w) => w.members.length === 2 && w.value < 45)));
  }
  check(`${format}: the old duel table is still filled`, s.duels.rows.length > 0 && s.duels.rows.every((row) => row.cells.length === s.ours.length));
  // Singles: the Pokémon table, the Trouble list and the biggest threats all quote the cells
  // of the 1 vs 1 matrix, so the page cannot say "Trouble: X" over a Favoured cell for X.
  if (!doubles) {
    const monKey = (m) => `${m.species}|${m.form}`;
    const colOf = (slot) => mx.columns.findIndex((col) => col.members[0].slot === slot);
    const rowOf = (m) => mx.rows.findIndex((row) => monKey(row.members[0]) === monKey(m));
    const cellFor = (them, slot) => {
      const r = rowOf(them);
      const c = colOf(slot);
      return r >= 0 && c >= 0 ? mx.rows[r].cells[c] : null;
    };
    const troubles = s.pokemon.flatMap((p) => (p.weakTo || []).map((w) => [p, w]));
    check("Singles: every Trouble Pokémon is Behind in the matrix cell for that pair",
      troubles.length > 0 && troubles.every(([p, w]) => { const v = cellFor(w, p.slot); return v === null || v < 45; }),
      JSON.stringify(troubles.map(([p, w]) => [p.species, w.form, cellFor(w, p.slot)?.toFixed(1), w.fromMatrix])));
    check("Singles: a Trouble Pokémon from the matrix carries that cell's own score",
      troubles.every(([p, w]) => !w.fromMatrix || Math.abs(w.value - cellFor(w, p.slot)) < 1e-9));
    check("Singles: the best answer to a threat is its best cell in the matrix row",
      s.threats.length > 0 && s.threats.every((t) => {
        const r = rowOf(t);
        if (r < 0) return t.answer.value === null;
        return t.answer.value !== null && Math.abs(t.answer.value - Math.max(...mx.rows[r].cells)) < 1e-9
          && Math.abs(t.answer.value - cellFor(t, t.answer.slot)) < 1e-9;
      }), JSON.stringify(s.threats.map((t) => [t.form, t.answer.species, t.answer.value])));
    // The 1 vs 1 column counts only the Pokémon they actually brought, weighted by how often.
    check("Singles: the 1 vs 1 column is the brought-weighted mean of that Pokémon's cells",
      s.pokemon.every((p) => {
        const c = colOf(p.slot);
        let sum = 0;
        let weight = 0;
        for (const row of mx.rows) {
          if (!(row.brought > 0)) continue;
          sum += row.brought * row.cells[c];
          weight += row.brought;
        }
        return weight > 0 && p.oneOnOne !== null && Math.abs(p.oneOnOne - sum / weight) < 1e-9;
      }), JSON.stringify(s.pokemon.map((p) => [p.species, p.oneOnOne])));
    check("Singles: the matrix rows say how often they were brought", mx.rows.every((row) => row.brought !== null && row.brought >= 0 && row.brought <= row.share + 1e-9));
  } else {
    check("Doubles: the 1 vs 1 column is not used (the pair score is)", s.pokemon.every((p) => p.oneOnOne === null) && mx.rows.every((row) => row.brought === null));
  }
  check(`${format}: archetypes cover every team`, s.archetypes.reduce((sum, a) => sum + a.count, 0) === s.tested);
  check(`${format}: archetypes from best to worst`, s.archetypes.every((a, i) => i === 0 || a.average <= s.archetypes[i - 1].average + 1e-9), JSON.stringify(s.archetypes.map((a) => a.average.toFixed(1))));
  check(`${format}: the most similar team`, s.similar && s.similar.members.length === 6 && s.similar.overlap >= 3 && s.similar.members.filter((m) => m.shared).length === s.similar.overlap && s.similar.members.every((m) => m.bonuses?.length === 6),
    JSON.stringify(s.similar && { n: s.similar.number, o: s.similar.overlap }));
  check(`${format}: stories have the field after turn 1`, s.hardest.every((t) => Array.isArray(t.after.field?.you) && t.after.field.you.length <= (doubles ? 2 : 1) && Array.isArray(t.after.status?.them)));
  check(`${format}: snapshot survives a structured clone`, JSON.stringify(structuredClone(s)) === JSON.stringify(s));
  // One Mega a side, everywhere the results name a line-up. Most tournament teams are
  // registered with two Mega Stones, so their side is the real test here.
  {
    const lineUps = [
      ...s.bestBrings.map((b) => ["bring", b.members]),
      ...s.bestBrings.map((b) => ["lead", b.leads]),
      ...mx.columns.map((col) => ["our line-up", col.members]),
      ...mx.rows.map((row) => ["their line-up", row.members]),
      ...[...s.hardest, ...s.easiest].flatMap((g) => [["game bring", g.bring], ["their bring", g.against]]),
      ...s.pokemon.flatMap((p) => (p.weakPairs || []).map((w) => ["trouble pair", w.members])),
      ...s.threats.filter((t) => t.pairAnswer).map((t) => ["pair answer", t.pairAnswer.members]),
    ];
    const twoMegas = lineUps.filter(([, list]) => megasIn(list) > 1);
    check(`${format}: no line-up in the results names two Megas`, twoMegas.length === 0,
      JSON.stringify(twoMegas.map(([what, list]) => [what, list.map((m) => m.form)])));
    // A story never names two Megas on one side either.
    const sides = [...s.hardest, ...s.easiest].flatMap((g) => ["you", "them"].map((side) => g.story.filter((e) => e.side === side).map((e) => e.actor)));
    check(`${format}: no story has two Megas acting on one side`, sides.every((list) => megasIn(list.filter((m, i) => list.findIndex((x) => x.form === m.form) === i)) <= 1),
      JSON.stringify(sides.filter((list) => megasIn(list) > 1).map((list) => list.map((m) => m.form))));
  }
  console.log(`${format}: ${s.tested} teams in ${runs[format].seconds.toFixed(1)} s · average ${s.average.toFixed(1)} · favoured ${s.bands.favourable} / even ${s.bands.even} / behind ${s.bands.unfavourable} · deciles ${JSON.stringify(deciles)} · matrix ${mx.rows.length} x ${mx.columns.length}`);
}

// --- turn 1 does not reach the duel numbers (TOURNAMENT_TURN_ONE version 2) ----------------
// `playTeam` used to duel on the board the chosen game left AFTER turn 1, so a Trick Room that
// went up on turn 1 inverted who strikes first in every duel of that game. Whole-pipeline check:
// a run whose `duel` is handed a board with a Trick Room, both Tailwinds and Sand on it must
// report the same duel column, the same duel table and the same threat answers as an honest one.
{
  const poison = { w: 3, t: 4, tw: [3, 3], tr: 4, trBy: 0, wide: 3, quick: 3 };
  const quick = 40;
  for (const format of ["Doubles", "Singles"]) {
    const honest = await makeTest(format).run(BENCH.map((set) => makeSet(set)), { limit: quick });
    const test = makeTest(format);
    const honestDuel = test.duel.bind(test);
    test.duel = (o, t) => honestDuel(o, t, poison);
    const poisoned = await test.run(BENCH.map((set) => makeSet(set)), { limit: quick });
    const column = (s) => s.pokemon.map((p) => p.duel);
    const table = (s) => s.duels.rows.map((row) => [row.species, row.form, ...row.cells]);
    const answers = (s) => s.threats.map((t) => [t.species, t.form, t.answer.species, t.answer.form, t.answer.win, t.level]);
    check(`${format}: the duel column ignores what turn 1 left on the board`,
      column(honest).length === 6 && JSON.stringify(column(honest)) === JSON.stringify(column(poisoned)),
      `${JSON.stringify(column(honest))} vs ${JSON.stringify(column(poisoned))}`);
    check(`${format}: so does the duel table`, table(honest).length > 0 && JSON.stringify(table(honest)) === JSON.stringify(table(poisoned)));
    check(`${format}: and the biggest threats' answers`, answers(honest).length > 0 && JSON.stringify(answers(honest)) === JSON.stringify(answers(poisoned)));
    // The rest of the run is untouched by the duels, so it must match as well.
    check(`${format}: the headline average never came from the duels`, honest.average === poisoned.average, `${honest.average} vs ${poisoned.average}`);
  }
}

for (const format of ["Doubles", "Singles"]) {
  const test = makeTest(format);
  const units = TWO_STONES.map((set, i) => test.ourUnit(makeSet(set), i));
  const holders = units.filter((u) => test.megaHolder(u));
  check(`${format}: the two stone holders are found`, holders.length === 2 && units[0].base?.form_name === "Salamence" && units[2].base?.form_name === "Blastoise",
    JSON.stringify(units.map((u) => [u.form, Boolean(u.base)])));

  // No bring offers a second stone: the fours (or threes) holding both are simply gone.
  const plans = test.plansFor(units);
  const both = format === "Singles" ? 4 : 6; // the line-ups that carry both holders
  const all = format === "Singles" ? 20 : 15;
  check(`${format}: the brings holding two stones are not offered`, plans.length === all - both, `${plans.length} of ${all}`);
  check(`${format}: every bring carries at most one Mega Stone`, plans.every((p) => p.members.filter((m) => test.megaHolder(m)).length <= 1));
  check(`${format}: no bring plays two Megas`, plans.every((p) => megasIn(p.members) <= 1),
    JSON.stringify(plans.map((p) => p.members.map((m) => m.form))));

  // A named lead pair of the two holders has to carry both: one Mega-Evolves, the other does not.
  const forced = test.fixedPlan([units[0], units[2]]);
  const [first, second] = forced.members;
  check(`${format}: a forced two-stone line-up plays exactly one Mega`,
    first.form === "Mega Salamence" && !first.stone && second.form === "Blastoise" && second.stone === "Blastoisinite",
    forced.members.map((m) => `${m.form}${m.stone ? `+${m.stone}` : ""}`).join(" + "));
  // It is played that way, not only labelled: base stats, base Ability, base Speed.
  const megaBlastoise = units[2];
  const baseStats = test.ev.engine.finalStats(second.mon);
  const megaStats = test.ev.engine.finalStats(megaBlastoise.mon);
  check(`${format}: the holder that stays behind keeps its base stats and Ability`,
    second.mon.ability === "Torrent" && megaBlastoise.mon.ability !== "Torrent" && baseStats.defense < megaStats.defense,
    `${second.mon.ability}/${baseStats.defense} vs ${megaBlastoise.mon.ability}/${megaStats.defense}`);
  // Turn the pair around and Salamence is the one that stays behind: 100 Speed, not 120.
  {
    const other = test.fixedPlan([units[2], units[0]]);
    const salamence = other.members[1];
    check(`${format}: the holder that stays behind keeps its base Speed`,
      other.members[0].form === "Mega Blastoise" && salamence.form === "Salamence"
      && test.speedOf(salamence, 0, false, 0) < test.speedOf(units[0], 0, false, 0),
      `${other.members.map((m) => m.form).join(" + ")} ${test.speedOf(salamence, 0, false, 0)} vs ${test.speedOf(units[0], 0, false, 0)}`);
  }
  // ... and it takes a hit like the base form, not like the Mega.
  {
    const kg = test.opponentMon(member("Kingambit", "Leftovers", "Defiant", "Adamant", ["Sucker Punch", "Kowtow Cleave", "Iron Head", "Protect"]));
    const b = megaBoard();
    const onBase = test.strike(kg, second, b, 0, 0).frac;
    const onMega = test.strike(kg, megaBlastoise, b, 0, 0).frac;
    check(`${format}: the base form takes damage like the base form`, onBase > onMega + 1e-9, `${onBase.toFixed(4)} vs ${onMega.toFixed(4)}`);
  }

  // Which one Mega-Evolves is a choice, not an accident.
  const [v0, v2] = [test.megaValue(units[0]), test.megaValue(units[2])];
  check(`${format}: a stone holder is worth Mega-Evolving and a plain one is not`,
    v0 > 0 && v2 > 0 && test.megaValue(units[1]) < 0 && test.committedMega([1, 3], units, []) === -1,
    `${v0.toFixed(1)} / ${v2.toFixed(1)}`);
  check(`${format}: with neither leading, the holder worth more Mega-Evolves`,
    test.committedMega([0, 2], units, []) === (v0 >= v2 ? 0 : 2), `${v0.toFixed(1)} vs ${v2.toFixed(1)}`);
  if (Math.abs(v0 - v2) < 7) {
    check(`${format}: a leading holder Mega-Evolves over an equal one behind it`,
      test.committedMega([0, 2], units, [2]) === 2 && test.committedMega([0, 2], units, [0]) === 0);
  }

  // Five holders in six: a bring must carry a second stone, and still plays one Mega.
  const stoneUnits = FIVE_STONES.map((set, i) => test.ourUnit(makeSet(set), i));
  const stonePlans = test.plansFor(stoneUnits);
  const stonesPer = stonePlans.map((p) => p.members.filter((m) => test.megaHolder(m) || m.stone).length);
  check(`${format}: a team of stone holders still has brings, each with one Mega`,
    stonePlans.length === (format === "Singles" ? 10 : 10) && stonePlans.every((p) => megasIn(p.members) === 1),
    `${stonePlans.length} brings, megas ${JSON.stringify(stonePlans.map((p) => megasIn(p.members)))}`);
  check(`${format}: such a bring carries the fewest stones it can`, Math.max(...stonesPer) === (format === "Singles" ? 2 : 3), JSON.stringify(stonesPer));
}

// --- the free runs: the three Pro features behave the same --------------------------------
//
// Team Evaluation, Auto Build and Test against Tournament Teams each give the same number of
// complete free runs, count them apart from each other, and are all lifted by one Pro licence.
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  let jar = "";
  globalThis.document = { get cookie() { return jar; }, set cookie(value) { jar = String(value).split(";")[0]; } };
  const pro = await import("../builder/pro.js");
  const FEATURES = ["evaluation", "autobuild", "tournament"];
  check("Pro: three free runs of each feature", pro.FREE_RUNS === 3, String(pro.FREE_RUNS));
  check("Pro: all three start with every free try", FEATURES.every((f) => pro.canRun(f) && pro.freeRunsLeft(f) === pro.FREE_RUNS));
  for (let used = 1; used <= pro.FREE_RUNS; used += 1) {
    pro.recordRun("tournament");
    check(`Pro: the tournament test has ${pro.FREE_RUNS - used} free tries left after ${used}`, pro.freeRunsLeft("tournament") === pro.FREE_RUNS - used,
      String(pro.freeRunsLeft("tournament")));
  }
  check("Pro: the tournament test asks for Pro after its free runs", !pro.canRun("tournament"));
  check("Pro: its runs are not taken from the other two",
    FEATURES.filter((f) => f !== "tournament").every((f) => pro.canRun(f) && pro.freeRunsLeft(f) === pro.FREE_RUNS));
  for (const feature of ["evaluation", "autobuild"]) for (let i = 0; i < pro.FREE_RUNS; i += 1) pro.recordRun(feature);
  check("Pro: all three are out after the same number of runs", FEATURES.every((f) => !pro.canRun(f) && pro.freeRunsLeft(f) === 0));
  // One licence lifts the limit for all three, and a Pro run is not counted.
  const token = (edition, seconds) => `${Buffer.from(JSON.stringify({ edition, plan: "pro-yearly", exp: Math.floor(Date.now() / 1000) + seconds })).toString("base64")}.signature`;
  store.set("cbd.licence.v1", JSON.stringify({ key: "PCT-TEST", token: token("pro", 3600) }));
  check("Pro: a licence lifts the limit for all three", pro.isPro() && FEATURES.every((f) => pro.canRun(f) && pro.freeRunsLeft(f) === Infinity));
  const spent = globalThis.localStorage.getItem("cbd.runs.v1");
  FEATURES.forEach((f) => pro.recordRun(f));
  check("Pro: a Pro run is not counted against the free tries", globalThis.localStorage.getItem("cbd.runs.v1") === spent);
  // An expired or free-edition token is not Pro, and the free runs stay spent.
  store.set("cbd.licence.v1", JSON.stringify({ key: "PCT-TEST", token: token("pro", -10) }));
  check("Pro: an expired licence is not Pro", !pro.isPro() && FEATURES.every((f) => !pro.canRun(f)));
  store.set("cbd.licence.v1", JSON.stringify({ key: "PCT-TEST", token: token("free", 3600) }));
  check("Pro: a free-edition token is not Pro", !pro.isPro() && !pro.canRun("tournament"));
  delete globalThis.localStorage;
  delete globalThis.document;
}

// --- (e) turn-1 tools move the result ----------------------------------------------------------
{
  const variants = {
    "no Tailwind": BENCH.map((set) => (set.species === "Whimsicott" ? { ...set, moves: ["Energy Ball", "Moonblast", "Encore", "Protect"] } : set)),
    "no Fake Out / Intimidate": BENCH.map((set) => (set.species === "Incineroar" ? { ...set, ability: "Blaze", moves: ["Darkest Lariat", "Parting Shot", "Flare Blitz", "Knock Off"] } : set)),
  };
  const full = runs.Doubles.s;
  for (const [label, sets] of Object.entries(variants)) {
    const s = await makeTest("Doubles").run(sets.map((set) => makeSet(set)), { limit });
    console.log(`Doubles ${label}: average ${s.average.toFixed(1)} (full ${full.average.toFixed(1)}) · favoured ${s.bands.favourable} (full ${full.bands.favourable})`);
    check(`${label} lowers the favoured count`, s.bands.favourable < full.bands.favourable, `${s.bands.favourable} vs ${full.bands.favourable}`);
  }
}

// --- (i) the results view: sections, words, the matrix and its Show more --------------------------
{
  // Just enough DOM for ui.js h(): elements with children, classes, listeners and their text.
  class El {
    constructor(tag) { this.tag = tag; this.kids = []; this.style = { setProperty() {} }; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.className = ""; this.parent = null; }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    append(...kids) { for (const kid of kids) { kid.parent = this; this.kids.push(kid); } }
    get textContent() { return this.kids.map((kid) => kid.textContent).join(""); }
    all(cls) { const out = []; const walk = (el) => { for (const kid of el.kids) { if (String(kid.className || "").split(" ").includes(cls)) out.push(kid); walk(kid); } }; walk(this); return out; }
    closest(sel) { const cls = sel.replace(/^\./, ""); let el = this; while (el && !String(el.className || "").split(" ").includes(cls)) el = el.parent; return el; }
    replaceWith(node) { const i = this.parent.kids.indexOf(this); node.parent = this.parent; this.parent.kids[i] = node; }
  }
  class Txt extends El {
    constructor(text) { super("#text"); this.text = text; }
    get textContent() { return this.text; }
  }
  globalThis.Node = El;
  globalThis.document = { createElement: (tag) => new El(tag), createTextNode: (text) => new Txt(text) };
  const { tournamentAnalysis, tournamentExplainer, resetTournamentView } = await import("../builder/tournament-view.js");
  const view = (s) => tournamentAnalysis(s, { name: (m) => m.species, sprite: () => new El("img"), running: false, loadTeam: () => {} });
  const render = (s) => view(s).textContent;
  const sections = (node) => node.kids.map((kid) => kid.all("bd-tr-head")[0]?.kids[0]?.textContent || String(kid.className).split(" ")[0]);

  resetTournamentView();
  const doublesView = view(runs.Doubles.s);
  const full = doublesView.textContent;
  const order = sections(doublesView);
  check("Doubles: the sections in order", JSON.stringify(order) === JSON.stringify(["bd-tr-verdict", "Bring these four", "Biggest threats", "Your Pokémon", "By archetype", "Hardest teams", "Easiest teams", "Lead pairs, 2 vs 2", "Most similar tournament team"]), JSON.stringify(order));
  check("No 'What happens on turn 1' section", !full.includes("What happens on turn 1"));
  check("Bring lists the other strong choices", runs.Doubles.s.bestBrings.length < 2 || full.includes("Other strong choices to bring"));
  const options = doublesView.all("bd-tr-option");
  check("Every bring option shows our Pokémon with the leads marked", options.length === runs.Doubles.s.bestBrings.length && options.every((o) => o.all("bd-tr-option-mon").length === 4 && o.all("lead").length === 2));
  const teams = doublesView.all("bd-tr-game");
  check("Hardest and easiest teams show all six Pokémon", teams.length > 0 && teams.every((t) => t.all("bd-tr-six")[0]?.kids.length === 6));
  const cols = doublesView.all("bd-tr-mx-col");
  check("Matrix column heads are sprites only (two per pair, no names)", cols.length === 8 && cols.every((c) => c.kids.length === 2 && c.kids.every((k) => k.tag === "img") && !c.textContent.trim()));
  const rowsBefore = doublesView.all("bd-tr-mx-name").length;
  const more = doublesView.all("bd-tr-mx-block")[0].all("ghost-button").find((b) => b.textContent.startsWith("Show more"));
  more?.listeners.click?.({ currentTarget: more });
  const rowsAfter = doublesView.all("bd-tr-mx-name").length;
  check("Show more adds ten of their pairs", rowsBefore === 10 && rowsAfter === Math.min(20, runs.Doubles.s.matrix.rows.length), `${rowsBefore} -> ${rowsAfter}`);
  const allPairs = doublesView.all("bd-tr-mx-block")[0].all("ghost-button").find((b) => b.textContent.startsWith("Show all"));
  allPairs?.listeners.click?.({ currentTarget: allPairs });
  check("Show all brings in all 15 of our pairs", doublesView.all("bd-tr-mx-col").length === 15);
  resetTournamentView();
  check("Doubles text talks about pairs", full.includes("Your best lead pair into it") && full.includes("Best partner") && full.includes("2 vs 2"));
  check("The similar team is shown with its six", doublesView.all("bd-similar-member").length === 6 && full.includes(`Team #${runs.Doubles.s.similar.number}`));

  // One Mega a side: the holder that does not Mega-Evolve is named by its base form, with the
  // Mega Stone it is still holding, wherever the results speak in sentences.
  {
    const d = runs.Doubles.s;
    const stone = { species: "Blastoise", form: "Blastoise", item: "", stone: "Blastoisinite" };
    const first = d.bestBrings[0];
    const held = { ...first.members[0], ...stone };
    const option = { ...first, members: [held, ...first.members.slice(1)], leads: [held, ...first.leads.slice(1)] };
    const bringText = render({ ...d, bestBrings: [option] });
    check("A holder that does not Mega-Evolve is named with the stone it holds",
      bringText.includes("Blastoise (holding Blastoisinite)"), bringText.match(/Lead[^.]*\./)?.[0] || "");
    const pairAnswer = d.threats.find((t) => t.pairAnswer)?.pairAnswer;
    if (pairAnswer) {
      const threat = { ...d.threats.find((t) => t.pairAnswer), pairAnswer: { ...pairAnswer, subject: { ...stone }, partner: { ...stone } } };
      const threatText = render({ ...d, threats: [threat] });
      check("A threat that cannot Mega-Evolve beside its partner is named that way",
        threatText.includes("Your best lead pair into Blastoise (holding Blastoisinite)") && threatText.includes("with Blastoise (holding Blastoisinite)"),
        threatText.match(/Your best lead pair into[^.]*\./)?.[0] || "");
    }
    // The one-Mega rule is a rule of the games, not a paragraph: the owner asked
    // for a short "How it works", so the explainer no longer spells it out. What
    // the player sees instead is the result naming the stone the Pokemon that did
    // not Mega-Evolve still holds, which the checks above cover.
    check("The explainer does not spell out the one-Mega rule",
      !tournamentExplainer({ teams: 2827, format: "Doubles" }).textContent.includes("Only one Pokémon a side may Mega-Evolve"));
  }

  const singlesView = view(runs.Singles.s);
  const singlesText = singlesView.textContent;
  check("Singles: 'Bring these three', a 1 vs 1 matrix, no pair talk", singlesText.includes("Bring these three") && sections(singlesView).includes("Matchups, 1 vs 1") && !singlesText.includes("Best partner") && !singlesText.includes("2 vs 2"),
    JSON.stringify(sections(singlesView)));
  check("Singles: matrix heads are one sprite each", singlesView.all("bd-tr-mx-col").every((c) => c.kids.length === 1 && c.kids[0].tag === "img"));
  const how = tournamentExplainer({ teams: 2827, format: "Doubles" }).textContent;
  // "How it works" is deliberately short now: the moves turn 1 can bring are
  // listed once, in the panel description above the button, not again here.
  check("The explainer keeps its steps short", how.includes("Each of the four picks one action, and they go in priority and Speed order.")
    && how.includes("From turn 2 all four attack on the board turn 1 left behind.")
    && !how.includes("Wide Guard"), how.slice(0, 160));
  check("The Singles explainer brings three and has no partner moves", tournamentExplainer({ format: "Singles" }).textContent.includes("Both sides bring three") && !tournamentExplainer({ format: "Singles" }).textContent.includes("Helping Hand"));

  // A lone Pokémon that cannot damage anything: one to bring, the same score against every archetype.
  const lone = await makeTest("Doubles").run([makeSet({ species: "Whimsicott", item: "Focus Sash", ability: "Prankster", nature: "Timid", moves: ["Tailwind", "Encore", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] })], { limit: 80 });
  const loneText = render(lone);
  const known = lone.archetypes.filter((a) => a.name !== "Other" && a.count >= 5);
  const gap = Math.max(...known.map((a) => a.average)) - Math.min(...known.map((a) => a.average));
  check("A one-Pokémon team reads 'Bring this one'", loneText.includes("Bring this one") && !loneText.includes("Bring these"));
  check("No strongest / weakest archetype when the averages are equal", known.length >= 2 && gap < 3 && !loneText.includes("Strongest against"), `${known.length} archetypes, gap ${gap.toFixed(1)}`);

  // The story lines for the turn-1 events.
  const mon = (species) => ({ species, form: species, item: "" });
  const game = runs.Doubles.s.hardest[0];
  const e = (fields) => ({ side: "you", target: null, targets: null, own: null, move: "", value: "", by: "", stats: null, ...fields });
  const story = [
    e({ kind: "partnerko", actor: mon("Garchomp"), target: mon("Incineroar"), move: "Earthquake" }),
    e({ side: "them", kind: "speeddrop", actor: mon("Torkoal"), targets: [mon("Dragapult")], own: [mon("Venusaur")], move: "Bulldoze" }),
    e({ kind: "helpinghand", actor: mon("Indeedee"), target: mon("Gholdengo"), move: "Helping Hand" }),
    e({ kind: "wideguard", actor: mon("Gallade") }),
    e({ side: "them", kind: "blocked", actor: mon("Incineroar"), target: mon("Garchomp"), move: "Fake Out", by: "Quick Guard" }),
    e({ kind: "lower", actor: mon("Incineroar"), targets: [mon("Gholdengo"), mon("Sylveon")], move: "Snarl", stats: ["spa"] }),
    e({ kind: "sleep", actor: mon("Venusaur"), target: mon("Kingambit"), move: "Spore", value: "2" }),
    e({ kind: "taunt", actor: mon("Grimmsnarl"), target: mon("Sinistcha") }),
    e({ side: "them", kind: "taunted", actor: mon("Sinistcha"), move: "Trick Room" }),
  ];
  const storyText = render({ ...runs.Doubles.s, hardest: [{ ...game, story }] });
  const lines = [
    "Your Garchomp's Earthquake also hits your own Incineroar and knocks it out.",
    "Their Torkoal uses Bulldoze: your Dragapult has lower Speed, and their own Venusaur has lower Speed too.",
    "Your Indeedee uses Helping Hand: your Gholdengo's attack is 50% stronger this turn.",
    "Your Gallade uses Wide Guard: moves that hit both of your Pokémon are blocked this turn.",
    "Their Incineroar's Fake Out on your Garchomp is blocked by Quick Guard.",
    "Your Incineroar uses Snarl: their Gholdengo and Sylveon have lower Sp. Atk.",
    "Your Venusaur uses Spore: their Kingambit falls asleep and loses its next two turns.",
    "Your Grimmsnarl taunts their Sinistcha: it cannot use status moves such as Trick Room or Tailwind.",
    "Their Sinistcha cannot use Trick Room: it was taunted.",
  ];
  for (const line of lines) check(`Story: ${line.slice(0, 48)}…`, storyText.includes(line));
  check("Story: the pairs that start turn 2", /Turn 2 starts with your .+ \+ .+ against their .+ \+ .+\./.test(render({ ...runs.Doubles.s, hardest: [game] })));

  // --- the Singles table quotes the 1 vs 1 games, not a separate reckoning -----------------
  {
    const s = runs.Singles.s;
    const text = render(s);
    check("Singles: the Pokémon table's last column is the 1 vs 1 score", text.includes("1 vs 1: its score across the games in the Matchups card below") && !text.includes("Duels won"), text.slice(0, 0));
    const scores = singlesView.all("bd-tr-win").map((node) => Number(node.textContent));
    check("Singles: the column shows each Pokémon's 1 vs 1 score out of 100",
      scores.length === s.pokemon.length && scores.every((v, i) => v === Math.round(s.pokemon[i].oneOnOne)), JSON.stringify(scores));
    check("Singles: the matrix rows say how often they were brought against you", text.includes(", brought in "));
    // Every threat the matrix holds a row for is quoted as that row's score, not a duel share.
    const fromMatrix = s.threats.filter((t) => t.answer.value !== null);
    const quoted = text.split(" against it 1 vs 1)").length - 1;
    const duelWords = text.split("of their 1-on-1s from full HP").length - 1;
    check("Singles: the best answer is quoted as a matrix score, not a duel share",
      fromMatrix.length > 0 && quoted === fromMatrix.length && duelWords === s.threats.length - fromMatrix.length,
      `${quoted} matrix / ${duelWords} duel of ${s.threats.length} threats`);
  }

  // --- a short team: nothing claims a bring size the team cannot reach ---------------------
  {
    check("The explainer states our bring size and theirs separately",
      tournamentExplainer({ format: "Doubles", bring: 3 }).textContent.includes("You bring three, they bring four"));
    check("The explainer handles a one-Pokémon team",
      tournamentExplainer({ format: "Singles", bring: 1 }).textContent.includes("You bring your one, they bring three"));
    check("The explainer still says both sides for a full team",
      tournamentExplainer({ format: "Doubles", bring: 4 }).textContent.includes("Both sides bring four")
      && tournamentExplainer({ format: "Singles", bring: 3 }).textContent.includes("Both sides bring three"));
    const short = await makeTest("Doubles").run(BENCH.slice(0, 3).map((set) => makeSet(set)), { limit: 40 });
    const shortText = render(short);
    check("A three-Pokémon Doubles team brings three and says they bring four",
      short.bring === 3 && shortText.includes("Bring these three") && shortText.includes("your best three against the four of theirs")
      && !shortText.includes("best four") && !shortText.includes("Bring these four"),
      shortText.match(/[^.]*\bfour\b[^.]*\./)?.[0] || "");
    check("Without a bring size the explainer follows the last results drawn",
      tournamentExplainer({ format: "Doubles" }).textContent.includes("You bring three, they bring four"));
    const one = await makeTest("Doubles").run([makeSet(BENCH[4])], { limit: 40 });
    const oneText = render(one);
    check("A one-Pokémon Doubles team reads 'Lead with', not 'Lead A + B'", oneText.includes("Lead with Whimsicott") && !/Lead Whimsicott/.test(oneText),
      oneText.match(/Lead[^.]*\./)?.[0] || "");
    check("A one-Pokémon team's note does not promise a choice of three", !oneText.includes("that hold up best"), oneText.match(/[^.]*hold up best[^.]*\./)?.[0] || "");
  }
}

console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
