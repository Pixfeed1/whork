import { describe, it, expect } from "vitest";
import { makeFrame, toLonLat, type XY, type LonLat } from "../shared/geo";
import { computeMetrics, type RoofModel, edgeKey } from "../shared/roof";
import { addFace, moveVertex, insertVertex, deleteVertex, splitFace, setEdgeType, deleteFace } from "../shared/edit";

const O: LonLat = [-1.37, 46.2];
const F = makeFrame(O[0], O[1]);
const ll = (p: XY) => toLonLat(F, p);
const D2R = Math.PI / 180;

// toiture deux pans 10 x 8 m, pente 30°, faîtage à y = 0
function gable(): RoofModel {
  return {
    version: 1,
    origin: O,
    edgeOverrides: {},
    faces: [
      { id: "S", ring: [ll([-5, -4]), ll([5, -4]), ll([5, 0]), ll([-5, 0])], pitchDeg: 30, azimuthDeg: 180 },
      { id: "N", ring: [ll([-5, 0]), ll([5, 0]), ll([5, 4]), ll([-5, 4])], pitchDeg: 30, azimuthDeg: 0 },
    ],
  };
}

describe("moteur de métré", () => {
  it("surfaces, linéaires et classement d'une toiture deux pans", () => {
    const m = computeMetrics(gable());
    const L = m.totals.lengths;
    expect(m.totals.area).toBeCloseTo(80 / Math.cos(30 * D2R), 1);
    expect(L.faitage).toBeCloseTo(10, 2);
    expect(L.egout).toBeCloseTo(20, 2);
    expect(L.rive).toBeCloseTo((4 * 4) / Math.cos(30 * D2R), 2);
    expect(m.edges.length).toBe(7);
  });

  it("noue et arêtier selon la convexité", () => {
    // deux pans qui descendent l'un vers l'autre : noue horizontale
    const g = gable();
    g.faces[0].azimuthDeg = 0;
    g.faces[1].azimuthDeg = 180;
    expect(computeMetrics(g).totals.lengths.noue).toBeCloseTo(10, 2);
  });

  it("surcharge manuelle du type d'arête", () => {
    const g = gable();
    const k = edgeKey(ll([-5, 0]), ll([5, 0]));
    const m2 = setEdgeType(g, k, "bris");
    const met = computeMetrics(m2);
    expect(met.totals.lengths.bris).toBeCloseTo(10, 2);
    expect(met.totals.lengths.faitage).toBe(0);
    expect(computeMetrics(setEdgeType(m2, k, null)).totals.lengths.faitage).toBeCloseTo(10, 2);
  });
});

describe("opérations d'édition", () => {
  it("déplacer un sommet partagé déplace les deux pans et conserve le type forcé", () => {
    let g = gable();
    const a = ll([5, 0]);
    g = setEdgeType(g, edgeKey(ll([-5, 0]), a), "bris");
    const b = ll([6, 0]);
    const m2 = moveVertex(g, a, b);
    const met = computeMetrics(m2);
    expect(met.totals.lengths.bris).toBeCloseTo(11, 1);
    expect(m2.faces.every((f) => f.ring.some((p) => p[0] === b[0] && p[1] === b[1]))).toBe(true);
  });

  it("insérer puis supprimer un sommet", () => {
    const g = gable();
    const m2 = insertVertex(g, ll([-5, 0]), ll([5, 0]), ll([0, 0]));
    expect(m2.faces[0].ring.length).toBe(5);
    expect(m2.faces[1].ring.length).toBe(5);
    expect(computeMetrics(m2).totals.lengths.faitage).toBeCloseTo(10, 2);
    const m3 = deleteVertex(m2, ll([0, 0]));
    expect(m3.faces[0].ring.length).toBe(4);
  });

  it("ajouter un pan accolé partage l'arête commune", () => {
    const g = gable();
    // appentis contre le pignon est, sommet posé au milieu de la rive
    const m2 = addFace(g, [ll([5, -4]), ll([8, -4]), ll([8, 0]), ll([5, 0])], 20, 90);
    const met = computeMetrics(m2);
    expect(met.totals.faceCount).toBe(3);
    const shared = met.edges.filter((e) => e.faces.length === 2);
    expect(shared.length).toBe(2); // faîtage + arête commune avec l'appentis
  });

  it("découper un pan en deux", () => {
    const g = gable();
    const r = splitFace(g, "S", ll([-5, -4]), ll([5, 0]));
    expect(r).not.toBeNull();
    const met = computeMetrics(r!.model);
    expect(met.totals.faceCount).toBe(3);
    expect(met.totals.area).toBeCloseTo(computeMetrics(g).totals.area, 3);
    // sommets voisins : découpe refusée
    expect(splitFace(g, "S", ll([-5, -4]), ll([5, -4]))).toBeNull();
  });

  it("supprimer un pan", () => {
    expect(deleteFace(gable(), "N").faces.length).toBe(1);
  });

  it("éléments de toiture : solins de cheminée et abergement de fenêtre de toit", async () => {
    const { addElement, updateElement, deleteElement } = await import("../shared/edit");
    let g = gable();
    const a = addElement(g, "cheminee", ll([2, -2]));
    g = updateElement(a.model, a.id, { width: 0.8, length: 1.0 });
    g = addElement(g, "chassis", ll([-2, 2])).model;
    const met = computeMetrics(g);
    expect(met.elements.length).toBe(2);
    expect(met.elements[0].faceId).toBe("S");
    const fl = Object.fromEntries(met.flashing.map((f) => [f.key, f.length]));
    expect(fl.chem_amont).toBeCloseTo(0.8, 5);
    expect(fl.chem_cotes).toBeCloseTo(2.0, 5);
    expect(fl.chem_contre).toBeCloseTo(3.6, 5);
    expect(fl.chassis_aberg).toBeCloseTo(2 * (0.78 + 0.98), 5);
    // emprise orientée selon la pente (pan sud : le haut de la cheminée est au nord)
    const top = met.elements[0].ring[0];
    const bottom = met.elements[0].ring[3];
    expect(top[1]).toBeGreaterThan(bottom[1]);
    expect(deleteElement(g, a.id).elements!.length).toBe(1);
  });

  it("orientation automatique : deux pans « en dents de scie » redeviennent un toit à deux pans", async () => {
    const { autoOrient } = await import("../shared/edit");
    let g = gable();
    g.faces[1].azimuthDeg = 180; // les deux pans descendent vers le sud (erreur)
    expect(computeMetrics(g).totals.lengths.faitage).toBe(0);
    g = autoOrient(autoOrient(g, "S"), "N");
    expect(g.faces[0].azimuthDeg).toBe(180);
    expect(g.faces[1].azimuthDeg).toBe(0);
    expect(computeMetrics(g).totals.lengths.faitage).toBeCloseTo(10, 2);
  });
});

