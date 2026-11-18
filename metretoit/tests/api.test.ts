import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "metretoit-test-"));
process.env.IGN_BASE_URL = "http://127.0.0.1:9"; // hors ligne : on teste l'API sans réseau

let server: Server;
let base = "";

class Client {
  cookie = "";
  async req(path: string, body?: unknown, method?: string) {
    const r = await fetch(base + path, {
      method: method ?? (body !== undefined ? "POST" : "GET"),
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const ct = r.headers.get("content-type") ?? "";
    return { status: r.status, data: ct.includes("json") ? await r.json() : await r.arrayBuffer() };
  }
}

const O = [-1.37, 46.2];
const sq = (dx: number, dy: number, s = 0.00005) => [
  [O[0] + dx, O[1] + dy],
  [O[0] + dx + s, O[1] + dy],
  [O[0] + dx + s, O[1] + dy + s],
  [O[0] + dx, O[1] + dy + s],
];

beforeAll(async () => {
  const { app } = await import("../server/index");
  await new Promise<void>((res) => {
    server = app.listen(0, () => res());
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server?.close());

describe("API", () => {
  const a = new Client();
  const b = new Client();
  let studyId = "";

  it("inscription, session et validation", async () => {
    expect((await a.req("/api/studies")).status).toBe(401);
    expect((await a.req("/api/auth/register", { orgName: "A", name: "Alice", email: "bad", password: "x" })).status).toBe(400);
    const r = await a.req("/api/auth/register", { orgName: "Couverture A", name: "Alice", email: "alice@a.fr", password: "motdepasse" });
    expect(r.status).toBe(200);
    const me = await a.req("/api/auth/me");
    expect(me.data.user.role).toBe("owner");
    expect(me.data.org.name).toBe("Couverture A");
    expect((await a.req("/api/auth/register", { orgName: "X", name: "X", email: "alice@a.fr", password: "motdepasse" })).status).toBe(400);
  });

  it("connexion : mauvais mot de passe refusé", async () => {
    const c = new Client();
    expect((await c.req("/api/auth/login", { email: "alice@a.fr", password: "faux-mdp" })).status).toBe(401);
    expect((await c.req("/api/auth/login", { email: "alice@a.fr", password: "motdepasse" })).status).toBe(200);
  });

  it("étude manuelle, enregistrement du modèle, surfaces", async () => {
    const r = await a.req("/api/studies", { lon: O[0], lat: O[1], address: "1 rue du Test", manual: true });
    expect(r.status).toBe(200);
    studyId = r.data.id;
    const model = { ...r.data.model, faces: [{ id: "f1", ring: sq(0, 0), pitchDeg: 30, azimuthDeg: 180 }] };
    const u = await a.req(`/api/studies/${studyId}`, { model, clientName: "M. Dupont" }, "PUT");
    expect(u.status).toBe(200);
    expect(u.data.faceCount).toBe(1);
    expect(u.data.totalArea).toBeGreaterThan(20);
    expect(u.data.edited).toBe(true);
    // modèle invalide refusé
    const bad = await a.req(`/api/studies/${studyId}`, { model: { ...model, faces: [{ ring: [[0, 0]], pitchDeg: 30, azimuthDeg: 0 }] } }, "PUT");
    expect(bad.status).toBe(400);
  });

  it("rapport PDF + historique", async () => {
    const r = await a.req(`/api/studies/${studyId}/reports`, undefined, "POST");
    expect(r.status).toBe(200);
    expect(r.data.number).toMatch(/^MT-\d{4}-0001$/);
    const list = await a.req("/api/reports");
    expect(list.data.length).toBe(1);
    const pdf = await a.req(`/api/reports/${r.data.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(Buffer.from(pdf.data as ArrayBuffer).subarray(0, 4).toString()).toBe("%PDF");
  }, 30000);

  it("cloisonnement entre entreprises", async () => {
    await b.req("/api/auth/register", { orgName: "Couverture B", name: "Bob", email: "bob@b.fr", password: "motdepasse" });
    expect((await b.req(`/api/studies/${studyId}`)).status).toBe(404);
    expect((await b.req("/api/studies")).data.length).toBe(0);
    expect((await b.req("/api/reports")).data.length).toBe(0);
  });

  it("utilisateurs : seul le responsable gère l'équipe", async () => {
    const r = await a.req("/api/org/members", { name: "Paul", email: "paul@a.fr", password: "motdepasse" });
    expect(r.status).toBe(200);
    const p = new Client();
    await p.req("/api/auth/login", { email: "paul@a.fr", password: "motdepasse" });
    expect((await p.req("/api/studies")).data.length).toBe(1);
    expect((await p.req("/api/org", { name: "Pirate" }, "PUT")).status).toBe(403);
  });

  it("logo : PNG accepté, autre format refusé", async () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    expect((await a.req("/api/org/logo", { dataUrl: png }, "PUT")).status).toBe(200);
    expect((await a.req("/api/org/logo", { dataUrl: "data:text/html;base64,PGI+" }, "PUT")).status).toBe(400);
    expect((await a.req("/api/auth/me")).data.org.hasLogo).toBe(true);
  });

  it("quota d'essai quand les abonnements sont activés", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_PRICE_ID = "price_x";
    const { logUsage } = await import("../server/db");
    const me = (await b.req("/api/auth/me")).data;
    for (let i = 0; i < 5; i++) logUsage(me.user.orgId, "analysis");
    const r = await b.req("/api/studies", { lon: O[0], lat: O[1], address: "x" });
    expect(r.status).toBe(402);
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID;
  });
});
