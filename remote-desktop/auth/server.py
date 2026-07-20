#!/usr/bin/env python3
# Auth + interface d'administration multi-licences (stdlib uniquement).
#
# Modele (config.json) :
#   licenses    : { "<nom>": {"port": 8001}, ... }   1 licence = 1 compte hellowork = 1 IP fixe
#   consultants : { "<login>": {"password":"...", "license":"<nom>", "seat": N}, ... }
#                 1 consultant = 1 poste (navigateur) sur l'IP de sa licence.
#
# Cote consultant : /login, /, /verify, /logout
# Cote admin      : /admin, /admin/lic-add, /admin/lic-del, /admin/add, /admin/delete
#
# Un synchroniseur cote serveur (hors web) cree les proxys + postes pour coller
# a config.json (voir provision.py / apply.sh / deploy/talens-sync.*).

import os, json, hmac, hashlib, time, html, tempfile, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

SECRET = os.environ.get("SESSION_SECRET", "change-me").encode()
CONFIG_PATH = os.environ.get("CONFIG_PATH", "/app/config.json")
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
TTL = 8 * 3600
COOKIE = "talens_session"
NAME_RE = re.compile(r"^[a-zA-Z0-9._-]{2,32}$")


def load_cfg():
    try:
        with open(CONFIG_PATH) as f:
            c = json.load(f)
    except Exception:
        c = {}
    c.setdefault("licenses", {})
    c.setdefault("consultants", {})
    return c


def save_cfg(c):
    d = os.path.dirname(CONFIG_PATH) or "."
    fd, tmp = tempfile.mkstemp(dir=d)
    with os.fdopen(fd, "w") as f:
        json.dump(c, f, indent=2, ensure_ascii=False)
    os.replace(tmp, CONFIG_PATH)


def next_seat(c):
    used = {int(r.get("seat", 0)) for r in c["consultants"].values()}
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
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:34px;width:100%%;max-width:420px;
box-shadow:0 10px 40px rgba(20,40,80,.08);}
.wrap{max-width:900px;margin:0 auto;padding:34px 20px;}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px;}
.logo{width:34px;height:34px;border-radius:8px;background:var(--accent);display:flex;align-items:center;
justify-content:center;color:#fff;font-weight:700;font-size:18px;}
h1{font-size:20px;margin:0;}
p.sub{color:var(--muted);font-size:13.5px;margin:6px 0 22px;line-height:1.5;}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px;}
input,select{width:100%%;padding:11px 13px;border:1px solid var(--line);border-radius:8px;font-size:14px;font-family:inherit;background:#fff;}
input:focus,select:focus{outline:2px solid var(--accent);border-color:var(--accent);}
button,a.btn{display:inline-block;text-align:center;text-decoration:none;background:var(--accent);color:#fff;
border:none;border-radius:8px;padding:11px 16px;font-size:14px;font-weight:600;cursor:pointer;}
button.block{display:block;width:100%%;margin-top:20px;padding:13px;}
button:hover,a.btn:hover{filter:brightness(1.08);}
button.danger{background:#fff;color:var(--ko);border:1px solid #f0c4c4;padding:7px 12px;font-size:13px;}
.err{background:#fdecec;color:var(--ko);border:1px solid #f5c6c6;border-radius:8px;padding:9px 12px;font-size:13px;margin-top:16px;}
.ok{background:#eafaf0;color:var(--ok);border:1px solid #bfe6cd;border-radius:8px;padding:9px 12px;font-size:13px;margin-top:16px;}
.foot{margin-top:20px;font-size:11.5px;color:var(--muted);text-align:center;line-height:1.5;}
.foot a,a.link{color:var(--accent);}
.panel{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px 24px;margin-top:18px;}
table{width:100%%;border-collapse:collapse;font-size:14px;}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);}
th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;}
.row2{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;}
.row2>div{flex:1;min-width:150px;}
.row2>div.fit{flex:0;}
.dot{width:9px;height:9px;border-radius:50%%;background:var(--ok);display:inline-block;margin-right:6px;}
.topbar{display:flex;justify-content:space-between;align-items:center;}
.tip{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%%;background:var(--line);color:var(--ink);font-size:11px;font-weight:700;cursor:help;margin-left:6px;vertical-align:middle;}
.tip .bub{visibility:hidden;opacity:0;transition:opacity .15s;position:absolute;bottom:150%%;left:50%%;transform:translateX(-50%%);background:var(--ink);color:#fff;font-weight:400;font-size:12px;line-height:1.45;padding:9px 11px;border-radius:8px;width:250px;z-index:20;text-align:left;box-shadow:0 6px 20px rgba(0,0,0,.18);}
.tip:hover .bub{visibility:visible;opacity:1;}
</style></head><body>"""


def tip(text):
    return '<span class="tip">i<span class="bub">' + text + '</span></span>'


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


def portal_page(user, seat, lic):
    return (HEAD % "Mon espace") + """
<div class="center"><div class="card">
  <div class="brand"><div class="logo">S</div><h1>Bonjour %s</h1></div>
  <p class="sub"><span class="dot"></span>Ton navigateur de sourcing est pret (licence %s). Clique pour l'ouvrir dans cet onglet. Rien a installer.<span class="tip">i<span class="bub">Au premier chargement, patiente quelques secondes. Ensuite tu utilises hellowork comme d'habitude. Ferme l'onglet quand tu as termine.</span></span></p>
  <a class="btn" style="display:block;padding:13px;" href="/s%d/" target="_blank" rel="noopener">Ouvrir mon navigateur</a>
  <p class="foot">Ton poste est personnel et sort sur l'IP fixe de ta licence.<br><a href="/logout">Se deconnecter</a></p>
</div></div></body></html>""" % (html.escape(user), html.escape(lic), seat)


def admin_page(cfg, msg="", err=""):
    lic = cfg["licenses"]
    cons = cfg["consultants"]

    lic_rows = ""
    for name in sorted(lic):
        n = sum(1 for r in cons.values() if r.get("license") == name)
        lic_rows += """<tr><td><b>%s</b></td><td>port %s</td><td>%d consultant(s)</td>
<td style="text-align:right;"><form method="post" action="/admin/lic-del" onsubmit="return confirm('Supprimer la licence %s ?');" style="margin:0;">
<input type="hidden" name="name" value="%s"><button class="danger" type="submit">Supprimer</button></form></td></tr>""" % (
            html.escape(name), lic[name].get("port", "?"), n, html.escape(name), html.escape(name))
    if not lic_rows:
        lic_rows = '<tr><td colspan="4" style="color:var(--muted);">Aucune licence. Ajoute-en une ci-dessus.</td></tr>'

    options = "".join('<option value="%s">%s (port %s)</option>' % (html.escape(n), html.escape(n), lic[n].get("port", "?")) for n in sorted(lic))

    cons_rows = ""
    for name in sorted(cons):
        r = cons[name]
        cons_rows += """<tr><td><b>%s</b></td><td>%s</td><td>Poste %s</td>
<td style="text-align:right;"><form method="post" action="/admin/delete" onsubmit="return confirm('Supprimer %s ?');" style="margin:0;">
<input type="hidden" name="username" value="%s"><button class="danger" type="submit">Supprimer</button></form></td></tr>""" % (
            html.escape(name), html.escape(r.get("license", "?")), r.get("seat", "?"), html.escape(name), html.escape(name))
    if not cons_rows:
        cons_rows = '<tr><td colspan="4" style="color:var(--muted);">Aucun consultant.</td></tr>'

    banner = ('<div class="ok">%s</div>' % html.escape(msg)) if msg else ""
    if err:
        banner += '<div class="err">%s</div>' % html.escape(err)

    add_cons = """
    <form method="post" action="/admin/add">
      <div class="row2">
        <div><label>Identifiant</label><input name="username" placeholder="ex: jean" required></div>
        <div><label>Mot de passe</label><input name="password" required></div>
        <div><label>Licence <span class="tip">i<span class="bub">La licence (donc l'IP fixe + le compte hellowork) sur laquelle ce consultant travaillera.</span></span></label><select name="license" required>%s</select></div>
        <div class="fit"><button type="submit">Ajouter</button></div>
      </div>
    </form>""" % options if lic else '<p class="sub" style="margin:0;">Cree d\'abord une licence pour pouvoir ajouter des consultants.</p>'

    return (HEAD % "Administration") + """
<div class="wrap">
  <div class="topbar">
    <div class="brand" style="margin:0;"><div class="logo">S</div><h1>Administration</h1></div>
    <a class="link" href="/logout">Se deconnecter</a>
  </div>
  <p class="sub">Une licence = un compte hellowork + une IP fixe (un port Oxylabs). Chaque consultant appartient a une licence et ouvre son propre poste sur l'IP de cette licence.</p>
  %s
  <div class="panel">
    <h1 style="font-size:15px;margin:0 0 12px;">Ajouter une licence</h1>
    <form method="post" action="/admin/lic-add">
      <div class="row2">
        <div><label>Nom de la licence <span class="tip">i<span class="bub">Un nom libre pour t'y retrouver (ex: le compte hellowork concerne). 1 licence = 1 compte hellowork + 1 IP fixe.</span></span></label><input name="name" placeholder="ex: licence1" required></div>
        <div><label>Port Oxylabs <span class="tip">i<span class="bub">Le port depuis ton dashboard Oxylabs (ISP Proxies, Proxy list). Chaque port = une IP fixe. Ex: 8001 = 31.98.21.135.</span></span></label><input name="port" type="number" min="1" max="65535" placeholder="8001" required></div>
        <div class="fit"><button type="submit">Ajouter</button></div>
      </div>
    </form>
    <table style="margin-top:14px;"><thead><tr><th>Licence</th><th>Port</th><th>Consultants</th><th></th></tr></thead><tbody>%s</tbody></table>
  </div>
  <div class="panel">
    <h1 style="font-size:15px;margin:0 0 12px;">Ajouter un consultant <span class="tip">i<span class="bub">Chaque consultant a son propre navigateur (poste), sur l'IP de sa licence. Il se connecte avec ces identifiants. Son poste demarre tout seul en moins d'une minute.</span></span></h1>
    %s
    <table style="margin-top:14px;"><thead><tr><th>Consultant</th><th>Licence</th><th>Poste</th><th></th></tr></thead><tbody>%s</tbody></table>
    <p class="foot" style="text-align:left;">Un nouveau poste peut mettre jusqu'a une minute a demarrer apres la creation du compte.</p>
  </div>
</div></body></html>""" % (banner, lic_rows, add_cons, cons_rows)


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

    def _redir(self, loc, cookie=None):
        h = {"Location": loc}
        if cookie:
            h["Set-Cookie"] = cookie
        self._send(302, headers=h)

    def do_GET(self):
        path = self.path.split("?")[0]
        user = token_user(cookie_token(self.headers))

        if path == "/verify":
            if not user:
                self._redir("/login"); return
            fwd = self.headers.get("X-Forwarded-Uri", "/").split("?")[0]
            if fwd.startswith("/s") and len(fwd) > 2 and fwd[2].isdigit():
                if user == ADMIN_USER:
                    self._send(200); return
                # extraire le numero de poste demande
                num = ""
                for ch in fwd[2:]:
                    if ch.isdigit():
                        num += ch
                    else:
                        break
                seat = load_cfg()["consultants"].get(user, {}).get("seat")
                self._send(200 if str(seat) == num else 403); return
            self._send(200)
        elif path == "/login":
            self._send(200, login_page())
        elif path == "/logout":
            self._redir("/login", cookie=COOKIE + "=; Path=/; Max-Age=0")
        elif path == "/admin":
            if user != ADMIN_USER:
                self._redir("/login"); return
            self._send(200, admin_page(load_cfg()))
        elif path in ("/", ""):
            if not user:
                self._redir("/login"); return
            if user == ADMIN_USER:
                self._redir("/admin"); return
            r = load_cfg()["consultants"].get(user, {})
            self._send(200, portal_page(user, r.get("seat", 1), r.get("license", "")))
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
                self._redir("/admin", cookie=self._cookie(sign(u, int(time.time()) + TTL))); return
            r = load_cfg()["consultants"].get(u)
            if r and p and hmac.compare_digest(p, str(r.get("password", ""))):
                self._redir("/", cookie=self._cookie(sign(u, int(time.time()) + TTL))); return
            self._send(200, login_page(error=True))
            return

        if user != ADMIN_USER:
            self._redir("/login"); return
        cfg = load_cfg()
        f = self._form()

        if path == "/admin/lic-add":
            name = f.get("name", [""])[0].strip()
            port = f.get("port", [""])[0].strip()
            if not NAME_RE.match(name):
                self._send(200, admin_page(cfg, err="Nom de licence invalide.")); return
            if name in cfg["licenses"]:
                self._send(200, admin_page(cfg, err="Cette licence existe deja.")); return
            if not (port.isdigit() and 1 <= int(port) <= 65535):
                self._send(200, admin_page(cfg, err="Port invalide.")); return
            cfg["licenses"][name] = {"port": int(port)}
            save_cfg(cfg)
            self._redir("/admin")

        elif path == "/admin/lic-del":
            name = f.get("name", [""])[0].strip()
            if any(r.get("license") == name for r in cfg["consultants"].values()):
                self._send(200, admin_page(cfg, err="Supprime d'abord les consultants de cette licence.")); return
            cfg["licenses"].pop(name, None)
            save_cfg(cfg)
            self._redir("/admin")

        elif path == "/admin/add":
            u = f.get("username", [""])[0].strip()
            p = f.get("password", [""])[0]
            lic = f.get("license", [""])[0].strip()
            if not NAME_RE.match(u):
                self._send(200, admin_page(cfg, err="Identifiant invalide (lettres, chiffres, . _ - ).")); return
            if u == ADMIN_USER or u in cfg["consultants"]:
                self._send(200, admin_page(cfg, err="Ce compte existe deja.")); return
            if lic not in cfg["licenses"]:
                self._send(200, admin_page(cfg, err="Licence inconnue.")); return
            if not p:
                self._send(200, admin_page(cfg, err="Mot de passe requis.")); return
            cfg["consultants"][u] = {"password": p, "license": lic, "seat": next_seat(cfg)}
            save_cfg(cfg)
            self._redir("/admin")

        elif path == "/admin/delete":
            u = f.get("username", [""])[0].strip()
            if u in cfg["consultants"]:
                cfg["consultants"].pop(u, None)
                save_cfg(cfg)
            self._redir("/admin")
        else:
            self._send(404)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 9000), H).serve_forever()
