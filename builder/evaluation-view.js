// Team Evaluation views: the Settings dialog, Team Building Checks (with
// Customize), Critical Threats with their calcs, the Synergy and Offense /
// Defense popups and Speed (Speed Control plus the ranked Speed Tiers).
//
// Everything here renders the payload builder/team-payload.js produces (a port of
// the Companion app's evaluation); the calc wording follows the app.

import { DEFAULT_SETTINGS, STAT_DISTRIBUTION_OPTIONS } from "./team-eval.js";
import { calcTail, orderedResults, suppressedResult } from "./calc-format.js";
import { h, openDialog, problemCard, scoreRing, segmented, select, sprite, stepper, switchControl } from "./ui.js";

// --- settings ----------------------------------------------------------------------

/** _V420_SETTING_HINTS, one per row of the app's Team Evaluation Settings. */
const HINTS = {
  top_meta: "How many of the highest-usage Pokémon are evaluated. Example: 30 checks the current Top 30 Meta.",
  calc_item_limit: "How many of each threat's most common held items are calculated. Example: 3 tries its three most used items.",
  calc_move_limit: "How many of each Pokémon's most common moves are calculated. Example: 6 also covers moves outside its usual four.",
  threat_stat_distributions: "Chooses whether threats use common invested Stat Points and natures. Example: a common bulky spread may survive a hit that a blank spread cannot.",
  use_move_accuracies: "Includes each move's chance to miss. Example: Hydro Pump is less reliable than a 100% accurate move.",
  use_weather_abilities: "Lets Abilities set the weather automatically. Example: Drizzle starts Rain when this is Yes.",
  use_other_abilities: "Lets non-weather Abilities take effect. Example: Intimidate lowers Attack when this is Yes.",
  use_held_items: "Lets held items take effect and tries each threat's common items. Example: Choice Scarf increases Speed.",
  use_speed_tiers: "Uses priority and effective Speed to decide who acts first. Example: a faster OHKO can prevent the slower Pokémon from moving.",
  weather: "Runs every matchup in the selected weather. Example: Rain boosts Water moves and activates Swift Swim.",
  terrain: "Runs every matchup in the selected terrain. Example: Electric Terrain boosts grounded Electric attacks.",
  trick_room: "Reverses normal Speed order while enabled. Example: a slower Torkoal can move before a faster attacker.",
  tailwind: "Doubles effective Speed for the selected side. Example: My Team Tailwind can let Garchomp move first.",
  reflect: "Reduces physical damage for the selected side. Example: Reflect can turn an OHKO into a 2HKO.",
  light_screen: "Reduces special damage for the selected side. Example: Light Screen can turn an OHKO into a 2HKO.",
  exclude_moves: "Comma-separated moves that the Evaluation must ignore. Example: Protect, Perish Song.",
  exclude_abilities: "Comma-separated Abilities that the Evaluation must ignore. Example: Intimidate, Drizzle.",
  exclude_pokemon: "Comma-separated Pokémon removed from the threat pool. Example: Miraidon, Incineroar.",
  my_stages: "Applies stat stages to your team. Example: Atk:-1, Spe:+1.",
  threat_stages: "Applies stat stages to opposing threats. Example: SpA:+1, Atk:-1.",
};

const SIDES = [["None", "Off"], ["My Team", "Your team"], ["Threat Team", "Threats"], ["Both", "Both"]];

/**
 * The Settings dialog (the app's Team Evaluation Settings, V429/V431): the same
 * twenty settings, grouped the way they are used, plus the Team Building Checks.
 * @param {object} current   the saved settings (app keys)
 * @param {(settings: object) => void} onSave
 * @param {{maxTopMeta?: number, onCustomizeChecks?: (onSaved: () => void) => void, checksSummary?: () => string}} options
 */
export function openSettingsDialog(current, onSave, options = {}) {
  const { maxTopMeta = 262, onCustomizeChecks = null, checksSummary = null } = options;
  const summaryNode = h("span", { class: "bd-note" }, checksSummary ? checksSummary() : "");
  const draft = { ...DEFAULT_SETTINGS, ...(current || {}) };
  const row = (label, key, control, { stack = false } = {}) => h("div", { class: `bd-set-row ${stack ? "stack" : ""}` },
    h("div", { class: "bd-set-text" }, h("span", { class: "bd-set-label" }, label), HINTS[key] ? h("small", {}, HINTS[key]) : null),
    h("div", { class: "bd-set-control" }, control));
  const count = (key, min, max, label) => stepper(draft[key], { min, max, label, onChange: (v) => { draft[key] = v; } });
  const toggle = (key, label) => switchControl(Boolean(draft[key]), (on) => { draft[key] = on; }, { "aria-label": label });
  const choose = (key, options, label) => segmented(options, draft[key], (v) => { draft[key] = v; }, { "aria-label": label });
  const text = (key, placeholder, label) => {
    const input = h("input", { type: "text", class: "bd-input", placeholder, value: draft[key] || "", "aria-label": label, spellcheck: "false" });
    input.addEventListener("input", () => { draft[key] = input.value.trim(); });
    return input;
  };
  const section = (title, rows) => h("section", { class: "bd-set-section" }, h("h3", {}, title), h("div", { class: "bd-set-rows" }, rows));
  const body = h("div", { class: "bd-settings" },
    h("p", { class: "bd-section-note" }, "Applies to Team Evaluation, Suggestions, Optimize, Auto Build and the Tournament Test the next time they run."),
    h("div", { class: "bd-set-grid" },
      section("What is calculated", [
        row("Top X Meta", "top_meta", count("top_meta", 1, Math.max(1, maxTopMeta), "Top X Meta")),
        row("Held items per threat", "calc_item_limit", count("calc_item_limit", 1, 5, "Held items per threat")),
        row("Moves per Pokémon", "calc_move_limit", count("calc_move_limit", 1, 10, "Moves per Pokémon")),
        row("Threat Stat Points", "threat_stat_distributions", select(STAT_DISTRIBUTION_OPTIONS, draft.threat_stat_distributions, (v) => { draft.threat_stat_distributions = v; }, { "aria-label": "Threat Stat Points" }), { stack: true }),
      ]),
      section("Rules", [
        row("Move accuracy", "use_move_accuracies", toggle("use_move_accuracies", "Move accuracy")),
        row("Weather Abilities", "use_weather_abilities", toggle("use_weather_abilities", "Weather Abilities")),
        row("Other Abilities", "use_other_abilities", toggle("use_other_abilities", "Other Abilities")),
        row("Held items", "use_held_items", toggle("use_held_items", "Held items")),
        row("Speed decides who moves first", "use_speed_tiers", toggle("use_speed_tiers", "Speed order")),
      ]),
      section("Field", [
        row("Weather", "weather", choose("weather", ["None", "Sun", "Rain", "Sand", "Snow"], "Weather"), { stack: true }),
        row("Terrain", "terrain", choose("terrain", ["None", "Electric", "Grassy", "Psychic", "Misty"], "Terrain"), { stack: true }),
        row("Trick Room", "trick_room", toggle("trick_room", "Trick Room")),
        row("Tailwind", "tailwind", choose("tailwind", SIDES, "Tailwind"), { stack: true }),
        row("Reflect", "reflect", choose("reflect", SIDES, "Reflect"), { stack: true }),
        row("Light Screen", "light_screen", choose("light_screen", SIDES, "Light Screen"), { stack: true }),
      ]),
      section("Exclusions and stat stages", [
        row("Exclude moves", "exclude_moves", text("exclude_moves", "Protect, Perish Song", "Exclude moves"), { stack: true }),
        row("Exclude Abilities", "exclude_abilities", text("exclude_abilities", "Intimidate, Drizzle", "Exclude Abilities"), { stack: true }),
        row("Exclude Pokémon", "exclude_pokemon", text("exclude_pokemon", "Incineroar, Sneasler", "Exclude Pokémon"), { stack: true }),
        row("Your stat stages", "my_stages", text("my_stages", "Atk:-1, Spe:+1", "Your stat stages"), { stack: true }),
        row("Threat stat stages", "threat_stages", text("threat_stages", "SpA:+1, Atk:-1", "Threat stat stages"), { stack: true }),
      ]),
      onCustomizeChecks ? section("Team Building Checks", [
        h("div", { class: "bd-set-row" },
          h("div", { class: "bd-set-text" }, h("span", { class: "bd-set-label" }, "Checks in use"),
            h("small", {}, "Choose which team requirements are checked. Only the checked ones count for Suggestions and Auto Build.")),
          h("div", { class: "bd-set-control" },
            checksSummary ? summaryNode : null,
            h("button", { type: "button", class: "ghost-button compact", onclick: () => onCustomizeChecks(() => { if (checksSummary) summaryNode.textContent = checksSummary(); }) }, "Choose checks…"))),
      ]) : null));
  const { close } = openDialog({
    title: "Settings",
    body,
    wide: true,
    className: "bd-dialog-settings",
    actions: [
      h("button", { type: "button", class: "ghost-button", onclick: () => { close(); openSettingsDialog({ ...DEFAULT_SETTINGS }, onSave, options); } }, "Reset to defaults"),
      h("span", { class: "bd-spacer" }),
      h("button", { type: "button", class: "ghost-button", onclick: () => close() }, "Cancel"),
      h("button", { type: "button", class: "primary-button", onclick: () => {
        const out = { ...draft };
        out.ignore_weather_abilities = !out.use_weather_abilities;
        out.ignore_other_abilities = !out.use_other_abilities;
        out.ignore_held_items = !out.use_held_items;
        close();
        onSave(out);
      } }, "Save"),
    ],
  });
}

// --- shared bits ----------------------------------------------------------------------

function severityLabel(row) {
  if (row.check_id === "archetype_fit") return row.severity === "good" ? "OK" : "Watch";
  if (row.check_id === "mega") return row.severity === "good" ? "OK" : "Problem";
  return row.severity === "red" ? "Problem" : row.severity === "yellow" ? "Needs Attention" : "Good";
}

// --- Team Building Checks ------------------------------------------------------------

/**
 * @param {object} payload   the evaluation payload
 * @param {object} helpers   {onCustomize()}
 */
export function checksView(payload, { onCustomize } = {}) {
  const rows = payload.checks?.rows || [];
  const bad = rows.filter((r) => r.check_id !== "archetype_fit" && r.severity !== "good").length;
  return h("div", { class: "bd-checks" },
    h("div", { class: "bd-checks-head" },
      h("p", { class: "bd-section-note" }, bad ? `${bad} requirement${bad === 1 ? "" : "s"} need attention. Red checks count most for Suggestions and Auto Build.` : "Every enabled requirement is covered."),
      onCustomize ? h("button", { type: "button", class: "ghost-button compact", onclick: onCustomize }, "Customize") : null),
    h("div", { class: "bd-list" }, rows.map((row) => checkRow(row))));
}

function checkRow(row) {
  const details = [];
  if (row.why_v203) details.push(h("p", {}, row.why_v203));
  if (row.fix_v203 && row.severity !== "good") details.push(h("p", { class: "bd-good-text" }, `Fix: ${row.fix_v203}`));
  if (row.score_explanation && row.severity !== "good") details.push(h("p", { class: "bd-note" }, `Score: ${row.score_explanation}`));
  if ((row.archetype_requirements_v403 || []).length) {
    details.push(h("div", { class: "bd-req-list" }, row.archetype_requirements_v403.map((req) => h("span", { class: `bd-req ${req.met ? "met" : "missing"}` }, `${req.label} ${req.display}`))));
  }
  if ((row.type_rows_v251 || []).length) {
    details.push(h("div", { class: "bd-req-list" }, row.type_rows_v251.map((t) => h("span", { class: `bd-req ${t.severity === "red" ? "missing" : "watch"}` },
      h("img", { src: `/pokemon_champions_assets/types/${t.type}.png`, alt: "", width: 14, height: 14 }), `${t.type}: ${t.weak} weak and ${t.switch_ins} switch ins`))));
  }
  const summary = row.summary_v203 || row.summary || row.text;
  const title = row.check_label || row.check_id;
  const head = h("div", { class: "bd-check-main" },
    h("span", { class: `bd-status ${row.severity}` }, severityLabel(row)),
    h("div", {}, h("h3", {}, title), h("p", {}, summary)));
  return details.length ? h("details", { class: `bd-row bd-checkrow ${row.severity}` }, h("summary", {}, head), h("div", { class: "bd-check-detail" }, details)) : h("div", { class: `bd-row bd-checkrow ${row.severity}` }, head);
}

/**
 * The app's Customize list for Team Building Checks.
 * @param {Array<{id,label,description}>} list
 * @param {Set<string>} selected
 * @param {(ids: string[]) => void} onSave
 */
export function openChecksDialog(list, selected, onSave) {
  const boxes = list.map((check) => {
    const input = h("input", { type: "checkbox", checked: selected.has(check.id) });
    return [check.id, input, h("label", { class: "bd-check-option" }, input, h("span", {}, h("strong", {}, check.label), h("small", {}, check.description)))];
  });
  const { close } = openDialog({
    title: "Customize Team Building Checks",
    body: h("div", { class: "bd-list" },
      h("p", { class: "bd-section-note" }, "Only the checked requirements appear in Team Building Checks and count for Suggestions and Auto Build. Mega Options always shows."),
      boxes.map(([, , label]) => label)),
    actions: [
      h("button", { type: "button", class: "ghost-button", onclick: () => boxes.forEach(([, input]) => { input.checked = true; }) }, "Select all"),
      h("span", { class: "bd-spacer" }),
      h("button", { type: "button", class: "ghost-button", onclick: () => close() }, "Cancel"),
      h("button", { type: "button", class: "primary-button", onclick: () => { onSave(boxes.filter(([, input]) => input.checked).map(([id]) => id)); close(); } }, "Save"),
    ],
  });
}

// --- Critical Threats ---------------------------------------------------------------------
//
// One card per threat, laid out like the app's threat rows: one sprite, the set, how
// many of the team it KOs and how many answer it, the best answer, and a ring coloured
// by danger. Opened, it lists each team member's matchup as a compact box per side
// that acts ("Attacker · Move" over "damage · KO"), the side that moves second and is
// knocked out first as one grey line, and a condition note (Sun, Intimidate...) inside
// the box it changes.

/** _v47_threat_score_color: higher is more dangerous. */
function threatTone(score) {
  return score >= 75 ? "bad" : score >= 55 ? "orange" : score >= 35 ? "mid" : "good";
}

function threatRing(score) {
  const value = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  return h("span", { class: `bd-ring bd-ring-${threatTone(value)}`, style: `--value: ${value}`, role: "img", "aria-label": `Threat score ${value} out of 100`, title: "Threat score: higher is more dangerous" }, h("b", {}, value));
}

/** _v38_breakdown_counts: "3/6 OHKO · 2/6 2HKO"; a side knocked out before it attacks does not count. */
function koCounts(threat, key, teamSize) {
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const b of threat.breakdown || []) {
    const r = b[key] || {};
    if (r.speed_tier_suppressed) continue;
    const hits = Number.parseInt(r.hits ?? 99, 10) || 99;
    if (hits in counts && (Number(r.chance) || 0) > 0) counts[hits] += 1;
  }
  const parts = [[1, "OHKO"], [2, "2HKO"], [3, "3HKO"]].filter(([n]) => counts[n] > 0).map(([n, label]) => `${counts[n]}/${teamSize} ${label}`);
  return parts.length ? parts.join(" · ") : `0/${teamSize} KO`;
}

const lines = (text) => String(text || "").split("\n").map((line, i) => (i ? [h("br"), line] : line));
const isThreatSide = (r) => String(r?.attacker_side || "").toLowerCase() === "threat";

/** One side's attack: "Attacker · Move" over "damage · KO" (plus a condition line). */
function calcBox(result, name, outcome) {
  return h("div", { class: `bd-tc-calc ${isThreatSide(result) ? "threat" : "team"}` },
    h("p", {}, h("strong", {}, name(result.attacker || result.attacker_mon || "")), ` · ${result.move || "—"}`),
    calcTail(result).map((line) => h("p", {}, line)),
    outcome ? h("p", { class: `bd-tc-outcome ${outcome.severity === "critical" ? "critical" : "helpful"}` }, lines(outcome.text)) : null);
}

/** One team member's matchup with the threat. */
function matchupGroup(b, name) {
  const visible = orderedResults(b);
  const hidden = suppressedResult(b);
  if (!visible.length && !hidden) return null;
  const outcome = b.conditional_outcome_v420?.text ? b.conditional_outcome_v420 : null;
  // The condition note sits in the threat's box when it hurts, else in ours.
  const wantThreat = outcome?.severity === "critical";
  const target = outcome ? visible.find((r) => isThreatSide(r) === wantThreat) || visible[0] : null;
  return h("section", { class: "bd-tc-group" },
    h("h4", { class: "bd-tc-vs" }, `vs ${name(b.team_mon || (b.incoming_result || {}).defender || "")}`),
    visible.map((r) => calcBox(r, name, r === target ? outcome : null)),
    hidden ? h("p", { class: "bd-tc-hidden" },
      `${name(hidden.attacker || hidden.attacker_mon || "")} · ${hidden.move || "—"} · ${calcTail(hidden, { trueLabel: true }).join(" / ")}`,
      h("em", {}, " (moves second and is knocked out first)")) : null);
}

/** _v40_best_answer_display_text, in the breakdown's format. */
function bestAnswer(best, name) {
  if (!best || !best.move || best.move === "—") return h("p", { class: "bd-tc-best" }, "Best answer: none");
  const [first, ...rest] = calcTail(best, { trueLabel: Boolean(best.speed_tier_suppressed) });
  return h("p", { class: "bd-tc-best" }, "Best answer: ", h("strong", {}, name(best.attacker || best.attacker_mon || "")), ` · ${best.move} · ${first}`,
    best.speed_tier_suppressed ? h("em", {}, " (moves second)") : null,
    rest.map((line) => [h("br"), line]));
}

function threatCard(threat, { spriteFor, name, teamSize }) {
  const species = threat.base_name || threat.name;
  const form = threat.form || threat.name;
  const groups = (threat.breakdown || []).map((b) => matchupGroup(b, name)).filter(Boolean);
  return h("details", { class: "bd-tc" },
    h("summary", {},
      h("div", { class: "bd-tc-head" },
        h("span", { class: "bd-tc-art" }, sprite(spriteFor(species, form, threat.threat_item), "", 48)),
        h("div", { class: "bd-tc-main" },
          h("h3", { class: "bd-tc-title" }, h("strong", {}, name(threat.name)), [threat.threat_item, threat.threat_ability].filter(Boolean).map((v) => ` · ${v}`)),
          threat.threat_spread_label ? h("p", { class: "bd-tc-spread" }, threat.threat_spread_label) : null,
          h("p", { class: "bd-tc-pressure" }, `Threat pressure: ${koCounts(threat, "incoming_result", teamSize)}`),
          h("p", { class: "bd-tc-answers" }, `Team answers: ${koCounts(threat, "outgoing_result", teamSize)}`),
          bestAnswer(threat.our_best, name)),
        threatRing(threat.score))),
    h("div", { class: "bd-tc-body" }, groups.length ? groups : h("p", { class: "bd-note" }, "No detailed calcs available.")));
}

/**
 * @param {object} payload
 * @param {object} helpers  {spriteFor(species, form, item), name(value)}
 */
export function threatsView(payload, { spriteFor, name }) {
  const threats = payload.threats || [];
  if (!threats.length) {
    return h("div", { class: "bd-gate" }, h("h3", {}, "No critical threats"), h("p", {}, `Nothing in the Top ${payload.settings?.top_meta ?? ""} Meta reaches a 3HKO or better into this team.`));
  }
  const teamSize = Math.max(1, (payload.slots || []).length || (threats[0].breakdown || []).length);
  return h("div", { class: "bd-list" },
    h("p", { class: "bd-section-note" }, `${threats.length} of the Top ${payload.all_top_meta_threat_rows_v462} Meta Pokémon can KO a team member in three hits or fewer. Open a threat to see each matchup: red is the threat attacking, white is your Pokémon attacking, grey is the side that moves second and is knocked out first.`),
    threats.map((threat) => threatCard(threat, { spriteFor, name, teamSize })));
}

// --- Synergy, Offense and Defense popups ---------------------------------------------------

export function openSynergyDialog(payload, { spriteFor, slots }) {
  const members = payload.synergy_members || [];
  const weakest = Math.min(...members.map((m) => m.score), 100);
  const slotFor = (memberName) => (slots || []).find((s) => s.name === memberName);
  const body = h("div", { class: "bd-list" },
    h("div", { class: "bd-synergy-head" }, scoreRing(payload.synergy_score, "Synergy"),
      h("p", { class: "bd-section-note" }, "Each Pokémon lists its synergy with every teammate. Low-connection members are highlighted so weak links are easy to spot.")),
    members.map((member) => {
      const slot = slotFor(member.name);
      return h("details", { class: `bd-synergy-member ${member.score <= weakest + 0.01 ? "weakest" : ""}` },
        h("summary", {},
          slot ? sprite(spriteFor(slot.species, slot.form, slot.item), "", 36) : null,
          h("strong", {}, member.name),
          h("span", { class: "bd-note" }, `${member.synergy_count} meaningful synerg${member.synergy_count === 1 ? "y" : "ies"} · ${member.strong_link_count} strong link${member.strong_link_count === 1 ? "" : "s"}`),
          h("b", { class: "bd-synergy-score" }, Math.round(member.score))),
        h("div", { class: "bd-list" }, member.links.map((link) => h("div", { class: `bd-synergy-link ${link.connection}` },
          h("h4", {}, `${link.partner} · ${link.synergy_count} meaningful synerg${link.synergy_count === 1 ? "y" : "ies"} · ${Math.round(link.score)}`),
          link.interaction_titles.length ? h("p", {}, link.interaction_titles.slice(0, 3).join(" • ")) : h("p", { class: "bd-bad-text" }, "No contextual move, ability, typing, or speed interaction detected."),
          link.evidence ? h("p", { class: "bd-note" }, link.evidence) : null,
          link.warning ? h("p", { class: "bd-bad-text" }, link.warning) : null))));
    }));
  openDialog({ title: "Team Synergy by Pokémon", body, wide: true });
}

export function openPressureDialog(payload, which) {
  const overview = payload.pressure_overview_v188 || {};
  const offense = which === "offense";
  const pressure = offense ? overview.team_to_meta : overview.meta_to_team;
  const critical = overview.critical || {};
  const score = offense ? payload.offense_score : payload.defense_score;
  const formula = offense
    ? `Offense ${Math.round(score)} = 70% of the team's damage pressure into the Top ${overview.top_x} Meta (${Math.round(pressure?.score ?? 0)}) + 30% how well it answers its critical threats (${Math.round(critical.answer_score ?? 0)}).`
    : `Defense ${Math.round(score)} = 70% of (100 − the meta's pressure into the team, ${Math.round(pressure?.score ?? 0)}) + 30% critical-threat safety (${Math.round(critical.safety_score ?? 0)}).`;
  const types = Object.entries(pressure?.type_summary || {}).filter(([, v]) => v.count > 0).sort((a, b) => b[1].pressure - a[1].pressure);
  const body = h("div", { class: "bd-list" },
    h("p", { class: "bd-confirm-text" }, formula),
    h("p", { class: "bd-note" }, `Per-matchup damage with the real sets, capped at 100% per target before averaging. Average type multiplier ${Number(pressure?.average_type_multiplier ?? 1).toFixed(2)}× · ${Math.round((pressure?.physical_share ?? 0) * 100)}% physical · ${Math.round((pressure?.special_share ?? 0) * 100)}% special.`),
    h("h3", { class: "bd-field-label" }, offense ? "Your strongest attacks into the meta" : "The meta's strongest attacks into you"),
    (pressure?.top_moves || []).map((row) => h("div", { class: "bd-row" },
      h("img", { src: `/pokemon_champions_assets/types/${row.type}.png`, alt: row.type, width: 20, height: 20 }),
      h("div", {}, h("h3", {}, `${row.owner_name} · ${row.move}`), h("p", {}, `${row.category} · ${row.target_multiplier.toFixed(2)}× average type multiplier${row.uses_current_set ? " · current set" : ""}`)),
      h("strong", { class: "bd-row-strong" }, `${Math.round(row.pressure)}%`))),
    types.length ? h("h3", { class: "bd-field-label" }, "By attacking type") : null,
    types.length ? h("div", { class: "bd-type-grid" }, types.map(([type, v]) => h("div", { class: `bd-type-cell ${offense ? (v.pressure >= 60 ? "good" : v.pressure < 35 ? "bad" : "mid") : (v.pressure >= 60 ? "bad" : v.pressure < 35 ? "good" : "mid")}` },
      h("img", { src: `/pokemon_champions_assets/types/${type}.png`, alt: "", width: 16, height: 16 }), h("span", {}, type), h("b", {}, `${Math.round(v.pressure)}%`)))) : null,
    (critical.critical_rows || []).length ? h("h3", { class: "bd-field-label" }, "Critical threats in this score") : null,
    (critical.critical_rows || []).map((row) => h("div", { class: "bd-row" },
      h("span", { class: `bd-status ${row.severity}` }, row.severity === "red" ? "Red" : "Yellow"),
      h("div", {}, h("h3", {}, row.name), h("p", {}, `Threat ${Math.round(row.score)} · best answer ${Math.round(row.answer)}`)), h("span"))));
  openDialog({ title: offense ? "Offense Overview" : "Defense Overview", body, wide: true });
}

// --- Speed ------------------------------------------------------------------------------------

/** Speed Control: the Speed score's sub-scores and every line behind them. */
export function speedView(payload) {
  const speed = payload.speed || {};
  const section = (label, value, lines) => h("details", { class: "bd-speed-part" },
    h("summary", {}, scoreRing(value, label), h("strong", {}, label), h("span", { class: "bd-note" }, `${(lines || []).length} line${(lines || []).length === 1 ? "" : "s"}`)),
    h("ul", { class: "bd-speed-lines" }, (lines || []).map((line) => h("li", {}, line))));
  const room = speed.room_plan || {};
  return h("div", { class: "bd-speed" },
    h("p", { class: "bd-section-note" }, `The Speed score is how often your team moves first against the Top ${payload.settings?.top_meta ?? ""} Meta in three situations: normal Speed, when the opponent has Tailwind, and under Trick Room. Open a part to see the matchups behind it.`),
    speed.summary ? h("p", { class: "bd-note" }, speed.summary) : null,
    speed.archetype_speed_mode_v465 === "trick_room"
      ? h("div", { class: "bd-speed-parts" }, section("Trick Room", speed.trick_room, speed.trick_lines))
      : h("div", { class: "bd-speed-parts" },
        section("Standard Speed", speed.standard, speed.standard_lines),
        section("Opposing Tailwind", speed.opposing_tailwind, speed.tailwind_lines),
        section("Trick Room", speed.trick_room, speed.trick_lines)),
    room.setters ? h("p", { class: "bd-note" }, `Trick Room plan: ${room.setters} setter${room.setters === 1 ? "" : "s"}, ${room.beneficiaries} slow attacker${room.beneficiaries === 1 ? "" : "s"}. ${room.supported ? "Scored under Trick Room." : "Scored as a normal-Speed team."}`) : null);
}

/**
 * The ranked Speed list: our team plus the Top-X meta (the Team Overview's
 * "Top N Meta"), under the chosen weather, Tailwinds, Trick Room and Speed stages.
 */
export function speedTiersView(tiers, state, { spriteFor, onState, title = "Speed Tiers", error = "", onRetry, topSource = "" }) {
  const set = (patch) => onState({ ...state, ...patch });
  const stages = Array.from({ length: 13 }, (_, i) => i - 6).map((v) => [String(v), v > 0 ? `+${v}` : v === 0 ? "±0" : String(v)]);
  const group = (label, ...controls) => h("div", { class: "bd-speed-group" }, h("span", { class: "bd-speed-label" }, label), h("div", { class: "bd-speed-group-body" }, controls));
  const labelled = (text, control) => h("label", { class: "bd-inline-control" }, control, h("span", {}, text));
  const stageSelect = (key, label) => h("label", { class: "bd-inline-control" }, h("span", {}, "Stage"),
    select(stages, String(state[key] || 0), (v) => set({ [key]: Number(v) }), { class: "bd-select bd-select-small", "aria-label": label }));
  const controls = h("div", { class: "bd-speed-toolbar" },
    group("Weather", segmented(["None", "Sun", "Rain", "Sand", "Snow"], state.weather || "None", (v) => set({ weather: v }), { "aria-label": "Weather" })),
    group("Order",
      labelled("Trick Room", switchControl(state.trick_room, (on) => set({ trick_room: on }), { "aria-label": "Trick Room" }))),
    group("Your team",
      labelled("Tailwind", switchControl(state.own_tailwind, (on) => set({ own_tailwind: on }), { "aria-label": "Your Tailwind" })),
      stageSelect("our_stage", "Your Speed stage")),
    group("Opponents",
      labelled("Tailwind", switchControl(state.opposing_tailwind, (on) => set({ opposing_tailwind: on }), { "aria-label": "Opposing Tailwind" })),
      stageSelect("opponent_stage", "Opposing Speed stage")));

  let list;
  if (error) {
    list = problemCard("The Speed list could not be calculated", error, { onAction: onRetry });
  } else if (!tiers) {
    list = h("div", { class: "bd-loading" }, h("span", { class: "bd-spinner" }), "Ranking the Speed tiers…");
  } else {
    list = h("ol", { class: "bd-tier-list" }, tiers.rows.map((row, i) => h("li", { class: `bd-tier ${row.ours ? "ours" : ""}` },
      h("span", { class: "bd-tier-rank" }, i + 1),
      sprite(spriteFor(row.species, row.form, row.item), "", 36, "bd-sprite bd-tier-sprite"),
      h("span", { class: "bd-tier-text" },
        h("span", { class: "bd-tier-name" },
          h("strong", {}, row.name),
          row.variant ? h("span", { class: "bd-tier-variant" }, row.variant) : null,
          row.ours ? h("span", { class: "bd-tier-tag" }, "Your team") : null),
        h("small", {}, [row.ours ? "" : `#${row.position} in the meta`, `${row.nature} · +${row.points} Speed`, row.ability, row.item].filter(Boolean).join(" · "))),
      h("span", { class: "bd-tier-speed" },
        h("b", {}, row.speed),
        h("span", { class: "bd-tier-bar", "aria-hidden": "true" }, h("i", { style: { width: `${Math.max(4, Math.round((100 * row.speed) / Math.max(1, tiers.maximum)))}%` } }))))));
  }
  return h("section", { class: "bd-overview-section bd-speed-tiers" },
    h("div", { class: "bd-section-head" },
      h("h3", { class: "bd-field-label" }, title),
      tiers && !error ? h("span", { class: "bd-note" }, `${tiers.rows.length} rows · Top ${state.top_x} Meta · ${state.trick_room ? "slowest" : "fastest"} first`) : null),
    h("p", { class: "bd-section-note" }, `Your team and the Top ${state.top_x} Meta on their most common sets. A Pokémon gets an extra row when it often runs Choice Scarf or a Speed Ability. Change the weather, Tailwind, Trick Room or Speed stages to see how the order moves.${topSource ? ` The Top Meta size comes from ${topSource}.` : ""}`),
    controls, list);
}

// --- Suggested Pokémon ----------------------------------------------------------------

// The list and its breakdown live in builder/suggest-view.js.
export { suggestionsView } from "./suggest-view.js";
