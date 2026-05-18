(() => {
  const ROOT = "pokemon_champions_assets";
  const PREFERRED_FORMAT_ORDER = ["Doubles", "Singles"];
  const CATEGORY_LABELS = {
    move: "Moves",
    held_item: "Held items",
    teammate: "Teammates",
    stat_alignment: "Natures",
    stat_points: "Stat spreads",
    ability: "Abilities"
  };
  const STAT_COLUMNS = [
    ["hp_points", "HP"],
    ["attack_points", "Atk"],
    ["defense_points", "Def"],
    ["sp_atk_points", "SpA"],
    ["sp_def_points", "SpD"],
    ["speed_points", "Spe"]
  ];
  const BASE_STATS = [
    ["hp", "HP"],
    ["attack", "Atk"],
    ["defense", "Def"],
    ["sp_attack", "SpA"],
    ["sp_defense", "SpD"],
    ["speed", "Spe"]
  ];
  const FORM_STATS = [...BASE_STATS, ["base_stat_total", "Total"]];
  const NATURE_CHANGES = {
    hardy: ["", ""], lonely: ["ATK", "DEF"], brave: ["ATK", "SPE"], adamant: ["ATK", "SPA"], naughty: ["ATK", "SPD"],
    bold: ["DEF", "ATK"], docile: ["", ""], relaxed: ["DEF", "SPE"], impish: ["DEF", "SPA"], lax: ["DEF", "SPD"],
    timid: ["SPE", "ATK"], hasty: ["SPE", "DEF"], serious: ["", ""], jolly: ["SPE", "SPA"], naive: ["SPE", "SPD"],
    modest: ["SPA", "ATK"], mild: ["SPA", "DEF"], quiet: ["SPA", "SPE"], bashful: ["", ""], rash: ["SPA", "SPD"],
    calm: ["SPD", "ATK"], gentle: ["SPD", "DEF"], sassy: ["SPD", "SPE"], careful: ["SPD", "SPA"], quirky: ["", ""]
  };
  const RECENT_KEY = "pokemonBattleDataRecentSearches";
  const FAVORITES_KEY = "pokemonBattleDataFavorites";
  let searchHelpHideTimer = null;
  const mobileResultsQuery = window.matchMedia("(max-width: 760px)");

  const SAMPLE_METADATA = `title,base_name,saved_name,types,abilities,image_path,form,hp,atk,def,spa,spd,spe,total
Garchomp,Garchomp,Garchomp,Dragon/Ground,Sand Veil|Rough Skin,pokemon_champions_assets\\pokemon\\Garchomp.png,,108,130,95,80,85,102,600
Garchomp [Mega Garchomp],Garchomp,Mega Garchomp,Dragon/Ground,Sand Force,pokemon_champions_assets\\pokemon\\Mega Garchomp.png,Mega,108,170,115,120,95,92,700
Garchomp [Mega Garchomp Z],Garchomp,Mega Garchomp Z,Dragon,Sand Force,pokemon_champions_assets\\pokemon\\Mega Garchomp Z.png,Mega,108,130,85,141,85,151,700`;

  const SAMPLE_BATTLE = `pokemon,category,rank,name,percentage,stat_up,stat_down,hp_points,attack_points,defense_points,sp_atk_points,sp_def_points,speed_points,source_time_seconds
Garchomp,move,1,Earthquake,90.3%,,,,,,,,,108.13
Garchomp,held_item,1,Choice Scarf,24.2%,,,,,,,,,118.13
Garchomp,ability,1,Rough Skin,94%,,,,,,,,,169.17`;

  const state = {
    pokemon: [],
    filtered: [],
    selectedFormat: "Doubles",
    favorites: new Set(readArray(FAVORITES_KEY)),
    recentSearches: readArray(RECENT_KEY),
    failedAssetUrls: new Set(),
    sourceLabel: "Manifest"
  };

  const els = {
    datasetStatus: document.getElementById("datasetStatus"),
    pokemonCount: document.getElementById("pokemonCount"),
    battleEntryList: document.getElementById("battleEntryList"),
    searchInput: document.getElementById("searchInput"),
    typeFilter: document.getElementById("typeFilter"),
    sortFilter: document.getElementById("sortFilter"),
    orderFilter: document.getElementById("orderFilter"),
    favoritesOnly: document.getElementById("favoritesOnly"),
    clearFiltersButton: document.getElementById("clearFiltersButton"),
    emptyClearButton: document.getElementById("emptyClearButton"),
    formatToggleDoubles: document.getElementById("formatToggleDoubles"),
    formatToggleSingles: document.getElementById("formatToggleSingles"),
    resultCount: document.getElementById("resultCount"),
    rosterList: document.getElementById("rosterList"),
    pokemonGrid: document.getElementById("pokemonGrid"),
    emptyState: document.getElementById("emptyState"),
    cardTemplate: document.getElementById("pokemonCardTemplate"),
    detailDialog: document.getElementById("detailDialog"),
    detailContent: document.getElementById("detailContent"),
    closeDialogButton: document.getElementById("closeDialogButton"),
    searchHelpButton: document.getElementById("searchHelpButton"),
    searchHelpPopover: document.getElementById("searchHelpPopover"),
    searchHelpClose: document.getElementById("searchHelpClose")
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindEvents();
    renderLoadingState();
    const loaded = await loadManifestDataset();
    if (!loaded) hydrateDataset(buildSampleDataset(), "Sample dataset");
  }

  function bindEvents() {
    els.searchInput.addEventListener("input", applyFiltersAndRender);
    els.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        performSearch();
      }
    });
    els.searchHelpButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleSearchHelp(event);
    });
    els.searchHelpClose?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideSearchHelp();
      els.searchHelpButton?.focus();
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".search-help")) hideSearchHelp();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideSearchHelp();
    });
    window.addEventListener("resize", () => { updateSearchHelpPosition(); renderBattleEntries(); }, { passive: true });
    mobileResultsQuery?.addEventListener?.("change", () => { renderBattleEntries(); renderCards(); });
    window.addEventListener("scroll", () => updateSearchHelpPosition(), { passive: true });
    els.typeFilter.addEventListener("change", applyFiltersAndRender);
    els.sortFilter.addEventListener("change", applyFiltersAndRender);
    els.orderFilter?.addEventListener("change", applyFiltersAndRender);
    els.favoritesOnly.addEventListener("change", applyFiltersAndRender);
    els.clearFiltersButton.addEventListener("click", clearFilters);
    els.emptyClearButton.addEventListener("click", clearFilters);
    els.formatToggleDoubles?.addEventListener("click", () => setActiveFormat("Doubles"));
    els.formatToggleSingles?.addEventListener("click", () => setActiveFormat("Singles"));
    els.closeDialogButton.addEventListener("click", closeDetail);
    els.detailDialog.addEventListener("click", (event) => {
      if (event.target === els.detailDialog) closeDetail();
    });
  }

  async function loadManifestDataset() {
    try {
      const manifest = await fetchJson("data/pokemon-index.json");
      if (!manifest || !Array.isArray(manifest.pokemon) || !manifest.pokemon.length) return false;
      const records = manifest.pokemon.map((entry) => recordFromManifestEntry(entry)).filter(Boolean).sort(compareByName);
      const label = manifest.generatedAt ? `Manifest • ${shortDate(manifest.generatedAt)}` : "Manifest";
      hydrateDataset(records, label);
      quietlyEnrichLegacyManifest(records);
      return true;
    } catch (error) {
      console.info("Manifest loading skipped:", error.message);
      return false;
    }
  }

  async function quietlyEnrichLegacyManifest(records) {
    if (records.some((record) => record.hasManifestSummary)) return;
    const enriched = await Promise.all(records.map(async (record) => {
      try {
        await ensureMetadata(record);
        return record;
      } catch {
        return record;
      }
    }));
    state.pokemon = enriched.sort(compareByName);
    updateTypeFilter();
    updateSummary();
    renderBattleEntries();
    applyFiltersAndRender();
  }

  function hydrateDataset(records, sourceLabel) {
    state.pokemon = records;
    state.sourceLabel = sourceLabel;
    if (!availableFormats().includes(state.selectedFormat)) state.selectedFormat = availableFormats()[0] || "Doubles";
    updateTypeFilter();
    updateFormatToggle();
    updateSummary();
    renderBattleEntries();
    renderRecentSearches();
    applyFiltersAndRender();
  }

  function renderLoadingState() {
    setDatasetStatus("Loading Pokémon…");
    els.pokemonCount.textContent = "—";
    els.emptyState.hidden = true;
    els.battleEntryList.innerHTML = Array.from({ length: 6 }, () => `
      <div class="entry-item loading-row" aria-hidden="true">
        <span class="entry-index skeleton"></span>
        <span class="entry-thumb skeleton"></span>
        <span class="entry-meta"><span class="skeleton-line wide"></span><span class="skeleton-line short"></span></span>
      </div>`).join("");
    els.pokemonGrid.innerHTML = Array.from({ length: 6 }, () => `<article class="pokemon-card skeleton-card" aria-hidden="true"><div class="pokemon-art skeleton-art"></div><div class="pokemon-card-body"><span class="skeleton-line short"></span><span class="skeleton-line wide"></span><div class="quick-facts"><span class="skeleton-tile"></span><span class="skeleton-tile"></span><span class="skeleton-tile"></span><span class="skeleton-tile"></span></div></div></article>`).join("");
    renderRecentSearches();
  }

  function recordFromManifestEntry(entry) {
    const summary = entry.summary || {};
    const name = entry.name || summary.name || "Unknown";
    const formats = sortFormats(unique((entry.battleDataCsvs || entry.battleData || []).map((source) => source.format || detectFormatFromPath(source.path || source.csv || source)).filter(Boolean)));
    const forms = Array.isArray(summary.forms) ? summary.forms.map(normalizeSummaryForm) : [];
    const primary = normalizeSummaryForm(summary.primary || forms.find((form) => /base/i.test(form.form_kind || "") || !form.form_kind || form.form_name === name) || forms[0] || {});
    const types = unique((summary.types || primary.types || []).map(titleCase));
    const baseStats = summary.baseStats || {};
    Object.assign(primary, {
      hp: numberOrNull(primary.hp ?? baseStats.hp),
      attack: numberOrNull(primary.attack ?? baseStats.attack),
      defense: numberOrNull(primary.defense ?? baseStats.defense),
      sp_attack: numberOrNull(primary.sp_attack ?? baseStats.sp_attack),
      sp_defense: numberOrNull(primary.sp_defense ?? baseStats.sp_defense),
      speed: numberOrNull(primary.speed ?? baseStats.speed),
      base_stat_total: numberOrNull(primary.base_stat_total ?? summary.baseStatTotal)
    });
    return {
      name,
      key: recordKey(name),
      dex: numberOrNull(summary.dex ?? primary.dex_number),
      metadataCsv: entry.metadataCsv || "",
      battleSources: normalizeBattleSources(entry),
      formats: formats.length ? formats : ["Doubles"],
      forms,
      primary,
      types: types.length ? types : splitTypes(primary.types_raw || ""),
      imageCandidates: pokemonImageCandidates(summary.sprite || primary.image_path, name, primary.form_name),
      summariesByFormat: normalizeBattleSummary(summary.battleSummary || {}),
      battleByFormat: new Map(),
      metadataLoaded: Boolean(forms.length),
      hasManifestSummary: Boolean(entry.summary)
    };
  }

  function buildSampleDataset() {
    const metadataRows = parseCSV(SAMPLE_METADATA);
    const forms = metadataRows.map(normalizeMetadataRow);
    const battleRows = withFormat(parseCSV(SAMPLE_BATTLE), "Doubles").map(normalizeBattleRow);
    const primary = forms[0];
    return [{
      name: "Garchomp",
      key: "garchomp",
      dex: 445,
      metadataCsv: "pokemon_champions_assets/metadata/Garchomp.csv",
      battleSources: [
        { format: "Doubles", path: "pokemon_champions_assets/battle_data/Doubles/Garchomp.csv" },
        { format: "Singles", path: "pokemon_champions_assets/battle_data/Singles/Garchomp.csv" }
      ],
      formats: ["Doubles", "Singles"],
      forms,
      primary,
      types: primary.types,
      imageCandidates: pokemonImageCandidates(primary.image_path, "Garchomp", primary.form_name),
      summariesByFormat: { Doubles: summaryFromRows(battleRows), Singles: summaryFromRows(battleRows.map((row) => ({ ...row, format: "Singles" }))) },
      battleByFormat: new Map([["Doubles", battleRows]]),
      metadataLoaded: true,
      hasManifestSummary: true
    }];
  }

  function normalizeBattleSources(entry) {
    const sources = Array.isArray(entry.battleDataCsvs) ? entry.battleDataCsvs : (Array.isArray(entry.battleData) ? entry.battleData : []);
    return sources.map((source) => {
      if (typeof source === "string") return { path: source, format: detectFormatFromPath(source) };
      const path = source.path || source.csv || source.battleDataCsv || "";
      return { path, format: source.format || detectFormatFromPath(path) };
    }).filter((source) => source.path);
  }

  function normalizeSummaryForm(form) {
    const types = Array.isArray(form.types) ? form.types.map(titleCase) : splitTypes(form.types || form.types_raw || "");
    const savedName = form.saved_name || form.form_name || form.title || form.name || form.pokemon_name || form.base_name || "Base";
    const formKind = form.form_kind ?? form.form ?? form.kind ?? "";
    return {
      pokemon_name: form.pokemon_name || form.base_name || form.title || form.name || "",
      dex_number: form.dex_number ?? form.dex ?? "",
      base_dex_url: form.base_dex_url || "",
      image_path: normalizePath(form.image_path || form.sprite || ""),
      form_name: savedName,
      saved_name: savedName,
      form_kind: formKind || (savedName === (form.base_name || form.pokemon_name) ? "Base" : "Form"),
      types,
      types_raw: form.types_raw || types.join("/"),
      abilities: form.abilities || "",
      hidden_ability: form.hidden_ability || "",
      hp: numberOrNull(form.hp),
      attack: numberOrNull(form.attack ?? form.atk),
      defense: numberOrNull(form.defense ?? form.def),
      sp_attack: numberOrNull(form.sp_attack ?? form.spa),
      sp_defense: numberOrNull(form.sp_defense ?? form.spd),
      speed: numberOrNull(form.speed ?? form.spe),
      base_stat_total: numberOrNull(form.base_stat_total ?? form.baseStatTotal ?? form.total)
    };
  }

  function normalizeBattleSummary(raw) {
    const out = {};
    Object.entries(raw || {}).forEach(([format, summary]) => {
      out[titleCase(format)] = {
        top: summary.top || {},
        values: summary.values || {},
        rows: normalizeSummaryRows(summary)
      };
    });
    return out;
  }

  function normalizeSummaryRows(summary) {
    if (Array.isArray(summary?.rows)) return summary.rows.map(normalizeSummaryBattleRow).filter((row) => row.category);
    if (summary?.rowsByCategory && typeof summary.rowsByCategory === "object") {
      return Object.entries(summary.rowsByCategory).flatMap(([category, rows]) =>
        (Array.isArray(rows) ? rows : []).map((row) => normalizeSummaryBattleRow({ ...row, category }))
      ).filter((row) => row.category);
    }
    const rows = [];
    Object.entries(summary?.values || {}).forEach(([category, values]) => {
      (values || []).forEach((value, index) => rows.push({ category, rank: index + 1, name: value, percentage: "", percentage_value: null }));
    });
    Object.values(summary?.top || {}).forEach((row) => {
      const normalized = normalizeSummaryBattleRow(row);
      if (normalized.category && normalized.rank === 1 && normalized.name) {
        const duplicateIndex = rows.findIndex((candidate) => candidate.category === normalized.category && candidate.rank === 1);
        if (duplicateIndex >= 0) rows[duplicateIndex] = { ...rows[duplicateIndex], ...normalized };
        else rows.push(normalized);
      }
    });
    return rows;
  }

  function normalizeSummaryBattleRow(row) {
    const normalized = {
      category: row?.category || "",
      rank: numberOrNull(row?.rank),
      name: row?.name || "",
      percentage: row?.percentage || "",
      percentage_value: numberOrNull(row?.percentage_value) ?? parsePercent(row?.percentage),
      stat_up: row?.stat_up || "",
      stat_down: row?.stat_down || ""
    };
    for (const [key] of STAT_COLUMNS) normalized[key] = numberOrNull(row?.[key]);
    return normalized;
  }

  async function ensureMetadata(record) {
    if (record.metadataLoaded || !record.metadataCsv) return;
    const rows = parseCSV(await fetchText(record.metadataCsv));
    const forms = rows.map(normalizeMetadataRow);
    record.forms = forms;
    record.primary = forms.find((form) => /base/i.test(form.form_kind || "") || !form.form_kind || form.form_name === record.name) || forms[0] || record.primary;
    record.types = unique(forms.flatMap((form) => form.types));
    record.dex = numberOrNull(record.primary.dex_number);
    record.imageCandidates = pokemonImageCandidates(record.primary.image_path, record.name, record.primary.form_name);
    record.metadataLoaded = true;
  }

  async function ensureBattleData(record, format = state.selectedFormat) {
    const normalizedFormat = titleCase(format);
    if (record.battleByFormat.has(normalizedFormat)) return record.battleByFormat.get(normalizedFormat);
    const source = record.battleSources.find((item) => item.format === normalizedFormat) || record.battleSources[0];
    if (!source) return [];
    const rows = withFormat(parseCSV(await fetchText(source.path)), normalizedFormat, source.path).map(normalizeBattleRow).filter((row) => row.category);
    record.battleByFormat.set(normalizedFormat, rows);
    record.summariesByFormat[normalizedFormat] = summaryFromRows(rows);
    return rows;
  }

  async function fetchJson(path) {
    const response = await fetch(path, { cache: "force-cache" });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.json();
  }

  async function fetchText(path) {
    const response = await fetch(encodeURI(normalizePath(path)), { cache: "force-cache" });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.text();
  }

  function applyFiltersAndRender() {
    const queryPlan = parseSearchQuery(els.searchInput.value);
    const type = els.typeFilter.value;
    const favoritesOnly = els.favoritesOnly.checked;
    const format = state.selectedFormat;

    let filtered = state.pokemon.filter((record) => {
      const matchesFormat = record.formats.includes(format);
      const matchesType = type === "all" || record.types.includes(type);
      const matchesFavorite = !favoritesOnly || state.favorites.has(record.key);
      const matchesSearch = matchesQuery(record, queryPlan, format);
      return matchesFormat && matchesType && matchesFavorite && matchesSearch;
    });

    filtered = sortPokemon(filtered, els.sortFilter.value, els.orderFilter?.value || "desc", format);
    state.filtered = filtered;
    renderBattleEntries();
    renderRecentSearches();
    renderCards();
  }

  function parseSearchQuery(rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw) return { mode: "empty", clauses: [], text: "" };

    const clauses = [];
    const nameParts = [];
    const clauseRe = /([a-zA-Z_]+)\s*(>=|<=|=|:|>|<)\s*([^,]*?)(?=(?:\s*,\s*)|(?:\s+[a-zA-Z_]+\s*(?:>=|<=|=|:|>|<))|$)/g;
    let match;
    let cursor = 0;

    while ((match = clauseRe.exec(raw)) !== null) {
      addNameSegments(raw.slice(cursor, match.index), nameParts);
      const parsed = parseClause(match[1], match[2], match[3]);
      if (parsed) clauses.push(parsed);
      cursor = clauseRe.lastIndex;
    }
    addNameSegments(raw.slice(cursor), nameParts);

    nameParts.forEach((part) => clauses.unshift({ field: "name", op: ":", value: part }));

    if (!clauses.length) return { mode: "name", text: normalizeForSearch(raw), clauses: [] };
    const hasOnlyName = clauses.every((clause) => clause.field === "name");
    if (hasOnlyName && clauses.length === 1) return { mode: "name", text: normalizeForSearch(clauses[0].value), clauses };
    return { mode: "advanced", text: "", clauses };
  }

  function addNameSegments(segment, parts) {
    String(segment || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => parts.push(part));
  }

  function parseClause(field, op, rawValue) {
    const value = String(rawValue || "").trim().replace(/^,\s*/, "");
    if (!field || !value) return null;

    const rankMatch = value.match(/^(\d+)\s*(=|:)\s*(.+)$/);
    if ((op === "<=" || op === ">=" || op === "<" || op === ">") && rankMatch && isRankFilterField(field)) {
      return {
        field: normalizeField(field),
        op: rankMatch[2],
        value: rankMatch[3].trim(),
        rankOp: op,
        rankValue: Number(rankMatch[1])
      };
    }

    return { field: normalizeField(field), op, value };
  }

  function isRankFilterField(field) {
    return Boolean(categoryForSearchField(normalizeField(field)));
  }

  function matchesQuery(record, plan, format) {
    if (plan.mode === "empty") return true;
    if (plan.mode === "name") return normalizeForSearch(record.name).includes(plan.text);
    return plan.clauses.every((clause) => matchClause(record, clause, format));
  }

  function matchClause(record, clause, format) {
    const value = clause.value;
    const query = normalizeForSearch(value);
    const field = clause.field;
    if (!field) return true;

    const numericFields = {
      dex: record.dex,
      hp: record.primary?.hp,
      atk: record.primary?.attack,
      attack: record.primary?.attack,
      def: record.primary?.defense,
      defense: record.primary?.defense,
      spa: record.primary?.sp_attack,
      spatk: record.primary?.sp_attack,
      spattack: record.primary?.sp_attack,
      sp_atk: record.primary?.sp_attack,
      spd: record.primary?.sp_defense,
      spdef: record.primary?.sp_defense,
      spdefense: record.primary?.sp_defense,
      sp_def: record.primary?.sp_defense,
      spe: record.primary?.speed,
      speed: record.primary?.speed,
      bst: record.primary?.base_stat_total,
      stats: record.primary?.base_stat_total,
      totalstats: record.primary?.base_stat_total,
      total: record.primary?.base_stat_total
    };
    if (Object.prototype.hasOwnProperty.call(numericFields, field)) {
      return compareNumeric(numberOrZero(numericFields[field]), clause.op, Number(value));
    }

    if (field === "name" || field === "pokemon") return matchTextValues([record.name], clause.op, query);
    if (field === "type" || field === "types") return matchTextValues(record.types, clause.op, query);

    const battleNumericField = battleNumericFieldName(field);
    if (battleNumericField) {
      const target = Number(value);
      if (!Number.isFinite(target)) return false;
      return battleRowsForSearch(record, format).some((row) => compareNumeric(numberOrZero(row[battleNumericField]), clause.op, target));
    }

    if (field === "usage" || field === "percent" || field === "percentage") {
      const target = Number(String(value).replace("%", ""));
      if (!Number.isFinite(target)) return false;
      return battleRowsForSearch(record, format).some((row) => compareNumeric(numberOrZero(row.percentage_value), clause.op, target));
    }

    if (field === "rank") {
      const target = Number(value);
      if (!Number.isFinite(target)) return false;
      return battleRowsForSearch(record, format).some((row) => compareNumeric(numberOrZero(row.rank), clause.op, target));
    }

    if (field === "statup") return matchTextValues(battleRowsForSearch(record, format).map((row) => row.stat_up), clause.op, query);
    if (field === "statdown" || field === "reducedstat") return matchTextValues(battleRowsForSearch(record, format).map((row) => row.stat_down), clause.op, query);

    const category = categoryForSearchField(field);
    if (!category) return false;

    let rows = battleRowsForSearch(record, format).filter((row) => row.category === category);
    if (field.startsWith("top")) rows = rows.filter((row) => numberOrZero(row.rank) === 1);
    if (clause.rankOp) rows = rows.filter((row) => compareNumeric(numberOrZero(row.rank), clause.rankOp, clause.rankValue));

    const battleMatch = rows.some((row) => matchBattleRowName(row, clause.op, query));
    if (battleMatch) return true;

    if (category === "ability" && !clause.rankOp && !field.startsWith("top")) {
      return matchTextValues(metadataAbilityValues(record), clause.op, query);
    }

    return false;
  }

  function matchBattleRowName(row, op, query) {
    const rowText = normalizeForSearch(rowLabel(row));
    if (!rowText) return false;
    return rowText.includes(query);
  }

  function metadataAbilityValues(record) {
    const values = [];
    (record.forms || []).forEach((form) => {
      splitListValue(form.abilities).forEach((value) => values.push(value));
      splitListValue(form.hidden_ability).forEach((value) => values.push(value));
    });
    splitListValue(record.primary?.abilities).forEach((value) => values.push(value));
    splitListValue(record.primary?.hidden_ability).forEach((value) => values.push(value));
    return unique(values);
  }

  function splitListValue(value) {
    return String(value || "")
      .split(/[\/,|;]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function matchTextValues(values, op, query) {
    const normalized = (values || []).filter(Boolean).map((candidate) => normalizeForSearch(candidate));
    return normalized.some((candidate) => candidate.includes(query));
  }

  function categoryForSearchField(field) {
    const aliases = {
      move: "move",
      moves: "move",
      topmove: "move",
      item: "held_item",
      helditem: "held_item",
      helditems: "held_item",
      held_item: "held_item",
      topitem: "held_item",
      tophelditem: "held_item",
      ability: "ability",
      abilities: "ability",
      topability: "ability",
      teammate: "teammate",
      teammates: "teammate",
      topteammate: "teammate",
      nature: "stat_alignment",
      natures: "stat_alignment",
      statalignment: "stat_alignment",
      alignment: "stat_alignment",
      statspread: "stat_points",
      statspreads: "stat_points",
      statpoints: "stat_points",
      evs: "stat_points"
    };
    return aliases[field] || "";
  }

  function battleNumericFieldName(field) {
    const aliases = {
      hppoints: "hp_points",
      hp_points: "hp_points",
      hppts: "hp_points",
      atkpoints: "attack_points",
      attackpoints: "attack_points",
      attack_points: "attack_points",
      defpoints: "defense_points",
      defensepoints: "defense_points",
      defense_points: "defense_points",
      spapoints: "sp_atk_points",
      spatkpoints: "sp_atk_points",
      spattackpoints: "sp_atk_points",
      sp_atk_points: "sp_atk_points",
      spdpoints: "sp_def_points",
      spdefpoints: "sp_def_points",
      spdefensepoints: "sp_def_points",
      sp_def_points: "sp_def_points",
      spepoints: "speed_points",
      speedpoints: "speed_points",
      speed_points: "speed_points"
    };
    return aliases[field] || "";
  }

  function battleRowsForSearch(record, format) {
    const liveRows = record.battleByFormat?.get(format);
    if (Array.isArray(liveRows) && liveRows.length) return liveRows;
    const summary = getSummary(record, format);
    if (Array.isArray(summary.rows) && summary.rows.length) return summary.rows;
    return normalizeSummaryRows(summary);
  }

  function normalizeField(field) {
    return normalizeForSearch(field).replace(/[\s_-]+/g, "");
  }

  function compareNumeric(candidate, op, target) {
    if (!Number.isFinite(target)) return false;
    if (op === ">=") return candidate >= target;
    if (op === "<=") return candidate <= target;
    if (op === ">") return candidate > target;
    if (op === "<") return candidate < target;
    return candidate === target;
  }

  function getSummary(record, format) {
    return record.summariesByFormat?.[format] || record.summariesByFormat?.[record.formats[0]] || { top: {}, values: {} };
  }

  function valuesForCategory(summary, category) {
    return summary.values?.[category] || [];
  }

  function valuesForKey(summary, key) {
    const values = [];
    Object.values(summary.top || {}).forEach((row) => {
      if (row && row[key]) values.push(row[key]);
    });
    return values;
  }

  function summaryValue(summary, category) {
    return rowLabel(summary.top?.[category]);
  }

  function sortPokemon(records, mode, order = "desc", format) {
    const copy = [...records];
    const direction = order === "asc" ? 1 : -1;
    const byName = (a, b) => direction * compareByName(a, b);
    const byNumber = (getter) => (a, b) => {
      const diff = numberOrZero(getter(a)) - numberOrZero(getter(b));
      return diff ? direction * diff : compareByName(a, b);
    };
    const sorters = {
      name: byName,
      dex: byNumber((record) => record.dex),
      bst: byNumber((record) => record.primary?.base_stat_total),
      hp: byNumber((record) => record.primary?.hp),
      attack: byNumber((record) => record.primary?.attack),
      defense: byNumber((record) => record.primary?.defense),
      sp_attack: byNumber((record) => record.primary?.sp_attack),
      sp_defense: byNumber((record) => record.primary?.sp_defense),
      speed: byNumber((record) => record.primary?.speed)
    };
    return copy.sort(sorters[mode] || byName);
  }

  function updateTypeFilter() {
    const current = els.typeFilter.value;
    const types = unique(state.pokemon.flatMap((record) => record.types)).sort();
    els.typeFilter.innerHTML = `<option value="all">All types</option>${types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("")}`;
    if (types.includes(current)) els.typeFilter.value = current;
  }

  function updateSummary() {
    const entries = formatBattleEntries();
    els.pokemonCount.textContent = entries.length.toLocaleString();
    setDatasetStatus(`${entries.length.toLocaleString()} Pokémon`);
  }

  function setDatasetStatus(text) {
    els.datasetStatus.textContent = text;
  }

  function isMobileResultsMode() {
    return Boolean(mobileResultsQuery?.matches);
  }

  function hasActiveSearchOrFilters() {
    return Boolean(String(els.searchInput?.value || "").trim()) ||
      els.typeFilter?.value !== "all" ||
      Boolean(els.favoritesOnly?.checked);
  }

  function formatBattleEntries() {
    return state.pokemon
      .filter((record) => record.formats.includes(state.selectedFormat))
      .sort(compareByName);
  }

  function battleEntries() {
    if (isMobileResultsMode() && Array.isArray(state.filtered)) {
      return [...state.filtered];
    }
    return formatBattleEntries();
  }

  function renderBattleEntries() {
    if (!els.battleEntryList) return;
    const entries = battleEntries();
    const mobileMode = isMobileResultsMode();
    if (mobileMode) {
      els.pokemonCount.textContent = entries.length.toLocaleString();
      setDatasetStatus(hasActiveSearchOrFilters() ? `${entries.length.toLocaleString()} matches` : `${entries.length.toLocaleString()} Pokémon`);
    }
    els.battleEntryList.innerHTML = "";
    const fragment = document.createDocumentFragment();
    entries.forEach((record, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "entry-item";
      button.setAttribute("role", "listitem");
      button.addEventListener("click", () => openDetail(record));

      const order = document.createElement("span");
      order.className = "entry-index";
      order.textContent = String(index + 1);

      const thumb = document.createElement("span");
      thumb.className = "entry-thumb";
      appendImageOrFallback(thumb, record.imageCandidates, record.name, initials(record.name));

      const meta = document.createElement("span");
      meta.className = "entry-meta";
      const types = document.createElement("span");
      types.className = "entry-types";
      types.append(...record.types.map(typeChip));
      meta.innerHTML = `<strong>${escapeHtml(record.name)}</strong>`;
      meta.append(types);

      button.append(order, thumb, meta);
      fragment.append(button);
    });

    if (!fragment.childNodes.length) {
      const empty = document.createElement("p");
      empty.className = "entry-empty";
      empty.textContent = isMobileResultsMode() ? "No Pokémon matched your search." : "No entries loaded for this selection.";
      fragment.append(empty);
    }
    els.battleEntryList.append(fragment);
  }

  function renderRecentSearches() {
    els.resultCount.textContent = `${state.filtered.length.toLocaleString()} results`;
    els.rosterList.innerHTML = "";
    const fragment = document.createDocumentFragment();

    state.recentSearches.forEach((query) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "recent-item";
      button.innerHTML = `<span class="recent-icon">⌕</span><span><strong>${escapeHtml(query)}</strong><small>${searchHintLabel(query)}</small></span>`;
      button.addEventListener("click", () => {
        els.searchInput.value = query;
        applyFiltersAndRender();
      });
      fragment.append(button);
    });

    if (!fragment.childNodes.length) {
      const empty = document.createElement("p");
      empty.className = "recent-empty";
      empty.textContent = "No recent searches yet.";
      fragment.append(empty);
    }
    els.rosterList.append(fragment);
  }

  function searchHintLabel(query) {
    return parseSearchQuery(query).mode === "advanced" ? "Advanced search" : "Name search";
  }

  function rememberSearch(value) {
    const query = String(value || "").trim();
    if (!query) return;
    state.recentSearches = [query, ...state.recentSearches.filter((item) => item.toLowerCase() !== query.toLowerCase())].slice(0, 20);
    localStorage.setItem(RECENT_KEY, JSON.stringify(state.recentSearches));
    renderRecentSearches();
  }

  function performSearch() {
    applyFiltersAndRender();
    rememberSearch(els.searchInput.value);
  }


  function showSearchHelp(event) {
    if (!els.searchHelpPopover || !els.searchHelpButton) return;
    cancelHideSearchHelp();
    updateSearchHelpPosition(event);
    els.searchHelpPopover.classList.add("is-visible");
    els.searchHelpButton.setAttribute("aria-expanded", "true");
  }

  function hideSearchHelp() {
    if (!els.searchHelpPopover || !els.searchHelpButton) return;
    cancelHideSearchHelp();
    els.searchHelpPopover.classList.remove("is-visible");
    els.searchHelpButton.setAttribute("aria-expanded", "false");
  }

  function toggleSearchHelp(event) {
    if (els.searchHelpPopover?.classList.contains("is-visible")) hideSearchHelp();
    else showSearchHelp(event);
  }

  function queueHideSearchHelp() {
    hideSearchHelp();
  }

  function cancelHideSearchHelp() {
    if (searchHelpHideTimer) {
      window.clearTimeout(searchHelpHideTimer);
      searchHelpHideTimer = null;
    }
  }

  function updateSearchHelpPosition() {
    if (!els.searchHelpButton || !els.searchHelpPopover) return;

    const buttonRect = els.searchHelpButton.getBoundingClientRect();
    const margin = 14;
    const gap = 12;
    const width = Math.max(240, Math.min(560, window.innerWidth - margin * 2));

    els.searchHelpPopover.style.setProperty("--help-width", `${width}px`);

    const popoverHeight = Math.min(
      els.searchHelpPopover.scrollHeight || 520,
      Math.max(280, window.innerHeight - margin * 2)
    );

    let left = buttonRect.right - width;
    if (left < margin) left = buttonRect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

    let top = buttonRect.bottom + gap;
    if (top + popoverHeight > window.innerHeight - margin) {
      top = buttonRect.top - popoverHeight - gap;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - popoverHeight - margin));

    els.searchHelpPopover.style.setProperty("--help-left", `${Math.round(left)}px`);
    els.searchHelpPopover.style.setProperty("--help-top", `${Math.round(top)}px`);
  }

  function renderCards() {
    if (isMobileResultsMode()) {
      els.pokemonGrid.innerHTML = "";
      els.emptyState.hidden = true;
      return;
    }
    els.pokemonGrid.innerHTML = "";
    els.emptyState.hidden = state.filtered.length !== 0;
    const fragment = document.createDocumentFragment();
    const format = state.selectedFormat;

    state.filtered.forEach((record) => {
      const card = els.cardTemplate.content.firstElementChild.cloneNode(true);
      const favoriteButton = card.querySelector(".favorite-button");
      const art = card.querySelector(".pokemon-art");
      const title = card.querySelector("h3");
      const dex = card.querySelector(".dex-number");
      const typeRow = card.querySelector(".type-row");
      const facts = card.querySelector(".quick-facts");
      const openButton = card.querySelector(".open-profile");
      const summary = getSummary(record, format);

      favoriteButton.textContent = state.favorites.has(record.key) ? "★" : "☆";
      favoriteButton.classList.toggle("active", state.favorites.has(record.key));
      favoriteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleFavorite(record.key);
        applyFiltersAndRender();
      });

      appendImageOrFallback(art, record.imageCandidates, record.name, initials(record.name));
      dex.textContent = record.dex ? `National Dex #${String(record.dex).padStart(3, "0")}` : "Dex data unavailable";
      title.textContent = record.name;
      if (record.types.length) typeRow.append(...record.types.map(typeChip));
      facts.append(
        fact("Top move", rowLabel(summary.top?.move) || "—"),
        fact("Top item", rowLabel(summary.top?.held_item) || "—"),
        fact("Ability", rowLabel(summary.top?.ability) || "—"),
        fact("Speed", record.primary?.speed ?? "—")
      );
      openButton.addEventListener("click", () => openDetail(record));
      card.addEventListener("dblclick", () => openDetail(record));
      fragment.append(card);
    });
    els.pokemonGrid.append(fragment);
  }

  async function openDetail(record) {
    rememberSearch(els.searchInput.value);
    els.detailContent.innerHTML = `<div class="detail-loading">Loading profile…</div>`;
    if (typeof els.detailDialog.showModal === "function" && !els.detailDialog.open) els.detailDialog.showModal();
    else els.detailDialog.setAttribute("open", "");
    try {
      await ensureMetadata(record);
      await ensureBattleData(record, state.selectedFormat);
      els.detailContent.innerHTML = "";
      els.detailContent.append(detailHero(record), detailSections(record));
    } catch (error) {
      els.detailContent.innerHTML = `<div class="detail-loading"><strong>Profile data unavailable.</strong><p>${escapeHtml(error.message || "Could not load this Pokémon profile.")}</p></div>`;
    }
  }

  function closeDetail() {
    if (typeof els.detailDialog.close === "function") els.detailDialog.close();
    else els.detailDialog.removeAttribute("open");
  }

  function detailHero(record) {
    const hero = document.createElement("section");
    hero.className = "detail-hero";

    const art = document.createElement("div");
    art.className = "detail-art";
    appendImageOrFallback(art, record.imageCandidates, record.name, initials(record.name));

    const copy = document.createElement("div");
    copy.className = "detail-title";
    copy.innerHTML = `
      <p class="eyebrow">${record.dex ? `National Dex #${String(record.dex).padStart(3, "0")}` : "Pokémon profile"}</p>
      <h2 id="detailTitle">${escapeHtml(record.name)}</h2>
    `;
    const typeRow = document.createElement("div");
    typeRow.className = "type-row";
    typeRow.append(...record.types.map(typeChip));

    const summary = getSummary(record, state.selectedFormat);
    const metrics = document.createElement("div");
    metrics.className = "detail-metrics";
    metrics.append(
      metric("Top move", rowWithPercent(summary.top?.move)),
      metric("Top item", rowWithPercent(summary.top?.held_item)),
      metric("Top ability", rowWithPercent(summary.top?.ability))
    );

    copy.append(typeRow, metrics);
    hero.append(art, copy);
    return hero;
  }

  function detailSections(record) {
    const wrapper = document.createElement("div");
    wrapper.className = "detail-sections";
    wrapper.append(
      section("Base stats", baseStatsBlock(record.primary)),
      section("Forms and metadata", formsTable(record.forms)),
      section("Battle data", battleDataBlock(record))
    );
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

  function battleDataBlock(record) {
    const rows = record.battleByFormat.get(state.selectedFormat) || [];
    const wrapper = document.createElement("div");
    wrapper.className = "battle-grid battle-grid-columns";
    if (!rows.length) {
      wrapper.textContent = "No battle data available.";
      return wrapper;
    }

    const leftColumn = document.createElement("div");
    leftColumn.className = "battle-column";
    const rightColumn = document.createElement("div");
    rightColumn.className = "battle-column";

    const leftCategories = ["move", "teammate", "stat_points"];
    const rightCategories = ["held_item", "stat_alignment", "ability"];

    leftCategories.forEach((category) => appendBattleCategory(leftColumn, rows, category));
    rightCategories.forEach((category) => appendBattleCategory(rightColumn, rows, category));

    if (leftColumn.childNodes.length) wrapper.append(leftColumn);
    if (rightColumn.childNodes.length) wrapper.append(rightColumn);
    return wrapper;
  }

  function appendBattleCategory(parent, rows, category) {
    const categoryRows = rows.filter((row) => row.category === category).sort(compareRank);
    if (categoryRows.length) parent.append(categorySection(category, categoryRows));
  }

  function categorySection(category, rows) {
    const container = document.createElement("section");
    container.className = "detail-section nested";
    const heading = document.createElement("h3");
    heading.textContent = CATEGORY_LABELS[category] || titleCase(category);
    container.append(heading, categoryTable(category, rows));
    return container;
  }

  function tableCell(label, value) {
    return `<td data-label="${escapeHtml(label)}">${value}</td>`;
  }

  function tableHeader(labels) {
    return `<thead><tr>${labels.map((label) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead>`;
  }

  function categoryTable(category, rows) {
    const wrap = document.createElement("div");
    wrap.className = "data-table-wrap";

    if (category === "stat_points") {
      const labels = ["#", "Usage", ...STAT_COLUMNS.map(([, label]) => label)];
      wrap.innerHTML = `
        <table class="responsive-data-table stat-points-table">
          ${tableHeader(labels)}
          <tbody>${rows.map((row) => `<tr>
            ${tableCell("#", escapeHtml(row.rank ?? "—"))}
            ${tableCell("Usage", percentBar(row.percentage_value, row.percentage))}
            ${STAT_COLUMNS.map(([key, label]) => tableCell(label, escapeHtml(row[key] ?? "—"))).join("")}
          </tr>`).join("")}</tbody>
        </table>`;
      return wrap;
    }

    if (category === "stat_alignment") {
      const labels = ["#", "Nature", "Usage", "Stat Change"];
      wrap.innerHTML = `
        <table class="responsive-data-table nature-table">
          ${tableHeader(labels)}
          <tbody>${rows.map((row) => `<tr>
            ${tableCell("#", escapeHtml(row.rank ?? "—"))}
            ${tableCell("Nature", escapeHtml(row.name || "—"))}
            ${tableCell("Usage", percentBar(row.percentage_value, row.percentage))}
            ${tableCell("Stat Change", natureChangeMarkup(row.name))}
          </tr>`).join("")}</tbody>
        </table>`;
      return wrap;
    }

    if (category === "teammate") {
      const labels = ["#", "Name"];
      wrap.innerHTML = `
        <table class="responsive-data-table teammate-table">
          ${tableHeader(labels)}
          <tbody>${rows.map((row) => `<tr>
            ${tableCell("#", escapeHtml(row.rank ?? "—"))}
            ${tableCell("Name", escapeHtml(row.name || "—"))}
          </tr>`).join("")}</tbody>
        </table>`;
      return wrap;
    }

    const labels = ["#", "Name", "Usage"];
    wrap.innerHTML = `
      <table class="responsive-data-table battle-table">
        ${tableHeader(labels)}
        <tbody>${rows.map((row) => `<tr>
          ${tableCell("#", escapeHtml(row.rank ?? "—"))}
          ${tableCell("Name", escapeHtml(row.name || "—"))}
          ${tableCell("Usage", row.percentage ? percentBar(row.percentage_value, row.percentage) : "—")}
        </tr>`).join("")}</tbody>
      </table>`;
    return wrap;
  }

  function baseStatsBlock(form) {
    const wrap = document.createElement("div");
    wrap.className = "stat-bars";
    if (!form || !BASE_STATS.some(([key]) => form[key] !== null && form[key] !== undefined)) {
      wrap.textContent = "No base-stat metadata available.";
      return wrap;
    }
    BASE_STATS.forEach(([key, label]) => {
      const value = numberOrZero(form[key]);
      const row = document.createElement("div");
      row.className = "stat-row";
      row.innerHTML = `
        <span>${label}</span>
        <div class="stat-track"><div class="stat-fill" style="--stat: ${Math.min(100, (value / 180) * 100)}%; --stat-color: ${statColor(value)}"></div></div>
        <strong>${value || "—"}</strong>
      `;
      wrap.append(row);
    });
    return wrap;
  }

  function formsTable(forms) {
    const wrap = document.createElement("div");
    wrap.className = "data-table-wrap";
    if (!forms.length) {
      wrap.textContent = "No form metadata available.";
      return wrap;
    }
    const labels = ["Form", "Types", "Abilities", "Stats"];
    wrap.innerHTML = `
      <table class="responsive-data-table forms-table">
        ${tableHeader(labels)}
        <tbody>
          ${forms.map((form) => {
            const abilities = combinedAbilityLabel(form);
            return `<tr>
              ${tableCell("Form", escapeHtml(form.saved_name || form.form_name || "—"))}
              ${tableCell("Types", escapeHtml(form.types.join(" / ") || "—"))}
              ${tableCell("Abilities", escapeHtml(abilities || "—"))}
              ${tableCell("Stats", `<span class="form-stat-line">${FORM_STATS.map(([key, label]) => `<span>${escapeHtml(label)} ${escapeHtml(form[key] ?? "—")}</span>`).join("")}</span>`)}
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
    return wrap;
  }

  function natureChangeMarkup(natureName) {
    const [boosted, lowered] = NATURE_CHANGES[normalizeForSearch(natureName).trim()] || ["", ""];
    if (!boosted || !lowered) return `<span class="nature-change nature-neutral">Neutral</span>`;
    return `<span class="nature-change"><span class="nature-up">+${escapeHtml(boosted)}</span><span class="nature-down">-${escapeHtml(lowered)}</span></span>`;
  }

  function combinedAbilityLabel(form) {
    const baseAbilities = splitListValue(form.abilities);
    const hiddenAbilities = splitListValue(form.hidden_ability);
    const hiddenSet = new Set(hiddenAbilities.map((ability) => ability.toLowerCase()));
    const merged = unique([...baseAbilities, ...hiddenAbilities]);
    return merged.map((ability) => hiddenSet.has(ability.toLowerCase()) ? `${ability} (Hidden)` : ability).join(" / ");
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

  function fact(label, value) {
    const item = document.createElement("div");
    item.className = "fact";
    item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
    return item;
  }

  function metric(label, value) {
    const item = document.createElement("div");
    item.className = "metric";
    item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "—")}</strong>`;
    return item;
  }

  function percentBar(value, label) {
    const safe = Math.max(0, Math.min(100, numberOrZero(value)));
    return `<div class="percent-bar" aria-label="${escapeHtml(label || `${safe}%`)}"><span style="--value:${safe}%"></span><b>${escapeHtml(label || "—")}</b></div>`;
  }

  function setActiveFormat(format) {
    state.selectedFormat = format;
    updateFormatToggle();
    updateSummary();
    renderBattleEntries();
    applyFiltersAndRender();
  }

  function updateFormatToggle() {
    for (const button of [els.formatToggleDoubles, els.formatToggleSingles]) {
      if (!button) continue;
      const isActive = button.dataset.format === state.selectedFormat;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    }
  }

  function clearFilters() {
    els.searchInput.value = "";
    els.typeFilter.value = "all";
    els.sortFilter.value = "name";
    if (els.orderFilter) els.orderFilter.value = "desc";
    els.favoritesOnly.checked = false;
    applyFiltersAndRender();
  }

  function toggleFavorite(key) {
    if (state.favorites.has(key)) state.favorites.delete(key);
    else state.favorites.add(key);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites]));
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
    const headers = rows.shift().map((header) => header.trim());
    return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }

  function withFormat(rows, format, sourcePath = "") {
    return rows.map((row) => ({ ...row, _battle_format: format || detectFormatFromPath(sourcePath), _source_path: sourcePath }));
  }

  function normalizeMetadataRow(row) {
    const types = splitTypes(row.types);
    const baseName = row.base_name || row.pokemon_name || row.title || "";
    const savedName = row.saved_name || row.form_name || row.title || baseName || "Unknown form";
    const formKind = row.form_kind ?? row.form ?? "";
    return {
      pokemon_name: baseName,
      dex_number: row.dex_number || row.dex || "",
      base_dex_url: row.base_dex_url || "",
      image_path: normalizePath(row.image_path || ""),
      form_name: savedName,
      saved_name: savedName,
      form_kind: formKind || (savedName === baseName ? "Base" : "Form"),
      types,
      types_raw: row.types || "",
      abilities: row.abilities || "",
      hidden_ability: row.hidden_ability || "",
      hp: numberOrNull(row.hp),
      attack: numberOrNull(row.attack ?? row.atk),
      defense: numberOrNull(row.defense ?? row.def),
      sp_attack: numberOrNull(row.sp_attack ?? row.spa),
      sp_defense: numberOrNull(row.sp_defense ?? row.spd),
      speed: numberOrNull(row.speed ?? row.spe),
      base_stat_total: numberOrNull(row.base_stat_total ?? row.total)
    };
  }

  function normalizeBattleRow(row) {
    const normalized = { ...row };
    normalized.category = row.category || "";
    normalized.rank = numberOrNull(row.rank);
    normalized.name = row.name || "";
    normalized.percentage = row.percentage || "";
    normalized.percentage_value = parsePercent(row.percentage);
    normalized.stat_up = row.stat_up || "";
    normalized.stat_down = row.stat_down || "";
    normalized.source_time_seconds = numberOrNull(row.source_time_seconds);
    normalized.format = titleCase(row._battle_format || row.format || row.battle_format || detectFormatFromPath(row._source_path || "") || "Battle");
    for (const [key] of STAT_COLUMNS) normalized[key] = numberOrNull(row[key]);
    return normalized;
  }

  function summaryFromRows(rows) {
    const summary = { top: {}, values: {}, rows: [] };
    Object.keys(CATEGORY_LABELS).forEach((category) => {
      const categoryRows = rows.filter((row) => row.category === category).sort((a, b) => {
        const rankDelta = compareRank(a, b);
        if (rankDelta) return rankDelta;
        return numberOrZero(b.percentage_value) - numberOrZero(a.percentage_value);
      });
      const usageSorted = [...categoryRows].sort((a, b) => {
        const usageDelta = numberOrZero(b.percentage_value) - numberOrZero(a.percentage_value);
        if (usageDelta) return usageDelta;
        return compareRank(a, b);
      });
      if (usageSorted[0]) summary.top[category] = compactBattleRow(usageSorted[0]);
      summary.values[category] = unique(categoryRows.map(rowLabel).filter(Boolean));
      summary.rows.push(...categoryRows.map(compactBattleRow));
    });
    return summary;
  }

  function compactBattleRow(row) {
    const compact = {
      category: row.category,
      rank: row.rank,
      name: row.name,
      percentage: row.percentage,
      percentage_value: row.percentage_value,
      stat_up: row.stat_up,
      stat_down: row.stat_down
    };
    STAT_COLUMNS.forEach(([key]) => { if (row[key] !== null && row[key] !== undefined) compact[key] = row[key]; });
    return compact;
  }

  function appendImageOrFallback(target, candidates, alt, fallbackText) {
    const resolved = unique((candidates || []).map(resolveAssetCandidate).filter(Boolean));
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

  function resolveAssetCandidate(path) {
    if (!path) return "";
    const encoded = encodeURI(normalizePath(path));
    if (state.failedAssetUrls.has(encoded)) return "";
    return encoded;
  }

  function pokemonImageCandidates(spritePath, name, formName = "") {
    const names = unique([name, formName].filter(Boolean));
    return unique([
      spritePath,
      ...names.flatMap((candidateName) => [`${ROOT}/pokemon/${candidateName}.png`, `${ROOT}/pokemon/${candidateName}.webp`])
    ].filter(Boolean).map(normalizePath));
  }

  function typeImageCandidates(type) {
    const title = titleCase(type);
    const lower = String(type || "").toLowerCase();
    const upper = String(type || "").toUpperCase();
    return [`${ROOT}/types/${title}.png`, `${ROOT}/types/${lower}.png`, `${ROOT}/types/${upper}.png`, `${ROOT}/types/${title}.webp`, `${ROOT}/types/${lower}.webp`];
  }

  function availableFormats() {
    return sortFormats(unique(state.pokemon.flatMap((record) => record.formats)));
  }

  function statColor(value) {
    const numeric = numberOrZero(value);
    if (numeric < 40) return "#ff3a3a";
    if (numeric < 70) return "#ff8c2a";
    if (numeric < 90) return "#ffdd57";
    if (numeric < 120) return "#a8e65a";
    if (numeric < 150) return "#45d97a";
    return "#4fd6ff";
  }

  function rowLabel(row) {
    if (!row) return "";
    if (row.name) return row.name;
    if (row.category === "stat_points") return STAT_COLUMNS.map(([key, label]) => `${label} ${row[key] ?? "—"}`).join(" / ");
    return "";
  }

  function rowWithPercent(row) {
    if (!row) return "—";
    const label = rowLabel(row);
    return row.percentage ? `${label} (${row.percentage})` : label;
  }

  function compareByName(a, b) {
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  }

  function compareRank(a, b) {
    return numberOrZero(a.rank) - numberOrZero(b.rank);
  }

  function sortFormats(formats) {
    return [...formats].sort((a, b) => {
      const ai = PREFERRED_FORMAT_ORDER.indexOf(a);
      const bi = PREFERRED_FORMAT_ORDER.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return String(a).localeCompare(String(b));
    });
  }

  function splitTypes(value) {
    return unique(String(value || "").split(/[\/|,]/).map((type) => titleCase(type.trim())).filter(Boolean));
  }

  function detectFormatFromPath(path) {
    const parts = normalizePath(path).split("/").filter(Boolean);
    const index = parts.findIndex((part) => normalizeForSearch(part) === "battle_data");
    if (index !== -1 && parts[index + 1] && !parts[index + 1].toLowerCase().endsWith(".csv")) return titleCase(parts[index + 1].replace(/[_-]/g, " "));
    return "Battle";
  }

  function parsePercent(value) {
    if (!value) return null;
    const parsed = Number(String(value).replace("%", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function numberOrZero(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function normalizePath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  }

  function recordKey(value) {
    return normalizeForSearch(String(value || "")).replace(/\s+/g, " ").trim();
  }

  function normalizeForSearch(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function initials(name) {
    const parts = String(name || "?").split(/\s|-/).filter(Boolean);
    return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
  }

  function titleCase(value) {
    return String(value || "").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function shortDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function unique(values) {
    return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
  }

  function readArray(key) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
})();
