// Playing a turn out, rather than printing it.
//
// The worker resolves a whole turn at once and hands back an ORDERED list of what happened. This
// walks that list in front of the person: the attacker leans in, the target shakes, the bar
// slides down, something faints. It is the same information the log holds -- it simply arrives in
// the order it happened, at a speed a person can follow.
//
// WHY IT DRIVES THE DOM DIRECTLY. The board on screen is the board from BEFORE the turn, and the
// board the worker sent is the board after it. Rendering either one shows a finished turn; the
// interesting part is the bit in between, which no single view contains. So the steps are played
// as changes on top of the old board -- a width here, a class there -- and the real view is
// committed in one render at the end. That render is the authority: however the animation ends
// up looking, the board that stays on screen is the worker's.
//
// NOTHING HERE MAY HOLD THE GAME UP. Every wait returns instantly once `skip()` has been called,
// and the caller clears the animation whatever happens, so a step kind this file has never heard
// of costs a few hundred milliseconds of nothing rather than a board that will not move again.

/**
 * How much longer than the base each beat runs. 2 is the default pace -- the base lengths read as
 * a flicker -- and the page offers 1 and 3 beside it.
 */
export const DEFAULT_PACE = 2;
/** What the pace control offers, as [value, label]. */
export const PACES = [[1, "Fast"], [2, "Steady"], [3, "Slow"]];

/**
 * How long each kind of step holds the screen, in milliseconds, BEFORE the pace multiplies it.
 *
 * These are also written in play.css as `--beat-*`, because a CSS animation has to last exactly
 * as long as the class that carries it: shorter and the tile sits still at the end of its own
 * beat, longer and the animation is cut off halfway. `tests/run-play-anim.mjs` reads the
 * stylesheet and asserts the two lists agree, so they cannot drift apart.
 */
export const BEAT = {
  send: 300,
  // The attack itself is QUICK -- out, contact, back. Read off the reference recording: the
  // strike is the one thing in a turn that is not unhurried, because it is movement rather than
  // something to be read.
  move: 150,
  hit: 400,
  crit: 480,
  residual: 320,
  miss: 340,
  protect: 360,
  flinch: 340,
  faint: 520,
  switch: 420,
  // The one that is NOT halved: a line of text takes as long to read as it ever did, and this is
  // the beat that exists purely to be read.
  note: 560,
};

/** A hit worth a bigger shake, in percentage points of health. */
const BIG = 35;

/**
 * `monEl(side, tag)` finds the element, `monInfo(side, tag)` describes the one coming in on a
 * switch, `freeSeat(side)` finds the tile a replacement arrives in, `sideBox(side)` gives that
 * side's area so a spread move can be aimed at it, `nameOf(side, tag)` names one for a caption,
 * and `caption(text, side)` says it.
 *
 * Names are looked up rather than carried on the steps: the page already knows what is standing
 * in each seat, and a name baked into a step at the moment it was recorded would be the name of
 * whatever stood there THEN.
 */
/**
 * How one step is SAID -- by the animation as a caption, and by the log as a transcript line.
 *
 * One place on purpose: the panel used to be built from a different description of the same turn
 * and the two disagreed about both the wording and the order.
 */
export function sentenceFor(step, nameOf) {
  if (!step) return "";
  if (step.text) return step.text;
  const name = (side, tag) => (nameOf ? nameOf(side, tag) : "") || "It";
  const who = name(step.side, step.tag);
  switch (step.kind) {
    case "send": return `${who} comes out`;
    case "move": {
      const at = step.targetTag === null || step.targetTag === undefined
        ? ""
        : ` on ${name(step.targetSide, step.targetTag)}`;
      return `${who} used ${step.move}${at}`;
    }
    // An ordinary hit says nothing: the bar moving IS the sentence, and a line of text for
    // every hit buries the lines that matter. A critical hit is the exception, because it is
    // the one thing about a hit that a player cannot read off the bar.
    case "hit": return step.crit ? "A critical hit!" : "";
    case "residual":
      if (step.to > step.from) return `${who} recovered`;
      return `${who} was worn down`;
    // The three results the reference recording always says out loud, because none of them can
    // be read off a health bar: nothing happened, and the reason differs every time.
    case "miss": return `It missed ${who}!`;
    case "protect": return `${who} protected itself!`;
    case "flinch": return `${who} flinched and could not move!`;
    case "faint": return `${who} fainted`;
    case "switch": {
      const out = name(step.side, step.outTag);
      const into = name(step.side, step.inTag);
      return `${out} went back, and out came ${into}`;
    }
    default: return "";
  }
}

export function createTurnPlayer({ monEl, monInfo, freeSeat, sideBox, nameOf, caption, pace = DEFAULT_PACE }) {
  // Every beat below is the BASE length multiplied by this. The stylesheet multiplies its own
  // `--beat-*` by `--beat-scale` in exactly the same way, and the page sets the two together, so
  // an animation always lasts precisely as long as the class carrying it.
  const paced = (ms) => Math.round(ms * (Number(pace) > 0 ? Number(pace) : DEFAULT_PACE));
  let skipping = false;
  let running = false;

  // The beat currently in flight, so `skip` can end it instead of waiting it out. Without this
  // skipping only stopped the beats that had not STARTED, so a click during a long one still sat
  // there for the rest of it -- and the slower the pace, the longer that was.
  let endNow = null;
  const wait = (ms) => new Promise((resolve) => {
    if (skipping) { resolve(); return; }
    const timer = setTimeout(() => { endNow = null; resolve(); }, ms);
    endNow = () => { clearTimeout(timer); endNow = null; resolve(); };
  });

  /**
   * Put a class on a tile for a beat and take it off again, and optionally draw an effect in
   * front of it for the same beat.
   *
   * The two are separate because they do different jobs: the tile MOVES -- it tackles, recoils,
   * slumps -- and the layer DRAWS -- a screen, a burst, a streak. Trying to do both on one
   * element meant every effect had to be expressible as a transform on a sprite, which is why
   * Protect used to be a glow that read as "this one is selected".
   */
  async function beat(el, className, ms, fxClass = "") {
    if (!el) { await wait(Math.min(ms, 160)); return; }
    const layer = fxClass ? el.querySelector(".bd-play-fx") : null;
    el.classList.add(className);
    if (layer) layer.classList.add(fxClass);
    await wait(ms);
    el.classList.remove(className);
    if (layer) layer.classList.remove(fxClass);
  }

  /**
   * Point a tile's strike at what it is hitting.
   *
   * The distance is measured between the two tiles rather than guessed, so the attack arrives
   * wherever the other Pokemon happens to be standing -- and a spread move, which names nobody,
   * is aimed at the middle of the far side instead. Written onto the element as custom
   * properties, because the keyframes that carry the motion live in the stylesheet.
   */
  function aimAt(el, item) {
    // No style to write on means a tile that is not in a document -- nothing to animate, and
    // certainly nothing worth throwing the rest of the turn away for.
    if (!el || !el.style || typeof el.style.setProperty !== "function") return;
    let dx = 0;
    let dy = item.side === 0 ? -150 : 150;
    try {
      const here = el.getBoundingClientRect();
      const named = (item.targetTag === null || item.targetTag === undefined)
        ? null : monEl(item.targetSide, item.targetTag);
      const there = named ? named.getBoundingClientRect() : (sideBox ? sideBox(1 - item.side) : null);
      if (there && there.width) {
        // Stop just short of the middle of it, the way a Pokemon stops ON the other rather than
        // through it.
        dx = Math.round((there.left + there.width / 2) - (here.left + here.width / 2));
        dy = Math.round((there.top + there.height / 2) - (here.top + here.height / 2));
      }
    } catch { /* no layout to measure: the default carries it towards the other side */ }
    el.style.setProperty("--to-x", `${dx}px`);
    el.style.setProperty("--to-y", `${dy}px`);
  }

  /** The damage, as a number that floats off the Pokemon that took it. */
  function showDamage(el, lost, crit) {
    if (!el || !(lost > 0)) return;
    const layer = el.querySelector(".bd-play-fx");
    if (!layer || typeof document === "undefined" || !layer.append) return;
    const tag = document.createElement("span");
    tag.className = `bd-play-damage${crit ? " crit" : ""}`;
    tag.textContent = `-${Math.round(lost)}%`;
    layer.append(tag);
    setTimeout(() => tag.remove(), 1400);
  }

  /** Move a health bar to where the turn left it. The width is transitioned in CSS. */
  function setHp(el, hp) {
    if (!el || !Number.isFinite(hp)) return;
    const bar = Math.max(0, Math.min(100, Math.round(hp)));
    const fill = el.querySelector(".bd-play-hp-fill");
    if (fill) {
      fill.style.width = `${bar}%`;
      fill.classList.toggle("low", bar <= 20);
      fill.classList.toggle("mid", bar > 20 && bar <= 50);
    }
    const text = el.querySelector(".bd-play-hp-text");
    if (text) text.textContent = bar <= 0 ? "fainted" : `${bar}%`;
  }

  /** Swap a standing Pokemon for the one coming in. */
  function swapIn(el, info) {
    if (!el || !info) return;
    const img = el.querySelector("img");
    if (img && info.sprite) {
      img.src = info.sprite;
      img.alt = "";
    }
    const name = el.querySelector(".bd-play-mon-name");
    if (name) name.textContent = info.name || "";
    const chips = el.querySelector(".bd-play-chips");
    // The one that left took its stat drops and its status with it; leaving them under the new
    // sprite says the incoming Pokemon is burned when it is not.
    if (chips) chips.textContent = "";
    el.classList.remove("down");
    if (Number.isFinite(info.hp)) setHp(el, info.hp);
    el.dataset.tag = String(info.tag ?? el.dataset.tag);
  }

  const say = (step) => sentenceFor(step, nameOf);
  async function step(item) {
    // A switch names the one LEAVING in `outTag`; every other step uses `tag`.
    const seat = item.kind === "switch" ? item.outTag : item.tag;
    const el = monEl(item.side, seat);
    const line = say(item);
    if (line) caption(line, item.side);
    switch (item.kind) {
      case "send": {
        // A replacement is not on the board this animation is running over -- the Pokemon it
        // replaces is, fainted. So it arrives in that tile rather than nowhere at all.
        const seat = el || (freeSeat ? freeSeat(item.side) : null);
        if (seat && seat !== el) swapIn(seat, monInfo(item.side, item.tag));
        await beat(seat, "is-enter", paced(BEAT.send), "fx-arrive");
        return;
      }
      case "move": {
        // A move that strikes drives at what it named and ARRIVES there. One that does not
        // (Protect, Tailwind, Swords Dance) gathers itself in place instead, because a Pokemon
        // putting up a shield charging the other team reads as an attack that then did nothing.
        // `attack` comes from the game; a stream without it is the fallback one, which cannot
        // know, so it keeps the old behaviour.
        if (item.attack === false) {
          await beat(el, "is-focus", paced(BEAT.move) * 2, "fx-focus");
          return;
        }
        aimAt(el, item);
        await beat(el, "is-tackle", paced(BEAT.move));
        return;
      }
      case "hit": {
        const lost = Number.isFinite(item.from) && Number.isFinite(item.to) ? item.from - item.to : 0;
        setHp(el, item.to);
        // The number that floats off it. The bar says the same thing, afterwards and more
        // slowly; this is what makes a hit land.
        showDamage(el, lost, item.crit);
        // A critical hit gets its own beat and its own burst whatever it took: it is the reason
        // the turn went the way it did, and reading it off the bar afterwards is not possible.
        if (item.crit) {
          await beat(el, "is-hit-hard", paced(BEAT.crit), "fx-crit");
          return;
        }
        const hard = lost >= BIG;
        await beat(el, hard ? "is-hit-hard" : "is-hit", paced(BEAT.hit), hard ? "fx-impact-hard" : "fx-impact");
        return;
      }
      case "residual": {
        // The weather, a burn, Leftovers. Smaller than being hit, because it is.
        const up = item.to > item.from;
        setHp(el, item.to);
        await beat(el, up ? "is-mend" : "is-chip", paced(BEAT.residual), up ? "fx-mend" : "fx-chip");
        return;
      }
      case "miss":
        await beat(el, "is-miss", paced(BEAT.miss), "fx-miss");
        return;
      case "protect":
        // The screen goes up in FRONT of it -- see `.bd-play-fx.fx-protect` in play.css, which
        // anchors the bright edge to whichever side of the tile faces the other team.
        await beat(el, "is-protect", paced(BEAT.protect), "fx-protect");
        return;
      case "flinch":
        await beat(el, "is-flinch", paced(BEAT.flinch), "fx-flinch");
        return;
      case "faint":
        setHp(el, Number.isFinite(item.to) ? item.to : 0);
        if (el) {
          const layer = el.querySelector(".bd-play-fx");
          el.classList.add("is-faint");
          if (layer) layer.classList.add("fx-faint");
          await wait(paced(BEAT.faint));
          el.classList.remove("is-faint");
          if (layer) layer.classList.remove("fx-faint");
          el.classList.add("down");
        } else {
          await wait(160);
        }
        return;
      case "switch": {
        if (el) {
          el.classList.add("is-leave");
          await wait(paced(BEAT.switch) / 2);
          el.classList.remove("is-leave");
          swapIn(el, monInfo(item.side, item.inTag));
          await beat(el, "is-enter", paced(BEAT.switch) / 2, "fx-arrive");
        } else {
          await wait(160);
        }
        return;
      }
      default:
        // A note, or a kind this file has not met. The sentence is the whole point of it.
        await wait(line ? paced(BEAT.note) : 0);
    }
  }

  return {
    get running() { return running; },
    skip() {
      skipping = true;
      if (endNow) endNow();
    },
    async play(steps) {
      running = true;
      skipping = false;
      try {
        for (const item of steps || []) {
          if (!item) continue;
          await step(item);
        }
      } finally {
        running = false;
        skipping = false;
      }
    },
  };
}

/**
 * A stream, for a turn record that has not got one.
 *
 * The record has always carried what was chosen, what the health was before and after, and what
 * fainted -- just not in the order it happened. This puts those into the step shape so the turn
 * still plays out as a sequence rather than appearing all at once, and it is what runs if the
 * game ever answers without a stream. It is deliberately plain: the moves in the order they were
 * chosen, then the damage, then the faints.
 */
export function streamFromRecord(record, tagsByName) {
  const steps = [];
  const tagOf = (side, name) => tagsByName?.(side, name);
  for (const play of record?.plays || []) {
    const name = String(play.text || "").split(":")[0].split(" switched")[0].trim();
    steps.push({ kind: "move", side: play.side, tag: tagOf(play.side, name), text: play.text });
  }
  for (const hit of record?.damage || []) {
    steps.push({
      kind: hit.to > hit.from ? "residual" : "hit",
      side: hit.side,
      tag: tagOf(hit.side, hit.name),
      from: hit.from,
      to: hit.to,
    });
  }
  for (const note of record?.notes || []) steps.push({ kind: "note", text: note });
  for (const gone of record?.fainted || []) {
    steps.push({ kind: "faint", side: gone.side, tag: tagOf(gone.side, gone.name), name: gone.name });
  }
  return steps;
}
