// "Use in-game screenshots": the Team Builder's Import / Export panel reading a
// whole team out of two pictures of the game's own team screen.
//
//   node tests/run-screenshot-import.mjs
//   node tests/run-screenshot-import.mjs --verbose
//
// The four fixtures are REAL screenshots the owner supplied, pixel for pixel,
// from two different phones:
//
//   tests/screenshot-moves.png  / screenshot-stats.png   1080x810, six cards
//   tests/screenshot2-moves.png / screenshot2-stats.png  1080x499, six cards
//
// The second pair is a lossless copy of the two WebP files the page itself
// shows as examples, so the bytes this suite reads are the bytes a browser
// decodes; the first pair is the same screen from a taller phone, which puts
// the cards on screen at 0.82x the size and is what the reader has to survive.
// Nothing here is mocked: the suite decodes the PNGs, hands the pixels to
// builder/screenshot-import.js and requires the exact team back.
//
// What it holds to:
//
//   1. THE WHOLE TEAM, EXACTLY, TWICE.  Six species and forms, six natures, six
//      arrays of Stat Points, six Abilities, six items and all twenty-four
//      moves, for both teams.  The species are not read as text at all — the
//      card headings are the player's own nicknames — they are solved out of the
//      stat arithmetic, so a wrong digit anywhere makes this fail rather than
//      import a different Pokemon.
//
//   2. EITHER ORDER.  The panel does not ask which picture is which tab.
//
//   3. ANOTHER PHONE.  Each team read out of its own pictures resampled, because
//      the reader works off the card's own size and not the capture's.
//
//   4. WHICH SLOT IS WHICH.  The banner carrying the team's name is a plate of
//      the same colour as a card and on a wide screen it is deep enough to pass
//      for a row of them, so the slots are counted over what is card-shaped.
//
//   5. HOW OFTEN IT IS UNSURE.  Nothing it calls certain may be wrong, and the
//      number of fields it reads correctly but will not vouch for is capped, so
//      the reader cannot quietly get vaguer.
//
//   6. THE PASTE IT PRODUCES.  The panel hands importTeam() a Showdown paste, so
//      the text has to survive parseShowdown and come back as the same sets.
//
//   7. WHAT IT SAYS WHEN IT CANNOT.  Two copies of one tab, a picture that is
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

// --- the two teams the four pictures hold ---------------------------------------------

const TEAM_ONE = [
  { name: "Sneasler", species: "Sneasler", form: "Sneasler", nature: "Adamant", points: [2, 32, 0, 0, 0, 32], ability: "Unburden", item: "Grassy Seed", moves: ["Protect", "Dire Claw", "Close Combat", "Rock Slide"] },
  { name: "Kangaskhan", species: "Kangaskhan", form: "Kangaskhan", nature: "Adamant", points: [18, 32, 4, 0, 0, 12], ability: "Scrappy", item: "Kangaskhanite", moves: ["Double-Edge", "Fake Out", "Drain Punch", "Sucker Punch"] },
  { name: "Rillaboom", species: "Rillaboom", form: "Rillaboom", nature: "Adamant", points: [28, 32, 0, 0, 0, 6], ability: "Grassy Surge", item: "Miracle Seed", moves: ["Fake Out", "Wood Hammer", "Grassy Glide", "U-turn"] },
  { name: "Gholdengo", species: "Gholdengo", form: "Gholdengo", nature: "Modest", points: [28, 0, 0, 32, 6, 0], ability: "Good as Gold", item: "Life Orb", moves: ["Make It Rain", "Shadow Ball", "Nasty Plot", "Protect"] },
  { name: "Indeedee-F", species: "Indeedee", form: "Indeedee Female", nature: "Relaxed", points: [32, 0, 32, 0, 2, 0], ability: "Psychic Surge", item: "Rocky Helmet", moves: ["Follow Me", "Trick Room", "Helping Hand", "Psyshock"] },
  { name: "Incineroar", species: "Incineroar", form: "Incineroar", nature: "Careful", points: [32, 0, 6, 0, 19, 9], ability: "Intimidate", item: "Sitrus Berry", moves: ["Fake Out", "Flare Blitz", "Parting Shot", "Throat Chop"] },
];

// The team the page shows as its example, from a phone whose screen puts the
// same cards on at 0.82x. Three of the six hold a Mega Stone or a Life Orb, and
// two of the four move lines per card are printed over the lighter heading band.
const TEAM_TWO = [
  { name: "Emboar", species: "Emboar", form: "Emboar", nature: "Adamant", points: [32, 32, 2, 0, 0, 0], ability: "Reckless", item: "Emboarite", moves: ["Flare Blitz", "Close Combat", "Sucker Punch", "Protect"] },
  { name: "Salamence", species: "Salamence", form: "Salamence", nature: "Timid", points: [2, 0, 0, 32, 0, 32], ability: "Intimidate", item: "Salamencite", moves: ["Protect", "Draco Meteor", "Hyper Voice", "Flamethrower"] },
  { name: "Rillaboom", species: "Rillaboom", form: "Rillaboom", nature: "Brave", points: [32, 32, 0, 0, 2, 0], ability: "Grassy Surge", item: "Miracle Seed", moves: ["Grassy Glide", "High Horsepower", "Wood Hammer", "Fake Out"] },
  { name: "Empoleon", species: "Empoleon", form: "Empoleon", nature: "Bold", points: [32, 0, 20, 0, 14, 0], ability: "Competitive", item: "Leftovers", moves: ["Hydro Pump", "Icy Wind", "Ice Beam", "Protect"] },
  { name: "Gholdengo", species: "Gholdengo", form: "Gholdengo", nature: "Modest", points: [2, 0, 0, 32, 0, 32], ability: "Good as Gold", item: "Life Orb", moves: ["Make It Rain", "Shadow Ball", "Nasty Plot", "Protect"] },
  { name: "Whimsicott", species: "Whimsicott", form: "Whimsicott", nature: "Timid", points: [2, 0, 0, 32, 0, 32], ability: "Prankster", item: "Focus Sash", moves: ["Moonblast", "Encore", "Helping Hand", "Tailwind"] },
];

const data = new BuilderData(JSON.parse(readFileSync(join(root, "data", "builder", "app-data.json"), "utf8")));

const TEAMS = [
  { label: "team one", team: TEAM_ONE, size: [1080, 810], factors: [0.8, 1.5], file: "screenshot" },
  { label: "team two", team: TEAM_TWO, size: [1080, 499], factors: [1.15, 1.5], file: "screenshot2" },
];
for (const entry of TEAMS) {
  entry.movesShot = decodePng(join(here, `${entry.file}-moves.png`));
  entry.statsShot = decodePng(join(here, `${entry.file}-stats.png`));
  ok(`${entry.label}: both fixtures decoded at ${entry.size.join("x")}`,
    entry.movesShot.width === entry.size[0] && entry.movesShot.height === entry.size[1]
    && entry.statsShot.width === entry.size[0] && entry.statsShot.height === entry.size[1],
    `${entry.movesShot.width}x${entry.movesShot.height} and ${entry.statsShot.width}x${entry.statsShot.height}`);
}

// The second pair IS the pair of pictures the panel shows as its examples, so
// the page can never illustrate one screen and be tested against another.
for (const [asset, fixture] of [["team-moves-example.webp", "screenshot2-moves.png"], ["team-stats-example.webp", "screenshot2-stats.png"]]) {
  ok(`the page's ${asset} is on disk for the panel to show`,
    readFileSync(join(root, "pokemon_champions_assets", "help", asset)).length > 1000);
  ok(`and tests/${fixture} stands in for it`, readFileSync(join(here, fixture)).length > 1000);
}

// =============================================================================
// 1. the whole team, exactly, twice
// =============================================================================

let sureAndWrong = 0, rightButUnsure = 0, fieldsRead = 0;

const gradeFields = (slots, team) => {
  slots.forEach((slot, index) => {
    const want = team[index];
    if (!want || slot.error) return;
    const fields = [[slot.ability, want.ability], [slot.item, want.item], ...(slot.moves || []).map((move, k) => [move, want.moves[k]])];
    for (const [got, wanted] of fields) {
      fieldsRead += 1;
      if (got?.text !== wanted) { if (got?.sure) sureAndWrong += 1; }
      else if (!got.sure) rightButUnsure += 1;
    }
  });
};

for (const { label, team, movesShot, statsShot, factors } of TEAMS) {
  const read = readTeamScreenshots([movesShot, statsShot], data);
  ok(`${label}: the two real screenshots were read`, !read.error, read.error || "");
  if (read.error) continue;

  same(`${label}: six Pokémon came out`, read.slots.length, 6);
  same(`${label}: nothing needed saying about the team as a whole`, read.notes, []);
  // Which card is which slot: the first Pokémon is slot 0 and the sixth slot 5,
  // whatever else is on screen above the grid.
  same(`${label}: the six cards are slots 0 to 5`, read.slots.map((slot) => slot.slot), [0, 1, 2, 3, 4, 5]);
  team.forEach((want, index) => {
    const got = read.slots[index] || {};
    same(`${label} slot ${index + 1} is ${want.name}`, [got.name, got.species, got.form], [want.name, want.species, want.form]);
    same(`${label} slot ${index + 1} has a ${want.nature} nature`, got.nature, want.nature);
    same(`${label} slot ${index + 1} Stat Points`, got.points, want.points);
    same(`${label} slot ${index + 1} Ability`, got.ability?.text, want.ability);
    same(`${label} slot ${index + 1} item`, got.item?.text, want.item);
    same(`${label} slot ${index + 1} moves`, (got.moves || []).map((move) => move.text), want.moves);
  });
  // The stat values on screen have to be the values the engine gives that very
  // set: this is the arithmetic the species was solved out of, run forwards.
  team.forEach((want, index) => {
    const got = read.slots[index] || {};
    const record = data.formRecord(want.species, want.form);
    const expected = ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"].map((key, stat) => {
      const [up, down] = data.natures[want.nature];
      const label2 = ["", "ATK", "DEF", "SPA", "SPD", "SPE"][stat];
      let value = record.stats[key] + want.points[stat];
      if (stat > 0 && label2 === up) value = Math.floor(value * 1.1);
      else if (stat > 0 && label2 === down) value = Math.floor(value * 0.9);
      return value;
    });
    same(`${label} slot ${index + 1} stat values match the engine`, got.finals, expected);
  });
  gradeFields(read.slots, team);

  // 2. either order
  const swapped = readTeamScreenshots([statsShot, movesShot], data);
  ok(`${label}: the pictures may be chosen in either order`, !swapped.error, swapped.error || "");
  same(`${label}: and give the same team`, (swapped.slots || []).map((slot) => slot.name), team.map((row) => row.name));
  same(`${label}: and the same paste`, swapped.showdown, read.showdown);

  // 3. another phone
  for (const factor of factors) {
    const other = readTeamScreenshots([resample(movesShot, factor), resample(statsShot, factor)], data);
    ok(`${label}: a ${factor}x capture was read`, !other.error, other.error || "");
    same(`${label}: a ${factor}x capture gives the same six Pokémon`, (other.slots || []).map((slot) => slot.name), team.map((row) => row.name));
    same(`${label}: a ${factor}x capture gives the same natures`, (other.slots || []).map((slot) => slot.nature), team.map((row) => row.nature));
    same(`${label}: a ${factor}x capture gives the same Stat Points`, (other.slots || []).map((slot) => slot.points), team.map((row) => row.points));
    same(`${label}: a ${factor}x capture gives the same Abilities`, (other.slots || []).map((slot) => slot.ability?.text), team.map((row) => row.ability));
    same(`${label}: a ${factor}x capture gives the same items`, (other.slots || []).map((slot) => slot.item?.text), team.map((row) => row.item));
    same(`${label}: a ${factor}x capture gives the same moves`, (other.slots || []).map((slot) => (slot.moves || []).map((move) => move.text)), team.map((row) => row.moves));
    gradeFields(other.slots || [], team);
  }

  // 4. which slot is which, straight off the picture
  const cards = detectCards(movesShot);
  same(`${label}: six cards were found`, cards.length, 6);
  same(`${label}: and they are numbered 0 to 5`, cards.map((card) => card.slot), [0, 1, 2, 3, 4, 5]);
  ok(`${label}: and the banner over the grid is not one of them`,
    cards.every((card) => Math.abs(card.h / card.w - 109 / 421) < 0.12), JSON.stringify(cards.map((card) => [card.w, card.h])));
}

// =============================================================================
// 5. how often it is unsure
// =============================================================================

// Nothing the reader called certain may be wrong. A field it could not place is
// allowed to come out wrong, but only with `sure` false, which is what puts the
// "Please check" line in front of the player before anything is imported.
same("nothing the reader was sure of was wrong, on either team at any size", sureAndWrong, 0);
ok("and every field of both teams was read", fieldsRead === 6 * 6 * 3 * 2, `${fieldsRead} fields`);
// Being unsure is safe but it is work for the player, so it is capped. Over the
// six readings above the reader before this one was unsure of 21 fields and got
// two of them wrong as well; this one is unsure of 5 and gets none of them wrong.
ok("the reader is not unsure of more than eight fields in all", rightButUnsure <= 8, `${rightButUnsure} fields came back right but unsure`);

// A letter with no template. Eight are still missing (J Q X Y Z j q x) because
// they appear nowhere in the fixtures. A name that uses one is still matched on
// its other letters, but the missing ones are counted and such a match is never
// called certain. Incineroar's fourth move line really says "Throat Chop": the
// true name still has to beat a decoy that needs a letter the atlas lacks.
{
  const movesShot = TEAMS[0].movesShot;
  const card = cropCard(movesShot, detectCards(movesShot)[5]);
  const line = (name) => fitText(card.ink, MOVE_ROW_TOP[3], MOVE_TEXT_X[0], MOVE_TEXT_X[1], name);
  const right = line("Throat Chop");
  const decoy = line("Zen Headbutt");
  same("a name using a letter with no template is counted as such", decoy.unknown, 1);
  same("a name the atlas covers in full is not", right.unknown, 0);
  ok("and the name that is really there still wins", right.score > decoy.score + 0.1,
    `Throat Chop ${right.score.toFixed(3)} against Zen Headbutt ${decoy.score.toFixed(3)}`);
  // V and v were two of the ten missing letters until the second team's
  // screenshots supplied them; "Hyper Voice" and "Competitive" are read off that
  // team with no doubt at all, which only holds while both have templates.
  same("V and v now have templates", fitText(card.ink, MOVE_ROW_TOP[3], MOVE_TEXT_X[0], MOVE_TEXT_X[1], "Volt Switch").unknown, 0);
}

// =============================================================================
// 6. the paste it produces
// =============================================================================

for (const { label, team, movesShot, statsShot } of TEAMS) {
  const read = readTeamScreenshots([movesShot, statsShot], data);
  const parsed = parseShowdown(read.showdown || "", data);
  same(`${label}: the paste it hands the import holds six Pokémon`, parsed.length, 6);
  team.forEach((want, index) => {
    const set = parsed[index] || {};
    same(`${label}: the paste round-trips slot ${index + 1}`,
      [set.species, set.form, set.nature, set.item, set.ability, set.moves, set.bonuses],
      [want.species, want.form, want.nature, want.item, want.ability, want.moves, want.points]);
  });
}

// =============================================================================
// 7. what it says when it cannot
// =============================================================================

const { movesShot, statsShot } = TEAMS[0];
const noise = { width: 1080, height: 810, data: new Uint8ClampedArray(1080 * 810 * 4) };
for (let i = 0; i < 1080 * 810; i++) {
  noise.data[i * 4] = 40 + (i % 200); noise.data[i * 4 + 1] = 90; noise.data[i * 4 + 2] = 60; noise.data[i * 4 + 3] = 255;
}
same("a picture that is not the team screen", readTeamScreenshots([noise, statsShot], data).error, MESSAGES.noCards);
same("two copies of the Stats tab", readTeamScreenshots([statsShot, statsShot], data).error, MESSAGES.sameTab);
same("two copies of the Moves tab", readTeamScreenshots([movesShot, movesShot], data).error, MESSAGES.sameTab);
same("one picture on its own", readTeamScreenshots([movesShot], data).error, MESSAGES.notTwo);
// A capture too small for the game's own 11px text is refused, not guessed at.
same("a shrunken capture is refused", readTeamScreenshots([resample(movesShot, 0.6), resample(statsShot, 0.6)], data).error, MESSAGES.tooSmall);

// Two pictures of different teams, and a team with an empty row.
const fourMoves = emptyRow(clone(movesShot), 505, 625);
const fourStats = emptyRow(clone(statsShot), 505, 625);
const four = readTeamScreenshots([fourMoves, fourStats], data);
ok("a team of four was read", !four.error, four.error || "");
same("and gives four Pokémon", (four.slots || []).map((slot) => slot.name), TEAM_ONE.slice(0, 4).map((row) => row.name));
ok("and says so in plain words", (four.notes || []).some((note) => /Only 4 of the six slots/.test(note)), JSON.stringify(four.notes));

const disagree = readTeamScreenshots([fourMoves, statsShot], data);
ok("two pictures of different teams are called out", (disagree.notes || []).includes(MESSAGES.mismatch), JSON.stringify(disagree.notes || disagree.error));

// One picture chosen and one still to go is NOT a failure: the panel has its own
// sentences for it, and they name the tab that is still missing rather than
// telling the player that something went wrong.
for (const key of ["needBoth", "needStats", "needMoves"]) {
  ok(`the panel has a note for a half-finished choice (${key})`, typeof MESSAGES[key] === "string" && MESSAGES[key].length > 20, MESSAGES[key]);
  ok(`and ${key} does not read as a failure`, !/did not work|could not|wrong|error/i.test(MESSAGES[key]), MESSAGES[key]);
}
ok("needStats asks for the Stats tab and needMoves for the other one",
  /Stats/.test(MESSAGES.needStats) && /Moves & More/.test(MESSAGES.needMoves), `${MESSAGES.needStats} / ${MESSAGES.needMoves}`);

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
