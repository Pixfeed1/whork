import express, { type Request, type Response, type NextFunction } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { one, all, run, uid, now, logUsage } from "./db";
import {
  loadUser,
  requireAuth,
  requireOwner,
  hashPassword,
  checkPassword,
  setSession,
  clearSession,
  loginThrottle,
  loginFailed,
  loginOk,
} from "./auth";
import { ignGeocode, ignReverse, ignBuildings, ignOrtho, toL93 } from "./providers/ign";
import { mailEnabled, sendMail, resetMail } from "./mail";
import { gateMiddleware, gateGet, gatePost } from "./gate";
import { randomBytes, createHash } from "node:crypto";
import { googleKey, googleGeocode } from "./providers/google";
import { googleTilesAvailable, fetchGoogleTile } from "./providers/googleTiles";
import { facadeStreetView } from "./providers/streetview";
import { computeFacades, type FacadeMetrics } from "../shared/facades";
import { analyzeRoof, fitFace, type SourcePref } from "./analysis/pipeline";
import { generateReport } from "./pdf/report";
import { computeMetrics, type RoofModel, type EdgeType, EDGE_TYPES } from "../shared/roof";
import {
  billingEnabled,
  quotaStatus,
  createCheckout,
  createPortal,
  verifyWebhook,
  handleStripeEvent,
} from "./billing";

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// webhook Stripe : corps brut, avant le parseur JSON
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const evt = verifyWebhook(req.body as Buffer, req.header("stripe-signature"));
  if (!evt) return res.status(400).send("signature invalide");
  handleStripeEvent(evt);
  res.json({ received: true });
});

// page d'accès verrouillée (devant tout le site, si un identifiant est défini)
app.get("/acces", gateGet);
app.post("/acces", express.urlencoded({ extended: false, limit: "10kb" }), gatePost);
app.use(gateMiddleware);

app.use(express.json({ limit: "6mb" }));
app.use(loadUser);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

class HttpError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}
const bad = (msg: string) => new HttpError(400, msg);
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const baseUrl = (req: Request) => process.env.PUBLIC_URL ?? `${req.protocol}://${req.get("host")}`;

// ---------------- validation du modèle ----------------
const EDGE_SET = new Set(EDGE_TYPES.map((e) => e.type));
function validLonLat(p: unknown): p is [number, number] {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
}
function sanitizeModel(m: any): RoofModel {
  if (!m || typeof m !== "object") throw bad("Modèle invalide");
  if (!validLonLat(m.origin)) throw bad("Origine invalide");
  if (!Array.isArray(m.faces) || m.faces.length > 400) throw bad("Pans invalides");
  const faces = m.faces.map((f: any) => {
    if (!Array.isArray(f.ring) || f.ring.length < 3 || f.ring.length > 1000 || !f.ring.every(validLonLat))
      throw bad("Contour de pan invalide");
    const pitch = num(f.pitchDeg);
    const az = num(f.azimuthDeg);
    if (!(pitch >= 0 && pitch <= 89) || !Number.isFinite(az)) throw bad("Pente ou orientation invalide");
    return {
      id: str(f.id, 60) || uid(),
      ring: f.ring.map((p: number[]) => [p[0], p[1]]),
      pitchDeg: pitch,
      azimuthDeg: ((az % 360) + 360) % 360,
      plane: f.plane && validLonLat(f.plane.anchor) && Number.isFinite(f.plane.z) ? { anchor: [f.plane.anchor[0], f.plane.anchor[1]], z: f.plane.z } : null,
      source: ["auto", "manual", "google"].includes(f.source) ? f.source : "manual",
    };
  });
  const edgeOverrides: Record<string, EdgeType> = {};
  for (const [k, v] of Object.entries(m.edgeOverrides ?? {})) {
    if (typeof k === "string" && k.length < 200 && EDGE_SET.has(v as EdgeType)) edgeOverrides[k] = v as EdgeType;
  }
  const footprint = Array.isArray(m.footprint) && m.footprint.every(validLonLat) ? m.footprint.slice(0, 2000) : null;
  const ELT = new Set(["cheminee", "chassis", "lucarne"]);
  const elements = (Array.isArray(m.elements) ? m.elements : []).slice(0, 200).flatMap((e: any) => {
    const w = num(e?.width);
    const l = num(e?.length);
    if (!e || !ELT.has(e.type) || !validLonLat(e.center) || !(w > 0 && w <= 30) || !(l > 0 && l <= 30)) return [];
    return [{ id: str(e.id, 60) || uid(), type: e.type, center: [e.center[0], e.center[1]], width: w, length: l, auto: !!e.auto }];
  });
  return {
    version: 1,
    origin: [m.origin[0], m.origin[1]],
    faces,
    edgeOverrides,
    footprint,
    footprintMitoyen:
      footprint && Array.isArray(m.footprintMitoyen) && m.footprintMitoyen.length === footprint.length
        ? m.footprintMitoyen.map((x: unknown) => !!x)
        : null,
    facades: sanitizeFacades(m.facades),
    elements,
    meta: m.meta && typeof m.meta === "object" ? JSON.parse(JSON.stringify(m.meta).slice(0, 50000)) : {},
  };
}

function sanitizeFacades(f: any) {
  if (!f || typeof f !== "object") return null;
  const OT = new Set(["fenetre", "porte_fenetre", "porte", "garage", "baie", "autre"]);
  const clamp = (v: unknown, lo: number, hi: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : null;
  };
  const overrides: Record<string, any> = {};
  for (const [k, v] of Object.entries(f.overrides ?? {}).slice(0, 200)) {
    if (!/^f\d{1,3}$/.test(k) || !v || typeof v !== "object") continue;
    const o: any = v;
    overrides[k] = {
      excluded: o.excluded == null ? null : !!o.excluded,
      eaveHeight: o.eaveHeight == null ? null : clamp(o.eaveHeight, 0.5, 40),
      deductPct: o.deductPct == null ? null : clamp(o.deductPct, 0, 90),
      openings: (Array.isArray(o.openings) ? o.openings : []).slice(0, 100).flatMap((op: any) =>
        OT.has(op?.type)
          ? [
              {
                id: str(op.id, 60) || uid(),
                type: op.type,
                count: Math.round(clamp(op.count, 0, 500) ?? 1),
                width: clamp(op.width, 0.1, 30) ?? 1,
                height: clamp(op.height, 0.1, 30) ?? 1,
              },
            ]
          : [],
      ),
    };
  }
  return { enabled: !!f.enabled, defaultDeductPct: clamp(f.defaultDeductPct, 0, 90) ?? 0, overrides };
}

function studyRow(s: any, withModel = false) {
  return {
    id: s.id,
    title: s.title,
    address: s.address,
    clientName: s.client_name,
    notes: s.notes,
    lon: s.lon,
    lat: s.lat,
    totalArea: s.total_area,
    faceCount: s.face_count,
    edited: !!s.edited,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    reportCount: s.report_count ?? undefined,
    model: withModel ? JSON.parse(s.model) : undefined,
  };
}

function getStudy(req: Request) {
  const s = one<any>("SELECT * FROM studies WHERE id = ? AND org_id = ?", req.params.id, req.user!.orgId);
  if (!s) throw new HttpError(404, "Étude introuvable");
  return s;
}

function orgPublic(o: any) {
  return {
    id: o.id,
    name: o.name,
    address: o.address,
    postcode: o.postcode,
    city: o.city,
    phone: o.phone,
    email: o.email,
    website: o.website,
    siret: o.siret,
    reportFooter: o.report_footer,
    wastePct: o.waste_pct,
    report3d: !!o.report_3d,
    hasLogo: !!o.logo_mime,
    plan: o.plan,
    planStatus: o.plan_status,
  };
}

// ---------------- authentification ----------------
app.post(
  "/api/auth/register",
  wrap(async (req, res) => {
    if (process.env.ALLOW_SIGNUP === "false" && one("SELECT id FROM users LIMIT 1"))
      throw new HttpError(403, "Les inscriptions sont fermées");
    const orgName = str(req.body.orgName, 120);
    const name = str(req.body.name, 120);
    const email = str(req.body.email, 200).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!orgName || !name) throw bad("Nom de l'entreprise et nom requis");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("Adresse e-mail invalide");
    if (password.length < 8) throw bad("Mot de passe : 8 caractères minimum");
    if (one("SELECT id FROM users WHERE email = ?", email)) throw bad("Un compte existe déjà avec cet e-mail");
    const orgId = uid();
    const userId = uid();
    run("INSERT INTO organizations(id, name, email, created_at) VALUES(?, ?, ?, ?)", orgId, orgName, email, now());
    run(
      "INSERT INTO users(id, org_id, email, name, password_hash, role, created_at) VALUES(?, ?, ?, ?, ?, 'owner', ?)",
      userId,
      orgId,
      email,
      name,
      await hashPassword(password),
      now(),
    );
    await setSession(res, userId);
    res.json({ ok: true });
  }),
);

app.post(
  "/api/auth/login",
  wrap(async (req, res) => {
    const email = str(req.body.email, 200).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const key = `${req.ip}|${email}`;
    if (!loginThrottle(key)) throw new HttpError(429, "Trop de tentatives, réessayez dans 15 minutes");
    const u = one<any>("SELECT * FROM users WHERE email = ?", email);
    if (!u || !(await checkPassword(password, u.password_hash))) {
      loginFailed(key);
      throw new HttpError(401, "E-mail ou mot de passe incorrect");
    }
    loginOk(key);
    await setSession(res, u.id);
    res.json({ ok: true });
  }),
);

app.post("/api/auth/logout", (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.user) return res.json({ user: null });
  const org = one<any>("SELECT * FROM organizations WHERE id = ?", req.user.orgId);
  res.json({
    user: req.user,
    org: orgPublic(org),
    features: { google: !!googleKey(), billing: billingEnabled() },
    quota: quotaStatus(req.user.orgId),
  });
});

// ---------------- mot de passe oublié ----------------
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

app.post(
  "/api/auth/forgot",
  wrap(async (req, res) => {
    const email = str(req.body.email, 200).toLowerCase();
    const key = `forgot|${req.ip}`;
    if (!loginThrottle(key)) throw new HttpError(429, "Trop de demandes, réessayez dans 15 minutes");
    loginFailed(key); // compte chaque demande pour limiter les abus
    if (!mailEnabled()) return res.json({ ok: true, mail: false });
    const u = one<any>("SELECT id, name, email FROM users WHERE email = ?", email);
    if (u) {
      const token = randomBytes(32).toString("hex");
      run(
        "INSERT INTO password_resets(token_hash, user_id, expires_at) VALUES(?, ?, ?)",
        sha256(token),
        u.id,
        new Date(Date.now() + 3600_000).toISOString(),
      );
      const link = `${baseUrl(req)}/reinitialiser?token=${token}`;
      const m = resetMail(u.name, link);
      try {
        await sendMail(u.email, "Réinitialisation de votre mot de passe MétréToit", m.text, m.html);
      } catch (e) {
        console.error("Envoi d'e-mail impossible :", e);
        throw new HttpError(502, "L'e-mail n'a pas pu être envoyé. Réessayez plus tard.");
      }
    }
    // même réponse que le compte existe ou non (pas de divulgation)
    res.json({ ok: true, mail: true });
  }),
);

app.post(
  "/api/auth/reset",
  wrap(async (req, res) => {
    const token = str(req.body.token, 200);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (password.length < 8) throw bad("Mot de passe : 8 caractères minimum");
    const r = one<any>("SELECT * FROM password_resets WHERE token_hash = ?", sha256(token));
    if (!r || r.used || r.expires_at < now()) throw bad("Lien invalide ou expiré : refaites une demande");
    run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), r.user_id);
    run("UPDATE password_resets SET used = 1 WHERE user_id = ?", r.user_id);
    await setSession(res, r.user_id);
    res.json({ ok: true });
  }),
);

app.put(
  "/api/auth/password",
  requireAuth,
  wrap(async (req, res) => {
    const u = one<any>("SELECT * FROM users WHERE id = ?", req.user!.id);
    const next = typeof req.body.next === "string" ? req.body.next : "";
    if (!(await checkPassword(String(req.body.current ?? ""), u.password_hash))) throw bad("Mot de passe actuel incorrect");
    if (next.length < 8) throw bad("Nouveau mot de passe : 8 caractères minimum");
    run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(next), u.id);
    res.json({ ok: true });
  }),
);

// ---------------- entreprise ----------------
app.get("/api/org", requireAuth, (req, res) => {
  res.json(orgPublic(one("SELECT * FROM organizations WHERE id = ?", req.user!.orgId)));
});

app.put("/api/org", requireOwner, (req, res) => {
  const b = req.body ?? {};
  const waste = Number(b.wastePct);
  run(
    `UPDATE organizations SET name = ?, address = ?, postcode = ?, city = ?, phone = ?, email = ?, website = ?, siret = ?, report_footer = ?, waste_pct = ?, report_3d = ? WHERE id = ?`,
    str(b.name, 120) || "Mon entreprise",
    str(b.address, 200),
    str(b.postcode, 20),
    str(b.city, 100),
    str(b.phone, 40),
    str(b.email, 200),
    str(b.website, 200),
    str(b.siret, 30),
    str(b.reportFooter, 600),
    Number.isFinite(waste) ? Math.max(0, Math.min(50, waste)) : 10,
    b.report3d ? 1 : 0,
    req.user!.orgId,
  );
  res.json(orgPublic(one("SELECT * FROM organizations WHERE id = ?", req.user!.orgId)));
});

app.put("/api/org/logo", requireOwner, (req, res) => {
  const m = /^data:(image\/(png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl ?? ""));
  if (!m) throw bad("Logo : PNG ou JPEG attendu");
  const buf = Buffer.from(m[3], "base64");
  if (buf.length > 2_000_000) throw bad("Logo trop lourd (2 Mo max)");
  run("UPDATE organizations SET logo = ?, logo_mime = ? WHERE id = ?", buf, m[1], req.user!.orgId);
  res.json({ ok: true });
});

app.delete("/api/org/logo", requireOwner, (req, res) => {
  run("UPDATE organizations SET logo = NULL, logo_mime = NULL WHERE id = ?", req.user!.orgId);
  res.json({ ok: true });
});

app.get("/api/org/logo", requireAuth, (req, res) => {
  const o = one<any>("SELECT logo, logo_mime FROM organizations WHERE id = ?", req.user!.orgId);
  if (!o?.logo) return res.status(404).end();
  res.setHeader("Content-Type", o.logo_mime);
  res.setHeader("Cache-Control", "private, max-age=60");
  res.send(Buffer.from(o.logo));
});

app.get("/api/org/members", requireAuth, (req, res) => {
  res.json(all("SELECT id, name, email, role, created_at AS createdAt FROM users WHERE org_id = ? ORDER BY created_at", req.user!.orgId));
});

app.post(
  "/api/org/members",
  requireOwner,
  wrap(async (req, res) => {
    const name = str(req.body.name, 120);
    const email = str(req.body.email, 200).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const role = req.body.role === "owner" ? "owner" : "member";
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("Nom et e-mail valides requis");
    if (password.length < 8) throw bad("Mot de passe provisoire : 8 caractères minimum");
    if (one("SELECT id FROM users WHERE email = ?", email)) throw bad("Cet e-mail est déjà utilisé");
    const id = uid();
    run(
      "INSERT INTO users(id, org_id, email, name, password_hash, role, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
      id,
      req.user!.orgId,
      email,
      name,
      await hashPassword(password),
      role,
      now(),
    );
    res.json({ id });
  }),
);

app.put(
  "/api/org/members/:id/password",
  requireOwner,
  wrap(async (req, res) => {
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (password.length < 8) throw bad("Mot de passe : 8 caractères minimum");
    const u = one<any>("SELECT id FROM users WHERE id = ? AND org_id = ?", req.params.id, req.user!.orgId);
    if (!u) throw new HttpError(404, "Utilisateur introuvable");
    run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), u.id);
    res.json({ ok: true });
  }),
);

app.delete("/api/org/members/:id", requireOwner, (req, res) => {
  if (req.params.id === req.user!.id) throw bad("Vous ne pouvez pas supprimer votre propre compte");
  run("DELETE FROM users WHERE id = ? AND org_id = ?", req.params.id, req.user!.orgId);
  res.json({ ok: true });
});

// ---------------- géographie ----------------
app.get(
  "/api/geocode",
  requireAuth,
  wrap(async (req, res) => {
    const q = str(req.query.q, 200);
    if (q.length < 3) return res.json([]);
    const nlon = Number(req.query.lon);
    const nlat = Number(req.query.lat);
    const near = Number.isFinite(nlon) && Number.isFinite(nlat) && req.query.lon !== undefined ? { lon: nlon, lat: nlat } : undefined;
    let r = await ignGeocode(q, 6, req.query.autocomplete !== "0", near).catch(() => []);
    if (!r.length && googleKey()) r = await googleGeocode(q).catch(() => []);
    res.json(r);
  }),
);

app.get(
  "/api/reverse",
  requireAuth,
  wrap(async (req, res) => {
    const lon = Number(req.query.lon);
    const lat = Number(req.query.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw bad("Coordonnées invalides");
    res.json({ label: await ignReverse(lon, lat) });
  }),
);

app.get(
  "/api/buildings",
  requireAuth,
  wrap(async (req, res) => {
    const lon = Number(req.query.lon);
    const lat = Number(req.query.lat);
    const r = Math.min(150, Math.max(20, Number(req.query.r) || 80));
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw bad("Coordonnées invalides");
    const dLat = r / 111000;
    const dLon = dLat / Math.cos((lat * Math.PI) / 180);
    const bs = await ignBuildings(lon - dLon, lat - dLat, lon + dLon, lat + dLat).catch(() => []);
    res.json({
      type: "FeatureCollection",
      features: bs.map((b) => ({
        type: "Feature",
        properties: { id: b.id, usage: b.usage, height: b.height },
        geometry: { type: "Polygon", coordinates: [[...b.ring, b.ring[0]]] },
      })),
    });
  }),
);

// ---------------- études ----------------
const parseSource = (v: unknown): SourcePref => (v === "ign" || v === "google" ? v : "auto");
const parsePoints = (v: unknown, fallback: [number, number]): [number, number][] => {
  if (!Array.isArray(v) || !v.length) return [fallback];
  const pts = v.filter(validLonLat).slice(0, 10).map((p) => [p[0], p[1]] as [number, number]);
  return pts.length ? pts : [fallback];
};

function saveModel(id: string, model: RoofModel, edited: boolean) {
  const m = computeMetrics(model);
  run(
    "UPDATE studies SET model = ?, total_area = ?, face_count = ?, edited = ?, updated_at = ? WHERE id = ?",
    JSON.stringify(model),
    m.totals.area,
    m.totals.faceCount,
    edited ? 1 : 0,
    now(),
    id,
  );
}

function checkQuota(orgId: string) {
  const q = quotaStatus(orgId);
  if (!q.allowed)
    throw new HttpError(
      402,
      q.plan === "trial"
        ? `Période d'essai terminée (${q.limit} études). Abonnez-vous pour continuer.`
        : `Quota mensuel atteint (${q.limit} études).`,
    );
}

app.get("/api/studies", requireAuth, (req, res) => {
  const q = str(req.query.q, 100);
  const rows = all<any>(
    `SELECT s.id, s.title, s.address, s.client_name, s.notes, s.lon, s.lat, s.total_area, s.face_count, s.edited, s.created_at, s.updated_at,
       (SELECT COUNT(*) FROM reports r WHERE r.study_id = s.id) AS report_count
     FROM studies s WHERE s.org_id = ? ${q ? "AND (s.address LIKE ? OR s.title LIKE ? OR s.client_name LIKE ?)" : ""}
     ORDER BY s.updated_at DESC LIMIT 500`,
    req.user!.orgId,
    ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []),
  );
  res.json(rows.map((r) => studyRow(r)));
});

app.post(
  "/api/studies",
  requireAuth,
  wrap(async (req, res) => {
    const lon = num(req.body.lon);
    const lat = num(req.body.lat);
    if (!validLonLat([lon, lat])) throw bad("Position invalide");
    checkQuota(req.user!.orgId);
    const address = str(req.body.address, 300) || `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    let model: RoofModel;
    if (req.body.manual) {
      model = { version: 1, origin: [lon, lat], faces: [], edgeOverrides: {}, footprint: null, meta: { warnings: [] } };
    } else {
      model = await analyzeRoof({ points: parsePoints(req.body.points, [lon, lat]), source: parseSource(req.body.source) });
      logUsage(req.user!.orgId, "analysis");
    }
    const id = uid();
    const t = now();
    run(
      `INSERT INTO studies(id, org_id, created_by, title, address, client_name, notes, lon, lat, model, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      req.user!.orgId,
      req.user!.id,
      str(req.body.title, 200),
      address,
      str(req.body.clientName, 200),
      "",
      lon,
      lat,
      JSON.stringify(model),
      t,
      t,
    );
    saveModel(id, model, false);
    res.json(studyRow(one("SELECT * FROM studies WHERE id = ?", id), true));
  }),
);

app.get("/api/studies/:id", requireAuth, (req, res) => {
  res.json(studyRow(getStudy(req), true));
});

app.put("/api/studies/:id", requireAuth, (req, res) => {
  const s = getStudy(req);
  const b = req.body ?? {};
  run(
    "UPDATE studies SET title = ?, address = ?, client_name = ?, notes = ?, updated_at = ? WHERE id = ?",
    b.title !== undefined ? str(b.title, 200) : s.title,
    b.address !== undefined ? str(b.address, 300) || s.address : s.address,
    b.clientName !== undefined ? str(b.clientName, 200) : s.client_name,
    b.notes !== undefined ? str(b.notes, 4000) : s.notes,
    now(),
    s.id,
  );
  if (b.model) saveModel(s.id, sanitizeModel(b.model), true);
  res.json(studyRow(one("SELECT * FROM studies WHERE id = ?", s.id), true));
});

// vignette : photo aérienne IGN + contour des pans (SVG, mis à jour à chaque modification)
const TW = 640;
const TH = 320;
app.get(
  "/api/studies/:id/vignette.svg",
  requireAuth,
  wrap(async (req, res) => {
    const s = getStudy(req);
    const model: RoofModel = JSON.parse(s.model);
    let t = one<any>("SELECT img, bbox FROM thumbs WHERE study_id = ?", s.id);
    if (!t) {
      const pts = model.faces.flatMap((f) => f.ring).concat(model.footprint ?? []);
      const l93 = (pts.length ? pts : [[s.lon, s.lat] as [number, number]]).map((p) => toL93(p));
      const xs = l93.map((p) => p[0]);
      const ys = l93.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const half = Math.max(16, (Math.max(...xs) - Math.min(...xs)) * 0.75, (Math.max(...ys) - Math.min(...ys)) * 1.5);
      const bbox: [number, number, number, number] = [cx - half, cy - half / 2, cx + half, cy + half / 2];
      let img: Buffer;
      try {
        img = await ignOrtho(bbox, TW, TH);
      } catch {
        return res.status(404).end();
      }
      run("INSERT OR REPLACE INTO thumbs(study_id, img, bbox) VALUES(?, ?, ?)", s.id, img, JSON.stringify(bbox));
      t = { img, bbox: JSON.stringify(bbox) };
    }
    const [x0, y0, x1, y1] = JSON.parse(t.bbox) as number[];
    const px = (p: [number, number]) => {
      const q = toL93(p);
      return `${(((q[0] - x0) / (x1 - x0)) * TW).toFixed(1)},${(((y1 - q[1]) / (y1 - y0)) * TH).toFixed(1)}`;
    };
    const polys = model.faces
      .map((f) => `<polygon points="${f.ring.map(px).join(" ")}"/>`)
      .join("");
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "private, max-age=120");
    res.send(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TW} ${TH}" preserveAspectRatio="xMidYMid slice">` +
        `<image href="data:image/jpeg;base64,${Buffer.from(t.img).toString("base64")}" width="${TW}" height="${TH}"/>` +
        `<g fill="rgba(15,126,168,0.22)" stroke="#ffffff" stroke-width="2.4" stroke-linejoin="round">${polys}</g></svg>`,
    );
  }),
);

// ---------------- façades : photo Street View (mise en cache) ----------------
/** renvoie la photo d'une façade, depuis le cache ou Google ; null si indisponible */
export async function streetViewFor(studyId: string, model: RoofModel, f: FacadeMetrics, force = false) {
  const sig = `${f.mid[0].toFixed(5)},${f.mid[1].toFixed(5)},${f.azimuth}`;
  const c = one<any>("SELECT * FROM streetviews WHERE study_id = ? AND fkey = ?", studyId, f.key);
  if (c && c.sig === sig && !force) return { img: c.img ? Buffer.from(c.img) : null, info: JSON.parse(c.info) };
  let shot;
  try {
    shot = await facadeStreetView(model, f);
  } catch (e: any) {
    // API non autorisée : on ne met pas en cache, pour réessayer une fois réglé
    return { img: null, info: { reason: e.message } };
  }
  const info = "img" in shot ? { date: shot.date, heading: shot.heading } : { reason: shot.reason };
  const img = "img" in shot ? shot.img : null;
  run(
    "INSERT OR REPLACE INTO streetviews(study_id, fkey, sig, img, info, created_at) VALUES(?, ?, ?, ?, ?, ?)",
    studyId,
    f.key,
    sig,
    img,
    JSON.stringify(info),
    now(),
  );
  return { img, info };
}

app.get(
  "/api/studies/:id/facades/:key/streetview.jpg",
  requireAuth,
  wrap(async (req, res) => {
    const s = getStudy(req);
    const model: RoofModel = JSON.parse(s.model);
    const f = computeFacades(model).facades.find((x) => x.key === req.params.key);
    if (!f) throw new HttpError(404, "Façade introuvable");
    const r = await streetViewFor(s.id, model, f, req.query.force === "1");
    if (!r.img) return res.status(404).json({ error: r.info.reason ?? "Pas de photo" });
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (r.info.date) res.setHeader("X-Photo-Date", String(r.info.date));
    res.send(r.img);
  }),
);

app.delete("/api/studies/:id", requireAuth, (req, res) => {
  const s = getStudy(req);
  run("DELETE FROM studies WHERE id = ?", s.id);
  res.json({ ok: true });
});

app.post(
  "/api/studies/:id/analyze",
  requireAuth,
  wrap(async (req, res) => {
    const s = getStudy(req);
    checkQuota(req.user!.orgId);
    const overhang = Number(req.body.overhang);
    const prev = JSON.parse(s.model)?.meta ?? {};
    const model = await analyzeRoof({
      points: parsePoints(req.body.points ?? prev.points, [s.lon, s.lat]),
      source: parseSource(req.body.source ?? prev.source),
      overhang: Number.isFinite(overhang) ? Math.max(0, Math.min(2, overhang)) : undefined,
    });
    logUsage(req.user!.orgId, "analysis");
    // les saisies de façades (ouvertures, exclusions) sont conservées
    if (JSON.parse(s.model)?.facades) model.facades = JSON.parse(s.model).facades;
    saveModel(s.id, model, false);
    res.json(studyRow(one("SELECT * FROM studies WHERE id = ?", s.id), true));
  }),
);

app.post(
  "/api/fit-face",
  requireAuth,
  wrap(async (req, res) => {
    const ring = req.body.ring;
    if (!Array.isArray(ring) || ring.length < 3 || ring.length > 500 || !ring.every(validLonLat)) throw bad("Contour invalide");
    const r = await fitFace(ring, parseSource(req.body.source));
    if (!r) throw new HttpError(422, "Pas de relevé 3D exploitable sur cette zone");
    res.json(r);
  }),
);

// ---------------- rapports ----------------
async function nextReportNumber(orgId: string): Promise<string> {
  run("UPDATE organizations SET report_seq = report_seq + 1 WHERE id = ?", orgId);
  const seq = one<any>("SELECT report_seq FROM organizations WHERE id = ?", orgId).report_seq;
  return `MT-${new Date().getFullYear()}-${String(seq).padStart(4, "0")}`;
}

app.post(
  "/api/studies/:id/reports",
  requireAuth,
  wrap(async (req, res) => {
    const s = getStudy(req);
    const model: RoofModel = JSON.parse(s.model);
    if (!model.faces.length) throw bad("Aucun pan : impossible d'établir un rapport");
    const org = one<any>("SELECT * FROM organizations WHERE id = ?", req.user!.orgId);
    const number = await nextReportNumber(org.id);
    // photo du rapport : tuiles Google HD si disponibles, sinon orthophoto IGN
    const tiles = (await googleTilesAvailable().catch(() => false))
      ? {
          fetch: async (z: number, x: number, y: number) => (await fetchGoogleTile(z, x, y))?.body ?? null,
          maxZoom: 21,
          credit: "Google",
        }
      : null;
    // photos Street View des façades retenues
    const facadePhotos = new Map<string, { img: Buffer; date?: string | null }>();
    if (model.facades?.enabled) {
      for (const f of computeFacades(model).facades.filter((x) => !x.excluded)) {
        const r = await streetViewFor(s.id, model, f).catch(() => null);
        if (r?.img) facadePhotos.set(f.key, { img: r.img, date: r.info?.date ?? null });
      }
    }
    const pdf = await generateReport({
      facadePhotos,
      tiles,
      org: { ...org, logo: org.logo ? Buffer.from(org.logo) : null },
      number,
      date: new Date(),
      address: s.address,
      title: s.title,
      clientName: s.client_name,
      notes: s.notes,
      model,
      author: req.user!.name,
    });
    const m = computeMetrics(model);
    const summary = {
      area: m.totals.area,
      faceCount: m.totals.faceCount,
      meanPitchDeg: m.totals.meanPitchDeg,
      lengths: m.totals.lengths,
    };
    const id = uid();
    run(
      "INSERT INTO reports(id, study_id, org_id, created_by, number, address, summary, pdf, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      s.id,
      org.id,
      req.user!.id,
      number,
      s.address,
      JSON.stringify(summary),
      pdf,
      now(),
    );
    logUsage(org.id, "report");
    res.json({ id, number, createdAt: now(), summary });
  }),
);

const reportRow = (r: any) => ({
  id: r.id,
  studyId: r.study_id,
  number: r.number,
  address: r.address,
  summary: JSON.parse(r.summary),
  createdAt: r.created_at,
  author: r.author ?? null,
});

app.get("/api/studies/:id/reports", requireAuth, (req, res) => {
  const s = getStudy(req);
  res.json(
    all<any>(
      "SELECT r.id, r.study_id, r.number, r.address, r.summary, r.created_at, u.name AS author FROM reports r LEFT JOIN users u ON u.id = r.created_by WHERE r.study_id = ? ORDER BY r.created_at DESC",
      s.id,
    ).map(reportRow),
  );
});

app.get("/api/reports", requireAuth, (req, res) => {
  res.json(
    all<any>(
      "SELECT r.id, r.study_id, r.number, r.address, r.summary, r.created_at, u.name AS author FROM reports r LEFT JOIN users u ON u.id = r.created_by WHERE r.org_id = ? ORDER BY r.created_at DESC LIMIT 1000",
      req.user!.orgId,
    ).map(reportRow),
  );
});

app.get("/api/reports/:id/pdf", requireAuth, (req, res) => {
  const r = one<any>("SELECT number, pdf FROM reports WHERE id = ? AND org_id = ?", req.params.id, req.user!.orgId);
  if (!r) return res.status(404).json({ error: "Rapport introuvable" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${req.query.download ? "attachment" : "inline"}; filename="rapport-metrage-${r.number}.pdf"`,
  );
  res.send(Buffer.from(r.pdf));
});

app.delete("/api/reports/:id", requireAuth, (req, res) => {
  run("DELETE FROM reports WHERE id = ? AND org_id = ?", req.params.id, req.user!.orgId);
  res.json({ ok: true });
});

// ---------------- abonnement ----------------
app.get("/api/billing", requireAuth, (req, res) => {
  res.json({ enabled: billingEnabled(), quota: quotaStatus(req.user!.orgId), price: process.env.PRICE_LABEL ?? null });
});
app.post(
  "/api/billing/checkout",
  requireOwner,
  wrap(async (req, res) => {
    if (!billingEnabled()) throw bad("Abonnements non configurés");
    res.json({ url: await createCheckout(req.user!.orgId, req.user!.email, baseUrl(req)) });
  }),
);
app.post(
  "/api/billing/portal",
  requireOwner,
  wrap(async (req, res) => {
    if (!billingEnabled()) throw bad("Abonnements non configurés");
    res.json({ url: await createPortal(req.user!.orgId, baseUrl(req)) });
  }),
);

app.get("/api/public/config", (_req, res) => {
  const e = process.env;
  res.json({
    mail: mailEnabled(),
    legal: {
      company: e.LEGAL_COMPANY ?? "",
      form: e.LEGAL_FORM ?? "",
      capital: e.LEGAL_CAPITAL ?? "",
      address: e.LEGAL_ADDRESS ?? "",
      siret: e.LEGAL_SIRET ?? "",
      rcs: e.LEGAL_RCS ?? "",
      vat: e.LEGAL_VAT ?? "",
      director: e.LEGAL_DIRECTOR ?? "",
      email: e.LEGAL_EMAIL ?? "",
      phone: e.LEGAL_PHONE ?? "",
      host: e.LEGAL_HOST ?? "",
      updated: e.LEGAL_UPDATED ?? "",
    },
  });
});
// ---------------- photos aériennes Google (relais) ----------------
app.get(
  "/api/tiles/google/status",
  requireAuth,
  wrap(async (_req, res) => {
    res.json({ available: await googleTilesAvailable() });
  }),
);
app.get(
  "/api/tiles/google/:z/:x/:y",
  requireAuth,
  wrap(async (req, res) => {
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw bad("Tuile invalide");
    const t = await fetchGoogleTile(z, x, y).catch(() => null);
    if (!t) return res.status(404).end();
    res.setHeader("Content-Type", t.type);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(t.body);
  }),
);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api", (_req, res) => res.status(404).json({ error: "Route inconnue" }));

// ---------------- application web (build) ----------------
const webDir = join(process.cwd(), "dist", "web");
if (existsSync(webDir)) {
  app.use(express.static(webDir, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(webDir, "index.html")));
}

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : err?.type === "entity.too.large" ? 413 : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? "Erreur interne" : err.message });
});

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  // par défaut, écoute uniquement en local (le site public passe par Apache/Nginx en HTTPS)
  const host = process.env.HOST ?? "127.0.0.1";
  app
    .listen(port, host, () => console.log(`MétréToit : http://${host}:${port}`))
    .on("error", (e: NodeJS.ErrnoException) => {
      console.error(e.code === "EADDRINUSE" ? `Le port ${port} est déjà utilisé : une autre instance tourne déjà.` : e);
      process.exit(1);
    });
}
