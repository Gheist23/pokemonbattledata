// How one damage calc reads on screen, shared by the Threats list, Suggestions and
// anything else that prints a calc: "Attacker · Move" over "54.4-64.3% · Guaranteed 2HKO".

import { cleanKoLabel, displayResultCopy } from "./team-payload.js";

const hasDamage = (percent) => (String(percent || "").match(/-?\d+(?:\.\d+)?/g) || []).some((n) => Number(n) > 0);

/**
 * The damage and KO text of a result: one line, or two when a condition changes it
 * ("Sun, Blaze not triggered: 54.4-64.3% · Guaranteed 2HKO").
 * @param {object} result   a calc result (percent, label, condition_range...)
 * @param {{trueLabel?: boolean}} opts  trueLabel: the KO the attack would have if it
 *   moved first (pre_speed_tier_label), for a side that is knocked out before it attacks
 * @returns {string[]}
 */
export function calcTail(result, { trueLabel = false } = {}) {
  let data = { ...(result || {}) };
  if (trueLabel && "pre_speed_tier_label" in data) {
    data.label = data.pre_speed_tier_label;
    data.hits = data.pre_speed_tier_hits ?? data.hits;
  }
  data = displayResultCopy(data);
  const tail = (percent, label) => {
    const clean = cleanKoLabel(label);
    return percent && clean && clean.toLowerCase() !== "no damage" ? `${percent} · ${clean}` : percent || clean || "No damage";
  };
  if (data.condition_range) {
    const condition = String(data.range_max_condition || "").trim();
    const high = tail(data.range_max_percent || "0-0%", data.range_max_label);
    return [tail(data.range_min_percent || "0-0%", data.range_min_label), condition ? `${condition}: ${high}` : high];
  }
  return [tail(String(data.percent || "").trim(), data.label || data.full_label || data.ko || "")];
}

/** Whether a result shows a real attack (a move and some damage). */
export function isShownResult(result) {
  return Boolean(result) && !(String(result.move || "—") === "—" && !hasDamage(result.percent));
}

/**
 * The two sides of one matchup in the order they act: the first mover first. A side
 * knocked out before it can attack (speed_tier_suppressed) is left out.
 */
export function orderedResults(breakdown) {
  const incoming = breakdown?.incoming_result || {};
  const outgoing = breakdown?.outgoing_result || {};
  return (breakdown?.first_result === "outgoing" ? [outgoing, incoming] : [incoming, outgoing])
    .filter((r) => !r.speed_tier_suppressed && isShownResult(r));
}

/** The side of a matchup that moves second and is knocked out first, if it would have attacked. */
export function suppressedResult(breakdown) {
  return [breakdown?.incoming_result, breakdown?.outgoing_result].find((r) => r?.speed_tier_suppressed && isShownResult(r)) || null;
}
