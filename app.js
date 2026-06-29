(() => {
  const ROOT = "pokemon_champions_assets";
  const DEFAULT_SEASON = "Season M-3";
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
    ["attack_points", "ATK"],
    ["defense_points", "DEF"],
    ["sp_atk_points", "SpA"],
    ["sp_def_points", "SpD"],
    ["speed_points", "SPE"]
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
  const REGIONAL_FORM_PATTERN = /\b(hisuian|alolan|galarian|paldean)\b/i;
  const STAT_ALIASES = {
    hp: ["hp", "health"],
    attack: ["attack", "atk"],
    defense: ["defense", "def"],
    sp_attack: ["sp_attack", "spattack", "sp_atk", "spa", "spatk", "special_attack"],
    sp_defense: ["sp_defense", "spdefense", "sp_def", "spd", "spdef", "special_defense"],
    speed: ["speed", "spe"],
    base_stat_total: ["base_stat_total", "baseStatTotal", "bst", "total", "stats"]
  };
  const METADATA_ALIASES = {
    pokemon_name: ["pokemon_name", "base_name", "title", "name", "pokemon"],
    dex_number: ["dex_number", "dex", "national_dex"],
    base_dex_url: ["base_dex_url", "dex_url", "url"],
    image_path: ["image_path", "sprite", "sprite_path", "image"],
    form_name: ["saved_name", "form_name", "title", "name"],
    form_kind: ["form_kind", "form"],
    types: ["types", "type"],
    abilities: ["abilities", "ability"],
    hidden_ability: ["hidden_ability", "hidden", "hidden_abilities"]
  };
  const NATURE_CHANGES = {
    hardy: ["", ""], lonely: ["ATK", "DEF"], brave: ["ATK", "SPE"], adamant: ["ATK", "SPA"], naughty: ["ATK", "SPD"],
    bold: ["DEF", "ATK"], docile: ["", ""], relaxed: ["DEF", "SPE"], impish: ["DEF", "SPA"], lax: ["DEF", "SPD"],
    timid: ["SPE", "ATK"], hasty: ["SPE", "DEF"], serious: ["", ""], jolly: ["SPE", "SPA"], naive: ["SPE", "SPD"],
    modest: ["SPA", "ATK"], mild: ["SPA", "DEF"], quiet: ["SPA", "SPE"], bashful: ["", ""], rash: ["SPA", "SPD"],
    calm: ["SPD", "ATK"], gentle: ["SPD", "DEF"], sassy: ["SPD", "SPE"], careful: ["SPD", "SPA"], quirky: ["", ""]
  };
  const RECENT_KEY = "pokemonBattleDataRecentSearches";
  const FAVORITES_KEY = "pokemonBattleDataFavorites";
  const DESKTOP_SEARCH_PLACEHOLDER = "Search database, press Enter to save search";
  const MOBILE_SEARCH_PLACEHOLDER = "Search...";
  const SEARCH_DEBOUNCE_MS = 120;
  const RESULT_PAGE_SIZE = 48;
  let searchHelpHideTimer = null;
  let searchInputTimer = null;
  const mobileResultsQuery = window.matchMedia("(max-width: 760px)");

  const SAMPLE_METADATA = `title,base_name,saved_name,types,abilities,image_path,form,hp,atk,def,spa,spd,spe,total
Garchomp,Garchomp,Garchomp,Dragon/Ground,Sand Veil|Rough Skin,pokemon_champions_assets\\pokemon\\Garchomp.png,,108,130,95,80,85,102,600
Garchomp [Mega Garchomp],Garchomp,Mega Garchomp,Dragon/Ground,Sand Force,pokemon_champions_assets\\pokemon\\Mega Garchomp.png,Mega,108,170,115,120,95,92,700
Garchomp [Mega Garchomp Z],Garchomp,Mega Garchomp Z,Dragon,Sand Force,pokemon_champions_assets\\pokemon\\Mega Garchomp Z.png,Mega,108,130,85,141,85,151,700`;

  const SAMPLE_BATTLE = `pokemon,column_position,category,rank,name,percentage,stat_up,stat_down,hp_points,attack_points,defense_points,sp_atk_points,sp_def_points,speed_points
Garchomp,1,move,1,Earthquake,90.3%,,,,,,,,
Garchomp,1,held_item,1,Choice Scarf,24.2%,,,,,,,,
Garchomp,1,ability,1,Rough Skin,94%,,,,,,,,`;

  const state = {
    pokemon: [],
    filtered: [],
    availableSeasons: [],
    selectedSeason: DEFAULT_SEASON,
    selectedFormat: "Doubles",
    favorites: new Set(readArray(FAVORITES_KEY)),
    recentSearches: readArray(RECENT_KEY),
    learnableMovesCache: new Map(),
    moveDescriptionCache: new Map(),
    failedAssetUrls: new Set(),
    activeDetailRecord: null,
    activeMoveButton: null,
    visibleResults: RESULT_PAGE_SIZE,
    sourceLabel: "Manifest",
    dataVersion: "",
    activeRouteSlug: ""
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
    dialogInner: document.querySelector("#detailDialog .dialog-inner"),
    closeDialogButton: document.getElementById("closeDialogButton"),
    profileFavoriteButton: document.getElementById("profileFavoriteButton"),
    searchHelpButton: document.getElementById("searchHelpButton"),
    searchHelpPopover: document.getElementById("searchHelpPopover"),
    searchHelpClose: document.getElementById("searchHelpClose"),
    controls: document.querySelector(".controls"),
    mobileFilterToggle: document.getElementById("mobileFilterToggle")
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindEvents();
    renderLoadingState();
    const loaded = await loadManifestDataset();
    if (!loaded) hydrateDataset(buildSampleDataset(), "Sample dataset");
    openRouteProfileFromLocation();
  }

  function bindEvents() {
    els.searchInput.addEventListener("input", queueFilterRender);
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
      if (!event.target.closest(".move-info-button") && !event.target.closest(".move-info-popover")) hideMoveInfoPopover();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideSearchHelp();
        hideMoveInfoPopover();
      }
    });
    window.addEventListener("popstate", () => openRouteProfileFromLocation());
    window.addEventListener("resize", () => { updateSearchHelpPosition(); positionMoveInfoPopover(); renderBattleEntries(); }, { passive: true });
    mobileResultsQuery?.addEventListener?.("change", () => { updateMobileSearchUi(); renderBattleEntries(); renderCards(); });
    window.addEventListener("scroll", () => updateSearchHelpPosition(), { passive: true });
    els.typeFilter.addEventListener("change", applyFiltersAndRender);
    els.sortFilter.addEventListener("change", applyFiltersAndRender);
    els.orderFilter?.addEventListener("change", applyFiltersAndRender);
    els.favoritesOnly.addEventListener("change", applyFiltersAndRender);
    els.clearFiltersButton.addEventListener("click", clearFilters);
    els.emptyClearButton.addEventListener("click", clearFilters);
    els.formatToggleDoubles?.addEventListener("click", () => setActiveFormat("Doubles"));
    els.formatToggleSingles?.addEventListener("click", () => setActiveFormat("Singles"));
    els.mobileFilterToggle?.addEventListener("click", toggleMobileFilters);
    els.profileFavoriteButton?.addEventListener("click", toggleProfileFavorite);
    els.closeDialogButton.addEventListener("click", closeDetail);
    els.detailDialog.addEventListener("click", (event) => {
      if (event.target === els.detailDialog) closeDetail();
    });
    els.detailDialog.addEventListener("cancel", () => updateExplorerRoute());
    els.dialogInner?.addEventListener("scroll", () => positionMoveInfoPopover(), { passive: true });
    els.detailDialog.addEventListener("close", () => {
      document.body.classList.remove("profile-open");
      hideMoveInfoPopover();
      state.activeDetailRecord = null;
      state.activeRouteSlug = "";
    });
    updateMobileSearchUi();
  }

  function toggleMobileFilters() {
    const expanded = !els.controls?.classList.contains("filters-expanded");
    setMobileFiltersExpanded(expanded);
  }

  function setMobileFiltersExpanded(expanded) {
    els.controls?.classList.toggle("filters-expanded", expanded);
    els.mobileFilterToggle?.setAttribute("aria-expanded", String(expanded));
  }

  function updateMobileSearchUi() {
    if (els.searchInput) {
      els.searchInput.placeholder = isMobileResultsMode() ? MOBILE_SEARCH_PLACEHOLDER : DESKTOP_SEARCH_PLACEHOLDER;
    }
    if (!isMobileResultsMode()) setMobileFiltersExpanded(true);
    else if (!els.controls?.classList.contains("filters-expanded")) setMobileFiltersExpanded(false);
  }

  async function loadManifestDataset() {
    try {
      const manifest = await fetchJson("data/pokemon-index.json", { cache: "no-cache" });
      if (!manifest || !Array.isArray(manifest.pokemon) || !manifest.pokemon.length) return false;
      state.dataVersion = manifest.dataVersion || manifest.generatedAt || "";
      const records = manifest.pokemon.map((entry) => recordFromManifestEntry(entry)).filter(Boolean).sort(compareByName);
      const label = manifest.generatedAt ? `Manifest • ${shortDate(manifest.generatedAt)}` : "Manifest";
      hydrateDataset(records, label, manifest);
      quietlyEnrichLegacyManifest(records);
      return true;
    } catch (error) {
      delete els.detailContent.dataset.recordKey;
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

  function hydrateDataset(records, sourceLabel, manifest = {}) {
    state.pokemon = records;
    state.sourceLabel = sourceLabel;
    state.availableSeasons = sortSeasons(unique([
      ...(manifest.seasons || []),
      ...(manifest.battleDataFolders || []),
      ...records.flatMap((record) => record.seasons || [])
    ]));
    const seasons = availableSeasons();
    state.selectedSeason = seasons.includes(DEFAULT_SEASON) ? DEFAULT_SEASON : seasons[0] || DEFAULT_SEASON;
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
    const battleName = entry.battleName || entry.saved_name || name;
    const battleSources = normalizeBattleSources(entry);
    const seasons = sortSeasons(unique(battleSources.map((source) => source.season).filter(Boolean)));
    const formats = sortFormats(unique(battleSources.map((source) => source.format).filter(Boolean)));
    const forms = Array.isArray(summary.forms) ? summary.forms.map(normalizeSummaryForm) : [];
    const matchedForm = findMetadataFormForBattleName(forms, battleName);
    const resolvedPrimary = normalizeSummaryForm(
      matchedForm ||
      summary.primary ||
      forms.find((form) => /base/i.test(form.form_kind || "") || !form.form_kind || form.form_name === battleName) ||
      forms[0] || {}
    );
    const displayName = displayNameForBattleName(battleName, resolvedPrimary);
    const primary = resolvedPrimary;
    const types = unique(((primary.types && primary.types.length ? primary.types : summary.types) || []).map(titleCase));
    const baseStats = summary.baseStats || {};
    Object.assign(primary, {
      hp: metadataStatValue(primary, "hp") ?? metadataStatValue(baseStats, "hp"),
      attack: metadataStatValue(primary, "attack") ?? metadataStatValue(baseStats, "attack"),
      defense: metadataStatValue(primary, "defense") ?? metadataStatValue(baseStats, "defense"),
      sp_attack: metadataStatValue(primary, "sp_attack") ?? metadataStatValue(baseStats, "sp_attack"),
      sp_defense: metadataStatValue(primary, "sp_defense") ?? metadataStatValue(baseStats, "sp_defense"),
      speed: metadataStatValue(primary, "speed") ?? metadataStatValue(baseStats, "speed"),
      base_stat_total: metadataStatValue(primary, "base_stat_total") ?? metadataStatValue(summary, "base_stat_total")
    });
    return {
      name: displayName,
      battleName,
      slug: entry.slug || slugify(battleName),
      key: recordKey(battleName),
      dex: numberOrNull(summary.dex ?? primary.dex_number),
      metadataCsv: entry.metadataCsv || "",
      battleSources,
      seasons: seasons.length ? seasons : [DEFAULT_SEASON],
      formats: formats.length ? formats : ["Doubles"],
      forms,
      primary,
      types: types.length ? types : splitTypes(primary.types_raw || ""),
      imageCandidates: pokemonImageCandidates(summary.sprite || primary.image_path, battleName, primary.form_name),
      summariesBySeason: normalizeBattleSummaryBySeason(summary.battleSummary || {}, battleSources),
      battleBySelection: new Map(),
      learnableMoveNames: Array.isArray(entry.learnableMoveNames) ? entry.learnableMoveNames : [],
      learnableMoves: [],
      learnableMovesLoaded: false,
      metadataLoaded: Boolean(forms.length),
      hasManifestSummary: Boolean(entry.summary)
    };
  }

  function buildSampleDataset() {
    const metadataRows = parseCSV(SAMPLE_METADATA);
    const forms = metadataRows.map(normalizeMetadataRow);
    const battleRows = withFormat(parseCSV(SAMPLE_BATTLE), "Doubles", "pokemon_champions_assets/battle_data/Season M-3/Doubles/Garchomp.csv", DEFAULT_SEASON).map(normalizeBattleRow);
    const primary = forms[0];
    return [{
      name: "Garchomp",
      battleName: "Garchomp",
      slug: "garchomp",
      key: "garchomp",
      dex: 445,
      metadataCsv: "pokemon_champions_assets/metadata/Garchomp.csv",
      battleSources: [
        { season: DEFAULT_SEASON, format: "Doubles", path: "pokemon_champions_assets/battle_data/Season M-3/Doubles/Garchomp.csv" },
        { season: DEFAULT_SEASON, format: "Singles", path: "pokemon_champions_assets/battle_data/Season M-3/Singles/Garchomp.csv" }
      ],
      seasons: [DEFAULT_SEASON],
      formats: ["Doubles", "Singles"],
      forms,
      primary,
      types: primary.types,
      imageCandidates: pokemonImageCandidates(primary.image_path, "Garchomp", primary.form_name),
      summariesBySeason: { [DEFAULT_SEASON]: { Doubles: summaryFromRows(battleRows), Singles: summaryFromRows(battleRows.map((row) => ({ ...row, format: "Singles" }))) } },
      battleBySelection: new Map([[battleSelectionKey(DEFAULT_SEASON, "Doubles"), battleRows]]),
      learnableMoveNames: [],
      learnableMoves: [],
      learnableMovesLoaded: false,
      metadataLoaded: true,
      hasManifestSummary: true
    }];
  }

  function normalizeBattleSources(entry) {
    const sources = Array.isArray(entry.battleDataCsvs) ? entry.battleDataCsvs : (Array.isArray(entry.battleData) ? entry.battleData : []);
    const normalizedSources = sources.map((source) => {
      if (typeof source === "string") {
        const info = battleInfoFromPath(source);
        return { path: source, season: info.season, format: info.format };
      }
      const path = source.path || source.csv || source.battleDataCsv || "";
      const info = battleInfoFromPath(path);
      return { path, season: source.season || info.season, format: source.format || info.format };
    }).filter((source) => source.path);
    if (normalizedSources.some((source) => source.season !== "Current")) return normalizedSources;
    return normalizedSources.map((source) => ({
      ...source,
      season: DEFAULT_SEASON
    }));
  }

  function normalizeSummaryForm(form) {
    const types = Array.isArray(form.types) ? form.types.map(titleCase) : splitTypes(readField(form, METADATA_ALIASES.types) || form.types_raw || "");
    const baseName = readField(form, ["base_name", "pokemon_name", "pokemon", "base", "name"]) || "";
    const savedName = readField(form, ["saved_name", "form_name"]) || readField(form, ["title", "name"]) || baseName || "Base";
    const titleField = readField(form, ["title"]) || savedName;
    const formKind = readField(form, METADATA_ALIASES.form_kind) || "";
    const normalized = {
      pokemon_name: baseName || readField(form, METADATA_ALIASES.pokemon_name) || "",
      title: titleField,
      dex_number: metadataNumber(form, "dex_number", METADATA_ALIASES.dex_number),
      base_dex_url: readField(form, METADATA_ALIASES.base_dex_url) || "",
      image_path: normalizePath(readField(form, METADATA_ALIASES.image_path) || ""),
      form_name: savedName,
      saved_name: savedName,
      slug: form.slug || slugify(savedName),
      form_kind: formKind || (savedName === baseName ? "Base" : "Form"),
      types,
      types_raw: readField(form, ["types_raw", ...METADATA_ALIASES.types]) || types.join("/"),
      abilities: readField(form, METADATA_ALIASES.abilities) || "",
      hidden_ability: readField(form, METADATA_ALIASES.hidden_ability) || ""
    };
    Object.keys(STAT_ALIASES).forEach((key) => {
      normalized[key] = metadataStatValue(form, key);
    });
    return normalized;
  }

  function normalizeBattleSummaryBySeason(raw, sources = []) {
    const out = {};
    const fallbackSeason = sortSeasons(unique(sources.map((source) => source.season).filter(Boolean)))[0] || DEFAULT_SEASON;
    Object.entries(raw || {}).forEach(([key, value]) => {
      if (isBattleSummary(value)) {
        const format = titleCase(key);
        const season = sources.find((source) => source.format === format)?.season || fallbackSeason;
        setSeasonSummary(out, season, format, value);
        return;
      }
      Object.entries(value || {}).forEach(([format, summary]) => {
        if (isBattleSummary(summary)) setSeasonSummary(out, key, titleCase(format), summary);
      });
    });
    return out;
  }

  function isBattleSummary(value) {
    return Boolean(value && typeof value === "object" && ("top" in value || "values" in value || "rows" in value || "rowsByCategory" in value));
  }

  function setSeasonSummary(target, season, format, summary) {
    target[season] ||= {};
    target[season][format] = {
      top: summary.top || {},
      values: summary.values || {},
      position: numberOrNull(summary.position),
      statChanges: summary.statChanges || {},
      rows: normalizeSummaryRows(summary)
    };
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
      (values || []).forEach((value, index) => {
        const natureChange = category === "stat_alignment" ? (summary?.statChanges?.[value] || NATURE_CHANGES[normalizeForSearch(value)]) : null;
        rows.push({
          category,
          column_position: numberOrNull(summary?.position),
          position: numberOrNull(summary?.position),
          rank: index + 1,
          name: value,
          percentage: "",
          percentage_value: null,
          stat_up: natureChange?.stat_up || natureChange?.[0] || "",
          stat_down: natureChange?.stat_down || natureChange?.[1] || ""
        });
      });
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
    const columnPosition = numberOrNull(row?.column_position);
    const normalized = {
      category: row?.category || "",
      column_position: columnPosition,
      position: columnPosition ?? numberOrNull(row?.position),
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
    const battleName = battleDataName(record);
    const matchedForm = findMetadataFormForBattleName(forms, battleName);
    record.forms = forms;
    record.primary = matchedForm ||
      forms.find((form) => /base/i.test(form.form_kind || "") || !form.form_kind || form.form_name === battleName) ||
      forms[0] || record.primary;
    record.types = unique(((matchedForm || record.primary)?.types?.length ? (matchedForm || record.primary).types : forms.flatMap((form) => form.types)));
    record.dex = numberOrNull(record.primary.dex_number);
    record.name = displayNameForBattleName(battleName, record.primary);
    record.key = recordKey(battleName || record.name);
    record.slug = record.slug || slugify(battleName || record.name);
    record.imageCandidates = pokemonImageCandidates(record.primary.image_path, battleName, record.primary.form_name);
    record.metadataLoaded = true;
  }

  async function ensureLearnableMoves(record) {
    if (record.learnableMovesLoaded) return record.learnableMoves || [];
    const candidates = learnableMovePathCandidates(record);
    for (const path of candidates) {
      if (state.learnableMovesCache.has(path)) {
        record.learnableMoves = state.learnableMovesCache.get(path);
        record.learnableMoveNames = unique([...(record.learnableMoveNames || []), ...record.learnableMoves.map((row) => row.move_name)]);
        record.learnableMovesLoaded = true;
        return record.learnableMoves;
      }
      try {
        const rows = parseCSV(await fetchText(path)).map(normalizeLearnableMove).filter((row) => row.move_name);
        state.learnableMovesCache.set(path, rows);
        record.learnableMoves = rows;
        record.learnableMoveNames = unique([...(record.learnableMoveNames || []), ...rows.map((row) => row.move_name)]);
        record.learnableMovesLoaded = true;
        return rows;
      } catch {
        state.learnableMovesCache.set(path, []);
      }
    }
    record.learnableMoves = [];
    record.learnableMovesLoaded = true;
    return [];
  }

  async function prepareProfileMoveDescriptions(record, battleRows = []) {
    const profileMoves = Array.isArray(record.learnableMoves) ? record.learnableMoves : [];
    const battleMoveNames = (battleRows || [])
      .filter((row) => row?.category === "move")
      .map((row) => row.name);
    const moveNames = unique([...profileMoves.map((move) => move.move_name), ...battleMoveNames].filter(Boolean));
    await Promise.allSettled(moveNames.map((moveName) => ensureMoveDescription(moveName)));
    profileMoves.forEach((move) => {
      move.description = state.moveDescriptionCache.get(recordKey(move.move_name)) || "";
    });
  }

  async function ensureMoveDescription(moveName) {
    const key = recordKey(moveName);
    if (!key) return "";
    if (state.moveDescriptionCache.has(key)) return state.moveDescriptionCache.get(key);
    for (const path of moveDescriptionPathCandidates(moveName)) {
      try {
        const rows = parseCSV(await fetchText(path));
        const description = extractMoveDescription(rows, moveName);
        state.moveDescriptionCache.set(key, description);
        return description;
      } catch {
        // Try the next filename candidate.
      }
    }
    state.moveDescriptionCache.set(key, "");
    return "";
  }


  async function ensureBattleData(record, format = state.selectedFormat, season = state.selectedSeason) {
    const normalizedFormat = titleCase(format);
    const normalizedSeason = season || DEFAULT_SEASON;
    const key = battleSelectionKey(normalizedSeason, normalizedFormat);
    if (record.battleBySelection.has(key)) return record.battleBySelection.get(key);
    const source = findBattleSource(record, normalizedSeason, normalizedFormat) || record.battleSources[0];
    if (!source) return [];
    const rows = withFormat(parseCSV(await fetchText(source.path)), normalizedFormat, source.path, source.season || normalizedSeason).map(normalizeBattleRow).filter((row) => row.category);
    record.battleBySelection.set(key, rows);
    record.summariesBySeason[normalizedSeason] ||= {};
    record.summariesBySeason[normalizedSeason][normalizedFormat] = summaryFromRows(rows);
    return rows;
  }

  function versionedPath(path, version) {
    const normalized = rootRelativePath(path);
    if (!version) return normalized;
    const separator = normalized.includes("?") ? "&" : "?";
    return `${normalized}${separator}v=${encodeURIComponent(version)}`;
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(encodeURI(versionedPath(path, options.version)), { cache: options.cache || "force-cache" });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.json();
  }

  async function fetchText(path) {
    const response = await fetch(encodeURI(versionedPath(path, state.dataVersion)), { cache: "force-cache" });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.text();
  }

  function applyFiltersAndRender() {
    const queryPlan = parseSearchQuery(els.searchInput.value);
    const type = els.typeFilter.value;
    const favoritesOnly = els.favoritesOnly.checked;
    const season = state.selectedSeason;
    const format = state.selectedFormat;

    let filtered = state.pokemon.filter((record) => {
      const matchesFormat = recordHasBattleSelection(record, season, format);
      const matchesType = type === "all" || record.types.includes(type);
      const matchesFavorite = !favoritesOnly || state.favorites.has(record.key);
      const matchesSearch = matchesQuery(record, queryPlan, format, season);
      return matchesFormat && matchesType && matchesFavorite && matchesSearch;
    });

    filtered = sortPokemon(filtered, els.sortFilter.value, els.orderFilter?.value || "desc", format, season);
    filtered = prioritizeSearchResults(filtered, queryPlan, format, season);
    state.filtered = filtered;
    state.visibleResults = RESULT_PAGE_SIZE;
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

    nameParts.forEach((part) => clauses.unshift({ field: "quick", op: ":", value: part }));

    if (!clauses.length) return { mode: "name", text: normalizeForSearch(raw), clauses: [] };
    const hasOnlyQuick = clauses.every((clause) => clause.field === "quick");
    if (hasOnlyQuick && clauses.length === 1) return { mode: "name", text: normalizeForSearch(clauses[0].value), clauses };
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

  function matchesQuery(record, plan, format, season) {
    if (plan.mode === "empty") return true;
    if (plan.mode === "name") return quickSearchScore(record, plan.text, format, season) !== Number.POSITIVE_INFINITY;
    return plan.clauses.every((clause) => matchClause(record, clause, format, season));
  }

  function prioritizeSearchResults(records, plan, format, season) {
    if (plan.mode !== "name" || !plan.text) return records;
    return [...records].sort((a, b) => {
      const scoreDiff = quickSearchScore(a, plan.text, format, season) - quickSearchScore(b, plan.text, format, season);
      return scoreDiff || 0;
    });
  }

  function quickSearchScore(record, query, format, season) {
    const text = normalizeForSearch(query).trim();
    if (!text) return 0;
    const nameScore = bestTextMatchScore(searchablePokemonNames(record), text);
    if (nameScore !== Number.POSITIVE_INFINITY) return nameScore;

    const metadataScore = bestTextMatchScore([
      ...(record?.types || []),
      ...metadataAbilityValues(record),
      ...(record?.forms || []).flatMap((form) => [
        form?.pokemon_name,
        form?.saved_name,
        form?.form_name,
        form?.form_kind,
        ...(form?.types || [])
      ])
    ], text);
    if (metadataScore !== Number.POSITIVE_INFINITY) return metadataScore + 10;

    const battleScore = bestTextMatchScore(searchableBattleTextValues(record, format, season), text);
    if (battleScore !== Number.POSITIVE_INFINITY) return battleScore + 20;

    return bestTextMatchScore(learnableMoveSearchValues(record), text) + 30;
  }

  function bestTextMatchScore(values, query) {
    let best = Number.POSITIVE_INFINITY;
    (values || []).forEach((value) => {
      const candidate = normalizeForSearch(value).trim();
      if (!candidate || !candidate.includes(query)) return;
      if (candidate === query) best = Math.min(best, 0);
      else if (candidate.startsWith(query)) best = Math.min(best, 1);
      else if (candidate.split(" ").some((part) => part.startsWith(query))) best = Math.min(best, 2);
      else best = Math.min(best, 3);
    });
    return best;
  }

  function matchClause(record, clause, format, season) {
    const value = clause.value;
    const query = normalizeForSearch(value);
    const field = clause.field;
    if (!field) return true;
    if (field === "quick") return quickSearchScore(record, query, format, season) !== Number.POSITIVE_INFINITY;

    const numericFields = {
      dex: record.dex,
      hp: metadataStatValue(record.primary, "hp"),
      atk: metadataStatValue(record.primary, "attack"),
      attack: metadataStatValue(record.primary, "attack"),
      def: metadataStatValue(record.primary, "defense"),
      defense: metadataStatValue(record.primary, "defense"),
      spa: metadataStatValue(record.primary, "sp_attack"),
      spatk: metadataStatValue(record.primary, "sp_attack"),
      spattack: metadataStatValue(record.primary, "sp_attack"),
      sp_atk: metadataStatValue(record.primary, "sp_attack"),
      spd: metadataStatValue(record.primary, "sp_defense"),
      spdef: metadataStatValue(record.primary, "sp_defense"),
      spdefense: metadataStatValue(record.primary, "sp_defense"),
      sp_def: metadataStatValue(record.primary, "sp_defense"),
      spe: metadataStatValue(record.primary, "speed"),
      speed: metadataStatValue(record.primary, "speed"),
      bst: metadataStatValue(record.primary, "base_stat_total"),
      stats: metadataStatValue(record.primary, "base_stat_total"),
      totalstats: metadataStatValue(record.primary, "base_stat_total"),
      total: metadataStatValue(record.primary, "base_stat_total")
    };
    if (Object.prototype.hasOwnProperty.call(numericFields, field)) {
      return compareNumeric(numberOrZero(numericFields[field]), clause.op, Number(value));
    }

    if (field === "name" || field === "pokemon") return matchTextValues(searchablePokemonNames(record), clause.op, query);
    if (field === "type" || field === "types") return matchTextValues(record.types, clause.op, query);

    const battleNumericField = battleNumericFieldName(field);
    if (battleNumericField) {
      const target = Number(value);
      if (!Number.isFinite(target)) return false;
      return battleRowsForSearch(record, format, season).some((row) => compareNumeric(numberOrZero(row[battleNumericField]), clause.op, target));
    }

    if (field === "usage" || field === "percent" || field === "percentage") {
      const target = Number(String(value).replace("%", ""));
      if (!Number.isFinite(target)) return false;
      return battleRowsForSearch(record, format, season).some((row) => compareNumeric(numberOrZero(row.percentage_value), clause.op, target));
    }

    if (field === "rank") {
      const target = Number(value);
      if (!Number.isFinite(target)) return false;
      return battleRowsForSearch(record, format, season).some((row) => compareNumeric(numberOrZero(row.rank), clause.op, target));
    }

    if (field === "statup") return matchTextValues(battleRowsForSearch(record, format, season).map((row) => row.stat_up), clause.op, query);
    if (field === "statdown" || field === "reducedstat") return matchTextValues(battleRowsForSearch(record, format, season).map((row) => row.stat_down), clause.op, query);

    const category = categoryForSearchField(field);
    if (!category) return false;

    let rows = battleRowsForSearch(record, format, season).filter((row) => row.category === category);
    if (field.startsWith("top")) rows = rows.filter((row) => numberOrZero(row.rank) === 1);
    if (clause.rankOp) rows = rows.filter((row) => compareNumeric(numberOrZero(row.rank), clause.rankOp, clause.rankValue));

    const battleMatch = rows.some((row) => matchBattleRowName(row, clause.op, query));
    if (battleMatch) return true;

    if (category === "move" && !clause.rankOp && !field.startsWith("top")) {
      return matchTextValues(learnableMoveValues(record), clause.op, query);
    }

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

  function learnableMoveValues(record) {
    return unique([
      ...(record?.learnableMoveNames || []),
      ...(record?.learnableMoves || []).map((move) => move?.move_name)
    ].filter(Boolean));
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
      nature: "stat_alignment",
      natures: "stat_alignment",
      statalignment: "stat_alignment",
      alignment: "stat_alignment",
      teammate: "teammate",
      teammates: "teammate",
      topteammate: "teammate",
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

  function battleRowsForSearch(record, format, season = state.selectedSeason) {
    const liveRows = record.battleBySelection?.get(battleSelectionKey(season, format));
    if (Array.isArray(liveRows) && liveRows.length) return liveRows;
    const summary = getSummary(record, format, season);
    if (Array.isArray(summary.rows) && summary.rows.length) return summary.rows;
    return normalizeSummaryRows(summary);
  }

  function battlePosition(record, season = state.selectedSeason, format = state.selectedFormat) {
    const summaryPosition = numberOrNull(getSummary(record, format, season).position);
    const positions = battleRowsForSearch(record, format, season)
      .map((row) => numberOrNull(row.column_position ?? row.position))
      .filter((value) => Number.isFinite(value));
    return positions.length ? Math.min(...positions) : summaryPosition ?? Number.POSITIVE_INFINITY;
  }

  function sortByBattlePosition(records) {
    return [...records].sort((a, b) => {
      const aPosition = battlePosition(a);
      const bPosition = battlePosition(b);
      const aHasPosition = Number.isFinite(aPosition);
      const bHasPosition = Number.isFinite(bPosition);
      if (aHasPosition && bHasPosition && aPosition !== bPosition) return aPosition - bPosition;
      if (aHasPosition !== bHasPosition) return aHasPosition ? -1 : 1;
      return compareByName(a, b);
    });
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

  function getSummary(record, format, season = state.selectedSeason) {
    const normalizedFormat = titleCase(format || state.selectedFormat);
    const seasonSummaries = record.summariesBySeason || {};
    return seasonSummaries[season]?.[normalizedFormat] ||
      seasonSummaries[record.seasons?.[0]]?.[normalizedFormat] ||
      Object.values(seasonSummaries).find((formats) => formats?.[normalizedFormat])?.[normalizedFormat] ||
      { top: {}, values: {}, rows: [] };
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
      bst: byNumber((record) => metadataStatValue(record.primary, "base_stat_total")),
      hp: byNumber((record) => metadataStatValue(record.primary, "hp")),
      attack: byNumber((record) => metadataStatValue(record.primary, "attack")),
      defense: byNumber((record) => metadataStatValue(record.primary, "defense")),
      sp_attack: byNumber((record) => metadataStatValue(record.primary, "sp_attack")),
      sp_defense: byNumber((record) => metadataStatValue(record.primary, "sp_defense")),
      speed: byNumber((record) => metadataStatValue(record.primary, "speed"))
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
    return sortByBattlePosition(state.pokemon
      .filter((record) => recordHasBattleSelection(record, state.selectedSeason, state.selectedFormat)));
  }

  function battleEntries() {
    if (isMobileResultsMode() && Array.isArray(state.filtered)) {
      return sortByBattlePosition(state.filtered);
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
      const priorityLoading = index < 6 ? "eager" : "lazy";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "entry-item";
      button.setAttribute("role", "listitem");
      button.addEventListener("click", () => openDetail(record));

      const order = document.createElement("span");
      order.className = "entry-index";
      const position = battlePosition(record);
      order.textContent = Number.isFinite(position) ? String(position) : String(index + 1);

      const thumb = document.createElement("span");
      thumb.className = "entry-thumb";
      appendImageOrFallback(thumb, record.imageCandidates, record.name, initials(record.name), { loading: priorityLoading, fetchPriority: index < 6 ? "high" : "auto" });

      const meta = document.createElement("span");
      meta.className = "entry-meta";
      const types = document.createElement("span");
      types.className = "entry-types";
      types.append(...record.types.map((type) => typeChip(type, priorityLoading)));
      meta.innerHTML = `<strong>${escapeHtml(record.name)}</strong>`;
      meta.append(types);

      const action = document.createElement("span");
      action.className = "entry-action";
      action.setAttribute("aria-hidden", "true");
      action.textContent = "View";

      button.append(order, thumb, meta, action);
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
    const plan = parseSearchQuery(query);
    const allQuickClauses = plan.clauses?.length && plan.clauses.every((clause) => clause.field === "quick");
    return plan.mode === "advanced" && !allQuickClauses ? "Advanced Search" : "Quick Search";
  }

  function rememberSearch(value) {
    const query = String(value || "").trim();
    if (!query) return;
    state.recentSearches = [query, ...state.recentSearches.filter((item) => item.toLowerCase() !== query.toLowerCase())].slice(0, 20);
    localStorage.setItem(RECENT_KEY, JSON.stringify(state.recentSearches));
    renderRecentSearches();
  }

  function performSearch() {
    window.clearTimeout(searchInputTimer);
    searchInputTimer = null;
    applyFiltersAndRender();
    rememberSearch(els.searchInput.value);
  }

  function queueFilterRender() {
    window.clearTimeout(searchInputTimer);
    searchInputTimer = window.setTimeout(() => {
      searchInputTimer = null;
      applyFiltersAndRender();
    }, SEARCH_DEBOUNCE_MS);
  }


  function showSearchHelp(event) {
    if (!els.searchHelpPopover || !els.searchHelpButton) return;
    cancelHideSearchHelp();
    updateSearchHelpPosition(event);
    els.searchHelpPopover.classList.add("is-visible");
    els.searchHelpButton.setAttribute("aria-expanded", "true");
    window.requestAnimationFrame(updateSearchHelpPosition);
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
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const margin = Math.min(14, Math.max(8, Math.floor(Math.min(viewportWidth, viewportHeight) * 0.04)));
    const gap = 12;
    const width = Math.min(560, Math.max(0, viewportWidth - margin * 2));
    const maxHeight = Math.max(0, viewportHeight - margin * 2);

    els.searchHelpPopover.style.setProperty("--help-width", `${width}px`);
    els.searchHelpPopover.style.setProperty("--help-max-height", `${maxHeight}px`);

    const popoverHeight = Math.min(
      els.searchHelpPopover.scrollHeight || 520,
      maxHeight
    );

    let left = buttonRect.right - width;
    if (left < margin) left = buttonRect.left;
    left = Math.max(margin, Math.min(left, viewportWidth - width - margin));

    let top = buttonRect.bottom + gap;
    if (top + popoverHeight > viewportHeight - margin) {
      top = buttonRect.top - popoverHeight - gap;
    }
    top = Math.max(margin, Math.min(top, viewportHeight - popoverHeight - margin));

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

    state.filtered.slice(0, state.visibleResults).forEach((record, index) => {
      const card = els.cardTemplate.content.firstElementChild.cloneNode(true);
      const position = card.querySelector(".result-position");
      const favoriteButton = card.querySelector(".favorite-button");
      const art = card.querySelector(".pokemon-art");
      const title = card.querySelector("h3");
      const typeRow = card.querySelector(".type-row");
      const facts = card.querySelector(".quick-facts");
      const openButton = card.querySelector(".open-profile");
      const summary = getSummary(record, format, state.selectedSeason);

      position.textContent = `#${index + 1}`;
      position.setAttribute("aria-label", `Search result position ${index + 1}`);

      favoriteButton.textContent = state.favorites.has(record.key) ? "★" : "☆";
      favoriteButton.classList.toggle("active", state.favorites.has(record.key));
      favoriteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleFavorite(record.key);
        applyFiltersAndRender();
      });

      appendImageOrFallback(art, record.imageCandidates, record.name, initials(record.name));
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
    if (state.visibleResults < state.filtered.length) {
      const remaining = state.filtered.length - state.visibleResults;
      const loadMore = document.createElement("button");
      loadMore.className = "primary-button load-more-results";
      loadMore.type = "button";
      loadMore.textContent = `Show ${Math.min(RESULT_PAGE_SIZE, remaining)} more`;
      loadMore.addEventListener("click", () => {
        state.visibleResults += RESULT_PAGE_SIZE;
        renderCards();
      });
      fragment.append(loadMore);
    }
    els.pokemonGrid.append(fragment);
  }

  async function openDetail(record, options = {}) {
    if (options.rememberSearch !== false) rememberSearch(els.searchInput.value);
    if (options.updateRoute !== false) updateProfileRoute(record, options.routeAction);
    state.activeRouteSlug = profileSlug(record);
    state.activeDetailRecord = record;
    updateProfileFavoriteButton(record);
    document.body.classList.add("profile-open");
    els.detailContent.innerHTML = `<div class="detail-loading">Loading profile…</div>`;
    resetDetailScroll();
    if (typeof els.detailDialog.showModal === "function" && !els.detailDialog.open) els.detailDialog.showModal();
    else els.detailDialog.setAttribute("open", "");
    try {
      await ensureMetadata(record);
      const battleRows = await ensureBattleData(record, state.selectedFormat, state.selectedSeason);
      await ensureLearnableMoves(record);
      await prepareProfileMoveDescriptions(record, battleRows);
      els.detailContent.innerHTML = "";
      els.detailContent.dataset.recordKey = record.key;
      state.activeDetailRecord = record;
      updateProfileFavoriteButton(record);
      els.detailContent.append(detailHero(record), detailSections(record));
      resetDetailScroll();
      requestAnimationFrame(resetDetailScroll);
    } catch (error) {
      delete els.detailContent.dataset.recordKey;
      els.detailContent.innerHTML = `<div class="detail-loading"><strong>Profile data unavailable.</strong><p>${escapeHtml(error.message || "Could not load this Pokémon profile.")}</p></div>`;
    }
  }

  function closeDetail(options = {}) {
    if (options.updateRoute !== false) updateExplorerRoute(options.routeAction);
    if (typeof els.detailDialog.close === "function") els.detailDialog.close();
    else els.detailDialog.removeAttribute("open");
    document.body.classList.remove("profile-open");
    hideMoveInfoPopover();
    state.activeDetailRecord = null;
    state.activeRouteSlug = "";
  }

  function resetDetailScroll() {
    if (els.dialogInner) els.dialogInner.scrollTop = 0;
    if (els.detailDialog) els.detailDialog.scrollTop = 0;
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
      <p class="eyebrow">Pokémon profile</p>
      <h2 id="detailTitle">${escapeHtml(record.name)}</h2>
    `;
    const typeRow = document.createElement("div");
    typeRow.className = "type-row";
    typeRow.append(...record.types.map(typeChip));

    const summary = getSummary(record, state.selectedFormat, state.selectedSeason);
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
      section("Forms", formsTable(record)),
      section("Battle data", battleDataBlock(record)),
      section("Learnable moves", learnableMovesBlock(record))
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
    const rows = record.battleBySelection.get(battleSelectionKey(state.selectedSeason, state.selectedFormat)) || [];
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

    leftCategories.forEach((category) => appendBattleCategory(leftColumn, rows, category, record));
    rightCategories.forEach((category) => appendBattleCategory(rightColumn, rows, category, record));

    if (leftColumn.childNodes.length) wrapper.append(leftColumn);
    if (rightColumn.childNodes.length) wrapper.append(rightColumn);
    return wrapper;
  }

  function appendBattleCategory(parent, rows, category, record) {
    const categoryRows = rows.filter((row) => row.category === category).sort(compareRank);
    if (categoryRows.length) parent.append(categorySection(category, categoryRows, record));
  }

  function categorySection(category, rows, record) {
    const container = document.createElement("section");
    container.className = "detail-section nested";
    container.classList.add(`category-${String(category || "").replace(/_/g, "-")}`);
    const heading = document.createElement("h3");
    heading.textContent = CATEGORY_LABELS[category] || titleCase(category);
    container.append(heading, categoryTable(category, rows, record));
    return container;
  }

  function tableCell(label, value) {
    return `<td data-label="${escapeHtml(label)}">${value}</td>`;
  }

  function tableHeader(labels) {
    return `<thead><tr>${labels.map((label) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead>`;
  }

  function categoryTable(category, rows, record) {
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
      const labels = ["#", "Nature", "Usage"];
      wrap.innerHTML = `
        <table class="responsive-data-table nature-table">
          ${tableHeader(labels)}
          <tbody>${rows.map((row) => `<tr>
            ${tableCell("#", escapeHtml(row.rank ?? "—"))}
            ${tableCell("Nature", natureLabelMarkup(row.name))}
            ${tableCell("Usage", percentBar(row.percentage_value, row.percentage))}
          </tr>`).join("")}</tbody>
        </table>`;
      return wrap;
    }

    if (category === "move") {
      const { table, tbody } = createResponsiveTable(["#", "Name", "Type", "Usage"], "battle-table moves-table");
      rows.forEach((row) => {
        const tr = document.createElement("tr");
        const moveMeta = moveMetaForName(record, row.name);
        const moveDescription = moveDescriptionForName(record, row.name);
        appendDataCell(tr, "#", escapeHtml(row.rank ?? "—"));
        appendDataCell(tr, "Name", moveInfoButton(row.name || "—", moveDescription));
        appendDataCell(tr, "Type", moveTypeMarkup(moveMeta?.type || ""));
        appendDataCell(tr, "Usage", row.percentage ? percentBar(row.percentage_value, row.percentage) : "—");
        tbody.append(tr);
      });
      wrap.append(table);
      return wrap;
    }

    if (category === "held_item") {
      const { table, tbody } = createResponsiveTable(["#", "Name", "Usage"], "battle-table held-item-table");
      rows.forEach((row) => {
        const tr = document.createElement("tr");
        appendDataCell(tr, "#", escapeHtml(row.rank ?? "—"));
        appendDataCell(tr, "Name", assetLabel(row.name || "—", itemImageCandidates(row.name), "item-label"));
        appendDataCell(tr, "Usage", row.percentage ? percentBar(row.percentage_value, row.percentage) : "—");
        tbody.append(tr);
      });
      wrap.append(table);
      return wrap;
    }

    if (category === "teammate") {
      const { table, tbody } = createResponsiveTable(["#", "Name"], "teammate-table");
      rows.forEach((row) => {
        const tr = document.createElement("tr");
        appendDataCell(tr, "#", escapeHtml(row.rank ?? "—"));
        appendDataCell(tr, "Name", assetLabel(row.name || "—", teammateImageCandidates(row.name), "teammate-label"));
        tbody.append(tr);
      });
      wrap.append(table);
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

  function learnableMovesBlock(record) {
    const moves = Array.isArray(record.learnableMoves) ? record.learnableMoves : [];
    const wrapper = document.createElement("div");
    wrapper.className = "learnable-moves-block";
    if (!moves.length) {
      wrapper.textContent = "No learnable moves available.";
      return wrapper;
    }

    const searchShell = document.createElement("div");
    searchShell.className = "learnable-moves-search-shell";
    const search = document.createElement("input");
    search.className = "learnable-moves-search";
    search.type = "search";
    search.placeholder = "Search moves";
    search.setAttribute("aria-label", "Search learnable moves");
    searchShell.append(search);

    const tableWrap = document.createElement("div");
    tableWrap.className = "data-table-wrap learnable-moves-wrap";

    const renderRows = () => {
      const query = search.value.trim();
      const scroller = els.dialogInner;
      const anchorTop = search.getBoundingClientRect().top;
      if (query && scroller) {
        const neededHeight = scroller.scrollTop + scroller.clientHeight - tableWrap.offsetTop + 24;
        tableWrap.style.minHeight = `${Math.max(260, Math.ceil(neededHeight))}px`;
      } else {
        tableWrap.style.minHeight = "";
      }
      const filtered = moves.filter((move) => learnableMoveMatches(move, query));
      if (!filtered.length) {
        tableWrap.innerHTML = `<div class="detail-empty">No matching moves.</div>`;
        if (scroller) requestAnimationFrame(() => { scroller.scrollTop += search.getBoundingClientRect().top - anchorTop; });
        return;
      }
      tableWrap.innerHTML = "";
      tableWrap.append(buildLearnableMovesTable(filtered));
      if (scroller) requestAnimationFrame(() => { scroller.scrollTop += search.getBoundingClientRect().top - anchorTop; });
    };

    search.addEventListener("input", renderRows);
    renderRows();
    wrapper.append(searchShell, tableWrap);
    return wrapper;
  }

  function baseStatsBlock(form) {
    const wrap = document.createElement("div");
    wrap.className = "stat-bars";
    if (!form || !BASE_STATS.some(([key]) => metadataStatValue(form, key) !== null && metadataStatValue(form, key) !== undefined)) {
      wrap.textContent = "No base-stat metadata available.";
      return wrap;
    }
    BASE_STATS.forEach(([key, label]) => {
      const value = numberOrZero(metadataStatValue(form, key));
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

  function formsTable(record) {
    const forms = Array.isArray(record?.forms) ? record.forms : [];
    const outer = document.createElement("div");
    outer.className = "forms-metadata-block";
    if (!forms.length) {
      outer.textContent = "No form metadata available.";
      return outer;
    }

    const desktopWrap = document.createElement("div");
    desktopWrap.className = "data-table-wrap forms-desktop-wrap";
    const labels = ["Form", "Types", "Abilities", "Stats"];
    desktopWrap.innerHTML = `
      <table class="responsive-data-table forms-table">
        ${tableHeader(labels)}
        <tbody>
          ${forms.map((form) => {
            const abilities = combinedAbilityLabel(form);
            const formName = formProfileName(form);
            const targetKind = findRecordByBattleName(formName) ? "exact" : "base";
            return `<tr>
              ${tableCell("Form", `<button class="form-profile-button" type="button" data-form-name="${escapeHtml(formName)}" data-battle-source="${escapeHtml(targetKind)}">${escapeHtml(formName || "—")}</button>`)}
              ${tableCell("Types", typeListMarkup(form.types))}
              ${tableCell("Abilities", escapeHtml(abilities || "—"))}
              ${tableCell("Stats", `<span class="form-stat-line">${FORM_STATS.map(([key, label]) => `<span>${escapeHtml(label)} ${escapeHtml(metadataStatValue(form, key) ?? "—")}</span>`).join("")}</span>`)}
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;

    outer.append(desktopWrap);
    desktopWrap.querySelectorAll(".forms-table tbody tr").forEach((row, index) => {
      const form = forms[index];
      row.classList.add("form-profile-row");
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Open ${formProfileName(form)} profile`);
      row.addEventListener("click", () => openDetail(formProfileRecord(record, form)));
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openDetail(formProfileRecord(record, form));
      });
    });
    return outer;
  }

  function formProfileName(form) {
    return String(form?.saved_name || form?.form_name || form?.title || form?.pokemon_name || "").trim();
  }

  function formProfileRecord(currentRecord, form) {
    const formName = formProfileName(form);
    const exactRecord = findRecordByBattleName(formName);
    const baseName = String(form?.pokemon_name || form?.base_name || currentRecord?.primary?.pokemon_name || "").trim();
    const baseRecord = findRecordByBattleName(baseName) || currentRecord;
    const sourceRecord = exactRecord || baseRecord;
    const battleName = exactRecord ? battleDataName(exactRecord) : battleDataName(baseRecord);
    const selectedForm = form || sourceRecord.primary;
    return {
      ...sourceRecord,
      name: formName || sourceRecord.name,
      battleName,
      slug: form?.slug || slugify(formName || sourceRecord.name),
      key: `${sourceRecord.key || recordKey(battleName)}::form::${recordKey(formName || sourceRecord.name)}`,
      favoriteKey: sourceRecord.key || recordKey(battleName || sourceRecord.name),
      primary: selectedForm,
      types: selectedForm?.types?.length ? selectedForm.types : sourceRecord.types,
      imageCandidates: pokemonImageCandidates(selectedForm?.image_path, formName, selectedForm?.form_name),
      forms: currentRecord?.forms?.length ? currentRecord.forms : sourceRecord.forms,
      metadataCsv: currentRecord?.metadataCsv || sourceRecord.metadataCsv,
      battleSources: sourceRecord.battleSources || [],
      seasons: sourceRecord.seasons || [],
      formats: sourceRecord.formats || [],
      summariesBySeason: sourceRecord.summariesBySeason || {},
      battleBySelection: sourceRecord.battleBySelection || new Map(),
      learnableMoveNames: [],
      learnableMoves: [],
      learnableMovesLoaded: false,
      metadataLoaded: true,
      formProfileBattleSource: exactRecord ? "exact" : "base"
    };
  }

  function findRecordByBattleName(name) {
    const target = recordKey(name);
    if (!target) return null;
    return state.pokemon.find((record) => recordKey(battleDataName(record)) === target) || null;
  }

  function routeSlugFromLocation() {
    const match = window.location.pathname.match(/^\/pokemon\/([^/?#]+)\/?$/i);
    if (!match) return "";
    try {
      return slugify(decodeURIComponent(match[1]));
    } catch {
      return slugify(match[1]);
    }
  }

  function profileSlug(record) {
    return record?.slug || slugify(record?.primary?.saved_name || record?.primary?.form_name || battleDataName(record) || record?.name);
  }

  function profilePath(record) {
    const slug = profileSlug(record);
    return slug ? `/pokemon/${slug}/` : "";
  }

  function updateProfileRoute(record, routeAction = "push") {
    if (!window.history || typeof window.history.pushState !== "function") return;
    const path = profilePath(record);
    if (!path || window.location.pathname === path) return;
    const method = routeAction === "replace" ? "replaceState" : "pushState";
    window.history[method]({}, "", path);
  }

  function updateExplorerRoute(routeAction = "push") {
    if (!window.history || typeof window.history.pushState !== "function" || !routeSlugFromLocation()) return;
    const method = routeAction === "replace" ? "replaceState" : "pushState";
    window.history[method]({}, "", "/");
  }

  function findProfileRecordBySlug(slug) {
    const target = slugify(slug);
    if (!target) return null;
    for (const record of state.pokemon) {
      if (profileSlug(record) === target) return record;
    }
    for (const record of state.pokemon) {
      for (const form of record.forms || []) {
        const formSlug = form?.slug || slugify(formProfileName(form));
        if (formSlug === target) return formProfileRecord(record, form);
      }
    }
    return null;
  }

  async function openRouteProfileFromLocation() {
    const slug = routeSlugFromLocation();
    if (!slug) {
      if (els.detailDialog?.open) closeDetail({ updateRoute: false });
      return false;
    }
    const record = findProfileRecordBySlug(slug);
    if (!record) return false;
    if (els.detailDialog?.open && profileSlug(state.activeDetailRecord) === profileSlug(record)) return true;
    await openDetail(record, { updateRoute: false, rememberSearch: false });
    return true;
  }

  function natureChangeMarkup(natureName) {
    const [boosted, lowered] = NATURE_CHANGES[normalizeForSearch(natureName).trim()] || ["", ""];
    if (!boosted || !lowered) return `<span class="nature-change nature-neutral">Neutral</span>`;
    return `<span class="nature-change"><span class="nature-up">+${escapeHtml(boosted)}</span><span class="nature-separator">/</span><span class="nature-down">- ${escapeHtml(lowered)}</span></span>`;
  }

  function natureLabelMarkup(natureName) {
    const name = escapeHtml(natureName || "—");
    return `<span class="nature-label"><span>${name}</span>${natureName ? natureChangeMarkup(natureName) : ""}</span>`;
  }

  function combinedAbilityLabel(form) {
    const baseAbilities = splitListValue(form.abilities);
    const hiddenAbilities = splitListValue(form.hidden_ability);
    const hiddenSet = new Set(hiddenAbilities.map((ability) => ability.toLowerCase()));
    const merged = unique([...baseAbilities, ...hiddenAbilities]);
    return merged.map((ability) => hiddenSet.has(ability.toLowerCase()) ? `${ability} (Hidden)` : ability).join(" / ");
  }

  function typeChip(type, loading = "lazy") {
    const chip = document.createElement("span");
    chip.className = "type-chip";
    const candidates = typeImageCandidates(type).map(resolveAssetCandidate).filter(Boolean);
    if (candidates.length) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = loading;
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

  function typeListMarkup(types) {
    const labels = unique((types || []).map(titleCase).filter(Boolean));
    if (!labels.length) return "—";
    return `<span class="form-type-list">${labels.map(typeChipMarkup).join("")}</span>`;
  }

  function typeChipMarkup(type) {
    const label = titleCase(type || "");
    if (!label) return "";
    const src = resolveAssetCandidate(typeImageCandidates(label)[0]);
    const image = src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async">` : "";
    return `<span class="type-chip form-type-chip">${image}${escapeHtml(label)}</span>`;
  }

  function buildLearnableMovesTable(moves) {
    const table = document.createElement("table");
    table.className = "responsive-data-table learnable-moves-table";
    table.innerHTML = `
      ${tableHeader(["Move", "Type", "Category", "Power", "Accuracy", "PP", "Description"])}
      <tbody>${moves.map((move) => `<tr>
        ${tableCell("Move", escapeHtml(move.move_name || "—"))}
        ${tableCell("Type", moveTypeMarkup(move.type))}
        ${tableCell("Category", moveCategoryMarkup(move.category))}
        ${tableCell("Power", escapeHtml(move.power || "—"))}
        ${tableCell("Accuracy", escapeHtml(move.accuracy || "—"))}
        ${tableCell("PP", escapeHtml(move.pp || "—"))}
        ${tableCell("Description", `<span class="move-description">${escapeHtml(move.description || "—")}</span>`)}
      </tr>`).join("")}</tbody>`;
    return table;
  }

  function createResponsiveTable(labels, className) {
    const table = document.createElement("table");
    table.className = `responsive-data-table ${className}`;
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    labels.forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.append(th);
    });
    thead.append(headRow);
    const tbody = document.createElement("tbody");
    table.append(thead, tbody);
    return { table, tbody };
  }

  function appendDataCell(row, label, content) {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    if (content instanceof Node) cell.append(content);
    else cell.innerHTML = content || "—";
    row.append(cell);
    return cell;
  }

  function moveInfoButton(moveName, description) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "move-info-button";
    button.textContent = moveName || "—";
    button.dataset.moveName = moveName || "";
    button.dataset.moveDescription = description || "No short description available.";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", `${moveName || "Move"} description`);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMoveInfoPopover(button);
    });
    return button;
  }

  function toggleMoveInfoPopover(button) {
    if (state.activeMoveButton === button && !moveInfoPopover().hidden) {
      hideMoveInfoPopover();
      return;
    }
    showMoveInfoPopover(button);
  }

  function showMoveInfoPopover(button) {
    const popover = moveInfoPopover();
    const moveName = button.dataset.moveName || "Move";
    const description = button.dataset.moveDescription || "No short description available.";
    if (state.activeMoveButton) {
      state.activeMoveButton.classList.remove("active");
      state.activeMoveButton.setAttribute("aria-expanded", "false");
    }
    state.activeMoveButton = button;
    button.classList.add("active");
    button.setAttribute("aria-expanded", "true");
    popover.innerHTML = `<strong>${escapeHtml(moveName)}</strong><span>${escapeHtml(description)}</span>`;
    popover.hidden = false;
    requestAnimationFrame(() => positionMoveInfoPopover());
  }

  function hideMoveInfoPopover() {
    const popover = document.getElementById("moveInfoPopover");
    if (state.activeMoveButton) {
      state.activeMoveButton.classList.remove("active");
      state.activeMoveButton.setAttribute("aria-expanded", "false");
    }
    state.activeMoveButton = null;
    if (popover) popover.hidden = true;
  }

  function moveInfoPopover() {
    let popover = document.getElementById("moveInfoPopover");
    if (!popover) {
      popover = document.createElement("div");
      popover.id = "moveInfoPopover";
      popover.className = "move-info-popover";
      popover.setAttribute("role", "tooltip");
      popover.hidden = true;
      els.detailDialog.append(popover);
    }
    return popover;
  }

  function positionMoveInfoPopover() {
    const button = state.activeMoveButton;
    const popover = document.getElementById("moveInfoPopover");
    if (!button || !popover || popover.hidden) return;
    const buttonRect = button.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const margin = 12;
    let left = buttonRect.left;
    let top = buttonRect.bottom + 8;

    if (left + popoverRect.width > window.innerWidth - margin) {
      left = window.innerWidth - popoverRect.width - margin;
    }
    if (top + popoverRect.height > window.innerHeight - margin) {
      top = buttonRect.top - popoverRect.height - 8;
    }
    left = Math.max(margin, left);
    top = Math.max(margin, top);

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function assetLabel(name, candidates, className) {
    const label = document.createElement("span");
    label.className = `asset-label ${className}`;
    const icon = document.createElement("span");
    icon.className = "asset-icon";
    appendAssetIconOrFallback(icon, candidates, name, initials(name));
    const text = document.createElement("span");
    text.className = "asset-label-text";
    text.textContent = name || "—";
    label.append(icon, text);
    return label;
  }

  function appendAssetIconOrFallback(target, candidates, alt, fallbackText) {
    const resolved = unique((candidates || []).map(resolveAssetCandidate).filter(Boolean));
    if (!resolved.length) {
      target.append(assetIconFallback(fallbackText));
      return;
    }
    let index = 0;
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", () => {
      state.failedAssetUrls.add(resolved[index] || img.src);
      index += 1;
      if (index < resolved.length) img.src = resolved[index];
      else { img.remove(); target.append(assetIconFallback(fallbackText)); }
    });
    img.src = resolved[index];
    target.append(img);
  }

  function assetIconFallback(text) {
    const fallback = document.createElement("span");
    fallback.className = "asset-icon-fallback";
    fallback.textContent = initials(text);
    return fallback;
  }

  function moveTypeMarkup(type) {
    const label = titleCase(type || "");
    if (!label) return "—";
    const src = resolveAssetCandidate(typeImageCandidates(label)[0]);
    const image = src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async">` : "";
    return `<span class="move-type-label">${image}<span>${escapeHtml(label)}</span></span>`;
  }

  function moveCategoryMarkup(category) {
    const label = titleCase(category || "");
    if (!label) return "—";
    const className = normalizeForSearch(label).replace(/[^a-z0-9]+/g, "-");
    const shortLabels = { physical: "PHY", special: "SPE", status: "STA" };
    const shortLabel = shortLabels[className] || label.slice(0, 3).toUpperCase();
    return `<span class="move-category ${escapeHtml(className)}"><span class="move-category-full">${escapeHtml(label)}</span><span class="move-category-short">${escapeHtml(shortLabel)}</span></span>`;
  }

  function moveMetaForName(record, moveName) {
    const key = recordKey(moveName);
    return (record?.learnableMoves || []).find((move) => recordKey(move.move_name) === key) || null;
  }

  function moveDescriptionForName(record, moveName) {
    const key = recordKey(moveName);
    const moveMeta = moveMetaForName(record, moveName);
    return compactText(moveMeta?.description || state.moveDescriptionCache.get(key) || "");
  }

  function learnableMoveMatches(move, query) {
    if (!query) return true;
    const needle = normalizeForSearch(query);
    return [move.move_name, move.type, move.category, move.power, move.accuracy, move.pp, move.description]
      .some((value) => normalizeForSearch(value).includes(needle));
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
    const fillWidth = (safe * 1.2).toFixed(2);
    return `<span class="usage-meter" aria-label="${escapeHtml(label || `${safe}%`)}"><svg class="usage-svg" viewBox="0 0 120 10" width="120" height="10" aria-hidden="true" focusable="false"><rect class="usage-svg-track" x="0" y="0" width="120" height="10" rx="5"></rect><rect class="usage-svg-fill" x="0" y="0" width="${fillWidth}" height="10" rx="5" style="fill:${usageColor(safe)}"></rect></svg><b class="usage-value">${escapeHtml(label || "?")}</b></span>`;
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
      button.disabled = false;
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

  function favoriteKeyForRecord(record) {
    return String(record?.favoriteKey || record?.key || "").trim();
  }

  function updateProfileFavoriteButton(record = state.activeDetailRecord) {
    const button = els.profileFavoriteButton;
    if (!button) return;
    const key = favoriteKeyForRecord(record);
    button.hidden = !key;
    if (!key) return;
    const active = state.favorites.has(key);
    button.innerHTML = `<span class="favorite-heart-glyph" aria-hidden="true">${active ? "&#9829;" : "&#9825;"}</span>`;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", active ? "Remove favorite" : "Add favorite");
    button.title = active ? "Remove favorite" : "Add favorite";
  }

  function toggleProfileFavorite(event) {
    event.preventDefault();
    event.stopPropagation();
    const key = favoriteKeyForRecord(state.activeDetailRecord);
    if (!key) return;
    toggleFavorite(key);
    updateProfileFavoriteButton();
    applyFiltersAndRender();
  }

  function toggleFavorite(key) {
    if (!key) return;
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

  function withFormat(rows, format, sourcePath = "", season = detectSeasonFromPath(sourcePath)) {
    return rows.map((row) => ({ ...row, _battle_format: format || detectFormatFromPath(sourcePath), _battle_season: season, _source_path: sourcePath }));
  }

  function normalizeMetadataRow(row) {
    const types = splitTypes(readField(row, METADATA_ALIASES.types));
    const baseName = readField(row, ["base_name"]) || readField(row, ["pokemon_name", "pokemon", "name"]) || "";
    const savedName = readField(row, ["saved_name", "form_name"]) || baseName || "Unknown form";
    const titleField = readField(row, ["title"]) || savedName;
    const formKind = readField(row, METADATA_ALIASES.form_kind) || "";
    const normalized = {
      pokemon_name: baseName,
      title: titleField,
      dex_number: metadataNumber(row, "dex_number", METADATA_ALIASES.dex_number),
      base_dex_url: readField(row, METADATA_ALIASES.base_dex_url) || "",
      image_path: normalizePath(readField(row, METADATA_ALIASES.image_path) || ""),
      form_name: savedName,
      saved_name: savedName,
      slug: slugify(savedName),
      form_kind: formKind || (savedName === baseName ? "Base" : "Form"),
      types,
      types_raw: readField(row, METADATA_ALIASES.types) || "",
      abilities: readField(row, METADATA_ALIASES.abilities) || "",
      hidden_ability: readField(row, METADATA_ALIASES.hidden_ability) || ""
    };
    Object.keys(STAT_ALIASES).forEach((key) => {
      normalized[key] = metadataStatValue(row, key);
    });
    return normalized;
  }

  function normalizeBattleRow(row) {
    const normalized = { ...row };
    normalized.category = row.category || "";
    normalized.column_position = numberOrNull(row.column_position);
    normalized.position = normalized.column_position ?? numberOrNull(row.position);
    normalized.rank = numberOrNull(row.rank);
    normalized.name = row.name || "";
    normalized.percentage = row.percentage || "";
    normalized.percentage_value = parsePercent(row.percentage);
    normalized.stat_up = row.stat_up || "";
    normalized.stat_down = row.stat_down || "";
    if (row.source_time_seconds !== undefined) normalized.source_time_seconds = numberOrNull(row.source_time_seconds);
    normalized.format = titleCase(row._battle_format || row.format || row.battle_format || detectFormatFromPath(row._source_path || "") || "Battle");
    normalized.season = row._battle_season || row.season || detectSeasonFromPath(row._source_path || "") || DEFAULT_SEASON;
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
      column_position: row.column_position,
      position: row.position,
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

  function appendImageOrFallback(target, candidates, alt, fallbackText, options = {}) {
    const resolved = unique((candidates || []).map(resolveAssetCandidate).filter(Boolean));
    if (!resolved.length) {
      target.append(fallbackNode(fallbackText));
      return;
    }
    let index = 0;
    const img = document.createElement("img");
    img.alt = alt;
    img.loading = options.loading || "lazy";
    if (options.fetchPriority) img.fetchPriority = options.fetchPriority;
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
    const encoded = encodeURI(rootRelativePath(path));
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

  function battleDataName(record) {
    return String(record?.battleName || record?.saved_name || record?.primary?.saved_name || record?.name || "").trim();
  }

  function displayNameForBattleName(battleName, form) {
    const rawName = String(battleName || "").trim();
    const baseName = String(form?.pokemon_name || form?.base_name || "").trim();
    return (!REGIONAL_FORM_PATTERN.test(rawName) && baseName) ? baseName : rawName;
  }

  function findMetadataFormForBattleName(forms, battleName) {
    const target = normalizeForSearch(battleName);
    return (forms || []).find((form) => normalizeForSearch(form?.saved_name || form?.form_name) === target) || null;
  }

  function searchablePokemonNames(record) {
    return unique([
      record?.name,
      battleDataName(record),
      record?.primary?.pokemon_name,
      record?.primary?.saved_name,
      record?.primary?.form_name
    ].filter(Boolean));
  }

  function searchablePokemonTextValues(record, format = state.selectedFormat, season = state.selectedSeason) {
    const values = [
      ...searchablePokemonNames(record),
      ...(record?.types || []),
      ...metadataAbilityValues(record)
    ];
    (record?.forms || []).forEach((form) => {
      values.push(form?.pokemon_name, form?.saved_name, form?.form_name, form?.form_kind);
      values.push(...(form?.types || []));
    });
    values.push(...searchableBattleTextValues(record, format, season));
    values.push(...learnableMoveSearchValues(record));
    return unique(values.filter(Boolean));
  }

  function searchableBattleTextValues(record, format = state.selectedFormat, season = state.selectedSeason) {
    const values = [];
    battleRowsForSearch(record, format, season)
      .filter((row) => row?.category !== "teammate")
      .forEach((row) => {
        values.push(rowLabel(row), row?.name, row?.category, row?.stat_up, row?.stat_down);
      });
    return values;
  }

  function learnableMoveSearchValues(record) {
    const values = [];
    (record?.learnableMoves || []).forEach((move) => {
      values.push(move?.move_name, move?.type, move?.category);
    });
    values.push(...(record?.learnableMoveNames || []));
    return values;
  }

  function learnableMovePathCandidates(record) {
    const names = unique([
      record?.primary?.saved_name,
      record?.primary?.form_name,
      battleDataName(record)
    ].filter(Boolean));
    return names.map((name) => `${ROOT}/learnable_moves/${name}.csv`);
  }

  function moveDescriptionPathCandidates(moveName) {
    const cleanName = String(moveName || "").trim();
    const underscoredName = cleanName.replace(/\s+/g, "_");
    return unique([underscoredName, cleanName].filter(Boolean))
      .map((name) => `${ROOT}/all_moves/${name}.csv`);
  }

  function extractMoveDescription(rows, moveName) {
    const moveKey = recordKey(moveName);
    const textRows = (rows || [])
      .map((row) => String(readField(row, ["text", "description"]) || "").trim())
      .filter(Boolean);
    const descriptionRows = textRows.filter((text) => {
      const normalized = recordKey(text.replace(/\s+/g, " "));
      return normalized !== moveKey && !/^(power|accuracy|pp)(\s*\n|\s+\d|$)/i.test(text);
    });
    return compactText(descriptionRows.at(-1) || "");
  }

  function normalizeLearnableMove(row) {
    return {
      move_name: readField(row, ["move_name", "move", "name"]) || "",
      type: titleCase(readField(row, ["type"]) || ""),
      category: titleCase(readField(row, ["category", "damage_class"]) || ""),
      power: readField(row, ["power", "base_power"]) || "",
      accuracy: readField(row, ["accuracy", "acc"]) || "",
      pp: readField(row, ["pp"]) || "",
      description: ""
    };
  }

  function typeImageCandidates(type) {
    const title = titleCase(type);
    const lower = String(type || "").toLowerCase();
    const upper = String(type || "").toUpperCase();
    return [`${ROOT}/types/${title}.png`, `${ROOT}/types/${lower}.png`, `${ROOT}/types/${upper}.png`, `${ROOT}/types/${title}.webp`, `${ROOT}/types/${lower}.webp`];
  }

  function itemImageCandidates(itemName) {
    const name = String(itemName || "").trim();
    return name ? [`${ROOT}/items/${name}.png`, `${ROOT}/items/${name}.webp`] : [];
  }

  function teammateImageCandidates(name) {
    const key = recordKey(name);
    const matched = state.pokemon.find((record) => {
      const names = [
        record.name,
        battleDataName(record),
        record.primary?.pokemon_name,
        record.primary?.saved_name,
        record.primary?.form_name
      ];
      return names.some((candidate) => recordKey(candidate) === key);
    });
    return unique([
      ...(matched?.imageCandidates || []),
      ...pokemonImageCandidates("", name)
    ]);
  }

  function availableSeasons() {
    return state.availableSeasons.length ? state.availableSeasons : sortSeasons(unique(state.pokemon.flatMap((record) => record.seasons || [])));
  }

  function availableFormats() {
    return sortFormats(unique(state.pokemon.flatMap((record) =>
      (record.battleSources || [])
        .filter((source) => sourceMatchesSeason(source, state.selectedSeason))
        .map((source) => source.format)
    )));
  }

  function recordHasBattleSelection(record, season, format) {
    return (record.battleSources || []).some((source) => sourceMatchesSeason(source, season) && source.format === format);
  }

  function findBattleSource(record, season, format) {
    return (record.battleSources || []).find((source) => sourceMatchesSeason(source, season) && source.format === format);
  }

  function sourceMatchesSeason(source, season) {
    return normalizeForSearch(source?.season) === normalizeForSearch(season);
  }

  function battleSelectionKey(season, format) {
    return `${season || "Current"}::${titleCase(format || "Battle")}`;
  }

  function statColor(value) {
    const numeric = numberOrZero(value);
    if (numeric >= 120) return "var(--stat-great)";
    if (numeric >= 90) return "var(--stat-good)";
    if (numeric >= 60) return "var(--stat-mid)";
    return "var(--stat-bad)";
  }

  function usageColor(value) {
    const numeric = numberOrZero(value);
    if (numeric >= 75) return "var(--stat-great)";
    if (numeric >= 50) return "var(--stat-good)";
    if (numeric >= 25) return "var(--stat-mid)";
    return "var(--stat-bad)";
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

  function sortSeasons(seasons) {
    return [...seasons].sort((a, b) => {
      if (a === DEFAULT_SEASON) return -1;
      if (b === DEFAULT_SEASON) return 1;
      const am = String(a || "").match(/M-(\d+)/i);
      const bm = String(b || "").match(/M-(\d+)/i);
      if (am && bm) return Number(bm[1]) - Number(am[1]);
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    });
  }

  function readField(row, aliases) {
    if (!row) return "";
    const keys = Array.isArray(aliases) ? aliases : [aliases];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== null && row[key] !== undefined && row[key] !== "") return row[key];
    }
    const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
    for (const key of keys) {
      const value = normalized.get(normalizeHeader(key));
      if (value !== null && value !== undefined && value !== "") return value;
    }
    return "";
  }

  function normalizeHeader(value) {
    return String(value || "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  }

  function metadataNumber(row, canonicalKey, aliases = []) {
    return numberOrNull(readField(row, [canonicalKey, ...(aliases || [])]));
  }

  function metadataStatValue(row, canonicalKey) {
    return metadataNumber(row, canonicalKey, STAT_ALIASES[canonicalKey] || [canonicalKey]);
  }

  function splitTypes(value) {
    return unique(String(value || "").split(/[\/|,]/).map((type) => titleCase(type.trim())).filter(Boolean));
  }

  function detectFormatFromPath(path) {
    return battleInfoFromPath(path).format;
  }

  function detectSeasonFromPath(path) {
    return battleInfoFromPath(path).season;
  }

  function pathForSeason(path, season) {
    const parts = normalizePath(path).split("/").filter(Boolean);
    const index = parts.findIndex((part) => normalizeForSearch(part) === "battle_data");
    if (index === -1 || !parts[index + 1] || /^season\b/i.test(parts[index + 1])) return normalizePath(path);
    parts.splice(index + 1, 0, season);
    return parts.join("/");
  }

  function battleInfoFromPath(path) {
    const parts = normalizePath(path).split("/").filter(Boolean);
    const index = parts.findIndex((part) => normalizeForSearch(part) === "battle_data");
    if (index !== -1 && parts[index + 1] && parts[index + 2] && /^season\b/i.test(parts[index + 1])) {
      return { season: parts[index + 1], format: titleCase(parts[index + 2].replace(/[_-]/g, " ")) };
    }
    if (index !== -1 && parts[index + 1] && !parts[index + 1].toLowerCase().endsWith(".csv")) {
      return { season: "Current", format: titleCase(parts[index + 1].replace(/[_-]/g, " ")) };
    }
    return { season: DEFAULT_SEASON, format: "Battle" };
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

  function compactText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizePath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  }

  function rootRelativePath(path) {
    const raw = String(path || "").trim();
    if (!raw) return "";
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) return raw;
    const normalized = normalizePath(raw);
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  function recordKey(value) {
    return normalizeForSearch(String(value || "")).replace(/\s+/g, " ").trim();
  }

  function slugify(value) {
    return normalizeForSearch(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
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
