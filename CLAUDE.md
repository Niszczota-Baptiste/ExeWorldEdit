# CLAUDE.md — contexte pour Claude Code

Lu automatiquement au démarrage. À garder court : ce qui change à chaque commit
appartient au code ou à `docs/desktop.md`.

## Ce qu'est ce dépôt

**Titi WorldEdit** — application Windows d'édition de mondes Minecraft, bâtie
sur le moteur WorldEdit du site `titisite`. Monorepo npm workspaces :

- `packages/we-engine` — le moteur. Aucune dépendance à un serveur, une base de
  données ou un navigateur. C'est là que vit tout le savoir sur le format Anvil.
- `apps/desktop` — l'application Electron. Trois processus : **principal**
  (fenêtre, dialogues, protocole `app://`), **moteur** (`utilityProcess`, seul
  à toucher aux fichiers de région), **renderer** (React + three.js, en
  sandbox, sans accès disque).

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
4. **Toute génération aléatoire prend une seed** et est rejouable. Un tirage PAR
   BLOC se hache sur la position (`hash3(x, y, z, seed)`, `transform.js`), ce qui
   le rend indépendant de l'ordre de parcours ; ailleurs, la fonction accepte un
   générateur injectable (voir `weightedPicker`). Aucun `Math.random()` nu dans
   `packages/we-engine/src/`.
5. **Aucune écriture dans une save sans sauvegarde préalable**, et dans cet
   ordre : refuser si Minecraft tient le monde, sauvegarder en zip horodaté,
   puis écrire. Une sauvegarde prise après la première écriture ne sauvegarde
   plus rien — un test l'exige explicitement.
6. **Le renderer ne touche jamais au disque.** Il passe par la liste blanche du
   preload (`apps/desktop/src/preload/index.cjs`) et rien d'autre. Ajouter une
   capacité veut dire l'ajouter à cette liste — délibérément, pas par accident.
7. **Le moteur ne parle jamais à l'utilisateur.** Il rend un fichier prêt à
   écrire ; c'est le processus principal qui ouvre le dialogue et choisit le
   chemin. Un moteur qui ouvre des fenêtres est un moteur qu'on ne peut plus
   tester ni réutiliser.

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
npm test          # tous les paquets (264 tests aujourd'hui : 239 moteur, 25 desktop)
npm run lint

npm run dev   --workspace @titi/desktop   # Vite + Electron
npm run start --workspace @titi/desktop   # build puis lancement
npm run dist  --workspace @titi/desktop   # installeur Windows
npm run demo  --workspace @titi/desktop -- <dossier>   # build de démonstration

npm run bench --workspace @titi/we-engine                 # médiane de 1
npm run bench --workspace @titi/we-engine -- --repeat=3   # médiane de 3
npm run bench --workspace @titi/we-engine -- --save-baseline   # refiger la référence
```

Le bench compare à `bench/baseline.json` et écrit `bench/RESULTS.md`. Ne refiger
la référence QUE délibérément : c'est le point de comparaison de tout ce qui
suit.

Sans écran (session distante, intégration continue) :
`TITI_SCREENSHOT=/tmp/x.png xvfb-run -a npx electron .` rend la fenêtre en
logiciel et écrit un PNG. Les images par seconde mesurées ainsi ne valent rien —
c'est du SwiftShader ; le nombre d'appels de dessin, lui, est transposable.

## Où ajouter quoi

| Ajouter… | …dans |
|---|---|
| Une opération WorldEdit | `packages/we-engine/src/worldedit/transform.js` + son entrée dans `OPS` (`src/staging/staging.js`) + son descripteur dans `operations.js` + ses tests. Elle DOIT rendre des `bounds` couvrant tout ce qu'elle écrit : l'instantané d'annulation ET l'aperçu incrémental s'y fient. Ne l'ajouter à `COLUMN_LOCAL_OPS` que si elle ne lit JAMAIS hors de son (x, z) |
| Une propriété d'état de bloc à transformer | `src/worldedit/blockstates.js` + une assertion par propriété dans `test/worldedit.test.js` |
| Un format d'échange | `src/worldedit/schematicFormats.js` + un test de round-trip |
| Une donnée hors grille de blocs (block entity, biome) | elle voyage dans la `Schematic` (`transform.js`) pour les transformations, et se recopie explicitement dans l'export décalé (`exportBuild`) |
| Un champ dans l'aperçu | `src/staging/previewCodec.js` (en-tête JSON) + son cas dans `test/preview-codec.test.js` ; le corps binaire ne porte que les blocs |
| Une chose qui dépend d'où vivent les données | une méthode du `StorageAdapter` + son cas dans la suite de contrat (`test/storage.test.js`) |
| Un plafond réglable | `DEFAULT_LIMITS` + son entrée dans `LIMIT_RANGES` (`src/staging/geometry.js`), jamais une variable d'environnement. L'interface génère son champ depuis les bornes, il n'y a rien à écrire côté renderer |
| Une capacité pour le renderer | la méthode dans `apps/desktop/src/engine/index.js`, puis son nom dans `ENGINE_METHODS` du preload |
| Un outil dans l'interface | `TOOLS` et `TOOL_OPS` (`apps/desktop/src/renderer/store.js`) — l'inspecteur génère ses champs depuis le descripteur du moteur, il n'y a pas de formulaire à écrire |
| Une couleur de bloc pour le viewport | `EXTRA` dans `apps/desktop/src/renderer/viewport/blockColors.js` (en attendant l'atlas) |
| Un réglage de l'application | `DEFAULT_SETTINGS` (`apps/desktop/src/renderer/theme.js`) + son champ dans `Settings.jsx` ; il se persiste tout seul via `readSettings`/`writeSettings` de l'adapter |
| Une variable de thème ou de densité | `theme.js` ET `tokens.css` — un test compare les deux à l'échelle 1, ne pas n'en changer qu'une |
| Une icône | `apps/desktop/src/renderer/shell/icons.js` — le SEUL fichier du renderer qui importe `lucide-react` |
| Un format d'entrée | `openAnyPath` (`apps/desktop/src/main/index.js`) décide selon l'extension ; dialogue, glisser-déposer et chemin de lancement y passent tous |

## Ce qui n'est pas encore là

Entités mobiles (`entities/*.mca`), aperçu découpé par chunk, `getBlock` sans
allocation, et toute l'application. Détail, écarts assumés avec le site et ordre
des phases : **`docs/desktop.md`**.

## Rapport au site `titisite`

Ce dépôt **ne modifie pas** le site. Le site garde sa copie du moteur ; les deux
divergeront dès la phase 1. Le `StorageAdapter` est là pour que ce soit
réversible : rebrancher le site demanderait un `SqliteUploadsAdapter` d'une
centaine de lignes, et rien d'autre. Ne pas casser cette possibilité sans raison.

## Pièges déjà rencontrés

- **Optimiser sans mesurer.** J'ai annoncé que `prismarine-nbt` dominerait le
  chargement d'une région. Faux : il pesait 12 %, et 85 % partaient dans notre
  propre dépack de sections, qui allouait un BigInt par bloc. Le bench de la
  phase 1.1 existe pour que la 1.2 ne se trompe pas de cible.
- **Un seuil de régression à 20 % crie au loup.** Mesuré : à code identique,
  `mirror-rotate` a bougé de 18 % entre deux exécutions. Le bench prend la
  médiane de N et n'annonce un écart qu'au-delà de 25 %.
- **Assainir un identifiant au lieu de le refuser.** `a/b` et `a b` deviennent
  tous deux `a_b` : deux projets distincts dans le même dossier, donc une perte
  de données silencieuse. `FsAdapter` valide et refuse.
- **Deux fonctions homonymes aux règles différentes.** Le site avait deux
  `regionCoordsFromName`, l'une acceptant `r_X_Z.mca` et l'autre non. Une seule
  a été reprise.
- **Régénérer un aperçu sans troncature.** Sur le site, annuler une opération sur
  un très gros build levait `too_many_blocks` alors que l'annulation avait
  réussi. Tout ce qui dérive un aperçu doit tronquer et le signaler.
- **`import * as Icons from 'lucide-react'`** embarque les ~1500 icônes de la
  bibliothèque : 1 Mo de bundle pour en afficher onze. Passer par
  `renderer/shell/icons.js`, qui les réexporte nommément.
- **Deux racines derrière le même préfixe `app://`.** Vite écrit déjà le bundle
  dans `dist/renderer/assets` ; servir aussi les polices sous `assets` faisait
  répondre 404 aux scripts de l'application. Les assets embarqués sont sous
  `res/`.
- **Couleurs de sommet en sRGB.** three.js les traite comme linéaires et
  réencode à l'affichage : envoyer du sRGB tel quel fait passer deux fois dans
  l'encodage et délave tout le build. La conversion est dans `buildTables`.
- **Un panneau redimensionnable n'est pas un conteneur flex.** `flex: 1` sur le
  viewport ne lui donnait aucune hauteur, et le canvas se rendait en 1175×0 —
  sans la moindre erreur. `height: 100%`.
- **Une save ne s'ouvre jamais en entier.** Plusieurs centaines de régions,
  des dizaines de gigaoctets : `worldOverview` rend la carte (noms et tailles
  de fichiers seulement), puis on ne matérialise que les régions demandées.
- **Le bloc −1 est dans la région −1, pas la région 0.** Toute traduction
  coordonnées monde → région passe par `regionsForBBox`, qui utilise une
  division PLANCHER. Une division entière naïve charge la mauvaise moitié du
  monde sans rien signaler.
- **Un état initial paresseux ne se rejoue pas.** `useState(() => …)` dans un
  composant monté dès le démarrage s'exécute avant que les données existent :
  la présélection du `WorldPicker` ne prenait jamais. Ce qui dépend d'une
  donnée qui arrive plus tard va dans un effet.
- **Une grille en `1fr` s'étire.** La carte des régions doit garder ses
  proportions de monde : colonnes à taille fixe, jamais `1fr`.
- **Le contenu d'un coffre n'est pas dans la grille de blocs.** Les block
  entities sont une liste à part, avec leurs coordonnées MONDE. Toute opération
  qui déplace ou efface des blocs doit les suivre — sinon un build pivoté
  abandonne ses coffres. Elles voyagent dans la `Schematic` (`transform.js`),
  donc toutes les transformations en héritent ; l'entrée est recopiée telle
  quelle, seules ses coordonnées changent.
- **Un fil par chunk ne gagne rien.** Le principal a besoin de l'arbre NBT pour
  réécrire sans perte, et le TRANSFÉRER coûte plus que le décoder (65 ms contre
  60 sur 128 chunks). La seule découpe qui paie est un fil par RÉGION : un
  `ArrayBuffer` se transfère sans copie. Et elle n'est juste que pour les
  opérations colonne-locales (`COLUMN_LOCAL_OPS`) — une opération qui lit un
  voisin verrait de l'air au bord de sa région.
- **`getBlock` alloue un objet par appel.** Une boucle qui balaie une colonne
  pour savoir « est-ce de l'air ? » en jette des millions : 34 % du temps de
  `terrain`. `isAirAt` / `matchesAt` lisent la palette en place ; elles sont
  optionnelles sur le volume, comme `getBiome`.
- **Sérialiser un cache en JSON.** L'aperçu passait ~330 ms par opération dans
  `stringify`/`parse`/gzip, quel que soit le nombre de blocs changés. En binaire
  non compressé : ~30 ms, pour 5,1 Mo au lieu de 2,0. Un cache s'optimise pour
  le temps. Corollaire : un format binaire se reconnaît à ses OCTETS, jamais à
  son nom de fichier — c'est ce qui permet de relire l'ancien.
- **Compresser un fichier de CACHE au niveau par défaut.** L'aperçu passait
  457 ms dans gzip pour gagner 350 ko sur un fichier qu'on régénère à volonté.
  Niveau 1 : 67 ms. Un cache s'optimise pour le temps, pas pour la place.
- **Repasser d'un tableau typé à un tableau JS coûte cher.** 850 000 blocs :
  160 ms pour convertir un `Int32Array`, 16 ms pour remplir un `Array`
  prédimensionné par index. Ce qui finit en JSON doit naître en `Array`.
- **Une clé texte dans une boucle chaude.** Le recollage d'aperçu refabriquait
  `nom|propriétés` par bloc : 317 ms. Une table de correspondance calculée une
  fois par palette ramène la boucle à de l'entier.
- **Un `findIndex` avec une clé fabriquée dans le comparateur.** `setBlock`
  refabriquait la clé texte de CHAQUE entrée de palette à chaque bloc : onze
  allocations par bloc pour une palette de dix. Un index `Map` construit une
  fois par section : × 3,5. Corollaire : les opérations parcourent en YZX, donc
  un mémo d'UNE case sur la section résolue supprime les recherches de chunk.
- **Un normaliseur qui jette ce qu'il ne nomme pas.** `normalizeParams`
  (`worldedit/operations.js`) ne recopie que les paramètres qu'il liste, et le
  cas non personnalisé de `naturalize` faisait `return { preset }`. Ajouter
  `seed` au descripteur ET à l'opération n'aurait rien changé : la graine
  disparaissait entre les deux, sans erreur. Un nouveau paramètre se branche à
  TROIS endroits — descripteur, normaliseur, opération.
- **Un tirage par bloc se hache sur la POSITION, pas sur un état.** Un
  générateur à état ne rejoue identique que si la boucle visite les cases dans
  le même ordre — contrainte invisible qu'une optimisation casserait sans
  bruit. `hash3(x, y, z, seed)` est en plus stable par morceaux : remélanger un
  coin d'une zone redonne les mêmes blocs qu'un mélange de la zone entière.
- **Une couleur d'accent réglable casse le texte posé dessus.** Un accent sombre
  choisi par l'utilisateur donnait un bouton principal noir sur noir. `inkOn`
  (`theme.js`) tranche par contraste WCAG ; le test exige 4,5:1 sur chaque
  accent proposé.
- **Deux sources pour la même valeur par défaut divergent.** `tokens.css` sert
  au premier rendu, `theme.js` ensuite : `--accent-dim` valait `#5E8D7E` en dur
  contre `#5B8476` calculé, et l'interface sautait pendant une image. Un test
  compare désormais les deux.
- **Le coin entre deux barres de défilement est BLANC** tant qu'on ne le peint
  pas (`::-webkit-scrollbar-corner`). Il n'apparaît que quand un conteneur
  défile dans les deux sens — donc jamais pendant qu'on dessine l'interface, et
  toujours chez qui a agrandi la sienne.
- **Le verrou `session.lock` n'est détectable que sur Windows.** Ailleurs il est
  consultatif et une ouverture réussie ne prouve rien. `probeWorldLock` renvoie
  `{ locked, reliable }` : ne jamais réduire ça à un booléen, ce serait
  affirmer qu'un monde est libre sans le savoir.
