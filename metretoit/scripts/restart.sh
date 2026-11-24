#!/usr/bin/env bash
# Redémarre Relevéo proprement : arrête l'instance qui occupe le port, relance, vérifie.
# Relevéo a besoin de Node.js 22 ou plus (base intégrée node:sqlite) : voir scripts/node22.sh.
cd "$(dirname "$0")/.." || exit 1
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2); PORT=${PORT:-3000}
. scripts/node22.sh || exit 1

LOG="$HOME/apps/metretoit.log"

# Si Relevéo tourne comme service système (deploy/releveo.service), c'est systemd qui le relance :
# il suffit d'arrêter le processus (il appartient à l'utilisateur, pas besoin d'être root),
# systemd le redémarre aussitôt avec le nouveau code.
if systemctl is-active --quiet releveo 2>/dev/null; then
  PID=$(systemctl show -p MainPID --value releveo 2>/dev/null)
  echo "===== $(date -u +%FT%TZ) relance du service releveo (${RESTART_REASON:-à la main}), instance précédente : ${PID:-?} =====" >> "$LOG" 2>/dev/null
  [ -n "$PID" ] && [ "$PID" != "0" ] && kill "$PID"
  for i in $(seq 1 20); do
    sleep 1
    NEW=$(systemctl show -p MainPID --value releveo 2>/dev/null)
    if [ "$NEW" != "$PID" ] && curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null; then
      echo "Relevéo (service système) redémarré sur le port $PORT (page d'accueil : $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/))"
      exit 0
    fi
  done
  echo "Le service releveo ne répond pas. Diagnostic (en root) : systemctl status releveo"; tail -8 "$LOG"
  exit 1
fi
mkdir -p "$(dirname "$LOG")"
# journal conservé d'une relance à l'autre (au-delà de 5 Mo, l'ancien part dans metretoit.log.1)
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ]; then mv -f "$LOG" "$LOG.1"; fi
QUI=${RESTART_REASON:-"à la main"}
PID=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)
if [ -n "$PID" ]; then kill "$PID"; sleep 2; fi
echo "===== $(date -u +%FT%TZ) relance ($QUI), instance précédente : ${PID:-aucune} =====" >> "$LOG"
# setsid : l'application est détachée de la session SSH ou de la crontab qui la lance,
# elle ne s'arrête donc pas quand on se déconnecte
setsid nohup npm start >> "$LOG" 2>&1 < /dev/null &
sleep 4
if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  echo "Relevéo redémarré sur le port $PORT avec Node $("$NODE" -v) ($NODE) (page d'accueil : $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/))"
else
  echo "Échec du démarrage (Node $("$NODE" -v), $NODE). Dernières lignes du journal :"; tail -8 "$LOG"
fi
