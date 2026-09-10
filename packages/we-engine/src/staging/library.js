import { schemToBlob, blobToSchem } from '../worldedit/schematicFormats.js';

// Bibliothèque de schematics : un presse-papier (Schematic) persisté, pour
// copier ici et coller là — y compris d'un projet à l'autre.
//
// Le partage du travail avec l'adapter : ce module sait SÉRIALISER un
// schematic, l'adapter sait RANGER un blob. L'adapter n'a jamais à connaître
// le format, et ce module n'a jamais à savoir où c'est écrit.

export const DEFAULT_MAX_PER_SCOPE = 200;

function countNonAir(schem) {
  let n = 0;
  for (const b of schem.data) if (b && b.Name !== 'minecraft:air') n++;
  return n;
}

/**
 * @param {import('../storage/StorageAdapter.js').StorageAdapter} adapter
 * @param {{scope?: string, maxPerScope?: number}} [options]
 *   `scope` isole les bibliothèques : un workspace côté serveur, une constante
 *   côté application de bureau (un seul utilisateur, une seule bibliothèque).
 */
export function createLibrary(adapter, { scope = 'local', maxPerScope = DEFAULT_MAX_PER_SCOPE } = {}) {
  const list = () => adapter.listSchematics(scope);

  /** @throws {Error} `library_full` */
  function save({ name, schem }) {
    if (list().length >= maxPerScope) throw new Error('library_full');
    return adapter.putSchematic(
      scope,
      { name, sx: schem.sx, sy: schem.sy, sz: schem.sz, blockCount: countNonAir(schem) },
      schemToBlob(schem),
    );
  }

  /** @returns {Schematic} prêt à coller @throws {Error} `not_found` */
  const load = (id) => blobToSchem(adapter.getSchematicBlob(scope, id));

  return {
    scope,
    list,
    get: (id) => adapter.getSchematicMeta(scope, id),
    save,
    load,
    remove: (id) => adapter.deleteSchematic(scope, id),
  };
}
