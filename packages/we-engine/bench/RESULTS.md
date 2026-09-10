# Bench du moteur — mesures AVANT optimisation

Généré par `npm run bench` le 2026-09-10.

## Comment lire ces chiffres

Chaque scénario tourne dans **son propre processus** : `maxRSS` est une marque
haute cumulée, donc dans un processus partagé le pic du premier scénario
deviendrait le plancher de tous les suivants.

⚠️ **Ces mesures viennent d’un conteneur partagé, pas d’une machine dédiée.**
Les valeurs absolues bougeront d’une exécution à l’autre — parfois beaucoup.
Ce qui est exploitable ici, ce sont les **rapports entre scénarios** et la
décomposition du chargement : ils tiennent quelle que soit la machine.

Machine : Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cœurs, 16 Go, Node 22.22.2.

## Opérations

| Scénario | Temps | Pic mémoire | Débit | Sortie |
|---|---|---|---|---|
| `set-10M` | 6391 ms | 160 Mo | 1.6 M/s blocs |  |
| `replace` | 2068 ms | 139 Mo | 1.7 M/s blocs |  |
| `mix` | 2730 ms | 457 Mo | 1.3 M/s blocs |  |
| `mirror-rotate` | 10.1 s | 1013 Mo | 701 k/s blocs |  |
| `terrain-1024` | 39.0 s | 1068 Mo | 27 k/s colonnes |  |
| `naturalize` | 2111 ms | 161 Mo | 31 k/s colonnes |  |

## Entrées / sorties

| Scénario | Temps | Pic mémoire | Débit | Sortie |
|---|---|---|---|---|
| `region-decode` | 3433 ms | 333 Mo | 4 k/s sections | 5.0 Mo |
| `region-write` | 871 ms | 462 Mo | 1 k/s chunks | 5.0 Mo |
| `export-mca` | 5 ms | 323 Mo | 214/s régions | 5.0 Mo |
| `export-schem` | 355 ms | 184 Mo | 3.0 M/s blocs | 0.0 Mo |

## Décomposition du chargement d’une région

| Scénario | Temps | Pic mémoire | Débit | Sortie |
|---|---|---|---|---|
| `phase-inflate` | 91 ms | 346 Mo | 11 k/s chunks |  |
| `phase-nbt-parse` | 340 ms | 356 Mo | 3 k/s chunks |  |
| `phase-nbt-simplify` | 39 ms | 461 Mo | 26 k/s chunks |  |
| `phase-unpack-sections` | 2619 ms | 461 Mo | 5 k/s sections |  |

## Chemin chaud de RegionStore

| Scénario | Temps | Pic mémoire | Débit | Sortie |
|---|---|---|---|---|
| `store-setblock` | 1034 ms | 97 Mo | 1.0 M/s blocs |  |
| `store-getblock` | 136 ms | 98 Mo | 7.7 M/s blocs |  |

## Où part le temps au chargement

Décoder une région pleine (1024 chunks, 12288 sections) prend **3433 ms**.
Répartition mesurée :

| Étape | Temps | Part |
|---|---|---|
| `inflate` | 91 ms | 3 % |
| `nbt-parse` | 340 ms | 11 % |
| `nbt-simplify` | 39 ms | 1 % |
| `unpack-sections` | 2619 ms | 85 % |

(La somme des étapes ne retombe pas exactement sur le total : chacune
réalloue de son côté. Ce sont les **proportions** qui comptent.)

## Ce que la décomposition apprend

**Mon hypothèse de départ était fausse.** J'attendais que `prismarine-nbt`
domine le chargement d'une région, et j'ai annoncé qu'il faudrait probablement
le remplacer. La mesure dit l'inverse : le NBT (parse + simplify) pèse 12 %,
l'inflate 3 %, et **85 % du temps part dans `readSection`** — le dépack des
palettes et des tableaux de bits, c'est-à-dire notre propre code.

La cause est dans `decodeBlockStates` (`src/anvil/section.js`) :

```js
const longs = data.map(pairToBig);            // un BigInt par long
for (let n = 0; n < SECTION_VOLUME; n++) {
  indices[n] = Number((longs[li] >> BigInt(within * bits)) & mask);
  //                                ^^^^^^^^^^^^^^^^^^^^  un BigInt de plus, PAR BLOC
}
```

Une région pleine fait 12 288 sections × 4096 blocs, soit ~50 M d'itérations,
chacune allouant plusieurs BigInt. Les opérations BigInt sont un ordre de
grandeur plus lentes que l'arithmétique sur `Number` et allouent sur le tas.

C'est une bonne nouvelle : le format 1.16+ ne fait pas chevaucher un index sur
deux longs, et un index tient sur 12 bits au plus. Tout se lit donc en
arithmétique 32 bits ordinaire, sans jamais construire un BigInt.

Remplacer `prismarine-nbt` reste envisageable un jour, mais ce n'est clairement
pas là qu'est le gain : ce serait optimiser les 12 % en laissant les 85 %.

## Ce que ces chiffres n’incluent pas

- Aucun parallélisme : tout tourne sur un seul fil. Le pool de `worker_threads`
  est justement l’objet de la phase 1.2.
- Le rendu. Le viewport a ses propres mesures, prises dans l’application.
- Les entités : elles ne sont pas encore lues ni écrites (phase 1.3).
