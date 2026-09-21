// Box and Team sync between this website and the Companion app.
//
// A sync code (CBD-XXXX-XXXX-XXXX-XXXX) names one shared document on the
// server (functions/api/sync).  Both sides keep their own copy and merge:
//   * teams and boxes are matched by `id`; the newer `updated` wins;
//   * a deletion leaves a tombstone, which beats any older copy;
//   * the server holds a revision number, so a write based on a stale copy is
//     refused (409) and the client merges the newer copy before retrying.
// The code is the only credential, so it is long and random, and the server
// stores documents under a hash of it.

import { getState, replaceState, subscribe } from "./store.js";
import { clear, confirmDialog, h, openDialog, toast } from "./ui.js";

const SYNC_KEY = "cbd.sync.v1";
const PUSH_DELAY_MS = 4000;
const PULL_EVERY_MS = 90_000;
const listeners = new Set();
let config = readConfig();
let pushTimer = 0;
let pullTimer = 0;
let busy = false;
let dirty = false;
let lastStatus = { tone: "", text: "" };
let applyingRemote = false;

function readConfig() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_KEY) || "null") || {};
  } catch {
    return {};
  }
}

function writeConfig() {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify(config));
  } catch {
    // storage unavailable
  }
}

function setStatus(tone, text) {
  lastStatus = { tone, text };
  for (const listener of listeners) listener(lastStatus);
}

export function onSyncStatus(listener) {
  listeners.add(listener);
}

export function syncStatus() {
  if (!config.code) return { tone: "", text: "" };
  return lastStatus.text ? lastStatus : { tone: "ok", text: "Synced" };
}

export function normaliseCode(raw) {
  const cleaned = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = cleaned.startsWith("CBD") ? cleaned.slice(3) : cleaned;
  if (!/^[A-Z2-9]{16}$/.test(body)) return "";
  return `CBD-${body.match(/.{4}/g).join("-")}`;
}

// --- document and merge ---------------------------------------------------------

export function documentFromState(state) {
  return {
    format: "cbd-sync/1",
    updatedAt: Date.now(),
    teams: state.teams.filter((team) => !team.pristine),
    boxes: state.boxes.filter((box) => !box.pristine),
    selectedTeamId: state.selectedTeamId,
    currentBoxId: state.currentBoxId,
    tombstones: state.tombstones,
  };
}

function mergeById(localList, remoteList, tombstones) {
  const byId = new Map();
  const order = [];
  for (const item of [...(localList || []), ...(remoteList || [])]) {
    if (!item || !item.id) continue;
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      order.push(item.id);
    } else if ((Number(item.updated) || 0) > (Number(existing.updated) || 0)) {
      byId.set(item.id, item);
    }
  }
  return order.map((id) => byId.get(id)).filter((item) => !(tombstones[item.id] && tombstones[item.id] >= (Number(item.updated) || 0)));
}

function mergeTombstones(a = {}, b = {}) {
  const out = { ...a };
  for (const [id, time] of Object.entries(b || {})) out[id] = Math.max(Number(out[id]) || 0, Number(time) || 0);
  // Tombstones older than 90 days have done their job everywhere.
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  for (const [id, time] of Object.entries(out)) if (time < cutoff) delete out[id];
  return out;
}

/** Same content as the app hashes it (web_sync._clean_team / _clean_box). */
function contentKey(item, kind) {
  if (kind === "team") {
    const spreads = {};
    for (const [k, v] of Object.entries(item.ev_spreads || {})) spreads[String(k)] = v;
    return stableJson({ archetype: String(item.archetype || "Balanced"), ev_spreads: spreads, lead_back_plans: item.lead_back_plans || [], team: item.team || [], title: String(item.title || "Team") });
  }
  return stableJson({ box: item.box || [], name: String(item.name || "Box") });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * Two ids holding identical content are one item: keep the newest and
 * tombstone the other, as the Companion does, so every device drops it.
 */
function dedupe(items, tombstones, kind) {
  const newest = new Map();
  for (const item of items) {
    const k = contentKey(item, kind);
    const kept = newest.get(k);
    if (!kept || (Number(item.updated) || 0) > (Number(kept.updated) || 0)) newest.set(k, item);
  }
  const keep = new Set([...newest.values()].map((item) => item.id));
  for (const item of items) {
    if (!keep.has(item.id)) tombstones[item.id] = Math.max(Number(tombstones[item.id]) || 0, Number(item.updated) || 0, Date.now());
  }
  return items.filter((item) => keep.has(item.id));
}

export function mergeDocuments(local, remote) {
  local = { ...local, teams: (local.teams || []).filter((t) => !t.pristine), boxes: (local.boxes || []).filter((b) => !b.pristine) };
  const tombstones = {
    teams: mergeTombstones(local.tombstones?.teams, remote.tombstones?.teams),
    boxes: mergeTombstones(local.tombstones?.boxes, remote.tombstones?.boxes),
  };
  const teams = dedupe(mergeById(local.teams, remote.teams, tombstones.teams), tombstones.teams, "team");
  const boxes = dedupe(mergeById(local.boxes, remote.boxes, tombstones.boxes), tombstones.boxes, "box");
  return { ...local, teams, boxes, tombstones };
}

function signature(doc) {
  const brief = (list) => (list || []).map((item) => `${item.id}:${item.updated}`).sort().join(",");
  return `${brief(doc.teams)}|${brief(doc.boxes)}|${JSON.stringify(doc.tombstones || {})}`;
}

/** A browser that has never been used: the default empty team and an empty box. */
function isPristine(state) {
  return state.teams.length === 1 && state.teams[0].team.every((entry) => !entry[0]) && state.boxes.length === 1 && !state.boxes[0].box.length;
}

// --- network ----------------------------------------------------------------------

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, payload };
}

function applyRemote(merged) {
  applyingRemote = true;
  try {
    const state = getState();
    // Placeholders never left this browser; keep them only while nothing
    // real has arrived to take their place.
    const teams = merged.teams.length ? merged.teams : state.teams;
    const boxes = merged.boxes.length ? merged.boxes : state.boxes;
    replaceState({ ...state, teams, boxes, tombstones: merged.tombstones }, "sync");
  } finally {
    applyingRemote = false;
  }
}

/** Pull, merge, and push whatever the other side is missing. */
export async function syncNow({ quiet = false } = {}) {
  if (!config.code || busy) {
    if (busy) dirty = true;
    return;
  }
  busy = true;
  dirty = false;
  if (!quiet) setStatus("", "Syncing…");
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const remote = await api("GET", `/api/sync/${encodeURIComponent(config.code)}`);
      if (remote.status === 404) throw new Error("This sync code no longer exists.");
      if (!remote.ok) throw new Error(remote.payload.error || "The sync server did not answer.");
      const local = documentFromState(getState());
      const merged = mergeDocuments(local, remote.payload.document || {});
      if (signature(merged) !== signature(local)) applyRemote(merged);
      if (signature(merged) === signature(remote.payload.document || {})) {
        config.revision = remote.payload.revision;
        break;
      }
      const put = await api("PUT", `/api/sync/${encodeURIComponent(config.code)}`, { baseRevision: remote.payload.revision, document: documentFromState(getState()) });
      if (put.status === 409) continue;
      if (!put.ok) throw new Error(put.payload.error || "The sync server refused the update.");
      config.revision = put.payload.revision;
      break;
    }
    config.lastSync = Date.now();
    config.lastError = "";
    writeConfig();
    setStatus("ok", `Synced ${new Date(config.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  } catch (error) {
    config.lastError = String(error.message || error);
    writeConfig();
    setStatus("err", "Sync failed — will retry");
  } finally {
    busy = false;
    if (dirty) schedulePush();
  }
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow({ quiet: true }), PUSH_DELAY_MS);
}

export function initSync() {
  subscribe((_state, reason) => {
    if (applyingRemote || !config.code) return;
    if (["team", "box", "edit"].includes(reason)) schedulePush();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && config.code && Date.now() - (config.lastSync || 0) > 20_000) syncNow({ quiet: true });
  });
  clearInterval(pullTimer);
  pullTimer = setInterval(() => {
    if (document.visibilityState === "visible" && config.code) syncNow({ quiet: true });
  }, PULL_EVERY_MS);
  if (config.code) syncNow({ quiet: true });
}

async function createCode() {
  const created = await api("POST", "/api/sync", { document: documentFromState(getState()) });
  if (!created.ok) throw new Error(created.payload.error || "Could not create a sync code.");
  config = { code: created.payload.code, revision: created.payload.revision, lastSync: Date.now() };
  writeConfig();
  setStatus("ok", "Synced just now");
  return config.code;
}

async function connect(rawCode) {
  const code = normaliseCode(rawCode);
  if (!code) throw new Error("That does not look like a sync code (CBD-XXXX-XXXX-XXXX-XXXX).");
  const remote = await api("GET", `/api/sync/${encodeURIComponent(code)}`);
  if (remote.status === 404) throw new Error("No synced data exists for that code.");
  if (!remote.ok) throw new Error(remote.payload.error || "The sync server did not answer.");
  const state = getState();
  const doc = remote.payload.document || {};
  if (isPristine(state)) {
    applyRemote({ teams: doc.teams?.length ? doc.teams : state.teams, boxes: doc.boxes?.length ? doc.boxes : state.boxes, tombstones: doc.tombstones || state.tombstones });
  }
  config = { code, revision: remote.payload.revision, lastSync: 0 };
  writeConfig();
  await syncNow();
}

// --- dialog -------------------------------------------------------------------------

export function openSyncDialog() {
  const body = h("div", { class: "bd-list" });
  const render = () => {
    clear(body);
    if (!config.code) {
      const input = h("input", { type: "text", class: "bd-input", placeholder: "CBD-XXXX-XXXX-XXXX-XXXX", autocomplete: "off", spellcheck: "false", "aria-label": "Sync code" });
      const message = h("p", { class: "bd-note", role: "status" });
      body.append(
        h("p", { class: "bd-confirm-text" }, "Keep your Box and your teams identical on this website and in the Companion app. Changes on either side appear on the other."),
        h("h3", { class: "bd-field-label" }, "New here"),
        h("button", { type: "button", class: "primary-button", onclick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            await createCode();
            render();
          } catch (error) {
            message.textContent = error.message;
            event.currentTarget.disabled = false;
          }
        } }, "Create a sync code"),
        h("h3", { class: "bd-field-label" }, "Already have a code?"),
        h("p", { class: "bd-note" }, "Paste the code shown in the Companion (Team Builder → Sync) or on another browser."),
        input,
        h("button", { type: "button", class: "ghost-button", onclick: async (event) => {
          event.currentTarget.disabled = true;
          message.textContent = "Connecting…";
          try {
            await connect(input.value);
            toast("Connected. Your Box and teams are synced.");
            render();
          } catch (error) {
            message.textContent = error.message;
            event.currentTarget.disabled = false;
          }
        } }, "Connect"),
        message);
      return;
    }
    body.append(
      h("p", { class: "bd-confirm-text" }, "This browser is synced. Enter the same code in the Companion to share your Box and teams with it."),
      h("div", { class: "bd-code" }, h("span", {}, config.code), h("button", { type: "button", class: "ghost-button compact", onclick: async () => {
        try {
          await navigator.clipboard.writeText(config.code);
          toast("Sync code copied");
        } catch {
          toast(config.code);
        }
      } }, "Copy")),
      h("ol", { class: "bd-steps" },
        h("li", {}, "Open the Companion and go to the Team Builder."),
        h("li", {}, "Press ", h("strong", {}, "Sync"), " and paste this code."),
        h("li", {}, "From then on both sides stay in step on their own.")),
      h("p", { class: "bd-note" }, config.lastSync ? `Last synced ${new Date(config.lastSync).toLocaleString()}.` : "Not synced yet.", config.lastError ? ` Last problem: ${config.lastError}` : ""),
      h("p", { class: "bd-note" }, "Treat the code like a password: anyone with it can read and change the synced teams."));
  };
  render();
  const actions = [
    h("button", { type: "button", class: "ghost-button bd-danger-text", onclick: async () => {
      if (!config.code) return close();
      if (await confirmDialog("Stop syncing this browser? Your teams stay here; they just stop updating from the code.", { confirmLabel: "Stop syncing" })) {
        config = {};
        writeConfig();
        setStatus("", "");
        render();
      }
    } }, "Stop syncing"),
    h("span", { class: "bd-spacer" }),
    h("button", { type: "button", class: "ghost-button", onclick: () => close() }, "Close"),
    h("button", { type: "button", class: "primary-button", onclick: async () => { await syncNow(); render(); } }, "Sync now"),
  ];
  const { close } = openDialog({ title: "Sync with the Companion", body, actions });
}
