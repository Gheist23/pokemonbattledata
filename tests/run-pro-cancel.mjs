// Checks the "cancel my subscription" path: the block on /pro-tool/plans/ and
// the line inside the Team Builder's Pro dialog.
//
//   node tests/run-pro-cancel.mjs
//
// Both places work the same way. A Stripe customer-portal LOGIN link can be
// pasted into one constant (STRIPE_PORTAL, once at the bottom of
// pro-tool/plans/index.html and once in builder/pro.js); while it is empty the
// page and the dialog keep wording that always works -- the manage link in the
// Stripe receipt, or Discord -- instead of showing a dead button. So this file
// runs both states:
//
//   * the plans page's own inline script, against a small DOM, with the
//     constant unset, set to a real https link, and set to junk (which must be
//     ignored rather than written into an href);
//   * builder-page.js's cancelLine(), rendered through the real builder/ui.js
//     h(), with and without the link;
//   * the copy itself, because the system cannot cancel access instantly: the
//     token in the browser and in the Companion stays valid to the end of the
//     paid period plus the 7-day grace in functions/api/license/_lib.js, so any
//     wording that promises an immediate stop is a bug;
//   * that the dialog's existing "Cancel" button (which only dismisses it) and
//     "Remove key from this browser" (which only signs this browser out) are
//     not what the new line looks like.
//
// No browser and no network; nothing here touches Stripe.
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
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? ` - ${detail}` : ""}`);
};

const PORTAL = "https://billing.stripe.com/p/login/test_0000example";
const PORTAL_LIVE = "https://billing.stripe.com/p/login/3cIaEX7TQfju0rIei157W00";
// Wording that would be false: the licence keeps verifying offline until the
// paid period plus GRACE_DAYS, and the Companion re-checks only every few days.
const FALSE_PROMISES = [
  /pro (?:stops|ends) (?:immediately|right away|at once)/i,
  /(?:immediately|instantly) (?:lose|loses|lost) (?:pro|access)/i,
  /cancel(?:ling|s)? (?:now )?(?:and|to) (?:end|stop) (?:pro|it) (?:immediately|now)/i,
];

/* ------------------------------------------------------------ a tiny DOM */

class NodeBase {
  constructor() { this.childNodes = []; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
}
class TextNode extends NodeBase {
  constructor(value) { super(); this.value = String(value); }
  get textContent() { return this.value; }
}
class El extends NodeBase {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.attrs = {};
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.hidden = false;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener() {}
  append(...children) { for (const child of children) this.childNodes.push(child); }
}
globalThis.Node = NodeBase;
globalThis.document = {
  createElement: (tag) => new El(tag),
  createTextNode: (value) => new TextNode(value),
};

const links = (node) => {
  const found = [];
  const walk = (n) => {
    if (n instanceof El) {
      if (n.tagName === "A") found.push(n);
      n.childNodes.forEach(walk);
    }
  };
  walk(node);
  return found;
};

/* ------------------------------------------------- the plans page markup */

const plans = read("pro-tool", "plans", "index.html");
const cancelParagraph = plans.match(/<p class="tool-cta-note tool-cta-note-center" id="cancel">[\s\S]*?<\/p>/)?.[0] || "";

ok("the plans page has a cancel block", cancelParagraph.length > 0);
// The owner asked for this paragraph under "Already subscribed?", in their own
// words: the receipt link, no Discord, and what actually happens to Pro.
ok("it sits under the \"Already subscribed?\" note",
  plans.indexOf("Already subscribed?") < plans.indexOf('id="cancel"'),
  `subscribed ${plans.indexOf("Already subscribed?")}, cancel ${plans.indexOf('id="cancel"')}`);
ok("it opens with the owner's question", /<strong>Want to cancel\?<\/strong>/.test(cancelParagraph));
ok("it offers the Stripe Customer Portal",
  /Manage or cancel your subscription at any time through the <a[^>]*>Stripe Customer Portal<\/a>\./.test(cancelParagraph),
  cancelParagraph.slice(0, 200));
ok("the portal link is the live one",
  cancelParagraph.includes(`href="${PORTAL_LIVE}"`));
ok("it opens in a new tab safely",
  /<a href="https:\/\/billing\.stripe\.com[^"]*" target="_blank" rel="noopener">/.test(cancelParagraph));
ok("nobody is sent hunting through their email", !/receipt email/i.test(cancelParagraph));
ok("it does not send anyone to Discord to cancel", !/discord\.gg/.test(cancelParagraph));
ok("the page says Pro runs on to the end of the period", /end of the period you are in/i.test(cancelParagraph));
ok("it names the trial and the paid period", /the free trial, or the month or year you have paid for/.test(cancelParagraph));
ok("the page names the up-to-a-week lag", /up to a week/i.test(cancelParagraph));
ok("the page says the teams and the Box are kept", /teams and your Box stay exactly where they are/.test(cancelParagraph));
ok("the page promises no instant stop",
  !FALSE_PROMISES.some((pattern) => pattern.test(cancelParagraph)),
  FALSE_PROMISES.map((p) => cancelParagraph.match(p)?.[0]).filter(Boolean).join(" | "));
ok("the trial sentence further up is untouched",
  /7-day free trial<\/strong>; cancel inside it and you are not charged/.test(plans));

/* --------------------------------------------- the plans page inline script */

const inlineScript = [...plans.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).pop() || "";
ok("the inline script still holds the portal URL, so the page has one home for it",
  inlineScript.includes(`var STRIPE_PORTAL = "${PORTAL_LIVE}";`),
  inlineScript.match(/var STRIPE_PORTAL = "[^"]*";/)?.[0] || "missing");
ok("the payment links are still rewritten by the same script", /data-plan="/.test(inlineScript));
ok("the script no longer injects the cancel link, the paragraph carries it",
  !/getElementById\("cancelPortal/.test(inlineScript) && !/createElement\("a"\)/.test(inlineScript));

/* ------------------------------------------------------- builder/pro.js */

const proSource = read("builder", "pro.js");
const proPortal = proSource.match(/const STRIPE_PORTAL = "([^"]*)";/)?.[1];
ok("builder/pro.js carries the same constant", proPortal !== undefined);
ok("builder/pro.js exports portalUrl()", /export function portalUrl\(\)/.test(proSource));
ok("portalUrl() only accepts an https URL", /\/\^https:\\\/\\\/\/\.test\(url\)/.test(proSource), proSource.match(/return .*url.*;/)?.[0] || "");
// If one place has the link and the other does not, half the site would still
// be telling people to dig through their receipts.
const planPortal = inlineScript.match(/var STRIPE_PORTAL = "([^"]*)";/)?.[1] ?? "";
ok("the plans page and the Pro dialog point at the same portal link",
  (proPortal || "").trim() === planPortal.trim(),
  `pro.js ${JSON.stringify(proPortal)} vs plans page ${JSON.stringify(planPortal)}`);

/* ---------------------------------------------- the Pro dialog's cancel line */

const builderSource = read("builder", "builder-page.js");
const cancelLineSource = builderSource.match(/function cancelLine\(\) \{[\s\S]*?\n\}/)?.[0] || "";
const proDialogSource = builderSource.match(/function openProDialog\(\) \{[\s\S]*?\n\}/)?.[0] || "";

ok("builder-page.js has a cancelLine()", cancelLineSource.length > 0);
ok("the Pro dialog shows it", /cancelLine\(\)/.test(proDialogSource));
// The Pro-active branch is the one before the ternary's ":"; the other branch is
// the activation form, where there is nothing to cancel.
const branches = proDialogSource.split("      : h(\"div\", {}, h(\"p\", { class: \"bd-confirm-text\" }, \"Enter the licence key");
ok("the dialog still has its two branches", branches.length === 2, `found ${branches.length}`);
ok("only the Pro-is-active branch shows it",
  branches.length === 2 && /cancelLine\(\)/.test(branches[0]) && !/cancelLine\(\)/.test(branches[1]));
ok("the activation branch still has exactly one \"Cancel\" button, the dismiss one",
  (proDialogSource.match(/\}, "Cancel"\)/g) || []).length === 1);
ok("\"Remove key from this browser\" is untouched", /"Remove key from this browser"/.test(proDialogSource));

const { h } = await import("../builder/ui.js");
function renderCancelLine(portal) {
  const factory = new Function("h", "portalUrl", "DISCORD_URL", `${cancelLineSource}\nreturn cancelLine;`);
  return factory(h, () => portal, "https://discord.gg/k93eVQzj8c")();
}

{
  const node = renderCancelLine("");
  const text = node.textContent;
  const anchors = links(node);
  ok("dialog, unset: it still offers the portal in words", /through the Stripe Customer Portal\./.test(text), text.slice(0, 120));
  // The dialog says the same as the plans page: the receipt link, no Discord.
  ok("dialog, unset: no link is needed", anchors.length === 0,
    anchors.map((a) => a.getAttribute("href")).join(" | "));
  ok("dialog, unset: it does not send anyone to Discord to cancel", !/discord/i.test(text));
  ok("dialog, unset: it uses the owner's wording", /Want to cancel\?/.test(text) && /Manage or cancel your subscription at any time/.test(text), text.slice(0, 90));
  ok("dialog, unset: no Stripe portal link is invented", !/billing\.stripe\.com/.test(anchors.map((a) => a.getAttribute("href")).join(" ")));
}
{
  const node = renderCancelLine(PORTAL);
  const text = node.textContent;
  const anchors = links(node);
  ok("dialog, set: one link, to the portal", anchors.length === 1 && anchors[0].getAttribute("href") === PORTAL,
    anchors.map((a) => a.getAttribute("href")).join(" | "));
  // The link is named after where it goes; the sentence around it says what it does.
  ok("dialog, set: the link names the portal", /Stripe Customer Portal/.test(anchors[0]?.textContent || ""), anchors[0]?.textContent || "");
  ok("dialog, set: the sentence says what happens there", /Manage or cancel your subscription at any time/.test(text), text.slice(0, 120));
  ok("dialog, set: it opens in a new tab safely",
    anchors[0]?.getAttribute("target") === "_blank" && /noopener/.test(anchors[0]?.getAttribute("rel") || ""));
  ok("dialog: cancelling is told apart from removing the key here",
    /not the same as removing the key/i.test(text), text);
  ok("dialog: it says Pro runs to the end of the period", /end of the period you are in/i.test(text), text);
  ok("dialog: it names the up-to-a-week lag", /up to a week/i.test(text), text);
  ok("dialog: it says the teams and the Box are kept", /teams and your Box/i.test(text), text);
  ok("dialog: it promises no instant stop", !FALSE_PROMISES.some((pattern) => pattern.test(text)), text);
}

/* ---------------------------------------------------------------- report */

if (failures.length) {
  console.error(`FAIL ${failures.length}/${checked}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`OK ${checked}/${checked} checks - cancel path (plans page + Pro dialog), both with and without the Stripe portal link`);
