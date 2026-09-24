// The page must not jump: what the player is looking at has to stay where it is
// when the Team Builder or the Damage Calculator redraws.
//
//   node tests/run-scroll-anchor.mjs
//   node tests/run-scroll-anchor.mjs --verbose          every number, action by action
//   WIDTHS=390,768,1024,1440 node tests/run-scroll-anchor.mjs
//
// Both pages redraw by emptying a container and building it again, which throws the
// browser's own scroll anchor away, so builder/scroll-anchor.js puts the position
// back by hand.  This test pins that: for every action the owner reported - removing
// a Pokemon, adding one to the Box, replacing one, changing an item, ability, move,
// nature or stat points, switching the analysis tab, opening and closing a dialog,
// and on the calculator picking a Pokemon, a move, a field toggle, a stat stage or
// the format - it measures two things before and after.
//
//   * three landmarks: one named piece of text from each third of the screen's width -
//     one per column - and how far each moved, across and down.  Each is named by where
//     it sits in the page's structure, which of the identically built cards at that spot
//     it is, and what it says, so that it is only counted as found again when all three
//     still agree.  This is the owner's complaint stated literally: "what I was looking
//     at moved".
//   * the median of everything on screen.
//
// The median moving by more than 2px is the failure, for every action.  It is the
// sharp check and the one that bites: with builder/scroll-anchor.js taken out, 22 of
// these measurements move it, "remove a Pokemon" by the reported 128px.
//
// Two things are allowed for, because no scroll offset can undo either.  A view that
// shrinks past where the player was standing takes them to its new bottom, and the
// screen slides down by exactly that much; and switching the Overview's sub-tab on a
// phone, where that column is the whole screen, leaves nothing on screen that was
// there before, so there is nothing to compare - scroll-anchor.js gives up for the
// same reason.  Both are counted and named rather than passed over quietly.
//
// The landmarks are printed beside it as named evidence, and are only asserted on for
// the actions marked "nothing behind may move" - opening and closing a dialog, which
// changes nothing on the page underneath, so there every landmark has to hold both its
// height and its column.  That is the check for a dialog taking the page scrollbar away
// with it.  Elsewhere a landmark can move for reasons no scroll offset can undo: these
// pages lay their panels out in columns, so when one column genuinely grows - filling
// an empty team slot makes the team card 106px taller - whatever sits below it in that
// column moves, and the calculator's stat table sets its own column widths from the
// numbers in it, so changing a nature shifts a header sideways by 12px.  Neither is
// the page jumping, and the median is the honest question there.
//
// window.scrollY is reported but never asserted on: it is the number that stayed
// still while the page slid under it, so holding it fixed is the bug, not the fix.
//
// One thing to know when reading --verbose: naming a landmark by spot, ordinal and
// text is good but not perfect, and when an action replaces a whole card a landmark
// can occasionally be found again as its lookalike somewhere else, which prints as a
// few hundred px sideways. It shows up about once in 250 measurements. That is one
// more reason the landmarks are only asserted on for the actions that should change
// nothing at all, where no card is replaced and the naming cannot slip.
//
// It also pins the three ways a fix like this goes wrong: it must not scroll the page
// at the top (where there is nothing above the screen to hold still), it must not
// scroll on a view's first draw, and it must not move the page sideways when a dialog
// takes the scrollbar away.
//
// This is the one test here that needs a browser, because it is a question about
// layout.  It starts its own dev server and its own headless Chrome with a scratch
// profile, and touches nothing else.  With no Chrome installed it says SKIPPED.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const PORT = Number(process.env.PORT || 8871);
const CDP = Number(process.env.CDP || 9471);
// A phone, the width the jump was reported at, and a wide screen: three different
// bands of builder.css's breakpoints (420 / 760 / 860 / 960 / 1100 / 1240).
const WIDTHS = (process.env.WIDTHS || "390,1024,1440").split(",").map(Number);
const HEIGHT = 800;
/** How far a screenful may drift before it reads as a jump. */
const TOLERANCE = 2;
const VERBOSE = process.argv.includes("--verbose");

const CHROMES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const chromePath = CHROMES.find((path) => existsSync(path));
if (!chromePath) {
  console.log("SKIPPED run-scroll-anchor.mjs: no Chrome found. Set CHROME to its path to run it.");
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
let checked = 0;
let landmarksMissed = 0;
/** Actions that swapped out everything on screen, so there was nothing to compare. */
let unmeasurable = 0;

// ------------------------------------------------------------------ the page's side

// __mark() records where everything on screen sits, keyed by a plain child-index path
// (which survives a rebuild that keeps the same shape) plus the element's own text, so
// "something else now sits here" is never counted as movement.  It also picks the
// landmark.  Both stay in the page; __shift() re-measures and returns only the verdict,
// so a screenful of elements is never serialised across the wire.
const PAGE_HELPERS = `
window.__settle = () => Promise.race([
  Promise.all([...document.images].map((img) => img.complete ? null : new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); }))),
  new Promise((r) => setTimeout(r, 900)),
]).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
window.__jump = (top) => {
  const html = document.documentElement;
  html.style.scrollBehavior = "auto";          // styles.css asks for smooth site-wide
  window.scrollTo({ top, behavior: "instant" });
  html.style.removeProperty("scroll-behavior");
  return window.scrollY;
};
window.__own = (el) => {
  let text = "";
  for (let n = el.firstChild; n && text.length < 60; n = n.nextSibling) if (n.nodeType === 3) text += n.data;
  return text.replace(/\\s+/g, " ").trim().slice(0, 44);
};
/** Where an element sits structurally: its ancestors' tags and first class names all the
 *  way up to <body>, which a rebuild reproduces exactly. Without this, "the only 171 on
 *  the page" is found again as a different 171 in another column and reads as a 12px
 *  sideways jump - and the chain has to reach the column, so it must not be cut short. */
window.__where = (el) => {
  const parts = [];
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const cls = (n.getAttribute("class") || "").trim().split(/\s+/)[0];
    parts.push(n.tagName + (cls ? "." + cls : ""));
  }
  return parts.reverse().join(">");
};
/** Naming a landmark: which structural spot, which one of those (the team slots are a
 *  grid of identically built cards, so the spot alone names six of them), and what it
 *  says. Found again only when all three still agree - text alone is not enough,
 *  because replacing a Pokemon moves a "20%" to the card beside it and matching that
 *  reads as the page jumping 460px sideways, and the spot alone is not enough either. */
window.__ordinals = () => {
  const seen = new Map();
  const ordinal = new WeakMap();
  for (const el of document.body.getElementsByTagName("*")) {
    const spot = window.__where(el);
    const n = (seen.get(spot) || 0) + 1;
    seen.set(spot, n);
    ordinal.set(el, n);
  }
  return ordinal;
};
window.__sweep = () => {
  const height = innerHeight;
  const tops = Object.create(null);
  const onScreen = [];
  const walk = (el, path, depth) => {
    let i = 0;
    for (const child of el.children) {
      i += 1;
      const tag = child.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" || tag === "DIALOG") continue;
      const rect = child.getBoundingClientRect();
      const here = path + ">" + i;
      if (rect.height >= 6 && rect.width >= 6 && rect.top >= 0 && rect.top <= height) {
        tops[here] = [Math.round(rect.top * 100) / 100, tag + "|" + child.childElementCount + "|" + window.__own(child)];
        onScreen.push([child, rect]);
      }
      if (depth < 14) walk(child, here, depth + 1);
    }
  };
  walk(document.body, "", 0);
  return { tops, onScreen };
};
window.__mark = () => {
  const { tops, onScreen } = window.__sweep();
  // The landmarks: one piece of text from each third of the screen's width, near the
  // middle of its height, each the only one of its kind so it can be found again by
  // name and not by where it ended up. One per third because these pages lay their
  // panels out side by side: a landmark from each column tells a page that slid (they
  // all move) apart from one column that genuinely grew (only its own moves).
  const ordinal = window.__ordinals();
  const usable = onScreen.filter(([el]) => {
    if (window.__own(el).length < 3) return false;
    const pos = getComputedStyle(el).position;        // a pinned bar holds still by design
    return pos !== "fixed" && pos !== "sticky";
  });
  const wanted = [];
  const middle = innerHeight * 0.45;
  for (const third of [0, 1, 2]) {
    const from = (innerWidth / 3) * third;
    const to = (innerWidth / 3) * (third + 1);
    let best = null;
    for (const [el, rect] of usable) {
      const centre = rect.left + rect.width / 2;
      if (centre < from || centre >= to) continue;
      if (wanted.some((w) => w.spot === window.__where(el) && w.n === ordinal.get(el))) continue;
      if (!best || Math.abs(rect.top - middle) < Math.abs(best[1].top - middle)) best = [el, rect];
    }
    if (best) {
      wanted.push({
        spot: window.__where(best[0]), n: ordinal.get(best[0]), text: window.__own(best[0]),
        name: window.__own(best[0]).slice(0, 26),
        top: Math.round(best[1].top * 100) / 100, left: Math.round(best[1].left * 100) / 100,
      });
    }
  }
  window.__before = { tops, landmarks: wanted, scrollY: Math.round(scrollY * 100) / 100, docH: document.documentElement.scrollHeight };
  return { scrollY: window.__before.scrollY, marks: Object.keys(tops).length, landmarks: wanted.length };
};
window.__find = (want) => {
  let n = 0;
  for (const el of document.body.getElementsByTagName("*")) {
    if (window.__where(el) !== want.spot) continue;
    n += 1;
    if (n < want.n) continue;
    return window.__own(el) === want.text ? el : null;  // something else holds the spot now
  }
  return null;
};
window.__shift = () => {
  const before = window.__before;
  const { tops } = window.__sweep();
  const moved = [];
  for (const key of Object.keys(before.tops)) {
    const now = tops[key];
    if (!now || now[1] !== before.tops[key][1]) continue;
    moved.push(Math.round((now[0] - before.tops[key][0]) * 100) / 100);
  }
  const landmarks = [];
  for (const want of before.landmarks) {
    const el = window.__find(want);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    landmarks.push({
      name: want.name,
      down: Math.round((rect.top - want.top) * 100) / 100,
      across: Math.round((rect.left - want.left) * 100) / 100,
      was: want.top,
      now: Math.round(rect.top * 100) / 100,
    });
  }
  const sorted = [...moved].sort((a, b) => a - b);
  // How much of any movement the page had no say in: when a view shrinks past where
  // the player was standing, the browser pins them to the new bottom, and the content
  // slides down by exactly the difference. Nothing can hold a position off the end.
  const room = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  return {
    landmarks,
    asked: before.landmarks.length,
    pinned: Math.round(Math.max(0, before.scrollY - room) * 100) / 100,
    replaced: Math.abs(document.documentElement.scrollHeight - before.docH) > innerHeight / 3,
    seen: moved.length,
    median: moved.length ? sorted[sorted.length >> 1] : null,
    worst: sorted.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0),
    scroll: [before.scrollY, Math.round(scrollY * 100) / 100],
    doc: [before.docH, document.documentElement.scrollHeight],
  };
};
`;

// ---------------------------------------------------------------------- the harness

const profile = mkdtempSync(join(tmpdir(), "cbd-anchor-"));
const server = spawn(process.execPath, ["tests/dev-server.mjs"], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
const chrome = spawn(chromePath, [
  "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  `--window-size=${WIDTHS[0]},${HEIGHT}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
], { stdio: "ignore" });

let socket = null;
async function shutdown(code) {
  try { socket?.close(); } catch { /* already gone */ }
  chrome.kill();
  server.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* the OS will */ }
  process.exit(code);
}

let target = null;
for (let i = 0; i < 100 && !target; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    target = list.find((t) => t.type === "page");
  } catch {
    await sleep(200);
  }
}
if (!target) {
  console.log("SKIPPED run-scroll-anchor.mjs: headless Chrome did not start.");
  await shutdown(0);
}
socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve));
let seq = 0;
const pending = new Map();
const pageErrors = [];
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") pageErrors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 200));
});
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) {
  const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 600));
  return reply.result?.result?.value;
}
const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`));
const viewport = (width) => send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 1, mobile: width < 768, screenWidth: width, screenHeight: HEIGHT });

async function open(url) {
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}${url}` });
  await sleep(3400);
  await evaluate(PAGE_HELPERS);
  await evaluate(`window.__settle()`);
}

/**
 * Runs one action at one scroll position and says how far the screen moved.
 *
 * @param still  true when the action leaves the page behind it untouched, so every
 *               landmark has to hold its exact place, across as well as down.
 */
async function measure(label, place, fraction, action, still = false) {
  const max = await evaluate(`document.documentElement.scrollHeight - innerHeight`);
  const wanted = Math.max(0, Math.round(max * fraction));
  await evaluate(`window.__jump(${wanted})`);
  await evaluate(`window.__settle()`);
  await evaluate(`window.__jump(${wanted})`);
  await sleep(60);
  await evaluate(`window.__mark()`);
  const did = await evaluate(action);
  await evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  await sleep(260);
  await evaluate(`window.__settle()`);
  const shift = await json(`window.__shift()`);
  checked += 1;
  const where = `${place}: "${label}"`;
  if (did !== true) {
    failures.push(`${where} did not run (${JSON.stringify(did)})`);
    return shift;
  }
  const tail = `\n     scroll ${shift?.scroll[0]} -> ${shift?.scroll[1]}, document ${shift?.doc[0]} -> ${shift?.doc[1]}, ${shift?.seen} elements measured`;
  if (!shift || shift.seen < 3) {
    // On a phone the middle column is the whole screen, so switching the Overview's
    // sub-tab swaps out everything there was: there is no "same place" left to hold,
    // and scroll-anchor.js gives up for the same reason (fewer than MIN_MARKS found).
    // That is only fair when the view really was replaced - if the page is the same
    // height as before, nothing recognisable on it is a broken redraw.
    if (shift?.replaced) { unmeasurable += 1; if (VERBOSE) console.log(`  ${place.padEnd(23)} ${label.padEnd(30)} the whole screen was replaced, nothing to compare${tail}`); }
    else failures.push(`${where} left nothing recognisable on screen to measure${tail}`);
    return shift;
  }
  // A view that shrank past where the player was standing takes them to its new bottom
  // whatever anyone does, and everything on screen slides down by that much.
  const allowed = TOLERANCE + shift.pinned;
  if (Math.abs(shift.median) > allowed) {
    failures.push(`${where} moved the middle of the screen by ${shift.median}px`
      + (shift.pinned ? ` (${shift.pinned}px of that is the page ending above where the player was)` : "") + tail);
  }
  if (!shift.landmarks.length) {
    landmarksMissed += 1;
    if (still) failures.push(`${where} left nothing on screen to recognise, and it should have changed nothing at all${tail}`);
  }
  if (still) {
    // Nothing on the page behind changed, so nothing on it may have moved either.
    for (const mark of shift.landmarks) {
      if (Math.abs(mark.down) > TOLERANCE) failures.push(`${where} should change nothing behind it, but moved "${mark.name}" ${mark.down}px down the page (${mark.was} -> ${mark.now})${tail}`);
      if (Math.abs(mark.across) > TOLERANCE) failures.push(`${where} should change nothing behind it, but moved "${mark.name}" ${mark.across}px sideways${tail}`);
    }
  }
  if (VERBOSE) {
    const marks = shift.landmarks.length
      ? shift.landmarks.map((mark) => `${mark.down}/${mark.across}`).join(" ").padEnd(24)
      : "(all gone)".padEnd(24);
    console.log(`  ${place.padEnd(23)} ${label.padEnd(30)} landmarks ${marks} median ${String(shift.median).padStart(8)}  worst ${String(shift.worst).padStart(8)}  scroll ${shift.scroll[0]} -> ${shift.scroll[1]}  doc ${shift.doc[0]} -> ${shift.doc[1]}`);
  }
  return shift;
}

// --------------------------------------------------------------------- the actions

const TEAM = JSON.parse(readFileSync(join(here, "scroll-anchor-team.json"), "utf8"));

/** Reaches the store the same way the page does, so an action changes real state. */
const withStore = (body) => `(async () => { const s = await import("/builder/store.js"); const { makeSet } = await import("/builder/common.js"); const list = s.teamSets(s.currentTeam(), window.__data); ${body} })()`;
const tab = (name) => `(() => { const b = [...document.querySelectorAll(".bd-toolbar .bd-tab")].find((x) => x.textContent.trim() === ${JSON.stringify(name)}); if (!b) return "no ${name} tab"; b.click(); return true; })()`;
const subtab = (name) => `(() => { const b = [...document.querySelectorAll(".bd-overview-bar .bd-subtabs .bd-tab")].find((x) => x.textContent.trim() === ${JSON.stringify(name)}); if (!b) return "no ${name} sub-tab"; b.click(); return true; })()`;
const slotTool = (glyph, nth) => `(() => { const b = [...document.querySelectorAll(".bd-team-col .bd-slot .bd-slot-tools button")].filter((x) => x.textContent === ${JSON.stringify(glyph)})[${nth}]; if (!b) return "no ${glyph} button"; b.click(); return true; })()`;

const BUILDER_ACTIONS = [
  ["remove a Pokemon from the team", slotTool("\u00d7", 2)],
  ["add a Pokemon to the Box", slotTool("\u21e9", 1)],
  ["replace a Pokemon", withStore(`s.setSlot(3, makeSet({ species: "Rillaboom", item: "Assault Vest", ability: "Grassy Surge", nature: "Adamant", moves: ["Grassy Glide", "Wood Hammer", "U-turn", "Fake Out"], bonuses: [32, 32, 0, 0, 0, 2] }), window.__data); return true;`)],
  ["add a Pokemon to an empty slot", withStore(`const i = list.findIndex((x) => !x.species); s.setSlot(i < 0 ? 5 : i, makeSet({ species: "Amoonguss", item: "Sitrus Berry", ability: "Regenerator", nature: "Calm", moves: ["Spore", "Rage Powder", "Pollen Puff", "Protect"], bonuses: [32, 0, 2, 0, 32, 0] }), window.__data); return true;`)],
  ["change a set's item", withStore(`s.setSlot(1, { ...list[1], item: "Life Orb" }, window.__data); return true;`)],
  ["change a set's ability", withStore(`s.setSlot(1, { ...list[1], ability: "Overgrow" }, window.__data); return true;`)],
  ["change a set's move", withStore(`const moves = [...list[1].moves]; moves[0] = "Giga Drain"; s.setSlot(1, { ...list[1], moves }, window.__data); return true;`)],
  ["change a set's nature", withStore(`s.setSlot(1, { ...list[1], nature: "Timid" }, window.__data); return true;`)],
  ["change a set's stat points", withStore(`s.setSlot(1, { ...list[1], bonuses: [32, 0, 0, 32, 0, 2] }, window.__data); return true;`)],
  // A dialog takes the page scrollbar away with it (body.bd-modal-open), which is the
  // one thing here that would move the columns sideways rather than up. It changes
  // nothing on the page behind it, so nothing behind it may move: "still".
  ["open the Edit Pokemon dialog", `(async () => { const card = document.querySelector(".bd-team-col .bd-slot"); if (!card) return "no slot"; card.click(); await new Promise((r) => setTimeout(r, 500)); return document.querySelector("dialog.bd-dialog") ? true : "the dialog did not open"; })()`, "still"],
  ["close the Edit Pokemon dialog", `(async () => { const b = document.querySelector("dialog.bd-dialog .bd-dialog-head button"); if (!b) return "no close button"; b.click(); await new Promise((r) => setTimeout(r, 500)); return true; })()`, "still"],
  ["switch to the Box tab", tab("Box")],
  ["add a Pokemon to the Box while the Box is showing", slotTool("\u21e9", 0)],
  ["remove a Pokemon from the Box", `(() => { const b = [...document.querySelectorAll(".bd-box-grid .bd-mini-button")].filter((x) => x.textContent === "\\u00d7")[0]; if (!b) return "no Box remove button"; b.click(); return true; })()`],
  ["switch to Team Evaluation", tab("Team Evaluation")],
  ["switch back to Team Overview", tab("Team Overview")],
  // The Overview's own sub-tabs redraw the middle column on their own rather than
  // through renderAll, which is the second place builder-page.js holds the position.
  ["switch the Overview to Defense", subtab("Defense")],
  ["switch the Overview to Speed", subtab("Speed")],
  ["switch the Overview back to Offense", subtab("Offense")],
];

const CALC_ACTIONS = [
  ["pick one of our moves", `(() => { const b = document.querySelectorAll(".bd-side-left .bd-result-move")[1]; if (!b) return "no move"; b.click(); return true; })()`],
  ["pick an opposing move", `(() => { const b = document.querySelectorAll(".bd-side-right .bd-result-move")[0]; if (!b) return "no move"; b.click(); return true; })()`],
  ["turn on Crit", `(() => { const b = document.querySelectorAll(".bd-side-left .bd-crit")[1]; if (!b) return "no Crit button"; b.click(); return true; })()`],
  ["flip a field toggle", `(() => { const b = [...document.querySelectorAll(".bd-side-toggles .bd-toggle")].find((x) => /Protect/.test(x.textContent)); if (!b) return "no Protect toggle"; b.click(); return true; })()`],
  ["change the weather", `(() => { const b = [...document.querySelectorAll(".bd-field-settings .bd-segment button")].find((x) => x.textContent.trim() === "Rain"); if (!b) return "no weather button"; b.click(); return true; })()`],
  ["change a stat stage", `(() => { const s = document.querySelectorAll(".bd-side-left .bd-col-stage select")[0]; if (!s) return "no stage select"; s.value = "2"; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`],
  ["change the nature", `(() => { const s = document.querySelectorAll(".bd-side-left .bd-mon-details select")[0]; if (!s) return "no nature select"; s.value = [...s.options].map((o) => o.value).find((v) => v !== s.value); s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`],
  ["change stat points", `(() => { const i = document.querySelectorAll(".bd-side-left .bd-sp-cell input")[1]; if (!i) return "no stat point box"; i.value = "20"; i.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`],
  ["open the Pokemon picker", `(async () => { const b = document.querySelector(".bd-side-left .bd-mon-name"); if (!b) return "no name button"; b.click(); await new Promise((r) => setTimeout(r, 600)); return document.querySelector("dialog.bd-dialog") ? true : "the picker did not open"; })()`, "still"],
  ["pick our Pokemon", `(async () => {
     const row = document.querySelectorAll(".bd-pick-row")[6]; if (!row) return "no rows";
     row.click();
     await new Promise((r) => setTimeout(r, 600));
     return true; })()`],
  ["pick the opposing Pokemon", `(async () => {
     const b = document.querySelector(".bd-side-right .bd-mon-name"); if (!b) return "no name button";
     b.click();
     await new Promise((r) => setTimeout(r, 600));
     const row = document.querySelectorAll(".bd-pick-row")[9]; if (!row) return "no rows";
     row.click();
     await new Promise((r) => setTimeout(r, 600));
     return true; })()`],
  ["switch the format", `(async () => { const b = [...document.querySelectorAll(".bd-field-settings .bd-segment button")].find((x) => x.textContent.trim() === "Singles"); if (!b) return "no format button"; b.click(); await new Promise((r) => setTimeout(r, 1000)); return true; })()`],
];

// ------------------------------------------------------------------------- the runs

try {
  await send("Page.enable");
  await send("Runtime.enable");

  for (const width of WIDTHS) {
    await viewport(width);
    await sleep(150);

    // --- Team Builder
    await open("/team-builder/");
    await evaluate(`(async () => { const { BuilderData } = await import("/builder/common.js"); window.__data = await BuilderData.load(); await window.__data.loadMeta("Doubles"); return true; })()`);
    for (const fraction of [0.35, 0.7]) {
      await evaluate(`(async () => {
        const s = await import("/builder/store.js");
        const { makeSet } = await import("/builder/common.js");
        s.setTeamSets(${JSON.stringify(TEAM)}.map(makeSet), window.__data, { title: "Anchor Team" });
        const state = s.getState();
        const box = state.boxes.find((b) => b.id === state.currentBoxId) || state.boxes[0];
        while (box.box.length) s.removeFromBox(box.box.length - 1);
        const overview = [...document.querySelectorAll(".bd-toolbar .bd-tab")].find((x) => x.textContent.trim() === "Team Overview");
        if (overview) overview.click();
        return true;
      })()`);
      await sleep(500);
      for (const [label, action, still] of BUILDER_ACTIONS) await measure(label, `builder ${width}px @${fraction}`, fraction, action, still === "still");
      // Leave no dialog standing for the next pass.
      await evaluate(`(() => { document.querySelectorAll("dialog.bd-dialog").forEach((d) => d.close()); return true; })()`);
    }

    // At the very top there is nothing above the screen to hold still, so the page
    // must be left exactly where it is.
    await evaluate(`window.__jump(0)`);
    await sleep(200);
    await evaluate(BUILDER_ACTIONS[0][1]);
    await sleep(300);
    checked += 1;
    const topScroll = await evaluate(`scrollY`);
    if (topScroll !== 0) failures.push(`builder ${width}px: an action at the top of the page scrolled to ${topScroll}`);

    // A redraw that changes nothing must move nothing: clicking the tab you are already
    // on redraws the whole page, and six of them in a row must not creep down the page.
    await evaluate(`window.__jump(700)`);
    await sleep(250);
    const settled = await evaluate(`scrollY`);
    for (let i = 0; i < 6; i += 1) { await evaluate(tab("Team Overview")); await sleep(120); }
    checked += 1;
    const crept = await evaluate(`scrollY`);
    if (Math.abs(crept - settled) > TOLERANCE) failures.push(`builder ${width}px: six redraws that changed nothing moved the page from ${settled} to ${crept}`);

    // And it must not fight the player: scrolling by hand and then redrawing has to
    // leave the page where the player put it, not drag it back.
    await evaluate(`window.__jump(${settled + 220})`);
    await sleep(250);
    const byHand = await evaluate(`scrollY`);
    await evaluate(tab("Team Overview"));
    await sleep(300);
    checked += 1;
    const afterRedraw = await evaluate(`scrollY`);
    if (Math.abs(afterRedraw - byHand) > TOLERANCE) failures.push(`builder ${width}px: a redraw pulled the page back from ${byHand} to ${afterRedraw} after the player scrolled there`);

    // --- Damage Calculator
    await open("/damage-calculator/?attacker=Garchomp&defender=Incineroar&format=Doubles");
    checked += 1;
    const firstDraw = await evaluate(`scrollY`);
    if (firstDraw !== 0) failures.push(`calculator ${width}px: the first draw scrolled the page to ${firstDraw}`);
    for (const fraction of [0.35, 0.7]) {
      await open("/damage-calculator/?attacker=Garchomp&defender=Incineroar&format=Doubles");
      for (const [label, action, still] of CALC_ACTIONS) await measure(label, `calculator ${width}px @${fraction}`, fraction, action, still === "still");
    }
    await evaluate(`window.__jump(0)`);
    await sleep(200);
    await evaluate(CALC_ACTIONS[0][1]);
    await sleep(300);
    checked += 1;
    const calcTop = await evaluate(`scrollY`);
    if (calcTop !== 0) failures.push(`calculator ${width}px: an action at the top of the page scrolled to ${calcTop}`);
  }

  // Landmarks that are genuinely removed by their own action cannot be looked for
  // again, and the median still covers those - but if they keep going missing the
  // landmark half of this test has stopped saying anything and should not pass quietly.
  if (landmarksMissed > checked / 4) {
    failures.push(`${landmarksMissed} of ${checked} actions left no landmark at all to find again: the landmark check is no longer measuring anything`);
  }
  // Likewise for a screen that was swapped out wholesale: a handful is the phone
  // layout's Overview sub-tabs, a lot would mean this test had stopped asking anything.
  if (unmeasurable > checked / 8) {
    failures.push(`${unmeasurable} of ${checked} actions replaced everything on screen: there was nothing left to measure`);
  }
  if (pageErrors.length) failures.push(`the page logged errors: ${pageErrors.slice(0, 3).join(" | ")}`);
} catch (error) {
  failures.push(`the harness itself failed: ${error.message}`);
}

const asides = [
  landmarksMissed ? `${landmarksMissed} removed every landmark on screen, and the median covered those` : "",
  unmeasurable ? `${unmeasurable} replaced everything on screen, so there was nothing to compare` : "",
].filter(Boolean);
console.log(`\nrun-scroll-anchor.mjs: ${checked} checks, ${failures.length} failed`
  + (asides.length ? ` (of the actions, ${asides.join("; ")})` : ""));
for (const failure of failures) console.log(`  - ${failure}`);
await shutdown(failures.length ? 1 : 0);
