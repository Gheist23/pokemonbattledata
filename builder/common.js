// Shared data layer for the Damage Calculator and Team Builder pages.
//
// Loads the app-exported tables (data/builder/app-data.json) and the daily meta
// files, and answers the questions both pages ask: what is this Pokemon called,
// which sprite does it use, what can it learn, what is its most common set.
// Team entries use the Companion's own shape so a synced team round-trips
// unchanged:  [pokemon, item, form, ability, [moves]]  plus a spread
// { name, nature_name, nature: [up, down], bonuses: [6] }.

import { DamageEngine, compact, makeMon, normalizeBonuses, STAT_KEYS } from "./engine.js";
import { setRosterIdentity } from "./known-teams.js";

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

    // Pokemon are shown under their Pokemon Showdown names ("Indeedee-F",
    // "Charizard-Mega-Y"), the names the battle data and the rest of the site
    // use.  The app's tables file some Pokemon twice under different spellings
    // (species "Basculegion" lists both "Basculegion" and "Basculegion Male";
    // "Heat Rotom" is its own species next to Rotom's "Rotom Heat"), so every
    // Showdown name keeps one (species, form) pair to stand for it: the pair
    // the usage data is filed under when there is one, so the picker's rank and
    // most common set come from the same row as the meta tables.
    this.displayNames = new Map(Object.entries(appData.displayNames || {}).map(([name, shown]) => [compact(name), shown]));
    const usageAliases = Object.entries(appData.usageAliases || {});
    const usagePairs = new Map(usageAliases.map(([shown, pair]) => [compact(shown), pair]));
    // The ladder's name for an app form where the display table says something
    // else: the app's one Floette is the ladder's Floette-Eternal, its Maushold
    // is Maushold-Four, and its "Vivillon Icy Snow Pattern" carries the
    // Vivillon-Fancy usage.  Only a form exactly one ladder name points at is
    // renamed.  The app's single Squawkabilly stands for both ladder
    // Squawkabilly and Squawkabilly-Yellow, so it keeps its own name and the
    // second name only finds it (see byName below).
    const ladderByForm = new Map();
    for (const [shown, [, form]] of usageAliases) {
      const key = compact(form);
      if (!ladderByForm.has(key)) ladderByForm.set(key, { form, names: [] });
      ladderByForm.get(key).names.push(shown);
    }
    this.ladderNames = new Map(); // compact(app form) -> the ladder's Showdown name
    for (const [key, { form, names }] of ladderByForm) {
      if (names.length === 1 && compact(names[0]) !== compact(this.displayNames.get(key) || form)) this.ladderNames.set(key, names[0]);
    }
    const preference = (row, shown) => {
      const pair = usagePairs.get(compact(shown));
      if (pair && compact(pair[0]) === compact(row.species) && compact(pair[1]) === compact(row.form)) return 0;
      if (compact(row.species) === compact(String(shown).split("-")[0])) return 1;
      return 2;
    };
    this.byShowdown = new Map(); // compact(Showdown name) -> { row, label, keys }
    for (const row of this.forms) {
      const label = this.showdownName(row.form);
      const key = compact(label);
      const identity = this.byShowdown.get(key);
      if (!identity) {
        this.byShowdown.set(key, { row, label, keys: new Set([key, compact(row.form), compact(row.species)]) });
        continue;
      }
      identity.keys.add(compact(row.form));
      identity.keys.add(compact(row.species));
      if (preference(row, label) < preference(identity.row, label)) identity.row = row;
    }

    // Every name a person may type or paste for a Pokemon, to its identity:
    // the Showdown label; the display table's own spelling where the label
    // differs ("Floette", "Vivillon-Icy Snow"); a second ladder name that
    // shares one app form ("Squawkabilly-Yellow"); and "<Base>-F-Mega" for a
    // Mega the app files once for both genders ("Meowstic-F-Mega" is a female
    // Meowstic, whose stone does the rest).  The search matches them too.
    this.byName = new Map(this.byShowdown);
    const claim = (name, identity) => {
      const key = compact(name);
      if (!key || !identity || this.byName.has(key)) return;
      this.byName.set(key, identity);
      identity.keys.add(key);
    };
    for (const row of this.forms) claim(this.displayNames.get(compact(row.form)), this.byShowdown.get(compact(this.showdownName(row.form))));
    for (const [shown, [, form]] of usageAliases) claim(shown, this.byShowdown.get(compact(this.showdownName(form))));
    for (const identity of this.byShowdown.values()) {
      const gendered = identity.label.match(/^(.+)-M-Mega$/);
      if (gendered) claim(`${gendered[1]}-F-Mega`, this.byShowdown.get(compact(`${gendered[1]}-F`)));
      // "Meowstic-M", "Indeedee-M": the male is the plain name where a -F forme exists.
      if (this.byShowdown.has(compact(`${identity.label}-F`))) claim(`${identity.label}-M`, identity);
    }

    // The tournament-team library compares rosters by battle-data name, and
    // the app's tables spell some Pokemon two ways: a Basculegion saved as
    // "Basculegion" and one saved as "Basculegion Male" must count as the
    // same member (builder/known-teams.js).  Every app spelling answers to
    // its Showdown identity.
    this.rosterKeys = new Map();
    for (const row of this.forms) {
      const identityKey = compact(this.showdownName(row.form));
      for (const key of [identityKey, compact(row.form), compact(this.displayNames.get(compact(row.form)))]) {
        if (key && !this.rosterKeys.has(key)) this.rosterKeys.set(key, identityKey);
      }
    }
    setRosterIdentity((key) => this.rosterKeys.get(key) || key);
  }

  /** The Showdown spelling of an app form name (pokemon_display_name), or the
   *  ladder's name where the app files one ladder form under another name
   *  (the app's Floette is Floette-Eternal). */
  showdownName(name) {
    const text = String(name ?? "").trim();
    const key = compact(text);
    const known = this.ladderNames?.get(key) || this.displayNames.get(key);
    if (known) return known;
    // A Mega the table has no entry for: Showdown names the gendered ones
    // after the gender letter, and the app's single "Mega Meowstic" is the
    // male's (a female holder is named in displayName()).
    const mega = text.match(/^Mega\s+(.+)$/i);
    if (mega) {
      const base = this.showdownName(mega[1]);
      const shown = this.displayNames.get(compact(`${base}-Mega`)) || this.displayNames.get(compact(`${base}-M-Mega`));
      if (shown) return shown;
    }
    return text;
  }

  /** Index one already-read meta payload, so a caller that fetched the file
   *  itself gets the same `meta` / `metaByUsage` the pages build.  The Discord
   *  bot reads the site's files through env.ASSETS inside a Cloudflare Function,
   *  where `loadMeta`'s root-relative fetch has no base URL to resolve against
   *  (functions/api/discord/_damage.js), so it calls this instead.  One copy of
   *  the indexing rule, whichever way the payload arrived. */
  ingestMeta(format, payload) {
    this.meta[format] = payload;
    this.metaByUsage[format] = new Map(payload.pokemon.map((row) => [compact(row.name), row]));
    return payload;
  }

  async loadMeta(format) {
    const key = format === "Singles" ? "singles" : "doubles";
    if (!this.meta[format]) this.ingestMeta(format, await fetchJson(`/data/builder/meta-${key}.json`));
    return this.meta[format];
  }

  /** (species, form) in the app's spelling for any name (Showdown, app, legacy).
   *  A pair the app's tables already hold is returned unchanged, so a synced
   *  team round-trips as it was saved; Showdown names the tables do not spell
   *  that way ("Aegislash-Blade", "Castform-Rainy", "Vivillon-Icy Snow",
   *  "Meowstic-M-Mega") are looked up by their Showdown identity. */
  resolve(pokemon, form = "") {
    const resolved = this.engine.resolve(pokemon, form);
    if (this.isAppPair(resolved)) return resolved;
    for (const name of [form, pokemon]) {
      const identity = name ? this.byName.get(compact(name)) : null;
      if (identity) return [identity.row.species, identity.row.form];
    }
    return resolved;
  }

  /** (species, form) for a name a person typed or pasted (a Showdown paste,
   *  a link's ?add=): the Showdown identity comes first, so "Basculegion" is
   *  the pair the picker stores (Basculegion Male, the one the usage data and
   *  the tournament library use), not the table's second "Basculegion" row.
   *  App spellings still resolve as themselves. */
  resolveName(name) {
    const identity = this.byName.get(compact(name));
    if (identity) return [identity.row.species, identity.row.form];
    return this.resolve(name, name);
  }

  isAppPair([species, form]) {
    const entry = this.speciesEntry(species);
    return Boolean(entry && entry.forms.some((record) => compact(record.form) === compact(form)));
  }

  formRecord(species, form) {
    return this.engine.formRecord(species, form);
  }

  speciesEntry(species) {
    return this.engine.speciesEntry(species);
  }

  /** The form's Pokemon Showdown name ("Charizard-Mega-Y", "Ninetales-Alola",
   *  "Indeedee-F") -- what every label, the Showdown export and the Team
   *  Evaluation threats use.  `baseForm` is the set's own form when `form` is
   *  the Mega it battles as: the app has one "Mega Meowstic" for both
   *  genders, and Showdown calls a female holder's Meowstic-F-Mega. */
  displayName(species, form, baseForm = "") {
    const record = this.formRecord(species, form);
    const label = this.showdownName(record?.form || form || species || "");
    if (baseForm && /-M-Mega$/.test(label) && /-F$/.test(this.showdownName(baseForm))) {
      return this.displayNames.get(compact(label.replace(/-M-Mega$/, "-F-Mega"))) || label;
    }
    return label;
  }

  /** The name a set battles under: its Mega's name when the stone applies,
   *  after the holder's gender (a female Meowstic with Meowsticite is
   *  Meowstic-F-Mega), otherwise its own form's name. */
  setName(set) {
    if (!set?.species) return "";
    const [species, form] = this.battleForm(set.species, set.form, set.item);
    return this.displayName(species, form, set.form || set.species);
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

  /** [value, label] pairs for a Form select: one per Showdown identity, the
   *  value in the app's spelling and the label its Showdown name.  `current`
   *  (the set's own form) keeps its spelling, so the select shows it chosen. */
  legalForms(species, current = "") {
    const entry = this.speciesEntry(species);
    const groups = new Map();
    for (const form of entry?.forms || []) {
      const label = this.showdownName(form.form);
      const key = compact(label);
      const isCurrent = Boolean(current) && compact(form.form) === compact(current);
      const preferred = this.byShowdown.get(key)?.row;
      const isPreferred = Boolean(preferred) && compact(preferred.species) === compact(entry.name) && compact(preferred.form) === compact(form.form);
      const existing = groups.get(key);
      if (!existing || isCurrent || (isPreferred && !existing.isCurrent)) groups.set(key, { value: form.form, label, isCurrent });
    }
    return [...groups.values()].map(({ value, label }) => [value, label]);
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

  /** Picker rows: one per Pokemon (Showdown identity), labelled with its
   *  Showdown name.  A query matches the Showdown name or any app spelling of
   *  that Pokemon, so "ninetales-alola" and "alolan ninetales" both find it. */
  searchSpecies(query, { limit = 60, format = "Doubles" } = {}) {
    const q = compact(query);
    const index = this.metaByUsage[format];
    const scored = [];
    for (const { row, label, keys } of this.byShowdown.values()) {
      const names = [...keys];
      let score;
      if (!q) score = 0;
      else if (names.some((key) => key === q)) score = 3;
      else if (names.some((key) => key.startsWith(q))) score = 2;
      else if (names.some((key) => key.includes(q)) || (row.types || []).some((t) => compact(t) === q)) score = 1;
      else continue;
      const usage = row.usage && index ? index.get(compact(row.usage)) : null;
      const position = usage && !row.mega ? usage.position : 9999;
      scored.push({ ...row, label, score, position });
    }
    scored.sort((a, b) => b.score - a.score || a.position - b.position || a.label.localeCompare(b.label));
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

/** Stat words a person may type or paste, to the index they mean. Exported so
 *  the Discord bot's /damage free text reads the same spellings this file's
 *  Showdown parser does (functions/api/discord/_damage.js). */
export const STAT_ALIASES = { hp: 0, atk: 1, attack: 1, def: 2, defense: 2, spa: 3, spatk: 3, "sp.atk": 3, spd: 4, spdef: 4, "sp.def": 4, spe: 5, speed: 5 };

/** Parse a Showdown paste into sets (the format the Companion's import reads). */
export function parseShowdown(text, data) {
  const blocks = String(text || "").replace(/\r/g, "").split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const sets = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    let [head, item = ""] = lines[0].split(" @ ");
    const gender = head.match(/\s*\((M|F)\)\s*$/)?.[1] || "";
    head = head.replace(/\s*\((M|F)\)\s*$/, "");
    const nicknamed = head.match(/\(([^)]+)\)\s*$/);
    let name = (nicknamed ? nicknamed[1] : head).trim();
    // "Meowstic (F)": the gender marker picks the female forme where Showdown has one.
    if (gender === "F" && data.byName?.has(compact(`${name}-F`))) name = `${name}-F`;
    // Through the Showdown identity first, so a pasted "Basculegion" is the
    // same Pokemon the picker stores, and the similar-team matching sees it.
    const [species, form] = data.resolveName(name);
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
