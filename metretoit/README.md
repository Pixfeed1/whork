# Relevéo — métrage automatique de toiture à distance

Application web (SaaS) pour artisans couvreurs. On saisit une adresse, l'application détecte les pans de la
toiture à partir d'un relevé 3D aérien et calcule automatiquement :

- surface totale et surface de chaque pan (vraie grandeur, rampant), surface avec majoration pour chutes ;
- pente de chaque pan (en degrés et en %) et orientation ;
- linéaires : **faîtages, arêtiers, noues, égouts, rives, solins / rives hautes, changements de pente** ;
- **cheminées** (détectées automatiquement, à vérifier), **fenêtres de toit** et **lucarnes** placées en un clic,
  avec le calcul de leurs raccords : solins amont, à gradins, de base, contre-solin, abergements ;
- **métré des façades** (onglet « Façades ») : surface brute de chaque façade du sol à la toiture (pignons
  compris), murs mitoyens exclus automatiquement, hauteur à l'égout mesurée (modifiable), ouvertures saisies
  (fenêtres, portes, baies…) ou déduction en %, photo **Street View** de chaque façade visible depuis la rue,
  et une partie « Métré des façades » dans le rapport ;
- rapport **PDF** à l'en-tête de l'entreprise : vue aérienne annotée et cotée, plan coté des longueurs, plan des
  pans, **vues 3D sous 4 angles**, tableaux récapitulatifs, éléments et raccords, **surface à commander selon le
  taux de chutes** (0 à 20 %), détail de chaque arête.

Tout est corrigeable à la main : déplacer / ajouter / supprimer un sommet, dessiner ou découper un pan, modifier
la pente ou l'orientation, forcer le type d'une arête, annuler / rétablir. Enregistrement automatique.

## Sources de données

| Source | Utilisation | Coût |
|---|---|---|
| **IGN LiDAR HD** (MNS 0,5 m, Géoplateforme) | Relevé 3D principal en France métropolitaine | Gratuit (Licence Ouverte Etalab) |
| **IGN BD TOPO** (bâtiments) | Emprise du bâtiment, recalée sur le relevé 3D | Gratuit |
| **IGN BD ORTHO** (20 cm) | Fond de carte et vue aérienne du rapport | Gratuit |
| **Adresse (BAN / IGN)** | Recherche d'adresse | Gratuit |
| **Google Solar API** (optionnel) | Relevé 3D de secours (DSM 0,25 m) hors couverture IGN, contrôle croisé des surfaces | Payant à l'usage (voir plus bas) |

Le LiDAR HD de l'IGN couvre la Charente-Maritime (dont l'Île de Ré) : **l'application fonctionne sans aucune clé
Google**. La clé Google ajoute une seconde source de relevé 3D et un contrôle de cohérence.

## Comment le calcul fonctionne

1. Bâtiment : emprise BD TOPO sous l'adresse (ou bâtiments cliqués), recalée sur le relevé 3D (décalage ≤ 2 m).
2. Masque toiture : pixels au-dessus du sol (+2 m) dans l'emprise et son débord, hors bâtiments voisins.
3. Détection des pans par **croissance de régions planes** (normales + distance au plan), fusion des plans coplanaires.
4. Contour extérieur : emprise IGN + **débord de toit mesuré côté par côté** (0 sur les murs mitoyens) quand elle
   concorde avec le relevé, sinon contour du relevé redressé selon les axes du bâtiment.
5. Arêtes intérieures placées sur les **intersections exactes des plans** (faîtages, arêtiers, noues rectilignes).
6. Classement automatique de chaque arête (convexe/concave, horizontale/inclinée, sens de la pente) et calcul des
   longueurs **en vraie grandeur** (3D).

Le moteur est validé par des tests sur des toitures de synthèse (deux pans, quatre pans avec croupes, toiture en T
avec noues) : écarts < 1 % sur les surfaces et les linéaires.

## Installation (développement)

Prérequis : Node.js ≥ 22.13.

```bash
npm install
```

```bash
npm run dev
```

L'interface est servie sur http://localhost:5173 (API sur le port 3000).

```bash
npm test
```

## Mise en production

```bash
npm run build
```

```bash
npm start
```

Ou avec Docker (données persistées dans le volume `metretoit-data`) :

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

Placer l'application derrière un reverse proxy HTTPS (Caddy, Nginx, Traefik). Hébergement conseillé en France
(OVHcloud, Scaleway, Clever Cloud) : un petit serveur (2 vCPU, 2 Go) suffit, ~10 à 30 € HT / mois.
La base est un fichier SQLite dans `DATA_DIR` : sauvegarder ce dossier (copie quotidienne).

### Configuration (`.env`)

Voir `.env.example`. Principales variables :

- `GOOGLE_MAPS_API_KEY` : active les services Google. APIs à activer et à autoriser sur la clé :
  *Solar API* (relevé 3D), *Geocoding API*, *Map Tiles API* (photos HD de l'éditeur et du rapport),
  *Street View Static API* (photos des façades). Restreindre la clé à l'adresse IP du serveur.
- `ALLOW_SIGNUP=false` : ferme les inscriptions publiques (usage interne d'une seule entreprise).
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` : active les abonnements payants
  (essai gratuit de `TRIAL_STUDIES` études, puis abonnement). Webhook Stripe à déclarer sur
  `https://<domaine>/api/billing/webhook` (événements `checkout.session.completed`, `customer.subscription.*`).

### Page d'accès verrouillée (phase de test)

Pour protéger tout le site (page d'accueil comprise) par un identifiant et un mot de passe, en SSH :

```bash
npm run acces -- ridha
```

Le mot de passe est demandé deux fois (saisie invisible, 10 caractères minimum). Effet immédiat, sans
redémarrage. Changer le mot de passe referme les accès déjà ouverts.

```bash
npm run acces -- --statut
```

```bash
npm run acces -- --off
```

### E-mails et pages légales

- `SMTP_*` : active le lien « Mot de passe oublié » envoyé par e-mail (valable 1 heure). Sans SMTP, le responsable du
  compte attribue un nouveau mot de passe depuis Entreprise → Utilisateurs.
- `LEGAL_*` : informations de la société affichées dans les mentions légales, les CGU et la politique de
  confidentialité (`/mentions-legales`, `/cgu`, `/confidentialite`). Les textes sont des modèles à faire relire.

## Livrer le code sur le dépôt GitHub du client

Le dossier `metretoit/` est autonome. Pour le publier seul, avec son historique, dans un dépôt vide du client :

```bash
git subtree split --prefix=metretoit -b metretoit-livraison
```

```bash
git push https://github.com/<compte-client>/<depot>.git metretoit-livraison:main
```

## Coûts d'utilisation des API

- IGN : gratuit.
- Google Solar API (si activée) : chaque analyse appelle *Building Insights* et *Data Layers*. Data Layers est le
  poste principal (~75 $ / 1 000 requêtes au-delà du quota gratuit mensuel). Vérifier la grille en vigueur sur
  la page de tarification Google Maps Platform.

## Banc d'essai de précision

Pour mesurer la précision sur de vraies toitures déjà métrées sur site, préparer un fichier CSV :

```
adresse;surface;faitage;egout;rive;noue;aretier
12 rue X 17410 Saint-Martin-de-Ré;142,5;12,3;24,6;18,2;;
```

```bash
npm run precision -- toitures.csv resultats.csv
```

Le script affiche l'écart (en %) de chaque grandeur et l'écart moyen.

## Organisation du code

```
shared/      modèle de toiture, moteur de métré, opérations d'édition (navigateur + serveur)
server/      API Express, base SQLite, authentification, rapports PDF, abonnements
  analysis/  extraction des pans à partir du relevé 3D
  providers/ IGN Géoplateforme, Google Solar API
web/         interface React (MapLibre GL)
tests/       tests unitaires et d'API (vitest)
scripts/     parcours navigateur complet (e2e), banc de précision
```

## Limites connues

- La précision dépend du relevé : végétation surplombant le toit, petites lucarnes (< 2,5 m²) ou cheminées
  peuvent nécessiter une correction manuelle.
- Le débord de toit est mesuré au pixel près (0,5 m en LiDAR IGN) : à vérifier sur les égouts critiques.
- Les valeurs restent à confirmer sur site avant commande des matériaux (mention en pied de page des rapports).
