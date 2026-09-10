import test from 'node:test';
import assert from 'node:assert/strict';
import { transformProperties, isYMirrorSafe, __test } from '../src/worldedit/blockstates.js';
import {
  MemoryVolume, readSelection, mirrorSchematic, rotateSchematic, stampSchematic,
  opMirror, opMirrorCopy, opRotate, opTranslate, opReplace, opSet, opCopy, opPaste, sameBlock, selectionSize,
  opWalls, opFaces, opHollow, opOverlay, opNaturalize, opStack, opSphere, opCyl, opSmooth, opScale, opMix,
  opLine, opPyramid, opCone, opErode, opDilate, opDrain, opPath, opTerrain,
  MaskedVolume, selectionContains,
} from '../src/worldedit/transform.js';

const ROT90 = { kind: 'rotate', quarts: 1 };
const MX = { kind: 'mirror', axis: 'x' };
const MZ = { kind: 'mirror', axis: 'z' };
const MY = { kind: 'mirror', axis: 'y' };

// ── Table d'états : une assertion par propriété ──────────────────────────────

test('facing : rotation horaire north→east→south→west', () => {
  assert.equal(transformProperties({ facing: 'north' }, ROT90).facing, 'east');
  assert.equal(transformProperties({ facing: 'east' }, ROT90).facing, 'south');
  assert.equal(transformProperties({ facing: 'west' }, ROT90).facing, 'north');
  assert.equal(transformProperties({ facing: 'up' }, ROT90).facing, 'up');
});

test('facing : miroir X (east↔west) et Z (north↔south)', () => {
  assert.equal(transformProperties({ facing: 'east' }, MX).facing, 'west');
  assert.equal(transformProperties({ facing: 'north' }, MX).facing, 'north');
  assert.equal(transformProperties({ facing: 'north' }, MZ).facing, 'south');
  assert.equal(transformProperties({ facing: 'east' }, MZ).facing, 'east');
});

test('axis : x↔z en rotation, inchangé en miroir', () => {
  assert.equal(transformProperties({ axis: 'x' }, ROT90).axis, 'z');
  assert.equal(transformProperties({ axis: 'z' }, ROT90).axis, 'x');
  assert.equal(transformProperties({ axis: 'y' }, ROT90).axis, 'y');
  assert.equal(transformProperties({ axis: 'x' }, MX).axis, 'x');
});

test('rotation (0–15) : +4 par quart, (16−r) miroir X, (8−r) miroir Z', () => {
  assert.equal(transformProperties({ rotation: '0' }, ROT90).rotation, '4');
  assert.equal(transformProperties({ rotation: '14' }, ROT90).rotation, '2');
  assert.equal(transformProperties({ rotation: '4' }, MX).rotation, '12');
  assert.equal(transformProperties({ rotation: '0' }, MX).rotation, '0');
  assert.equal(transformProperties({ rotation: '2' }, MZ).rotation, '6');
});

test('escaliers shape : chiralité inversée au miroir, inchangée en rotation', () => {
  assert.equal(transformProperties({ shape: 'inner_left' }, MX).shape, 'inner_right');
  assert.equal(transformProperties({ shape: 'outer_right' }, MZ).shape, 'outer_left');
  assert.equal(transformProperties({ shape: 'straight' }, MX).shape, 'straight');
  assert.equal(transformProperties({ shape: 'inner_left' }, ROT90).shape, 'inner_left');
});

test('portes hinge : left↔right au miroir', () => {
  assert.equal(transformProperties({ hinge: 'left' }, MX).hinge, 'right');
  assert.equal(transformProperties({ hinge: 'right' }, MZ).hinge, 'left');
  assert.equal(transformProperties({ hinge: 'left' }, ROT90).hinge, 'left');
});

test('rails shape : rotation et miroirs', () => {
  assert.equal(transformProperties({ shape: 'north_south' }, ROT90).shape, 'east_west');
  assert.equal(transformProperties({ shape: 'north_east' }, ROT90).shape, 'south_east');
  assert.equal(transformProperties({ shape: 'ascending_east' }, MX).shape, 'ascending_west');
  assert.equal(transformProperties({ shape: 'ascending_north' }, MX).shape, 'ascending_north');
  assert.equal(transformProperties({ shape: 'north_east' }, MZ).shape, 'south_east');
});

test('miroir Y : half / type / facing vertical', () => {
  assert.equal(transformProperties({ half: 'top' }, MY).half, 'bottom');
  assert.equal(transformProperties({ half: 'upper' }, MY).half, 'lower');
  assert.equal(transformProperties({ type: 'top' }, MY).type, 'bottom');
  assert.equal(transformProperties({ type: 'double' }, MY).type, 'double');
  assert.equal(transformProperties({ facing: 'up' }, MY).facing, 'down');
  assert.equal(transformProperties({ facing: 'north' }, MY).facing, 'north');
});

test('miroir Y : half inchangé en miroir X/Z', () => {
  assert.equal(transformProperties({ half: 'top' }, MX).half, 'top');
});

test('propriétés cardinales (clés north/east/south/west) cyclent', () => {
  const r = transformProperties({ north: 'a', east: 'b', south: 'c', west: 'd' }, ROT90);
  assert.deepEqual(r, { east: 'a', south: 'b', west: 'c', north: 'd' });
  const m = transformProperties({ north: 'a', east: 'b', south: 'c', west: 'd' }, MX);
  assert.deepEqual(m, { north: 'a', east: 'd', south: 'c', west: 'b' });
});

test('isYMirrorSafe : portes/lits/panneaux refusés', () => {
  assert.equal(isYMirrorSafe('minecraft:oak_door'), false);
  assert.equal(isYMirrorSafe('minecraft:red_bed'), false);
  assert.equal(isYMirrorSafe('minecraft:oak_sign'), false);
  assert.equal(isYMirrorSafe('minecraft:stone'), true);
});

test('helpers internes', () => {
  assert.equal(__test.mirrorStairShape('inner_left'), 'inner_right');
  assert.equal(__test.railRotate('north_south', 2), 'north_south');
  assert.equal(__test.railRotate('north_south', 1), 'east_west');
});

// ── Transformations géométriques ─────────────────────────────────────────────

function fill(vol, sel, cb) {
  const s = selectionSize(sel);
  for (let y = 0; y < s.y; y++) for (let z = 0; z < s.z; z++) for (let x = 0; x < s.x; x++) {
    const b = cb(x, y, z);
    if (b) vol.setBlock(sel.min.x + x, sel.min.y + y, sel.min.z + z, b);
  }
}

test('miroir : involution (X∘X = identité), comptes conservés', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 0, z: 2 } };
  fill(vol, sel, (x, y, z) => ((x + z) % 2 ? { Name: 'minecraft:stone', Properties: null } : null));
  const before = readSelection(vol, sel);
  const once = mirrorSchematic(before, 'x');
  const twice = mirrorSchematic(once, 'x');
  for (let i = 0; i < before.data.length; i++) {
    assert.ok(sameBlock(before.data[i], twice.data[i]), `cellule ${i}`);
  }
});

test('miroir X puis Z d’un escalier symétrique : asymétrie nulle', () => {
  // Un quad d’escaliers orientés vers le centre est invariant par X puis Z
  // (équivalent d’une rotation 180°) si on le re-pose au même endroit.
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 1 } };
  vol.setBlock(0, 0, 0, { Name: 'minecraft:oak_stairs', Properties: { facing: 'south' } });
  vol.setBlock(1, 0, 0, { Name: 'minecraft:oak_stairs', Properties: { facing: 'south' } });
  vol.setBlock(0, 0, 1, { Name: 'minecraft:oak_stairs', Properties: { facing: 'north' } });
  vol.setBlock(1, 0, 1, { Name: 'minecraft:oak_stairs', Properties: { facing: 'north' } });
  opMirror(vol, sel, { axis: 'x' });
  opMirror(vol, sel, { axis: 'z' });
  // X∘Z = rotation 180° : ce quad symétrique est invariant → asymétrie nulle.
  assert.equal(vol.getBlock(0, 0, 0).Properties.facing, 'south');
  assert.equal(vol.getBlock(0, 0, 1).Properties.facing, 'north');
  assert.equal(vol.getBlock(1, 0, 0).Properties.facing, 'south');
});

test('rotation 90×4 = identité', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 1 } };
  fill(vol, sel, (x, y, z) => (x === 0 ? { Name: 'minecraft:oak_stairs', Properties: { facing: 'east' } } : null));
  const before = readSelection(vol, sel);
  let s = before;
  for (let i = 0; i < 4; i++) s = rotateSchematic(s, 1);
  assert.equal(s.sx, before.sx); assert.equal(s.sz, before.sz);
  for (let i = 0; i < before.data.length; i++) assert.ok(sameBlock(before.data[i], s.data[i]), `cell ${i}`);
});

test('rotation 90 d’une emprise non carrée permute X/Z + tourne le facing', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 0, z: 1 } }; // 4×1×2
  vol.setBlock(0, 0, 0, { Name: 'minecraft:furnace', Properties: { facing: 'north' } });
  const { bounds } = opRotate(vol, sel, { degrees: 90 });
  assert.deepEqual(bounds.max, { x: 1, y: 0, z: 3 }); // 2×1×4
  // (0,0,0) → (x'=(sz-1)-z, z'=x) = (1,0,0)
  assert.equal(vol.getBlock(1, 0, 0).Properties.facing, 'east');
});

// ── Opérations de haut niveau ────────────────────────────────────────────────

test('translate déplace la sélection et vide l’origine', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  vol.setBlock(0, 0, 0, { Name: 'minecraft:gold_block', Properties: null });
  opTranslate(vol, sel, { dx: 5, dy: 1, dz: -2 });
  assert.equal(vol.getBlock(0, 0, 0), null);
  assert.equal(vol.getBlock(5, 1, -2).Name, 'minecraft:gold_block');
});

test('replace (avec états optionnels) et set', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } };
  vol.setBlock(0, 0, 0, { Name: 'minecraft:oak_log', Properties: { axis: 'x' } });
  vol.setBlock(1, 0, 0, { Name: 'minecraft:oak_log', Properties: { axis: 'y' } });
  vol.setBlock(2, 0, 0, { Name: 'minecraft:stone', Properties: null });
  const r = opReplace(vol, sel, { from: { name: 'minecraft:oak_log', states: { axis: 'y' } }, to: { name: 'minecraft:spruce_log' } });
  assert.equal(r.blocksChanged, 1);
  assert.equal(vol.getBlock(1, 0, 0).Name, 'minecraft:spruce_log');
  assert.equal(vol.getBlock(0, 0, 0).Name, 'minecraft:oak_log');

  opSet(vol, sel, { block: { name: 'minecraft:glass' } });
  assert.equal(vol.getBlock(0, 0, 0).Name, 'minecraft:glass');
  assert.equal(vol.getBlock(2, 0, 0).Name, 'minecraft:glass');
});

test('copy / paste (overlay préserve l’existant sous l’air)', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 0 } };
  vol.setBlock(0, 0, 0, { Name: 'minecraft:diamond_block', Properties: null }); // (1,0,0) reste air
  vol.setBlock(11, 0, 0, { Name: 'minecraft:bedrock', Properties: null });
  const { clipboard } = opCopy(vol, sel);
  opPaste(vol, clipboard, { at: { x: 10, y: 0, z: 0 }, mode: 'overlay' });
  assert.equal(vol.getBlock(10, 0, 0).Name, 'minecraft:diamond_block');
  assert.equal(vol.getBlock(11, 0, 0).Name, 'minecraft:bedrock'); // air du presse-papier → intact
});

// ── Commandes WorldEdit / GoBrush additionnelles ─────────────────────────────

const STONE = { name: 'minecraft:stone' };
test('walls : 4 côtés ; faces : 6 faces', () => {
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } };
  const w = new MemoryVolume();
  opWalls(w, sel, { block: STONE });
  assert.equal(w.getBlock(0, 1, 0).Name, 'minecraft:stone'); // côté
  assert.equal(w.getBlock(1, 1, 1), null); // intérieur
  assert.equal(w.getBlock(1, 2, 1), null); // plafond non touché par walls
  const f = new MemoryVolume();
  opFaces(f, sel, { block: STONE });
  assert.equal(f.getBlock(1, 2, 1).Name, 'minecraft:stone'); // plafond
  assert.equal(f.getBlock(1, 0, 1).Name, 'minecraft:stone'); // sol
  assert.equal(f.getBlock(1, 1, 1), null); // intérieur
});

test('hollow : vide l’intérieur plein', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } };
  opSet(vol, sel, { block: STONE });
  const r = opHollow(vol, sel);
  assert.equal(r.blocksChanged, 1);
  assert.equal(vol.getBlock(1, 1, 1), null);
  assert.equal(vol.getBlock(0, 0, 0).Name, 'minecraft:stone');
});

test('overlay : pose au-dessus de la surface', () => {
  const vol = new MemoryVolume();
  vol.setBlock(0, 0, 0, { Name: 'minecraft:stone', Properties: null });
  opOverlay(vol, { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 3, z: 0 } }, { block: { name: 'minecraft:grass_block' } });
  assert.equal(vol.getBlock(0, 1, 0).Name, 'minecraft:grass_block');
});

test('naturalize : herbe / terre / roche profonde (palette plaine par défaut)', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 9, z: 0 } };
  for (let y = 0; y <= 9; y++) vol.setBlock(0, y, 0, { Name: 'minecraft:cobblestone', Properties: null });
  opNaturalize(vol, sel, {});
  assert.equal(vol.getBlock(0, 9, 0).Name, 'minecraft:grass_block'); // surface
  assert.equal(vol.getBlock(0, 8, 0).Name, 'minecraft:dirt'); // sous-sol
  assert.equal(vol.getBlock(0, 6, 0).Name, 'minecraft:dirt');
  // roche profonde = mélange pondéré de la palette plaine
  const deep = ['minecraft:stone', 'minecraft:andesite', 'minecraft:diorite', 'minecraft:gravel'];
  assert.ok(deep.includes(vol.getBlock(0, 5, 0).Name));
});

test('naturalize : preset montagne (pierre/andésite/cobble) + désert', () => {
  const col = (preset) => {
    const vol = new MemoryVolume();
    const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 9, z: 0 } };
    for (let y = 0; y <= 9; y++) vol.setBlock(0, y, 0, { Name: 'minecraft:netherrack', Properties: null });
    opNaturalize(vol, sel, { preset });
    return vol;
  };
  assert.equal(col('mountain').getBlock(0, 9, 0).Name, 'minecraft:stone'); // surface pierre
  assert.equal(col('mountain').getBlock(0, 8, 0).Name, 'minecraft:cobblestone'); // sous-sol cobble
  assert.equal(col('desert').getBlock(0, 9, 0).Name, 'minecraft:sand');
  assert.equal(col('desert').getBlock(0, 8, 0).Name, 'minecraft:sandstone');
});

test('naturalize : custom (blocs au choix) + auto (depuis le biome)', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 4, z: 0 } };
  for (let y = 0; y <= 4; y++) vol.setBlock(0, y, 0, { Name: 'minecraft:netherrack', Properties: null });
  opNaturalize(vol, sel, { preset: 'custom', surface: 'minecraft:moss_block', soil: 'minecraft:rooted_dirt', filler: 'minecraft:deepslate' });
  assert.equal(vol.getBlock(0, 4, 0).Name, 'minecraft:moss_block');
  assert.equal(vol.getBlock(0, 3, 0).Name, 'minecraft:rooted_dirt');
  assert.equal(vol.getBlock(0, 0, 0).Name, 'minecraft:deepslate');

  // auto : le biome désert de la colonne → surface sable.
  const v2 = new MemoryVolume();
  for (let y = 0; y <= 4; y++) v2.setBlock(0, y, 0, { Name: 'minecraft:netherrack', Properties: null });
  v2.setBiome(0, 4, 0, 'minecraft:desert');
  opNaturalize(v2, sel, { preset: 'auto' });
  assert.equal(v2.getBlock(0, 4, 0).Name, 'minecraft:sand');
});

test('stack : répète la sélection', () => {
  const vol = new MemoryVolume();
  vol.setBlock(0, 0, 0, { Name: 'minecraft:gold_block', Properties: null });
  const { bounds } = opStack(vol, { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, { count: 2, direction: 'east' });
  assert.equal(vol.getBlock(1, 0, 0).Name, 'minecraft:gold_block');
  assert.equal(vol.getBlock(2, 0, 0).Name, 'minecraft:gold_block');
  assert.equal(bounds.max.x, 2);
});

test('sphere / cyl : pinceaux centrés sur la sélection', () => {
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 6, z: 6 } };
  const s = new MemoryVolume();
  opSphere(s, sel, { block: STONE, radius: 3 });
  assert.equal(s.getBlock(3, 3, 3).Name, 'minecraft:stone'); // centre
  assert.equal(s.getBlock(0, 0, 0), null); // coin hors boule
  const c = new MemoryVolume();
  opCyl(c, sel, { block: { name: 'minecraft:dirt' }, radius: 3 });
  assert.equal(c.getBlock(3, 0, 3).Name, 'minecraft:dirt'); // centre bas
  assert.equal(c.getBlock(3, 6, 3).Name, 'minecraft:dirt'); // centre haut (toute la hauteur)
  assert.equal(c.getBlock(0, 0, 0), null);
});

test('smooth : abaisse un pic isolé vers ses voisins', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 5, z: 4 } };
  for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) vol.setBlock(x, 0, z, { Name: 'minecraft:grass_block', Properties: null });
  for (let y = 1; y <= 4; y++) vol.setBlock(2, y, 2, { Name: 'minecraft:grass_block', Properties: null });
  opSmooth(vol, sel, { iterations: 4 });
  assert.equal(vol.getBlock(2, 4, 2), null); // sommet du pic aplani
});

test('scale : ×2 agrandit, ×0.5 réduit', () => {
  const up = new MemoryVolume();
  up.setBlock(0, 0, 0, { Name: 'minecraft:gold_block', Properties: null });
  const r = opScale(up, { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, { factor: 2 });
  assert.equal(up.getBlock(1, 1, 1).Name, 'minecraft:gold_block'); // bloc 2×2×2
  assert.deepEqual(r.bounds.max, { x: 1, y: 1, z: 1 });

  const down = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) down.setBlock(x, y, z, { Name: 'minecraft:stone', Properties: null });
  opScale(down, sel, { factor: 0.5 });
  assert.equal(down.getBlock(0, 0, 0).Name, 'minecraft:stone');
  assert.equal(down.getBlock(1, 1, 1), null); // réduit à 1×1×1
});

test('mix (mélange %) : remplit avec les blocs du pattern, filtre `from`', () => {
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 3, z: 3 } };
  // Un seul bloc dans le pattern → déterministe (tout en stone).
  const a = new MemoryVolume();
  opMix(a, sel, { from: null, pattern: [{ name: 'minecraft:stone', weight: 1 }] });
  assert.equal(a.getBlock(2, 2, 2).Name, 'minecraft:stone');

  // Propriété (vraie quel que soit le hasard) : chaque case ∈ {dirt, andesite}.
  const allowed = new Set(['minecraft:dirt', 'minecraft:andesite']);
  const c = new MemoryVolume();
  opMix(c, sel, { from: null, pattern: [{ name: 'minecraft:dirt', weight: 30 }, { name: 'minecraft:andesite', weight: 20 }] });
  for (let x = 0; x <= 3; x++) for (let y = 0; y <= 3; y++) for (let z = 0; z <= 3; z++) assert.ok(allowed.has(c.getBlock(x, y, z).Name));

  // `from` : ne touche que la cobble (déterministe avec un pattern à 1 entrée).
  const f = new MemoryVolume();
  f.setBlock(0, 0, 0, { Name: 'minecraft:cobblestone', Properties: null });
  f.setBlock(1, 0, 0, { Name: 'minecraft:oak_planks', Properties: null });
  opMix(f, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 0 } }, { from: { name: 'minecraft:cobblestone' }, pattern: [{ name: 'minecraft:gravel', weight: 1 }] });
  assert.equal(f.getBlock(0, 0, 0).Name, 'minecraft:gravel');
  assert.equal(f.getBlock(1, 0, 0).Name, 'minecraft:oak_planks'); // intact
});

test('replace multi-source : plusieurs blocs → une cible', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } };
  vol.setBlock(0, 0, 0, { Name: 'minecraft:cobblestone', Properties: null });
  vol.setBlock(1, 0, 0, { Name: 'minecraft:dirt', Properties: null });
  vol.setBlock(2, 0, 0, { Name: 'minecraft:oak_planks', Properties: null });
  opReplace(vol, sel, { from: [{ name: 'minecraft:cobblestone' }, { name: 'minecraft:dirt' }], to: { name: 'minecraft:stone' } });
  assert.equal(vol.getBlock(0, 0, 0).Name, 'minecraft:stone');
  assert.equal(vol.getBlock(1, 0, 0).Name, 'minecraft:stone');
  assert.equal(vol.getBlock(2, 0, 0).Name, 'minecraft:oak_planks'); // intact
});

test('set + masque on_surface : ne pose qu’au-dessus de la surface', () => {
  const vol = new MemoryVolume();
  vol.setBlock(0, 0, 0, { Name: 'minecraft:dirt', Properties: null }); // surface y=0
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 3, z: 0 } };
  opSet(vol, sel, { block: { name: 'minecraft:grass_block' }, mask: { type: 'on_surface' } });
  assert.equal(vol.getBlock(0, 1, 0).Name, 'minecraft:grass_block'); // juste au-dessus
  assert.equal(vol.getBlock(0, 0, 0).Name, 'minecraft:dirt'); // surface intacte
  assert.equal(vol.getBlock(0, 2, 0), null); // pas plus haut
});

test('line : trace une droite entre A et B', () => {
  const vol = new MemoryVolume();
  const r = opLine(vol, { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 0, z: 0 } }, { block: { name: 'minecraft:stone' } });
  assert.equal(r.blocksChanged, 4);
  for (let x = 0; x <= 3; x++) assert.equal(vol.getBlock(x, 0, 0).Name, 'minecraft:stone');
});

test('pyramid : base pleine, sommet rétréci', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 2, z: 4 } };
  opPyramid(vol, sel, { block: { name: 'minecraft:sandstone' } });
  assert.ok(vol.getBlock(2, 0, 2)); // centre base
  assert.ok(vol.getBlock(0, 0, 0)); // coin base
  assert.equal(vol.getBlock(0, 2, 0), null); // coin au sommet → vide
});

test('cône creux : coque seulement', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 6, z: 6 } };
  opCone(vol, sel, { block: { name: 'minecraft:stone' }, hollow: true });
  assert.ok(vol.getBlock(3, 0, 3)); // bord/centre bas présent
});

test('sphère creuse : centre vide', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 8, z: 8 } };
  opSphere(vol, sel, { block: { name: 'minecraft:stone' }, radius: 4, hollow: true });
  assert.equal(vol.getBlock(4, 4, 4), null); // centre creux
  assert.ok(vol.getBlock(8, 4, 4) || vol.getBlock(7, 4, 4)); // coque présente
});

test('erode : un bloc isolé est rongé ; dilate comble un trou', () => {
  const e = new MemoryVolume();
  e.setBlock(2, 2, 2, { Name: 'minecraft:stone', Properties: null }); // 6 faces air
  opErode(e, { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } }, { iterations: 1, threshold: 4 });
  assert.equal(e.getBlock(2, 2, 2), null);

  const d = new MemoryVolume();
  // trou en (1,1,1) entouré de pierre sur 6 faces
  for (const [x, y, z] of [[0, 1, 1], [2, 1, 1], [1, 0, 1], [1, 2, 1], [1, 1, 0], [1, 1, 2]]) d.setBlock(x, y, z, { Name: 'minecraft:stone', Properties: null });
  opDilate(d, { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } }, { iterations: 1, threshold: 6 });
  assert.equal(d.getBlock(1, 1, 1).Name, 'minecraft:stone');
});

test('drain : vide eau/lave', () => {
  const vol = new MemoryVolume();
  vol.setBlock(0, 0, 0, { Name: 'minecraft:water', Properties: null });
  vol.setBlock(1, 0, 0, { Name: 'minecraft:stone', Properties: null });
  opDrain(vol, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 0 } });
  assert.equal(vol.getBlock(0, 0, 0), null);
  assert.equal(vol.getBlock(1, 0, 0).Name, 'minecraft:stone');
});

test('sélection sphère : MaskedVolume clippe les écritures hors forme', () => {
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 }, shape: { type: 'sphere' } };
  assert.equal(selectionContains(sel, 2, 2, 2), true); // centre
  assert.equal(selectionContains(sel, 0, 0, 0), false); // coin hors sphère
  const vol = new MemoryVolume();
  opSet(new MaskedVolume(vol, sel), sel, { block: { name: 'minecraft:stone' } });
  assert.equal(vol.getBlock(2, 2, 2).Name, 'minecraft:stone');
  assert.equal(vol.getBlock(0, 0, 0), null); // jamais écrit (hors sphère)
});

test('blocs minefield:* : géométrie déplacée, namespace préservé', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 0 } };
  vol.setBlock(0, 0, 0, { Name: 'minefield:quart_de_bloc', Properties: { facing: 'north' } });
  opMirror(vol, sel, { axis: 'z' });
  const b = vol.getBlock(0, 0, 0);
  assert.equal(b.Name, 'minefield:quart_de_bloc'); // jamais remappé vanilla
  assert.equal(b.Properties.facing, 'south');
});

test('opPath : route droite de largeur 3 (revêtement + sous-couche)', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 4, z: 0 }, max: { x: 10, y: 4, z: 0 } }; // ligne sur X
  const r = opPath(vol, sel, { preset: 'dirt_path', width: 3, bow: 0 });
  assert.ok(r.blocksChanged > 0);
  // centre du chemin = revêtement dirt_path
  assert.equal(vol.getBlock(5, 4, 0)?.Name, 'minecraft:dirt_path');
  // sous-couche dirt juste dessous
  assert.equal(vol.getBlock(5, 3, 0)?.Name, 'minecraft:dirt');
  // largeur 3 → la colonne voisine en Z est aussi pavée
  assert.equal(vol.getBlock(5, 4, 1)?.Name, 'minecraft:dirt_path');
  assert.equal(vol.getBlock(5, 4, 2), null); // pas au-delà de la largeur
});

test('opPath : pont = planches + rambardes (fences) sur les bords', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 4, z: 0 }, max: { x: 6, y: 4, z: 0 } };
  opPath(vol, sel, { preset: 'bridge', width: 3, bow: 0 });
  assert.equal(vol.getBlock(3, 4, 0)?.Name, 'minecraft:oak_planks'); // tablier
  // rambarde (fence) un bloc au-dessus, sur un bord
  assert.equal(vol.getBlock(3, 5, 1)?.Name, 'minecraft:oak_fence');
});

test('opPath : courbe (bow) sort de l’axe droit', () => {
  const straight = new MemoryVolume();
  const curved = new MemoryVolume();
  const sel = { min: { x: 0, y: 4, z: 0 }, max: { x: 12, y: 4, z: 0 } };
  opPath(straight, sel, { preset: 'cobblestone', width: 1, bow: 0 });
  const rc = opPath(curved, sel, { preset: 'cobblestone', width: 1, bow: 6 });
  // la courbe dépasse en Z (l'axe droit reste à z=0)
  assert.ok(rc.bounds.max.z > 0, 'la courbe doit s’écarter en Z');
});

test('opTerrain : relief procédural varié + déterministe (seed)', async () => {
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 24, z: 31 } };
  const gen = async () => { const v = new MemoryVolume(); await opTerrain(v, sel, { style: 'montagne', seed: 42, palette: 'mountain' }); return v; };
  const a = await gen(), b = await gen();
  // déterministe : même seed → même surface en plusieurs points
  const topAt = (v, x, z) => { for (let y = sel.max.y; y >= sel.min.y; y--) if (v.getBlock(x, y, z)) return y; return -1; };
  const heights = [];
  for (let x = 0; x < 32; x += 4) for (let z = 0; z < 32; z += 4) {
    assert.equal(topAt(a, x, z), topAt(b, x, z), `déterminisme (${x},${z})`);
    heights.push(topAt(a, x, z));
  }
  // relief varié : pas une dalle plate
  assert.ok(Math.max(...heights) - Math.min(...heights) >= 3, 'le terrain doit avoir du dénivelé');
  // surface = pierre (palette montagne) ; pas d'air sous la surface
  const hx = topAt(a, 0, 0);
  assert.ok(a.getBlock(0, hx, 0));
});

test('opTerrain : crevasse creuse (base haute, vallées) + clearAbove purge le dessus', async () => {
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 30, z: 15 } };
  const v = new MemoryVolume();
  // pré-remplir tout le volume pour vérifier la purge au-dessus de la surface
  for (let y = 0; y <= 30; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) v.setBlock(x, y, z, { Name: 'minecraft:netherrack', Properties: null });
  await opTerrain(v, sel, { style: 'crevasse', seed: 7, palette: 'mountain' });
  const topAt = (x, z) => { for (let y = sel.max.y; y >= sel.min.y; y--) if (v.getBlock(x, y, z)) return y; return -1; };
  // au-dessus de la surface : purgé (air)
  const h = topAt(0, 0);
  assert.equal(v.getBlock(0, h + 1, 0), null);
});

test('opMirrorCopy : duplique en miroir à droite (original intact, états retournés)', () => {
  const vol = new MemoryVolume();
  // Sélection 0..2 en X : un escalier orienté est en x=0, pierre en x=2.
  vol.setBlock(0, 0, 0, { Name: 'minecraft:oak_stairs', Properties: { facing: 'east' } });
  vol.setBlock(2, 0, 0, { Name: 'minecraft:stone', Properties: null });
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } };
  const r = opMirrorCopy(vol, sel, { axis: 'x', side: 'positive', gap: 0, mode: 'overlay' });

  // L'original est intact.
  assert.equal(vol.getBlock(0, 0, 0).Properties.facing, 'east');
  assert.equal(vol.getBlock(2, 0, 0).Name, 'minecraft:stone');
  // La copie est posée juste à droite (x=3..5), en miroir : la pierre (x=2) →
  // bord gauche de la copie (x=3), l'escalier (x=0) → bord droit (x=5) retourné.
  assert.equal(vol.getBlock(3, 0, 0).Name, 'minecraft:stone');
  assert.equal(vol.getBlock(5, 0, 0).Properties.facing, 'west'); // east → west (miroir X)
  assert.deepEqual(r.bounds.min, { x: 3, y: 0, z: 0 });
  assert.deepEqual(r.bounds.max, { x: 5, y: 0, z: 0 });
});

test('opMirrorCopy : côté négatif + écart', () => {
  const vol = new MemoryVolume();
  vol.setBlock(10, 0, 0, { Name: 'minecraft:stone', Properties: null });
  const sel = { min: { x: 10, y: 0, z: 0 }, max: { x: 11, y: 0, z: 0 } };
  const r = opMirrorCopy(vol, sel, { axis: 'x', side: 'negative', gap: 2, mode: 'overlay' });
  // largeur 2, côté −, écart 2 → origine x = 10 - 2 - 2 = 6, copie 6..7
  assert.deepEqual(r.bounds.min, { x: 6, y: 0, z: 0 });
  assert.deepEqual(r.bounds.max, { x: 7, y: 0, z: 0 });
  assert.ok(vol.getBlock(10, 0, 0)); // original intact
});

test('opScale hollow : agrandit puis garde la coque (intérieur vidé)', () => {
  // Cube plein 2×2×2 → ×2 = 4×4×4. En plein : 64 blocs. En coque : intérieur 2×2×2 vidé → 56.
  const solid = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) for (let x = 0; x <= 1; x++) solid.setBlock(x, y, z, { Name: 'minecraft:stone', Properties: null });

  const hollowVol = new MemoryVolume();
  for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) for (let x = 0; x <= 1; x++) hollowVol.setBlock(x, y, z, { Name: 'minecraft:stone', Properties: null });
  opScale(hollowVol, sel, { factor: 2, hollow: true });

  const count = (v) => { let n = 0; for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) if (v.getBlock(x, y, z)) n++; return n; };
  assert.equal(count(hollowVol), 56); // 64 - 8 (cœur 2³) = coque
  // Les coins et faces restent pleins, le centre est vide.
  assert.ok(hollowVol.getBlock(0, 0, 0));
  assert.equal(hollowVol.getBlock(1, 1, 1), null); // une cellule du cœur 2³ (1..2)
  assert.equal(hollowVol.getBlock(2, 2, 2), null);
});

test('opScale plein (sans hollow) : remplit tout le cube agrandi', () => {
  const vol = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) for (let x = 0; x <= 1; x++) vol.setBlock(x, y, z, { Name: 'minecraft:stone', Properties: null });
  opScale(vol, sel, { factor: 2, hollow: false });
  let n = 0; for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) if (vol.getBlock(x, y, z)) n++;
  assert.equal(n, 64);
});
