// Playing a turn out: builder/play-anim.js.
//
// The animation is the one part of the Play page that is pure logic sitting on top of the DOM --
// it walks a list of steps and puts classes, widths and sentences onto elements -- so it can be
// checked without a browser by handing it elements that only record what was done to them.
//
// What is checked:
//   1. the steps are walked IN ORDER, and each one touches the Pokemon it names on the side it
//      names -- a step that hits side 1's tag 2 must not touch side 0's tag 2;
//   2. a class goes on for the step and comes off again, so nothing is left shaking;
//   3. health arrives on the bar AND in the text beside it, clamped, and the colour follows it;
//   4. a switch is played on the Pokemon LEAVING (`outTag`) and swaps in the one arriving
//      (`inTag`): the sprite, the name and -- the one that is easy to forget -- the status and
//      stat chips, which belonged to the Pokemon that left;
//   5. a faint leaves the Pokemon down rather than mid-animation;
//   6. `skip()` ends the rest of the turn promptly instead of playing it out;
//   7. a step kind this file has never heard of costs nothing and throws nothing;
//   8. `streamFromRecord` turns a record with no stream on it into one that still plays;
//   9. every beat in play-anim.js has a matching `--beat-*` of the SAME length in play.css. A
//      CSS animation must last exactly as long as the class carrying it: shorter and the tile
//      stands still at the end of its own beat, longer and it is cut off halfway. Two lists of
//      numbers in two files is exactly the kind of thing that drifts.
//
//   node tests/run-play-anim.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BEAT, DEFAULT_PACE, PACES, createTurnPlayer, streamFromRecord } from "../builder/play-anim.js";

const site = dirname(dirname(fileURLToPath(import.meta.url)));

let checked = 0;
const failures = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};
const eq = (label, got, want) => ok(label, Object.is(got, want), `${JSON.stringify(got)} vs ${JSON.stringify(want)}`);

/** Just enough of a class list to be written to and read back. */
function classList(initial = []) {
  const set = new Set(initial);
  return {
    set,
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    contains: (name) => set.has(name),
    toggle: (name, on) => (on ? set.add(name) : set.delete(name)),
  };
}

/** A stand-in for one `.bd-play-mon` button, which records everything done to it. */
function fakeMon(side, tag, { hp = 100, chips = "", name = `mon${tag}`, sprite = `/s/${tag}.png` } = {}) {
  const fill = { style: { width: `${hp}%` }, classList: classList() };
  const text = { textContent: `${hp}%` };
  const nameNode = { textContent: name };
  const chipNode = { textContent: chips };
  const img = { src: sprite, alt: name };
  // A real tile has a style object the attack writes its measured reach onto, and a rect the
  // reach is measured FROM. Both are here so the test exercises the real path rather than the
  // "no layout" fallback.
  const style = { props: {}, setProperty(name, value) { this.props[name] = value; } };
  const el = {
    dataset: { side: String(side), tag: String(tag) },
    style,
    getBoundingClientRect: () => ({ left: side === 0 ? 40 : 240, top: side === 0 ? 400 : 80, width: 160, height: 90 }),
    classList: classList(),
    /** Every class this element has ever worn, in order. The point of the whole harness. */
    history: [],
    querySelector(sel) {
      if (sel === ".bd-play-hp-fill") return fill;
      if (sel === ".bd-play-hp-text") return text;
      if (sel === ".bd-play-mon-name") return nameNode;
      if (sel === ".bd-play-chips") return chipNode;
      if (sel === "img") return img;
      return null;
    },
    parts: { fill, text, name: nameNode, chips: chipNode, img, style },
  };
  const realAdd = el.classList.add;
  el.classList.add = (...names) => {
    names.forEach((n) => el.history.push(n));
    realAdd(...names);
  };
  return el;
}

/** A board of them, and a player wired to it. */
function board(mons) {
  const byKey = new Map(mons.map((m) => [`${m.dataset.side}:${m.dataset.tag}`, m]));
  const captions = [];
  const player = createTurnPlayer({
    monEl: (side, tag) => byKey.get(`${side}:${tag}`) || null,
    monInfo: (side, tag) => ({ tag, name: `in${tag}`, hp: 88, sprite: `/s/in${tag}.png` }),
    // The steps carry tags, never names: the page is what knows who is standing where.
    nameOf: (side, tag) => `s${side}t${tag}`,
    caption: (text, side) => captions.push({ text, side }),
  });
  return { player, captions, byKey };
}

// --- 1, 2: in order, on the right Pokemon, and cleaned up afterwards ---------------------------
{
  const ours = fakeMon(0, 2);
  const theirs = fakeMon(1, 2);
  const { player, captions } = board([ours, theirs]);
  await player.play([
    { kind: "move", side: 0, tag: 2, move: "Earthquake", targetSide: 1, targetTag: 2 },
    { kind: "hit", side: 1, tag: 2, from: 100, to: 40 },
    { kind: "faint", side: 1, tag: 2 },
  ]);
  eq("the attacker tackled, and only the attacker", ours.history.join(","), "is-tackle");
  // The strike has to ARRIVE: the distance is measured between the two tiles, not guessed, so
  // the attacker crosses the field to whoever it actually named.
  eq("and it was aimed at the Pokemon it named", ours.parts.style.props["--to-x"], "200px");
  eq("across the field, not a nudge", ours.parts.style.props["--to-y"], "-320px");

  // A move that strikes nobody must not charge the other team.
  {
    const quiet = fakeMon(0, 5);
    const b = board([quiet]);
    await b.player.play([{ kind: "move", side: 0, tag: 5, move: "Protect", attack: false }]);
    eq("a non-attacking move gathers instead of tackling", quiet.history.join(","), "is-focus");
    const spread = fakeMon(0, 6);
    const c = board([spread]);
    // A spread move carries no target either, so target alone cannot decide this.
    await c.player.play([{ kind: "move", side: 0, tag: 6, move: "Earthquake", attack: true, targetTag: null }]);
    eq("a targetless spread move still tackles", spread.history.join(","), "is-tackle");
  }
  // Side 1's tag 2 is a DIFFERENT Pokemon from side 0's tag 2. Keying on the tag alone put every
  // hit on whichever of the two the page happened to find first.
  ok("the hit landed on the other side's tag 2", theirs.history.includes("is-hit-hard"),
    theirs.history.join(","));
  ok("nothing was left wearing an animation class",
    !ours.classList.contains("is-lunge-up") && !theirs.classList.contains("is-hit-hard"),
    [...ours.classList.set, ...theirs.classList.set].join(","));
  // An ordinary hit is deliberately silent: the bar moving says it, and a line for every hit
  // buries the lines that matter.
  eq("the captions came in order, and an ordinary hit said nothing",
    captions.map((c) => c.text).join(" | "),
    "s0t2 used Earthquake on s1t2 | s1t2 fainted");

  // --- 3, 5 -----------------------------------------------------------------------------------
  eq("the faint left it down", theirs.classList.contains("down"), true);
  eq("the bar ended where the turn left it", theirs.parts.fill.style.width, "0%");
  eq("the text beside it agrees", theirs.parts.text.textContent, "fainted");
}

// --- 3: health, clamped, with the colour following it ------------------------------------------
{
  const mon = fakeMon(0, 0);
  const { player, captions } = board([mon]);
  await player.play([{ kind: "hit", side: 0, tag: 0, from: 100, to: 17 }]);
  eq("a low bar is width 17", mon.parts.fill.style.width, "17%");
  eq("and reads 17%", mon.parts.text.textContent, "17%");
  eq("and is coloured low", mon.parts.fill.classList.contains("low"), true);
  await player.play([{ kind: "hit", side: 0, tag: 0, from: 17, to: 140 }]);
  eq("over a hundred is clamped", mon.parts.fill.style.width, "100%");
  eq("and is no longer low", mon.parts.fill.classList.contains("low"), false);
  await player.play([{ kind: "hit", side: 0, tag: 0, from: 100, to: -20 }]);
  eq("below zero is clamped too", mon.parts.fill.style.width, "0%");

  // The end of the turn: a burn takes, Leftovers give, and the two do not look the same.
  captions.length = 0;
  await player.play([
    { kind: "residual", side: 0, tag: 0, from: 0, to: 12 },
    { kind: "residual", side: 0, tag: 0, from: 12, to: 6 },
  ]);
  ok("recovering and being worn down are different animations",
    mon.history.includes("is-mend") && mon.history.includes("is-chip"), mon.history.join(","));
  eq("and are said differently", captions.map((c) => c.text).join(" | "),
    "s0t0 recovered | s0t0 was worn down");
}

// --- 4: a switch brings in a different Pokemon, not a renamed one -------------------------------
{
  const mon = fakeMon(0, 1, { hp: 30, chips: "brn · Atk -1", name: "Incineroar" });
  mon.classList.add("down");
  const { player, captions } = board([mon]);
  // A switch names BOTH ends and is played on the seat the leaver is standing in.
  await player.play([{ kind: "switch", side: 0, outTag: 1, inTag: 3 }]);
  eq("the switch was said from both ends", captions[0]?.text, "s0t1 went back, and out came s0t3");
  eq("the sprite is the one coming in", mon.parts.img.src, "/s/in3.png");
  eq("so is the name", mon.parts.name.textContent, "in3");
  eq("and the health", mon.parts.fill.style.width, "88%");
  // The burn and the Attack drop belonged to the one that left.
  eq("the status and stat chips went with it", mon.parts.chips.textContent, "");
  eq("the tag now points at what is standing there", mon.dataset.tag, "3");
}

// --- 6: skip ------------------------------------------------------------------------------------
{
  const mon = fakeMon(0, 0);
  const { player } = board([mon]);
  const long = Array.from({ length: 40 }, () => ({ kind: "hit", side: 0, tag: 0, from: 100, to: 50 }));
  const started = process.hrtime.bigint();
  const run = player.play(long);
  player.skip();
  await run;
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // Forty hits is sixteen seconds played out. Skipped, it must be essentially instant.
  ok("skip ended the turn promptly", ms < 1200, `${Math.round(ms)}ms`);
  eq("and the board still ended where the turn left it", mon.parts.fill.style.width, "50%");
  eq("the player is not left marked as running", player.running, false);
}

// --- 7: something this file has never seen ------------------------------------------------------
{
  const mon = fakeMon(0, 0);
  const { player, captions } = board([mon]);
  let threw = "";
  try {
    await player.play([
      { kind: "weatherChangedSomehow", side: 0, tag: 0, text: "Sand whipped up" },
      { kind: "move", side: 0, tag: 9 },
      null,
    ]);
  } catch (error) {
    threw = String(error && error.message);
  }
  eq("an unknown kind did not throw", threw, "");
  eq("but its sentence was still said", captions[0]?.text, "Sand whipped up");
  eq("and a step naming a Pokemon that is not there did not throw", threw, "");
}

// --- 8: a record with no stream on it still plays ------------------------------------------------
{
  const record = {
    plays: [
      { side: 0, text: "Garchomp: Earthquake → Farigiraf" },
      { side: 1, text: "Farigiraf switched out for Torkoal" },
    ],
    damage: [{ side: 1, name: "Farigiraf", from: 100, to: 42 }],
    notes: ["Garchomp protected"],
    fainted: [{ side: 1, name: "Torkoal" }],
  };
  const tags = (side, name) => ({ Garchomp: 0, Farigiraf: 1, Torkoal: 2 })[name] ?? null;
  const steps = streamFromRecord(record, tags);
  eq("every play, hit, note and faint is a step", steps.length, 5);
  eq("the moves come first", steps[0].kind, "move");
  eq("the name is read out of the play text", steps[0].tag, 0);
  // "Farigiraf switched out for Torkoal" must resolve to Farigiraf, not to the whole sentence.
  eq("a switch line resolves to the one that left", steps[1].tag, 1);
  eq("the damage became a hit", steps[2].kind, "hit");
  eq("carrying where it started", steps[2].from, 100);
  eq("and where it ended", steps[2].to, 42);
  eq("the faint is last", steps.at(-1).kind, "faint");
  eq("and names the right Pokemon", steps.at(-1).tag, 2);

  const mons = [fakeMon(0, 0), fakeMon(1, 1), fakeMon(1, 2)];
  const { player } = board(mons);
  let threw = "";
  try { await player.play(steps); } catch (error) { threw = String(error && error.message); }
  eq("and the whole thing plays", threw, "");
  eq("leaving the hit Pokemon where the record says", mons[1].parts.fill.style.width, "42%");
}

// --- 9: a replacement arrives in the seat the fainted one left ----------------------------------
{
  // The board the animation runs over is the board from BEFORE the turn, so the Pokemon coming
  // in after a knockout has no tile of its own on it. It takes the fainted one's.
  const down = fakeMon(0, 1, { name: "Sneasler" });
  down.classList.add("down");
  const other = fakeMon(0, 0, { name: "Garchomp" });
  const byKey = new Map([["0:1", down], ["0:0", other]]);
  const captions = [];
  const player = createTurnPlayer({
    monEl: (side, tag) => byKey.get(`${side}:${tag}`) || null,
    monInfo: (side, tag) => ({ tag, name: `in${tag}`, hp: 100, sprite: `/s/in${tag}.png` }),
    freeSeat: (side) => (side === 0 ? down : null),
    nameOf: (side, tag) => `s${side}t${tag}`,
    caption: (text, side) => captions.push({ text, side }),
  });
  await player.play([{ kind: "send", side: 0, tag: 4 }]);
  eq("it was said", captions[0]?.text, "s0t4 comes out");
  ok("and it came in somewhere", down.history.includes("is-enter"), down.history.join(","));
  eq("taking the fainted one's tile", down.parts.name.textContent, "in4");
  eq("with its own sprite", down.parts.img.src, "/s/in4.png");
  eq("and no longer down", down.classList.contains("down"), false);
  ok("the Pokemon still standing was not disturbed", other.history.length === 0, other.history.join(","));
}

// --- 10: the two lists of durations agree -------------------------------------------------------
{
  const css = readFileSync(join(site, "builder", "play.css"), "utf8");
  const declared = new Map();
  for (const [, name, ms] of css.matchAll(/--beat-([a-z]+):\s*(\d+)ms/g)) declared.set(name, Number(ms));
  ok("play.css declares a --beat-* for every step kind", declared.size >= Object.keys(BEAT).length,
    `${declared.size} in css vs ${Object.keys(BEAT).length} in js`);
  for (const [kind, ms] of Object.entries(BEAT)) {
    eq(`--beat-${kind} matches BEAT.${kind}`, declared.get(kind), ms);
  }
  // What the viewer actually experiences is the base beat TIMES the pace, and the pace control
  // defaults to 2. The bases were halved to make the movement twice as quick while the turn
  // still takes as long to read -- so the effective lengths must not have moved.
  ok("a turn still holds the screen long enough to read",
    BEAT.hit * DEFAULT_PACE >= 700 && BEAT.faint * DEFAULT_PACE >= 900,
    `hit ${BEAT.hit * DEFAULT_PACE}ms, faint ${BEAT.faint * DEFAULT_PACE}ms at pace ${DEFAULT_PACE}`);
  // And the strike itself is the quick one: it is movement, not something to be read.
  ok("but the strike itself is quick", BEAT.move * DEFAULT_PACE <= 400,
    `${BEAT.move * DEFAULT_PACE}ms`);
  // The pace control's own labels, which the page renders straight out of this list.
  eq("the pace options are Fast, Steady and Slow",
    PACES.map(([, label]) => label).join("/"), "Fast/Steady/Slow");
  // Every effect the player asks for must actually be drawn by the stylesheet, or the step plays
  // as a pause with nothing on screen.
  for (const fx of ["fx-protect", "fx-impact", "fx-impact-hard", "fx-miss", "fx-flinch", "fx-chip", "fx-mend", "fx-faint", "fx-arrive", "fx-focus"]) {
    ok(`play.css draws .${fx}`, css.includes(`.bd-play-fx.${fx}`), "no rule for it");
  }
  for (const cls of ["is-tackle", "is-focus", "is-hit", "is-hit-hard", "is-miss", "is-protect", "is-flinch", "is-chip", "is-mend", "is-faint", "is-leave", "is-enter"]) {
    ok(`play.css styles .${cls}`, css.includes(`.bd-play-mon.${cls}`), "no rule for it");
  }
  // Protect is meant to read as a screen in FRONT of the Pokemon, which means the facing edge
  // depends on which side of the field it is standing on.
  ok("the Protect screen faces the other team",
    css.includes('[data-side="0"] .bd-play-fx.fx-protect') && css.includes('[data-side="1"] .bd-play-fx.fx-protect'),
    "both sides must anchor the bright edge");
}

// --- the result ----------------------------------------------------------------------------------
if (failures.length) {
  console.error(`FAIL  ${failures.length} of ${checked} checks`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`PASS  ${checked} checks  (builder/play-anim.js)`);
