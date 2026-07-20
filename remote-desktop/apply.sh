#!/bin/sh
# Synchronise proxys + postes avec config.json : (re)genere l'override et le
# Caddyfile, puis applique. Lance a la main ou par le sync systemd.
set -e
cd "$(dirname "$0")"

[ -f config.json ] || echo '{"licenses":{},"consultants":{}}' > config.json

python3 provision.py
docker compose up -d --remove-orphans

# Recharge la config Caddy sans coupure (fallback : restart).
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null \
  || docker compose restart caddy

echo "Applique."
