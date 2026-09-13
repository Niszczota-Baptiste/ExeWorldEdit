# titiforge — dossier transitoire

⚠️ **Ce dossier n'a pas vocation à rester ici.** Il attend la création du dépôt
`titiforge`, que l'intégration GitHub de la session n'a pas le droit de créer
(403). Il est posé sur la branche de travail d'`ExeWorldEdit` pour que le
prototype et ses mesures ne disparaissent pas avec le conteneur.

Rien d'`ExeWorldEdit` n'a été modifié ni supprimé. Le déplacement se fera d'un
`git mv` une fois le dépôt créé.

## Ce qu'il contient

- **`RESULTATS.md`** — les mesures du prototype face au moteur actuel, sur le
  même fichier et la même machine. C'est le document à lire.
- **`proto/`** — le prototype lui-même. ~650 lignes de Rust qui ne prouvent que
  des chiffres : lecteur NBT ciblé, section packée, trois stratégies de
  `//replace` comparées et vérifiées l'une contre l'autre.

## Décisions déjà prises

| | |
|---|---|
| Cœur | **Rust** — `rayon` pour le parallélisme par données, et le même langage que le rendu |
| Rendu | **wgpu** direct — Vulkan / DX12 / Metal d'une seule base, avec compute shaders |
| Coque | **winit + wgpu + egui** — une fenêtre, une surface, intégration nulle. La couche UI reste derrière un trait pour qu'une coque Tauri/React soit possible plus tard sans toucher au cœur |
| Dépôt | Nouveau — `ExeWorldEdit` reste intact comme référence d'écriture et outil de travail pendant les 3-4 mois du MVP |

## Ce qui vient ensuite

Phase 0 du plan : workspace Cargo, `tf-nbt` et `tf-anvil` en lecture *et*
écriture, round-trip lossless vérifié par un décodeur indépendant réécrit de
zéro, et `criterion` avec les scénarios de `we-engine` sous leurs noms actuels.

Le prototype n'écrit rien pour l'instant : il lit, transforme en mémoire et
vérifie. Le round-trip lossless est l'invariant n° 2 d'`ExeWorldEdit` et c'est
la première chose que la phase 0 doit rétablir.
