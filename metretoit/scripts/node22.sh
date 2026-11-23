#!/usr/bin/env bash
# À inclure (source) : trouve un Node.js 22 ou plus et le place en tête du PATH (avec son npm).
# Le « node » par défaut peut être plus ancien (crontab, cPanel…). Chemin imposable : NODE_BIN=… dans .env.
ENV_NODE=$(grep -E '^NODE_BIN=' .env 2>/dev/null | cut -d= -f2-)

pick_node() {
  local n v
  for n in "$NODE_BIN" "$ENV_NODE" "$(command -v node 2>/dev/null)" \
    "$HOME"/.nvm/versions/node/v2[2-9]*/bin/node \
    /opt/alt/alt-nodejs2[2-9]/root/usr/bin/node \
    /opt/cpanel/ea-nodejs2[2-9]/bin/node \
    /usr/local/bin/node /usr/bin/node; do
    [ -n "$n" ] && [ -x "$n" ] || continue
    v=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
    if [ "$v" -ge 22 ] 2>/dev/null; then echo "$n"; return 0; fi
  done
  return 1
}

NODE=$(pick_node)
if [ -z "$NODE" ]; then
  echo "Aucun Node.js 22 ou plus trouvé sur ce serveur. Versions disponibles :"
  which -a node 2>/dev/null | while read -r n; do echo "  $n -> $("$n" -v 2>/dev/null)"; done
  echo "Indiquez le bon chemin dans .env : NODE_BIN=/chemin/vers/node (version 22 ou plus)."
  exit 1
fi
# ce Node (et le npm installé avec lui) passe en premier pour toute la suite
export PATH="$(dirname "$NODE"):$PATH"

