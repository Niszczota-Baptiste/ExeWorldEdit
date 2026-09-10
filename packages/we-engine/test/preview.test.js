import test from 'node:test';
import assert from 'node:assert/strict';
import { splicePreview } from '../src/staging/preview.js';

// Le recollage d'aperçu ne plante pas quand il se trompe : il affiche un build
// légèrement faux. C'est exactement le genre de bug qu'on ne voit pas, donc il
// se teste par comparaison avec la vérité — une dérivation complète simulée.

const bbox = (x0, y0, z0, x1, y1, z1) => ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });

/** Fabrique un artefact creux comme le ferait `deriveSparse` sur `box`. */
function sparse(box, cells) {
  const palette = [];
  const index = new Map();
  const counts = new Map();
  const blocks = [];
  for (const [x, y, z, name] of cells) {
    if (x < box.min.x || x > box.max.x || y < box.min.y || y > box.max.y || z < box.min.z || z > box.max.z) continue;
    let i = index.get(name);
    if (i === undefined) { i = palette.length; palette.push({ name, props: null }); index.set(name, i); }
    blocks.push(x - box.min.x, y - box.min.y, z - box.min.z, i);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return {
    palette, blocks, count: blocks.length / 4, truncated: false,
    bom: [...counts.entries()].map(([blockId, count]) => ({ blockId, count })).sort((a, b) => b.count - a.count),
    min: { ...box.min },
    size: { x: box.max.x - box.min.x + 1, y: box.max.y - box.min.y + 1, z: box.max.z - box.min.z + 1 },
  };
}

/** Un aperçu ramené à un ensemble comparable : « quel bloc à quelle place ». */
const asWorld = (s) => {
  const out = new Map();
  for (let i = 0; i < s.blocks.length; i += 4) {
    out.set(
      `${s.min.x + s.blocks[i]},${s.min.y + s.blocks[i + 1]},${s.min.z + s.blocks[i + 2]}`,
      s.palette[s.blocks[i + 3]].name,
    );
  }
  return out;
};

test('recoller donne exactement ce qu’une dérivation complète donnerait', () => {
  const extent = bbox(0, 0, 0, 7, 7, 7);
  const avant = [
    [1, 1, 1, 'stone'], [2, 1, 1, 'stone'], [3, 1, 1, 'dirt'],
    [5, 5, 5, 'oak_log'], [0, 0, 0, 'bedrock'],
  ];
  // L'opération a réécrit la boîte (1,1,1)-(3,1,1) : stone/stone/dirt → glass.
  const apres = [
    [1, 1, 1, 'glass'], [2, 1, 1, 'glass'], [3, 1, 1, 'glass'],
    [5, 5, 5, 'oak_log'], [0, 0, 0, 'bedrock'],
  ];
  const dirty = bbox(1, 1, 1, 3, 1, 1);

  const spliced = splicePreview({
    base: sparse(extent, avant),
    patch: sparse(dirty, apres),
    dirty,
    extent,
  });

  assert.deepEqual(asWorld(spliced), asWorld(sparse(extent, apres)));
  assert.equal(spliced.count, 5);
});

test('un bloc effacé dans la boîte touchée disparaît de l’aperçu', () => {
  const extent = bbox(0, 0, 0, 7, 7, 7);
  const avant = [[2, 2, 2, 'stone'], [6, 6, 6, 'stone']];
  const dirty = bbox(2, 2, 2, 2, 2, 2);

  // Le patch est VIDE : la case a été mise à l'air.
  const spliced = splicePreview({ base: sparse(extent, avant), patch: sparse(dirty, []), dirty, extent });

  assert.equal(spliced.count, 1, 'il ne reste que le bloc hors boîte');
  assert.deepEqual([...asWorld(spliced).keys()], ['6,6,6']);
});

test('l’emprise peut grandir : les anciens blocs sont rebasés, pas déplacés', () => {
  const ancien = bbox(0, 0, 0, 7, 7, 7);
  const grandi = bbox(-4, -8, -4, 15, 7, 15);
  const avant = [[1, 1, 1, 'stone'], [7, 7, 7, 'dirt']];
  const dirty = bbox(-4, -8, -4, -1, -1, -1);
  const patch = sparse(dirty, [[-2, -3, -2, 'deepslate']]);

  const spliced = splicePreview({ base: sparse(ancien, avant), patch, dirty, extent: grandi });

  assert.deepEqual(spliced.min, { x: -4, y: -8, z: -4 });
  assert.deepEqual(spliced.size, { x: 20, y: 16, z: 20 });
  const world = asWorld(spliced);
  assert.equal(world.get('1,1,1'), 'stone', 'l’ancien bloc reste à sa place dans le MONDE');
  assert.equal(world.get('7,7,7'), 'dirt');
  assert.equal(world.get('-2,-3,-2'), 'deepslate');
  assert.equal(spliced.count, 3);
});

test('un bloc hors de la nouvelle emprise est jeté, pas replié dedans', () => {
  const ancien = bbox(0, 0, 0, 15, 15, 15);
  const reduit = bbox(0, 0, 0, 7, 7, 7);
  const avant = [[2, 2, 2, 'stone'], [12, 12, 12, 'dirt']];
  const dirty = bbox(0, 0, 0, 1, 1, 1);

  const spliced = splicePreview({ base: sparse(ancien, avant), patch: sparse(dirty, []), dirty, extent: reduit });

  assert.deepEqual([...asWorld(spliced).keys()], ['2,2,2'], 'le bloc en 12 sort de l’emprise');
});

test('la palette recollée ne duplique pas ses entrées', () => {
  const extent = bbox(0, 0, 0, 7, 7, 7);
  const dirty = bbox(4, 4, 4, 5, 5, 5);
  // `stone` est des deux côtés : il ne doit apparaître qu'une fois.
  const spliced = splicePreview({
    base: sparse(extent, [[0, 0, 0, 'stone'], [1, 0, 0, 'dirt']]),
    patch: sparse(dirty, [[4, 4, 4, 'stone']]),
    dirty,
    extent,
  });

  assert.equal(spliced.palette.length, 2);
  assert.deepEqual(spliced.palette.map((p) => p.name).sort(), ['dirt', 'stone']);
  assert.deepEqual(spliced.bom.find((b) => b.blockId === 'stone'), { blockId: 'stone', count: 2 });
});

test('les états de bloc distinguent deux entrées de palette', () => {
  const extent = bbox(0, 0, 0, 7, 7, 7);
  const dirty = bbox(4, 4, 4, 4, 4, 4);
  const base = {
    ...sparse(extent, [[0, 0, 0, 'oak_stairs']]),
    palette: [{ name: 'oak_stairs', props: { facing: 'north' } }],
  };
  const patch = {
    ...sparse(dirty, [[4, 4, 4, 'oak_stairs']]),
    palette: [{ name: 'oak_stairs', props: { facing: 'south' } }],
  };

  const spliced = splicePreview({ base, patch, dirty, extent });
  assert.equal(spliced.palette.length, 2, 'north et south ne se confondent pas');
});

test('l’ordre des propriétés ne crée pas de doublon', () => {
  const extent = bbox(0, 0, 0, 7, 7, 7);
  const dirty = bbox(4, 4, 4, 4, 4, 4);
  const base = {
    ...sparse(extent, [[0, 0, 0, 'oak_stairs']]),
    palette: [{ name: 'oak_stairs', props: { facing: 'north', half: 'top' } }],
  };
  const patch = {
    ...sparse(dirty, [[4, 4, 4, 'oak_stairs']]),
    palette: [{ name: 'oak_stairs', props: { half: 'top', facing: 'north' } }],
  };

  const spliced = splicePreview({ base, patch, dirty, extent });
  assert.equal(spliced.palette.length, 1, 'même bloc, clés écrites dans un autre ordre');
});

test('un aperçu source tronqué refuse le recollage', () => {
  const extent = bbox(0, 0, 0, 7, 7, 7);
  const dirty = bbox(1, 1, 1, 2, 2, 2);
  const base = { ...sparse(extent, [[0, 0, 0, 'stone']]), truncated: true };

  assert.equal(
    splicePreview({ base, patch: sparse(dirty, []), dirty, extent }),
    null,
    'on ne recolle pas sur des données incomplètes',
  );
  assert.equal(
    splicePreview({ base: sparse(extent, []), patch: { ...sparse(dirty, []), truncated: true }, dirty, extent }),
    null,
  );
  assert.equal(splicePreview({ base: null, patch: sparse(dirty, []), dirty, extent }), null);
});

test('dépasser le budget rend la main plutôt qu’un aperçu amputé', () => {
  const extent = bbox(0, 0, 0, 7, 7, 7);
  const dirty = bbox(6, 6, 6, 7, 7, 7);
  const base = sparse(extent, [[0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'stone']]);

  assert.equal(splicePreview({ base, patch: sparse(dirty, []), dirty, extent, maxBlocks: 2 }), null);
  assert.ok(splicePreview({ base, patch: sparse(dirty, []), dirty, extent, maxBlocks: 3 }), 'pile le budget, ça passe');
});

test('recoller la même boîte deux fois est idempotent', () => {
  const extent = bbox(0, 0, 0, 7, 7, 7);
  const dirty = bbox(1, 1, 1, 2, 2, 2);
  const cells = [[1, 1, 1, 'glass'], [5, 5, 5, 'stone']];
  const base = sparse(extent, [[1, 1, 1, 'dirt'], [5, 5, 5, 'stone']]);
  const patch = sparse(dirty, cells);

  const une = splicePreview({ base, patch, dirty, extent });
  const deux = splicePreview({ base: une, patch, dirty, extent });
  assert.deepEqual(asWorld(deux), asWorld(une));
  assert.equal(deux.count, une.count);
});
