// Checks the Damage Calculator page itself (damage-calculator/index.html and
// builder/calc-page.js), not the numbers - those are covered by
// tests/run-calc-vectors.mjs and tests/run-calc-amounts.mjs.
//
//   node tests/run-calc-page.mjs
//
// It covers:
//   * the hero: the eyebrow line, and that the long "Level 50 with Stat
//     Points..." paragraph is gone;
//   * the import row's team picker: every saved team is offered, it starts on
//     the team the Team Builder has open, picking another team swaps the chips
//     without moving the Team Builder's own selection, and the pick survives a
//     reload;
//   * the awkward teams: one saved team, a team with empty slots, an all-empty
//     team, a team saved in the Companion's shape (Showdown names, numeric
//     ev_spread keys, no form), a team naming a Pokemon this site does not
//     hold, and a deleted team;
//   * the meta row: 30 chips in both formats.
//
// The page needs a DOM, so this file carries a small one (enough for
// builder/ui.js, the page's renders, simple selectors and click/change events).
// No browser and no network: fetch reads the site's own files.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let checked = 0;
const failures = [];
function check(label, got, want) {
  checked += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) failures.push(`${label}\n     got  ${a}\n     want ${b}`);
}
function ok(label, condition, detail = "") {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
}

// ---------------------------------------------------------------- the page file

const html = readFileSync(join(root, "damage-calculator", "index.html"), "utf8");
ok("hero eyebrow reads \"Pokemon Champions Damage Calculator\"",
  /<p class="eyebrow">Pokemon Champions Damage Calculator<\/p>/.test(html));
ok("the old \"Free · in your browser\" eyebrow is gone", !html.includes("no account needed"));
ok("the \"Level 50 with Stat Points\" paragraph is gone", !html.includes("Level 50 with Stat Points"));
ok("no hero paragraph is left in the hero", !/<p class="hero-text">/.test(html));
ok("the calculator still mounts on #calcApp", html.includes('id="calcApp"'));

// ------------------------------------------------------------------- a small DOM

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
  focus() {}
  blur() {}
  select() {}
  scrollIntoView() {}
  showModal() { this.setAttribute("open", ""); }
  close() { this.removeAttribute("open"); }
}

class Fragment extends NodeBase {
  constructor() { super(); this.nodeType = 11; }
}

const windowListeners = new Map();

function installDom(siteRoot) {
  const document = new Element("#document");
  document.nodeType = 9;
  document.body = new Element("body");
  document.appendChild(document.body);
  document.createElement = (tag) => new Element(tag);
  document.createTextNode = (text) => new Text(String(text));
  document.createDocumentFragment = () => new Fragment();
  document.getElementById = (id) => document.querySelector(`#${id}`);
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
  globalThis.location = { search: "", pathname: "/damage-calculator/", href: "http://127.0.0.1/damage-calculator/", origin: "http://127.0.0.1" };
  globalThis.history = { replaceState() {} };
  globalThis.window = globalThis;
  globalThis.addEventListener = (type, fn) => {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(fn);
  };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
  globalThis.fetch = async (url) => {
    const path = String(url).split("?")[0];
    const file = join(siteRoot, path);
    if (path.startsWith("/api/") || !existsSync(file)) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const text = readFileSync(file, "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  };
  return document;
}

/** What another tab's write looks like here: the store re-reads and the page redraws. */
function fireStorage(key) {
  for (const fn of windowListeners.get("storage") || []) fn({ key });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll for a condition; false when it never comes (the check then reports it). */
async function settle(fn, ms = 15000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}
async function until(fn, ms = 60000, label = "condition") {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const value = fn();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// --------------------------------------------------------------------- fixtures

const slot = (pokemon, item = "", form = "", ability = "", moves = []) => [pokemon, item, form || pokemon, ability, moves];
const EMPTY = ["", "", "", "", []];
const fill = (entries) => Array.from({ length: 6 }, (_, i) => entries[i] || EMPTY);

const MY_TEAM = {
  id: "team_my", title: "My Team", archetype: "Balanced", updated: 10,
  team: fill([
    slot("Rillaboom", "Miracle Seed", "Rillaboom", "Grassy Surge", ["Grassy Glide", "Fake Out", "Wood Hammer", "U-turn"]),
    slot("Incineroar", "Sitrus Berry", "Incineroar", "Intimidate", ["Fake Out", "Knock Off", "Flare Blitz", "Parting Shot"]),
  ]),
  ev_spreads: { 0: { nature_name: "Adamant", bonuses: [32, 32, 0, 0, 0, 2] } },
};
const RAIN_TEAM = {
  id: "team_rain", title: "Rain Test", archetype: "Rain", updated: 20,
  team: fill([
    slot("Pelipper", "Focus Sash", "Pelipper", "Drizzle", ["Hurricane", "Weather Ball", "Tailwind", "Protect"]),
    slot("Basculegion", "Life Orb", "Basculegion", "Swift Swim", ["Wave Crash", "Last Respects", "Aqua Jet", "Protect"]),
    slot("Garchomp", "Garchompite Z", "Garchomp", "Rough Skin", ["Earthquake", "Dragon Claw", "Rock Slide", "Protect"]),
  ]),
  ev_spreads: {},
};
const EMPTY_TEAM = { id: "team_empty", title: "Empty Plan", archetype: "Balanced", updated: 30, team: fill([]), ev_spreads: {} };
// A team as the Companion (or an older site version) leaves it: Showdown names,
// no form column, ev_spreads keyed by number, and a Pokemon this site's tables
// do not hold.
const SYNCED_TEAM = {
  id: "team_synced", title: "Synced Team", archetype: "Trick Room", updated: 40,
  team: fill([
    ["Indeedee-F", "Psychic Seed", "", "Psychic Surge", ["Expanding Force", "Follow Me", "Trick Room", "Helping Hand"]],
    ["Arcanine-Hisui", "Choice Band", "", "Intimidate", ["Flare Blitz", "Head Smash", "Extreme Speed", "Rock Slide"]],
    ["Missingno", "Leftovers", "", "", ["Splash"]],
  ]),
  ev_spreads: { 0: { nature_name: "Sassy", bonuses: [32, 0, 0, 30, 2, 0] }, 1: { nature_name: "Adamant", bonuses: [2, 32, 0, 0, 0, 32] } },
};

const document = installDom(root);
const builderDoc = (teams, selectedTeamId, boxes = [{ id: "box_1", name: "Box 1", box: [] }]) => JSON.stringify({
  version: 1, format: "Doubles", teams, selectedTeamId, boxes, currentBoxId: boxes[0]?.id || "box_1",
  tombstones: { teams: {}, boxes: {} }, settings: {}, updatedAt: 1,
});
const writeTeams = (teams, selectedTeamId, boxes) => {
  localStorage.setItem("cbd.builder.v1", builderDoc(teams, selectedTeamId, boxes));
  fireStorage("cbd.builder.v1");
};

localStorage.setItem("cbd.builder.v1", builderDoc([MY_TEAM, RAIN_TEAM, EMPTY_TEAM, SYNCED_TEAM], "team_my"));

const app = new Element("div");
app.id = "calcApp";
document.body.append(app);
for (const format of ["Doubles", "Singles"]) {
  const button = new Element("button");
  button.dataset.format = format;
  document.body.append(button);
}

const pageErrors = [];
console.error = (...args) => pageErrors.push(args.map((a) => (a && a.stack) || String(a)).join(" "));
process.on("unhandledRejection", (error) => pageErrors.push(`unhandledRejection: ${error?.stack || error}`));

const pageUrl = `file:///${join(root, "builder", "calc-page.js").replace(/\\/g, "/")}`;
await import(pageUrl);
await until(() => document.querySelector(".bd-calc-body"), 60000, "the calculator to draw");

// ------------------------------------------------------------------- the checks

const importRows = () => document.querySelectorAll(".bd-import-row");
const pickers = () => document.querySelectorAll(".bd-import-team");
const teamChips = () => document.querySelectorAll(".bd-mon.bd-side-left .bd-import-chips")[0]?.querySelectorAll(".bd-import-chip") || [];
const metaChips = () => document.querySelectorAll(".bd-mon.bd-side-left .bd-import-meta")[0]?.querySelectorAll(".bd-import-chip") || [];
const chipNames = (list) => list.map((chip) => (chip.getAttribute("title") || "").replace(/^Load /, ""));
const pickerValue = (select) => select.querySelectorAll("option").find((o) => o.hasAttribute("selected"))?.getAttribute("value") || "";
const pickerOptions = () => pickers()[0]?.querySelectorAll("option") || [];
const pick = async (id) => {
  // Missing picker: the checks below report it, rather than this line throwing.
  const select = pickers()[0];
  if (select) {
    select.value = id;
    select.dispatch("change", { target: select });
  }
  await sleep(0);
};

check("both Pokemon cards carry an import row for the team and one for the meta", importRows().length, 4);
check("each Pokemon card has a team picker", pickers().length, 2);
check("the picker offers every saved team, in the Team Builder's order",
  pickerOptions().map((o) => [o.getAttribute("value"), o.textContent]),
  [["team_my", "My Team"], ["team_rain", "Rain Test"], ["team_empty", "Empty Plan"], ["team_synced", "Synced Team"]]);
check("it starts on the team the Team Builder has open", pickers().map(pickerValue), ["team_my", "team_my"]);
check("the label next to it reads \"Import from\"",
  document.querySelectorAll(".bd-import-head")[0]?.querySelector(".bd-field-label")?.textContent || "(no import head)", "Import from");
check("the chips are that team's Pokemon", chipNames(teamChips()), ["Rillaboom", "Incineroar"]);
check("the meta row shows 30 Pokemon", metaChips().length, 30);
check("the second meta row shows 30 too", document.querySelectorAll(".bd-mon.bd-side-right .bd-import-meta")[0]?.querySelectorAll(".bd-import-chip").length ?? 0, 30);
ok("the meta chips are the top of the ranked list, in order",
  chipNames(metaChips())[0].includes("most common set") && chipNames(metaChips()).length === new Set(chipNames(metaChips())).size);

// The existing button still works: a chip loads that Pokemon into its side.
const monName = (side) => document.querySelector(`.bd-mon.bd-side-${side} .bd-mon-name`)?.textContent.replace(/\s*▾\s*$/, "") || "(no name)";
teamChips()[1]?.click();
await sleep(0);
check("clicking a team chip loads that Pokemon", monName("left"), "Incineroar");

// Another team: the chips follow, the Team Builder's own selection does not.
await pick("team_rain");
check("picking another team swaps the chips", chipNames(teamChips()), ["Pelipper", "Basculegion", "Garchomp"]);
check("both cards' pickers move together", pickers().map(pickerValue), ["team_rain", "team_rain"]);
check("the Team Builder keeps the team it had open", JSON.parse(localStorage.getItem("cbd.builder.v1")).selectedTeamId, "team_my");
check("the pick is saved for the next visit", JSON.parse(localStorage.getItem("cbd.calc.v1")).importTeamId, "team_rain");

// A team with empty slots shows only the slots that hold a Pokemon.
await pick("team_synced");
check("a team saved in the Companion's shape still imports",
  chipNames(teamChips()), ["Indeedee-F", "Arcanine-Hisui"]);
ok("a Pokemon this site does not hold gets no chip", !chipNames(teamChips()).some((name) => /Missingno/i.test(name)));

// An all-empty team says so instead of drawing nothing.
await pick("team_empty");
check("an empty team draws no chips", teamChips().length, 0);
check("and says where to fill it",
  document.querySelectorAll(".bd-mon.bd-side-left .bd-import-empty").map((n) => n.textContent),
  ["This team is empty. Fill it in the Team Builder"]);
check("the meta row is unaffected by an empty team", metaChips().length, 30);

// Deleting the chosen team elsewhere falls back to the team the Builder has open.
writeTeams([MY_TEAM, RAIN_TEAM, SYNCED_TEAM], "team_rain");
await sleep(0);
check("a deleted team falls back to the Team Builder's team", pickers().map(pickerValue), ["team_rain", "team_rain"]);
check("and the chips are that team's", chipNames(teamChips()), ["Pelipper", "Basculegion", "Garchomp"]);

// One saved team, and an empty Box: the picker is still there with that team.
writeTeams([MY_TEAM], "team_my", [{ id: "box_1", name: "Box 1", box: [] }]);
await sleep(0);
check("one saved team still gets a picker", pickers().length, 2);
check("with that one team on it",
  pickerOptions().map((o) => o.textContent), ["My Team"]);
check("and its Pokemon as chips", chipNames(teamChips()), ["Rillaboom", "Incineroar"]);

// The other format: 30 chips there too.
document.body.querySelectorAll("[data-format]").find((b) => b.dataset.format === "Singles").click();
ok("switching format redraws the import rows in Singles",
  await settle(() => document.querySelectorAll(".bd-mon.bd-side-left .bd-import-row")[1]?.textContent.includes("Singles")));
check("the Singles meta row shows 30 Pokemon too", metaChips().length, 30);
check("the team row is unchanged by the format", chipNames(teamChips()), ["Rillaboom", "Incineroar"]);

// A reload keeps the chosen team. (The page that is already up saves its own
// state on every draw, so the team is chosen after its last draw.)
writeTeams([MY_TEAM, RAIN_TEAM], "team_my");
await sleep(0);
localStorage.setItem("cbd.calc.v1", JSON.stringify({ ...JSON.parse(localStorage.getItem("cbd.calc.v1")), importTeamId: "team_rain" }));
await import(`${pageUrl}?reload=1`);
ok("the reloaded page draws its import rows",
  await settle(() => document.querySelectorAll(".bd-import-row").length === 4));
await sleep(60);
check("a reload comes back on the team that was picked", pickers().map(pickerValue), ["team_rain", "team_rain"]);
check("with that team's chips", chipNames(teamChips()), ["Pelipper", "Basculegion", "Garchomp"]);

ok("the page logged no errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

// ------------------------------------------------------------------------ report

if (failures.length) {
  console.log(`\n${failures.length} of ${checked} checks failed:\n`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(failures.length);
}
console.log(`Damage Calculator page: ${checked} checks, all good.`);
process.exit(0);
