// /damage: a real damage calculation in Discord, from the site's own engine.
//
// There is exactly one damage implementation on this site and this file is not
// it. builder/engine.js is the Companion's engine ported once and held to
// 4,000 recorded app vectors by tests/run-calc-vectors.mjs; builder/calc-model.js
// is the Damage Calculator screen's own logic on top of it (which weather is
// really up, which abilities are switched off, KO odds over repeated hits,
// Sitrus Berry, Focus Sash). Both are pure -- no DOM, no fetch -- so this
// module builds the same CalcModel the page builds and reads the numbers off
// it. Nothing here computes damage. If a number here disagreed with the page,
// that would be a bug in the wiring below, never a difference of formula.
//
// Two things have to be worked around to run that chain inside a Function:
//
//   * BuilderData.load() / loadMeta() fetch root-relative paths ("/data/...")
//     which have no base URL in a Worker and throw. So the payloads come from
//     SiteData (env.ASSETS, the same reads every other command makes) and go in
//     through BuilderData.ingestMeta, which is the indexing loadMeta itself uses.
//   * new BuilderData(appData) indexes every species and learnset, which is the
//     one expensive thing on a cold isolate. It is cached as a built object, not
//     as JSON, because the cost is CPU and not the read.
//
// Customization is three free-text fields plus a few named options. One parser
// reads all three. It never silently drops a word: everything it did not
// understand comes back in `unread` and the reply prints it.

import { CalcModel, LEFT, RIGHT, defaultCalcState, defaultMonState } from '../../../builder/calc-model.js';
import { BuilderData, NATURE_ORDER, STAT_ALIASES, STAT_LABELS, bonusTotal, setFromCommon } from '../../../builder/common.js';
import { MAX_BONUS_POINTS_PER_STAT, MAX_BONUS_STAT_POINTS, compact, normalizeBonuses } from '../../../builder/engine.js';
import { TtlCache } from './_cache.js';
import { matchScore } from './_data.js';

export { LEFT, RIGHT, MAX_BONUS_POINTS_PER_STAT, MAX_BONUS_STAT_POINTS };

/** The stage a bare `+2` means on the attacker, by the move's category. */
const STAGE_BY_CATEGORY = { physical: 'attack', special: 'sp_attack' };
const STAGE_ATTR = {
  attack: 'attack_stage', defense: 'defense_stage', sp_attack: 'sp_attack_stage',
  sp_defense: 'sp_defense_stage', speed: 'speed_stage'
};
const STAT_ORDER = ['hp', 'attack', 'defense', 'sp_attack', 'sp_defense', 'speed'];

/** compact("sp.atk") and compact("sp atk") are the same key, so both are read. */
const STAT_INDEX = new Map(Object.entries(STAT_ALIASES).map(([name, index]) => [compact(name), index]));
for (const [name, index] of [
  ['spattack', 3], ['specialattack', 3], ['satk', 3], ['spdefense', 4], ['specialdefense', 4], ['sdef', 4],
  ['hitpoints', 0], ['spd', 4], ['spe', 5]
]) if (!STAT_INDEX.has(name)) STAT_INDEX.set(name, index);

// The page stores a healthy Pokemon as "" and not as "Healthy" (builder/calc-page.js:
// `entry.status = value === "Healthy" ? "" : value`). Store the literal instead and
// Guts, Quick Feet, Marvel Scale, Facade and Hex all fire on a healthy Pokemon.
const STATUS_WORDS = new Map(Object.entries({
  healthy: '', fine: '', none: '', nostatus: '',
  burn: 'Burned', burned: 'Burned', brn: 'Burned',
  poison: 'Poisoned', poisoned: 'Poisoned', psn: 'Poisoned',
  toxic: 'Badly Poisoned', badlypoisoned: 'Badly Poisoned', badpoison: 'Badly Poisoned', tox: 'Badly Poisoned',
  paralyzed: 'Paralyzed', paralysed: 'Paralyzed', paralysis: 'Paralyzed', par: 'Paralyzed', para: 'Paralyzed',
  asleep: 'Asleep', sleep: 'Asleep', sleeping: 'Asleep', slp: 'Asleep',
  frozen: 'Frozen', freeze: 'Frozen', frz: 'Frozen'
}));

const GENDER_WORDS = new Map(Object.entries({
  male: 'Male', female: 'Female', genderless: 'Genderless', nogender: 'Genderless', unspecified: 'Unspecified'
}));

const CLEAR_ITEM = new Set(['noitem', 'itemnone', 'nohelditem', 'itemless', 'item']);
const CLEAR_ABILITY = new Set(['noability', 'abilitynone']);

/** Whichever side of the field a switch belongs to, and what it turns on.
 *  `side: "defender"` is the side contextForSide reads the flag off for the
 *  Pokemon taking the hit, which is why screens, hazards and Friend Guard all
 *  live there while Helping Hand is the attacker's. */
export const FIELD_TOKENS = [
  { keys: ['reflect'], side: 'defender', flag: 'reflect', label: 'Reflect' },
  { keys: ['lightscreen'], side: 'defender', flag: 'light_screen', label: 'Light Screen' },
  { keys: ['auroraveil'], side: 'defender', flag: 'aurora_veil', label: 'Aurora Veil' },
  { keys: ['friendguard'], side: 'defender', flag: 'friend_guard', label: 'Friend Guard' },
  { keys: ['protect'], side: 'defender', flag: 'protect', label: 'Protect' },
  { keys: ['saltcure'], side: 'defender', flag: 'salt_cure', label: 'Salt Cure' },
  { keys: ['stealthrock', 'rocks', 'sr'], side: 'defender', flag: 'stealth_rock', label: 'Stealth Rock' },
  { keys: ['spikes'], side: 'defender', number: { min: 1, max: 3, fallback: 1 }, flag: 'spikes', label: 'Spikes' },
  { keys: ['helpinghand'], side: 'attacker', flag: 'helping_hand', label: 'Helping Hand' },
  { keys: ['charged'], side: 'attacker', flag: 'charged_v445', label: 'Charged' },
  { keys: ['gravity'], ctx: 'gravity', label: 'Gravity' },
  { keys: ['wonderroom'], ctx: 'wonder_room', label: 'Wonder Room' },
  { keys: ['switching', 'switchingin', 'switchedin'], ctx: 'defender_switching', label: 'Defender switching in' },
  { keys: ['movedfirst', 'movingfirst', 'first'], ctx: 'attacker_moved_first', label: 'Attacker moved first' },
  { keys: ['hits'], number: { min: 1, max: 10, fallback: 0 }, count: 'hits', label: 'Hits' },
  { keys: ['use', 'uses'], number: { min: 1, max: 10, fallback: 1 }, count: 'times_used', label: 'Use' },
  { keys: ['timeshit', 'ragefist', 'hitstaken'], number: { min: 0, max: 6, fallback: 0 }, value: 'times_hit', label: 'Times hit' },
  { keys: ['fainted', 'faintedallies'], number: { min: 0, max: 3, fallback: 0 }, value: 'fainted_allies', label: 'Fainted allies' }
];

/** Recognised, deliberately not applied, and said out loud rather than dropped. */
const REFUSED = [
  { keys: ['tailwind'], why: 'Tailwind changes Speed, not damage, so it cannot change this number.' },
  { keys: ['level', 'lvl', 'lv'], why: 'Level is always 50 in Pokemon Champions.' },
  { keys: ['ev', 'evs', 'iv', 'ivs'], why: `This game has no EVs or IVs: the spread is ${MAX_BONUS_STAT_POINTS} bonus points with at most ${MAX_BONUS_POINTS_PER_STAT} in one stat.` },
  { keys: ['spread', 'spreadmove'], why: 'The spread reduction comes from the move itself and no calculator on this site can switch it off. Use format: Singles.' },
  { keys: ['tera', 'terastal', 'teratype'], why: 'Tera types are not part of this game.' }
];

// ------------------------------------------------------- the builder, cached

/** One built BuilderData per isolate: the JSON read is cheap, the indexing is not. */
const builderCache = new TtlCache({ maxEntries: 4 });

export async function builderFor(site, format, cache = builderCache) {
  let bundle = cache.get('builder');
  if (!bundle) {
    const data = new BuilderData(await site.appData());
    bundle = cache.set('builder', { data, dictionaries: dictionaries(data) });
  }
  if (!bundle.data.metaByUsage[format]) bundle.data.ingestMeta(format, await site.usage(format));
  return bundle;
}

/** Every name the free text may hold, compacted once so "never melt ice" and
 *  "Never-Melt Ice" are one key. Built with the BuilderData and cached with it. */
export function dictionaries(data) {
  const items = new Map();
  for (const name of data.itemNames || []) items.set(compact(name), name);
  const abilities = new Map();
  const abilityNames = Array.isArray(data.app?.abilities) ? data.app.abilities : Object.keys(data.app?.abilities || {});
  for (const name of abilityNames) abilities.set(compact(name), name);
  const natures = new Map();
  for (const name of [...NATURE_ORDER, ...Object.keys(data.natures || {})]) natures.set(compact(name), name);
  return { items, abilities, natures };
}

// ------------------------------------------------------------- the free text

/** Comma, semicolon or newline separates one statement; inside one, words. */
function statements(text) {
  return String(text || '').replace(/[;\n\r|/]+/g, ',').split(',').map((part) => part.trim()).filter(Boolean);
}

/**
 * Walk one free-text field, longest phrase first so a multi-word name is never
 * eaten one word at a time.
 *
 * `take(words, at, span)` returns how many words it consumed, or 0. Words nobody
 * took are grouped while they stay consecutive and reported as one phrase: a
 * held item this game does not have should read as `Choice Band`, not as two
 * unknown words that look like typos.
 */
function scan(text, maxSpan, take, onUnread) {
  for (const statement of statements(text)) {
    const words = statement.split(/\s+/).filter(Boolean);
    let at = 0;
    let pending = [];
    const flush = () => {
      if (pending.length) onUnread(pending.join(' '));
      pending = [];
    };
    while (at < words.length) {
      let consumed = 0;
      for (let span = Math.min(maxSpan, words.length - at); span >= 1 && !consumed; span -= 1) {
        consumed = take(words, at, span) || 0;
      }
      if (consumed > 0) {
        flush();
        at += consumed;
      } else {
        pending.push(words[at]);
        at += 1;
      }
    }
    flush();
  }
}

/** "Choice Band" is not in this game; say which of the 199 items it is nearest,
 *  because the useful answer to an unknown name is usually the right one. */
function nearest(phrase, dicts) {
  const wanted = compact(phrase);
  if (wanted.length < 3) return '';
  let best = null;
  for (const [table, what] of [[dicts.items, 'item'], [dicts.abilities, 'Ability'], [dicts.natures, 'nature']]) {
    for (const [key, name] of table) {
      const score = matchScore(wanted, key);
      if (score === null) continue;
      if (!best || score < best.score) best = { score, name, what };
    }
  }
  if (best) return `did you mean the ${best.what} ${best.name}?`;
  // Plenty of familiar items are simply not in this game (there is no Choice
  // Band and no Assault Vest), so say that rather than leave it looking broken.
  return /\s/.test(phrase.trim()) ? 'no held item, Ability or nature in Pokemon Champions is called that' : '';
}

/** A number with an optional sign before it, an optional sign after it, an
 *  optional percent sign and an optional stat word on either side. This is the
 *  whole numeric grammar: sign before the number is a stat stage (`+2 atk`),
 *  sign after it is a Showdown nature marker on a points value (`252+ Atk`),
 *  and a percent sign makes it HP. */
export function splitNumeric(phrase) {
  const first = phrase.match(/^([+-]?)(\d{1,3})\s*([+-]?)\s*(%?)\s*([a-z. ]*)$/i);
  if (first) return { pre: first[1], amount: Number(first[2]), post: first[3], pct: first[4], word: first[5].trim() };
  const last = phrase.match(/^([a-z. ]+?)\s*([+-]?)(\d{1,3})\s*([+-]?)\s*(%?)$/i);
  if (last) return { pre: last[2], amount: Number(last[3]), post: last[4], pct: last[5], word: last[1].trim() };
  return null;
}

const statIndex = (word) => (word ? STAT_INDEX.get(compact(word)) : undefined);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** The nature whose plus is `up` and whose minus is `down`, from app-data. */
function natureFor(data, up, down) {
  if (up === undefined || down === undefined || up === down) return '';
  const wanted = [STAT_LABELS[up].toUpperCase(), STAT_LABELS[down].toUpperCase()];
  for (const [name, pair] of Object.entries(data.natures || {})) {
    if (String(pair?.[0]).toUpperCase() === wanted[0] && String(pair?.[1]).toUpperCase() === wanted[1]) return name;
  }
  return '';
}

/**
 * Read one side's free text onto a set and a mon state.
 *
 * Returns what it did (`read`), what it could not place (`unread`) and what the
 * user should know about what it did (`notes`). The caller prints all three;
 * nothing is dropped in silence.
 */
export function parseSetText(text, { data, dictionaries: dicts, set, entry, categoryStat = '', label = '' } = {}) {
  const read = [];
  const unread = [];
  const notes = [];
  const pending = { up: undefined, down: undefined };
  let sawEvNumber = false;
  let natureNamed = false;

  const takeNumeric = (phrase) => {
    const parsed = splitNumeric(phrase);
    if (!parsed) return false;
    const index = statIndex(parsed.word);
    if (parsed.word && index === undefined) return false;

    // HP percent needs the percent sign, so `32 hp` is always HP points and
    // `60% hp` is always HP left. Without that rule one of the two is a guess.
    if (parsed.pct === '%') {
      if (parsed.word && index !== 0) return false;
      const value = clamp(Math.trunc(parsed.amount), 1, 100);
      entry.hp = value;
      read.push(`${value}% HP`);
      return true;
    }

    if (parsed.pre === '+' || parsed.pre === '-') {
      let stat = index === undefined ? categoryStat : STAT_ORDER[index];
      if (!stat) {
        unread.push(`${phrase} — say which stat, for example \`+2 atk\` or \`+2 spd\``);
        return true;
      }
      if (stat === 'hp') {
        unread.push(`${phrase} — HP has no stat stage`);
        return true;
      }
      const raw = (parsed.pre === '-' ? -1 : 1) * Math.trunc(parsed.amount);
      const stage = clamp(raw, -6, 6);
      entry.stages[STAGE_ATTR[stat]] = stage;
      const label = STAT_LABELS[STAT_ORDER.indexOf(stat)];
      read.push(`${stage > 0 ? '+' : ''}${stage} ${label}`);
      if (stage !== raw) notes.push(`A stat stage only goes to ${raw > 0 ? '+6' : '-6'}, so ${phrase} was read as ${stage > 0 ? '+' : ''}${stage} ${label}.`);
      if (index === undefined) notes.push(`\`${phrase}\` has no stat, so it was read as the stat ${label === 'Atk' ? 'the physical' : 'the special'} move uses.`);
      return true;
    }

    if (index === undefined) return false;
    const typed = Math.trunc(parsed.amount);
    const value = clamp(typed, 0, MAX_BONUS_POINTS_PER_STAT);
    set.bonuses = normalizeBonuses(set.bonuses);
    set.bonuses[index] = value;
    read.push(`${value} ${STAT_LABELS[index]}`);
    if (typed > MAX_BONUS_POINTS_PER_STAT) sawEvNumber = true;
    if (parsed.post === '+') pending.up = index;
    if (parsed.post === '-') pending.down = index;
    return true;
  };

  scan(text, 4, (words, at, span) => {
    const phrase = words.slice(at, at + span).join(' ');
    const flat = compact(phrase);
    const bare = compact(phrase.replace(/\bnature\b/i, ''));

    if (takeNumeric(phrase)) return span;

    const refused = REFUSED.find((rule) => rule.keys.includes(flat) || rule.keys.includes(bare));
    if (refused) {
      unread.push(`${phrase} — ${refused.why}`);
      // "level 100": swallow the number too, or it is reported a second time as
      // a word of its own.
      const next = words[at + span];
      return next && /^\d{1,3}\+?-?$/.test(next) ? span + 1 : span;
    }

    if (CLEAR_ITEM.has(flat)) { set.item = ''; read.push('no item'); return span; }
    if (CLEAR_ABILITY.has(flat)) { set.ability = ''; read.push('no Ability'); return span; }

    if (dicts.natures.has(bare)) {
      set.nature = dicts.natures.get(bare);
      natureNamed = true;
      read.push(set.nature);
      return span;
    }
    if (dicts.items.has(flat)) { set.item = dicts.items.get(flat); read.push(set.item); return span; }
    if (dicts.abilities.has(flat)) { set.ability = dicts.abilities.get(flat); read.push(set.ability); return span; }
    if (STATUS_WORDS.has(flat)) {
      entry.status = STATUS_WORDS.get(flat);
      read.push(entry.status || 'healthy');
      return span;
    }
    if (GENDER_WORDS.has(flat)) { entry.gender = GENDER_WORDS.get(flat); read.push(entry.gender); return span; }
    return 0;
  }, (phrase) => {
    const stem = compact(phrase).replace(/\d+$/, '');
    if (FIELD_TOKENS.some((token) => token.keys.includes(stem))) {
      unread.push(`${phrase} — that is a battlefield switch; put it in \`field\` instead`);
      return;
    }
    const hint = nearest(phrase, dicts);
    unread.push(hint ? `${phrase} — ${hint}` : phrase);
  });

  // "252+ Atk / 0- Spe" is the single most likely paste. Read it, clamp it, and
  // say what was done, because refusing it teaches nothing and applying it in
  // silence hides that this game's numbers are not EVs.
  if (sawEvNumber) {
    notes.push(`This game uses a ${MAX_BONUS_STAT_POINTS}-point bonus budget with at most ${MAX_BONUS_POINTS_PER_STAT} in one stat, not EVs, so anything over ${MAX_BONUS_POINTS_PER_STAT} was read as ${MAX_BONUS_POINTS_PER_STAT}.`);
  }
  if (!natureNamed && (pending.up !== undefined || pending.down !== undefined)) {
    const nature = natureFor(data, pending.up, pending.down);
    if (nature) {
      set.nature = nature;
      read.push(`${nature} (from the + and − marks)`);
    } else {
      notes.push('No nature in this game raises and lowers the stats those + and − marks name, so the nature was left as it was.');
    }
  }
  const total = bonusTotal(set.bonuses);
  if (total > MAX_BONUS_STAT_POINTS) {
    notes.push(`${label ? `${label}: t` : 'T'}hat spread is ${total} of ${MAX_BONUS_STAT_POINTS} bonus points — ${total - MAX_BONUS_STAT_POINTS} over. The site's own calculator says the same and still shows the number.`);
  }
  return { read, unread, notes };
}

/** Read the battlefield free text. Returns the switches, not a mutation, so the
 *  caller can apply them to the model and to the context in one place. */
export function parseFieldText(text) {
  const read = [];
  const unread = [];
  const field = { attacker: {}, defender: {} };
  const ctx = {};
  const counts = {};
  const values = {};

  scan(text, 3, (words, at, span) => {
    const phrase = words.slice(at, at + span).join(' ');
    const flat = compact(phrase);

    const refused = REFUSED.find((rule) => rule.keys.includes(flat));
    if (refused) { unread.push(`${phrase} — ${refused.why}`); return span; }

    // A token that takes a number may carry it in this phrase ("spikes2", or
    // "spikes 2" as one two-word span) or in the word after it.
    const glued = flat.match(/^([a-z]+?)(\d{1,2})$/);
    const stem = glued ? glued[1] : flat;
    const token = FIELD_TOKENS.find((entry) => entry.keys.includes(stem));
    if (!token) return 0;
    let amount = glued ? Number(glued[2]) : null;
    let consumed = span;
    if (token.number && amount === null) {
      const next = words[at + span];
      if (next && /^\d{1,2}$/.test(next)) { amount = Number(next); consumed = span + 1; }
    }
    if (token.number) {
      const value = clamp(amount === null ? token.number.max : Math.trunc(amount), token.number.min, token.number.max);
      if (token.count) counts[token.count] = value;
      else if (token.value) values[token.value] = value;
      else field[token.side][token.flag] = value;
      read.push(`${token.label} ${value}`);
    } else if (token.ctx) {
      ctx[token.ctx] = true;
      read.push(token.label);
    } else {
      field[token.side][token.flag] = true;
      read.push(token.label);
    }
    return consumed;
  }, (phrase) => unread.push(phrase));
  return { field, ctx, counts, values, read, unread };
}

// ----------------------------------------------------------- the calculation

/**
 * CalcModel, plus the four context fields the calculator page has no control for
 * (Gravity, Wonder Room, a switching defender, an attacker that moved first).
 *
 * Overriding contextForSide is how they reach the calculation without a second
 * code path: `calculate` and `bestMove` both build their context through it, so
 * one override covers every number in the reply and the ranking that picks the
 * best move stays the model's own.
 */
export class BotCalcModel extends CalcModel {
  constructor(data, state, extraContext = {}) {
    super(data, state);
    this.extraContext = extraContext;
  }

  contextForSide(side, moveName, critical = false) {
    const ctx = super.contextForSide(side, moveName, critical);
    if (this.extraContext.gravity) ctx.gravity = true;
    if (this.extraContext.wonder_room) ctx.wonder_room = true;
    // These two are read relative to the attacker, so they only apply to the
    // side whose move is being measured.
    if (side === LEFT) {
      if (this.extraContext.defender_switching) ctx.defender_switching = true;
      if (this.extraContext.attacker_moved_first) ctx.attacker_moved_first = true;
    }
    return ctx;
  }
}

/** (species, form) for what the user typed, falling back to the battle name. */
export function pairFor(data, query, profile) {
  for (const candidate of [query, profile?.row ? `${profile.row.form || profile.row.species}` : '', profile?.name]) {
    if (!candidate) continue;
    const pair = data.resolveName(candidate);
    if (data.isAppPair(pair)) return pair;
  }
  return null;
}

const MOVE_NOT_ON_SET = 3;

/**
 * Everything the reply needs, and nothing it does not: the numbers come from
 * CalcModel, the names from BuilderData, the snapshot from SiteData.
 */
export function buildCalculation({ data, dictionaries: dicts, format, attacker, defender, options }) {
  const state = defaultCalcState();
  state.format = format;

  const sides = {};
  for (const [side, profile, pair] of [[LEFT, attacker.profile, attacker.pair], [RIGHT, defender.profile, defender.pair]]) {
    const common = data.commonSet(format, pair[0], pair[1]);
    state.mons[side] = defaultMonState(setFromCommon(common));
    sides[side] = { profile, common, customized: false, read: [], unread: [], notes: [] };
  }

  const critical = Boolean(options.crit);
  const parsed = parseFieldText(options.field || '');
  const model = new BotCalcModel(data, state, parsed.ctx);

  // Weather: effectiveWeather() only looks at state.weather when weatherMode is
  // not "Auto" (builder/calc-model.js), so setting the value alone does nothing.
  if (options.weather && options.weather !== 'Auto') {
    state.weather = options.weather;
    state.weatherMode = 'Manual';
  }
  // Terrain: effectiveTerrain() ignores an explicit "None" and then scans both
  // sides' abilities, so "None" against a Grassy Surge is only real as the
  // ability override the page's own effect chips use.
  if (options.terrain && options.terrain !== 'Auto') {
    state.terrain = options.terrain === 'None' ? 'None' : options.terrain;
    if (options.terrain === 'None') {
      for (const side of [LEFT, RIGHT]) {
        const ability = model.engine.effectiveMegaMon(model.mon(side)).ability || '';
        if (compact(ability) && (data.app?.terrainSetters || {})[String(ability).toLowerCase()] !== undefined) {
          state.effectOverrides[model.effectKey(side, 'ability', ability)] = false;
        }
      }
    }
  }

  // The move first, because a bare `+2` on the attacker means the stat the move
  // uses and the parser needs to know which that is.
  const wantedMove = String(options.move || '').trim();
  // canonicalMoveName echoes a name it does not know, so the move table decides.
  const canonicalMove = wantedMove && data.engine.moveRecord(wantedMove)
    ? data.engine.canonicalMoveName(wantedMove)
    : '';
  const attackerSet = state.mons[LEFT].set;
  const move = { asked: wantedMove, name: canonicalMove, chosen: false, replaced: '', unknown: false, illegal: false };
  if (wantedMove && !canonicalMove) {
    move.unknown = true;
  } else if (canonicalMove) {
    move.chosen = true;
    const at = attackerSet.moves.findIndex((name) => compact(name) === compact(canonicalMove));
    if (at >= 0) {
      move.index = at;
    } else {
      // The page's move picker replaces a slot; do the same, deterministically,
      // and name what went out so the four moves shown are never a fiction.
      move.index = Math.min(MOVE_NOT_ON_SET, Math.max(0, attackerSet.moves.length - 1));
      if (attackerSet.moves.length === 0) move.index = 0;
      move.replaced = attackerSet.moves[move.index] || '';
      const moves = [...attackerSet.moves];
      moves[move.index] = canonicalMove;
      attackerSet.moves = moves;
    }
    const learnset = data.learnset(attackerSet.species, attackerSet.form) || [];
    move.illegal = learnset.length > 0 && !learnset.some((name) => compact(name) === compact(canonicalMove));
  }

  const categoryStat = (() => {
    if (!move.chosen) return '';
    const meta = model.moveMetaFor(canonicalMove);
    return STAGE_BY_CATEGORY[String(meta?.category || '').toLowerCase()] || '';
  })();

  // Free text per side, then the named options, which win because a user who
  // picked one from the list meant it.
  for (const [side, text] of [[LEFT, options.attacker_set], [RIGHT, options.defender_set]]) {
    if (!String(text || '').trim()) continue;
    const outcome = parseSetText(text, {
      data,
      dictionaries: dicts,
      set: state.mons[side].set,
      entry: state.mons[side],
      categoryStat: side === LEFT ? categoryStat : '',
      label: sides[side].profile.name
    });
    sides[side].read = outcome.read;
    sides[side].unread = outcome.unread;
    sides[side].notes = outcome.notes;
    sides[side].customized = outcome.read.length > 0;
    sides[side].emptyParse = outcome.read.length === 0;
  }
  if (Number.isFinite(Number(options.defender_hp)) && Number(options.defender_hp) > 0) {
    state.mons[RIGHT].hp = clamp(Math.trunc(Number(options.defender_hp)), 1, 100);
    sides[RIGHT].read = [...sides[RIGHT].read.filter((line) => !/% HP$/.test(line)), `${state.mons[RIGHT].hp}% HP`];
    if (state.mons[RIGHT].hp !== 100) sides[RIGHT].customized = true;
  }

  // The battlefield, after the sets, so `spikes`/`hits` see the real items.
  for (const [side, key] of [[LEFT, 'attacker'], [RIGHT, 'defender']]) {
    Object.assign(state.field[side], parsed.field[key]);
  }
  for (const [name, value] of Object.entries(parsed.values)) state.effectValues[`${LEFT}:${name}`] = value;
  state.critical = critical;

  const results = [];
  const moveNames = state.mons[LEFT].set.moves.filter(Boolean).slice(0, 4);
  // A chosen hit count or use number belongs to the move it was chosen for, so
  // it is stored per move the way the page's amount pickers store it.
  for (const name of moveNames) {
    for (const spec of model.countSpecs(LEFT, name)) {
      const amount = parsed.counts[spec.kind];
      if (amount !== undefined) model.setCountValue(spec.storeKey, amount, spec.default);
    }
  }

  let chosen = null;
  if (move.chosen && move.index !== undefined) {
    state.selectedSide = LEFT;
    state.selectedIndex = move.index;
    const result = model.calculate(LEFT, move.index, critical);
    chosen = result ? { move: canonicalMove, index: move.index, result } : null;
  } else {
    moveNames.forEach((name, index) => {
      const result = model.calculate(LEFT, index, critical);
      if (result) results.push({ move: name, index, result });
    });
    const best = model.bestMove(LEFT);
    if (best) {
      chosen = best;
      state.selectedSide = LEFT;
      state.selectedIndex = best.index;
    }
  }

  const spreadNote = (() => {
    if (!chosen || format !== 'Doubles') return '';
    // Read the flag off the same context the calculation used: a few moves keep
    // their spread flag for one target and most lose it, so a blanket sentence
    // would be wrong for one group or the other.
    const meta = model.engine.moveMeta(model.contextForSide(LEFT, chosen.move, critical));
    return meta?.spread ? `Spread move: −25% in Doubles (format: Singles removes it)` : '';
  })();

  const weather = model.effectiveWeather();
  const terrain = model.effectiveTerrain();
  const sourceOf = (table, wanted) => {
    if (!wanted || wanted === 'None') return '';
    for (const side of [LEFT, RIGHT]) {
      const ability = model.engine.effectiveMegaMon(model.mon(side)).ability || '';
      const set = table[String(ability).toLowerCase()] ?? table[ability];
      if (set === wanted) return ability;
    }
    return '';
  };

  const describe = (side) => {
    const entry = state.mons[side];
    const set = entry.set;
    const stages = Object.entries(STAGE_ATTR)
      .filter(([, attr]) => Number(entry.stages[attr]) !== 0)
      .map(([stat, attr]) => `${entry.stages[attr] > 0 ? '+' : ''}${entry.stages[attr]} ${STAT_LABELS[STAT_ORDER.indexOf(stat)]}`);
    return {
      ...sides[side],
      set,
      battleName: data.setName(set) || data.displayName(set.species, set.form),
      stages,
      status: entry.status,
      gender: entry.gender === 'Unspecified' ? '' : entry.gender,
      hp: entry.hp,
      points: bonusTotal(set.bonuses),
      field: state.field[side]
    };
  };

  return {
    format,
    critical,
    move,
    chosen,
    results,
    model,
    attacker: describe(LEFT),
    defender: describe(RIGHT),
    conditions: {
      weather,
      weatherAuto: state.weatherMode === 'Auto',
      weatherFrom: state.weatherMode === 'Auto' ? sourceOf({ ...(data.app?.weatherSetters || {}) }, weather) : '',
      terrain,
      terrainFrom: sourceOf(data.app?.terrainSetters || {}, terrain),
      spreadNote,
      field: { attacker: state.field[LEFT], defender: state.field[RIGHT] },
      // Context switches the page has no control for: applied, so shown.
      extra: FIELD_TOKENS.filter((token) => token.ctx && parsed.ctx[token.ctx]).map((token) => token.label),
      // The page's own line for a hit count, a use number, Rage Fist's hits and
      // fainted allies -- and the only honest way to show that a `hits 5` the
      // chosen move has no use for did not reach it.
      moveNotes: chosen ? model.headerNotes(LEFT, chosen.move) : []
    },
    fieldRead: parsed.read,
    fieldUnread: parsed.unread,
    koOdds: chosen ? koLine(model, chosen.result) : ''
  };
}

/** The KO line in this game's own words, plus the engine's Salt Cure tail. */
export function koLine(model, result) {
  if (!result) return '';
  const odds = model.formatKoOdds(result);
  const tail = String(result.ko || '').split('|').slice(1).map((part) => part.trim()).filter(Boolean);
  return [odds, ...tail].filter(Boolean).join(' · ');
}

/** Resolve both Pokemon, read the files and hand back the calculation. */
export async function damageCalculation(site, options) {
  const format = site.format(options.format);
  const [attackerProfile, defenderProfile] = await Promise.all([
    site.profile(options.attacker, format),
    site.profile(options.defender, format)
  ]);
  if (!attackerProfile.ok) return { notFound: attackerProfile };
  if (!defenderProfile.ok) return { notFound: defenderProfile };

  const { data, dictionaries: dicts } = await builderFor(site, format);
  const attackerPair = pairFor(data, options.attacker, attackerProfile);
  const defenderPair = pairFor(data, options.defender, defenderProfile);
  if (!attackerPair) return { noUsage: attackerProfile };
  if (!defenderPair) return { noUsage: defenderProfile };

  const calculation = buildCalculation({
    data,
    dictionaries: dicts,
    format,
    attacker: { profile: attackerProfile, pair: attackerPair },
    defender: { profile: defenderProfile, pair: defenderPair },
    options
  });
  if (!calculation.chosen && !calculation.results.length) return { noMoves: attackerProfile, calculation };
  return { calculation, snapshot: attackerProfile.snapshot };
}
