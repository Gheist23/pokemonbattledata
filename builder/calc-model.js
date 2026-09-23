// The Damage Calculator screen's logic, ported from the Companion's
// DamageCalculatorPanel layers (V287 / V290 / V293 / V297 / V314 / V364 / V445).
// Pure state + functions; builder/calc-page.js draws it.
//
// What this adds on top of the engine is the "panel" behaviour:
//   * which weather/terrain is actually up (Auto reads the setters' abilities,
//     slowest setter wins; any button press switches to a manual choice);
//   * which abilities/items are active, triggered or switched off (the effect
//     chips in the result strip), and the manual triggers they imply;
//   * per-side field state (screens, Helping Hand, hazards, Tailwind, ...);
//   * KO odds over repeated hits, Sitrus Berry included;
//   * the "who wins" duel when no move is selected.

import {
  MANUAL_STAGE_CHANGES, PINCH_ABILITIES, RESIST_BERRIES, TRIGGERED_ABILITIES, TYPE_IMMUNITY_ABILITIES, ATE_ABILITIES,
  applyChainedModifiers, clampFaintedAllies, makeContext, makeMon, maxFaintedAllies, pyRound, pyFixed, stagedStat,
} from "./engine.js";
import { makeSet } from "./common.js";

export const LEFT = "left";
export const RIGHT = "right";
export const other = (side) => (side === LEFT ? RIGHT : LEFT);
const norm = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const compactKey = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// How many amount pickers the result strip shows at once when no move is
// selected and several moves have one.
const MAX_COUNT_CONTROLS = 6;

function ordinal(number) {
  const rest = number % 100;
  const suffix = rest >= 10 && rest <= 20 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[number % 10] || "th";
  return `${number}${suffix}`;
}
const hitsLabel = (count) => `${count} hit${count === 1 ? "" : "s"}`;
const usesLabel = (count) => `${ordinal(count)} use`;
const faintedNote = (count) => `${count} fainted all${count === 1 ? "y" : "ies"}`;

/** The number of hits engine.js settles on when no amount has been chosen.
 *  Mirrored here so the picker opens on the number the calculation is already
 *  using; engine.js itself is checked against recorded app results and is left
 *  untouched. */
function defaultHitCount(mon, meta) {
  if (meta.hits) return Math.max(1, Math.min(10, Number(meta.hits) || 1));
  const range = meta.hit_range;
  if (Array.isArray(range) && range.length >= 2) {
    if (norm(mon.ability) === "skill link") return Number(range[1]);
    if (norm(mon.item) === "loaded dice") return Math.max(Number(range[0]), Number(range[1]) - 1);
    return 3;
  }
  return 1;
}

export const FIELD_LABELS = {
  protect: "Protect", helping_hand: "Helping Hand", aurora_veil: "Aurora Veil", reflect: "Reflect",
  light_screen: "Light Screen", tailwind: "Tailwind", friend_guard: "Friend Guard", stealth_rock: "Stealth Rock",
  salt_cure: "Salt Cure",
};
const WEATHER_REQUIREMENTS = {
  "swift swim": "Rain", "rain dish": "Rain", "hydration": "Rain",
  "chlorophyll": "Sun", "solar power": "Sun", "leaf guard": "Sun",
  "sand rush": "Sand", "sand force": "Sand", "sand veil": "Sand",
  "slush rush": "Snow", "ice body": "Snow", "snow cloak": "Snow",
};
const WEATHER_SETTERS = {
  "drizzle": "Rain", "primordial sea": "Rain", "drought": "Sun", "orichalcum pulse": "Sun", "desolate land": "Sun",
  "sand stream": "Sand", "snow warning": "Snow", "snow cloak": "Snow",
};
const TERRAIN_SETTERS = { "electric surge": "Electric", "hadron engine": "Electric", "grassy surge": "Grassy", "psychic surge": "Psychic", "misty surge": "Misty" };
const WIND_MOVES = new Set(["air cutter", "bleakwind storm", "blizzard", "fairy wind", "gust", "heat wave", "hurricane", "icy wind", "petal blizzard", "sandsear storm", "sandstorm", "springtide storm", "tailwind", "twister", "whirlwind", "wildbolt storm"]);
const ALWAYS_VISIBLE = new Set([...TRIGGERED_ABILITIES, "blaze", "torrent", "overgrow", "swarm", "defiant", "competitive", "guard dog", "intimidate", "guts", "quick feet", "marvel scale", "flare boost", "toxic boost", "multiscale", "shadow shield", "sturdy", "swift swim", "rain dish", "hydration", "chlorophyll", "solar power", "leaf guard", "sand rush", "sand force", "sand veil", "slush rush", "ice body", "snow cloak", "unburden"]);
const TYPE_BOOST = {
  "charcoal": "Fire", "mystic water": "Water", "miracle seed": "Grass", "magnet": "Electric", "never-melt ice": "Ice",
  "black belt": "Fighting", "poison barb": "Poison", "soft sand": "Ground", "sharp beak": "Flying", "twisted spoon": "Psychic",
  "silver powder": "Bug", "hard stone": "Rock", "spell tag": "Ghost", "dragon fang": "Dragon", "black glasses": "Dark",
  "metal coat": "Steel", "fairy feather": "Fairy", "silk scarf": "Normal",
};
export const STATUSES = ["Healthy", "Poisoned", "Badly Poisoned", "Burned", "Paralyzed", "Asleep", "Frozen"];
export const GENDERS = ["Unspecified", "Male", "Female", "Genderless"];

export function defaultSideState() {
  return { protect: false, helping_hand: false, aurora_veil: false, reflect: false, light_screen: false, tailwind: false, friend_guard: false, stealth_rock: false, spikes: 0, salt_cure: false };
}

export function defaultMonState(set = makeSet()) {
  return { set, hp: 100, stages: { attack_stage: 0, defense_stage: 0, sp_attack_stage: 0, sp_defense_stage: 0, speed_stage: 0 }, status: "", gender: "Unspecified" };
}

export function defaultCalcState() {
  return {
    format: "Doubles",
    weather: "None",
    weatherMode: "Auto",
    terrain: "None",
    mons: { [LEFT]: defaultMonState(), [RIGHT]: defaultMonState() },
    field: { [LEFT]: defaultSideState(), [RIGHT]: defaultSideState() },
    selectedSide: "",
    selectedIndex: -1,
    critical: false,
    effectOverrides: {},
    effectValues: {},
    // Which saved team the import row shows; "" follows the Team Builder's
    // selected team (builder/calc-page.js importSource()).
    importTeamId: "",
  };
}

export class CalcModel {
  constructor(data, state = defaultCalcState()) {
    this.data = data;
    this.engine = data.engine;
    this.state = state;
  }

  // ---- mons ----
  mon(side) {
    const entry = this.state.mons[side];
    const set = entry.set || makeSet();
    return makeMon({
      pokemon_name: set.species,
      form_name: set.form || set.species,
      item: set.item || "",
      ability: set.ability || "",
      nature_name: set.nature || "Serious",
      bonuses: [...(set.bonuses || [0, 0, 0, 0, 0, 0])],
      moves: (set.moves || []).slice(0, 4),
      current_hp_percent: entry.hp,
      ...entry.stages,
      status: entry.status || "",
      gender: entry.gender || "Unspecified",
    });
  }

  effectKey(side, kind, name) {
    return `${side}:${kind}:${norm(name)}`;
  }

  // ---- field ----
  effectiveWeather() {
    const explicit = String(this.state.weather || "None");
    if (this.state.weatherMode !== "Auto") return explicit;
    const setters = [];
    [LEFT, RIGHT].forEach((side, index) => {
      const mon = this.mon(side);
      const ability = this.engine.effectiveMegaMon(mon).ability || mon.ability;
      const weather = WEATHER_SETTERS[norm(ability)] || this.data.app.weatherSetters?.[ability] || "";
      if (!weather || this.state.effectOverrides[this.effectKey(side, "ability", ability)] === false) return;
      const speed = this.engine.finalStats(mon).speed || 0;
      setters.push([speed, index, weather]);
    });
    setters.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    return setters.length ? setters[setters.length - 1][2] : "None";
  }

  effectiveTerrain() {
    const explicit = String(this.state.terrain || "None");
    if (explicit !== "None") return explicit;
    for (const side of [LEFT, RIGHT]) {
      const mon = this.mon(side);
      const ability = this.engine.effectiveMegaMon(mon).ability || mon.ability;
      const terrain = TERRAIN_SETTERS[norm(ability)];
      if (terrain && this.state.effectOverrides[this.effectKey(side, "ability", ability)] !== false) return terrain;
    }
    return "None";
  }

  selectedMove() {
    const side = this.state.selectedSide;
    if (side !== LEFT && side !== RIGHT || this.state.selectedIndex < 0) return [side, ""];
    return [side, String(this.mon(side).moves[this.state.selectedIndex] || "").trim()];
  }

  moveMetas(side, selectedSide, selectedMove) {
    const moves = selectedMove ? (side === selectedSide ? [selectedMove] : []) : this.mon(side).moves;
    return moves.filter(Boolean).map((move) => {
      const meta = this.engine.moveMeta(makeContext({ move_name: move }));
      return { ...meta, name: meta.name || move, type: String(meta.type || "Normal"), category: String(meta.category || "status").toLowerCase(), flags: new Set((meta.flags || []).map(norm)) };
    });
  }

  incomingTriggerMetas(side) {
    const [selectedSide, selectedMove] = this.selectedMove();
    const otherSide = other(side);
    if (selectedMove) return selectedSide === otherSide ? this.moveMetas(otherSide, otherSide, selectedMove) : [];
    return this.moveMetas(otherSide, "", "");
  }

  opponentStatDrop(side, considerWhiteHerb = true) {
    const mon = this.mon(side);
    if (["attack_stage", "defense_stage", "sp_attack_stage", "sp_defense_stage", "speed_stage"].some((attr) => mon[attr] < 0)) return true;
    const otherSide = other(side);
    const otherMon = this.mon(otherSide);
    const intimidate = norm(otherMon.ability) === "intimidate" && this.state.effectOverrides[this.effectKey(otherSide, "ability", otherMon.ability)] !== false;
    const whiteHerb = norm(mon.item) === "white herb" && this.state.effectOverrides[this.effectKey(side, "item", mon.item)] !== false;
    if (intimidate && (!considerWhiteHerb || !whiteHerb)) return true;
    if (considerWhiteHerb && whiteHerb) return false;
    const lowering = new Set((this.data.app.statLoweringMoves || []).map(norm));
    return this.incomingTriggerMetas(side).some((meta) => lowering.has(norm(meta.name)));
  }

  abilityAutoTrigger(side, ability) {
    const key = norm(ability);
    const mon = this.mon(side);
    const metas = this.incomingTriggerMetas(side);
    const damaging = metas.filter((meta) => meta.category !== "status" && (Number(meta.power) > 0 || meta.fixed_damage));
    const types = new Set(damaging.map((meta) => meta.type));
    const categories = new Set(damaging.map((meta) => meta.category));
    const flags = new Set(metas.flatMap((meta) => [...meta.flags]));
    const names = new Set(metas.map((meta) => norm(meta.name)));
    const wasHit = damaging.length > 0;
    if (["defiant", "competitive", "guard dog"].includes(key)) return this.opponentStatDrop(side);
    if (key === "download") return true;
    if (key === "electromorphosis") return wasHit;
    if (key === "wind power") return flags.has("wind") || [...names].some((n) => WIND_MOVES.has(n));
    if (key === "flash fire") return types.has("Fire");
    if (key === "motor drive") return types.has("Electric");
    if (key === "sap sipper") return types.has("Grass");
    if (key === "storm drain") return types.has("Water");
    if (key === "steam engine") return types.has("Fire") || types.has("Water");
    if (key === "weak armor") return categories.has("physical");
    if (key === "justified") return types.has("Dark");
    if (key === "rattled") return ["Bug", "Dark", "Ghost"].some((t) => types.has(t)) || norm(this.mon(other(side)).ability) === "intimidate";
    if (key === "stamina") return wasHit;
    if (key === "water compaction") return types.has("Water");
    if (key === "berserk" || key === "anger shell") return mon.current_hp_percent <= 50 && wasHit;
    return false;
  }

  whiteHerbConsumed(side) {
    const mon = this.mon(side);
    if (norm(mon.item) !== "white herb") return false;
    const key = this.effectKey(side, "item", mon.item);
    if (key in this.state.effectOverrides) return Boolean(this.state.effectOverrides[key]);
    const otherSide = other(side);
    const otherMon = this.mon(otherSide);
    if (norm(otherMon.ability) !== "intimidate") return false;
    return this.state.effectOverrides[this.effectKey(otherSide, "ability", otherMon.ability)] !== false;
  }

  unburdenActive(side) {
    const mon = this.mon(side);
    if (norm(mon.ability) !== "unburden") return false;
    const key = this.effectKey(side, "ability", mon.ability);
    if (key in this.state.effectOverrides) return Boolean(this.state.effectOverrides[key]);
    return this.whiteHerbConsumed(side);
  }

  effectActive(side, kind, name) {
    const clean = String(name || "").trim();
    if (!clean) return false;
    const key = this.effectKey(side, kind, clean);
    const overrides = this.state.effectOverrides;
    const normalized = norm(clean);
    if (kind === "field") return Boolean(this.state.field[side][normalized]);
    if (kind === "ability" && normalized === "unburden") return this.unburdenActive(side);
    if (key in overrides && !overrides[key]) return false;
    const mon = this.mon(side);
    if (kind === "item" && normalized === "focus sash") return mon.current_hp_percent >= 100;
    if (kind === "item" && normalized === "white herb") return key in overrides ? Boolean(overrides[key]) : this.opponentStatDrop(side, false);
    if (kind !== "ability") return key in overrides ? Boolean(overrides[key]) : true;
    const hp = mon.current_hp_percent;
    const status = mon.status;
    if (PINCH_ABILITIES[normalized] && hp > 33) return false;
    if (["multiscale", "shadow shield", "sturdy"].includes(normalized) && hp < 100) return false;
    if (["guts", "quick feet", "marvel scale"].includes(normalized) && !status) return false;
    if (normalized === "flare boost" && status !== "Burned") return false;
    if (normalized === "toxic boost" && !["Poisoned", "Badly Poisoned"].includes(status)) return false;
    const required = WEATHER_REQUIREMENTS[normalized];
    if (required && this.effectiveWeather() !== required) return false;
    if (["defiant", "competitive", "guard dog"].includes(normalized) || TRIGGERED_ABILITIES.has(normalized)) {
      if (key in overrides) return Boolean(overrides[key]);
      return this.abilityAutoTrigger(side, clean);
    }
    return key in overrides ? Boolean(overrides[key]) : true;
  }

  /** DamageCalculatorPanel.context_for_side, all layers. */
  contextForSide(side, moveName, critical = false) {
    const defending = other(side);
    // V297: context decisions see the Mega ability, not the pre-Mega one.
    const saved = {};
    for (const s of [LEFT, RIGHT]) saved[s] = this.state.mons[s].set.ability;
    const megaAbility = (s) => this.engine.effectiveMegaMon(this.mon(s)).ability;
    const abilities = { [LEFT]: megaAbility(LEFT), [RIGHT]: megaAbility(RIGHT) };
    try {
      this.state.mons[LEFT].set.ability = abilities[LEFT];
      this.state.mons[RIGHT].set.ability = abilities[RIGHT];
      const atkState = { ...this.state.field[side] };
      const defState = { ...this.state.field[defending] };
      const ctx = makeContext({
        move_name: String(moveName || ""),
        weather: this.effectiveWeather(),
        terrain: this.effectiveTerrain(),
        battle_format: this.state.format,
        critical: Boolean(critical),
        spread_move: false,
        burned: Boolean(atkState.burned),
        helping_hand: Boolean(atkState.helping_hand),
        reflect: Boolean(defState.reflect),
        light_screen: Boolean(defState.light_screen),
        aurora_veil: Boolean(defState.aurora_veil),
        friend_guard: Boolean(defState.friend_guard),
        protect: Boolean(defState.protect),
        stealth_rock: Boolean(defState.stealth_rock),
        spikes: Number(defState.spikes || 0),
        salt_cure: Boolean(defState.salt_cure),
        attacker_state: atkState,
        defender_state: defState,
      });
      const attacker = this.mon(side);
      const defender = this.mon(defending);
      const disabled = [];
      if (!this.effectActive(side, "ability", attacker.ability)) disabled.push("attacker:ability");
      if (!this.effectActive(defending, "ability", defender.ability)) disabled.push("defender:ability");
      if (attacker.item && !this.effectActive(side, "item", attacker.item)) disabled.push("attacker:item");
      if (defender.item && !this.effectActive(defending, "item", defender.item)) disabled.push("defender:item");
      ctx._disabled_effects_v290 = disabled;
      const abilityKey = norm(attacker.ability);
      ctx._manual_trigger_attacker_ability_v290 = (TRIGGERED_ABILITIES.has(abilityKey) || ["defiant", "competitive", "guard dog"].includes(abilityKey)) && this.effectActive(side, "ability", attacker.ability);
      ctx.fainted_allies = clampFaintedAllies(this.state.effectValues[`${side}:fainted_allies`] || 0, this.state.format);
      const moveKey = norm(moveName);
      if (moveKey === "last respects" && !this.effectActive(side, "move", "Last Respects")) ctx.fainted_allies = 0;
      // The Rage Fist chip is the on/off switch it looks like: switching it off
      // means this Pokemon has not been hit, as it already did for Last Respects.
      if (moveKey === "rage fist") {
        ctx.attacker_state.times_hit = this.effectActive(side, "move", "Rage Fist")
          ? Math.max(0, Math.min(6, Number(this.state.effectValues[`${side}:times_hit`]) || 0))
          : 0;
      }
      // A chosen amount reaches only the move it was chosen for.
      for (const spec of this.countSpecs(side, moveName)) {
        const value = this.countValue(spec);
        if (spec.kind === "hits") ctx.hits = Math.max(1, Math.min(10, value));
        else if (spec.kind === "times_used") ctx.times_used = Math.max(1, value);
        else if (spec.kind === "ally_fainted_last_turn" && value) ctx.attacker_state.ally_fainted_last_turn = true;
      }
      if (this.unburdenActive(side)) ctx.attacker_state.unburden = true;
      if (this.unburdenActive(defending)) ctx.defender_state.unburden = true;
      ctx.actual_spread_targets_v445 = 1;
      return ctx;
    } finally {
      this.state.mons[LEFT].set.ability = saved[LEFT];
      this.state.mons[RIGHT].set.ability = saved[RIGHT];
    }
  }

  calculate(side, index, critical = false) {
    const mon = this.mon(side);
    const move = mon.moves[index];
    if (!move) return null;
    const ctx = this.contextForSide(side, move, critical);
    return this.engine.calculate(mon, this.mon(other(side)), ctx);
  }

  // ---- stats column ----
  boostedStats(side) {
    const left = this.mon(LEFT);
    const right = this.mon(RIGHT);
    const pair = { [LEFT]: this.engine.effectiveMegaMon(left), [RIGHT]: this.engine.effectiveMegaMon(right) };
    for (const s of [LEFT, RIGHT]) {
      const candidate = pair[s];
      if (!this.effectActive(s, "ability", candidate.ability)) candidate.ability = "";
      if (candidate.item && !this.effectActive(s, "item", candidate.item)) candidate.item = "";
      const abilityKey = norm(candidate.ability);
      if (!candidate.ability || !this.effectActive(s, "ability", candidate.ability)) continue;
      for (const [attr, change] of Object.entries(MANUAL_STAGE_CHANGES[abilityKey] || {})) candidate[attr] = Math.max(-6, Math.min(6, candidate[attr] + change));
      if (abilityKey === "beast boost") {
        const stats = this.engine.finalStats(candidate);
        const order = ["attack", "defense", "sp_attack", "sp_defense", "speed"];
        let best = order[0];
        for (const key of order) if (stats[key] > stats[best]) best = key;
        candidate[`${best}_stage`] = Math.min(6, candidate[`${best}_stage`] + 1);
      } else if (abilityKey === "download") {
        const opp = this.engine.finalStats(pair[other(s)]);
        const attr = opp.defense < opp.sp_defense ? "attack_stage" : "sp_attack_stage";
        candidate[attr] = Math.min(6, candidate[attr] + 1);
      }
    }
    const mon = pair[side];
    const opponent = pair[other(side)];
    const weather = this.effectiveWeather();
    const terrain = this.effectiveTerrain();
    const sideState = { ...this.state.field[side], unburden: this.unburdenActive(side) };
    const total = this.engine.finalStats(mon);
    const boosted = { ...total };
    for (const [key, attr] of [["attack", "attack_stage"], ["defense", "defense_stage"], ["sp_attack", "sp_attack_stage"], ["sp_defense", "sp_defense_stage"], ["speed", "speed_stage"]]) {
      boosted[key] = stagedStat(boosted[key], mon[attr]);
    }
    const ability = norm(mon.ability);
    const item = norm(mon.item);
    const status = String(mon.status || "");
    const types = new Set(this.engine.pokemon(mon.pokemon_name, mon.form_name).types || []);
    const mods = { hp: [], attack: [], defense: [], sp_attack: [], sp_defense: [], speed: [] };
    if (ability === "huge power" || ability === "pure power") mods.attack.push(["", 2.0]);
    if (ability === "hustle") mods.attack.push(["", 1.5]);
    if (ability === "guts" && status) mods.attack.push(["", 1.5]);
    if (item === "choice band") mods.attack.push(["", 1.5]);
    if (ability === "fur coat") mods.defense.push(["", 2.0]);
    if (ability === "marvel scale" && status) mods.defense.push(["", 1.5]);
    if (item === "eviolite") { mods.defense.push(["", 1.5]); mods.sp_defense.push(["", 1.5]); }
    if (weather === "Snow" && types.has("Ice")) mods.defense.push(["", 1.5]);
    if (ability === "solar power" && weather === "Sun") mods.sp_attack.push(["", 1.5]);
    if (ability === "flare boost" && status === "Burned") mods.sp_attack.push(["", 1.5]);
    if (item === "choice specs") mods.sp_attack.push(["", 1.5]);
    if (ability === "ice scales") mods.sp_defense.push(["", 2.0]);
    if (item === "assault vest") mods.sp_defense.push(["", 1.5]);
    if (weather === "Sand" && types.has("Rock")) mods.sp_defense.push(["", 1.5]);
    if (ability === "chlorophyll" && weather === "Sun") mods.speed.push(["", 2.0]);
    if (ability === "swift swim" && weather === "Rain") mods.speed.push(["", 2.0]);
    if (ability === "sand rush" && weather === "Sand") mods.speed.push(["", 2.0]);
    if (ability === "slush rush" && weather === "Snow") mods.speed.push(["", 2.0]);
    if (ability === "quick feet" && status) mods.speed.push(["", 1.5]);
    else if (status === "Paralyzed") mods.speed.push(["", 0.5]);
    if (item === "choice scarf") mods.speed.push(["", 1.5]);
    if (item === "iron ball") mods.speed.push(["", 0.5]);
    if (sideState.tailwind) mods.speed.push(["", 2.0]);
    if (sideState.unburden) mods.speed.push(["", 2.0]);
    // V287 additions
    const species = `${mon.pokemon_name} ${mon.form_name}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const extra = { hp: [], attack: [], defense: [], sp_attack: [], sp_defense: [], speed: [] };
    if (ability === "gorilla tactics") extra.attack.push(["", 1.5]);
    if (ability === "toxic boost" && ["Poisoned", "Badly Poisoned"].includes(status)) extra.attack.push(["", 1.5]);
    if (ability === "slow start" && !sideState.slow_start_ended) extra.attack.push(["", 0.5]);
    if (ability === "orichalcum pulse" && weather === "Sun") extra.attack.push(["", 4 / 3]);
    if (ability === "hadron engine" && terrain === "Electric") extra.sp_attack.push(["", 4 / 3]);
    if (ability === "grass pelt" && terrain === "Grassy") extra.defense.push(["", 1.5]);
    if (item === "light ball" && species.includes("pikachu")) { extra.attack.push(["", 2.0]); extra.sp_attack.push(["", 2.0]); }
    const otherAbility = norm(opponent.ability);
    if (otherAbility === "tablets of ruin") extra.attack.push(["", 0.75]);
    if (otherAbility === "vessel of ruin") extra.sp_attack.push(["", 0.75]);
    if (otherAbility === "sword of ruin") extra.defense.push(["", 0.75]);
    if (otherAbility === "beads of ruin") extra.sp_defense.push(["", 0.75]);
    for (const key of Object.keys(mods)) {
      if (mods[key].length) boosted[key] = Math.max(1, applyChainedModifiers(boosted[key], mods[key]));
      if (extra[key].length) boosted[key] = Math.max(1, applyChainedModifiers(boosted[key], extra[key]));
    }
    return { total, boosted };
  }

  // ---- KO odds ----
  static koHitLabel(hits) {
    return hits <= 1 ? "OHKO" : `${hits}HKO`;
  }

  static koProbability(value) {
    const pct = Math.max(0, Math.min(100, value * 100));
    if (Math.abs(pct - pyRound(pct)) < 0.05) return `${Math.trunc(pyRound(pct))}%`;
    return `${pyFixed(pct, 1).replace(/0+$/, "").replace(/\.$/, "")}%`;
  }

  formatKoOdds(result, maxHits = 8) {
    if (!result) return "";
    if (!result.sitrus_berry_active) {
      if (result.focus_sash_active) return "Focus Sash prevents the OHKO · Guaranteed 2HKO if the next hit lands";
      if (result.sturdy_active) return "Sturdy prevents the OHKO · Guaranteed 2HKO if the next hit lands";
      const rolls = (result.rolls || []).map((v) => Math.max(0, Math.trunc(v)));
      if (!rolls.length || Math.max(...rolls) <= 0) return String(result.ko || "No direct damage.");
      const hp = Math.max(1, Number(result.current_hp) || 1);
      let distribution = new Map([[0, 1]]);
      let firstPositive = null;
      for (let hits = 1; hits <= maxHits; hits += 1) {
        const next = new Map();
        for (const [total, count] of distribution) {
          for (const roll of rolls) {
            const value = Math.min(hp, total + roll);
            next.set(value, (next.get(value) || 0) + count);
          }
        }
        distribution = next;
        const cases = rolls.length ** hits;
        const success = distribution.get(hp) || 0;
        const chance = success / Math.max(1, cases);
        if (chance > 0 && !firstPositive) firstPositive = [hits, chance];
        if (chance >= 1.0) {
          const label = CalcModel.koHitLabel(hits);
          if (firstPositive && firstPositive[0] < hits && firstPositive[1] < 1.0) return `${CalcModel.koProbability(firstPositive[1])} chance to ${CalcModel.koHitLabel(firstPositive[0])} · Guaranteed ${label}`;
          return `Guaranteed ${label}`;
        }
      }
      if (firstPositive) return `${CalcModel.koProbability(firstPositive[1])} chance to ${CalcModel.koHitLabel(firstPositive[0])}`;
      return `No KO chance within ${maxHits} hits`;
    }
    // Sitrus Berry: heals once at <= 50%; accuracy included (V290).
    const rolls = (result.rolls || []).map((v) => Math.max(0, Math.trunc(v)));
    if (!rolls.length || Math.max(...rolls) <= 0) return String(result.ko || "No direct damage.");
    const current = Math.max(1, Number(result.current_hp) || 1);
    const maxHp = Math.max(1, Number(result.max_hp) || current);
    const heal = Math.max(1, Number(result.sitrus_heal) || Math.floor(maxHp / 4));
    const accuracy = Math.max(0, Math.min(1, Number(result.move_accuracy_factor ?? 1)));
    const outcomes = rolls.map((roll) => [roll, accuracy / rolls.length]);
    if (accuracy < 0.999999) outcomes.push([0, 1 - accuracy]);
    let distribution = new Map([[`${current}|0`, 1]]);
    let firstPositive = null;
    for (let hits = 1; hits <= maxHits; hits += 1) {
      const next = new Map();
      for (const [state, probability] of distribution) {
        const [hpText, usedText] = state.split("|");
        const hp = Number(hpText);
        const used = usedText === "1";
        for (const [damage, p] of outcomes) {
          let nextHp = Math.max(0, hp - damage);
          let nextUsed = used;
          if (!used && nextHp > 0 && nextHp <= Math.floor(maxHp / 2)) {
            nextHp = Math.min(maxHp, nextHp + heal);
            nextUsed = true;
          }
          const key = `${nextHp}|${nextUsed ? 1 : 0}`;
          next.set(key, (next.get(key) || 0) + probability * p);
        }
      }
      distribution = next;
      let chance = 0;
      for (const [state, probability] of distribution) if (Number(state.split("|")[0]) <= 0) chance += probability;
      if (chance > 0 && !firstPositive) firstPositive = [hits, chance];
      if (chance >= 0.999999) {
        const label = CalcModel.koHitLabel(hits);
        if (firstPositive && firstPositive[0] < hits) return `${CalcModel.koProbability(firstPositive[1])} chance to ${CalcModel.koHitLabel(firstPositive[0])} · Guaranteed ${label} after Sitrus Berry`;
        return `Guaranteed ${label} after Sitrus Berry`;
      }
    }
    if (firstPositive) return `${CalcModel.koProbability(firstPositive[1])} chance to ${CalcModel.koHitLabel(firstPositive[0])} after Sitrus Berry`;
    return `No KO chance within ${maxHits} hits after Sitrus Berry`;
  }

  // ---- the duel when no move is selected (V290 / V294) ----
  bestMove(side) {
    const attacker = this.mon(side);
    let best = null;
    attacker.moves.forEach((move, index) => {
      if (!move) return;
      const ctx = this.contextForSide(side, move, false);
      const result = this.engine.calculate(attacker, this.mon(other(side)), ctx);
      const rolls = (result.rolls || []).map((v) => Math.max(0, Math.trunc(v)));
      const expected = (rolls.length ? rolls.reduce((s, v) => s + v, 0) / rolls.length : 0) * Math.max(0, Math.min(1, Number(result.move_accuracy_factor ?? 1)));
      const priority = Number(this.engine.moveMeta(ctx).priority || 0);
      const candidate = { move, index, result, damage: expected, priority };
      if (!best || candidate.damage > best.damage) best = candidate;
    });
    return best;
  }

  matchup() {
    const empty = { rolls: [0], move_accuracy_factor: 1 };
    const bestLeft = this.bestMove(LEFT) || { move: "No damaging move", result: empty, damage: 0, priority: 0 };
    const bestRight = this.bestMove(RIGHT) || { move: "No damaging move", result: empty, damage: 0, priority: 0 };
    if (Math.max(bestLeft.damage, bestRight.damage) <= 0) return { text: "Neither Pokémon wins under the current conditions.", winner: "", turns: 0 };
    const maximum = { [LEFT]: Math.max(1, this.engine.finalStats(this.mon(LEFT)).hp), [RIGHT]: Math.max(1, this.engine.finalStats(this.mon(RIGHT)).hp) };
    const hp = {
      [LEFT]: Math.max(1, Math.trunc(pyRound((maximum[LEFT] * this.state.mons[LEFT].hp) / 100))),
      [RIGHT]: Math.max(1, Math.trunc(pyRound((maximum[RIGHT] * this.state.mons[RIGHT].hp) / 100))),
    };
    const best = { [LEFT]: bestLeft, [RIGHT]: bestRight };
    const speed = { [LEFT]: this.boostedStats(LEFT).boosted.speed, [RIGHT]: this.boostedStats(RIGHT).boosted.speed };
    let order = [LEFT, RIGHT];
    const leftKey = [bestLeft.priority, speed[LEFT]];
    const rightKey = [bestRight.priority, speed[RIGHT]];
    if (rightKey[0] > leftKey[0] || (rightKey[0] === leftKey[0] && rightKey[1] > leftKey[1])) order = [RIGHT, LEFT];
    const berryUsed = { [LEFT]: false, [RIGHT]: false };
    const sashUsed = { [LEFT]: false, [RIGHT]: false };
    const counts = { [LEFT]: 0, [RIGHT]: 0 };
    let winner = "";
    let rounds = 0;
    const recoilOf = (result) => {
      const values = (String(result.recoil_hp_range || "").match(/\d+/g) || []).map(Number);
      if (!values.length) return 0;
      if (values.length === 1) return Math.max(0, values[0]);
      return Math.max(0, Math.trunc(pyRound((values[0] + values[1]) / 2)));
    };
    for (let round = 1; round <= 500 && !winner; round += 1) {
      rounds = round;
      for (const acting of order) {
        const target = other(acting);
        if (hp[acting] <= 0 || hp[target] <= 0) continue;
        const result = best[acting].result;
        const expected = Math.max(0, best[acting].damage);
        const damage = expected > 0 ? Math.max(1, Math.trunc(pyRound(expected))) : 0;
        if (damage <= 0) continue;
        counts[acting] += 1;
        if (!sashUsed[target] && hp[target] === maximum[target] && (result.focus_sash_active || result.sturdy_active) && damage >= hp[target]) {
          hp[target] = 1;
          sashUsed[target] = true;
        } else {
          hp[target] = Math.max(0, hp[target] - damage);
        }
        const recoil = recoilOf(result);
        if (recoil > 0) hp[acting] = Math.max(0, hp[acting] - recoil);
        for (const [who, used] of [[target, berryUsed], [acting, berryUsed]]) {
          const mon = this.mon(who);
          if (hp[who] > 0 && !used[who] && norm(mon.item) === "sitrus berry" && this.effectActive(who, "item", mon.item) && hp[who] <= Math.floor(maximum[who] / 2)) {
            hp[who] = Math.min(maximum[who], hp[who] + Math.max(1, Math.floor(maximum[who] / 4)));
            used[who] = true;
          }
        }
        if (hp[target] <= 0 && hp[acting] <= 0) { winner = target; break; }
        if (hp[target] <= 0 && hp[acting] > 0) { winner = acting; break; }
        if (hp[acting] <= 0 && hp[target] > 0) { winner = target; break; }
      }
    }
    if (!winner) {
      winner = [LEFT, RIGHT].sort((a, b) => (hp[b] / maximum[b]) - (hp[a] / maximum[a]) || best[b].damage - best[a].damage || speed[b] - speed[a])[0];
    }
    const winnerMon = this.mon(winner);
    const remaining = Math.max(0, hp[winner]);
    const percent = pyRound((remaining * 1000) / maximum[winner]) / 10;
    const used = counts[winner];
    const move = best[winner].move;
    let summary = this.formatKoOdds(best[winner].result).replace(/\n/g, " ").trim();
    if (summary) summary = summary[0].toLowerCase() + summary.slice(1);
    const [winnerSpecies, winnerForm] = this.data.battleForm(winnerMon.pokemon_name, winnerMon.form_name, winnerMon.item);
    const name = this.data.displayName(winnerSpecies, winnerForm, winnerMon.form_name);
    const pctText = Number.isInteger(percent) ? String(percent) : String(percent);
    return {
      winner,
      turns: rounds,
      headline: `${winner === LEFT ? "Our" : "Opposing"} ${name} wins`,
      detail: `${name} has ${remaining} / ${maximum[winner]} HP (${pctText}%) left${used > 0 ? ` after ${used} ${move}${summary ? ` (${summary})` : ""}` : ""}.`,
    };
  }

  // ---- effect chips (V290 / V291 relevance) ----
  effectChips(result) {
    const [selectedSideRaw, selectedMove] = this.selectedMove();
    const selectedSide = selectedSideRaw === LEFT || selectedSideRaw === RIGHT ? selectedSideRaw : LEFT;
    const records = [];
    for (const side of [LEFT, RIGHT]) {
      const mon = this.engine.effectiveMegaMon(this.mon(side));
      if (mon.ability && this.abilityRelevant(side, mon.ability, selectedSide, selectedMove)) records.push({ side, kind: "ability", name: mon.ability, display: mon.ability });
      if (mon.item && this.itemRelevant(side, mon.item, selectedSide, selectedMove)) {
        records.push({ side, kind: "item", name: mon.item, display: norm(mon.item) === "sitrus berry" ? this.sitrusDisplay(result) : mon.item });
      }
    }
    for (const side of [LEFT, RIGHT]) {
      for (const [key, label] of Object.entries(FIELD_LABELS)) {
        if (this.state.field[side][key] && this.fieldRelevant(side, key, selectedSide, selectedMove)) records.push({ side, kind: "field", name: key, display: label });
      }
    }
    const sources = selectedMove ? [[selectedSide, selectedMove]] : [LEFT, RIGHT].flatMap((side) => this.mon(side).moves.map((move) => [side, move]));
    const seen = new Set();
    for (const [side, move] of sources) {
      const key = norm(move);
      if ((key === "last respects" || key === "rage fist") && !seen.has(`${side}:${key}`)) {
        seen.add(`${side}:${key}`);
        records.push({ side, kind: "move", name: move, display: move });
      }
    }
    const counts = {};
    for (const record of records) counts[norm(record.name)] = (counts[norm(record.name)] || 0) + 1;
    const order = { ability: 0, item: 1, move: 2, field: 3 };
    records.sort((a, b) => order[a.kind] - order[b.kind]);
    return records.slice(0, 12).map((record) => {
      const normalized = norm(record.name);
      let options = null;
      let value = null;
      if (normalized === "supreme overlord" || normalized === "last respects") {
        const limit = maxFaintedAllies(this.state.format);
        options = Array.from({ length: limit + 1 }, (_, n) => [`${n} fainted`, n]);
        value = clampFaintedAllies(this.state.effectValues[`${record.side}:fainted_allies`] || 0, this.state.format);
      } else if (normalized === "rage fist") {
        options = [["Not hit", 0], ...Array.from({ length: 6 }, (_, n) => [`Hit ${n + 1}x`, n + 1])];
        value = Number(this.state.effectValues[`${record.side}:times_hit`] || 0);
      }
      const reason = record.kind === "ability" ? this.abilityReason(record.side, record.name) : record.kind === "item" ? this.itemReason(record.side, record.name) : "";
      const locked = !this.effectActive(record.side, record.kind, record.name) && reason && (WEATHER_REQUIREMENTS[normalized] || PINCH_ABILITIES[normalized]);
      return {
        ...record,
        label: counts[normalized] > 1 ? `${record.side === LEFT ? "Our" : "Opposing"} · ${record.display}` : record.display,
        active: this.effectActive(record.side, record.kind, record.name),
        reason,
        locked: Boolean(locked),
        options,
        value,
      };
    });
  }

  setEffect(side, kind, name, active) {
    if (kind === "field") this.state.field[side][norm(name)] = Boolean(active);
    else this.state.effectOverrides[this.effectKey(side, kind, name)] = Boolean(active);
  }

  setEffectValue(side, name, value) {
    const normalized = norm(name);
    if (normalized === "supreme overlord" || normalized === "last respects") this.state.effectValues[`${side}:fainted_allies`] = clampFaintedAllies(value, this.state.format);
    else if (normalized === "rage fist") this.state.effectValues[`${side}:times_hit`] = Math.max(0, Math.min(6, Number(value) || 0));
  }

  // ---- amounts for the moves whose strength is a count ----

  /** Every amount `move` offers for the Pokemon on `side`: how many times it
   *  hits, which use in a row it is, and whether an ally fainted last turn.
   *  Each spec carries its own storage key, so one move's amount never reaches
   *  another move or the other side. */
  countSpecs(side, move) {
    const key = norm(move);
    if (!key) return [];
    const meta = this.moveMetaFor(move);
    if (!isDamaging(meta)) return [];
    const mon = this.engine.effectiveMegaMon(this.mon(side));
    const ability = norm(mon.ability);
    const item = norm(mon.item);
    const special = String(meta.special || "");
    const specs = [];

    const range = meta.hit_range;
    if (ability !== "skill link") {
      // Skill Link always lands every hit, so there is nothing to choose.
      if (Array.isArray(range) && range.length >= 2) {
        const high = Number(range[1]);
        const low = item === "loaded dice" ? Math.max(Number(range[0]), high - 1) : Number(range[0]);
        const auto = defaultHitCount(mon, meta);
        specs.push({
          kind: "hits",
          storeKey: `${side}:hits:${key}`,
          options: countOptions(low, high, hitsLabel),
          default: auto,
          natural: true,
          tip: `How many times ${move} hits: ${low} to ${high}. Without a choice the calculator assumes ${hitsLabel(auto)}.`,
        });
      } else if (key === "population bomb" || special === "triple_axel" || special === "triple_kick") {
        const top = Math.max(1, Math.min(10, Number(meta.hits) || (key === "population bomb" ? 10 : 3)));
        specs.push({
          kind: "hits",
          storeKey: `${side}:hits:${key}`,
          options: countOptions(1, top, hitsLabel),
          default: top,
          natural: true,
          tip: `How many of the ${top} hits of ${move} land. Each hit can miss on its own.`,
        });
      }
    }

    let topUses = 0;
    let natural = true;
    let tip = "";
    if (special === "successive_power") {
      if (key === "fury cutter") {
        // It doubles per use up to 160 power, so 40 -> 80 -> 160 is three uses.
        const base = Math.max(1, Math.trunc(Number(meta.power) || 40));
        topUses = 1;
        while (topUses < 4 && base * 2 ** (topUses - 1) < 160) topUses += 1;
      } else {
        topUses = 5;
        for (const effect of meta.effect_script || []) {
          if (effect && typeof effect === "object" && String(effect.op || "") === "successive_power") {
            topUses = Math.max(2, Math.min(10, Number(effect.max_uses) || 5));
          }
        }
      }
      tip = `Which use in a row this is. ${move} gets stronger each turn it is used again.`;
    } else if (special === "team_successive_power") {
      topUses = 5;
      tip = `Which turn in a row ${move} is used, by any Pokémon on the field. It gets stronger each turn.`;
    }
    if (item === "metronome") {
      if (topUses < 6) {
        // An amount the held item brings, not the move: offered for the move
        // being looked at rather than for every move at once.
        natural = topUses > 0;
        topUses = 6;
      }
      tip = `${tip ? `${tip} ` : ""}The Metronome item adds 20% per use of the same move in a row, up to double.`;
    }
    if (topUses > 1) {
      specs.push({
        kind: "times_used",
        storeKey: `${side}:times_used:${key}`,
        options: countOptions(1, topUses, usesLabel),
        default: 1,
        natural,
        tip,
      });
    }

    if (special === "retaliate" || key === "retaliate") {
      specs.push({
        kind: "ally_fainted_last_turn",
        storeKey: `${side}:ally_fainted_last_turn`,
        options: [["No ally fainted", 0], ["Ally fainted", 1]],
        default: 0,
        natural: true,
        tip: "Retaliate doubles in power if a teammate fainted on the previous turn.",
      });
    }
    return specs;
  }

  /** Move facts only, so a bare context does. */
  moveMetaFor(move) {
    return this.engine.moveMeta(makeContext({ move_name: String(move || ""), battle_format: this.state.format }));
  }

  /** The amount this spec holds, snapped to an option it still offers: picking
   *  up Loaded Dice can take "2 hits" off the list after it was chosen. */
  countValue(spec) {
    const stored = this.state.effectValues[spec.storeKey];
    const allowed = spec.options.map(([, value]) => value);
    let value = stored === undefined || stored === null ? spec.default : Number(stored);
    if (!Number.isFinite(value)) value = spec.default;
    if (!allowed.includes(value) && allowed.length) {
      value = allowed.reduce((best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best), allowed[0]);
    }
    return value;
  }

  setCountValue(storeKey, value, fallback) {
    const parsed = Number(value);
    const next = Number.isFinite(parsed) ? Math.trunc(parsed) : Number(fallback);
    if (next === Number(fallback)) delete this.state.effectValues[storeKey];
    else this.state.effectValues[storeKey] = next;
  }

  /** The amount pickers the result strip should draw: the selected move's, or
   *  those of every move on the board while the matchup is shown. */
  countControls() {
    const [rawSide, selectedMove] = this.selectedMove();
    const selectedSide = rawSide === LEFT || rawSide === RIGHT ? rawSide : LEFT;
    const sources = selectedMove
      ? [[selectedSide, selectedMove]]
      : [LEFT, RIGHT].flatMap((side) => this.mon(side).moves.slice(0, 4).map((move) => [side, move]));
    const rows = [];
    const seen = new Set();
    for (const [side, move] of sources) {
      const key = norm(move);
      if (!key || seen.has(`${side}:${key}`)) continue;
      seen.add(`${side}:${key}`);
      for (const spec of this.countSpecs(side, move)) {
        if (!selectedMove && !spec.natural && !(spec.storeKey in this.state.effectValues)) continue;
        rows.push({ side, move, spec });
      }
    }
    const shown = rows.slice(0, MAX_COUNT_CONTROLS);
    const sidesPerMove = new Map();
    for (const row of shown) {
      const key = norm(row.move);
      if (!sidesPerMove.has(key)) sidesPerMove.set(key, new Set());
      sidesPerMove.get(key).add(row.side);
    }
    return shown.map((row) => ({
      ...row,
      label: sidesPerMove.get(norm(row.move)).size > 1 ? `${row.side === LEFT ? "Our" : "Opposing"} · ${row.move}` : row.move,
      value: this.countValue(row.spec),
    }));
  }

  /** What the result heading should say about the amounts behind this move,
   *  e.g. "2 fainted allies" or "hit 3 times". */
  headerNotes(side, move) {
    const key = norm(move);
    const notes = [];
    let usesFainted = key === "last respects" && this.effectActive(side, "move", "Last Respects");
    const ability = this.engine.effectiveMegaMon(this.mon(side)).ability;
    if (!usesFainted && norm(ability) === "supreme overlord" && this.effectActive(side, "ability", ability)) {
      usesFainted = isDamaging(this.moveMetaFor(move));
    }
    if (usesFainted) notes.push(faintedNote(clampFaintedAllies(this.state.effectValues[`${side}:fainted_allies`] || 0, this.state.format)));
    if (key === "rage fist" && this.effectActive(side, "move", "Rage Fist")) {
      const hit = Math.max(0, Math.min(6, Number(this.state.effectValues[`${side}:times_hit`]) || 0));
      notes.push(hit === 0 ? "not hit yet" : `hit ${hit} time${hit === 1 ? "" : "s"}`);
    }
    for (const spec of this.countSpecs(side, move)) {
      const value = this.countValue(spec);
      if (spec.kind === "hits") notes.push(hitsLabel(value));
      else if (spec.kind === "times_used" && value > 1) notes.push(usesLabel(value));
      else if (spec.kind === "ally_fainted_last_turn" && value) notes.push("ally fainted last turn");
    }
    return notes;
  }

  /** Singles has one ally fewer than Doubles, so a stored count can be too
   *  high for the format the calculator has just been switched to. */
  setFormat(format) {
    for (const key of Object.keys(this.state.effectValues)) {
      if (key.endsWith(":fainted_allies")) this.state.effectValues[key] = clampFaintedAllies(this.state.effectValues[key], format);
    }
    this.state.format = format;
  }

  /** A state restored from this browser can carry amounts from another format
   *  or from an older version of the page. */
  normalizeEffectValues() {
    if (!this.state.effectValues || typeof this.state.effectValues !== "object") {
      this.state.effectValues = {};
      return;
    }
    for (const [key, value] of Object.entries(this.state.effectValues)) {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        delete this.state.effectValues[key];
      } else if (key.endsWith(":fainted_allies")) {
        this.state.effectValues[key] = clampFaintedAllies(number, this.state.format);
      } else if (key.endsWith(":times_hit")) {
        this.state.effectValues[key] = Math.max(0, Math.min(6, Math.trunc(number)));
      } else {
        this.state.effectValues[key] = Math.trunc(number);
      }
    }
  }

  /** A new Pokemon on this side starts with no amounts chosen. */
  clearSideValues(side) {
    for (const key of Object.keys(this.state.effectValues)) {
      if (key.startsWith(`${side}:`)) delete this.state.effectValues[key];
    }
  }

  sitrusDisplay(result) {
    if (!result || !result.sitrus_berry_active) return "Sitrus Berry (at ≤50% HP)";
    const rolls = (result.rolls || []).filter((v) => Number.isFinite(v));
    const current = Number(result.current_hp || result.max_hp || 1);
    const maximum = Number(result.max_hp || current || 1);
    if (!rolls.length) return "Sitrus Berry (at ≤50% HP)";
    const average = Math.max(1, Math.trunc(pyRound(rolls.reduce((s, v) => s + v, 0) / rolls.length)));
    let hp = current;
    for (let hit = 1; hit <= 8; hit += 1) {
      hp -= average;
      if (hp > 0 && hp <= Math.floor(maximum / 2)) return `Sitrus Berry (after hit ${hit})`;
      if (hp <= 0) break;
    }
    return "Sitrus Berry (not reached)";
  }

  abilityReason(side, name) {
    const normalized = norm(name);
    const mon = this.mon(side);
    const setWeather = WEATHER_SETTERS[normalized];
    if (setWeather) return `Sets ${setWeather}; when both sides set weather, the slower Pokémon's weather remains.`;
    const required = WEATHER_REQUIREMENTS[normalized];
    if (required) return this.effectiveWeather() !== required ? `Requires ${required}.` : `Active because ${required} is set.`;
    if (PINCH_ABILITIES[normalized]) return mon.current_hp_percent > 33 ? "Requires 33% HP or less." : `Triggered at ${mon.current_hp_percent}% HP.`;
    const status = mon.status;
    if (["guts", "quick feet", "marvel scale"].includes(normalized)) return status ? `Triggered by ${status}.` : "Requires a status condition.";
    if (normalized === "flare boost") return status === "Burned" ? "Triggered by Burn." : "Requires Burn.";
    if (normalized === "toxic boost") return ["Poisoned", "Badly Poisoned"].includes(status) ? "Triggered by poison." : "Requires poison.";
    if (normalized === "unburden") {
      if (this.whiteHerbConsumed(side)) return "White Herb is consumed after restoring an opposing stat drop, doubling Speed through Unburden.";
      return this.state.effectOverrides[this.effectKey(side, "ability", name)] ? "Unburden is manually active because the held item has been consumed." : "Requires the held item to be consumed; click to simulate an earlier item trigger.";
    }
    if (["defiant", "competitive", "guard dog"].includes(normalized)) return this.abilityAutoTrigger(side, name) ? "Triggered by a stat drop caused by the opponent." : "Off until the opponent lowers a stat; click to simulate the trigger manually.";
    if (TRIGGERED_ABILITIES.has(normalized)) return this.abilityAutoTrigger(side, name) ? "Its battle trigger is currently satisfied." : "Off until its battle trigger occurs; click to simulate it manually.";
    return "";
  }

  itemReason(side, name) {
    const normalized = norm(name);
    const mon = this.mon(side);
    if (normalized === "focus sash") return mon.current_hp_percent >= 100 ? "Active at full HP." : "Requires full HP.";
    if (normalized === "white herb") return this.opponentStatDrop(side, false) ? "Triggered by an opposing stat drop." : "Off until an opponent lowers a stat.";
    if (normalized === "sitrus berry") return "Triggers when HP reaches 50% or less.";
    return "";
  }

  abilityRelevant(side, ability, selectedSide, selectedMove) {
    const key = norm(ability);
    if (!key) return false;
    if (ALWAYS_VISIBLE.has(key) || WEATHER_SETTERS[key] || TERRAIN_SETTERS[key]) return true;
    const own = this.moveMetas(side, selectedSide, selectedMove).filter(isDamaging);
    const incoming = this.moveMetas(other(side), selectedSide, selectedMove).filter(isDamaging);
    const all = [...own, ...incoming];
    if (TYPE_IMMUNITY_ABILITIES[key]) return incoming.some((meta) => meta.type === TYPE_IMMUNITY_ABILITIES[key]);
    if (ATE_ABILITIES[key] || key === "normalize" || key === "liquid voice") return own.some((meta) => meta.type === "Normal" || (key === "liquid voice" && meta.flags.has("sound")));
    if (key === "intimidate") return incoming.some((meta) => meta.category === "physical");
    const flagNeeds = { "tough claws": "contact", "iron fist": "punch", "strong jaw": "bite", "sharpness": "slicing", "reckless": "recoil", "punk rock": "sound" };
    if (flagNeeds[key]) return [...own, ...(key === "punk rock" ? incoming : [])].some((meta) => meta.flags.has(flagNeeds[key]));
    const typeNeeds = { "steelworker": "Steel", "rocky payload": "Rock", "transistor": "Electric", "dragon's maw": "Dragon", "water bubble": "Water" };
    if (typeNeeds[key]) return [...own, ...(key === "water bubble" ? incoming : [])].some((meta) => meta.type === typeNeeds[key]);
    const offensive = new Set(["huge power", "pure power", "hustle", "guts", "solar power", "flare boost", "toxic boost", "technician", "mega launcher", "sheer force", "sand force", "rivalry", "analytic", "stakeout", "supreme overlord", "adaptability", "protean", "libero", "neuroforce", "sniper", "tinted lens", "sword of ruin", "beads of ruin", "orichalcum pulse", "hadron engine", "parental bond"]);
    const defensive = new Set(["fur coat", "marvel scale", "ice scales", "multiscale", "shadow shield", "fluffy", "filter", "solid rock", "prism armor", "purifying salt", "heatproof", "dry skin", "wonder guard", "unaware", "tablets of ruin", "vessel of ruin", "sturdy", "armor tail", "dazzling", "queenly majesty", "thick fat"]);
    if (offensive.has(key) && own.length) return true;
    if (defensive.has(key) && incoming.length) return true;
    void all;
    return false;
  }

  itemRelevant(side, item, selectedSide, selectedMove) {
    const key = norm(item);
    if (!key || this.engine.isMegaStone(item)) return false;
    if (["focus sash", "sitrus berry", "white herb"].includes(key)) return true;
    const own = this.moveMetas(side, selectedSide, selectedMove).filter(isDamaging);
    const incoming = this.moveMetas(other(side), selectedSide, selectedMove).filter(isDamaging);
    if (TYPE_BOOST[key]) return own.some((meta) => meta.type === TYPE_BOOST[key]);
    if (key.endsWith(" plate")) return own.length > 0;
    if (key === "normal gem") return own.some((meta) => meta.type === "Normal");
    if (key === "choice band" || key === "muscle band") return own.some((meta) => meta.category === "physical");
    if (key === "choice specs" || key === "wise glasses") return own.some((meta) => meta.category === "special");
    if (["life orb", "expert belt", "metronome"].includes(key)) return own.length > 0;
    if (key === "punching glove") return own.some((meta) => meta.flags.has("punch"));
    if (key === "loaded dice") return own.some((meta) => meta.hits || meta.hit_range);
    if (key === "choice scarf" || key === "iron ball") return !selectedMove && own.length > 0;
    if (key === "assault vest") return incoming.some((meta) => meta.category === "special");
    if (key === "eviolite") return incoming.length > 0;
    if (RESIST_BERRIES[key]) return incoming.some((meta) => meta.type === RESIST_BERRIES[key]);
    return false;
  }

  fieldRelevant(side, key, selectedSide, selectedMove) {
    const own = this.moveMetas(side, selectedSide, selectedMove).filter(isDamaging);
    const incoming = this.moveMetas(other(side), selectedSide, selectedMove).filter(isDamaging);
    if (key === "helping_hand") return this.state.format === "Doubles" && own.length > 0;
    if (key === "reflect") return incoming.some((meta) => meta.category === "physical");
    if (key === "light_screen") return incoming.some((meta) => meta.category === "special");
    if (key === "friend_guard") return this.state.format === "Doubles" && incoming.length > 0;
    if (["aurora_veil", "protect", "stealth_rock", "salt_cure"].includes(key)) return incoming.length > 0;
    if (key === "tailwind") return !selectedMove && own.length > 0;
    return own.length > 0 || incoming.length > 0;
  }
}

function isDamaging(meta) {
  return meta.category !== "status" && (Number(meta.power) > 0 || Boolean(meta.fixed_damage));
}

function countOptions(low, high, label) {
  const options = [];
  for (let value = low; value <= high; value += 1) options.push([label(value), value]);
  return options;
}

export { compactKey };
