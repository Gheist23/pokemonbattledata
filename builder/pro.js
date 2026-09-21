// Pro status and the free-run allowance for Team Evaluation and Auto Build.
//
// Everything else on the builder pages is free.  These two features give a
// visitor a few complete runs; after that they ask for Pro.  The allowance is
// deliberately never shown while it is being used -- the first sign of it is
// the Pro prompt.
//
// Pro on the website is the same licence as the Companion: the key from the
// purchase email is exchanged at /api/license/activate for a signed token whose
// expiry covers the paid period plus grace, exactly like the app.

const RUNS_KEY = "cbd.runs.v1";
const LICENCE_KEY = "cbd.licence.v1";
const COOKIE = "cbd_r";
const FREE_RUNS = 3;
const REFRESH_AFTER_MS = 3 * 24 * 3600 * 1000;

function readJson(storageKey, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "null");
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storageKey, value) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // storage unavailable
  }
}

function cookieRuns() {
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`));
  if (!match) return {};
  try {
    return JSON.parse(atob(decodeURIComponent(match[1])));
  } catch {
    return {};
  }
}

function writeCookieRuns(runs) {
  const value = encodeURIComponent(btoa(JSON.stringify(runs)));
  document.cookie = `${COOKIE}=${value}; path=/; max-age=${60 * 60 * 24 * 400}; SameSite=Lax`;
}

function runs() {
  const local = readJson(RUNS_KEY, {});
  const cookie = cookieRuns();
  const merged = {};
  for (const feature of new Set([...Object.keys(local), ...Object.keys(cookie)])) {
    merged[feature] = Math.max(Number(local[feature]) || 0, Number(cookie[feature]) || 0);
  }
  return merged;
}

function decodeToken(token) {
  try {
    const [body] = String(token || "").split(".");
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function licence() {
  return readJson(LICENCE_KEY, null);
}

export function isPro() {
  const stored = licence();
  if (!stored?.token) return false;
  const payload = decodeToken(stored.token);
  return Boolean(payload && payload.edition === "pro" && Number(payload.exp) * 1000 > Date.now());
}

/** May this feature run now?  Pro always; otherwise while free runs remain. */
export function canRun(feature) {
  if (isPro()) return true;
  return (runs()[feature] || 0) < FREE_RUNS;
}

/** Free runs left for a feature (Infinity with Pro). */
export function freeRunsLeft(feature) {
  if (isPro()) return Infinity;
  return Math.max(0, FREE_RUNS - (runs()[feature] || 0));
}

/** Count one completed free run (Pro runs are not counted). */
export function recordRun(feature) {
  if (isPro()) return;
  const current = runs();
  current[feature] = (current[feature] || 0) + 1;
  writeJson(RUNS_KEY, current);
  writeCookieRuns(current);
}

export async function activate(rawKey) {
  const response = await fetch("/api/license/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: rawKey }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) throw new Error(body.error || "That key could not be activated.");
  const payload = decodeToken(body.token);
  writeJson(LICENCE_KEY, { key: payload?.key || rawKey, token: body.token, plan: body.plan, checkedAt: Date.now() });
  return body;
}

export function deactivate() {
  try {
    localStorage.removeItem(LICENCE_KEY);
  } catch {
    // ignore
  }
}

/** Quietly renew the token every few days so a live subscription never lapses here. */
export async function refreshLicence() {
  const stored = licence();
  if (!stored?.key) return;
  if (Date.now() - (stored.checkedAt || 0) < REFRESH_AFTER_MS && isPro()) return;
  try {
    await activate(stored.key);
  } catch {
    writeJson(LICENCE_KEY, { ...stored, checkedAt: Date.now() });
  }
}

export function licenceSummary() {
  const stored = licence();
  const payload = decodeToken(stored?.token);
  if (!payload) return null;
  return { key: stored.key, plan: payload.plan || stored.plan || "pro", expires: new Date(Number(payload.exp) * 1000) };
}
