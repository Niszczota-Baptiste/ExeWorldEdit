// Recomposition incrémentale de l'aperçu.
//
// Redériver l'aperçu entier après chaque opération coûtait 82 % du temps du
// moteur : poser 121 blocs faisait reparcourir les 2,1 millions de cases de
// l'emprise. Or `applyOperation` sait déjà quelle boîte il a touchée — c'est
// celle dont il prend un instantané d'annulation. On redérive cette boîte-là,
// et on la recolle sur l'aperçu précédent.
//
// Pur : aucun accès au disque. C'est ce qui rend le recollage testable sans
// staging — et il vaut mieux, parce qu'un splice faux ne plante pas, il
// affiche un build légèrement faux, ce qui est bien pire.

/**
 * Même clé de palette que `deriveSparse` (`regionStore.js`). Deux clés
 * différentes pour le même bloc dupliqueraient les entrées de palette et
 * feraient mentir la nomenclature.
 */
const propsKey = (p) => (p ? Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join(',') : '');
const entryKey = (e) => `${e.name}|${propsKey(e.props)}`;

/**
 * Recolle `patch` (dérivation fraîche de `dirty`) sur `base` (aperçu précédent)
 * pour produire l'aperçu de `extent`.
 *
 * Les trois jeux de coordonnées sont relatifs à leur propre `min` : on repasse
 * par le monde pour comparer, puis on rebase sur la nouvelle emprise. C'est ce
 * qui permet à l'emprise de grandir sans invalider l'aperçu.
 *
 * Renvoie **`null`** dès que le résultat ne peut pas être garanti — aperçu
 * source tronqué, ou budget dépassé. L'appelant redérive alors en entier :
 * mieux vaut payer une fois le prix fort qu'afficher un build faux.
 *
 * @param {object}  o
 * @param {object}  o.base       aperçu précédent (`deriveSparse`)
 * @param {object}  o.patch      dérivation de la seule boîte touchée
 * @param {{min,max}} o.dirty    boîte touchée, en coordonnées monde
 * @param {{min,max}} o.extent   nouvelle emprise, en coordonnées monde
 * @param {number} [o.maxBlocks] budget d'affichage
 */
export function splicePreview({ base, patch, dirty, extent, maxBlocks = Infinity }) {
  // Un aperçu tronqué a perdu des blocs qu'on ne sait plus nommer : le recoller
  // laisserait des trous, sans rien signaler.
  if (!base || !patch || base.truncated || patch.truncated) return null;
  if (!base.palette || !patch.palette) return null;

  const palette = [];
  const index = new Map();

  const idxOf = (e) => {
    const k = entryKey(e);
    let i = index.get(k);
    if (i === undefined) {
      i = palette.length;
      palette.push({ name: e.name, props: e.props || null });
      index.set(k, i);
    }
    return i;
  };

  // Table de correspondance palette source → palette recollée, calculée UNE
  // fois par palette. Refabriquer la clé texte pour chacun des 850 000 blocs
  // coûtait 317 ms — la boucle chaude ne doit manipuler que des entiers.
  const baseMap = base.palette.map(idxOf);
  const patchMap = patch.palette.map(idxOf);
  const tally = new Int32Array(palette.length);

  // Majorant du résultat : tout l'ancien plus tout le patch. Préallouer évite
  // de faire grandir un tableau de plusieurs millions d'entrées à coups de
  // `push`.
  //
  // Tableau ORDINAIRE et non typé : l'aperçu finit en JSON, et repasser d'un
  // `Int32Array` à un tableau JS coûtait 160 ms sur 850 000 blocs, contre 16 ms
  // pour remplir directement un `Array` prédimensionné. Mesuré, pas supposé.
  const cap = Math.min(base.blocks.length + patch.blocks.length, maxBlocks * 4);
  const buf = new Array(cap);
  let n = 0;
  let overflow = false;

  const ex = extent.min.x, ey = extent.min.y, ez = extent.min.z;
  const put = (wx, wy, wz, pi) => {
    if (wx < ex || wy < ey || wz < ez
      || wx > extent.max.x || wy > extent.max.y || wz > extent.max.z) return;
    if (n + 4 > cap) { overflow = true; return; }
    buf[n] = wx - ex; buf[n + 1] = wy - ey; buf[n + 2] = wz - ez; buf[n + 3] = pi;
    n += 4;
    tally[pi]++;
  };

  // 1. L'ancien aperçu, moins la boîte touchée — celle-ci est réécrite en (2).
  const bb = base.blocks;
  const dx0 = dirty.min.x, dy0 = dirty.min.y, dz0 = dirty.min.z;
  const dx1 = dirty.max.x, dy1 = dirty.max.y, dz1 = dirty.max.z;
  const bx = base.min.x, by = base.min.y, bz = base.min.z;
  for (let i = 0; i < bb.length && !overflow; i += 4) {
    const wx = bx + bb[i];
    const wy = by + bb[i + 1];
    const wz = bz + bb[i + 2];
    if (wx >= dx0 && wx <= dx1 && wy >= dy0 && wy <= dy1 && wz >= dz0 && wz <= dz1) continue;
    put(wx, wy, wz, baseMap[bb[i + 3]]);
  }

  // 2. La boîte touchée, telle que le staging la contient maintenant.
  const pb = patch.blocks;
  const px = patch.min.x, py = patch.min.y, pz = patch.min.z;
  for (let i = 0; i < pb.length && !overflow; i += 4) {
    put(px + pb[i], py + pb[i + 1], pz + pb[i + 2], patchMap[pb[i + 3]]);
  }

  // Dépasser le budget en cours de route laisse un aperçu amputé de sa fin,
  // c'est-à-dire arbitraire. On préfère rendre la main.
  if (overflow) return null;

  const bom = [];
  for (let i = 0; i < palette.length; i++) {
    if (tally[i] > 0) bom.push({ blockId: palette[i].name, count: tally[i] });
  }
  bom.sort((a, b) => b.count - a.count);

  buf.length = n;

  return {
    palette,
    blocks: buf,
    bom,
    count: n / 4,
    truncated: false,
    min: { x: extent.min.x, y: extent.min.y, z: extent.min.z },
    size: {
      x: extent.max.x - extent.min.x + 1,
      y: extent.max.y - extent.min.y + 1,
      z: extent.max.z - extent.min.z + 1,
    },
  };
}
