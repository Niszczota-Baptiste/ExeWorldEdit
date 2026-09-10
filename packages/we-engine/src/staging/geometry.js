import { SELECTION_SHAPES } from '../worldedit/transform.js';

// Géométrie du staging : emprises, limites, validation de sélection, plan d'un
// panneau. Aucun accès au stockage — c'est volontaire, et c'est ce qui rend
// cette moitié testable sans le moindre fichier.

// Plafonds. Sur le site c'étaient des variables d'environnement ; ici ce sont
// des réglages passés à `createStaging`, parce qu'une application de bureau doit
// pouvoir les relever selon la RAM de la machine (cf. phase 1.2).
export const DEFAULT_LIMITS = {
  // Hauteur du monde Minecraft 1.18+ : blocs y ∈ [-64, 319].
  worldMinY: -64,
  worldMaxY: 319,
  // Volume de la BOÎTE de sélection (les opérations itèrent chaque case).
  maxSelectionVolume: 128_000_000,
  // Budget d'AFFICHAGE de l'aperçu, en blocs pleins. Au-delà l'aperçu est
  // partiel : la commande a quand même tout écrit dans le .mca.
  previewMaxBlocks: 4_000_000,
  // Extraction de zone / re-chunk à l'export.
  cropMaxBlocks: 3_000_000,
  // Baguette magique (remplissage 6-connexe).
  wandMax: 250_000,
  // Profondeur des piles undo et redo.
  maxUndo: 30,
};

export const fdiv = (a, b) => Math.floor(a / b);

/** Emprise RÉELLE du contenu — sert au warmup et à l'aperçu. */
export function buildExtent(project) {
  const { min, size } = project;
  return {
    min: { x: min.x, y: min.y, z: min.z },
    max: { x: min.x + size.x - 1, y: min.y + size.y - 1, z: min.z + size.z - 1 },
  };
}

/**
 * Limites ÉDITABLES : X/Z = emprise du build, Y = hauteur du monde. On peut
 * donc construire au-dessus et en-dessous du contenu existant (les sections
 * Anvil manquantes sont créées à l'écriture).
 */
export function buildLimits(project, limits = DEFAULT_LIMITS) {
  const { min, size } = project;
  return {
    min: { x: min.x, y: limits.worldMinY, z: min.z },
    max: { x: min.x + size.x - 1, y: limits.worldMaxY, z: min.z + size.z - 1 },
  };
}

/** Conservé pour compat (extraction de zone) : alias d'emprise contenu. */
export const buildBBox = buildExtent;

export const clampBBox = (b, lim) => ({
  min: { x: Math.max(b.min.x, lim.min.x), y: Math.max(b.min.y, lim.min.y), z: Math.max(b.min.z, lim.min.z) },
  max: { x: Math.min(b.max.x, lim.max.x), y: Math.min(b.max.y, lim.max.y), z: Math.min(b.max.z, lim.max.z) },
});

export const unionBBox = (a, b) => ({
  min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
  max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
});

/** Clés « rx,rz » des régions (512 blocs) qu'une boîte intersecte. */
export function regionKeysForBBox(bbox) {
  const keys = new Set();
  for (let rz = fdiv(bbox.min.z, 512); rz <= fdiv(bbox.max.z, 512); rz++) {
    for (let rx = fdiv(bbox.min.x, 512); rx <= fdiv(bbox.max.x, 512); rx++) keys.add(`${rx},${rz}`);
  }
  return keys;
}

/**
 * Normalise et vérifie une sélection. Renvoie la boîte normalisée (avec sa
 * forme) ou une CHAÎNE de code d'erreur — le motif d'origine, conservé parce
 * que les appelants distinguent `invalid_selection` / `out_of_bounds` /
 * `selection_too_large` pour afficher quoi faire.
 *
 * `maxVolume` borne le volume de la BOÎTE (les transformations itèrent chaque
 * case). L'extraction passe Infinity : son coût réel est le nombre de blocs
 * non-air, borné plus loin par `deriveSparse`.
 */
export function validateSelection(sel, bbox, { maxVolume = DEFAULT_LIMITS.maxSelectionVolume } = {}) {
  for (const c of ['min', 'max']) for (const a of ['x', 'y', 'z']) {
    if (!Number.isFinite(sel?.[c]?.[a])) return 'invalid_selection';
  }
  const norm = {
    min: { x: Math.min(sel.min.x, sel.max.x), y: Math.min(sel.min.y, sel.max.y), z: Math.min(sel.min.z, sel.max.z) },
    max: { x: Math.max(sel.min.x, sel.max.x), y: Math.max(sel.min.y, sel.max.y), z: Math.max(sel.min.z, sel.max.z) },
  };
  for (const a of ['x', 'y', 'z']) {
    if (norm.min[a] < bbox.min[a] || norm.max[a] > bbox.max[a]) return 'out_of_bounds';
  }
  const vol = (norm.max.x - norm.min.x + 1) * (norm.max.y - norm.min.y + 1) * (norm.max.z - norm.min.z + 1);
  if (vol > maxVolume) return 'selection_too_large';
  const stype = SELECTION_SHAPES.has(sel?.shape?.type) ? sel.shape.type : 'box';
  norm.shape = { type: stype };
  return norm;
}

// ── Panneaux (texte / image → mur plat de blocs) ─────────────────────────────
// Palettes « marbre » : fond texturé (mélange pondéré) + bloc d'écriture (ink).

const nm = (s) => (s && s.includes(':') ? s : `minecraft:${s}`);

export const PANEL_PRESETS = {
  white_marble: { label: 'Marbre blanc', ink: 'minecraft:black_concrete', bg: [['quartz_block', 50], ['smooth_quartz', 22], ['calcite', 16], ['diorite', 8], ['white_concrete', 4]] },
  black_marble: { label: 'Marbre noir', ink: 'minecraft:white_concrete', bg: [['blackstone', 46], ['polished_blackstone', 26], ['basalt', 16], ['black_concrete', 8], ['gilded_blackstone', 4]] },
  white_clean: { label: 'Quartz uni', ink: 'minecraft:black_concrete', bg: [['quartz_block', 1]] },
  black_clean: { label: 'Noir uni', ink: 'minecraft:white_concrete', bg: [['black_concrete', 1]] },
};
export const PANEL_PRESET_IDS = Object.keys(PANEL_PRESETS);

/**
 * Tirage pondéré dans un motif `[[nom, poids], …]`.
 * `random` est injectable pour rendre un rendu reproductible (seed).
 */
export function weightedPicker(pattern, random = Math.random) {
  const list = pattern.map(([name, w]) => [{ Name: nm(name), Properties: null }, Math.max(1, w)]);
  const total = list.reduce((s, [, w]) => s + w, 0);
  return () => { let r = random() * total; for (const [b, w] of list) { r -= w; if (r <= 0) return b; } return list[list.length - 1][0]; };
}

/**
 * Plan du panneau : l'axe « plat » est la plus petite dimension de la sélection.
 * uAxis = horizontal, vAxis = vertical (Y sur un mur → image à l'endroit).
 */
export function panelPlane(sel) {
  const size = { x: sel.max.x - sel.min.x + 1, y: sel.max.y - sel.min.y + 1, z: sel.max.z - sel.min.z + 1 };
  let flat;
  if (size.x <= size.y && size.x <= size.z) flat = 'x';
  else if (size.y <= size.x && size.y <= size.z) flat = 'y';
  else flat = 'z';
  if (flat === 'y') return { flat, uAxis: 'x', vAxis: 'z', invertV: false, w: size.x, h: size.z };
  if (flat === 'x') return { flat, uAxis: 'z', vAxis: 'y', invertV: true, w: size.z, h: size.y };
  return { flat, uAxis: 'x', vAxis: 'y', invertV: true, w: size.x, h: size.y };
}

export const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Rend la main à la boucle d'événements (l'interface reste réactive). */
export const tick = () => new Promise((r) => setImmediate(r));
