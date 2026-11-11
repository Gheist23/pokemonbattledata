// The turn engine reads the Ability registry it is shipped (TOURNAMENT_ABILITY_OPS).
//
// THE FINDING, measured 3 Nov 2026: 62 of the game's 215 Abilities did nothing at all in a
// played game -- 935 appearances across the registered teams. Two causes, and the first is the
// one nobody would guess:
//
//   * of the 19 Ability ops the exporter shipped, the engine read SIX. `move-effects.json`
//     carried `on_hit_status_attacker`, `stat_drop_immunity`, `damage_taken`, `stat_multiplier`
//     and nine more every single day, and not one line of code ever looked at them. FLAME BODY
//     IS THE MOST-BROUGHT ABILITY IN THE WHOLE LIBRARY -- 329 appearances -- and touching a
//     Pokemon with it was completely safe;
//   * and 22 more the Companion models were not on the whitelist at all, which is the Disguise
//     shape (see run-disguise.mjs).
//
// What is checked:
//
//   1. the rule, and that it is off by default;
//   2. Flame Body, Static and Poison Point burn/paralyse/poison whoever makes contact, and a
//      non-contact move is safe -- with the A/B that proves the rule is doing it;
//   3. Poison Touch, the mirror: its holder poisons what IT touches;
//   4. an Ability that answers contact does not fire for a Pokemon that is already down;
//   5. Compound Eyes multiplies its holder's accuracy by 1.3 and nobody else's;
//   6. Big Pecks keeps its Defense when something tries to lower it, and keeps everything else
//      droppable;
//   7. Unnerve stops the OTHER side eating a berry, from either seat, and leaves its own alone;
//   8. the three newly shipped ops are really in the exported registry;
//   9. all three engines ask for the rule, and the Tournament Test still rolls nothing.
//
//   node tests/run-ability-ops.mjs
//
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData, makeSet } from "../builder/common.js";
import { DamageEngine } from "../builder/engine.js";
import { TeamEvaluator, normalizeSettings, DEFAULT_SETTINGS } from "../builder/team-eval.js";
import { TeamEvaluation } from "../builder/team-payload.js";
import { TeamSuggestions } from "../builder/team-suggest.js";
import { KnownTeams } from "../builder/known-teams.js";
import { TournamentTest, TOURNAMENT_ABILITY_OPS, tournamentAbilityOpsOption } from "../builder/tournament-test.js";
import { Solver } from "../builder/solver.js";
import { PlayGame, teamFromKnown } from "../builder/play-game.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));

let checked = 0;
const failures = [];
const notes = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const FORMAT = "Doubles";
const appData = read("data", "builder", "app-data.json");
const meta = read("data", "builder", `meta-${FORMAT.toLowerCase()}.json`);
const effects = read("data", "builder", "move-effects.json");
const knownRaw = read("data", "builder", "known-teams.json");
const data = new BuilderData(appData);
data.ingestMeta(FORMAT, meta);

function makeSolver(abilityOpsRule) {
  const ev = new TeamEvaluator(data, new DamageEngine(appData), FORMAT, normalizeSettings({ ...DEFAULT_SETTINGS }));
  ev.setMetaRecords(meta.pokemon || []);
  const evaluation = new TeamEvaluation(ev);
  return new Solver(new TournamentTest(evaluation, new KnownTeams(knownRaw),
    new TeamSuggestions(evaluation), { effects, liveHpRule: 1, berryRule: 1, abilityOpsRule }));
}

/** Any set from the meta, with whatever we need forced onto it. */
function setFor(species, extra = {}) {
  for (const r of meta.pokemon) {
    if (String(r.species).toLowerCase() !== species.toLowerCase()) continue;
    const base = data.commonSet(FORMAT, r.species, r.form);
    if (base && base.moves?.length) return makeSet({ ...base, moves: [...base.moves], ...extra });
  }
  const any = meta.pokemon.map((r) => data.commonSet(FORMAT, r.species, r.form)).find((s) => s && s.moves?.length);
  return makeSet({ ...any, moves: [...any.moves], ...extra });
}
const ANY = setFor("Garchomp");
const row = (set, extra = {}) => ({ set, hp: 100, front: false, ...extra });

/** A board with `mine` and `theirs` standing, and a hit of `frac` ready to use. */
function duel(rule, mine, theirs) {
  const solver = makeSolver(rule);
  const state = solver.buildState({
    sides: [[row(mine, { front: true }), row(ANY, { front: true })],
      [row(theirs, { front: true }), row(ANY, { front: true })]],
    field: {},
  });
  return { solver, state, me: state.active[0][0], foe: state.active[1][0] };
}
const hit = (frac, slot = 0) => ({ slot, frac, lo: frac, hi: frac, odds: 1, rollLo: frac, rollHigh: frac,
  priority: 0, spread: false, self: 0, rberry: false });

/** The share of a condition on a Pokemon, as this engine carries it. */
const cond = (m, field) => Math.round((m.st?.[field] || 0) * 1000) / 1000;

/* -------------------------------------------- 1. the rule */
{
  ok("TOURNAMENT_ABILITY_OPS is 0", TOURNAMENT_ABILITY_OPS === 0, String(TOURNAMENT_ABILITY_OPS));
  ok("the option reader turns it off for an older recording",
    tournamentAbilityOpsOption(null) === 0 && tournamentAbilityOpsOption(1) === 1);
  ok("an engine built with the default does not model it", makeSolver(0).t.abilityOpsOn === false);
}

/* -------------------------------------------- 2. the contact answers */
const CONTACT = [["Flame Body", "brn"], ["Static", "par"], ["Poison Point", "psn"]];
for (const [ability, field] of CONTACT) {
  const holder = setFor("Garchomp", { ability });
  // find a CONTACT move on the attacker's own sheet
  const solverPeek = makeSolver(1);
  const attacker = setFor("Garchomp");
  const slot = attacker.moves.findIndex((name) => solverPeek.t.moveInfo(name)?.contact);
  if (slot < 0) { notes.push(`${ability}: no contact move on the test attacker, skipped`); continue; }

  const off = duel(0, attacker, holder);
  off.solver.t.deal(off.me, off.foe, hit(0.2, slot), null, false, null, off.state.active[0]);
  ok(`rule 0: ${ability} does nothing`, cond(off.me, field) === 0, String(cond(off.me, field)));

  const on = duel(1, attacker, holder);
  ok(`${ability} is read onto the kit`, on.foe.k.contactStatus?.status
    && Math.abs(on.foe.k.contactStatus.chance - 0.3) < 1e-9, JSON.stringify(on.foe.k.contactStatus));
  on.solver.t.deal(on.me, on.foe, hit(0.2, slot), null, false, null, on.state.active[0]);
  ok(`${ability} answers a contact move`, cond(on.me, field) > 0, String(cond(on.me, field)));
  ok(`${ability} answers with its own 30%`, Math.abs(cond(on.me, field) - 0.3) < 1e-6,
    String(cond(on.me, field)));
  if (ability === "Flame Body") notes.push(`Flame Body: attacker carries ${cond(on.me, "brn")} of a burn`);

  // a NON-contact move is safe
  const nonContact = attacker.moves.findIndex((name) => {
    const info = solverPeek.t.moveInfo(name);
    return info && !info.contact && info.damaging;
  });
  if (nonContact >= 0) {
    const safe = duel(1, attacker, holder);
    safe.solver.t.deal(safe.me, safe.foe, hit(0.2, nonContact), null, false, null, safe.state.active[0]);
    ok(`${ability} does not answer a move that makes no contact`, cond(safe.me, field) === 0,
      String(cond(safe.me, field)));
  }
}

/* -------------------------------------------- 3. Poison Touch, the mirror */
{
  const solverPeek = makeSolver(1);
  const toucher = setFor("Garchomp", { ability: "Poison Touch" });
  const slot = toucher.moves.findIndex((name) => solverPeek.t.moveInfo(name)?.contact);
  const victim = setFor("Dragonite");
  if (slot >= 0) {
    const on = duel(1, toucher, victim);
    ok("Poison Touch is read onto the kit", on.me.k.touchStatus?.status === "poison",
      JSON.stringify(on.me.k.touchStatus));
    on.solver.t.deal(on.me, on.foe, hit(0.2, slot), null, false, null, on.state.active[0]);
    const got = cond(on.foe, "psn") + cond(on.foe, "tox");
    ok("Poison Touch poisons what it touches", got > 0, String(got));

    const off = duel(0, toucher, victim);
    off.solver.t.deal(off.me, off.foe, hit(0.2, slot), null, false, null, off.state.active[0]);
    ok("rule 0: it does not", cond(off.foe, "psn") + cond(off.foe, "tox") === 0);
  } else {
    notes.push("Poison Touch: no contact move on the test attacker, skipped");
  }
}

/* -------------------------------------------- 4. nothing answers from the grave */
{
  const solverPeek = makeSolver(1);
  const attacker = setFor("Garchomp");
  const slot = attacker.moves.findIndex((name) => solverPeek.t.moveInfo(name)?.contact);
  if (slot >= 0) {
    const on = duel(1, attacker, setFor("Garchomp", { ability: "Flame Body" }));
    on.solver.t.deal(on.me, on.foe, hit(3, slot), null, false, null, on.state.active[0]);
    ok("a knocked-out holder does not burn its killer", on.foe.out === true && cond(on.me, "brn") === 0,
      `out=${on.foe.out} brn=${cond(on.me, "brn")}`);
  }
}

/* -------------------------------------------- 5. Compound Eyes */
{
  const on = makeSolver(1);
  const off = makeSolver(0);
  // a move that can miss
  const name = ["Focus Blast", "Hydro Pump", "Stone Edge", "Hurricane", "Thunder", "Fire Blast", "Rock Slide"]
    .find((n) => appData.moves[n]);
  ok("the data has a move that can miss to test with", Boolean(name), String(name));
  if (name) {
    const info = on.t.moveInfo(name);
    const plain = { k: { accuracyBoost: 1 } };
    const keen = { k: { accuracyBoost: 1.3 } };
    const base = on.t.accuracyOf(info, plain);
    const boosted = on.t.accuracyOf(info, keen);
    ok("Compound Eyes raises its holder's accuracy", boosted > base || base === 1,
      `${base} -> ${boosted}`);
    ok("and never past certain", boosted <= 1, String(boosted));
    ok("rule 0: it does not", off.t.accuracyOf(info, keen) === base, String(off.t.accuracyOf(info, keen)));
    ok("and nobody else's accuracy moves", on.t.accuracyOf(info, plain) === base);
    const holder = setFor("Garchomp", { ability: "Compound Eyes" });
    const built = duel(1, holder, ANY);
    ok("the kit reads it from the registry", Math.abs(built.me.k.accuracyBoost - 1.3) < 1e-9,
      String(built.me.k.accuracyBoost));
    notes.push(`Compound Eyes: ${name} ${(base * 100).toFixed(0)}% -> ${(boosted * 100).toFixed(0)}%`);
  }
}

/* -------------------------------------------- 6. Big Pecks */
{
  const on = duel(1, setFor("Garchomp", { ability: "Big Pecks" }), ANY);
  ok("Big Pecks is read onto the kit", on.me.k.dropProof?.has("def") === true,
    JSON.stringify([...(on.me.k.dropProof || [])]));
  on.solver.t.shiftStages(on.me, ["defense"], -2);
  ok("its Defense cannot be lowered", (on.me.def || 0) === 0, String(on.me.def));
  on.solver.t.shiftStages(on.me, ["attack"], -2);
  ok("but its Attack still can", (on.me.atk || 0) < 0, String(on.me.atk));
  on.solver.t.shiftStages(on.me, ["defense"], 2);
  ok("and a RISE in Defense is not refused", (on.me.def || 0) > 0, String(on.me.def));

  const off = duel(0, setFor("Garchomp", { ability: "Big Pecks" }), ANY);
  off.solver.t.shiftStages(off.me, ["defense"], -2);
  ok("rule 0: the drop lands", (off.me.def || 0) < 0, String(off.me.def));
}

/* -------------------------------------------- 7. Unnerve */
{
  const berryHolder = setFor("Garchomp", { item: "Sitrus Berry" });
  const unnerver = setFor("Dragonite", { ability: "Unnerve" });

  const on = duel(1, berryHolder, unnerver);
  ok("Unnerve is read onto the kit", on.foe.k.unnerve === true, String(on.foe.k.unnerve));
  on.me.hp = 0.4;
  on.solver.t.berry(on.me, on.state.active[1]);
  ok("the berry is not eaten while Unnerve stands", Math.abs(on.me.hp - 0.4) < 1e-9, String(on.me.hp));
  ok("and it is still held", on.me.berry === true);

  // from the OTHER seat, not just the one in front
  const side = duel(1, berryHolder, ANY);
  side.state.active[1][1] = { ...side.state.active[1][1], k: { ...side.state.active[1][1].k, unnerve: true } };
  side.me.hp = 0.4;
  side.solver.t.berry(side.me, side.state.active[1]);
  ok("Unnerve works from the partner's seat too", Math.abs(side.me.hp - 0.4) < 1e-9, String(side.me.hp));

  // ...and the Unnerve holder's OWN side eats normally
  const own = duel(1, berryHolder, unnerver);
  own.foe.berry = true;
  own.foe.hp = 0.4;
  own.solver.t.berry(own.foe, own.state.active[0]);
  ok("its own side is unaffected", own.foe.hp > 0.4, String(own.foe.hp));

  const off = duel(0, berryHolder, unnerver);
  off.me.hp = 0.4;
  off.solver.t.berry(off.me, off.state.active[1]);
  ok("rule 0: the berry is eaten", off.me.hp > 0.4, String(off.me.hp));
  notes.push("Unnerve: the Sitrus stays uneaten while it stands");
}

/* -------------------------------------------- 7b. Gooey, Synchronize, Corrosion */
{
  const solverPeek = makeSolver(1);
  const attacker = setFor("Garchomp");
  const slot = attacker.moves.findIndex((name) => solverPeek.t.moveInfo(name)?.contact);
  if (slot >= 0) {
    const on = duel(1, attacker, setFor("Garchomp", { ability: "Gooey" }));
    ok("Gooey is read onto the kit", on.foe.k.contactStage?.stat === "speed"
      && on.foe.k.contactStage.amount === -1, JSON.stringify(on.foe.k.contactStage));
    on.solver.t.deal(on.me, on.foe, hit(0.2, slot), null, false, null, on.state.active[0]);
    ok("touching Gooey costs the attacker Speed", (on.me.spe || 0) < 0, String(on.me.spe));
    const off = duel(0, attacker, setFor("Garchomp", { ability: "Gooey" }));
    off.solver.t.deal(off.me, off.foe, hit(0.2, slot), null, false, null, off.state.active[0]);
    ok("rule 0: it does not", (off.me.spe || 0) === 0, String(off.me.spe));
  }
}
{
  const sync = duel(1, setFor("Garchomp", { ability: "Synchronize" }), setFor("Dragonite"));
  ok("Synchronize is read onto the kit", sync.me.k.reflectStatus?.has("burn") === true,
    JSON.stringify([...(sync.me.k.reflectStatus || [])]));
  sync.solver.t.applyStatus(sync.me, "burn", 1, sync.foe);
  ok("the holder is burned", cond(sync.me, "brn") > 0, String(cond(sync.me, "brn")));
  ok("and so is whoever burned it", cond(sync.foe, "brn") > 0, String(cond(sync.foe, "brn")));

  // two holders must not bounce it back and forth for ever
  const both = duel(1, setFor("Garchomp", { ability: "Synchronize" }),
    setFor("Dragonite", { ability: "Synchronize" }));
  both.solver.t.applyStatus(both.me, "burn", 1, both.foe);
  ok("two Synchronize holders settle", cond(both.me, "brn") <= 1 && cond(both.foe, "brn") <= 1,
    `${cond(both.me, "brn")} / ${cond(both.foe, "brn")}`);

  // ...and it does not reflect onto its own side, nor without a source
  const ally = duel(1, setFor("Garchomp", { ability: "Synchronize" }), setFor("Dragonite"));
  ally.solver.t.applyStatus(ally.me, "burn", 1, ally.state.active[0][1]);
  ok("it does not burn its own partner", cond(ally.state.active[0][1], "brn") === 0);
  const alone = duel(1, setFor("Garchomp", { ability: "Synchronize" }), setFor("Dragonite"));
  alone.solver.t.applyStatus(alone.me, "burn", 1);
  ok("a burn with no source reflects onto nobody", cond(alone.foe, "brn") === 0);

  const off = duel(0, setFor("Garchomp", { ability: "Synchronize" }), setFor("Dragonite"));
  off.solver.t.applyStatus(off.me, "burn", 1, off.foe);
  ok("rule 0: nothing comes back", cond(off.foe, "brn") === 0, String(cond(off.foe, "brn")));
  notes.push(`Synchronize: the source carries ${cond(sync.foe, "brn")} of the burn it gave`);
}
{
  // Corrosion goes through a Steel or Poison TYPE, and not through an Ability's immunity.
  const steel = meta.pokemon.map((r) => ({ r, s: data.commonSet(FORMAT, r.species, r.form) }))
    .find(({ r }) => (appData.species.find((sp) => sp.name === r.species)?.forms || [])
      .some((f) => (f.types || []).includes("Steel")));
  ok("the meta has a Steel type to test Corrosion on", Boolean(steel), "none found");
  if (steel) {
    const victim = makeSet({ ...steel.s, moves: [...steel.s.moves] });
    const on = duel(1, setFor("Garchomp", { ability: "Corrosion" }), victim);
    ok("Corrosion is read onto the kit", on.me.k.bypassTypeImmunity?.has("poison") === true,
      JSON.stringify([...(on.me.k.bypassTypeImmunity || [])]));
    ok("the victim really is poison-proof by type", on.foe.k.poisonProofByType === true);
    on.solver.t.applyStatus(on.foe, "poison", 1, on.me);
    ok("Corrosion poisons it anyway", cond(on.foe, "psn") > 0, String(cond(on.foe, "psn")));
    const plain = duel(1, setFor("Garchomp"), victim);
    plain.solver.t.applyStatus(plain.foe, "poison", 1, plain.me);
    ok("and anybody else still cannot", cond(plain.foe, "psn") === 0, String(cond(plain.foe, "psn")));
    notes.push(`Corrosion: poisons ${steel.r.species} through its Steel typing`);
  }
}

/* -------------------------------------------- 7c. Gale Wings */
{
  // A Flying move on a Gale Wings holder: +1 priority at FULL HP and not a point below it.
  const solverPeek = makeSolver(1);
  const flying = Object.keys(appData.moves).find((name) => {
    const m = appData.moves[name];
    return m.type === "Flying" && (m.category === "physical" || m.category === "special") && m.power
      && (solverPeek.t.movePriorityOf ? true : true) && (appData.movePriority?.[name] ?? 0) === 0;
  });
  ok("the data has a plain Flying attack to test with", Boolean(flying), String(flying));
  if (flying) {
    const holder = setFor("Garchomp", { ability: "Gale Wings", moves: [flying, ...ANY.moves].slice(0, 4) });
    const on = duel(1, holder, setFor("Dragonite"));
    ok("Gale Wings is read onto the kit", on.me.u.kit.galeWings === true, String(on.me.u.kit.galeWings));
    const at = (hp) => on.solver.t.moveHit(on.me.u, on.foe.u, 0, on.state.board, 0, 0, 0, hp,
      0, 0, false, 1, 0, 0, false);
    const full = at(1);
    const hurt = at(0.95);
    ok("at full HP the Flying move gains priority", (full?.priority || 0) > 0, JSON.stringify(full?.priority));
    ok("one point below full it does not", (hurt?.priority || 0) === 0, JSON.stringify(hurt?.priority));
    const off = duel(0, holder, setFor("Dragonite"));
    const offHit = off.solver.t.moveHit(off.me.u, off.foe.u, 0, off.state.board, 0, 0, 0, 1,
      0, 0, false, 1, 0, 0, false);
    ok("rule 0: no boost at all", (offHit?.priority || 0) === 0, JSON.stringify(offHit?.priority));
    // a NON-Flying move on the same Pokemon is untouched
    const other = holder.moves.findIndex((name, i) => i > 0 && appData.moves[name]
      && appData.moves[name].type !== "Flying" && appData.moves[name].power);
    if (other > 0) {
      const plain = on.solver.t.moveHit(on.me.u, on.foe.u, other, on.state.board, 0, 0, 0, 1,
        0, 0, false, 1, 0, 0, false);
      ok("and a move of another type is not lifted", (plain?.priority || 0) === 0,
        JSON.stringify(plain?.priority));
    }
    notes.push(`Gale Wings: ${flying} priority ${full?.priority} at full, ${hurt?.priority} at 95%`);
  }
}

/* -------------------------------------------- 7d. Cursed Body */
{
  const cursed = setFor("Dragonite", { ability: "Cursed Body" });
  const on = duel(1, setFor("Garchomp"), cursed);
  ok("Cursed Body is read onto the kit", on.foe.k.disableOnDamage?.turns === 4
    && Math.abs(on.foe.k.disableOnDamage.chance - 0.3) < 1e-9,
    JSON.stringify(on.foe.k.disableOnDamage));
  ok("nothing is disabled to begin with", on.me.disabledSlot === -1 && on.me.disabledTurns === 0);

  // ROLLED, so the engine needs a roll lent to it -- exactly as a played turn lends one.
  on.solver.t.effectRoll = () => 0;   // always inside the 30%
  on.solver.t.deal(on.me, on.foe, hit(0.2, 1), null, false, null, on.state.active[0]);
  ok("the move that hit is shut off", on.me.disabledSlot === 1 && on.me.disabledTurns === 4,
    `${on.me.disabledSlot}/${on.me.disabledTurns}`);
  ok("and the engine says that slot is unusable", on.solver.t.slotDisabled(on.me, 1) === true);
  ok("while its other moves are fine", on.solver.t.slotDisabled(on.me, 0) === false);

  // ...so it is missing from the action list the search and the player both read
  const offered = on.solver.slotCandidates(on.state, 0, 0, { cap: 0 })
    .filter((a) => a.slot === 1);
  ok("the shut-off move is not offered at all", offered.length === 0, JSON.stringify(offered));

  // it wears off
  for (let i = 0; i < 4; i += 1) on.solver.t.tickDisable(on.me);
  ok("after four turns it comes back", on.me.disabledSlot === -1 && on.me.disabledTurns === 0,
    `${on.me.disabledSlot}/${on.me.disabledTurns}`);
  ok("and is offered again", on.solver.slotCandidates(on.state, 0, 0, { cap: 0 })
    .some((a) => a.slot === 1));

  // a roll OUTSIDE the 30% leaves it alone
  const miss = duel(1, setFor("Garchomp"), cursed);
  miss.solver.t.effectRoll = () => 0.99;
  miss.solver.t.deal(miss.me, miss.foe, hit(0.2, 1), null, false, null, miss.state.active[0]);
  ok("a roll outside the 30% shuts nothing off", miss.me.disabledSlot === -1,
    String(miss.me.disabledSlot));

  // rule 0 does nothing at all
  const off = duel(0, setFor("Garchomp"), cursed);
  off.solver.t.effectRoll = () => 0;
  off.solver.t.deal(off.me, off.foe, hit(0.2, 1), null, false, null, off.state.active[0]);
  ok("rule 0: nothing is shut off", off.me.disabledSlot === -1, String(off.me.disabledSlot));

  // and with no roll to hand -- the expectation engine -- it does nothing either
  const noRoll = duel(1, setFor("Garchomp"), cursed);
  delete noRoll.solver.t.effectRoll;
  noRoll.solver.t.deal(noRoll.me, noRoll.foe, hit(0.2, 1), null, false, null, noRoll.state.active[0]);
  ok("with no roll lent to it, nothing is shut off", noRoll.me.disabledSlot === -1,
    String(noRoll.me.disabledSlot));
  notes.push("Cursed Body: the move that hit is gone from the sheet for four turns");
}

/* -------------------------------------------- 7e. the entry and switch-out three */
{
  // CURIOUS MEDICINE wipes its own side's stages as it arrives, and leaves the foes alone.
  const on = duel(1, setFor("Garchomp"), setFor("Dragonite"));
  const ally = on.state.active[0][1];
  ally.atk = -2; ally.spe = 2;
  on.foe.atk = -2;
  const medic = duel(1, setFor("Garchomp", { ability: "Curious Medicine" }), setFor("Dragonite"));
  ok("Curious Medicine is read onto the kit", medic.me.k.entryClearStages === "allies",
    String(medic.me.k.entryClearStages));
  const mate = medic.state.active[0][1];
  mate.atk = -2;
  medic.foe.atk = -2;
  medic.solver.t.enter(medic.me, medic.state.active, medic.state.board, null);
  ok("its ally's stages are wiped", (mate.atk || 0) === 0, String(mate.atk));
  ok("and the other side keeps theirs", (medic.foe.atk || 0) === -2, String(medic.foe.atk));

  // SCREEN CLEANER sweeps both sides.
  const clean = duel(1, setFor("Garchomp", { ability: "Screen Cleaner" }), setFor("Dragonite"));
  ok("Screen Cleaner is read onto the kit", clean.me.k.entryScreenCleaner === true);
  clean.solver.t.solverField = { reflect: [true, true], lightScreen: [true, false], auroraVeil: [false, true], friendGuard: [false, false] };
  clean.solver.t.enter(clean.me, clean.state.active, clean.state.board, null);
  ok("every screen is gone from both sides",
    clean.solver.t.solverField.reflect.concat(clean.solver.t.solverField.lightScreen,
      clean.solver.t.solverField.auroraVeil).every((v) => v === false),
    JSON.stringify(clean.solver.t.solverField));

  // NATURAL CURE takes the condition with it when it leaves.
  const cure = duel(1, setFor("Garchomp", { ability: "Natural Cure" }), setFor("Dragonite"));
  ok("Natural Cure is read onto the kit", cure.me.k.cureOnSwitchOut === true);
  cure.solver.t.applyStatus(cure.me, "burn", 1);
  ok("it is burned to begin with", cond(cure.me, "brn") > 0);
  // switch it out, exactly as a chosen switch does
  const bench = cure.state.sides[0].find((x) => x && !cure.state.active[0].includes(x));
  if (bench) {
    cure.solver.applySwitches(cure.state, [{ kind: -1, position: 0, into: bench.ix }], 0);
    ok("and comes off the field cured", cond(cure.me, "brn") === 0, String(cond(cure.me, "brn")));
  }
  const plain = duel(1, setFor("Garchomp"), setFor("Dragonite"));
  plain.solver.t.applyStatus(plain.me, "burn", 1);
  const bench2 = plain.state.sides[0].find((x) => x && !plain.state.active[0].includes(x));
  if (bench2) {
    plain.solver.applySwitches(plain.state, [{ kind: -1, position: 0, into: bench2.ix }], 0);
    ok("anybody else keeps the burn on the bench", cond(plain.me, "brn") > 0, String(cond(plain.me, "brn")));
  }
  notes.push("entry three: Curious Medicine, Screen Cleaner and Natural Cure all land");
}

/* -------------------------------------------- 7f. Moody */
{
  const on = duel(1, setFor("Garchomp", { ability: "Moody" }), setFor("Dragonite"));
  ok("Moody is read onto the kit", on.me.k.moody?.raise === 2 && on.me.k.moody?.lower === -1,
    JSON.stringify(on.me.k.moody));
  on.solver.t.effectRoll = () => 0;   // first stat up, first of the rest down
  on.solver.t.endOfTurn(on.state.active, null, on.state.board);
  const stages = { atk: on.me.atk || 0, def: on.me.def || 0, spa: on.me.spa || 0, spd: on.me.spd || 0, spe: on.me.spe || 0 };
  const ups = Object.values(stages).filter((v) => v > 0);
  const downs = Object.values(stages).filter((v) => v < 0);
  ok("one stat went up by two", ups.length === 1 && ups[0] === 2, JSON.stringify(stages));
  ok("and another down by one", downs.length === 1 && downs[0] === -1, JSON.stringify(stages));
  ok("and they are not the same stat", ups.length + downs.length === 2);

  const off = duel(0, setFor("Garchomp", { ability: "Moody" }), setFor("Dragonite"));
  off.solver.t.effectRoll = () => 0;
  off.solver.t.endOfTurn(off.state.active, null, off.state.board);
  ok("rule 0: nothing moves", (off.me.atk || 0) === 0 && (off.me.def || 0) === 0,
    `${off.me.atk}/${off.me.def}`);

  const noRoll = duel(1, setFor("Garchomp", { ability: "Moody" }), setFor("Dragonite"));
  delete noRoll.solver.t.effectRoll;
  noRoll.solver.t.endOfTurn(noRoll.state.active, null, noRoll.state.board);
  ok("with no roll lent to it, nothing moves", (noRoll.me.atk || 0) === 0 && (noRoll.me.def || 0) === 0);
  notes.push(`Moody: ${JSON.stringify(stages)}`);
}

/* -------------------------------------------- 7g. Stance Change */
{
  const aegis = setFor("Aegislash");
  ok("the meta really brings an Aegislash", Boolean(aegis) && /stance change/i.test(aegis.ability || ""),
    aegis ? aegis.ability : "not in the meta");
  if (aegis && /stance change/i.test(aegis.ability)) {
    const on = duel(1, aegis, setFor("Dragonite"));
    ok("Stance Change is read onto the kit", on.me.k.stanceChange?.attackForm === "Blade"
      && on.me.k.stanceChange?.shieldMove === "kingsshield", JSON.stringify(on.me.k.stanceChange));
    ok("it starts in the form its sheet names", /shield/i.test(on.me.u.form), on.me.u.form);
    const dmg = on.me.u.moves.findIndex((i) => i?.damaging);
    const shield = on.me.u.moves.findIndex((i) => i?.key === "kingsshield");
    if (dmg >= 0) {
      on.solver.applyStances(on.state, [[{ position: 0, slot: dmg }], []], null);
      ok("a damaging move draws the blade", /blade/i.test(on.state.active[0][0].u.form),
        on.state.active[0][0].u.form);
    }
    if (shield >= 0) {
      on.solver.applyStances(on.state, [[{ position: 0, slot: shield }], []], null);
      ok("King's Shield raises it again", /shield/i.test(on.state.active[0][0].u.form),
        on.state.active[0][0].u.form);
    }
    // a switch or a wait leaves it exactly as it stands
    const held = on.state.active[0][0].u.form;
    on.solver.applyStances(on.state, [[{ position: 0 }], []], null);
    ok("an action with no move leaves the form alone", on.state.active[0][0].u.form === held,
      `${held} -> ${on.state.active[0][0].u.form}`);

    const off = duel(0, aegis, setFor("Dragonite"));
    const dmgOff = off.me.u.moves.findIndex((i) => i?.damaging);
    off.solver.applyStances(off.state, [[{ position: 0, slot: dmgOff }], []], null);
    ok("rule 0: the form never changes", /shield/i.test(off.state.active[0][0].u.form),
      off.state.active[0][0].u.form);
    notes.push(`Stance Change: ${aegis.form} draws the blade to attack`);
  }
}

/* -------------------------------------------- 7h. Frisk */
{
  // Frisk is an INFORMATION Ability, and in this game information is mechanical: the
  // opponent plays against a pool of rolled versions of the player's team, and `seen` is the
  // only thing that pins one. A Frisk holder on the opponent's side therefore stops it
  // guessing the item and makes it play against the Focus Sash that is really there.
  const library = read("data", "builder", "pokemon-sets.json").sets;
  const known = new KnownTeams(knownRaw);
  const solver = makeSolver(1);
  const game = new PlayGame(solver, data, FORMAT, library, { pickReplacement: false });
  const mine = [setFor("Garchomp", { item: "Focus Sash" }), setFor("Dragonite", { item: "Leftovers" }),
    setFor("Garchomp"), setFor("Dragonite")];
  const foe = teamFromKnown(data, FORMAT, known.teams[0]).slice(0, 6);
  game.start({ player: mine, foe, seed: 3 });
  const itemsKnown = () => (game.seen || []).filter((row) => row && row.item).length;
  ok("the opponent starts knowing no items of ours", itemsKnown() === 0, String(itemsKnown()));
  // put Frisk on the opponent's lead and let it look
  const theirLead = game.state.active[1][0];
  solver.t.setAbility(theirLead, "Frisk");
  game.frisk();
  ok("a Frisk holder opposite us learns what we hold", itemsKnown() > 0, String(itemsKnown()));
  ok("and it is the real item", (game.seen || []).some((row) => row && row.item === "Focus Sash"),
    JSON.stringify((game.seen || []).map((r) => r && r.item)));

  // ...and OUR Frisk fills `shown`, which is what the view reads for the other side.
  const ours = new PlayGame(makeSolver(1), data, FORMAT, library, { pickReplacement: false });
  ours.start({ player: mine, foe, seed: 3 });
  ours.solver.t.setAbility(ours.state.active[0][0], "Frisk");
  ours.frisk();
  ok("our own Frisk fills what we have been shown",
    (ours.shown || []).filter((row) => row && row.item).length > 0,
    JSON.stringify((ours.shown || []).map((r) => r && r.item)));
  notes.push(`Frisk: the opponent pinned ${itemsKnown()} of our items`);
}

/* -------------------------------------------- 7i. Zero to Hero */
{
  // Built from the species data, not from `setFor`: Palafin is in the game but not in the
  // Doubles meta list, and a skipped check reads exactly like a passing one.
  const palaBase = data.commonSet(FORMAT, "Palafin", "Palafin Zero Form")
    || data.commonSet(FORMAT, "Palafin", "Palafin");
  const pala = palaBase && palaBase.moves?.length
    ? makeSet({ ...palaBase, moves: [...palaBase.moves], ability: "Zero to Hero" }) : null;
  ok("the game really has a Palafin to test with", Boolean(pala), String(palaBase && palaBase.form));
  if (pala) {
    // Its own board, because `duel` seats two a side and this needs somebody on the bench
    // to switch to -- without one the swap never happens and the checks below never run.
    const build = (rule) => {
      const s = makeSolver(rule);
      const st = s.buildState({
        sides: [[row(pala, { front: true }), row(ANY, { front: true }), row(ANY)],
          [row(ANY, { front: true }), row(ANY, { front: true }), row(ANY)]],
        field: {},
      });
      return { solver: s, state: st, me: st.active[0][0] };
    };
    const on = build(1);
    ok("Zero to Hero is read onto the kit", on.me.k.switchOutForm === "Hero",
      String(on.me.k.switchOutForm));
    ok("it starts as the form its sheet names", !/hero/i.test(on.me.u.form), on.me.u.form);
    const bench = on.state.sides[0].find((x) => x && !on.state.active[0].includes(x));
    if (bench) {
      on.solver.applySwitches(on.state, [{ kind: -1, position: 0, into: bench.ix }], 0);
      ok("and comes off the field as its Hero Form", /hero/i.test(on.me.u.form), on.me.u.form);
      notes.push(`Zero to Hero: ${pala.form} -> ${on.me.u.form}`);
    }
    const off = build(0);
    const b2 = off.state.sides[0].find((x) => x && !off.state.active[0].includes(x));
    if (b2) {
      off.solver.applySwitches(off.state, [{ kind: -1, position: 0, into: b2.ix }], 0);
      ok("rule 0: the form does not change", !/hero/i.test(off.me.u.form), off.me.u.form);
    }
  } else {
    notes.push("Zero to Hero: no Palafin in the meta, skipped");
  }
}

/* -------------------------------------------- 8+9. shipped, and asked for */
{
  const shipped = effects.abilities || {};
  for (const [key, op] of [["poisontouch", "on_contact_status_target"], ["compoundeyes", "accuracy_multiplier"],
    ["unnerve", "unnerve"], ["flamebody", "on_hit_status_attacker"], ["bigpecks", "stat_drop_immunity"]]) {
    ok(`${key} ships its op`, (shipped[key] || []).some((e) => e.op === op), JSON.stringify(shipped[key]));
  }
  // THE PLAYED GAME DECORATES `applyStatus`, and a decorator that drops an argument breaks
  // the Ability everywhere except in a real game -- the one place it is for. Corrosion and
  // Synchronize read the fourth argument, so the wrapper has to carry it.
  const play = readFileSync(join(root, "builder", "play-game.js"), "utf8");
  const at = play.indexOf('decorate("applyStatus"');
  const decorator = at < 0 ? null : [play.slice(at, at + 2400)];
  ok("the played game still decorates applyStatus", Boolean(decorator));
  ok("and its wrapper takes the source",
    Boolean(decorator) && /function applyStatus\(target, status, chance, source/.test(decorator[0]),
    decorator ? decorator[0].slice(0, 90) : "");
  ok("and passes it on",
    Boolean(decorator) && /was\.call\(this, target, status, chance, source\)/.test(decorator[0]));

  const worker = readFileSync(join(root, "builder", "analysis-worker.js"), "utf8");
  const built = worker.match(/new TournamentTest\([\s\S]*?\);/g) || [];
    // V549: all THREE engines ask for it now. The Tournament Test used to be built with
  // `{{ effects }}` alone, so every modelling rule added since was on in the two live engines
  // and off in the one that produces the numbers on the Test against Tournament Teams screen.
  // What it must still NOT have is either ROLLING rule: it prices expectations and rolls
  // nothing, and a rolling cost handed to an expectation engine is counted twice.
  ok("all three engines ask for the rule, the Tournament Test included",
    built.filter((c) => /abilityOpsRule:\s*1/.test(c)).length === 3,
    String(built.filter((c) => /abilityOpsRule:\s*1/.test(c)).length));
  const tourney = built.find((c) => !/playTournament|solverTournament/.test(c)) || "";
  ok("and the Tournament Test still rolls nothing",
    Boolean(tourney) && !/selfRollRule/.test(tourney) && !/actionRollRule/.test(tourney),
    tourney.slice(0, 160));
}

for (const note of notes) console.log(`   ${note}`);
console.log(`${checked} checked, ${failures.length} failed.`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
