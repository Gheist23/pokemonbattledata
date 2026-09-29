// "Use in-game screenshots": the Team Builder's Import / Export panel reading a
// whole team out of two pictures of the game's own team screen.
//
//   node tests/run-screenshot-import.mjs
//   node tests/run-screenshot-import.mjs --verbose
//
// The two fixtures are the REAL screenshots the owner supplied, pixel for pixel
// (tests/screenshot-moves.png and tests/screenshot-stats.png are lossless copies
// of the two WebP files the page itself shows as examples, so the bytes this
// suite reads are the bytes a browser decodes).  Nothing here is mocked: the
// suite decodes the PNGs, hands the pixels to builder/screenshot-import.js and
// requires the exact team back.
//
// What it holds to:
//
//   1. THE WHOLE TEAM, EXACTLY.  Six species and forms, six natures, six arrays
//      of Stat Points, six Abilities, six items and all twenty-four moves.  The
//      species are not read as text at all — the card headings are the player's
//      own nicknames — they are solved out of the stat arithmetic, so a wrong
//      digit anywhere makes this fail rather than import a different Pokemon.
//
//   2. EITHER ORDER.  The panel does not ask which picture is which tab.
//
//   3. ANOTHER PHONE.  The same team read out of the same pictures resampled to
//      0.8x and 1.5x, because the reader works off the card's own size.
//
//   4. THE PASTE IT PRODUCES.  The panel hands importTeam() a Showdown paste, so
//      the text has to survive parseShowdown and come back as the same sets.
//
//   5. WHAT IT SAYS WHEN IT CANNOT.  Two copies of one tab, a picture that is
//      not the team screen, one picture, a team of four and two pictures of
//      different teams each get their own sentence, and none of them is an
//      exception or an internal name.
//
// No browser and no network.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData, parseShowdown } from "../builder/common.js";
import { MOVE_ROW_TOP, MOVE_TEXT_X, cropCard, detectCards, fitText, readTeamScreenshots, MESSAGES } from "../builder/screenshot-import.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const verbose = process.argv.includes("--verbose");

let checked = 0;
const failures = [];
const ok = (label, passed, detail = "") => {
  checked += 1;
  if (!passed) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  else if (verbose) console.log(`  ok   ${label}`);
};
const same = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

// --- the smallest PNG reader that reads these fixtures --------------------------------
//
// Node has no image decoder and this repo has no dependencies, so the suite
// carries one: 8-bit truecolour, no interlacing, which is what the fixtures are.
// It hands back exactly the shape a canvas hands the browser.

function decodePng(file) {
  const buffer = readFileSync(file);
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  let at = 8, width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  const parts = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("latin1", at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; colour = body[9]; interlace = body[12];
    } else if (type === "IDAT") parts.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
    throw new Error(`${file}: unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
  }
  const channels = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  let previous = new Uint8Array(stride), read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const line = raw.subarray(read, read + stride);
    read += stride;
    const row = pixels.subarray(y * stride, y * stride + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      const x = line[i];
      let value;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      row[i] = value & 255;
    }
    previous = row;
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, count = width * height; i < count; i++) {
    data[i * 4] = pixels[i * channels];
    data[i * 4 + 1] = pixels[i * channels + 1];
    data[i * 4 + 2] = pixels[i * channels + 2];
    data[i * 4 + 3] = channels === 4 ? pixels[i * channels + 3] : 255;
  }
  return { width, height, data };
}

/** The same picture as a phone with a different screen would have taken it. */
function resample(image, factor) {
  const width = Math.round(image.width * factor);
  const height = Math.round(image.height * factor);
  const out = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fx = (x + 0.5) / factor - 0.5, fy = (y + 0.5) / factor - 0.5;
      const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(fy)));
      const x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1);
      const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
      for (let c = 0; c < 4; c++) {
        const top = image.data[(y0 * image.width + x0) * 4 + c] * (1 - tx) + image.data[(y0 * image.width + x1) * 4 + c] * tx;
        const bottom = image.data[(y1 * image.width + x0) * 4 + c] * (1 - tx) + image.data[(y1 * image.width + x1) * 4 + c] * tx;
        out.data[(y * width + x) * 4 + c] = top * (1 - ty) + bottom * ty;
      }
    }
  }
  return out;
}

const clone = (image) => ({ width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) });

/** Paint the page's own colour over a band, which is what an empty team row looks like. */
function emptyRow(image, top, bottom) {
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      image.data[i] = 255; image.data[i + 1] = 233; image.data[i + 2] = 202; image.data[i + 3] = 255;
    }
  }
  return image;
}

// --- the team the two pictures hold ---------------------------------------------------

const TEAM = [
  { name: "Sneasler", species: "Sneasler", form: "Sneasler", nature: "Adamant", points: [2, 32, 0, 0, 0, 32], ability: "Unburden", item: "Grassy Seed", moves: ["Protect", "Dire Claw", "Close Combat", "Rock Slide"] },
  { name: "Kangaskhan", species: "Kangaskhan", form: "Kangaskhan", nature: "Adamant", points: [18, 32, 4, 0, 0, 12], ability: "Scrappy", item: "Kangaskhanite", moves: ["Double-Edge", "Fake Out", "Drain Punch", "Sucker Punch"] },
  { name: "Rillaboom", species: "Rillaboom", form: "Rillaboom", nature: "Adamant", points: [28, 32, 0, 0, 0, 6], ability: "Grassy Surge", item: "Miracle Seed", moves: ["Fake Out", "Wood Hammer", "Grassy Glide", "U-turn"] },
  { name: "Gholdengo", species: "Gholdengo", form: "Gholdengo", nature: "Modest", points: [28, 0, 0, 32, 6, 0], ability: "Good as Gold", item: "Life Orb", moves: ["Make It Rain", "Shadow Ball", "Nasty Plot", "Protect"] },
  { name: "Indeedee-F", species: "Indeedee", form: "Indeedee Female", nature: "Relaxed", points: [32, 0, 32, 0, 2, 0], ability: "Psychic Surge", item: "Rocky Helmet", moves: ["Follow Me", "Trick Room", "Helping Hand", "Psyshock"] },
  { name: "Incineroar", species: "Incineroar", form: "Incineroar", nature: "Careful", points: [32, 0, 6, 0, 19, 9], ability: "Intimidate", item: "Sitrus Berry", moves: ["Fake Out", "Flare Blitz", "Parting Shot", "Throat Chop"] },
];

const data = new BuilderData(JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8")));
const movesShot = decodePng(join(here, "screenshot-moves.png"));
const statsShot = decodePng(join(here, "screenshot-stats.png"));

ok("both fixtures decoded", movesShot.width === 1080 && movesShot.height === 810 && statsShot.width === 1080 && statsShot.height === 810,
  `${movesShot.width}x${movesShot.height} and ${statsShot.width}x${statsShot.height}`);

// =============================================================================
// 1. the whole team, exactly
// =============================================================================

const read = readTeamScreenshots([movesShot, statsShot], data);
ok("the two real screenshots were read", !read.error, read.error || "");

if (!read.error) {
  same("six Pokémon came out", read.slots.length, 6);
  same("nothing needed saying about the team as a whole", read.notes, []);
  TEAM.forEach((want, index) => {
    const got = read.slots[index] || {};
    same(`slot ${index + 1} is ${want.name}`, [got.name, got.species, got.form], [want.name, want.species, want.form]);
    same(`slot ${index + 1} has a ${want.nature} nature`, got.nature, want.nature);
    same(`slot ${index + 1} Stat Points`, got.points, want.points);
    same(`slot ${index + 1} Ability`, got.ability?.text, want.ability);
    same(`slot ${index + 1} item`, got.item?.text, want.item);
    same(`slot ${index + 1} moves`, (got.moves || []).map((move) => move.text), want.moves);
  });
  // The stat values on screen have to be the values the engine gives that very
  // set: this is the arithmetic the species was solved out of, run forwards.
  TEAM.forEach((want, index) => {
    const got = read.slots[index] || {};
    const record = data.formRecord(want.species, want.form);
    const expected = ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"].map((key, stat) => {
      const [up, down] = data.natures[want.nature];
      const label = ["", "ATK", "DEF", "SPA", "SPD", "SPE"][stat];
      let value = record.stats[key] + want.points[stat];
      if (stat > 0 && label === up) value = Math.floor(value * 1.1);
      else if (stat > 0 && label === down) value = Math.floor(value * 0.9);
      return value;
    });
    same(`slot ${index + 1} stat values match the engine`, got.finals, expected);
  });
}

// =============================================================================
// 2. either order
// =============================================================================

const swapped = readTeamScreenshots([statsShot, movesShot], data);
ok("the pictures may be chosen in either order", !swapped.error, swapped.error || "");
same("and give the same team", (swapped.slots || []).map((slot) => slot.name), TEAM.map((row) => row.name));
same("and the same paste", swapped.showdown, read.showdown);

// =============================================================================
// 3. another phone
// =============================================================================

for (const factor of [0.8, 1.5]) {
  const other = readTeamScreenshots([resample(movesShot, factor), resample(statsShot, factor)], data);
  ok(`a ${factor}x capture was read`, !other.error, other.error || "");
  same(`a ${factor}x capture gives the same six Pokémon`, (other.slots || []).map((slot) => slot.name), TEAM.map((row) => row.name));
  same(`a ${factor}x capture gives the same natures`, (other.slots || []).map((slot) => slot.nature), TEAM.map((row) => row.nature));
  same(`a ${factor}x capture gives the same Stat Points`, (other.slots || []).map((slot) => slot.points), TEAM.map((row) => row.points));
  same(`a ${factor}x capture gives the same Abilities`, (other.slots || []).map((slot) => slot.ability?.text), TEAM.map((row) => row.ability));
}

// A capture too small for the game's own 11px text is refused, not guessed at.
const tiny = readTeamScreenshots([resample(movesShot, 0.6), resample(statsShot, 0.6)], data);
same("a shrunken capture is refused", tiny.error, MESSAGES.tooSmall);

// Nothing the reader called certain may be wrong. A move it could not place is
// allowed to come out wrong, but only with `sure` false, which is what puts the
// "Please check" line in front of the player before anything is imported.
for (const factor of [1, 0.8, 1.5]) {
  const pair = factor === 1 ? [movesShot, statsShot] : [resample(movesShot, factor), resample(statsShot, factor)];
  const other = factor === 1 ? read : readTeamScreenshots(pair, data);
  const wrongAndCertain = [];
  (other.slots || []).forEach((slot, index) => {
    const want = TEAM[index];
    const fields = [[slot.ability, want.ability], [slot.item, want.item], ...(slot.moves || []).map((move, k) => [move, want.moves[k]])];
    for (const [got, wanted] of fields) {
      if (got?.sure && got.text !== wanted) wrongAndCertain.push(`${want.name}: read “${got.text}”, wanted “${wanted}”`);
    }
  });
  ok(`at ${factor}x nothing the reader was sure of was wrong`, wrongAndCertain.length === 0, wrongAndCertain.join("; "));
}

// Ten letters (J Q V X Y Z j q v x) never appear in the two screenshots and so
// have no template. A name that uses one is still matched on its other letters,
// but the missing ones are counted and the reader never calls such a match
// certain. Incineroar's fourth move line really says "Throat Chop": the true
// name still has to beat a decoy that needs a letter the atlas does not hold.
{
  const card = cropCard(movesShot, detectCards(movesShot)[5]);
  const line = (name) => fitText(card.ink, MOVE_ROW_TOP[3], MOVE_TEXT_X[0], MOVE_TEXT_X[1], name);
  const right = line("Throat Chop");
  const decoy = line("Volt Switch");
  same("a name using a letter with no template is counted as such", decoy.unknown, 1);
  same("a name the atlas covers in full is not", right.unknown, 0);
  ok("and the name that is really there still wins", right.score > decoy.score + 0.1,
    `Throat Chop ${right.score.toFixed(3)} against Volt Switch ${decoy.score.toFixed(3)}`);
}

// =============================================================================
// 4. the paste it produces
// =============================================================================

const parsed = parseShowdown(read.showdown || "", data);
same("the paste it hands the import holds six Pokémon", parsed.length, 6);
TEAM.forEach((want, index) => {
  const set = parsed[index] || {};
  same(`the paste round-trips slot ${index + 1}`,
    [set.species, set.form, set.nature, set.item, set.ability, set.moves, set.bonuses],
    [want.species, want.form, want.nature, want.item, want.ability, want.moves, want.points]);
});

// =============================================================================
// 5. what it says when it cannot
// =============================================================================

const noise = { width: 1080, height: 810, data: new Uint8ClampedArray(1080 * 810 * 4) };
for (let i = 0; i < 1080 * 810; i++) {
  noise.data[i * 4] = 40 + (i % 200); noise.data[i * 4 + 1] = 90; noise.data[i * 4 + 2] = 60; noise.data[i * 4 + 3] = 255;
}
same("a picture that is not the team screen", readTeamScreenshots([noise, statsShot], data).error, MESSAGES.noCards);
same("two copies of the Stats tab", readTeamScreenshots([statsShot, statsShot], data).error, MESSAGES.sameTab);
same("two copies of the Moves tab", readTeamScreenshots([movesShot, movesShot], data).error, MESSAGES.sameTab);
same("one picture on its own", readTeamScreenshots([movesShot], data).error, MESSAGES.notTwo);

const fourMoves = emptyRow(clone(movesShot), 505, 625);
const fourStats = emptyRow(clone(statsShot), 505, 625);
const four = readTeamScreenshots([fourMoves, fourStats], data);
ok("a team of four was read", !four.error, four.error || "");
same("and gives four Pokémon", (four.slots || []).map((slot) => slot.name), TEAM.slice(0, 4).map((row) => row.name));
ok("and says so in plain words", (four.notes || []).some((note) => /Only 4 of the six slots/.test(note)), JSON.stringify(four.notes));

const disagree = readTeamScreenshots([fourMoves, statsShot], data);
ok("two pictures of different teams are called out", (disagree.notes || []).includes(MESSAGES.mismatch), JSON.stringify(disagree.notes || disagree.error));

for (const message of Object.values(MESSAGES)) {
  ok("every message is a sentence a player can act on", /^[A-Z].*[.]$/.test(message) && !/undefined|null|Error|\bexception\b/i.test(message), message);
}

// =============================================================================

console.log(`\n${checked} checks, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exit(1);
}
console.log("screenshot import: OK");
process.exit(0);
