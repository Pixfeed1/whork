import {
  type LonLat,
  type XY,
  makeFrame,
  toLocal,
  toLonLat,
  pointInPolygon,
  distToPolygonBoundary,
  centroid,
  polygonArea,
} from "../../shared/geo";
import { type RoofModel, type RoofFace, type RoofElement, newId } from "../../shared/roof";
import { ignBuildings, ignDsm, toL93, type Building } from "../providers/ign";
import { googleKey, solarBuildingInsights, solarDsm, type SolarInsights } from "../providers/google";
import { segmentRoof, planeAt, planeAngles } from "./segment";
import type { DsmGrid } from "./grid";
import { pixelToLocal } from "./grid";

export type SourcePref = "auto" | "ign" | "google";

export interface AnalyzeInput {
  points: LonLat[]; // 1er point = bâtiment principal ; suivants = bâtiments à ajouter
  source?: SourcePref;
  overhang?: number;
}

const DEG_LAT = 1 / 111000;

async function loadBuildings(p: LonLat, radius = 70): Promise<Building[] | null> {
  const dLat = radius * DEG_LAT;
  const dLon = dLat / Math.cos((p[1] * Math.PI) / 180);
  // le service WFS de l'IGN a parfois des ratés passagers : on réessaie avant d'abandonner
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await ignBuildings(p[0] - dLon, p[1] - dLat, p[0] + dLon, p[1] + dLat);
    } catch {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  return null; // service indisponible
}

function pickBuilding(bs: Building[], p: LonLat): Building | null {
  const f = makeFrame(p[0], p[1]);
  let best: Building | null = null;
  let bestD = 15;
  for (const b of bs) {
    const ring = b.ring.map((q) => toLocal(f, q));
    if (pointInPolygon([0, 0], ring)) return b;
    const d = distToPolygonBoundary([0, 0], ring);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

async function getDsm(
  pref: SourcePref,
  frame: ReturnType<typeof makeFrame>,
  extent: { min: XY; max: XY },
  center: LonLat,
): Promise<{ grid: DsmGrid; imageryDate?: string; imageryQuality?: string } | null> {
  const ign = async () => {
    const corners: XY[] = [
      [extent.min[0], extent.min[1]],
      [extent.max[0], extent.min[1]],
      [extent.max[0], extent.max[1]],
      [extent.min[0], extent.max[1]],
    ];
    const l93 = corners.map((c) => toL93(toLonLat(frame, c)));
    const bbox: [number, number, number, number] = [
      Math.floor(Math.min(...l93.map((c) => c[0]))),
      Math.floor(Math.min(...l93.map((c) => c[1]))),
      Math.ceil(Math.max(...l93.map((c) => c[0]))),
      Math.ceil(Math.max(...l93.map((c) => c[1]))),
    ];
    // hors France métropolitaine : inutile d'interroger l'IGN
    if (bbox[0] < 50000 || bbox[0] > 1300000 || bbox[1] < 6000000 || bbox[1] > 7200000) return null;
    const g = await ignDsm(frame, bbox, 0.5).catch(() => null);
    return g ? { grid: g } : null;
  };
  const google = async () => {
    if (!googleKey()) return null;
    const r = Math.max(extent.max[0] - extent.min[0], extent.max[1] - extent.min[1]) / 2 + 2;
    return solarDsm(frame, center[0], center[1], r).catch(() => null);
  };
  if (pref === "google") return (await google()) ?? (await ign());
  return (await ign()) ?? (await google());
}

export async function analyzeRoof(input: AnalyzeInput): Promise<RoofModel> {
  const warnings: string[] = [];
  const p0 = input.points[0];
  const loaded = await loadBuildings(p0);
  const buildings = loaded ?? [];
  const targetsB: Building[] = [];
  for (const p of input.points) {
    const b = pickBuilding(buildings, p);
    if (b && !targetsB.includes(b)) targetsB.push(b);
  }

  let origin: LonLat = p0;
  if (targetsB.length) {
    const f0 = makeFrame(p0[0], p0[1]);
    const c = centroid(targetsB[0].ring.map((q) => toLocal(f0, q)));
    origin = toLonLat(f0, c);
  }
  const frame = makeFrame(origin[0], origin[1]);

  let targets: XY[][] = targetsB.map((b) => b.ring.map((q) => toLocal(frame, q)));
  let align = true;
  if (!targets.length) {
    warnings.push(
      loaded === null
        ? "Le service des bâtiments de l'IGN n'a pas répondu : relancez la détection dans quelques instants."
        : "Bâtiment introuvable dans la BD TOPO : contours à vérifier.",
    );
    const s = 9;
    const c = toLocal(frame, p0);
    targets = [
      [
        [c[0] - s, c[1] - s],
        [c[0] + s, c[1] - s],
        [c[0] + s, c[1] + s],
        [c[0] - s, c[1] + s],
      ],
    ];
    align = false;
  }
  const allPts = targets.flat();
  const margin = 14;
  const extent = {
    min: [Math.min(...allPts.map((p) => p[0])) - margin, Math.min(...allPts.map((p) => p[1])) - margin] as XY,
    max: [Math.max(...allPts.map((p) => p[0])) + margin, Math.max(...allPts.map((p) => p[1])) + margin] as XY,
  };
  const neighbors = buildings
    .filter((b) => !targetsB.includes(b))
    .map((b) => b.ring.map((q) => toLocal(frame, q)))
    .filter((r) =>
      r.some((p) => p[0] > extent.min[0] && p[0] < extent.max[0] && p[1] > extent.min[1] && p[1] < extent.max[1]),
    );

  const pref = input.source ?? "auto";
  const [dsm, insights] = await Promise.all([
    getDsm(pref, frame, extent, origin),
    googleKey() ? solarBuildingInsights(p0[0], p0[1]).catch(() => null) : Promise.resolve(null as SolarInsights | null),
  ]);

  const faces: RoofFace[] = [];
  const elements: RoofElement[] = [];
  let diagnostics: Record<string, unknown> = {};
  let shift: XY = [0, 0];
  if (!dsm) {
    warnings.push(
      "Aucun relevé 3D disponible pour ce bâtiment (LiDAR HD IGN / Google Solar). Dessinez les pans manuellement.",
    );
  } else {
    const seg = segmentRoof(dsm.grid, targets, neighbors, { overhang: input.overhang ?? 0.8, alignFootprint: align });
    shift = seg.shift;
    diagnostics = { ...seg.diagnostics, ground: seg.ground, shift: seg.shift };
    for (const f of seg.faces) {
      const c = centroid(f.ring);
      faces.push({
        id: newId("pan"),
        ring: f.ring.map((p) => toLonLat(frame, p)),
        pitchDeg: Math.round(f.pitchDeg * 10) / 10,
        azimuthDeg: Math.round(f.azimuthDeg),
        plane: { anchor: toLonLat(frame, c), z: Math.round(planeAt(f.plane, c[0], c[1]) * 100) / 100 },
        source: "auto",
      });
    }
    for (const c of seg.chimneys)
      elements.push({ id: newId("el"), type: "cheminee", center: toLonLat(frame, c.center), width: c.width, length: c.length, auto: true });
    if (!faces.length) warnings.push("Aucun pan détecté automatiquement : dessinez les pans manuellement.");
    const cov = (seg.diagnostics.coverage as number) ?? 0;
    const rms = seg.diagnostics.meanRms;
    diagnostics.confidence = !faces.length ? "faible" : cov > 0.9 && rms < 0.12 ? "élevée" : cov > 0.75 && rms < 0.2 ? "moyenne" : "faible";
  }

  const footprint = targetsB.length
    ? targetsB[0].ring.map((q) => {
        const l = toLocal(frame, q);
        return toLonLat(frame, [l[0] + shift[0], l[1] + shift[1]]);
      })
    : null;

  // murs mitoyens : un bâtiment voisin touche le côté de l'emprise
  let footprintMitoyen: boolean[] | null = null;
  if (targetsB.length) {
    const fp = targets[0].map((p) => [p[0] + shift[0], p[1] + shift[1]] as XY);
    const nbs = neighbors.map((r) => r.map((p) => [p[0] + shift[0], p[1] + shift[1]] as XY));
    const ccw = polygonArea(fp) > 0;
    footprintMitoyen = fp.map((a, i) => {
      const b = fp[(i + 1) % fp.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.3) return false;
      // normale extérieure
      let nx = (b[1] - a[1]) / L;
      let ny = -(b[0] - a[0]) / L;
      if (!ccw) {
        nx = -nx;
        ny = -ny;
      }
      let hits = 0;
      for (const t of [0.2, 0.5, 0.8]) {
        const q: XY = [a[0] + (b[0] - a[0]) * t + nx * 0.6, a[1] + (b[1] - a[1]) * t + ny * 0.6];
        if (nbs.some((nb) => pointInPolygon(q, nb))) hits++;
      }
      return hits >= 2;
    });
  }

  return {
    version: 1,
    origin,
    footprintMitoyen,
    faces,
    elements,
    edgeOverrides: {},
    footprint,
    meta: {
      analyzedAt: new Date().toISOString(),
      points: input.points,
      source: input.source ?? "auto",
      dsmSource: dsm?.grid.source ?? null,
      imageryDate: dsm?.imageryDate ?? insights?.imageryDate ?? null,
      imageryQuality: dsm?.imageryQuality ?? insights?.imageryQuality ?? null,
      buildingIds: targetsB.map((b) => b.id),
      diagnostics,
      warnings,
      google: insights
        ? {
            wholeRoofArea: insights.wholeRoofArea,
            segmentCount: insights.segments.length,
            imageryDate: insights.imageryDate,
            imageryQuality: insights.imageryQuality,
          }
        : null,
    },
  };
}

/** Ajuste la pente / l'orientation d'un pan dessiné à la main sur le relevé 3D. */
export async function fitFace(
  ring: LonLat[],
  source: SourcePref = "auto",
): Promise<{ pitchDeg: number; azimuthDeg: number; plane: { anchor: LonLat; z: number }; rms: number } | null> {
  const f0 = makeFrame(ring[0][0], ring[0][1]);
  const loc0 = ring.map((p) => toLocal(f0, p));
  const origin = toLonLat(f0, centroid(loc0));
  const frame = makeFrame(origin[0], origin[1]);
  const loc = ring.map((p) => toLocal(frame, p));
  const extent = {
    min: [Math.min(...loc.map((p) => p[0])) - 2, Math.min(...loc.map((p) => p[1])) - 2] as XY,
    max: [Math.max(...loc.map((p) => p[0])) + 2, Math.max(...loc.map((p) => p[1])) + 2] as XY,
  };
  const dsm = await getDsm(source, frame, extent, origin);
  if (!dsm) return null;
  const g = dsm.grid;
  // érosion légère : on ignore 0,4 m le long des bords (arêtes, débords)
  const pts: [number, number, number][] = [];
  for (let j = 0; j < g.h; j++)
    for (let i = 0; i < g.w; i++) {
      const p = pixelToLocal(g, i, j);
      const zz = g.z[j * g.w + i];
      if (!Number.isFinite(zz) || !pointInPolygon(p, loc)) continue;
      if (distToPolygonBoundary(p, loc) < 0.4) continue;
      pts.push([p[0], p[1], zz]);
    }
  if (pts.length < 6) return null;
  let plane = lsq(pts);
  if (!plane) return null;
  const res = pts.map((p) => Math.abs(p[2] - planeAt(plane!, p[0], p[1])));
  const sorted = res.slice().sort((a, b) => a - b);
  const thr = Math.max(0.1, sorted[Math.floor(sorted.length * 0.8)] * 1.5);
  plane = lsq(pts.filter((_, i) => res[i] <= thr)) ?? plane;
  const rms = Math.sqrt(pts.reduce((s, p) => s + (p[2] - planeAt(plane!, p[0], p[1])) ** 2, 0) / pts.length);
  const ang = planeAngles(plane);
  return {
    pitchDeg: Math.round(ang.pitchDeg * 10) / 10,
    azimuthDeg: Math.round(ang.azimuthDeg),
    plane: { anchor: origin, z: Math.round(plane.c * 100) / 100 },
    rms,
  };
}

function lsq(pts: [number, number, number][]) {
  let sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
  const n = pts.length;
  for (const [x, y, z] of pts) {
    sx += x; sy += y; sz += z; sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z;
  }
  const mx = sx / n, my = sy / n, mz = sz / n;
  const cxx = sxx / n - mx * mx, cxy = sxy / n - mx * my, cyy = syy / n - my * my;
  const cxz = sxz / n - mx * mz, cyz = syz / n - my * mz;
  const det = cxx * cyy - cxy * cxy;
  if (Math.abs(det) < 1e-9) return null;
  const a = (cxz * cyy - cyz * cxy) / det;
  const b = (cyz * cxx - cxz * cxy) / det;
  return { a, b, c: mz - a * mx - b * my };
}
