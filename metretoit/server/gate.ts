// Accès verrouillé au site entier (phase de test).
// Activé dès qu'un identifiant est défini en SSH :  npm run acces -- ridha
// Désactivé avec :                                   npm run acces -- --off
import type { Request, Response, NextFunction } from "express";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { getSetting } from "./db";
import { authSecret, loginThrottle, loginFailed, loginOk } from "./auth";

const COOKIE = "mt_acces";
const MAX_AGE_S = 30 * 24 * 3600;

function gateConfig(): { user: string; hash: string } | null {
  const user = getSetting("gate_user");
  const hash = getSetting("gate_hash");
  return user && hash ? { user, hash } : null;
}

// chemins accessibles sans être passé par la page d'accès
const OPEN = new Set(["/acces", "/api/health", "/api/billing/webhook", "/img/hero-re.jpg", "/favicon.svg", "/favicon.ico", "/favicon-32.png", "/apple-touch-icon.png"]);

function readCookie(req: Request): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

async function hasAccess(req: Request, cfg: { user: string; hash: string }): Promise<boolean> {
  const t = readCookie(req);
  if (!t) return false;
  try {
    const { payload } = await jwtVerify(t, authSecret());
    // changer le mot de passe invalide les accès déjà ouverts
    return payload.sub === cfg.user && payload.v === cfg.hash.slice(-12);
  } catch {
    return false;
  }
}

const safeNext = (n: unknown) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/acces") ? n : "/");

export async function gateMiddleware(req: Request, res: Response, next: NextFunction) {
  const cfg = gateConfig();
  if (!cfg || OPEN.has(req.path)) return next();
  if (await hasAccess(req, cfg)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Accès protégé", gate: true });
  res.redirect(302, `/acces?next=${encodeURIComponent(req.originalUrl)}`);
}

export async function gateGet(req: Request, res: Response) {
  if (!gateConfig()) return res.redirect(302, "/");
  sendPage(res, "", safeNext(req.query.next));
}

export async function gatePost(req: Request, res: Response) {
  const cfg = gateConfig();
  const nextUrl = safeNext(req.body?.next);
  if (!cfg) return res.redirect(302, nextUrl);
  const key = `acces|${req.ip}`;
  if (!loginThrottle(key)) return sendPage(res, "Trop de tentatives. Réessayez dans 15 minutes.", nextUrl, 429);
  const user = String(req.body?.identifiant ?? "").trim().toLowerCase();
  const pass = String(req.body?.motdepasse ?? "");
  if (user !== cfg.user.toLowerCase() || !(await bcrypt.compare(pass, cfg.hash))) {
    loginFailed(key);
    return sendPage(res, "Identifiant ou mot de passe incorrect.", nextUrl, 401);
  }
  loginOk(key);
  const token = await new SignJWT({ sub: cfg.user, v: cfg.hash.slice(-12) })
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
  res.redirect(303, nextUrl);
}

// ---------- page HTML autonome (aucune dépendance au reste du site) ----------
let fontCss = "";
try {
  const req = createRequire(import.meta.url);
  const f = (w: number) =>
    readFileSync(req.resolve(`@fontsource/montserrat/files/montserrat-latin-${w}-normal.woff2`)).toString("base64");
  fontCss = [400, 600, 700]
    .map((w) => `@font-face{font-family:Montserrat;font-weight:${w};font-display:swap;src:url(data:font/woff2;base64,${f(w)}) format("woff2")}`)
    .join("");
} catch {
  /* police système en repli */
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function sendPage(res: Response, error: string, nextUrl: string, status = 200) {
  res.status(status);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0f7ea8">
<title>Accès protégé · MétréToit</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
${fontCss}
:root{--brand:#0f7ea8;--brand2:#0b6a8f;--ink:#1b2b3f;--muted:#6b7684}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font-family:Montserrat,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);
background:#0a2d46 url(/img/hero-re.jpg) center/cover no-repeat fixed;display:flex;flex-direction:column;min-height:100%}
.veil{position:fixed;inset:0;background:linear-gradient(180deg,rgba(7,38,60,.86),rgba(9,52,78,.74) 55%,rgba(7,38,60,.9))}
main{position:relative;flex:1;display:grid;place-items:center;padding:24px 16px}
.brand{display:flex;align-items:center;gap:12px;color:#fff;justify-content:center;margin-bottom:26px}
.brand b{display:flex;flex-direction:column;line-height:.98;font-size:21px;letter-spacing:.02em;font-weight:700}
.card{width:100%;max-width:410px;background:#fff;border-radius:18px;padding:34px 30px 28px;box-shadow:0 30px 80px rgba(0,0,0,.35)}
.lock{width:52px;height:52px;border-radius:50%;background:#e7f3f8;color:var(--brand);display:grid;place-items:center;margin:0 auto 14px}
h1{margin:0;text-align:center;font-size:19px;font-weight:600;letter-spacing:.1em;text-transform:uppercase}
p.sub{margin:8px 0 24px;text-align:center;color:var(--muted);font-size:14px;line-height:1.5}
label{display:block;font-size:13px;font-weight:600;margin:0 0 6px;color:#3b4656}
.field{position:relative;margin-bottom:16px}
input{width:100%;font:inherit;font-size:16px;padding:13px 14px;border:1.5px solid #d5dbe3;border-radius:10px;color:var(--ink);background:#fff;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(15,126,168,.15)}
.eye{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:none;color:var(--muted);cursor:pointer;padding:6px;font:inherit;font-size:12px;font-weight:600}
button.go{width:100%;margin-top:6px;border:0;border-radius:999px;background:var(--brand);color:#fff;font:inherit;font-weight:600;font-size:16px;padding:14px;cursor:pointer;transition:background .15s,transform .05s}
button.go:hover{background:var(--brand2)}button.go:active{transform:translateY(1px)}
.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:10px;padding:10px 12px;font-size:14px;margin-bottom:16px}
footer{position:relative;text-align:center;color:rgba(255,255,255,.7);font-size:12px;padding:18px}
</style>
</head>
<body>
<div class="veil"></div>
<main>
<div style="width:100%;max-width:410px">
<div class="brand">
<svg width="50" height="50" viewBox="0 0 64 64" fill="none" aria-hidden="true"><circle cx="32" cy="32" r="28.5" stroke="currentColor" stroke-width="4"/><path d="M15 35 32 19.5 49 35" stroke="currentColor" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 45.5h28" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><path d="M18 40.5v5M25 43v2.5M32 41v4.5M39 43v2.5M46 40.5v5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>
<b><span>MÉTRÉ</span><span>TOIT</span></b>
</div>
<form class="card" method="post" action="/acces" autocomplete="on">
<div class="lock"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg></div>
<h1>Accès protégé</h1>
<p class="sub">Site en phase de test.<br>Saisissez vos identifiants pour continuer.</p>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<input type="hidden" name="next" value="${esc(nextUrl)}">
<div class="field"><label for="u">Identifiant</label><input id="u" name="identifiant" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></div>
<label for="p">Mot de passe</label>
<div class="field"><input id="p" name="motdepasse" type="password" autocomplete="current-password" required style="padding-right:84px"><button type="button" class="eye" onclick="var i=document.getElementById('p');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'Afficher':'Masquer'">Afficher</button></div>
<button class="go" type="submit">Accéder au site</button>
</form>
</div>
</main>
<footer>© ${new Date().getFullYear()} MétréToit · Vue aérienne © IGN</footer>
</body>
</html>`);
}
