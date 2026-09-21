// Small DOM toolkit shared by the builder pages: element builder, dialogs,
// searchable pickers and the Pokemon set editor.

import { NATURE_ORDER, STAT_LABELS, bonusTotal, escapeHtml, makeSet, setFromCommon, typeIcon } from "./common.js";
import { MAX_BONUS_POINTS_PER_STAT, MAX_BONUS_STAT_POINTS, compact } from "./engine.js";

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "html") node.innerHTML = value;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function typeChip(type) {
  return h("span", { class: `bd-type bd-type-${String(type).toLowerCase()}` },
    h("img", { src: typeIcon(type), alt: "", width: 14, height: 14, loading: "lazy", decoding: "async" }), type);
}

export function sprite(src, alt = "", size = 40, className = "bd-sprite") {
  return h("img", { class: className, src: src || "/favicon.svg", alt, width: size, height: size, loading: "lazy", decoding: "async" });
}

export function toast(message, tone = "info") {
  let host = document.querySelector(".bd-toasts");
  if (!host) {
    host = h("div", { class: "bd-toasts", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  const item = h("div", { class: `bd-toast bd-toast-${tone}` }, message);
  host.append(item);
  setTimeout(() => item.classList.add("leaving"), 3200);
  setTimeout(() => item.remove(), 3600);
}

// --- dialogs -----------------------------------------------------------------

let openCount = 0;

export function openDialog({ title = "", body, actions = [], wide = false, className = "", onClose } = {}) {
  const dialog = h("dialog", { class: `bd-dialog ${wide ? "bd-dialog-wide" : ""} ${className}`, "aria-label": title || "Dialog" });
  const close = () => {
    if (!dialog.open) return;
    dialog.close();
  };
  const header = h("header", { class: "bd-dialog-head" },
    h("h2", {}, title),
    h("button", { class: "bd-icon-button", type: "button", "aria-label": "Close", onclick: close }, "×"));
  const content = h("div", { class: "bd-dialog-body" });
  if (body) content.append(body);
  const footer = actions.length ? h("footer", { class: "bd-dialog-foot" }, actions) : null;
  dialog.append(header, content);
  if (footer) dialog.append(footer);
  dialog.addEventListener("close", () => {
    openCount = Math.max(0, openCount - 1);
    if (!openCount) document.body.classList.remove("bd-modal-open");
    dialog.remove();
    onClose?.();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  document.body.append(dialog);
  openCount += 1;
  document.body.classList.add("bd-modal-open");
  dialog.showModal();
  return { dialog, body: content, close };
}

export function confirmDialog(message, { confirmLabel = "Confirm", tone = "danger" } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const { close } = openDialog({
      title: "Please confirm",
      body: h("p", { class: "bd-confirm-text" }, message),
      actions: [
        h("button", { class: "ghost-button", type: "button", onclick: () => close() }, "Cancel"),
        h("button", { class: `primary-button ${tone === "danger" ? "bd-danger" : ""}`, type: "button", onclick: () => { answered = true; resolve(true); close(); } }, confirmLabel),
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

// --- searchable combo ----------------------------------------------------------

/**
 * A text input with a filtered option list, for lists too long for a <select>
 * (items, moves).  Options: [{ value, label, icon?, hint?, badge? }].
 */
export function searchSelect({ options, value = "", placeholder = "Search…", onChange, allowEmpty = true, label = "", className = "" }) {
  const wrapper = h("div", { class: `bd-combo ${className}` });
  const input = h("input", { type: "text", class: "bd-combo-input", placeholder, value: value || "", autocomplete: "off", spellcheck: "false", "aria-label": label || placeholder, role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list" });
  const list = h("div", { class: "bd-combo-list", role: "listbox", hidden: true });
  const icon = h("img", { class: "bd-combo-icon", alt: "", width: 18, height: 18, hidden: true });
  let current = value || "";
  let active = -1;
  let shown = [];

  const setIcon = () => {
    const option = options.find((o) => o.value === current);
    if (option?.icon) {
      icon.src = option.icon;
      icon.hidden = false;
      wrapper.classList.add("has-icon");
    } else {
      icon.hidden = true;
      wrapper.classList.remove("has-icon");
    }
  };
  const render = () => {
    const q = compact(input.value === current ? "" : input.value);
    shown = options.filter((o) => !q || compact(o.label).includes(q) || compact(o.hint || "").includes(q)).slice(0, 80);
    if (allowEmpty) shown.unshift({ value: "", label: "(none)" });
    clear(list);
    shown.forEach((option, index) => {
      const row = h("button", {
        type: "button",
        class: `bd-combo-option ${option.value === current ? "selected" : ""} ${index === active ? "active" : ""}`,
        role: "option",
        "aria-selected": option.value === current ? "true" : "false",
        onmousedown: (event) => event.preventDefault(),
        onclick: () => pick(option.value),
      },
      option.icon ? h("img", { src: option.icon, alt: "", width: 20, height: 20, loading: "lazy" }) : h("span", { class: "bd-combo-noicon" }),
      h("span", { class: "bd-combo-label" }, option.label),
      option.badge ? h("span", { class: "bd-combo-badge" }, option.badge) : null,
      option.hint ? h("span", { class: "bd-combo-hint" }, option.hint) : null);
      list.append(row);
    });
  };
  const open = () => {
    active = -1;
    render();
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.select();
  };
  const closeList = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.value = options.find((o) => o.value === current)?.label ?? current;
  };
  const pick = (next) => {
    current = next;
    input.value = options.find((o) => o.value === current)?.label ?? current;
    setIcon();
    closeList();
    onChange?.(current);
  };
  input.addEventListener("focus", open);
  input.addEventListener("input", () => { active = 0; render(); list.hidden = false; });
  input.addEventListener("blur", () => setTimeout(closeList, 120));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) open();
      active = Math.max(0, Math.min(shown.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
      render();
      list.children[active]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = shown[Math.max(0, active)];
      if (option) pick(option.value);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      closeList();
      input.blur();
    }
  });
  wrapper.append(icon, input, list);
  input.value = options.find((o) => o.value === current)?.label ?? current;
  setIcon();
  wrapper.setValue = (next) => {
    current = next || "";
    input.value = options.find((o) => o.value === current)?.label ?? current;
    setIcon();
  };
  wrapper.getValue = () => current;
  return wrapper;
}

export function select(options, value, onChange, attrs = {}) {
  const node = h("select", { class: "bd-select", ...attrs, onchange: (event) => onChange?.(event.target.value) },
    options.map((option) => {
      const [optValue, optLabel] = Array.isArray(option) ? option : [option, option];
      return h("option", { value: optValue, selected: optValue === value }, optLabel);
    }));
  return node;
}

// --- Pokemon picker ---------------------------------------------------------------

export function pickPokemon(data, { format = "Doubles", title = "Choose a Pokémon", initial = "" } = {}) {
  return new Promise((resolve) => {
    let chosen = null;
    const input = h("input", { type: "search", class: "bd-search", placeholder: "Search by name or type…", value: initial, autocomplete: "off", "aria-label": "Search Pokémon" });
    const list = h("div", { class: "bd-pick-list", role: "listbox" });
    const render = () => {
      clear(list);
      const rows = data.searchSpecies(input.value, { format, limit: 120 });
      if (!rows.length) list.append(h("p", { class: "bd-empty" }, "No Pokémon matched."));
      for (const row of rows) {
        list.append(h("button", {
          type: "button",
          class: "bd-pick-row",
          onclick: () => { chosen = row; close(); },
        },
        sprite(`/${row.mini.split("/").map(encodeURIComponent).join("/")}`, "", 40),
        h("span", { class: "bd-pick-name" }, row.form, row.position < 9999 ? h("small", {}, `#${row.position} ${format}`) : null),
        h("span", { class: "bd-pick-types" }, (row.types || []).map(typeChip))));
      }
    };
    input.addEventListener("input", render);
    const body = h("div", { class: "bd-pick" }, input, list);
    const { close } = openDialog({ title, body, className: "bd-dialog-picker", onClose: () => resolve(chosen) });
    render();
    setTimeout(() => input.focus(), 30);
  });
}

// --- set editor -------------------------------------------------------------------

/**
 * Edit one set (species, form, item, ability, moves, nature, stat points).
 * Resolves with the new set, `null` for "remove", or `undefined` when cancelled.
 */
export function editSet(data, initialSet, { format = "Doubles", title = "Edit Pokémon", allowRemove = true, removeLabel = "Remove" } = {}) {
  return new Promise((resolve) => {
    let result;
    let set = makeSet(JSON.parse(JSON.stringify(initialSet || {})));
    const body = h("div", { class: "bd-editor" });
    const footerSave = h("button", { class: "primary-button", type: "button", onclick: () => { result = set; close(); } }, "Save");
    const actions = [
      allowRemove && initialSet?.species ? h("button", { class: "ghost-button bd-danger-text", type: "button", onclick: () => { result = null; close(); } }, removeLabel) : null,
      h("span", { class: "bd-spacer" }),
      h("button", { class: "ghost-button", type: "button", onclick: () => close() }, "Cancel"),
      footerSave,
    ].filter(Boolean);
    const { close } = openDialog({ title, body, actions, wide: true, className: "bd-dialog-editor", onClose: () => resolve(result) });

    const applySpecies = (species, form) => {
      const common = data.commonSet(format, species, form);
      set = setFromCommon(common);
      if (!set.ability) set.ability = data.abilities(species, form)[0] || "";
      render();
    };

    const render = () => {
      clear(body);
      footerSave.disabled = !set.species;
      if (!set.species) {
        body.append(h("div", { class: "bd-editor-empty" },
          h("p", {}, "Pick a Pokémon to start. Its most common ranked set is filled in for you."),
          h("button", { class: "primary-button", type: "button", onclick: async () => {
            const row = await pickPokemon(data, { format });
            if (row) applySpecies(row.species, row.form);
          } }, "Choose Pokémon")));
        return;
      }
      const types = data.types(set.species, set.form, set.item);
      const [, battleForm, forcedAbility] = data.battleForm(set.species, set.form, set.item);
      const head = h("div", { class: "bd-editor-head" },
        sprite(data.sprite(set.species, set.form, set.item, { full: true }), "", 96, "bd-sprite bd-sprite-lg"),
        h("div", { class: "bd-editor-title" },
          h("h3", {}, data.displayName(set.species, battleForm)),
          h("div", { class: "bd-type-row" }, types.map(typeChip)),
          h("div", { class: "bd-editor-head-actions" },
            h("button", { class: "ghost-button compact", type: "button", onclick: async () => {
              const row = await pickPokemon(data, { format, title: "Change Pokémon" });
              if (row) applySpecies(row.species, row.form);
            } }, "Change Pokémon"),
            h("button", { class: "ghost-button compact", type: "button", title: "Most common ranked set for this Pokémon", onclick: () => applySpecies(set.species, set.form) }, "Most common set"))));

      const forms = data.legalForms(set.species);
      const formSelect = select(forms, set.form, (value) => {
        set.form = value;
        const legal = data.abilities(set.species, value);
        if (!legal.includes(set.ability)) set.ability = legal[0] || set.ability;
        render();
      }, { "aria-label": "Form" });

      const abilities = data.abilities(set.species, set.form);
      const abilityOptions = [...new Set([...abilities, set.ability].filter(Boolean))];
      const abilitySelect = select(abilityOptions, set.ability, (value) => { set.ability = value; }, { "aria-label": "Ability", disabled: Boolean(forcedAbility && battleForm !== set.form) });

      const usage = data.usage(format, set.species, set.form);
      const itemUsage = new Map((usage?.items || []).map(([name, pct]) => [compact(name), pct]));
      const itemOptions = data.itemNames.map((name) => ({ value: name, label: name, icon: data.itemIcon(name), badge: itemUsage.has(compact(name)) ? `${itemUsage.get(compact(name))}%` : "" }))
        .sort((a, b) => (itemUsage.get(compact(b.value)) || 0) - (itemUsage.get(compact(a.value)) || 0));
      const itemCombo = searchSelect({ options: itemOptions, value: set.item, placeholder: "Held item", label: "Held item", onChange: (value) => { set.item = value; render(); } });

      const learnset = data.learnset(set.species, set.form);
      const moveUsage = new Map((usage?.moves || []).map(([name, pct]) => [compact(name), pct]));
      const pool = [...new Set([...learnset, ...(set.moves || [])])];
      const moveOptions = pool.map((name) => {
        const meta = data.move(name) || {};
        const power = Number(meta.power) > 0 ? `${meta.power} BP` : "";
        return {
          value: name,
          label: name,
          icon: meta.type ? typeIcon(meta.type) : "",
          hint: [meta.category ? meta.category[0].toUpperCase() + meta.category.slice(1) : "", power].filter(Boolean).join(" · "),
          badge: moveUsage.has(compact(name)) ? `${moveUsage.get(compact(name))}%` : "",
        };
      }).sort((a, b) => (moveUsage.get(compact(b.value)) || 0) - (moveUsage.get(compact(a.value)) || 0) || a.label.localeCompare(b.label));
      const moveCombos = [0, 1, 2, 3].map((index) => searchSelect({
        options: moveOptions,
        value: set.moves[index] || "",
        placeholder: `Move ${index + 1}`,
        label: `Move ${index + 1}`,
        onChange: (value) => {
          const moves = [...set.moves];
          moves[index] = value;
          set.moves = moves.filter((move, i) => move && moves.indexOf(move) === i);
        },
      }));

      const natureSelect = select(NATURE_ORDER.map((name) => [name, data.natureLabel(name)]), set.nature, (value) => { set.nature = value; renderStats(); }, { "aria-label": "Nature" });

      const statsHost = h("div", { class: "bd-editor-stats" });
      const renderStats = () => {
        clear(statsHost);
        const total = bonusTotal(set.bonuses);
        const stats = data.engine.finalStats({ pokemon_name: set.species, form_name: set.form, item: set.item, nature_name: set.nature, bonuses: set.bonuses, ability: set.ability });
        const record = data.formRecord(...data.battleForm(set.species, set.form, set.item)) || data.formRecord(set.species, set.form);
        const left = MAX_BONUS_STAT_POINTS - total;
        statsHost.append(h("div", { class: `bd-points-left ${left < 0 ? "over" : ""}` }, `Stat Points: ${total} / ${MAX_BONUS_STAT_POINTS}`, h("small", {}, left >= 0 ? `${left} left` : `${-left} over`)));
        STAT_LABELS.forEach((label, index) => {
          const key = ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"][index];
          const [up, down] = data.natures[set.nature] || ["", ""];
          const short = ["HP", "ATK", "DEF", "SPA", "SPD", "SPE"][index];
          const mark = short === up ? "up" : short === down ? "down" : "";
          const input = h("input", { type: "number", min: 0, max: MAX_BONUS_POINTS_PER_STAT, value: set.bonuses[index] || 0, inputmode: "numeric", "aria-label": `${label} stat points` });
          const range = h("input", { type: "range", min: 0, max: MAX_BONUS_POINTS_PER_STAT, value: set.bonuses[index] || 0, "aria-label": `${label} stat points slider` });
          const apply = (raw) => {
            const bonuses = [...set.bonuses];
            bonuses[index] = Math.max(0, Math.min(MAX_BONUS_POINTS_PER_STAT, Number(raw) || 0));
            set.bonuses = bonuses;
            renderStats();
          };
          input.addEventListener("change", () => apply(input.value));
          range.addEventListener("input", () => { input.value = range.value; });
          range.addEventListener("change", () => apply(range.value));
          statsHost.append(h("div", { class: `bd-stat-edit ${mark}` },
            h("span", { class: "bd-stat-name" }, label, mark ? h("b", { "aria-label": mark === "up" ? "raised by nature" : "lowered by nature" }, mark === "up" ? "+" : "−") : null),
            h("span", { class: "bd-stat-base" }, record?.stats?.[key] ?? "–"),
            range,
            input,
            h("span", { class: "bd-stat-total" }, stats[key])));
        });
      };
      renderStats();

      body.append(head,
        h("div", { class: "bd-editor-grid" },
          h("label", { class: "bd-field" }, h("span", {}, "Form"), formSelect),
          h("label", { class: "bd-field" }, h("span", {}, "Ability"), abilitySelect,
            forcedAbility && battleForm !== set.form ? h("small", { class: "bd-note" }, `${battleForm} battles with ${forcedAbility}.`) : null),
          h("div", { class: "bd-field" }, h("span", {}, "Held item"), itemCombo),
          h("label", { class: "bd-field" }, h("span", {}, "Nature"), natureSelect)),
        h("div", { class: "bd-editor-moves" }, h("span", { class: "bd-field-label" }, "Moves"), h("div", { class: "bd-move-grid" }, moveCombos)),
        h("div", { class: "bd-field-label" }, "Stat Points"),
        statsHost);
    };
    render();
    if (!set.species) setTimeout(async () => {
      const row = await pickPokemon(data, { format });
      if (row) applySpecies(row.species, row.form);
    }, 0);
  });
}

export function formatPercent(value, digits = 0) {
  return `${Number(value || 0).toFixed(digits)}%`;
}

export function scoreTone(score) {
  if (score >= 70) return "good";
  if (score >= 50) return "mid";
  return "bad";
}

export function scoreRing(score, label = "") {
  const value = Math.max(0, Math.min(100, Math.round(score || 0)));
  const ring = h("span", { class: `bd-ring bd-ring-${scoreTone(value)}`, style: { "--value": value }, role: "img", "aria-label": `${label ? `${label} ` : ""}${value} out of 100` }, h("b", {}, value));
  return ring;
}

export { escapeHtml };

// --- form controls -------------------------------------------------------------

/** An on/off switch: a real checkbox, drawn as a sliding toggle. */
export function switchControl(checked, onChange, attrs = {}) {
  const input = h("input", { type: "checkbox", role: "switch", checked: Boolean(checked), ...attrs });
  input.addEventListener("change", () => onChange?.(input.checked));
  return h("span", { class: "bd-switch" }, input, h("span", { class: "bd-switch-track", "aria-hidden": "true" }));
}

/** A labelled switch row: the whole row toggles. */
export function switchRow(label, checked, onChange, { hint = "", disabled = false } = {}) {
  return h("label", { class: `bd-switch-row ${disabled ? "disabled" : ""}`, title: hint || null },
    switchControl(checked, onChange, { disabled }),
    h("span", {}, label));
}

/** Mutually exclusive buttons in one bar. `options` are values or [value, label] pairs. */
export function segmented(options, value, onChange, attrs = {}) {
  const group = h("div", { class: "bd-seg", role: "radiogroup", ...attrs });
  const buttons = options.map((option) => {
    const [optValue, optLabel] = Array.isArray(option) ? option : [option, option];
    const button = h("button", {
      type: "button",
      role: "radio",
      class: optValue === value ? "on" : "",
      "aria-checked": optValue === value ? "true" : "false",
      onclick: () => {
        for (const other of buttons) {
          other.classList.remove("on");
          other.setAttribute("aria-checked", "false");
        }
        button.classList.add("on");
        button.setAttribute("aria-checked", "true");
        onChange?.(optValue);
      },
    }, optLabel);
    return button;
  });
  group.append(...buttons);
  return group;
}

/** A whole-number field with − and + buttons, kept inside [min, max]. */
export function stepper(value, { min = 0, max = 100, step = 1, onChange, label = "" } = {}) {
  const clamp = (v) => Math.max(min, Math.min(max, Number.isFinite(v) ? Math.round(v) : min));
  const input = h("input", { type: "number", class: "bd-stepper-input", min, max, step, value: clamp(Number(value)), "aria-label": label, inputmode: "numeric" });
  const set = (v) => {
    input.value = String(clamp(v));
    onChange?.(Number(input.value));
  };
  input.addEventListener("change", () => set(Number.parseInt(input.value, 10)));
  return h("span", { class: "bd-stepper" },
    h("button", { type: "button", "aria-label": `Lower ${label}`, onclick: () => set(Number(input.value) - step) }, "−"),
    input,
    h("button", { type: "button", "aria-label": `Raise ${label}`, onclick: () => set(Number(input.value) + step) }, "+"));
}

/** An inline problem report with a way forward, instead of a panel that just stays empty. */
export function problemCard(title, message, { actionLabel = "Try again", onAction } = {}) {
  return h("div", { class: "bd-problem", role: "alert" },
    h("h3", {}, title),
    message ? h("p", {}, message) : null,
    onAction ? h("button", { type: "button", class: "ghost-button compact", onclick: onAction }, actionLabel) : null);
}
