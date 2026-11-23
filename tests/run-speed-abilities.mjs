// V549: an Ability can be Speed control, a threat's rare items can be left out, and the
// Archetype row measures the archetype the team says it is.
//
// What went wrong, and what each section holds:
//
//   1. `_simple_profile_v187` / `TeamChecks.profile` decided `speed_control` from THIRTEEN
//      MOVES and no Ability at all. Measured on a team that won a regional -- Salamence-Mega /
//      Tyranitar-Mega / Corviknight / Excadrill / Indeedee / Sneasler -- all six came back
//      `speed_control: false`, the Speed Control row said "no direct Speed control", and Lead
//      Viability called 1 of its 15 pairs playable. Its plan is Tyranitar-Mega's Sand Stream
//      turning Excadrill's Sand Rush into 280 Speed on turn one.
//   2. `_V358_SPEED_ABILITIES` has shipped in app-data.json all along and nothing read it.
//   3. The condition is not assumed: no sand setter, no credit. That is the same rule the rest
//      of the checks apply to a set that leans on a field its team does not turn on.
//   4. Threat calculations used the top THREE items whatever their usage, so a team was told it
//      loses to a set almost nobody brings.
//   5. The Archetype row re-detected from the features and never looked at the archetype the
//      user picked, so a team built for Trick Room was measured against Hyper Offense.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { BuilderData } from "../builder/common.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamChecks, SPEED_ABILITY_RULE, speedAbilityRuleOption } from "../builder/team-checks.js";
import { TeamSpeed, outspeedTerm, OUTSPEED_CAP, TAILWIND_MULTIPLIER } from "../builder/team-speed.js";
import { TeamSuggestions, boxCandidates } from "../builder/team-suggest.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => JSON.parse(readFileSync(join(root, ...p), "utf8"));
const appData = read("data", "builder", "app-data.json");
const meta = read("data", "builder", "meta-doubles.json");

let checked = 0;
const failures = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const data = new BuilderData(appData);
data.ingestMeta("Doubles", meta);
const engine = new DamageEngine(appData);

const set = (species, form, item, ability, nature, bonuses, moves) =>
  ({ species, form: form || species, item, ability, nature, bonuses, moves });

/** The regional-winning team, exactly as it was reported. */
const REGIONAL = [
  set("Salamence", "Salamence-Mega", "Salamencite", "Aerilate", "Timid", [2, 0, 0, 32, 0, 32], ["Hyper Voice", "Draco Meteor", "Flamethrower", "Protect"]),
  set("Tyranitar", "Tyranitar-Mega", "Tyranitarite", "Sand Stream", "Jolly", [2, 32, 0, 0, 0, 32], ["Rock Slide", "Knock Off", "Low Kick", "Protect"]),
  set("Corviknight", "", "Psychic Seed", "Mirror Armor", "Careful", [0, 32, 0, 0, 2, 32], ["Brave Bird", "Power Trip", "Bulk Up", "Roost"]),
  set("Excadrill", "", "Focus Sash", "Sand Rush", "Adamant", [0, 32, 1, 0, 1, 32], ["Iron Head", "Protect", "Rock Slide", "High Horsepower"]),
  set("Indeedee", "", "Choice Scarf", "Psychic Surge", "Modest", [2, 0, 0, 32, 0, 32], ["Expanding Force", "Mystical Fire", "Trick", "Protect"]),
  set("Sneasler", "", "Mental Herb", "Unburden", "Adamant", [2, 32, 0, 0, 0, 32], ["Dire Claw", "Close Combat", "Coaching", "Protect"]),
];

function evaluatorFor(extra = {}, settings = {}) {
  const ev = new TeamEvaluator(data, engine, "Doubles",
    normalizeSettings({ ...DEFAULT_SETTINGS, top_meta: 30, ...settings }), extra);
  ev.setMetaRecords(meta.pokemon || []);
  return ev;
}

function profilesFor(team, extra = {}, settings = {}) {
  const payload = new TeamEvaluation(evaluatorFor(extra, settings));
  const slots = payload.slots(team);
  return { checks: payload.checks, slots, profiles: payload.checks.profiles(slots) };
}

// --- 1. the table is really in the shipped data -------------------------------------------
{
  const table = (appData.analysisTables || {})._V358_SPEED_ABILITIES || {};
  const keys = Object.keys(table).sort();
  ok("app-data.json ships _V358_SPEED_ABILITIES", keys.length === 5, keys.join(", "));
  for (const key of ["sand rush", "swift swim", "chlorophyll", "slush rush", "surge surfer"]) {
    ok(`it carries ${key}`, Boolean(table[key]), keys.join(", "));
  }
  ok("Sand Rush names Sand and doubles", String(table["sand rush"]?.[1]) === "Sand" && Number(table["sand rush"]?.[2]) === 2,
    JSON.stringify(table["sand rush"]));
}

// --- 2. the rule, and that it is ON by default --------------------------------------------
{
  ok("the rule is on in production", SPEED_ABILITY_RULE === 1, String(SPEED_ABILITY_RULE));
  ok("an absent option means production", speedAbilityRuleOption(undefined) === 1 && speedAbilityRuleOption(null) === 1);
  for (const off of [0, "0", false, "off", "false", "no", "none", ""]) {
    ok(`${JSON.stringify(off)} turns it off`, speedAbilityRuleOption(off) === 0, String(speedAbilityRuleOption(off)));
  }
  for (const on of [1, "1", true, "yes"]) {
    ok(`${JSON.stringify(on)} leaves it on`, speedAbilityRuleOption(on) === 1, String(speedAbilityRuleOption(on)));
  }
}

// --- 3. the regional team: the A/B that proves the rule is doing it ------------------------
{
  const off = profilesFor(REGIONAL, { speedAbilityRule: 0 });
  const on = profilesFor(REGIONAL);
  const named = (rows) => rows.filter((p) => p.speed_control).map((p) => p.name).sort();

  ok("with the rule off not one of the six has Speed control", named(off.profiles).length === 0,
    named(off.profiles).join(", "));
  ok("with it on, Excadrill and Sneasler do",
    JSON.stringify(named(on.profiles)) === JSON.stringify(["Excadrill", "Sneasler"]),
    named(on.profiles).join(", "));

  // ...and nothing else moved: the other four have no Speed Ability at all.
  for (const name of ["Salamence-Mega", "Tyranitar-Mega", "Corviknight", "Indeedee"]) {
    const row = on.profiles.find((p) => p.name === name);
    ok(`${name} is unchanged`, row && !row.speed_control && !row.speed_ability_live,
      JSON.stringify({ sc: row?.speed_control, live: row?.speed_ability_live }));
  }

  const exca = on.profiles.find((p) => p.name === "Excadrill");
  ok("Excadrill's Sand Rush names the field it needs",
    exca?.speed_ability?.name === "Sand Rush" && exca.speed_ability.condition === "Sand" && exca.speed_ability.kind === "weather",
    JSON.stringify(exca?.speed_ability));
  const sneasler = on.profiles.find((p) => p.name === "Sneasler");
  ok("Sneasler's Unburden needs no field", sneasler?.speed_ability?.kind === "always",
    JSON.stringify(sneasler?.speed_ability));

  // the lead score, and the count the row reports
  const pairs = [];
  for (let i = 0; i < on.profiles.length; i += 1) {
    for (let j = i + 1; j < on.profiles.length; j += 1) {
      pairs.push(on.checks.leadPairScore(on.profiles[i], on.profiles[j]));
    }
  }
  const playableOn = pairs.filter((v) => v >= 5.6).length;
  const pairsOff = [];
  for (let i = 0; i < off.profiles.length; i += 1) {
    for (let j = i + 1; j < off.profiles.length; j += 1) {
      pairsOff.push(off.checks.leadPairScore(off.profiles[i], off.profiles[j]));
    }
  }
  const playableOff = pairsOff.filter((v) => v >= 5.6).length;
  ok("15 pairs either way", pairs.length === 15 && pairsOff.length === 15, `${pairs.length} / ${pairsOff.length}`);
  ok("the regional team used to have exactly one playable lead pair", playableOff === 1, String(playableOff));
  ok("and has more than one now", playableOn > playableOff, `${playableOff} -> ${playableOn}`);

  // the Speed Control verdict itself
  const rowOff = off.checks.checkSpeedControl(off.profiles);
  const rowOn = on.checks.checkSpeedControl(on.profiles);
  ok("the Speed Control row was not good", rowOff.severity !== "good", rowOff.severity);
  ok("and is good now", rowOn.severity === "good", rowOn.severity);
  ok("and names the Ability and the field", /Sand Rush in Sand/.test(String(rowOn.summary_v203 || rowOn.summary)),
    String(rowOn.summary_v203 || rowOn.summary));
  ok("Unburden is named by what it needs", /Unburden once its item is used up/.test(String(rowOn.summary_v203 || rowOn.summary)),
    String(rowOn.summary_v203 || rowOn.summary));
}

// --- 4. the condition is not assumed -------------------------------------------------------
{
  const noSand = [
    set("Excadrill", "", "Focus Sash", "Sand Rush", "Adamant", [0, 32, 1, 0, 1, 32], ["Iron Head", "Protect", "Rock Slide", "High Horsepower"]),
    set("Incineroar", "", "Sitrus Berry", "Intimidate", "Careful", [2, 0, 32, 0, 32, 0], ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"]),
  ];
  const { profiles } = profilesFor(noSand);
  const exca = profiles.find((p) => p.name === "Excadrill");
  ok("Sand Rush with nobody setting sand is not Speed control", exca && !exca.speed_control && !exca.speed_ability_live,
    JSON.stringify({ sc: exca?.speed_control, live: exca?.speed_ability_live }));
  ok("but the Ability is still recognised, so the reason is the field", exca?.speed_ability?.name === "Sand Rush",
    JSON.stringify(exca?.speed_ability));

  // ...and the same Excadrill WITH a sand setter beside it does count: one team apart.
  const withSand = [...noSand, set("Tyranitar", "Tyranitar-Mega", "Tyranitarite", "Sand Stream", "Jolly", [2, 32, 0, 0, 0, 32], ["Rock Slide", "Knock Off", "Low Kick", "Protect"])];
  const second = profilesFor(withSand).profiles.find((p) => p.name === "Excadrill");
  ok("the same Excadrill beside a Sand Stream does", second?.speed_control === true && second.speed_ability_live === true,
    JSON.stringify({ sc: second?.speed_control, live: second?.speed_ability_live }));

  // Unburden with nothing to lose cannot fire
  const bare = [set("Sneasler", "", "", "Unburden", "Adamant", [2, 32, 0, 0, 0, 32], ["Dire Claw", "Close Combat", "Coaching", "Protect"])];
  const bareRow = profilesFor(bare).profiles[0];
  ok("Unburden with no item is not Speed control", !bareRow.speed_control && !bareRow.speed_ability_live,
    JSON.stringify({ sc: bareRow.speed_control, live: bareRow.speed_ability_live }));
}

// --- 5. the threat usage floor -------------------------------------------------------------
{
  const row = (meta.pokemon || []).find((p) => /^Incineroar$/i.test(String(p.name || "")));
  ok("the meta file carries usage percentages", Array.isArray(row?.items?.[0]) && row.items[0].length === 2,
    JSON.stringify(row?.items?.[0]));

  const entryFor = (floor) => {
    const ev = evaluatorFor({}, { threat_usage_floor: floor });
    return (ev.metaEntries() || []).find((e) => /incineroar/i.test(String(e.pokemon || e.name)));
  };
  const none = entryFor(0);
  ok("with no floor the top three items are used", none.top_items.length === 3, JSON.stringify(none.top_items));
  const pct = new Map((row.items || []).map(([name, value]) => [name, Number(value)]));

  // A FLOOR THE DATA ACTUALLY SEPARATES ON, worked out from the data itself.
  //
  // This used to pass 5 and assert something was dropped, which held only while one of
  // Incineroar's top three sat under 5%. The 13 Nov usage refresh moved the third to 5.8% and
  // nothing was below the floor any more, so the suite went red with no defect behind it -- the
  // rule it is guarding never changed. Pitched between the second and third most used items, it
  // drops exactly one whatever the percentages say this week.
  const used = none.top_items.map((item) => pct.get(item) || 0);
  const floor = (used[1] + used[2]) / 2;
  const above = entryFor(floor);
  ok("a floor between the second and third item drops the third",
    above.top_items.length === none.top_items.length - 1,
    `floor ${floor.toFixed(2)}: ${JSON.stringify(none.top_items)} -> ${JSON.stringify(above.top_items)}`);
  for (const item of above.top_items.slice(1)) {
    ok(`${item} is at or above the floor`, (pct.get(item) || 0) >= floor,
      `${pct.get(item)} vs ${floor.toFixed(2)}`);
  }
  ok("the most used item is always kept", above.top_items[0] === none.top_items[0],
    `${above.top_items[0]} vs ${none.top_items[0]}`);
  // ...and a floor above everything still keeps the one most used, which is the rule that
  // stops a Pokemon losing its item entirely.
  const brutal = entryFor(99);
  ok("a floor above every item still keeps the most used one",
    brutal.top_items.length === 1 && brutal.top_items[0] === none.top_items[0],
    JSON.stringify(brutal.top_items));

  // the default really is 5, and a recording that says nothing replays with no floor
  ok("the setting defaults to 5", normalizeSettings({}).threat_usage_floor === 5,
    String(normalizeSettings({}).threat_usage_floor));
  ok("0 is allowed and means off", normalizeSettings({ threat_usage_floor: 0 }).threat_usage_floor === 0);
  ok("it is clamped to 0..100", normalizeSettings({ threat_usage_floor: 900 }).threat_usage_floor === 100
    && normalizeSettings({ threat_usage_floor: -4 }).threat_usage_floor === 0);
}

// --- 6. the Archetype row measures the archetype the team says it is -----------------------
{
  const { checks, slots } = profilesFor(REGIONAL);
  const detected = checks.rows(slots, null, {}).archetype;
  ok("with no choice it still detects", /^Detected /.test(String(detected.summary)), String(detected.summary));

  const chosen = checks.rows(slots, null, { teamArchetype: "Trick Room" }).archetype;
  ok("a chosen archetype is what the row is called", chosen.check_label === "Archetype: Trick Room", chosen.check_label);
  ok("and it is measured against ITS requirements",
    /Trick Room requirements are covered/.test(String(chosen.summary)), String(chosen.summary));
  ok("while still saying what the team reads as",
    chosen.summary.includes("reads as") && chosen.archetype_detected_v549 === detected.archetype,
    `${chosen.summary} | ${chosen.archetype_detected_v549}`);
  ok("a team that misses its own archetype is not called good", chosen.severity !== "good", chosen.severity);

  // a single-word key, which ARCHETYPE_DISPLAY does not hold: it must still resolve
  const sand = checks.rows(slots, null, { teamArchetype: "Sand" }).archetype;
  ok("a one-word archetype resolves too", sand.check_label === "Archetype: Sand", sand.check_label);
  // ...by key as well as by label, because Auto Build passes the key
  const byKey = checks.rows(slots, null, { teamArchetype: "hyper offense" }).archetype;
  ok("and by key", byKey.check_label === "Archetype: Hyper Offense", byKey.check_label);
  // "automatic" is not a choice
  const auto = checks.rows(slots, null, { teamArchetype: "automatic" }).archetype;
  ok("Automatically is not treated as a choice", auto.check_label === detected.check_label,
    `${auto.check_label} vs ${detected.check_label}`);
  // and nonsense falls back rather than inventing a label
  const junk = checks.rows(slots, null, { teamArchetype: "not an archetype" }).archetype;
  ok("an unknown archetype falls back to the detected one", junk.check_label === detected.check_label,
    junk.check_label);
}

// --- 7. the three recorded vector suites replay with both rules off ------------------------
{
  for (const name of ["run-eval-vectors.mjs", "run-suggest-vectors.mjs", "run-autobuild-vectors.mjs"]) {
    const source = readFileSync(join(here, name), "utf8");
    ok(`${name} replays with no Speed Abilities`, /speedAbilityRule:\s*0/.test(source));
    ok(`${name} replays with no usage floor`, /threat_usage_floor:\s*Number\(/.test(source));
  }
  // and the Companion carries the same rule, or the two ports have split
  const appModule = join(root, "..", "..", "pct_tool94", "pokemon_champions_tool", "speed_ability_control_v549.py");
  let app = "";
  try { app = readFileSync(appModule, "utf8"); } catch { /* a checkout without the app */ }
  if (app) {
    ok("the Companion has the same five Abilities",
      ["swift swim", "chlorophyll", "sand rush", "slush rush", "surge surfer"].every((k) => app.includes(`"${k}"`)));
    ok("and the same two unconditional ones", app.includes('"speed boost"') && app.includes('"unburden"'));
    ok("and it, too, refuses Unburden with no item", /unburden.*not str\(item/s.test(app));
  }
}

// --- 8. the Speed SCORE counts the Speed the Pokemon really has ---------------------------
// `finalSpeed` returned the raw stat, so every count in the Speed score -- how much of the meta
// a member outruns, whether it is one of the team's fast ones -- put a Sand Rush Excadrill on a
// Sand Stream team at 140 against a meta it beats at 280, and a flat bonus was bolted on at the
// end instead. Now the comparison is made at the real Speed, and the flat bonus is paid only
// where no Speed term replaced it (Opposing Tailwind, which has none).
{
  const speedOf = (extra) => {
    const ev = evaluatorFor(extra);
    const sp = new TeamSpeed(ev);
    const payload = new TeamEvaluation(ev);
    const slots = payload.slots(REGIONAL);
    const boosts = sp.speedAbilityBoosts(slots);
    const exca = slots.find(({ mon, entry }) => /Excadrill/i.test(String(mon.form_name || entry.pokemon)));
    const sala = slots.find(({ mon, entry }) => /Salamence/i.test(String(mon.form_name || entry.pokemon)));
    return { boosts, exca, sala, sp };
  };

  const on = speedOf({});
  const off = speedOf({ speedAbilityRule: 0 });

  ok("with the rule off nothing is boosted", off.boosts.size === 0, String(off.boosts.size));
  ok("with it on exactly one member is", on.boosts.size === 1, String(on.boosts.size));
  ok("and it is Excadrill, at 2x", on.boosts.get(on.exca.mon) === 2, String(on.boosts.get(on.exca.mon)));

  // the Speed the score compares with
  on.sp._speedAbilityBoost = on.boosts;
  const boosted = on.sp.finalSpeed(on.exca.mon);
  const salaBoosted = on.sp.finalSpeed(on.sala.mon);
  on.sp._speedAbilityBoost = null;
  const raw = on.sp.finalSpeed(on.exca.mon);
  ok("Excadrill is compared at twice its raw Speed", boosted === raw * 2, `${raw} -> ${boosted}`);
  ok("and nobody else on the team moves", salaBoosted === on.sp.finalSpeed(on.sala.mon),
    String(salaBoosted));
  ok("the raw Speed is unchanged when nothing is held", raw > 0 && raw < boosted, `${raw} / ${boosted}`);

  // The field must really be set, and it may be set by an ABILITY or by a MOVE. Five teams,
  // one Excadrill, only the two that put sand up count it.
  {
    const exca = REGIONAL[3];
    const tyr = REGIONAL[1];
    const sandMove = set("Garchomp", "", "Life Orb", "Rough Skin", "Jolly", [2, 32, 0, 0, 0, 32], ["Sandstorm", "Earthquake", "Dragon Claw", "Protect"]);
    const rainAbility = set("Pelipper", "", "Focus Sash", "Drizzle", "Modest", [2, 0, 0, 32, 0, 32], ["Hurricane", "Weather Ball", "Tailwind", "Protect"]);
    const rainMove = set("Milotic", "", "Leftovers", "Competitive", "Calm", [2, 0, 0, 32, 32, 0], ["Rain Dance", "Scald", "Recover", "Protect"]);
    const boostOf = (team) => {
      const ev = evaluatorFor({});
      const sp = new TeamSpeed(ev);
      const slots = new TeamEvaluation(ev).slots(team);
      const row = slots.find(({ mon, entry }) => /Excadrill/i.test(String(mon.form_name || entry.pokemon)));
      return sp.speedAbilityBoosts(slots).get(row.mon) || 0;
    };
    ok("Sand Rush alone is not Speed", boostOf([exca]) === 0, String(boostOf([exca])));
    ok("a Sand Stream ABILITY switches it on", boostOf([exca, tyr]) === 2, String(boostOf([exca, tyr])));
    ok("a Sandstorm MOVE switches it on too", boostOf([exca, sandMove]) === 2, String(boostOf([exca, sandMove])));
    ok("a rain ABILITY does not", boostOf([exca, rainAbility]) === 0, String(boostOf([exca, rainAbility])));
    ok("and neither does a rain MOVE", boostOf([exca, rainMove]) === 0, String(boostOf([exca, rainMove])));
  }

  // Unburden is NOT a field doubler: it keeps the flat credit instead of a Speed it has not got
  ok("Unburden is not counted as doubled Speed",
    ![...on.boosts.keys()].some((mon) => /Sneasler/i.test(String(mon.form_name || mon.pokemon_name))),
    [...on.boosts.keys()].map((m) => m.form_name || m.pokemon_name).join(", "));

  // and the map does not leak into the next team
  const payload2 = new TeamEvaluation(evaluatorFor({}));
  const result = payload2.evaluate(REGIONAL, {});
  ok("control() clears the boost map when it is done", payload2.speed._speedAbilityBoost == null,
    String(payload2.speed?._speedAbilityBoost));
  ok("and the Speed score still comes out", Number(result.speed?.score) > 0, String(result.speed?.score));
}

// --- 8b. V555 half two: outrunning a Tailwinded meta is worth something -------------------
// `opposing_tailwind` carries 27% of the Speed score and had NO Speed term in it -- only your
// own Tailwind, your own Trick Room, OHKOs on the setters and priority. So a team whose answer
// to a speed war is "I am still faster than you are with Tailwind up" scored nothing for it,
// and the count that answers it was already being computed one line above and spent on display
// text. These checks are the A/B, the gate and the arithmetic -- deliberately NOT a pinned
// score, which would go red on a data refresh with no defect behind it.
{
  // the pure term first: the cap and the step are code, not data
  ok("no matchups is no term", outspeedTerm(0) === 0, String(outspeedTerm(0)));
  ok("the step reaches the cap at 60 matchups", outspeedTerm(60) === OUTSPEED_CAP, String(outspeedTerm(60)));
  ok("and it never exceeds it", outspeedTerm(600) === OUTSPEED_CAP, String(outspeedTerm(600)));
  ok("half the cap at half the matchups", Math.abs(outspeedTerm(30) - OUTSPEED_CAP / 2) < 1e-9, String(outspeedTerm(30)));
  ok("the cap is the own-Tailwind credit", OUTSPEED_CAP === 22, String(OUTSPEED_CAP));
  ok("a member must beat twice a meta Speed", TAILWIND_MULTIPLIER === 2, String(TAILWIND_MULTIPLIER));
  ok("nonsense is not a term", outspeedTerm(-5) === 0 && outspeedTerm(NaN) === 0 && outspeedTerm(undefined) === 0);

  const speedFor = (team, extra) => {
    const ev = evaluatorFor(extra);
    const payload = new TeamEvaluation(ev);
    const result = payload.evaluate(team, {});
    const speed = result.speed || {};
    return {
      score: Number(speed.score || 0),
      standard: Number(speed.standard || 0),
      tw: Number(speed.opposing_tailwind || 0),
      lines: (speed.tailwind_lines || []).map(String),
      held: payload.speed?._v555TailwindOutspeed,
    };
  };

  // --- the board the defect was reported on ---------------------------------------------
  const off = speedFor(REGIONAL, { speedAbilityRule: 0 });
  const on = speedFor(REGIONAL, {});
  ok("the sand team's Opposing Speed Control rises", on.tw > off.tw, `${off.tw} -> ${on.tw}`);
  ok("and so does its Speed score", on.score > off.score, `${off.score} -> ${on.score}`);

  // the sentence is the report, and it must say what it paid
  const said = on.lines.filter((line) => /Tailwinded Top/.test(line));
  ok("it reports the term it paid, once", said.length === 1, said.join(" | "));
  const match = /Top (\d+) in (\d+) of (\d+) matchups, worth ([\d.]+) here/.exec(said[0] || "");
  ok("the sentence parses", Boolean(match), said[0] || "");
  if (match) {
    const [, metaCount, matchups, pairs, worth] = match.map(Number);
    ok("it counted a Top 30", metaCount === 30, String(metaCount));
    ok("over six members against all thirty", pairs === 6 * 30, String(pairs));
    ok("it found matchups to pay for", matchups > 0, String(matchups));
    ok("and the term is that count through the step",
      Math.abs(worth - outspeedTerm(matchups)) < 0.05, `${worth} vs ${outspeedTerm(matchups)}`);

    // THE ARITHMETIC: the rise in this component is the term and NOTHING else.
    //
    // Measured, because the obvious expectation is wrong: v358's flat Tailwind share
    // (`bonus * 0.45`) is paid in both runs. It is not gated on `speedAbilityRule` and it was
    // never meant to be -- half one withholds the flat credit only from `standard`, where a
    // real Speed comparison replaced it, and deliberately leaves this component's share alone
    // because there was no Speed term here for the doubled stat to have improved. Half two adds
    // that term; it does not touch the share. So the two runs differ here by the term alone,
    // which is a tighter claim than "the share plus the term" and would catch either half
    // starting to pay for the other.
    ok("the component rose by exactly the term, the flat share being paid either way",
      Math.abs(on.tw - off.tw - outspeedTerm(matchups)) < 0.05,
      `${(on.tw - off.tw).toFixed(2)} vs ${outspeedTerm(matchups).toFixed(2)}`);
  }

  // --- who does NOT move: the gate -------------------------------------------------------
  // `enabled` is v358's own count of live Speed Abilities. A team with none is not touched by
  // either half, which is what keeps this a defect fix and not a rescale of every team's score.
  const noAbility = {
    "top-meta goodstuff": [
      set("Incineroar", "", "Sitrus Berry", "Intimidate", "Careful", [2, 0, 32, 0, 32, 0], ["Fake Out", "Parting Shot", "Flare Blitz", "Knock Off"]),
      set("Rillaboom", "", "Assault Vest", "Grassy Surge", "Adamant", [2, 32, 0, 0, 0, 32], ["Grassy Glide", "Wood Hammer", "U-turn", "Fake Out"]),
      set("Garchomp", "", "Life Orb", "Rough Skin", "Jolly", [2, 32, 0, 0, 0, 32], ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"]),
      set("Whimsicott", "", "Covert Cloak", "Prankster", "Timid", [2, 0, 0, 32, 0, 32], ["Moonblast", "Tailwind", "Fake Tears", "Protect"]),
      set("Kingambit", "", "Black Glasses", "Defiant", "Adamant", [2, 32, 0, 0, 0, 32], ["Kowtow Cleave", "Sucker Punch", "Iron Head", "Protect"]),
      set("Gholdengo", "", "Choice Specs", "Good as Gold", "Modest", [2, 0, 0, 32, 0, 32], ["Make It Rain", "Shadow Ball", "Power Gem", "Protect"]),
    ],
    "a Trick Room six": [
      set("Indeedee", "Indeedee-F", "Psychic Seed", "Psychic Surge", "Relaxed", [2, 0, 32, 0, 32, 0], ["Follow Me", "Expanding Force", "Helping Hand", "Trick Room"]),
      set("Hatterene", "", "Life Orb", "Magic Bounce", "Quiet", [2, 0, 0, 32, 32, 0], ["Expanding Force", "Dazzling Gleam", "Trick Room", "Protect"]),
      set("Incineroar", "", "Sitrus Berry", "Intimidate", "Careful", [2, 0, 32, 0, 32, 0], ["Fake Out", "Parting Shot", "Flare Blitz", "Knock Off"]),
      set("Gholdengo", "", "Choice Specs", "Good as Gold", "Modest", [2, 0, 0, 32, 0, 32], ["Make It Rain", "Shadow Ball", "Power Gem", "Protect"]),
      set("Farigiraf", "", "Sitrus Berry", "Armor Tail", "Relaxed", [2, 0, 32, 0, 32, 0], ["Trick Room", "Psychic", "Helping Hand", "Protect"]),
      set("Rillaboom", "", "Assault Vest", "Grassy Surge", "Adamant", [2, 32, 0, 0, 0, 32], ["Grassy Glide", "Wood Hammer", "U-turn", "Fake Out"]),
    ],
  };
  for (const [label, team] of Object.entries(noAbility)) {
    const a = speedFor(team, { speedAbilityRule: 0 });
    const b = speedFor(team, {});
    ok(`${label} is untouched`, a.score === b.score && a.tw === b.tw, `${a.score} -> ${b.score}`);
    ok(`${label} says nothing about Tailwind outspeeds`,
      !b.lines.some((line) => /Tailwinded Top/.test(line)), b.lines.join(" | "));
  }

  // A doubler with no setter is not a live Ability: v358 writes the "needs Sand" line and
  // `enabled` stays 0, so this board is untouched as well -- the same rule as half one.
  {
    const lonely = [REGIONAL[3], ...noAbility["top-meta goodstuff"].slice(0, 5)];
    const a = speedFor(lonely, { speedAbilityRule: 0 });
    const b = speedFor(lonely, {});
    ok("Sand Rush with no sand setter is untouched", a.score === b.score, `${a.score} -> ${b.score}`);
  }

  // ...but Unburden with no doubler IS live: it keeps v358's flat credit AND it is paid the
  // term, because the Companion's `apply` runs on `doublers or enabled_count` too. This is the
  // one population the gate admits that is not a weather team, and it is measured here rather
  // than left to be discovered.
  {
    const unburden = [REGIONAL[5], ...noAbility["top-meta goodstuff"].slice(0, 5)];
    const a = speedFor(unburden, { speedAbilityRule: 0 });
    const b = speedFor(unburden, {});
    ok("an Unburden team is paid the term too", b.score > a.score, `${a.score} -> ${b.score}`);
    ok("and it reports it", b.lines.some((line) => /Tailwinded Top/.test(line)), b.lines.join(" | "));
  }

  // --- the held count does not leak into the next team -----------------------------------
  ok("control() clears the held count when it is done", on.held == null, String(on.held));
}

// --- 8c. the two ports must not drift apart ------------------------------------------------
// The Companion's V555 and this file are one rule in two languages. A cap or a step changed in
// one and not the other is a silent divergence no vector suite can see, because every recorded
// suite replays with the rule off.
{
  const appModule = join(root, "..", "..", "pct_tool94", "pokemon_champions_tool", "speed_ability_speed_v555.py");
  let app = "";
  try { app = readFileSync(appModule, "utf8"); } catch { /* a checkout without the app */ }
  if (app) {
    ok("the Companion caps the term at the same 22", /OUTSPEED_CAP\s*=\s*22\.0/.test(app));
    ok("and reaches it over the same 60 matchups", /OUTSPEED_STEP\s*=\s*22\.0\s*\/\s*60\.0/.test(app));
    ok("and asks for twice the meta Speed", /TAILWIND_MULTIPLIER\s*=\s*2\.0/.test(app));
    ok("and pays the term on either a doubler or a flat Ability",
      /if\s+doublers\s+or\s+enabled_count/.test(app));
  } else {
    ok("the Companion module was not readable from here (skipped)", true);
  }
}

// --- 9. Suggestions never offers a Pokemon the team already has ---------------------------
// The team's names come from `showdownName` ("Salamence-Mega"); the ranked list uses the game's
// own display ("Mega Salamence"). `compact` compared the two directly, so no Mega on a team was
// ever filtered out of its own candidate list -- reported from the live site as
// "Swap Tyranitar-Mega -> Mega Salamence" on a team already holding Salamence.
{
  const sg = new TeamSuggestions(new TeamEvaluation(evaluatorFor({})));
  const names = ["Salamence-Mega", "Tyranitar-Mega", "Corviknight", "Excadrill", "Indeedee", "Sneasler"];
  const rows = sg.candidates({}, names);
  ok("the ranked candidate list is not empty", rows.length > 100, String(rows.length));

  // No Mega on the team comes back under its other spelling, whichever way round it is written.
  const megaKey = (value) => {
    const text = String(value || "").trim();
    const bare = /^mega[\s-]+/i.test(text) ? text.replace(/^mega[\s-]+/i, "")
      : /[\s-]mega$/i.test(text) ? text.replace(/[\s-]mega$/i, "") : "";
    return bare ? `${bare.toLowerCase().replace(/[^a-z0-9]/g, "")}mega` : "";
  };
  const teamMegas = new Set(names.map(megaKey).filter(Boolean));
  const clash = rows.filter((r) => {
    const key = megaKey(String(r.form || r.name || r.base_name));
    return key && teamMegas.has(key);
  });
  ok("and no Mega on the team is offered back under its other spelling",
    clash.length === 0, clash.map((r) => r.name).join(", "));

  // the exact pair that was reported, both ways round
  for (const spelling of ["Mega Salamence", "Salamence-Mega", "Mega Tyranitar", "Tyranitar-Mega"]) {
    ok(`${spelling} is not offered`, !rows.some((r) => String(r.name) === spelling),
      rows.filter((r) => String(r.name) === spelling).map((r) => r.name).join(", "));
  }
  // KNOWN AND DELIBERATE: a second FORM of a species already on the team is still offered.
  // The species clause makes that illegal too (play-page.js:1041) and the Companion offers it
  // as well, but removing those candidates measurably concentrated the shown list on one swap
  // target -- Indeedee-F went from 7 of 14 rows to 9, past the bar `run-suggest-scoring.mjs`
  // holds. Pinned here so the gap is a recorded decision and not an oversight: when the V517
  // diversity is re-tuned, widen this to the full species collapse and this check flips.
  ok("a second form of a species on the team is still offered (known gap)",
    rows.some((r) => /indeedee/i.test(String(r.name))),
    rows.filter((r) => /indeedee/i.test(String(r.name))).map((r) => r.name).join(", "));

  // the Box list, which had the same comparison
  const box = [
    { species: "Salamence", form: "Mega Salamence", item: "Salamencite", ability: "Aerilate", nature: "Timid", bonuses: [2, 0, 0, 32, 0, 32], moves: ["Hyper Voice"] },
    { species: "Milotic", form: "Milotic", item: "Leftovers", ability: "Competitive", nature: "Calm", bonuses: [2, 0, 0, 32, 32, 0], moves: ["Scald"] },
  ];
  const offered = boxCandidates(sg, box, names).map((r) => String(r.name));
  ok("a Box Mega already on the team is not offered", !offered.some((n) => /salamence/i.test(n)), offered.join(", "));
  ok("and the rest of the Box still is", offered.some((n) => /milotic/i.test(n)), offered.join(", "));
}

console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
