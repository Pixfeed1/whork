# Proxy Selectif Oxylabs — v1.2.1

Extension Chrome (MV3) qui fait apparaitre tout un groupe de consultants avec la
**meme IP fixe Oxylabs** sur des domaines cibles (ex. `hellowork.com`), pour
permettre l'usage **simultane** d'un compte partage — **sans GoLogin, sans
Orbita, sans serveur / VPS** (donc compatible avec un hebergement mutualise).

## Ce que ca fait

- Route **uniquement les domaines cibles** via le proxy Oxylabs (sessid partage
  = IP identique pour tout le groupe). Le reste de la navigation reste direct.
- Auth proxy **transparente** (aucune boite de dialogue).
- Chaque consultant utilise **son propre Chrome** : plus aucun verrou de
  simultaneite (contrairement a GoLogin qui interdit d'ouvrir un profil deux
  fois). Ils peuvent donc etre connectes en meme temps.
- **Optionnel** : alignement du fingerprint du groupe sur les domaines cibles.
  v1.2.1 assure la **coherence complete UA <-> client hints** : User-Agent,
  Accept-Language, Sec-CH-UA (+ mobile / platform / version / arch / bitness)
  au niveau reseau, et `navigator.userAgent` / `userAgentData` (brands +
  getHighEntropyValues) / langues / timezone / ecran au niveau JS. Le vrai OS
  ne fuit donc plus via `navigator.userAgentData` (trou classique des
  extensions "UA only"). Un profil coherent Windows/Chrome est pre-rempli.

## Strategie recommandee (du moins cher au plus cher)

1. **Tester l'extension SEULE** avec 2-4 consultants + le meme `sessid`. Si la
   plateforme bloquait sur l'IP (cas decrit par le client), le probleme est
   deja regle. Ne pas activer le fingerprint.
2. **Si ca bloque encore** : activer « Aligner le fingerprint du groupe » dans
   la configuration et renseigner les memes valeurs pour tout le monde.
3. **Si la plateforme fingerprinte en profondeur** (canvas / WebGL / polices) :
   une extension ne suffit plus → navigateur anti-detection (GoLogin) ou
   navigateur cote serveur. Peu probable pour une plateforme de sourcing.

## Installation (chaque consultant)

1. `chrome://extensions` → activer **Mode developpeur**.
2. **Charger l'extension non empaquetee** → choisir ce dossier.
3. Clic sur l'icone → **Ouvrir la configuration**.
4. Renseigner l'identifiant Oxylabs **avec le `sessid` du groupe**, le mot de
   passe, le serveur/port, et les domaines cibles.
5. **Enregistrer et tester** → doit afficher l'IP du groupe.

> Tous les consultants d'un meme groupe saisissent **le meme `sessid`** pour
> partager la meme IP.

## Fichiers

| Fichier | Role |
|---|---|
| `manifest.json` | Declaration MV3 + permissions |
| `background.js` | Proxy PAC selectif, auth transparente, test, alignement fingerprint |
| `options.html` / `options.js` | Configuration (proxy + fingerprint) |
| `popup.html` / `popup.js` | Statut rapide + test |
| `icon128.png` | **A fournir** (icone 128px, non incluse) |

## Limites honnetes

- Le fingerprint via extension couvre les signaux « faciles » (UA, langue,
  timezone, ecran). Il ne masque **pas** canvas/WebGL/polices.
- Faire cohabiter plusieurs personnes sur une meme licence peut enfreindre les
  CGU de la plateforme cible. Choix et responsabilite du client.
