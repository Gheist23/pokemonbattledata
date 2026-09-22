// Suggestions that complete a real team (the app's known_team_prediction, V496).
//
// The Companion ships a library of tournament teams (data/builder/known-teams.json,
// written by pct_tool94/tools/export_web_builder_data.py with the app's own name
// resolution). When a saved team already shares five of our Pokemon and also has
// the candidate, the candidate is what the players who brought that team ran:
// the suggestion gets +14, "Found in similar team (file)", and that team's item,
// Ability, moves and Nature.

const taKey = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

export const FOUND_IN_TEAM_NOTE = "Found in similar team";

// Roster keys are battle-data names, and the app's tables spell some Pokemon
// two ways: the library files Basculegion as "Basculegion Male" while a team
// may hold the table's second "Basculegion" row ("Heat Rotom" / "Rotom Heat"
// likewise).  BuilderData (builder/common.js) registers a map from every app
// spelling to its Showdown identity when it loads, so both count as the same
// member.  Without it (the parity tests run the bare engine) a key is itself.
let rosterIdentity = null;

/** @param {((key: string) => string) | null} identity  roster key -> identity key */
export function setRosterIdentity(identity) {
  rosterIdentity = typeof identity === "function" ? identity : null;
}

function rosterKey(key) {
  return rosterIdentity ? rosterIdentity(key) || key : key;
}

export class KnownTeams {
  /** @param {{minOverlap:number, bonus:number, battleDataForms:string[], teams:Array}} payload */
  constructor(payload = {}) {
    this.minOverlap = Number(payload.minOverlap) || 5;
    this.bonus = Number(payload.bonus) || 14;
    this.battleForms = new Set(payload.battleDataForms || []);
    this.teams = (payload.teams || []).map(([name, rows]) => {
      const members = (rows || []).map(([species, form, item, ability, nature, moves, roster]) => ({
        species, form: form || species, item, ability, nature, moves: moves || [], roster: roster || taKey(species),
      }));
      return { name, members, counts: null, countsFor: undefined };
    });
  }

  /** A team's roster keys as counts, under the identity map in use (worked out on first use,
   *  since the library may load before BuilderData registers the map). */
  teamCounts(team) {
    if (!team.counts || team.countsFor !== rosterIdentity) {
      team.counts = countKeys(team.members.map((m) => rosterKey(m.roster)));
      team.countsFor = rosterIdentity;
    }
    return team.counts;
  }

  /** _v494_battle_data_name: the form's name when it has its own file, else the species. */
  battleDataName(species, form) {
    const s = String(species || "").trim();
    const f = String(form || "").trim();
    if (!f || f.toLowerCase() === s.toLowerCase()) return s;
    return this.battleForms.has(taKey(f)) ? f : s;
  }

  /** known_team_prediction.roster_key as counts; empty when any slot has no name. */
  rosterCounts(entries) {
    const keys = [];
    for (const entry of entries || []) {
      const species = String(entry?.pokemon ?? entry?.species ?? "");
      const form = String(entry?.form || species);
      const name = species || form ? this.battleDataName(species, form) : "";
      if (!name) return {};
      keys.push(rosterKey(taKey(name)));
    }
    return countKeys(keys);
  }

  /** _v494_team_overlap */
  overlap(team, present) {
    const wanted = this.rosterCounts(present);
    const counts = this.teamCounts(team);
    return Object.entries(wanted).reduce((sum, [key, count]) => sum + Math.min(count, counts[key] || 0), 0);
  }

  /** _v494_member_for: by form first, then by species. */
  memberFor(team, formKey, speciesKey) {
    return team.members.find((m) => taKey(m.form) === formKey) || team.members.find((m) => taKey(m.species) === speciesKey) || null;
  }

  /** _v494_team_corroboration: how much of our own sets the saved team agrees with. */
  corroboration(team, present) {
    let score = 0;
    for (const entry of present) {
      const member = this.memberFor(team, taKey(entry.form || entry.pokemon), taKey(entry.pokemon));
      if (!member) continue;
      if (entry.item && taKey(entry.item) === taKey(member.item)) score += 1;
      const read = new Set((entry.moves || []).filter((m) => String(m || "").trim()).map(taKey));
      const saved = new Set((member.moves || []).map(taKey));
      if (read.size && saved.size) score += [...read].filter((m) => saved.has(m)).length / saved.size;
    }
    return score;
  }

  /** known_team_prediction.completing_member: [team, member] or null. */
  completingMember(ourTeam, species, form) {
    const present = (ourTeam || []).filter((e) => e && String(e.pokemon ?? e.species ?? "").trim());
    if (!present.length) return null;
    const formKey = taKey(form || species);
    const speciesKey = taKey(species);
    const found = [];
    for (const team of this.teams) {
      const member = this.memberFor(team, formKey, speciesKey);
      if (!member) continue;
      const shared = this.overlap(team, present);
      if (shared >= this.minOverlap) found.push({ shared, team, member });
    }
    if (!found.length) return null;
    const best = Math.max(...found.map((f) => f.shared));
    const ranked = found.filter((f) => f.shared === best)
      .map((f) => ({ ...f, corroboration: this.corroboration(f.team, present) }))
      .sort((a, b) => b.corroboration - a.corroboration || (a.team.name < b.team.name ? -1 : a.team.name > b.team.name ? 1 : 0));
    return [ranked[0].team, ranked[0].member];
  }
}

/** The number in a file name ("team2058.txt" -> 2058). */
export function teamNumber(name) {
  return Number((String(name).match(/\d+/) || [0])[0]) || 0;
}

/**
 * The saved tournament team closest to a team: most Pokémon in common (Megas as their
 * species), then the most matching items and moves, then the lower file number.
 * @param {KnownTeams} known
 * @param {Array<{pokemon, form, item, moves}>} entries
 */
export function mostSimilarTeam(known, entries) {
  const present = (entries || []).filter((e) => e && String(e.pokemon || "").trim());
  if (!known || !present.length) return null;
  let best = null;
  for (const team of known.teams) {
    const overlap = known.overlap(team, present);
    if (!best || overlap > best.overlap || (overlap === best.overlap && overlap > 0)) {
      const corroboration = known.corroboration(team, present);
      if (!best || overlap > best.overlap || corroboration > best.corroboration
        || (corroboration === best.corroboration && teamNumber(team.name) < teamNumber(best.team.name))) {
        best = { team, overlap, corroboration };
      }
    }
  }
  if (!best) return null;
  const ours = present.map((e) => ({ entry: e, key: rosterKey(taKey(known.battleDataName(e.pokemon, e.form || e.pokemon))), used: false }));
  const members = best.team.members.map((m) => {
    const match = ours.find((o) => !o.used && o.key === rosterKey(m.roster));
    if (match) match.used = true;
    const entry = match?.entry;
    const moves = new Set((m.moves || []).map(taKey));
    return {
      species: m.species, form: m.form, item: m.item, ability: m.ability, nature: m.nature, moves: [...(m.moves || [])],
      shared: Boolean(match),
      sameItem: Boolean(entry && taKey(entry.item) === taKey(m.item)),
      sharedMoves: entry ? (entry.moves || []).filter((move) => moves.has(taKey(move))).length : 0,
    };
  });
  return {
    name: best.team.name,
    number: teamNumber(best.team.name),
    overlap: best.overlap,
    size: present.length,
    members,
    notInIt: ours.filter((o) => !o.used).map((o) => ({ species: o.entry.pokemon, form: o.entry.form || o.entry.pokemon, item: o.entry.item || "" })),
  };
}

function countKeys(keys) {
  const out = {};
  for (const key of keys) out[key] = (out[key] || 0) + 1;
  return out;
}
