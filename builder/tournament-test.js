// Test against Tournament Teams: our team plays real tournament teams
// (data/builder/known-teams.json), one short game for every choice of Pokémon
// each side can bring.
//
// A game. Both sides bring BRING[format] Pokémon (four in Doubles, three in Singles)
// and lead with the ACTIVE[format] that do the most on turn 1 (kit().lead).
//   Entry    Intimidate and weather / terrain Abilities trigger in Speed order, so the
//            slower setter's weather or terrain stays.
//   Turn 1   each lead picks one action. First the plays that decide the turn: Fake Out
//            (on a target that can flinch, their Tailwind or Trick Room setter first),
//            Tailwind, Trick Room (when its side brought the slower Pokémon). Then Taunt on
//            their Trick Room / Tailwind setter, Follow Me / Rage Powder (when the partner
//            sets up, or there is nothing to put to sleep), sleep (Spore, Sleep Powder...),
//            a spread Speed drop (Icy Wind, Electroweb, Bulldoze) when the other leads are
//            faster, otherwise the most valuable of: its best attack (a knockout first,
//            else the most damage for the target's HP; First Impression counts here, at
//            +2), an Attack / Sp. Atk drop (Snarl, Parting Shot, Charm, Struggle Bug...),
//            Will-O-Wisp, Encore (on a Fake Out or other support user that moves first)
//            and Taunt. Helping Hand replaces an attack when the partner's boosted attack
//            is worth more. Finally, knowing what the other side plans: Protect for a lead
//            that would be knocked out, Wide Guard against spread moves and Quick Guard
//            against Fake Out and other priority moves when they save more than the lead's
//            own attack. Actions go by priority, then Speed. Taunt stops status moves,
//            Protect blocks everything aimed at its user, Prankster status moves fail on
//            Dark types, Good as Gold and Magic Bounce stop status moves.
//   Partner  Earthquake, Surf, Discharge, Bulldoze and the other "every Pokémon next to the
//            user" moves hit the user's partner too. Such a move is picked only when what
//            it does to the foes is worth more than what it does to the partner, and a
//            Speed drop is never used when it would hit the partner. A partner knocked out
//            this way does not count as a knockout for anyone.
//   Turn 2+  every active Pokémon attacks on the board turn 1 left: Tailwind doubles its
//            side's Speed for 3 more turns, Trick Room lets slower Pokémon move first for
//            4 more, Speed and Attack drops stay (a move's guaranteed drop, like Snarl's or
//            Icy Wind's, applies on every hit), sleep and Encore cost the next turns, a burn
//            halves physical damage and takes 1/16 HP a turn, HP carries over, Focus Sash and
//            Sitrus Berry work once. A Pokémon that faints is replaced from the back until
//            one side is out or the turn cap is reached.
// Damage is the calc engine's exact expected damage (mean roll x accuracy, halved for
// moves that need a recharge turn) for the board's weather, terrain, stat stages, burn
// and Helping Hand.
// The game's value = 50 + 50 x (our HP left - their HP left), each side's HP as a share
// of what it brought, kept to 0..100.
//
// A matchup is every bring of ours against every bring of theirs. We bring the one that
// holds up best; they answer with the one that hurts it most (max over ours of min over
// theirs, ties to the better average). 50 is even.
//
// One Mega Evolution a side. Only one Pokémon per side may Mega-Evolve in a battle, so a
// bring carries one Mega Stone: a second stone is a dead item slot, and no bring that can
// avoid it is offered. When a side must bring two holders anyway -- a lead pair of the
// matrix, or a team with almost nothing else -- one of them Mega-Evolves and the other
// plays its own base form, with the stone still in hand: base stats, base Ability, base
// Speed. Which one it is, is a choice: the holder that gains the most by Mega-Evolving,
// counting the extra stats, a new Ability, a new typing, and a lead that can Mega-Evolve on
// turn 1. This is the Companion's rule (lead_optimizer/mega_rule.py).
//
// The lead matrix: in Doubles every pair of ours plays the pairs they lead with most often,
// a full 2 vs 2 game of just those four (turn 1 and the fight after it), each of their
// Pokémon on its most common tournament set; in Singles every Pokémon of ours plays their
// most common Pokémon 1 vs 1.

import { compact, intimidateOffsets, makeMon, TERRAIN_SEEDS } from "./engine.js";
import { mostSimilarTeam } from "./known-teams.js";
import { classifyArchetype, tailwindBeneficiaries } from "./team-checks.js";

const BRING = { Singles: 3, Doubles: 4 };
const ACTIVE = { Singles: 1, Doubles: 2 };
const TURN_CAP = { Singles: 12, Doubles: 10 };
// Bring options the results list: the recommended one and the next strong choices.
const BRING_OPTIONS = { Singles: 3, Doubles: 4 };
const TAILWIND_TURNS = 3; // the turns after the one it is set on (4 counting that turn)
const TRICK_ROOM_TURNS = 4; // the turns after the one it is set on (5 counting that turn)
const IDLE_TURNS = 2; // sleep (from a sure-hit move) and Encore cost the next two actions
const BATCH = 8;
const MATRIX_ROWS = 40;
const MATRIX_EVERY = 8; // snapshots between lead-matrix refreshes while running (64 teams)
const ID_SPAN = 1 << 16;
const MAX_CACHED_HITS = 400000;
export const MATCHUP_BANDS = { favourable: 55, unfavourable: 45 };
export const SNAPSHOT_VERSION = 3;

const WEATHERS = ["None", "Sun", "Rain", "Sand", "Snow", "Strong Winds"];
const TERRAINS = ["None", "Electric", "Grassy", "Psychic", "Misty"];
const ANY = 7; // a move the board's weather or terrain does not change
// The field Abilities the evaluator's autoField honours (team-eval.js WEATHER_SETTERS /
// TERRAIN_SETTERS; Hadron Engine's terrain is left to the engine there as well).
const WEATHER_SETTERS = { drizzle: "Rain", drought: "Sun", sandstream: "Sand", snowwarning: "Snow", frostwarning: "Snow", desolateland: "Sun", primordialsea: "Rain", deltastream: "Strong Winds", orichalcumpulse: "Sun" };
const TERRAIN_SETTERS = { electricsurge: "Electric", grassysurge: "Grassy", psychicsurge: "Psychic", mistysurge: "Misty" };
const WEATHER_MOVES = new Set(["weatherball", "solarbeam", "solarblade", "hydrosteam", "thunder", "hurricane", "blizzard", "electroshot", "morningsun", "synthesis"]);
const WEATHER_ABILITIES = /solarpower|sandforce|protosynthesis|flowergift|orichalcumpulse|drought|drizzle|sandstream|snowwarning/;
const TERRAIN_TYPES = new Set(["Electric", "Grass", "Psychic", "Dragon"]);
const TERRAIN_MOVES = new Set(["expandingforce", "risingvoltage", "grassyglide", "psyblade", "terrainpulse", "earthquake", "bulldoze", "magnitude", "mistyexplosion"]);
const TERRAIN_ABILITIES = /quarkdrive|hadronengine|surgesurfer|grassysurge|psychicsurge|electricsurge|mistysurge|mimicry/;
const PRIORITY_BLOCKERS = new Set(["armortail", "dazzling", "queenlymajesty"]);
const MOLD_BREAKERS = new Set(["moldbreaker", "teravolt", "turboblaze"]);
const FLINCH_PROOF = new Set(["innerfocus", "shielddust"]);
const FIRST_TURN_ONLY = new Set(["fakeout", "firstimpression"]);
// Priorities the move table lists as 0: First Impression is +2, Helping Hand +5, Quick Guard +3.
const PRIORITY_FIX = { firstimpression: 2, helpinghand: 5, quickguard: 3, wideguard: 3 };
const ELECTRIC = TERRAINS.indexOf("Electric");
const GRASSY = TERRAINS.indexOf("Grassy");
const PSYCHIC = TERRAINS.indexOf("Psychic");
const MISTY = TERRAINS.indexOf("Misty");
// Status moves the move table lists as 80-power attacks.
const NOT_ATTACKS = new Set(["spore", "matblock", "tarshot", "floralhealing", "aromatherapy", "luckychant", "junglehealing", "confide", "softboiled", "playnice", "lovelykiss", "grasswhistle"]);
const LOWERED_STAT_BOOST = { defiant: [2, 0], competitive: [0, 2] };
const STAT_DROP_PROOF = new Set(["clearbody", "whitesmoke", "fullmetalbody", "mirrorarmor"]);
// The stat stages a move surely lowers on its target: [Attack, Sp. Atk, Speed]. On an attack
// it is a secondary effect (Sheer Force, Shield Dust and Covert Cloak remove it).
const STAT_DROPS = {
  snarl: [0, -1, 0], strugglebug: [0, -1, 0], mysticalfire: [0, -1, 0], skittersmack: [0, -1, 0], spiritbreak: [0, -1, 0],
  breakingswipe: [-1, 0, 0], lunge: [-1, 0, 0], tropkick: [-1, 0, 0], chillingwater: [-1, 0, 0], bittermalice: [-1, 0, 0],
  icywind: [0, 0, -1], electroweb: [0, 0, -1], bulldoze: [0, 0, -1], rocktomb: [0, 0, -1], mudshot: [0, 0, -1],
  lowsweep: [0, 0, -1], pounce: [0, 0, -1], glaciate: [0, 0, -1], drumbeating: [0, 0, -1],
  charm: [-2, 0, 0], featherdance: [-2, 0, 0], babydolleyes: [-1, 0, 0], tickle: [-1, 0, 0], playnice: [-1, 0, 0], growl: [-1, 0, 0],
  partingshot: [-1, -1, 0], nobleroar: [-1, -1, 0], eerieimpulse: [0, -2, 0], confide: [0, -1, 0],
};
// Sleep moves and how many actions the target loses (sure hits two, the rest one).
const SLEEP_MOVES = { spore: 2, sleeppowder: 1, hypnosis: 1, sing: 1, lovelykiss: 1, grasswhistle: 1 };
const POWDER_MOVES = new Set(["spore", "sleeppowder"]);
const SLEEP_PROOF = new Set(["insomnia", "vitalspirit", "sweetveil", "comatose", "purifyingsalt"]);
const BURN_PROOF = new Set(["waterveil", "waterbubble", "thermalexchange", "comatose", "purifyingsalt", "guts"]);
const NO_HIT = Object.freeze({ slot: -1, frac: 0, lo: 0, hi: 0, priority: 0, spread: false });

// Turn-1 actions.
const FAKE_OUT = 1;
const TAILWIND = 2;
const TRICK_ROOM = 3;
const REDIRECT = 4;
const SPEED_DROP = 5;
const ATTACK = 6;
const PROTECT = 7;
const HELPING_HAND = 8;
const WIDE_GUARD = 9;
const QUICK_GUARD = 10;
const SLEEP = 11;
const TAUNT = 12;
const ENCORE = 13;
const LOWER = 14;
const BURN = 15;
// The actions that are status moves (Taunt stops them; Encore locks a Pokémon that used one).
const STATUS_ACTIONS = new Set([TAILWIND, TRICK_ROOM, REDIRECT, PROTECT, HELPING_HAND, WIDE_GUARD, QUICK_GUARD, SLEEP, TAUNT, ENCORE, BURN]);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const teamNumber = (name) => Number((String(name).match(/\d+/) || [0])[0]) || 0;
const clampStage = (value) => Math.max(-6, Math.min(6, value));
const stageFactor = (stage) => (stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage));
const hitsFor = (frac) => (frac > 1e-9 ? Math.min(99, Math.ceil(1 / frac - 1e-9)) : 99);
// A Pokémon as the results name it. A stone holder that does not Mega-Evolve this game is
// named by its base form, so `item` is empty (the item decides the name and the sprite) and
// `stone` says which Mega Stone it is still holding.
const who = (unit) => (unit.stone
  ? { species: unit.species, form: unit.form, item: "", stone: unit.stone }
  : { species: unit.species, form: unit.form, item: unit.item });
const alive = (m) => Boolean(m && !m.out);

function combinations(size, k) {
  const out = [];
  const pick = (start, chosen) => {
    if (chosen.length === k) {
      out.push([...chosen]);
      return;
    }
    for (let i = start; i < size; i += 1) pick(i + 1, [...chosen, i]);
  };
  pick(0, []);
  return out;
}

/** Priority first, then Speed (reversed under Trick Room); ties alternate by turn. */
function orderActions(actions, trickRoom, turn) {
  return actions.sort((a, b) => b.pr - a.pr || (trickRoom ? a.sp - b.sp : b.sp - a.sp) || (turn % 2 ? b.s - a.s : a.s - b.s));
}

export class TournamentTest {
  /**
   * @param {TeamEvaluation} evaluation   its evaluator does every calculation
   * @param {KnownTeams} known            the tournament-team library
   * @param {TeamSuggestions} suggestions for the Stat Points that go with a Nature
   */
  constructor(evaluation, known, suggestions) {
    this.evaluation = evaluation;
    this.ev = evaluation.ev;
    this.known = known;
    this.suggestions = suggestions;
    this.format = this.ev.format === "Singles" ? "Singles" : "Doubles";
    this.bring = BRING[this.format];
    this.active = ACTIVE[this.format];
    this.turnCap = TURN_CAP[this.format];
    const tables = this.ev.engine.data?.analysisTables || {};
    this.protectMoves = new Set((tables._SIMPLE_PROTECT_V187 || ["protect", "detect"]).map(compact));
    this.redirectMoves = new Set((tables._V250_REDIRECTION_MOVES || ["follow me", "rage powder"]).map(compact).filter((k) => k !== "spotlight"));
    this.speedDropMoves = new Map(Object.entries(tables._V252_SPEED_DROP_MOVES || {}).map(([name, [, spread]]) => [compact(name), Boolean(spread)]));
    const s = this.ev.settings;
    this.fixedWeather = Math.max(0, WEATHERS.indexOf(s.weather));
    this.fixedTerrain = Math.max(0, TERRAINS.indexOf(s.terrain));
    this.monCache = new Map();
    this.ourCache = new Map();
    this.archetypeCache = new Map();
    this.moveInfoCache = new Map();
    this.resetCaches();
    const aliases = this.ev.engine.data?.usageAliases || {};
    this.usageStem = new Map(Object.entries(aliases).map(([stem, [species, form]]) => [`${compact(species)}|${compact(form)}`, stem]));
  }

  resetCaches() {
    this.gen = (this.gen || 0) + 1;
    this.nextId = 0;
    this.hits = new Map();
    this.best = new Map();
    this.bestSafe = new Map();
    this.speeds = new Map();
    this.cells = new Map();
    this.calcs = 0;
  }

  /** The tournament teams in file order (team1, team2, ...), the first `limit` of them. */
  teams(limit) {
    return [...this.known.teams].sort((a, b) => teamNumber(a.name) - teamNumber(b.name)).slice(0, Math.max(1, limit));
  }

  // --- the Pokémon -----------------------------------------------------------------------

  /** A tournament member as a calculation mon: its own set, and the Stat Points usage pairs with its Nature. */
  opponentMon(member) {
    const key = [member.species, member.form, member.item, member.ability, member.nature, (member.moves || []).join("+")].join("|");
    const cached = this.monCache.get(key);
    if (cached) return this.prepare(cached);
    const usage = this.usageStem.get(`${compact(member.species)}|${compact(member.form)}`) || member.species;
    const spread = this.suggestions.spreadForNature(usage, member.nature || "") || this.suggestions.spreadForNature(member.species, member.nature || "");
    const mon = makeMon({
      pokemon_name: member.species,
      form_name: member.form || member.species,
      item: member.item || "",
      ability: member.ability || "",
      nature_name: member.nature || spread?.nature_name || "Serious",
      bonuses: [...(spread?.bonuses || [0, 0, 0, 0, 0, 0])],
      moves: (member.moves || []).slice(0, 4),
    });
    if (compact(mon.item) && this.ev.engine.isMegaStone(mon.item)) {
      const megaForm = this.ev.megaFormForItem(mon.pokemon_name, mon.item);
      if (megaForm && compact(megaForm) !== compact(mon.pokemon_name)) {
        mon.form_name = megaForm;
        mon.ability = this.ev.megaAbility(mon.pokemon_name, megaForm, mon.ability);
      }
    }
    mon.analysis_side = "threat";
    this.ev.applyStages(mon, this.ev.settings.threat_stages);
    const entry = {
      key, mon, species: member.species, form: mon.form_name, item: mon.item, display: `${compact(member.species)}|${compact(mon.form_name)}`,
      // The form and Ability it walks in with: a Mega Stone holder Mega-Evolves during the turn.
      baseForm: member.form || member.species, baseAbility: member.ability || "",
    };
    this.monCache.set(key, entry);
    return this.prepare(entry);
  }

  /** One of our slots as a unit (cached by its set, so the damage caches outlive a run). */
  ourUnit(set, index) {
    const mon = this.ev.teamMon(set, index);
    // The Ability on the set is part of the key: a Mega Stone overwrites it with the Mega's,
    // but the base one is what fires as it comes in.
    const baseForm = set.form || set.species;
    const baseAbility = set.ability || "";
    const key = ["team", mon.pokemon_name, mon.form_name, mon.item, mon.ability, baseForm, baseAbility, mon.nature_name, (mon.bonuses || []).join(","), (mon.moves || []).join("+")].join("|");
    let unit = this.ourCache.get(key);
    if (!unit) {
      unit = { key, mon, species: set.species, form: mon.form_name, item: set.item || "", display: `${compact(set.species)}|${compact(mon.form_name)}`, baseForm, baseAbility };
      this.ourCache.set(key, unit);
    }
    return this.prepare(unit);
  }

  /**
   * The mon a Mega Stone holder comes in as, before it Mega-Evolves during the turn:
   * its base form and the base form's Ability. null when it is not a Mega Stone holder.
   */
  baseFormMon(unit) {
    const mon = unit.mon;
    if (!compact(mon.item) || !this.ev.engine.isMegaStone(mon.item)) return null;
    // A set usually names the base form and its Ability, and the stone turns both into the
    // Mega's. Some already name the Mega form, and then the base form is the species itself
    // and the Ability on the set is the Mega's, so the species' own first Ability stands in.
    const named = String(unit.baseForm || "").trim();
    const ownForm = named && compact(named) !== compact(mon.form_name);
    const form = ownForm ? named : mon.pokemon_name;
    if (compact(form) === compact(mon.form_name)) return null;
    let ability = ownForm ? String(unit.baseAbility || "").trim() : "";
    if (!ability) {
      const data = this.ev.engine.pokemon(mon.pokemon_name, form) || {};
      ability = (data.abilities || []).map((a) => String(a || "").trim()).find(Boolean) || mon.ability;
    }
    // Without the stone the engine leaves the form alone, so this reads the base form's stats.
    return { ...mon, bonuses: [...(mon.bonuses || [])], form_name: form, ability, item: "" };
  }

  /** What one move does in the model (cached by name). */
  moveInfo(name) {
    let info = this.moveInfoCache.get(name);
    if (info) return info;
    const meta = this.ev.meta(name);
    const k = compact(name);
    const type = String(meta.type || "");
    const category = String(meta.category || "").toLowerCase();
    const listed = this.ev.movePriority(name);
    const priority = PRIORITY_FIX[k] ?? listed;
    const solar = k === "solarbeam" || k === "solarblade";
    const spread = Boolean(meta.spread) && this.format === "Doubles";
    const damaging = this.ev.damagingMove(name) && !NOT_ATTACKS.has(k);
    info = {
      name, key: k, type, priority, listed, solar, spread,
      // "allAdjacent" (Earthquake, Surf, Discharge, Bulldoze...) hits the user's partner too.
      allyHit: spread && meta.target === "allAdjacent",
      physical: category === "physical",
      special: category === "special",
      attack: damaging && !FIRST_TURN_ONLY.has(k) && !this.ev.selfDestructs(name) && !this.ev.excludedMoves.has(name.toLowerCase()),
      damaging,
      drop: STAT_DROPS[k] || null,
      sound: (meta.flags || []).map((f) => String(f).toLowerCase()).includes("sound"),
      weather: type === "Fire" || type === "Water" || WEATHER_MOVES.has(k),
      terrain: TERRAIN_TYPES.has(type) || TERRAIN_MOVES.has(k) || priority > 0,
      cooldown: solar ? null : this.ev.hasCooldown(name, {}),
    };
    this.moveInfoCache.set(name, info);
    return info;
  }

  /** Gives a unit its id, its moves' info and its turn-1 kit (once per cache generation). */
  prepare(unit) {
    if (unit.gen === this.gen) return unit;
    unit.gen = this.gen;
    unit.id = ++this.nextId;
    if (unit.kit) return unit;
    const mon = unit.mon;
    const engine = this.ev.engine;
    const data = engine.pokemon(mon.pokemon_name, mon.form_name) || {};
    const types = data.types || [];
    const ability = compact(mon.ability);
    const item = compact(mon.item);
    unit.moves = (mon.moves || []).map((move) => this.moveInfo(move));
    unit.attacks = unit.moves.map((info, slot) => (info.attack ? slot : -1)).filter((slot) => slot >= 0);
    // The attacks that leave the partner alone, and whether any does not.
    unit.safeAttacks = unit.attacks.filter((slot) => !unit.moves[slot].allyHit);
    unit.allyHits = unit.safeAttacks.length < unit.attacks.length;
    unit.grounded = engine.isGrounded(mon, data, null);
    unit.moldBreaker = MOLD_BREAKERS.has(ability);
    unit.grass = types.includes("Grass");
    unit.weatherSense = types.includes("Rock") || types.includes("Ice") || WEATHER_ABILITIES.test(ability);
    // A terrain seed holder's defence depends on the board's terrain too, so the damage
    // cache must key on it; without this the calc made on a terrainless board is reused.
    unit.terrainSense = TERRAIN_ABILITIES.test(ability) || Boolean(TERRAIN_SEEDS[item]);
    const keys = unit.moves.map((info) => info.key);
    const field = compact(this.ev.fieldAbility(mon));
    const s = this.ev.settings;
    const stats = engine.finalStats(mon);
    const doubles = this.active > 1;
    // Sheer Force removes the Speed drop (it is the move's secondary effect).
    const speedDrop = ability === "sheerforce" ? -1 : keys.findIndex((k, slot) => this.speedDropMoves.get(k) && unit.moves[slot].damaging);
    const redirect = keys.findIndex((k) => this.redirectMoves.has(k));
    const sleep = keys.findIndex((k) => SLEEP_MOVES[k]);
    // A Mega Stone holder walks in as its base form and Mega-Evolves during the turn, so the
    // base form's Ability and Speed are what count as it comes in.
    const base = this.baseFormMon(unit);
    unit.base = base;
    unit.entrySpeed = base ? engine.effectiveSpeed({ ...base, speed_stage: clampStage(base.speed_stage || 0) }, { weather: WEATHERS[0], tailwind: false }) : null;
    // Intimidate fires once on turn 1: from the base form as it enters, or from the Mega's own
    // Ability as it Mega-Evolves (Mega Salamence keeps Salamence's, Mega Manectric gains one).
    const baseAbility = base ? compact(base.ability) : ability;
    unit.intimidateMon = baseAbility === "intimidate" ? base || mon : ability === "intimidate" ? mon : null;
    const kit = {
      fakeOut: keys.indexOf("fakeout"),
      firstImpression: keys.findIndex((k, slot) => k === "firstimpression" && unit.moves[slot].damaging),
      tailwind: keys.includes("tailwind"),
      trickRoom: keys.includes("trickroom"),
      protect: keys.some((k) => this.protectMoves.has(k)),
      redirect: doubles && redirect >= 0 ? unit.moves[redirect].name : "",
      rage: redirect >= 0 && keys[redirect] === "ragepowder",
      speedDrop,
      helpingHand: doubles && keys.includes("helpinghand"),
      wideGuard: doubles && keys.includes("wideguard"),
      quickGuard: keys.includes("quickguard"),
      sleep,
      sleepTurns: sleep >= 0 ? SLEEP_MOVES[keys[sleep]] : 0,
      powder: sleep >= 0 && POWDER_MOVES.has(keys[sleep]),
      taunt: keys.indexOf("taunt"),
      encore: keys.indexOf("encore"),
      wisp: keys.indexOf("willowisp"),
      // Moves that lower the target's Attack or Sp. Atk (Snarl, Parting Shot, Charm...).
      // (an attack's drop is its secondary effect, which Sheer Force removes).
      lowers: unit.moves.map((info, slot) => (info.drop && (info.drop[0] < 0 || info.drop[1] < 0) && (info.attack || !info.damaging) ? slot : -1))
        .filter((slot) => slot >= 0 && !(unit.moves[slot].damaging && ability === "sheerforce")),
      prankster: ability === "prankster",
      intimidate: Boolean(unit.intimidateMon),
      flinchProof: FLINCH_PROOF.has(ability) || item === "covertcloak",
      // Clear Body and friends stop every stat drop; Shield Dust and Covert Cloak stop the ones
      // that come with an attack (Icy Wind's, Snarl's); Hyper Cutter keeps its Attack.
      statProof: STAT_DROP_PROOF.has(ability),
      secondaryProof: ability === "shielddust" || item === "covertcloak",
      hyperCutter: ability === "hypercutter",
      sheerForce: ability === "sheerforce",
      priorityBlock: PRIORITY_BLOCKERS.has(ability),
      // Good as Gold and Magic Bounce stop status moves aimed at it.
      statusProof: ability === "goodasgold" || ability === "magicbounce",
      tauntProof: ability === "oblivious" || ability === "aromaveil",
      sleepProof: SLEEP_PROOF.has(ability),
      powderProof: types.includes("Grass") || ability === "overcoat" || item === "safetygoggles",
      burnProof: types.includes("Fire") || BURN_PROOF.has(ability),
      soundProof: ability === "soundproof",
      dark: types.includes("Dark"),
      weather: s.weather === "None" && s.use_weather_abilities ? WEATHER_SETTERS[field] || "" : "",
      terrain: s.terrain === "None" ? TERRAIN_SETTERS[field] || "" : "",
      sash: item === "focussash",
      sitrus: item === "sitrusberry",
      power: Math.max(Number(stats.attack) || 0, Number(stats.sp_attack) || 0),
    };
    kit.lead = (kit.fakeOut >= 0 ? 3 : 0) + (kit.tailwind ? 3 : 0) + (kit.trickRoom ? 3 : 0) + (kit.intimidate ? 2 : 0)
      + (kit.redirect ? 1.5 : 0) + (kit.speedDrop >= 0 ? 1.5 : 0) + (kit.firstImpression >= 0 ? 1.5 : 0)
      + (kit.weather || kit.terrain ? 1.5 : 0) + (kit.sleep >= 0 ? kit.sleepTurns : 0)
      + (kit.helpingHand ? 1 : 0) + (kit.wideGuard ? 1 : 0) + (kit.quickGuard ? 0.5 : 0)
      + (kit.taunt >= 0 ? 1 : 0) + (kit.encore >= 0 ? 1 : 0) + (kit.lowers.length ? 1 : 0) + (kit.wisp >= 0 ? 0.5 : 0)
      + kit.power / 150;
    unit.kit = kit;
    return unit;
  }

  /** The team's archetype by the Team Building Checks' own detection (team_evaluation_v462). */
  archetypeOf(team, theirs) {
    if (this.archetypeCache.has(team.name)) return this.archetypeCache.get(team.name);
    let label = "Balanced";
    try {
      const slots = theirs.map((t) => ({ entry: { pokemon: t.species, item: t.mon.item, form: t.mon.form_name, ability: t.mon.ability, moves: [...t.mon.moves] }, mon: t.mon }));
      const { checks, synergy } = this.evaluation;
      const profiles = slots.map(({ entry, mon }) => synergy.profile(entry, mon));
      const features = checks.archetypeFeatures(checks.profiles(slots), { tailwind: tailwindBeneficiaries(profiles, synergy.metaSpeedRows()) });
      label = classifyArchetype(features)[0] || "Balanced";
    } catch {
      label = "Balanced";
    }
    this.archetypeCache.set(team.name, label);
    return label;
  }

  // --- damage and Speed ----------------------------------------------------------------------

  /**
   * One move into one defender on this board, cached with only the parts of the board it depends on.
   * `fx`: 1 = Helping Hand (Doubles), 2 = the attacker is burned (physical moves).
   */
  moveHit(att, def, slot, board, atk, spa, fx = 0) {
    const info = att.moves[slot];
    if (!info) return NO_HIT;
    const w = info.weather || att.weatherSense || def.weatherSense ? board.w : ANY;
    const t = info.terrain || att.terrainSense || def.terrainSense ? board.t : ANY;
    const stage = info.physical ? atk : info.special ? spa : 0;
    const f = (this.active > 1 ? fx & 1 : 0) | (info.physical ? fx & 2 : 0);
    const key = (((((att.id * ID_SPAN + def.id) * 4 + slot) * 8 + w) * 8 + t) * 13 + stage + 6) * 4 + f;
    let hit = this.hits.get(key);
    if (hit === undefined) {
      hit = this.calc(att, def, info, slot, w, t, stage, f);
      this.hits.set(key, hit);
    }
    return hit;
  }

  calc(att, def, info, slot, w, t, stage, f) {
    // Grassy Glide is +1 in Grassy Terrain when its user is on the ground.
    const priority = info.priority + (info.key === "grassyglide" && t === GRASSY && att.grounded ? 1 : 0);
    // Priority the move table does not list is priority the engine cannot see, so its
    // blocks are applied here: Psychic Terrain for a grounded target, and Armor Tail,
    // Dazzling and Queenly Majesty (unless the attacker has Mold Breaker).
    if (priority > 0 && priority > info.listed && ((t === PSYCHIC && def.grounded) || (def.kit?.priorityBlock && !att.moldBreaker))) return NO_HIT;
    // The board applies Intimidate on entry, so the engine must not apply it again.
    const attacker = { ...att.mon, _white_herb_restored_v314: true };
    if (stage && info.physical) attacker.attack_stage = clampStage((att.mon.attack_stage || 0) + stage);
    if (stage && info.special) attacker.sp_attack_stage = clampStage((att.mon.sp_attack_stage || 0) + stage);
    const s = this.ev.settings;
    try {
      const ctx = this.ev.calcContext(attacker, def.mon, info.name);
      if (s.weather === "None") {
        const weather = WEATHERS[w === ANY ? 0 : w];
        ctx.weather = weather;
        ctx.attacker_state.weather = weather;
        ctx.defender_state.weather = weather;
      }
      if (s.terrain === "None") ctx.terrain = TERRAINS[t === ANY ? 0 : t];
      if (f & 1) ctx.helping_hand = true;
      if (f & 2) ctx.burned = true;
      const result = this.ev.calculate(attacker, def.mon, ctx);
      this.calcs += 1;
      const rolls = result.rolls || [];
      const maxHp = Number(result.max_hp) || 1;
      if (!rolls.length) return NO_HIT;
      let lo = Infinity;
      let hi = 0;
      let sum = 0;
      for (const roll of rolls) {
        sum += roll;
        if (roll < lo) lo = roll;
        if (roll > hi) hi = roll;
      }
      if (hi <= 0) return NO_HIT;
      const raw = result.move_accuracy_factor;
      let scale = raw === undefined || raw === null ? 1 : Math.max(0, Math.min(1, Number(raw)));
      if (info.cooldown === null ? this.ev.hasCooldown(info.name, result) : info.cooldown) scale /= 2;
      scale /= maxHp;
      return { slot, frac: (sum / rolls.length) * scale, lo: lo * scale, hi: hi * scale, priority, spread: info.spread };
    } catch {
      return NO_HIT;
    }
  }

  /** A Pokémon's move into another on this board, with its stages, burn and Helping Hand. */
  hitOn(m, target, slot, board, helped = m.helped) {
    return this.moveHit(m.u, target.u, slot, board, m.atk, m.spa, (helped ? 1 : 0) | (m.burn ? 2 : 0));
  }

  /**
   * The attacker's best attack into the defender on this board (ties go to the higher priority).
   * `safe`: only the attacks that leave the attacker's partner alone. `burned`: the attacker is burned.
   */
  strike(att, def, board, atk = 0, spa = 0, safe = false, burned = false) {
    const key = ((((att.id * ID_SPAN + def.id) * 8 + board.w) * 8 + board.t) * 169 + (atk + 6) * 13 + spa + 6) * 2 + (burned ? 1 : 0);
    const cache = safe ? this.bestSafe : this.best;
    let best = cache.get(key);
    if (best !== undefined) return best;
    best = NO_HIT;
    const fx = burned ? 2 : 0;
    for (const slot of safe ? att.safeAttacks : att.attacks) best = this.better(best, this.moveHit(att, def, slot, board, atk, spa, fx));
    cache.set(key, best);
    return best;
  }

  better(best, hit) {
    return hit.frac > best.frac + 1e-9 || (hit.frac > 0 && Math.abs(hit.frac - best.frac) <= 1e-9 && hit.priority > best.priority) ? hit : best;
  }

  speedOf(unit, w, tailwind, stage) {
    const key = ((unit.id * 8 + w) * 2 + (tailwind ? 1 : 0)) * 13 + stage + 6;
    let speed = this.speeds.get(key);
    if (speed === undefined) {
      const mon = unit.mon;
      speed = this.ev.engine.effectiveSpeed({ ...mon, speed_stage: clampStage((mon.speed_stage || 0) + stage) }, { weather: WEATHERS[w], tailwind });
      this.speeds.set(key, speed);
    }
    return speed;
  }

  speed(m, board) {
    return this.speedOf(m.u, board.w, board.tw[m.s] > 0, m.spe);
  }

  /** The Speed a unit has as it comes in (a Mega Stone holder's base form). */
  entrySpeedOf(unit) {
    return unit.entrySpeed ?? this.speedOf(unit, 0, false, 0);
  }

  /** The most damage a Pokémon's best attack does to any of these (a share of their HP). */
  threatTo(foe, list, board) {
    let danger = 0;
    for (const own of list) if (alive(own)) danger = Math.max(danger, Math.min(own.hp, this.strike(foe.u, own.u, board, foe.atk, foe.spa, false, foe.burn).frac));
    return danger;
  }

  // --- one Mega Evolution a side ---------------------------------------------------------

  /** Is this unit holding a Mega Stone that would turn it into another form? */
  megaHolder(unit) {
    return Boolean(unit && unit.base);
  }

  /**
   * What a holder gains by Mega-Evolving: the Top Lead optimizer's rule (mega_rule.mega_value)
   * -- the extra base stats over 8, plus 16 for an Ability the base form does not have (5 for
   * the same one) and 7 for a new typing. Static, so it is worked out once per unit.
   */
  megaValue(unit) {
    if (!this.megaHolder(unit)) return -1e9;
    if (unit._megaValue !== undefined) return unit._megaValue;
    const engine = this.ev.engine;
    const record = (mon) => engine.pokemon(mon.pokemon_name, mon.form_name) || {};
    const total = (mon) => {
      const stats = record(mon).stats || {};
      return ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"].reduce((sum, key) => sum + (Number(stats[key]) || 0), 0);
    };
    const baseTypes = (record(unit.base).types || []).join("/");
    const megaTypes = (record(unit.mon).types || []).join("/");
    const ability = compact(unit.mon.ability) && compact(unit.mon.ability) !== compact(unit.base.ability) ? 16 : 5;
    unit._megaValue = (total(unit.mon) - total(unit.base)) / 8 + ability + (megaTypes && megaTypes !== baseTypes ? 7 : 0);
    return unit._megaValue;
  }

  /** The stone holders among these indices, in the order given. */
  stoneHolders(idx, units) {
    return idx.filter((i) => this.megaHolder(units[i]));
  }

  /**
   * How many stone holders one bring may carry: one, unless the side has too few Pokémon
   * without a stone to fill the rest of the bring (mega_rule.allowed_stone_count).
   */
  allowedStones(units, size) {
    const withoutStone = units.filter((unit) => !this.megaHolder(unit)).length;
    return Math.max(1, size - withoutStone);
  }

  /**
   * Which holder of a bring Mega-Evolves, or -1 when it brings no stone
   * (mega_rule.committed_mega). A leading holder gets the optimizer's +7, since it can
   * Mega-Evolve on turn 1; ties go to the lower slot, so the answer is stable.
   */
  committedMega(idx, units, lead = []) {
    const leading = new Set(lead);
    let best = -1;
    let bestValue = 0;
    for (const i of idx) {
      if (!this.megaHolder(units[i])) continue;
      const value = this.megaValue(units[i]) + (leading.has(i) ? 7 : 0);
      if (best < 0 || value > bestValue + 1e-9) {
        best = i;
        bestValue = value;
      }
    }
    return best;
  }

  /**
   * A stone holder that is not the one Mega-Evolving, as its own base form: base stats,
   * base Ability, base Speed, the stone still in hand but doing nothing. Cached on the unit,
   * so its damage caches outlive a run like every other unit's.
   */
  baseFormUnit(unit) {
    if (!this.megaHolder(unit)) return unit;
    if (!unit.baseUnit) {
      const mon = unit.base;
      unit.baseUnit = {
        key: `${unit.key}|base`, mon, species: unit.species, form: mon.form_name,
        // The name and the sprite follow the item, so the base form needs none; `stone` is
        // what it is holding, for the results to say so.
        item: "", stone: unit.item || unit.mon.item || "",
        display: `${compact(unit.species)}|${compact(mon.form_name)}`,
        baseForm: mon.form_name, baseAbility: mon.ability,
      };
    }
    return this.prepare(unit.baseUnit);
  }

  /** These Pokémon as they play: one Mega at most, every other holder in its base form. */
  membersOf(idx, units, lead) {
    const committed = this.committedMega(idx, units, lead);
    return new Map(idx.map((i) => [i, i === committed ? units[i] : this.baseFormUnit(units[i])]));
  }

  // --- one game --------------------------------------------------------------------------

  /**
   * Our brings (or theirs): members lead first, then the back in team order.
   * A bring carries one Mega Stone, and the holder that gains the most Mega-Evolves; the
   * leads are then picked from the forms that really play, so a base form's own turn-1 kit
   * decides whether it leads.
   */
  plansFor(units) {
    const size = Math.min(this.bring, units.length);
    const allowed = this.allowedStones(units, size);
    const every = combinations(units.length, size);
    const kept = every.filter((idx) => this.stoneHolders(idx, units).length <= allowed);
    return (kept.length ? kept : every).map((idx) => {
      const opening = [...idx].sort((a, b) => units[b].kit.lead - units[a].kit.lead || a - b).slice(0, Math.min(this.active, size));
      const played = this.membersOf(idx, units, opening);
      const leads = [...idx].sort((a, b) => played.get(b).kit.lead - played.get(a).kit.lead || a - b).slice(0, Math.min(this.active, size)).sort((a, b) => a - b);
      const order = [...leads, ...idx.filter((i) => !leads.includes(i))];
      const members = order.map((i) => played.get(i));
      const mean = members.reduce((sum, u) => sum + this.speedOf(u, 0, false, 0), 0) / Math.max(1, members.length);
      return { idx, order, members, unitAt: played, leads: leads.length, leadKey: members.slice(0, leads.length).map((u) => u.id).join(","), mean };
    });
  }

  /**
   * A line-up that is all leads (the lead matrix): these Pokémon and no one behind them.
   * The caller names them, so two stone holders can stand here -- one Mega-Evolves and the
   * other leads in its base form.
   */
  fixedPlan(units) {
    const idx = units.map((_, i) => i);
    const played = this.membersOf(idx, units, idx.slice(0, Math.min(this.active, units.length)));
    const members = idx.map((i) => played.get(i));
    const leads = Math.min(this.active, members.length);
    const mean = members.reduce((sum, u) => sum + this.speedOf(u, 0, false, 0), 0) / Math.max(1, members.length);
    return { idx, order: idx, members, unitAt: played, leads, leadKey: members.map((u) => u.id).join(","), mean };
  }

  fresh(unit, s, lead) {
    return {
      u: unit, k: unit.kit, s, hp: 1, spe: 0, atk: 0, spa: 0, sash: unit.kit.sash, berry: unit.kit.sitrus, out: false, kos: 0,
      flinch: false, guard: false, intimidated: false, lead,
      idle: 0, sleep: false, burn: false, helped: false, taunted: false, acted: 0,
    };
  }

  /**
   * A Pokémon comes in: its weather or terrain, and its Intimidate.
   * A Mega Stone holder is still its base form here, so Intimidate reads the base form's
   * Ability on both sides (Mega Salamence lowers Attack; Mega Mawile's Hyper Cutter still
   * blocks it). It Mega-Evolves during the turn, and the Mega's Ability takes it from there.
   */
  enter(m, active, board, events) {
    const k = m.k;
    if (k.weather) {
      board.w = WEATHERS.indexOf(k.weather);
      events?.push({ s: m.s, kind: "weather", actor: m.u, value: k.weather });
    }
    if (k.terrain) {
      board.t = TERRAINS.indexOf(k.terrain);
      events?.push({ s: m.s, kind: "terrain", actor: m.u, value: k.terrain });
    }
    if (!k.intimidate) return;
    const source = m.u.intimidateMon || m.u.mon;
    const lowered = [];
    for (const foe of active[1 - m.s]) {
      if (!alive(foe)) continue;
      const target = foe.u.base || foe.u.mon;
      const ability = compact(target.ability);
      if (ability === "hypercutter" || ability === "mirrorarmor") continue;
      if (ability === "guarddog") {
        foe.atk = clampStage(foe.atk + 1);
        continue;
      }
      const offsets = intimidateOffsets(source, target);
      if (!offsets.attack_stage && !offsets.sp_attack_stage) continue;
      foe.atk = clampStage(foe.atk + offsets.attack_stage);
      foe.spa = clampStage(foe.spa + offsets.sp_attack_stage);
      if (offsets.attack_stage < 0) {
        lowered.push(foe.u);
        foe.intimidated = true;
      }
    }
    if (lowered.length) events?.push({ s: m.s, kind: "intimidate", actor: m.u, targets: lowered });
  }

  /**
   * Damage from one hit: Focus Sash holds at 1% from full HP, Sitrus Berry heals 25% at half HP.
   * `partner`: the attacker hit its own partner, so a knockout is not the attacker's.
   * True when the hit landed.
   */
  deal(att, target, hit, events, partner = false) {
    if (!target || target.out || target.guard || hit.frac <= 0) return false;
    let damage = hit.frac;
    if (target.sash && target.hp >= 0.999 && damage >= target.hp) {
      damage = target.hp - 0.01;
      target.sash = false;
    }
    target.hp -= damage;
    if (target.hp <= 1e-9) {
      target.hp = 0;
      target.out = true;
      if (partner) {
        events?.push({ s: att.s, kind: "partnerko", actor: att.u, target: target.u, move: att.u.moves[hit.slot]?.name || "" });
        return true;
      }
      att.kos += 1;
      events?.push({ s: att.s, kind: "ko", actor: att.u, target: target.u });
      return true;
    }
    this.berry(target);
    return true;
  }

  berry(target) {
    if (target.berry && !target.out && target.hp <= 0.5) {
      target.hp = Math.min(1, target.hp + 0.25);
      target.berry = false;
    }
  }

  /**
   * Lowers a Pokémon's stats ([Attack, Sp. Atk, Speed] stages). Clear Body and friends stop it,
   * Hyper Cutter keeps its Attack, Defiant / Competitive answer a drop from the other side.
   * Returns the stats that went down (an empty list when none did).
   */
  lowerStats(target, drop, fromFoe = true) {
    if (!alive(target) || target.k.statProof) return [];
    const done = [];
    if (drop[0] < 0 && !target.k.hyperCutter && target.atk > -6) {
      target.atk = clampStage(target.atk + drop[0]);
      done.push("atk");
    }
    if (drop[1] < 0 && target.spa > -6) {
      target.spa = clampStage(target.spa + drop[1]);
      done.push("spa");
    }
    if (drop[2] < 0 && target.spe > -6) {
      target.spe = clampStage(target.spe + drop[2]);
      done.push("spe");
    }
    const boost = fromFoe && done.length ? LOWERED_STAT_BOOST[compact(target.u.mon.ability)] : null;
    if (boost) {
      target.atk = clampStage(target.atk + boost[0] * done.length);
      target.spa = clampStage(target.spa + boost[1] * done.length);
    }
    return done;
  }

  /** An attack's sure stat drop after it landed (Sheer Force, Shield Dust and Covert Cloak remove it). */
  afterHit(m, target, info) {
    if (!info.drop || !alive(target) || m.k.sheerForce || target.k.secondaryProof) return [];
    return this.lowerStats(target, info.drop, m.s !== target.s);
  }

  /** What a hit is worth against one Pokémon: a knockout first, then the share of its HP. */
  hitScore(frac, target) {
    if (frac <= 0) return 0;
    const ko = frac >= target.hp && !(target.sash && target.hp >= 0.999) ? 10 : 0;
    return ko + Math.min(frac, target.hp) / Math.max(0.05, target.hp);
  }

  /** The attacker's partner that is still in (Doubles has one). */
  partnerOf(m, allies) {
    for (const ally of allies) if (ally && ally !== m && !ally.out) return ally;
    return null;
  }

  /**
   * The foe this attacker hits hardest: a knockout first, then the most damage for the target's HP.
   * `allies` is the attacker's own side (for moves that hit the partner too); `firstTurn` lets a
   * lead use First Impression.
   */
  pickTarget(m, foes, board, allies = null, firstTurn = false) {
    const partner = allies && m.u.allyHits ? this.partnerOf(m, allies) : null;
    const first = firstTurn && m.k.firstImpression >= 0 && !foes.some((f) => alive(f) && f.k.priorityBlock) ? m.k.firstImpression : -1;
    let best = null;
    let bestScore = -1;
    for (const foe of foes) {
      if (!alive(foe)) continue;
      let hit = this.strike(m.u, foe.u, board, m.atk, m.spa, false, m.burn);
      if (partner && hit.frac > 0 && m.u.moves[hit.slot].allyHit) hit = this.spareThePartner(m, foe, hit, foes, partner, board);
      if (first >= 0) hit = this.better(hit, this.hitOn(m, foe, first, board, false));
      if (hit.frac <= 0) continue;
      const score = this.hitScore(hit.frac, foe);
      if (score > bestScore) {
        bestScore = score;
        best = { foe, hit };
      }
    }
    return best;
  }

  /**
   * A move that also hits the partner (Earthquake next to a grounded partner) is kept only when
   * what it does to the foes is worth more than what it does to the partner; otherwise the
   * best attack that leaves the partner alone (NO_HIT when there is none).
   */
  spareThePartner(m, foe, hit, foes, partner, board) {
    const own = this.hitOn(m, partner, hit.slot, board, false).frac;
    if (own <= 0) return hit;
    const worth = (h) => {
      if (h.frac <= 0) return 0;
      let value = this.hitScore(h.frac, foe);
      if (h.spread) for (const other of foes) if (alive(other) && other !== foe) value += this.hitScore(this.hitOn(m, other, h.slot, board, false).frac, other);
      return value;
    };
    const safe = this.strike(m.u, foe.u, board, m.atk, m.spa, true, m.burn);
    return worth(hit) - this.hitScore(own, partner) > worth(safe) ? hit : safe;
  }

  /** What a planned attack is worth: the target's share, plus the other foes a spread move hits. */
  attackValue(m, pick, foes, board, helped = false) {
    const hit = helped ? this.hitOn(m, pick.foe, pick.hit.slot, board, true) : pick.hit;
    let value = this.hitScore(hit.frac, pick.foe);
    if (hit.spread) for (const other of foes) if (alive(other) && other !== pick.foe) value += this.hitScore(this.hitOn(m, other, hit.slot, board, helped).frac, other);
    return value;
  }

  meanSpeed(list, board) {
    let sum = 0;
    let n = 0;
    for (const m of list) {
      if (!alive(m)) continue;
      sum += this.speed(m, board);
      n += 1;
    }
    return n ? sum / n : 0;
  }

  /** A single-target move after a Follow Me / Rage Powder goes to the redirector. */
  redirected(m, target, redirector) {
    if (!redirector || redirector.out || redirector === target) return target;
    if (redirector.k.rage && m.u.grass) return target;
    return redirector;
  }

  /**
   * Whether a status move of this Pokémon can affect that one: Good as Gold and Magic Bounce stop
   * it, a Prankster status move fails on a Dark type and on a side with Armor Tail / Dazzling /
   * Queenly Majesty, Soundproof stops sound moves.
   */
  canStatus(m, target, info, foes) {
    if (!alive(target) || target.k.statusProof) return false;
    if (m.k.prankster && (target.k.dark || foes.some((f) => alive(f) && f.k.priorityBlock))) return false;
    return !(info?.sound && target.k.soundProof);
  }

  /** Whether a spread Speed drop is worth using: it lowers a foe, and it does not hit the partner. */
  speedDropUseful(m, mine, foes, board) {
    const slot = m.k.speedDrop;
    if (m.u.moves[slot].allyHit) {
      const partner = this.partnerOf(m, mine);
      if (partner && this.hitOn(m, partner, slot, board, false).frac > 0) return false;
    }
    return foes.some((foe) => alive(foe) && !foe.k.statProof && !foe.k.secondaryProof && this.hitOn(m, foe, slot, board, false).frac > 0);
  }

  /** The foe to put to sleep: the one that hurts us most (their Tailwind / Trick Room setter first). */
  sleepTarget(m, foes, mine, board) {
    const info = m.u.moves[m.k.sleep];
    let best = null;
    let bestScore = -1;
    for (const foe of foes) {
      if (!this.canStatus(m, foe, info, foes) || foe.idle > 0 || foe.sleep || foe.burn || foe.k.sleepProof) continue;
      if (m.k.powder && foe.k.powderProof) continue;
      if (foe.u.grounded && (board.t === ELECTRIC || board.t === MISTY)) continue;
      const score = (foe.k.tailwind || foe.k.trickRoom ? 1 : 0) + this.threatTo(foe, mine, board);
      if (score > bestScore) {
        bestScore = score;
        best = foe;
      }
    }
    return best;
  }

  /**
   * Taunt: worth most on a foe about to set Trick Room (when its side is slower) or Tailwind,
   * then on sleep and other support moves, and only when Taunt goes first.
   */
  tauntTarget(m, foes, board, foeSlower) {
    const pr = m.k.prankster ? 1 : 0;
    const sp = this.speed(m, board);
    const first = (foe) => pr > (foe.k.prankster ? 1 : 0) || (pr === (foe.k.prankster ? 1 : 0) && sp > this.speed(foe, board));
    const info = m.u.moves[m.k.taunt];
    let best = null;
    for (const foe of foes) {
      if (!this.canStatus(m, foe, info, foes) || foe.k.tauntProof) continue;
      let value = 0;
      if (foe.k.trickRoom && foeSlower) value = 3;
      else if (foe.k.tailwind && !board.tw[foe.s] && first(foe)) value = 2.5;
      else if (foe.k.sleep >= 0 && first(foe)) value = 1.2;
      else if ((foe.k.lowers.some((slot) => !foe.u.moves[slot].damaging) || foe.k.wisp >= 0) && first(foe)) value = 0.6;
      if (value > (best?.value || 0)) best = { foe, value };
    }
    return best;
  }

  /**
   * Encore only works on a Pokémon that has already moved this turn, and only hurts one that
   * used a status move or Fake Out (it is then stuck with a move that does nothing).
   */
  encoreTarget(m, foes, board) {
    const pr = m.k.prankster ? 1 : 0;
    const sp = this.speed(m, board);
    const before = (foe, foePr) => foePr > pr || (foePr === pr && this.speed(foe, board) > sp);
    const info = m.u.moves[m.k.encore];
    let best = null;
    for (const foe of foes) {
      if (!this.canStatus(m, foe, info, foes) || foe.k.tauntProof) continue;
      let value = 0;
      if (foe.k.fakeOut >= 0) value = 1.5;
      else if (foe.k.helpingHand || foe.k.redirect) value = 1;
      else if (foe.k.tailwind && !board.tw[foe.s] && before(foe, foe.k.prankster ? 1 : 0)) value = 1.2;
      if (value > (best?.value || 0)) best = { foe, value };
    }
    return best;
  }

  /**
   * An Attack / Sp. Atk drop: what it saves over the next two turns (the target's best hit into
   * us, less what the lower stage leaves), plus the damage when it is an attack. A Defiant or
   * Competitive target makes it a bad idea. Returns { value, target } (target null for spread).
   */
  lowerPlan(m, slot, mine, foes, board) {
    const info = m.u.moves[slot];
    const drop = info.drop;
    const worth = (foe) => {
      if (!alive(foe) || foe.k.statProof) return 0;
      if (info.damaging ? foe.k.secondaryProof : !this.canStatus(m, foe, info, foes)) return 0;
      if (LOWERED_STAT_BOOST[compact(foe.u.mon.ability)]) return -2;
      let saved = 0;
      for (const own of mine) {
        if (!alive(own)) continue;
        const hit = this.strike(foe.u, own.u, board, foe.atk, foe.spa, false, foe.burn);
        if (hit.frac <= 0) continue;
        const move = foe.u.moves[hit.slot];
        let cut = 0;
        if (move.physical && drop[0] < 0 && !foe.k.hyperCutter) cut = 1 - stageFactor(clampStage(foe.atk + drop[0])) / stageFactor(foe.atk);
        if (move.special && drop[1] < 0) cut = 1 - stageFactor(clampStage(foe.spa + drop[1])) / stageFactor(foe.spa);
        saved = Math.max(saved, Math.min(hit.frac, own.hp) * cut * 2);
      }
      const damage = info.damaging ? this.hitScore(this.hitOn(m, foe, slot, board, false).frac, foe) : 0;
      return saved + damage;
    };
    if (info.spread) {
      let value = 0;
      for (const foe of foes) value += worth(foe);
      return { value, target: null };
    }
    let best = { value: 0, target: null };
    for (const foe of foes) {
      const value = worth(foe);
      if (value > best.value) best = { value, target: foe };
    }
    return best;
  }

  /** Will-O-Wisp: halves the target's physical damage for the next two turns, plus the burn's chip. */
  burnPlan(m, mine, foes, board) {
    const info = m.u.moves[m.k.wisp];
    let best = { value: 0, target: null };
    for (const foe of foes) {
      if (!this.canStatus(m, foe, info, foes) || foe.k.burnProof || foe.burn || foe.sleep) continue;
      let saved = 0;
      for (const own of mine) {
        if (!alive(own)) continue;
        const hit = this.strike(foe.u, own.u, board, foe.atk, foe.spa, false, false);
        if (hit.frac > 0 && foe.u.moves[hit.slot].physical) saved = Math.max(saved, Math.min(hit.frac, own.hp) * 0.5 * 2);
      }
      const value = saved + 0.12;
      if (saved > 0 && value > best.value) best = { value, target: foe };
    }
    return best;
  }

  /** One side's turn-1 plan: one action per lead. */
  planSide(s, active, board, slower) {
    const mine = active[s];
    const foes = active[1 - s];
    const foeBlocks = foes.some((f) => alive(f) && f.k.priorityBlock);
    const partners = mine.filter(alive).length;
    const plan = [];
    const faked = [];
    let tailwindTaken = board.tw[s] > 0;
    let roomTaken = false;
    let redirectTaken = false;
    // The plays that decide the turn: Fake Out, Tailwind, Trick Room.
    for (const m of mine) {
      if (!alive(m)) continue;
      const k = m.k;
      const a = { m, s, kind: 0, pr: 0, sp: this.speed(m, board), value: 0, target: null, hit: null, slot: -1, move: "" };
      plan.push(a);
      if (k.fakeOut >= 0 && !foeBlocks) {
        let target = null;
        let targetScore = -1;
        for (const foe of foes) {
          if (!alive(foe) || faked.includes(foe) || foe.k.flinchProof) continue;
          // No damage means no flinch: a Ghost type, or a grounded target under Psychic Terrain.
          if (this.hitOn(m, foe, k.fakeOut, board, false).frac <= 0) continue;
          const score = (foe.k.tailwind || foe.k.trickRoom ? 10 : 0) + this.threatTo(foe, mine, board);
          if (score > targetScore) {
            targetScore = score;
            target = foe;
          }
        }
        if (target) {
          faked.push(target);
          Object.assign(a, { kind: FAKE_OUT, target, pr: 3, value: 1 + targetScore, move: "Fake Out" });
          continue;
        }
      }
      if (k.tailwind && !tailwindTaken) {
        tailwindTaken = true;
        Object.assign(a, { kind: TAILWIND, pr: k.prankster ? 1 : 0, value: 3, move: "Tailwind" });
        continue;
      }
      if (k.trickRoom && !roomTaken && slower[s]) {
        roomTaken = true;
        Object.assign(a, { kind: TRICK_ROOM, pr: k.prankster ? -6 : -7, value: 3, move: "Trick Room" });
      }
    }
    // The rest: Taunt on their speed control, redirection, sleep, a Speed drop, else the best of
    // an attack, a stat drop, Will-O-Wisp, Encore and Taunt.
    const status = (m, slot) => (m.k.prankster ? 1 : 0) + (m.u.moves[slot]?.priority || 0);
    for (const a of plan) {
      if (a.kind) continue;
      const m = a.m;
      const k = m.k;
      const partnerSetsUp = plan.some((b) => b !== a && (b.kind === TAILWIND || b.kind === TRICK_ROOM));
      const taunt = k.taunt >= 0 ? this.tauntTarget(m, foes, board, slower[1 - s]) : null;
      if (taunt && taunt.value >= 2) {
        Object.assign(a, { kind: TAUNT, target: taunt.foe, pr: status(m, k.taunt), value: taunt.value, move: "Taunt" });
        continue;
      }
      const sleepy = k.sleep >= 0 ? this.sleepTarget(m, foes, mine, board) : null;
      if (k.redirect && !redirectTaken && partners > 1 && (partnerSetsUp || !sleepy)) {
        redirectTaken = true;
        Object.assign(a, { kind: REDIRECT, pr: k.prankster && !k.rage ? 3 : 2, value: 1, move: k.redirect });
        continue;
      }
      if (sleepy) {
        Object.assign(a, { kind: SLEEP, target: sleepy, slot: k.sleep, pr: status(m, k.sleep), value: 1.5, move: m.u.moves[k.sleep].name });
        continue;
      }
      if (k.speedDrop >= 0 && this.meanSpeed(foes, board) > this.meanSpeed(mine, board) && this.speedDropUseful(m, mine, foes, board)) {
        Object.assign(a, { kind: SPEED_DROP, slot: k.speedDrop, pr: m.u.moves[k.speedDrop].priority, value: 1, move: m.u.moves[k.speedDrop].name });
        continue;
      }
      const pick = this.pickTarget(m, foes, board, mine, true);
      if (pick) Object.assign(a, { kind: ATTACK, target: pick.foe, hit: pick.hit, slot: pick.hit.slot, pr: pick.hit.priority, value: this.attackValue(m, pick, foes, board), move: m.u.moves[pick.hit.slot].name });
      for (const slot of k.lowers) {
        const lower = this.lowerPlan(m, slot, mine, foes, board);
        const info = m.u.moves[slot];
        if (lower.value > a.value + 1e-9 && (info.spread || lower.target)) {
          Object.assign(a, { kind: LOWER, target: lower.target, hit: null, slot, pr: info.damaging ? info.priority : status(m, slot), value: lower.value, move: info.name });
        }
      }
      if (k.wisp >= 0) {
        const burn = this.burnPlan(m, mine, foes, board);
        if (burn.target && burn.value > a.value + 1e-9) Object.assign(a, { kind: BURN, target: burn.target, hit: null, slot: k.wisp, pr: status(m, k.wisp), value: burn.value, move: m.u.moves[k.wisp].name });
      }
      if (k.encore >= 0) {
        const encore = this.encoreTarget(m, foes, board);
        if (encore && encore.value > a.value + 1e-9) Object.assign(a, { kind: ENCORE, target: encore.foe, hit: null, slot: k.encore, pr: status(m, k.encore), value: encore.value, move: "Encore" });
      }
      if (taunt && taunt.value > a.value + 1e-9) Object.assign(a, { kind: TAUNT, target: taunt.foe, hit: null, slot: k.taunt, pr: status(m, k.taunt), value: taunt.value, move: "Taunt" });
    }
    // Helping Hand: when the partner's attack gains more from it than this lead's own attack is worth.
    for (const a of plan) {
      if (!a.m.k.helpingHand || (a.kind && a.kind !== ATTACK)) continue;
      const b = plan.find((x) => x !== a && (x.kind === ATTACK || (x.kind === LOWER && x.m.u.moves[x.slot].damaging) || x.kind === SPEED_DROP));
      if (!b) continue;
      const gain = this.helpGain(b, foes, board);
      if (gain > a.value + 1e-9) Object.assign(a, { kind: HELPING_HAND, partner: b.m, target: null, hit: null, pr: 5, value: gain, move: "Helping Hand" });
    }
    for (const a of plan) if (a.kind === HELPING_HAND) plan.find((x) => x.m === a.partner).helped = true;
    return plan;
  }

  /** What Helping Hand adds to a partner's planned attack. */
  helpGain(b, foes, board) {
    const m = b.m;
    const info = m.u.moves[b.slot];
    const targets = info.spread ? foes.filter(alive) : b.target ? [b.target] : [];
    let gain = 0;
    for (const foe of targets) gain += this.hitScore(this.hitOn(m, foe, b.slot, board, true).frac, foe) - this.hitScore(this.hitOn(m, foe, b.slot, board, false).frac, foe);
    return gain;
  }

  /** What planned action x does to Pokémon `target` (0 when it cannot reach it). */
  plannedDamage(x, target, board) {
    if (x.kind === FAKE_OUT) return x.target === target ? this.hitOn(x.m, target, x.m.k.fakeOut, board, x.helped).frac : 0;
    if (x.kind !== ATTACK && x.kind !== SPEED_DROP && !(x.kind === LOWER && x.m.u.moves[x.slot].damaging)) return 0;
    const info = x.m.u.moves[x.slot];
    if (x.s !== target.s) {
      if (info.spread || x.target === target) return this.hitOn(x.m, target, x.slot, board, x.helped).frac;
      return 0;
    }
    return info.allyHit && x.m !== target ? this.hitOn(x.m, target, x.slot, board, x.helped).frac : 0;
  }

  /**
   * After both sides planned: Wide Guard and Quick Guard when what they block is worth more than
   * the lead's own action, then Protect for a lead that would still be knocked out (an attacker,
   * or a lead about to use sleep, Taunt, Encore, Will-O-Wisp or a stat drop).
   */
  planGuards(plans, board) {
    const all = [...plans[0], ...plans[1]];
    const replaceable = (a) => !a.kind || a.kind === ATTACK || a.kind === LOWER;
    this.planSideGuards(plans, board, replaceable);
    const guarded = (x, target) => {
      const g = plans[target.s].find((b) => b.kind === WIDE_GUARD || b.kind === QUICK_GUARD);
      if (!g) return false;
      const slot = x.kind === FAKE_OUT ? x.m.k.fakeOut : x.slot;
      if (g.kind === WIDE_GUARD) return Boolean(x.m.u.moves[slot]?.spread);
      return x.pr > 0 && (x.pr < g.pr || (x.pr === g.pr && x.sp < g.sp));
    };
    const protectable = (a) => replaceable(a) || a.kind === SLEEP || a.kind === TAUNT || a.kind === ENCORE || a.kind === BURN;
    for (const a of all) {
      if (!a.m.k.protect || !protectable(a)) continue;
      let incoming = 0;
      let hits = 0;
      for (const x of all) {
        if (x.m === a.m || guarded(x, a.m)) continue;
        const frac = this.plannedDamage(x, a.m, board);
        if (frac <= 0) continue;
        incoming += frac;
        hits += 1;
      }
      const sashHolds = a.m.sash && hits === 1;
      if (incoming >= a.m.hp && !sashHolds) Object.assign(a, { kind: PROTECT, pr: 4, target: null, move: "Protect" });
    }
  }

  /** Wide Guard and Quick Guard, one of each per side. */
  planSideGuards(plans, board, replaceable) {
    for (let s = 0; s < 2; s += 1) {
      const mine = plans[s];
      const foes = plans[1 - s];
      const own = mine.map((a) => a.m);
      for (const a of mine) {
        if (!replaceable(a) || (!a.m.k.wideGuard && !a.m.k.quickGuard)) continue;
        if (a.m.k.wideGuard && !mine.some((b) => b.kind === WIDE_GUARD)) {
          let blocked = 0;
          for (const x of [...foes, ...mine]) {
            const slot = x.kind === ATTACK || x.kind === SPEED_DROP || x.kind === LOWER ? x.slot : -1;
            const info = slot >= 0 ? x.m.u.moves[slot] : null;
            if (!info?.spread || (x.s === s && !info.allyHit)) continue;
            for (const target of own) if (alive(target) && target !== x.m) blocked += this.hitScore(this.plannedDamage(x, target, board), target);
          }
          if (blocked > a.value + 0.3) {
            Object.assign(a, { kind: WIDE_GUARD, pr: 3 + (a.m.k.prankster ? 1 : 0), target: null, value: blocked, move: "Wide Guard" });
            continue;
          }
        }
        if (a.m.k.quickGuard && !mine.some((b) => b.kind === QUICK_GUARD)) {
          const pr = 3 + (a.m.k.prankster ? 1 : 0);
          let blocked = 0;
          for (const x of foes) {
            if (x.pr <= 0 || !x.target || x.target.s !== s || x.pr > pr || (x.pr === pr && x.sp >= a.sp)) continue;
            if (x.kind === FAKE_OUT) blocked += Math.max(0.8, mine.find((b) => b.m === x.target)?.value || 0);
            else blocked += this.hitScore(this.plannedDamage(x, x.target, board), x.target);
          }
          if (blocked > a.value + 0.3) Object.assign(a, { kind: QUICK_GUARD, pr, target: null, value: blocked, move: "Quick Guard" });
        }
      }
    }
  }

  /** Why a status move aimed at a Pokémon fails now ("" when it lands). */
  statusBlock(a, target, board) {
    if (!alive(target)) return "gone";
    if (target.guard) return "Protect";
    if (a.pr > 0 && board.quick & (1 << target.s)) return "Quick Guard";
    return "";
  }

  /** Turn 1 for the leads: entry, then one action each. `slower[s]` = side s brought the slower Pokémon. */
  turnOne(active, board, slower, events) {
    // Entry order is by the Speed each one has as it comes in: a Mega Stone holder is still
    // its base form until it Mega-Evolves later in the turn.
    const entrants = [...active[0], ...active[1]].filter(Boolean)
      .sort((a, b) => this.entrySpeedOf(b.u) - this.entrySpeedOf(a.u) || a.s - b.s);
    for (const m of entrants) this.enter(m, active, board, events);
    board.wide = 0;
    board.quick = 0;

    const plans = [this.planSide(0, active, board, slower), this.planSide(1, active, board, slower)];
    this.planGuards(plans, board);
    const actions = orderActions([...plans[0], ...plans[1]].filter((a) => a.kind), false, 1);
    const redirector = [null, null];
    for (const a of actions) {
      const { m, s } = a;
      if (m.out || m.flinch) continue;
      if (m.idle > 0) {
        m.idle -= 1;
        continue;
      }
      const foes = active[1 - s];
      if (m.taunted && (STATUS_ACTIONS.has(a.kind) || (a.kind === LOWER && !m.u.moves[a.slot].damaging))) {
        events?.push({ s, kind: "taunted", actor: m.u, move: a.move });
        m.acted = a.kind;
        continue;
      }
      m.acted = a.kind;
      if (a.kind === PROTECT) {
        m.guard = true;
        events?.push({ s, kind: "protect", actor: m.u });
      } else if (a.kind === WIDE_GUARD) {
        board.wide |= 1 << s;
        events?.push({ s, kind: "wideguard", actor: m.u });
      } else if (a.kind === QUICK_GUARD) {
        board.quick |= 1 << s;
        events?.push({ s, kind: "quickguard", actor: m.u });
      } else if (a.kind === HELPING_HAND) {
        if (alive(a.partner)) {
          a.partner.helped = true;
          events?.push({ s, kind: "helpinghand", actor: m.u, target: a.partner.u });
        }
      } else if (a.kind === FAKE_OUT) {
        const target = a.target;
        if (target.out) continue;
        const by = target.guard ? "Protect" : board.quick & (1 << target.s) ? "Quick Guard" : "";
        if (by) {
          events?.push({ s, kind: "blocked", actor: m.u, target: target.u, move: "Fake Out", by });
          continue;
        }
        this.deal(m, target, this.hitOn(m, target, m.k.fakeOut, board), events);
        target.flinch = true;
        events?.push({ s, kind: "fakeout", actor: m.u, target: target.u });
      } else if (a.kind === TAILWIND) {
        board.tw[s] = TAILWIND_TURNS;
        events?.push({ s, kind: "tailwind", actor: m.u });
      } else if (a.kind === TRICK_ROOM) {
        board.tr = board.tr ? 0 : TRICK_ROOM_TURNS;
        board.trBy = board.tr ? s : -1;
        events?.push({ s, kind: "trickroom", actor: m.u, on: board.tr > 0 });
      } else if (a.kind === REDIRECT) {
        redirector[s] = m;
        events?.push({ s, kind: "redirect", actor: m.u, move: m.k.redirect });
      } else if (a.kind === SLEEP || a.kind === TAUNT || a.kind === ENCORE || a.kind === BURN || (a.kind === LOWER && !m.u.moves[a.slot].damaging)) {
        this.statusMove(a, active, board, redirector[1 - s], events);
      } else if (a.kind === SPEED_DROP) {
        const done = this.attack(m, null, { slot: a.slot, spread: m.u.moves[a.slot].spread }, foes, active[s], board, null, events);
        events?.push({ s, kind: "speeddrop", actor: m.u, move: a.move, targets: done.lowered.map((x) => x.m.u), own: done.own.map((x) => x.m.u) });
      } else if (a.kind === ATTACK || a.kind === LOWER) {
        const hit = a.hit || { slot: a.slot, spread: m.u.moves[a.slot].spread };
        const done = this.attack(m, a.target || foes.find(alive) || null, hit, foes, active[s], board, redirector[1 - s], events);
        const drops = [...done.lowered, ...done.own];
        if (drops.length) events?.push({ s, kind: "lower", actor: m.u, move: m.u.moves[hit.slot].name, targets: done.lowered.map((x) => x.m.u), own: done.own.map((x) => x.m.u), stats: drops[0].stats });
      }
    }
    board.wide = 0;
    board.quick = 0;
    this.endOfTurn(active, events);
  }

  /** Sleep, Taunt, Encore, Will-O-Wisp and the status stat drops (Charm, Parting Shot...). */
  statusMove(a, active, board, redirector, events) {
    const { m, s } = a;
    const info = m.u.moves[a.slot];
    const foes = active[1 - s];
    if (a.kind === LOWER && info.spread) {
      if (board.wide & (1 << (1 - s))) {
        events?.push({ s, kind: "blocked", actor: m.u, move: a.move, by: "Wide Guard" });
        return;
      }
      const lowered = [];
      for (const foe of foes) {
        if (this.statusBlock(a, foe, board) || !this.canStatus(m, foe, info, foes)) continue;
        const stats = this.lowerStats(foe, info.drop, true);
        if (stats.length) lowered.push({ u: foe.u, stats });
      }
      if (lowered.length) events?.push({ s, kind: "lower", actor: m.u, move: a.move, targets: lowered.map((x) => x.u), own: null, stats: lowered[0].stats });
      return;
    }
    // Follow Me and Rage Powder draw single-target status moves too.
    const target = this.redirected(m, a.target, redirector);
    const by = this.statusBlock(a, target, board);
    if (by === "gone") return;
    if (by) {
      events?.push({ s, kind: "blocked", actor: m.u, target: target.u, move: a.move, by });
      return;
    }
    if (!this.canStatus(m, target, info, foes)) {
      events?.push({ s, kind: "fails", actor: m.u, target: target.u, move: a.move });
      return;
    }
    if (a.kind === SLEEP) {
      if (target.sleep || target.burn || target.k.sleepProof || (m.k.powder && target.k.powderProof) || (target.u.grounded && (board.t === ELECTRIC || board.t === MISTY))) {
        events?.push({ s, kind: "fails", actor: m.u, target: target.u, move: a.move });
        return;
      }
      target.sleep = true;
      target.idle = Math.max(target.idle, m.k.sleepTurns);
      events?.push({ s, kind: "sleep", actor: m.u, target: target.u, move: a.move, value: String(m.k.sleepTurns) });
    } else if (a.kind === TAUNT) {
      if (target.k.tauntProof) return;
      target.taunted = true;
      events?.push({ s, kind: "taunt", actor: m.u, target: target.u });
    } else if (a.kind === ENCORE) {
      // Encore needs a move to repeat: it fails on a Pokémon that has not moved yet, and an
      // attack repeated changes little. A status move or Fake Out repeated does nothing.
      if (!target.acted || target.k.tauntProof) {
        events?.push({ s, kind: "encorefail", actor: m.u, target: target.u });
        return;
      }
      if (target.acted === ATTACK || target.acted === SPEED_DROP || target.acted === LOWER) return;
      target.idle = Math.max(target.idle, IDLE_TURNS);
      events?.push({ s, kind: "encore", actor: m.u, target: target.u, value: String(IDLE_TURNS) });
    } else if (a.kind === BURN) {
      if (target.burn || target.sleep || target.k.burnProof) {
        events?.push({ s, kind: "fails", actor: m.u, target: target.u, move: a.move });
        return;
      }
      target.burn = true;
      events?.push({ s, kind: "burn", actor: m.u, target: target.u, move: a.move });
    } else if (a.kind === LOWER) {
      const stats = this.lowerStats(target, info.drop, true);
      if (stats.length) events?.push({ s, kind: "lower", actor: m.u, move: a.move, targets: [target.u], own: null, stats });
    }
  }

  /**
   * One attack: spread moves hit every active foe (and the partner, for Earthquake and the other
   * "every Pokémon next to the user" moves); a single-target move follows redirection or a fainted
   * target. Wide Guard stops spread moves, Quick Guard priority moves. A sure stat drop (Icy Wind,
   * Snarl) follows each landed hit. Returns the Pokémon whose stats went down: { lowered, own }.
   */
  attack(m, target, hit, foes, allies, board, redirector, events) {
    const slot = hit.slot;
    const info = m.u.moves[slot];
    const out = { lowered: [], own: [] };
    if (!info) return out;
    const wide = board.wide || 0;
    const quick = board.quick || 0;
    if (hit.spread) {
      if (wide & (1 << (1 - m.s))) events?.push({ s: m.s, kind: "blocked", actor: m.u, move: info.name, by: "Wide Guard" });
      else {
        for (const foe of foes) {
          if (!alive(foe)) continue;
          const h = this.hitOn(m, foe, slot, board);
          if (h.priority > 0 && quick & (1 << foe.s)) continue;
          if (!this.deal(m, foe, h, events)) continue;
          const stats = this.afterHit(m, foe, info);
          if (stats.length) out.lowered.push({ m: foe, stats });
        }
      }
      if (allies && info.allyHit && !(wide & (1 << m.s))) {
        for (const ally of allies) {
          if (!alive(ally) || ally === m) continue;
          if (!this.deal(m, ally, this.hitOn(m, ally, slot, board), events, true)) continue;
          const stats = this.afterHit(m, ally, info);
          if (stats.length) out.own.push({ m: ally, stats });
        }
      }
      return out;
    }
    let aim = target ? this.redirected(m, target, redirector) : null;
    if (!aim || aim.out) aim = foes.find(alive) || null;
    if (!aim) return out;
    const h = this.hitOn(m, aim, slot, board);
    if (h.priority > 0 && quick & (1 << aim.s)) {
      events?.push({ s: m.s, kind: "blocked", actor: m.u, target: aim.u, move: info.name, by: "Quick Guard" });
      return out;
    }
    if (this.deal(m, aim, h, events)) {
      const stats = this.afterHit(m, aim, info);
      if (stats.length) out.lowered.push({ m: aim, stats });
    }
    return out;
  }

  /** The end of a turn: a burn takes 1/16 of its HP. */
  endOfTurn(active, events) {
    for (const side of active) {
      for (const m of side) {
        if (!alive(m) || !m.burn) continue;
        m.hp -= 1 / 16;
        if (m.hp <= 1e-9) {
          m.hp = 0;
          m.out = true;
          events?.push({ s: m.s, kind: "burnout", actor: m.u });
        } else this.berry(m);
      }
    }
  }

  /** Empty slots take the next Pokémon from the back, which then enters (Intimidate, weather, terrain). */
  refill(active, sides, next, board) {
    for (let s = 0; s < 2; s += 1) {
      for (let slot = 0; slot < active[s].length; slot += 1) {
        const m = active[s][slot];
        if (m) {
          m.flinch = false;
          m.guard = false;
          m.helped = false;
          m.taunted = false;
          m.acted = 0;
          if (!m.out) continue;
        }
        const incoming = next[s] < sides[s].length ? sides[s][next[s]++] : null;
        active[s][slot] = incoming;
        if (incoming) this.enter(incoming, active, board, null);
      }
    }
  }

  /**
   * One game between two brings.
   * @param {object} ours    a plan from plansFor (our side)
   * @param {object} theirs  a plan from plansFor (their side)
   * @param {Map|null} memo  turn-1 outcomes by leads, for games of the same tournament team
   * @param {boolean} record return what happened on turn 1 and after it
   */
  play(ours, theirs, memo = null, record = false) {
    const sides = [
      ours.members.map((u, i) => this.fresh(u, 0, i < ours.leads)),
      theirs.members.map((u, i) => this.fresh(u, 1, i < theirs.leads)),
    ];
    const active = [sides[0].slice(0, ours.leads), sides[1].slice(0, theirs.leads)];
    const next = [ours.leads, theirs.leads];
    const slower = [ours.mean < theirs.mean, theirs.mean < ours.mean];
    let board = { w: this.fixedWeather, t: this.fixedTerrain, tw: [0, 0], tr: 0, trBy: -1, wide: 0, quick: 0 };
    const events = record ? [] : null;
    const memoKey = memo && !record ? `${ours.leadKey}|${theirs.leadKey}|${slower[0] ? 1 : slower[1] ? 2 : 0}` : "";
    const saved = memoKey ? memo.get(memoKey) : undefined;
    if (saved) {
      board = { ...saved.board, tw: [...saved.board.tw] };
      for (let s = 0; s < 2; s += 1) saved.leads[s].forEach((state, i) => Object.assign(active[s][i], state));
    } else {
      this.turnOne(active, board, slower, events);
      if (memoKey) {
        const keep = (m) => ({ hp: m.hp, spe: m.spe, atk: m.atk, spa: m.spa, sash: m.sash, berry: m.berry, out: m.out, kos: m.kos, flinch: m.flinch, guard: m.guard, intimidated: m.intimidated, idle: m.idle, sleep: m.sleep, burn: m.burn });
        memo.set(memoKey, { board: { ...board, tw: [...board.tw] }, leads: [active[0].map(keep), active[1].map(keep)] });
      }
    }
    const hpAfterTurnOne = record ? sides.map((list) => list.map((m) => Math.round(m.hp * 100))) : null;
    this.refill(active, sides, next, board);
    const boardAfterTurnOne = record ? { ...board, tw: [...board.tw] } : null;
    const after = record ? this.afterTurnOne(active, board, hpAfterTurnOne, sides) : null;

    let turn = 2;
    const actions = [];
    for (; turn <= this.turnCap; turn += 1) {
      if (!active[0].some(alive) || !active[1].some(alive)) break;
      actions.length = 0;
      let asleep = 0;
      for (let s = 0; s < 2; s += 1) {
        for (const m of active[s]) {
          if (!alive(m)) continue;
          if (m.idle > 0) {
            m.idle -= 1;
            asleep += 1;
            continue;
          }
          const pick = this.pickTarget(m, active[1 - s], board, active[s]);
          if (pick) actions.push({ m, s, target: pick.foe, hit: pick.hit, pr: pick.hit.priority, sp: this.speed(m, board) });
        }
      }
      if (!actions.length && !asleep) {
        turn = this.turnCap + 1;
        break;
      }
      orderActions(actions, board.tr > 0, turn);
      for (const a of actions) {
        if (a.m.out) continue;
        this.attack(a.m, a.target, a.hit, active[1 - a.s], active[a.s], board, null, null);
      }
      this.endOfTurn(active, null);
      if (board.tw[0]) board.tw[0] -= 1;
      if (board.tw[1]) board.tw[1] -= 1;
      if (board.tr) board.tr -= 1;
      this.refill(active, sides, next, board);
    }
    let left0 = 0;
    let left1 = 0;
    for (const m of sides[0]) left0 += m.hp;
    for (const m of sides[1]) left1 += m.hp;
    const value = Math.max(0, Math.min(100, 50 + 50 * (left0 / sides[0].length - left1 / sides[1].length)));
    if (!record) return { value };
    const fainted = (list) => list.filter((m) => m.out).length;
    return {
      value,
      events,
      after,
      board: boardAfterTurnOne,
      result: { kos: [fainted(sides[1]), fainted(sides[0])], turns: Math.min(turn, this.turnCap + 1) - 1 },
      mons: sides.map((list) => list.map((m) => ({ kos: m.kos, out: m.out, lead: m.lead }))),
    };
  }

  /** The board turn 1 left, from our side: who moves first on turn 2, Tailwind, Trick Room, field, HP, who is in. */
  afterTurnOne(active, board, hp, sides) {
    let first = 0;
    let pairs = 0;
    for (const a of active[0]) {
      if (!alive(a)) continue;
      for (const b of active[1]) {
        if (!alive(b)) continue;
        const sa = this.speed(a, board);
        const sb = this.speed(b, board);
        first += sa === sb ? 0.5 : (board.tr > 0 ? sa < sb : sa > sb) ? 1 : 0;
        pairs += 1;
      }
    }
    const share = pairs ? first / pairs : 0.5;
    const state = (m) => (m.out ? "" : m.sleep && m.idle > 0 ? "asleep" : m.idle > 0 ? "stuck" : m.burn ? "burned" : "");
    return {
      faster: share > 0.5 ? "you" : share < 0.5 ? "them" : "split",
      tailwind: { you: board.tw[0], them: board.tw[1] },
      trickRoom: board.tr,
      trickRoomBy: board.tr > 0 ? (board.trBy === 0 ? "you" : "them") : "",
      weather: WEATHERS[board.w],
      terrain: TERRAINS[board.t],
      hp: { you: hp[0], them: hp[1] },
      // Who starts turn 2 (indices into the brought lists) and any sleep, Encore or burn.
      field: { you: active[0].filter(alive).map((m) => sides[0].indexOf(m)), them: active[1].filter(alive).map((m) => sides[1].indexOf(m)) },
      status: { you: sides[0].map(state), them: sides[1].map(state) },
    };
  }

  /** A 1-on-1 on a given board from full HP: hits to KO (lowest and highest roll) both ways, then who moves first. */
  duel(o, t, board) {
    const a = this.strike(o, t, board, 0, 0);
    const b = this.strike(t, o, board, 0, 0);
    let first = 0.5;
    if (a.priority !== b.priority) first = a.priority > b.priority ? 1 : 0;
    else {
      const sa = this.speedOf(o, board.w, board.tw[0] > 0, 0);
      const sb = this.speedOf(t, board.w, board.tw[1] > 0, 0);
      if (sa !== sb) first = (board.tr > 0 ? sa < sb : sa > sb) ? 1 : 0;
    }
    const sashA = o.kit.sash;
    const sashT = t.kit.sash;
    let win = 0;
    for (const ours of [a.hi, a.lo]) {
      let x = hitsFor(ours);
      if (x === 1 && sashT) x = 2;
      for (const theirs of [b.hi, b.lo]) {
        let y = hitsFor(theirs);
        if (y === 1 && sashA) y = 2;
        win += x < y ? 1 : x > y ? 0 : x >= 99 ? 0.5 : first;
      }
    }
    return win / 4;
  }

  /**
   * A full game of just these Pokémon (all leading, no one behind): our line-up against
   * theirs. Both sides come in as plans, so the one Mega each of them commits to is already
   * settled and the cache is keyed by the forms that really play.
   */
  cellValue(ourPlan, theirPlan) {
    const key = `${ourPlan.leadKey}|${theirPlan.leadKey}`;
    let value = this.cells.get(key);
    if (value === undefined) {
      value = this.play(ourPlan, theirPlan).value;
      this.cells.set(key, value);
    }
    return value;
  }

  // --- the run ---------------------------------------------------------------------------

  /**
   * Plays the tournament teams in order and reports a fresh analysis after every batch.
   * @param {Array<object|null>} sets     our builder slots
   * @param {{limit:number, onSnapshot:(s)=>void, shouldStop:()=>boolean}} options
   */
  async run(sets, { limit = 1000, onSnapshot, shouldStop } = {}) {
    const started = Date.now();
    if (this.nextId > 40000) {
      this.monCache.clear();
      this.ourCache.clear();
      this.resetCaches();
    }
    const ours = [];
    (sets || []).slice(0, 6).forEach((set, slot) => {
      if (!set || !String(set.species || "").trim()) return;
      ours.push({ slot, set, unit: this.ourUnit(set, ours.length) });
    });
    if (!ours.length) throw new Error("Add at least one Pokémon to the team first.");
    const plans = this.plansFor(ours.map((o) => o.unit));
    const teams = this.teams(limit);
    // The line-ups of the lead matrix: every pair of ours in Doubles, every Pokémon in Singles.
    const width = Math.min(this.active, ours.length);
    const lineups = combinations(ours.length, width).map((idx) => ({ idx, plan: this.fixedPlan(idx.map((i) => ours[i].unit)) }));
    const state = {
      ours, plans, lineups,
      bringTotals: plans.map(() => ({ value: 0, picked: 0 })),
      mons: ours.map(() => ({ brought: 0, lead: 0, kos: 0, faints: 0, duel: 0, faced: 0 })),
      species: new Map(),
      pairs: new Map(),
      ourLeads: new Map(),
      archetypes: new Map(),
      turnOne: { games: 0, ourTailwind: 0, theirTailwind: 0, ourTrickRoom: 0, theirTrickRoom: 0, weFakeOut: 0, fakedOut: 0, intimidated: 0, weFirst: 0, koFor: 0, koAgainst: 0 },
      results: [],
      values: new Map(),
      games: 0,
      matrix: null,
      similar: this.similarTeam(ours),
    };
    let stopped = false;
    let batches = 0;
    for (let index = 0; index < teams.length; index += 1) {
      this.playTeam(state, teams[index]);
      const last = index === teams.length - 1;
      if ((index + 1) % BATCH === 0 || last) {
        batches += 1;
        if (batches === 1 || batches % MATRIX_EVERY === 0 || last) this.refreshMatrix(state);
        onSnapshot?.(this.snapshot(state, teams.length, started, false));
        await tick();
        if (shouldStop?.()) {
          stopped = !last;
          break;
        }
      }
    }
    if (state.matrix?.tested !== state.results.length) this.refreshMatrix(state);
    return { ...this.snapshot(state, teams.length, started, true), stopped };
  }

  /** The tournament team closest to ours, with the Stat Points its Natures go with (so it can be loaded). */
  similarTeam(ours) {
    try {
      const entries = ours.map((o) => ({ pokemon: o.set.species, form: o.set.form || o.set.species, item: o.set.item || "", moves: [...(o.set.moves || [])] }));
      const similar = mostSimilarTeam(this.known, entries);
      if (!similar) return null;
      for (const member of similar.members) {
        const spread = this.suggestions.spreadForNature(member.species, member.nature || "");
        member.bonuses = [...(spread?.bonuses || [0, 0, 0, 0, 0, 0])];
      }
      return similar;
    } catch {
      return null;
    }
  }

  /** One tournament team: every bring against every bring, then the chosen game once more with its story. */
  playTeam(state, team) {
    if (this.hits.size > MAX_CACHED_HITS) {
      this.hits.clear();
      this.best.clear();
      this.bestSafe.clear();
    }
    const theirs = team.members.map((member) => this.opponentMon(member));
    const theirPlans = this.plansFor(theirs);
    const memo = new Map();
    let best = { value: -1, mean: -1, c: 0, d: 0 };
    for (let c = 0; c < state.plans.length; c += 1) {
      let worst = 101;
      let worstD = 0;
      let sum = 0;
      for (let d = 0; d < theirPlans.length; d += 1) {
        const { value } = this.play(state.plans[c], theirPlans[d], memo);
        sum += value;
        if (value < worst) {
          worst = value;
          worstD = d;
        }
      }
      state.games += theirPlans.length;
      const mean = sum / theirPlans.length;
      state.bringTotals[c].value += worst;
      if (worst > best.value + 1e-9 || (Math.abs(worst - best.value) <= 1e-9 && (mean > best.mean + 1e-9 || (Math.abs(mean - best.mean) <= 1e-9 && c < best.c)))) {
        best = { value: worst, mean, c, d: worstD };
      }
    }
    const ourPlan = state.plans[best.c];
    const theirPlan = theirPlans[best.d];
    state.bringTotals[best.c].picked += 1;
    const game = this.play(ourPlan, theirPlan, null, true);

    // Our Pokémon in the chosen game, and the pair we lead with.
    ourPlan.order.forEach((o, i) => {
      const tally = state.mons[o];
      const mon = game.mons[0][i];
      tally.brought += 1;
      if (mon.lead) tally.lead += 1;
      tally.kos += mon.kos;
      if (mon.out) tally.faints += 1;
    });
    const ourLead = ourPlan.order.slice(0, ourPlan.leads).sort((a, b) => a - b).join(",");
    state.ourLeads.set(ourLead, (state.ourLeads.get(ourLead) || 0) + 1);
    // Their Pokémon: how often each is seen, brought against us, what it does, its sets, and our duels with it.
    const broughtBy = new Map(theirPlan.order.map((t, i) => [t, game.mons[1][i]]));
    const duelBoard = game.board;
    theirs.forEach((t, i) => {
      const row = state.species.get(t.display) || { display: t.display, species: t.species, form: t.form, item: t.item, count: 0, brought: 0, kos: 0, survived: 0, perSlot: state.ours.map(() => 0), sets: new Map() };
      row.count += 1;
      const set = row.sets.get(t.key) || { count: 0, member: team.members[i] };
      set.count += 1;
      row.sets.set(t.key, set);
      const mon = broughtBy.get(i);
      if (mon) {
        row.brought += 1;
        row.kos += mon.kos;
        if (!mon.out) row.survived += 1;
      }
      state.ours.forEach((o, slot) => {
        const win = this.duel(o.unit, t, duelBoard);
        row.perSlot[slot] += win;
        state.mons[slot].duel += win;
        state.mons[slot].faced += 1;
      });
      state.species.set(t.display, row);
    });
    // Their pairs (Doubles): the two they lead with, and every two they bring together.
    // Named by their own set (the Mega a stone holder is registered as), so the pairs, the
    // Pokémon rows and the matrix's most common sets all speak of the same Pokémon even when
    // this one bring played a holder in its base form.
    if (this.active > 1) {
      const brought = theirPlan.order.map((t) => theirs[t]);
      for (let a = 0; a < brought.length; a += 1) {
        for (let b = a + 1; b < brought.length; b += 1) {
          const [x, y] = [brought[a].display, brought[b].display].sort();
          const key = `${x}~${y}`;
          const pair = state.pairs.get(key) || { key, a: x, b: y, lead: 0, together: 0 };
          pair.together += 1;
          if (a < theirPlan.leads && b < theirPlan.leads) pair.lead += 1;
          state.pairs.set(key, pair);
        }
      }
    }
    // Turn 1.
    const t1 = state.turnOne;
    const events = game.events;
    const has = (s, kind) => events.some((e) => e.s === s && e.kind === kind);
    t1.games += 1;
    if (has(0, "tailwind")) t1.ourTailwind += 1;
    if (has(1, "tailwind")) t1.theirTailwind += 1;
    if (game.after.trickRoomBy === "you") t1.ourTrickRoom += 1;
    if (game.after.trickRoomBy === "them") t1.theirTrickRoom += 1;
    if (has(0, "fakeout")) t1.weFakeOut += 1;
    if (has(1, "fakeout")) t1.fakedOut += 1;
    if (events.some((e) => e.s === 1 && e.kind === "intimidate")) t1.intimidated += 1;
    if (game.after.faster === "you") t1.weFirst += 1;
    if (has(0, "ko")) t1.koFor += 1;
    // Losing one counts our own Earthquake knocking out our partner, too.
    if (has(1, "ko") || has(0, "partnerko")) t1.koAgainst += 1;
    // By archetype.
    const archetype = this.archetypeOf(team, theirs);
    const tally = state.archetypes.get(archetype) || { name: archetype, count: 0, value: 0, favourable: 0, even: 0, unfavourable: 0 };
    tally.count += 1;
    tally.value += best.value;
    if (best.value >= MATCHUP_BANDS.favourable) tally.favourable += 1;
    else if (best.value < MATCHUP_BANDS.unfavourable) tally.unfavourable += 1;
    else tally.even += 1;
    state.archetypes.set(archetype, tally);
    state.values.set(team.name, best.value);
    state.results.push({
      name: team.name,
      number: teamNumber(team.name),
      archetype,
      value: best.value,
      members: theirs.map(who),
      bring: best.c,
      against: theirPlan.members.map(who),
      theirLeads: theirPlan.leads,
      story: events.map((e) => ({
        side: e.s === 0 ? "you" : "them",
        kind: e.kind,
        actor: who(e.actor),
        target: e.target ? who(e.target) : null,
        targets: e.targets ? e.targets.map(who) : null,
        own: e.own?.length ? e.own.map(who) : null,
        move: e.move || "",
        value: e.value || "",
        by: e.by || "",
        stats: e.stats || null,
        on: e.on,
      })),
      after: game.after,
      result: game.result,
    });
  }

  /** A species' most common tournament set, as a unit. */
  commonSet(state, display) {
    const row = state.species.get(display);
    let best = null;
    for (const set of row.sets.values()) if (!best || set.count > best.count) best = set;
    return this.opponentMon(best.member);
  }

  /**
   * The lead matrix: rows are the pairs they lead with most (Doubles; then the pairs they bring
   * together) or their most common Pokémon (Singles); columns are our line-ups; each cell a full
   * game of just those Pokémon.
   */
  refreshMatrix(state) {
    let rows;
    if (this.active > 1) {
      rows = [...state.pairs.values()]
        .sort((x, y) => y.lead - x.lead || y.together - x.together || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
        .slice(0, MATRIX_ROWS)
        .map((pair) => {
          // A pair of two stone holders leads with one Mega and one base form, so the row
          // is the line-up that plays the cells, not the two sets on their own.
          const plan = this.fixedPlan([this.commonSet(state, pair.a), this.commonSet(state, pair.b)]);
          return { plan, lead: pair.lead, together: pair.together, weight: Math.max(pair.lead, pair.together / 6) };
        });
    } else {
      rows = [...state.species.entries()]
        .sort(([ka, a], [kb, b]) => b.count - a.count || (ka < kb ? -1 : ka > kb ? 1 : 0))
        .slice(0, MATRIX_ROWS)
        // `display` and `brought` let the snapshot quote these very cells in the Pokémon table,
        // the Trouble list and the biggest threats, so the page never contradicts itself.
        .map(([display, row]) => {
          return { display, plan: this.fixedPlan([this.commonSet(state, display)]), lead: row.brought, brought: row.brought, together: row.count, weight: row.count };
        });
    }
    const cells = rows.map((row) => state.lineups.map((line) => this.cellValue(line.plan, row.plan)));
    state.matrix = { rows, cells, tested: state.results.length };
  }

  snapshot(state, total, started, done) {
    const tested = state.results.length;
    const n = Math.max(1, tested);
    // One of our slots, by default as its own set battles. `unit` names the form it plays in
    // one particular line-up instead: a stone holder that does not Mega-Evolve there.
    const slotInfo = (o, unit = state.ours[o].unit) => (unit.stone
      ? { slot: state.ours[o].slot, species: state.ours[o].set.species, form: unit.form, item: "", stone: unit.stone }
      : { slot: state.ours[o].slot, species: state.ours[o].set.species, form: unit.form, item: state.ours[o].set.item || "" });
    // The same, for a line-up whose members are already settled (`unitAt` from the plan).
    const planInfo = (plan, list = plan.idx) => list.map((o) => slotInfo(o, plan.unitAt.get(o)));
    const doubles = this.active > 1;
    const values = state.results.map((r) => r.value);
    const average = values.reduce((a, b) => a + b, 0) / n;
    const bands = { favourable: 0, even: 0, unfavourable: 0 };
    for (const v of values) {
      if (v >= MATCHUP_BANDS.favourable) bands.favourable += 1;
      else if (v < MATCHUP_BANDS.unfavourable) bands.unfavourable += 1;
      else bands.even += 1;
    }
    const plan = (c) => ({
      members: planInfo(state.plans[c]),
      leads: planInfo(state.plans[c], state.plans[c].order.slice(0, state.plans[c].leads)),
      value: state.bringTotals[c].value / n,
      bestRate: state.bringTotals[c].picked / n,
    });
    const brings = state.plans.map((_, c) => c)
      .sort((a, b) => state.bringTotals[b].picked - state.bringTotals[a].picked || state.bringTotals[b].value - state.bringTotals[a].value || a - b);
    // The recommended bring, then the other strong choices (each the best one against some teams).
    const bestBrings = brings.slice(0, BRING_OPTIONS[this.format]).filter((c, i) => i === 0 || state.bringTotals[c].picked > 0).map(plan);

    // The lead matrix: columns sorted by how often we lead with them, then by their average.
    const m = state.matrix || { rows: [], cells: [] };
    const weightSum = m.rows.reduce((sum, row) => sum + row.weight, 0) || 1;
    const lineMean = state.lineups.map((_, c) => m.rows.reduce((sum, row, r) => sum + row.weight * m.cells[r][c], 0) / weightSum);
    const lineLeads = state.lineups.map((line) => (state.ourLeads.get(line.idx.join(",")) || 0) / n);
    const columnOrder = state.lineups.map((_, c) => c).sort((a, b) => lineLeads[b] - lineLeads[a] || lineMean[b] - lineMean[a] || a - b);
    // A line-up's members in the forms it leads with: its plan keeps them in the order its
    // own `idx` names them, so the slot and the form it plays line up one for one.
    const lineInfo = (line) => line.idx.map((o, i) => slotInfo(o, line.plan.members[i]));
    const matrix = {
      kind: doubles ? "pairs" : "single",
      columns: columnOrder.map((c) => ({ members: lineInfo(state.lineups[c]), leads: lineLeads[c], average: m.rows.length ? lineMean[c] : null })),
      rows: m.rows.map((row, r) => ({
        // The forms that play the cell's game, so a pair of two stone holders shows one Mega.
        members: row.plan.members.map(who),
        share: (doubles ? row.lead : row.together) / n,
        count: doubles ? row.lead : row.together,
        together: row.together / n,
        // Singles: how often they actually brought it against us, which is what the Pokémon
        // table's 1 vs 1 column weights these rows by. null for a pair (Doubles).
        brought: row.brought === undefined ? null : row.brought / n,
        cells: columnOrder.map((c) => m.cells[r][c]),
      })),
      tested: m.tested || 0,
    };

    const speciesRows = [...state.species.values()];
    // Singles: the 1 vs 1 game the matrix card draws for one of ours against one of theirs.
    // The Pokémon table, the Trouble list and the biggest threats all read these very cells,
    // so a "Trouble: X" never sits next to a Favoured cell for the same pair. null when that
    // Pokémon is not one of the rows the matrix holds (it keeps their most common 40).
    // Singles only: a line-up is one Pokémon of ours, so its column is that slot's column.
    const columnOf = doubles ? new Map() : new Map(state.lineups.map((line, c) => [line.idx[0], c]));
    const matrixCells = new Map();
    if (!doubles && m.rows.length) {
      m.rows.forEach((row, r) => {
        if (!row.display) return;
        for (const [o, c] of columnOf) matrixCells.set(`${row.display}|${o}`, m.cells[r][c]);
      });
    }
    const oneOnOne = (display, o) => {
      const value = matrixCells.get(`${display}|${o}`);
      return value === undefined ? null : value;
    };
    const answerOf = (row) => {
      const cells = doubles ? null : state.ours.map((_, o) => oneOnOne(row.display, o));
      if (cells && cells.every((value) => value !== null)) {
        let slot = 0;
        for (let o = 1; o < cells.length; o += 1) if (cells[o] > cells[slot]) slot = o;
        return { ...slotInfo(slot), win: row.perSlot[slot] / Math.max(1, row.count), value: cells[slot] };
      }
      let slot = 0;
      for (let o = 1; o < row.perSlot.length; o += 1) if (row.perSlot[o] > row.perSlot[slot]) slot = o;
      return { ...slotInfo(slot), win: row.perSlot[slot] / Math.max(1, row.count), value: null };
    };
    // Singles: how one of ours does over the 1 vs 1 games of the matrix, counting only the
    // Pokémon they actually brought against us and weighting each by how often they did.
    const oneOnOneScore = (o) => {
      if (doubles || !m.rows.length) return null;
      const c = columnOf.get(o);
      let sum = 0;
      let weight = 0;
      m.rows.forEach((row, r) => {
        if (!(row.brought > 0)) return;
        sum += row.brought * m.cells[r][c];
        weight += row.brought;
      });
      return weight > 0 ? sum / weight : null;
    };
    // Trouble: common enough to matter (2% of the teams, fewer early in a run).
    const minCount = Math.min(Math.max(2, Math.round(n * 0.02)), Math.max(1, ...speciesRows.map((row) => row.count)));
    // Doubles: each Pokémon of ours as one half of a lead pair, from the lead matrix.
    const pairOf = (a, b) => state.lineups.findIndex((line) => line.idx.includes(a) && line.idx.includes(b));
    const pairStats = (o) => {
      if (!doubles || !m.rows.length || state.ours.length < 2) return null;
      let best = null;
      for (let p = 0; p < state.ours.length; p += 1) {
        if (p === o) continue;
        const c = pairOf(o, p);
        if (c >= 0 && (!best || lineMean[c] > best.score)) best = { partner: p, c, score: lineMean[c] };
      }
      if (!best) return null;
      const weakPairs = m.rows.map((row, r) => ({ members: row.plan.members.map(who), value: m.cells[r][best.c], weight: row.weight }))
        .filter((row) => row.value < MATCHUP_BANDS.unfavourable)
        .sort((a, b) => a.value - b.value || b.weight - a.weight)
        .slice(0, 2)
        .map(({ weight, ...row }) => row);
      // The partner in the form it leads in beside this one: a pair of two stone holders
      // plays only one of them as its Mega, and the score comes from that game.
      const line = state.lineups[best.c];
      return { partner: slotInfo(best.partner, line.plan.members[line.idx.indexOf(best.partner)]), pairScore: best.score, weakPairs };
    };
    const pokemon = state.ours.map((_, o) => {
      const t = state.mons[o];
      // Behind in the 1 vs 1 game the matrix draws; without a cell, the quick duel's old rule.
      const weakTo = speciesRows.filter((row) => row.count >= minCount)
        .map((row) => {
          const cell = oneOnOne(row.display, o);
          const win = row.perSlot[o] / row.count;
          const value = cell === null ? win * 100 : cell;
          return { species: row.species, form: row.form, item: row.item, win, value, fromMatrix: cell !== null, weight: row.count * (1 - value / 100) };
        })
        .filter((row) => (row.fromMatrix ? row.value < MATCHUP_BANDS.unfavourable : row.win < 0.5))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 2)
        .map(({ weight, ...row }) => row);
      const pairs = pairStats(o);
      return {
        ...slotInfo(o),
        brought: t.brought / n,
        lead: t.lead / n,
        kosPerGame: t.brought ? t.kos / t.brought : 0,
        faintRate: t.brought ? t.faints / t.brought : 0,
        duel: t.faced ? t.duel / t.faced : 0,
        oneOnOne: oneOnOneScore(o),
        weakTo,
        partner: pairs?.partner || null,
        pairScore: pairs ? pairs.pairScore : null,
        weakPairs: pairs?.weakPairs || [],
      };
    });

    // Doubles: a threat's usual partner (the one it leads with most, else the one it comes with).
    const partnerOf = (display) => {
      let best = null;
      for (const pair of state.pairs.values()) {
        if (pair.a !== display && pair.b !== display) continue;
        const score = pair.lead * 6 + pair.together;
        if (!best || score > best.score) best = { display: pair.a === display ? pair.b : pair.a, score };
      }
      return best?.display || null;
    };
    const threats = [...state.species.entries()].map(([display, row]) => {
      const brought = row.brought / row.count;
      const kosPerGame = row.brought ? row.kos / row.brought : 0;
      const survived = row.brought ? row.survived / row.brought : 0;
      const answer = answerOf(row);
      const share = row.count / n;
      return { display, species: row.species, form: row.form, item: row.item, count: row.count, share, brought, kosPerGame, survived, answer, danger: share * brought * (kosPerGame + survived) };
    })
      // Nothing to warn about when one of ours simply beats it and it knocks out almost nothing.
      .filter((row) => row.brought > 0 && !((row.answer.value === null ? row.answer.win >= 0.9 : row.answer.value >= 90) && row.kosPerGame < 0.3))
      .sort((a, b) => b.danger - a.danger)
      .slice(0, 6)
      .map(({ display, ...row }) => {
        let pairAnswer = null;
        const partner = doubles && state.ours.length > 1 ? partnerOf(display) : null;
        if (partner && state.species.has(partner)) {
          const units = [this.commonSet(state, display), this.commonSet(state, partner)];
          const theirPlan = this.fixedPlan(units);
          let best = null;
          for (const line of state.lineups) {
            const value = this.cellValue(line.plan, theirPlan);
            if (!best || value > best.value) best = { members: lineInfo(line), value };
          }
          // The two of them as they stand together: only one Mega-Evolves, so `subject` says
          // which form of this very Pokémon the score belongs to.
          pairAnswer = { ...best, partner: who(theirPlan.members[1]), subject: who(theirPlan.members[0]) };
        }
        const answerBehind = pairAnswer ? pairAnswer.value < MATCHUP_BANDS.unfavourable
          : row.answer.value === null ? row.answer.win < 0.5 : row.answer.value < MATCHUP_BANDS.unfavourable;
        return { ...row, pairAnswer, level: row.kosPerGame >= 1 || answerBehind ? "high" : "medium" };
      });

    const common = [...speciesRows].sort((a, b) => b.count - a.count || a.species.localeCompare(b.species)).slice(0, 10);
    const duels = {
      columns: state.ours.map((_, o) => slotInfo(o)),
      rows: common.map((row) => ({ species: row.species, form: row.form, item: row.item, share: row.count / n, cells: row.perSlot.map((sum) => sum / row.count) })),
    };

    // By archetype, from our best matchup to our worst.
    const archetypeRows = [...state.archetypes.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const shown = archetypeRows.filter((a) => a.count / n >= 0.02 || a.count >= 5);
    const rest = archetypeRows.filter((a) => !shown.includes(a));
    if (rest.length) {
      shown.push(rest.reduce((sum, a) => ({ name: "Other", count: sum.count + a.count, value: sum.value + a.value, favourable: sum.favourable + a.favourable, even: sum.even + a.even, unfavourable: sum.unfavourable + a.unfavourable }),
        { name: "Other", count: 0, value: 0, favourable: 0, even: 0, unfavourable: 0 }));
    }
    const archetypes = shown.map((a) => ({ name: a.name, count: a.count, share: a.count / n, average: a.value / a.count, favourable: a.favourable / a.count, even: a.even / a.count, unfavourable: a.unfavourable / a.count }))
      .sort((a, b) => b.average - a.average || b.count - a.count || a.name.localeCompare(b.name));

    const t1 = state.turnOne;
    const games = Math.max(1, t1.games);
    const turnOne = { games: t1.games };
    for (const key of Object.keys(t1)) if (key !== "games") turnOne[key] = t1[key] / games;

    const brief = (r) => {
      const plan = state.plans[r.bring];
      return {
        name: r.name, number: r.number, archetype: r.archetype, value: r.value, members: r.members,
        bring: planInfo(plan, plan.order), leads: plan.leads, against: r.against, theirLeads: r.theirLeads,
        story: r.story, after: r.after, result: r.result,
      };
    };
    const ranked = [...state.results].sort((a, b) => a.value - b.value || a.number - b.number);
    // The library holds some teams more than once (the same six registered for several
    // events): list each line-up once.
    const lineUp = (r) => (r.members || []).map((x) => String(x?.form || x?.species || x || "")).sort().join("|");
    const distinct = (list, count) => {
      const seen = new Set();
      const out = [];
      for (const r of list) {
        const key = lineUp(r);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
        if (out.length >= count) break;
      }
      return out;
    };
    const hardest = distinct(ranked, 5);
    const hardSet = new Set(hardest.map(lineUp));
    const easiest = ranked.length > 5 ? distinct([...ranked].reverse().filter((r) => !hardSet.has(lineUp(r))), 3) : [];
    const similar = state.similar ? { ...state.similar, value: state.values.has(state.similar.name) ? state.values.get(state.similar.name) : null } : null;
    return {
      version: SNAPSHOT_VERSION,
      done, tested, total, library: this.known.teams.length, seconds: (Date.now() - started) / 1000,
      format: this.format, bring: Math.min(this.bring, state.ours.length), active: this.active, games: state.games,
      ours: state.ours.map((_, o) => slotInfo(o)),
      average, bands,
      bestBrings, mostBrought: bestBrings[0] || null,
      turnOne, pokemon, threats, duels, matrix, archetypes,
      hardest: hardest.map(brief),
      easiest: easiest.map(brief),
      latest: state.results.slice(-1).map(brief),
      similar,
    };
  }
}
