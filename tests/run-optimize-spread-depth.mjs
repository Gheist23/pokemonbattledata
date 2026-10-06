// Checks Optimize's spread rule (builder/optimize-spread-depth.js, OPTIMIZE_SPREAD_DEPTH):
//
//  1. the stamp itself: `undefined` keeps the default, 0 / null / false / "off" switch the
//     rule off, and the worker really threads it as `options.optimizeSpreadDepth`;
//  2. A, the support-Nature test: a support Pokemon may be tried on a Nature that raises the
//     category its own attacks use, and may not be tried on one that raises a category it
//     never uses. Its own Nature is never dropped. Run end to end, a support set whose
//     attacks are physical is now offered an Attack-raising Nature - as the suggestion when the
//     margins allow it, on the trade-off card when they do not - and it scores better for it,
//     and with the rule off it still gets the old answer (so the check can fail);
//  3. B, the trade-off gate: a better-scoring spread the margins held back is shown once it
//     clears the same MARGINS.minimum the suggestion clears, where before it had to clear a
//     whole point; and with the rule off nothing under a point is shown;
//  4. B, the card: when nothing is suggested the card opens with that spread and what it
//     costs, in plain English, instead of "no change did clearly better" - and a result from
//     before the rule still opens with the old sentence;
//  5. C, the starts: "just enough Speed" spreads are built on every start and read in the two
//     speed contexts the score weighs most, capped at SPEED_START_CAP; with the rule off they
//     are exactly what the old code made, spread for spread, so a recording replays;
//  6. the same run twice gives the same answer.
//
//   node tests/run-optimize-spread-depth.mjs
//
// OPTIMIZE_SPREAD_DEPTH=0 / =1 replays the end-to-end cases at that stamp: the suite then
// asserts the behaviour of the stamp it names (both sides are run either way, since each
// check is proved against the other one).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine, MAX_BONUS_POINTS_PER_STAT } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamOptimizer } from "../builder/team-optimize.js";
import { makeSet } from "../builder/common.js";
import { OptimizeObjective } from "../builder/optimize-objective.js";
import { fillPoints, natureIndices, pointTotal, pointsKey, withSpeedPoints } from "../builder/optimize-core.js";
import { DeepOptimizer, MARGINS } from "../builder/optimize-deep.js";
import { OPTIMIZE_SPREAD_DEPTH, SPEED_CONTEXTS, SPEED_START_CAP, speedContexts, spreadDepthOption, supportNatures } from "../builder/optimize-spread-depth.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const meta = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));
const engine = new DamageEngine(appData);
const TOP = 30;
const ev = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: TOP }, 1000));
ev.setMetaRecords(meta.pokemon);
const evaluation = new TeamEvaluation(ev);

/** The stamp the end-to-end cases are replayed at (the module's own version by default). */
const STAMP = process.env.OPTIMIZE_SPREAD_DEPTH === undefined
  ? OPTIMIZE_SPREAD_DEPTH
  : spreadDepthOption(process.env.OPTIMIZE_SPREAD_DEPTH);

const TEAMS = {
  // A support Pokemon whose own attacks are both physical (the case A is about), beside a
  // Tailwind setter, so the board has more than one speed context for C.
  sun: [
    { species: "Charizard", form: "Mega Charizard Y", item: "Charizardite Y", ability: "Drought", nature: "Timid", moves: ["Heat Wave", "Weather Ball", "Solar Beam", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Venusaur", item: "Focus Sash", ability: "Chlorophyll", nature: "Modest", moves: ["Energy Ball", "Sludge Bomb", "Sleep Powder", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Incineroar", item: "Sitrus Berry", ability: "Intimidate", nature: "Careful", moves: ["Fake Out", "Parting Shot", "Flare Blitz", "Knock Off"], bonuses: [32, 0, 2, 0, 32, 0] },
    { species: "Garchomp", item: "Life Orb", ability: "Rough Skin", nature: "Jolly", moves: ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], bonuses: [2, 32, 0, 0, 0, 32] },
    { species: "Whimsicott", item: "Focus Sash", ability: "Prankster", nature: "Timid", moves: ["Tailwind", "Moonblast", "Encore", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Gholdengo", item: "Choice Specs", ability: "Good as Gold", nature: "Modest", moves: ["Make It Rain", "Shadow Ball", "Focus Blast", "Thunderbolt"], bonuses: [2, 0, 0, 32, 0, 32] },
  ],
  rough: [
    { species: "Garchomp", item: "Life Orb", ability: "Rough Skin", nature: "Bold", moves: ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], bonuses: [10, 10, 10, 10, 10, 10] },
    { species: "Kingambit", item: "Black Glasses", ability: "Supreme Overlord", nature: "Modest", moves: ["Sucker Punch", "Kowtow Cleave", "Iron Head", "Protect"], bonuses: [0, 0, 0, 0, 0, 0] },
    { species: "Rillaboom", item: "Assault Vest", ability: "Grassy Surge", nature: "Adamant", moves: ["Fake Out", "Grassy Glide", "Wood Hammer", "U-turn"], bonuses: [32, 32, 0, 0, 0, 2] },
  ],
  // A Trick Room team: there the Speed starts are one spread with no Speed at all, either way.
  tr: [
    { species: "Hatterene", item: "Life Orb", ability: "Magic Bounce", nature: "Quiet", moves: ["Dazzling Gleam", "Trick Room", "Expanding Force", "Protect"], bonuses: [32, 0, 2, 32, 0, 0] },
    { species: "Torkoal", item: "Charcoal", ability: "Drought", nature: "Timid", moves: ["Eruption", "Heat Wave", "Earth Power", "Protect"], bonuses: [2, 0, 0, 32, 0, 32] },
    { species: "Farigiraf", item: "Sitrus Berry", ability: "Armor Tail", nature: "Bold", moves: ["Trick Room", "Helping Hand", "Psychic", "Thunderbolt"], bonuses: [32, 0, 32, 0, 2, 0] },
    { species: "Incineroar", item: "Safety Goggles", ability: "Intimidate", nature: "Careful", moves: ["Fake Out", "Parting Shot", "Flare Blitz", "Knock Off"], bonuses: [32, 0, 2, 0, 32, 0] },
  ],
};
const teamSets = (name) => {
  const list = TEAMS[name].map((s) => makeSet(s));
  while (list.length < 6) list.push(null);
  return list;
};

const failures = [];
let checks = 0;
const check = (ok, message) => {
  checks += 1;
  if (!ok) failures.push(message);
};
const upOf = (name) => natureIndices(engine.natures, name)[0];
const raises = (name, stat) => upOf(name) === stat;

// --- 1. the stamp ---------------------------------------------------------------------------
{
  check(OPTIMIZE_SPREAD_DEPTH === 1, `the rule version should be 1, it is ${OPTIMIZE_SPREAD_DEPTH}`);
  check(spreadDepthOption(undefined) === OPTIMIZE_SPREAD_DEPTH, "undefined should keep the default");
  for (const off of [0, null, false, "off", "Off", "false", "no", "none", "0", -1]) {
    check(spreadDepthOption(off) === 0, `${JSON.stringify(off)} should switch the rule off, it gave ${spreadDepthOption(off)}`);
  }
  check(spreadDepthOption("") === OPTIMIZE_SPREAD_DEPTH, "an empty string should keep the default");
  check(spreadDepthOption("1") === 1 && spreadDepthOption(2) === 2 && spreadDepthOption("2") === 2, "a version number should select that version");
  check(spreadDepthOption("nonsense") === OPTIMIZE_SPREAD_DEPTH, "a word that is not a version should keep the default");
  // The worker is what production runs: the option has to reach the search from there.
  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  check(/optimizeSpreadDepth:\s*OPTIMIZE_SPREAD_DEPTH/.test(worker), "builder/analysis-worker.js does not thread optimizeSpreadDepth into the Optimize run");
  console.log(`1. the stamp: version ${OPTIMIZE_SPREAD_DEPTH}, off for 0/null/false/"off", threaded by the worker (replaying at ${STAMP})`);
}

// --- 2. A, the support-Nature test (the rule on its own) --------------------------------------
{
  const natures = Object.keys(engine.natures);
  const physicalUp = natures.filter((n) => raises(n, 1));
  const specialUp = natures.filter((n) => raises(n, 3));
  check(physicalUp.length > 0 && specialUp.length > 0, "data: no Nature raises Attack or Sp. Attack any more");
  // The blanket rule this replaces, as it was: every Attack / Sp. Attack Nature deleted.
  const blanket = (list, current) => (![1, 3].includes(upOf(current)) ? list.filter((n) => ![1, 3].includes(upOf(n))) : list);
  const list = ["Careful", ...physicalUp.slice(0, 2), ...specialUp.slice(0, 2), "Impish"];
  const physicalSet = supportNatures(list, { current: "Careful", indexOf: upOf, physical: true, special: false });
  const specialSet = supportNatures(list, { current: "Careful", indexOf: upOf, physical: false, special: true });
  const noAttacks = supportNatures(list, { current: "Careful", indexOf: upOf, physical: false, special: false });
  for (const name of physicalUp.slice(0, 2)) {
    check(physicalSet.includes(name), `A: ${name} raises Attack and the set attacks physically, so it must be testable`);
    check(!specialSet.includes(name), `A: ${name} raises Attack but the set never attacks physically, so it must be dropped`);
    check(!noAttacks.includes(name), `A: ${name} raises Attack for a set with no attacks at all, so it must be dropped`);
    // Without this the check above would hold for the wrong reason: the old rule dropped it too.
    check(!blanket(list, "Careful").includes(name), `A: the blanket rule already kept ${name}, so the new rule cannot be told apart from it`);
  }
  for (const name of specialUp.slice(0, 2)) {
    check(specialSet.includes(name), `A: ${name} raises Sp. Attack and the set attacks specially, so it must be testable`);
    check(!physicalSet.includes(name), `A: ${name} raises Sp. Attack but the set never attacks specially, so it must be dropped`);
  }
  check(physicalSet.includes("Impish") && specialSet.includes("Impish"), "A: a Nature that raises neither attack stat is never dropped");
  // The set's own Nature always stays, even when it raises a category the set never uses.
  const own = supportNatures([physicalUp[0], "Careful"], { current: physicalUp[0], indexOf: upOf, physical: false, special: false });
  check(own.includes(physicalUp[0]), `A: the set's own Nature ${physicalUp[0]} was dropped`);
  console.log(`2. A: +Attack kept for a physical support set (${physicalUp.slice(0, 2).join(", ")}), dropped for a special one, own Nature always kept`);
}

// --- the runs -------------------------------------------------------------------------------
const quick = { depth: "quick", topX: TOP };
const runAt = (team, slot, rule, extra = {}) => new DeepOptimizer(evaluation).run(teamSets(team), slot, { ...quick, ...extra, optimizeSpreadDepth: rule }, {});
/** A second, independent objective over the same team: the score a result really applies. */
const scorerFor = (team, slot) => {
  const objective = new OptimizeObjective(new TeamOptimizer(evaluation), teamSets(team), slot, { topX: TOP });
  return (nature, bonuses, moves) => objective.score(nature, bonuses, objective.moveSet((moves || []).filter(Boolean)), { rows: objective.rows });
};

// --- 3. A end to end: the support set is offered the Nature its attacks want -------------------
{
  // Optimize has exactly two ways to put a spread in front of the player: the suggestion, and
  // the trade-off card's "Use this instead" button. Under this rule both clear the same
  // MARGINS.minimum (that is part B), and with the rule off neither can ever carry a Nature
  // that raises an attack stat for a support set, because such a Nature is never scored at all.
  // So "offered" is both of them together.
  const offers = (result) => {
    const out = [{ nature: result.after.nature, bonuses: result.after.bonuses, moves: result.after.moves, via: result.ok ? "the suggestion" : "no change" }];
    if (result.trade_off) out.push({ nature: result.trade_off.nature, bonuses: result.trade_off.bonuses, moves: result.trade_off.moves, via: "the trade-off card" });
    return out;
  };
  // The case is chosen by what it can demonstrate, not by a Pokemon typed in here: a member is
  // a candidate when it is read as a support Pokemon and its own attacks are physical with none
  // special, which is what makes an Attack-raising Nature legitimate and a +Sp. Attack one still
  // forbidden. Pinning this to the sun team's Incineroar is what made the suite go red the
  // morning the meta data was rebuilt: the rule still reaches Adamant and still offers it, but
  // Adamant's edge over its own Careful fell from +1.04 to +0.89 and the margins - the same ones
  // part B is about - now hold it back from being the suggestion rather than the trade-off.
  const categories = (set) => {
    const of = (name) => (set.moves || []).filter((m) => engine.moveRecord(m) && String(engine.moveRecord(m).category || "").toLowerCase() === name);
    return { physical: of("physical"), special: of("special") };
  };
  const candidates = [];
  // The first candidate that demonstrates the rule is the case; the rest are only run when it
  // does not, so the failure can name the whole pool.
  scan: for (const team of Object.keys(TEAMS)) {
    for (let slot = 0; slot < TEAMS[team].length; slot += 1) {
      const set = teamSets(team)[slot];
      const { physical, special } = categories(set);
      if (!physical.length || special.length) continue;
      const off = await runAt(team, slot, 0);
      if (off.stats?.support !== true) continue;
      const on = await runAt(team, slot, 1);
      const score = scorerFor(team, slot);
      const scored = (offer) => ({ ...offer, score: score(offer.nature, offer.bonuses, offer.moves) });
      const offOffers = offers(off).map(scored);
      const onOffers = offers(on).map(scored);
      candidates.push({
        team, slot, set, off, on, score, offOffers, onOffers,
        best: Math.max(...offOffers.map((o) => o.score)),
        attack: onOffers.filter((o) => raises(o.nature, 1)).sort((a, b) => b.score - a.score)[0] || null,
      });
      if (candidates[candidates.length - 1].attack) break scan;
    }
  }
  const shown = (list) => list.map((o) => `${o.nature} ${o.bonuses.join("/")} ${o.score.toFixed(3)} (${o.via})`).join(" / ");
  check(candidates.length > 0, "A end to end: no member is read as a support Pokemon whose own attacks are all physical - pick another member, this section cannot fail");
  // The one that demonstrates the rule; without one the suite says so and names the whole pool.
  const picked = candidates.find((c) => c.attack) || candidates[0];
  if (picked) {
    const { team, slot, set, off, on, score, best, attack } = picked;
    const label = `A end to end ${team}/${slot} ${set.species}`;
    check(Boolean(attack), `${label}: with the rule on no support member is offered an Attack-raising Nature, which is the whole point of A - ${candidates.map((c) => `${c.team}/${c.slot} ${c.set.species} off [${shown(c.offOffers)}] on [${shown(c.onOffers)}]`).join("; ")}`);
    // With the rule off the blanket filter is still blanket, so the check above can fail.
    for (const offer of picked.offOffers) {
      check(!raises(offer.nature, 1) && !raises(offer.nature, 3), `${label}: with the rule off ${offer.via} is already on ${offer.nature}, which raises an attack stat - the check above would hold for the wrong reason`);
    }
    // A set that never attacks specially is still never offered a +Sp. Attack Nature.
    for (const offer of picked.onOffers) {
      check(!raises(offer.nature, 3), `${label}: ${offer.via} is on ${offer.nature}, which raises Sp. Attack for a set whose attacks are all physical`);
    }
    if (attack) check(attack.score > best + 0.2, `${label}: the rule should score clearly better, ${best.toFixed(3)} -> ${attack.score.toFixed(3)}`);
    check(on.stats.optimize_spread_depth === 1 && off.stats.optimize_spread_depth === 0, `${label}: the result does not carry the stamp it ran at (${on.stats.optimize_spread_depth} / ${off.stats.optimize_spread_depth})`);
    // Whichever stamp this replay names is what a run with no option of its own must do.
    const production = await runAt(team, slot, STAMP);
    const want = STAMP ? on : off;
    check(production.after.nature === want.after.nature && pointsKey(production.after.bonuses) === pointsKey(want.after.bonuses),
      `${label}: replayed at stamp ${STAMP} it gave ${production.after.nature} ${production.after.bonuses.join("/")}, the stamp says ${want.after.nature} ${want.after.bonuses.join("/")}`);
    const offScore = score(off.after.nature, off.after.bonuses, off.after.moves);
    console.log(`3. A end to end: ${candidates.length} support candidate(s), ${team}/${slot} ${set.species} ${off.after.nature} ${off.after.bonuses.join("/")} (${offScore.toFixed(2)}) -> ${attack ? `${attack.nature} ${attack.bonuses.join("/")} (${attack.score.toFixed(2)}) as ${attack.via}` : "nothing with an Attack-raising Nature"}`);
  }
}

// --- 4. B, the trade-off gate -----------------------------------------------------------------
const cards = [];
{
  const jobs = [["sun", 0], ["sun", 3], ["sun", 4], ["sun", 5], ["rough", 0]];
  let lowered = 0;
  for (const [team, slot] of jobs) {
    const off = await runAt(team, slot, 0);
    const on = await runAt(team, slot, 1);
    const name = `${team}/${slot} ${teamSets(team)[slot].species}`;
    // The gate against the suggestion never moved: both stamps still clear MARGINS.minimum.
    for (const [rule, result] of [[0, off], [1, on]]) {
      const trade = result.trade_off;
      if (!trade) continue;
      check(trade.over_pick >= MARGINS.minimum - 1e-9, `B ${name} (rule ${rule}): a trade-off only ${trade.over_pick.toFixed(2)} over the suggestion is shown`);
      check(pointTotal(trade.bonuses) <= 66 && trade.bonuses.every((v) => v >= 0 && v <= MAX_BONUS_POINTS_PER_STAT), `B ${name} (rule ${rule}): the trade-off spread is not legal: ${trade.bonuses}`);
      check(Number.isFinite(trade.speed_lost) && trade.speed_lost >= 0, `B ${name} (rule ${rule}): the trade-off does not say how much of the Speed list it gives up (${trade.speed_lost})`);
    }
    // The gate against the current set: a whole point before the rule, MARGINS.minimum with it.
    if (off.trade_off) check(off.trade_off.delta >= 1 - 1e-9, `B ${name}: with the rule off a trade-off worth only ${off.trade_off.delta.toFixed(2)} is shown; the old gate was a whole point`);
    if (on.trade_off) check(on.trade_off.delta >= MARGINS.minimum - 1e-9, `B ${name}: a trade-off worth only ${on.trade_off.delta.toFixed(2)} is shown, under the same bar the suggestion clears`);
    // A run that shows a better spread may not also say the set plays these matchups best.
    const best = /already plays these matchups best/;
    if (!off.ok) check(best.test(off.message || ""), `B ${name}: with the rule off the sentence for a run with nothing to suggest changed: "${off.message}"`);
    if (!on.ok && on.trade_off) {
      check(/so nothing is suggested/.test(on.message || "") && !best.test(on.message || ""), `B ${name}: a run showing a spread worth ${on.trade_off.delta.toFixed(2)} more still says the set plays these matchups best: "${on.message}"`);
    }
    if (!on.ok && !on.trade_off) check(best.test(on.message || ""), `B ${name}: with nothing better found at all the sentence should stay as it was: "${on.message}"`);
    if (on.trade_off && !off.trade_off && on.trade_off.delta < 1) {
      lowered += 1;
      console.log(`   ${name.padEnd(24)} now shows ${on.trade_off.nature} ${on.trade_off.bonuses.join("/")} (${on.trade_off.delta.toFixed(2)}), which the old gate hid`);
    }
    if (!on.ok && on.trade_off) cards.push({ team, slot, result: on });
  }
  check(lowered > 0, "B: no member has a better spread worth between MARGINS.minimum and a whole point, so the lowered gate cannot be told from the old one - pick another team");
  check(cards.length > 0, "B: no member ends with nothing suggested and a trade-off, so the card below cannot be drawn - pick another team");
  console.log(`4. B: ${lowered} member(s) show a spread the whole-point gate hid; every trade-off still clears the suggestion by MARGINS.minimum`);
}

// --- 5. B, the card ---------------------------------------------------------------------------
{
  // Just enough DOM for ui.js h() and the Optimize card.
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.kids = [];
      this.attrs = {};
      this.listeners = {};
      this.dataset = {};
      this.style = { setProperty() {} };
      this.className = "";
    }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    append(...kids) { for (const kid of kids) this.kids.push(kid); }
    set innerHTML(value) { this.kids = [new Txt(String(value))]; }
    get classes() { return String(this.className || "").split(" ").filter(Boolean); }
    get classList() {
      const el = this;
      return {
        add: (name) => { el.className = [...new Set([...el.classes, name])].join(" "); },
        remove: (name) => { el.className = el.classes.filter((c) => c !== name).join(" "); },
        contains: (name) => el.classes.includes(name),
      };
    }
    replaceChildren(...kids) { this.kids = [...kids]; }
    get textContent() { return this.kids.map((kid) => kid.textContent).join(""); }
  }
  class Txt extends El {
    constructor(text) { super("#text"); this.text = text; }
    get textContent() { return this.text; }
  }
  globalThis.Node = El;
  globalThis.document = { createElement: (tag) => new El(tag), createTextNode: (text) => new Txt(text) };
  const { optimizeView, OPTIMIZE_DEFAULTS } = await import("../builder/optimize-view.js");
  const noop = () => {};
  const cardFor = (set, result) => optimizeView({
    members: [{ slot: 0, name: set.species, sprite: "", set, state: { result }, kept: new Set() }],
    options: { ...OPTIMIZE_DEFAULTS, depth: "quick" }, topX: TOP, spriteFor: () => "",
    onOptions: noop, onRun: noop, onStop: noop, onApply: noop, onDiscard: noop, onKeepMove: noop,
  });
  const textOf = (set, result) => cardFor(set, result).textContent;
  /** The text of one block of the card (the answer it opens with). */
  const blockText = (set, result, cls) => {
    const out = [];
    const walk = (node) => {
      for (const kid of node.kids || []) {
        if (String(kid.className || "").split(" ").includes(cls)) out.push(kid);
        walk(kid);
      }
    };
    walk(cardFor(set, result));
    return out.map((node) => node.textContent).join(" ");
  };

  const { team, slot, result } = cards[0];
  const set = teamSets(team)[slot];
  const flat = "already plays these matchups best";
  const held = "so nothing is suggested";
  const lead = `A spread scores ${result.trade_off.delta > 0 ? "+" : "−"}${Math.abs(result.trade_off.delta).toFixed(1)}`;
  const withRule = textOf(set, result);
  const answer = blockText(set, result, "bd-opt-trade-lead");
  check(answer.includes(lead), `card: the card does not open with the spread that scores better ("${lead}"): ${answer.slice(0, 260)}`);
  check(answer.includes("It costs you "), "card: the card does not say what taking that spread costs");
  // Every cost is named, except the Nature, which the sentence has already printed by then.
  for (const reason of result.trade_off.reasons) {
    const named = reason.startsWith(result.trade_off.nature_text) ? answer.includes(result.trade_off.nature_text) : answer.includes(reason);
    check(named, `card: the answer leaves out the cost "${reason}"`);
  }
  check(answer.split(result.trade_off.nature_text).length - 1 === 1, `card: the answer names ${result.trade_off.nature_text} ${answer.split(result.trade_off.nature_text).length - 1} times, once is enough: "${answer}"`);
  // A better spread exists, so the card may not also claim the set plays these matchups best.
  check(!withRule.includes(flat), `card: the card says the set "${flat}" although it shows a spread that scores ${result.trade_off.delta.toFixed(2)} more`);
  check(withRule.includes(held), `card: the card does not say why that spread is not suggested: ${withRule.slice(0, 300)}`);
  check(withRule.indexOf(lead) < withRule.indexOf(held), "card: the answer has to come before the sentence about the current set, not after it");
  // A result from before the rule keeps the card it was written for.
  const older = { ...result, stats: { ...result.stats, optimize_spread_depth: 0 } };
  const withoutRule = textOf(set, older);
  check(!withoutRule.includes(lead), "card: a result from before the rule should still open with the flat sentence; the check above would hold for the wrong reason");
  // A suggestion is unchanged: the answer only leads when there is nothing to suggest.
  const suggested = { ...result, ok: true };
  check(!textOf(set, suggested).includes(lead), "card: a run that does suggest something should not open with the trade-off");
  console.log(`5. B card: "${withRule.slice(withRule.indexOf(lead), withRule.indexOf(lead) + 150)}"`);
}

// --- 6. C, the starts -------------------------------------------------------------------------
{
  const optimizer = new DeepOptimizer(evaluation);
  /** The old speedStarts, exactly as it read before the rule: one base spread, normal play. */
  const before = (nature, currentPoints, objective, limit) => {
    if (objective.speedMode === "trickroom") return [withSpeedPoints(fillPoints(currentPoints), 0)];
    const speeds = [];
    for (let sp = 0; sp <= MAX_BONUS_POINTS_PER_STAT; sp += 1) {
      const points = [...currentPoints];
      points[5] = sp;
      speeds.push(Math.trunc(engine.effectiveSpeed(objective.mon(nature, points), {})) || 1);
    }
    const targets = new Map();
    for (const row of objective.workingRows) {
      const theirs = row.speeds[0];
      if (theirs < speeds[0] || theirs >= speeds[MAX_BONUS_POINTS_PER_STAT]) continue;
      targets.set(theirs, (targets.get(theirs) || 0) + row.weight);
    }
    const out = [];
    for (const [theirs] of [...targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
      const sp = speeds.findIndex((s) => s > theirs);
      if (sp >= 0) out.push(withSpeedPoints(fillPoints(currentPoints), sp));
    }
    return out;
  };
  let wider = 0;
  for (const [team, slot, natures] of [["sun", 2, ["Careful", "Adamant"]], ["sun", 3, ["Jolly", "Impish"]], ["rough", 0, ["Bold"]], ["tr", 1, ["Timid"]]]) {
    const sets = teamSets(team);
    const set = sets[slot];
    const objective = new OptimizeObjective(new TeamOptimizer(evaluation), sets, slot, { topX: TOP });
    const bases = optimizer.starts(set, set.bonuses, { usage: 5, templates: 7 });
    const name = `${team}/${slot} ${set.species}`;
    const heaviest = speedContexts(objective.contexts);
    check(heaviest.length === Math.min(SPEED_CONTEXTS, objective.contexts.length), `C ${name}: ${heaviest.length} speed contexts read, ${Math.min(SPEED_CONTEXTS, objective.contexts.length)} expected`);
    check(heaviest.every((c, i) => i === 0 || c.weight <= heaviest[i - 1].weight + 1e-9), `C ${name}: the contexts are not the heaviest ones (${heaviest.map((c) => `${objective.contexts[c.index].label} ${c.weight}`).join(", ")})`);
    for (const nature of natures) {
      const off = optimizer.speedStarts(nature, set.bonuses, objective, 8, { rule: 0, bases });
      const old = before(nature, set.bonuses, objective, 8);
      check(JSON.stringify(off) === JSON.stringify(old), `C ${name} ${nature}: with the rule off the starts changed - a recording would not replay.\n    was ${JSON.stringify(old)}\n    now ${JSON.stringify(off)}`);
      const on = optimizer.speedStarts(nature, set.bonuses, objective, 8, { rule: 1, bases });
      check(on.length <= SPEED_START_CAP, `C ${name} ${nature}: ${on.length} starts, more than the cap of ${SPEED_START_CAP}`);
      check(new Set(on.map(pointsKey)).size === on.length, `C ${name} ${nature}: the same start twice`);
      for (const points of on) {
        check(points.every((v) => Number.isInteger(v) && v >= 0 && v <= MAX_BONUS_POINTS_PER_STAT) && pointTotal(points) <= 66, `C ${name} ${nature}: an illegal start ${points}`);
      }
      if (objective.speedMode === "trickroom") {
        check(JSON.stringify(on) === JSON.stringify(off), `C ${name} ${nature}: a Trick Room team still gets its one no-Speed start either way`);
      } else {
        // The point of the change: a start built on another spread than the player's own.
        // Setting the Speed points rebalances the rest, so "its own" is every spread the own
        // base can reach at any Speed count - anything outside that came from another start.
        const fromOwn = new Set();
        for (let sp = 0; sp <= MAX_BONUS_POINTS_PER_STAT; sp += 1) fromOwn.add(pointsKey(withSpeedPoints(fillPoints(set.bonuses), sp)));
        for (const points of off) check(fromOwn.has(pointsKey(points)), `C ${name} ${nature}: with the rule off a start comes from somewhere other than the set's own spread: ${points}`);
        if (on.some((points) => !fromOwn.has(pointsKey(points)))) wider += 1;
        check(on.length >= off.length, `C ${name} ${nature}: the rule made fewer starts (${on.length}) than before it (${off.length})`);
      }
    }
  }
  check(wider > 0, "C: no member got a Speed start built on anything but its own spread, so the change cannot be told apart - pick another case");
  console.log(`6. C: the starts are unchanged with the rule off, capped at ${SPEED_START_CAP} with it on, and ${wider} case(s) now seed one from another spread`);
}

// --- 7. the same run twice --------------------------------------------------------------------
{
  const plain = (r) => JSON.stringify({ after: r.after, delta: r.delta, trade_off: r.trade_off, ok: r.ok });
  const again = async () => {
    const e = new TeamEvaluator(null, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: TOP }, 1000));
    e.setMetaRecords(meta.pokemon);
    return new DeepOptimizer(new TeamEvaluation(e)).run(teamSets("sun"), 2, { ...quick, optimizeSpreadDepth: STAMP }, {});
  };
  const [a, b] = [await again(), await again()];
  check(plain(a) === plain(b), `7. the same run twice gave different results at stamp ${STAMP}`);
  console.log(`7. the same run twice gives the same answer at stamp ${STAMP}`);
}

for (const failure of failures.slice(0, 40)) console.log(`FAIL ${failure}`);
console.log(`\n${checks} checked, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
