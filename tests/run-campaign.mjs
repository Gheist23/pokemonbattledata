// Creator collaborations: the URL read out in a video, and the teams it puts in
// the Team Builder. _redirects, data/campaigns/*.json, builder/campaign-teams.js,
// builder/campaign-track.js and functions/api/campaign/[code].js.
//
//   node tests/run-campaign.mjs
//   node tests/run-campaign.mjs --verbose
//
// What it holds to:
//
//   0. THE LINK GOES STRAIGHT IN.  championsbattledata.com/giuseppe is a redirect
//      to the Team Builder with the campaign on it, not a page to click through.
//      Both spellings redirect, and no stale /giuseppe/ directory may shadow them.
//
//   1. A CAMPAIGN NEVER TAKES A TEAM AWAY.  Everything is added; a visitor who
//      has been building for a month keeps all of it.  The team the visitor
//      ends up looking at is the FIRST of the video, not the last, which is why
//      the install walks the list backwards.
//
//   2. IT ONLY HAPPENS ONCE.  A reload, a back button or a second visit from
//      the pinned comment does not hand anybody a second set of five.  Asking
//      for one team by number is exempt, because that is a different request.
//
//   3. NOTHING HERE CAN BREAK THE PAGE.  A missing file, a 404, one paste that
//      no longer resolves: the other teams still land and the builder opens.
//
//   4. THE PASTE IS THE SOURCE.  Every team's `members` -- the names and
//      sprites the landing page draws -- is derived from its Showdown paste by
//      tools/build-campaign.mjs, so the card and the team can never disagree.
//      Running that tool with --check must leave the file alone.
//
//   5. THE COUNTER CANNOT IDENTIFY ANYBODY.  The only thing sent is a step name
//      and a 16-character id the browser made up for itself.  The endpoint
//      refuses anything else, answers 204 when it is not configured, and stores
//      one empty object whose key is the whole record.
//
// No browser and no network.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData, parseShowdown } from "../builder/common.js";
import { cleanCampaignCode, installCampaignTeams } from "../builder/campaign-teams.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const verbose = process.argv.includes("--verbose");

let checked = 0;
const failures = [];
const ok = (label, passed, detail = "") => {
  checked += 1;
  if (!passed) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  else if (verbose) console.log(`  ok   ${label}`);
};
const same = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const not_in = (text, needle) => !text.includes(needle);

// --- 0. the code filter -------------------------------------------------------------------

same("a plain code survives", cleanCampaignCode("giuseppe"), "giuseppe");
same("case and spaces do not", cleanCampaignCode("  GiusePPe "), "giuseppe");
// A traversal does not survive as a traversal: the filter keeps only [a-z0-9-],
// so what is left can name a file that is not there but can never name one
// outside data/campaigns/.
for (const nasty of ["../../etc/passwd", "a/b", "..", "./.", "%2e%2e%2fx", "a\\b"]) {
  const cleaned = cleanCampaignCode(nasty);
  ok(`"${nasty}" cannot escape data/campaigns/`, /^[a-z0-9-]*$/.test(cleaned), `got ${JSON.stringify(cleaned)}`);
}
same("two dots are not a code", cleanCampaignCode(".."), "");
same("one character is not a code", cleanCampaignCode("a"), "");
same("thirty-three characters are not a code", cleanCampaignCode("a".repeat(33)), "");

// --- 1. the shipped campaign file ---------------------------------------------------------

const campaignDir = join(root, "data", "campaigns");
ok("data/campaigns/ exists", existsSync(campaignDir));
const campaignFiles = existsSync(campaignDir) ? readdirSync(campaignDir).filter((name) => name.endsWith(".json")) : [];
ok("at least one campaign file", campaignFiles.length > 0, `found ${campaignFiles.length}`);

for (const name of campaignFiles) {
  const code = name.replace(/\.json$/, "");
  let file;
  try {
    file = JSON.parse(read("data", "campaigns", name));
  } catch (error) {
    ok(`${name} is JSON`, false, error.message);
    continue;
  }
  ok(`${name} is JSON`, true);
  same(`${name} knows its own code`, file.code, code);
  ok(`${name} names a creator`, Boolean(file.creator?.name));
  ok(`${name} is one of the two formats`, ["Singles", "Doubles"].includes(file.format), String(file.format));
  ok(`${name} has a teams array`, Array.isArray(file.teams));
  for (const [index, team] of (file.teams || []).entries()) {
    const paste = String(team?.showdown || "").trim();
    // A team with no paste is "not written yet", and the page leaves it out. A
    // team WITH a paste must have been through tools/build-campaign.mjs, or the
    // landing page would draw a card with no Pokemon on it.
    ok(`${name} team ${index + 1}: a paste brings members with it`,
      !paste || (Array.isArray(team.members) && team.members.length > 0),
      "paste present but members empty -- run node tools/build-campaign.mjs");
    for (const member of team.members || []) {
      ok(`${name} team ${index + 1}: ${member.name || "?"} has a sprite`, Boolean(member.sprite));
      if (member.sprite) {
        const path = decodeURIComponent(member.sprite).replace(/^\//, "");
        ok(`${name} team ${index + 1}: ${member.name}'s sprite is on disk`, existsSync(join(root, path)), path);
      }
    }
  }
}

// --- 2. a paste becomes the team the builder would make ------------------------------------

const data = new BuilderData(JSON.parse(read("data", "builder", "app-data.json")));
const PASTE_ONE = [
  "Incineroar @ Sitrus Berry", "Ability: Intimidate", "Level: 50", "EVs: 8 HP / 4 Atk", "Adamant Nature",
  "- Fake Out", "- Knock Off", "- Parting Shot", "- Flare Blitz",
  "", "Charizard @ Charizardite Y", "Ability: Blaze", "Level: 50", "Timid Nature",
  "- Heat Wave", "- Protect", "- Solar Beam", "- Air Slash",
].join("\n");
const PASTE_TWO = ["Rillaboom @ Miracle Seed", "Ability: Grassy Surge", "Level: 50", "Adamant Nature", "- Grassy Glide", "- Wood Hammer", "- Fake Out", "- Protect"].join("\n");

const parsedOne = parseShowdown(PASTE_ONE, data);
same("a two-Pokemon paste is two sets", parsedOne.length, 2);
same("the stone decides the name on the card", parsedOne.map((set) => data.setName(set)), ["Incineroar", "Charizard-Mega-Y"]);
ok("both sprites resolve", parsedOne.every((set) => data.sprite(set.species, set.form, set.item)));

// --- 3. installing a campaign --------------------------------------------------------------

function fakeCampaign(teams, extra = {}) {
  return { code: "demo", format: "Doubles", creator: { name: "Someone" }, teams, ...extra };
}

function harness(campaign) {
  const added = [];
  const formats = [];
  const selected = [];
  return {
    added,
    formats,
    selected,
    deps: {
      parse: (text) => parseShowdown(text, data),
      // The real one is store.js's newTeam, which returns the team it made.
      add: (sets, title) => {
        const team = { id: `team-${added.length + 1}`, title, names: sets.map((set) => data.setName(set)) };
        added.push(team);
        return team;
      },
      select: (id) => selected.push(id),
      setFormat: (value) => formats.push(value),
      fetchCampaign: async () => campaign,
    },
  };
}

{
  const { added, formats, selected, deps } = harness(fakeCampaign([
    { title: "One", showdown: PASTE_ONE },
    { title: "Two", showdown: PASTE_TWO },
  ]));
  const answer = await installCampaignTeams("demo", deps);
  same("both teams land", answer.loaded, 2);
  // The library column draws them in the order they were added, so that order
  // IS what the visitor reads: team one at the top, the way the video numbers
  // them. Adding a team also selects it, which is why the first one has to be
  // asked for again at the end.
  same("they are added in reading order", added.map((team) => team.title), ["One", "Two"]);
  same("the titles are reported in reading order", answer.titles, ["One", "Two"]);
  // By title, not by position: "the first one added" would still be satisfied
  // by an installer that added them backwards.
  same("the video's first team is the one left open", selected, [added.find((team) => team.title === "One").id]);
  same("the format is set before any team is read", formats, ["Doubles"]);
  same("and that first team is the video's first", added[0].names, ["Incineroar", "Charizard-Mega-Y"]);
}

{
  const { added, deps } = harness(fakeCampaign([
    { title: "Empty", showdown: "" },
    { title: "Rubbish", showdown: "Thisisnotapokemon @ Nothing\n- Nope" },
    { title: "Good", showdown: PASTE_TWO },
  ]));
  const answer = await installCampaignTeams("demo", deps);
  same("an empty slot and an unreadable paste are skipped, the rest lands", answer.loaded, 1);
  same("and it is the readable one", added.map((team) => team.title), ["Good"]);
}

{
  // Nothing installed, nothing opened: a select() on a team that was never made
  // would leave the Team Builder pointing at nothing.
  const { selected, deps } = harness(fakeCampaign([{ title: "Empty", showdown: "" }]));
  await installCampaignTeams("demo", deps);
  same("a campaign that installs nothing opens nothing", selected, []);
}

{
  // The older deps shape, without select: the page must still work if a caller
  // (or a test) hands over only the two functions the file documents as needed.
  const { added, deps } = harness(fakeCampaign([{ title: "One", showdown: PASTE_ONE }]));
  delete deps.select;
  same("no select hook, the teams still land", (await installCampaignTeams("demo", deps)).loaded, 1);
  same("and it is the right one", added.map((team) => team.title), ["One"]);
}

{
  const { added, deps } = harness(fakeCampaign([
    { title: "One", showdown: PASTE_ONE },
    { title: "Two", showdown: PASTE_TWO },
  ]));
  const answer = await installCampaignTeams("demo", deps, { only: 2 });
  same("asking for one team gives one team", answer.loaded, 1);
  same("and it is the one asked for", added.map((team) => team.title), ["Two"]);
}

{
  const { deps } = harness(fakeCampaign([{ title: "One", showdown: PASTE_ONE }]));
  const answer = await installCampaignTeams("", deps);
  same("no code, nothing installed", answer.loaded, 0);
}

{
  // The once-only rule lives in localStorage, which Node has not got; without a
  // stand-in every "have I done this already?" answers no and the rule is never
  // exercised at all. The stand-in is the browser's own API, nothing more.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    const first = harness(fakeCampaign([{ title: "One", showdown: PASTE_ONE }, { title: "Two", showdown: PASTE_TWO }]));
    same("the first visit installs", (await installCampaignTeams("once", first.deps)).loaded, 2);

    const second = harness(fakeCampaign([{ title: "One", showdown: PASTE_ONE }, { title: "Two", showdown: PASTE_TWO }]));
    const again = await installCampaignTeams("once", second.deps);
    same("a reload installs nothing a second time", again.loaded, 0);
    same("and says why", again.skipped, "seen");
    same("nothing was added on the second visit", second.added.length, 0);

    const forced = harness(fakeCampaign([{ title: "One", showdown: PASTE_ONE }]));
    same("?again=1 gets past it", (await installCampaignTeams("once", forced.deps, { force: true })).loaded, 1);

    const single = harness(fakeCampaign([{ title: "One", showdown: PASTE_ONE }, { title: "Two", showdown: PASTE_TWO }]));
    same("asking for one team by number is still honoured afterwards",
      (await installCampaignTeams("once", single.deps, { only: 2 })).loaded, 1);

    const other = harness(fakeCampaign([{ title: "One", showdown: PASTE_ONE }]));
    same("a different campaign is a different question", (await installCampaignTeams("elsewhere", other.deps)).loaded, 1);

    // A campaign that installed nothing must not be remembered as installed, or
    // a file filled in an hour later would never reach the people who looked early.
    const emptyRun = harness(fakeCampaign([{ title: "Not written yet", showdown: "" }]));
    same("an empty campaign installs nothing", (await installCampaignTeams("later", emptyRun.deps)).loaded, 0);
    const filledRun = harness(fakeCampaign([{ title: "Now written", showdown: PASTE_TWO }]));
    same("and is not remembered, so the filled-in version still arrives",
      (await installCampaignTeams("later", filledRun.deps)).loaded, 1);
  } finally {
    delete globalThis.localStorage;
  }
}

{
  // The empty "My Team" the store invents for a brand new browser sat above the
  // creator's five, which is the first thing somebody arriving off the video
  // looks at. This is the real store, not a stand-in.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    const s = await import("../builder/store.js");
    const sets = parseShowdown(PASTE_ONE, data);
    same("a new browser starts with the placeholder", s.getState().teams.map((t) => t.title), ["My Team"]);
    const one = s.newTeam(sets, data, "Team 1");
    s.newTeam(sets, data, "Team 2");
    s.selectTeam(one.id);
    s.dropEmptyPlaceholders();
    same("the placeholder goes once a campaign's teams are in",
      s.getState().teams.map((t) => t.title), ["Team 1", "Team 2"]);
    same("the video's first team is still the open one", s.getState().selectedTeamId, one.id);

    // An empty team is only a placeholder if the store made it. One the visitor
    // made themselves is theirs, however empty it is.
    const mine = s.newTeam(null, data, "Scratch");
    s.dropEmptyPlaceholders();
    ok("an empty team the visitor made is kept", s.getState().teams.some((t) => t.id === mine.id));

    // And a placeholder they typed into is not a placeholder any more.
    s.selectTeam(s.getState().teams[0].id);
    s.setSlot(0, sets[0], data);
    const titles = s.getState().teams.map((t) => t.title);
    s.dropEmptyPlaceholders();
    same("nothing else is ever dropped", s.getState().teams.map((t) => t.title), titles);
  } finally {
    delete globalThis.localStorage;
  }
}

{
  const deps = {
    parse: (text) => parseShowdown(text, data),
    add: () => { throw new Error("nothing should be added"); },
    fetchCampaign: async () => { throw new Error("404"); },
  };
  const answer = await installCampaignTeams("demo", deps);
  same("a missing campaign file installs nothing and does not throw", answer.loaded, 0);
}

{
  // A campaign whose format the file does not name must not silently switch the
  // visitor's format out from under them.
  const { formats, deps } = harness(fakeCampaign([{ title: "One", showdown: PASTE_TWO }], { format: "" }));
  await installCampaignTeams("demo", deps);
  same("an unnamed format is left alone", formats, []);
}

// --- 4. the link the video reads out -------------------------------------------------------

const redirects = read("_redirects");
// Both spellings, because a URL read out loud is typed without the slash as often as with it.
for (const from of ["/giuseppe", "/giuseppe/"]) {
  const rule = redirects.split(/\r?\n/).find((line) => line.trim().split(/\s+/)[0] === from);
  ok(`${from} is a rule`, Boolean(rule), "nothing in _redirects matches it");
  if (!rule) continue;
  const [, to, status] = rule.trim().split(/\s+/);
  same(`${from} goes straight into the Team Builder`, to, "/team-builder/?campaign=giuseppe");
  // 302, not 301: a permanent redirect is cached in the browser forever and a
  // campaign's destination is exactly what gets changed mid-flight.
  same(`${from} is a temporary redirect`, status, "302");
}
// A directory would be served as an asset and shadow the rule.
ok("no stale landing page shadows the redirect", !existsSync(join(root, "giuseppe")));
ok("a campaign page is not in the sitemap", !read("sitemap.xml").includes("/giuseppe"));
// The campaign file is edited after the link is already live.
ok("the campaign files are served uncached", read("_headers").includes("/data/campaigns/*"));

// --- 5. the Team Builder's end -------------------------------------------------------------

const builderPage = read("builder", "builder-page.js");
ok("the builder reads ?campaign=", builderPage.includes('params.get("campaign")'));
ok("it clears the parameter so a reload is a plain builder", /history\.replaceState\(null, "", location\.pathname\);/.test(builderPage));
// No banner: a visitor from the video gets the Team Builder with the five teams
// in it and nothing explaining itself on top. The only thing that must survive is
// that the teams are ADDED, never set over what the visitor already had.
ok("no campaign banner is left behind",
   not_in(read("team-builder", "index.html"), "campaignBanner")
   && not_in(builderPage, "campaignBanner"));
ok("the teams are ADDED, never set", builderPage.includes("newTeam(sets.slice(0, TEAM_SIZE), data, title)") && !/campaign[\s\S]{0,400}setTeamSets/.test(builderPage));

// --- 6. the counter ------------------------------------------------------------------------

const tracker = read("builder", "campaign-track.js");
ok("the click that leaves the page still gets counted", tracker.includes("keepalive: true"));
ok("the id is sixteen hex characters", tracker.includes("/^[0-9a-f]{16}$/"));
ok("nothing third-party is contacted", !/https?:\/\//.test(tracker.replace(/^\s*\/\/.*$/gm, "")));

const fn = read("functions", "api", "campaign", "[code].js");
ok("the endpoint validates the code before it touches storage",
  fn.indexOf("function cleanCode") < fn.indexOf("bucket.put"));
ok("only known steps are stored", fn.includes("STEPS.includes"));
ok("the visitor id is bounded to sixteen hex characters", fn.includes("id.length === 16"));
ok("an unconfigured bucket is a 204, not an error", /if \(!bucket \|\| !code\) return new Response\(null, \{ status: 204/.test(fn));
ok("the stored object is empty: the key IS the record", fn.includes("new Uint8Array(0)"));
ok("it uses the bucket the site already has", fn.includes("env.SHARES"));
ok("no IP, header or referrer is read", !/headers\.get\(["'](cf-|x-forwarded|referer|user-agent)/i.test(fn));

// Every step the two clients can send must be one the endpoint accepts.
const declared = [...fn.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
const stepsLine = fn.match(/const STEPS = \[(.*?)\];/s)?.[1] || "";
const allowed = [...stepsLine.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
ok("the endpoint declares its steps", allowed.length > 0, JSON.stringify(declared.slice(0, 3)));
// Every step the site can send: the literals passed straight to trackCampaign,
// plus the two that come from the CAMPAIGN_TABS map rather than from the call.
const tabSteps = [...(builderPage.match(/const CAMPAIGN_TABS = \{([^}]*)\}/)?.[1] || "")
  .matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
const sent = new Set([
  ...[...builderPage.matchAll(/trackCampaign\([^;]*?"([a-z]+)"[^;]*?\);/g)].map((match) => match[1]),
  ...tabSteps,
]);
ok("the funnel still has its later steps after the banner went",
   tabSteps.length >= 2, `found ${JSON.stringify(tabSteps)}`);
ok("and they are only sent for a campaign visitor",
   /function trackCampaignTab[\s\S]{0,160}if \(!campaignOnScreen\) return;/.test(builderPage));
ok("the site really does send steps", sent.size >= 3, `found ${[...sent].join(", ")}`);
for (const step of sent) ok(`the endpoint accepts the step "${step}" the site sends`, allowed.includes(step));

// --- 7. the file is what the tool would write ----------------------------------------------

const { execFileSync } = await import("node:child_process");
let checkCode = 0;
try {
  execFileSync(process.execPath, [join(root, "tools", "build-campaign.mjs"), "giuseppe", "--check"], { cwd: root, stdio: "pipe" });
} catch (error) {
  checkCode = error.status ?? 1;
}
ok("data/campaigns/giuseppe.json matches its own pastes (build-campaign.mjs --check)", checkCode === 0,
  "run node tools/build-campaign.mjs giuseppe");

// --- report --------------------------------------------------------------------------------

if (failures.length) {
  console.error(`run-campaign: ${failures.length} of ${checked} checks failed`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`run-campaign: ${checked} checks passed`);
