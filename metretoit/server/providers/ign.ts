// Géoplateforme IGN (data.geopf.fr) — services publics et gratuits, sans clé.
//  - géocodage (BAN)                       /geocodage/search
//  - bâtiments BD TOPO (WFS)               /wfs/ows  BDTOPO_V3:batiment
//  - MNS LiDAR HD (WMS raster, GeoTIFF)    /wms-r/wms  IGNF_LIDAR-HD_MNS_...
//  - orthophotographie (WMS / WMTS)        HR.ORTHOIMAGERY.ORTHOPHOTOS

import proj4 from "proj4";
import { fromArrayBuffer } from "geotiff";
import type { LonLat, LocalFrame } from "../../shared/geo";
import { toLocal } from "../../shared/geo";
import { type DsmGrid, affineFrom3 } from "../analysis/grid";

export const IGN_BASE = process.env.IGN_BASE_URL ?? "https://data.geopf.fr";
proj4.defs(
  "EPSG:2154",
  "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
);

export const toL93 = (p: LonLat): [number, number] => proj4("EPSG:4326", "EPSG:2154", p) as [number, number];
export const fromL93 = (p: [number, number]): LonLat => proj4("EPSG:2154", "EPSG:4326", p) as LonLat;

async function fetchWithRetry(url: string, tries = 3, timeoutMs = 30000): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return r;
      last = new Error(`HTTP ${r.status} sur ${url.split("?")[0]}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) {
      last = e;
    }
    await new Promise((res) => setTimeout(res, 500 * (i + 1)));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export interface GeocodeResult {
  label: string;
  lon: number;
  lat: number;
  score: number;
  city?: string;
  postcode?: string;
  type?: string;
}

export async function ignGeocode(
  q: string,
  limit = 6,
  autocomplete = true,
  near?: { lon: number; lat: number },
): Promise<GeocodeResult[]> {
  const u = new URL(`${IGN_BASE}/geocodage/search`);
  if (near) {
    u.searchParams.set("lon", String(near.lon));
    u.searchParams.set("lat", String(near.lat));
  }
  u.searchParams.set("q", q);
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("index", "address");
  if (autocomplete) u.searchParams.set("autocomplete", "1");
  const r = await fetchWithRetry(u.toString(), 2, 10000);
  const j = (await r.json()) as any;
  return (j.features ?? []).map((f: any) => ({
    label: f.properties.label,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    score: f.properties.score,
    city: f.properties.city,
    postcode: f.properties.postcode,
    type: f.properties.type,
  }));
}

export async function ignReverse(lon: number, lat: number): Promise<string | null> {
  const u = new URL(`${IGN_BASE}/geocodage/reverse`);
  u.searchParams.set("lon", String(lon));
  u.searchParams.set("lat", String(lat));
  u.searchParams.set("limit", "1");
  u.searchParams.set("index", "address");
  try {
    const r = await fetchWithRetry(u.toString(), 2, 10000);
    const j = (await r.json()) as any;
    return j.features?.[0]?.properties?.label ?? null;
  } catch {
    return null;
  }
}

export interface Building {
  id: string;
  ring: LonLat[];
  height?: number | null;
  usage?: string | null;
}

/** Bâtiments BD TOPO dans une emprise (lon/lat). */
export async function ignBuildings(minLon: number, minLat: number, maxLon: number, maxLat: number): Promise<Building[]> {
  const u = new URL(`${IGN_BASE}/wfs/ows`);
  u.searchParams.set("SERVICE", "WFS");
  u.searchParams.set("VERSION", "2.0.0");
  u.searchParams.set("REQUEST", "GetFeature");
  u.searchParams.set("TYPENAMES", "BDTOPO_V3:batiment");
  u.searchParams.set("outputFormat", "application/json");
  u.searchParams.set("SRSNAME", "EPSG:4326");
  u.searchParams.set("BBOX", `${minLon},${minLat},${maxLon},${maxLat},CRS:84`);
  u.searchParams.set("COUNT", "500");
  const r = await fetchWithRetry(u.toString());
  const j = (await r.json()) as any;
  // une réponse sans liste d'objets est une erreur du service (pas « aucun bâtiment »)
  if (!Array.isArray(j?.features)) throw new Error("Réponse WFS invalide");
  const out: Building[] = [];
  for (const f of j.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    const polys: number[][][][] = g.type === "MultiPolygon" ? g.coordinates : g.type === "Polygon" ? [g.coordinates] : [];
    polys.forEach((poly, i) => {
      const ring = poly[0].map((c) => [c[0], c[1]] as LonLat);
      if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
      if (ring.length >= 3)
        out.push({
          id: polys.length > 1 ? `${f.properties?.cleabs ?? f.id}-${i}` : String(f.properties?.cleabs ?? f.id),
          ring,
          height: f.properties?.hauteur ?? null,
          usage: f.properties?.usage_1 ?? null,
        });
    });
  }
  return out;
}

/**
 * MNS LiDAR HD (résolution native 0,5 m) sur une emprise Lambert-93.
 * Renvoie null si la zone n'est pas couverte.
 */
export async function ignDsm(
  frame: LocalFrame,
  bboxL93: [number, number, number, number],
  res = 0.5,
): Promise<DsmGrid | null> {
  const [x0, y0, x1, y1] = bboxL93;
  const W = Math.max(8, Math.round((x1 - x0) / res));
  const H = Math.max(8, Math.round((y1 - y0) / res));
  const X1 = x0 + W * res;
  const Y1 = y0 + H * res;
  const u = new URL(`${IGN_BASE}/wms-r/wms`);
  u.searchParams.set("SERVICE", "WMS");
  u.searchParams.set("VERSION", "1.3.0");
  u.searchParams.set("REQUEST", "GetMap");
  u.searchParams.set("LAYERS", "IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93");
  u.searchParams.set("STYLES", "");
  u.searchParams.set("CRS", "EPSG:2154");
  u.searchParams.set("BBOX", `${x0},${y0},${X1},${Y1}`);
  u.searchParams.set("WIDTH", String(W));
  u.searchParams.set("HEIGHT", String(H));
  u.searchParams.set("FORMAT", "image/geotiff");
  const r = await fetchWithRetry(u.toString(), 3, 60000);
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("tiff")) return null;
  const tiff = await fromArrayBuffer(await r.arrayBuffer());
  const img = await tiff.getImage();
  const rasters = (await img.readRasters({ interleave: true })) as unknown as ArrayLike<number>;
  const nodataStr = img.getGDALNoData?.();
  const nodata = nodataStr != null ? Number(nodataStr) : null;
  const z = new Float32Array(W * H);
  let valid = 0;
  for (let k = 0; k < W * H; k++) {
    const v = Number(rasters[k]);
    const bad = !Number.isFinite(v) || v < -500 || v > 9000 || (nodata != null && v === nodata);
    z[k] = bad ? NaN : v;
    if (!bad) valid++;
  }
  if (valid < W * H * 0.5) return null;
  // vérification d'une donnée non constante (zone hors couverture = aplat)
  let mn = Infinity;
  let mx = -Infinity;
  for (let k = 0; k < W * H; k++)
    if (Number.isFinite(z[k])) {
      mn = Math.min(mn, z[k]);
      mx = Math.max(mx, z[k]);
    }
  if (mx - mn < 0.5) return null;
  const pix = (i: number, j: number) => toLocal(frame, fromL93([x0 + (i + 0.5) * res, Y1 - (j + 0.5) * res]));
  return {
    w: W,
    h: H,
    z,
    affine: affineFrom3(pix(0, 0), pix(W, 0), pix(0, H), W, H),
    cell: res,
    source: "IGN LiDAR HD (MNS 0,5 m)",
  };
}

/** Orthophoto IGN (JPEG) sur une emprise Lambert-93. */
export async function ignOrtho(bboxL93: [number, number, number, number], width: number, height: number): Promise<Buffer> {
  const [x0, y0, x1, y1] = bboxL93;
  const u = new URL(`${IGN_BASE}/wms-r/wms`);
  u.searchParams.set("SERVICE", "WMS");
  u.searchParams.set("VERSION", "1.3.0");
  u.searchParams.set("REQUEST", "GetMap");
  u.searchParams.set("LAYERS", "HR.ORTHOIMAGERY.ORTHOPHOTOS");
  u.searchParams.set("STYLES", "");
  u.searchParams.set("CRS", "EPSG:2154");
  u.searchParams.set("BBOX", `${x0},${y0},${x1},${y1}`);
  u.searchParams.set("WIDTH", String(Math.round(width)));
  u.searchParams.set("HEIGHT", String(Math.round(height)));
  u.searchParams.set("FORMAT", "image/jpeg");
  const r = await fetchWithRetry(u.toString(), 3, 60000);
  return Buffer.from(await r.arrayBuffer());
}
