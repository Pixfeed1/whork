// Usage : npx tsx scripts/try-real.ts "adresse" | lon lat
import { ignGeocode } from "../server/providers/ign";
import { analyzeRoof } from "../server/analysis/pipeline";
import { computeMetrics, fmt, EDGE_TYPES } from "../shared/roof";
const args = process.argv.slice(2);
let lon: number, lat: number, label = "";
if (args.length === 2 && !isNaN(+args[0])) { lon = +args[0]; lat = +args[1]; }
else { const g = (await ignGeocode(args.join(" "), 1, false))[0]; lon = g.lon; lat = g.lat; label = g.label; }
console.log(label, lon, lat);
const t0 = Date.now();
const m = await analyzeRoof({ points: [[lon, lat]], source: (process.env.SOURCE as any) ?? "auto" });
const r = computeMetrics(m);
console.log(`analyse ${Date.now()-t0} ms`, JSON.stringify(m.meta));
for (const f of r.faces) console.log(`pan ${f.index}: ${fmt(f.area)} m² pente ${fmt(f.pitchDeg,1)}° (${fmt(f.pitchPct,0)} %) ${f.orientation}`);
console.log("TOTAL", fmt(r.totals.area), "m²");
for (const e of EDGE_TYPES) console.log(e.label, fmt(r.totals.lengths[e.type]), "ml");
import { writeFileSync } from "node:fs";
writeFileSync(process.env.OUT ?? "/tmp/claude-0/model.json", JSON.stringify(m));
