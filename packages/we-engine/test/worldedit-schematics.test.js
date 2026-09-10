import test from 'node:test';
import assert from 'node:assert/strict';
import { Schematic } from '../src/worldedit/transform.js';
import {
  schematicToSponge, spongeToSchematic, schematicToLitematic, litematicToSchematic,
  schemToBlob, blobToSchem, blockToStateString, stateStringToBlock,
} from '../src/worldedit/schematicFormats.js';

// Schematic de référence : blocs variés + propriétés + air.
function sample() {
  const s = new Schematic(3, 2, 2, null, { x: 10, y: 64, z: -5 });
  s.set(0, 0, 0, { Name: 'minecraft:stone', Properties: null });
  s.set(1, 0, 0, { Name: 'minecraft:oak_log', Properties: { axis: 'x' } });
  s.set(2, 0, 0, { Name: 'minecraft:gold_block', Properties: null });
  s.set(0, 1, 1, { Name: 'minecraft:oak_stairs', Properties: { facing: 'east', half: 'top', shape: 'straight', waterlogged: 'false' } });
  return s;
}

function sameGeometry(a, b) {
  if (a.sx !== b.sx || a.sy !== b.sy || a.sz !== b.sz) return false;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i], y = b.data[i];
    const ax = !x || x.Name === 'minecraft:air', ay = !y || y.Name === 'minecraft:air';
    if (ax && ay) continue;
    if (ax !== ay || x.Name !== y.Name) return false;
    if (JSON.stringify(x.Properties || null) !== JSON.stringify(y.Properties || null)) return false;
  }
  return true;
}

test('blockstate ⇄ chaîne (palette Sponge)', () => {
  assert.equal(blockToStateString({ Name: 'minecraft:stone', Properties: null }), 'minecraft:stone');
  assert.equal(blockToStateString({ Name: 'minecraft:oak_log', Properties: { axis: 'x' } }), 'minecraft:oak_log[axis=x]');
  // tri stable des clés
  assert.equal(blockToStateString({ Name: 'a:b', Properties: { z: '1', a: '2' } }), 'a:b[a=2,z=1]');
  const b = stateStringToBlock('minecraft:oak_stairs[facing=east,half=top]');
  assert.deepEqual(b, { Name: 'minecraft:oak_stairs', Properties: { facing: 'east', half: 'top' } });
  assert.deepEqual(stateStringToBlock('minecraft:stone'), { Name: 'minecraft:stone', Properties: null });
});

test('round-trip blob bibliothèque (palette+indices gzip)', () => {
  const s = sample();
  const back = blobToSchem(schemToBlob(s));
  assert.ok(sameGeometry(s, back));
  assert.deepEqual(back.origin, { x: 10, y: 64, z: -5 });
});

test('round-trip Sponge .schem (v2, Offset conservé)', async () => {
  const s = sample();
  const buf = schematicToSponge(s, { name: 'test' });
  assert.ok(buf.length > 0);
  const back = await spongeToSchematic(buf);
  assert.ok(sameGeometry(s, back));
  assert.deepEqual(back.origin, { x: 10, y: 64, z: -5 });
});

test('round-trip Litematica .litematic (v6, bit-array chevauchant)', async () => {
  const s = sample();
  const buf = schematicToLitematic(s, { name: 'test' });
  assert.ok(buf.length > 0);
  const back = await litematicToSchematic(buf);
  assert.ok(sameGeometry(s, back));
  assert.deepEqual({ x: back.sx, y: back.sy, z: back.sz }, { x: 3, y: 2, z: 2 });
});

test('litematic : palette > 16 entrées (bits dynamiques) round-trip', async () => {
  // 20 blocs distincts → bits = 5, force le packing multi-long avec chevauchement.
  const s = new Schematic(20, 1, 1, null, { x: 0, y: 0, z: 0 });
  for (let i = 0; i < 20; i++) s.set(i, 0, 0, { Name: `minecraft:wool_${i}`, Properties: null });
  const back = await litematicToSchematic(schematicToLitematic(s, { name: 'p' }));
  assert.ok(sameGeometry(s, back));
});
