// Banc d'essai de précision : compare le métré automatique à des métrés réalisés sur site.
//
// Usage : npx tsx scripts/precision.ts toitures.csv [resultats.csv]
//
// Format du fichier d'entrée (séparateur « ; », première ligne = en-têtes) :
//   adresse;surface;faitage;egout;rive;noue;aretier
//   12 rue X 17410 Saint-Martin-de-Ré;142,5;12,3;24,6;18,2;;
// Les colonnes vides sont ignorées. On peut remplacer « adresse » par « lon » et « lat ».
import { readFileSync, writeFileSync } from "node:fs";
import { ignGeocode } from "../server/providers/ign";
import { analyzeRoof } from "../server/analysis/pipeline";
import { computeMetrics, type EdgeType } from "../shared/roof";

const [inp, out = "precision-resultats.csv"] = process.argv.slice(2);
if (!inp) {
  console.error("Usage : npx tsx scripts/precision.ts toitures.csv [resultats.csv]");
  process.exit(1);
}
const lines = readFileSync(inp, "utf8").split(/\r?\n/).filter((l) => l.trim());
const head = lines[0].split(";").map((h) => h.trim().toLowerCase());
const num = (s?: string) => (s && s.trim() ? Number(s.replace(",", ".")) : NaN);
const cols: [string, EdgeType | "surface"][] = [
  ["surface", "surface"],
  ["faitage", "faitage"],
  ["egout", "egout"],
  ["rive", "rive"],
  ["noue", "noue"],
  ["aretier", "aretier"],
];
const outRows = [["adresse", ...cols.flatMap(([c]) => [`${c}_terrain`, `${c}_auto`, `${c}_ecart_%`])].join(";")];
const errs: Record<string, number[]> = {};

for (const line of lines.slice(1)) {
  const v = line.split(";");
  const get = (k: string) => v[head.indexOf(k)];
  let lon = num(get("lon"));
  let lat = num(get("lat"));
  const addr = get("adresse") ?? `${lat},${lon}`;
  if (!Number.isFinite(lon)) {
    const g = (await ignGeocode(addr, 1, false))[0];
    if (!g) {
      console.log(`✗ adresse introuvable : ${addr}`);
      continue;
    }
    lon = g.lon;
    lat = g.lat;
  }
  const model = await analyzeRoof({ points: [[lon, lat]] });
  const m = computeMetrics(model);
  const row = [addr];
  const parts: string[] = [];
  for (const [c, t] of cols) {
    const ref = num(get(c));
    const auto = t === "surface" ? m.totals.area : m.totals.lengths[t];
    const e = Number.isFinite(ref) && ref > 0 ? ((auto - ref) / ref) * 100 : NaN;
    if (Number.isFinite(e)) (errs[c] ??= []).push(Math.abs(e));
    row.push(Number.isFinite(ref) ? ref.toFixed(2) : "", auto.toFixed(2), Number.isFinite(e) ? e.toFixed(1) : "");
    if (Number.isFinite(e)) parts.push(`${c} ${e >= 0 ? "+" : ""}${e.toFixed(1)} %`);
  }
  outRows.push(row.join(";"));
  console.log(`• ${addr} : ${m.totals.faceCount} pans, ${m.totals.area.toFixed(1)} m² — ${parts.join(", ")}`);
}
writeFileSync(out, outRows.join("\n"));
console.log("\nÉcart absolu moyen :");
for (const [c, e] of Object.entries(errs)) console.log(`  ${c.padEnd(8)} ${(e.reduce((a, b) => a + b, 0) / e.length).toFixed(1)} %  (${e.length} toitures)`);
console.log(`Détail : ${out}`);
