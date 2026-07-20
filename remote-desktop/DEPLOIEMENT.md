# Déploiement — Bureau à distance (sourcing)

Navigateurs streamés derrière une IP fixe Oxylabs, accessibles par un simple
lien web (aucune installation côté consultant). Charte identique à l'extension.

> ⚠️ Ce dossier est un **scaffold à déployer et ajuster sur ton serveur**. Il n'a
> pas pu être exécuté dans l'environnement de dev. Points à valider = « À TESTER ».

## Ta config (serveur dédié + cPanel)
- Docker OK, lancé **en tant que ton user** (groupe `docker`) — pas besoin de sudo pour Docker.
- **cPanel/Apache occupe déjà 80/443.** Donc : le stack écoute en local sur
  **`127.0.0.1:8080`**, et **cPanel garde le HTTPS** de `talens.pixfeed.net` en
  redirigeant vers ce port.
- On ne met **rien** dans le dossier `~/talens.pixfeed.net` (racine web cPanel).
  Le stack va dans `~/remote-desktop`.

## Étape 1 — Déployer le stack Docker (aucun root nécessaire)

```bash
cd ~
git clone <ton-repo> whork          # si pas déjà cloné
cd whork
git checkout claude/admin-interface-user-login-ojaui8
cd remote-desktop

cp .env.example .env
#   -> remplis OXY_USER / OXY_PASS / OXY_PORT_G1 (8001), PORTAL_USER

# Hash du mot de passe du portail :
docker run --rm caddy:2 caddy hash-password --plaintext "tonMotDePasse"
#   -> colle-le dans PORTAL_PASS_HASH du .env

docker compose up -d

# Vérifie que le routeur répond en local (401 = normal, l'auth marche) :
curl -si http://127.0.0.1:8080/ | head -n 1
```

## Étape 2 — Vérifier l'IP fixe (À TESTER)
Une fois exposé (étape 3), ouvre un siège et va sur `https://ip.oxylabs.io/location` :
tu dois voir **31.98.21.135** (port 8001). Si c'est l'IP du serveur → voir Dépannage.

## Étape 3 — Brancher `talens.pixfeed.net` sur le stack

Comme cPanel tient déjà le HTTPS du sous-domaine, on lui fait **reverse-proxy**
vers `127.0.0.1:8080`, **avec support WebSocket** (indispensable pour le streaming).

### Option A — cPanel/Apache (tu as root, tout reste sur ton serveur)
En root, crée l'include du vhost SSL du sous-domaine :

```bash
# Adapte <USER> (ton user cPanel) et le chemin exact si besoin.
mkdir -p /etc/apache2/conf.d/userdata/ssl/2_4/jurojinn/talens.pixfeed.net/
cat > /etc/apache2/conf.d/userdata/ssl/2_4/jurojinn/talens.pixfeed.net/remote.conf <<'EOF'
RewriteEngine On
# WebSocket -> proxifie en ws://
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteRule /(.*) ws://127.0.0.1:8080/$1 [P,L]
# HTTP normal
RewriteCond %{HTTP:Upgrade} !=websocket [NC]
RewriteRule /(.*) http://127.0.0.1:8080/$1 [P,L]
ProxyPreserveHost On
EOF

# Recharge la conf cPanel + Apache
/usr/local/cpanel/scripts/ensure_vhost_includes --user=jurojinn --domains=talens.pixfeed.net
apachectl configtest && apachectl graceful
```

> Modules requis (EA4) : `proxy`, `proxy_http`, `proxy_wstunnel`, `rewrite`.
> S'ils manquent : WHM → EasyApache 4 → active-les.

### Option B — Cloudflare Tunnel (si le DNS de pixfeed.net est/peut être sur Cloudflare)
Plus robuste pour le WebSocket, et n'utilise ni 80/443 ni Apache. Dis-le-moi et
je t'ajoute le conteneur `cloudflared` au `docker-compose.yml` + la commande.

## Ajouter des consultants / groupes
- **+1 consultant (même IP)** : duplique un bloc `seat-N` dans `docker-compose.yml`,
  ajoute la route `/sN/*` dans le `Caddyfile` et une carte dans `portal/index.html`.
- **+1 groupe (autre IP)** : duplique `proxy-groupe1` (`OXY_PORT_G2=8002`…) et fais
  pointer ses sièges dessus.

## Fingerprint identique pour tous
Images identiques + même UA/timezone (`.env`) → même fingerprint, **canvas inclus**
(rendu identique car environnement identique). GoLogin inutile ; Oxylabs conservé.

## Dépannage (À TESTER)
- **IP = celle du serveur** : mot de passe Oxylabs avec caractère spécial non
  encodé (`@`→`%40`…), ou mauvais port. Vérifie `OXY_PASS` / `OXY_PORT_G1`.
- **Écran gris / siège ne charge pas** : Selkies/noVNC sous un sous-chemin `/s1/`
  peut nécessiter un **sous-domaine par siège** (`s1.talens.pixfeed.net`) plutôt
  qu'un sous-chemin. Dis-le-moi, je bascule la conf dans ce sens.
- **502/erreur proxy** : le stack n'écoute pas — `docker compose ps` / `docker compose logs`.

## Sécurité
- Le `.env` (identifiants Oxylabs) reste **sur le serveur**, jamais chez les consultants.
- Accès protégé par login (Caddy basicauth) + HTTPS cPanel.
