// Test against Tournament Teams: a fast Matchup Matrix of our team against the
// tournament teams the Companion ships (data/builder/known-teams.json).
//
// The unit is a 1-on-1 race. For one of our Pokémon and one of theirs, each side
// uses its best move (Optimize's calculation: the damage engine with items,
// Abilities, weather from Abilities and KO odds), the faster side (priority first,
// then Speed) strikes first, and whoever needs fewer hits wins. A move with a 60%
// chance to OHKO counts as an OHKO 60% of the time and a 2HKO otherwise, so every
// pairing is a win chance from 0 to 100%. That table, 6 of ours against 6 of
// theirs, is the matrix.
//
// A matchup is judged the way it is played: both sides bring 4. For our core C
// (four of our six) against their four D
//   value(C, D) = 50 + 100 x (how well C answers D - how well D answers C)
// (kept to 0..100), where "C answers D" is the average, over their four, of our
// best win chance against it. We bring the core that holds up best; they answer
// with the four that hurt it most, so the matchup is max over C of min over D,
// ties going to the core with the better average over their fours. 50 is even.

import { compact, makeMon } from "./engine.js";
import { classifyArchetype, tailwindBeneficiaries } from "./team-checks.js";
import { TeamOptimizer } from "./team-optimize.js";

const CORE_SIZE = 4;
const BATCH = 8;
export const MATCHUP_BANDS = { favourable: 55, unfavourable: 45 };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const teamNumber = (name) => Number((String(name).match(/\d+/) || [0])[0]) || 0;

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

/** Priority first, then Speed (Trick Room is not assumed). */
function strikesFirst(a, b) {
  const pa = Number.parseInt(a?.move_priority, 10) || 0;
  const pb = Number.parseInt(b?.move_priority, 10) || 0;
  if (pa !== pb) return pa > pb ? "a" : "b";
  const sa = Number(a?.attacker_speed) || 0;
  const sb = Number(b?.attacker_speed) || 0;
  if (sa === sb) return null;
  return sa > sb ? "a" : "b";
}

/** P(hits) as {hits: probability}: "60% to OHKO" is an OHKO 60% of the time and a 2HKO otherwise. */
function hitDistribution(result) {
  const hits = Number.parseInt(result?.hits, 10) || 99;
  const chance = Math.max(0, Math.min(1, Number(result?.chance) || 0));
  if (hits >= 99 || chance <= 0) return [[99, 1]];
  if (chance >= 0.999) return [[hits, 1]];
  return [[hits, chance], [hits + 1, 1 - chance]];
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
    this.fast = new TeamOptimizer(evaluation);
    this.pairCache = new Map();
    this.monCache = new Map();
    this.archetypeCache = new Map();
    const aliases = this.ev.engine.data?.usageAliases || {};
    this.usageStem = new Map(Object.entries(aliases).map(([stem, [species, form]]) => [`${compact(species)}|${compact(form)}`, stem]));
  }

  /** The tournament teams in file order (team1, team2, ...), the first `limit` of them. */
  teams(limit) {
    return [...this.known.teams].sort((a, b) => teamNumber(a.name) - teamNumber(b.name)).slice(0, Math.max(1, limit));
  }

  /** A tournament member as a calculation mon: its own set, and the Stat Points usage pairs with its Nature. */
  opponentMon(member) {
    const key = [member.species, member.form, member.item, member.ability, member.nature, (member.moves || []).join("+")].join("|");
    if (this.monCache.has(key)) return this.monCache.get(key);
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
    const entry = { key, mon, species: member.species, form: mon.form_name, item: mon.item, display: `${compact(member.species)}|${compact(mon.form_name)}` };
    this.monCache.set(key, entry);
    return entry;
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

  /** Our chance to win the 1-on-1 race to a KO. `sig` names our set, so the cache outlives a run. */
  pairWin(ours, sig, theirs) {
    const cacheKey = `${sig}>${theirs.key}`;
    const cached = this.pairCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const out = this.fast.bestForMoves(ours, theirs.mon, ours.moves);
    const inc = this.fast.bestForMoves(theirs.mon, ours, theirs.mon.moves);
    const first = strikesFirst(inc, out); // "a": they strike first, "b": we do, null: Speed tie
    let win = 0;
    for (const [ourHits, pOurs] of hitDistribution(out)) {
      for (const [theirHits, pTheirs] of hitDistribution(inc)) {
        let value;
        if (ourHits >= 99 && theirHits >= 99) value = 0.5;
        else if (first === "b") value = ourHits <= theirHits ? 1 : 0;
        else if (first === "a") value = ourHits < theirHits ? 1 : 0;
        else value = ourHits < theirHits ? 1 : ourHits === theirHits ? 0.5 : 0;
        win += pOurs * pTheirs * value;
      }
    }
    this.pairCache.set(cacheKey, win);
    return win;
  }

  /**
   * Runs the matrix team by team and reports a fresh analysis after every batch.
   * @param {Array<object|null>} sets     our builder slots
   * @param {{limit:number, onSnapshot:(s)=>void, shouldStop:()=>boolean}} options
   */
  async run(sets, { limit = 1000, onSnapshot, shouldStop } = {}) {
    const started = Date.now();
    const ours = [];
    (sets || []).slice(0, 6).forEach((set, slot) => {
      if (!set || !String(set.species || "").trim()) return;
      const mon = this.ev.teamMon(set, ours.length);
      const sig = [mon.pokemon_name, mon.form_name, mon.item, mon.ability, mon.nature_name, (mon.bonuses || []).join(","), (mon.moves || []).join("+")].join("|");
      ours.push({ slot, set, mon, sig });
    });
    if (!ours.length) throw new Error("Add at least one Pokémon to the team first.");
    if (this.pairCache.size > 200000) this.pairCache.clear();
    const size = Math.min(CORE_SIZE, ours.length);
    const cores = combinations(ours.length, size);
    const teams = this.teams(limit);
    const state = {
      ours, cores,
      coreTotals: cores.map(() => ({ value: 0, best: 0 })),
      theirCoreSets: {},
      pokemon: ours.map(() => ({ win: 0, faced: 0, best: 0, losses: new Map() })),
      species: new Map(),
      archetypes: new Map(),
      results: [],
      histogram: Array(10).fill(0),
    };
    let stopped = false;
    for (let index = 0; index < teams.length; index += 1) {
      this.playTeam(state, teams[index]);
      if ((index + 1) % BATCH === 0 || index === teams.length - 1) {
        onSnapshot?.(this.snapshot(state, teams.length, started, false));
        await tick();
        if (shouldStop?.()) {
          stopped = index < teams.length - 1;
          break;
        }
      }
    }
    return { ...this.snapshot(state, teams.length, started, true), stopped };
  }

  /** One tournament team: its 6x6 matrix, every core's value, and the running tallies. */
  playTeam(state, team) {
    const theirs = team.members.map((member) => this.opponentMon(member));
    const matrix = state.ours.map((ours) => theirs.map((t) => this.pairWin(ours.mon, ours.sig, t)));
    // Their cores: four of their six (all six when a file lists fewer).
    const theirCores = state.theirCoreSets[theirs.length] ||= combinations(theirs.length, Math.min(CORE_SIZE, theirs.length));
    let best = { value: -1, mean: -1, core: 0, against: theirCores[0] };
    state.cores.forEach((core, c) => {
      let worst = { value: 101, against: null };
      let sum = 0;
      for (const their of theirCores) {
        let ours = 0;
        for (const t of their) {
          let answer = 0;
          for (const o of core) answer = Math.max(answer, matrix[o][t]);
          ours += answer;
        }
        let them = 0;
        for (const o of core) {
          let answer = 0;
          for (const t of their) answer = Math.max(answer, 1 - matrix[o][t]);
          them += answer;
        }
        const value = Math.max(0, Math.min(100, 50 + 100 * (ours / their.length - them / core.length)));
        sum += value;
        if (value < worst.value) worst = { value, against: their };
      }
      const mean = sum / theirCores.length;
      state.coreTotals[c].value += worst.value;
      if (worst.value > best.value + 1e-9 || (Math.abs(worst.value - best.value) <= 1e-9 && mean > best.mean)) {
        best = { value: worst.value, mean, core: c, against: worst.against };
      }
    });
    state.coreTotals[best.core].best += 1;
    for (const o of state.cores[best.core]) state.pokemon[o].best += 1;
    state.ours.forEach((_, o) => {
      const tally = state.pokemon[o];
      theirs.forEach((t, i) => {
        tally.win += matrix[o][i];
        tally.faced += 1;
        const loss = tally.losses.get(t.display) || { species: t.species, form: t.form, item: t.item, weight: 0, count: 0 };
        loss.weight += 1 - matrix[o][i];
        loss.count += 1;
        tally.losses.set(t.display, loss);
      });
    });
    theirs.forEach((t, i) => {
      const bestAnswer = Math.max(...state.ours.map((_, o) => matrix[o][i]));
      const answerSlot = state.ours.findIndex((_, o) => matrix[o][i] === bestAnswer);
      const row = state.species.get(t.display) || { species: t.species, form: t.form, item: t.item, count: 0, answer: 0, perSlot: state.ours.map(() => 0), answerBy: state.ours.map(() => 0) };
      row.count += 1;
      row.answer += bestAnswer;
      state.ours.forEach((_, o) => { row.perSlot[o] += matrix[o][i]; });
      row.answerBy[answerSlot] += 1;
      state.species.set(t.display, row);
    });
    state.histogram[Math.min(9, Math.floor(best.value / 10))] += 1;
    const archetype = this.archetypeOf(team, theirs);
    const tally = state.archetypes.get(archetype) || { name: archetype, count: 0, value: 0, favourable: 0, unfavourable: 0 };
    tally.count += 1;
    tally.value += best.value;
    if (best.value >= MATCHUP_BANDS.favourable) tally.favourable += 1;
    else if (best.value < MATCHUP_BANDS.unfavourable) tally.unfavourable += 1;
    state.archetypes.set(archetype, tally);
    state.results.push({ name: team.name, number: teamNumber(team.name), archetype, value: best.value, core: best.core, against: best.against, members: theirs.map((t) => ({ species: t.species, form: t.form, item: t.item })) });
  }

  snapshot(state, total, started, done) {
    const tested = state.results.length;
    const n = Math.max(1, tested);
    const values = state.results.map((r) => r.value);
    const average = values.reduce((a, b) => a + b, 0) / n;
    const bands = {
      favourable: values.filter((v) => v >= MATCHUP_BANDS.favourable).length,
      even: values.filter((v) => v < MATCHUP_BANDS.favourable && v >= MATCHUP_BANDS.unfavourable).length,
      unfavourable: values.filter((v) => v < MATCHUP_BANDS.unfavourable).length,
    };
    const slotInfo = (o) => ({ slot: state.ours[o].slot, species: state.ours[o].set.species, form: state.ours[o].mon.form_name, item: state.ours[o].set.item || "" });
    const cores = state.cores.map((core, c) => ({ members: core.map(slotInfo), value: state.coreTotals[c].value / n, bestRate: state.coreTotals[c].best / n }))
      .sort((a, b) => b.value - a.value);
    const pokemon = state.ours.map((_, o) => {
      const tally = state.pokemon[o];
      const worst = [...tally.losses.values()].sort((a, b) => b.weight - a.weight).slice(0, 3)
        .map((l) => ({ species: l.species, form: l.form, item: l.item, win: 1 - l.weight / Math.max(1, l.count), count: l.count }));
      return { ...slotInfo(o), win: tally.win / Math.max(1, tally.faced), brought: tally.best / n, worst };
    }).sort((a, b) => b.win - a.win);
    const speciesRows = [...state.species.values()];
    const threats = speciesRows.map((row) => {
      const answer = row.answer / row.count;
      const by = row.answerBy.indexOf(Math.max(...row.answerBy));
      return { species: row.species, form: row.form, item: row.item, count: row.count, share: row.count / n, answer, answerBy: slotInfo(by), index: row.count * (1 - answer) };
    }).sort((a, b) => b.index - a.index).slice(0, 8);
    const columns = [...speciesRows].sort((a, b) => b.count - a.count).slice(0, 12);
    const matrix = {
      columns: columns.map((row) => ({ species: row.species, form: row.form, item: row.item, count: row.count, share: row.count / n })),
      rows: state.ours.map((_, o) => ({ ...slotInfo(o), cells: columns.map((row) => row.perSlot[o] / row.count) })),
    };
    const brief = (r) => ({ name: r.name, number: r.number, archetype: r.archetype, value: r.value, members: r.members, core: state.cores[r.core].map(slotInfo), against: (r.against || []).map((t) => r.members[t]) });
    const ranked = [...state.results].sort((a, b) => a.value - b.value);
    return {
      done, tested, total, seconds: (Date.now() - started) / 1000,
      coreSize: state.cores[0]?.length || 0,
      ours: state.ours.map((_, o) => slotInfo(o)),
      average, bands, histogram: [...state.histogram],
      bestCores: cores.slice(0, 5),
      worstCores: cores.length > 5 ? cores.slice(-5).reverse() : [],
      mostBrought: [...cores].sort((a, b) => b.bestRate - a.bestRate)[0] || null,
      pokemon, threats, matrix,
      archetypes: [...state.archetypes.values()].map((a) => ({ name: a.name, count: a.count, share: a.count / n, average: a.value / a.count, favourable: a.favourable / a.count, unfavourable: a.unfavourable / a.count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      hardest: ranked.slice(0, 5).map(brief),
      easiest: ranked.slice(-5).reverse().map(brief),
      latest: state.results.slice(-6).reverse().map(brief),
      pairs: this.pairCache.size,
    };
  }
}
