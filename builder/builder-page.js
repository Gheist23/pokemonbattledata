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
  checksView, openChecksDialog, openPressureDialog, openSettingsDialog, openSynergyDialog, speedTiersView, speedView, suggestionsView, threatsView,
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
  removeFromBox, renameBox, renameTeam, replaceBoxEntry, selectBox, selectTeam, setFormat, setSetting, setSlot, setTeamSets,
  subscribe, swapSlots, teamSets,
} from "./store.js";
import { activate, canRun, deactivate, freeRunsLeft, isPro, licenceSummary, recordRun, refreshLicence } from "./pro.js";
import { tournamentAnalysis, tournamentExplainer } from "./tournament-view.js";
import { clear, confirmDialog, editSet, h, openDialog, problemCard, scoreRing, segmented, select, sprite, switchRow, toast, typeChip } from "./ui.js";
import { initSync, openSyncDialog, syncStatus, onSyncStatus } from "./sync.js";

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
  speedState: { top_x: 30, weather: "None", own_tailwind: false, opposing_tailwind: false, trick_room: false, our_stage: 0, opponent_stage: 0 },
  speedTiers: null,
  speedTiersKey: "",
  speedTiersBusy: "",
  speedTiersError: null,
  suggestions: null,
  suggesting: false,
  suggestProgress: 0,
  suggestStatus: "",
  suggestError: "",
  optimize: {},
  auto: { running: false, fraction: 0, status: "", result: null, error: "", keep: true, onlyBox: false, depth: "medium", archetype: "automatic", prioritizeMeta: false },
  tour: { running: false, stopping: false, limit: 1000, snapshot: null, error: "", requestId: 0, key: "", host: null, paintQueued: false },
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

function name(set) {
  const [species, form] = data.battleForm(set.species, set.form, set.item);
  return data.displayName(species, form);
}

/** The app's Team Evaluation settings, as saved on this device. */
function evalSettings() {
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...(getState().settings.evaluation || {}) });
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
  openSettingsDialog(evalSettings(), (next) => {
    setSetting("evaluation", normalizeSettings(next));
    toast("Settings saved. They apply to the next Team Evaluation, Suggestions and Auto Build.");
  });
}

function openCustomizeChecks() {
  const checks = new TeamChecks({ engine: data.engine });
  openChecksDialog(checks.checkList(), checks.selectedIds(checkSelection()), (ids) => {
    setSetting("teamChecks", ids);
    toast("Team Building Checks updated. Run the evaluation again to apply them.");
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
    h("button", { type: "button", class: "bd-tab", onclick: openEvaluationSettings, title: "Team Evaluation, Suggestions and Auto Build settings" }, "Settings"),
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
  const team = currentTeam();
  const titleInput = h("input", { type: "text", class: "bd-input", value: team.title, maxlength: 80, "aria-label": "Team title" });
  titleInput.addEventListener("change", () => renameTeam(team.id, titleInput.value.trim() || team.title));
  const archetype = select(ARCHETYPES.filter((a) => a !== "Auto"), team.archetype || "Balanced", (value) => renameTeam(team.id, undefined, value), { "aria-label": "Archetype" });
  hosts.main.append(
    h("div", { class: "bd-team-meta" },
      h("label", { class: "bd-field" }, h("span", {}, "Title"), titleInput),
      h("label", { class: "bd-field" }, h("span", {}, "Archetype"), archetype)),
    h("div", { class: "bd-subtabs", role: "tablist", "aria-label": "Overview" },
      [["offense", "Offense"], ["defense", "Defense"], ["speed", "Speed"], ["meta", `Top ${overviewTop()} Meta`]].map(([id, label]) => h("button", {
        type: "button",
        class: `bd-tab ${view.overviewTab === id ? "on" : ""}`,
        role: "tab",
        "aria-selected": view.overviewTab === id ? "true" : "false",
        onclick: () => { view.overviewTab = id; renderMain(); },
      }, label))));
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
  if (view.overviewTab === "meta") {
    body.append(metaGrid((overviewData.meta?.records || []).map((r) => ({ name: data.displayName(r.pokemon, r.form) || r.name, species: r.pokemon, form: r.entry_form || r.form, item: r.item, position: r.position }))));
    return;
  }
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
function speedTiersPanel(title = "Speed Tiers") {
  const key = `${teamKey()}|${JSON.stringify(view.speedState)}`;
  const failed = view.speedTiersError?.key === key ? view.speedTiersError.message : "";
  if (view.speedTiersKey !== key && !failed) requestSpeedTiers(key);
  const stale = view.speedTiersKey !== key;
  const panel = speedTiersView(stale ? null : view.speedTiers, view.speedState, {
    spriteFor,
    title,
    error: failed,
    onRetry: () => { view.speedTiersError = null; renderMain(); },
    onState: (next) => {
      view.speedState = next;
      renderMain();
    },
  });
  return panel;
}

function requestSpeedTiers(key) {
  if (view.speedTiersBusy === key) return;
  view.speedTiersBusy = key;
  analysis("speedTiers", { format: format(), sets: plainSets(), settings: evalSettings(), state: view.speedState }).then((result) => {
    if (view.speedTiersBusy !== key) return;
    for (const row of result.rows || []) row.name = data.displayName(row.species, row.form) || row.name;
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

/** The app shares one Top-X between the Speed list and the Team Overview charts. */
function overviewTop() {
  return Number(view.speedState?.top_x) || getState().settings.overviewTop || 30;
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

function metaGrid(meta) {
  return h("div", { class: "bd-box-grid" }, meta.map((row) => h("div", { class: "bd-box-card", style: { cursor: "default" } },
    sprite(data.sprite(row.species, row.form, row.item), "", 56),
    h("strong", {}, `#${row.position} ${row.name}`),
    h("small", {}, data.itemIcon(row.item) ? h("img", { src: data.itemIcon(row.item), alt: "", width: 14, height: 14 }) : null, row.item || "—"),
    h("div", { class: "bd-box-card-actions" },
      h("button", { type: "button", class: "bd-mini-button", title: `Add ${row.name} to the team`, "aria-label": `Add ${row.name} to the team`, onclick: () => addToTeamFlow(setFromCommon(data.commonSet(format(), row.species, row.form))) }, "+"),
      h("button", { type: "button", class: "bd-mini-button", title: `Add ${row.name} to the Box`, "aria-label": `Add ${row.name} to the Box`, onclick: () => { addToBox([setToBoxEntry(setFromCommon(data.commonSet(format(), row.species, row.form)), data)]); toast(`${row.name} added to ${currentBox().name}`); } }, "⇩"),
      h("button", { type: "button", class: "bd-mini-button", title: `Calculate against ${row.name}`, "aria-label": `Calculate against ${row.name}`, onclick: () => openInCalc(setFromCommon(data.commonSet(format(), row.species, row.form)), "right") }, "⚔")))));
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
    h("div", {}, h("h2", {}, "Team Evaluation"), h("p", {}, `Scores the team against the Top ${settings.top_meta} ${format()} Meta with the Companion's own Team Evaluation: the same damage engine, threat calcs, checks and scores.`)),
    h("div", { class: "bd-actions" },
      h("button", { type: "button", class: "ghost-button compact", onclick: openEvaluationSettings }, "Settings"),
      hasResult && !view.evaluating ? h("button", { type: "button", class: "primary-button compact", onclick: () => runEvaluation(key) }, view.evaluationKey === key ? "Run again" : "Evaluate changes") : null)));
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
      h("p", {}, "Team Evaluation scores Synergy, Offense, Defense and Speed, runs the Team Building Checks, and lists every critical threat in the meta with the calcs behind it."),
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
    scoreButton("Speed", result.speed.score, () => { view.evalTab = "speed"; renderMain(); }, "Speed Control")));
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
  else if (view.evalTab === "speed") wrap.append(speedView(result), speedTiersPanel("Speed Tiers"));
  hosts.main.append(wrap);
}

function memberName(result, slot) {
  const members = result.synergy_members || [];
  const wanted = showdownName(slot.form || slot.species);
  return members.find((m) => m.name === wanted)?.name || wanted;
}

let namer = null;
function showdownName(value) {
  namer ||= new TeamChecks({ engine: data.engine });
  return namer.showdownName(value);
}

function scoreButton(label, value, onClick, hint) {
  return h("button", { type: "button", class: "bd-score", onclick: onClick, title: `Open ${hint}` },
    scoreRing(value, label), h("span", { class: "bd-score-text" }, h("strong", {}, label), h("small", {}, "Details ›")));
}

/** A score shown without anything behind it (Auto Build's result). */
function scoreCard(label, value) {
  return h("div", { class: "bd-score static" }, scoreRing(value, label), h("span", { class: "bd-score-text" }, h("strong", {}, label)));
}

function suggestionsPanel() {
  const list = sets();
  if (view.suggestError && !view.suggesting) {
    return problemCard("Suggestions could not be calculated", view.suggestError, { onAction: runSuggestions });
  }
  return suggestionsView(view.suggestions, {
    spriteFor,
    running: view.suggesting,
    progress: view.suggestProgress,
    status: view.suggestStatus,
    full: !list.some((s) => !s.species),
    onRun: runSuggestions,
    onUse: useSuggestion,
  });
}

const STAT_SHORT = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];
const spreadText = (bonuses) => (bonuses || []).map((v, i) => `${STAT_SHORT[i]} ${v}`).join(" / ");

/** The app's Optimize: one member's Stat Points tuned against the Top-X threats, moves held. */
function optimizePanel() {
  const list = sets();
  const key = teamKey(list);
  const holder = h("div", { class: "bd-list" },
    h("p", { class: "bd-section-note" }, `Tunes one member's Stat Points against every Top ${evalSettings().top_meta} threat (two sets each), exactly like the Companion's Optimize: each 8, 4, 2 and 1-point transfer is tried and kept only when it wins or saves more KOs, weighted by how common the threat is, plus up to 10 points for newly outspeeding threats. Moves and Nature stay as they are.`));
  list.forEach((set, slot) => {
    if (!set.species) return;
    const state = view.optimize[slot] && view.optimize[slot].key === key ? view.optimize[slot] : null;
    const result = state?.result;
    const card = h("details", { class: "bd-suggestion", open: Boolean(result) });
    const side = h("div", { class: "bd-suggestion-side" },
      state?.running
        ? h("span", { class: "bd-note" }, `${Math.round((state.fraction || 0) * 100)}%`)
        : h("button", { type: "button", class: "ghost-button compact", onclick: (event) => { event.preventDefault(); runOptimize(slot); } }, result ? "Run again" : "Optimize"));
    card.append(h("summary", {},
      sprite(data.sprite(set.species, set.form, set.item), "", 44),
      h("div", {},
        h("h3", {}, name(set)),
        h("p", {}, `${set.nature || "Serious"} · ${spreadText(set.bonuses)}`),
        state?.running ? h("p", { class: "bd-note", "aria-live": "polite" }, state.status || "Preparing…") : null),
      side));
    if (result) {
      if (!result.ok) {
        card.append(h("p", { class: "bd-note", style: { padding: "0 0.8rem 0.6rem" } }, result.message || "No transfer improves the ranked matchups; keep the current investment."));
      } else {
        card.append(
          h("div", { class: "bd-optimize-result" },
            h("p", {}, h("strong", {}, `Set Stat Points to ${spreadText(result.spread.bonuses)}`)),
            h("p", { class: "bd-note" }, `+${result.score.toFixed(1)} against the Top ${result.top_meta} (${result.damage >= 0 ? "+" : ""}${result.damage.toFixed(1)} from KO odds, ${result.speed >= 0 ? "+" : ""}${result.speed.toFixed(1)} from Speed) · Speed ${result.speed_before} → ${result.speed_after} · ${result.improved} matchups better, ${result.worsened} worse · ${result.tested} spreads tested in ${result.seconds.toFixed(1)} s`),
            h("div", { class: "bd-gate-actions", style: { justifyContent: "flex-start" } },
              h("button", { type: "button", class: "primary-button compact", onclick: () => applyOptimize(slot, result) }, "Apply"))),
          h("ul", { class: "bd-suggestion-details" }, (result.comparisons || []).slice(0, 12).map((row) => h("li", { class: row.score > 0 ? "bd-good-text" : "bd-bad-text" },
            h("strong", {}, `${row.threat}: `), `${row.detail} `, h("span", { class: "bd-note" }, `${row.previous} → ${row.now}`)))));
      }
    }
    holder.append(card);
  });
  return holder;
}

async function runOptimize(slot) {
  const list = sets();
  const key = teamKey(list);
  const state = { key, running: true, fraction: 0, status: "Preparing the Top Meta threats…" };
  view.optimize[slot] = state;
  renderMain();
  try {
    state.result = await analysis("optimize", { format: format(), sets: plainSets(list), slot, settings: evalSettings(), checks: checkSelection() }, (progress) => {
      state.fraction = progress.fraction ?? state.fraction;
      if (progress.message) state.status = progress.message;
      if (view.tab === "evaluation" && view.evalTab === "optimize") renderMain();
    });
  } catch (error) {
    console.error(error);
    state.result = { ok: false, message: `Optimize could not finish: ${String(error?.message || error || "Unknown error").split("\n")[0]}` };
  }
  state.running = false;
  renderMain();
}

function applyOptimize(slot, result) {
  const set = sets()[slot];
  if (!set?.species || !result?.spread) return;
  setSlot(slot, makeSet({ ...set, nature: result.spread.nature_name || set.nature, bonuses: [...result.spread.bonuses] }), data);
  view.optimize[slot] = null;
  toast(`${name(set)}: Stat Points set to ${spreadText(result.spread.bonuses)}`);
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

async function runSuggestions() {
  view.suggesting = true;
  view.suggestError = "";
  view.suggestProgress = 0;
  view.suggestStatus = "Evaluating the current team…";
  renderMain();
  try {
    view.suggestions = await analysis("suggestions", { format: format(), sets: plainSets(), settings: evalSettings(), checks: checkSelection() }, (progress) => {
      view.suggestProgress = progress.fraction ?? view.suggestProgress;
      if (progress.message) view.suggestStatus = progress.message;
      if (view.tab === "evaluation" && view.evalTab === "suggest") renderMain();
    });
  } catch (error) {
    console.error(error);
    view.suggestError = String(error?.message || error || "Unknown error").split("\n")[0];
  }
  view.suggesting = false;
  renderMain();
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
  try {
    const result = await analysis("evaluate", { format: format(), sets: plainSets(), settings: evalSettings(), checks: checkSelection() }, (progress) => {
      view.evalProgress = progress.fraction ?? view.evalProgress;
      if (progress.message) view.evalStatus = progress.message;
      if (view.tab === "evaluation") renderMain();
    });
    if (!isEvaluation(result)) throw new Error("The evaluation came back incomplete.");
    view.evaluation = result;
    view.evaluationKey = key;
    recordRun("evaluation");
    rememberEvaluation(key, result);
  } catch (error) {
    console.error(error);
    view.evalError = String(error?.message || error || "Unknown error").split("\n")[0];
  }
  view.evaluating = false;
  renderMain();
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
      view.evaluation = saved.result;
      view.evaluationKey = saved.key;
    } else if (saved) {
      forgetEvaluation();
    }
  } catch {
    // ignore
  }
}

// ---- auto build ----

const AUTO_DEPTHS = [
  ["fast", "Fast", "Screens the 40 most-used Pokémon per slot and keeps the best one."],
  ["medium", "Medium", "Screens the 100 most-used Pokémon per slot with two finalists each. The Companion's default."],
  ["deep", "Deep", "Screens every ranked Pokémon per slot with four finalists each."],
];

function renderAuto() {
  const auto = view.auto;
  const boxCount = allBoxSets().length;
  const locked = sets().filter((s) => s.species);
  hosts.main.append(h("div", { class: "bd-panel-head" },
    h("div", {}, h("h2", {}, "Auto Build Team"),
      h("p", {}, "Fills the open slots the way the Companion does: every candidate is scored by the Suggestions engine, the enabled Team Building Checks decide first and the score second, and the finished team is tuned for its own weather, Megas, speed mode and sets.")),
    h("div", { class: "bd-actions" }, h("button", { type: "button", class: "ghost-button compact", onclick: openEvaluationSettings }, "Settings"))));
  if (auto.running) {
    hosts.main.append(h("div", { class: "bd-progress" },
      h("div", { class: "bd-progress-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(auto.fraction * 100)) }, h("i", { style: { width: `${Math.round(auto.fraction * 100)}%` } })),
      h("p", { class: "bd-note", "aria-live": "polite" }, auto.status)));
    return;
  }
  if (!auto.result && !canRun("autobuild")) {
    hosts.main.append(gate("autobuild"));
    return;
  }
  const depthNote = (AUTO_DEPTHS.find(([key]) => key === (auto.depth || "medium")) || AUTO_DEPTHS[1])[2];
  const topMeta = evalSettings().top_meta;
  hosts.main.append(h("div", { class: "bd-auto-options" },
    h("div", { class: "bd-auto-col" },
      h("div", { class: "bd-auto-depth" },
        h("span", { class: "bd-field-label" }, "Depth"),
        segmented(AUTO_DEPTHS.map(([key, label]) => [key, label]), auto.depth || "medium", (value) => { auto.depth = value; renderMain(); }, { "aria-label": "Depth" }),
        h("p", { class: "bd-note" }, depthNote)),
      h("label", { class: "bd-auto-depth" },
        h("span", { class: "bd-field-label" }, "Preferred archetype"),
        select(AUTO_BUILD_ARCHETYPES.map(([label, key]) => [key, label]), archetypeKey(auto.archetype), (value) => { auto.archetype = archetypeKey(value); renderMain(); }, { "aria-label": "Preferred archetype" }),
        h("p", { class: "bd-note" }, archetypeDescription(auto.archetype)))),
    h("div", { class: "bd-auto-switches" },
      switchRow(locked.length ? `Keep the current ${locked.length} Pokémon` : "Keep the current team", auto.keep, (on) => { auto.keep = on; }),
      switchRow(boxCount ? "Only use my Box" : "Only use my Box (empty)", Boolean(auto.onlyBox && boxCount), (on) => { auto.onlyBox = on; }, { disabled: !boxCount, hint: "Build only from the Pokémon in your Box." }),
      switchRow("Prioritize Meta Pokémon", Boolean(auto.prioritizeMeta), (on) => { auto.prioritizeMeta = on; }, { hint: `Ranks the Top ${topMeta} ${format()} Meta ahead of other Pokémon once the Team Building Checks are settled.` }),
      switchRow("Optimize Stat Points", Boolean(auto.optimizeStats), (on) => { auto.optimizeStats = on; }, { hint: "After the build, tune every member's Stat Points and Nature (slower)." })),
    h("div", { class: "bd-actions" },
      h("button", { type: "button", class: "primary-button", onclick: runAutoBuild }, auto.result ? "Build again" : "Start Auto Build"),
      h("span", { class: "bd-note" }, "Uses the Team Evaluation Settings and your Team Building Checks."))));
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
  // Only what the reader should know: a rule the last slot could not keep, a move it could not add.
  const caveats = (result.log || []).filter((line) => /^No Pokémon for the last slot|^Auto Build could not reach|^Auto Build reached \d/.test(line));
  hosts.main.append(h("section", { class: "bd-auto-result" },
    h("div", { class: "bd-section-head" },
      h("h3", { class: "bd-field-label" }, "Result"),
      h("span", { class: "bd-note" }, [archetypeLine, evaluation ? `${evaluation.threats.length} critical threat${evaluation.threats.length === 1 ? "" : "s"} left` : "", result.seconds ? `built in ${result.seconds.toFixed(1)} s` : ""].filter(Boolean).join(" · "))),
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
          h("div", { class: "bd-move-chips" }, (set.moves || []).filter(Boolean).map((move) => h("span", {}, move)))));
    })),
    result.similar ? similarTeamCard(result.similar) : null,
    h("div", { class: "bd-actions" },
      h("button", { type: "button", class: "primary-button", onclick: () => { newTeam(built, data, `Auto Build ${new Date().toLocaleDateString()}`); renameTeam(currentTeam().id, undefined, teamLabel); toast("Saved as a new team"); view.tab = "overview"; renderAll(); } }, "Save as new team"),
      h("button", { type: "button", class: "ghost-button", onclick: () => { setTeamSets(built, data, { archetype: teamLabel }); toast("Current team replaced"); } }, "Replace current team"))));
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
  hosts.main.append(h("div", { class: "bd-panel-head" },
    h("div", {}, h("h2", {}, "Test against Tournament Teams"),
      h("p", {}, "A fast Matchup Matrix of your team against real tournament teams, with a live analysis of how it fares: your best and worst cores, how each of your Pokémon does, and the teams and Pokémon that give you the most trouble.")),
    h("div", { class: "bd-actions" }, h("button", { type: "button", class: "ghost-button compact", onclick: openEvaluationSettings }, "Settings"))));
  // The explanation leads until there is a result; after that it is one click away.
  const how = tournamentExplainer(2827);
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
  if (tour.running) {
    const fraction = tour.snapshot ? tour.snapshot.tested / Math.max(1, tour.snapshot.total) : 0;
    hosts.main.append(h("div", { class: "bd-progress bd-tour-progress" },
      h("div", { class: "bd-progress-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(fraction * 100)) }, h("i", { style: { width: `${Math.round(fraction * 100)}%` } })),
      h("p", { class: "bd-note", "aria-live": "polite" }, tour.snapshot ? `${tour.snapshot.tested.toLocaleString("en-US")} of ${tour.snapshot.total.toLocaleString("en-US")} teams · ${tour.snapshot.seconds.toFixed(1)} s` : "Loading the tournament teams…")));
  }
  if (tour.error) {
    hosts.main.append(problemCard("The test could not finish", tour.error, { onAction: runTournament }));
    return;
  }
  if (!tour.running && tour.snapshot && tour.key !== key) {
    hosts.main.append(h("p", { class: "bd-note bd-stale-note" }, "The team or the settings changed since this test. Run it again to update it."));
  }
  tour.host = h("div", { class: `bd-tour-host ${!tour.running && tour.snapshot && tour.key !== key ? "bd-stale" : ""}` });
  hosts.main.append(tour.host);
  paintTournament();
}

/** Redraws only the analysis (the controls stay put while the test runs). */
function paintTournament() {
  const tour = view.tour;
  tour.paintQueued = false;
  if (!tour.host || !tour.host.isConnected) return;
  if (!tour.snapshot && !tour.running) {
    clear(tour.host);
    return;
  }
  clear(tour.host).append(tournamentAnalysis(tour.snapshot, { name: tourName, sprite: tourSprite, running: tour.running }));
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
  Object.assign(tour, { running: true, stopping: false, error: "", snapshot: null, key });
  renderMain();
  let lastPaint = 0;
  try {
    const request = analysis("tournament", { format: format(), sets: plainSets(), settings: evalSettings(), limit: tour.limit || 100000 }, (progress) => {
      if (!progress.snapshot) return;
      const first = !tour.snapshot;
      tour.snapshot = progress.snapshot;
      if (view.tab !== "tournament") return;
      if (first) {
        renderMain();
        return;
      }
      // At most a few redraws a second: the analysis moves while it runs, the buttons do not.
      const now = Date.now();
      if (now - lastPaint > 350) {
        lastPaint = now;
        const bar = hosts.main.querySelector(".bd-tour-progress");
        if (bar) {
          const fraction = tour.snapshot.tested / Math.max(1, tour.snapshot.total);
          bar.querySelector(".bd-progress-bar i").style.width = `${Math.round(fraction * 100)}%`;
          bar.querySelector(".bd-note").textContent = `${tour.snapshot.tested.toLocaleString("en-US")} of ${tour.snapshot.total.toLocaleString("en-US")} teams · ${tour.snapshot.seconds.toFixed(1)} s`;
        }
        paintTournament();
      }
    });
    tour.requestId = request.requestId;
    const result = await request;
    tour.snapshot = result;
    if (result.tested) rememberTournament(key, result);
    // A try counts once it has shown a real result, not for a test stopped straight away.
    if (result.tested >= Math.min(result.total, 100)) recordRun("tournament");
  } catch (error) {
    console.error(error);
    tour.error = String(error?.message || error || "Unknown error").split("\n")[0];
  }
  tour.running = false;
  tour.stopping = false;
  tour.requestId = 0;
  if (view.tab === "tournament") renderMain();
}

// The last finished test survives a reload of the tab, like the last evaluation.
const TOURNAMENT_STORE = "cbd.tour.v1";

function rememberTournament(key, snapshot) {
  try {
    sessionStorage.setItem(TOURNAMENT_STORE, JSON.stringify({ key, snapshot }));
  } catch {
    // Storage full or disabled: the result is just not kept across reloads.
  }
}

function restoreTournament() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOURNAMENT_STORE) || "null");
    if (saved?.snapshot?.tested && Array.isArray(saved.snapshot.bestCores) && Array.isArray(saved.snapshot.archetypes)) {
      view.tour.snapshot = saved.snapshot;
      view.tour.key = saved.key || "";
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
  auto.running = true;
  auto.error = "";
  auto.fraction = 0;
  auto.status = "Preparing the team and the candidate pool…";
  renderMain();
  const boxCount = allBoxSets().length;
  const key = evaluationKey();
  // The app reuses Team Evaluation's scores only for the very team it evaluated.
  const cachedScores = auto.keep && view.evaluation && view.evaluationKey === key
    ? { synergy_score: view.evaluation.synergy_score, offense_score: view.evaluation.offense_score, defense_score: view.evaluation.defense_score, speed: view.evaluation.speed ? { score: view.evaluation.speed.score } : undefined }
    : null;
  try {
    const result = await analysis("autobuild", {
      format: format(),
      sets: auto.keep ? plainSets() : [],
      box: plainSets(allBoxSets()).filter(Boolean),
      onlyBox: Boolean(auto.onlyBox && boxCount),
      optimizeStats: Boolean(auto.optimizeStats),
      depth: auto.depth || "medium",
      archetype: archetypeKey(auto.archetype),
      teamArchetype: currentTeam().archetype || "",
      prioritizeMeta: Boolean(auto.prioritizeMeta),
      settings: evalSettings(),
      checks: checkSelection(),
      cachedScores,
    }, (progress) => {
      auto.fraction = progress.fraction ?? auto.fraction;
      if (progress.message) auto.status = progress.message;
      if (view.tab === "auto") renderMain();
    });
    auto.result = result;
    if (!result.error) recordRun("autobuild");
  } catch (error) {
    console.error(error);
    auto.result = null;
    auto.error = String(error?.message || error || "Unknown error").split("\n")[0];
  }
  auto.running = false;
  renderMain();
}

// ---- import / export ----

function renderImportExport() {
  const exportText = sets().filter((s) => s.species).map((set) => setToShowdown(set, data)).join("\n\n");
  const exportArea = h("textarea", { class: "bd-textarea", readonly: true, "aria-label": "Team export" }, exportText);
  const importArea = h("textarea", { class: "bd-textarea", placeholder: "Paste a Showdown team (up to six Pokémon)…", "aria-label": "Team import" });
  hosts.main.append(
    h("div", { class: "bd-panel-head" }, h("div", {}, h("h2", {}, "Import / Export"), h("p", {}, "Showdown format, as the Companion imports and exports it. Stat Points go in the EVs line."))),
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
  const [species, form] = data.resolve(wanted, wanted);
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
    await data.loadMeta(format());
    const params = new URLSearchParams(location.search);
    const wantedFormat = params.get("format");
    if (wantedFormat === "Singles" || wantedFormat === "Doubles") setFormat(wantedFormat);
    mount();
    restoreEvaluation();
    restoreTournament();
    renderAll();
    document.querySelectorAll("[data-format]").forEach((button) => button.addEventListener("click", async () => {
      setFormat(button.dataset.format);
      await data.loadMeta(format());
      view.overview = null;
      view.overviewKey = "";
      renderAll();
    }));
    subscribe((_state, reason) => {
      if (reason === "format") return;
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
