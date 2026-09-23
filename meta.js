(() => {
  const ROOT = "pokemon_champions_assets";
  const META_ROOT = "data/meta";
  const CATEGORY_LABELS = {
    move: "Moves",
    held_item: "Held items",
    ability: "Abilities",
    stat_alignment: "Natures",
    stat_points: "Stat spreads",
    teammate: "Teammates"
  };
  const CATEGORY_SINGULAR = { move: "move", held_item: "item", ability: "ability" };
  const DIALOG_CATEGORIES = ["move", "held_item", "ability", "stat_alignment", "stat_points", "teammate"];
  const PERCENT_CATEGORIES = new Set(["move", "held_item", "ability", "stat_alignment", "stat_points"]);
  const STAT_LABELS = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const NATURE_CHANGES = {
    hardy: ["", ""], lonely: ["ATK", "DEF"], brave: ["ATK", "SPE"], adamant: ["ATK", "SPA"], naughty: ["ATK", "SPD"],
    bold: ["DEF", "ATK"], docile: ["", ""], relaxed: ["DEF", "SPE"], impish: ["DEF", "SPA"], lax: ["DEF", "SPD"],
    timid: ["SPE", "ATK"], hasty: ["SPE", "DEF"], serious: ["", ""], jolly: ["SPE", "SPA"], naive: ["SPE", "SPD"],
    modest: ["SPA", "ATK"], mild: ["SPA", "DEF"], quiet: ["SPA", "SPE"], bashful: ["", ""], rash: ["SPA", "SPD"],
    calm: ["SPD", "ATK"], gentle: ["SPD", "DEF"], sassy: ["SPD", "SPE"], careful: ["SPD", "SPA"], quirky: ["", ""]
  };
  const LIST_LIMIT = 10;
  const LIST_LIMIT_EXPANDED = 30;

  const state = {
    index: null,
    lookup: {},
    season: "",
    format: "Doubles",
    rangeDays: 7,
    scope: 30,
    category: "move",
    usageExpanded: false,
    rankExpanded: false,
    latest: null,
    baseline: null,
    snapshots: new Map(),
    learnableMoves: new Map(),
    failedAssetUrls: new Set(),
    activeName: "",
    loadToken: 0,
    builderData: null,
    builderPromise: null,
    typeToken: 0
  };

  const els = {
    window: document.getElementById("metaWindow"),
    formatLabel: document.getElementById("metaFormatLabel"),
    pokemonCount: document.getElementById("metaPokemonCount"),
    range: document.getElementById("metaRange"),
    scope: document.getElementById("metaScope"),
    results: document.getElementById("metaResults"),
    status: document.getElementById("metaStatus"),
    rankPill: document.getElementById("metaRankPill"),
    rankMoreButton: document.getElementById("rankMoreButton"),
    rankWinners: document.getElementById("rankWinners"),
    rankLosers: document.getElementById("rankLosers"),
    usageRising: document.getElementById("usageRising"),
    usageFalling: document.getElementById("usageFalling"),
    usageMoreButton: document.getElementById("usageMoreButton"),
    typePill: document.getElementById("metaTypePill"),
    typeNote: document.getElementById("metaTypeNote"),
    typeOffenseLead: document.getElementById("typeOffenseLead"),
    typeDefenseLead: document.getElementById("typeDefenseLead"),
    typeOffense: document.getElementById("typeOffense"),
    typeDefense: document.getElementById("typeDefense"),
    tabs: [...document.querySelectorAll(".meta-tab")],
    formatToggleDoubles: document.getElementById("formatToggleDoubles"),
    formatToggleSingles: document.getElementById("formatToggleSingles"),
    dialog: document.getElementById("metaDialog"),
    dialogInner: document.querySelector("#metaDialog .dialog-inner"),
    dialogContent: document.getElementById("metaDialogContent"),
    dialogClose: document.getElementById("metaDialogClose")
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    readStateFromLocation();
    bindEvents();
    try {
      state.index = await fetchJson(`${META_ROOT}/index.json`);
    } catch (error) {
      showStatus("Meta trend data is not available yet.", `Run <code>node tools/generate-manifest.mjs</code> (or <code>python tools/build_meta_trends.py</code>) to build ${META_ROOT}/. ${escapeHtml(error.message || "")}`);
      return;
    }
    state.lookup = state.index.pokemon || {};
    resolveDefaultSeason();
    syncControls();
    await refresh();
    openRouteProfileFromLocation();
  }

  function bindEvents() {
    els.formatToggleDoubles?.addEventListener("click", () => setFormat("Doubles"));
    els.formatToggleSingles?.addEventListener("click", () => setFormat("Singles"));
    els.range?.addEventListener("change", () => {
      state.rangeDays = Number(els.range.value) || 7;
      writeStateToLocation();
      refresh();
    });
    els.scope?.addEventListener("change", () => {
      state.scope = els.scope.value === "all" ? "all" : Number(els.scope.value) || 30;
      writeStateToLocation();
      // Every section is scoped, so every one has to be redrawn. Only the usage
      // one was, which is the other half of "the Pokemon scope does nothing".
      renderRankMovers();
      renderUsageChanges();
      renderTypeChanges();
    });
    els.tabs.forEach((tab) => tab.addEventListener("click", () => setCategory(tab.dataset.category)));
    els.rankMoreButton?.addEventListener("click", () => {
      state.rankExpanded = !state.rankExpanded;
      els.rankMoreButton.textContent = state.rankExpanded ? "Show less" : "Show more";
      els.rankMoreButton.setAttribute("aria-expanded", String(state.rankExpanded));
      renderRankMovers();
    });
    els.usageMoreButton?.addEventListener("click", () => {
      state.usageExpanded = !state.usageExpanded;
      els.usageMoreButton.textContent = state.usageExpanded ? "Show less" : "Show more";
      els.usageMoreButton.setAttribute("aria-expanded", String(state.usageExpanded));
      renderUsageChanges();
    });
    els.dialogClose?.addEventListener("click", () => closeChanges());
    els.dialog?.addEventListener("click", (event) => {
      if (event.target === els.dialog) closeChanges();
    });
    els.dialog?.addEventListener("cancel", () => closeChanges({ close: false }));
    els.dialog?.addEventListener("close", () => {
      document.body.classList.remove("profile-open");
      state.activeName = "";
    });
    window.addEventListener("popstate", () => {
      readStateFromLocation();
      syncControls();
      refresh().then(openRouteProfileFromLocation);
    });
  }

  /* ---------------------------------------------------------------- state */

  function setFormat(format) {
    if (state.format === format) return;
    state.format = format;
    syncControls();
    writeStateToLocation();
    refresh();
  }

  function setCategory(category) {
    if (!category || state.category === category) return;
    state.category = category;
    state.usageExpanded = false;
    els.usageMoreButton.textContent = "Show more";
    els.usageMoreButton.setAttribute("aria-expanded", "false");
    syncControls();
    writeStateToLocation();
    renderUsageChanges();
  }

  /** There is no season picker in the UI -- always resolve to the most
   *  recent season (state.index.seasons is ordered newest first). */
  function resolveDefaultSeason() {
    const seasons = state.index?.seasons || [];
    if (!seasons.some((entry) => entry.season === state.season)) state.season = seasons[0]?.season || "";
  }

  function syncControls() {
    els.formatToggleDoubles?.classList.toggle("active", state.format === "Doubles");
    els.formatToggleDoubles?.setAttribute("aria-pressed", String(state.format === "Doubles"));
    els.formatToggleSingles?.classList.toggle("active", state.format === "Singles");
    els.formatToggleSingles?.setAttribute("aria-pressed", String(state.format === "Singles"));
    if (els.formatLabel) els.formatLabel.textContent = state.format;
    if (els.range) els.range.value = String(state.rangeDays);
    if (els.scope) els.scope.value = String(state.scope);
    els.tabs.forEach((tab) => {
      const active = tab.dataset.category === state.category;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
  }

  function readStateFromLocation() {
    const params = new URLSearchParams(window.location.search);
    const format = titleCase(params.get("format") || "");
    if (format === "Doubles" || format === "Singles") state.format = format;
    const range = Number(params.get("range"));
    if ([1, 3, 7, 14, 30].includes(range)) state.rangeDays = range;
    const scope = params.get("scope");
    if (scope === "all") state.scope = "all";
    else if ([10, 20, 30, 40, 50, 100].includes(Number(scope))) state.scope = Number(scope);
    const category = params.get("category");
    if (category && CATEGORY_SINGULAR[category]) state.category = category;
  }

  function writeStateToLocation(extra = {}) {
    const params = new URLSearchParams();
    params.set("format", state.format);
    params.set("range", String(state.rangeDays));
    params.set("scope", String(state.scope));
    params.set("category", state.category);
    const pokemon = "pokemon" in extra ? extra.pokemon : state.activeName;
    if (pokemon) params.set("pokemon", pokemon);
    const url = `${window.location.pathname}?${params.toString()}`;
    if (extra.push) window.history.pushState({}, "", url);
    else window.history.replaceState({}, "", url);
  }

  /* ----------------------------------------------------------------- data */

  async function fetchJson(path) {
    const response = await fetch(encodeURI(`/${path}`), { cache: "no-cache" });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.json();
  }

  async function fetchText(path) {
    const response = await fetch(encodeURI(`/${path}`), { cache: "force-cache" });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.text();
  }

  function seasonEntry() {
    return (state.index?.seasons || []).find((entry) => entry.season === state.season) || null;
  }

  async function loadSnapshot(season, date, format) {
    const key = `${season}/${date}/${format}`;
    if (state.snapshots.has(key)) return state.snapshots.get(key);
    const snapshot = await fetchJson(`${META_ROOT}/${key}.json`);
    state.snapshots.set(key, snapshot);
    return snapshot;
  }

  function parseDate(value) {
    const match = /^(\d{2})_(\d{2})_(\d{4})$/.exec(value || "");
    if (!match) return null;
    return Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  }

  function formatDate(value) {
    const time = parseDate(value);
    if (time === null) return value || "—";
    const date = new Date(time);
    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }

  function daysBetween(from, to) {
    const a = parseDate(from);
    const b = parseDate(to);
    if (a === null || b === null) return null;
    return Math.round(Math.abs(b - a) / 86400000);
  }

  /** Snapshots are irregular, so the window resolves to the oldest day that
   *  still falls inside it, or the nearest day before it when none does. */
  function pickBaselineDate(dates, latestDate, days) {
    const latest = parseDate(latestDate);
    const older = dates.filter((date) => parseDate(date) < latest);
    if (!older.length || latest === null) return "";
    const cutoff = latest - days * 86400000;
    const inWindow = older.filter((date) => parseDate(date) >= cutoff);
    return inWindow.length ? inWindow[inWindow.length - 1] : older[0];
  }

  async function refresh() {
    const entry = seasonEntry();
    const token = (state.loadToken += 1);
    if (!entry || !entry.dates?.length) {
      showStatus("No ranked snapshots found.", "Daily battle data folders are required to compare two days.");
      return;
    }
    if (!entry.formats.includes(state.format)) {
      showStatus(`No ${escapeHtml(state.format)} snapshots in ${escapeHtml(entry.season)}.`, "Switch the format or the season to compare two days.");
      return;
    }
    const latestDate = entry.dates[0];
    const baselineDate = pickBaselineDate(entry.dates, latestDate, state.rangeDays);
    if (!baselineDate) {
      showStatus("Only one snapshot is available.", `${escapeHtml(entry.season)} has a single ranked day (${escapeHtml(formatDate(latestDate))}), so there is nothing to compare against yet.`);
      return;
    }

    setWindowText("Loading snapshots…");
    try {
      const [latest, baseline] = await Promise.all([
        loadSnapshot(entry.season, latestDate, state.format),
        loadSnapshot(entry.season, baselineDate, state.format)
      ]);
      if (token !== state.loadToken) return;
      state.latest = latest;
      state.baseline = baseline;
    } catch (error) {
      showStatus("Could not load the meta snapshots.", escapeHtml(error.message || ""));
      return;
    }
    hideStatus();
    renderAll();
    syncActiveDialog();
  }

  /** Keeps an already-open change dialog in sync when the format, season, or
   *  range changes underneath it (its content reads state.latest/baseline
   *  live, so a stale open dialog would otherwise show mismatched data). */
  function syncActiveDialog() {
    if (!state.activeName) return;
    if (state.latest?.pokemon?.[state.activeName]) openChanges(state.activeName, { updateRoute: false });
    // Not a popstate: the URL is stale here (it still names the old Pokemon),
    // so let closeChanges replace it and drop the dangling ?pokemon=.
    else closeChanges();
  }

  /* -------------------------------------------------------------- compute */

  function positionOf(snapshot, name) {
    const value = snapshot?.pokemon?.[name]?.position;
    return Number.isFinite(value) ? value : null;
  }

  function rankMovers() {
    const moved = [];
    const entered = [];
    const current = state.latest?.pokemon || {};
    const previous = state.baseline?.pokemon || {};
    Object.keys(current).forEach((name) => {
      if (!inScope(name)) return;
      const to = positionOf(state.latest, name);
      const from = positionOf(state.baseline, name);
      if (to === null) return;
      if (from === null) entered.push({ name, to });
      else if (from !== to) moved.push({ name, from, to, delta: from - to });
    });
    const left = Object.keys(previous)
      .filter((name) => !current[name] && inScope(name))
      .map((name) => ({ name, from: positionOf(state.baseline, name) }));
    return { moved, entered, left };
  }

  /** Whether the Pokemon scope covers this Pokemon.
   *
   *  Either snapshot counts, not just the latest one. A Pokemon that fell out
   *  of the Top 30 is exactly what "rank losers" is for, and one that climbed
   *  into it is exactly what "rank winners" is for -- judging only by where it
   *  ended up would hide half of each list.
   */
  function inScope(name) {
    if (state.scope === "all") return true;
    const to = positionOf(state.latest, name);
    const from = positionOf(state.baseline, name);
    return (Number.isFinite(to) && to <= state.scope)
      || (Number.isFinite(from) && from <= state.scope);
  }

  function scopedNames() {
    return Object.entries(state.latest?.pokemon || {})
      .filter(([name, value]) => Number.isFinite(value.position) && inScope(name))
      .sort((a, b) => a[1].position - b[1].position)
      .map(([name]) => name);
  }

  /** Snapshot rows always end with the rank they were captured at. */
  function rowKey(category, row) {
    if (category === "stat_points") return row.slice(1, 7).join("/");
    return row[0];
  }

  function entryMap(entry, category) {
    const map = new Map();
    (entry?.[category] || []).forEach((row) => {
      if (!Array.isArray(row)) return;
      const value = category === "stat_points" ? row[0] : row[1];
      // Teammates are Pokemon names: an old spelling of one ("Basculegion
      // Male") must not read as a second Pokemon next to its Showdown name.
      const key = category === "teammate" ? canon(rowKey(category, row)) : rowKey(category, row);
      if (category === "teammate" && map.has(key)) return;
      map.set(key,{ percent: numberOrZero(value), rank: row[row.length - 1], row });
    });
    return map;
  }

  /** A day whose captured ranks were not 1..N cannot prove an entry's absence. */
  function isComplete(entry, category) {
    return !(entry?.partial || []).includes(category);
  }

  function spreadLabel(key) {
    const values = String(key).split("/");
    return STAT_LABELS.map((label, index) => `${label} ${values[index] ?? "—"}`).join(" / ");
  }

  /** An entry missing on a fully captured day counts as 0%, per the top-10 cap.
   *  When either day's capture is partial only shared entries are comparable,
   *  otherwise a missing opening rank would read as a 99% collapse. */
  function comparableKeys(nowMap, wasMap, complete) {
    if (complete) return new Set([...nowMap.keys(), ...wasMap.keys()]);
    return new Set([...nowMap.keys()].filter((key) => wasMap.has(key)));
  }

  function usageChanges(category) {
    const changes = [];
    let partialCount = 0;
    scopedNames().forEach((name) => {
      const after = state.latest?.pokemon?.[name];
      const before = state.baseline?.pokemon?.[name];
      if (!before) return;
      const complete = isComplete(after, category) && isComplete(before, category);
      if (!complete) partialCount += 1;
      const nowMap = entryMap(after, category);
      const wasMap = entryMap(before, category);
      comparableKeys(nowMap, wasMap, complete).forEach((key) => {
        const now = nowMap.get(key)?.percent ?? 0;
        const was = wasMap.get(key)?.percent ?? 0;
        const delta = round1(now - was);
        if (!delta) return;
        changes.push({ pokemon: name, entry: key, now, was, delta });
      });
    });
    return { changes, partialCount };
  }

  /* --------------------------------------------------------------- render */

  function renderAll() {
    renderWindowLine();
    renderRankMovers();
    renderUsageChanges();
    renderTypeChanges();
    if (els.pokemonCount) els.pokemonCount.textContent = Object.keys(state.latest?.pokemon || {}).length.toLocaleString();
  }

  function renderWindowLine() {
    const from = state.baseline?.date;
    const to = state.latest?.date;
    const span = daysBetween(from, to);
    const spanText = span === null ? "" : ` · ${span} day${span === 1 ? "" : "s"} apart`;
    const fallback = span !== null && span > state.rangeDays
      ? ` <span class="meta-window-note">no snapshot inside ${state.rangeDays} day${state.rangeDays === 1 ? "" : "s"}, so the nearest earlier day is used</span>`
      : "";
    setWindowText(`Comparing <strong>${escapeHtml(formatDate(from))}</strong> to <strong>${escapeHtml(formatDate(to))}</strong>${spanText}${fallback}`);
  }

  function setWindowText(html) {
    if (els.window) els.window.innerHTML = html;
  }

  function renderRankMovers() {
    const { moved, entered, left } = rankMovers();
    const limit = state.rankExpanded ? LIST_LIMIT_EXPANDED : LIST_LIMIT;
    const climbed = moved.filter((row) => row.delta > 0)
      .sort((a, b) => b.delta - a.delta || a.to - b.to);
    const dropped = moved.filter((row) => row.delta < 0)
      .sort((a, b) => a.delta - b.delta || a.to - b.to);
    const winners = climbed.slice(0, limit);
    const losers = dropped.slice(0, limit);

    // Some seasons record the same column_position on every ranked day, which
    // is worth saying outright rather than showing two empty columns.
    const flat = !moved.length && !entered.length && !left.length;
    const emptyUp = flat
      ? `Both snapshots report identical usage ranks, so there is nothing to compare.`
      : "No Pokemon climbed in this window.";
    const emptyDown = flat
      ? `Try a wider time range.`
      : "No Pokemon dropped in this window.";
    fillList(els.rankWinners, winners.map((row) => rankRow(row)), emptyUp);
    fillList(els.rankLosers, losers.map((row) => rankRow(row)), emptyDown);
    if (els.rankPill) els.rankPill.textContent = `Top ${limit}`;
    // Only offer to expand when there is something behind the button.
    if (els.rankMoreButton) {
      const more = climbed.length > limit || dropped.length > limit;
      els.rankMoreButton.hidden = !more && !state.rankExpanded;
    }
  }

  function renderUsageChanges() {
    if (!state.latest || !state.baseline) return;
    const limit = state.usageExpanded ? LIST_LIMIT_EXPANDED : LIST_LIMIT;
    const { changes } = usageChanges(state.category);
    const rising = changes.filter((row) => row.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, limit);
    const falling = changes.filter((row) => row.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, limit);
    const noun = CATEGORY_SINGULAR[state.category] || "entry";
    fillList(els.usageRising, rising.map((row) => usageRow(row)), `No ${noun} usage gains in this window.`);
    fillList(els.usageFalling, falling.map((row) => usageRow(row)), `No ${noun} usage drops in this window.`);
  }


  function fillList(target, nodes, emptyText) {
    if (!target) return;
    target.innerHTML = "";
    if (!nodes.length) {
      const empty = document.createElement("p");
      empty.className = "meta-empty";
      empty.textContent = emptyText;
      target.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    nodes.forEach((node) => fragment.append(node));
    target.append(fragment);
  }

  function rankRow(row) {
    const button = metaRowShell(row.name);
    const body = document.createElement("span");
    body.className = "meta-row-body";
    body.innerHTML = `<strong>${escapeHtml(displayName(row.name))}</strong><small>#${row.from} → #${row.to}</small>`;
    button.append(body, deltaChip(row.delta, { suffix: "", prefixSign: true, title: `${Math.abs(row.delta)} place${Math.abs(row.delta) === 1 ? "" : "s"}` }));
    return button;
  }

  function usageRow(row) {
    const button = metaRowShell(row.pokemon);
    const body = document.createElement("span");
    body.className = "meta-row-body";
    const label = state.category === "stat_points" ? spreadLabel(row.entry) : row.entry;
    body.innerHTML = `<strong>${escapeHtml(label)}</strong><small>${escapeHtml(displayName(row.pokemon))} · ${formatPercent(row.was)} → ${formatPercent(row.now)}</small>`;
    button.append(body, deltaChip(row.delta, { suffix: "%", prefixSign: true }));
    return button;
  }

  function metaRowShell(name) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "meta-row";
    const thumb = document.createElement("span");
    thumb.className = "meta-row-thumb";
    appendImageOrFallback(thumb, spriteCandidates(name), displayName(name), initials(displayName(name)));
    button.append(thumb);
    button.addEventListener("click", () => openChanges(name));
    return button;
  }

  function deltaChip(value, options = {}) {
    const chip = document.createElement("span");
    const rounded = round1(value);
    chip.className = `meta-delta ${rounded > 0 ? "up" : rounded < 0 ? "down" : "flat"}`;
    const sign = options.prefixSign && rounded > 0 ? "+" : "";
    chip.textContent = `${sign}${formatNumber(rounded)}${options.suffix ?? ""}`;
    if (options.title) chip.title = options.title;
    return chip;
  }

  /* ---------------------------------------------------------- type lists */

  /* The two lists under "Type changes" are the Team Builder's Team Overview
     charts with the team taken out of them (builder/team-overview.js, and the
     profile/directionalPressure pair in builder/team-eval.js the app records
     were checked against):

       offence  the average type multiplier an attacking type gets against the
                Top X's typings -- the Overview's "Average Type Chart" for a team
                that carries no move of that type, so it falls back to the meta's
                own chart. Every Pokemon counts once: the Overview does not weight
                the Top X by usage, and neither does this.
       defence  the Overview's "Average Pressure: Top X Meta into Our Team" with
                one Pokemon of that single type standing in for the team. Every
                damaging move on the Top X's most common sets is priced by type
                multiplier, power and STAB, each Pokemon's best two count, and
                those are averaged. 0-100, lower is better.

     The page is a plain script and cannot import those modules (they pull in the
     whole damage engine), so the two formulas are copied here in the small form
     they need. tests/run-meta-types.mjs runs this copy and the real ones over the
     same day and fails if they disagree. */

  /** builder/team-eval.js TYPES, in its order. */
  const TYPE_ORDER = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy"];

  function compactKey(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function clamp100(value) {
    return Math.max(0, Math.min(100, numberOrZero(value)));
  }

  /** The Team Builder's own tables (data/builder/app-data.json), loaded once and
   *  only for this section: the type chart, the move list, and the form and Mega
   *  tables the Top X's typings come from. Reading the same file is what keeps the
   *  two pages from disagreeing. */
  async function loadBuilderData() {
    if (state.builderData) return state.builderData;
    state.builderPromise ||= fetchJson("data/builder/app-data.json")
      .then((payload) => {
        const forms = new Map();
        (payload.species || []).forEach((species) => {
          (species.forms || []).forEach((form) => {
            const key = compactKey(form.form);
            if (key && !forms.has(key)) forms.set(key, form.types || []);
          });
        });
        state.builderData = {
          chart: payload.typeChart || {},
          forms,
          stones: new Map(Object.entries(payload.megaStones || {}).map(([item, holders]) => [compactKey(item), holders || []])),
          moves: new Map(Object.entries(payload.moves || {}).map(([name, record]) => [compactKey(name), record?.simple || null])),
          moveAliases: payload.moveAliases || {},
          usage: payload.usageAliases || {}
        };
        return state.builderData;
      })
      .catch((error) => {
        state.builderPromise = null;
        throw error;
      });
    return state.builderPromise;
  }

  /** builder/engine.js typeMultiplier. */
  function typeMultiplier(chart, attacking, defending) {
    let multiplier = 1;
    const row = chart[attacking] || {};
    for (const type of defending || []) {
      const value = row[type];
      multiplier *= value === undefined ? 1 : value;
    }
    return multiplier;
  }

  /** builder/engine.js canonicalMoveName + team-eval.js simpleMoveInfo. */
  function moveSimple(data, move) {
    const text = String(move || "").trim();
    return data.moves.get(compactKey(data.moveAliases[text] || text)) || null;
  }

  /** One Pokemon of a day's Top X, played the way the Team Builder plays it:
   *  the most common set is the top row of each usage category, and a Mega form
   *  only when the top held item is that species' own stone
   *  (builder/speed-tiers.js commonMetaSet). */
  function metaEntry(data, name, entry) {
    const [species, form] = data.usage[name] || [name, name];
    const item = (entry.held_item || [])[0]?.[0] || "";
    const holder = (data.stones.get(compactKey(item)) || []).find((row) => compactKey(row.species) === compactKey(species));
    const resolved = holder ? holder.form : form;
    const types = data.forms.get(compactKey(resolved))
      || data.forms.get(compactKey(form))
      || data.forms.get(compactKey(species))
      || state.lookup[name]?.types
      || [];
    return {
      name,
      types: [...types],
      moves: (entry.move || []).slice(0, 4).map((row) => String(row?.[0] || "").trim()).filter(Boolean),
      partialMoves: (entry.partial || []).includes("move")
    };
  }

  /** That day's own Top X: the meta as it stood, not today's names on an old day. */
  function metaTopX(data, snapshot) {
    const ranked = Object.entries(snapshot?.pokemon || {})
      .filter(([, entry]) => Number.isFinite(entry?.position))
      .sort((a, b) => a[1].position - b[1].position);
    const limited = state.scope === "all" ? ranked : ranked.slice(0, Math.max(1, Number(state.scope) || 30));
    return limited.map(([name, entry]) => metaEntry(data, name, entry));
  }

  /** team-eval.js profile(): the average multiplier of each attacking type into
   *  the group, every member counting once. */
  function offenseScores(data, mons) {
    const out = {};
    for (const type of TYPE_ORDER) {
      const values = mons.map((mon) => (mon.types.length ? typeMultiplier(data.chart, type, mon.types) : 1));
      out[type] = mons.length ? values.reduce((a, b) => a + b, 0) / mons.length : 1;
    }
    return out;
  }

  /** team-eval.js profile(): the damaging moves the group carries, with STAB. */
  function metaDamageMoves(data, mons) {
    const rows = [];
    mons.forEach((mon, owner) => {
      const own = new Set(mon.types);
      for (const move of mon.moves.slice(0, 4)) {
        const simple = moveSimple(data, move);
        if (!simple) continue;
        const category = String(simple[1] || "").toLowerCase();
        if (category !== "physical" && category !== "special") continue;
        const power = Number(simple[2]) > 0 ? Number(simple[2]) : 70;
        rows.push({
          owner,
          move,
          type: simple[0] || "Normal",
          power: Math.max(20, Math.min(180, power)),
          stab: own.has(simple[0]) ? 1.5 : 1
        });
      }
    });
    return rows;
  }

  /** team-eval.js directionalPressure() with use_current_team_sets off: every
   *  move priced by type multiplier, power and STAB, the best two per attacker,
   *  averaged over the attackers. */
  function defenseScore(data, moves, ownerCount, defendingTypes) {
    const byOwner = new Map();
    for (const move of moves) {
      const multiplier = Math.max(0, typeMultiplier(data.chart, move.type, defendingTypes));
      const effective = (move.power / 80) * Math.max(1, move.stab) * multiplier;
      if (!byOwner.has(move.owner)) byOwner.set(move.owner, []);
      byOwner.get(move.owner).push({ move: move.move, pressure: clamp100(40 * effective) });
    }
    const scores = [];
    for (let owner = 0; owner < Math.max(1, ownerCount); owner += 1) {
      const best = [...(byOwner.get(owner) || [])]
        .sort((a, b) => b.pressure - a.pressure || String(a.move).localeCompare(String(b.move)))
        .slice(0, 2);
      scores.push(best.length ? best.reduce((sum, row) => sum + row.pressure, 0) / best.length : 0);
    }
    return clamp100(scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length));
  }

  /** Both scores for one day, or null for a day that ranks nobody in scope.
   *  A day whose Top X carries no damaging move at all has no defence score
   *  rather than eighteen zeroes. */
  function typeScoresFor(data, snapshot) {
    const mons = metaTopX(data, snapshot);
    if (!mons.length) return null;
    const moves = metaDamageMoves(data, mons);
    return {
      count: mons.length,
      partial: mons.filter((mon) => mon.partialMoves).length,
      offense: offenseScores(data, mons),
      defense: moves.length ? Object.fromEntries(TYPE_ORDER.map((type) => [type, defenseScore(data, moves, mons.length, [type])])) : null
    };
  }

  /** Best first. A type the earlier day cannot score carries no change at all,
   *  which the row shows as a dash -- never as a 0 it did not earn. */
  function typeRows(now, was, side) {
    const lowerIsBetter = side === "defense";
    return TYPE_ORDER
      .map((type) => {
        const value = now?.[side]?.[type];
        const before = was?.[side]?.[type];
        const has = Number.isFinite(value);
        const hadBefore = Number.isFinite(before);
        return {
          type,
          value: has ? value : null,
          was: hadBefore ? before : null,
          delta: has && hadBefore ? value - before : null
        };
      })
      .filter((row) => row.value !== null)
      .sort((a, b) => (lowerIsBetter ? a.value - b.value : b.value - a.value) || a.type.localeCompare(b.type));
  }

  /* --------------------------------------------------- type lists: render */

  /** "Top 30 Meta", or the whole ranked list when the scope is All Pokemon. */
  function scopeLabel(count) {
    return state.scope === "all" ? `the full ranked meta (${count} Pokemon)` : `Top ${Math.min(Number(state.scope) || 30, count)} Meta`;
  }

  function windowLabel() {
    const span = daysBetween(state.baseline?.date, state.latest?.date);
    if (span === null) return "the window";
    return `the last ${span} day${span === 1 ? "" : "s"}`;
  }

  async function renderTypeChanges() {
    if (!els.typeOffense || !els.typeDefense || !state.latest || !state.baseline) return;
    const token = (state.typeToken += 1);
    let data;
    try {
      data = await loadBuilderData();
    } catch (error) {
      if (token !== state.typeToken) return;
      setTypeNote(`The type lists need <code>data/builder/app-data.json</code>, which could not be loaded. ${escapeHtml(error.message || "")}`);
      fillList(els.typeOffense, [], "No type scores available.");
      fillList(els.typeDefense, [], "No type scores available.");
      if (els.typeOffenseLead) els.typeOffenseLead.textContent = "";
      if (els.typeDefenseLead) els.typeDefenseLead.textContent = "";
      return;
    }
    if (token !== state.typeToken) return;
    const now = typeScoresFor(data, state.latest);
    const was = typeScoresFor(data, state.baseline);
    const count = now?.count || 0;
    const scope = scopeLabel(count);
    if (els.typePill) els.typePill.textContent = state.scope === "all" ? `All ${count}` : `Top ${Math.min(Number(state.scope) || 30, count)}`;

    const offense = now ? typeRows(now, was, "offense") : [];
    const defense = now ? typeRows(now, was, "defense") : [];
    renderTypeList(els.typeOffense, els.typeOffenseLead, offense, "offense", scope);
    renderTypeList(els.typeDefense, els.typeDefenseLead, defense, "defense", scope);

    const partial = Math.max(now?.partial || 0, was?.partial || 0);
    setTypeNote(`<strong>Best</strong> here is the same measure as the Team Builder's Offense and Defense overviews. An attacking type is scored by the average damage multiplier it gets against the typings of the ${escapeHtml(scope)}; a defending type by how much damage the ${escapeHtml(scope)} can put on it, counting every damaging move on their most used sets by type, power and same-type bonus, best two per Pokemon. Every Pokemon in the list counts once, whatever its usage. Scored on ${escapeHtml(formatDate(state.latest?.date))}, changed against ${escapeHtml(formatDate(state.baseline?.date))}.${partial ? ` ${partial} of them had a partly captured move list on one of the two days.` : ""}`);
  }

  function renderTypeList(target, lead, rows, side, scope) {
    const offense = side === "offense";
    const best = rows[0];
    if (lead) {
      lead.innerHTML = best
        ? `<strong>Best ${offense ? "offensive" : "defensive"} type against ${escapeHtml(scope)}: ${escapeHtml(best.type)}.</strong> <span>Best to worst, with the change over ${escapeHtml(windowLabel())}.</span>`
        : "";
    }
    fillList(target, rows.map((row, index) => typeRow(row, index, side)), `No ranked Pokemon in this scope, so there is nothing to score ${offense ? "attacking" : "defending"} types against.`);
  }

  function typeRow(row, index, side) {
    const offense = side === "offense";
    const line = document.createElement("div");
    line.className = "meta-row meta-type-row";

    const thumb = document.createElement("span");
    thumb.className = "meta-row-thumb meta-type-thumb";
    appendImageOrFallback(thumb, typeImageCandidates(row.type), row.type, initials(row.type));

    const body = document.createElement("span");
    body.className = "meta-row-body";
    const score = offense ? `${row.value.toFixed(2)}×` : `${row.value.toFixed(1)}%`;
    const detail = offense ? "average multiplier" : "damage pressure taken";
    body.innerHTML = `<strong><span class="meta-type-rank">${index + 1}</span>${escapeHtml(row.type)}</strong><small>${score} ${escapeHtml(detail)}</small>`;

    line.append(thumb, body, typeDeltaChip(row, side));
    return line;
  }

  /** The arrow and the sign carry the direction, so the colour is never the only
   *  thing saying which way a type moved. On the defending list a rise is a worse
   *  score, and the chip is toned that way round. */
  function typeDeltaChip(row, side) {
    const offense = side === "offense";
    const chip = document.createElement("span");
    if (row.delta === null) {
      chip.className = "meta-delta flat";
      chip.textContent = "—";
      chip.title = `No score for ${row.type} on ${formatDate(state.baseline?.date)}, so there is no change to show yet.`;
      return chip;
    }
    const digits = offense ? 2 : 1;
    const delta = Number(row.delta.toFixed(digits));
    const better = offense ? delta > 0 : delta < 0;
    const tone = delta === 0 ? "flat" : better ? "up" : "down";
    const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "▪";
    chip.className = `meta-delta ${tone}`;
    chip.textContent = `${arrow} ${delta > 0 ? "+" : ""}${delta.toFixed(digits)}`;
    const unit = offense ? "×" : " points";
    chip.title = delta === 0
      ? `${row.type} scores the same as on ${formatDate(state.baseline?.date)}.`
      : `${row.type}: ${row.was.toFixed(digits)}${offense ? "×" : "%"} on ${formatDate(state.baseline?.date)} → ${row.value.toFixed(digits)}${offense ? "×" : "%"} now, ${delta > 0 ? "up" : "down"} ${Math.abs(delta).toFixed(digits)}${unit}. ${better ? "Better" : "Worse"} for this type.`;
    return chip;
  }

  function setTypeNote(html) {
    if (els.typeNote) els.typeNote.innerHTML = html;
  }

  /* --------------------------------------------------------------- detail */

  async function openChanges(name, options = {}) {
    if (!state.latest || !state.baseline) return;
    state.activeName = name;
    if (options.updateRoute !== false) writeStateToLocation({ pokemon: name, push: true });
    document.body.classList.add("profile-open");
    els.dialogContent.innerHTML = `<div class="detail-loading">Loading changes…</div>`;
    if (typeof els.dialog.showModal === "function" && !els.dialog.open) els.dialog.showModal();
    else els.dialog.setAttribute("open", "");
    if (els.dialogInner) els.dialogInner.scrollTop = 0;

    const moveTypes = await loadMoveTypes(name);
    if (state.activeName !== name) return;
    els.dialogContent.innerHTML = "";
    els.dialogContent.append(detailHero(name), detailSections(name, moveTypes));
    if (els.dialogInner) els.dialogInner.scrollTop = 0;
  }

  function closeChanges(options = {}) {
    if (options.close !== false && typeof els.dialog.close === "function") els.dialog.close();
    else els.dialog.removeAttribute("open");
    document.body.classList.remove("profile-open");
    state.activeName = "";
    if (options.updateRoute !== false) writeStateToLocation({ pokemon: "" });
  }

  /** Reconciles the dialog with ?pokemon= on load and on popstate (back/forward).
   *  Never rewrites the URL itself -- the location is already the source of truth
   *  in both of those cases, so every call here passes updateRoute: false. */
  function openRouteProfileFromLocation() {
    // canon(): a link shared before the switch to Showdown names
    // (?pokemon=Basculegion%20Male) still opens that Pokemon.
    const name = canon(new URLSearchParams(window.location.search).get("pokemon"));
    const valid = name && state.latest?.pokemon?.[name];
    if (valid) {
      if (state.activeName !== name) openChanges(name, { updateRoute: false });
    } else if (state.activeName || els.dialog.open) {
      closeChanges({ updateRoute: false });
    }
  }

  function detailHero(name) {
    const info = state.lookup[name] || {};
    const hero = document.createElement("section");
    hero.className = "detail-hero";

    const art = document.createElement("div");
    art.className = "detail-art";
    appendImageOrFallback(art, spriteCandidates(name), displayName(name), initials(displayName(name)));

    const copy = document.createElement("div");
    copy.className = "detail-title";
    copy.innerHTML = `
      <p class="eyebrow">Meta changes · ${escapeHtml(state.format)}</p>
      <h2 id="metaDetailTitle">${escapeHtml(displayName(name))}</h2>
      <p class="meta-detail-window">${escapeHtml(formatDate(state.baseline?.date))} → ${escapeHtml(formatDate(state.latest?.date))}</p>
    `;
    const typeRow = document.createElement("div");
    typeRow.className = "type-row";
    typeRow.append(...(info.types || []).map((type) => typeChip(type)));

    const from = positionOf(state.baseline, name);
    const to = positionOf(state.latest, name);
    const metrics = document.createElement("div");
    metrics.className = "detail-metrics";
    metrics.append(
      metric("Rank", to === null ? "Unranked" : `#${to}`),
      metric("Rank change", rankChangeText(from, to)),
      metric("Profile", `<a class="meta-profile-link" href="/pokemon/${escapeHtml(info.slug || slugify(name))}/">Open full profile →</a>`)
    );

    copy.append(typeRow, metrics);
    hero.append(art, copy);
    return hero;
  }

  function rankChangeText(from, to) {
    if (from === null && to === null) return "—";
    if (from === null) return "Newly ranked";
    if (to === null) return "No longer ranked";
    const delta = from - to;
    if (!delta) return "No change";
    return `${delta > 0 ? "+" : ""}${delta} · #${from} → #${to}`;
  }

  function metric(label, valueHtml) {
    const box = document.createElement("div");
    box.className = "metric";
    box.innerHTML = `<span>${escapeHtml(label)}</span><strong>${valueHtml}</strong>`;
    return box;
  }

  function detailSections(name, moveTypes) {
    const wrapper = document.createElement("div");
    wrapper.className = "detail-sections meta-detail-sections";
    DIALOG_CATEGORIES.forEach((category) => {
      const rows = changeRows(name, category);
      if (!rows.length) return;
      wrapper.append(section(CATEGORY_LABELS[category], changeTable(category, rows, moveTypes)));
    });
    if (!wrapper.childNodes.length) {
      const empty = document.createElement("p");
      empty.className = "meta-empty";
      empty.textContent = "Nothing changed for this Pokemon in the selected window.";
      wrapper.append(empty);
    }
    return wrapper;
  }

  function section(title, content) {
    const container = document.createElement("section");
    container.className = "detail-section";
    const heading = document.createElement("h3");
    heading.textContent = title;
    container.append(heading, content);
    return container;
  }

  function changeRows(name, category) {
    const after = state.latest?.pokemon?.[name];
    const before = state.baseline?.pokemon?.[name];
    const complete = isComplete(after, category) && isComplete(before, category);
    const nowMap = entryMap(after, category);
    const wasMap = entryMap(before, category);
    const keys = [...comparableKeys(nowMap, wasMap, complete)];

    if (category === "teammate") {
      return keys.map((entry) => {
        const nowRank = nowMap.get(entry)?.rank ?? null;
        const wasRank = wasMap.get(entry)?.rank ?? null;
        return {
          entry,
          nowRank,
          wasRank,
          delta: nowRank === null || wasRank === null ? null : wasRank - nowRank
        };
      }).sort((a, b) => rankSortValue(a) - rankSortValue(b));
    }

    return keys.map((entry) => {
      const now = nowMap.get(entry)?.percent ?? 0;
      const was = wasMap.get(entry)?.percent ?? 0;
      return {
        entry,
        now,
        was,
        delta: round1(now - was),
        present: nowMap.has(entry),
        rank: nowMap.get(entry)?.rank ?? wasMap.get(entry)?.rank ?? null
      };
    }).sort((a, b) => b.was - a.was || Math.abs(b.delta) - Math.abs(a.delta));
  }

  function rankSortValue(row) {
    return row.nowRank ?? 900 + (row.wasRank ?? 0);
  }

  function changeTable(category, rows, moveTypes) {
    const wrap = document.createElement("div");
    wrap.className = "data-table-wrap";
    const table = document.createElement("table");
    table.className = "responsive-data-table meta-change-table";

    if (category === "teammate") {
      table.innerHTML = `
        <thead><tr><th>Teammate</th><th>Before</th><th>Now</th><th>Change</th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td data-label="Teammate">${assetLabelMarkup(displayName(canon(row.entry)), teammateImageCandidates(row.entry), "teammate-label")}</td>
          <td data-label="Before">${row.wasRank ? `#${row.wasRank}` : "—"}</td>
          <td data-label="Now">${row.nowRank ? `#${row.nowRank}` : "—"}</td>
          <td data-label="Change">${teammateChangeMarkup(row)}</td>
        </tr>`).join("")}</tbody>`;
      wrap.append(table);
      return wrap;
    }

    const nameHeader = category === "stat_points" ? "Spread" : category === "stat_alignment" ? "Nature" : "Name";
    table.innerHTML = `
      <thead><tr><th>${escapeHtml(nameHeader)}</th><th>Before</th><th>Now</th><th>Change</th></tr></thead>
      <tbody>${rows.map((row) => `<tr>
        <td data-label="${escapeHtml(nameHeader)}">${entryLabelMarkup(category, row.entry, moveTypes)}</td>
        <td data-label="Before">${formatPercent(row.was)}</td>
        <td data-label="Now">${row.present ? formatPercent(row.now) : `<span class="meta-dropped">dropped out</span>`}</td>
        <td data-label="Change">${deltaMarkup(row.delta, "%")}</td>
      </tr>`).join("")}</tbody>`;
    wrap.append(table);
    return wrap;
  }

  function teammateChangeMarkup(row) {
    if (row.wasRank === null) return `<span class="meta-delta up">new</span>`;
    if (row.nowRank === null) return `<span class="meta-delta down">dropped out</span>`;
    if (!row.delta) return `<span class="meta-delta flat">0</span>`;
    return deltaMarkup(row.delta, "");
  }

  function deltaMarkup(value, suffix) {
    const rounded = round1(value);
    const tone = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
    const sign = rounded > 0 ? "+" : "";
    return `<span class="meta-delta ${tone}">${sign}${formatNumber(rounded)}${suffix}</span>`;
  }

  function entryLabelMarkup(category, entry, moveTypes) {
    if (category === "stat_points") return `<span class="meta-spread">${escapeHtml(spreadLabel(entry))}</span>`;
    if (category === "stat_alignment") return natureLabelMarkup(entry);
    if (category === "held_item") return assetLabelMarkup(entry, itemImageCandidates(entry), "item-label");
    if (category === "move") {
      const type = moveTypes?.get(recordKey(entry)) || "";
      return `<span class="meta-move-label"><strong>${escapeHtml(entry)}</strong>${type ? moveTypeMarkup(type) : ""}</span>`;
    }
    return `<strong>${escapeHtml(entry)}</strong>`;
  }

  async function loadMoveTypes(name) {
    if (state.learnableMoves.has(name)) return state.learnableMoves.get(name);
    const info = state.lookup[name] || {};
    // info.learnset is the file's own stem: learnsets keep the app's spelling
    // ("Basculegion Male.csv") while the page names Pokemon the Showdown way.
    const candidates = unique([info.learnset, name, info.baseName].filter(Boolean));
    for (const candidate of candidates) {
      try {
        const rows = parseCSV(await fetchText(`${ROOT}/learnable_moves/${candidate}.csv`));
        const map = new Map(rows
          .map((row) => [recordKey(row.move_name || row.move || row.name), titleCase(row.type || "")])
          .filter(([key, type]) => key && type));
        state.learnableMoves.set(name, map);
        return map;
      } catch {
        // Try the next filename candidate.
      }
    }
    state.learnableMoves.set(name, new Map());
    return state.learnableMoves.get(name);
  }

  /* -------------------------------------------------------------- markup */

  function natureLabelMarkup(natureName) {
    const [boosted, lowered] = NATURE_CHANGES[recordKey(natureName)] || ["", ""];
    const change = boosted && lowered
      ? `<span class="nature-change"><span class="nature-up">+${escapeHtml(boosted)}</span><span class="nature-separator">/</span><span class="nature-down">- ${escapeHtml(lowered)}</span></span>`
      : `<span class="nature-change nature-neutral">Neutral</span>`;
    return `<span class="nature-label"><span>${escapeHtml(natureName || "—")}</span>${change}</span>`;
  }

  function moveTypeMarkup(type) {
    const candidates = typeImageCandidates(type).map(resolveAssetCandidate).filter(Boolean);
    const icon = candidates.length ? `<img src="${candidates[0]}" alt="" loading="lazy" decoding="async" />` : "";
    return `<span class="move-type-label">${icon}${escapeHtml(type)}</span>`;
  }

  function assetLabelMarkup(name, candidates, className) {
    const resolved = candidates.map(resolveAssetCandidate).filter(Boolean);
    const icon = resolved.length
      ? `<span class="asset-icon"><img src="${resolved[0]}" alt="" loading="lazy" decoding="async" onerror="this.remove()" /></span>`
      : `<span class="asset-icon"><span class="asset-icon-fallback">${escapeHtml(initials(name))}</span></span>`;
    return `<span class="asset-label ${escapeHtml(className)}">${icon}<span class="asset-label-text">${escapeHtml(name || "—")}</span></span>`;
  }

  function typeChip(type) {
    const chip = document.createElement("span");
    chip.className = "type-chip";
    const candidates = typeImageCandidates(type).map(resolveAssetCandidate).filter(Boolean);
    if (candidates.length) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      let index = 0;
      img.onerror = () => {
        index += 1;
        if (index < candidates.length) img.src = candidates[index];
        else img.remove();
      };
      img.src = candidates[index];
      chip.append(img);
    }
    chip.append(document.createTextNode(type));
    return chip;
  }

  function appendImageOrFallback(target, candidates, alt, fallbackText) {
    const resolved = unique(candidates.map(resolveAssetCandidate).filter(Boolean));
    if (!resolved.length) {
      target.append(fallbackNode(fallbackText));
      return;
    }
    let index = 0;
    const img = document.createElement("img");
    img.alt = alt;
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", () => {
      state.failedAssetUrls.add(resolved[index] || img.src);
      index += 1;
      if (index < resolved.length) img.src = resolved[index];
      else { img.remove(); target.append(fallbackNode(fallbackText)); }
    });
    img.src = resolved[index];
    target.append(img);
  }

  function fallbackNode(text) {
    const fallback = document.createElement("div");
    fallback.className = "pokemon-fallback";
    fallback.textContent = text;
    return fallback;
  }

  function showStatus(title, detail) {
    if (els.results) els.results.hidden = true;
    if (!els.status) return;
    els.status.hidden = false;
    els.status.innerHTML = `<div class="empty-state"><strong>${title}</strong><p>${detail || ""}</p></div>`;
    setWindowText("");
  }

  function hideStatus() {
    if (els.results) els.results.hidden = false;
    if (els.status) els.status.hidden = true;
  }

  /* ------------------------------------------------------------- helpers */

  function spriteCandidates(name) {
    const info = state.lookup[name] || {};
    return unique([
      info.sprite,
      `${ROOT}/pokemon/${name}.png`,
      `${ROOT}/pokemon/${name}.webp`,
      info.baseName ? `${ROOT}/pokemon/${info.baseName}.png` : ""
    ].filter(Boolean));
  }

  function itemImageCandidates(itemName) {
    const name = String(itemName || "").trim();
    return name ? [`${ROOT}/items/${name}.png`, `${ROOT}/items/${name}.webp`] : [];
  }

  /** Sprites are filed under the app's spelling ("Basculegion Male.png"), so a
   *  teammate is looked up by its canonical name first -- the lookup knows the
   *  real file -- and only then by a file named after it. */
  function teammateImageCandidates(name) {
    if (!name) return [];
    const shown = canon(name);
    return unique([
      ...(state.lookup[shown] ? spriteCandidates(shown) : []),
      `${ROOT}/pokemon/${name}.png`,
      `${ROOT}/pokemon/${name}.webp`
    ]);
  }

  /** The Showdown name for any spelling of a Pokemon the index knows. */
  function canon(name) {
    const text = String(name || "").trim();
    return state.index?.aliases?.[text] || text;
  }

  function typeImageCandidates(type) {
    const title = titleCase(type);
    return [`${ROOT}/types/${title}.png`, `${ROOT}/types/${String(type || "").toLowerCase()}.png`, `${ROOT}/types/${title}.webp`];
  }

  function resolveAssetCandidate(path) {
    if (!path) return "";
    const encoded = encodeURI(`/${String(path).replace(/\\/g, "/").replace(/^\/+/, "")}`);
    return state.failedAssetUrls.has(encoded) ? "" : encoded;
  }

  function displayName(name) {
    return state.lookup[name]?.name || name;
  }

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];
      if (char === '"') {
        if (inQuotes && next === '"') { cell += '"'; i += 1; }
        else inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        row.push(cell.trim()); cell = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") i += 1;
        row.push(cell.trim());
        if (row.some(Boolean)) rows.push(row);
        row = []; cell = "";
      } else cell += char;
    }
    if (cell.length || row.length) {
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
    }
    if (!rows.length) return [];
    const headers = rows.shift().map((header) => header.trim().toLowerCase());
    return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }

  function round1(value) {
    return Math.round(numberOrZero(value) * 10) / 10;
  }

  function formatNumber(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  function formatPercent(value) {
    const numeric = round1(value);
    return `${formatNumber(numeric)}%`;
  }

  function numberOrZero(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function unique(values) {
    return [...new Set(values)];
  }

  function titleCase(value) {
    return String(value || "").replace(/[_-]+/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function recordKey(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function slugify(value) {
    return recordKey(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function initials(name) {
    return String(name || "?").split(/\s+/).map((part) => part[0] || "").join("").slice(0, 2).toUpperCase() || "?";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
