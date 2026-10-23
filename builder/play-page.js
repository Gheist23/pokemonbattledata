// Play page: a game against the Solver.
//
// The opponent here is the same search the Solver page runs, with the Closed Team Sheet on: it
// cannot see your sets. It brings a real tournament team, it looks ten turns ahead, and it
// learns your moves only by watching you use them.
//
// The game itself lives in the worker (builder/play-game.js). This file is the screen: the team
// preview, the field, the buttons and the log. It never holds the board, only the view of it the
// worker sends back, which is why nothing here can disagree with the game about what happened.
//
// A game runs through three screens. SETUP picks the team. PREVIEW shows both sides' six and
// takes the four you bring, in the order you bring them. BATTLE plays it out. That is the shape
// the game itself has, and splitting it this way is what lets the four be chosen per game against
// the team you can actually see rather than once, in the abstract, before you know what you are
// up against.

import { BuilderData, makeSet, setFromCommon } from "./common.js";
import { clear, editSet, h, openDialog, pickPokemon, segmented, select, sprite } from "./ui.js";
import { getState, teamSets } from "./store.js";
import { loadRecord, playerName, recordGame, setPlayerName } from "./play-record.js";
import { DEFAULT_PACE, PACES, createTurnPlayer, sentenceFor, streamFromRecord } from "./play-anim.js";
import { BattleMusic } from "./play-music.js";

try { window.__bdPageModuleRan = true; } catch { /* no window: nothing to guard */ }

const root = document.getElementById("playApp");
const BRING = { Doubles: 4, Singles: 3 };
const ACTIVE = { Doubles: 2, Singles: 1 };
const TEAM_SIZE = 6;
/** The dropdown's entry for somebody who has not built a team yet. */
const LADDER = "__ladder";
const MUSIC_KEY = "bd-play-music";
const SHEET_KEY = "bd-play-sheet";
const PACE_KEY = "bd-play-pace";

let data;
let worker = null;
/**
 * The opponent's Pokemon that have actually stood on the field.
 *
 * You are shown their six at team preview and not which four they brought, so their bench stays
 * grey until it appears. Cleared with every game.
 */
const revealed = new Set();
/** A species name as a key: case and punctuation vary between a team sheet and the board. */
const compactName = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
let requestId = 0;
const pending = new Map();
const music = new BattleMusic();
let turnPlayer = null;
/**
 * Whether music is wanted, remembered between games.
 *
 * Separate from `state.musicOn`, which says whether it is actually PLAYING. A browser will not
 * start audio without a gesture, so a remembered "on" cannot be honoured at load: the speaker
 * would read as on over silence. The wish is kept here and acted on when a battle starts, by
 * which point several buttons have been pressed and the context will resume.
 */
let musicWanted = false;

const state = {
  format: "Doubles",
  tab: "play",
  screen: "setup",
  /**
   * Whether the opponent is shown your sets. Open by default, and the only kind of game the
   * ladder counts -- a closed-sheet opponent is guessing, and it guesses differently every run,
   * so two players bringing the same team would be rated against two different opponents.
   */
  sheet: "open",
  /** The six you chose from. */
  team: [],
  teamId: LADDER,
  teamName: "",
  /** The preview: their six, and the id the worker remembers the deal by. */
  previewId: "",
  foe: [],
  foeName: "",
  /** Indices into `team`, in the order they were clicked. The first ACTIVE of them lead. */
  bring: [],
  gameId: "",
  view: null,
  options: [],
  chosen: [],
  /** Whether each standing Pokemon is reaching for its stone this turn. Cleared with the turn. */
  mega: [],
  targeting: null,
  thinking: false,
  /** True while a turn is being played out on screen. Nothing may be chosen during one. */
  animating: false,
  caption: "",
  captionSide: null,
  error: "",
  musicOn: false,
  /** How long the turn animation takes, as a multiple of its base beats. See PACES. */
  pace: DEFAULT_PACE,
  /** What the ladder said about the last game, once it has said it. */
  lastRating: null,
};

// --- the worker ------------------------------------------------------------------------------

function ask(type, payload, onProgress) {
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
      else entry.reject(new Error(error || "The game could not continue."));
    });
    worker.addEventListener("error", (event) => {
      for (const [, entry] of pending) entry.reject(new Error(event.message || "The game stopped."));
      pending.clear();
    });
  }
  requestId += 1;
  const id = requestId;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject, onProgress }));
  worker.postMessage({ id, type, payload });
  return promise;
}

// --- teams ------------------------------------------------------------------------------------

/** The teams this browser has in the Team Builder, as sets. */
function savedTeams() {
  const app = getState();
  return (app.teams || [])
    .map((team) => ({ id: team.id, title: team.title, sets: teamSets(team, data).filter((set) => set?.species) }))
    .filter((team) => team.sets.length >= 1);
}

/** A team off the top of the ladder, for somebody who has not built one yet. */
function ladderTeam(format) {
  const rows = data.meta[format]?.pokemon || [];
  const sets = [];
  let stones = 0;
  for (const row of rows) {
    if (sets.length >= TEAM_SIZE) break;
    const set = setFromCommon(data.commonSet(format, row.species, row.form));
    if (!set.moves.length) continue;
    if (data.engine.isMegaStone(set.item)) {
      // One stone a side is the rule everything else in the app keeps, and a team that breaks it
      // cannot be played.
      if (stones) continue;
      stones += 1;
    }
    sets.push(set);
  }
  return sets;
}

/** Load whichever team the dropdown is on into `state.team`. */
function useTeam(id) {
  state.teamId = id;
  state.bring = [];
  if (id === LADDER) {
    state.team = ladderTeam(state.format);
    state.teamName = "Top of the ladder";
    return;
  }
  const team = savedTeams().find((entry) => entry.id === id);
  if (!team) {
    state.team = [];
    state.teamName = "";
    return;
  }
  state.team = team.sets.slice(0, TEAM_SIZE).map((set) => makeSet(set));
  state.teamName = team.title;
}

/**
 * Why this team cannot battle, or "" when it can.
 *
 * A reason and not a boolean, because "Pick a team first" under a team somebody has just picked
 * is the page refusing without saying what is wrong. A saved team with an empty slot in it is
 * the ordinary way to get here.
 */
function whyNotPlayable(sets) {
  const need = BRING[state.format];
  if (!sets.length) return "Pick a team first";
  // You bring four of six, so a team of three cannot field a Doubles battle however good it is.
  if (sets.length < need) return `${state.format} brings ${need}; this team has ${sets.length}`;
  const blank = sets.filter((set) => !set.species || !(set.moves || []).filter(Boolean).length);
  if (blank.length) {
    const named = blank.map((set) => set.species).filter(Boolean);
    return named.length
      ? `${named.join(" and ")} ${named.length === 1 ? "has" : "have"} no moves yet`
      : "One of these has nothing in it yet";
  }
  return "";
}

// --- rendering --------------------------------------------------------------------------------

function render() {
  if (!root) return;
  clear(root);
  root.append(
    h("div", { class: "bd-play-tabs" },
      segmented([["play", "Play"], ["leaderboard", "Leaderboard"]], state.tab, (value) => {
        state.tab = value;
        if (value === "leaderboard") syncBoardFormat();
        render();
        if (value === "leaderboard") loadBoard();
      }, { "aria-label": "Play or leaderboard" }),
      h("span", { class: "bd-play-record" }, recordLine())),
    state.tab === "leaderboard" ? renderBoard() : renderPlay());
}

function recordLine() {
  const record = loadRecord();
  const played = record.wins + record.losses + record.draws;
  if (!played) return "No games yet";
  const rate = Math.round((record.wins / played) * 100);
  // The rating only appears once the ladder has answered for a named player, so an unnamed
  // player or an unreachable ladder simply shows the record rather than a hole where a number
  // should be.
  const rating = Number.isFinite(record.elo) && record.elo ? ` · ${record.elo} Elo` : "";
  return `${record.wins}W ${record.losses}L${record.draws ? ` ${record.draws}D` : ""} · ${rate}% · ${played} game${played === 1 ? "" : "s"}${rating}`;
}

function renderPlay() {
  if (state.screen === "setup") return renderSetup();
  if (state.screen === "preview") return renderPreview();
  return renderBattle();
}

// --- the setup screen ---------------------------------------------------------------------------

function renderSetup() {
  const saved = savedTeams();
  const options = [
    ...saved.map((team) => [team.id, team.title || "Untitled team"]),
    [LADDER, "Top of the ladder"],
  ];
  const why = whyNotPlayable(state.team);
  return h("div", { class: "bd-play-setup" },
    state.error ? h("p", { class: "bd-play-error" }, state.error) : null,
    h("div", { class: "bd-card bd-play-intro" },
      h("h2", {}, "Play the Solver"),
      h("p", {},
        "The same search that runs on the Solver page. It brings a real tournament team and looks "
        + "ten turns ahead."),
      h("div", { class: "bd-play-setup-row" },
        segmented([["Doubles", "Doubles"], ["Singles", "Singles"]], state.format, async (value) => {
          if (value === state.format) return;
          state.format = value;
          // The other format's usage file has not been read yet, and everything that builds a
          // team off the ladder reads it: without this the Singles board came up with no team at
          // all and a Battle button that would not light.
          await data.loadMeta(value);
          useTeam(state.teamId);
          render();
        }, { "aria-label": "Battle format" }),
        h("label", { class: "bd-play-team-select" },
          h("span", {}, "Your team"),
          select(options, state.teamId, (value) => { useTeam(value); render(); }, { "aria-label": "Your team" }))),
      h("div", { class: "bd-play-sheet-row" },
        segmented([["open", "Open Team Sheet"], ["closed", "Closed Team Sheet"]], state.sheet, (value) => {
          if (value === state.sheet) return;
          state.sheet = value === "closed" ? "closed" : "open";
          try { localStorage.setItem(SHEET_KEY, state.sheet); } catch { /* private window */ }
          render();
        }, { "aria-label": "What the Solver is shown of your team" }),
        h("p", { class: "bd-play-note" }, state.sheet === "open"
          ? "The Solver is shown your sets, the way it sees a team on the Solver page. The same "
            + "game every time, so this is what the leaderboard rates."
          : "The Solver is not shown your sets. It guesses them from the usage data and only "
            + "learns a move by watching you use it — a harder opponent to read, and a different "
            + "game each time, so these are not rated."))),
    renderTeamCard(),
    h("div", { class: "bd-play-start" },
      h("button", {
        type: "button",
        class: "primary-button bd-play-go",
        disabled: Boolean(why) || undefined,
        onclick: () => deal(),
      }, why || "Find a battle")));
}

function renderTeamCard() {
  if (!state.team.length) {
    return h("div", { class: "bd-card" }, h("p", { class: "bd-play-note" }, "Pick a team to go on."));
  }
  return h("div", { class: "bd-card bd-play-team-card" },
    h("div", { class: "bd-play-team-head" },
      // The column's own name when the team has no title of its own. The preview screen and the
      // party row keep "Your team": there the Pokemon are on a board beside the opponent's and
      // "yours" is the distinction that matters, where here it is a column heading.
      h("h3", {}, state.teamName || "My Team"),
      h("p", { class: "bd-play-note" },
        `All six come to the battle. You choose the ${BRING[state.format]} you bring once you have `
        + "seen what you are up against."),
      // The rule is not guessable from the screen, and it is the one that decides whether a
      // rating is worth anything: a team is its CONTENTS, so changing a move is a new team on
      // the ladder with no record behind it.
      h("p", { class: "bd-play-note" },
        "On the ladder a team is what it is made of. Change a move, an item or a Pokémon and "
        + "it goes on as a new team, at the starting rating with no games behind it.")),
    h("div", { class: "bd-play-team-grid" }, state.team.map((set, index) => renderTeamSlot(set, index))),
    h("div", { class: "bd-play-team-actions" },
      state.team.length < TEAM_SIZE
        ? h("button", {
          type: "button", class: "ghost-button",
          onclick: async () => {
            const choice = await pickPokemon(data, { format: state.format, title: "Add to your team" });
            if (!choice) return;
            const set = setFromCommon(data.commonSet(state.format,
              choice.row ? choice.row.species : choice.species, choice.row ? choice.row.form : choice.form));
            state.team.push(set);
            render();
          },
        }, `Add a Pokémon (${state.team.length}/${TEAM_SIZE})`)
        : null));
}

function renderTeamSlot(set, index) {
  return h("div", { class: "bd-play-slot" },
    h("div", { class: "bd-play-slot-art" },
      sprite(data.sprite(set.species, set.form, set.item, { full: true }), "", 48, "bd-sprite")),
    h("div", { class: "bd-play-slot-body" },
      h("strong", {}, data.setName ? data.setName(set) : set.species),
      h("small", {}, [set.item || "No item", set.ability].filter(Boolean).join(" · ")),
      h("small", { class: "bd-play-slot-moves" }, (set.moves || []).filter(Boolean).join(", ") || "No moves")),
    h("div", { class: "bd-play-slot-tools" },
      h("button", {
        type: "button", class: "ghost-button bd-play-edit",
        onclick: async () => {
          const next = await editSet(data, set, { format: state.format, title: set.species, removeLabel: "Take off the team" });
          if (next === undefined) return;
          if (next === null) state.team.splice(index, 1);
          else state.team[index] = next;
          state.bring = [];
          render();
        },
      }, "Edit")));
}

// --- the team preview -----------------------------------------------------------------------------

/** Deal both teams and go to the preview. */
async function deal() {
  state.error = "";
  state.thinking = true;
  state.screen = "preview";
  state.bring = [];
  state.foe = [];
  state.previewId = "";
  render();
  try {
    const answer = await ask("play", {
      action: "preview",
      format: state.format,
      settings: getState().settings || {},
      seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0,
    });
    state.previewId = answer.previewId || "";
    state.foe = answer.foe || [];
    state.foeName = answer.foeName || "";
  } catch (error) {
    state.error = error.message || "The teams could not be dealt.";
    state.screen = "setup";
  }
  state.thinking = false;
  render();
}

/** Click one of yours to bring it, click it again to put it back. */
function toggleBring(index) {
  const at = state.bring.indexOf(index);
  if (at >= 0) state.bring.splice(at, 1);
  else if (state.bring.length < BRING[state.format]) state.bring.push(index);
  render();
}

function renderPreview() {
  if (state.thinking && !state.foe.length) {
    return h("div", { class: "bd-card" },
      h("div", { class: "bd-loading", role: "status" },
        h("span", { class: "bd-spinner", "aria-hidden": "true" }), "Dealing the teams…"));
  }
  const need = BRING[state.format];
  const lead = ACTIVE[state.format];
  const ready = state.bring.length === need;
  return h("div", { class: "bd-play-preview" },
    state.error ? h("p", { class: "bd-play-error" }, state.error) : null,
    h("div", { class: "bd-card bd-play-preview-head" },
      h("h2", {}, "Team preview"),
      h("p", { class: "bd-play-note" },
        `Choose the ${need} you bring, in order. The first ${lead} lead; the `
        + `${need - lead === 1 ? "last one waits" : `last ${need - lead} wait`} behind. `
        + "Click one again to put it back.")),
    h("div", { class: "bd-play-preview-grid" },
      h("div", { class: "bd-card bd-play-preview-side ours" },
        h("h3", {}, state.teamName || "Your team"),
        h("div", { class: "bd-play-preview-list" }, state.team.map((set, index) => renderPreviewPick(set, index)))),
      h("div", { class: "bd-card bd-play-preview-side theirs" },
        h("h3", {}, "The Solver"),
        h("div", { class: "bd-play-preview-list" }, state.foe.map((mon) => h("div", { class: "bd-play-preview-mon" },
          sprite(mon.sprite, "", 44, "bd-sprite"),
          h("span", { class: "bd-play-preview-name" }, mon.name || mon.species)))))),
    h("div", { class: "bd-play-start" },
      h("button", {
        type: "button", class: "ghost-button",
        onclick: () => { state.screen = "setup"; render(); },
      }, "Change team"),
      h("button", {
        type: "button", class: "primary-button bd-play-go",
        disabled: !ready || undefined,
        onclick: () => startGame(),
      }, ready ? "Battle" : `Choose ${need - state.bring.length} more`)));
}

function renderPreviewPick(set, index) {
  const at = state.bring.indexOf(index);
  const picked = at >= 0;
  const leads = picked && at < ACTIVE[state.format];
  return h("button", {
    type: "button",
    class: `bd-play-preview-mon pick${picked ? " on" : ""}`,
    "aria-pressed": picked ? "true" : "false",
    onclick: () => toggleBring(index),
  },
  sprite(data.sprite(set.species, set.form, set.item, { full: true }), "", 44, "bd-sprite"),
  h("span", { class: "bd-play-preview-name" }, data.setName ? data.setName(set) : set.species),
  picked
    ? h("span", { class: `bd-play-preview-order${leads ? " lead" : ""}` }, `${at + 1} · ${leads ? "Lead" : "Back"}`)
    : null);
}

/** The sets you brought, in the order you brought them. */
function broughtSets() {
  return state.bring.map((index) => makeSet(state.team[index]));
}

// --- the battle ---------------------------------------------------------------------------------

async function startGame() {
  if (!state.previewId) { await deal(); return; }
  state.error = "";
  state.thinking = true;
  state.screen = "battle";
  state.view = null;
  render();
  try {
    const answer = await ask("play", {
      action: "start",
      format: state.format,
      settings: getState().settings || {},
      previewId: state.previewId,
      sheet: state.sheet,
      team: broughtSets(),
      // The whole six, so the opponent chooses its own four against the team preview it was
      // shown rather than against the four you picked -- which it has no way of knowing.
      six: state.team,
    });
    if (answer.error) {
      // The deal has been forgotten -- a reload, or the tab left long enough to be evicted.
      // Dealing again is the only thing that can be done about it, so it happens rather than
      // being reported.
      state.previewId = "";
      state.thinking = false;
      await deal();
      return;
    }
    state.lastRating = null;
    state.gameId = answer.gameId;
    state.view = answer.view;
    state.options = answer.options;
    state.foeName = answer.foeName || state.foeName;
    // What is actually being played, as the GAME reports it -- not what the page asked for. An
    // old cached worker answers without it and really is playing the closed sheet.
    state.sheet = answer.sheet === "open" ? "open" : "closed";
    state.chosen = [];
    state.mega = [];
    state.caption = "";
    revealed.clear();
    await musicForBattle(true);
    render();
    // The teams coming out is a turn like any other -- the opening record carries its own stream,
    // with a `send` for each lead and the entry Abilities that fire as they arrive -- so it is
    // played rather than appearing already finished.
    await playOut(state.view?.log?.[0]);
  } catch (error) {
    state.error = error.message || "The game could not start.";
    state.screen = "preview";
  }
  state.thinking = false;
  render();
}

/** Every Pokemon that has something to choose has had it chosen, and nothing is half-chosen. */
function turnReady() {
  const slots = state.options.filter((slot) => !slot.empty);
  return slots.length > 0 && !state.targeting && slots.every((slot) => state.chosen[slot.position]);
}

/**
 * Called after every choice. A turn starts the moment it CAN start.
 *
 * There is no button between choosing and playing: the last click of a turn is the one that plays
 * it. That is what makes a game feel like a game rather than a form, and it is why Clear is worth
 * having -- it is the only way back, so it stays on screen the whole time.
 */
function afterChoice() {
  render();
  if (turnReady()) sendTurn();
}

async function sendTurn() {
  if (state.thinking || state.animating || !state.gameId) return;
  state.thinking = true;
  render();
  let answer;
  try {
    answer = await ask("play", {
      action: "turn",
      format: state.format,
      settings: getState().settings || {},
      gameId: state.gameId,
      chosen: state.chosen,
    });
  } catch (error) {
    state.error = error.message || "The turn could not be played.";
    state.thinking = false;
    render();
    return;
  }
  state.thinking = false;
  if (answer.error) {
    // The worker answers with an error only when the game it was asked about is gone -- a
    // reload, or the tab having been left long enough for the game to be evicted. Staying on a
    // board that cannot be played leaves the person clicking at nothing, so the error goes
    // where it can be acted on.
    state.error = answer.error;
    state.screen = "setup";
    state.gameId = "";
    state.view = null;
    state.options = [];
    render();
    return;
  }
  // Played out on the board that is still on screen -- the one from before the turn -- and only
  // then is the worker's board committed. See builder/play-anim.js.
  await playOut(answer.record);
  state.view = answer.view;
  state.options = answer.options || [];
  state.chosen = [];
  state.mega = [];
  state.targeting = null;
  state.caption = "";
  if (answer.view.over) await musicForBattle(false);
  render();
  if (answer.view.over) finishGame(resultOf(answer.view.over));
  const log = document.querySelector(".bd-play-log");
  if (log) log.scrollTop = log.scrollHeight;
}

/** Walk the turn's steps in front of the person. */
async function playOut(record) {
  // The game sends a real stream. `streamFromRecord` is the floor under it: it rebuilds a
  // playable sequence out of the four buckets the record has always carried, so a turn still
  // plays out in order if the stream is ever missing rather than appearing all at once.
  const steps = record?.stream?.length ? record.stream : streamFromRecord(record, tagByName);
  if (!steps.length) return;
  state.animating = true;
  state.caption = "";
  render();
  // The stylesheet scales its own durations by this, so the two cannot disagree.
  try { document.documentElement.style.setProperty("--beat-scale", String(state.pace)); } catch { /* no DOM */ }
  turnPlayer = createTurnPlayer({
    pace: state.pace,
    monEl: (side, tag) => (tag === null || tag === undefined
      ? null
      : document.querySelector(`.bd-play-mon[data-side="${side}"][data-tag="${tag}"]`)),
    monInfo: (side, tag) => {
      const mon = monAt(side, tag);
      if (!mon) return null;
      return {
        tag,
        name: mon.name || mon.species,
        // The board the worker just sent, which is where the turn LEFT it -- the one coming in
        // may already have taken Stealth Rock or a hit in the same turn it arrived.
        hp: mon.hp,
        sprite: data.sprite(mon.species, mon.form, mon.item, { full: true }),
      };
    },
    freeSeat: (side) => document.querySelector(`.bd-play-mon[data-side="${side}"].down`)
      || document.querySelector(`.bd-play-mon[data-side="${side}"].empty`),
    // Where a side stands, so a spread move -- which names nobody -- can still be aimed at it.
    sideBox: (side) => {
      const row = document.querySelector(`.bd-play-actives.${side === 0 ? "ours" : "theirs"}`);
      return row ? row.getBoundingClientRect() : null;
    },
    nameOf: (side, tag) => nameFor(state.view, side, tag),
    // A sprite for a form the board on screen does not know about yet -- the Mega a Pokemon is
    // becoming in the middle of this turn. No item: `data.sprite` runs a Mega Stone holder
    // through `battleForm` and would draw the Mega before it had evolved.
    spriteFor: (species, form) => data.sprite(species, form, "", { full: true }),
    caption: (text, side) => {
      state.caption = text;
      state.captionSide = side ?? null;
      const node = document.querySelector(".bd-play-caption");
      if (node) {
        node.textContent = text;
        node.className = `bd-play-caption showing${side === 0 ? " ours" : side === 1 ? " theirs" : ""}`;
      }
    },
  });
  try {
    await turnPlayer.play(steps);
  } finally {
    turnPlayer = null;
    state.animating = false;
  }
}

/** One Pokemon of the board the worker last sent, by the tag that follows it all game. */
function monAt(side, tag) {
  if (tag === null || tag === undefined) return null;
  return (state.view?.sides?.[side] || []).find((entry) => entry.tag === tag) || null;
}

/**
 * Everything known about one Pokemon, laid out the way the Team Builder lays a set out.
 *
 * KNOWN is the operative word. Ours is open to us -- it is our team. Theirs is only what the
 * game has actually shown: the moves it has used, the item and the Ability if it has given
 * either away. A closed sheet that filled this in from the real set would hand over exactly the
 * thing the closed sheet exists to withhold.
 */
function showMon(view, side, tag) {
  const mon = monByTag(view, side, tag);
  if (!mon) return;
  // Under an OPEN team sheet both sheets are open, so the opponent's panel is as full as our
  // own. Under a closed one only what it has shown us, which is the whole point of that mode.
  const known = side === 0 || state.sheet === "open";
  const row = (label, value) => h("div", { class: "bd-play-info-row" },
    h("span", { class: "bd-play-info-key" }, label),
    h("span", { class: "bd-play-info-value" }, value));
  // A FUNCTION, NOT A NODE. One element cannot be in three rows: appending it to the second
  // MOVES it out of the first, which left the Item row blank instead of "not shown yet".
  const unknown = () => h("span", { class: "bd-play-info-unknown" }, "not shown yet");
  const stages = [["atk", "Attack"], ["spa", "Sp. Atk"], ["spe", "Speed"], ["def", "Defense"], ["spd", "Sp. Def"]]
    .map(([key, name]) => (mon[key] ? `${name} ${mon[key] > 0 ? "+" : ""}${mon[key]}` : ""))
    .filter(Boolean);
  // Ours is read straight off the sheet. Theirs is read off what the game has SHOWN us -- the
  // moves they have used, an item they have spent, an Ability that has done something -- which
  // is the same information they are getting about us, and the honest answer to "all known info".
  const seen = mon.revealed || { moves: [], item: "", ability: "" };
  const item = known ? mon.item : seen.item;
  const ability = known ? mon.ability : seen.ability;
  const moves = (known ? mon.moves || [] : seen.moves || []).filter(Boolean);
  const dialog = openDialog({
    title: mon.name || mon.species,
    body: h("div", { class: "bd-play-info" },
      h("div", { class: "bd-play-info-head" },
        sprite(data.sprite(mon.species, mon.form, "", { full: true }), "", 72, "bd-sprite bd-sprite-lg"),
        h("div", {},
          h("strong", {}, mon.name || mon.species),
          h("div", { class: "bd-play-note" },
            `${mon.out ? "Fainted" : `${mon.hp}% left`}${mon.status ? ` · ${mon.status}` : ""}`),
          stages.length ? h("div", { class: "bd-play-note" }, stages.join(" · ")) : null)),
      row("Item", item || (known ? "No item" : unknown())),
      row("Ability", ability || (known ? "—" : unknown())),
      // Only on an open sheet: a Nature and a Stat spread are never "revealed" by watching.
      known && mon.nature ? row("Nature", mon.nature) : null,
      known && mon.spread ? row("Stat Points", String(mon.spread).replace(/^Current:\s*/, "")) : null,
      row("Moves", moves.length
        ? h("div", { class: "bd-play-info-moves" }, moves.map((move) => h("span", { class: "bd-play-info-move" }, move)))
        : (known ? "—" : unknown())),
      // Only once SOMETHING is known: with nothing shown the Moves row already says so, and
      // both lines together read as two different facts about the same empty list.
      known || moves.length === 0 || moves.length >= 4 ? null
        : row("", h("span", { class: "bd-play-info-unknown" },
          `${4 - moves.length} more not shown yet`)),
      known ? null : h("p", { class: "bd-play-note" },
        "Only what this Pokémon has shown you. It learns about yours the same way.")),
    actions: [h("button", { class: "primary-button", type: "button", onclick: () => dialog.close() }, "Close")],
    wide: true,
  });
}

/** The tag standing in the way of a name, for the fallback stream. */
function tagByName(side, name) {
  const mon = (state.view?.sides?.[side] || []).find((entry) => (entry.name || entry.species) === name
    || entry.species === name);
  return mon ? mon.tag : null;
}

/**
 * Write one finished game down, however it finished.
 *
 * Resigning and playing it out go through here together on purpose. They used to be written
 * separately and the resignation left the team off, which gave it a DIFFERENT ladder entry --
 * the empty team -- so a resigned game rated a team nobody had ever brought.
 */
function finishGame(result, { resigned = false } = {}) {
  const { reported } = recordGame({
    format: state.format,
    result,
    turns: state.view?.turn || 0,
    teamName: state.teamName,
    foeName: state.foeName,
    resigned,
    // Only an open sheet is rated; `report` in play-record.js refuses anything else.
    sheet: state.sheet,
    // The game's OWN id, so the ladder can tell a retry from a replay. Without one the server
    // mints a fresh id per request and the same finished game, sent twice, counts twice.
    clientGameId: state.gameId || "",
    // The team that was SUBMITTED -- all six -- which is what the ladder rates. Its contents
    // are its identity, so changing one move is a new entry with its own record rather than a
    // continued one. Only what identifies it travels: no stat points, no nicknames.
    //
    // All six, and SORTED, because the four brought are chosen per game and in click order: a
    // team rated on those would get a different ladder entry -- at the starting rating, with no
    // games behind it -- every time the player led with the other two, or merely picked the same
    // four in a different order.
    team: state.team
      .map((set) => ({
        species: set.species, form: set.form, item: set.item,
        ability: set.ability, nature: set.nature, moves: [...(set.moves || [])].sort(),
      }))
      .sort((a, b) => `${a.species}|${a.form}`.localeCompare(`${b.species}|${b.form}`)),
    lookahead: 10,
    log: state.view?.log || [],
  });
  // The result screen is already up by the time the ladder answers, so the rating is written in
  // when it arrives rather than the screen waiting for it.
  reported.then((answer) => {
    if (!answer) return;
    state.lastRating = answer;
    render();
  }).catch(() => {});
}

/** Which of the three words a finished game is, from the player's side. */
const resultOf = (over) => (over.winner === 0 ? "win" : over.winner === 1 ? "loss" : "draw");

function renderBattle() {
  const view = state.view;
  if (!view) {
    return h("div", { class: "bd-card" },
      h("div", { class: "bd-loading", role: "status" }, h("span", { class: "bd-spinner", "aria-hidden": "true" }), "Sending them out…"));
  }
  return h("div", { class: "bd-play-battle" },
    h("div", { class: "bd-play-field-wrap" }, renderStage(view), renderControls(view)),
    renderLog(view));
}

/**
 * The field, with a party row on each side of it.
 *
 * Theirs sits ABOVE the field and to the RIGHT, ours BELOW it and to the LEFT, which is the
 * diagonal the game itself uses: the two rows read as the two sides of the table rather than as
 * one list of twelve. All six are shown on each side, the two left out of the battle dimmed --
 * you saw their six at preview, and which two they held back is worth remembering.
 */
function renderStage(view) {
  // Whatever is standing has been seen, and stays seen.
  for (const tag of view.standing[1] || []) if (tag !== null && tag !== undefined) revealed.add(tag);
  return h("div", {
    class: `bd-play-stage${state.animating ? " playing" : ""}`,
    // A turn being played out is a thing somebody may have seen enough of.
    onclick: state.animating ? () => turnPlayer?.skip() : undefined,
    title: state.animating ? "Click to skip to the end of the turn" : undefined,
  },
  h("div", { class: "bd-play-party-row theirs" },
    h("span", { class: "bd-play-side-name" }, "The Solver"),
    h("div", { class: "bd-play-party" }, partyOf(view, 1))),
  h("div", { class: "bd-play-field" },
    // Nothing stands between the two sides. The turn and the conditions share the line above the
    // field, and the message has a row of its own below our Pokemon -- so the two teams face
    // each other across an empty board, which is the whole point of a battlefield.
    h("div", { class: "bd-play-weather" },
      h("span", { class: "bd-play-turn" }, view.turn ? `Turn ${view.turn}` : "The teams come out"),
      // Just the field. Which sheet is being played is a setup choice and is said there; on the
      // battlefield it is noise above the Pokemon. A closed sheet still says so, because that
      // one changes whether the game counts.
      h("span", { class: "bd-play-conditions" }, conditionsOf(view).join(" · ") || "Clear"),
      state.sheet === "open"
        ? null
        : h("span", { class: "bd-play-unrated" }, "Closed sheet · unrated")),
    h("div", { class: "bd-play-actives theirs" }, activesOf(view, 1)),
    h("div", { class: "bd-play-actives ours" }, activesOf(view, 0)),
    // BELOW our Pokemon, not between the two sides. Sitting in the middle it split the field in
    // half and pushed the two teams apart; the game it is modelled on puts the message under
    // your own side, where it is read without looking away from what just happened. It keeps its
    // own row so it can never overlap a Pokemon.
    h("div", {
      class: `bd-play-caption${state.caption ? " showing" : ""}${state.captionSide === 0 ? " ours" : state.captionSide === 1 ? " theirs" : ""}`,
      role: "status",
    }, state.caption)),
  h("div", { class: "bd-play-party-row ours" },
    h("div", { class: "bd-play-party" }, partyOf(view, 0)),
    h("span", { class: "bd-play-side-name" }, state.teamName || "Your team")));
}

function conditionsOf(view) {
  const out = [];
  // The field arrives already said in words. The page used to translate it from indices with a
  // copy of the engine's lists, and that copy had Psychic and Misty the other way round.
  if (view.field.weather && view.field.weather !== "None") out.push(view.field.weather);
  if (view.field.terrain && view.field.terrain !== "None") out.push(`${view.field.terrain} Terrain`);
  if (view.field.trickRoom) out.push("Trick Room");
  if (view.field.tailwind[0]) out.push("Your Tailwind");
  if (view.field.tailwind[1]) out.push("Their Tailwind");
  return out;
}

/**
 * All six of a side, as small sprites.
 *
 * Four of the six are in the battle and carry their health; the other two were left at preview
 * and are dimmed. Ours are matched by the order they were brought in, theirs by species, because
 * the species clause means a species names exactly one Pokemon on a team.
 */
function partyOf(view, side) {
  const inPlay = view.sides[side] || [];
  // Named by the BASE form, like the sprite beside it: a Garchomp holding its stone is a
  // Garchomp until it Mega Evolves, and `setName` would call it "Garchomp-Mega-Z" from the
  // first turn. Once it is on the board the battler's own name is used instead, which becomes
  // the Mega's the moment it evolves.
  const whole = side === 0
    ? state.team.map((set) => ({ species: set.species, form: set.form, name: set.form || set.species }))
    : state.foe.map((mon) => ({ species: mon.species, form: mon.form, name: mon.name || mon.species }));
  // Paired on SPECIES, not on species-and-form: a team cannot hold two of one species, and a
  // Mega Evolution changes the form -- which used to break the pairing and draw the Pokemon
  // standing in the middle of the field as "not brought".
  //
  // A LIST per species, consumed as it is matched, so a board that somehow holds two of one
  // never hands the same battler to both tiles.
  const playing = new Map();
  for (const mon of inPlay) {
    const at = compactName(mon.species);
    if (!playing.has(at)) playing.set(at, []);
    playing.get(at).push(mon);
  }
  const rows = whole.length ? whole : inPlay;
  return rows.map((entry) => {
    const queue = playing.get(compactName(entry.species));
    const found = queue && queue.length ? queue.shift() : null;
    const standing = found ? view.standing[side].includes(found.tag) : false;
    // THE OPPONENT'S BENCH IS NOT YOURS TO SEE. You are shown their six at team preview and not
    // which four they brought, so a Pokemon of theirs stays grey until it has actually stood on
    // the field. Ours are all known, because they are ours.
    const known = side === 0 || standing || revealed.has(found?.tag);
    const mon = known ? found : null;
    // Drawn as it IS: the live form once it is on the board, so a Mega shows as its Mega, and
    // never with the item -- `data.sprite` upgrades a stone holder to its Mega before it has
    // evolved.
    const species = mon ? mon.species : entry.species;
    const form = mon ? mon.form : entry.form;
    const name = mon ? (mon.name || mon.species) : entry.name;
    const label = mon
      ? `${name}${mon.out ? " — fainted" : ` — ${mon.hp}%`}${standing ? ", on the field" : ""}`
      : `${entry.name}${side === 0 ? " — not brought" : " — not seen yet"}`;
    return h("button", {
      type: "button",
      class: `bd-play-pip${!mon ? " benched" : ""}${mon?.out ? " down" : ""}${standing ? " standing" : ""}`,
      title: mon ? `${label} — click to look` : label,
      "aria-label": label,
      // DISABLED WHILE THE TURN PLAYS, like the tiles above. Every pip sits inside
      // `.bd-play-stage`, whose click skips the rest of the animation, so an enabled pip both
      // threw the turn away and opened a card -- and the card was built from the board as it was
      // BEFORE the turn, because that is what is still on screen while it plays.
      disabled: !mon || state.animating ? true : undefined,
      // `state.view`, not the view this render closed over: by the time anyone clicks, the turn
      // may have finished and moved on.
      onclick: mon ? () => showMon(state.view, side, mon.tag) : undefined,
    }, sprite(data.sprite(species, form, ""), "", 26));
  });
}

/** One Pokemon of a side, BY TAG. The list is not in tag order -- a switch swaps two of it. */
function monByTag(view, side, tag) {
  if (tag === null || tag === undefined) return null;
  return (view.sides[side] || []).find((mon) => mon.tag === tag) || null;
}

function activesOf(view, side) {
  return view.standing[side].map((tag, position) => {
    const mon = monByTag(view, side, tag);
    if (!mon) return h("div", { class: "bd-play-mon empty" }, "Empty");
    return renderMon(mon, side, position);
  });
}

function renderMon(mon, side, position) {
  const bar = Math.max(0, Math.min(100, mon.hp));
  const chips = [];
  if (mon.status) chips.push(mon.status);
  for (const [key, label] of [["atk", "Atk"], ["spa", "SpA"], ["spe", "Spe"], ["def", "Def"]]) {
    const stage = Number(mon[key]) || 0;
    if (stage) chips.push(`${label} ${stage > 0 ? "+" : ""}${stage}`);
  }
  const targeting = state.targeting;
  const canTarget = Boolean(targeting) && !state.animating && side === 1 && !mon.out
    && targeting.targets.includes(position);
  return h("button", {
    type: "button",
    // The animation finds a Pokemon by these two: the side it is on and its tag, which stays the
    // same for the whole game however often it switches in and out.
    "data-side": String(side),
    "data-tag": String(mon.tag),
    class: `bd-play-mon${mon.out ? " down" : ""} active${canTarget ? " targetable" : ""}`,
    disabled: state.animating && !canTarget ? true : undefined,
    onclick: canTarget ? () => chooseTarget(position) : () => showMon(state.view, side, mon.tag),
    title: canTarget ? undefined : `Look at ${mon.name || mon.species}`,
  },
  // No item: `data.sprite` runs it through `battleForm`, which draws a Mega Stone holder as its
  // Mega before it has evolved. The form is already the Mega's once it has.
  sprite(data.sprite(mon.species, mon.form, "", { full: true }), "", 64, "bd-sprite bd-sprite-lg"),
  h("span", { class: "bd-play-mon-name" }, mon.name || mon.species),
  h("span", { class: "bd-play-hp" },
    h("i", { class: `bd-play-hp-fill${bar <= 20 ? " low" : bar <= 50 ? " mid" : ""}`, style: { width: `${bar}%` } })),
  h("span", { class: "bd-play-hp-text" }, mon.out ? "fainted" : `${bar}%`),
  h("span", { class: "bd-play-chips" }, chips.join(" · ")),
  // Where the turn's effects are drawn: the screen Protect puts up, the burst of a hit, the
  // streak of a miss. Empty until something happens to this Pokemon. See builder/play-anim.js.
  h("span", { class: "bd-play-fx", "aria-hidden": "true" }));
}

// --- choosing a turn -------------------------------------------------------------------------------

function chooseTarget(position) {
  const { slot, action } = state.targeting;
  const pick = state.options[slot].actions.find((a) => a.move === action.move
    && a.mega === action.mega && a.kind === action.kind && a.target === position);
  state.targeting = null;
  if (pick) state.chosen[slot] = pick.id;
  afterChoice();
}

function renderControls(view) {
  if (view.over) return renderResult(view);
  if (state.animating) {
    return h("div", { class: "bd-play-controls" },
      h("p", { class: "bd-play-note" }, "Playing out the turn… click the field to skip."));
  }
  if (state.thinking) {
    return h("div", { class: "bd-play-controls" },
      h("div", { class: "bd-loading", role: "status" },
        h("span", { class: "bd-spinner", "aria-hidden": "true" }),
        "The Solver is thinking…"));
  }
  const slots = state.options.filter((slot) => !slot.empty);
  const left = slots.filter((slot) => !state.chosen[slot.position]).length;
  return h("div", { class: "bd-play-controls" },
    state.error ? h("p", { class: "bd-play-error" }, state.error) : null,
    state.targeting
      ? h("p", { class: "bd-play-note targeting" }, `Pick a target for ${state.targeting.action.move}.`)
      : null,
    h("div", { class: "bd-play-slots" }, slots.map((slot) => renderSlotChoice(slot, view))),
    h("div", { class: "bd-play-submit" },
      // Off by default, and the speaker is the only thing that turns it on. Left of Clear.
      h("button", {
        type: "button",
        class: `ghost-button bd-play-music${state.musicOn ? " on" : ""}`,
        "aria-pressed": state.musicOn ? "true" : "false",
        "aria-label": state.musicOn ? "Turn the music off" : "Turn the music on",
        title: state.musicOn ? "Music off" : "Music on",
        onclick: () => toggleMusic(),
      }, state.musicOn ? "🔊" : "🔈"),
      h("button", {
        type: "button", class: "ghost-button",
        onclick: () => { state.chosen = []; state.mega = []; state.targeting = null; render(); },
      }, "Clear"),
      h("button", {
        type: "button", class: "ghost-button bd-play-resign",
        onclick: () => resign(),
      }, "Resign"),
      h("label", { class: "bd-play-pace" },
        h("span", {}, "Pace"),
        select(PACES.map(([value, label]) => [String(value), label]), String(state.pace), (value) => {
          state.pace = Number(value) || DEFAULT_PACE;
          try { localStorage.setItem(PACE_KEY, String(state.pace)); } catch { /* private window */ }
          try { document.documentElement.style.setProperty("--beat-scale", String(state.pace)); } catch { /* no DOM */ }
          render();
        }, { "aria-label": "How fast a turn plays out" })),
      h("span", { class: "bd-play-note bd-play-hint" },
        left ? `Choose for ${left} more and the turn plays itself out.` : "")));
}

async function toggleMusic() {
  state.musicOn = await music.toggle();
  musicWanted = state.musicOn;
  try { localStorage.setItem(MUSIC_KEY, musicWanted ? "1" : "0"); } catch { /* private window */ }
  render();
}

/** Music belongs to a battle. It starts with one if it is wanted and stops when one ends. */
async function musicForBattle(on) {
  if (on && musicWanted && !music.playing) {
    await music.start();
  } else if (!on && music.playing) {
    music.stop();
  }
  state.musicOn = music.playing;
}

/**
 * Why the game will not take this move this turn, or "" when it will.
 *
 * Only the two rules that really remove a move are named; anything else gets the plain sentence
 * rather than a guess at a reason.
 */
function whyRefused(move, mon) {
  const name = String(move || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!mon) return "Not available this turn";
  if (mon.guardedLast && /^(protect|detect|spikyshield|banefulbunker|silktrap|kingsshield|obstruct|burningbulwark)$/.test(name)) {
    return "It protected last turn, so it cannot protect again";
  }
  if (!mon.justIn && (name === "fakeout" || name === "firstimpression")) {
    return "Only on the turn it comes in";
  }
  return "Not available this turn";
}

function renderSlotChoice(slot, view) {
  const chosen = state.chosen[slot.position];
  const canMega = slot.actions.some((a) => a.mega);
  const megaOn = Boolean(state.mega[slot.position]) && canMega;
  // One button per MOVE, not per move-and-target: a Doubles move with two targets is one choice
  // followed by a second, which is how the game asks it. And the stone is a switch over the whole
  // list rather than a second copy of every button -- the engine offers it as a flag on each
  // move, so a stone holder came out with its four moves twice over, eight buttons for four
  // moves, which is neither how the game asks it nor how anybody reads it.
  const byMove = new Map();
  for (const action of slot.actions) {
    if (action.into !== null && action.into !== undefined) continue;
    if (Boolean(action.mega) !== megaOn) continue;
    if (!byMove.has(action.move)) byMove.set(action.move, []);
    byMove.get(action.move).push(action);
  }
  const switches = slot.actions.filter((a) => a.into !== null && a.into !== undefined);
  const picked = slot.actions.find((a) => a.id === chosen);
  return h("div", { class: `bd-play-slot-choice${picked ? " done" : ""}` },
    h("div", { class: "bd-play-choice-head" },
      h("strong", {}, slot.name),
      picked
        ? h("span", { class: "bd-play-picked" },
          `${picked.move}${picked.targetName ? ` → ${picked.targetName}` : ""}${picked.mega ? " + Mega" : ""}`)
        : h("span", { class: "bd-play-picked none" }, "nothing chosen"),
      canMega
        ? h("button", {
          type: "button",
          class: `bd-play-mega-toggle${megaOn ? " on" : ""}`,
          "aria-pressed": megaOn ? "true" : "false",
          title: megaOn
            ? "Mega Evolving this turn. Click to call it off."
            : "Mega Evolve this Pokémon as it acts this turn",
          onclick: () => {
            // One stone a side. Arming the second seat used to be allowed and then silently
            // ignored by the game, so the player watched the Pokemon they chose stay as it was
            // with nothing said about it.
            if (!megaOn) state.mega = [];
            state.mega[slot.position] = !megaOn;
            // Keep whatever they had chosen, in the other form of it.
            const was = slot.actions.find((a) => a.id === state.chosen[slot.position]);
            if (was) {
              const same = slot.actions.find((a) => a.move === was.move && a.target === was.target
                && a.kind === was.kind && Boolean(a.mega) === !megaOn);
              state.chosen[slot.position] = same ? same.id : undefined;
            }
            state.targeting = null;
            render();
          },
        },
        h("i", { class: "bd-play-mega-gem", "aria-hidden": "true" }),
        h("span", { class: "bd-play-mega-text" }, "Mega Evolve"))
        : null),
    // ALL FOUR, always. A move the game will not take this turn is drawn refused, with the
    // reason, rather than quietly left out -- see `whyRefused`.
    h("div", { class: "bd-play-moves" }, (() => {
      const mon = monByTag(view, 0, (view.standing[0] || [])[slot.position]);
      const offered = [...byMove.values()];
      const have = new Set(offered.map((group) => compactName(group[0].move)));
      const refused = (mon?.moves || [])
        .filter(Boolean)
        .filter((move) => !have.has(compactName(move)))
        .map((move) => h("button", {
          type: "button",
          class: "bd-play-move refused",
          disabled: true,
          title: whyRefused(move, mon),
          "aria-label": `${move}. ${whyRefused(move, mon)}`,
        },
        h("span", { class: "bd-play-move-name" }, move),
        h("span", { class: "bd-play-move-tag" }, whyRefused(move, mon))));
      return [...offered.map((group) => {
      const first = group[0];
      const on = picked && picked.move === first.move && Boolean(picked.mega) === megaOn;
      return h("button", {
        type: "button",
        class: `bd-play-move${on ? " on" : ""}${megaOn ? " mega" : ""}`,
        "aria-pressed": on ? "true" : "false",
        onclick: () => {
          // Clicking what is already chosen takes it back. Without this the last choice of a
          // turn could not be changed at all, because making it starts the turn.
          if (on) {
            state.chosen[slot.position] = undefined;
            if (state.targeting?.slot === slot.position) state.targeting = null;
            render();
            return;
          }
          const targets = group.filter((a) => a.target >= 0).map((a) => a.target);
          if (targets.length > 1) {
            // The old choice goes NOW, not when a target is picked. Without this the slot still
            // held the move being replaced, so `turnReady` counted it as chosen -- and the last
            // click of a turn started it with the OLD move while a prompt for the new one was
            // still on screen.
            state.chosen[slot.position] = undefined;
            state.targeting = { slot: slot.position, action: first, targets };
            render();
            return;
          }
          state.chosen[slot.position] = group[0].id;
          // Only this slot's own prompt is cancelled: clearing it outright let one seat's click
          // cancel the prompt the OTHER seat was waiting on.
          if (state.targeting?.slot === slot.position) state.targeting = null;
          afterChoice();
        },
      },
      h("span", { class: "bd-play-move-name" }, first.move),
      first.spread ? h("span", { class: "bd-play-move-tag" }, "Spread") : null);
      }), ...refused];
    })()),
    switches.length
      ? h("div", { class: "bd-play-switches" }, switches.map((action) => {
        const on = Boolean(picked && picked.id === action.id);
        return h("button", {
          type: "button",
          class: `bd-play-switch${on ? " on" : ""}`,
          "aria-pressed": on ? "true" : "false",
          onclick: () => {
            if (on) {
              state.chosen[slot.position] = undefined;
              if (state.targeting?.slot === slot.position) state.targeting = null;
              render();
              return;
            }
            state.chosen[slot.position] = action.id;
            if (state.targeting?.slot === slot.position) state.targeting = null;
            afterChoice();
          },
        }, `→ ${action.intoName}`);
      }))
      : null);
}

function resign() {
  const { close } = openDialog({
    title: "Resign this game?",
    body: h("p", {}, "It counts as a loss."),
    actions: [
      h("button", { class: "ghost-button", type: "button", onclick: () => close() }, "Keep playing"),
      h("button", {
        class: "primary-button", type: "button",
        onclick: async () => {
          close();
          // The board is left FIRST, and the worker is told afterwards. Resigning used to wait
          // on the worker before leaving, so the Resign button stayed on screen and clickable
          // for as long as that took -- and a second click wrote a second loss for one game.
          const gameId = state.gameId;
          if (!gameId) return;
          await musicForBattle(false);
          finishGame("loss", { resigned: true });
          state.screen = "setup";
          state.gameId = "";
          state.view = null;
          state.options = [];
          render();
          // Nothing reads the answer; this only lets the worker drop the game.
          ask("play", { action: "resign", format: state.format, settings: getState().settings || {}, gameId })
            .catch(() => {});
        },
      }, "Resign"),
    ],
  });
}

function renderResult(view) {
  const won = view.over.winner === 0;
  const drew = view.over.winner === "draw";
  return h("div", { class: `bd-play-controls bd-play-result${won ? " won" : drew ? "" : " lost"}` },
    h("h2", {}, drew ? "A draw" : won ? "You win" : "The Solver wins"),
    h("p", {}, view.over.why),
    h("p", { class: "bd-play-note" }, `${view.turn} turns · ${recordLine()}`),
    // Said on the result rather than only on the setup screen: this is the moment somebody looks
    // for their rating, and a game that was never going to count should say so here.
    state.sheet === "open"
      ? null
      : h("p", { class: "bd-play-note" },
        "Closed Team Sheet, so this one is not on the leaderboard. Your own record still counts it."),
    state.lastRating
      ? h("p", { class: "bd-play-note" },
        `On the ladder: you are ${state.lastRating.player.elo} Elo over ${state.lastRating.player.games} `
        + `game${state.lastRating.player.games === 1 ? "" : "s"}, this team is ${state.lastRating.team.elo}, `
        + `and ${state.lastRating.solverTeam.name} is now ${state.lastRating.solverTeam.elo}.`)
      : playerName()
        ? null
        : h("p", { class: "bd-play-note" },
          "Pick a name on the Leaderboard tab and your games start counting towards a rating."),
    h("div", { class: "bd-play-submit" },
      h("button", { type: "button", class: "primary-button", onclick: () => deal() }, "Play again"),
      h("button", {
        type: "button", class: "ghost-button",
        onclick: () => { state.screen = "setup"; state.view = null; state.gameId = ""; render(); },
      }, "Change team")));
}

/**
 * A Pokemon's name, as the turn should say it.
 *
 * A name on BOTH sides names two Pokemon, so theirs is "the opposing X". The sides are read at
 * the moment of asking rather than from the names the turn started with, because a Mega
 * Evolution renames a Pokemon mid-turn: two Garchomps that both evolve are both
 * "Mega Garchomp Z" from that point on, and a rule settled before the turn would not know it.
 */
function nameFor(view, side, tag) {
  const mon = monByTag(view, side, tag);
  if (!mon) return "";
  const name = mon.name || mon.species;
  const mirrored = (view?.sides?.[1 - side] || [])
    .some((other) => (other.name || other.species) === name);
  return mirrored && side === 1 ? `the opposing ${name}` : name;
}

/**
 * What happened, as a transcript of the turn you watched.
 *
 * Built from the STREAM -- the same ordered list the animation plays, through the same
 * sentence-maker -- rather than from `turnRecord`'s four buckets. The buckets hold every move,
 * then every note, then every number, so a Sleep Powder's sleep was printed three moves after
 * Sleep Powder and every health change came at the end. The panel disagreed with the animation
 * beside it about both the order and the wording.
 *
 * The buckets are still carried on the record and still sent to the ladder as the audit trail;
 * a turn with no stream on it falls back to printing them the old way.
 */
function renderLog(view) {
  const line = (step, index) => {
    // THE SAME NAMES THE ANIMATION USED. This had its own lookup with no mirror rule, so the
    // caption said "the opposing Mega Garchomp Z" while the transcript beside it said
    // "Mega Garchomp Z" for both of them -- and in a mirror match the transcript named neither.
    const text = sentenceFor(step, (side, tag) => nameFor(view, side, tag));
    if (!text) return null;
    const hurt = step.kind === "hit" || step.kind === "faint"
      || (step.kind === "residual" && step.to < step.from);
    return h("span", {
      class: `bd-play-log-line side-${step.side ?? ""}${step.kind === "faint" ? " ko" : hurt ? " hurt" : ""}`,
      key: index,
    }, text);
  };
  return h("div", { class: "bd-play-log-wrap" },
    h("h3", {}, "What happened"),
    h("div", { class: "bd-play-log" }, (view.log || []).map((entry) => {
      const stream = entry.stream?.length ? entry.stream : null;
      return h("div", { class: "bd-play-log-turn" },
        entry.turn ? h("strong", {}, `Turn ${entry.turn}`) : h("strong", {}, "The teams come out"),
        stream
          ? h("div", { class: "bd-play-log-lines" }, stream.map(line).filter(Boolean))
          : h("div", { class: "bd-play-log-lines" },
            (entry.plays || []).map((play) => h("span", { class: `bd-play-log-line side-${play.side}` }, play.text)),
            (entry.notes || []).map((note) => h("span", { class: "bd-play-log-line" }, note)),
            (entry.damage || []).map((hit) => h("span", { class: `bd-play-log-line hurt side-${hit.side}` }, `${hit.name} ${hit.from}% → ${hit.to}%`))));
    })));
}

// --- the leaderboard --------------------------------------------------------------------------------

let boardState = { loading: false, error: "", payload: null, format: "Doubles" };

/** Open the board on the format being played rather than always on Doubles. */
function syncBoardFormat() {
  boardState.format = state.format;
}

async function loadBoard() {
  // Which request this is. Two quick clicks on the format control start two reads, and the one
  // that finishes LAST wins -- which is not necessarily the one that was asked for. Anything
  // but the newest answer is dropped on arrival.
  const seq = (boardState.seq = (boardState.seq || 0) + 1);
  const asked = boardState.format;
  boardState.loading = true;
  boardState.error = "";
  render();
  try {
    const response = await fetch(`/api/play/leaderboard?format=${encodeURIComponent(asked)}`, { cache: "no-store" });
    if (seq !== boardState.seq) return;
    if (response.status === 503) {
      boardState.error = "The ladder is not switched on for this site yet. Your own record is kept in this browser and still counts.";
      boardState.payload = null;
    } else if (!response.ok) {
      boardState.error = `The ladder could not be read (${response.status}).`;
    } else {
      boardState.payload = await response.json();
    }
  } catch {
    if (seq !== boardState.seq) return;
    boardState.error = "The ladder could not be reached.";
  }
  if (seq !== boardState.seq) return;
  boardState.loading = false;
  render();
}

function renderBoard() {
  const record = loadRecord();
  return h("div", { class: "bd-play-board" },
    h("div", { class: "bd-card" },
      h("div", { class: "bd-play-board-head" },
        h("h2", {}, "Leaderboard"),
        segmented([["Doubles", "Doubles"], ["Singles", "Singles"]], boardState.format, (value) => {
          boardState.format = value;
          loadBoard();
        }, { "aria-label": "Leaderboard format" })),
      h("p", { class: "bd-play-note" },
        `You are ${playerName() || "not named yet"}. `,
        h("button", {
          type: "button", class: "bd-linkish",
          onclick: () => askName(),
        }, playerName() ? "Change name" : "Pick a name")),
      h("p", { class: "bd-play-note" },
        `Your record in this browser: ${record.wins}W ${record.losses}L${record.draws ? ` ${record.draws}D` : ""}.`)),
    boardState.loading
      ? h("div", { class: "bd-card" }, h("div", { class: "bd-loading", role: "status" }, h("span", { class: "bd-spinner", "aria-hidden": "true" }), "Reading the ladder…"))
      : boardState.error
        ? h("div", { class: "bd-card" }, h("p", { class: "bd-play-note" }, boardState.error))
        : renderBoardTables(boardState.payload));
}

function renderBoardTables(payload) {
  if (!payload) return h("div", { class: "bd-card" }, h("p", { class: "bd-play-note" }, "Nothing on the ladder yet."));
  const table = (title, rows, nameKey) => h("div", { class: "bd-card bd-play-table" },
    h("h3", {}, title),
    rows?.length
      ? h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Name"), h("th", {}, "Elo"), h("th", {}, "W/L"), h("th", {}, "Games"))),
        h("tbody", {}, rows.map((row, index) => h("tr", {},
          h("td", {}, String(index + 1)),
          h("td", {}, row[nameKey] || "—"),
          h("td", {}, String(Math.round(row.elo))),
          h("td", {}, `${Math.round((row.wins / Math.max(1, row.games)) * 100)}%`),
          h("td", {}, String(row.games))))))
      // "Nobody here yet" is not true once games have been played and nothing has reached the
      // minimum -- it reads as the ladder being broken rather than as a threshold not yet met.
      : h("p", { class: "bd-play-note" },
        payload.games
          ? `${payload.games} game${payload.games === 1 ? "" : "s"} played so far. A team or a player appears here once it has ${payload.minGames}.`
          : "Nobody here yet."));
  return h("div", { class: "bd-play-tables" },
    table("Best players", payload.players, "name"),
    table("Best player teams", payload.playerTeams, "name"),
    table("Best Solver teams", payload.solverTeams, "name"));
}

function askName() {
  const input = h("input", { type: "text", maxlength: "24", value: playerName(), class: "bd-play-name-input", placeholder: "A name for the ladder" });
  const { close } = openDialog({
    title: "Your name on the ladder",
    body: h("div", {}, h("p", {}, "Shown beside your results. No account, no email: it is kept in this browser."), input),
    actions: [
      h("button", { class: "ghost-button", type: "button", onclick: () => close() }, "Not now"),
      h("button", {
        class: "primary-button", type: "button",
        onclick: () => {
          setPlayerName(input.value);
          close();
          render();
        },
      }, "Save"),
    ],
  });
  input.focus();
}

// --- boot ---------------------------------------------------------------------------------------

async function main() {
  try {
    data = await BuilderData.load();
    await data.loadMeta(state.format);
    const saved = savedTeams();
    useTeam(saved.length ? saved[0].id : LADDER);
    // Off unless it was turned on before. The AudioContext is not built until it is wanted, so
    // remembering the choice costs nothing to anybody who left it off.
    try { musicWanted = localStorage.getItem(MUSIC_KEY) === "1"; } catch { musicWanted = false; }
    // Open unless this browser has chosen otherwise before; anything unrecognised reads as open,
    // so a corrupted value cannot quietly put somebody into unrated games.
    try { state.sheet = localStorage.getItem(SHEET_KEY) === "closed" ? "closed" : "open"; } catch { state.sheet = "open"; }
    try {
      const kept = Number(localStorage.getItem(PACE_KEY));
      if (PACES.some(([value]) => value === kept)) state.pace = kept;
    } catch { /* private window */ }
    try { document.documentElement.style.setProperty("--beat-scale", String(state.pace)); } catch { /* no DOM */ }
    render();
  } catch (error) {
    if (root) {
      clear(root).append(h("div", { class: "bd-card bd-error" },
        h("h2", {}, "The Play page could not load its data."),
        h("p", {}, "Reload the page. If it keeps happening, tell us on Discord."),
        h("code", {}, String(error.message || error))));
    }
  }
}

main();
