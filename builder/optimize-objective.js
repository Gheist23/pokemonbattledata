// How the deep Optimize scores one version of a team member (a Nature, Stat Points
// and moves) against the Top-X meta.
//
// Every Top-X threat is played on up to three of its common sets, each weighted by
// how common the threat is (matchupWeight) and shared between its sets. For each set:
//
//   A = the chance our best attack has knocked it out after our 1st..4th attack
//   B = the chance its best attack has knocked us out after its 1st..4th attack
//
// Who attacks first comes from move priority, then Speed, in every speed context the
// team plays in (normal, the team's Tailwind, the opponent's Tailwind, the team's
// Trick Room, the team's weather or terrain). The race value R is the chance we land
// the KO first (a tie counts half). The matchup value blends that race with how
// well we take hits and how hard we hit, so one Stat Point can never swing a
// matchup from lost to won on its own:
//
//   M = wR * R + wS * (0.7 (1 - B1) + 0.3 (1 - B2)) + wK * (0.7 A1 + 0.3 A2) + wV * V
//
// V is the chance of simply being faster (priority aside): in Doubles moving first
// also protects the partner and lands spread moves and flinches first, which a
// one-on-one race does not see. Support Pokemon lean on surviving (see TUNING). In
// Doubles a move that hits both opponents adds a little on top. The score is 100 *
// the weighted average of M: a matchup score from 0 to 100.
//
// Differences from the Threats list, on purpose: Focus Sash and Sturdy stop a
// one-hit KO from full HP, and moves that lower the user's attack (Draco Meteor,
// Make It Rain...) hit their second time at the lowered stat. The labels shown in
// the breakdown use the Threats list's own KO maths so the two read the same.

import { DAMAGE_RECOIL_FRACTIONS, MAX_HP_RECOIL_FRACTIONS, SELF_DROP_STAGES, compact, pyFixed, pyRound } from "./engine.js";
import { speedModePlan } from "./team-suggest.js";
import { SpeedTiers } from "./speed-tiers.js";
import { fullMonKey, matchupWeight } from "./team-optimize.js";
import {
  DamageMemo, PROFILE_HITS, actionProfile, koProfile, minimalResult, raceValue, rollsForHit, turnsToKo,
} from "./optimize-core.js";
import { DRAIN_FRACTIONS, FIELD_PLAN_MOVES, NEUTRAL_STATUS, REDIRECTION_MOVES, isFirstTurnOnly, isMultiHit, isSpreadMove } from "./move-traits.js";

const THREAT_VARIANTS = 3;
export const WORKING_SET_RANKS = 50;
const RADIX = 1024;

/**
 * The knobs of the score (tuned with a calibration run over common sets, see
 * tests/run-optimize-deep.mjs):
 *  weights         wR, wS, wK, wV of the matchup value for attackers and support Pokemon
 *  chip            what each side loses per turn to the rest of the field in Doubles
 *                  (the other opponent, spread moves), as [share of max HP, chance]
 *                  outcomes: a hit that only just fails to KO often does not survive
 *                  a real Doubles turn
 *  speedSpread     how far (as a share of its Speed) a threat's Speed may differ from its
 *                  most common spread: moving first becomes a chance, not a cliff
 *  spreadCredit    extra value of a move that hits both opponents in Doubles
 *  opposingTailwind weight of the context where the opponent has Tailwind
 */
export const TUNING = {
  weights: { attacker: [0.5, 0.2, 0.2, 0.1], support: [0.33, 0.44, 0.17, 0.06] },
  chip: [[0, 0.5], [0.2, 0.3], [0.45, 0.2]],
  speedSpread: 0.03,
  spreadCredit: 0.1,
  opposingTailwind: 0.15,
};
const RECOIL_IMMUNE = new Set(["rockhead", "magicguard"]);
const SPEED_WEATHER = { chlorophyll: "Sun", swiftswim: "Rain", sandrush: "Sand", slushrush: "Snow" };
const WEATHER_OF = { drizzle: "Rain", drought: "Sun", sandstream: "Sand", snowwarning: "Snow", frostwarning: "Snow", desolateland: "Sun", primordialsea: "Rain", orichalcumpulse: "Sun" };
const TERRAIN_OF = { electricsurge: "Electric", grassysurge: "Grassy", psychicsurge: "Psychic", mistysurge: "Misty", hadronengine: "Electric" };
const WEATHER_MOVES = { sunnyday: "Sun", raindance: "Rain", sandstorm: "Sand", snowscape: "Snow", chillyreception: "Snow" };
const TERRAIN_MOVES = { electricterrain: "Electric", grassyterrain: "Grassy", psychicterrain: "Psychic", mistyterrain: "Misty" };
const MOLD_BREAKERS = new Set(["moldbreaker", "teravolt", "turboblaze"]);
const CHARGE_MOVES = { solarbeam: "Sun", solarblade: "Sun", electroshot: "Rain", meteorbeam: "", skyattack: "", skullbash: "", razorwind: "" };
const ZERO_PROFILE = new Float64Array(PROFILE_HITS + 1);
const NO_ATTACK = Object.freeze({ prof: ZERO_PROFILE, prio: 0, move: "", spreadK: 0, entry: null });

const kOf = (p) => 0.7 * p[1] + 0.3 * p[2];

/**
 * The chance we act before a threat on Speed alone: a near-certainty well above (or,
 * under Trick Room, below) its usual Speed, a coin flip around it.
 */
export function fasterChance(ours, theirs, trickRoom = false) {
  if (!(TUNING.speedSpread > 0)) return ours === theirs ? 0.5 : (ours > theirs) !== trickRoom ? 1 : 0;
  const scale = Math.max(1, TUNING.speedSpread * theirs);
  const gap = (trickRoom ? theirs - ours : ours - theirs) / scale;
  return 1 / (1 + Math.exp(-gap * 1.7));
}

/** Best attack by: fewest actions to a 50% KO, then priority, then that chance, then the one-hit chance. */
function better(a, b) {
  const ta = turnsToKo(a.prof);
  const tb = turnsToKo(b.prof);
  if (ta !== tb) return ta < tb;
  if (a.prio !== b.prio) return a.prio > b.prio;
  const ca = a.prof[Math.min(ta, PROFILE_HITS)];
  const cb = b.prof[Math.min(tb, PROFILE_HITS)];
  if (ca !== cb) return ca > cb;
  return a.prof[1] > b.prof[1];
}

/** A Focus Sash or Sturdy holder cannot be knocked out from full HP by a single hit. */
function sashLike(defender, attacker, record) {
  if (isMultiHit(record)) return false;
  if (compact(defender.item) === "focussash") return true;
  return compact(defender.ability) === "sturdy" && !MOLD_BREAKERS.has(compact(attacker.ability));
}

function withSash(prof) {
  if (!prof[1]) return prof;
  const out = Float64Array.from(prof);
  out[1] = 0;
  return out;
}

/** Percent of `hp` a result's rolls deal, as the engine prints it ("54.4-64.3%"). */
export function percentText(result, hp) {
  const rolls = rollsForHit(result, 1);
  if (!rolls.length || hp <= 0) return "0-0%";
  const text = (value) => pyFixed(pyRound((value * 1000) / hp) / 10, 1).replace(/\.0$/, "");
  return `${text(Math.min(...rolls))}-${text(Math.max(...rolls))}%`;
}

export class OptimizeObjective {
  /**
   * @param {import("./team-optimize.js").TeamOptimizer} opt  its helpers (threat moves, team mons)
   * @param {Array<object|null>} sets   the team (builder sets)
   * @param {number} slot               the member being tuned
   * @param {{memo?: DamageMemo, topX?: number}} options
   */
  constructor(opt, sets, slot, { memo = null, topX = 30 } = {}) {
    this.opt = opt;
    this.ev = opt.ev;
    this.sg = opt.sg;
    this.engine = this.ev.engine;
    this.settings = this.ev.settings;
    this.sets = sets;
    this.slot = slot;
    this.set = sets[slot];
    this.memo = memo || new DamageMemo();
    this.doubles = this.ev.format === "Doubles";
    this.template = opt.monFor(this.set, slot, { nature_name: this.set.nature || "Serious", bonuses: [...(this.set.bonuses || [0, 0, 0, 0, 0, 0])] }, this.set.moves);
    this.ownAbility = compact(this.ev.fieldAbility(this.template));
    this.speedWeatherAbility = SPEED_WEATHER[compact(this.template.ability)] || "";
    this.moveSets = [];
    this.moveSetIds = new Map();
    this.profiles = new WeakMap();
    this.buildTeam();
    this.buildBoard(topX);
    this.buildContexts();
  }

  // --- the team -------------------------------------------------------------------------

  buildTeam() {
    const members = this.sets.map((set, i) => (set?.species ? { set, index: i } : null)).filter(Boolean);
    const moveKeys = new Set();
    for (const { set } of members) for (const m of set.moves || []) moveKeys.add(compact(m));
    this.teamMoves = moveKeys;
    this.hasTailwind = moveKeys.has("tailwind");
    this.hasTrickRoom = moveKeys.has("trickroom");
    // The team's weather and terrain from the other members (ours already plays in the normal context).
    let weather = "";
    let terrain = "";
    for (const { set, index } of members) {
      if (index === this.slot) continue;
      let ability = compact(set.ability);
      try {
        ability = compact(this.ev.fieldAbility(this.ev.teamMon(set, index)));
      } catch {
        // keep the listed ability
      }
      weather ||= WEATHER_OF[ability] || "";
      terrain ||= ability === "hadronengine" ? "" : TERRAIN_OF[ability] || "";
      for (const m of set.moves || []) {
        weather ||= WEATHER_MOVES[compact(m)] || "";
        terrain ||= TERRAIN_MOVES[compact(m)] || "";
      }
    }
    if (WEATHER_OF[this.ownAbility]) weather = "";
    if (TERRAIN_OF[this.ownAbility]) terrain = "";
    if (this.settings.weather !== "None" || !this.settings.use_weather_abilities) weather = "";
    if (this.settings.terrain !== "None") terrain = "";
    this.teamField = weather || terrain ? { weather, terrain } : null;
    this.teamFieldId = this.teamField ? `team:${weather}:${terrain}` : "";
    const ownWeather = WEATHER_OF[this.ownAbility] || "";
    this.sunTeam = weather === "Sun" || ownWeather === "Sun" || this.settings.weather === "Sun";
    this.rainTeam = weather === "Rain" || ownWeather === "Rain" || this.settings.weather === "Rain";
    this.fieldKeys = new Set([weather, ownWeather, terrain, TERRAIN_OF[this.ownAbility] || "", this.settings.weather, this.settings.terrain].map((v) => compact(v)).filter((v) => v && v !== "none"));
    // How the team controls Speed (the Suggestions' speed mode).
    this.speedMode = "none";
    try {
      const synergy = this.opt.evaluation.synergy;
      const profiles = members.map(({ set, index }) => {
        const mon = this.ev.teamMon(set, index);
        return synergy.profile({ pokemon: set.species, form: set.form, item: set.item, ability: set.ability, moves: set.moves }, mon);
      });
      this.speedMode = speedModePlan(profiles, synergy.metaSpeedRows()).mode;
    } catch {
      this.speedMode = this.hasTrickRoom && !this.hasTailwind ? "trickroom" : this.hasTailwind ? "tailwind" : "none";
    }
    // The member's role: support when it runs two or more status moves (Protect and the
    // like aside), redirection, or Fake Out with a status move (Incineroar's Parting Shot).
    const moves = (this.set.moves || []).filter(Boolean);
    const statusMoves = moves.filter((m) => !this.opt.damaging(m) && !NEUTRAL_STATUS.has(compact(m)));
    const fakeOut = moves.some((m) => compact(m) === "fakeout");
    this.support = statusMoves.length >= 2 || moves.some((m) => REDIRECTION_MOVES.has(compact(m))) || (fakeOut && statusMoves.length >= 1);
    [this.wR, this.wS, this.wK, this.wV = 0] = this.support ? TUNING.weights.support : TUNING.weights.attacker;
    this.chip = this.doubles ? TUNING.chip : [[0, 1]];
    this.recoilImmune = RECOIL_IMMUNE.has(compact(this.template.ability));
    this.lifeOrb = compact(this.template.item) === "lifeorb" && !this.recoilImmune;
  }

  /** Moves a team's field is built around, for the moves this member may not lose. */
  fieldPlanMoves() {
    const out = new Set();
    for (const key of this.fieldKeys) for (const move of FIELD_PLAN_MOVES[key] || []) out.add(move);
    return out;
  }

  // --- the board ------------------------------------------------------------------------

  buildBoard(topX) {
    const limit = Math.max(1, Math.min(Number(topX) || 30, (this.ev.metaRecords || []).length || 1));
    const meta = this.ev.topMeta(limit);
    this.topX = meta.length;
    this.rows = [];
    meta.forEach((metaRow, index) => {
      const rank = index + 1;
      let variants = [];
      try {
        variants = this.sg.threatVariantsForSuggestion(metaRow).slice(0, THREAT_VARIANTS);
      } catch {
        variants = [];
      }
      variants.forEach((threat, variantIndex) => {
        const moves = this.opt.threatCalcMoves(threat).filter((m) => !isFirstTurnOnly(m));
        this.rows.push({
          index: this.rows.length, rank, variant: variantIndex, threat, sig: fullMonKey(threat),
          weight: matchupWeight(rank) / variants.length,
          name: this.sg.name(threat.form_name || threat.pokemon_name),
          species: threat.pokemon_name, form: threat.form_name, item: threat.item || "", ability: threat.ability || "",
          moves: moves.map((move) => ({ move, record: this.engine.moveRecord(move) || {}, prio: this.ev.movePriority(move) })),
          fieldAbility: compact(this.ev.fieldAbility(threat)),
          readsAttack: moves.some((m) => String(this.engine.moveRecord(m)?.special || "") === "foul_play"),
          readsSpeed: moves.some((m) => ["electro_ball", "gyro_ball"].includes(String(this.engine.moveRecord(m)?.special || ""))),
          best: new Map(),
        });
      });
    });
    const working = this.rows.filter((row) => row.rank <= WORKING_SET_RANKS);
    this.workingRows = working.length < this.rows.length ? working : this.rows;
    for (const row of this.rows) {
      // A weather (terrain) both sides set is decided by who is slower: then our Speed is read.
      const ourW = WEATHER_OF[this.ownAbility];
      const theirW = WEATHER_OF[row.fieldAbility];
      const ourT = TERRAIN_OF[this.ownAbility];
      const theirT = TERRAIN_OF[row.fieldAbility];
      row.contested = Boolean((ourW && theirW && this.settings.weather === "None" && this.settings.use_weather_abilities) || (ourT && theirT && this.settings.terrain === "None"));
      let weather = this.settings.weather;
      try {
        if (weather === "None" && this.settings.use_weather_abilities) weather = this.ev.autoField(this.template, row.threat)[0] || "None";
      } catch {
        weather = "None";
      }
      row.normalWeather = weather;
    }
  }

  // --- speed contexts --------------------------------------------------------------------

  buildContexts() {
    const s = this.settings;
    const ourTW = s.tailwind === "My Team" || s.tailwind === "Both";
    const theirTW = s.tailwind === "Threat Team" || s.tailwind === "Both";
    const roomTeam = this.speedMode === "trickroom";
    const contexts = [{ id: "normal", label: "Normal", weight: roomTeam ? 0.4 : 1, ourTW, theirTW, trickRoom: Boolean(s.trick_room), field: null }];
    if (this.hasTailwind && !ourTW) contexts.push({ id: "tailwind", label: "Your Tailwind", weight: this.speedMode === "tailwind" ? 0.8 : 0.5, ourTW: true, theirTW, trickRoom: Boolean(s.trick_room), field: null });
    if (!theirTW && TUNING.opposingTailwind > 0) contexts.push({ id: "their-tailwind", label: "Opposing Tailwind", weight: TUNING.opposingTailwind, ourTW, theirTW: true, trickRoom: Boolean(s.trick_room), field: null });
    if (this.hasTrickRoom && !s.trick_room) contexts.push({ id: "trick-room", label: "Trick Room", weight: roomTeam ? 1 : 0.3, ourTW, theirTW, trickRoom: true, field: null });
    if (this.teamField) {
      const label = [this.teamField.weather, this.teamField.terrain ? `${this.teamField.terrain} Terrain` : ""].filter(Boolean).join(" + ");
      contexts.push({ id: "team-field", label: `Your ${label}`, weight: 0.6, ourTW, theirTW, trickRoom: Boolean(s.trick_room), field: this.teamField });
    }
    this.contexts = contexts;
    this.contextWeight = contexts.reduce((sum, c) => sum + c.weight, 0);
    this.fields = [...new Set(contexts.map((c) => (c.field ? this.teamFieldId : "normal")))];
    for (const row of this.rows) {
      row.speeds = contexts.map((c) => {
        const weather = c.field?.weather || row.normalWeather;
        try {
          return Math.trunc(this.engine.effectiveSpeed(row.threat, { weather, tailwind: c.theirTW })) || 1;
        } catch {
          return 1;
        }
      });
    }
  }

  /** The Top-X Speed list (normal play), as the Speed tab shows it. */
  speedList() {
    if (!this.speedListCache) {
      try {
        this.speedListCache = new SpeedTiers(this.ev).metaVariants(this.topX).map(([mon, info]) => {
          try {
            return Math.max(1, Math.trunc(this.engine.effectiveSpeed(mon, { weather: "None", unburden: info.variant_label === "Unburden" })));
          } catch {
            return 1;
          }
        });
      } catch {
        this.speedListCache = this.workingRows.map((row) => row.speeds[0]);
      }
    }
    return this.speedListCache;
  }

  /**
   * The share of the Top-X Speed list we outsped at `before` and no longer outspeed at
   * `after` (normal play; 0 when the team plays Trick Room, where slower is the point).
   */
  speedLossShare(before, after) {
    if (after >= before || this.speedMode === "trickroom") return 0;
    const list = this.speedList();
    if (!list.length) return 0;
    let lost = 0;
    for (const theirs of list) if (before > theirs && after <= theirs) lost += 1;
    return lost / list.length;
  }

  // --- move sets ------------------------------------------------------------------------

  /** A registered move set (its id keys the per-row caches). */
  moveSet(moves) {
    const list = (moves || []).filter(Boolean).slice(0, 4);
    const key = list.map(compact).sort().join("|");
    let id = this.moveSetIds.get(key);
    if (id === undefined) {
      id = this.moveSets.length;
      const attacks = this.opt.calcMoves(list, 4).filter((m) => !isFirstTurnOnly(m)).map((move) => {
        const record = this.engine.moveRecord(move) || {};
        return { move, record, prio: this.ev.movePriority(move), spread: this.doubles && isSpreadMove(record) };
      });
      const reads = { atk: false, spa: false, def: false, hp: false, spe: false };
      for (const { record } of attacks) {
        const special = String(record.special || "");
        const category = String(record.category || "").toLowerCase();
        if (record.choose_best_category || record.choose_higher_offense || special === "tera_blast") reads.atk = reads.spa = true;
        else if (record.attack_stat === "defense") reads.def = true;
        else if (category === "special") reads.spa = true;
        else reads.atk = true;
        if (special === "eruption" || special === "flail" || record.fixed_damage === "attacker_current_hp") reads.hp = true;
        if (special === "electro_ball" || special === "gyro_ball") reads.spe = true;
      }
      this.moveSets.push({ id, moves: list, attacks, reads });
      this.moveSetIds.set(key, id);
    }
    return this.moveSets[id];
  }

  // --- the member -------------------------------------------------------------------------

  mon(nature, points) {
    return { ...this.template, nature_name: nature, bonuses: [...points] };
  }

  /** Our Speed in a context (weather only matters to a Chlorophyll-style Ability). */
  ourSpeed(mon, context, row) {
    const weather = this.speedWeatherAbility ? (context.field?.weather || row.normalWeather) : "None";
    return Math.trunc(this.engine.effectiveSpeed(mon, { weather, tailwind: context.ourTW })) || 1;
  }

  // --- damage ---------------------------------------------------------------------------

  applyField(ctx, fieldId) {
    if (fieldId === "normal" || !this.teamField) return ctx;
    const { weather, terrain } = this.teamField;
    if (weather) {
      ctx.weather = weather;
      ctx.attacker_state = { ...(ctx.attacker_state || {}), weather };
      ctx.defender_state = { ...(ctx.defender_state || {}), weather };
    }
    if (terrain) ctx.terrain = terrain;
    return ctx;
  }

  calc(attacker, defender, move, fieldId) {
    const ctx = this.applyField(this.ev.calcContext(attacker, defender, move), fieldId);
    const result = this.ev.calculate(attacker, defender, ctx);
    return minimalResult(result, { weather: ctx.weather });
  }

  /** Stage-lowered copy for the second hit of a move that lowers its own attack stat. */
  dropped(mon, move, record) {
    const drop = SELF_DROP_STAGES[String(record.name || move).toLowerCase()];
    if (!drop) return null;
    const [stat, amount] = drop;
    const category = String(record.category || "").toLowerCase();
    if (!((stat === "attack" && category === "physical") || (stat === "sp_attack" && category === "special"))) return null;
    const attr = `${stat}_stage`;
    return { ...mon, [attr]: Math.max(-6, (Number(mon[attr]) || 0) - amount) };
  }

  cooldownOf(move, raw) {
    const charge = CHARGE_MOVES[compact(move)];
    if (charge !== undefined) {
      if (charge && String(raw.weather || "") === charge) return {};
      return { charge: true };
    }
    return { recharge: this.ev.hasCooldown(move, raw) };
  }

  /** Our attack `move` against a row: profile, priority, spread credit. */
  outgoing(row, attack, fs, mon, fieldId) {
    const { move, record } = attack;
    const reads = [];
    const special = String(record.special || "");
    const category = String(record.category || "").toLowerCase();
    if (record.choose_best_category || record.choose_higher_offense || special === "tera_blast") reads.push(fs.attack, fs.sp_attack);
    else if (record.attack_stat === "defense") reads.push(fs.defense);
    else reads.push(category === "special" ? fs.sp_attack : fs.attack);
    if (special === "eruption" || special === "flail" || record.fixed_damage === "attacker_current_hp") reads.push(fs.hp);
    if (special === "electro_ball" || special === "gyro_ball" || row.contested) reads.push(fs.speed);
    let key = 0;
    for (const v of reads) key = key * RADIX + v;
    const cell = this.memo.cell(`o|${fieldId}|${row.sig}|${move}`);
    return this.memo.get(cell, key, () => {
      let raw;
      let prof;
      try {
        raw = this.calc(mon, row.threat, move, fieldId);
        const lowered = this.dropped(mon, move, record);
        const extra = lowered ? [rollsForHit(this.calc(lowered, row.threat, move, fieldId), 1)] : null;
        const hp = Math.trunc(raw.current_hp || raw.max_hp || 0);
        const later = compact(row.threat.item) === "lifeorb" ? Math.floor(hp / 10) : 0;
        const hits = koProfile(extra ? [rollsForHit(raw, 0), ...extra] : [rollsForHit(raw, 0), rollsForHit(raw, 1)], hp, raw.move_accuracy_factor ?? 1, this.chipOutcomes(hp), later);
        prof = actionProfile(hits, { ...this.cooldownOf(move, raw), selfKo: this.ev.selfDestructs(move) });
        if (sashLike(row.threat, mon, record)) prof = withSash(prof);
      } catch {
        raw = minimalResult({});
        prof = ZERO_PROFILE;
      }
      return { prof, prio: attack.prio, move, raw, spread: attack.spread, ...this.recoilOf(record, raw) };
    });
  }

  /**
   * What an attack costs (or gives back to) its user each time: a share of the damage
   * dealt as recoil, of its own max HP, or HP drained back (negative).
   */
  recoilOf(record, raw) {
    const name = String(record.name || "");
    let fraction = "recoil_fraction" in record ? record.recoil_fraction : DAMAGE_RECOIL_FRACTIONS[name];
    if ((fraction === undefined || fraction === null) && (record.flags || []).includes("recoil")) fraction = 1 / 3;
    if (this.recoilImmune) fraction = 0;
    const drain = DRAIN_FRACTIONS[compact(name)] || 0;
    const maxHp = this.recoilImmune ? 0 : "recoil_max_hp_fraction" in record ? record.recoil_max_hp_fraction : MAX_HP_RECOIL_FRACTIONS[name];
    let dealt = 0;
    if (fraction || drain) {
      const rolls = rollsForHit(raw, 1);
      const hp = Math.trunc(raw.current_hp || raw.max_hp || 0);
      const mean = rolls.length ? rolls.reduce((a, b) => a + Math.min(b, hp), 0) / rolls.length : 0;
      const acc = Number(raw.move_accuracy_factor ?? 1);
      dealt = (Number(fraction || 0) - drain) * mean * (Number.isFinite(acc) ? acc : 1);
    }
    return { recoilDealt: dealt, recoilMaxHp: Number(maxHp) || 0 };
  }

  /** Chip outcomes against `hp` HP. */
  chipOutcomes(hp) {
    return this.chip.map(([share, chance]) => [Math.round(share * hp), chance]);
  }

  /** The fixed damage we take after each of our attacks: Life Orb and recoil. */
  selfDamage(hp, out) {
    let offset = 0;
    if (this.lifeOrb && out.move) offset += Math.floor(hp / 10);
    if (out.recoilDealt) offset += Math.round(out.recoilDealt);
    if (out.recoilMaxHp) offset += Math.ceil(hp * out.recoilMaxHp);
    return offset;
  }

  /** The threat's attack against us: the raw calc (HP is applied afterwards). */
  incomingRaw(row, attack, fs, mon, fieldId) {
    const { move, record } = attack;
    const special = String(record.special || "");
    const category = String(record.category || "").toLowerCase();
    const reads = [];
    if (record.choose_best_category || record.choose_higher_offense || special === "tera_blast" || compact(row.threat.ability) === "download") reads.push(fs.defense, fs.sp_defense);
    else reads.push(category === "physical" || record.defense_stat === "defense" ? fs.defense : fs.sp_defense);
    if (special === "foul_play") reads.push(fs.attack);
    if (special === "electro_ball" || special === "gyro_ball" || row.contested) reads.push(fs.speed);
    if (record.fixed_damage || record.fixed_damage_fraction || ["hard_press", "target_hp_power", "brine", "counter_damage"].includes(special)) reads.push(fs.hp);
    let key = 0;
    for (const v of reads) key = key * RADIX + v;
    const cell = this.memo.cell(`i|${fieldId}|${row.sig}|${move}`);
    return this.memo.get(cell, key, () => {
      try {
        const raw = this.calc(row.threat, mon, move, fieldId);
        const lowered = this.dropped(row.threat, move, record);
        raw.later = lowered ? rollsForHit(this.calc(lowered, mon, move, fieldId), 1) : null;
        raw.cooldown = this.cooldownOf(move, raw);
        raw.selfKo = this.ev.selfDestructs(move);
        return raw;
      } catch {
        const raw = minimalResult({});
        raw.cooldown = {};
        return raw;
      }
    });
  }

  incomingProfile(row, attack, raw, hp, mon, offset = 0) {
    // Profiles live for this run only (the memo that outlives it keeps just the calcs).
    let profiles = this.profiles.get(raw);
    if (!profiles) {
      profiles = new Map();
      this.profiles.set(raw, profiles);
    }
    const key = hp * 4096 + offset;
    let prof = profiles.get(key);
    if (!prof) {
      const first = rollsForHit(raw, 0);
      const hits = koProfile(raw.later ? [first, raw.later] : [first, rollsForHit(raw, 1)], hp, raw.move_accuracy_factor ?? 1, this.chipOutcomes(hp), offset);
      prof = actionProfile(hits, { ...raw.cooldown, selfKo: raw.selfKo });
      if (sashLike(mon, row.threat, attack.record)) prof = withSash(prof);
      profiles.set(key, prof);
    }
    return prof;
  }

  /** The row's best attack on us, cached by the stats of ours it reads and what we lose per turn. */
  bestIncoming(row, fs, mon, fieldId, cache, offset = 0) {
    let byOffset = cache.get(offset);
    if (!byOffset) {
      byOffset = new Map();
      cache.set(offset, byOffset);
    }
    const key = (((fs.hp * RADIX + fs.defense) * RADIX + fs.sp_defense) * RADIX + (row.contested || row.readsSpeed ? fs.speed : 0)) * RADIX + (row.readsAttack ? fs.attack : 0);
    let best = byOffset.get(key);
    if (best) return best;
    best = NO_ATTACK;
    for (const attack of row.moves) {
      const raw = this.incomingRaw(row, attack, fs, mon, fieldId);
      const prof = this.incomingProfile(row, attack, raw, fs.hp, mon, offset);
      const candidate = { prof, prio: attack.prio, move: attack.move, raw };
      if (better(candidate, best)) best = candidate;
    }
    byOffset.set(key, best);
    return best;
  }

  /** Our best attack on the row for a move set, and the spread-move credit. */
  bestOutgoing(row, moveSet, fs, mon, fieldId, outCache) {
    let cache = outCache.get(moveSet.id);
    if (!cache) {
      cache = new Map();
      outCache.set(moveSet.id, cache);
    }
    const r = moveSet.reads;
    let key = r.atk ? fs.attack : 0;
    key = key * RADIX + (r.spa ? fs.sp_attack : 0);
    key = key * RADIX + (r.def ? fs.defense : 0);
    key = key * RADIX + (r.hp ? fs.hp : 0);
    key = key * RADIX + (r.spe || row.contested ? fs.speed : 0);
    let best = cache.get(key);
    if (best) return best;
    best = NO_ATTACK;
    const spreadKs = [];
    for (const attack of moveSet.attacks) {
      const entry = this.outgoing(row, attack, fs, mon, fieldId);
      if (better(entry, best)) best = entry;
      if (attack.spread) spreadKs.push(kOf(entry.prof));
    }
    spreadKs.sort((a, b) => b - a);
    const spreadK = (spreadKs[0] || 0) + 0.5 * (spreadKs[1] || 0);
    best = { ...best, spreadK };
    cache.set(key, best);
    return best;
  }

  rowCache(row, fieldId) {
    let cache = row.best.get(fieldId);
    if (!cache) {
      cache = { in: new Map(), out: new Map() };
      row.best.set(fieldId, cache);
    }
    return cache;
  }

  // --- the score --------------------------------------------------------------------------

  /**
   * The matchup score (0-100) of a Nature, Stat Points and move set.
   * @param {boolean|null} detail  also return every row's matchup
   * @param {object[]} rows        the board to score (the working set by default)
   */
  score(nature, points, moveSet, { detail = false, rows = this.workingRows } = {}) {
    const mon = this.mon(nature, points);
    const fs = this.engine.finalStats(mon);
    const plain = {};
    for (const context of this.contexts) plain[context.id] = this.speedWeatherAbility ? null : this.ourSpeed(mon, context, rows[0] || {});
    let total = 0;
    let weights = 0;
    const per = detail ? [] : null;
    for (const row of rows) {
      const fieldBest = {};
      for (const fieldId of this.fields) {
        const cache = this.rowCache(row, fieldId);
        const outCache = cache.out;
        const out = this.bestOutgoing(row, moveSet, fs, mon, fieldId, outCache);
        fieldBest[fieldId] = [out, this.bestIncoming(row, fs, mon, fieldId, cache.in, this.selfDamage(fs.hp, out))];
      }
      let value = 0;
      const contexts = detail ? [] : null;
      for (let c = 0; c < this.contexts.length; c += 1) {
        const context = this.contexts[c];
        const [out, inc] = fieldBest[context.field ? this.teamFieldId : "normal"];
        const A = out.prof;
        const B = inc.prof;
        const ours = plain[context.id] ?? this.ourSpeed(mon, context, row);
        const theirs = row.speeds[c];
        // The chance we move first: priority decides outright; Speed is a near-certainty
        // well above or below the threat's usual Speed and a coin flip around it.
        const faster = this.settings.use_speed_tiers ? fasterChance(ours, theirs, context.trickRoom) : 0.5;
        const chance = !this.settings.use_speed_tiers || out.prio === inc.prio ? faster : out.prio > inc.prio ? 1 : 0;
        const first = chance > 0.5 ? 1 : chance < 0.5 ? -1 : 0;
        const race = chance * raceValue(A, B, true) + (1 - chance) * raceValue(A, B, false);
        const survive = 0.7 * (1 - B[1]) + 0.3 * (1 - B[2]);
        const hit = kOf(A);
        const m = this.wR * race + this.wS * survive + this.wK * hit + this.wV * faster + (this.doubles ? TUNING.spreadCredit * out.spreadK : 0);
        value += context.weight * m;
        if (contexts) contexts.push({ id: context.id, first, chance, faster, race, ours, theirs });
      }
      value /= this.contextWeight;
      total += row.weight * value;
      weights += row.weight;
      if (per) {
        const [out, inc] = fieldBest.normal;
        per.push({ row, value, out, inc, contexts, hp: fs.hp });
      }
    }
    const score = weights ? (100 * total) / weights : 0;
    return detail ? { score, per, fs, mon } : score;
  }

  /** Our best attack profile with one move, for ranking candidate moves (normal field). */
  moveValue(move, nature, points, rows = this.workingRows) {
    const mon = this.mon(nature, points);
    const fs = this.engine.finalStats(mon);
    const record = this.engine.moveRecord(move) || {};
    const attack = { move, record, prio: this.ev.movePriority(move), spread: this.doubles && isSpreadMove(record) };
    let sum = 0;
    let weights = 0;
    for (const row of rows) {
      const entry = this.outgoing(row, attack, fs, mon, "normal");
      sum += row.weight * (entry.prof[2] + (attack.spread ? TUNING.spreadCredit * kOf(entry.prof) : 0));
      weights += row.weight;
    }
    return weights ? sum / weights : 0;
  }

  /** The Threats list's own KO label for a raw result against `hp` HP. */
  koLabel(move, raw, hp) {
    if (!raw || !(raw.rolls || []).length) return { hits: 99, chance: 0, label: "No damage" };
    const plain = (list) => Array.from(list || []);
    const result = {
      rolls: plain(raw.rolls), rolls_with_resist_berry: plain(raw.rolls_with_resist_berry), rolls_without_resist_berry: plain(raw.rolls_without_resist_berry),
      move_accuracy_factor: raw.move_accuracy_factor, weather: raw.weather, current_hp: hp, max_hp: hp,
    };
    const ko = this.ev.applyCooldown(move, this.ev.koSummary(result), result);
    return { hits: Number.parseInt(ko.hits, 10) || 99, chance: Number(ko.chance) || 0, label: String(ko.label || "No damage") };
  }
}
