// Scenario checks for Test against Tournament Teams (builder/tournament-test.js):
// hand-made leads for turn 1, the bring size per format, the snapshot shape, and that
// Tailwind / Fake Out / Intimidate actually move the result. Also: Earthquake-type moves
// hit the partner (and the choice and Protect account for it), Speed drops skip immune
// targets, Grassy Glide / First Impression priority, and a few lines of the results text.
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
import { TournamentTest } from "../builder/tournament-test.js";
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
  const board = (terrain = "None") => ({ w: 0, t: ["None", "Electric", "Grassy", "Psychic", "Misty"].indexOf(terrain), tw: [0, 0], tr: 0, trBy: -1 });
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
    // The foes only protect or set up, so our own Earthquake is the only thing that can knock our partner out.
    const g = state(chomp, 0);
    const partner = state(test.ourUnit(makeSet(groundedPartner), 1), 0, 0.5);
    const foes = [
      state(test.opponentMon(member("Kingambit", "Black Glasses", "Defiant", "Adamant", ["Protect", "Swords Dance"])), 1, 0.3),
      state(test.opponentMon(member("Tyranitar", "Assault Vest", "Sand Stream", "Adamant", ["Protect", "Dragon Dance"])), 1, 0.6),
    ];
    const log = [];
    test.turnOne([[g, partner], foes], board(), [false, false], log);
    check("The partner protects from its own side's Earthquake", log.some((e) => e.kind === "protect" && e.actor === partner.u) && partner.hp === 0.5 && foes.every((f) => f.out) && g.kos === 2,
      `${log.map((e) => `${e.kind}:${e.actor.species}`).join(" ")} | partner ${partner.hp}`);
  }

  // (g) A spread Speed drop only lowers the Pokémon it damages (Electroweb does nothing to a Ground type).
  {
    const ampharos = { species: "Ampharos", item: "Focus Sash", ability: "Static", nature: "Quiet", moves: ["Electroweb", "Dazzling Gleam", "Thunderbolt", "Protect"], bonuses: [32, 0, 0, 32, 2, 0] };
    const amoonguss = { species: "Amoonguss", item: "Sitrus Berry", ability: "Regenerator", nature: "Relaxed", moves: ["Spore", "Pollen Puff", "Clear Smog", "Protect"], bonuses: [32, 0, 32, 0, 2, 0] };
    const ours = [ampharos, amoonguss].map((set, i) => state(test.ourUnit(makeSet(set), i), 0));
    const foes = [
      member("Garchomp", "Choice Scarf", "Rough Skin", "Timid", ["Dragon Pulse", "Protect"]),
      member("Sneasler", "Focus Sash", "Unburden", "Jolly", ["Fake Tears", "Protect"]),
    ].map((f) => state(test.opponentMon(f), 1));
    const log = [];
    test.turnOne([ours, foes], board(), [false, false], log);
    const drop = log.find((e) => e.kind === "speeddrop");
    check("A Speed drop skips a target it cannot damage", drop && foes[0].spe === 0 && foes[1].spe === -1 && drop.targets.length === 1 && drop.targets[0] === foes[1].u,
      `${drop ? drop.targets.map((t) => t.species).join("+") : "no Speed drop"} | stages ${foes.map((f) => f.spe).join("/")}`);
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
}

// --- the bring size per format, the snapshot, and the spread of results -------------------
const runs = {};
for (const format of ["Doubles", "Singles"]) {
  const test = makeTest(format);
  const started = Date.now();
  let snapshots = 0;
  const s = await test.run(BENCH.map((set) => makeSet(set)), { limit, onSnapshot: () => { snapshots += 1; } });
  runs[format] = { s, seconds: (Date.now() - started) / 1000, values: test.values };
  const size = format === "Singles" ? 3 : 4;
  check(`${format}: snapshot version 2`, s.version === 2);
  check(`${format}: brings ${size}`, s.bring === size && s.bestBrings.every((b) => b.members.length === size) && s.hardest.every((t) => t.bring.length === size && t.against.length === size),
    JSON.stringify(s.bestBrings.map((b) => b.members.length)));
  check(`${format}: leads per side`, s.hardest.every((t) => t.leads === (format === "Singles" ? 1 : 2)));
  check(`${format}: progress after every batch`, snapshots >= Math.floor(limit / 8));
  check(`${format}: values within 0..100`, test.values.every((v) => v >= 0 && v <= 100));
  const deciles = Array(10).fill(0);
  for (const v of test.values) deciles[Math.min(9, Math.floor(v / 10))] += 1;
  check(`${format}: no decile above 40%`, Math.max(...deciles) <= 0.4 * test.values.length, JSON.stringify(deciles));
  check(`${format}: bands add up`, s.bands.favourable + s.bands.even + s.bands.unfavourable === s.tested);
  check(`${format}: threats have an answer`, s.threats.every((t) => t.answer && t.answer.species && t.answer.win >= 0 && t.answer.win <= 1));
  check(`${format}: duel table is 10 x team`, s.duels.rows.length === Math.min(10, s.duels.rows.length) && s.duels.rows.every((row) => row.cells.length === s.ours.length));
  check(`${format}: archetypes cover every team`, s.archetypes.reduce((sum, a) => sum + a.count, 0) === s.tested);
  check(`${format}: snapshot survives a structured clone`, JSON.stringify(structuredClone(s)) === JSON.stringify(s));
  console.log(`${format}: ${s.tested} teams in ${runs[format].seconds.toFixed(1)} s · average ${s.average.toFixed(1)} · favoured ${s.bands.favourable} / even ${s.bands.even} / behind ${s.bands.unfavourable} · deciles ${JSON.stringify(deciles)}`);
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

// --- (i) the results text: "Bring this one", the archetype line, the partner lines -----------
{
  // Just enough DOM for ui.js h(): elements with children and their text.
  class El {
    constructor(tag) { this.tag = tag; this.kids = []; this.style = { setProperty() {} }; this.dataset = {}; }
    setAttribute() {}
    addEventListener() {}
    append(...kids) { this.kids.push(...kids); }
    get textContent() { return this.kids.map((kid) => kid.textContent).join(""); }
  }
  class Txt extends El {
    constructor(text) { super("#text"); this.text = text; }
    get textContent() { return this.text; }
  }
  globalThis.Node = El;
  globalThis.document = { createElement: (tag) => new El(tag), createTextNode: (text) => new Txt(text) };
  const { tournamentAnalysis } = await import("../builder/tournament-view.js");
  const render = (s) => tournamentAnalysis(s, { name: (m) => m.species, sprite: () => new El("img"), running: false }).textContent;

  const full = render(runs.Doubles.s);
  check("Doubles verdict says 'Bring these four'", full.includes("Bring these four"));
  // A lone Pokémon that cannot damage anything: one to bring, the same score against every archetype.
  const lone = await makeTest("Doubles").run([makeSet({ species: "Whimsicott", item: "Focus Sash", ability: "Prankster", nature: "Timid", moves: ["Tailwind", "Encore", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] })], { limit: 80 });
  const loneText = render(lone);
  const known = lone.archetypes.filter((a) => a.name !== "Other" && a.count >= 5);
  const gap = Math.max(...known.map((a) => a.average)) - Math.min(...known.map((a) => a.average));
  check("A one-Pokémon team reads 'Bring this one'", loneText.includes("Bring this one") && !loneText.includes("Bring these"));
  check("No strongest / weakest archetype when the averages are equal", known.length >= 2 && gap < 3 && !loneText.includes("Strongest against"), `${known.length} archetypes, gap ${gap.toFixed(1)}`);

  // The story lines for a partner knocked out by its own side and a Speed drop that also hits the partner.
  const mon = (species) => ({ species, form: species, item: "" });
  const game = runs.Doubles.s.hardest[0];
  const story = [
    { side: "you", kind: "partnerko", actor: mon("Garchomp"), target: mon("Incineroar"), targets: null, own: null, move: "Earthquake", value: "" },
    { side: "them", kind: "speeddrop", actor: mon("Torkoal"), target: null, targets: [mon("Dragapult")], own: [mon("Amoonguss")], move: "Bulldoze", value: "" },
  ];
  const storyText = render({ ...runs.Doubles.s, hardest: [{ ...game, story }] });
  check("Story: a partner knocked out by its own side", storyText.includes("Your Garchomp's Earthquake also hits your own Incineroar and knocks it out."));
  check("Story: a Speed drop that also hits the partner", storyText.includes("Their Torkoal uses Bulldoze: your Dragapult loses Speed, and their own Amoonguss loses Speed too."));
}

console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
