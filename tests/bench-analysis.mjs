// Times Team Evaluation and Auto Build outside the browser.
import { readFileSync } from "node:fs";
import { BuilderData, setFromCommon } from "../builder/common.js";
import { autoBuild, evaluateTeam, metaRecords, overview } from "../builder/analysis.js";

const data = new BuilderData(JSON.parse(readFileSync("data/builder/app-data.json", "utf8")));
for (const format of ["Doubles", "Singles"]) {
  const payload = JSON.parse(readFileSync(`data/builder/meta-${format.toLowerCase()}.json`, "utf8"));
  data.meta[format] = payload;
  data.metaByUsage[format] = new Map(payload.pokemon.map((row) => [row.name.toLowerCase().replace(/[^a-z0-9]/g, ""), row]));
}
const format = "Doubles";
let t = performance.now();
const meta = await metaRecords(data, format, 80);
console.log("meta records", meta.length, Math.round(performance.now() - t), "ms");
const team = meta.slice(0, 6).map((rec) => rec.set);
t = performance.now();
const ov = overview(data, format, team, meta, 30);
console.log("overview", Math.round(performance.now() - t), "ms", "out", ov.outgoing.score.toFixed(1), "in", ov.incoming.score.toFixed(1));
t = performance.now();
const ev = evaluateTeam(data, format, team, meta, { top: 40 });
console.log("evaluate", Math.round(performance.now() - t), "ms", JSON.stringify(ev.scores), ev.archetype.display, "critical", ev.critical.length, "calls", ev.calls);
console.log(ev.checks.map((c) => `${c.severity}:${c.label}`).join(" | "));
console.log(ev.critical.slice(0, 3).map((c) => `${c.name} ${c.score.toFixed(0)} P${JSON.stringify(c.pressure)} A${JSON.stringify(c.answers)} best:${c.answer?.name} ${c.answer?.move} ${c.answer?.label}`).join("\n"));
t = performance.now();
const pool = meta.slice(0, 70).map((rec) => ({ set: setFromCommon(data.commonSet(format, rec.set.species, rec.set.form)), source: "meta" }));
const built = autoBuild(data, format, meta, pool, { locked: [team[2]], beam: 3 });
console.log("autobuild", Math.round(performance.now() - t), "ms", built.sets.map((s) => s.species).join(", "));
console.log(built.log.map((l) => `${l.name}: ${l.answered.join("/")}`).join(" | "));
