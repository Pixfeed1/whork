import { readFileSync, writeFileSync } from "node:fs";
import { generateReport } from "../server/pdf/report";
const m = JSON.parse(readFileSync(process.argv[2], "utf8"));
const tiles = process.env.TILES === "ign"
  ? { maxZoom: 19, credit: "IGN (test tuiles)", fetch: async (z: number, x: number, y: number) => { const r = await fetch(`https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg`); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; } }
  : null;
// STATIC=ign : simule une photo unique (type Google Maps Static) avec le WMS IGN en Web Mercator
const staticImagery = process.env.STATIC === "ign"
  ? { maxZoom: 21, scale: 2, maxSize: 640, credit: "IGN (test image unique)", fetch: async (c: [number, number], z: number, w: number, h: number) => {
      const R = 6378137, k = 2 ** z, res = (2 * Math.PI * R) / (256 * k);
      const mx = (c[0] * Math.PI * R) / 180, my = R * Math.log(Math.tan(Math.PI / 4 + (c[1] * Math.PI) / 360));
      const b = [mx - (w / 2) * res, my - (h / 2) * res, mx + (w / 2) * res, my + (h / 2) * res].join(",");
      const r = await fetch(`https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=HR.ORTHOIMAGERY.ORTHOPHOTOS&STYLES=&CRS=EPSG:3857&BBOX=${b}&WIDTH=${w * 2}&HEIGHT=${h * 2}&FORMAT=image/png`);
      return r.ok ? Buffer.from(await r.arrayBuffer()) : null; } }
  : null;
const pdf = await generateReport({ tiles, staticImagery, org: { logo: process.env.LOGO ? readFileSync(process.env.LOGO) : null, name: "GUÉRIN COUVERTURE", address: "Rue de test", postcode: "17410", city: "Saint-Martin-de-Ré", phone: "05 00 00 00 00", email: "contact@exemple.fr", waste_pct: 10 }, number: "MT-2026-0001", date: new Date(), address: "Adresse de test, 17410 Saint-Martin-de-Ré", clientName: "M. Dupont", notes: "Tuiles canal, à vérifier sur place.", model: m, author: "R. G." });
writeFileSync(process.argv[3], pdf); console.log(pdf.length);
