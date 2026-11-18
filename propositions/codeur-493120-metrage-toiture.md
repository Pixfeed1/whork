# Codeur #493120 – Métrage automatique de toiture (Google Solar API)

Client : Ridha Guérin – GUÉRIN COUVERTURE (Saint-Martin-de-Ré)
Budget affiché : 500 € à 1 000 €
Lien : https://www.codeur.com/projects/493120-creation-application-avec-solar-api-pour-entreprise-de-couverture

> Avant d'envoyer : remplacer les `[CROCHETS]` (nom, références, lien portfolio).
> Prix proposé : 990 € pour le MVP (dans le budget), phase 2 chiffrée à part.
> Le périmètre complet décrit dans l'annonce représente plutôt 6 000 à 10 000 € :
> on le dit franchement, et on fait du MVP une vraie preuve de précision.

---

## 1. Message à coller dans l'offre Codeur

**Montant : 990 € HT – Délai : 3 semaines**

Bonjour M. Guérin,

Votre projet m'intéresse beaucoup, et j'ai déjà vérifié deux points clés pour vous.

**1. Google Solar API ne suffit pas seule, mais il existe une solution.**
L'API donne pour chaque pan sa pente, son orientation et sa surface réelle. En revanche, elle ne donne ni le contour exact des pans ni les linéaires (faîtage, égout, rive, noue, arêtier). Ces informations se calculent à partir du modèle 3D de surface (DSM) que fournit aussi Google, avec une précision allant jusqu'à 10 cm par pixel. Je découpe chaque pan comme un plan 3D, je calcule les intersections entre plans, puis je classe chaque arête :
- une arête horizontale haute est un faîtage ;
- une arête inclinée saillante est un arêtier ;
- une arête inclinée rentrante est une noue ;
- une arête basse horizontale est un égout ;
- une arête de bord inclinée est une rive.

**2. Pour la France, il existe mieux et gratuit : le LiDAR HD de l'IGN.**
La Charente-Maritime est couverte par ce relevé laser public (environ 10 points/m²). Quand Google est imprécis ou absent, ce qui arrive souvent hors des grandes villes, l'application bascule sur le LiDAR de l'IGN et l'orthophoto 20 cm. C'est un vrai avantage pour un outil français par rapport aux solutions américaines.

**Ce que je propose pour le MVP (990 €, 3 semaines) :**
- Recherche par adresse et vue aérienne de la toiture.
- Détection automatique des pans, avec leur surface réelle et leur pente.
- Calcul automatique des faîtages, égouts, rives, noues et arêtiers.
- Éditeur pour corriger un contour ou changer le type d'une arête, avec recalcul instantané.
- Rapport PDF : adresse, vue annotée, tableau des métrés, pentes, logo et coordonnées.
- Sauvegarde et historique des études, avec un accès sécurisé par identifiant.
- **Test de précision sur 5 à 10 toitures que vous avez déjà métrées.** Vous recevez un tableau d'écarts. L'objectif est un écart inférieur à 5 % sur les surfaces.

**Ensuite, si les résultats vous conviennent (phase 2, chiffrée à part) :** comptes multi-entreprises, abonnements Stripe, export vers les logiciels de devis, détection des éléments de toiture (fenêtres de toit, cheminées) et amélioration continue de la détection.

**Coûts d'usage estimés :** environ 0,10 € par étude en API Google après la gratuité mensuelle (le LiDAR IGN est gratuit), plus 15 à 30 €/mois d'hébergement en France.

**Code source :** il vous appartient entièrement. Il est livré sur votre dépôt GitHub, avec la documentation, 30 jours de garantie corrective et un contrat de maintenance optionnel.

Je peux vous montrer un premier calcul sur une toiture de votre choix avant même de démarrer. Envoyez-moi simplement une adresse.

Bien cordialement,
[VOTRE NOM]
[LIEN PORTFOLIO / RÉFÉRENCES]

---

## 2. Annexe technique (à envoyer si le client demande le détail)

### 2.1 Faisabilité technique

| Besoin | Source | Méthode | Fiabilité |
|---|---|---|---|
| Surface par pan, pente, orientation | Solar API `buildingInsights:findClosest` (`roofSegmentStats`) | Lecture directe : surface inclinée, pente en degrés, azimut | Bonne si la qualité est HIGH ou MEDIUM |
| Contours des pans | Solar API `dataLayers:get` (DSM + masque, 0,1 à 0,5 m/px) ou IGN LiDAR HD | Ajustement de plans (RANSAC) sur le DSM, guidé par les pentes et azimuts Google, puis vectorisation | Bonne sur toitures simples à moyennes, correction manuelle prévue |
| Faîtages, noues, arêtiers | Plans 3D calculés | Intersection de plans adjacents et classement selon la convexité et l'inclinaison | Bonne |
| Égouts, rives | Bord du toit et plans | Arête de bord horizontale = égout ; arête de bord inclinée = rive | Bonne, avec un léger risque sur les débords de toit |
| Longueurs réelles | Géométrie 3D | Longueur 3D (et pas la projection au sol) | Même précision que les plans |

**Points de vigilance, dits honnêtement :**
- La couverture Google en zone rurale ou insulaire est variable. On vérifie l'Île de Ré en premier jour, ce qui détermine la source principale.
- La date des images Google peut avoir plusieurs années. Elle est indiquée dans le rapport.
- La végétation qui recouvre le toit et les débords de toiture sont les principales sources d'erreur, d'où l'éditeur manuel.
- Le LiDAR HD IGN est en open data (licence Etalab). Sa disponibilité exacte sur la zone reste à confirmer sur la carte de suivi IGN.

### 2.2 Technologies proposées

- **Interface :** Next.js + TypeScript, MapLibre GL (carte et édition des polygones), responsive pour mobile et tablette.
- **Moteur géométrique :** Python FastAPI, avec rasterio, numpy, shapely, pyproj, et laspy/PDAL pour le LiDAR.
- **Données :** PostgreSQL + PostGIS (Supabase : authentification incluse, hébergement en UE).
- **PDF :** rendu HTML vers PDF (Playwright), avec la vue aérienne annotée en image.
- **Hébergement :** Scaleway ou OVH (France, conforme RGPD).

### 2.3 Calendrier du MVP (3 semaines)

| Semaine | Livrable |
|---|---|
| S1 | Vérification de la couverture Google sur 10 adresses de l'île, intégration Solar API et IGN, extraction automatique des pans |
| S2 | Calcul et classement des linéaires, éditeur manuel, sauvegarde et historique |
| S3 | Rapport PDF, authentification, déploiement, **test de précision sur vos toitures**, recette |

### 2.4 Budget

| Phase | Contenu | Prix |
|---|---|---|
| MVP | Tout ce qui est listé ci-dessus, pour un utilisateur ou une entreprise | **990 € HT** |
| Phase 2 (optionnelle) | Multi-comptes, abonnements, back-office, détection des éléments de toiture, exports | Sur devis après le MVP (ordre de grandeur : 3 500 à 6 000 €) |
| Maintenance (optionnelle) | Mises à jour, suivi des API, petites évolutions | [XX] €/mois |

### 2.5 Coûts d'utilisation (estimation à confirmer sur la grille Google en vigueur)

- **Solar API Data Layers :** quota gratuit mensuel, puis environ 75 $ pour 1 000 requêtes, soit environ 0,07 € par étude.
- **Solar API Building Insights :** coût bien plus faible (SKU Essentials).
- **Géocodage et tuiles :** quelques centimes par étude.
- **IGN LiDAR HD et orthophotos :** gratuits.
- **Hébergement :** 15 à 30 €/mois au démarrage.

Au total : **environ 0,10 à 0,15 € par rapport**, ce qui laisse une marge confortable pour un abonnement à 29–79 €/mois.

### 2.6 Livraison, propriété, maintenance

- Code source cédé intégralement, sur un dépôt GitHub au nom du client.
- Clés API Google ouvertes sur le compte du client, qui paie directement à l'usage.
- Documentation d'installation et d'architecture.
- 30 jours de garantie corrective après la livraison.
- Maintenance et évolutions en option, au forfait ou au temps passé.
