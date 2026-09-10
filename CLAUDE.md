# CLAUDE.md — contexte pour Claude Code

Lu automatiquement au démarrage. À garder court : ce qui change à chaque commit
appartient au code ou à `docs/desktop.md`.

## Ce qu'est ce dépôt

**Titi WorldEdit** — application Windows d'édition de mondes Minecraft, bâtie
sur le moteur WorldEdit du site `titisite`. Monorepo npm workspaces :

- `packages/we-engine` — le moteur. Aucune dépendance à un serveur, une base de
  données ou un navigateur. C'est là que vit tout le savoir sur le format Anvil.
- `apps/desktop` — l'application Electron (phase 2, encore un squelette).

Cible : Minecraft **vanilla 1.18** avec les blocs custom `minefield:*`. Gros
builds pour le serveur Minefield — murailles, arènes, villes, terrains.

## Invariants à ne jamais casser

1. **On ne touche jamais au fichier source.** Toute opération travaille sur une
   copie de staging, et commence par un snapshot des régions qu'elle va toucher.
2. **Le round-trip Anvil est lossless.** Les chunks non modifiés sont réémis
   octet pour octet. `test/anvil.test.js` le vérifie en relisant le fichier
   produit avec un décodeur **indépendant** (`test/fixtures/legacy-decoder.js`,
   à garder GELÉ — s'il partageait du code avec `src/anvil/`, le test ne
   prouverait plus rien).
3. **Les blocs `minefield:*` ne sont jamais remappés vanilla.** Leur géométrie
   et leurs états se transforment ; leur namespace, jamais.
4. **Toute génération aléatoire prend une seed** et est rejouable. Les fonctions
   qui tirent au sort acceptent un générateur injectable (voir `weightedPicker`).
5. **Aucune écriture dans une save sans sauvegarde préalable.**

## Conventions

- Le moteur ne connaît son hôte que par le **`StorageAdapter`**
  (`src/storage/`). Si tu ajoutes quelque chose qui a besoin de savoir *où* les
  données vivent, ça passe par là — jamais par un `import` de base ou un chemin
  en dur. Les tests de l'adapter sont une **suite de contrat** : un nouvel
  adapter s'y branche et doit passer les mêmes assertions.
- Dans `src/staging/`, le pur et le stocké sont séparés exprès : `geometry.js` et
  `blank.js` ne touchent pas au disque, `staging.js` est la seule partie liée au
  stockage. Ne pas les remélanger.
- Chaque nouvelle fonction du moteur arrive **avec ses tests**, déterministes.
- Repère Minecraft partout : **+X = Est, +Z = Sud, +Y = Haut**. Index d'un bloc
  dans une section : `i = y*256 + z*16 + x` (ordre **YZX**).
- Pas de fixture binaire dans le dépôt : les tests construisent leurs régions à
  la volée (`test/fixtures/region.js`). Un `.mca` commité est opaque en revue et
  impossible à faire évoluer.
- Messages de commit en **français**.

## Commandes

```bash
npm install
npm test          # tous les paquets (128 tests aujourd'hui)
npm run lint
npm run bench     # phase 1.1
```

## Où ajouter quoi

| Ajouter… | …dans |
|---|---|
| Une opération WorldEdit | `packages/we-engine/src/worldedit/transform.js` + son entrée dans `OPS` (`src/staging/staging.js`) + son descripteur dans `operations.js` + ses tests |
| Une propriété d'état de bloc à transformer | `src/worldedit/blockstates.js` + une assertion par propriété dans `test/worldedit.test.js` |
| Un format d'échange | `src/worldedit/schematicFormats.js` + un test de round-trip |
| Une chose qui dépend d'où vivent les données | une méthode du `StorageAdapter` + son cas dans la suite de contrat (`test/storage.test.js`) |
| Un plafond réglable | `DEFAULT_LIMITS` (`src/staging/geometry.js`), jamais une variable d'environnement |

## Ce qui n'est pas encore là

Entités (`entities/*.mca`), block-entities préservées à l'export décalé,
`RegionStore` rapide, pool de workers, et toute l'application. Détail, écarts
assumés avec le site et ordre des phases : **`docs/desktop.md`**.

## Rapport au site `titisite`

Ce dépôt **ne modifie pas** le site. Le site garde sa copie du moteur ; les deux
divergeront dès la phase 1. Le `StorageAdapter` est là pour que ce soit
réversible : rebrancher le site demanderait un `SqliteUploadsAdapter` d'une
centaine de lignes, et rien d'autre. Ne pas casser cette possibilité sans raison.

## Pièges déjà rencontrés

- **Assainir un identifiant au lieu de le refuser.** `a/b` et `a b` deviennent
  tous deux `a_b` : deux projets distincts dans le même dossier, donc une perte
  de données silencieuse. `FsAdapter` valide et refuse.
- **Deux fonctions homonymes aux règles différentes.** Le site avait deux
  `regionCoordsFromName`, l'une acceptant `r_X_Z.mca` et l'autre non. Une seule
  a été reprise.
- **Régénérer un aperçu sans troncature.** Sur le site, annuler une opération sur
  un très gros build levait `too_many_blocks` alors que l'annulation avait
  réussi. Tout ce qui dérive un aperçu doit tronquer et le signaler.
