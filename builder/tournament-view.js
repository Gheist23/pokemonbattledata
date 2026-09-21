// The Result Analysis of "Test against Tournament Teams" (builder/tournament-test.js).
// Drawn from one snapshot, so the page can redraw it after every batch while the
// test runs.

import { MATCHUP_BANDS } from "./tournament-test.js";
import { h, scoreRing } from "./ui.js";

const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
const number = (value) => Number(value || 0).toLocaleString("en-US");
const bandOf = (value) => (value >= MATCHUP_BANDS.favourable ? "good" : value < MATCHUP_BANDS.unfavourable ? "bad" : "mid");
const winTone = (win) => (win >= 0.6 ? "good" : win < 0.4 ? "bad" : "mid");

/** How the test works, in three steps. */
export function tournamentExplainer(teamCount) {
  const step = (n, title, text) => h("div", { class: "bd-tour-step" }, h("span", { class: "bd-tour-step-n" }, n), h("div", {}, h("strong", {}, title), h("p", {}, text)));
  return h("div", { class: "bd-tour-how" },
    step("1", "Matchup Matrix", "Each of your Pokémon meets each of theirs 1-on-1: both use their best move, the faster side (priority, then Speed) strikes first, and KO odds decide how often each side wins the race."),
    step("2", "Both sides bring four", "For every four of yours (a core), the tournament team answers with the four that hurt it most. Your matchup is the core that holds up best."),
    step("3", "Across the teams", `Played against up to ${number(teamCount)} real tournament teams from the Companion's library. 50 is an even matchup; ${MATCHUP_BANDS.favourable}+ favours you, under ${MATCHUP_BANDS.unfavourable} favours them.`));
}

/**
 * @param {object} s            a snapshot from TournamentTest.run
 * @param {{name:(mon)=>string, sprite:(mon, size)=>Node, running:boolean}} helpers
 */
export function tournamentAnalysis(s, { name, sprite, running }) {
  if (!s || !s.tested) return h("div", { class: "bd-loading" }, h("span", { class: "bd-spinner" }), "Building the first matchups…");
  const n = Math.max(1, s.tested);
  const mons = (list, size = 30) => h("span", { class: "bd-mon-row" }, (list || []).map((m) => h("span", { class: "bd-mon-chip", title: name(m) }, sprite(m, size))));
  const section = (title, note, ...body) => h("section", { class: "bd-tour-card" },
    h("div", { class: "bd-section-head" }, h("h3", { class: "bd-field-label" }, title), note ? h("span", { class: "bd-note" }, note) : null),
    ...body);

  // --- the headline --------------------------------------------------------------
  const bands = [
    ["good", "Favourable", s.bands.favourable],
    ["mid", "Even", s.bands.even],
    ["bad", "Unfavourable", s.bands.unfavourable],
  ];
  const summary = h("div", { class: "bd-tour-summary" },
    h("div", { class: "bd-tour-headline" },
      scoreRing(s.average, "Average matchup"),
      h("div", {}, h("strong", {}, "Average matchup"), h("small", {}, s.average >= MATCHUP_BANDS.favourable ? "The field favours you" : s.average < MATCHUP_BANDS.unfavourable ? "The field favours them" : "Close to even overall"))),
    h("div", { class: "bd-tour-bands" },
      h("div", { class: "bd-tour-bandbar", role: "img", "aria-label": bands.map(([, label, count]) => `${label} ${count}`).join(", ") },
        bands.map(([tone, label, count]) => (count ? h("i", { class: tone, style: { width: `${(100 * count) / n}%` }, title: `${label}: ${count}` }) : null))),
      h("div", { class: "bd-tour-legend" }, bands.map(([tone, label, count]) => h("span", { class: tone }, h("b", {}, pct(count / n)), ` ${label} · ${number(count)}`)))),
    h("div", { class: "bd-tour-stats" },
      h("div", {}, h("b", {}, `${number(s.tested)}`), h("small", {}, `of ${number(s.total)} teams`)),
      h("div", {}, h("b", {}, `${s.seconds.toFixed(1)} s`), h("small", {}, `${number(s.pairs)} pairings`)),
      s.mostBrought ? h("div", { class: "bd-tour-brought" }, mons(s.mostBrought.members, 28), h("small", {}, `your usual four · ${pct(s.mostBrought.bestRate)}`)) : null));

  // --- how the matchups spread ------------------------------------------------------
  const peak = Math.max(1, ...s.histogram);
  const histogram = section("Matchup spread", `${number(s.tested)} teams`,
    h("div", { class: "bd-tour-hist" }, s.histogram.map((count, i) => h("div", { class: `bd-tour-hist-col ${bandOf(i * 10 + 5)}`, title: `${i * 10}–${i * 10 + 10}: ${count} teams` },
      h("span", { class: "bd-tour-hist-count" }, count || ""),
      h("i", { style: { height: `${Math.max(count ? 4 : 0, (100 * count) / peak)}%` } }),
      h("span", { class: "bd-tour-hist-label" }, i * 10)))));

  // --- by archetype ----------------------------------------------------------------------
  const archetypes = (s.archetypes || []).length ? section("Against each archetype", "how the matchup goes, by their archetype",
    h("ol", { class: "bd-arch-list" }, s.archetypes.map((a) => {
      const avg = Math.max(0, Math.min(100, a.average));
      const band = bandOf(avg);
      return h("li", { class: "bd-arch" },
        h("div", { class: "bd-arch-top" },
          h("span", {}, h("strong", {}, a.name), h("small", {}, ` ${number(a.count)} team${a.count === 1 ? "" : "s"} · ${pct(a.share)}`)),
          h("b", { class: `bd-value ${band}` }, avg.toFixed(1))),
        h("span", { class: "bd-arch-bar", role: "img", "aria-label": `${a.name}: ${avg.toFixed(1)}` },
          h("i", { class: band, style: { left: `${Math.min(avg, 50)}%`, width: `${Math.max(1, Math.abs(avg - 50))}%` } })),
        h("small", { class: "bd-arch-split" }, `${pct(a.favourable)} favourable · ${pct(a.unfavourable)} unfavourable`));
    }))) : null;

  // --- the Matchup Matrix -------------------------------------------------------------
  const columns = s.matrix.columns || [];
  const matrix = section("Matchup Matrix", "your 1-on-1 win chance against their most common Pokémon",
    h("div", { class: "bd-matrix-scroll" },
      h("div", { class: "bd-matrix", style: `--cols: ${columns.length}` },
        h("span", { class: "bd-matrix-corner" }),
        columns.map((c) => h("span", { class: "bd-matrix-head", title: `${name(c)}: in ${pct(c.share)} of the teams` }, sprite(c, 34), h("small", {}, pct(c.share)))),
        (s.matrix.rows || []).map((row) => [
          h("span", { class: "bd-matrix-row" }, sprite(row, 30), h("span", {}, name(row))),
          row.cells.map((win, i) => h("span", { class: `bd-matrix-cell ${winTone(win)}`, style: `--win: ${win}`, title: `${name(row)} vs ${name(columns[i])}: ${pct(win)}` }, pct(win))),
        ]))));

  // --- cores ---------------------------------------------------------------------------
  const coreRow = (core, i) => h("li", { class: "bd-core" },
    h("span", { class: "bd-core-rank" }, i + 1),
    mons(core.members, 34),
    h("span", { class: "bd-core-meta" }, h("b", { class: `bd-value ${bandOf(core.value)}` }, core.value.toFixed(1)), h("small", {}, `your pick in ${pct(core.bestRate)}`)));
  const cores = h("div", { class: "bd-tour-pair" },
    section("Best cores", `four of your ${s.ours.length}`, h("ol", { class: "bd-core-list" }, s.bestCores.map(coreRow))),
    s.worstCores.length ? section("Worst cores", "avoid bringing these", h("ol", { class: "bd-core-list" }, s.worstCores.map(coreRow))) : null);

  // --- your Pokémon ----------------------------------------------------------------------
  const pokemon = section("Your Pokémon against the field", "average 1-on-1 win chance",
    h("ol", { class: "bd-rank-list" }, s.pokemon.map((p, i) => h("li", { class: "bd-rank" },
      h("span", { class: "bd-rank-n" }, i + 1),
      sprite(p, 44),
      h("div", { class: "bd-rank-main" },
        h("div", { class: "bd-rank-top" }, h("strong", {}, name(p)), h("b", { class: `bd-value ${winTone(p.win)}` }, pct(p.win))),
        h("span", { class: "bd-meter" }, h("i", { class: winTone(p.win), style: { width: pct(p.win) } })),
        h("small", {}, `In your best four ${pct(p.brought)} of the time`)),
      h("div", { class: "bd-rank-worst" }, h("small", {}, "Struggles against"), mons(p.worst, 28))))));

  // --- their Pokémon ----------------------------------------------------------------------
  const threats = section("Biggest threats", "common and hard to answer",
    h("ol", { class: "bd-threat-list" }, s.threats.map((t) => h("li", { class: "bd-threat-row" },
      sprite(t, 40),
      h("div", { class: "bd-rank-main" },
        h("div", { class: "bd-rank-top" }, h("strong", {}, name(t)), h("small", {}, t.share >= 0.01 ? `in ${pct(t.share)} of teams` : `in ${t.count} team${t.count === 1 ? "" : "s"}`)),
        h("span", { class: "bd-meter" }, h("i", { class: winTone(t.answer), style: { width: pct(t.answer) } })),
        h("small", {}, "Best answer ", h("b", {}, name(t.answerBy)), ` wins ${pct(t.answer)}`)),
      sprite(t.answerBy, 32)))));

  // --- teams ---------------------------------------------------------------------------------
  const teamRow = (team, { showAnswer = false } = {}) => h("li", { class: "bd-tour-team" },
    h("div", { class: "bd-tour-team-top" },
      h("span", { class: "bd-tour-team-no" }, `#${team.number}`, team.archetype ? h("small", {}, team.archetype) : null),
      mons(team.members, 26),
      h("b", { class: `bd-value ${bandOf(team.value)}` }, team.value.toFixed(0))),
    h("div", { class: "bd-tour-team-plan" },
      h("small", {}, "You bring"), mons(team.core, 22),
      showAnswer && team.against?.length ? [h("small", {}, "they answer with"), mons(team.against, 22)] : null));
  const teams = h("div", { class: "bd-tour-pair" },
    section("Hardest teams", "", h("ol", { class: "bd-tour-teams" }, s.hardest.map((t) => teamRow(t, { showAnswer: true })))),
    section("Easiest teams", "", h("ol", { class: "bd-tour-teams" }, s.easiest.map((t) => teamRow(t)))));

  const live = running && s.latest?.length
    ? section("Now testing", "the latest matchups", h("ol", { class: "bd-tour-teams bd-tour-live" }, s.latest.map((t) => teamRow(t))))
    : null;

  return h("div", { class: `bd-tour-analysis ${running ? "running" : ""}` }, summary, live, archetypes, histogram, matrix, cores, pokemon, threats, teams);
}
