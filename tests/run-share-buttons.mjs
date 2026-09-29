// The site's Share buttons: that they are where people will look for them, that
// pressing one really makes a share the endpoint accepts, and that a failure
// says something a person can act on.
//
//   node tests/run-share-buttons.mjs
//   node tests/run-share-buttons.mjs --verbose
//
// Three parts, and the first two are the ones that matter most:
//
//   1. THE DIGEST AGAINST THE REAL SERVER.  builder/share-client.js carries its
//      own copy of the share allowlist so a bad value never leaves the browser,
//      and functions/api/share/_lib.js is the authority on that shape.  A second
//      copy is a drift risk, so this file imports the REAL cleanTeamDigest,
//      cleanEvalDigest and cleanDigest and requires every digest to come back
//      from them UNCHANGED, field for field.  If the two copies ever disagree
//      this suite goes red instead of a player getting a 400.
//
//      The per-Pokemon stats are checked against data.engine.finalStats on the
//      same set, because that agreement is the whole point of the card: it has
//      to show the numbers the tab shows.
//
//      The evaluation digest is built from a REAL Team Evaluation, run here the
//      way tests/run-eval-vectors.mjs runs one (the recorded meta rows from
//      tests/eval-vectors.json), not from a hand-written payload, so the check
//      row and threat shapes are the ones the page actually holds.
//
//   2. WHAT A FAILURE SAYS.  Offline, sharing switched off, a refused record and
//      a card too large are four different sentences; none of them is an
//      exception, a status code or an internal name.  An empty team is refused
//      before a single request goes out, which is asserted by counting requests.
//
//   3. THE PAGE.  builder/builder-page.js is imported against a small DOM (the
//      same approach as tests/run-calc-page.mjs), with a canvas that records
//      instead of painting and a fetch that runs the record through the real
//      cleaner.  Then: the team column has a Share control, the Import / Export
//      panel has one beside Copy, Team Evaluation has one only once a result
//      exists, a result the panel has already marked out of date is not pinned to
//      a team it was not run for, an empty team is offered none at all, and
//      pressing one twice in a row posts once.
//
// No browser and no network.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cleanDigest, cleanEvalDigest, cleanTeamDigest, MAX_RECORD_CHARS } from "../functions/api/share/_lib.js";
import { BuilderData, makeSet } from "../builder/common.js";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { MAX_CARD_BYTES, spriteRequests } from "../builder/share-card.js";
import { pokemonRecord } from "../tools/builder-meta.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const verbose = process.argv.includes("--verbose");

let checked = 0;
const failures = [];

function ok(label, condition, detail = "") {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? ` - ${detail}` : ""}`);
  else if (verbose) console.log(`  ok  ${label}`);
  return Boolean(condition);
}

function same(label, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  checked += 1;
  if (a !== b) failures.push(`${label}\n     got  ${a}\n     want ${b}`);
  else if (verbose) console.log(`  ok  ${label}`);
  return a === b;
}

/** Deep equality that also refuses an extra or a missing key at any depth. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

/** The first field that differs, so a failure names it instead of printing two blobs. */
function firstDifference(a, b, path = "") {
  if (deepEqual(a, b)) return "";
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return `${path || "value"}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!deepEqual(a[key], b[key])) return firstDifference(a[key], b[key], path ? `${path}.${key}` : key);
  }
  return `${path || "value"}: key order or length differs`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, ms, label) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const value = fn();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}${pageErrors.length ? `\n     the page also reported: ${pageErrors.join("\n     ")}` : ""}`);
}

/** The page's own console.error lines, filled in part 3. */
const pageErrors = [];

console.log("== share buttons guard suite ==");

// =============================================================================
// A small DOM.  share-client.js builds its control with builder/ui.js, so even
// part 2 needs one; the page in part 3 needs all of it.
// =============================================================================

const camelToKebab = (s) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

class NodeBase {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] || null; }
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
    for (const c of children) this.appendChild(c instanceof NodeBase ? c : new TextNode(String(c)));
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
    if (v !== "" && v !== null && v !== undefined) this.appendChild(new TextNode(String(v)));
  }
}

class TextNode extends NodeBase {
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

/** Tag / #id / .class / [attr] / [attr=value], joined by descendant spaces. */
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

/** Every drawing call share-card.js makes (its CONTEXT_OPS), recorded. */
class StubContext {
  constructor() {
    this.calls = 0;
    this.drawn = 0;
    this.font = "400 13px sans";
    this.fillStyle = "#000";
    this.strokeStyle = "#000";
    this.lineWidth = 1;
    this.textAlign = "left";
    this.textBaseline = "alphabetic";
  }
  save() { this.calls += 1; }
  restore() { this.calls += 1; }
  beginPath() { this.calls += 1; }
  closePath() { this.calls += 1; }
  moveTo() { this.calls += 1; }
  lineTo() { this.calls += 1; }
  arcTo() { this.calls += 1; }
  fill() { this.calls += 1; }
  stroke() { this.calls += 1; }
  fillRect() { this.calls += 1; }
  fillText() { this.calls += 1; }
  drawImage() { this.calls += 1; this.drawn += 1; }
  /** Wide enough that the shrink ladders run; the real widths are asserted by
   *  tests/run-share-card.mjs, which is where layout belongs. */
  measureText(text) { return { width: String(text).length * 6 }; }
  createLinearGradient() { return { addColorStop() {} }; }
}

/** What the browser hands renderCardBlob: a PNG-sized blob with no pixels. */
const FAKE_CARD_BYTES = 4096;

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
    if (this.tagName === "CANVAS") {
      this._ctx = new StubContext();
      this.getContext = () => this._ctx;
      this.toBlob = (callback) => {
        canvases.push(this);
        setTimeout(() => callback(new Blob([new Uint8Array(FAKE_CARD_BYTES)], { type: "image/png" })), 0);
      };
    }
  }
  get className() { return this.getAttribute("class") || ""; }
  set className(v) { this.setAttribute("class", v); }
  get id() { return this.getAttribute("id") || ""; }
  set id(v) { this.setAttribute("id", v); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v) { if (v) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
  get value() { return this._value !== undefined ? this._value : this.getAttribute("value") ?? ""; }
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
    const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
  }
  click() { this.dispatch("click"); }
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
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() {}
  blur() {}
  select() { selections.push(this.value || this.getAttribute("value") || ""); }
  scrollIntoView() {}
  showModal() { this.setAttribute("open", ""); }
  close() { this.removeAttribute("open"); this.dispatch("close"); }
}

class Fragment extends NodeBase {
  constructor() { super(); this.nodeType = 11; }
}

/** Every canvas the card renderer made, and every text a fallback selected. */
const canvases = [];
const selections = [];
const clipboard = [];
const windowListeners = new Map();

function installDom() {
  const document = new Element("#document");
  document.nodeType = 9;
  document.body = new Element("body");
  document.documentElement = new Element("html");
  document.appendChild(document.documentElement);
  document.appendChild(document.body);
  document.createElement = (tag) => new Element(tag);
  document.createTextNode = (t) => new TextNode(String(t));
  document.createDocumentFragment = () => new Fragment();
  document.getElementById = (id) => document.querySelector(`#${id}`);
  // builder/pro.js keeps its free-run tally in a cookie as well as in storage.
  let jar = new Map();
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get() { return [...jar].map(([k, v]) => `${k}=${v}`).join("; "); },
    set(value) {
      const pair = String(value).split(";")[0];
      const at = pair.indexOf("=");
      if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1));
    },
  });
  globalThis.document = document;
  globalThis.Node = NodeBase;
  globalThis.Element = Element;
  globalThis.HTMLElement = Element;
  const store = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
      key: (i) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    };
  };
  globalThis.localStorage = store();
  globalThis.sessionStorage = store();
  globalThis.location = { search: "", pathname: "/team-builder/", href: "http://127.0.0.1/team-builder/", origin: "http://127.0.0.1" };
  globalThis.history = { replaceState() {} };
  globalThis.window = globalThis;
  globalThis.innerHeight = 800;
  globalThis.scrollX = 0;
  globalThis.scrollY = 0;
  globalThis.scrollTo = () => {};
  globalThis.addEventListener = (type, fn) => {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(fn);
  };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
  // A sprite that "loads": the card then really runs its drawImage path.
  globalThis.Image = class {
    constructor() {
      this.width = 128;
      this.height = 128;
      this.onload = null;
      this.onerror = null;
      this._src = "";
    }
    get src() { return this._src; }
    set src(value) {
      this._src = String(value);
      setTimeout(() => (this._src ? this.onload?.() : this.onerror?.()), 0);
    }
  };
  // The page only builds one when an analysis runs; part 3 answers it by hand.
  globalThis.Worker = class {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    postMessage(message) { workerPost(this, message); }
    terminate() {}
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      onLine: true,
      clipboard: {
        async writeText(value) { clipboard.push(String(value)); },
      },
    },
  });
  return document;
}

/** Answered in part 3; before that a posted message is simply dropped. */
let workerPost = () => {};

const document = installDom();

// =============================================================================
// PART 1 -- the digest, against the real server cleaners
// =============================================================================

const {
  MESSAGES, ShareError, cardHost, copyShareLink, entryDigest, evaluationDigest,
  shareButton, slotStats, teamDigest, uploadShare,
} = await import("../builder/share-client.js");

const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const data = new BuilderData(appData);

/** A real six-Pokemon team, two of them holding a Mega Stone. */
const TEAM_SETS = [
  makeSet({ species: "Froslass", form: "Mega Froslass", item: "Froslassite", ability: "Snow Warning", moves: ["Blizzard", "Shadow Ball", "Icy Wind", "Protect"], nature: "Timid", bonuses: [2, 0, 0, 32, 0, 32] }),
  makeSet({ species: "Sneasler", form: "Sneasler", item: "White Herb", ability: "Unburden", moves: ["Close Combat", "Dire Claw", "Fake Out", "Protect"], nature: "Adamant", bonuses: [2, 32, 0, 0, 0, 32] }),
  makeSet({ species: "Salamence", form: "Mega Salamence", item: "Salamencite", ability: "Aerilate", moves: ["Hyper Voice", "Tailwind", "Draco Meteor", "Protect"], nature: "Timid", bonuses: [2, 0, 0, 32, 0, 32] }),
  makeSet({ species: "Kingambit", form: "Kingambit", item: "Chople Berry", ability: "Supreme Overlord", moves: ["Sucker Punch", "Kowtow Cleave", "Iron Head", "Protect"], nature: "Adamant", bonuses: [32, 32, 0, 0, 2, 0] }),
  makeSet({ species: "Farigiraf", form: "Farigiraf", item: "Sitrus Berry", ability: "Armor Tail", moves: ["Trick Room", "Helping Hand", "Psychic", "Thunderbolt"], nature: "Bold", bonuses: [27, 0, 20, 0, 19, 0] }),
  makeSet({ species: "Milotic", form: "Milotic", item: "Leftovers", ability: "Competitive", moves: ["Scald", "Ice Beam", "Recover", "Protect"], nature: "Modest", bonuses: [32, 0, 32, 0, 2, 0] }),
];
const EMPTY_SETS = Array.from({ length: 6 }, () => makeSet());

console.log("-- 1. the digest is what the server accepts --");

const TEAM_DIGEST = teamDigest(data, { sets: TEAM_SETS, title: "Mega Froslass Trick Room", archetype: "Hyper Offense", format: "Doubles" });

{
  const cleaned = cleanTeamDigest(TEAM_DIGEST);
  ok("a team digest survives cleanTeamDigest unchanged", deepEqual(cleaned, TEAM_DIGEST), firstDifference(TEAM_DIGEST, cleaned));
  // Key order too: the record is stored and read back as text, so a digest that
  // serialises differently is not the same record.
  same("the cleaned team digest serialises identically", JSON.stringify(cleaned), JSON.stringify(TEAM_DIGEST));
  const twice = cleanTeamDigest(cleaned);
  ok("cleaning twice changes nothing", deepEqual(twice, TEAM_DIGEST), firstDifference(TEAM_DIGEST, twice));
  ok("cleanDigest routes it by kind and accepts it", deepEqual(cleanDigest(TEAM_DIGEST), TEAM_DIGEST));
  ok("every slot made it in", TEAM_DIGEST.team.length === 6, `got ${TEAM_DIGEST.team.length}`);
  ok("the record is well inside the size cap",
    JSON.stringify(TEAM_DIGEST).length < MAX_RECORD_CHARS,
    `${JSON.stringify(TEAM_DIGEST).length} of ${MAX_RECORD_CHARS}`);
}

// The agreement that matters: the numbers on the card ARE the tab's numbers.
{
  const keys = ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"];
  TEAM_SETS.forEach((set, index) => {
    const want = data.engine.finalStats({
      pokemon_name: set.species, form_name: set.form, item: set.item,
      nature_name: set.nature, bonuses: set.bonuses,
    });
    const got = TEAM_DIGEST.team[index].stats;
    same(`${set.species}: the digest's stats are finalStats' own numbers`,
      keys.map((k) => got[k]), keys.map((k) => Math.round(want[k])));
    same(`${set.species}: slotStats is that same call`,
      keys.map((k) => slotStats(data, set)[k]), keys.map((k) => want[k]));
  });
  // Not all 70s or all zeroes: a digest of default stats would pass the line
  // above and still be wrong on the card.
  const spreads = new Set(TEAM_DIGEST.team.map((entry) => keys.map((k) => entry.stats[k]).join(",")));
  ok("the six slots carry six different stat lines", spreads.size === 6, `${spreads.size} distinct`);
  ok("a Mega's stats are its Mega's, not its base form's",
    TEAM_DIGEST.team[0].stats.sp_attack > data.engine.finalStats({ pokemon_name: "Froslass", form_name: "Froslass", item: "", nature_name: "Timid", bonuses: [2, 0, 0, 32, 0, 32] }).sp_attack);
}

// The names and the Ability the slot card shows.
{
  const froslass = TEAM_DIGEST.team[0];
  same("a Mega holder is named as it battles", froslass.name, data.setName(TEAM_SETS[0]));
  same("its form is the form it battles as", froslass.form, "Mega Froslass");
  same("its species is still the base species", froslass.species, "Froslass");
  same("the nature's raised and lowered stats come through", [froslass.natureUp, froslass.natureDown], ["SPE", "ATK"]);
  ok("every sprite the card asks for can be resolved from the digest alone",
    spriteRequests(TEAM_DIGEST).every((request) => (request.slot === "items"
      ? data.itemIcon(request.item)
      : data.sprite(request.species, request.form, request.item, { full: true }))),
    "a request resolved to no local asset");
  ok("the digest carries nothing fetchable",
    !/https?:|\/pokemon_champions_assets|\.png|\.webp/i.test(JSON.stringify(TEAM_DIGEST)));
}

// A set saved as its BASE form with the stone in hand -- which is how a team
// built here, or synced from the app, can arrive. The engine applies the Mega
// itself, so the item has to reach it: without it the card would show the base
// form's numbers and its base Ability, and disagree with the slot card.
{
  const bonuses = [2, 0, 0, 32, 0, 32];
  const held = makeSet({ species: "Froslass", form: "Froslass", item: "Froslassite", ability: "Cursed Body", moves: ["Blizzard", "Shadow Ball", "Icy Wind", "Protect"], nature: "Timid", bonuses });
  const entry = entryDigest(data, held);
  same("a stone held on the base form is drawn as the Mega", entry.form, "Mega Froslass");
  same("under the name it battles as", entry.name, data.setName(held));
  same("with the Mega's own Ability, as the slot card shows it",
    entry.ability, data.battleForm("Froslass", "Froslass", "Froslassite")[2]);
  const withStone = data.engine.finalStats({ pokemon_name: "Froslass", form_name: "Froslass", item: "Froslassite", nature_name: "Timid", bonuses });
  const without = data.engine.finalStats({ pokemon_name: "Froslass", form_name: "Froslass", item: "", nature_name: "Timid", bonuses });
  ok("the stone really does change the numbers", withStone.sp_attack !== without.sp_attack, `${withStone.sp_attack} vs ${without.sp_attack}`);
  same("and the digest carries the numbers the stone gives",
    ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"].map((k) => entry.stats[k]),
    ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"].map((k) => withStone[k]));
  ok("which is a share the server takes", (() => {
    const digest = teamDigest(data, { sets: [held], title: "One" });
    return deepEqual(cleanTeamDigest(digest), digest);
  })());
}

// An empty slot is dropped, not sent as a blank row.
{
  const mixed = teamDigest(data, { sets: [makeSet(), TEAM_SETS[1], makeSet(), TEAM_SETS[3]], title: "Two", format: "Singles" });
  same("empty slots are left out", mixed.team.map((e) => e.species), ["Sneasler", "Kingambit"]);
  same("Singles is kept as the format", mixed.format, "Singles");
  ok("a part-filled team still round-trips", deepEqual(cleanTeamDigest(mixed), mixed), firstDifference(mixed, cleanTeamDigest(mixed)));
  const noTitle = teamDigest(data, { sets: [TEAM_SETS[0]] });
  same("a team with no title gets the server's own default", noTitle.title, "Pokemon Champions Team");
  ok("no archetype means no archetype field", !("archetype" in noTitle));
  ok("a team with no archetype round-trips too", deepEqual(cleanTeamDigest(noTitle), noTitle));
  same("an unknown format falls back to Doubles", teamDigest(data, { sets: [TEAM_SETS[0]], format: "Triples" }).format, "Doubles");
}

// Empty means refused, with the sentence a person reads.
{
  let message = "";
  try {
    teamDigest(data, { sets: EMPTY_SETS, title: "Nothing" });
  } catch (error) {
    message = error?.userMessage || "";
  }
  same("an empty team is refused by name", message, MESSAGES.empty);
  ok("and the refusal is a ShareError", (() => {
    try { teamDigest(data, { sets: [] }); return false; } catch (error) { return error instanceof ShareError; }
  })());
  ok("the server would refuse it too", (() => {
    try { cleanTeamDigest({ v: 1, kind: "team", team: [] }); return false; } catch { return true; }
  })());
  ok("entryDigest says no to an empty set", entryDigest(data, makeSet()) === null);
}

// ---- a REAL evaluation -------------------------------------------------------

const evalCase = JSON.parse(readFileSync(join(root, "tests", "eval-vectors.json"), "utf8"))[0];
const EVAL_PAYLOAD = (() => {
  const engine = new DamageEngine(appData);
  const evaluator = new TeamEvaluator(null, engine, "Doubles", evalCase.settings);
  const metaRows = evalCase.record.meta[0]?.rows || [];
  evaluator.setMetaRecords(metaRows.map((row) => pokemonRecord(
    String(row.pokemon || row.base_name || row.name), row.rows || [], appData.usageAliases || {})));
  const extra = evalCase.extra || {};
  const mons = evalCase.record.team_mons.at(-1)?.mons || [];
  const sets = (extra.simple_profiles || []).map((profile, i) => {
    const [species, item, form, ability, moves] = profile.entry;
    const source = mons[i] || {};
    return makeSet({ species, item, form, ability, moves, nature: source.nature_name, bonuses: source.bonuses });
  });
  const payload = new TeamEvaluation(evaluator).evaluate(sets, { checkSelection: extra.selected_checks });
  // What the worker sends the page: structured-clone-safe, mon objects flattened.
  const { slots, ...rest } = payload;
  return { sets, payload: JSON.parse(JSON.stringify({ ...rest, slots: (slots || []).map(({ entry, mon }) => ({ entry, mon })) })) };
})();

ok("the real evaluation produced check rows", (EVAL_PAYLOAD.payload.checks?.rows || []).length >= 8);
ok("and a detected archetype", Boolean(EVAL_PAYLOAD.payload.archetype?.archetype));
ok("and critical threats", (EVAL_PAYLOAD.payload.threats || []).length > 6);

const EVAL_DIGEST = evaluationDigest(data, {
  result: EVAL_PAYLOAD.payload,
  sets: EVAL_PAYLOAD.sets,
  title: "Mega Froslass Trick Room",
  format: "Doubles",
});

{
  const cleaned = cleanEvalDigest(EVAL_DIGEST);
  ok("an evaluation digest survives cleanEvalDigest unchanged", deepEqual(cleaned, EVAL_DIGEST), firstDifference(EVAL_DIGEST, cleaned));
  same("the cleaned evaluation digest serialises identically", JSON.stringify(cleaned), JSON.stringify(EVAL_DIGEST));
  ok("cleanDigest routes an eval by kind", deepEqual(cleanDigest(EVAL_DIGEST), EVAL_DIGEST));
  ok("a full evaluation record is inside the size cap",
    JSON.stringify(EVAL_DIGEST).length < MAX_RECORD_CHARS,
    `${JSON.stringify(EVAL_DIGEST).length} of ${MAX_RECORD_CHARS}`);
}

// The card has to say what the tab says.
{
  const p = EVAL_PAYLOAD.payload;
  same("the four scores are the payload's own, rounded",
    [EVAL_DIGEST.scores.synergy, EVAL_DIGEST.scores.offense, EVAL_DIGEST.scores.defense, EVAL_DIGEST.scores.speed],
    [Math.round(p.synergy_score), Math.round(p.offense_score), Math.round(p.defense_score), Math.round(p.speed.score)]);
  same("the detected archetype is the one the checks found", EVAL_DIGEST.archetype, p.archetype.archetype);
  same("the Top Meta size comes from the run's own settings", EVAL_DIGEST.topMeta, p.settings.top_meta);
  same("the threat total is how many of the Top Meta were looked at", EVAL_DIGEST.threatCount, p.all_top_meta_threat_rows_v462);

  const rows = p.checks.rows;
  const counts = { good: 0, yellow: 0, red: 0 };
  for (const row of rows) counts[["good", "yellow", "red"].includes(row.severity) ? row.severity : "good"] += 1;
  same("the check tally counts every row, not only the shown ones", EVAL_DIGEST.checkCounts, counts);
  ok("the checks that need attention are not the ones that fall off the end",
    EVAL_DIGEST.checks.every((row, i) => i === 0 || rank(EVAL_DIGEST.checks[i - 1].severity) <= rank(row.severity)),
    EVAL_DIGEST.checks.map((r) => r.severity).join(","));
  ok("no more checks than the card holds", EVAL_DIGEST.checks.length <= 16);
  ok("every check row carries a heading and a real severity",
    EVAL_DIGEST.checks.every((row) => row.label && ["good", "yellow", "red"].includes(row.severity)));
  ok("the archetype check is one of them", EVAL_DIGEST.checks.some((row) => row.label === `Archetype: ${p.archetype.archetype}`));

  ok("at most six threats", EVAL_DIGEST.threats.length === 6, `${EVAL_DIGEST.threats.length}`);
  ok("the most dangerous first", EVAL_DIGEST.threats.every((row, i) => i === 0 || EVAL_DIGEST.threats[i - 1].score >= row.score));
  const worst = [...p.threats].sort((a, b) => b.score - a.score).slice(0, 6).map((row) => row.name);
  same("and they are the six worst of the run", EVAL_DIGEST.threats.map((row) => row.name), worst);
  const mega = EVAL_DIGEST.threats.find((row) => row.name === "Mega Charizard Y");
  ok("a threat that Megas carries its base species and its Mega form",
    mega && mega.species === "Charizard" && mega.form === "Mega Charizard Y",
    JSON.stringify(mega));
  ok("a threat carries the item its calcs used", EVAL_DIGEST.threats.every((row) => typeof row.item === "string"));
  ok("every threat sprite resolves locally",
    spriteRequests(EVAL_DIGEST).every((request) => (request.slot === "items"
      ? data.itemIcon(request.item)
      : data.sprite(request.species, request.form, request.item, { full: true }))));
  ok("the evaluation digest carries nothing fetchable either",
    !/https?:|\/pokemon_champions_assets|\.png|\.webp/i.test(JSON.stringify(EVAL_DIGEST)));
}

function rank(severity) {
  return { red: 0, yellow: 1, good: 2 }[severity] ?? 2;
}

// An evaluation with nothing to show is refused, not drawn empty.
{
  let noResult = "";
  try { evaluationDigest(data, { result: null, sets: TEAM_SETS }); } catch (error) { noResult = error?.userMessage || ""; }
  same("no finished result means no share", noResult, MESSAGES.noResult);
  let noTeam = "";
  try { evaluationDigest(data, { result: EVAL_PAYLOAD.payload, sets: EMPTY_SETS }); } catch (error) { noTeam = error?.userMessage || ""; }
  same("an evaluation of nothing is refused as well", noTeam, MESSAGES.empty);
}

// =============================================================================
// PART 2 -- what a failure says, and that a refusal costs no request
// =============================================================================

console.log("-- 2. failures say something a person can act on --");

const png = () => new Blob([new Uint8Array(FAKE_CARD_BYTES)], { type: "image/png" });
const answer = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, async json() { return body; } });

async function upload(digest, blob, respond) {
  const seen = [];
  const fetchStub = async (url, options) => {
    seen.push({ url, options });
    if (typeof respond === "function") return respond(url, options);
    throw respond;
  };
  try {
    const result = await uploadShare(digest, blob, { fetch: fetchStub });
    return { seen, result, message: "" };
  } catch (error) {
    return { seen, result: null, message: error?.userMessage ?? String(error) };
  }
}

{
  const good = await upload(TEAM_DIGEST, png(), () => answer(201, { code: "CBS-AAAA-BBBB-CCCC-DDDD", pageUrl: "https://championsbattledata.com/api/share/CBS-AAAA-BBBB-CCCC-DDDD" }));
  ok("a created share comes back with its link", good.result?.pageUrl?.includes("CBS-"), JSON.stringify(good.result));
  same("one press is one request", good.seen.length, 1);
  const body = good.seen[0].options.body;
  ok("the record and the card go up together in one body", body instanceof FormData && body.get("record") && body.get("image"));
  ok("the record on the wire is the digest", deepEqual(JSON.parse(body.get("record")), TEAM_DIGEST));
  ok("the card is sent as a PNG file", body.get("image")?.type === "image/png");
  ok("the request is a POST", good.seen[0].options.method === "POST");

  const reused = await upload(TEAM_DIGEST, png(), () => answer(200, { code: "CBS-AAAA-BBBB-CCCC-DDDD", reused: true, pageUrl: "https://championsbattledata.com/api/share/CBS-AAAA-BBBB-CCCC-DDDD" }));
  ok("sharing the same team twice is the same link, not an error", reused.result?.reused === true && !reused.message);

  same("sharing switched off says so", (await upload(TEAM_DIGEST, png(), () => answer(503, { error: "Sharing is not configured on this server." }))).message, MESSAGES.notConfigured);
  same("a refused record says so", (await upload(TEAM_DIGEST, png(), () => answer(400, { error: "missing digest" }))).message, MESSAGES.refused);
  same("too large says what to do", (await upload(TEAM_DIGEST, png(), () => answer(413, {}))).message, MESSAGES.tooBig);
  same("today's limit says to come back tomorrow", (await upload(TEAM_DIGEST, png(), () => answer(429, {}))).message, MESSAGES.limit);
  same("a wrong origin says where sharing works", (await upload(TEAM_DIGEST, png(), () => answer(403, {}))).message, MESSAGES.notAllowed);
  same("anything else is a plain try again", (await upload(TEAM_DIGEST, png(), () => answer(500, {}))).message, MESSAGES.serverError);
  same("a 201 with no link is not treated as success", (await upload(TEAM_DIGEST, png(), () => answer(201, {}))).message, MESSAGES.serverError);
  same("a body that is not JSON is not a crash", (await upload(TEAM_DIGEST, png(), () => ({ status: 201, ok: true, async json() { throw new Error("not json"); } }))).message, MESSAGES.serverError);

  const dead = await upload(TEAM_DIGEST, png(), new TypeError("Failed to fetch"));
  same("an unreachable site says to check the connection", dead.message, MESSAGES.network);

  navigator.onLine = false;
  const off = await upload(TEAM_DIGEST, png(), () => answer(201, { pageUrl: "x" }));
  same("a browser that knows it is offline says so", off.message, MESSAGES.offline);
  same("and spends no request on it", off.seen.length, 0);
  navigator.onLine = true;

  const huge = await upload(TEAM_DIGEST, new Blob([new Uint8Array(MAX_CARD_BYTES + 1)], { type: "image/png" }), () => answer(201, { pageUrl: "x" }));
  same("a card over the byte cap is refused here, not there", huge.message, MESSAGES.tooBig);
  same("and costs no request either", huge.seen.length, 0);

  const nothing = await upload(TEAM_DIGEST, new Blob([], { type: "image/png" }), () => answer(201, { pageUrl: "x" }));
  same("a card that did not draw is not uploaded", nothing.message, MESSAGES.drawFailed);
  same("and costs no request", nothing.seen.length, 0);

  // No internal names, no status codes, no version numbers, and a finished
  // sentence: whatever a person reads has to make sense on its own.
  for (const [name, message] of Object.entries(MESSAGES)) {
    ok(`the "${name}" message reads as plain English`,
      !/\b(?:digest|payload|PNG|JSON|multipart|R2|HTTP|4\d\d|5\d\d|undefined|null|Error|_v\d)/.test(message)
      && !/v\d+\.\d+/.test(message)
      && /[.!…]$/.test(message.trim()),
      message);
  }
}

// A Share control never posts an empty team, and says why.
{
  let requests = 0;
  const said = [];
  const button = shareButton({
    label: "Share team",
    build: () => teamDigest(data, { sets: EMPTY_SETS, title: "Nothing" }),
    host: () => cardHost(data),
    share: async () => { requests += 1; return { pageUrl: "x" }; },
    copy: async () => true,
    notify: (message, tone) => said.push(`${tone || "info"}: ${message}`),
  });
  button.click();
  await sleep(30);
  same("an empty team never reaches the network", requests, 0);
  same("and the button says what to do instead", said, [`error: ${MESSAGES.empty}`]);
  ok("the button is still usable afterwards", !button.disabled);
}

// The whole control, end to end, without the page.
{
  const said = [];
  let released;
  const gate = new Promise((resolve) => { released = resolve; });
  let calls = 0;
  const button = shareButton({
    label: "Share team",
    build: () => TEAM_DIGEST,
    host: () => cardHost(data),
    share: async (digest) => {
      calls += 1;
      await gate;
      return uploadShare(digest, png(), { fetch: async () => answer(201, { pageUrl: "https://championsbattledata.com/api/share/CBS-1111-2222-3333-4444" }) });
    },
    copy: copyShareLink,
    notify: (message, tone) => said.push(`${tone || "info"}: ${message}`),
  });
  button.click();
  await sleep(10);
  ok("the button is disabled while it works", button.disabled);
  same("and says so", button.textContent, "Sharing…");
  same("with feedback straight away", said[0], `info: ${MESSAGES.working}`);
  button.click();
  button.click();
  released();
  await until(() => !button.disabled, 5000, "the share to finish");
  same("pressing it again while it works posts nothing extra", calls, 1);
  same("it goes back to its own label", button.textContent, "Share team");
  same("and says the link was copied", said.at(-1), `info: ${MESSAGES.copied}`);
  same("the link really is on the clipboard", clipboard.at(-1), "https://championsbattledata.com/api/share/CBS-1111-2222-3333-4444");
}

// The clipboard fallback: the Copy button's own behaviour, which is to put the
// text on screen already selected.
{
  const before = selections.length;
  const writeText = navigator.clipboard.writeText;
  navigator.clipboard.writeText = async () => { throw new Error("blocked"); };
  const copied = await copyShareLink("https://championsbattledata.com/api/share/CBS-9999-8888-7777-6666");
  navigator.clipboard.writeText = writeText;
  ok("a blocked clipboard is reported, not hidden", copied === false);
  same("and the link is selected on screen so it can be copied by hand",
    selections.at(-1), "https://championsbattledata.com/api/share/CBS-9999-8888-7777-6666");
  ok("something new really was selected", selections.length > before);
  const dialog = document.body.querySelectorAll("dialog").at(-1);
  ok("the fallback shows the link itself", dialog?.textContent.includes("selected"), dialog?.textContent);
  dialog?.querySelector(".primary-button")?.click();
}

// =============================================================================
// PART 3 -- the page: the three controls, and what pressing one really does
// =============================================================================

console.log("-- 3. the page --");

const realError = console.error;
console.error = (...args) => pageErrors.push(args.map((a) => (a && a.stack) || String(a)).join(" "));
process.on("unhandledRejection", (error) => pageErrors.push(`unhandledRejection: ${error?.stack || error}`));

const slot = (set) => [set.species, set.item, set.form, set.ability, set.moves];
const EMPTY_SLOT = ["", "", "", "", []];
const spreads = (sets) => Object.fromEntries(sets.map((set, i) => [i, { nature_name: set.nature, bonuses: set.bonuses }]));

const FULL_TEAM = {
  id: "team_full", title: "Mega Froslass Trick Room", archetype: "Hyper Offense", updated: 20,
  team: TEAM_SETS.map(slot),
  ev_spreads: spreads(TEAM_SETS),
};
const BARE_TEAM = {
  id: "team_bare", title: "Nothing Yet", archetype: "Balanced", updated: 10,
  team: Array.from({ length: 6 }, () => EMPTY_SLOT),
  ev_spreads: {},
};

localStorage.setItem("cbd.builder.v1", JSON.stringify({
  version: 1, format: "Doubles", teams: [FULL_TEAM, BARE_TEAM], selectedTeamId: "team_full",
  boxes: [{ id: "box_1", name: "Box 1", box: [] }], currentBoxId: "box_1",
  tombstones: { teams: {}, boxes: {} }, settings: {}, updatedAt: 1,
}));

/** Every share the page posted, with the record already run through the REAL
 *  server cleaner -- so "it works" means the endpoint would have taken it. */
const posted = [];
let nextCode = 0;
let holdShare = null;

globalThis.fetch = async (url, options = {}) => {
  const path = String(url).split("?")[0];
  if (path === "/api/share" && String(options.method || "GET").toUpperCase() === "POST") {
    if (holdShare) await holdShare;
    const body = options.body;
    const raw = JSON.parse(body.get("record"));
    const image = body.get("image");
    let cleaned = null;
    let refusal = "";
    try {
      cleaned = cleanDigest(raw);
    } catch (error) {
      refusal = error.message;
    }
    posted.push({ raw, cleaned, refusal, bytes: image?.size ?? 0, name: image?.name || "" });
    if (refusal) return { ok: false, status: 400, async json() { return { error: refusal }; } };
    nextCode += 1;
    const code = `CBS-TEST-0000-0000-000${nextCode}`;
    return { ok: true, status: 201, async json() { return { code, kind: cleaned.kind, pageUrl: `https://championsbattledata.com/api/share/${code}`, imageUrl: `https://championsbattledata.com/api/share/img/${code}`, bytes: image?.size ?? 0 }; } };
  }
  if (path.startsWith("/api/")) return { ok: false, status: 404, async json() { return {}; }, async text() { return ""; } };
  try {
    const text = readFileSync(join(root, path.replace(/^\/+/, "")), "utf8");
    return { ok: true, status: 200, async json() { return JSON.parse(text); }, async text() { return text; } };
  } catch {
    return { ok: false, status: 404, async json() { return {}; }, async text() { return ""; } };
  }
};

// The page's analysis worker, answered by hand with the real evaluation above.
workerPost = (worker, message) => {
  if (!message || message.type !== "evaluate") return;
  setTimeout(() => {
    for (const fn of worker.listeners.get("message") || []) {
      fn({ data: { id: message.id, ok: true, result: JSON.parse(JSON.stringify(EVAL_PAYLOAD.payload)) } });
    }
  }, 0);
};

const app = new Element("div");
app.id = "builderApp";
document.body.append(app);
for (const value of ["Doubles", "Singles"]) {
  const button = new Element("button");
  button.dataset.format = value;
  document.body.append(button);
}

await import(pathToFileURL(join(root, "builder", "builder-page.js")).href);
await until(() => document.querySelector(".bd-team-col .bd-slot"), 60000, "the Team Builder to draw");

const tab = (label) => document.querySelectorAll(".bd-toolbar .bd-tab").find((node) => node.textContent === label);
const shareControls = (scope) => (scope ? scope.querySelectorAll("button") : []).filter((node) => /^Share /.test(node.textContent));
const toasts = () => document.body.querySelectorAll(".bd-toast").map((node) => node.textContent);

/** Switch tabs by its name in the toolbar; a missing tab is a named failure. */
function openTab(label) {
  const button = tab(label);
  if (!button) return ok(`the ${label} tab is in the toolbar`, false);
  button.click();
  return true;
}

/** Press the one Share control in `controls` and wait for the share it posts.
 *  A control that is not there is reported, never thrown, so this suite says
 *  what is missing instead of dying with a stack. */
async function pressShare(controls, label) {
  if (controls.length !== 1) {
    ok(label, false, `${controls.length} Share controls found`);
    return null;
  }
  const before = posted.length;
  controls[0].click();
  await until(() => posted.length > before, 20000, `${label}: the share to be posted`);
  await until(() => !controls[0].disabled, 20000, `${label}: the share to finish`);
  same(`${label}: one press posts one share`, posted.length, before + 1);
  return posted.at(-1);
}

// ---- the team column ---------------------------------------------------------
{
  const head = document.querySelector(".bd-team-col .bd-panel-head");
  const controls = shareControls(head);
  same("the team column's heading offers exactly one Share control", controls.length, 1);
  same("and it says what it shares", controls[0]?.textContent, "Share team");
  ok("it sits in the heading's actions row, where the other panels put theirs",
    controls[0]?.closest(".bd-actions") !== null && controls[0]?.closest(".bd-panel-head") !== null);

  const sent = await pressShare(controls, "the team column's Share control");
  if (sent) {
    same("the endpoint accepted the record", sent.refusal, "");
    ok("the record went up exactly as the server keeps it", deepEqual(sent.raw, sent.cleaned), firstDifference(sent.raw, sent.cleaned));
    same("it is a team card", sent.raw.kind, "team");
    same("of the team that is open", sent.raw.title, "Mega Froslass Trick Room");
    same("with the archetype the team is saved under", sent.raw.archetype, "Hyper Offense");
    same("and all six Pokemon", sent.raw.team.map((e) => e.species),
      ["Froslass", "Sneasler", "Salamence", "Kingambit", "Farigiraf", "Milotic"]);
    ok("with the stats the slot cards show",
      sent.raw.team.every((entry, i) => entry.stats.speed === Math.round(slotStats(data, TEAM_SETS[i]).speed)),
      JSON.stringify(sent.raw.team.map((e) => e.stats.speed)));
    same("the card was drawn at the size the endpoint demands",
      [canvases.at(-1)?.width, canvases.at(-1)?.height], [1200, 630]);
    ok("and something was actually painted on it", (canvases.at(-1)?._ctx.calls || 0) > 100);
    ok("including the sprites", (canvases.at(-1)?._ctx.drawn || 0) >= 6, `${canvases.at(-1)?._ctx.drawn} images`);
    same("the file was sent under a name", sent.name, "card.png");
    same("the link is on the clipboard", clipboard.at(-1), "https://championsbattledata.com/api/share/CBS-TEST-0000-0000-0001");
    ok("and the page said so plainly", toasts().includes(MESSAGES.copied), toasts().join(" | "));
  }
}

// ---- Import / Export ---------------------------------------------------------
if (openTab("Import / Export")) {
  await until(() => document.querySelector(".bd-main .bd-textarea"), 20000, "the Import / Export panel");
  const copy = document.querySelectorAll(".bd-main .bd-actions button").find((node) => node.textContent === "Copy");
  ok("the Copy button is still there", Boolean(copy));
  const controls = shareControls(copy?.closest(".bd-actions"));
  same("Share sits in the same row as Copy", controls.length, 1);
  same("and says what it shares", controls[0]?.textContent, "Share team");

  const previous = posted.at(-1);
  const sent = await pressShare(controls, "the Import / Export Share control");
  if (sent) {
    same("the endpoint accepted this record too", sent.refusal, "");
    same("it shares the same team", sent.raw.team.length, 6);
    ok("as the very same record the team column made", deepEqual(sent.raw, previous?.raw), firstDifference(sent.raw, previous?.raw));
  }
}

// ---- Team Evaluation ---------------------------------------------------------
if (openTab("Team Evaluation")) {
  await until(() => document.querySelector(".bd-main .bd-panel-head"), 20000, "the Team Evaluation panel");
  same("with no result there is nothing to share yet",
    shareControls(document.querySelector(".bd-main")).length, 0);

  const run = document.querySelectorAll(".bd-main button").find((node) => node.textContent === "Run Team Evaluation");
  ok("the run button is offered instead", Boolean(run));
  run?.click();
  await until(() => document.querySelector(".bd-main .bd-scores"), 30000, "the evaluation to finish");

  const head = document.querySelector(".bd-main .bd-panel-head");
  const controls = shareControls(head);
  same("a finished result offers exactly one Share control", controls.length, 1);
  same("and it says it shares the result", controls[0]?.textContent, "Share result");
  ok("beside Run again, in the actions row that already exists",
    Boolean(controls[0]?.closest(".bd-actions")?.querySelectorAll("button").some((node) => /Run again|Evaluate changes/.test(node.textContent))));

  const sent = await pressShare(controls, "the Team Evaluation Share control");
  if (sent) {
    same("the endpoint accepted the evaluation record", sent.refusal, "");
    ok("it went up exactly as the server keeps it", deepEqual(sent.raw, sent.cleaned), firstDifference(sent.raw, sent.cleaned));
    same("it is an evaluation card", sent.raw.kind, "eval");
    same("carrying the four scores the tab shows", sent.raw.scores, EVAL_DIGEST.scores);
    same("the archetype the checks detected", sent.raw.archetype, EVAL_PAYLOAD.payload.archetype.archetype);
    same("the check tally", sent.raw.checkCounts, EVAL_DIGEST.checkCounts);
    same("and the six worst threats", sent.raw.threats.map((row) => row.name), EVAL_DIGEST.threats.map((row) => row.name));
    ok("the card was drawn from it", (canvases.at(-1)?._ctx.calls || 0) > 100);
  }

  // A result the panel is already showing as out of date must not be pinned to
  // the team that is on screen now: the picture cannot be corrected afterwards.
  const remove = document.querySelectorAll(".bd-team-col .bd-slot .bd-slot-tools button").find((node) => node.textContent === "×");
  if (ok("a Pokemon can be taken off the team", Boolean(remove))) {
    remove.click();
    await until(() => document.querySelector(".bd-main .bd-stale-note"), 20000, "the result to be marked out of date");
    const stale = shareControls(document.querySelector(".bd-main .bd-panel-head"));
    same("the Share control is still offered", stale.length, 1);
    const before = posted.length;
    stale[0].click();
    await sleep(200);
    same("but an out-of-date result is not shared", posted.length, before);
    ok("and it says what to do first", toasts().includes(MESSAGES.stale), toasts().join(" | "));
    ok("the button is left usable", !stale[0].disabled);
  }
}

// ---- an empty team is offered nothing ---------------------------------------
{
  const list = document.querySelector(".bd-library-list");
  const pick = list?.querySelectorAll("button").find((node) => node.textContent.includes("Nothing Yet"));
  if (ok("the empty team can be selected from the library", Boolean(pick))) {
    pick.click();
    await until(() => document.querySelector(".bd-team-col .bd-slot-empty"), 20000, "the empty team to draw");
    const before = posted.length;
    same("an empty team gets no Share control in the team column",
      shareControls(document.querySelector(".bd-team-col")).length, 0);
    if (openTab("Import / Export")) {
      await until(() => document.querySelector(".bd-main .bd-textarea"), 20000, "Import / Export again");
      same("and none beside Copy either",
        shareControls(document.querySelector(".bd-main")).length, 0);
    }
    same("so nothing was posted", posted.length, before);
  }
}

ok("the page raised no errors of its own", pageErrors.length === 0, pageErrors.join("\n     "));
ok("every share the page posted was one the endpoint accepts",
  posted.length >= 3 && posted.every((row) => !row.refusal),
  posted.map((row) => row.refusal).filter(Boolean).join(" | "));

console.error = realError;

// =============================================================================

console.log(`\n${checked} checks, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exit(1);
}
console.log("share buttons: OK");
process.exit(0);
