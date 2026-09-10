import test from 'node:test';
import assert from 'node:assert/strict';
import { RegionStore } from '../src/worldedit/regionStore.js';
import { opTerrain, opNaturalize } from '../src/worldedit/transform.js';
import {
  runColumnLocal, closePool, clipToRegion, shouldParallelize,
  COLUMN_LOCAL_OPS, MIN_REGIONS, MIN_VOLUME,
} from '../src/worldedit/regionPool.js';
import { blankRegions } from '../src/staging/blank.js';

// Découper par région ne se voit pas quand c'est faux : ça produit une couture
// d'un bloc de large au bord d'une région, dans un build de plusieurs millions.
// Le seul test qui prouve quelque chose compare le résultat parallèle au
// résultat SÉRIE, case par case.

test.after(() => closePool());

/**
 * Deux régions côte à côte (r.0.0 et r.1.0), vides.
 *
 * Régénérées à chaque appel : le pool TRANSFÈRE les buffers, donc les détache.
 * Réutiliser le même jeu de sources d'un test à l'autre donnerait des tampons
 * vides au second.
 */
function sources() {
  return blankRegions({ origin: { x: 0, y: 0, z: 0 }, size: { x: 1024, y: 1, z: 256 } });
}

/** Empreinte d'une zone : « quel bloc à quelle place ». */
function fingerprint(store, box) {
  const out = [];
  for (let y = box.min.y; y <= box.max.y; y++)
    for (let z = box.min.z; z <= box.max.z; z++)
      for (let x = box.min.x; x <= box.max.x; x++) {
        const b = store.getBlock(x, y, z);
        out.push(b ? b.Name : 'air');
      }
  return out.join('|');
}

const SEL = { min: { x: 400, y: 0, z: 20 }, max: { x: 700, y: 40, z: 120 } };
const PARAMS = { style: 'collines', seed: 20260910, amplitude: 0.7, scale: 64, palette: 'plains', clearAbove: true };

async function serie(operation, params, sel) {
  const store = new RegionStore(sources());
  await store.warmup(sel);
  const fn = operation === 'terrain' ? opTerrain : opNaturalize;
  const res = await fn(store, sel, params, { yield: async () => {} });
  return { store, res };
}

test('terrain : le résultat parallèle est identique au résultat série', async () => {
  // La sélection CHEVAUCHE la frontière x = 512 : c'est là que se produirait
  // une couture si le découpage était faux.
  assert.ok(SEL.min.x < 512 && SEL.max.x > 512, 'la sélection doit franchir la frontière de région');

  const { store: ref, res: refRes } = await serie('terrain', PARAMS, SEL);

  const { buffers, blocksChanged } = await runColumnLocal({
    sources: sources(), operation: 'terrain', params: PARAMS, selection: SEL, poolSize: 2,
  });

  // On recolle les régions rendues par les fils et on relit tout.
  const recolle = sources().map((s) => {
    const out = buffers.get(`${s.regionX},${s.regionZ}`);
    return out ? { ...s, buffer: out } : s;
  });
  const par = new RegionStore(recolle);
  await par.warmup(SEL);

  assert.equal(blocksChanged, refRes.blocksChanged, 'même nombre de blocs changés');
  assert.equal(fingerprint(par, SEL), fingerprint(ref, SEL), 'couture au bord de région');
});

test('naturalize : le résultat parallèle est identique au résultat série', async () => {
  const sel = { min: { x: 480, y: 0, z: 20 }, max: { x: 560, y: 30, z: 60 } };
  // On pose d'abord du relief, pour que naturalize ait de la matière.
  const socle = async () => {
    const s = sources();
    const store = new RegionStore(s);
    await store.warmup(sel);
    for (let z = sel.min.z; z <= sel.max.z; z++)
      for (let x = sel.min.x; x <= sel.max.x; x++)
        for (let y = 0; y <= 12 + ((x + z) % 7); y++) store.setBlock(x, y, z, { Name: 'minecraft:cobblestone', Properties: null });
    const commit = store.commit({ touchedOnly: false });
    return s.map((src) => ({ ...src, buffer: commit.get(`${src.regionX},${src.regionZ}`) || src.buffer }));
  };

  const base = await socle();
  const ref = new RegionStore(base.map((b) => ({ ...b })));
  await ref.warmup(sel);
  const refRes = await opNaturalize(ref, sel, { preset: 'mountain', seed: 3 });

  const { buffers, blocksChanged } = await runColumnLocal({
    sources: base.map((b) => ({ ...b })), operation: 'naturalize',
    params: { preset: 'mountain', seed: 3 }, selection: sel, poolSize: 2,
  });
  const par = new RegionStore(base.map((s) => {
    const out = buffers.get(`${s.regionX},${s.regionZ}`);
    return out ? { ...s, buffer: out } : { ...s };
  }));
  await par.warmup(sel);

  assert.equal(blocksChanged, refRes.blocksChanged);
  assert.equal(fingerprint(par, sel), fingerprint(ref, sel));
});

test('une région hors sélection n’est pas réécrite', async () => {
  const sel = { min: { x: 10, y: 0, z: 10 }, max: { x: 100, y: 20, z: 60 } }; // r.0.0 seulement
  const { buffers } = await runColumnLocal({
    sources: sources(), operation: 'terrain', params: PARAMS, selection: sel, poolSize: 2,
  });
  assert.equal(buffers.has('1,0'), false, 'r.1.0 n’est pas touchée, donc pas réécrite');
});

test('clipToRegion coupe en X/Z mais JAMAIS en Y', () => {
  // La hauteur est ce que l'utilisateur a demandé, pas une propriété de la
  // région : la rogner changerait le relief calculé par chaque fil.
  const c = clipToRegion({ min: { x: 400, y: -64, z: 20 }, max: { x: 700, y: 200, z: 120 } }, 0, 0);
  assert.deepEqual(c.min, { x: 400, y: -64, z: 20 });
  assert.deepEqual(c.max, { x: 511, y: 200, z: 120 });

  const d = clipToRegion({ min: { x: 400, y: -64, z: 20 }, max: { x: 700, y: 200, z: 120 } }, 1, 0);
  assert.equal(d.min.x, 512);
  assert.equal(d.max.x, 700);
  assert.equal(d.min.y, -64, 'Y intact');

  assert.equal(clipToRegion({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }, 5, 5), null);
});

test('le garde-fou refuse de paralléliser ce qui n’en vaut pas la peine', () => {
  const grande = { min: { x: 0, y: 0, z: 0 }, max: { x: 999, y: 99, z: 999 } };
  const petite = { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 9, z: 9 } };

  assert.equal(shouldParallelize({ operation: 'terrain', regionCount: 4, selection: grande, poolSize: 4 }), true);
  assert.equal(shouldParallelize({ operation: 'terrain', regionCount: 1, selection: grande, poolSize: 4 }), false, 'une seule région');
  assert.equal(shouldParallelize({ operation: 'terrain', regionCount: 4, selection: petite, poolSize: 4 }), false, 'trop petit');
  assert.equal(shouldParallelize({ operation: 'terrain', regionCount: 4, selection: grande, poolSize: 1 }), false, 'un seul cœur');
  assert.equal(shouldParallelize({ operation: 'mirror', regionCount: 4, selection: grande, poolSize: 4 }), false, 'pas colonne-locale');
  assert.ok(MIN_REGIONS >= 2 && MIN_VOLUME > 0);
});

test('la liste des opérations parallélisables reste volontairement courte', () => {
  // Y ajouter une opération qui lit un voisin (lissage, érosion) produirait une
  // couture au bord de chaque région. Ce test est un rappel, pas une mesure.
  assert.deepEqual([...COLUMN_LOCAL_OPS].sort(), ['naturalize', 'terrain']);
  for (const interdite of ['smooth', 'erode', 'dilate', 'mirror', 'rotate', 'translate', 'stack', 'scale']) {
    assert.equal(COLUMN_LOCAL_OPS.has(interdite), false, `${interdite} n’est pas colonne-locale`);
  }
});
