# Titi WorldEdit — application de bureau

Éditeur de mondes Minecraft pour Windows : reprend le moteur WorldEdit du site
`titisite`, sans ses plafonds de VPS, avec une vraie interface d'atelier.

Ce document se remplit au fil des phases. Il consigne aussi les **écarts
assumés** avec la spécification d'origine — les endroits où on a fait
différemment, et pourquoi.

---

![Le viewport](images/viewport.png)

*Capture réelle de l'application : un build de 850 000 blocs généré par le
moteur lui-même (`npm run demo`), maillé par chunk avec occlusion ambiante.*

## Où vit quoi

```
ExeWorldEdit/
├─ packages/we-engine/     le moteur, sans dépendance à un serveur
│  ├─ src/anvil/           lecture/écriture .mca lossless
│  ├─ src/worldedit/       opérations, états de blocs, formats d'échange
│  ├─ src/storage/         StorageAdapter + implémentation fichiers
│  ├─ src/staging/         orchestration non destructive
│  ├─ assets/fonts/        Unifont (rendu de texte sans police système)
│  ├─ test/                129 tests
│  └─ bench/               mesures de performance (phase 1.1)
└─ apps/desktop/
   ├─ src/main/            processus principal : fenêtre, protocole app://, IPC
   ├─ src/preload/         pont d'API (CommonJS — obligatoire en sandbox)
   ├─ src/engine/          le moteur dans son utilityProcess
   ├─ src/renderer/        React + three.js
   ├─ assets/fonts/        Pretendard (latin + hangeul, OFL)
   ├─ test/                14 tests du mailleur
   └─ scripts/make-demo.js build de démonstration, via le vrai moteur
```

## Les trois processus

| | Rôle | Ce qu'il n'a PAS le droit de faire |
|---|---|---|
| **Principal** | Fenêtre, dialogues système, protocole `app://`, relais IPC | Calculer quoi que ce soit sur un build |
| **Moteur** (`utilityProcess`) | Source de vérité : seul à lire et écrire les régions | Parler à l'utilisateur, choisir un chemin de fichier |
| **Renderer** | Interface et viewport | Toucher au disque, invoquer autre chose que la liste blanche du preload |

Le renderer tourne en `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`. Il ne dispose que des méthodes énumérées dans
`src/preload/index.cjs` : compromis par une dépendance, il ne peut rien faire
d'autre. Une politique de sécurité de contenu interdit en plus toute ressource
qui ne vient pas de `app://` — aucun CDN, aucune police distante, aucune requête
réseau.

`titisite` n'est **pas** modifié par ce dépôt. Le site continue de tourner sur sa
propre copie du moteur. Les deux vont donc diverger dès la phase 1 — c'est un
choix, pas un oubli : voir « Rapport au site » plus bas.

---

## Architecture visée

```
┌────────────── Renderer (React) ──────────────┐
│ UI · viewport three.js                        │
│  ├─ worker d'édition : chunks près du curseur │
│  └─ workers de maillage : greedy + AO         │
└───────────────▲──────────────────────────────┘
                │ MessagePort (buffers transférés)
┌───────────────┴──────────────────────────────┐
│ Engine (utilityProcess, source de vérité)     │
│ RegionStore · staging · undo · export         │
│  └─ pool worker_threads (zlib/NBT, ops lourdes)│
└───────────────────────────────────────────────┘
```

Trois corrections apportées à l'architecture proposée à l'origine :

**`SharedArrayBuffer` n'est pas un prérequis.** Le mailleur a besoin des chunks
voisins pour l'occlusion ambiante et la suppression des faces cachées, mais la
manière habituelle de le lui donner est un bloc **paddé 18³ d'identifiants**
envoyé en `ArrayBuffer` transféré : zéro copie, et surtout aucune isolation
cross-origin à mettre en place. COOP/COEP sur `app://` reste possible et
fonctionne (il faut `registerSchemesAsPrivileged` avant `app.ready`), mais ça
complique tout le reste du chargement. On garde SAB comme optimisation
activable si le profilage la réclame, pas comme fondation.

**Les anciens identifiants de l'undo viennent de l'engine, jamais du renderer.**
Le chemin rapide des brushs veut que le renderer applique localement puis envoie
des deltas creux. S'il fournissait aussi les anciens identifiants et qu'il a
désynchronisé, l'undo réécrirait des valeurs fausses, sans que rien ne le
signale. Le renderer n'envoie donc que des paires `(index, nouvelID)` ; l'engine,
qui est la source de vérité, capture l'ancienne valeur au moment où il applique.

**Le greedy meshing ne couvre pas tout.** Il ne s'applique qu'aux cubes pleins
opaques. Escaliers, dalles et les quarts de bloc `minefield:*` doivent être émis
en géométrie de modèle cuite, ajoutée au même tampon de chunk, plus une passe
transparente séparée pour l'eau et le verre. C'est le gros du travail de
maillage et ça ne figurait pas dans la spécification d'origine.

---

## Le StorageAdapter

C'est la seule frontière entre le moteur et son hôte. Le moteur ne sait pas s'il
tourne dans un serveur Express avec SQLite ou dans un processus Electron.

Ce qui passe par l'adapter — parce que ça **diffère** entre les deux :

| | Site (SQLite + uploads) | Desktop (`FsAdapter`) |
|---|---|---|
| Projets | table `minecraft_blueprints` | `projects/<id>/project.json` |
| Fichier source | `uploads/<uuid>` | `projects/<id>/source/` |
| Journal | table `worldedit_audit` | `audit.jsonl` |
| Bibliothèque | table + `uploads/` | `library/<scope>.json` + blobs |
| Dossier de travail | `uploads/worldedit/<id>/` | `projects/<id>/staging/` |

Ce qui **ne** passe **pas** par l'adapter, volontairement : la mécanique des
snapshots undo, des fichiers de région et de l'aperçu. Les deux hôtes ont un vrai
système de fichiers ; l'adapter se contente de nommer un dossier (`stagingDir`)
que le moteur possède ensuite entièrement. Abstraire aussi cette mécanique aurait
signifié réécrire mille lignes de code testé pour n'en tirer aucune souplesse.

Les tests de l'adapter sont écrits comme une **suite de contrat** paramétrée par
une fabrique : un futur adapter SQLite s'y branche et doit passer les mêmes
assertions.

### Arborescence du poste local

```
%APPDATA%/TitiWorldEdit/         (macOS et Linux : emplacements conventionnels)
├─ projects/<id>/
│  ├─ project.json               métadonnées, écrites en atomique
│  ├─ source/<fichier>           le .mca / .zip importé, jamais modifié
│  ├─ staging/
│  │  ├─ regions/r.X.Z.mca       la copie de travail
│  │  ├─ undo/<n>/ redo/<n>/     snapshots des régions touchées
│  │  └─ preview.json.gz
│  └─ audit.jsonl
└─ library/
   ├─ <scope>.json
   └─ blobs/<uuid>.we.gz
```

Le journal est en JSON Lines : une opération ajoute une ligne en O(1) sans relire
le fichier, et un journal coupé par un crash reste lisible jusqu'à sa dernière
ligne complète. `project.json` s'écrit par fichier temporaire puis renommage :
un crash au milieu laisse l'ancien intact plutôt qu'un JSON tronqué.

---

## Le contrat non destructif

Inchangé depuis le site, et c'est l'invariant central :

1. On ne touche **jamais** au fichier source. À la première opération, il est
   déplié en copie de staging.
2. Chaque opération commence par un **snapshot** des régions qu'elle va toucher.
   C'est ce qui donne l'undo, et c'est pris avant la moindre écriture.
3. Les chunks non modifiés sont **réémis octet pour octet**. Le round-trip Anvil
   est lossless, vérifié par des tests qui relisent le fichier produit avec un
   décodeur indépendant.
4. Réinitialiser jette la copie de travail et repart de la source.

---

## Écrire dans une vraie save

« Appliquer au monde » est la seule action irréversible de l'application. Elle
suit trois garde-fous, **dans cet ordre** :

1. **Refuser si Minecraft tient le monde.** Le jeu garde un verrou exclusif sur
   `session.lock` tant qu'un monde est chargé, et écrire dans un monde chargé le
   corrompt.
2. **Sauvegarder en zip horodaté** les régions qui vont être réécrites — celles
   de blocs *et* celles d'entités. Seulement celles-là : archiver un monde entier
   à chaque application coûterait des gigaoctets pour rien.
3. **Écrire.**

L'ordre n'est pas négociable, et un test le vérifie explicitement : il relit
l'archive et exige d'y trouver l'état d'AVANT. Une sauvegarde prise après la
première écriture ne sauvegarde plus rien.

### Le verrou ne se détecte pas partout pareil

| | Nature du verrou | Détection |
|---|---|---|
| **Windows** | obligatoire (système) | fiable — ouvrir `session.lock` en écriture échoue |
| **Linux, macOS** | consultatif (POSIX) | **impossible** — l'ouverture réussit même monde chargé |

`probeWorldLock` renvoie donc `{ locked, reliable }` plutôt qu'un simple
booléen. Là où la détection n'est pas fiable, l'application ne fait pas semblant
de savoir : la confirmation dit franchement qu'elle ne peut pas vérifier et
demande de fermer le jeu. Windows étant la plateforme visée, la garde est
effective là où elle compte — mais mentir sur ce qu'on sait ailleurs aurait été
pire que de l'avouer.

### Ce qui s'ouvre

| Entrée | Devient |
|---|---|
| `.mca` | un projet, région seule |
| `.zip` d'un dossier `region/` | un projet, toutes ses régions |
| dossier de save (`level.dat` + `region/`) | un projet **avec sa save attachée** — seul cas où « Appliquer au monde » existe |
| dossier `region/` isolé | un projet, sans save attachée |
| `.schem` (Sponge), `.litematic` | un projet : régions vierges à la taille du schematic, puis tamponnage |

Un schematic n'a ni chunks ni coordonnées absolues. Plutôt que d'en faire un cas
particulier que tout le moteur devrait connaître, on lui fabrique des régions et
on l'y tamponne : le résultat est un build ordinaire, éditable et annulable
comme les autres. Son offset d'origine est respecté, si bien que le recoller
sans décalage le remet exactement où il a été pris.

Le glisser-déposer passe par le même point d'entrée que les dialogues : c'est
l'extension qui choisit la porte. Le renderer ne lit jamais le fichier — il n'en
transmet que le chemin.

---

## Écarts assumés avec le moteur du site

| Sujet | Site | Ici | Pourquoi |
|---|---|---|---|
| Plafonds | variables d'environnement | options de `createStaging` | Une application de bureau doit pouvoir les relever selon la RAM de la machine (phase 1.2). |
| `regenPreview` | `deriveSparse` sans troncature | tronqué comme partout ailleurs | Sur le site, annuler une opération sur un très gros build levait `too_many_blocks` : l'annulation avait bien eu lieu sur disque, mais l'utilisateur voyait une erreur pour une opération réussie. |
| Forme des projets | ligne SQLite (`min_x`, `size_x`, `source_file`) | `{ id, name, min, size, source }` | Le moteur n'a pas à connaître le nom des colonnes d'une base qu'il n'utilise pas. |
| `regionCoordsFromName` | deux versions aux règles différentes | une seule, celle d'`anvil` | Celle du lecteur ZIP n'acceptait que `r.X.Z.mca` ; celle d'`anvil` accepte en plus `r_X_Z.mca`. Deux homonymes aux règles divergentes finissent toujours par se rencontrer au mauvais moment. |
| Ids de projet | entiers de la base | validés `[A-Za-z0-9_-]{1,64}` | Assainir au lieu de valider fait collisionner deux ids distincts sur le même dossier, donc perdre un projet en silence. |

---

## Limites connues, non encore traitées

- **Entités absentes.** Rien n'est lu ni écrit dans `entities/r.X.Z.mca`, et
  l'export `.schem` sort une liste `Entities` vide. Phase 1.3.
- **L'export avec décalage re-chunke** et perd au passage les block-entities
  (contenu des coffres, texte des panneaux) et les biomes. L'export sans
  décalage, lui, est lossless. Phase 1.3.
- **`RegionStore` est lent sur le chemin chaud** : `setBlock` fabrique une clé
  texte et fait un `findIndex` sur la palette de section à chaque bloc,
  `getBlock` alloue un objet par appel. Phase 1.2.
- **Un seul fil d'exécution.** Pas de pool de workers. Phase 1.2.

### Ce que le viewport ne fait pas encore

- **Pas de textures** : chaque bloc est teinté d'une couleur unie. La base vient
  des vraies couleurs de carte du jeu, exportées par le moteur
  (`flatBlockColors`, ~60 blocs) ; le reste est complété à la main, et un bloc
  inconnu reçoit une teinte dérivée de son nom, stable mais arbitraire. L'atlas
  arrive en phase 2.5.
- **Pas de modèles non cubiques** : escaliers, dalles et quarts de bloc
  `minefield:*` sont rendus en cube plein. C'est la vraie limite du greedy
  meshing, et le gros du travail de la 2.5.
- **Pas de sélection à la souris ni de gizmos** : la sélection par défaut est
  l'emprise du contenu, modifiable dans l'inspecteur seulement.
- **Pas de palette de commandes** (`Ctrl+K`), pas de thème clair, pas d'onglets
  multiples réellement ouvrables.

### Mesurer le viewport honnêtement

Les captures et les chiffres de cette documentation sont produits sous
**xvfb + SwiftShader**, c'est-à-dire un rendu 100 % logiciel sur une machine
sans carte graphique. Les 8 images par seconde qu'affiche la barre d'état dans
ces conditions ne disent RIEN des performances réelles : elles mesurent un
rasteriseur logiciel, pas le viewport. Le seul chiffre transposable de ces
captures est le nombre d'appels de dessin (385 pour 850 000 blocs, soit un par
chunk), qui est une propriété du maillage et pas du matériel.

La cible de 60 images par seconde sur 20 M de blocs se vérifiera sur une vraie
machine, à la phase 2.7.

### Piste principale pour la phase 1.1

`decodeChunk` passe par `prismarine-nbt` (`nbt.parse` + `nbt.simplify`), une
implémentation générique fondée sur protodef, très allocatoire. Sur un
chargement de région complète, le NBT domine probablement le dépack des
sections — donc avant d'optimiser `RegionStore`, **mesurer où part réellement le
temps**. Si c'est confirmé, écrire un lecteur/écrivain NBT dédié (quelques
centaines de lignes de binaire direct, sortie en vues typées, sans `simplify`)
est vraisemblablement le plus gros gain du chantier. Ce n'est pas réécrire le
moteur dans un autre langage : c'est remplacer une dépendance sur le chemin
chaud.

---

## Rapport au site

Le moteur est ici, `titisite` garde le sien. Les deux vont diverger dès que la
phase 1 réécrira `RegionStore` et ajoutera les entités.

Le `StorageAdapter` existe précisément pour que ce ne soit pas irréversible : le
jour où on veut rebrancher le site sur ce package, il ne reste qu'à écrire un
`SqliteUploadsAdapter` (une centaine de lignes : les mêmes méthodes, contre la
base et `uploads/`) et à le faire passer la suite de contrat déjà écrite. Rien
d'autre dans le moteur n'a besoin de bouger.

---

## Commandes

```bash
npm install
npm test                              # tous les paquets
npm run lint

# Application
npm run dev      --workspace @titi/desktop   # Vite + Electron en parallèle
npm run start    --workspace @titi/desktop   # build puis lancement
npm run dist     --workspace @titi/desktop   # installeur NSIS + portable (Windows)
npm run demo     --workspace @titi/desktop -- <dossier-de-données>

# Capture du rendu, y compris sans écran (rendu logiciel)
TITI_SCREENSHOT=/chemin/capture.png xvfb-run -a npx electron .
```

`TITI_DATA_ROOT` déplace l'espace de données (par défaut
`%APPDATA%/TitiWorldEdit`), ce qui permet de travailler sur un jeu de projets
jetable sans toucher au vrai.

---

## État des phases

| Phase | Sujet | État |
|---|---|---|
| 0 | Extraire le moteur en package partagé | **fait** |
| 2.1 | Socle Electron (3 processus, `app://`, IPC en liste blanche) | **fait** |
| 2.2 | Ouverture et export | **fait** — `.mca`, `.zip`, dossier de save, dossier `region/`, `.schem`, `.litematic`, glisser-déposer ; export `.mca`/`.schem`/`.litematic` ; « Appliquer au monde » avec verrou `session.lock` et sauvegarde horodatée. Reste : récupération après crash explicite (le staging est déjà persistant) |
| 2.3 | Direction visuelle (jetons, Pretendard, roue d'outils) | **fait** |
| 2.4 | Disposition (panneaux, inspecteur généré, palette virtualisée) | fait pour l'essentiel ; `Ctrl+K` et thème clair à venir |
| 2.5 | Viewport | maillage par chunk + AO **fait** ; atlas de textures et modèles non cubiques à venir |
| 2.6 | Empaquetage | configuration electron-builder écrite, jamais exécutée sur Windows |
| 1 | Moteur rapide et entités | à venir |
| 3 | Brushs | à venir |
| 4 | Tracés, PNJ, dispersion | à venir |
| 5 | Outils de génération | à venir |

![La roue d'outils](images/roue-outils.png)

*L'élément signature : maintenir `Espace` au-dessus du viewport ouvre la roue,
la direction du curseur choisit l'outil, relâcher valide. On change d'outil sans
quitter le build des yeux.*

L'ordre choisi n'est pas celui du numérotage : le socle Electron passe **avant**
l'optimisation du moteur, pour que le bench de la phase 1 mesure les vrais
chemins chauds de l'application au lieu de cibles supposées, et pour qu'il y ait
un exécutable à essayer tôt.
