#!/usr/bin/env python3
# Auth + interface d'administration multi-licences (stdlib uniquement).
#
# Modele (config.json) :
#   licenses    : { "<nom>": {"port":8001, "hw_email":"", "hw_password":""}, ... }
#                 1 licence = 1 compte hellowork + 1 IP fixe (le port Oxylabs).
#   consultants : { "<login>": {"password":"...", "license":"<nom>", "seat":N}, ... }
#                 1 consultant = 1 poste (navigateur) sur l'IP de sa licence.
#   seat_seq    : compteur de postes (numeros jamais reutilises).
#
# status.json (ecrit par apply.sh) : { "running": [1,2,...] } postes en marche.

import os, json, hmac, hashlib, time, html, tempfile, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

SECRET = os.environ.get("SESSION_SECRET", "change-me").encode()
CONFIG_PATH = os.environ.get("CONFIG_PATH", "/app/config.json")
STATUS_PATH = os.environ.get("STATUS_PATH", "/app/status.json")
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
TTL = 8 * 3600
COOKIE = "talens_session"
NAME_RE = re.compile(r"^[a-zA-Z0-9._-]{2,32}$")
PORT_BASE = int(os.environ.get("OXY_PORT_BASE", "8001"))
PORT_MAX = int(os.environ.get("OXY_PORT_MAX", "8020"))


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


def running_seats():
    try:
        with open(STATUS_PATH) as f:
            return set(int(x) for x in json.load(f).get("running", []))
    except Exception:
        return set()


def next_seat(c):
    used = {int(r.get("seat", 0)) for r in c["consultants"].values()}
    s = int(c.get("seat_seq", 0)) + 1
    while s in used:
        s += 1
    c["seat_seq"] = s
    return s


def next_port(c):
    used = {int(l.get("port", 0)) for l in c["licenses"].values()}
    for p in range(PORT_BASE, PORT_MAX + 1):
        if p not in used:
            return p
    return None


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
:root{--ink:#1d2430;--muted:#5b6472;--line:#d8dde4;--accent:#0f5fbe;--ok:#1a7f4b;--warn:#a86400;--ko:#b3261e;--bg:#f6f7f9;}
*{box-sizing:border-box;}
body{margin:0;min-height:100vh;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);
background:linear-gradient(135deg,#eef4fc 0%%,#f6f7f9 60%%);}
.center{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:34px;width:100%%;max-width:440px;
box-shadow:0 10px 40px rgba(20,40,80,.08);}
.wrap{max-width:920px;margin:0 auto;padding:34px 20px;}
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
.info{background:#eef4fc;color:var(--ink);border:1px solid #cfe0f5;border-radius:10px;padding:14px 16px;font-size:13px;line-height:1.55;margin-bottom:18px;}
.info b{color:var(--ink);}
.foot{margin-top:20px;font-size:11.5px;color:var(--muted);text-align:center;line-height:1.5;}
.foot a,a.link{color:var(--accent);}
.panel{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px 24px;margin-top:18px;}
table{width:100%%;border-collapse:collapse;font-size:14px;}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:middle;}
th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;}
.row2{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;}
.row2>div{flex:1;min-width:150px;}
.row2>div.fit{flex:0;}
.dot{width:9px;height:9px;border-radius:50%%;display:inline-block;margin-right:6px;}
.dot.ok{background:var(--ok);} .dot.warn{background:var(--warn);}
.pill{display:inline-flex;align-items:center;font-size:12.5px;}
.topbar{display:flex;justify-content:space-between;align-items:center;}
.stats{display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;}
.stat{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:120px;}
.stat .n{font-size:22px;font-weight:700;color:var(--accent);}
.stat .l{font-size:12px;color:var(--muted);}
code.cred{background:#f2f6fc;border:1px solid var(--line);border-radius:6px;padding:2px 7px;font-family:ui-monospace,monospace;font-size:13px;}
.tip{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%%;background:var(--line);color:var(--ink);font-size:11px;font-weight:700;cursor:help;margin-left:6px;vertical-align:middle;}
.tip .bub{visibility:hidden;opacity:0;transition:opacity .15s;position:absolute;bottom:150%%;left:50%%;transform:translateX(-50%%);background:var(--ink);color:#fff;font-weight:400;font-size:12px;line-height:1.45;padding:9px 11px;border-radius:8px;width:250px;z-index:20;text-align:left;box-shadow:0 6px 20px rgba(0,0,0,.18);}
.tip:hover .bub{visibility:visible;opacity:1;}
</style></head><body>"""

TIP = '<span class="tip">i<span class="bub">%s</span></span>'


def login_page(error=False):
    err = '<div class="err">Identifiants incorrects.</div>' if error else ""
    return (HEAD % "Connexion") + """
<div class="center"><form class="card" method="post" action="/login">
  <div class="brand"><div class="logo">S</div><h1>Espace sourcing</h1></div>
  <p class="sub">Connecte-toi avec l'identifiant qu'on t'a communique. Ton navigateur de sourcing s'ouvrira ensuite en un clic.</p>
  %s
  <label for="username">Identifiant</label>
  <input id="username" name="username" type="text" autocomplete="username" autofocus required>
  <label for="password">Mot de passe</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button class="block" type="submit">Se connecter</button>
  <p class="foot">Acces personnel. Ne partage pas tes identifiants.</p>
</form></div></body></html>""" % err


def portal_page(user, seat, lic_name, hw_email, hw_password):
    creds = ""
    if hw_email:
        pw = ('<div style="margin-top:6px;">Mot de passe : <code class="cred">%s</code></div>' % html.escape(hw_password)) if hw_password else ""
        creds = """
  <details style="margin-top:16px;">
    <summary style="cursor:pointer;font-weight:600;font-size:13.5px;">Premiere fois ? Se connecter a hellowork</summary>
    <div class="info" style="margin-top:10px;">
      <b>A faire une seule fois :</b> quand le navigateur s'ouvre sur hellowork, connecte-toi avec le compte de l'equipe ci-dessous. Ensuite, c'est memorise : tu n'auras plus a le refaire.
      <div style="margin-top:10px;">Identifiant hellowork : <code class="cred">%s</code></div>
      %s
    </div>
  </details>""" % (html.escape(hw_email), pw)
    return (HEAD % "Mon espace") + """
<div class="center"><div class="card">
  <div class="brand"><div class="logo">S</div><h1>Bonjour %s</h1></div>
  <p class="sub"><span class="dot ok"></span>Ton navigateur de sourcing est pret. Clique pour l'ouvrir dans un onglet. Rien a installer.%s</p>
  <a class="btn" style="display:block;padding:13px;" href="/s%d/" target="_blank" rel="noopener">Ouvrir mon navigateur</a>
  %s
  <p class="foot">Au 1er chargement, patiente quelques secondes. Ferme l'onglet quand tu as fini.<br><a href="/logout">Se deconnecter</a></p>
</div></div></body></html>""" % (
        html.escape(user),
        TIP % "Tu es rattache a la licence &laquo; " + html.escape(lic_name) + " &raquo; : tu sors sur son IP fixe, comme le reste de ton equipe.",
        seat, creds)


def admin_page(cfg, run, msg="", err=""):
    lic = cfg["licenses"]
    cons = cfg["consultants"]

    lic_rows = ""
    for name in sorted(lic):
        n = sum(1 for r in cons.values() if r.get("license") == name)
        hw = html.escape(lic[name]["hw_email"]) if lic[name].get("hw_email") else '<span style="color:var(--muted);">non renseigne</span>'
        lic_rows += """<tr><td><b>%s</b></td><td>port %s</td><td>%s</td><td>%d</td>
<td style="text-align:right;"><form method="post" action="/admin/lic-del" onsubmit="return confirm('Supprimer la licence %s ?');" style="margin:0;">
<input type="hidden" name="name" value="%s"><button class="danger" type="submit">Supprimer</button></form></td></tr>""" % (
            html.escape(name), lic[name].get("port", "?"), hw, n, html.escape(name), html.escape(name))
    if not lic_rows:
        lic_rows = '<tr><td colspan="5" style="color:var(--muted);">Aucune licence. Commence par en creer une.</td></tr>'

    options = "".join('<option value="%s">%s (port %s)</option>' % (html.escape(x), html.escape(x), lic[x].get("port", "?")) for x in sorted(lic))

    cons_rows = ""
    active = 0
    for name in sorted(cons):
        r = cons[name]
        seat = int(r.get("seat", 0))
        up = seat in run
        if up:
            active += 1
        st = '<span class="pill"><span class="dot ok"></span>actif</span>' if up else '<span class="pill"><span class="dot warn"></span>demarrage…</span>'
        cons_rows += """<tr><td><b>%s</b></td><td>%s</td><td>Poste %s</td><td>%s</td>
<td style="text-align:right;"><form method="post" action="/admin/delete" onsubmit="return confirm('Supprimer %s ?');" style="margin:0;">
<input type="hidden" name="username" value="%s"><button class="danger" type="submit">Supprimer</button></form></td></tr>""" % (
            html.escape(name), html.escape(r.get("license", "?")), seat, st, html.escape(name), html.escape(name))
    if not cons_rows:
        cons_rows = '<tr><td colspan="5" style="color:var(--muted);">Aucun consultant.</td></tr>'

    banner = ('<div class="ok">%s</div>' % html.escape(msg)) if msg else ""
    if err:
        banner += '<div class="err">%s</div>' % html.escape(err)

    add_cons = """
    <form method="post" action="/admin/add">
      <div class="row2">
        <div><label>Identifiant</label><input name="username" placeholder="ex: jean" required></div>
        <div><label>Mot de passe</label><input name="password" required></div>
        <div><label>Licence %s</label><select name="license" required>%s</select></div>
        <div class="fit"><button type="submit">Ajouter</button></div>
      </div>
    </form>""" % (TIP % "La licence (donc l'IP fixe + le compte hellowork) sur laquelle ce consultant travaillera.", options) if lic else '<p class="sub" style="margin:0;">Cree d\'abord une licence ci-dessus pour pouvoir ajouter des consultants.</p>'

    return (HEAD % "Administration") + """
<div class="wrap">
  <div class="topbar">
    <div class="brand" style="margin:0;"><div class="logo">S</div><h1>Administration</h1></div>
    <a class="link" href="/logout">Se deconnecter</a>
  </div>

  <div class="info">
    <b>Comment ca marche, en 3 etapes :</b>
    <div>1. Cree une <b>licence</b> = un compte hellowork partage + son IP fixe (l'IP est attribuee automatiquement).</div>
    <div>2. Ajoute tes <b>consultants</b> dans cette licence (2 a 4 recommandes). Chacun aura son propre navigateur.</div>
    <div>3. Chaque consultant se connecte ici avec son identifiant, ouvre son navigateur, et travaille sur hellowork via l'IP de sa licence.</div>
  </div>

  <div class="stats">
    <div class="stat"><div class="n">%d</div><div class="l">Licences</div></div>
    <div class="stat"><div class="n">%d</div><div class="l">Consultants</div></div>
    <div class="stat"><div class="n">%d</div><div class="l">Postes actifs</div></div>
  </div>

  %s

  <div class="panel">
    <h1 style="font-size:15px;margin:0 0 12px;">Ajouter une licence</h1>
    <form method="post" action="/admin/lic-add">
      <div class="row2">
        <div><label>Nom de la licence %s</label><input name="name" placeholder="ex: equipe-paris" required></div>
        <div><label>Port Oxylabs %s</label><input name="port" type="number" min="1" max="65535" placeholder="auto"></div>
        <div class="fit"><button type="submit">Ajouter</button></div>
      </div>
      <div class="row2" style="margin-top:6px;">
        <div><label>Compte hellowork (email) %s</label><input name="hw_email" type="text" placeholder="compte@exemple.com"></div>
        <div><label>Mot de passe hellowork</label><input name="hw_password" type="text" placeholder="(optionnel)"></div>
      </div>
    </form>
    <table style="margin-top:14px;"><thead><tr><th>Licence</th><th>Port</th><th>Compte hellowork</th><th>Consult.</th><th></th></tr></thead><tbody>%s</tbody></table>
  </div>

  <div class="panel">
    <h1 style="font-size:15px;margin:0 0 12px;">Ajouter un consultant %s</h1>
    %s
    <table style="margin-top:14px;"><thead><tr><th>Consultant</th><th>Licence</th><th>Poste</th><th>Etat</th><th></th></tr></thead><tbody>%s</tbody></table>
    <p class="foot" style="text-align:left;">Un nouveau poste passe de &laquo; demarrage &raquo; a &laquo; actif &raquo; en moins d'une minute.</p>
  </div>
</div></body></html>""" % (
        len(lic), len(cons), active, banner,
        TIP % "Un nom libre pour t'y retrouver (ex: le compte hellowork concerne). 1 licence = 1 compte hellowork + 1 IP fixe.",
        TIP % "Laisse vide : la prochaine IP libre est attribuee automatiquement. Sinon force un port precis depuis ton dashboard Oxylabs.",
        TIP % "Le compte hellowork partage de cette licence. Il s'affichera au consultant pour sa 1re connexion, puis c'est memorise.",
        lic_rows,
        TIP % "Chaque consultant a son propre navigateur (poste), sur l'IP de sa licence. Il demarre tout seul en moins d'une minute.",
        add_cons, cons_rows)


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
            self._send(200, admin_page(load_cfg(), running_seats()))
        elif path in ("/", ""):
            if not user:
                self._redir("/login"); return
            if user == ADMIN_USER:
                self._redir("/admin"); return
            cfg = load_cfg()
            r = cfg["consultants"].get(user, {})
            licrec = cfg["licenses"].get(r.get("license", ""), {})
            self._send(200, portal_page(user, r.get("seat", 1), r.get("license", ""),
                                        licrec.get("hw_email", ""), licrec.get("hw_password", "")))
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
                self._send(200, admin_page(cfg, running_seats(), err="Nom de licence invalide.")); return
            if name in cfg["licenses"]:
                self._send(200, admin_page(cfg, running_seats(), err="Cette licence existe deja.")); return
            if port:
                if not (port.isdigit() and 1 <= int(port) <= 65535):
                    self._send(200, admin_page(cfg, running_seats(), err="Port invalide.")); return
                port_val = int(port)
            else:
                port_val = next_port(cfg)
                if port_val is None:
                    self._send(200, admin_page(cfg, running_seats(), err="Plus de port/IP disponible (limite atteinte).")); return
            cfg["licenses"][name] = {
                "port": port_val,
                "hw_email": f.get("hw_email", [""])[0].strip(),
                "hw_password": f.get("hw_password", [""])[0],
            }
            save_cfg(cfg)
            self._redir("/admin")

        elif path == "/admin/lic-del":
            name = f.get("name", [""])[0].strip()
            if any(r.get("license") == name for r in cfg["consultants"].values()):
                self._send(200, admin_page(cfg, running_seats(), err="Supprime d'abord les consultants de cette licence.")); return
            cfg["licenses"].pop(name, None)
            save_cfg(cfg)
            self._redir("/admin")

        elif path == "/admin/add":
            u = f.get("username", [""])[0].strip()
            p = f.get("password", [""])[0]
            licn = f.get("license", [""])[0].strip()
            if not NAME_RE.match(u):
                self._send(200, admin_page(cfg, running_seats(), err="Identifiant invalide (lettres, chiffres, . _ - ).")); return
            if u == ADMIN_USER or u in cfg["consultants"]:
                self._send(200, admin_page(cfg, running_seats(), err="Ce compte existe deja.")); return
            if licn not in cfg["licenses"]:
                self._send(200, admin_page(cfg, running_seats(), err="Licence inconnue.")); return
            if not p:
                self._send(200, admin_page(cfg, running_seats(), err="Mot de passe requis.")); return
            cfg["consultants"][u] = {"password": p, "license": licn, "seat": next_seat(cfg)}
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
