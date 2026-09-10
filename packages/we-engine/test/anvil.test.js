import test from 'node:test';
import assert from 'node:assert/strict';
import nbt from 'prismarine-nbt';
import {
  readRegion, writeRegion, decodeChunk, chunkSections, readSection, writeSection,
  decodeBlockStates, encodeBlockStates, bitsForPalette, localIndex, regionCoordsFromName,
  regionFileName, SECTION_VOLUME,
} from '../src/anvil/index.js';

// ── Helpers : construit une région .mca synthétique à partir de grilles ──────

// Construit un compound `chunk` NBT tagué portant une liste de sections + des
// données annexes (DataVersion, block_entities) pour vérifier qu'elles survivent
// au réencodage.
function makeChunk(sections, extra = {}) {
  return {
    type: 'compound',
    name: '',
    value: {
      DataVersion: { type: 'int', value: 2865 },
      xPos: { type: 'int', value: extra.xPos ?? 0 },
      zPos: { type: 'int', value: extra.zPos ?? 0 },
      block_entities: {
        type: 'list',
        value: { type: 'compound', value: extra.blockEntities ?? [] },
      },
      sections: {
        type: 'list',
        value: {
          type: 'compound',
          value: sections.map(({ Y, grid }) => ({
            Y: { type: 'byte', value: Y },
            block_states: encodeBlockStates(grid),
          })),
        },
      },
    },
  };
}

// Grille homogène d'air + quelques blocs posés (palette construite au vol).
function makeGrid(blocks) {
  const palette = [{ Name: 'minecraft:air', Properties: null }];
  const key = (e) => `${e.Name}|${e.Properties ? JSON.stringify(e.Properties) : ''}`;
  const idx = new Map([[key(palette[0]), 0]]);
  const indices = new Uint16Array(SECTION_VOLUME); // tout air (0)
  for (const b of blocks) {
    const entry = { Name: b.Name, Properties: b.Properties || null };
    const k = key(entry);
    let pi = idx.get(k);
    if (pi === undefined) { pi = palette.length; palette.push(entry); idx.set(k, pi); }
    indices[localIndex(b.x, b.y, b.z)] = pi;
  }
  return { palette, indices };
}

// Encode une région à un seul chunk (localX/localZ via index) contenant `sections`.
function makeRegionBuffer(sections, extra) {
  const chunk = {
    index: 0, localX: 0, localZ: 0, chunkX: 0, chunkZ: 0,
    timestamp: 1234, compression: 2, payload: null, root: makeChunk(sections, extra), dirty: true,
  };
  return writeRegion({ regionX: 0, regionZ: 0, chunks: [chunk] });
}

// Relit toutes les sections d'une région et renvoie une map "x,y,z" -> Name
// (coordonnées section-locales, blocs non-air seulement).
async function readAllBlocks(buf) {
  const region = readRegion(buf, 0, 0);
  const out = new Map();
  for (const chunk of region.chunks) {
    await decodeChunk(chunk);
    for (const { Y, comp } of chunkSections(chunk)) {
      const grid = readSection(comp);
      if (!grid) continue;
      for (let n = 0; n < SECTION_VOLUME; n++) {
        const name = grid.palette[grid.indices[n]]?.Name;
        if (!name || name === 'minecraft:air') continue;
        const x = n & 15, z = (n >> 4) & 15, y = (n >> 8) & 15;
        out.set(`${x},${Y * 16 + y},${z}`, name);
      }
    }
  }
  return out;
}

// ── Tests unitaires section ──────────────────────────────────────────────────

test('bitsForPalette respecte la règle Minecraft (min 4)', () => {
  assert.equal(bitsForPalette(1), 4);
  assert.equal(bitsForPalette(16), 4);
  assert.equal(bitsForPalette(17), 5);
  assert.equal(bitsForPalette(32), 5);
  assert.equal(bitsForPalette(33), 6);
  assert.equal(bitsForPalette(256), 8);
});

test('encode/decode block_states round-trip (plusieurs tailles de palette)', () => {
  for (const paletteSize of [1, 2, 16, 17, 64, 100]) {
    const palette = [];
    for (let i = 0; i < paletteSize; i++) palette.push({ Name: `minecraft:block_${i}`, Properties: null });
    const indices = new Uint16Array(SECTION_VOLUME);
    for (let n = 0; n < SECTION_VOLUME; n++) indices[n] = n % paletteSize;

    const tag = encodeBlockStates({ palette, indices });
    const decoded = decodeBlockStates(nbt.simplify(tag));

    assert.equal(decoded.palette.length, paletteSize, `palette ${paletteSize}`);
    for (let n = 0; n < SECTION_VOLUME; n++) {
      assert.equal(decoded.indices[n], indices[n], `idx ${n} @palette ${paletteSize}`);
    }
  }
});

test('section homogène : pas de data, indices tous à 0', () => {
  const palette = [{ Name: 'minecraft:stone', Properties: null }];
  const tag = encodeBlockStates({ palette, indices: new Uint16Array(SECTION_VOLUME) });
  assert.equal(tag.value.data, undefined, 'pas de longArray pour 1 entrée');
  const decoded = decodeBlockStates(nbt.simplify(tag));
  assert.equal(decoded.indices.reduce((a, b) => a + b, 0), 0);
});

test('Properties (états de blocs) préservées', () => {
  const grid = makeGrid([
    { x: 1, y: 2, z: 3, Name: 'minecraft:oak_stairs', Properties: { facing: 'east', half: 'bottom', shape: 'straight' } },
  ]);
  const tag = encodeBlockStates(grid);
  const decoded = decodeBlockStates(nbt.simplify(tag));
  const e = decoded.palette.find((p) => p.Name === 'minecraft:oak_stairs');
  assert.deepEqual(e.Properties, { facing: 'east', half: 'bottom', shape: 'straight' });
});

// ── Tests région / round-trip lossless ──────────────────────────────────────

test('round-trip région : écrire puis relire conserve tous les blocs', async () => {
  const blocks = [
    { x: 0, y: 0, z: 0, Name: 'minecraft:stone' },
    { x: 15, y: 15, z: 15, Name: 'minecraft:oak_stairs', Properties: { facing: 'west' } },
    { x: 8, y: 4, z: 2, Name: 'minefield:quart_de_bloc_custom', Properties: { facing: 'north' } },
  ];
  const buf = makeRegionBuffer([{ Y: 0, grid: makeGrid(blocks) }]);
  const got = await readAllBlocks(buf);
  assert.equal(got.get('0,0,0'), 'minecraft:stone');
  assert.equal(got.get('15,15,15'), 'minecraft:oak_stairs');
  assert.equal(got.get('8,4,2'), 'minefield:quart_de_bloc_custom');
  assert.equal(got.size, 3);
});

test('round-trip lossless : read → write (sans modif) → read = identique', async () => {
  const blocks = [];
  for (let i = 0; i < 50; i++) {
    blocks.push({ x: i % 16, y: (i * 3) % 16, z: (i * 7) % 16, Name: `minecraft:block_${i % 20}` });
  }
  const buf0 = makeRegionBuffer([{ Y: 0, grid: makeGrid(blocks) }, { Y: 1, grid: makeGrid(blocks) }]);
  const before = await readAllBlocks(buf0);

  // read → write sans toucher aux chunks (payload recopié byte-for-byte)
  const region = readRegion(buf0, 0, 0);
  const buf1 = writeRegion(region);
  const after = await readAllBlocks(buf1);

  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
  // les chunks non modifiés sont ré-émis à l'identique (payload brut recopié)
  assert.ok(region.chunks.every((c) => !c.dirty));
});

test('réencodage forcé (dirty) : NBT + section codec restent lossless', async () => {
  const blocks = [{ x: 3, y: 3, z: 3, Name: 'minecraft:diamond_block' }];
  const buf0 = makeRegionBuffer([{ Y: 0, grid: makeGrid(blocks) }]);
  const before = await readAllBlocks(buf0);

  const region = readRegion(buf0, 0, 0);
  for (const c of region.chunks) { await decodeChunk(c); c.dirty = true; } // force le réencodage NBT
  const after = await readAllBlocks(writeRegion(region));
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
});

test('writeSection modifie une grille et reste relisible', async () => {
  const buf0 = makeRegionBuffer([{ Y: 0, grid: makeGrid([{ x: 0, y: 0, z: 0, Name: 'minecraft:stone' }]) }]);
  const region = readRegion(buf0, 0, 0);
  const chunk = region.chunks[0];
  await decodeChunk(chunk);
  const [{ comp }] = chunkSections(chunk);
  const grid = readSection(comp);
  grid.palette.push({ Name: 'minecraft:gold_block', Properties: null });
  grid.indices[localIndex(5, 5, 5)] = grid.palette.length - 1;
  writeSection(comp, grid);
  chunk.dirty = true;

  const got = await readAllBlocks(writeRegion(region));
  assert.equal(got.get('0,0,0'), 'minecraft:stone');
  assert.equal(got.get('5,5,5'), 'minecraft:gold_block');
});

// ── Cross-validation avec le décodeur indépendant existant ───────────────────

test('cross-check : le décodeur historique lit la région écrite', async () => {
  const { parseRegion } = await import('./fixtures/legacy-decoder.js');
  const blocks = [
    { x: 2, y: 1, z: 4, Name: 'minecraft:stone' },
    { x: 10, y: 6, z: 12, Name: 'minecraft:oak_stairs', Properties: { facing: 'south' } },
  ];
  const buf = makeRegionBuffer([{ Y: 0, grid: makeGrid(blocks) }]);
  const seen = new Map();
  await parseRegion(buf, 0, 0, { minX: 0, minY: 0, minZ: 0, maxX: 15, maxY: 15, maxZ: 15 },
    (x, y, z, name) => seen.set(`${x},${y},${z}`, name));
  assert.equal(seen.get('2,1,4'), 'minecraft:stone');
  assert.equal(seen.get('10,6,12'), 'minecraft:oak_stairs');
});

// ── Noms de fichiers région ──────────────────────────────────────────────────

test('regionCoordsFromName accepte r.X.Z et r_X_Z', () => {
  assert.deepEqual(regionCoordsFromName('r.0.-1.mca'), { regionX: 0, regionZ: -1 });
  assert.deepEqual(regionCoordsFromName('region/r.-2.3.mca'), { regionX: -2, regionZ: 3 });
  assert.deepEqual(regionCoordsFromName('r_5_-7.mca'), { regionX: 5, regionZ: -7 });
  assert.equal(regionCoordsFromName('nope.txt'), null);
});

test('regionFileName', () => {
  assert.equal(regionFileName(0, -1), 'r.0.-1.mca');
  assert.equal(regionFileName(2, 3, '_'), 'r_2_3.mca');
});
