import { readFileSync } from "node:fs";
import { DamageEngine, makeMon, makeContext } from "../../builder/engine.js";
import { resultRecoilShare } from "../../builder/self-cost.js";
const appData = JSON.parse(readFileSync("data/builder/app-data.json","utf8"));
const e = new DamageEngine(appData);
const att = makeMon({ pokemon_name:"Mimikyu", form_name:"Mimikyu", ability:"Disguise",
  item_name:"Life Orb", nature_name:"Jolly", bonuses:[0,0,0,0,0,0] });
const def = makeMon({pokemon_name:"Armarouge",form_name:"Armarouge",ability:"Flash Fire",nature_name:"Modest",bonuses:[0,0,0,0,0,0]});
const r = e.calculate(att, def, makeContext({ move_name:"Play Rough", battle_format:"Doubles" }));
console.log("Play Rough w/ Life Orb -> recoil share:", resultRecoilShare(r));
console.log("accuracy factor:", r.move_accuracy_factor);
const share = resultRecoilShare(r) * (r.move_accuracy_factor ?? 1);
console.log("");
console.log("turn 3 ledger for Mimikyu (fractions of max HP):");
console.log("  start                 100.00%");
console.log("  Disguise absorbs hit  -12.50%  -> 87.50%");
console.log("  Life Orb (Play Rough) -" + (share*100).toFixed(2) + "%  -> " + ((0.875 - share)*100).toFixed(2) + "%");
console.log("  Grassy Terrain heal    +6.25%  -> " + ((0.875 - share + 1/16)*100).toFixed(2) + "%");
console.log("  displayed:            ", Math.round((0.875 - share + 1/16)*100) + "%");
