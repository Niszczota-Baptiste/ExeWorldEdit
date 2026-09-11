import test from 'node:test';
import assert from 'node:assert/strict';
import { atlasLayers, FACES } from '../src/renderer/viewport/atlas.js';
import { buildTables } from '../src/renderer/viewport/blockColors.js';

// L'INDEXATION est la seule chose difficile de l'atlas, et elle se trompe en
// silence : l'identifiant d'un voxel est l'indice de palette PLUS UN, parce que
// 0 est réservé à l'air. Une table indexée sur la palette décale tout d'un cran
// — chaque bloc prend la texture de son voisin, et l'herbe sort en pierre.
// C'est exactement ce qui est arrivé, et ça s'est vu à l'écran avant de se voir
// dans le code.

/** Un compteur de couches, à la place du chargeur d'images. */
function compteur() {
  const vues = new Map();
  return async (src) => {
    if (!src) return 0;
    if (!vues.has(src)) vues.set(src, vues.size + 1);
    return vues.get(src);
  };
}

const PALETTE = [
  { name: 'minecraft:stone' },
  { name: 'minecraft:grass_block' },
  { name: 'minefield:chaise' },
];
const FACE_SRC = {
  'minecraft:stone': Object.fromEntries(FACES.map((f) => [f, 'stone.png'])),
  'minecraft:grass_block': { ...Object.fromEntries(FACES.map((f) => [f, 'side.png'])), up: 'top.png', down: 'dirt.png' },
};

test('la table est indexée comme les VOXELS, pas comme la palette', async () => {
  const layers = await atlasLayers(PALETTE, FACE_SRC, compteur());
  const { colors } = buildTables(PALETTE);
  // Même convention que la table des couleurs : une case de plus, pour l'air.
  assert.equal(layers.length / 6, colors.length / 3);
  assert.equal(layers.length / 6, PALETTE.length + 1);
  // La case 0 est celle de l'air : jamais émise par le mailleur, donc jamais
  // texturée.
  for (let k = 0; k < 6; k++) assert.equal(layers[k], 0);
});

test('chaque bloc retrouve SES textures, pas celles du voisin', async () => {
  const layers = await atlasLayers(PALETTE, FACE_SRC, compteur());
  const iStone = 1, iGrass = 2, iChaise = 3; // indice de palette + 1
  const face = (i, nom) => layers[i * 6 + FACES.indexOf(nom)];

  // La pierre : la même texture sur les six faces.
  const p = face(iStone, 'up');
  assert.ok(p > 0);
  for (const f of FACES) assert.equal(face(iStone, f), p, `pierre ${f}`);

  // L'herbe : trois textures distinctes, et surtout PAS celles de la pierre.
  assert.notEqual(face(iGrass, 'up'), face(iGrass, 'north'));
  assert.notEqual(face(iGrass, 'up'), face(iGrass, 'down'));
  assert.notEqual(face(iGrass, 'up'), p, 'le dessus de l’herbe n’est pas de la pierre');

  // La chaise n'est pas dans le pack : couche 0, donc blanche, donc sa couleur.
  for (const f of FACES) assert.equal(face(iChaise, f), 0, `chaise ${f}`);
});

test('une palette vide ne rend que la case de l’air', async () => {
  const layers = await atlasLayers([], {}, compteur());
  assert.equal(layers.length, 6);
  assert.ok(layers.every((l) => l === 0));
});

test('l’ordre des faces est celui du mailleur, MESURÉ', async () => {
  // `d * 2 + (front ? 1 : 0)` : la face négative de chaque axe d'abord.
  // Déduit d'un commentaire, cet ordre était faux — le mailleur annonçait
  // « +Y −Y » — et la texture du dessous se retrouvait sur le dessus des blocs.
  // On le vérifie donc contre le mailleur lui-même, pas contre une liste.
  const { meshChunk, P } = await import('../src/renderer/viewport/mesher.js');
  const ids = new Uint16Array(P * P * P);
  ids[(1 * P + 1) * P + 1] = 1;
  const layers = new Uint16Array(2 * 6);
  for (let f = 0; f < 6; f++) layers[6 + f] = f + 1; // couche = indice de face + 1
  const out = meshChunk(ids, Uint8Array.from([0, 1]), Uint8Array.from([0, 0, 0, 9, 9, 9]), layers);

  // Pour chaque quad, la direction de sa normale et l'indice de face qu'il porte.
  const vus = {};
  for (let q = 0; q < out.positions.length / 12; q++) {
    const a = (c, k) => out.positions[(q * 4 + c) * 3 + k];
    const plat = (k) => [0, 1, 2, 3].every((c) => a(c, k) === a(0, k));
    let dir = null;
    if (plat(1)) dir = a(0, 1) === 1 ? 'up' : 'down';
    else if (plat(0)) dir = a(0, 0) === 1 ? 'east' : 'west';
    else if (plat(2)) dir = a(0, 2) === 1 ? 'south' : 'north';
    vus[dir] = out.layers[q * 4] - 1;
  }
  for (const [dir, indice] of Object.entries(vus)) {
    assert.equal(FACES[indice], dir, `l'indice ${indice} devrait être « ${dir} »`);
  }
  assert.equal(Object.keys(vus).length, 6, 'les six faces d’un bloc isolé');
});

test('le DESSUS est la face la plus claire', async () => {
  // L'ombrage était inversé : le dessous éclairé à plein, le dessus assombri.
  // Sur un build gris ça ne saute pas aux yeux ; un terrain en terrasses
  // montrait ses marches plus claires que ses plats.
  const { meshChunk, P } = await import('../src/renderer/viewport/mesher.js');
  const ids = new Uint16Array(P * P * P);
  ids[(1 * P + 1) * P + 1] = 1;
  const out = meshChunk(ids, Uint8Array.from([0, 1]), Uint8Array.from([0, 0, 0, 200, 200, 200]));
  let dessus = -1, dessous = -1;
  for (let q = 0; q < out.positions.length / 12; q++) {
    const a = (c, k) => out.positions[(q * 4 + c) * 3 + k];
    if (![0, 1, 2, 3].every((c) => a(c, 1) === a(0, 1))) continue;
    const lum = out.colors[q * 12];
    if (a(0, 1) === 1) dessus = lum; else dessous = lum;
  }
  assert.ok(dessus > dessous, `dessus ${dessus} doit être plus clair que dessous ${dessous}`);
});
