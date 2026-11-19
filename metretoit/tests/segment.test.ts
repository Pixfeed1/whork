import { describe, it, expect } from "vitest";
import type { XY } from "../shared/geo";
import { runSynthetic, pointInPolygon } from "./synthetic";

const D2R = Math.PI / 180;
const rel = (a: number, b: number) => Math.abs(a - b) / b;

describe("extraction automatique sur toitures synthétiques", () => {
  it("toiture deux pans 12 x 8 m, débord 0,4 m, pente 35°", () => {
    const t = Math.tan(35 * D2R);
    const fp: XY[] = [
      [-6, -4],
      [6, -4],
      [6, 4],
      [-6, 4],
    ];
    const zf = (x: number, y: number) =>
      Math.abs(x) <= 6.4 && Math.abs(y) <= 4.4 ? 16 + t * (4.4 - Math.abs(y)) : null;
    const { metrics, seg } = runSynthetic(zf, fp, [-16, -14, 16, 14], { overhang: 0.8 });
    const L = metrics.totals.lengths;
    const area = (12.8 * 8.8) / Math.cos(35 * D2R);
    console.log("2 pans", metrics.totals, seg.diagnostics);
    expect(metrics.totals.faceCount).toBe(2);
    expect(rel(metrics.totals.area, area)).toBeLessThan(0.04);
    for (const f of metrics.faces) expect(Math.abs(f.pitchDeg - 35)).toBeLessThan(1);
    expect(rel(L.faitage, 12.8)).toBeLessThan(0.05);
    expect(rel(L.egout, 25.6)).toBeLessThan(0.05);
    expect(rel(L.rive, (4 * 4.4) / Math.cos(35 * D2R))).toBeLessThan(0.08);
    expect(L.noue + L.aretier).toBeLessThan(0.5);
  });

  it("toiture à quatre pans (croupes) 14 x 10 m, pente 30°", () => {
    const t = Math.tan(30 * D2R);
    const fp: XY[] = [
      [-7, -5],
      [7, -5],
      [7, 5],
      [-7, 5],
    ];
    const zf = (x: number, y: number) =>
      Math.abs(x) <= 7 && Math.abs(y) <= 5 ? 15 + t * Math.min(5 - Math.abs(y), 7 - Math.abs(x)) : null;
    const { metrics, seg } = runSynthetic(zf, fp, [-18, -16, 18, 16], { overhang: 0.3 });
    const L = metrics.totals.lengths;
    console.log("croupe", metrics.totals, seg.diagnostics);
    expect(metrics.totals.faceCount).toBe(4);
    expect(rel(metrics.totals.area, 140 / Math.cos(30 * D2R))).toBeLessThan(0.04);
    expect(rel(L.faitage, 4)).toBeLessThan(0.15);
    const hip = Math.sqrt(50 + (5 * t) ** 2);
    expect(rel(L.aretier, 4 * hip)).toBeLessThan(0.06);
    expect(rel(L.egout, 48)).toBeLessThan(0.05);
  });

  it("toiture en T avec deux noues, pente 40°", () => {
    const t = Math.tan(40 * D2R);
    const fp: XY[] = [
      [-8, -4],
      [8, -4],
      [8, 4],
      [4, 4],
      [4, 12],
      [-4, 12],
      [-4, 4],
      [-8, 4],
    ];
    const zf = (x: number, y: number) => {
      if (!pointInPolygon([x, y], fp)) return null;
      const main = Math.abs(y) <= 4 ? 15 + t * (4 - Math.abs(y)) : -Infinity;
      const wing = Math.abs(x) <= 4 && y >= 0 ? 15 + t * (4 - Math.abs(x)) : -Infinity;
      return Math.max(main, wing);
    };
    const { metrics, seg } = runSynthetic(zf, fp, [-18, -14, 18, 22], { overhang: 0.3 });
    const L = metrics.totals.lengths;
    console.log("T", metrics.totals, seg.diagnostics);
    // pan nord du corps principal coupé en deux par l'aile
    expect(metrics.totals.faceCount).toBe(5);
    expect(rel(metrics.totals.area, 192 / Math.cos(40 * D2R))).toBeLessThan(0.04);
    expect(rel(L.faitage, 28)).toBeLessThan(0.06);
    expect(rel(L.noue, 2 * Math.sqrt(32 + 16 * t * t))).toBeLessThan(0.1);
    expect(rel(L.egout, 40)).toBeLessThan(0.06);
    expect(rel(L.rive, (6 * 4) / Math.cos(40 * D2R))).toBeLessThan(0.1);
  });

  it("cheminée détectée automatiquement sur un pan", () => {
    const t = Math.tan(35 * D2R);
    const fp: XY[] = [
      [-6, -4],
      [6, -4],
      [6, 4],
      [-6, 4],
    ];
    const zf = (x: number, y: number) => {
      if (Math.abs(x) > 6.4 || Math.abs(y) > 4.4) return null;
      const roof = 16 + t * (4.4 - Math.abs(y));
      // souche de cheminée 1,0 x 1,0 m, 1,2 m au-dessus du toit
      if (x > 1.5 && x < 2.5 && y > -2.5 && y < -1.5) return roof + 1.2;
      return roof;
    };
    const { seg, metrics } = runSynthetic(zf, fp, [-16, -14, 16, 14], { overhang: 0.8 });
    expect(seg.chimneys.length).toBe(1);
    const c = seg.chimneys[0];
    expect(Math.hypot(c.center[0] - 2, c.center[1] + 2)).toBeLessThan(0.5);
    expect(c.width).toBeGreaterThan(0.6);
    expect(c.width).toBeLessThan(1.6);
    // la cheminée ne doit pas créer de pan parasite
    expect(metrics.totals.faceCount).toBe(2);
  });
});

