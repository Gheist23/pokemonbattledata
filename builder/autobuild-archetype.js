// Auto Build's "Preferred archetype" and "Prioritize Meta Pokémon", ported from the
// Companion app.
//
//   V477  a chosen archetype is a construction target: every candidate carries how
//         many of the archetype's (critical) requirements the projected team still
//         misses, the Phase-1 order puts the fewest first, and the archetype's
//         specialists are reserved places in a bounded candidate pool.
//   V494  the archetype's defining move is offered to every candidate that can learn
//         it; the first picks are forced to a setter, then a beneficiary (Trick Room
//         wants one member, the rest two); an unmet critical requirement outranks
//         everything; and the finished team is taught the move - or, as a last
//         resort, a Box Pokémon that can use it steps in.
//   V462  Prioritize Meta Pokémon: the Top-X meta is kept inside the candidate budget
//         and ranked ahead of the rest within the same hard Team Building Check group.

import { compact } from "./engine.js";
import { archetypeRequirements, classifyArchetype } from "./team-checks.js";

/** The setup dialog's choices, in the app's order (_V433_ARCHETYPE_CHOICES). */
export const AUTO_BUILD_ARCHETYPES = [
  ["Automatically", "automatic"], ["Balanced", "balanced"], ["Offense", "offense"], ["Bulky Offense", "bulky offense"],
  ["Hyper Offense", "hyper offense"], ["Goodstuff", "goodstuff"], ["Trick Room", "trick room"], ["Tailwind", "tailwind"],
  ["Rain", "rain"], ["Sun", "sun"], ["Sand", "sand"], ["Snow", "snow"], ["Screens", "screens"], ["Setup", "setup"],
  ["Terrain", "terrain"], ["Perish Trap", "perish trap"], ["Stall", "stall"], ["Semi-Stall", "semi-stall"],
];

/** _V453_ARCHETYPE_DESCRIPTIONS */
const DESCRIPTIONS = {
  automatic: "Automatically infer the best team style from the current core and the enabled Team Building Checks.",
  balanced: "Balance offense, defensive pivots, Speed control, disruption and matchup coverage.",
  offense: "Prioritize immediate damage, pressure and reliable offensive positioning.",
  "hyper offense": "Maximize tempo, Speed and fast KO pressure with minimal passive turns.",
  "bulky offense": "Combine strong damage with enough bulk and defensive flexibility to trade well.",
  rain: "Prioritize a coherent Rain core: setters, beneficiaries and Water-pressure synergy.",
  sun: "Prioritize a coherent Sun core: setters, beneficiaries and Fire/Grass synergy.",
  sand: "Prioritize Sand setters and Pokémon that benefit offensively or defensively from Sand.",
  snow: "Prioritize Snow setters and Ice-oriented defensive/offensive synergy.",
  tailwind: "Prioritize reliable Tailwind access and partners that exploit the Speed advantage.",
  "trick room": "Prioritize Trick Room setters and slow attackers that benefit from reversed Speed order.",
  screens: "Prioritize Reflect/Light Screen support and teams that capitalize on the added bulk.",
  terrain: "Prioritize terrain setters and Pokémon whose moves or Abilities benefit from terrain.",
  setup: "Prioritize setup win conditions and the support needed to create safe setup turns.",
  stall: "Prioritize durability, recovery, denial and long-game resource advantages.",
  "semi-stall": "Prioritize a durable defensive core while retaining proactive offensive pressure.",
  "perish trap": "Prioritize Perish Song plus trapping/control tools and the support needed to execute it.",
};

export function archetypeDescription(key) {
  return DESCRIPTIONS[archetypeKey(key)] || "Strongly prioritize this archetype while still covering enabled Team Building Checks and Top-X threats.";
}

/** _v432_archetype_key: a display name or key as a key; anything unknown is "automatic". */
export function archetypeKey(value) {
  const text = String(value || "Automatically").replace(/[_-]/g, " ").trim().toLowerCase().replace(/\s+/g, " ");
  const aliases = {
    auto: "automatic", automatically: "automatic", automatic: "automatic", balance: "balanced", bulkyoffense: "bulky offense",
    hyperoffense: "hyper offense", semistall: "semi-stall", trickroom: "trick room", perishtrap: "perish trap",
  };
  const key = aliases[text.replace(/ /g, "")] || aliases[text] || text;
  return AUTO_BUILD_ARCHETYPES.some(([, k]) => k === key) ? key : "automatic";
}

export function archetypeDisplay(value) {
  const key = archetypeKey(value);
  return (AUTO_BUILD_ARCHETYPES.find(([, k]) => k === key) || AUTO_BUILD_ARCHETYPES[0])[0];
}

/** _v477_manual_archetype: the chosen key, or "" for Automatically. */
export function manualArchetype(value) {
  const key = archetypeKey(value);
  return key === "automatic" ? "" : key;
}

// --- what each archetype is made of --------------------------------------------------

/** _V494_ARCHETYPE_ANCHORS: the move (or Ability) an archetype is named after. */
const ANCHORS = {
  "trick room": { label: "Trick Room setters", target: 2, moves: ["Trick Room"], avoidItems: ["Choice Scarf"] },
  tailwind: { label: "Tailwind setters", target: 2, moves: ["Tailwind"] },
  "perish trap": { label: "Perish Song users", target: 1, moves: ["Perish Song"] },
  screens: { label: "Distinct screens", target: 2, distinct: true, moves: ["Reflect", "Light Screen", "Aurora Veil"] },
  rain: { label: "Rain setters", target: 2, moves: ["Rain Dance"], abilities: ["Drizzle", "Primordial Sea"] },
  sun: { label: "Sun setters", target: 2, moves: ["Sunny Day"], abilities: ["Drought", "Orichalcum Pulse"] },
  sand: { label: "Sand setters", target: 1, moves: ["Sandstorm"], abilities: ["Sand Stream", "Sand Spit"] },
  snow: { label: "Snow setters", target: 1, moves: ["Snowscape"], abilities: ["Snow Warning", "Chilly Reception"] },
  terrain: { label: "Terrain setters", target: 1, moves: ["Electric Terrain", "Grassy Terrain", "Psychic Terrain", "Misty Terrain"] },
};

const KEEP_PROTECT = new Set(["protect", "detect", "spikyshield", "banefulbunker", "burningbulwark", "silktrap", "wideguard", "quickguard"]);
const KEEP_UTILITY = new Set([
  "recover", "roost", "softboiled", "moonlight", "morningsun", "synthesis", "slackoff",
  "swordsdance", "nastyplot", "dragondance", "calmmind", "bulkup", "irondefense", "shellsmash",
  "fakeout", "followme", "ragepowder", "helpinghand", "haze", "taunt", "encore", "willowisp",
]);

/** _v477_anchor_score's own table: what the species' single most common set must show. */
const COMMON_SET_ANCHORS = {
  tailwind: [["tailwind"], []],
  "trick room": [["trickroom"], []],
  rain: [["raindance"], ["drizzle"]],
  sun: [["sunnyday"], ["drought", "orichalcumpulse"]],
  sand: [["sandstorm"], ["sandstream"]],
  snow: [["snowscape", "hail"], ["snowwarning"]],
  screens: [["reflect", "lightscreen", "auroraveil"], []],
  terrain: [["electricterrain", "grassyterrain", "mistyterrain", "psychicterrain"], ["electricsurge", "grassysurge", "mistysurge", "psychicsurge"]],
  "perish trap": [["perishsong", "meanlook", "block"], ["shadowtag", "arenatrap"]],
};

/** The archetypes whose specialists V477 reserves pool places for. */
const RESERVED_ARCHETYPES = new Set(Object.keys(COMMON_SET_ANCHORS));

/** _V494_WEATHER_BENEFICIARY_MOVES */
const BENEFICIARY_MOVES = {
  rain: ["electroshot", "thunder", "hurricane", "weatherball"],
  sun: ["solarbeam", "solarblade", "weatherball", "growth"],
  sand: [],
  snow: ["auroraveil"],
};

/** _V494_ARCHETYPE_QUOTA_BY_KEY: members forced in before the ranking takes over. */
const quota = (key) => (key === "trick room" ? 1 : 2);

const SWAP_MAX = 2;
const MAX_STRUCTURAL_SETS = 18;

/** Python's round(): halves go to the even neighbour. */
function pyRound(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

const keySet = (values) => new Set((values || []).map(compact).filter(Boolean));

/**
 * The archetype pieces one Auto Build needs, bound to its Suggestions engine.
 * @param {import("./team-suggest.js").TeamSuggestions} sg
 */
export class AutoBuildArchetype {
  constructor(sg, key) {
    this.sg = sg;
    this.ev = sg.ev;
    this.key = manualArchetype(key);
    this.anchor = ANCHORS[this.key] || null;
    const tables = this.ev.engine.data?.analysisTables || {};
    this.weatherUsers = keySet((tables._SIMPLE_WEATHER_USERS_V187 || {})[this.key]);
    const [roleMoves, roleAbilities] = this.key === "setup"
      ? [tables._V403_SETUP_MOVES || [], []]
      : ROLE_MAP[this.key] || [[], []];
    this.roleMoves = keySet(roleMoves);
    this.roleAbilities = keySet(roleAbilities);
    this.benefitMoves = keySet(BENEFICIARY_MOVES[this.key]);
    this.anchorMoves = keySet(this.anchor?.moves);
    this.anchorAbilities = keySet(this.anchor?.abilities);
  }

  // --- learnsets and moves ----------------------------------------------------------

  /** get_learnable_move_names_cached as keys: the form's list, else any list of the species. */
  learnable(species, form) {
    const sets = this.ev.engine.data?.learnsets || {};
    let list = sets[`${species}|${form || species}`];
    if (!list?.length) list = Object.entries(sets).find(([k, v]) => k.startsWith(`${species}|`) && v.length)?.[1] || [];
    return keySet(list);
  }

  /** _v494_anchor_slot_rank: how reluctant we are to drop moves[index]; lower goes first. */
  slotRank(moves, index, keeperTypes) {
    const key = compact(moves[index]);
    if (KEEP_PROTECT.has(key)) return 100;
    const [type, , power] = this.ev.simpleMoveInfo(moves[index]);
    if (Number(power) > 0) return (keeperTypes.has(String(type).toLowerCase()) ? 40 : 10) + Number(power) / 1000;
    if (KEEP_UTILITY.has(key)) return 60;
    return 20;
  }

  /** _v494_anchor_drop_index: which of four moves makes room, or the free slot. */
  dropIndex(moves) {
    if (moves.length < 4) return moves.length;
    const types = new Map();
    for (const move of moves) {
      const [type, , power] = this.ev.simpleMoveInfo(move);
      if (Number(power) > 0) types.set(String(type).toLowerCase(), (types.get(String(type).toLowerCase()) || 0) + 1);
    }
    const keepers = new Set([...types].filter(([, n]) => n <= 1).map(([t]) => t));
    const ranked = moves.map((_, i) => i).sort((a, b) => this.slotRank(moves, a, keepers) - this.slotRank(moves, b, keepers) || b - a);
    return ranked.length ? ranked[0] : -1;
  }

  /** _v494_with_anchor_move: the moves with the anchor installed, or null when it is there. */
  withAnchorMove(moves, anchorMove) {
    const clean = (moves || []).map((m) => String(m || "")).filter((m) => m.trim());
    if (clean.some((m) => compact(m) === compact(anchorMove))) return null;
    const index = this.dropIndex(clean);
    if (index < 0) return null;
    if (index >= clean.length) return [...clean, anchorMove].slice(0, 4);
    const out = [...clean];
    out[index] = anchorMove;
    return out.slice(0, 4);
  }

  // --- 1. the move is offered to every candidate that can learn it (V494) -------------

  /** _v494_anchor_candidate_sets, round the candidate sets the Trick Room natures produced. */
  candidateSets(sets, meta) {
    if (!sets.length || !this.anchor) return sets;
    const species = String(meta.base_name || meta.pokemon || meta.name || meta.form || "").trim();
    const form = String(meta.form || meta.name || species).trim();
    if (!species) return sets;
    const learnable = this.learnable(species, form);
    if (!learnable.size) return sets;
    for (const set of sets) {
      if ((set.moves || []).some((m) => this.anchorMoves.has(compact(m)))) return sets;
      if (this.anchorAbilities.size && this.anchorAbilities.has(compact(set.ability))) return sets;
    }
    const anchorMove = this.anchor.moves.find((m) => learnable.has(compact(m)));
    if (!anchorMove) return sets;
    const signature = (set) => [compact(set.item), compact(set.ability), (set.moves || []).map(compact).join(","), String(set.spread?.nature_name || set.spread?.name || "").toLowerCase(), (set.spread?.bonuses || []).join(",")].join("|");
    const seen = new Set(sets.map(signature));
    const variants = [];
    for (const set of sets.slice(0, 3)) {
      const moves = this.withAnchorMove(set.moves, anchorMove);
      if (!moves) continue;
      const variant = { ...structuredClone(set), moves, source_v449: "archetype-anchor", archetype_anchor_v494: anchorMove };
      const k = signature(variant);
      if (seen.has(k)) continue;
      seen.add(k);
      variants.push(variant);
      if (variants.length >= 2) break;
    }
    if (!variants.length) return sets;
    const merged = [...variants, ...sets];
    return merged.slice(0, Math.max(MAX_STRUCTURAL_SETS, variants.length + 1));
  }

  // --- 2. who plays the role ------------------------------------------------------------

  usage(name, category, limit) {
    return this.ev.usagePairs(this.sg.usageName(name), category, limit);
  }

  /** Usage-weighted credit for moves/Abilities in two sets, with the common set as fallback. */
  usageScore(meta, moveSet, abilitySet, [moveBase, moveCap, abilityBase, abilityCap]) {
    if (!moveSet.size && !abilitySet.size) return 0;
    const name = String(meta?.base_name || meta?.name || "").trim();
    if (!name) return 0;
    let moveUsage = 0;
    let abilityUsage = 0;
    for (const [label, pct] of this.usage(name, "move", 80)) if (moveSet.has(compact(label))) moveUsage = Math.max(moveUsage, Number(pct) || 0);
    for (const [label, pct] of this.usage(name, "ability", 20)) if (abilitySet.has(compact(label))) abilityUsage = Math.max(abilityUsage, Number(pct) || 0);
    let score = 0;
    if (moveUsage > 0) score += moveBase + Math.min(moveCap, moveUsage / 25);
    if (abilityUsage > 0) score += abilityBase + Math.min(abilityCap, abilityUsage / 25);
    if (score <= 0) {
      const common = this.sg.common(name);
      if ((common.moves || []).some((m) => moveSet.has(compact(m)))) score += moveBase;
      if (abilitySet.has(compact(common.ability))) score += abilityBase;
    }
    return score;
  }

  /** _v494_archetype_role_score: real usage of the archetype's setting move or Ability. */
  roleScore(meta) {
    return this.usageScore(meta, this.roleMoves, this.roleAbilities, [3, 2, 4, 2]);
  }

  /** _v494_archetype_beneficiary_score: real usage of what cashes the weather in. */
  beneficiaryScore(meta) {
    return this.usageScore(meta, this.benefitMoves, this.weatherUsers, [1.5, 1, 2, 1]);
  }

  /** _v477_anchor_score as V494 left it: role usage, else the common set, else learnable, else beneficiary. */
  anchorScore(meta) {
    const widened = this.roleScore(meta);
    let score = widened > 0 ? pyRound(widened) : this.commonSetScore(meta);
    if (score <= 0 && this.anchor) {
      const data = meta || {};
      const species = String(data.base_name || data.pokemon || data.name || "").trim();
      const form = String(data.form || data.name || species).trim();
      if (species && [...this.learnable(species, form)].some((m) => this.anchorMoves.has(m))) score = 2;
    }
    return score > 0 ? score : pyRound(this.beneficiaryScore(meta));
  }

  commonSetScore(meta) {
    const [moves, abilities] = COMMON_SET_ANCHORS[this.key] || [[], []];
    const name = String(meta?.base_name || meta?.name || "").trim();
    const common = this.sg.common(name);
    let score = 0;
    if ((common.moves || []).some((m) => moves.includes(compact(m)))) score += 3;
    if (abilities.includes(compact(common.ability))) score += 4;
    return score;
  }

  /** _v494_entry_archetype_roles: [sets it, benefits from it] for one set on the team. */
  entryRoles(entry) {
    if (!entry || !String(entry.pokemon || "").trim()) return [false, false];
    const moves = new Set((entry.moves || []).map(compact));
    const ability = compact(entry.ability);
    const setsIt = [...moves].some((m) => this.roleMoves.has(m)) || this.roleAbilities.has(ability);
    const benefits = [...moves].some((m) => this.benefitMoves.has(m)) || this.weatherUsers.has(ability);
    return [setsIt, benefits];
  }

  /** The forcing state _v427_run_auto_build arms from the starting team. */
  forcing(entries) {
    let have = 0;
    let haveSetter = false;
    if (this.key) {
      for (const entry of entries) {
        const [setsIt, benefits] = this.entryRoles(entry);
        if (setsIt || benefits) have += 1;
        if (setsIt) haveSetter = true;
      }
    }
    return { needed: this.key ? Math.max(0, quota(this.key) - have) : 0, haveSetter };
  }

  // --- 3. the pool (V477) -------------------------------------------------------------------

  /** _v202_top_x_suggestion_candidates (V477): specialists replace the tail of a bounded pool. */
  reserveSpecialists(bounded, full) {
    if (!RESERVED_ARCHETYPES.has(this.key)) return bounded;
    const specialists = full.map((row) => [this.anchorScore(row), row]).filter(([score]) => score > 0);
    specialists.sort((a, b) => b[0] - a[0] || (Number(a[1].position) || 999999) - (Number(b[1].position) || 999999) || (String(a[1].name) < String(b[1].name) ? -1 : String(a[1].name) > String(b[1].name) ? 1 : 0));
    if (!specialists.length) return bounded;
    const limit = Math.max(1, bounded.length);
    const keep = bounded.map((row) => structuredClone(row));
    const seen = new Set(keep.map((row) => compact(row.name)));
    const insertions = [];
    for (const [, row] of specialists.slice(0, 8)) {
      const k = compact(row.name);
      if (k && !seen.has(k)) {
        insertions.push({ ...structuredClone(row), archetype_anchor_reserved_v477: this.key });
        seen.add(k);
      }
    }
    if (!insertions.length) return keep;
    return [...keep.slice(0, Math.max(0, limit - insertions.length)), ...insertions].slice(0, limit);
  }

  // --- 4. each candidate (V477) ----------------------------------------------------------------

  /** _v477_archetype_metrics over the team the candidate would complete. */
  metrics(row, context) {
    const slots = [...context.teamSlots, this.sg.slotFor(row.candidate_entry, context.teamSlots.length)];
    const features = this.sg.featuresFor(slots);
    let criticalUnmet = 0;
    let totalUnmet = 0;
    let deficit = 0;
    for (const req of archetypeRequirements(this.key, features)) {
      if (!req || req.met) continue;
      totalUnmet += 1;
      if (req.critical) criticalUnmet += 1;
      const current = Number(req.current ?? 0);
      const target = Number(req.target ?? 0);
      deficit += Number.isFinite(current) && Number.isFinite(target) ? Math.abs(target - current) : 1;
    }
    const complete = slots.length >= 6;
    const match = complete && classifyArchetype(features)[1] === this.key;
    Object.assign(row, {
      _manual_archetype_v477: this.key,
      _archetype_critical_unmet_v477: criticalUnmet,
      _archetype_total_unmet_v477: totalUnmet,
      _archetype_deficit_v477: deficit,
      _archetype_final_match_v477: match,
      _archetype_final_complete_v477: complete,
    });
    return row;
  }

  // --- 5. the finished team carries the archetype (V494) ------------------------------------

  /** _v494_anchor_supply: how much of the defining move the team already has. */
  supply(entries) {
    const present = new Set();
    let holders = 0;
    for (const entry of entries) {
      if (!entry || !String(entry.pokemon || "").trim()) continue;
      const matched = (entry.moves || []).map(compact).filter((m) => this.anchorMoves.has(m));
      if (matched.length) {
        matched.forEach((m) => present.add(m));
        holders += 1;
      } else if (this.anchorAbilities.size && this.anchorAbilities.has(compact(entry.ability))) {
        holders += 1;
      }
    }
    return [this.anchor?.distinct ? present.size : holders, present];
  }

  /**
   * _v494_install_archetype_anchor: teach the archetype's move to members that can
   * learn it, then (_v494_swap_in_archetype_anchor) bring in Box Pokémon that can.
   * @param {Function} speedOf  (entry, index) -> the member's Speed
   * @returns {number[]} the slots whose Pokémon was replaced
   */
  install(entries, { box = [], speedOf = () => 0, log = [] } = {}) {
    if (!this.anchor) return [];
    const populated = entries.map((e, i) => (e && String(e.pokemon || "").trim() ? i : -1)).filter((i) => i >= 0);
    if (populated.length < 4) return [];
    const target = this.anchor.target || 1;
    let [supply, present] = this.supply(entries);
    if (supply >= target) return [];
    const display = archetypeDisplay(this.key);
    const distinct = Boolean(this.anchor.distinct);
    for (const index of populated) {
      if (supply >= target) break;
      const entry = entries[index];
      const keys = new Set((entry.moves || []).map(compact));
      if ([...keys].some((m) => this.anchorMoves.has(m)) && !distinct) continue;
      const learnable = this.learnable(entry.pokemon, entry.form);
      const wanted = this.anchor.moves.find((name) => learnable.has(compact(name)) && !keys.has(compact(name)) && !(distinct && present.has(compact(name))));
      if (!wanted) continue;
      const replacement = this.withAnchorMove(entry.moves, wanted);
      if (!replacement) continue;
      const kept = new Set(replacement.map(compact));
      const dropped = (entry.moves || []).filter((m) => !kept.has(compact(m)));
      entries[index] = { ...entry, moves: replacement };
      present.add(compact(wanted));
      supply += 1;
      log.push(`Auto Build finished a ${display} team without enough ${this.anchor.label}. Teaching ${entry.form || entry.pokemon} ${wanted}${dropped.length ? ` in place of ${dropped[0]}.` : "."}`);
    }
    return supply < target ? this.swapIn(entries, { box, speedOf, log, supply, target, present, display }) : [];
  }

  /** _v494_box_anchor_options: Box Pokémon that can supply the defining move. */
  boxOptions(box, taken) {
    const options = [];
    const seen = new Set(taken);
    const avoid = keySet(this.anchor.avoidItems);
    for (const set of box || []) {
      const species = String(set?.species || "").trim();
      const form = String(set?.form || species).trim() || species;
      if (!species || seen.has(compact(form)) || seen.has(compact(species))) continue;
      let moves = (set.moves || []).map((m) => String(m || "")).filter((m) => m.trim());
      let moveKeys = new Set(moves.map(compact));
      let ability = String(set.ability || "");
      const learnable = this.learnable(species, form);
      let supplies = [...moveKeys].some((m) => this.anchorMoves.has(m)) || [...learnable].some((m) => this.anchorMoves.has(m));
      if (this.anchorAbilities.size && this.anchorAbilities.has(compact(ability))) supplies = true;
      if (!supplies) continue;
      seen.add(compact(form));
      let item = String(set.item || "");
      if (item && avoid.has(compact(item))) item = "";
      if (!item || !ability || !moves.length) {
        const common = this.sg.common(form || species);
        for (const choice of [String(common.item || ""), ...this.sg.usage(form || species, "held_item", 4)]) {
          if (!choice || avoid.has(compact(choice)) || this.ev.engine.isMegaStone(choice)) continue;
          item ||= choice;
          break;
        }
        ability ||= String(common.ability || "");
        if (!moves.length) {
          moves = (common.moves || []).map((m) => String(m || "")).slice(0, 4);
          moveKeys = new Set(moves.map(compact));
        }
      }
      let rank = [...moveKeys].some((m) => this.anchorMoves.has(m)) ? 3 : 1;
      if (this.anchorAbilities.size && this.anchorAbilities.has(compact(ability))) rank = 4;
      options.push({ pokemon: species, form, item, ability, moves, rank, nature: set.nature, bonuses: set.bonuses });
    }
    return options.map((o, i) => [o, i]).sort((a, b) => b[0].rank - a[0].rank || a[1] - b[1]).map(([o]) => o);
  }

  swapIn(entries, { box, speedOf, log, supply, target, present, display }) {
    const populated = entries.map((e, i) => (e && String(e.pokemon || "").trim() ? i : -1)).filter((i) => i >= 0);
    const taken = new Set(populated.flatMap((i) => [compact(entries[i].pokemon), compact(entries[i].form)]));
    const options = this.boxOptions(box, taken);
    // Most expendable first, stone holders never: under Trick Room the fastest goes first.
    const slowFirst = compact(this.anchor.moves[0]) === "trickroom";
    const removable = populated
      .filter((i) => !(entries[i].item && this.ev.engine.isMegaStone(entries[i].item)))
      .map((i) => [slowFirst ? -speedOf(entries[i], i) : speedOf(entries[i], i), i])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([, i]) => i);
    if (!options.length || !removable.length) {
      log.push(`Auto Build could not reach ${target} ${this.anchor.label} for the ${display} archetype: none of the selected Pokémon can learn the move and the Box has no replacement that can.`);
      return [];
    }
    const distinct = Boolean(this.anchor.distinct);
    const swapped = [];
    while (supply < target && options.length && removable.length && swapped.length < SWAP_MAX) {
      const option = options.shift();
      const slot = removable.shift();
      const moveKeys = new Set(option.moves.map(compact));
      const learnable = this.learnable(option.pokemon, option.form);
      const wanted = this.anchor.moves.find((name) => !(distinct && present.has(compact(name))) && (moveKeys.has(compact(name)) || learnable.has(compact(name)))) || "";
      const byAbility = Boolean(this.anchorAbilities.size && this.anchorAbilities.has(compact(option.ability)));
      if (!wanted && !byAbility) continue;
      let moves = [...option.moves];
      if (wanted && !moveKeys.has(compact(wanted))) moves = this.withAnchorMove(moves, wanted) || moves;
      const outgoing = entries[slot].form || entries[slot].pokemon;
      entries[slot] = { pokemon: option.pokemon, item: option.item, form: option.form, ability: option.ability, moves: moves.slice(0, 4) };
      if (wanted) present.add(compact(wanted));
      supply += 1;
      swapped.push(slot);
      log.push(`Auto Build finished a ${display} team without enough ${this.anchor.label}, and none of its Pokémon can learn the move. Bringing in ${option.form} from the Box${wanted ? ` with ${wanted}` : ""}, in place of ${outgoing}.`);
    }
    if (supply < target) log.push(`Auto Build reached ${supply} of ${target} ${this.anchor.label} for the ${display} archetype.`);
    return swapped;
  }
}

/** _V494_ARCHETYPE_ROLE_MAP (setup reads _V403_SETUP_MOVES from the exported tables). */
const ROLE_MAP = {
  tailwind: [["tailwind"], []],
  "trick room": [["trickroom"], []],
  rain: [["raindance"], ["drizzle", "primordialsea"]],
  sun: [["sunnyday"], ["drought", "orichalcumpulse"]],
  sand: [["sandstorm"], ["sandstream", "sandspit"]],
  snow: [["snowscape", "hail"], ["snowwarning", "chillyreception"]],
  screens: [["reflect", "lightscreen", "auroraveil"], []],
  terrain: [["electricterrain", "grassyterrain", "psychicterrain", "mistyterrain"], ["electricsurge", "grassysurge", "psychicsurge", "mistysurge"]],
  "perish trap": [["perishsong"], []],
};

/**
 * _v433_choose_automatic_archetype: the style "Automatically" settles on for the
 * starting team. Only the Trick Room nature variants read it (_v483_trick_room_context).
 * @param {object} features   _v403_archetype_features of the starting team
 * @param {string} savedKey   the team's own archetype label ("balanced" when none)
 */
export function resolveAutomaticArchetype(features, savedKey, ratio) {
  const f = features || {};
  const n = (field) => Number(f[field]) || 0;
  const weather = (group, key) => Number((f[group] || {})[key]) || 0;
  const coverage = (requirements) => {
    let total = 0;
    let covered = 0;
    for (const req of requirements || []) {
      const weight = req.critical ? 2.4 : 1;
      total += weight;
      covered += Math.max(0, Math.min(1, ratio(req))) * weight;
    }
    return total > 0 ? covered / total : 1;
  };
  let best = "balanced";
  let bestScore = -Infinity;
  for (const [, key] of AUTO_BUILD_ARCHETYPES) {
    if (key === "automatic") continue;
    let score = coverage(archetypeRequirements(key, f)) * 55;
    if (savedKey === key && key !== "balanced") score += 30;
    if (["rain", "sun", "sand", "snow"].includes(key)) score += 46 * weather("weather_setters", key) + 8 * weather("weather_users", key) + 3 * weather("weather_beneficiaries", key);
    else if (key === "trick room") score += 48 * n("trick_room_setters") + 5 * n("slow_attackers");
    else if (key === "tailwind") score += 46 * n("tailwind_setters") + 3.5 * n("fast");
    else if (key === "screens") score += 24 * n("screens_distinct") + 15 * n("screen_providers") + 7 * n("light_clay");
    else if (key === "terrain") score += 42 * n("terrain_setters") + 7 * n("terrain_beneficiaries");
    else if (key === "perish trap") score += 45 * n("perish_song") + 25 * n("trap_sources");
    else if (key === "setup") score += 13 * n("setup") + 8 * n("redirection_fakeout");
    else if (key === "stall" || key === "semi-stall") score += 4 * n("bulky") + 6 * n("recovery") + 4 * n("denial");
    else if (key === "offense" || key === "hyper offense") score += 3.5 * n("attackers") + 3.5 * n("fast") + 3 * n("spread");
    else if (key === "bulky offense") score += 3 * n("attackers") + 4 * n("bulky");
    // max() keeps the first of equal scores.
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  return best;
}

/**
 * How many Pokémon Prioritize Meta ranks ahead: the Team Evaluation's Top X, at most the
 * ranked list. (The app capped it at 100, its own Top X maximum; the site's Settings go
 * up to every ranked Pokémon, and the option's hint names that number.)
 */
export function topMetaSize(ev) {
  const wanted = Math.max(1, Number.parseInt(ev.settings.top_meta, 10) || 30);
  return Math.max(1, ev.topMeta(wanted).length);
}

/** _v454_preflight_auto_build (V462): the Top-X meta's name keys, when Prioritize Meta is on. */
export function topMetaKeys(ev) {
  const topX = topMetaSize(ev);
  const keys = new Set();
  for (const meta of ev.topMeta(topX).slice(0, topX)) {
    for (const value of [meta?.name, meta?.base_name, meta?._v124_base_species]) {
      const k = compact(value);
      if (k) keys.add(k);
    }
  }
  return keys;
}

/** _v471_candidate_key */
export function candidateKey(meta) {
  for (const field of ["name", "base_name", "form", "_v124_base_species"]) {
    const k = compact(meta?.[field]);
    if (k) return k;
  }
  return "";
}
