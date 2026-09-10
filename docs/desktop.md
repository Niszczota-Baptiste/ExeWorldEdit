# Titi WorldEdit — application de bureau

Éditeur de mondes Minecraft pour Windows : reprend le moteur WorldEdit du site
`titisite`, sans ses plafonds de VPS, avec une vraie interface d'atelier.

Ce document se remplit au fil des phases. Il consigne aussi les **écarts
assumés** avec la spécification d'origine — les endroits où on a fait
différemment, et pourquoi.

---

## Où vit quoi

```
ExeWorldEdit/
├─ packages/we-engine/     le moteur, sans dépendance à un serveur
│  ├─ src/anvil/           lecture/écriture .mca lossless
│  ├─ src/worldedit/       opérations, états de blocs, formats d'échange
│  ├─ src/storage/         StorageAdapter + implémentation fichiers
│  ├─ src/staging/         orchestration non destructive
│  ├─ assets/fonts/        Unifont (rendu de texte sans police système)
│  ├─ test/                128 tests
│  └─ bench/               mesures de performance (phase 1.1)
└─ apps/desktop/           l'application Electron (phase 2)
```

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
npm test          # tous les paquets
npm run lint
npm run bench     # phase 1.1
```

---

## État des phases

| Phase | Sujet | État |
|---|---|---|
| 0 | Extraire le moteur en package partagé | **fait** |
| 2.1–2.2 | Socle Electron, ouverture, export | à venir |
| 1 | Moteur rapide et entités | à venir |
| 2.3–2.5 | Direction visuelle, disposition, viewport | à venir |
| 3 | Brushs | à venir |
| 4 | Tracés, PNJ, dispersion | à venir |
| 5 | Outils de génération | à venir |

L'ordre choisi n'est pas celui du numérotage : le socle Electron passe **avant**
l'optimisation du moteur, pour que le bench de la phase 1 mesure les vrais
chemins chauds de l'application au lieu de cibles supposées, et pour qu'il y ait
un exécutable à essayer tôt.
