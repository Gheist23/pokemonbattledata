// Solver page: set a board up, search it, read the best move for each side.
//
// The search itself is builder/solver.js and runs in builder/analysis-worker.js, for the same
// reason Team Evaluation does: it is thousands of damage calculations and must not freeze the
// page. This file is the board and the results.
//
// Free runs work exactly as they do for Team Evaluation, Auto Build and the Tournament Test: a
// visitor gets FREE_RUNS complete searches, counted only when a search really finished, and the
// panel says how many are left before the first one is used.

import { BuilderData, makeSet, monFromSet, parseShowdown, setFromCommon } from "./common.js";
import { STAT_KEYS } from "./engine.js";
import { FREE_RUNS, canRun, freeRunsLeft, isPro, recordRun } from "./pro.js";
import { LOOKAHEAD_RANGE, DEFAULT_LOOKAHEAD, SOLVER_FEATURE, SWITCH } from "./solver.js";
import { clear, editSet, h, openDialog, pickPokemon, segmented, select, sprite, toast } from "./ui.js";
import { currentTeam, getState, subscribe, teamSets } from "./store.js";


// The stale-module guard in the page's HTML watches for the module graph being refused
// wholesale, which is what a cached module with mismatched exports causes. It cannot see that
// from the DOM alone -- a page mid-analysis looks the same as a page that never started -- so it
// reads this instead. An import that fails takes the whole graph with it and this never runs,
// which is exactly the case the guard is for.
try { window.__bdPageModuleRan = true; } catch { /* no window: nothing to guard */ }

const STORAGE_KEY = "cbd.solver.v1";
/**
 * How long a search runs before it answers.
 *
 * A fixed budget, because pressing Solve should be the whole gesture: the answer arrives without
 * anyone having to decide when it is ready. Twenty seconds is between one and two million lines
 * on an ordinary laptop, which is far past the point where the order of the top few stops
 * moving on any board tested here.
 *
 * Stop is still there, and it still works -- it ends the run early and reports what has been
 * played so far -- but nothing waits for it.
 */
const SEARCH_SECONDS = 20;
const BRING = { Doubles: 4, Singles: 3 };
const ACTIVE = { Doubles: 2, Singles: 1 };
/** A team is six; the bring is how many of them are in the simulation. */
const TEAM_SIZE = 6;
const WEATHERS = ["None", "Sun", "Rain", "Sand", "Snow"];
const TERRAINS = ["None", "Electric", "Grassy", "Misty", "Psychic"];
/** Every condition the game has, not only the two the turn model tracks itself: the rest still
 *  change the damage, which is what the calculator reads them for. */
const STATUSES = [["", "Healthy"], ["poison", "Poisoned"], ["toxic", "Badly Poisoned"],
  ["burn", "Burned"], ["paralysis", "Paralyzed"], ["sleep", "Asleep"], ["freeze", "Frozen"]];
const STAGES = [["atk", "Atk"], ["def", "Def"], ["spa", "SpA"], ["spd", "SpD"], ["spe", "Spe"]];
const SIDE_LABEL = ["Your side", "Their side"];

let data;
let worker = null;
let requestId = 0;
const pending = new Map();
const root = document.getElementById("solverApp");

const state = {
  format: "Doubles",
  sides: [[], []],
  field: emptyField(),
  lookahead: DEFAULT_LOOKAHEAD,
  running: false,
  runId: 0,
  // Whether this run was ended by the Stop button rather than by its own time budget. A
  // stopped run must not spend one of the three free searches: the panel invites you to
  // "Press Stop whenever it has settled" and the Pro dialog says you have had three COMPLETE
  // searches, so charging for a stopped one contradicts the page twice over.
  stopped: false,
  progress: null,
  result: null,
  error: "",
  importTeamId: "",
  // Which Pokemon on the board has been picked up and is waiting for a partner to change places
  // with. The board is the only thing that reads it.
  pick: null,
};

// --- the worker --------------------------------------------------------------------------

function analysis(type, payload, onProgress) {
  if (!worker) {
    worker = new Worker(new URL("./analysis-worker.js", import.meta.url), { type: "module" });
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
      for (const entry of pending.values()) entry.reject(new Error(event.message || "The search could not start."));
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

function stopSearch() {
  if (!worker || !state.runId) return;
  state.stopped = true;
  worker.postMessage({ type: "cancel", payload: { target: state.runId } });
}

// --- the board ---------------------------------------------------------------------------

/**
 * One Pokemon of a team.
 *
 * `inSim` is whether it is brought to this battle at all -- a team is six and a Doubles bring is
 * four. Where it STANDS is not stored: it is the Pokemon's place in the line, exactly as the
 * Companion has it. The first of the bring that can stand are on the field and the rest are
 * behind them, so moving a Pokemon to the front means moving it up the line, which is the one
 * gesture the board offers. A flag said the same thing less well: two Pokemon could both claim
 * the front, and nothing said which of the two in front would make way for a third.
 *
 * `justIn` starts ON because the board a player recreates is almost always the one in front of
 * them right now, which is the turn something came in.
 */
const emptyRow = (set, inSim = false) => ({
  set, hp: 100, inSim, justIn: true, status: "",
  atk: 0, def: 0, spa: 0, spd: 0, spe: 0,
  // Per-Pokemon, because that is what they are facts about. `itemOff`/`abilityOff` build the
  // Pokemon without the thing, so it is gone from the turn model too; the two counters are what
  // Last Respects, Supreme Overlord and Rage Fist read.
  itemOff: false, abilityOff: false, faintedAllies: 0, timesHit: 0,
});

/** Everything about the battle that is not a Pokemon.
 *  A declaration rather than a const arrow: `state` below is built at module load and calls it,
 *  which a const in the temporal dead zone cannot answer. */
function emptyField() {
  return {
    weather: "None", terrain: "None", trickRoom: false, tailwind: [0, 0],
    reflect: [false, false], lightScreen: [false, false], auroraVeil: [false, false],
    friendGuard: [false, false],
    // Whether the person has said what the weather is. A Pokemon with Drought standing on the
    // field means sun, and the board should say so without being asked -- but only until the
    // person says otherwise, after which their answer is the answer.
    weatherSet: false, terrainSet: false,
  };
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      format: state.format, sides: state.sides, field: state.field, lookahead: state.lookahead,
      importTeamId: state.importTeamId,
    }));
  } catch {
    // storage unavailable: the page still works for this visit
  }
}

function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!raw || !Array.isArray(raw.sides) || raw.sides.length !== 2) return false;
    if (!raw.sides.some((side) => side.some((row) => row?.set?.species))) return false;
    state.format = raw.format === "Singles" ? "Singles" : "Doubles";
    state.sides = raw.sides.map((side) => {
      const rows = side.filter((row) => row?.set?.species).map((row) => {
        const kept = { ...emptyRow(makeSet(row.set)), ...row, set: makeSet(row.set) };
        if (row.inSim === undefined) kept.inSim = true;
        // Older boards said where a Pokemon stood with a flag -- `front`, and `active` before
        // that. The line says it now, so the flag becomes an order and then goes away.
        kept.wasFront = Boolean(row.front ?? row.active);
        delete kept.active;
        delete kept.front;
        return kept;
      });
      // Whoever was standing keeps standing: they move to the head of the line, in the order
      // they were already in.
      rows.sort((a, b) => (b.wasFront ? 1 : 0) - (a.wasFront ? 1 : 0));
      for (const row of rows) delete row.wasFront;
      return rows;
    });
    state.field = { ...emptyField(), ...(raw.field || {}) };
    for (const key of ["tailwind", "reflect", "lightScreen", "auroraVeil", "friendGuard"]) {
      const saved = raw.field?.[key];
      state.field[key] = Array.isArray(saved) ? [...saved] : emptyField()[key];
    }
    state.lookahead = Math.max(LOOKAHEAD_RANGE[0], Math.min(LOOKAHEAD_RANGE[1], Number(raw.lookahead) || DEFAULT_LOOKAHEAD));
    state.importTeamId = raw.importTeamId || "";
    fit();
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep each side legal: a team of at most six, and at most the format's bring in this battle.
 *
 * It no longer forces the bring to be FULL. It used to, by walking the line and switching the
 * first Pokemon that was out back in -- which made "take this one out of the battle" a silent
 * no-op for the earliest Pokemon on the team, because the same pass put it straight back.
 * Fewer than a full bring is a perfectly good question to ask of a board.
 */
function fit() {
  const bring = BRING[state.format];
  // A picked-up Pokemon is a position, so anything that can move or remove one puts it down.
  // Every mutation goes through here, which makes a stale index impossible rather than guarded.
  state.pick = null;
  for (const side of state.sides) {
    side.length = Math.min(side.length, TEAM_SIZE);
    let taken = 0;
    for (const row of side) {
      // Every row, not only the ones in this battle: the old `front` flag is read by `restore`
      // to work out the order a saved board meant, so a copy left on a benched Pokemon would
      // put it back in the front on the next visit and quietly undo the move that benched it.
      delete row.front;
      if (!row.inSim) continue;
      taken += 1;
      if (taken > bring) row.inSim = false;
    }
  }
  autoField();
}

/** The Abilities that put something up the moment their owner arrives. */
const WEATHER_ABILITIES = {
  drought: "Sun", orichalcumpulse: "Sun", desolateland: "Sun",
  drizzle: "Rain", primordialsea: "Rain",
  sandstream: "Sand", sandspit: "Sand",
  snowwarning: "Snow",
};
const TERRAIN_ABILITIES = {
  electricsurge: "Electric", hadronengine: "Electric",
  grassysurge: "Grassy", mistysurge: "Misty", psychicsurge: "Psychic",
};

/**
 * What the Pokemon on the field have put up, unless the person has said otherwise.
 *
 * The search does not re-run entry Abilities over the board -- the board is a game already in
 * progress, so running them again would re-apply Intimidate and double-count what has already
 * happened. That leaves one gap: a Drought holder standing on the field means sun, and nobody
 * should have to tell the Solver that. So the board answers it here instead, the way the Damage
 * Calculator does, and stops the moment the person picks a weather themselves -- including
 * picking "None", which is an answer too.
 */
function autoField() {
  const field = state.field;
  if (field.weatherSet && field.terrainSet) return;
  let weather = "None";
  let terrain = "None";
  for (const side of [0, 1]) {
    for (const row of standingOf(side)) {
      if (row.abilityOff) continue;
      const ability = String(row.set.ability || "").toLowerCase().replace(/[^a-z]/g, "");
      // Last one standing wins, which is as close as a still board gets to "whoever came in last".
      if (WEATHER_ABILITIES[ability]) weather = WEATHER_ABILITIES[ability];
      if (TERRAIN_ABILITIES[ability]) terrain = TERRAIN_ABILITIES[ability];
    }
  }
  if (!field.weatherSet) field.weather = weather;
  if (!field.terrainSet) field.terrain = terrain;
}

/** The ones taken into this battle, in the order they stand. */
function brought(side) {
  return state.sides[side].filter((row) => row.inSim && row.set?.species).slice(0, BRING[state.format]);
}

/**
 * The ones on the field: the first of the bring that can stand.
 *
 * A fainted Pokemon never stands, and the next one that can takes the place -- the same rule the
 * Companion's `field_and_back` keeps, so the picture, the payload and the Solve check cannot
 * disagree about who is in the front.
 */
function standingOf(side) {
  return brought(side).filter((row) => row.hp > 0).slice(0, ACTIVE[state.format]);
}

/** Whether this Pokemon is one of the ones standing. */
function isFront(side, row) {
  return standingOf(side).includes(row);
}

/**
 * Two Pokemon change places.
 *
 * The one arriving from the back is given a place on the field, so it is in this battle whether
 * or not it was: carrying "not in this battle" across with it made the swap look like it did
 * nothing, because the Pokemon really moved but was still skipped, and the place it had just
 * been given went to whoever was next in line.
 */
function swapRows(side, from, to) {
  const rows = state.sides[side];
  if (from === to || !rows[from] || !rows[to]) { state.pick = null; return; }
  if (isFront(side, rows[from]) && !rows[to].inSim) rows[to].inSim = true;
  const held = rows[from];
  rows[from] = rows[to];
  rows[to] = held;
  state.pick = null;
  fit();
  save();
  render();
}

/**
 * What a click on the board means, by where the Pokemon is standing.
 *
 * One in the front with nothing picked up is picked up, and blinks while it waits; anything at
 * all with one picked up changes places with it; one in the back with nothing picked up is taken
 * out of this battle, or put back into it. The two sides are separate teams, so a click on the
 * other side starts again rather than moving a Pokemon across.
 */
function boardClick(side, index) {
  const row = state.sides[side][index];
  if (!row || !row.set?.species) { state.pick = null; render(); return; }
  const pick = state.pick;
  if (pick && pick.side === side) {
    if (pick.index === index) { state.pick = null; render(); return; }
    swapRows(side, pick.index, index);
    return;
  }
  if (!isFront(side, row)) {
    state.pick = null;
    if (row.inSim) {
      row.inSim = false;
    } else {
      // A team is six and only the format's bring plays, so bringing one in has to send one back.
      // Without this the click did nothing at all whenever the bring was full -- which a fresh
      // board always is -- because `fit` simply trimmed the one that had just been added.
      const taken = brought(side);
      if (taken.length >= BRING[state.format]) {
        const leaving = taken[taken.length - 1];
        const rows = state.sides[side];
        const from = rows.indexOf(row);
        const to = rows.indexOf(leaving);
        // They change places as well as swapping their flags, so the one coming in takes the
        // place in the line that the one it replaced was holding.
        rows[from] = leaving;
        rows[to] = row;
        leaving.inSim = false;
      }
      row.inSim = true;
    }
    fit();
    save();
    render();
    return;
  }
  state.pick = { side, index };
  render();
}

/**
 * The board a first-time visitor is shown: the top of the current meta, one Mega Stone a side.
 *
 * A side may bring only one Mega Stone, which is the rule Auto Build and the Tournament Test
 * both enforce. Taking the top N of the meta straight off the list does not: in Singles the
 * top three of each side held two stones, so the opening board was illegal and the search
 * answered it with both Pokemon Mega-Evolved. Walk further down the list instead of handing
 * out a second one.
 */
async function startingBoard() {
  const meta = await data.loadMeta(state.format);
  const rows = meta.pokemon || [];
  const bring = BRING[state.format];
  const made = [];
  let index = 0;
  for (let side = 0; side < 2; side += 1) {
    const sets = [];
    let stones = 0;
    while (sets.length < TEAM_SIZE && index < rows.length) {
      const row = rows[index];
      index += 1;
      if (!row) break;
      const set = setFromCommon(data.commonSet(state.format, row.species, row.form));
      if (data.engine.isMegaStone(set.item)) {
        if (stones) continue;
        stones += 1;
      }
      sets.push(set);
    }
    while (sets.length < TEAM_SIZE) sets.push(makeSet());
    made.push(sets.map((set, i) => emptyRow(set, i < bring)));
  }
  state.sides = made;
  fit();
}

// --- drawing -----------------------------------------------------------------------------

function render() {
  if (!root) return;
  clear(root);
  root.appendChild(h("div", { class: "bd-solver" },
    renderControls(),
    h("div", { class: "bd-solver-board" },
      renderSide(0),
      h("div", { class: "bd-solver-middle" },
        renderEffects(), renderScene(), renderField(), renderResults()),
      renderSide(1))));
}

function renderControls() {
  const left = freeRunsLeft(SOLVER_FEATURE);
  const allowance = isPro()
    ? h("span", { class: "bd-free-runs" }, "Pro: unlimited searches")
    : h("span", { class: "bd-free-runs" }, left > 0
      ? `${left} of ${FREE_RUNS} free searches left`
      : "Free searches used — Pro keeps it unlimited");
  return h("div", { class: "bd-solver-controls" },
    h("div", { class: "bd-solver-controls-left" },
      segmented([["Doubles", "Doubles"], ["Singles", "Singles"]],
        state.format, async (value) => {
          if (value === state.format) return;
          state.format = value;
          state.result = null;
          await startingBoard();
          save();
          render();
        }, { "aria-label": "Battle format" }),
      h("label", { class: "bd-solver-depth" },
        h("span", {}, "Look turns ahead"),
        select(Array.from({ length: LOOKAHEAD_RANGE[1] - LOOKAHEAD_RANGE[0] + 1 }, (_, i) => [String(LOOKAHEAD_RANGE[0] + i), String(LOOKAHEAD_RANGE[0] + i)]),
          String(state.lookahead), (value) => { state.lookahead = Number(value); save(); render(); }, { "aria-label": "Look turns ahead" }))),
    // The board is clicked, and a board that is clicked has to say so: nothing else on the page
    // tells you that a sprite is a control.
    h("p", { class: "bd-solver-controls-hint" },
      "Click Pok\u00e9mon on the bench to activate/deactivate it, click the Pok\u00e9mon in the front "
      + "to switch its position with another Pok\u00e9mon."),
    h("div", { class: "bd-solver-controls-right" },
      allowance,
      state.running
        ? h("button", { type: "button", class: "ghost-button", onclick: () => stopSearch() }, "Stop")
        : h("button", { type: "button", class: "primary-button", onclick: () => solve() }, "Solve")));
}

function monLabel(set) {
  return data.displayName(set.species, set.form) || set.form || set.species || "Empty";
}

/** This Pokemon's stats as it is built, so the HP bar can show the real numbers. */
function monStats(set) {
  try {
    return data.engine.finalStats(monFromSet(set));
  } catch {
    return { hp: 0 };
  }
}

/** "118 / 175 HP · 67%". The percentage alone is not what a player reads off their own screen. */
function hpText(percent, maxHp) {
  const share = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  if (!maxHp) return `${share}%`;
  const now = share <= 0 ? 0 : Math.max(1, Math.ceil((maxHp * share) / 100));
  return `${now} / ${maxHp} HP · ${share}%`;
}

function renderSide(side) {
  const rows = state.sides[side];
  const active = ACTIVE[state.format];
  const bring = BRING[state.format];
  const taken = brought(side);
  return h("section", { class: "bd-solver-side", "aria-label": SIDE_LABEL[side] },
    h("div", { class: "bd-solver-side-head" },
      h("h2", {}, SIDE_LABEL[side]),
      renderImport(side)),
    // Every Pokemon on the team, not only the ones brought: a set still has to be editable when
    // it is sitting this battle out, and the board above says which are in it.
    h("div", { class: "bd-solver-cards" }, rows.map((row, index) => renderCard(side, index, row))),
    rows.length < TEAM_SIZE
      ? h("button", {
        type: "button",
        class: "ghost-button bd-solver-add",
        onclick: async () => {
          const choice = await pickPokemon(data, { format: state.format, title: `Add to ${SIDE_LABEL[side].toLowerCase()}` });
          if (!choice) return;
          rows.push(emptyRow(setFromCommon(data.commonSet(state.format, choice.row ? choice.row.species : choice.species, choice.row ? choice.row.form : choice.form))));
          fit();
          save();
          render();
        },
      }, `Add a Pokémon (${rows.length}/${TEAM_SIZE})`)
      : null,
    h("p", { class: "bd-solver-note" },
      `${taken.length} of ${rows.length} in this battle (${bring} play), ${active} in the front.`));
}

// --- the field, as a picture ----------------------------------------------------------------

/**
 * The board in the middle: both sides as the game shows them, and clickable.
 *
 * This is the Companion's own arrangement -- the opponent at the top with its team beside the
 * heading, ours at the bottom with ours -- because it is the arrangement a player is already
 * reading off their screen. Everything about where a Pokemon stands is said here, so the tiles
 * in the two outer columns are free to be about the Pokemon itself.
 */
function renderScene() {
  return h("div", { class: "bd-solver-scene" },
    h("p", { class: `bd-solver-scene-field${inPlay().length ? "" : " empty"}` },
      inPlay().join(" \u00b7 ") || "No weather, terrain or room in play"),
    sceneSide(1),
    h("div", { class: "bd-solver-scene-gap" }),
    sceneSide(0));
}

/** What is up, in the words the board uses. */
function inPlay() {
  const field = state.field;
  const out = [];
  if (field.weather !== "None") out.push(field.weather);
  if (field.terrain !== "None") out.push(`${field.terrain} Terrain`);
  if (field.trickRoom) out.push("Trick Room");
  if (field.tailwind[0] > 0) out.push("Your Tailwind");
  if (field.tailwind[1] > 0) out.push("Their Tailwind");
  for (const [key, label] of [["reflect", "Reflect"], ["lightScreen", "Light Screen"],
    ["auroraVeil", "Aurora Veil"], ["friendGuard", "Friend Guard"]]) {
    if (field[key][0]) out.push(`Your ${label}`);
    if (field[key][1]) out.push(`Their ${label}`);
  }
  return out;
}

/** One team on the board: the heading and the bench share a line, the field gets its own. */
function sceneSide(side) {
  const rows = state.sides[side];
  const standing = standingOf(side);
  const head = h("div", { class: "bd-solver-scene-head" },
    h("h3", {}, SIDE_LABEL[side]),
    h("div", { class: "bd-solver-bench" },
      rows.map((row, index) => (standing.includes(row) ? null : sceneTile(side, index, row, true)))));
  const field = h("div", { class: "bd-solver-scene-field-row" },
    standing.map((row) => sceneTile(side, rows.indexOf(row), row, false)));
  return h("div", { class: "bd-solver-scene-side", "data-side": side === 0 ? "ours" : "theirs" },
    ...(side === 0 ? [field, head] : [head, field]));
}

/** One Pokemon on the board. Clicked, never dragged -- see `boardClick`. */
function sceneTile(side, index, row, benched) {
  const set = row.set;
  const name = monLabel(set);
  const down = row.hp <= 0;
  const out = !row.inSim;
  const picked = state.pick && state.pick.side === side && state.pick.index === index;
  const classes = ["bd-solver-tile"];
  if (benched) classes.push("bench");
  if (down) classes.push("down");
  if (out) classes.push("out");
  if (picked) classes.push("picked");
  const how = picked
    ? "Click another Pokémon to change places with it, or click away to stop."
    : benched
      ? "Click to take it out of the battle, or to put it back."
      : "Click to pick it up, then click another to change their places.";
  const bits = [];
  if (row.status) bits.push((STATUSES.find(([value]) => value === row.status) || [])[1] || "");
  for (const [key, label] of STAGES) {
    const stage = Number(row[key]) || 0;
    if (stage) bits.push(`${label} ${stage > 0 ? "+" : ""}${stage}`);
  }
  return h("button", {
    type: "button",
    class: classes.join(" "),
    title: `${name} · ${out ? "on the team, not in this battle" : "in this battle"}\n${how}`,
    "aria-label": `${name}, ${out ? "not in this battle" : benched ? "in the back" : "in the front"}`,
    onclick: (event) => { event.stopPropagation(); boardClick(side, index); },
  },
  sprite(data.sprite(set.species, set.form, set.item), "", benched ? 30 : 34),
  benched ? null : h("span", { class: "bd-solver-tile-name" }, name),
  benched ? null : h("span", { class: "bd-solver-tile-hp" },
    out ? "out" : down ? "fainted" : `${Math.round(row.hp)}%`),
  h("span", { class: `bd-solver-tile-bar${out ? " out" : down ? " down" : row.hp <= 20 ? " low" : row.hp <= 50 ? " mid" : ""}` },
    h("i", { style: { width: `${Math.max(0, Math.min(100, row.hp))}%` } })),
  !benched && bits.length ? h("span", { class: "bd-solver-tile-chips" }, bits.join(" · ")) : null);
}

// --- what is switched on --------------------------------------------------------------------

/**
 * The strip above the board: everything in play right now, and every item, Ability and counter
 * belonging to a Pokemon that is standing.
 *
 * Modelled on the Damage Calculator's own strip, down to the gesture: a chip that is on is a
 * thing that is working, and clicking it turns that thing off. An item switched off here is not
 * merely discounted in the damage -- the Pokemon is built without it, so its Focus Sash does not
 * save it and its Sitrus Berry never comes.
 */
function renderEffects() {
  const chips = [];
  const field = state.field;
  const pushField = (label, on, clear, title) => {
    if (on) chips.push(h("button", { type: "button", class: "bd-effect on", title, onclick: () => { clear(); save(); render(); } }, label));
  };
  if (field.weather !== "None") pushField(field.weather, true, () => { field.weather = "None"; field.weatherSet = true; }, "In play. Click to clear it.");
  if (field.terrain !== "None") pushField(`${field.terrain} Terrain`, true, () => { field.terrain = "None"; field.terrainSet = true; }, "In play. Click to clear it.");
  pushField("Trick Room", field.trickRoom, () => { field.trickRoom = false; }, "In play. Click to clear it.");
  for (const side of [0, 1]) {
    const who = side === 0 ? "Your" : "Their";
    pushField(`${who} Tailwind`, field.tailwind[side] > 0, () => { field.tailwind[side] = 0; }, "In play. Click to clear it.");
    for (const [key, label] of [["reflect", "Reflect"], ["lightScreen", "Light Screen"],
      ["auroraVeil", "Aurora Veil"], ["friendGuard", "Friend Guard"]]) {
      pushField(`${who} ${label}`, field[key][side], () => { field[key][side] = false; }, "In play. Click to clear it.");
    }
  }
  for (const side of [0, 1]) {
    for (const row of standingOf(side)) {
      const name = monLabel(row.set);
      const mark = side === 0 ? "" : " (theirs)";
      if (row.set.ability) {
        chips.push(h("button", {
          type: "button", class: `bd-effect${row.abilityOff ? "" : " on"}`,
          title: `${name}'s Ability${mark}. Click to play the board without it.`,
          onclick: () => { row.abilityOff = !row.abilityOff; save(); render(); },
        }, row.set.ability));
      }
      if (row.set.item) {
        chips.push(h("button", {
          type: "button", class: `bd-effect${row.itemOff ? "" : " on"}`,
          title: `${name}'s item${mark}. Click to play the board without it.`,
          onclick: () => { row.itemOff = !row.itemOff; save(); render(); },
        }, row.set.item));
      }
      // The moves and Abilities that count something. They are the only ones whose damage
      // depends on a number nothing on the board can show, so the number is asked for here.
      const counted = countersFor(row);
      for (const spec of counted) {
        chips.push(h("span", { class: "bd-effect-group" },
          h("span", { class: "bd-effect on static", title: `${name}${mark}: ${spec.why}` }, spec.label),
          select(spec.options, String(row[spec.key] ?? 0), (value) => {
            row[spec.key] = Number(value) || 0;
            save();
            render();
          }, { class: "bd-select bd-effect-select", "aria-label": `${name} ${spec.label}` })));
      }
    }
  }
  if (!chips.length) {
    return h("div", { class: "bd-solver-effects empty" },
      h("p", { class: "bd-solver-note" }, "Nothing is switched on. Weather, terrain and anything else in play will show up here, with each Pokémon's item and Ability."));
  }
  return h("div", { class: "bd-solver-effects", role: "group", "aria-label": "What is in play" }, chips);
}

/** A moveset's counters: what Last Respects and friends are reading. */
function countersFor(row) {
  const out = [];
  const moves = (row.set.moves || []).map((move) => String(move || "").toLowerCase().replace(/[^a-z]/g, ""));
  const ability = String(row.set.ability || "").toLowerCase().replace(/[^a-z]/g, "");
  if (moves.includes("lastrespects") || ability === "supremeoverlord") {
    // The engine caps this by format -- three in Doubles, two in Singles -- so offering more
    // would be offering a number that cannot change anything.
    const limit = state.format === "Singles" ? 2 : 3;
    out.push({
      key: "faintedAllies", label: "Fainted allies", why: "Last Respects and Supreme Overlord count how many of its own side are down.",
      options: Array.from({ length: limit + 1 }, (_, i) => [String(i), `${i} down`]),
    });
  }
  if (moves.includes("ragefist")) {
    out.push({
      key: "timesHit", label: "Times hit", why: "Rage Fist counts how many times its user has been hit.",
      options: Array.from({ length: 7 }, (_, i) => [String(i), i ? `Hit ${i}\u00d7` : "Not hit"]),
    });
  }
  return out;
}

/**
 * One Pokemon of a team, as an editable tile.
 *
 * It says what the Pokemon IS -- its item, Ability, Nature, moves and the stats it ends up with
 * -- and what has happened to it: HP, condition, boosts. Where it stands is not here any more;
 * that is the board in the middle, which is the only place it is said.
 */
function renderCard(side, index, row) {
  const set = row.set;
  const down = row.hp <= 0;
  const stats = monStats(set);
  const maxHp = stats.hp || 0;
  // Alive and KO are the two ends of the HP bar, so the button is the bar: a Pokemon that is
  // knocked out is on 0%, and bringing it back puts it on full.
  const toggleAlive = () => {
    row.hp = row.hp > 0 ? 0 : 100;
    fit();
    save();
    render();
  };
  const number = (key, label, min, maxValue) => h("label", { class: "bd-solver-num" },
    h("span", {}, label),
    h("input", {
      type: "number", value: String(row[key] ?? 0), min: String(min), max: String(maxValue),
      "aria-label": `${monLabel(set)} ${label}`,
      oninput: (event) => {
        row[key] = Math.max(min, Math.min(maxValue, Number(event.target.value) || 0));
        save();
        render();
      },
    }));
  const moves = (set.moves || []).filter(Boolean);
  return h("article", { class: `bd-solver-card${down ? " knocked-out" : ""}${row.inSim ? "" : " benched"}` },
    h("div", { class: "bd-solver-card-head" },
      h("button", {
        type: "button", class: "bd-solver-art", "aria-label": `Edit ${monLabel(set)}`,
        onclick: async () => {
          const next = await editSet(data, set, { format: state.format, title: monLabel(set), removeLabel: "Take off the team" });
          if (next === undefined) return;
          if (next === null) {
            state.sides[side].splice(index, 1);
            fit();
          } else {
            row.set = next;
          }
          save();
          render();
        },
      }, sprite(data.sprite(set.species, set.form, set.item, { full: true }), "", 56, "bd-sprite bd-sprite-lg")),
      h("div", { class: "bd-solver-card-name" },
        h("strong", {}, monLabel(set)),
        h("small", {}, [set.item || "No item", set.ability].filter(Boolean).join(" \u00b7 ")),
        h("small", { class: "bd-solver-card-nature" }, `${set.nature || "Serious"} nature`)),
      h("button", {
        type: "button",
        class: `bd-chip bd-solver-alive${down ? " ko" : " on"}`,
        "aria-pressed": down ? "false" : "true",
        title: down ? "Knocked out. Click to put it back on full HP." : "Still in. Click to knock it out.",
        onclick: toggleAlive,
      }, down ? "KO" : "Alive")),
    // The stats it ends up with, after its Nature and its points. The board is built from these
    // numbers, so showing them is showing the Pokemon that is actually going to be played.
    h("div", { class: "bd-solver-card-stats" }, STAT_KEYS.map(([label, key]) => h("span", { class: "bd-solver-stat" },
      h("b", {}, label), h("i", {}, String(stats[key] ?? "\u2014")))))
    ,
    moves.length
      ? h("div", { class: "bd-solver-card-moves" }, moves.map((move) => h("span", { class: "bd-solver-move" }, move)))
      : h("p", { class: "bd-solver-note" }, "No moves yet."),
    h("div", { class: "bd-solver-card-row" },
      h("label", { class: "bd-solver-hp" },
        h("span", {}, "HP"),
        h("input", {
          type: "range", min: "0", max: "100", step: "1", value: String(row.hp),
          "aria-label": `${monLabel(set)} HP percent`,
          oninput: (event) => {
            const was = row.hp;
            row.hp = Number(event.target.value) || 0;
            event.target.closest(".bd-solver-hp").querySelector(".bd-solver-hp-value").textContent = hpText(row.hp, maxHp);
            save();
            // Crossing 0 or leaving it changes who is standing on the board above, so that
            // redraw cannot wait for the next render.
            if ((was > 0) !== (row.hp > 0)) {
              fit();
              render();
            }
          },
        }),
        // The percentage alone is not what a player reads off their own screen: they see
        // "118 / 175". Both are shown, from the Pokemon's real stats.
        h("span", { class: "bd-solver-hp-value" }, hpText(row.hp, maxHp))),
      select(STATUSES, row.status, (value) => { row.status = value; save(); render(); }, { "aria-label": "Status" }),
      h("button", {
        type: "button",
        class: `bd-chip${row.justIn ? " on" : ""}`,
        "aria-pressed": row.justIn ? "true" : "false",
        title: "Fake Out and First Impression only work on the turn their user came in",
        onclick: () => { row.justIn = !row.justIn; save(); render(); },
      }, "Just switched in")),
    // No "Boosts" caption: every box under it is already labelled Atk, Def, SpA, SpD, Spe, so the
    // word was a heading over something that did not need one.
    h("div", { class: "bd-solver-stages" },
      STAGES.map(([key, label]) => number(key, label, -6, 6))));
}

function renderImport(side) {
  const teams = (getState().teams || []).filter((team) => team && team.id);
  const team = teams.find((entry) => entry.id === state.importTeamId) || currentTeam() || teams[0] || null;
  const sets = teamSets(team, data).filter((set) => set.species && data.speciesEntry(set.species));
  /** Put a team on this side: all six, with the format's bring already chosen. */
  const load = (from) => {
    const bring = BRING[state.format];
    state.sides[side] = from.slice(0, TEAM_SIZE)
      .map((set, i) => emptyRow(JSON.parse(JSON.stringify(set)), i < bring));
    fit();
    save();
    render();
  };
  return h("div", { class: "bd-solver-import" },
    teams.length
      // Choosing a team IS loading it. A separate Load button asked the player to say the same
      // thing twice, and left the dropdown showing a team that was not on the board.
      ? select(teams.map((entry) => [entry.id, entry.title || "Team"]), team?.id || "", (value) => {
        state.importTeamId = value;
        const chosen = teams.find((entry) => entry.id === value) || null;
        const chosenSets = teamSets(chosen, data).filter((set) => set.species && data.speciesEntry(set.species));
        if (chosenSets.length) {
          load(chosenSets);
          toast(`${chosen?.title || "Team"} loaded into ${SIDE_LABEL[side].toLowerCase()}.`);
          return;
        }
        save();
        render();
      }, { class: "bd-select bd-import-team", "aria-label": `Team to load into ${SIDE_LABEL[side].toLowerCase()}` })
      : h("a", { class: "bd-import-empty", href: "/team-builder/" }, "Build a team to load it here"),
    h("button", {
      type: "button", class: "ghost-button",
      onclick: () => pasteSide(side),
    }, "Paste sets"));
}

/** Paste a whole side as text, in the same shape a team sheet is written in. */
function pasteSide(side) {
  const area = h("textarea", {
    class: "bd-paste", rows: "14", spellcheck: "false",
    placeholder: "Incineroar @ Sitrus Berry\nAbility: Intimidate\nAdamant Nature\nStat Points: 32 HP / 2 Def / 32 SpD\n- Fake Out\n- Flare Blitz\n- Knock Off\n- Parting Shot",
  });
  let closeDialog;
  const load = () => {
    const sets = parseShowdown(area.value, data).filter((set) => set.species && data.speciesEntry(set.species));
    if (!sets.length) {
      toast("No set could be read from that text.", "warn");
      return;
    }
    const bring = BRING[state.format];
    state.sides[side] = sets.slice(0, TEAM_SIZE).map((set, i) => emptyRow(set, i < bring));
    fit();
    save();
    render();
    toast(`${Math.min(sets.length, TEAM_SIZE)} Pokémon loaded into ${SIDE_LABEL[side].toLowerCase()}.`);
    closeDialog();
  };
  const { close } = openDialog({
    title: `Paste sets into ${SIDE_LABEL[side].toLowerCase()}`,
    wide: true,
    body: h("div", { class: "bd-paste-body" },
      h("p", { class: "bd-note" }, `One Pokémon per block, separated by a blank line; up to ${TEAM_SIZE} are used, and the first ${BRING[state.format]} are brought. Anything the site does not know is skipped.`),
      area),
    actions: [
      h("span", { class: "bd-spacer" }),
      h("button", { class: "ghost-button", type: "button", onclick: () => close() }, "Cancel"),
      h("button", { class: "primary-button", type: "button", onclick: load }, "Load them"),
    ],
  });
  closeDialog = close;
  area.focus();
}

function renderField() {
  const field = state.field;
  const row = (label, node) => h("div", { class: "bd-solver-field-row" }, h("span", { class: "bd-field-label" }, label), node);
  // One look for every button in this row. Trick Room and the two Tailwinds used to be pills and
  // Edit Field a button, which read as two different kinds of control for one kind of choice.
  const toggle = (label, on, onClick, title = "") => h("button", {
    type: "button", class: `ghost-button compact bd-solver-field-button${on ? " on" : ""}`,
    "aria-pressed": on ? "true" : "false", title, onclick: onClick,
  }, label);
  return h("div", { class: "bd-solver-field" },
    row("Weather", select(WEATHERS.map((w) => [w, w]), field.weather, (value) => {
      field.weather = value;
      field.weatherSet = true;
      save();
      render();
    }, { "aria-label": "Weather" })),
    row("Terrain", select(TERRAINS.map((x) => [x, x]), field.terrain, (value) => {
      field.terrain = value;
      field.terrainSet = true;
      save();
      render();
    }, { "aria-label": "Terrain" })),
    h("div", { class: "bd-solver-field-row" },
      h("span", { class: "bd-field-label" }, "In play"),
      h("div", { class: "bd-solver-chips" },
        toggle("Trick Room", field.trickRoom, () => { field.trickRoom = !field.trickRoom; save(); render(); },
          "Five turns in which the slower Pokemon moves first."),
        toggle("Your Tailwind", field.tailwind[0] > 0, () => { field.tailwind[0] = field.tailwind[0] > 0 ? 0 : 3; save(); render(); },
          "Three turns of doubled Speed for your side."),
        toggle("Their Tailwind", field.tailwind[1] > 0, () => { field.tailwind[1] = field.tailwind[1] > 0 ? 0 : 3; save(); render(); },
          "Three turns of doubled Speed for their side."),
        h("button", {
          type: "button", class: "ghost-button compact bd-solver-field-button",
          title: "Screens and Friend Guard, for each side",
          onclick: () => editField(),
        }, "Edit Field"))));
}

/**
 * Everything about the battle that is not a Pokemon, in one popup.
 *
 * Laid out as the Damage Calculator's Field card is: one column per side, the same rows in the
 * same order in both, so the two sides can be read against each other. A list of rows each
 * holding a "Yours" and a "Theirs" pill said the same thing, but nothing lined up and the eye
 * had to pair them up itself.
 *
 * The strip above the board carries what is in play and everything belonging to a Pokemon --
 * items, Abilities, and the counters Last Respects and Rage Fist read. What is left here is what
 * belongs to a SIDE and nothing else: the screens and Friend Guard, which are already up when
 * you recreate a board from the middle of a game.
 */
function editField() {
  const field = state.field;
  const redraw = () => { save(); render(); };
  const ROWS = [
    ["Tailwind", "tailwind", "Three turns of doubled Speed for that side."],
    ["Reflect", "reflect", "Halves the physical damage that side takes."],
    ["Light Screen", "lightScreen", "Halves the special damage that side takes."],
    ["Aurora Veil", "auroraVeil", "Halves both."],
    ["Friend Guard", "friendGuard", "An ally with Friend Guard cuts the damage its partner takes."],
  ];
  const on = (key, s) => (key === "tailwind" ? field.tailwind[s] > 0 : Boolean(field[key][s]));
  const set = (key, s, value) => {
    if (key === "tailwind") field.tailwind[s] = value ? 3 : 0;
    else field[key][s] = value;
  };
  const column = (s) => h("div", { class: "bd-solver-side-column" },
    h("h4", {}, SIDE_LABEL[s]),
    ROWS.map(([label, key, title]) => h("button", {
      type: "button",
      class: `bd-toggle${on(key, s) ? " on" : ""}`,
      "aria-pressed": on(key, s) ? "true" : "false",
      title,
      // Friend Guard only ever does anything with a partner on the field, which is Doubles.
      disabled: key === "friendGuard" && state.format === "Singles",
      onclick: (event) => {
        set(key, s, !on(key, s));
        event.currentTarget.classList.toggle("on", on(key, s));
        event.currentTarget.setAttribute("aria-pressed", on(key, s) ? "true" : "false");
        save();
      },
    }, label)));
  const { close } = openDialog({
    title: "Field settings",
    wide: true,
    body: h("div", { class: "bd-solver-field-popup" },
      h("div", { class: "bd-solver-field-row" },
        h("span", { class: "bd-field-label" }, "Weather"),
        select(WEATHERS.map((w) => [w, w]), field.weather, (value) => { field.weather = value; field.weatherSet = true; save(); }, { "aria-label": "Weather" })),
      h("div", { class: "bd-solver-field-row" },
        h("span", { class: "bd-field-label" }, "Terrain"),
        select(TERRAINS.map((x) => [x, x]), field.terrain, (value) => { field.terrain = value; field.terrainSet = true; save(); }, { "aria-label": "Terrain" })),
      h("div", { class: "bd-solver-field-row" },
        h("span", { class: "bd-field-label" }, "In play"),
        h("button", {
          type: "button",
          class: `bd-toggle${field.trickRoom ? " on" : ""}`,
          "aria-pressed": field.trickRoom ? "true" : "false",
          title: "Five turns in which the slower Pokemon moves first.",
          onclick: (event) => {
            field.trickRoom = !field.trickRoom;
            event.currentTarget.classList.toggle("on", field.trickRoom);
            event.currentTarget.setAttribute("aria-pressed", field.trickRoom ? "true" : "false");
            save();
          },
        }, "Trick Room")),
      h("div", { class: "bd-solver-field-sides" }, column(0), column(1)),
      h("p", { class: "bd-solver-note" },
        "The weather, terrain, Trick Room and Tailwind are played out turn by turn. The screens "
        + "are applied to every damage roll in the search. Each Pokémon's own item, Ability and "
        + "counters are in the strip above the board.")),
    actions: [
      h("span", { class: "bd-spacer" }),
      h("button", { class: "primary-button", type: "button", onclick: () => { close(); redraw(); } }, "Done"),
    ],
    onClose: () => redraw(),
  });
}

function bar(value) {
  const ours = Math.max(0, Math.min(100, value));
  return h("div", { class: "bd-solver-bar", role: "img", "aria-label": `The board favours you ${ours.toFixed(0)} to ${(100 - ours).toFixed(0)}` },
    h("div", { class: "bd-solver-bar-fill", style: `width:${ours}%` }),
    h("span", { class: "bd-solver-bar-text" }, `The board favours you ${ours.toFixed(0)} · them ${(100 - ours).toFixed(0)}`));
}

/**
 * One line of an answer.
 *
 * `mine` is false for "Their best answer". Each side's statistics are kept in that side's own
 * frame -- ours is the board value from our view, theirs is 100 minus it -- so a signed delta
 * printed straight from `row.score` flipped meaning between the two lists: on a board you were
 * losing, every move of yours was a red negative and every answer of theirs a green positive,
 * which reads as "their moves are the good ones". Both lists therefore print where the board
 * ENDS UP for YOU, on the same 0-100 scale the bar above uses. Green is always good for you.
 */
function actionText(action) {
  // A switch already reads as an arrow ("→ Incineroar"), so it does not take the colon a move does.
  return action.kind === SWITCH
    ? `${action.name} ${action.move}`
    : `${action.name}: ${action.move}${action.target ? ` → ${action.target}` : ""}`;
}

function lineRow(row, index, mine) {
  // One Pokemon per row. Run together with a separator, a Doubles turn was a single long line
  // that wrapped wherever the column happened to end, and the two halves ran into each other.
  const text = row.actions.length
    ? h("span", { class: "bd-solver-line-text" }, row.actions.map((action) => h("span", { class: "bd-solver-line-act" }, actionText(action))))
    : h("span", { class: "bd-solver-line-text" }, "Nothing it can do");
  const yours = mine ? row.score : 100 - row.score;
  return h("li", { class: `bd-solver-line${index === 0 ? " best" : ""}` },
    h("div", { class: "bd-solver-line-main" },
      text,
      h("span", {
        class: "bd-solver-line-score",
        "data-tone": yours >= 50 ? "good" : "bad",
        title: `If this line is played, the board ends up at ${yours.toFixed(1)} out of 100 for you. 50 is even.`,
      }, yours.toFixed(1))),
    h("div", { class: "bd-solver-line-sub" }, `${(row.share * 100).toFixed(0)}% of the lines, ${row.played} played`));
}

/**
 * How the game goes on from here: the best line for each side, played out once.
 *
 * The turn machinery has no "attacked" event, so the damage is read from the HP either side of
 * each turn. That is the honest reading anyway -- it is what the turn did, whoever did it.
 */
function renderStory(result) {
  const story = result.story;
  if (!story || !Array.isArray(story.turns) || !story.turns.length) return null;
  const who = (side) => (side === 0 ? "You" : "They");
  return h("details", { class: "bd-solver-story", open: true },
    h("summary", {}, "How it goes from here"),
    h("p", { class: "bd-solver-note" },
      `Both sides playing the line above, then ${story.turns.length - 1} more turn${story.turns.length === 2 ? "" : "s"} `
      + `the search decides for itself. The board ends at ${story.value.toFixed(1)} out of 100 for you.`),
    h("ol", { class: "bd-solver-turns" }, story.turns.map((turn) => h("li", { class: "bd-solver-turn" },
      h("strong", {}, `Turn ${turn.turn}`),
      turn.plays.length
        ? h("div", { class: "bd-solver-turn-plays" }, turn.plays.map((play) =>
          h("span", { class: `bd-solver-line-act bd-solver-turn-play side-${play.side}` }, play.text)))
        : null,
      turn.notes.length ? h("div", { class: "bd-solver-turn-notes" }, turn.notes.join(" · ")) : null,
      turn.damage.length
        ? h("div", { class: "bd-solver-turn-damage" }, turn.damage.map((hit) =>
          h("span", { class: `bd-solver-turn-hit side-${hit.side}` }, `${hit.name} ${hit.from}% → ${hit.to}%`)))
        : null,
      turn.fainted.length
        ? h("div", { class: "bd-solver-turn-ko" }, turn.fainted.map((gone) => `${who(gone.side)} lose ${gone.name}`).join(" · "))
        : null))));
}

/** The one line that changes while a search runs. Held so `onProgress` can write it in place. */
let progressLine = null;

function progressText(p) {
  if (!p) return "Loading the battle data for the search…";
  const rate = p.elapsed > 0 ? Math.round(p.played / p.elapsed).toLocaleString() : "0";
  return `${p.played.toLocaleString()} lines played · ${p.elapsed.toFixed(1)}s · ${rate} a second · the board favours you ${p.value.toFixed(0)}`;
}

function renderResults() {
  if (state.error) {
    return h("div", { class: "bd-solver-results" },
      h("p", { class: "bd-solver-error" }, state.error));
  }
  if (state.running) {
    // Before the first slice comes back the search is loading the battle data in its own worker,
    // which on a slow connection is the longest part of the whole run. Saying so is the
    // difference between waiting and thinking it has hung.
    progressLine = h("span", {}, progressText(state.progress));
    return h("div", { class: "bd-solver-results" },
      h("div", { class: "bd-loading", role: "status" },
        h("span", { class: "bd-spinner", "aria-hidden": "true" }),
        progressLine),
      h("p", { class: "bd-solver-note" },
        "Every line rolls to hit and rolls its damage, so the answer is an average over samples "
        + `and it keeps sharpening. It answers after about ${SEARCH_SECONDS} seconds.`));
  }
  const result = state.result;
  if (!result) {
    return h("div", { class: "bd-solver-results" },
      h("p", { class: "bd-solver-idle" }, `Set the board up and press Solve. Both sides pick at the same time, neither sees the other, and the answer is whatever comes out ahead across the lines that get played. It takes about ${SEARCH_SECONDS} seconds.`));
  }
  const side = (title, rows, mine) => h("div", { class: "bd-solver-answer" },
    h("h3", {}, title),
    h("ol", { class: "bd-solver-lines" }, rows.slice(0, 6).map((row, index) => lineRow(row, index, mine))));
  return h("div", { class: "bd-solver-results" },
    bar(result.value),
    // The scale, said once. Without it nobody can tell whether 59.1 is a lot or nothing.
    h("p", { class: "bd-solver-note" }, "Every number below is where the board ends up for you if that line is played, out of 100. 50 is even."),
    side("Your best move", result.ours, true),
    side("Their best answer", result.theirs, false),
    renderStory(result),
    h("p", { class: "bd-solver-note" },
      `${result.played.toLocaleString()} lines played in ${result.seconds.toFixed(1)}s, ${result.lookahead} turns ahead, `
      + `${result.space[0]} × ${result.space[1]} opening actions. Every number above is a count of those lines.`));
}

// --- the search --------------------------------------------------------------------------

function proDialog() {
  const { close } = openDialog({
    title: "The Solver is a Pro feature",
    body: h("div", {},
      h("p", {}, `You have had ${FREE_RUNS} complete searches \u2014 the whole answer, not a preview. Pro keeps the Solver unlimited here and in the Companion, along with Team Evaluation, Auto Build and Test against Tournament Teams.`),
      h("p", {}, "\u20ac5 a month or \u20ac45 a year, with a seven day free trial, and it covers the website and the app.")),
    actions: [
      h("a", { class: "ghost-button", href: "/pro-tool/key/" }, "I have a key"),
      h("span", { class: "bd-spacer" }),
      h("button", { class: "ghost-button", type: "button", onclick: () => close() }, "Not now"),
      h("a", { class: "primary-button", href: "/pro-tool/plans/" }, "See the plans"),
    ],
  });
}

async function solve() {
  if (!canRun(SOLVER_FEATURE)) {
    proDialog();
    return;
  }
  // Only the Pokemon brought to this battle go to the search; the rest are the rest of the team.
  // `front` is worked out here rather than stored, from the line the board shows -- so what is
  // searched and what is drawn cannot disagree about who is standing.
  const board = {
    sides: [0, 1].map((side) => {
      const standing = standingOf(side);
      return brought(side).map((row) => ({
        set: row.set, hp: row.hp, front: standing.includes(row), justIn: row.justIn,
        status: row.status,
        atk: row.atk, def: row.def, spa: row.spa, spd: row.spd, spe: row.spe,
        itemOff: row.itemOff, abilityOff: row.abilityOff,
        faintedAllies: row.faintedAllies, timesHit: row.timesHit,
      }));
    }),
    field: state.field,
  };
  const short = [0, 1].filter((side) => standingOf(side).length < ACTIVE[state.format]);
  if (short.length) {
    const need = ACTIVE[state.format];
    state.error = need > 1
      ? `${short.map((side) => SIDE_LABEL[side]).join(" and ")} needs ${need} Pokémon on the field. Click one in the back to bring it into this battle.`
      : `${short.map((side) => SIDE_LABEL[side]).join(" and ")} needs a Pokémon on the field.`;
    render();
    return;
  }
  state.running = true;
  state.stopped = false;
  state.error = "";
  state.progress = null;
  state.result = null;
  render();
  const request = analysis("solver", {
    format: state.format,
    settings: getState().settings || {},
    board,
    lookahead: state.lookahead,
    seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0,
    // The cap is a backstop; `seconds` is what actually ends the run, so the answer is as
    // good as this machine can make it in that time rather than a fixed number of lines.
    iterations: 200000000,
    seconds: SEARCH_SECONDS,
  }, (progress) => {
    state.progress = progress;
    // NOT render(). A full redraw arrives about eighteen times a second while the search runs,
    // and it replaces every node in the page -- including the Stop button, between the mousedown
    // and the mouseup, so the click never completed and Stop appeared dead. Only the one line
    // that changes is written.
    if (progressLine) progressLine.textContent = progressText(progress);
  });
  state.runId = request.requestId;
  try {
    const result = await request;
    state.result = result.error ? null : result;
    state.error = result.error || "";
    // Only a search that ran its full budget counts against the free allowance.
    if (!result.error && result.played > 0 && !state.stopped) recordRun(SOLVER_FEATURE);
  } catch (error) {
    state.error = error.message || "The search stopped.";
  } finally {
    state.running = false;
    state.runId = 0;
    progressLine = null;
    render();
  }
}

// --- start -------------------------------------------------------------------------------

/**
 * `fetch` has no timeout of its own, so a request that stalls never settles and never throws:
 * the page then sits on "Loading the solver…" for ever with nothing in the console, which is
 * exactly what was reported. Every load is raced against a deadline so a stall becomes a
 * message with a Retry button instead of a spinner that never stops.
 */
const LOAD_TIMEOUT_MS = 20000;

function withTimeout(promise, what) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${what} took longer than ${LOAD_TIMEOUT_MS / 1000} seconds`)), LOAD_TIMEOUT_MS);
    }),
  ]);
}

function loadFailed(error) {
  console.error(error);
  if (!root) return;
  clear(root);
  root.appendChild(h("div", { class: "bd-solver-results" },
    h("p", { class: "bd-solver-error" },
      "The Solver could not load its data. This is almost always a slow or dropped connection."),
    h("p", { class: "bd-solver-note" }, String(error?.message || error)),
    h("p", {},
      h("button", { type: "button", class: "primary-button", onclick: () => start() }, "Try again"),
      " ",
      h("a", { class: "ghost-button", href: "https://discord.gg/k93eVQzj8c", target: "_blank", rel: "noopener" }, "Tell us on Discord"))));
}

let started = false;

async function start() {
  if (root) {
    clear(root);
    root.appendChild(h("div", { class: "bd-loading", role: "status" },
      h("span", { class: "bd-spinner", "aria-hidden": "true" }), "Loading the solver…"));
  }
  try {
    data = await withTimeout(BuilderData.load(), "Loading the battle data");
    const params = new URLSearchParams(location.search);
    if (params.get("format") === "Singles") state.format = "Singles";
    if (!restore()) await withTimeout(startingBoard(), "Setting the board up");
    await withTimeout(data.loadMeta(state.format), "Loading the meta");
    if (!started) {
      started = true;
      // A click that lands anywhere but a tile puts the picked Pokemon down. The tiles stop
      // their own click from bubbling, so this only ever sees the clicks that were not on one.
      document.addEventListener("click", () => {
        if (!state.pick) return;
        state.pick = null;
        render();
      });
      subscribe(() => render());
    }
    render();
  } catch (error) {
    loadFailed(error);
  }
}

start();
