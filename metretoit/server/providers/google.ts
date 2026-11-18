// Google Maps Platform — Solar API (+ Geocoding en secours hors France).
// Activé uniquement si GOOGLE_MAPS_API_KEY est défini.
//  - buildingInsights:findClosest : pans (pente, azimut, surface), date et qualité d'image
//  - dataLayers:get               : MNS (DSM) GeoTIFF jusqu'à 0,1 m/pixel

import proj4 from "proj4";
import { fromArrayBuffer } from "geotiff";
import type { LonLat, LocalFrame } from "../../shared/geo";
import { toLocal } from "../../shared/geo";
import { type DsmGrid, affineFrom3 } from "../analysis/grid";
import type { GeocodeResult } from "./ign";

const SOLAR = "https://solar.googleapis.com/v1";

export function googleKey(): string | null {
  return process.env.GOOGLE_MAPS_API_KEY?.trim() || null;
}

export interface SolarSegment {
  pitchDegrees: number;
  azimuthDegrees: number;
  areaMeters2: number;
  groundAreaMeters2: number;
  center: LonLat;
  planeHeightAtCenterMeters?: number;
  bbox?: { sw: LonLat; ne: LonLat };
}

export interface SolarInsights {
  imageryDate?: string;
  imageryQuality?: string;
  center: LonLat;
  wholeRoofArea?: number;
  wholeRoofGroundArea?: number;
  segments: SolarSegment[];
}

const date = (d: any) =>
  d?.year ? `${d.year}-${String(d.month ?? 1).padStart(2, "0")}-${String(d.day ?? 1).padStart(2, "0")}` : undefined;

export async function solarBuildingInsights(lon: number, lat: number): Promise<SolarInsights | null> {
  const key = googleKey();
  if (!key) return null;
  const u = new URL(`${SOLAR}/buildingInsights:findClosest`);
  u.searchParams.set("location.latitude", String(lat));
  u.searchParams.set("location.longitude", String(lon));
  u.searchParams.set("requiredQuality", "LOW");
  u.searchParams.set("key", key);
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Google Solar API : HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as any;
  const sp = j.solarPotential ?? {};
  return {
    imageryDate: date(j.imageryDate),
    imageryQuality: j.imageryQuality,
    center: [j.center?.longitude, j.center?.latitude],
    wholeRoofArea: sp.wholeRoofStats?.areaMeters2,
    wholeRoofGroundArea: sp.wholeRoofStats?.groundAreaMeters2,
    segments: (sp.roofSegmentStats ?? []).map((s: any) => ({
      pitchDegrees: s.pitchDegrees ?? 0,
      azimuthDegrees: s.azimuthDegrees ?? 0,
      areaMeters2: s.stats?.areaMeters2 ?? 0,
      groundAreaMeters2: s.stats?.groundAreaMeters2 ?? 0,
      center: [s.center?.longitude, s.center?.latitude],
      planeHeightAtCenterMeters: s.planeHeightAtCenterMeters,
      bbox: s.boundingBox
        ? {
            sw: [s.boundingBox.sw.longitude, s.boundingBox.sw.latitude],
            ne: [s.boundingBox.ne.longitude, s.boundingBox.ne.latitude],
          }
        : undefined,
    })),
  };
}

function utmDef(epsg: number): string | null {
  if (epsg >= 32601 && epsg <= 32660) return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
  if (epsg >= 32701 && epsg <= 32760) return `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
  return null;
}

/** MNS Google Solar sous forme de grille locale. */
export async function solarDsm(
  frame: LocalFrame,
  lon: number,
  lat: number,
  radiusMeters: number,
): Promise<{ grid: DsmGrid; imageryDate?: string; imageryQuality?: string } | null> {
  const key = googleKey();
  if (!key) return null;
  const u = new URL(`${SOLAR}/dataLayers:get`);
  u.searchParams.set("location.latitude", String(lat));
  u.searchParams.set("location.longitude", String(lon));
  u.searchParams.set("radiusMeters", String(Math.min(100, Math.max(15, Math.ceil(radiusMeters)))));
  u.searchParams.set("view", "DSM_LAYER");
  u.searchParams.set("requiredQuality", "LOW");
  u.searchParams.set("pixelSizeMeters", "0.25");
  u.searchParams.set("key", key);
  const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Google Solar dataLayers : HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as any;
  if (!j.dsmUrl) return null;
  const sep = j.dsmUrl.includes("?") ? "&" : "?";
  const tr = await fetch(`${j.dsmUrl}${sep}key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(60000) });
  if (!tr.ok) throw new Error(`Google Solar GeoTIFF : HTTP ${tr.status}`);
  const tiff = await fromArrayBuffer(await tr.arrayBuffer());
  const img = await tiff.getImage();
  const W = img.getWidth();
  const H = img.getHeight();
  const [ox, oy] = img.getOrigin();
  const [rx, ry] = img.getResolution();
  const gk = img.getGeoKeys() as any;
  const epsg = gk.ProjectedCSTypeGeoKey ?? gk.GeographicTypeGeoKey;
  const def = epsg === 4326 ? "EPSG:4326" : utmDef(epsg);
  if (!def) throw new Error(`Projection GeoTIFF non gérée : EPSG ${epsg}`);
  const rasters = (await img.readRasters({ interleave: true })) as unknown as ArrayLike<number>;
  const z = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) {
    const v = Number(rasters[k]);
    z[k] = Number.isFinite(v) && v > -500 && v < 9000 ? v : NaN;
  }
  const pix = (i: number, jj: number) => {
    const x = ox + (i + 0.5) * rx;
    const y = oy + (jj + 0.5) * ry;
    const ll = (def === "EPSG:4326" ? [x, y] : proj4(def, "EPSG:4326", [x, y])) as LonLat;
    return toLocal(frame, ll);
  };
  return {
    grid: {
      w: W,
      h: H,
      z,
      affine: affineFrom3(pix(0, 0), pix(W, 0), pix(0, H), W, H),
      cell: Math.abs(rx),
      source: `Google Solar API (DSM ${Math.abs(rx)} m)`,
    },
    imageryDate: date(j.imageryDate),
    imageryQuality: j.imageryQuality,
  };
}

export async function googleGeocode(q: string): Promise<GeocodeResult[]> {
  const key = googleKey();
  if (!key) return [];
  const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  u.searchParams.set("address", q);
  u.searchParams.set("language", "fr");
  u.searchParams.set("key", key);
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) return [];
  const j = (await r.json()) as any;
  return (j.results ?? []).slice(0, 5).map((x: any) => ({
    label: x.formatted_address,
    lon: x.geometry.location.lng,
    lat: x.geometry.location.lat,
    score: 1,
    type: x.types?.[0],
  }));
}
