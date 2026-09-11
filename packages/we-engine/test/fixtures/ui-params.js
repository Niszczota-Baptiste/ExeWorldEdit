// Paramètres tels que l'INTERFACE les envoie, pour chaque opération déclarée.
//
// Un seul jeu, partagé par les tests du normaliseur et par le balayage qui
// exécute réellement chaque opération. Le garder ici plutôt que dans un fichier
// de test évite qu'importer les échantillons rejoue les tests d'à côté.
//
// Les champs `block` partent en `{ name }` — c'est ce que fabrique
// `Inspector.jsx` —, les entiers en nombres, les enums en identifiants.

export const ECHANTILLONS_UI = {
  mirror: { axis: 'x' },
  mirrorcopy: { axis: 'z', side: 'negative', gap: 3, mode: 'overwrite' },
  rotate: { degrees: 270 },
  translate: { dx: 2, dy: -3, dz: 4 },
  stack: { count: 3, direction: 'north' },
  scale: { factor: 2, hollow: true },
  replace: { from: [{ name: 'minecraft:dirt' }], to: { name: 'minecraft:stone' } },
  set: { block: { name: 'minecraft:stone' }, mask: { type: 'above', y: 5 } },
  mix: { from: { name: 'minecraft:dirt' }, pattern: [{ name: 'minecraft:stone', weight: 60 }, { name: 'minecraft:andesite', weight: 40 }], mask: { type: 'all' }, seed: 7 },
  walls: { block: { name: 'minecraft:stone' } },
  faces: { block: { name: 'minecraft:stone' } },
  hollow: {},
  overlay: { block: { name: 'minecraft:grass_block' } },
  naturalize: { preset: 'custom', seed: 5, surface: { name: 'minecraft:sand' }, soil: { name: 'minecraft:sandstone' }, filler: { name: 'minecraft:stone' } },
  drain: {},
  cut: {},
  sphere: { block: { name: 'minecraft:stone' }, radius: 6, hollow: true },
  cyl: { block: { name: 'minecraft:stone' }, radius: 6, hollow: false },
  pyramid: { block: { name: 'minecraft:stone' }, hollow: true },
  cone: { block: { name: 'minecraft:stone' }, hollow: false },
  line: { block: { name: 'minecraft:stone' } },
  path: { preset: 'bridge', width: 4, bow: 6, block: { name: 'minecraft:oak_planks' } },
  smooth: { iterations: 3 },
  erode: { iterations: 2, threshold: 5 },
  dilate: { iterations: 2, threshold: 2 },
  biome: { biome: 'minecraft:desert' },
  terrain: { style: 'montagne', amplitude: 70, scale: 48, seed: 9, palette: 'custom', clearAbove: false, surface: { name: 'minecraft:snow_block' }, soil: { name: 'minecraft:dirt' }, filler: { name: 'minecraft:stone' } },
  copy: {},
  paste: { mode: 'overwrite' },
};
