// Checks the Damage Calculator's amount pickers: the moves whose strength is a
// count (Last Respects, Supreme Overlord, Rage Fist, multi-hit moves, the
// "use in a row" moves, a Metronome-held move and Retaliate).
//
//   node tests/run-calc-amounts.mjs
//
// It drives builder/calc-model.js, which is what the page draws and what hands
// the engine its context, and covers:
//   * every picker's option list, its opening value and the moves that get none
//     (Skill Link lands every hit, so there is nothing to choose);
//   * the numbers the model puts in the context - the whole contract between the
//     picker and builder/engine.js, whose handling of ctx.hits, ctx.times_used,
//     ctx.fainted_allies, times_hit and ally_fainted_last_turn is separately
//     checked against 4000 results recorded from the app (run-calc-vectors.mjs);
//   * that an amount reaches only its own move and only its own side;
//   * clamping: Singles allows one fainted ally fewer than Doubles, both when
//     the format is switched and when a saved state is restored;
//   * the heading text ("Kowtow Cleave KO odds (2 fainted allies)");
//   * the damage itself, as exact values for the fixed sets below and as a ratio
//     against the same case measured in the Companion's own window.
//
// The sets are written out here rather than taken from the meta files: those are
// rebuilt every day, and this test has to answer the same thing tomorrow.
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DamageEngine } from "../builder/engine.js";
import { CalcModel, LEFT, RIGHT, defaultCalcState, defaultMonState } from "../builder/calc-model.js";
import { makeSet } from "../builder/common.js";

const here = dirname(fileURLToPath(import.meta.url));
const appData = JSON.parse(readFileSync(join(here, "..", "data", "builder", "app-data.json"), "utf8"));
const engine = new DamageEngine(appData);
// CalcModel reads the engine, the raw tables and the two naming helpers.
const data = { app: appData, engine, battleForm: (species, form) => [species, form], displayName: (species) => species };

let checked = 0;
const failures = [];
function check(label, got, want) {
  checked += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) failures.push(`${label}\n     got  ${a}\n     want ${b}`);
}
function ok(label, condition, detail = "") {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
}

// Both sides get the same plain spread, so a difference can only come from the
// amount under test.
const BONUSES = [30, 30, 30, 30, 30, 30];
const set = (species, item, ability, moves) => ({ ...makeSet(), species, form: species, item, ability, nature: "Serious", bonuses: [...BONUSES], moves });
const DEFENDER = set("Incineroar", "Sitrus Berry", "Intimidate", ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"]);

function build(attacker, { defender = DEFENDER, format = "Doubles", index = 0, side = LEFT } = {}) {
  const state = defaultCalcState();
  state.format = format;
  state.mons[LEFT] = defaultMonState(structuredClone(attacker));
  state.mons[RIGHT] = defaultMonState(structuredClone(defender));
  state.selectedSide = index === null ? "" : side;
  state.selectedIndex = index === null ? -1 : index;
  return new CalcModel(data, state);
}

const optionLabels = (spec) => spec.options.map(([label]) => label);
const strip = (model) => model.countControls().map((row) => ({
  label: row.label,
  options: optionLabels(row.spec),
  current: row.spec.options.find(([, value]) => value === row.value)?.[0] ?? null,
}));
const damage = (model, index = 0) => model.calculate(LEFT, index, false).range;
const midpoint = (range) => {
  const [low, high] = String(range).split("-").map(Number);
  return (low + high) / 2;
};
const heading = (model, side, move) => {
  const notes = model.headerNotes(side, move);
  return `${move} KO odds${notes.length ? ` (${notes.join(", ")})` : ""}`;
};

// ---------------------------------------------------------------------------
// 1. Every picker: what it offers, what it opens on, what the heading says and
//    what the amount does to the damage.
//
//    `app` is the same case measured in the Companion's own window.  Its
//    Pokemon carry different stat spreads, so the HP numbers differ and only the
//    ratio between the amounts can be compared.  A single point of HP is already
//    12% of the smallest reading there (Triple Axel at one hit lands 3-5 HP), so
//    the band is wide; the exact numbers this build produces are pinned by
//    `damage` below, and the engine's own arithmetic by run-calc-vectors.mjs.
// ---------------------------------------------------------------------------
const RATIO_BAND = 0.12;

const CASES = [
  {
    name: "Population Bomb",
    attacker: set("Maushold", "Wide Lens", "Friend Guard", ["Population Bomb", "Follow Me", "Protect", "Beat Up"]),
    options: ["1 hit", "2 hits", "3 hits", "4 hits", "5 hits", "6 hits", "7 hits", "8 hits", "9 hits", "10 hits"],
    current: "10 hits",
    kind: "hits",
    rows: [
      { value: 1, heading: "Population Bomb KO odds (1 hit)", damage: "7-10", app: "6-7" },
      { value: 2, heading: "Population Bomb KO odds (2 hits)", damage: "14-20", app: "12-14" },
      { value: 5, heading: "Population Bomb KO odds (5 hits)", damage: "35-50", app: "30-35" },
      { value: 10, heading: "Population Bomb KO odds (10 hits)", damage: "70-100", app: "60-70" },
    ],
  },
  {
    name: "Scale Shot",
    attacker: set("Garchomp", "Life Orb", "Rough Skin", ["Scale Shot", "Earthquake", "Protect", "Dragon Claw"]),
    options: ["2 hits", "3 hits", "4 hits", "5 hits"],
    current: "3 hits",
    kind: "hits",
    rows: [
      { value: 2, heading: "Scale Shot KO odds (2 hits)", damage: "34-42", app: "26-34" },
      { value: 3, heading: "Scale Shot KO odds (3 hits)", damage: "51-63", app: "39-51" },
      { value: 5, heading: "Scale Shot KO odds (5 hits)", damage: "85-105", app: "65-85" },
    ],
  },
  {
    name: "Triple Axel",
    attacker: set("Weavile", "Focus Sash", "Pressure", ["Triple Axel", "Knock Off", "Fake Out", "Protect"]),
    options: ["1 hit", "2 hits", "3 hits"],
    current: "3 hits",
    kind: "hits",
    rows: [
      { value: 1, heading: "Triple Axel KO odds (1 hit)", damage: "5-6", app: "3-5" },
      { value: 2, heading: "Triple Axel KO odds (2 hits)", damage: "14-18", app: "11-14" },
      { value: 3, heading: "Triple Axel KO odds (3 hits)", damage: "28-35", app: "23-28" },
    ],
  },
  {
    name: "Fury Cutter",
    attacker: set("Scizor", "Choice Band", "Technician", ["Fury Cutter", "Bullet Punch", "U-turn", "Protect"]),
    options: ["1st use", "2nd use", "3rd use"],
    current: "1st use",
    kind: "times_used",
    rows: [
      { value: 1, heading: "Fury Cutter KO odds", damage: "43-52", app: "37-45" },
      { value: 2, heading: "Fury Cutter KO odds (2nd use)", damage: "58-70", app: "49-58" },
      { value: 3, heading: "Fury Cutter KO odds (3rd use)", damage: "117-138", app: "97-115" },
    ],
  },
  {
    name: "Echoed Voice",
    attacker: set("Sylveon", "Throat Spray", "Pixilate", ["Echoed Voice", "Hyper Voice", "Protect", "Moonblast"]),
    options: ["1st use", "2nd use", "3rd use", "4th use", "5th use"],
    current: "1st use",
    kind: "times_used",
    rows: [
      { value: 1, heading: "Echoed Voice KO odds", damage: "33-39", app: "33-39" },
      { value: 2, heading: "Echoed Voice KO odds (2nd use)", damage: "63-75", app: "64-76" },
      { value: 5, heading: "Echoed Voice KO odds (5th use)", damage: "154-183", app: "160-189" },
    ],
  },
  {
    name: "Retaliate",
    attacker: set("Hitmontop", "Sitrus Berry", "Intimidate", ["Retaliate", "Close Combat", "Fake Out", "Protect"]),
    options: ["No ally fainted", "Ally fainted"],
    current: "No ally fainted",
    kind: "ally_fainted_last_turn",
    rows: [
      { value: 0, heading: "Retaliate KO odds", damage: "13-16", app: "10-12" },
      { value: 1, heading: "Retaliate KO odds (ally fainted last turn)", damage: "26-31", app: "18-22" },
    ],
  },
  {
    // The amount comes from the held item, not from the move.
    name: "Metronome",
    attacker: set("Garchomp", "Metronome", "Rough Skin", ["Earthquake", "Dragon Claw", "Protect", "Rock Slide"]),
    label: "Earthquake",
    options: ["1st use", "2nd use", "3rd use", "4th use", "5th use", "6th use"],
    current: "1st use",
    kind: "times_used",
    rows: [
      { value: 1, heading: "Earthquake KO odds", damage: "72-86", app: "62-74" },
      { value: 3, heading: "Earthquake KO odds (3rd use)", damage: "102-120", app: "84-102" },
      { value: 6, heading: "Earthquake KO odds (6th use)", damage: "146-174", app: "120-144" },
    ],
  },
];

for (const item of CASES) {
  const label = item.label || item.name;
  const move = item.attacker.moves[0];
  const model = build(item.attacker);
  const controls = model.countControls();
  check(`${item.name}: one picker`, controls.length, 1);
  if (!controls.length) continue;
  const [control] = controls;
  check(`${item.name}: picker name`, control.label, label);
  check(`${item.name}: options`, optionLabels(control.spec), item.options);
  check(`${item.name}: opens on`, control.spec.options.find(([, value]) => value === control.value)?.[0], item.current);
  check(`${item.name}: kind`, control.spec.kind, item.kind);

  for (const row of item.rows) {
    model.setCountValue(control.spec.storeKey, row.value, control.spec.default);
    check(`${item.name} = ${row.value}: heading`, heading(model, LEFT, move), row.heading);
    check(`${item.name} = ${row.value}: damage`, damage(model), row.damage);
    const ctx = model.contextForSide(LEFT, move, false);
    if (item.kind === "hits") check(`${item.name} = ${row.value}: ctx.hits`, ctx.hits, row.value);
    if (item.kind === "times_used") check(`${item.name} = ${row.value}: ctx.times_used`, ctx.times_used, row.value);
    if (item.kind === "ally_fainted_last_turn") check(`${item.name} = ${row.value}: ctx ally fainted`, Boolean(ctx.attacker_state.ally_fainted_last_turn), Boolean(row.value));
  }
  const base = item.rows[0];
  for (const row of item.rows.slice(1)) {
    const here = midpoint(row.damage) / midpoint(base.damage);
    const there = midpoint(row.app) / midpoint(base.app);
    ok(`${item.name} = ${row.value}: ratio against the app`, Math.abs(here - there) <= RATIO_BAND * there,
      `web ${here.toFixed(3)}x vs app ${there.toFixed(3)}x`);
    ok(`${item.name} = ${row.value}: stronger than ${base.value}`, midpoint(row.damage) > midpoint(base.damage));
  }
  // Back to the opening value, which is stored as "nothing chosen".
  model.setCountValue(control.spec.storeKey, control.spec.default, control.spec.default);
  check(`${item.name}: default is not stored`, Object.keys(model.state.effectValues), []);
}

// ---------------------------------------------------------------------------
// 2. Moves with no amount to choose.
// ---------------------------------------------------------------------------
{
  // Skill Link lands every hit of a 2-5 hit move.
  const model = build(set("Cloyster", "King's Rock", "Skill Link", ["Icicle Spear", "Rock Blast", "Shell Smash", "Protect"]));
  check("Skill Link: no picker", strip(model), []);
  check("Skill Link: heading", heading(model, LEFT, "Icicle Spear"), "Icicle Spear KO odds");
  check("Skill Link: ctx.hits untouched", model.contextForSide(LEFT, "Icicle Spear", false).hits, 0);
}
{
  // A status move has no damage to scale.
  const model = build(set("Garchomp", "Life Orb", "Rough Skin", ["Protect", "Scale Shot", "Earthquake", "Dragon Claw"]));
  check("status move: no picker", strip(model), []);
}
{
  // The ability that decides this is the Mega's, not the one before it: base
  // Heracross has no Skill Link, Mega Heracross does, and the calculation
  // already lands all five hits.
  const moves = ["Pin Missile", "Close Combat", "Protect", "Bullet Seed"];
  const plain = build(set("Heracross", "Life Orb", "Guts", moves));
  check("Heracross: a picker", strip(plain), [{ label: "Pin Missile", options: ["2 hits", "3 hits", "4 hits", "5 hits"], current: "3 hits" }]);
  const mega = build(set("Heracross", "Heracronite", "Guts", moves));
  check("Mega Heracross: Skill Link, so no picker", strip(mega), []);
  check("Mega Heracross: and the calculation lands every hit", mega.calculate(LEFT, 0, false).hit_count, 5);
}

// ---------------------------------------------------------------------------
// 3. The 2-5 hit and use-in-a-row moves the app lists, and Loaded Dice.
// ---------------------------------------------------------------------------
{
  const model = build(set("Golem", "Leftovers", "Sturdy", ["Rollout", "Earthquake", "Protect", "Stealth Rock"]));
  check("Rollout: options", strip(model), [{ label: "Rollout", options: ["1st use", "2nd use", "3rd use", "4th use", "5th use"], current: "1st use" }]);
}
{
  const model = build(set("Hitmontop", "Sitrus Berry", "Intimidate", ["Triple Kick", "Close Combat", "Fake Out", "Protect"]));
  check("Triple Kick: options", strip(model), [{ label: "Triple Kick", options: ["1 hit", "2 hits", "3 hits"], current: "3 hits" }]);
}
{
  // Loaded Dice never lands fewer than four of the five hits.
  const model = build(set("Garchomp", "Loaded Dice", "Rough Skin", ["Scale Shot", "Earthquake", "Protect", "Dragon Claw"]));
  check("Loaded Dice: options", strip(model), [{ label: "Scale Shot", options: ["4 hits", "5 hits"], current: "4 hits" }]);
  // An amount chosen before the item was picked up is no longer on offer.
  model.state.effectValues["left:hits:scale shot"] = 2;
  check("Loaded Dice: an amount it no longer offers", strip(model)[0].current, "4 hits");
  check("Loaded Dice: and the calculation agrees", model.contextForSide(LEFT, "Scale Shot", false).hits, 4);
}

// ---------------------------------------------------------------------------
// 4. An amount reaches its own move and its own side, nothing else.
// ---------------------------------------------------------------------------
{
  const model = build(set("Garchomp", "Life Orb", "Rough Skin", ["Scale Shot", "Earthquake", "Protect", "Dragon Claw"]));
  const before = [0, 1, 3].map((index) => damage(model, index));
  model.state.effectValues["left:hits:scale shot"] = 5;
  const after = [0, 1, 3].map((index) => damage(model, index));
  ok("per move: Scale Shot changes", after[0] !== before[0], `${before[0]} -> ${after[0]}`);
  check("per move: Earthquake untouched", after[1], before[1]);
  check("per move: Dragon Claw untouched", after[2], before[2]);
  check("per move: Earthquake ctx.hits", model.contextForSide(LEFT, "Earthquake", false).hits, 0);
}
{
  const basculegion = set("Basculegion", "Choice Band", "Adaptability", ["Last Respects", "Wave Crash", "Aqua Jet", "Flip Turn"]);
  const model = build(basculegion, { defender: basculegion });
  model.state.effectValues["left:fainted_allies"] = 3;
  check("per side: ours counts", model.contextForSide(LEFT, "Last Respects", false).fainted_allies, 3);
  check("per side: theirs does not", model.contextForSide(RIGHT, "Last Respects", false).fainted_allies, 0);
}
{
  const scizor = set("Scizor", "Choice Band", "Technician", ["Fury Cutter", "Bullet Punch", "U-turn", "Protect"]);
  const model = build(scizor, { defender: scizor });
  model.state.effectValues["right:times_used:fury cutter"] = 3;
  check("per side: ours stays on the 1st use", model.contextForSide(LEFT, "Fury Cutter", false).times_used, 1);
  check("per side: theirs is on the 3rd", model.contextForSide(RIGHT, "Fury Cutter", false).times_used, 3);
}

// ---------------------------------------------------------------------------
// 5. Fainted allies: the format's limit, the switch, and a restored state.
// ---------------------------------------------------------------------------
const basculegion = set("Basculegion", "Choice Band", "Adaptability", ["Last Respects", "Wave Crash", "Aqua Jet", "Flip Turn"]);
const kingambit = set("Kingambit", "Black Glasses", "Supreme Overlord", ["Kowtow Cleave", "Sucker Punch", "Iron Head", "Protect"]);
const faintedChip = (model) => model.effectChips(null).filter((chip) => chip.options).map((chip) => [chip.label, chip.options.map(([label]) => label), chip.value]);

{
  const model = build(basculegion);
  check("Doubles: fainted options", faintedChip(model), [["Last Respects", ["0 fainted", "1 fainted", "2 fainted", "3 fainted"], 0]]);
  const rows = [
    { value: 0, heading: "Last Respects KO odds (0 fainted allies)", damage: "22-27", app: "18-22" },
    { value: 1, heading: "Last Respects KO odds (1 fainted ally)", damage: "44-52", app: "36-43" },
    { value: 2, heading: "Last Respects KO odds (2 fainted allies)", damage: "66-78", app: "54-64" },
    { value: 3, heading: "Last Respects KO odds (3 fainted allies)", damage: "87-103", app: "71-84" },
  ];
  for (const row of rows) {
    model.setEffectValue(LEFT, "Last Respects", row.value);
    check(`Last Respects = ${row.value}: heading`, heading(model, LEFT, "Last Respects"), row.heading);
    check(`Last Respects = ${row.value}: damage`, damage(model), row.damage);
    check(`Last Respects = ${row.value}: ctx`, model.contextForSide(LEFT, "Last Respects", false).fainted_allies, row.value);
  }
  for (const row of rows.slice(1)) {
    const here = midpoint(row.damage) / midpoint(rows[0].damage);
    const there = midpoint(row.app) / midpoint(rows[0].app);
    ok(`Last Respects = ${row.value}: ratio against the app`, Math.abs(here - there) <= RATIO_BAND * there, `web ${here.toFixed(3)}x vs app ${there.toFixed(3)}x`);
  }
  // Switching the move's chip off leaves the fainted allies out, as before.
  model.setEffect(LEFT, "move", "Last Respects", false);
  check("Last Respects switched off: ctx", model.contextForSide(LEFT, "Last Respects", false).fainted_allies, 0);
  check("Last Respects switched off: heading", heading(model, LEFT, "Last Respects"), "Last Respects KO odds");
}
{
  // Singles has one ally fewer, and a count chosen in Doubles comes down with it.
  const model = build(basculegion);
  model.setEffectValue(LEFT, "Last Respects", 3);
  model.setFormat("Singles");
  check("Singles: stored count clamped", model.state.effectValues["left:fainted_allies"], 2);
  check("Singles: options", faintedChip(model), [["Last Respects", ["0 fainted", "1 fainted", "2 fainted"], 2]]);
  check("Singles: heading", heading(model, LEFT, "Last Respects"), "Last Respects KO odds (2 fainted allies)");
  check("Singles: ctx", model.contextForSide(LEFT, "Last Respects", false).fainted_allies, 2);
  model.setEffectValue(LEFT, "Last Respects", 3);
  check("Singles: 3 cannot be set either", model.state.effectValues["left:fainted_allies"], 2);
  model.setFormat("Doubles");
  check("back to Doubles: the count stays where Singles left it", model.state.effectValues["left:fainted_allies"], 2);
}
{
  // A state restored from this browser can hold anything.
  const model = build(basculegion, { format: "Singles" });
  model.state.effectValues = { "left:fainted_allies": 3, "right:fainted_allies": "2", "left:times_hit": 99, "left:hits:scale shot": "5", "left:times_used:rollout": "not a number" };
  model.normalizeEffectValues();
  check("restored state: clamped and cleaned", model.state.effectValues, { "left:fainted_allies": 2, "right:fainted_allies": 2, "left:times_hit": 6, "left:hits:scale shot": 5 });
}
{
  // Supreme Overlord scales every damaging move, so the heading names it there too.
  const model = build(kingambit);
  const rows = [
    { value: 0, heading: "Kowtow Cleave KO odds (0 fainted allies)", damage: "25-30", app: "21-26" },
    { value: 1, heading: "Kowtow Cleave KO odds (1 fainted ally)", damage: "28-33", app: "24-28" },
    { value: 2, heading: "Kowtow Cleave KO odds (2 fainted allies)", damage: "30-36", app: "25-30" },
    { value: 3, heading: "Kowtow Cleave KO odds (3 fainted allies)", damage: "33-39", app: "28-33" },
  ];
  for (const row of rows) {
    model.setEffectValue(LEFT, "Supreme Overlord", row.value);
    check(`Supreme Overlord = ${row.value}: heading`, heading(model, LEFT, "Kowtow Cleave"), row.heading);
    check(`Supreme Overlord = ${row.value}: damage`, damage(model), row.damage);
  }
  for (const row of rows.slice(1)) {
    const here = midpoint(row.damage) / midpoint(rows[0].damage);
    const there = midpoint(row.app) / midpoint(rows[0].app);
    ok(`Supreme Overlord = ${row.value}: ratio against the app`, Math.abs(here - there) <= RATIO_BAND * there, `web ${here.toFixed(3)}x vs app ${there.toFixed(3)}x`);
  }
  model.setEffect(LEFT, "ability", "Supreme Overlord", false);
  check("Supreme Overlord switched off: heading", heading(model, LEFT, "Kowtow Cleave"), "Kowtow Cleave KO odds");
  check("Supreme Overlord: no heading note on a status move", heading(model, LEFT, "Protect"), "Protect KO odds");
}

// ---------------------------------------------------------------------------
// 6. Rage Fist: the chip's off state means "not hit".
// ---------------------------------------------------------------------------
{
  const model = build(set("Annihilape", "Choice Scarf", "Defiant", ["Rage Fist", "Drain Punch", "Final Gambit", "Protect"]));
  const rows = [
    { value: 0, heading: "Rage Fist KO odds (not hit yet)", damage: "25-30", app: "21-24" },
    { value: 1, heading: "Rage Fist KO odds (hit 1 time)", damage: "50-59", app: "41-48" },
    { value: 3, heading: "Rage Fist KO odds (hit 3 times)", damage: "99-117", app: "81-96" },
    { value: 6, heading: "Rage Fist KO odds (hit 6 times)", damage: "174-204", app: "142-168" },
  ];
  for (const row of rows) {
    model.setEffectValue(LEFT, "Rage Fist", row.value);
    check(`Rage Fist = ${row.value}: heading`, heading(model, LEFT, "Rage Fist"), row.heading);
    check(`Rage Fist = ${row.value}: damage`, damage(model), row.damage);
    check(`Rage Fist = ${row.value}: ctx`, model.contextForSide(LEFT, "Rage Fist", false).attacker_state.times_hit, row.value);
  }
  for (const row of rows.slice(1)) {
    const here = midpoint(row.damage) / midpoint(rows[0].damage);
    const there = midpoint(row.app) / midpoint(rows[0].app);
    ok(`Rage Fist = ${row.value}: ratio against the app`, Math.abs(here - there) <= RATIO_BAND * there, `web ${here.toFixed(3)}x vs app ${there.toFixed(3)}x`);
  }
  model.setEffect(LEFT, "move", "Rage Fist", false);
  check("Rage Fist switched off: ctx", model.contextForSide(LEFT, "Rage Fist", false).attacker_state.times_hit, 0);
  check("Rage Fist switched off: damage", damage(model), "25-30");
  check("Rage Fist switched off: heading", heading(model, LEFT, "Rage Fist"), "Rage Fist KO odds");
}

// ---------------------------------------------------------------------------
// 7. With no move selected the strip covers the whole board, and a new Pokemon
//    on a side starts with nothing chosen.
// ---------------------------------------------------------------------------
{
  const model = build(basculegion, {
    defender: set("Annihilape", "Leftovers", "Defiant", ["Rage Fist", "Bullet Seed", "Protect", "Bulk Up"]),
    index: null,
  });
  check("no move selected: pickers", strip(model), [{ label: "Bullet Seed", options: ["2 hits", "3 hits", "4 hits", "5 hits"], current: "3 hits" }]);
  check("no move selected: chips", model.effectChips(null).map((chip) => chip.label),
    ["Adaptability", "Defiant", "Choice Band", "Last Respects", "Rage Fist"]);
}
{
  // A Metronome-held move only gets a picker where it is being looked at.
  const garchomp = set("Garchomp", "Metronome", "Rough Skin", ["Earthquake", "Dragon Claw", "Protect", "Rock Slide"]);
  const selected = build(garchomp);
  check("Metronome: offered for the selected move", strip(selected).map((row) => row.label), ["Earthquake"]);
  const board = build(garchomp, { index: null });
  check("Metronome: not on every move at once", strip(board), []);
  board.state.effectValues["left:times_used:earthquake"] = 3;
  check("Metronome: shown once chosen", strip(board).map((row) => row.label), ["Earthquake"]);
}
{
  const model = build(basculegion);
  model.setEffectValue(LEFT, "Last Respects", 2);
  model.state.effectValues["right:fainted_allies"] = 1;
  model.clearSideValues(LEFT);
  check("a new Pokemon: its side's amounts are cleared", model.state.effectValues, { "right:fainted_allies": 1 });
}
{
  // Never more than a strip's worth of pickers.
  const model = build(set("Cinccino", "Life Orb", "Technician", ["Bullet Seed", "Rock Blast", "Tail Slap", "Triple Axel"]), {
    defender: set("Maushold", "Wide Lens", "Friend Guard", ["Population Bomb", "Tidy Up", "Beat Up", "Bullet Seed"]),
    index: null,
  });
  ok("strip length is capped", model.countControls().length <= 6, `${model.countControls().length} pickers`);
  const labels = model.countControls().map((row) => row.label);
  ok("both sides are named when they share a move", labels.includes("Our · Bullet Seed") && labels.includes("Opposing · Bullet Seed"), labels.join(", "));
}

console.log(`\n${checked} checks, ${failures.length} failed.`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exitCode = Math.min(failures.length, 255);
