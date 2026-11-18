# MétréToit — métrage automatique de toiture à distance

Application web (SaaS) pour artisans couvreurs. On saisit une adresse, l'application détecte les pans de la
toiture à partir d'un relevé 3D aérien et calcule automatiquement :

- surface totale et surface de chaque pan (vraie grandeur, rampant), surface avec majoration pour chutes ;
- pente de chaque pan (en degrés et en %) et orientation ;
- linéaires : **faîtages, arêtiers, noues, égouts, rives, solins / rives hautes, changements de pente** ;
- rapport **PDF** à l'en-tête de l'entreprise : vue aérienne annotée, plan coté des longueurs, plan des pans,
  tableaux récapitulatifs, détail de chaque arête.

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

- `GOOGLE_MAPS_API_KEY` : active Google Solar API (APIs à activer : *Solar API*, *Geocoding API*).
- `ALLOW_SIGNUP=false` : ferme les inscriptions publiques (usage interne d'une seule entreprise).
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` : active les abonnements payants
  (essai gratuit de `TRIAL_STUDIES` études, puis abonnement). Webhook Stripe à déclarer sur
  `https://<domaine>/api/billing/webhook` (événements `checkout.session.completed`, `customer.subscription.*`).

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
