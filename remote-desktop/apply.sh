#!/bin/sh
# Synchronise proxys + postes avec config.json : (re)genere l'override et le
# Caddyfile, applique, puis ecrit l'etat des postes (status.json).
set -e
cd "$(dirname "$0")"

[ -f config.json ] || echo '{"licenses":{},"consultants":{}}' > config.json
[ -f status.json ] || echo '{"running":[]}' > status.json

python3 provision.py
docker compose up -d --remove-orphans

# Recharge la config Caddy sans coupure (fallback : restart).
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null \
  || docker compose restart caddy

# Etat des postes en marche -> status.json (affiche dans l'admin).
RUN=$(docker compose ps --status running --services 2>/dev/null | sed -n 's/^seat-\([0-9]\{1,\}\)$/\1/p' | paste -sd, -)
echo "{\"running\":[${RUN}]}" > status.json

echo "Applique. Postes actifs: [${RUN}]"
