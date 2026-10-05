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
//            own attack. Actions go by priority, then Speed; a Speed tie is decided by the two
//            Pokémon themselves and never by which side they are on, and two Pokémon that are the
//            same in every way act at the same time -- neither takes the other's action away, and
//            both strike with the stats they had before either moved. Taunt stops status moves,
//            Protect blocks everything aimed at its user, Prankster status moves fail on
//            Dark types, Good as Gold and Magic Bounce stop status moves.
//   Partner  Earthquake, Surf, Discharge, Bulldoze and the other "every Pokémon next to the
//            user" moves hit the user's partner too. Such a move is picked only when what
//            it does to the foes is worth more than what it does to the partner, and a
//            Speed drop is never used when it would hit the partner. A partner knocked out
//            this way does not count as a knockout for anyone.
//   Turns 2-4 three more PLANNED turns, each decided by the same machinery as turn 1
//            (TOURNAMENT_DEPTH): Protect, Wide and Quick Guard, Helping Hand, sleep, Taunt, Encore,
//            a stat drop, and a Trick Room or Tailwind that is not up yet are all available on them.
//            Fake Out and First Impression are not -- they work on the turn their user comes in, and
//            only turn 1's leads have come in. Protect fails when its user protected the turn before
//            (TOURNAMENT_GUARD), so a lead cannot refuse every turn of the game for nothing.
//   Turn 5+  every active Pokémon attacks on the board the first four turns left: Speed and Attack
//            drops stay (a move's guaranteed drop, like Snarl's or Icy Wind's, applies on every hit),
//            sleep costs its target kit.sleepTurns actions and Encore IDLE_TURNS, a burn
//            halves physical damage and takes 1/16 HP a turn, HP carries over, Focus Sash and
//            Sitrus Berry work once. Tailwind's 3 turns and Trick Room's 4 are counted from the turn
//            they went up and tick on every planned turn after it, so a turn-1 Tailwind is spent by
//            turn 5 and a turn-1 Trick Room has one turn left. A Pokémon that faints is replaced
//            from the back until one side is out or the turn cap is reached. Everyone replaced on the
//            same turn comes in together, in Speed order, so a replacement's Intimidate reaches the
//            other side's replacement too and the slower setter's weather stands whichever side it is on.
// Damage is the calc engine's exact expected damage (mean roll x accuracy, halved for
// moves that need a recharge turn) for the board's weather, terrain, stat stages, burn
// and Helping Hand. Eruption, Water Spout and Dragon Energy are as strong as the HP their user has
// left (TOURNAMENT_FALLOFF). Every game has a field of its own and the board is its only source, so the
// shared Field settings (Weather, Terrain, Trick Room, Tailwind, Reflect, Light Screen) do not
// apply here -- the results name the ones a run ignored (`ignoredField`).
// The game's value = 50 + 50 x (our HP left - their HP left), each side's HP as a share
// of what it brought, kept to 0..100.
//
// Every game is played nine times (TOURNAMENT_DEPTH). Each side picks one of three stances for turn
// 1 -- the line above, everyone who can Protect protecting, or everyone attacking -- and the game is
// played once for every pair of them. Each side then takes the stance that holds up best against all
// three of the other's, blind, by the same rule it brings by. So no side is credited for a turn the
// other side could simply refuse.
//
// A matchup is every bring of ours against every bring of theirs. Both sides bring blind: each
// takes the Pokémon that hold up best against every answer the other could make (ties to the
// better average, then the lower line-up), and the matchup's score is the one game those two
// choices play. Neither side sees the other's choice, and a Speed tie is decided by the two
// Pokémon themselves and not by which side they are on, so the same two teams score the same
// whichever of them is "ours": A against B and B against A add up to 100, and a team against
// itself scores exactly 50. That is why 50 is even.
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
// a full 2 vs 2 game of just those four (the four planned turns and the fight after them,
// searched exactly as the scoring game is -- TOURNAMENT_DEPTH version 2), each of their
// Pokémon on its most common tournament set; in Singles every Pokémon of ours plays their
// most common Pokémon 1 vs 1.
//
// Variable-power attacks: a physical or special move the move table lists at 0 power is still an
// attack when the engine prices it -- Gyro Ball, Electro Ball, Reversal and the rest of the named
// set (TOURNAMENT_VAR_POWER).

import { compact, intimidateOffsets, makeMon, TERRAIN_SEEDS } from "./engine.js";
import { mostSimilarTeam } from "./known-teams.js";
import { resultRecoilShare } from "./self-cost.js";
import { classifyArchetype, tailwindBeneficiaries } from "./team-checks.js";

const BRING = { Singles: 3, Doubles: 4 };
const ACTIVE = { Singles: 1, Doubles: 2 };
const TURN_CAP = { Singles: 12, Doubles: 10 };
// Bring options the results list: the recommended one and the next strong choices.
const BRING_OPTIONS = { Singles: 3, Doubles: 4 };
const TAILWIND_TURNS = 3; // the turns after the one it is set on (4 counting that turn)
const TRICK_ROOM_TURNS = 4; // the turns after the one it is set on (5 counting that turn)
// Encore costs its target the next two actions. Sleep does NOT use this: a sleep move costs
// `kit.sleepTurns` actions, which is its own entry in SLEEP_MOVES (Spore 2, every other one 1).
const IDLE_TURNS = 2;
const BATCH = 8;
const MATRIX_ROWS = 40;
const MATRIX_EVERY = 8; // snapshots between lead-matrix refreshes while running (64 teams)
const ID_SPAN = 1 << 16;
const MAX_CACHED_HITS = 400000;
export const MATCHUP_BANDS = { favourable: 55, unfavourable: 45 };
// v10: the scoring game is FOUR planned turns, not two, and the lead matrix is that same searched
// game (TOURNAMENT_DEPTH version 2); Protect fails when its user protected the turn before
// (TOURNAMENT_GUARD); and a physical or special move the move table lists at 0 power is still an
// attack when the engine prices it (TOURNAMENT_VAR_POWER). All three change what a cell IS, so every
// score a v9 snapshot holds is a different number and a restored one would be drawn beside these as
// though they were comparable. None of them changes how a bring or a stance is CHOSEN, which is why
// the test stays even (measured bit-exact: a team scores exactly 50 against itself and A against B
// plus B against A make exactly 100, at every version of every stamp).
// v9: the game that scores is played TWO planned turns deep and searched (TOURNAMENT_DEPTH), and
// Eruption, Water Spout and Dragon Energy weaken as their user is hurt (TOURNAMENT_FALLOFF), so every
// score a v8 snapshot holds is a different number and a restored one would be drawn beside these as
// though they were comparable. Both rules change what the grid cell IS, not how it is chosen: the
// bring is still the maximin of the grid and the score is still one of its cells, which is why the
// test stays even (a team scores exactly 50 against itself and A against B plus B against A make
// exactly 100, both measured bit-exact under the new rules).
// v8: `unevenStages` names a stat stage pinned on ONE side, because then a team does not score 50
// against itself and the results have to say so; and each slot's quick duel is priced in the form
// the one-Mega rule gives it in the line-up that fights that duel (TOURNAMENT_MEGA version 2), so
// the duel column of a team carrying two Mega Stones reads differently. A restored v7 snapshot has
// no `unevenStages` at all, which is why the version moves: it would draw a run with a one-sided
// stage as though 50 were even. v7: the duels were priced for one Mega over the whole team
// (TOURNAMENT_MEGA version 1), a setter is weighed against every alternative its own chain offers
// (TOURNAMENT_ALT), the shared Field settings no longer reach the board (TOURNAMENT_FIELD) and
// `ignoredField` names the ones it ignored, so every earlier snapshot is a different number. v6
// scored under the bring rule (TOURNAMENT_BRING) on top of the seat rule (TOURNAMENT_SEAT).
export const SNAPSHOT_VERSION = 10;

/** The turn-1 rule as a version: 2 keeps turn 1 out of the duel board, 1 prices Tailwind and
 *  Trick Room, 0 forces them.
 *
 *  Before version 1 a lead that carried Trick Room simply USED it on turn 1 whenever its side
 *  was the slower one, and a lead that carried Tailwind always used it. The move was never
 *  weighed against attacking, so a Trick Room team got its defining condition for free in every
 *  match -- measured at +11 points of headline average on the subject side, and it made "Trick
 *  Room" the hardest column of the By-archetype card on the opponent side. Version 1 replaces
 *  both forced branches with `planSetup`, which prices each condition and commits only when it
 *  beats the setter's own best alternative.
 *
 *  Version 2 stops turn 1 leaking into the quick duels (`duel`, `duelBoard`). Before it,
 *  `playTeam` duelled on the board the chosen game left AFTER turn 1, so a Trick Room that went
 *  up on turn 1 inverted `duel`'s Speed comparison and a Tailwind sped up every one of that
 *  side's slots -- including the ones the game never brought. That is a reporting bias only (the
 *  headline average comes from `play`, the lead matrix from `cellValue` on a fresh board), but it
 *  reached the "answer" the biggest-threats card names, the `duel` column and the `duels` table.
 *  Version 2 duels on a fresh board carrying nothing but the two duellists' own
 *  weather and terrain Abilities, so a duel is a property of the pair and nothing else.
 *
 *  Kept as a stamp on the `team_checks` pattern so a recording made before a rule replays
 *  byte-identically at its own stamp: version 1 restores the post-turn-1 duel board and version
 *  0 the forced setup branches as well. */
export const TOURNAMENT_TURN_ONE = 2;

/** The seat rule as a version: 1 takes the SEAT out of the battle model, 0 is the shipped model.
 *
 *  Under version 0 a Speed tie is broken by `(turn % 2 ? b.s - a.s : a.s - b.s)`, i.e. by which
 *  side the Pokémon sits on and the parity of the turn number, and Protect is decided in one pass
 *  over both sides' plans. Both make the value of a game depend on the seat: a team played against
 *  ITSELF did not score 50 (measured on the first 20 tournament teams: every one of them off 50,
 *  up to 41.43 points on one bring), and A against B plus B against A did not add up to 100.
 *
 *  Version 1 decides both without the seat:
 *    - a Speed tie goes to the Pokémon whose own set hashes lower (`tieRank` / `tieKey`, set in
 *      `prepare`), so the same two Pokémon break their tie the same way whichever side they are
 *      on. A tie in the real game is a coin flip, so no winner is "correct"; what must not happen
 *      is that the seat decides it.
 *    - two INDISTINGUISHABLE Pokémon (same priority, same Speed, same set) cannot be ordered at
 *      all, and there both act (`tieRuns`, `freezeRun`): neither takes the other's action away by
 *      knocking it out, making it flinch, putting it to sleep, Taunting or Encoring it first, and
 *      both strike with the stats they had before either moved. That is the only seat-free answer
 *      to a coin flip between twins, and it is what makes a mirror come out at exactly 50.
 *    - Protect, Wide Guard and Quick Guard are decided for both sides against the plans as they
 *      stood BEFORE any guard was chosen, so side 0's Protect no longer removes its attack from
 *      the damage side 1 prices its own Protect against.
 *    - everyone replaced on the same turn comes in together, in Speed order (`refill`), instead of
 *      side 0's replacements and then side 1's.
 *  Measured after, on the same 20 teams: all 210 mirror games (every bring) score exactly 50.00,
 *  and all 4,050 seat swaps measured -- within a team and across teams -- add up to exactly 100.
 *  The headline barely moves (Doubles 48.41 -> 48.46 on 150 teams), which is why a per-matchup
 *  bias of up to 75 points could sit here unnoticed.
 *
 *  Kept as a stamp on the `team_checks` pattern so a recording made before the rule replays
 *  byte-identically at its own stamp: version 0 restores the seat-dependent order and the
 *  one-pass Protect. */
export const TOURNAMENT_SEAT = 1;

/** The bring rule as a version: 1 has both sides commit blind, 0 is the shipped best response.
 *
 *  Under version 0 our bring is the one whose WORST answer is best (`max` over ours of `min` over
 *  theirs) and their bring is the answer that hurts that choice most -- a best response to a
 *  commitment they can see. Since `max min <= min max`, the number reported is the value of a game
 *  we play blind and they play knowing our line-up, so it is systematically below even: measured on
 *  a round robin of the first 20 tournament teams (380 ordered pairs, every bring against every
 *  bring, Doubles, default settings) the reported average is 45.17 while the average over every
 *  bring pair -- the value with no decision in it at all -- is exactly 50.0000, and 170 of the 190
 *  unordered pairs do not add up to 100 (mean 10.80, max 31.55 points). That is what made the
 *  page's own "A score of 50 is even" untrue.
 *
 *  Version 1 gives their bring the same rule ours has: the bring whose worst case is best, chosen
 *  without seeing what the other side brings. Their seat's maximin is `argmin` over theirs of `max`
 *  over ours, which needs no extra game -- it reads the very grid the loop already builds, because
 *  the seat rule (TOURNAMENT_SEAT) makes V(ours=c, theirs=d) + V(ours=d, theirs=c) exactly 100. The
 *  tie-break is the mirror of ours: ours takes the better worst case, then the better average, then
 *  the lower plan index; theirs takes the better worst case FOR THEM (our lower one), then the
 *  better average for them (our lower one), then the lower plan index -- their own index in their
 *  own plan list, which is the same list whichever seat they sit on, so the pick is the same after a
 *  seat swap. Measured on the same round robin: the reported average is exactly 50.00, all 190
 *  pairs add up to 100 exactly, and the bands go 25.3 / 21.3 / 53.4 -> 38.2 / 23.7 / 38.2.
 *
 *  Our own recommended bring is the same under both versions -- only the game it is scored in
 *  changes, and with it which of THEIR Pokémon are recorded as brought against us (the threats
 *  card's `brought`, `kosPerGame`, `survived` and their pairs). `bringTotals` follows the same
 *  rule, so the bring options card prints the average of what each bring scores against every
 *  team's own committed bring, which is what its copy claims.
 *
 *  Kept as a stamp on the `team_checks` pattern so a recording made before the rule replays
 *  byte-identically at its own stamp: version 0 restores the best-response answer and the
 *  per-team worst case in `bringTotals`. */
export const TOURNAMENT_BRING = 1;

/** The field rule as a version: 1 makes the board the only source of the field, 0 lets the shared
 *  Team Evaluation settings through.
 *
 *  Every game has a field of its own: weather and terrain come in with the Pokémon that set them
 *  (`enter`), Tailwind and Trick Room are turn-1 choices with their own counters, and screens are
 *  not modelled at all. The shared settings of the Field panel (builder/evaluation-view.js) are a
 *  different thing: one field pinned for every calculation of Team Evaluation. Under version 0 five
 *  of the six reached tournament damage. `calc` overrode the settings' weather only when it was
 *  "None" and terrain only when it was "None", and `freshBoard` started every board on them, so a
 *  pinned field REPLACED the board's own -- and `prepare` then dropped the Pokémon's own weather /
 *  terrain Ability from its kit, so nothing could set the real one. Reflect and Light Screen were
 *  worse than replaced: `calcContext` applies them by SIDE (team-eval.js `screenOn`, keyed on
 *  `analysis_side`), so "My Team" halved every hit into our side of every game, and the board has no
 *  screen, no turn count and no Light Clay to price that with. Measured on team1 against the first
 *  120 tournament teams (Doubles, every other setting default): Reflect "My Team" +7.47 headline
 *  points, "Threat Team" -5.50, "Both" +2.83; Light Screen "My Team" +5.82, "Threat Team" -6.05,
 *  "Both" +0.45; weather Rain +5.15, Sand +3.02, Snow +2.50, Sun +1.24; terrain Psychic +1.21,
 *  Misty -0.46, Grassy -0.45, Electric -0.03. Trick Room and Tailwind moved it by exactly +0.0000,
 *  because the engine reads them only in `effectiveSpeed` (builder/engine.js:721) and the board
 *  passes its own Speed state there, never the settings'.
 *
 *  Version 1 neutralises all six: the board's weather and terrain are used whatever the settings
 *  say, `reflect`, `light_screen` and `trick_room` are forced off in the calc context, both sides'
 *  `tailwind` with them, and `freshBoard` starts empty. A Pokémon's own weather / terrain Ability is
 *  honoured again whatever is pinned -- "Weather Abilities" in the Rules panel still turns it off,
 *  because that is a rule about the model and not a field. The snapshot lists what it ignored
 *  (`ignoredField`) and the results say so, because a silently ignored setting is its own bug.
 *
 *  Kept as a stamp on the `team_checks` pattern so a recording made before the rule replays
 *  byte-identically at its own stamp: version 0 restores the settings-first field. Under the
 *  default settings (no field pinned) the two versions are the same run. */
export const TOURNAMENT_FIELD = 1;

/** The Mega rule of the quick duels as a version: 2 duels in the form the one-Mega rule gives the
 *  slot in the line-up that FIGHTS the duel, 1 commits one Mega over the whole team, 0 prices every
 *  Mega Stone holder as its Mega.
 *
 *  One Mega Stone a side is all a bring can spend (`committedMega`, the Companion's
 *  lead_optimizer/mega_rule.py), and the games honour it per LINE-UP: `membersOf` is asked about the
 *  Pokémon that stand on the field together, so `plansFor` offers no bring with two stones it could
 *  avoid and `fixedPlan` plays the second holder of a named lead pair in its own base form.
 *
 *  Version 0 duelled with `state.ours[o].unit`, the set as registered. Version 1 asked
 *  `committedMega` about the WHOLE TEAM and duelled every other holder as its base form -- which is
 *  not the question a 1-on-1 poses, and it made the duel column depend on a teammate that is not in
 *  the duel. Measured on tests/run-tournament-smoke.mjs's own TWO_STONES fixture against 150 teams in
 *  Doubles: the column committed slot 0 ([Mega Salamence, Arcanine, Blastoise+Blastoisinite, Milotic,
 *  Gholdengo, Rillaboom]) while the recommended bring is [Arcanine, Mega Blastoise, Milotic,
 *  Gholdengo], which commits slot 2 -- so the column priced the one Pokémon the recommended games
 *  really do Mega-Evolve as a base form, and spent its Mega on a Salamence that bring never brings.
 *  On 30 library teams holding two or more stones (played as ours, Doubles, 60 opponents each) it
 *  priced the recommended bring's own Mega slot as a base form in 14 of 30. It also contradicted the
 *  report's own 1 vs 1 games: in Singles the Matchups card plays each of our Pokémon as a line-up of
 *  one (`fixedPlan`), so its column for that slot IS Mega Blastoise, while the same page priced base
 *  Blastoise in the duels. The claim version 1 was written on -- that the card answered with "a form
 *  no recommended game ever fielded" -- does not hold for that fixture: the recommended bring fields
 *  Mega Blastoise.
 *
 *  Version 2 asks the one-Mega rule the question the duel actually poses: which form does this slot
 *  play in the line-up that fights this game? A 1-on-1 holds one Pokémon of ours, so nothing else can
 *  spend the stone and the holder Mega-Evolves -- `membersOf([slot])`, the very call the games make.
 *  The duel is a property of the pair again, like the field it is fought on (`duelBoard`), and the
 *  duel column agrees with the Singles matrix column for the same slot. It fields the same forms
 *  version 0 did, by asking the rule instead of reading the set; the one-Mega rule keeps its bite
 *  where it belongs, in the GAMES (`plansFor`, `membersOf`, `fixedPlan`), and an empty commitment is
 *  still empty -- a slot with no stone has nothing to spend, exactly as `mega_allowed` of `()` means
 *  "no commitment" in the Companion.
 *
 *  It moves no score: the duels reach the duel column, the `duels` table, `weakTo` where the matrix
 *  has no cell of its own, and the biggest-threats answer (tests/run-tournament-smoke.mjs proves the
 *  headline cannot come from them). Measured version 1 against version 2 on TWO_STONES against 150
 *  teams: the headline is 56.2996 in Doubles and 54.7169 in Singles under both, and 0 of 150 matchups
 *  move in either format. On the 30 two-stone library teams above: 0 of 30 headlines and 0 of 1,800
 *  matchups move; 25 snapshot threat answers change and none of them is drawn (a Doubles answer comes
 *  from the duels only when there is no pair answer, which in practice needs a one-Pokémon team, and
 *  such a team has at most one stone); the Biggest-threats list is the same on 30 of 30 and so is its
 *  High / Medium pill; `weakTo` changes on 18 of 30 in Doubles, where the card draws `weakPairs`
 *  instead, and on 0 of 30 in Singles, where it is drawn.
 *
 *  Kept as a stamp on the `team_checks` pattern so a recording made before the rule replays
 *  byte-identically at its own stamp: version 1 restores the team-wide commitment and version 0 the
 *  registered form, which is also what an ABSENT stamp means. A team with at most one stone holder is
 *  the same run under all three. */
export const TOURNAMENT_MEGA = 2;

/** The setter's alternatives as a version: 1 prices every action the chain would offer IN PLACE of
 *  the condition, 0 only a Taunt and an attack. (Three of the chain are out on purpose; the list at
 *  the end of this comment says which and why, so it is not read as everything `planSide` can do.)
 *
 *  `altValue` is what setting Tailwind or Trick Room is weighed against (`planSetup`): the lead has
 *  one action, so the condition must beat the best thing that lead would otherwise do. Version 0
 *  asked only for a pre-empting Taunt and the lead's best attack, while `planSide`'s own chain would
 *  also give that lead Spore or another sleep move, Follow Me / Rage Powder, a spread Speed drop,
 *  Snarl and the other Attack / Sp. Atk drops, Will-O-Wisp and Encore. So the alternative was
 *  under-priced and setting up was chosen against a turn the model itself would not have played.
 *
 *  Version 1 takes the best of every option the chain offers that lead, each at the price the chain
 *  puts on it. Measured on the bench team of tests/run-tournament-smoke.mjs against 150 teams: the
 *  headline moves +0.0195 in Doubles (53.3546 -> 53.3742) and 0.0000 in Singles, but 12 of the 150
 *  matchups change and 11 of them by more than a point (biggest 22.28), and their Trick Room rate
 *  falls 4.0% -> 2.7% with our Tailwind 18.0% -> 17.3%. On eight real Trick Room teams played as the
 *  subject against the first 100 teams the move is -2.28 to +0.99 (mean -0.51), and the committed
 *  one still commits: team685 sets Trick Room in 67 of 100 recommended games (66 before) and scores
 *  58.03 (58.07 before). Helping Hand is deliberately not among the alternatives: what it is worth
 *  depends on the partner's chosen action, which is not settled while a bid is being priced.
 *
 *  Two more of the chain are out, on purpose, so this list is not read as everything `planSide` can
 *  give a lead:
 *    - FAKE OUT, because it is not an alternative to setting up at all: `planSide` takes it BEFORE it
 *      reads the committed setup (`planSide`'s Fake Out branch `continue`s past it), so a lead that
 *      can flinch something never uses a setup move whatever the bid says. Pricing the bid against
 *      Fake Out would not change what THAT lead does; it would only stop it reserving the condition
 *      from a partner (`taken` in `planSetup`), which is a separate defect this list cannot fix.
 *      Measured, with Fake Out's own price (1 + 10 for a setter + `threatTo`) added to the bids
 *      below: exactly +0.0000 on the bench team against 150 teams in both formats, 0 of 150 matchups
 *      moved; +0.0000 and 0 matchups on a hand-made team whose lead carries Fake Out and Trick Room;
 *      +0.0000 on all three library teams that hold such a member, played as ours against 60 teams
 *      each, and on the bench against those three. Of 16,962 library members exactly 3 carry Fake Out
 *      and a setup move (team98 and team587 Meowstic, team568 Indeedee, all Trick Room). It is only
 *      ever worth anything when the SAME side has a second carrier of the same condition: on a
 *      manufactured team (Meowstic with Fake Out + Trick Room beside an Indeedee with Trick Room) it
 *      is +0.3334 over 150 teams with 6 matchups moved, the biggest by 40.02 -- which is the
 *      reservation defect, not this price.
 *    - WIDE GUARD, QUICK GUARD and PROTECT, because `planGuards` runs after both sides have planned
 *      and only ever replaces an action that is `replaceable` -- nothing, an attack or a stat drop. A
 *      lead that committed a condition is never one of them, so a guard cannot take its turn.
 *
 *  Kept as a stamp on the `team_checks` pattern so a recording made before the rule replays
 *  byte-identically at its own stamp: version 0 restores the Taunt-or-attack alternative. */
export const TOURNAMENT_ALT = 1;

/**
 * How deeply the game that SCORES is played.
 *
 * Version 0 is one planned turn: `turnOne` decides everything -- Fake Out, Trick Room, Tailwind,
 * Protect, Wide and Quick Guard, sleep, Taunt, Encore, Helping Hand -- and then every turn after it
 * is `pickTarget` only, so from turn 2 on NOBODY protects, switches, sets a condition or uses a
 * status move again. A side that wins turn 1 therefore meets no answer for the nine turns that
 * follow: a Trick Room that goes up on turn 1 runs its full five turns unopposed, the foe never
 * Protects the attack it is about to die to, and its own Trick Room or Tailwind can never go up
 * because a status move is not something turn 2 can choose. Measured on a Trick Room + Drought team
 * (Farigiraf / Torkoal / Dragonite-Mega / Incineroar / Golisopod-Mega / Kingambit): 67.53 against 150
 * teams where twelve library teams played as ours average 50.68, and taking Trick Room off that team
 * alone costs it 10.81 of those points.
 *
 * Version 1 plays TWO planned turns and searches them, for the one game whose value becomes the
 * matchup score:
 *   - Turn 2 is planned by the same `planSide` / `planGuards` machinery as turn 1, so Protect, the
 *     guards, sleep, Taunt, Encore, Helping Hand and a second side's Trick Room or Tailwind are all
 *     available on it. Fake Out and First Impression are not: they are the turn a Pokémon enters,
 *     and only turn 1's leads have entered (`firstTurn`).
 *   - Both sides choose a STANCE for turn 1 and the game is played once for every pair of them, so
 *     the same matchup is played several times instead of once. The stances are the three a side
 *     really has: the line `planSide` decides, everyone who can Protect protecting, and everyone
 *     attacking.
 *   - Each side then takes its best path, by the same maximin `chooseBrings` already uses for the
 *     bring: ours is the stance whose WORST case against their three is highest, and theirs is
 *     chosen BLIND, by its own minimax over its own side of the grid -- not as an answer to ours.
 *     (The sentence that used to stand here, "theirs is their best answer to it", described the
 *     first attempt, which `playDeep`'s own comment records as the thing that broke the test's
 *     evenness: read as a reply, the search is one-sided and a team stops scoring 50 against
 *     itself.) So a side is never credited for a line the other side can simply refuse.
 *
 * Version 2 plays FOUR planned turns, and makes the lead matrix the same searched game:
 *   - Turns 2, 3 and 4 all go through `plannedTurn` (`play`'s loop over `plannedTurns`), because
 *     version 1 still left turns 3+ as `pickTarget` and nothing else -- so the ability to Protect or
 *     use a support move after turn 2 was worth exactly nothing. The TURN BUDGET is unchanged
 *     (TURN_CAP: 10 in Doubles, 12 in Singles): a deeper plan does not buy a longer game, it
 *     replaces attack-only turns with planned ones.
 *     Measured on 20 library teams spread evenly across the library, 60 opponents each, Doubles,
 *     budget held at 10, the other two new rules off: four planned turns move the headline against
 *     two by mean 1.62 and up to 4.90 points and reorder 16 of the 20; planning EVERY turn
 *     (plannedTurns = the turn cap) moves them by mean 4.11, max 14.17, 19 of 20. So four turns take
 *     39% of the full-depth correction for +25% of the run time, where every turn costs +84%. The
 *     production run at limit 1000 goes 56.8 s -> 73.2, 73.9 and 75.3 s over three runs on the bench
 *     team (+29% to +33%), which is the order the owner already tolerates.
 *   - `cellValue`, the lead matrix's cell, is the searched game too (see it for the numbers): the same
 *     nine playouts and the same four planned turns as the score, so the Matchups card and the
 *     headline stop being two different models of one game. It is gated on version >= 2 and not on the
 *     search being on at all, so a recording at version 1 still gets the unsearched one-turn matrix it
 *     was drawn with, byte for byte -- a matrix cell is a number in the snapshot like any other, and
 *     that is what the stamp is for.
 * It ships with TOURNAMENT_GUARD, because four planned turns amplify the free consecutive Protect
 * that version 1 could only ever hand out once: a team of six Protect carriers against 150 teams goes
 * 59.65 (two planned turns) -> 64.73 (four) and back to 61.30 once repeat Protect fails.
 *
 * The bring grid is NOT shallow and has not been since version 1: `cellFor` plays the searched game
 * for every cell, because the bring rule's guarantee is that their blind bring is never a better
 * answer for them than their best reply, and that only holds while the cell and the score are one
 * model (tests/run-tournament-bring.mjs). Measured on the bench team against 150 teams: 176.7
 * searched games a matchup, and searching the grid instead of playing it once costs +84% of the run
 * at two planned turns and +163% at four -- not the "about four times the whole run" this comment
 * used to claim for a deepening that had in fact already happened.
 *
 * Kept as a stamp so a recording made before the rule replays at its own stamp: version 1 restores
 * the two planned turns, version 0 the single planned turn and the unsearched lead matrix.
 */
export const TOURNAMENT_DEPTH = 2;

/**
 * Whether Eruption, Water Spout and Dragon Energy weaken as their user is hurt.
 *
 * Version 0 is the defect: the test never set `current_hp_percent`, so the engine read its default
 * of 100 and those three moves were priced at full 150 base power however little HP their user had
 * left. Measured, Torkoal's Eruption into an Amoonguss in its own Sun: the test returned the same
 * 3.71786 of the target's HP at 100%, 50% AND 10% HP, while the engine asked properly returns
 * 371.8%, 186.4% and 36.8%. A Torkoal on a sliver was credited with ten times the damage it can do,
 * every turn, for up to ten turns.
 *
 * Version 1 passes the attacker's live HP to the engine, which already models the falloff
 * (engine.js's `special === "eruption"`). The HP share is quantised into HP_BUCKETS steps and enters
 * the damage cache key, but ONLY for the moves that read it -- a cache that ignored HP would hand
 * back the full-power number for a hurt attacker, which is the very defect being fixed.
 *
 * Kept as a stamp so a recording made before the rule replays at its own stamp.
 */
export const TOURNAMENT_FALLOFF = 1;

/**
 * Whether Protect fails when its user protected the turn before.
 *
 * Version 0 is free: `planGuards` gives Protect to any lead that would otherwise be knocked out, and
 * asks nothing about last turn. With one planned turn that could happen once and cost nothing; with
 * four (TOURNAMENT_DEPTH version 2) the same Pokémon simply refuses every turn of the game. Counted
 * inside the games, on a team of six Protect carriers against 60 teams in Doubles at four planned
 * turns: 662,971 Protects over 390,528 planned turns, and 363,856 of them -- 54.9% -- by a Pokémon
 * that had protected the turn before. That is not a rare edge; it is the majority of every Protect the
 * model plays. What it is worth, on the same team against 150 teams: 59.65 at two planned turns, 64.73
 * at four, which is the free refusal being paid for.
 *
 * Version 1 records `guardedLast` in `refill` (the one place `guard` is cleared, and it runs at the
 * end of every turn, so it is exactly "last turn") and refuses the repeat in the two places a Protect
 * can be chosen: `planGuards`, and `applyStance`'s STANCE_GUARD. Counted the same way: 407,670
 * Protects and 0 repeats -- so it takes the repeats and not Protect itself -- and the team comes back
 * to 61.30 against 150 teams.
 *
 * AN OUTRIGHT BLOCK IS SLIGHTLY HARSH, and knowingly so. The real game gives a consecutive Protect a
 * 1/3 success chance (it is 1/3 again on the third turn, and so on), not zero. Pricing it at a third
 * of its effect was considered and rejected as the less clean of the two: `guard` is a boolean that
 * every consumer reads as an absolute -- `deal` drops the hit entirely, `statusBlock` returns the word
 * "Protect", the Fake Out branch turns the flinch off, and the story says the move "is blocked by
 * Protect". A third of an effect would mean a partial block threaded through all four, a flinch that
 * half happens, and a story line that has to hedge; and the choice `planGuards` makes is not a value
 * comparison it could scale (it protects when the lead would DIE, which either happens or does not).
 * So the model refuses the repeat outright, which errs against the Protect user, and the direction of
 * the error is stated here rather than hidden. Wide Guard and Quick Guard share Protect's counter in
 * the real game and do not here, because `guard` is only ever set by Protect and the board keeps no
 * record of a Wide Guard turn to count -- a separate defect, not fixed by this rule.
 *
 * Kept as a stamp so a recording made before the rule replays byte-identically at its own stamp:
 * version 0 restores the free consecutive Protect.
 */
export const TOURNAMENT_GUARD = 1;

/**
 * Whether a physical or special move the move table lists at 0 power is still an attack.
 *
 * Version 0 reads `attack` straight off `ev.damagingMove`, whose test is "physical or special AND
 * power > 0". Eleven moves fail it for a reason that has nothing to do with being an attack: their
 * power is not in the table because it is worked out from the board -- the target's weight (Low Kick,
 * Grass Knot), the two weights (Heavy Slam, Heat Crash), the two Speeds (Gyro Ball, Electro Ball),
 * the user's own HP (Reversal, Flail), the target's (Hard Press), the user's party (Beat Up) or its
 * held item (Fling). The engine prices nine of the eleven perfectly well, so the test was fielding
 * Pokémon whose real attack it treated as a blank move slot. Measured into a Snorlax as a share of
 * its HP: Machamp's Low Kick 1.2350 (its Close Combat is 1.4167), Archaludon's Hard Press 0.4422,
 * Venusaur's Grass Knot 0.2718, Machamp's Reversal 0.2193, Raichu's Electro Ball 0.1711, Steelix's
 * Heavy Slam 0.1573, Emboar's Heat Crash 0.1035, Forretress's Gyro Ball and Tauros's Flail 0.0899.
 * Beat Up and Fling still come back at 0.0000 -- the party and the item they read are not on this
 * board -- so they are named here and cost nothing until the engine can price them.
 *
 * Version 1 makes exactly those eleven attacks, by name (VAR_POWER_MOVES). A NAMED SET and not a
 * general relaxation: `damagingMove`'s `power > 0` is also what keeps Protect, Trick Room and every
 * other status move out of `unit.attacks`, so widening the test would put them in. `damaging` itself
 * is left alone -- it is a different question (it gates the stat-drop and Speed-drop bookkeeping) and
 * none of the eleven is one of those moves.
 *
 * Measured against 150 teams in Doubles: a team built so that every attack it owns is one of the
 * eleven (Forretress, Steelix, Machamp, Raichu, Archaludon, Venusaur) goes 9.82 -> 26.27 (+16.45),
 * because under version 0 five of its six Pokémon had no attack at all -- 0, 0, 0, 0, 1, 0 attacks a
 * slot against 1, 2, 2, 1, 2, 1 under version 1. On an ordinary six with one Low Kick carrier that
 * also holds Knock Off it is -0.0002, because that Machamp picks Knock Off anyway -- the rule pays
 * where a Pokémon has nothing else, which is the case it was wrong about. Of today's 16,962
 * library members 611 (3.6%) carry one: Low Kick 547, Beat Up 16, Heavy Slam 16, Grass Knot 13, Hard
 * Press 7, Fling 5, Gyro Ball 3, Reversal 2, Heat Crash 1, Electro Ball 1.
 *
 * Kept as a stamp so a recording made before the rule replays byte-identically at its own stamp:
 * version 0 restores the blank move slot.
 */
export const TOURNAMENT_VAR_POWER = 1;

/** The physical and special moves whose LISTED power is 0 because the power is worked out from the
 *  board -- the target's weight, the two Speeds, the user's HP, its item or its party. A NAMED set
 *  and not a general relaxation of `damagingMove`: that function's `power > 0` test is also what
 *  keeps status moves out of `attacks`, so widening it would make Protect an attack
 *  (TOURNAMENT_VAR_POWER). */
const VAR_POWER_MOVES = new Set([
  "lowkick", "grassknot", "heavyslam", "heatcrash", "gyroball", "electroball",
  "reversal", "flail", "beatup", "hardpress", "fling",
]);

/** A rule stamp as a version: 0 (off) for null / undefined / false / "" / "0".
 *
 *  Coerces as `teamCheckRulesOption` does (team-checks.js): a version is a non-negative integer,
 *  so it is truncated and a non-positive one is off. An ABSENT value on a recording means "no
 *  stamp", i.e. a recording made before the rule, so it is off -- but a stamp option's own
 *  default is `current`, the version production runs, which is also what an unreadable value
 *  falls back to. */
function ruleVersion(value, current) {
  if (value === null || value === undefined || value === false) return 0;
  const text = String(value).trim().toLowerCase();
  if (!text || text === "0" || text === "off" || text === "false" || text === "no" || text === "none") return 0;
  const n = Number(text);
  if (!Number.isFinite(n)) return current;
  const version = Math.trunc(n);
  return version > 0 ? version : 0;
}

/** A `tournament_turn_one` stamp as a version (`ruleVersion` against TOURNAMENT_TURN_ONE). */
export function tournamentTurnOneOption(value) {
  return ruleVersion(value, TOURNAMENT_TURN_ONE);
}

/** A `tournament_seat` stamp as a version (`ruleVersion` against TOURNAMENT_SEAT), so it coerces
 *  exactly as `tournamentTurnOneOption` does. */
export function tournamentSeatOption(value) {
  return ruleVersion(value, TOURNAMENT_SEAT);
}

/** A `tournament_bring` stamp as a version (`ruleVersion` against TOURNAMENT_BRING), so it coerces
 *  exactly as `tournamentTurnOneOption` does. */
export function tournamentBringOption(value) {
  return ruleVersion(value, TOURNAMENT_BRING);
}

/** A `tournament_field` stamp as a version (`ruleVersion` against TOURNAMENT_FIELD), so it coerces
 *  exactly as `tournamentTurnOneOption` does. */
export function tournamentFieldOption(value) {
  return ruleVersion(value, TOURNAMENT_FIELD);
}

/** A `tournament_mega` stamp as a version (`ruleVersion` against TOURNAMENT_MEGA), so it coerces
 *  exactly as `tournamentTurnOneOption` does. */
export function tournamentMegaOption(value) {
  return ruleVersion(value, TOURNAMENT_MEGA);
}

/** A `tournament_alt` stamp as a version (`ruleVersion` against TOURNAMENT_ALT), so it coerces
 *  exactly as `tournamentTurnOneOption` does. */
export function tournamentAltOption(value) {
  return ruleVersion(value, TOURNAMENT_ALT);
}

/** A `tournament_depth` stamp as a version (`ruleVersion` against TOURNAMENT_DEPTH), so it coerces
 *  exactly as `tournamentTurnOneOption` does. */
export function tournamentDepthOption(value) {
  return ruleVersion(value, TOURNAMENT_DEPTH);
}

/** A `tournament_falloff` stamp as a version (`ruleVersion` against TOURNAMENT_FALLOFF), so it
 *  coerces exactly as `tournamentTurnOneOption` does. */
export function tournamentFalloffOption(value) {
  return ruleVersion(value, TOURNAMENT_FALLOFF);
}

/** A `tournament_guard` stamp as a version (`ruleVersion` against TOURNAMENT_GUARD), so it coerces
 *  exactly as `tournamentTurnOneOption` does. */
export function tournamentGuardOption(value) {
  return ruleVersion(value, TOURNAMENT_GUARD);
}

/** A `tournament_var_power` stamp as a version (`ruleVersion` against TOURNAMENT_VAR_POWER), so it
 *  coerces exactly as `tournamentTurnOneOption` does. */
export function tournamentVarPowerOption(value) {
  return ruleVersion(value, TOURNAMENT_VAR_POWER);
}

/**
 * The Field settings a run ignores, named as the Settings dialog names them
 * (builder/evaluation-view.js "Field"). Every game has a field of its own, so a pinned one does not
 * apply (TOURNAMENT_FIELD) -- and the results have to say so, because a setting that is silently
 * ignored is its own bug. Empty under the default settings, and empty under field rule 0, which
 * honours them.
 */
export function ignoredFieldSettings(settings) {
  const s = settings || {};
  const out = [];
  const side = (value) => (value === "Both" ? "both sides" : value === "My Team" ? "your team" : "their team");
  const on = (value) => value && value !== "None";
  if (on(s.weather)) out.push(`Weather (${s.weather})`);
  if (on(s.terrain)) out.push(`Terrain (${s.terrain})`);
  if (s.trick_room) out.push("Trick Room");
  if (on(s.tailwind)) out.push(`Tailwind (${side(s.tailwind)})`);
  if (on(s.reflect)) out.push(`Reflect (${side(s.reflect)})`);
  if (on(s.light_screen)) out.push(`Light Screen (${side(s.light_screen)})`);
  return out;
}

// The stat stages the Settings dialog's "Your stat stages" / "Threat stat stages" can set, named as
// the results name a stat (builder/evaluation-view.js, team-eval.js `applyStages`).
const STAGE_NAMES = [["attack_stage", "Attack"], ["defense_stage", "Defense"], ["sp_attack_stage", "Sp. Atk"], ["sp_defense_stage", "Sp. Def"], ["speed_stage", "Speed"]];

/**
 * A stat stage pinned on ONE side, for the results to own up to.
 *
 * Unlike the Field settings, the stat stages are NOT taken out of the board: a stage is part of what
 * the user says their Pokémon is (`ourUnit` through `teamMon`, `opponentMon`), and dropping it would
 * be its own bug. But the page's own "50 is even, because that is what a team scores against itself"
 * is only true while both sides get the same treatment. Measured through the production path on 20
 * library teams played as ours (Doubles, every bring, the reported `chooseBrings` value): with the
 * default settings 0 of 20 teams are off 50; with `my_stages` "attack: +2" 20 of 20 are off, worst
 * +32.6234 (every one of the 210 bring mirrors off, worst +47.9424); with `threat_stages` "attack:
 * +2" 20 of 20 off with the sign flipped, worst -32.6234; with "attack: +2" on BOTH sides 0 of 20
 * again; with `my_stages` "spe: -1" 20 of 20 off, worst -31.2962. So what matters is not that a stage
 * is set but that the two sides are set differently.
 *
 * `readStages` parses one settings string the way the evaluator does -- pass
 * `(text) => ev.applyStages({}, text)`, so this cannot drift from the stages the battle really gets.
 * Without it (or if it throws) the two settings strings are compared as text instead, which can
 * over-report but never falls silent.
 * Returns null when both sides are given the same stages (including none at all, and including two
 * different spellings of the same thing), otherwise each side's stages in the words the results use.
 * It is not behind a rule version: every version of every rule here applies the stages, so every one
 * of them needs the sentence.
 *
 * @param {object} settings
 * @param {(text:string)=>object} readStages
 * @returns {{you:string[], them:string[]}|null}
 */
export function unevenStagePins(settings, readStages) {
  const s = settings || {};
  const mineText = String(s.my_stages || "").trim();
  const theirsText = String(s.threat_stages || "").trim();
  // The text the two sides were given, compared as text. Used when there is no reader to parse them
  // with, or when the reader fails: it can over-report (two spellings of one stage read as two pins),
  // and that is the safe direction, because claiming 50 is even when it is not is the bug this
  // function exists to stop. Falling silent is the one thing it must never do.
  const asText = () => (mineText.toLowerCase() === theirsText.toLowerCase()
    ? null
    : { you: mineText ? [mineText] : [], them: theirsText ? [theirsText] : [] });
  if (typeof readStages !== "function") return asText();
  let failed = false;
  const read = (text) => {
    try {
      return readStages(text) || {};
    } catch {
      failed = true;
      return {};
    }
  };
  const mine = read(mineText);
  const theirs = read(theirsText);
  if (failed) return asText();
  const stage = (stages, key) => {
    const value = Number(stages?.[key]);
    return Number.isFinite(value) ? value : 0;
  };
  if (STAGE_NAMES.every(([key]) => stage(mine, key) === stage(theirs, key))) return null;
  const named = (stages) => STAGE_NAMES.filter(([key]) => stage(stages, key) !== 0)
    .map(([key, name]) => `${name} ${stage(stages, key) > 0 ? "+" : ""}${stage(stages, key)}`);
  return { you: named(mine), them: named(theirs) };
}

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
const NO_HIT = Object.freeze({ slot: -1, frac: 0, lo: 0, hi: 0, priority: 0, spread: false, self: 0 });

// The stances a side chooses between on turn 1 when the scoring game is searched
// (TOURNAMENT_DEPTH). Three, because these are the three a side really has: play the line the model
// decides, refuse the turn behind Protect, or spend it all on damage.
const STANCE_PLAN = 0;
const STANCE_GUARD = 1;
const STANCE_ATTACK = 2;
const STANCES = [STANCE_PLAN, STANCE_GUARD, STANCE_ATTACK];
const STANCE_NAMES = ["planned", "guarded", "all-out"];
// How finely the attacker's own HP is quantised for the moves whose power reads it (Eruption, Water
// Spout, Dragon Energy). Eight steps put every bucket inside 12.5% of the true share, and the bucket
// is only ever part of a cache key for those moves, so nothing else pays for it (TOURNAMENT_FALLOFF).
const HP_BUCKETS = 8;
/** An attacker's HP share as one of HP_BUCKETS steps; full HP is the top bucket, whose own top edge
 *  is 100%, so a healthy attacker reads exactly as it did before the rule. */
function hpBucket(hp) {
  const share = Number.isFinite(hp) ? Math.max(0, Math.min(1, hp)) : 1;
  return Math.max(0, Math.min(HP_BUCKETS - 1, Math.ceil(share * HP_BUCKETS) - 1));
}
// The moves whose base power is their user's remaining HP share (engine.js `special === "eruption"`).
const HP_POWER_MOVES = new Set(["eruption", "waterspout", "dragonenergy"]);

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

/**
 * The same action kinds, for a second searcher that drives this turn machinery with actions of its
 * own choosing rather than the ones `planSide` decides (builder/solver.js). Exported rather than
 * duplicated, so the Solver and the Tournament Test can never disagree about what an action IS.
 */
export const ACTION_KINDS = Object.freeze({
  FAKE_OUT, TAILWIND, TRICK_ROOM, REDIRECT, SPEED_DROP, ATTACK, PROTECT,
  HELPING_HAND, WIDE_GUARD, QUICK_GUARD, SLEEP, TAUNT, ENCORE, LOWER, BURN,
});

/** How many each side brings and how many stand on the field, by format. */
export const BRING_BY_FORMAT = Object.freeze({ ...BRING });
export const ACTIVE_BY_FORMAT = Object.freeze({ ...ACTIVE });
export const TURN_CAP_BY_FORMAT = Object.freeze({ ...TURN_CAP });

// What owning the Speed order is worth, on the same currency as hitScore (a knockout is 10).
// Hand-set, like the Taunt value of 3 and the Wide Guard margin of 0.3 below: a full inversion
// against a field that can take a whole Pokémon (swing 1, stakes 2) prices at 12, just above a
// knockout; against chip damage (stakes 0.5) at 3, which loses to a knockout and beats a weak
// attack. Trick Room is worth more than Tailwind because it lasts a turn longer AND slows the
// other side down as well. Measured from 4 to 9 the Trick Room weight moves the manufactured
// Trick Room advantage only 0.86 -> 2.86 points and the turn-1 landing rate 30% -> 42%, so no
// conclusion rests on the exact figure.
const TRICK_ROOM_WEIGHT = 6;
const TAILWIND_WEIGHT = 4.5;
const SETUP_MARGIN = 0; // how far setting up must beat the setter's own best alternative
const NO_SETUP = Object.freeze({ setup: new Map(), held: new Map() });

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
export { alive, clampStage };

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

/** FNV-1a, so a set's tie rank is the same number in every run and on every machine. */
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Two Pokémon in Speed order without the seat (seat rule 1): the lower `tieRank` of the set each
 * one plays goes first, the key itself settling the rare hash collision. A hash rather than the
 * name so no species is handed every tie it takes part in, and a total order (never a per-pair
 * coin flip) so `sort` stays consistent. 0 means the two are the same Pokémon and the tie cannot
 * be broken at all -- see `tieRuns`.
 */
const byIdentity = (a, b) => a.tieRank - b.tieRank || (a.tieKey < b.tieKey ? -1 : a.tieKey > b.tieKey ? 1 : 0);

/** Priority first, then Speed (reversed under Trick Room); a tie by the Pokémon themselves under
 *  seat rule 1 (`byIdentity`), and by the seat and the turn's parity under version 0. */
function orderActions(actions, trickRoom, turn, seatRule = 0) {
  if (seatRule >= 1) return actions.sort((a, b) => b.pr - a.pr || (trickRoom ? a.sp - b.sp : b.sp - a.sp) || byIdentity(a.m.u, b.m.u));
  return actions.sort((a, b) => b.pr - a.pr || (trickRoom ? a.sp - b.sp : b.sp - a.sp) || (turn % 2 ? b.s - a.s : a.s - b.s));
}

/**
 * Where each action's run of actions the order could not separate starts (seat rule 1): the same
 * priority, the same Speed and the same Pokémon, which after `orderActions` is a block of
 * neighbours. A run of one is every ordinary action. A longer run is a Speed tie between twins --
 * the same set on both sides -- and all of it acts on the state the run began with, so neither
 * twin can take the other's action away.
 */
function tieRuns(actions) {
  const runs = new Array(actions.length);
  for (let i = 0; i < actions.length;) {
    let j = i + 1;
    while (j < actions.length && actions[j].pr === actions[i].pr && actions[j].sp === actions[i].sp && byIdentity(actions[j].m.u, actions[i].m.u) === 0) j += 1;
    for (let k = i; k < j; k += 1) runs[k] = i;
    i = j;
  }
  return runs;
}

let runTag = 0;

/** The state an action is judged by: what its Pokémon was when its run began. The run's `tag`
 *  also marks its Pokémon (`m.runTag`), so an action can tell a twin of its own run -- which has
 *  not moved yet, whatever order the two were listed in -- from a Pokémon that really has moved. */
function freezeRun(actions, runs, i) {
  const tag = (runTag += 1);
  for (let j = i; j < actions.length && runs[j] === i; j += 1) {
    const m = actions[j].m;
    // atk / spa / burn as well, so twins strike with the stats they had before either moved: a
    // Mystical Fire between two identical Indeedee lowered only the one listed second otherwise.
    actions[j].pre = { tag, out: m.out, flinch: m.flinch, idle: m.idle, taunted: m.taunted, atk: m.atk, spa: m.spa, burn: m.burn };
    m.runTag = tag;
  }
}

export class TournamentTest {
  /**
   * @param {TeamEvaluation} evaluation   its evaluator does every calculation
   * @param {KnownTeams} known            the tournament-team library
   * @param {TeamSuggestions} suggestions for the Stat Points that go with a Nature
   * @param {{turnOneRule?:number|string, seatRule?:number|string, bringRule?:number|string,
   *          fieldRule?:number|string, megaRule?:number|string, altRule?:number|string}} options
   *   `turnOneRule`: the turn-1 rule (TOURNAMENT_TURN_ONE); 1 replays the post-turn-1 duel board of
   *   a recording made before version 2, and 0 the forced Tailwind / Trick Room of one made before
   *   version 1 as well. `seatRule`: the seat rule (TOURNAMENT_SEAT); 0 replays the seat-dependent
   *   Speed tie and one-pass Protect of a recording made before it. `bringRule`: the bring rule
   *   (TOURNAMENT_BRING); 0 replays the best-response answer of a recording made before it.
   *   `fieldRule`: the field rule (TOURNAMENT_FIELD); 0 replays the settings-first field of a
   *   recording made before it. `megaRule`: the duels' Mega rule (TOURNAMENT_MEGA); 1 replays the
   *   team-wide Mega commitment of a recording made before version 2, and 0 the registered form of
   *   one made before version 1 as well. `altRule`: the setter's alternatives (TOURNAMENT_ALT); 0
   *   replays the Taunt-or-attack alternative of a recording made before it. `depthRule`: how deep
   *   the scoring game is (TOURNAMENT_DEPTH); 1 replays the two planned turns of a recording made
   *   before version 2, and 0 the single planned turn and the unsearched lead matrix of one made
   *   before version 1 as well. `falloffRule`: the HP falloff (TOURNAMENT_FALLOFF); 0 replays the
   *   full-power Eruption of a recording made before it. `guardRule`: the repeat-Protect rule
   *   (TOURNAMENT_GUARD); 0 replays the free consecutive Protect of a recording made before it.
   *   `varPowerRule`: the variable-power attacks (TOURNAMENT_VAR_POWER); 0 replays a recording made
   *   before it, where a 0-power attack was no attack at all.
   */
  constructor(evaluation, known, suggestions, { turnOneRule = TOURNAMENT_TURN_ONE, seatRule = TOURNAMENT_SEAT, bringRule = TOURNAMENT_BRING, fieldRule = TOURNAMENT_FIELD, megaRule = TOURNAMENT_MEGA, altRule = TOURNAMENT_ALT, depthRule = TOURNAMENT_DEPTH, falloffRule = TOURNAMENT_FALLOFF, guardRule = TOURNAMENT_GUARD, varPowerRule = TOURNAMENT_VAR_POWER } = {}) {
    this.turnOneRule = tournamentTurnOneOption(turnOneRule);
    this.seatRule = tournamentSeatOption(seatRule);
    this.bringRule = tournamentBringOption(bringRule);
    this.fieldRule = tournamentFieldOption(fieldRule);
    this.megaRule = tournamentMegaOption(megaRule);
    this.altRule = tournamentAltOption(altRule);
    this.depthRule = tournamentDepthOption(depthRule);
    this.falloffRule = tournamentFalloffOption(falloffRule);
    this.guardRule = tournamentGuardOption(guardRule);
    this.varPowerRule = tournamentVarPowerOption(varPowerRule);
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
    // The board's own field starts empty (TOURNAMENT_FIELD); version 0 starts it on the shared
    // settings' weather and terrain, which a Pokémon's Ability then could not replace.
    this.fixedWeather = this.fieldRule >= 1 ? 0 : Math.max(0, WEATHERS.indexOf(s.weather));
    this.fixedTerrain = this.fieldRule >= 1 ? 0 : Math.max(0, TERRAINS.indexOf(s.terrain));
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
    // A named variable-power attack (TOURNAMENT_VAR_POWER): the move table lists 0 power because the
    // power comes off the board, so `damagingMove` says no and the move was not an attack at all.
    // `damaging` itself is left alone on purpose -- it is a different question (it gates the stat-drop
    // and Speed-drop bookkeeping) and none of the named set is one of those moves.
    const varPower = this.varPowerRule >= 1 && !damaging && VAR_POWER_MOVES.has(k)
      && (category === "physical" || category === "special");
    info = {
      name, key: k, type, priority, listed, solar, spread,
      // "allAdjacent" (Earthquake, Surf, Discharge, Bulldoze...) hits the user's partner too.
      allyHit: spread && meta.target === "allAdjacent",
      physical: category === "physical",
      special: category === "special",
      attack: (damaging || varPower) && !FIRST_TURN_ONLY.has(k) && !this.ev.selfDestructs(name) && !this.ev.excludedMoves.has(name.toLowerCase()),
      damaging,
      varPower,
      drop: STAT_DROPS[k] || null,
      sound: (meta.flags || []).map((f) => String(f).toLowerCase()).includes("sound"),
      weather: type === "Fire" || type === "Water" || WEATHER_MOVES.has(k),
      terrain: TERRAIN_TYPES.has(type) || TERRAIN_MOVES.has(k) || priority > 0,
      cooldown: solar ? null : this.ev.hasCooldown(name, {}),
      // Its base power IS its user's remaining HP share (TOURNAMENT_FALLOFF).
      hpPower: HP_POWER_MOVES.has(k),
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
    // Whether ANY of its attacks reads its own HP, so `strike`'s cache key only widens for the
    // units that need it (TOURNAMENT_FALLOFF).
    unit.readsOwnHp = unit.attacks.some((slot) => unit.moves[slot].hpPower);
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
      // Its own weather / terrain Ability, whatever the shared settings pin (TOURNAMENT_FIELD);
      // "Weather Abilities" in the Rules panel still turns the weather half off, because that is a
      // rule about the model and not a field. Version 0 drops both when a field is pinned.
      weather: (this.fieldRule >= 1 || s.weather === "None") && s.use_weather_abilities ? WEATHER_SETTERS[field] || "" : "",
      terrain: this.fieldRule >= 1 || s.terrain === "None" ? TERRAIN_SETTERS[field] || "" : "",
      // A Choice item is NOT modelled, and the reason matters: it does not forbid status moves, it
      // locks its user into the first move it uses, so dropping Protect or Snarl from a holder's kit
      // would be modelling the wrong rule. Nor are the sets that pair the two an artefact of the
      // >=95% guaranteed-moves rule (guaranteed-moves.js is in the Auto Build and Suggestions path
      // only; this library is registered teams, imported as they were registered): measured on
      // today's 2,827 teams, 678 of 16,962 members hold a Choice item (4.0%), and of those 34 carry
      // Snarl, 26 Protect, 23 Icy Wind, 15 Trick Room, 9 Helping Hand, 7 Encore, 5 Taunt, 4
      // Will-O-Wisp, 3 Sleep Powder and 3 Tailwind. Modelling the lock itself (from turn 2, in
      // `play`) is the honest change and is not made here.
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
    // What this Pokémon IS to the model, and nothing about the side it sits on: the set as it
    // plays (a stone holder that does not Mega-Evolve is its own base form here, with no item),
    // plus the stat stages the settings gave it, because those change what it does. Two units
    // with the same key are indistinguishable, so a Speed tie between them cannot be broken.
    unit.tieKey = [
      compact(mon.pokemon_name), compact(mon.form_name), item, ability, compact(mon.nature_name),
      (mon.bonuses || []).map((b) => Number(b) || 0).join(","), keys.join("+"),
      [mon.attack_stage, mon.defense_stage, mon.sp_attack_stage, mon.sp_defense_stage, mon.speed_stage].map((v) => Number(v) || 0).join(","),
    ].join("|");
    unit.tieRank = hash32(unit.tieKey);
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
  moveHit(att, def, slot, board, atk, spa, fx = 0, hp = 1) {
    const info = att.moves[slot];
    if (!info) return NO_HIT;
    const w = info.weather || att.weatherSense || def.weatherSense ? board.w : ANY;
    const t = info.terrain || att.terrainSense || def.terrainSense ? board.t : ANY;
    const stage = info.physical ? atk : info.special ? spa : 0;
    const f = (this.active > 1 ? fx & 1 : 0) | (info.physical ? fx & 2 : 0);
    // Eruption, Water Spout and Dragon Energy are as strong as their user's remaining HP
    // (TOURNAMENT_FALLOFF). The share is quantised to HP_BUCKETS steps and joins the cache key for
    // exactly those moves -- a key that ignored it would hand a hurt attacker the full-power number,
    // which is the defect. Every other move, and every move under rule 0, keeps the top bucket, so
    // its key only shifts and its number does not move at all.
    const bucket = this.falloffRule >= 1 && info.hpPower ? hpBucket(hp) : HP_BUCKETS - 1;
    const key = ((((((att.id * ID_SPAN + def.id) * 4 + slot) * 8 + w) * 8 + t) * 13 + stage + 6) * 4 + f) * HP_BUCKETS + bucket;
    let hit = this.hits.get(key);
    if (hit === undefined) {
      hit = this.calc(att, def, info, slot, w, t, stage, f, bucket);
      this.hits.set(key, hit);
    }
    return hit;
  }

  calc(att, def, info, slot, w, t, stage, f, bucket = HP_BUCKETS - 1) {
    // Grassy Glide is +1 in Grassy Terrain when its user is on the ground.
    const priority = info.priority + (info.key === "grassyglide" && t === GRASSY && att.grounded ? 1 : 0);
    // Priority the move table does not list is priority the engine cannot see, so its
    // blocks are applied here: Psychic Terrain for a grounded target, and Armor Tail,
    // Dazzling and Queenly Majesty (unless the attacker has Mold Breaker).
    if (priority > 0 && priority > info.listed && ((t === PSYCHIC && def.grounded) || (def.kit?.priorityBlock && !att.moldBreaker))) return NO_HIT;
    // The board applies Intimidate on entry, so the engine must not apply it again.
    const attacker = { ...att.mon, _white_herb_restored_v314: true };
    // The engine already models the falloff; it just needs telling. The bucket's own top edge is
    // used, so a full-HP attacker is exactly 100 and reads precisely as it did before the rule.
    if (info.hpPower) attacker.current_hp_percent = Math.round(((bucket + 1) / HP_BUCKETS) * 100);
    if (stage && info.physical) attacker.attack_stage = clampStage((att.mon.attack_stage || 0) + stage);
    if (stage && info.special) attacker.sp_attack_stage = clampStage((att.mon.sp_attack_stage || 0) + stage);
    const s = this.ev.settings;
    try {
      const ctx = this.ev.calcContext(attacker, def.mon, info.name);
      // The board is the only source of the field (TOURNAMENT_FIELD). Version 0 keeps a pinned
      // weather or terrain instead of the board's, and keeps the screens, Trick Room and Tailwind
      // the shared settings apply -- by settings SIDE, which the board has no way to model.
      const own = this.fieldRule >= 1;
      if (own || s.weather === "None") {
        const weather = WEATHERS[w === ANY ? 0 : w];
        ctx.weather = weather;
        ctx.attacker_state.weather = weather;
        ctx.defender_state.weather = weather;
      }
      if (own || s.terrain === "None") ctx.terrain = TERRAINS[t === ANY ? 0 : t];
      if (own) {
        ctx.trick_room = false;
        ctx.reflect = false;
        ctx.light_screen = false;
        ctx.attacker_state.tailwind = false;
        ctx.defender_state.tailwind = false;
      }
      // The Solver sets a board that the Tournament Test never does: it starts mid-game, so the
      // screens, Friend Guard and the two conditional counters CAN already be up, and the player
      // may want the rules themselves switched (items off, abilities off). `solverField` is unset
      // for every Tournament Test run, so nothing above this line changes for it.
      const solver = this.solverField;
      if (solver) {
        const attackSide = att.side === 1 ? 1 : 0;
        const defendSide = 1 - attackSide;
        const physical = info.physical;
        if (physical && solver.reflect[defendSide]) ctx.reflect = true;
        if (info.special && solver.lightScreen[defendSide]) ctx.light_screen = true;
        if (solver.auroraVeil[defendSide]) ctx.aurora_veil = true;
        if (solver.friendGuard[defendSide]) ctx.friend_guard = true;
        // Supreme Overlord and Last Respects read how many of the user's own side are down,
        // and Rage Fist how many times its user has been hit. Both are facts about one Pokemon
        // rather than about a side, so they are carried on the attacking unit -- which is also
        // what makes them part of the damage cache key, through `Solver.unitFor`.
        //
        // `ctx.times_hit` was the wrong name: the only Rage Fist site in engine.js reads
        // `ctx.attacker_state.times_hit`, so the counter did nothing and Rage Fist always
        // priced at its 50 base power. The Damage Calculator writes the working key.
        ctx.fainted_allies = Math.max(0, Math.min(5, Number(att.faintedAllies) || 0));
        if (ctx.attacker_state) {
          ctx.attacker_state.times_hit = Math.max(0, Math.min(6, Number(att.timesHit) || 0));
        }
      }
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
      // What this move costs ITS OWN USER, as a share of the ATTACKER's max HP (`self_cost`).
      // `frac` is a share of the DEFENDER's HP, so the recoil cannot ride on it -- and the engine
      // used to publish its recoil as strings only, which is why this game charged Life Orb's 1.3x
      // and Flare Blitz's power at nothing (builder/self-cost.js). `rate` is the accuracy and
      // cooldown part of `scale` WITHOUT the defender's max HP: a move that misses half the time
      // recoils half as often, and one that fires every other turn recoils every other turn.
      const rate = scale;
      scale /= maxHp;
      const self = this.ev.selfCost >= 1 ? resultRecoilShare(result) * rate : 0;
      // `frac` is the EXPECTED share -- the mean roll, scaled by accuracy and by the cooldown --
      // and every planning decision is made on it, which is right: you choose on expectation.
      // `odds` and the unscaled roll range are what a caller needs to play the hit out as the
      // game plays it instead: roll to hit, then roll the damage. `rollHit` is where that
      // happens, and the Tournament Test leaves it alone.
      return {
        slot, frac: (sum / rolls.length) * scale, lo: lo * scale, hi: hi * scale,
        odds: rate, rollLo: lo / maxHp, rollHigh: hi / maxHp,
        priority, spread: info.spread, self,
      };
    } catch {
      return NO_HIT;
    }
  }

  /**
   * A Pokémon's move into another on this board, with its stages, burn and Helping Hand.
   * `pre` is the attacker's own state to strike with, which is the attacker itself everywhere
   * except inside a run of tied twins (seat rule 1), where it is what it was before the run began.
   */
  hitOn(m, target, slot, board, helped = m.helped, pre = m) {
    return this.moveHit(m.u, target.u, slot, board, pre.atk, pre.spa, (helped ? 1 : 0) | (pre.burn ? 2 : 0), pre.hp);
  }

  /**
   * The attacker's best attack into the defender on this board (ties go to the higher priority).
   * `safe`: only the attacks that leave the attacker's partner alone. `burned`: the attacker is burned.
   */
  strike(att, def, board, atk = 0, spa = 0, safe = false, burned = false, hp = 1) {
    const key = (((((att.id * ID_SPAN + def.id) * 8 + board.w) * 8 + board.t) * 169 + (atk + 6) * 13 + spa + 6) * 2 + (burned ? 1 : 0)) * HP_BUCKETS + (this.falloffRule >= 1 && att.readsOwnHp ? hpBucket(hp) : HP_BUCKETS - 1);
    const cache = safe ? this.bestSafe : this.best;
    let best = cache.get(key);
    if (best !== undefined) return best;
    best = NO_HIT;
    const fx = burned ? 2 : 0;
    for (const slot of safe ? att.safeAttacks : att.attacks) best = this.better(best, this.moveHit(att, def, slot, board, atk, spa, fx, hp));
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
    for (const own of list) if (alive(own)) danger = Math.max(danger, Math.min(own.hp, this.strike(foe.u, own.u, board, foe.atk, foe.spa, false, foe.burn, foe.hp).frac));
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

  /**
   * Our slots as the quick duels price them (TOURNAMENT_MEGA version 2): the form the one-Mega rule
   * leaves this slot in for the line-up that FIGHTS the duel, which is this slot alone -- so nothing
   * else is there to spend the stone and a holder duels as its own Mega. It is the same call the
   * games make for a bring (`membersOf`), asked about the one Pokémon in the duel, so the duel is a
   * property of the pair like the field it is fought on, and the column agrees with the Singles
   * matrix column for the same slot (`fixedPlan` of one of ours, which is this same question).
   * Version 1 committed one Mega over the whole TEAM, so a second holder duelled as its base form
   * with the stone in hand -- including the holder the recommended bring really Mega-Evolves.
   * Version 0 duels with the set as registered, which is what version 2 ends up fielding.
   * The results name the form each slot duelled as, whichever version is in force.
   */
  duelUnits(units) {
    if (this.megaRule >= 2) return units.map((_, i) => this.membersOf([i], units, [i]).get(i));
    if (this.megaRule < 1) return units.map((unit) => unit);
    const committed = this.committedMega(units.map((_, i) => i), units);
    return units.map((unit, i) => (i === committed ? unit : this.baseFormUnit(unit)));
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
      return {
        idx, order, members, unitAt: played, leads: leads.length,
        leadKey: members.slice(0, leads.length).map((u) => u.id).join(","),
        // EVERY member it brings, in the order it brings them: a whole game depends on the two in
        // reserve as well, so a game cached by `leadKey` alone would be handed to a different bring
        // that happens to lead with the same pair (`cellFor`).
        bringKey: members.map((u) => u.id).join(","),
        mean,
      };
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
      // Whether it protected on the turn just ended, so the next one cannot (TOURNAMENT_GUARD).
      // Set in `refill`, which is the one place `guard` is cleared.
      guardedLast: false,
      idle: 0, sleep: false, burn: false, helped: false, taunted: false, acted: 0, runTag: 0,
      // What this turn's own moves owe their user, paid in `endOfTurn` (`oweSelf`, `self_cost`).
      selfOwed: 0,
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
  /**
   * The share of the defender's HP this hit actually takes off.
   *
   * The expected share, which is what the Tournament Test wants: its games are scored by
   * comparing teams, and a comparison made on averages needs no repetition to be stable.
   * builder/solver.js replaces this with one that rolls to hit and then rolls the damage,
   * because a Solver is answering a different question -- whether a line WORKS, which turns on
   * whether a roll reaches a knockout and whether a 70% move lands at all.
   */
  rollHit(hit) {
    return hit.frac;
  }

  deal(att, target, hit, events, partner = false) {
    if (!target || target.out || target.guard || hit.frac <= 0) return false;
    let damage = this.rollHit(hit);
    if (damage <= 0) return false;
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
   * The attacker OWES what its own move costs it: recoil and Life Orb, as a share of ITS OWN
   * max HP (`self_cost`, `calc`'s `self`). Owed ONCE per move use, after the hit or hits it
   * landed -- which is why it is here and not in `deal`, since a spread move calls `deal` for
   * every Pokemon it hits and would otherwise pay its recoil two or three times over.
   *
   * It is OWED and not paid on the spot, because paying it inside the turn breaks the seat
   * invariants and those are not negotiable. A turn is ordered and every target chosen before
   * anything moves, and the mirror holds today because inside a turn each side only ever
   * damages the OTHER side: whoever moves first still meets a pristine opponent. Recoil is the
   * first damage a side does to ITSELF mid-turn, and measured on team4 in Doubles it moved a
   * mirror to 46.44 -- the faster Rillaboom's Life Orb killed it at 3.2% HP, which took it off
   * the board, which sent the other Rillaboom's Grassy Glide into an Archaludon instead, for
   * different damage. A Focus Sash goes the same way: its holder is no longer "at full HP" once
   * its own Life Orb has fired. Paid in `endOfTurn` beside the burn, both sides are charged at
   * the same point and nothing about it reads the side index, so a team against itself still
   * scores exactly 50 and a pair of line-ups still 100 together
   * (tests/run-tournament-symmetry.mjs).
   *
   * A move that faints its own user never reaches this: `moveInfo` keeps a self-KO move out of
   * `attacks` altogether.
   */
  oweSelf(att, share) {
    const cost = Number(share) || 0;
    if (!(cost > 0) || !att) return;
    att.selfOwed = (att.selfOwed || 0) + cost;
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
      let hit = this.strike(m.u, foe.u, board, m.atk, m.spa, false, m.burn, m.hp);
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
    const safe = this.strike(m.u, foe.u, board, m.atk, m.spa, true, m.burn, m.hp);
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
        const hit = this.strike(foe.u, own.u, board, foe.atk, foe.spa, false, foe.burn, foe.hp);
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
        const hit = this.strike(foe.u, own.u, board, foe.atk, foe.spa, false, false, foe.hp);
        if (hit.frac > 0 && foe.u.moves[hit.slot].physical) saved = Math.max(saved, Math.min(hit.frac, own.hp) * 0.5 * 2);
      }
      const value = saved + 0.12;
      if (saved > 0 && value > best.value) best = { value, target: foe };
    }
    return best;
  }

  /**
   * How many (mine, theirs) pairs my side wins the Speed order on, under a hypothetical condition.
   *
   * `mul` doubles my Speed (Tailwind), `tr` is the Trick Room flag to judge it under. The
   * comparison is the strict one `orderActions` itself makes, both ways round, so a Speed tie
   * counts for neither side.
   */
  orderWins(mine, foes, board, mul, tr) {
    let wins = 0;
    let pairs = 0;
    for (const a of mine) {
      if (!alive(a)) continue;
      const sa = this.speed(a, board) * mul;
      for (const b of foes) {
        if (!alive(b)) continue;
        const sb = this.speed(b, board);
        pairs += 1;
        if (tr ? sa < sb : sa > sb) wins += 1;
      }
    }
    return { wins, pairs };
  }

  /**
   * What the setter would do instead of setting up: the best of everything `planSide`'s own chain
   * would offer that lead IN PLACE of the condition, at the price the chain puts on it
   * (TOURNAMENT_ALT). Version 0 asks only for a pre-empting Taunt and the lead's best attack, which
   * under-prices the turn a Spore or a Snarl carrier gives up -- the lead has one action, so the
   * condition has to beat the best of them, not one of them.
   *
   * Three of the chain are deliberately not among them, and TOURNAMENT_ALT says why for each:
   * Helping Hand (its worth depends on the partner's chosen action, which `helpGain` cannot know
   * while a bid is being priced -- and a partner boosting this lead's attack is not a lead that just
   * set up), Fake Out (taken before the setup branch is read at all, so it is a pre-emption and not
   * an alternative: measured at exactly +0.0000 everywhere it could be priced here), and the guards
   * (`planGuards` never replaces a committed condition).
   */
  altValue(m, mine, foes, board, slower, s) {
    const k = m.k;
    let best = 0;
    const bid = (value) => { if (value > best) best = value; };
    bid(k.taunt >= 0 ? this.tauntTarget(m, foes, board, slower[1 - s])?.value || 0 : 0);
    const pick = this.pickTarget(m, foes, board, mine, true);
    bid(pick ? this.attackValue(m, pick, foes, board) : 0);
    if (this.altRule < 1) return best;
    // The rest of the chain, in its own order: sleep, redirection, a spread Speed drop, then the
    // stat drops, Will-O-Wisp and Encore it weighs against its attack.
    if (k.sleep >= 0 && this.sleepTarget(m, foes, mine, board)) bid(1.5);
    if (k.redirect && mine.filter(alive).length > 1) bid(1);
    if (k.speedDrop >= 0 && this.meanSpeed(foes, board) > this.meanSpeed(mine, board) && this.speedDropUseful(m, mine, foes, board)) bid(1);
    for (const slot of k.lowers) {
      const lower = this.lowerPlan(m, slot, mine, foes, board);
      if (m.u.moves[slot].spread || lower.target) bid(lower.value);
    }
    if (k.wisp >= 0) {
      const burn = this.burnPlan(m, mine, foes, board);
      if (burn.target) bid(burn.value);
    }
    if (k.encore >= 0) {
      const encore = this.encoreTarget(m, foes, board);
      if (encore) bid(encore.value);
    }
    return best;
  }

  /**
   * Which of this side's setup moves are worth their turn, best bid first.
   *
   * One bid per (lead, condition), priced on the current board, then committed greedily: a second
   * condition is RE-priced on the board the first one leaves, so a side never sets Tailwind into
   * its own Trick Room and then fights its own Speed plan. Returns the committed actions by lead
   * and, for the rest, why the move stayed unused.
   */
  planSetup(s, mine, foes, board, slower) {
    const setup = new Map();
    const held = new Map();
    const bids = [];
    for (const m of mine) {
      if (!alive(m)) continue;
      if (m.k.tailwind && !(board.tw[s] > 0)) bids.push({ m, kind: TAILWIND, pr: m.k.prankster ? 1 : 0, move: "Tailwind" });
      if (m.k.trickRoom) bids.push({ m, kind: TRICK_ROOM, pr: m.k.prankster ? -6 : -7, move: "Trick Room" });
    }
    if (!bids.length) return NO_SETUP;
    for (const bid of bids) bid.first = this.setupBid(bid.kind, bid.m, mine, foes, board, bid.pr, slower, s);
    // Descending by price. Array sort is stable, so equal prices keep the order the leads are in.
    bids.sort((a, b) => b.first.value - a.first.value);
    let tr = board.tr;
    const tw = [...board.tw];
    const taken = new Set();
    for (const bid of bids) {
      // One condition per side and one action per lead: a second bid for either is already decided.
      if (setup.has(bid.m) || taken.has(bid.kind)) {
        if (!held.has(bid.m)) held.set(bid.m, { move: bid.move, why: "taken" });
        continue;
      }
      const assumed = tr === board.tr && tw[s] === board.tw[s] ? board : { ...board, tr, tw };
      const now = assumed === board ? bid.first : this.setupBid(bid.kind, bid.m, mine, foes, assumed, bid.pr, slower, s);
      if (now.value > this.altValue(bid.m, mine, foes, assumed, slower, s) + SETUP_MARGIN) {
        setup.set(bid.m, { kind: bid.kind, pr: bid.pr, value: now.value, move: bid.move });
        taken.add(bid.kind);
        if (bid.kind === TRICK_ROOM) tr = TRICK_ROOM_TURNS;
        else tw[s] = TAILWIND_TURNS;
      } else {
        held.set(bid.m, { move: bid.move, why: now.why === "ok" ? "notworth" : now.why });
      }
    }
    return { setup, held };
  }

  /**
   * What setting this condition is worth: the order it buys x what that order is worth x how
   * likely the setter is to get to use it.
   */
  setupBid(kind, m, mine, foes, board, pr, slower, s) {
    const tr = kind === TRICK_ROOM;
    const now = board.tr > 0;
    const base = this.orderWins(mine, foes, board, 1, now);
    const pairs = Math.max(1, base.pairs);
    // Trick Room's hypothetical is the inverted flag; Tailwind's is double Speed with the flag
    // unchanged, so doubling Speed under an existing Trick Room correctly scores as a LOSS.
    const after = tr ? this.orderWins(mine, foes, board, 1, !now).wins : this.orderWins(mine, foes, board, 2, now).wins;
    const lead = (after - base.wins) / pairs;
    // Half the field, half the bring behind it: Trick Room is set for the slow Pokémon that come
    // in later, not only for the two on the field. `slower` is the bring-level signal `play`
    // already computes and already keys the turn-1 memo on, so this adds no new input. Tailwind is
    // judged on the field alone (it is one-sided and shorter, and the field is what it buys).
    const bring = slower[s] ? 1 : slower[1 - s] ? -1 : 0;
    const swing = tr ? 0.5 * lead + 0.5 * bring : lead;
    // The test that replaces the old `slower` gate -- and what lets the mirror exist at all,
    // because both sides may now bid.
    if (swing <= 0) return { value: 0, why: "nogain" };
    if (tr && foes.some((f) => alive(f) && f.k.trickRoom)) {
      // Whoever moves second at -7 turns it straight off again, so neither side should spend the
      // turn on it. Only when the inversion would suit them too: an inversion that hurts them is
      // one they will not undo.
      const theirs = this.orderWins(foes, mine, board, 1, now);
      if (this.orderWins(foes, mine, board, 1, !now).wins > theirs.wins) return { value: 0, why: "mirror" };
    }
    // What the order is worth this turn: what the foes can actually do to us, on the same 0..1
    // HP-share-per-foe threat Fake Out already targets by.
    let stakes = 0;
    for (const foe of foes) if (alive(foe)) stakes += this.threatTo(foe, mine, board);
    const risk = this.setupRisk(m, mine, foes, board, pr);
    return { value: swing * stakes * (tr ? TRICK_ROOM_WEIGHT : TAILWIND_WEIGHT) * (1 - risk.p), why: risk.p >= 0.5 ? risk.why : "ok" };
  }

  /**
   * The single likeliest thing that stops this setter before it moves -- never a product, so the
   * reason stays explainable.
   *
   * Counts only what the turn does ANYWAY, never what the other side could CHOOSE. In particular
   * NOT Taunt: a Taunt is a simultaneous choice and the model already plays it out (tauntTarget
   * scores their setter at 3 and a taunted setter loses its action), so pricing it here as well
   * would let the setter fold against a threat that is then never spent, and the "Taunt stopped
   * their Trick Room" line would vanish from the results.
   */
  setupRisk(m, mine, foes, board, pr) {
    const sp = this.speed(m, board);
    const blocked = mine.some((x) => alive(x) && x.k.priorityBlock);
    let p = 0;
    let why = "ok";
    const bump = (q, w) => { if (q > p) { p = q; why = w; } };
    // Fake Out is forced on the other side and its target score puts a setup carrier first, so it
    // lands on one of ours -- but with two carriers only one of them is hit.
    let carriers = 0;
    for (const x of mine) if (alive(x) && (x.k.trickRoom || x.k.tailwind) && !x.k.flinchProof) carriers += 1;
    let incoming = 0;
    for (const foe of foes) {
      if (!alive(foe)) continue;
      if (foe.k.fakeOut >= 0 && !m.k.flinchProof && !blocked && pr < 3 && this.hitOn(foe, m, foe.k.fakeOut, board, false).frac > 0) {
        bump(1 / Math.max(1, carriers), "fakeout");
      }
      // Knocked out first: only the foes that move before this lead at this priority count.
      const best = this.strike(foe.u, m.u, board, foe.atk, foe.spa, false, foe.burn, foe.hp);
      const before = best.priority > pr || (best.priority === pr && this.speed(foe, board) > sp);
      if (best.frac > 0 && before) incoming += best.frac;
    }
    if (incoming >= m.hp && !(m.sash && m.hp >= 0.999)) bump(0.9, "ko");
    return { p, why };
  }

  /** One side's turn-1 plan: one action per lead. */
  planSide(s, active, board, slower, firstTurn = true) {
    const mine = active[s];
    const foes = active[1 - s];
    const foeBlocks = foes.some((f) => alive(f) && f.k.priorityBlock);
    const partners = mine.filter(alive).length;
    const plan = [];
    const faked = [];
    let tailwindTaken = board.tw[s] > 0;
    let roomTaken = false;
    let redirectTaken = false;
    // Which setup moves are worth their turn (rule 1), or none of them (rule 0, which forces both
    // below exactly as every recording made before the rule saw them).
    const { setup, held } = this.turnOneRule >= 1 ? this.planSetup(s, mine, foes, board, slower) : NO_SETUP;
    // The plays that decide the turn: Fake Out, Tailwind, Trick Room.
    for (const m of mine) {
      if (!alive(m)) continue;
      const k = m.k;
      const a = { m, s, kind: 0, pr: 0, sp: this.speed(m, board), value: 0, target: null, hit: null, slot: -1, move: "" };
      plan.push(a);
      if (firstTurn && k.fakeOut >= 0 && !foeBlocks) {
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
      if (this.turnOneRule >= 1) {
        const chosen = setup.get(m);
        if (chosen) {
          Object.assign(a, chosen);
          if (chosen.kind === TAILWIND) tailwindTaken = true;
          else roomTaken = true;
          continue;
        }
        // It carries a setup move and is not using it: say so, then fall through to the rest of
        // the chain, which gives it an attack, a Taunt or whatever else is worth more.
        const back = held.get(m);
        if (back) a.held = back;
      } else {
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
      const pick = this.pickTarget(m, foes, board, mine, firstTurn);
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
    // Seat rule 1: every lead is judged against the plans as they stand before ANY of them
    // Protects, and the choices are applied together. In one sequential pass side 0's Protect
    // takes its own attack out of the damage side 1 then prices its Protect against, so in a
    // mirror side 0's Salamence Protected and side 1's identical Salamence did not.
    const decided = [];
    for (const a of all) {
      if (!a.m.k.protect || !protectable(a)) continue;
      // Protect fails when its user protected the turn before (TOURNAMENT_GUARD). Without this, four
      // planned turns let a lead refuse every one of them for nothing.
      if (this.guardRule >= 1 && a.m.guardedLast) continue;
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
      if (!(incoming >= a.m.hp) || sashHolds) continue;
      if (this.seatRule >= 1) decided.push(a);
      else Object.assign(a, { kind: PROTECT, pr: 4, target: null, move: "Protect" });
    }
    for (const a of decided) Object.assign(a, { kind: PROTECT, pr: 4, target: null, move: "Protect" });
  }

  /** Wide Guard and Quick Guard, one of each per side. Seat rule 1 decides both sides against the
   *  plans as they stand before either has guarded, then applies the choices together, so which
   *  side is asked first cannot change the answer. */
  planSideGuards(plans, board, replaceable) {
    const decided = [];
    const take = (a, patch) => {
      if (this.seatRule >= 1) decided.push([a, patch]);
      else Object.assign(a, patch);
    };
    for (let s = 0; s < 2; s += 1) {
      const mine = plans[s];
      const foes = plans[1 - s];
      const own = mine.map((a) => a.m);
      // One of each per side: under the two-pass rule the choice is not on the action yet, so the
      // count is kept here. Nothing else in the turn sets either guard, so this reads the same.
      let wideTaken = mine.some((b) => b.kind === WIDE_GUARD);
      let quickTaken = mine.some((b) => b.kind === QUICK_GUARD);
      for (const a of mine) {
        if (!replaceable(a) || (!a.m.k.wideGuard && !a.m.k.quickGuard)) continue;
        if (a.m.k.wideGuard && !wideTaken) {
          let blocked = 0;
          for (const x of [...foes, ...mine]) {
            const slot = x.kind === ATTACK || x.kind === SPEED_DROP || x.kind === LOWER ? x.slot : -1;
            const info = slot >= 0 ? x.m.u.moves[slot] : null;
            if (!info?.spread || (x.s === s && !info.allyHit)) continue;
            for (const target of own) if (alive(target) && target !== x.m) blocked += this.hitScore(this.plannedDamage(x, target, board), target);
          }
          if (blocked > a.value + 0.3) {
            take(a, { kind: WIDE_GUARD, pr: 3 + (a.m.k.prankster ? 1 : 0), target: null, value: blocked, move: "Wide Guard" });
            wideTaken = true;
            continue;
          }
        }
        if (a.m.k.quickGuard && !quickTaken) {
          const pr = 3 + (a.m.k.prankster ? 1 : 0);
          let blocked = 0;
          for (const x of foes) {
            if (x.pr <= 0 || !x.target || x.target.s !== s || x.pr > pr || (x.pr === pr && x.sp >= a.sp)) continue;
            if (x.kind === FAKE_OUT) blocked += Math.max(0.8, mine.find((b) => b.m === x.target)?.value || 0);
            else blocked += this.hitScore(this.plannedDamage(x, x.target, board), x.target);
          }
          if (blocked > a.value + 0.3) {
            take(a, { kind: QUICK_GUARD, pr, target: null, value: blocked, move: "Quick Guard" });
            quickTaken = true;
          }
        }
      }
    }
    for (const [a, patch] of decided) Object.assign(a, patch);
  }

  /** Why a status move aimed at a Pokémon fails now ("" when it lands). */
  statusBlock(a, target, board) {
    if (!alive(target)) return "gone";
    if (target.guard) return "Protect";
    if (a.pr > 0 && board.quick & (1 << target.s)) return "Quick Guard";
    return "";
  }

  /** Turn 1 for the leads: entry, then one action each. `slower[s]` = side s brought the slower Pokémon. */
  turnOne(active, board, slower, events, stances = null) {
    // Entry order is by the Speed each one has as it comes in: a Mega Stone holder is still
    // its base form until it Mega-Evolves later in the turn.
    const entrants = [...active[0], ...active[1]].filter(Boolean)
      .sort((a, b) => this.entrySpeedOf(b.u) - this.entrySpeedOf(a.u) || (this.seatRule >= 1 ? byIdentity(a.u, b.u) : a.s - b.s));
    for (const m of entrants) this.enter(m, active, board, events);
    board.wide = 0;
    board.quick = 0;

    this.plannedTurn(active, board, slower, 1, events, stances);
  }

  /**
   * One PLANNED turn: both sides plan with the full chain (`planSide`), the guards answer what the
   * other side planned (`planGuards`), and the actions go in priority-then-Speed order.
   *
   * Turn 1 is this with the entry Abilities in front of it, and it is what version 0 of
   * TOURNAMENT_DEPTH plays exactly once -- every turn after it was `pickTarget` and nothing else.
   * Version 1 plays turn 2 through here too and version 2 turns 3 and 4 as well, so Protect, the
   * guards, sleep, Taunt, Encore, Helping Hand and a second Trick Room or Tailwind are available on
   * every one of them. Protect is the one action that is not simply available again: it fails when its
   * user protected the turn before (TOURNAMENT_GUARD), which is what stops four planned turns from
   * paying a lead four times for refusing.
   *
   * `firstTurn` is `turn <= 1`: Fake Out and First Impression only work on the turn their user came
   * in, and only turn 1's leads have come in here (a replacement entering later is refilled by
   * `refill`, which does not plan a turn for it).
   *
   * `stances` is null for the ordinary turn, or `[ourStance, theirStance]` while the scoring game is
   * searched; `board.tr` is 0 on turn 1 for every field rule (`freshBoard`), so passing it to
   * `orderActions` leaves turn 1 exactly as it was.
   */
  /**
   * Bend a planned side into one of the three stances the search tries (TOURNAMENT_DEPTH).
   *
   * STANCE_PLAN is the line `planSide` decided, untouched. STANCE_GUARD has everyone who carries
   * Protect use it -- the turn a side refuses, which is the answer version 0 could never give to a
   * lead about to be knocked out from turn 2 on. STANCE_ATTACK has everyone attack, which is the
   * line that gives up its support to end the game faster.
   *
   * `helped` is cleared first on both the plan entry and the Pokemon: Helping Hand is chosen inside
   * `planSide` and marks its partner there, so overwriting the helper without clearing the mark
   * would leave a boosted attack with nothing boosting it.
   */
  applyStance(plan, stance, active, board) {
    if (stance === STANCE_PLAN) return plan;
    for (const a of plan) {
      a.helped = false;
      if (a.m) a.m.helped = false;
    }
    for (const a of plan) {
      const m = a.m;
      if (!m || !alive(m)) continue;
      if (stance === STANCE_GUARD) {
        // A Pokemon that protected last turn cannot protect again (TOURNAMENT_GUARD), so the stance
        // may not hand it a Protect either. Stances are only ever applied to turn 1, where nothing has
        // protected yet, so this bites nowhere today -- it is here so the stance can never offer a
        // Protect the turn itself would refuse.
        if (m.k.protect && !(this.guardRule >= 1 && m.guardedLast)) Object.assign(a, { kind: PROTECT, pr: 4, target: null, hit: null, slot: -1, move: "Protect" });
        continue;
      }
      // STANCE_ATTACK: its best attack, with Fake Out and First Impression out (this is turn 1 of a
      // searched game, so `pickTarget`'s first-turn moves are the ones `planSide` already offered;
      // the stance is the all-out line, not a different first-turn trick).
      const foes = active[1 - a.s];
      const pick = this.pickTarget(m, foes, board, active[a.s], false);
      if (pick) {
        Object.assign(a, {
          kind: ATTACK, target: pick.foe, hit: pick.hit, slot: pick.hit.slot, pr: pick.hit.priority,
          value: this.attackValue(m, pick, foes, board), move: m.u.moves[pick.hit.slot].name,
        });
      }
    }
    return plan;
  }

  /**
   * `given` is `[ourPlan, theirPlan]` when the caller has ALREADY decided both sides' actions --
   * which is what the Solver does for the turn it is searching (builder/solver.js). The planning
   * chain is then skipped entirely: `planSide` would overwrite the chosen actions and `planGuards`
   * would answer a plan nobody made. Everything after it is the ordinary turn, so a searched turn
   * and a played turn resolve through one piece of code. Null everywhere else, so nothing that
   * existed before this reads differently.
   */
  plannedTurn(active, board, slower, turn, events, stances, given = null) {
    board.wide = 0;
    board.quick = 0;
    const firstTurn = turn <= 1;
    const plans = given || [this.planSide(0, active, board, slower, firstTurn), this.planSide(1, active, board, slower, firstTurn)];
    if (!given) {
      if (stances) for (let s = 0; s < 2; s += 1) this.applyStance(plans[s], stances[s], active, board);
      this.planGuards(plans, board);
    }
    // A setup move that was priced and left unused is part of what happened this turn, so the
    // results can say why the condition never went up.
    if (events) for (const plan of plans) for (const a of plan) if (a.held) events.push({ s: a.s, kind: "heldback", actor: a.m.u, move: a.held.move, why: a.held.why });
    const actions = orderActions([...plans[0], ...plans[1]].filter((a) => a.kind), board.tr > 0, turn, this.seatRule);
    // Twins the order cannot separate act on the state their run began with (seat rule 1).
    const runs = this.seatRule >= 1 ? tieRuns(actions) : null;
    const redirector = [null, null];
    for (let i = 0; i < actions.length; i += 1) {
      const a = actions[i];
      const { m, s } = a;
      if (runs && runs[i] === i) freezeRun(actions, runs, i);
      const pre = a.pre || m;
      if (pre.out || pre.flinch) continue;
      if (pre.idle > 0) {
        m.idle -= 1;
        continue;
      }
      const foes = active[1 - s];
      if (pre.taunted && (STATUS_ACTIONS.has(a.kind) || (a.kind === LOWER && !m.u.moves[a.slot].damaging))) {
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
        const fakeHit = this.hitOn(m, target, m.k.fakeOut, board, m.helped, pre);
        if (this.deal(m, target, fakeHit, events)) this.oweSelf(m, fakeHit.self);
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
        const done = this.attack(m, null, { slot: a.slot, spread: m.u.moves[a.slot].spread }, foes, active[s], board, null, events, pre);
        events?.push({ s, kind: "speeddrop", actor: m.u, move: a.move, targets: done.lowered.map((x) => x.m.u), own: done.own.map((x) => x.m.u) });
      } else if (a.kind === ATTACK || a.kind === LOWER) {
        const hit = a.hit || { slot: a.slot, spread: m.u.moves[a.slot].spread };
        const done = this.attack(m, a.target || foes.find(alive) || null, hit, foes, active[s], board, redirector[1 - s], events, pre);
        const drops = [...done.lowered, ...done.own];
        if (drops.length) events?.push({ s, kind: "lower", actor: m.u, move: m.u.moves[hit.slot].name, targets: done.lowered.map((x) => x.m.u), own: done.own.map((x) => x.m.u), stats: drops[0].stats });
      }
    }
    board.wide = 0;
    board.quick = 0;
    this.endOfTurn(active, events);
    // What each side actually did, for a caller that wants to report the turn. The Tournament
    // Test ignores it -- every call site drops it -- so this is observationally inert for the
    // recorded vectors; it exists because the Solver's trace has no other way to learn what the
    // planner chose, and the entries are the guard-corrected ones (`planGuards` rewrites them in
    // place before the action loop), which is what the turn really did rather than what it meant
    // to do.
    return plans;
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
      // A twin of the user's own run counts as not having moved (seat rule 1): the two are the
      // same Pokémon at the same Speed, so whichever was listed first only moved first by chance
      // -- and Encoring that would hand the whole exchange to one seat (measured on team10's
      // mirror: two Mega Raichu Y, one Encore-locked and one not, 43.56 instead of 50.00).
      const acted = a.pre && target.runTag === a.pre.tag ? 0 : target.acted;
      if (!acted || target.k.tauntProof) {
        events?.push({ s, kind: "encorefail", actor: m.u, target: target.u });
        return;
      }
      if (acted === ATTACK || acted === SPEED_DROP || acted === LOWER) return;
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
  attack(m, target, hit, foes, allies, board, redirector, events, pre = m) {
    const slot = hit.slot;
    const info = m.u.moves[slot];
    const out = { lowered: [], own: [] };
    if (!info) return out;
    const wide = board.wide || 0;
    const quick = board.quick || 0;
    // One move use owes its own cost once, however many Pokemon it hits (`oweSelf`).
    let selfCost = 0;
    if (hit.spread) {
      if (wide & (1 << (1 - m.s))) events?.push({ s: m.s, kind: "blocked", actor: m.u, move: info.name, by: "Wide Guard" });
      else {
        for (const foe of foes) {
          if (!alive(foe)) continue;
          const h = this.hitOn(m, foe, slot, board, m.helped, pre);
          if (h.priority > 0 && quick & (1 << foe.s)) continue;
          if (!this.deal(m, foe, h, events)) continue;
          selfCost = Math.max(selfCost, h.self || 0);
          const stats = this.afterHit(m, foe, info);
          if (stats.length) out.lowered.push({ m: foe, stats });
        }
      }
      if (allies && info.allyHit && !(wide & (1 << m.s))) {
        for (const ally of allies) {
          if (!alive(ally) || ally === m) continue;
          const h = this.hitOn(m, ally, slot, board, m.helped, pre);
          if (!this.deal(m, ally, h, events, true)) continue;
          selfCost = Math.max(selfCost, h.self || 0);
          const stats = this.afterHit(m, ally, info);
          if (stats.length) out.own.push({ m: ally, stats });
        }
      }
      this.oweSelf(m, selfCost);
      return out;
    }
    let aim = target ? this.redirected(m, target, redirector) : null;
    if (!aim || aim.out) aim = foes.find(alive) || null;
    if (!aim) return out;
    const h = this.hitOn(m, aim, slot, board, m.helped, pre);
    if (h.priority > 0 && quick & (1 << aim.s)) {
      events?.push({ s: m.s, kind: "blocked", actor: m.u, target: aim.u, move: info.name, by: "Quick Guard" });
      return out;
    }
    if (this.deal(m, aim, h, events)) {
      this.oweSelf(m, h.self);
      const stats = this.afterHit(m, aim, info);
      if (stats.length) out.lowered.push({ m: aim, stats });
    }
    return out;
  }

  /** The end of a turn: what this turn's own moves cost their user (`oweSelf`), then a burn
   *  takes 1/16 of its HP. */
  endOfTurn(active, events) {
    for (const side of active) {
      for (const m of side) {
        // An empty slot is a null here, so the owed cost is read after that check and not before.
        if (!m) continue;
        const owed = m.selfOwed || 0;
        if (owed) {
          m.selfOwed = 0;
          if (alive(m)) {
            m.hp -= owed;
            if (m.hp <= 1e-9) {
              m.hp = 0;
              m.out = true;
              events?.push({ s: m.s, kind: "recoil", actor: m.u });
            } else this.berry(m);
          }
        }
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

  /**
   * Empty slots take the next Pokémon from the back, which then enters (Intimidate, weather, terrain).
   *
   * Seat rule 1: everyone replaced this turn is on the field before ANY of them triggers, and they
   * trigger in the Speed order they come in at, as on turn 1. Under version 0 each side was filled
   * in turn, so side 1's replacement walked into side 0's -- its Intimidate lowered the Attack of
   * a Pokémon that had already come in -- while side 0's replacement met an empty slot. In a mirror
   * that alone cost side 0 an Attack stage on every simultaneous replacement (measured: team11's
   * bring [1,2,3,4] came out at 44.21 instead of 50.00), and it put the weather of whichever side
   * refilled second on the board whatever the Speed.
   */
  refill(active, sides, next, board) {
    const arriving = [];
    for (let s = 0; s < 2; s += 1) {
      for (let slot = 0; slot < active[s].length; slot += 1) {
        const m = active[s][slot];
        if (m) {
          m.flinch = false;
          // Read before `guard` is cleared: this is what the next turn's Protect is refused for
          // (TOURNAMENT_GUARD). `refill` runs at the end of every turn, so it is exactly "last turn".
          m.guardedLast = m.guard;
          m.guard = false;
          m.helped = false;
          m.taunted = false;
          m.acted = 0;
          if (!m.out) continue;
        }
        const incoming = next[s] < sides[s].length ? sides[s][next[s]++] : null;
        active[s][slot] = incoming;
        if (!incoming) continue;
        if (this.seatRule >= 1) arriving.push(incoming);
        else this.enter(incoming, active, board, null);
      }
    }
    arriving.sort((a, b) => this.entrySpeedOf(b.u) - this.entrySpeedOf(a.u) || byIdentity(a.u, b.u));
    for (const m of arriving) this.enter(m, active, board, null);
  }

  /** An empty field: no weather, no terrain, nobody's Tailwind, no Trick Room. Under field rule 0 it
   *  starts on the shared settings' weather and terrain instead (TOURNAMENT_FIELD). */
  freshBoard() {
    return { w: this.fixedWeather, t: this.fixedTerrain, tw: [0, 0], tr: 0, trBy: -1, wide: 0, quick: 0 };
  }

  /** How many turns of the scoring game are PLANNED rather than attack-only (TOURNAMENT_DEPTH):
   *  four under version 2, two under version 1. One number, read by every caller that builds a
   *  `deep` argument (`playDeep` for the search, `playTeam` for the recorded game), because the
   *  recorded game must be the very game the score came from -- a recorded game one turn shallower
   *  than the searched one would tell a story that does not add up to the number beside it. */
  plannedTurns() {
    return this.depthRule >= 2 ? 4 : 2;
  }

  /**
   * The scoring game, searched (TOURNAMENT_DEPTH).
   *
   * Both sides pick a turn-1 stance and the game is played once for every pair, `plannedTurns()` deep
   * (four turns under version 2, two under version 1), so one matchup is played STANCES.length squared
   * times instead of once. Nine playouts, whatever the depth: the stances are a turn-1 choice, so
   * deepening the game lengthens each playout and does not add any. Each side then takes
   * its best path by the same rule `chooseBrings` uses for the bring, and INDEPENDENTLY of the
   * other: ours is the stance whose worst case against their three is highest, theirs is the stance
   * whose best case for us is lowest (each ties to the better average, then the lower stance). They
   * choose blind, exactly as they bring blind -- read as a reply to ours the search would be
   * one-sided and a team would stop scoring 50 against itself. A side is therefore never credited
   * for a line the other side can simply refuse, which is what an unanswerable turn 1 was worth
   * under version 0.
   *
   * @returns {{value:number, mean:number, a:number, b:number, grid:number[][]}} the chosen pair
   */
  playDeep(ours, theirs) {
    const grid = STANCES.map((a) => STANCES.map((b) => this.play(ours, theirs, null, false, { stances: [a, b], plannedTurns: this.plannedTurns() }).value));
    const count = Math.max(1, grid[0]?.length || 0);
    // Ours: the stance whose WORST case is highest (ties to the better average, then the lower
    // stance) -- `chooseBrings`'s own rule, on the same grid shape.
    let best = { value: -1, mean: -1, a: 0 };
    for (let a = 0; a < grid.length; a += 1) {
      let low = 101;
      let sum = 0;
      for (let b = 0; b < count; b += 1) {
        const value = grid[a][b];
        sum += value;
        if (value < low) low = value;
      }
      const mean = sum / count;
      if (low > best.value + 1e-9 || (Math.abs(low - best.value) <= 1e-9 && (mean > best.mean + 1e-9 || (Math.abs(mean - best.mean) <= 1e-9 && a < best.a)))) {
        best = { value: low, mean, a };
      }
    }
    // Theirs, computed the same way from their own side of the grid and NOT as an answer to ours:
    // both sides choose blind, which is what keeps the test even. A stance pair read as a reply
    // would make the search one-sided, and then a team would stop scoring 50 against itself.
    let theirBest = { value: 101, mean: 101, b: 0 };
    for (let b = 0; b < count; b += 1) {
      let top = -1;
      let sum = 0;
      for (let a = 0; a < grid.length; a += 1) {
        const value = grid[a][b];
        sum += value;
        if (value > top) top = value;
      }
      const mean = sum / Math.max(1, grid.length);
      if (top < theirBest.value - 1e-9 || (Math.abs(top - theirBest.value) <= 1e-9 && (mean < theirBest.mean - 1e-9 || (Math.abs(mean - theirBest.mean) <= 1e-9 && b < theirBest.b)))) {
        theirBest = { value: top, mean, b };
      }
    }
    return { value: grid[best.a][theirBest.b], mean: best.mean, a: best.a, b: theirBest.b, grid };
  }

  /**
   * One game between two brings.
   * @param {object} ours    a plan from plansFor (our side)
   * @param {object} theirs  a plan from plansFor (their side)
   * @param {Map|null} memo  turn-1 outcomes by leads, for games of the same tournament team
   * @param {boolean} record return what happened on turn 1 and after it
   */
  play(ours, theirs, memo = null, record = false, deep = null) {
    const sides = [
      ours.members.map((u, i) => this.fresh(u, 0, i < ours.leads)),
      theirs.members.map((u, i) => this.fresh(u, 1, i < theirs.leads)),
    ];
    const active = [sides[0].slice(0, ours.leads), sides[1].slice(0, theirs.leads)];
    const next = [ours.leads, theirs.leads];
    const slower = [ours.mean < theirs.mean, theirs.mean < ours.mean];
    let board = this.freshBoard();
    const events = record ? [] : null;
    const memoKey = memo && !record && !deep ? `${ours.leadKey}|${theirs.leadKey}|${slower[0] ? 1 : slower[1] ? 2 : 0}` : "";
    const saved = memoKey ? memo.get(memoKey) : undefined;
    if (saved) {
      board = { ...saved.board, tw: [...saved.board.tw] };
      for (let s = 0; s < 2; s += 1) saved.leads[s].forEach((state, i) => Object.assign(active[s][i], state));
    } else {
      this.turnOne(active, board, slower, events, deep ? deep.stances : null);
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
    // The PLANNED turns after turn 1 (TOURNAMENT_DEPTH: two of them under version 1, four under
    // version 2). Each one's bookkeeping is the attack-only loop's own: actions, endOfTurn (inside
    // plannedTurn), then the condition counters, then the refill. Turn 1 deliberately does not tick
    // the counters, which is what makes a Trick Room set on turn 1 last its five turns; every turn
    // after it does, planned or not. The loop leaves `turn` at plannedTurns + 1, so the attack-only
    // loop below finishes the same turn budget (TURN_CAP) it always did -- a deeper plan does not buy
    // a longer game, it only replaces attack-only turns with planned ones.
    const plannedTurns = deep ? Math.max(0, Math.trunc(Number(deep.plannedTurns) || 0)) : 0;
    for (; turn <= plannedTurns; turn += 1) {
      if (!active[0].some(alive) || !active[1].some(alive)) break;
      this.plannedTurn(active, board, slower, turn, events, null);
      if (board.tw[0]) board.tw[0] -= 1;
      if (board.tw[1]) board.tw[1] -= 1;
      if (board.tr) board.tr -= 1;
      this.refill(active, sides, next, board);
    }
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
      orderActions(actions, board.tr > 0, turn, this.seatRule);
      const runs = this.seatRule >= 1 ? tieRuns(actions) : null;
      for (let i = 0; i < actions.length; i += 1) {
        const a = actions[i];
        if (runs && runs[i] === i) freezeRun(actions, runs, i);
        const pre = a.pre || a.m;
        if (pre.out) continue;
        this.attack(a.m, a.target, a.hit, active[1 - a.s], active[a.s], board, null, null, pre);
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

  /**
   * The field a 1-on-1 between these two is fought on (TOURNAMENT_TURN_ONE version 2): a fresh
   * board, plus the weather and terrain THESE TWO bring. A duel is averaged over every team the
   * defender appears on (`row.perSlot[slot] / row.count`), so it is only a number about the pair
   * if the field is decided by the pair: a Trick Room or a Tailwind from one chosen game belongs
   * to whoever led there, often neither duellist, and expires after 4 or 5 turns while `duel`
   * counts a race of up to 99 hits.
   *
   * Weather and terrain stay, because for these two they are not borrowed: a duellist's Drought
   * really is the field of this 1 vs 1 -- dropping it would score a Torkoal's Eruption or a
   * Pelipper's Hurricane out of the weather the threat list most needs them priced in. The board is
   * their only source now (TOURNAMENT_FIELD), so a pinned setting cannot stand here either; under
   * field rule 0 `freshBoard` brings the pinned field in and `kit.weather` is "" instead. They are applied in
   * `turnOne`'s own entry order (fastest in first, each setter overwriting), so the SLOWER
   * setter's field stands, exactly as in a real game; on an exact Speed tie the field of the
   * threat stands, because it is applied second here.
   *
   * That last tie is the one thing left in the file that a side decides: it is not part of the
   * battle model (the seat rule covers `turnOne`, `play` and `refill`, and a duel has no sides --
   * `duel` is always called with our unit first), and it reaches only the duel column and the
   * biggest-threats answer, never a score (tests/run-tournament-smoke.mjs proves the headline
   * cannot come from the duels). Deciding it by `byIdentity` too would move published duel
   * numbers for no gain in the test itself.
   */
  duelBoard(o, t) {
    const board = this.freshBoard();
    for (const unit of this.entrySpeedOf(t) > this.entrySpeedOf(o) ? [t, o] : [o, t]) {
      if (unit.kit.weather) board.w = WEATHERS.indexOf(unit.kit.weather);
      if (unit.kit.terrain) board.t = TERRAINS.indexOf(unit.kit.terrain);
    }
    return board;
  }

  /**
   * A 1-on-1 from full HP: hits to KO (lowest and highest roll) both ways, then who moves first.
   * `board` is the board the caller has; version 2 duels on `duelBoard` instead, and version 1
   * and below on the caller's, which is the board the chosen game left after turn 1.
   */
  duel(o, t, given) {
    const board = this.turnOneRule >= 2 ? this.duelBoard(o, t) : given;
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
   *
   * This is the lead matrix's cell (`refreshMatrix`), and under TOURNAMENT_DEPTH version 2 it is the
   * SAME searched game the headline is scored by. Up to version 1 it was one unsearched game of one
   * planned turn, which made the Matchups card contradict the score beside it. Measured on the bench
   * team of tests/run-tournament-smoke.mjs against 150 teams in Doubles, 2,055 cells: the unsearched
   * cell and the searched game disagree by more than a point on 69.9% of them (72.5% by more than
   * 0.01), worst 76.96 points. The headline is 59.457959 either way -- it never reads a matrix cell --
   * and the run costs no measurable extra time, because `refreshMatrix` runs once every MATRIX_EVERY
   * snapshots and `this.cells` keeps every cell it has played: measured at limit 1000, 73.7 s with a
   * shallow matrix against 73.2 s with a searched one, headline 58.605610 in both (and 24.7 s against
   * 24.2 s at limit 300, headline 57.779901 in both), so the difference is noise in both directions.
   */
  cellValue(ourPlan, theirPlan) {
    const key = `${ourPlan.leadKey}|${theirPlan.leadKey}`;
    let value = this.cells.get(key);
    if (value === undefined) {
      value = this.depthRule >= 2 ? this.playDeep(ourPlan, theirPlan).value : this.play(ourPlan, theirPlan).value;
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
      duelUnits: this.duelUnits(ours.map((o) => o.unit)),
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

  /**
   * Both sides' brings, read off the grid of every bring of ours (`c`) against every bring of
   * theirs (`d`): `grid[c][d]` is the value of that one game from our seat.
   *
   * OURS is the bring whose WORST answer is best -- what holds up whatever they bring -- with ties
   * going to the better average over their brings, then to the lower line-up. THEIRS depends on the
   * bring rule (TOURNAMENT_BRING):
   *   version 1  the same rule from their own seat, chosen without seeing ours. From our seat that
   *              is the column whose BEST case for us is worst, ties to their better worst case
   *              (our lower best), then their better average (our lower average), then their own
   *              lower line-up -- their index in their own plan list, which is the same list
   *              whichever seat they sit on, so a seat swap makes the same pick. With the seat rule
   *              making V(ours=c, theirs=d) + V(ours=d, theirs=c) exactly 100, this is their own
   *              maximin, so the two sides' reported scores add up to 100 and a team against itself
   *              reports exactly 50.
   *   version 0  the answer that hurts the bring we chose most, which only a side that could see
   *              our choice would find, so the number reported is below even.
   *
   * `totals[c]` is what the bring options card adds up for bring `c`: the game it plays against the
   * bring they commit to (version 1, so the card's "on average ... against every team" is what it
   * says), or its own worst case (version 0).
   *
   * @param {number[][]} grid
   * @returns {{c:number, d:number, value:number, mean:number, totals:number[]}}
   */
  chooseBrings(grid) {
    const theirCount = Math.max(1, grid[0]?.length || 0);
    const worst = [];
    let best = { value: -1, mean: -1, c: 0, d: 0 };
    for (let c = 0; c < grid.length; c += 1) {
      let low = 101;
      let lowD = 0;
      let sum = 0;
      for (let d = 0; d < theirCount; d += 1) {
        const value = grid[c][d];
        sum += value;
        if (value < low) {
          low = value;
          lowD = d;
        }
      }
      worst.push(low);
      const mean = sum / theirCount;
      if (low > best.value + 1e-9 || (Math.abs(low - best.value) <= 1e-9 && (mean > best.mean + 1e-9 || (Math.abs(mean - best.mean) <= 1e-9 && c < best.c)))) {
        best = { value: low, mean, c, d: lowD };
      }
    }
    if (this.bringRule < 1) return { ...best, totals: worst };
    let theirBest = { value: 101, mean: 101, d: 0 };
    for (let d = 0; d < theirCount; d += 1) {
      let top = -1;
      let sum = 0;
      for (let c = 0; c < grid.length; c += 1) {
        const value = grid[c][d];
        sum += value;
        if (value > top) top = value;
      }
      const mean = sum / Math.max(1, grid.length);
      if (top < theirBest.value - 1e-9 || (Math.abs(top - theirBest.value) <= 1e-9 && (mean < theirBest.mean - 1e-9 || (Math.abs(mean - theirBest.mean) <= 1e-9 && d < theirBest.d)))) {
        theirBest = { value: top, mean, d };
      }
    }
    return { value: grid[best.c][theirBest.d], mean: best.mean, c: best.c, d: theirBest.d, totals: grid.map((row) => row[theirBest.d]) };
  }

  /**
   * One cell of the bring grid. Under TOURNAMENT_DEPTH version 1 the cell is the SEARCHED game, the
   * same model the matchup is scored by -- the grid picks the bring and the score is one of its
   * cells, so the two must be the one model. Scoring a cell that a shallower model chose let the
   * bring rule's own guarantee go, that their blind bring is never a better answer for them than
   * their best reply (tests/run-tournament-bring.mjs).
   */
  cellFor(ours, theirs, memo) {
    if (this.depthRule < 1) return this.play(ours, theirs, memo).value;
    const key = `${ours.bringKey}|${theirs.bringKey}`;
    const saved = this.deepCells.get(key);
    if (saved !== undefined) return saved;
    const value = this.playDeep(ours, theirs).value;
    this.deepCells.set(key, value);
    return value;
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
    this.deepCells = new Map();
    // Every bring of ours against every bring of theirs, kept as a grid: under the bring rule
    // (TOURNAMENT_BRING) their own blind choice is read off these very games, so it costs none.
    const grid = [];
    for (let c = 0; c < state.plans.length; c += 1) {
      const row = [];
      for (let d = 0; d < theirPlans.length; d += 1) row.push(this.cellFor(state.plans[c], theirPlans[d], memo));
      grid.push(row);
      state.games += theirPlans.length;
    }
    const best = this.chooseBrings(grid);
    for (let c = 0; c < state.plans.length; c += 1) state.bringTotals[c].value += best.totals[c];
    const ourPlan = state.plans[best.c];
    const theirPlan = theirPlans[best.d];
    state.bringTotals[best.c].picked += 1;
    // The game whose value IS the matchup score. Under TOURNAMENT_DEPTH version 1 it is searched
    // first, then replayed with the chosen stances so that what the results show and what the score
    // says are one and the same game; under version 0 the score stays the grid cell `chooseBrings`
    // picked, which is the same game the grid already played.
    const searched = this.depthRule >= 1 ? this.playDeep(ourPlan, theirPlan) : null;
    const game = this.play(ourPlan, theirPlan, null, true, searched ? { stances: [searched.a, searched.b], plannedTurns: this.plannedTurns() } : null);
    // The grid cell IS the searched game under version 1, so the score stays the cell `chooseBrings`
    // picked under both rules and the recorded game is that very game, replayed for its story.
    const score = best.value;

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
    // The board this game left after turn 1. Version 2 of the turn-1 rule duels on `duelBoard`
    // instead and ignores this one; it is still handed over so version 1 and below replay.
    const afterTurnOneBoard = game.board;
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
        // The form this slot plays in the line-up that fights this duel -- itself, so a stone holder
        // duels as its own Mega (TOURNAMENT_MEGA, `duelUnits`).
        const win = this.duel(state.duelUnits[slot], t, afterTurnOneBoard);
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
    tally.value += score;
    if (score >= MATCHUP_BANDS.favourable) tally.favourable += 1;
    else if (score < MATCHUP_BANDS.unfavourable) tally.unfavourable += 1;
    else tally.even += 1;
    state.archetypes.set(archetype, tally);
    state.values.set(team.name, score);
    state.results.push({
      name: team.name,
      number: teamNumber(team.name),
      archetype,
      value: score,
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
        why: e.why || "",
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
      // From the quick duels, so named by the form that duelled (TOURNAMENT_MEGA): the form this
      // slot plays in a line-up of one, which is the form the branch above names as well.
      return { ...slotInfo(slot, state.duelUnits[slot]), win: row.perSlot[slot] / Math.max(1, row.count), value: null };
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
    // Nothing on the page draws this table (the biggest-threats answer and `weakTo` read `perSlot`
    // themselves), but it is what tests/run-tournament-smoke.mjs watches the duel numbers through --
    // both that turn 1 cannot reach them and that the headline cannot come from them -- so it stays:
    // deleting it would delete two guards, and it is ten rows of six numbers.
    const duels = {
      // Named by the forms that duelled (TOURNAMENT_MEGA), so the column head and the number below it
      // are the same Pokémon. Not a line-up: these are six separate 1-on-1s, each with one Pokémon of
      // ours in it, so two stone holders both duel as their own Megas -- where a bring, a lead pair
      // or a matrix row plays only one Mega, because those Pokémon stand on the field together.
      columns: state.ours.map((_, o) => slotInfo(o, state.duelUnits[o])),
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
      // The Field settings this run ignored, for the results to own up to (TOURNAMENT_FIELD).
      ignoredField: this.fieldRule >= 1 ? ignoredFieldSettings(this.ev.settings) : [],
      // A stat stage pinned on one side only, which the run DOES honour -- so 50 is not the even
      // score in it, and the results say so (`unevenStagePins`). null when both sides match.
      unevenStages: unevenStagePins(this.ev.settings, (text) => this.ev.applyStages({}, text)),
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
