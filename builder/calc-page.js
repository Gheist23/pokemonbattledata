// Damage Calculator page: draws CalcModel and wires the controls.

import { BuilderData, NATURE_ORDER, STAT_LABELS, bonusTotal, makeSet, setFromCommon } from "./common.js";
import { CalcModel, FIELD_LABELS, GENDERS, LEFT, RIGHT, STATUSES, defaultCalcState, defaultMonState, other } from "./calc-model.js";
import { MAX_BONUS_POINTS_PER_STAT, MAX_BONUS_STAT_POINTS } from "./engine.js";
import { clear, h, pickPokemon, searchSelect, select, sprite, toast, typeChip } from "./ui.js";
import { keepPlace } from "./scroll-anchor.js";
import { currentTeam, getState, subscribe, teamSets } from "./store.js";

const STORAGE_KEY = "cbd.calc.v1";
// How many ranked Pokemon the "Top Doubles/Singles meta" row offers. The chips
// wrap and the block scrolls (builder.css), so the row stays usable on a phone.
const META_IMPORT_CHIPS = 30;
const STAT_KEYS = ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"];
const STAGE_ATTRS = { attack: "attack_stage", defense: "defense_stage", sp_attack: "sp_attack_stage", sp_defense: "sp_defense_stage", speed: "speed_stage" };

let data;
let model;
const root = document.getElementById("calcApp");

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(model.state));
  } catch {
    // storage unavailable: the page still works for this visit
  }
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (raw && raw.mons?.left?.set && raw.mons?.right?.set) return { ...defaultCalcState(), ...raw };
  } catch {
    // ignore a damaged saved state
  }
  return null;
}

function formatQuery() {
  const params = new URLSearchParams(location.search);
  const format = params.get("format");
  return format === "Singles" || format === "Doubles" ? format : null;
}

async function initialSets(format) {
  const meta = await data.loadMeta(format);
  const top = meta.pokemon.slice(0, 2);
  const params = new URLSearchParams(location.search);
  const want = params.get("attacker") || params.get("pokemon");
  const target = params.get("defender");
  const fromName = (name, fallback) => {
    if (!name) return fallback;
    const [species, form] = data.resolveName(name);
    return data.speciesEntry(species) ? setFromCommon(data.commonSet(format, species, form)) : fallback;
  };
  const a = top[0] ? setFromCommon(data.commonSet(format, top[0].species, top[0].form)) : makeSet();
  const b = top[1] ? setFromCommon(data.commonSet(format, top[1].species, top[1].form)) : makeSet();
  return [fromName(want, a), fromName(target, b)];
}

// --- rendering ------------------------------------------------------------------

function render() {
  // The whole page is rebuilt, so the browser cannot hold the reading position
  // itself: note where the top of the screen is and put it back (scroll-anchor.js).
  const keepPosition = keepPlace("calc");
  clear(root);
  root.append(
    renderResults(),
    h("div", { class: "bd-calc-body" }, renderMon(LEFT), renderField(), renderMon(RIGHT)),
  );
  syncFormatSwitch();
  save();
  keepPosition();
}

function monName(side) {
  const mon = model.mon(side);
  const [, form] = data.battleForm(mon.pokemon_name, mon.form_name, mon.item);
  return data.displayName(mon.pokemon_name, form, mon.form_name) || "Pokémon";
}

function renderResults() {
  const state = model.state;
  const moveList = (side) => {
    const mon = model.mon(side);
    const rows = [0, 1, 2, 3].map((index) => {
      const move = mon.moves[index];
      const selected = state.selectedSide === side && state.selectedIndex === index;
      if (!move) return h("div", { class: "bd-result-row empty" }, h("span", { class: "bd-result-move" }, "—"), h("span"), h("span", { class: "bd-result-pct" }, "—"));
      const result = model.calculate(side, index, selected ? state.critical : false);
      const meta = data.move(move) || {};
      return h("div", { class: `bd-result-row ${selected ? "selected" : ""}` },
        h("button", {
          type: "button",
          class: "bd-result-move",
          "aria-pressed": selected ? "true" : "false",
          onclick: () => selectMove(side, index),
        }, meta.type ? h("img", { src: `/pokemon_champions_assets/types/${meta.type}.png`, alt: "", width: 14, height: 14 }) : null, move),
        h("button", {
          type: "button",
          class: `bd-crit ${selected && state.critical ? "on" : ""}`,
          "aria-pressed": selected && state.critical ? "true" : "false",
          "aria-label": `Critical hit for ${move}`,
          onclick: () => toggleCrit(side, index),
        }, "Crit"),
        resultPercent(result));
    });
    return h("section", { class: `bd-card bd-results-side bd-side-${side}`, "aria-label": `${side === LEFT ? "Our" : "Opposing"} move results` },
      h("h2", { class: "bd-card-title" }, side === LEFT ? "Our moves" : "Opposing moves", h("small", {}, monName(side))),
      rows);
  };

  const verdict = h("section", { class: "bd-card bd-verdict", "aria-live": "polite" });
  const [selectedSide, selectedMove] = model.selectedMove();
  let result = null;
  if (selectedMove) {
    result = model.calculate(selectedSide, state.selectedIndex, state.critical);
    const attackerName = monName(selectedSide);
    const defenderName = monName(other(selectedSide));
    verdict.append(
      h("p", { class: "bd-verdict-eyebrow" }, `${selectedSide === LEFT ? "Our" : "Opposing"} ${attackerName} → ${defenderName}`),
      h("h2", { class: "bd-verdict-title" }, koHeading(selectedSide, selectedMove)),
      h("p", { class: "bd-verdict-ko" }, model.formatKoOdds(result)),
      h("p", { class: "bd-verdict-damage" }, `Damage: ${result.range} HP  |  ${result.percent}`, result.recoil_text ? h("span", { class: "bd-recoil" }, ` · ${result.recoil_text}`) : null),
      h("p", { class: "bd-verdict-note" }, [result.ko, ...(result.warnings || []).slice(0, 2).map((w) => `Missing exact data: ${w}`)].filter(Boolean).join("  |  ")),
      h("p", { class: "bd-verdict-speed" }, speedLine(result, selectedSide)));
  } else {
    const outcome = model.matchup();
    verdict.append(
      h("p", { class: "bd-verdict-eyebrow" }, "Matchup — no move selected"),
      h("h2", { class: "bd-verdict-title" }, outcome.headline || outcome.text),
      outcome.detail ? h("p", { class: "bd-verdict-ko" }, outcome.detail) : null,
      h("p", { class: "bd-verdict-note" }, "Each side uses its best move every turn. Select a move to see its KO odds."));
  }
  const chips = model.effectChips(result);
  const counts = model.countControls();
  if (chips.length || counts.length) {
    verdict.append(h("div", { class: "bd-effects", role: "group", "aria-label": "Effects included in the calculation" },
      chips.map((chip) => {
        const button = h("button", {
          type: "button",
          class: `bd-effect ${chip.active ? "on" : ""}`,
          "aria-pressed": chip.active ? "true" : "false",
          title: `${chip.side === LEFT ? "Our" : "Opposing"} ${chip.kind}: ${chip.name}. ${chip.reason || "Click to include or exclude it."}`,
          disabled: chip.locked,
          onclick: () => {
            model.setEffect(chip.side, chip.kind, chip.name, !chip.active);
            render();
          },
        }, chip.label);
        if (!chip.options) return button;
        // The chip stays the on/off switch; the amount sits beside it, and is
        // out of reach while the effect is switched off.
        const picker = select(chip.options.map(([label, value]) => [String(value), label]), String(chip.value ?? 0), (value) => {
          model.setEffectValue(chip.side, chip.name, Number(value));
          render();
        }, { class: "bd-select bd-effect-select", "aria-label": `${chip.label} amount`, disabled: !chip.active });
        return h("span", { class: "bd-effect-group" }, button, picker);
      }),
      counts.map((row) => h("label", { class: "bd-effect-group bd-count", title: row.spec.tip },
        h("span", { class: "bd-count-name" }, row.label),
        select(row.spec.options.map(([label, value]) => [String(value), label]), String(row.value), (value) => {
          model.setCountValue(row.spec.storeKey, Number(value), row.spec.default);
          render();
        }, { class: "bd-select bd-effect-select" })))));
  }
  return h("div", { class: "bd-calc-results" }, moveList(LEFT), verdict, moveList(RIGHT));
}

/** "Kowtow Cleave KO odds (2 fainted allies)": the heading names the amounts
 *  the number below it was worked out with. */
function koHeading(side, move) {
  const notes = model.headerNotes(side, move);
  return `${move} KO odds${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

/** "80.8 - 95.5% (20.3 - 24.2% recoil)" as the app shows it, recoil on its own line. */
function resultPercent(result) {
  const text = String(result?.display_percent || result?.percent || "—");
  const match = text.match(/^(.*?)\s*\((.+ recoil)\)$/);
  if (!match) return h("span", { class: "bd-result-pct" }, text);
  return h("span", { class: "bd-result-pct" }, match[1], h("small", { class: "bd-recoil" }, `${match[2]}`));
}

function speedLine(result, side) {
  if (!result) return "";
  const attacker = monName(side);
  const defender = monName(other(side));
  const a = model.boostedStats(side).boosted.speed;
  const d = model.boostedStats(other(side)).boosted.speed;
  const who = a === d ? "Speed tie" : a > d ? `${attacker} moves first` : `${defender} moves first`;
  return `Speed ${attacker} ${a} · ${defender} ${d} — ${who}`;
}

function renderMon(side) {
  const state = model.state;
  const entry = state.mons[side];
  const set = entry.set;
  const mon = model.mon(side);
  const [battleSpecies, battleForm, forcedAbility] = data.battleForm(mon.pokemon_name, mon.form_name, mon.item);
  const types = data.types(set.species, set.form, set.item);
  const { total, boosted } = model.boostedStats(side);
  const maxHp = total.hp;
  const currentHp = Math.max(1, Math.ceil((maxHp * entry.hp) / 100));

  const changePokemon = async () => {
    const row = await pickPokemon(data, { format: state.format, title: side === LEFT ? "Our Pokémon" : "Opposing Pokémon" });
    if (!row) return;
    entry.set = setFromCommon(data.commonSet(state.format, row.species, row.form));
    resetMonState(side);
    render();
  };

  const abilityOptions = [...new Set([...data.abilities(set.species, set.form), set.ability].filter(Boolean))];
  const abilityField = forcedAbility && battleForm !== set.form
    ? h("span", { class: "bd-forced" }, forcedAbility)
    : select(abilityOptions, set.ability, (value) => { set.ability = value; render(); }, { "aria-label": "Ability" });
  const usage = data.usage(state.format, set.species, set.form);
  const itemUsage = new Map((usage?.items || []).map(([name, pct]) => [name.toLowerCase(), pct]));
  const itemCombo = searchSelect({
    options: data.itemNames.map((name) => ({ value: name, label: name, icon: data.itemIcon(name), badge: itemUsage.has(name.toLowerCase()) ? `${itemUsage.get(name.toLowerCase())}%` : "" }))
      .sort((a, b) => (itemUsage.get(b.value.toLowerCase()) || 0) - (itemUsage.get(a.value.toLowerCase()) || 0)),
    value: set.item,
    placeholder: "Held item",
    label: "Held item",
    onChange: (value) => { set.item = value; render(); },
  });
  const moveUsage = new Map((usage?.moves || []).map(([name, pct]) => [name.toLowerCase(), pct]));
  const pool = [...new Set([...data.learnset(set.species, set.form), ...set.moves])];
  const moveOptions = pool.map((name) => {
    const meta = data.move(name) || {};
    return {
      value: name,
      label: name,
      icon: meta.type ? `/pokemon_champions_assets/types/${meta.type}.png` : "",
      hint: [meta.category ? meta.category[0].toUpperCase() + meta.category.slice(1) : "", Number(meta.power) > 0 ? `${meta.power}` : ""].filter(Boolean).join(" "),
      badge: moveUsage.has(name.toLowerCase()) ? `${moveUsage.get(name.toLowerCase())}%` : "",
    };
  }).sort((a, b) => (moveUsage.get(b.value.toLowerCase()) || 0) - (moveUsage.get(a.value.toLowerCase()) || 0) || a.label.localeCompare(b.label));
  const moves = h("div", { class: "bd-mon-moves" }, [0, 1, 2, 3].map((index) => searchSelect({
    options: moveOptions,
    value: set.moves[index] || "",
    placeholder: `Move ${index + 1}`,
    label: `Move ${index + 1}`,
    onChange: (value) => {
      const next = [...set.moves];
      next[index] = value;
      set.moves = next.filter((move, i) => move && next.indexOf(move) === i);
      if (state.selectedSide === side && state.selectedIndex >= set.moves.length) {
        state.selectedSide = "";
        state.selectedIndex = -1;
      }
      render();
    },
  })));

  const header = h("div", { class: "bd-mon-head" },
    h("button", { type: "button", class: "bd-mon-art", onclick: changePokemon, "aria-label": "Change Pokémon" },
      sprite(data.sprite(set.species, set.form, set.item, { full: true }), "", 84, "bd-sprite bd-sprite-lg")),
    h("div", { class: "bd-mon-id" },
      h("button", { type: "button", class: "bd-mon-name", onclick: changePokemon }, data.displayName(battleSpecies, battleForm, set.form) || "Choose Pokémon", h("span", { "aria-hidden": "true" }, " ▾")),
      h("div", { class: "bd-type-row" }, types.map(typeChip)),
      h("label", { class: "bd-inline-field" }, h("span", {}, "Ability"), abilityField),
      h("div", { class: "bd-inline-field" }, h("span", {}, "Item"), itemCombo)));

  const hpRange = h("input", { type: "range", min: 1, max: 100, value: entry.hp, "aria-label": "Current HP percent" });
  const hpText = h("span", { class: "bd-hp-text" }, `${currentHp} / ${maxHp} HP`, h("b", {}, `${entry.hp}%`));
  hpRange.addEventListener("input", () => {
    const pct = Number(hpRange.value);
    hpText.firstChild.textContent = `${Math.max(1, Math.ceil((maxHp * pct) / 100))} / ${maxHp} HP`;
    hpText.lastChild.textContent = `${pct}%`;
  });
  hpRange.addEventListener("change", () => { entry.hp = Number(hpRange.value); render(); });
  const hp = h("div", { class: "bd-hp" }, h("div", { class: "bd-hp-head" }, h("span", {}, "Current HP"), hpText), hpRange);

  const record = data.formRecord(battleSpecies, battleForm) || data.formRecord(set.species, set.form);
  const [up, down] = data.natures[set.nature] || ["", ""];
  const left = MAX_BONUS_STAT_POINTS - bonusTotal(set.bonuses);
  const statRows = STAT_KEYS.map((key, index) => {
    const short = ["HP", "ATK", "DEF", "SPA", "SPD", "SPE"][index];
    const mark = short === up ? "up" : short === down ? "down" : "";
    const input = h("input", { type: "number", min: 0, max: MAX_BONUS_POINTS_PER_STAT, value: set.bonuses[index] || 0, inputmode: "numeric", "aria-label": `${STAT_LABELS[index]} stat points` });
    input.addEventListener("change", () => {
      const bonuses = [...set.bonuses];
      bonuses[index] = Math.max(0, Math.min(MAX_BONUS_POINTS_PER_STAT, Number(input.value) || 0));
      set.bonuses = bonuses;
      render();
    });
    const max = h("button", { type: "button", class: "bd-max", onclick: () => {
      const bonuses = [...set.bonuses];
      const room = MAX_BONUS_STAT_POINTS - bonusTotal(bonuses) + (bonuses[index] || 0);
      bonuses[index] = Math.max(0, Math.min(MAX_BONUS_POINTS_PER_STAT, room));
      set.bonuses = bonuses;
      render();
    } }, "Max");
    const stageCell = key === "hp" ? h("span", { class: "bd-stage-none" }, "—") : select(
      [6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6].map((n) => [String(n), n > 0 ? `+${n}` : String(n)]),
      String(entry.stages[STAGE_ATTRS[key]] || 0),
      (value) => { entry.stages[STAGE_ATTRS[key]] = Number(value); render(); },
      { "aria-label": `${STAT_LABELS[index]} stage`, class: "bd-select bd-stage" },
    );
    const boostedValue = boosted[key];
    const changed = boostedValue !== total[key];
    return h("tr", { class: mark },
      h("th", { scope: "row" }, STAT_LABELS[index], mark ? h("b", { class: "bd-nature-mark" }, mark === "up" ? "+" : "−") : null),
      h("td", { class: "bd-col-base" }, record?.stats?.[key] ?? "–"),
      h("td", { class: "bd-col-sp" }, h("div", { class: "bd-sp-cell" }, input, max)),
      h("td", { class: "bd-col-total" }, total[key]),
      h("td", { class: "bd-col-stage" }, stageCell),
      h("td", { class: `bd-col-boost ${changed ? (boostedValue > total[key] ? "raised" : "lowered") : ""}` }, boostedValue));
  });
  const stats = h("div", { class: "bd-stat-table-wrap" },
    h("table", { class: "bd-stat-table" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, ""), h("th", { scope: "col", class: "bd-col-base" }, "Base"), h("th", { scope: "col", class: "bd-col-sp" }, "SPs"), h("th", { scope: "col", class: "bd-col-total" }, "Total"), h("th", { scope: "col", class: "bd-col-stage" }, "Stage"), h("th", { scope: "col", class: "bd-col-boost" }, "Boost"))),
      h("tbody", {}, statRows)),
    h("p", { class: `bd-points-left ${left < 0 ? "over" : ""}` }, `Stat Points ${bonusTotal(set.bonuses)} / ${MAX_BONUS_STAT_POINTS}`, h("small", {}, left >= 0 ? ` · ${left} left` : ` · ${-left} over`)));

  const details = h("div", { class: "bd-mon-details" },
    h("label", { class: "bd-field" }, h("span", {}, "Nature"), select(NATURE_ORDER.map((name) => [name, data.natureLabel(name)]), set.nature, (value) => { set.nature = value; render(); }, { "aria-label": "Nature" })),
    h("label", { class: "bd-field" }, h("span", {}, "Form"), select(data.legalForms(set.species, set.form), set.form, (value) => {
      set.form = value;
      const legal = data.abilities(set.species, value);
      if (!legal.includes(set.ability)) set.ability = legal[0] || set.ability;
      render();
    }, { "aria-label": "Form" })),
    h("label", { class: "bd-field" }, h("span", {}, "Status"), select(STATUSES, entry.status || "Healthy", (value) => { entry.status = value === "Healthy" ? "" : value; render(); }, { "aria-label": "Status" })),
    h("label", { class: "bd-field" }, h("span", {}, "Gender"), select(GENDERS, entry.gender || "Unspecified", (value) => { entry.gender = value; render(); }, { "aria-label": "Gender" })));

  return h("section", { class: `bd-card bd-mon bd-side-${side}`, "aria-label": side === LEFT ? "Our Pokémon" : "Opposing Pokémon" },
    h("h2", { class: "bd-card-title" }, side === LEFT ? "Our Pokémon" : "Opposing Pokémon",
      h("button", { type: "button", class: "ghost-button compact", title: "Swap our and opposing Pokémon", onclick: swapSides }, "⇄ Swap")),
    header, moves, hp, stats, details, renderImport(side));
}

/** Every team the Team Builder has saved, read through the store (which
 *  repairs a document written by an older version or by the Companion). */
function savedTeams() {
  return (getState().teams || []).filter((team) => team && team.id);
}

/** The team the import row is showing. The calculator remembers its own pick,
 *  so choosing a team here does not move the Team Builder's selection; with no
 *  pick (or after that team is deleted) it follows the selected team. */
function importSource() {
  const teams = savedTeams();
  return teams.find((team) => team.id === model.state.importTeamId) || currentTeam() || teams[0] || null;
}

function renderImport(side) {
  const teams = savedTeams();
  const team = importSource();
  // A team saved elsewhere can name a Pokemon this site's tables do not hold;
  // such a slot gets no chip rather than a chip that loads nothing.
  const sets = teamSets(team, data).filter((set) => set.species && data.speciesEntry(set.species));
  const meta = data.meta[model.state.format]?.pokemon || [];
  const chip = (set, label) => h("button", {
    type: "button",
    class: "bd-import-chip",
    title: `Load ${label}`,
    onclick: () => {
      model.state.mons[side].set = JSON.parse(JSON.stringify(set));
      resetMonState(side);
      render();
    },
  }, sprite(data.sprite(set.species, set.form, set.item), label, 36));
  const teamRow = sets.length
    ? sets.map((set) => chip(set, data.displayName(set.species, set.form)))
    : [h("a", { class: "bd-import-empty", href: "/team-builder/" }, teams.length > 1 ? "This team is empty. Fill it in the Team Builder" : "Build a team to import it here")];
  const metaRow = meta.slice(0, META_IMPORT_CHIPS).map((row) => {
    const set = setFromCommon(data.commonSet(model.state.format, row.species, row.form));
    return chip(set, `${row.name} (most common set)`);
  });
  // The picker sits next to the label so any saved team can be imported, not
  // only the one the Team Builder happens to have open.
  const picker = teams.length
    ? select(teams.map((entry) => [entry.id, entry.title || "Team"]), team?.id || "", (value) => {
      model.state.importTeamId = value;
      render();
    }, { class: "bd-select bd-import-team", "aria-label": `Team to import from, ${side === LEFT ? "our" : "opposing"} Pokémon` })
    : null;
  return h("div", { class: "bd-import" },
    h("div", { class: "bd-import-row" },
      h("div", { class: "bd-import-head" }, h("span", { class: "bd-field-label" }, "Import from"), picker),
      h("div", { class: "bd-import-chips" }, teamRow)),
    h("div", { class: "bd-import-row" },
      h("div", { class: "bd-import-head" }, h("span", { class: "bd-field-label" }, `Top ${model.state.format} meta`)),
      h("div", { class: "bd-import-chips bd-import-meta" }, metaRow)));
}

function renderField() {
  const state = model.state;
  const weather = model.effectiveWeather();
  const terrain = model.effectiveTerrain();
  const buttons = (values, current, onPick, label) => h("div", { class: "bd-segment", role: "group", "aria-label": label },
    values.map((value) => h("button", {
      type: "button",
      class: value === current ? "on" : "",
      "aria-pressed": value === current ? "true" : "false",
      onclick: () => onPick(value),
    }, value)));
  const sideToggles = (side) => {
    const field = state.field[side];
    const toggle = (key) => h("button", {
      type: "button",
      class: `bd-toggle ${field[key] ? "on" : ""}`,
      "aria-pressed": field[key] ? "true" : "false",
      onclick: () => { field[key] = !field[key]; render(); },
    }, FIELD_LABELS[key]);
    // Helping Hand and Friend Guard come from a partner, which Singles does not have
    // (the calculation ignores them there), so Singles does not offer them.
    const doubles = state.format === "Doubles";
    return h("div", { class: "bd-side-toggles" },
      h("h3", {}, side === LEFT ? "Our side" : "Opposing side"),
      toggle("protect"), doubles ? toggle("helping_hand") : null, toggle("aurora_veil"),
      h("div", { class: "bd-toggle-pair" }, toggle("reflect"), toggle("light_screen")),
      toggle("tailwind"), doubles ? toggle("friend_guard") : null, toggle("stealth_rock"),
      h("div", { class: "bd-segment bd-spikes", role: "group", "aria-label": "Spikes layers" },
        [0, 1, 2, 3].map((n) => h("button", {
          type: "button",
          class: Number(field.spikes || 0) === n ? "on" : "",
          "aria-pressed": Number(field.spikes || 0) === n ? "true" : "false",
          onclick: () => { field.spikes = n; render(); },
        }, n === 3 ? "3 Spikes" : String(n)))),
      toggle("salt_cure"));
  };
  return h("section", { class: "bd-card bd-field-panel", "aria-label": "Field" },
    h("h2", { class: "bd-card-title" }, "Field"),
    h("div", { class: "bd-field-settings" },
      h("span", { class: "bd-field-label" }, "Weather", state.weatherMode === "Auto" ? h("small", {}, " · auto from abilities") : h("button", { type: "button", class: "bd-link", onclick: () => { state.weatherMode = "Auto"; state.weather = "None"; render(); } }, " · back to auto")),
      buttons(["None", "Sun", "Rain", "Sand", "Snow"], weather, (value) => { state.weather = value; state.weatherMode = "Manual"; render(); }, "Weather"),
      h("span", { class: "bd-field-label" }, "Terrain"),
      buttons(["None", "Electric", "Grassy", "Psychic", "Misty"], state.terrain !== "None" ? state.terrain : terrain === "None" ? "None" : terrain, (value) => { state.terrain = value; render(); }, "Terrain"),
      h("span", { class: "bd-field-label" }, "Format"),
      buttons(["Singles", "Doubles"], state.format, (value) => setFormat(value), "Battle format")),
    h("div", { class: "bd-field-sides" }, sideToggles(LEFT), sideToggles(RIGHT)));
}

// --- actions ------------------------------------------------------------------------

function resetMonState(side) {
  const fresh = defaultMonState(model.state.mons[side].set);
  model.state.mons[side] = fresh;
  for (const key of Object.keys(model.state.effectOverrides)) if (key.startsWith(`${side}:`)) delete model.state.effectOverrides[key];
  model.clearSideValues(side);
  if (model.state.selectedSide === side) {
    model.state.selectedSide = "";
    model.state.selectedIndex = -1;
    model.state.critical = false;
  }
}

function selectMove(side, index) {
  const state = model.state;
  if (state.selectedSide === side && state.selectedIndex === index) {
    state.selectedSide = "";
    state.selectedIndex = -1;
    state.critical = false;
  } else {
    state.selectedSide = side;
    state.selectedIndex = index;
    state.critical = false;
  }
  render();
}

function toggleCrit(side, index) {
  const state = model.state;
  const wasOn = state.selectedSide === side && state.selectedIndex === index && state.critical;
  state.selectedSide = side;
  state.selectedIndex = index;
  state.critical = !wasOn;
  render();
}

function swapSides() {
  const state = model.state;
  [state.mons[LEFT], state.mons[RIGHT]] = [state.mons[RIGHT], state.mons[LEFT]];
  [state.field[LEFT], state.field[RIGHT]] = [state.field[RIGHT], state.field[LEFT]];
  state.effectOverrides = Object.fromEntries(Object.entries(state.effectOverrides).map(([key, value]) => [key.replace(/^left:/, "tmp:").replace(/^right:/, "left:").replace(/^tmp:/, "right:"), value]));
  state.effectValues = Object.fromEntries(Object.entries(state.effectValues).map(([key, value]) => [key.replace(/^left:/, "tmp:").replace(/^right:/, "left:").replace(/^tmp:/, "right:"), value]));
  if (state.selectedSide) state.selectedSide = other(state.selectedSide);
  render();
}

async function setFormat(format) {
  // Singles has one ally fewer, so a chosen "3 fainted allies" comes down to 2.
  model.setFormat(format);
  await data.loadMeta(format);
  render();
}

function syncFormatSwitch() {
  document.querySelectorAll("[data-format]").forEach((button) => {
    const active = button.dataset.format === model.state.format;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

async function main() {
  try {
    data = await BuilderData.load();
    const saved = load();
    const format = formatQuery() || saved?.format || getState().format || "Doubles";
    await data.loadMeta(format);
    const state = saved && !new URLSearchParams(location.search).has("attacker") ? saved : defaultCalcState();
    state.format = format;
    model = new CalcModel(data, state);
    model.normalizeEffectValues();
    if (!saved || new URLSearchParams(location.search).has("attacker")) {
      const [a, b] = await initialSets(format);
      state.mons[LEFT] = defaultMonState(a);
      state.mons[RIGHT] = defaultMonState(b);
    }
    document.querySelectorAll("[data-format]").forEach((button) => button.addEventListener("click", () => setFormat(button.dataset.format)));
    subscribe((_state, reason) => { if (reason === "team" || reason === "external" || reason === "sync") render(); });
    render();
  } catch (error) {
    console.error(error);
    clear(root).append(h("div", { class: "bd-card bd-error" }, h("h2", {}, "The calculator could not load its data."), h("p", {}, "Reload the page. If it keeps happening, tell us on Discord."), h("code", {}, String(error.message || error))));
    toast("Could not load the calculator data", "error");
  }
}

main();
