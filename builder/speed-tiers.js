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
   */
  constructor(evaluator, data = null) {
    this.ev = evaluator;
    this.data = data;
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
    const variants = [
      ...this.metaVariants(Number(s.top_x) || 30).map(([mon, info]) => [Object.assign(mon, { speed_stage: stage((mon.speed_stage || 0) + stage(s.opponent_stage)) }), info]),
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
      summary: `Our Team + Top ${Number(s.top_x) || 30} Meta · ${conditions.join(" · ")}`,
      state: s,
    };
  }
}
