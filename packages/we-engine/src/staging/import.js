import { Schematic, stampSchematic } from '../worldedit/transform.js';
import { parseSchematicFile } from '../worldedit/schematicFormats.js';
import { RegionStore } from '../worldedit/regionStore.js';
import { blankRegions } from './blank.js';
import { DEFAULT_LIMITS, tick } from './geometry.js';

// Ouvrir un `.schem` ou un `.litematic` comme un projet.
//
// Un schematic n'est pas un monde : il n'a ni chunks, ni coordonnées absolues,
// juste une boîte de blocs. Pour l'éditer avec les mêmes opérations que le
// reste, on lui fabrique des régions vierges à la taille voulue et on l'y
// tamponne. Le résultat est un build ordinaire — exportable en .mca, éditable,
// annulable — au lieu d'un cas particulier qui traverserait tout le moteur.

/**
 * @param {Buffer} buffer contenu du fichier
 * @param {string} filename sert à choisir le format (l'extension)
 * @param {{origin?: {x,y,z}, cropMaxBlocks?: number}} [opts]
 *   `origin` place le schematic dans le monde. Par défaut on respecte l'offset
 *   que le fichier porte lui-même : c'est ce qui permet de recoller un
 *   schematic à l'endroit d'où il a été copié.
 * @returns {Promise<{regions, sparse, size, origin, blockCount}>}
 */
export async function schematicToRegions(buffer, filename = '', opts = {}) {
  const schem = await parseSchematicFile(buffer, filename);
  if (!schem?.sx || !schem?.sy || !schem?.sz) throw new Error('bad_schematic');

  const cropMaxBlocks = opts.cropMaxBlocks ?? DEFAULT_LIMITS.cropMaxBlocks;
  const origin = opts.origin || {
    x: schem.origin?.x ?? 0,
    y: schem.origin?.y ?? 0,
    z: schem.origin?.z ?? 0,
  };
  const bbox = {
    min: { ...origin },
    max: { x: origin.x + schem.sx - 1, y: origin.y + schem.sy - 1, z: origin.z + schem.sz - 1 },
  };

  const regions = blankRegions({ origin, size: { x: schem.sx, y: schem.sy, z: schem.sz } });
  const store = new RegionStore(regions);
  await store.warmup(bbox);

  const changed = stampSchematic(store, schem, origin, 'overwrite');
  await tick();

  const outRegions = [...store.commit({ touchedOnly: false })].map(([key, buf]) => {
    const [rx, rz] = key.split(',').map(Number);
    return { regionX: rx, regionZ: rz, buffer: buf };
  });

  return {
    regions: outRegions,
    sparse: store.deriveSparse(bbox, cropMaxBlocks, { truncate: true }),
    size: { x: schem.sx, y: schem.sy, z: schem.sz },
    origin,
    blockCount: changed,
  };
}

/**
 * L'inverse : une sélection d'un volume devient un `Schematic` prêt à écrire
 * en `.schem` ou `.litematic`.
 *
 * L'origine du schematic est celle de la sélection : recoller le fichier sans
 * décalage le remet exactement où il a été pris.
 */
export function volumeToSchematic(vol, sel) {
  const sx = sel.max.x - sel.min.x + 1;
  const sy = sel.max.y - sel.min.y + 1;
  const sz = sel.max.z - sel.min.z + 1;
  const schem = new Schematic(sx, sy, sz, null, { ...sel.min });
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        schem.set(x, y, z, vol.getBlock(sel.min.x + x, sel.min.y + y, sel.min.z + z));
      }
    }
  }
  return schem;
}
