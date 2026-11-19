// Extraction automatique des pans de toiture à partir d'un Modèle Numérique
// de Surface (LiDAR HD IGN ou Google Solar DSM).
//
// Étapes :
//  1. recalage de l'emprise cadastrale sur le relief
//  2. masque « toiture » (au-dessus du sol, dans l'emprise + débord, hors voisins)
//  3. croissance de régions planes (normales + distance au plan)
//  4. fusion des régions coplanaires, affectation des pixels restants
//  5. vectorisation de chaque pan, simplification
//  6. régularisation topologique (sommets partagés, intersections de plans)

import {
  type XY,
  pointInPolygon,
  distToPolygonBoundary,
  simplifyRing,
  cleanRing,
  polygonArea,
  centroid,
  distPointSegment,
} from "../../shared/geo";
import { type DsmGrid, pixelToLocal, localToPixel } from "./grid";

export interface Plane {
  a: number; // dz/dx
  b: number; // dz/dy
  c: number; // z à l'origine locale
}

export interface SegFace {
  ring: XY[];
  plane: Plane;
  pitchDeg: number;
  azimuthDeg: number;
  rms: number;
  cells: number;
}

export interface SegmentOptions {
  overhang?: number; // débord de toit maximum autorisé (m)
  minEaveHeight?: number; // hauteur mini au-dessus du sol (m)
  minFaceArea?: number; // m²
  alignFootprint?: boolean;
  /** contour = emprise BD TOPO + débord mesuré (si concordance suffisante) */
  outlineFromFootprint?: boolean;
}

export interface DetectedChimney {
  center: XY;
  width: number;
  length: number;
}

export interface SegmentResult {
  faces: SegFace[];
  chimneys: DetectedChimney[];
  ground: number;
  shift: XY;
  diagnostics: {
    roofCells: number;
    assignedCells: number;
    meanRms: number;
    coverage: number;
    cell: number;
    outline?: string;
    overhangs?: number[];
    iou?: number;
  };
}

const R2D = 180 / Math.PI;

// ---------- moindres carrés incrémentaux ----------
class PlaneAcc {
  n = 0;
  sx = 0;
  sy = 0;
  sz = 0;
  sxx = 0;
  sxy = 0;
  syy = 0;
  sxz = 0;
  syz = 0;
  szz = 0;
  add(x: number, y: number, z: number) {
    this.n++;
    this.sx += x;
    this.sy += y;
    this.sz += z;
    this.sxx += x * x;
    this.sxy += x * y;
    this.syy += y * y;
    this.sxz += x * z;
    this.syz += y * z;
    this.szz += z * z;
  }
  merge(o: PlaneAcc) {
    this.n += o.n;
    this.sx += o.sx;
    this.sy += o.sy;
    this.sz += o.sz;
    this.sxx += o.sxx;
    this.sxy += o.sxy;
    this.syy += o.syy;
    this.sxz += o.sxz;
    this.syz += o.syz;
    this.szz += o.szz;
  }
  solve(): Plane | null {
    if (this.n < 3) return null;
    // centrage pour la stabilité numérique
    const n = this.n;
    const mx = this.sx / n;
    const my = this.sy / n;
    const mz = this.sz / n;
    const cxx = this.sxx / n - mx * mx;
    const cxy = this.sxy / n - mx * my;
    const cyy = this.syy / n - my * my;
    const cxz = this.sxz / n - mx * mz;
    const cyz = this.syz / n - my * mz;
    const det = cxx * cyy - cxy * cxy;
    if (Math.abs(det) < 1e-9) return null;
    const a = (cxz * cyy - cyz * cxy) / det;
    const b = (cyz * cxx - cxz * cxy) / det;
    return { a, b, c: mz - a * mx - b * my };
  }
}

export function planeAt(p: Plane, x: number, y: number) {
  return p.a * x + p.b * y + p.c;
}

export function planeAngles(p: Plane): { pitchDeg: number; azimuthDeg: number } {
  const g = Math.hypot(p.a, p.b);
  const pitchDeg = Math.atan(g) * R2D;
  // la descente va dans le sens (-a, -b) ; azimut compté depuis le Nord (y) vers l'Est (x)
  let az = g < 1e-6 ? 180 : Math.atan2(-p.a, -p.b) * R2D;
  if (az < 0) az += 360;
  return { pitchDeg, azimuthDeg: az };
}

function normalAngle(p: Plane, q: Plane): number {
  const n1 = [-p.a, -p.b, 1];
  const n2 = [-q.a, -q.b, 1];
  const d = n1[0] * n2[0] + n1[1] * n2[1] + 1;
  const l = Math.hypot(n1[0], n1[1], 1) * Math.hypot(n2[0], n2[1], 1);
  return Math.acos(Math.min(1, d / l)) * R2D;
}

function percentile(arr: number[], q: number): number {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

// ---------------------------------------------------------------------------

export function segmentRoof(
  grid: DsmGrid,
  targets: XY[][],
  neighbors: XY[][],
  opts: SegmentOptions = {},
): SegmentResult {
  const overhang = opts.overhang ?? 0.8;
  const minEave = opts.minEaveHeight ?? 2.0;
  const minFaceArea = opts.minFaceArea ?? 2.5;
  const { w, h, z } = grid;
  const N = w * h;
  const cellArea = grid.cell * grid.cell;
  const P: XY[] = new Array(N);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) P[j * w + i] = pixelToLocal(grid, i, j);

  // --- sol : bas percentile autour du bâtiment, hors bâti ---
  const inAnyFoot = (p: XY) => targets.some((t) => pointInPolygon(p, t)) || neighbors.some((t) => pointInPolygon(p, t));
  const ring: number[] = [];
  for (let k = 0; k < N; k++) {
    if (!Number.isFinite(z[k])) continue;
    const p = P[k];
    if (inAnyFoot(p)) continue;
    const d = Math.min(...targets.map((t) => distToPolygonBoundary(p, t)));
    if (d > 1.5 && d < 12) ring.push(z[k]);
  }
  const allZ: number[] = [];
  for (let k = 0; k < N; k++) if (Number.isFinite(z[k])) allZ.push(z[k]);
  const ground = ring.length > 20 ? percentile(ring, 0.1) : percentile(allZ, 0.05);
  const elevated = (k: number) => Number.isFinite(z[k]) && z[k] > ground + minEave;

  // --- recalage de l'emprise (décalage systématique des bases cadastrales) ---
  let shift: XY = [0, 0];
  if (opts.alignFootprint !== false) {
    let best = -Infinity;
    const step = grid.cell / 2;
    const R = 2.0;
    for (let dx = -R; dx <= R + 1e-9; dx += step) {
      for (let dy = -R; dy <= R + 1e-9; dy += step) {
        let s = 0;
        for (let k = 0; k < N; k++) {
          const p: XY = [P[k][0] - dx, P[k][1] - dy];
          if (targets.some((t) => pointInPolygon(p, t))) s += elevated(k) ? 1 : -2;
        }
        // à score égal, on préfère le plus petit décalage
        s -= 0.01 * Math.hypot(dx, dy);
        if (s > best) {
          best = s;
          shift = [dx, dy];
        }
      }
    }
  }
  const sh = (poly: XY[]) => poly.map((p) => [p[0] + shift[0], p[1] + shift[1]] as XY);
  const T = targets.map(sh);
  const Nb = neighbors.map(sh);

  // --- masque toiture ---
  const allowed = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const p = P[k];
    const inT = T.some((t) => pointInPolygon(p, t));
    const nearT = inT || T.some((t) => distToPolygonBoundary(p, t) <= overhang);
    if (!nearT) continue;
    if (!inT && Nb.some((t) => pointInPolygon(p, t))) continue;
    allowed[k] = 1;
  }
  const roof = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (allowed[k] && elevated(k)) roof[k] = 1;
  // on ne garde que les composantes connexes qui touchent l'emprise
  {
    const comp = new Int32Array(N).fill(-1);
    let c = 0;
    for (let k = 0; k < N; k++) {
      if (!roof[k] || comp[k] >= 0) continue;
      const stack = [k];
      comp[k] = c;
      const members: number[] = [];
      let touches = false;
      while (stack.length) {
        const q = stack.pop()!;
        members.push(q);
        if (!touches && T.some((t) => pointInPolygon(P[q], t))) touches = true;
        const qi = q % w;
        const qj = (q - qi) / w;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = qi + di;
          const nj = qj + dj;
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          const nk = nj * w + ni;
          if (roof[nk] && comp[nk] < 0) {
            comp[nk] = c;
            stack.push(nk);
          }
        }
      }
      if (!touches || members.length * cellArea < 2) for (const q of members) roof[q] = 0;
      c++;
    }
  }
  let roofCells = 0;
  for (let k = 0; k < N; k++) roofCells += roof[k];
  if (roofCells < 8) {
    return {
      faces: [],
      chimneys: [],
      ground,
      shift,
      diagnostics: { roofCells, assignedCells: 0, meanRms: 0, coverage: 0, cell: grid.cell },
    };
  }

  const nb4 = (k: number): number[] => {
    const i = k % w;
    const j = (k - i) / w;
    const r: number[] = [];
    if (i > 0) r.push(k - 1);
    if (i < w - 1) r.push(k + 1);
    if (j > 0) r.push(k - w);
    if (j < h - 1) r.push(k + w);
    return r;
  };
  const nb8 = (k: number): number[] => {
    const i = k % w;
    const j = (k - i) / w;
    const r: number[] = [];
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni >= 0 && nj >= 0 && ni < w && nj < h) r.push(nj * w + ni);
      }
    return r;
  };

  // --- plans locaux (fenêtre 3x3) ---
  const localPlane: (Plane | null)[] = new Array(N).fill(null);
  const localRms = new Float32Array(N).fill(Infinity);
  for (let k = 0; k < N; k++) {
    if (!roof[k]) continue;
    const acc = new PlaneAcc();
    const pts = [k, ...nb8(k)].filter((q) => roof[q]);
    if (pts.length < 6) continue;
    for (const q of pts) acc.add(P[q][0], P[q][1], z[q]);
    const pl = acc.solve();
    if (!pl) continue;
    let ss = 0;
    for (const q of pts) {
      const r = z[q] - planeAt(pl, P[q][0], P[q][1]);
      ss += r * r;
    }
    localPlane[k] = pl;
    localRms[k] = Math.sqrt(ss / pts.length);
  }
  const rmsList: number[] = [];
  for (let k = 0; k < N; k++) if (Number.isFinite(localRms[k])) rmsList.push(localRms[k]);
  const noise = Math.max(0.03, percentile(rmsList, 0.3));
  const seedTol = Math.max(0.05, noise * 1.5);
  const distTol = Math.max(0.12, noise * 3);

  // --- croissance de régions ---
  const label = new Int32Array(N).fill(-1);
  const regions: { acc: PlaneAcc; plane: Plane; cells: number[] }[] = [];
  const seeds = [];
  for (let k = 0; k < N; k++) if (roof[k] && localRms[k] < seedTol) seeds.push(k);
  seeds.sort((a, b) => localRms[a] - localRms[b]);
  const tried = new Uint8Array(N);
  for (const s of seeds) {
    if (label[s] >= 0 || tried[s]) continue;
    const id = regions.length;
    const acc = new PlaneAcc();
    let plane = localPlane[s]!;
    const cells: number[] = [];
    const queue = [s];
    label[s] = id;
    let head = 0;
    let sinceFit = 0;
    while (head < queue.length) {
      const q = queue[head++];
      cells.push(q);
      acc.add(P[q][0], P[q][1], z[q]);
      if (++sinceFit >= 15) {
        const np = acc.solve();
        if (np) plane = np;
        sinceFit = 0;
      }
      for (const nk of nb4(q)) {
        if (!roof[nk] || label[nk] >= 0) continue;
        const dz = Math.abs(z[nk] - planeAt(plane, P[nk][0], P[nk][1]));
        if (dz > distTol) continue;
        const lp = localPlane[nk];
        const okNormal = lp && localRms[nk] < seedTol * 2 ? normalAngle(lp, plane) < 12 : dz < distTol * 0.6;
        if (!okNormal) continue;
        label[nk] = id;
        queue.push(nk);
      }
    }
    if (cells.length * cellArea < Math.max(0.75, minFaceArea * 0.5)) {
      for (const q of cells) {
        label[q] = -1;
        tried[q] = 1;
      }
      continue;
    }
    regions.push({ acc, plane: acc.solve() ?? plane, cells });
  }
  // compactage des identifiants
  {
    const map = new Map<number, number>();
    const kept: typeof regions = [];
    regions.forEach((r, i) => {
      if (r.cells.length && r.cells.every((c) => label[c] === i)) {
        map.set(i, kept.length);
        kept.push(r);
      }
    });
    for (let k = 0; k < N; k++) if (label[k] >= 0) label[k] = map.get(label[k]) ?? -1;
    regions.length = 0;
    regions.push(...kept);
  }

  // --- fusion des régions adjacentes coplanaires ---
  const mergeCoplanar = () => {
    let merged = true;
    while (merged) {
      merged = false;
      const adj = new Map<string, number[]>();
      for (let k = 0; k < N; k++) {
        const a = label[k];
        if (a < 0) continue;
        for (const nk of nb4(k)) {
          const b = label[nk];
          if (b < 0 || b <= a) continue;
          const key = `${a},${b}`;
          let arr = adj.get(key);
          if (!arr) adj.set(key, (arr = []));
          arr.push(k);
        }
      }
      for (const [key, cells] of adj) {
        const [a, b] = key.split(",").map(Number);
        const ra = regions[a];
        const rb = regions[b];
        if (!ra.cells.length || !rb.cells.length) continue;
        if (normalAngle(ra.plane, rb.plane) > 5) continue;
        let dzs = 0;
        for (const k of cells) dzs += Math.abs(planeAt(ra.plane, P[k][0], P[k][1]) - planeAt(rb.plane, P[k][0], P[k][1]));
        if (dzs / cells.length > 0.15) continue;
        // fusion de b dans a
        for (const k of rb.cells) label[k] = a;
        ra.cells.push(...rb.cells);
        ra.acc.merge(rb.acc);
        ra.plane = ra.acc.solve() ?? ra.plane;
        rb.cells = [];
        merged = true;
        break;
      }
    }
  };
  mergeCoplanar();

  // --- affectation des pixels restants au plan voisin le plus proche ---
  const assignLeftovers = (maxDz: number) => {
    let changed = true;
    while (changed) {
      changed = false;
      const updates: [number, number][] = [];
      for (let k = 0; k < N; k++) {
        if (!roof[k] || label[k] >= 0) continue;
        let bestL = -1;
        let bestD = maxDz;
        for (const nk of nb8(k)) {
          const l = label[nk];
          if (l < 0) continue;
          const d = Math.abs(z[k] - planeAt(regions[l].plane, P[k][0], P[k][1]));
          if (d < bestD) {
            bestD = d;
            bestL = l;
          }
        }
        if (bestL >= 0) updates.push([k, bestL]);
      }
      for (const [k, l] of updates) {
        label[k] = l;
        changed = true;
      }
    }
  };
  assignLeftovers(0.5);
  // trous restants (cheminées, végétation) : vote majoritaire
  {
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 50) {
      changed = false;
      const updates: [number, number][] = [];
      for (let k = 0; k < N; k++) {
        if (!roof[k] || label[k] >= 0) continue;
        const cnt = new Map<number, number>();
        for (const nk of nb8(k)) if (label[nk] >= 0) cnt.set(label[nk], (cnt.get(label[nk]) ?? 0) + 1);
        let bl = -1;
        let bc = 0;
        for (const [l, c] of cnt)
          if (c > bc) {
            bc = c;
            bl = l;
          }
        if (bl >= 0) updates.push([k, bl]);
      }
      for (const [k, l] of updates) {
        label[k] = l;
        changed = true;
      }
    }
  }

  // --- lissage (filtre majoritaire) ---
  for (let pass = 0; pass < 2; pass++) {
    const upd: [number, number][] = [];
    for (let k = 0; k < N; k++) {
      if (label[k] < 0) continue;
      const cnt = new Map<number, number>();
      for (const nk of nb8(k)) if (label[nk] >= 0) cnt.set(label[nk], (cnt.get(label[nk]) ?? 0) + 1);
      for (const [l, c] of cnt) if (l !== label[k] && c >= 6) upd.push([k, l]);
    }
    for (const [k, l] of upd) label[k] = l;
  }

  // --- recalcul robuste des plans, suppression des petits pans ---
  const recompute = () => {
    for (const r of regions) r.cells = [];
    for (let k = 0; k < N; k++) if (label[k] >= 0) regions[label[k]].cells.push(k);
    for (const r of regions) {
      if (r.cells.length < 3) continue;
      let acc = new PlaneAcc();
      for (const k of r.cells) acc.add(P[k][0], P[k][1], z[k]);
      let pl = acc.solve() ?? r.plane;
      // 2e passe sans les points aberrants
      const res = r.cells.map((k) => Math.abs(z[k] - planeAt(pl, P[k][0], P[k][1])));
      const thr = Math.max(0.1, percentile(res, 0.8) * 1.5);
      acc = new PlaneAcc();
      r.cells.forEach((k, i) => {
        if (res[i] <= thr) acc.add(P[k][0], P[k][1], z[k]);
      });
      pl = acc.solve() ?? pl;
      r.plane = pl;
      r.acc = acc;
    }
  };
  recompute();
  for (let it = 0; it < 3; it++) {
    let removed = false;
    regions.forEach((r, id) => {
      if (!r.cells.length || r.cells.length * cellArea >= minFaceArea) return;
      // réaffectation au voisin qui colle le mieux
      for (const k of r.cells) label[k] = -1;
      r.cells = [];
      removed = true;
      void id;
    });
    if (!removed) break;
    assignLeftovers(5);
    recompute();
  }
  mergeCoplanar();
  recompute();

  // --- découpage en composantes connexes : 1 composante = 1 pan ---
  const faceLabel = new Int32Array(N).fill(-1);
  const facePlanes: Plane[] = [];
  regions.forEach((r) => {
    if (!r.cells.length) return;
    const inR = new Uint8Array(N);
    for (const k of r.cells) inR[k] = 1;
    // pans quasi verticaux (murs, arbres) : rejetés
    if (planeAngles(r.plane).pitchDeg > 60) return;
    for (const comp of components(inR, nb4)) {
      if (comp.length * cellArea < minFaceArea) continue;
      const id = facePlanes.length;
      facePlanes.push(r.plane);
      for (const k of comp) faceLabel[k] = id;
    }
  });
  // les petites composantes orphelines rejoignent un pan voisin
  {
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 20) {
      changed = false;
      const upd: [number, number][] = [];
      for (let k = 0; k < N; k++) {
        if (label[k] < 0 || faceLabel[k] >= 0) continue;
        let best = -1;
        let bd = Infinity;
        for (const nk of nb4(k)) {
          const f = faceLabel[nk];
          if (f < 0) continue;
          const d = Math.abs(z[k] - planeAt(facePlanes[f], P[k][0], P[k][1]));
          if (d < bd) {
            bd = d;
            best = f;
          }
        }
        if (best >= 0) upd.push([k, best]);
      }
      for (const [k, f] of upd) {
        faceLabel[k] = f;
        changed = true;
      }
    }
  }

  const theta = T.length && opts.alignFootprint !== false ? dominantAxis(T[0]) : null;

  // --- contour extérieur : emprise IGN + débord mesuré, si elle concorde avec le relevé ---
  let outlinePoly: XY[] | null = null;
  let overhangs: number[] = [];
  let iou = 0;
  if (T.length === 1 && opts.alignFootprint !== false && opts.outlineFromFootprint !== false) {
    const fp = polygonArea(T[0]) < 0 ? T[0].slice().reverse() : T[0].slice();
    const pix = (p: XY) => {
      const [fi, fj] = localToPixel(grid, p);
      const i = Math.round(fi);
      const j = Math.round(fj);
      return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
    };
    overhangs = fp.map((a, i) => {
      const b = fp[(i + 1) % fp.length];
      const Lr = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (Lr < 0.3) return 0;
      const dir: XY = [(b[0] - a[0]) / Lr, (b[1] - a[1]) / Lr];
      const nOut: XY = [dir[1], -dir[0]];
      // côté mitoyen : un bâtiment voisin touche ce côté
      const mid: XY = [(a[0] + b[0]) / 2 + nOut[0] * 0.6, (a[1] + b[1]) / 2 + nOut[1] * 0.6];
      if (Nb.some((nb) => pointInPolygon(mid, nb))) return 0;
      const samples: number[] = [];
      for (let t = 0.15; t <= 0.85; t += Math.max(0.05, 0.5 / Lr)) {
        const p: XY = [a[0] + dir[0] * Lr * t, a[1] + dir[1] * Lr * t];
        const kin = pix([p[0] - nOut[0] * 0.5, p[1] - nOut[1] * 0.5]);
        if (kin < 0 || faceLabel[kin] < 0) continue;
        const pl = facePlanes[faceLabel[kin]];
        let ok = 0;
        for (let off = 0.1; off <= 1.21; off += 0.1) {
          const q: XY = [p[0] + nOut[0] * off, p[1] + nOut[1] * off];
          const kq = pix(q);
          if (kq < 0 || !Number.isFinite(z[kq])) break;
          const zq = z[kq];
          if (zq > ground + minEave && Math.abs(zq - planeAt(pl, q[0], q[1])) < 0.3) ok = off;
          else break;
        }
        samples.push(ok);
      }
      if (!samples.length) return 0;
      // échantillonnage au plus proche pixel : estimation sans biais du bord
      return Math.max(0, Math.min(1.0, percentile(samples, 0.5)));
    });
    outlinePoly = offsetPolygon(fp, overhangs);
    let inter = 0;
    let uni = 0;
    for (let k = 0; k < N; k++) {
      const inO = pointInPolygon(P[k], outlinePoly);
      const isRoof = faceLabel[k] >= 0;
      if (inO && isRoof) inter++;
      if (inO || isRoof) uni++;
    }
    iou = uni ? inter / uni : 0;
    if (iou < 0.8) outlinePoly = null;
    else {
      // tous les pixels de l'emprise reçoivent un pan, ceux hors emprise sont exclus
      for (let k = 0; k < N; k++) if (!pointInPolygon(P[k], outlinePoly)) faceLabel[k] = -1;
      let changed = true;
      let guard = 0;
      while (changed && guard++ < 60) {
        changed = false;
        const upd: [number, number][] = [];
        for (let k = 0; k < N; k++) {
          if (faceLabel[k] >= 0 || !pointInPolygon(P[k], outlinePoly)) continue;
          const cnt = new Map<number, number>();
          for (const nk of nb8(k)) if (faceLabel[nk] >= 0) cnt.set(faceLabel[nk], (cnt.get(faceLabel[nk]) ?? 0) + 1);
          let bl = -1;
          let bc = 0;
          for (const [l, c] of cnt)
            if (c > bc) {
              bc = c;
              bl = l;
            }
          if (bl >= 0) upd.push([k, bl]);
        }
        for (const [k, l] of upd) {
          faceLabel[k] = l;
          changed = true;
        }
      }
    }
  }

  // --- cheminées : petits volumes nettement au-dessus du plan du pan ---
  const chimneys: DetectedChimney[] = [];
  {
    const above = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
      const f = faceLabel[k];
      if (f < 0 || !Number.isFinite(z[k])) continue;
      const r = z[k] - planeAt(facePlanes[f], P[k][0], P[k][1]);
      if (r > 0.7 && r < 4) above[k] = 1;
    }
    const seen = new Uint8Array(N);
    const minCells = Math.max(2, Math.round(0.2 / cellArea));
    for (let k = 0; k < N; k++) {
      if (!above[k] || seen[k]) continue;
      const comp: number[] = [];
      const st = [k];
      seen[k] = 1;
      while (st.length) {
        const q = st.pop()!;
        comp.push(q);
        for (const nk of nb8(q))
          if (above[nk] && !seen[nk]) {
            seen[nk] = 1;
            st.push(nk);
          }
      }
      const area = comp.length * cellArea;
      if (comp.length < minCells || area > 3.5) continue;
      // orientation du pan majoritaire
      const cnt = new Map<number, number>();
      for (const q of comp) cnt.set(faceLabel[q], (cnt.get(faceLabel[q]) ?? 0) + 1);
      const f = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
      // une souche est entourée par son pan : on écarte ce qui touche une arête, un décroché ou le bord du toit
      const inComp = new Set(comp);
      let around = 0;
      let same = 0;
      for (const q of comp)
        for (const nk of nb8(q)) {
          if (inComp.has(nk)) continue;
          around++;
          if (faceLabel[nk] === f) same++;
          // deux pixels plus loin, toujours sur le même pan
          const GW = grid.w;
          const qi = q % GW;
          const ni = nk % GW;
          const nj = (nk - ni) / GW;
          const qj = (q - qi) / GW;
          const fi = ni + (ni - qi);
          const fj = nj + (nj - qj);
          if (fi < 0 || fj < 0 || fi >= GW || fj >= grid.h || faceLabel[fj * GW + fi] !== f) same -= 0.5;
        }
      if (!around || same / around < 0.9) continue;
      const { pitchDeg, azimuthDeg } = planeAngles(facePlanes[f]);
      const dn: XY = [Math.sin((azimuthDeg * Math.PI) / 180), Math.cos((azimuthDeg * Math.PI) / 180)];
      const ac: XY = [-dn[1], dn[0]];
      let cx = 0;
      let cy = 0;
      for (const q of comp) {
        cx += P[q][0] / comp.length;
        cy += P[q][1] / comp.length;
      }
      let a0 = Infinity, a1 = -Infinity, d0 = Infinity, d1 = -Infinity;
      for (const q of comp) {
        const dx = P[q][0] - cx;
        const dy = P[q][1] - cy;
        const a = dx * ac[0] + dy * ac[1];
        const d = dx * dn[0] + dy * dn[1];
        a0 = Math.min(a0, a); a1 = Math.max(a1, a); d0 = Math.min(d0, d); d1 = Math.max(d1, d);
      }
      const w = a1 - a0 + grid.cell * 0.5;
      const lPlan = d1 - d0 + grid.cell * 0.5;
      if (w > 2.2 || lPlan > 2.2) continue; // trop grand : arbre, lucarne, édicule
      if (area / (w * lPlan) < 0.45) continue; // forme peu compacte : végétation
      const ccx = cx + ac[0] * (a0 + a1) / 2 + dn[0] * (d0 + d1) / 2;
      const ccy = cy + ac[1] * (a0 + a1) / 2 + dn[1] * (d0 + d1) / 2;
      chimneys.push({
        center: [ccx, ccy],
        width: Math.max(0.4, Math.round(w * 20) / 20),
        length: Math.max(0.4, Math.round((lPlan / Math.cos((pitchDeg * Math.PI) / 180)) * 20) / 20),
      });
    }
  }

  const faces = vectorize(grid, faceLabel, facePlanes, P, z, theta, outlinePoly);

  let assigned = 0;
  let rmsSum = 0;
  for (const f of faces) {
    assigned += f.cells;
    rmsSum += f.rms * f.cells;
  }
  return {
    faces,
    chimneys,
    ground,
    shift,
    diagnostics: {
      roofCells,
      assignedCells: assigned,
      meanRms: assigned ? rmsSum / assigned : 0,
      coverage: roofCells ? assigned / roofCells : 0,
      cell: grid.cell,
      outline: outlinePoly ? "emprise IGN + débord mesuré" : "relevé 3D",
      overhangs: overhangs.map((o) => Math.round(o * 100) / 100),
      iou: Math.round(iou * 100) / 100,
    },
  };
}

function components(mask: Uint8Array, nb4: (k: number) => number[]): number[][] {
  const seen = new Uint8Array(mask.length);
  const out: number[][] = [];
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k] || seen[k]) continue;
    const comp: number[] = [];
    const st = [k];
    seen[k] = 1;
    while (st.length) {
      const q = st.pop()!;
      comp.push(q);
      for (const n of nb4(q))
        if (mask[n] && !seen[n]) {
          seen[n] = 1;
          st.push(n);
        }
    }
    out.push(comp);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vectorisation topologique : les frontières entre pans sont des « chaînes »
// partagées, simplifiées une seule fois, puis recalées sur les intersections
// des plans. Deux pans voisins ont donc exactement la même arête.

interface Chain {
  pts: XY[]; // y compris extrémités
  startNode: string;
  endNode: string;
  a: number; // label d'un côté (-1 = extérieur)
  b: number;
}

function vectorize(
  grid: DsmGrid,
  label: Int32Array,
  planes: Plane[],
  P: XY[],
  z: Float32Array,
  thetaIn: number | null,
  outlinePoly: XY[] | null = null,
): SegFace[] {
  const { w, h } = grid;
  const L = (i: number, j: number) => (i < 0 || j < 0 || i >= w || j >= h ? -1 : label[j * w + i]);
  const corner = (i: number, j: number): XY => pixelToLocal(grid, i - 0.5, j - 0.5);
  const ck = (i: number, j: number) => `${i},${j}`;

  // arêtes de pixels frontières, indexées par coin
  type E = { id: string; c1: [number, number]; c2: [number, number]; a: number; b: number };
  const incident = new Map<string, E[]>();
  const addE = (e: E) => {
    for (const c of [e.c1, e.c2]) {
      const k = ck(c[0], c[1]);
      let arr = incident.get(k);
      if (!arr) incident.set(k, (arr = []));
      arr.push(e);
    }
  };
  for (let j = 0; j <= h; j++)
    for (let i = 0; i < w; i++) {
      const up = L(i, j - 1);
      const dn = L(i, j);
      if (up !== dn) addE({ id: `h${i},${j}`, c1: [i, j], c2: [i + 1, j], a: up, b: dn });
    }
  for (let j = 0; j < h; j++)
    for (let i = 0; i <= w; i++) {
      const lf = L(i - 1, j);
      const rt = L(i, j);
      if (lf !== rt) addE({ id: `v${i},${j}`, c1: [i, j], c2: [i, j + 1], a: lf, b: rt });
    }

  const isJunction = (k: string) => (incident.get(k)?.length ?? 0) !== 2;
  const used = new Set<string>();
  const chains: Chain[] = [];
  const nodePos = new Map<string, XY>();
  const nodeCorner = new Map<string, [number, number]>();

  const walk = (startKey: string, startC: [number, number], first: E) => {
    const pts: [number, number][] = [startC];
    let e = first;
    let cur = startC;
    for (;;) {
      used.add(e.id);
      const nxt = e.c1[0] === cur[0] && e.c1[1] === cur[1] ? e.c2 : e.c1;
      pts.push(nxt);
      cur = nxt;
      const k = ck(cur[0], cur[1]);
      if (isJunction(k) || k === startKey) break;
      const cand = incident.get(k)!.find((x) => !used.has(x.id));
      if (!cand) break;
      e = cand;
    }
    const endKey = ck(cur[0], cur[1]);
    for (const [kk, c] of [
      [startKey, startC],
      [endKey, cur],
    ] as const) {
      if (!nodePos.has(kk)) {
        nodePos.set(kk, corner(c[0], c[1]));
        nodeCorner.set(kk, [c[0], c[1]]);
      }
    }
    chains.push({
      pts: pts.map((c) => corner(c[0], c[1])),
      startNode: startKey,
      endNode: endKey,
      a: first.a,
      b: first.b,
    });
  };

  for (const [k, es] of incident) {
    if (!isJunction(k)) continue;
    const c = k.split(",").map(Number) as [number, number];
    for (const e of es) if (!used.has(e.id)) walk(k, c, e);
  }
  // boucles fermées sans jonction
  for (const [k, es] of incident) {
    for (const e of es) {
      if (used.has(e.id)) continue;
      const c = k.split(",").map(Number) as [number, number];
      walk(k, c, e);
    }
  }

  // --- simplification + recalage sur les intersections de plans ---
  const facesAtNode = (k: string): number[] => {
    const [i, j] = nodeCorner.get(k)!;
    const s = new Set<number>();
    for (const [di, dj] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const l = L(i + di, j + dj);
      if (l >= 0) s.add(l);
    }
    return [...s];
  };
  const touchesOut = (k: string) =>
    chains.some((c) => (c.startNode === k || c.endNode === k) && (c.a < 0 || c.b < 0));
  for (const [k, p] of nodePos) {
    const fs = facesAtNode(k);
    let np: XY | null = null;
    if (outlinePoly && touchesOut(k)) {
      if (fs.length === 2) np = lineMeetsPolygon(p, planes[fs[0]], planes[fs[1]], outlinePoly);
      if (!np) np = nearestOnPolygon(p, outlinePoly).q;
      nodePos.set(k, np);
      continue;
    }
    if (fs.length >= 3) {
      np = intersect3(fs.map((f) => planes[f]));
      if (np && Math.hypot(np[0] - p[0], np[1] - p[1]) > 1.0) np = null;
    } else if (fs.length === 2) {
      const touchesOutside = chains.some((c) => (c.startNode === k || c.endNode === k) && (c.a < 0 || c.b < 0));
      if (touchesOutside) {
        // point où l'arête (faîtage / arêtier / noue) rencontre le contour brut
        np = lineMeetsOutline(p, planes[fs[0]], planes[fs[1]], chains, k);
      }
      if (!np) {
        np = projectOnPlaneIntersection(p, planes[fs[0]], planes[fs[1]]);
        if (np && Math.hypot(np[0] - p[0], np[1] - p[1]) > 0.8) np = null;
      }
    }
    if (np) nodePos.set(k, np);
  }

  for (const c of chains) {
    const raw = c.pts.slice();
    c.pts[0] = nodePos.get(c.startNode)!;
    c.pts[c.pts.length - 1] = nodePos.get(c.endNode)!;
    const interior = c.a >= 0 && c.b >= 0;
    if (!interior && outlinePoly) {
      c.pts = polygonPath(outlinePoly, c.pts[0], c.pts[c.pts.length - 1], raw, c.startNode === c.endNode);
      (c as any).onPoly = true;
      continue;
    }
    let step = false;
    if (interior) {
      const mid = c.pts[Math.floor(c.pts.length / 2)];
      step = Math.abs(planeAt(planes[c.a], mid[0], mid[1]) - planeAt(planes[c.b], mid[0], mid[1])) > 0.5;
    }
    const closed = c.startNode === c.endNode;
    if (interior && !step && !closed) {
      // intersection de deux plans = segment de droite
      c.pts = [c.pts[0], c.pts[c.pts.length - 1]];
    } else {
      c.pts = dpOpen(c.pts, Math.max(0.35, grid.cell * 0.9), closed);
    }
  }
  // redressement des contours selon les axes du bâtiment
  const outline = chains.filter((c) => !(c as any).onPoly && (c.a < 0 || c.b < 0 || c.pts.length > 2));
  const theta = thetaIn ?? dominantAxis(outline.flatMap((c) => c.pts));
  for (const c of outline) {
    if (c.startNode === c.endNode) continue;
    c.pts = squareChain(c.pts, theta);
  }

  // --- assemblage des polygones de chaque pan ---
  const faces: SegFace[] = [];
  planes.forEach((pl, f) => {
    const mine = chains.filter((c) => c.a === f || c.b === f);
    if (!mine.length) return;
    const loops: XY[][] = [];
    const usedC = new Set<Chain>();
    for (const c0 of mine) {
      if (usedC.has(c0)) continue;
      usedC.add(c0);
      const ring: XY[] = c0.pts.slice(0, -1);
      const startNode = c0.startNode;
      let endNode = c0.endNode;
      let guard = 0;
      while (endNode !== startNode && guard++ < 10000) {
        const nx = mine.find((c) => !usedC.has(c) && (c.startNode === endNode || c.endNode === endNode));
        if (!nx) break;
        usedC.add(nx);
        const pts = nx.startNode === endNode ? nx.pts : nx.pts.slice().reverse();
        ring.push(...pts.slice(0, -1));
        endNode = nx.startNode === endNode ? nx.endNode : nx.startNode;
      }
      if (c0.startNode === c0.endNode && ring.length && c0.pts.length) {
        // boucle fermée : pts contient déjà tout l'anneau
      }
      if (ring.length >= 3) loops.push(ring);
    }
    if (!loops.length) return;
    loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
    let ring = loops[0].filter((p, i, arr) => {
      const q = arr[(i + 1) % arr.length];
      return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
    });
    if (ring.length < 3 || Math.abs(polygonArea(ring)) < 0.5) return;
    if (polygonArea(ring) < 0) ring = ring.reverse();
    let cells = 0;
    let ss = 0;
    for (let k = 0; k < label.length; k++) {
      if (label[k] !== f) continue;
      cells++;
      const d = z[k] - planeAt(pl, P[k][0], P[k][1]);
      ss += d * d;
    }
    faces.push({ ring, plane: pl, ...planeAngles(pl), rms: Math.sqrt(ss / Math.max(1, cells)), cells });
  });
  return faces;
}

function dpOpen(pts: XY[], tol: number, closed: boolean): XY[] {
  if (closed) {
    const ring = simplifyRing(pts.slice(0, -1), tol);
    return [...ring, ring[0]];
  }
  if (pts.length < 3) return pts;
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
  const l = dpOpen(pts.slice(0, idx + 1), tol, false);
  const r = dpOpen(pts.slice(idx), tol, false);
  return [...l.slice(0, -1), ...r];
}

function intersect3(planes: Plane[]): XY | null {
  // minimise Σ (a x + b y + c - z)² : système 3x3 en (x, y, z)
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const v = [0, 0, 0];
  for (const p of planes) {
    const row = [p.a, p.b, -1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) m[i][j] += row[i] * row[j];
      v[i] += -row[i] * p.c;
    }
  }
  const det3 = (q: number[][]) =>
    q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) -
    q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) +
    q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const det = det3(m);
  if (Math.abs(det) < 1e-4) return null;
  const solve = (col: number) => {
    const mm = m.map((r) => r.slice());
    for (let i = 0; i < 3; i++) mm[i][col] = v[i];
    return det3(mm) / det;
  };
  return [solve(0), solve(1)];
}

/**
 * Intersection de la droite commune à deux plans avec le contour extérieur
 * (chaînes « bord » partant du nœud), au plus près du nœud.
 */
function lineMeetsOutline(p: XY, A: Plane, B: Plane, chains: Chain[], node: string): XY | null {
  const u = A.a - B.a;
  const v = A.b - B.b;
  const c = A.c - B.c;
  const n = Math.hypot(u, v);
  if (n < 0.08) return null;
  // droite : u x + v y + c = 0 ; distance signée f(q)
  const f = (q: XY) => (u * q[0] + v * q[1] + c) / n;
  let best: XY | null = null;
  let bd = 1.5;
  for (const ch of chains) {
    if (!(ch.a < 0 || ch.b < 0)) continue;
    if (ch.startNode !== node && ch.endNode !== node) continue;
    const pts = ch.startNode === node ? ch.pts : ch.pts.slice().reverse();
    for (let i = 0; i < pts.length - 1; i++) {
      const q1 = pts[i];
      const q2 = pts[i + 1];
      if (Math.hypot(q1[0] - p[0], q1[1] - p[1]) > 3) break;
      const f1 = f(q1);
      const f2 = f(q2);
      if ((f1 > 0 && f2 > 0) || (f1 < 0 && f2 < 0)) continue;
      const t = f1 === f2 ? 0 : f1 / (f1 - f2);
      const x: XY = [q1[0] + t * (q2[0] - q1[0]), q1[1] + t * (q2[1] - q1[1])];
      const d = Math.hypot(x[0] - p[0], x[1] - p[1]);
      if (d < bd) {
        bd = d;
        best = x;
      }
    }
  }
  return best;
}

function nearestOnPolygon(p: XY, poly: XY[]): { q: XY; e: number; t: number; d: number } {
  let best = { q: poly[0], e: 0, t: 0, d: Infinity };
  for (let i = 0; i < poly.length; i++) {
    const r = distPointSegment(p, poly[i], poly[(i + 1) % poly.length]);
    if (r.d < best.d) best = { q: r.q, e: i, t: r.t, d: r.d };
  }
  return best;
}

/** intersection de la droite commune à deux plans avec le contour, au plus près de p */
function lineMeetsPolygon(p: XY, A: Plane, B: Plane, poly: XY[]): XY | null {
  const u = A.a - B.a;
  const v = A.b - B.b;
  const c = A.c - B.c;
  const n = Math.hypot(u, v);
  if (n < 0.08) return null;
  const f = (q: XY) => (u * q[0] + v * q[1] + c) / n;
  let best: XY | null = null;
  let bd = 2.0;
  for (let i = 0; i < poly.length; i++) {
    const q1 = poly[i];
    const q2 = poly[(i + 1) % poly.length];
    const f1 = f(q1);
    const f2 = f(q2);
    if ((f1 > 0 && f2 > 0) || (f1 < 0 && f2 < 0)) continue;
    const t = f1 === f2 ? 0 : f1 / (f1 - f2);
    const x: XY = [q1[0] + t * (q2[0] - q1[0]), q1[1] + t * (q2[1] - q1[1])];
    const d = Math.hypot(x[0] - p[0], x[1] - p[1]);
    if (d < bd) {
      bd = d;
      best = x;
    }
  }
  return best;
}

/** chemin le long du polygon entre deux points de son contour (sens choisi d'après la chaîne brute) */
function polygonPath(poly: XY[], A: XY, B: XY, raw: XY[], closed: boolean): XY[] {
  const na = nearestOnPolygon(A, poly);
  const n = poly.length;
  if (closed) {
    // boucle fermée : contour complet seulement si la chaîne brute fait le tour
    if (Math.abs(polygonArea(raw)) < 0.5 * Math.abs(polygonArea(poly))) {
      return dpOpen(raw, 0.35, true);
    }
    const out: XY[] = [na.q];
    for (let k = 1; k <= n; k++) out.push(poly[(na.e + k) % n]);
    out.push(na.q);
    return out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1e-6);
  }
  const nb = nearestOnPolygon(B, poly);
  const fwd: XY[] = [na.q];
  if (!(na.e === nb.e && nb.t >= na.t)) {
    let e = na.e;
    for (let guard = 0; guard < n; guard++) {
      e = (e + 1) % n;
      fwd.push(poly[e]);
      if (e === nb.e) break;
    }
  }
  fwd.push(nb.q);
  const bwd: XY[] = [na.q];
  if (!(na.e === nb.e && nb.t <= na.t)) {
    let e = na.e;
    for (let guard = 0; guard < n; guard++) {
      bwd.push(poly[e]);
      e = (e - 1 + n) % n;
      if ((e + 1) % n === (nb.e + 1) % n) break;
    }
  }
  bwd.push(nb.q);
  // point au milieu (en abscisse curviligne) de la chaîne brute
  const plen = (path: XY[]) => {
    let l = 0;
    for (let i = 0; i + 1 < path.length; i++) l += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    return l;
  };
  const rawLen = plen(raw);
  let mid: XY = raw[0];
  {
    let acc = 0;
    for (let i = 0; i + 1 < raw.length; i++) {
      const l = Math.hypot(raw[i + 1][0] - raw[i][0], raw[i + 1][1] - raw[i][1]);
      if (acc + l >= rawLen / 2) {
        const t = l > 0 ? (rawLen / 2 - acc) / l : 0;
        mid = [raw[i][0] + t * (raw[i + 1][0] - raw[i][0]), raw[i][1] + t * (raw[i + 1][1] - raw[i][1])];
        break;
      }
      acc += l;
    }
  }
  const score = (path: XY[]) => {
    let d = Infinity;
    for (let i = 0; i + 1 < path.length; i++) d = Math.min(d, distPointSegment(mid, path[i], path[i + 1]).d);
    return 2 * d + Math.abs(plen(path) - rawLen);
  };
  const best = score(fwd) <= score(bwd) ? fwd : bwd;
  return best.filter((p, i) => i === 0 || Math.hypot(p[0] - best[i - 1][0], p[1] - best[i - 1][1]) > 1e-6);
}

/**
 * Emprise décalée vers l'extérieur d'un débord propre à chaque côté.
 * Les côtés mitoyens (bâtiment voisin collé) n'ont pas de débord.
 */
export function offsetPolygon(poly: XY[], d: number[]): XY[] {
  // poly doit être en sens anti-horaire ; d[i] = débord du côté (poly[i], poly[i+1])
  const ring = poly;
  const dd = d;
  const n = ring.length;
  const lines = ring.map((a, i) => {
    const b = ring[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const dir: XY = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const nOut: XY = [dir[1], -dir[0]]; // anneau CCW : extérieur à droite
    return { p: [a[0] + nOut[0] * dd[i], a[1] + nOut[1] * dd[i]] as XY, d: dir, nOut };
  });
  return ring.map((v, i) => {
    const A = lines[(i - 1 + n) % n];
    const B = lines[i];
    const x = lineX(A.p, A.d, B.p, B.d);
    if (x && Math.hypot(x[0] - v[0], x[1] - v[1]) < 3) return x;
    return [v[0] + B.nOut[0] * dd[i], v[1] + B.nOut[1] * dd[i]] as XY;
  });
}

/** Orientation dominante (modulo 90°) d'une polyligne/polygone, en radians. */
export function dominantAxis(pts: XY[]): number {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    sx += L * Math.cos(4 * ang);
    sy += L * Math.sin(4 * ang);
  }
  return Math.atan2(sy, sx) / 4;
}

function lineX(p1: XY, d1: XY, p2: XY, d2: XY): XY | null {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 0.17) return null; // < ~10°
  const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
  return [p1[0] + t * d1[0], p1[1] + t * d1[1]];
}

/**
 * Redresse une chaîne de contour : les segments proches des axes du bâtiment
 * (±12°) sont rendus parallèles/perpendiculaires, les petits décrochés
 * parasites (< 0,7 m) sont supprimés. Les extrémités (nœuds) restent fixes.
 */
export function squareChain(pts: XY[], theta: number): XY[] {
  if (pts.length < 3) return pts;
  const axes: XY[] = [0, 1, 2, 3].map((k) => [Math.cos(theta + (k * Math.PI) / 2), Math.sin(theta + (k * Math.PI) / 2)]);
  type Ln = { p: XY; d: XY; axis: number; len: number; fixed: boolean };
  const n = pts.length - 1;
  let lines: Ln[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const d: XY = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    let axis = -1;
    let dd = d;
    for (let k = 0; k < 4; k++) {
      if (d[0] * axes[k][0] + d[1] * axes[k][1] > Math.cos((12 * Math.PI) / 180)) {
        axis = k % 2;
        dd = axes[k];
      }
    }
    const fixed = i === 0 || i === n - 1;
    const anchor: XY = i === 0 ? a : i === n - 1 ? b : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    lines.push({ p: anchor, d: dd, axis, len: L, fixed });
  }
  const off = (A: Ln, B: Ln) => Math.abs((B.p[0] - A.p[0]) * -A.d[1] + (B.p[1] - A.p[1]) * A.d[0]);
  // suppression des petits décrochés entre deux segments parallèles
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i + 1 < lines.length; i++) {
      const A = lines[i];
      const B = lines[i + 1];
      if (A.axis >= 0 && A.axis === B.axis && off(A, B) < 0.35) {
        lines.splice(i, 2, merge(A, B));
        changed = true;
        break;
      }
      const C = lines[i + 2];
      if (C && B.len < 0.7 && A.axis >= 0 && A.axis === C.axis && off(A, C) < 0.7 && !B.fixed) {
        lines.splice(i, 3, merge(A, C));
        changed = true;
        break;
      }
    }
  }
  function merge(A: Ln, B: Ln): Ln {
    if (A.fixed && !B.fixed) return { ...A, len: A.len + B.len };
    if (B.fixed && !A.fixed) return { ...B, len: A.len + B.len };
    const wA = A.len / (A.len + B.len);
    return {
      p: [A.p[0] * wA + B.p[0] * (1 - wA), A.p[1] * wA + B.p[1] * (1 - wA)],
      d: A.d,
      axis: A.axis,
      len: A.len + B.len,
      fixed: A.fixed || B.fixed,
    };
  }
  if (lines.length < 2) return [pts[0], pts[pts.length - 1]];
  const out: XY[] = [pts[0]];
  for (let i = 0; i + 1 < lines.length; i++) {
    const x = lineX(lines[i].p, lines[i].d, lines[i + 1].p, lines[i + 1].d);
    const ref = out[out.length - 1];
    if (x && Math.hypot(x[0] - ref[0], x[1] - ref[1]) < 60) out.push(x);
    else {
      // segments parallèles : on relie par les projections
      const q = lines[i + 1].p;
      const A = lines[i];
      const t = (q[0] - A.p[0]) * A.d[0] + (q[1] - A.p[1]) * A.d[1];
      out.push([A.p[0] + t * A.d[0], A.p[1] + t * A.d[1]]);
    }
  }
  out.push(pts[pts.length - 1]);
  // garde-fou : si le redressement déforme trop, on garde l'original
  for (let i = 1; i < out.length - 1; i++) {
    let dmin = Infinity;
    for (let k = 0; k < pts.length - 1; k++) dmin = Math.min(dmin, distPointSegment(out[i], pts[k], pts[k + 1]).d);
    if (dmin > 1.2) return pts;
  }
  return out;
}

/** projection d'un point sur la droite (en plan) intersection de deux plans */
function projectOnPlaneIntersection(p: XY, A: Plane, B: Plane): XY | null {
  const u = A.a - B.a;
  const v = A.b - B.b;
  const c = A.c - B.c;
  const n = Math.hypot(u, v);
  if (n < 0.08) return null; // plans quasi parallèles
  const d = (u * p[0] + v * p[1] + c) / n;
  return [p[0] - (d * u) / n, p[1] - (d * v) / n];
}

export { localToPixel, cleanRing, centroid };
