// WHAT PRO COSTS, SAID THE SAME EVERYWHERE, AND POINTING AT THE RIGHT CHECKOUT.
//
// The price is written out in SEVEN places -- four bits of running copy and three schema.org
// Offer blocks -- and the checkout it belongs to is written in four more. Nothing joins them
// up, so on 19 Nov 2026 the site had already drifted once in exactly this way: the gate and the
// plans page promised a payment method the monthly checkout did not offer, because a Stripe
// Payment Link FREEZES the account's payment-method set at the moment it is created, and
// enabling one afterwards never reaches it.
//
// A wrong price is worse than a wrong feature list. Somebody who read EUR 5 and is charged
// EUR 9 has been misled at the one moment they were willing to pay, and the first they hear of
// it is the card statement. So this suite asks one question of the whole site: does every
// surface quote the same price, and do the buttons go to the checkout that charges it?
//
// The DERIVED numbers are checked too -- "EUR 5.75 a month", "saves EUR 39" -- because they are
// the ones a price change forgets. They are arithmetic, so they are simply recomputed here.
//
//   node tests/run-pricing.mjs
//
// Source text, no browser and no network. Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

// ---------------------------------------------------------------------------
// THE PRICE. Change these two numbers and the suite names every file that still
// disagrees -- which is the whole point of it.
// ---------------------------------------------------------------------------
const MONTHLY = 9;
const YEARLY = 89;
const PER_MONTH = (YEARLY / 12).toFixed(2);          // "5.75"
const SAVING = MONTHLY * 12 - YEARLY;                // 39

// The live Payment Links these prices belong to. Replacing a price means replacing the link:
// a Stripe Payment Link's amount cannot be edited after the link is created.
const LINK_MONTHLY = "https://buy.stripe.com/7sYbJ1eie7R27Ua0rb57W02";
const LINK_YEARLY = "https://buy.stripe.com/bJe8wP6PM8V6eiygq957W04";
// Superseded. Deactivated in Stripe; each must appear nowhere on the site.
//   EUR 5/month and EUR 45/year, retired 20 Nov 2026 on the rise to EUR 9/EUR 69.
//   EUR 69/year, retired the same day: yearly subscribers churn at 60% against monthly's 33%,
//   so the 36% yearly discount was being handed to the worst-retaining cohort. EUR 89 is an 18%
//   discount, which is a saving worth naming without funding the churn.
const RETIRED_LINKS = [
  "https://buy.stripe.com/3cIaEX7TQfju0rIei157W00",
  "https://buy.stripe.com/14A00j4HE7R24HY8XH57W01",
  "https://buy.stripe.com/14A9AT1vs3AM3DUddX57W03",
];

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const plans = read("pro-tool", "plans", "index.html");
const proTool = read("pro-tool", "index.html");
const builder = read("builder", "builder-page.js");
const solver = read("builder", "solver-page.js");
const solverPage = read("solver", "index.html");
const teamBuilderPage = read("team-builder", "index.html");

/* ------------------------------------------------- 1. the running copy agrees */
// Four surfaces say the price in a sentence. They are four different files written months
// apart, and they are the ones that drift.
const SENTENCES = [
  ["pro-tool/plans/index.html (hero)", plans, `Free for 7 days, then &euro;${MONTHLY} a month or &euro;${YEARLY} a year.`],
  ["pro-tool/index.html (download foot)", proTool, `Pro is &euro;${MONTHLY} a month or &euro;${YEARLY} a year`],
  ["builder/builder-page.js (PRO_TERMS)", builder, `then €${MONTHLY} a month or €${YEARLY} a year`],
  ["builder/solver-page.js (Solver gate)", solver, `then €${MONTHLY} a month or €${YEARLY} a year`],
];
for (const [where, text, needle] of SENTENCES) {
  ok(`${where} quotes the current price`, text.includes(needle), needle);
}

/* ------------------------------------------------- 2. the plan cards agree */
ok("the yearly card shows the yearly price",
  plans.includes(`<span class="plan-amount">&euro;${YEARLY}</span> <span class="plan-period">/ year</span>`));
ok("the monthly card shows the monthly price",
  plans.includes(`<span class="plan-amount">&euro;${MONTHLY}</span> <span class="plan-period">/ month</span>`));

/* ------------------------------------------------- 3. the DERIVED numbers */
// The two a price change forgets, because they are not the price.
ok("the yearly card's per-month figure is right",
  plans.includes(`&euro;${PER_MONTH} a month`), `expected &euro;${PER_MONTH} a month`);
ok("...and the saving against monthly is right",
  plans.includes(`saves &euro;${SAVING} against monthly`), `expected saves &euro;${SAVING}`);
notes.push(`EUR ${MONTHLY}/month, EUR ${YEARLY}/year -> EUR ${PER_MONTH} a month, saves EUR ${SAVING}`);

/* ------------------------------------------------- 4. the structured data agrees */
// Google reads these, and a stale Offer price is a wrong price shown in a search result -- the
// one place a buyer can see it before they ever reach the site.
const OFFERS = [
  ["pro-tool/index.html", proTool, true],
  ["team-builder/index.html", teamBuilderPage, true],
  ["solver/index.html", solverPage, false],  // monthly only
];
for (const [where, text, hasYearly] of OFFERS) {
  ok(`${where} Offer: monthly price`, text.includes(`"name": "Pro monthly", "price": "${MONTHLY}"`));
  if (hasYearly) ok(`${where} Offer: yearly price`, text.includes(`"name": "Pro yearly", "price": "${YEARLY}"`));
}

/* ------------------------------------------------- 5. nothing quotes a superseded price */
// Asked of every surface at once, so a file nobody thought of still fails here. Bare "5" and
// "45" appear all over this site (stats, percentages, usage), so this asks for them only in the
// shapes a PRICE takes.
const SURFACES = [
  ["pro-tool/plans/index.html", plans], ["pro-tool/index.html", proTool],
  ["builder/builder-page.js", builder], ["builder/solver-page.js", solver],
  ["solver/index.html", solverPage], ["team-builder/index.html", teamBuilderPage],
];
const STALE = [
  new RegExp(`&euro;(?!${YEARLY}\\b|${MONTHLY}\\b|0\\b|${PER_MONTH}\\b|${SAVING}\\b)\\d`, "g"),
  new RegExp(`€(?!${YEARLY}\\b|${MONTHLY}\\b)\\d+ a (month|year)`, "g"),
  new RegExp(`"price": "(?!${MONTHLY}"|${YEARLY}"|0")\\d+"`, "g"),
];
for (const [where, text] of SURFACES) {
  for (const pattern of STALE) {
    const hits = text.match(pattern) || [];
    ok(`${where} quotes no superseded price`, hits.length === 0, hits.join(" "));
  }
}

/* ------------------------------------------------- 6. the buttons go to that price */
// The plans page carries each link TWICE: in the <a href> that works without JavaScript, and in
// the var the inline script rewrites it from when it appends client_reference_id. If those two
// ever disagree, which price a buyer gets depends on whether the script ran.
ok("the yearly button's href is the live yearly link",
  plans.includes(`href="${LINK_YEARLY}" data-plan="yearly"`));
ok("the monthly button's href is the live monthly link",
  plans.includes(`href="${LINK_MONTHLY}" data-plan="monthly"`));
ok("...and the script rewrites from the same yearly link",
  plans.includes(`var STRIPE_YEARLY = "${LINK_YEARLY}";`));
ok("...and from the same monthly link",
  plans.includes(`var STRIPE_MONTHLY = "${LINK_MONTHLY}";`));
for (const [where, text] of SURFACES) {
  for (const retired of RETIRED_LINKS) {
    ok(`${where} links to no retired checkout`, !text.includes(retired), retired);
  }
}

/* ------------------------------------------------- 7. the payment methods agree */
// The drift that actually happened. A Payment Link freezes the account's payment-method set at
// CREATION, so a method switched on afterwards reaches NEW links only -- which is why the
// retired monthly link still showed no PayPal a day after PayPal was enabled. These three
// sentences are one claim about the live checkout, so they must be one sentence, not three.
const METHODS = "Card, PayPal, Klarna and more at checkout.";
ok("the plans hero names the payment methods", plans.includes(METHODS));
ok("the Team Builder gate names the same ones", builder.includes(`const PRO_PAYMENT = "${METHODS}";`));
ok("the Solver gate names the same ones", solver.includes(`"${METHODS}"`));
ok("builder-page.js records WHEN that was last checked against the live checkout",
  /RE-CHECKED AGAINST THE LIVE CHECKOUT, \d{1,2} \w+ \d{4}/.test(builder));
ok("...and why enabling a method does not reach an existing link",
  /freezes the account's payment-method set at the moment it is CREATED/i.test(builder));

/* ------------------------------------------------- 8. the trial is still promised */
// Every surface that names a price also promises the trial; the two travel together. The 7 days
// is set on the Payment Link and not here, so this number is a claim about Stripe -- it was
// verified against both live checkouts on 20 Nov 2026 ("7 Tage kostenlos", "Heute faellige
// Gesamtsumme 0,00 EUR").
for (const [where, text] of [["the plans hero", plans], ["PRO_TERMS", builder], ["the Solver gate", solver]]) {
  ok(`${where} still promises the free trial`, /Free for 7 days/.test(text));
}
ok("the plans page still spells out that cancelling inside it costs nothing",
  /7-day free trial<\/strong>; cancel inside it and you are not charged/.test(plans));

/* ------------------------------------------------- 9. the new price reaches cached clients */
// /builder/*.js is served max-age=14400 by Cloudflare whatever _headers asks for -- verified
// live on 20 Nov 2026 ("Cache-Control: max-age=14400, must-revalidate") -- while the pages that
// load it are no-cache. So on the day a price changes, a returning visitor runs the OLD module
// for up to four hours: the gate quotes the old price while the checkout already charges the
// new one, which is the exact failure this whole suite exists to prevent. The ?v= token is part
// of the module's URL, so bumping it fetches the new module at once. It is keyed on the PRICE
// rather than on a date precisely so that this suite can refuse a price change that forgets it.
const BUST = `p${MONTHLY}-${YEARLY}`;
for (const [page, text, mod] of [
  ["team-builder/index.html", teamBuilderPage, "builder-page.js"],
  ["solver/index.html", solverPage, "solver-page.js"],
]) {
  ok(`${page} loads its module with the current price's cache-bust token`,
    text.includes(`src="/builder/${mod}?v=${BUST}"`), `expected src="/builder/${mod}?v=${BUST}"`);
  ok(`${page} loads that module exactly once`,
    (text.match(new RegExp(`src="/builder/${mod}`, "g")) || []).length === 1);
  ok(`${page} records why the token is there`, /max-age=14400/.test(text));
}
notes.push(`cache-bust token: ?v=${BUST}`);

if (failures.length) {
  console.error(`run-pricing: ${failures.length} of ${checked} checks FAILED`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
for (const line of notes) console.log(`  ${line}`);
console.log(`run-pricing: ${checked} checks passed`);
