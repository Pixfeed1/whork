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
  computeMetrics,
  downVector,
  orientationLabel,
} from "../../shared/roof";
import { ignOrtho, toL93 } from "../providers/ign";

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
  logo?: Buffer | null;
  logo_mime?: string | null;
}

export interface ReportInput {
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
const BRAND = "#1f3a5f";
const MUTED = "#6b7280";
const FACE_FILLS = ["#fde68a", "#bfdbfe", "#bbf7d0", "#fecaca", "#ddd6fe", "#fed7aa", "#a5f3fc", "#fbcfe8", "#d9f99d", "#e5e7eb"];

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
  doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(18).text("Rapport de métrage de toiture", M, y);
  y += 26;
  doc.fillColor("#111").font("Helvetica").fontSize(10.5);
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
  const imgBox = { x: M, y, w: A4.w - 2 * M, h: 300 };
  await drawAerial(doc, input.model, metrics, imgBox, allPts);
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
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(label, x + 8, y + 8, { width: tw - 16 });
    doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(14).text(val, x + 8, y + 26, { width: tw - 16 });
  });
  y += 66;

  // linéaires
  doc.fillColor("#111").font("Helvetica-Bold").fontSize(11).text("Linéaires", M, y);
  y += 16;
  const lin = EDGE_TYPES.filter((e) => t.lengths[e.type] > 0.005);
  const colW = (A4.w - 2 * M) / 2;
  lin.forEach((e, i) => {
    const x = M + (i % 2) * colW;
    const yy = y + Math.floor(i / 2) * 18;
    doc.rect(x, yy + 3, 14, 4).fillColor(e.color).fill();
    doc.fillColor("#111").font("Helvetica").fontSize(10).text(e.label, x + 22, yy, { width: colW - 120 });
    doc.font("Helvetica-Bold").text(`${nf(t.lengths[e.type])} ml`, x + colW - 110, yy, { width: 90, align: "right" });
  });
  y += Math.ceil(lin.length / 2) * 18 + 8;
  const warn = (input.model.meta?.warnings as string[] | undefined) ?? [];
  const src = sourceText(input.model);
  doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(src, M, Math.min(y, A4.h - 95), { width: A4.w - 2 * M });
  if (warn.length) doc.fillColor("#b45309").text(warn.join(" "), { width: A4.w - 2 * M });

  // ---------- page 2 : plan des longueurs ----------
  doc.addPage();
  header(doc, input);
  doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(14).text("Plan des longueurs (vraie grandeur, en mètres)", M, 140);
  drawPlan(doc, input.model, metrics, frame, { x: M, y: 165, w: A4.w - 2 * M, h: 540 }, "lengths");
  legend(doc, A4.h - 120, metrics);

  // ---------- page 3 : plan des pans ----------
  doc.addPage();
  header(doc, input);
  doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(14).text("Plan des pans : surfaces et pentes", M, 140);
  drawPlan(doc, input.model, metrics, frame, { x: M, y: 165, w: A4.w - 2 * M, h: 540 }, "faces");
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(
    "Chaque pan est numéroté ; la flèche indique le sens de la pente (écoulement de l'eau). Surfaces en vraie grandeur (rampant).",
    M,
    A4.h - 115,
    { width: A4.w - 2 * M },
  );

  // ---------- page 4 : tableaux ----------
  doc.addPage();
  header(doc, input);
  y = 140;
  doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(14).text("Tableau récapitulatif des métrés", M, y);
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
  doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(12).text("Linéaires par type", M, y);
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
  if (input.notes) {
    if (y > A4.h - 160) {
      doc.addPage();
      header(doc, input);
      y = 140;
    }
    doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(12).text("Observations", M, y);
    doc.fillColor("#111").font("Helvetica").fontSize(9.5).text(input.notes, M, y + 18, { width: A4.w - 2 * M });
    y = doc.y + 14;
  }

  // détail des arêtes
  doc.addPage();
  header(doc, input);
  y = 140;
  doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(12).text("Détail des arêtes", M, y);
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
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text("* type d'arête corrigé manuellement", M, doc.y + 6);

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
    doc.fillColor(MUTED).font("Helvetica").fontSize(7).text(footer, M, fy + 6, { width: A4.w - 2 * M - 80, lineBreak: true, height: 30 });
    doc.text(`${input.number} · page ${i + 1}/${range.count}`, A4.w - M - 120, fy + 6, { width: 120, align: "right" });
  }
  doc.end();
  return done;
}

function sourceText(model: RoofModel): string {
  const m = model.meta ?? {};
  const parts: string[] = [];
  if (m.dsmSource) parts.push(`Relevé 3D : ${m.dsmSource}`);
  if (m.imageryDate) parts.push(`date des images : ${m.imageryDate}`);
  parts.push("Orthophotographie : IGN (Géoplateforme)");
  if ((m.diagnostics as any)?.confidence) parts.push(`indice de confiance de la détection automatique : ${(m.diagnostics as any).confidence}`);
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
      doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(16).text(o.name, lx, 40, { width: 260 });
    }
  } else {
    doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(16).text(o.name, lx, 40, { width: 260 });
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
  doc.fillColor("#111").font("Helvetica-Bold").fontSize(9).text(lines[0] ?? "", A4.w - M - 220, 26, { width: 220, align: "right" });
  doc.font("Helvetica").fontSize(8).fillColor(MUTED);
  for (const l of lines.slice(1)) doc.text(String(l), { width: 220, align: "right" });
  doc.moveTo(M, 118).lineTo(A4.w - M, 118).strokeColor("#e5e7eb").lineWidth(0.8).stroke();
}

function legend(doc: PDFKit.PDFDocument, y: number, metrics: RoofMetrics) {
  const used = EDGE_TYPES.filter((e) => metrics.totals.lengths[e.type] > 0.005);
  let x = M;
  doc.font("Helvetica").fontSize(8.5);
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
  doc.fillColor(c).font("Helvetica-Bold").fontSize(9).text("N", x - 4, y + 18, { lineBreak: false });
  doc.restore();
}

function scaleBar(doc: PDFKit.PDFDocument, x: number, y: number, s: number, light = false) {
  const candidates = [1, 2, 5, 10, 20, 50];
  const m = candidates.find((c) => c * s > 50) ?? 50;
  const c = light ? "#ffffff" : "#111111";
  doc.save();
  doc.rect(x, y, m * s, 4).fillColor(c).fill();
  doc.fillColor(c).font("Helvetica").fontSize(8).text(`${m} m`, x, y + 6, { lineBreak: false });
  doc.restore();
}

async function drawAerial(doc: PDFKit.PDFDocument, model: RoofModel, metrics: RoofMetrics, box: Box, pts: LonLat[]) {
  // emprise Lambert-93 au ratio de la boîte
  const l93 = pts.map((p) => toL93(p));
  let x0 = Math.min(...l93.map((p) => p[0]));
  let x1 = Math.max(...l93.map((p) => p[0]));
  let y0 = Math.min(...l93.map((p) => p[1]));
  let y1 = Math.max(...l93.map((p) => p[1]));
  const pad = Math.max(6, 0.25 * Math.max(x1 - x0, y1 - y0));
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
  for (const fm of metrics.faces) {
    const c = f(fm.centroid);
    doc.circle(c[0], c[1], 8).fillColor("#ffffff").fill();
    doc.fillColor("#111").font("Helvetica-Bold").fontSize(8).text(String(fm.index), c[0] - 8, c[1] - 3.5, { width: 16, align: "center" });
  }
  const s = box.w / (x1 - x0);
  scaleBar(doc, box.x + 12, box.y + box.h - 22, s, hasImage);
  northArrow(doc, box.x + box.w - 20, box.y + 10, hasImage);
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
  if (mode === "lengths") {
    const fs = Math.max(6, Math.min(9, s * 0.45));
    doc.font("Helvetica").fontSize(fs);
    for (const e of metrics.edges) {
      if (e.length < 0.3) continue;
      const a = P(e.a);
      const b = P(e.b);
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (segLen < 14) continue;
      const label = nf(e.length, 2);
      const tw = doc.widthOfString(label);
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      if (ang > 90) ang -= 180;
      if (ang < -90) ang += 180;
      doc.save();
      doc.rotate(ang, { origin: [mx, my] });
      doc.rect(mx - tw / 2 - 2, my - fs / 2 - 1.5, tw + 4, fs + 3).fillColor("#ffffff").fillOpacity(0.9).fill();
      doc.fillOpacity(1).fillColor(EDGE_COLOR[e.type]).text(label, mx - tw / 2, my - fs / 2 + 0.5, { lineBreak: false });
      doc.restore();
    }
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
      doc.fillColor("#111").font("Helvetica-Bold").fontSize(10).text(String(fm.index), c[0] - 20, c[1] - 22, { width: 40, align: "center" });
      doc.font("Helvetica").fontSize(7.5).text(`${nf(fm.area, 1)} m²`, c[0] - 30, c[1] - 10, { width: 60, align: "center" });
      doc.text(`${nf(fm.pitchDeg, 0)}° · ${nf(fm.pitchPct, 0)} % · ${orientationLabel(fm.azimuthDeg)}`, c[0] - 40, c[1] - 1, { width: 80, align: "center" });
    }
  }
  scaleBar(doc, box.x + 4, box.y + box.h - 16, s);
  northArrow(doc, box.x + box.w - 16, box.y + 4);
  doc.restore();
}

function table(
  doc: PDFKit.PDFDocument,
  y: number,
  head: string[],
  widths: number[],
  rows: string[][],
  foot: string[] | null,
  newPage?: () => number,
): number {
  const rowH = 17;
  const drawRow = (cells: string[], yy: number, opts: { bold?: boolean; fill?: string; color?: string }) => {
    let x = M;
    if (opts.fill) doc.rect(M, yy, widths.reduce((a, b) => a + b, 0), rowH).fillColor(opts.fill).fill();
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(opts.color ?? "#111");
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
