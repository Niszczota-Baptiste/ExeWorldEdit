// Le PINCEAU : de quoi transformer un clic dans la vue en une liste de cases.
//
// Pur — aucun three.js, aucun DOM. Le viewport fournit un point d'impact et une
// normale de face ; ce module décide quelle case est visée et lesquelles la
// forme couvre. C'est là que se prennent les deux décisions qui se voient tout
// de suite quand elles sont fausses : de quel CÔTÉ de la face on pose, et
// combien de cases part une brosse.

/** Formes proposées. Chacune est une condition sur la distance au centre. */
export const BRUSH_SHAPES = [
  { id: 'sphere', label: 'Sphère' },
  { id: 'cube', label: 'Cube' },
  { id: 'disc', label: 'Disque (à plat)' },
];

export const BRUSH_MODES = [
  { id: 'paint', label: 'Poser', aide: 'Pose le bloc CONTRE la face visée.' },
  { id: 'erase', label: 'Effacer', aide: 'Retire les blocs visés.' },
  { id: 'replace', label: 'Remplacer', aide: 'Change le bloc visé sans déplacer la surface.' },
];

export const MAX_RADIUS = 16;

/**
 * La case visée par un impact.
 *
 * Un rayon touche une FACE, donc un plan entre deux cases : le point d'impact
 * est pile sur la frontière et `Math.floor` y tombe d'un côté ou de l'autre
 * selon l'arrondi du flottant. On s'écarte donc d'un demi-pas le long de la
 * normale — vers l'intérieur pour toucher le bloc, vers l'extérieur pour poser
 * contre lui.
 *
 * C'est la différence entre « je pose un bloc sur la table » et « je remplace
 * la table ».
 *
 * @param {{x,y,z}} point impact, en coordonnées monde
 * @param {{x,y,z}} normal normale de la face touchée
 * @param {'paint'|'erase'|'replace'} mode
 */
export function voxelFromHit(point, normal, mode) {
  const dehors = mode === 'paint' ? 0.5 : -0.5;
  return {
    x: Math.floor(point.x + normal.x * dehors),
    y: Math.floor(point.y + normal.y * dehors),
    z: Math.floor(point.z + normal.z * dehors),
  };
}

/**
 * Les cases couvertes par une brosse, en tableau PLAT `[x, y, z, …]`.
 *
 * Plat et pas une liste d'objets : une brosse de rayon 8 en sphère fait plus de
 * deux mille cases, et à chaque déplacement de souris. Deux mille objets par
 * image, c'est deux mille allocations que le ramasse-miettes paiera pendant
 * qu'on peint.
 *
 * @param {{x,y,z}} centre
 * @param {{shape?:string, radius?:number, limits?:{min,max}}} o
 * @returns {Int32Array}
 */
export function brushPositions(centre, { shape = 'sphere', radius = 2, limits = null } = {}) {
  const r = Math.max(0, Math.min(MAX_RADIUS, Math.round(radius)));
  const out = [];
  const r2 = (r + 0.5) * (r + 0.5);
  for (let dy = -r; dy <= r; dy++) {
    // Le disque est plat : une seule couche, celle du centre.
    if (shape === 'disc' && dy !== 0) continue;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (shape === 'sphere' && dx * dx + dy * dy + dz * dz > r2) continue;
        if (shape === 'disc' && dx * dx + dz * dz > r2) continue;
        const x = centre.x + dx, y = centre.y + dy, z = centre.z + dz;
        // Hors des limites du projet, une case n'est pas « ignorée par le
        // moteur » : elle ferait refuser la commande entière. On coupe ici.
        if (limits && (
          x < limits.min.x || x > limits.max.x
          || y < limits.min.y || y > limits.max.y
          || z < limits.min.z || z > limits.max.z)) continue;
        out.push(x, y, z);
      }
    }
  }
  return Int32Array.from(out);
}

/**
 * Fusionne les cases d'un TRAIT, sans doublon.
 *
 * Un trait est une suite de brosses posées le long du déplacement de la souris,
 * et elles se recouvrent largement. Envoyer les doublons au moteur ferait
 * compter plusieurs fois les mêmes blocs — et la seule chose que l'utilisateur
 * lit, c'est « N blocs changés ».
 */
export class Stroke {
  constructor() {
    this.vus = new Set();
    this.plat = [];
  }

  /** @param {Int32Array} positions */
  add(positions) {
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      // Clé TEXTE, et pas un entier composite.
      //
      // Trois coordonnées ne tiennent pas dans les 53 bits d'un `Number` :
      // 21 bits chacune donnent des clés jusqu'à 2⁶³, donc des arrondis, donc
      // des collisions. Essayé, et pris sur le fait par le test — vingt-sept
      // cases distinctes rendues comme vingt-trois.
      //
      // Le coût est acceptable ici, contrairement au piège du recollage
      // d'aperçu : on fabrique une chaîne par case CANDIDATE d'un trait
      // (quelques dizaines de milliers), pas par bloc d'un build (plusieurs
      // millions), et une seule fois.
      const cle = `${x},${y},${z}`;
      if (this.vus.has(cle)) continue;
      this.vus.add(cle);
      this.plat.push(x, y, z);
    }
    return this;
  }

  get size() { return this.plat.length / 3; }

  positions() { return Int32Array.from(this.plat); }
}

/**
 * Les cases d'une LIGNE entre deux centres de brosse, extrémités comprises.
 *
 * Sans elle, un trait est une suite de taches : la souris n'envoie qu'une
 * poignée de positions par seconde, et à vitesse normale deux brosses
 * consécutives sont à dix blocs l'une de l'autre. C'est la différence entre un
 * pinceau et un tampon.
 *
 * Le pas est d'une case : on échantillonne la ligne assez finement pour
 * qu'aucune case ne soit sautée, puis les doublons tombent dans le `Stroke`.
 */
export function lineBetween(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const pas = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (!pas) return [{ x: a.x, y: a.y, z: a.z }];
  // Un saut démesuré veut dire que le curseur a quitté le build et y est
  // revenu ailleurs : relier les deux tracerait une barre en travers de tout.
  if (pas > 256) return [{ x: b.x, y: b.y, z: b.z }];
  const out = [];
  for (let i = 0; i <= pas; i++) {
    const t = i / pas;
    out.push({
      x: Math.round(a.x + dx * t),
      y: Math.round(a.y + dy * t),
      z: Math.round(a.z + dz * t),
    });
  }
  return out;
}

/** Boîte englobante d'un tableau plat de positions, ou `null` s'il est vide. */
export function positionsBounds(positions) {
  if (!positions?.length) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } };
}
