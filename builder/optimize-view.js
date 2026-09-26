// Team Evaluation > Optimize: the options, the running state and the result of
// builder/optimize-deep.js for each team member, drawn as
//
//   a one-line summary        Matchup score 57 → 63 (+6) and what it now survives, KOs, outspeeds
//   Previously and now        the trade in one sentence ("23 more Speed and 14 more Attack,
//                             paid for with…"), then the spread as a shape: a bar per stat
//                             with what it gained or gave up at its tip, the 66 Stat Points
//                             as a budget bar per side, both Natures, and the moves
//   What changes in battle    threat by threat, better and worse, in plain sentences
//   Speed                     only when Speed changed: the Top-X Pokemon it now outspeeds or not
//   Moves tested              which moves were kept and the best other attacks
//   Apply / Discard
//
// Styles: builder/optimize.css. The page (builder-page.js) owns the state and the worker.

import { MAX_BONUS_STAT_POINTS } from "./engine.js";
import { h, segmented, sprite, switchRow } from "./ui.js";

const STATS = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];
/** The same six, spelled out: the short labels head the bars, these go in the sentence. */
const STAT_WORDS = ["HP", "Attack", "Defense", "Special Attack", "Special Defense", "Speed"];
const MAX_POINTS = MAX_BONUS_STAT_POINTS;
const CHANGE_LIMIT = 8;

export const OPTIMIZE_DEFAULTS = Object.freeze({ depth: "deep", testMoves: true, keepNature: false, keepSpeed: false });

const fmt = (value, digits = 1) => Number(value || 0).toFixed(digits);
const signed = (value, digits = 1) => {
  const v = Number(value || 0);
  const text = Math.abs(v).toFixed(digits);
  if (Number(text) === 0) return `±${text}`;
  return `${v > 0 ? "+" : "−"}${text}`;
};
const count = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString("en-US")} ${n === 1 ? one : many}`;
const pct = (value) => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;
const spreadText = (bonuses) => (bonuses || []).join("/");
/** "A", "A & B", "A, B & C": a plain English list for a button label. */
const listText = (parts) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} & ${parts.at(-1)}`);
const toneOf = (delta) => (delta > 0 ? "up" : delta < 0 ? "down" : "same");
/** The same list inside a sentence, where "&" would read as an abbreviation. */
const andList = (parts) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

/** The explanation above the members. */
export function optimizeIntro(topX) {
  return h("p", { class: "bd-section-note bd-opt-intro" },
    `Optimize tries Stat Point spreads, every Nature and, if you let it, new attacking moves for one Pokémon against the Top ${topX} Meta. `,
    "Each option is scored by how its matchups play out: who moves first, and how many hits each side needs to knock the other out, in normal play and with your team's Tailwind, Trick Room or weather. ",
    "Common Pokémon count more. Another Nature, less Speed or new moves are only suggested when they clearly score better. ",
    "A move used by 95% or more of that Pokémon on the ladder is never swapped out, unless it needs weather or terrain your team does not set up. ",
    h("strong", {}, "Nothing changes until you press Apply."));
}

/** Quick / Deep and the three switches. */
function optionsBar(options, onOptions) {
  return h("div", { class: "bd-opt-options" },
    h("div", { class: "bd-opt-depth" },
      h("span", { class: "bd-field-label" }, "Search"),
      segmented([["quick", "Quick"], ["deep", "Deep"]], options.depth, (depth) => onOptions({ depth }), { "aria-label": "How deep to search" }),
      h("small", { class: "bd-note" }, options.depth === "quick"
        ? "About 5 to 20 seconds per Pokémon: fewer Natures and coarser steps. Longer with a larger Top Meta and on phones."
        : "About 15 seconds to a minute per Pokémon: every Nature worth trying, finer steps and more move sets. Longer with a larger Top Meta and on phones.")),
    h("div", { class: "bd-opt-switches" },
      switchRow("Test new moves", options.testMoves, (testMoves) => onOptions({ testMoves }), { hint: "Try the attacks it is recorded with in the move slots that are not doing a support job." }),
      switchRow("Keep current Nature", options.keepNature, (keepNature) => onOptions({ keepNature }), { hint: "Only tune the Stat Points (and moves)." }),
      switchRow("Keep Speed", options.keepSpeed, (keepSpeed) => onOptions({ keepSpeed }), { hint: "Never suggest a spread that is slower than the current one." })));
}

/**
 * The whole Optimize tab. A member's `teamChanged` says its result was found with other
 * teammates than the team has now (their Tailwind, Trick Room or weather feed the score).
 * @param {{members: Array<{slot:number, name:string, sprite:string, set:object, state:object|null, kept:Set<string>, teamChanged?:boolean}>,
 *   options: object, topX: number, spriteFor: Function, onOptions: Function, onRun: Function, onStop: Function,
 *   onApply: Function, onDiscard: Function, onKeepMove: Function}} props
 */
export function optimizeView(props) {
  const wrap = h("div", { class: "bd-opt" }, optimizeIntro(props.topX), optionsBar(props.options, props.onOptions));
  for (const member of props.members) wrap.append(memberCard(member, props));
  return wrap;
}

function memberCard(member, props) {
  const { slot, set, state } = member;
  const result = state?.result;
  const running = Boolean(state?.running);
  const card = h("section", { class: "bd-opt-member", dataset: { optSlot: String(slot) } });
  const button = running
    ? h("button", { type: "button", class: "ghost-button compact", disabled: Boolean(state.stopping), onclick: () => props.onStop(slot) }, state.stopping ? "Stopping…" : "Stop")
    : h("button", { type: "button", class: `${result ? "ghost-button" : "primary-button"} compact`, onclick: () => props.onRun(slot) }, result ? "Run again" : "Optimize");
  card.append(h("div", { class: "bd-opt-head" },
    sprite(member.sprite, "", 40, "bd-sprite bd-opt-head-sprite"),
    h("div", { class: "bd-opt-head-text" },
      h("h3", {}, member.name),
      h("p", {}, `${set.nature || "Serious"} · ${spreadText(set.bonuses)} · ${(set.moves || []).filter(Boolean).join(", ") || "no moves"}`)),
    button));
  if (running) {
    card.append(progressBlock(state));
    return card;
  }
  // (Element.append would print a null as the text "null".)
  const keep = !result && props.options.testMoves ? keepRow(member, props) : null;
  if (keep) card.append(keep);
  if (result && member.teamChanged && !result.error) {
    card.append(h("p", { class: "bd-note bd-opt-stale" }, "Your other team members changed since this ran, and they shape the score (their Tailwind, Trick Room or weather). Run it again to refresh."));
  }
  if (result) card.append(resultBlock(member, result, props));
  return card;
}

/** Moves the player can pin so Optimize never replaces them. */
function keepRow(member, props) {
  const moves = (member.set.moves || []).filter(Boolean);
  if (!moves.length) return null;
  return h("div", { class: "bd-opt-keep" },
    h("span", { class: "bd-note" }, "Tap a move to keep it:"),
    h("div", { class: "bd-opt-move-row" }, moves.map((move) => {
      const kept = member.kept?.has(move);
      return h("button", {
        type: "button",
        class: `bd-opt-move toggle ${kept ? "kept" : ""}`,
        "aria-pressed": kept ? "true" : "false",
        title: kept ? "Kept: Optimize will not replace it" : "Optimize may replace it with a better attack",
        onclick: () => props.onKeepMove(member.slot, move),
      }, kept ? `✓ ${move}` : move);
    })));
}

/** The progress bar, the phase and what it is doing. Updated in place by the page. */
export function progressBlock(state) {
  const fraction = Math.max(0, Math.min(1, Number(state.fraction) || 0));
  return h("div", { class: "bd-opt-run bd-progress", role: "status" },
    h("div", { class: "bd-progress-bar" }, h("i", { style: { width: `${Math.round(fraction * 100)}%` } })),
    h("p", { class: "bd-note bd-opt-run-text" }, state.stopping ? "Stopping: finishing with the best result so far…" : state.status || "Preparing…"));
}

/** Patch a running card's bar and text without redrawing the page. */
export function updateProgress(host, state) {
  const bar = host?.querySelector(".bd-opt-run .bd-progress-bar i");
  const text = host?.querySelector(".bd-opt-run-text");
  if (!bar || !text) return false;
  bar.style.width = `${Math.round(Math.max(0, Math.min(1, Number(state.fraction) || 0)) * 100)}%`;
  text.textContent = state.stopping ? "Stopping: finishing with the best result so far…" : state.status || "Preparing…";
  return true;
}

// --- the result ------------------------------------------------------------------------

function resultBlock(member, result, props) {
  const block = h("div", { class: "bd-opt-result" });
  // An error, or a run that ended before it had a set to compare (an empty slot, no meta).
  if (result.error || !result.before || !result.after) {
    block.append(h("p", { class: `bd-opt-message ${result.error ? "bad" : ""}` }, result.message || "Optimize could not finish."),
      h("div", { class: "bd-opt-actions" }, h("button", { type: "button", class: "ghost-button compact", onclick: () => props.onDiscard(member.slot) }, "Close")));
    return block;
  }
  const ui = (member.state.ui ||= {});
  const parts = [summary(result)];
  if (result.ok) {
    parts.push(compareTable(result), changesSection(result, ui, props));
    if (result.speed?.changed) parts.push(speedSection(result, ui));
  } else if (result.message) {
    parts.push(h("p", { class: "bd-opt-message" }, result.message));
  }
  if (result.trade_off) parts.push(tradeOffSection(member, result, props));
  if (result.moves_tested) parts.push(movesSection(member, result, props));
  parts.push(actions(member, result, props));
  // (A section with nothing to show is null; Element.append would print it as "null".)
  block.append(...parts.filter(Boolean));
  return block;
}

/** The team's speed plan, for the "moves first" texts (Trick Room for a Trick Room team). */
const planText = (result) => (result.plan_context?.trick_room ? "in Trick Room, your team's speed plan" : "in normal play");

function summary(result) {
  const { before, after } = result;
  const stats = result.stats || {};
  const chips = [];
  const chip = (label, was, now, higherIsBetter = true) => {
    if (was === now) return;
    const better = higherIsBetter ? now > was : now < was;
    chips.push(h("span", { class: `bd-opt-chip ${better ? "good" : "bad"}` }, `${label} ${was} → ${now}`));
  };
  const threats = after?.counts?.threats || 0;
  const topMeta = stats.top_meta || result.speed?.top_meta || 0;
  if (result.ok) {
    chip("Survives a hit from", before.counts.survives, after.counts.survives);
    chip("OHKOs", before.counts.ohkos, after.counts.ohkos);
    chip("2HKOs", before.counts.twohkos, after.counts.twohkos);
    // In the team's speed plan: under its Trick Room the slower Pokémon moves first.
    chip(result.plan_context?.trick_room ? "Moves first in Trick Room vs" : "Outspeeds", before.counts.outspeeds, after.counts.outspeeds);
  }
  const tested = [
    count(stats.spreads, "spread"),
    count(stats.natures, "Nature"),
    stats.move_sets ? count(stats.move_sets, "move set") : "",
    `${fmt(stats.seconds)} s`,
    `Top ${topMeta}${stats.working_set < stats.threat_sets ? ` (searched against the ${stats.working_ranks} most common, checked against all)` : ""}`,
  ].filter(Boolean).join(" · ");
  return h("div", { class: "bd-opt-summary" },
    h("p", { class: "bd-opt-headline" },
      "Matchup score ",
      h("strong", {}, fmt(before.score)),
      result.ok ? [" → ", h("strong", {}, fmt(after.score)), " ", h("span", { class: `bd-opt-delta ${toneOf(result.delta)}` }, signed(result.delta))] : null,
      h("small", { class: "bd-note" }, ` against the Top ${topMeta}${threats ? ` (${threats} Pokémon)` : ""}`)),
    chips.length ? h("div", { class: "bd-opt-chips" }, chips) : null,
    pointsNote(result),
    guaranteedCostNote(result),
    result.ok && result.moves_from_common?.length
      ? h("p", { class: "bd-note bd-opt-points" }, `It has no moves yet, so Optimize tested it with its most common ones. They are marked new below, and Apply adds them.`)
      : null,
    h("p", { class: "bd-note bd-opt-tested" }, `Tested ${tested}.`),
    stats.stopped ? h("p", { class: "bd-note bd-opt-stopped" }, "Stopped early: this is the best result found before you pressed Stop.") : null,
    !stats.stopped && stats.clock_cut ? h("p", { class: "bd-note" }, "This device ran out of time before the search finished, so it looked at fewer options than usual. Deep, or a faster device, may find more.") : null,
    !stats.stopped && !stats.clock_cut && stats.out_of_budget ? h("p", { class: "bd-note" }, "The search tried as many options as this depth allows; Deep looks further than Quick.") : null);
}

/**
 * The score now covers the move the rule adds, so it can come out lower than the saved
 * set's. Why the suggestion is still the one to use.
 */
function guaranteedCostNote(result) {
  const added = (result.guaranteed?.added || []).map((a) => a.move);
  if (!result.ok || !added.length || !(result.delta < 0) || !(result.guaranteed.delta < 0)) return null;
  const one = added.length === 1;
  return h("p", { class: "bd-note bd-opt-points" },
    `The score above is lower than your saved set's because ${added.join(" and ")} ${one ? "scores less against the Top Meta than the move it replaces" : "score less against the Top Meta than the moves they replace"}. `
    + `Nearly every team of this Pokémon still runs ${one ? "it" : "them"}, so the suggestion keeps ${one ? "it" : "them"}; the spread below is the best one found beside ${one ? "it" : "them"}.`);
}

/** A set over 66 Stat Points, or one that leaves points unused: what the suggestion does about it. */
function pointsNote(result) {
  const points = result.points;
  if (!points || !result.ok) return null;
  const plural = (n) => `${n} Stat Point${n === 1 ? "" : "s"}`;
  if (points.kind === "legal") {
    return h("p", { class: "bd-opt-message bad bd-opt-points" },
      `This set has ${points.total} Stat Points, ${points.over} more than the 66 allowed (pasted Showdown EVs often do this). The spread below is legal: apply it before you use this set.`,
      // A guaranteed move that costs score is named by its own note instead (the points are then not the reason).
      result.delta < 0 && !(result.guaranteed?.delta < 0) ? " Its score is lower than the pasted set's because the extra points are gone; no legal spread keeps them." : "");
  }
  if (points.kind === "fill") {
    return h("p", { class: "bd-note bd-opt-points" }, `This set leaves ${plural(points.unspent)} unused. The spread below spends them where they help most and changes nothing else.`);
  }
  return null;
}

/**
 * Previously and now: the spread as a shape.
 *
 * A player does not read six rows of digits to learn what their Pokemon became — they
 * want its silhouette. So the six final stats are bars on one shared scale: the solid
 * bar is always what the stat is NOW, a striped tip is the part it just gained, and a
 * hollow tip past the end of the bar is the part it gave up. The digits are all still
 * there, quietly, beside each bar.
 *
 * Under the shape sit the two things that produced it: the 66 Stat Points as one budget
 * bar per side (the same length both times when nothing was unspent, so the eye reads a
 * re-spend, not a gain), and the Nature with the stats it raises and lowers.
 *
 * Nothing here colours a direction: less Speed for more bulk is a trade, not a loss.
 * Direction is carried by the stripe/hollow pattern, by ↑ ↓ and by the signed number, so
 * it survives one dark theme and a colour-blind reader. ▲ and ▼ stay the Nature's marks.
 */
function compareTable(result) {
  const { before, after } = result;
  const shifts = STATS.map((label, index) => ({
    label,
    index,
    stat: after.stats[index] - before.stats[index],
    points: after.bonuses[index] - before.bonuses[index],
  }));
  const natureChanged = before.nature !== after.nature;
  const spreadChanged = natureChanged || shifts.some((shift) => shift.points);
  const moves = movesCompare(result);
  // A move the saved set was missing that nearly every team of this Pokemon runs.
  const guaranteed = result.guaranteed?.note ? h("p", { class: "bd-note" }, result.guaranteed.note) : null;
  // Its Nature and all of its Stat Points already are the ones we would pick: printing
  // them twice, side by side, would be the same numbers twice. The spread is shown once
  // instead, and only the moves are compared.
  if (!spreadChanged) {
    return h("div", { class: "bd-opt-compare bd-opt-unchanged" },
      h("h4", {}, "The spread stays as it is"),
      h("p", { class: "bd-note" }, "Its Nature and all of its Stat Points are already the best we found, so there is nothing to compare. Only the moves change."),
      spreadOnce(after),
      moves, guaranteed);
  }
  return h("div", { class: "bd-opt-compare" },
    h("h4", {}, "Previously and now"),
    tradeStory(before, after, shifts, natureChanged),
    shapeTable(before, after, shifts),
    h("div", { class: "bd-opt-ledger" }, budgetBlock(before, after), natureBlock(before, after, natureChanged)),
    moves, guaranteed);
}

/** The Nature's ▲ / ▼ on the stat it moves, or nothing. */
function natureMark(side, index) {
  const [up, down] = side.nature_effect || [-1, -1];
  if (index !== up && index !== down) return null;
  const mark = index === up ? "up" : "down";
  return h("span", { class: `bd-nature-mark ${mark}`, title: mark === "up" ? "Raised by the Nature" : "Lowered by the Nature" }, mark === "up" ? "▲" : "▼");
}

const pointWord = (n) => `${n} Stat Point${n === 1 ? "" : "s"}`;

/** "a" / "a and b" / "a, b and c", as nodes, so each part can keep its own markup. */
function joinNodes(parts) {
  const out = [];
  parts.forEach((part, i) => {
    if (i) out.push(i === parts.length - 1 ? " and " : ", ");
    out.push(part);
  });
  return out;
}

/** "23 more Speed": the size in the mono face, and the two never break apart. */
const amount = (shift, word) => h("span", { class: "bd-opt-amount" }, h("b", {}, String(Math.abs(shift.stat))), word, STAT_WORDS[shift.index]);

/**
 * The change in one plain sentence, built from the two sides: what the Pokémon gained
 * and what it paid for it, in the final stats a player feels in battle.
 *
 * "paid for with" states a trade and judges neither side — less Speed for more bulk is
 * a trade, not a loss — and the sentence is assembled from the numbers, never written by
 * hand, so it cannot drift from the bars underneath it.
 */
function leadSentence(before, after, shifts, natureChanged) {
  const gains = shifts.filter((shift) => shift.stat > 0).sort((a, b) => b.stat - a.stat);
  const costs = shifts.filter((shift) => shift.stat < 0).sort((a, b) => a.stat - b.stat);
  const head = natureChanged ? [h("b", {}, before.nature), " to ", h("b", {}, after.nature), ": "] : [];
  const line = (...parts) => h("p", { class: "bd-opt-story-lead" }, ...head, ...parts);
  if (gains.length && costs.length) {
    return line(...joinNodes(gains.map((s) => amount(s, " more "))), ", paid for with ", ...joinNodes(costs.map((s) => amount(s, " "))), ".");
  }
  if (gains.length) return line(...joinNodes(gains.map((s) => amount(s, " more "))), ", and nothing is given up.");
  if (costs.length) return line(...joinNodes(costs.map((s) => amount(s, " less "))), ", and nothing is gained.");
  // Points that move without moving the stat they are spent on, or two Natures that both
  // raise and lower nothing: the stats are the same twelve numbers, and the line below says why.
  return line(natureChanged ? "every stat keeps the number it had." : "Every stat keeps the number it had.");
}

/**
 * Under it, quieter: where the Stat Points went, and what the Nature does now that it did
 * not do before — the two panels below this block, said in words. Stat Points and final
 * stats are different things — a stat can lose a point and still end up higher because the
 * Nature now raises it — so this line only ever talks about points, and the line above it
 * only about stats.
 */
function tradeStory(before, after, shifts, natureChanged) {
  const out = shifts.filter((shift) => shift.points < 0);
  const into = shifts.filter((shift) => shift.points > 0);
  const outSum = out.reduce((sum, shift) => sum - shift.points, 0);
  const inSum = into.reduce((sum, shift) => sum + shift.points, 0);
  const named = (list) => andList(list.map((shift) => (list.length > 1 ? `${shift.label} (${Math.abs(shift.points)})` : shift.label)));
  const lines = [];
  if (outSum && inSum && outSum === inSum) lines.push(`${pointWord(inSum)} move out of ${named(out)} into ${named(into)}.`);
  else if (outSum && inSum) lines.push(`${pointWord(outSum)} come out of ${named(out)} and ${pointWord(inSum)} go into ${named(into)}.`);
  else if (inSum) lines.push(`${pointWord(inSum)} more are spent, on ${named(into)}.`);
  else if (outSum) lines.push(`${pointWord(outSum)} come off ${named(out)}.`);
  if (natureChanged) {
    const [wasUp, wasDown] = before.nature_effect || [-1, -1];
    const [isUp, isDown] = after.nature_effect || [-1, -1];
    if (isUp < 0) lines.push(`${after.nature} raises and lowers nothing, where ${before.nature} raised ${STATS[wasUp]} and lowered ${STATS[wasDown]}.`);
    else if (wasUp < 0) lines.push(`${after.nature} raises ${STATS[isUp]} and lowers ${STATS[isDown]}, where ${before.nature} raised and lowered nothing.`);
    else {
      // Two Natures can share the stat they raise or the stat they lower: that half of the
      // sentence then has to say "still", not "instead of" the same stat. "now" belongs to
      // the first half that did change, so the sentence does not say it twice.
      const raiseMoved = isUp !== wasUp;
      const raises = raiseMoved ? `now raises ${STATS[isUp]} instead of ${STATS[wasUp]}` : `still raises ${STATS[isUp]}`;
      const lowers = isDown === wasDown
        ? `still lowers ${STATS[isDown]}`
        : `${raiseMoved ? "" : "now "}lowers ${STATS[isDown]} instead of ${STATS[wasDown]}`;
      lines.push(`The Nature ${raises} and ${lowers}.`);
    }
  }
  return h("div", { class: "bd-opt-story" },
    leadSentence(before, after, shifts, natureChanged),
    lines.length ? h("p", { class: "bd-opt-story-detail" }, lines.join(" ")) : null);
}

/** One row per stat: the bar is the stat now, the tip is what moved. */
function shapeTable(before, after, shifts) {
  // One scale for all twelve numbers, so the six bars read as this Pokemon's shape.
  const axis = Math.max(1, ...before.stats, ...after.stats);
  const pos = (value) => `${(Math.max(0, value) / axis) * 100}%`;
  const rows = shifts.map((shift) => {
    const was = before.stats[shift.index];
    const now = after.stats[shift.index];
    const grew = now > was;
    const lost = now < was;
    return h("div", { class: `bd-opt-srow ${shift.stat || shift.points ? "changed" : "same"}`, role: "row" },
      h("span", { class: "bd-opt-srow-stat", role: "rowheader" }, shift.label),
      h("span", { class: "bd-opt-track", role: "cell" },
        // The solid bar is always the stat as it is now.
        h("i", { class: "bd-opt-now", style: { width: pos(now) } }),
        grew ? h("i", { class: "bd-opt-gain", style: { left: pos(was), width: pos(now - was) } }) : null,
        lost ? h("i", { class: "bd-opt-loss", style: { left: pos(now), width: pos(was - now) } }) : null),
      h("span", { class: "bd-opt-vals", role: "cell" },
        h("b", {}, h("span", { class: "bd-opt-sp" }, String(after.bonuses[shift.index])), " · ", String(now), natureMark(after, shift.index)),
        h("small", {}, "was ", h("span", { class: "bd-opt-sp" }, String(before.bonuses[shift.index])), " · ", String(was), natureMark(before, shift.index))),
      shiftMark(shift.stat, shift.points));
  });
  return h("div", { class: "bd-opt-shape", role: "table", "aria-label": "Every stat previously and now" },
    h("div", { class: "bd-opt-shape-head", role: "row" },
      h("span", { role: "columnheader" }, "Stat"),
      h("span", { role: "columnheader" }, `Final stat at level 50 — one scale, 0 to ${axis}`),
      h("span", { role: "columnheader" }, "Stat Points · stat"),
      h("span", { role: "columnheader" }, "Change")),
    rows);
}

/** ↑ +14 / ↓ −12 / same. One colour for both: up is not always better. */
function shiftMark(delta, points) {
  const value = delta || points;
  if (!value) return h("span", { class: "bd-opt-d", role: "cell" }, h("span", { class: "bd-opt-shift same" }, "same"));
  const up = value > 0;
  return h("span", { class: "bd-opt-d", role: "cell" },
    h("span", { class: `bd-opt-shift ${up ? "up" : "down"}` },
      h("i", { class: "bd-opt-arrow", "aria-hidden": "true" }, up ? "↑" : "↓"),
      `${up ? "+" : "−"}${Math.abs(value)}${delta ? "" : " SP"}`));
}

/**
 * The 66 Stat Points as one bar per side, cut into the stats they are spent on. Both
 * bars are drawn on the same track, so a spread that only moves its points keeps the
 * same length and the eye sees the re-spend. The 66 line is always drawn, which is what
 * a pasted set with more than 66 points crosses.
 */
function budgetBlock(before, after) {
  const cap = Math.max(MAX_POINTS, before.total, after.total);
  // Only the Nature moved: the second bar would be the first one again.
  const same = String(before.bonuses) === String(after.bonuses);
  return h("div", { class: "bd-opt-budget" },
    h("span", { class: "bd-field-label" }, "The 66 Stat Points"),
    same ? budgetRow("Both", after, cap) : budgetRow("Previously", before, cap),
    same ? null : budgetRow("Now", after, cap),
    same ? h("small", { class: "bd-note" }, "Unchanged: the same points, in the same stats.") : null,
    cap > MAX_POINTS ? h("small", { class: "bd-note" }, "The line is the 66 a legal set may spend.") : null);
}

function budgetRow(label, side, cap) {
  const track = h("span", { class: "bd-opt-budget-track" });
  STATS.forEach((stat, index) => {
    const points = side.bonuses[index];
    if (!points) return;
    // The shade is the stat's own, the same on both bars, so a block that shrinks on one
    // and grows on the other is the same block. It is one hue: no stat is "good".
    // A block narrower than about an eighth of the bar cannot hold its label legibly.
    const wide = points / cap >= 0.12;
    track.append(h("i", { class: "bd-opt-budget-seg", style: { width: `${(points / cap) * 100}%`, "--i": String(index) }, title: `${stat}: ${pointWord(points)}` },
      wide ? h("span", {}, `${stat} ${points}`) : null));
  });
  const unspent = MAX_POINTS - side.total;
  if (unspent > 0) track.append(h("i", { class: "bd-opt-budget-free", style: { width: `${(unspent / cap) * 100}%` }, title: `${pointWord(unspent)} not spent` }));
  if (cap > MAX_POINTS) track.append(h("i", { class: "bd-opt-budget-cap", style: { left: `${(MAX_POINTS / cap) * 100}%` } }));
  return h("div", { class: "bd-opt-budget-row" },
    h("span", { class: "bd-opt-budget-key" }, label),
    track,
    h("span", { class: "bd-opt-budget-total" }, h("b", {}, String(side.total)), "/66"));
}

/** Both Natures with what each raises and lowers. */
function natureBlock(before, after, natureChanged) {
  return h("div", { class: "bd-opt-natures" },
    h("span", { class: "bd-field-label" }, "Nature"),
    h("div", { class: "bd-opt-nature-swap" },
      natureSide(before, "was"),
      natureChanged ? h("i", { class: "bd-opt-nature-to", "aria-hidden": "true" }, "→") : null,
      natureChanged ? natureSide(after, "now") : null),
    natureChanged ? null : h("small", { class: "bd-note" }, "Unchanged."));
}

function natureSide(side, kind) {
  const [up, down] = side.nature_effect || [-1, -1];
  return h("span", { class: `bd-opt-nature-side ${kind}` },
    h("b", {}, side.nature),
    h("small", {}, up >= 0
      ? [h("span", { class: "bd-nature-mark up" }, "▲"), STATS[up], " ", h("span", { class: "bd-nature-mark down" }, "▼"), STATS[down]]
      : "raises and lowers nothing"));
}

/** The spread printed once, for a set whose Nature and Stat Points do not change. */
function spreadOnce(side) {
  return h("div", { class: "bd-opt-once" },
    h("div", { class: "bd-opt-once-head" },
      h("b", {}, side.nature),
      h("small", {}, ...(() => {
        const [up, down] = side.nature_effect || [-1, -1];
        return up >= 0
          ? [h("span", { class: "bd-nature-mark up" }, "▲"), STATS[up], " ", h("span", { class: "bd-nature-mark down" }, "▼"), STATS[down]]
          : ["raises and lowers nothing"];
      })()),
      h("span", { class: "bd-opt-once-total" }, h("b", {}, String(side.total)), "/66 Stat Points")),
    h("div", { class: "bd-opt-once-stats" }, STATS.map((stat, index) => h("span", { class: "bd-opt-once-stat" },
      h("span", { class: "bd-opt-once-key" }, stat),
      h("span", { class: "bd-opt-sp" }, String(side.bonuses[index])), " · ", h("b", {}, String(side.stats[index])),
      natureMark(side, index)))));
}

/**
 * The moves the set had and the moves it would have - or, when the four are the same four,
 * one row of them: two identical lists side by side is the same thing printed twice.
 */
function movesCompare(result) {
  const { before, after } = result;
  const had = (before.moves || []).filter(Boolean);
  if (had.length && String(before.moves) === String(after.moves)) {
    return h("div", { class: "bd-opt-moves-compare one" },
      h("div", {}, h("span", { class: "bd-field-label" }, "Moves, unchanged"), moveChips(after.moves, [], "new")));
  }
  return h("div", { class: "bd-opt-moves-compare" },
    h("div", {}, h("span", { class: "bd-field-label" }, "Previously"), had.length ? moveChips(before.moves, result.removed, "gone") : h("p", { class: "bd-note" }, "No moves")),
    h("div", {}, h("span", { class: "bd-field-label" }, "Now"), moveChips(after.moves, result.added, "new")));
}

function moveChips(moves, highlighted, tone) {
  const marked = new Set((highlighted || []).map((m) => m.toLowerCase()));
  return h("div", { class: "bd-opt-move-row" }, (moves || []).filter(Boolean).map((move) => h("span", { class: `bd-opt-move ${marked.has(move.toLowerCase()) ? tone : ""}` }, move)));
}

/** What changes in battle: better and worse, one threat per row. */
function changesSection(result, ui, props) {
  const better = (result.changes || []).filter((c) => c.tone === "better");
  const worse = (result.changes || []).filter((c) => c.tone === "worse");
  if (!better.length && !worse.length) return null;
  ui.changeTab ||= better.length ? "better" : "worse";
  const list = h("div", { class: "bd-opt-change-list" });
  const paint = () => {
    const rows = ui.changeTab === "worse" ? worse : better;
    const shown = ui.allChanges ? rows : rows.slice(0, CHANGE_LIMIT);
    list.replaceChildren(...shown.map((row) => changeRow(row, props, result)));
    if (rows.length > CHANGE_LIMIT) {
      list.append(h("button", { type: "button", class: "ghost-button compact bd-opt-more", onclick: () => { ui.allChanges = !ui.allChanges; paint(); } },
        ui.allChanges ? "Show fewer" : `Show all ${rows.length}`));
    }
    if (!rows.length) list.append(h("p", { class: "bd-note" }, ui.changeTab === "worse" ? "Nothing gets worse." : "Nothing gets better."));
  };
  paint();
  return h("div", { class: "bd-opt-section bd-opt-changes" },
    h("h4", {}, "What changes in battle"),
    h("p", { class: "bd-note" }, `Threat by threat (on the item set that changes most): what it now survives or knocks out, who moves first, and the chance to win the one-on-one race to the KO ${planText(result)}. The biggest changes come first, and each row sits on the side its own lines say. “Both ways” means it gains one way and gives something up the other, in its lines or in the 1-on-1 chance beside them.`),
    segmented([["better", `Better (${better.length})`], ["worse", `Worse (${worse.length})`]], ui.changeTab, (tab) => { ui.changeTab = tab; ui.allChanges = false; paint(); }, { "aria-label": "Better or worse matchups" }),
    list);
}

function changeRow(row, props, result) {
  const src = props.spriteFor?.(row.species, row.form, row.item);
  return h("div", { class: `bd-opt-change ${row.tone}` },
    sprite(src, "", 28, "bd-sprite bd-opt-change-sprite"),
    h("div", { class: "bd-opt-change-text" },
      h("div", { class: "bd-opt-change-name" }, h("span", { class: "bd-opt-rank" }, `#${row.rank}`), h("strong", {}, row.name),
        // A matchup that gains one way and loses another: both lines are printed below.
        row.trade ? h("span", { class: "bd-opt-tag", title: "Gains in one way, gives something up in another" }, "both ways") : null),
      (row.lines || []).map((line) => h("p", { class: `bd-opt-line ${line.tone}` }, line.text, line.detail ? h("small", {}, ` ${line.detail}`) : null))),
    h("span", { class: `bd-opt-win ${row.win_after > row.win_before + 0.005 ? "up" : row.win_after < row.win_before - 0.005 ? "down" : "same"}`, title: `The chance to win the one-on-one race to the KO ${planText(result)}` },
      h("small", {}, "1-on-1"), `${pct(row.win_before)} → ${pct(row.win_after)}`));
}

/** The Top-X Speed list rows now outsped or no longer outsped, per speed context. */
function speedSection(result, ui) {
  const contexts = (result.speed.contexts || []).filter((c) => c.before !== c.after || c.now_faster.length || c.now_slower.length || c.now_tied.length);
  if (!contexts.length) return null;
  // Normal opens first: it is the context the "Speed 97 → 120" heading above reads, and the
  // one every player checks before their team's own Tailwind or Trick Room, which is a tap away.
  if (!contexts.some((c) => c.id === ui.speedContext)) {
    ui.speedContext = (contexts.find((c) => c.id === "normal") || contexts.find((c) => c.id === result.plan_context?.id) || contexts[0]).id;
  }
  const body = h("div", { class: "bd-opt-speed-body" });
  const paint = () => {
    const context = contexts.find((c) => c.id === ui.speedContext) || contexts[0];
    const faster = context.trick_room ? "Now moves before" : "Now faster than";
    const slower = context.trick_room ? "Now moves after" : "Now slower than";
    body.replaceChildren(...[
      h("p", { class: "bd-opt-speed-line" }, `${context.label}: Speed `, h("strong", {}, String(context.before)), " → ", h("strong", {}, String(context.after)),
        context.trick_room ? h("small", { class: "bd-note" }, " Under Trick Room the slower Pokémon moves first.") : null),
      h("div", { class: "bd-opt-speed-cols" },
        speedList(`${faster} (${context.now_faster.length})`, context.now_faster, "good"),
        speedList(`${slower} (${context.now_slower.length})`, context.now_slower, "bad")),
      context.now_tied.length ? h("p", { class: "bd-note" }, `Now speed-tied with ${context.now_tied.map(tierName).join(", ")}.`) : null,
      h("p", { class: "bd-note" }, `Still ${context.trick_room ? "moves before" : "faster than"} ${context.still_faster} · still ${context.trick_room ? "moves after" : "slower than"} ${context.still_slower}${context.still_tied ? ` · still tied with ${context.still_tied}` : ""} of the Top ${result.speed.top_meta} Speed list.`),
    ].filter(Boolean));
  };
  paint();
  return h("div", { class: "bd-opt-section bd-opt-speed" },
    h("h4", {}, `Speed ${result.speed.before} → ${result.speed.after}`),
    h("p", { class: "bd-note" }, `The Top ${result.speed.top_meta} Pokémon of the Speed list (the Top Meta size from Settings), on their most common set and their Choice Scarf or Speed-Ability versions.`),
    contexts.length > 1 ? segmented(contexts.map((c) => [c.id, c.label]), ui.speedContext, (id) => { ui.speedContext = id; paint(); }, { "aria-label": "Speed context" }) : null,
    body);
}

const tierName = (row) => `${row.name}${row.variant ? ` (${row.variant})` : ""}`;

function speedList(title, rows, tone) {
  return h("div", { class: `bd-opt-speed-list ${tone}` },
    h("h5", {}, title),
    rows.length
      ? h("ul", {}, rows.map((row) => h("li", {},
        h("span", { class: "bd-opt-rank" }, row.rank ? `#${row.rank}` : ""),
        h("span", { class: "bd-opt-speed-name" }, row.name, row.variant ? h("span", { class: "bd-tier-variant" }, row.variant) : null),
        h("b", {}, String(row.speed)))))
      : h("p", { class: "bd-note" }, "None."));
}

/**
 * The best option the margins held back. Its reasons compare it with the suggestion when
 * there is one (so nothing the two share is listed), else with the current set.
 */
function tradeOffSection(member, result, props) {
  const trade = result.trade_off;
  const text = `${trade.nature_text} · ${spreadText(trade.bonuses)}${trade.moves?.length ? ` · ${trade.moves.join(", ")}` : ""}`;
  const reasons = trade.reasons.join("; ") || "the gain is small for the change";
  const against = trade.compared_with === "suggestion"
    ? [text, " scores ", h("strong", {}, fmt(trade.over_pick)), ` more than the suggestion above (${signed(trade.delta)} against your current set). Compared with the suggestion: ${reasons}.`]
    : [text, " scores ", h("strong", {}, signed(trade.delta)), ` over your current set, but: ${reasons}.`];
  return h("div", { class: "bd-opt-section bd-opt-trade" },
    h("h4", {}, "Closest trade-off"),
    h("p", {}, against),
    h("p", { class: "bd-note" }, "It was not suggested because a change like this has to score clearly better first. Use it if that trade suits your team."),
    h("button", { type: "button", class: "ghost-button compact", onclick: () => props.onApply(member.slot, trade, "trade") }, "Use this instead"));
}

function movesSection(member, result, props) {
  const tested = result.moves_tested;
  const kept = (tested.kept || []).map((k) => `${k.move} (${k.reason})`).join(", ");
  const options = tested.options || [];
  return h("div", { class: "bd-opt-section bd-opt-moves" },
    h("h4", {}, "Moves tested"),
    h("p", { class: "bd-note" }, tested.note || [
      tested.tested ? `${count(tested.tested, "attack")} it is recorded with, in ${count(tested.combos, "combination")} for its ${count(tested.free, "free slot")}.` : "",
      kept ? `Kept as they are: ${kept}.` : "",
    ].filter(Boolean).join(" ")),
    options.length ? h("ul", { class: "bd-opt-move-options" }, options.map((option) => h("li", {},
      h("span", { class: "bd-opt-move-swap" },
        option.added.map((m) => h("span", { class: "bd-opt-move new" }, m)),
        h("small", {}, " for "),
        option.removed.map((m) => h("span", { class: "bd-opt-move gone" }, m))),
      h("span", { class: `bd-opt-delta ${toneOf(option.delta)}` }, signed(option.delta)),
      tested.spread ? h("button", { type: "button", class: "ghost-button compact", title: `Apply these moves with ${tested.spread.nature} · ${spreadText(tested.spread.bonuses)}`, onclick: () => props.onApply(member.slot, { nature: tested.spread.nature, bonuses: tested.spread.bonuses, moves: option.moves }, "moves") }, "Use") : null))) : null,
    options.length && tested.spread ? h("p", { class: "bd-note" }, `Scores are matchup-score points against ${movesReference(result)}, with ${tested.spread.nature} · ${spreadText(tested.spread.bonuses)}; Use applies that spread with those moves.`) : null);
}

/** What the "Moves tested" scores are measured against: the set the move search started from. */
function movesReference(result) {
  if (result.moves_from_common?.length) return "its most common moves";
  const added = (result.guaranteed?.added || []).map((a) => a.move);
  if (added.length) return `the current moves with ${added.join(" and ")} in`;
  return "the current moves";
}

function actions(member, result, props) {
  const bar = h("div", { class: "bd-opt-actions" });
  if (result.ok) {
    bar.append(h("button", { type: "button", class: "primary-button compact", onclick: () => props.onApply(member.slot, result.after, "all") }, "Apply"));
    const statsOnly = (result.alternatives || []).find((a) => a.kind === "stats");
    if (result.moves_changed && statsOnly) {
      // This button writes the moves the search started from, which is the player's own set
      // plus any move the guaranteed-move rule added to it. "only" would then be untrue, so
      // the label names those moves and the tooltip spells the whole set out.
      const added = (result.guaranteed?.added || []).map((a) => a.move).filter(Boolean);
      const withMoves = added.length ? (statsOnly.moves || []).join(", ") : "your current moves";
      bar.append(h("button", {
        type: "button", class: "ghost-button compact",
        title: `${statsOnly.nature_text} · ${spreadText(statsOnly.bonuses)} with ${withMoves} (${signed(statsOnly.delta)})`,
        onclick: () => props.onApply(member.slot, statsOnly, "stats"),
      }, added.length
        ? `Apply ${listText(["Stat Points", "Nature", ...added])} (${signed(statsOnly.delta)})`
        : `Apply Stat Points & Nature only (${signed(statsOnly.delta)})`));
    }
  }
  // (A set whose spread is kept says so in the breakdown above, under "The spread stays as
  // it is", which is where a player is looking when they ask the question.)
  bar.append(h("button", { type: "button", class: "ghost-button compact", onclick: () => props.onDiscard(member.slot) }, result.ok ? "Discard" : "Close"));
  return bar;
}
