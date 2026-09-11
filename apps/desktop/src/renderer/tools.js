// Les OUTILS : leur liste, les opérations que chacun met en avant, et ce que
// l'inspecteur dit de ceux qui n'en ont pas.
//
// De la donnée pure, dans son propre module et non dans `store.js`. Ce sont
// `keys.js` (qui dérive un raccourci par outil) et `store.js` (qui s'en sert
// pour l'état) qui les lisent : les laisser dans le store faisait un cycle —
// store → keys → store —, et un cycle d'initialisation ESM ne se signale qu'à
// l'exécution, par un « Cannot access before initialization ».

export const TOOLS = [
  { id: 'select', label: 'Sélection', icon: 'BoxSelect', key: 'V' },
  { id: 'transform', label: 'Transformer', icon: 'FlipHorizontal2', key: 'T' },
  { id: 'blocks', label: 'Blocs', icon: 'Blocks', key: 'B' },
  { id: 'shapes', label: 'Formes', icon: 'Circle', key: 'F' },
  { id: 'terrain', label: 'Terrain', icon: 'Mountain', key: 'G' },
  { id: 'brush', label: 'Pinceau', icon: 'Brush', key: 'P', soon: true },
  { id: 'path', label: 'Tracé', icon: 'Spline', key: 'C' },
  { id: 'panel', label: 'Texte et carte', icon: 'Type', key: 'X' },
  { id: 'heightmap', label: 'Relief', icon: 'Waves', key: 'H' },
  { id: 'measure', label: 'Mesure', icon: 'Ruler', key: 'M' },
  { id: 'library', label: 'Bibliothèque', icon: 'Library', key: 'L' },
];

/**
 * Les opérations que chaque outil met en avant dans l'inspecteur.
 *
 * Un test (`test/store.test.js`) exige que TOUTE opération déclarée par le
 * moteur figure ici. Sans lui, `biome`, `copy` et `paste` étaient déclarées,
 * branchées, testées — et inatteignables : aucun outil ne les proposait et
 * aucun raccourci ne les appelait.
 */
export const TOOL_OPS = {
  transform: ['mirror', 'rotate', 'translate', 'stack', 'scale', 'mirrorcopy'],
  blocks: ['set', 'replace', 'mix', 'walls', 'faces', 'hollow', 'overlay', 'drain', 'cut'],
  shapes: ['sphere', 'cyl', 'pyramid', 'cone', 'line'],
  terrain: ['terrain', 'naturalize', 'smooth', 'erode', 'dilate', 'biome'],
  path: ['path'],
  // L'outil de sélection porte le presse-papier : c'est là qu'on a une zone
  // sous la main et rien d'autre à en faire.
  select: ['copy', 'paste'],
};

/**
 * Ce que dit l'inspecteur d'un outil qui n'a PAS d'opérations du moteur.
 *
 * Sans ça il gardait à l'écran la description, les champs et le bouton de
 * l'opération d'avant : choisir « Texte et carte » proposait « Appliquer
 * copier ». Un outil doit dire ce qu'il fait, ou dire qu'il ne le fait pas
 * encore — jamais présenter les commandes d'un autre.
 */
export const TOOL_NOTES = {
  brush: { soon: true, text: 'Peindre directement dans la vue, sans passer par une sélection. Phase 3.' },
  panel: { text: 'Écrire un texte ou projeter une image en blocs sur un mur plat.' },
  heightmap: { text: 'Sculpter le relief depuis une image en niveaux de gris, et ressortir celui d’une zone.' },
  measure: { text: 'Les dimensions de la sélection sont au-dessus : taille en blocs et volume. Rien à appliquer.' },
  library: { text: 'Ranger une zone copiée et la reposer ailleurs, d’un build à l’autre.' },
};
