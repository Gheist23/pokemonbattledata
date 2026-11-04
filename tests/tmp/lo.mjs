import { readFileSync } from "node:fs";
import { DamageEngine, makeMon, makeContext } from "../../builder/engine.js";
const appData = JSON.parse(readFileSync("data/builder/app-data.json","utf8"));
const e = new DamageEngine(appData);
const att = makeMon({ pokemon_name:"Mimikyu", form_name:"Mimikyu", ability:"Disguise",
  item_name:"Life Orb", nature_name:"Jolly", bonuses:[0,0,0,0,0,0] });
const def = makeMon({pokemon_name:"Armarouge",form_name:"Armarouge",ability:"Flash Fire",nature_name:"Modest",bonuses:[0,0,0,0,0,0]});
const r = e.calculate(att, def, makeContext({ move_name:"Play Rough", battle_format:"Doubles" }));
const selfish = Object.entries(r).filter(([k]) => /self|recoil|cost/i.test(k));
console.log("range", r.range);
console.log("self-ish fields:", JSON.stringify(selfish));
