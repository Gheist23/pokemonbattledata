// The replies. One function per command, each returning a Discord message
// payload; nothing here fetches, so the shapes can be tested on stub data.
//
// Written for a phone: short fields, no table that wraps, at most ten rows in a
// list, one sprite as the thumbnail. Every reply carries link buttons back to
// championsbattledata.com, because sending people to the page is the point --
// the embed answers the question and the buttons are where they go next.

import {
  assetUrl, profileUrl, siteLinks, formatDate, defensiveChart, offensiveChart, finalStat, natureEffect
} from './_data.js';

export const EPHEMERAL = 64;

const TYPE_COLORS = {
  Normal: 0xa8a77a, Fire: 0xee8130, Water: 0x6390f0, Electric: 0xf7d02c, Grass: 0x7ac74c,
  Ice: 0x96d9d6, Fighting: 0xc22e28, Poison: 0xa33ea1, Ground: 0xe2bf65, Flying: 0xa98ff3,
  Psychic: 0xf95587, Bug: 0xa6b91a, Rock: 0xb6a136, Ghost: 0x735797, Dragon: 0x6f35fc,
  Dark: 0x705746, Steel: 0xb7b7ce, Fairy: 0xd685ad
};
const SITE_COLOR = 0x3fa9f5;
const STAT_LABELS = [['hp', 'HP'], ['attack', 'Atk'], ['defense', 'Def'], ['sp_attack', 'SpA'], ['sp_defense', 'SpD'], ['speed', 'Spe']];
const STAT_KEYS = ['HP', 'ATK', 'DEF', 'SPA', 'SPD', 'SPE'];

export function typeColor(types) {
  for (const type of types || []) if (TYPE_COLORS[type]) return TYPE_COLORS[type];
  return SITE_COLOR;
}

/** 80.6 -> "80.6%", 97 -> "97%", null -> "". */
export function percent(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return `${Number(number.toFixed(1))}%`;
}

function truncate(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function field(name, value, inline = false) {
  return { name: truncate(name, 256), value: truncate(value || '—', 1024), inline };
}

function linkButtons(buttons) {
  const row = buttons.filter((button) => button && button.url).slice(0, 5)
    .map((button) => ({ type: 2, style: 5, label: truncate(button.label, 80), url: button.url }));
  return row.length ? [{ type: 1, components: row }] : [];
}

function snapshotLine(format, snapshot) {
  const date = formatDate(snapshot?.date);
  const season = snapshot?.season ? `season ${snapshot.season}` : '';
  return [format, season, date].filter(Boolean).join(' · ');
}

function footer(format, snapshot) {
  return { text: `championsbattledata.com · ${snapshotLine(format, snapshot)}` };
}

function spriteThumbnail(identity, origin) {
  const url = assetUrl(identity?.sprite, origin);
  return url ? { url } : undefined;
}

function statsLine(stats) {
  if (!stats) return '';
  const cells = STAT_LABELS.map(([key, label]) => `${label} ${stats[key] ?? '?'}`);
  return `${cells.slice(0, 3).join(' · ')}\n${cells.slice(3).join(' · ')}`;
}

function spreadLine(bonuses) {
  if (!Array.isArray(bonuses) || bonuses.length < 6) return '';
  return STAT_LABELS.map(([, label], index) => `${label} ${bonuses[index] ?? 0}`).join(' / ');
}

/** A full-width list: the padded code span keeps the percentages in a column. */
function rankedList(pairs, limit) {
  return (pairs || []).slice(0, limit)
    .map(([name, value]) => `\`${(percent(value) || '–').padStart(6)}\` ${name}`)
    .join('\n');
}

/** The same list for a side-by-side field, where a phone has half the width:
 *  no monospace, which is wider, and no padding. */
function compactList(pairs, limit) {
  return (pairs || []).slice(0, limit)
    .map(([name, value]) => `${percent(value) || '–'} ${name}`)
    .join('\n');
}

/** A Mega typed into the box has no rows of its own; say so once, in one line. */
function formNote(profile) {
  if (!profile.askedForm) return '';
  return `Battle data for every form is filed under **${profile.name}**, so the usage below is the whole line's.`;
}

// ---------------------------------------------------------------- not found

export function notFoundReply(resolved, origin) {
  const links = siteLinks(origin);
  const suggestions = resolved.suggestions || [];
  const lines = [`No Pokemon on the site matches **${truncate(String(resolved.query || ''), 60)}**.`];
  if (suggestions.length) lines.push(`Did you mean ${suggestions.map((name) => `**${name}**`).join(', ')}?`);
  else lines.push('Names follow Pokemon Showdown spelling, for example `Garchomp`, `Indeedee-F` or `Tauros-Paldea-Aqua`.');
  return {
    embeds: [{
      color: SITE_COLOR,
      title: 'No match',
      description: lines.join('\n'),
      footer: { text: 'championsbattledata.com' }
    }],
    components: linkButtons([{ label: 'Browse every Pokemon', url: links.home }])
  };
}

export function noUsageReply(profile, origin) {
  const links = siteLinks(origin);
  return {
    embeds: [{
      color: typeColor(profile.identity?.types),
      title: profile.name,
      url: profileUrl(profile.identity?.slug, origin),
      thumbnail: spriteThumbnail(profile.identity, origin),
      description: `No ${profile.format} usage rows for **${profile.name}** in the current snapshot. Its profile page still has typing, stats and learnable moves.`,
      footer: footer(profile.format, profile.snapshot)
    }],
    components: linkButtons([
      { label: 'Profile', url: profileUrl(profile.identity?.slug, origin) },
      { label: 'Meta', url: links.meta }
    ])
  };
}

export function errorReply(message, origin) {
  const links = siteLinks(origin);
  return {
    embeds: [{
      color: SITE_COLOR,
      title: 'Could not read the battle data',
      description: `${message} The site itself is the same data, and it is up.`,
      footer: { text: 'championsbattledata.com' }
    }],
    components: linkButtons([{ label: 'championsbattledata.com', url: links.home }])
  };
}

// ---------------------------------------------------------------- /pokemon

export function pokemonReply(profile, appData, origin) {
  const links = siteLinks(origin);
  const row = profile.row;
  const set = row?.set || {};
  const form = profile.form;
  const types = form?.types || profile.identity?.types || [];
  const url = profileUrl(profile.identity?.slug, origin);

  // No base stat total: the "Total" a profile page prints is not the sum of the
  // six stats it prints above it (it runs 55 lower on every Pokemon in
  // pokemon_champions_assets/metadata/*.csv), so a sum worked out here would
  // disagree with the page this embed links to. The page has the number.
  const headline = [
    types.join(' / '),
    profile.rank ? `#${profile.rank} of ${profile.total} in ${profile.format}` : null
  ].filter(Boolean).join(' · ');

  const fields = [];
  if (form?.stats) fields.push(field(`Base stats — ${form.form}`, statsLine(form.stats)));
  if (set.item || set.ability || set.nature) {
    const spread = spreadLine(set.bonuses);
    fields.push(field('Most used set', [
      [set.item, set.ability, set.nature].filter(Boolean).join(' · '),
      spread,
      (set.moves || []).join(' · ')
    ].filter(Boolean).join('\n')));
  }
  // Four each, side by side: two inline fields get half a phone's width, and
  // /moves and /teammates are there for the full ten.
  if (row?.moves?.length) fields.push(field('Top moves', compactList(row.moves, 4), true));
  if (row?.teammates?.length) fields.push(field('Top teammates', row.teammates.slice(0, 4).join('\n'), true));
  const others = (profile.forms || []).filter((entry) => entry.form !== form?.form);
  if (others.length) {
    fields.push(field('Other forms', others.slice(0, 4)
      .map((entry) => `${entry.form} — ${entry.types.join('/')}, Spe ${entry.stats?.speed ?? '?'}`).join('\n')));
  }

  const note = formNote(profile);
  return {
    embeds: [{
      color: typeColor(types),
      author: { name: snapshotLine(profile.format, profile.snapshot), url: links.meta },
      title: profile.name,
      url,
      thumbnail: spriteThumbnail(profile.identity, origin),
      description: [headline, note].filter(Boolean).join('\n'),
      fields,
      footer: footer(profile.format, profile.snapshot)
    }],
    components: linkButtons([
      { label: 'Full profile', url },
      { label: 'Team Builder', url: links.builder },
      { label: 'Damage Calc', url: links.calculator }
    ])
  };
}

// ------------------------------------------------------------------ /moves

const normalizeName = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Find a table entry by a loosely typed name. */
export function lookupByName(table, wanted) {
  if (!table || !wanted) return null;
  if (table[wanted]) return { name: wanted, value: table[wanted] };
  const target = normalizeName(wanted);
  for (const [name, value] of Object.entries(table)) {
    if (normalizeName(name) === target) return { name, value };
  }
  return null;
}

/** Accuracy as a player may see it: never over 100, and `true` never misses. */
function accuracyText(move) {
  if (move.accuracy === true) return 'never misses';
  const value = Math.min(100, Number(move.acc ?? move.accuracy ?? 100));
  return Number.isFinite(value) ? `${value}% accurate` : 'unknown accuracy';
}

function usageOf(pairs, name) {
  const found = (pairs || []).find(([entry]) => normalizeName(entry) === normalizeName(name));
  return found ? Number(found[1]) : null;
}

function moveDetailField(wanted, appData, profile) {
  const found = lookupByName(appData?.moves || {}, wanted);
  if (!found) return field(`No move called "${wanted}"`, 'Pick one from the list the box offers, or leave the move blank for the top ten.');
  const move = found.value;
  const usage = usageOf(profile.row?.moves, found.name);
  const headline = [
    move.type,
    move.category,
    Number(move.power) > 0 ? `${move.power} power` : null,
    accuracyText(move),
    move.pp ? `${move.pp} PP` : null,
    Number(move.priority) ? `priority ${move.priority > 0 ? '+' : ''}${move.priority}` : null
  ].filter(Boolean).join(' · ');
  const usageLine = usage !== null
    ? `On **${percent(usage)}** of ${profile.name}'s ${profile.format} sets.`
    : `Not in ${profile.name}'s ten most used ${profile.format} moves.`;
  return field(found.name, [headline, move.description, usageLine].filter(Boolean).join('\n'));
}

export function movesReply(profile, appData, origin, wantedMove = '') {
  const links = siteLinks(origin);
  const url = profileUrl(profile.identity?.slug, origin);
  const moves = profile.row?.moves || [];
  const moveTable = appData?.moves || {};
  const lines = moves.slice(0, 10).map(([name, value]) => {
    const meta = moveTable[name];
    const tail = meta ? ` · ${meta.type}` : '';
    return `\`${(percent(value) || '–').padStart(6)}\` **${name}**${tail}`;
  });
  const set = profile.row?.set || {};
  const fields = [];
  if (wantedMove) fields.push(moveDetailField(wantedMove, appData, profile));
  if ((set.moves || []).length) fields.push(field('The four most often run together', set.moves.join(' · ')));
  return {
    embeds: [{
      color: typeColor(profile.form?.types || profile.identity?.types),
      author: { name: snapshotLine(profile.format, profile.snapshot), url: links.meta },
      title: `${profile.name} — most used ${profile.format} moves`,
      url,
      thumbnail: spriteThumbnail(profile.identity, origin),
      description: [formNote(profile), lines.join('\n') || 'No move rows in this snapshot.'].filter(Boolean).join('\n'),
      fields,
      footer: footer(profile.format, profile.snapshot)
    }],
    components: linkButtons([
      { label: 'Full moveset', url },
      { label: 'All movesets', url: links.movesets },
      { label: 'Damage Calc', url: links.calculator }
    ])
  };
}

// ------------------------------------------------------------------ /items

function itemDetailField(wanted, descriptions, profile) {
  const table = descriptions?.items || {};
  const found = lookupByName(table, wanted);
  const usage = usageOf(profile.row?.items, found?.name || wanted);
  if (!found && usage === null) {
    return field(`No item called "${wanted}"`, 'Pick one from the list the box offers, or leave the item blank for the top ten.');
  }
  const usageLine = usage !== null
    ? `On **${percent(usage)}** of ${profile.name}'s ${profile.format} sets.`
    : `Not in ${profile.name}'s ten most used ${profile.format} items.`;
  return field(found?.name || wanted, [found?.value, usageLine].filter(Boolean).join('\n'));
}

export function itemsReply(profile, descriptions, origin, wantedItem = '') {
  const links = siteLinks(origin);
  const url = profileUrl(profile.identity?.slug, origin);
  const items = profile.row?.items || [];
  const top = items[0]?.[0] || '';
  const description = (descriptions?.items || {})[top] || '';
  const fields = wantedItem
    ? [itemDetailField(wantedItem, descriptions, profile)]
    : (description ? [field(top, description)] : []);
  return {
    embeds: [{
      color: typeColor(profile.form?.types || profile.identity?.types),
      author: { name: snapshotLine(profile.format, profile.snapshot), url: links.meta },
      title: `${profile.name} — most used ${profile.format} held items`,
      url,
      thumbnail: spriteThumbnail(profile.identity, origin),
      description: [formNote(profile), rankedList(items, 10) || 'No held-item rows in this snapshot.'].filter(Boolean).join('\n'),
      fields,
      footer: footer(profile.format, profile.snapshot)
    }],
    components: linkButtons([
      { label: 'Full profile', url },
      { label: 'All held items', url: links.items },
      { label: 'Team Builder', url: links.builder }
    ])
  };
}

// -------------------------------------------------------------- /teammates

export function teammatesReply(profile, ranking, origin) {
  const links = siteLinks(origin);
  const url = profileUrl(profile.identity?.slug, origin);
  const teammates = profile.row?.teammates || [];
  const rankOf = new Map((ranking || []).map((row) => [row.name, row.position]));
  const lines = teammates.slice(0, 10).map((name, index) => {
    const rank = rankOf.get(name);
    return `**${index + 1}.** ${name}${rank ? ` · #${rank} overall` : ''}`;
  });
  return {
    embeds: [{
      color: typeColor(profile.form?.types || profile.identity?.types),
      author: { name: snapshotLine(profile.format, profile.snapshot), url: links.meta },
      title: `${profile.name} — most common ${profile.format} teammates`,
      url,
      thumbnail: spriteThumbnail(profile.identity, origin),
      description: [formNote(profile), lines.join('\n') || 'No teammate rows in this snapshot.'].filter(Boolean).join('\n'),
      footer: { text: `Order of appearance, not a percentage · ${snapshotLine(profile.format, profile.snapshot)}` }
    }],
    components: linkButtons([
      { label: 'Full profile', url },
      { label: 'All teammates', url: links.teammates },
      { label: 'Build a team', url: links.builder }
    ])
  };
}

// ------------------------------------------------------------------- /meta

export function metaReply(ranking, format, snapshot, top, origin) {
  const links = siteLinks(origin);
  const rows = (ranking || []).slice(0, top);
  const lines = rows.map((row) => {
    const item = row.set?.item ? ` · ${row.set.item}` : '';
    return `**${String(row.position).padStart(2)}.** ${row.name}${item}`;
  });
  const half = Math.ceil(lines.length / 2);
  return {
    embeds: [{
      color: SITE_COLOR,
      author: { name: snapshotLine(format, snapshot), url: links.meta },
      title: `Top ${rows.length} in ${format}`,
      url: links.meta,
      description: `Ranked by how often each Pokemon appears in ${format} battle data, with its most used item.`,
      fields: [
        field('​', lines.slice(0, half).join('\n'), true),
        ...(lines.length > half ? [field('​', lines.slice(half).join('\n'), true)] : [])
      ],
      footer: footer(format, snapshot)
    }],
    components: linkButtons([
      { label: 'Meta trends', url: links.meta },
      { label: 'Ranked usage', url: links.ranked },
      { label: 'Team Builder', url: links.builder }
    ])
  };
}

// ---------------------------------------------------------------- /compare

export function compareReply(first, second, origin) {
  const links = siteLinks(origin);
  const column = (profile) => {
    const stats = profile.form?.stats;
    const set = profile.row?.set || {};
    return [
      (profile.form?.types || profile.identity?.types || []).join(' / '),
      profile.rank ? `#${profile.rank} in ${profile.format}` : 'unranked',
      stats ? statsLine(stats) : '',
      set.item ? `Item ${set.item}` : '',
      set.ability ? `Ability ${set.ability}` : ''
    ].filter(Boolean).join('\n');
  };
  const sharedTeammates = (first.row?.teammates || []).filter((name) => (second.row?.teammates || []).includes(name));
  const sharedMoves = (first.row?.moves || []).map(([name]) => name)
    .filter((name) => (second.row?.moves || []).some(([other]) => other === name));
  const speedOf = (profile) => profile.form?.stats?.speed ?? null;
  const [a, b] = [speedOf(first), speedOf(second)];
  const speedNote = a !== null && b !== null
    ? (a === b ? 'Same base Speed.' : `**${a > b ? first.name : second.name}** is faster before investment (${Math.max(a, b)} to ${Math.min(a, b)}).`)
    : '';

  return {
    embeds: [{
      color: typeColor(first.form?.types || first.identity?.types),
      author: { name: snapshotLine(first.format, first.snapshot), url: links.meta },
      title: `${first.name} vs ${second.name}`,
      url: links.builder,
      thumbnail: spriteThumbnail(first.identity, origin),
      description: speedNote,
      fields: [
        field(first.name, column(first), true),
        field(second.name, column(second), true),
        field('Shared teammates', sharedTeammates.slice(0, 6).join(', ') || 'None in the top ten of either.'),
        field('Moves both run', sharedMoves.slice(0, 8).join(', ') || 'No overlap in the top ten of either.')
      ],
      footer: footer(first.format, first.snapshot)
    }],
    components: linkButtons([
      { label: first.name, url: profileUrl(first.identity?.slug, origin) },
      { label: second.name, url: profileUrl(second.identity?.slug, origin) },
      { label: 'Damage Calc', url: links.calculator }
    ])
  };
}

// ------------------------------------------------------------------ /speed

/** Every ranked Pokemon's Speed on its own most used spread, fastest first. */
export function speedTable(ranking, appData) {
  const species = new Map((appData?.species || []).map((entry) => [entry.name, entry]));
  const natures = appData?.natures || {};
  const rows = [];
  for (const row of ranking || []) {
    const form = species.get(row.species)?.forms?.find((entry) => entry.form === row.form);
    if (!form?.stats) continue;
    const points = Array.isArray(row.set?.bonuses) ? row.set.bonuses[5] : 0;
    const effect = natureEffect(natures, row.set?.nature, STAT_KEYS[5]);
    rows.push({
      name: row.name,
      position: row.position,
      base: form.stats.speed,
      points: points || 0,
      nature: row.set?.nature || '',
      effect,
      speed: finalStat(form.stats.speed, points, effect)
    });
  }
  return rows.sort((a, b) => b.speed - a.speed || a.position - b.position);
}

export function speedReply(profile, table, origin) {
  const links = siteLinks(origin);
  const url = profileUrl(profile.identity?.slug, origin);
  const index = table.findIndex((entry) => entry.name === profile.name);
  const me = index >= 0 ? table[index] : null;
  const line = (entry) => `${entry.name === profile.name ? '**' : ''}${String(entry.speed).padStart(3)} ${entry.name}${entry.name === profile.name ? '**' : ''}`;
  const window = index >= 0 ? table.slice(Math.max(0, index - 3), index + 4) : [];
  const slower = me ? table.filter((entry) => entry.speed < me.speed).length : 0;

  const headline = me
    ? `Base Speed **${me.base}**, plus **${me.points}** Speed points${me.effect === 'up' ? ` and a Speed-boosting ${me.nature}` : me.effect === 'down' ? ` under a Speed-lowering ${me.nature}` : ''} → **${me.speed}**.`
    : `No ${profile.format} spread on file for ${profile.name}, so its usual Speed cannot be worked out.`;

  return {
    embeds: [{
      color: typeColor(profile.form?.types || profile.identity?.types),
      author: { name: snapshotLine(profile.format, profile.snapshot), url: links.meta },
      title: `${profile.name} — Speed in ${profile.format}`,
      url,
      thumbnail: spriteThumbnail(profile.identity, origin),
      description: [formNote(profile), headline].filter(Boolean).join('\n'),
      fields: [
        ...(window.length ? [field('Around it, on each one’s most used spread', window.map(line).join('\n'))] : []),
        ...(me ? [field('Outspeeds', `${slower} of the ${table.length} ranked Pokemon, on their most used spreads.`)] : [])
      ],
      footer: { text: `Base + points, then the nature · ${snapshotLine(profile.format, profile.snapshot)}` }
    }],
    components: linkButtons([
      { label: 'Speed tiers', url: links.speedTiers },
      { label: 'Full profile', url },
      { label: 'Team Builder', url: links.builder }
    ])
  };
}

// ---------------------------------------------------------------- /matchup

function groupChart(chart) {
  const groups = new Map();
  for (const [type, multiplier] of Object.entries(chart)) {
    if (multiplier === 1) continue;
    const key = multiplier;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(type);
  }
  return [...groups.entries()].sort((a, b) => b[0] - a[0]);
}

const times = (multiplier) => (multiplier === 0 ? 'immune' : `x${Number(multiplier.toFixed(2))}`);

export function matchupReply(types, typeChart, origin) {
  const links = siteLinks(origin);
  const defensive = groupChart(defensiveChart(typeChart, types));
  const weak = defensive.filter(([multiplier]) => multiplier > 1);
  const resist = defensive.filter(([multiplier]) => multiplier < 1 && multiplier > 0);
  const immune = defensive.filter(([multiplier]) => multiplier === 0);
  const line = (entries) => entries.map(([multiplier, list]) => `${times(multiplier)} — ${list.join(', ')}`).join('\n');

  const offensive = types.map((type) => {
    const chart = offensiveChart(typeChart, type);
    const strong = Object.entries(chart).filter(([, value]) => value > 1).map(([name]) => name);
    const weakAgainst = Object.entries(chart).filter(([, value]) => value < 1).map(([name]) => name);
    return field(`${type} attacks`, `Strong: ${strong.join(', ') || 'nothing'}\nWeak: ${weakAgainst.join(', ') || 'nothing'}`);
  });

  return {
    embeds: [{
      color: typeColor(types),
      title: `${types.join(' / ')} matchups`,
      url: links.builder,
      description: 'Defending, then attacking, from the type chart this site’s Damage Calculator uses.',
      fields: [
        field('Takes more from', line(weak) || 'Nothing.'),
        field('Takes less from', line(resist) || 'Nothing.'),
        ...(immune.length ? [field('Immune to', immune[0][1].join(', '))] : []),
        ...offensive
      ],
      footer: { text: 'championsbattledata.com · type chart' }
    }],
    components: linkButtons([
      { label: 'Team Builder', url: links.builder },
      { label: 'Damage Calc', url: links.calculator }
    ])
  };
}

// --------------------------------------------------------------- /counters

/** Ranked Pokemon that already run a move hitting `types` for at least double. */
export function counterList(ranking, appData, types, targetName, { minUsage = 15, limit = 8 } = {}) {
  const chart = defensiveChart(appData?.typeChart || {}, types);
  const moveTable = appData?.moves || {};
  const out = [];
  for (const row of ranking || []) {
    if (row.name === targetName) continue;
    let best = null;
    for (const [moveName, usage] of row.moves || []) {
      if (Number(usage) < minUsage) continue;
      const move = moveTable[moveName];
      if (!move || move.category === 'status' || !(Number(move.power) > 0)) continue;
      const multiplier = chart[move.type];
      if (!(multiplier >= 2)) continue;
      if (!best || multiplier > best.multiplier || (multiplier === best.multiplier && usage > best.usage)) {
        best = { move: moveName, type: move.type, multiplier, usage: Number(usage) };
      }
    }
    if (best) out.push({ name: row.name, position: row.position, ...best });
    if (out.length >= limit) break;
  }
  return out;
}

export function countersReply(profile, counters, typeChart, origin) {
  const links = siteLinks(origin);
  const types = profile.form?.types || profile.identity?.types || [];
  const url = profileUrl(profile.identity?.slug, origin);
  const weak = groupChart(defensiveChart(typeChart, types)).filter(([multiplier]) => multiplier > 1);
  const lines = counters.map((entry) => `**#${entry.position} ${entry.name}** — ${entry.move} (${times(entry.multiplier)}, on ${percent(entry.usage)} of sets)`);

  return {
    embeds: [{
      color: typeColor(types),
      author: { name: snapshotLine(profile.format, profile.snapshot), url: links.meta },
      title: `What hits ${profile.name} hard in ${profile.format}`,
      url,
      thumbnail: spriteThumbnail(profile.identity, origin),
      description: [
        formNote(profile),
        `${types.join(' / ')} takes more from ${weak.map(([multiplier, list]) => `${list.join(', ')} (${times(multiplier)})`).join('; ') || 'nothing'}.`
      ].filter(Boolean).join('\n'),
      fields: [field('Ranked Pokemon already carrying one', lines.join('\n') || 'None in the current ranking.')],
      footer: { text: `Type coverage from the most used sets, not a damage roll · ${snapshotLine(profile.format, profile.snapshot)}` }
    }],
    components: linkButtons([
      { label: 'Run the numbers', url: links.calculator },
      { label: `${profile.name} profile`, url },
      { label: 'Meta', url: links.meta }
    ])
  };
}

// ------------------------------------------------------------------- /help

export function helpReply(commands, origin) {
  const links = siteLinks(origin);
  const lines = commands.map((command) => `**/${command.name}** — ${command.description}`);
  return {
    embeds: [{
      color: SITE_COLOR,
      title: 'Pokemon Champions battle data, in Discord',
      url: links.home,
      description: `${lines.join('\n')}\n\nNames follow Pokemon Showdown spelling and the box autocompletes. \`format\` is Doubles unless you pick Singles.`,
      fields: [field('Where the numbers come from', `Every answer is read live from championsbattledata.com, the same files the site’s own pages and [public API](${links.api}) use.`)],
      footer: { text: 'championsbattledata.com' }
    }],
    components: linkButtons([
      { label: 'Website', url: links.home },
      { label: 'Meta', url: links.meta },
      { label: 'Team Builder', url: links.builder },
      { label: 'Damage Calc', url: links.calculator },
      { label: 'API guide', url: links.api }
    ])
  };
}
