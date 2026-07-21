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

import os, json, hmac, hashlib, time, html, tempfile, re, secrets, threading, unicodedata
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

SECRET = os.environ.get("SESSION_SECRET", "change-me").encode()
CONFIG_PATH = os.environ.get("CONFIG_PATH", "/app/config.json")
STATUS_PATH = os.environ.get("STATUS_PATH", "/app/status.json")
ACTIVITY_PATH = os.environ.get("ACTIVITY_PATH", "/app/activity.json")
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
TTL = 8 * 3600
COOKIE = "talens_session"
NAME_RE = re.compile(r"^[a-zA-Z0-9._-]{2,32}$")
PORT_BASE = int(os.environ.get("OXY_PORT_BASE", "8001"))
PORT_MAX = int(os.environ.get("OXY_PORT_MAX", "8020"))
ONDEMAND = os.environ.get("ONDEMAND", "0").strip() == "1"
try:
    IDLE_MINUTES = int(os.environ.get("IDLE_MINUTES", "5") or 5)
except Exception:
    IDLE_MINUTES = 5
PORTAL_URL = os.environ.get("PORTAL_URL", "").strip().rstrip("/")
ONLINE_WINDOW = 180  # secondes : un consultant "en ligne" a battu il y a moins de 3 min.

# Anti-force-brute sur la page de connexion (par IP).
FAIL_MAX = 8
FAIL_WINDOW = 600      # 8 echecs en 10 min...
FAIL_BLOCK = 600       # ...bloquent l'IP 10 min.
LOGIN_FAILS = {}
LOGIN_LOCK = threading.Lock()

# Taille de fenetre variee d'une licence a l'autre (empreinte differente entre
# groupes ; identique a l'interieur d'un groupe car partagee par la licence).
WIN_POOL = ["1920,1080", "1600,900", "1536,864", "1680,1050", "1440,900",
            "1366,768", "1280,800", "1728,1117"]


def pick_win(cfg):
    used = {l.get("fp_win") for l in cfg.get("licenses", {}).values()}
    for w in WIN_POOL:
        if w not in used:
            return w
    return WIN_POOL[len(cfg.get("licenses", {})) % len(WIN_POOL)]


def safe(name):
    return re.sub(r"[^a-z0-9]", "-", str(name).lower()).strip("-") or "x"


def slugify(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s[:32]


def unique_login(cfg, base):
    if base and base not in cfg["consultants"] and base != ADMIN_USER:
        return base
    i = 2
    while True:
        cand = ("%s-%d" % (base, i))[:32]
        if cand not in cfg["consultants"] and cand != ADMIN_USER:
            return cand
        i += 1


def parse_person(line):
    # "Nom Affiche" ou "Nom Affiche, motdepasse" -> (nom, motdepasse ou genere).
    s = line.strip()
    if not s:
        return None
    if "," in s:
        left, right = s.split(",", 1)
        disp, pw = left.strip(), right.strip()
    else:
        disp, pw = s, ""
    if not disp:
        return None
    return disp, (pw or secrets.token_hex(4))


def load_cfg():
    try:
        with open(CONFIG_PATH) as f:
            c = json.load(f)
    except Exception:
        c = {}
    c.setdefault("licenses", {})
    c.setdefault("consultants", {})
    return c


def _atomic_write(path, text):
    # Ecriture atomique (tmp + rename). CONFIG_PATH est un fichier monte seul
    # dans Docker : le rename traverse deux systemes de fichiers et echoue
    # (EXDEV). Dans ce cas, on ecrit directement dans le fichier monte.
    d = os.path.dirname(path) or "."
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(dir=d)
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except OSError:
        if tmp:
            try:
                os.remove(tmp)
            except Exception:
                pass
        with open(path, "w") as f:
            f.write(text)


def save_cfg(c):
    _atomic_write(CONFIG_PATH, json.dumps(c, indent=2, ensure_ascii=False))


def running_seats():
    try:
        with open(STATUS_PATH) as f:
            return set(int(x) for x in json.load(f).get("running", []))
    except Exception:
        return set()


def load_activity():
    try:
        with open(ACTIVITY_PATH) as f:
            a = json.load(f)
        return a if isinstance(a, dict) else {}
    except Exception:
        return {}


def online_seats():
    now = time.time()
    out = set()
    for s, ts in load_activity().items():
        try:
            if now - float(ts) < ONLINE_WINDOW:
                out.add(int(s))
        except Exception:
            pass
    return out


def proxy_exit_ip(license_name, timeout=8):
    # Verifie l'IP de sortie d'une licence en passant par son proxy gost interne.
    # Sert au bouton "Tester l'IP" (aucun compte hellowork requis).
    px = "http://proxy-%s:8080" % safe(license_name)
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": px, "https": px}))
    req = urllib.request.Request("http://api.ipify.org/",
                                 headers={"User-Agent": "talens-check"})
    with opener.open(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace").strip()


def touch_seat(seat):
    # Marque un poste comme "utilise maintenant" (pour les postes a la demande :
    # apply.sh demarre les postes vus recemment et arrete les autres).
    try:
        seat = int(seat)
    except Exception:
        return
    try:
        with open(ACTIVITY_PATH) as f:
            a = json.load(f)
        if not isinstance(a, dict):
            a = {}
    except Exception:
        a = {}
    a[str(seat)] = int(time.time())
    try:
        _atomic_write(ACTIVITY_PATH, json.dumps(a))
    except Exception:
        pass


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
:root{
  --bg:#f4f6fb;--bg2:#e9eefb;--surface:#ffffff;--surface2:#f5f7fb;
  --line:#e5e9f1;--line2:#eef1f7;--ink:#141a26;--muted:#5f6b7e;
  --accent:#2f6bff;--accent2:#7aa2ff;--accent-ink:#ffffff;--accent-soft:#e9f0ff;
  --ok:#16a34a;--ok-soft:#dcfce7;--warn:#b45309;--warn-soft:#fef0d9;--ko:#dc2626;--ko-soft:#fee2e2;
  --shadow:0 1px 2px rgba(16,30,60,.05),0 10px 30px rgba(16,30,60,.06);
  --radius:16px;--radius-s:10px;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0b0f16;--bg2:#0f1626;--surface:#151b26;--surface2:#1b2230;
  --line:#29313f;--line2:#222a37;--ink:#e8eef7;--muted:#9aa6b8;
  --accent:#5b8cff;--accent2:#8fb0ff;--accent-ink:#0b0f16;--accent-soft:#17223b;
  --ok:#34d399;--ok-soft:#0f2a1e;--warn:#fbbf24;--warn-soft:#2a2211;--ko:#f87171;--ko-soft:#2a1615;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 34px rgba(0,0,0,.45);
}}
*{box-sizing:border-box;}
body{margin:0;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
color:var(--ink);background:radial-gradient(1100px 560px at 100%% -8%%,var(--bg2),var(--bg)) fixed;
-webkit-font-smoothing:antialiased;line-height:1.5;}
a{color:var(--accent);}
.center{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:34px;width:100%%;max-width:430px;box-shadow:var(--shadow);}
.wrap{max-width:960px;margin:0 auto;padding:30px 20px 64px;}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:18px;}
.logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:19px;box-shadow:0 4px 14px rgba(47,107,255,.35);}
h1{font-size:21px;margin:0;font-weight:750;letter-spacing:-.01em;}
p.sub{color:var(--muted);font-size:13.5px;margin:6px 0 22px;}
label{display:block;font-size:12.5px;font-weight:600;margin:15px 0 6px;}
input,select{width:100%%;padding:11px 13px;border:1px solid var(--line);border-radius:var(--radius-s);font-size:14px;font-family:inherit;background:var(--surface);color:var(--ink);transition:border-color .15s,box-shadow .15s;}
input::placeholder{color:var(--muted);opacity:.65;}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
button,a.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;background:var(--accent);color:var(--accent-ink);border:none;border-radius:var(--radius-s);padding:11px 18px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;transition:transform .08s,filter .15s,box-shadow .15s;box-shadow:0 2px 10px rgba(47,107,255,.25);}
button:hover,a.btn:hover{filter:brightness(1.06);box-shadow:0 5px 16px rgba(47,107,255,.32);}
button:active,a.btn:active{transform:translateY(1px);}
button.block{display:flex;width:100%%;margin-top:22px;padding:13px;}
button.danger{background:transparent;color:var(--ko);border:1px solid var(--ko-soft);padding:7px 13px;font-size:13px;box-shadow:none;}
button.danger:hover{background:var(--ko-soft);filter:none;box-shadow:none;}
.err{background:var(--ko-soft);color:var(--ko);border:1px solid var(--ko-soft);border-radius:var(--radius-s);padding:10px 13px;font-size:13px;margin-top:16px;}
.ok{background:var(--ok-soft);color:var(--ok);border:1px solid var(--ok-soft);border-radius:var(--radius-s);padding:10px 13px;font-size:13px;margin-top:16px;}
.info{background:var(--accent-soft);color:var(--ink);border:1px solid var(--accent-soft);border-radius:var(--radius);padding:16px 18px;font-size:13px;line-height:1.6;margin-bottom:20px;}
.info b{font-weight:700;} .info>div{margin-top:4px;}
.foot{margin-top:22px;font-size:11.5px;color:var(--muted);text-align:center;line-height:1.6;}
.foot a,a.link{color:var(--accent);font-weight:600;text-decoration:none;}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:24px;margin-top:18px;box-shadow:var(--shadow);}
.panel h1{font-size:15px;margin:0 0 14px;}
table{width:100%%;border-collapse:collapse;font-size:14px;}
th,td{text-align:left;padding:11px 10px;border-bottom:1px solid var(--line2);vertical-align:middle;}
thead th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--line);}
tbody tr{transition:background .12s;} tbody tr:hover{background:var(--surface2);} tbody tr:last-child td{border-bottom:none;}
.row2{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;}
.row2>div{flex:1;min-width:160px;} .row2>div.fit{flex:0;}
.dot{flex:none;width:9px;height:9px;min-width:9px;aspect-ratio:1/1;border-radius:50%%;display:inline-block;margin-right:7px;vertical-align:middle;box-sizing:border-box;}
.dot.ok{background:var(--ok);animation:blink 1.8s ease-in-out infinite;}
.dot.warn{background:var(--warn);}
@keyframes blink{0%%,100%%{opacity:1;}50%%{opacity:.5;}}
.pill{display:inline-flex;align-items:center;font-size:12.5px;font-weight:600;padding:5px 11px;border-radius:999px;line-height:1;white-space:nowrap;}
.pill .dot{margin-right:6px;}
.pill.ok{background:var(--ok-soft);color:var(--ok);} .pill.warn{background:var(--warn-soft);color:var(--warn);}
.topbar{display:flex;justify-content:space-between;align-items:center;padding-bottom:8px;}
.topbar .brand{margin:0;}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:6px 0 4px;}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow);}
.stat .n{font-size:27px;font-weight:800;letter-spacing:-.02em;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}
.stat .l{font-size:12px;color:var(--muted);margin-top:2px;}
code.cred{background:var(--surface2);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:var(--ink);}
details>summary{cursor:pointer;font-weight:600;font-size:13.5px;list-style:none;}
details>summary::-webkit-details-marker{display:none;}
details>summary::before{content:"\\25B8";margin-right:7px;color:var(--muted);}
details[open]>summary::before{content:"\\25BE";}
.item{border:1px solid var(--line);border-radius:var(--radius-s);margin-top:8px;background:var(--surface);}
.item>summary{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;list-style:none;font-size:14px;}
.item>summary::-webkit-details-marker{display:none;}
.item>summary::before{content:"\\25B8";color:var(--muted);margin:0;}
.item[open]>summary::before{content:"\\25BE";}
.item[open]>summary{border-bottom:1px solid var(--line2);}
.item .meta{color:var(--muted);font-size:12.5px;font-weight:400;}
.item .body{padding:14px;}
.grow{flex:1 1 auto;}
.mini{font-size:12px;padding:8px 12px;}
textarea{width:100%%;padding:11px 13px;border:1px solid var(--line);border-radius:var(--radius-s);font-size:14px;font-family:inherit;background:var(--surface);color:var(--ink);min-height:96px;resize:vertical;}
textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
.tip{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%%;background:var(--line);color:var(--muted);font-size:11px;font-weight:700;cursor:help;margin-left:6px;vertical-align:middle;font-style:normal;}
.tip .bub{visibility:hidden;opacity:0;transition:opacity .15s;position:absolute;bottom:150%%;left:50%%;transform:translateX(-50%%);background:var(--ink);color:var(--surface);font-weight:400;font-size:12px;line-height:1.5;padding:10px 12px;border-radius:10px;width:250px;z-index:30;text-align:left;box-shadow:0 8px 26px rgba(0,0,0,.28);}
.tip:hover .bub{visibility:visible;opacity:1;}
.stage{position:relative;margin-top:14px;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow);background:#0b0f16;min-height:62vh;}
.stage iframe{display:block;width:100%%;height:74vh;border:0;background:#0b0f16;}
.cover{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--surface);padding:24px;}
.cover .logo{width:52px;height:52px;font-size:24px;border-radius:15px;}
.spin{width:26px;height:26px;margin-top:16px;border-radius:50%%;border:3px solid var(--line);border-top-color:var(--accent);animation:sp 0.8s linear infinite;}
@keyframes sp{to{transform:rotate(360deg);}}
@media(max-width:560px){.wrap{padding:20px 14px 48px;}.panel{padding:18px 16px;}.card{padding:26px 22px;}.stage iframe{height:68vh;}}
</style></head><body>"""

TIP = '<span class="tip">i<span class="bub">%s</span></span>'


def login_page(error=False, blocked=False):
    if blocked:
        err = '<div class="err">Trop de tentatives. Reessaie dans quelques minutes.</div>'
    elif error:
        err = '<div class="err">Identifiants incorrects.</div>'
    else:
        err = ""
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
<div class="wrap">
  <div class="topbar">
    <div class="brand" style="margin:0;"><div class="logo">S</div><h1>Bonjour %s</h1></div>
    <a class="link" href="/logout">Se deconnecter</a>
  </div>
  <p class="sub"><span class="dot ok"></span>Ton navigateur de sourcing s'ouvre ci-dessous. Laisse cet onglet ouvert pendant que tu travailles.%s</p>
  <div class="stage">
    <iframe id="frame" title="Navigateur de sourcing" allow="clipboard-read; clipboard-write"></iframe>
    <div id="cover" class="cover">
      <div class="logo">S</div>
      <div class="spin" id="spin"></div>
      <p id="ctxt" style="font-weight:650;margin:14px 0 4px;">Demarrage de ton navigateur</p>
      <p class="sub" id="csub" style="margin:0 0 18px;text-align:center;max-width:340px;">Prepare-toi, ca ne prend que quelques secondes au premier lancement.</p>
      <button id="rl" type="button" class="mini" style="display:none;">Toujours rien ? Relancer</button>
    </div>
  </div>
  <p class="foot" style="text-align:left;">Tu peux aussi <a class="link" href="/s%d/" target="_blank" rel="noopener">l'ouvrir dans un nouvel onglet</a>. Ferme l'onglet quand tu as fini : ton navigateur se met en veille tout seul apres un moment sans activite.</p>
  %s
</div>
<script>
var seat=%d;
function beat(){fetch('/keepalive',{method:'POST',cache:'no-store'}).catch(function(){});}
beat();setInterval(beat,45000);
var f=document.getElementById('frame'),c=document.getElementById('cover'),rl=document.getElementById('rl');
var tries=0,ready=false;
function show(){c.style.display='none';}
function check(){
  if(ready)return;
  tries++;
  fetch('/s'+seat+'/?p='+Date.now(),{method:'GET',cache:'no-store'}).then(function(r){
    if(r.ok){ready=true;f.src='/s'+seat+'/';setTimeout(show,600);}
    else next();
  }).catch(next);
}
function next(){
  if(ready)return;
  if(tries>4){document.getElementById('ctxt').textContent='Presque pret';document.getElementById('csub').textContent='Ton navigateur finit de demarrer. Encore un instant.';}
  if(tries>12){rl.style.display='inline-flex';}
  setTimeout(check,2500);
}
rl.addEventListener('click',function(){ready=false;tries=0;rl.style.display='none';check();});
check();
</script>
</body></html>""" % (
        html.escape(user),
        TIP % ("Tu es rattache a la licence &laquo; " + html.escape(lic_name) + " &raquo; : tu sors sur son IP fixe, comme le reste de ton equipe."),
        seat, creds, seat)


def admin_page(cfg, run, msg="", err="", created=None):
    lic = cfg["licenses"]
    cons = cfg["consultants"]
    online = online_seats()

    def sel_options(selected=""):
        return "".join(
            '<option value="%s"%s>%s (port %s)</option>' % (
                html.escape(x), " selected" if x == selected else "",
                html.escape(x), lic[x].get("port", "?")) for x in sorted(lic))

    # --- licences (cartes depliables) ---
    lic_items = ""
    for name in sorted(lic):
        L = lic[name]
        e = html.escape(name)
        n = sum(1 for r in cons.values() if r.get("license") == name)
        iptxt = ("IP " + html.escape(L["ip"])) if L.get("ip") else "IP non testee"
        hwtxt = html.escape(L["hw_email"]) if L.get("hw_email") else "hellowork non renseigne"
        meta = "port %s &middot; %s &middot; %s &middot; %d consult." % (
            L.get("port", "?"), iptxt, hwtxt, n)
        grp_lines = ["Groupe : %s" % name]
        if L.get("hw_email"):
            grp_lines.append("Compte hellowork : %s" % L["hw_email"])
        if PORTAL_URL:
            grp_lines.append("Lien : %s" % PORTAL_URL)
        grp_lines.append("")
        for cn in sorted(cons):
            if cons[cn].get("license") == name:
                grp_lines.append("%s / %s" % (cn, cons[cn].get("password", "")))
        grp_attr = html.escape("\n".join(grp_lines), quote=True).replace("\n", "&#10;")
        copy_grp = ('<button class="mini" type="button" data-c="' + grp_attr + '" onclick="cp(this)">Copier tout le groupe</button>') if n else ""
        lic_items += (
            '<details class="item"><summary><b>' + e + '</b><span class="meta">' + meta + '</span></summary>'
            '<div class="body">'
            '<form method="post" action="/admin/lic-edit"><input type="hidden" name="name" value="' + e + '">'
            '<div class="row2">'
            '<div><label>Compte hellowork (email)</label><input name="hw_email" value="' + html.escape(L.get("hw_email", "")) + '" placeholder="compte@exemple.com"></div>'
            '<div><label>Mot de passe hellowork</label><input name="hw_password" placeholder="(inchange si vide)"></div>'
            '<div class="fit" style="min-width:110px;"><label>Port</label><input name="port" type="number" min="1" max="65535" value="' + str(L.get("port", "")) + '"></div>'
            '<div class="fit"><button type="submit">Enregistrer</button></div>'
            '</div></form>'
            '<div class="row2" style="margin-top:12px;align-items:center;">'
            '<form method="post" action="/admin/lic-test" style="margin:0;"><input type="hidden" name="name" value="' + e + '"><button class="mini" type="submit">Tester l\'IP de sortie</button></form>'
            + copy_grp +
            '<span class="grow"></span>'
            '<form method="post" action="/admin/lic-del" onsubmit="return confirm(\'Supprimer la licence ' + e + ' ?\');" style="margin:0;"><input type="hidden" name="name" value="' + e + '"><button class="danger" type="submit">Supprimer</button></form>'
            '</div></div></details>')
    if not lic_items:
        lic_items = '<p class="sub" style="margin:8px 0 0;">Aucune licence pour le moment.</p>'

    # --- consultants (cartes depliables) ---
    cons_items = ""
    active = 0
    for name in sorted(cons):
        r = cons[name]
        e = html.escape(name)
        seat = int(r.get("seat", 0))
        licn = r.get("license", "?")
        if seat in run:
            active += 1
        if seat in online:
            st = '<span class="pill ok"><span class="dot ok"></span>en ligne</span>'
        elif seat in run:
            st = '<span class="pill"><span class="dot ok"></span>pret</span>'
        elif ONDEMAND:
            st = '<span class="pill warn"><span class="dot warn"></span>en veille</span>'
        else:
            st = '<span class="pill warn"><span class="dot warn"></span>demarrage&hellip;</span>'
        pw = r.get("password", "")
        cred = "Identifiant : %s\nMot de passe : %s" % (name, pw)
        if PORTAL_URL:
            cred += "\nLien : %s" % PORTAL_URL
        cred_attr = html.escape(cred, quote=True).replace("\n", "&#10;")
        pw_attr = html.escape(pw, quote=True)
        cons_items += (
            '<details class="item" data-name="' + html.escape((name + " " + licn).lower(), quote=True) + '"><summary><b>' + e + '</b><span class="meta">' + html.escape(licn) + ' &middot; poste ' + str(seat) + '</span><span class="grow"></span>' + st + '</summary>'
            '<div class="body">'
            '<div class="meta" style="margin-bottom:10px;">Mot de passe : <code class="cred" data-p="' + pw_attr + '">&bull;&bull;&bull;&bull;&bull;&bull;</code> <a href="#" class="link" onclick="return rv(this)">afficher</a></div>'
            '<form method="post" action="/admin/edit"><input type="hidden" name="username" value="' + e + '">'
            '<div class="row2">'
            '<div><label>Nouveau mot de passe</label><input class="pwin" name="password" placeholder="(inchange si vide)"><a href="#" class="link" style="font-size:11.5px;" onclick="return gp(this)">generer</a></div>'
            '<div><label>Licence</label><select name="license">' + sel_options(licn) + '</select></div>'
            '<div class="fit"><button type="submit">Enregistrer</button></div>'
            '</div></form>'
            '<div class="row2" style="margin-top:12px;align-items:center;">'
            '<button class="mini" type="button" data-c="' + cred_attr + '" onclick="cp(this)">Copier les identifiants</button>'
            '<span class="grow"></span>'
            '<form method="post" action="/admin/delete" onsubmit="return confirm(\'Supprimer ' + e + ' ?\');" style="margin:0;"><input type="hidden" name="username" value="' + e + '"><button class="danger" type="submit">Supprimer</button></form>'
            '</div></div></details>')
    if not cons_items:
        cons_items = '<p class="sub" style="margin:8px 0 0;">Aucun consultant pour le moment.</p>'

    banner = ('<div class="ok">%s</div>' % html.escape(msg)) if msg else ""
    if err:
        banner += '<div class="err">%s</div>' % html.escape(err)

    created_panel = ""
    if created:
        rows = "".join(
            '<tr><td><b>%s</b></td><td><code class="cred">%s</code></td><td>%s</td></tr>' % (
                html.escape(x["user"]), html.escape(x["pw"]), html.escape(x.get("license", "")))
            for x in created)
        alltxt = "\n".join("%s / %s" % (x["user"], x["pw"]) for x in created)
        all_attr = html.escape(alltxt, quote=True).replace("\n", "&#10;")
        banner += (
            '<div class="panel" style="border:1px solid var(--ok);margin-top:14px;">'
            '<div class="row2" style="align-items:center;margin-bottom:10px;">'
            '<h1 style="font-size:15px;margin:0;">Identifiants crees (' + str(len(created)) + ') &mdash; note-les maintenant</h1>'
            '<span class="grow"></span>'
            '<button class="mini" type="button" data-c="' + all_attr + '" onclick="cp(this)">Tout copier</button></div>'
            '<table><thead><tr><th>Identifiant</th><th>Mot de passe</th><th>Licence</th></tr></thead><tbody>' + rows + '</tbody></table>'
            '<p class="foot" style="text-align:left;">Les mots de passe generes ne seront plus affiches en clair ensuite (tu pourras toujours les copier depuis chaque consultant).</p></div>')

    if lic:
        add_cons = (
            '<form method="post" action="/admin/add"><div class="row2">'
            '<div><label>Identifiant</label><input name="username" placeholder="ex: jean" required></div>'
            '<div><label>Mot de passe</label><input name="password" required></div>'
            '<div><label>Licence ' + (TIP % "La licence (IP fixe + compte hellowork) sur laquelle ce consultant travaillera.") + '</label><select name="license" required>' + sel_options() + '</select></div>'
            '<div class="fit"><button type="submit">Ajouter</button></div>'
            '</div></form>'
            '<details style="margin-top:14px;"><summary>Ajouter plusieurs consultants d\'un coup ' + (TIP % "Colle une liste, un nom par ligne (les accents et espaces sont convertis en identifiant). Ajoute , motdepasse pour en imposer un, sinon il est genere.") + '</summary>'
            '<form method="post" action="/admin/bulk" style="margin-top:12px;">'
            '<label>Licence pour tout ce lot</label><select name="license" required>' + sel_options() + '</select>'
            '<label style="margin-top:12px;">Liste (un par ligne)</label>'
            '<textarea name="list" placeholder="Melina&#10;Julia, motdepasse123&#10;Remi Prevot&#10;Theo"></textarea>'
            '<button type="submit" style="margin-top:12px;">Creer le lot</button>'
            '</form></details>')
    else:
        add_cons = '<p class="sub" style="margin:0;">Cree d\'abord une licence ci-dessus, ou utilise l\'import complet ci-dessous pour tout creer d\'un coup.</p>'

    import_block = (
        '<div class="panel"><h1 style="font-size:15px;margin:0 0 6px;">Importer toute la structure d\'un coup ' + (TIP % "Cree les groupes ET leurs consultants en une fois. Ideal pour tout monter au demarrage.") + '</h1>'
        '<p class="sub" style="margin:0 0 12px;">Une ligne <b>#</b> ouvre un groupe, les lignes suivantes sont ses consultants. Options sur la ligne du groupe : <code class="cred">port=8001</code> et <code class="cred">hello=compte@exemple.com</code>. Les mots de passe manquants sont generes.</p>'
        '<form method="post" action="/admin/import">'
        '<textarea name="text" style="min-height:150px;" placeholder="# equipe-paris port=8001 hello=arthur.l@reseau-talents.fr&#10;Melina&#10;Julia&#10;Patrick&#10;Theo&#10;&#10;# equipe-lyon port=8002 hello=aude.m@reseau-talents.fr&#10;Navaz&#10;Fabienne"></textarea>'
        '<button type="submit" style="margin-top:12px;">Tout creer</button>'
        '</form></div>')

    head = (HEAD % "Administration") + (
        '<div class="wrap">'
        '<div class="topbar"><div class="brand" style="margin:0;"><div class="logo">S</div><h1>Administration</h1></div>'
        '<a class="link" href="/logout">Se deconnecter</a></div>'
        '<div class="info"><b>Comment ca marche, en 3 etapes :</b>'
        '<div>1. Cree une <b>licence</b> = un compte hellowork partage + son IP fixe (l\'IP est attribuee automatiquement).</div>'
        '<div>2. Ajoute tes <b>consultants</b> dans cette licence. Chacun aura son propre navigateur.</div>'
        '<div>3. Chaque consultant se connecte ici, ouvre son navigateur, et travaille sur hellowork via l\'IP de sa licence.</div></div>'
        '<div class="stats">'
        '<div class="stat"><div class="n">' + str(len(lic)) + '</div><div class="l">Licences</div></div>'
        '<div class="stat"><div class="n">' + str(len(cons)) + '</div><div class="l">Consultants</div></div>'
        '<div class="stat"><div class="n">' + str(len(online)) + '</div><div class="l">En ligne</div></div>'
        '<div class="stat"><div class="n">' + str(active) + '</div><div class="l">Postes actifs</div></div>'
        '</div>' + banner)

    lic_panel = (
        '<div class="panel"><h1 style="font-size:15px;margin:0 0 12px;">Licences</h1>'
        '<form method="post" action="/admin/lic-add"><div class="row2">'
        '<div><label>Nom de la licence ' + (TIP % "Un nom libre pour t'y retrouver (ex: le compte hellowork concerne).") + '</label><input name="name" placeholder="ex: equipe-paris" required></div>'
        '<div><label>Port Oxylabs ' + (TIP % "Laisse vide : la prochaine IP libre est attribuee automatiquement. Sinon force un port precis.") + '</label><input name="port" type="number" min="1" max="65535" placeholder="auto"></div>'
        '<div class="fit"><button type="submit">Ajouter</button></div></div>'
        '<div class="row2" style="margin-top:6px;">'
        '<div><label>Compte hellowork (email) ' + (TIP % "Peut etre rempli plus tard via Gerer. S'affiche au consultant pour sa 1re connexion, puis c'est memorise.") + '</label><input name="hw_email" type="text" placeholder="(optionnel, modifiable ensuite)"></div>'
        '<div><label>Mot de passe hellowork</label><input name="hw_password" type="text" placeholder="(optionnel)"></div></div>'
        '</form><div style="margin-top:14px;">' + lic_items + '</div></div>')

    search = ('<input id="q" type="text" placeholder="Rechercher un consultant ou une licence" oninput="flt()" style="margin-top:14px;">') if len(cons) > 6 else ""

    cons_panel = (
        '<div class="panel"><h1 style="font-size:15px;margin:0 0 12px;">Consultants</h1>'
        + add_cons + search +
        '<div id="conslist" style="margin-top:14px;">' + cons_items + '</div></div>')

    script = (
        '<script>'
        'function cp(b){var t=b.getAttribute("data-c");navigator.clipboard.writeText(t).then(function(){var o=b.textContent;b.textContent="Copie";setTimeout(function(){b.textContent=o;},1500);});}'
        'function rv(a){var c=a.previousElementSibling;var real=c.getAttribute("data-p");if(c.textContent===real){c.textContent="\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022";a.textContent="afficher";}else{c.textContent=real;a.textContent="masquer";}return false;}'
        'function gp(a){var i=a.previousElementSibling;var s="ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";var p="";for(var k=0;k<10;k++){p+=s.charAt(Math.floor(Math.random()*s.length));}i.value=p;i.type="text";return false;}'
        'function flt(){var q=document.getElementById("q").value.toLowerCase();var it=document.querySelectorAll("#conslist .item");for(var i=0;i<it.length;i++){var n=it[i].getAttribute("data-name")||"";it[i].style.display=n.indexOf(q)>=0?"":"none";}}'
        '</script>')

    return head + lic_panel + cons_panel + import_block + '</div>' + script + '</body></html>'


class H(BaseHTTPRequestHandler):
    def _send(self, code, body=None, headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if body is not None:
            data = body.encode("utf-8")
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self.end_headers()
            self.wfile.write(data)
        else:
            self.end_headers()

    def _form(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        return parse_qs(self.rfile.read(n).decode("utf-8"))

    def client_ip(self):
        xff = self.headers.get("X-Forwarded-For", "")
        if xff:
            return xff.split(",")[0].strip()
        return self.client_address[0]

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
                match = str(seat) == num
                if match:
                    touch_seat(num)
                self._send(200 if match else 403); return
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
            touch_seat(r.get("seat"))
            self._send(200, portal_page(user, r.get("seat", 1), r.get("license", ""),
                                        licrec.get("hw_email", ""), licrec.get("hw_password", "")))
        else:
            self._send(404)

    def do_POST(self):
        path = self.path.split("?")[0]
        user = token_user(cookie_token(self.headers))

        if path == "/login":
            ip = self.client_ip()
            now = time.time()
            with LOGIN_LOCK:
                fails = [t for t in LOGIN_FAILS.get(ip, []) if now - t < FAIL_WINDOW]
                LOGIN_FAILS[ip] = fails
                blocked = len(fails) >= FAIL_MAX
            if blocked:
                self._send(429, login_page(blocked=True)); return
            f = self._form()
            u = f.get("username", [""])[0].strip()
            p = f.get("password", [""])[0]
            ok_admin = ADMIN_PASSWORD and u == ADMIN_USER and hmac.compare_digest(p, ADMIN_PASSWORD)
            r = load_cfg()["consultants"].get(u)
            ok_cons = bool(r and p and hmac.compare_digest(p, str(r.get("password", ""))))
            if ok_admin or ok_cons:
                with LOGIN_LOCK:
                    LOGIN_FAILS.pop(ip, None)
                dest = "/admin" if ok_admin else "/"
                self._redir(dest, cookie=self._cookie(sign(u, int(time.time()) + TTL))); return
            with LOGIN_LOCK:
                LOGIN_FAILS.setdefault(ip, []).append(now)
            self._send(200, login_page(error=True))
            return

        if path == "/keepalive":
            # Battement du portail consultant : garde son poste allume tant qu'il
            # travaille (utilise par les postes a la demande).
            if user and user != ADMIN_USER:
                r = load_cfg()["consultants"].get(user)
                if r:
                    touch_seat(r.get("seat"))
            self._send(204); return

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
                "fp_win": pick_win(cfg),
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

        elif path == "/admin/lic-edit":
            name = f.get("name", [""])[0].strip()
            if name not in cfg["licenses"]:
                self._send(200, admin_page(cfg, running_seats(), err="Licence inconnue.")); return
            port = f.get("port", [""])[0].strip()
            if port:
                if not (port.isdigit() and 1 <= int(port) <= 65535):
                    self._send(200, admin_page(cfg, running_seats(), err="Port invalide.")); return
                new_port = int(port)
                if any(k != name and int(l.get("port", 0)) == new_port for k, l in cfg["licenses"].items()):
                    self._send(200, admin_page(cfg, running_seats(), err="Ce port est deja utilise par une autre licence.")); return
                cfg["licenses"][name]["port"] = new_port
            cfg["licenses"][name]["hw_email"] = f.get("hw_email", [""])[0].strip()
            newpw = f.get("hw_password", [""])[0]
            if newpw:
                cfg["licenses"][name]["hw_password"] = newpw
            save_cfg(cfg)
            self._redir("/admin")

        elif path == "/admin/lic-test":
            name = f.get("name", [""])[0].strip()
            if name not in cfg["licenses"]:
                self._redir("/admin"); return
            try:
                ip = proxy_exit_ip(name)
                cfg["licenses"][name]["ip"] = ip
                save_cfg(cfg)
                self._send(200, admin_page(load_cfg(), running_seats(),
                    msg="Licence %s : sortie confirmee sur l'IP %s." % (name, ip))); return
            except Exception:
                self._send(200, admin_page(cfg, running_seats(),
                    err="Test impossible pour %s. Le proxy n'est peut-etre pas encore demarre : relance la synchro et reessaie." % name)); return

        elif path == "/admin/edit":
            u = f.get("username", [""])[0].strip()
            if u not in cfg["consultants"]:
                self._send(200, admin_page(cfg, running_seats(), err="Consultant inconnu.")); return
            licn = f.get("license", [""])[0].strip()
            if licn and licn not in cfg["licenses"]:
                self._send(200, admin_page(cfg, running_seats(), err="Licence inconnue.")); return
            newpw = f.get("password", [""])[0]
            if newpw:
                cfg["consultants"][u]["password"] = newpw
            if licn:
                cfg["consultants"][u]["license"] = licn
            save_cfg(cfg)
            self._redir("/admin")

        elif path == "/admin/bulk":
            licn = f.get("license", [""])[0].strip()
            if licn not in cfg["licenses"]:
                self._send(200, admin_page(cfg, running_seats(), err="Choisis une licence pour l'import.")); return
            created = []
            skipped = []
            for line in f.get("list", [""])[0].splitlines():
                person = parse_person(line)
                if not person:
                    continue
                disp, pw = person
                base = slugify(disp)
                if not base:
                    skipped.append(disp); continue
                login = unique_login(cfg, base)
                cfg["consultants"][login] = {"password": pw, "license": licn, "seat": next_seat(cfg)}
                created.append({"user": login, "pw": pw, "license": licn})
            save_cfg(cfg)
            m = "%d consultant(s) ajoute(s) a la licence %s." % (len(created), licn)
            e = ("Ignores : " + ", ".join(skipped)) if skipped else ""
            self._send(200, admin_page(load_cfg(), running_seats(), msg=m, err=e, created=created)); return

        elif path == "/admin/import":
            text = f.get("text", [""])[0]
            created = []
            new_lics = 0
            skipped = []
            current = None
            for raw in text.splitlines():
                s = raw.strip()
                if not s:
                    continue
                if s.startswith("#"):
                    nm_parts = []
                    port = None
                    hello = None
                    for t in s[1:].split():
                        low = t.lower()
                        if low.startswith("port="):
                            port = t.split("=", 1)[1]
                        elif low.startswith("hello=") or low.startswith("email="):
                            hello = t.split("=", 1)[1]
                        else:
                            nm_parts.append(t)
                    nm = slugify(" ".join(nm_parts))
                    if not nm:
                        current = None; skipped.append(s); continue
                    if nm not in cfg["licenses"]:
                        if port and port.isdigit() and 1 <= int(port) <= 65535 and not any(int(l.get("port", 0)) == int(port) for l in cfg["licenses"].values()):
                            pv = int(port)
                        else:
                            pv = next_port(cfg)
                        if pv is None:
                            current = None; skipped.append(s + " (plus de port disponible)"); continue
                        cfg["licenses"][nm] = {"port": pv, "hw_email": (hello or ""), "hw_password": "", "fp_win": pick_win(cfg)}
                        new_lics += 1
                    elif hello:
                        cfg["licenses"][nm]["hw_email"] = hello
                    current = nm
                else:
                    if not current:
                        skipped.append(s); continue
                    person = parse_person(s)
                    if not person:
                        continue
                    disp, pw = person
                    base = slugify(disp)
                    if not base:
                        skipped.append(disp); continue
                    login = unique_login(cfg, base)
                    cfg["consultants"][login] = {"password": pw, "license": current, "seat": next_seat(cfg)}
                    created.append({"user": login, "pw": pw, "license": current})
            save_cfg(cfg)
            m = "Import termine : %d groupe(s) cree(s), %d consultant(s) ajoute(s)." % (new_lics, len(created))
            e = ""
            if skipped:
                e = "Lignes ignorees : " + ", ".join(skipped[:10]) + (" ..." if len(skipped) > 10 else "")
            self._send(200, admin_page(load_cfg(), running_seats(), msg=m, err=e, created=created)); return

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
