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
| dossier de save (`level.dat` + `region/`) | sa **carte** — on choisit ensuite la zone (voir plus bas) ; le projet garde la save attachée, seul cas où « Appliquer au monde » existe |
| dossier `region/` isolé | sa carte aussi, sans save attachée |
| `.schem` (Sponge), `.litematic` | un projet : régions vierges à la taille du schematic, puis tamponnage |

Un chemin peut aussi arriver **au lancement** (`titi-worldedit.exe "…/saves/Monde"`,
« ouvrir avec », un fichier lâché sur l'icône) : il suit le même chemin qu'un
glisser-déposer, sans traitement à part.

### Ouvrir un monde : la carte d'abord, la zone ensuite

![Choisir la zone](images/selecteur-zone.png)

Une région couvre 512 × 512 blocs. Un monde joué quelques mois en compte
facilement plusieurs centaines, soit des dizaines de gigaoctets : **tout charger
n'est pas lent, c'est impossible**. L'ouverture se fait donc en deux temps.

1. `worldOverview` lit les seuls noms et tailles de fichiers — aucun décodage,
   instantané même sur un monde énorme — et rend la carte de ce qui existe.
2. On désigne les régions voulues : au clic, au glissé pour un rectangle, ou en
   entrant des coordonnées du F3 avec un rayon. `regionsForBBox` traduit une
   boîte en coordonnées monde en indices de région, et seules celles-là sont
   matérialisées dans le staging.

Le piège de cette traduction, ce sont les **coordonnées négatives** : le bloc
`-1` appartient à la région `-1`, pas à la région `0`. Une division entière naïve
chargerait la mauvaise moitié du monde, en silence. Des tests dédiés couvrent
l'origine et ses quatre quadrants.

Une zone qui déborde sur du terrain jamais généré est normale : on charge ce
qu'il y a et on annonce combien manquait, plutôt que d'échouer sur du vide.

`loadMoreRegions` étend ensuite un projet ouvert. Les régions déjà chargées ne
sont **pas** rechargées — le travail en cours dessus serait sinon écrasé par le
contenu du disque.

Un schematic n'a ni chunks ni coordonnées absolues. Plutôt que d'en faire un cas
particulier que tout le moteur devrait connaître, on lui fabrique des régions et
on l'y tamponne : le résultat est un build ordinaire, éditable et annulable
comme les autres. Son offset d'origine est respecté, si bien que le recoller
sans décalage le remet exactement où il a été pris.

Le glisser-déposer passe par le même point d'entrée que les dialogues : c'est
l'extension qui choisit la porte. Le renderer ne lit jamais le fichier — il n'en
transmet que le chemin.

---

## Réglages et mode performance

Les réglages vivent dans `settings.json`, à la racine de l'espace de données, et
passent par le `StorageAdapter` (`readSettings` / `writeSettings`) comme tout le
reste. Ils ne sont **pas** dans le `localStorage` du renderer : celui-ci est
effacé par un vidage de cache, et un réglage qui disparaît à chaque mise à jour
n'est pas un réglage.

![Les réglages](images/reglages.png)

Quatre réglages, appliqués **à la frappe** et non à la validation — un réglage
d'apparence qu'on ne voit qu'après avoir fermé la fenêtre se règle à l'aveugle :

| Réglage | Effet | Bornes |
|---|---|---|
| `textScale` | multiplie `--t-micro/small/body/title` | 0,8 → 1,6 |
| `uiScale` | multiplie la densité de la coquille (barres, rail, boutons, champs) | 0,85 → 1,5 |
| `accent` | `--accent` et ses quatre nuances dérivées | tout `#RRGGBB` |
| `perf` | affiche le relevé des opérations | oui / non |
| `limits` | plafonds du moteur (voir plus bas) | par plafond |

### Tout passe par des variables CSS

`renderer/theme.js` transforme les réglages en une poignée de variables posées
sur `:root` ; la feuille de style entière suit. Aucun composant ne lit les
réglages pour se dimensionner lui-même, sans quoi la moitié de l'interface
obéirait et l'autre non.

Ce module est **pur** en dehors de `applyTheme` — donc testé sans navigateur
(`apps/desktop/test/theme.test.js`, 11 tests). Deux choses s'y vérifient qu'on
ne voit pas à l'œil :

- **`inkOn(accent)`** choisit le texte du bouton principal par contraste WCAG.
  Sans ce calcul, un accent sombre choisi par l'utilisateur donne un bouton noir
  sur noir : le réglage casserait l'interface au lieu de la personnaliser. Le
  test exige 4,5:1 sur chaque accent proposé.
- **`tokens.css` et le module ne doivent pas diverger.** Le premier sert au tout
  premier rendu, avant que le moteur ait répondu ; le second sert ensuite. Un
  test compare les deux à l'échelle 1 — et a trouvé l'écart dès sa première
  exécution : `--accent-dim` valait `#5E8D7E` en dur contre `#5B8476` calculé.
  L'interface sautait au démarrage, pendant une image.

L'or de la sélection (`--select`) n'est **pas** réglable : c'est un code de
lecture partagé par le viewport, la pastille d'onglet et la barre d'état, pas
une décoration.

### Les plafonds du moteur

`DEFAULT_LIMITS` (`staging/geometry.js`) n'était réglable que dans le code. Les
cinq plafonds qui dépendent de la machine sont maintenant dans le panneau :
volume de sélection, budget d'aperçu, extraction de zone, baguette magique,
profondeur d'annulation.

**`worldMinY` et `worldMaxY` n'y sont pas.** Ce ne sont pas des préférences mais
la hauteur du monde Minecraft : les rendre réglables laisserait écrire hors du
monde et produirait des régions qu'aucun jeu ne relirait. `normalizeLimits` les
remet depuis `DEFAULT_LIMITS` quoi qu'on lui passe — un `settings.json` bricolé
à la main ne peut pas les déplacer, et un test l'exige.

Trois décisions valent d'être notées :

- **Le bornage est à la frontière des réglages, pas dans le constructeur.**
  `createStaging(adapter, options)` reçoit ses plafonds du CODE : un test qui
  demande un budget d'aperçu de dix blocs pour vérifier la troncature doit
  obtenir dix. C'est `setLimits` — l'entrée humaine — qui borne. Les tests
  existants ont attrapé l'erreur inverse dès le premier jet.
- **Un plafond prend effet tout de suite.** `limits` est muté en place et tous
  les appels lisent `limits.x` au moment de l'appel : pas de staging à
  reconstruire, donc pas de cache d'aperçu perdu. Le relire au prochain
  démarrage ferait croire que le réglage n'a pas marché.
- **Les BORNES viennent du moteur**, transportées par `getSettings`. L'interface
  génère ses champs depuis elles, comme l'inspecteur génère les siens depuis les
  descripteurs d'opérations. Les redéclarer côté renderer les ferait diverger —
  et importerait le moteur entier dans le bundle.

Le champ réaffiche toujours la valeur **retenue par le moteur**, jamais celle
qui a été tapée : saisir dix fois le plafond ne doit pas laisser croire que
c'est passé.

### Le relevé des opérations

Le moteur chronomètre chaque opération en quatre temps (`phaseTimer`,
`staging/geometry.js`), exactement les mêmes que ceux annoncés par la barre de
progression :

| Phase | Ce qu'elle couvre |
|---|---|
| `load` | décoder les régions touchées, warmup du `RegionStore` |
| `apply` | l'opération elle-même |
| `commit` | instantané d'annulation + réécriture des régions |
| `preview` | redériver l'aperçu 3D |
| `reste` | ce que les quatre n'ont pas couvert (validation, journal) |

Le relevé est joint au résultat de l'opération **et consigné au journal**
(`AuditEntry.timings`), donc consultable après coup : ouvrir un projet recharge
son historique de mesures depuis `audit.jsonl`. Ce que le panneau montre a donc
réellement été mesuré dans le moteur — ce n'est pas un chronomètre tenu par
l'interface, qui compterait aussi les allers-retours entre processus.

![Le relevé de performance](images/performances.png)

Chaque ligne porte une barre **à l'échelle** des durées, et la phase dominante
est nommée en clair : la déduire de la largeur d'un segment n'est pas la donner.
Le cumul en bas répond à l'autre question — une commande lente une fois est un
accident, la même phase lente dix fois est une cible.

### Ce que le relevé a montré tout de suite

Sur le build de démonstration (192 × 192, 850 000 blocs, 12 opérations), le
premier cumul affiché était sans appel :

```
aperçu 82 %  ·  calcul 9 %  ·  lecture 6 %  ·  écriture 3 %  ·  reste 0 %
```

**82 % du temps du moteur partait à régénérer l'aperçu.** Poser 121 blocs avec
`set` coûtait 815 ms, dont 761 ms d'aperçu.

---

## Rendre l'aperçu incrémental

La piste évidente — « ne pas afficher ce qu'on ne voit pas » — a été mesurée
avant d'être suivie, et elle ne menait pas là où on croyait.

### Les faces sont déjà culées

Le mailleur n'émet une face qu'entre un plein et un vide. Sur le build de
démonstration : **849 954 blocs → 52 362 quads**, là où six faces par bloc en
feraient 5,1 millions. Il n'y a rien à gagner de ce côté.

### Les blocs enterrés, eux, sont bien du poids mort — mais on ne peut pas les jeter

| | blocs | part |
|---|---|---|
| enterrés (six voisins pleins) | 751 880 | **88,5 %** |
| visibles | 98 074 | 11,5 % |

Sauf qu'en les retirant, le mailleur voit de l'air à l'intérieur et dessine la
coque intérieure : **52 362 → 98 345 quads, +87,8 %**. On diviserait les données
par neuf pour doubler les triangles. Et le curseur de couche étant un plan de
coupe three.js et non un filtre, trancher dans une coque creuse montrerait un
build vide au milieu.

L'**occupation** de ces blocs porte du sens même quand leur **identité** n'en
porte pas : c'est elle qui dit au mailleur de ne pas dessiner. Une extraction
« surface seule » demanderait donc une sentinelle « plein, non listé » connue du
mailleur — ce n'est pas fait, et ce n'était de toute façon pas le vrai coupable.

### Le vrai coupable : la sérialisation, puis le parcours

Décomposition de la phase `preview` (~1 s) :

| | avant |
|---|---|
| **gzip** | **457 ms** |
| `deriveSparse` (parcours de l'emprise) | 338 ms |
| warmup | 101–198 ms |
| `JSON.stringify` | 77 ms |

La moitié partait à compresser un **fichier de cache local**, au niveau par
défaut. Le niveau 1 coûte 67 ms pour 350 ko de plus : 390 ms rendus sur une
ligne.

Le reste tient au fait que l'aperçu était redérivé **en entier** après chaque
opération. Or `applyOperation` connaît déjà la boîte qu'il a touchée — c'est
celle dont il prend l'instantané d'annulation, `sel ∪ bounds`. `splicePreview`
(`src/staging/preview.js`, pur) redérive cette seule boîte et la recolle sur
l'aperçu précédent.

Ce n'est pas un choix de confort : **si une opération écrivait hors de cette
boîte, l'annulation serait déjà fausse**. Le recollage est donc exactement aussi
fiable que l'undo, ni plus ni moins. Il renvoie `null` — et l'appelant redérive
tout — dès qu'il ne peut rien garantir : aperçu source tronqué, ou budget
dépassé en cours de route.

### Deux pièges de mesure en chemin

Le premier jet n'a rendu que 25 %. La mesure a dit pourquoi, deux fois :

1. **La boucle chaude refabriquait une clé texte de palette par bloc** —
   850 000 concaténations et autant de recherches dans une `Map`. Une table de
   correspondance calculée une fois par palette ramène la boucle à de l'entier :
   317 → 184 ms.
2. **Repasser d'un `Int32Array` à un tableau JS coûtait 160 ms.** L'aperçu finit
   en JSON, donc le tampon doit être un `Array` ordinaire — prédimensionné et
   rempli par index, c'est 16 ms. Dix fois moins, pour un détail de type.

Et `readPreview` relisait à chaque opération (gunzip 48 ms + `JSON.parse`
161 ms) un objet qu'on venait soi-même d'écrire : une case de cache en mémoire,
posée dans `writePreview`/`readPreview` pour ne pas pouvoir se désynchroniser,
supprime ces 209 ms.

### Résultat

| phase | avant | après | |
|---|---|---|---|
| lecture | 732 ms | 634 ms | −13 % |
| calcul | 1 233 ms | 1 130 ms | −8 % |
| écriture | 427 ms | 379 ms | −11 % |
| **aperçu** | **10 879 ms** | **2 825 ms** | **−74 %** |
| **total** | **13 276 ms** | **4 968 ms** | **−63 %** |

L'aperçu est **3,9 × plus rapide** et retombe de 82 % à 57 % du temps moteur.
Sur les petites opérations, celles qu'on enchaîne : `set` de 121 blocs passe de
**815 ms à 239 ms**, `path` de 847 à 243 ms.

Le plancher restant est structurel : on resérialise l'aperçu entier à chaque
opération (`JSON.stringify` 46 ms + gzip 76 ms + recollage ~40 ms), quel que
soit le nombre de blocs changés. Descendre plus bas demande de changer le
FORMAT de l'aperçu — binaire, ou découpé par chunk — ce qui touche aussi le
renderer. Phase 1.2 également.

---

## Le chemin chaud du `RegionStore`

Le bench annonçait un écart de 7× entre lecture et écriture : `setBlock` à
1,1 M/s contre `getBlock` à 7,8 M/s. Le profileur a dit exactement pourquoi.

| poste | part du temps d'écriture |
|---|---|
| `propsKey` (clé texte des états) | 22 % |
| le rappel du `findIndex` sur la palette | 14 % |
| `_chunkRec` + `_regionAt` (clés texte de chunk) | 12 % |
| ramasse-miettes (les chaînes jetées ci-dessus) | 5 % |

`setBlock` **refabriquait la clé texte de chaque entrée de palette, à chaque
bloc** : pour une palette de dix entrées, onze allocations de chaîne par bloc
écrit.

Trois corrections, dans cet ordre de gain :

1. **Index de palette en `Map`**, construit une fois par section et tenu à jour
   à l'ajout. Une clé fabriquée et une recherche par bloc, au lieu de 1 + N.
   `grid.palette` n'est modifiée qu'à un seul endroit, ce qui rend l'index
   impossible à désynchroniser tant que ça reste vrai.
2. **Mémo d'une case sur la section résolue.** Les opérations parcourent en
   YZX, donc seize blocs consécutifs tombent dans la même section : une seule
   case suffit à supprimer `_chunkRec` et `_regionAt` du profil. Le mémo profite
   aussi à `getBlock`, qui n'était pourtant pas la cible.
3. **Un bloc sans état rend son nom comme clé**, sans concaténation. C'est
   l'écrasante majorité des blocs d'un build. `{}` et `null` rendent la même
   clé, sinon un bloc décrit des deux façons occuperait deux entrées de palette.

### Résultat

| scénario | référence | après | |
|---|---|---|---|
| `store-setblock` | 983 ms | 284 ms | **× 3,5** |
| `store-getblock` | 135 ms | 48 ms | **× 2,8** |
| `set-10M` | 6 590 ms | 984 ms | **× 6,7** |
| `replace` | 2 092 ms | 326 ms | **× 6,4** |
| `naturalize` | 2 254 ms | 625 ms | **× 3,6** |
| `mirror-rotate` | 9 312 ms | 5 190 ms | **× 1,8** |
| `mix` | 2 773 ms | 2 148 ms | × 1,3 |

`set-10M` passe de 1,7 à 10,7 M/s. `mix` gagne le moins : son coût est ailleurs
(le tirage pondéré lui-même), ce que le profil confirmera si on y revient.

Ce qui reste : `getBlock` alloue toujours un objet `{ Name, Properties }` par
appel. Le supprimer demanderait une interface à identifiants entiers, donc de
toucher `transform.js` entier — un autre chantier.

---

## Rejouabilité des tirages aléatoires

L'invariant n° 4 veut que toute génération aléatoire soit rejouable à seed
égale. Deux endroits ne le respectaient pas : `opMix` et `fillerPicker`
(la roche profonde de `naturalize` et `terrain`) appelaient `Math.random()`.
Deux exécutions de `make-demo.js` avec la même seed ne rendaient donc pas le
même build — « Massif rocheux » sortait à 105 369 puis 105 385 blocs.

Le défaut est venu du relevé de performance : en comparant deux exécutions pour
mesurer un gain, les compteurs de blocs ne tombaient pas juste.

### Un hash de position, pas un générateur à état

Les deux tirages passent maintenant par `hash3(x, y, z, seed)`, du même
tonneau que le `hash2` qui sert déjà au bruit de relief. C'est un meilleur
choix qu'un générateur à état pour ce travail :

- **il ne dépend pas de l'ordre de parcours.** Un générateur à état ne rejoue
  identique que si la boucle visite les cases dans le même ordre — une
  contrainte invisible qu'une optimisation future casserait sans bruit ;
- **il est stable par morceaux.** Mélanger un cube entier, puis remélanger un
  coin de ce cube avec la même seed, redonne exactement les mêmes blocs dans ce
  coin. Un test l'exige.

La roche profonde décale sa graine (`seed + 9176`) : sans ça, elle partagerait
sa graine avec le bruit de relief et son motif pourrait épouser celui des
collines.

`mix` et `naturalize` gagnent un paramètre `seed`, comme `terrain` en avait
déjà un.

### Le piège : un normaliseur qui jette en silence

`normalizeParams` (`worldedit/operations.js`) ne garde que les paramètres qu'il
nomme explicitement — et pour `naturalize`, le cas non personnalisé faisait
`return { preset }`. Ajouter `seed` au descripteur et à l'opération n'aurait
donc **rien changé** : la graine aurait été jetée entre les deux, sans erreur,
et le tirage serait resté non rejouable pendant qu'un champ « Graine » invitait
à le régler.

### Vérification

Deux exécutions de `make-demo.js` rendent désormais des compteurs identiques au
bloc près, palette dominante comprise. Côté tests, la rejouabilité se vérifie
sur la sélection ENTIÈRE et non sur un bloc — comparer un seul bloc passerait
par chance une fois sur N. Un test de distribution vérifie en plus que les
proportions tirées suivent les poids demandés à moins de 2 points : un hash mal
mélangé passerait les tests de rejouabilité et produirait quand même des bandes.

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
- **`getBlock` alloue un objet par appel** (`{ Name, Properties }`). Le reste du
  chemin chaud est traité (voir « Le chemin chaud du `RegionStore` »).
- **Un seul fil d'exécution.** Pas de pool de workers. Phase 1.2.
- **L'aperçu se resérialise en entier** à chaque opération, même pour un bloc
  changé : `JSON.stringify` + gzip forment un plancher d'environ 120 ms. Le
  parcours, lui, est devenu incrémental. Descendre plus bas demande un format
  binaire ou découpé par chunk, donc de toucher aussi le renderer. Phase 1.2.
- **Pas de textures ni de modèles non cubiques** dans le viewport (phase 2.5),
  détaillé plus bas.

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

### Phase 1.1 : la mesure a contredit l'intuition

J'avais annoncé que `prismarine-nbt` dominerait le chargement d'une région et
qu'il faudrait sans doute le remplacer. **C'était faux.** Le bench a montré :

| Étape | Avant | Part |
|---|---|---|
| inflate | 101 ms | 3 % |
| `nbt.parse` | 346 ms | 11 % |
| `nbt.simplify` | 41 ms | 1 % |
| `readSection` | 2585 ms | **85 %** |

Le coût était dans notre propre code : `decodeBlockStates` allouait **un BigInt
par bloc** pour extraire un index de palette. Une région pleine, c'est 12 288
sections × 4096 blocs.

Le format 1.16+ ne fait jamais chevaucher un index sur deux longs et un index
tient sur 12 bits au plus : tout se lit en arithmétique 32 bits. Résultat
mesuré, médiane de 3 :

- dépack de sections : **× 10,7**
- chargement d'une région complète : **× 4,2** (3502 → 841 ms)

La réécriture est jugée par `test/section-unpack.test.js`, qui compare sa sortie
à l'implémentation BigInt d'origine sur les onze largeurs de palette. Une
manipulation de bits ne se relit pas, elle se compare.

Maintenant que le dépack ne coûte plus rien, le NBT est effectivement devenu le
premier poste (50 % du chargement) — mais c'est la mesure qui l'a établi, pas
l'intuition, et l'ordre des deux n'est pas un détail : remplacer le NBT d'abord
aurait été optimiser 12 % en laissant 85 %.

### Le seuil de régression en intégration continue

Le cahier des charges demande de signaler une régression de plus de 20 %.
Mesuré ici : à **code identique**, `mirror-rotate` est passé de 9,3 s à 11,0 s
entre deux exécutions — 18 % d'écart pour rien. Un seuil à 20 % sur une machine
partagée déclenche sur du bruit, et une garde qui crie au loup finit désactivée.

Le lanceur prend donc la **médiane** de N exécutions (`--repeat=3`) et n'annonce
un écart qu'au-delà de 25 %.

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

`TITI_SCREENSHOT_WHEEL=1` et `TITI_SCREENSHOT_SETTINGS=1` ouvrent la roue
d'outils ou les réglages avant la capture, par un **vrai** événement clavier
(`Espace`, `Ctrl` `,`) et non par un crochet de test : ce qu'on capture est alors
exactement ce que produit la touche, pas un état forcé qui pourrait mentir.
`TITI_SCREENSHOT_DELAY` règle l'attente avant la prise (9 000 ms par défaut).

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
| 2.4b | Réglages (texte, densité, accent) + mode performance | **fait** — `settings.json` via l'adapter, `theme.js` testé, relevé par phase |
| 2.5 | Viewport | maillage par chunk + AO **fait** ; atlas de textures et modèles non cubiques à venir |
| 2.6 | Empaquetage | configuration electron-builder écrite, jamais exécutée sur Windows |
| 1.1 | Mesurer | **fait** — `bench/`, 16 scénarios, `RESULTS.md` |
| 1.2 | Moteur rapide | dépack de sections **× 10,7**, aperçu incrémental **× 3,9** (−63 % sur le total) ; reste : format d'aperçu binaire, `RegionStore` en tableaux typés, pool de workers, plafonds réglables |
| 1.3 | Entités | à venir |
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
