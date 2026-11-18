// Projection locale « tangente » (Est/Nord en mètres) autour d'une origine.
// Sur l'emprise d'un bâtiment (< 200 m) l'erreur est négligeable (< 1 mm),
// et contrairement au Lambert-93 ou au Web Mercator il n'y a pas
// d'altération d'échelle : les longueurs et surfaces sont vraies.

export type LonLat = [number, number];
export type XY = [number, number];

const A = 6378137.0; // WGS84 demi-grand axe
const E2 = 6.69437999014e-3; // excentricité²

export interface LocalFrame {
  lon0: number;
  lat0: number;
  /** mètres par radian de latitude */
  m: number;
  /** mètres par radian de longitude */
  n: number;
}

export function makeFrame(lon0: number, lat0: number): LocalFrame {
  const phi = (lat0 * Math.PI) / 180;
  const s = Math.sin(phi);
  const w = Math.sqrt(1 - E2 * s * s);
  const N = A / w; // rayon de courbure normal
  const M = (A * (1 - E2)) / (w * w * w); // rayon méridien
  return { lon0, lat0, m: M, n: N * Math.cos(phi) };
}

export function toLocal(f: LocalFrame, p: LonLat): XY {
  return [
    (((p[0] - f.lon0) * Math.PI) / 180) * f.n,
    (((p[1] - f.lat0) * Math.PI) / 180) * f.m,
  ];
}

export function toLonLat(f: LocalFrame, p: XY): LonLat {
  return [f.lon0 + ((p[0] / f.n) * 180) / Math.PI, f.lat0 + ((p[1] / f.m) * 180) / Math.PI];
}

// ---------- géométrie plane ----------

export function polygonArea(poly: XY[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2; // positif si sens anti-horaire
}

export function centroid(poly: XY[]): XY {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const c = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * c;
    cy += (p[1] + q[1]) * c;
    a += c;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(p: XY, poly: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distPointSegment(p: XY, a: XY, b: XY): { d: number; t: number; q: XY } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const q: XY = [a[0] + t * dx, a[1] + t * dy];
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), t, q };
}

export function distToPolygonBoundary(p: XY, poly: XY[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distPointSegment(p, poly[i], poly[(i + 1) % poly.length]).d);
  return d;
}

/** Douglas-Peucker sur un anneau fermé (sans répétition du 1er point). */
export function simplifyRing(ring: XY[], tol: number): XY[] {
  if (ring.length <= 4) return ring.slice();
  // on coupe l'anneau aux deux points les plus éloignés pour stabiliser
  let i0 = 0;
  let i1 = 0;
  let best = -1;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > best) {
      best = d;
      i1 = i;
    }
  }
  const a = [...ring.slice(i0, i1 + 1)];
  const b = [...ring.slice(i1), ring[0]];
  const sa = dp(a, tol);
  const sb = dp(b, tol);
  return [...sa.slice(0, -1), ...sb.slice(0, -1)];
}

function dp(pts: XY[], tol: number): XY[] {
  if (pts.length < 3) return pts.slice();
  let idx = -1;
  let dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distPointSegment(pts[i], pts[0], pts[pts.length - 1]).d;
    if (d > dmax) {
      dmax = d;
      idx = i;
    }
  }
  if (dmax <= tol) return [pts[0], pts[pts.length - 1]];
  const l = dp(pts.slice(0, idx + 1), tol);
  const r = dp(pts.slice(idx), tol);
  return [...l.slice(0, -1), ...r];
}

/** Supprime les sommets presque alignés et les doublons. */
export function cleanRing(ring: XY[], angTolDeg = 4, minLen = 0.05): XY[] {
  let r = ring.slice();
  let changed = true;
  while (changed && r.length > 3) {
    changed = false;
    for (let i = 0; i < r.length && r.length > 3; i++) {
      const p = r[(i - 1 + r.length) % r.length];
      const c = r[i];
      const n = r[(i + 1) % r.length];
      const l1 = Math.hypot(c[0] - p[0], c[1] - p[1]);
      const l2 = Math.hypot(n[0] - c[0], n[1] - c[1]);
      if (l1 < minLen) {
        r.splice(i, 1);
        changed = true;
        break;
      }
      const cross = (c[0] - p[0]) * (n[1] - c[1]) - (c[1] - p[1]) * (n[0] - c[0]);
      const dot = (c[0] - p[0]) * (n[0] - c[0]) + (c[1] - p[1]) * (n[1] - c[1]);
      const ang = Math.abs(Math.atan2(cross, dot)) * (180 / Math.PI);
      if (ang < angTolDeg && l2 > 0) {
        r.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return r;
}
