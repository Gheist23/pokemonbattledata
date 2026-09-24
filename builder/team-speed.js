// Speed Control, ported from the Companion app (TeamAnalysisPanel.speed_control).
//
// The app builds the Speed score in layers; each method below is one of them,
// called in the same order:
//   v42   Trick Room / opposing Tailwind / raw Speed / priority against the Top-X
//   v44   priority sub-score and the first composite
//   v51   Standard Speed recomputed from raw Speed with six-slot scaling
//   v65   speed-disruption moves (Icy Wind, Electroweb, Thunder Wave, ...)
//   v67   priority folded into Standard Speed
//   v68   the disruption lines with the paralysis wording
//   v101  Exclude Pokemon applied to the team (the caller passes the filtered team)
//   v358  condition-aware Speed Abilities (Swift Swim with a Rain setter, Unburden)
//   v465  a real Trick Room team is scored under its own Trick Room
//   V494  that Trick Room score is the measured coverage, gated by setter reliability -
//         no flat points for owning the setters or for being slow
//   V512  that measured number is one of three parts again: a Trick Room team keeps
//         Standard Speed and Opposing Speed Control beside it
//   team_strategy  Trick Room scoring only when slow attackers back it up; a
//         redundant setter costs 8
// The payload then scales the score by active slots / 6 (v47).

import { pyFixed } from "./engine.js";
import { classifyArchetype } from "./team-checks.js";

const TEAM_SIZE = 6;

function clamp(value, low = 0, high = 100) {
  const v = Number(value);
  return Math.max(low, Math.min(high, Number.isFinite(v) ? v : 0));
}

function roundInt(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python f"{x:g}" for the small values used here. */
function pyG(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return String(Number(n.toPrecision(6)));
}

function pyTitle(text) {
  return String(text).replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const V358_SPEED_ABILITIES = {
  "swift swim": ["Swift Swim", "Rain", 2.0],
  chlorophyll: ["Chlorophyll", "Sun", 2.0],
  "sand rush": ["Sand Rush", "Sand", 2.0],
  "slush rush": ["Slush Rush", "Snow", 2.0],
  "surge surfer": ["Surge Surfer", "Electric Terrain", 2.0],
};
const V358_FIELD_SETTER_ABILITIES = {
  drizzle: "Rain", drought: "Sun", "orichalcum pulse": "Sun", "sand stream": "Sand", "snow warning": "Snow",
  "electric surge": "Electric Terrain", "hadron engine": "Electric Terrain",
};
const V358_FIELD_SETTER_MOVES = {
  "rain dance": "Rain", "sunny day": "Sun", sandstorm: "Sand", snowscape: "Snow", "chilly reception": "Snow", "electric terrain": "Electric Terrain",
};
const PARALYSIS_MOVES = new Set(["Thunder Wave", "Nuzzle", "Glare", "Stun Spore"]);

/**
 * V512, `score_composition_v512.TRICK_ROOM_WEIGHTS`: [trick_room, opposing_tailwind, standard].
 *
 * The general path finishes with `standard * 0.46 + opposing_tailwind * 0.27 + trick_room * 0.27`
 * (v67 and v358). These are the same three weights with the leading slot given to the axis the
 * team actually plays, so neither path is the more generous one - only the order changes. It is
 * also the answer to "a Trick Room team must not be punished for being slow": the general path
 * would charge it 0.46 for a Standard Speed it has deliberately not built, and here that is 0.27
 * while the number it has built carries 0.46.
 */
export const TRICK_ROOM_WEIGHTS = [0.46, 0.27, 0.27];

/**
 * team_evaluation_v465.trick_room_speed_metrics, as V494 left it
 * (_v494_trick_room_speed_metrics, the app's final binding of the name).
 *
 * v465 scored `coverage * 78 + setter_reliability * 15 + slow_share * 7`, so a Trick Room
 * team collected up to 22 points for merely owning the setters and for being slow, whatever
 * those slow Pokemon actually achieved against the meta. V494 replaced the composite: the
 * score is the measured coverage - the share of selected Top-X speed matchups the team wins
 * under its own Trick Room, and the one number the summary line prints beside it - gated by
 * whether the team can reliably get Trick Room up at all. `slow_share` is reported but no
 * longer paid for, and a team with no setter scores 0 however slow it is.
 *
 * The other four fields are still v465's, and V494 reads the rounded percentages back out of
 * them, so the score is computed from `coverage` and `setter_reliability` as returned.
 */
export function trickRoomSpeedMetrics(ownSpeeds, metaSpeeds, setters, slowAttackers, teamSize) {
  const own = ownSpeeds.map(([n, s]) => [String(n), Number(s)]).filter(([, s]) => s > 0);
  const meta = metaSpeeds.map(([n, s]) => [String(n), Number(s)]).filter(([, s]) => s > 0);
  if (!own.length || !meta.length) return { score: 0, coverage: 0, setter_reliability: 0, slow_share: 0, lines: [] };
  const perMon = [];
  let favorableTotal = 0;
  for (const [name, speed] of own) {
    const favorable = meta.filter(([, ms]) => speed < ms).length;
    favorableTotal += favorable;
    perMon.push([name, speed, favorable]);
  }
  const coverage = favorableTotal / Math.max(1, own.length * meta.length);
  const reliability = setters >= 2 ? 1.0 : setters === 1 ? 0.72 : 0.0;
  const size = Math.max(1, Math.trunc(teamSize || own.length));
  const slowShare = Math.min(1.0, Math.max(0.0, slowAttackers / size));
  const lines = [...perMon]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, speed, favorable]) => `${name}: Speed ${roundInt(speed)} acts before ${favorable}/${meta.length} Top Meta Pokemon under Trick Room`);
  lines.unshift(`${setters} Trick Room setter${setters !== 1 ? "s" : ""}; ${slowAttackers}/${size} slow attackers`);
  const r2 = (x) => Number(pyFixed(x, 2));
  const metrics = { score: 0, coverage: r2(coverage * 100), setter_reliability: r2(reliability * 100), slow_share: r2(slowShare * 100), lines };
  // V494: coverage carries the score on its own, scaled by how reliably Trick Room goes up.
  const shown = metrics.coverage / 100;
  const gate = metrics.setter_reliability / 100;
  metrics.score = r2(Math.max(0, Math.min(100, shown * 100 * gate)));
  return metrics;
}

/** team_strategy.room_plan: is Trick Room backed by slow attackers? */
export function roomPlan(profiles, metaSpeeds) {
  const speeds = metaSpeeds.map(([, s]) => Number(s)).filter((s) => s > 0);
  const threshold = median(speeds.length ? speeds : [130.0]);
  let setters = 0;
  let beneficiaries = 0;
  let attackers = 0;
  for (const profile of profiles) {
    const moves = new Set([...(profile.move_keys || [])].map((m) => String(m).toLowerCase().replace(/[^a-z0-9]/g, "")));
    if (moves.has("trickroom")) setters += 1;
    const damage = Boolean(profile.has_damage || profile.damage_pressure || profile.damaging_count);
    if (damage) {
      attackers += 1;
      const speed = Number(profile.effective_speed ?? profile.speed ?? 0) || 0;
      if (speed > 0 && speed < threshold * 0.8 && (profile.damaging_count ?? 2) >= 2) beneficiaries += 1;
    }
  }
  const supported = beneficiaries >= 2 && beneficiaries >= attackers / 2;
  return { setters, beneficiaries, supported, redundant: !supported ? Math.max(0, setters - 1) : 0 };
}

export class TeamSpeed {
  /**
   * @param {TeamEvaluator} evaluator
   * @param {TeamChecks} checks
   * @param {TeamSynergy} synergy  its profiles and meta speeds feed the Trick Room plan
   */
  constructor(evaluator, checks, synergy) {
    this.ev = evaluator;
    this.checks = checks;
    this.synergy = synergy;
    const tables = evaluator.engine.data?.analysisTables || {};
    this.priorityNames = new Set(tables.PRIORITY_MOVE_NAMES || []);
    this.dropStage = tables.SPEED_DROP_STAGE_BY_MOVE_V65 || {};
  }

  moveRecord(move) {
    return this.ev.engine.moves[this.ev.engine.canonicalMoveName(move)] || this.ev.engine.moves[move] || null;
  }

  /** _v35_priority_moves: priority moves (Protect aside), sorted case-insensitively. */
  priorityMoves(moves) {
    const out = new Set();
    for (const move of moves || []) {
      const name = String(move ?? "").trim();
      if (!name || name === "Protect") continue;
      const record = this.moveRecord(name);
      const priority = Number.parseInt(record?.analysis?.priority ?? record?.priority ?? 0, 10) || 0;
      if (this.priorityNames.has(name) || priority > 0) out.add(name);
    }
    return [...out].sort((a, b) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  /** _v65_is_speed_disruption_move (the app's own answer, exported per move) */
  isSpeedDisruption(move) {
    const name = String(move ?? "").trim();
    if (!name) return false;
    if (name in this.dropStage) return true;
    return Boolean(this.moveRecord(name)?.analysis?.speed_disruption);
  }

  finalSpeed(mon) {
    return Number(this.ev.engine.finalStats(mon).speed) || 0;
  }

  /** The v42 meta mons: common set, top item (its Mega), top moves. */
  v42MetaMons(topMeta) {
    const out = [];
    for (const meta of topMeta) {
      try {
        const mon = this.ev.commonMon(String(meta.name || ""), String(meta.name || ""));
        if (meta.top_item) {
          mon.item = String(meta.top_item);
          if (this.ev.engine.isMegaStone(mon.item)) mon.form_name = this.ev.megaFormForItem(mon.pokemon_name, mon.item);
        }
        mon.moves = ((meta.moves || []).length ? meta.moves : mon.moves || []).slice(0, 6);
        mon.analysis_side = "threat";
        out.push(mon);
      } catch {
        // skipped, as in the app
      }
    }
    return out;
  }

  /** The v51 meta mons: common set with its top item, Mega only for a matching stone. */
  v51MetaMons(topMeta) {
    const out = [];
    for (const meta of topMeta) {
      const name = String(meta.name || "").trim();
      if (!name) continue;
      try {
        const mon = this.ev.commonMon(name, name);
        const item = String(meta.top_item || (meta.top_items || [])[0] || "");
        if (item) {
          mon.item = item;
          const species = String(mon.pokemon_name || "");
          if (this.ev.stoneMatchesSpecies(species, item)) {
            const form = String(this.ev.megaFormForItem(species, item) || species).trim();
            if (form && form.toLowerCase().replace(/[^a-z0-9]/g, "") !== species.toLowerCase().replace(/[^a-z0-9]/g, "")) {
              mon.form_name = form;
              mon.ability = this.ev.megaAbility(species, form, mon.ability);
            }
          }
        }
        mon.analysis_side = "threat";
        out.push(mon);
      } catch {
        // skipped, as in the app
      }
    }
    return out;
  }

  /** v42 (+ v44): the four sub-scores against the Top-X. */
  v42(team) {
    const topMeta = this.ev.topMeta(this.ev.settings.top_meta);
    const teamMons = team.map(({ mon }) => mon);
    const metaMons = this.v42MetaMons(topMeta);
    const moveNames = (mon) => new Set((mon.moves || []).map((m) => String(m).trim()).filter(Boolean));
    const trickUsers = metaMons.filter((m) => moveNames(m).has("Trick Room"));
    const tailwindUsers = metaMons.filter((m) => moveNames(m).has("Tailwind"));
    const metaSpeeds = metaMons.map((m) => this.finalSpeed(m));
    const avg = metaSpeeds.reduce((s, v) => s + v, 0) / Math.max(1, metaSpeeds.length);
    const metaCount = Math.max(1, metaSpeeds.length);

    const priorityMoves = [];
    const priorityLines = [];
    const seenPriority = new Set();
    for (const mon of teamMons) {
      const own = this.priorityMoves(mon.moves);
      if (own.length) priorityLines.push(`${this.ev.display(mon)}: ${own.join(", ")}`);
      for (const move of own) {
        const k = move.trim().toLowerCase();
        if (k && !seenPriority.has(k)) {
          seenPriority.add(k);
          priorityMoves.push(move);
        }
      }
    }
    const ownTrickRoom = teamMons.some((m) => moveNames(m).has("Trick Room"));
    const ownTailwind = teamMons.some((m) => moveNames(m).has("Tailwind"));
    const trickLines = [];
    const tailwindLines = [];
    const standardLines = [];
    let trOhkos = 0;
    let twOhkos = 0;
    let outspeedTotal = 0;
    for (const mon of teamMons) {
      const speed = this.finalSpeed(mon);
      const own = this.priorityMoves(mon.moves);
      const moves = this.ev.commonMoves(mon.pokemon_name, mon.moves, 6);
      const ohkos = (users) => users.filter((threat) => this.ev.bestAttack(mon, threat, moves).hits === 1).map((threat) => this.ev.display(threat));
      const tr = ohkos(trickUsers);
      const tw = ohkos(tailwindUsers);
      trOhkos += tr.length;
      twOhkos += tw.length;
      const outspeeds = metaSpeeds.filter((s) => speed > s).length;
      outspeedTotal += outspeeds;
      const slower = metaSpeeds.filter((s) => speed < s).length;
      const trickBits = [];
      if (tr.length) trickBits.push(`OHKOs TR users: ${tr.slice(0, 3).join(", ")}${tr.length > 3 ? ` +${tr.length - 3}` : ""}`);
      if (moveNames(mon).has("Trick Room")) trickBits.push("can reverse Trick Room");
      if (own.length) trickBits.push(`priority: ${own.slice(0, 3).join(", ")}`);
      trickBits.push(`TR speed: ${slower}/${metaCount} meta slower-matchups`);
      trickLines.push(`${this.ev.display(mon)}: ${trickBits.join(" · ")}`);
      const twBits = [];
      if (tw.length) twBits.push(`OHKOs Tailwind users: ${tw.slice(0, 3).join(", ")}${tw.length > 3 ? ` +${tw.length - 3}` : ""}`);
      if (moveNames(mon).has("Tailwind")) twBits.push("own Tailwind");
      if (moveNames(mon).has("Trick Room")) twBits.push("Trick Room answer");
      if (own.length) twBits.push(`priority: ${own.slice(0, 3).join(", ")}`);
      twBits.push(`outspeeds into opposing Tailwind: ${metaSpeeds.filter((s) => speed > s * 2).length}/${metaCount}`);
      tailwindLines.push(`${this.ev.display(mon)}: ${twBits.join(" · ")}`);
      standardLines.push(`${this.ev.display(mon)}: SPE ${speed} · outspeeds ${outspeeds}/${metaCount} meta`);
    }
    const trFactor = trickUsers.length ? Math.min(28, trOhkos * 4) : 0;
    const twFactor = tailwindUsers.length ? Math.min(28, twOhkos * 4) : 0;
    const slowTeam = teamMons.filter((m) => this.finalSpeed(m) <= avg * 0.72).length;
    const fastTeam = teamMons.filter((m) => this.finalSpeed(m) >= avg * 1.02).length;
    const trickRoom = clamp((ownTrickRoom ? 25 : 0) + slowTeam * 8 + trFactor + priorityMoves.length * 4);
    const ratio = outspeedTotal / Math.max(1, teamMons.length * metaCount);
    const standard = clamp(25 + fastTeam * 10 + Math.min(35, ratio * 70));
    const opposingTailwind = clamp((ownTailwind ? 22 : 0) + (ownTrickRoom ? 20 : 0) + twFactor + priorityMoves.length * 7);
    const speed = {
      score: 0,
      trick_room: trickRoom,
      standard,
      opposing_tailwind: opposingTailwind,
      priority: clamp(priorityMoves.length * 18),
      priority_moves: priorityMoves,
      priority_lines: priorityLines,
      summary: `Top ${topMeta.length} meta · ${trickUsers.length} TR users · ${tailwindUsers.length} Tailwind users · Avg meta SPE ${roundInt(avg)}`,
      trick_lines: trickLines,
      tailwind_lines: tailwindLines,
      standard_lines: standardLines,
      trick_users: trickUsers.map((m) => this.ev.display(m)),
      tailwind_users: tailwindUsers.map((m) => this.ev.display(m)),
    };
    // v44
    speed.priority = clamp(priorityLines.length * 13 + priorityMoves.length * 7);
    speed.score = clamp(speed.standard * 0.36 + speed.opposing_tailwind * 0.27 + speed.trick_room * 0.22 + speed.priority * 0.15);
    return speed;
  }

  /** v51: raw Standard Speed with six-slot scaling; partial teams scale the rest. */
  v51(speed, team) {
    const teamMons = team.map(({ mon }) => mon);
    const topMeta = this.ev.topMeta(this.ev.settings.top_meta);
    const metaSpeeds = this.v51MetaMons(topMeta).map((m) => this.finalSpeed(m));
    if (teamMons.length && metaSpeeds.length) {
      let total = 0;
      const lines = [];
      for (const mon of teamMons) {
        const spe = this.finalSpeed(mon);
        const outruns = metaSpeeds.filter((s) => spe > s).length;
        total += outruns;
        lines.push(`${this.ev.display(mon)}: SPE ${roundInt(spe)} · outspeeds ${outruns}/${metaSpeeds.length} meta threats`);
      }
      speed.standard = clamp((100.0 * total) / Math.max(1.0, TEAM_SIZE * metaSpeeds.length));
      speed.standard_lines = lines;
    } else {
      speed.standard = 0.0;
      speed.standard_lines = ["No active team Pokémon or meta speed data available."];
    }
    const factor = Math.max(0, Math.min(1, teamMons.length / TEAM_SIZE));
    for (const k of ["trick_room", "opposing_tailwind", "priority"]) speed[k] = clamp((Number(speed[k]) || 0) * factor);
    speed.score = clamp(speed.standard * 0.42 + speed.opposing_tailwind * 0.24 + speed.trick_room * 0.2 + speed.priority * 0.14);
    speed.summary = `Top ${this.ev.settings.top_meta} Meta - ${(speed.trick_users || []).length} Trick Room users - Standard Speed uses raw Speed only, no priority moves.`;
    return speed;
  }

  disruptionMoves(entry) {
    return (entry.moves || []).map((m) => String(m ?? "").trim()).filter((m) => m && this.isSpeedDisruption(m));
  }

  /** v65: speed-disruption moves add to Standard Speed and anti-Tailwind. */
  v65(speed, team) {
    const lines = [];
    let mons = 0;
    let total = 0;
    for (const { entry, mon } of team) {
      const moves = this.disruptionMoves(entry);
      if (!moves.length) continue;
      mons += 1;
      total += moves.length;
      const notes = moves.slice(0, 3).map((m) => (this.dropStage[m] ? `${m} (${this.dropStage[m]} Spe)` : PARALYSIS_MOVES.has(m) ? `${m} (paralysis speed control)` : m));
      lines.push(`${this.ev.display(mon)}: speed disruption - ${notes.join(", ")}`);
    }
    if (lines.length) {
      speed.standard_lines = [...(speed.standard_lines || []), ...lines];
      speed.tailwind_lines = [...(speed.tailwind_lines || []), ...lines.map((l) => `${l} helps slow faster teams after it connects`)];
      const factor = Math.max(0, Math.min(1, team.length / TEAM_SIZE));
      const bonus = Math.min(24.0, mons * 7.5 + total * 2.5) * factor;
      speed.standard = clamp(speed.standard + bonus * 0.55);
      speed.opposing_tailwind = clamp(speed.opposing_tailwind + bonus);
      speed.score = clamp(speed.standard * 0.42 + speed.opposing_tailwind * 0.24 + speed.trick_room * 0.2 + speed.priority * 0.14);
      speed.summary = `${speed.summary || ""} - ${mons} speed-disruption Pokémon`;
      speed.speed_disruption_moves = lines;
    } else if (!speed.speed_disruption_moves) speed.speed_disruption_moves = [];
    return speed;
  }

  /** v67: priority becomes a Standard Speed bonus; the priority sub-score is retired. */
  v67(speed, team) {
    const lines = (speed.priority_lines || []).map(String).filter((l) => l.trim());
    const moves = (speed.priority_moves || []).map(String).filter((m) => m.trim());
    if (lines.length) {
      speed.standard_lines = [...(speed.standard_lines || []), `Priority pressure: ${lines.slice(0, 8).join(" · ")}`];
      const factor = Math.max(0, Math.min(1, team.length / TEAM_SIZE));
      speed.standard = clamp(speed.standard + Math.min(22.0, lines.length * 5.5 + moves.length * 1.5) * factor);
    }
    speed.priority_lines = [];
    speed.priority_moves = [];
    speed.priority = 0.0;
    speed.score = clamp(speed.standard * 0.46 + speed.opposing_tailwind * 0.27 + speed.trick_room * 0.27);
    return speed;
  }

  /** v68: the same disruption lines with the paralysis wording, where not already listed. */
  v68(speed, team) {
    const extra = [];
    for (const { entry, mon } of team) {
      const moves = this.disruptionMoves(entry);
      if (!moves.length) continue;
      const notes = moves.slice(0, 4).map((m) => (this.dropStage[m] ? `${m} (${this.dropStage[m]} Spe)` : PARALYSIS_MOVES.has(m) ? `${m} (paralysis)` : m));
      const line = `${this.ev.display(mon)}: speed disruption - ${notes.join(", ")}`;
      if (!extra.includes(line)) extra.push(line);
    }
    if (extra.length) {
      const std = [...(speed.standard_lines || [])];
      const existing = std.join("\n");
      for (const line of extra) if (!existing.includes(line)) std.push(line);
      speed.standard_lines = std;
      const tw = [...(speed.tailwind_lines || [])];
      const existingTw = tw.join("\n");
      for (const line of extra) {
        const twLine = `${line} helps against faster teams after it connects`;
        if (!existingTw.includes(twLine)) tw.push(twLine);
      }
      speed.tailwind_lines = tw;
    }
    return speed;
  }

  /** v358: Speed Abilities, credited only when their condition is on the team. */
  v358(speed, team) {
    const rows = team.map(({ entry, mon }) => ({
      name: String(mon.form_name || entry.form || entry.pokemon),
      item: String(entry.item || ""),
      ability: String(mon.ability || entry.ability || ""),
      ability_key: String(mon.ability || entry.ability || "").trim().toLowerCase(),
      move_keys: new Set((entry.moves || []).map((m) => String(m ?? "").trim().toLowerCase()).filter(Boolean)),
    }));
    const setters = {};
    for (const row of rows) {
      const field = V358_FIELD_SETTER_ABILITIES[row.ability_key];
      if (field) (setters[field] ||= []).push(`${row.name}'s ${row.ability}`);
      for (const move of [...row.move_keys].sort()) {
        const f = V358_FIELD_SETTER_MOVES[move];
        if (f) (setters[f] ||= []).push(`${row.name}'s ${pyTitle(move)}`);
      }
    }
    const lines = [];
    let enabled = 0;
    for (const row of rows) {
      const k = row.ability_key;
      if (V358_SPEED_ABILITIES[k]) {
        const [abilityName, condition, multiplier] = V358_SPEED_ABILITIES[k];
        const enablers = setters[condition] || [];
        if (enablers.length) {
          enabled += 1;
          lines.push(`${row.name}: ${abilityName} reaches ${pyG(multiplier)}× Speed in ${condition} with ${enablers.slice(0, 2).join(", ")}`);
        } else lines.push(`${row.name}: ${abilityName} needs ${condition}; no setter is currently selected`);
        continue;
      }
      if (k === "speed boost") {
        enabled += 1;
        lines.push(`${row.name}: Speed Boost raises Speed after each completed turn`);
      } else if (k === "unburden") {
        enabled += 1;
        lines.push(`${row.name}: Unburden doubles Speed after ${row.item || "an item"} is consumed or lost`);
      } else if (k === "quick feet") {
        lines.push(`${row.name}: Quick Feet raises Speed only while statused`);
      } else if (["motor drive", "rattled", "weak armor", "steam engine"].includes(k)) {
        const condition = {
          "motor drive": "an Electric-type hit",
          rattled: "a Bug-, Dark-, or Ghost-type hit or Intimidate",
          "weak armor": "a physical hit",
          "steam engine": "a Fire- or Water-type hit",
        }[k];
        lines.push(`${row.name}: ${row.ability} raises Speed after ${condition}`);
      }
    }
    if (lines.length) {
      speed.standard_lines = [...lines, ...(speed.standard_lines || [])];
      speed.speed_ability_lines = lines;
      if (enabled) {
        const bonus = Math.min(22.0, enabled * 7.0);
        speed.standard = clamp(speed.standard + bonus);
        speed.opposing_tailwind = clamp(speed.opposing_tailwind + bonus * 0.45);
        speed.score = clamp(speed.standard * 0.46 + speed.opposing_tailwind * 0.27 + speed.trick_room * 0.27);
      }
    } else if (!speed.speed_ability_lines) speed.speed_ability_lines = [];
    return speed;
  }

  /** v42 through v358 in order (the app's "normal" Speed Control). */
  normal(team) {
    let speed = this.v42(team);
    speed = this.v51(speed, team);
    speed = this.v65(speed, team);
    speed = this.v67(speed, team);
    speed = this.v68(speed, team);
    return this.v358(speed, team);
  }

  /** v465's repeated-label clean-up, over the four line lists in its order. */
  static dedupeLines(speed) {
    const seen = new Set();
    for (const k of ["trick_lines", "tailwind_lines", "standard_lines", "priority_lines"]) {
      const unique = [];
      for (const line of speed[k] || []) {
        const n = String(line ?? "").trim().toLowerCase();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        unique.push(String(line));
      }
      speed[k] = unique;
    }
    return speed;
  }

  /** v465: a Trick Room archetype is scored under its own Trick Room. */
  v465(team, { profiles, features }) {
    const speed = this.normal(team);
    const [, archetype] = classifyArchetype(features);
    if (archetype !== "trick room") return TeamSpeed.dedupeLines(speed);
    const setters = Number(features.trick_room_setters) || 0;
    const ownSpeeds = profiles.filter((p) => p.has_damage || p.damage_pressure).map((p) => [String(p.name || "Pokemon"), Number(p.effective_speed ?? p.speed ?? 0) || 0]);
    const metrics = trickRoomSpeedMetrics(ownSpeeds, this.synergy.metaSpeedRows(), setters, Number(features.slow_attackers) || 0, Number(features.team) || team.length);
    if (!this.ev.scoreRules) {
      // Before V512: the measured Trick Room number was the whole score, and the other
      // three parts were written as 0 with no lines at all.
      Object.assign(speed, {
        score: metrics.score, trick_room: metrics.score, standard: 0.0, opposing_tailwind: 0.0, priority: 0.0,
        trick_lines: metrics.lines, tailwind_lines: [], standard_lines: [], priority_lines: [], speed_ability_lines: [],
        trick_users: ["Own Trick Room plan"], tailwind_users: ["Not part of Trick Room scoring"],
        archetype_speed_mode_v465: "trick_room",
        summary: `Trick Room archetype · ${pyG(metrics.coverage)}% of selected Top-X speed matchups favor your attackers under Trick Room · ${setters} setter(s).`,
      });
      return speed;
    }
    // V512 (score_composition_v512.compose_trick_room_speed): Standard Speed and Opposing
    // Speed Control keep the values and the lines the general path gave them; only Trick
    // Room is replaced by V494's measured coverage, and the score is the three weighted.
    const [trW, twW, stdW] = TRICK_ROOM_WEIGHTS;
    Object.assign(speed, {
      trick_room: clamp(metrics.score),
      trick_lines: metrics.lines.map(String),
      score: clamp(clamp(metrics.score) * trW + Number(speed.opposing_tailwind || 0) * twW + Number(speed.standard || 0) * stdW),
      archetype_speed_mode_v465: "trick_room",
      summary: `Trick Room archetype · ${pyG(metrics.coverage)}% of selected Top-X speed matchups favor your attackers under Trick Room · ${setters} setter(s). Scored as Trick Room ${pyG(trW)} · Opposing Speed Control ${pyG(twW)} · Standard Speed ${pyG(stdW)}.`,
    });
    return TeamSpeed.dedupeLines(speed);
  }

  /**
   * TeamAnalysisPanel.speed_control (team_strategy outermost).
   * @param {Array<{entry, mon}>} team  filled slots, Exclude Pokemon applied
   * @param {object} context  {profiles: synergy profiles, features: archetype features}
   */
  control(team, context) {
    const fit = roomPlan(context.profiles, this.synergy.metaSpeedRows());
    const speed = fit.supported ? this.v465(team, context) : this.normal(team);
    speed.room_plan = fit;
    if (fit.redundant) {
      speed.score = Math.max(0, speed.score - 8 * fit.redundant);
      speed.summary = `${speed.summary || ""} Extra Trick Room setters lack slow attacking partners.`;
    }
    return speed;
  }
}
