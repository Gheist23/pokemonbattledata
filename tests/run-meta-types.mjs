// Checks the "Type changes" section on /meta/: the best attacking types against
// the ranked Top X, the best defending types against what that Top X carries, and
// how both moved over the page's own day window.
//
//   node tests/run-meta-types.mjs
//
// It covers:
//   * that the two lists agree with the Team Builder. meta.js cannot import
//     builder/team-overview.js (the page is a plain script and that module pulls
//     in the whole damage engine), so it carries a small copy of the two formulas.
//     This file runs the REAL ones - teamOverview() for the attacking chart and
//     TeamEvaluator.directionalPressure() for the defending pressure - over the
//     same day's battle data and fails if the page's numbers differ;
//   * the ordering (best first, and best means the higher multiplier on the left
//     and the lower pressure on the right), the lead sentence, and the Top-X and
//     day numbers in it;
//   * the change arithmetic: today's score minus the score on the earliest day in
//     the window, checked against an independently scored baseline day and, on a
//     hand-built meta, against numbers worked out by hand;
//   * the empty-history cases: a baseline day that ranks nobody, and one whose
//     Top X carries no damaging move, must show a dash and never a 0.
//
// The page needs a DOM, so this file carries a small one (the same shape as
// tests/run-profile-page.mjs). No browser and no network: fetch reads the site's
// own files, or, for the hand-built cases, a few snapshots made up here.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { teamOverview } from "../builder/team-overview.js";
import { pokemonRecord } from "../tools/builder-meta.mjs";

const site = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (...parts) => readFileSync(join(site, ...parts), "utf8");

const failures = [];
let checks = 0;
function check(label, condition, detail = "") {
  checks += 1;
  if (!condition) failures.push(`${label}${detail ? ` - ${detail}` : ""}`);
}

const TYPES = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy"];

/* ------------------------------------------------------- the page's markup */

const pageHtml = read("meta", "index.html");
const pageCss = read("meta.css");
const pageJs = read("meta.js");

check("the page has a Type changes section", /<h2 id="typeHeading">Type changes<\/h2>/.test(pageHtml));
check("the section sits with the other two", pageHtml.indexOf('id="typeHeading"') > pageHtml.indexOf('id="usageHeading"')
  && pageHtml.indexOf('id="typeHeading"') < pageHtml.indexOf('id="metaStatus"'), "it must be inside #metaResults, after the usage section");
for (const id of ["metaTypePill", "metaTypeNote", "typeOffenseLead", "typeDefenseLead", "typeOffense", "typeDefense"]) {
  check(`the page declares #${id}`, pageHtml.includes(`id="${id}"`));
}
check("both lists are labelled", /aria-labelledby="typeOffenseHeading"/.test(pageHtml) && /aria-labelledby="typeDefenseHeading"/.test(pageHtml));
check("meta.css styles the type rows", /\.meta-type-row \{/.test(pageCss));
check("a type row is not clickable", /\.meta-type-row \{\s*cursor: default;/.test(pageCss));
check("the delta chip has room for the arrow at phone width", /\.meta-type-list \.meta-delta \{[^}]*min-width/.test(pageCss));
check("the section keeps the page's own two-column layout", /class="meta-duo"/.test(pageHtml.slice(pageHtml.indexOf('id="typeHeading"'))));
// 390px: .meta-duo collapses to one column at 900px and the row shrinks at 620px.
check("meta.css stacks the two panels on a phone", /@media \(max-width: 900px\) \{\s*\.meta-duo \{ grid-template-columns: 1fr; \}/.test(pageCss));
check("meta.js does not import the builder modules", !/\bimport\b[^\n]*builder\//.test(pageJs), "the page is a plain script");

/* ---------------------------------------------------------------- tiny DOM */

const camelToKebab = (s) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

class NodeBase {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
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
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
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
    const want = force === undefined ? !this.contains(name) : Boolean(force);
    if (want) this.add(name); else this.remove(name);
    return want;
  }
  contains(name) { return this.list.includes(name); }
}

function parseSelector(sel) {
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
  get value() { return this._value !== undefined ? this._value : this.getAttribute("value") ?? ""; }
  set value(v) { this._value = String(v); }
  get children() { return this.childNodes.filter((c) => c instanceof Element); }
  // Enough for the page's rows: the text survives, the tags do not.
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
    const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra };
    let node = this;
    while (node) {
      event.currentTarget = node;
      for (const fn of [...(node.listeners?.get(type) || [])]) fn(event);
      node = node.parentNode;
      if (!extra.bubbles) break;
    }
    return true;
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
  focus() {}
  showModal() { this.setAttribute("open", ""); }
  close() { this.removeAttribute("open"); this.dispatch("close"); }
}

class Fragment extends NodeBase {
  constructor() { super(); this.nodeType = 11; }
}

/** fetch over the site's own files, with a few paths answered from memory. */
function diskFetch(overrides = {}) {
  return async (url) => {
    const path = decodeURI(String(url).split("?")[0]).replace(/^\/+/, "");
    if (Object.prototype.hasOwnProperty.call(overrides, path)) {
      const body = overrides[path];
      if (body === null) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    }
    const file = join(site, path);
    if (!existsSync(file)) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const text = readFileSync(file, "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  };
}

function installDom(fetchImpl, search = "") {
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
  globalThis.document = document;
  globalThis.Node = NodeBase;
  globalThis.Element = Element;
  globalThis.HTMLElement = Element;
  globalThis.window = globalThis;
  globalThis.location = { search, pathname: "/meta/", href: `http://127.0.0.1/meta/${search}`, origin: "http://127.0.0.1" };
  globalThis.history = { replaceState() {}, pushState() {} };
  globalThis.addEventListener = () => {};
  globalThis.fetch = fetchImpl;
  return document;
}

/** The parts of /meta/index.html meta.js reaches for. */
function buildMetaPage(document) {
  const add = (tag, id, className = "") => {
    const node = document.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    document.body.append(node);
    return node;
  };
  for (const id of ["metaWindow", "metaPokemonCount", "metaFormatLabel", "metaResults", "metaStatus", "metaRankPill",
    "rankWinners", "rankLosers", "usageRising", "usageFalling",
    "metaTypePill", "metaTypeNote", "typeOffenseLead", "typeDefenseLead", "typeOffense", "typeDefense"]) add("div", id);
  for (const id of ["metaRange", "metaScope"]) add("select", id);
  for (const id of ["rankMoreButton", "usageMoreButton", "formatToggleDoubles", "formatToggleSingles", "metaDialogClose"]) add("button", id);
  for (const category of ["move", "held_item", "ability"]) {
    const tab = add("button", "", "meta-tab");
    tab.dataset.category = category;
  }
  const dialog = add("dialog", "metaDialog");
  const inner = document.createElement("div");
  inner.className = "dialog-inner";
  const content = document.createElement("div");
  content.id = "metaDialogContent";
  inner.append(content);
  dialog.append(inner);
  return document;
}

// The page's script, run the way a <script> tag runs it. It has to be evaluated
// rather than imported: with no package.json type, Node loads meta.js through the
// CommonJS loader, whose cache is keyed by file name alone, so a second import -
// query string or not - would hand back the first run's page instead of the new one.
const runMetaScript = new Function(pageJs);

/** Loads /meta/ with meta.js and waits for the type lists to be drawn. */
async function openMetaPage(fetchImpl, { search = "" } = {}) {
  const document = installDom(fetchImpl, search);
  buildMetaPage(document);
  runMetaScript();
  document.dispatch("DOMContentLoaded");
  for (let tries = 0; tries < 400; tries += 1) {
    if (document.querySelectorAll("#typeOffense .meta-type-row").length || document.getElementById("metaTypeNote").textContent) break;
    await sleep(25);
  }
  return document;
}

/** One list as the page drew it: "1Ice1.08× average multiplier" -> {type, value}. */
function readList(document, id) {
  return document.querySelectorAll(`#${id} .meta-type-row`).map((row) => {
    const body = row.querySelector(".meta-row-body")?.textContent || "";
    const chip = row.querySelector(".meta-delta");
    const parsed = /^(\d+)([A-Za-z]+?)([\d.]+)(×|%)/.exec(body) || [];
    return {
      rank: Number(parsed[1]),
      type: parsed[2] || "",
      shown: parsed[3] || "",
      value: Number(parsed[3]),
      unit: parsed[4] || "",
      delta: (chip?.textContent || "").trim(),
      title: chip?.title || "",
      tone: (chip?.className || "").replace("meta-delta", "").trim(),
    };
  });
}

/* ------------------------------------ the same numbers, from the real modules */

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = [];
    let cell = "";
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) { cells.push(cell); cell = ""; }
      else cell += ch;
    }
    cells.push(cell);
    return Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? "").trim()]));
  });
}

const appData = JSON.parse(read("data", "builder", "app-data.json"));
const engine = new DamageEngine(appData);

/** The Team Builder's own answer for one day: teamOverview() with no team, which
 *  is the attacking chart, and its meta profile put through directionalPressure()
 *  against one Pokemon of each single type, which is the defending pressure. */
function builderScores(season, date, format, topX) {
  const dir = join(site, "pokemon_champions_assets", "battle_data", season, date, format);
  if (!existsSync(dir)) return null;
  const records = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".csv")).sort()
    .map((name) => pokemonRecord(name.replace(/\.csv$/i, ""), parseCsv(readFileSync(join(dir, name), "utf8")), appData.usageAliases || {}));
  const ev = new TeamEvaluator(null, engine, format, {});
  ev.setMetaRecords(records);
  const overview = teamOverview(new TeamEvaluation(ev), [], topX);
  const defense = Object.fromEntries(TYPES.map((type) => {
    const target = { defensive_type_chart: Object.fromEntries(TYPES.map((attack) => [attack, engine.typeMultiplier(attack, [type])])) };
    return [type, ev.directionalPressure(overview.meta, target, false).score];
  }));
  return { offense: overview.offense_chart, defense, count: overview.meta.count };
}

/* -------------------------------------------------------------- the real run */

const metaIndex = JSON.parse(read("data", "meta", "index.json"));
const season = metaIndex.seasons[0];
const latestDate = season.dates[0];
// pickBaselineDate with the page's default 7-day window: the oldest day still
// inside it, or the nearest earlier day when none is.
const baselineDate = (() => {
  const stamp = (value) => {
    const m = /^(\d{2})_(\d{2})_(\d{4})$/.exec(value);
    return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  };
  const older = season.dates.filter((date) => stamp(date) < stamp(latestDate));
  const inWindow = older.filter((date) => stamp(date) >= stamp(latestDate) - 7 * 86400000);
  return inWindow.length ? inWindow.at(-1) : older[0];
})();

const page = await openMetaPage(diskFetch());
const offense = readList(page, "typeOffense");
const defense = readList(page, "typeDefense");
const offenseLead = page.getElementById("typeOffenseLead").textContent;
const defenseLead = page.getElementById("typeDefenseLead").textContent;
const note = page.getElementById("metaTypeNote").textContent;

check("the attacking list has all 18 types", offense.length === 18, `${offense.length} row(s)`);
check("the defending list has all 18 types", defense.length === 18, `${defense.length} row(s)`);
check("the attacking list is a multiplier", offense.every((row) => row.unit === "×"), offense[0]?.unit);
check("the defending list is a pressure", defense.every((row) => row.unit === "%"), defense[0]?.unit);
check("the attacking list runs best first", offense.every((row, i) => i === 0 || offense[i - 1].value >= row.value),
  offense.map((r) => `${r.type} ${r.shown}`).join(" | "));
check("the defending list runs best first", defense.every((row, i) => i === 0 || defense[i - 1].value <= row.value),
  defense.map((r) => `${r.type} ${r.shown}`).join(" | "));
check("the rows are numbered from 1", offense.every((row, i) => row.rank === i + 1) && defense.every((row, i) => row.rank === i + 1));
check("the page names the winner the way the owner asked",
  offenseLead.startsWith(`Best offensive type against Top 30 Meta: ${offense[0]?.type}.`), offenseLead.slice(0, 120));
check("the defending list says the same thing",
  defenseLead.startsWith(`Best defensive type against Top 30 Meta: ${defense[0]?.type}.`), defenseLead.slice(0, 120));
check("the sentence says the real day window", /change over the last 7 days/.test(offenseLead), offenseLead.slice(0, 160));
check("the pill says the Top X", page.getElementById("metaTypePill").textContent === "Top 30", page.getElementById("metaTypePill").textContent);
check("the page explains what best means", /same measure as the Team Builder's Offense and Defense overviews/.test(note), note.slice(0, 160));
check("the note says every Pokemon counts once", /counts once/.test(note), note.slice(0, 260));
check("the note names both days", note.includes("Sep") && note.split("Sep").length >= 3, note.slice(-160));
check("the note names no internal function", !/[a-zA-Z]+\(\)/.test(note), note.slice(0, 260));

const wantNow = builderScores(season.season, latestDate, "Doubles", 30);
const wantWas = builderScores(season.season, baselineDate, "Doubles", 30);
check(`the battle data for ${latestDate} is in the repo`, !!wantNow);
check(`the battle data for ${baselineDate} is in the repo`, !!wantWas);

if (wantNow && wantWas) {
  check("the Team Builder ranks the same 30", wantNow.count === 30, String(wantNow.count));
  const wantOffense = Object.entries(wantNow.offense).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const wantDefense = Object.entries(wantNow.defense).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  check("the attacking order is the Team Builder's",
    offense.map((row) => row.type).join(",") === wantOffense.map(([type]) => type).join(","),
    `page ${offense.map((r) => r.type).join(",")}\n    builder ${wantOffense.map(([t]) => t).join(",")}`);
  check("the defending order is the Team Builder's",
    defense.map((row) => row.type).join(",") === wantDefense.map(([type]) => type).join(","),
    `page ${defense.map((r) => r.type).join(",")}\n    builder ${wantDefense.map(([t]) => t).join(",")}`);

  const badOffense = offense.filter((row) => row.shown !== wantNow.offense[row.type].toFixed(2));
  check("every attacking score is the Team Builder's", badOffense.length === 0,
    badOffense.slice(0, 4).map((row) => `${row.type} page ${row.shown} builder ${wantNow.offense[row.type].toFixed(2)}`).join("; "));
  const badDefense = defense.filter((row) => row.shown !== wantNow.defense[row.type].toFixed(1));
  check("every defending score is the Team Builder's", badDefense.length === 0,
    badDefense.slice(0, 4).map((row) => `${row.type} page ${row.shown} builder ${wantNow.defense[row.type].toFixed(1)}`).join("; "));

  // The change: today's score minus the score on the earliest day in the window,
  // both scored the same way, with the sign and the arrow the page prints.
  const chip = (delta, digits) => `${delta > 0 ? "▲" : delta < 0 ? "▼" : "▪"} ${delta > 0 ? "+" : ""}${delta.toFixed(digits)}`;
  const badOffenseDelta = offense.filter((row) => row.delta !== chip(Number((wantNow.offense[row.type] - wantWas.offense[row.type]).toFixed(2)), 2));
  check("every attacking change is today minus the earliest day in the window", badOffenseDelta.length === 0,
    badOffenseDelta.slice(0, 4).map((row) => `${row.type} page ${row.delta} want ${chip(Number((wantNow.offense[row.type] - wantWas.offense[row.type]).toFixed(2)), 2)}`).join("; "));
  const badDefenseDelta = defense.filter((row) => row.delta !== chip(Number((wantNow.defense[row.type] - wantWas.defense[row.type]).toFixed(1)), 1));
  check("every defending change is today minus the earliest day in the window", badDefenseDelta.length === 0,
    badDefenseDelta.slice(0, 4).map((row) => `${row.type} page ${row.delta} want ${chip(Number((wantNow.defense[row.type] - wantWas.defense[row.type]).toFixed(1)), 1)}`).join("; "));

  // Colour is never the only signal, and a rise on the defending list is a worse
  // score, so it is toned the other way round.
  const risingOffense = offense.find((row) => row.delta.startsWith("▲ +"));
  const risingDefense = defense.find((row) => row.delta.startsWith("▲ +"));
  check("a rising attacking type reads as better", !risingOffense || risingOffense.tone === "up", `${risingOffense?.type} ${risingOffense?.tone}`);
  check("a rising defending type reads as worse", !risingDefense || risingDefense.tone === "down", `${risingDefense?.type} ${risingDefense?.tone}`);
  check("every chip carries its own arrow and sign", [...offense, ...defense].every((row) => /^[▲▼▪] /.test(row.delta)));
  check("a chip spells the change out in words", /on \d+ \w+ \d{4} →/.test(offense[0]?.title || ""), offense[0]?.title);
}

/* ------------------------------------------- the controls the page already has */

// The Pokemon scope select: the section is scored against the Top X it names.
page.getElementById("metaScope").value = "10";
page.getElementById("metaScope").dispatch("change");
for (let tries = 0; tries < 40 && page.getElementById("metaTypePill").textContent !== "Top 10"; tries += 1) await sleep(25);
const narrowed = readList(page, "typeOffense");
const wantNarrow = builderScores(season.season, latestDate, "Doubles", 10);
check("the Pokemon scope control moves the lists with it",
  page.getElementById("metaTypePill").textContent === "Top 10"
  && page.getElementById("typeOffenseLead").textContent.startsWith(`Best offensive type against Top 10 Meta: ${narrowed[0]?.type}.`),
  page.getElementById("typeOffenseLead").textContent.slice(0, 120));
check("and the Top 10 scores are the Team Builder's Top 10",
  !!wantNarrow && narrowed.every((row) => row.shown === wantNarrow.offense[row.type].toFixed(2)),
  narrowed.slice(0, 3).map((row) => `${row.type} page ${row.shown} builder ${wantNarrow?.offense[row.type]?.toFixed(2)}`).join("; "));

// Singles, a wider window, and a Top X from the URL: same section, same numbers.
const singlesWindow = (() => {
  const stamp = (value) => {
    const m = /^(\d{2})_(\d{2})_(\d{4})$/.exec(value);
    return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  };
  // The page reaches past the season the latest day belongs to, so that "the
  // last 14 days" is 14 days and not "as much of them as this season holds".
  const days = [];
  for (const entry of metaIndex.seasons) {
    if (!(entry.formats || []).includes("Singles")) continue;
    for (const date of entry.dates) days.push({ season: entry.season, date });
  }
  days.sort((a, b) => stamp(b.date) - stamp(a.date));
  const older = days.filter((day) => stamp(day.date) < stamp(latestDate));
  const inWindow = older.filter((day) => stamp(day.date) >= stamp(latestDate) - 14 * 86400000);
  const pick = inWindow.length ? inWindow.at(-1) : older[0];
  return { date: pick.date, season: pick.season, days: Math.round((stamp(latestDate) - stamp(pick.date)) / 86400000) };
})();
const singles = await openMetaPage(diskFetch(), { search: "?format=Singles&range=14&scope=20" });
const singlesOffense = readList(singles, "typeOffense");
const singlesDefense = readList(singles, "typeDefense");
const wantSingles = builderScores(season.season, latestDate, "Singles", 20);
const wantSinglesWas = builderScores(singlesWindow.season, singlesWindow.date, "Singles", 20);
check("Singles gets the same section", singlesOffense.length === 18 && singlesDefense.length === 18,
  `${singlesOffense.length} / ${singlesDefense.length} row(s)`);
check("its sentence names the Top X from the URL",
  singles.getElementById("typeOffenseLead").textContent.startsWith(`Best offensive type against Top 20 Meta: ${singlesOffense[0]?.type}.`),
  singles.getElementById("typeOffenseLead").textContent.slice(0, 120));
check("and the day window it really compared",
  new RegExp(`change over the last ${singlesWindow.days} days`).test(singles.getElementById("typeOffenseLead").textContent),
  singles.getElementById("typeOffenseLead").textContent.slice(0, 160));
check("the Singles scores are the Team Builder's Singles scores",
  !!wantSingles && singlesOffense.every((row) => row.shown === wantSingles.offense[row.type].toFixed(2))
  && singlesDefense.every((row) => row.shown === wantSingles.defense[row.type].toFixed(1)),
  singlesOffense.slice(0, 3).map((row) => `${row.type} page ${row.shown} builder ${wantSingles?.offense[row.type]?.toFixed(2)}`).join("; "));
check("and the Singles changes are against the Singles baseline day",
  !!wantSinglesWas && singlesDefense.every((row) => {
    const delta = Number((wantSingles.defense[row.type] - wantSinglesWas.defense[row.type]).toFixed(1));
    return row.delta === `${delta > 0 ? "▲" : delta < 0 ? "▼" : "▪"} ${delta > 0 ? "+" : ""}${delta.toFixed(1)}`;
  }),
  singlesDefense.slice(0, 3).map((row) => `${row.type} ${row.delta}`).join("; "));

// "All Pokemon" is the whole ranked list, which is also the most the Team
// Builder's Top-X can be.
singles.getElementById("metaScope").value = "all";
singles.getElementById("metaScope").dispatch("change");
for (let tries = 0; tries < 40 && !/^All /.test(singles.getElementById("metaTypePill").textContent); tries += 1) await sleep(25);
const everything = readList(singles, "typeOffense");
const wantEverything = builderScores(season.season, latestDate, "Singles", 99999);
check("the All Pokemon scope scores the whole ranked list",
  !!wantEverything && singles.getElementById("metaTypePill").textContent === `All ${wantEverything.count}`,
  `${singles.getElementById("metaTypePill").textContent} vs ${wantEverything?.count}`);
check("and says so instead of naming a Top X",
  singles.getElementById("typeOffenseLead").textContent.startsWith(`Best offensive type against the full ranked meta (${wantEverything?.count} Pokemon): ${everything[0]?.type}.`),
  singles.getElementById("typeOffenseLead").textContent.slice(0, 140));
check("with the Team Builder's numbers again",
  !!wantEverything && everything.every((row) => row.shown === wantEverything.offense[row.type].toFixed(2)),
  everything.slice(0, 3).map((row) => `${row.type} page ${row.shown} builder ${wantEverything?.offense[row.type]?.toFixed(2)}`).join("; "));

/* --------------------------------------------- a meta small enough to do by hand */

const handIndex = {
  seasons: [{ season: "T1", dates: ["10_01_2026", "03_01_2026"], formats: ["Doubles"] }],
  pokemon: {
    Rillaboom: { name: "Rillaboom", slug: "rillaboom", types: ["Grass"] },
    Kingambit: { name: "Kingambit", slug: "kingambit", types: ["Dark", "Steel"] },
    Milotic: { name: "Milotic", slug: "milotic", types: ["Water"] },
  },
  aliases: {},
};
const handDay = (pokemon) => ({ season: "T1", date: "10_01_2026", format: "Doubles", pokemon });
const entry = (position, moves, item = "Leftovers") => ({
  position,
  move: moves.map((move, index) => [move, 90 - index, index + 1]),
  held_item: [[item, 50, 1]],
});
const rillaboom = entry(1, ["Wood Hammer", "High Horsepower"]);
const kingambit = entry(2, ["Iron Head", "Sucker Punch"]);
const milotic = entry(3, ["Surf", "Ice Beam"]);

const handNow = { Rillaboom: rillaboom, Kingambit: kingambit, Milotic: milotic };
const handWas = { Rillaboom: rillaboom, Milotic: milotic };

const handPage = await openMetaPage(diskFetch({
  "data/meta/index.json": handIndex,
  "data/meta/T1/10_01_2026/Doubles.json": handDay(handNow),
  "data/meta/T1/03_01_2026/Doubles.json": { ...handDay(handWas), date: "03_01_2026" },
}));
const handOffense = readList(handPage, "typeOffense");
const handDefense = readList(handPage, "typeDefense");

// Fighting against Grass (1), Dark/Steel (2 x 2 = 4) and Water (1): 6 / 3 = 2.00.
check("the hand-built attacking winner is Fighting", handOffense[0]?.type === "Fighting", handOffense.slice(0, 3).map((r) => `${r.type} ${r.shown}`).join(" | "));
check("and its score is 2.00x", handOffense[0]?.shown === "2.00", handOffense[0]?.shown);
// Two days earlier, without Kingambit: (1 + 1) / 2 = 1.00, so the change is +1.00.
check("its change is +1.00", handOffense[0]?.delta === "▲ +1.00", handOffense[0]?.delta);

// Water defending, move by move, each Pokemon's best two averaged:
//   Rillaboom  Wood Hammer 40*(120/80)*1.5*2 = 180 -> 100, High Horsepower 40*(95/80)*1*1 = 47.5   -> 73.75
//   Kingambit  Iron Head 40*(80/80)*1.5*0.5 = 30,     Sucker Punch 40*(70/80)*1.5*1 = 52.5         -> 41.25
//   Milotic    Surf 40*(90/80)*1.5*0.5 = 33.75,       Ice Beam 40*(90/80)*1*0.5 = 22.5             -> 28.125
//   (73.75 + 41.25 + 28.125) / 3 = 47.708...
check("the hand-built defending winner is Water", handDefense[0]?.type === "Water", handDefense.slice(0, 3).map((r) => `${r.type} ${r.shown}`).join(" | "));
check("and its score is 47.7%", handDefense[0]?.shown === "47.7", handDefense[0]?.shown);
// Without Kingambit: (73.75 + 28.125) / 2 = 50.9375, so the change is -3.2.
check("its change is -3.2", handDefense[0]?.delta === "▼ -3.2", handDefense[0]?.delta);
check("the sentence counts only the Pokemon that are ranked",
  handPage.getElementById("typeOffenseLead").textContent.startsWith("Best offensive type against Top 3 Meta: Fighting."),
  handPage.getElementById("typeOffenseLead").textContent.slice(0, 120));
check("the pill follows", handPage.getElementById("metaTypePill").textContent === "Top 3", handPage.getElementById("metaTypePill").textContent);

/* ------------------------------------------------------ nothing to compare with */

const emptyPage = await openMetaPage(diskFetch({
  "data/meta/index.json": handIndex,
  "data/meta/T1/10_01_2026/Doubles.json": handDay(handNow),
  "data/meta/T1/03_01_2026/Doubles.json": { season: "T1", date: "03_01_2026", format: "Doubles", pokemon: {} },
}));
const emptyOffense = readList(emptyPage, "typeOffense");
const emptyDefense = readList(emptyPage, "typeDefense");
check("a day that ranks nobody still scores today", emptyOffense.length === 18 && emptyDefense.length === 18,
  `${emptyOffense.length} / ${emptyDefense.length} row(s)`);
check("no attacking type invents a change", emptyOffense.every((row) => row.delta === "—"), emptyOffense.slice(0, 3).map((r) => `${r.type} ${r.delta}`).join(" | "));
check("no defending type invents a change", emptyDefense.every((row) => row.delta === "—"), emptyDefense.slice(0, 3).map((r) => `${r.type} ${r.delta}`).join(" | "));
check("and it says why", /no change to show yet/.test(emptyOffense[0]?.title || ""), emptyOffense[0]?.title);

// The other half of it: a day whose Top X carries nothing that deals damage can
// still be compared as typings, but not as pressure.
const statusPage = await openMetaPage(diskFetch({
  "data/meta/index.json": handIndex,
  "data/meta/T1/10_01_2026/Doubles.json": handDay(handNow),
  "data/meta/T1/03_01_2026/Doubles.json": {
    season: "T1",
    date: "03_01_2026",
    format: "Doubles",
    pokemon: { Rillaboom: entry(1, ["Protect", "Fake Out"]), Milotic: entry(2, ["Protect", "Recover"]) },
  },
}));
const statusOffense = readList(statusPage, "typeOffense");
const statusDefense = readList(statusPage, "typeDefense");
check("typings can still be compared", statusOffense[0]?.delta === "▲ +1.00", statusOffense[0]?.delta);
check("pressure cannot, so it shows a dash", statusDefense.every((row) => row.delta === "—"),
  statusDefense.slice(0, 3).map((r) => `${r.type} ${r.delta}`).join(" | "));
check("the defending list is still scored for today", statusDefense[0]?.type === "Water" && statusDefense[0]?.shown === "47.7",
  `${statusDefense[0]?.type} ${statusDefense[0]?.shown}`);

console.log(`${checks - failures.length}/${checks} check(s) passed.`);
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
