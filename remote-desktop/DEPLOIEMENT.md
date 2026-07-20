# Déploiement — Bureau à distance (sourcing)

Navigateurs streamés derrière une IP fixe Oxylabs, accessibles par un simple
lien web (aucune installation côté consultant). Charte identique à l'extension.

> ⚠️ Ce dossier est un **scaffold à déployer et ajuster sur ton VPS**. Il n'a pas
> pu être exécuté dans l'environnement de dev (pas de Docker/navigateur/sortie
> réseau). Les points à vérifier en réel sont signalés « À TESTER ».

## Prérequis
- Un **VPS** (Ubuntu/Debian), 4-8 vCPU / 8-16 Go recommandés (le streaming est gourmand).
- **Docker** + **Docker Compose** installés.
- Un **sous-domaine** (ex. `app.tondomaine.com`) dont le DNS **A** pointe vers l'IP du VPS.
- Ports **80** et **443** ouverts (HTTPS auto via Caddy).
- Tes identifiants **Oxylabs ISP** (user + mot de passe).

## Mise en place (5 étapes)

```bash
# 1. Récupérer le code
git clone <ton-repo> && cd remote-desktop     # (ce dossier)

# 2. Config
cp .env.example .env
#   -> remplis OXY_USER / OXY_PASS / OXY_PORT_G1, PORTAL_DOMAIN, PORTAL_USER

# 3. Générer le hash du mot de passe du portail
docker run --rm caddy:2 caddy hash-password --plaintext "tonMotDePasse"
#   -> colle le résultat dans PORTAL_PASS_HASH du .env

# 4. Lancer
docker compose up -d

# 5. Ouvrir
#   https://app.tondomaine.com  (login = PORTAL_USER / ton mot de passe)
```

## Vérifier que l'IP est la bonne (À TESTER)
Dans un siège ouvert, va sur `https://ip.oxylabs.io/location` :
tu dois voir l'IP fixe du groupe (ex. **31.98.21.135** pour le port 8001).
Si l'IP est celle du VPS → le proxy n'est pas pris en compte (voir Dépannage).

## Ajouter des consultants / des groupes
- **+1 consultant (même groupe / même IP)** : dans `docker-compose.yml`, duplique
  un bloc `seat-N` (change juste le nom), et ajoute une route `/sN/*` dans le
  `Caddyfile` + une carte dans `portal/index.html`.
- **+1 groupe (autre IP)** : duplique `proxy-groupe1` en `proxy-groupe2` avec
  `OXY_PORT_G2` (ex. 8002 → autre IP), et fais pointer ses sièges dessus.

## Fingerprint identique pour tous
Les sièges utilisent la **même image** + le **même UA/timezone** (`.env`) →
même fingerprint, **canvas inclus** (rendu identique car environnement
identique). Rien à faire de plus. GoLogin n'est pas nécessaire ici.

## Dépannage (À TESTER)
- **L'IP affichée est celle du VPS** : le mot de passe Oxylabs contient
  peut-être un caractère spécial non encodé → encode-le en URL dans `OXY_PASS`
  (`@`→`%40`, `:`→`%3A`…). Vérifie aussi le port (`OXY_PORT_G1`).
- **Le siège ne s'affiche pas / écran gris** : Selkies/noVNC derrière un
  sous-chemin (`/s1/`) peut avoir besoin d'un sous-domaine dédié plutôt qu'un
  sous-chemin. Alternative : `s1.app.tondomaine.com` (wildcard DNS + Caddy).
- **HTTPS ne se génère pas** : vérifie que le DNS pointe bien vers le VPS et que
  les ports 80/443 sont ouverts.
- **Lag / rame** : augmente le VPS (CPU) ou réduis le nombre de sièges simultanés.

## Sécurité
- Le `.env` (identifiants Oxylabs) reste **sur le serveur**, jamais chez les consultants.
- L'accès est protégé par login (Caddy basicauth). Change le mot de passe régulièrement.
- Pour une gestion multi-utilisateurs plus fine (comptes individuels, quotas,
  sessions), l'évolution naturelle est **Kasm Workspaces** — même principe, portail intégré.
