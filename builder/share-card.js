/* The share card: one 1200x630 PNG that a pasted link unfurls into.
 *
 * Two kinds, deliberately different shapes:
 *   TEAM  - two rows of three cells, each with the sprite, the name, the item,
 *           the ability, the nature, the four moves and the six stat bars with
 *           their numbers and their invested Stat Points.
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
  move: [12, 11, 10],
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
  moveInset: 8,
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

export const EVAL = Object.freeze({
  dividerX: 534,
  dividerTop: 104,
  dividerBottom: 566,
  leftX: 28,
  leftW: 492,
  tileW: 239,
  tileH: 118,
  tileX: [28, 281],
  tileY: [100, 232],
  tileRadius: 12,
  tileLabelDX: 16,
  tileLabelDY: 30,
  tileValueDY: 86,
  tileBarDY: 96,
  tileBarH: 6,
  tileBarInset: 16,
  stripY: 372,
  stripSize: 62,
  stripPitch: 82,
  stripNameBaseline: 450,
  stripNameMaxW: 78,
  archetypeBaseline: 482,
  leftNoteBaseline: 506,
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
  return total;
}

/** The occupied cells, centred so four Pokemon read as four and not as a grid
 *  with two holes.  Row one takes up to three, row two the rest; each row is
 *  centred in the grid, and a single row is centred vertically too. */
export function teamCellBoxes(count) {
  const total = clamp(Math.round(num(count)), 0, 6);
  if (!total) return [];
  const rows = total > 3 ? [3, total - 3] : [total];
  const boxes = [];
  const rowH = TEAM.cellH;
  const blockH = rows.length * rowH + (rows.length - 1) * TEAM.gapY;
  const y0 = TEAM.gridY + Math.round((TEAM.gridH - blockH) / 2);
  rows.forEach((n, rowIndex) => {
    const rowW = n * TEAM.cellW + (n - 1) * TEAM.gapX;
    const x0 = TEAM.gridX + Math.round((TEAM.gridW - rowW) / 2);
    const y = y0 + rowIndex * (rowH + TEAM.gapY);
    for (let i = 0; i < n; i += 1) {
      boxes.push({ x: x0 + i * (TEAM.cellW + TEAM.gapX), y, w: TEAM.cellW, h: TEAM.cellH });
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
  panel(ctx, x, y, w, h, TEAM.cellRadius);
  const at = (lx, ly) => [x + lx, y + ly];

  const plate = TEAM.spritePlate;
  fillRound(ctx, x + plate.x, y + plate.y, plate.w, plate.h, plate.r, PALETTE.cardDeep);
  const s = TEAM.sprite;
  if (!art(ctx, image, x + s.x, y + s.y, s.w, s.h)) {
    drawText(ctx, "?", x + plate.x + plate.w / 2, y + plate.y + plate.h / 2 + 10, {
      sizes: [28], weight: 700, color: PALETTE.soft, align: "center", maxWidth: plate.w,
    });
  }

  drawText(ctx, entry.name || entry.species, ...at(TEAM.textX, TEAM.nameBaseline), {
    sizes: FONT_LADDER.name, weight: 700, color: PALETTE.text, maxWidth: TEAM.textW,
  });

  const item = str(entry.item).trim();
  if (item) {
    const icon = TEAM.itemIcon;
    const drew = art(ctx, itemIcon, x + icon.x, y + icon.y, icon.w, icon.h);
    drawText(ctx, item, ...at(drew ? TEAM.itemTextX : TEAM.textX, TEAM.itemBaseline), {
      sizes: FONT_LADDER.item, color: PALETTE.text, maxWidth: drew ? TEAM.itemTextW : TEAM.textW,
    });
  } else {
    drawText(ctx, "No item", ...at(TEAM.textX, TEAM.itemBaseline), {
      sizes: FONT_LADDER.item, color: PALETTE.soft, maxWidth: TEAM.textW,
    });
  }

  drawText(ctx, str(entry.ability).trim() || "—", ...at(TEAM.textX, TEAM.abilityBaseline), {
    sizes: FONT_LADDER.ability, color: PALETTE.muted, maxWidth: TEAM.textW,
  });

  drawText(ctx, natureLabel(entry), ...at(TEAM.textX, TEAM.natureBaseline), {
    sizes: FONT_LADDER.nature, color: PALETTE.muted, maxWidth: TEAM.natureMaxW,
  });
  drawText(ctx, `${bonusTotal(entry)}/${MAX_BONUS_STAT_POINTS} pts`, ...at(TEAM.pointsRight, TEAM.natureBaseline), {
    sizes: FONT_LADDER.points, weight: 700, color: PALETTE.good, align: "right", maxWidth: TEAM.pointsMaxW,
  });

  const moves = Array.isArray(entry.moves) ? entry.moves : [];
  for (let i = 0; i < 4; i += 1) {
    const mx = x + TEAM.moveX[i % 2];
    const my = y + TEAM.moveRowY[Math.floor(i / 2)];
    const move = str(moves[i]).trim();
    fillRound(ctx, mx, my, TEAM.moveColW, TEAM.moveH, TEAM.moveRadius, PALETTE.cardDeep);
    strokeRound(ctx, mx, my, TEAM.moveColW, TEAM.moveH, TEAM.moveRadius, PALETTE.line);
    drawText(ctx, move || "—", mx + TEAM.moveColW / 2, my + 15, {
      sizes: FONT_LADDER.move, weight: 700, color: move ? PALETTE.text : PALETTE.soft,
      align: "center", maxWidth: TEAM.moveColW - TEAM.moveInset * 2,
    });
  }

  const stats = entry.stats || {};
  const up = STAT_CODES.indexOf(str(entry.natureUp).toUpperCase());
  const down = STAT_CODES.indexOf(str(entry.natureDown).toUpperCase());
  const bonuses = Array.isArray(entry.bonuses) ? entry.bonuses : [];
  for (let i = 0; i < 6; i += 1) {
    const key = STAT_KEYS[i];
    const sx = x + TEAM.statX[i % 3];
    const sy = y + TEAM.statRowY[Math.floor(i / 3)];
    const value = Math.round(num(stats[key]));
    const labelColor = i === up ? PALETTE.natureUp : i === down ? PALETTE.natureDown : PALETTE.muted;
    drawText(ctx, STAT_LABELS[i], sx, sy + TEAM.statTextDY, {
      sizes: FONT_LADDER.statLabel, weight: 700, color: labelColor, maxWidth: 40,
    });
    const valueFit = drawText(ctx, String(value), sx + TEAM.statColW, sy + TEAM.statTextDY, {
      sizes: FONT_LADDER.statValue, weight: 700, color: PALETTE.text, align: "right", maxWidth: 44,
    });
    const invested = clamp(Math.round(num(bonuses[i])), 0, MAX_BONUS_POINTS_PER_STAT);
    if (invested > 0) {
      drawText(ctx, `+${invested}`, sx + TEAM.statColW - valueFit.width - TEAM.statGapBeforeValue, sy + TEAM.statTextDY, {
        sizes: FONT_LADDER.statPoints, weight: 700, color: PALETTE.good, align: "right", maxWidth: 30,
      });
    }
    bar(ctx, sx, sy + TEAM.statBarDY, TEAM.statColW, TEAM.statBarH,
      statBarWidth(key, value, TEAM.statColW), statColor(value));
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
      drawText(ctx, "?", x + EVAL.stripSize / 2, EVAL.stripY + EVAL.stripSize / 2 + 8, {
        sizes: [22], weight: 700, color: PALETTE.soft, align: "center", maxWidth: EVAL.stripSize,
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
  const topMeta = Math.max(0, Math.round(num(digest?.topMeta)));
  drawText(ctx, topMeta ? `Critical threats (Top ${topMeta})` : "Critical threats", EVAL.rightX, EVAL.threatsHeadBaseline, {
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
    // Higher is more dangerous (evaluation-view.js:201 threatTone), so the
    // colour runs the other way from a team score.
    const tone = score >= 70 ? PALETTE.bad : score >= 50 ? PALETTE.mid : PALETTE.good;
    bar(ctx, EVAL.threatBarX, y + EVAL.threatBarDY, EVAL.threatBarW, EVAL.threatBarH,
      Math.round((EVAL.threatBarW * score) / 100), tone);
    drawText(ctx, String(score), EVAL.threatScoreRight, y + EVAL.threatNameDY, {
      sizes: FONT_LADDER.threatScore, weight: 700, color: tone, align: "right", maxWidth: 40,
    });
  });
  const total = Math.max(0, Math.round(num(digest?.threatCount)));
  if (total) {
    drawText(ctx, `${total} critical threat${total === 1 ? "" : "s"}${topMeta ? ` in the Top ${topMeta}` : ""}`,
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
