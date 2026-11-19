// Vues 3D axonométriques de la toiture (pans + éléments), sans dépendance :
// renvoie des polygones 2D déjà triés (algorithme du peintre) et ombrés.
import type { LonLat, XY } from "./geo";
import { makeFrame, toLocal } from "./geo";
import { type RoofModel, type RoofFace, computeMetrics, downVector, planeZ, faceAt, ELEMENT_TYPES } from "./roof";

export interface Poly3D {
  pts: XY[]; // coordonnées écran (y vers le bas), non mises à l'échelle
  fill: string;
  stroke: string;
  depth: number;
  kind: "face" | "element";
}

const D2R = Math.PI / 180;

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgb = (c: [number, number, number], k: number) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(255, v * k)))).join(",")})`;

/**
 * Altitude d'un point d'un pan, pour l'affichage 3D.
 * Chaque pan est reconstruit à partir de sa pente, en partant de son égout. Les égouts
 * proches (moins de 0,8 m d'écart) sont alignés sur une même hauteur : ainsi les pans d'un
 * même toit se rejoignent toujours proprement au faîtage, même si le relevé 3D est bruité
 * ou si une pente a été corrigée à la main. Les vrais décrochés (annexe plus basse) sont conservés.
 */
function zFn(model: RoofModel, frame: ReturnType<typeof makeFrame>) {
  const lowestProj = new Map<string, number>();
  const rawEave = new Map<string, number | null>();
  for (const f of model.faces) {
    const d = downVector(f.azimuthDeg);
    const ring = f.ring.map((q) => toLocal(frame, q));
    const proj = ring.map((l) => l[0] * d[0] + l[1] * d[1]);
    const lo = Math.max(...proj);
    lowestProj.set(f.id, lo);
    // altitude d'égout mesurée (plan du relevé), si disponible
    const lowPt = ring[proj.indexOf(lo)];
    rawEave.set(f.id, f.plane ? planeZ(f, frame, lowPt) : null);
  }
  const known = [...rawEave.values()].filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const ref = known.length ? known[Math.floor(known.length / 2)] : 0;
  // regroupement des égouts : à moins de 0,8 m de la référence, on aligne
  const eave = new Map<string, number>();
  for (const f of model.faces) {
    const r = rawEave.get(f.id);
    eave.set(f.id, r == null || !Number.isFinite(r) || Math.abs(r - ref) < 0.8 ? ref : r);
  }
  return (f: RoofFace, p: XY): number => {
    const d = downVector(f.azimuthDeg);
    const s = Math.tan(f.pitchDeg * D2R);
    return (eave.get(f.id) ?? ref) + s * ((lowestProj.get(f.id) ?? 0) - (p[0] * d[0] + p[1] * d[1]));
  };
}

/**
 * @param bearing direction d'où l'on regarde (degrés depuis le Nord : 225 = depuis le sud-ouest)
 * @param elevation angle de vue au-dessus de l'horizon (degrés)
 */
export function roofView(model: RoofModel, bearing: number, elevation = 32): Poly3D[] {
  const frame = makeFrame(model.origin[0], model.origin[1]);
  const Z = zFn(model, frame);
  const v: XY = [Math.sin(bearing * D2R), Math.cos(bearing * D2R)]; // vers l'observateur
  const right: XY = [-v[1], v[0]];
  const ce = Math.cos(elevation * D2R);
  const se = Math.sin(elevation * D2R);
  // lumière : depuis l'observateur, un peu à gauche et en hauteur
  const L = [v[0] * 0.55 - right[0] * 0.45, v[1] * 0.55 - right[1] * 0.45, 0.85];
  const ln = Math.hypot(L[0], L[1], L[2]);
  const proj = (x: number, y: number, z: number): { s: XY; d: number } => {
    const far = -(x * v[0] + y * v[1]);
    return { s: [x * right[0] + y * right[1], -(z * ce + far * se)], d: far * ce - z * se };
  };
  const polys: Poly3D[] = [];
  const shadeOf = (nx: number, ny: number, nz: number) => {
    const n = Math.hypot(nx, ny, nz) || 1;
    return 0.62 + 0.38 * Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / (n * ln));
  };
  const roofColor: [number, number, number] = [196, 98, 64]; // terre cuite
  const faceDepth = new Map<string, number>();
  for (const f of model.faces) {
    const pts3 = f.ring.map((q) => {
      const l = toLocal(frame, q);
      return [l[0], l[1], Z(f, l)] as const;
    });
    const pr = pts3.map(([x, y, z]) => proj(x, y, z));
    const dn = downVector(f.azimuthDeg);
    const sp = Math.sin(f.pitchDeg * D2R);
    const k = shadeOf(dn[0] * sp, dn[1] * sp, Math.cos(f.pitchDeg * D2R));
    const fd = pr.reduce((a, p) => a + p.d, 0) / pr.length;
    faceDepth.set(f.id, fd);
    polys.push({ pts: pr.map((p) => p.s), fill: rgb(roofColor, k), stroke: "#4a2a1c", depth: fd, kind: "face" });
  }
  // murs sous les bords du toit (égouts, rives, décrochés) pour lire les volumes
  const met = computeMetrics(model);
  const meta: any = model.meta ?? {};
  const allZ = model.faces.flatMap((f) => f.ring.map((q) => Z(f, toLocal(frame, q))));
  // sol : mesuré si possible (hauteur de mur plausible entre 2 et 9 m), sinon 2,8 m sous l'égout le plus bas
  const minZ = Math.min(...allZ);
  const g = Number(meta?.diagnostics?.ground);
  const ground = Number.isFinite(g) && minZ - g >= 2 && minZ - g <= 9 ? g : minZ - 2.8;
  const wallColor: [number, number, number] = [226, 220, 208];
  for (const e of met.edges) {
    if (e.faces.length !== 1) continue;
    const f = model.faces.find((x) => x.id === e.faces[0]);
    if (!f) continue;
    const a = toLocal(frame, e.a);
    const b = toLocal(frame, e.b);
    const za = Z(f, a);
    const zb = Z(f, b);
    if (Math.min(za, zb) - ground < 0.3) continue;
    // normale sortante : vers l'extérieur du pan
    const fr = f.ring.map((q) => toLocal(frame, q));
    const cxf = fr.reduce((s2, q) => s2 + q[0], 0) / fr.length;
    const cyf = fr.reduce((s2, q) => s2 + q[1], 0) / fr.length;
    let nx = b[1] - a[1];
    let ny = -(b[0] - a[0]);
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    if ((mx - cxf) * nx + (my - cyf) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    if (nx * v[0] + ny * v[1] <= 0) continue; // mur vu de dos
    const quad = [proj(a[0], a[1], za), proj(b[0], b[1], zb), proj(b[0], b[1], ground), proj(a[0], a[1], ground)];
    polys.push({
      pts: quad.map((q) => q.s),
      fill: rgb(wallColor, shadeOf(nx, ny, 0)),
      stroke: "#8b8378",
      depth: (quad[0].d + quad[1].d) / 2 + 0.01,
      kind: "face",
    });
  }

  // éléments : cheminées et lucarnes en volume, fenêtres de toit à plat
  for (const el of met.elements) {
    const face = model.faces.find((f) => f.id === el.faceId) ?? faceAt(model.faces, frame, toLocal(frame, el.ring[0]));
    const base = el.ring.map((q) => {
      const l = toLocal(frame, q);
      return [l[0], l[1], face ? Z(face, l) : 0] as [number, number, number];
    });
    const col = hexToRgb(ELEMENT_TYPES.find((x) => x.type === el.type)!.color);
    // un élément est toujours dessiné après (devant) le pan qui le porte
    const fd = face ? faceDepth.get(face.id) : undefined;
    const dd = (d: number) => (fd != null ? Math.min(d, fd - 0.001) : d);
    if (el.type === "chassis") {
      const pr = base.map(([x, y, z]) => proj(x, y, z + 0.05));
      polys.push({ pts: pr.map((p) => p.s), fill: "rgb(40,70,100)", stroke: "#e5e7eb", depth: dd(pr.reduce((a, p) => a + p.d, 0) / pr.length - 0.05), kind: "element" });
      continue;
    }
    const top = Math.max(...base.map((b) => b[2])) + (el.type === "cheminee" ? 0.9 : 0.6);
    const cx = base.reduce((a, b) => a + b[0], 0) / 4;
    const cy = base.reduce((a, b) => a + b[1], 0) / 4;
    for (let i = 0; i < 4; i++) {
      const a = base[i];
      const b = base[(i + 1) % 4];
      const quad = [proj(a[0], a[1], a[2]), proj(b[0], b[1], b[2]), proj(b[0], b[1], top), proj(a[0], a[1], top)];
      // normale sortante = du centre vers le milieu du côté
      const nx = (a[0] + b[0]) / 2 - cx;
      const ny = (a[1] + b[1]) / 2 - cy;
      if (nx * v[0] + ny * v[1] <= 0) continue; // côté caché
      polys.push({ pts: quad.map((q) => q.s), fill: rgb(col, shadeOf(nx, ny, 0) * 1.25), stroke: "#1f2937", depth: dd(quad.reduce((s, q) => s + q.d, 0) / 4 - 0.1), kind: "element" });
    }
    const tp = base.map(([x, y]) => proj(x, y, top));
    polys.push({ pts: tp.map((p) => p.s), fill: rgb(col, 1.35), stroke: "#1f2937", depth: dd(tp.reduce((s, q) => s + q.d, 0) / 4) - 0.2, kind: "element" });
  }
  polys.sort((a, b) => b.depth - a.depth);
  return polys;
}

/** cadrage : met à l'échelle les polygones dans une boîte (x, y, w, h) */
export function fitPolys(polys: Poly3D[], box: { x: number; y: number; w: number; h: number }, pad = 10): Poly3D[] {
  const xs = polys.flatMap((p) => p.pts.map((q) => q[0]));
  const ys = polys.flatMap((p) => p.pts.map((q) => q[1]));
  if (!xs.length) return [];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const s = Math.min((box.w - 2 * pad) / Math.max(0.1, x1 - x0), (box.h - 2 * pad) / Math.max(0.1, y1 - y0));
  const ox = box.x + (box.w - s * (x1 - x0)) / 2;
  const oy = box.y + (box.h - s * (y1 - y0)) / 2;
  return polys.map((p) => ({ ...p, pts: p.pts.map((q) => [ox + (q[0] - x0) * s, oy + (q[1] - y0) * s] as XY) }));
}

export const VIEW_BEARINGS: { label: string; bearing: number }[] = [
  { label: "Sud-ouest", bearing: 225 },
  { label: "Sud-est", bearing: 135 },
  { label: "Nord-ouest", bearing: 315 },
  { label: "Nord-est", bearing: 45 },
];

export type { LonLat };
