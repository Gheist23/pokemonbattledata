// Read a team out of two in-game screenshots ("Moves & More" and "Stats").
//
// The game never prints the species: the card heading is the player's own
// nickname.  It does print, per stat, the final value and the points spent, and
// Champions' stat formula has no level, IV or EV term:
//
//     final = floor((base + points) * natureMultiplier)      HP: final = base + points
//
// so the six base stats can be SOLVED back out of the screen, and 333 of the
// game's 358 forms have a base-stat sextuple no other form shares.  Species,
// form, nature and all six point values therefore come out of arithmetic, not
// out of reading text, and the six points of a legal spread always add up to
// 66 (MAX_BONUS_STAT_POINTS), which is a free checksum on every card.
//
// Moves, ability and item do need text.  There is no OCR engine on this site
// and adding one would cost megabytes, so this file carries a small glyph
// atlas lifted from the game's own rendering (DIGITS_B64 and GLYPHS_B64 below)
// and matches whole candidate strings against the pixels by forced alignment.  That only works
// because every candidate list is tiny: the moves of the solved species that
// have the type the move's own icon shows, that form's own ability list, the
// item list.  Anything it is not sure about is handed to the player to fix
// rather than imported silently.
//
// Everything here is pure: an "image" is { width, height, data } with `data` an
// RGBA Uint8ClampedArray, exactly what a canvas hands back, so the guard suite
// (tests/run-screenshot-import.mjs) reads the same pixels the browser does.

import { MAX_BONUS_POINTS_PER_STAT, MAX_BONUS_STAT_POINTS } from "./engine.js";
import { makeSet, setToShowdown } from "./common.js";
import { clear, h, problemCard, sprite } from "./ui.js";

// --- the card grid ------------------------------------------------------------------
//
// Every measurement below is in "canonical card" pixels: the 421x109 card of a
// 1080x810 capture.  A card found in a capture of any other size is resampled
// to that box first (cropCard), so the reader does not care what resolution the
// player's phone records at, only that the cards are big enough to still carry
// the glyphs.

const CARD_W = 421;
const CARD_H = 109;
/** Below this, the game's 11px text has been resampled away and nothing can be read. */
const MIN_CARD_SCALE = 0.75;

const STAT_ROW_TOP = [33, 57, 82];
const MOVE_ROW_TOP = [8, 34, 59, 85];

// Left/right column geometry of the Stats tab, per row. `value` and `points`
// are where to look; `valueRight` and `pointLeft` are the edges the digits are
// actually aligned on, which is what puts each digit in its own 7px cell.
const STAT_COLUMNS = [
  { label: [46, 120], value: [114, 152], valueRight: 150, points: [176, 212], pointLeft: 181, bar: [153, 181] },
  { label: [244, 322], value: [311, 349], valueRight: 347, points: [373, 409], pointLeft: 378, bar: [350, 378] },
];
// Moves tab: the ability sits on the left of row 1, the item on row 2, and the
// four moves run down the right-hand column.  404 stops short of the big
// translucent slot number the game watermarks into the card's bottom corner.
const ABILITY_X = [50, 250];
const ITEM_X = [50, 250];
const MOVE_TEXT_X = [278, 404];
const MOVE_ICON_X = [257, 275];
// Heading badges: gender, then type 1, then type 2, in three fixed slots.  A
// genderless Pokemon leaves slot 1 empty rather than shifting the types left.
const BADGE_SLOTS = [[177, 193], [198, 213], [222, 237]];
const BADGE_Y = [7, 22];

/** Stat order everywhere in the builder: HP, Attack, Defense, Sp. Atk, Sp. Def, Speed. */
const STAT_KEYS = ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"];
/** The nature table's codes for the five stats a nature can touch. */
const NATURE_CODES = ["", "ATK", "DEF", "SPA", "SPD", "SPE"];
/** Screen position (row, column) of each stat on the Stats tab. */
const STAT_CELLS = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]];

export const MESSAGES = {
  notTwo: "Two pictures are needed: the “Moves & More” tab and the “Stats” tab.",
  noCards: "No Pokémon cards were found in one of the pictures. Take the screenshot from the team screen, with the whole screen in the picture.",
  sameTab: "Both pictures show the same tab. One has to be “Moves & More” and the other “Stats”.",
  mismatch: "The two pictures show different teams. Take both screenshots from the same team without changing anything in between.",
  tooSmall: "The picture is too small to read. Take the screenshot at your phone's own resolution instead of a cropped or shrunk copy.",
  badSpread: "The stat points on one card do not add up to 66, so the numbers were not read correctly. A sharper screenshot usually fixes it.",
  // One picture chosen and one still to go is not a failure, so the panel says
  // what is still missing in plain words instead of showing a problem card.
  needBoth: "Now choose the other picture as well: one has to be the “Moves & More” tab and the other the “Stats” tab.",
  needStats: "That is the “Moves & More” tab. Now choose a picture of the “Stats” tab as well.",
  needMoves: "That is the “Stats” tab. Now choose a picture of the “Moves & More” tab as well.",
};

// --- pixels -------------------------------------------------------------------------

/** Bilinear sample, clamped at the edges. */
function sample(image, fx, fy, out) {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(fy)));
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const a = (y0 * image.width + x0) * 4, b = (y0 * image.width + x1) * 4;
  const c = (y1 * image.width + x0) * 4, d = (y1 * image.width + x1) * 4;
  for (let k = 0; k < 3; k++) {
    const top = image.data[a + k] * (1 - tx) + image.data[b + k] * tx;
    const bottom = image.data[c + k] * (1 - tx) + image.data[d + k] * tx;
    out[k] = top * (1 - ty) + bottom * ty;
  }
  return out;
}

/** The card plate and its heading band are the only strong blue-over-red areas
 *  on the screen; the page behind them is warm cream and the tabs are green. */
function isPlate(r, g, b) {
  return b > r + 22 && b > g + 30 && b > 110 && b < 245;
}

/** Rows and columns of a boolean mask, as runs of set pixels. */
function runs(values, min, gap) {
  const out = [];
  let start = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > min) { if (start < 0) start = i; }
    else if (start >= 0) { out.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) out.push([start, values.length - 1]);
  const merged = [];
  for (const run of out) {
    if (merged.length && run[0] - merged[merged.length - 1][1] - 1 <= gap) merged[merged.length - 1][1] = run[1];
    else merged.push(run);
  }
  return merged;
}

/**
 * The six team cards, in reading order (left to right, top to bottom).
 * A team with empty slots simply has fewer cards; each one still knows which
 * row and column it came from, so the two screenshots can be paired up.
 */
export function detectCards(image) {
  const { width, height } = image;
  const plate = new Uint8Array(width * height);
  const rowCount = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isPlate(image.data[i], image.data[i + 1], image.data[i + 2])) { plate[y * width + x] = 1; count++; }
    }
    rowCount[y] = count;
  }
  const bands = runs(rowCount, width * 0.12, Math.round(height * 0.006))
    .filter(([y0, y1]) => y1 - y0 >= height * 0.06);
  const cards = [];
  for (const [y0, y1] of bands) {
    const colCount = new Int32Array(width);
    for (let y = y0; y <= y1; y++) for (let x = 0; x < width; x++) colCount[x] += plate[y * width + x];
    // The gap that closes must be wide enough to bridge the Moves tab's own
    // tint seam inside one card (a few pixels) and narrow enough to leave the
    // gutter between the two cards of a row open (about 3% of the screen).
    const columns = runs(colCount, (y1 - y0) * 0.25, Math.round(width * 0.012))
      .filter(([x0, x1]) => x1 - x0 >= width * 0.2);
    if (!columns.length) continue;
    for (const [x0, x1] of columns) cards.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  if (!cards.length) return [];
  // A team of one is still a team; a picture that is not the team screen is
  // thrown out further on, by whether its cards read as one tab or the other.
  // Cards are laid out on a grid: name each one by which band and which
  // column it sits in, so a half-empty team still lines up between the tabs.
  const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const midWidth = median(cards.map((c) => c.w));
  for (const card of cards) {
    card.scale = card.w / CARD_W;
    card.odd = Math.abs(card.w - midWidth) > midWidth * 0.08 || Math.abs(card.h / card.w - CARD_H / CARD_W) > 0.12;
  }
  // Which band a card sits in is counted over the cards alone.  The banner that
  // carries the team's name is a plate of the same colour, and on a wide screen
  // it is deep enough to pass for a band, which used to push the whole team one
  // row down: the first Pokemon was filed as slot 3.
  const team = cards.filter((card) => !card.odd);
  const bandTops = [...new Set(team.map((c) => c.y))].sort((a, b) => a - b);
  for (const card of team) {
    card.row = bandTops.indexOf(card.y);
    card.col = card.x < width / 2 ? 0 : 1;
    card.slot = card.row * 2 + card.col;
  }
  team.sort((a, b) => a.slot - b.slot);
  return team;
}

/** A card resampled to the canonical 421x109 box, as an "ink" map: 0 for the
 *  plate behind the text, 1 for the white of the glyphs, with the antialiasing
 *  in between.  Grey rather than a hard threshold, because at a lower capture
 *  resolution a stroke may never reach full white. */
const PLATE_GAP = 32;
function inkMap(image, card) {
  const low = new Float32Array(CARD_W * CARD_H);
  const rgb = [0, 0, 0];
  for (let y = 0; y < CARD_H; y++) {
    for (let x = 0; x < CARD_W; x++) {
      sample(image, card.x + (x + 0.5) * card.w / CARD_W, card.y + (y + 0.5) * card.h / CARD_H, rgb);
      low[y * CARD_W + x] = Math.min(rgb[0], rgb[1], rgb[2]);
    }
  }
  // Two cut-offs, and a mark has to clear both.  The fixed one (155) is the
  // card body; it is what keeps the faint seam where the heading band meets the
  // body from reading as writing.  The second is the line's own plate, because
  // the heading band is lighter than the body and the same word printed on it
  // crosses a fixed cut-off a pixel early on each side -- which is why the top
  // move line used to come out in fatter strokes than the other three and match
  // the atlas worst of the four.
  const ink = new Float32Array(CARD_W * CARD_H);
  const line = new Float32Array(CARD_W);
  for (let y = 0; y < CARD_H; y++) {
    for (let x = 0; x < CARD_W; x++) line[x] = low[y * CARD_W + x];
    const plate = line.slice().sort()[CARD_W >> 1];
    for (let x = 0; x < CARD_W; x++) {
      const value = low[y * CARD_W + x];
      const here = Math.min(value - 155, value - plate - PLATE_GAP);
      ink[y * CARD_W + x] = Math.max(0, Math.min(1, here / 75));
    }
  }
  return ink;
}

/** The card's own colours, resampled the same way, for the badges and bars. */
function colourMap(image, card) {
  const out = new Uint8ClampedArray(CARD_W * CARD_H * 3);
  const rgb = [0, 0, 0];
  for (let y = 0; y < CARD_H; y++) {
    for (let x = 0; x < CARD_W; x++) {
      sample(image, card.x + (x + 0.5) * card.w / CARD_W, card.y + (y + 0.5) * card.h / CARD_H, rgb);
      const i = (y * CARD_W + x) * 3;
      out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2];
    }
  }
  return out;
}

export function cropCard(image, card) {
  return { ink: inkMap(image, card), colour: colourMap(image, card), slot: card.slot, scale: card.scale };
}

/** Column ink totals over a band, used for finding where text starts and ends. */
function columnInk(ink, top, height, x0, x1) {
  const out = new Float32Array(x1 - x0);
  for (let y = top; y < top + height; y++) {
    if (y < 0 || y >= CARD_H) continue;
    for (let x = x0; x < x1; x++) out[x - x0] += ink[y * CARD_W + x];
  }
  return out;
}

function inkRuns(ink, top, height, x0, x1, gap = 0, min = 0.6) {
  return runs(columnInk(ink, top, height, x0, x1), min, gap).map(([a, b]) => [a + x0, b + x0]);
}

/** Where one letter stops and the next starts. Higher than the threshold used to
 *  find a number, because letters have to come apart and digits only have to be
 *  found: at 1.2 the six cards' text splits a little too eagerly about as often
 *  as a little too late, which is what the alignment below is built to absorb. */
const LETTER_INK = 1.2;

export { CARD_W, CARD_H, STAT_ROW_TOP, MOVE_ROW_TOP, STAT_COLUMNS, ABILITY_X, ITEM_X, MOVE_TEXT_X, MOVE_ICON_X, BADGE_SLOTS, BADGE_Y, inkRuns, columnInk, STAT_KEYS, NATURE_CODES, STAT_CELLS, MIN_CARD_SCALE };

// --- the glyph atlas ----------------------------------------------------------------
//
// The game's own text, lifted out of a 1080x810 capture of the two tabs and
// averaged over every sample of each character, stored as 0-255 ink.  There is
// no font file and no OCR engine here: this IS the reader's alphabet.

/** Digits sit on a fixed 7px grid: stat values are right-aligned, points left-aligned. */
const DIGIT_PITCH = 7;
const DIGIT_W = 9;
const GLYPH_H = 15;
const DIGITS_B64 = "AAAAAAAAAAAAAAAFIjgtDQAAAAI3eYODVgkAAxVybThXgjIADDd9MQEUd1oFEU57GQAGZ24NEld3EwADXXUUEVl3EgADXXgXEFJ4FQAFY3YUDEF7IAAJbmkNBid+SQwrgE4EAghki3SFgiIBAAAXYH1xNQIAAAAABxQNAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAEXLRYAAAAAAAJCjW0LAAACAAAdgYUXAAAEAAADWHwYAAAMAAACTXoZAAAQAAACTXoYAAARAAACTXoYAAAQAAABTHkYAAAQAAABS3gXAAAPAAACTHkYAAAIAAABP2kVAAAHAAAAECcGAAACAAAAAAEAAAAAAAAAAAAAAAAAAAAAAgUDAAAAAQAYUGRdLwMAAgEpV15/fyYAAQAEBQY1h0wDAQAAAAAYflQHAQAAAAArhUEGAgAAAAllfh0EAwAAA0mHRQIEBgAALoBbBgACBgAVdXYcAAABAwVerIA9IQgAABR7rJmIdCkAAAMlOzk2KgcAAAAAAAAAAAAAAAAAAAAAAAAAAAABBgQBAAAAAAc9YWZFCQAAAAg5TnCNPAAAAQABAx+BYwQAAwAAACB9WQMBAwAAGnKYPgABBAABPJ2oPwACBQAACUKHaAcCAwAAAARWgBgBAgAAAAJThRwBAgYUEzGFehEBAC1wgo6IOAEFAAk5VksiAgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGCQAAAAAAAAdRSgUAAQAAAS6TcQcABQAABmGdbgYACgABJ3aMZAYADgAHWWJvXwYADwEpaDZTWwYAGQ5kbzFhcxQAIy+Kh2abpDMBFhtXXmqrsDoABQACBBNjeBUAAAAAAAAZIgEAAAAAAAABAAAAAAAAAAAAAAAAAAAGGBwZCAAAAAE9gYNuLgEAAAZnjFozCQAAAQptaxYAAAAAAxGDk1IfBAAABgtfgol9NgEABQAJEjR9cA0ABAAAAANHfB8EBAAAAAA4eiIIAwAAAAlhehUCAQQoOGKRXAMAABFtkJBlEgAAAAIaKx4EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwkJAQAAAAALTW9nJgAAAAJOcVNBGAAAABlyPgMAAAAAAD1+Ow8EAAAAAV2hgG5eHwAAAnC5h2qBbwoAA22gNQo0gCcDA1h4CwAPfTwHAUB1FAEagzUGAB56XDdfhBoBAANGfYyLSgMAAAADIjorBAAAAAAAAAAAAAAAAAADBwcHBQAAABFQY2lyVxIBABVJXHWnihoBAAEHCjSPbAYAAQAAADGAOQAAAQAAAlxyEQAAAQAAGH5OAQAAAQABS4UiAAAAAgAKeGoGAAAAAQAxizcAAAABAANfehAAAAAAAAxZPQAAAAACAAIVAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABREQBAAAAAAPTm9tRwgAAwJHcVBXeTABCwhnVw0TaEwGDghhXBIXaUkJDANQimpujjgGCANMnZueoTkFBwpldEJHhVgNBhh0PAMGWHMcBBl5OAACUHQcAg5uaSkwdl4MBQI3eoCAdSMBAAAEHTU0GQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADGCkgCAAAAAE3cXVvQQQAABJqXCxJbB4CAihrJAAYajsJAS1mHAAUeVUQACJtPQ86nmsVAA1dfG2Fr2oWAQAhV2l5lVQTAQAABRA+fD4PAQAAAAdLeiEFAAEfRGOCUQUBAAM2b3VMCgAAAAAEEAsCAAAAAAAAAAAAAAAA";

/** One pass of a separable 1-2-1 blur over a w x GLYPH_H template. */
function soften(source, w) {
  const mid = new Float32Array(source.length), out = new Float32Array(source.length);
  for (let y = 0; y < GLYPH_H; y++) for (let x = 0; x < w; x++) {
    const a = source[y * w + Math.max(0, x - 1)], b = source[y * w + x], c = source[y * w + Math.min(w - 1, x + 1)];
    mid[y * w + x] = (a + 2 * b + c) / 4;
  }
  for (let y = 0; y < GLYPH_H; y++) for (let x = 0; x < w; x++) {
    const a = mid[Math.max(0, y - 1) * w + x], b = mid[y * w + x], c = mid[Math.min(GLYPH_H - 1, y + 1) * w + x];
    out[y * w + x] = (a + 2 * b + c) / 4;
  }
  return out;
}

/** A template and the same template seen through a smaller capture. The atlas
 *  was lifted from a full-size screenshot; a phone that records fewer pixels
 *  hands the reader the same glyph with its strokes smeared, and a sharp
 *  template is a poor filter for a smeared mark. Each template therefore
 *  carries two softer copies of itself and a mark is scored against whichever
 *  of the three it fits best, which is matching at the capture's own sharpness
 *  rather than assuming one. */
function blurLevels(source, w) {
  const once = soften(source, w);
  return [source, once, soften(once, w)];
}

function unpack(b64, count, w, h) {
  const binary = atob(b64);
  const out = [];
  for (let i = 0; i < count; i++) {
    const patch = new Float32Array(w * h);
    for (let j = 0; j < w * h; j++) patch[j] = binary.charCodeAt(i * w * h + j) / 255;
    out.push(patch);
  }
  return out;
}

const DIGITS = unpack(DIGITS_B64, 10, DIGIT_W, GLYPH_H);
const DIGIT_LEVELS = DIGITS.map((digit) => blurLevels(digit, DIGIT_W));

/** How alike two ink patches are, 0..1 (cosine similarity: brightness-blind, so
 *  a thinner stroke in a smaller capture still matches). */
function similarity(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  if (aa < 1e-6 || bb < 1e-6) return 0;
  return ab / Math.sqrt(aa * bb);
}

function patch(ink, x0, y0, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= CARD_H) continue;
    for (let x = 0; x < w; x++) {
      const sx = x0 + x;
      if (sx < 0 || sx >= CARD_W) continue;
      out[y * w + x] = ink[sy * CARD_W + sx];
    }
  }
  return out;
}

/** Best digit for one grid cell, with the gap to the runner-up.
 *
 *  The cell is tried at every offset within +-2 (a capture at another
 *  resolution is squeezed back into the canonical card, so the 7px grid lands a
 *  pixel or two off), but all ten digits are always scored against the SAME
 *  offset and the offset the mark fits best is the one that answers.  Letting
 *  each digit hunt for its own alignment gave every one of them its best view
 *  of the mark, which is how a 6 and an 8 came to score alike. */
function matchDigit(ink, x0, y0) {
  let ranked = null;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const mark = patch(ink, x0 + dx, y0 + dy, DIGIT_W, GLYPH_H);
    const scores = [];
    for (let d = 0; d < 10; d++) {
      let score = -1;
      for (const level of DIGIT_LEVELS[d]) score = Math.max(score, similarity(mark, level));
      scores.push({ digit: d, score });
    }
    scores.sort((a, b) => b.score - a.score);
    if (!ranked || scores[0].score > ranked[0].score) ranked = scores;
  }
  return { digit: ranked[0].digit, score: ranked[0].score, margin: ranked[0].score - ranked[1].score, ranked };
}

/**
 * One printed number. Stat values are right-aligned on the 7px grid and the
 * points left-aligned, so the digit count comes from where the ink starts and
 * every digit then has its own cell.
 */
function readNumber(ink, rowTop, x0, x1, anchor, align) {
  const top = rowTop + 1;
  const found = inkRuns(ink, top, GLYPH_H, x0, x1, 2);
  if (!found.length) return null;
  const first = found[0][0], last = found[found.length - 1][1];
  const count = Math.max(1, Math.min(3, align === "right"
    ? Math.round((anchor - first) / DIGIT_PITCH)
    : Math.round((last + 1 - anchor) / DIGIT_PITCH)));
  const digits = [];
  let text = "", score = 1, margin = 1;
  for (let k = 0; k < count; k++) {
    const cell = align === "right" ? anchor - (count - k) * DIGIT_PITCH - 1 : anchor + k * DIGIT_PITCH - 1;
    const hit = matchDigit(ink, cell, top);
    digits.push(hit);
    text += String(hit.digit);
    score = Math.min(score, hit.score);
    margin = Math.min(margin, hit.margin);
  }
  // Second readings worth trying if the first one turns out to be impossible:
  // one doubtful digit swapped for its runner-up, dearest first.  The 66-point
  // total and the base-stat solve are strict enough to say which one was right.
  const options = [];
  digits.forEach((hit, k) => {
    for (const other of hit.ranked.slice(1, 3)) {
      if (hit.score - other.score > 0.2) break;
      const swapped = `${text.slice(0, k)}${other.digit}${text.slice(k + 1)}`;
      options.push({ value: Number(swapped), loss: hit.score - other.score });
    }
  });
  options.sort((a, b) => a.loss - b.loss);
  return { value: Number(text), score, margin, options: options.map((row) => row.value) };
}

// --- the Stats tab ------------------------------------------------------------------

/** The nature arrows: a warm pink one over the raised stat, a cold blue one
 *  under the lowered stat, printed right after the stat's name. */
function arrowAt(colour, rowTop, x0, x1) {
  let up = 0, down = 0;
  for (let y = rowTop + 1; y < rowTop + GLYPH_H; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * CARD_W + x) * 3;
      const r = colour[i], g = colour[i + 1], b = colour[i + 2];
      if (r > 150 && r > g + 30 && b > g + 10) up++;
      else if (b > 150 && b > r + 30 && g > r + 8) down++;
    }
  }
  if (up >= 6 && up > down) return 1;
  if (down >= 6 && down > up) return -1;
  return 0;
}

/** The little progress bar between the value and the points: its orange part is
 *  the points out of 32. Only ever used to sanity-check the digits. */
function barFraction(colour, rowTop, x0, x1) {
  let filled = 0, track = 0;
  for (let x = x0; x < x1; x++) {
    let isFill = false, isTrack = false;
    for (let y = rowTop + 6; y <= rowTop + 10; y++) {
      const i = (y * CARD_W + x) * 3;
      const r = colour[i], g = colour[i + 1], b = colour[i + 2];
      if (r > 150 && g > 85 && b < 120) isFill = true;
      else if (r < 115 && g < 110 && b > 80 && b < 175) isTrack = true;
    }
    if (isFill) { filled++; track++; }
    else if (isTrack) track++;
  }
  return track < (x1 - x0) * 0.5 ? null : filled / track;
}

/** Does this card come from the Stats tab? All six rows carry that bar. */
export function statsBarCount(colour) {
  let count = 0;
  for (const [row, col] of STAT_CELLS) {
    const cfg = STAT_COLUMNS[col];
    if (barFraction(colour, STAT_ROW_TOP[row], cfg.bar[0], cfg.bar[1]) !== null) count++;
  }
  return count;
}

export function readStatsCard(card) {
  const { ink, colour } = card;
  const finals = [], points = [], notes = [], variants = [];
  let boost = 0, drop = 0, weakest = 1;
  for (let s = 0; s < 6; s++) {
    const [row, col] = STAT_CELLS[s];
    const top = STAT_ROW_TOP[row];
    const cfg = STAT_COLUMNS[col];
    const value = readNumber(ink, top, cfg.value[0], cfg.value[1], cfg.valueRight, "right");
    const bonus = readNumber(ink, top, cfg.points[0], cfg.points[1], cfg.pointLeft, "left");
    if (!value || !bonus) return { error: MESSAGES.badSpread };
    finals.push(value.value);
    points.push(bonus.value);
    for (const other of value.options) variants.push({ field: "finals", index: s, value: other });
    for (const other of bonus.options) variants.push({ field: "points", index: s, value: other });
    weakest = Math.min(weakest, value.score, bonus.score);
    const arrow = arrowAt(colour, top, cfg.label[0], cfg.label[1]);
    if (arrow > 0 && s > 0) boost = s;
    if (arrow < 0 && s > 0) drop = s;
    // The bar is the same number said a second way; it is coarse (28px for 32
    // points), so it only ever raises a doubt, never overrides a digit.
    const fraction = barFraction(colour, top, cfg.bar[0], cfg.bar[1]);
    if (fraction !== null && Math.abs(fraction * MAX_BONUS_POINTS_PER_STAT - bonus.value) > 6) {
      notes.push(`the ${SLOT_STATS[s]} points may not be right`);
    }
  }
  const total = points.reduce((a, b) => a + b, 0);
  return { finals, points, boost, drop, total, notes, variants, score: weakest, checksum: total === MAX_BONUS_STAT_POINTS };
}

// --- type badges --------------------------------------------------------------------
//
// The game's type badges are the site's own 18 type icons: a prior run matched
// every header badge and every move icon against them. Each is kept here as a
// 10x10 colour thumbnail with the shared rounded-square mask, so no icon has to
// be fetched and the guard suite sees exactly what the browser sees.

const TYPE_NAMES = "Bug,Dark,Dragon,Electric,Fairy,Fighting,Fire,Flying,Ghost,Grass,Ground,Ice,Normal,Poison,Psychic,Rock,Steel,Water";
const TYPE_SIGNATURES_B64 = "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5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp7mxt73N05igp5igp5igp5igp5igp5igp5igp5igp9aep9aan5zEy5igp5igp5igp5igp5igp5igp8YaG+9/f+c/R73V25igp5igp5igp5igp5igp5igp97e37mdn//39/vPz5zAx5igp5igp5igp5igp5igp8YWD5ikp8o6O/vb35zAx5igp5igp5igp5igp5igp6Dk65y4v7m5u7Fpc5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igp5igpgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgrjvkcHxs9X2qM/0gbnvgbnvgbnvgbnvgbnvncny7/b9////5fH8ir7wgbnvgbnvgbnvgbnvgLjv5vH8+vz+2ur6rND0gbnvgbnvgbnvgbnvgbnvkMHx////7fX9yeD4grrvgbnvgbnvgbnvgbnvgbnvqtD04O77utj2jsDxgLnvgbnvgbnvgbnvgbnvgbnvpcz1iLzxgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvgbnvcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwf1R/gVeBcEFwcEFwcEFwcEFwcEFwcEFwcEFwmHSY7eft8evxqYupcEFwcEFwcEFwcEFwcEFwcUJx0sLSxrPGw67D5NvkcUNxcEFwcEFwcEFwcEFwuKC4/fz9/////////vz+zLvMcEFwcEFwcEFwcEFwckNyjmeO8evx+fb5lXCVd0t3cEFwcEFwcEFwcEFwcEFwcEFwg1mDhl2GcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwcEFwP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpRKMuQKEpP6EpP6EpP6EpP6EpP6EpP6EpP6EpR6Qxnc+QQKEpRaMvP6EpP6EpP6EpP6EpP6EpaLVVhcN12ezTV6xBfsBvP6EpP6EpP6EpP6EpQKEpyeTCoM+Uv9+2xOK8a7ZZP6EpP6EpP6EpP6EpX7BL/v7+pdKZlsuJ////Tqg4P6EpP6EpP6EpP6EppNKY/P78YrFNz+fJ6vXoQKEpP6EpP6EpP6EpP6EpVKs/Wa1EP6EpW65HVKs/P6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpP6EpkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhlFUmtotrklEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhlVYow6CHnWM4kFEgy62WllgqkVEhkVEhkVEhkVEhkVEhkFEhroVkn2xDkVEhkVEikVEhkVEhkVEhkVEho2xE4c/D/v7+////6dzTrHpVkVEhkVEhkVEhkVEhqndRyKeM697V7+TbyquSsoJgkVEhkVEhkVEhkVEhk1MkroBduI9wuY9xsoZllVYokVEhkVEhkVEhkVEhkVEhkVEhkFEhkFEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhkVEhP9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/aeD/b+H/P9j/P9j/P9j/P9j/P9j/P9j/VN3/huj/g+f/j+n/dOT/Y+D/P9j/P9j/P9j/P9j/Sdr/muv/pu7//v//s/D/T9v/P9j/P9j/P9j/P9j/RNn/kun/3fj/////r+//R9n/P9j/P9j/P9j/P9j/Wt7/nez/muv/pO3/i+j/buL/P9j/P9j/P9j/P9j/P9j/P9j/cuL/eOT/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/P9j/n6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfq6yr0NHQzMzMzs7OztDOs7Ozn6Gfn6Gfn6Gfn6GfxcXF9PT0u7u7uLi47Ozs1tXWn6Gfn6Gfn6Gfn6GfzMzMuru6n6Gfn6Gfqquq2tran6Gfn6Gfn6Gfn6Gfz9DPt7i3n6Gfn6Gfp6in3N3cn6Gfn6Gfn6Gfn6GfsLGw6Ofoqqmqp6an397fvL28n6Gfn6Gfn6Gfn6Gfn6GftLa029zb3d7dvL68n6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6Gfn6GfkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLqmzYt4LekUHLkUHLkUHLkUHLkUHLkUHLkUHLkEDL7N72////lUjOkUHMkUHLkUHLkUHLkUHLkUHLkUHLqWzXtoDcrHLaz63qkUHLkUHLkUHLkUHLkUHLkUHLkUHLmVHQpGPUqWrYkUHLkUHLkUHLkUHLkUHLl03PtX7d6tv28ej5t4Lem1TSkUHLkUHLkUHLkUHLpmTWyqTm07Tr07TszKfnrXDZkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHLkUHL70F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F583Se9Hyl70F570F570F570F570F570F58VWI+bbN+sTW+sLU+r3R8mSS70F570F570F570F58mSS+r7S70J670F596G89H+l70F570F570F570F58mGP+bfN70F570F59pi29Hui70F570F570F570F58V6O+9Lh+K7G+KfB/NXj83Kc70F570F570F570F570F570F59Yit9pS170F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F570F5r6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBvriY3NjH29fGwr6gr6mBr6mBr6mBr6mBr6mBvriY+vn3////////3dnIv7qar6mBr6mBr6mBr6mB3NjH////////////////5OPVr6mBr6mBr6mBr6mB0Mu19fTv////////+vr419TAr6mBr6mBr6mBr6mBwryevLaW9/by+vr4wr2gxL6gr6mBr6mBr6mBr6mBr6mBv7iX1tO+19TAxL6gr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBr6mBYKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4hrfJosjVp8vYkr7PYKG4YKG4YKG4YKG4YKG4YqK43evv1+fsmcHQpsrXbKe8YKG4YKG4YKG4YKG4hrfI////2+rwt9Ters/cmsPSYKG4YKG4YKG4YKG4iLnKsdHdu9bgmsPQ////u9bgYKG4YKG4YKG4YKG4YqK4rc7Z/f7+oMfUutXfZaS6YKG4YKG4YKG4YKG4YKG4YKG4h7fJhbfJYKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4YKG4KYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvRZHxSZTyKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvhLf2lMD3KYDvKYDvKYDvKYDvKYDvKYDvKYDvMobw5O798vf+Q5DxKYDvKYDvKYDvKYDvKYDvKYDvf7T2////////o8n4KYDvKYDvKYDvKYDvKYDvKYDvda71ibn2ibn2h7j2KYDvKYDvKYDvKYDvKYDvKYDvLILvdKz1eK/1NIfwKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDvKYDv";
const TYPE_MASK = [0,0,0.23,0.72,0.95,0.96,0.77,0.31,0,0,0,0.37,0.98,1,1,1,1,1,0.51,0,0.23,0.98,1,1,1,1,1,1,1,0.32,0.73,1,1,1,1,1,1,1,1,0.76,0.96,1,1,1,1,1,1,1,1,0.96,0.97,1,1,1,1,1,1,1,1,0.97,0.78,1,1,1,1,1,1,1,1,0.81,0.31,1,1,1,1,1,1,1,1,0.41,0,0.51,1,1,1,1,1,1,0.67,0.01,0,0,0.33,0.76,0.96,0.97,0.81,0.41,0.01,0];

const TYPES = TYPE_NAMES.split(",");
const TYPE_N = 10;
const TYPE_SIGNATURES = (() => {
  const binary = atob(TYPE_SIGNATURES_B64);
  return TYPES.map((_, t) => {
    const out = new Float32Array(TYPE_N * TYPE_N * 3);
    for (let j = 0; j < out.length; j++) out[j] = binary.charCodeAt(t * out.length + j) / 255;
    return out;
  });
})();

/** A badge box out of the card, reduced to the same 10x10 colour thumbnail. */
function badgeThumb(colour, box) {
  const [x0, y0, x1, y1] = box;
  const out = new Float32Array(TYPE_N * TYPE_N * 3);
  for (let y = 0; y < TYPE_N; y++) {
    for (let x = 0; x < TYPE_N; x++) {
      const sx0 = x0 + Math.floor(x * (x1 - x0) / TYPE_N), sx1 = Math.max(sx0 + 1, x0 + Math.floor((x + 1) * (x1 - x0) / TYPE_N));
      const sy0 = y0 + Math.floor(y * (y1 - y0) / TYPE_N), sy1 = Math.max(sy0 + 1, y0 + Math.floor((y + 1) * (y1 - y0) / TYPE_N));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const i = (sy * CARD_W + sx) * 3;
        r += colour[i]; g += colour[i + 1]; b += colour[i + 2]; n++;
      }
      const j = (y * TYPE_N + x) * 3;
      out[j] = r / n / 255; out[j + 1] = g / n / 255; out[j + 2] = b / n / 255;
    }
  }
  return out;
}

/** Which of the eighteen types this badge is, and how far ahead of the next. */
export function matchType(colour, box) {
  const thumb = badgeThumb(colour, box);
  const scored = TYPE_SIGNATURES.map((signature, t) => {
    // Mean-centred correlation: plain cosine over colours that are all bright
    // and all positive scores 0.95 for every pair and tells nothing apart.
    const kept = [];
    for (let cell = 0; cell < TYPE_N * TYPE_N; cell++) if (TYPE_MASK[cell] >= 0.9) kept.push(cell);
    let ma = 0, mb = 0;
    for (const cell of kept) for (let c = 0; c < 3; c++) { ma += thumb[cell * 3 + c]; mb += signature[cell * 3 + c]; }
    ma /= kept.length * 3; mb /= kept.length * 3;
    let ab = 0, aa = 0, bb = 0;
    for (const cell of kept) for (let c = 0; c < 3; c++) {
      const a = thumb[cell * 3 + c] - ma, b = signature[cell * 3 + c] - mb;
      ab += a * b; aa += a * a; bb += b * b;
    }
    return { type: TYPES[t], score: ab / Math.sqrt(aa * bb || 1e-9) };
  }).sort((a, b) => b.score - a.score);
  return { type: scored[0].type, score: scored[0].score, margin: scored[0].score - scored[1].score, ranked: scored };
}

/** The two type badges in a card's heading. Slot 1 is the gender mark (empty for
 *  a genderless Pokemon), slot 2 the first type and slot 3 the second if there
 *  is one. Both are returned as rankings rather than answers: the badges only
 *  ever break a tie between forms the stats could not tell apart, so what
 *  matters is which candidate the picture prefers, not an absolute verdict.
 *  Whether a slot holds a badge at all is decided against the plate colour in
 *  the gap beside it, because a Normal badge is pale and nearly featureless. */
export function headingBadges(colour) {
  const plate = [0, 0, 0];
  let n = 0;
  for (let y = 9; y < 20; y++) for (let x = 215; x < 221; x++) {
    const i = (y * CARD_W + x) * 3;
    plate[0] += colour[i]; plate[1] += colour[i + 1]; plate[2] += colour[i + 2]; n++;
  }
  for (let c = 0; c < 3; c++) plate[c] /= n;
  const out = [];
  for (const slot of [1, 2]) {
    const [x0, x1] = BADGE_SLOTS[slot];
    let far = 0, total = 0;
    for (let y = 9; y < 20; y++) for (let x = x0 + 2; x < x1 - 2; x++) {
      const i = (y * CARD_W + x) * 3;
      if (Math.abs(colour[i] - plate[0]) + Math.abs(colour[i + 1] - plate[1]) + Math.abs(colour[i + 2] - plate[2]) > 60) far++;
      total++;
    }
    const filled = far / total > 0.3;
    const hit = matchType(colour, [x0, BADGE_Y[0], x1, BADGE_Y[1]]);
    out.push({ filled, ranked: hit.ranked, rank: (type) => hit.ranked.findIndex((row) => row.type === type) });
  }
  return out;
}

// --- letters ------------------------------------------------------------------------
//
// The same treatment for the game's text: every character the example
// screenshots draw, aligned and averaged over all of its samples. Eight letters
// (J Q X Y Z j q x) never appear in them and have no template; a candidate
// name that uses one is still matched on its other letters and on its shape,
// but it is held to a higher bar before the reader calls it certain.
const GLYPH_CHARS = "UnburdeGasySPotcDiClwmRkpKgh-EFOMWHLfIBNTz.AVv";
const GLYPH_WIDTHS = [5,7,8,7,4,8,7,11,7,5,6,7,11,8,5,6,9,4,8,4,9,10,8,6,8,8,8,7,8,5,7,11,12,19,4,4,4,4,8,6,5,5,5,8,8,6];
const GLYPHS_B64 = "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";

const GLYPHS = (() => {
  const binary = atob(GLYPHS_B64);
  const map = new Map();
  let at = 0;
  [...GLYPH_CHARS].forEach((ch, index) => {
    const w = GLYPH_WIDTHS[index];
    const data = new Float32Array(w * GLYPH_H);
    for (let j = 0; j < data.length; j++) data[j] = binary.charCodeAt(at + j) / 255;
    at += data.length;
    map.set(ch, { w, data });
  });
  return map;
})();

/** How well a candidate character explains a box of ink, 0 (perfect) upwards.
 *  A character with no template costs a flat amount: it neither helps nor
 *  sinks the candidate it belongs to. */
const NO_TEMPLATE_COST = 0.45;

function stretch(source, from, to) {
  if (from === to) return source;
  const out = new Float32Array(to * GLYPH_H);
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < to; x++) {
      const fx = x * from / to;
      const i = Math.min(from - 1, Math.floor(fx)), t = fx - i, j = Math.min(from - 1, i + 1);
      out[y * to + x] = source[y * from + i] * (1 - t) + source[y * from + j] * t;
    }
  }
  return out;
}

function charCost(ch, ink, x0, w, top, cache) {
  const glyph = GLYPHS.get(ch);
  if (!glyph) return NO_TEMPLATE_COST;
  // One line is matched against every candidate name in turn and they keep
  // asking about the same letter over the same marks, so the answers are kept.
  const key = `${ch}|${x0}|${w}`;
  const known = cache?.get(key);
  if (known !== undefined) return known;
  let best = 0;
  for (let dy = -1; dy <= 1; dy++) {
    best = Math.max(best, similarity(stretch(patch(ink, x0 - 1, top + dy, w + 2, GLYPH_H), w + 2, glyph.w), glyph.data));
  }
  const cost = 1 - best + 0.06 * Math.abs(w + 2 - glyph.w);
  cache?.set(key, cost);
  return cost;
}

/**
 * The ways one run of ink can be shared between k letters.
 *
 * An even split is what k copies of one letter would want.  Real letters differ
 * in width and meet at a thin join, so the run is also cut at its own thinnest
 * columns and the alignment keeps whichever of the two reads better.  It
 * matters most on the top move line, where the game prints over its lighter
 * heading band in slightly fatter strokes and neighbouring letters touch.
 */
function runParts(ink, top, a, b, k, cache) {
  const key = `runParts|${a}|${b}|${k}`;
  const known = cache?.get(key);
  if (known !== undefined) return known;
  const width = b - a + 1;
  const even = [];
  for (let q = 0; q < k; q++) even.push([a + Math.round(q * width / k), a + Math.round((q + 1) * width / k) - 1]);
  const out = [even];
  const MIN_PART = 3;
  const sums = columnInk(ink, top, GLYPH_H, a, b + 1);
  const cuts = [];
  for (let c = 1; c < k; c++) {
    let at = -1, thinnest = Infinity;
    for (let x = a + MIN_PART; x <= b - MIN_PART + 1; x++) {
      if (cuts.some((cut) => Math.abs(cut - x) < MIN_PART)) continue;
      if (sums[x - a] < thinnest) { thinnest = sums[x - a]; at = x; }
    }
    if (at < 0) { cuts.length = 0; break; }
    cuts.push(at);
  }
  if (cuts.length === k - 1) {
    cuts.sort((p, q) => p - q);
    const thin = [];
    let start = a;
    for (const cut of cuts) { thin.push([start, cut - 1]); start = cut; }
    thin.push([start, b]);
    if (thin.some(([x0, x1], q) => x1 - x0 + 1 !== even[q][1] - even[q][0] + 1)) out.push(thin);
  }
  cache?.set(key, out);
  return out;
}

/**
 * Align one candidate name to a line of the card and say how well it fits.
 *
 * The game's text is too small for its letters to come apart cleanly: at the
 * threshold where most letters separate, some still run together and some
 * single letters break in two.  So the reader never decides "what does this
 * say"; it asks "how well does THIS name explain these marks", and the caller
 * only ever asks about the handful of names that are possible at all.  The
 * alignment walks the ink runs and the candidate's letters together, letting
 * one letter cover up to four runs and one run hold up to four letters, and
 * pays for every departure from one letter per run.
 */
export function fitText(ink, top, x0, x1, text, found = inkRuns(ink, top + 1, GLYPH_H, x0, x1, 0, LETTER_INK), cache = null) {
  const chars = [...text];
  if (!found.length || !chars.length) return { score: 0, unknown: chars.length };
  const n = chars.length, m = found.length;
  const letters = chars.filter((ch) => ch !== " ").length;
  // The walk below lets one letter cover at most four runs and one run hold at
  // most four letters, so a name far outside that range cannot be laid over
  // these marks at all and is dropped before the walk starts.
  if (letters * 4 < m || m * 4 < letters) return { score: 0, unknown: 0 };
  const INF = 1e9;
  const cost = [];
  for (let i = 0; i <= n; i++) cost.push(new Float64Array(m + 1).fill(INF));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = cost[i][j];
      if (here >= INF || i === n) continue;
      if (chars[i] === " ") {
        // A space consumes no ink; it only asks for a wider gap at that point.
        const gap = j > 0 && j < m ? found[j][0] - found[j - 1][1] - 1 : 4;
        cost[i + 1][j] = Math.min(cost[i + 1][j], here + (gap >= 3 ? 0 : 0.6));
        continue;
      }
      for (let k = 1; k <= 4 && j + k <= m; k++) {
        const a = found[j][0], b = found[j + k - 1][1];
        const next = here + charCost(chars[i], ink, a, b - a + 1, top + 1, cache) + (k - 1) * 0.2;
        if (next < cost[i + 1][j + k]) cost[i + 1][j + k] = next;
      }
      if (j < m) {
        const width = found[j][1] - found[j][0] + 1;
        for (let k = 2; k <= 4 && i + k <= n; k++) {
          if (width < 4 * k - 2) break;
          // A space is not drawn, so it can never be one of the letters sharing
          // a single run.
          if (chars.slice(i, i + k).includes(" ")) break;
          for (const parts of runParts(ink, top + 1, found[j][0], found[j][1], k, cache)) {
            let next = here + (k - 1) * 0.2;
            for (const [q, part] of parts.entries()) next += charCost(chars[i + q], ink, part[0], part[1] - part[0] + 1, top + 1, cache);
            if (next < cost[i + k][j + 1]) cost[i + k][j + 1] = next;
          }
        }
      }
    }
  }
  const total = cost[n][m];
  const unknown = chars.filter((ch) => ch !== " " && !GLYPHS.has(ch)).length;
  if (total >= INF) return { score: 0, unknown };
  return { score: Math.max(0, 1 - total / chars.length), unknown };
}

/** The candidates ranked by how well each explains the line, best first. */
export function readText(ink, top, x0, x1, candidates) {
  const found = inkRuns(ink, top + 1, GLYPH_H, x0, x1, 0, LETTER_INK);
  const cache = new Map();
  return candidates
    .map((text) => ({ text, ...fitText(ink, top, x0, x1, text, found, cache) }))
    .sort((a, b) => b.score - a.score);
}

// --- from numbers to a Pokemon --------------------------------------------------------

/** The nature the two arrows name. No arrows means a neutral nature, and the
 *  game draws all five of those the same way, so the set gets the builder's own. */
function natureFor(data, boost, drop) {
  if (!boost && !drop) return "Serious";
  const wantUp = NATURE_CODES[boost] || "";
  const wantDown = NATURE_CODES[drop] || "";
  for (const [name, [up, down]] of Object.entries(data.natures || {})) {
    if (up === wantUp && down === wantDown) return name;
  }
  return "Serious";
}

/** Every form whose base stats, plus the points on screen and that nature,
 *  give exactly the six values on screen. The arithmetic is the engine's own
 *  (builder/engine.js finalStats), run forwards over each form rather than
 *  inverted, so the two can never drift apart. */
export function formsMatching(data, finals, points, boost, drop) {
  const out = [];
  for (const row of data.forms) {
    // A Mega Stone holder's card shows the stats of the form it is standing
    // there as, never the Mega's, so a Mega form is never the answer.
    if (row.kind === "Mega") continue;
    let ok = true;
    for (let i = 0; i < 6 && ok; i++) {
      let value = Math.trunc(Number(row.stats?.[STAT_KEYS[i]] ?? 70)) + points[i];
      if (i > 0 && i === boost) value = Math.floor(value * 1.1);
      else if (i > 0 && i === drop) value = Math.floor(value * 0.9);
      ok = Math.max(1, value) === finals[i];
    }
    if (ok) out.push(row);
  }
  return out;
}

/**
 * Which Pokemon the card is. The stats do almost all of it: 333 of the 358
 * forms have a sextuple no other form shares. What is left over is either two
 * spellings of the same Pokemon (one Showdown name, so nothing to choose) or a
 * group the heading's type badges separate — the five Rotom appliances, the
 * three Simi- monkeys, Charizard against Typhlosion.
 */
export function solveCard(data, reading, badges) {
  const nature = natureFor(data, reading.boost, reading.drop);
  const matches = formsMatching(data, reading.finals, reading.points, reading.boost, reading.drop);
  if (!matches.length) return { nature, matches: [], identity: null };
  const identities = new Map();
  for (const row of matches) {
    const name = data.displayName(row.species, row.form);
    if (!identities.has(name)) identities.set(name, []);
    identities.get(name).push(row);
  }
  const names = [...identities.keys()];
  if (names.length === 1) return { nature, matches, identity: identities.get(names[0])[0], name: names[0] };
  // More than one Pokemon fits: ask the badges which one the heading drew.
  const cost = (row) => {
    const first = badges?.[0] ? badges[0].rank(row.types[0]) : 0;
    if (!row.types[1]) return first + (badges?.[1]?.filled ? 30 : 0);
    return first + (badges?.[1]?.filled ? badges[1].rank(row.types[1]) : 30);
  };
  const ranked = names.map((name) => ({ name, row: identities.get(name)[0], cost: cost(identities.get(name)[0]) }))
    .sort((a, b) => a.cost - b.cost);
  if (ranked.length > 1 && ranked[0].cost === ranked[1].cost) {
    return { nature, matches, identity: null, choices: ranked.map((entry) => entry.name) };
  }
  return { nature, matches, identity: ranked[0].row, name: ranked[0].name, choices: ranked.map((entry) => entry.name) };
}

/** The gender mark in the heading's first slot, which is the only thing that
 *  tells a male Meowstic from a female one (their stats are the same). */
export function headingGender(colour) {
  const plate = [0, 0, 0];
  let n = 0;
  for (let y = 9; y < 20; y++) for (let x = 215; x < 221; x++) {
    const i = (y * CARD_W + x) * 3;
    plate[0] += colour[i]; plate[1] += colour[i + 1]; plate[2] += colour[i + 2]; n++;
  }
  for (let c = 0; c < 3; c++) plate[c] /= n;
  const [x0, x1] = BADGE_SLOTS[0];
  let far = 0, red = 0, blue = 0, total = 0;
  for (let y = 9; y < 20; y++) for (let x = x0 + 2; x < x1 - 2; x++) {
    const i = (y * CARD_W + x) * 3;
    const r = colour[i], g = colour[i + 1], b = colour[i + 2];
    if (Math.abs(r - plate[0]) + Math.abs(g - plate[1]) + Math.abs(b - plate[2]) > 60) far++;
    if (r > 120 && r > g + 50 && r > b + 40) red++;
    if (b > 140 && b > r + 45 && b > g + 20) blue++;
    total++;
  }
  if (far / total < 0.3) return "";
  if (red > blue) return "F";
  if (blue > red) return "M";
  return "";
}

// --- the Moves & More tab -------------------------------------------------------------

/** Anything read off the card that the reader is not sure of comes back with
 *  `sure: false`, and nothing uncertain is ever imported without being shown. */
const SURE_SCORE = 0.70;
const SURE_MARGIN = 0.06;

/**
 * True when two names differ ONLY in characters the reader has no template for.
 *
 * Then no amount of looking at the picture can separate them: every glyph they share fits the
 * same, and the ones that differ cost the same `NO_TEMPLATE_COST` on both sides. The scores come
 * out equal and the winner is decided by the order the candidates happened to arrive in, which is
 * not a reading at all.
 */
export function onlyBlindDifference(a, b) {
  const x = [...String(a)];
  const y = [...String(b)];
  if (x.length !== y.length) return false;
  let differences = 0;
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] === y[i]) continue;
    if (GLYPHS.has(x[i]) || GLYPHS.has(y[i])) return false;
    differences += 1;
  }
  return differences > 0;
}

function bestOf(ranked) {
  if (!ranked.length) return { text: "", score: 0, sure: false, choices: [] };
  const best = ranked[0];
  const margin = ranked.length > 1 ? best.score - ranked[1].score : 1;
  // The ones this reader is BLIND to, as opposed to merely unsure of: same score, and what
  // separates them is a character the glyph table does not carry. Naming them is the difference
  // between "check this" and "it is one of these two and the picture cannot say which".
  const blind = ranked
    .filter((row) => row !== best && row.score === best.score && onlyBlindDifference(best.text, row.text))
    .map((row) => row.text);
  return {
    text: best.text,
    score: best.score,
    margin,
    sure: best.score >= SURE_SCORE && margin >= SURE_MARGIN && !best.unknown && !blind.length,
    blind,
    choices: ranked.slice(0, 5).map((row) => row.text),
  };
}

/** The items this Pokemon could be holding: everything but another species' stone. */
function legalItems(data, species) {
  const stones = data.app?.megaStones || {};
  return (data.itemNames || []).filter((name) => {
    const holders = stones[name];
    return !holders || holders.some((entry) => entry.species === species);
  });
}

/** Ability, item and the four moves. The species has to be solved first: it is
 *  what cuts each list down to something a glyph reader can be trusted with. */
export function readMovesCard(data, card, identity) {
  const { ink, colour } = card;
  const abilities = data.abilities(identity.species, identity.form);
  const ability = abilities.length === 1
    ? { text: abilities[0], score: 1, margin: 1, sure: true, choices: abilities }
    : bestOf(readText(ink, MOVE_ROW_TOP[1], ABILITY_X[0], ABILITY_X[1], abilities));
  // A line with no writing on it is a Pokemon holding nothing, which is worth
  // knowing before matching the item against all 199 names.
  const holdsItem = inkRuns(ink, MOVE_ROW_TOP[2] + 1, GLYPH_H, ITEM_X[0], ITEM_X[1], 0, LETTER_INK).length > 0;
  const item = holdsItem
    ? bestOf(readText(ink, MOVE_ROW_TOP[2], ITEM_X[0], ITEM_X[1], legalItems(data, identity.species)))
    : { text: "", score: 1, margin: 1, sure: true, choices: [] };
  const learnset = data.app?.learnsets?.[`${identity.species}|${identity.form}`] || [];
  const moves = [];
  for (let k = 0; k < 4; k++) {
    const top = MOVE_ROW_TOP[k];
    if (!inkRuns(ink, top + 1, GLYPH_H, MOVE_TEXT_X[0], MOVE_TEXT_X[1], 0, LETTER_INK).length) { moves.push(null); continue; }
    const icon = matchType(colour, [MOVE_ICON_X[0], top + 1, MOVE_ICON_X[1], top + 16]);
    // The icon narrows the list but never decides it: a Normal badge is pale
    // and nearly featureless, so the right type is sometimes only second.
    const likely = icon.ranked.slice(0, 3).map((row) => row.type);
    const candidates = learnset.filter((name) => likely.includes(data.app.moves?.[name]?.type));
    moves.push(bestOf(readText(ink, top, MOVE_TEXT_X[0], MOVE_TEXT_X[1], candidates.length ? candidates : learnset)));
  }
  return { ability, item, moves };
}

// --- the two pictures together --------------------------------------------------------

/** Which tab a picture shows, from the cards themselves rather than the tab bar:
 *  every Stats card carries six little points bars and no Moves card carries any. */
export function readScreen(image) {
  const cards = detectCards(image);
  if (cards.length < 1) return { kind: "", cards: [], crops: [] };
  const crops = cards.map((card) => cropCard(image, card));
  const bars = crops.reduce((sum, crop) => sum + statsBarCount(crop.colour), 0) / crops.length;
  return { kind: bars >= 3 ? "stats" : bars <= 1 ? "moves" : "", cards, crops, bars };
}

const SLOT_STATS = ["HP", "Attack", "Defense", "Sp. Atk", "Sp. Def", "Speed"];

/**
 * Read a whole team out of the two screenshots, in either order.
 *
 * Nothing here decides to import: it returns what it read, slot by slot, with
 * every doubt attached, so the panel can show it and let the player fix it.
 */
export function readTeamScreenshots(images, data) {
  if (!Array.isArray(images) || images.length !== 2) return { error: MESSAGES.notTwo };
  const screens = images.map(readScreen);
  if (screens.some((screen) => !screen.cards.length)) return { error: MESSAGES.noCards };
  if (screens.some((screen) => screen.cards.some((card) => card.scale < MIN_CARD_SCALE))) return { error: MESSAGES.tooSmall };
  if (screens[0].kind === screens[1].kind) {
    return { error: screens[0].kind ? MESSAGES.sameTab : MESSAGES.noCards };
  }
  if (!screens[0].kind || !screens[1].kind) return { error: MESSAGES.noCards };
  const statsScreen = screens.find((screen) => screen.kind === "stats");
  const movesScreen = screens.find((screen) => screen.kind === "moves");
  const bySlot = (screen) => new Map(screen.cards.map((card, index) => [card.slot, screen.crops[index]]));
  const statsCards = bySlot(statsScreen);
  const movesCards = bySlot(movesScreen);
  const slots = [];
  const notes = [];
  for (const slot of [...statsCards.keys()].sort((a, b) => a - b)) {
    const statsCard = statsCards.get(slot);
    const movesCard = movesCards.get(slot);
    if (!movesCard) { notes.push(MESSAGES.mismatch); continue; }
    slots.push(readSlot(data, statsCard, movesCard, slot));
  }
  if (!slots.length) return { error: MESSAGES.noCards };
  const missing = [...movesCards.keys()].filter((slot) => !statsCards.has(slot));
  if (missing.length) notes.push(MESSAGES.mismatch);
  if (slots.length < 6) notes.push(`Only ${slots.length} of the six slots had a Pokémon in them, so the team was read with ${slots.length}.`);
  return { slots, notes: [...new Set(notes)], showdown: teamText(slots, data) };
}

function readSlot(data, statsCard, movesCard, slot) {
  const doubts = [];
  const reading = readStatsCard(statsCard);
  if (reading.error) return { slot, error: reading.error };
  if (!reading.checksum) doubts.push(`the stat points add up to ${reading.total}, not ${MAX_BONUS_STAT_POINTS}`);
  for (const note of reading.notes) doubts.push(note);
  const badges = headingBadges(movesCard.colour);
  let solved = solveCard(data, reading, badges);
  // Nothing fits: rather than give up, try the digits the reader was least sure
  // of one at a time.  A swap is only accepted when it both finds a Pokemon and
  // brings the points back to 66, which almost never happens by accident.
  if (!solved.identity && !solved.choices?.length) {
    for (const variant of reading.variants.slice(0, 40)) {
      const finals = [...reading.finals], points = [...reading.points];
      (variant.field === "finals" ? finals : points)[variant.index] = variant.value;
      if (points.reduce((a, b) => a + b, 0) !== MAX_BONUS_STAT_POINTS) continue;
      const retry = solveCard(data, { ...reading, finals, points }, badges);
      if (retry.identity) {
        solved = retry;
        reading.finals = finals;
        reading.points = points;
        doubts.push(`one number was hard to read; ${SLOT_STATS[variant.index]} was taken as ${variant.value}`);
        break;
      }
    }
  }
  if (!solved.identity) {
    const gender = headingGender(movesCard.colour);
    // Two Pokemon with one stat line and one type line: the male and female
    // Meowstic are only ever told apart by the heading's gender mark.
    const picked = gender && solved.choices
      ? solved.choices.filter((name) => (gender === "F" ? /-F$/.test(name) : !/-F$/.test(name)))
      : [];
    if (picked.length === 1) {
      const [species, form] = data.resolveName(picked[0]);
      solved.identity = data.formRecord(species, form) && { species, form };
      solved.name = picked[0];
    }
  }
  if (!solved.identity) {
    return {
      slot,
      error: solved.choices?.length
        ? `These stats fit more than one Pokémon (${solved.choices.join(", ")}), and the picture cannot tell them apart.`
        : "No Pokémon in the game has these stats, so this card was not read correctly.",
      finals: reading.finals, points: reading.points, doubts,
    };
  }
  // Solved by the heading rather than by the stats alone: the numbers fitted
  // more than one Pokemon and a badge broke the tie, which is worth saying.
  if (solved.choices?.length > 1) {
    doubts.push(`these stats also fit ${solved.choices.filter((name) => name !== solved.name).join(" and ")}, and the heading was used to choose`);
  }
  const read = readMovesCard(data, movesCard, solved.identity);
  const moves = read.moves.filter(Boolean);
  for (const [label, field] of [["the Ability", read.ability], ["the item", read.item]]) {
    // An empty item line is a Pokemon holding nothing, which readMovesCard
    // marks sure; an empty one that is NOT sure is a line it failed to read.
    if (!field.text && !field.sure) doubts.push(`${label} could not be read and was left empty`);
    // Told apart from "may not be right" on purpose: this one will not come good with a sharper
    // picture, so the player is told which two it is between and that only they can choose.
    else if (field.blind?.length) {
      doubts.push(`${label} is ${[field.text, ...field.blind].join(" or ")} \u2014 they are written the same`
        + " apart from one letter this reader cannot see, so please set it yourself");
    } else if (field.text && !field.sure) doubts.push(`${label} may not be right`);
  }
  // A move line with writing on it that came back empty is said out loud rather
  // than quietly dropped: the set would import with three moves and no warning.
  moves.forEach((move, index) => {
    if (!move.text) doubts.push(`move ${index + 1} could not be read and was left out`);
    else if (!move.sure) doubts.push(`move ${index + 1} may not be right`);
  });
  return {
    slot,
    name: solved.name,
    species: solved.identity.species,
    form: solved.identity.form,
    nature: solved.nature,
    points: reading.points,
    finals: reading.finals,
    ability: read.ability,
    item: read.item,
    moves,
    doubts,
    sure: !doubts.length,
  };
}

/** The read team as a Showdown paste, so the panel hands the very same text the
 *  paste box takes and the import behaves identically either way. */
export function teamText(slots, data) {
  return slots.filter((slot) => slot.species).map((slot) => setToShowdown(makeSet({
    species: slot.species,
    form: slot.form,
    item: slot.item?.text || "",
    ability: slot.ability?.text || "",
    moves: slot.moves.map((move) => move.text).filter(Boolean),
    nature: slot.nature,
    bonuses: slot.points,
  }), data)).join("\n\n");
}

export { SLOT_STATS };

// --- the panel ------------------------------------------------------------------------

export const EXAMPLES = [
  { src: "/pokemon_champions_assets/help/team-moves-example.webp", caption: "The “Moves & More” tab" },
  { src: "/pokemon_champions_assets/help/team-stats-example.webp", caption: "The “Stats” tab" },
];

/** A picture file as pixels. Very large captures are brought down first: the
 *  reader works off the card's own size, so more pixels buy nothing. */
async function imageFromFile(file) {
  const bitmap = await createImageBitmap(file);
  const limit = 3000;
  const factor = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * factor));
  const height = Math.max(1, Math.round(bitmap.height * factor));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return context.getImageData(0, 0, width, height);
}

const pointsLine = (points) => points
  .map((value, index) => (value ? `${value} ${SLOT_STATS[index]}` : ""))
  .filter(Boolean).join(" · ") || "no Stat Points";

/**
 * The screenshot half of the Import / Export panel.
 *
 * `onImport(text, mode)` is the panel's own importTeam, so a team read from two
 * pictures is saved, named and slotted exactly like a pasted one.
 */
export function screenshotImportView(data, onImport) {
  const state = { files: [null, null], result: null, error: "", waiting: "", busy: false };
  const host = h("div", { class: "bd-shot" });
  const textArea = h("textarea", { class: "bd-textarea", "aria-label": "The team that was read" });

  // Every call takes a ticket. Choosing a second file while the first pair is still
  // being read would otherwise let the older read finish last and print its message
  // over the newer one -- which is how a picture that has just been removed could
  // still be the one the panel complains about.
  let reading = 0;

  const read = async () => {
    const ticket = (reading += 1);
    state.result = null;
    state.error = "";
    state.waiting = "";
    if (!state.files[0] || !state.files[1]) {
      // One picture on its own is not a failure to read, it is a choice that is
      // not finished yet, so it gets a plain note saying what is still missing.
      const only = state.files[0] || state.files[1];
      if (!only) { render(); return; }
      state.waiting = MESSAGES.needBoth;
      state.busy = true;
      render();
      // Which tab the one picture shows is worth reading for: it turns the note
      // into the exact thing the player still has to take a screenshot of.
      try {
        const kind = readScreen(await imageFromFile(only)).kind;
        if (ticket !== reading) return;
        if (kind === "moves") state.waiting = MESSAGES.needStats;
        else if (kind === "stats") state.waiting = MESSAGES.needMoves;
      } catch (caught) {
        // A file that will not open is called out once both have been chosen.
        if (ticket !== reading) return;
      }
      if (ticket !== reading) return;
      state.busy = false;
      render();
      return;
    }
    state.busy = true;
    render();
    let error = "";
    let result = null;
    try {
      const images = await Promise.all(state.files.map(imageFromFile));
      const out = readTeamScreenshots(images, data);
      if (out.error) error = out.error;
      else result = out;
    } catch (caught) {
      console.error(caught);
      error = "That file could not be opened as a picture. PNG, JPG and WebP all work.";
    }
    if (ticket !== reading) return;
    state.error = error;
    state.result = result;
    if (result) textArea.value = result.showdown;
    state.busy = false;
    render();
  };

  const pick = (index) => {
    const chosen = h("em", {}, "No file chosen");
    return h("label", { class: "bd-shot-pick" },
      h("span", {}, index === 0 ? "First screenshot" : "Second screenshot"),
      h("input", {
        type: "file", accept: "image/*", class: "bd-shot-file",
        onchange: (event) => {
          state.files[index] = event.target.files?.[0] || null;
          chosen.textContent = state.files[index]?.name || "No file chosen";
          read();
        },
      }),
      chosen);
  };

  const slotRow = (slot) => {
    if (slot.error) {
      return h("li", { class: "bd-shot-slot bd-shot-bad" },
        h("strong", {}, `Slot ${slot.slot + 1}`), h("p", {}, slot.error));
    }
    const line = [slot.ability?.text, slot.item?.text].filter(Boolean).join(" · ");
    return h("li", { class: `bd-shot-slot${slot.sure ? "" : " bd-shot-unsure"}` },
      sprite(data.sprite(slot.species, slot.form, slot.item?.text || ""), "", 32),
      h("div", {},
        h("strong", {}, slot.name), " ", h("span", { class: "bd-shot-nature" }, `${slot.nature} nature`),
        h("p", {}, pointsLine(slot.points)),
        h("p", {}, line),
        h("p", {}, slot.moves.map((move) => move.text).filter(Boolean).join(", ")),
        slot.doubts.length ? h("p", { class: "bd-shot-doubt" }, `Please check: ${slot.doubts.join("; ")}.`) : null));
  };

  // The two file controls are built once and never rebuilt: re-rendering them
  // would throw away the browser's own "file chosen" state under the player.
  const results = h("div", { class: "bd-shot" });
  host.append(
    h("p", { class: "bd-note" }, "Take one screenshot of each tab of your team screen in the game, then choose both files here. It does not matter which one you choose first."),
    h("div", { class: "bd-shot-examples" }, EXAMPLES.map((example) => h("figure", { class: "bd-shot-figure" },
      h("img", { src: example.src, alt: example.caption, loading: "lazy", decoding: "async" }),
      h("figcaption", {}, example.caption)))),
    h("div", { class: "bd-shot-picks" }, pick(0), pick(1)),
    results);

  const render = () => {
    clear(results);
    if (state.busy) results.append(h("p", { class: "bd-note" }, state.waiting ? "Looking at the picture…" : "Reading the pictures…"));
    if (state.waiting && !state.busy) results.append(h("p", { class: "bd-note bd-shot-waiting" }, state.waiting));
    if (state.error) results.append(problemCard("That did not work", state.error));
    if (state.result) {
      // append() writes "null" where h() would have dropped it, so the optional
      // line is filtered out here rather than handed over as a child.
      results.append(...[
        h("h3", { class: "bd-shot-heading" }, "This is what the pictures say — check it before you import"),
        state.result.notes.length ? h("p", { class: "bd-shot-doubt" }, state.result.notes.join(" ")) : null,
        h("ul", { class: "bd-shot-list" }, state.result.slots.map(slotRow)),
        h("div", { class: "bd-field" },
          h("span", {}, "You can correct anything here before importing"),
          textArea,
          h("div", { class: "bd-actions" },
            h("button", { type: "button", class: "primary-button compact", onclick: () => onImport(textArea.value, "new") }, "Import as new team"),
            h("button", { type: "button", class: "ghost-button compact", onclick: () => onImport(textArea.value, "replace") }, "Replace current team"),
            h("button", { type: "button", class: "ghost-button compact", onclick: () => onImport(textArea.value, "box") }, "Add to Box"))),
      ].filter(Boolean));
    }
  };
  render();
  return host;
}
