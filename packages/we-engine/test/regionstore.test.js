import test from 'node:test';
import assert from 'node:assert/strict';
import {
  writeRegion, encodeBlockStates, localIndex, readRegion, decodeChunk, chunkSections, readSection, SECTION_VOLUME,
} from '../src/anvil/index.js';
import { RegionStore } from '../src/worldedit/regionStore.js';
import { opMirror, opSet } from '../src/worldedit/transform.js';

// Construit un buffer région r.0.0 avec un seul chunk (0,0), section Y=0 portant
// les blocs fournis (coords locales 0..15).
function buildRegion(blocks) {
  const palette = [{ Name: 'minecraft:air', Properties: null }];
  const key = (n, p) => `${n}|${p ? JSON.stringify(p) : ''}`;
  const idx = new Map([[key('minecraft:air', null), 0]]);
  const indices = new Uint16Array(SECTION_VOLUME);
  for (const b of blocks) {
    const k = key(b.Name, b.Properties || null);
    let pi = idx.get(k);
    if (pi === undefined) { pi = palette.length; palette.push({ Name: b.Name, Properties: b.Properties || null }); idx.set(k, pi); }
    indices[localIndex(b.x, b.y, b.z)] = pi;
  }
  const chunk = {
    index: 0, localX: 0, localZ: 0, chunkX: 0, chunkZ: 0, timestamp: 1, compression: 2, payload: null, dirty: true,
    root: {
      type: 'compound', name: '', value: {
        sections: { type: 'list', value: { type: 'compound', value: [
          { Y: { type: 'byte', value: 0 }, block_states: encodeBlockStates({ palette, indices }) },
        ] } },
      },
    },
  };
  return writeRegion({ regionX: 0, regionZ: 0, chunks: [chunk] });
}

async function readBack(buffer) {
  const region = readRegion(buffer, 0, 0);
  const out = new Map();
  for (const chunk of region.chunks) {
    await decodeChunk(chunk);
    for (const { Y, comp } of chunkSections(chunk)) {
      const grid = readSection(comp);
      for (let n = 0; n < SECTION_VOLUME; n++) {
        const e = grid.palette[grid.indices[n]];
        if (!e || e.Name === 'minecraft:air') continue;
        out.set(`${n & 15},${Y * 16 + ((n >> 8) & 15)},${(n >> 4) & 15}`, e);
      }
    }
  }
  return out;
}

test('RegionStore : get/set + commit relisible par anvil', async () => {
  const buf = buildRegion([{ x: 1, y: 0, z: 1, Name: 'minecraft:stone' }]);
  const store = new RegionStore([{ regionX: 0, regionZ: 0, buffer: buf }]);
  await store.warmup({ min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } });

  assert.equal(store.getBlock(1, 0, 1).Name, 'minecraft:stone');
  assert.equal(store.getBlock(2, 0, 2), null);
  store.setBlock(2, 0, 2, { Name: 'minecraft:gold_block', Properties: null });

  const out = store.commit();
  const region = out.get('0,0');
  const got = await readBack(region);
  assert.equal(got.get('1,0,1').Name, 'minecraft:stone');
  assert.equal(got.get('2,0,2').Name, 'minecraft:gold_block');
});

test('RegionStore : opMirror + deriveSparse', async () => {
  const buf = buildRegion([
    { x: 0, y: 0, z: 0, Name: 'minecraft:oak_stairs', Properties: { facing: 'east' } },
  ]);
  const store = new RegionStore([{ regionX: 0, regionZ: 0, buffer: buf }]);
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 0, z: 0 } };
  await store.warmup(sel);
  opMirror(store, sel, { axis: 'x' });
  // L'escalier était en x=0 facing east → après miroir X il est en x=3 facing west.
  assert.equal(store.getBlock(0, 0, 0), null);
  assert.equal(store.getBlock(3, 0, 0).Properties.facing, 'west');

  const sparse = store.deriveSparse(sel);
  assert.equal(sparse.count, 1);
  assert.equal(sparse.bom[0].blockId, 'minecraft:oak_stairs');
});

test('RegionStore : setBlock hors chunk chargé est ignoré (clamp)', async () => {
  const buf = buildRegion([{ x: 0, y: 0, z: 0, Name: 'minecraft:stone' }]);
  const store = new RegionStore([{ regionX: 0, regionZ: 0, buffer: buf }]);
  await store.warmup({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } });
  assert.doesNotThrow(() => store.setBlock(5000, 0, 5000, { Name: 'minecraft:stone' }));
  assert.equal(store.getBlock(5000, 0, 5000), null); // non écrit
});
