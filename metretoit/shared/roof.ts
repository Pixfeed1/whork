// Modèle de toiture + moteur de métré (partagé navigateur / serveur).
//
// Une toiture = un ensemble de pans plans. Chaque pan est un polygone
// (projection au sol, en lon/lat WGS84), une pente et une orientation
// (azimut de la ligne de plus grande pente, sens descendant).
// Les arêtes (faîtages, noues, égouts...) ne sont PAS stockées : elles sont
// déduites de la géométrie des pans, puis classées automatiquement.
// L'utilisateur peut forcer le type d'une arête (edgeOverrides).

import {
  type LonLat,
  type XY,
  type LocalFrame,
  makeFrame,
  toLocal,
  toLonLat,
  polygonArea,
  centroid,
  distPointSegment,
  pointInPolygon,
} from "./geo";

export type EdgeType = "faitage" | "aretier" | "noue" | "egout" | "rive" | "solin" | "bris";

export const EDGE_TYPES: { type: EdgeType; label: string; color: string; help: string }[] = [
  { type: "faitage", label: "Faîtage", color: "#e53935", help: "Arête horizontale haute entre deux pans" },
  { type: "aretier", label: "Arêtier", color: "#fb8c00", help: "Arête inclinée saillante entre deux pans" },
  { type: "noue", label: "Noue", color: "#1e88e5", help: "Arête rentrante entre deux pans" },
  { type: "egout", label: "Égout", color: "#43a047", help: "Bas de pente (gouttière)" },
  { type: "rive", label: "Rive", color: "#8e24aa", help: "Bord latéral incliné" },
  { type: "solin", label: "Solin / rive haute", color: "#6d4c41", help: "Raccord contre un mur ou haut de pan" },
  { type: "bris", label: "Changement de pente", color: "#00897b", help: "Ligne de bris (mansarde, coyau...)" },
];

export const EDGE_LABEL: Record<EdgeType, string> = Object.fromEntries(
  EDGE_TYPES.map((e) => [e.type, e.label]),
) as Record<EdgeType, string>;
export const EDGE_COLOR: Record<EdgeType, string> = Object.fromEntries(
  EDGE_TYPES.map((e) => [e.type, e.color]),
) as Record<EdgeType, string>;

export interface FacePlane {
  /** point d'ancrage (lon/lat) */
  anchor: LonLat;
  /** altitude du plan au point d'ancrage (m) */
  z: number;
}

export interface RoofFace {
  id: string;
  /** anneau extérieur (projection au sol), sans répétition du 1er point */
  ring: LonLat[];
  /** pente en degrés (0 = plat) */
  pitchDeg: number;
  /** azimut de la pente descendante, en degrés depuis le Nord, sens horaire */
  azimuthDeg: number;
  /** plan absolu (si connu par mesure) : permet de détecter les décrochés */
  plane?: FacePlane | null;
  source?: "auto" | "manual" | "google";
}

// ---------- éléments de toiture (cheminées, fenêtres de toit, lucarnes) ----------
export type ElementType = "cheminee" | "chassis" | "lucarne";

export const ELEMENT_TYPES: { type: ElementType; label: string; plural: string; width: number; length: number; color: string }[] = [
  { type: "cheminee", label: "Cheminée", plural: "Cheminées", width: 0.6, length: 0.6, color: "#7c2d12" },
  { type: "chassis", label: "Fenêtre de toit", plural: "Fenêtres de toit", width: 0.78, length: 0.98, color: "#0369a1" },
  { type: "lucarne", label: "Lucarne", plural: "Lucarnes", width: 1.4, length: 1.6, color: "#6d28d9" },
];
export const ELEMENT_LABEL: Record<ElementType, string> = Object.fromEntries(ELEMENT_TYPES.map((e) => [e.type, e.label])) as Record<
  ElementType,
  string
>;

export interface RoofElement {
  id: string;
  type: ElementType;
  /** centre (lon/lat) */
  center: LonLat;
  /** largeur, parallèle à l'égout (m) */
  width: number;
  /** longueur dans le sens de la pente, en vraie grandeur (m) */
  length: number;
  /** détecté automatiquement (à vérifier) */
  auto?: boolean;
}

export interface ElementMetrics {
  id: string;
  index: number;
  type: ElementType;
  label: string;
  faceId: string | null;
  ring: LonLat[]; // emprise au sol (haut-gauche, haut-droit, bas-droit, bas-gauche ; « haut » = côté amont)
  width: number;
  length: number;
  lines: { key: string; label: string; length: number }[];
}

export interface RoofModel {
  version: 1;
  origin: LonLat;
  faces: RoofFace[];
  elements?: RoofElement[];
  edgeOverrides: Record<string, EdgeType>;
  /** emprise du bâtiment (cadastre / BD TOPO) pour affichage */
  footprint?: LonLat[] | null;
  meta?: Record<string, unknown>;
}

export interface FaceMetrics {
  id: string;
  index: number;
  area: number; // m² rampant (surface réelle)
  area2D: number; // m² projetée au sol
  pitchDeg: number;
  pitchPct: number;
  azimuthDeg: number;
  orientation: string;
  centroid: LonLat;
}

export interface EdgeMetrics {
  key: string;
  a: LonLat;
  b: LonLat;
  faces: string[];
  type: EdgeType;
  autoType: EdgeType;
  overridden: boolean;
  length: number; // m, vraie grandeur (3D)
  length2D: number;
  slopeDeg: number; // inclinaison de l'arête
}

export interface RoofMetrics {
  faces: FaceMetrics[];
  edges: EdgeMetrics[];
  elements: ElementMetrics[];
  /** linéaires de raccords (solins, abergements), cumulés par libellé */
  flashing: { key: string; label: string; length: number }[];
  totals: {
    area: number;
    area2D: number;
    faceCount: number;
    meanPitchDeg: number;
    maxPitchDeg: number;
    lengths: Record<EdgeType, number>;
    perimeter: number;
  };
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function orientationLabel(az: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  const i = Math.round((((az % 360) + 360) % 360) / 45) % 8;
  return names[i];
}

export function pitchPercent(deg: number): number {
  return Math.tan(deg * D2R) * 100;
}

/** vecteur unitaire (x=Est, y=Nord) dans le sens de la descente */
export function downVector(azimuthDeg: number): XY {
  return [Math.sin(azimuthDeg * D2R), Math.cos(azimuthDeg * D2R)];
}

export function planeZ(face: RoofFace, frame: LocalFrame, p: XY): number | null {
  if (!face.plane) return null;
  const a = toLocal(frame, face.plane.anchor);
  const d = downVector(face.azimuthDeg);
  const s = Math.tan(face.pitchDeg * D2R);
  return face.plane.z - s * ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]);
}

export function vertexKey(p: LonLat): string {
  return `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
}

export function edgeKey(a: LonLat, b: LonLat): string {
  const ka = vertexKey(a);
  const kb = vertexKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

interface Seg {
  faceId: string;
  a: number; // index sommet canonique
  b: number;
}

/**
 * Calcule surfaces, linéaires et classement des arêtes.
 * Tolérance de fusion des sommets : 3 cm.
 */
export function computeMetrics(model: RoofModel): RoofMetrics {
  const frame = makeFrame(model.origin[0], model.origin[1]);
  const faces = model.faces.filter((f) => f.ring.length >= 3);

  // --- sommets canoniques ---
  const verts: XY[] = [];
  const vertsLL: LonLat[] = [];
  const TOL = 0.03;
  const canon = (ll: LonLat): number => {
    const p = toLocal(frame, ll);
    for (let i = 0; i < verts.length; i++) {
      if (Math.abs(verts[i][0] - p[0]) < TOL && Math.abs(verts[i][1] - p[1]) < TOL) return i;
    }
    verts.push(p);
    vertsLL.push(ll);
    return verts.length - 1;
  };

  const faceRings: number[][] = [];
  const faceMetrics: FaceMetrics[] = [];
  faces.forEach((f, idx) => {
    let ring = f.ring.map(canon);
    // dédoublonnage consécutif
    ring = ring.filter((v, i) => v !== ring[(i + 1) % ring.length]);
    let xy = ring.map((i) => verts[i]);
    if (polygonArea(xy) < 0) {
      ring = ring.reverse();
      xy = xy.reverse();
    }
    faceRings.push(ring);
    const a2 = Math.abs(polygonArea(xy));
    const cp = Math.cos(f.pitchDeg * D2R);
    faceMetrics.push({
      id: f.id,
      index: idx + 1,
      area2D: a2,
      area: cp > 1e-6 ? a2 / cp : a2,
      pitchDeg: f.pitchDeg,
      pitchPct: pitchPercent(f.pitchDeg),
      azimuthDeg: ((f.azimuthDeg % 360) + 360) % 360,
      orientation: orientationLabel(f.azimuthDeg),
      centroid: toLonLat(frame, centroid(xy)),
    });
  });

  // --- segments, découpés aux sommets d'autres pans (jonctions en T) ---
  const segs: Seg[] = [];
  faces.forEach((f, fi) => {
    const ring = faceRings[fi];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const pa = verts[a];
      const pb = verts[b];
      const inner: { t: number; v: number }[] = [];
      for (let v = 0; v < verts.length; v++) {
        if (v === a || v === b) continue;
        const r = distPointSegment(verts[v], pa, pb);
        if (r.d < TOL && r.t > 1e-4 && r.t < 1 - 1e-4) inner.push({ t: r.t, v });
      }
      inner.sort((x, y) => x.t - y.t);
      const chain = [a, ...inner.map((x) => x.v), b];
      for (let k = 0; k < chain.length - 1; k++) segs.push({ faceId: f.id, a: chain[k], b: chain[k + 1] });
    }
  });

  // --- regroupement des segments identiques ---
  const groups = new Map<string, Seg[]>();
  for (const s of segs) {
    const k = s.a < s.b ? `${s.a}-${s.b}` : `${s.b}-${s.a}`;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }

  const faceById = new Map(faces.map((f) => [f.id, f]));
  const edges: EdgeMetrics[] = [];

  const sideInfo = (s: Seg) => {
    const f = faceById.get(s.faceId)!;
    const pa = verts[s.a];
    const pb = verts[s.b];
    const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    const d: XY = [(pb[0] - pa[0]) / L, (pb[1] - pa[1]) / L];
    // anneau CCW : intérieur à gauche de a->b
    const nIn: XY = [-d[1], d[0]];
    const dn = downVector(f.azimuthDeg);
    const sl = Math.tan(f.pitchDeg * D2R);
    const h = -sl * (dn[0] * nIn[0] + dn[1] * nIn[1]); // dz/dm en entrant dans le pan
    const g = -sl * (dn[0] * d[0] + dn[1] * d[1]); // dz/dm le long de l'arête
    const outDown = -(dn[0] * nIn[0] + dn[1] * nIn[1]); // cos(normale sortante, descente)
    return { f, L, h, g, outDown, mid: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2] as XY };
  };

  const boundaryType = (si: ReturnType<typeof sideInfo>): EdgeType => {
    if (si.f.pitchDeg < 4) return "rive";
    if (si.outDown > 0.6) return "egout";
    if (si.outDown < -0.6) return "solin";
    return "rive";
  };

  const pushEdge = (key: string, s: Seg, faceIds: string[], auto: EdgeType, g: number, L: number) => {
    const ov = model.edgeOverrides?.[key];
    edges.push({
      key,
      a: vertsLL[s.a],
      b: vertsLL[s.b],
      faces: faceIds,
      autoType: auto,
      type: ov ?? auto,
      overridden: !!ov && ov !== auto,
      length2D: L,
      length: L * Math.sqrt(1 + g * g),
      slopeDeg: Math.abs(Math.atan(g)) * R2D,
    });
  };

  for (const g of groups.values()) {
    const s0 = g[0];
    const key = edgeKey(vertsLL[s0.a], vertsLL[s0.b]);
    if (g.length === 1) {
      const si = sideInfo(s0);
      if (si.L < 0.01) continue;
      pushEdge(key, s0, [s0.faceId], boundaryType(si), si.g, si.L);
      continue;
    }
    // arête partagée (on ne garde que les deux premiers pans)
    const A = sideInfo(g[0]);
    const B = sideInfo(g[1]);
    if (A.L < 0.01) continue;
    const zA = planeZ(A.f, frame, A.mid);
    const zB = planeZ(B.f, frame, B.mid);
    if (zA != null && zB != null && Math.abs(zA - zB) > 0.6) {
      // décroché : chaque côté est une arête de bord
      const lower = zA < zB ? g[0] : g[1];
      const upper = zA < zB ? g[1] : g[0];
      const Si = zA < zB ? A : B;
      const Su = zA < zB ? B : A;
      pushEdge(`${key}#${lower.faceId}`, lower, [lower.faceId], "solin", Si.g, Si.L);
      const ut = boundaryType(Su);
      pushEdge(`${key}#${upper.faceId}`, upper, [upper.faceId], ut === "solin" ? "rive" : ut, Su.g, Su.L);
      continue;
    }
    const gm = (Math.abs(A.g) + Math.abs(B.g)) / 2;
    const horizontal = Math.atan(gm) * R2D < 8;
    const eps = 0.02;
    let t: EdgeType;
    const sum = A.h + B.h;
    if (horizontal) {
      if (A.h < -eps && B.h < -eps) t = "faitage";
      else if (A.h > eps && B.h > eps) t = "noue";
      else t = "bris";
    } else if (Math.abs(sum) < eps) t = "bris";
    else t = sum < 0 ? "aretier" : "noue";
    pushEdge(key, s0, [g[0].faceId, g[1].faceId], t, gm, A.L);
  }

  const lengths = Object.fromEntries(EDGE_TYPES.map((e) => [e.type, 0])) as Record<EdgeType, number>;
  let perimeter = 0;
  for (const e of edges) {
    lengths[e.type] += e.length;
    if (e.faces.length === 1) perimeter += e.length2D;
  }
  const area = faceMetrics.reduce((s, f) => s + f.area, 0);
  const area2D = faceMetrics.reduce((s, f) => s + f.area2D, 0);
  const meanPitch = area2D > 0 ? faceMetrics.reduce((s, f) => s + f.pitchDeg * f.area2D, 0) / area2D : 0;

  // éléments de toiture
  const elements: ElementMetrics[] = [];
  const flashMap = new Map<string, { key: string; label: string; length: number }>();
  (model.elements ?? []).forEach((el, i) => {
    const em = elementGeometry(el, faces, frame, i + 1);
    elements.push(em);
    for (const l of em.lines) {
      const f = flashMap.get(l.key);
      if (f) f.length += l.length;
      else flashMap.set(l.key, { ...l });
    }
  });

  return {
    faces: faceMetrics,
    edges,
    elements,
    flashing: [...flashMap.values()],
    totals: {
      area,
      area2D,
      faceCount: faceMetrics.length,
      meanPitchDeg: meanPitch,
      maxPitchDeg: faceMetrics.reduce((m, f) => Math.max(m, f.pitchDeg), 0),
      lengths,
      perimeter,
    },
  };
}

/** pan qui contient un point (local), le plus petit s'il y en a plusieurs */
export function faceAt(faces: RoofFace[], frame: LocalFrame, p: XY): RoofFace | null {
  let best: RoofFace | null = null;
  let bestA = Infinity;
  for (const f of faces) {
    const ring = f.ring.map((q) => toLocal(frame, q));
    if (!pointInPolygon(p, ring)) continue;
    const a = Math.abs(polygonArea(ring));
    if (a < bestA) {
      bestA = a;
      best = f;
    }
  }
  return best;
}

export function elementGeometry(el: RoofElement, faces: RoofFace[], frame: LocalFrame, index: number): ElementMetrics {
  const c = toLocal(frame, el.center);
  const face = faceAt(faces, frame, c);
  const az = face?.azimuthDeg ?? 180;
  const pitch = face?.pitchDeg ?? 0;
  const dn = downVector(az); // vers l'aval
  const ac: XY = [-dn[1], dn[0]]; // le long de l'égout
  const hw = el.width / 2;
  const hl = (el.length * Math.cos(pitch * D2R)) / 2;
  const P = (sa: number, sd: number): LonLat => toLonLat(frame, [c[0] + ac[0] * hw * sa + dn[0] * hl * sd, c[1] + ac[1] * hw * sa + dn[1] * hl * sd]);
  const ring = [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)];
  const W = el.width;
  const L = el.length;
  let lines: ElementMetrics["lines"];
  if (el.type === "cheminee") {
    lines = [
      { key: "chem_amont", label: "Solin arrière de cheminée (amont)", length: W },
      { key: "chem_cotes", label: "Solins à gradins de cheminée (côtés)", length: 2 * L },
      { key: "chem_base", label: "Solin de base de cheminée (aval)", length: W },
      { key: "chem_contre", label: "Contre-solin de cheminée (périmètre)", length: 2 * (W + L) },
    ];
  } else if (el.type === "chassis") {
    lines = [{ key: "chassis_aberg", label: "Abergement de fenêtre de toit (périmètre)", length: 2 * (W + L) }];
  } else {
    lines = [
      { key: "luc_facade", label: "Lucarne : façade (largeur)", length: W },
      { key: "luc_joues", label: "Lucarne : raccords des joues (côtés)", length: 2 * L },
      { key: "luc_amont", label: "Lucarne : raccord amont", length: W },
    ];
  }
  return { id: el.id, index, type: el.type, label: ELEMENT_LABEL[el.type], faceId: face?.id ?? null, ring, width: W, length: L, lines };
}

export function emptyModel(origin: LonLat): RoofModel {
  return { version: 1, origin, faces: [], edgeOverrides: {} };
}

export function fmt(n: number, d = 2): string {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
}

let idCounter = 0;
export function newId(prefix = "p"): string {
  idCounter++;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}
