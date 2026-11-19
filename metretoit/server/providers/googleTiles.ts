// Photos aériennes Google (Map Tiles API, 2D « satellite »), servies par notre serveur :
// la clé n'est jamais exposée au navigateur. Il faut « Map Tiles API » activée sur la clé.
import { googleKey } from "./google";

const BASE = "https://tile.googleapis.com";
let session: { token: string; expiry: number } | null = null;
let status: { ok: boolean; checkedAt: number; error?: string } | null = null;

async function createSession(): Promise<string> {
  const key = googleKey();
  if (!key) throw new Error("Clé Google absente");
  const r = await fetch(`${BASE}/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapType: "satellite", language: "fr-FR", region: "FR" }),
    signal: AbortSignal.timeout(15000),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || !j.session) {
    status = { ok: false, checkedAt: Date.now(), error: j?.error?.message ?? `HTTP ${r.status}` };
    throw new Error(status.error);
  }
  session = { token: j.session, expiry: Number(j.expiry ?? 0) * 1000 || Date.now() + 24 * 3600_000 };
  status = { ok: true, checkedAt: Date.now() };
  return session.token;
}

async function getSession(): Promise<string> {
  if (session && session.expiry - Date.now() > 3600_000) return session.token;
  return createSession();
}

/** Les photos Google sont-elles utilisables ? (résultat mis en cache 10 minutes) */
export async function googleTilesAvailable(): Promise<boolean> {
  if (!googleKey()) return false;
  if (status && Date.now() - status.checkedAt < 10 * 60_000) return status.ok;
  try {
    await getSession();
    return true;
  } catch {
    return false;
  }
}

export async function fetchGoogleTile(z: number, x: number, y: number): Promise<{ body: Buffer; type: string } | null> {
  const key = googleKey();
  if (!key) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await getSession();
    const r = await fetch(`${BASE}/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(tok)}&key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) return { body: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") ?? "image/jpeg" };
    if ((r.status === 400 || r.status === 401 || r.status === 403) && attempt === 0) {
      session = null; // session expirée : on en recrée une
      continue;
    }
    return null;
  }
  return null;
}
