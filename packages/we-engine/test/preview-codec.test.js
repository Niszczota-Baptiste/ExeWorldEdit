import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePreview, decodePreview, isBinaryPreview } from '../src/staging/previewCodec.js';

// L'aperçu est ce que l'utilisateur VOIT. Un encodage qui perd un bloc ou en
// décale un ne plante pas : il affiche un build légèrement faux. Le seul test
// qui prouve quelque chose est l'aller-retour exact.

const sparse = (min, size, cells, extra = {}) => {
  const palette = [];
  const index = new Map();
  const blocks = [];
  for (const [x, y, z, name] of cells) {
    let i = index.get(name);
    if (i === undefined) { i = palette.length; palette.push({ name, props: null }); index.set(name, i); }
    blocks.push(x, y, z, i);
  }
  return {
    palette, blocks, count: cells.length, truncated: false,
    bom: [{ blockId: 'minecraft:stone', count: cells.length }],
    min, size, ...extra,
  };
};

test('aller-retour exact sur un aperçu ordinaire', () => {
  const p = sparse({ x: -10, y: 40, z: 7 }, { x: 32, y: 24, z: 32 }, [
    [0, 0, 0, 'minecraft:stone'],
    [31, 23, 31, 'minecraft:dirt'],
    [5, 12, 19, 'minecraft:stone'],
    [1, 0, 30, 'minecraft:oak_log'],
  ]);
  const back = decodePreview(encodePreview(p));
  assert.deepEqual(back.blocks, p.blocks);
  assert.deepEqual(back.palette, p.palette);
  assert.deepEqual(back.min, p.min);
  assert.deepEqual(back.size, p.size);
  assert.deepEqual(back.bom, p.bom);
  assert.equal(back.count, p.count);
  assert.equal(back.truncated, false);
});

test('les coordonnées ne se mélangent pas entre axes', () => {
  // Une emprise aux trois dimensions DIFFÉRENTES : avec un cube, une inversion
  // x↔z passerait inaperçue.
  const p = sparse({ x: 0, y: 0, z: 0 }, { x: 7, y: 3, z: 11 }, [
    [6, 0, 0, 'a'], [0, 2, 0, 'b'], [0, 0, 10, 'c'], [6, 2, 10, 'd'], [3, 1, 5, 'e'],
  ]);
  assert.deepEqual(decodePreview(encodePreview(p)).blocks, p.blocks);
});

test('chaque case d’une petite emprise se retrouve à sa place', () => {
  // Balayage exhaustif : la meilleure garantie contre une erreur d'index.
  const size = { x: 5, y: 4, z: 3 };
  const cells = [];
  for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) {
    cells.push([x, y, z, `b${(x + y + z) % 3}`]);
  }
  const p = sparse({ x: 0, y: 0, z: 0 }, size, cells);
  const back = decodePreview(encodePreview(p));
  assert.deepEqual(back.blocks, p.blocks);
});

test('un aperçu vide fait un aller-retour', () => {
  const p = sparse({ x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 4 }, []);
  const back = decodePreview(encodePreview(p));
  assert.deepEqual(back.blocks, []);
  assert.equal(back.count, 0);
});

test('le drapeau « tronqué » survit', () => {
  const p = sparse({ x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 4 }, [[1, 1, 1, 'x']], { truncated: true });
  assert.equal(decodePreview(encodePreview(p)).truncated, true);
});

test('une emprise trop grande pour un index linéaire bascule en mode triple', () => {
  // 2 000 × 2 000 × 2 000 = 8 × 10⁹ cases : au-delà de ce qu'un Uint32 adresse.
  const p = sparse({ x: 0, y: -64, z: 0 }, { x: 2000, y: 2000, z: 2000 }, [
    [1999, 1999, 1999, 'minecraft:stone'], [0, 0, 0, 'minecraft:dirt'],
  ]);
  const buf = encodePreview(p);
  const head = JSON.parse(buf.toString('utf8', 12, 12 + buf.readUInt32LE(8)));
  assert.equal(head.mode, 'triple', 'le mode linéaire déborderait');
  assert.deepEqual(decodePreview(buf).blocks, p.blocks);
});

test('une palette de plus de 65 535 entrées passe en index large', () => {
  // Sinon l'index de palette repasserait à zéro en silence — un bloc deviendrait
  // un autre bloc, sans la moindre erreur.
  const palette = Array.from({ length: 70000 }, (_, i) => ({ name: `t:b${i}`, props: null }));
  const p = {
    palette, blocks: [0, 0, 0, 69999, 1, 0, 0, 3], count: 2, truncated: false, bom: [],
    min: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 4, z: 4 },
  };
  const back = decodePreview(encodePreview(p));
  assert.equal(back.blocks[3], 69999);
  assert.equal(back.blocks[7], 3);
});

test('le format se reconnaît, et refuse ce qui n’est pas lui', () => {
  const p = sparse({ x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 4 }, [[1, 1, 1, 'x']]);
  assert.equal(isBinaryPreview(encodePreview(p)), true);
  assert.equal(isBinaryPreview(Buffer.from('{"palette":[]}')), false, 'un ancien aperçu JSON');
  assert.equal(isBinaryPreview(Buffer.alloc(3)), false);
  assert.throws(() => decodePreview(Buffer.from('pas un aperçu')), /bad_preview/);
});

test('l’encodage est plus rapide que JSON sur un gros aperçu', () => {
  // La raison d'être du format. On ne mesure pas un facteur précis (le bruit
  // d'un conteneur partagé l'interdit) mais on refuse la régression.
  const n = 200_000;
  const size = { x: 256, y: 128, z: 256 };
  const blocks = new Array(n * 4);
  for (let k = 0, i = 0; k < n; k++, i += 4) {
    blocks[i] = k % size.x;
    blocks[i + 1] = (k / (size.x * size.z)) | 0;
    blocks[i + 2] = ((k / size.x) | 0) % size.z;
    blocks[i + 3] = k % 8;
  }
  const p = {
    palette: Array.from({ length: 8 }, (_, i) => ({ name: `t:b${i}`, props: null })),
    blocks, count: n, truncated: false, bom: [], min: { x: 0, y: 0, z: 0 }, size,
  };

  const t0 = Date.now(); const buf = encodePreview(p); const encMs = Date.now() - t0;
  const t1 = Date.now(); const back = decodePreview(buf); const decMs = Date.now() - t1;
  const t2 = Date.now(); JSON.parse(JSON.stringify(p)); const jsonMs = Date.now() - t2;

  assert.deepEqual(back.blocks, p.blocks, 'exactitude d’abord');
  assert.ok(encMs + decMs < jsonMs, `binaire ${encMs + decMs} ms contre JSON seul ${jsonMs} ms`);
});
