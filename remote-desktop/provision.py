#!/usr/bin/env python3
# Genere docker-compose.override.yml (un poste par compte) et le Caddyfile
# (routes par poste) a partir de users.json. Lance par apply.sh / le sync systemd.
# NE PAS editer les fichiers generes a la main.

import json, os

BASE = os.path.dirname(os.path.abspath(__file__))

try:
    with open(os.path.join(BASE, "users.json")) as f:
        users = json.load(f)
except Exception:
    users = {}

seats = sorted({int(r["seat"]) for r in users.values() if "seat" in r})

# --- docker-compose.override.yml ---
lines = ["# Genere automatiquement a partir de users.json. NE PAS editer.\n", "services:\n"]
if not seats:
    lines = ["# Genere automatiquement. Aucun poste (aucun compte).\n", "services: {}\n"]
else:
    for s in seats:
        lines.append(
"""  seat-%d:
    image: lscr.io/linuxserver/chromium:latest
    depends_on: [proxy-groupe1]
    security_opt: [seccomp:unconfined]
    shm_size: "1gb"
    restart: unless-stopped
    networks: [interne]
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=${FP_TZ}
      - LC_ALL=fr_FR.UTF-8
      - TITLE=Sourcing
      - CHROME_CLI=--proxy-server=http://proxy-groupe1:8080 --lang=fr-FR --start-maximized https://www.hellowork.com/
""" % s)
with open(os.path.join(BASE, "docker-compose.override.yml"), "w") as f:
    f.write("".join(lines))

# --- Caddyfile (a partir du template) ---
routes = "\n".join(
    "\t\thandle_path /s%d/* { reverse_proxy seat-%d:3000 }" % (s, s) for s in seats
)
with open(os.path.join(BASE, "Caddyfile.template")) as f:
    tpl = f.read()
with open(os.path.join(BASE, "Caddyfile"), "w") as f:
    f.write(tpl.replace("{{ROUTES}}", routes))

print("Postes provisionnes:", seats or "(aucun)")
