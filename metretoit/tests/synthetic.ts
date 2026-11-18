// Génération de MNS synthétiques pour valider l'extraction automatique.
import type { XY } from "../shared/geo";
import { makeFrame, toLonLat, centroid, pointInPolygon } from "../shared/geo";
import type { DsmGrid } from "../server/analysis/grid";
import { segmentRoof, planeAt, type SegFace } from "../server/analysis/segment";
import { type RoofModel, computeMetrics } from "../shared/roof";

export function makeGrid(
  zf: (x: number, y: number) => number | null,
  ext: [number, number, number, number],
  cell = 0.5,
  ground = 10,
  noise = 0.03,
  seed = 1,
): DsmGrid {
  const [x0, y0, x1, y1] = ext;
  const w = Math.round((x1 - x0) / cell);
  const h = Math.round((y1 - y0) / cell);
  const z = new Float32Array(w * h);
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const x = x0 + (i + 0.5) * cell;
      const y = y1 - (j + 0.5) * cell;
      const v = zf(x, y);
      z[j * w + i] = (v ?? ground) + rnd() * 2 * noise;
    }
  return { w, h, z, affine: [x0 + cell / 2, cell, 0, y1 - cell / 2, 0, -cell], cell, source: "synthétique" };
}

export function toModel(faces: SegFace[]): RoofModel {
  const frame = makeFrame(-1.37, 46.2);
  return {
    version: 1,
    origin: [-1.37, 46.2],
    edgeOverrides: {},
    faces: faces.map((f, i) => {
      const c = centroid(f.ring);
      return {
        id: `f${i}`,
        ring: f.ring.map((p) => toLonLat(frame, p)),
        pitchDeg: f.pitchDeg,
        azimuthDeg: f.azimuthDeg,
        plane: { anchor: toLonLat(frame, c), z: planeAt(f.plane, c[0], c[1]) },
      };
    }),
  };
}

export function runSynthetic(
  zf: (x: number, y: number) => number | null,
  footprint: XY[],
  ext: [number, number, number, number],
  opts: { cell?: number; noise?: number; overhang?: number } = {},
) {
  const grid = makeGrid(zf, ext, opts.cell ?? 0.5, 10, opts.noise ?? 0.03);
  const seg = segmentRoof(grid, [footprint], [], { overhang: opts.overhang ?? 0.8 });
  const model = toModel(seg.faces);
  return { seg, model, metrics: computeMetrics(model) };
}

export { pointInPolygon };
