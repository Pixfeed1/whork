import type { XY } from "../../shared/geo";

/**
 * Grille d'altitude (MNS) avec une transformation affine
 * pixel (colonne i, ligne j, centre du pixel) -> coordonnées locales (m).
 */
export interface DsmGrid {
  w: number;
  h: number;
  z: Float32Array; // NaN = pas de donnée
  /** x = a0 + a1*i + a2*j ; y = b0 + b1*i + b2*j */
  affine: [number, number, number, number, number, number];
  /** taille approximative d'un pixel en mètres */
  cell: number;
  source: string;
}

export function pixelToLocal(g: DsmGrid, i: number, j: number): XY {
  const [a0, a1, a2, b0, b1, b2] = g.affine;
  return [a0 + a1 * i + a2 * j, b0 + b1 * i + b2 * j];
}

export function localToPixel(g: DsmGrid, p: XY): [number, number] {
  const [a0, a1, a2, b0, b1, b2] = g.affine;
  const det = a1 * b2 - a2 * b1;
  const dx = p[0] - a0;
  const dy = p[1] - b0;
  return [(b2 * dx - a2 * dy) / det, (-b1 * dx + a1 * dy) / det];
}

/** Construit l'affine à partir de trois pixels de référence déjà projetés. */
export function affineFrom3(
  p00: XY, // pixel (0,0)
  pW0: XY, // pixel (W,0)
  p0H: XY, // pixel (0,H)
  W: number,
  H: number,
): DsmGrid["affine"] {
  return [
    p00[0],
    (pW0[0] - p00[0]) / W,
    (p0H[0] - p00[0]) / H,
    p00[1],
    (pW0[1] - p00[1]) / W,
    (p0H[1] - p00[1]) / H,
  ];
}

/** Interpolation bilinéaire de l'altitude en un point local. */
export function sampleZ(g: DsmGrid, p: XY): number {
  const [fi, fj] = localToPixel(g, p);
  const i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  if (i0 < 0 || j0 < 0 || i0 + 1 >= g.w || j0 + 1 >= g.h) {
    const i = Math.round(fi);
    const j = Math.round(fj);
    if (i < 0 || j < 0 || i >= g.w || j >= g.h) return NaN;
    return g.z[j * g.w + i];
  }
  const tx = fi - i0;
  const ty = fj - j0;
  const z00 = g.z[j0 * g.w + i0];
  const z10 = g.z[j0 * g.w + i0 + 1];
  const z01 = g.z[(j0 + 1) * g.w + i0];
  const z11 = g.z[(j0 + 1) * g.w + i0 + 1];
  return (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
}
