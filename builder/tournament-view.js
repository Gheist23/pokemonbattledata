// The results of "Test against Tournament Teams" (builder/tournament-test.js), drawn
// from one snapshot so the page can redraw them after every batch while the test runs.
//
// Reads top-down: the verdict with the Pokémon to bring, what happens on turn 1, the
// biggest threats, your Pokémon, each archetype, the hardest teams as short stories,
// and a closed "More detail" with the duel table, other brings and the easiest teams.
// One set of colours throughout: Favoured / Even / Behind for matchups, Wins / Close /
// Loses for 1-on-1 duels, and a neutral colour for plain facts such as "brought 80%".

import { MATCHUP_BANDS, SNAPSHOT_VERSION } from "./tournament-test.js";
import { h } from "./ui.js";

const BAND_LABEL = { good: "Favoured", mid: "Even", bad: "Behind" };
const WIN_LABEL = { good: "Wins", mid: "Close", bad: "Loses" };
const WIN_ICON = { good: "▲", mid: "●", bad: "▼" };
const WORDS = ["none", "one", "two", "three", "four", "five", "six"];
const WEATHER_TEXT = { Sun: "harsh sunlight", Rain: "rain", Sand: "a sandstorm", Snow: "snow", "Strong Winds": "strong winds" };
// The verdict names a strongest and a weakest archetype only when their averages differ by this much.
const ARCHETYPE_GAP = 3;

const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
const number = (value) => Number(value || 0).toLocaleString("en-US");
const word = (n) => WORDS[n] || String(n);
const clamp100 = (value) => Math.max(0, Math.min(100, Number(value) || 0));
export const bandOf = (value) => (value >= MATCHUP_BANDS.favourable ? "good" : value < MATCHUP_BANDS.unfavourable ? "bad" : "mid");
const winTone = (win) => (win >= 0.6 ? "good" : win < 0.4 ? "bad" : "mid");

/** "A", "A and B", "A, B and C". */
function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** The line under the progress bar: "250 of 1,000 teams · 9.4 s · Latest: team #250, Hyper Offense, Even". */
export function tournamentProgress(snapshot) {
  if (!snapshot) return "Loading the tournament teams…";
  const latest = snapshot.latest?.[0];
  const tail = latest ? ` · Latest: team #${latest.number}${latest.archetype ? `, ${latest.archetype}` : ""}, ${BAND_LABEL[bandOf(latest.value)]}` : "";
  return `${number(snapshot.tested)} of ${number(snapshot.total)} teams · ${Number(snapshot.seconds || 0).toFixed(1)} s${tail}`;
}

/** How the test works, in four steps. */
export function tournamentExplainer({ teams = 2827, format = "Doubles" } = {}) {
  const singles = format === "Singles";
  const bring = word(singles ? 3 : 4);
  const step = (n, title, text) => h("div", { class: "bd-tour-step" }, h("span", { class: "bd-tour-step-n" }, n), h("div", {}, h("strong", {}, title), h("p", {}, text)));
  return h("div", { class: "bd-tour-explain" },
    h("div", { class: "bd-tour-how" },
      step("1", "Turn 1", singles
        ? "Both sides lead with the Pokémon that does the most on turn 1. Intimidate and weather or terrain Abilities trigger when it comes in, then Protect, Fake Out, Tailwind, Trick Room and Speed-lowering moves like Icy Wind go in priority and Speed order, or it attacks."
        : "Both sides lead with the two Pokémon that do the most on turn 1. Intimidate and weather or terrain Abilities trigger when they come in, then Protect, Fake Out, Follow Me, Tailwind, Trick Room and Speed-lowering moves like Icy Wind go in priority and Speed order, and the rest attack. Earthquake and similar moves hit the user's partner too, so a Pokémon only uses them when they do more to the other side than to its partner."),
      step("2", "After turn 1", "From turn 2 both sides attack on the board turn 1 left behind. Tailwind doubles Speed for 3 more turns, Trick Room lets slower Pokémon move first for 4 more, Speed and Attack drops stay, and every Pokémon keeps the HP it has left. A Pokémon that faints is replaced from the back until one side is out."),
      step("3", `Both sides bring ${bring}`, `Every ${bring} you could bring plays every ${bring} they could bring. You get the ${bring} that hold up best; they answer with the ${bring} that hurt them most.`),
      step("4", "Across the teams", `Played against up to ${number(teams)} real tournament teams. A score of 50 is even; ${MATCHUP_BANDS.favourable} or more favours you, under ${MATCHUP_BANDS.unfavourable} favours them.`)),
    h("p", { class: "bd-note bd-tour-limits" },
      "Kept simple on purpose: nobody switches out, and status conditions, stat-boosting moves, screens and Helping Hand are left out. ",
      singles ? "The tournament teams come from Doubles events; in Singles each side brings three of them and plays one at a time." : ""));
}

/**
 * @param {object} s            a snapshot from TournamentTest.run (version 2)
 * @param {{name:(mon)=>string, sprite:(mon, size)=>Node, running:boolean}} helpers
 */
export function tournamentAnalysis(s, { name, sprite, running }) {
  if (!s || !s.tested || s.version !== SNAPSHOT_VERSION) return h("div", { class: "bd-loading" }, h("span", { class: "bd-spinner" }), "Playing the first tournament teams…");
  const n = Math.max(1, s.tested);
  const bring = word(s.bring);
  const section = (title, note, ...body) => h("section", { class: "bd-tr-card" },
    h("div", { class: "bd-tr-head" }, h("h3", {}, title), note ? h("p", { class: "bd-note" }, note) : null),
    ...body);
  const pill = (tone, text, attrs = {}) => h("span", { class: `bd-tr-pill ${tone}`, ...attrs }, text);
  const bandPill = (value) => pill(bandOf(value), `${BAND_LABEL[bandOf(value)]} · ${Math.round(clamp100(value))}`);

  return h("div", { class: `bd-tr ${running ? "running" : ""}` },
    verdictCard(s, n, bring, { name, sprite }),
    turnOneCard(s, section),
    threatsCard(s, section, pill, { name, sprite }),
    pokemonCard(s, section, { name, sprite }),
    archetypeCard(s, section, pill),
    hardestCard(s, section, bandPill, { name, sprite }),
    moreDetail(s, section, bandPill, { name, sprite }));
}

// --- (A) the verdict ----------------------------------------------------------------------

function verdictCard(s, n, bring, { name, sprite }) {
  const tone = bandOf(s.average);
  const title = { good: "Favoured against the tournament field", mid: "About even with the tournament field", bad: "The tournament field has the edge" }[tone];
  const known = (s.archetypes || []).filter((a) => a.name !== "Other" && a.count >= 5);
  let subline = "";
  if (known.length >= 2) {
    const sorted = [...known].sort((a, b) => b.average - a.average);
    const strongest = sorted[0];
    const weakest = sorted[sorted.length - 1];
    // Only when the gap is real: with (nearly) equal averages the pair would be arbitrary.
    if (strongest.average - weakest.average >= ARCHETYPE_GAP) subline = `Strongest against ${strongest.name} teams, weakest against ${weakest.name} teams.`;
  }
  const bands = [
    ["good", s.bands.favourable],
    ["mid", s.bands.even],
    ["bad", s.bands.unfavourable],
  ];
  const pick = s.mostBrought;
  const leads = new Set((pick?.leads || []).map((m) => m.slot));
  return h("section", { class: `bd-tr-verdict ${tone}` },
    h("div", { class: "bd-tr-verdict-main" },
      h("p", { class: "bd-tr-kicker" }, `${s.done ? "" : "So far: "}${number(s.tested)} tournament team${s.tested === 1 ? "" : "s"} · ${s.format}`),
      h("h3", {}, title),
      subline ? h("p", { class: "bd-tr-sub" }, subline) : null,
      h("div", { class: "bd-tr-bands", role: "img", "aria-label": bands.map(([t, count]) => `${BAND_LABEL[t]}: ${count} teams`).join(", ") },
        bands.map(([t, count]) => (count ? h("i", { class: t, style: { width: `${(100 * count) / n}%` } }) : null))),
      h("div", { class: "bd-tr-bandlabels" }, bands.map(([t, count]) => h("span", { class: t },
        h("b", {}, pct(count / n)),
        h("small", {}, `${BAND_LABEL[t]} · ${number(count)} team${count === 1 ? "" : "s"}`)))),
      h("p", { class: "bd-tr-score" }, "Average score ", h("b", { class: tone }, Math.round(clamp100(s.average))), " / 100 · 50 is even")),
    pick ? h("div", { class: "bd-tr-bring" },
      h("h4", {}, s.bring === 1 ? "Bring this one" : `Bring these ${bring}`),
      h("ol", {}, pick.members.map((m) => h("li", {},
        sprite(m, 28),
        h("span", {}, name(m)),
        leads.has(m.slot) ? h("span", { class: "bd-tr-tag" }, "Lead") : null))),
      h("p", { class: "bd-note" }, `Your best choice against ${pct(pick.bestRate)} of the teams.`)) : null);
}

// --- (B) turn 1 ----------------------------------------------------------------------------

function turnOneCard(s, section) {
  const t = s.turnOne || {};
  const first = t.weFirst || 0;
  const tiles = [
    [first, "You move first on turn 2", first >= 0.55 ? "good" : first < 0.45 ? "bad" : "", true],
    [t.ourTailwind, "Your Tailwind goes up", "good"],
    [t.theirTailwind, "Their Tailwind goes up", "bad"],
    [t.ourTrickRoom, "You set up Trick Room", "good"],
    [t.theirTrickRoom, "They set up Trick Room", "bad"],
    [t.weFakeOut, "Your Fake Out stops one of theirs", "good"],
    [t.fakedOut, "Their Fake Out stops one of yours", "bad"],
    [t.intimidated, "Their Intimidate lowers your Attack", "bad"],
    [t.koFor, "You knock one out on turn 1", "good"],
    [t.koAgainst, "You lose one on turn 1", "bad"],
  ].filter(([value, , , always]) => always || value >= 0.005);
  return section("What happens on turn 1", "How often, in the game each team is judged by: your best choice against their strongest answer.",
    h("div", { class: "bd-tr-tiles" }, tiles.map(([value, text, tone]) => h("div", { class: `bd-tr-tile ${tone}` },
      h("b", {}, pct(value)),
      h("span", {}, text),
      h("i", { class: "bd-tr-tile-bar", "aria-hidden": "true" }, h("i", { style: { width: pct(value) } }))))));
}

// --- (C) the biggest threats ------------------------------------------------------------

function threatsCard(s, section, pill, { name, sprite }) {
  const rows = s.threats || [];
  return section("Biggest threats", "Common Pokémon that knock out yours or are hard to knock out.",
    rows.length
      ? h("ol", { class: "bd-tr-threats" }, rows.map((t) => h("li", { class: "bd-tr-threat" },
        sprite(t, 36),
        h("div", { class: "bd-tr-threat-main" },
          h("div", { class: "bd-tr-threat-top" }, h("strong", {}, name(t)), pill(t.level === "high" ? "bad" : "mid", t.level === "high" ? "High" : "Medium", { title: "How big a threat it is" })),
          h("p", {}, `${t.share >= 0.01 ? `In ${pct(t.share)} of teams` : `In ${t.count} team${t.count === 1 ? "" : "s"}`} · brought against you in ${pct(t.brought)} of them`),
          h("p", {}, `Knocks out ${t.kosPerGame.toFixed(1)} of yours per game · survives ${pct(t.survived)} of games`),
          h("p", {}, "Your best answer: ", h("b", {}, name(t.answer)), ` (wins ${pct(t.answer.win)} of their duels)`)))))
      : h("p", { class: "bd-note" }, "Nothing common stands out: every frequent Pokémon has a strong answer on your team."));
}

// --- (D) your Pokémon ----------------------------------------------------------------------

function pokemonCard(s, section, { name, sprite }) {
  const head = ["Pokémon", "Brought", "Leads", "KOs per game", "Faints", "Duels won"];
  const cell = (label, content, cls = "") => h("td", { "data-label": label, class: cls }, content);
  return section("Your Pokémon", "Brought: how often it is in your best choice. Duels won: its 1-on-1 wins against every Pokémon it met, on the board after turn 1.",
    h("table", { class: "bd-tr-table" },
      h("thead", {}, h("tr", {}, head.map((label) => h("th", { scope: "col" }, label)))),
      h("tbody", {}, (s.pokemon || []).map((p) => h("tr", {},
        h("th", { scope: "row", class: "bd-tr-mon" }, h("div", {},
          sprite(p, 32),
          h("span", {}, h("strong", {}, name(p)),
            p.weakTo?.length ? h("small", {}, `Trouble: ${joinNames(p.weakTo.map((w) => name(w)))}`) : null))),
        cell("Brought", h("span", { class: "bd-tr-fact" }, pct(p.brought), h("i", { "aria-hidden": "true" }, h("i", { style: { width: pct(p.brought) } })))),
        cell("Leads", pct(p.lead)),
        cell("KOs per game", p.brought ? p.kosPerGame.toFixed(1) : "–"),
        cell("Faints", p.brought ? pct(p.faintRate) : "–"),
        cell("Duels won", h("span", { class: `bd-tr-win ${winTone(p.duel)}` }, pct(p.duel))))))));
}

// --- (E) by archetype ------------------------------------------------------------------------

function archetypeCard(s, section, pill) {
  const rows = s.archetypes || [];
  if (!rows.length) return null;
  return section("By archetype", "How the matchups split against each kind of team.",
    h("div", { class: "bd-tr-legend", "aria-hidden": "true" }, ["good", "mid", "bad"].map((t) => h("span", { class: t }, h("i", {}), BAND_LABEL[t]))),
    h("ol", { class: "bd-tr-archs" }, rows.map((a) => {
      const parts = [["good", a.favourable], ["mid", a.even], ["bad", a.unfavourable]];
      return h("li", { class: "bd-tr-arch" },
        h("div", { class: "bd-tr-arch-top" },
          h("span", {}, h("strong", {}, a.name), h("small", {}, ` · ${pct(a.share)} of teams (${number(a.count)})`)),
          pill(bandOf(a.average), `Average ${Math.round(clamp100(a.average))}`)),
        h("div", { class: "bd-tr-bands small", role: "img", "aria-label": `${a.name}: ${parts.map(([t, v]) => `${BAND_LABEL[t]} ${pct(v)}`).join(", ")}` },
          parts.map(([t, v]) => (v > 0 ? h("i", { class: t, style: { width: `${v * 100}%` }, title: `${BAND_LABEL[t]} ${pct(v)}` }) : null))));
    })));
}

// --- (F) the hardest teams, as short stories ----------------------------------------------

function storyLine(e, name) {
  const own = e.side === "you" ? "Your" : "Their";
  const other = e.side === "you" ? "their" : "your";
  const actor = name(e.actor);
  switch (e.kind) {
    case "weather": return `${own} ${actor} brings ${WEATHER_TEXT[e.value] || e.value}.`;
    case "terrain": return `${own} ${actor} sets ${e.value} Terrain.`;
    case "intimidate": return `${own} ${actor}'s Intimidate lowers the Attack of ${other} ${joinNames((e.targets || []).map(name))}.`;
    case "fakeout": return `${own} ${actor} uses Fake Out on ${other} ${name(e.target)}, so it cannot move this turn.`;
    case "blocked": return `${own} ${actor}'s ${e.move} is blocked by Protect.`;
    case "protect": return `${own} ${actor} protects itself.`;
    case "tailwind": return `${e.side === "you" ? "You" : "They"} set up Tailwind with ${actor}: ${e.side === "you" ? "your" : "their"} Speed doubles for the next 3 turns.`;
    case "trickroom": return e.on
      ? `${e.side === "you" ? "You" : "They"} set up Trick Room with ${actor}: slower Pokémon move first for the next 4 turns.`
      : `${e.side === "you" ? "You" : "They"} end Trick Room with ${actor}.`;
    case "redirect": return `${own} ${actor} uses ${e.move} and draws ${other} single-target attacks.`;
    case "speeddrop": {
      // Only the Pokémon that really lost Speed are listed (an immune one is not).
      const loses = (list) => `${joinNames(list.map(name))} lose${list.length === 1 ? "s" : ""} Speed`;
      const parts = [];
      if (e.targets?.length) parts.push(`${other} ${loses(e.targets)}`);
      if (e.own?.length) parts.push(`${own.toLowerCase()} own ${loses(e.own)}${parts.length ? " too" : ""}`);
      return `${own} ${actor} uses ${e.move}${parts.length ? `: ${parts.join(", and ")}` : ""}.`;
    }
    case "ko": return `${own} ${actor} knocks out ${other} ${name(e.target)}.`;
    case "partnerko": return `${own} ${actor}'s ${e.move || "attack"} also hits ${own.toLowerCase()} own ${name(e.target)} and knocks it out.`;
    default: return "";
  }
}

function afterLine(game, name) {
  const a = game.after;
  if (!a) return "";
  const parts = [];
  parts.push(a.faster === "you" ? "you move first" : a.faster === "them" ? "they move first" : "the Speed order is split");
  if (a.tailwind?.you) parts.push(`your Tailwind lasts ${a.tailwind.you} more turns`);
  if (a.tailwind?.them) parts.push(`their Tailwind lasts ${a.tailwind.them} more turns`);
  if (a.trickRoom) parts.push(`Trick Room lasts ${a.trickRoom} more turns`);
  if (a.weather && a.weather !== "None") parts.push(`${WEATHER_TEXT[a.weather] || a.weather} is up`);
  if (a.terrain && a.terrain !== "None") parts.push(`${a.terrain} Terrain is up`);
  const hurt = (mons, hp, owner) => mons.map((m, i) => [m, hp?.[i] ?? 100]).filter(([, v]) => v < 100)
    .map(([m, v]) => (v <= 0 ? `${owner} ${name(m)} has fainted` : `${owner} ${name(m)} is at ${v}%`));
  const damage = [...hurt(game.bring || [], a.hp?.you, "your"), ...hurt(game.against || [], a.hp?.them, "their")];
  const text = parts.join(", ");
  return `After turn 1: ${text}. ${damage.length ? `${damage.join("; ").replace(/^./, (c) => c.toUpperCase())}.` : "Everyone still has full HP."}`;
}

function resultLine(game) {
  const r = game.result;
  if (!r) return "";
  const [yours, theirs] = r.kos;
  const turns = `${r.turns} turn${r.turns === 1 ? "" : "s"}`;
  const size = game.bring?.length || 0;
  const theirSize = game.against?.length || 0;
  if (yours >= theirSize && theirSize) return `Result: you win, knocking out all ${word(theirSize)} of theirs and losing ${word(theirs)}, in ${turns}.`;
  if (theirs >= size && size) return `Result: you lose, knocking out ${word(yours)} of theirs before your ${word(size)} are out, in ${turns}.`;
  return `Result: after ${turns} neither side is out (you knocked out ${word(yours)}, they knocked out ${word(theirs)}); the HP left decides.`;
}

function gameRow(game, { open, group, bandPill, name, sprite }) {
  const lead = (list, count) => list.slice(0, count).map((m) => name(m));
  const names = (list) => joinNames(list.map((m) => name(m)));
  const leadsOf = game.against?.[0] || game.members?.[0];
  const story = (game.story || []).map((e) => storyLine(e, name)).filter(Boolean);
  return h("details", { class: "bd-tr-game", open: open || null, "data-key": `${group}-${game.number}` },
    h("summary", {},
      leadsOf ? sprite(leadsOf, 32) : h("span"),
      h("span", { class: "bd-tr-game-title" },
        h("strong", {}, `Team #${game.number}`, game.archetype ? ` · ${game.archetype}` : ""),
        h("small", {}, (game.members || []).map((m) => name(m)).join(", "))),
      bandPill(game.value)),
    h("div", { class: "bd-tr-game-body" },
      h("p", {}, h("b", {}, "You bring "), names(game.bring || []), game.leads ? ` (leading with ${joinNames(lead(game.bring || [], game.leads))})` : "", "."),
      h("p", {}, h("b", {}, "They bring "), names(game.against || []), game.theirLeads ? ` (leading with ${joinNames(lead(game.against || [], game.theirLeads))})` : "", "."),
      h("p", { class: "bd-tr-game-label" }, "Turn 1"),
      h("ul", { class: "bd-tr-story" }, story.length ? story.map((line) => h("li", {}, line)) : h("li", {}, "Both sides attack.")),
      h("p", {}, afterLine(game, name)),
      h("p", { class: "bd-tr-result" }, resultLine(game))));
}

function hardestCard(s, section, bandPill, helpers) {
  const rows = s.hardest || [];
  if (!rows.length) return null;
  return section("Hardest teams", "The matchups you do worst in, told as the game plays out.",
    h("div", { class: "bd-tr-games" }, rows.map((game, i) => gameRow(game, { open: i === 0, group: "hard", bandPill, ...helpers }))));
}

// --- (G) more detail ------------------------------------------------------------------------

function duelTable(s, { name, sprite }) {
  const cols = s.duels?.columns || [];
  const rows = s.duels?.rows || [];
  if (!cols.length || !rows.length) return null;
  return h("div", { class: "bd-tr-block" },
    h("h4", {}, "Duels after turn 1"),
    h("p", { class: "bd-note" }, "Each cell is a 1-on-1 from full HP on the board turn 1 left (weather, terrain, Tailwind, Trick Room): who needs fewer hits to knock the other out, then who moves first. Rows are their most common Pokémon, columns are yours."),
    h("div", { class: "bd-tr-legend", "aria-hidden": "true" }, ["good", "mid", "bad"].map((t) => h("span", { class: t }, h("i", {}), `${WIN_ICON[t]} ${WIN_LABEL[t]}`))),
    h("div", { class: "bd-tr-duels", role: "table", style: { "--cols": cols.length } },
      h("div", { class: "bd-tr-duels-row", role: "row" },
        h("span", { class: "bd-tr-duels-corner", role: "columnheader" }, "Their Pokémon"),
        cols.map((c) => h("span", { class: "bd-tr-duels-col", role: "columnheader", title: name(c) }, h("span", {}, name(c))))),
      rows.map((row) => h("div", { class: "bd-tr-duels-row", role: "row" },
        h("span", { class: "bd-tr-duels-name", role: "rowheader" }, sprite(row, 28), h("span", {}, h("strong", {}, name(row)), h("small", {}, `in ${pct(row.share)}`))),
        row.cells.map((win, i) => {
          const tone = winTone(win);
          return h("span", { class: `bd-tr-duel ${tone}`, role: "cell", title: `${name(cols[i])} against ${name(row)}: ${WIN_LABEL[tone].toLowerCase()} (${pct(win)})`, "aria-label": `${name(cols[i])} against ${name(row)}: ${WIN_LABEL[tone].toLowerCase()}, ${pct(win)}` },
            h("span", { "aria-hidden": "true" }, WIN_ICON[tone]), pct(win));
        })))));
}

function moreDetail(s, section, bandPill, helpers) {
  const { name } = helpers;
  const others = (s.bestBrings || []).slice(1).filter((b) => b.bestRate > 0);
  const easiest = s.easiest || [];
  return h("details", { class: "bd-tr-more", "data-key": "more" },
    h("summary", {}, "More detail", h("small", {}, "duels after turn 1, other choices to bring, easiest teams")),
    h("div", { class: "bd-tr-more-body" },
      duelTable(s, helpers),
      others.length ? h("div", { class: "bd-tr-block" },
        h("h4", {}, "Other strong choices to bring"),
        h("ul", { class: "bd-tr-brings" }, others.map((b) => h("li", {},
          h("strong", {}, joinNames(b.members.map((m) => name(m)))),
          h("small", {}, `leading with ${joinNames(b.leads.map((m) => name(m)))} · your best choice against ${pct(b.bestRate)} of the teams`))))) : null,
      easiest.length ? h("div", { class: "bd-tr-block" },
        h("h4", {}, "Easiest teams"),
        h("div", { class: "bd-tr-games" }, easiest.map((game) => gameRow(game, { open: false, group: "easy", bandPill, ...helpers })))) : null));
}
