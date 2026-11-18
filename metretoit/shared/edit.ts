// Opérations d'édition du modèle de toiture (fonctions pures, testées).
import type { LonLat } from "./geo";
import { makeFrame, toLocal, distPointSegment, polygonArea } from "./geo";
import { type RoofModel, type RoofFace, type EdgeType, vertexKey, edgeKey, newId } from "./roof";

const clone = (m: RoofModel): RoofModel => JSON.parse(JSON.stringify(m));
const same = (a: LonLat, b: LonLat) => vertexKey(a) === vertexKey(b);

/** renomme un sommet dans les clés de surcharge d'arêtes */
function migrateOverrides(ov: Record<string, EdgeType>, from: LonLat, to: LonLat): Record<string, EdgeType> {
  const kf = vertexKey(from);
  const out: Record<string, EdgeType> = {};
  for (const [k, v] of Object.entries(ov)) {
    const [pair, suffix] = k.split("#");
    const [a, b] = pair.split("|");
    if (a !== kf && b !== kf) {
      out[k] = v;
      continue;
    }
    const pa = (a === kf ? to : (a.split(",").map(Number) as LonLat)) as LonLat;
    const pb = (b === kf ? to : (b.split(",").map(Number) as LonLat)) as LonLat;
    out[edgeKey(pa, pb) + (suffix ? `#${suffix}` : "")] = v;
  }
  return out;
}

export function moveVertex(model: RoofModel, from: LonLat, to: LonLat): RoofModel {
  const m = clone(model);
  for (const f of m.faces) {
    f.ring = f.ring.map((p) => (same(p, from) ? ([to[0], to[1]] as LonLat) : p));
    f.plane = f.plane ?? null;
  }
  m.edgeOverrides = migrateOverrides(m.edgeOverrides ?? {}, from, to);
  return dedupe(m);
}

/** supprime les sommets consécutifs identiques et les pans dégénérés */
function dedupe(m: RoofModel): RoofModel {
  const frame = makeFrame(m.origin[0], m.origin[1]);
  m.faces = m.faces
    .map((f) => ({ ...f, ring: f.ring.filter((p, i) => !same(p, f.ring[(i + 1) % f.ring.length])) }))
    .filter((f) => f.ring.length >= 3 && Math.abs(polygonArea(f.ring.map((p) => toLocal(frame, p)))) > 0.05);
  return m;
}

export function insertVertex(model: RoofModel, a: LonLat, b: LonLat, p: LonLat): RoofModel {
  const m = clone(model);
  for (const f of m.faces) {
    const n = f.ring.length;
    for (let i = 0; i < n; i++) {
      const u = f.ring[i];
      const v = f.ring[(i + 1) % n];
      if ((same(u, a) && same(v, b)) || (same(u, b) && same(v, a))) {
        f.ring.splice(i + 1, 0, [p[0], p[1]]);
        break;
      }
    }
  }
  // une arête coupée en deux : on reporte un éventuel type forcé sur les deux moitiés
  const k = edgeKey(a, b);
  const t = m.edgeOverrides[k];
  if (t) {
    delete m.edgeOverrides[k];
    m.edgeOverrides[edgeKey(a, p)] = t;
    m.edgeOverrides[edgeKey(p, b)] = t;
  }
  return m;
}

export function deleteVertex(model: RoofModel, p: LonLat): RoofModel {
  const m = clone(model);
  for (const f of m.faces) f.ring = f.ring.filter((q) => !same(q, p));
  const kp = vertexKey(p);
  for (const k of Object.keys(m.edgeOverrides)) if (k.split("#")[0].split("|").includes(kp)) delete m.edgeOverrides[k];
  return dedupe(m);
}

export function deleteFace(model: RoofModel, id: string): RoofModel {
  const m = clone(model);
  m.faces = m.faces.filter((f) => f.id !== id);
  return m;
}

export function updateFace(model: RoofModel, id: string, patch: Partial<RoofFace>): RoofModel {
  const m = clone(model);
  m.faces = m.faces.map((f) => (f.id === id ? { ...f, ...patch } : f));
  return m;
}

/**
 * Ajoute un pan. Chaque sommet du nouveau pan posé sur l'arête d'un pan
 * existant y est inséré, pour que les deux pans partagent bien l'arête.
 */
export function addFace(model: RoofModel, ring: LonLat[], pitchDeg = 30, azimuthDeg = 180): RoofModel {
  let m = clone(model);
  const frame = makeFrame(m.origin[0], m.origin[1]);
  for (const p of ring) {
    const lp = toLocal(frame, p);
    for (const f of m.faces) {
      if (f.ring.some((q) => same(q, p))) continue;
      for (let i = 0; i < f.ring.length; i++) {
        const a = f.ring[i];
        const b = f.ring[(i + 1) % f.ring.length];
        const r = distPointSegment(lp, toLocal(frame, a), toLocal(frame, b));
        if (r.d < 0.02 && r.t > 0.001 && r.t < 0.999) {
          m = insertVertex(m, a, b, p);
          break;
        }
      }
    }
  }
  m.faces.push({ id: newId("pan"), ring: ring.map((p) => [p[0], p[1]] as LonLat), pitchDeg, azimuthDeg, plane: null, source: "manual" });
  return m;
}

/** Découpe un pan selon le segment joignant deux de ses sommets. */
export function splitFace(model: RoofModel, id: string, a: LonLat, b: LonLat): { model: RoofModel; ids: string[] } | null {
  const m = clone(model);
  const f = m.faces.find((x) => x.id === id);
  if (!f) return null;
  let i = f.ring.findIndex((p) => same(p, a));
  let j = f.ring.findIndex((p) => same(p, b));
  if (i < 0 || j < 0 || i === j) return null;
  if (i > j) [i, j] = [j, i];
  // les deux sommets ne doivent pas être voisins
  if (j - i < 2 || (i === 0 && j === f.ring.length - 1)) return null;
  const r1 = f.ring.slice(i, j + 1);
  const r2 = [...f.ring.slice(j), ...f.ring.slice(0, i + 1)];
  if (r1.length < 3 || r2.length < 3) return null;
  const f1: RoofFace = { ...f, id: newId("pan"), ring: r1, source: "manual" };
  const f2: RoofFace = { ...f, id: newId("pan"), ring: r2, source: "manual" };
  m.faces = m.faces.flatMap((x) => (x.id === id ? [f1, f2] : [x]));
  return { model: m, ids: [f1.id, f2.id] };
}

export function setEdgeType(model: RoofModel, key: string, type: EdgeType | null): RoofModel {
  const m = clone(model);
  if (type) m.edgeOverrides[key] = type;
  else delete m.edgeOverrides[key];
  return m;
}

/** liste des sommets distincts */
export function uniqueVertices(model: RoofModel): LonLat[] {
  const seen = new Map<string, LonLat>();
  for (const f of model.faces) for (const p of f.ring) seen.set(vertexKey(p), p);
  return [...seen.values()];
}
