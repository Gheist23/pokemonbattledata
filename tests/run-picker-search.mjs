// The "Choose a Pokémon" picker: the Explorer's search language, the "?" beside
// the close button, and what happens when the picker is closed without picking.
//
//   node tests/run-picker-search.mjs
//   node tests/run-picker-search.mjs --verbose
//
// What it holds to:
//
//   1. ONE LANGUAGE, NOT TWO.  builder/search-query.js is the only place the
//      query syntax is written down: app.js (the Explorer) imports it instead of
//      carrying its own copy, so the picker and the search box cannot drift.
//
//   2. EVERY EXAMPLE THE HELP GIVES.  The Advanced Search card names its own
//      examples; each one is run against the real tables and has to find the
//      Pokémon it claims to find, and to leave out one it does not.
//
//   3. A PICKER IS NOT A PAGE.  "rilla" offers Rillaboom, not the hundred
//      Pokémon Rillaboom is most often brought with, while "Fake Out" — nobody's
//      name — still finds everything that can use it.
//
//   4. THE "?" AND THE CLOSE BUTTON.  Both sit at the right of the heading, the
//      "?" first, and what it opens is inside the dialog (a modal dialog is
//      drawn in the browser's top layer, above any popover anchored to the page).
//
//   5. CLOSING THE PICKER WITH NOTHING CHOSEN.  On an empty slot that takes the
//      slot editor with it, and the slot is told the edit was CANCELLED, not
//      that the Pokémon was removed.  On "Change Pokémon" the editor stays.
//
//   6. THE PICKER DOES NOT JUMP.  Its top edge is pinned, so narrowing the list
//      shrinks it downwards instead of sliding it up the screen.
//
// No browser and no network: the DOM below is a stand-in with just enough of
// one for h(), openDialog(), pickPokemon() and editSet()'s empty state.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// --- just enough DOM ------------------------------------------------------------------

class NodeBase {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get children() { return this.childNodes.filter((child) => child instanceof Element); }
  get firstChild() { return this.childNodes[0] || null; }
  append(...nodes) {
    for (const node of nodes.flat(Infinity)) {
      if (node === null || node === undefined || node === false) continue;
      const child = node instanceof NodeBase ? node : new Text(String(node));
      child.parentNode?.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }
  removeChild(node) {
    const at = this.childNodes.indexOf(node);
    if (at >= 0) { this.childNodes.splice(at, 1); node.parentNode = null; }
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  get textContent() { return this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value) { this.childNodes = []; this.append(String(value)); }
  find(test, out = []) {
    for (const child of this.children) { if (test(child)) out.push(child); child.find(test, out); }
    return out;
  }
  querySelectorAll(selector) {
    const test = selector.startsWith(".")
      ? (node) => node.classList.contains(selector.slice(1))
      : (node) => node.tag === selector;
    return this.find(test);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class Text extends NodeBase {
  constructor(text) { super(); this.text = text; }
  get textContent() { return this.text; }
}
class Element extends NodeBase {
  constructor(tag) {
    super();
    this.tag = tag;
    this.attributes = {};
    this.dataset = {};
    this.style = { setProperty() {} };
    this.listeners = new Map();
    this.open = false;
    this.classList = {
      set: new Set(),
      add: (...names) => names.forEach((name) => this.classList.set.add(name)),
      remove: (...names) => names.forEach((name) => this.classList.set.delete(name)),
      contains: (name) => this.classList.set.has(name),
    };
  }
  get className() { return [...this.classList.set].join(" "); }
  set className(value) { this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  // `hidden` is reflected, as it is on a real element: h() sets the attribute
  // and openDialog reads the property.
  get hidden() { return this.attributes.hidden !== undefined; }
  set hidden(value) { if (value) this.attributes.hidden = ""; else delete this.attributes.hidden; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatchEvent(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn({ type, target: this, ...event }); }
  click() { this.dispatchEvent("click", { preventDefault() {}, stopPropagation() {} }); }
  focus() {}
  blur() {}
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatchEvent("close"); }
}

const document = new Element("#document");
document.body = new Element("body");
document.append(document.body);
document.createElement = (tag) => new Element(tag);
document.createTextNode = (text) => new Text(String(text));
globalThis.document = document;
globalThis.Node = NodeBase;
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);

const { BuilderData } = await import("../builder/common.js");
const { openDialog, pickPokemon, editSet, searchHelpCard } = await import("../builder/ui.js");
const language = await import("../builder/search-query.js");

const data = new BuilderData(JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8")));
data.ingestMeta("Doubles", JSON.parse(readFileSync(join(root, "data", "builder", "meta-doubles.json"), "utf8")));
const find = (query, limit = 400) => data.searchSpecies(query, { format: "Doubles", limit }).map((row) => row.label);

// =============================================================================
// 1. one language, not two
// =============================================================================

const appSource = readFileSync(join(root, "app.js"), "utf8");
const MOVED = [
  "parseSearchQuery", "addNameSegments", "parseClause", "isRankFilterField",
  "bestTextMatchScore", "splitListValue", "matchTextValues",
  "categoryForSearchField", "battleNumericFieldName",
  "normalizeField", "compareNumeric", "normalizeForSearch",
];
for (const name of MOVED) {
  ok(`the Explorer does not carry its own ${name}`, !appSource.includes(`function ${name}(`),
    "app.js still defines it, so the picker and the search box can drift apart");
  ok(`and builder/search-query.js exports ${name}`, typeof language[name] === "function");
}
ok("the Explorer takes the language from the shared module",
  /await import\("\/builder\/search-query\.js"\)/.test(appSource), "no dynamic import of the module in app.js");
ok("and it does so before it binds the search box",
  appSource.indexOf("await loadSearchLanguage();") < appSource.indexOf("bindEvents();\n    renderLoadingState();"),
  "the language has to be in hand before the first render");

// The parser answers the same shapes both sides rely on.
same("a plain word is a name query", language.parseSearchQuery("Rillaboom").mode, "name");
same("nothing typed matches everything", language.parseSearchQuery("   ").mode, "empty");
same("a clause makes it an advanced query", language.parseSearchQuery("spe>=100").mode, "advanced");
same("free text and a clause are both kept", language.parseSearchQuery("Fake Out, spe>=100").clauses.map((c) => c.field), ["quick", "spe"]);
same("a rank filter keeps the window and the name apart",
  language.parseSearchQuery("move<=5=Earthquake").clauses[0],
  { field: "move", op: "=", value: "Earthquake", rankOp: "<=", rankValue: 5 });
ok("every operator parses", ["=", ":", ">", "<", ">=", "<="].every((op) =>
  language.parseSearchQuery(`spe${op}100`).clauses[0]?.op === op));

// =============================================================================
// 2. every example the help gives
// =============================================================================

const helpText = searchHelpCard().textContent;
const EXAMPLES = [
  ["Fake Out, spe>=100", "Sneasler", "Torkoal"],
  ["type=Dragon", "Garchomp", "Rillaboom"],
  ["item=Choice Scarf", "Garchomp", "Torkoal"],
  ["move<=5=Earthquake", "Garchomp", "Rillaboom"],
  ["ability=Rough Skin", "Garchomp", "Rillaboom"],
  ["teammate=Garchomp", "Rillaboom", "Wobbuffet"],
];
for (const [query, wanted, notWanted] of EXAMPLES) {
  ok(`the help shows "${query}"`, helpText.includes(query), helpText);
  const rows = find(query);
  ok(`"${query}" finds ${wanted}`, rows.includes(wanted), rows.slice(0, 8).join(", "));
  ok(`"${query}" leaves out ${notWanted}`, !rows.includes(notWanted), rows.slice(0, 8).join(", "));
}
ok("the help names the stats it can compare", /hp.*atk.*def.*spa.*spd.*spe.*bst/s.test(helpText), helpText);
for (const field of ["hp", "atk", "def", "spa", "spd", "spe", "bst"]) {
  ok(`${field} compares as a number`, find(`${field}>=1`).length > 100 && find(`${field}>=100000`).length === 0);
}
{
  // Whoever is fastest in the tables: found by a floor at its own Speed, left
  // out by a ceiling one below it.
  let fastest = { label: "", speed: -1 };
  for (const { row, label } of data.byShowdown.values()) {
    const speed = Number(row.stats?.speed || 0);
    if (speed > fastest.speed) fastest = { label, speed };
  }
  ok("a Speed floor really is a floor", find(`spe>=${fastest.speed}`).includes(fastest.label), `${fastest.label} at ${fastest.speed}`);
  ok("and a Speed ceiling leaves the fast ones out", !find(`spe<=${fastest.speed - 1}`).includes(fastest.label), fastest.label);
}
ok("a rank window is narrower than the whole column",
  find("move=Earthquake").length > find("move<=5=Earthquake").length,
  `${find("move=Earthquake").length} against ${find("move<=5=Earthquake").length}`);
ok("a top-only field is narrower again",
  find("topmove=Fake Out").length > 0 && find("topmove=Fake Out").length < find("move=Fake Out").length);
ok("two clauses are both applied",
  find("type=Dragon, spe>=120").every((name) => find("type=Dragon").includes(name) && find("spe>=120").includes(name)));

// =============================================================================
// 3. a picker is not a page
// =============================================================================

same("a name finds that Pokémon and nothing that merely stands next to it", find("rilla"), ["Rillaboom"]);
ok("a type still comes with the names it is part of", find("dragon").includes("Dragonite") && find("dragon").includes("Garchomp"));
ok("an Ability is found by name", find("grassy surge").includes("Rillaboom"));
ok("a move nobody is named after finds everything that learns it",
  find("fake out").includes("Rillaboom") && find("fake out").includes("Incineroar") && find("fake out").length > 20);
ok("an empty query is the whole ladder in order", find("", 6).length === 6);
same("and it starts at the top of the meta", find("", 1), ["Rillaboom"]);
ok("every spelling of a name still works",
  ["alolan ninetales", "ninetales-alola", "Ninetales-Alola"].every((query) => find(query).includes("Ninetales-Alola")));
same("including a second ladder name for one app form", find("Squawkabilly-Yellow"), ["Squawkabilly"]);

// =============================================================================
// 4. the "?" and the close button
// =============================================================================

{
  const { dialog, close } = openDialog({ title: "Choose a Pokémon", body: new Element("div"), help: searchHelpCard() });
  const head = dialog.querySelector(".bd-dialog-head");
  const actions = head.querySelector(".bd-dialog-head-actions");
  ok("the heading has an actions group", Boolean(actions));
  const buttons = actions.children;
  same("with two buttons in it", buttons.length, 2);
  same("the ? comes first", buttons[0].textContent, "?");
  same("and the close button second", buttons[1].textContent, "×");
  same("the close button still says what it does", buttons[1].getAttribute("aria-label"), "Close");
  ok("the ? says what it does too", (buttons[0].getAttribute("aria-label") || "").length > 8, buttons[0].getAttribute("aria-label"));
  const panel = dialog.querySelector(".bd-dialog-help");
  ok("the help is inside the dialog, not floating over the page", Boolean(panel) && panel.find(() => true, []).length >= 0);
  ok("and it starts hidden", panel.getAttribute("hidden") === "" || panel.hidden === true);
  buttons[0].click();
  ok("the ? opens it", panel.hidden === false, String(panel.hidden));
  same("and says so", buttons[0].getAttribute("aria-expanded"), "true");
  buttons[0].click();
  ok("pressing it again closes it", panel.hidden === true);
  same("and says that too", buttons[0].getAttribute("aria-expanded"), "false");
  close();
}
{
  // A dialog with nothing to explain gets no "?" at all.
  const { dialog, close } = openDialog({ title: "Plain", body: new Element("div") });
  same("a dialog with no help has one heading button", dialog.querySelector(".bd-dialog-head-actions").children.length, 1);
  ok("and no help panel", !dialog.querySelector(".bd-dialog-help"));
  close();
}

// The picker itself asks for the help.
{
  const picking = pickPokemon(data, { format: "Doubles" });
  const dialog = document.body.querySelector(".bd-dialog-picker");
  ok("the picker opened", Boolean(dialog));
  ok("and it carries the ?", dialog.querySelector(".bd-dialog-help-button")?.textContent === "?");
  ok("which says it is about searching",
    /search/i.test(dialog.querySelector(".bd-dialog-help-button")?.getAttribute("aria-label") || ""),
    dialog.querySelector(".bd-dialog-help-button")?.getAttribute("aria-label"));
  ok("and its search box says more than a name will do",
    /move|ability|spe/i.test(dialog.querySelector("input")?.getAttribute("placeholder") || ""),
    dialog.querySelector("input")?.getAttribute("placeholder"));
  dialog.close();
  same("closing it without choosing gives nothing back", await picking, null);
}

// =============================================================================
// 5. closing the picker with nothing chosen
// =============================================================================

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

{
  // An empty slot: the editor opens the picker itself, and the two go together.
  const editing = editSet(data, null, { format: "Doubles", title: "Slot 1" });
  await settle();
  await settle();
  const picker = document.body.querySelector(".bd-dialog-picker");
  const editor = document.body.querySelector(".bd-dialog-editor");
  ok("an empty slot opens the picker on top of the editor", Boolean(picker) && Boolean(editor));
  ok("and the editor is the one that says how to start",
    /Pick a Pokémon to start/.test(editor.textContent), editor.textContent.slice(0, 60));
  picker.close();
  await settle();
  await settle();
  ok("closing the picker with nothing chosen closes the editor too", editor.open === false, "the editor stayed open");
  same("and the slot is told the edit was cancelled, not emptied", await editing, undefined);
  same("nothing is left on the page", document.body.querySelectorAll(".bd-dialog").length, 0);
}
{
  // "Change Pokémon" on a Pokémon that is already there: the editor stays.
  const set = { species: "Rillaboom", form: "Rillaboom", item: "", ability: "Grassy Surge", moves: [], nature: "Adamant", bonuses: [0, 0, 0, 0, 0, 0] };
  const editing = editSet(data, set, { format: "Doubles", title: "Edit Rillaboom" });
  await settle();
  await settle();
  const editor = document.body.querySelector(".bd-dialog-editor");
  ok("an occupied slot does not open the picker by itself", !document.body.querySelector(".bd-dialog-picker"));
  const change = editor.find((node) => node.tag === "button" && node.textContent === "Change Pokémon")[0];
  ok("it offers Change Pokémon", Boolean(change));
  change.click();
  await settle();
  const picker = document.body.querySelector(".bd-dialog-picker");
  ok("which opens the picker", Boolean(picker));
  picker.close();
  await settle();
  await settle();
  ok("and closing that picker leaves the editor open", editor.open === true, "the editor closed with it");
  editor.close();
  same("so cancelling it is still a cancel", await editing, undefined);
}

// =============================================================================
// 6. the picker does not jump
// =============================================================================

const css = readFileSync(join(root, "builder", "builder.css"), "utf8");
// The rule that pins it is the one that also lets the bottom move; a second
// copy inside a media query must not be able to stand in for it.
const pickerRule = css.match(/\.bd-dialog-picker\s*\{[^}]*margin-bottom:\s*auto[^}]*\}/)?.[0] || "";
ok("the picker has a rule that lets its bottom edge move", Boolean(pickerRule), "no .bd-dialog-picker rule with margin-bottom: auto");
ok("and the same rule pins its top", /margin-top:\s*\d/.test(pickerRule), pickerRule || "(no rule)");
ok("the list is still allowed to shrink", /\.bd-dialog-picker \.bd-pick-list \{[^}]*max-height/.test(css));
ok("the heading's buttons sit in a row", /\.bd-dialog-head-actions \{[^}]*display:\s*flex/.test(css));

// =============================================================================
// 7. an evaluation that just ran is not called out of date
// =============================================================================

const page = readFileSync(join(root, "builder", "builder-page.js"), "utf8");
ok("runEvaluation files its result under the team as it is now",
  /async function runEvaluation\(key = evaluationKey\(\)\)/.test(page),
  "a caller that passes no key would file the result under `undefined`, and the panel would ask to evaluate changes that were never made");

// =============================================================================

console.log(`\n${checked} checks, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exit(1);
}
console.log("picker search: OK");
process.exit(0);
