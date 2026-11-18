// Superpose un modèle sur l'orthophoto IGN -> PNG (diagnostic)
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { ignOrtho, toL93 } from "../server/providers/ign";
import { computeMetrics, EDGE_COLOR } from "../shared/roof";
const [inp, out] = process.argv.slice(2);
const m = JSON.parse(readFileSync(inp, "utf8"));
const pts = m.faces.flatMap((f: any) => f.ring).concat(m.footprint ?? []);
const l93 = pts.map((p: any) => toL93(p));
const pad = 6;
const x0 = Math.min(...l93.map((p: any) => p[0])) - pad, x1 = Math.max(...l93.map((p: any) => p[0])) + pad;
const y0 = Math.min(...l93.map((p: any) => p[1])) - pad, y1 = Math.max(...l93.map((p: any) => p[1])) + pad;
const W = 900, H = Math.round(W * (y1 - y0) / (x1 - x0));
const img = await ignOrtho([x0, y0, x1, y1], W, H);
const px = (p: any) => { const q = toL93(p); return [((q[0] - x0) / (x1 - x0)) * W, ((y1 - q[1]) / (y1 - y0)) * H]; };
const met = computeMetrics(m);
let svg = "";
if (m.footprint) svg += `<polygon points="${m.footprint.map((p: any) => px(p).join(",")).join(" ")}" fill="none" stroke="yellow" stroke-dasharray="4" stroke-width="1"/>`;
for (const f of m.faces) svg += `<polygon points="${f.ring.map((p: any) => px(p).join(",")).join(" ")}" fill="rgba(255,255,255,0.12)" stroke="none"/>`;
for (const e of met.edges) { const a = px(e.a), b = px(e.b); svg += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${EDGE_COLOR[e.type]}" stroke-width="3"/>`; svg += `<text x="${(a[0]+b[0])/2}" y="${(a[1]+b[1])/2}" fill="white" font-size="12" stroke="black" stroke-width="0.4">${e.length.toFixed(1)}</text>`; }
for (const f of met.faces) { const c = px(f.centroid); svg += `<text x="${c[0]}" y="${c[1]}" fill="yellow" font-size="13" font-weight="bold" stroke="black" stroke-width="0.5">${f.index}: ${f.area.toFixed(1)}m² ${f.pitchDeg.toFixed(0)}°</text>`; }
const html = `<html><body style="margin:0"><div style="position:relative;width:${W}px;height:${H}px"><img src="data:image/jpeg;base64,${img.toString("base64")}" style="position:absolute"/><svg width="${W}" height="${H}" style="position:absolute">${svg}</svg></div></body></html>`;
const br = await chromium.launch(); const pg = await br.newPage({ viewport: { width: W, height: H } });
await pg.setContent(html); await pg.screenshot({ path: out }); await br.close();
