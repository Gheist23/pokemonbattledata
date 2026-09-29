/* What happens when someone presses Share on this site.
 *
 * builder/share-card.js draws the card and functions/api/share/* stores it.
 * This file is the piece between them: it turns what is on screen into the
 * DIGEST those two agree on, hands it to the renderer with a browser host,
 * posts the result, and puts the link on the clipboard.
 *
 * THE DIGEST IS AN ALLOWLIST, and the SERVER is the authority on it:
 * cleanTeamDigest / cleanEvalDigest (functions/api/share/_lib.js:375, :391)
 * drop anything they are not expecting and refuse anything outside the shape.
 * The limits and the two cleaners below are a second copy of that shape on
 * purpose -- the same arrangement the Companion's share_link_v518.py uses --
 * so a bad value is refused here, before it leaves the browser, instead of
 * arriving as a 400.  tests/run-share-buttons.mjs imports the REAL cleaners
 * and fails if the two copies ever disagree, which is what keeps this honest.
 *
 * Nothing here carries a path, a URL, an id, a licence or an e-mail: the card's
 * sprites are resolved by the host from the species and form names through the
 * local index, so a share record has nothing fetchable in it.
 *
 * The per-Pokemon `stats` come from slotStats(), which is the SAME call the
 * Team Builder's own slot card makes -- builder-page.js calls this function for
 * the numbers it draws -- so the card and the tab can never disagree.
 */

import { MAX_CARD_BYTES, renderCardBlob } from "./share-card.js";
import { h, openDialog, toast } from "./ui.js";

export const SHARE_ENDPOINT = "/api/share";

/** functions/api/share/_lib.js STAT_KEYS / STAT_CODES / SEVERITIES / FORMATS. */
const STAT_KEYS = ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"];
const STAT_CODES = new Set(["HP", "ATK", "DEF", "SPA", "SPD", "SPE"]);
const SEVERITIES = new Set(["good", "yellow", "red"]);
const FORMATS = new Set(["Doubles", "Singles"]);

/** functions/api/share/_lib.js LIMITS, field for field. */
const LIMITS = {
  title: 80,
  format: 10,
  archetype: 48,
  name: 48,
  item: 48,
  ability: 32,
  nature: 16,
  move: 40,
  label: 90,
  team: 6,
  moves: 4,
  bonuses: 6,
  checks: 16,
  threats: 6,
};

/** How long to wait for the page's own fonts before drawing.  The card measures
 *  its text, so drawing before a web font arrives would size every field to the
 *  fallback; waiting forever would leave the button stuck, so it is a race. */
const FONT_WAIT_MS = 1500;

// --- the words a person reads -------------------------------------------------
//
// Every one of them.  No status codes, no field names, no version numbers, and
// never an exception: a failure has to say what happened and what to do next.

export const MESSAGES = Object.freeze({
  empty: "There is nothing to share yet. Add at least one Pokémon to the team first.",
  noResult: "There is no evaluation to share yet. Run Team Evaluation and let it finish, then press Share.",
  stale: "The team or the settings changed since this evaluation ran. Press “Evaluate changes” first, then share.",
  working: "Drawing the picture and making the link…",
  copied: "Share link copied to the clipboard.",
  ready: "Your share link is ready. Copy it from the box on screen.",
  offline: "You are offline, so no link could be made. Check your connection and try again.",
  network: "The site could not be reached, so no link could be made. Check your connection and try again.",
  notConfigured: "Sharing is switched off on the site at the moment. Please try again later.",
  refused: "The site would not accept this team, so no link was made. Please try again.",
  tooBig: "This picture came out too large to send. Try sharing a team with fewer Pokémon.",
  limit: "Sharing has reached today's limit on the site. Please try again tomorrow.",
  notAllowed: "Share links can only be made from the Team Builder on this site.",
  serverError: "The site could not make a share link just now. Please try again in a moment.",
  drawFailed: "The picture could not be drawn, so nothing was sent.",
  unknown: "Sharing did not work, so no link was made. Please try again.",
});

/** A failure a person can act on.  Its message is shown as it is written. */
export class ShareError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShareError";
    /** The tag the UI reads, so a message survives crossing a module boundary. */
    this.userMessage = message;
  }
}

/** The sentence to show for anything that came back from the flow.  An error
 *  this file did not raise never reaches the screen. */
export function shareMessage(error) {
  const tagged = error && typeof error.userMessage === "string" ? error.userMessage : "";
  return tagged || MESSAGES.unknown;
}

// --- the same cleaning the server does ---------------------------------------

function text(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function int(value, lo, hi, fallback = 0) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(lo, Math.min(hi, number));
}

function statCode(value) {
  const code = String(value ?? "").toUpperCase().trim();
  return STAT_CODES.has(code) ? code : "";
}

function cleanFormat(value) {
  const name = text(value, LIMITS.format);
  return FORMATS.has(name) ? name : "Doubles";
}

function severityOf(row) {
  const value = String(row?.severity ?? "good").toLowerCase();
  return SEVERITIES.has(value) ? value : "good";
}

/** A check row's heading, as the Team Building Checks list shows it. */
function checkLabel(row) {
  return text(row?.check_label || row?.label || row?.summary_v203 || row?.check_id, LIMITS.label);
}

// --- the digest ---------------------------------------------------------------

/**
 * The stats the Team Builder shows for a slot.
 *
 * This is the one call: builder-page.js's slot card reads its six numbers from
 * here and so does the share digest, which is what makes the card agree with
 * the tab.  The engine applies the Mega itself when the stone matches, so the
 * set's own species and form go in unchanged.
 */
export function slotStats(data, set) {
  return data.engine.finalStats({
    pokemon_name: set.species,
    form_name: set.form,
    item: set.item,
    nature_name: set.nature,
    bonuses: set.bonuses,
  });
}

/** One team slot, or null for an empty one. */
export function entryDigest(data, set) {
  const species = text(set?.species, LIMITS.name);
  if (!species) return null;
  const [, battleForm, battleAbility] = data.battleForm(set.species, set.form, set.item);
  // The slot card shows the Mega's own Ability when the stone applies, and the
  // set's otherwise (builder-page.js's bd-slot-ability).
  const ability = battleAbility && battleForm !== set.form ? battleAbility : set.ability || "";
  const stats = slotStats(data, set);
  const [up, down] = data.natures[set.nature] || ["", ""];
  const numbers = {};
  for (const key of STAT_KEYS) numbers[key] = int(stats?.[key], 0, 999);
  const bonuses = [];
  for (let i = 0; i < LIMITS.bonuses; i += 1) {
    bonuses.push(int(Array.isArray(set.bonuses) ? set.bonuses[i] : 0, 0, 32));
  }
  return {
    name: text(data.setName(set), LIMITS.name) || species,
    species,
    form: text(battleForm || set.form, LIMITS.name) || species,
    item: text(set.item, LIMITS.item),
    ability: text(ability, LIMITS.ability),
    nature: text(set.nature, LIMITS.nature),
    natureUp: statCode(up),
    natureDown: statCode(down),
    moves: (Array.isArray(set.moves) ? set.moves : []).slice(0, LIMITS.moves).map((move) => text(move, LIMITS.move)),
    bonuses,
    stats: numbers,
  };
}

function teamRows(data, sets) {
  return (Array.isArray(sets) ? sets : [])
    .slice(0, LIMITS.team)
    .map((set) => entryDigest(data, set))
    .filter(Boolean);
}

/**
 * The Team card's digest.
 * @throws ShareError when there is no Pokemon to draw.
 */
export function teamDigest(data, { sets, title = "", archetype = "", format = "Doubles" } = {}) {
  const team = teamRows(data, sets);
  if (!team.length) throw new ShareError(MESSAGES.empty);
  const digest = {
    v: 1,
    kind: "team",
    title: text(title, LIMITS.title) || "Pokemon Champions Team",
    format: cleanFormat(format),
    team,
  };
  const detected = text(archetype, LIMITS.archetype);
  if (detected) digest.archetype = detected;
  return digest;
}

/**
 * The Team Evaluation card's digest, taken from the result on screen.
 *
 * A digest, not the payload: one evaluation payload is megabytes and everything
 * the card shows is read out here, at the moment Share is pressed.
 *
 * @throws ShareError when there is no finished result, or no Pokemon to draw.
 */
export function evaluationDigest(data, { result, sets, title = "", archetype = "", format = "Doubles" } = {}) {
  if (!result || typeof result !== "object") throw new ShareError(MESSAGES.noResult);
  const team = teamRows(data, sets);
  if (!team.length) throw new ShareError(MESSAGES.empty);

  const rows = Array.isArray(result.checks?.rows) ? result.checks.rows : [];
  const checkCounts = { good: 0, yellow: 0, red: 0 };
  for (const row of rows) checkCounts[severityOf(row)] += 1;
  // Red first, then the ones to watch: a card shows sixteen rows at most, so the
  // ones that need attention must not be the ones that fall off the end.
  const order = { red: 0, yellow: 1, good: 2 };
  const checks = [...rows]
    .sort((a, b) => order[severityOf(a)] - order[severityOf(b)])
    .map((row) => ({ label: checkLabel(row), severity: severityOf(row) }))
    .filter((row) => row.label)
    .slice(0, LIMITS.checks);

  // The most dangerous first, which is the order the Threats tab leads with
  // (share-card.js threatTone's bands rise with the score).
  const threats = [...(Array.isArray(result.threats) ? result.threats : [])]
    .sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0))
    .map((row) => ({
      name: text(row?.name, LIMITS.name),
      species: text(row?.base_name || row?.species || row?.name, LIMITS.name),
      form: text(row?.form || row?.species || row?.name, LIMITS.name),
      item: text(row?.threat_item || row?.item, LIMITS.item),
      score: int(row?.score, 0, 100),
    }))
    .filter((row) => row.name)
    .slice(0, LIMITS.threats);

  const speed = result.speed && typeof result.speed === "object" ? result.speed : {};
  const settings = result.settings && typeof result.settings === "object" ? result.settings : {};
  return {
    v: 1,
    kind: "eval",
    title: text(title, LIMITS.title) || "Team Evaluation",
    format: cleanFormat(format),
    archetype: text(result.archetype?.archetype || archetype, LIMITS.archetype),
    scores: {
      synergy: int(result.synergy_score, 0, 100),
      offense: int(result.offense_score, 0, 100),
      defense: int(result.defense_score, 0, 100),
      speed: int(speed.score, 0, 100),
    },
    topMeta: int(settings.top_meta, 0, 1000),
    threatCount: int(result.all_top_meta_threat_rows_v462 ?? (result.threats || []).length, 0, 100000),
    team,
    checks,
    checkCounts,
    threats,
  };
}

// --- drawing it in a browser --------------------------------------------------

/**
 * The renderer's platform half.  Sprites are same-origin site assets, so the
 * canvas stays untainted and toBlob works; a sprite that will not load resolves
 * to null and the card draws without it rather than failing.
 */
export function cardHost(data) {
  return {
    createCanvas(width, height) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    loadImage(request) {
      const src = request.slot === "items"
        ? data.itemIcon(request.item)
        : data.sprite(request.species, request.form, request.item, { full: true });
      if (!src) return null;
      return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = src;
      });
    },
    fonts: fontsReady(),
  };
}

function fontsReady() {
  const ready = typeof document !== "undefined" && document.fonts ? document.fonts.ready : null;
  if (!ready) return null;
  return Promise.race([ready, new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))]).catch(() => null);
}

// --- sending it --------------------------------------------------------------

function messageForStatus(status) {
  if (status === 400) return MESSAGES.refused;
  if (status === 403) return MESSAGES.notAllowed;
  if (status === 413) return MESSAGES.tooBig;
  if (status === 429) return MESSAGES.limit;
  if (status === 503) return MESSAGES.notConfigured;
  return MESSAGES.serverError;
}

/**
 * POST the digest and the card bytes together, as the endpoint expects: one
 * multipart body, `record` and `image`, and the server picks the code.
 *
 * @returns the endpoint's answer, which carries pageUrl.
 * @throws ShareError, always with one of MESSAGES.
 */
export async function uploadShare(digest, blob, { fetch: given, endpoint = SHARE_ENDPOINT } = {}) {
  const send = given || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!send) throw new ShareError(MESSAGES.network);
  if (!blob || !blob.size) throw new ShareError(MESSAGES.drawFailed);
  if (blob.size > MAX_CARD_BYTES) throw new ShareError(MESSAGES.tooBig);
  // A browser that already knows it is offline should say so rather than spend
  // a request on it; a stale `true` still falls through to the catch below.
  if (typeof navigator === "object" && navigator && navigator.onLine === false) {
    throw new ShareError(MESSAGES.offline);
  }
  const body = new FormData();
  body.append("record", JSON.stringify(digest));
  body.append("image", blob, "card.png");
  let response;
  try {
    response = await send(endpoint, { method: "POST", body });
  } catch {
    throw new ShareError(MESSAGES.network);
  }
  let answer = null;
  try {
    answer = await response.json();
  } catch {
    answer = null;
  }
  if (response.ok && answer && answer.pageUrl) return answer;
  throw new ShareError(messageForStatus(Number(response.status)));
}

/** Draw the card, then send it.  Every failure is a ShareError. */
export async function createShare(digest, host, options = {}) {
  let blob;
  try {
    ({ blob } = await renderCardBlob(digest, host));
  } catch {
    throw new ShareError(MESSAGES.drawFailed);
  }
  return uploadShare(digest, blob, options);
}

// --- the clipboard -----------------------------------------------------------

/**
 * The Import / Export Copy button's pattern: ask the browser to copy, and when
 * it refuses, put the text on screen already selected so it can be copied by
 * hand.
 *
 * @returns true when the clipboard took it.
 */
export async function copyShareLink(url, { dialog = openDialog } = {}) {
  const link = String(url || "");
  if (!link) return false;
  try {
    await navigator.clipboard.writeText(link);
    return true;
  } catch {
    showLink(link, dialog);
    return false;
  }
}

function showLink(url, dialog) {
  const field = h("input", { type: "text", class: "bd-input", readonly: true, value: url, "aria-label": "Share link" });
  const { close } = dialog({
    title: "Your share link",
    body: h("div", { class: "bd-list" },
      h("p", { class: "bd-confirm-text" }, "This browser would not let the page copy for you. The link below is selected, so you can copy it yourself."),
      field),
    actions: [h("button", { type: "button", class: "primary-button", onclick: () => close() }, "Done")],
  });
  field.select();
}

// --- the control -------------------------------------------------------------

/**
 * A Share button.
 *
 * `build()` is called when it is pressed, on the spot, so the card is made of
 * what is on screen at that moment; it throws a ShareError when there is
 * nothing to share.  While the work runs the button is disabled and says so, so
 * nobody can post the same card twice by pressing twice.
 */
export function shareButton({
  label = "Share team",
  title = "",
  className = "ghost-button compact",
  busyLabel = "Sharing…",
  build,
  host,
  share = createShare,
  copy = copyShareLink,
  notify = toast,
} = {}) {
  const button = h("button", { type: "button", class: className, title, onclick: () => press() }, label);
  let busy = false;
  async function press() {
    if (busy) return;
    let digest;
    try {
      digest = build();
    } catch (error) {
      notify(shareMessage(error), "error");
      return;
    }
    busy = true;
    button.disabled = true;
    button.textContent = busyLabel;
    notify(MESSAGES.working);
    try {
      const result = await share(digest, typeof host === "function" ? host() : host);
      const link = String(result?.pageUrl || "");
      if (!link) throw new ShareError(MESSAGES.serverError);
      notify(await copy(link) ? MESSAGES.copied : MESSAGES.ready);
    } catch (error) {
      notify(shareMessage(error), "error");
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = label;
    }
  }
  return button;
}
