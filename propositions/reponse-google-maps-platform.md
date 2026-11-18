# Réponse proposée à Google Maps Platform (dossier a2PHq00000B2OLoMAN)

> À envoyer par Ridha Guérin en réponse au mail de Dixi Figueroa.
> Les chiffres de volume sont des estimations à ajuster par Ridha.

---

Objet : Re: Demande d'informations à l'équipe Google Maps - a2PHq00000B2OLoMAN

Bonjour Dixi,

Merci pour votre retour et pour la documentation. Oui, Solar API correspond bien à notre cas d'usage. Voici nos réponses à vos questions :

**1) API utilisées**
- Solar API : `buildingInsights:findClosest` (pans, pentes, orientations, surfaces) et `dataLayers:get` (modèle numérique de surface, DSM).
- Geocoding API, pour la recherche d'adresses.
- Éventuellement Map Tiles API (vue satellite) dans un second temps.

**2) Rôle de la cartographie dans notre solution**
Nous développons une application web de métrage de toiture à distance pour les couvreurs. L'utilisateur saisit une adresse. L'application récupère le relevé 3D du toit, détecte automatiquement chaque pan et calcule les surfaces, les pentes et les longueurs de faîtage, de noue, d'arêtier, d'égout et de rive. Elle produit ensuite un rapport PDF qui sert à établir les devis. Solar API fournit les données 3D et les caractéristiques des pans. Nous l'utilisons aussi en contrôle croisé avec le LiDAR HD de l'IGN pour la France.

**3) Intégration dans un produit commercialisé**
Oui. L'outil est d'abord utilisé par notre entreprise, GUÉRIN COUVERTURE. Il sera ensuite proposé sur abonnement à d'autres artisans couvreurs.

**4) Site / application**
Application web responsive, utilisable sur ordinateur, tablette et smartphone. Le nom de domaine définitif est en cours d'attribution. Site de l'entreprise : https://www.guerin-couverture-ile-de-re.fr/

**5) Stade de développement**
Une première version fonctionnelle est développée. Elle fonctionne avec les données de l'IGN, et l'intégration de Solar API est prête : il ne manque que la clé API. Nous allons maintenant tester la précision sur des toitures réelles déjà métrées sur site.

**6) Entreprise**
GUÉRIN COUVERTURE, Saint-Martin-de-Ré (17410), Île de Ré, France.
Effectif : [à compléter].
Je suis le dirigeant (Président Directeur Général du Groupe Guérin).

**7) Volume prévu**
- Phase de test : environ 10 à 30 études par jour, soit 2 appels Solar API par étude.
- Après commercialisation : [à estimer], par exemple 100 à 500 études par jour à 12 mois.

Pourriez-vous nous indiquer les conditions tarifaires de Solar API à ces volumes ? En particulier, existe-t-il des crédits de démarrage pour les nouvelles intégrations, et des remises sur volume pour le SKU Data Layers ? Je suis disponible pour un échange au 06 64 76 43 28.

Cordialement,

Ridha Guérin
GUÉRIN COUVERTURE – Saint-Martin-de-Ré
