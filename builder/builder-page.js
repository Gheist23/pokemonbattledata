// Team Builder page.
//
//   left    the six slots of the selected team (click to edit, drag to reorder)
//   centre  Team Overview · Box · Team Evaluation · Auto Build · Import / Export
//   right   the team library
//
// Everything is saved in the browser in the Companion's own format and can be
// synced with the app through a sync code (builder/sync.js).  Team Evaluation
// and Auto Build run in builder/analysis-worker.js.

import {
  ARCHETYPES,
} from "./analysis.js";
import {
  checksView, openChecksDialog, openPressureDialog, openSettingsDialog, openSpeedDialog, openSynergyDialog, speedTiersView, speedView, suggestionsView, threatsView,
} from "./evaluation-view.js";
import { AUTO_BUILD_ARCHETYPES, archetypeDescription, archetypeDisplay, archetypeKey } from "./autobuild-archetype.js";
import { TeamChecks } from "./team-checks.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "./team-eval.js";
import {
  BuilderData, STAT_LABELS, TEAM_SIZE, boxEntryToSet, isEmptySet, makeSet, parseShowdown,
  setFromCommon, setToBoxEntry, setToShowdown,
} from "./common.js";
import {
  addBox, addToBox, currentBox, currentTeam, deleteBox, deleteTeam, duplicateTeam, getState, newTeam,
  removeFromBox, renameBox, renameTeam, replaceBoxEntry, selectBox, selectTeam, setFormat, setOverviewTop, setSetting, setSlot, setTeamSets,
  subscribe, swapSlots, teamSets,
} from "./store.js";
import { activate, canRun, deactivate, freeRunsLeft, isPro, licenceSummary, recordRun, refreshLicence } from "./pro.js";
import { resetTournamentView, tournamentAnalysis, tournamentExplainer, tournamentProgress } from "./tournament-view.js";
import { clear, confirmDialog, editSet, h, openDialog, problemCard, scoreRing, segmented, select, sprite, switchRow, toast, typeChip } from "./ui.js";
import { initSync, openSyncDialog, syncStatus, onSyncStatus } from "./sync.js";
import { OPTIMIZE_DEFAULTS, optimizeView, updateProgress } from "./optimize-view.js";

const root = document.getElementById("builderApp");
let data;
let worker;
let requestId = 0;
const pending = new Map();

const view = {
  tab: "overview",
  overviewTab: "offense",
  evalTab: "checks",
  overview: null,
  overviewKey: "",
  overviewBusy: false,
  overviewError: null,
  evaluation: null,
  evaluationKey: "",
  evaluating: false,
  evalError: "",
  evalProgress: 0,
  evalStatus: "",
  speedState: { weather: "None", own_tailwind: false, opposing_tailwind: false, trick_room: false, our_stage: 0, opponent_stage: 0 },
  speedTiers: null,
  speedTiersKey: "",
  speedTiersBusy: "",
  speedTiersError: null,
  suggestions: null,
  suggesting: false,
  suggestProgress: 0,
  suggestStatus: "",
  suggestError: "",
  // Suggestions: All Pokémon or Only Box, the running request (its Team Evaluation
  // checks arrive after the list), the team and settings it was run for (evaluationKey),
  // which rows are open and which show every reason.
  suggestScope: "all",
  suggestRequest: 0,
  suggestKey: "",
  suggestUi: { open: new Set(), all: new Set() },
  suggestHost: null,
  optimize: {},
  auto: { running: false, stopping: false, requestId: 0, fraction: 0, status: "", result: null, error: "", keep: true, onlyBox: false, depth: "deep", archetype: "automatic", prioritizeMeta: false },
  tour: { running: false, stopping: false, limit: 1000, snapshot: null, error: "", requestId: 0, key: "", host: null, paintQueued: false, runFormat: "" },
  libraryQuery: "",
  libraryFilter: "All",
  dragSlot: null,
  dragBox: null,
};

const hosts = {};

// --- worker ------------------------------------------------------------------------

function analysis(type, payload, onProgress) {
  if (!worker) {
    try {
      worker = new Worker(new URL("./analysis-worker.js", import.meta.url), { type: "module" });
    } catch (error) {
      console.error(error);
      return Promise.reject(new Error("This browser cannot run the analysis in the background. Update it, or use a current Chrome, Edge, Firefox or Safari."));
    }
    worker.addEventListener("message", (event) => {
      const { id, ok, result, error, progress } = event.data || {};
      const entry = pending.get(id);
      if (!entry) return;
      if (progress !== undefined) {
        entry.onProgress?.(progress);
        return;
      }
      pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error));
    });
    worker.addEventListener("error", (event) => {
      for (const entry of pending.values()) entry.reject(new Error(event.message || "Analysis worker failed"));
      pending.clear();
      worker = null;
    });
  }
  const id = ++requestId;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, payload });
  });
  promise.requestId = id;
  return promise;
}

/** Ask the worker to stop a long request (it answers with what it has so far). */
function cancelAnalysis(id) {
  if (worker && id) worker.postMessage({ type: "cancel", payload: { target: id } });
}

// --- helpers ---------------------------------------------------------------------------

function format() {
  return getState().format;
}

function sets() {
  return teamSets(currentTeam(), data);
}

function plainSets(list = sets()) {
  return list.map((set) => (isEmptySet(set) ? null : { species: set.species, form: set.form, item: set.item, ability: set.ability, moves: set.moves, nature: set.nature, bonuses: set.bonuses }));
}

function teamKey(list = sets()) {
  return `${format()}|${JSON.stringify(plainSets(list))}`;
}

/** The name a set battles under (its Mega's name when the stone applies), in Showdown spelling. */
function name(set) {
  return data.setName(set);
}

/** The Team Evaluation settings, as saved on this device (Top X at most every ranked Pokémon). */
function evalSettings() {
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...(getState().settings.evaluation || {}) }, metaCount() || 1000);
}

/** The saved Team Building Checks selection (null = every check, as in the app). */
function checkSelection() {
  const saved = getState().settings.teamChecks;
  return Array.isArray(saved) ? saved : null;
}

function evaluationKey(list = sets()) {
  return `${teamKey(list)}|${JSON.stringify(evalSettings())}|${JSON.stringify(checkSelection())}`;
}

function spriteFor(species, form, item = "") {
  const [s, f] = data.resolve(species, form || species);
  return data.sprite(s || species, f || form || species, item);
}

function openEvaluationSettings() {
  const checks = new TeamChecks({ engine: data.engine });
  const total = checks.checkList().length;
  openSettingsDialog(evalSettings(), (next) => {
    setSetting("evaluation", normalizeSettings(next, metaCount() || 1000));
    toast("Settings saved. They apply the next time you run an analysis.");
  }, {
    maxTopMeta: metaCount() || 262,
    onCustomizeChecks: openCustomizeChecks,
    checksSummary: () => `${checks.selectedIds(checkSelection()).size} of ${total} in use`,
  });
}

function openCustomizeChecks(onSaved) {
  // The format picks the descriptions (Singles skips Spread Damage and says so).
  const checks = new TeamChecks({ engine: data.engine, format: format() });
  openChecksDialog(checks.checkList(), checks.selectedIds(checkSelection()), (ids) => {
    setSetting("teamChecks", ids);
    toast("Team Building Checks updated. Run the evaluation again to apply them.");
    if (typeof onSaved === "function") onSaved();
  });
}

function allBoxSets() {
  return getState().boxes.flatMap((box) => box.box.map((entry) => boxEntryToSet(entry, data))).filter((set) => set.species);
}

// --- rendering -------------------------------------------------------------------------------

function mount() {
  clear(root);
  hosts.toolbar = h("div", { class: "bd-toolbar", role: "tablist", "aria-label": "Team Builder sections" });
  hosts.team = h("section", { class: "bd-team-col", "aria-label": "Team" });
  hosts.main = h("section", { class: "bd-card bd-main", "aria-live": "polite" });
  hosts.library = h("aside", { class: "bd-card bd-library", "aria-label": "Saved teams" });
  root.append(hosts.toolbar, h("div", { class: "bd-builder" }, hosts.team, hosts.main, hosts.library));
}

function renderAll() {
  renderToolbar();
  renderTeam();
  renderMain();
  renderLibrary();
  syncFormatSwitch();
}

function renderToolbar() {
  const tabs = [
    ["overview", "Team Overview"],
    ["box", "Box"],
    ["evaluation", "Team Evaluation"],
    ["auto", "Auto Build"],
    ["tournament", "Tournament Test"],
    ["io", "Import / Export"],
  ];
  const status = syncStatus();
  clear(hosts.toolbar).append(
    ...tabs.map(([id, label]) => h("button", {
      type: "button",
      class: `bd-tab ${view.tab === id ? "on" : ""}`,
      role: "tab",
      "aria-selected": view.tab === id ? "true" : "false",
      onclick: () => { view.tab = id; renderAll(); },
    }, label)),
    h("button", { type: "button", class: "bd-tab", onclick: openEvaluationSettings, title: "Settings for Team Evaluation, Suggestions, Optimize, Auto Build and the Tournament Test" }, "Settings"),
    h("span", { class: "bd-spacer" }),
    h("button", { type: "button", class: "bd-tab", onclick: () => openSyncDialog(data) }, "Sync with Companion"),
    h("button", { type: "button", class: `bd-tab ${isPro() ? "on" : ""}`, onclick: openProDialog }, isPro() ? "Pro ✓" : "Get Pro"),
    h("span", { class: `bd-sync-state ${status.tone}` }, status.text),
  );
}

// ---- team slots ----

function renderTeam() {
  const list = sets();
  clear(hosts.team);
  hosts.team.append(h("div", { class: "bd-panel-head" },
    h("div", {}, h("h2", {}, currentTeam().title), h("p", {}, `${list.filter((s) => s.species).length}/6 · ${currentTeam().archetype || "Balanced"} · ${format()}`))));
  list.forEach((set, index) => {
    try {
      hosts.team.append(slotCard(set, index));
    } catch (error) {
      console.error(error);
      hosts.team.append(h("div", { class: "bd-slot bd-slot-broken" },
        h("span", {}, `Slot ${index + 1}: ${set.species || "this Pokémon"} could not be shown.`),
        h("button", { type: "button", class: "ghost-button compact", onclick: () => setSlot(index, makeSet(), data) }, "Clear slot")));
    }
  });
}

function slotCard(set, index) {
  const edit = async () => {
    const result = await editSet(data, set.species ? set : makeSet(), { format: format(), title: set.species ? `Edit ${name(set)}` : `Slot ${index + 1}` });
    if (result === undefined) return;
    if (result === null) setSlot(index, makeSet(), data);
    else setSlot(index, result, data);
  };
  const dropHandlers = {
    ondragover: (event) => { event.preventDefault(); event.currentTarget.classList.add("drop-target"); },
    ondragleave: (event) => event.currentTarget.classList.remove("drop-target"),
    ondrop: (event) => {
      event.preventDefault();
      event.currentTarget.classList.remove("drop-target");
      if (view.dragSlot !== null && view.dragSlot !== index) swapSlots(view.dragSlot, index);
      else if (view.dragBox) setSlot(index, view.dragBox, data);
      view.dragSlot = null;
      view.dragBox = null;
    },
  };
  if (!set.species) {
    return h("button", { type: "button", class: "bd-slot bd-slot-empty", onclick: edit, ...dropHandlers }, h("span", {}, `+ Add Pokémon (slot ${index + 1})`));
  }
  const types = data.types(set.species, set.form, set.item);
  const stats = data.engine.finalStats({ pokemon_name: set.species, form_name: set.form, item: set.item, nature_name: set.nature, bonuses: set.bonuses });
  const [up, down] = data.natures[set.nature] || ["", ""];
  const card = h("div", {
    class: "bd-slot",
    role: "button",
    tabindex: "0",
    draggable: "true",
    "aria-label": `Edit ${name(set)}`,
    onclick: (event) => { if (!event.target.closest(".bd-slot-tools")) edit(); },
    onkeydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); edit(); } },
    ondragstart: () => { view.dragSlot = index; view.dragBox = null; },
    ...dropHandlers,
  },
  h("div", { class: "bd-slot-art" }, sprite(data.sprite(set.species, set.form, set.item), "", 60)),
  h("div", { class: "bd-slot-main" },
    h("span", { class: "bd-slot-name" }, name(set)),
    h("div", { class: "bd-type-row" }, types.map(typeChip)),
    h("span", { class: "bd-slot-ability" }, data.battleForm(set.species, set.form, set.item)[2] && data.battleForm(set.species, set.form, set.item)[1] !== set.form ? data.battleForm(set.species, set.form, set.item)[2] : set.ability || "—"),
    set.item ? h("span", { class: "bd-slot-sub" }, data.itemIcon(set.item) ? h("img", { src: data.itemIcon(set.item), alt: "", width: 16, height: 16 }) : null, h("span", {}, set.item)) : h("span", { class: "bd-slot-sub" }, "No item"),
    h("div", { class: "bd-slot-stats", "aria-label": "Stats" }, ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"].map((k, i) => {
      const short = ["HP", "ATK", "DEF", "SPA", "SPD", "SPE"][i];
      const color = stats[k] >= 180 ? "var(--stat-great)" : stats[k] >= 140 ? "var(--stat-good)" : stats[k] >= 100 ? "var(--stat-mid)" : "var(--stat-bad)";
      return h("span", { class: "bd-mini-stat" }, h("span", { style: { color: short === up ? "#ff9a9a" : short === down ? "#9ec9ff" : "" } }, STAT_LABELS[i]), h("span", {}, stats[k]), h("i", { style: { width: `${Math.min(100, (stats[k] / (k === "hp" ? 260 : 230)) * 100)}%`, background: color } }));
    }))),
  h("div", { class: "bd-slot-moves" }, [0, 1, 2, 3].map((i) => h("span", { class: "bd-slot-move" }, set.moves[i] || "—"))),
  h("div", { class: "bd-slot-tools" },
    h("button", { type: "button", class: "bd-mini-button", title: "Open in the Damage Calculator", "aria-label": `Open ${name(set)} in the Damage Calculator`, onclick: () => openInCalc(set) }, "⚔"),
    h("button", { type: "button", class: "bd-mini-button", title: "Copy to Box", "aria-label": `Copy ${name(set)} to the Box`, onclick: () => { addToBox([setToBoxEntry(set, data)]); toast(`${name(set)} copied to ${currentBox().name}`); } }, "⇩"),
    h("button", { type: "button", class: "bd-mini-button", title: "Remove from team", "aria-label": `Remove ${name(set)} from the team`, onclick: () => setSlot(index, makeSet(), data) }, "×")));
  return card;
}

function openInCalc(set, side = "left") {
  try {
    const saved = JSON.parse(localStorage.getItem("cbd.calc.v1") || "null");
    if (saved && saved.mons) {
      saved.mons[side] = { set: JSON.parse(JSON.stringify(set)), hp: 100, stages: { attack_stage: 0, defense_stage: 0, sp_attack_stage: 0, sp_defense_stage: 0, speed_stage: 0 }, status: "", gender: "Unspecified" };
      saved.selectedSide = "";
      saved.selectedIndex = -1;
      saved.format = format();
      localStorage.setItem("cbd.calc.v1", JSON.stringify(saved));
      location.href = "/damage-calculator/";
      return;
    }
  } catch {
    // fall through to the URL form
  }
  location.href = `/damage-calculator/?attacker=${encodeURIComponent(set.form || set.species)}&format=${format()}`;
}

// ---- library ----

function renderLibrary() {
  const state = getState();
  const query = view.libraryQuery.trim().toLowerCase();
  const teams = state.teams.filter((team) => {
    if (view.libraryFilter !== "All" && (team.archetype || "Balanced") !== view.libraryFilter) return false;
    if (!query) return true;
    const text = `${team.title} ${team.team.map((e) => e[0]).join(" ")}`.toLowerCase();
    return text.includes(query);
  });
  const search = h("input", { type: "search", class: "bd-search", placeholder: "Search teams…", value: view.libraryQuery, "aria-label": "Search teams" });
  search.addEventListener("input", () => { view.libraryQuery = search.value; rerenderLibraryList(); });
  const filter = select(["All", ...ARCHETYPES.filter((a) => a !== "Auto")], view.libraryFilter, (value) => { view.libraryFilter = value; renderLibrary(); }, { "aria-label": "Filter by archetype" });
  const listHost = h("div", { class: "bd-library-list" });
  const rerenderLibraryList = () => {
    const q = view.libraryQuery.trim().toLowerCase();
    renderLibraryList(listHost, state.teams.filter((team) => (view.libraryFilter === "All" || (team.archetype || "Balanced") === view.libraryFilter) && (!q || `${team.title} ${team.team.map((e) => e[0]).join(" ")}`.toLowerCase().includes(q))));
  };
  renderLibraryList(listHost, teams);
  clear(hosts.library).append(
    h("div", { class: "bd-panel-head" }, h("div", {}, h("h2", {}, "Teams"), h("p", {}, `${state.teams.length} saved`)),
      h("button", { type: "button", class: "primary-button compact", onclick: () => { newTeam(); view.tab = "overview"; } }, "New Team")),
    h("div", { class: "bd-library-actions" },
      h("button", { type: "button", class: "ghost-button compact", onclick: () => duplicateTeam(currentTeam().id) }, "Duplicate"),
      h("button", { type: "button", class: "ghost-button compact", onclick: () => { view.tab = "io"; renderAll(); } }, "Import / Export"),
      h("button", { type: "button", class: "ghost-button compact", onclick: () => addTeamToBox() }, "Team → Box"),
      h("button", { type: "button", class: "ghost-button compact bd-danger-text", onclick: async () => {
        if (await confirmDialog(`Delete “${currentTeam().title}”? This cannot be undone.`, { confirmLabel: "Delete team" })) deleteTeam(currentTeam().id);
      } }, "Delete")),
    h("div", { class: "bd-team-meta" }, search, filter),
    listHost);
}

function renderLibraryList(host, teams) {
  const state = getState();
  clear(host);
  if (!teams.length) host.append(h("p", { class: "bd-empty" }, "No teams match."));
  for (const team of teams) {
    host.append(h("button", {
      type: "button",
      class: `bd-library-item ${team.id === state.selectedTeamId ? "selected" : ""}`,
      "aria-pressed": team.id === state.selectedTeamId ? "true" : "false",
      onclick: () => { selectTeam(team.id); },
    },
    h("strong", {}, team.title),
    h("small", {}, team.archetype || "Balanced"),
    h("span", { class: "bd-library-sprites" }, team.team.map((entry) => {
      if (!entry[0]) return h("span", { style: { width: "32px" } });
      const [species, form] = data.resolve(entry[0], entry[2] || entry[0]);
      return sprite(data.sprite(species, form, entry[1]), "", 32);
    }))));
  }
}

function addTeamToBox() {
  const list = sets().filter((set) => set.species);
  if (!list.length) return toast("This team is empty.");
  addToBox(list.map((set) => setToBoxEntry(set, data)));
  toast(`${list.length} Pokémon added to ${currentBox().name}`);
}

// ---- main panel ----

function renderMain() {
  clear(hosts.main);
  // On phones the analysis tabs show their results above the team column (builder.css).
  if (hosts.main.parentElement) hosts.main.parentElement.dataset.tab = view.tab;
  try {
    if (view.tab === "overview") renderOverview();
    else if (view.tab === "box") renderBox();
    else if (view.tab === "evaluation") renderEvaluation();
    else if (view.tab === "auto") renderAuto();
    else if (view.tab === "tournament") renderTournament();
    else if (view.tab === "io") renderImportExport();
  } catch (error) {
    console.error(error);
    clear(hosts.main).append(problemCard("This view hit a problem",
      `${String(error?.message || error || "Unknown error").split("\n")[0]}. Resetting clears the results kept for this team; your teams and Box are not touched.`,
      { actionLabel: "Reset this view", onAction: () => { resetResults(); renderMain(); } }));
  }
}

/** Forget every calculated result (not the teams): the way out of a result that cannot be shown. */
function resetResults() {
  Object.assign(view, {
    overview: null, overviewKey: "", overviewBusy: false, overviewError: null,
    evaluation: null, evaluationKey: "", evalError: "",
    speedTiers: null, speedTiersKey: "", speedTiersBusy: "", speedTiersError: null,
    suggestions: null, suggestError: "", optimize: {},
  });
  view.auto.result = null;
  view.auto.error = "";
  for (const shelf of Object.values(formatShelves)) for (const k of Object.keys(shelf)) delete shelf[k];
  if (!view.tour.running) {
    view.tour.snapshot = null;
    view.tour.error = "";
    try {
      sessionStorage.removeItem(TOURNAMENT_STORE);
    } catch {
      // ignore
    }
  }
  forgetEvaluation();
}

function renderOverview() {
  if (!["offense", "defense", "speed"].includes(view.overviewTab)) view.overviewTab = "offense";
  const team = currentTeam();
  const titleInput = h("input", { type: "text", class: "bd-input", value: team.title, maxlength: 80, "aria-label": "Team title" });
  titleInput.addEventListener("change", () => renameTeam(team.id, titleInput.value.trim() || team.title));
  const archetype = select(ARCHETYPES.filter((a) => a !== "Auto"), team.archetype || "Balanced", (value) => renameTeam(team.id, undefined, value), { "aria-label": "Archetype" });
  hosts.main.append(
    h("div", { class: "bd-team-meta" },
      h("label", { class: "bd-field" }, h("span", {}, "Title"), titleInput),
      h("label", { class: "bd-field" }, h("span", {}, "Archetype"), archetype)),
    h("div", { class: "bd-overview-bar" },
      h("div", { class: "bd-subtabs", role: "tablist", "aria-label": "Overview" },
        [["offense", "Offense"], ["defense", "Defense"], ["speed", "Speed"]].map(([id, label]) => h("button", {
          type: "button",
          class: `bd-tab ${view.overviewTab === id ? "on" : ""}`,
          role: "tab",
          "aria-selected": view.overviewTab === id ? "true" : "false",
          onclick: () => { view.overviewTab = id; renderMain(); },
        }, label))),
      topMetaControl()));
  const key = overviewKey();
  if (view.overviewTab === "speed") {
    const body = h("div", { class: "bd-overview" });
    hosts.main.append(body);
    body.append(speedTiersPanel("Speed Tiers"));
    return;
  }
  if (view.overviewError?.key === key) {
    hosts.main.append(problemCard("The overview could not be calculated", view.overviewError.message, { onAction: () => { view.overviewError = null; renderMain(); } }));
    return;
  }
  if (view.overviewKey !== key) {
    requestOverview(key);
    if (!view.overview) {
      hosts.main.append(h("div", { class: "bd-loading" }, h("span", { class: "bd-spinner" }), "Scoring the team against the meta…"));
      return;
    }
  }
  const overviewData = view.overview;
  const body = h("div", { class: `bd-overview ${view.overviewKey !== key ? "bd-stale" : ""}` });
  hosts.main.append(body);
  if (overviewData.empty) {
    body.append(h("div", { class: "bd-gate" }, h("h3", {}, "Start with one Pokémon"), h("p", {}, "Add a Pokémon to a slot on the left, pick one from your Box, or let Auto Build fill the team."),
      h("div", { class: "bd-gate-actions" }, h("button", { type: "button", class: "primary-button", onclick: () => hosts.team.querySelector(".bd-slot")?.click() }, "Add a Pokémon"), h("button", { type: "button", class: "ghost-button", onclick: () => { view.tab = "auto"; renderAll(); } }, "Auto Build"))));
    return;
  }
  const top = overviewData.top_x || overviewTop();
  if (view.overviewTab === "offense") {
    const into = `Our coverage into Top ${top} Meta`;
    body.append(typeChartSection(`Average Type Chart: ${into}.`, "The average type multiplier of each attacking type the team carries, against the Top Meta's typings. Higher values are better.", chartRows(overviewData.offense_chart), "multiplier"));
    body.append(typeChartSection(`Average Pressure: ${into}.`, "Every damaging move the team carries, scored by type multiplier, power and STAB against the Top Meta, averaged per type. Higher values are better.", pressureRows(overviewData.team_to_meta), "pressure"));
  } else if (view.overviewTab === "defense") {
    const into = `Top ${top} Meta into Our Team`;
    body.append(typeChartSection(`Average Type Chart: ${into}.`, "How each attacking type lands on this team on average. Lower values are better.", chartRows(overviewData.defense_chart), "multiplier", true));
    body.append(typeChartSection(`Average Pressure: ${into}.`, "Every damaging move on the Top Meta's most common sets, scored by type multiplier, power and STAB against this team, averaged per type. Lower values are better.", pressureRows(overviewData.meta_to_team), "pressure", true));
    body.append(weaknessTable(overviewData.weaknesses || {}));
  }
}

/** The app's ranked Speed Tiers list: our team plus the Top-X meta, with sprites. */
/**
 * @param {string} title
 * @param {"overview"|"evaluation"} place  the Team Overview's list follows its "Top N Meta";
 *   the Team Evaluation's follows the Top X from Settings, like everything else on that tab
 */
function speedTiersPanel(title = "Speed Tiers", place = "overview") {
  const topX = place === "evaluation" ? evalSettings().top_meta : overviewTop();
  const state = { ...view.speedState, top_x: topX };
  const key = `${teamKey()}|${JSON.stringify(state)}`;
  const failed = view.speedTiersError?.key === key ? view.speedTiersError.message : "";
  if (view.speedTiersKey !== key && !failed) requestSpeedTiers(key, state);
  const stale = view.speedTiersKey !== key;
  const panel = speedTiersView(stale ? null : view.speedTiers, state, {
    spriteFor,
    title,
    topSource: place === "evaluation" ? "the Top X in Settings" : "“Top N Meta” above",
    error: failed,
    onRetry: () => { view.speedTiersError = null; renderMain(); },
    onState: (next) => {
      const { top_x: _topX, ...rest } = next;
      view.speedState = rest;
      renderMain();
    },
  });
  return panel;
}

function requestSpeedTiers(key, state) {
  if (view.speedTiersBusy === key) return;
  view.speedTiersBusy = key;
  analysis("speedTiers", { format: format(), sets: plainSets(), settings: evalSettings(), state }).then((result) => {
    if (view.speedTiersBusy !== key) return;
    const members = sets();
    for (const row of result.rows || []) {
      // Our rows name the Mega after the holder's own form (a female Meowstic is Meowstic-F-Mega).
      const member = row.ours ? members.find((s) => s.species === row.species && (s.item || "") === (row.item || "")) : null;
      row.name = data.displayName(row.species, row.form, member?.form || "") || row.name;
    }
    view.speedTiers = result;
    view.speedTiersKey = key;
    view.speedTiersBusy = "";
    if ((view.tab === "overview" && view.overviewTab === "speed") || (view.tab === "evaluation" && view.evalTab === "speed")) renderMain();
  }).catch((error) => {
    view.speedTiersBusy = "";
    console.error(error);
    view.speedTiersError = { key, message: String(error?.message || error || "Unknown error").split("\n")[0] };
    if ((view.tab === "overview" && view.overviewTab === "speed") || (view.tab === "evaluation" && view.evalTab === "speed")) renderMain();
  });
}

/** How many Pokémon the current format's meta ranks (the most the Top-X can be). */
function metaCount(fmt = format()) {
  const rows = data?.meta?.[fmt]?.pokemon;
  return rows ? Math.max(1, rows.filter((r) => Number(r.position) < 999999).length) : 0;
}

/**
 * The Team Overview's Top-X: how many ranked Pokémon the Offense, Defense and Speed
 * overviews are scored against. Clamped when read, so a smaller format keeps the choice.
 */
function overviewTop() {
  const saved = Number.parseInt(getState().settings.overviewTop, 10) || 30;
  const max = metaCount();
  return Math.max(1, max ? Math.min(max, saved) : saved);
}

function chooseOverviewTop(value) {
  setOverviewTop(value);
  renderMain();
}

/** "Top N Meta ▾": any number from 1 to the ranked count.
 *
 *  A native select would drop a list of all 262 numbers down the whole screen,
 *  so the list is drawn here instead and kept to a few rows high, scrolled to
 *  the number in use.
 */
function topMetaControl() {
  const current = overviewTop();
  const max = metaCount() || current;
  if (!metaCount()) data.loadMeta(format()).then(() => renderMain()).catch(() => {});

  const panel = h("div", { class: "bd-topx-panel", role: "listbox", hidden: true, "aria-label": `How many ranked ${format()} Pokémon the overviews use (1 to ${max})` },
    ...Array.from({ length: max }, (_, index) => {
      const value = index + 1;
      return h("button", {
        type: "button", class: `bd-topx-option ${value === current ? "on" : ""}`, role: "option",
        "aria-selected": value === current ? "true" : "false", "data-value": String(value),
        onclick: () => chooseOverviewTop(value),
      }, `Top ${value}`);
    }));

  const button = h("button", {
    type: "button", class: "bd-tab bd-topx", "aria-haspopup": "listbox", "aria-expanded": "false",
    title: `Score the Offense, Defense and Speed overviews against the ${current} highest-ranked ${format()} Pokémon`,
    onclick: (event) => { event.stopPropagation(); toggleTopMetaPanel(panel); },
    onkeydown: (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      toggleTopMetaPanel(panel, true);
      panel.querySelector(".bd-topx-option.on")?.focus();
    },
  }, h("span", {}, `Top ${current} Meta`), h("span", { class: "bd-topx-caret", "aria-hidden": "true" }, "▾"));

  return h("div", { class: "bd-topx-wrap" }, button, panel);
}

/** Opens or closes the Top-X list; only one is ever open, and Escape closes it. */
function toggleTopMetaPanel(panel, forceOpen = false) {
  const open = forceOpen || panel.hidden;
  for (const other of document.querySelectorAll(".bd-topx-panel")) {
    if (other !== panel) {
      other.hidden = true;
      other.previousElementSibling?.setAttribute("aria-expanded", "false");
    }
  }
  panel.hidden = !open;
  panel.previousElementSibling?.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) return;
  panel.querySelector(".bd-topx-option.on")?.scrollIntoView({ block: "center" });
  const close = (event) => {
    if (panel.contains(event.target) || panel.previousElementSibling?.contains(event.target)) return;
    panel.hidden = true;
    panel.previousElementSibling?.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", close);
  };
  document.addEventListener("click", close);
  panel.onkeydown = (event) => {
    if (event.key === "Escape") {
      panel.hidden = true;
      panel.previousElementSibling?.setAttribute("aria-expanded", "false");
      panel.previousElementSibling?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const options = [...panel.querySelectorAll(".bd-topx-option")];
    const at = options.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    options[Math.max(0, Math.min(options.length - 1, next))]?.focus();
  };
}

function overviewKey() {
  return `${teamKey()}|${overviewTop()}|${evalSettings().exclude_moves || ""}`;
}

function requestOverview(key) {
  if (view.overviewBusy === key) return;
  view.overviewBusy = key;
  analysis("overview", { format: format(), sets: plainSets(), top: overviewTop(), settings: evalSettings() }).then((result) => {
    if (view.overviewBusy !== key) return;
    view.overview = result;
    view.overviewKey = key;
    view.overviewBusy = false;
    if (view.tab === "overview") renderMain();
  }).catch((error) => {
    view.overviewBusy = false;
    console.error(error);
    view.overviewError = { key, message: String(error?.message || error || "Unknown error").split("\n")[0] };
    if (view.tab === "overview") renderMain();
  });
}

/** _v302_directional_type_chart as rows; a type the team does not attack with is "—". */
function chartRows(chart) {
  return Object.entries(chart || {}).map(([type, value]) => ({ type, count: value === null ? 0 : 1, value: value ?? 0 }));
}

function pressureRows(direction) {
  return Object.entries(direction?.type_summary || {}).map(([type, row]) => ({ type, count: row.count, value: row.pressure }));
}

/** The app's order: charted types first, highest value first, then by name. */
function typeChartSection(title, note, rows, field, lowerIsBetter = false) {
  rows = [...rows].sort((a, b) => (b.count > 0) - (a.count > 0) || b.value - a.value || a.type.localeCompare(b.type));
  const best = rows.find((r) => r.count > 0);
  const cells = rows.map((row) => {
    let cls = "none";
    let text = "—";
    if (row.count > 0) {
      if (field === "multiplier") {
        text = `${row.value.toFixed(2)}×`;
        const good = lowerIsBetter ? row.value < 0.95 : row.value > 1.05;
        const bad = lowerIsBetter ? row.value > 1.1 : row.value < 0.9;
        cls = good ? "good" : bad ? "bad" : "mid";
      } else {
        text = `${Math.round(row.value)}%`;
        const good = lowerIsBetter ? row.value < 35 : row.value >= 60;
        const bad = lowerIsBetter ? row.value >= 60 : row.value < 35;
        cls = good ? "good" : bad ? "bad" : "mid";
      }
    } else if (field === "pressure") {
      text = "0%";
    }
    return h("div", { class: `bd-type-cell ${cls}` }, h("img", { src: `/pokemon_champions_assets/types/${row.type}.png`, alt: "", width: 16, height: 16 }), h("span", {}, row.type), h("b", {}, text));
  });
  return h("section", { class: "bd-overview-section" },
    h("h3", { class: "bd-field-label" }, title),
    h("p", { class: "bd-section-note" }, note, best ? h("strong", {}, ` ${lowerIsBetter ? "Most dangerous" : "Best"}: ${best.type}.`) : null),
    h("div", { class: "bd-type-grid" }, cells));
}

function weaknessTable(defense) {
  const rows = Object.entries(defense).filter(([, v]) => v.weak >= 2 || v.resist === 0).sort((a, b) => b[1].weak - a[1].weak);
  return h("section", { class: "bd-overview-section" },
    h("h3", { class: "bd-field-label" }, "Shared weaknesses"),
    rows.length ? h("div", { class: "bd-type-grid" }, rows.map(([type, v]) => h("div", { class: `bd-type-cell ${v.weak >= 3 && v.resist === 0 ? "bad" : v.weak >= 2 ? "mid" : "none"}` },
      h("img", { src: `/pokemon_champions_assets/types/${type}.png`, alt: "", width: 16, height: 16 }), h("span", {}, type), h("b", {}, `${v.weak} weak · ${v.resist} resist`))))
      : h("p", { class: "bd-section-note" }, "No attacking type hits two or more of the team super-effectively."));
}


async function addToTeamFlow(set) {
  const list = sets();
  const empty = list.findIndex((s) => !s.species);
  if (empty >= 0) {
    setSlot(empty, set, data);
    toast(`${name(set)} added to slot ${empty + 1}`);
    return;
  }
  const choice = await chooseSlot(`Your team is full. Which Pokémon should ${name(set)} replace?`);
  if (choice === "new") {
    newTeam([set], data, "");
    toast(`New team started with ${name(set)}`);
  } else if (Number.isInteger(choice)) {
    setSlot(choice, set, data);
    toast(`${name(set)} replaced slot ${choice + 1}`);
  }
}

function chooseSlot(message) {
  return new Promise((resolve) => {
    let answer;
    const list = sets();
    const body = h("div", { class: "bd-list" },
      h("p", { class: "bd-confirm-text" }, message),
      list.map((set, index) => h("button", { type: "button", class: "bd-pick-row", onclick: () => { answer = index; close(); } },
        set.species ? sprite(data.sprite(set.species, set.form, set.item), "", 40) : h("span"),
        h("span", { class: "bd-pick-name" }, set.species ? name(set) : "Empty slot", h("small", {}, `Slot ${index + 1}`)),
        h("span"))),
      h("button", { type: "button", class: "ghost-button", onclick: () => { answer = "new"; close(); } }, "Start a new team instead"));
    const { close } = openDialog({ title: "Choose a slot", body, onClose: () => resolve(answer) });
  });
}

// ---- box ----

function renderBox() {
  const state = getState();
  const box = currentBox();
  const boxSelect = select(state.boxes.map((b) => [b.id, b.name]), box.id, (value) => selectBox(value), { "aria-label": "Box" });
  hosts.main.append(
    h("div", { class: "bd-panel-head" },
      h("div", {}, h("h2", {}, "Box"), h("p", {}, "The Pokémon you own. Auto Build builds from here; drag a card onto a team slot, or use its buttons."))),
    h("div", { class: "bd-box-bar" },
      boxSelect,
      h("button", { type: "button", class: "primary-button compact", onclick: addPokemonToBox }, "+ Add Pokémon"),
      h("button", { type: "button", class: "ghost-button compact", onclick: () => addTeamToBox() }, "Add current team"),
      h("button", { type: "button", class: "ghost-button compact", onclick: () => { const n = prompt("Name for the new box", `Box ${state.boxes.length + 1}`); if (n) addBox(n.trim()); } }, "New box"),
      h("button", { type: "button", class: "ghost-button compact", onclick: () => { const n = prompt("Rename box", box.name); if (n) renameBox(box.id, n.trim()); } }, "Rename"),
      state.boxes.length > 1 ? h("button", { type: "button", class: "ghost-button compact bd-danger-text", onclick: async () => { if (await confirmDialog(`Delete “${box.name}” and its ${box.box.length} Pokémon?`, { confirmLabel: "Delete box" })) deleteBox(box.id); } }, "Delete box") : null));
  if (!box.box.length) {
    hosts.main.append(h("div", { class: "bd-gate" }, h("h3", {}, "This box is empty"), h("p", {}, "Add the Pokémon you have trained, or sync your Box from the Companion app, which can scan it straight from the game."),
      h("div", { class: "bd-gate-actions" }, h("button", { type: "button", class: "primary-button", onclick: addPokemonToBox }, "+ Add Pokémon"), h("button", { type: "button", class: "ghost-button", onclick: () => openSyncDialog(data) }, "Sync with Companion"))));
    return;
  }
  hosts.main.append(h("div", { class: "bd-box-grid" }, box.box.map((entry, index) => {
    const set = boxEntryToSet(entry, data);
    if (!set.species) return null;
    return h("div", {
      class: "bd-box-card",
      draggable: "true",
      ondragstart: () => { view.dragBox = set; view.dragSlot = null; },
    },
    sprite(data.sprite(set.species, set.form, set.item), "", 56),
    h("strong", {}, name(set)),
    h("small", {}, set.item ? h("img", { src: data.itemIcon(set.item), alt: "", width: 14, height: 14 }) : null, set.item || "No item"),
    h("div", { class: "bd-box-card-actions" },
      h("button", { type: "button", class: "bd-mini-button", title: "Add to team", "aria-label": `Add ${name(set)} to the team`, onclick: () => addToTeamFlow(set) }, "+"),
      h("button", { type: "button", class: "bd-mini-button", title: "Edit", "aria-label": `Edit ${name(set)}`, onclick: async () => {
        const result = await editSet(data, set, { format: format(), title: `Edit ${name(set)}`, removeLabel: "Remove from Box" });
        if (result === undefined) return;
        if (result === null) removeFromBox(index);
        else replaceBoxEntry(index, { ...entry, ...setToBoxEntry(result, data, { build_source: entry.build_source || "website", confidence: entry.confidence ?? 1 }) });
      } }, "✎"),
      h("button", { type: "button", class: "bd-mini-button", title: "Remove from Box", "aria-label": `Remove ${name(set)} from the Box`, onclick: () => removeFromBox(index) }, "×")));
  })));
}

async function addPokemonToBox() {
  const set = await editSet(data, makeSet(), { format: format(), title: "Add to Box", allowRemove: false });
  if (set && set.species) {
    addToBox([setToBoxEntry(set, data)]);
    toast(`${name(set)} added to ${currentBox().name}`);
  }
}

// ---- Pro gate ----

const FEATURE_LABELS = { evaluation: "Team Evaluation", autobuild: "Auto Build", tournament: "Test against Tournament Teams" };

function gate(feature) {
  const label = FEATURE_LABELS[feature] || "Pro";
  return h("div", { class: "bd-gate" },
    h("h3", {}, `Keep using ${label} with Pro`),
    h("p", {}, "You've had the full result — Pro makes it unlimited, on this website and in the Companion app."),
    h("ul", {},
      h("li", {}, "Unlimited Team Evaluation: scores, checks and every critical threat"),
      h("li", {}, "Unlimited Auto Build from your Box or the ranked meta"),
      h("li", {}, "Unlimited tests against 2,800+ tournament teams"),
      h("li", {}, "The Companion's Live Mode and Top Lead as a bonus")),
    h("div", { class: "bd-gate-actions" },
      h("a", { class: "primary-button", href: "/pro-tool/plans/" }, "See Pro plans"),
      h("button", { type: "button", class: "ghost-button", onclick: openProDialog }, "I have a key")),
    h("p", { class: "bd-note" }, "Everything else in the Team Builder and the Damage Calculator stays free."));
}

/**
 * Out of free runs while a result is on screen: the result stays and a dialog says why
 * the button did not run (it used to swap the result for the gate).
 */
function openGateDialog(feature) {
  const label = FEATURE_LABELS[feature] || "this feature";
  const body = h("div", { class: "bd-list" },
    h("p", { class: "bd-confirm-text" }, `You've used your free runs of ${label}. The last result stays on screen; with Pro you can run it again as often as you like, on this website and in the Companion app.`),
    h("p", { class: "bd-note" }, "Everything else in the Team Builder and the Damage Calculator stays free."));
  const { close } = openDialog({
    title: `Keep using ${label} with Pro`,
    body,
    actions: [
      h("button", { type: "button", class: "ghost-button", onclick: () => { close(); openProDialog(); } }, "I have a key"),
      h("a", { class: "primary-button", href: "/pro-tool/plans/" }, "See Pro plans"),
    ],
  });
}

function openProDialog() {
  const summary = licenceSummary();
  const input = h("input", { type: "text", class: "bd-input", placeholder: "PCT-XXXXX-XXXXX-XXXXX-XXXXX", autocomplete: "off", spellcheck: "false", "aria-label": "Licence key" });
  const message = h("p", { class: "bd-note", role: "status" });
  const body = h("div", { class: "bd-list" },
    isPro() && summary
      ? h("div", {}, h("p", { class: "bd-confirm-text" }, `Pro is active (${summary.plan}). Renewed automatically while your subscription runs.`), h("p", { class: "bd-note" }, `Key ${summary.key} · valid until ${summary.expires.toLocaleDateString()}`))
      : h("div", {}, h("p", { class: "bd-confirm-text" }, "Enter the licence key from your purchase email. The same key unlocks Pro here and in the Companion app."), input, message),
    h("p", { class: "bd-note" }, h("a", { href: "/pro-tool/plans/" }, "See the plans"), " · ", h("a", { href: "/pro-tool/key/" }, "Lost your key?")));
  const actions = isPro()
    ? [h("button", { type: "button", class: "ghost-button", onclick: () => { deactivate(); close(); renderAll(); } }, "Remove key from this browser"), h("span", { class: "bd-spacer" }), h("button", { type: "button", class: "primary-button", onclick: () => close() }, "Done")]
    : [h("span", { class: "bd-spacer" }), h("button", { type: "button", class: "ghost-button", onclick: () => close() }, "Cancel"), h("button", { type: "button", class: "primary-button", onclick: async (event) => {
      event.currentTarget.disabled = true;
      message.textContent = "Checking the key…";
      try {
        await activate(input.value.trim());
        toast("Pro is active. Thank you for supporting the project!");
        close();
        renderAll();
      } catch (error) {
        message.textContent = error.message;
        event.currentTarget.disabled = false;
      }
    } }, "Activate")];
  const { close } = openDialog({ title: isPro() ? "Pro" : "Activate Pro", body, actions });
}

// ---- evaluation ----

function renderEvaluation() {
  const key = evaluationKey();
  const list = sets().filter((s) => s.species);
  const settings = evalSettings();
  const hasResult = isEvaluation(view.evaluation);
  hosts.main.append(h("div", { class: "bd-panel-head" },
    h("div", {}, h("h2", {}, "Team Evaluation"), h("p", {}, `Rates the team against the Top ${settings.top_meta} ${format()} Meta on their most common sets. Open a score to see how it is made up, or a threat to see every damage calc behind it.`)),
    hasResult && !view.evaluating
      ? h("div", { class: "bd-actions" }, h("button", { type: "button", class: "primary-button compact", onclick: () => runEvaluation(key) }, view.evaluationKey === key ? "Run again" : "Evaluate changes"))
      : null));
  if (!list.length) {
    hosts.main.append(h("div", { class: "bd-gate" }, h("h3", {}, "Nothing to evaluate yet"), h("p", {}, "Add at least one Pokémon to the team first.")));
    return;
  }
  if (view.evaluating) {
    hosts.main.append(h("div", { class: "bd-progress" },
      h("div", { class: "bd-progress-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(view.evalProgress * 100)) }, h("i", { style: { width: `${Math.round(view.evalProgress * 100)}%` } })),
      h("p", { class: "bd-note", "aria-live": "polite" }, view.evalStatus || "Evaluating every matchup…")));
    return;
  }
  if (view.evalError) {
    hosts.main.append(problemCard("Team Evaluation could not finish", view.evalError, { onAction: () => runEvaluation(key) }));
    return;
  }
  if (!hasResult) {
    if (!canRun("evaluation")) {
      hosts.main.append(gate("evaluation"));
      return;
    }
    hosts.main.append(h("div", { class: "bd-gate" },
      h("h3", {}, "Is this team any good?"),
      h("p", {}, "Team Evaluation scores Synergy, Offense, Defense and Speed, runs the Team Building Checks, and lists every critical threat in the meta with the calcs behind it. The Top Meta size, field and rules are under Settings in the top bar."),
      h("div", { class: "bd-gate-actions" }, h("button", { type: "button", class: "primary-button", onclick: () => runEvaluation(key) }, "Run Team Evaluation"))));
    return;
  }
  const result = view.evaluation;
  const stale = view.evaluationKey !== key;
  const wrap = h("div", { class: stale ? "bd-stale" : "" });
  if (stale) wrap.append(h("p", { class: "bd-note bd-stale-note" }, "The team or the settings changed since this evaluation. Press “Evaluate changes” to update it."));
  const slots = (result.slots || []).map(({ entry, mon }) => ({ name: data ? mon.form_name : "", species: entry.pokemon, form: mon.form_name, item: entry.item }));
  wrap.append(h("div", { class: "bd-scores" },
    scoreButton("Synergy", result.synergy_score, () => openSynergyDialog(result, { spriteFor, slots: slots.map((slot) => ({ ...slot, name: memberName(result, slot) })) }), "Team Synergy by Pokémon"),
    scoreButton("Offense", result.offense_score, () => openPressureDialog(result, "offense"), "Offense Overview"),
    scoreButton("Defense", result.defense_score, () => openPressureDialog(result, "defense"), "Defense Overview"),
    scoreButton("Speed", result.speed.score, () => openSpeedDialog(result), "Speed Control")));
  const archetype = result.archetype?.archetype;
  wrap.append(h("p", { class: "bd-eval-meta" }, [archetype ? `Detected archetype: ${archetype}` : "", `${result.threats.length} critical threat${result.threats.length === 1 ? "" : "s"} in the Top ${result.all_top_meta_threat_rows_v462}`, result.seconds ? `calculated in ${result.seconds.toFixed(1)} s` : ""].filter(Boolean).join(" · ")));
  wrap.append(h("div", { class: "bd-subtabs", role: "tablist", style: "--tabs: 5" },
    [["checks", "Team Checks"], ["threats", `Threats (${result.threats.length})`], ["suggest", "Suggestions"], ["optimize", "Optimize"], ["speed", "Speed"]].map(([id, label]) => h("button", {
      type: "button",
      class: `bd-tab ${view.evalTab === id ? "on" : ""}`,
      role: "tab",
      "aria-selected": view.evalTab === id ? "true" : "false",
      onclick: () => { view.evalTab = id; renderMain(); },
    }, label))));
  if (view.evalTab === "checks") wrap.append(checksView(result, { onCustomize: openCustomizeChecks }));
  else if (view.evalTab === "threats") wrap.append(threatsView(result, { spriteFor, name: (value) => showdownName(value) }));
  else if (view.evalTab === "suggest") wrap.append(suggestionsPanel());
  else if (view.evalTab === "optimize") wrap.append(optimizePanel());
  else if (view.evalTab === "speed") wrap.append(speedView(result), speedTiersPanel("Speed Tiers", "evaluation"));
  hosts.main.append(wrap);
}

function memberName(result, slot) {
  const members = result.synergy_members || [];
  const wanted = showdownName(slot.form || slot.species);
  return members.find((m) => m.name === wanted || showdownName(m.name) === wanted)?.name || wanted;
}

/** Showdown spelling for names in analysis results (threats, checks, synergy): the
 *  builder's table also knows the ladder names (Floette-Eternal) and gendered Megas. */
function showdownName(value) {
  return data.showdownName(value);
}

function scoreButton(label, value, onClick, hint) {
  return h("button", { type: "button", class: "bd-score", onclick: onClick, title: `Open ${hint}` },
    scoreRing(value, label), h("span", { class: "bd-score-text" }, h("strong", {}, label), h("small", {}, "Details ›")));
}

/** A score shown without anything behind it (Auto Build's result). */
function scoreCard(label, value) {
  return h("div", { class: "bd-score static" }, scoreRing(value, label), h("span", { class: "bd-score-text" }, h("strong", {}, label)));
}

/**
 * The app spellings of Pokémon ("Mega Salamence", "Hisuian Arcanine") that have another
 * Showdown name, longest first, as one pattern. Suggestions and Auto Build reasons carry
 * the engine's names inside their sentences; showdownText renames them on screen only, so
 * the rows stay exactly as the parity suites check them.
 */
let appSpellings = null;
function spellingPattern(names) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sorted = [...names].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return new RegExp(`(^|[^A-Za-z0-9'’-])(${sorted.map(escape).join("|")})(?=$|[^A-Za-z0-9'’-])`, "g");
}

/** `text` with every Pokémon name in its Showdown spelling, as the Threats tab shows them; `extra` adds names to look for. */
function showdownText(text, extra = []) {
  const value = String(text ?? "");
  if (!value) return value;
  if (!appSpellings) {
    const raw = new Set([...Object.keys(data.app?.displayNames || {}), ...data.forms.flatMap((row) => [row.form, row.species])]);
    const names = [...raw].filter((n) => /^[A-Z]/.test(n) && showdownName(n) !== n);
    appSpellings = { names: new Set(names), pattern: names.length ? spellingPattern(names) : null };
  }
  const more = [...new Set((extra || []).map((n) => String(n || "").trim()))].filter((n) => n && !appSpellings.names.has(n) && showdownName(n) !== n);
  const pattern = more.length ? spellingPattern([...appSpellings.names, ...more]) : appSpellings.pattern;
  return pattern ? value.replace(pattern, (_, before, found) => `${before}${showdownName(found)}`) : value;
}

/**
 * Drops a Suggestions run or list made for another team, format or settings (a team edit,
 * "Use", a Settings change) and stops the worker's checks for it. True when it dropped one.
 */
function dropStaleSuggestions() {
  if (!view.suggestKey || view.suggestKey === evaluationKey()) return false;
  if (view.suggestRequest) cancelAnalysis(view.suggestRequest);
  Object.assign(view, { suggestRequest: 0, suggestKey: "", suggesting: false, suggestions: null, suggestProgress: 0, suggestStatus: "" });
  return true;
}

function suggestionsPanel() {
  const list = sets();
  dropStaleSuggestions();
  if (view.suggestError && !view.suggesting) {
    return problemCard("Suggestions could not be calculated", view.suggestError, { onAction: runSuggestions });
  }
  const boxCount = allBoxSets().length;
  const panel = suggestionsView(view.suggestions, {
    spriteFor,
    // Pokémon names in Showdown spelling, as on the Threats tab (display only).
    name: showdownName,
    text: showdownText,
    running: view.suggesting,
    progress: view.suggestProgress,
    status: view.suggestStatus,
    full: !list.some((s) => !s.species),
    onRun: runSuggestions,
    onUse: useSuggestion,
    scope: boxCount ? view.suggestScope : "all",
    boxCount,
    // Switching the scope of a list on screen runs it again for the new scope; with an
    // empty Box there is only "All Pokémon" (the view disables Only Box).
    onScope: (scope) => {
      const wanted = scope === "box" && boxCount ? "box" : "all";
      view.suggestScope = wanted;
      if (view.suggestions && (view.suggestions.scope || "all") !== wanted) runSuggestions();
    },
    ui: view.suggestUi,
  });
  // Kept so a Team Evaluation check that arrives redraws just its row.
  view.suggestHost = panel;
  return panel;
}

// --- Optimize (builder/optimize-deep.js in the worker, builder/optimize-view.js on screen) ---

const OPTIMIZE_STORE = "cbd.optimize.v1";

/** The Optimize options, remembered on this device (Quick by default on small machines). */
function optimizeOptions() {
  const fallback = { ...OPTIMIZE_DEFAULTS, depth: (navigator.hardwareConcurrency || 8) <= 4 ? "quick" : "deep" };
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIMIZE_STORE) || "null");
    return saved && typeof saved === "object" ? { ...fallback, ...saved, depth: saved.depth === "quick" ? "quick" : saved.depth === "deep" ? "deep" : fallback.depth } : fallback;
  } catch {
    return fallback;
  }
}

function setOptimizeOptions(patch) {
  // Merged from the options in memory, so an earlier choice still holds when the browser
  // refuses to store them.
  const next = { ...(view.optimizeOptions || optimizeOptions()), ...patch };
  try {
    localStorage.setItem(OPTIMIZE_STORE, JSON.stringify(next));
  } catch {
    // Storage off: the choice lasts until the page is reloaded.
  }
  view.optimizeOptions = next;
  renderMain();
}

/** The moves the player pinned for a member (cleared when the slot holds another Pokemon). */
function optimizeKept(slot, set) {
  view.optimizeKeep ||= {};
  const entry = view.optimizeKeep[slot];
  if (!entry || entry.species !== set.species) view.optimizeKeep[slot] = { species: set.species, moves: new Set() };
  const moves = view.optimizeKeep[slot].moves;
  for (const move of [...moves]) if (!(set.moves || []).includes(move)) moves.delete(move);
  return moves;
}

/**
 * What a member's Optimize state stands for: the format, that member's own set and the
 * Team Evaluation settings. Changing another member keeps it (shown with a note, since
 * the team's Tailwind, Trick Room or weather feed the score); changing this one drops it.
 */
function optimizeMemberKey(set) {
  return `${format()}|${JSON.stringify(plainSets([set])[0])}|${JSON.stringify(evalSettings())}`;
}

/** Whether a slot's Optimize state no longer belongs there (replaced, or its member changed). */
function optimizeStale(slot, state, list = sets()) {
  if (view.optimize[slot] !== state) return true;
  const set = list[slot];
  return !set?.species || optimizeMemberKey(set) !== state.key;
}

/** Forget a slot's Optimize state; a run still going is cancelled in the worker. */
function dropOptimize(slot, state) {
  if (state?.running && state.requestId && !state.cancelled) {
    state.cancelled = true;
    cancelAnalysis(state.requestId);
  }
  if (view.optimize[slot] === state) view.optimize[slot] = null;
}

/** Optimize: each member's Nature, Stat Points and attacking moves tuned against the Top-X meta. */
function optimizePanel() {
  const list = sets();
  const key = teamKey(list);
  const options = view.optimizeOptions || optimizeOptions();
  for (const [slot, state] of Object.entries(view.optimize)) {
    if (state && optimizeStale(Number(slot), state, list)) dropOptimize(Number(slot), state);
  }
  const members = [];
  list.forEach((set, slot) => {
    if (!set.species) return;
    const state = view.optimize[slot] || null;
    members.push({
      slot, set, name: name(set), sprite: data.sprite(set.species, set.form, set.item), state, kept: optimizeKept(slot, set),
      teamChanged: Boolean(state?.result && state.teamKey !== key),
    });
  });
  return optimizeView({
    members,
    options,
    topX: evalSettings().top_meta,
    spriteFor,
    onOptions: setOptimizeOptions,
    onRun: runOptimize,
    onStop: stopOptimize,
    onApply: applyOptimize,
    onDiscard: (slot) => { view.optimize[slot] = null; renderMain(); },
    onKeepMove: (slot, move) => {
      const kept = optimizeKept(slot, sets()[slot]);
      if (kept.has(move)) kept.delete(move);
      else kept.add(move);
      renderMain();
    },
  });
}

async function runOptimize(slot) {
  const list = sets();
  const set = list[slot];
  if (!set?.species) return;
  const options = view.optimizeOptions || optimizeOptions();
  // An earlier run of this slot that is still going is cancelled, so two never compete.
  if (view.optimize[slot]) dropOptimize(slot, view.optimize[slot]);
  const state = { key: optimizeMemberKey(set), teamKey: teamKey(list), running: true, stopping: false, fraction: 0, status: "Preparing the Top Meta threats…", requestId: 0 };
  view.optimize[slot] = state;
  renderMain();
  let painted = 0;
  let checked = 0;
  try {
    const request = analysis("optimize", {
      format: format(), sets: plainSets(list), slot, settings: evalSettings(), topX: evalSettings().top_meta,
      depth: options.depth, testMoves: options.testMoves, keepNature: options.keepNature, keepSpeed: options.keepSpeed,
      lockedMoves: [...optimizeKept(slot, set)],
    }, (progress) => {
      if (state.cancelled) return;
      const now = Date.now();
      // A run whose member changed, or that was replaced, is cancelled and never drawn
      // (checked a few times a second, also while another tab is open).
      if (view.optimize[slot] !== state || now - checked >= 200) {
        checked = now;
        if (optimizeStale(slot, state)) {
          dropOptimize(slot, state);
          return;
        }
      }
      state.fraction = progress.fraction ?? state.fraction;
      if (progress.message) state.status = progress.message;
      if (!(view.tab === "evaluation" && view.evalTab === "optimize")) return;
      // A few redraws a second, in place only: the rest of the tab does not move while it
      // runs, and a card that is not on screen is drawn from this state when it next is.
      if (now - painted < 200) return;
      painted = now;
      updateProgress(hosts.main.querySelector(`[data-opt-slot="${slot}"]`), state);
    });
    state.requestId = request.requestId;
    state.result = await request;
  } catch (error) {
    console.error(error);
    state.result = { ok: false, error: true, message: `Optimize could not finish: ${String(error?.message || error || "Unknown error").split("\n")[0]}` };
  }
  state.running = false;
  state.stopping = false;
  state.requestId = 0;
  // Dropped meanwhile (its member changed, or a newer run replaced it): nothing to show.
  if (state.cancelled || optimizeStale(slot, state)) {
    dropOptimize(slot, state);
    return;
  }
  if (view.tab === "evaluation" && view.evalTab === "optimize") renderMain();
}

/** Stop a running Optimize: the worker answers with the best result found so far. */
function stopOptimize(slot) {
  const state = view.optimize[slot];
  if (!state?.running || !state.requestId) return;
  state.stopping = true;
  cancelAnalysis(state.requestId);
  updateProgress(hosts.main.querySelector(`[data-opt-slot="${slot}"]`), state);
  renderMain();
}

/**
 * Put an Optimize result into the slot. `kind`: "all" (Nature, Stat Points and moves),
 * "stats" (Nature and Stat Points, moves kept), "moves" or "trade" (a listed option).
 */
function applyOptimize(slot, choice, kind = "all") {
  const set = sets()[slot];
  if (!set?.species || !choice?.bonuses) return;
  const moves = kind !== "stats" && (choice.moves || []).length ? [...choice.moves] : set.moves;
  // This member's result is used up; the other members keep theirs (their sets did not change).
  view.optimize[slot] = null;
  setSlot(slot, makeSet({ ...set, nature: choice.nature || set.nature, bonuses: [...choice.bonuses], moves }), data);
  const changedMoves = kind !== "stats" && (choice.moves || []).some((m) => !(set.moves || []).includes(m));
  toast(`${name(set)}: ${choice.nature || set.nature} · ${choice.bonuses.join("/")}${changedMoves ? ` · ${moves.join(", ")}` : ""}`);
}

/** The builder slot a suggestion goes into: the open slot, or the member it replaces. */
function suggestionSlot(row) {
  const list = sets();
  if (row.action_kind !== "swap") return list.findIndex((s) => !s.species);
  const filled = list.map((set, index) => [set, index]).filter(([set]) => set.species);
  const wanted = showdownName(row.swap_target || "");
  const match = filled.find(([set]) => showdownName(name(set)) === wanted || showdownName(set.form || set.species) === wanted);
  return match ? match[1] : filled[row.slot_index]?.[1] ?? -1;
}

function useSuggestion(row) {
  const slot = suggestionSlot(row);
  if (slot < 0) {
    toast("There is no slot for this suggestion any more. Run the suggestions again.", "error");
    return;
  }
  // Item Clause is the app's rule on apply (_v482_suggestion_unique_item): a clashing
  // item becomes the first one no other member holds, or the suggestion is refused.
  const key = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const used = new Set(sets().filter((s, i) => i !== slot && s.species && s.item).map((s) => key(s.item)));
  let entry = { ...row.candidate_entry };
  if (key(entry.item) && used.has(key(entry.item))) {
    const replacement = (row.item_options || []).find((option) => key(option) && !used.has(key(option)));
    if (!replacement) {
      toast(`Cannot apply this suggestion: ${entry.item} is already used by another team member.`, "error");
      return;
    }
    toast(`${entry.item} is already on the team, so ${row.name} holds ${replacement}.`);
    entry = { ...entry, item: replacement };
  }
  const set = boxEntryToSet({ ...entry, ev_spread: row.spread }, data);
  setSlot(slot, set, data);
  view.suggestions = null;
  toast(row.action_kind === "swap" && row.swap_target ? `${row.name} replaces ${row.swap_target}` : `${row.name} added`);
}

/**
 * Suggestions arrive in two steps: the ranked list ({ranked}), then each shown row's
 * check against the full Team Evaluation ({detail}), merged into its row by key. A run
 * whose team, format or settings changed meanwhile (a team edit, Use, Settings) is
 * dropped and stopped at its next message, whichever step it is in; details of a list
 * that is gone (Use, a new run) are dropped and the check stopped.
 */
async function runSuggestions() {
  if (view.suggestRequest) cancelAnalysis(view.suggestRequest);
  const showing = () => view.tab === "evaluation" && view.evalTab === "suggest";
  const boxSets = plainSets(allBoxSets()).filter(Boolean);
  const onlyBox = view.suggestScope === "box" && boxSets.length > 0;
  Object.assign(view, {
    suggesting: true, suggestError: "", suggestProgress: 0, suggestStatus: "Evaluating the current team…",
    suggestions: null, suggestUi: { open: new Set(), all: new Set() }, suggestRequest: 0, suggestKey: evaluationKey(),
  });
  renderMain();
  let id = 0;
  try {
    const request = analysis("suggestions", { format: format(), sets: plainSets(), settings: evalSettings(), checks: checkSelection(), onlyBox, box: onlyBox ? boxSets : [] }, (progress) => {
      if (view.suggestRequest !== id) return;
      if (dropStaleSuggestions()) {
        if (showing()) renderMain();
        return;
      }
      if (progress.ranked) {
        view.suggestions = progress.ranked;
        view.suggesting = false;
        if (showing()) renderMain();
        return;
      }
      if (progress.detail) {
        const row = view.suggestions?.rows?.find((r) => r.key === progress.detail.key);
        if (!row) {
          cancelAnalysis(id);
          return;
        }
        row.projected = progress.detail.projected;
        if (!showing()) return;
        if (view.suggestHost?.isConnected && view.suggestHost.refreshRow) view.suggestHost.refreshRow(row.key);
        else renderMain();
        return;
      }
      view.suggestProgress = progress.fraction ?? view.suggestProgress;
      if (progress.message) view.suggestStatus = progress.message;
      if (view.suggesting && showing()) renderMain();
    });
    id = request.requestId;
    view.suggestRequest = id;
    const result = await request;
    if (view.suggestRequest === id && dropStaleSuggestions()) {
      if (showing()) renderMain();
      return;
    }
    // A list cleared meanwhile (Use, a team change) stays cleared.
    if (view.suggestRequest === id && view.suggestions) view.suggestions = result;
  } catch (error) {
    console.error(error);
    if (view.suggestRequest === id) view.suggestError = String(error?.message || error || "Unknown error").split("\n")[0];
  }
  if (view.suggestRequest !== id) return;
  view.suggestRequest = 0;
  view.suggesting = false;
  if (showing()) renderMain();
}

async function runEvaluation(key) {
  if (!canRun("evaluation")) {
    if (isEvaluation(view.evaluation)) openGateDialog("evaluation");
    else renderMain();
    return;
  }
  view.evaluating = true;
  view.evalError = "";
  view.evalProgress = 0;
  view.evalStatus = "Preparing the Top Meta…";
  view.suggestions = null;
  renderMain();
  const runFormat = format();
  // The format was switched while it ran: the result is kept for that format.
  const place = () => (format() === runFormat ? view : formatShelf(runFormat));
  try {
    const result = await analysis("evaluate", { format: runFormat, sets: plainSets(), settings: evalSettings(), checks: checkSelection() }, (progress) => {
      view.evalProgress = progress.fraction ?? view.evalProgress;
      if (progress.message) view.evalStatus = progress.message;
      if (view.tab === "evaluation") renderMain();
    });
    if (!isEvaluation(result)) throw new Error("The evaluation came back incomplete.");
    Object.assign(place(), { evaluation: result, evaluationKey: key, evalError: "" });
    recordRun("evaluation");
    rememberEvaluation(key, result);
  } catch (error) {
    console.error(error);
    place().evalError = String(error?.message || error || "Unknown error").split("\n")[0];
  }
  view.evaluating = false;
  renderMain();
}

// --- results per format ------------------------------------------------------------
//
// A Team Evaluation or Auto Build result belongs to the format it was made in. Switching
// the format puts the shown ones on that format's shelf and brings back the other
// format's own (or none); a run that finishes after a switch goes onto its own shelf.

const formatShelves = { Doubles: {}, Singles: {} };

function formatShelf(fmt) {
  return formatShelves[fmt === "Singles" ? "Singles" : "Doubles"];
}

/** The format a result key was made for (every key starts with it, see teamKey). */
function keyFormat(key) {
  return String(key || "").split("|")[0];
}

function switchFormatResults(from, to) {
  if (from === to) return;
  Object.assign(formatShelf(from), { evaluation: view.evaluation, evaluationKey: view.evaluationKey, evalError: view.evalError, autoResult: view.auto.result, autoError: view.auto.error });
  const next = formatShelf(to);
  Object.assign(view, { evaluation: next.evaluation || null, evaluationKey: next.evaluationKey || "", evalError: next.evalError || "" });
  view.auto.result = next.autoResult || null;
  view.auto.error = next.autoError || "";
  for (const k of ["evaluation", "evaluationKey", "evalError", "autoResult", "autoError"]) delete next[k];
  // The tournament result on screen belongs to the format it was made in, running or not:
  // a test that keeps running for `from` keeps filing its progress on that shelf (see runTournament).
  Object.assign(formatShelf(from), { tourSnapshot: view.tour.snapshot, tourKey: view.tour.key, tourError: view.tour.error });
  takeTournamentShelf(to);
}

/** Shows the given format's shelved tournament result (or none). */
function takeTournamentShelf(fmt) {
  const shelf = formatShelf(fmt);
  Object.assign(view.tour, { snapshot: shelf.tourSnapshot || null, key: shelf.tourKey || "", error: shelf.tourError || "", opened: new Map() });
  for (const k of ["tourSnapshot", "tourKey", "tourError"]) delete shelf[k];
}

// The last evaluation survives a reload of the tab. Its shape changed when the app's
// evaluation was ported; one saved by an older version must not be shown (it has no
// Offense/Defense scores and no threat list), so the key is versioned and the shape checked.
const EVALUATION_STORE = "cbd.eval.v2";
const OLD_EVALUATION_STORES = ["cbd.eval.last"];

function isEvaluation(result) {
  return Boolean(result)
    && ["synergy_score", "offense_score", "defense_score"].every((k) => Number.isFinite(Number(result[k])))
    && Array.isArray(result.threats)
    && Array.isArray(result.checks?.rows)
    && typeof result.speed === "object" && result.speed !== null;
}

function rememberEvaluation(key, result) {
  try {
    sessionStorage.setItem(EVALUATION_STORE, JSON.stringify({ key, result }));
  } catch {
    // Storage full or disabled: the result just is not kept across reloads.
  }
}

function forgetEvaluation() {
  try {
    sessionStorage.removeItem(EVALUATION_STORE);
  } catch {
    // ignore
  }
}

function restoreEvaluation() {
  try {
    for (const old of OLD_EVALUATION_STORES) sessionStorage.removeItem(old);
    const saved = JSON.parse(sessionStorage.getItem(EVALUATION_STORE) || "null");
    if (saved?.key && isEvaluation(saved.result)) {
      // Shown only in the format it was made for; otherwise it waits on that format's shelf.
      Object.assign(keyFormat(saved.key) === format() ? view : formatShelf(keyFormat(saved.key)), { evaluation: saved.result, evaluationKey: saved.key });
    } else if (saved) {
      forgetEvaluation();
    }
  } catch {
    // ignore
  }
}

// ---- auto build ----

// Times as measured on a desktop (Node): the first build of a visit also fills the damage
// caches; a slower device can take up to about twice as long.
const AUTO_DEPTHS = [
  ["fast", "Fast", "Screens the 40 most-used Pokémon for each open slot, then builds one other team and compares both with the full Team Evaluation. About 10 seconds for the first build, a few seconds after that."],
  ["medium", "Medium", "Screens the 100 most-used Pokémon for each slot, then compares up to three complete teams (two sets tried for each other pick) and checks one swap of a Pokémon it added. About 20 seconds for the first build, about 5 after that."],
  ["deep", "Deep", "Screens every ranked Pokémon for each slot, then compares up to four complete teams (three sets tried for each other pick) and checks one swap of a Pokémon it added. Up to about 45 seconds for the first build and about 10 after that, longer on a slower device; Stop keeps the best team found so far."],
];

/** What the compared teams are called on the result. */
const AUTO_TEAM_LABELS = { anchor: "Best pick per slot", alternative: "Other picks", swap: "After one swap" };

function renderAuto() {
  const auto = view.auto;
  const boxCount = allBoxSets().length;
  const locked = sets().filter((s) => s.species);
  hosts.main.append(h("div", { class: "bd-panel-head" },
    h("div", {}, h("h2", {}, "Auto Build Team"),
      h("p", {}, "Fills the open slots one at a time: every candidate is scored on the enabled Team Building Checks first and on the Suggestions score second, and the best one is taken. Then other picks are tried for each slot, the complete teams are finished (Megas, weather, speed mode and sets) and compared with the full Team Evaluation, and the best team is kept."),
      h("p", { class: "bd-note" }, "A move used by 95% or more of that Pokémon on the ladder is always kept on the final set, unless it needs weather or terrain the team does not set up."))));
  if (auto.running) {
    hosts.main.append(h("div", { class: "bd-progress bd-auto-progress" },
      h("div", { class: "bd-progress-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(auto.fraction * 100)) }, h("i", { style: { width: `${Math.round(auto.fraction * 100)}%` } })),
      h("div", { class: "bd-auto-run" },
        h("p", { class: "bd-note", "aria-live": "polite" }, auto.status),
        h("button", { type: "button", class: "ghost-button compact", disabled: auto.stopping, onclick: stopAutoBuild }, auto.stopping ? "Stopping…" : "Stop")),
      auto.runFormat && auto.runFormat !== format() ? h("p", { class: "bd-note" }, `This build is for ${auto.runFormat}; its team is shown when ${auto.runFormat} is selected again.`) : null));
    return;
  }
  if (!auto.result && !canRun("autobuild")) {
    hosts.main.append(gate("autobuild"));
    return;
  }
  const depth = AUTO_DEPTHS.some(([key]) => key === auto.depth) ? auto.depth : "deep";
  const depthNote = AUTO_DEPTHS.find(([key]) => key === depth)[2];
  const topMeta = evalSettings().top_meta;
  hosts.main.append(h("div", { class: "bd-auto-options" },
    h("div", { class: "bd-auto-col" },
      h("div", { class: "bd-auto-depth" },
        h("span", { class: "bd-field-label" }, "Search depth"),
        segmented(AUTO_DEPTHS.map(([key, label]) => [key, label]), depth, (value) => { auto.depth = value; renderMain(); }, { "aria-label": "Search depth" }),
        h("p", { class: "bd-note" }, depthNote)),
      h("label", { class: "bd-auto-depth" },
        h("span", { class: "bd-field-label" }, "Preferred archetype"),
        select(AUTO_BUILD_ARCHETYPES.map(([label, key]) => [key, label]), archetypeKey(auto.archetype), (value) => { auto.archetype = archetypeKey(value); renderMain(); }, { "aria-label": "Preferred archetype" }),
        h("p", { class: "bd-note" }, archetypeDescription(auto.archetype)))),
    h("div", { class: "bd-auto-switches" },
      switchRow(locked.length ? `Keep the current ${locked.length} Pokémon` : "Keep the current team", auto.keep, (on) => { auto.keep = on; }),
      switchRow(boxCount ? "Only use my Box" : "Only use my Box (empty)", Boolean(auto.onlyBox && boxCount), (on) => { auto.onlyBox = on; }, { disabled: !boxCount, hint: "Build only from the Pokémon in your Box." }),
      switchRow("Prioritize Meta Pokémon", Boolean(auto.prioritizeMeta), (on) => { auto.prioritizeMeta = on; }, { hint: `Ranks the Top ${topMeta} ${format()} Meta ahead of other Pokémon once the Team Building Checks are settled, for each slot and when the complete teams are compared.` }),
      switchRow("Optimize Stat Points", Boolean(auto.optimizeStats), (on) => { auto.optimizeStats = on; }, { hint: "After the build, tune every member's Stat Points and Nature (slower)." })),
    h("div", { class: "bd-actions" },
      h("button", { type: "button", class: "primary-button", onclick: runAutoBuild }, auto.result ? "Build again" : "Start Auto Build"),
      h("span", { class: "bd-note" }, "Uses your Team Evaluation settings and Team Building Checks (the Settings button above)."))));
  if (auto.error) {
    hosts.main.append(problemCard("Auto Build could not finish", auto.error, { onAction: runAutoBuild }));
    return;
  }
  if (auto.result?.error) {
    hosts.main.append(problemCard("Auto Build could not finish", auto.result.error));
    return;
  }
  if (!auto.result) return;
  const result = auto.result;
  const added = new Map((result.additions || []).map((a) => [a.slot, a]));
  const evaluation = isEvaluation(result.evaluation) ? result.evaluation : null;
  const built = result.sets.map((set) => (set ? makeSet(set) : makeSet()));
  // _v494_label_team_with_archetype: the archetype it was built for, else the one it reads as.
  const teamLabel = result.archetype || evaluation?.archetype?.archetype || "Balanced";
  const detected = evaluation?.archetype?.archetype || "";
  const archetypeLine = result.archetype
    ? (detected && detected !== result.archetype ? `Built for ${result.archetype} · reads as ${detected}` : `Built for ${result.archetype}`)
    : detected;
  // Only what the reader should know: a rule the last slot could not keep, a move it could
  // not add, the swap the Team Evaluation asked for, a build stopped early (names in
  // Showdown spelling, as everywhere on the page).
  const swapNames = (result.compared || []).flatMap((team) => (team.swap ? [team.swap.out, team.swap.in] : []));
  const caveats = (result.log || []).filter((line) => /^No Pokémon for the last slot|^Auto Build could not reach|^Auto Build reached \d|^Swapped |^Auto Build was stopped|^The best pick per slot could not/.test(line))
    .map((line) => showdownText(line, swapNames));
  const search = result.search || null;
  // The search is bounded by fixed counts; only its time limit (a safety net for a very
  // slow or busy device) can cut it short, and then the same team may build differently.
  if (search?.capped && !search.stoppedEarly) caveats.push("The search reached its time limit, so it compared fewer teams than it normally does. Building again, which is faster once the first build has run, may find a different team.");
  hosts.main.append(h("section", { class: "bd-auto-result" },
    h("div", { class: "bd-section-head" },
      h("h3", { class: "bd-field-label" }, "Result"),
      h("span", { class: "bd-note" }, [
        archetypeLine,
        evaluation ? `${evaluation.threats.length} critical threat${evaluation.threats.length === 1 ? "" : "s"} left` : "",
        search?.teams > 1 ? `${search.teams} complete teams compared` : "",
        result.seconds ? `built in ${result.seconds.toFixed(1)} s` : "",
      ].filter(Boolean).join(" · "))),
    caveats.length ? h("p", { class: "bd-note bd-auto-caveat" }, caveats.join(" ")) : null,
    evaluation ? h("div", { class: "bd-scores" },
      scoreCard("Synergy", evaluation.synergy_score), scoreCard("Offense", evaluation.offense_score),
      scoreCard("Defense", evaluation.defense_score), scoreCard("Speed", evaluation.speed.score)) : null,
    h("div", { class: "bd-auto-members" }, result.sets.map((set, index) => {
      if (!set) return null;
      const pick = added.get(index);
      return h("div", { class: `bd-auto-member ${pick ? "added" : ""}` },
        h("div", { class: "bd-auto-art" }, sprite(data.sprite(set.species, set.form, set.item), "", 52)),
        h("div", { class: "bd-auto-text" },
          h("div", { class: "bd-auto-name" }, h("strong", {}, name(set)), pick ? h("span", { class: "bd-pill good", title: "Suggestions score when it was added" }, `Added · ${Number(pick.score).toFixed(1)}`) : null),
          h("p", {}, [set.item, set.ability, set.nature].filter(Boolean).join(" · ")),
          h("div", { class: "bd-move-chips" }, (set.moves || []).filter(Boolean).map((move) => h("span", {}, move))),
          pick ? autoWhy(pick) : null));
    })),
    comparedTeams(result),
    result.similar ? similarTeamCard(result.similar) : null,
    h("div", { class: "bd-actions" },
      h("button", { type: "button", class: "primary-button", onclick: () => { newTeam(built, data, `Auto Build ${new Date().toLocaleDateString()}`); renameTeam(currentTeam().id, undefined, teamLabel); toast("Saved as a new team"); view.tab = "overview"; renderAll(); } }, "Save as new team"),
      h("button", { type: "button", class: "ghost-button", onclick: () => { setTeamSets(built, data, { archetype: teamLabel }); toast("Current team replaced"); } }, "Replace current team"))));
}

/**
 * "Why it was added": the member's best reasons, the threats it helps against, its
 * estimated score changes. Pokémon names are shown in Showdown spelling (display only).
 */
function autoWhy(pick) {
  const order = { good: 0, yellow: 1, red: 2, neutral: 3 };
  const severities = pick.severities || {};
  const answers = (pick.answers || []).map(String);
  const reasons = (pick.details || []).map((text, i) => [String(text), severities[String(text).toLowerCase()] || "neutral", i])
    .sort((a, b) => (order[a[1]] ?? 3) - (order[b[1]] ?? 3) || a[2] - b[2]).slice(0, 3)
    .map(([text, sev, i]) => [showdownText(text, answers), sev, i]);
  const components = pick.components || {};
  const chips = [["synergy", "Syn"], ["offense", "Off"], ["defense", "Def"], ["speed", "Spe"]].filter(([k]) => components[k]).map(([k, short]) => {
    const delta = Number(components[k].delta) || 0;
    return h("span", { class: `bd-sg-delta ${delta > 0.049 ? "up" : delta < -0.049 ? "down" : "flat"}` }, `${short} ${delta > 0.049 ? "+" : delta < -0.049 ? "−" : "±"}${Math.abs(delta).toFixed(1)}`);
  });
  return h("details", { class: "bd-auto-why" },
    h("summary", {}, "Why it was added"),
    pick.swapped ? h("p", {}, `Swapped in for ${showdownName(pick.swapped)} because the full Team Evaluation rated the team higher with it.`) : null,
    reasons.length ? h("ul", { class: "bd-sg-impact" }, reasons.map(([text, sev]) => h("li", { class: sev },
      h("span", { class: `bd-sg-badge ${sev}`, "aria-hidden": "true" }, sev === "good" ? "✓" : sev === "neutral" ? "i" : "!"), h("span", {}, text)))) : null,
    answers.length ? h("p", {}, `Helps vs ${answers.slice(0, 4).map((n) => showdownName(n)).join(", ")}`) : null,
    chips.length ? h("div", { class: "bd-sg-deltas", title: "Estimated score changes when it was picked" }, chips) : null);
}

/**
 * The rule the compared teams are ranked by, in words (autobuild-search.js beats(): the
 * first step on which two teams differ decides; the score counts only when all tie).
 */
function comparedRule(objective = {}, archetype = "") {
  const margin = Number(objective.margin ?? 1);
  const weight = Number(objective.redThreatWeight ?? 1);
  const red = Number(objective.redThreat ?? 70);
  const steps = ["fewer red Team Building Checks failed", "then fewer yellow ones"];
  const chosenArchetype = objective.archetype ?? archetype;
  if (chosenArchetype) steps.push(`then fewer unmet critical ${chosenArchetype} requirements`);
  if (objective.metaTop) steps.push(`then fewer Pokémon added from outside the Top ${objective.metaTop} Meta`);
  steps.push(`and last a score at least ${margin} point${margin === 1 ? "" : "s"} higher (the average of the four scores, minus ${weight} for every threat scoring ${red} or more)`);
  return `Each team went through the same finishing steps and the full Team Evaluation. Teams are compared step by step, and the first step where two teams differ decides: ${steps.join(", ")}. The best pick per slot is kept unless another team wins this way.`;
}

/** Every complete team the search finished and evaluated, the kept one marked. */
function comparedTeams(result) {
  const compared = result.compared || [];
  if (compared.length < 2) return null;
  const objective = result.search?.objective || {};
  const scores = (s) => [["Synergy", s.scores.synergy], ["Offense", s.scores.offense], ["Defense", s.scores.defense], ["Speed", s.scores.speed]];
  return h("section", { class: "bd-auto-compare" },
    h("div", { class: "bd-section-head" },
      h("h3", { class: "bd-field-label" }, "Compared teams"),
      h("span", { class: "bd-note" }, `${compared.length} complete teams`)),
    h("p", { class: "bd-note" }, comparedRule(objective, result.archetype || "")),
    h("div", { class: "bd-auto-compare-list" }, compared.map((team) => {
      const s = team.summary;
      const tiers = [
        `Checks failed: ${s.checksRed} red, ${s.checksYellow} yellow`,
        (objective.archetype ?? result.archetype) ? `Unmet critical ${objective.archetype || result.archetype} requirements: ${Number(s.archetypeUnmet) || 0}` : "",
        objective.metaTop ? `Added from outside the Top ${objective.metaTop}: ${Number(s.metaOutside) || 0}` : "",
        `Threats at 70+: ${s.threatsRed}`, `Critical threats: ${s.critical}`,
      ].filter(Boolean);
      return h("div", { class: `bd-auto-compare-row ${team.chosen ? "chosen" : ""}` },
        h("div", { class: "bd-auto-compare-main" },
          h("div", { class: "bd-auto-compare-title" },
            h("strong", {}, AUTO_TEAM_LABELS[team.label] || "Team"),
            team.chosen ? h("span", { class: "bd-pill good" }, "Picked") : null),
          h("p", { class: "bd-auto-compare-team" }, team.members.map((member, i) => [i ? ", " : "", member.added ? h("b", {}, name(member)) : name(member)])),
          h("p", { class: "bd-auto-compare-scores" }, scores(s).map(([label, value]) => h("span", {}, `${label} ${Number(value).toFixed(1)}`))),
          h("p", { class: "bd-note" }, tiers.join(" · "))),
        team.chosen ? null : h("button", { type: "button", class: "ghost-button compact", onclick: () => useComparedTeam(team, result) }, "Use this team"));
    })),
    h("p", { class: "bd-note" }, "Names in bold were added by Auto Build."));
}

function useComparedTeam(team, result) {
  const built = (team.sets || []).map((set) => (set ? makeSet(set) : makeSet()));
  setTeamSets(built, data, result.archetype ? { archetype: result.archetype } : {});
  toast("Current team replaced");
}

/** The tournament team closest to the built one, with what it has in common. */
function similarTeamCard(similar) {
  const verdict = similar.overlap >= 5
    ? `${similar.overlap} of your ${similar.size} Pokémon were played together in a tournament team.`
    : similar.overlap >= 3
      ? `Shares ${similar.overlap} of its ${similar.size} Pokémon with a tournament team.`
      : `No tournament team is close; the nearest shares ${similar.overlap} of its Pokémon.`;
  return h("section", { class: `bd-similar ${similar.overlap >= 5 ? "close" : ""}` },
    h("div", { class: "bd-section-head" },
      h("h3", { class: "bd-field-label" }, "Most similar tournament team"),
      h("span", { class: "bd-pill" }, `Team #${similar.number} · ${similar.overlap}/${similar.members.length} shared`)),
    h("p", { class: "bd-similar-verdict" }, verdict),
    format() === "Singles" ? h("p", { class: "bd-note" }, "The tournament teams come from Doubles events, so their sets are built for Doubles.") : null,
    h("div", { class: "bd-similar-members" }, similar.members.map((member) => {
      const set = { species: member.species, form: member.form, item: member.item };
      const detail = member.shared
        ? member.sameItem ? `Same item${member.sharedMoves ? ` · ${member.sharedMoves}/4 moves` : ""}` : `In yours${member.sharedMoves ? ` · ${member.sharedMoves}/4 moves` : ""}`
        : "Not in yours";
      return h("div", { class: `bd-similar-member ${member.shared ? "shared" : ""}`, title: [member.ability, member.nature ? `${member.nature} Nature` : "", ...(member.moves || [])].filter(Boolean).join(" · ") },
        h("div", { class: "bd-similar-art" }, sprite(data.sprite(member.species, member.form, member.item), "", 48)),
        h("strong", {}, name(set)),
        h("small", {}, member.item || "No item"),
        h("span", { class: `bd-similar-tag ${member.shared ? "good" : ""}` }, detail));
    })),
    similar.notInIt?.length ? h("p", { class: "bd-note" }, `Only in yours: ${similar.notInIt.map((m) => name(m)).join(", ")}.`) : null,
    h("div", { class: "bd-actions" },
      h("button", { type: "button", class: "ghost-button compact", onclick: () => loadTournamentTeam(similar) }, "Load it as a new team"),
      h("span", { class: "bd-note" }, "Hover a Pokémon for its Ability, Nature and moves.")));
}

function loadTournamentTeam(similar) {
  const list = similar.members.map((m) => makeSet({ species: m.species, form: m.form, item: m.item, ability: m.ability, moves: [...(m.moves || [])], nature: m.nature || "Serious", bonuses: [...(m.bonuses || [0, 0, 0, 0, 0, 0])] }));
  newTeam(list, data, `Tournament team #${similar.number}`);
  toast(`Tournament team #${similar.number} saved as a new team`);
  view.tab = "overview";
  renderAll();
}

// ---- test against tournament teams ----

const TOUR_LIMITS = [[100, "100"], [250, "250"], [500, "500"], [1000, "1,000"], [0, "All"]];

function tourName(mon) {
  return name({ species: mon.species, form: mon.form, item: mon.item }) || mon.form || mon.species;
}

function tourSprite(mon, size) {
  // Eager: the analysis is redrawn while the test runs, and a lazy image replaced
  // before it loads would leave an empty box.
  const img = sprite(data.sprite(mon.species, mon.form, mon.item), tourName(mon), size);
  img.setAttribute("loading", "eager");
  img.removeAttribute("decoding");
  return img;
}

function renderTournament() {
  const tour = view.tour;
  const list = sets().filter((s) => s.species);
  const left = freeRunsLeft("tournament");
  const singles = format() === "Singles";
  hosts.main.append(h("div", { class: "bd-panel-head" },
    h("div", {}, h("h2", {}, "Test against Tournament Teams"),
      h("p", {}, singles
        ? "Plays your team against real tournament teams, three against three and one at a time: turn 1 with Fake Out, Tailwind, Trick Room, Intimidate, sleep moves, Taunt and more, then the fight that follows. Shows how often you are favoured, which of yours to bring, how your Pokémon match up 1 vs 1, and which teams and Pokémon give you trouble."
        : "Plays your team against real tournament teams, 2 vs 2 from the leads on: turn 1 with Fake Out, Tailwind, Trick Room, Intimidate, Helping Hand, Wide Guard and more, then the fight that follows. Shows how often you are favoured, which of yours to bring, how your lead pairs match up against theirs, and which teams and Pokémon give you trouble."))));
  // The explanation leads until there is a result; after that it is one click away. A team
  // shorter than a full bring brings everyone, so the explanation says the real number.
  const how = tournamentExplainer({ teams: tour.snapshot?.library || 2827, format: format(), bring: tour.snapshot?.bring ?? Math.min(list.length, singles ? 3 : 4) });
  hosts.main.append(tour.snapshot || tour.running ? h("details", { class: "bd-tour-howto" }, h("summary", {}, "How the test works"), how) : how);
  if (!list.length) {
    hosts.main.append(h("div", { class: "bd-gate" }, h("h3", {}, "Nothing to test yet"), h("p", {}, "Add at least one Pokémon to the team first.")));
    return;
  }
  const key = evaluationKey();
  if (!tour.running && !tour.snapshot && !canRun("tournament")) {
    hosts.main.append(gate("tournament"));
    return;
  }
  const controls = h("div", { class: "bd-tour-controls" },
    h("div", { class: "bd-tour-limit" },
      h("span", { class: "bd-field-label" }, "Tournament teams"),
      segmented(TOUR_LIMITS, tour.limit, (value) => { tour.limit = value; }, { "aria-label": "Tournament teams to test" })),
    h("div", { class: "bd-actions" },
      tour.running
        ? h("button", { type: "button", class: "ghost-button", disabled: tour.stopping, onclick: stopTournament }, tour.stopping ? "Stopping…" : "Stop")
        : h("button", { type: "button", class: "primary-button", onclick: runTournament }, tour.snapshot ? "Run again" : "Start the test"),
      isPro() ? null : h("span", { class: "bd-pill" }, left > 0 ? `Pro feature · ${left} free ${left === 1 ? "try" : "tries"} left` : "Pro feature")));
  hosts.main.append(controls);
  // A test running for the other format keeps going; this format still shows its own
  // finished result underneath, so nothing the player already has disappears.
  const elsewhere = tour.running && tour.runFormat && tour.runFormat !== format();
  if (elsewhere) {
    hosts.main.append(h("p", { class: "bd-note" }, `A test for ${tour.runFormat} is running; its result is shown when ${tour.runFormat} is selected again. Stop it to test this team in ${format()}.`));
  }
  if (tour.running && !elsewhere) {
    const fraction = tour.snapshot ? tour.snapshot.tested / Math.max(1, tour.snapshot.total) : 0;
    hosts.main.append(h("div", { class: "bd-progress bd-tour-progress" },
      h("div", { class: "bd-progress-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(fraction * 100)) }, h("i", { style: { width: `${Math.round(fraction * 100)}%` } })),
      h("p", { class: "bd-note", "aria-live": "polite" }, tournamentProgress(tour.snapshot))));
  }
  if (tour.error) {
    hosts.main.append(problemCard("The test could not finish", tour.error, { onAction: runTournament }));
    return;
  }
  const stale = (!tour.running || elsewhere) && tour.snapshot && tour.key !== key;
  if (stale) {
    hosts.main.append(h("p", { class: "bd-note bd-stale-note" }, "The team or the settings changed since this test. Run it again to update it."));
  }
  tour.host = h("div", { class: `bd-tour-host ${stale ? "bd-stale" : ""}` });
  hosts.main.append(tour.host);
  paintTournament();
}

/** Redraws only the analysis (the controls stay put while the test runs), keeping opened sections open. */
function paintTournament() {
  const tour = view.tour;
  tour.paintQueued = false;
  if (!tour.host || !tour.host.isConnected) return;
  // Nothing to draw: no result for this format, and no test running for it either
  // (a test running for the other format has its own note above).
  if (!tour.snapshot && (!tour.running || (tour.runFormat && tour.runFormat !== format()))) {
    clear(tour.host);
    return;
  }
  tour.opened ||= new Map();
  clear(tour.host).append(tournamentAnalysis(tour.snapshot, { name: tourName, sprite: tourSprite, running: tour.running, loadTeam: loadTournamentTeam }));
  for (const node of tour.host.querySelectorAll("details[data-key]")) {
    if (tour.opened.has(node.dataset.key)) node.open = tour.opened.get(node.dataset.key);
    // Only what the viewer opens or closes is remembered (a click on the summary, also by keyboard).
    node.querySelector(":scope > summary")?.addEventListener("click", () => tour.opened.set(node.dataset.key, !node.open));
  }
}

async function runTournament() {
  const tour = view.tour;
  if (tour.running) return;
  if (!canRun("tournament")) {
    if (tour.snapshot) openGateDialog("tournament");
    else renderMain();
    return;
  }
  const key = evaluationKey();
  // The test belongs to the format it runs in; a switch meanwhile leaves it running for that format.
  const runFormat = format();
  Object.assign(tour, { running: true, stopping: false, error: "", snapshot: null, key, opened: new Map(), runFormat });
  resetTournamentView();
  renderMain();
  let lastPaint = 0;
  let snapshot = null;
  let failure = "";
  try {
    const request = analysis("tournament", { format: runFormat, sets: plainSets(), settings: evalSettings(), limit: tour.limit || 100000 }, (progress) => {
      if (!progress.snapshot) return;
      if (format() !== runFormat) {
        // The other format is on screen: keep the progress on this run's own shelf.
        formatShelf(runFormat).tourSnapshot = progress.snapshot;
        return;
      }
      const first = !tour.snapshot;
      tour.snapshot = progress.snapshot;
      if (view.tab !== "tournament") return;
      if (first) {
        renderMain();
        return;
      }
      // At most two redraws a second: the analysis moves while it runs, the buttons do not.
      const now = Date.now();
      if (now - lastPaint > 500) {
        lastPaint = now;
        const bar = hosts.main.querySelector(".bd-tour-progress");
        if (bar) {
          const fraction = tour.snapshot.tested / Math.max(1, tour.snapshot.total);
          const fill = bar.querySelector(".bd-progress-bar");
          fill.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
          fill.querySelector("i").style.width = `${Math.round(fraction * 100)}%`;
          bar.querySelector(".bd-note").textContent = tournamentProgress(tour.snapshot);
        }
        paintTournament();
      }
    });
    tour.requestId = request.requestId;
    const result = await request;
    snapshot = result;
    if (result.tested) rememberTournament(key, result);
    // A try counts for a test that ran its course, not for one the player cut short:
    // with "All" chosen, 100 of 2,827 teams is four seconds of a run worth minutes.
    if (result.tested >= result.total || result.tested >= Math.max(100, result.total / 2)) recordRun("tournament");
  } catch (error) {
    console.error(error);
    failure = String(error?.message || error || "Unknown error").split("\n")[0];
  }
  tour.running = false;
  tour.stopping = false;
  tour.requestId = 0;
  tour.runFormat = "";
  if (format() === runFormat) {
    tour.snapshot = snapshot;
    tour.error = failure;
  } else {
    // It finished while the other format was on screen: file it under its own format
    // and leave this format's own result alone.
    Object.assign(formatShelf(runFormat), { tourSnapshot: snapshot, tourKey: key, tourError: failure });
    toast(`The ${runFormat} tournament test has finished. Switch to ${runFormat} to see it.`);
  }
  if (view.tab === "tournament") renderMain();
}

// The last finished test survives a reload of the tab, like the last evaluation.
// v3: the snapshot with the lead matrix, bring options and the similar team
// (tournament-test.js SNAPSHOT_VERSION); older ones are dropped.
const TOURNAMENT_STORE = "cbd.tour.v3";

function rememberTournament(key, snapshot) {
  try {
    sessionStorage.setItem(TOURNAMENT_STORE, JSON.stringify({ key, snapshot }));
  } catch {
    // Storage full or disabled: the result is just not kept across reloads.
  }
}

function restoreTournament() {
  try {
    sessionStorage.removeItem("cbd.tour.v1");
    sessionStorage.removeItem("cbd.tour.v2");
    const saved = JSON.parse(sessionStorage.getItem(TOURNAMENT_STORE) || "null");
    const s = saved?.snapshot;
    const lists = ["bestBrings", "pokemon", "threats", "archetypes", "hardest", "easiest"];
    if (s?.version === 3 && s.tested > 0 && lists.every((name) => Array.isArray(s[name])) && s.bands && typeof s.active === "number"
      && Array.isArray(s.matrix?.rows) && Array.isArray(s.matrix?.columns) && s.matrix.rows.every((row) => Array.isArray(row.cells) && Array.isArray(row.members))
      && s.bestBrings.every((b) => Array.isArray(b.members) && Array.isArray(b.leads)) && (s.similar === null || Array.isArray(s.similar?.members))) {
      // Shown only in the format it was made for; otherwise it waits on that format's shelf.
      const fmt = keyFormat(saved.key) || format();
      if (fmt === format()) Object.assign(view.tour, { snapshot: s, key: saved.key || "" });
      else Object.assign(formatShelf(fmt), { tourSnapshot: s, tourKey: saved.key || "", tourError: "" });
    }
  } catch {
    // ignore
  }
}

function stopTournament() {
  const tour = view.tour;
  if (!tour.running || !tour.requestId) return;
  tour.stopping = true;
  cancelAnalysis(tour.requestId);
  renderMain();
}

async function runAutoBuild() {
  if (!canRun("autobuild")) {
    if (view.auto.result) openGateDialog("autobuild");
    else renderMain();
    return;
  }
  const auto = view.auto;
  if (auto.running) return;
  auto.running = true;
  auto.stopping = false;
  auto.error = "";
  auto.fraction = 0;
  auto.status = "Preparing the team and the candidate pool…";
  renderMain();
  const boxCount = allBoxSets().length;
  const key = evaluationKey();
  const depth = AUTO_DEPTHS.some(([k]) => k === auto.depth) ? auto.depth : "deep";
  // The app reuses Team Evaluation's scores only for the very team it evaluated.
  const cachedScores = auto.keep && view.evaluation && view.evaluationKey === key
    ? { synergy_score: view.evaluation.synergy_score, offense_score: view.evaluation.offense_score, defense_score: view.evaluation.defense_score, speed: view.evaluation.speed ? { score: view.evaluation.speed.score } : undefined }
    : null;
  // The team is built for this format; a switch meanwhile leaves the result on its shelf.
  const runFormat = format();
  auto.runFormat = runFormat;
  try {
    const request = analysis("autobuild", {
      format: runFormat,
      sets: auto.keep ? plainSets() : [],
      box: plainSets(allBoxSets()).filter(Boolean),
      onlyBox: Boolean(auto.onlyBox && boxCount),
      optimizeStats: Boolean(auto.optimizeStats),
      depth,
      search: depth,
      archetype: archetypeKey(auto.archetype),
      teamArchetype: currentTeam().archetype || "",
      prioritizeMeta: Boolean(auto.prioritizeMeta),
      settings: evalSettings(),
      checks: checkSelection(),
      cachedScores,
    }, (progress) => {
      auto.fraction = progress.fraction ?? auto.fraction;
      // The worker names candidates as the engine does; shown in Showdown spelling.
      if (progress.message) auto.status = showdownText(progress.message);
      if (view.tab !== "auto") return;
      // Only the bar and the line move while it runs, so the Stop button stays clickable.
      const bar = hosts.main.querySelector(".bd-auto-progress");
      if (!bar) {
        renderMain();
        return;
      }
      bar.querySelector(".bd-progress-bar")?.setAttribute("aria-valuenow", String(Math.round(auto.fraction * 100)));
      const fill = bar.querySelector(".bd-progress-bar i");
      if (fill) fill.style.width = `${Math.round(auto.fraction * 100)}%`;
      const line = bar.querySelector(".bd-auto-run .bd-note");
      if (line) line.textContent = auto.status;
    });
    auto.requestId = request.requestId;
    const result = await request;
    if (format() === runFormat) auto.result = result;
    else {
      Object.assign(formatShelf(runFormat), { autoResult: result, autoError: "" });
      toast(`The ${runFormat} Auto Build has finished. Switch to ${runFormat} to see it.`);
    }
    // A free run is used only by a scored team: a build stopped before its first team was
    // complete (no Team Evaluation) does not count.
    if (!result.error && result.evaluation) recordRun("autobuild");
  } catch (error) {
    console.error(error);
    const message = String(error?.message || error || "Unknown error").split("\n")[0];
    if (format() === runFormat) {
      auto.result = null;
      auto.error = message;
    } else Object.assign(formatShelf(runFormat), { autoResult: null, autoError: message });
  }
  auto.running = false;
  auto.stopping = false;
  auto.requestId = 0;
  auto.runFormat = "";
  renderMain();
}

/** Stop keeps the best team found so far (the worker answers with it). */
function stopAutoBuild() {
  const auto = view.auto;
  if (!auto.running || !auto.requestId) return;
  auto.stopping = true;
  auto.status = "Stopping: finishing the best team found so far…";
  cancelAnalysis(auto.requestId);
  if (view.tab === "auto") renderMain();
}

// ---- import / export ----

function renderImportExport() {
  const exportText = sets().filter((s) => s.species).map((set) => setToShowdown(set, data)).join("\n\n");
  const exportArea = h("textarea", { class: "bd-textarea", readonly: true, "aria-label": "Team export" }, exportText);
  const importArea = h("textarea", { class: "bd-textarea", placeholder: "Paste a Showdown team (up to six Pokémon)…", "aria-label": "Team import" });
  hosts.main.append(
    h("div", { class: "bd-panel-head" }, h("div", {}, h("h2", {}, "Import / Export"), h("p", {}, "Copy or paste teams in Showdown format. Stat Points go on the EVs line."))),
    h("div", { class: "bd-eval-grid" },
      h("div", { class: "bd-field" }, h("span", {}, `Export “${currentTeam().title}”`), exportArea,
        h("div", { class: "bd-actions" }, h("button", { type: "button", class: "ghost-button compact", onclick: async () => { try { await navigator.clipboard.writeText(exportText); toast("Copied to the clipboard"); } catch { exportArea.select(); } } }, "Copy"))),
      h("div", { class: "bd-field" }, h("span", {}, "Import"), importArea,
        h("div", { class: "bd-actions" },
          h("button", { type: "button", class: "primary-button compact", onclick: () => importTeam(importArea.value, "new") }, "Import as new team"),
          h("button", { type: "button", class: "ghost-button compact", onclick: () => importTeam(importArea.value, "replace") }, "Replace current team"),
          h("button", { type: "button", class: "ghost-button compact", onclick: () => importTeam(importArea.value, "box") }, "Add to Box")))));
}

function importTeam(text, mode) {
  const parsed = parseShowdown(text, data);
  if (!parsed.length) return toast("No Pokémon found in that text.", "error");
  if (mode === "box") {
    addToBox(parsed.map((set) => setToBoxEntry(set, data)));
    toast(`${parsed.length} Pokémon added to ${currentBox().name}`);
  } else if (mode === "replace") {
    setTeamSets(parsed.slice(0, TEAM_SIZE), data);
    toast("Team replaced");
  } else {
    newTeam(parsed.slice(0, TEAM_SIZE), data, "Imported Team");
    toast("Imported as a new team");
  }
}

// --- format -------------------------------------------------------------------------

function syncFormatSwitch() {
  document.querySelectorAll("[data-format]").forEach((button) => {
    const active = button.dataset.format === format();
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

// --- profile links: /team-builder/?add=Salamence -------------------------------------

async function handleAddParam() {
  const params = new URLSearchParams(location.search);
  const wanted = params.get("add");
  if (!wanted) return;
  history.replaceState(null, "", location.pathname);
  const [species, form] = data.resolveName(wanted);
  if (!data.speciesEntry(species)) return toast(`Could not find ${wanted}.`, "error");
  const set = setFromCommon(data.commonSet(format(), species, form));
  await addToTeamFlow(set);
  view.tab = "overview";
  renderAll();
  const banner = document.getElementById("addBanner");
  if (banner) {
    banner.hidden = false;
    banner.querySelector("[data-name]").textContent = name(set);
  }
}

// --- boot ----------------------------------------------------------------------------------

async function main() {
  try {
    data = await BuilderData.load();
    const params = new URLSearchParams(location.search);
    const wantedFormat = params.get("format");
    if (wantedFormat === "Singles" || wantedFormat === "Doubles") setFormat(wantedFormat);
    await data.loadMeta(format());
    mount();
    restoreEvaluation();
    restoreTournament();
    renderAll();
    document.querySelectorAll("[data-format]").forEach((button) => button.addEventListener("click", async () => {
      const from = format();
      setFormat(button.dataset.format);
      switchFormatResults(from, format());
      await data.loadMeta(format());
      view.overview = null;
      view.overviewKey = "";
      renderAll();
    }));
    subscribe((_state, reason) => {
      if (reason === "format") return;
      // The overview's Top-X only redraws the overview; a finished analysis stays.
      if (reason === "overviewTop") return;
      view.suggestions = null;
      renderAll();
    });
    onSyncStatus(() => renderToolbar());
    await handleAddParam();
    initSync(data);
    refreshLicence().then(() => renderToolbar());
    document.getElementById("addBanner")?.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => {
      view.tab = button.dataset.action;
      renderAll();
      document.getElementById("addBanner").hidden = true;
      if (button.dataset.action === "auto") root.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  } catch (error) {
    console.error(error);
    clear(root).append(h("div", { class: "bd-card bd-error" }, h("h2", {}, "The Team Builder could not load its data."), h("p", {}, "Reload the page. If it keeps happening, tell us on Discord."), h("code", {}, String(error.message || error))));
  }
}

main();
