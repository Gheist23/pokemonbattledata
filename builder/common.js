// Shared data layer for the Damage Calculator and Team Builder pages.
//
// Loads the app-exported tables (data/builder/app-data.json) and the daily meta
// files, and answers the questions both pages ask: what is this Pokemon called,
// which sprite does it use, what can it learn, what is its most common set.
// Team entries use the Companion's own shape so a synced team round-trips
// unchanged:  [pokemon, item, form, ability, [moves]]  plus a spread
// { name, nature_name, nature: [up, down], bonuses: [6] }.

import { DamageEngine, compact, makeMon, normalizeBonuses, STAT_KEYS } from "./engine.js";

export const FORMATS = ["Doubles", "Singles"];
export const TYPES = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy"];
export const STAT_LABELS = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];
export const STAT_NAMES = STAT_KEYS.map(([, key]) => key);
export const NATURE_ORDER = [
  "Hardy", "Lonely", "Brave", "Adamant", "Naughty", "Bold", "Docile", "Relaxed", "Impish", "Lax",
  "Timid", "Hasty", "Serious", "Jolly", "Naive", "Modest", "Mild", "Quiet", "Bashful", "Rash",
  "Calm", "Gentle", "Sassy", "Careful", "Quirky",
];
export const TEAM_SIZE = 6;
export const EMPTY_ENTRY = () => ["", "", "", "", []];

const cache = new Map();

async function fetchJson(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url, { cache: "no-cache" }).then((response) => {
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return response.json();
    }).catch((error) => {
      cache.delete(url);
      throw error;
    }));
  }
  return cache.get(url);
}

export function assetUrl(path) {
  if (!path) return "";
  return `/${String(path).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")}`;
}

export function typeIcon(type) {
  return assetUrl(`pokemon_champions_assets/types/${type}.png`);
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

/** Everything the pages need from the exported tables, indexed once. */
export class BuilderData {
  static async load() {
    const appData = await fetchJson("/data/builder/app-data.json");
    return new BuilderData(appData);
  }

  constructor(appData) {
    this.app = appData;
    this.engine = new DamageEngine(appData);
    this.species = appData.species || [];
    this.forms = [];
    for (const entry of this.species) {
      for (const form of entry.forms) this.forms.push({ species: entry.name, ...form });
    }
    this.itemNames = (appData.items || []).map((item) => item.name).sort((a, b) => a.localeCompare(b));
    this.itemSprite = new Map((appData.items || []).map((item) => [compact(item.name), item.sprite]));
    this.moveNames = Object.keys(appData.moves || {}).sort((a, b) => a.localeCompare(b));
    this.natures = appData.natures || {};
    this.meta = {};
    this.metaByUsage = {};
  }

  async loadMeta(format) {
    const key = format === "Singles" ? "singles" : "doubles";
    if (!this.meta[format]) {
      const payload = await fetchJson(`/data/builder/meta-${key}.json`);
      this.meta[format] = payload;
      this.metaByUsage[format] = new Map(payload.pokemon.map((row) => [compact(row.name), row]));
    }
    return this.meta[format];
  }

  /** (species, form) in the app's spelling for any name (Showdown, app, legacy). */
  resolve(pokemon, form = "") {
    return this.engine.resolve(pokemon, form);
  }

  formRecord(species, form) {
    return this.engine.formRecord(species, form);
  }

  speciesEntry(species) {
    return this.engine.speciesEntry(species);
  }

  /** What the Companion shows: the form's own name ("Mega Charizard Y", "Alolan Ninetales"). */
  displayName(species, form) {
    const record = this.formRecord(species, form);
    return record?.form || form || species || "";
  }

  /** The form a set actually battles as (a matching Mega Stone decides). */
  battleForm(species, form, item) {
    const mon = this.engine.effectiveMegaMon(makeMon({ pokemon_name: species, form_name: form || species, item: item || "" }));
    return [mon.pokemon_name, mon.form_name, mon.ability];
  }

  sprite(species, form, item = "", { full = false } = {}) {
    const [battleSpecies, battleForm] = this.battleForm(species, form, item);
    const record = this.formRecord(battleSpecies, battleForm) || this.formRecord(species, form);
    if (!record) return "";
    return assetUrl(full ? record.sprite : record.mini || record.sprite);
  }

  itemIcon(item) {
    const path = this.itemSprite.get(compact(item));
    return path ? assetUrl(path) : "";
  }

  types(species, form, item = "") {
    const [s, f] = this.battleForm(species, form, item);
    return (this.formRecord(s, f) || this.formRecord(species, form))?.types || [];
  }

  abilities(species, form) {
    return this.formRecord(species, form)?.abilities || [];
  }

  legalForms(species) {
    return (this.speciesEntry(species)?.forms || []).map((form) => form.form);
  }

  learnset(species, form) {
    const sets = this.app.learnsets || {};
    const [s, f] = this.resolve(species, form);
    const direct = sets[`${s}|${f}`];
    if (direct && direct.length) return direct;
    const entry = this.speciesEntry(s);
    for (const candidate of entry?.forms || []) {
      const list = sets[`${s}|${candidate.form}`];
      if (list && list.length) return list;
    }
    return [];
  }

  move(name) {
    return this.engine.moveRecord(name);
  }

  isMegaStone(item) {
    return this.engine.isMegaStone(item);
  }

  /** Stones that turn this species into one of its Mega forms. */
  megaStonesFor(species) {
    const out = [];
    for (const [stone, holders] of Object.entries(this.app.megaStones || {})) {
      if (holders.some((holder) => compact(holder.species) === compact(species))) out.push(stone);
    }
    return out;
  }

  /** The usage record (moves/items/abilities/teammates/spreads) for a form. */
  usage(format, species, form) {
    const index = this.metaByUsage[format];
    if (!index) return null;
    const record = this.formRecord(species, form);
    if (record?.usage && index.has(compact(record.usage))) return index.get(compact(record.usage));
    const entry = this.speciesEntry(species);
    for (const candidate of entry?.forms || []) {
      if (candidate.usage && index.has(compact(candidate.usage))) return index.get(compact(candidate.usage));
    }
    return index.get(compact(species)) || null;
  }

  /** PokemonBattleApiClient.common_set — top moves/item/ability/nature/spread. */
  commonSet(format, species, form) {
    const usage = this.usage(format, species, form);
    const [s, f] = this.resolve(species, form);
    if (!usage) {
      const abilities = this.abilities(s, f);
      return { species: s, form: f, item: "", ability: abilities[0] || "", nature: "Serious", bonuses: [0, 0, 0, 0, 0, 0], moves: this.learnset(s, f).slice(0, 0) };
    }
    return {
      species: s,
      form: f,
      item: usage.set.item || "",
      ability: usage.set.ability || this.abilities(s, f)[0] || "",
      nature: usage.set.nature || "Serious",
      bonuses: normalizeBonuses(usage.set.bonuses),
      moves: [...usage.set.moves],
    };
  }

  natureLabel(name) {
    const [up, down] = this.natures[name] || ["", ""];
    return up && down ? `${name} (+${up}/-${down})` : `${name} (Neutral)`;
  }

  searchSpecies(query, { limit = 60, format = "Doubles" } = {}) {
    const q = compact(query);
    const index = this.metaByUsage[format];
    const scored = [];
    for (const form of this.forms) {
      const name = form.form;
      const key = compact(name);
      const speciesKey = compact(form.species);
      let score;
      if (!q) score = 0;
      else if (key === q || speciesKey === q) score = 3;
      else if (key.startsWith(q) || speciesKey.startsWith(q)) score = 2;
      else if (key.includes(q) || (form.types || []).some((t) => compact(t) === q)) score = 1;
      else continue;
      const usage = form.usage && index ? index.get(compact(form.usage)) : null;
      const position = usage && !form.mega ? usage.position : 9999;
      scored.push({ ...form, score, position });
    }
    scored.sort((a, b) => b.score - a.score || a.position - b.position || a.form.localeCompare(b.form));
    return scored.slice(0, limit);
  }
}

// --- sets and team entries ---------------------------------------------------

/**
 * A "set" is the page-side view of one Pokemon: the app's entry fields plus
 * its spread.  setToEntry / entryToSet convert to and from the Companion's
 * storage shape.
 */
export function makeSet(fields = {}) {
  return {
    species: "",
    form: "",
    item: "",
    ability: "",
    moves: [],
    nature: "Serious",
    bonuses: [0, 0, 0, 0, 0, 0],
    ...fields,
  };
}

export function isEmptySet(set) {
  return !set || !set.species;
}

export function spreadFromSet(set, data) {
  const nature = set.nature || "Serious";
  const [up, down] = data?.natures?.[nature] || ["", ""];
  return { name: nature, nature_name: nature, nature: [up, down], bonuses: normalizeBonuses(set.bonuses) };
}

export function setToEntry(set) {
  if (isEmptySet(set)) return EMPTY_ENTRY();
  return [set.species, set.item || "", set.form || set.species, set.ability || "", (set.moves || []).filter(Boolean).slice(0, 4)];
}

export function entryToSet(entry, spread, data) {
  if (!Array.isArray(entry) || !entry[0]) return makeSet();
  const [pokemon, item, form, ability, moves] = entry;
  const [species, resolvedForm] = data ? data.resolve(pokemon, form || pokemon) : [pokemon, form || pokemon];
  return makeSet({
    species,
    form: resolvedForm,
    item: item || "",
    ability: ability || "",
    moves: Array.isArray(moves) ? moves.filter(Boolean).slice(0, 4) : [],
    nature: spread?.nature_name || spread?.name || "Serious",
    bonuses: normalizeBonuses(spread?.bonuses),
  });
}

export function boxEntryToSet(entry, data) {
  if (!entry || !entry.pokemon) return makeSet();
  return entryToSet([entry.pokemon, entry.item, entry.form, entry.ability, entry.moves], entry.ev_spread, data);
}

export function setToBoxEntry(set, data, extra = {}) {
  return {
    pokemon: set.species,
    form: set.form || set.species,
    sprite: data ? (data.formRecord(set.species, set.form)?.sprite || "").replace(/\//g, "\\") : "",
    item: set.item || "",
    ability: set.ability || "",
    moves: (set.moves || []).filter(Boolean).slice(0, 4),
    ev_spread: spreadFromSet(set, data?.app),
    confidence: 1,
    build_source: "website",
    ...extra,
  };
}

/** A damage-engine mon for a set (level 50, full HP, no stages). */
export function monFromSet(set, overrides = {}) {
  return makeMon({
    pokemon_name: set.species,
    form_name: set.form || set.species,
    item: set.item || "",
    ability: set.ability || "",
    nature_name: set.nature || "Serious",
    bonuses: normalizeBonuses(set.bonuses),
    moves: (set.moves || []).filter(Boolean).slice(0, 4),
    ...overrides,
  });
}

export function setFromCommon(common) {
  return makeSet({
    species: common.species,
    form: common.form,
    item: common.item,
    ability: common.ability,
    moves: common.moves.slice(0, 4),
    nature: common.nature,
    bonuses: [...common.bonuses],
  });
}

export function bonusTotal(bonuses) {
  return normalizeBonuses(bonuses).reduce((sum, value) => sum + value, 0);
}

/** Showdown-style text for export, in the same shape the Companion imports. */
export function setToShowdown(set, data) {
  if (isEmptySet(set)) return "";
  const name = data.displayName(set.species, set.form);
  const lines = [`${name}${set.item ? ` @ ${set.item}` : ""}`];
  if (set.ability) lines.push(`Ability: ${set.ability}`);
  lines.push("Level: 50");
  const points = normalizeBonuses(set.bonuses);
  const parts = points.map((value, index) => (value ? `${value} ${STAT_LABELS[index]}` : "")).filter(Boolean);
  if (parts.length) lines.push(`EVs: ${parts.join(" / ")}`);
  lines.push(`${set.nature || "Serious"} Nature`);
  for (const move of (set.moves || []).filter(Boolean)) lines.push(`- ${move}`);
  return lines.join("\n");
}

const STAT_ALIASES = { hp: 0, atk: 1, attack: 1, def: 2, defense: 2, spa: 3, spatk: 3, "sp.atk": 3, spd: 4, spdef: 4, "sp.def": 4, spe: 5, speed: 5 };

/** Parse a Showdown paste into sets (the format the Companion's import reads). */
export function parseShowdown(text, data) {
  const blocks = String(text || "").replace(/\r/g, "").split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const sets = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    let [head, item = ""] = lines[0].split(" @ ");
    head = head.replace(/\s*\((M|F)\)\s*$/, "");
    const nicknamed = head.match(/\(([^)]+)\)\s*$/);
    const name = (nicknamed ? nicknamed[1] : head).trim();
    const [species, form] = data.resolve(name, name);
    if (!data.speciesEntry(species)) continue;
    const set = makeSet({ species, form, item: item.trim() });
    for (const line of lines.slice(1)) {
      if (/^ability:/i.test(line)) set.ability = line.split(":").slice(1).join(":").trim();
      else if (/nature$/i.test(line)) set.nature = line.replace(/nature$/i, "").trim();
      else if (/^(evs|sps|stat points):/i.test(line)) {
        const bonuses = [0, 0, 0, 0, 0, 0];
        for (const part of line.split(":").slice(1).join(":").split("/")) {
          const match = part.trim().match(/^(\d+)\s+(.+)$/);
          if (!match) continue;
          const index = STAT_ALIASES[match[2].toLowerCase().replace(/\s+/g, "")];
          if (index !== undefined) bonuses[index] = Math.min(32, Number(match[1]));
        }
        set.bonuses = bonuses;
      } else if (line.startsWith("-")) {
        const move = data.engine.canonicalMoveName(line.replace(/^-\s*/, "").replace(/\s*\[.*\]$/, ""));
        if (move && set.moves.length < 4) set.moves.push(move);
      }
    }
    if (!set.ability) set.ability = data.abilities(species, form)[0] || "";
    sets.push(set);
  }
  return sets;
}

export function debounce(fn, wait = 200) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function uid(prefix = "id") {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
