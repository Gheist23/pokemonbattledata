// The Box takes the picker's search language.
//
// WHAT WAS MISSING. The Box was a plain grid: no filter at all, so a player with forty trained
// Pokemon scrolled. The picker and the Explorer already share one search language
// (builder/search-query.js); this is the Box joining them, so "item=Choice Scarf, spe>=100"
// narrows the Box the way it narrows the picker.
//
// THE ONE THING THAT HAD TO BE DECIDED, and what this suite mostly exists to pin. A Box card is
// one CONCRETE SET, not a species, so the three kinds of clause come from three places:
//
//     what it IS          name, type, hp/atk/def/spa/spd/spe/bst  -> the species
//     what THIS ONE has   item, ability, nature, moves, points    -> the set the player owns
//     the battle data      teammate, rank, usage                   -> the species, as the
//                                                                     picker already answers it
//
// So `item=Choice Scarf` in the Box finds the Pokemon HOLDING a Scarf, not every Pokemon whose
// usage table happens to list one, and `move=Flamethrower` finds the ones that HAVE it rather
// than the ones that could learn it. Sections 2 and 3 are the difference, and they are written
// against cards whose species' battle data DOES list the item or move being asked for -- which
// is the only way those assertions can fail for the right reason.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuilderData } from "../builder/common.js";
import { parseSearchQuery } from "../builder/search-query.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => JSON.parse(readFileSync(join(root, ...p), "utf8"));

let checked = 0;
const failures = [];
const ok = (label, condition, detail = "") => {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const data = new BuilderData(read("data", "builder", "app-data.json"));
data.ingestMeta("Doubles", read("data", "builder", "meta-doubles.json"));

const set = (s, f, i, a, n, b, m) => ({ species: s, form: f || s, item: i, ability: a, nature: n, bonuses: b, moves: m });
const BOX = [
  set("Salamence", "", "Life Orb", "Intimidate", "Jolly", [2, 32, 0, 0, 0, 32], ["Dragon Claw", "Earthquake", "Protect", "Tailwind"]),
  set("Incineroar", "", "Sitrus Berry", "Intimidate", "Careful", [32, 0, 14, 0, 20, 0], ["Fake Out", "Flare Blitz", "Knock Off", "Parting Shot"]),
  set("Rillaboom", "", "Assault Vest", "Grassy Surge", "Adamant", [32, 32, 2, 0, 0, 0], ["Grassy Glide", "Wood Hammer", "U-turn", "Fake Out"]),
  set("Milotic", "", "Leftovers", "Competitive", "Calm", [32, 0, 17, 8, 5, 4], ["Scald", "Ice Beam", "Recover", "Protect"]),
  set("Ninetales", "Ninetales-Alola", "Light Clay", "Snow Warning", "Timid", [2, 0, 0, 32, 0, 32], ["Aurora Veil", "Blizzard", "Freeze-Dry", "Protect"]),
];
const found = (query) => BOX.filter(data.boxFilter(query, "Doubles")).map((s) => s.form || s.species);
const only = (query, ...want) => {
  const got = found(query);
  ok(`${JSON.stringify(query)} finds ${want.join(" + ") || "nothing"}`,
    got.length === want.length && want.every((w) => got.includes(w)), got.join(", ") || "(none)");
};
/** Does the SPECIES' battle data list this value? Sections 2-3 need it to, or they prove nothing. */
const usageHas = (species, category, value) => {
  const record = data.usage("Doubles", species, species);
  const rows = category === "held_item" ? record?.items : category === "ability" ? record?.abilities : record?.moves;
  return (rows || []).some(([name]) => String(name).toLowerCase() === value.toLowerCase());
};

// --- 1. the same language, and an empty query keeps everything ----------------------------
{
  ok("an empty query keeps the whole box", found("").length === BOX.length);
  ok("so does whitespace", found("   ").length === BOX.length);
  only("mence", "Salamence");
  only("alolan ninetales", "Ninetales-Alola");
  only("type=Fire", "Incineroar");
  only("type=Water", "Milotic");
  only("nature=Adamant", "Rillaboom");
  // Chained clauses are AND, exactly as everywhere else.
  only("type=Water, item=Leftovers", "Milotic");
  only("type=Grass, item=Leftovers");
  ok("a plain word is a name search", parseSearchQuery("mence").mode === "name");
  ok("and a clause is not", parseSearchQuery("item=Leftovers").mode === "advanced");
}

// --- 2. the ITEM is the one it is holding -------------------------------------------------
{
  // The point of the test: Salamence's usage table DOES list Choice Scarf, so a Box that
  // answered from the battle data would find it. The card holds a Life Orb.
  ok("Salamence's battle data lists Choice Scarf", usageHas("Salamence", "held_item", "Choice Scarf"));
  only("item=Choice Scarf");
  only("item=Life Orb", "Salamence");
  only("item=Leftovers", "Milotic");
  only("item=Light Clay", "Ninetales-Alola");
  // One Pokemon holds one item, so that item is its own first choice.
  only("topitem=Life Orb", "Salamence");
}

// --- 3. the ABILITY and the MOVES are the ones on the set ---------------------------------
{
  ok("Salamence's battle data lists Moxie", usageHas("Salamence", "ability", "Moxie"));
  only("ability=Intimidate", "Salamence", "Incineroar");
  only("ability=Moxie");
  only("ability=Grassy Surge", "Rillaboom");

  // A move it can LEARN but does not have. The picker finds this; the Box must not.
  const learnset = data.learnset("Salamence", "Salamence").map((m) => String(m).toLowerCase());
  ok("Salamence can learn Fire Blast", learnset.includes("fire blast"), learnset.slice(0, 6).join(", "));
  only("move=Fire Blast");
  only("move=Earthquake", "Salamence");
  only("move=Fake Out", "Incineroar", "Rillaboom");
  only("Fake Out", "Incineroar", "Rillaboom");
  only("Protect", "Salamence", "Milotic", "Ninetales-Alola");
  // Four moves, each of them this Pokemon's own, so a rank clause still answers yes.
  only("move<=5=Earthquake", "Salamence");
}

// --- 4. the stats come from the species, and the POINTS from the set ----------------------
{
  // Pokemon Champions has its own base stats -- Rillaboom is 105 Speed here, not mainline's 85 --
  // so this reads them from the game's own table rather than asserting a remembered number.
  const speedOf = (name) => Number(data.byName.get(name.toLowerCase().replace(/[^a-z0-9]/g, "")).row.stats.speed);
  const fast = BOX.filter((s) => speedOf(s.form || s.species) >= 110).map((s) => s.form || s.species);
  ok("some of the box is at 110 Speed or more, in THIS game's numbers", fast.length > 0 && fast.length < BOX.length,
    fast.join(", "));
  only("spe>=110", ...fast);
  // The owned FORM's stats, not the base species': an Alolan Ninetales is not a Ninetales.
  ok("the two Ninetales forms have different Speed",
    speedOf("Ninetales-Alola") !== speedOf("Ninetales"),
    `${speedOf("Ninetales-Alola")} vs ${speedOf("Ninetales")}`);
  const alola = data.boxSearchSource(BOX[4], "Doubles");
  ok("and the box reads the form it owns", alola.stat("speed") === speedOf("Ninetales-Alola"),
    `${alola.stat("speed")} vs ${speedOf("Ninetales-Alola")}`);
  // Stat POINTS are the player's own investment, which only the owned set knows.
  only("spepoints>=32", "Salamence", "Ninetales-Alola");
  only("hppoints>=32", "Incineroar", "Rillaboom", "Milotic");
}

// --- 5. the battle data still answers for the species ------------------------------------
{
  // `teammate` is a fact about the species, not about this one Pokemon, so the species answers
  // it -- the same answer the picker gives. Conflating the two is the obvious way to break this.
  const anyTeammate = found("teammate=Rillaboom");
  ok("a teammate clause is answered, not refused", anyTeammate.length > 0, "(none)");
  ok("and not simply everything", anyTeammate.length <= BOX.length);
  const salamence = data.boxSearchSource(BOX[0], "Doubles");
  const picker = data.searchSource(data.byName.get("salamence"), "Doubles");
  ok("the teammate rows are the picker's own",
    JSON.stringify(salamence.rows("teammate")) === JSON.stringify(picker.rows("teammate")));
  // ...while the item rows are NOT.
  ok("the item rows are not", JSON.stringify(salamence.rows("held_item")) !== JSON.stringify(picker.rows("held_item")));
}

// --- 6. the awkward cases -----------------------------------------------------------------
{
  const blank = { species: "", form: "", item: "", ability: "", nature: "", bonuses: [], moves: [] };
  ok("a card with no species never matches", data.boxFilter("mence", "Doubles")(blank) === false);
  ok("...nor an empty-clause match", data.boxFilter("type=Dragon", "Doubles")(blank) === false);
  const unknown = set("Totallynotapokemon", "", "Leftovers", "Levitate", "Timid", [0, 0, 0, 0, 0, 0], ["Protect"]);
  const src = data.boxSearchSource(unknown, "Doubles");
  // "A page that cannot answer a field answers no to it, rather than answering 0 and making
  // dex=0 find everything" (builder/search-query.js). An unknown species has no stats at all.
  ok("an unknown species cannot answer a stat clause", typeof src.stat !== "function");
  ok("but what the player typed on the card still answers", src.learnset().includes("Protect")
    && src.abilities().includes("Levitate"));
  ok("and it is still filterable without crashing", data.boxFilter("item=Leftovers", "Doubles")(unknown) === true);
  // A set with no moves and no item answers no to those clauses rather than matching everything.
  const bare = set("Milotic", "", "", "", "Calm", [0, 0, 0, 0, 0, 0], []);
  ok("a bare card matches no item clause", data.boxFilter("item=Leftovers", "Doubles")(bare) === false);
  ok("a bare card matches no move clause", data.boxFilter("move=Scald", "Doubles")(bare) === false);
  ok("but still matches its own name", data.boxFilter("milotic", "Doubles")(bare) === true);
}

// --- 7. a stone holder is filtered as the card LABELS it ----------------------------------
// THE GAP THIS SUITE ORIGINALLY HAD, caught in the browser rather than here: every card above
// is a base form holding an ordinary item, so nothing exercised a Mega. A Box entry stores the
// BASE form plus the stone -- {pokemon: "Dragonite", form: "Dragonite", item: "Dragoninite"} --
// while the card is labelled by `setName`, which resolves the Mega, so the player reads
// "Dragonite-Mega" and its Mega stats. Reading the stored form made `spe>=120` skip the very
// card showing 120, and `byName` is keyed by the SHOWDOWN spelling, so looking up the app's own
// form name ("Mega Dragonite") silently fell through to the base species instead of failing.
{
  const mega = set("Dragonite", "Dragonite", "Dragoninite", "Multiscale", "Adamant", [32, 32, 2, 0, 0, 0], ["Dragon Claw", "Earthquake", "Extreme Speed", "Protect"]);
  const label = data.setName(mega);
  ok("the card is labelled with the Mega", /mega/i.test(label), label);
  const baseSpe = Number(data.byName.get("dragonite").row.stats.speed);
  const megaSpe = Number(data.byName.get("dragonitemega").row.stats.speed);
  ok("the Mega is faster than the base form in this game", megaSpe > baseSpe, `${megaSpe} vs ${baseSpe}`);

  const src = data.boxSearchSource(mega, "Doubles");
  ok("the box reads the form it BATTLES as", src.stat("speed") === megaSpe, `${src.stat("speed")} vs ${megaSpe}`);
  const match = (q) => data.boxFilter(q, "Doubles")(mega);
  ok("a stat clause the card satisfies matches it", match(`spe>=${megaSpe}`));
  ok("and one only the base form satisfies does not", match(`spe<${megaSpe}`) === false);
  // Both spellings, because the player may type either, and the base name must still work.
  ok("the Showdown spelling finds it", match("dragonite-mega"));
  ok("the app spelling finds it", match("mega dragonite"));
  ok("and the base name still finds it", match("dragonite"));
  // The Mega's typing, which the base form does not have, proves the identity really switched.
  const megaTypes = (data.byName.get("dragonitemega").row.types || []).map((t) => t.toLowerCase());
  ok("the Mega has a type to test", megaTypes.length > 0);
  for (const type of megaTypes) ok(`type=${type} finds it`, match(`type=${type}`));
  // And the stone itself is just its held item.
  ok("the stone is its held item", match("item=Dragoninite"));
  // A base-form card with no stone must NOT be read as its Mega.
  const plain = set("Dragonite", "Dragonite", "Leftovers", "Multiscale", "Adamant", [32, 32, 2, 0, 0, 0], ["Dragon Claw"]);
  ok("without the stone it stays the base form",
    data.boxSearchSource(plain, "Doubles").stat("speed") === baseSpe,
    String(data.boxSearchSource(plain, "Doubles").stat("speed")));
}

// --- 8. the page really binds it ----------------------------------------------------------
// A filter nothing calls is the failure mode worth a test of its own: every assertion above
// would pass with the input never rendered.
{
  const page = readFileSync(join(root, "builder", "builder-page.js"), "utf8");
  ok("renderBox builds the filter", page.includes("data.boxFilter(view.boxQuery"));
  ok("the query lives on the view, so a tab switch keeps it", /boxQuery: ""/.test(page));
  ok("typing re-fills the grid rather than the page", /addEventListener\("input", \(\) => \{ view\.boxQuery = input\.value; fill\(\); \}\)/.test(page));
  ok("and it offers the picker's own help card", page.includes("searchHelpCard()")
    && page.includes('from "./ui.js"') && /import \{[^}]*searchHelpCard[^}]*\} from "\.\/ui\.js"/.test(page));
  const css = readFileSync(join(root, "builder", "builder.css"), "utf8");
  ok("and the styles for it exist", css.includes(".bd-box-filter"));
}

console.log(`${checked} checked, ${failures.length} failed`);
for (const line of failures) console.log(`  FAIL ${line}`);
process.exit(failures.length ? 1 : 0);
