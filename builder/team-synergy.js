// Team Synergy, ported from the Companion app.
//
//   profile   _v252_profile over _v250 / _v247 / _v234 (+ V303: the Mega a stone
//             turns into)
//   pair      _v252_pair_synergy (V252 interactions) -> V402 (field-ability
//             pairs) -> V465 (ally-hitting spread moves, final score)
//   team      V465 _v252_team_synergy: weighted pair scores plus a connection bonus
//   members   _v251_member_synergy_rows (the "Team Synergy by Pokemon" popup)
//
// Rule tables come from the app's final runtime (app-data analysisTables).
//
// One deliberate difference: the app's "offense-plus-pivot into Top Meta" pair
// line read the threats of the evaluation last shown on screen, which could be a
// different team's. Both now pass the current evaluation's critical threats.

import { compact, pyFixed } from "./engine.js";

const TYPES = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy"];

/** _v234_norm: lower case, every run of other characters one space. */
export function norm(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Python str.title() */
function pyTitle(text) {
  return String(text).replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/** Python round(x, n) */
function round(x, digits) {
  return Number(pyFixed(Number(x) || 0, digits));
}

/** Python round(x) for the few integer thresholds (half to even). */
function roundInt(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function clamp(value, low = 0, high = 100) {
  const v = Number(value);
  return Math.max(low, Math.min(high, Number.isFinite(v) ? v : 0));
}

function byImpactThenTitle(a, b) {
  const d = -(Number(a.impact) || 0) - -(Number(b.impact) || 0);
  if (d) return d;
  const ta = String(a.title ?? "");
  const tb = String(b.title ?? "");
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

function stableSorted(rows, cmp) {
  return rows.map((row, i) => [row, i]).sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1]).map(([row]) => row);
}

function sortedStrings(values) {
  return [...values].map(String).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function setOf(values) {
  return new Set((values || []).map(String));
}

function intersection(a, b) {
  return new Set([...a].filter((v) => b.has(v)));
}

/** _v250_partner_multiplier. A type immunity stored as 0 reads as neutral (`or 1`), as in the app. */
export function partnerMultiplier(profile, attackType) {
  if (profile.immunities.has(attackType)) return 0.0;
  const weak = profile.weaknesses[attackType];
  const value = weak !== undefined ? weak : profile.resistances[attackType] !== undefined ? profile.resistances[attackType] : 1;
  return Number(value) || 1;
}

/** team_evaluation_v465.spread_partner_effect */
function spreadPartnerEffect(multiplier, telepathy = false) {
  if (telepathy || multiplier <= 0) return ["immune", 12.0];
  if (multiplier <= 0.5) return ["resisted", 9.0];
  if (multiplier > 1.0) return ["weak", -14.0];
  return ["neutral", -7.0];
}

export class TeamSynergy {
  /**
   * @param {TeamEvaluator} evaluator
   * @param {TeamChecks} checks  supplies the Showdown names and Ability fields
   */
  constructor(evaluator, checks) {
    this.ev = evaluator;
    this.checks = checks;
    const t = evaluator.engine.data?.analysisTables || {};
    const dict = (name) => t[name] || {};
    this.spread = dict("_V234_SPREAD");
    this.setterAbility = dict("_V234_SETTER_ABILITY");
    this.setterMove = dict("_V234_SETTER_MOVE");
    this.abuser = Object.fromEntries(Object.entries(dict("_V234_ABUSER")).map(([k, v]) => [k, setOf(v)]));
    this.immunity = Object.fromEntries(Object.entries(dict("_V234_IMMUNITY")).map(([k, v]) => [k, setOf(v)]));
    this.speedModes = dict("_V234_SPEED");
    this.support = setOf(Object.keys(dict("_V234_SUPPORT")));
    this.setup = setOf(t._V234_SETUP);
    this.redirect = dict("_V234_REDIRECT");
    this.ally = dict("_V234_ALLY");
    this.priority = setOf(t._V250_PRIORITY_MOVES);
    this.redirection = setOf(t._V250_REDIRECTION_MOVES);
    this.screens = setOf(t._V250_SCREENS);
    this.disruption = setOf(t._V250_DISRUPTION);
    this.pivots = setOf(t._V250_PIVOT_MOVES);
    this.healing = setOf(t._V250_HEALING);
    this.statusInflict = dict("_V250_STATUS_INFLICT");
    this.statusExploit = Object.fromEntries(Object.entries(dict("_V250_STATUS_EXPLOIT")).map(([k, v]) => [k, setOf(v)]));
    this.entryAbilities = setOf(t._V250_ENTRY_ABILITIES);
    this.opponentSpread = setOf(t._V250_OPPONENT_SPREAD);
    this.speedDrops = Object.entries(dict("_V252_SPEED_DROP_MOVES"));
    this.metaSpeedCache = new Map();
  }

  /** _v234_move_meta: the static move tables first, the engine's metadata after. */
  moveProfile(move) {
    const recorded = this.ev.engine.moves[this.ev.engine.canonicalMoveName(move)]?.analysis?.profile;
    if (Array.isArray(recorded)) return [String(recorded[0] || ""), String(recorded[1] || "").toLowerCase()];
    const meta = this.ev.meta(move);
    return [pyTitle(String(meta.type || "")), String(meta.category || "").toLowerCase()];
  }

  /**
   * _v252_profile for one filled slot.
   * @param {object} entry  {pokemon, item, form, ability, moves}: the slot as saved
   * @param {object} mon    the evaluator's team mon (Mega applied)
   */
  profile(entry, mon) {
    const common = !String(mon.ability || "").trim() || !(entry.moves || []).length ? this.ev.commonSet(entry.pokemon) || {} : {};
    const ability = String(mon.ability || common.ability || "").trim();
    const moves = ((entry.moves || []).length ? entry.moves : common.moves || []).slice(0, 4).map((m) => String(m).trim()).filter(Boolean);
    const types = this.ev.typesFor(mon);
    const moveTypes = [];
    let physical = 0;
    let special = 0;
    let status = 0;
    for (const move of moves) {
      const [type, category] = this.moveProfile(move);
      if ((category === "physical" || category === "special") && type) {
        moveTypes.push(type);
        physical += category === "physical" ? 1 : 0;
        special += category === "special" ? 1 : 0;
      } else if (category === "status") status += 1;
    }
    const weaknesses = {};
    const resistances = {};
    for (const attackType of TYPES) {
      const mult = this.ev.engine.typeMultiplier(attackType, types);
      if (mult > 1.01) weaknesses[attackType] = mult;
      else if (mult < 0.99) resistances[attackType] = mult;
    }
    const ak = norm(ability);
    const mks = new Set(moves.map(norm));
    const fields = new Set();
    if (this.setterAbility[ak]) fields.add(this.setterAbility[ak]);
    for (const k of mks) if (this.setterMove[k]) fields.add(this.setterMove[k]);
    const abuse = new Set(this.abuser[ak] || []);
    if (["solar beam", "solar blade", "growth"].some((k) => mks.has(k))) abuse.add("Sun");
    if (["thunder", "hurricane"].some((k) => mks.has(k))) abuse.add("Rain");
    if (["blizzard", "aurora veil"].some((k) => mks.has(k))) abuse.add("Snow");
    if (mks.has("grassy glide")) abuse.add("Grassy Terrain");
    if (mks.has("expanding force")) abuse.add("Psychic Terrain");
    const immunities = new Set(this.immunity[ak] || []);
    if (types.includes("Flying")) immunities.add("Ground");
    // V303: the Ability's own field, as _v51 names it.
    const [weather, terrain] = this.checks.abilityFields[ability] || ["", ""];
    if (weather) fields.add(weather);
    if (terrain) fields.add(terrain);
    const role = [...mks].some((k) => this.support.has(k)) || status >= 2 ? "support" : physical > special ? "physical" : special > physical ? "special" : "mixed";
    // V247: the slot's own battle stats.
    const stats = this.ev.statsFor(mon);
    const battleStats = { hp: stats.hp, attack: stats.attack, defense: stats.defense, sp_attack: stats.sp_attack, sp_defense: stats.sp_defense, speed: stats.speed };
    // V250
    const item = String(entry.item || "").trim();
    const itemKey = norm(item);
    const name = this.checks.showdownName(mon.form_name || mon.pokemon_name);
    const bulkIndex = battleStats.hp * 0.45 + battleStats.defense * 0.275 + battleStats.sp_defense * 0.275;
    const formText = `${name} ${entry.form || ""}`.toLowerCase();
    const isMega = /(^|[^a-z0-9])mega(?![a-z0-9])/.test(formText) || (itemKey.endsWith("ite") && itemKey !== "eviolite");
    const statusInflict = new Set(Object.entries(this.statusInflict).filter(([move]) => mks.has(move)).map(([, effect]) => effect));
    const hasDamage = moveTypes.length > 0;
    // V252
    const effectiveSpeed = this.ev.engine.effectiveSpeed(mon, {});
    const offense = Math.max(battleStats.attack, battleStats.sp_attack);
    return {
      entry, mon, name, types, ability, ability_key: ak, moves, move_keys: mks,
      move_types: new Set(moveTypes), weaknesses, resistances, immunities, fields, field_abuse: abuse,
      speed_modes: new Set([...mks].filter((k) => this.speedModes[k]).map((k) => this.speedModes[k])),
      speed: roundInt(battleStats.speed), role, has_setup: [...mks].some((k) => this.setup.has(k)),
      has_damage: hasDamage, physical, special, battle_stats: battleStats,
      item, item_key: itemKey, is_mega: isMega, bulk_index: bulkIndex, is_bulky: bulkIndex >= 105, is_fragile: bulkIndex < 82,
      priority_moves: intersection(mks, this.priority), redirection_moves: intersection(mks, this.redirection),
      screen_moves: intersection(mks, this.screens), disruption_moves: intersection(mks, this.disruption),
      pivot_moves: intersection(mks, this.pivots), healing_moves: intersection(mks, this.healing), status_inflict: statusInflict,
      effective_speed: effectiveSpeed, offense_index: offense,
      damage_pressure: Boolean(hasDamage && (offense >= 105 || physical + special >= 2)),
    };
  }

  /** _v252_meta_speed_rows: each Top-X meta Pokemon's speed on its common set. */
  metaSpeedRows() {
    const limit = Math.max(1, Number(this.ev.settings.top_meta) || 20);
    if (this.metaSpeedCache.has(limit)) return this.metaSpeedCache.get(limit);
    const rows = [];
    for (const meta of this.ev.topMeta(limit)) {
      const name = String(meta.name || meta.base_name || "").trim();
      if (!name) continue;
      try {
        const mon = this.ev.commonMon(name, name);
        const item = String(meta.top_item || meta.item || "").trim();
        if (item) mon.item = item;
        const moves = meta.moves || meta.top_moves || [];
        if (moves.length) mon.moves = moves.slice(0, 6);
        const speed = this.ev.engine.effectiveSpeed(mon, {});
        if (speed > 0) rows.push([this.checks.showdownName(name) || name, speed]);
      } catch {
        // a meta row the data cannot build is skipped, as in the app
      }
    }
    const out = rows.length ? rows : [90, 100, 110, 120, 130, 140, 150, 160, 170, 180].map((speed, i) => [`Meta ${i + 1}`, speed]);
    this.metaSpeedCache.set(limit, out);
    return out;
  }

  /** _v250_meta_types */
  metaTypes(threat) {
    const species = String(threat.base_name || threat.name || "");
    const form = String(threat.form || threat.base_name || threat.name || "");
    return (this.ev.engine.pokemon(species, form)?.types || []).map((t) => pyTitle(String(t))).filter(Boolean);
  }

  /** The three pair layers: V252 interactions, V402 field-ability pairs, V465 spread + score. */
  pair(a, b, { threats = [], format = "Doubles" } = {}) {
    const interactions = [];
    const conflicts = [];
    const seen = new Set();
    const conflictSeen = new Set();
    const addInteraction = (title, detail, impact, enabler, beneficiary, mechanism = "") => {
      const k = `${norm(title)}|${norm(enabler)}|${norm(beneficiary)}`;
      if (!title || seen.has(k)) return;
      seen.add(k);
      interactions.push({ title: String(title), detail: String(detail), impact: round(Math.max(1.0, Number(impact) || 1), 1), enabler: String(enabler || ""), beneficiary: String(beneficiary || ""), mechanism: String(mechanism || "") });
    };
    const addConflict = (title, detail, impact = 6.0) => {
      const k = norm(title);
      if (!title || conflictSeen.has(k)) return;
      conflictSeen.add(k);
      conflicts.push({ title: String(title), detail: String(detail), impact: round(Math.max(1.0, Number(impact) || 1), 1) });
    };
    const metaSpeeds = this.metaSpeedRows();
    const metaCount = Math.max(1, metaSpeeds.length);
    const outspeed = (speed, factor = 1.0) => metaSpeeds.filter(([, s]) => Number(speed || 0) > Number(s || 0) * Number(factor || 1)).length;
    // Singles (the website's own rule): the two are never on the field together, so what
    // only works beside a partner (Fake Out or redirection covering its turn, Helping
    // Hand, ally Abilities, moves that hit or trigger the partner, Commander) is skipped.
    const together = !String(format || "").toLowerCase().includes("single");

    // Defensive pivots are directional.
    for (const [source, partner] of [[a, b], [b, a]]) {
      const shared = [];
      for (const [attackType, multiplier] of Object.entries(source.weaknesses)) {
        const pm = partnerMultiplier(partner, attackType);
        if (pm === 0) {
          addInteraction(`${partner.name} gives ${source.name} a ${attackType} immunity pivot`,
            `${source.name} is weak to ${attackType}, while ${partner.name} can enter without taking ${attackType} damage.`,
            Number(multiplier || 1) >= 4 ? 8 : 6, partner.name, source.name, "typing");
        } else if (pm <= 0.5) {
          addInteraction(`${partner.name} covers ${source.name}'s ${attackType} weakness`,
            `The partner resists ${attackType}, creating a real defensive switch option for ${source.name}.`,
            Number(multiplier || 1) >= 4 ? 6 : 4, partner.name, source.name, "typing");
        } else if (pm > 1) shared.push(attackType);
      }
      if (shared.length) {
        const unique = sortedStrings(new Set(shared));
        addConflict(`${source.name} and ${partner.name} share ${unique.slice(0, 3).join(", ")} pressure`,
          "These shared weaknesses reduce the number of safe defensive pivots between the pair.", Math.min(12, 3 + unique.length * 2));
      }
    }

    // Field setters only count when the other Pokemon has a concrete payoff.
    for (const [setter, beneficiary] of [[a, b], [b, a]]) {
      for (const field of setter.fields) {
        let payoff = beneficiary.field_abuse.has(field);
        payoff = payoff || (field === "Rain" && beneficiary.move_types.has("Water"));
        payoff = payoff || (field === "Sun" && beneficiary.move_types.has("Fire"));
        payoff = payoff || (field === "Snow" && (beneficiary.types.includes("Ice") || beneficiary.move_keys.has("aurora veil")));
        payoff = payoff || (field === "Sand" && beneficiary.types.some((t) => ["Rock", "Ground", "Steel"].includes(t)));
        payoff = payoff || (field === "Grassy Terrain" && (beneficiary.move_keys.has("grassy glide") || "Ground" in beneficiary.weaknesses));
        payoff = payoff || (field === "Psychic Terrain" && beneficiary.move_keys.has("expanding force"));
        if (payoff) {
          addInteraction(`${setter.name} enables ${beneficiary.name} with ${field}`,
            `The field setter directly improves ${beneficiary.name}'s ability, move, typing, or damage plan.`, 11, setter.name, beneficiary.name, "field");
        }
        if (field === "Psychic Terrain" && beneficiary.priority_moves.size) addConflict(`Psychic Terrain blocks ${beneficiary.name}'s priority`, "The partner's grounded priority attacks fail while Psychic Terrain is active.", 10);
        if (field === "Misty Terrain" && beneficiary.status_inflict.size) addConflict(`Misty Terrain obstructs ${beneficiary.name}'s status plan`, "Grounded opposing Pokemon cannot receive the intended major status.", 8);
      }
    }

    // Speed support against the configured Top Meta speeds.
    for (const [controller, beneficiary] of [[a, b], [b, a]]) {
      const controllerSpeed = Number(controller.effective_speed ?? controller.speed ?? 0) || 0;
      const beneficiarySpeed = Number(beneficiary.effective_speed ?? beneficiary.speed ?? 0) || 0;
      const canCashIn = Boolean(beneficiary.damage_pressure);
      for (const [move, [factor, affectsBoth]] of this.speedDrops) {
        if (!controller.move_keys.has(move) || !canCashIn) continue;
        const controllerFirst = outspeed(controllerSpeed);
        const before = outspeed(beneficiarySpeed);
        const after = outspeed(beneficiarySpeed, factor);
        const gain = after - before;
        const reliable = controllerFirst >= Math.max(1, roundInt(metaCount * 0.55)) || controller.ability_key === "prankster";
        const meaningful = gain >= Math.max(2, roundInt(metaCount * 0.20)) && after >= Math.max(1, Math.ceil(metaCount * 0.55));
        if (reliable && meaningful) {
          const lead = controller.item_key === "choice scarf" ? `Choice Scarf ${controller.name}` : controller.name;
          const both = affectsBoth && together;
          const scope = both ? "both opposing Pokemon" : together ? "a target" : "the opposing Pokemon";
          addInteraction(`${lead}'s ${pyTitle(move)} unlocks ${beneficiary.name}`,
            `${lead} moves before ${controllerFirst}/${metaCount} Top Meta Pokemon and can slow ${scope}; afterward ${beneficiary.name} moves first in ${after}/${metaCount} matchups instead of ${before}/${metaCount}, letting its damage pressure matter before it is hit.`,
            Math.min(16, 7 + gain * 0.7 + (both ? 2 : 0)), controller.name, beneficiary.name, "speed");
        } else if (meaningful && !reliable) {
          addConflict(`${controller.name}'s ${pyTitle(move)} may arrive too late for ${beneficiary.name}`,
            `The speed drop would improve ${gain} matchups, but ${controller.name} currently moves before only ${controllerFirst}/${metaCount} Top Meta Pokemon.`, 5);
        }
      }
      if (controller.move_keys.has("tailwind") && canCashIn) {
        const before = outspeed(beneficiarySpeed);
        const after = outspeed(beneficiarySpeed * 2.0);
        const gain = after - before;
        if (gain >= Math.max(2, roundInt(metaCount * 0.20)) && after >= Math.max(1, Math.ceil(metaCount * 0.55))) {
          addInteraction(`Tailwind turns ${beneficiary.name} into immediate speed pressure`,
            `${beneficiary.name} improves from ${before}/${metaCount} to ${after}/${metaCount} Top Meta outspeed matchups while carrying meaningful damage.`,
            Math.min(15, 8 + gain * 0.6), controller.name, beneficiary.name, "speed");
        }
      }
      if (controller.move_keys.has("trick room") && canCashIn) {
        const favorable = metaSpeeds.filter(([, s]) => beneficiarySpeed < s).length;
        if (favorable >= Math.max(2, roundInt(metaCount * 0.55))) {
          addInteraction(`Trick Room gives slow ${beneficiary.name} a damage window`,
            `${beneficiary.name} is slower than ${favorable}/${metaCount} Top Meta Pokemon and can attack before them under Trick Room.`,
            Math.min(15, 7 + favorable * 0.5), controller.name, beneficiary.name, "speed");
        }
      }
    }

    // Board-control moves require a beneficiary with a concrete protected action.
    const spreadKeys = new Set([...this.opponentSpread, ...Object.keys(this.spread)]);
    for (const [supporter, beneficiary] of [[a, b], [b, a]]) {
      const supporterMoves = supporter.move_keys;
      let action = "";
      if (beneficiary.has_setup) action = "set up";
      else if (beneficiary.speed_modes.size) action = "establish speed control";
      else if (beneficiary.screen_moves.size) action = "establish screens";
      else if (beneficiary.fields.size) action = "establish its field plan";
      else if (beneficiary.is_fragile && beneficiary.damage_pressure && [...beneficiary.move_keys].some((k) => spreadKeys.has(k))) action = "launch a high-pressure spread attack";
      if (together && supporterMoves.has("fake out") && action) {
        addInteraction(`${supporter.name}'s Fake Out creates ${beneficiary.name}'s setup turn`,
          `Fake Out denies one opposing action while ${beneficiary.name} can safely ${action}; without that concrete action, Fake Out is not counted as pair synergy.`, 9, supporter.name, beneficiary.name, "positioning");
      }
      if (together && supporter.redirection_moves.size && action) {
        const move = pyTitle(sortedStrings(supporter.redirection_moves)[0]);
        addInteraction(`${move} protects ${beneficiary.name}'s key turn`, `${supporter.name} redirects single-target attacks while ${beneficiary.name} can ${action}.`, 11, supporter.name, beneficiary.name, "positioning");
      }
      if (supporter.screen_moves.size && (beneficiary.has_setup || beneficiary.is_fragile)) {
        const screens = sortedStrings(supporter.screen_moves).map(pyTitle).join(", ");
        if (!supporter.screen_moves.has("aurora veil") || supporter.fields.has("Snow") || beneficiary.fields.has("Snow")) {
          addInteraction(`${screens} extends ${beneficiary.name}'s board life`,
            `The damage reduction gives ${beneficiary.has_setup ? "a setup user" : "a fragile attacker"} more chances to execute its plan.`, 8, supporter.name, beneficiary.name, "bulk");
        }
      }
      if (together && supporter.ability_key === "intimidate" && ((Number(beneficiary.battle_stats.defense) || 80) < 100 || beneficiary.has_setup)) {
        addInteraction(`Intimidate patches ${beneficiary.name}'s physical turns`,
          `Lowering both opponents' Attack specifically helps ${beneficiary.name} survive while it ${beneficiary.has_setup ? "sets up" : "uses its lower physical bulk"}.`, 7, supporter.name, beneficiary.name, "bulk");
      }
      if (!together) continue;
      if (supporterMoves.has("helping hand") && beneficiary.damage_pressure) {
        addInteraction(`Helping Hand amplifies ${beneficiary.name}'s real damage pressure`,
          `${beneficiary.name} already carries meaningful direct damage, so the 50% boost has a concrete payoff.`, 8, supporter.name, beneficiary.name, "damage");
      }
      if (supporterMoves.has("coaching") && beneficiary.physical > 0) {
        addInteraction(`Coaching improves physical ${beneficiary.name}`, `The Attack and Defense boosts match ${beneficiary.name}'s selected physical attacks.`, 9, supporter.name, beneficiary.name, "boost");
      }
      if (supporterMoves.has("decorate") && beneficiary.damage_pressure) {
        addInteraction(`Decorate creates a ${beneficiary.name} win condition`, "The large offensive boost is attached to a partner that can immediately convert it into damage.", 12, supporter.name, beneficiary.name, "boost");
      }
    }

    // Ability and ally-hit interactions must match a real partner need.
    for (const [owner, beneficiary] of [[a, b], [b, a]]) {
      const ability = owner.ability_key;
      const redirectType = together ? this.redirect[ability] : "";
      if (redirectType && redirectType in beneficiary.weaknesses) {
        addInteraction(`${owner.ability} redirects ${redirectType} away from ${beneficiary.name}`, "The ability directly removes targeting into a real partner weakness.", 12, owner.name, beneficiary.name, "ability");
      }
      const immune = sortedStrings([...(this.immunity[ability] || [])].filter((t) => t in beneficiary.weaknesses));
      if (immune.length) {
        addInteraction(`${owner.ability} creates a ${immune[0]} switch for ${beneficiary.name}`, `The ability is relevant because ${beneficiary.name} is actually weak to ${immune[0]}.`, 8, owner.name, beneficiary.name, "ability");
      }
      const ally = together ? this.ally[ability] : null;
      if (ally) {
        let applies = ability !== "battery" && ability !== "steely spirit";
        applies = applies || (ability === "battery" && beneficiary.special > 0);
        applies = applies || (ability === "steely spirit" && beneficiary.move_types.has("Steel"));
        if (applies) {
          addInteraction(`${owner.ability} directly supports ${beneficiary.name}`, `${ally[1]} and the partner's selected set can use that effect.`, Math.min(10, Number(ally[0])), owner.name, beneficiary.name, "ability");
        }
      }
      const ownerMoves = owner.move_keys;
      const beneficiaryMoves = beneficiary.move_keys;
      // Moves that hit or target the partner beside them (Doubles only).
      const allyMoves = together ? ownerMoves : new Set();
      if (allyMoves.has("beat up") && ["justified", "stamina", "anger point"].includes(beneficiary.ability_key)) {
        addInteraction(`Beat Up activates ${beneficiary.name}'s ${beneficiary.ability}`, "The ally-targeted multi-hit move intentionally triggers the partner ability before it attacks.", 14, owner.name, beneficiary.name, "combo");
      }
      if (allyMoves.has("surf") && ["water absorb", "dry skin", "storm drain", "steam engine"].includes(beneficiary.ability_key)) {
        addInteraction(`Surf activates ${beneficiary.name}'s ${beneficiary.ability}`, "The spread move provides a beneficial ally trigger instead of ordinary partner damage.", 12, owner.name, beneficiary.name, "combo");
      }
      if (allyMoves.has("discharge") && (beneficiary.immunities.has("Electric") || ["volt absorb", "motor drive", "lightning rod"].includes(beneficiary.ability_key))) {
        addInteraction(`Discharge is safe beside ${beneficiary.name}`, "The partner avoids the ally hit and may gain healing, Speed, or Special Attack from it.", 11, owner.name, beneficiary.name, "combo");
      }
      if (allyMoves.has("earthquake") && (beneficiary.immunities.has("Ground") || beneficiary.ability_key === "telepathy")) {
        addInteraction(`Earthquake is safe beside ${beneficiary.name}`, "The partner's typing or ability removes friendly-fire damage from the spread move.", 10, owner.name, beneficiary.name, "combo");
      }
      for (const [statusMove, statusName] of Object.entries(this.statusInflict)) {
        if (!ownerMoves.has(statusMove)) continue;
        for (const [payoffMove, accepted] of Object.entries(this.statusExploit)) {
          if (beneficiaryMoves.has(payoffMove) && accepted.has(statusName)) {
            addInteraction(`${pyTitle(statusMove)} powers ${beneficiary.name}'s ${pyTitle(payoffMove)}`, `${owner.name} applies the exact status condition that increases the partner move's payoff.`, 10, owner.name, beneficiary.name, "status");
          }
        }
      }
      if (owner.pivot_moves.size && this.entryAbilities.has(beneficiary.ability_key)) {
        const pivot = pyTitle(sortedStrings(owner.pivot_moves)[0]);
        addInteraction(`${pivot} repeatedly reactivates ${beneficiary.name}'s ${beneficiary.ability}`, "The pivot move creates repeatable entry value rather than repositioning with no partner payoff.", 9, owner.name, beneficiary.name, "pivot");
      }
    }

    // Friendly fire (V252): resisted is safe, super effective is a conflict.
    for (const [attacker, partner] of together ? [[a, b], [b, a]] : []) {
      for (const [move, moveType] of Object.entries(this.spread)) {
        if (!attacker.move_keys.has(move)) continue;
        const multiplier = partnerMultiplier(partner, moveType);
        if (multiplier <= 0.5 || partner.ability_key === "telepathy") {
          addInteraction(`${partner.name} safely enables ${attacker.name}'s ${pyTitle(move)}`,
            `The partner takes ${multiplier === 0 || partner.ability_key === "telepathy" ? "no" : "reduced"} friendly-fire damage, so the spread move is practical beside it.`, 10, partner.name, attacker.name, "spread");
        } else if (multiplier > 1) {
          addConflict(`${attacker.name}'s ${pyTitle(move)} threatens ${partner.name}`, "The selected spread move hits the partner super effectively and restricts normal board positioning.", 12);
        }
      }
    }

    // Complementary offense.
    if (a.has_damage && b.has_damage) {
      const combined = new Set([...a.move_types, ...b.move_types]);
      const overlap = intersection(a.move_types, b.move_types);
      if (combined.size >= 5 && overlap.size <= 1) {
        addInteraction(`${a.name} and ${b.name} form complementary attacking coverage`,
          `Together they attack through ${combined.size} types with only ${overlap.size} overlapping type, making one defensive answer less reliable.`, Math.min(10, 4 + combined.size), a.name, b.name, "offense");
      }
      const aPhysical = a.physical > a.special;
      const bPhysical = b.physical > b.special;
      if (aPhysical !== bPhysical && Math.max(a.physical, a.special) > 0 && Math.max(b.physical, b.special) > 0) {
        addInteraction(`${a.name} and ${b.name} split physical and special pressure`, "The pair cannot be contained by only Intimidate/Defense or only special bulk.", 7, a.name, b.name, "offense");
      }
    }

    // Offense-plus-pivot lines into the current evaluation's Top Meta threats.
    const metaPairs = [];
    for (const threat of (threats || []).slice(0, 20)) {
      const threatTypes = this.metaTypes(threat);
      if (!threatTypes.length) continue;
      for (const [attacker, pivot] of [[a, b], [b, a]]) {
        const offense = [...attacker.move_types].some((t) => this.ev.engine.typeMultiplier(t, threatTypes) > 1.01);
        const defense = threatTypes.some((t) => partnerMultiplier(pivot, t) <= 0.5);
        if (offense && defense) {
          metaPairs.push(String(threat.name || "Meta threat"));
          break;
        }
      }
    }
    const uniqueMeta = [...new Set(metaPairs)];
    if (uniqueMeta.length >= 2) {
      addInteraction(`The pair has offense-plus-pivot lines into ${uniqueMeta.length} Top Meta Pokemon`,
        `One partner threatens ${uniqueMeta.slice(0, 5).join(", ")} while the other provides a resistance or immunity pivot into their typings.`, Math.min(12, 5 + uniqueMeta.length), a.name, b.name, "meta");
    }

    const names = [norm(a.name), norm(b.name)];
    const allMoves = new Set([...a.move_keys, ...b.move_keys]);
    const allAbilities = new Set([a.ability_key, b.ability_key]);
    if (together && names.some((n) => n.includes("dondozo")) && names.some((n) => n.includes("tatsugiri")) && allAbilities.has("commander")) {
      addInteraction("Commander creates the Dondozo + Tatsugiri mode", "Tatsugiri enters Dondozo and supplies the intended all-stat boost and Order Up interaction.", 18, "Tatsugiri", "Dondozo", "combo");
    }
    if (together && allMoves.has("swagger") && (allAbilities.has("own tempo") || allAbilities.has("mirror armor"))) {
      addInteraction("Swagger supplies a protected ally Attack boost", "The partner ability prevents or reflects the confusion drawback, turning Swagger into intentional support.", 12, a.name, b.name, "combo");
    }

    let rows = stableSorted(interactions, byImpactThenTitle);
    let bad = stableSorted(conflicts, byImpactThenTitle);

    // V402: a setter paired with the Ability that needs its field is worth 18.
    for (const [setter, beneficiary] of [[a, b], [b, a]]) {
      const required = this.abuser[beneficiary.ability_key] || new Set();
      for (const field of sortedStrings([...setter.fields].filter((f) => required.has(f)))) {
        const title = `${setter.name} enables ${beneficiary.name}'s ${beneficiary.ability || "ability"} with ${field}`;
        const detail = `${setter.name} supplies ${field}, directly activating ${beneficiary.name}'s ${beneficiary.ability || "field-dependent ability"}.`;
        const existing = rows.find((row) => String(row.mechanism || "").toLowerCase() === "field" && norm(row.enabler) === norm(setter.name) && norm(row.beneficiary) === norm(beneficiary.name) && norm(row.title).includes(norm(field)));
        if (existing) {
          existing.impact = Math.max(18.0, Number(existing.impact) || 0);
          existing.title = title;
          existing.detail = detail;
        } else {
          rows.push({ title, detail, impact: 18.0, enabler: String(setter.name || ""), beneficiary: String(beneficiary.name || ""), mechanism: "field" });
        }
      }
    }
    rows = stableSorted(rows, byImpactThenTitle);

    // V465: ally-hitting spread moves in Doubles, then the final pair score.
    const singles = String(format || "").toLowerCase().includes("single");
    if (singles) {
      rows = rows.filter((row) => String(row.category || "") !== "spread");
      bad = bad.filter((row) => String(row.category || "") !== "spread");
    }
    const conflictTitles = new Set(bad.map((row) => String(row.title || "")));
    if (!singles) {
      for (const [attacker, partner] of [[a, b], [b, a]]) {
        for (const [move, moveType] of Object.entries(this.spread)) {
          if (!attacker.move_keys.has(move)) continue;
          const telepathy = String(partner.ability_key || "").toLowerCase() === "telepathy";
          const [relation, signed] = spreadPartnerEffect(partnerMultiplier(partner, moveType), telepathy);
          if (relation === "neutral") {
            const title = `${attacker.name}'s ${pyTitle(move)} also hits ${partner.name}`;
            if (!conflictTitles.has(title)) {
              bad.push({ title, detail: "The spread move damages the adjacent partner for neutral damage, creating avoidable friendly-fire pressure in Doubles.", impact: Math.abs(signed), category: "spread" });
              conflictTitles.add(title);
            }
          } else if (relation === "immune" || relation === "resisted") {
            const title = `${partner.name} safely enables ${attacker.name}'s ${pyTitle(move)}`;
            const match = rows.find((row) => String(row.title || "") === title);
            if (match) match.impact = Math.max(Number(match.impact) || 0, signed);
            else rows.push({ title, detail: "The adjacent partner is immune to or resists the ally-hitting spread move, making that board position naturally compatible.", impact: signed, source: partner.name, target: attacker.name, category: "spread" });
          } else if (relation === "weak") {
            const needle = `${attacker.name}'s ${pyTitle(move)} threatens ${partner.name}`;
            const match = bad.find((row) => String(row.title || "") === needle);
            if (match) match.impact = Math.max(Number(match.impact) || 0, Math.abs(signed));
          }
        }
      }
    }
    rows = stableSorted(rows, byImpactThenTitle);
    bad = stableSorted(bad, byImpactThenTitle);
    const positive = rows.slice(0, 12).reduce((sum, row, i) => sum + (Number(row.impact) || 0) * 0.88 ** i, 0);
    const negative = bad.slice(0, 8).reduce((sum, row, i) => sum + (Number(row.impact) || 0) * 0.9 ** i, 0);
    const score = clamp(38.0 + Math.min(55.0, positive * 0.72) - Math.min(30.0, negative * 0.68));
    return {
      first: a.name, second: b.name, score: round(score, 1),
      interactions: rows, conflicts: bad,
      interaction_count: rows.length, conflict_count: bad.length,
      reasons: rows.slice(0, 8).map((row) => String(row.detail || row.title)),
      cautions: bad.slice(0, 5).map((row) => String(row.detail || row.title)),
      version: 465,
    };
  }

  /**
   * V465 _v252_team_synergy.
   * @param {Array<{entry, mon}>} team  filled slots (Exclude Pokemon already applied)
   * @param {object} options  {threats}: the evaluation's critical threats; {format}
   */
  team(team, options = {}) {
    const profiles = team.map(({ entry, mon }) => this.profile(entry, mon));
    const pairs = [];
    for (let i = 0; i < profiles.length; i += 1) {
      for (let j = i + 1; j < profiles.length; j += 1) pairs.push(this.pair(profiles[i], profiles[j], options));
    }
    const values = pairs.map((pair) => Number(pair.score ?? 50));
    const average = values.length ? values.reduce((s, v) => s + v, 0) / values.length : 50.0;
    const best = values.length ? Math.max(...values) : 50.0;
    const weakest = values.length ? Math.min(...values) : 50.0;
    const connected = pairs.filter((pair) => pair.interaction_count >= 2).length;
    const ratio = connected / Math.max(1, pairs.length);
    const weighted = average * 0.68 + best * 0.1 + weakest * 0.22;
    const score = clamp(weighted + Math.min(4.0, ratio * 4.0));
    const first = (better) => pairs.reduce((pick, pair) => (pick === null || better(Number(pair.score), Number(pick.score)) ? pair : pick), null);
    return {
      score: round(score, 1), version: 465, pair_count: pairs.length, pairs,
      members: profiles.map((p) => String(p.name || "Pokemon")),
      interaction_count: pairs.reduce((s, pair) => s + pair.interaction_count, 0),
      strongest: first((x, y) => x > y),
      weakest: first((x, y) => x < y),
      calculation: {
        pair_average: round(average, 2), strongest_pair: round(best, 2), weakest_pair: round(weakest, 2),
        connected_pairs: connected, connected_ratio: round(ratio, 4),
        weighted_pair_score: round(weighted, 2), connection_bonus: round(Math.min(4.0, ratio * 4.0), 2),
        weights: { average: 0.68, strongest: 0.1, weakest: 0.22 },
      },
      profiles,
    };
  }

  /** _v251_member_synergy_rows: every member with its link to each teammate. */
  memberRows(synergy) {
    const pairs = synergy?.pairs || [];
    const members = (synergy?.members || []).map((n) => String(n).trim()).filter(Boolean);
    const out = [];
    for (const member of members) {
      const k = norm(member);
      const links = [];
      for (const pair of pairs) {
        const first = String(pair.first || "Pokemon");
        const second = String(pair.second || "Pokemon");
        if (k !== norm(first) && k !== norm(second)) continue;
        const partner = k === norm(first) ? second : first;
        const interactions = pair.interactions || [];
        const conflicts = pair.conflicts || [];
        const totalImpact = interactions.reduce((s, row) => s + (Number(row.impact) || 0), 0);
        const connection = interactions.length >= 3 && totalImpact >= 22 ? "strong" : interactions.length ? "partial" : "limited";
        links.push({
          partner, score: Number(pair.score ?? 50), synergy_count: interactions.length, conflict_count: conflicts.length,
          interaction_titles: interactions.slice(0, 4).map((row) => String(row.title || "")),
          evidence: String(interactions[0]?.detail || ""), warning: String(conflicts[0]?.detail || ""), connection, pair,
        });
      }
      const sorted = stableSorted(links, (x, y) => (y.synergy_count - x.synergy_count) || (y.score - x.score) || (x.partner < y.partner ? -1 : x.partner > y.partner ? 1 : 0));
      const adjusted = sorted.map((link) => link.score + Math.min(12, link.synergy_count * 1.5));
      out.push({
        name: member,
        score: round(clamp(adjusted.length ? adjusted.reduce((s, v) => s + v, 0) / adjusted.length : 50), 1),
        links: sorted,
        synergy_count: sorted.reduce((s, link) => s + link.synergy_count, 0),
        strong_link_count: sorted.filter((link) => link.connection === "strong").length,
        limited_link_count: sorted.filter((link) => link.connection === "limited").length,
        partner_count: sorted.length,
      });
    }
    return out;
  }
}

