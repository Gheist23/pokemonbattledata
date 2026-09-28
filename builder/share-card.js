/* The share card: one 1200x630 PNG that a pasted link unfurls into.
 *
 * Two kinds, deliberately different shapes:
 *   TEAM  - up to two rows of three cells, each with the sprite, the name, the
 *           item, the ability, the nature, the four moves and the six stat bars
 *           with their numbers and their invested Stat Points.  A team of one or
 *           two draws the SAME cell at a uniform scale (see teamCellBoxes), so a
 *           short team fills the card instead of floating in it.
 *   EVAL  - four score tiles, the team as a sprite strip, the Team Building
 *           Checks and the critical threats.  Not the six-cell grid.
 *
 * Everything here is PURE.  It never touches `document`, never fetches, never
 * reads a URL out of the digest, and draws only through a small context
 * interface (see CONTEXT_OPS), so the node guard suite can hand it a recording
 * context and assert the layout instead of squinting at pixels.  The browser
 * entry point is `renderCardBlob`, which is the only function that knows what a
 * canvas is, and it takes its canvas and image factories as arguments.
 *
 * The digest is the ONLY input.  It carries names, numbers and nothing
 * fetchable: no sprite path, no URL, no id.  Sprites are resolved by the HOST
 * from species/form/item through the local index (builder/common.js
 * DataIndex.sprite), which is what keeps the card pipeline from becoming an
 * open proxy.  Stats are pre-computed by the producer with the same
 * data.engine.finalStats call the Team Builder tab uses
 * (builder/builder-page.js:289), so the image and the tab can never disagree.
 *
 * Colours and thresholds are the live ones, not a second copy of them:
 *   builder/builder.css:8-18   the Team Builder "green console" palette
 *   styles.css:4266-4269       --stat-bad/mid/good/great
 *   builder/builder-page.js:310-311  the bar width and colour expressions
 *   builder/ui.js:400-404      scoreTone's 70 / 50 cuts
 *   builder/engine.js:260-261  MAX_BONUS_STAT_POINTS / _PER_STAT
 */

// --- the context interface -----------------------------------------------------
// Every drawing call this module makes.  A browser CanvasRenderingContext2D
// satisfies it; so does tests/run-share-card.mjs's RecordingContext.  Gradients
// are optional: `linear()` falls back to a solid colour when the context has no
// createLinearGradient, so a test context needs none of it.
export const CONTEXT_OPS = Object.freeze([
  "save", "restore", "beginPath", "closePath", "moveTo", "lineTo", "arcTo",
  "fill", "stroke", "fillRect", "measureText", "fillText", "drawImage",
]);

// --- the geometry table --------------------------------------------------------
// Numbers only.  The Companion's share_card_layout.py is a transcription of this
// block, and a parity test diffs the two.  Keep it literal: no expressions that
// a parser cannot read.

export const CARD = Object.freeze({ W: 1200, H: 630 });

/** Maximum sane PNG payload for one card.  Measured, not guessed: see the
 *  sample sizes reported by tests/run-share-card.mjs --samples. */
export const MAX_CARD_BYTES = 600000;

export const PALETTE = Object.freeze({
  pageTop: "#0a1710",
  pageBottom: "#050b08",
  card: ["rgba(20, 34, 24, 0.97)", "rgba(8, 17, 12, 0.96)"],
  cardDeep: "rgba(5, 13, 8, 0.72)",
  line: "rgba(114, 255, 171, 0.16)",
  lineStrong: "rgba(114, 255, 171, 0.36)",
  text: "#f7f9fc",
  muted: "#a6b1c2",
  soft: "#77869a",
  good: "#72ffab",
  mid: "#f2cf5b",
  bad: "#ff7a66",
  natureUp: "#ff9a9a",
  natureDown: "#9ec9ff",
  statGreat: "#188a45",
  statGood: "#a6d854",
  statMid: "#f2cf5b",
  statBad: "#e05243",
  track: "rgba(114, 255, 171, 0.16)",
  hairline: "rgba(114, 255, 171, 0.09)",
  orange: "#fdba74",
});

/** One family for both renderers.  Two families would be two sets of text
 *  metrics to keep in step, and the Companion's QFontDatabase would have to
 *  resolve both.  This is the stack .bd-hero already uses (builder.css:27). */
export const FONT_STACK = '"Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';

/** Shrink ladders.  A field is measured at each size in turn and the first that
 *  fits wins; at the last size the text is elided with a single ellipsis. */
export const FONT_LADDER = Object.freeze({
  title: [30, 27, 24, 21],
  subtitle: [15, 14, 13],
  name: [19, 17.5, 16],
  item: [13, 12, 11],
  ability: [13, 12, 11],
  nature: [12.5, 11.5, 10.5],
  points: [11.5, 10.5],
  move: [12, 11, 10, 9.5],
  statLabel: [10.5],
  statValue: [11],
  statPoints: [10],
  tileLabel: [13],
  tileValue: [42, 38, 34],
  stripName: [10.5, 9.5],
  sectionHead: [17, 16],
  checkLabel: [13.5, 12.5, 11.5],
  severity: [12],
  threatName: [13, 12, 11],
  threatScore: [13],
  note: [13, 12],
  footer: [17, 16],
});

export const ELLIPSIS = "…";

export const HEADER = Object.freeze({
  H: 92,
  ruleY: 91.5,
  padX: 28,
  titleBaseline: 48,
  titleMaxW: 860,
  subBaseline: 73,
  subMaxW: 860,
  pillRight: 1172,
  pillY: 28,
  pillH: 30,
  pillRadius: 15,
  pillPadX: 14,
  pillTextSize: 14,
  noteBaseline: 78,
  noteMaxW: 300,
});

export const FOOTER = Object.freeze({
  ruleY: 582.5,
  baseline: 613,
  leadText: "Built with ",
  brandText: "championsbattledata.com",
});

export const TEAM = Object.freeze({
  gridX: 28,
  gridY: 98,
  gridW: 1144,
  gridH: 478,
  cellW: 372,
  cellH: 232,
  gapX: 14,
  gapY: 14,
  cellRadius: 12,
  pad: 14,
  spritePlate: { x: 12, y: 10, w: 80, h: 80, r: 10 },
  sprite: { x: 14, y: 12, w: 76, h: 76 },
  textX: 100,
  textW: 258,
  nameBaseline: 33,
  itemIcon: { x: 100, y: 44, w: 14, h: 14 },
  itemTextX: 118,
  itemTextW: 240,
  itemBaseline: 55,
  abilityBaseline: 74,
  natureBaseline: 92,
  natureMaxW: 188,
  pointsRight: 358,
  pointsMaxW: 66,
  moveColW: 167,
  moveGap: 10,
  moveX: [14, 191],
  moveRowY: [104, 130],
  moveH: 22,
  moveRadius: 6,
  moveInset: 7,
  statColW: 108,
  statGap: 10,
  statX: [14, 132, 250],
  statRowY: [160, 190],
  statTextDY: 9,
  statBarDY: 14,
  statBarH: 5,
  statGapBeforeValue: 6,
  // builder-page.js:311 -- the same denominators, so the image and the tab agree.
  barMaxHp: 260,
  barMaxOther: 230,
});

// The left column is laid out to END WHERE THE RIGHT ONE DOES (the threat note
// at 542).  It used to stop at 506 with the strip at 62px, which left a dead
// band roughly a sixth of the column tall in the lower left.  The space went to
// the two things worth reading at Discord's ~500px downscale: taller score tiles
// and a 76px sprite strip (76 + 5*82 = 514, inside the 492+28 column).
export const EVAL = Object.freeze({
  dividerX: 534,
  dividerTop: 104,
  dividerBottom: 566,
  leftX: 28,
  leftW: 492,
  tileW: 239,
  tileH: 126,
  tileX: [28, 281],
  tileY: [100, 240],
  tileRadius: 12,
  tileLabelDX: 16,
  tileLabelDY: 30,
  tileValueDY: 90,
  tileBarDY: 106,
  tileBarH: 6,
  tileBarInset: 16,
  stripY: 392,
  stripSize: 76,
  stripPitch: 82,
  stripNameBaseline: 486,
  stripNameMaxW: 78,
  archetypeBaseline: 516,
  leftNoteBaseline: 540,
  rightX: 548,
  rightW: 624,
  checksHeadBaseline: 124,
  verdictBaseline: 146,
  checkTop: 158,
  checkPitch: 29,
  checkRows: 5,
  checkDotX: 557,
  checkDotDY: 14,
  checkDotR: 5,
  checkLabelX: 572,
  checkLabelMaxW: 516,
  checkLabelDY: 18,
  severityRight: 1172,
  severityReserve: 70,
  moreBaseline: 319,
  threatsHeadBaseline: 356,
  threatTop: 370,
  threatPitch: 30,
  threatRows: 5,
  threatSprite: { x: 548, w: 28, h: 28, dy: 1 },
  threatNameX: 586,
  threatNameMaxW: 412,
  threatNameDY: 19,
  threatBarX: 1010,
  threatBarW: 90,
  threatBarH: 6,
  threatBarDY: 11,
  threatScoreRight: 1172,
  rightNoteBaseline: 542,
});

export const STAT_KEYS = Object.freeze(["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"]);
/** The text drawn (common.js:15 STAT_LABELS). */
export const STAT_LABELS = Object.freeze(["HP", "Atk", "Def", "SpA", "SpD", "Spe"]);
/** What app-data.json's natures table names them (builder-page.js:310). */
export const STAT_CODES = Object.freeze(["HP", "ATK", "DEF", "SPA", "SPD", "SPE"]);

/** builder/engine.js:260-261. */
export const MAX_BONUS_STAT_POINTS = 66;
export const MAX_BONUS_POINTS_PER_STAT = 32;

// --- small pure helpers --------------------------------------------------------

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const str = (value) => String(value ?? "");

/** builder/ui.js:400-404, not a second set of cut-offs. */
export function scoreTone(score) {
  if (score >= 70) return "good";
  if (score >= 50) return "mid";
  return "bad";
}

export function scoreColor(score) {
  return PALETTE[scoreTone(num(score))];
}

/** builder/evaluation-view.js:202-203 threatTone (_v47_threat_score_color):
 *  higher is MORE dangerous, and it has four bands and its own cut-offs -- not
 *  scoreTone's two.  Not exported there, so the guard suite asserts the cuts
 *  against that file's source text instead of letting them drift. */
export function threatTone(score) {
  const value = num(score);
  if (value >= 75) return "bad";
  if (value >= 55) return "orange";
  if (value >= 35) return "mid";
  return "good";
}

export function threatColor(score) {
  return PALETTE[threatTone(score)];
}

/** builder/builder-page.js:310 -- the same four thresholds. */
export function statColor(value) {
  const stat = num(value);
  if (stat >= 180) return PALETTE.statGreat;
  if (stat >= 140) return PALETTE.statGood;
  if (stat >= 100) return PALETTE.statMid;
  return PALETTE.statBad;
}

/** builder/builder-page.js:311 -- min(100, stat / (hp ? 260 : 230)) of the track. */
export function statBarWidth(key, value, trackW) {
  const max = key === "hp" ? TEAM.barMaxHp : TEAM.barMaxOther;
  return Math.round(trackW * Math.min(1, Math.max(0, num(value) / max)));
}

/** `Adamant  +Atk -SpA`, or just the name for a neutral nature. */
export function natureLabel(entry) {
  const name = str(entry?.nature).trim();
  if (!name) return "";
  const up = STAT_CODES.indexOf(str(entry?.natureUp).toUpperCase());
  const down = STAT_CODES.indexOf(str(entry?.natureDown).toUpperCase());
  if (up < 0 || down < 0 || up === down) return name;
  return `${name}  +${STAT_LABELS[up]} −${STAT_LABELS[down]}`;
}

export function bonusTotal(entry) {
  const list = Array.isArray(entry?.bonuses) ? entry.bonuses : [];
  let total = 0;
  for (let i = 0; i < 6; i += 1) total += clamp(Math.round(num(list[i])), 0, MAX_BONUS_POINTS_PER_STAT);
  // Per stat AND in total.  engine.js caps the team's whole spend at 66, and
  // clamping only the six parts let a crafted record render "192/66 pts".
  return clamp(total, 0, MAX_BONUS_STAT_POINTS);
}

/** The Stat Points read-out is a VALUE, so it carries a value's colour.  It was
 *  a fixed PALETTE.good, which made a brand-new 0/66 team read as finished. */
export function pointsColor(total) {
  const points = clamp(Math.round(num(total)), 0, MAX_BONUS_STAT_POINTS);
  if (points >= MAX_BONUS_STAT_POINTS) return PALETTE.good;
  if (points > 0) return PALETTE.mid;
  return PALETTE.soft;
}

/** Three columns is the widest row.  The cell's own text is laid out for that
 *  width -- a 27-character move in a 153px chip -- so a fourth column would
 *  shrink the chips, not the margins. */
export const TEAM_MAX_COLUMNS = 3;

/** Round half up, in a way BOTH renderers agree on.  JS Math.round and Python's
 *  round() disagree on .5 (Python rounds to even), and the scaled layouts below
 *  produce exact halves, so neither is used. */
function halfUp(value) {
  return Math.floor(value + 0.5);
}

/** The uniform scale a `columns` x `rows` block of cells may be drawn at,
 *  floored to 1/100 so the two renderers compute the same number from the same
 *  doubles and the block can never round its way outside the grid. */
export function cellScale(columns, rows) {
  const rowW = columns * TEAM.cellW + (columns - 1) * TEAM.gapX;
  const blockH = rows * TEAM.cellH + (rows - 1) * TEAM.gapY;
  return Math.floor(Math.min(TEAM.gridW / rowW, TEAM.gridH / blockH) * 100) / 100;
}

/** How a team of `count` is split into rows, top row first. */
function rowSplit(count, columns) {
  const rows = [];
  for (let left = count; left > 0; left -= columns) rows.push(Math.min(columns, left));
  return rows;
}

/**
 * The occupied cells: {x, y, w, h, s}.
 *
 * Two jobs.  Centring, so four Pokemon read as four and not as a grid with two
 * holes.  And FILLING: at the fixed 372x232 cell a team of one covered 17% of
 * the grid and read as a rendering fault -- one small panel in a dark void, an
 * empty box once Discord scales the card to ~500px.  So the arrangement that
 * lets the cell grow the most wins, and `s` is the uniform factor the cell is
 * drawn at: every length and every font size multiplied by one number, so it is
 * the same design, larger, and not a second layout to keep in step.
 *
 * What that picks, and why each is the best available:
 *   1  one cell, s=2.06 -- height-bound (232 * 2.06 = 478, the whole grid).
 *      67% of the grid instead of 17%.
 *   2  one row of two, s=1.50 -- width-bound (2*558 + 21 = 1137 of 1144). 73%.
 *   3  one row of three, s=1.00 -- already width-bound at full size; stacking
 *      them 2+1 reaches the same scale (the height then binds at exactly 1.00)
 *      and gives up the full-width row, so three stays as it was.
 *   4  3+1, s=1.00 -- 2x2 ties on scale and area; 3+1 keeps the top row the
 *      same shape as five and six, with the odd cell centred under it.
 *   5  3+2, s=1.00.  6  3+3, s=1.00.  Both unchanged.
 */
export function teamCellBoxes(count) {
  const total = clamp(Math.round(num(count)), 0, 6);
  if (!total) return [];
  let best = null;
  for (let columns = 1; columns <= TEAM_MAX_COLUMNS; columns += 1) {
    const rows = rowSplit(total, columns);
    const widest = Math.max(...rows);
    const s = cellScale(widest, rows.length);
    // Bigger cell wins; on a tie the wider first row wins, which is what keeps
    // four at 3+1 rather than 2x2.
    if (!best || s > best.s + 1e-9 || (s > best.s - 1e-9 && widest > best.widest)) {
      best = { s, rows, widest };
    }
  }
  const { s, rows } = best;
  const cellW = TEAM.cellW * s;
  const cellH = TEAM.cellH * s;
  const gapX = TEAM.gapX * s;
  const gapY = TEAM.gapY * s;
  const boxes = [];
  const blockH = rows.length * cellH + (rows.length - 1) * gapY;
  const y0 = TEAM.gridY + halfUp((TEAM.gridH - blockH) / 2);
  rows.forEach((n, rowIndex) => {
    const rowW = n * cellW + (n - 1) * gapX;
    const x0 = TEAM.gridX + halfUp((TEAM.gridW - rowW) / 2);
    const y = y0 + rowIndex * (cellH + gapY);
    for (let i = 0; i < n; i += 1) {
      boxes.push({ x: x0 + i * (cellW + gapX), y, w: cellW, h: cellH, s });
    }
  });
  return boxes;
}

// --- text fitting --------------------------------------------------------------

export function fontOf(size, weight = 400, family = FONT_STACK) {
  return `${weight} ${size}px ${family}`;
}

function widthOf(ctx, text, size, weight, family) {
  ctx.font = fontOf(size, weight, family);
  return num(ctx.measureText(text)?.width, 0);
}

/** Measure, step down the ladder, then elide with one ellipsis.  Returns the
 *  exact text and size that will be drawn, so a caller (or a test) can assert
 *  the result fits before anything is painted. */
export function fitText(ctx, text, maxWidth, sizes, weight = 400, family = FONT_STACK) {
  const source = str(text);
  const ladder = Array.isArray(sizes) && sizes.length ? sizes : [13];
  if (!source) return { text: "", size: ladder[0], width: 0, elided: false };
  for (const size of ladder) {
    const width = widthOf(ctx, source, size, weight, family);
    if (width <= maxWidth) return { text: source, size, width, elided: false };
  }
  const size = ladder[ladder.length - 1];
  ctx.font = fontOf(size, weight, family);
  const ellipsisW = num(ctx.measureText(ELLIPSIS)?.width, 0);
  if (ellipsisW > maxWidth) return { text: "", size, width: 0, elided: true };
  let lo = 0;
  let hi = source.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (num(ctx.measureText(source.slice(0, mid))?.width, 0) + ellipsisW <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  const cut = `${source.slice(0, lo).replace(/\s+$/, "")}${ELLIPSIS}`;
  return { text: cut, size, width: num(ctx.measureText(cut)?.width, 0), elided: true };
}

/** Fit and draw in one call.  Returns what was drawn and its measured width so
 *  the caller can place the next run beside it. */
export function drawText(ctx, text, x, y, opts = {}) {
  const { sizes = [13], weight = 400, color = PALETTE.text, align = "left", maxWidth = CARD.W, family = FONT_STACK } = opts;
  const fit = fitText(ctx, text, maxWidth, sizes, weight, family);
  if (!fit.text) return fit;
  ctx.font = fontOf(fit.size, weight, family);
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = color;
  ctx.fillText(fit.text, x, y);
  return fit;
}

// --- primitives ----------------------------------------------------------------

/** A gradient when the context can make one, otherwise the last stop.  Keeps
 *  createLinearGradient off the required context interface. */
function linear(ctx, x0, y0, x1, y1, stops) {
  if (typeof ctx.createLinearGradient !== "function") return stops[stops.length - 1][1];
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  return gradient;
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function fillRound(ctx, x, y, w, h, r, fill) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

function strokeRound(ctx, x, y, w, h, r, stroke, lineWidth = 1) {
  roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

function bar(ctx, x, y, w, h, value, fill, track = PALETTE.track) {
  const r = h / 2;
  fillRound(ctx, x, y, w, h, r, track);
  const filled = Math.max(0, Math.min(w, value));
  if (filled >= 1) fillRound(ctx, x, y, Math.max(filled, h), h, r, fill);
}

function rule(ctx, y, x0 = HEADER.padX, x1 = HEADER.pillRight) {
  ctx.fillStyle = PALETTE.line;
  ctx.fillRect(x0, y, x1 - x0, 1);
}

function dot(ctx, cx, cy, r, fill) {
  fillRound(ctx, cx - r, cy - r, r * 2, r * 2, r, fill);
}

/** The card's background, drawn before anything else. */
function background(ctx) {
  ctx.fillStyle = linear(ctx, 0, 0, 0, CARD.H, [[0, PALETTE.pageTop], [1, PALETTE.pageBottom]]);
  ctx.fillRect(0, 0, CARD.W, CARD.H);
}

function panel(ctx, x, y, w, h, r) {
  fillRound(ctx, x, y, w, h, r, linear(ctx, x, y, x, y + h, [[0, PALETTE.card[0]], [1, PALETTE.card[1]]]));
  strokeRound(ctx, x, y, w, h, r, PALETTE.line);
}

/** An image the host resolved, or a muted plate when it could not.  Never
 *  throws: a corrupt sprite (ten of the 393 files under
 *  pokemon_champions_assets/pokemon/ are HTML error pages with a .png name)
 *  must cost one cell's art, not the whole card. */
function art(ctx, image, x, y, w, h) {
  if (!image) return false;
  try {
    ctx.drawImage(image, x, y, w, h);
    return true;
  } catch {
    return false;
  }
}

// --- the shared chrome ---------------------------------------------------------

function header(ctx, { title, subtitle, pill, note }) {
  drawText(ctx, title, HEADER.padX, HEADER.titleBaseline, {
    sizes: FONT_LADDER.title, weight: 700, color: PALETTE.text, maxWidth: HEADER.titleMaxW,
  });
  drawText(ctx, subtitle, HEADER.padX, HEADER.subBaseline, {
    sizes: FONT_LADDER.subtitle, color: PALETTE.muted, maxWidth: HEADER.subMaxW,
  });
  if (pill) {
    const fit = fitText(ctx, pill, HEADER.noteMaxW, [HEADER.pillTextSize], 700);
    const w = Math.round(fit.width + HEADER.pillPadX * 2);
    const x = HEADER.pillRight - w;
    fillRound(ctx, x, HEADER.pillY, w, HEADER.pillH, HEADER.pillRadius, PALETTE.cardDeep);
    strokeRound(ctx, x, HEADER.pillY, w, HEADER.pillH, HEADER.pillRadius, PALETTE.lineStrong);
    drawText(ctx, fit.text, x + w / 2, HEADER.pillY + 20, {
      sizes: [HEADER.pillTextSize], weight: 700, color: PALETTE.good, align: "center", maxWidth: w,
    });
  }
  drawText(ctx, note, HEADER.pillRight, HEADER.noteBaseline, {
    sizes: FONT_LADDER.note, color: PALETTE.muted, align: "right", maxWidth: HEADER.noteMaxW,
  });
  rule(ctx, HEADER.ruleY);
}

/** The line the owner asked for, centred, in two runs so the domain can carry
 *  the brand colour. */
function footer(ctx) {
  rule(ctx, FOOTER.ruleY);
  const size = FONT_LADDER.footer[0];
  ctx.font = fontOf(size, 400);
  const leadW = num(ctx.measureText(FOOTER.leadText)?.width, 0);
  ctx.font = fontOf(size, 700);
  const brandW = num(ctx.measureText(FOOTER.brandText)?.width, 0);
  const x = Math.round((CARD.W - (leadW + brandW)) / 2);
  drawText(ctx, FOOTER.leadText, x, FOOTER.baseline, { sizes: [size], color: PALETTE.muted });
  drawText(ctx, FOOTER.brandText, x + leadW, FOOTER.baseline, { sizes: [size], weight: 700, color: PALETTE.good });
}

// --- the team card -------------------------------------------------------------

function teamCell(ctx, entry, box, image, itemIcon) {
  const { x, y, w, h } = box;
  // One factor for the whole cell: lengths, offsets and font sizes alike.  A
  // cell at s=2.06 is the six-cell design at 206%, not a second layout.
  const s = num(box.s, 1) || 1;
  const up = (value) => value * s;
  const ladder = (sizes) => (s === 1 ? sizes : sizes.map((size) => size * s));
  const at = (lx, ly) => [x + up(lx), y + up(ly)];

  panel(ctx, x, y, w, h, up(TEAM.cellRadius));

  const plate = TEAM.spritePlate;
  fillRound(ctx, x + up(plate.x), y + up(plate.y), up(plate.w), up(plate.h), up(plate.r), PALETTE.cardDeep);
  const spriteBox = TEAM.sprite;
  if (!art(ctx, image, x + up(spriteBox.x), y + up(spriteBox.y), up(spriteBox.w), up(spriteBox.h))) {
    drawText(ctx, "?", ...at(plate.x + plate.w / 2, plate.y + plate.h / 2 + 10), {
      sizes: [up(28)], weight: 700, color: PALETTE.soft, align: "center", maxWidth: up(plate.w),
    });
  }

  drawText(ctx, entry.name || entry.species, ...at(TEAM.textX, TEAM.nameBaseline), {
    sizes: ladder(FONT_LADDER.name), weight: 700, color: PALETTE.text, maxWidth: up(TEAM.textW),
  });

  const item = str(entry.item).trim();
  if (item) {
    const icon = TEAM.itemIcon;
    const drew = art(ctx, itemIcon, x + up(icon.x), y + up(icon.y), up(icon.w), up(icon.h));
    drawText(ctx, item, ...at(drew ? TEAM.itemTextX : TEAM.textX, TEAM.itemBaseline), {
      sizes: ladder(FONT_LADDER.item), color: PALETTE.text, maxWidth: up(drew ? TEAM.itemTextW : TEAM.textW),
    });
  } else {
    drawText(ctx, "No item", ...at(TEAM.textX, TEAM.itemBaseline), {
      sizes: ladder(FONT_LADDER.item), color: PALETTE.soft, maxWidth: up(TEAM.textW),
    });
  }

  drawText(ctx, str(entry.ability).trim() || "—", ...at(TEAM.textX, TEAM.abilityBaseline), {
    sizes: ladder(FONT_LADDER.ability), color: PALETTE.muted, maxWidth: up(TEAM.textW),
  });

  drawText(ctx, natureLabel(entry), ...at(TEAM.textX, TEAM.natureBaseline), {
    sizes: ladder(FONT_LADDER.nature), color: PALETTE.muted, maxWidth: up(TEAM.natureMaxW),
  });
  const points = bonusTotal(entry);
  drawText(ctx, `${points}/${MAX_BONUS_STAT_POINTS} pts`, ...at(TEAM.pointsRight, TEAM.natureBaseline), {
    sizes: ladder(FONT_LADDER.points), weight: 700, color: pointsColor(points),
    align: "right", maxWidth: up(TEAM.pointsMaxW),
  });

  const moves = Array.isArray(entry.moves) ? entry.moves : [];
  const chipW = up(TEAM.moveColW);
  const chipH = up(TEAM.moveH);
  const chipR = up(TEAM.moveRadius);
  const chipTextW = up(TEAM.moveColW - TEAM.moveInset * 2);
  const moveSizes = ladder(FONT_LADDER.move);
  // ONE size for the four chips in a cell: the smallest step any of them needs.
  // Fitting each chip on its own put "10,000,000 Volt Thunderbolt" a step below
  // the move beside it -- legible at full size, visibly unbalanced, and gone at
  // Discord's downscale.  The ladder descends, so the step the widest move needs
  // fits every narrower one too.
  let step = 0;
  for (let i = 0; i < 4; i += 1) {
    const move = str(moves[i]).trim();
    if (!move) continue;
    const fit = fitText(ctx, move, chipTextW, moveSizes, 700);
    step = Math.max(step, moveSizes.indexOf(fit.size));
  }
  const moveSize = moveSizes[Math.max(0, step)];
  for (let i = 0; i < 4; i += 1) {
    const mx = x + up(TEAM.moveX[i % 2]);
    const my = y + up(TEAM.moveRowY[Math.floor(i / 2)]);
    const move = str(moves[i]).trim();
    if (!move) {
      // An empty slot is a RECESS, not a chip.  A filled, outlined pill with an
      // em-dash in it reads as a move that failed to load -- four of them read
      // as a broken card.  This is the same hairline the check rows use: it says
      // "a slot, nothing in it" and stops competing with the real moves.
      fillRound(ctx, mx, my, chipW, chipH, chipR, PALETTE.hairline);
      continue;
    }
    fillRound(ctx, mx, my, chipW, chipH, chipR, PALETTE.cardDeep);
    strokeRound(ctx, mx, my, chipW, chipH, chipR, PALETTE.line);
    drawText(ctx, move, mx + chipW / 2, my + up(15), {
      sizes: [moveSize], weight: 700, color: PALETTE.text,
      align: "center", maxWidth: chipTextW,
    });
  }

  const stats = entry.stats || {};
  const natUp = STAT_CODES.indexOf(str(entry.natureUp).toUpperCase());
  const natDown = STAT_CODES.indexOf(str(entry.natureDown).toUpperCase());
  const bonuses = Array.isArray(entry.bonuses) ? entry.bonuses : [];
  const colW = up(TEAM.statColW);
  for (let i = 0; i < 6; i += 1) {
    const key = STAT_KEYS[i];
    const sx = x + up(TEAM.statX[i % 3]);
    const sy = y + up(TEAM.statRowY[Math.floor(i / 3)]);
    const value = Math.round(num(stats[key]));
    const labelColor = i === natUp ? PALETTE.natureUp : i === natDown ? PALETTE.natureDown : PALETTE.muted;
    drawText(ctx, STAT_LABELS[i], sx, sy + up(TEAM.statTextDY), {
      sizes: ladder(FONT_LADDER.statLabel), weight: 700, color: labelColor, maxWidth: up(40),
    });
    const valueFit = drawText(ctx, String(value), sx + colW, sy + up(TEAM.statTextDY), {
      sizes: ladder(FONT_LADDER.statValue), weight: 700, color: PALETTE.text, align: "right", maxWidth: up(44),
    });
    const invested = clamp(Math.round(num(bonuses[i])), 0, MAX_BONUS_POINTS_PER_STAT);
    if (invested > 0) {
      drawText(ctx, `+${invested}`, sx + colW - valueFit.width - up(TEAM.statGapBeforeValue), sy + up(TEAM.statTextDY), {
        sizes: ladder(FONT_LADDER.statPoints), weight: 700, color: PALETTE.good, align: "right", maxWidth: up(30),
      });
    }
    bar(ctx, sx, sy + up(TEAM.statBarDY), colW, up(TEAM.statBarH),
      statBarWidth(key, value, colW), statColor(value));
  }
}

function teamSubtitle(digest) {
  const team = liveTeam(digest);
  const parts = [str(digest.format) || "Doubles", `${team.length} Pokémon`];
  const points = team.reduce((sum, entry) => sum + bonusTotal(entry), 0);
  if (points) parts.push(`${points} Stat Points`);
  if (str(digest.archetype).trim()) parts.push(str(digest.archetype).trim());
  return parts.join(" · ");
}

export function liveTeam(digest) {
  const list = Array.isArray(digest?.team) ? digest.team : [];
  return list.filter((entry) => entry && str(entry.species).trim()).slice(0, 6);
}

/**
 * @param ctx      a CONTEXT_OPS-shaped drawing context, already 1200x630
 * @param digest   the share digest (kind "team")
 * @param images   { sprites: [image|null x6], items: [image|null x6] } as the
 *                 host resolved them.  Missing entries degrade, never throw.
 */
export function drawTeamCard(ctx, digest, images = {}) {
  const team = liveTeam(digest);
  background(ctx);
  header(ctx, {
    title: str(digest?.title).trim() || "Pokémon Champions Team",
    subtitle: teamSubtitle({ ...digest, team }),
    pill: str(digest?.format) || "Doubles",
    note: "Team Builder",
  });
  const boxes = teamCellBoxes(team.length);
  const sprites = images.sprites || [];
  const items = images.items || [];
  team.forEach((entry, i) => teamCell(ctx, entry, boxes[i], sprites[i] || null, items[i] || null));
  if (!team.length) {
    drawText(ctx, "This team is empty.", CARD.W / 2, CARD.H / 2, {
      sizes: [24], weight: 700, color: PALETTE.soft, align: "center", maxWidth: 600,
    });
  }
  footer(ctx);
  return { kind: "team", cells: boxes.length };
}

// --- the evaluation card -------------------------------------------------------

const SCORE_TILES = Object.freeze([
  ["Synergy", "synergy"],
  ["Offense", "offense"],
  ["Defense", "defense"],
  ["Speed", "speed"],
]);

const SEVERITY_WORD = Object.freeze({ good: "Good", yellow: "Watch", red: "Problem" });
const SEVERITY_COLOR = Object.freeze({ good: PALETTE.good, yellow: PALETTE.mid, red: PALETTE.bad });

function severityKey(value) {
  const key = str(value).toLowerCase();
  if (key === "red") return "red";
  if (key === "yellow") return "yellow";
  return "good";
}

function scoreTiles(ctx, digest) {
  const scores = digest?.scores || {};
  SCORE_TILES.forEach(([label, key], i) => {
    const x = EVAL.tileX[i % 2];
    const y = EVAL.tileY[Math.floor(i / 2)];
    panel(ctx, x, y, EVAL.tileW, EVAL.tileH, EVAL.tileRadius);
    const value = clamp(Math.round(num(scores[key])), 0, 100);
    drawText(ctx, label, x + EVAL.tileLabelDX, y + EVAL.tileLabelDY, {
      sizes: FONT_LADDER.tileLabel, weight: 700, color: PALETTE.muted, maxWidth: EVAL.tileW - EVAL.tileLabelDX * 2,
    });
    drawText(ctx, String(value), x + EVAL.tileLabelDX, y + EVAL.tileValueDY, {
      sizes: FONT_LADDER.tileValue, weight: 700, color: scoreColor(value), maxWidth: EVAL.tileW - EVAL.tileLabelDX * 2,
    });
    const barW = EVAL.tileW - EVAL.tileBarInset * 2;
    bar(ctx, x + EVAL.tileBarInset, y + EVAL.tileBarDY, barW, EVAL.tileBarH,
      Math.round((barW * value) / 100), scoreColor(value));
  });
}

function spriteStrip(ctx, digest, sprites) {
  const team = liveTeam(digest);
  team.forEach((entry, i) => {
    const x = EVAL.leftX + i * EVAL.stripPitch;
    fillRound(ctx, x, EVAL.stripY, EVAL.stripSize, EVAL.stripSize, 10, PALETTE.cardDeep);
    if (!art(ctx, sprites[i] || null, x, EVAL.stripY, EVAL.stripSize, EVAL.stripSize)) {
      drawText(ctx, "?", x + EVAL.stripSize / 2, EVAL.stripY + EVAL.stripSize / 2 + 10, {
        sizes: [26], weight: 700, color: PALETTE.soft, align: "center", maxWidth: EVAL.stripSize,
      });
    }
    // A name may be wider than the 62px sprite it sits under, so centring it on
    // the sprite would hang the first one off the left edge of the column and
    // the last one off the right.  Clamp the centre into the column; both
    // renderers must do this, it is a rule and not a number.
    const fit = fitText(ctx, entry.name || entry.species, EVAL.stripNameMaxW, FONT_LADDER.stripName);
    const half = fit.width / 2;
    const cx = clamp(x + EVAL.stripSize / 2, EVAL.leftX + half, EVAL.leftX + EVAL.leftW - half);
    drawText(ctx, fit.text, cx, EVAL.stripNameBaseline, {
      sizes: [fit.size], color: PALETTE.muted, align: "center", maxWidth: EVAL.stripNameMaxW,
    });
  });
}

function checkList(ctx, digest) {
  const rows = (Array.isArray(digest?.checks) ? digest.checks : []).slice(0, EVAL.checkRows);
  const counts = digest?.checkCounts || {};
  drawText(ctx, "Team Building Checks", EVAL.rightX, EVAL.checksHeadBaseline, {
    sizes: FONT_LADDER.sectionHead, weight: 700, color: PALETTE.text, maxWidth: EVAL.rightW,
  });
  const verdict = [
    `${Math.max(0, Math.round(num(counts.good)))} good`,
    `${Math.max(0, Math.round(num(counts.yellow)))} watch`,
    `${Math.max(0, Math.round(num(counts.red)))} problem`,
  ].join(" · ");
  drawText(ctx, verdict, EVAL.rightX, EVAL.verdictBaseline, {
    sizes: FONT_LADDER.note, color: PALETTE.muted, maxWidth: EVAL.rightW,
  });
  rows.forEach((row, i) => {
    const y = EVAL.checkTop + i * EVAL.checkPitch;
    const key = severityKey(row?.severity);
    if (i) {
      ctx.fillStyle = PALETTE.hairline;
      ctx.fillRect(EVAL.rightX, y, EVAL.rightW, 1);
    }
    dot(ctx, EVAL.checkDotX, y + EVAL.checkDotDY, EVAL.checkDotR, SEVERITY_COLOR[key]);
    drawText(ctx, row?.label, EVAL.checkLabelX, y + EVAL.checkLabelDY, {
      sizes: FONT_LADDER.checkLabel, color: PALETTE.text, maxWidth: EVAL.checkLabelMaxW,
    });
    drawText(ctx, SEVERITY_WORD[key], EVAL.severityRight, y + EVAL.checkLabelDY, {
      sizes: FONT_LADDER.severity, weight: 700, color: SEVERITY_COLOR[key],
      align: "right", maxWidth: EVAL.severityReserve,
    });
  });
  const extra = Math.max(0, (Array.isArray(digest?.checks) ? digest.checks.length : 0) - rows.length);
  if (extra) {
    drawText(ctx, `+${extra} more check${extra === 1 ? "" : "s"}`, EVAL.rightX, EVAL.moreBaseline, {
      sizes: [12], color: PALETTE.soft, maxWidth: EVAL.rightW,
    });
  }
}

function threatList(ctx, digest, sprites) {
  const all = Array.isArray(digest?.threats) ? digest.threats : [];
  const rows = all.slice(0, EVAL.threatRows);
  // Just "Critical threats".  The heading used to read "Critical threats (Top
  // 20)" -- which sounds like "the twenty worst threats" but means "of the Top
  // 20 of the meta", and the subtitle already says that.  The note below now
  // says the one thing the heading cannot: how many of them you are looking at.
  drawText(ctx, "Critical threats", EVAL.rightX, EVAL.threatsHeadBaseline, {
    sizes: FONT_LADDER.sectionHead, weight: 700, color: PALETTE.text, maxWidth: EVAL.rightW,
  });
  rows.forEach((row, i) => {
    const y = EVAL.threatTop + i * EVAL.threatPitch;
    const s = EVAL.threatSprite;
    if (i) {
      ctx.fillStyle = PALETTE.hairline;
      ctx.fillRect(EVAL.rightX, y, EVAL.rightW, 1);
    }
    fillRound(ctx, s.x, y + s.dy, s.w, s.h, 6, PALETTE.cardDeep);
    art(ctx, sprites[i] || null, s.x, y + s.dy, s.w, s.h);
    drawText(ctx, row?.name, EVAL.threatNameX, y + EVAL.threatNameDY, {
      sizes: FONT_LADDER.threatName, color: PALETTE.text, maxWidth: EVAL.threatNameMaxW,
    });
    const score = clamp(Math.round(num(row?.score)), 0, 100);
    const tone = threatColor(score);
    bar(ctx, EVAL.threatBarX, y + EVAL.threatBarDY, EVAL.threatBarW, EVAL.threatBarH,
      Math.round((EVAL.threatBarW * score) / 100), tone);
    drawText(ctx, String(score), EVAL.threatScoreRight, y + EVAL.threatNameDY, {
      sizes: FONT_LADDER.threatScore, weight: 700, color: tone, align: "right", maxWidth: 40,
    });
  });
  // Only when there is something the list does not show.  "20 critical threats
  // in the Top 20" under a heading that said the same thing told a reader
  // nothing; this says which part of the 20 is on the card.
  //
  // `threatCount` is the number of meta rows that were EXAMINED, not the number
  // that came back critical (share_link_v518.py takes it from
  // all_top_meta_threat_rows_v462, the whole Top-X, while `threats` holds only
  // the critical ones).  So an empty list with a live count is a clean team, and
  // "Showing the 0 worst of 20" is both broken English and the wrong claim: it
  // gets the good news instead.  Nothing at all is drawn when the digest carries
  // no evaluation to speak of (no rows AND no count).
  const total = Math.max(0, Math.round(num(digest?.threatCount)));
  const note = rows.length ? (total > rows.length ? `Showing the ${rows.length} worst of ${total}` : "")
    : (total ? "No critical threats" : "");
  if (note) {
    drawText(ctx, note,
      EVAL.rightX, EVAL.rightNoteBaseline, { sizes: [12], color: PALETTE.soft, maxWidth: EVAL.rightW });
  }
}

export function drawEvalCard(ctx, digest, images = {}) {
  const sprites = images.sprites || [];
  background(ctx);
  const topMeta = Math.max(0, Math.round(num(digest?.topMeta)));
  header(ctx, {
    title: str(digest?.title).trim() || "Team Evaluation",
    subtitle: [str(digest?.format) || "Doubles", topMeta ? `Top ${topMeta} of the meta` : "", "Team Evaluation"]
      .filter(Boolean).join(" · "),
    pill: str(digest?.format) || "Doubles",
    note: "Team Evaluation",
  });
  ctx.fillStyle = PALETTE.line;
  ctx.fillRect(EVAL.dividerX, EVAL.dividerTop, 1, EVAL.dividerBottom - EVAL.dividerTop);
  scoreTiles(ctx, digest);
  spriteStrip(ctx, digest, sprites);
  const archetype = str(digest?.archetype).trim();
  if (archetype) {
    drawText(ctx, `Detected archetype: ${archetype}`, EVAL.leftX, EVAL.archetypeBaseline, {
      sizes: [14], weight: 700, color: PALETTE.good, maxWidth: EVAL.leftW,
    });
  }
  const team = liveTeam(digest);
  drawText(ctx, `${team.length} Pokémon evaluated against the ranked meta`, EVAL.leftX, EVAL.leftNoteBaseline, {
    sizes: FONT_LADDER.note, color: PALETTE.soft, maxWidth: EVAL.leftW,
  });
  checkList(ctx, digest);
  threatList(ctx, digest, images.threatSprites || []);
  footer(ctx);
  return { kind: "eval", cells: 4 };
}

/** Dispatch on the digest's kind. */
export function drawCard(ctx, digest, images = {}) {
  return str(digest?.kind) === "eval" ? drawEvalCard(ctx, digest, images) : drawTeamCard(ctx, digest, images);
}

// --- how many images a digest needs -------------------------------------------

/** The sprite lookups a card needs, as {kind, species, form, item} rows.  The
 *  HOST turns each into a local asset path through the sprite index; nothing in
 *  this module or in the digest may carry a path or a URL. */
export function spriteRequests(digest) {
  const out = [];
  liveTeam(digest).forEach((entry, index) => {
    out.push({ slot: "sprites", index, species: entry.species, form: entry.form || entry.species, item: entry.item || "" });
    if (str(digest?.kind) !== "eval" && str(entry.item).trim()) {
      out.push({ slot: "items", index, item: str(entry.item).trim() });
    }
  });
  if (str(digest?.kind) === "eval") {
    (Array.isArray(digest?.threats) ? digest.threats : []).slice(0, EVAL.threatRows).forEach((row, index) => {
      out.push({ slot: "threatSprites", index, species: row?.species || row?.name, form: row?.form || row?.name, item: row?.item || "" });
    });
  }
  return out;
}

// --- the browser entry point ---------------------------------------------------

/**
 * Render the card to PNG bytes in the browser.  Every platform dependency is an
 * argument, so this file stays importable from node.
 *
 * @param digest    the share digest
 * @param host      {
 *   createCanvas(w, h)   -> a canvas with getContext("2d") and toBlob/convertToBlob
 *   loadImage(request)   -> Promise<image|null>, resolving the sprite LOCALLY
 *   fonts?               -> Promise awaited before the first measureText
 * }
 * @returns { blob, bytes, width, height }
 */
export async function renderCardBlob(digest, host) {
  if (!host || typeof host.createCanvas !== "function" || typeof host.loadImage !== "function") {
    throw new Error("renderCardBlob needs a host with createCanvas and loadImage");
  }
  if (host.fonts) await host.fonts;
  const images = { sprites: [], items: [], threatSprites: [] };
  const requests = spriteRequests(digest);
  const loaded = await Promise.all(requests.map(async (request) => {
    try {
      return await host.loadImage(request);
    } catch {
      return null;
    }
  }));
  requests.forEach((request, i) => {
    (images[request.slot] ||= [])[request.index] = loaded[i] || null;
  });
  const canvas = host.createCanvas(CARD.W, CARD.H);
  const ctx = canvas.getContext("2d");
  drawCard(ctx, digest, images);
  const blob = await toPngBlob(canvas);
  return { blob, bytes: blob.size, width: CARD.W, height: CARD.H };
}

function toPngBlob(canvas) {
  if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob returned nothing"))), "image/png");
  });
}
