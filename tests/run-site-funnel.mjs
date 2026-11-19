// THE SITE'S OWN FUNNEL, AND WHERE A SALE CAME FROM.
//
// Two months of Pro sales could not be explained, because the only funnel anybody could see was
// one creator video's and a Stripe Payment Link carries nothing from the click that opened it.
// Two mechanisms close that, and both fail SILENTLY if a name drifts -- which is exactly the
// trap tests/run-share-endpoints.mjs exists for, where a mis-named binding deploys cleanly and
// then 503s every share:
//
//   1. THE STEP NAMES. builder/campaign-track.js sends a step name and
//      functions/api/campaign/[code].js answers 204 and drops anything not on its whitelist. A
//      step the client sends and the server has never heard of is counted nowhere and nothing
//      anywhere says so. So every name the client can send is checked against that list.
//
//   2. THE QUOTA. The counter writes one R2 object per visitor per step per day and READS by
//      listing them, against a free tier of 1,000,000 Class A operations a month. A step fired
//      on every page view would be ~300,000 writes a month on its own. So no page in this site
//      may count a plain view here: Cloudflare's zone analytics already does that for free. The
//      guard is that no step is sent from app.js or from the generated page templates.
//
//   3. THE SALE'S SOURCE. pro-tool/plans/index.html must put `client_reference_id` on BOTH
//      payment links, and functions/api/stripe/webhook.js must store it -- cleaned, because the
//      value arrives from the open internet. Neither half is any use without the other.
//
// Source text, no browser and no network: these are pairings between files, which is the only
// thing that can drift.
//
//   node tests/run-site-funnel.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const endpoint = read("functions", "api", "campaign", "[code].js");
const tracker = read("builder", "campaign-track.js");
const plans = read("pro-tool", "plans", "index.html");
const webhook = read("functions", "api", "stripe", "webhook.js");

/* ------------------------------------------------- 1. the server's whitelist */
const stepsBlock = endpoint.match(/const STEPS = \[([\s\S]*?)\];/);
ok("the endpoint still declares a STEPS whitelist", Boolean(stepsBlock));
const serverSteps = new Set((stepsBlock?.[1] || "").match(/"([a-z_]+)"/g)?.map((s) => s.slice(1, -1)) || []);
ok("...and it is not empty", serverSteps.size > 0, String(serverSteps.size));
notes.push(`server accepts ${serverSteps.size} steps: ${[...serverSteps].join(", ")}`);

/* ------------------------------------------------- 2. every name a client sends */
// Every trackSite("x") and trackCampaign(code, "x") literal across the whole front end, plus the
// inline copy on the plans page, which has no module graph to import the tracker from.
const clientFiles = [
  ["builder/builder-page.js", read("builder", "builder-page.js")],
  ["builder/calc-page.js", read("builder", "calc-page.js")],
  ["builder/solver-page.js", read("builder", "solver-page.js")],
  ["builder/play-page.js", read("builder", "play-page.js")],
  ["pro-tool/plans/index.html", plans],
];
const sent = new Map();
for (const [name, text] of clientFiles) {
  for (const match of text.matchAll(/\btrackSite\(\s*"([a-z_]+)"/g)) sent.set(match[1], name);
  for (const match of text.matchAll(/\bstep\(\s*"([a-z_]+)"\s*\)/g)) sent.set(match[1], name);
  for (const match of text.matchAll(/\btrackCampaign\([^,]+,\s*"([a-z_]+)"/g)) sent.set(match[1], name);
}
// The two the builder sends through a lookup table rather than a literal.
for (const table of ["CAMPAIGN_TABS", "SITE_TABS"]) {
  const block = read("builder", "builder-page.js").match(new RegExp(`const ${table} = \\{([^}]*)\\}`));
  for (const match of (block?.[1] || "").matchAll(/:\s*"([a-z_]+)"/g)) sent.set(match[1], `builder-page.js ${table}`);
}
ok("the front end sends at least the eight steps this funnel is made of", sent.size >= 8, String(sent.size));
for (const [step, where] of sent) {
  ok(`"${step}" (${where}) is on the server's whitelist`, serverSteps.has(step),
    `not in [${[...serverSteps].join(", ")}]`);
}
notes.push(`client sends ${sent.size} steps: ${[...sent.keys()].sort().join(", ")}`);

/* ------------------------------------------------- 3. the quota guard */
// app.js is the Explorer and the template every one of the 2,717 generated pages is built from
// (tools/generate-manifest.mjs basePageHtml). A step fired there is a step fired on every page
// view on the site, which is the one thing this counter cannot afford.
const appJs = read("app.js");
ok("app.js counts no funnel step (it runs on every generated page)",
  !/trackSite\(|\/api\/campaign\//.test(appJs));
const template = read("index.html");
ok("index.html counts no funnel step either", !/\/api\/campaign\//.test(template));
ok("the endpoint says WHY a page view is not a step",
  /1,000,000|free tier/i.test(endpoint) && /page view/i.test(endpoint));

/* ------------------------------------------------- 4. the sale's source */
ok("the plans page puts client_reference_id on the Stripe link",
  plans.includes("client_reference_id="));
const planButtons = [...plans.matchAll(/data-plan="(monthly|yearly)"/g)].map((m) => m[1]);
ok("both plans still have a button", new Set(planButtons).size === 2, planButtons.join(","));
ok("...and the reference is built for whichever plan was clicked",
  /client_reference_id=" \+ encodeURIComponent\(plan \+ "-" \+ source\)/.test(plans));
ok("the plans page derives a source label from ?from= or the referrer",
  /function sourceLabel\(\)/.test(plans) && /document\.referrer/.test(plans));
ok("...and sanitises it to the characters Stripe and the record allow",
  /replace\(\/\[\^a-z0-9-\]\/g, ""\)/.test(plans));

ok("the webhook stores the source on the licence record",
  /source: String\(session\.client_reference_id/.test(webhook));
ok("...cleaned rather than trusted, because it arrives from the open internet",
  /client_reference_id[\s\S]{0,160}replace\(\/\[\^a-z0-9-\]\/g, ""\)/.test(webhook));
ok("...and bounded, so a crafted link cannot write a long value",
  /client_reference_id[\s\S]{0,200}\.slice\(0, \d+\)/.test(webhook));

/* ------------------------------------------------- 5. the gate is tagged */
const builder = read("builder", "builder-page.js");
ok("the gate links to the plans page with its own origin",
  /plansUrl\(`gate-\$\{feature\}`\)/.test(builder));
ok("the Solver's gate does too", /from=gate-solver/.test(read("builder", "solver-page.js")));
ok("plansUrl sanitises what it is given",
  /function plansUrl\(where\)[\s\S]{0,260}replace\(\/\[\^a-z0-9-\]\/g, ""\)/.test(builder));
// The nav is deliberately NOT tagged: with no ?from= the plans page falls back to the referrer's
// first path segment, which says "pokemon" or "moves" instead of a flat "nav" -- a better answer
// than the one a tag would have given.
ok("the nav link is left untagged so the referrer answers instead",
  !/pro-tool\/plans\/\?from=nav/.test(template));

/* ------------------------------------------------- 6. a step is a DECISION, not an arrival */
// The defect this guards was built and then removed on 19 Nov 2026. The content pages link in
// with `?tab=auto`, so counting a step when the deep link lands would have filed every one of
// those arrivals as "ran Auto Build" -- a tool-engagement figure manufactured by a redirect, at
// the scale of 2,717 pages, inside the instrument installed to stop guessing. It is the same
// defect the creator campaign's own funnel already has: `land` and `builder` both fire on one
// page load behind a 302, which is why that 91% is a fetch succeeding and not a conversion.
const applyBlock = builder.slice(builder.indexOf("function applyViewParams"),
  builder.indexOf("async function handleAddParam"));
ok("no funnel step is sent when a deep link merely arrives",
  !/track(Site|CampaignTab)\(/.test(applyBlock), applyBlock.match(/track\w+\([^)]*\)/)?.[0] || "");
ok("...and the file says why", /manufactured by a redirect|no user action|nothing is counted here/i.test(applyBlock));
for (const [fn, step] of [["runEvaluation", "evaluation"], ["runAutoBuild", "autobuild"], ["runTournament", "tournament"]]) {
  const body = builder.slice(builder.indexOf(`async function ${fn}(`));
  ok(`"${step}" is sent from ${fn}, where the button is pressed`,
    body.slice(0, 500).includes(`trackSite("${step}")`));
}

/* ------------------------------------------------- 7. the two copies of the Pokemon CTA */
// A Pokemon page carries this block TWICE: tools/generate-manifest.mjs writes it into the
// static HTML, and app.js rebuilds it inside the profile modal -- and app.js's own comment
// records that the modal covers the viewport, so the static one is read by crawlers and the
// modal one by people. Improving either alone is improving the half nobody reads.
const appJsCta = read("app.js");
const genCta = read("tools", "generate-manifest.mjs");
for (const needle of ["Build a team around", "tab=auto", "Just open the builder"]) {
  ok(`the modal CTA (app.js) and the static CTA (generate-manifest.mjs) agree on "${needle}"`,
    appJsCta.includes(needle) && genCta.includes(needle));
}
ok("app.js names the file it must stay in step with",
  /companionCta\(\)[\s\S]{0,120}generate-manifest\.mjs/.test(appJsCta));

/* ------------------------------------------------- 8. nothing identifying travels */
ok("the tracker sends only a step and a 16-hex id",
  /JSON\.stringify\(\{ step, visitor: visitorId\(\) \}\)/.test(tracker));
ok("the sale's source is a label, not the visitor id",
  !/visitorId\(\)/.test(plans.split("client_reference_id")[0].split("function step")[0] || "")
  || /source = sourceLabel\(\)/.test(plans));
// Asked of the CODE and not of the prose: the comment beside the field explains at length that
// a visitor id is exactly what must not go in it, and a bare text search read its own warning as
// the thing it was warning about.
const webhookCode = webhook.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok("the webhook stores no visitor id", !/visitor/i.test(webhookCode));

if (failures.length) {
  console.error(`run-site-funnel: ${failures.length} of ${checked} checks FAILED`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
for (const line of notes) console.log(`  ${line}`);
console.log(`run-site-funnel: ${checked} checks passed`);
