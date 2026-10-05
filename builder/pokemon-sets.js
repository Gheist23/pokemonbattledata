// The sets a Pokemon is actually played with, for the pickers.
//
// Choosing a Pokemon used to mean choosing a row and getting one set -- the usage file's own
// "most common set", the top row of each category. That is a real set and a good default, but it
// is one of several: a Mawile is a Mawilite Trick Room attacker in most teams and a Rocky Helmet
// pivot in others, and picking it gave you only the first.
//
// WHERE A SET COMES FROM
// ----------------------
// Two sources, combined:
//
//   * the registered tournament teams (data/builder/known-teams.json, 2,827 of them) are real
//     sets real players brought, with the item, ability, nature and four moves they chose. They
//     are grouped by what makes them a different set -- the held item and the role the nature and
//     the moves put the Pokemon in -- and the groups are ranked by how many teams ran them;
//   * the usage data supplies the Stat Points, because a tournament sheet does not record them.
//     The nature and the distribution are paired by the project's own rule (nature-spreads.js),
//     which never hands a nature points in the stat it lowers.
//
// The result is a small file, `data/builder/pokemon-sets.json`, built by tools/pokemon-sets.mjs.
// Every Pokemon has at least a blank set and its most common set, whatever the tournament teams
// hold, so the picker's behaviour never depends on how popular a Pokemon is.

import { makeSet, setFromCommon } from "./common.js";

/** Natures by what they do, for the role a set is named after. */
const FASTER = new Set(["Jolly", "Timid", "Hasty", "Naive"]);
const SLOWER = new Set(["Brave", "Quiet", "Relaxed", "Sassy"]);
const BULKIER = new Set(["Bold", "Impish", "Calm", "Careful", "Relaxed", "Sassy"]);
const HARDER = new Set(["Adamant", "Modest", "Lonely", "Mild", "Naughty", "Rash", "Brave", "Quiet", "Hasty", "Naive"]);

const compact = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * What to call this set, from the nature and the moves.
 *
 * A deliberately short list, because a label nobody can predict is worse than no label: a set
 * that goes last on purpose is Trick Room, one that goes first is Fast, one that invests in
 * bulk is Defensive and one that invests in power is Offensive.
 */
export function roleLabel(nature, moves = []) {
  const keys = (moves || []).map(compact);
  const name = String(nature || "").trim();
  if (keys.includes("trickroom")) return "Trick Room";
  if (keys.includes("tailwind") && FASTER.has(name)) return "Tailwind";
  if (SLOWER.has(name)) return "Trick Room";
  if (FASTER.has(name)) return "Fast";
  if (BULKIER.has(name)) return "Defensive";
  if (HARDER.has(name)) return "Offensive";
  return "Balanced";
}

/** "Mawilite Trick Room", "Rocky Helmet Defensive", or just the role with no item. */
export function setLabel(item, nature, moves) {
  const role = roleLabel(nature, moves);
  const held = String(item || "").trim();
  return held ? `${held} ${role}` : `No item ${role}`;
}

/** A set with nothing in it: the species, its first ability, and no choices made. */
export function blankSet(data, species, form) {
  const [s, f] = data.resolve(species, form);
  return makeSet({
    species: s, form: f, item: "", ability: data.abilities(s, f)[0] || "",
    nature: "Serious", bonuses: [0, 0, 0, 0, 0, 0], moves: [],
  });
}

/**
 * Every set offered for one Pokemon, best first.
 *
 * Always at least two: the blank set and the most common set. `library` is the parsed
 * `data/builder/pokemon-sets.json`, or null -- without it the two are all there is, which is
 * exactly what the picker did before this file existed.
 *
 * @returns {{id:string, label:string, sub:string, share:number, set:object}[]}
 */
export function setsFor(data, format, species, form, library = null) {
  const [s, f] = data.resolve(species, form);
  const common = setFromCommon(data.commonSet(format, s, f));
  const out = [
    {
      id: "common",
      label: "Most common Set",
      sub: setLabel(common.item, common.nature, common.moves),
      share: 0,
      set: common,
    },
    { id: "blank", label: "Blank Set", sub: "Nothing chosen yet", share: 0, set: blankSet(data, s, f) },
  ];
  const key = `${compact(s)}|${compact(f)}`;
  const entries = library?.[format]?.[key] || library?.[key] || [];
  const seen = new Set([`${compact(common.item)}|${compact(out[0].sub)}`]);
  for (const entry of entries) {
    const label = setLabel(entry.item, entry.nature, entry.moves);
    const id = `${compact(entry.item)}|${compact(label)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label,
      sub: `${entry.teams} tournament team${entry.teams === 1 ? "" : "s"}`,
      share: Number(entry.share) || 0,
      set: makeSet({
        species: s, form: f, item: entry.item || "",
        ability: entry.ability || data.abilities(s, f)[0] || "",
        nature: entry.nature || "Serious",
        bonuses: [...(entry.bonuses || [0, 0, 0, 0, 0, 0])],
        moves: [...(entry.moves || [])].slice(0, 4),
      }),
    });
  }
  return out;
}

/** The sets file, fetched once and remembered. Null when it is not published yet. */
let libraryPromise = null;
export function loadSetLibrary() {
  libraryPromise ||= fetch("/data/builder/pokemon-sets.json", { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((payload) => payload?.sets || payload || null);
  return libraryPromise;
}
