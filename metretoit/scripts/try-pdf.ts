import { readFileSync, writeFileSync } from "node:fs";
import { generateReport } from "../server/pdf/report";
const m = JSON.parse(readFileSync(process.argv[2], "utf8"));
const tiles = process.env.TILES === "ign"
  ? { maxZoom: 19, credit: "IGN (test tuiles)", fetch: async (z: number, x: number, y: number) => { const r = await fetch(`https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg`); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; } }
  : null;
const pdf = await generateReport({ tiles, org: { name: "GUÉRIN COUVERTURE", address: "Rue de test", postcode: "17410", city: "Saint-Martin-de-Ré", phone: "05 00 00 00 00", email: "contact@exemple.fr", waste_pct: 10 }, number: "MT-2026-0001", date: new Date(), address: "Adresse de test, 17410 Saint-Martin-de-Ré", clientName: "M. Dupont", notes: "Tuiles canal, à vérifier sur place.", model: m, author: "R. G." });
writeFileSync(process.argv[3], pdf); console.log(pdf.length);
