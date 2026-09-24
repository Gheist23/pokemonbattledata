// A small time-to-live cache, used twice: in front of the site files the bot
// reads, and in front of the finished replies.
//
// It lives in module scope, so on Cloudflare Workers it is per isolate: each
// isolate warms its own copy, an isolate that is recycled loses it, and two
// requests can land on different isolates and both miss. That is fine for what
// this is -- an optimisation, never a source of truth -- and it is why nothing
// here is allowed to matter for correctness. What it must not do is grow
// without bound or answer with yesterday's ranking, so every entry expires
// after TTL_MS and the map is capped at MAX_ENTRIES.
//
// The daily pipeline rewrites the data files each morning, which is the real
// reason for the TTL: a warm isolate that never expired its copy would answer
// with the previous day's usage all day.

export const TTL_MS = 300_000;
export const MAX_ENTRIES = 200;

export class TtlCache {
  constructor({ ttlMs = TTL_MS, maxEntries = MAX_ENTRIES, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so the oldest key to evict is the one least recently wanted.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return value;
  }

  /** Run `load` once per key while the entry is fresh. */
  async wrap(key, load) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    return this.set(key, await load());
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }
}

/** Finished replies, keyed by the question that was asked. Shared per isolate. */
export const replyCache = new TtlCache();

/** The key a command and its arguments cache under: same question, same key. */
export function replyKey(name, options, format) {
  const parts = (options || [])
    .filter((option) => option && option.name !== 'format' && option.value !== undefined && option.value !== '')
    .map((option) => `${option.name}=${String(option.value).trim().toLowerCase()}`)
    .sort();
  return [name, `format=${format}`, ...parts].join('|');
}
