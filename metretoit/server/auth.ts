import type { Request, Response, NextFunction } from "express";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { one, getSetting, setSetting } from "./db";

const COOKIE = "mt_session";
const MAX_AGE_S = 30 * 24 * 3600;

export function authSecret(): Uint8Array {
  let s = process.env.AUTH_SECRET;
  if (!s) {
    s = getSetting("auth_secret");
    if (!s) {
      s = randomBytes(32).toString("hex");
      setSetting("auth_secret", s);
    }
  }
  return new TextEncoder().encode(s);
}

export interface SessionUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: "owner" | "member";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const checkPassword = (p: string, h: string) => bcrypt.compare(p, h);

export async function setSession(res: Response, userId: string) {
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_S}s`)
    .sign(authSecret());
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    maxAge: MAX_AGE_S * 1000,
    path: "/",
  });
}

export function clearSession(res: Response) {
  res.clearCookie(COOKIE, { path: "/" });
}

function readCookie(req: Request, name: string): string | null {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = readCookie(req, COOKIE);
  if (token) {
    try {
      const { payload } = await jwtVerify(token, authSecret());
      const u = one<any>("SELECT id, org_id, email, name, role FROM users WHERE id = ?", payload.sub);
      if (u) req.user = { id: u.id, orgId: u.org_id, email: u.email, name: u.name, role: u.role };
    } catch {
      /* jeton invalide ou expiré */
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Connexion requise" });
  next();
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Connexion requise" });
  if (req.user.role !== "owner") return res.status(403).json({ error: "Réservé au responsable du compte" });
  next();
}

// limitation simple des tentatives de connexion (mémoire)
const attempts = new Map<string, { n: number; until: number }>();
export function loginThrottle(key: string): boolean {
  const a = attempts.get(key);
  const t = Date.now();
  if (a && a.until > t && a.n >= 8) return false;
  return true;
}
export function loginFailed(key: string) {
  const a = attempts.get(key);
  const t = Date.now();
  if (!a || a.until < t) attempts.set(key, { n: 1, until: t + 15 * 60 * 1000 });
  else a.n++;
}
export function loginOk(key: string) {
  attempts.delete(key);
}
