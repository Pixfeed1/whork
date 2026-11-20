// Photo satellite Google « Maps Static API » pour le rapport PDF (une image par rapport).
// Sert de remplacement quand les tuiles satellite de la Map Tiles API sont refusées
// (comptes facturés dans l'Espace économique européen). Il faut « Maps Static API » autorisée sur la clé.
import type { LonLat } from "../../shared/geo";
import { googleKey } from "./google";

let status: { ok: boolean; checkedAt: number; error?: string } | null = null;

export async function fetchGoogleStatic(center: LonLat, zoom: number, width: number, height: number): Promise<Buffer | null> {
  const key = googleKey();
  if (!key) return null;
  const u = new URL("https://maps.googleapis.com/maps/api/staticmap");
  u.searchParams.set("center", `${center[1].toFixed(7)},${center[0].toFixed(7)}`);
  u.searchParams.set("zoom", String(zoom));
  u.searchParams.set("size", `${Math.round(width)}x${Math.round(height)}`);
  u.searchParams.set("scale", "2");
  u.searchParams.set("maptype", "satellite");
  u.searchParams.set("format", "png");
  u.searchParams.set("key", key);
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  const ct = r.headers.get("content-type") ?? "";
  if (!r.ok || !ct.startsWith("image/")) {
    status = { ok: false, checkedAt: Date.now(), error: `HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}` };
    console.warn("Google Maps Static :", status.error);
    return null;
  }
  status = { ok: true, checkedAt: Date.now() };
  return Buffer.from(await r.arrayBuffer());
}

/** Maps Static utilisable ? (essai sur une très petite image, résultat gardé 10 minutes) */
export async function googleStaticAvailable(): Promise<boolean> {
  if (!googleKey()) return false;
  if (status && Date.now() - status.checkedAt < 10 * 60_000) return status.ok;
  try {
    return !!(await fetchGoogleStatic([2.3522, 48.8566], 15, 8, 8));
  } catch {
    status = { ok: false, checkedAt: Date.now() };
    return false;
  }
}
