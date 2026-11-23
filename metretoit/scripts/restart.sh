#!/usr/bin/env bash
# Redémarre Relevéo proprement : arrête l'instance qui occupe le port, relance, vérifie.
# Relevéo a besoin de Node.js 22 ou plus (base intégrée node:sqlite) : voir scripts/node22.sh.
cd "$(dirname "$0")/.." || exit 1
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2); PORT=${PORT:-3000}
. scripts/node22.sh || exit 1

PID=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)
if [ -n "$PID" ]; then kill "$PID"; sleep 2; fi
nohup npm start > "$HOME/apps/metretoit.log" 2>&1 &
sleep 4
if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  echo "Relevéo redémarré sur le port $PORT avec Node $("$NODE" -v) ($NODE) (page d'accueil : $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/))"
else
  echo "Échec du démarrage (Node $("$NODE" -v), $NODE). Dernières lignes du journal :"; tail -8 "$HOME/apps/metretoit.log"
fi
