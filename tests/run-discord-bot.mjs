// Discord bot checks: the interactions endpoint, the command routing, the name
// resolver and the shape of every reply.
//
//   node tests/run-discord-bot.mjs
//
// Signatures are real: the test generates an Ed25519 keypair and signs bodies
// the way Discord does, so a good signature, a tampered one and a replayed
// timestamp are all exercised against the code that runs in production.
//
// The replies are built twice. Once on small fixtures written out below, so a
// day's new battle data cannot change what an embed is supposed to contain, and
// once on this repo's real data/ files, which is what catches a field being
// renamed upstream. Both go through functions/api/discord/*, never a copy.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SiteData, editDistance, matchScore, finalStat, defensiveChart, rankNames } from "../functions/api/discord/_data.js";
import { verifySignature, hexToBytes, MAX_SIGNATURE_AGE_SECONDS } from "../functions/api/discord/_verify.js";
import { TtlCache, replyKey, TTL_MS, MAX_ENTRIES } from "../functions/api/discord/_cache.js";
import { COMMANDS, COMMAND_NAMES, IMMEDIATE_COMMANDS, AUTOCOMPLETE_KINDS, TYPE_NAMES, optionValue } from "../functions/api/discord/_commands.js";
import {
  routeInteraction, onRequestPost, onRequestGet, discordFetch, sendFollowUp, withBudget,
  AUTOCOMPLETE_LIMIT, RESPONSE_PONG, RESPONSE_MESSAGE, RESPONSE_DEFERRED, RESPONSE_AUTOCOMPLETE
} from "../functions/api/discord/interactions.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ORIGIN = "https://championsbattledata.com";

let checked = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  checked += 1;
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

// ------------------------------------------------------------------ fixtures

const stats = (hp, attack, defense, spa, spd, speed) => ({ hp, attack, defense, sp_attack: spa, sp_defense: spd, speed });
const sprite = (name) => `pokemon_champions_assets/pokemon/${name}.png`;

const FIXTURES = {
  "data/api/lookup.json": {
    aliases: { garchomp: "garchomp", rillaboom: "rillaboom", weavile: "weavile", indeedeef: "indeedee-f" }
  },
  "data/meta/index.json": {
    seasons: [{ season: "M6", dates: ["24_09_2026", "23_09_2026"], formats: ["Doubles", "Singles"] }],
    pokemon: {
      Garchomp: { name: "Garchomp", baseName: "Garchomp", slug: "garchomp", sprite: sprite("Garchomp"), types: ["Dragon", "Ground"] },
      Rillaboom: { name: "Rillaboom", baseName: "Rillaboom", slug: "rillaboom", sprite: sprite("Rillaboom"), types: ["Grass"] },
      Weavile: { name: "Weavile", baseName: "Weavile", slug: "weavile", sprite: sprite("Weavile"), types: ["Dark", "Ice"] },
      "Indeedee-F": { name: "Indeedee-F", baseName: "Indeedee", slug: "indeedee-f", sprite: sprite("Indeedee Female"), types: ["Psychic", "Normal"] }
    }
  },
  "data/builder/app-data.json": {
    types: TYPE_NAMES,
    natures: { Adamant: ["ATK", "SPA"], Jolly: ["SPE", "SPA"], Modest: ["SPA", "ATK"], Relaxed: ["DEF", "SPE"] },
    typeChart: {
      Ice: { Dragon: 2, Ground: 2, Grass: 2, Fire: 0.5, Water: 0.5, Ice: 0.5, Steel: 0.5 },
      Dragon: { Dragon: 2, Steel: 0.5, Fairy: 0 },
      Grass: { Ground: 2, Water: 2, Grass: 0.5, Fire: 0.5, Dragon: 0.5, Steel: 0.5, Ice: 0.5 },
      Fighting: { Dark: 2, Ice: 2, Steel: 2, Psychic: 0.5, Fairy: 0.5 },
      Ground: { Fire: 2, Steel: 2, Grass: 0.5, Ice: 1 },
      Fairy: { Dragon: 2, Dark: 2, Fighting: 2, Fire: 0.5, Steel: 0.5 },
      Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
      Electric: { Ground: 0, Water: 2, Flying: 2, Grass: 0.5, Electric: 0.5, Dragon: 0.5 },
      Fire: { Grass: 2, Ice: 2, Steel: 2, Dragon: 0.5, Water: 0.5 }
    },
    moves: {
      Protect: { type: "Normal", category: "status", power: 0 },
      "Dragon Claw": { type: "Dragon", category: "physical", power: 80 },
      Earthquake: { type: "Ground", category: "physical", power: 100 },
      "Grassy Glide": { type: "Grass", category: "physical", power: 55 },
      "Ice Punch": { type: "Ice", category: "physical", power: 75 },
      "Icy Wind": { type: "Ice", category: "special", power: 55 }
    },
    items: [{ name: "Life Orb", sprite: "pokemon_champions_assets/items/Life Orb.png" }],
    species: [
      {
        name: "Garchomp",
        forms: [
          { form: "Garchomp", kind: "Base", types: ["Dragon", "Ground"], abilities: ["Sand Veil", "Rough Skin"], stats: stats(183, 150, 115, 100, 105, 122), sprite: sprite("Garchomp") },
          { form: "Mega Garchomp", kind: "Mega", types: ["Dragon", "Ground"], abilities: ["Sand Force"], stats: stats(183, 190, 135, 140, 115, 112), sprite: sprite("Mega Garchomp") }
        ]
      },
      { name: "Rillaboom", forms: [{ form: "Rillaboom", kind: "Base", types: ["Grass"], abilities: ["Grassy Surge"], stats: stats(170, 160, 110, 90, 100, 105), sprite: sprite("Rillaboom") }] },
      { name: "Weavile", forms: [{ form: "Weavile", kind: "Base", types: ["Dark", "Ice"], abilities: ["Pressure"], stats: stats(145, 150, 95, 75, 105, 145), sprite: sprite("Weavile") }] },
      { name: "Indeedee", forms: [{ form: "Indeedee Female", kind: "Base", types: ["Psychic", "Normal"], abilities: ["Psychic Surge"], stats: stats(150, 80, 100, 125, 130, 105), sprite: sprite("Indeedee Female") }] }
    ]
  },
  "data/descriptions.json": {
    items: { "Life Orb": "Boosts move power by 30% at the cost of 10% of the holder's max HP per attack." },
    abilities: { "Rough Skin": "Attackers that make contact take damage." }
  },
  "data/builder/meta-doubles.json": {
    format: "Doubles",
    pokemon: [
      {
        name: "Garchomp", species: "Garchomp", form: "Garchomp", position: 1,
        set: { moves: ["Protect", "Dragon Claw", "Earthquake", "Grassy Glide"], item: "Life Orb", ability: "Rough Skin", nature: "Jolly", bonuses: [2, 32, 0, 0, 0, 32] },
        moves: [["Protect", 80.6], ["Dragon Claw", 44.5], ["Earthquake", 41.4]],
        items: [["Life Orb", 45.2], ["Choice Scarf", 20.1]],
        abilities: [["Rough Skin", 97]],
        teammates: ["Rillaboom", "Weavile"],
        natures: [["Jolly", 34.3]],
        spreads: [[10.6, [2, 32, 0, 0, 0, 32]]]
      },
      {
        name: "Rillaboom", species: "Rillaboom", form: "Rillaboom", position: 2,
        set: { moves: ["Grassy Glide", "Protect"], item: "Miracle Seed", ability: "Grassy Surge", nature: "Adamant", bonuses: [32, 32, 0, 0, 0, 2] },
        moves: [["Grassy Glide", 97.5], ["Protect", 11.9]],
        items: [["Miracle Seed", 56.7]],
        abilities: [["Grassy Surge", 99.9]],
        teammates: ["Garchomp", "Weavile"],
        natures: [["Adamant", 85]],
        spreads: [[10.6, [32, 32, 0, 0, 0, 2]]]
      },
      {
        name: "Weavile", species: "Weavile", form: "Weavile", position: 3,
        set: { moves: ["Ice Punch", "Protect"], item: "Focus Sash", ability: "Pressure", nature: "Jolly", bonuses: [0, 32, 0, 0, 0, 32] },
        moves: [["Ice Punch", 88.2], ["Protect", 30]],
        items: [["Focus Sash", 61.4]],
        abilities: [["Pressure", 100]],
        teammates: ["Garchomp"],
        natures: [["Jolly", 90]],
        spreads: [[20, [0, 32, 0, 0, 0, 32]]]
      },
      {
        name: "Indeedee-F", species: "Indeedee", form: "Indeedee Female", position: 4,
        set: { moves: ["Protect"], item: "Safety Goggles", ability: "Psychic Surge", nature: "Relaxed", bonuses: [32, 0, 32, 0, 2, 0] },
        moves: [["Protect", 70]],
        items: [["Safety Goggles", 50]],
        abilities: [["Psychic Surge", 100]],
        teammates: ["Rillaboom"],
        natures: [["Relaxed", 60]],
        spreads: [[12, [32, 0, 32, 0, 2, 0]]]
      }
    ]
  }
};
// Singles is the same file with a different order, so a `format` argument that
// silently did nothing would show up as the same ranking twice.
FIXTURES["data/builder/meta-singles.json"] = {
  format: "Singles",
  pokemon: FIXTURES["data/builder/meta-doubles.json"].pokemon
    .map((row, index) => ({ ...row, position: [3, 1, 2, 4][index] }))
    .sort((a, b) => a.position - b.position)
};

function fixtureEnv() {
  const reads = [];
  return {
    reads,
    ASSETS: {
      async fetch(url) {
        const path = new URL(url).pathname.replace(/^\/+/, "");
        reads.push(path);
        const value = FIXTURES[path];
        if (value === undefined) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(value), { status: 200 });
      }
    }
  };
}

function diskEnv() {
  return {
    ASSETS: {
      async fetch(url) {
        const path = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, "");
        try {
          return new Response(readFileSync(join(root, ...path.split("/"))), { status: 200 });
        } catch {
          return new Response("not found", { status: 404 });
        }
      }
    }
  };
}

const request = () => new Request(`${ORIGIN}/api/discord/interactions`, { method: "POST" });
// A cache of its own per SiteData, so one scenario cannot warm another's reads.
const siteData = (env, cache = new TtlCache()) => new SiteData(env, request(), { origin: ORIGIN, cache });

// ------------------------------------------------------- Discord embed limits

const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, fields: 25, total: 6000 };

function embedProblems(payload, label) {
  const problems = [];
  const embeds = payload?.embeds || [];
  if (!embeds.length) problems.push("no embed");
  if (embeds.length > 10) problems.push("more than 10 embeds");
  for (const embed of embeds) {
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
  const rows = payload?.components || [];
  if (rows.length > 5) problems.push("too many component rows");
  for (const row of rows) {
    if (row.type !== 1) problems.push("component row is not an action row");
    if ((row.components || []).length > 5) problems.push("more than five buttons in a row");
    for (const button of row.components || []) {
      if (button.style !== 5 || !button.url) problems.push("button is not a link button");
      if (String(button.label || "").length > 80) problems.push("button label too long");
      if (!String(button.url || "").startsWith(`${ORIGIN}/`)) problems.push(`off-site button ${button.url}`);
    }
  }
  return problems.map((problem) => `${label}: ${problem}`);
}

/** Every reply must offer at least one way back to the site. */
function linkCount(payload) {
  return (payload?.components || []).reduce((total, row) => total + (row.components || []).length, 0);
}

const textOf = (payload) => JSON.stringify(payload);

// ----------------------------------------------------- 1. signature checking

const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const publicKeyHex = [...new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function sign(body, timestamp) {
  const signed = new TextEncoder().encode(`${timestamp}${body}`);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, signed));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signedRequest(body, timestamp, signature) {
  return new Request(`${ORIGIN}/api/discord/interactions`, {
    method: "POST",
    headers: { "x-signature-ed25519": signature, "x-signature-timestamp": String(timestamp) },
    body
  });
}

const now = 1_800_000_000_000;
const nowSeconds = Math.floor(now / 1000);
const pingBody = JSON.stringify({ type: 1, application_id: "1234" });
const goodSignature = await sign(pingBody, nowSeconds);

check("a good signature verifies",
  (await verifySignature({ rawBody: pingBody, signature: goodSignature, timestamp: nowSeconds, publicKey: publicKeyHex, now })).ok);

const flipped = `${goodSignature.slice(0, -2)}${goodSignature.slice(-2) === "00" ? "01" : "00"}`;
const badSignature = await verifySignature({ rawBody: pingBody, signature: flipped, timestamp: nowSeconds, publicKey: publicKeyHex, now });
check("a tampered signature is rejected", !badSignature.ok, badSignature.reason);

const tamperedBody = await verifySignature({ rawBody: `${pingBody} `, signature: goodSignature, timestamp: nowSeconds, publicKey: publicKeyHex, now });
check("a tampered body is rejected", !tamperedBody.ok && tamperedBody.reason === "signature mismatch", tamperedBody.reason);

const replayedAt = nowSeconds - MAX_SIGNATURE_AGE_SECONDS - 60;
const replaySignature = await sign(pingBody, replayedAt);
const replayNow = await verifySignature({ rawBody: pingBody, signature: replaySignature, timestamp: replayedAt, publicKey: publicKeyHex, now });
check("a replayed timestamp is rejected even though its signature is genuine",
  !replayNow.ok && replayNow.reason === "stale timestamp", replayNow.reason);
check("that same body verified when it was fresh",
  (await verifySignature({ rawBody: pingBody, signature: replaySignature, timestamp: replayedAt, publicKey: publicKeyHex, now: replayedAt * 1000 })).ok);
check("a far-future timestamp is rejected",
  !(await verifySignature({ rawBody: pingBody, signature: goodSignature, timestamp: nowSeconds, publicKey: publicKeyHex, now: now + 3_600_000 })).ok);

check("missing headers are rejected",
  !(await verifySignature({ rawBody: pingBody, signature: "", timestamp: "", publicKey: publicKeyHex, now })).ok);
check("a non-numeric timestamp is rejected",
  !(await verifySignature({ rawBody: pingBody, signature: goodSignature, timestamp: "not-a-number", publicKey: publicKeyHex, now })).ok);
check("a short public key is rejected",
  !(await verifySignature({ rawBody: pingBody, signature: goodSignature, timestamp: nowSeconds, publicKey: "abcd", now })).ok);
check("hexToBytes refuses odd and non-hex input", hexToBytes("abc") === null && hexToBytes("zz") === null && hexToBytes("00ff").length === 2);

// The endpoint itself, end to end.
const env = { ...fixtureEnv(), DISCORD_PUBLIC_KEY: publicKeyHex };
const fresh = Math.floor(Date.now() / 1000);
const freshSignature = await sign(pingBody, fresh);

const pong = await onRequestPost({ request: signedRequest(pingBody, fresh, freshSignature), env });
check("PING answers 200 PONG", pong.status === 200 && (await pong.clone().json()).type === RESPONSE_PONG);

const rejected = await onRequestPost({ request: signedRequest(pingBody, fresh, flipped), env });
check("the endpoint answers 401 to a bad signature", rejected.status === 401, String(rejected.status));

const unsigned = await onRequestPost({ request: new Request(`${ORIGIN}/api/discord/interactions`, { method: "POST", body: pingBody }), env });
check("the endpoint answers 401 to an unsigned body", unsigned.status === 401, String(unsigned.status));

const unconfigured = await onRequestPost({ request: signedRequest(pingBody, fresh, freshSignature), env: fixtureEnv() });
check("with no DISCORD_PUBLIC_KEY nothing is accepted", unconfigured.status === 500, String(unconfigured.status));

const wrongApp = await onRequestPost({
  request: signedRequest(pingBody, fresh, freshSignature),
  env: { ...env, DISCORD_APP_ID: "9999" }
});
check("a body for another application is refused", wrongApp.status === 401, String(wrongApp.status));

const badJson = await sign("{", fresh);
const broken = await onRequestPost({ request: signedRequest("{", fresh, badJson), env });
check("a signed but unparsable body answers 400", broken.status === 400, String(broken.status));

const status = await onRequestGet({ env });
const statusBody = await status.json();
check("GET reports the route without leaking anything",
  statusBody.configured === true && statusBody.commands.length === COMMANDS.length && !textOf(statusBody).includes(publicKeyHex));

// ------------------------------------------------------------- 2. routing

const command = (name, options = []) => ({
  type: 2, application_id: "1234", token: "interaction-token", data: { name, options }
});

// Each route gets a reply cache of its own; the module-scope one is exercised
// separately below, where the cache itself is what is under test.
const routed = (name, options = [], data = siteData(fixtureEnv()), cache = new TtlCache()) =>
  routeInteraction(command(name, options), { data, origin: ORIGIN, cache });

const ping = await routeInteraction({ type: 1 }, { data: siteData(fixtureEnv()), origin: ORIGIN });
check("PING routes to PONG with no follow-up", ping.response.type === RESPONSE_PONG && !ping.work);

const help = await routed("help");
check("/help answers immediately", help.response.type === RESPONSE_MESSAGE && !help.work && help.response.data.embeds.length === 1);
check("/help is the only immediate command", [...IMMEDIATE_COMMANDS].join() === "help");

for (const name of COMMAND_NAMES) {
  const result = await routed(name, name === "matchup" ? [{ name: "type", value: "Ice" }] : [{ name: "pokemon", value: "Garchomp" }, { name: "first", value: "Garchomp" }, { name: "second", value: "Rillaboom" }]);
  const expected = IMMEDIATE_COMMANDS.has(name) ? RESPONSE_MESSAGE : RESPONSE_DEFERRED;
  check(`/${name} routes`, result.response.type === expected && Boolean(result.work) === !IMMEDIATE_COMMANDS.has(name), `type ${result.response.type}`);
  check(`/${name} is not answered as unknown`, !textOf(result.response).includes("not a command this bot knows"));
}

const unknown = await routed("nonsense");
check("an unregistered command says so, privately",
  unknown.response.type === RESPONSE_MESSAGE && unknown.response.data.flags === 64 && !unknown.work);

const notACommand = await routeInteraction({ type: 3 }, { data: siteData(fixtureEnv()), origin: ORIGIN });
check("a non-command interaction is answered privately", notACommand.response.data.flags === 64 && !notACommand.work);

const complete = await routeInteraction(
  { type: 4, data: { name: "pokemon", options: [{ name: "pokemon", value: "garch", focused: true }] } },
  { data: siteData(fixtureEnv()), origin: ORIGIN }
);
check("autocomplete answers inline with choices",
  complete.response.type === RESPONSE_AUTOCOMPLETE && !complete.work
  && complete.response.data.choices[0].name === "Garchomp"
  && complete.response.data.choices.length <= 25);

const completeEmpty = await routeInteraction(
  { type: 4, data: { name: "pokemon", options: [{ name: "pokemon", value: "", focused: true }] } },
  { data: siteData(fixtureEnv()), origin: ORIGIN }
);
check("autocomplete with nothing typed still offers names", completeEmpty.response.data.choices.length > 0);

const completeBroken = await routeInteraction(
  { type: 4, data: { name: "pokemon", options: [{ name: "pokemon", value: "x", focused: true }] } },
  { data: siteData({ ASSETS: { async fetch() { throw new Error("down"); } } }), origin: ORIGIN }
);
check("autocomplete never fails the interaction", completeBroken.response.type === RESPONSE_AUTOCOMPLETE && Array.isArray(completeBroken.response.data.choices));

check("optionValue falls back", optionValue([{ name: "top", value: 15 }], "top", 10) === 15 && optionValue([], "top", 10) === 10);

// ------------------------------------------------- 2b. autocomplete in detail

async function completeNames(commandName, options) {
  const result = await routeInteraction({ type: 4, data: { name: commandName, options } }, { data: siteData(fixtureEnv()), origin: ORIGIN });
  return result.response.data.choices.map((choice) => choice.name);
}
const focused = (name, value, rest = []) => [...rest, { name, value, focused: true }];

check("a prefix finds the name", (await completeNames("pokemon", focused("pokemon", "garch")))[0] === "Garchomp");
check("a fragment from the middle still finds it", (await completeNames("pokemon", focused("pokemon", "chomp"))).includes("Garchomp"));
check("a misspelling still finds it", (await completeNames("pokemon", focused("pokemon", "garchmop"))).includes("Garchomp"));
check("nothing matching offers nothing", (await completeNames("pokemon", focused("pokemon", "qqqqqqqq"))).length === 0);
check("a prefix outranks a contains-match",
  (await completeNames("pokemon", focused("pokemon", "ill")))[0] === "Rillaboom",
  (await completeNames("pokemon", focused("pokemon", "ill"))).join(", "));

const bothArguments = await completeNames("compare", focused("second", "weav", [{ name: "first", value: "Garchomp" }]));
check("both /compare arguments autocomplete Pokemon", bothArguments[0] === "Weavile", bothArguments.join(", "));

const movesForPokemon = await completeNames("moves", focused("move", "prot", [{ name: "pokemon", value: "Garchomp" }]));
check("a move completes from the Pokemon's own rows when one is named",
  movesForPokemon.length === 1 && movesForPokemon[0] === "Protect", movesForPokemon.join(", "));
const movesNoPokemon = await completeNames("moves", focused("move", "icy"));
check("a move still completes with no Pokemon named", movesNoPokemon.includes("Icy Wind"), movesNoPokemon.join(", "));
const movesUntyped = await completeNames("moves", focused("move", "", [{ name: "pokemon", value: "Weavile" }]));
check("an empty move box offers that Pokemon's moves", movesUntyped[0] === "Ice Punch", movesUntyped.join(", "));
const movesUnknownPokemon = await completeNames("moves", focused("move", "prot", [{ name: "pokemon", value: "zzzz" }]));
check("an unresolvable Pokemon falls back to the move table", movesUnknownPokemon.includes("Protect"));

const itemsForPokemon = await completeNames("items", focused("item", "life", [{ name: "pokemon", value: "Garchomp" }]));
check("an item completes from the Pokemon's own rows", itemsForPokemon[0] === "Life Orb", itemsForPokemon.join(", "));
const itemsNoPokemon = await completeNames("items", focused("item", "orb"));
check("an item still completes with no Pokemon named", itemsNoPokemon.includes("Life Orb"), itemsNoPokemon.join(", "));

check("an option with no name list offers nothing", (await completeNames("meta", focused("top", "1"))).length === 0);

// Every option Discord will ask us to complete has a list to complete it from,
// and nothing claims autocomplete and a choice list at once (Discord refuses).
const autocompleting = COMMANDS.flatMap((cmd) => (cmd.options || []).map((option) => ({ cmd: cmd.name, ...option })));
check("every autocompleting option has a name list",
  autocompleting.filter((option) => option.autocomplete).every((option) => AUTOCOMPLETE_KINDS[option.name]),
  autocompleting.filter((option) => option.autocomplete && !AUTOCOMPLETE_KINDS[option.name]).map((option) => `/${option.cmd} ${option.name}`).join(", "));
check("no option both autocompletes and lists choices",
  !autocompleting.some((option) => option.autocomplete && option.choices));
check("required options come before optional ones",
  COMMANDS.every((cmd) => {
    const required = (cmd.options || []).map((option) => Boolean(option.required));
    return required.indexOf(true) === -1 || required.lastIndexOf(true) < (required.indexOf(false) === -1 ? required.length : required.indexOf(false));
  }));

check("autocomplete gives up rather than making Discord wait",
  (await withBudget(new Promise(() => {}), 5, ["fallback"])).join() === "fallback");
check("autocomplete is capped at Discord's limit", AUTOCOMPLETE_LIMIT === 25);
check("rankNames returns everything when nothing is typed", rankNames("", ["B", "A"]).length === 2);

// ------------------------------------------------ 2c. the format option

const formatDependent = COMMAND_NAMES.filter((name) => !["matchup", "help"].includes(name));
for (const name of formatDependent) {
  const option = (COMMANDS.find((cmd) => cmd.name === name).options || []).find((entry) => entry.name === "format");
  check(`/${name} offers Doubles and Singles as choices`,
    option && !option.required && (option.choices || []).map((choice) => choice.value).join() === "Doubles,Singles");
}
check("/matchup has no format, because the type chart does not have one",
  !(COMMANDS.find((cmd) => cmd.name === "matchup").options || []).some((option) => option.name === "format"));

// ------------------------------------------------------- 3. name resolution

const data = siteData(fixtureEnv());
const exact = await data.resolve("Garchomp");
check("an exact name resolves", exact.ok && exact.name === "Garchomp");

const showdown = await data.resolve("indeedeef");
check("a Showdown id resolves", showdown.ok && showdown.name === "Indeedee-F", showdown.name);

const spaced = await data.resolve("  garchomp ");
check("whitespace and case do not matter", spaced.ok && spaced.name === "Garchomp");

const misspelled = await data.resolve("garchmop");
check("a misspelling does not resolve but suggests the real name",
  !misspelled.ok && misspelled.suggestions.includes("Garchomp"), (misspelled.suggestions || []).join(", "));

const misspelledTwo = await data.resolve("rilaboom");
check("a dropped letter suggests the real name", !misspelledTwo.ok && misspelledTwo.suggestions.includes("Rillaboom"), (misspelledTwo.suggestions || []).join(", "));

const nonsense = await data.resolve("qqqqqqqqqq");
check("nonsense resolves to nothing and suggests nothing", !nonsense.ok && nonsense.suggestions.length === 0, (nonsense.suggestions || []).join(", "));

const mega = await data.resolve("Garchomp-Mega");
check("a Mega resolves to the Pokemon its battle data is filed under",
  mega.ok && mega.name === "Garchomp" && mega.askedForm === "mega", `${mega.name} / ${mega.askedForm}`);
const megaPrefix = await data.resolve("Mega Garchomp");
check("the other spelling of a Mega resolves the same way", megaPrefix.ok && megaPrefix.name === "Garchomp");

check("edit distance stops at the cap", editDistance("abcdefgh", "zzzzzzzz", 2) === 3);
check("a prefix beats a substring beats a typo",
  matchScore("gar", "garchomp") < matchScore("chomp", "garchomp") && matchScore("chomp", "garchomp") < matchScore("garchmop", "garchomp"));
check("an unrelated word does not match", matchScore("zzzz", "garchomp") === null);

const byForm = await data.profile("Garchomp-Mega", "Doubles");
check("a Mega shows its own stats but the line's usage",
  byForm.form.form === "Mega Garchomp" && byForm.form.stats.attack === 190 && byForm.rank === 1, byForm.form.form);

// ------------------------------------------------------ 4. every reply shape

async function reply(name, options) {
  const result = await routed(name, options, siteData(fixtureEnv()));
  return result.work ? result.work() : result.response.data;
}

const pokemonReplyPayload = await reply("pokemon", [{ name: "pokemon", value: "Garchomp" }]);
check("/pokemon embed is valid", !embedProblems(pokemonReplyPayload, "/pokemon").length, embedProblems(pokemonReplyPayload, "/pokemon").join("; "));
check("/pokemon links to the profile", pokemonReplyPayload.embeds[0].url === `${ORIGIN}/pokemon/garchomp/`, pokemonReplyPayload.embeds[0].url);
check("/pokemon shows the sprite", pokemonReplyPayload.embeds[0].thumbnail.url === `${ORIGIN}/pokemon_champions_assets/pokemon/Garchomp.png`);

// The site's own "Total" is not the sum of the stats it shows (it runs 55 low
// in pokemon_champions_assets/metadata/*.csv), so no embed may print a sum.
const statSum = Object.values({ hp: 183, attack: 150, defense: 115, sp_attack: 100, sp_defense: 105, speed: 122 }).reduce((a, b) => a + b, 0);
check("/pokemon prints no base stat total of its own",
  !new RegExp(String(statSum)).test(textOf(pokemonReplyPayload)) && !/BST|Total/.test(textOf(pokemonReplyPayload)));
check("/pokemon names the rank, the typing and the stats",
  /#1 of 4 in Doubles/.test(pokemonReplyPayload.embeds[0].description)
  && /Dragon \/ Ground/.test(pokemonReplyPayload.embeds[0].description)
  && textOf(pokemonReplyPayload).includes("Spe 122"));
check("/pokemon shows the most used set", textOf(pokemonReplyPayload).includes("Life Orb") && textOf(pokemonReplyPayload).includes("Rough Skin"));
check("/pokemon offers three ways back to the site", linkCount(pokemonReplyPayload) === 3);

const megaReply = await reply("pokemon", [{ name: "pokemon", value: "Garchomp-Mega" }]);
check("/pokemon explains where a Mega's data lives", /filed under \*\*Garchomp\*\*/.test(megaReply.embeds[0].description));

const singles = await reply("pokemon", [{ name: "pokemon", value: "Garchomp" }, { name: "format", value: "Singles" }]);
check("the format argument changes the answer", /#3 of 4 in Singles/.test(singles.embeds[0].description), singles.embeds[0].description);
const defaulted = await reply("pokemon", [{ name: "pokemon", value: "Garchomp" }, { name: "format", value: "nonsense" }]);
check("an unusable format falls back to Doubles", /in Doubles/.test(defaulted.embeds[0].description));

const movesPayload = await reply("moves", [{ name: "pokemon", value: "Garchomp" }]);
check("/moves embed is valid", !embedProblems(movesPayload, "/moves").length, embedProblems(movesPayload, "/moves").join("; "));
check("/moves lists the moves with their usage and type",
  /80\.6%.*Protect.*Normal/s.test(movesPayload.embeds[0].description) && /44\.5%.*Dragon Claw/s.test(movesPayload.embeds[0].description));
check("/moves shows the four run together", textOf(movesPayload).includes("Protect · Dragon Claw · Earthquake"));
check("/moves names the format in its title", movesPayload.embeds[0].title === "Garchomp — most used Doubles moves", movesPayload.embeds[0].title);

const oneMove = await reply("moves", [{ name: "pokemon", value: "Garchomp" }, { name: "move", value: "Dragon Claw" }]);
check("/moves with a move named explains that move",
  oneMove.embeds[0].fields[0].name === "Dragon Claw"
  && /Dragon · physical · 80 power/.test(oneMove.embeds[0].fields[0].value)
  && /On \*\*44\.5%\*\* of Garchomp's Doubles sets/.test(oneMove.embeds[0].fields[0].value),
  oneMove.embeds[0].fields[0].value);
const looseMove = await reply("moves", [{ name: "pokemon", value: "Garchomp" }, { name: "move", value: "dragonclaw" }]);
check("/moves accepts a loosely typed move name", looseMove.embeds[0].fields[0].name === "Dragon Claw");
const unusedMove = await reply("moves", [{ name: "pokemon", value: "Garchomp" }, { name: "move", value: "Icy Wind" }]);
check("/moves says when a move is not one this Pokemon runs",
  /Not in Garchomp's ten most used Doubles moves/.test(unusedMove.embeds[0].fields[0].value), unusedMove.embeds[0].fields[0].value);
const unknownMove = await reply("moves", [{ name: "pokemon", value: "Garchomp" }, { name: "move", value: "Hyper Nonsense" }]);
check("/moves says when there is no such move", /^No move called/.test(unknownMove.embeds[0].fields[0].name), unknownMove.embeds[0].fields[0].name);

const itemsPayload = await reply("items", [{ name: "pokemon", value: "Garchomp" }]);
check("/items embed is valid", !embedProblems(itemsPayload, "/items").length, embedProblems(itemsPayload, "/items").join("; "));
check("/items ranks the items and explains the top one",
  /45\.2%.*Life Orb/s.test(itemsPayload.embeds[0].description) && itemsPayload.embeds[0].fields[0].value.startsWith("Boosts move power"));

const oneItem = await reply("items", [{ name: "pokemon", value: "Garchomp" }, { name: "item", value: "life orb" }]);
check("/items with an item named explains that item",
  oneItem.embeds[0].fields[0].name === "Life Orb" && /On \*\*45\.2%\*\* of Garchomp's Doubles sets/.test(oneItem.embeds[0].fields[0].value),
  oneItem.embeds[0].fields[0].value);
const otherItem = await reply("items", [{ name: "pokemon", value: "Garchomp" }, { name: "item", value: "Choice Scarf" }]);
check("/items reports an item it has usage for but no description",
  otherItem.embeds[0].fields[0].name === "Choice Scarf" && /On \*\*20\.1%\*\*/.test(otherItem.embeds[0].fields[0].value),
  otherItem.embeds[0].fields[0].value);
const unknownItem = await reply("items", [{ name: "pokemon", value: "Garchomp" }, { name: "item", value: "Nonsense Berry" }]);
check("/items says when there is no such item", /^No item called/.test(unknownItem.embeds[0].fields[0].name));

const teammatesPayload = await reply("teammates", [{ name: "pokemon", value: "Garchomp" }]);
check("/teammates embed is valid", !embedProblems(teammatesPayload, "/teammates").length, embedProblems(teammatesPayload, "/teammates").join("; "));
check("/teammates gives each teammate its own rank", /Rillaboom · #2 overall/.test(teammatesPayload.embeds[0].description));

const metaPayload = await reply("meta", []);
check("/meta embed is valid", !embedProblems(metaPayload, "/meta").length, embedProblems(metaPayload, "/meta").join("; "));
check("/meta shows the ranking with items", /Garchomp · Life Orb/.test(textOf(metaPayload)) && metaPayload.embeds[0].title === "Top 4 in Doubles");
check("/meta names the format in the title", /in Doubles$/.test(metaPayload.embeds[0].title));
// `top` is clamped, so with four fixture Pokemon every value shows four; the
// clamp itself is checked against the real ranking further down.
const metaSingles = await reply("meta", [{ name: "format", value: "Singles" }]);
check("/meta reads the other format",
  /in Singles$/.test(metaSingles.embeds[0].title) && /Rillaboom/.test(metaSingles.embeds[0].fields[0].value.split("\n")[0]),
  metaSingles.embeds[0].fields[0].value.split("\n")[0]);

const comparePayload = await reply("compare", [{ name: "first", value: "Garchomp" }, { name: "second", value: "Weavile" }]);
check("/compare embed is valid", !embedProblems(comparePayload, "/compare").length, embedProblems(comparePayload, "/compare").join("; "));
check("/compare puts them side by side",
  comparePayload.embeds[0].fields[0].name === "Garchomp" && comparePayload.embeds[0].fields[1].name === "Weavile"
  && comparePayload.embeds[0].fields[0].inline && comparePayload.embeds[0].fields[1].inline);
check("/compare works out who is faster", /\*\*Weavile\*\* is faster before investment \(145 to 122\)/.test(comparePayload.embeds[0].description), comparePayload.embeds[0].description);
check("/compare finds the shared teammates and moves",
  textOf(comparePayload).includes("Shared teammates") && /Moves both run.{0,60}Protect/s.test(textOf(comparePayload)));
check("/compare links to both profiles",
  textOf(comparePayload).includes(`${ORIGIN}/pokemon/garchomp/`) && textOf(comparePayload).includes(`${ORIGIN}/pokemon/weavile/`));

const speedPayload = await reply("speed", [{ name: "pokemon", value: "Garchomp" }]);
check("/speed embed is valid", !embedProblems(speedPayload, "/speed").length, embedProblems(speedPayload, "/speed").join("; "));
// 122 base + 32 points = 154, Jolly raises Speed -> floor(154 * 1.1) = 169.
check("/speed applies points then the nature", /→ \*\*169\*\*/.test(speedPayload.embeds[0].description), speedPayload.embeds[0].description);
check("/speed places it against the rest", /Weavile/.test(textOf(speedPayload)) && /Outspeeds/.test(textOf(speedPayload)));
check("finalStat matches the engine's order", finalStat(122, 32, "up") === 169 && finalStat(122, 40, "") === 154 && finalStat(105, 2, "down") === 96);

const countersPayload = await reply("counters", [{ name: "pokemon", value: "Garchomp" }]);
check("/counters embed is valid", !embedProblems(countersPayload, "/counters").length, embedProblems(countersPayload, "/counters").join("; "));
check("/counters names the four-times weakness", /Ice \(x4\)/.test(countersPayload.embeds[0].description), countersPayload.embeds[0].description);
check("/counters finds a ranked Pokemon that already runs the move",
  /Weavile.*Ice Punch.*x4.*88\.2%/s.test(countersPayload.embeds[0].fields[0].value), countersPayload.embeds[0].fields[0].value);
check("/counters sends people to the calculator to check the numbers", textOf(countersPayload).includes(`${ORIGIN}/damage-calculator/`));
check("/counters does not list the Pokemon itself", !/#1 Garchomp/.test(countersPayload.embeds[0].fields[0].value));

const matchupPayload = await reply("matchup", [{ name: "type", value: "Dragon" }, { name: "second_type", value: "Ground" }]);
check("/matchup embed is valid", !embedProblems(matchupPayload, "/matchup").length, embedProblems(matchupPayload, "/matchup").join("; "));
check("/matchup multiplies a dual typing", /x4 — Ice/.test(matchupPayload.embeds[0].fields[0].value), matchupPayload.embeds[0].fields[0].value);
check("/matchup lists the immunity", textOf(matchupPayload).includes("Immune to"));
const matchupOne = await reply("matchup", [{ name: "type", value: "Ice" }]);
check("/matchup takes a single type", matchupOne.embeds[0].title === "Ice matchups", matchupOne.embeds[0].title);
const matchupBad = await reply("matchup", [{ name: "type", value: "Plastic" }]);
check("/matchup refuses a type that is not on the chart", matchupBad.embeds[0].title === "No match");
check("defensiveChart multiplies both halves", defensiveChart(FIXTURES["data/builder/app-data.json"].typeChart, ["Dragon", "Ground"]).Ice === 4);

const helpPayload = await reply("help", []);
check("/help embed is valid", !embedProblems(helpPayload, "/help").length, embedProblems(helpPayload, "/help").join("; "));
check("/help lists every command", COMMAND_NAMES.every((name) => helpPayload.embeds[0].description.includes(`**/${name}**`)));
check("/help links to the site's own pages", linkCount(helpPayload) === 5);

const missing = await reply("pokemon", [{ name: "pokemon", value: "garchmop" }]);
check("an unknown name answers with suggestions, not an error",
  missing.embeds[0].title === "No match" && /Did you mean \*\*Garchomp\*\*/.test(missing.embeds[0].description), missing.embeds[0].description);
check("an unknown name still links to the site", linkCount(missing) >= 1);
check("an unknown name reply is valid", !embedProblems(missing, "/pokemon miss").length, embedProblems(missing, "/pokemon miss").join("; "));

// A Pokemon the site knows but that has no rows in this snapshot.
const thinFixtures = { ...FIXTURES };
const thinEnv = {
  ASSETS: {
    async fetch(url) {
      const path = new URL(url).pathname.replace(/^\/+/, "");
      if (path === "data/builder/meta-doubles.json") {
        return new Response(JSON.stringify({ format: "Doubles", pokemon: thinFixtures["data/builder/meta-doubles.json"].pokemon.slice(1) }), { status: 200 });
      }
      return fixtureEnv().ASSETS.fetch(url);
    }
  }
};
const noRows = await (await routeInteraction(command("pokemon", [{ name: "pokemon", value: "Garchomp" }]), { data: siteData(thinEnv), origin: ORIGIN, cache: new TtlCache() })).work();
check("a Pokemon with no usage rows still gets a profile link",
  /No Doubles usage rows/.test(noRows.embeds[0].description) && noRows.embeds[0].url === `${ORIGIN}/pokemon/garchomp/`, noRows.embeds[0].description);

// Every reply, from every command, is valid, names its format and carries a
// link home. The format has to be somewhere a reader will see it, not implied.
for (const name of COMMAND_NAMES) {
  const payload = await reply(name, [
    { name: "pokemon", value: "Garchomp" }, { name: "first", value: "Garchomp" },
    { name: "second", value: "Rillaboom" }, { name: "type", value: "Ice" },
    { name: "attacker", value: "Garchomp" }, { name: "defender", value: "Rillaboom" }
  ]);
  const problems = embedProblems(payload, `/${name}`);
  check(`/${name} reply fits Discord's limits`, !problems.length, problems.join("; "));
  check(`/${name} links back to the site`, linkCount(payload) >= 1);
  const embed = payload.embeds[0];
  if (!["matchup", "help"].includes(name)) {
    const shown = [embed.title, embed.author?.name, embed.footer?.text, embed.description].filter(Boolean).join(" ");
    check(`/${name} says which format it answered`, /Doubles/.test(shown), shown.slice(0, 120));
    check(`/${name} dates the data in the footer`, /24 Sep 2026/.test(embed.footer?.text || ""), embed.footer?.text);
  }
}

// The first button is the one most worth pressing for that command.
for (const [name, options, first] of [
  ["pokemon", [{ name: "pokemon", value: "Garchomp" }], `${ORIGIN}/pokemon/garchomp/`],
  ["moves", [{ name: "pokemon", value: "Garchomp" }], `${ORIGIN}/pokemon/garchomp/`],
  ["meta", [], `${ORIGIN}/meta/`],
  ["speed", [{ name: "pokemon", value: "Garchomp" }], `${ORIGIN}/pokemon-champions-speed-tiers/`],
  ["counters", [{ name: "pokemon", value: "Garchomp" }], `${ORIGIN}/damage-calculator/`],
  ["matchup", [{ name: "type", value: "Ice" }], `${ORIGIN}/team-builder/`]
]) {
  const payload = await reply(name, options);
  check(`/${name} leads with the page it should`, payload.components[0].components[0].url === first, payload.components[0].components[0].url);
}

// ------------------------------------------------------------- 4b. the cache

const cacheEnv = fixtureEnv();
const shared = new TtlCache();
const askTwice = async (options) => {
  // A fresh SiteData each time, so its own file cache cannot be what saves the
  // second read: only the reply cache can.
  const result = await routeInteraction(command("pokemon", options), { data: siteData(cacheEnv), origin: ORIGIN, cache: shared });
  return result.work();
};
const firstAnswer = await askTwice([{ name: "pokemon", value: "Garchomp" }]);
const readsAfterFirst = cacheEnv.reads.length;
const secondAnswer = await askTwice([{ name: "pokemon", value: "garchomp" }]);
check("the same question twice reads the data once",
  cacheEnv.reads.length === readsAfterFirst && readsAfterFirst > 0, `${readsAfterFirst} then ${cacheEnv.reads.length}`);
check("and gives back the same answer", textOf(secondAnswer) === textOf(firstAnswer));

await routeInteraction(command("pokemon", [{ name: "pokemon", value: "Garchomp" }, { name: "format", value: "Singles" }]), { data: siteData(cacheEnv), origin: ORIGIN, cache: shared })
  .then((result) => result.work());
check("a different format is a different question", cacheEnv.reads.length > readsAfterFirst);

let clock = 1_000_000;
const timed = new TtlCache({ now: () => clock });
timed.set("k", "v");
check("an entry is live inside its five minutes", timed.get("k") === "v");
clock += TTL_MS - 1;
check("still live one millisecond before it expires", timed.get("k") === "v");
clock += 2;
check("and gone once 300 seconds have passed", timed.get("k") === undefined && timed.size === 0);
check("the TTL is 300 seconds", TTL_MS === 300_000);

const capped = new TtlCache({ maxEntries: 3 });
for (let index = 0; index < 10; index += 1) capped.set(`key-${index}`, index);
check("the cache cannot grow without bound", capped.size === 3 && capped.get("key-9") === 9 && capped.get("key-0") === undefined);
check("the default cap is set", MAX_ENTRIES === 200);

const wrapped = new TtlCache();
let loads = 0;
const load = () => { loads += 1; return Promise.resolve("value"); };
check("wrap loads once", (await wrapped.wrap("x", load)) === "value" && (await wrapped.wrap("x", load)) === "value" && loads === 1);

check("the key ignores argument order and case",
  replyKey("pokemon", [{ name: "pokemon", value: "Garchomp" }, { name: "move", value: "Protect" }], "Doubles")
  === replyKey("pokemon", [{ name: "move", value: "protect" }, { name: "pokemon", value: " garchomp " }], "Doubles"));
check("the key separates the formats",
  replyKey("pokemon", [{ name: "pokemon", value: "Garchomp" }], "Doubles") !== replyKey("pokemon", [{ name: "pokemon", value: "Garchomp" }], "Singles"));
check("the key separates the commands",
  replyKey("moves", [], "Doubles") !== replyKey("items", [], "Doubles"));

// A handler that threw must not leave a failure sitting in the cache.
const failing = new TtlCache();
const failingRoute = await routeInteraction(command("pokemon", [{ name: "pokemon", value: "Garchomp" }]), {
  data: siteData({ ASSETS: { async fetch() { throw new Error("down"); } } }), origin: ORIGIN, cache: failing
});
await failingRoute.work().catch(() => {});
check("a failed answer is not cached", failing.size === 0);

// ---------------------------------------------------- 5. rate limits, retries

function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      const next = responses.shift();
      return new Response(next.body ?? "{}", { status: next.status });
    }
  };
}

const slept = [];
const limited = fakeFetch([{ status: 429, body: JSON.stringify({ retry_after: 0.4 }) }, { status: 200 }]);
const afterLimit = await discordFetch("https://discord.com/x", {}, { fetchImpl: limited.fetch, sleep: async (ms) => slept.push(ms) });
check("a 429 is retried after the delay Discord asks for",
  afterLimit.status === 200 && limited.calls.length === 2 && slept[0] === 400, `${afterLimit.status} after ${slept.join(",")}ms`);

const stubborn = fakeFetch([
  { status: 429, body: JSON.stringify({ retry_after: 0.1 }) },
  { status: 429, body: JSON.stringify({ retry_after: 0.1 }) },
  { status: 429, body: JSON.stringify({ retry_after: 0.1 }) }
]);
const gaveUp = await discordFetch("https://discord.com/x", {}, { fetchImpl: stubborn.fetch, sleep: async () => {}, attempts: 3 });
check("a rate limit that will not clear gives up rather than looping", gaveUp.status === 429 && stubborn.calls.length === 3);

const waited = [];
const serverError = fakeFetch([{ status: 500 }, { status: 200 }]);
await discordFetch("https://discord.com/x", {}, { fetchImpl: serverError.fetch, sleep: async (ms) => waited.push(ms) });
check("a 5xx is retried once", serverError.calls.length === 2 && waited[0] === 1000);

const notFoundOnce = fakeFetch([{ status: 404 }]);
await discordFetch("https://discord.com/x", {}, { fetchImpl: notFoundOnce.fetch, sleep: async () => {} });
check("a 4xx that is not a rate limit is not retried", notFoundOnce.calls.length === 1);

const followUp = fakeFetch([{ status: 200 }]);
await sendFollowUp({ application_id: "1234", token: "abc" }, { embeds: [] }, { fetchImpl: followUp.fetch, sleep: async () => {} });
check("the deferred reply edits the original message through the interaction webhook",
  followUp.calls[0].url === "https://discord.com/api/v10/webhooks/1234/abc/messages/@original" && followUp.calls[0].init.method === "PATCH");
check("the follow-up carries no bot token", !JSON.stringify(followUp.calls[0].init.headers || {}).toLowerCase().includes("authorization"));

// A data layer that is down must not throw out of the handler.
const brokenData = siteData({ ASSETS: { async fetch() { throw new Error("assets down"); } } });
const brokenRoute = await routeInteraction(command("pokemon", [{ name: "pokemon", value: "Garchomp" }]), { data: brokenData, origin: ORIGIN, cache: new TtlCache() });
let threw = false;
try { await brokenRoute.work(); } catch { threw = true; }
check("a broken data layer surfaces as a rejected promise the endpoint catches", threw);

// ------------------------------------------------- 6. the real data path

const live = siteData(diskEnv());
const liveProfile = await live.profile("garchomp", "Doubles");
check("the real files resolve a Showdown id", liveProfile.ok && liveProfile.name === "Garchomp", liveProfile.name);
check("the real files carry a rank, a form and base stats",
  Number.isInteger(liveProfile.rank) && liveProfile.rank > 0 && liveProfile.form?.stats?.speed > 0 && liveProfile.total > 200,
  `${liveProfile.rank}/${liveProfile.total}`);

const liveRanking = JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8"));
check("the rank the bot prints is the rank in the file",
  liveProfile.rank === liveRanking.pokemon.find((row) => row.name === "Garchomp").position);

const liveRouted = await routeInteraction(command("pokemon", [{ name: "pokemon", value: "garchomp" }]), { data: live, origin: ORIGIN, cache: new TtlCache() });
const livePokemon = await liveRouted.work();
check("/pokemon on the real data is a valid embed", !embedProblems(livePokemon, "live /pokemon").length, embedProblems(livePokemon, "live /pokemon").join("; "));
check("/pokemon on the real data links to a page the repo actually generates",
  livePokemon.embeds[0].url === `${ORIGIN}/pokemon/garchomp/`);

for (const [name, options] of [
  ["meta", []],
  ["moves", [{ name: "pokemon", value: "rillaboom" }]],
  ["items", [{ name: "pokemon", value: "rillaboom" }]],
  ["teammates", [{ name: "pokemon", value: "rillaboom" }]],
  ["compare", [{ name: "first", value: "garchomp" }, { name: "second", value: "rillaboom" }]],
  ["speed", [{ name: "pokemon", value: "rillaboom" }]],
  ["counters", [{ name: "pokemon", value: "garchomp" }]],
  ["matchup", [{ name: "type", value: "Dragon" }, { name: "second_type", value: "Ground" }]]
]) {
  const result = await routeInteraction(command(name, options), { data: live, origin: ORIGIN, cache: new TtlCache() });
  const payload = result.work ? await result.work() : result.response.data;
  const problems = embedProblems(payload, `live /${name}`);
  check(`/${name} on the real data is a valid embed`, !problems.length, problems.join("; "));
  check(`/${name} on the real data links back to the site`, linkCount(payload) >= 1);
}

// Sprites the bot points at have to exist in the repo, or the embed shows a gap.
const liveIndex = JSON.parse(readFileSync(join(root, "data", "meta", "index.json"), "utf8"));
const missingSprites = Object.values(liveIndex.pokemon)
  .filter((entry) => { try { readFileSync(join(root, ...entry.sprite.split("/"))); return false; } catch { return true; } })
  .map((entry) => entry.name);
check("every sprite the bot can link to is in the repo", !missingSprites.length, missingSprites.slice(0, 6).join(", "));

// Every name the resolver can produce has a profile page.
const liveLookup = JSON.parse(readFileSync(join(root, "data", "api", "lookup.json"), "utf8"));
const slugs = new Set(Object.values(liveIndex.pokemon).map((entry) => entry.slug));
const orphans = [...new Set(Object.values(liveLookup.aliases))].filter((slug) => !slugs.has(slug));
check("every alias the bot accepts names a Pokemon the site has a page for", !orphans.length, orphans.slice(0, 6).join(", "));

const liveMisspelled = await live.resolve("incinaroar");
check("a real misspelling suggests the real Pokemon",
  !liveMisspelled.ok && liveMisspelled.suggestions.includes("Incineroar"), (liveMisspelled.suggestions || []).join(", "));

const liveComplete = await live.completions("garch", 25);
check("real autocomplete puts the obvious answer first", liveComplete[0] === "Garchomp" && liveComplete.length <= 25, liveComplete.slice(0, 3).join(", "));
const liveBroad = await live.completions("a", 25);
check("real autocomplete never returns more than Discord accepts", liveBroad.length <= 25, String(liveBroad.length));
const liveMoves = await live.completeMoves("prot", { pokemon: "garchomp", format: "Doubles" }, 25);
check("real move autocomplete finds a move the Pokemon runs", liveMoves.includes("Protect"), liveMoves.slice(0, 4).join(", "));
const liveMovesAll = await live.completeMoves("draco", {}, 25);
check("real move autocomplete falls back to the whole move table", liveMovesAll.includes("Draco Meteor"), liveMovesAll.slice(0, 4).join(", "));
const liveItems = await live.completeItems("sitrus", {}, 25);
check("real item autocomplete finds an item", liveItems.includes("Sitrus Berry"), liveItems.slice(0, 4).join(", "));

// `top` is clamped to the range the command declares, which only a ranking
// longer than the clamp can show.
for (const [value, title] of [[undefined, "Top 10 in Doubles"], [2, "Top 5 in Doubles"], [500, "Top 25 in Doubles"]]) {
  const options = value === undefined ? [] : [{ name: "top", value }];
  const payload = await (await routeInteraction(command("meta", options), { data: live, origin: ORIGIN, cache: new TtlCache() })).work();
  check(`/meta top=${value ?? "(none)"} shows ${title}`, payload.embeds[0].title === title, payload.embeds[0].title);
}

const liveMoveDetail = await (await routeInteraction(command("moves", [{ name: "pokemon", value: "garchomp" }, { name: "move", value: "Protect" }]), { data: live, origin: ORIGIN, cache: new TtlCache() })).work();
check("/moves on the real data explains a named move",
  liveMoveDetail.embeds[0].fields[0].name === "Protect" && /Normal/.test(liveMoveDetail.embeds[0].fields[0].value),
  liveMoveDetail.embeds[0].fields[0].value.slice(0, 80));
check("no accuracy anywhere reads over 100", !/\b(1[0-9]{2}|[2-9][0-9]{2})% accurate/.test(textOf(liveMoveDetail)));

// --------------------------------------------------------------- 7. guards

const liveAppData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
check("the /matchup type list still matches the site's own", TYPE_NAMES.join() === (liveAppData.types || []).join(),
  `${TYPE_NAMES.length} vs ${(liveAppData.types || []).length}`);

const deploy = readFileSync(join(root, "tools", "deploy.mjs"), "utf8");
check("tests/ stays out of the deploy", /devOnlyPaths\s*=\s*\[[^\]]*"tests"/.test(deploy));
check("functions/ is Function source, not an uploaded asset", /rootIgnored\s*=\s*new Set\(\[[^\]]*"functions"/.test(deploy));

// tools/ IS uploaded with the site, so the registration script must hold no
// secret and must read the token only from the environment.
const registerSource = readFileSync(join(root, "tools", "register-discord-commands.mjs"), "utf8");
// The header comment names .dev.vars to say it is not read; look at the code.
const registerCode = registerSource.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
check("the registration script reads the token from the environment only",
  registerCode.includes("process.env.DISCORD_BOT_TOKEN") && !/\.dev\.vars|readFileSync|readFile\(/.test(registerCode));
check("the registration script has no token-shaped literal in it",
  !/["'][A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}["']/.test(registerSource));
check("the registration script never prints the token", !/console\.(log|error)\([^)]*token[^)]*\)/i.test(registerSource.replace(/<token>/g, "")));

const botSources = ["_verify.js", "_data.js", "_render.js", "_commands.js", "_damage.js", "interactions.js"]
  .map((name) => readFileSync(join(root, "functions", "api", "discord", name), "utf8"));
check("no bot source hard-codes a Discord credential",
  !botSources.some((source) => /DISCORD_(PUBLIC_KEY|BOT_TOKEN|APP_ID)\s*=\s*["'][^"']+["']/.test(source)));
check("the endpoint never sends a bot token to Discord",
  !botSources.some((source) => /Authorization/i.test(source)));

// --------------------------------------- the registrar and the router agree

// _commands.js is one list used twice: tools/register-discord-commands.mjs PUTs
// it to Discord and interactions.js routes against it. A command that exists in
// one and not the other would either be invokable with nothing to answer it, or
// answerable and never registered -- so the two directions are both checked.
const routerSource = readFileSync(join(root, "functions", "api", "discord", "interactions.js"), "utf8");
const handlerBlock = routerSource.split("const HANDLERS = {")[1]?.split("\n};")[0] || "";
const handlerNames = [...handlerBlock.matchAll(/^ {2}(?:async )?([a-z_][a-z0-9_]*)\(/gm)].map((match) => match[1]);
check("the router has a handler for every defined command",
  COMMAND_NAMES.every((name) => handlerNames.includes(name)),
  COMMAND_NAMES.filter((name) => !handlerNames.includes(name)).join(", "));
check("the router has no handler for a command that is not defined",
  handlerNames.every((name) => COMMAND_NAMES.includes(name)),
  handlerNames.filter((name) => !COMMAND_NAMES.includes(name)).join(", "));
check("the registrar sends the shared list and defines none of its own",
  /import \{ COMMANDS \} from "\.\.\/functions\/api\/discord\/_commands\.js"/.test(registerSource)
  && /call\("PUT", COMMANDS\)/.test(registerSource)
  && !/const COMMANDS\s*=/.test(registerSource));

// Discord's own rules for a command, so a bad definition fails here and not in
// the registrar -- which the lead runs by hand, once, against the live bot.
const seenNames = new Set();
for (const definition of COMMANDS) {
  const where = `/${definition.name}`;
  check(`${where} has a Discord-legal name`, /^[a-z][a-z0-9_-]{0,31}$/.test(definition.name), definition.name);
  check(`${where} is defined once`, !seenNames.has(definition.name));
  seenNames.add(definition.name);
  check(`${where} description fits 100 characters`, definition.description.length <= 100, String(definition.description.length));
  const options = definition.options || [];
  check(`${where} has at most 25 options`, options.length <= 25, String(options.length));
  let optional = false;
  const optionNames = new Set();
  for (const option of options) {
    check(`${where} ${option.name} has a legal name`, /^[a-z][a-z0-9_-]{0,31}$/.test(option.name), option.name);
    check(`${where} ${option.name} appears once`, !optionNames.has(option.name));
    optionNames.add(option.name);
    check(`${where} ${option.name} description fits 100 characters`, option.description.length <= 100, String(option.description.length));
    // Discord refuses a required option after an optional one.
    if (option.required) check(`${where} ${option.name} comes before the optional options`, !optional);
    else optional = true;
    if (option.choices) check(`${where} ${option.name} has at most 25 choices`, option.choices.length <= 25);
    check(`${where} ${option.name} is not both a choice list and autocompleting`, !(option.choices && option.autocomplete));
  }
}

// ------------------------------------------------------------ /damage routing

const damageRouted = await routed("damage", [{ name: "attacker", value: "Garchomp" }, { name: "defender", value: "Rillaboom" }]);
check("/damage defers before it calculates", damageRouted.response.type === RESPONSE_DEFERRED && Boolean(damageRouted.work));
const damagePayload = await damageRouted.work();
check("/damage answers with one embed", (damagePayload.embeds || []).length === 1);
check("/damage names both Pokemon in the title", /Garchomp.*Rillaboom/.test(damagePayload.embeds[0].title || ""), damagePayload.embeds[0].title);
check("/damage says the set it used came from the usage data", /most used Doubles set/.test(damagePayload.embeds[0].description || ""), damagePayload.embeds[0].description);
check("/damage links into the calculator with both names",
  (damagePayload.components?.[0]?.components || []).some((button) => /damage-calculator\/\?attacker=Garchomp&defender=Rillaboom&format=Doubles/.test(button.url)));

// The move box has to complete from the attacker's own used moves, not from the
// whole move table: that is one line in completeOption and the entire quality of
// the box, so it is checked through the router.
const damageMoves = await routeInteraction(
  { type: 4, data: { name: "damage", options: [{ name: "attacker", value: "Garchomp" }, { name: "move", value: "", focused: true }] } },
  { data: siteData(fixtureEnv()), origin: ORIGIN }
);
const damageChoices = damageMoves.response.data.choices.map((choice) => choice.value);
check("the /damage move box completes from the attacker's used moves",
  damageChoices.length > 0 && damageChoices.every((name) => FIXTURES["data/builder/meta-doubles.json"].pokemon[0].moves.some(([move]) => move === name)),
  damageChoices.join(", "));
const damageNames = await routeInteraction(
  { type: 4, data: { name: "damage", options: [{ name: "attacker", value: "garch", focused: true }] } },
  { data: siteData(fixtureEnv()), origin: ORIGIN }
);
check("the /damage attacker box completes Pokemon names",
  damageNames.response.data.choices.some((choice) => choice.value === "Garchomp"));

// The reply cache key must not be confusable by free text, which /damage takes.
check("a pipe in free text cannot fake a second option",
  replyKey("damage", [{ name: "field", value: "reflect|crit=true" }], "Doubles")
  !== replyKey("damage", [{ name: "field", value: "reflect" }, { name: "crit", value: "true" }], "Doubles"));

console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
