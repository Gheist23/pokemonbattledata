// The results of "Test against Tournament Teams" (builder/tournament-test.js), drawn
// from one snapshot so the page can redraw them after every batch while the test runs.
//
// Reads top-down: the verdict, what to bring (the recommended choice and the other strong
// ones), the biggest threats, your Pokémon, each archetype from best to worst, the hardest
// and the easiest teams as short stories, the lead matrix (2 vs 2 in Doubles, 1 vs 1 in
// Singles) and the most similar tournament team.
// One set of colours throughout: Favoured / Even / Behind for every matchup score, whether
// it comes from a 2 vs 2 or a 1 vs 1 game, and a neutral colour for plain facts such as
// "brought 80%".

import { MATCHUP_BANDS, SNAPSHOT_VERSION } from "./tournament-test.js";
import { h } from "./ui.js";

const BAND_LABEL = { good: "Favoured", mid: "Even", bad: "Behind" };
const BAND_ICON = { good: "▲", mid: "●", bad: "▼" };
const WORDS = ["none", "one", "two", "three", "four", "five", "six"];
const WEATHER_TEXT = { Sun: "harsh sunlight", Rain: "rain", Sand: "a sandstorm", Snow: "snow", "Strong Winds": "strong winds" };
const STAT_TEXT = { atk: "Attack", spa: "Sp. Atk", spe: "Speed" };
// The verdict names a strongest and a weakest archetype only when their averages differ by this much.
const ARCHETYPE_GAP = 3;
// The lead matrix: rows shown at first and per "Show more", and our pairs shown before "Show all".
const MATRIX_STEP = 10;
const PAIR_COLUMNS = 8;

// What the viewer opened in the lead matrix; kept across the redraws of a running test.
const matrixView = { rows: MATRIX_STEP, allColumns: false };
// How many the last results shown brought, per format. A team with fewer than three (Singles)
// or four (Doubles) Pokémon brings all of them, and the explainer has to say so. Callers should
// pass `bring` to tournamentExplainer; this is what it falls back to when they do not. It
// outlives a new test on purpose: the team size is the same until the team itself changes.
const lastBring = { Doubles: 0, Singles: 0 };

/** Back to the first rows of the lead matrix (a new test). */
export function resetTournamentView() {
  matrixView.rows = MATRIX_STEP;
  matrixView.allColumns = false;
}

const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
const number = (value) => Number(value || 0).toLocaleString("en-US");
const word = (n) => WORDS[n] || String(n);
const clamp100 = (value) => Math.max(0, Math.min(100, Number(value) || 0));
const score = (value) => Math.round(clamp100(value));
export const bandOf = (value) => (value >= MATCHUP_BANDS.favourable ? "good" : value < MATCHUP_BANDS.unfavourable ? "bad" : "mid");

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

/**
 * How the test works, step by step.
 * `bring` is how many of ours the test brings (a team of two brings two, not four); leave it
 * out and it falls back to the size of the last results drawn, then to the full bring size.
 * The tournament teams always have six, so their side always brings four (Doubles) or three.
 */
export function tournamentExplainer({ teams = 2827, format = "Doubles", bring = 0 } = {}) {
  const singles = format === "Singles";
  const full = singles ? 3 : 4;
  const theirs = word(full);
  const size = Number(bring) > 0 ? Math.min(Math.round(Number(bring)), full) : lastBring[singles ? "Singles" : "Doubles"] || full;
  const ours = word(size);
  const same = size === full;
  const step = (n, title, text) => h("div", { class: "bd-tour-step" }, h("span", { class: "bd-tour-step-n" }, n), h("div", {}, h("strong", {}, title), h("p", {}, text)));
  return h("div", { class: "bd-tour-explain" },
    h("div", { class: "bd-tour-how" },
      step("1", "The leads", singles
        ? "Both sides lead with the Pokémon that does the most on turn 1. Intimidate and weather or terrain Abilities trigger as it comes in."
        : "Both sides lead with the two Pokémon that do the most on turn 1, so every game starts as your pair against their pair. Intimidate and weather or terrain Abilities trigger as they come in."),
      step("2", "Turn 1", singles
        ? "Each lead picks one action, and they go in priority and Speed order: Fake Out, Tailwind, Trick Room, Protect, Quick Guard, sleep moves like Spore, Taunt, Encore, Speed drops like Icy Wind, Attack and Sp. Atk drops like Snarl, Parting Shot and Charm, Will-O-Wisp, or its best attack."
        : "Each of the four picks one action, and they go in priority and Speed order: Fake Out, Tailwind, Trick Room, Helping Hand, Protect, Wide Guard against spread moves, Quick Guard against Fake Out and priority moves, Follow Me and Rage Powder, sleep moves like Spore, Taunt, Encore, Speed drops like Icy Wind, Attack and Sp. Atk drops like Snarl, Parting Shot and Charm, Will-O-Wisp, or its best attack. Each lead plans with its partner, and Earthquake and similar moves hit the partner too."),
      step("3", "After turn 1", `From turn 2 ${singles ? "both Pokémon attack" : "all four attack"} on the board turn 1 left behind. Tailwind doubles Speed for 3 more turns, Trick Room lets slower Pokémon move first for 4 more, stat drops stay, sleep and Encore cost the next turns, a burn halves physical damage, and every Pokémon keeps the HP it has left. A Pokémon that faints is replaced from the back until one side is out.`),
      step("4",
        same ? `Both sides bring ${theirs}` : `You bring ${size === 1 ? "your one" : ours}, they bring ${theirs}`,
        same
          ? `Every ${theirs} you could bring plays every ${theirs} they could bring. You get the ${theirs} that hold up best; they answer with the ${theirs} that do the most against your choice.`
          : size === 1
            ? `Your one Pokémon plays every ${theirs} they could bring. They answer with the ${theirs} that do the most against it.`
            : `Every ${ours} you could bring plays every ${theirs} they could bring. You get the ${ours} that hold up best; they answer with the ${theirs} that do the most against your choice.`),
      step("5", "One Mega Evolution a side",
        "Only one Pokémon a side may Mega-Evolve, so a bring carries one Mega Stone. When two holders have to come along anyway, the one that gains more Mega-Evolves and the other plays its own base form — base stats, base Ability, base Speed — with the stone still in hand."),
      step("6", "Across the teams", `Played against up to ${number(teams)} real tournament teams. A score of 50 is even; ${MATCHUP_BANDS.favourable} or more favours you, under ${MATCHUP_BANDS.unfavourable} favours them.`)),
    h("p", { class: "bd-note bd-tour-limits" },
      "Kept simple on purpose: nobody switches out (Parting Shot lowers the stats but its user stays in), paralysis, poison, screens and stat-boosting moves are left out, and each Pokémon picks its best play without guessing what the other side will do. ",
      singles ? "The tournament teams come from Doubles events; in Singles both sides play one Pokémon at a time." : ""));
}

/**
 * @param {object} s            a snapshot from TournamentTest.run (version 3)
 * @param {{name:(mon)=>string, sprite:(mon, size)=>Node, running:boolean, loadTeam?:(similar)=>void}} helpers
 */
export function tournamentAnalysis(s, { name, sprite, running, loadTeam = null }) {
  if (!s || !s.tested || s.version !== SNAPSHOT_VERSION) return h("div", { class: "bd-loading" }, h("span", { class: "bd-spinner" }), "Playing the first tournament teams…");
  const doubles = (s.active || (s.format === "Singles" ? 1 : 2)) > 1;
  if (s.bring > 0) lastBring[doubles ? "Doubles" : "Singles"] = s.bring;
  const c = {
    s, name, sprite, running, loadTeam,
    n: Math.max(1, s.tested),
    doubles,
    // How many we bring (our team can be smaller) and how many they bring (always a full six).
    bring: word(s.bring),
    theirBring: word(doubles ? 4 : 3),
    section: (title, note, ...body) => h("section", { class: "bd-tr-card" },
      h("div", { class: "bd-tr-head" }, h("h3", {}, title), note ? h("p", { class: "bd-note" }, note) : null),
      ...body),
    pill: (tone, text, attrs = {}) => h("span", { class: `bd-tr-pill ${tone}`, ...attrs }, text),
  };
  c.bandPill = (value) => c.pill(bandOf(value), `${BAND_LABEL[bandOf(value)]} · ${score(value)}`);
  return h("div", { class: `bd-tr ${running ? "running" : ""}` },
    verdictCard(c),
    bringCard(c),
    threatsCard(c),
    pokemonCard(c),
    archetypeCard(c),
    teamsCard(c, "hard"),
    teamsCard(c, "easy"),
    matrixCard(c),
    similarCard(c));
}

/** Pokémon names joined with "+" (a pair on the field). */
function plus(list, name) {
  return list.map((m) => held(m, name)).join(" + ");
}

/**
 * A Pokémon's name, saying which Mega Stone it is holding when it does not Mega-Evolve.
 * Only one Pokémon a side may Mega-Evolve, so a second stone holder plays its base form and
 * the results name it that way; the snapshot puts its stone under `stone`.
 */
function held(mon, name) {
  return mon?.stone ? `${name(mon)} (holding ${mon.stone})` : name(mon);
}

// --- the verdict ----------------------------------------------------------------------------

function verdictCard({ s, n, doubles, bring, theirBring }) {
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
  return h("section", { class: `bd-tr-verdict ${tone}` },
    h("div", { class: "bd-tr-verdict-main" },
      h("p", { class: "bd-tr-kicker" }, `${s.done ? "" : "So far: "}${number(s.tested)} tournament team${s.tested === 1 ? "" : "s"} · ${s.format}`),
      h("h3", {}, title),
      subline ? h("p", { class: "bd-tr-sub" }, subline) : null,
      h("div", { class: "bd-tr-bands", role: "img", "aria-label": bands.map(([t, count]) => `${BAND_LABEL[t]}: ${count} teams`).join(", ") },
        bands.map(([t, count]) => (count ? h("i", { class: t, style: { width: `${(100 * count) / n}%` } }) : null))),
      h("div", { class: "bd-tr-bandlabels" }, bands.map(([t, count]) => h("span", { class: t },
        h("b", {}, pct(count / n)),
        h("small", {}, `${BAND_LABEL[t]} · ${number(count)} team${count === 1 ? "" : "s"}`))))),
    h("div", { class: "bd-tr-verdict-score" },
      h("small", {}, "Average score"),
      h("b", { class: tone }, score(s.average)),
      h("span", {}, "of 100 · 50 is even"),
      h("p", { class: "bd-note" }, doubles
        ? `Each team is scored by your best ${bring} against the ${theirBring} of theirs that do the most against it, played 2 vs 2 from the leads on.`
        : `Each team is scored by your best ${bring} against the ${theirBring} of theirs that do the most against it, played 1 vs 1.`)));
}

// --- what to bring --------------------------------------------------------------------------

function bringCard({ s, n, doubles, bring, section, name, sprite }) {
  const limit = doubles ? 4 : 3;
  const options = (s.bestBrings || []).filter((b, i) => i === 0 || b.bestRate > 0).slice(0, limit);
  if (!options.length) return null;
  const option = (b, i) => {
    const leads = new Set((b.leads || []).map((m) => m.slot));
    const leadList = b.members.filter((m) => leads.has(m.slot));
    const back = b.members.filter((m) => !leads.has(m.slot));
    const size = i === 0 ? 44 : 36;
    return h("li", { class: `bd-tr-option ${i === 0 ? "first" : ""}` },
      h("span", { class: "bd-tr-option-rank", "aria-hidden": "true" }, String(i + 1)),
      h("div", { class: "bd-tr-option-mons" }, [...leadList, ...back].map((m) => h("span", { class: `bd-tr-option-mon ${leads.has(m.slot) ? "lead" : ""}`, title: `${held(m, name)}${leads.has(m.slot) ? " (lead)" : ""}` },
        sprite(m, size),
        leads.has(m.slot) ? h("small", {}, "Lead") : h("small", { "aria-hidden": "true" }, " ")))),
      h("div", { class: "bd-tr-option-text" },
        h("strong", {}, i === 0 ? "Recommended" : `Option ${i + 1}`),
        h("p", {}, leadList.length
          // "Lead A + B" only when there really are two of them: a team of one leads with one.
          ? `${leadList.length > 1 ? `Lead ${plus(leadList, name)}` : `Lead with ${held(leadList[0], name)}`}${back.length ? `, then ${joinNames(back.map((m) => held(m, name)))}` : ""}.`
          : joinNames(b.members.map((m) => held(m, name)))),
        h("small", {}, `Your best choice against ${pct(b.bestRate)} of the teams · ${score(b.value)} on average when brought against every team`)));
  };
  const leadCount = options[0].leads?.length || (doubles ? 2 : 1);
  const more = options.length > 1 ? ` The other strong choices are each your best ${bring} against some of the teams.` : "";
  const note = s.bring === 1
    ? `Your one Pokémon, played against every team.${more}`
    : `The ${bring} that hold up best against the most teams${leadCount < s.bring ? `, with the ${word(leadCount)} you lead with` : ""}.${more}`;
  return section(s.bring === 1 ? "Bring this one" : `Bring these ${bring}`, note,
    h("ol", { class: "bd-tr-options" },
      option(options[0], 0),
      options.length > 1 ? h("li", { class: "bd-tr-options-label" }, "Other strong choices to bring") : null,
      options.slice(1).map((b, i) => option(b, i + 1))),
    n < 20 ? h("p", { class: "bd-note" }, "Early in the run these shares still move a lot.") : null);
}

// --- the biggest threats ------------------------------------------------------------------

function threatsCard({ s, doubles, section, pill, name, sprite }) {
  const rows = s.threats || [];
  const answer = (t) => {
    if (doubles && t.pairAnswer) {
      const tone = bandOf(t.pairAnswer.value);
      // Beside its usual partner it may be the one that cannot Mega-Evolve, and the score
      // belongs to that form, so the line names it.
      const into = t.pairAnswer.subject?.stone ? held(t.pairAnswer.subject, name) : "it";
      return h("p", {}, `Your best lead pair into ${into}: `, h("b", {}, plus(t.pairAnswer.members, name)),
        ` (${BAND_LABEL[tone]}, ${score(t.pairAnswer.value)} against it with ${held(t.pairAnswer.partner, name)})`);
    }
    // The 1 vs 1 game the Matchups card below draws, so both say the same thing.
    if (t.answer.value !== null && t.answer.value !== undefined) {
      const tone = bandOf(t.answer.value);
      return h("p", {}, "Your best answer: ", h("b", {}, name(t.answer)), ` (${BAND_LABEL[tone]}, ${score(t.answer.value)} against it 1 vs 1)`);
    }
    return h("p", {}, "Your best answer: ", h("b", {}, name(t.answer)), ` (wins ${pct(t.answer.win)} of their 1-on-1s after turn 1)`);
  };
  return section("Biggest threats", doubles
    ? "Common Pokémon that knock out yours or are hard to knock out, with the pair of yours that does best against it and its usual partner, 2 vs 2."
    : "Common Pokémon that knock out yours or are hard to knock out, with the Pokémon of yours that does best against it in the 1 vs 1 games of the Matchups card below.",
  rows.length
    ? h("ol", { class: "bd-tr-threats" }, rows.map((t) => h("li", { class: "bd-tr-threat" },
      sprite(t, 36),
      h("div", { class: "bd-tr-threat-main" },
        h("div", { class: "bd-tr-threat-top" }, h("strong", {}, name(t)), pill(t.level === "high" ? "bad" : "mid", t.level === "high" ? "High" : "Medium", { title: "How big a threat it is" })),
        h("p", {}, `${t.share >= 0.01 ? `In ${pct(t.share)} of teams` : `In ${t.count} team${t.count === 1 ? "" : "s"}`} · brought against you in ${pct(t.brought)} of them`),
        h("p", {}, `Knocks out ${t.kosPerGame.toFixed(1)} of yours per game · survives ${pct(t.survived)} of games`),
        answer(t)))))
    : h("p", { class: "bd-note" }, "Nothing common stands out: every frequent Pokémon has a strong answer on your team."));
}

// --- your Pokémon ------------------------------------------------------------------------------

function pokemonCard({ s, doubles, bring, section, name, sprite }) {
  const last = doubles ? "Best partner" : "1 vs 1";
  const head = ["Pokémon", "Brought", "Leads", "KOs per game", "Faints", last];
  const cell = (label, content, cls = "") => h("td", { "data-label": label, class: cls }, content);
  const trouble = (p) => {
    if (doubles && p.weakPairs?.length) return `Trouble: ${p.weakPairs.map((w) => plus(w.members, name)).join(", ")}`;
    if (!doubles && p.weakTo?.length) return `Trouble: ${joinNames(p.weakTo.map((w) => name(w)))}`;
    return "";
  };
  // Singles: the score over the 1 vs 1 games of the Matchups card, not a separate reckoning.
  const oneOnOne = (p) => {
    if (p.oneOnOne === null || p.oneOnOne === undefined) return "–";
    const tone = bandOf(p.oneOnOne);
    return h("span", { class: `bd-tr-win ${tone}`, title: `${BAND_LABEL[tone]} · ${score(p.oneOnOne)} of 100 across the 1 vs 1 games` }, score(p.oneOnOne));
  };
  const partner = (p) => {
    if (!p.partner || p.pairScore === null || p.pairScore === undefined) return "–";
    const tone = bandOf(p.pairScore);
    return h("span", { class: "bd-tr-partner", title: `Leads best with ${held(p.partner, name)}: ${BAND_LABEL[tone]}, ${score(p.pairScore)}` },
      sprite(p.partner, 24),
      h("small", {}, name(p.partner)),
      h("b", { class: `bd-tr-win ${tone}` }, score(p.pairScore)));
  };
  return section("Your Pokémon", doubles
    ? `Brought: how often it is in your best ${bring}. Best partner: the partner it does best with as a lead pair against the pairs they lead with most, and that pair's score (2 vs 2, 50 is even). Trouble: the pairs of theirs that beat that lead pair.`
    : `Brought: how often it is in your best ${bring}. 1 vs 1: its score across the games in the Matchups card below, against the Pokémon they brought against you and weighted by how often each one came (50 is even). Trouble: the Pokémon of theirs it is Behind against there.`,
  h("table", { class: "bd-tr-table" },
    h("thead", {}, h("tr", {}, head.map((label) => h("th", { scope: "col" }, label)))),
    h("tbody", {}, (s.pokemon || []).map((p) => h("tr", {},
      h("th", { scope: "row", class: "bd-tr-mon" }, h("div", {},
        sprite(p, 32),
        h("span", {}, h("strong", {}, name(p)),
          trouble(p) ? h("small", {}, trouble(p)) : null))),
      cell("Brought", h("span", { class: "bd-tr-fact" }, pct(p.brought), h("i", { "aria-hidden": "true" }, h("i", { style: { width: pct(p.brought) } })))),
      cell("Leads", pct(p.lead)),
      cell("KOs per game", p.brought ? p.kosPerGame.toFixed(1) : "–"),
      cell("Faints", p.brought ? pct(p.faintRate) : "–"),
      cell(last, doubles ? partner(p) : oneOnOne(p)))))));
}

// --- by archetype ------------------------------------------------------------------------------

function archetypeCard({ s, section, pill }) {
  const rows = [...(s.archetypes || [])].sort((a, b) => b.average - a.average || b.count - a.count);
  if (!rows.length) return null;
  return section("By archetype", "From your best matchup to your worst: how the matchups split against each kind of team.",
    h("div", { class: "bd-tr-legend", "aria-hidden": "true" }, ["good", "mid", "bad"].map((t) => h("span", { class: t }, h("i", {}), BAND_LABEL[t]))),
    h("ol", { class: "bd-tr-archs" }, rows.map((a) => {
      const parts = [["good", a.favourable], ["mid", a.even], ["bad", a.unfavourable]];
      return h("li", { class: "bd-tr-arch" },
        h("div", { class: "bd-tr-arch-top" },
          h("span", {}, h("strong", {}, a.name), h("small", {}, ` · ${pct(a.share)} of teams (${number(a.count)})`)),
          pill(bandOf(a.average), `Average ${score(a.average)}`)),
        h("div", { class: "bd-tr-bands small", role: "img", "aria-label": `${a.name}: ${parts.map(([t, v]) => `${BAND_LABEL[t]} ${pct(v)}`).join(", ")}` },
          parts.map(([t, v]) => (v > 0 ? h("i", { class: t, style: { width: `${v * 100}%` }, title: `${BAND_LABEL[t]} ${pct(v)}` }) : null))));
    })));
}

// --- the hardest and easiest teams, as short stories --------------------------------------------

function statsText(stats) {
  return joinNames((stats || []).map((k) => STAT_TEXT[k] || k));
}

function storyLine(e, name) {
  const own = e.side === "you" ? "Your" : "Their";
  const other = e.side === "you" ? "their" : "your";
  const ownLower = own.toLowerCase();
  const actor = name(e.actor);
  const list = (items) => joinNames((items || []).map(name));
  switch (e.kind) {
    case "weather": return `${own} ${actor} brings ${WEATHER_TEXT[e.value] || e.value}.`;
    case "terrain": return `${own} ${actor} sets ${e.value} Terrain.`;
    case "intimidate": return `${own} ${actor}'s Intimidate lowers the Attack of ${other} ${list(e.targets)}.`;
    case "fakeout": return `${own} ${actor} uses Fake Out on ${other} ${name(e.target)}, so it cannot move this turn.`;
    case "blocked": return e.target
      ? `${own} ${actor}'s ${e.move} on ${other} ${name(e.target)} is blocked by ${e.by || "Protect"}.`
      : `${own} ${actor}'s ${e.move} is blocked by ${e.by || "Protect"}.`;
    case "protect": return `${own} ${actor} protects itself.`;
    case "wideguard": return `${own} ${actor} uses Wide Guard: moves that hit both of ${ownLower} Pokémon are blocked this turn.`;
    case "quickguard": return `${own} ${actor} uses Quick Guard: Fake Out and other priority moves into ${ownLower} side are blocked this turn.`;
    case "helpinghand": return `${own} ${actor} uses Helping Hand: ${ownLower} ${name(e.target)}'s attack is 50% stronger this turn.`;
    case "tailwind": return `${e.side === "you" ? "You" : "They"} set up Tailwind with ${actor}: ${ownLower} Speed doubles for the next 3 turns.`;
    case "trickroom": return e.on
      ? `${e.side === "you" ? "You" : "They"} set up Trick Room with ${actor}: slower Pokémon move first for the next 4 turns.`
      : `${e.side === "you" ? "You" : "They"} end Trick Room with ${actor}.`;
    case "redirect": return `${own} ${actor} uses ${e.move} and draws ${other} single-target moves.`;
    case "sleep": return `${own} ${actor} uses ${e.move}: ${other} ${name(e.target)} falls asleep and loses its next ${e.value === "1" ? "turn" : `${word(Number(e.value) || 2)} turns`}.`;
    case "taunt": return `${own} ${actor} taunts ${other} ${name(e.target)}: it cannot use status moves such as Trick Room or Tailwind.`;
    case "taunted": return `${own} ${actor} cannot use ${e.move}: it was taunted.`;
    case "encore": return `${own} ${actor}'s Encore makes ${other} ${name(e.target)} repeat a move that does nothing now: it loses its next ${word(Number(e.value) || 2)} turns.`;
    case "encorefail": return `${own} ${actor}'s Encore fails: ${other} ${name(e.target)} has not moved yet.`;
    case "burn": return `${own} ${actor} uses ${e.move}: ${other} ${name(e.target)} is burned, so its physical attacks do half damage.`;
    case "fails": return `${own} ${actor}'s ${e.move} has no effect on ${other} ${name(e.target)}.`;
    case "lower":
    case "speeddrop": {
      // Only the Pokémon whose stats really went down are listed (an immune one is not).
      const stat = e.kind === "speeddrop" ? "Speed" : statsText(e.stats);
      const loses = (items) => `${list(items)} ${items.length === 1 ? "has" : "have"} lower ${stat}`;
      const parts = [];
      if (e.targets?.length) parts.push(`${other} ${loses(e.targets)}`);
      if (e.own?.length) parts.push(`${ownLower} own ${loses(e.own)}${parts.length ? " too" : ""}`);
      return `${own} ${actor} uses ${e.move}${parts.length ? `: ${parts.join(", and ")}` : ""}.`;
    }
    case "ko": return `${own} ${actor} knocks out ${other} ${name(e.target)}.`;
    case "partnerko": return `${own} ${actor}'s ${e.move || "attack"} also hits ${ownLower} own ${name(e.target)} and knocks it out.`;
    case "burnout": return `${own} ${actor} faints from its burn.`;
    default: return "";
  }
}

function afterLine(game, doubles, name) {
  const a = game.after;
  if (!a) return "";
  const parts = [];
  parts.push(a.faster === "you" ? "you move first" : a.faster === "them" ? "they move first" : "the Speed order is split");
  if (a.tailwind?.you) parts.push(`your Tailwind lasts ${a.tailwind.you} more turns`);
  if (a.tailwind?.them) parts.push(`their Tailwind lasts ${a.tailwind.them} more turns`);
  if (a.trickRoom) parts.push(`Trick Room lasts ${a.trickRoom} more turns`);
  if (a.weather && a.weather !== "None") parts.push(`${WEATHER_TEXT[a.weather] || a.weather} is up`);
  if (a.terrain && a.terrain !== "None") parts.push(`${a.terrain} Terrain is up`);
  const state = { asleep: "asleep", stuck: "stuck repeating its move", burned: "burned" };
  const hurt = (mons, hp, status, owner) => mons.map((m, i) => [m, hp?.[i] ?? 100, status?.[i] || ""]).filter(([, v, st]) => v < 100 || st)
    .map(([m, v, st]) => (v <= 0 ? `${owner} ${name(m)} has fainted` : `${owner} ${name(m)} is at ${v}%${st ? ` and ${state[st] || st}` : ""}`));
  const damage = [...hurt(game.bring || [], a.hp?.you, a.status?.you, "your"), ...hurt(game.against || [], a.hp?.them, a.status?.them, "their")];
  const field = (list, idx) => (idx || []).map((i) => list?.[i]).filter(Boolean);
  const ours = field(game.bring, a.field?.you);
  const theirs = field(game.against, a.field?.them);
  const next = ours.length && theirs.length
    ? ` Turn 2 starts with your ${doubles ? plus(ours, name) : joinNames(ours.map(name))} against their ${doubles ? plus(theirs, name) : joinNames(theirs.map(name))}.`
    : "";
  return `After turn 1: ${parts.join(", ")}. ${damage.length ? `${damage.join("; ").replace(/^./, (ch) => ch.toUpperCase())}.` : "Everyone still has full HP."}${next}`;
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

function gameRow(game, { open, group, doubles, bandPill, name, sprite }) {
  const names = (list) => joinNames(list.map((m) => held(m, name)));
  const leadsOf = (list, count) => list.slice(0, count);
  const lineUp = (list, count) => (doubles ? plus(leadsOf(list, count), name) : names(leadsOf(list, count)));
  const story = (game.story || []).map((e) => storyLine(e, name)).filter(Boolean);
  const members = game.members || [];
  return h("details", { class: "bd-tr-game", open: open || null, "data-key": `${group}-${game.number}` },
    h("summary", {},
      h("span", { class: "bd-tr-six", role: "img", "aria-label": names(members) }, members.map((m) => sprite(m, 30))),
      h("span", { class: "bd-tr-game-title" },
        h("strong", {}, `Team #${game.number}`),
        game.archetype ? h("small", {}, game.archetype) : null),
      bandPill(game.value)),
    h("div", { class: "bd-tr-game-body" },
      h("p", {}, h("b", {}, "Leads: "), `your ${lineUp(game.bring || [], game.leads)} against their ${lineUp(game.against || [], game.theirLeads)}.`),
      h("p", {}, h("b", {}, "You bring "), names(game.bring || []), ". ", h("b", {}, "They bring "), names(game.against || []), "."),
      h("p", { class: "bd-tr-game-label" }, "Turn 1"),
      h("ul", { class: "bd-tr-story" }, story.length ? story.map((line) => h("li", {}, line))
        // How many are on the field: both sides' leads, which is fewer when our team is small.
        : h("li", {}, (game.leads || 0) + (game.theirLeads || 0) === 2 ? "Both attack." : `All ${word((game.leads || 0) + (game.theirLeads || 0))} attack.`)),
      h("p", {}, afterLine(game, doubles, name)),
      h("p", { class: "bd-tr-result" }, resultLine(game))));
}

function teamsCard(c, group) {
  const hard = group === "hard";
  const rows = (hard ? c.s.hardest : c.s.easiest) || [];
  if (!rows.length) return null;
  const note = hard
    ? `The matchups you do worst in. Open a team to see the game: ${c.doubles ? "both lead pairs" : "both leads"}, turn 1, the board after it, and the result.`
    : "The matchups you do best in, told the same way.";
  return c.section(hard ? "Hardest teams" : "Easiest teams", note,
    h("div", { class: "bd-tr-games" }, rows.map((game, i) => gameRow(game, { open: hard && i === 0, group, ...c }))));
}

// --- the lead matrix -----------------------------------------------------------------------------

function matrixBlock(c) {
  const { s, doubles, name, sprite } = c;
  const mx = s.matrix;
  const allColumns = mx.columns || [];
  const allRows = mx.rows || [];
  const colCount = doubles && !matrixView.allColumns ? Math.min(PAIR_COLUMNS, allColumns.length) : allColumns.length;
  const cols = allColumns.slice(0, colCount);
  const rows = allRows.slice(0, Math.max(MATRIX_STEP, matrixView.rows));
  const wide = cols.length > PAIR_COLUMNS;
  const colName = (col) => (doubles ? plus(col.members, name) : name(col.members[0]));
  const rowName = (row) => (doubles ? plus(row.members, name) : name(row.members[0]));
  const redraw = (event) => {
    const block = event.currentTarget.closest(".bd-tr-mx-block");
    block?.replaceWith(matrixBlock(c));
  };
  const more = allRows.length > rows.length;
  const buttons = [
    more ? h("button", { type: "button", class: "ghost-button compact", onclick: (event) => { matrixView.rows = rows.length + MATRIX_STEP; redraw(event); } },
      `Show more of theirs (${Math.min(MATRIX_STEP, allRows.length - rows.length)} more)`) : null,
    rows.length > MATRIX_STEP ? h("button", { type: "button", class: "ghost-button compact", onclick: (event) => { matrixView.rows = MATRIX_STEP; redraw(event); } }, "Show fewer") : null,
    doubles && allColumns.length > PAIR_COLUMNS ? h("button", { type: "button", class: "ghost-button compact", onclick: (event) => { matrixView.allColumns = !matrixView.allColumns; redraw(event); } },
      matrixView.allColumns ? `Show your ${PAIR_COLUMNS} most used pairs` : `Show all ${allColumns.length} of your pairs`) : null,
  ].filter(Boolean);
  return h("div", { class: "bd-tr-mx-block" },
    h("div", { class: `bd-tr-mx-scroll ${wide ? "wide" : ""}` },
      h("div", { class: "bd-tr-mx", role: "table", "aria-label": doubles ? "Your lead pairs against the pairs they lead with" : "Your Pokémon against their most common Pokémon", style: { "--cols": cols.length } },
        h("div", { class: "bd-tr-mx-row bd-tr-mx-headrow", role: "row" },
          h("span", { class: "bd-tr-mx-corner", role: "columnheader" }, doubles ? "Their pair · yours →" : "Theirs · yours →"),
          cols.map((col) => h("span", {
            class: "bd-tr-mx-col", role: "columnheader",
            title: `${colName(col)}${col.leads > 0 ? ` · your lead in ${pct(col.leads)} of the games` : ""}`,
            "aria-label": colName(col),
          }, col.members.map((m) => sprite(m, doubles ? 26 : 30))))),
        rows.map((row) => h("div", { class: "bd-tr-mx-row", role: "row" },
          h("span", { class: "bd-tr-mx-name", role: "rowheader" },
            h("span", { class: "bd-tr-mx-sprites", "aria-hidden": "true" }, row.members.map((m) => sprite(m, 26))),
            h("span", {}, h("strong", {}, rowName(row)),
              h("small", {}, doubles ? (row.count ? `lead together in ${pct(row.share)}` : `brought together in ${pct(row.together)}`)
                : `in ${pct(row.share)} of teams${row.brought === null || row.brought === undefined ? "" : `, brought in ${pct(row.brought)}`}`))),
          row.cells.slice(0, colCount).map((value, i) => {
            const tone = bandOf(value);
            const label = `Your ${colName(cols[i])} against their ${rowName(row)}: ${BAND_LABEL[tone]}, ${score(value)} of 100`;
            return h("span", { class: `bd-tr-mx-cell ${tone}`, role: "cell", title: label, "aria-label": label },
              h("span", { "aria-hidden": "true" }, BAND_ICON[tone]), score(value));
          }))))),
    h("div", { class: "bd-tr-mx-foot" },
      h("span", { class: "bd-note" }, `Showing ${rows.length} of ${allRows.length} ${doubles ? "pairs of theirs" : "of their Pokémon"}${doubles ? ` and ${cols.length} of your ${allColumns.length} pairs` : ""}.`),
      buttons.length ? h("div", { class: "bd-actions" }, buttons) : null));
}

function matrixCard(c) {
  const { s, doubles, section } = c;
  if (!s.matrix?.rows?.length || !s.matrix?.columns?.length) return null;
  const note = doubles
    ? "Each cell is a full 2 vs 2 game: one of your pairs (columns, the pairs you lead with most first) against a pair they often lead with (rows). Both pairs come in, turn 1 is played in full (Intimidate, weather and terrain, Fake Out, Protect, Helping Hand, Wide Guard, Follow Me, Tailwind, Trick Room, sleep, Taunt and stat drops), then the four fight it out. Each of their Pokémon uses its most common tournament set. 50 is even."
    : "Each cell is a full 1 vs 1 game: one of your Pokémon (columns) against one of their most common Pokémon (rows), turn 1 in full and then the fight. Each of their Pokémon uses its most common tournament set. 50 is even.";
  return section(doubles ? "Lead pairs, 2 vs 2" : "Matchups, 1 vs 1", note,
    h("div", { class: "bd-tr-legend", "aria-hidden": "true" }, ["good", "mid", "bad"].map((t) => h("span", { class: t }, h("i", {}), `${BAND_ICON[t]} ${BAND_LABEL[t]}`))),
    matrixBlock(c),
    s.running || !s.done ? h("p", { class: "bd-note" }, "While the test runs, this table is refreshed every 64 teams.") : null);
}

// --- the most similar tournament team -------------------------------------------------------------

function similarCard({ s, section, name, sprite, running, loadTeam }) {
  const similar = s.similar;
  if (!similar?.members?.length) return null;
  const verdict = similar.overlap >= 5
    ? `${similar.overlap} of your ${similar.size} Pokémon were played together in a tournament team.`
    : similar.overlap >= 3
      ? `It shares ${similar.overlap} of your ${similar.size} Pokémon.`
      : `No tournament team is close; the nearest shares ${similar.overlap} of your Pokémon.`;
  const tested = similar.value !== null && similar.value !== undefined;
  return section("Most similar tournament team", "The tournament team closest to yours: the most Pokémon in common, then the most matching items and moves.",
    h("div", { class: `bd-similar bd-tr-similar ${similar.overlap >= 5 ? "close" : ""}` },
      h("div", { class: "bd-tr-similar-head" },
        h("p", { class: "bd-similar-verdict" }, verdict),
        h("span", { class: "bd-tr-pill" }, `Team #${similar.number} · ${similar.overlap}/${similar.members.length} shared`)),
      h("div", { class: "bd-similar-members" }, similar.members.map((member) => {
        const detail = member.shared
          ? member.sameItem ? `Same item${member.sharedMoves ? ` · ${member.sharedMoves}/4 moves` : ""}` : `In yours${member.sharedMoves ? ` · ${member.sharedMoves}/4 moves` : ""}`
          : "Not in yours";
        return h("div", { class: `bd-similar-member ${member.shared ? "shared" : ""}`, title: [member.ability, member.nature ? `${member.nature} Nature` : "", ...(member.moves || [])].filter(Boolean).join(" · ") },
          h("div", { class: "bd-similar-art" }, sprite(member, 48)),
          h("strong", {}, name(member)),
          h("small", {}, member.item || "No item"),
          h("span", { class: `bd-similar-tag ${member.shared ? "good" : ""}` }, detail));
      })),
      similar.notInIt?.length ? h("p", { class: "bd-note" }, `Only in yours: ${similar.notInIt.map((m) => name(m)).join(", ")}.`) : null,
      tested ? h("p", { class: "bd-tr-similar-score" }, "Your score against it in this test: ", h("b", { class: bandOf(similar.value) }, `${BAND_LABEL[bandOf(similar.value)]} · ${score(similar.value)}`)) : null,
      h("div", { class: "bd-actions" },
        loadTeam && !running ? h("button", { type: "button", class: "ghost-button compact", onclick: () => loadTeam(similar) }, "Load it as a new team") : null,
        h("span", { class: "bd-note" }, "Hover a Pokémon for its Ability, Nature and moves."))));
}
