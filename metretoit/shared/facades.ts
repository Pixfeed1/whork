// Métré des façades (pour les peintres / façadiers).
//
// Les murs viennent de l'emprise du bâtiment (BD TOPO recalée sur le relevé 3D),
// ou à défaut du contour de la toiture. Chaque façade = suite de murs de même
// orientation. Sa surface brute = intégrale, le long du mur, de la hauteur entre
// le sol et la toiture au-dessus du mur : les pignons sont donc compris.
// Les murs mitoyens (bâtiment voisin collé) sont repérés à l'analyse et exclus.
import type { LonLat, XY } from "./geo";
import { makeFrame, toLocal, toLonLat, polygonArea } from "./geo";
import { type RoofModel, computeMetrics, faceAt, vertexKey } from "./roof";
import { roofHeightFn } from "./view3d";

export type OpeningType = "fenetre" | "porte_fenetre" | "porte" | "garage" | "baie" | "autre";

export const OPENING_TYPES: { type: OpeningType; label: string; width: number; height: number }[] = [
  { type: "fenetre", label: "Fenêtre", width: 1.0, height: 1.25 },
  { type: "porte_fenetre", label: "Porte-fenêtre", width: 1.2, height: 2.15 },
  { type: "porte", label: "Porte d'entrée", width: 0.9, height: 2.15 },
  { type: "garage", label: "Porte de garage", width: 2.4, height: 2.0 },
  { type: "baie", label: "Baie vitrée", width: 2.4, height: 2.15 },
  { type: "autre", label: "Autre ouverture", width: 1.0, height: 1.0 },
];
export const OPENING_LABEL = Object.fromEntries(OPENING_TYPES.map((o) => [o.type, o.label])) as Record<OpeningType, string>;

export interface Opening {
  id: string;
  type: OpeningType;
  count: number;
  width: number;
  height: number;
}

export interface FacadeOverride {
  /** façade non concernée (mitoyenne, cachée, hors chantier) */
  excluded?: boolean | null;
  /** hauteur à l'égout imposée (m) */
  eaveHeight?: number | null;
  openings?: Opening[];
  /** déduction forfaitaire des ouvertures (%) si aucune ouverture n'est saisie */
  deductPct?: number | null;
}

export interface FacadesConfig {
  enabled: boolean;
  /** déduction par défaut (%) pour les façades sans ouvertures saisies */
  defaultDeductPct?: number;
  overrides: Record<string, FacadeOverride>;
}

export interface FacadeMetrics {
  key: string;
  index: number;
  label: string; // « Façade sud »
  orientation: string; // « S »
  azimuth: number; // direction vers laquelle la façade regarde (degrés)
  segments: [LonLat, LonLat][];
  a: LonLat;
  b: LonLat;
  mid: LonLat;
  length: number;
  eaveHeight: number;
  maxHeight: number;
  grossArea: number;
  gableArea: number;
  openingsArea: number;
  openingsCount: number;
  deductPct: number;
  netArea: number;
  mitoyenAuto: boolean;
  excluded: boolean;
}

export interface FacadesResult {
  facades: FacadeMetrics[];
  source: "emprise" | "toiture";
  heightSource: "relevé" | "défaut";
  totals: { length: number; gross: number; openings: number; net: number; count: number };
}

const NAMES: [string, string][] = [
  ["N", "nord"],
  ["NE", "nord-est"],
  ["E", "est"],
  ["SE", "sud-est"],
  ["S", "sud"],
  ["SO", "sud-ouest"],
  ["O", "ouest"],
  ["NO", "nord-ouest"],
];
const R2D = 180 / Math.PI;
export const DEFAULT_EAVE_HEIGHT = 2.8;

/** contour extérieur du toit (arêtes de bord chaînées), si pas d'emprise */
function roofOutline(model: RoofModel): LonLat[] | null {
  const met = computeMetrics(model);
  const segs = met.edges.filter((e) => e.faces.length === 1 && !e.key.includes("#"));
  if (segs.length < 3) return null;
  const next = new Map<string, LonLat[]>();
  for (const e of segs) {
    for (const [p, q] of [
      [e.a, e.b],
      [e.b, e.a],
    ] as const) {
      const k = vertexKey(p);
      const arr = next.get(k) ?? [];
      arr.push(q);
      next.set(k, arr);
    }
  }
  const used = new Set<string>();
  let best: LonLat[] | null = null;
  const frame = makeFrame(model.origin[0], model.origin[1]);
  for (const e of segs) {
    const k0 = `${vertexKey(e.a)}>${vertexKey(e.b)}`;
    if (used.has(k0)) continue;
    const ring: LonLat[] = [e.a];
    let prev = e.a;
    let cur = e.b;
    used.add(k0);
    for (let guard = 0; guard < 2000; guard++) {
      if (vertexKey(cur) === vertexKey(e.a)) break;
      ring.push(cur);
      const cands = (next.get(vertexKey(cur)) ?? []).filter((q) => vertexKey(q) !== vertexKey(prev));
      const nxt = cands.find((q) => !used.has(`${vertexKey(cur)}>${vertexKey(q)}`));
      if (!nxt) break;
      used.add(`${vertexKey(cur)}>${vertexKey(nxt)}`);
      prev = cur;
      cur = nxt;
    }
    if (ring.length >= 3) {
      const a = Math.abs(polygonArea(ring.map((p) => toLocal(frame, p))));
      if (!best || a > Math.abs(polygonArea(best.map((p) => toLocal(frame, p))))) best = ring;
    }
  }
  return best;
}

export function computeFacades(model: RoofModel, cfg?: FacadesConfig | null): FacadesResult {
  const conf: FacadesConfig = cfg ?? (model as any).facades ?? { enabled: false, overrides: {} };
  const frame = makeFrame(model.origin[0], model.origin[1]);
  const empty: FacadesResult = { facades: [], source: "emprise", heightSource: "défaut", totals: { length: 0, gross: 0, openings: 0, net: 0, count: 0 } };
  let source: FacadesResult["source"] = "emprise";
  let ringLL: LonLat[] | null = model.footprint && model.footprint.length >= 3 ? model.footprint : null;
  let mitoyenFlags: boolean[] | null = (model as any).footprintMitoyen ?? null;
  if (!ringLL) {
    ringLL = roofOutline(model);
    mitoyenFlags = null;
    source = "toiture";
  }
  if (!ringLL) return empty;
  let ring = ringLL.map((p) => toLocal(frame, p));
  if (mitoyenFlags && mitoyenFlags.length !== ring.length) mitoyenFlags = null;
  // sens anti-horaire : l'extérieur est à droite de chaque côté
  if (polygonArea(ring) < 0) {
    ring = ring.slice().reverse();
    ringLL = ringLL.slice().reverse();
    // le côté i (ring[i] -> ring[i+1]) devient le côté n-2-i
    if (mitoyenFlags) {
      const n = mitoyenFlags.length;
      const f = mitoyenFlags;
      mitoyenFlags = f.map((_, i) => f[(n - 2 - i + n) % n]);
    }
  }
  const n = ring.length;

  // hauteurs : sol mesuré (relevé 3D) ou hauteur d'égout par défaut
  const H = model.faces.length ? roofHeightFn(model, frame) : null;
  const meta: any = model.meta ?? {};
  const g = Number(meta?.diagnostics?.ground);
  const ref = H?.ref ?? 0;
  const measured = !!H?.measured && Number.isFinite(g) && ref - g > 1.5 && ref - g < 15;
  const ground = measured ? g : ref - DEFAULT_EAVE_HEIGHT;

  // côtés du contour
  type Side = { a: XY; b: XY; len: number; dir: number; mitoyen: boolean; i: number };
  const sides: Side[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-3) continue;
    sides.push({ a, b, len, dir: Math.atan2(b[1] - a[1], b[0] - a[0]), mitoyen: !!mitoyenFlags?.[i], i });
  }
  if (!sides.length) return empty;
  // regroupement des côtés consécutifs de même direction (±20°) ; les petits décrochés (< 0,8 m) suivent leur voisin
  const angDiff = (x: number, y: number) => Math.abs(((x - y + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * R2D;
  // départ sur un vrai changement de direction pour ne pas couper une façade en deux
  let start = 0;
  for (let i = 0; i < sides.length; i++) {
    const prev = sides[(i - 1 + sides.length) % sides.length];
    if (sides[i].len >= 0.8 && angDiff(sides[i].dir, prev.dir) > 20) {
      start = i;
      break;
    }
  }
  const ordered = [...sides.slice(start), ...sides.slice(0, start)];
  const groups: Side[][] = [];
  for (const sd of ordered) {
    const g0 = groups[groups.length - 1];
    if (g0) {
      const main = g0.reduce((m, x) => (x.len > m.len ? x : m), g0[0]);
      if (sd.len < 0.8 || angDiff(sd.dir, main.dir) <= 20) {
        g0.push(sd);
        continue;
      }
    }
    groups.push([sd]);
  }

  const facades: FacadeMetrics[] = [];
  const step = 0.25;
  groups.forEach((grp, gi) => {
    const len = grp.reduce((s, x) => s + x.len, 0);
    if (len < 0.5) return;
    // orientation : normale sortante pondérée par la longueur
    let nx = 0;
    let ny = 0;
    for (const sd of grp) {
      nx += ((sd.b[1] - sd.a[1]) / sd.len) * sd.len;
      ny += (-(sd.b[0] - sd.a[0]) / sd.len) * sd.len;
    }
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    let az = Math.atan2(nx, ny) * R2D;
    if (az < 0) az += 360;
    const [code, name] = NAMES[Math.round(az / 45) % 8];
    const key = `f${gi + 1}`;
    const ov = conf.overrides?.[key] ?? {};
    // profil de hauteur le long des murs
    let area = 0;
    let gable = 0;
    let hmax = 0;
    const autoEave = ref - ground;
    const eaveH = ov.eaveHeight != null && ov.eaveHeight > 0 ? ov.eaveHeight : autoEave;
    for (const sd of grp) {
      const ux = (sd.b[0] - sd.a[0]) / sd.len;
      const uy = (sd.b[1] - sd.a[1]) / sd.len;
      const ins: XY = [-uy, ux]; // vers l'intérieur (anneau CCW)
      const k = Math.max(1, Math.ceil(sd.len / step));
      for (let j = 0; j < k; j++) {
        const t = ((j + 0.5) / k) * sd.len;
        const w: XY = [sd.a[0] + ux * t, sd.a[1] + uy * t]; // point sur le mur
        const p: XY = [w[0] + ins[0] * 0.3, w[1] + ins[1] * 0.3]; // juste à l'intérieur, pour trouver le pan
        const f = H ? faceAt(model.faces, frame, p) : null;
        const zr = f && H ? H.z(f, w) : ref;
        const h = Math.max(0, zr - ground - autoEave + eaveH);
        area += h * (sd.len / k);
        gable += Math.max(0, h - eaveH) * (sd.len / k);
        hmax = Math.max(hmax, h);
      }
    }
    const openings = ov.openings ?? [];
    const openingsCount = openings.reduce((s, o) => s + o.count, 0);
    const openArea = openings.reduce((s, o) => s + o.count * o.width * o.height, 0);
    const pct = openings.length ? 0 : (ov.deductPct ?? conf.defaultDeductPct ?? 0);
    const deduction = openings.length ? openArea : (area * pct) / 100;
    const mitLen = grp.filter((x) => x.mitoyen).reduce((s, x) => s + x.len, 0);
    const mitoyenAuto = mitLen > len / 2;
    const excluded = ov.excluded ?? mitoyenAuto;
    const first = grp[0].a;
    const last = grp[grp.length - 1].b;
    // milieu « en abscisse curviligne »
    let acc = 0;
    let mid: XY = first;
    for (const sd of grp) {
      if (acc + sd.len >= len / 2) {
        const t = (len / 2 - acc) / sd.len;
        mid = [sd.a[0] + (sd.b[0] - sd.a[0]) * t, sd.a[1] + (sd.b[1] - sd.a[1]) * t];
        break;
      }
      acc += sd.len;
    }
    facades.push({
      key,
      index: facades.length + 1,
      label: `Façade ${name}`,
      orientation: code,
      azimuth: Math.round(az),
      segments: grp.map((sd) => [toLonLat(frame, sd.a), toLonLat(frame, sd.b)] as [LonLat, LonLat]),
      a: toLonLat(frame, first),
      b: toLonLat(frame, last),
      mid: toLonLat(frame, mid),
      length: len,
      eaveHeight: eaveH,
      maxHeight: hmax,
      grossArea: area,
      gableArea: gable,
      openingsArea: Math.min(area, deduction),
      openingsCount,
      deductPct: pct,
      netArea: Math.max(0, area - deduction),
      mitoyenAuto,
      excluded,
    });
  });

  // libellés uniques : « Façade ouest 1 », « Façade ouest 2 »…
  const counts = new Map<string, number>();
  for (const f of facades) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const f of facades) {
    if ((counts.get(f.label) ?? 0) > 1) {
      const k = (seen.get(f.label) ?? 0) + 1;
      seen.set(f.label, k);
      f.label = `${f.label} ${k}`;
    }
  }
  const kept = facades.filter((f) => !f.excluded);
  return {
    facades,
    source,
    heightSource: measured ? "relevé" : "défaut",
    totals: {
      count: kept.length,
      length: kept.reduce((s, f) => s + f.length, 0),
      gross: kept.reduce((s, f) => s + f.grossArea, 0),
      openings: kept.reduce((s, f) => s + f.openingsArea, 0),
      net: kept.reduce((s, f) => s + f.netArea, 0),
    },
  };
}

/** point de prise de vue « depuis la rue » : à `dist` mètres devant la façade */
export function facadeViewpoint(model: RoofModel, f: FacadeMetrics, dist = 14): { target: LonLat; probe: LonLat } {
  const frame = makeFrame(model.origin[0], model.origin[1]);
  const m = toLocal(frame, f.mid);
  const az = (f.azimuth * Math.PI) / 180;
  return { target: f.mid, probe: toLonLat(frame, [m[0] + Math.sin(az) * dist, m[1] + Math.cos(az) * dist]) };
}

/** modifie les réglages d'une façade (renvoie un nouveau modèle) */
export function setFacadeOverride(model: RoofModel, key: string, patch: Partial<FacadeOverride>): RoofModel {
  const cfg: FacadesConfig = model.facades ?? { enabled: true, overrides: {} };
  return { ...model, facades: { ...cfg, overrides: { ...cfg.overrides, [key]: { ...(cfg.overrides[key] ?? {}), ...patch } } } };
}

export function setFacadesConfig(model: RoofModel, patch: Partial<FacadesConfig>): RoofModel {
  const cfg: FacadesConfig = model.facades ?? { enabled: false, overrides: {} };
  return { ...model, facades: { ...cfg, ...patch } };
}
