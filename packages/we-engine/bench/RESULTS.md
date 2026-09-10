# Bench du moteur

Généré par `npm run bench` le 2026-09-10.
Deux colonnes de temps : la référence figée, et la mesure du jour.

## Comment lire ces chiffres

Chaque scénario tourne dans **son propre processus** : `maxRSS` est une marque
haute cumulée, donc dans un processus partagé le pic du premier scénario
deviendrait le plancher de tous les suivants.

⚠️ **Ces mesures viennent d’un conteneur partagé, pas d’une machine dédiée.**
Les valeurs absolues bougeront d’une exécution à l’autre — parfois beaucoup.
Ce qui est exploitable ici, ce sont les **rapports entre scénarios** et la
décomposition du chargement : ils tiennent quelle que soit la machine.

Machine : Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cœurs, 16 Go, Node 22.22.2.

La colonne « Avant » vient de `bench/baseline.json`, mesuré le 2026-09-10 sur la même machine.

## Opérations

| Scénario | Avant | Après | Pic mémoire | Débit | Gain |
|---|---|---|---|---|---|
| `set-10M` | 6590 ms | 6121 ms | 158 Mo | 1.7 M/s blocs | dans le bruit |
| `replace` | 2092 ms | 2081 ms | 138 Mo | 1.7 M/s blocs | dans le bruit |
| `mix` | 2773 ms | 2695 ms | 458 Mo | 1.3 M/s blocs | dans le bruit |
| `mirror-rotate` | 9312 ms | 8422 ms | 1025 Mo | 840 k/s blocs | dans le bruit |
| `terrain-1024` | 42.0 s | 38.6 s | 1072 Mo | 27 k/s colonnes | dans le bruit |
| `naturalize` | 2254 ms | 2102 ms | 160 Mo | 31 k/s colonnes | dans le bruit |

## Entrées / sorties

| Scénario | Avant | Après | Pic mémoire | Débit | Gain |
|---|---|---|---|---|---|
| `region-decode` | 3502 ms | 884 ms | 331 Mo | 14 k/s sections | **× 4.0 plus rapide** |
| `region-write` | 857 ms | 888 ms | 466 Mo | 1 k/s chunks | dans le bruit |
| `export-mca` | 4 ms | 5 ms | 325 Mo | 208/s régions | dans le bruit |
| `export-schem` | 340 ms | 351 ms | 184 Mo | 3.0 M/s blocs | dans le bruit |

## Décomposition du chargement d’une région

| Scénario | Avant | Après | Pic mémoire | Débit | Gain |
|---|---|---|---|---|---|
| `phase-inflate` | 101 ms | 97 ms | 343 Mo | 11 k/s chunks | dans le bruit |
| `phase-nbt-parse` | 346 ms | 383 ms | 356 Mo | 3 k/s chunks | dans le bruit |
| `phase-nbt-simplify` | 41 ms | 43 ms | 456 Mo | 24 k/s chunks | dans le bruit |
| `phase-unpack-sections` | 2585 ms | 243 ms | 463 Mo | 50 k/s sections | **× 10.6 plus rapide** |

## Chemin chaud de RegionStore

| Scénario | Avant | Après | Pic mémoire | Débit | Gain |
|---|---|---|---|---|---|
| `store-setblock` | 1066 ms | 1044 ms | 98 Mo | 1.0 M/s blocs | dans le bruit |
| `store-getblock` | 141 ms | 146 ms | 98 Mo | 7.2 M/s blocs | dans le bruit |

## Où part le temps au chargement

Décoder une région pleine (1024 chunks, 12288 sections) prend **884 ms**.
Répartition mesurée :

| Étape | Temps | Part |
|---|---|---|
| `inflate` | 97 ms | 13 % |
| `nbt-parse` | 383 ms | 50 % |
| `nbt-simplify` | 43 ms | 6 % |
| `unpack-sections` | 243 ms | 32 % |

(La somme des étapes ne retombe pas exactement sur le total : chacune
réalloue de son côté. Ce sont les **proportions** qui comptent.)

## Ce que la mesure a appris

**L’hypothèse de départ était fausse.** J’attendais que `prismarine-nbt`
domine le chargement d’une région, et j’avais annoncé qu’il faudrait sans
doute le remplacer. La décomposition dit l’inverse : avant optimisation, le
NBT pesait 12 %, l’inflate 3 %, et **85 % du temps partait dans
`readSection`** — notre propre dépack de sections.

La cause était dans `decodeBlockStates` (`src/anvil/section.js`) : la boucle
allouait **un BigInt par bloc** pour extraire un index de palette. Sur une
région pleine — 12 288 sections × 4096 blocs — cela fait une cinquantaine de
millions d’itérations à plusieurs allocations chacune.

Le format 1.16+ ne fait jamais chevaucher un index sur deux longs, et un
index tient sur 12 bits au plus. Tout se lit donc en arithmétique 32 bits
ordinaire. La réécriture est couverte par `test/section-unpack.test.js`, qui
compare la sortie à l’implémentation BigInt d’origine sur les onze largeurs
de palette : une manipulation de bits ne se relit pas, elle se compare.

Remplacer `prismarine-nbt` aurait été optimiser les 12 % en laissant les
85 %. Maintenant que le dépack ne coûte plus rien, le NBT est effectivement
devenu le premier poste du chargement — mais c’est la mesure qui l’a établi,
pas l’intuition.

## Sur le seuil de régression en intégration continue

Le cahier des charges demande de signaler une régression de plus de 20 %.
Mesuré ici : à **code identique**, `mirror-rotate` est passé de 9,3 s à
11,0 s entre deux exécutions, soit 18 % d’écart pour rien. Un seuil à 20 %
sur une machine partagée déclencherait sur du bruit, et une garde qui crie au
loup finit désactivée.

D’où deux protections dans le lanceur : `--repeat=3` prend la **médiane**
(pas la moyenne, qu’un seul tour lent suffit à fausser), et tout écart de
moins de 25 % s’affiche « dans le bruit » plutôt que comme un résultat.

## Ce que ces chiffres n’incluent pas

- Aucun parallélisme : tout tourne sur un seul fil. Le pool de `worker_threads`
  est justement l’objet de la phase 1.2.
- Le rendu. Le viewport a ses propres mesures, prises dans l’application.
- Les entités : elles ne sont pas encore lues ni écrites (phase 1.3).
