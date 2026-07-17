# Partage de session navigateur — architecture & chiffrage

Réponse technique à la mission « Système de partage de session navigateur » :
permettre à **2-4 consultants** d'utiliser **le même compte en même temps**, avec
la **même IP fixe** et le **même fingerprint**, **sans rien installer** de leur
côté.

---

## 1. Diagnostic

### Le vrai problème
La plateforme de sourcing bloque les **connexions simultanées depuis des IP
différentes** sur un même compte. Deux vecteurs de détection :

1. **IP** — déjà réglé côté client (proxy ISP fixe Oxylabs, une IP fixe FR par licence).
2. **Fingerprint navigateur** — géré par GoLogin, mais…

### Pourquoi GoLogin seul est une impasse
Le blocage « un profil = une instance » de GoLogin **n'est pas un bug à
contourner, c'est une protection volontaire** : deux instances du même profil
font diverger les cookies/tokens de session → détection garantie. Il n'existe
**aucune API, aucun mode headless, aucun profil cloud** qui lève cette limite
proprement.

➡️ **Conclusion : GoLogin ne peut pas, seul, offrir du multi-accès concurrent
sur un même profil.** Il reste utile comme *moteur de fingerprint*, pas comme
mécanisme de partage.

### Pourquoi l'approche « launcher local » est à écarter
Faire installer un launcher + Orbita sur le poste de chaque consultant :
- se heurte quand même au verrou de simultanéité (chacun ouvre le profil localement) ;
- impose un téléchargement — exactement la contrainte que le client veut supprimer.

---

## 2. Principe de la solution

On arrête de raisonner en « N copies synchronisées d'un profil » (impossible).

> **Un navigateur par consultant, tournant côté serveur, streamé dans son
> onglet web. Tous les profils sont clonés à l'identique (même fingerprint) et
> sortent par la même IP fixe Oxylabs.**

Comme ce sont des **profils différents** (IDs différents), le verrou de
simultanéité GoLogin ne se déclenche jamais. Comme ils sont **configurés à
l'identique**, la plateforme voit la même IP + le même fingerprint pour les 2-4
consultants — la signature naturelle d'un bureau de plusieurs personnes derrière
un même réseau. Et comme tout tourne **côté serveur**, le consultant **n'installe
rien** : il ouvre un lien.

```
  Consultant 1  ─┐
  Consultant 2  ─┤   (un lien dans leur navigateur — zéro install)
  Consultant 3  ─┤
  Consultant 4  ─┘
        │  streaming web (WebRTC / HTML5)
        ▼
┌─────────────────────────────────────────────┐
│  VPS (Docker)                                │
│   ├─ conteneur 1 → Chromium/Orbita profil A  │
│   ├─ conteneur 2 → Chromium/Orbita profil B  │  ← profils clonés :
│   ├─ conteneur 3 → Chromium/Orbita profil C  │    fingerprint identique
│   └─ conteneur 4 → Chromium/Orbita profil D  │
│                    │                          │
└────────────────────┼─────────────────────────┘
                     ▼
        Proxy Oxylabs ISP  →  IP fixe FR (par licence/groupe)
```

Chaque consultant travaille **indépendamment et en parallèle** (choix validé
avec le client).

---

## 3. Briques réutilisables de l'existant (`qa-orchestrator`)

Le code déjà produit n'est pas perdu :

| Brique existante | Réutilisation |
|---|---|
| `packages/providers/src/oxylabs.js` (`buildProxyForRegion`) | Injection de l'IP fixe / ciblage géo Oxylabs. **Directement réutilisable.** |
| Auth + attribution admin (`apps/web`, `ProfileAssignment`) | Gérer « quel consultant accède à quel groupe/compte ». Réutilisable. |
| `packages/providers/src/gologin.js` | Le clonage de profil et le PATCH proxy restent pertinents côté serveur. |

Ce qui **disparaît** : le launcher Electron local (`apps/launcher`) et tout le
flux « le testeur ouvre Orbita sur son poste ».

Ce qui est **nouveau** : la couche de **streaming navigateur côté serveur**.

---

## 4. Options techniques pour le streaming

| Option | Nature | Avantages | Inconvénients |
|---|---|---|---|
| **Hyperbeam** | API SaaS (navigateur cloud embarquable) | Le plus rapide à intégrer, zéro infra à gérer | Coût récurrent à l'usage ; un tiers voit passer le trafic ; fingerprint moins maîtrisé |
| **Kasm Workspaces** | Navigateurs conteneurisés streamés (self-host) | Multi-utilisateurs intégré, prod-ready, édition communautaire gratuite | Config serveur à faire ; ressources CPU |
| **Neko** | Room WebRTC self-host (open-source) | Léger, gratuit, contrôle total | Plus de plomberie à coder ; 1 room/consultant |

---

## 5. Les 2 risques à valider AVANT de tout construire

Les vecteurs cités par le client (IP + fingerprint) sont réglés par l'archi.
Restent deux points à **tester sur leur vraie plateforme** (~1 jour de POC) :

1. **Sessions concurrentes** — 4 logins simultanés sur un compte. Si la
   plateforme n'autorise *aucune* session concurrente même depuis la même IP,
   il faut basculer sur une **session unique à cookies mutualisés** (variante
   hybride, plus complexe).
2. **Fingerprints trop identiques** — 4 empreintes *strictement* identiques
   peuvent paraître aussi suspectes que trop différentes. On calibre pour rester
   plausible : même IP, empreintes cohérentes mais pas clonées au pixel.

**Tant que ces deux points ne sont pas validés, aucune archi ne doit être
engagée en dur.** C'est le sens du POC.

---

## 6. Chiffrage & réalité budgétaire

⚠️ **Le budget affiché (« moins de 500 € ») ne couvre pas une infra
multi-navigateurs streamée complète et maintenue.** Il faut le dire au client.

### Coûts d'infrastructure récurrents (mensuels, hors dev)
| Poste | Estimation |
|---|---|
| VPS France (4 vCPU / 8-16 Go, headful streaming) | ~30-60 €/mois |
| Oxylabs ISP | *déjà payé par le client* |
| GoLogin | *déjà payé par le client* |
| Kasm / Neko (self-host) | 0 € (open-source) |
| *ou* Hyperbeam (SaaS) | ~0,10-0,30 $/h × sessions actives |

### Effort de développement
| Livrable | Effort réaliste |
|---|---|
| **POC** (1 conteneur + Oxylabs + streaming, validation des 2 risques) | 2-3 jours |
| **Solution complète** (N conteneurs, admin, provisioning profils, streaming multi-users) | 1,5 à 3 semaines |

### Recommandation de cadrage
Deux façons de rester réaliste :

- **Palier 1 — POC / faisabilité (compatible ~budget)** : monter Hyperbeam ou
  Kasm communautaire + intégration Oxylabs minimale, valider les 2 risques sur
  leur plateforme, livrer une reco. C'est le seul périmètre honnête sous 500 €.
- **Palier 2 — mise en production** : à rechiffrer une fois le POC concluant
  (l'archi complète est un vrai projet, pas une prestation à 500 €).

---

## 7. Prochaine étape proposée

1. Valider avec le client le **cadrage en 2 paliers** (POC d'abord).
2. Récupérer un accès de test à **leur** plateforme + les credentials Oxylabs/GoLogin.
3. Monter le POC (Hyperbeam ou Kasm) derrière l'IP fixe Oxylabs.
4. Tester : login concurrent × 4, comportement de la plateforme, cohérence
   fingerprint.
5. Décision go/no-go sur le palier 2.
