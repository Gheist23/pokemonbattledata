// Persistent Team Builder state: boxes, teams, the selected team, settings.
//
// Kept in the browser (localStorage) in the Companion's own shapes so that the
// sync endpoint can hand the same document to the app:
//   boxes:  [{ id, name, box: [box entries] }]      (pokemon_box.json "boxes")
//   teams:  [{ title, archetype, team: [6 entries], ev_spreads, lead_back_plans }]
// Every box and team also carries an `id` and `updated` time, which is what the
// sync merge keys on; deletions leave a tombstone so they propagate too.

import { EMPTY_ENTRY, TEAM_SIZE, entryToSet, setToEntry, spreadFromSet, uid } from "./common.js";

const KEY = "cbd.builder.v1";
const listeners = new Set();
let state = null;

function now() {
  return Date.now();
}

function freshTeam(title = "New Team") {
  return {
    id: uid("team"),
    title,
    archetype: "Balanced",
    team: Array.from({ length: TEAM_SIZE }, EMPTY_ENTRY),
    ev_spreads: {},
    lead_back_plans: [],
    updated: now(),
  };
}

function freshBox(name = "Box 1") {
  return { id: uid("box"), name, box: [], updated: now() };
}

function defaults() {
  // The starting team and box are placeholders: they are not synced until the
  // visitor puts something in them (sync.js skips `pristine` items).
  const team = { ...freshTeam("My Team"), pristine: true };
  const box = { ...freshBox("Box 1"), pristine: true };
  return {
    version: 1,
    format: "Doubles",
    teams: [team],
    selectedTeamId: team.id,
    boxes: [box],
    currentBoxId: box.id,
    tombstones: { teams: {}, boxes: {} },
    settings: { topMeta: 40, overviewTop: 30 },
    updatedAt: now(),
  };
}

function normalizeTeam(team) {
  const clean = {
    id: team.id || uid("team"),
    title: String(team.title || "Team").slice(0, 80),
    archetype: String(team.archetype || "Balanced"),
    team: Array.from({ length: TEAM_SIZE }, (_, index) => {
      const entry = Array.isArray(team.team) ? team.team[index] : null;
      if (!Array.isArray(entry) || !entry[0]) return EMPTY_ENTRY();
      return [String(entry[0]), String(entry[1] || ""), String(entry[2] || entry[0]), String(entry[3] || ""), Array.isArray(entry[4]) ? entry[4].map(String).slice(0, 4) : []];
    }),
    ev_spreads: team.ev_spreads && typeof team.ev_spreads === "object" ? { ...team.ev_spreads } : {},
    lead_back_plans: Array.isArray(team.lead_back_plans) ? team.lead_back_plans : [],
    updated: Number(team.updated) || now(),
  };
  if (team.pristine) clean.pristine = true;
  return clean;
}

function normalizeBox(box, index) {
  const clean = {
    id: box.id || uid("box"),
    name: String(box.name || `Box ${index + 1}`).slice(0, 60),
    box: Array.isArray(box.box) ? box.box.filter((entry) => entry && entry.pokemon) : [],
    updated: Number(box.updated) || now(),
  };
  if (box.pristine) clean.pristine = true;
  return clean;
}

function touched(item) {
  delete item.pristine;
  item.updated = now();
}

function normalize(raw) {
  const base = defaults();
  if (!raw || typeof raw !== "object") return base;
  const teams = Array.isArray(raw.teams) && raw.teams.length ? raw.teams.map(normalizeTeam) : base.teams;
  const boxes = Array.isArray(raw.boxes) && raw.boxes.length ? raw.boxes.map(normalizeBox) : base.boxes;
  return {
    version: 1,
    format: raw.format === "Singles" ? "Singles" : "Doubles",
    teams,
    selectedTeamId: teams.some((t) => t.id === raw.selectedTeamId) ? raw.selectedTeamId : teams[0].id,
    boxes,
    currentBoxId: boxes.some((b) => b.id === raw.currentBoxId) ? raw.currentBoxId : boxes[0].id,
    tombstones: {
      teams: { ...(raw.tombstones?.teams || {}) },
      boxes: { ...(raw.tombstones?.boxes || {}) },
    },
    settings: { ...base.settings, ...(raw.settings || {}) },
    updatedAt: Number(raw.updatedAt) || now(),
  };
}

function read() {
  try {
    const text = localStorage.getItem(KEY);
    return normalize(text ? JSON.parse(text) : null);
  } catch {
    return defaults();
  }
}

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private mode or a full quota: the page keeps working for this visit.
  }
}

export function getState() {
  if (!state) state = read();
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(reason) {
  for (const listener of [...listeners]) {
    try {
      listener(state, reason);
    } catch (error) {
      console.error(error);
    }
  }
}

/** Apply a change, persist it, and tell every listener (including sync). */
export function update(mutator, reason = "edit", { touch = true } = {}) {
  getState();
  mutator(state);
  if (touch) state.updatedAt = now();
  write();
  emit(reason);
  return state;
}

/** Replace the whole document (used by sync after a merge). */
export function replaceState(next, reason = "sync") {
  state = normalize(next);
  write();
  emit(reason);
}

// --- teams -------------------------------------------------------------------

export function currentTeam() {
  const s = getState();
  return s.teams.find((team) => team.id === s.selectedTeamId) || s.teams[0];
}

export function teamSets(team, data) {
  return (team?.team || []).map((entry, index) => entryToSet(entry, team.ev_spreads?.[index] ?? team.ev_spreads?.[String(index)], data));
}

export function setSlot(index, set, data) {
  update((s) => {
    const team = s.teams.find((t) => t.id === s.selectedTeamId);
    if (!team) return;
    team.team[index] = setToEntry(set);
    if (set && set.species) team.ev_spreads[String(index)] = spreadFromSet(set, data?.app);
    else delete team.ev_spreads[String(index)];
    touched(team);
  }, "team");
}

export function setTeamSets(sets, data, { title, archetype } = {}) {
  update((s) => {
    const team = s.teams.find((t) => t.id === s.selectedTeamId);
    if (!team) return;
    team.team = Array.from({ length: TEAM_SIZE }, (_, index) => setToEntry(sets[index]));
    team.ev_spreads = {};
    sets.forEach((set, index) => {
      if (set && set.species) team.ev_spreads[String(index)] = spreadFromSet(set, data?.app);
    });
    if (title) team.title = title;
    if (archetype) team.archetype = archetype;
    touched(team);
  }, "team");
}

export function swapSlots(a, b) {
  update((s) => {
    const team = s.teams.find((t) => t.id === s.selectedTeamId);
    if (!team || a === b) return;
    [team.team[a], team.team[b]] = [team.team[b], team.team[a]];
    const sa = team.ev_spreads[String(a)];
    const sb = team.ev_spreads[String(b)];
    if (sb) team.ev_spreads[String(a)] = sb; else delete team.ev_spreads[String(a)];
    if (sa) team.ev_spreads[String(b)] = sa; else delete team.ev_spreads[String(b)];
    touched(team);
  }, "team");
}

export function selectTeam(id) {
  update((s) => {
    if (s.teams.some((t) => t.id === id)) s.selectedTeamId = id;
  }, "select", { touch: false });
}

export function newTeam(sets = null, data = null, title = "") {
  let created = null;
  update((s) => {
    const used = new Set(s.teams.map((t) => t.title));
    let name = title || `Team ${s.teams.length + 1}`;
    for (let n = s.teams.length + 1; used.has(name); n += 1) name = `Team ${n}`;
    created = freshTeam(name);
    if (sets) {
      created.team = Array.from({ length: TEAM_SIZE }, (_, index) => setToEntry(sets[index]));
      sets.forEach((set, index) => {
        if (set && set.species) created.ev_spreads[String(index)] = spreadFromSet(set, data?.app);
      });
    }
    s.teams.push(created);
    s.selectedTeamId = created.id;
  }, "team");
  return created;
}

export function duplicateTeam(id) {
  update((s) => {
    const source = s.teams.find((t) => t.id === id);
    if (!source) return;
    const copy = normalizeTeam(JSON.parse(JSON.stringify(source)));
    copy.id = uid("team");
    copy.title = `${source.title} (copy)`;
    copy.updated = now();
    s.teams.splice(s.teams.indexOf(source) + 1, 0, copy);
    s.selectedTeamId = copy.id;
  }, "team");
}

export function deleteTeam(id) {
  update((s) => {
    const index = s.teams.findIndex((t) => t.id === id);
    if (index < 0) return;
    s.teams.splice(index, 1);
    s.tombstones.teams[id] = now();
    if (!s.teams.length) s.teams.push(freshTeam("My Team"));
    if (!s.teams.some((t) => t.id === s.selectedTeamId)) s.selectedTeamId = s.teams[Math.max(0, index - 1)].id;
  }, "team");
}

export function renameTeam(id, title, archetype) {
  update((s) => {
    const team = s.teams.find((t) => t.id === id);
    if (!team) return;
    if (title !== undefined) team.title = String(title).slice(0, 80) || team.title;
    if (archetype !== undefined) team.archetype = archetype;
    touched(team);
  }, "team");
}

export function setFormat(format) {
  update((s) => {
    s.format = format === "Singles" ? "Singles" : "Doubles";
  }, "format", { touch: false });
}

// --- boxes -------------------------------------------------------------------

export function currentBox() {
  const s = getState();
  return s.boxes.find((box) => box.id === s.currentBoxId) || s.boxes[0];
}

export function selectBox(id) {
  update((s) => {
    if (s.boxes.some((b) => b.id === id)) s.currentBoxId = id;
  }, "box", { touch: false });
}

export function addBox(name) {
  let created = null;
  update((s) => {
    created = freshBox(name || `Box ${s.boxes.length + 1}`);
    s.boxes.push(created);
    s.currentBoxId = created.id;
  }, "box");
  return created;
}

export function renameBox(id, name) {
  update((s) => {
    const box = s.boxes.find((b) => b.id === id);
    if (box && name) {
      box.name = String(name).slice(0, 60);
      touched(box);
    }
  }, "box");
}

export function deleteBox(id) {
  update((s) => {
    const index = s.boxes.findIndex((b) => b.id === id);
    if (index < 0) return;
    s.boxes.splice(index, 1);
    s.tombstones.boxes[id] = now();
    if (!s.boxes.length) s.boxes.push(freshBox("Box 1"));
    if (!s.boxes.some((b) => b.id === s.currentBoxId)) s.currentBoxId = s.boxes[0].id;
  }, "box");
}

export function addToBox(entries, boxId = null) {
  update((s) => {
    const box = s.boxes.find((b) => b.id === (boxId || s.currentBoxId)) || s.boxes[0];
    for (const entry of entries) box.box.push(entry);
    touched(box);
  }, "box");
}

export function replaceBoxEntry(index, entry, boxId = null) {
  update((s) => {
    const box = s.boxes.find((b) => b.id === (boxId || s.currentBoxId)) || s.boxes[0];
    if (index >= 0 && index < box.box.length) {
      box.box[index] = entry;
      touched(box);
    }
  }, "box");
}

export function removeFromBox(index, boxId = null) {
  update((s) => {
    const box = s.boxes.find((b) => b.id === (boxId || s.currentBoxId)) || s.boxes[0];
    if (index >= 0 && index < box.box.length) {
      box.box.splice(index, 1);
      touched(box);
    }
  }, "box");
}

export function allBoxEntries() {
  return getState().boxes.flatMap((box) => box.box.map((entry, index) => ({ entry, index, boxId: box.id, boxName: box.name })));
}

export function setSetting(key, value) {
  update((s) => {
    s.settings[key] = value;
  }, "settings", { touch: false });
}

// Keep tabs in step: a change in the Damage Calculator tab (or another
// Team Builder tab) reloads here.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    state = read();
    emit("external");
  });
}
