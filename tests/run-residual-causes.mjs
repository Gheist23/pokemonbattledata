// WHY a Pokemon's health moved at the end of a turn (builder/tournament-test.js, play-game.js).
//
// A player reported a line the log could not justify:
//
//     Archaludon used Electro Shot on Gholdengo, 100% -> 22%
//     Gholdengo used Shadow Ball on Pelipper, 100% -> 1%
//     Gholdengo was worn down
//
//     "Investigate Gholdengo was worn down because there was no field condition at all."
//
// They were right that there was no field condition. It was Gholdengo's own LIFE ORB, which is
// not on a board at all. `endOfTurn` settled it into one number and kept no reason, and the page
// then worked the reason out again by asking the board -- which cannot see an item, cannot see
// an Ability, and when two reasons share one number names whichever came first in its list.
//
// So the engine records the reasons now, at the sites that charge them (`chargeWhy`), and this
// is what that has to be true of:
//
//   1. the reported case: a Life Orb is named, and the sentence is not the bare "was worn down";
//   2. a Rocky Helmet and a Rough Skin are named -- the other two reasons no board shows, and
//      the second one killed a Sneasler with nothing on screen to say what had;
//   3. ONE number, EVERY reason: Leftovers and a burn in the same turn says both, in a sentence
//      whose direction matches the health bar;
//   4. a replacement walking into a hazard is named, because `refill` is also where the page
//      settles the turn's health;
//   5. the vocabulary covers the engine: every cause the engine can charge has a sentence;
//   6. IT IS OFF unless the played game asks for it, so the search pays nothing for a record of
//      millions of turns nobody reads;
//   7. `Solver.snapshot` floors health at 1% like every other reader -- a survivor under half a
//      percent was rounded to 0, which both invented a "recovered" line every turn and told the
//      opponent it was already dead;
//   8. AND THE SWEEP, which is the guard that keeps the hole shut: played games end to end, and
//      not one end-of-turn step in any of them may come out as the bare "was worn down" or
//      "recovered". With a floor under how many it has to have seen, because a sweep that found
//      nothing to ask would otherwise report that everything passed.
//
// NOTHING HERE IS PINNED TO A COUNT OR TO A NAMED POKEMON. The sets come from the meta, which is
// rebuilt every morning: measured on 20 Nov 2026, one morning's rebuild took the same 24 games
// from 160 end-of-turn health moves to 128 with no code change at all. Every assertion is a
// floor or a shape, and the ones that need a particular item or Ability force it onto whatever
// the ladder hands back.
//
//   node tests/run-residual-causes.mjs
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
import { TournamentTest, hpPercent } from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";
import { PlayGame, TURN_LIMIT } from "../builder/play-game.js";
// The page's log renders EVERY stream step through this, so it is what the log really says.
import { sentenceFor } from "../builder/play-anim.js";

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
const library = read("data", "builder", "pokemon-sets.json").sets;
const knownRaw = read("data", "builder", "known-teams.json");
const meta = read("data", "builder", `meta-${FORMAT.toLowerCase()}.json`);
const effects = read("data", "builder", "move-effects.json");

const data = new BuilderData(appData);
data.ingestMeta(FORMAT, meta);
const engine = new DamageEngine(appData);
const ev = new TeamEvaluator(data, engine, FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
ev.setMetaRecords(meta.pokemon || []);
const evaluation = new TeamEvaluation(ev);
const known = new KnownTeams(knownRaw);

const freshSolver = () =>
  new Solver(new TournamentTest(evaluation, known, new TeamSuggestions(evaluation), { effects }));

/**
 * Sets off the top of the ladder.
 *
 * By rank and not by name: a Pokemon that has dropped out of the meta has no usage record, and
 * `commonSet` then hands back a set with no item and no moves at all. The report that this file
 * exists for names four Pokemon, and not one of them is depended on here.
 */
const pool = meta.pokemon.slice(0, 40).map((record) => {
  const set = data.commonSet(FORMAT, record.species, record.form);
  return set.moves.length ? makeSet({ ...set, moves: [...set.moves] }) : null;
}).filter(Boolean);
const withSet = (set, changes) =>
  makeSet({ ...set, ...changes, moves: [...(changes.moves || set.moves)] });

/** Four, with the given leads in front and the rest filled off the ladder. */
const team = (leads, offset) => {
  const out = [...leads];
  const taken = new Set(out.map((m) => m.species));
  for (const set of pool.slice(offset)) {
    if (out.length >= 4) break;
    if (taken.has(set.species)) continue;
    taken.add(set.species);
    out.push(set);
  }
  return out;
};

/** A started game, for a check that wants real units rather than a played turn. */
const started = (player, foe, seed) => {
  const solver = freshSolver();
  const game = new PlayGame(solver, data, FORMAT, library);
  game.start({ player, foe, seed });
  return { solver, game };
};

/** One played game, both sides on their best-valued action, handing back every residual step. */
const play = (player, foe, seed, cap = TURN_LIMIT + 2) => {
  const { solver, game } = started(player, foe, seed);
  const out = [];
  let turns = 0;
  while (!game.over() && turns < cap) {
    const options = game.options();
    const ourJoint = game.jointFrom(options, options.map((slot) => slot.actions[0]?.id));
    const foeJoint = [0, 1].map((position) => {
      const list = solver.slotCandidates(game.state, 1, position, { cap: 0 });
      const pick = list.find((a) => !a.wait) || { kind: 0, wait: true };
      return { ...pick, position };
    });
    const record = game.resolve(ourJoint, foeJoint);
    turns += 1;
    const view = game.view();
    const nameOf = (side, tag) => view.sides[side].find((m) => m.tag === tag)?.name || `#${tag}`;
    for (const step of record.stream || []) {
      if (step.kind !== "residual") continue;
      out.push({ turn: turns, step, line: sentenceFor(step, nameOf) });
    }
  }
  return { game, solver, residuals: out, turns };
};

/** The two lines that mean "health moved and the log cannot say why". */
const GENERIC = /was worn down$|recovered$/;
const causesOf = (one) => (one.step.causes || []).map((c) => c.cause);
const saidFor = (cause, hurting = true) => sentenceFor({
  kind: "residual", from: 50, to: hurting ? 40 : 60, cause,
  causes: [{ cause, amount: hurting ? 0.1 : -0.1 }],
}, () => "It");

// ---------------------------------------------------------------------------
// 1. the reported case: a Life Orb is named
// ---------------------------------------------------------------------------
{
  // AT THE OWE SITE FIRST, because that is where the engine has to tell the orb from the move's
  // own recoil: `resultRecoilShare` hands over ONE number for both, and every owe site sits
  // behind a `deal` that returned true -- a landed damaging hit, which is exactly when the orb
  // charges. So the holder's tenth is in that number by construction.
  const t = freshSolver().t;
  t.explainResiduals = true;
  const { game } = started(team([withSet(pool[0], { item: "Life Orb" })], 0), team([], 12), 3);
  const orbed = game.state.active[0][0];
  ok("the forced Life Orb is on the unit", /life ?orb/i.test(String(orbed.u?.mon?.item || "")),
    String(orbed.u?.mon?.item));
  orbed.why = null;
  t.oweSelf(orbed, 0.0927);
  let said = orbed.why || [];
  ok("a Life Orb holder's self cost is recorded as the Life Orb",
    said.length === 1 && said[0].cause === "lifeorb", JSON.stringify(said));
  ok("and charged what the engine actually took, not a flat tenth",
    Math.abs(said[0].amount - 0.0927) < 1e-9, JSON.stringify(said));
  // A move with recoil ON TOP of the orb: the orb's tenth, and the rest is the move's.
  orbed.why = null;
  t.oweSelf(orbed, 0.1 + 0.25);
  said = orbed.why || [];
  ok("an orb AND a recoil are told apart", said.length === 2
    && said.some((one) => one.cause === "lifeorb" && Math.abs(one.amount - 0.1) < 1e-9)
    && said.some((one) => one.cause === "recoil" && Math.abs(one.amount - 0.25) < 1e-9),
    JSON.stringify(said));
  // And with no orb, the whole cost is the move's recoil and is not blamed on an item.
  const { game: plain } = started(team([withSet(pool[0], { item: "Leftovers" })], 0), team([], 12), 3);
  const bare = plain.state.active[0][0];
  bare.why = null;
  t.oweSelf(bare, 0.33);
  said = bare.why || [];
  ok("a holder with no orb is charged recoil, not an orb",
    said.length === 1 && said[0].cause === "recoil", JSON.stringify(said));

  // AND IN A PLAYED GAME, which is the thing the player was looking at.
  let found = null;
  for (let seed = 1; seed <= 14 && !found; seed += 1) {
    const orbs = [withSet(pool[1], { item: "Life Orb" }), withSet(pool[2], { item: "Life Orb" })];
    const { residuals } = play(team(orbs, 6), team([], 14), seed, 5);
    found = residuals.find((one) => causesOf(one).includes("lifeorb"));
  }
  ok("a Life Orb is named in a played game too", Boolean(found),
    "no residual step named one in fourteen games");
  if (found) {
    ok("and the log names it instead of saying 'was worn down'",
      !GENERIC.test(found.line) && /Life Orb/.test(found.line), found.line);
    notes.push(`life orb: "${found.line}"`);
  }
}

// ---------------------------------------------------------------------------
// 2. the other two reasons no board shows: a Rocky Helmet and a Rough Skin
// ---------------------------------------------------------------------------
{
  // Measured on units rather than played out, because what is checked is which HALF of one
  // `contactAnswer` number the engine says it was -- and a Pokemon carrying both is the case a
  // single total cannot report at all.
  const t = freshSolver().t;
  t.explainResiduals = true;
  const unit = (set, seed) => started(team([set], 0), team([], 12), seed).game.state.active[0][0];
  const biter = unit(pool[0], 5);
  const helmeted = unit(withSet(pool[1], { item: "Rocky Helmet" }), 6);
  ok("a Rocky Helmet is in the kit as its own share, beside the total",
    Math.abs((helmeted.k.contactHelmet || 0) - 1 / 6) < 1e-9, String(helmeted.k.contactHelmet));
  const contactSlot = biter.u.moves.findIndex((info) => info?.contact);
  ok("the biter has a contact move for the helmet to answer", contactSlot >= 0,
    JSON.stringify(biter.u.moves.map((info) => [info?.name, Boolean(info?.contact)])));
  if (contactSlot >= 0) {
    const answer = (target) => {
      biter.why = null;
      biter.resid = 0;
      t.answerContact(biter, target, { slot: contactSlot });
      return biter.why || [];
    };
    const helmetOnly = answer(helmeted);
    ok("a Rocky Helmet's answer is named as the helmet",
      helmetOnly.some((one) => one.cause === "helmet"), JSON.stringify(helmetOnly));
    ok("and charged the helmet's own sixth",
      helmetOnly.some((one) => one.cause === "helmet" && Math.abs(one.amount - 1 / 6) < 1e-9),
      JSON.stringify(helmetOnly));
    // Rough Skin's eighth on a Pokemon with no helmet must come out as the Ability.
    const spiky = unit(pool[2], 7);
    spiky.k = { ...spiky.k, contactAnswer: 1 / 8, contactHelmet: 0 };
    const abilityOnly = answer(spiky);
    ok("an Ability's answer is named as the Ability, not as the helmet",
      abilityOnly.some((one) => one.cause === "roughskin")
      && !abilityOnly.some((one) => one.cause === "helmet"), JSON.stringify(abilityOnly));
    // BOTH AT ONCE: a sixth and an eighth, each named, adding up to what was charged.
    const both = unit(pool[3], 8);
    both.k = { ...both.k, contactAnswer: 1 / 6 + 1 / 8, contactHelmet: 1 / 6 };
    const pair = answer(both).filter((one) => one.cause === "helmet" || one.cause === "roughskin");
    ok("a Pokemon carrying both charges both, each its own share", pair.length === 2
      && Math.abs(pair.reduce((sum, one) => sum + one.amount, 0) - (1 / 6 + 1 / 8)) < 1e-9,
      JSON.stringify(pair));
    // A move that is NOT contact answers nothing, which is the rule `answerContact` opens with.
    const nonContact = biter.u.moves.findIndex((info) => info && !info.contact);
    if (nonContact >= 0) {
      biter.why = null;
      biter.resid = 0;
      t.answerContact(biter, helmeted, { slot: nonContact });
      ok("a move that makes no contact is answered by nothing", (biter.why || []).length === 0,
        JSON.stringify(biter.why));
    }
  }
  for (const cause of ["helmet", "roughskin"]) {
    ok(`"${cause}" has a sentence of its own`, !GENERIC.test(saidFor(cause)), saidFor(cause));
  }
}

// ---------------------------------------------------------------------------
// 3. one number, every reason
// ---------------------------------------------------------------------------
{
  // Leftovers and a burn are the pair that used to lie: the old reconstruction asked about the
  // burn first, so a NET HEAL was announced as a burn.
  const line = sentenceFor({
    kind: "residual", from: 50, to: 53, cause: "leftovers",
    causes: [{ cause: "leftovers", amount: -1 / 16 }, { cause: "burn", amount: 1 / 16 }],
  }, () => "Rillaboom");
  ok("a step with two reasons says both", /restored/.test(line) && /burn/.test(line), line);
  ok("and says them in one sentence, not two", (line.match(/Rillaboom/g) || []).length === 1, line);
  notes.push(`two reasons: "${line}"`);
  // A board settled with the recording off still names what the board itself shows.
  const bare = sentenceFor({ kind: "residual", from: 50, to: 44, cause: "Sand", causes: [] },
    () => "Pelipper");
  ok("a board settled without the record still names what the board shows",
    /sandstorm/.test(bare), bare);
  // The same cause charged from two places is ONE entry: a burn can arrive both as a status slot
  // and as the boolean a board was built with, and `baked` is what keeps only one of them
  // firing. `whyOf` merges them before the sentence ever sees them -- and the sentence then
  // deduplicates again by the PHRASE, because two different causes can share one: a poison and
  // a bad poison are both "was hurt by the poison" and the model carries both as shares.
  const twice = sentenceFor({
    kind: "residual", from: 50, to: 44, cause: "burn",
    causes: [{ cause: "burn", amount: 1 / 16 }, { cause: "burn", amount: 1 / 16 }],
  }, () => "Rillaboom");
  ok("one cause twice reads once", (twice.match(/burn/g) || []).length === 1, twice);
  const bothPoisons = sentenceFor({
    kind: "residual", from: 50, to: 38, cause: "psn",
    causes: [{ cause: "psn", amount: 1 / 8 }, { cause: "tox", amount: 1 / 16 }],
  }, () => "Charizard");
  ok("two causes that share a sentence say it once",
    (bothPoisons.match(/poison/g) || []).length === 1, bothPoisons);
}

// ---------------------------------------------------------------------------
// 4. a replacement walking into a hazard
// ---------------------------------------------------------------------------
{
  const t = freshSolver().t;
  t.explainResiduals = true;
  const victim = started(team([pool[0]], 0), team([], 12), 7).game.state.active[0][0];
  // The two words `hazardDamage` passes, which are the words its own `hazardko` event uses.
  for (const what of ["stealth rock", "spikes"]) {
    victim.why = null;
    victim.hp = 1;
    victim.out = false;
    t.hazardDamage(victim, 1 / 8, null, what);
    const said = (victim.why || []).map((one) => one.cause);
    ok(`a ${what} on the way in is recorded`, said.includes(what), JSON.stringify(said));
    ok(`and "${what}" has a sentence of its own`, !GENERIC.test(saidFor(what)), saidFor(what));
  }
  // A hazard that takes nothing records nothing, so an immune arrival says nothing either.
  victim.why = null;
  t.hazardDamage(victim, 0, null, "spikes");
  ok("a hazard that takes nothing is not a reason", (victim.why || []).length === 0,
    JSON.stringify(victim.why));
}

// ---------------------------------------------------------------------------
// 5. the vocabulary covers the engine
// ---------------------------------------------------------------------------
{
  // Read off the ENGINE'S OWN SOURCE, because the list that matters is the one the engine can
  // actually charge, and the next person to add a `chargeWhy` will not think to come here.
  const source = readFileSync(join(root, "builder", "tournament-test.js"), "utf8");
  const charged = new Set();
  for (const match of source.matchAll(/chargeWhy\([^,]+,\s*"([^"]+)"/g)) charged.add(match[1]);
  // The ternary form, which the plain scan above reads only the first arm of.
  for (const match of source.matchAll(/chargeWhy\([^,]+,\s*[^,"]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)) {
    charged.add(match[1]);
    charged.add(match[2]);
  }
  ok("the engine charges a reason under more than a handful of names", charged.size >= 12,
    `${charged.size}: ${[...charged].sort().join(", ")}`);
  const missing = [...charged].filter((cause) => GENERIC.test(saidFor(cause)));
  ok("every cause the engine charges has a sentence", missing.length === 0,
    `no phrase for ${missing.join(", ")}`);
  // The two it charges by VALUE rather than by literal, which no scan of the source can see:
  // `WEATHERS[board.w]` for the weather chip, and `String(what)` for a hazard.
  for (const cause of ["Sand", "Snow", "hazard"]) {
    ok(`the dynamic cause "${cause}" has a sentence`, !GENERIC.test(saidFor(cause)), saidFor(cause));
  }
  // A heal reads as a heal and a hurt as a hurt, which is the direction the health bar moves.
  ok("a heal's sentence is a heal", /restored|healed|ate|drank|drained/.test(saidFor("leftovers", false)),
    saidFor("leftovers", false));
  ok("and a hurt's is a hurt", /hurt|buffeted|pelted|sapped|paid/.test(saidFor("lifeorb")),
    saidFor("lifeorb"));
  notes.push(`vocabulary: ${charged.size} charged names, all said`);
}

// ---------------------------------------------------------------------------
// 6. off unless the played game asks for it
// ---------------------------------------------------------------------------
{
  const t = freshSolver().t;
  ok("the recording is off on a fresh engine", t.explainResiduals === false, String(t.explainResiduals));
  const m = { why: null, hp: 1, k: {}, u: {} };
  t.chargeWhy(m, "lifeorb", 0.1);
  ok("and charges nothing while it is off", m.why === null, JSON.stringify(m.why));
  t.explainResiduals = true;
  t.chargeWhy(m, "lifeorb", 0.1);
  ok("and charges once it is on", Array.isArray(m.why) && m.why.length === 1, JSON.stringify(m.why));
  t.chargeWhy(m, "lifeorb", 0);
  ok("a zero share is not a reason", m.why.length === 1, JSON.stringify(m.why));
  t.chargeWhy(m, "", 0.1);
  ok("and a reason with no name is not one either", m.why.length === 1, JSON.stringify(m.why));

  // And the played game leaves the engine exactly as it found it, like the roll stream beside it.
  const { solver, game } = started(team([pool[0]], 0), team([pool[5]], 12), 9);
  ok("the game's own engine starts with it off", solver.t.explainResiduals === false);
  const options = game.options();
  const record = game.resolve(game.jointFrom(options, options.map((slot) => slot.actions[0]?.id)),
    [0, 1].map((position) => {
      const list = solver.slotCandidates(game.state, 1, position, { cap: 0 });
      const pick = list.find((a) => !a.wait) || { kind: 0, wait: true };
      return { ...pick, position };
    }));
  ok("and it is off again after the turn, so the opponent's search pays nothing",
    solver.t.explainResiduals === false, String(solver.t.explainResiduals));
  ok("while the turn it just played did come back with a stream", Array.isArray(record.stream));
  // A clone carries neither field, so nothing a searched line charges can reach the real game.
  const copy = solver.cloneState(game.state);
  ok("a cloned board carries no record of its own",
    copy.sides.every((side) => side.every((one) => one.why === null && one.paid === null)));
}

// ---------------------------------------------------------------------------
// 7. a survivor under half a percent is not reported dead
// ---------------------------------------------------------------------------
{
  ok("health floors at 1% for anything still standing", hpPercent(0.004) === 1, String(hpPercent(0.004)));
  ok("and only an exact 0 reads 0%", hpPercent(0) === 0 && hpPercent(1e-9) === 1,
    `${hpPercent(0)} / ${hpPercent(1e-9)}`);
  ok("and it is still capped at 100", hpPercent(1.4) === 100, String(hpPercent(1.4)));
  const { solver, game } = started(team([pool[0]], 0), team([pool[6]], 12), 11);
  const clinging = game.state.active[0][0];
  clinging.hp = 0.004;
  const row = solver.snapshot(game.state)[0].find((one) => one.tag === clinging.tag);
  // THE SNAPSHOT IS READ TWICE: it is the log's `before`, and it is the board the opponent
  // searches. Rounded, this row said 0% of a Pokemon that was still attacking -- which both
  // invented a "recovered" line every turn and told the opponent it was already dead.
  ok("Solver.snapshot floors it too", row.hp === 1, JSON.stringify(row));
  ok("and still says it has not fainted", row.out === false, JSON.stringify(row));
  clinging.hp = 0;
  clinging.out = true;
  const dead = solver.snapshot(game.state)[0].find((one) => one.tag === clinging.tag);
  ok("while a real faint still reads 0%", dead.hp === 0 && dead.out === true, JSON.stringify(dead));
}

// ---------------------------------------------------------------------------
// 8. the sweep: no played turn ends with a line the log cannot justify
// ---------------------------------------------------------------------------
{
  let seen = 0;
  const generic = [];
  const causes = new Map();
  for (let run = 0; run < 24; run += 1) {
    const a = [0, 1, 2, 3].map((i) => pool[(run * 7 + i * 3) % pool.length]);
    const b = [0, 1, 2, 3].map((i) => pool[(run * 11 + i * 5 + 1) % pool.length]);
    if (new Set([...a, ...b].map((m) => m.species)).size < 8) continue;
    for (const one of play(a, b, 100 + run).residuals) {
      seen += 1;
      for (const cause of causesOf(one)) causes.set(cause, (causes.get(cause) || 0) + 1);
      if (GENERIC.test(one.line)) {
        generic.push(`run ${run} turn ${one.turn}: "${one.line}" ${one.step.from}% -> ${one.step.to}%`);
      }
    }
  }
  // THE FLOOR IS THE POINT. Without it a sweep that reached no end-of-turn health at all would
  // report that every one of them had been explained. A floor and not a count, because the meta
  // is rebuilt every morning and the same 24 games are not the same 24 games tomorrow.
  ok("the sweep saw enough end-of-turn health to be asking anything", seen >= 60, String(seen));
  ok("and more than a couple of different reasons for it", causes.size >= 5,
    [...causes.keys()].join(", "));
  ok("and not one line the log could not justify", generic.length === 0,
    `${generic.length} of ${seen}\n  ${generic.slice(0, 6).join("\n  ")}`);
  notes.push(`sweep: ${seen} end-of-turn health moves, ${causes.size} reasons, ${generic.length} unexplained`);
  notes.push(`reasons: ${[...causes.entries()].sort((x, y) => y[1] - x[1]).map(([c, n]) => `${c} x${n}`).join(", ")}`);
}

// ---------------------------------------------------------------------------
console.log(notes.map((line) => `  ${line}`).join("\n"));
if (failures.length) {
  console.error(`\nFAILED ${failures.length} of ${checked}:\n` + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`\nall ${checked} checks passed`);
