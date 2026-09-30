// The search language of the Explorer's search box.
//
// One query, two places that answer it: the Explorer (app.js) searches the
// battle-data records, and the Team Builder's "Choose a Pokémon" picker
// searches the builder's own tables.  What a query MEANS has to be the same in
// both — the same field names, the same operators, the same rank filters, the
// same idea of which hit is a better match — so the language lives here and
// both sides import it.  Where a value comes from is the only thing each side
// still decides for itself.
//
// The Advanced Search help the Explorer shows (index.html) is the user-facing
// description of exactly this file:
//
//   Fake Out, spe>=100     free text and clauses, chained with commas, all AND
//   type=Dragon            search inside one category
//   move<=5=Earthquake     Earthquake among the Top 5 moves
//   spe>=120  bst>=600     numbers compare with = : > < >= <=
//
// app.js is a classic script, so it pulls this in with a dynamic import() while
// it starts up rather than a static one.  Nothing here touches the DOM.

/** Fold accents and case, but keep spaces and punctuation: the matcher wants
 *  to know that "fake out" begins a word. */
export function normalizeForSearch(value) {
  return String(value || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** A field name as typed, reduced to its canonical spelling: "Sp_Atk", "sp atk"
 *  and "spatk" are one field. */
export function normalizeField(field) {
  return normalizeForSearch(field).replace(/[\s_-]+/g, "");
}

export function compareNumeric(candidate, op, target) {
  if (!Number.isFinite(target)) return false;
  if (op === ">=") return candidate >= target;
  if (op === "<=") return candidate <= target;
  if (op === ">") return candidate > target;
  if (op === "<") return candidate < target;
  return candidate === target;
}

export function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** How good a hit is, lowest is best: 0 the whole value, 1 its start, 2 the
 *  start of a word in it, 3 anywhere inside it. Infinity for no hit at all. */
export function bestTextMatchScore(values, query) {
  let best = Number.POSITIVE_INFINITY;
  (values || []).forEach((value) => {
    const candidate = normalizeForSearch(value).trim();
    if (!candidate || !candidate.includes(query)) return;
    if (candidate === query) best = Math.min(best, 0);
    else if (candidate.startsWith(query)) best = Math.min(best, 1);
    else if (candidate.split(" ").some((part) => part.startsWith(query))) best = Math.min(best, 2);
    else best = Math.min(best, 3);
  });
  return best;
}

export function matchTextValues(values, op, query) {
  const normalized = (values || []).filter(Boolean).map((candidate) => normalizeForSearch(candidate));
  return normalized.some((candidate) => candidate.includes(query));
}

export function splitListValue(value) {
  return String(value || "")
    .split(/[\/,|;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The battle-data category a field name asks about, or "" if it asks about
 *  something else. A "top…" field is the same category, top row only. */
export function categoryForSearchField(field) {
  const aliases = {
    move: "move",
    moves: "move",
    topmove: "move",
    item: "held_item",
    helditem: "held_item",
    helditems: "held_item",
    held_item: "held_item",
    topitem: "held_item",
    tophelditem: "held_item",
    ability: "ability",
    abilities: "ability",
    topability: "ability",
    nature: "stat_alignment",
    natures: "stat_alignment",
    statalignment: "stat_alignment",
    alignment: "stat_alignment",
    teammate: "teammate",
    teammates: "teammate",
    topteammate: "teammate",
    statspread: "stat_points",
    statspreads: "stat_points",
    statpoints: "stat_points",
    evs: "stat_points"
  };
  return aliases[field] || "";
}

/** The Stat Points column a field name asks about, or "". */
export function battleNumericFieldName(field) {
  const aliases = {
    hppoints: "hp_points",
    hp_points: "hp_points",
    hppts: "hp_points",
    atkpoints: "attack_points",
    attackpoints: "attack_points",
    attack_points: "attack_points",
    defpoints: "defense_points",
    defensepoints: "defense_points",
    defense_points: "defense_points",
    spapoints: "sp_atk_points",
    spatkpoints: "sp_atk_points",
    spattackpoints: "sp_atk_points",
    sp_atk_points: "sp_atk_points",
    spdpoints: "sp_def_points",
    spdefpoints: "sp_def_points",
    spdefensepoints: "sp_def_points",
    sp_def_points: "sp_def_points",
    spepoints: "speed_points",
    speedpoints: "speed_points",
    speed_points: "speed_points"
  };
  return aliases[field] || "";
}

/** The base stat a field name asks about, or "". */
export function baseStatFieldName(field) {
  const aliases = {
    hp: "hp",
    atk: "attack",
    attack: "attack",
    def: "defense",
    defense: "defense",
    spa: "sp_attack",
    spatk: "sp_attack",
    spattack: "sp_attack",
    sp_atk: "sp_attack",
    spd: "sp_defense",
    spdef: "sp_defense",
    spdefense: "sp_defense",
    sp_def: "sp_defense",
    spe: "speed",
    speed: "speed",
    bst: "base_stat_total",
    stats: "base_stat_total",
    totalstats: "base_stat_total",
    total: "base_stat_total"
  };
  return aliases[field] || "";
}

export function isRankFilterField(field) {
  return Boolean(categoryForSearchField(normalizeField(field)));
}

export function addNameSegments(segment, parts) {
  String(segment || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => parts.push(part));
}

export function parseClause(field, op, rawValue) {
  const value = String(rawValue || "").trim().replace(/^,\s*/, "");
  if (!field || !value) return null;

  const rankMatch = value.match(/^(\d+)\s*(=|:)\s*(.+)$/);
  if ((op === "<=" || op === ">=" || op === "<" || op === ">") && rankMatch && isRankFilterField(field)) {
    return {
      field: normalizeField(field),
      op: rankMatch[2],
      value: rankMatch[3].trim(),
      rankOp: op,
      rankValue: Number(rankMatch[1])
    };
  }

  return { field: normalizeField(field), op, value };
}

/**
 * A typed query as a plan.
 *
 *   mode "empty"     nothing typed, everything matches
 *   mode "name"      one plain word, matched against everything and ranked
 *   mode "advanced"  one or more clauses, all of which have to hold
 */
export function parseSearchQuery(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return { mode: "empty", clauses: [], text: "" };

  const clauses = [];
  const nameParts = [];
  const clauseRe = /([a-zA-Z_]+)\s*(>=|<=|=|:|>|<)\s*([^,]*?)(?=(?:\s*,\s*)|(?:\s+[a-zA-Z_]+\s*(?:>=|<=|=|:|>|<))|$)/g;
  let match;
  let cursor = 0;

  while ((match = clauseRe.exec(raw)) !== null) {
    addNameSegments(raw.slice(cursor, match.index), nameParts);
    const parsed = parseClause(match[1], match[2], match[3]);
    if (parsed) clauses.push(parsed);
    cursor = clauseRe.lastIndex;
  }
  addNameSegments(raw.slice(cursor), nameParts);

  nameParts.forEach((part) => clauses.unshift({ field: "quick", op: ":", value: part }));

  if (!clauses.length) return { mode: "name", text: normalizeForSearch(raw), clauses: [] };
  const hasOnlyQuick = clauses.every((clause) => clause.field === "quick");
  if (hasOnlyQuick && clauses.length === 1) return { mode: "name", text: normalizeForSearch(clauses[0].value), clauses };
  return { mode: "advanced", text: "", clauses };
}

// --- answering a clause -----------------------------------------------------
//
// A "source" is one Pokemon seen through whichever tables the calling page has.
// Every method is optional and returns nothing when that page cannot answer it;
// a clause a page cannot answer simply matches nothing, so a field never
// silently means something different in one place than in the other.
//
//   names()              every spelling of the Pokemon's own name
//   types()              its types
//   abilities()          every Ability it can have
//   learnset()           every move it can learn
//   extraText()          form names, form kinds and anything else worth a hit
//   stat(key)            a base stat: hp attack defense sp_attack sp_defense speed base_stat_total
//   dex()                its Pokedex number
//   rows(category)       battle-data rows of one category, [{ label, rank, percentage }]
//   points(column)       Stat Points columns, e.g. "speed_points", as numbers
//   ranks()              every rank the Pokemon holds in the battle data
//   percentages()        every usage percentage it holds
//   statUp() statDown()  the raised and lowered stat of each of its spreads

const list = (source, key, ...args) => (typeof source?.[key] === "function" ? source[key](...args) || [] : []);

/** Where a plain word is found, lowest is best: its own name beats its types
 *  and Abilities, which beat the battle data, which beats its learnset. */
export function quickScore(query, source) {
  const text = normalizeForSearch(query).trim();
  if (!text) return 0;
  const nameScore = bestTextMatchScore(list(source, "names"), text);
  if (nameScore !== Number.POSITIVE_INFINITY) return nameScore;

  const metadataScore = bestTextMatchScore([
    ...list(source, "types"),
    ...list(source, "abilities"),
    ...list(source, "extraText"),
  ], text);
  if (metadataScore !== Number.POSITIVE_INFINITY) return metadataScore + 10;

  const battleScore = bestTextMatchScore(list(source, "battleText"), text);
  if (battleScore !== Number.POSITIVE_INFINITY) return battleScore + 20;

  return bestTextMatchScore(list(source, "learnset"), text) + 30;
}

export function matchClause(clause, source) {
  const value = clause.value;
  const query = normalizeForSearch(value);
  const field = clause.field;
  if (!field) return true;
  if (field === "quick") return quickScore(query, source) !== Number.POSITIVE_INFINITY;

  // A page that cannot answer a field at all answers no to it, rather than
  // answering 0 and making "dex=0" find everything.
  const statField = baseStatFieldName(field);
  if (statField) {
    if (typeof source?.stat !== "function") return false;
    return compareNumeric(numberOrZero(source.stat(statField)), clause.op, Number(value));
  }
  if (field === "dex") {
    if (typeof source?.dex !== "function") return false;
    return compareNumeric(numberOrZero(source.dex()), clause.op, Number(value));
  }

  if (field === "name" || field === "pokemon") return matchTextValues(list(source, "names"), clause.op, query);
  if (field === "type" || field === "types") return matchTextValues(list(source, "types"), clause.op, query);

  const pointsField = battleNumericFieldName(field);
  if (pointsField) {
    const target = Number(value);
    if (!Number.isFinite(target)) return false;
    return list(source, "points", pointsField).some((number) => compareNumeric(numberOrZero(number), clause.op, target));
  }

  if (field === "usage" || field === "percent" || field === "percentage") {
    const target = Number(String(value).replace("%", ""));
    if (!Number.isFinite(target)) return false;
    return list(source, "percentages").some((number) => compareNumeric(numberOrZero(number), clause.op, target));
  }

  if (field === "rank") {
    const target = Number(value);
    if (!Number.isFinite(target)) return false;
    return list(source, "ranks").some((number) => compareNumeric(numberOrZero(number), clause.op, target));
  }

  if (field === "statup") return matchTextValues(list(source, "statUp"), clause.op, query);
  if (field === "statdown" || field === "reducedstat") return matchTextValues(list(source, "statDown"), clause.op, query);

  const category = categoryForSearchField(field);
  if (!category) return false;

  let rows = list(source, "rows", category);
  if (field.startsWith("top")) rows = rows.filter((row) => numberOrZero(row.rank) === 1);
  if (clause.rankOp) rows = rows.filter((row) => compareNumeric(numberOrZero(row.rank), clause.rankOp, clause.rankValue));
  if (rows.some((row) => normalizeForSearch(row.label).includes(query))) return true;

  // A move or an Ability it merely CAN have counts too, but only when the
  // clause did not ask for a place in the table.
  if (category === "move" && !clause.rankOp && !field.startsWith("top")) {
    return matchTextValues(list(source, "learnset"), clause.op, query);
  }
  if (category === "ability" && !clause.rankOp && !field.startsWith("top")) {
    return matchTextValues(list(source, "abilities"), clause.op, query);
  }
  return false;
}

/** Every clause has to hold. */
export function matchesPlan(plan, source) {
  if (!plan || plan.mode === "empty") return true;
  if (plan.mode === "name") return quickScore(plan.text, source) !== Number.POSITIVE_INFINITY;
  return plan.clauses.every((clause) => matchClause(clause, source));
}
