# Guide d'utilisation — Proxy Sélectif Oxylabs

Ce guide explique **tout**, pas à pas. Il y a deux rôles :

- **ADMIN** (une personne) : crée le « code de groupe » et le distribue.
- **CONSULTANT** (chaque utilisateur) : installe l'extension et colle le code.

---

## PARTIE 1 — ADMIN : créer le code de groupe (une fois par groupe)

### Étape 1 — Installer l'extension
1. Décompresse le fichier `.zip` reçu → tu obtiens un dossier.
2. Ouvre Chrome, va à l'adresse : `chrome://extensions`
3. En haut à droite, active **« Mode développeur »**.
4. Clique **« Charger l'extension non empaquetée »** et sélectionne le dossier décompressé.
5. L'icône de l'extension apparaît dans la barre d'outils de Chrome.

> ⚠️ Ne supprime pas le dossier : Chrome en a besoin pour faire tourner l'extension.

### Étape 2 — Ouvrir le générateur de code
1. Clique sur l'icône de l'extension → **« Ouvrir la configuration »**.
2. Sur la page qui s'ouvre, déplie **« Configuration manuelle (avancé / admin) »**.
3. Clique **« Générer un code de groupe (admin) → »**. Un nouvel onglet s'ouvre.

### Étape 3 — Remplir et générer
Dans le générateur, renseigne (cas **ISP dédié** — une IP fixe par port) :

| Champ | Quoi mettre |
|---|---|
| **Identifiant Oxylabs** | `user-<TON_USERNAME_ISP>` (le préfixe `user-` est obligatoire pour l'ISP) |
| **Mot de passe Oxylabs** | le mot de passe de l'utilisateur ISP (dashboard → ISP Proxies → Users → Change password) |
| **Serveur proxy** | `isp.oxylabs.io` |
| **Port** | le port du groupe (voir encadré ci-dessous) |
| **Domaines cibles** | `hellowork.com` (déjà pré-rempli) |
| **Alignement fingerprint** | à cocher SEULEMENT si besoin (par défaut : laisse décoché) |

Puis clique **« Générer le code »** → un code `OXY1:...` apparaît → clique **« Copier »**.

> ### 🔑 Le point le plus important : le PORT = l'IP
> Avec les proxies **ISP dédiés**, chaque port correspond à **une IP fixe**.
> Pour qu'un groupe partage la même IP, tous ses membres utilisent **le même port**.
>
> - Groupe 1 → port `8001` → tous sortent sur la même IP fixe
> - Groupe 2 → port `8002` → une autre IP fixe
> - etc.
>
> La liste port ↔ IP se trouve dans : dashboard Oxylabs → **ISP Proxies → Proxy list**.
> (Pas besoin de `sessid` ni de `cc-FR` : l'IP est déjà fixée par le port.)

### Étape 4 — Distribuer
Envoie le code `OXY1:...` **en privé** à chaque consultant du groupe (un seul code pour tout le groupe).

> ⚠️ Le code contient le mot de passe du proxy : traite-le comme un secret (ne pas poster en public).
> Pour changer le mot de passe ou l'IP plus tard : régénère un code et redistribue-le.

---

## PARTIE 2 — CONSULTANT : installer et activer (une fois, 2 min)

### Étape 1 — Installer l'extension
1. Décompresse le fichier `.zip` reçu → tu obtiens un dossier.
2. Ouvre Chrome, va à l'adresse : `chrome://extensions`
3. En haut à droite, active **« Mode développeur »**.
4. Clique **« Charger l'extension non empaquetée »** et sélectionne le dossier décompressé.

> ⚠️ Ne supprime pas le dossier après l'installation.

### Étape 2 — Coller le code
1. Clique sur l'icône de l'extension → **« Ouvrir la configuration »**.
2. Colle le **code de groupe** reçu dans le champ **« Code de groupe »**.
3. Clique **« Appliquer le code »**.
4. Le message **« Prêt. IP du groupe : … »** s'affiche → c'est terminé.

### Étape 3 — Travailler normalement
Rien de plus à faire. Ouvre hellowork.com et travaille comme d'habitude.
- Le proxy ne s'applique **qu'à** hellowork.com ; le reste de ta navigation est normal.
- Pour vérifier à tout moment : clique sur l'icône → le popup indique **« Routage actif »** et l'IP du groupe.

---

## En cas de souci

- **Le popup dit « Routage suspendu »** : identifiants proxy invalides ou quota Oxylabs épuisé. Clique sur **« Tester la connexion »** dans le popup, ou recolle un code à jour.
- **« Code invalide »** : le code a été mal copié (copie-le en entier, il commence par `OXY1:`).
- **L'IP n'est pas la bonne / pas partagée** : vérifie que tous utilisent bien **le même code** (donc le même port ISP).

Pour tout autre problème, contacte l'admin — une version à jour peut être fournie rapidement.
