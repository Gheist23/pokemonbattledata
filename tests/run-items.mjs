// SIX HELD ITEMS THE ENGINE HAD NEVER HEARD OF.
//
// `tests/run-item-coverage.mjs` is the audit that found them: every item on a current meta set,
// against the whole vocabulary of builder/*.js. Six were named NOWHERE, and the Companion
// (`pokemon_champions_tool/mcts/engine.py`) models all six -- so this is drift in one direction
// and the numbers below are the Companion's, not numbers invented here.
//
//   Wide Lens                    the user's accuracy x 1.1        64.1% of Maushold-Four
//   Bright Powder / Lax Incense  the attacker's accuracy x 0.9    47.7% of Glaceon
//   King's Rock / Razor Fang     a tenth of a flinch, as a FLOOR  18.5% of Maushold-Four
//   Big Root                     a draining move gives back 1.3x  16.2% of Vileplume
//   Focus Band                   one hit in ten survived on 1 HP   9.4% of Stunfisk
//   Shell Bell                   an eighth of the damage dealt     6.7% of Tauros-Paldea-Combat
//
// The three that are easy to get wrong are tested hardest:
//
//   * KING'S ROCK IS A FLOOR AND NOT A SUM. A move that already flinches 30% of the time still
//     flinches 30% of the time; a move with no flinch at all gets a tenth. Accumulating the two
//     would make 0.3 into 0.37, which is what every other `flinchP` writer in the engine does,
//     and is wrong here.
//   * IT ALSO HAS TO REACH A MOVE WITH NO REGISTRY OPS, which is most moves. `secondaries`
//     returns early for those, so the item cannot live inside it.
//   * FOCUS BAND IS NOT THE FOCUS SASH. The Sash works only from full health and is certain;
//     the Band works from any health and is one time in ten.
//
//   node tests/run-items.mjs
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
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const near = (label, got, want, tol, detail = "") =>
  ok(label, Math.abs(got - want) <= tol, `${got} vs ${want} +-${tol}${detail ? ` (${detail})` : ""}`);

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

const set = (species, item, ability, nature, moves, bonuses) => ({
  species, form: species, item, ability, nature, moves, bonuses: [...bonuses],
});
const row = (s, extra = {}) => ({ set: s, hp: 100, front: false, ...extra });
const boardOf = (ours, theirs, field = {}) => ({ sides: [ours, theirs], field });

/** Stone Edge is 80% accurate, which makes an accuracy multiplier readable. */
const SHAKY = (item) => set("Garchomp", item, "Rough Skin", "Adamant",
  ["Stone Edge", "Earthquake", "Dragon Claw", "Protect"], [2, 32, 0, 0, 0, 32]);
/** Giga Drain, for Big Root; Sludge Bomb for a 30% secondary beside King's Rock. */
const DRAINER = (item) => set("Vileplume", item, "Effect Spore", "Modest",
  ["Giga Drain", "Sludge Bomb", "Protect", "Moonblast"], [32, 0, 0, 32, 2, 0]);
/** Headbutt would flinch on its own; Earthquake never does. */
const HITTER = (item) => set("Garchomp", item, "Rough Skin", "Adamant",
  ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"], [2, 32, 0, 0, 0, 32]);
const WALL = (item = "") => set("Amoonguss", item, "Regenerator", "Calm",
  ["Spore", "Pollen Puff", "Rage Powder", "Protect"], [32, 0, 2, 0, 32, 0]);
/** Something that survives a hit, so a ratio is not clipped at the target's remaining HP. */
const TANK = (item = "") => set("Dondozo", item, "Unaware", "Impish",
  ["Wave Crash", "Earthquake", "Protect", "Curse"], [32, 0, 32, 0, 2, 0]);

function stand(mine, theirs, field = {}) {
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(mine, { front: true }), row(WALL(), { front: true })],
    [row(theirs, { front: true }), row(WALL(), { front: true })], field));
  return { s, state, me: state.active[0][0], foe: state.active[1][0] };
}

// ---------------------------------------------------------------------------
// 1. the kit knows them at all
// ---------------------------------------------------------------------------

for (const [item, flag] of [["Wide Lens", "wideLens"], ["Bright Powder", "dimming"],
  ["Lax Incense", "dimming"], ["King's Rock", "flinchItem"], ["Razor Fang", "flinchItem"],
  ["Big Root", "bigRoot"], ["Focus Band", "band"], ["Shell Bell", "shellBell"]]) {
  const { me } = stand(HITTER(item), WALL());
  ok(`the kit reads ${item}`, me.k[flag] === true, `${flag}=${me.k[flag]}`);
}
{
  const { me } = stand(HITTER("Leftovers"), WALL());
  ok("...and sets none of them for an item that is none of them",
    !me.k.wideLens && !me.k.dimming && !me.k.flinchItem && !me.k.bigRoot && !me.k.band
    && !me.k.shellBell);
}

// ---------------------------------------------------------------------------
// 2. accuracy, from both sides
// ---------------------------------------------------------------------------

{
  const plain = stand(SHAKY(""), WALL());
  const slot = plain.me.u.moves.findIndex((m) => m && m.name === "Stone Edge");
  ok("Stone Edge is on the probe set", slot >= 0);
  const info = plain.me.u.moves[slot];
  const base = plain.s.t.accuracyOf(info, plain.me);
  ok("...and it is not a certainty, so a multiplier can be seen", base < 1, String(base));

  const lens = stand(SHAKY("Wide Lens"), WALL());
  near("Wide Lens raises accuracy by a tenth",
    lens.s.t.accuracyOf(lens.me.u.moves[slot], lens.me) / base, 1.1, 1e-9);

  const dim = stand(SHAKY(""), WALL("Bright Powder"));
  near("Bright Powder takes a tenth off the attacker's",
    dim.s.t.accuracyOf(dim.me.u.moves[slot], dim.me, dim.foe) / base, 0.9, 1e-9);
  const lax = stand(SHAKY(""), WALL("Lax Incense"));
  near("...and Lax Incense does the same",
    lax.s.t.accuracyOf(lax.me.u.moves[slot], lax.me, lax.foe) / base, 0.9, 1e-9);

  // THE OLD CALLERS MUST NOT MOVE. `target` is optional, and a caller that omits it gets the
  // number it always got -- which is what keeps every recorded run where it was.
  near("a caller that names no target is unchanged by the defender's item",
    dim.s.t.accuracyOf(dim.me.u.moves[slot], dim.me), base, 1e-9);
  // ...and the two multiply, rather than one winning.
  const both = stand(SHAKY("Wide Lens"), WALL("Bright Powder"));
  near("the two stack", both.s.t.accuracyOf(both.me.u.moves[slot], both.me, both.foe) / base,
    1.1 * 0.9, 1e-9);
  notes.push(`Stone Edge ${(base * 100).toFixed(0)}% bare`);
}

// ---------------------------------------------------------------------------
// 3. King's Rock: a FLOOR, on any damaging move, after everything else
// ---------------------------------------------------------------------------

/** One landed hit, and the flinch left on the target. */
function flinchAfter(item, move) {
  const { s, state, me, foe } = stand(HITTER(item), TANK());
  const slot = me.u.moves.findIndex((m) => m && m.name === move);
  if (slot < 0) return null;
  const hit = s.t.hitOn(me, foe, slot, state.board, false);
  s.t.deal(me, foe, hit, null, false, me, [me], state.board);
  return foe.flinchP || 0;
}
{
  near("Earthquake flinches nobody", flinchAfter("", "Earthquake"), 0, 1e-9);
  // A MOVE WITH NO FLINCH OP AT ALL, which is where `secondaries` could not have helped.
  near("...and with a King's Rock it flinches a tenth of the time",
    flinchAfter("King's Rock", "Earthquake"), 0.1, 1e-9);
  near("...and a Razor Fang does the same",
    flinchAfter("Razor Fang", "Earthquake"), 0.1, 1e-9);
}
{
  // ROCK SLIDE already flinches 30% of the time. The item must not add to that.
  const bare = flinchAfter("", "Rock Slide");
  const withRock = flinchAfter("King's Rock", "Rock Slide");
  ok("Rock Slide flinches on its own", bare > 0.1, String(bare));
  near("...and a King's Rock does NOT add to it", withRock, bare, 1e-9,
    "a floor, not a sum -- accumulating would make 0.3 into 0.37");
  notes.push(`Rock Slide flinch ${bare.toFixed(3)}, unchanged by the item`);
}
{
  // Inner Focus refuses it, which is the only thing the Companion checks.
  const { s, state, me, foe } = stand(HITTER("King's Rock"),
    set("Crobat", "", "Inner Focus", "Jolly", ["Air Slash", "Brave Bird", "Protect", "Tailwind"],
      [2, 32, 0, 0, 0, 32]));
  const slot = me.u.moves.findIndex((m) => m && m.name === "Earthquake");
  ok("the Inner Focus holder is flinch-proof", foe.k.flinchProof === true);
  const hit = s.t.hitOn(me, foe, slot, state.board, false);
  s.t.deal(me, foe, hit, null, false, me, [me], state.board);
  near("...so a King's Rock does nothing to it", foe.flinchP || 0, 0, 1e-9);
}

// ---------------------------------------------------------------------------
// 4. Big Root and Shell Bell: what comes back
// ---------------------------------------------------------------------------

/**
 * What the attacker is owed after one hit (`resid` is negative when it is healing).
 *
 * Into AMOONGUSS and not the Dondozo the other probes use: Dondozo is a Water type, so a Giga
 * Drain is super effective and knocks it out -- and what comes back is then the KO case, which
 * is tested on its own below. Amoonguss resists Grass and survives, which is what makes the
 * ratio between two items readable.
 */
function owed(item, move) {
  const { s, state, me, foe } = stand(DRAINER(item), WALL());
  const slot = me.u.moves.findIndex((m) => m && m.name === move);
  if (slot < 0) return null;
  const hit = s.t.hitOn(me, foe, slot, state.board, false);
  me.resid = 0;
  s.t.deal(me, foe, hit, null, false, me, [me], state.board);
  return -(me.resid || 0);
}
{
  const plain = owed("", "Giga Drain");
  ok("Giga Drain is on the probe set and gives something back", plain !== null && plain > 0,
    String(plain));
  near("Big Root gives back a third again as much", owed("Big Root", "Giga Drain") / plain, 1.3, 1e-9);
  near("...and an ordinary item does not", owed("Leftovers", "Giga Drain") / plain, 1, 1e-9);
}
{
  // SHELL BELL WORKS ON ANY HIT, draining or not.
  const plain = owed("", "Sludge Bomb");
  near("Sludge Bomb gives nothing back on its own", plain, 0, 1e-9);
  const bell = owed("Shell Bell", "Sludge Bomb");
  ok("...and with a Shell Bell it does", bell > 0, String(bell));
  notes.push(`Shell Bell returned ${bell.toFixed(4)} of the holder's own bar`);
}
{
  // ...AND A KNOCKOUT STILL GIVES IT BACK, which it did not. The knockout branch of `deal`
  // RETURNS, and the drain was credited below it -- so a Giga Drain that knocked its target out
  // healed its user for nothing at all, which is the normal case for a draining move.
  const { s, state, me, foe } = stand(DRAINER(""), TANK());
  const slot = me.u.moves.findIndex((m) => m && m.name === "Giga Drain");
  const hit = s.t.hitOn(me, foe, slot, state.board, false);
  ok("the probe drain really does knock it out", hit.frac >= foe.hp, `${hit.frac} vs ${foe.hp}`);
  me.resid = 0;
  s.t.deal(me, foe, hit, null, false, me, [me], state.board);
  ok("...and the knockout still heals its user", -(me.resid || 0) > 0, String(me.resid));
  ok("...and the target really is down", foe.out === true && foe.hp === 0);
  // CAPPED AT WHAT WAS DEALT: half of an overkill is not half of what came off the bar.
  const full = -(me.resid || 0);
  ok("...by no more than half of the bar it actually took off", full <= 0.5 * 1.001 * 10,
    String(full));
  notes.push(`a drain that KOs now returns ${full.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// 5. Focus Band: not the Focus Sash
// ---------------------------------------------------------------------------

/**
 * A hit big enough to knock the target out, and what the target had left afterwards.
 *
 * `roll` is the played turn's own seam. Focus Band is ROLLED and never priced: an expectation
 * would leave a Pokemon standing at a thousandth of a bar, and a Pokemon at a thousandth of a
 * bar reads as ALIVE to every reader in this engine and on the page -- nine times in ten a lie,
 * and /play/ feeds the displayed HP back into the search as truth. With no roll the search
 * simply prices the knockout, which is right nine times in ten.
 */
function survived(item, hp, roll = null) {
  const s = makeSolver();
  const state = s.buildState(boardOf(
    [row(HITTER(""), { front: true }), row(WALL(), { front: true })],
    [row(WALL(item), { front: true, hp }), row(WALL(), { front: true })]));
  const me = state.active[0][0];
  const foe = state.active[1][0];
  const slot = me.u.moves.findIndex((m) => m && m.name === "Earthquake");
  const hit = s.t.hitOn(me, foe, slot, state.board, false);
  ok(`the probe hit would knock it out (${item || "no item"}, ${hp}%)`, hit.frac >= foe.hp,
    `${hit.frac} vs ${foe.hp}`);
  s.t.effectRoll = roll;
  s.t.deal(me, foe, hit, null, false, me, [me], state.board);
  s.t.effectRoll = null;
  return foe.hp;
}
/** A roll that always comes up under a tenth, and one that never does. */
const LUCKY = () => 0.05;
const UNLUCKY = () => 0.95;
{
  near("with no item the hit knocks it out", survived("", 100, LUCKY), 0, 1e-9,
    "the roll is the band's, and there is no band");
  const band = survived("Focus Band", 100, LUCKY);
  ok("a lucky Focus Band leaves its holder standing", band > 0 && band < 0.05, String(band));
  near("...and an unlucky one does not", survived("Focus Band", 100, UNLUCKY), 0, 1e-9);
  // ...AND FROM ANY HEALTH, which is the difference from the Sash.
  const hurt = survived("Focus Band", 40, LUCKY);
  ok("...and it works from 40% health too", hurt > 0, String(hurt));
  near("...where a Focus Sash does nothing, because it needs full health",
    survived("Focus Sash", 40, LUCKY), 0, 1e-9);
  // THE SEARCH PRICES THE KNOCKOUT and invents nobody. An expectation here would be a Pokemon
  // at a thousandth of a bar that every reader calls alive.
  near("and with no roll to lend it, the search simply takes the knockout",
    survived("Focus Band", 100), 0, 1e-9);
  notes.push(`Focus Band: ${band.toFixed(4)} left on a lucky roll, 0 on an unlucky one and in the search`);
}

// ---------------------------------------------------------------------------

for (const line of notes) console.log(`  note: ${line}`);
if (failures.length) {
  console.error(`\nrun-items: ${failures.length} of ${checked} checks FAILED`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\nrun-items: ${checked} checks passed`);
