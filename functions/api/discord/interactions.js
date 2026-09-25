// Discord interactions endpoint: POST /api/discord/interactions
//
// The bot is this one Pages Function. Discord's HTTP interactions transport
// posts a signed request per slash command and the Function answers it, so
// there is no gateway connection, no process to keep alive and no second host:
// it deploys, scales and costs exactly what the rest of this site does, and it
// reads the site's own data through env.ASSETS.
//
// Discord drops an interaction that is not answered within three seconds and
// shows the user "The application did not respond". Only /help is answered in
// the first response; every command that reads battle data replies DEFERRED
// (type 5, "Bot is thinking...") and then edits that message through the
// interaction webhook, which stays valid for 15 minutes. The edit needs no bot
// token: the interaction token in the signed body authorises it. So the only
// value this Function needs is DISCORD_PUBLIC_KEY, which is not a secret.
//
// Autocomplete cannot be deferred, so it answers inline, is completed from the
// smallest list that fits the option, and gives up inside a two-second budget
// rather than letting Discord time the box out.
//
// Finished replies are cached for five minutes by command, arguments and
// format (_cache.js), so the same question asked repeatedly in a busy server
// reads nothing. The cache is module scope, which on Workers means per isolate.
//
//   DISCORD_PUBLIC_KEY  required   the application's Ed25519 public key (hex)
//   DISCORD_APP_ID      optional   refuses to answer another application
//   SITE_ORIGIN         optional   overrides https://championsbattledata.com

import { jsonResponse, optionsResponse } from '../_common.js';
import { readSignedBody } from './_verify.js';
import { SiteData, SITE_ORIGIN, DEFAULT_FORMAT } from './_data.js';
import { replyCache, replyKey } from './_cache.js';
import { COMMANDS, IMMEDIATE_COMMANDS, AUTOCOMPLETE_KINDS, SUBJECT_OPTIONS, optionValue, focusedOption, TYPE_NAMES } from './_commands.js';
import {
  notFoundReply, noUsageReply, noMovesReply, errorReply, pokemonReply, movesReply, itemsReply, teammatesReply,
  metaReply, compareReply, speedReply, speedTable, matchupReply, counterList, countersReply, damageReply, helpReply,
  EPHEMERAL
} from './_render.js';
import { damageCalculation } from './_damage.js';

export const INTERACTION_PING = 1;
export const INTERACTION_COMMAND = 2;
export const INTERACTION_AUTOCOMPLETE = 4;

export const RESPONSE_PONG = 1;
export const RESPONSE_MESSAGE = 4;
export const RESPONSE_DEFERRED = 5;
export const RESPONSE_AUTOCOMPLETE = 8;

const DISCORD_API = 'https://discord.com/api/v10';
const FOLLOW_UP_TIMEOUT_MS = 12000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------- command work

const HANDLERS = {
  async pokemon(data, options, origin) {
    const profile = await data.profile(optionValue(options, 'pokemon'), optionValue(options, 'format'));
    if (!profile.ok) return notFoundReply(profile, origin);
    if (!profile.row) return noUsageReply(profile, origin);
    return pokemonReply(profile, await data.appData(), origin);
  },

  async moves(data, options, origin) {
    const profile = await data.profile(optionValue(options, 'pokemon'), optionValue(options, 'format'));
    if (!profile.ok) return notFoundReply(profile, origin);
    if (!profile.row) return noUsageReply(profile, origin);
    return movesReply(profile, await data.appData(), origin, optionValue(options, 'move', ''));
  },

  async items(data, options, origin) {
    const profile = await data.profile(optionValue(options, 'pokemon'), optionValue(options, 'format'));
    if (!profile.ok) return notFoundReply(profile, origin);
    if (!profile.row) return noUsageReply(profile, origin);
    return itemsReply(profile, await data.descriptions(), origin, optionValue(options, 'item', ''));
  },

  async teammates(data, options, origin) {
    const profile = await data.profile(optionValue(options, 'pokemon'), optionValue(options, 'format'));
    if (!profile.ok) return notFoundReply(profile, origin);
    if (!profile.row) return noUsageReply(profile, origin);
    const usage = await data.usage(profile.format);
    return teammatesReply(profile, usage.pokemon || [], origin);
  },

  async meta(data, options, origin) {
    const format = data.format(optionValue(options, 'format'));
    const top = Math.min(25, Math.max(5, Number(optionValue(options, 'top', 10)) || 10));
    const [usage, snapshot] = await Promise.all([data.usage(format), data.currentSnapshot()]);
    return metaReply(usage.pokemon || [], format, snapshot, top, origin);
  },

  async compare(data, options, origin) {
    const format = optionValue(options, 'format');
    const [first, second] = await Promise.all([
      data.profile(optionValue(options, 'first'), format),
      data.profile(optionValue(options, 'second'), format)
    ]);
    if (!first.ok) return notFoundReply(first, origin);
    if (!second.ok) return notFoundReply(second, origin);
    return compareReply(first, second, origin);
  },

  async speed(data, options, origin) {
    const profile = await data.profile(optionValue(options, 'pokemon'), optionValue(options, 'format'));
    if (!profile.ok) return notFoundReply(profile, origin);
    const [usage, appData] = await Promise.all([data.usage(profile.format), data.appData()]);
    return speedReply(profile, speedTable(usage.pokemon || [], appData), origin);
  },

  async matchup(data, options, origin) {
    const appData = await data.appData();
    const chart = appData.typeChart || {};
    const known = new Set(Object.keys(chart).length ? Object.keys(chart) : TYPE_NAMES);
    const types = [optionValue(options, 'type'), optionValue(options, 'second_type')]
      .filter((type) => type && known.has(type));
    if (!types.length) {
      return notFoundReply({ query: optionValue(options, 'type') || '', suggestions: TYPE_NAMES.slice(0, 3) }, origin);
    }
    return matchupReply([...new Set(types)], chart, origin);
  },

  async counters(data, options, origin) {
    const profile = await data.profile(optionValue(options, 'pokemon'), optionValue(options, 'format'));
    if (!profile.ok) return notFoundReply(profile, origin);
    const [usage, appData] = await Promise.all([data.usage(profile.format), data.appData()]);
    const types = profile.form?.types || profile.identity?.types || [];
    const counters = counterList(usage.pokemon || [], appData, types, profile.name);
    return countersReply(profile, counters, appData.typeChart || {}, origin);
  },

  /** The one command that calculates rather than reads. Everything it needs is
   *  the two names plus whatever was customized; the numbers come out of
   *  builder/engine.js through _damage.js. */
  async damage(data, options, origin) {
    const outcome = await damageCalculation(data, {
      attacker: optionValue(options, 'attacker'),
      defender: optionValue(options, 'defender'),
      move: optionValue(options, 'move', ''),
      format: optionValue(options, 'format'),
      attacker_set: optionValue(options, 'attacker_set', ''),
      defender_set: optionValue(options, 'defender_set', ''),
      weather: optionValue(options, 'weather', 'Auto'),
      terrain: optionValue(options, 'terrain', 'Auto'),
      field: optionValue(options, 'field', ''),
      crit: optionValue(options, 'crit', false) === true,
      defender_hp: optionValue(options, 'defender_hp', null)
    });
    if (outcome.notFound) return notFoundReply(outcome.notFound, origin);
    if (outcome.noUsage) return noUsageReply(outcome.noUsage, origin);
    if (outcome.noMoves) return noMovesReply(outcome.noMoves, origin);
    return damageReply(outcome.calculation, origin, outcome.snapshot);
  },

  async help(data, options, origin) {
    return helpReply(COMMANDS, origin);
  }
};

// ----------------------------------------------------------------- routing

export function originOf(env) {
  return String(env?.SITE_ORIGIN || SITE_ORIGIN).replace(/\/+$/, '');
}

/** Autocomplete cannot be deferred, so it is capped: past the budget it answers
 *  with an empty list, which Discord shows as "no results" rather than failing. */
export async function withBudget(promise, ms, fallback) {
  let timer = null;
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const AUTOCOMPLETE_BUDGET_MS = 2000;
export const AUTOCOMPLETE_LIMIT = 25;

/** Complete the focused option from the list that fits it. */
export async function completeOption(data, options, focused) {
  const kind = AUTOCOMPLETE_KINDS[focused.name];
  if (!kind || !data) return [];
  const format = optionValue(options, 'format');
  // Which Pokemon a move or item box belongs to. Without /damage's `attacker`
  // here, its move box would complete from all 955 moves instead of the ten the
  // attacker actually runs -- the whole quality of that box.
  const pokemon = SUBJECT_OPTIONS.reduce((found, name) => found || optionValue(options, name), null);
  if (kind === 'move') return data.completeMoves(focused.value, { pokemon, format }, AUTOCOMPLETE_LIMIT);
  if (kind === 'item') return data.completeItems(focused.value, { pokemon, format }, AUTOCOMPLETE_LIMIT);
  return data.completions(focused.value, AUTOCOMPLETE_LIMIT);
}

/** Decide the immediate response, and what (if anything) runs after it. */
export async function routeInteraction(interaction, { data, origin = SITE_ORIGIN, cache = replyCache } = {}) {
  const type = interaction?.type;

  if (type === INTERACTION_PING) return { response: { type: RESPONSE_PONG }, work: null };

  if (type === INTERACTION_AUTOCOMPLETE) {
    const options = interaction?.data?.options || [];
    const focused = focusedOption(options);
    let choices = [];
    if (focused) {
      const names = await withBudget(
        completeOption(data, options, focused).catch(() => []),
        AUTOCOMPLETE_BUDGET_MS,
        []
      );
      choices = names.slice(0, AUTOCOMPLETE_LIMIT).map((name) => ({ name: String(name).slice(0, 100), value: String(name).slice(0, 100) }));
    }
    return { response: { type: RESPONSE_AUTOCOMPLETE, data: { choices } }, work: null };
  }

  if (type !== INTERACTION_COMMAND) {
    return {
      response: { type: RESPONSE_MESSAGE, data: { content: 'This bot only answers slash commands. Try `/help`.', flags: EPHEMERAL } },
      work: null
    };
  }

  const name = String(interaction?.data?.name || '').toLowerCase();
  const options = interaction?.data?.options || [];
  const handler = HANDLERS[name];
  if (!handler) {
    return {
      response: { type: RESPONSE_MESSAGE, data: { content: `\`/${name}\` is not a command this bot knows. Try \`/help\`.`, flags: EPHEMERAL } },
      work: null
    };
  }

  // /help needs no data, so it lands inside Discord's three-second window with
  // room to spare. Everything else reads the site's files and defers first.
  if (IMMEDIATE_COMMANDS.has(name)) {
    return { response: { type: RESPONSE_MESSAGE, data: await handler(data, options, origin) }, work: null };
  }

  // The same question asked again in a busy server is answered from the cache
  // and reads nothing. A handler that threw is not cached, so a blip does not
  // stick around for five minutes.
  const key = replyKey(name, options, data ? data.format(optionValue(options, 'format')) : DEFAULT_FORMAT);
  const run = async () => {
    const hit = cache?.get(key);
    if (hit !== undefined) return hit;
    const payload = await handler(data, options, origin);
    cache?.set(key, payload);
    return payload;
  };
  return { response: { type: RESPONSE_DEFERRED, data: {} }, work: run, cacheKey: key };
}

// ------------------------------------------------------- deferred follow-up

/** One Discord call, retried while Discord asks us to slow down; three tries at most. */
export async function discordFetch(url, init, { fetchImpl = fetch, sleep = wait, attempts = 3 } = {}) {
  let response = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    response = await fetchImpl(url, init);
    if (response.status !== 429 && response.status < 500) return response;
    if (attempt === attempts) return response;
    // Discord answers 429 with retry_after in seconds; honour it, but never
    // hold the isolate longer than the follow-up window is worth.
    let delay = 1000;
    if (response.status === 429) {
      const body = await response.clone().json().catch(() => ({}));
      delay = Math.min(5000, Math.max(200, Math.round(Number(body.retry_after || 1) * 1000)));
    }
    await sleep(delay);
  }
  return response;
}

/** Edit the deferred "thinking" message into the real answer. */
export async function sendFollowUp(interaction, payload, options = {}) {
  const url = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  return discordFetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, options);
}

export async function runWork(work, origin, timeoutMs = FOLLOW_UP_TIMEOUT_MS, sleep = wait) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(errorReply('That took too long to read.', origin)), timeoutMs);
  });
  try {
    return await Promise.race([
      work().catch(() => errorReply('Something went wrong reading the battle data.', origin)),
      timeout
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// -------------------------------------------------------------- the handler

export const onRequestOptions = () => optionsResponse();

/** A plain check that the route is live; it says nothing a secret could leak. */
export function onRequestGet({ env }) {
  return jsonResponse({
    endpoint: '/api/discord/interactions',
    method: 'POST',
    commands: COMMANDS.map((command) => command.name),
    configured: Boolean(env?.DISCORD_PUBLIC_KEY),
    site: originOf(env)
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = originOf(env);

  const verified = await readSignedBody(request, env?.DISCORD_PUBLIC_KEY);
  if (!verified.ok) {
    // Discord requires a 401 here: it saves an interactions endpoint URL only
    // after a deliberately invalid signature has been rejected.
    return new Response(verified.reason === 'missing public key' ? 'not configured' : 'invalid request signature', {
      status: verified.status
    });
  }

  let interaction;
  try {
    interaction = JSON.parse(verified.rawBody);
  } catch {
    return new Response('bad request body', { status: 400 });
  }

  if (env?.DISCORD_APP_ID && interaction.application_id && String(interaction.application_id) !== String(env.DISCORD_APP_ID)) {
    return new Response('unexpected application', { status: 401 });
  }

  const data = new SiteData(env, request, { origin });
  let routed;
  try {
    routed = await routeInteraction(interaction, { data, origin });
  } catch {
    routed = { response: { type: RESPONSE_MESSAGE, data: errorReply('Something went wrong.', origin) }, work: null };
  }

  if (routed.work) {
    const followUp = (async () => {
      const payload = await runWork(routed.work, origin);
      await sendFollowUp(interaction, payload).catch(() => {});
    })();
    if (typeof context.waitUntil === 'function') context.waitUntil(followUp);
    else await followUp;
  }

  return new Response(JSON.stringify(routed.response), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
