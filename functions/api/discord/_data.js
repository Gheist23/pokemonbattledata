// What the Discord bot reads, and how it names a Pokemon.
//
// Everything comes from the files this site already deploys, through the same
// env.ASSETS.fetch the JSON API uses, so an answer in Discord and the page it
// links to cannot disagree:
//
//   data/api/lookup.json          normalized alias -> profile slug, including
//                                 every Pokemon Showdown id (/api uses this)
//   data/meta/index.json          per battle name: slug, sprite, typing, base
//                                 name; plus the seasons and dates on the site
//   data/builder/meta-<format>    the current ranking and, per Pokemon, its
//                                 moves, items, abilities, natures, spreads and
//                                 teammates -- the file the Team Builder reads
//   data/builder/app-data.json    base stats per form, the type chart and the
//                                 move table, from the Companion's engine
//   data/descriptions.json        item and Ability text
//
// Battle data is filed under battle names, so a Mega has no usage rows of its
// own: "Garchomp-Mega" resolves to Garchomp and the reply says so. Stats are
// form-aware and come from app-data, which is why /pokemon can still print the
// Mega's spread.
//
// Files are cached per isolate through _cache.js, which is where the TTL and
// the entry cap live.

import { fetchAssetJson, normalize, normalizeFormat } from '../_common.js';
import { TtlCache } from './_cache.js';

export const SITE_ORIGIN = 'https://championsbattledata.com';
export const DEFAULT_FORMAT = 'Doubles';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "24_09_2026" -> "24 Sep 2026". Returns the input when it is not a date. */
export function formatDate(value) {
  const match = String(value || '').match(/^(\d{2})_(\d{2})_(\d{4})$/);
  if (!match) return String(value || '');
  const [, day, month, year] = match;
  const name = MONTHS[Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : String(value);
}

/** A site URL for an asset path, with each segment escaped the way the pages do. */
export function assetUrl(path, origin = SITE_ORIGIN) {
  if (!path) return '';
  const clean = String(path).replace(/\\/g, '/').replace(/^\/+/, '');
  return `${origin}/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

export function profileUrl(slug, origin = SITE_ORIGIN) {
  return slug ? `${origin}/pokemon/${encodeURIComponent(slug)}/` : `${origin}/`;
}

export const siteLinks = (origin = SITE_ORIGIN) => ({
  home: `${origin}/`,
  meta: `${origin}/meta/`,
  builder: `${origin}/team-builder/`,
  calculator: `${origin}/damage-calculator/`,
  speedTiers: `${origin}/pokemon-champions-speed-tiers/`,
  movesets: `${origin}/pokemon-champions-movesets/`,
  items: `${origin}/pokemon-champions-held-items/`,
  teammates: `${origin}/pokemon-champions-teammates/`,
  ranked: `${origin}/pokemon-champions-ranked-usage/`,
  api: `${origin}/api_guide`
});

/** Edit distance, capped: anything past `limit` is not a suggestion anyway. */
export function editDistance(a, b, limit = 4) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length];
}

/** How well `query` matches `candidate`; lower is better, null means no match. */
export function matchScore(query, candidate) {
  if (!query || !candidate) return null;
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1 + (candidate.length - query.length) / 100;
  if (candidate.includes(query)) return 2 + (candidate.length - query.length) / 100;
  const limit = query.length <= 4 ? 1 : query.length <= 7 ? 2 : 3;
  const distance = editDistance(query, candidate, limit);
  if (distance > limit) return null;
  return 3 + distance;
}

/** Sort `names` by how well they match, best first. `extra` adds [alias, name]
 *  spellings that should find a name without appearing in the list themselves. */
export function rankNames(normalizedQuery, names, extra = []) {
  if (!normalizedQuery) return [...names];
  const scored = new Map();
  const consider = (candidate, name) => {
    const score = matchScore(normalizedQuery, candidate);
    if (score === null) return;
    if (!scored.has(name) || score < scored.get(name)) scored.set(name, score);
  };
  for (const name of names) consider(normalize(name), name);
  for (const [alias, name] of extra) consider(alias, name);
  return [...scored.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
}

// A leading or trailing form word that battle data does not file separately:
// the usage rows for every Mega sit under the base Pokemon's name.
const FORM_WORDS = ['mega', 'megax', 'megay', 'megaz', 'gmax', 'gigantamax'];

function stripFormWord(normalized) {
  for (const word of FORM_WORDS) {
    if (normalized.startsWith(word) && normalized.length > word.length) {
      return { base: normalized.slice(word.length), form: word };
    }
    if (normalized.endsWith(word) && normalized.length > word.length) {
      return { base: normalized.slice(0, -word.length), form: word };
    }
  }
  return null;
}

export class SiteData {
  constructor(env, request, { origin = SITE_ORIGIN, cache } = {}) {
    this.env = env;
    this.request = request;
    this.origin = origin;
    this.cache = cache || SiteData.cache;
  }

  /** Shared across requests in one isolate, so a warm bot does no asset reads. */
  static cache = new TtlCache();

  json(path) {
    return this.cache.wrap(path, () => fetchAssetJson(this.env, this.request, path));
  }

  lookup() { return this.json('data/api/lookup.json'); }
  metaIndex() { return this.json('data/meta/index.json'); }
  appData() { return this.json('data/builder/app-data.json'); }
  descriptions() { return this.json('data/descriptions.json'); }

  format(value) {
    return normalizeFormat(value) || DEFAULT_FORMAT;
  }

  usage(format) {
    return this.json(`data/builder/meta-${this.format(format).toLowerCase()}.json`);
  }

  /** Season and date the current ranking was built from, for the embed footer. */
  async currentSnapshot() {
    const index = await this.metaIndex();
    const season = index.seasons?.[0];
    return { season: season?.season || '', date: season?.dates?.[0] || '' };
  }

  /** Name -> battle-data Pokemon, with suggestions when nothing matches. */
  async resolve(query) {
    const wanted = normalize(query);
    if (!wanted) return { ok: false, query, suggestions: [] };

    const [lookup, index] = await Promise.all([this.lookup(), this.metaIndex()]);
    const aliases = lookup.aliases || {};
    const bySlug = new Map(Object.entries(index.pokemon || {}).map(([name, entry]) => [entry.slug, name]));

    const hit = (normalized, askedForm = '') => {
      const slug = aliases[normalized];
      const name = slug ? bySlug.get(slug) : null;
      if (!name) return null;
      return { ok: true, name, identity: index.pokemon[name], askedForm, query };
    };

    const direct = hit(wanted);
    if (direct) return direct;

    // "Garchomp-Mega" and "Mega Garchomp" both mean the Garchomp usage rows.
    const stripped = stripFormWord(wanted);
    if (stripped) {
      const viaBase = hit(stripped.base, stripped.form);
      if (viaBase) return viaBase;
    }

    // Battle names themselves ("Indeedee-F"), in case an alias is missing.
    for (const [name, entry] of Object.entries(index.pokemon || {})) {
      if (normalize(name) === wanted) return { ok: true, name, identity: entry, askedForm: '', query };
    }

    return { ok: false, query, suggestions: this.suggest(wanted, aliases, index) };
  }

  /** Up to `limit` near matches, as battle names. */
  suggest(normalizedQuery, aliases, index, limit = 3) {
    const bySlug = new Map(Object.entries(index.pokemon || {}).map(([name, entry]) => [entry.slug, name]));
    const seen = new Map();
    const consider = (candidate, name) => {
      if (!name) return;
      const score = matchScore(normalizedQuery, candidate);
      if (score === null) return;
      const previous = seen.get(name);
      if (previous === undefined || score < previous) seen.set(name, score);
    };
    for (const [alias, slug] of Object.entries(aliases)) consider(alias, bySlug.get(slug));
    for (const name of Object.keys(index.pokemon || {})) consider(normalize(name), name);
    return [...seen.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([name]) => name);
  }

  /** Autocomplete choices for Pokemon: the two small index files only. */
  async completions(query, limit = 25) {
    const wanted = normalize(query);
    const [lookup, index] = await Promise.all([this.lookup(), this.metaIndex()]);
    const names = Object.keys(index.pokemon || {});
    if (!wanted) return names.slice(0, limit);
    const bySlug = new Map(Object.entries(index.pokemon).map(([name, entry]) => [entry.slug, name]));
    const extra = Object.entries(lookup.aliases || {})
      .map(([alias, slug]) => [alias, bySlug.get(slug)])
      .filter(([, name]) => name);
    return rankNames(wanted, names, extra).slice(0, limit);
  }

  /** Move names: the Pokemon's own rows when one is named, else the move table. */
  async completeMoves(query, { pokemon, format } = {}, limit = 25) {
    const rows = await this.usageRowsFor(pokemon, format);
    if (rows?.moves?.length) {
      const ranked = rows.moves.map(([name]) => name);
      const matched = rankNames(normalize(query), ranked);
      if (!normalize(query)) return ranked.slice(0, limit);
      if (matched.length) return matched.slice(0, limit);
    }
    const appData = await this.appData();
    return rankNames(normalize(query), Object.keys(appData.moves || {})).slice(0, limit);
  }

  /** Item names: the Pokemon's own rows when one is named, else every item. */
  async completeItems(query, { pokemon, format } = {}, limit = 25) {
    const rows = await this.usageRowsFor(pokemon, format);
    if (rows?.items?.length) {
      const ranked = rows.items.map(([name]) => name);
      const matched = rankNames(normalize(query), ranked);
      if (!normalize(query)) return ranked.slice(0, limit);
      if (matched.length) return matched.slice(0, limit);
    }
    const descriptions = await this.descriptions();
    return rankNames(normalize(query), Object.keys(descriptions.items || {})).slice(0, limit);
  }

  /** The ranking row for a Pokemon, or null when it is not named or not found. */
  async usageRowsFor(pokemon, format) {
    if (!pokemon) return null;
    const resolved = await this.resolve(pokemon);
    if (!resolved.ok) return null;
    const usage = await this.usage(format);
    return (usage.pokemon || []).find((entry) => entry.name === resolved.name) || null;
  }

  /** Usage row + identity + base stats for one Pokemon in one format. */
  async profile(query, format) {
    const resolved = await this.resolve(query);
    if (!resolved.ok) return resolved;
    const cleanFormat = this.format(format);
    const [usage, appData, snapshot] = await Promise.all([
      this.usage(cleanFormat),
      this.appData(),
      this.currentSnapshot()
    ]);
    const row = (usage.pokemon || []).find((entry) => entry.name === resolved.name) || null;
    const species = (appData.species || []).find((entry) => entry.name === (row?.species || resolved.name));
    const forms = species?.forms || [];
    const base = forms.find((entry) => entry.form === row?.form) || forms[0] || null;
    // A Mega asked for by name shows that form's stats; usage stays the base's.
    const askedMega = resolved.askedForm && forms.find((entry) => /^mega/i.test(entry.kind || ''));
    return {
      ok: true,
      name: resolved.name,
      askedForm: resolved.askedForm,
      identity: resolved.identity,
      format: cleanFormat,
      snapshot,
      row,
      rank: row?.position || null,
      total: (usage.pokemon || []).length,
      species: species || null,
      form: askedMega || base,
      forms
    };
  }
}

/** Defensive multipliers for one typing, keyed by attacking type. */
export function defensiveChart(typeChart, types) {
  const out = {};
  for (const attacking of Object.keys(typeChart || {})) {
    let multiplier = 1;
    for (const defending of types || []) {
      const row = typeChart[attacking] || {};
      multiplier *= Object.prototype.hasOwnProperty.call(row, defending) ? Number(row[defending]) : 1;
    }
    out[attacking] = multiplier;
  }
  return out;
}

/** What one attacking type does to each defending type. */
export function offensiveChart(typeChart, attackingType) {
  const row = (typeChart || {})[attackingType] || {};
  const out = {};
  for (const defending of Object.keys(typeChart || {})) {
    out[defending] = Object.prototype.hasOwnProperty.call(row, defending) ? Number(row[defending]) : 1;
  }
  return out;
}

/** Final stat: base + points (0-32), then the nature, exactly as the engine does. */
export function finalStat(baseValue, points, natureEffect) {
  let value = Math.max(0, Math.trunc(Number(baseValue) || 0)) + Math.min(32, Math.max(0, Math.trunc(Number(points) || 0)));
  if (natureEffect === 'up') value = Math.floor(value * 1.1);
  else if (natureEffect === 'down') value = Math.floor(value * 0.9);
  return Math.max(1, value);
}

/** "up" / "down" / "" for one stat key under one nature. */
export function natureEffect(natures, natureName, statLabel) {
  const [boost, nerf] = (natures || {})[natureName] || ['', ''];
  if (String(boost).toUpperCase() === statLabel) return 'up';
  if (String(nerf).toUpperCase() === statLabel) return 'down';
  return '';
}
