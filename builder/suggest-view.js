// Suggested Pokémon: the ranked list and each suggestion's breakdown.
//
//   closed row  one sprite, the action, its meta rank, "Found in similar team", the set,
//               the moves, how much of the threat list it answers, the estimated score
//               changes, the score and Use
//   opened      What it does (one sentence), Score changes (the estimate the ranking uses
//               and, once checked, the full Team Evaluation of the team it would make),
//               Why it fits, Team Building Check changes, then the three views on the
//               threats, the set, and how the score is built
//
// The three views each say what they measure and in what unit, and each is one section:
//
//   Answers in the full Team Evaluation   every one of the team's worst threats played out
//                                         both ways; unit: hits needed to remove, and who
//                                         moves first. The answers first, the rest quieter.
//   Threat scores after adding it         the whole team re-evaluated with this Pokémon in
//                                         the slot; unit: threat score out of 100, lower is
//                                         better. Lowered and raised are two labelled groups
//                                         with their counts, and a net figure.
//   Type matchup only                     the threats whose typing flatters it while the calc
//                                         refuses the matchup, each with the one clause that
//                                         explains the disagreement. Never green.
//
// Colour is only used where one side is plainly better: a trade and a chip stay neutral, so
// nothing reads as a win that is not one. The hit counts and the threat-score moves are the
// figures the score came from, so they are what is set large; the words around them recede.
//
// The rows come from the worker's "suggestions" request (builder/team-suggest.js
// suggestionForPage); the Team Evaluation check of each shown row arrives after the
// list (TeamSuggestions.projectedDetail) and is merged in by builder-page.js.
//
// The rows carry the engine's Pokémon names ("Mega Salamence"), as the parity suites check
// them. They are shown in Showdown spelling ("Salamence-Mega", as on the Threats tab)
// through the page's helpers.name (one name) and helpers.text (names inside a sentence).

import { calcTail, isShownResult } from "./calc-format.js";
import { h, segmented, sprite } from "./ui.js";

const METRICS = [["synergy", "Synergy", "Syn"], ["offense", "Offense", "Off"], ["defense", "Defense", "Def"], ["speed", "Speed", "Spe"], ["archetype", "Archetype", "Arch"]];
const IMPACT_ORDER = { good: 0, yellow: 1, red: 2, neutral: 3 };
const IMPACT_LIMIT = 7;
const STATUS = { good: "Good", yellow: "Needs Attention", red: "Problem" };
const STAT_SHORT = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];

const signed = (value, digits = 1) => {
  const v = Number(value) || 0;
  const text = Math.abs(v).toFixed(digits);
  return v > 0.049 ? `+${text}` : v < -0.049 ? `−${text}` : `±${(0).toFixed(digits)}`;
};
const tone = (value) => (Number(value) > 0.049 ? "up" : Number(value) < -0.049 ? "down" : "flat");
const fixed1 = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(1));

/**
 * Whether the score was cut at 100: only a score of 100 is, and only when the layers'
 * raw adjustments add up to more (a layer can hit 100 mid-way and a later one take points
 * off again; that row is not "capped").
 */
export function cappedAt100(row) {
  return Number(row?.score) >= 99.95 && Number(row?.score_uncapped) > Number(row?.score) + 0.05;
}

/** The name mappers a view uses: helpers.name / helpers.text, or the names as they are. */
function namers(helpers = {}) {
  const one = typeof helpers.name === "function" ? (value) => (value ? helpers.name(String(value)) : value) : (value) => value;
  const text = typeof helpers.text === "function" ? (value, extra = []) => helpers.text(String(value ?? ""), extra) : (value) => String(value ?? "");
  return { one, text };
}

/** Every Pokémon name a row carries in its fields, so a sentence that repeats one is renamed too. */
function rowNames(row) {
  const projected = row?.projected && !row.projected.error ? row.projected : null;
  return [
    ...(row?.answers || []), ...(row?.answer_calcs || []).map((c) => c.threat), row?.swap_target, row?.name, row?.form,
    ...(row?.threat_verdicts || []).map((e) => e.threat),
    ...(projected ? [...(projected.answers || []), ...(projected.lowered || []), ...(projected.raised || [])].map((t) => t.threat) : []),
  ].filter(Boolean).map(String);
}

/**
 * The Suggestions tab.
 * @param {object|null} result  {rows, scanned, targets, empty_slot, scope, checking}
 * @param {object} helpers  {spriteFor, onUse(row), running, progress, status, onRun, full,
 *   scope, onScope(scope), boxCount, ui: {open:Set, all:Set}, name(value), text(value, extraNames)}
 */
export function suggestionsView(result, helpers) {
  const { running, progress = 0, status = "", onRun, full } = helpers;
  const { one } = namers(helpers);
  const controls = scopeControls(helpers, result ? "Run again" : "Find suggestions");
  if (running) {
    return h("div", { class: "bd-list" },
      h("div", { class: "bd-progress" },
        h("div", { class: "bd-progress-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(progress * 100)) }, h("i", { style: { width: `${Math.round(progress * 100)}%` } })),
        h("p", { class: "bd-note", "aria-live": "polite" }, status ? namers(helpers).text(status) : "Testing every ranked Pokémon…")));
  }
  if (!result) {
    return h("div", { class: "bd-gate" },
      h("h3", {}, full ? "Who would improve this team?" : "Who fits the open slot?"),
      h("p", {}, full
        ? "Tests every ranked Pokémon in place of the three members the failing Team Building Checks point at, and keeps each one's best swap. Each candidate plays its most common set."
        : "Tests every ranked Pokémon in the open slot on its most common set, and ranks them by what they add: Team Building Checks fixed, threats answered, typing, Speed and archetype fit."),
      h("p", { class: "bd-note" }, "The best 40 are then played out against the team's 8 worst threats with the full calcs, both ways, and the list is ranked on what they actually answer rather than on one move they carry."),
      h("p", { class: "bd-note" }, "The best 14 are then checked one by one against the full Team Evaluation of the team they would make."),
      h("p", { class: "bd-note" }, "A move used by 95% or more of that Pokémon on the ladder is always kept on the final set, unless it needs weather or terrain the team does not set up."),
      h("div", { class: "bd-gate-actions" }, controls));
  }
  const scopeText = result.scope === "box" ? "Pokémon from your Box" : "Pokémon";
  const head = h("div", { class: "bd-checks-head bd-sg-head" },
    h("p", { class: "bd-section-note" }, `${result.scanned} ${scopeText} tested${result.targets?.filter(Boolean).length ? ` in place of ${result.targets.filter(Boolean).map(one).join(", ")}` : ""}. Open a suggestion for the reasons behind it.`),
    controls);
  if (!result.rows.length) {
    return h("div", { class: "bd-list" }, head,
      h("div", { class: "bd-gate" }, h("h3", {}, "No suggestions"), h("p", {}, result.scope === "box"
        ? "Nothing in your Box improves this team under the current settings (or every Box Pokémon is already on it)."
        : "Nothing in the ranked meta improves this team under the current settings.")));
  }
  const list = h("div", { class: "bd-list bd-sg-list" }, head,
    checkingNote(result),
    result.known_teams === false ? h("p", { class: "bd-note" }, "The tournament teams could not be loaded, so no suggestion gets the “Found in similar team” bonus this time.") : null,
    result.rows.map((row) => suggestionRow(row, helpers, result)));
  /** Redraws one row (its Team Evaluation check arrived) and the progress line, nothing else. */
  list.refreshRow = (key) => {
    const row = result.rows.find((r) => String(r.key || r.action) === String(key));
    const old = [...list.querySelectorAll(".bd-sg-row")].find((node) => node.dataset.sgKey === String(key));
    if (row && old) old.replaceWith(suggestionRow(row, helpers, result));
    list.querySelector(".bd-sg-checking")?.replaceWith(checkingNote(result));
  };
  return list;
}

/** The line that says the Team Evaluation check is still running (replaced in place as it finishes). */
export function checkingNote(result) {
  const pending = (result?.rows || []).filter((row) => !row.projected).length;
  return h("p", { class: "bd-note bd-sg-checking", "aria-live": "polite" }, result?.checking && pending
    ? `Checking each suggestion against the full Team Evaluation… ${result.rows.length - pending} of ${result.rows.length} done.`
    : "");
}

function scopeControls({ scope = "all", onScope, boxCount = 0, onRun }, label) {
  const choice = segmented([["all", "All Pokémon"], ["box", boxCount ? `Only Box (${boxCount})` : "Only Box"]], boxCount ? scope : "all", (value) => {
    if (value === "box" && !boxCount) {
      // Disabled: keep "All Pokémon" marked.
      [...choice.querySelectorAll("button")].forEach((button, i) => {
        button.classList.toggle("on", i === 0);
        button.setAttribute("aria-checked", i === 0 ? "true" : "false");
      });
      return;
    }
    onScope?.(value);
  }, { "aria-label": "Which Pokémon to test" });
  // With an empty Box there is nothing to limit the test to.
  if (!boxCount) {
    const only = [...choice.querySelectorAll("button")][1];
    if (only) {
      only.disabled = true;
      only.setAttribute("aria-disabled", "true");
      only.title = "Your Box is empty: add Pokémon on the Box tab to test only those.";
    }
  }
  return h("div", { class: "bd-sg-controls" }, choice,
    h("button", { type: "button", class: "primary-button compact", onclick: onRun }, label));
}

/** One suggestion: the closed summary and the breakdown. */
export function suggestionRow(row, helpers, result = null) {
  const { spriteFor, onUse, ui } = helpers;
  const key = String(row.key || row.action);
  const open = Boolean(ui?.open?.has(key));
  const details = h("details", {
    class: "bd-suggestion bd-sg-row",
    open,
    dataset: { sgKey: key },
    ontoggle: (event) => {
      if (!ui?.open) return;
      if (event.currentTarget.open) ui.open.add(key);
      else ui.open.delete(key);
    },
  });
  const { one } = namers(helpers);
  const components = row.components || {};
  const deltas = METRICS.slice(0, 4).filter(([k]) => components[k]).map(([k, , short]) => h("span", { class: `bd-sg-delta ${tone(components[k].delta)}`, title: `${k[0].toUpperCase()}${k.slice(1)}: estimated ${components[k].current} → ${components[k].projected}` }, `${short} ${signed(components[k].delta)}`));
  const rank = row.source === "box" ? "Box" : row.meta_rank ? `Meta #${row.meta_rank}` : "";
  const helps = (row.answers || []).slice(0, 4).map(one);
  // V511: the closed row says how much of the threat list it answers, not only who.
  const measured = Number(row.threats_measured) || 0;
  const helpsLead = measured ? `Answers ${(row.threat_answers || []).length} of the ${measured} worst threats` : "Helps vs";
  details.append(h("summary", {},
    sprite(spriteFor(row.candidate_entry?.pokemon || row.name, row.form || row.name, row.item), "", 44),
    h("div", { class: "bd-sg-main" },
      h("div", { class: "bd-sg-title" },
        h("h3", {}, namers(helpers).text(row.action, [row.name, row.form, row.swap_target].filter(Boolean))),
        rank ? h("span", { class: "bd-pill", title: row.source === "box" ? "From your Box" : "Rank in the current usage data" }, rank) : null,
        // The set is that tournament team's own (known_team_prediction).
        row.found_in_team ? h("span", { class: "bd-pill good", title: `Completes the tournament team ${row.found_in_team}, and plays that team's set` }, "Found in similar team") : null),
      h("p", {}, [row.item, row.ability, row.spread?.nature_name || row.spread_label].filter(Boolean).join(" · ")),
      h("div", { class: "bd-move-chips" }, (row.moves || []).filter(Boolean).map((move) => h("span", {}, move))),
      helps.length ? h("p", { class: "bd-sg-helps" }, h("b", {}, helpsLead), `${measured ? ": " : " "}${helps.join(", ")}`) : measured ? h("p", { class: "bd-sg-helps" }, h("b", {}, helpsLead)) : null,
      deltas.length ? h("div", { class: "bd-sg-deltas", "aria-label": "Estimated score changes" }, deltas) : null),
    h("div", { class: "bd-suggestion-side" },
      h("b", { class: "bd-suggestion-score", title: cappedAt100(row) ? `Capped at 100 (uncapped ${fixed1(row.score_uncapped)})` : "Suggestions score" }, Number(row.score).toFixed(1)),
      h("button", { type: "button", class: "ghost-button compact", onclick: (event) => { event.preventDefault(); onUse(row); } }, "Use"))));
  details.append(breakdown(row, helpers, result));
  return details;
}

function section(title, ...children) {
  return h("section", { class: "bd-sg-section" }, h("h4", {}, title), ...children);
}

function breakdown(row, helpers, result) {
  const { ui } = helpers;
  const { text: named } = namers(helpers);
  const names = rowNames(row);
  const text = (value) => named(value, names);
  const key = String(row.key || row.action);
  const projected = row.projected && !row.projected.error ? row.projected : null;
  const waiting = !row.projected && result?.checking;
  const body = h("div", { class: "bd-sg-body" });
  const { one } = namers(helpers);

  // 0. What it does: the one sentence the ranking comes down to (V511), then - on a swap that
  // gives up a role only the outgoing Pokemon provides - what it costs to make it (V512).
  if (row.verdict_line || row.outgoing_verdict_line) {
    const beaten = (row.threat_answers || []).length;
    const measured = Number(row.threats_measured) || 0;
    const lines = [];
    if (row.verdict_line) {
      lines.push(h("p", { class: `bd-sg-verdict ${measured && beaten * 2 >= measured ? "up" : beaten ? "" : "down"}` }, text(row.verdict_line)));
    }
    if (row.outgoing_verdict_line) lines.push(h("p", { class: "bd-sg-verdict down" }, text(row.outgoing_verdict_line)));
    body.append(section("What it does", ...lines));
  }

  // 1. Score changes: the estimate the ranking uses, then the full Team Evaluation.
  const components = row.components || {};
  body.append(section("Score changes",
    h("div", { class: "bd-sg-metrics" }, METRICS.filter(([k]) => components[k]).map(([k, label]) => {
      const c = components[k];
      const real = projected && k !== "archetype" ? [projected.scores.before[k], projected.scores.after[k]] : null;
      return h("div", { class: `bd-sg-metric ${tone(c.delta)}` },
        h("span", { class: "bd-sg-metric-label" }, label),
        h("strong", {}, `${fixed1(c.current)} → ${fixed1(c.projected)}`, h("small", {}, ` (${signed(c.delta)})`)),
        real ? h("span", { class: `bd-sg-metric-real ${tone(real[1] - real[0])}` }, `Team Evaluation: ${fixed1(real[0])} → ${fixed1(real[1])}`)
          : k !== "archetype" && waiting ? h("span", { class: "bd-sg-metric-real flat" }, "Team Evaluation: checking…") : null);
    })),
    h("p", { class: "bd-note" }, projected
      ? "The first line is the quick estimate the ranking uses; “Team Evaluation” is the full evaluation of the team with this Pokémon in it."
      : "The quick estimate the ranking uses (how the typing, Speed and checks move each score)."),
    row.projected?.error ? h("p", { class: "bd-note bd-bad-text" }, `The Team Evaluation check failed: ${row.projected.error}`) : null,
    projected?.item_changed ? h("p", { class: "bd-note" }, `Another member already holds ${row.item}, so the check used ${projected.item_changed} (as Use would).`) : null));

  // 2. Why it fits: good first, then warnings, then problems, then the rest.
  const severities = row.severities || {};
  const impacts = (row.details || []).map((text, i) => [String(text), severities[String(text).toLowerCase()] || "neutral", i])
    .sort((a, b) => (IMPACT_ORDER[a[1]] ?? 3) - (IMPACT_ORDER[b[1]] ?? 3) || a[2] - b[2]);
  if (impacts.length) {
    const showAll = Boolean(ui?.all?.has(key));
    const list = h("ul", { class: "bd-sg-impact" }, (showAll ? impacts : impacts.slice(0, IMPACT_LIMIT)).map(([reason, sev]) => h("li", { class: sev },
      h("span", { class: `bd-sg-badge ${sev}`, "aria-hidden": "true" }, sev === "good" ? "✓" : sev === "neutral" ? "i" : "!"),
      h("span", {}, text(reason)))));
    const more = impacts.length > IMPACT_LIMIT ? h("button", {
      type: "button",
      class: "bd-sg-more",
      onclick: (event) => {
        event.preventDefault();
        if (!ui?.all) return;
        if (showAll) ui.all.delete(key);
        else ui.all.add(key);
        const row2 = event.currentTarget.closest(".bd-sg-row");
        row2?.replaceWith(suggestionRow(row, helpers, result));
      },
    }, showAll ? "Show fewer" : `Show all ${impacts.length}`) : null;
    body.append(section("Why it fits", list, more));
  }

  // 3. Team Building Checks whose status changes, then archetype requirements.
  const checks = row.checks || [];
  const gained = row.archetype_changes?.gained || [];
  const lost = row.archetype_changes?.lost || [];
  const archetype = row.archetype_changes?.archetype || "archetype";
  body.append(section("Team Building Checks",
    checks.length
      ? h("ul", { class: "bd-sg-checks" }, checks.map((c) => h("li", {},
        h("span", { class: "bd-sg-check-label" }, text(c.label)),
        h("span", { class: `bd-status ${c.before}` }, STATUS[c.before] || c.before), h("span", { class: "bd-sg-arrow", "aria-hidden": "true" }, "→"),
        h("span", { class: `bd-status ${c.after}` }, STATUS[c.after] || c.after),
        c.summary ? h("small", {}, text(c.summary)) : null)))
      : h("p", { class: "bd-note" }, "No enabled check changes its status."),
    gained.length ? h("p", { class: "bd-sg-req good" }, text(`${archetype} requirements it meets: ${gained.map((r) => `${r.label}${r.critical ? " (critical)" : ""} ${r.before ? `${r.before} → ` : ""}${r.display}`).join(" · ")}`)) : null,
    lost.length ? h("p", { class: "bd-sg-req bad" }, text(`${archetype} requirements it breaks: ${lost.map((r) => `${r.label}${r.critical ? " (critical)" : ""} ${r.before ? `${r.before} → ` : ""}${r.display}`).join(" · ")}`)) : null));

  // 4. The three views on the critical threats, each saying what it measures and in what unit.
  body.append(answersSection(row, projected, waiting, one));
  body.append(threatScoreSection(row, projected, waiting, one));
  const typeOnly = typeOnlySection(row, one);
  if (typeOnly) body.append(typeOnly);

  // 5. The set.
  const spread = row.spread || {};
  body.append(section("Set",
    h("dl", { class: "bd-sg-set" },
      h("dt", {}, "Item"), h("dd", {}, row.item || "None"),
      h("dt", {}, "Ability"), h("dd", {}, row.ability || "—"),
      h("dt", {}, "Nature"), h("dd", {}, spread.nature_name || spread.name || row.spread_label || "Serious"),
      h("dt", {}, "Stat Points"), h("dd", {}, (spread.bonuses || []).length ? spread.bonuses.map((v, i) => `${STAT_SHORT[i]} ${v}`).join(" / ") : "—"),
      h("dt", {}, "Moves"), h("dd", {}, (row.moves || []).filter(Boolean).join(", ") || "—"),
      h("dt", {}, "From"), h("dd", {}, row.set_source || "Most common set"))));

  // 6. How the score is built.
  const ledger = row.ledger || [];
  if (ledger.length) {
    const capped = cappedAt100(row);
    body.append(section("How the score is built",
      h("ul", { class: "bd-sg-ledger" }, ledger.map((item) => h("li", { class: `${item.value !== undefined ? "base" : tone(item.delta)}${item.detail ? " wide" : ""}` },
        h("span", {}, text(item.label)),
        h("b", {}, item.value !== undefined ? fixed1(item.value) : signed(item.delta)),
        item.value === undefined && item.raw !== undefined && Math.abs(item.raw - item.delta) >= 0.05 ? h("small", {}, ` (${signed(item.raw)} before the 0-100 limit)`) : null,
        // The terms the calcs added say, in the same words the groups above use, what they measured.
        item.detail ? h("small", { class: "bd-sg-ledger-detail" }, text(item.detail)) : null))),
      h("p", { class: "bd-note" }, [
        `Score ${Number(row.score).toFixed(1)}${capped ? `, capped at 100 (${fixed1(row.score_uncapped)} before the cap)` : ""}.`,
        Number(row.threats_measured) || 0
          ? "Equal scores are ordered by meta rank. The last three terms come from the calcs above, so a Pokémon that carries the team's archetype move but answers nothing is ranked behind one that answers the threats."
          : "Equal scores are ordered by meta rank. A suggestion whose speed plan fights the team's (for example Trick Room on a Tailwind team) goes after the others, and one that fixes Speed Control goes first.",
        Number(row.threats_measured) || 0 ? "" : row.speed_conflict ? "This one has such a conflict, so it is listed later." : row.role_fixes ? "This one fixes Speed Control, so it is listed earlier." : "",
      ].filter(Boolean).join(" "))));
  }
  return body;
}

/** A calc as two short lines: who attacks with what, then the damage and KO. `one` names the attacker. */
function calcLine(result, one = (value) => value) {
  if (!result || !isShownResult(result)) return null;
  const suppressed = Boolean(result.speed_tier_suppressed);
  const tail = calcTail(result, { trueLabel: suppressed });
  return h("div", { class: `bd-sg-calc ${result.attacker_side === "team" ? "ours" : ""}` },
    h("span", { class: "bd-sg-calc-who" }, `${result.attacker ? one(result.attacker) : "?"} · ${result.move || "—"}`),
    tail.map((line, i) => h("span", { class: "bd-sg-calc-out" }, line, suppressed && i === tail.length - 1 ? h("small", {}, " — knocked out before it moves") : null)));
}

/** The two sides of a matchup, the one that moves first on top (first_result, as builder/calc-format.js reads it). */
function calcPair(incoming, outgoing, first = "outgoing", one = undefined) {
  const order = first === "outgoing" ? [outgoing, incoming] : [incoming, outgoing];
  return order.map((result) => calcLine(result, one)).filter(Boolean);
}

/**
 * What a verdict is called and how it may be coloured.
 *
 * Only a verdict that is plainly better or plainly worse gets a colour: a trade is a trade
 * and a chip is a chip, so both stay neutral rather than being dressed as a win.
 */
const VERDICT = {
  beats: ["Beats", "good"],
  walls: ["Walls", "good"],
  chips: ["Chips", "flat"],
  trades: ["Even", "flat"],
  loses: ["Loses to", "bad"],
};

/**
 * "1 hit" / "2 hits" / "4+ hits" / "no KO".
 *
 * The engine only counts 1, 2 and 3 exactly; everything slower is one bucket (the app's
 * `_v35_best_rank_from_result` calls it 6), so it is shown as "4+" rather than as a
 * measurement nobody made.
 */
const hitWord = (count) => {
  const n = Number(count);
  if (!Number.isFinite(n) || n >= 99) return "no KO";
  if (n >= 4) return "4+ hits";
  return n === 1 ? "1 hit" : `${n} hits`;
};

/**
 * One measured matchup: the verdict, the two hit counts that decided it, and the sentence.
 * The two numbers are the figures that moved the score, so they are what stands out.
 */
function verdictRow(entry, one, calcs = null) {
  const [word, toneName] = VERDICT[entry.verdict] || ["Measured", "flat"];
  const parts = [
    h("div", { class: "bd-sg-vd-head" },
      h("span", { class: `bd-sg-vd-tag ${toneName}` }, word),
      h("strong", {}, one(entry.threat)),
      entry.fills_a_gap && (entry.verdict === "beats" || entry.verdict === "walls")
        ? h("span", { class: "bd-pill good", title: "No current team member beats or walls this threat" }, "Team has no answer")
        : null),
    h("div", { class: "bd-sg-vd-hits" },
      h("span", {}, h("b", {}, hitWord(entry.out_hits)), " to remove it"),
      h("span", {}, h("b", {}, hitWord(entry.in_hits)), " to be removed"),
      entry.ours_first ? h("span", { class: "bd-sg-vd-order" }, "moves first")
        : entry.theirs_first ? h("span", { class: "bd-sg-vd-order" }, "moves second") : null),
  ];
  // The calcs below come from the other pass - the finished team's own evaluation, where this
  // Pokemon has its real spread - so they are labelled rather than read as the same numbers.
  if (calcs?.length) parts.push(h("div", { class: "bd-sg-vd-calcs" }, h("span", { class: "bd-sg-vd-calcs-head" }, "In the full Team Evaluation of the finished team:"), calcs));
  return h("div", { class: `bd-sg-vd ${toneName}` }, ...parts);
}

/**
 * View 1 — "Answers in the full Team Evaluation".
 *
 * What it measures: this Pokémon against the team's worst threats, both ways, with the same
 * calcs the Team Evaluation runs. Unit: hits to remove, and who moves first.
 */
function answersSection(row, projected, waiting, one) {
  const measured = Number(row.threats_measured) || 0;
  const answers = row.threat_answers || [];
  const title = measured ? `Answers in the full Team Evaluation (${answers.length} of the ${measured} worst threats)` : "Answers in the full Team Evaluation";
  if (!measured) {
    // No V511 verdicts on this row (an old run, or the rule is off): the earlier view.
    const backed = projected?.answers?.length ? projected.answers : (row.answer_calcs || []).filter((c) => c.kept && (c.incoming || c.outgoing));
    return section(title,
      h("p", { class: "bd-note" }, "Measured both ways with the same calcs the Team Evaluation runs: how many hits each side needs."),
      backed.length
        ? h("div", { class: "bd-sg-answers" }, backed.map((a) => h("div", { class: "bd-sg-answer" },
          h("div", { class: "bd-sg-answer-head" }, h("strong", {}, one(a.threat)), a.score !== undefined ? h("span", { class: "bd-note" }, `threat score ${fixed1(a.score)}`) : null),
          ...calcPair(a.incoming, a.outgoing, a.first || "outgoing", one))))
        : h("p", { class: "bd-note" }, waiting ? "Checking against the full Team Evaluation…" : "It wins none of the critical matchups on its own; its value is in the checks and scores above."));
  }
  const byThreat = new Map((projected?.answers || []).map((a) => [String(a.threat), a]));
  const rest = (row.threat_verdicts || []).filter((e) => e.verdict !== "beats" && e.verdict !== "walls");
  return section(title,
    h("p", { class: "bd-note" }, `Each of the team's ${measured} worst threats, played out both ways with the same calcs the Team Evaluation runs. The two numbers are hits needed to remove, so fewer on the left and more on the right is better.`),
    answers.length
      ? h("div", { class: "bd-sg-verdicts" }, answers.map((entry) => {
        const full = byThreat.get(String(entry.threat));
        return verdictRow(entry, one, full ? calcPair(full.incoming, full.outgoing, full.first, one) : null);
      }))
      : h("p", { class: "bd-note" }, "It beats or walls none of them; its value is in the Team Building Checks and the scores above."),
    rest.length ? h("p", { class: "bd-sg-sub" }, "The rest of the same list") : null,
    rest.length ? h("div", { class: "bd-sg-verdicts quiet" }, rest.map((entry) => verdictRow(entry, one))) : null);
}

/**
 * View 2 — "Threat scores after adding it".
 *
 * What it measures: the whole team's threat scores re-run with this Pokémon in the slot.
 * Unit: threat score, 0-100, lower is better. Lowered and raised are two labelled groups
 * with their own totals, and a net figure, instead of one mixed column.
 */
function threatScoreSection(row, projected, waiting, one) {
  if (!projected) {
    return section("Threat scores after adding it",
      h("p", { class: "bd-note" }, waiting ? "Checking each threat score against the full Team Evaluation…" : "Not checked against the full Team Evaluation."));
  }
  const lowered = projected.lowered || [];
  const raised = projected.raised || [];
  // A threat that stops being critical counts as its whole score removed; a new one as its whole score added.
  const delta = (t) => (t.after === null ? -Number(t.before) : t.before === null ? Number(t.after) : Number(t.after) - Number(t.before));
  const net = [...lowered, ...raised].reduce((sum, t) => sum + delta(t), 0);
  const group = (items, toneName, title, empty) => h("div", { class: "bd-sg-tsg" },
    h("p", { class: "bd-sg-sub" }, title),
    items.length
      ? h("ul", { class: "bd-sg-threat-moves" }, items.map((t) => h("li", { class: toneName },
        h("span", {}, one(t.threat)),
        h("b", {}, t.after === null ? `${fixed1(t.before)} → gone` : t.before === null ? `new, ${fixed1(t.after)}` : `${fixed1(t.before)} → ${fixed1(t.after)}`),
        h("small", {}, ` (${signed(delta(t))})${Number(t.before) >= 55 && t.after !== null && Number(t.after) < 55 ? " · no longer critical" : ""}`))))
      : h("p", { class: "bd-note" }, empty));
  return section("Threat scores after adding it",
    h("p", { class: "bd-note" }, `A threat score says how hard that Pokémon is on the team, out of 100, and lower is better (70 and above is a serious threat).${projected.critical ? ` Critical threats ${projected.critical.before} → ${projected.critical.after}.` : ""}`),
    group(lowered, "up", `Threat scores it lowers — better (${lowered.length})`, "No threat score drops by a useful amount."),
    group(raised, "down", `Threat scores it raises — worse (${raised.length})`, "No threat score rises."),
    lowered.length || raised.length
      ? h("p", { class: `bd-sg-net ${net < -0.05 ? "up" : net > 0.05 ? "down" : ""}` }, "Across every threat that moved: ", h("b", {}, signed(net)), " in total, and lower is better.")
      : null);
}

/**
 * View 3 — "Type matchup only".
 *
 * What it measures: the threats whose type chart flatters this Pokémon while the calc refuses
 * the matchup. Unit: the one clause that explains the disagreement. Never green: these are
 * not answers.
 */
function typeOnlySection(row, one) {
  const entries = row.type_matchup_only || [];
  if (!entries.length) {
    const struck = (row.answer_calcs || []).filter((c) => !c.kept && (c.incoming || c.outgoing));
    if (!struck.length) return null;
    return section("Type matchup only",
      h("p", { class: "bd-note" }, "Its typing looks good into these, but the calc says it loses the matchup, so they do not count as answers:"),
      h("div", { class: "bd-sg-answers" }, struck.map((c) => h("div", { class: "bd-sg-answer struck" },
        h("div", { class: "bd-sg-answer-head" }, h("strong", {}, one(c.threat))), ...calcPair(c.incoming, c.outgoing, "outgoing", one)))));
  }
  const why = (e) => {
    const out = Number(e.out_hits) || 99;
    const inn = Number(e.in_hits) || 99;
    if (e.theirs_first && inn === 1) return "it moves first and removes this in one hit";
    if (inn < out) return `it needs ${hitWord(inn)}, this needs ${hitWord(out)}`;
    if (e.theirs_first) return `both need ${hitWord(out)}, and it moves first`;
    return `this needs ${hitWord(out)} and cannot finish the exchange`;
  };
  return section("Type matchup only",
    h("p", { class: "bd-note" }, "The type chart says this Pokémon is good into these, and the calc disagrees. They are not counted as answers."),
    h("ul", { class: "bd-sg-typeonly" }, entries.map((e) => h("li", {},
      h("strong", {}, one(e.threat)), h("span", {}, ` — the typing looks good, but the calc says ${why(e)}.`)))));
}
