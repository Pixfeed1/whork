#!/usr/bin/env bash
# Mise à jour complète : récupère le code, installe, compile et redémarre, avec Node.js 22 ou plus.
cd "$(dirname "$0")/.." || exit 1
git pull || exit 1
. scripts/node22.sh || exit 1
echo "Node utilisé : $(node -v) ($NODE)"
npm ci && npm run build && bash scripts/restart.sh
