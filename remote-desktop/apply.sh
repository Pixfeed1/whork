#!/bin/sh
# Synchronise proxys + postes avec config.json : (re)genere l'override et le
# Caddyfile quand la config change, applique, puis ecrit l'etat des postes.
#
# Mode "postes a la demande" (ONDEMAND=1 dans .env) : seuls les postes vus
# recemment (battement du portail consultant, ecrit dans activity.json) sont
# demarres ; les autres sont arretes. Evite de faire tourner des navigateurs
# pour rien. Par defaut (ONDEMAND absent ou 0) : tous les postes tournent.
set -e
cd "$(dirname "$0")"

[ -f config.json ] || echo '{"licenses":{},"consultants":{}}' > config.json
[ -f status.json ] || echo '{"running":[]}' > status.json
[ -f activity.json ] || echo '{}' > activity.json

# Lecture prudente de deux reglages dans .env (sans sourcer tout le fichier).
ONDEMAND=$(sed -n 's/^ONDEMAND=//p' .env 2>/dev/null | tr -d '\r' | tail -1)
IDLE_MINUTES=$(sed -n 's/^IDLE_MINUTES=//p' .env 2>/dev/null | tr -d '\r' | tail -1)
[ -n "$ONDEMAND" ] || ONDEMAND=0
[ -n "$IDLE_MINUTES" ] || IDLE_MINUTES=5

# Regenere l'override + le Caddyfile uniquement si config.json a change.
HASH=$(md5sum config.json 2>/dev/null | cut -d' ' -f1)
LAST=$(cat .last-hash 2>/dev/null || true)
CHANGED=0
if [ "$HASH" != "$LAST" ]; then
  python3 provision.py
  CHANGED=1
fi

INFRA=$(docker compose config --services 2>/dev/null | grep -E '^(auth|caddy|proxy-)' || true)
ALL_SEATS=$(docker compose config --services 2>/dev/null | sed -n 's/^seat-\([0-9]\{1,\}\)$/\1/p')

if [ "$ONDEMAND" = "1" ]; then
  # Infra (auth, caddy, proxys) toujours active : bascule instantanee des postes.
  docker compose up -d --remove-orphans $INFRA

  # Postes voulus = consultants vus il y a moins de IDLE_MINUTES.
  WANTED=$(IDLE="$IDLE_MINUTES" python3 - <<'PY'
import json, os, time
idle = int(os.environ["IDLE"]) * 60
try:
    a = json.load(open("activity.json"))
    if not isinstance(a, dict):
        a = {}
except Exception:
    a = {}
now = time.time()
print(" ".join(s for s, ts in a.items() if now - float(ts) < idle))
PY
)
  START=""
  for s in $WANTED; do START="$START seat-$s"; done
  [ -n "$START" ] && docker compose up -d $START

  # Postes non voulus mais en marche -> arret (la session hellowork reste dans
  # le volume du poste, rien n'est perdu).
  for s in $ALL_SEATS; do
    keep=0
    for w in $WANTED; do [ "$s" = "$w" ] && keep=1; done
    if [ "$keep" = "0" ]; then
      docker compose stop "seat-$s" >/dev/null 2>&1 || true
    fi
  done
else
  # Mode simple : tous les postes tournent en permanence.
  if [ "$CHANGED" = "1" ]; then
    docker compose up -d --remove-orphans
  fi
fi

# Recharge Caddy seulement si la config a change (pas a chaque passage).
if [ "$CHANGED" = "1" ]; then
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null \
    || docker compose restart caddy
  echo "$HASH" > .last-hash
fi

# Etat des postes en marche -> status.json (affiche dans l'admin).
RUN=$(docker compose ps --status running --services 2>/dev/null | sed -n 's/^seat-\([0-9]\{1,\}\)$/\1/p' | paste -sd, -)
echo "{\"running\":[${RUN}]}" > status.json

echo "Applique. ONDEMAND=$ONDEMAND Postes actifs: [${RUN}]"
