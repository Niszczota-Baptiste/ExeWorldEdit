// La SÉLECTION tracée à la souris dans la vue.
//
// Jusqu'ici elle ne se réglait que par les six champs de l'inspecteur : taper
// douze nombres pour désigner un coin de build qu'on a sous les yeux. Et rien
// ne la montrait à l'écran, ce qui se lit « la sélection ne marche pas ».
//
// Module PUR — de l'arithmétique de boîtes, testable sans navigateur. Ce qui
// touche à three.js reste dans le viewport.

/**
 * La boîte définie par deux coins, dans n'importe quel ordre.
 *
 * On ne suppose PAS que le premier coin est le plus petit : on tire aussi bien
 * vers le nord-ouest que vers le sud-est, et une boîte dont `min` dépasse `max`
 * est vide — donc invisible, et toute opération dessus ne ferait rien.
 */
export function boxFromCorners(a, b) {
  if (!a || !b) return null;
  const axe = (k) => [Math.min(a[k], b[k]), Math.max(a[k], b[k])];
  const [x0, x1] = axe('x');
  const [y0, y1] = axe('y');
  const [z0, z1] = axe('z');
  return { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } };
}

/** Le nombre de blocs d'une boîte, bornes comprises. */
export function boxVolume(box) {
  if (!box?.min || !box?.max) return 0;
  const cote = (k) => Math.max(0, box.max[k] - box.min[k] + 1);
  return cote('x') * cote('y') * cote('z');
}

/**
 * Serre une boîte dans les limites du monde.
 *
 * Sans ça, un glisser qui sort par le haut proposerait une sélection au-dessus
 * du plafond du monde : le moteur la refuserait, après coup et sans qu'on
 * comprenne pourquoi.
 */
export function clampBox(box, limits) {
  if (!box) return null;
  const minY = Number.isFinite(limits?.worldMinY) ? limits.worldMinY : -64;
  const maxY = Number.isFinite(limits?.worldMaxY) ? limits.worldMaxY : 319;
  const serre = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return {
    min: { x: box.min.x, y: serre(box.min.y, minY, maxY), z: box.min.z },
    max: { x: box.max.x, y: serre(box.max.y, minY, maxY), z: box.max.z },
  };
}

/**
 * Deux boîtes désignent-elles la même chose ?
 *
 * Sert à ne pas renvoyer au moteur une sélection identique à celle qu'il a
 * déjà : un glisser produit des dizaines d'événements, et la plupart ne
 * changent rien.
 */
export function sameBox(a, b) {
  if (!a || !b) return a === b;
  return ['x', 'y', 'z'].every((k) => a.min[k] === b.min[k] && a.max[k] === b.max[k]);
}
