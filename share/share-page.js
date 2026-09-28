/* The public share page.
 *
 * Two ways in, one renderer:
 *   * the Function at functions/api/share/[code].js serves this same HTML with
 *     the record already inlined as <script id="shareData">, so a click costs no
 *     extra request;
 *   * /share/?c=<code> (or /share/#<code>) fetches the record itself, which is
 *     what keeps this page useful on its own.
 *
 * The card itself is the stored PNG -- the very bytes a crawler unfurls -- so
 * what a visitor sees and what Discord shows can never disagree.  The numbers
 * below it come from the record and are drawn with the SAME colour and width
 * rules as the card (imported from builder/share-card.js), not a second copy of
 * them.  Nothing here needs data/builder/app-data.json, which is why the page
 * loads in one request and works while the Team Builder's 863 KB table does not.
 */

// Relative, not "/builder/share-card.js": this module's own URL is always
// /share/share-page.js (the page is served at /share/ and at /api/share/<code>,
// and both load it from that absolute path), so "../builder/..." resolves to
// /builder/... in the browser AND imports in node, which is what lets the guard
// suite pin the paste format against builder/common.js.
import {
  MAX_BONUS_STAT_POINTS, PALETTE, STAT_KEYS, STAT_LABELS, bonusTotal, natureLabel, scoreColor,
  statBarWidth, statColor, threatColor,
} from "../builder/share-card.js";

const RECORD_SUFFIX = "?format=json";
/** functions/api/share/_lib.js TTL_DAYS, so the page and the store agree. */
const TTL_DAYS = 180;

// Nothing at module scope may touch the DOM: tests/run-share-endpoints.mjs
// imports this file in node to pin the paste builder and the code reader.
const hasDom = typeof document !== "undefined";
const view = hasDom ? document.getElementById("shareView") : null;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function normaliseCode(raw) {
  const cleaned = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = cleaned.startsWith("CBS") ? cleaned.slice(3) : cleaned;
  if (!/^[A-HJ-NP-Z2-9]{16}$/.test(body)) return "";
  return `CBS-${body.match(/.{4}/g).join("-")}`;
}

/** ?c=<code>, then the last path segment (so a /share/<code> route would work
 *  the moment one is mounted), then the hash. */
function codeFromLocation() {
  const params = new URLSearchParams(location.search);
  const fromQuery = normaliseCode(params.get("c") || params.get("code") || "");
  if (fromQuery) return fromQuery;
  const segment = location.pathname.split("/").filter(Boolean).pop() || "";
  const fromPath = normaliseCode(decodeURIComponent(segment));
  if (fromPath) return fromPath;
  return normaliseCode(location.hash.replace(/^#/, ""));
}

function inlineData() {
  const node = document.getElementById("shareData");
  if (!node) return null;
  try {
    return JSON.parse(node.textContent || "null");
  } catch {
    return null;
  }
}

function toast(message) {
  let bar = document.getElementById("shareToast");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "shareToast";
    bar.setAttribute("role", "status");
    bar.style.cssText = "position:fixed;left:50%;bottom:1.4rem;transform:translateX(-50%);z-index:60;padding:0.55rem 0.95rem;border:1px solid rgba(114,255,171,0.36);border-radius:12px;background:rgba(5,13,8,0.94);color:#f7f9fc;box-shadow:0 16px 40px rgba(0,0,0,0.35);font-size:0.92rem";
    document.body.appendChild(bar);
  }
  bar.textContent = message;
  bar.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { bar.hidden = true; }, 2600);
}

async function copy(text, said) {
  try {
    await navigator.clipboard.writeText(text);
    toast(said);
  } catch {
    toast("Copying was blocked; select the text and copy it yourself.");
  }
}

// --- the Showdown paste --------------------------------------------------------
// The same shape builder/common.js:497 setToShowdown writes, so the Team
// Builder's own Import (and the Companion's) reads it back: Stat Points travel
// on the EVs line, which is what builder/common.js:517 parseShowdown expects.

function showdownFor(entry) {
  const name = entry.name || entry.species;
  const lines = [`${name}${entry.item ? ` @ ${entry.item}` : ""}`];
  if (entry.ability) lines.push(`Ability: ${entry.ability}`);
  lines.push("Level: 50");
  const points = (entry.bonuses || []).map((value, index) => (value ? `${value} ${STAT_LABELS[index]}` : "")).filter(Boolean);
  if (points.length) lines.push(`EVs: ${points.join(" / ")}`);
  lines.push(`${entry.nature || "Serious"} Nature`);
  for (const move of (entry.moves || []).filter(Boolean)) lines.push(`- ${move}`);
  return lines.join("\n");
}

function showdownTeam(digest) {
  return (digest.team || []).map(showdownFor).filter(Boolean).join("\n\n");
}

// --- pieces --------------------------------------------------------------------

function statRows(entry) {
  return STAT_KEYS.map((key, index) => {
    const value = Number(entry.stats?.[key] || 0);
    const points = Number(entry.bonuses?.[index] || 0);
    const up = entry.natureUp && STAT_LABELS[index].toUpperCase() === entry.natureUp.toUpperCase();
    const down = entry.natureDown && STAT_LABELS[index].toUpperCase() === entry.natureDown.toUpperCase();
    const tint = up ? PALETTE.natureUp : down ? PALETTE.natureDown : "";
    return `<div class="share-stat">
      <span class="share-stat-name"${tint ? ` style="color:${tint}"` : ""}>${esc(STAT_LABELS[index])}</span>
      <span class="share-track"><span class="share-fill" style="width:${statBarWidth(key, value, 100)}%;background:${statColor(value)}"></span></span>
      <span class="share-stat-value">${points ? `<span class="share-points">+${points}</span> ` : ""}${esc(String(value))}</span>
    </div>`;
  }).join("");
}

function slotCard(entry) {
  const nature = natureLabel(entry);
  const total = bonusTotal(entry);
  const moves = (entry.moves || []).filter(Boolean);
  return `<article class="share-slot">
    <h3>${esc(entry.name || entry.species)}</h3>
    <p class="share-meta">${entry.item ? `${esc(entry.item)} · ` : ""}${esc(entry.ability || "No ability")}</p>
    ${nature ? `<p class="share-meta share-nature">${esc(nature)}${total ? ` · ${total}/${MAX_BONUS_STAT_POINTS} Stat Points` : ""}</p>` : ""}
    ${moves.length ? `<ul class="share-moves">${moves.map((move) => `<li>${esc(move)}</li>`).join("")}</ul>` : ""}
    <div class="share-stats">${statRows(entry)}</div>
  </article>`;
}

const SEVERITY_WORD = { good: "Good", yellow: "Watch", red: "Problem" };
const SEVERITY_COLOR = { good: PALETTE.good, yellow: PALETTE.mid, red: PALETTE.bad };

function evalPanels(digest) {
  const scores = digest.scores || {};
  const tiles = [["Synergy", "synergy"], ["Offense", "offense"], ["Defense", "defense"], ["Speed", "speed"]]
    .map(([label, key]) => {
      const value = Number(scores[key] || 0);
      return `<div class="share-tile"><span>${label}</span><strong style="color:${scoreColor(value)}">${esc(String(value))}</strong></div>`;
    }).join("");
  const checks = (digest.checks || []).map((row) => {
    const key = SEVERITY_COLOR[row.severity] ? row.severity : "good";
    return `<li><span class="share-dot" style="background:${SEVERITY_COLOR[key]}"></span><span>${esc(row.label)}</span><span class="share-score" style="color:${SEVERITY_COLOR[key]}">${SEVERITY_WORD[key]}</span></li>`;
  }).join("");
  const counts = digest.checkCounts || {};
  const shown = (digest.threats || []).length;
  const threats = (digest.threats || []).map((row) => {
    const score = Number(row.score || 0);
    return `<li><span>${esc(row.name)}</span><span class="share-score" style="color:${threatColor(score)}">${esc(String(score))}</span></li>`;
  }).join("");
  return `
    <section class="share-panel">
      <h2>Scores</h2>
      <div class="share-tiles">${tiles}</div>
      ${digest.archetype ? `<p class="share-note">Detected archetype: <strong>${esc(digest.archetype)}</strong></p>` : ""}
    </section>
    ${checks ? `<section class="share-panel">
      <h2>Team Building Checks</h2>
      <p class="share-note" style="margin-top:0">${Number(counts.good || 0)} good · ${Number(counts.yellow || 0)} watch · ${Number(counts.red || 0)} problem</p>
      <ul class="share-rows">${checks}</ul>
    </section>` : ""}
    ${threats ? `<section class="share-panel">
      <h2>Critical threats</h2>
      ${shown && digest.threatCount && Number(digest.threatCount) > shown ? `<p class="share-note" style="margin-top:0">Showing the ${shown} worst of ${Number(digest.threatCount)}</p>` : ""}
      <ul class="share-rows">${threats}</ul>
    </section>` : ""}`;
}

// --- the page ------------------------------------------------------------------

function expiryNote(record) {
  const at = Number(record?.expiresAt || 0);
  if (!at) return "";
  return `This link works until ${new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}.`;
}

function render(payload) {
  const record = payload?.record;
  const digest = record?.digest;
  if (!digest) return renderGone(payload);
  const isEval = digest.kind === "eval";
  const names = (digest.team || []).map((entry) => entry.name || entry.species).filter(Boolean);
  const subtitle = isEval
    ? [digest.format, digest.topMeta ? `Top ${digest.topMeta} of the meta` : "", names.join(", ")].filter(Boolean).join(" · ")
    : [digest.format, `${names.length} Pokémon`, names.join(", ")].filter(Boolean).join(" · ");
  const paste = showdownTeam(digest);
  const image = payload.imageUrl || "";
  const page = payload.pageUrl || location.href;

  view.innerHTML = `
    <p class="eyebrow">${isEval ? "Shared Team Evaluation" : "Shared team"} · championsbattledata.com</p>
    <h1>${esc(digest.title)}</h1>
    <p class="share-sub">${esc(subtitle)}</p>
    ${image ? `<div class="share-frame"><img src="${esc(image)}" width="1200" height="630" alt="${esc(digest.title)}" /></div>` : ""}
    <div class="share-actions">
      <button class="primary-button" type="button" data-share="link">Copy the link</button>
      ${paste ? '<button class="ghost-button" type="button" data-share="team">Copy the team</button>' : ""}
      ${image ? `<a class="ghost-button" href="${esc(image)}" download="champions-${esc(payload.code || "share")}.png">Download the image</a>` : ""}
      <a class="ghost-button" href="/team-builder/?format=${encodeURIComponent(digest.format || "Doubles")}">Open the Team Builder</a>
    </div>
    <p class="share-note">${paste ? "Copy the team, then paste it into Import / Export in the Team Builder or the Companion. " : ""}${esc(expiryNote(record))}</p>
    ${/* an evaluation leads with its verdict; a team leads with its sets */ ""}
    ${isEval ? evalPanels(digest) : ""}
    ${(digest.team || []).length ? `<section class="share-panel">
      <h2>${isEval ? "The team that was evaluated" : "The sets"}</h2>
      <div class="share-grid">${(digest.team || []).map(slotCard).join("")}</div>
    </section>` : ""}
    ${paste ? `<details class="share-paste">
      <summary>Show the team as text</summary>
      <textarea readonly spellcheck="false" aria-label="The team in Showdown format">${esc(paste)}</textarea>
    </details>` : ""}
    <p class="share-built">Built with <a href="/">championsbattledata.com</a></p>`;

  view.removeAttribute("role");
  view.removeAttribute("aria-live");
  const linkButton = view.querySelector('[data-share="link"]');
  if (linkButton) linkButton.addEventListener("click", () => copy(page, "Link copied."));
  const teamButton = view.querySelector('[data-share="team"]');
  if (teamButton) teamButton.addEventListener("click", () => copy(paste, "Team copied; paste it into Import / Export."));
  document.title = `${digest.title} - ${isEval ? "Team Evaluation" : "Team"} - Pokemon Champions`;
}

function renderGone(payload) {
  const note = payload?.note || "That share link does not exist any more.";
  view.innerHTML = `
    <p class="eyebrow">Shared from championsbattledata.com</p>
    <h1>${esc(note)}</h1>
    <p class="share-sub">A share link keeps working for ${TTL_DAYS} days. Ask whoever sent it for a fresh one, or build a team of your own.</p>
    <div class="share-actions">
      <a class="primary-button" href="/team-builder/">Open the Team Builder</a>
      <a class="ghost-button" href="/">Browse the ladder data</a>
    </div>
    ${codeForm()}
    <p class="share-built">Built with <a href="/">championsbattledata.com</a></p>`;
  wireCodeForm();
}

function renderLanding() {
  view.innerHTML = `
    <p class="eyebrow">Shared from championsbattledata.com</p>
    <h1>Open a shared team</h1>
    <p class="share-sub">Paste the share code you were given, or the whole link. A share is a snapshot: the picture and the numbers it was made from, with no account attached.</p>
    ${codeForm()}
    <div class="share-actions">
      <a class="ghost-button" href="/team-builder/">Build a team instead</a>
    </div>
    <p class="share-built">Built with <a href="/">championsbattledata.com</a></p>`;
  wireCodeForm();
}

function codeForm() {
  return `<form class="share-code-form" data-share="form">
    <input name="code" placeholder="CBS-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" aria-label="Share code" />
    <button class="primary-button" type="submit">Open it</button>
  </form>`;
}

function wireCodeForm() {
  const form = view.querySelector('[data-share="form"]');
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = normaliseCode(form.elements.code.value);
    if (!code) return toast("That is not a share code.");
    location.href = `/api/share/${code}`;
  });
}

function renderError(message) {
  view.innerHTML = `
    <p class="eyebrow">Shared from championsbattledata.com</p>
    <h1>The share could not be loaded</h1>
    <p class="share-sub">${esc(message)}</p>
    <div class="share-actions"><a class="primary-button" href="/team-builder/">Open the Team Builder</a></div>
    <p class="share-built">Built with <a href="/">championsbattledata.com</a></p>`;
}

async function main() {
  if (!view) return;
  const inline = inlineData();
  if (inline && (inline.record || inline.status === "gone")) return render(inline);
  const code = codeFromLocation();
  if (!code) return renderLanding();
  try {
    const response = await fetch(`/api/share/${code}${RECORD_SUFFIX}`, { headers: { accept: "application/json" } });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.digest) {
      return render({ code, status: "gone", note: body?.error || "That share link does not exist." });
    }
    return render({
      code,
      status: "ok",
      pageUrl: `${location.origin}/api/share/${code}`,
      imageUrl: `${location.origin}/api/share/img/${code}`,
      record: body,
    });
  } catch (error) {
    return renderError(String(error?.message || error));
  }
}

// Exported for the guard suite, which has no DOM: the paste builder and the code
// reader are the only two pieces of this file worth pinning.
export { TTL_DAYS, normaliseCode, showdownFor, showdownTeam };

if (hasDom) main();
