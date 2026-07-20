#!/usr/bin/env python3
# Service d'authentification multi-utilisateurs (stdlib uniquement).
#
# Chaque consultant a son login et son poste dedie (un navigateur a lui).
#   - GET  /login   : page de connexion stylee
#   - POST /login   : verifie identifiants, pose un cookie de session signe
#   - GET  /verify  : cible du forward_auth Caddy (autorise aussi par poste)
#   - GET  /        : portail personnel (bouton "Ouvrir mon navigateur")
#   - GET  /logout  : deconnexion
#
# Les comptes sont dans users.json : { "jean": {"password":"...","seat":1}, ... }

import os, json, hmac, hashlib, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

SECRET = os.environ.get("SESSION_SECRET", "change-me").encode()
USERS_PATH = os.environ.get("USERS_PATH", "/app/users.json")
TTL = 8 * 3600
COOKIE = "talens_session"


def load_users():
    try:
        with open(USERS_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


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
    raw = headers.get("Cookie", "")
    for part in raw.split(";"):
        part = part.strip()
        if part.startswith(COOKIE + "="):
            return part[len(COOKIE) + 1:]
    return ""


PAGE_HEAD = """<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>%s</title>
<style>
:root{--ink:#1d2430;--muted:#5b6472;--line:#d8dde4;--accent:#0f5fbe;--ok:#1a7f4b;--ko:#b3261e;--bg:#f6f7f9;}
*{box-sizing:border-box;}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);
background:linear-gradient(135deg,#eef4fc 0%%,#f6f7f9 60%%);padding:20px;}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:36px 34px;
width:100%%;max-width:420px;box-shadow:0 10px 40px rgba(20,40,80,.08);}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:20px;}
.logo{width:34px;height:34px;border-radius:8px;background:var(--accent);display:flex;
align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px;}
h1{font-size:19px;margin:0;}
p.sub{color:var(--muted);font-size:13.5px;margin:6px 0 22px;line-height:1.5;}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px;}
input{width:100%%;padding:11px 13px;border:1px solid var(--line);border-radius:8px;font-size:14px;font-family:inherit;}
input:focus{outline:2px solid var(--accent);border-color:var(--accent);}
button,a.btn{display:block;width:100%%;text-align:center;text-decoration:none;margin-top:20px;
background:var(--accent);color:#fff;border:none;border-radius:8px;padding:13px;
font-size:14.5px;font-weight:600;cursor:pointer;}
button:hover,a.btn:hover{filter:brightness(1.08);}
.err{background:#fdecec;color:var(--ko);border:1px solid #f5c6c6;border-radius:8px;
padding:9px 12px;font-size:13px;margin-top:16px;}
.foot{margin-top:20px;font-size:11.5px;color:var(--muted);text-align:center;line-height:1.5;}
.foot a{color:var(--accent);}
.dot{width:9px;height:9px;border-radius:50%%;background:var(--ok);display:inline-block;margin-right:6px;}
</style></head><body>"""


def login_page(error=False):
    err = '<div class="err">Identifiants incorrects.</div>' if error else ""
    return (PAGE_HEAD % "Connexion") + """
<form class="card" method="post" action="/login">
  <div class="brand"><div class="logo">S</div><h1>Espace sourcing</h1></div>
  <p class="sub">Connecte-toi pour ouvrir ton navigateur de sourcing. Chaque acces est personnel.</p>
  %s
  <label for="username">Identifiant</label>
  <input id="username" name="username" type="text" autocomplete="username" autofocus required>
  <label for="password">Mot de passe</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Se connecter</button>
  <p class="foot">Session securisee. Ne partage pas tes identifiants.</p>
</form></body></html>""" % err


def portal_page(user, seat):
    return (PAGE_HEAD % "Mon espace") + """
<div class="card">
  <div class="brand"><div class="logo">S</div><h1>Bonjour %s</h1></div>
  <p class="sub"><span class="dot"></span>Ton navigateur de sourcing est pret. Clique pour l'ouvrir dans cet onglet. Rien a installer.</p>
  <a class="btn" href="/s%d/" target="_blank" rel="noopener">Ouvrir mon navigateur</a>
  <p class="foot">
    Ton poste est personnel et sort sur l'IP fixe de l'equipe.<br>
    <a href="/logout">Se deconnecter</a>
  </p>
</div></body></html>""" % (user, seat)


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

    def do_GET(self):
        path = self.path.split("?")[0]
        user = token_user(cookie_token(self.headers))

        if path == "/verify":
            if not user:
                self._send(302, headers={"Location": "/login"})
                return
            fwd = self.headers.get("X-Forwarded-Uri", "/")
            fpath = fwd.split("?")[0]
            if fpath.startswith("/s") and len(fpath) > 2 and fpath[2].isdigit():
                seat = load_users().get(user, {}).get("seat")
                if str(seat) != fpath[2]:
                    self._send(403)
                    return
            self._send(200)
        elif path == "/login":
            self._send(200, login_page())
        elif path == "/logout":
            self._send(302, headers={"Set-Cookie": COOKIE + "=; Path=/; Max-Age=0", "Location": "/login"})
        elif path == "/" or path == "":
            if not user:
                self._send(302, headers={"Location": "/login"})
                return
            seat = load_users().get(user, {}).get("seat", 1)
            self._send(200, portal_page(user, seat))
        else:
            self._send(404)

    def do_POST(self):
        if self.path.split("?")[0] != "/login":
            self._send(404)
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        u = form.get("username", [""])[0].strip()
        p = form.get("password", [""])[0]
        rec = load_users().get(u)
        if rec and p and hmac.compare_digest(p, str(rec.get("password", ""))):
            exp = int(time.time()) + TTL
            self._send(302, headers={
                "Set-Cookie": "%s=%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Lax" % (COOKIE, sign(u, exp), TTL),
                "Location": "/",
            })
        else:
            self._send(200, login_page(error=True))

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 9000), H).serve_forever()
