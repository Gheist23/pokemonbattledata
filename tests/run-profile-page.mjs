// Checks the static pages this site generates and the profile behaviour that
// app.js adds on top of them - not the battle numbers, which the vector suites
// under tests/ already cover.
//
//   node tests/run-profile-page.mjs
//
// It covers:
//   * the top button row on the API pages: /api_guide and its old /api.html
//     URL no longer offer an "API" button back to the page you are standing
//     on, /api-rules/ still does, and styles.css carries the rule that keeps
//     the remaining buttons on one row (with a width estimate, so adding a
//     tenth button to that header fails here rather than in the browser);
//   * a Pokemon profile: the move, held item and Ability names are buttons
//     that open a description, and the move's description leads with type,
//     category, power, accuracy and PP;
//   * that description opens as a card centred on the screen inside a
//     screen-sized `.info-scrim`, closes on a click outside it and on Escape,
//     and reads its category as plain text - the old version was anchored to
//     the name with pixel offsets and could give the profile a second
//     scrollbar, so the checks below also pin the CSS that makes that
//     impossible and that app.js writes no offsets of its own;
//   * the Team Builder call to action on a profile: "Build a Team with X",
//     one button, and a link to /team-builder/?build=X - the parameter that
//     starts a NEW team with that Pokemon in slot 1 (?add= still adds to the
//     team that is open);
//   * accuracy is shown as 100 wherever the battle data stores the "never
//     misses" spelling of 101 - on the generated /moves/ pages, in the
//     profile's learnable-move table and in the move popover;
//   * the Total a profile prints is the sum of the six stats printed above it,
//     in the metadata CSVs, in the generated API payloads and on the page - it
//     ran exactly 55 low everywhere until the scraper stopped offsetting the
//     total by a constant of its own (see the note further down).
//
// The profile needs a DOM, so this file carries a small one (enough for
// app.js's renders, simple selectors and click events). No browser and no
// network: fetch reads the site's own files.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
let checks = 0;
function check(label, condition, detail = "") {
  checks += 1;
  if (!condition) failures.push(`${label}${detail ? ` - ${detail}` : ""}`);
}

/* ------------------------------------------------------------ the pages */

const read = (...parts) => readFileSync(join(site, ...parts), "utf8");
const navOf = (html) => html.match(/<div class="nav-actions">([\s\S]*?)<\/div>/)?.[1] || "";
const navLabels = (nav) => [...nav.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)]
  .map((match) => match[1].replace(/<[^>]*>/g, "").trim())
  .filter(Boolean);

const guideNav = navOf(read("api_guide.html"));
const apiHtmlNav = navOf(read("api.html"));
const rulesNav = navOf(read("api-rules", "index.html"));

check("api_guide.html has one nav-actions row", guideNav.length > 0);
check("api_guide.html offers no API button", !/href="\/api_guide"/.test(guideNav), guideNav.match(/href="\/api_guide"[^>]*>[^<]*/)?.[0] || "");
check("api.html offers no API button", !/href="\/api_guide"/.test(apiHtmlNav));
check("/api-rules/ still links to the API guide", /href="\/api_guide"/.test(rulesNav));
check("api_guide.html keeps its other buttons",
  ["Team Builder", "Damage Calc", "Meta", "Explorer", "Download Battle Data", "API Rules", "Companion", "Pro", "Discord"]
    .every((label) => navLabels(guideNav).includes(label)),
  navLabels(guideNav).join(" | "));

const css = read("styles.css");
// The breakpoint itself is a measurement, not a contract: with the API button
// gone the row fits from 940px, where it needed 1025px before. What the test
// pins is that SOME desktop breakpoint holds the row on one line and lets the
// brand truncate instead of a button dropping.
const oneRow = css.match(/@media \(min-width: (?:9[0-9]{2}|1[0-9]{3})px\) \{[\s\S]*?\n\}/);
check("styles.css keeps the API header on one row", !!oneRow && /\.page-api \.site-header \.nav-actions \{[^}]*flex-wrap: nowrap/.test(oneRow[0]));
check("the brand is what gives way, not a button", !!oneRow && /text-overflow: ellipsis/.test(oneRow[0]));
check("the compact header sizing starts above the phone header",
  /@media \(min-width: 761px\) \{[\s\S]*?\.page-api \.site-header \.ghost-button/.test(css));

// A rough width for that row, so a button added later fails here first.
// Monospace at the widest of the header's fonts (Cascadia Code, 0.6em per
// character) at the sizes the v50 block sets, plus the shell's own gap; the
// header itself is capped at 1180px by the .page-api rule so it lines up with
// the page content.
const NAV_FONT_PX = 0.76 * 16;
const NAV_CHAR_PX = NAV_FONT_PX * 0.6;
const NAV_PAD_PX = 0.52 * 16 * 2 + 2;
const NAV_GAP_PX = 0.34 * 16;
const BRAND_PX = 34 + 0.5 * 16 + "Pokemon Champions Battle Data".length * 0.84 * 16 * 0.6;
const labels = navLabels(guideNav);
const navWidth = labels.reduce((total, label) => total + label.length * NAV_CHAR_PX + NAV_PAD_PX, 0)
  + Math.max(0, labels.length - 1) * NAV_GAP_PX
  + 15 // the Pro flame icon
  + 7; // the Discord button's own gap
const rowWidth = Math.round(BRAND_PX + navWidth + 0.85 * 16);
check("the API header row fits 1180px", rowWidth <= 1180, `estimated ${rowWidth}px for ${labels.length} button(s)`);

/* ------------------------------------------------- accuracy on the pages */

const accuracyOf = (html) => html.match(/Accuracy<\/td><td data-label="Value">([^<]*)/)?.[1] || "";
check("a never-miss move page reads 100", accuracyOf(read("moves", "aurora-veil", "index.html")) === "100", accuracyOf(read("moves", "aurora-veil", "index.html")));
check("a real accuracy is untouched", accuracyOf(read("moves", "thunder", "index.html")) === "70", accuracyOf(read("moves", "thunder", "index.html")));

const movePages = readdirSync(join(site, "moves")).filter((name) => existsSync(join(site, "moves", name, "index.html")));
const with101 = movePages.filter((name) => accuracyOf(read("moves", name, "index.html")) === "101");
check("no move page prints accuracy 101", with101.length === 0, with101.slice(0, 5).join(", "));

// The data itself keeps its own spelling: this only fixes what is shown.
const learnableCsv = read("pokemon_champions_assets", "learnable_moves", "Abomasnow.csv");
check("the CSVs still store 101", /,101,/.test(learnableCsv));

/* ------------------------------------------- the Total a page prints */

// A profile prints six stats and a Total, and the Total is their sum. It was not:
// scrape_data_pokemonzone.py converts pokemonzone's base stats to the level-50
// numbers Champions shows by adding a flat offset per stat (HP +75, the other five
// +20), but the offset it added to "total" was hard-coded to 120 - 20 x 6, missing
// that HP's own offset is 75 - so every written total came out exactly 55 low
// (Garchomp printed 720 next to stats summing to 775). The six Rotom formes were
// the only rows with a correct total, which left them 55 points too high on
// /rankings/highest-base-stats/. The generator now derives the total by summing the
// six stats it writes; these checks keep the CSVs, the generated JSON and the
// generated pages agreeing with each other.
const SIX_STATS = ["hp", "atk", "def", "spa", "spd", "spe"];
const metadataDir = join(site, "pokemon_champions_assets", "metadata");
const metadataFiles = readdirSync(metadataDir).filter((name) => name.endsWith(".csv"));
check("the metadata CSVs are there to check", metadataFiles.length > 200, `${metadataFiles.length} file(s)`);

const totalMismatches = [];
let metadataRows = 0;
for (const name of metadataFiles) {
  const lines = read("pokemon_champions_assets", "metadata", name).split(/\r?\n/).filter((line) => line.trim());
  const columns = lines[0].split(",");
  const at = Object.fromEntries(SIX_STATS.map((stat) => [stat, columns.indexOf(stat)]));
  const totalAt = columns.indexOf("total");
  if (totalAt < 0 || SIX_STATS.some((stat) => at[stat] < 0)) {
    totalMismatches.push(`${name}: missing a stat column`);
    continue;
  }
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const sum = SIX_STATS.reduce((running, stat) => running + Number(cells[at[stat]]), 0);
    metadataRows += 1;
    if (Number(cells[totalAt]) !== sum) totalMismatches.push(`${name} row "${cells[0]}": total ${cells[totalAt]} vs sum ${sum}`);
  }
}
check("every metadata CSV row's total is the sum of its six stats", !totalMismatches.length,
  `${totalMismatches.length} bad row(s): ${totalMismatches.slice(0, 4).join("; ")}`);
check("the check actually read the rows", metadataRows > 300, `${metadataRows} row(s)`);

// The same number after generate-manifest.mjs has carried it into the API payloads.
// Walk the whole payload rather than one known shape: the total is repeated under
// summary.primary, summary.forms[] and summary.baseStatTotal, and a check that knows
// only about forms[] would miss a generator that got one of the others wrong.
const API_STATS = ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"];
const apiBad = [];
let apiChecked = 0;
const walkStats = (node, where) => {
  if (Array.isArray(node)) return node.forEach((item, i) => walkStats(item, `${where}[${i}]`));
  if (!node || typeof node !== "object") return;
  for (const totalKey of ["base_stat_total", "baseStatTotal"]) {
    if (!(totalKey in node)) continue;
    const values = API_STATS.map((stat) => Number(node[stat]));
    if (!values.every(Number.isFinite)) continue;
    apiChecked += 1;
    const sum = values.reduce((running, value) => running + value, 0);
    if (Number(node[totalKey]) !== sum) apiBad.push(`${where}.${totalKey}: ${node[totalKey]} vs ${sum}`);
  }
  for (const [key, value] of Object.entries(node)) walkStats(value, `${where}.${key}`);
};
walkStats(JSON.parse(read("data", "api", "index.json")), "index");
for (const slug of ["garchomp", "abomasnow", "rotom-wash"]) walkStats(JSON.parse(read("data", "api", "pokemon", `${slug}.json`)), slug);
check("every API base_stat_total is the sum of its six stats", !apiBad.length,
  `${apiBad.length} bad record(s): ${apiBad.slice(0, 4).join("; ")}`);
check("the API check actually read the records", apiChecked > 500, `${apiChecked} record(s)`);

// And the number a generated profile page actually prints.
const valueOf = (html, label) => Number(html.match(new RegExp(`${label}</td><td data-label="Value">(\\d+)`))?.[1]);
for (const slug of ["garchomp", "abomasnow", "rotom-wash"]) {
  const html = read("pokemon", slug, "index.html");
  const printed = ["HP", "Attack", "Defense", "Sp. Attack", "Sp. Defense", "Speed"].map((label) => valueOf(html, label));
  const printedTotal = valueOf(html, "Total");
  const sum = printed.reduce((running, value) => running + value, 0);
  check(`/pokemon/${slug}/ prints a Total that is the sum of its six stats`,
    printed.every(Number.isFinite) && printedTotal === sum, `${printed.join("+")} = ${sum}, page says ${printedTotal}`);
}

/* --------------------------------------------------- the description file */

const descriptions = JSON.parse(read("data", "descriptions.json"));
check("data/descriptions.json carries held items", Object.keys(descriptions.items || {}).length > 150);
check("data/descriptions.json carries Abilities", Object.keys(descriptions.abilities || {}).length > 150);
check("a known item has effect text", /1\/16/.test(descriptions.items?.Leftovers || ""), descriptions.items?.Leftovers || "missing");
check("a known Ability has effect text", /Attack/.test(descriptions.abilities?.Intimidate || ""), descriptions.abilities?.Intimidate || "missing");

/* ------------------------------ the description card, in the CSS and the JS */

const appSource = read("app.js");

// The card sits in a layer that is exactly the size of the screen. That is
// what stops it adding height to the profile: the old version was placed with
// pixel offsets inside the profile dialog, and opening it on a row far down a
// long profile put a second scrollbar on the profile.
const scrimRule = css.match(/\n\.info-scrim \{([^}]*)\}/)?.[1] || "";
check("styles.css carries a screen-sized layer for the card", !!scrimRule);
check("the layer is fixed to the screen", /position:\s*fixed/.test(scrimRule), scrimRule.trim());
check("the layer is exactly the size of the screen", /inset:\s*0/.test(scrimRule), scrimRule.trim());
check("the card is centred in it", /place-items:\s*center/.test(scrimRule), scrimRule.trim());

check("app.js writes no offsets onto the card", !/popover\.style\.(left|top)/.test(appSource));
check("app.js has nothing left to reposition", !/positionMoveInfoPopover/.test(appSource));

// "increase the width": it used to be min(320px, ...). The last rule wins.
const cardWidths = [...css.matchAll(/\.move-info-popover \{[^}]*?width:\s*min\((\d+)px/g)].map((match) => Number(match[1]));
check("the card is wider than the old popover", cardWidths.length > 0 && cardWidths.at(-1) >= 480, cardWidths.join(", "));

/* ------------------------------------------- the Team Builder call to action */

const companionSource = appSource.match(/function companionPrompt\([\s\S]*?\n  \}/)?.[0] || "";
check("the profile still offers the Team Builder", !!companionSource);
check("the profile button starts a new team", /team-builder\/\?build=/.test(companionSource), companionSource);
check("the profile offers no damage-calculator button", !/damage-calculator/.test(companionSource), companionSource);

const staticCta = read("pokemon", "abomasnow", "index.html").match(/<aside class="companion-cta"[\s\S]*?<\/aside>/)?.[0] || "";
check("the generated page carries the same block", !!staticCta);
check("the generated heading builds a team", /<h2>Build a Team with Abomasnow<\/h2>/.test(staticCta), staticCta.slice(0, 260));
check("the generated button says Build Team with it", />Build Team with it</.test(staticCta), staticCta);
check("the generated button links to ?build=", /href="\/team-builder\/\?build=Abomasnow"/.test(staticCta), staticCta);
check("the generated block offers no damage calculator", !/Calculate damage/.test(staticCta), staticCta);
check("the generated block has one button only", (staticCta.match(/<a /g) || []).length === 1, staticCta);

// ?build= is the Team Builder's half of that button: a brand new team with
// that Pokemon in slot 1. ?add= keeps dropping it into the team already open.
const paramHandler = read("builder", "builder-page.js").match(/async function handleAddParam\(\)[\s\S]*?\n\}/)?.[0] || "";
check("the Team Builder reads ?build=", /params\.get\("build"\)/.test(paramHandler), paramHandler.slice(0, 200));
check("?build= starts a new team with that Pokemon first", /newTeam\(\[set\]/.test(paramHandler), paramHandler);
check("?add= still adds to the team that is open", /addToTeamFlow\(set\)/.test(paramHandler), paramHandler);

/* -------------------------------------------------------------- the DOM */

const camelToKebab = (s) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

class NodeBase {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get isConnected() {
    let n = this;
    while (n) {
      if (n === globalThis.document) return true;
      n = n.parentNode;
    }
    return false;
  }
  appendChild(child) {
    if (child.nodeType === 11) {
      for (const c of [...child.childNodes]) this.appendChild(c);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  append(...children) {
    for (const c of children) this.appendChild(c instanceof NodeBase ? c : new Text(String(c)));
  }
  prepend(...children) {
    const nodes = children.map((c) => (c instanceof NodeBase ? c : new Text(String(c))));
    for (const n of nodes) if (n.parentNode) n.parentNode.removeChild(n);
    nodes.forEach((n) => { n.parentNode = this; });
    this.childNodes.unshift(...nodes);
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const i = parent.childNodes.indexOf(this);
    const list = nodes.map((c) => (c instanceof NodeBase ? c : new Text(String(c))));
    for (const n of list) if (n.parentNode) n.parentNode.removeChild(n);
    parent.childNodes.splice(i, 1, ...list);
    list.forEach((n) => { n.parentNode = parent; });
    this.parentNode = null;
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) {
    this.childNodes.forEach((c) => { c.parentNode = null; });
    this.childNodes = [];
    if (v !== "" && v !== null && v !== undefined) this.appendChild(new Text(String(v)));
  }
}

class Text extends NodeBase {
  constructor(text) {
    super();
    this.nodeType = 3;
    this.data = text;
  }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class ClassList {
  constructor(el) { this.el = el; }
  get list() { return (this.el.getAttribute("class") || "").split(/\s+/).filter(Boolean); }
  add(...names) { this.el.setAttribute("class", [...new Set([...this.list, ...names])].join(" ")); }
  remove(...names) { this.el.setAttribute("class", this.list.filter((n) => !names.includes(n)).join(" ")); }
  toggle(name, force) {
    const has = this.contains(name);
    const want = force === undefined ? !has : Boolean(force);
    if (want) this.add(name); else this.remove(name);
    return want;
  }
  contains(name) { return this.list.includes(name); }
}

function parseSelector(sel) {
  // compound selectors separated by descendant spaces; supports tag, #id, .class, [attr], [attr=value], :not() not supported
  return sel.trim().split(/\s+/).map((part) => {
    const out = { tag: "", id: "", classes: [], attrs: [] };
    const re = /([a-zA-Z][a-zA-Z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="?([^"\]]*)"?)?\]/g;
    let m;
    while ((m = re.exec(part))) {
      if (m[1]) out.tag = m[1].toLowerCase();
      else if (m[2]) out.id = m[2];
      else if (m[3]) out.classes.push(m[3]);
      else if (m[4]) out.attrs.push([m[4], m[5]]);
    }
    return out;
  });
}

function matchesCompound(el, c) {
  if (!(el instanceof Element)) return false;
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.getAttribute("id") !== c.id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const [a, v] of c.attrs) {
    if (!el.hasAttribute(a)) return false;
    if (v !== undefined && el.getAttribute(a) !== v) return false;
  }
  return true;
}

function matches(el, sel) {
  return sel.split(",").some((one) => {
    const parts = parseSelector(one);
    if (!matchesCompound(el, parts.at(-1))) return false;
    let node = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      while (node && !matchesCompound(node, parts[i])) node = node.parentNode;
      if (!node) return false;
      node = node.parentNode;
    }
    return true;
  });
}

class Element extends NodeBase {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new ClassList(this);
    const el = this;
    this.style = new Proxy({ setProperty(k, v) { this[k] = v; } }, {});
    this.dataset = new Proxy({}, {
      set(_t, k, v) { el.setAttribute(`data-${camelToKebab(String(k))}`, v); return true; },
      get(_t, k) { return el.getAttribute(`data-${camelToKebab(String(k))}`) ?? undefined; },
    });
  }
  get className() { return this.getAttribute("class") || ""; }
  set className(v) { this.setAttribute("class", v); }
  get id() { return this.getAttribute("id") || ""; }
  set id(v) { this.setAttribute("id", v); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }
  get open() { return this.hasAttribute("open"); }
  set open(v) { if (v) this.setAttribute("open", ""); else this.removeAttribute("open"); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v) { if (v) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
  get checked() { return this.hasAttribute("checked"); }
  set checked(v) { if (v) this.setAttribute("checked", ""); else this.removeAttribute("checked"); }
  get value() { return this._value !== undefined ? this._value : this.getAttribute("value") ?? (this.tagName === "TEXTAREA" ? this.textContent : ""); }
  set value(v) { this._value = String(v); }
  get children() { return this.childNodes.filter((c) => c instanceof Element); }
  set innerHTML(v) { this.textContent = String(v).replace(/<[^>]*>/g, ""); }
  get innerHTML() { return this.textContent; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type, extra = {}) {
    let prevented = false;
    let node = this;
    const event = { type, target: this, currentTarget: this, preventDefault: () => { prevented = true; }, stopPropagation() {}, key: extra.key, ...extra };
    // bubble
    while (node) {
      event.currentTarget = node;
      for (const fn of [...(node.listeners?.get(type) || [])]) fn(event);
      node = node.parentNode;
      if (!extra.bubbles) break;
    }
    return !prevented;
  }
  click() { return this.dispatch("click", { bubbles: true }); }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c instanceof Element) {
          if (matches(c, sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    let n = this;
    while (n && n instanceof Element) {
      if (matches(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  focus() {}
  blur() {}
  select() {}
  scrollIntoView() {}
  showModal() { this.setAttribute("open", ""); }
  close() { this.removeAttribute("open"); this.dispatch("close"); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20, bottom: 20, right: 100 }; }
}

class Fragment extends NodeBase {
  constructor() { super(); this.nodeType = 11; }
}


function installDom(siteRoot) {
  const document = new Element("#document");
  document.nodeType = 9;
  document.body = new Element("body");
  document.documentElement = new Element("html");
  document.documentElement.appendChild(document.body);
  document.appendChild(document.documentElement);
  document.createElement = (tag) => new Element(tag);
  document.createTextNode = (text) => new Text(String(text));
  document.createDocumentFragment = () => new Fragment();
  document.getElementById = (id) => document.querySelector(`#${id}`);
  document.visibilityState = "visible";
  globalThis.document = document;
  globalThis.Node = NodeBase;
  globalThis.Element = Element;
  globalThis.HTMLElement = Element;
  const store = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      clear: () => map.clear(),
      key: (i) => [...map.keys()][i] ?? null,
      get length() { return map.size; }
    };
  };
  globalThis.localStorage = store();
  globalThis.sessionStorage = store();
  globalThis.window = globalThis;
  globalThis.innerWidth = 1440;
  globalThis.innerHeight = 900;
  globalThis.location = { search: "", pathname: "/", href: "http://127.0.0.1/", origin: "http://127.0.0.1" };
  globalThis.history = { replaceState() {}, pushState() {} };
  globalThis.addEventListener = () => {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
  globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
  globalThis.fetch = async (url) => {
    const path = String(url).split("?")[0];
    const file = join(siteRoot, path);
    if (!existsSync(file)) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const text = readFileSync(file, "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  };
  Object.defineProperty(Element.prototype, "parentElement", {
    get() { const parent = this.parentNode; return parent && parent.nodeType === 1 ? parent : null; }
  });
  return document;
}

/** The page the profile view is generated onto: /pokemon/<slug>/. */
async function openProfile(slug) {
  const document = installDom(site);
  globalThis.location.pathname = `/pokemon/${slug}/`;
  globalThis.location.href = `http://127.0.0.1/pokemon/${slug}/`;
  const add = (tag, id, className = "") => {
    const node = document.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    document.body.append(node);
    return node;
  };
  for (const id of ["datasetStatus", "pokemonCount", "battleEntryList", "resultCount", "rosterList", "pokemonGrid", "emptyState", "searchHelpPopover"]) add("div", id);
  add("input", "searchInput");
  add("input", "favoritesOnly");
  for (const id of ["typeFilter", "sortFilter", "orderFilter", "seasonSelect"]) add("select", id);
  for (const id of ["clearFiltersButton", "emptyClearButton", "formatToggleDoubles", "formatToggleSingles", "closeDialogButton", "profileFavoriteButton", "searchHelpButton", "searchHelpClose", "mobileFilterToggle"]) add("button", id);
  add("div", "", "controls");
  add("template", "pokemonCardTemplate").content = document.createDocumentFragment();
  const dialog = add("dialog", "detailDialog");
  const inner = document.createElement("div");
  inner.className = "dialog-inner";
  const content = document.createElement("div");
  content.id = "detailContent";
  inner.append(content);
  dialog.append(inner);

  await import(`file:///${join(site, "app.js").split("\\").join("/")}`);
  document.dispatch("DOMContentLoaded");
  for (let tries = 0; tries < 400 && !document.querySelector(".moves-table"); tries += 1) await sleep(25);
  return document;
}

const page = await openProfile("abomasnow");
check("the profile opened", !!page.querySelector(".moves-table"));

const popover = () => page.getElementById("moveInfoPopover");
const firstButton = (table) => page.querySelector(`.${table} .move-info-button`);
const open = (button) => { button.click(); return popover(); };

const moveButton = firstButton("moves-table");
check("a top move is a button", !!moveButton);
if (moveButton) {
  const facts = Object.fromEntries((moveButton.infoPayload?.facts || []).map(([label, value]) => [label, value.replace(/<[^>]*>/g, "")]));
  for (const label of ["Type", "Category", "Power", "Accuracy", "PP"]) {
    check(`the move popover gives its ${label.toLowerCase()}`, !!facts[label], JSON.stringify(facts));
  }
  check("the move popover carries the description", (moveButton.infoPayload?.description || "").length > 10);
  const shown = open(moveButton);
  check("clicking a move opens the popover", !!shown && shown.hidden === false);
  check("the popover shows the five facts",
    ["Type", "Category", "Power", "Accuracy", "PP"].every((label) => shown.textContent.includes(label)),
    shown?.textContent?.slice(0, 200));
  page.dispatch("keydown", { key: "Escape" });
  check("Escape closes the popover", popover().hidden === true);
}

// Abomasnow's third most used move is Protect, whose CSV accuracy is 101.
const moveButtons = page.querySelectorAll(".moves-table .move-info-button");
const protect = moveButtons.find((button) => button.infoPayload?.title === "Protect");
check("the 101 move is on the profile", !!protect, moveButtons.map((button) => button.infoPayload?.title).join(", "));
if (protect) {
  const accuracy = (protect.infoPayload.facts.find(([label]) => label === "Accuracy") || [])[1];
  check("a never-miss move reads 100 in the popover", accuracy === "100", `read ${accuracy}`);
}
check("no move popover reads 101",
  moveButtons.every((button) => (button.infoPayload?.facts || []).every(([, value]) => value !== "101")));

const itemButton = firstButton("held-item-table");
check("a held item is a button", !!itemButton);
if (itemButton) {
  const shown = open(itemButton);
  check("the item popover names the item", shown.textContent.includes(itemButton.infoPayload.title));
  check("the item popover says what it does",
    (itemButton.infoPayload.description || itemButton.infoPayload.note).length > 10,
    JSON.stringify(itemButton.infoPayload));
}

const abilityButton = firstButton("ability-table");
check("an Ability is a button", !!abilityButton);
if (abilityButton) {
  const shown = open(abilityButton);
  check("the Ability popover names the Ability", shown.textContent.includes(abilityButton.infoPayload.title));
  check("the Ability popover says what it does",
    (abilityButton.infoPayload.description || abilityButton.infoPayload.note).length > 10,
    JSON.stringify(abilityButton.infoPayload));
}

/* --------------------------- the card: where it hangs, and what closes it */

const scrim = page.getElementById("moveInfoScrim");
check("the card has its screen-sized layer", !!scrim);
check("the layer hangs off the dialog itself, not its scrolling inner",
  !!scrim && scrim.parentNode === page.getElementById("detailDialog"),
  scrim?.parentNode?.className || scrim?.parentNode?.tagName || "nothing");
check("the card lives inside that layer", popover()?.parentNode === scrim);

if (moveButton) {
  open(moveButton);
  check("the layer is shown with the card", scrim.hidden === false);
  const category = (moveButton.infoPayload.facts.find(([label]) => label === "Category") || [])[1];
  check("a move's category reads as plain text", !!category && !/[<>]/.test(category), String(category));

  page.getElementById("searchInput").click();
  check("a click outside closes the card", popover().hidden === true);
  check("the layer goes with it", scrim.hidden === true);

  open(moveButton);
  scrim.click();
  check("a click on the layer around the card closes it", popover().hidden === true);

  open(moveButton);
  page.dispatch("keydown", { key: "Escape" });
  check("Escape still closes the card", popover().hidden === true);
}

const cta = page.querySelector(".companion-cta");
check("the profile shows the Team Builder block", !!cta);
if (cta) {
  check("its heading builds a team", cta.textContent.includes("Build a Team with Abomasnow"), cta.textContent.slice(0, 200));
  check("its button says Build Team with it", cta.textContent.includes("Build Team with it"));
  check("it says the button starts a new team", /starts a brand new team/i.test(cta.textContent), cta.textContent.slice(0, 300));
  check("it offers no damage calculator", !cta.textContent.includes("Calculate damage"));
}

// Abomasnow's Aurora Veil is stored as accuracy 101 and must read 100 here.
// The small DOM above keeps only the text of a table written with innerHTML,
// so the row is read as text: name, type, category, power, accuracy, PP.
const learnable = page.querySelector(".learnable-moves-table");
check("the learnable-move table rendered", !!learnable);
if (learnable) {
  const rows = learnable.textContent;
  check("a never-miss move reads 100 in the profile", /Aurora Veil[\s\S]{0,60}?\b100\b/.test(rows),
    rows.slice(rows.indexOf("Aurora Veil"), rows.indexOf("Aurora Veil") + 80));
  check("no row in the profile reads 101", !/\b101\b/.test(rows));
}

console.log(`${checks - failures.length}/${checks} check(s) passed.`);
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
