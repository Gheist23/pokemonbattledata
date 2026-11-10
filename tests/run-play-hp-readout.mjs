// What /play/ SHOWS: a living Pokemon never reads 0%, and a move says what it cost.
//
// Two faults the user met in one real game, 10 Nov 2026:
//
// 1. "Garchomp attacked and stays the next turns at 0% HP". It had not fainted -- there was no
//    faint line for it and it went on attacking. It had taken a Sucker Punch and lived on a
//    sliver, and `percent` was `Math.max(0, Math.round(share * 100))`, so ANY survivor under
//    half a percent read 0%. Three more copies of that line were written out by hand for the
//    board, the bench and the view, so the same Pokemon read 0% everywhere at once.
//
//    Only an exact share of 0 may read 0%, and `deal` writes exactly that on a knockout
//    (`if (target.hp <= 1e-9) { target.hp = 0; target.out = true; }`), so a faint still reads 0%
//    and nothing alive can.
//
// 2. "Sneasler used Close Combat on Garchomp" never said what it did. A `hit` step is silent by
//    design -- in the animation the health bar moving IS the sentence -- but the transcript has
//    no bar, so the damage was nowhere. The numbers were on the step all along (`from`, `to`).
//    `damageByMove` puts them on the move's own line.
//
//   node tests/run-play-hp-readout.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData } from "../builder/common.js";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest } from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";
import { PlayGame } from "../builder/play-game.js";
import { damageByMove, sentenceFor } from "../builder/play-anim.js";

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

/* ------------------------------------------------- 1. the readout itself */
{
  // `percent` is module-private, so it is exercised through the source it is written in -- and
  // the shape of the rule is what matters: a floor of 1 that only an exact zero escapes.
  const src = readFileSync(join(root, "builder", "play-game.js"), "utf8");
  const at = src.indexOf("const percent = (share)");
  ok("percent is still the one place a share becomes a percentage", at >= 0, String(at));
  const body = src.slice(at, src.indexOf("\n};", at) + 3);
  ok("an exact zero is still 0%", /value <= 0\) return 0/.test(body), body);
  ok("and anything alive is floored at 1%", /Math\.max\(1,/.test(body), body);
  ok("and nothing exceeds 100%", /Math\.min\(100,/.test(body), body);

  // The three hand-written copies are gone: the board, the bench and the view all ask `percent`.
  const code = src.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
  const copies = code.filter((l) => /Math\.round\(m\.hp \* 100\)/.test(l));
  ok("no copy of the conversion is left", copies.length === 0,
    JSON.stringify(copies.map((l) => l.trim())));
  // Four now: the three that had a hand-written copy, plus the residual walk that always asked.
  const callers = code.filter((l) => /percent\(m\.hp\)/.test(l));
  ok("every HP readout asks percent", callers.length === 4, String(callers.length));
}

/* ------------------------------------------------- 2. the rule, run as the page runs it */
{
  // The same arithmetic, so the boundaries are pinned by number and not only by shape.
  const percent = (share) => {
    const value = Number(share) || 0;
    if (value <= 0) return 0;
    return Math.min(100, Math.max(1, Math.round(value * 100)));
  };
  const cases = [
    [0, 0, "a fainted Pokemon"],
    [1e-9, 1, "the thinnest sliver there is"],
    [0.001, 1, "a tenth of a percent"],
    [0.004, 1, "the Garchomp the user met"],
    [0.0049, 1, "just under the old rounding boundary"],
    [0.005, 1, "exactly on it"],
    [0.014, 1, "1.4%"],
    [0.076, 8, "7.6%"],
    [0.76, 76, "the Close Combat in the log"],
    [1, 100, "full health"],
    [1.5, 100, "more than full, capped"],
  ];
  for (const [share, want, label] of cases) {
    ok(`${label} reads ${want}%`, percent(share) === want, `${percent(share)}%`);
  }
  ok("and the OLD rule really did read 0% for that Garchomp",
    Math.max(0, Math.round(0.004 * 100)) === 0);
  notes.push("0.4% HP: was 0%, now 1% -- and only an exact 0 reads 0%");
}

/* ------------------------------------------------- 3. the damage goes on the move's line */
{
  const nameOf = (side, tag) => ({ "0:0": "Sneasler", "1:0": "Garchomp", "1:1": "Dragonite" })[`${side}:${tag}`] || "It";
  const stream = [
    { kind: "move", side: 0, tag: 0, move: "Close Combat", targetSide: 1, targetTag: 0 },
    { kind: "hit", side: 1, tag: 0, from: 100, to: 76, crit: false },
  ];
  const damage = damageByMove(stream, nameOf);
  ok("the move's line gets the transition", damage.get(0) === ", 100% → 76%", damage.get(0));
  ok("and the hit itself stays silent, as the animation needs",
    sentenceFor(stream[1], nameOf) === "", sentenceFor(stream[1], nameOf));
  const said = sentenceFor(stream[0], nameOf) + damage.get(0);
  ok("so the transcript reads as the user asked",
    said === "Sneasler used Close Combat on Garchomp, 100% → 76%", said);
  notes.push(`transcript line: "${said}"`);
}

/* ------------------------------------------------- 4. a spread move names each target */
{
  const nameOf = (side, tag) => ({ "0:0": "Sneasler", "1:0": "Garchomp", "1:1": "Dragonite" })[`${side}:${tag}`] || "It";
  const stream = [
    { kind: "move", side: 0, tag: 0, move: "Rock Slide", targetSide: null, targetTag: null },
    { kind: "hit", side: 1, tag: 0, from: 100, to: 76 },
    { kind: "hit", side: 1, tag: 1, from: 90, to: 71 },
  ];
  const damage = damageByMove(stream, nameOf);
  ok("both targets are named and both numbers are there",
    damage.get(0) === ", Garchomp 100% → 76%, Dragonite 90% → 71%", damage.get(0));
  notes.push(`spread: "${sentenceFor(stream[0], nameOf)}${damage.get(0)}"`);
}

/* ------------------------------------------------- 5. and it does not invent lines */
{
  const nameOf = () => "It";
  ok("a move that hit nothing gets nothing appended",
    damageByMove([{ kind: "move", side: 0, tag: 0, move: "Protect" }], nameOf).size === 0);
  ok("a hit with no move before it is ignored rather than guessed at",
    damageByMove([{ kind: "hit", side: 1, tag: 0, from: 100, to: 76 }], nameOf).size === 0);
  ok("a hit with no numbers on it is skipped",
    damageByMove([{ kind: "move", side: 0, tag: 0, move: "Tackle" },
      { kind: "hit", side: 1, tag: 0 }], nameOf).size === 0);
  // Two moves in a turn must not pool their damage onto the first one.
  const two = damageByMove([
    { kind: "move", side: 0, tag: 0, move: "Close Combat" },
    { kind: "hit", side: 1, tag: 0, from: 100, to: 76 },
    { kind: "move", side: 1, tag: 0, move: "Earth Power" },
    { kind: "hit", side: 0, tag: 0, from: 100, to: 54 },
  ], nameOf);
  ok("each move keeps its own damage", two.get(0) === ", 100% → 76%" && two.get(2) === ", 100% → 54%",
    JSON.stringify([...two]));
  ok("and nothing is attributed to a step that is not a move", two.size === 2, String(two.size));
  // A residual (Leftovers, a burn) is not a move's damage and must not be swept up.
  const resid = damageByMove([
    { kind: "move", side: 0, tag: 0, move: "Close Combat" },
    { kind: "hit", side: 1, tag: 0, from: 100, to: 76 },
    { kind: "residual", side: 0, tag: 0, from: 100, to: 94, cause: "lifeorb" },
  ], nameOf);
  ok("a residual is left to its own line", resid.get(0) === ", 100% → 76%", resid.get(0));
}

/* ------------------------------------------------- 6. the page really uses it */
{
  const page = readFileSync(join(root, "builder", "play-page.js"), "utf8");
  ok("the transcript imports it", /import \{[^}]*damageByMove[^}]*\} from "\.\/play-anim\.js"/.test(page));
  ok("and builds it from the stream it is printing", /damageByMove\(stream,/.test(page));
  ok("appending only to a move's line",
    /step\.kind === "move" \? \(damage\?\.get\(index\) \|\| ""\)/.test(page));
  // It must live in play-anim, not play-page: play-page cannot be imported without a DOM, so a
  // helper left there could never be tested.
  const anim = readFileSync(join(root, "builder", "play-anim.js"), "utf8");
  ok("the helper sits beside sentenceFor, where it can be tested",
    /export function damageByMove/.test(anim));
  ok("and not in the page any more", !/function damageByMove/.test(page));
}

/* ------------------------------------------------- 7. end to end, over real games */
{
  // THE INVARIANT, checked on the view the page actually renders: a Pokemon the engine has not
  // knocked out must never report 0%. The UI prints "Fainted" from `out` alone, so a row with
  // `out === false` and `hp === 0` is a Pokemon shown as gone while it is still fighting -- which
  // is exactly what the user saw.
  const FORMAT = "Doubles";
  const appData = read("data", "builder", "app-data.json");
  const meta = read("data", "builder", `meta-${FORMAT.toLowerCase()}.json`);
  const library = read("data", "builder", "pokemon-sets.json").sets;
  const knownRaw = read("data", "builder", "known-teams.json");
  const effects = read("data", "builder", "move-effects.json");
  const data = new BuilderData(appData);
  data.ingestMeta(FORMAT, meta);
  const ev = new TeamEvaluator(data, new DamageEngine(appData), FORMAT,
    normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  const known = new KnownTeams(knownRaw);
  const solver = new Solver(new TournamentTest(evaluation, known,
    new TeamSuggestions(evaluation), { effects }));

  const byRank = (count) => (meta.pokemon || []).slice(0, count)
    .map((r) => data.commonSet(FORMAT, r.species, r.form)).filter((x) => x && x.moves?.length);
  const PLAYER = byRank(4);
  const FOE = byRank(8).slice(4, 8);
  ok("two teams off the top of the ladder", PLAYER.length === 4 && FOE.length === 4,
    `${PLAYER.length}/${FOE.length}`);

  let rows = 0;
  let aliveRows = 0;
  let turns = 0;
  const offenders = [];
  const zeroShown = [];
  for (const seed of [3, 11, 19, 27, 35, 43, 51, 59]) {
    const game = new PlayGame(solver, data, FORMAT, library);
    let view = game.start({ player: PLAYER, foe: FOE, seed });
    const look = (where) => {
      for (const side of view.sides || []) {
        for (const mon of side || []) {
          if (!mon) continue;
          rows += 1;
          if (mon.out) {
            if (mon.hp !== 0) offenders.push(`${where}: a fainted ${mon.name} reads ${mon.hp}%`);
            continue;
          }
          aliveRows += 1;
          if (!(mon.hp >= 1)) offenders.push(`${where}: a living ${mon.name} reads ${mon.hp}%`);
          if (mon.hp === 1) zeroShown.push(`${mon.name} on the floor at 1%`);
        }
      }
    };
    look(`seed ${seed} turn 0`);
    for (let turn = 1; turn <= 12 && !game.over(); turn += 1) {
      const options = game.options();
      const chosen = options.filter((o) => !o.empty).map((o) => o.actions[0]?.id).filter(Boolean);
      if (!chosen.length) break;
      const foeOptions = [0, 1].map((pos) => solver.slotCandidates(game.state, 1, pos, { cap: 0 }));
      game.resolve(game.jointFrom(options, chosen),
        solver.planFor(game.state, foeOptions.map((l) => l[0]).filter(Boolean), 1));
      view = game.view();
      turns += 1;
      look(`seed ${seed} turn ${turn}`);
      if (game.replacementNeeded()) {
        const choices = game.replacementChoices();
        if (choices?.length) { game.chooseReplacement(choices[0].tag); view = game.view(); }
      }
    }
  }
  ok("the games really ran", turns >= 30 && rows >= 200, `${turns} turns, ${rows} rows`);
  ok("and most rows were of a living Pokemon", aliveRows > rows / 2, `${aliveRows}/${rows}`);
  ok("NO living Pokemon ever reads 0%, and no fainted one reads anything else",
    offenders.length === 0, JSON.stringify(offenders.slice(0, 6)));
  notes.push(`${turns} turns over 8 seeds, ${rows} readouts (${aliveRows} alive): none broke the rule`);
  if (zeroShown.length) notes.push(`${zeroShown.length} readouts sat on the 1% floor (these were the 0% ones)`);
}

for (const note of notes) console.log(`   ${note}`);
console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
