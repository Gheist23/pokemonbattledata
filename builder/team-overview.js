// Team Overview charts: the app's Team Builder dashboard (_v300_dashboard_overview,
// V302/V471). The same _v188 profiles as the Team Evaluation's Offense and Defense
// Overview, with two differences the app makes on purpose: pressure comes from
// type and power alone (use_current_team_sets=False, so a tab click never waits
// on hundreds of damage calcs), and the meta side is the Team Overview's Top-X
// (1 to every ranked Pokemon, shared with the Speed list) on each Pokemon's
// top-ranked set (_v300_meta_pressure_records).

import { SpeedTiers } from "./speed-tiers.js";
import { TYPES } from "./team-eval.js";

/** _v300_meta_pressure_records */
function metaPressureRecords(evaluation, topX) {
  const ev = evaluation.ev;
  const tiers = new SpeedTiers(ev);
  const ranked = (ev.metaRecords || []).filter((r) => Number(r.position) < 999999).slice(0, topX);
  return ranked.map((record, index) => {
    const mon = tiers.commonMetaSet(record);
    return {
      owner: index,
      name: evaluation.name(mon.form_name || mon.pokemon_name),
      pokemon: mon.pokemon_name,
      form: mon.form_name || mon.pokemon_name,
      entry_form: mon.entry_form || mon.pokemon_name,
      position: Number(record.position) || index + 1,
      types: ev.typesFor(mon),
      stats: ev.statsFor(mon),
      moves: (mon.moves || []).map((m) => String(m).trim()).filter(Boolean).slice(0, 4),
      mon,
      set_aware: true,
    };
  });
}

/** _v302_directional_type_chart: our attacking types that we carry, or how the meta hits us. */
function directionalTypeChart(teamProfile, metaProfile, direction, offense) {
  const target = offense ? metaProfile : teamProfile;
  const chart = target.defensive_type_chart || {};
  if (!offense) return Object.fromEntries(TYPES.map((type) => [type, chart[type] ?? 1]));
  const summary = direction.type_summary || {};
  let covered = false;
  const values = {};
  for (const type of TYPES) {
    if ((summary[type]?.count || 0) > 0) {
      covered = true;
      values[type] = summary[type].multiplier ?? chart[type] ?? 1;
    } else {
      values[type] = null;
    }
  }
  return covered ? values : Object.fromEntries(TYPES.map((type) => [type, chart[type] ?? 1]));
}

/**
 * @param {TeamEvaluation} evaluation
 * @param {Array<object|null>} sets  the six builder slots
 * @param {number} topX              the Team Overview's Top-X (capped at the ranked count)
 */
export function teamOverview(evaluation, sets, topX = 30) {
  const ev = evaluation.ev;
  const ranked = (ev.metaRecords || []).filter((r) => Number(r.position) < 999999).length;
  const x = Math.max(1, Math.min(Math.max(1, ranked), Number(topX) || 30));
  // _v188_team_records: every filled slot, owned by its slot number.
  const filled = (sets || []).slice(0, 6).map((set, slot) => ({ set, slot })).filter(({ set }) => set && String(set.species || "").trim());
  const teamRecords = ev.teamRecords(filled.map(({ set }, i) => ev.teamMon(set, i)));
  teamRecords.forEach((record, i) => {
    record.owner = filled[i].slot;
    record.mon.analysis_slot = filled[i].slot;
  });
  const teamProfile = ev.profile(teamRecords, "Our Team");
  const metaProfile = ev.profile(metaPressureRecords(evaluation, x), `Top ${x} Meta`);
  const teamToMeta = ev.directionalPressure(teamProfile, metaProfile, false);
  const metaToTeam = ev.directionalPressure(metaProfile, teamProfile, false);
  const weaknesses = Object.fromEntries(TYPES.map((type) => {
    const multipliers = teamRecords.map((r) => (r.types.length ? ev.engine.typeMultiplier(type, r.types) : 1));
    return [type, { weak: multipliers.filter((m) => m > 1).length, resist: multipliers.filter((m) => m < 1).length }];
  }));
  const strip = (profile) => ({
    ...profile,
    records: profile.records.map(({ mon, ...rest }) => ({ ...rest, item: mon?.item || "", ability: mon?.ability || "" })),
    damage_moves: profile.damage_moves.map(({ attacker_mon: _a, ...rest }) => rest),
  });
  return {
    empty: !teamRecords.length,
    top_x: x,
    team: strip(teamProfile),
    meta: strip(metaProfile),
    team_to_meta: teamToMeta,
    meta_to_team: metaToTeam,
    offense_chart: directionalTypeChart(teamProfile, metaProfile, teamToMeta, true),
    defense_chart: directionalTypeChart(teamProfile, metaProfile, metaToTeam, false),
    weaknesses,
  };
}
