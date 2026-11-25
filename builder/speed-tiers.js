// Speed Tiers: the app's ranked Speed list (SpeedComparisonListV297, V300/V305/
// V363/V409): the selected team plus every Top-X meta Pokemon on its most
// common set, with a Choice Scarf row when Scarf is one of its top items and a
// row for each Speed Ability among its top Abilities. The conditions bar sets
// the weather, each side's Tailwind, Trick Room order and each side's Speed stage.

import { compact, makeMon } from "./engine.js";

/** _V300_SPEED_ABILITY_RULES */
export const SPEED_ABILITY_RULES = {
  chlorophyll: { name: "Chlorophyll", weather: "Sun" },
  "swift swim": { name: "Swift Swim", weather: "Rain" },
  "sand rush": { name: "Sand Rush", weather: "Sand" },
  "slush rush": { name: "Slush Rush", weather: "Snow" },
  "quick feet": { name: "Quick Feet", status: "Burned" },
  unburden: { name: "Unburden", unburden: true },
  "speed boost": { name: "Speed Boost", stage: 1 },
  "motor drive": { name: "Motor Drive", stage: 1 },
  rattled: { name: "Rattled", stage: 1 },
  "weak armor": { name: "Weak Armor", stage: 2 },
  "steam engine": { name: "Steam Engine", stage: 6 },
};

/**
 * V562: a Pokemon that almost never plays WITHOUT its Mega Stone is shown only as its Mega.
 *
 * THE DEFECT. The Speed list gives every Top-X Pokemon a row for its common set and another
 * for each of its top five held items that matters, Choice Scarf among them. Salamence holds
 * Salamencite 96.6% of the time in Doubles -- and Choice Scarf 0.3% -- so the list carried a
 * "Salamence @ Choice Scarf" row at a Speed nobody on the ladder actually presents, while the
 * row that matters (Mega Salamence) sat elsewhere. Measured on the bundled data: Charizard
 * 98.4%, Floette 98.4%, Golisopod 97.6%, Salamence 96.6% and Raichu 96.0% clear the bar in
 * Doubles, and three of those five were carrying that phantom Scarf row.
 *
 * THE SHARE IS SUMMED OVER THE SPECIES' STONES, not read off the top item: Charizardite X and
 * Y are two items for one Pokemon, so a species can be 98% committed to its Mega with no
 * single stone above 50%.
 *
 * 95, INCLUSIVE, is the cutoff this project already uses for "almost everybody does this"
 * (GUARANTEED_MOVE_SHARE in builder/guaranteed-moves.js, and the app's own copy). It is doing
 * real work rather than catching everything: Gardevoir sits at 94.7% in Doubles and Salamence
 * at 93.8% in SINGLES, so the same Pokemon is Mega-only in one format and not in the other.
 *
 * WHAT IS NOT TOUCHED. `metaVariants()` still produces every row it ever did, because the
 * Optimize objective and DeepOptimizer tune against that list (builder/optimize-objective.js,
 * builder/optimize-deep.js) and what a BENCHMARK list should hold is a different question from
 * what the Speed Tiers panel should show. This rule filters the shown list, in `rows()`. Our
 * own team is never filtered: `ourVariants()` is the team as the player built it.
 */
export const MEGA_ONLY_RULE = 1;

/** Percent of a species' usage holding one of its own stones, at or above which only its Mega
 *  is shown. The same cutoff as GUARANTEED_MOVE_SHARE. */
export const MEGA_ONLY_SHARE = 95;

/** `megaOnlyRule` as a flag: absent means production (on), an explicit 0/false means off. */
export function megaOnlyRuleOption(value) {
  if (value === undefined || value === null) return MEGA_ONLY_RULE;
  if (value === false) return 0;
  const text = String(value).trim().toLowerCase();
  if (!text || text === "0" || text === "off" || text === "false" || text === "no" || text === "none") return 0;
  return 1;
}

const isMegaForm = (form) => /^mega[\s-]/i.test(String(form || ""));

export const DEFAULT_SPEED_STATE = Object.freeze({ top_x: 30, weather: "None", own_tailwind: false, opposing_tailwind: false, trick_room: false, our_stage: 0, opponent_stage: 0 });

const abilityKey = (value) => String(value ?? "").trim().toLowerCase();

// _v300_clone_mon: base_form returns to the form the usage file is filed under
// (the app's entry name): Salamence for Mega Salamence, but Hisuian Arcanine and
// Floette-Eternal stay themselves.
function clone(mon, { item, ability, baseForm = false } = {}) {
  const out = makeMon({
    pokemon_name: mon.pokemon_name,
    form_name: baseForm ? mon.entry_form || mon.pokemon_name : mon.form_name || mon.pokemon_name,
    item: item === undefined ? mon.item : item,
    ability: ability === undefined ? mon.ability : ability,
    nature_name: mon.nature_name || "Serious",
    bonuses: [...(mon.bonuses || [0, 0, 0, 0, 0, 0])],
    moves: [...(mon.moves || [])],
    speed_stage: mon.speed_stage || 0,
    status: mon.status || "",
  });
  if (mon.entry_form) out.entry_form = mon.entry_form;
  return out;
}

export class SpeedTiers {
  /**
   * @param {TeamEvaluator} evaluator  (meta records set)
   * @param {BuilderData|null} data    for legal Abilities of a form
   * @param {{megaOnlyRule?: number|string|boolean}} rules  V562, absent means production
   *
   * The V562 flag is read off the EVALUATOR when it is not passed here, because SpeedTiers is
   * built in six places (the worker, the overview, the Optimize objective, DeepOptimizer and
   * two suites) and all six build it from an evaluator they already hold: one assignment,
   * `ev.megaOnlyRule = 0`, therefore reaches every one of them, which is what a replay harness
   * needs. It is deliberately NOT a key of TeamEvaluator's own rules argument -- that argument
   * is the Team Evaluation's scoring rules, and this rule changes a list a panel shows.
   */
  constructor(evaluator, data = null, { megaOnlyRule = undefined } = {}) {
    this.ev = evaluator;
    this.data = data;
    this.megaOnlyRule = megaOnlyRule === undefined ? evaluator?.megaOnlyRule : megaOnlyRule;
  }

  /** V562: percent of this record's usage holding one of the species' own Mega Stones. */
  stoneShare(record, species) {
    let total = 0;
    for (const pair of record?.items || []) {
      const [item, share] = Array.isArray(pair) ? pair : [pair, 0];
      if (!item) continue;
      // Both predicates, as V305's own clean-up below uses both: one maps the stone through
      // the engine's holder table, the other through the V67 species key.
      if (this.ev.stoneMatchesSpecies(species, item) || this.ev.isMegaItemForSpecies(species, item)) {
        total += Number(share) || 0;
      }
    }
    return total;
  }

  /** V562: the Top-X species shown as their Mega only. Empty when the rule is off. */
  megaOnlySpecies(topX) {
    const out = new Set();
    if (!megaOnlyRuleOption(this.megaOnlyRule)) return out;
    // The same records, the same filter and the same slice `metaVariants` uses, so the two
    // cannot disagree about which Pokemon are in the list at all.
    const records = (this.ev.metaRecords || []).filter((r) => Number(r.position) < 999999).slice(0, Math.max(1, topX));
    for (const record of records) {
      const species = String(record.species || record.name);
      if (this.stoneShare(record, species) >= MEGA_ONLY_SHARE) out.add(compact(species));
    }
    return out;
  }

  /** V562: drop those species' non-Mega rows, without ever dropping the species itself. */
  keepMegaOnly(rows, species) {
    if (!species.size) return rows;
    const out = [];
    const kept = new Set();
    for (const entry of rows) {
      const key = compact(entry[0].pokemon_name);
      if (!species.has(key)) {
        out.push(entry);
        continue;
      }
      if (!isMegaForm(entry[0].form_name)) continue;
      out.push(entry);
      kept.add(key);
    }
    // A species the rule applies to must NOT vanish from the Speed list. Nothing in today's
    // data reaches this -- all five have a Mega row -- but it is one upstream change away: the
    // baseline row is base-formed when the common Ability is a Speed Ability
    // (`commonSpeedAbility` below), so a Mega whose own Ability was one would have no Mega row
    // left, and the opponent's fastest Pokemon would quietly leave the list.
    for (const key of species) {
      if (kept.has(key)) continue;
      const first = rows.find((entry) => compact(entry[0].pokemon_name) === key);
      if (first) out.push(first);
    }
    return out;
  }

  legalAbilities(species, form) {
    const record = this.ev.engine.formRecord?.(species, form) || this.ev.engine.pokemon?.(species, form);
    return (record?.abilities || []).map(String).filter(Boolean);
  }

  /** _v305_pick_legal_ability */
  pickLegal(species, form, preferred, fallback = "") {
    const legal = this.legalAbilities(species, form);
    const legalKeys = new Set(legal.map(compact));
    for (const ability of [...preferred, fallback]) {
      const clean = String(ability ?? "").trim();
      if (clean && (!legalKeys.size || legalKeys.has(compact(clean)))) return clean;
    }
    return legal[0] || String(fallback ?? "").trim();
  }

  /** _v297_effective_mega_mon: a matching stone turns the set into its Mega. */
  effectiveMega(mon) {
    const out = clone(mon);
    if (!this.ev.stoneMatchesSpecies(out.pokemon_name, out.item)) return out;
    const form = this.ev.megaFormForItem(out.pokemon_name, out.item);
    if (form && compact(form) !== compact(out.form_name)) {
      out.form_name = form;
      out.ability = this.ev.megaAbility(out.pokemon_name, form, out.ability) || out.ability;
    }
    return out;
  }

  /** _v298_common_meta_set (+ V305): each category's top-ranked entry; a Mega only with its own stone. */
  commonMetaSet(record) {
    const set = record.set || {};
    const species = String(record.species || record.name);
    const mon = this.effectiveMega(makeMon({
      pokemon_name: species,
      form_name: String(record.form || species),
      item: set.item || "",
      ability: set.ability || "",
      nature_name: set.nature || "Serious",
      bonuses: [...(set.bonuses || [0, 0, 0, 0, 0, 0])],
      moves: [...(set.moves || [])].slice(0, 4),
    }));
    mon.entry_form = String(record.form || species);
    const baseAbility = this.pickLegal(species, mon.entry_form, [set.ability, mon.ability], set.ability || "");
    if (!this.ev.isMegaItemForSpecies(species, mon.item) && /^mega[\s-]/i.test(String(mon.form_name))) {
      mon.form_name = mon.entry_form;
      mon.ability = this.pickLegal(species, mon.entry_form, [baseAbility, mon.ability], baseAbility);
    }
    return mon;
  }

  /** _v300_meta_speed_variants (+ V305 legality clean-up and de-duplication) */
  metaVariants(topX) {
    const rows = [];
    const records = (this.ev.metaRecords || []).filter((r) => Number(r.position) < 999999).slice(0, Math.max(1, topX));
    for (const record of records) {
      const set = record.set || {};
      const species = String(record.species || record.name);
      const base = makeMon({
        pokemon_name: species,
        form_name: String(record.form || species),
        item: set.item || "",
        ability: set.ability || "",
        nature_name: set.nature || "Serious",
        bonuses: [...(set.bonuses || [0, 0, 0, 0, 0, 0])],
        moves: [...(set.moves || [])].slice(0, 4),
      });
      const mon = this.effectiveMega(base);
      mon.entry_form = String(record.form || species);
      // V369: the Speed list keeps five top items, so a fourth- or fifth-choice Scarf still gets its row.
      const topItems = (record.items || []).map(([item]) => item).filter(Boolean).slice(0, 5);
      const topAbilities = (record.abilities || []).map(([ability]) => ability).filter(Boolean).slice(0, 3);
      const info = {
        source: "meta",
        position: Number(record.position) || 999999,
        top_items: topItems,
        top_abilities: topAbilities,
        speed_points: Number((set.bonuses || [])[5]) || 0,
        nature: set.nature || "Serious",
        common_item: set.item || "",
        base_ability: set.ability || "",
        variant_label: "",
        name: record.name,
      };
      const commonScarf = compact(mon.item) === "choicescarf";
      const commonSpeedAbility = abilityKey(mon.ability) in SPEED_ABILITY_RULES;
      let baselineAbility = mon.ability;
      if (commonSpeedAbility) baselineAbility = topAbilities.find((a) => !(abilityKey(a) in SPEED_ABILITY_RULES)) || "";
      rows.push([clone(mon, { item: commonScarf ? "" : mon.item, ability: baselineAbility, baseForm: commonScarf || commonSpeedAbility }), { ...info }]);
      if (topItems.some((i) => compact(i) === "choicescarf")) {
        rows.push([clone(mon, { item: "Choice Scarf", ability: baselineAbility || "", baseForm: true }), { ...info, variant_label: "Choice Scarf" }]);
      }
      const seen = new Set();
      for (const ability of topAbilities.filter((a) => abilityKey(a) in SPEED_ABILITY_RULES)) {
        const k = abilityKey(ability);
        if (seen.has(k)) continue;
        seen.add(k);
        const rule = SPEED_ABILITY_RULES[k];
        const variant = clone(mon, {
          item: compact(mon.item) === "choicescarf" || compact(mon.item).endsWith("ite") ? "" : mon.item,
          ability,
          baseForm: compact(mon.form_name) !== compact(mon.pokemon_name),
        });
        variant.speed_stage = rule.stage || 0;
        variant.status = rule.status || "";
        rows.push([variant, { ...info, variant_label: rule.name, speed_ability_key: k }]);
      }
    }
    // V305: a Mega only with its own stone, a legal Ability, no duplicate rows.
    const out = [];
    const seen = new Set();
    for (const [raw, info] of rows) {
      const mon = clone(raw);
      const species = mon.pokemon_name;
      if (/^mega[\s-]/i.test(String(mon.form_name)) && !this.ev.isMegaItemForSpecies(species, mon.item) && !this.ev.stoneMatchesSpecies(species, mon.item)) mon.form_name = mon.entry_form || species;
      mon.ability = this.pickLegal(species, mon.form_name || species, [mon.ability, info.base_ability], mon.ability);
      if (info.speed_ability_key && compact(mon.ability) !== compact(info.speed_ability_key)) continue;
      const k = [compact(species), compact(mon.form_name), compact(mon.item), compact(mon.ability), mon.speed_stage || 0, info.variant_label].join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([mon, info]);
    }
    return out;
  }

  /** _v300_our_speed_variants: the team's own sets, Mega applied. */
  ourVariants(sets) {
    const out = [];
    (sets || []).slice(0, 6).forEach((set, index) => {
      if (!set || !String(set.species || "").trim()) return;
      const mon = this.effectiveMega(makeMon({
        pokemon_name: set.species, form_name: set.form || set.species, item: set.item || "", ability: set.ability || "",
        nature_name: set.nature || "Serious", bonuses: [...(set.bonuses || [0, 0, 0, 0, 0, 0])], moves: [...(set.moves || [])].slice(0, 4),
      }));
      out.push([mon, { source: "our", position: index + 1, speed_points: Number((set.bonuses || [])[5]) || 0, nature: set.nature || "Serious", variant_label: "" }]);
    });
    return out;
  }

  /** _v409_prepare_speed_rows: every row's Speed under the chosen conditions, fastest first. */
  rows(sets, state = DEFAULT_SPEED_STATE) {
    const s = { ...DEFAULT_SPEED_STATE, ...(state || {}) };
    const stage = (value) => Math.max(-6, Math.min(6, Number(value) || 0));
    const topX = Number(s.top_x) || 30;
    // V562: the opponent's side only. Our own rows come from `ourVariants` and are the team as
    // the player built it, so "the Pokemon that are not on our team" is settled by which of the
    // two lists the filter is applied to.
    const metaRows = this.keepMegaOnly(this.metaVariants(topX), this.megaOnlySpecies(topX));
    const variants = [
      ...metaRows.map(([mon, info]) => [Object.assign(mon, { speed_stage: stage((mon.speed_stage || 0) + stage(s.opponent_stage)) }), info]),
      ...this.ourVariants(sets).map(([mon, info]) => [Object.assign(mon, { speed_stage: stage((mon.speed_stage || 0) + stage(s.our_stage)) }), info]),
    ];
    const rows = variants.map(([mon, info]) => {
      const ours = info.source === "our";
      const side = { weather: String(s.weather || "None"), tailwind: Boolean(ours ? s.own_tailwind : s.opposing_tailwind) };
      if (SPEED_ABILITY_RULES[info.speed_ability_key || ""]?.unburden) side.unburden = true;
      let speed;
      try {
        speed = this.ev.engine.effectiveSpeed(mon, side);
      } catch {
        speed = Number(this.ev.engine.finalStats(mon).speed) || 1;
      }
      return { speed: Math.max(1, Math.trunc(speed)), mon, info, ours };
    });
    rows.sort((a, b) => (s.trick_room ? a.speed - b.speed : b.speed - a.speed) || (a.ours ? 0 : 1) - (b.ours ? 0 : 1) || (Number(a.info.position) || 999999) - (Number(b.info.position) || 999999));
    const conditions = [String(s.weather || "None")];
    if (s.own_tailwind) conditions.push("Own Tailwind");
    if (s.opposing_tailwind) conditions.push("Opposing Tailwind");
    if (s.trick_room) conditions.push("Trick Room order");
    const signed = (v) => `${v >= 0 ? "+" : ""}${v}`;
    conditions.push(`Our Speed ${signed(stage(s.our_stage))}`, `Opponent Speed ${signed(stage(s.opponent_stage))}`);
    return {
      rows,
      maximum: Math.max(1, ...rows.map((r) => r.speed)),
      summary: `Our Team + Top ${topX} Meta · ${conditions.join(" · ")}`,
      state: s,
    };
  }
}
