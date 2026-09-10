import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeBiomes, encodeBiomes, BIOME_VOLUME,
  writeRegion, encodeBlockStates, SECTION_VOLUME,
} from '../src/anvil/index.js';
import nbt from 'prismarine-nbt';
import { RegionStore } from '../src/worldedit/regionStore.js';
import { MemoryVolume, opBiome } from '../src/worldedit/transform.js';

test('biomes : encode/decode round-trip (grille mixte)', () => {
  const palette = ['minecraft:plains', 'minecraft:desert', 'minecraft:ocean'];
  const indices = new Uint8Array(BIOME_VOLUME);
  for (let i = 0; i < BIOME_VOLUME; i++) indices[i] = i % 3;
  const tagged = encodeBiomes({ palette, indices });
  const back = decodeBiomes(nbt.simplify(tagged));
  assert.deepEqual(back.palette, palette);
  for (let i = 0; i < BIOME_VOLUME; i++) assert.equal(back.indices[i], i % 3);
});

test('biomes : palette homogène → pas de data', () => {
  const tagged = encodeBiomes({ palette: ['minecraft:plains'], indices: new Uint8Array(BIOME_VOLUME) });
  assert.equal(tagged.value.data, undefined);
  const back = decodeBiomes(nbt.simplify(tagged));
  assert.equal(back.palette[0], 'minecraft:plains');
});

test('opBiome : peint par cellules 4³ (MemoryVolume)', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 7, y: 3, z: 7 } }; // 8×4×8 → 2×1×2 cellules
  const r = opBiome(vol, sel, { biome: 'minecraft:desert' });
  assert.equal(r.blocksChanged, 4); // 2 * 1 * 2 cellules
  assert.equal(vol.getBiome(0, 0, 0), 'minecraft:desert');
  assert.equal(vol.getBiome(5, 2, 6), 'minecraft:desert');
  // ré-appliquer ne change rien (idempotent)
  assert.equal(opBiome(vol, sel, { biome: 'minecraft:desert' }).blocksChanged, 0);
});

// Construit un .mca région (0,0) chunk (0,0) avec une section pleine de pierre.
function mcaWithSection() {
  const palette = [{ Name: 'minecraft:air', Properties: null }, { Name: 'minecraft:stone', Properties: null }];
  const indices = new Uint16Array(SECTION_VOLUME);
  for (let i = 0; i < SECTION_VOLUME; i++) indices[i] = 1; // tout pierre
  const chunk = {
    index: 0, localX: 0, localZ: 0, chunkX: 0, chunkZ: 0, timestamp: 1, compression: 2, payload: null, dirty: true,
    root: { type: 'compound', name: '', value: {
      sections: { type: 'list', value: { type: 'compound', value: [
        { Y: { type: 'byte', value: 0 }, block_states: encodeBlockStates({ palette, indices }) },
      ] } },
    } },
  };
  return writeRegion({ regionX: 0, regionZ: 0, chunks: [chunk] });
}

test('RegionStore : setBiome → commit → relecture persistée', async () => {
  const buf = mcaWithSection();
  const store = new RegionStore([{ regionX: 0, regionZ: 0, buffer: buf }]);
  await store.warmup({ min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } });
  assert.equal(store.setBiome(0, 0, 0, 'minecraft:cherry_grove'), true);
  assert.equal(store.setBiome(4, 0, 0, 'minecraft:desert'), true); // cellule voisine
  const [, out] = [...store.commit({ touchedOnly: true })][0];

  const store2 = new RegionStore([{ regionX: 0, regionZ: 0, buffer: out }]);
  await store2.warmup({ min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } });
  assert.equal(store2.getBiome(0, 0, 0), 'minecraft:cherry_grove');
  assert.equal(store2.getBiome(4, 0, 0), 'minecraft:desert');
  assert.equal(store2.getBiome(8, 0, 0), 'minecraft:plains'); // cellule non peinte (défaut)
});

test('deriveSparse : truncate → aperçu partiel au lieu de planter', async () => {
  const buf = mcaWithSection(); // section pleine de pierre (4096 blocs)
  const store = new RegionStore([{ regionX: 0, regionZ: 0, buffer: buf }]);
  const bbox = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } };
  await store.warmup(bbox);
  // Sans truncate : lève au-delà du plafond.
  assert.throws(() => store.deriveSparse(bbox, 100), /too_many_blocks/);
  // Avec truncate : s'arrête au budget et signale l'aperçu partiel.
  const sparse = store.deriveSparse(bbox, 100, { truncate: true });
  assert.equal(sparse.truncated, true);
  assert.equal(sparse.count, 100);
});
