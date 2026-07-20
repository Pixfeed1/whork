#!/usr/bin/env python3
# Petit service d'authentification (stdlib uniquement) :
#   - GET  /login   -> page de connexion stylee (charte extension)
#   - POST /login   -> verifie identifiants, pose un cookie signe, redirige vers /
#   - GET  /verify  -> cible du forward_auth de Caddy (200 si connecte, sinon 302 /login)
#   - GET  /logout  -> efface le cookie
#
# Aucune dependance externe. Identifiants via variables d'environnement.

import os, hmac, hashlib, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs
from http.cookies import SimpleCookie

USER = os.environ.get("PORTAL_USER", "equipe")
PASSWORD = os.environ.get("PORTAL_PASSWORD", "")
SECRET = os.environ.get("SESSION_SECRET", "change-me").encode()
TTL = 8 * 3600  # duree de session : 8 h
COOKIE = "talens_session"


def sign(exp):
    sig = hmac.new(SECRET, f"{USER}|{exp}".encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def valid(token):
    try:
        exp_s, sig = token.split(".", 1)
        exp = int(exp_s)
        if exp < time.time():
            return False
        expected = hmac.new(SECRET, f"{USER}|{exp}".encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, expected)
    except Exception:
        return False


LOGIN_PAGE = """<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connexion — Espace sourcing</title>
<style>
  :root{--ink:#1d2430;--muted:#5b6472;--line:#d8dde4;--accent:#0f5fbe;--ok:#1a7f4b;--ko:#b3261e;--bg:#f6f7f9;}
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);
    background:linear-gradient(135deg,#eef4fc 0%,#f6f7f9 60%);padding:20px;}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;
    padding:36px 34px;width:100%;max-width:400px;box-shadow:0 10px 40px rgba(20,40,80,.08);}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:22px;}
  .logo{width:34px;height:34px;border-radius:8px;background:var(--accent);
    display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px;}
  h1{font-size:19px;margin:0;}
  p.sub{color:var(--muted);font-size:13.5px;margin:6px 0 24px;line-height:1.5;}
  label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px;}
  input{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:8px;font-size:14px;font-family:inherit;}
  input:focus{outline:2px solid var(--accent);border-color:var(--accent);}
  button{width:100%;margin-top:22px;background:var(--accent);color:#fff;border:none;
    border-radius:8px;padding:12px;font-size:14.5px;font-weight:600;cursor:pointer;}
  button:hover{filter:brightness(1.08);}
  .err{background:#fdecec;color:var(--ko);border:1px solid #f5c6c6;border-radius:8px;
    padding:9px 12px;font-size:13px;margin-top:16px;}
  .foot{margin-top:20px;font-size:11.5px;color:var(--muted);text-align:center;line-height:1.5;}
</style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <div class="brand">
      <div class="logo">S</div>
      <h1>Espace sourcing</h1>
    </div>
    <p class="sub">Connecte-toi pour ouvrir ton navigateur de sourcing. Accès réservé à l'équipe.</p>
    {{ERROR}}
    <label for="username">Identifiant</label>
    <input id="username" name="username" type="text" autocomplete="username" autofocus required>
    <label for="password">Mot de passe</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Se connecter</button>
    <p class="foot">Session sécurisée · accès personnel, ne pas partager.</p>
  </form>
</body>
</html>"""


class H(BaseHTTPRequestHandler):
    def _token(self):
        c = SimpleCookie(self.headers.get("Cookie", ""))
        return c[COOKIE].value if COOKIE in c else ""

    def _login_page(self, error=False):
        body = LOGIN_PAGE.replace("{{ERROR}}", '<div class="err">Identifiants incorrects.</div>' if error else "")
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/verify":
            if valid(self._token()):
                self.send_response(200)
                self.end_headers()
            else:
                self.send_response(302)
                self.send_header("Location", "/login")
                self.end_headers()
        elif path == "/login":
            self._login_page()
        elif path == "/logout":
            self.send_response(302)
            self.send_header("Set-Cookie", COOKIE + "=; Path=/; Max-Age=0")
            self.send_header("Location", "/login")
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path.split("?")[0] != "/login":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        u = form.get("username", [""])[0]
        p = form.get("password", [""])[0]
        if PASSWORD and u == USER and hmac.compare_digest(p, PASSWORD):
            exp = int(time.time()) + TTL
            self.send_response(302)
            self.send_header(
                "Set-Cookie",
                "%s=%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Lax" % (COOKIE, sign(exp), TTL),
            )
            self.send_header("Location", "/")
            self.end_headers()
        else:
            self._login_page(error=True)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 9000), H).serve_forever()
