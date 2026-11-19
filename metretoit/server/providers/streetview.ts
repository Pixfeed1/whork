// Photo Street View d'une façade : on cherche le panorama le plus proche devant la façade,
// on vérifie qu'il la voit bien de face, puis on cadre l'image dessus.
// Nécessite « Street View Static API » autorisée sur la clé Google.
import type { LonLat } from "../../shared/geo";
import { makeFrame, toLocal } from "../../shared/geo";
import type { RoofModel } from "../../shared/roof";
import { type FacadeMetrics, facadeViewpoint } from "../../shared/facades";
import { googleKey } from "./google";

const API = "https://maps.googleapis.com/maps/api/streetview";

export interface StreetViewShot {
  img: Buffer;
  date: string | null;
  panoId: string;
  heading: number;
}

export type StreetViewMiss = { reason: string };

async function metadata(loc: LonLat, radius: number, key: string) {
  const u = new URL(`${API}/metadata`);
  u.searchParams.set("location", `${loc[1]},${loc[0]}`);
  u.searchParams.set("radius", String(radius));
  u.searchParams.set("source", "outdoor");
  u.searchParams.set("key", key);
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  const j = (await r.json().catch(() => ({}))) as any;
  if (j.status === "OK" && j.location) return { panoId: j.pano_id as string, loc: [j.location.lng, j.location.lat] as LonLat, date: (j.date as string) ?? null };
  if (j.status === "REQUEST_DENIED") throw new Error(j.error_message ?? "Street View refusé (API non autorisée sur la clé)");
  return null;
}

export async function facadeStreetView(model: RoofModel, f: FacadeMetrics): Promise<StreetViewShot | StreetViewMiss> {
  const key = googleKey();
  if (!key) return { reason: "Clé Google non configurée" };
  const frame = makeFrame(model.origin[0], model.origin[1]);
  const M = toLocal(frame, f.mid);
  const n = [Math.sin((f.azimuth * Math.PI) / 180), Math.cos((f.azimuth * Math.PI) / 180)];
  let pano: Awaited<ReturnType<typeof metadata>> = null;
  for (const d of [12, 22, 35]) {
    const { probe } = facadeViewpoint(model, f, d);
    const cand = await metadata(probe, 30, key);
    if (!cand) continue;
    const P = toLocal(frame, cand.loc);
    const vx = P[0] - M[0];
    const vy = P[1] - M[1];
    const dist = Math.hypot(vx, vy);
    // le panorama doit être devant la façade (pas derrière le bâtiment ni trop de biais)
    if (dist > 4 && dist < 70 && (vx * n[0] + vy * n[1]) / dist > 0.35) {
      pano = cand;
      break;
    }
  }
  if (!pano) return { reason: "Façade non visible depuis la rue (pas de panorama Street View devant)" };
  const P = toLocal(frame, pano.loc);
  const heading = ((Math.atan2(M[0] - P[0], M[1] - P[1]) * 180) / Math.PI + 360) % 360;
  // champ de vision : largeur angulaire de la façade, avec une marge
  const ang = (q: LonLat) => {
    const l = toLocal(frame, q);
    return Math.atan2(l[0] - P[0], l[1] - P[1]);
  };
  let span = Math.abs(ang(f.a) - ang(f.b));
  if (span > Math.PI) span = 2 * Math.PI - span;
  const fov = Math.round(Math.max(40, Math.min(110, ((span * 180) / Math.PI) * 1.3)));
  const u = new URL(API);
  u.searchParams.set("size", "640x420");
  u.searchParams.set("pano", pano.panoId);
  u.searchParams.set("heading", heading.toFixed(1));
  u.searchParams.set("fov", String(fov));
  u.searchParams.set("pitch", "8");
  u.searchParams.set("source", "outdoor");
  u.searchParams.set("return_error_code", "true");
  u.searchParams.set("key", key);
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { reason: `Image Street View indisponible (HTTP ${r.status})` };
  return { img: Buffer.from(await r.arrayBuffer()), date: pano.date, panoId: pano.panoId, heading };
}
