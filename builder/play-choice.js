// Rules about the choices a player makes in /play/, with nothing else attached.
//
// Its own file on purpose. These are rules of the game, so they belong beside the game -- but
// `builder/play-game.js` imports the whole engine stack (tournament-test, solver, hidden-sets),
// and `/play/`'s screen deliberately does not: the game runs in the worker and the page holds
// only the view it is sent. Put here, the page can use the rule and a suite can test it without
// a DOM. A rule that cannot be tested on its own is a rule that drifts.

/**
 * Arm the stone on one seat, and take it off every other.
 *
 * ONE STONE A SIDE, and the screen asks each seat on its own. The page already cleared the other
 * seats' toggles when a second was armed -- but a toggle is not a choice. The action the other
 * seat had ALREADY chosen still carried `mega: true`, and `PlayGame.jointFrom` spends the side's
 * one Mega Evolution on the lowest seat that asks for it. So arming the second Pokemon disarmed
 * the first on screen and evolved it anyway, while the one the player had just armed stayed as
 * it was with nothing said about it.
 *
 * Reported 3 Nov 2026. `state.mega = []` in the toggle handler was the only place in the page
 * that reset the toggles without resetting `state.chosen` beside them -- every other reset
 * (new turn, new game, the Clear button) did both.
 *
 * Returns a NEW chosen list. Each other seat's pick becomes the same move, same target, same
 * kind, without the stone; or `undefined` when that Pokemon has no such action, so the seat
 * reads as unchosen and the player picks again. Never a silent substitution: an action the
 * player did not ask for is exactly what this is fixing.
 */
export function armMega(options, chosen, position) {
  const out = [...(chosen || [])];
  for (const slot of options || []) {
    if (!slot || slot.position === position) continue;
    const actions = slot.actions || [];
    const had = actions.find((a) => a.id === out[slot.position]);
    if (!had || !had.mega) continue;
    const plain = actions.find((a) => a.move === had.move && a.target === had.target
      && a.kind === had.kind && !a.mega);
    out[slot.position] = plain ? plain.id : undefined;
  }
  return out;
}
