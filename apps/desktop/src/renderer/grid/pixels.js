// Des PIXELS vers une grille que le moteur sait écrire.
//
// Trois sorties, une par outil : un masque d'encre (panneau texte), des noms de
// blocs (carte en blocs), des hauteurs (relief). Aucune dépendance au DOM — ce
// module reçoit du RGBA déjà rasterisé, ce qui le rend testable sans
// navigateur. Le peu qui touche à un canvas est dans `draw.js`.
//
// L'image arrive TOUJOURS déjà redimensionnée à la taille de la grille : c'est
// le canvas qui échantillonne, avec son propre filtrage, et il le fait mieux
// qu'une boucle écrite ici.

/**
 * Distance de couleur « redmean » — approximation de la perception, à deux
 * multiplications près. Une distance euclidienne nue en RGB place le bleu et le
 * violet plus loin qu'ils ne le paraissent, et un ciel dégradé en ressort
 * tacheté.
 */
function distance(r1, g1, b1, r2, g2, b2) {
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

/**
 * Bloc le plus proche d'une couleur, dans une palette `{block, r, g, b}[]`.
 *
 * Le cache est indispensable, pas un raffinement : une carte de 128 × 128
 * cellules sur une palette de soixante blocs fait un million de comparaisons,
 * alors qu'une image réelle n'a que quelques milliers de couleurs distinctes.
 */
export function makeMatcher(palette) {
  const cache = new Map();
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = null, bestD = Infinity;
    for (const c of palette) {
      const d = distance(r, g, b, c.r, c.g, c.b);
      if (d < bestD) { bestD = d; best = c.block; }
    }
    cache.set(key, best);
    return best;
  };
}

/** Luminance perçue (Rec. 601) — le gris que verrait un œil, pas la moyenne. */
export const luma = (r, g, b) => (r * 299 + g * 587 + b * 114) / 1000;

/**
 * Masque d'encre pour un panneau : 1 = encre, 0 = fond.
 *
 * @param {Uint8ClampedArray} rgba
 * @param {number} threshold 0..255, au-dessus duquel un pixel est de l'encre
 */
export function toMask(rgba, { threshold = 128, invert = false } = {}) {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    // Un pixel transparent n'est pas de l'encre : sans ça, un PNG à fond
    // transparent ressort en bloc plein.
    const on = rgba[i + 3] >= 128 && luma(rgba[i], rgba[i + 1], rgba[i + 2]) >= threshold;
    out[p] = (invert ? !on : on) ? 1 : 0;
  }
  return out;
}

/**
 * Noms de blocs pour une carte : un par cellule, `null` là où l'image est
 * transparente (le moteur laisse alors la case inchangée).
 */
export function toBlockNames(rgba, palette, { alphaMin = 128 } = {}) {
  const match = makeMatcher(palette);
  const out = new Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    out[p] = rgba[i + 3] < alphaMin ? null : match(rgba[i], rgba[i + 1], rgba[i + 2]);
  }
  return out;
}

/**
 * Hauteurs pour un relief : un RAPPORT 0..1 par cellule, tiré de la luminance.
 *
 * Un rapport et pas un nombre de blocs : c'est ce que `applyHeightmap` attend
 * (`clamp01(h) * maxH`), et c'est aussi ce qui a du sens — une image en niveaux
 * de gris ne sait pas dans quelle boîte elle atterrit, donc elle ne peut pas
 * parler en blocs. Lui envoyer des hauteurs absolues faisait passer toute
 * cellule non nulle par `clamp01` à 1 : un plateau plat au sommet de la
 * sélection, à la place du relief. Un aller-retour l'a montré — 1 022 cellules
 * fausses sur 1 024, jusqu'à 31 blocs d'écart.
 */
export function toHeights(rgba, { invert = false } = {}) {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    let t = luma(rgba[i], rgba[i + 1], rgba[i + 2]) / 255;
    if (invert) t = 1 - t;
    // Un pixel transparent vaut le sol, pas une colonne pleine.
    out[p] = rgba[i + 3] < 128 ? 0 : t;
  }
  return out;
}

/**
 * Grille en niveaux de gris → RGBA, pour redessiner un relief exporté et
 * l'enregistrer en PNG.
 */
export function grayToRgba(data) {
  const out = new Uint8ClampedArray(data.length * 4);
  for (let p = 0, i = 0; p < data.length; p++, i += 4) {
    out[i] = out[i + 1] = out[i + 2] = data[p];
    out[i + 3] = 255;
  }
  return out;
}
