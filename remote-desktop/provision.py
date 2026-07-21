#!/usr/bin/env python3
# Genere docker-compose.override.yml et le Caddyfile a partir de config.json :
#   - un proxy gost par LICENCE (sortie sur l'IP fixe = le port Oxylabs) ;
#   - un poste (navigateur) par CONSULTANT, via le proxy de sa licence ;
#   - une route Caddy par poste.
# Fichiers generes : ne pas editer a la main. Lance par apply.sh / sync systemd.

import json, os, re

BASE = os.path.dirname(os.path.abspath(__file__))


def safe(name):
    return re.sub(r"[^a-z0-9]", "-", str(name).lower()).strip("-") or "x"


try:
    with open(os.path.join(BASE, "config.json")) as f:
        cfg = json.load(f)
except Exception:
    cfg = {}
lics = cfg.get("licenses", {}) or {}
cons = cfg.get("consultants", {}) or {}

blocks = []

# --- un proxy par licence ---
for name, l in sorted(lics.items()):
    try:
        port = int(l["port"])
    except Exception:
        continue
    blocks.append(
"""  proxy-%s:
    image: ginuerzh/gost:latest
    command: -L=http://:8080 -F=http://isp.oxylabs.io:%d
    restart: unless-stopped
    networks: [interne]
""" % (safe(name), port))

# --- un poste par consultant (via le proxy de sa licence) ---
routes = []
seat_vols = []
for login, c in sorted(cons.items()):
    lic = c.get("license")
    if lic not in lics:
        continue
    try:
        seat = int(c["seat"])
    except Exception:
        continue
    pname = "proxy-" + safe(lic)
    # Taille de fenetre propre a la licence : empreinte differente entre groupes,
    # identique a l'interieur d'un groupe (tous les postes de la licence).
    win = lics[lic].get("fp_win")
    sizing = ("--window-size=%s" % win) if win else "--start-maximized"
    blocks.append(
"""  seat-%d:
    image: lscr.io/linuxserver/chromium:latest
    depends_on: [%s]
    security_opt: [seccomp:unconfined]
    shm_size: "1gb"
    mem_limit: "${SEAT_MEM:-3g}"
    restart: unless-stopped
    networks: [interne]
    volumes:
      - seat-%d-data:/config
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=${FP_TZ}
      - LC_ALL=fr_FR.UTF-8
      - TITLE=Sourcing
      - CHROME_CLI=--proxy-server=http://%s:8080 --lang=fr-FR %s https://www.hellowork.com/
""" % (seat, pname, seat, pname, sizing))
    routes.append("\t\thandle_path /s%d/* {\n\t\t\treverse_proxy seat-%d:3000\n\t\t}" % (seat, seat))
    seat_vols.append(seat)

# --- ecriture override ---
if blocks:
    override = "# Genere a partir de config.json. NE PAS editer.\nservices:\n" + "".join(blocks)
else:
    override = "# Genere a partir de config.json. Aucune licence/consultant.\nservices: {}\n"
# Volumes persistants : chaque poste garde sa session hellowork (cookies/login).
if seat_vols:
    override += "\nvolumes:\n" + "".join("  seat-%d-data:\n" % s for s in seat_vols)
with open(os.path.join(BASE, "docker-compose.override.yml"), "w") as f:
    f.write(override)

# --- ecriture Caddyfile ---
with open(os.path.join(BASE, "Caddyfile.template")) as f:
    tpl = f.read()
with open(os.path.join(BASE, "Caddyfile"), "w") as f:
    f.write(tpl.replace("{{ROUTES}}", "\n".join(routes)))

print("Licences:", sorted(lics), "| Postes:", len(routes))
