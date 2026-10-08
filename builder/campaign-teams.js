// /team-builder/?campaign=<code> -- the teams from a creator collaboration,
// already in the library when the visitor arrives.
//
// Somebody who typed a URL off a YouTube video has about two seconds of
// patience, so the point of this file is that there is nothing to do on
// arrival: the teams are there, the first one is open, and the overview below
// is already scoring it.
//
// THREE RULES IT HOLDS TO.
//
//   1. IT NEVER TAKES ANYTHING AWAY.  Every team is ADDED.  A visitor who has
//      been building for a month keeps all of it; the campaign's teams go in
//      beside theirs, and the one that ends up open is the campaign's first.
//
//   2. IT ONLY HAPPENS ONCE.  The code is remembered in localStorage, so a
//      reload, a back button or a second visit from the pinned comment does not
//      hand anybody a second set of five. `?campaign=giuseppe&again=1` is the
//      way back in for the person checking that it still works.
//
//   3. IT CANNOT BREAK THE PAGE.  A missing file, a 404, a team whose paste no
//      longer resolves: each one is skipped and the Team Builder opens normally.
//      Nothing here is allowed to throw into the page's boot.

const SEEN_KEY = "cbd.campaign.loaded";

/** "" for anything that is not a campaign code, so the fetch below can only
 *  ever reach a file under data/campaigns/. */
export function cleanCampaignCode(raw) {
  const code = String(raw || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return code.length >= 2 && code.length <= 32 ? code : "";
}

function alreadyLoaded(code) {
  try {
    return (JSON.parse(localStorage.getItem(SEEN_KEY) || "[]") || []).includes(code);
  } catch {
    return false;
  }
}

function remember(code) {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]") || [];
    if (!seen.includes(code)) seen.push(code);
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-20)));
  } catch {
    // Private browsing with storage switched off: the teams still load, they
    // just load again next time. That is the right way round.
  }
}

export async function loadCampaign(code) {
  // `cache: "no-store"`, not the usual default: this file is edited between the
  // page going up and the video going out, and a visitor who looked early must
  // not be served the empty version from their own cache on the day.
  const response = await fetch(`/data/campaigns/${code}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`campaign ${code}: ${response.status}`);
  return response.json();
}

/**
 * Put a campaign's teams into the library.
 *
 * @param {string}   code        the campaign, from ?campaign=
 * @param {object}   deps
 * @param {Function} deps.parse  a Showdown paste -> sets
 * @param {Function} deps.add    (sets, title) -> adds a team and selects it
 * @param {Function} [deps.setFormat]
 * @param {Function} [deps.fetchCampaign] to read the file some other way (tests)
 * @param {object}   [options]   { force } to load again over the once-only rule;
 *                               { only } a 1-based team number, for a link that
 *                               offers ONE team and must not quietly add five
 * @returns {Promise<{loaded: number, titles: string[], campaign: object|null}>}
 */
export async function installCampaignTeams(code, deps, { force = false, only = 0 } = {}) {
  const empty = { loaded: 0, titles: [], campaign: null };
  const clean = cleanCampaignCode(code);
  if (!clean) return empty;
  // One team asked for by number is always honoured: the "seen" rule is there
  // so a reload does not re-add the whole set, not to refuse a second team.
  if (!force && !only && alreadyLoaded(clean)) return { ...empty, skipped: "seen" };

  let campaign;
  try {
    campaign = await (deps.fetchCampaign || loadCampaign)(clean);
  } catch {
    return empty;
  }

  const teams = Array.isArray(campaign?.teams) ? campaign.teams : [];
  // The format the teams were built for, decided before any team is read: a
  // Doubles team scored against the Singles meta is a different team.
  const format = campaign?.format;
  if (deps.setFormat && (format === "Singles" || format === "Doubles")) deps.setFormat(format);

  const titles = [];
  // Backwards, because each team added becomes the selected one: the visitor
  // ends up looking at the FIRST team of the video, not the last.
  for (let index = teams.length - 1; index >= 0; index -= 1) {
    if (only && index !== only - 1) continue;
    const entry = teams[index];
    const paste = String(entry?.showdown || "").trim();
    if (!paste) continue;
    let sets = [];
    try {
      sets = deps.parse(paste) || [];
    } catch {
      continue; // one unreadable paste must not cost the other four
    }
    if (!sets.length) continue;
    const title = String(entry?.title || "").trim() || `${campaign?.creator?.name || clean} team ${index + 1}`;
    deps.add(sets.slice(0, 6), title);
    titles.unshift(title);
  }

  if (titles.length) remember(clean);
  return { loaded: titles.length, titles, campaign };
}
