// Génération du rapport PDF de métrage (pdfkit).
import PDFDocument from "pdfkit";
import type { LonLat, XY } from "../../shared/geo";
import { makeFrame, toLocal } from "../../shared/geo";
import {
  type RoofModel,
  type RoofMetrics,
  EDGE_TYPES,
  EDGE_COLOR,
  EDGE_LABEL,
  ELEMENT_TYPES,
  computeMetrics,
  downVector,
  orientationLabel,
} from "../../shared/roof";
import { ignOrtho, toL93 } from "../providers/ign";
import { roofView, fitPolys, VIEW_BEARINGS } from "../../shared/view3d";
import { computeFacades, OPENING_LABEL, type FacadesResult } from "../../shared/facades";
import { createRequire } from "node:module";

// Police Montserrat (repli sur Helvetica si indisponible)
const require_ = createRequire(import.meta.url);
function fontPath(w: number): string | null {
  try {
    return require_.resolve(`@fontsource/montserrat/files/montserrat-latin-${w}-normal.woff`);
  } catch {
    return null;
  }
}
const FONT_REG = fontPath(400);
const FONT_BOLD = fontPath(600);

export interface ReportOrg {
  name: string;
  address?: string;
  postcode?: string;
  city?: string;
  phone?: string;
  email?: string;
  website?: string;
  siret?: string;
  report_footer?: string;
  waste_pct?: number;
  report_3d?: number | boolean;
  logo?: Buffer | null;
  logo_mime?: string | null;
}

/** Source de photos aériennes en tuiles (Web Mercator z/x/y), ex. Google Map Tiles */
export interface TileImagery {
  fetch: (z: number, x: number, y: number) => Promise<Buffer | null>;
  maxZoom: number;
  credit: string;
}

export interface ReportInput {
  tiles?: TileImagery | null;
  /** photos Street View des façades (clé de façade -> image) */
  facadePhotos?: Map<string, { img: Buffer; date?: string | null }>;
  org: ReportOrg;
  number: string;
  date: Date;
  address: string;
  title?: string;
  clientName?: string;
  notes?: string;
  model: RoofModel;
  author?: string;
}

const A4 = { w: 595.28, h: 841.89 };
const M = 40;
const BRAND = "#0f7ea8";
const INK = "#1b2b3f";
const MUTED = "#6b7280";
const FACE_FILLS = ["#fde68a", "#bfdbfe", "#bbf7d0", "#fecaca", "#ddd6fe", "#fed7aa", "#a5f3fc", "#fbcfe8", "#d9f99d", "#e5e7eb"];

const fontsInUse = { reg: "Helvetica", bold: "Helvetica-Bold" };
const nf = (n: number, d = 2) =>
  n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/ | /g, " ");

export async function generateReport(input: ReportInput): Promise<Buffer> {
  const metrics = computeMetrics(input.model);
  const waste = input.org.waste_pct ?? 10;
  const doc = new PDFDocument({
    size: "A4",
    margin: M,
    bufferPages: true,
    info: {
      Title: `Rapport de métrage - ${input.address}`,
      Author: input.org.name,
      Subject: "Métrage de toiture",
      Creator: "MétréToit",
    },
  });
  let REG = "Helvetica";
  let BOLD = "Helvetica-Bold";
  try {
    if (FONT_REG && FONT_BOLD) {
      doc.registerFont("M", FONT_REG);
      doc.registerFont("MB", FONT_BOLD);
      doc.font("M");
      REG = "M";
      BOLD = "MB";
    }
  } catch {
    /* police indisponible : Helvetica */
  }
  fontsInUse.reg = REG;
  fontsInUse.bold = BOLD;
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));

  // emprise de dessin commune
  const allPts: LonLat[] = input.model.faces.flatMap((f) => f.ring);
  if (input.model.footprint) allPts.push(...input.model.footprint);
  if (!allPts.length) allPts.push(input.model.origin);
  const frame = makeFrame(input.model.origin[0], input.model.origin[1]);

  // ---------- page 1 : synthèse ----------
  header(doc, input);
  let y = 150;
  doc.fillColor(INK).font(fontsInUse.bold).fontSize(18).text("RAPPORT DE MÉTRAGE DE TOITURE", M, y, { characterSpacing: 1 });
  y += 26;
  doc.fillColor("#111").font(fontsInUse.reg).fontSize(10.5);
  doc.text(input.address, M, y, { width: A4.w - 2 * M });
  y = doc.y + 2;
  const infoLine = [
    `Réf. ${input.number}`,
    `Établi le ${input.date.toLocaleDateString("fr-FR")}`,
    input.clientName ? `Client : ${input.clientName}` : null,
    input.author ? `Par : ${input.author}` : null,
  ]
    .filter(Boolean)
    .join("   ·   ");
  doc.fillColor(MUTED).fontSize(9).text(infoLine, M, y);
  y = doc.y + 10;

  // vue aérienne
  const imgBox = { x: M, y, w: A4.w - 2 * M, h: 330 };
  const imageryCredit = await drawAerial(doc, input.model, metrics, imgBox, allPts, input.tiles ?? null);
  y = imgBox.y + imgBox.h + 14;

  // chiffres clés
  const t = metrics.totals;
  const tiles: [string, string][] = [
    ["Surface de toiture", `${nf(t.area)} m²`],
    [`Avec chutes (+${nf(waste, 0)} %)`, `${nf(t.area * (1 + waste / 100))} m²`],
    ["Nombre de pans", String(t.faceCount)],
    ["Pente moyenne", `${nf(t.meanPitchDeg, 1)}° (${nf(Math.tan((t.meanPitchDeg * Math.PI) / 180) * 100, 0)} %)`],
  ];
  const tw = (A4.w - 2 * M - 3 * 8) / 4;
  tiles.forEach(([label, val], i) => {
    const x = M + i * (tw + 8);
    doc.roundedRect(x, y, tw, 52, 6).fillColor("#f3f6fa").fill();
    doc.fillColor(MUTED).font(fontsInUse.reg).fontSize(8).text(label, x + 8, y + 8, { width: tw - 16 });
    doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(14).text(val, x + 8, y + 26, { width: tw - 16 });
  });
  y += 66;

  // linéaires
  doc.fillColor("#111").font(fontsInUse.bold).fontSize(11).text("Linéaires", M, y);
  y += 16;
  const lin = EDGE_TYPES.filter((e) => t.lengths[e.type] > 0.005);
  const colW = (A4.w - 2 * M) / 2;
  lin.forEach((e, i) => {
    const x = M + (i % 2) * colW;
    const yy = y + Math.floor(i / 2) * 18;
    doc.rect(x, yy + 3, 14, 4).fillColor(e.color).fill();
    doc.fillColor("#111").font(fontsInUse.reg).fontSize(10).text(e.label, x + 22, yy, { width: colW - 120 });
    doc.font(fontsInUse.bold).text(`${nf(t.lengths[e.type])} ml`, x + colW - 110, yy, { width: 90, align: "right" });
  });
  y += Math.ceil(lin.length / 2) * 18 + 8;
  if (metrics.elements.length) {
    const parts = ELEMENT_TYPES.filter((x) => metrics.elements.some((e) => e.type === x.type)).map(
      (x) => `${x.plural} : ${metrics.elements.filter((e) => e.type === x.type).length}`,
    );
    const fl = metrics.flashing.reduce((a, f) => a + (f.key.endsWith("contre") ? 0 : f.length), 0);
    doc.fillColor("#111").font(fontsInUse.reg).fontSize(9.5).text(`${parts.join("  ·  ")}  ·  raccords et solins : ${nf(fl)} ml (détail en page des tableaux)`, M, y, { width: A4.w - 2 * M });
    y = doc.y + 8;
  }
  const warn = (input.model.meta?.warnings as string[] | undefined) ?? [];
  const src = sourceText(input.model, imageryCredit);
  doc.fillColor(MUTED).font(fontsInUse.reg).fontSize(7.5).text(src, M, Math.min(y, A4.h - 95), { width: A4.w - 2 * M });
  if (warn.length) doc.fillColor("#b45309").text(warn.join(" "), { width: A4.w - 2 * M });

  // ---------- page 2 : plan des longueurs ----------
  doc.addPage();
  header(doc, input);
  doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(14).text("Plan des longueurs (vraie grandeur, en mètres)", M, 140);
  drawPlan(doc, input.model, metrics, frame, { x: M, y: 165, w: A4.w - 2 * M, h: 540 }, "lengths");
  legend(doc, A4.h - 120, metrics);

  // ---------- page 3 : plan des pans ----------
  doc.addPage();
  header(doc, input);
  doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(14).text("Plan des pans : surfaces et pentes", M, 140);
  drawPlan(doc, input.model, metrics, frame, { x: M, y: 165, w: A4.w - 2 * M, h: 540 }, "faces");
  doc.fillColor(MUTED).font(fontsInUse.reg).fontSize(8).text(
    "Chaque pan est numéroté ; la flèche indique le sens de la pente (écoulement de l'eau). Surfaces en vraie grandeur (rampant).",
    M,
    A4.h - 115,
    { width: A4.w - 2 * M },
  );

  // ---------- page : vues 3D (facultative, réglage Entreprise) ----------
  if (input.org.report_3d) {
  doc.addPage();
  header(doc, input);
  doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(14).text("Vues 3D de la toiture", M, 140);
    const gw = (A4.w - 2 * M - 14) / 2;
    const gh = 245;
    VIEW_BEARINGS.forEach((vb, i) => {
      const bx = M + (i % 2) * (gw + 14);
      const by = 170 + Math.floor(i / 2) * (gh + 16);
      doc.roundedRect(bx, by, gw, gh, 8).fillColor("#f4f7fa").fill();
      doc.roundedRect(bx, by, gw, 22, 8).fillColor("#e3ebf2").fill();
      doc.rect(bx, by + 14, gw, 8).fillColor("#e3ebf2").fill();
      doc.fillColor(INK).font(fontsInUse.bold).fontSize(9).text(`Vue depuis le ${vb.label.toLowerCase()}`, bx, by + 7, { width: gw, align: "center" });
      const polys = fitPolys(roofView(input.model, vb.bearing), { x: bx, y: by + 26, w: gw, h: gh - 30 }, 16);
      for (const p of polys) {
        doc.polygon(...p.pts).fillColor(cssColor(p.fill)).fill();
        doc.polygon(...p.pts).lineWidth(p.kind === "face" ? 0.7 : 0.4).lineJoin("round").strokeColor(p.stroke).stroke();
      }
    });
    doc.fillColor(MUTED).font(fontsInUse.reg).fontSize(8).text(
      "Représentation schématique établie à partir des pentes et des hauteurs mesurées. Les éléments (cheminées, fenêtres de toit) sont figurés en couleur.",
      M,
      170 + 2 * (gh + 16),
      { width: A4.w - 2 * M },
    );
  }

  // ---------- page 4 : tableaux ----------
  doc.addPage();
  header(doc, input);
  y = 140;
  doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(14).text("Tableau récapitulatif des métrés", M, y);
  y += 24;
  y = table(
    doc,
    y,
    ["Pan", "Surface (m²)", "Surface au sol (m²)", "Pente (°)", "Pente (%)", "Orientation"],
    [50, 90, 110, 75, 75, 95],
    metrics.faces.map((f) => [
      String(f.index),
      nf(f.area),
      nf(f.area2D),
      nf(f.pitchDeg, 1),
      nf(f.pitchPct, 0),
      `${f.orientation} (${Math.round(f.azimuthDeg)}°)`,
    ]),
    ["Total", nf(t.area), nf(t.area2D), nf(t.meanPitchDeg, 1), "", ""],
  );
  y += 18;
  if (y > A4.h - 200) {
    doc.addPage();
    header(doc, input);
    y = 140;
  }
  doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(12).text("Linéaires par type", M, y);
  y += 20;
  y = table(
    doc,
    y,
    ["Type", "Longueur (ml)", "Nombre", "Description"],
    [120, 90, 60, 225],
    EDGE_TYPES.map((e) => [
      e.label,
      nf(t.lengths[e.type]),
      String(metrics.edges.filter((x) => x.type === e.type).length),
      e.help,
    ]),
    ["Périmètre (au sol)", nf(t.perimeter), "", ""],
  );
  y += 18;
  // éléments de toiture et raccords
  if (metrics.elements.length) {
    if (y > A4.h - 200) {
      doc.addPage();
      header(doc, input);
      y = 140;
    }
    doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(12).text("Éléments de toiture et raccords", M, y);
    y += 20;
    const faceIdx = new Map(metrics.faces.map((f) => [f.id, f.index]));
    y = table(
      doc,
      y,
      ["Repère", "Élément", "Largeur (m)", "Longueur (m)", "Pan", "Raccords (ml)"],
      [55, 120, 75, 85, 50, 130],
      metrics.elements.map((e) => [
        `${e.type === "cheminee" ? "C" : e.type === "chassis" ? "F" : "L"}${e.index}`,
        e.label + (input.model.elements?.find((x) => x.id === e.id)?.auto ? " (auto)" : ""),
        nf(e.width),
        nf(e.length),
        e.faceId ? String(faceIdx.get(e.faceId) ?? "") : "",
        nf(e.lines.filter((l) => !l.key.endsWith("contre")).reduce((a, l) => a + l.length, 0)),
      ]),
      null,
      () => {
        doc.addPage();
        header(doc, input);
        return 140;
      },
    );
    y += 10;
    y = table(
      doc,
      y,
      ["Raccord / solin", "Longueur (ml)"],
      [385, 130],
      metrics.flashing.map((f) => [f.label, nf(f.length)]),
      null,
    );
    y += 18;
  }
  // tableau des chutes : surface à commander selon le taux de perte
  if (y > A4.h - 150) {
    doc.addPage();
    header(doc, input);
    y = 140;
  }
  doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(12).text("Surface à commander selon le taux de chutes", M, y);
  y += 20;
  const rates = wasteRates(waste);
  const cw = (A4.w - 2 * M - 90) / rates.length;
  y = table(
    doc,
    y,
    ["Chutes", ...rates.map((r) => `${nf(r, 0)} %`)],
    [90, ...rates.map(() => cw)],
    [["Surface (m²)", ...rates.map((r) => nf(t.area * (1 + r / 100)))]],
    null,
    undefined,
    rates.indexOf(waste) + 1,
  );
  doc.fillColor(MUTED).font(fontsInUse.reg).fontSize(7.5).text(`Colonne surlignée : taux retenu par l'entreprise (${nf(waste, 0)} %). Taux indicatifs, à adapter au matériau et à la complexité de la toiture.`, M, y + 4, { width: A4.w - 2 * M });
  y = doc.y + 14;
  if (input.notes) {
    if (y > A4.h - 160) {
      doc.addPage();
      header(doc, input);
      y = 140;
    }
    doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(12).text("Observations", M, y);
    doc.fillColor("#111").font(fontsInUse.reg).fontSize(9.5).text(input.notes, M, y + 18, { width: A4.w - 2 * M });
    y = doc.y + 14;
  }

  // ---------- métré des façades ----------
  if (input.model.facades?.enabled) {
    const fr = computeFacades(input.model);
    if (fr.facades.length) {
      doc.addPage();
      header(doc, input);
      doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(14).text("Métré des façades", M, 140);
      // plan des façades
      drawFacadePlan(doc, input.model, fr, { x: M, y: 162, w: A4.w - 2 * M, h: 250 });
      let fy = 422;
      const ft = fr.totals;
      const ftiles: [string, string][] = [
        ["Surface brute", `${nf(ft.gross)} m²`],
        ["Ouvertures déduites", `${nf(ft.openings)} m²`],
        ["Surface nette à traiter", `${nf(ft.net)} m²`],
        ["Façades · linéaire", `${ft.count} · ${nf(ft.length)} m`],
      ];
      const ftw = (A4.w - 2 * M - 3 * 8) / 4;
      ftiles.forEach(([label, val], i) => {
        const x = M + i * (ftw + 8);
        doc.roundedRect(x, fy, ftw, 46, 6).fillColor("#f3f6fa").fill();
        doc.fillColor(MUTED).font(fontsInUse.reg).fontSize(7.5).text(label, x + 8, fy + 7, { width: ftw - 16 });
        doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(12.5).text(val, x + 8, fy + 23, { width: ftw - 16 });
      });
      fy += 58;
      fy = table(
        doc,
        fy,
        ["N°", "Façade", "Long. (m)", "H. égout", "Brute m²", "Pignon m²", "Ouvert. m²", "Nette m²"],
        [42, 108, 58, 55, 60, 60, 64, 68],
        fr.facades.map((f) => [
          `F${f.index}`,
          f.label,
          nf(f.length),
          nf(f.eaveHeight),
          nf(f.grossArea),
          f.gableArea > 0.05 ? nf(f.gableArea) : "",
          f.excluded ? "" : nf(f.openingsArea),
          f.excluded ? (f.mitoyenAuto ? "mitoyenne" : "exclue") : nf(f.netArea),
        ]),
        ["Total", "", nf(ft.length), "", nf(ft.gross), "", nf(ft.openings), nf(ft.net)],
        () => {
          doc.addPage();
          header(doc, input);
          return 140;
        },
      );
      const ops = fr.facades.flatMap((f) =>
        f.excluded ? [] : (input.model.facades?.overrides?.[f.key]?.openings ?? []).map((o) => ({ f, o })),
      );
      fy += 8;
      doc.fillColor(MUTED).font(fontsInUse.reg).fontSize(7.5).text(
        `Surfaces brutes calculées du sol à la toiture le long de chaque mur (pignons compris). Hauteurs ${fr.heightSource === "relevé" ? "mesurées sur le relevé 3D" : "estimées (hauteur d'égout par défaut)"}. Murs mitoyens exclus. Ouvertures ${ops.length ? "saisies" : "déduites forfaitairement"}. À confirmer sur site.`,
        M,
        fy,
        { width: A4.w - 2 * M },
      );
      fy = doc.y + 12;
      if (ops.length) {
        if (fy > A4.h - 150) {
          doc.addPage();
          header(doc, input);
          fy = 140;
        }
        doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(11).text("Ouvertures déduites", M, fy);
        fy += 16;
        fy = table(
          doc,
          fy,
          ["Façade", "Type", "Nombre", "Dimensions (m)", "Surface (m²)"],
          [140, 120, 60, 110, 85],
          ops.map(({ f, o }) => [`F${f.index} · ${f.label}`, OPENING_LABEL[o.type], String(o.count), `${nf(o.width, 2)} × ${nf(o.height, 2)}`, nf(o.count * o.width * o.height)]),
          null,
          () => {
            doc.addPage();
            header(doc, input);
            return 140;
          },
        );
      }
      // photos Street View
      const shots = fr.facades.filter((f) => !f.excluded && input.facadePhotos?.get(f.key));
      if (shots.length) {
        doc.addPage();
        header(doc, input);
        doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(14).text("Façades vues depuis la rue", M, 140);
        const pw = (A4.w - 2 * M - 14) / 2;
        const ph = pw * (420 / 640);
        let i = 0;
        let py = 166;
        for (const f of shots) {
          if (py + ph + 30 > A4.h - 60) {
            doc.addPage();
            header(doc, input);
            py = 140;
            i = 0;
          }
          const x = M + (i % 2) * (pw + 14);
          const ph0 = input.facadePhotos!.get(f.key)!;
          try {
            doc.save();
            doc.roundedRect(x, py, pw, ph, 6).clip();
            doc.image(ph0.img, x, py, { width: pw, height: ph });
            doc.restore();
          } catch {
            doc.restore();
          }
          doc.fillColor(INK).font(fontsInUse.bold).fontSize(8.5).text(`F${f.index} · ${f.label}`, x, py + ph + 4, { width: pw * 0.65, lineBreak: false });
          doc.fillColor(MUTED).font(fontsInUse.reg).fontSize(7).text(`Street View${ph0.date ? ` (${ph0.date})` : ""} · © Google`, x + pw * 0.45, py + ph + 5, { width: pw * 0.55, align: "right", lineBreak: false });
          i++;
          if (i % 2 === 0) py += ph + 26;
        }
      }
    }
  }

  // détail des arêtes
  doc.addPage();
  header(doc, input);
  y = 140;
  doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(12).text("Détail des arêtes", M, y);
  y += 20;
  const edgesSorted = metrics.edges
    .slice()
    .sort((a, b) => EDGE_TYPES.findIndex((e) => e.type === a.type) - EDGE_TYPES.findIndex((e) => e.type === b.type) || b.length - a.length);
  const edgeIdx = new Map(metrics.edges.map((e, i) => [e.key, i + 1]));
  const faceIdx = new Map(metrics.faces.map((f) => [f.id, f.index]));
  table(
    doc,
    y,
    ["N°", "Type", "Longueur (ml)", "Au sol (m)", "Inclinaison (°)", "Pans"],
    [40, 120, 85, 80, 85, 85],
    edgesSorted.map((e) => [
      String(edgeIdx.get(e.key)),
      EDGE_LABEL[e.type] + (e.overridden ? " *" : ""),
      nf(e.length),
      nf(e.length2D),
      nf(e.slopeDeg, 1),
      e.faces.map((f) => faceIdx.get(f)).join(" / "),
    ]),
    null,
    () => {
      doc.addPage();
      header(doc, input);
      return 140;
    },
  );
  if (metrics.edges.some((e) => e.overridden))
    doc.fillColor(MUTED).font(fontsInUse.reg).fontSize(8).text("* type d'arête corrigé manuellement", M, doc.y + 6);

  // pieds de page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // évite l'ajout automatique de pages
    const fy = A4.h - 52;
    doc.moveTo(M, fy).lineTo(A4.w - M, fy).strokeColor("#e5e7eb").lineWidth(0.5).stroke();
    const footer =
      input.org.report_footer ||
      "Métrage établi à distance à partir de relevés aériens. Les valeurs sont à confirmer sur site avant commande des matériaux.";
    doc.fillColor(MUTED).font(fontsInUse.reg).fontSize(7).text(footer, M, fy + 6, { width: A4.w - 2 * M - 80, lineBreak: true, height: 30 });
    doc.text(`${input.number} · page ${i + 1}/${range.count}`, A4.w - M - 120, fy + 6, { width: 120, align: "right" });
  }
  doc.end();
  return done;
}

/** « rgb(r,g,b) » ou « #rrggbb » vers une couleur pdfkit */
function cssColor(c: string): string | [number, number, number] {
  const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(c.replace(/\s/g, ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : c;
}

/** taux de chutes présentés : série standard + taux de l'entreprise */
export function wasteRates(own: number): number[] {
  const base = [0, 5, 8, 10, 12, 15, 20];
  const r = base.includes(own) ? base : [...base, own].sort((a, b) => a - b);
  return r;
}

function sourceText(model: RoofModel, imagery = "IGN (Géoplateforme)"): string {
  const m = model.meta ?? {};
  const parts: string[] = [];
  if (m.dsmSource) parts.push(`Relevé 3D : ${m.dsmSource}`);
  if (m.imageryDate) parts.push(`date des images : ${m.imageryDate}`);
  parts.push(`Photographie aérienne : ${imagery}`);
  if ((m.google as any)?.wholeRoofArea)
    parts.push(`contrôle Google Solar API : ${nf((m.google as any).wholeRoofArea)} m² sur ${(m.google as any).segmentCount} segments`);
  if (model.faces.some((f) => f.source === "manual")) parts.push("pans corrigés ou dessinés manuellement");
  return parts.join(" · ") + ".";
}

function header(doc: PDFKit.PDFDocument, input: ReportInput) {
  const o = input.org;
  doc.rect(0, 0, A4.w, 6).fillColor(BRAND).fill();
  let lx = M;
  if (o.logo && o.logo.length) {
    try {
      doc.image(o.logo, M, 26, { fit: [140, 70] });
      lx = M;
    } catch {
      /* format de logo non supporté par pdfkit (ex. WebP) */
      doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(16).text(o.name, lx, 40, { width: 260 });
    }
  } else {
    doc.fillColor(BRAND).font(fontsInUse.bold).fontSize(16).text(o.name, lx, 40, { width: 260 });
  }
  const lines = [
    o.name,
    o.address,
    [o.postcode, o.city].filter(Boolean).join(" "),
    o.phone ? `Tél. ${o.phone}` : "",
    o.email,
    o.website,
    o.siret ? `SIRET ${o.siret}` : "",
  ].filter((s) => s && String(s).trim());
  doc.fillColor("#111").font(fontsInUse.bold).fontSize(9).text(lines[0] ?? "", A4.w - M - 220, 26, { width: 220, align: "right" });
  doc.font(fontsInUse.reg).fontSize(8).fillColor(MUTED);
  for (const l of lines.slice(1)) doc.text(String(l), { width: 220, align: "right" });
  doc.moveTo(M, 118).lineTo(A4.w - M, 118).strokeColor("#e5e7eb").lineWidth(0.8).stroke();
}

function legend(doc: PDFKit.PDFDocument, y: number, metrics: RoofMetrics) {
  const used = EDGE_TYPES.filter((e) => metrics.totals.lengths[e.type] > 0.005);
  let x = M;
  doc.font(fontsInUse.reg).fontSize(8.5);
  for (const e of used) {
    const label = `${e.label} : ${nf(metrics.totals.lengths[e.type])} ml`;
    const w = doc.widthOfString(label) + 30;
    if (x + w > A4.w - M) {
      x = M;
      y += 16;
    }
    doc.rect(x, y + 3, 16, 3).fillColor(e.color).fill();
    doc.fillColor("#111").text(label, x + 20, y, { lineBreak: false });
    x += w;
  }
}

type Box = { x: number; y: number; w: number; h: number };

function fitTransform(pts: XY[], box: Box, pad = 18) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const s = Math.min((box.w - 2 * pad) / Math.max(1, x1 - x0), (box.h - 2 * pad) / Math.max(1, y1 - y0));
  const ox = box.x + (box.w - s * (x1 - x0)) / 2;
  const oy = box.y + (box.h - s * (y1 - y0)) / 2;
  return { s, f: (p: XY): XY => [ox + (p[0] - x0) * s, oy + (y1 - p[1]) * s] };
}

function northArrow(doc: PDFKit.PDFDocument, x: number, y: number, light = false) {
  const c = light ? "#ffffff" : "#111111";
  doc.save();
  doc.moveTo(x, y).lineTo(x - 6, y + 16).lineTo(x, y + 12).lineTo(x + 6, y + 16).closePath().fillColor(c).fill();
  doc.fillColor(c).font(fontsInUse.bold).fontSize(9).text("N", x - 4, y + 18, { lineBreak: false });
  doc.restore();
}

function scaleBar(doc: PDFKit.PDFDocument, x: number, y: number, s: number, light = false) {
  const candidates = [1, 2, 5, 10, 20, 50];
  const m = candidates.find((c) => c * s > 50) ?? 50;
  const c = light ? "#ffffff" : "#111111";
  doc.save();
  doc.rect(x, y, m * s, 4).fillColor(c).fill();
  doc.fillColor(c).font(fontsInUse.reg).fontSize(8).text(`${m} m`, x, y + 6, { lineBreak: false });
  doc.restore();
}

// ---------- photo aérienne en tuiles (plus nette que le WMS IGN) ----------
const merc = (p: LonLat): XY => {
  const lat = Math.max(-85, Math.min(85, p[1])) * (Math.PI / 180);
  return [((p[0] + 180) / 360) * 256, ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * 256];
};

async function drawTiledImagery(
  doc: PDFKit.PDFDocument,
  box: Box,
  pts: LonLat[],
  tiles: TileImagery,
): Promise<{ f: (p: LonLat) => XY; mPerPt: number } | null> {
  const m = pts.map(merc);
  let x0 = Math.min(...m.map((p) => p[0]));
  let x1 = Math.max(...m.map((p) => p[0]));
  let y0 = Math.min(...m.map((p) => p[1]));
  let y1 = Math.max(...m.map((p) => p[1]));
  const pad = Math.max(1e-5, 0.1 * Math.max(x1 - x0, y1 - y0));
  x0 -= pad;
  x1 += pad;
  y0 -= pad;
  y1 += pad;
  const ratio = box.w / box.h;
  if ((x1 - x0) / (y1 - y0) > ratio) {
    const h = (x1 - x0) / ratio;
    const c = (y0 + y1) / 2;
    y0 = c - h / 2;
    y1 = c + h / 2;
  } else {
    const w = (y1 - y0) * ratio;
    const c = (x0 + x1) / 2;
    x0 = c - w / 2;
    x1 = c + w / 2;
  }
  // zoom visé : environ 2000 pixels sur la largeur de l'image
  let z = Math.min(tiles.maxZoom, Math.ceil(Math.log2(2000 / (x1 - x0))));
  for (let attempt = 0; attempt < 3 && z >= 15; attempt++, z--) {
    const k = 2 ** z;
    const tx0 = Math.floor((x0 * k) / 256);
    const tx1 = Math.floor((x1 * k) / 256);
    const ty0 = Math.floor((y0 * k) / 256);
    const ty1 = Math.floor((y1 * k) / 256);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 120) continue;
    const jobs: { x: number; y: number }[] = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push({ x: tx, y: ty });
    const imgs: (Buffer | null)[] = new Array(jobs.length).fill(null);
    let next = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < jobs.length) {
          const i = next++;
          imgs[i] = await tiles.fetch(z, jobs[i].x, jobs[i].y).catch(() => null);
        }
      }),
    );
    if (imgs.some((b) => !b)) continue; // zoom indisponible ici : on descend d'un niveau
    const s = box.w / ((x1 - x0) * k); // points PDF par pixel de tuile
    jobs.forEach((j, i) => {
      doc.image(imgs[i]!, box.x + (j.x * 256 - x0 * k) * s, box.y + (j.y * 256 - y0 * k) * s, { width: 256 * s + 0.4, height: 256 * s + 0.4 });
    });
    const latc = ((Math.atan(Math.sinh(Math.PI * (1 - (2 * (y0 + y1)) / 2 / 256))) * 180) / Math.PI) * (Math.PI / 180);
    const mPerPx = (156543.03392 * Math.cos(latc)) / k;
    return {
      f: (p: LonLat): XY => {
        const q = merc(p);
        return [box.x + (q[0] * k - x0 * k) * s, box.y + (q[1] * k - y0 * k) * s];
      },
      mPerPt: mPerPx / s,
    };
  }
  return null;
}

async function drawAerial(
  doc: PDFKit.PDFDocument,
  model: RoofModel,
  metrics: RoofMetrics,
  box: Box,
  pts: LonLat[],
  tiles: TileImagery | null,
): Promise<string> {
  if (tiles) {
    doc.save();
    doc.roundedRect(box.x, box.y, box.w, box.h, 6).clip();
    const t = await drawTiledImagery(doc, box, pts, tiles).catch(() => null);
    if (t) {
      drawOverlay(doc, model, metrics, box, t.f, 1 / t.mPerPt, true);
      doc.font(fontsInUse.reg).fontSize(6).fillColor("#ffffff").text(`Imagerie © ${tiles.credit}`, box.x + box.w - 110, box.y + box.h - 11, { width: 104, align: "right", lineBreak: false });
      doc.restore();
      return tiles.credit;
    }
    doc.restore();
  }
  // emprise Lambert-93 au ratio de la boîte
  const l93 = pts.map((p) => toL93(p));
  let x0 = Math.min(...l93.map((p) => p[0]));
  let x1 = Math.max(...l93.map((p) => p[0]));
  let y0 = Math.min(...l93.map((p) => p[1]));
  let y1 = Math.max(...l93.map((p) => p[1]));
  const pad = Math.max(4, 0.1 * Math.max(x1 - x0, y1 - y0));
  x0 -= pad;
  x1 += pad;
  y0 -= pad;
  y1 += pad;
  const ratio = box.w / box.h;
  if ((x1 - x0) / (y1 - y0) > ratio) {
    const h = (x1 - x0) / ratio;
    const cy = (y0 + y1) / 2;
    y0 = cy - h / 2;
    y1 = cy + h / 2;
  } else {
    const w = (y1 - y0) * ratio;
    const cx = (x0 + x1) / 2;
    x0 = cx - w / 2;
    x1 = cx + w / 2;
  }
  const f = (p: LonLat): XY => {
    const q = toL93(p);
    return [box.x + ((q[0] - x0) / (x1 - x0)) * box.w, box.y + ((y1 - q[1]) / (y1 - y0)) * box.h];
  };
  doc.save();
  doc.roundedRect(box.x, box.y, box.w, box.h, 6).clip();
  let hasImage = false;
  try {
    const img = await ignOrtho([x0, y0, x1, y1], 1400, Math.round((1400 * box.h) / box.w));
    doc.image(img, box.x, box.y, { width: box.w, height: box.h });
    hasImage = true;
  } catch {
    doc.rect(box.x, box.y, box.w, box.h).fillColor("#e5e7eb").fill();
  }
  drawOverlay(doc, model, metrics, box, f, box.w / (x1 - x0), hasImage);
  doc.restore();
  return "IGN (Géoplateforme)";
}

/** contours, arêtes cotées, éléments, numéros de pans, échelle et nord */
function drawOverlay(
  doc: PDFKit.PDFDocument,
  model: RoofModel,
  metrics: RoofMetrics,
  box: Box,
  f: (p: LonLat) => XY,
  ptPerM: number,
  hasImage: boolean,
) {
  for (const face of model.faces) {
    const r = face.ring.map(f);
    doc.polygon(...r).fillColor("#ffffff").fillOpacity(0.12).fill();
  }
  doc.fillOpacity(1);
  for (const e of metrics.edges) {
    const a = f(e.a);
    const b = f(e.b);
    doc.moveTo(a[0], a[1]).lineTo(b[0], b[1]).strokeColor(EDGE_COLOR[e.type]).lineWidth(2.2).stroke();
  }
  drawElements(doc, metrics, f, true);
  // cotes de chaque arête directement sur la photo
  drawEdgeLabels(doc, metrics, f, Math.max(5.5, Math.min(7.5, ptPerM * 0.42)), 16);
  for (const fm of metrics.faces) {
    const c = f(fm.centroid);
    doc.circle(c[0], c[1], 8).fillColor("#ffffff").fill();
    doc.fillColor("#111").font(fontsInUse.bold).fontSize(8).text(String(fm.index), c[0] - 8, c[1] - 3.5, { width: 16, align: "center" });
  }
  const s = ptPerM;
  scaleBar(doc, box.x + 12, box.y + box.h - 22, s, hasImage);
  northArrow(doc, box.x + box.w - 20, box.y + 10, hasImage);
}

/** plan des façades : contour du bâtiment, façades numérotées et cotées */
function drawFacadePlan(doc: PDFKit.PDFDocument, model: RoofModel, fr: FacadesResult, box: Box) {
  const frame = makeFrame(model.origin[0], model.origin[1]);
  const loc = (p: LonLat) => toLocal(frame, p);
  const pts = [...fr.facades.flatMap((f) => f.segments.flat().map(loc)), ...model.faces.flatMap((f) => f.ring.map(loc))];
  if (!pts.length) return;
  const { s, f } = fitTransform(pts, box, 34);
  const P = (p: LonLat) => f(loc(p));
  doc.save();
  doc.roundedRect(box.x, box.y, box.w, box.h, 8).fillColor("#f8fafc").fill();
  for (const face of model.faces) doc.polygon(...face.ring.map(P)).fillColor("#e5e7eb").fill();
  for (const fc of fr.facades) {
    for (const [a, b] of fc.segments) {
      const pa = P(a);
      const pb = P(b);
      doc.moveTo(pa[0], pa[1]).lineTo(pb[0], pb[1]).lineWidth(4).strokeColor(fc.excluded ? "#9ca3af" : "#ea580c").stroke();
    }
    // étiquette à l'extérieur, devant la façade
    const m = loc(fc.mid);
    const az = (fc.azimuth * Math.PI) / 180;
    const q = f([m[0] + Math.sin(az) * 1.6, m[1] + Math.cos(az) * 1.6]);
    const label = fc.length >= 2 ? `F${fc.index} · ${nf(fc.length, 2)} m` : `F${fc.index}`;
    doc.font(fontsInUse.bold).fontSize(7.5);
    const tw = doc.widthOfString(label) + 8;
    doc.roundedRect(q[0] - tw / 2, q[1] - 6.5, tw, 13, 3).fillColor(fc.excluded ? "#9ca3af" : "#ea580c").fill();
    doc.fillColor("#ffffff").text(label, q[0] - tw / 2 + 4, q[1] - 3.8, { lineBreak: false });
  }
  scaleBar(doc, box.x + 10, box.y + box.h - 18, s);
  northArrow(doc, box.x + box.w - 18, box.y + 6);
  doc.restore();
}

function drawPlan(
  doc: PDFKit.PDFDocument,
  model: RoofModel,
  metrics: RoofMetrics,
  frame: ReturnType<typeof makeFrame>,
  box: Box,
  mode: "lengths" | "faces",
) {
  const loc = (p: LonLat) => toLocal(frame, p);
  const all = model.faces.flatMap((f) => f.ring.map(loc));
  if (!all.length) {
    doc.fillColor(MUTED).fontSize(10).text("Aucun pan.", box.x, box.y + 20);
    return;
  }
  const { s, f } = fitTransform(all, box, 30);
  const P = (p: LonLat) => f(loc(p));
  doc.save();
  model.faces.forEach((face, i) => {
    const r = face.ring.map(P);
    doc.polygon(...r).fillColor(mode === "faces" ? FACE_FILLS[i % FACE_FILLS.length] : "#f8fafc").fill();
  });
  for (const e of metrics.edges) {
    const a = P(e.a);
    const b = P(e.b);
    doc.moveTo(a[0], a[1]).lineTo(b[0], b[1]).strokeColor(EDGE_COLOR[e.type]).lineWidth(mode === "lengths" ? 2 : 1.2).stroke();
  }
  drawElements(doc, metrics, P, false);
  if (mode === "lengths") {
    drawEdgeLabels(doc, metrics, P, Math.max(6, Math.min(9, s * 0.45)), 14);
  } else {
    for (const fm of metrics.faces) {
      const face = model.faces.find((x) => x.id === fm.id)!;
      const c = f(loc(fm.centroid));
      const dv = downVector(face.azimuthDeg);
      const L = Math.min(28, Math.max(14, s * 1.6));
      if (face.pitchDeg >= 2) {
        const ax = c[0] + dv[0] * L * 0.2;
        const ay = c[1] - dv[1] * L * 0.2 + 16;
        const bx = ax + dv[0] * L;
        const by = ay - dv[1] * L;
        doc.moveTo(ax, ay).lineTo(bx, by).strokeColor("#374151").lineWidth(1).stroke();
        const h = 5;
        const ang = Math.atan2(by - ay, bx - ax);
        doc
          .moveTo(bx, by)
          .lineTo(bx - h * Math.cos(ang - 0.4), by - h * Math.sin(ang - 0.4))
          .lineTo(bx - h * Math.cos(ang + 0.4), by - h * Math.sin(ang + 0.4))
          .closePath()
          .fillColor("#374151")
          .fill();
      }
      doc.fillColor("#111").font(fontsInUse.bold).fontSize(10).text(String(fm.index), c[0] - 20, c[1] - 22, { width: 40, align: "center" });
      doc.font(fontsInUse.reg).fontSize(7.5).text(`${nf(fm.area, 1)} m²`, c[0] - 30, c[1] - 10, { width: 60, align: "center" });
      doc.text(`${nf(fm.pitchDeg, 0)}° · ${nf(fm.pitchPct, 0)} % · ${orientationLabel(fm.azimuthDeg)}`, c[0] - 40, c[1] - 1, { width: 80, align: "center" });
    }
  }
  scaleBar(doc, box.x + 4, box.y + box.h - 16, s);
  northArrow(doc, box.x + box.w - 16, box.y + 4);
  doc.restore();
}

/** Cheminées, fenêtres de toit, lucarnes (emprise + numéro) */
function drawElements(doc: PDFKit.PDFDocument, metrics: RoofMetrics, P: (p: LonLat) => XY, onPhoto: boolean) {
  for (const el of metrics.elements) {
    const color = ELEMENT_TYPES.find((x) => x.type === el.type)!.color;
    const r = el.ring.map(P);
    doc.polygon(...r).fillColor(color).fillOpacity(onPhoto ? 0.75 : 0.85).fill();
    doc.fillOpacity(1).polygon(...r).lineWidth(0.8).strokeColor("#ffffff").stroke();
    const cx = r.reduce((a, p) => a + p[0], 0) / r.length;
    const cy = r.reduce((a, p) => a + p[1], 0) / r.length;
    const tag = `${el.type === "cheminee" ? "C" : el.type === "chassis" ? "F" : "L"}${el.index}`;
    doc.font(fontsInUse.bold).fontSize(6.5);
    const tw = doc.widthOfString(tag);
    doc.roundedRect(cx + 5, cy - 11, tw + 5, 9, 2).fillColor("#ffffff").fill();
    doc.fillColor(color).text(tag, cx + 7.5, cy - 9.5, { lineBreak: false });
  }
}

/** Étiquette de longueur au milieu de chaque arête, dans l'axe de l'arête. */
function drawEdgeLabels(doc: PDFKit.PDFDocument, metrics: RoofMetrics, P: (p: LonLat) => XY, fs: number, minPx: number) {
  doc.font(fontsInUse.bold).fontSize(fs);
  for (const e of metrics.edges) {
    if (e.length < 0.3) continue;
    const a = P(e.a);
    const b = P(e.b);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < minPx) continue;
    const label = nf(e.length, 2);
    const tw = doc.widthOfString(label);
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    doc.save();
    doc.rotate(ang, { origin: [mx, my] });
    doc
      .roundedRect(mx - tw / 2 - 2.5, my - fs / 2 - 1.8, tw + 5, fs + 3.6, 1.5)
      .lineWidth(0.8)
      .fillColor("#ffffff")
      .strokeColor(EDGE_COLOR[e.type])
      .fillOpacity(0.93)
      .fillAndStroke();
    doc.fillOpacity(1).fillColor("#111111").text(label, mx - tw / 2, my - fs / 2 + 0.6, { lineBreak: false });
    doc.restore();
  }
}

function table(
  doc: PDFKit.PDFDocument,
  y: number,
  head: string[],
  widths: number[],
  rows: string[][],
  foot: string[] | null,
  newPage?: () => number,
  highlightCol = -1,
): number {
  const rowH = 17;
  const drawRow = (cells: string[], yy: number, opts: { bold?: boolean; fill?: string; color?: string }) => {
    let x = M;
    if (opts.fill) doc.rect(M, yy, widths.reduce((a, b) => a + b, 0), rowH).fillColor(opts.fill).fill();
    if (highlightCol > 0 && !opts.color) {
      const hx = M + widths.slice(0, highlightCol).reduce((a, b) => a + b, 0);
      doc.rect(hx, yy, widths[highlightCol], rowH).fillColor("#d6eef6").fill();
    }
    doc.font(opts.bold ? fontsInUse.bold : fontsInUse.reg).fontSize(8.5).fillColor(opts.color ?? "#111");
    cells.forEach((c, i) => {
      doc.text(c, x + 5, yy + 4.5, { width: widths[i] - 10, lineBreak: false, ellipsis: true });
      x += widths[i];
    });
  };
  drawRow(head, y, { bold: true, fill: BRAND, color: "#ffffff" });
  y += rowH;
  rows.forEach((r, i) => {
    if (y > A4.h - 80) {
      if (newPage) {
        y = newPage();
        drawRow(head, y, { bold: true, fill: BRAND, color: "#ffffff" });
        y += rowH;
      }
    }
    drawRow(r, y, { fill: i % 2 ? "#f8fafc" : undefined });
    y += rowH;
  });
  if (foot) {
    drawRow(foot, y, { bold: true, fill: "#e8eef6" });
    y += rowH;
  }
  return y;
}
