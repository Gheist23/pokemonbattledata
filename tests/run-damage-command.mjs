// /damage checks: that the bot's number IS the website's number, that the free
// text is read or reported, and that the KO wording does not drift.
//
//   node tests/run-damage-command.mjs          the default sample
//   node tests/run-damage-command.mjs --full   every ranked pair in both formats
//
// The first section is the point of the file. The Discord bot must not have a
// damage implementation of its own, so this test builds the calculation twice:
//
//   * the way builder/calc-page.js does it -- BuilderData.load() and
//     loadMeta() over the real data/ files, setFromCommon(commonSet(...)),
//     defaultMonState, new CalcModel(...) -- which is literally the code the
//     Damage Calculator page runs;
//   * the way the bot does it, through functions/api/discord/_damage.js and
//     env.ASSETS, which has to bypass those two loaders because a Worker has no
//     base URL for a root-relative fetch.
//
// and requires every roll, range, percent and KO line to be identical. It cannot
// prove the formula (tests/run-calc-vectors.mjs replays 4,000 recorded app
// vectors for that); what it proves is the wiring, which is the only thing that
// can drift: the set the bot starts from, the form it battles as, the format's
// meta file, the weather and terrain the panel decides on.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ORIGIN = "https://championsbattledata.com";
const FULL = process.argv.slice(2).includes("--full");

let checked = 0;
const failures = [];
const check = (label, got, want) => {
  checked += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) failures.push(`${label}\n     got  ${a}\n     want ${b}`);
};
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

// ------------------------------------------------------- the two ways in

// The page's way: a fetch that reads the site's own files, so BuilderData.load()
// and loadMeta() run exactly as they do in a browser.
globalThis.fetch = async (url) => {
  const path = String(url).split("?")[0];
  const file = join(root, path);
  if (!existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
  const text = readFileSync(file, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(text) };
};

// The bot's way: env.ASSETS, the binding every other command reads through.
const env = {
  ASSETS: {
    async fetch(url) {
      const path = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, "");
      const file = join(root, ...path.split("/"));
      if (!existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(readFileSync(file), { status: 200 });
    }
  }
};

const { BuilderData, setFromCommon } = await import("../builder/common.js");
const { CalcModel, LEFT, RIGHT, defaultCalcState, defaultMonState } = await import("../builder/calc-model.js");
const { MAX_BONUS_POINTS_PER_STAT, MAX_BONUS_STAT_POINTS, compact } = await import("../builder/engine.js");
const { SiteData } = await import("../functions/api/discord/_data.js");
const { TtlCache } = await import("../functions/api/discord/_cache.js");
const {
  builderFor, buildCalculation, damageCalculation, dictionaries, parseFieldText, parseSetText, splitNumeric, koLine, FIELD_TOKENS
} = await import("../functions/api/discord/_damage.js");
const { damageReply, calculatorUrl } = await import("../functions/api/discord/_render.js");
const { COMMANDS, AUTOCOMPLETE_KINDS, SUBJECT_OPTIONS, optionValue } = await import("../functions/api/discord/_commands.js");
const { routeInteraction } = await import("../functions/api/discord/interactions.js");

const request = () => new Request(`${ORIGIN}/api/discord/interactions`, { method: "POST" });
const site = new SiteData(env, request(), { origin: ORIGIN, cache: new TtlCache() });

/** The Damage Calculator page's own model for one pair, built its own way. */
const pageData = await BuilderData.load();
async function pageModel(format, attackerName, defenderName) {
  await pageData.loadMeta(format);
  const state = defaultCalcState();
  state.format = format;
  const setFor = (name) => {
    const [species, form] = pageData.resolveName(name);
    return setFromCommon(pageData.commonSet(format, species, form));
  };
  state.mons[LEFT] = defaultMonState(setFor(attackerName));
  state.mons[RIGHT] = defaultMonState(setFor(defenderName));
  return new CalcModel(pageData, state);
}

const damage = (options) => damageCalculation(site, { weather: "Auto", terrain: "Auto", ...options });

// ------------------------------------- 1. the bot's number is the page's number

const meta = { Doubles: await site.usage("Doubles"), Singles: await site.usage("Singles") };
function samplePairs(format) {
  const names = (meta[format].pokemon || []).map((row) => row.name);
  if (FULL) return names.map((name, index) => [name, names[(index + 7) % names.length]]);
  // A fixed spread over the ranking rather than the top ten twice: the Megas,
  // the terrain setters and the Sitrus holders are all in there.
  const picks = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 200, 240];
  return picks.filter((index) => index < names.length)
    .map((index, position) => [names[index], names[picks[(position + 3) % picks.length] % names.length]]);
}

let compared = 0;
for (const format of ["Doubles", "Singles"]) {
  for (const [attackerName, defenderName] of samplePairs(format)) {
    const page = await pageModel(format, attackerName, defenderName);
    const outcome = await damage({ attacker: attackerName, defender: defenderName, format });
    if (!outcome.calculation) {
      ok(`/damage answers for ${attackerName} vs ${defenderName} in ${format}`, false, JSON.stringify(Object.keys(outcome)));
      continue;
    }
    const bot = outcome.calculation;
    const label = `${format} ${attackerName} → ${defenderName}`;

    // The set the bot starts from has to be the set the page starts from, or
    // every number after it is answering a different question.
    check(`${label}: attacker set matches the page's`, bot.attacker.set, page.state.mons[LEFT].set);
    check(`${label}: defender set matches the page's`, bot.defender.set, page.state.mons[RIGHT].set);
    check(`${label}: weather matches the page's`, bot.conditions.weather, page.effectiveWeather());
    check(`${label}: terrain matches the page's`, bot.conditions.terrain, page.effectiveTerrain());

    const pageMoves = page.mon(LEFT).moves.filter(Boolean);
    for (let index = 0; index < pageMoves.length; index += 1) {
      const want = page.calculate(LEFT, index, false);
      const got = bot.results.find((entry) => entry.index === index);
      if (!want) { ok(`${label}: the page has a result for move ${index}`, !got); continue; }
      ok(`${label}: the bot has a result for ${pageMoves[index]}`, Boolean(got));
      if (!got) continue;
      compared += 1;
      check(`${label}: ${pageMoves[index]} rolls`, got.result.rolls, want.rolls);
      check(`${label}: ${pageMoves[index]} range`, got.result.range, want.range);
      check(`${label}: ${pageMoves[index]} percent`, got.result.percent, want.percent);
      check(`${label}: ${pageMoves[index]} ko`, got.result.ko, want.ko);
      check(`${label}: ${pageMoves[index]} KO odds`, koLine(bot.model, got.result), koLine(page, want));
    }
    // The move the reply leads with is the page's own pick, not a new rule.
    const best = page.bestMove(LEFT);
    check(`${label}: leads with the page's best move`, bot.chosen?.move || "", best?.move || "");
  }
}
ok(`compared at least 100 move results against the page (${compared})`, compared >= 100, String(compared));

// A named move goes through the same path: select it on the page, ask for it in
// Discord, and the two have to agree.
for (const [attackerName, defenderName, move] of [
  ["Rillaboom", "Incineroar", "Wood Hammer"],
  ["Garchomp", "Rillaboom", "Earthquake"],
  ["Weavile", "Incineroar", "Ice Punch"]
]) {
  const page = await pageModel("Doubles", attackerName, defenderName);
  const index = page.mon(LEFT).moves.findIndex((name) => compact(name) === compact(move));
  const outcome = await damage({ attacker: attackerName, defender: defenderName, move });
  const got = outcome.calculation?.chosen;
  if (index < 0) {
    ok(`${attackerName} runs ${move} on its most used set`, Boolean(got), "fixture drifted; pick another move");
    continue;
  }
  const want = page.calculate(LEFT, index, false);
  check(`${attackerName} ${move} range matches the page`, got?.result.range, want.range);
  check(`${attackerName} ${move} percent matches the page`, got?.result.percent, want.percent);
  const crit = await damage({ attacker: attackerName, defender: defenderName, move, crit: true });
  check(`${attackerName} ${move} crit matches the page`, crit.calculation?.chosen?.result.range, page.calculate(LEFT, index, true).range);
}

// ------------------------------------------------- 2. the two weather traps

const { data: botData, dictionaries: dicts } = await builderFor(site, "Doubles", new TtlCache());
const calcFor = (options) => buildCalculation({
  data: botData,
  dictionaries: dicts,
  format: options.format || "Doubles",
  attacker: { profile: { name: options.attacker, form: null, identity: null }, pair: botData.resolveName(options.attacker) },
  defender: { profile: { name: options.defender, form: null, identity: null }, pair: botData.resolveName(options.defender) },
  options: { weather: "Auto", terrain: "Auto", ...options }
});

// effectiveWeather() only reads state.weather when weatherMode is not "Auto", so
// a weather option that set the value alone would silently do nothing.
const sunny = calcFor({ attacker: "Torkoal", defender: "Rillaboom", move: "Eruption" });
check("Auto reads Drought off the field", sunny.conditions.weather, "Sun");
check("Auto names the ability that set it", sunny.conditions.weatherFrom, "Drought");
const rained = calcFor({ attacker: "Torkoal", defender: "Rillaboom", move: "Eruption", weather: "Rain" });
check("weather: Rain overrides Drought", rained.conditions.weather, "Rain");
ok("weather: Rain changes the number", rained.chosen.result.range !== sunny.chosen.result.range,
  `${rained.chosen.result.range} vs ${sunny.chosen.result.range}`);
const clear = calcFor({ attacker: "Torkoal", defender: "Rillaboom", move: "Eruption", weather: "None" });
check("weather: None suppresses Drought", clear.conditions.weather, "None");
ok("weather: None changes the number", clear.chosen.result.range !== sunny.chosen.result.range);

// effectiveTerrain() ignores an explicit "None" and then scans both sides'
// abilities, so "None" is only real as the ability override the page's chips use.
const grassy = calcFor({ attacker: "Garchomp", defender: "Rillaboom", move: "Earthquake" });
check("Auto reads Grassy Surge off the field", grassy.conditions.terrain, "Grassy");
const bare = calcFor({ attacker: "Garchomp", defender: "Rillaboom", move: "Earthquake", terrain: "None" });
check("terrain: None really clears it", bare.conditions.terrain, "None");
ok("terrain: None changes Earthquake's number", bare.chosen.result.range !== grassy.chosen.result.range,
  `${bare.chosen.result.range} vs ${grassy.chosen.result.range}`);
const electric = calcFor({ attacker: "Garchomp", defender: "Rillaboom", move: "Earthquake", terrain: "Electric" });
check("terrain: Electric replaces Grassy", electric.conditions.terrain, "Electric");

// The spread note is read off the move's own meta in the context that was used:
// most spread moves keep the reduction for one target and a few do not, so a
// blanket sentence would be wrong for one group or the other.
ok("Earthquake in Doubles says the spread reduction", grassy.conditions.spreadNote.includes("25%"));
check("a single-target move says nothing about spread",
  calcFor({ attacker: "Garchomp", defender: "Rillaboom", move: "Dragon Claw" }).conditions.spreadNote, "");
check("Singles never says it",
  calcFor({ attacker: "Garchomp", defender: "Rillaboom", move: "Earthquake", format: "Singles" }).conditions.spreadNote, "");

// ------------------------------------------------------ 3. the parser table

const parse = (text, extra = {}) => {
  const set = setFromCommon(botData.commonSet("Doubles", "Rillaboom", "Rillaboom"));
  const entry = defaultMonState(set);
  const outcome = parseSetText(text, { data: botData, dictionaries: dicts, set, entry, ...extra });
  return { ...outcome, set, entry };
};

check("splitNumeric reads a number then a stat", splitNumeric("32 atk"), { pre: "", amount: 32, post: "", pct: "", word: "atk" });
check("splitNumeric reads a stat then a number", splitNumeric("atk 32"), { pre: "", amount: 32, post: "", pct: "", word: "atk" });
check("splitNumeric reads them glued", splitNumeric("32atk"), { pre: "", amount: 32, post: "", pct: "", word: "atk" });
check("splitNumeric reads a leading sign as a stage", splitNumeric("+2 atk"), { pre: "+", amount: 2, post: "", pct: "", word: "atk" });
check("splitNumeric reads a trailing sign as a nature mark", splitNumeric("252+ Atk"), { pre: "", amount: 252, post: "+", pct: "", word: "Atk" });
check("splitNumeric reads a percent", splitNumeric("60%"), { pre: "", amount: 60, post: "", pct: "%", word: "" });
check("splitNumeric refuses a word", splitNumeric("adamant"), null);

const TABLE = [
  ["32 atk", { bonuses: [32, 32, 0, 0, 0, 2] }, ["32 Atk"], []],
  ["atk 32, spe 32", { bonuses: [32, 32, 0, 0, 0, 32] }, ["32 Atk", "32 Spe"], []],
  ["0 hp", { bonuses: [0, 32, 0, 0, 0, 2] }, ["0 HP"], []],
  ["Life Orb", { item: "Life Orb" }, ["Life Orb"], []],
  ["no item", { item: "" }, ["no item"], []],
  ["miracle seed", { item: "Miracle Seed" }, ["Miracle Seed"], []],
  ["never-melt ice", { item: "Never-Melt Ice" }, ["Never-Melt Ice"], []],
  ["never melt ice", { item: "Never-Melt Ice" }, ["Never-Melt Ice"], []],
  ["Rough Skin", { ability: "Rough Skin" }, ["Rough Skin"], []],
  ["adamant", { nature: "Adamant" }, ["Adamant"], []],
  ["timid nature", { nature: "Timid" }, ["Timid"], []],
  ["252+ Atk / 0- Spe", { bonuses: [32, 32, 0, 0, 0, 0], nature: "Brave" }, ["32 Atk", "0 Spe", "Brave (from the + and − marks)"], []],
  ["252+ Atk / 0- SpA", { nature: "Adamant" }, ["32 Atk", "0 SpA", "Adamant (from the + and − marks)"], []],
  ["99 spa", { bonuses: [32, 32, 0, 32, 0, 2] }, ["32 SpA"], []],
];
for (const [text, wantSet, wantRead, wantUnread] of TABLE) {
  const got = parse(text);
  for (const [key, value] of Object.entries(wantSet)) check(`parse ${JSON.stringify(text)} → ${key}`, got.set[key], value);
  check(`parse ${JSON.stringify(text)} → read`, got.read, wantRead);
  check(`parse ${JSON.stringify(text)} → unread`, got.unread, wantUnread);
}

// The page stores a healthy Pokemon as "", never as "Healthy"; the literal turns
// Guts, Quick Feet, Marvel Scale, Facade and Hex on for a healthy Pokemon.
check("burned is stored as the status", parse("burned").entry.status, "Burned");
check("healthy is stored as an empty status, not \"Healthy\"", parse("healthy").entry.status, "");
check("toxic means Badly Poisoned", parse("toxic").entry.status, "Badly Poisoned");
check("slp means Asleep", parse("slp").entry.status, "Asleep");
check("female is a gender", parse("female").entry.gender, "Female");
check("60% is HP left", parse("60%").entry.hp, 60);
check("32 hp is HP points, not HP left", parse("32 hp").entry.hp, 100);
check("hp 32 is HP points too", parse("hp 32").set.bonuses[0], 32);
check("+2 atk is a stat stage", parse("+2 atk").entry.stages.attack_stage, 2);
check("-1 spe is a stat stage", parse("-1 spe").entry.stages.speed_stage, -1);
check("a stage is clamped to +6", parse("+9 atk").entry.stages.attack_stage, 6);
check("a bare +2 uses the move's stat when one is known", parse("+2", { categoryStat: "sp_attack" }).entry.stages.sp_attack_stage, 2);
ok("a bare +2 with no move is reported, not guessed", parse("+2").unread.join(" ").includes("which stat"));
ok("a point number over the cap is said out loud", parse("99 spa").notes.join(" ").includes(String(MAX_BONUS_POINTS_PER_STAT)));
ok("an over-budget spread is a note, not a refusal",
  parse("32 hp, 32 atk, 32 def").notes.join(" ").includes(String(MAX_BONUS_STAT_POINTS)));
ok("an over-budget spread still parses", parse("32 hp, 32 atk, 32 def").unread.length === 0);
ok("a level is refused with a reason", parse("level 100").unread.join(" ").includes("always 50"));
check("a refused word swallows its number", parse("level 100").unread.length, 1);
ok("EVs are named as not existing", parse("252 evs").unread.join(" ").includes("no EVs"));
ok("an unknown multi-word name says the game has no such thing",
  parse("Choice Band").unread.join(" ").includes("no held item"));
ok("a near miss suggests the real name", parse("Lif Orb").unread.join(" ").includes("Life Orb"));
ok("a battlefield switch in a set box is sent to the right box",
  parse("spikes 2").unread.join(" ").includes("`field`"));
ok("consecutive unread words are reported as one phrase", parse("total nonsense here").unread.length === 1);
check("an empty box reads nothing and complains about nothing", parse(""), { read: [], unread: [], notes: [], set: parse("").set, entry: parse("").entry });

// ------------------------------------------------------ 4. the field table

const field = (text) => parseFieldText(text);
check("reflect is the defender's", field("reflect").field.defender.reflect, true);
check("light screen is the defender's", field("light screen").field.defender.light_screen, true);
check("aurora veil is the defender's", field("aurora veil").field.defender.aurora_veil, true);
check("friend guard is the defender's", field("friend guard").field.defender.friend_guard, true);
check("helping hand is the attacker's", field("helping hand").field.attacker.helping_hand, true);
check("stealth rock is the defender's", field("stealth rock").field.defender.stealth_rock, true);
check("spikes takes a number", field("spikes 2").field.defender.spikes, 2);
check("spikes glued to its number works too", field("spikes2").field.defender.spikes, 2);
check("spikes is clamped to three layers", field("spikes 9").field.defender.spikes, 3);
check("bare spikes means the most", field("spikes").field.defender.spikes, 3);
check("hits is a per-move count", field("hits 5").counts.hits, 5);
check("use is a per-move count", field("use 3").counts.times_used, 3);
check("times hit is Rage Fist's", field("times hit 4").values.times_hit, 4);
check("fainted is Supreme Overlord's", field("fainted 2").values.fainted_allies, 2);
check("gravity is a context switch", field("gravity").ctx.gravity, true);
check("wonder room is a context switch", field("wonder room").ctx.wonder_room, true);
check("switching is Stakeout's", field("switching").ctx.defender_switching, true);
check("moved first turns Analytic off", field("moved first").ctx.attacker_moved_first, true);
ok("tailwind is refused with its reason", field("tailwind").unread.join(" ").includes("not damage"));
check("a comma list reads every switch", field("reflect, light screen, spikes 3").read,
  ["Reflect", "Light Screen", "Spikes 3"]);
check("a space list reads every switch too", field("reflect light screen spikes 3").read,
  ["Reflect", "Light Screen", "Spikes 3"]);
ok("an unknown switch is reported", field("wobble").unread.length === 1);
ok("every field token has a label", FIELD_TOKENS.every((token) => token.label && token.keys.length));

// The switches have to reach the engine, not just the echo.
const plain = calcFor({ attacker: "Weavile", defender: "Rillaboom", move: "Ice Beam" });
// Reflect halves physical damage and Light Screen special, so each screen is
// checked against a move it is supposed to reach -- and Reflect is checked
// against a special move too, where it must do nothing.
for (const row of [
  ["reflect", "Reflect", "Ice Punch", "", false],
  ["light screen", "Light Screen", "Ice Beam", "", false],
  ["reflect", "Reflect on a special move", "Ice Beam", "", true],
  ["helping hand", "Helping Hand", "Ice Beam", "", false],
  ["wonder room", "Wonder Room", "Ice Beam", "", false],
  ["switching", "a switching defender", "Ice Beam", "Stakeout", false]
]) {
  const [text, why, move, set, expectSame] = row;
  const base = calcFor({ attacker: "Weavile", defender: "Rillaboom", move, attacker_set: set });
  const with_ = calcFor({ attacker: "Weavile", defender: "Rillaboom", move, attacker_set: set, field: text });
  const same = with_.chosen.result.range === base.chosen.result.range;
  ok(`${why} ${expectSame ? "leaves the number alone" : "changes the number"}`, same === expectSame,
    `${with_.chosen.result.range} vs ${base.chosen.result.range}`);
}
// Hazards move the defender's current HP, so the range is unchanged and the KO
// line is not. A test that only watched the range would call this a no-op.
const hazard = calcFor({ attacker: "Weavile", defender: "Rillaboom", move: "Ice Beam", field: "spikes 3" });
check("spikes leaves the range alone", hazard.chosen.result.range, plain.chosen.result.range);
ok("spikes moves the KO line", hazard.koOdds !== plain.koOdds, `${hazard.koOdds} vs ${plain.koOdds}`);
// A hit count reaches the engine and is named back.
const spear = calcFor({ attacker: "Weavile", defender: "Rillaboom", move: "Icicle Spear" });
const spear5 = calcFor({ attacker: "Weavile", defender: "Rillaboom", move: "Icicle Spear", field: "hits 5" });
ok("a hit count changes the number", spear.chosen.result.range !== spear5.chosen.result.range);
check("and is named in the reply", spear5.conditions.moveNotes, ["5 hits"]);

// ------------------------------------------------- 5. the KO boundary rows

const bareModel = Object.create(CalcModel.prototype);
const repeat = (count, value) => Array.from({ length: count }, () => value);
const KO_ROWS = [
  ["every roll kills", { rolls: repeat(16, 100) }, "Guaranteed OHKO"],
  ["half the rolls kill", { rolls: [...repeat(8, 100), ...repeat(8, 50)] }, "50% chance to OHKO · Guaranteed 2HKO"],
  ["one roll kills", { rolls: [...repeat(1, 100), ...repeat(15, 50)] }, "6.2% chance to OHKO · Guaranteed 2HKO"],
  ["all but one kill", { rolls: [...repeat(15, 100), ...repeat(1, 50)] }, "93.8% chance to OHKO · Guaranteed 2HKO"],
  ["exactly half the HP", { rolls: repeat(16, 50) }, "Guaranteed 2HKO"],
  ["one short of half", { rolls: repeat(16, 49) }, "Guaranteed 3HKO"],
  ["no damage at all", { rolls: repeat(16, 0), ko: "No direct damage." }, "No direct damage."],
  ["one point a hit", { rolls: repeat(16, 1) }, "No KO chance within 8 hits"],
  ["Focus Sash", { rolls: repeat(16, 200), focus_sash_active: true }, "Focus Sash prevents the OHKO · Guaranteed 2HKO if the next hit lands"],
  ["Sturdy", { rolls: repeat(16, 200), sturdy_active: true }, "Sturdy prevents the OHKO · Guaranteed 2HKO if the next hit lands"],
  ["Sitrus Berry", { rolls: repeat(16, 60), sitrus_berry_active: true, sitrus_heal: 25, move_accuracy_factor: 1 }, "Guaranteed 3HKO after Sitrus Berry"],
  ["Salt Cure rides along", { rolls: repeat(16, 100), ko: "Guaranteed OHKO | Salt Cure: 1/8 max HP/turn" }, "Guaranteed OHKO · Salt Cure: 1/8 max HP/turn"]
];
for (const [label, result, want] of KO_ROWS) {
  check(`KO wording: ${label}`, koLine(bareModel, { current_hp: 100, max_hp: 100, ...result }), want);
}
check("no result is no line", koLine(bareModel, null), "");

// ------------------------------------------- 6. the command and the reply

const definition = COMMANDS.find((command) => command.name === "damage");
ok("/damage is in the one definition list", Boolean(definition));
const names = (definition.options || []).map((option) => option.name);
check("the two required options come first", names.slice(0, 2), ["attacker", "defender"]);
ok("only attacker and defender are required",
  (definition.options || []).filter((option) => option.required).map((option) => option.name).join(",") === "attacker,defender");
ok("at most 25 options", names.length <= 25, String(names.length));
ok("every autocompleting option is in AUTOCOMPLETE_KINDS",
  (definition.options || []).filter((option) => option.autocomplete).every((option) => AUTOCOMPLETE_KINDS[option.name]));
ok("the move box completes from the attacker", SUBJECT_OPTIONS.includes("attacker"));
ok("every option description fits Discord's 100 characters",
  (definition.options || []).every((option) => option.description.length <= 100));
ok("the description says the default out loud", /most used/i.test(definition.description));
// The examples in the option descriptions have to name things this game holds:
// there is no Choice Band and no Assault Vest in Pokemon Champions.
for (const option of definition.options || []) {
  for (const quoted of option.description.match(/"([^"]+)"/g) || []) {
    const text = quoted.replace(/"/g, "");
    const outcome = option.name === "field" ? parseFieldText(text) : parse(text);
    ok(`the example in ${option.name}'s description parses`, outcome.read.length > 0 && outcome.unread.length === 0,
      `${quoted} → unread ${JSON.stringify(outcome.unread)}`);
  }
}

// The reply, through the router, with the real embed limits.
const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, fields: 25, total: 6000 };
function embedProblems(payload, label) {
  const problems = [];
  for (const embed of payload?.embeds || []) {
    let total = 0;
    const measure = (text) => { total += String(text || "").length; return String(text || "").length; };
    if (measure(embed.title) > LIMITS.title) problems.push("title too long");
    if (measure(embed.description) > LIMITS.description) problems.push("description too long");
    if (measure(embed.footer?.text) > LIMITS.footer) problems.push("footer too long");
    if (measure(embed.author?.name) > LIMITS.author) problems.push("author too long");
    const fields = embed.fields || [];
    if (fields.length > LIMITS.fields) problems.push("too many fields");
    for (const item of fields) {
      if (measure(item.name) > LIMITS.fieldName) problems.push(`field name too long (${item.name})`);
      if (!String(item.name || "").length) problems.push("empty field name");
      if (measure(item.value) > LIMITS.fieldValue) problems.push(`field value too long (${item.name})`);
      if (!String(item.value || "").length) problems.push(`empty field value (${item.name})`);
    }
    if (total > LIMITS.total) problems.push(`embed over ${LIMITS.total} characters (${total})`);
    for (const url of [embed.url, embed.thumbnail?.url].filter(Boolean)) {
      if (!url.startsWith(`${ORIGIN}/`)) problems.push(`off-site url ${url}`);
    }
  }
  for (const row of payload?.components || []) {
    for (const button of row.components || []) {
      if (button.style !== 5 || !button.url) problems.push("button is not a link button");
      if (String(button.url || "").length > 512) problems.push(`button url over 512 characters (${button.url.length})`);
      if (!String(button.url || "").startsWith(`${ORIGIN}/`)) problems.push(`off-site button ${button.url}`);
    }
  }
  return problems.map((problem) => `${label}: ${problem}`);
}

async function reply(options) {
  const list = Object.entries(options).map(([name, value]) => ({ name, value }));
  const routed = await routeInteraction(
    { type: 2, application_id: "1", token: "t", data: { name: "damage", options: list } },
    { data: site, origin: ORIGIN, cache: null }
  );
  ok(`/damage defers before it calculates (${JSON.stringify(options).slice(0, 40)})`, routed.response.type === 5);
  return routed.work();
}

const SCENARIOS = [
  ["defaults", { attacker: "Rillaboom", defender: "Incineroar" }],
  ["a named move", { attacker: "Rillaboom", defender: "Incineroar", move: "Wood Hammer" }],
  ["fully customized", {
    attacker: "Rillaboom", defender: "Incineroar", move: "Wood Hammer",
    attacker_set: "Life Orb, +2 atk, 32 spe, Adamant, burned",
    defender_set: "Rocky Helmet, 32 hp, 32 spd, 60%",
    field: "reflect, helping hand, spikes 2", crit: true, weather: "Sun", terrain: "None", defender_hp: 40
  }],
  ["a Mega by name", { attacker: "Charizard-Mega-Y", defender: "Rillaboom" }],
  ["Singles", { attacker: "Garchomp", defender: "Rillaboom", format: "Singles" }],
  ["a move it does not learn", { attacker: "Rillaboom", defender: "Incineroar", move: "Ice Beam" }],
  ["a move that does not exist", { attacker: "Rillaboom", defender: "Incineroar", move: "Hyper Wobble" }],
  ["free text nobody can read", { attacker: "Rillaboom", defender: "Incineroar", attacker_set: "blah blah blah" }],
  ["an unknown attacker", { attacker: "Nonsense", defender: "Rillaboom" }]
];
for (const [label, options] of SCENARIOS) {
  const payload = await reply(options);
  for (const problem of embedProblems(payload, label)) failures.push(problem);
  checked += 1;
  ok(`${label}: the reply offers a way back to the site`,
    (payload.components || []).reduce((total, row) => total + (row.components || []).length, 0) > 0);
}

const defaults = await reply({ attacker: "Rillaboom", defender: "Incineroar" });
const embed = defaults.embeds[0];
ok("the default reply says which set it used", /most used Doubles set/.test(embed.description));
ok("the default reply lists all four moves", (embed.fields || []).some((entry) => entry.name === "All four moves"));
ok("the default reply shows the set", (embed.fields || []).some((entry) => /Miracle Seed/.test(entry.value)));
ok("the button opens the calculator on the same pair",
  defaults.components[0].components[0].url === calculatorUrl("Rillaboom", "Incineroar", "Doubles", ORIGIN));
ok("the footer says the link opens the default sets", /most used sets/.test(embed.footer.text));

const named = await reply({ attacker: "Rillaboom", defender: "Incineroar", move: "Wood Hammer" });
ok("a named move drops the four-move list",
  !(named.embeds[0].fields || []).some((entry) => entry.name === "All four moves"));
ok("a named move leads with that move", named.embeds[0].description.startsWith("**Wood Hammer**"));

const custom = await reply({
  attacker: "Rillaboom", defender: "Incineroar",
  attacker_set: "Life Orb, +2 atk", defender_set: "60%", field: "reflect, tailwind, wobble"
});
const readAs = (custom.embeds[0].fields || []).find((entry) => entry.name === "Read as");
const notRead = (custom.embeds[0].fields || []).find((entry) => entry.name === "Not understood");
ok("customization is echoed back", readAs && /Life Orb/.test(readAs.value) && /\+2 Atk/.test(readAs.value));
ok("what could not be read is printed, not dropped", notRead && /wobble/.test(notRead.value) && /tailwind/i.test(notRead.value));
ok("a customized reply says it was customized", /customized/.test(custom.embeds[0].description));

const unknownMove = await reply({ attacker: "Rillaboom", defender: "Incineroar", move: "Hyper Wobble" });
ok("an unknown move falls back to the four moves, and says so",
  /No move called/.test(unknownMove.embeds[0].description)
  && (unknownMove.embeds[0].fields || []).some((entry) => entry.name === "All four moves"));

const illegal = await reply({ attacker: "Rillaboom", defender: "Incineroar", move: "Ice Beam" });
ok("a move it cannot learn is calculated and noted", /does not learn/.test(illegal.embeds[0].description));
ok("and the move it replaced is named", /stands in for/.test(illegal.embeds[0].description));

// ---------------------------------------------------------------- report

console.log(`${checked} checks, ${compared} move results compared against the page`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("All /damage checks passed.");
