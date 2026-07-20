#!/usr/bin/env python3
# Auth + interface d'administration (stdlib uniquement).
#
# Cote consultant :
#   - GET  /login  / POST /login  : connexion
#   - GET  /        : portail personnel (bouton "Ouvrir mon navigateur")
#   - GET  /verify  : cible forward_auth (isolation par poste)
#   - GET  /logout
# Cote admin (ADMIN_USER / ADMIN_PASSWORD dans .env) :
#   - GET  /admin           : tableau de bord (liste des comptes)
#   - POST /admin/add       : creer un compte (nom + mot de passe)
#   - POST /admin/delete    : supprimer un compte
#
# Les comptes sont stockes dans users.json. Un synchroniseur cote serveur
# (hors web) cree/supprime les postes (conteneurs) pour coller aux comptes.

import os, json, hmac, hashlib, time, html, tempfile, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

SECRET = os.environ.get("SESSION_SECRET", "change-me").encode()
USERS_PATH = os.environ.get("USERS_PATH", "/app/users.json")
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
TTL = 8 * 3600
COOKIE = "talens_session"
NAME_RE = re.compile(r"^[a-zA-Z0-9._-]{2,32}$")


def load_users():
    try:
        with open(USERS_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def save_users(users):
    d = os.path.dirname(USERS_PATH) or "."
    fd, tmp = tempfile.mkstemp(dir=d)
    with os.fdopen(fd, "w") as f:
        json.dump(users, f, indent=2, ensure_ascii=False)
    os.replace(tmp, USERS_PATH)


def next_seat(users):
    used = {int(r.get("seat", 0)) for r in users.values()}
    s = 1
    while s in used:
        s += 1
    return s


def sign(user, exp):
    sig = hmac.new(SECRET, ("%s|%d" % (user, exp)).encode(), hashlib.sha256).hexdigest()
    return "%s|%d|%s" % (user, exp, sig)


def token_user(token):
    try:
        user, exp_s, sig = token.split("|", 2)
        exp = int(exp_s)
        if exp < time.time():
            return None
        expected = hmac.new(SECRET, ("%s|%d" % (user, exp)).encode(), hashlib.sha256).hexdigest()
        if hmac.compare_digest(sig, expected):
            return user
    except Exception:
        pass
    return None


def cookie_token(headers):
    for part in headers.get("Cookie", "").split(";"):
        part = part.strip()
        if part.startswith(COOKIE + "="):
            return part[len(COOKIE) + 1:]
    return ""


HEAD = """<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>%s</title>
<style>
:root{--ink:#1d2430;--muted:#5b6472;--line:#d8dde4;--accent:#0f5fbe;--ok:#1a7f4b;--ko:#b3261e;--bg:#f6f7f9;}
*{box-sizing:border-box;}
body{margin:0;min-height:100vh;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);
background:linear-gradient(135deg,#eef4fc 0%%,#f6f7f9 60%%);}
.center{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:34px;
width:100%%;max-width:420px;box-shadow:0 10px 40px rgba(20,40,80,.08);}
.wrap{max-width:820px;margin:0 auto;padding:34px 20px;}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px;}
.logo{width:34px;height:34px;border-radius:8px;background:var(--accent);display:flex;
align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px;}
h1{font-size:20px;margin:0;}
p.sub{color:var(--muted);font-size:13.5px;margin:6px 0 22px;line-height:1.5;}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px;}
input{width:100%%;padding:11px 13px;border:1px solid var(--line);border-radius:8px;font-size:14px;font-family:inherit;}
input:focus{outline:2px solid var(--accent);border-color:var(--accent);}
button,a.btn{display:inline-block;text-align:center;text-decoration:none;background:var(--accent);
color:#fff;border:none;border-radius:8px;padding:11px 16px;font-size:14px;font-weight:600;cursor:pointer;}
button.block{display:block;width:100%%;margin-top:20px;padding:13px;}
button:hover,a.btn:hover{filter:brightness(1.08);}
button.danger{background:#fff;color:var(--ko);border:1px solid #f0c4c4;padding:7px 12px;font-size:13px;}
.err{background:#fdecec;color:var(--ko);border:1px solid #f5c6c6;border-radius:8px;padding:9px 12px;font-size:13px;margin-top:16px;}
.foot{margin-top:20px;font-size:11.5px;color:var(--muted);text-align:center;line-height:1.5;}
.foot a,a.link{color:var(--accent);}
.panel{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px 24px;margin-top:18px;}
table{width:100%%;border-collapse:collapse;font-size:14px;}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);}
th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;}
.row2{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;}
.row2>div{flex:1;min-width:160px;}
.dot{width:9px;height:9px;border-radius:50%%;background:var(--ok);display:inline-block;margin-right:6px;}
.topbar{display:flex;justify-content:space-between;align-items:center;}
</style></head><body>"""


def login_page(error=False):
    err = '<div class="err">Identifiants incorrects.</div>' if error else ""
    return (HEAD % "Connexion") + """
<div class="center"><form class="card" method="post" action="/login">
  <div class="brand"><div class="logo">S</div><h1>Espace sourcing</h1></div>
  <p class="sub">Connecte-toi pour ouvrir ton navigateur de sourcing. Chaque acces est personnel.</p>
  %s
  <label for="username">Identifiant</label>
  <input id="username" name="username" type="text" autocomplete="username" autofocus required>
  <label for="password">Mot de passe</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button class="block" type="submit">Se connecter</button>
  <p class="foot">Session securisee. Ne partage pas tes identifiants.</p>
</form></div></body></html>""" % err


def portal_page(user, seat):
    return (HEAD % "Mon espace") + """
<div class="center"><div class="card">
  <div class="brand"><div class="logo">S</div><h1>Bonjour %s</h1></div>
  <p class="sub"><span class="dot"></span>Ton navigateur de sourcing est pret. Clique pour l'ouvrir dans cet onglet. Rien a installer.</p>
  <a class="btn" style="display:block;padding:13px;" href="/s%d/" target="_blank" rel="noopener">Ouvrir mon navigateur</a>
  <p class="foot">Ton poste est personnel et sort sur l'IP fixe de l'equipe.<br><a href="/logout">Se deconnecter</a></p>
</div></div></body></html>""" % (html.escape(user), seat)


def admin_page(users, msg=""):
    rows = ""
    for name in sorted(users):
        seat = users[name].get("seat", "?")
        rows += """<tr><td><b>%s</b></td><td>Poste %s</td>
<td style="text-align:right;"><form method="post" action="/admin/delete" onsubmit="return confirm('Supprimer %s ?');" style="margin:0;">
<input type="hidden" name="username" value="%s"><button class="danger" type="submit">Supprimer</button></form></td></tr>""" % (
            html.escape(name), seat, html.escape(name), html.escape(name))
    if not rows:
        rows = '<tr><td colspan="3" style="color:var(--muted);">Aucun compte pour l\'instant.</td></tr>'
    banner = ('<div class="err" style="background:#eafaf0;color:var(--ok);border-color:#bfe6cd;">%s</div>' % html.escape(msg)) if msg else ""
    return (HEAD % "Administration") + """
<div class="wrap">
  <div class="topbar">
    <div class="brand" style="margin:0;"><div class="logo">S</div><h1>Administration</h1></div>
    <a class="link" href="/logout">Se deconnecter</a>
  </div>
  <p class="sub">Cree un compte par consultant. Chaque compte ouvre automatiquement son propre poste (navigateur), avec la meme IP fixe pour toute l'equipe.</p>
  %s
  <div class="panel">
    <h1 style="font-size:15px;margin:0 0 12px;">Ajouter un consultant</h1>
    <form method="post" action="/admin/add">
      <div class="row2">
        <div><label>Identifiant</label><input name="username" placeholder="ex: jean" required></div>
        <div><label>Mot de passe</label><input name="password" required></div>
        <div style="flex:0;"><button type="submit">Ajouter</button></div>
      </div>
    </form>
  </div>
  <div class="panel">
    <h1 style="font-size:15px;margin:0 0 12px;">Comptes (%d)</h1>
    <table><thead><tr><th>Consultant</th><th>Poste</th><th></th></tr></thead><tbody>%s</tbody></table>
    <p class="foot" style="text-align:left;">Un nouveau poste peut mettre jusqu'a une minute a demarrer apres la creation du compte.</p>
  </div>
</div></body></html>""" % (banner, len(users), rows)


class H(BaseHTTPRequestHandler):
    def _send(self, code, body=None, headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if body is not None:
            data = body.encode("utf-8")
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.end_headers()

    def _form(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        return parse_qs(self.rfile.read(n).decode("utf-8"))

    def _cookie(self, token):
        return "%s=%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Lax" % (COOKIE, token, TTL)

    def do_GET(self):
        path = self.path.split("?")[0]
        user = token_user(cookie_token(self.headers))

        if path == "/verify":
            if not user:
                self._send(302, headers={"Location": "/login"}); return
            fwd = self.headers.get("X-Forwarded-Uri", "/").split("?")[0]
            if fwd.startswith("/s") and len(fwd) > 2 and fwd[2].isdigit():
                if user == ADMIN_USER:
                    self._send(200); return
                seat = load_users().get(user, {}).get("seat")
                self._send(200 if str(seat) == fwd[2] else 403); return
            self._send(200)
        elif path == "/login":
            self._send(200, login_page())
        elif path == "/logout":
            self._send(302, headers={"Set-Cookie": COOKIE + "=; Path=/; Max-Age=0", "Location": "/login"})
        elif path == "/admin":
            if user != ADMIN_USER:
                self._send(302, headers={"Location": "/login"}); return
            self._send(200, admin_page(load_users()))
        elif path in ("/", ""):
            if not user:
                self._send(302, headers={"Location": "/login"}); return
            if user == ADMIN_USER:
                self._send(302, headers={"Location": "/admin"}); return
            seat = load_users().get(user, {}).get("seat", 1)
            self._send(200, portal_page(user, seat))
        else:
            self._send(404)

    def do_POST(self):
        path = self.path.split("?")[0]
        user = token_user(cookie_token(self.headers))

        if path == "/login":
            f = self._form()
            u = f.get("username", [""])[0].strip()
            p = f.get("password", [""])[0]
            if ADMIN_PASSWORD and u == ADMIN_USER and hmac.compare_digest(p, ADMIN_PASSWORD):
                exp = int(time.time()) + TTL
                self._send(302, headers={"Set-Cookie": self._cookie(sign(u, exp)), "Location": "/admin"}); return
            rec = load_users().get(u)
            if rec and p and hmac.compare_digest(p, str(rec.get("password", ""))):
                exp = int(time.time()) + TTL
                self._send(302, headers={"Set-Cookie": self._cookie(sign(u, exp)), "Location": "/"}); return
            self._send(200, login_page(error=True))

        elif path == "/admin/add":
            if user != ADMIN_USER:
                self._send(302, headers={"Location": "/login"}); return
            f = self._form()
            u = f.get("username", [""])[0].strip()
            p = f.get("password", [""])[0]
            users = load_users()
            if not NAME_RE.match(u):
                self._send(200, admin_page(users, "Identifiant invalide (lettres, chiffres, . _ - , 2 a 32 caracteres).")); return
            if u == ADMIN_USER or u in users:
                self._send(200, admin_page(users, "Ce compte existe deja.")); return
            if not p:
                self._send(200, admin_page(users, "Mot de passe requis.")); return
            users[u] = {"password": p, "seat": next_seat(users)}
            save_users(users)
            self._send(302, headers={"Location": "/admin"})

        elif path == "/admin/delete":
            if user != ADMIN_USER:
                self._send(302, headers={"Location": "/login"}); return
            f = self._form()
            u = f.get("username", [""])[0].strip()
            users = load_users()
            if u in users:
                del users[u]
                save_users(users)
            self._send(302, headers={"Location": "/admin"})
        else:
            self._send(404)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 9000), H).serve_forever()
