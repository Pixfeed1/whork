import { describe, it, expect } from "vitest";
import { makeFrame, toLonLat, type XY, type LonLat } from "../shared/geo";
import type { RoofModel } from "../shared/roof";
import { computeFacades } from "../shared/facades";

const O: LonLat = [-1.37, 46.2];
const F = makeFrame(O[0], O[1]);
const ll = (p: XY) => toLonLat(F, p);
const T30 = Math.tan((30 * Math.PI) / 180);

// maison 10 x 8 m, toit deux pans (faîtage est-ouest), égout à 6 m au-dessus du sol (sol = 10 m)
function house(): RoofModel {
  return {
    version: 1,
    origin: O,
    edgeOverrides: {},
    footprint: [ll([-5, -4]), ll([5, -4]), ll([5, 4]), ll([-5, 4])],
    footprintMitoyen: [false, false, false, true], // côté ouest collé au voisin
    meta: { diagnostics: { ground: 10 } },
    faces: [
      { id: "S", ring: [ll([-5, -4]), ll([5, -4]), ll([5, 0]), ll([-5, 0])], pitchDeg: 30, azimuthDeg: 180, plane: { anchor: ll([0, -4]), z: 16 } },
      { id: "N", ring: [ll([-5, 0]), ll([5, 0]), ll([5, 4]), ll([-5, 4])], pitchDeg: 30, azimuthDeg: 0, plane: { anchor: ll([0, 4]), z: 16 } },
    ],
  };
}

describe("métré des façades", () => {
  it("surfaces brutes, pignons, mitoyen exclu", () => {
    const r = computeFacades(house());
    expect(r.heightSource).toBe("relevé");
    expect(r.facades.length).toBe(4);
    const by = Object.fromEntries(r.facades.map((f) => [f.orientation, f]));
    expect(by.S.length).toBeCloseTo(10, 3);
    expect(by.S.eaveHeight).toBeCloseTo(6, 2);
    expect(by.S.grossArea).toBeCloseTo(60, 0);
    // pignon est : 8 x 6 + triangle 8 x (4 tan 30°) / 2
    const gable = 0.5 * 8 * 4 * T30;
    expect(by.E.grossArea).toBeCloseTo(48 + gable, 0);
    expect(by.E.gableArea).toBeCloseTo(gable, 0);
    expect(by.O.excluded).toBe(true); // mitoyen
    expect(r.totals.count).toBe(3);
    expect(r.totals.gross).toBeCloseTo(60 + 60 + 48 + gable, 0);
  });

  it("ouvertures saisies, déduction en %, exclusion forcée", () => {
    const m = house();
    m.facades = {
      enabled: true,
      defaultDeductPct: 10,
      overrides: {
        [computeFacades(m).facades.find((f) => f.orientation === "S")!.key]: {
          openings: [
            { id: "1", type: "fenetre", count: 3, width: 1, height: 1.25 },
            { id: "2", type: "porte", count: 1, width: 0.9, height: 2.15 },
          ],
        },
      },
    };
    const r = computeFacades(m);
    const s = r.facades.find((f) => f.orientation === "S")!;
    expect(s.openingsArea).toBeCloseTo(3 * 1.25 + 0.9 * 2.15, 5);
    expect(s.netArea).toBeCloseTo(s.grossArea - s.openingsArea, 5);
    const n = r.facades.find((f) => f.orientation === "N")!;
    expect(n.deductPct).toBe(10);
    expect(n.netArea).toBeCloseTo(n.grossArea * 0.9, 5);
  });
});
