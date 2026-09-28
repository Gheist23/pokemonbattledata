// Guards builder/share-card.js: the LAYOUT, not just that bytes came out.
//
//   node tests/run-share-card.mjs [--verbose]
//
// There is no canvas in node, so the card is drawn into a RecordingContext that
// implements exactly the interface share-card.js declares (CONTEXT_OPS) and
// keeps every primitive's bounding box.  The assertions then read those boxes:
// nothing leaves the canvas, no cell overlaps a neighbour, every field the card
// claims to draw is drawn, and the widest REAL names in data/builder/app-data.json
// still sit inside their box.
//
// THE TEXT STUB.  ADVANCE_400 / ADVANCE_700 are real Chrome measurements of the
// card's own font stack, taken one glyph at a time at 100px and scaled
// linearly.  Over the 1,012 (string, size, weight) samples used to calibrate it
// the additive sum UNDER-estimates the shaped width by at most 0.169px and
// OVER-estimates by up to 32.9px (kerning), so with the +0.5px margin below it
// is an upper bound: a string this suite says fits, fits in the browser too.
//
// WHAT THE STUB CANNOT CATCH, stated plainly:
//   * a different font.  The stack is "Segoe UI", Inter, Roboto, Helvetica,
//     Arial, sans-serif; these advances are Segoe UI on Windows.  A viewer's
//     machine resolving a different family gets different widths, and only a
//     self-hosted font (a later stage) removes that.
//   * kerning and ligatures.  The model is additive, so it is wider than
//     reality, never narrower -- safe for overflow, useless for "is the gap
//     I left actually big enough".
//   * a glyph outside the 96-character table.  Those fall back to one full em,
//     which is wider than any real glyph, so an unknown character can only make
//     the suite stricter.
//   * anything about pixels: antialiasing, image smoothing, sprite decoding and
//     the real PNG byte size are browser facts this file never sees.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CARD, CONTEXT_OPS, ELLIPSIS, EVAL, FONT_LADDER, FOOTER, HEADER, MAX_BONUS_POINTS_PER_STAT,
  MAX_BONUS_STAT_POINTS, MAX_CARD_BYTES, PALETTE, STAT_LABELS, TEAM, bonusTotal, cellScale,
  drawEvalCard, drawTeamCard, fitText, liveTeam, natureLabel, pointsColor, scoreTone, statBarWidth,
  statColor, teamCellBoxes, threatColor, threatTone,
} from "../builder/share-card.js";
import { BuilderData } from "../builder/common.js";
import { MAX_BONUS_POINTS_PER_STAT as ENGINE_PER_STAT, MAX_BONUS_STAT_POINTS as ENGINE_TOTAL } from "../builder/engine.js";
import { scoreTone as uiScoreTone } from "../builder/ui.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const verbose = process.argv.includes("--verbose");
const failures = [];
let checks = 0;

function ok(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
  else if (verbose) console.log(`  ok  ${message}`);
  return Boolean(condition);
}

// --- the measured font -------------------------------------------------------
const ADVANCE_CHARS = " #$%&'()*+,-./0123456789<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~·é—’…−";
const ADVANCE_400 = [27.393, 59.082, 53.906, 81.836, 80.029, 22.998, 30.176, 30.176, 41.699, 68.408, 21.68, 39.99, 21.68, 38.965, 53.906, 53.906, 53.906, 53.906, 53.906, 53.906, 53.906, 53.906, 53.906, 53.906, 68.408, 68.408, 68.408, 44.824, 95.508, 64.502, 57.324, 61.914, 70.117, 50.586, 48.828, 68.604, 70.996, 26.611, 35.693, 58.008, 47.07, 89.795, 74.805, 75.391, 56.006, 75.391, 59.814, 53.125, 52.393, 68.701, 62.109, 93.408, 58.984, 55.273, 57.031, 30.176, 30.176, 68.408, 41.504, 26.807, 50.879, 58.789, 46.191, 58.887, 52.295, 31.299, 58.887, 56.592, 24.219, 24.219, 49.707, 24.219, 86.133, 56.592, 58.594, 58.789, 58.887, 34.766, 42.432, 33.887, 56.592, 47.9, 72.266, 45.898, 48.389, 45.215, 30.176, 23.926, 30.176, 68.408, 21.68, 52.295, 100, 22.9, 73.291, 68.408];
const ADVANCE_700 = [27.588, 59.229, 57.52, 86.719, 84.961, 29.297, 36.914, 36.914, 45.508, 70.703, 27.1, 40.43, 27.1, 44.336, 57.52, 57.52, 57.52, 57.52, 57.52, 57.52, 57.52, 57.52, 57.52, 57.52, 70.703, 70.703, 70.703, 43.799, 95.41, 70.313, 64.111, 62.402, 73.73, 53.223, 52.002, 71.094, 76.611, 31.689, 44.531, 64.893, 51.123, 95.703, 79.004, 75.83, 61.426, 75.83, 65.283, 56.055, 58.594, 72.314, 66.699, 100.488, 65.527, 60.693, 60.693, 36.914, 36.914, 70.703, 41.504, 31.396, 53.809, 62.012, 47.998, 61.914, 54.102, 38.33, 61.914, 60.205, 28.418, 28.418, 55.908, 28.418, 91.602, 60.498, 61.133, 62.012, 61.914, 39.795, 43.994, 38.916, 60.498, 54.199, 79.736, 55.225, 53.809, 47.9, 36.914, 32.617, 36.914, 70.703, 27.1, 54.102, 100, 29.004, 91.211, 70.703];
const ADVANCE_REF = 100;
/** Larger than the worst measured under-estimate (0.169px), so the model is an
 *  upper bound on every string it was calibrated against. */
const ADVANCE_MARGIN = 0.5;
const ADVANCE = { 400: new Map(), 700: new Map() };
[...ADVANCE_CHARS].forEach((ch, i) => {
  ADVANCE[400].set(ch, ADVANCE_400[i]);
  ADVANCE[700].set(ch, ADVANCE_700[i]);
});

function stubWidth(text, size, weight) {
  const table = ADVANCE[weight >= 600 ? 700 : 400];
  let total = 0;
  for (const ch of String(text)) total += (table.get(ch) ?? ADVANCE_REF) * size / ADVANCE_REF;
  return total ? total + ADVANCE_MARGIN : 0;
}

// --- the recording context ---------------------------------------------------
const TEXT_ASCENT = 0.8;
const TEXT_DESCENT = 0.25;

class RecordingContext {
  constructor() {
    this.ops = [];
    this.fillStyle = "#000";
    this.strokeStyle = "#000";
    this.lineWidth = 1;
    this.textAlign = "left";
    this.textBaseline = "alphabetic";
    this._font = "400 13px sans";
    this._size = 13;
    this._weight = 400;
    this._path = null;
    this._stack = [];
  }

  get font() { return this._font; }

  set font(value) {
    this._font = String(value);
    const match = this._font.match(/^\s*(\d+)?\s*([\d.]+)px\s/);
    this._weight = match?.[1] ? Number(match[1]) : 400;
    this._size = match ? Number(match[2]) : 13;
  }

  save() { this._stack.push([this.fillStyle, this.strokeStyle, this.lineWidth, this._font, this.textAlign]); }

  restore() {
    const s = this._stack.pop();
    if (s) [this.fillStyle, this.strokeStyle, this.lineWidth, this.font, this.textAlign] = s;
  }

  measureText(text) { return { width: stubWidth(text, this._size, this._weight) }; }

  _record(kind, x0, y0, x1, y1, extra = {}) {
    this.ops.push({ kind, x0, y0, x1, y1, style: this.fillStyle, ...extra });
  }

  fillRect(x, y, w, h) { this._record("rect", x, y, x + w, y + h); }

  beginPath() { this._path = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; }

  _point(x, y) {
    if (!this._path) this.beginPath();
    this._path.x0 = Math.min(this._path.x0, x);
    this._path.y0 = Math.min(this._path.y0, y);
    this._path.x1 = Math.max(this._path.x1, x);
    this._path.y1 = Math.max(this._path.y1, y);
  }

  moveTo(x, y) { this._point(x, y); }

  lineTo(x, y) { this._point(x, y); }

  arcTo(x1, y1, x2, y2) { this._point(x1, y1); this._point(x2, y2); }

  closePath() {}

  fill() {
    if (!this._path || this._path.x0 === Infinity) return;
    this._record("path-fill", this._path.x0, this._path.y0, this._path.x1, this._path.y1);
  }

  stroke() {
    if (!this._path || this._path.x0 === Infinity) return;
    const g = this.lineWidth / 2;
    this._record("path-stroke", this._path.x0 - g, this._path.y0 - g, this._path.x1 + g, this._path.y1 + g);
  }

  fillText(text, x, y) {
    const w = stubWidth(text, this._size, this._weight);
    const left = this.textAlign === "center" ? x - w / 2 : this.textAlign === "right" ? x - w : x;
    this._record("text", left, y - this._size * TEXT_ASCENT, left + w, y + this._size * TEXT_DESCENT,
      { text: String(text), size: this._size, weight: this._weight, align: this.textAlign });
  }

  drawImage(image, x, y, w, h) {
    if (!image) throw new Error("drawImage(null)");
    this._record("image", x, y, x + w, y + h);
  }
}

// The context must satisfy exactly what the renderer declares it needs.
for (const op of CONTEXT_OPS) {
  ok(typeof RecordingContext.prototype[op] === "function" || op === "measureText",
    `RecordingContext implements ctx.${op}`);
}

// --- box helpers -------------------------------------------------------------
const EPS = 0.01;
const area = (o) => Math.max(0, o.x1 - o.x0) * Math.max(0, o.y1 - o.y0);
const inside = (o, box) => o.x0 >= box.x - EPS && o.y0 >= box.y - EPS
  && o.x1 <= box.x + box.w + EPS && o.y1 <= box.y + box.h + EPS;
const overlaps = (a, b) => a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;
const asBox = (b) => ({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });
const texts = (ops) => ops.filter((o) => o.kind === "text").map((o) => o.text);

/** Everything except the full-canvas background wash. */
const content = (ops) => ops.filter((o) => area(o) < CARD.W * CARD.H * 0.5);

// --- the real data -----------------------------------------------------------
const appData = JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8"));
const data = new BuilderData(appData);
const probe = new RecordingContext();
const widthAt = (text, size, weight) => stubWidth(text, size, weight);

/** The widest string in a list AT THE FIELD'S LARGEST LADDER SIZE -- widest in
 *  pixels, not in characters, because "Menacing Moonraze Maelstrom" and
 *  "10,000,000 Volt Thunderbolt" are both 27 characters and not the same width. */
function widest(list, size, weight) {
  let best = "";
  let bestW = -1;
  for (const value of list) {
    const w = widthAt(value, size, weight);
    if (w > bestW) { bestW = w; best = value; }
  }
  return { text: best, width: bestW };
}

const moveNames = Object.values(appData.moves).map((m) => (typeof m === "string" ? m : m?.name)).filter(Boolean);
const itemNames = Object.values(appData.items).map((v) => v?.name).filter(Boolean);
const abilityNames = Object.values(appData.abilities).map(String).filter(Boolean);
const renderedNames = [...new Set(data.forms.map((row) => String(data.displayName(row.species ?? row.name, row.form, row.form))))];
const displayKeys = Object.keys(appData.displayNames);
const natureNames = Object.keys(appData.natures);

const WIDEST = {
  move: widest(moveNames, FONT_LADDER.move[0], 700),
  item: widest(itemNames, FONT_LADDER.item[0], 400),
  ability: widest(abilityNames, FONT_LADDER.ability[0], 400),
  name: widest(renderedNames, FONT_LADDER.name[0], 700),
  key: widest(displayKeys, FONT_LADDER.name[0], 700),
  nature: widest(natureNames.map((n) => natureLabel({ nature: n, natureUp: appData.natures[n][0], natureDown: appData.natures[n][1] })), FONT_LADDER.nature[0], 400),
};

// --- digests -----------------------------------------------------------------
function entryOf(over = {}) {
  return {
    name: "Froslass-Mega", species: "Froslass", form: "Mega Froslass",
    item: "Froslassite", ability: "Cursed Body",
    nature: "Timid", natureUp: "SPE", natureDown: "ATK",
    moves: ["Blizzard", "Shadow Ball", "Icy Wind", "Protect"],
    bonuses: [0, 0, 2, 32, 0, 32],
    stats: { hp: 145, attack: 90, defense: 92, sp_attack: 192, sp_defense: 120, speed: 189 },
    ...over,
  };
}

const SIX = ["Froslass-Mega", "Sneasler", "Salamence-Mega", "Kingambit", "Farigiraf", "Milotic"]
  .map((name, i) => entryOf({ name, species: name.replace(/-Mega$/, ""), form: name, bonuses: [0, i * 6, 2, 32 - i, 0, 32 - i * 5] }));

const teamDigest = (n) => ({ v: 1, kind: "team", title: "Mega Froslass Trick Room", format: "Doubles", team: SIX.slice(0, n) });

/** Every field filled with the widest REAL string of its kind. */
const WORST_TEAM = {
  v: 1, kind: "team",
  title: `${WIDEST.key.text} Hyper Offense Showcase`,
  format: "Doubles",
  team: Array.from({ length: 6 }, (_, i) => entryOf({
    name: i === 1 ? WIDEST.key.text : WIDEST.name.text,
    species: "Tauros", form: "Paldean Tauros Combat Breed",
    item: WIDEST.item.text, ability: WIDEST.ability.text,
    nature: "Careful", natureUp: "SPD", natureDown: "SPA",
    moves: [WIDEST.move.text, WIDEST.move.text, WIDEST.move.text, WIDEST.move.text],
    bonuses: [32, 32, 2, 0, 0, 0],
    stats: { hp: 255, attack: 255, defense: 255, sp_attack: 255, sp_defense: 255, speed: 255 },
  })),
};

const EVAL_DIGEST = {
  v: 1, kind: "eval", title: "Mega Froslass Trick Room", format: "Doubles",
  archetype: "Hyper Offense",
  scores: { synergy: 61, offense: 55, defense: 51, speed: 88 },
  topMeta: 20, threatCount: 20,
  team: SIX.map((e) => ({ name: e.name, species: e.species, form: e.form, item: e.item })),
  checks: [
    { label: "Archetype: Hyper Offense", severity: "yellow" },
    { label: "Mega Options", severity: "good" },
    { label: "Speed Control", severity: "good" },
    { label: "Protect / Positioning", severity: "good" },
    { label: "Field / Weather Consistency", severity: "good" },
    { label: "Spread Damage", severity: "good" },
    { label: "Priority or Cleanup", severity: "red" },
  ],
  checkCounts: { good: 10, yellow: 1, red: 0 },
  threats: [
    { name: "Mega Charizard Y", species: "Charizard", form: "Mega Charizard Y", item: "Charizardite Y", score: 80 },
    { name: "Sylveon", species: "Sylveon", form: "Sylveon", item: "Pixie Plate", score: 75 },
    { name: "Gholdengo", species: "Gholdengo", form: "Gholdengo", item: "Leftovers", score: 73 },
    { name: "Armarouge", species: "Armarouge", form: "Armarouge", item: "Life Orb", score: 72 },
    { name: "Archaludon", species: "Archaludon", form: "Archaludon", item: "Assault Vest", score: 71 },
    { name: "Incineroar", species: "Incineroar", form: "Incineroar", item: "Sitrus Berry", score: 68 },
  ],
};

/** A fake image the recorder accepts, so the layout runs without an Image. */
const IMG = { width: 128, height: 128 };
const imagesFor = (n, threats = 0) => ({
  sprites: Array.from({ length: n }, () => IMG),
  items: Array.from({ length: n }, () => IMG),
  threatSprites: Array.from({ length: threats }, () => IMG),
});

function render(digest, images) {
  const ctx = new RecordingContext();
  const out = digest.kind === "eval" ? drawEvalCard(ctx, digest, images) : drawTeamCard(ctx, digest, images);
  return { ctx, ops: ctx.ops, out };
}

// =============================================================================
console.log("== share card guard suite ==");

// 1. the parity constants come from the live sources, not a second copy
ok(MAX_BONUS_STAT_POINTS === ENGINE_TOTAL, `MAX_BONUS_STAT_POINTS ${MAX_BONUS_STAT_POINTS} == engine.js ${ENGINE_TOTAL}`);
ok(MAX_BONUS_POINTS_PER_STAT === ENGINE_PER_STAT, `MAX_BONUS_POINTS_PER_STAT ${MAX_BONUS_POINTS_PER_STAT} == engine.js ${ENGINE_PER_STAT}`);
for (const score of [0, 49, 50, 69, 70, 100]) {
  ok(scoreTone(score) === uiScoreTone(score), `scoreTone(${score}) == builder/ui.js (${uiScoreTone(score)})`);
}
// builder/builder-page.js:310-311 and styles.css:4266-4269
ok(statColor(180) === "#188a45" && statColor(179) === "#a6d854", "stat colour cuts at 180 / 140 (--stat-great / --stat-good)");
ok(statColor(140) === "#a6d854" && statColor(139) === "#f2cf5b", "stat colour cuts at 140 / 100 (--stat-good / --stat-mid)");
ok(statColor(100) === "#f2cf5b" && statColor(99) === "#e05243", "stat colour cut at 100 (--stat-mid / --stat-bad)");
ok(statBarWidth("hp", 260, 108) === 108 && statBarWidth("hp", 130, 108) === 54, "HP bar over 260 (builder-page.js:311)");
ok(statBarWidth("speed", 230, 108) === 108 && statBarWidth("speed", 115, 108) === 54, "non-HP bar over 230");
ok(statBarWidth("speed", 400, 108) === 108, "bar clamps at the track width");
const styles = readFileSync(join(root, "styles.css"), "utf8");
for (const [token, colour] of [["--stat-great", "#188a45"], ["--stat-good", "#a6d854"], ["--stat-mid", "#f2cf5b"], ["--stat-bad", "#e05243"]]) {
  ok(styles.includes(`${token}: ${colour};`), `styles.css still defines ${token}: ${colour}`);
}
const builderCss = readFileSync(join(root, "builder", "builder.css"), "utf8");
for (const colour of [PALETTE.good, PALETTE.mid, PALETTE.bad, PALETTE.line, PALETTE.cardDeep, PALETTE.orange]) {
  ok(builderCss.includes(colour), `builder.css still defines ${colour}`);
}
// Threat scores run the OTHER way (higher is more dangerous) and have four
// bands of their own.  threatTone is not exported from evaluation-view.js, so
// pin its cut-offs against that file's source text; if it is ever retuned this
// fails instead of the card quietly disagreeing with the tab.
const evalView = readFileSync(join(root, "builder", "evaluation-view.js"), "utf8");
ok(evalView.includes('score >= 75 ? "bad" : score >= 55 ? "orange" : score >= 35 ? "mid" : "good"'),
  "evaluation-view.js threatTone still cuts at 75 / 55 / 35");
for (const [score, tone] of [[100, "bad"], [75, "bad"], [74, "orange"], [55, "orange"], [54, "mid"], [35, "mid"], [34, "good"], [0, "good"]]) {
  ok(threatTone(score) === tone, `threatTone(${score}) is ${tone}`);
}
ok(threatColor(80) === PALETTE.bad && threatColor(20) === PALETTE.good, "threat colours run opposite to team scores");

// 2. the grid tiles without overlap, for every team size
//
// THE EXPECTED LAYOUT, written out.  A team of one used to draw one 372x232
// cell in a 1144x478 grid -- 17% of it, one small panel in a dark void, an empty
// box once Discord scales the card to ~500px.  The cell now grows by a uniform
// factor, so this table pins BOTH halves of that: the scale each team size gets,
// and the share of the grid it must end up covering.  Every number here is also
// in tests/test_share_card_v518.py, which is how the two renderers are held to
// one geometry.
const EXPECTED_LAYOUT = {
  1: { s: 2.06, rows: [1], cover: 67.0, x: 217, y: 98 },
  2: { s: 1.5, rows: [2], cover: 71.0, x: 32, y: 163 },
  3: { s: 1, rows: [3], cover: 47.3, x: 28, y: 221 },
  4: { s: 1, rows: [3, 1], cover: 63.1, x: 28, y: 98 },
  5: { s: 1, rows: [3, 2], cover: 78.9, x: 28, y: 98 },
  6: { s: 1, rows: [3, 3], cover: 94.7, x: 28, y: 98 },
};
const GRID_AREA = TEAM.gridW * TEAM.gridH;

for (let n = 1; n <= 6; n += 1) {
  const boxes = teamCellBoxes(n);
  const want = EXPECTED_LAYOUT[n];
  ok(boxes.length === n, `teamCellBoxes(${n}) returns ${n} cells`);
  ok(boxes.every((box) => box.s === want.s), `n=${n}: every cell is drawn at scale ${want.s}`);
  for (const box of boxes) {
    ok(box.w === TEAM.cellW * want.s && box.h === TEAM.cellH * want.s,
      `n=${n}: every cell is ${TEAM.cellW}x${TEAM.cellH} at ${want.s} (${box.w}x${box.h})`);
    ok(box.x >= TEAM.gridX && box.x + box.w <= TEAM.gridX + TEAM.gridW, `n=${n}: cell inside the grid horizontally`);
    ok(box.y >= TEAM.gridY && box.y + box.h <= TEAM.gridY + TEAM.gridH, `n=${n}: cell inside the grid vertically`);
    ok(box.y >= HEADER.H && box.y + box.h <= FOOTER.ruleY, `n=${n}: cell clear of the header and the footer`);
  }
  // the split, and where the block starts
  const rowYs = [...new Set(boxes.map((box) => box.y))].sort((a, b) => a - b);
  ok(rowYs.length === want.rows.length, `n=${n}: ${want.rows.length} row(s) of cells`);
  ok(rowYs.every((y, i) => boxes.filter((box) => box.y === y).length === want.rows[i]),
    `n=${n}: the rows hold ${want.rows.join(" then ")}`);
  ok(boxes[0].x === want.x && boxes[0].y === want.y,
    `n=${n}: the block starts at ${want.x},${want.y} (it is ${boxes[0].x},${boxes[0].y})`);
  // THE DEFECT ITSELF: how much of the grid the cells actually cover.
  const cover = (100 * n * boxes[0].w * boxes[0].h) / GRID_AREA;
  ok(Math.abs(cover - want.cover) < 0.1,
    `n=${n}: the cells cover ${cover.toFixed(1)}% of the grid (want ${want.cover}%)`);
  // and each row is centred in the grid, to within the half pixel the integer
  // rounding of a fractional cell width can cost
  for (const y of rowYs) {
    const row = boxes.filter((box) => box.y === y);
    const mid = (row[0].x + row[row.length - 1].x + row[0].w) / 2;
    ok(Math.abs(mid - (TEAM.gridX + TEAM.gridW / 2)) <= 0.5,
      `n=${n}: the row at y=${y} is centred (${mid.toFixed(2)} vs ${TEAM.gridX + TEAM.gridW / 2})`);
  }
  const blockMid = (boxes[0].y + boxes[boxes.length - 1].y + boxes[0].h) / 2;
  ok(Math.abs(blockMid - (TEAM.gridY + TEAM.gridH / 2)) <= 0.5,
    `n=${n}: the block is centred vertically (${blockMid.toFixed(2)} vs ${TEAM.gridY + TEAM.gridH / 2})`);

  for (let a = 0; a < boxes.length; a += 1) {
    for (let b = a + 1; b < boxes.length; b += 1) {
      ok(!overlaps(asBox(boxes[a]), asBox(boxes[b])), `n=${n}: cell ${a} does not overlap cell ${b}`);
      // Not overlapping is not enough: setting gapX to 0 kept every assertion
      // above green while fusing the row into one slab, because touching is not
      // overlapping.  Adjacent cells must be SEPARATED, by the declared gutter,
      // which scales with the cell.  The scaled gutter is exact at every scale
      // this layout uses (21 at 1.5, 14 at 1), so the only slack here is EPS,
      // against the double arithmetic -- not the half pixel that would have let
      // a 13.5px gutter through at the design size.
      const [p, q] = [boxes[a], boxes[b]];
      const gapX = Math.max(p.x - (q.x + q.w), q.x - (p.x + p.w));
      const gapY = Math.max(p.y - (q.y + q.h), q.y - (p.y + p.h));
      ok(gapX >= TEAM.gapX * want.s - EPS || gapY >= TEAM.gapY * want.s - EPS,
        `n=${n}: cell ${a} and cell ${b} are separated by the declared gutter (x ${gapX}, y ${gapY})`);
    }
  }
}
ok(TEAM.gapX > 0 && TEAM.gapY > 0, `the grid declares a positive gutter (${TEAM.gapX} x ${TEAM.gapY})`);
// four must look intentional: three across, the fourth centred under them
const four = teamCellBoxes(4);
ok(four[3].x + four[3].w / 2 === TEAM.gridX + TEAM.gridW / 2, "a four-Pokemon team centres the fourth cell");
// A one-Pokemon team fills the grid's whole height: that is what its 2.06 buys,
// and asserting the centre alone would pass on the 232px cell that read as a
// fault.  Half a pixel of slack, no more.
const one = teamCellBoxes(1)[0];
ok(Math.abs(one.y + one.h / 2 - (TEAM.gridY + TEAM.gridH / 2)) <= 0.5, "a one-Pokemon team centres its row vertically");
ok(one.h >= TEAM.gridH - 1, `a one-Pokemon team fills the grid's height (${one.h} of ${TEAM.gridH})`);
ok(one.w >= 700, `a one-Pokemon team is at least 700px wide (${one.w})`);
// Nothing may grow past the grid it is centred in, at any size.
for (let n = 1; n <= 6; n += 1) {
  for (const box of teamCellBoxes(n)) {
    ok(box.x + box.w <= TEAM.gridX + TEAM.gridW + EPS && box.y + box.h <= TEAM.gridY + TEAM.gridH + EPS,
      `n=${n}: a scaled cell still ends inside the grid`);
  }
}
// The scale rule itself: never below 1, never past what the grid can hold.
for (let columns = 1; columns <= 3; columns += 1) {
  for (let rows = 1; rows <= 2; rows += 1) {
    const s = cellScale(columns, rows);
    ok(s >= 1, `cellScale(${columns}, ${rows}) = ${s} never shrinks the cell below its design size`);
    ok(columns * TEAM.cellW * s + (columns - 1) * TEAM.gapX * s <= TEAM.gridW + EPS,
      `cellScale(${columns}, ${rows}): the row fits the grid width`);
    ok(rows * TEAM.cellH * s + (rows - 1) * TEAM.gapY * s <= TEAM.gridH + EPS,
      `cellScale(${columns}, ${rows}): the block fits the grid height`);
  }
}
ok(teamCellBoxes(0).length === 0, "an empty team asks for no cells");

// 3. the six-Pokemon card: bounds, containment, fields
{
  const { ops, out } = render(teamDigest(6), imagesFor(6));
  ok(out.cells === 6, "six Pokemon draw six cells");
  for (const op of ops) {
    ok(op.x0 >= -EPS && op.y0 >= -EPS && op.x1 <= CARD.W + EPS && op.y1 <= CARD.H + EPS,
      `every op inside the 1200x630 canvas (${op.kind} ${JSON.stringify(op.text ?? "")} at ${op.x0.toFixed(1)},${op.y0.toFixed(1)}-${op.x1.toFixed(1)},${op.y1.toFixed(1)})`);
  }
  const boxes = teamCellBoxes(6);
  const cellBoxes = boxes.map(asBox);
  let checked = 0;
  for (const op of content(ops)) {
    const hits = cellBoxes.filter((b) => overlaps(op, b));
    if (!hits.length) continue;
    checked += 1;
    ok(hits.length === 1, `an op touches exactly one cell (${op.kind} ${JSON.stringify(op.text ?? "")})`);
    ok(inside(op, boxes[cellBoxes.indexOf(hits[0])]),
      `${op.kind} ${JSON.stringify(op.text ?? "")} stays inside its cell (${op.x0.toFixed(1)}..${op.x1.toFixed(1)} x ${op.y0.toFixed(1)}..${op.y1.toFixed(1)})`);
  }
  ok(checked > 200, `cell containment checked ${checked} ops`);

  const drawn = texts(ops);
  const entry = SIX[0];
  ok(drawn.includes(entry.name), "the name is drawn");
  ok(drawn.includes(entry.item), "the item is drawn");
  ok(drawn.includes(entry.ability), "the ability is drawn");
  ok(drawn.includes(natureLabel(entry)), `the nature is drawn as ${JSON.stringify(natureLabel(entry))}`);
  for (const move of entry.moves) ok(drawn.includes(move), `move ${JSON.stringify(move)} is drawn`);
  for (const label of STAT_LABELS) ok(drawn.filter((t) => t === label).length === 6, `stat label ${label} drawn once per cell`);
  for (const key of ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"]) {
    ok(drawn.includes(String(entry.stats[key])), `stat value ${key}=${entry.stats[key]} is drawn`);
  }
  ok(drawn.filter((t) => /^\d+\/66 pts$/.test(t)).length === 6, "Stat Points printed once per cell");
  ok(drawn.includes(`${bonusTotal(entry)}/66 pts`), `slot 1 prints ${bonusTotal(entry)}/66 pts`);
  ok(drawn.filter((t) => /^\+\d+$/.test(t)).length >= 6, "invested Stat Points printed beside the stats");
  ok(drawn.includes(FOOTER.leadText) && drawn.includes(FOOTER.brandText),
    `the footer reads "${FOOTER.leadText}${FOOTER.brandText}"`);
  // ...and it reads the WORDS the owner asked for.  Comparing the drawn run
  // against FOOTER.leadText alone is a tautology: both sides come from the same
  // constant, so changing the constant to "Made by someone " passed the check
  // above unchanged.  These two pin the literal text instead.
  ok(FOOTER.leadText === "Built with ", `the footer lead-in is "Built with " (it is ${JSON.stringify(FOOTER.leadText)})`);
  ok(FOOTER.brandText === "championsbattledata.com",
    `the footer names championsbattledata.com (it is ${JSON.stringify(FOOTER.brandText)})`);
  ok(drawn.includes("Built with ") && drawn.includes("championsbattledata.com"),
    'every card draws "Built with championsbattledata.com"');
  ok(drawn.includes("Doubles"), "the format is drawn");
  ok(ops.filter((o) => o.kind === "image").length === 12, "six sprites and six item icons drawn");

  // the invested "+N" must not collide with its stat's label or its value
  const statOps = ops.filter((o) => o.kind === "text" && /^\+\d+$/.test(o.text));
  for (const plus of statOps) {
    const row = ops.filter((o) => o.kind === "text" && o !== plus && Math.abs(o.y0 - plus.y0) < 4);
    for (const other of row) ok(!overlaps(plus, other), `invested ${plus.text} clear of ${JSON.stringify(other.text)}`);
  }
}

// 4. fewer than six: four, and one
for (const n of [1, 2, 3, 4, 5]) {
  const { ops, out } = render(teamDigest(n), imagesFor(n));
  ok(out.cells === n, `${n} Pokemon draw ${n} cells`);
  ok(ops.filter((o) => o.kind === "image").length === n * 2, `${n} Pokemon draw ${n * 2} images`);
  const boxes = teamCellBoxes(n).map(asBox);
  for (const op of content(ops)) {
    const hits = boxes.filter((b) => overlaps(op, b));
    if (hits.length) ok(hits.length === 1 && inside(op, teamCellBoxes(n)[boxes.indexOf(hits[0])]),
      `n=${n}: ${op.kind} ${JSON.stringify(op.text ?? "")} stays in one cell`);
  }
  ok(texts(ops).includes(FOOTER.brandText), `n=${n}: the footer is still present`);
  ok(texts(ops).some((t) => t.includes(`${n} Pok`)), `n=${n}: the subtitle counts the team`);
}

// 4b. a short team draws the same design LARGER, not the same picture centred.
// The scale is useless if it only moves the box, so this reads the text that was
// really drawn: the name in a one-Pokemon card must be more than twice the size
// of the name in a six-Pokemon card, and the sprite more than twice the area.
{
  const nameOf = (n) => {
    const { ops } = render(teamDigest(n), imagesFor(n));
    return ops.find((o) => o.kind === "text" && o.text === SIX[0].name);
  };
  // A renderer that draws nothing must fail these, not crash them: size 0 keeps
  // every comparison below false and reports a FAILED line instead of throwing.
  const big = nameOf(1);
  const small = nameOf(6);
  const two = nameOf(2);
  ok(big && small && two, "the first name is drawn at one, two and six Pokemon");
  ok((big?.size ?? 0) > (small?.size ?? 0) * 2,
    `a one-Pokemon card draws the name at ${big?.size ?? 0}px against six's ${small?.size ?? 0}px`);
  const spriteOf = (n) => {
    const { ops } = render(teamDigest(n), imagesFor(n));
    const image = ops.filter((o) => o.kind === "image")[0];
    return image ? (image.x1 - image.x0) * (image.y1 - image.y0) : 0;
  };
  ok(spriteOf(1) > spriteOf(6) * 4 && spriteOf(6) > 0,
    `a one-Pokemon card draws the sprite at ${spriteOf(1)}px2 against six's ${spriteOf(6)}px2`);
  ok((two?.size ?? 0) > (small?.size ?? 0), `a two-Pokemon card draws the name at ${two?.size ?? 0}px, above six's ${small?.size ?? 0}px`);
  // and the whole worst-case text still lays out inside the enlarged cells
  for (const n of [1, 2]) {
    const { ops } = render({ ...WORST_TEAM, team: WORST_TEAM.team.slice(0, n) }, imagesFor(n));
    const boxes = teamCellBoxes(n);
    const cellBoxes = boxes.map(asBox);
    for (const op of ops) {
      ok(op.x0 >= -EPS && op.y0 >= -EPS && op.x1 <= CARD.W + EPS && op.y1 <= CARD.H + EPS,
        `n=${n} worst case: ${op.kind} ${JSON.stringify(op.text ?? "")} inside the canvas`);
    }
    for (const op of content(ops)) {
      const hits = cellBoxes.filter((b) => overlaps(op, b));
      if (!hits.length) continue;
      ok(hits.length === 1 && inside(op, boxes[cellBoxes.indexOf(hits[0])]),
        `n=${n} worst case: ${op.kind} ${JSON.stringify(op.text ?? "")} stays in one cell`);
    }
  }
}

// 4c. THE FOUR MOVE CHIPS IN A CELL SHARE ONE SIZE.
// Each chip used to pick its own step, so "10,000,000 Volt Thunderbolt" drew
// visibly smaller than "Soul-Stealing 7-Star Strike" beside it.
{
  const WIDE = "Menacing Moonraze Maelstrom";
  const NARROW = "Ice Shard";
  const mixed = {
    v: 1, kind: "team", title: "Mixed", format: "Doubles",
    team: [entryOf({ moves: [WIDE, NARROW, "10,000,000 Volt Thunderbolt", "Protect"] })],
  };
  for (const n of [1, 6]) {
    const digest = n === 1 ? mixed : { ...mixed, team: Array.from({ length: 6 }, () => mixed.team[0]) };
    const { ops } = render(digest, imagesFor(n));
    const chips = ops.filter((o) => o.kind === "text" && [WIDE, NARROW, "10,000,000 Volt Thunderbolt", "Protect"].includes(o.text));
    ok(chips.length === 4 * n, `n=${n}: four move chips per cell are drawn (${chips.length})`);
    const sizes = [...new Set(chips.map((o) => o.size))];
    ok(sizes.length === 1, `n=${n}: the four chips in a cell share ONE size (${sizes.join(", ")})`);
    // and it is the smallest one any of them needed, not the largest
    const chipTextW = (TEAM.moveColW - TEAM.moveInset * 2) * teamCellBoxes(n)[0].s;
    const alone = fitText(probe, WIDE, chipTextW, FONT_LADDER.move.map((v) => v * teamCellBoxes(n)[0].s), 700);
    ok(sizes[0] === alone.size,
      `n=${n}: the shared size ${sizes[0]} is the step the widest move needs (${alone.size})`);
    ok(sizes[0] < FONT_LADDER.move[0] * teamCellBoxes(n)[0].s,
      `n=${n}: the shared size stepped DOWN for the wide move (${sizes[0]})`);
    for (const chip of chips) {
      ok(chip.x1 - chip.x0 <= chipTextW + EPS,
        `n=${n}: ${JSON.stringify(chip.text)} fits the chip at the shared size (${(chip.x1 - chip.x0).toFixed(1)} <= ${chipTextW})`);
    }
  }
  // the worst real case -- four copies of the widest real move -- still fits
  const worst = {
    v: 1, kind: "team", title: "Worst", format: "Doubles",
    team: [entryOf({ moves: [WIDEST.move.text, WIDEST.move.text, WIDEST.move.text, WIDEST.move.text] })],
  };
  const { ops: worstOps } = render(worst, imagesFor(1));
  const worstChips = worstOps.filter((o) => o.kind === "text" && o.text === WIDEST.move.text);
  ok(worstChips.length === 4, "four copies of the widest real move all draw");
  ok(new Set(worstChips.map((o) => o.size)).size === 1, "and at one size");
  ok(worstChips.every((o) => !o.text.includes(ELLIPSIS)), "the widest real move is still not elided at the shared size");
}

// 4d. AN EMPTY MOVE SLOT READS AS NOTHING, not as a chip that failed to load.
{
  const partial = {
    v: 1, kind: "team", title: "Partial", format: "Doubles",
    team: [entryOf({ moves: ["Protect"] }), entryOf({ moves: [] })],
  };
  const { ops } = render(partial, imagesFor(2));
  const s = teamCellBoxes(2)[0].s;
  const drawn = texts(ops);
  // the em-dash placeholder is gone from the move slots.  The ability line still
  // uses one and that is fine -- it is one small run in a text column, not four
  // outlined pills -- so this counts them: two abilities are set, so no "—" at all.
  ok(!drawn.includes("—"), `no em-dash placeholder is drawn for an empty move slot (${drawn.filter((t) => t === "—").length} found)`);
  const boxes = teamCellBoxes(2);
  const chipAt = (cell, i) => ({
    x0: boxes[cell].x + TEAM.moveX[i % 2] * s,
    y0: boxes[cell].y + TEAM.moveRowY[Math.floor(i / 2)] * s,
    x1: boxes[cell].x + (TEAM.moveX[i % 2] + TEAM.moveColW) * s,
    y1: boxes[cell].y + (TEAM.moveRowY[Math.floor(i / 2)] + TEAM.moveH) * s,
  });
  const at = (box, kind) => ops.filter((o) => o.kind === kind
    && Math.abs(o.x0 - box.x0) < 0.6 && Math.abs(o.y0 - box.y0) < 0.6
    && Math.abs(o.x1 - box.x1) < 0.6 && Math.abs(o.y1 - box.y1) < 0.6);
  // slot 0 of cell 0 holds Protect: a filled, outlined chip with text in it
  const filled = chipAt(0, 0);
  ok(at(filled, "path-fill").length === 1, "a filled move slot draws its chip");
  ok(at(filled, "path-stroke").length === 1, "a filled move slot is outlined");
  ok(at(filled, "path-fill")[0]?.style === PALETTE.cardDeep, "a filled move slot uses the recessed chip colour");
  // slots 1..3 of cell 0 and all four of cell 1 are empty: a quiet recess, no
  // outline, no text
  for (const [cell, slot] of [[0, 1], [0, 2], [0, 3], [1, 0], [1, 1], [1, 2], [1, 3]]) {
    const box = chipAt(cell, slot);
    ok(at(box, "path-fill").length === 1, `cell ${cell} slot ${slot}: an empty slot still marks the slot`);
    ok(at(box, "path-fill")[0]?.style === PALETTE.hairline,
      `cell ${cell} slot ${slot}: an empty slot is the hairline recess, not the chip fill`);
    ok(at(box, "path-stroke").length === 0, `cell ${cell} slot ${slot}: an empty slot is NOT outlined`);
    ok(!ops.some((o) => o.kind === "text" && overlaps(o, box)),
      `cell ${cell} slot ${slot}: an empty slot carries no text`);
  }
  // the four real moves of a full cell are all still outlined chips
  const full = render(teamDigest(6), imagesFor(6));
  const strokes = full.ops.filter((o) => o.kind === "path-stroke" && Math.abs(o.y1 - o.y0 - TEAM.moveH) < 0.6);
  ok(strokes.length === 24, `a six-Pokemon team with every move set still outlines 24 chips (${strokes.length})`);
}

// 4e. THE STAT POINTS READ-OUT CARRIES A VALUE'S COLOUR.
// PALETTE.good was a fixed label colour, so 0/66 and 66/66 were the same green.
{
  ok(pointsColor(0) === PALETTE.soft, `pointsColor(0) is the muted tone (${pointsColor(0)})`);
  ok(pointsColor(1) === PALETTE.mid && pointsColor(65) === PALETTE.mid, "a part-invested team reads mid");
  ok(pointsColor(MAX_BONUS_STAT_POINTS) === PALETTE.good, "a fully invested team reads good");
  ok(pointsColor(0) !== pointsColor(MAX_BONUS_STAT_POINTS), "0/66 and 66/66 are NOT the same colour");
  ok(pointsColor(1) !== pointsColor(MAX_BONUS_STAT_POINTS), "part-invested and fully invested are not the same colour");
  const tone = (bonuses) => {
    const digest = { v: 1, kind: "team", title: "t", format: "Doubles", team: [entryOf({ bonuses })] };
    const { ops } = render(digest, imagesFor(1));
    return ops.find((o) => o.kind === "text" && /^\d+\/66 pts$/.test(o.text));
  };
  const none = tone([0, 0, 0, 0, 0, 0]);
  const part = tone([0, 16, 0, 0, 0, 16]);
  const all = tone([2, 32, 0, 0, 0, 32]);
  ok(none?.text === "0/66 pts" && none?.style === PALETTE.soft, `0/66 pts is drawn ${none?.style}`);
  ok(part?.text === "32/66 pts" && part?.style === PALETTE.mid, `32/66 pts is drawn ${part?.style}`);
  ok(all?.text === "66/66 pts" && all?.style === PALETTE.good, `66/66 pts is drawn ${all?.style}`);
  ok(none !== undefined && all !== undefined && none.style !== all.style, "an uninvested team does not read as a finished one");
}

// 4f. THE INVESTED TOTAL IS CLAMPED TO 66, not just to 32 a stat.
{
  ok(bonusTotal({ bonuses: [99, 99, 99, 99, 99, 99] }) === MAX_BONUS_STAT_POINTS,
    `six over-max stats total ${bonusTotal({ bonuses: [99, 99, 99, 99, 99, 99] })}, not 192`);
  ok(bonusTotal({ bonuses: [32, 32, 32, 0, 0, 0] }) === MAX_BONUS_STAT_POINTS, "three maxed stats still total 66");
  ok(bonusTotal({ bonuses: [4, 32, 0, 0, 0, 30] }) === 66, "a legal spread is unchanged");
  ok(bonusTotal({ bonuses: [0, 16, 0, 0, 0, 16] }) === 32, "a part spread is unchanged");
  ok(bonusTotal({}) === 0, "no bonuses total nothing");
  const crafted = { v: 1, kind: "team", title: "t", format: "Doubles", team: [entryOf({ bonuses: [99, 99, 99, 99, 99, 99] })] };
  const { ops } = render(crafted, imagesFor(1));
  const printed = texts(ops).filter((t) => /\/66 pts$/.test(t));
  ok(printed.length === 1 && printed[0] === "66/66 pts", `a crafted record prints ${JSON.stringify(printed[0])}, never "192/66 pts"`);
  // ...and the subtitle, which sums the six cells, cannot run over either
  const sixCrafted = {
    v: 1, kind: "team", title: "t", format: "Doubles",
    team: Array.from({ length: 6 }, () => entryOf({ bonuses: [99, 99, 99, 99, 99, 99] })),
  };
  const subtitle = texts(render(sixCrafted, imagesFor(6)).ops).find((t) => t.includes("Stat Points"));
  ok(subtitle === "Doubles · 6 Pokémon · 396 Stat Points",
    `a crafted six-Pokemon team totals ${JSON.stringify(subtitle)}, not 1152 Stat Points`);
}

// 5. THE WIDEST REAL STRINGS -- the whole point of the ladder
{
  console.log(`   widest real move     ${JSON.stringify(WIDEST.move.text)} = ${WIDEST.move.width.toFixed(1)}px at ${FONT_LADDER.move[0]}px/700 (chip has ${TEAM.moveColW - TEAM.moveInset * 2}px)`);
  console.log(`   widest real item     ${JSON.stringify(WIDEST.item.text)} = ${WIDEST.item.width.toFixed(1)}px at ${FONT_LADDER.item[0]}px/400 (field has ${TEAM.itemTextW}px)`);
  console.log(`   widest real ability  ${JSON.stringify(WIDEST.ability.text)} = ${WIDEST.ability.width.toFixed(1)}px at ${FONT_LADDER.ability[0]}px/400 (field has ${TEAM.textW}px)`);
  console.log(`   widest drawn name    ${JSON.stringify(WIDEST.name.text)} = ${WIDEST.name.width.toFixed(1)}px at ${FONT_LADDER.name[0]}px/700 (field has ${TEAM.textW}px)`);
  console.log(`   widest displayName   ${JSON.stringify(WIDEST.key.text)} = ${WIDEST.key.width.toFixed(1)}px at ${FONT_LADDER.name[0]}px/700 (field has ${TEAM.textW}px)`);
  console.log(`   widest nature label  ${JSON.stringify(WIDEST.nature.text)} = ${WIDEST.nature.width.toFixed(1)}px at ${FONT_LADDER.nature[0]}px/400 (field has ${TEAM.natureMaxW}px)`);

  // the ladder must SOLVE each field, not merely be applied to it
  const fits = (text, sizes, weight, max) => {
    const fit = fitText(probe, text, max, sizes, weight);
    return { ...fit, ok: fit.width <= max + EPS };
  };
  const moveFit = fits(WIDEST.move.text, FONT_LADDER.move, 700, TEAM.moveColW - TEAM.moveInset * 2);
  ok(moveFit.ok, `the widest real move fits the chip (${moveFit.width.toFixed(1)} <= ${TEAM.moveColW - TEAM.moveInset * 2}) at ${moveFit.size}px`);
  ok(!moveFit.elided, `the widest real move is NOT elided (drawn at ${moveFit.size}px)`);
  const itemFit = fits(WIDEST.item.text, FONT_LADDER.item, 400, TEAM.itemTextW);
  ok(itemFit.ok, `the widest real item fits (${itemFit.width.toFixed(1)} <= ${TEAM.itemTextW}) at ${itemFit.size}px`);
  ok(!itemFit.elided, `the widest real item is NOT elided (drawn at ${itemFit.size}px)`);
  const abilityFit = fits(WIDEST.ability.text, FONT_LADDER.ability, 400, TEAM.textW);
  ok(abilityFit.ok && !abilityFit.elided, `the widest real ability fits unelided at ${abilityFit.size}px (${abilityFit.width.toFixed(1)}px)`);
  const nameFit = fits(WIDEST.name.text, FONT_LADDER.name, 700, TEAM.textW);
  ok(nameFit.ok && !nameFit.elided, `the widest drawn name fits unelided at ${nameFit.size}px (${nameFit.width.toFixed(1)}px)`);
  const keyFit = fits(WIDEST.key.text, FONT_LADDER.name, 700, TEAM.textW);
  ok(keyFit.ok, `the 27-character displayNames KEY fits at ${keyFit.size}px (${keyFit.width.toFixed(1)}px, elided: ${keyFit.elided})`);
  const natureFit = fits(WIDEST.nature.text, FONT_LADDER.nature, 400, TEAM.natureMaxW);
  ok(natureFit.ok && !natureFit.elided, `the widest nature label fits unelided at ${natureFit.size}px (${natureFit.width.toFixed(1)}px)`);

  // and the whole worst-case card still lays out
  const { ops } = render(WORST_TEAM, imagesFor(6));
  for (const op of ops) {
    ok(op.x0 >= -EPS && op.y0 >= -EPS && op.x1 <= CARD.W + EPS && op.y1 <= CARD.H + EPS,
      `worst case: ${op.kind} ${JSON.stringify(op.text ?? "")} inside the canvas`);
  }
  const boxes = teamCellBoxes(6);
  const cellBoxes = boxes.map(asBox);
  for (const op of content(ops)) {
    const hits = cellBoxes.filter((b) => overlaps(op, b));
    if (!hits.length) continue;
    ok(hits.length === 1 && inside(op, boxes[cellBoxes.indexOf(hits[0])]),
      `worst case: ${op.kind} ${JSON.stringify(op.text ?? "")} stays in one cell`);
  }
  const drawn = texts(ops);
  ok(drawn.every((t) => (t.match(/…/g) || []).length <= 1), "no string carries more than one ellipsis");
  ok(drawn.includes(WIDEST.item.text), "the 32-character item is drawn in full");
  ok(drawn.includes(WIDEST.move.text), "the widest real move is drawn in full");
  ok(drawn.includes(FOOTER.brandText), "worst case: the footer is still present");
}

// 6. a missing sprite must cost one cell's art, not the card
{
  const { ops, out } = render(teamDigest(6), { sprites: [IMG, null, IMG, IMG, IMG, IMG], items: [] });
  ok(out.cells === 6, "a null sprite still draws six cells");
  ok(ops.filter((o) => o.kind === "image").length === 5, "the null sprite is skipped, the other five draw");
  ok(texts(ops).filter((t) => t === "?").length === 1, "the missing sprite leaves a placeholder");
  // The ten HTML-error-pages-with-a-.png-name under pokemon_champions_assets/pokemon/
  // decode to nothing; in a browser drawImage on such an image throws.
  const blown = new RecordingContext();
  blown.drawImage = () => { throw new Error("decode failed"); };
  let threw = false;
  try { drawTeamCard(blown, teamDigest(6), imagesFor(6)); } catch { threw = true; }
  ok(!threw, "a sprite whose decode throws does not take the card down");
  ok(texts(blown.ops).includes(FOOTER.brandText), "the card still reaches its footer after a decode failure");
  ok(texts(blown.ops).filter((t) => t === "?").length === 6, "every failed sprite leaves a placeholder");
  const bare = render(teamDigest(6), {});
  ok(bare.out.cells === 6, "no images at all still draws six complete cells");
  ok(bare.ops.filter((o) => o.kind === "image").length === 0, "no images at all draws no images");
  ok(texts(bare.ops).includes(FOOTER.brandText), "no images at all still draws the footer");
}

// 7. the evaluation card -- a different shape, same frame
{
  const { ops, out } = render(EVAL_DIGEST, imagesFor(6, 5));
  ok(out.kind === "eval", "the eval digest draws the eval card");
  for (const op of ops) {
    ok(op.x0 >= -EPS && op.y0 >= -EPS && op.x1 <= CARD.W + EPS && op.y1 <= CARD.H + EPS,
      `eval: ${op.kind} ${JSON.stringify(op.text ?? "")} inside the canvas`);
  }
  const LEFT = { x: EVAL.leftX, y: HEADER.H, w: EVAL.leftW, h: FOOTER.ruleY - HEADER.H };
  const RIGHT = { x: EVAL.rightX, y: HEADER.H, w: EVAL.rightW, h: FOOTER.ruleY - HEADER.H };
  const headerBand = (o) => o.y1 <= 93;
  const footerBand = (o) => o.y0 >= FOOTER.ruleY - 1;
  const divider = (o) => o.x0 >= EVAL.dividerX && o.x1 <= EVAL.dividerX + 1;
  let left = 0;
  let right = 0;
  for (const op of content(ops)) {
    if (headerBand(op) || footerBand(op) || divider(op)) continue;
    if (inside(op, LEFT)) { left += 1; continue; }
    if (inside(op, RIGHT)) { right += 1; continue; }
    ok(false, `eval: ${op.kind} ${JSON.stringify(op.text ?? "")} escapes both columns (${op.x0.toFixed(1)}..${op.x1.toFixed(1)} x ${op.y0.toFixed(1)}..${op.y1.toFixed(1)})`);
  }
  ok(left > 20 && right > 20, `eval: ${left} ops in the left column, ${right} in the right`);
  ok(EVAL.leftX + EVAL.leftW < EVAL.dividerX && EVAL.dividerX < EVAL.rightX, "the two columns are separated by the divider");

  // the four tiles tile without overlapping
  const tiles = [];
  for (let i = 0; i < 4; i += 1) {
    tiles.push({ x: EVAL.tileX[i % 2], y: EVAL.tileY[Math.floor(i / 2)], w: EVAL.tileW, h: EVAL.tileH });
  }
  for (let a = 0; a < 4; a += 1) {
    for (let b = a + 1; b < 4; b += 1) ok(!overlaps(asBox(tiles[a]), asBox(tiles[b])), `eval: tile ${a} clear of tile ${b}`);
    ok(inside(asBox(tiles[a]), LEFT), `eval: tile ${a} inside the left column`);
  }
  // the check rows and the threat rows never meet
  const lastCheck = EVAL.checkTop + (EVAL.checkRows - 1) * EVAL.checkPitch + EVAL.checkPitch;
  ok(lastCheck <= EVAL.moreBaseline, `eval: the check rows end (${lastCheck}) above the "+N more" line (${EVAL.moreBaseline})`);
  ok(EVAL.moreBaseline < EVAL.threatsHeadBaseline - 20, "eval: the threats heading clears the check block");
  const lastThreat = EVAL.threatTop + (EVAL.threatRows - 1) * EVAL.threatPitch + EVAL.threatSprite.h;
  ok(lastThreat < EVAL.rightNoteBaseline - 12, `eval: the threat rows end (${lastThreat}) above the note (${EVAL.rightNoteBaseline})`);

  const drawn = texts(ops);
  for (const [label, key] of [["Synergy", "synergy"], ["Offense", "offense"], ["Defense", "defense"], ["Speed", "speed"]]) {
    ok(drawn.includes(label), `eval: the ${label} tile is labelled`);
    ok(drawn.includes(String(EVAL_DIGEST.scores[key])), `eval: the ${label} score ${EVAL_DIGEST.scores[key]} is drawn`);
  }
  ok(drawn.includes("Team Building Checks") && drawn.includes("Critical threats"), "eval: both section headings drawn");
  ok(drawn.includes("10 good · 1 watch · 0 problem"), "eval: the verdict line is drawn");
  for (const row of EVAL_DIGEST.checks.slice(0, EVAL.checkRows)) ok(drawn.includes(row.label), `eval: check ${JSON.stringify(row.label)} is drawn`);
  ok(!drawn.includes(EVAL_DIGEST.checks[5].label), "eval: the sixth check is not drawn (only five fit)");
  ok(drawn.includes("+2 more checks"), "eval: the remaining checks are counted");
  for (const t of EVAL_DIGEST.threats.slice(0, EVAL.threatRows)) ok(drawn.includes(t.name), `eval: threat ${t.name} is drawn`);
  ok(drawn.includes("80") && drawn.includes("71"), "eval: the threat scores are drawn");
  ok(drawn.includes("Detected archetype: Hyper Offense"), "eval: the archetype is named");

  // THE WORDING.  The card used to head the list "Critical threats (Top 20)" and
  // then say "20 critical threats in the Top 20" under it: the same words twice,
  // and "(Top 20)" reads as "the twenty worst" when it means "of the Top 20 of
  // the meta", which the subtitle already says.  The note now carries the one
  // fact the list cannot: how much of the total is on the card.
  ok(drawn.includes("Showing the 5 worst of 20"), "eval: the note says how much of the list is shown");
  ok(!drawn.some((t) => t.includes("critical threat") && t !== "Critical threats"),
    "eval: the redundant \"N critical threats in the Top N\" line is gone");
  ok(!drawn.some((t) => /^Critical threats \(/.test(t)), "eval: the heading no longer repeats the meta size");
  ok(drawn.filter((t) => t.toLowerCase().includes("top 20")).length === 1,
    `eval: "Top 20" is said once, in the subtitle (${drawn.filter((t) => t.toLowerCase().includes("top 20")).join(" | ")})`);
  // nothing to add when the list already shows everything
  const short = render({ ...EVAL_DIGEST, threats: EVAL_DIGEST.threats.slice(0, 3), threatCount: 3 }, imagesFor(6, 3));
  ok(!texts(short.ops).some((t) => t.startsWith("Showing the")),
    "eval: a list that shows every threat says nothing about how many are shown");
  ok(texts(short.ops).includes("Critical threats"), "eval: ...but still has its heading");

  // A CLEAN TEAM.  threatCount is how many meta rows were EXAMINED, not how many
  // came back critical, so zero threats against a live count is good news -- and
  // "Showing the 0 worst of 20", which is what counting alone produced, is both
  // broken English and the opposite claim.
  const clean = render({ ...EVAL_DIGEST, threats: [], threatCount: 20 }, imagesFor(6, 0));
  const cleanText = texts(clean.ops);
  ok(!cleanText.some((t) => /Showing the 0\b/.test(t)),
    `eval: a team with no critical threats never says "Showing the 0 worst" (${cleanText.filter((t) => t.startsWith("Showing")).join(" | ")})`);
  ok(cleanText.includes("No critical threats"), "eval: a team with no critical threats says so");
  ok(cleanText.includes("Critical threats"), "eval: ...under the same heading");
  ok(clean.ops.filter((o) => o.kind === "image").length === 6,
    "eval: a clean team still draws its six sprites and no threat sprite");
  // ...and a digest with no evaluation at all still says nothing about threats
  const bare = render({ ...EVAL_DIGEST, threats: [], threatCount: 0 }, imagesFor(6, 0));
  ok(!texts(bare.ops).some((t) => t.includes("critical threat") && t !== "Critical threats"),
    "eval: a digest with nothing evaluated makes no claim about threats");

  // THE DEAD GAP.  The left column used to stop at 506 while the right ran to
  // 542 and the footer rule sits at 582, leaving a band roughly a sixth of the
  // column tall with nothing in it.  Both columns must now reach the same depth.
  const bottomOf = (side) => Math.max(...content(ops)
    .filter((o) => !(o.y1 <= 93) && !(o.y0 >= FOOTER.ruleY - 1) && inside(o, side))
    .map((o) => o.y1));
  const leftBottom = bottomOf(LEFT);
  const rightBottom = bottomOf(RIGHT);
  ok(Math.abs(leftBottom - rightBottom) <= 12,
    `eval: the two columns end together (left ${leftBottom.toFixed(1)}, right ${rightBottom.toFixed(1)})`);
  ok(FOOTER.ruleY - Math.max(leftBottom, rightBottom) <= 40,
    `eval: the content reaches the footer rule (${(FOOTER.ruleY - Math.max(leftBottom, rightBottom)).toFixed(1)}px of margin)`);
  ok(leftBottom > 530, `eval: the left column runs to ${leftBottom.toFixed(1)}, not the old 509`);
  // and the space went to the team, not to empty air
  ok(EVAL.stripSize >= 76, `eval: the sprite strip is ${EVAL.stripSize}px, up from the 62 that left the gap`);
  ok(EVAL.leftX + 5 * EVAL.stripPitch + EVAL.stripSize <= EVAL.leftX + EVAL.leftW,
    "eval: six sprites at the larger size still fit the left column");
  ok(EVAL.stripPitch > EVAL.stripSize, `eval: the strip keeps a gap between sprites (${EVAL.stripPitch - EVAL.stripSize}px)`);
  ok(EVAL.tileY[1] + EVAL.tileH < EVAL.stripY, "eval: the tiles clear the sprite strip");
  ok(EVAL.tileBarDY + EVAL.tileBarH < EVAL.tileH, "eval: the tile bar sits inside its tile");
  ok(EVAL.stripY + EVAL.stripSize < EVAL.stripNameBaseline, "eval: the strip names sit below the sprites");
  ok(EVAL.stripNameBaseline < EVAL.archetypeBaseline && EVAL.archetypeBaseline < EVAL.leftNoteBaseline,
    "eval: the left column's three closing lines run in order");
  ok(EVAL.leftNoteBaseline < FOOTER.ruleY, "eval: the left column's last line clears the footer rule");
  ok(drawn.includes(FOOTER.leadText) && drawn.includes(FOOTER.brandText), "eval: the footer is present");
  ok(ops.filter((o) => o.kind === "image").length === 11, "eval: six team sprites and five threat sprites drawn");
  // the longest REAL check label must survive its column
  const worstCheck = fitText(probe, "Field / Weather Consistency", EVAL.checkLabelMaxW, FONT_LADDER.checkLabel);
  ok(!worstCheck.elided, `eval: the longest real check label fits at ${worstCheck.size}px (${worstCheck.width.toFixed(1)} <= ${EVAL.checkLabelMaxW})`);
  const worstThreat = fitText(probe, WIDEST.name.text, EVAL.threatNameMaxW, FONT_LADDER.threatName);
  ok(!worstThreat.elided, `eval: the widest threat name fits at ${worstThreat.size}px (${worstThreat.width.toFixed(1)} <= ${EVAL.threatNameMaxW})`);
}

// 8. fitText itself
{
  ok(fitText(probe, "", 100, FONT_LADDER.name).text === "", "fitText passes an empty string through");
  const short = fitText(probe, "Milotic", TEAM.textW, FONT_LADDER.name, 700);
  ok(short.size === FONT_LADDER.name[0] && !short.elided, "a short name keeps the largest size");
  const huge = fitText(probe, "W".repeat(200), TEAM.textW, FONT_LADDER.name, 700);
  ok(huge.elided && huge.width <= TEAM.textW + EPS, `an impossible string is elided to ${huge.width.toFixed(1)}px`);
  ok(huge.text.endsWith(ELLIPSIS) && (huge.text.match(/…/g) || []).length === 1, "elision adds exactly one ellipsis");
  ok(fitText(probe, "Milotic", 2, FONT_LADDER.name, 700).text === "", "a box narrower than the ellipsis draws nothing");
  // the ladder is descending, so a step never grows the text
  for (const [field, sizes] of Object.entries(FONT_LADDER)) {
    ok(sizes.every((s, i) => i === 0 || s < sizes[i - 1]), `the ${field} ladder descends: ${sizes.join(" > ")}`);
  }
}

// 9. the digest carries nothing fetchable
{
  const hostile = {
    v: 1, kind: "team", title: "t", format: "Doubles",
    team: [entryOf({ sprite: "https://evil.example/x.png", icon: "//evil/y", url: "http://evil" })],
  };
  const { ops } = render(hostile, imagesFor(1));
  const blob = JSON.stringify(ops);
  ok(!blob.includes("evil.example") && !blob.includes("http"), "a URL smuggled into an entry is never drawn or followed");
  ok(liveTeam({ team: [entryOf(), { species: "" }, null] }).length === 1, "liveTeam drops empty and missing slots");
  ok(liveTeam({ team: Array.from({ length: 12 }, () => entryOf()) }).length === 6, "liveTeam caps the team at six");
}

// 10. the byte cap is above every sample actually rendered
ok(MAX_CARD_BYTES >= 319274, `MAX_CARD_BYTES ${MAX_CARD_BYTES} clears the largest rendered sample (319274 bytes, the longest-name team)`);

for (const failure of failures.slice(0, 40)) console.log(`FAILED ${failure}`);
console.log(`\n${checks} checks, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
