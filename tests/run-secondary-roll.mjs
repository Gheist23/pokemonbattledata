// A SECONDARY IN A PLAYED GAME HAPPENS OR IT DOES NOT -- it is never a fraction of itself.
//
// `shiftStages` spends WHOLE stages and banks the remainder on a per-stat carry. So a secondary
// priced as an expectation inside a played game (a 30% Attack drop applied as -0.30) moves
// nothing visible and leaves -0.30 behind -- and the next whole-stage boost pays the carry off
// instead of raising the stat. Reported from a real game:
//
//     Corviknight used Bulk Up, +1 attack/defense
//     Corviknight used Bulk Up            <- the other one, with no effect after it
//
// With both stats carrying, `runEffectOps` sees no stage move, `did` comes back empty and the
// log says only that the move was used. `runEffectOps` has rolled since it was written; this is
// the same rule for `secondaries`, which never got it.
//
//   node tests/run-secondary-roll.mjs
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

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));

let checked = 0;
const failures = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const appData = read("data", "builder", "app-data.json");
const meta = read("data", "builder", "meta-doubles.json");
const data = new BuilderData(appData);
data.ingestMeta("Doubles", meta);
const ev = new TeamEvaluator(data, new DamageEngine(appData), "Doubles",
  normalizeSettings({ ...DEFAULT_SETTINGS }));
ev.setMetaRecords(meta.pokemon || []);
const engineFor = () => new TournamentTest(
  new TeamEvaluation(ev), new KnownTeams(read("data", "builder", "known-teams.json")),
  new TeamSuggestions(new TeamEvaluation(ev)), { effects: read("data", "builder", "move-effects.json") });

const unit = () => ({ hp: 1, k: {}, u: { mon: {} }, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, flinchP: 0 });
const dropper = (chance) => ({
  hp: 1, k: {}, u: { mon: {}, moves: [{ fx: [
    { op: "stage", target: "target", stats: ["attack"], amount: -1, chance },
  ] }] },
});

// 1. THE SEARCH STILL PRICES. Every expectation this engine is built on depends on it, so this
//    is the half that must NOT move: no roll lent, the drop is worth its chance.
{
  const t = engineFor();
  const u = unit();
  t.secondaries(dropper(30), u, { slot: 0 });
  ok("a search still prices a 30% drop as three tenths", Math.abs((u.atkPart || 0) + 0.30) < 1e-9,
    `carry ${u.atkPart}`);
  ok("and it moves no whole stage", u.atk === 0, `atk ${u.atk}`);
}

// 2. A PLAYED GAME ROLLS, and what it rolls happens in full.
{
  const t = engineFor();
  t.effectRoll = () => 0.10;          // under 0.30: it fires
  const u = unit();
  t.secondaries(dropper(30), u, { slot: 0 });
  ok("a played drop that fires is a whole stage", u.atk === -1, `atk ${u.atk}`);
  ok("and banks nothing", !(u.atkPart), `carry ${u.atkPart}`);
}
{
  const t = engineFor();
  t.effectRoll = () => 0.90;          // over 0.30: it does not
  const u = unit();
  t.secondaries(dropper(30), u, { slot: 0 });
  ok("a played drop that misses does nothing", u.atk === 0, `atk ${u.atk}`);
  ok("and banks nothing either", !(u.atkPart), `carry ${u.atkPart}`);
}

// 3. THE BUG ITSELF: a carry must never swallow a later whole-stage boost in a played game.
{
  const t = engineFor();
  t.effectRoll = () => 0.90;          // three secondaries, none of which land
  const u = unit();
  for (let i = 0; i < 3; i += 1) t.secondaries(dropper(30), u, { slot: 0 });
  const before = u.atk;
  t.shiftStages(u, ["attack", "defense"], 1);      // a Bulk Up
  ok("Bulk Up raises Attack after three missed secondaries", u.atk === before + 1,
    `${before} -> ${u.atk}`);
  ok("and Defense with it", u.def === 1, `def ${u.def}`);
}

// 4. A 100% secondary is unconditional either way, so no roll may lose it.
{
  const t = engineFor();
  t.effectRoll = () => 0.999999;
  const u = unit();
  t.secondaries(dropper(100), u, { slot: 0 });
  ok("a sure secondary still lands on the worst roll", u.atk === -1, `atk ${u.atk}`);
}

console.log(`${checked} checked, ${failures.length} failed.`);
for (const line of failures) console.log(`FAIL ${line}`);
process.exit(failures.length ? 1 : 0);
