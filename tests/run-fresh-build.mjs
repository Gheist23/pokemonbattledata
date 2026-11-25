// V561: Auto Build starts a NEW team when the selected team is already full.
//
// THE DEFECT. Auto Build fills the OPEN slots. With six Pokemon on the team there are none, so
// every phase was skipped: `run()`'s anchor loop is `for (let d = 0; d < open; d += 1)`, the beam
// is gated on `open > 0`, and the one-swap repair only looks at slots Auto Build itself added
// (`if (!added.size) return null`). Pressing Start Auto Build on a full team therefore handed the
// team straight back -- nothing added, nothing compared -- and "Keep the current team" is on by
// default, so that was the ordinary way to meet it. Measured before the fix: 0 additions.
//
// WHY THERE IS NO REPLAY FLAG ON THE VECTOR SUITES. Section 6 is the reason and the guard: every
// recorded Auto Build case seeds 3 of 6 slots (one seeds 1), so the rule is dormant for all of
// them and `run-autobuild-vectors` needs no stamp. If a recording is ever made from a full team
// that assertion goes red, which is the moment to add one -- rather than discovering it as an
// unexplained parity failure.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { BuilderData } from "../builder/common.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamAutoBuild } from "../builder/team-autobuild.js";
import {
  FRESH_BUILD_NOTE, FRESH_BUILD_RULE, FULL_TEAM_SIZE,
  freshBuildRuleOption, freshOptions, freshSeed, stampFresh, teamIsFull,
} from "../builder/fresh-build.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => JSON.parse(readFileSync(join(root, ...p), "utf8"));
const appData = read("data", "builder", "app-data.json");
const metaData = read("data", "builder", "meta-doubles.json");

let checked = 0;
const failures = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const data = new BuilderData(appData);
data.ingestMeta("Doubles", metaData);
const engine = new DamageEngine(appData);
const set = (s, f, i, a, n, b, m) => ({ species: s, form: f || s, item: i, ability: a, nature: n, bonuses: b, moves: m });

/** The owner's own six, the team this rule was reported on. */
const FULL = [
  set("Milotic", "", "Leftovers", "Competitive", "Calm", [32, 0, 17, 8, 5, 4], ["Scald", "Ice Beam", "Recover", "Protect"]),
  set("Sneasler", "", "Focus Sash", "Poison Touch", "Jolly", [2, 32, 0, 0, 0, 32], ["Close Combat", "Dire Claw", "Fake Out", "Protect"]),
  set("Luxray", "", "Shuca Berry", "Intimidate", "Adamant", [32, 0, 2, 0, 32, 0], ["Wild Charge", "Snarl", "Superpower", "Protect"]),
  set("Arcanine", "", "Life Orb", "Intimidate", "Adamant", [32, 32, 0, 0, 0, 2], ["Flare Blitz", "Extreme Speed", "Snarl", "Protect"]),
  set("Dragonite", "", "Leftovers", "Multiscale", "Adamant", [32, 32, 2, 0, 0, 0], ["Dragon Claw", "Earthquake", "Extreme Speed", "Protect"]),
  set("Slowking", "Slowking-Galar", "Colbur Berry", "Regenerator", "Quiet", [32, 0, 2, 32, 0, 0], ["Trick Room", "Sludge Bomb", "Chilly Reception", "Psychic"]),
];
const PARTIAL = [FULL[0], FULL[1], FULL[2], null, null, null];

function builder(ctor = {}, poke = null) {
  const ev = new TeamEvaluator(data, engine, "Doubles", normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: 30 }), ctor);
  ev.setMetaRecords(metaData.pokemon || []);
  if (poke) poke(ev);
  return new TeamAutoBuild(new TeamEvaluation(ev));
}
const copy = (team) => team.map((s) => (s ? { ...s, moves: [...s.moves], bonuses: [...s.bonuses] } : null));
const names = (result) => (result.entries || []).map((e) => (e && (e.form || e.pokemon)) || "-").join(", ");
const seeded = FULL.map((s) => s.form || s.species).join(", ");

// --- 1. the gate --------------------------------------------------------------------------
{
  ok("production is on", FRESH_BUILD_RULE === 1);
  ok("a team is six slots", FULL_TEAM_SIZE === 6);
  ok("an absent option means production", freshBuildRuleOption(undefined) === 1 && freshBuildRuleOption(null) === 1);
  for (const off of [0, "0", false, "off", "false", "no", "none", ""]) {
    ok(`${JSON.stringify(off)} turns it off`, freshBuildRuleOption(off) === 0, String(freshBuildRuleOption(off)));
  }
  for (const on of [1, "1", true, "on"]) ok(`${JSON.stringify(on)} leaves it on`, freshBuildRuleOption(on) === 1);
}

// --- 2. what counts as full ---------------------------------------------------------------
// The filled test has to be the SAME one the engine uses to decide a slot is open
// (`sets[i]?.species ? ... : null` in runGreedy and AutoBuildSearch.run). Being looser here is
// the dangerous direction: the rule would throw away a seed the engine still thinks is partly
// open, and the user would lose members with no slot gained.
{
  ok("six filled is full", teamIsFull(FULL) === true);
  ok("five filled is not", teamIsFull([...FULL.slice(0, 5), null]) === false);
  ok("three filled is not", teamIsFull(PARTIAL) === false);
  ok("nothing filled is not", teamIsFull([null, null, null, null, null, null]) === false);
  ok("an empty array is not", teamIsFull([]) === false);
  ok("a short array of six is not", teamIsFull(FULL.slice(0, 3)) === false);
  ok("undefined is not", teamIsFull(undefined) === false && teamIsFull(null) === false);
  ok("a blank species does not count", teamIsFull([...FULL.slice(0, 5), { species: "   " }]) === false);
  ok("a seventh entry cannot make five full", teamIsFull([...FULL.slice(0, 5), null, FULL[5]]) === false);
  ok("size 0 is never full", teamIsFull(FULL, 0) === false);
}

// --- 3. the pieces the rule is made of ----------------------------------------------------
{
  const seed = freshSeed();
  ok("the fresh seed is six slots", seed.length === 6);
  ok("and all of them empty", seed.every((s) => s === null));
  // The cached payload is Team Evaluation's answer FOR THE SEEDED TEAM. Dropping the seed and
  // keeping it would measure every candidate against scores no team in the search has.
  const opts = freshOptions({ depth: "deep", cachedScores: { synergy_score: 70 }, cachedPayload: { x: 1 }, archetype: "rain" });
  ok("the cached scores go with the seed", opts.cachedScores === null);
  ok("and so does the cached payload", opts.cachedPayload === null);
  ok("everything else is kept", opts.depth === "deep" && opts.archetype === "rain");
  const stamped = stampFresh({ log: ["something else"] });
  ok("the result says it built fresh", stamped.freshBuild === true);
  ok("and the note is first in the log", stamped.log[0] === FRESH_BUILD_NOTE && stamped.log[1] === "something else");
  ok("a log it was not given is created", stampFresh({}).log[0] === FRESH_BUILD_NOTE);
  ok("nothing to stamp is not a crash", stampFresh(null) === null && stampFresh(undefined) === undefined);
}

// --- 4. end to end: the defect, and the fix -----------------------------------------------
{
  // RULE OFF is the behaviour that was reported: the team comes back with nothing added. It is
  // not byte-identical -- the finish chain still repairs Item Clause, which is why this asserts
  // the ADDITIONS rather than the team -- but no slot was searched and no team was compared.
  const before = builder({}, (ev) => { ev.freshBuildRule = 0; }).run(copy(FULL), { depth: "fast", archetype: "automatic" });
  ok("with the rule off nothing is added", (before.additions || []).length === 0, String((before.additions || []).length));
  ok("and it is not flagged fresh", before.freshBuild !== true);
  ok("and the members are the user's own", (before.entries || []).every((e, i) => String(e.pokemon) === FULL[i].species),
    names(before));

  const after = builder().run(copy(FULL), { depth: "fast", archetype: "automatic" });
  ok("with the rule on all six are built", (after.additions || []).length === 6, String((after.additions || []).length));
  ok("it is flagged fresh", after.freshBuild === true);
  ok("the note is in the log", (after.log || [])[0] === FRESH_BUILD_NOTE);
  ok("and the team is a different one", names(after) !== seeded, names(after));
  ok("every slot is filled", (after.entries || []).filter((e) => e && e.pokemon).length === 6, names(after));

  // A PARTIAL team is the case the rule must not touch. This is the whole value of the gate.
  const partial = builder().run(copy(PARTIAL), { depth: "fast", archetype: "automatic" });
  ok("a partial team is not rebuilt", partial.freshBuild !== true);
  ok("its members are kept", String((partial.entries || [])[0]?.pokemon) === "Milotic", names(partial));
  ok("and only the open slots are filled", (partial.additions || []).length === 3, String((partial.additions || []).length));
}

// --- 5. the off-channels that exist, and the one that does not -----------------------------
// TeamEvaluator's rules argument silently ignores a key it does not destructure, so passing
// freshBuildRule THERE looks like turning the rule off and does nothing. The first run of this
// rule's own probe was fooled by exactly that, which is why it is asserted rather than assumed.
{
  const viaRun = builder().run(copy(FULL), { depth: "fast", archetype: "automatic", freshBuildRule: 0 });
  ok("run() takes the flag", viaRun.freshBuild !== true && (viaRun.additions || []).length === 0);
  const viaEv = builder({}, (ev) => { ev.freshBuildRule = 0; }).run(copy(FULL), { depth: "fast", archetype: "automatic" });
  ok("the evaluator takes the flag", viaEv.freshBuild !== true);
  const viaCtor = builder({ freshBuildRule: 0 }).run(copy(FULL), { depth: "fast", archetype: "automatic" });
  ok("the constructor key is NOT a channel", viaCtor.freshBuild === true,
    "TeamEvaluator now stores freshBuildRule, so this suite's warning is out of date -- say so rather than deleting it");
  // Precedence, with the two channels disagreeing: the run's own option wins.
  const clash = builder({}, (ev) => { ev.freshBuildRule = 1; })
    .run(copy(FULL), { depth: "fast", archetype: "automatic", freshBuildRule: 0 });
  ok("run() wins over the evaluator", clash.freshBuild !== true);

  // runGreedy() called DIRECTLY still seeds what it is handed: that is what keeps a recording
  // replayable without a flag, and it is why the rule lives in run() rather than in both paths.
  const direct = builder().runGreedy(copy(FULL), { depth: "fast", archetype: "automatic" });
  ok("runGreedy alone does not restart", direct.freshBuild !== true && (direct.additions || []).length === 0,
    String((direct.additions || []).length));
}

// --- 6. no recorded case seeds a full team ------------------------------------------------
// The guard behind "no replay flag needed". `record.start[0].team` is the seed the vector suite
// feeds in -- NOT `case.team`, which is the FINISHED team and has all six, and which is the
// easy thing to measure by mistake.
{
  for (const file of ["autobuild-vectors.json", "autobuild-vectors-options.json", "autobuild-vectors-guaranteed.json"]) {
    const cases = Object.values(read("tests", file));
    ok(`${file} has cases`, cases.length > 0);
    for (const testCase of cases) {
      const start = testCase?.record?.start?.[0]?.team;
      ok(`${file} / ${testCase?.name}: the recorded seed is readable`, Array.isArray(start));
      const filled = (start || []).filter((entry) => entry && entry[0]).length;
      ok(`${file} / ${testCase?.name}: its seed is not a full team, so V561 is dormant for it`,
        filled > 0 && filled < FULL_TEAM_SIZE, `${filled} of ${(start || []).length} seeded`);
    }
  }
}

// --- 7. the page shows the note and tells the truth about the switch ----------------------
{
  const page = readFileSync(join(root, "builder", "builder-page.js"), "utf8");
  // The note reaches the reader only if the caveat filter lets it through.
  const caveat = page.match(/const caveats = \(result\.log \|\| \[\]\)\.filter\(\(line\) => (\/[^\n]*?\/)\.test\(line\)\)/);
  ok("the page filters the log with a regex", Boolean(caveat), page.includes("const caveats") ? "found the line, not the regex" : "no caveats line");
  if (caveat) {
    const re = new RegExp(caveat[1].slice(1, -1));
    ok("and that regex passes V561's note", re.test(FRESH_BUILD_NOTE), caveat[1]);
  }
  // A switch that looks live and changes nothing is the thing this replaces.
  ok("the full-team switch is disabled", /locked\.length >= 6[\s\S]{0,200}disabled: true/.test(page));
  ok("and the page says why in words the reader sees",
    page.includes("Your team is already full, so Auto Build searches for a completely new team"));
}

console.log(`${checked} checked, ${failures.length} failed`);
for (const line of failures) console.log(`  FAIL ${line}`);
process.exit(failures.length ? 1 : 0);
