import test from 'node:test';
import assert from 'node:assert/strict';
import { chunksInBounds, paletteSignature, chunkKey, CH } from '../src/renderer/viewport/voxels.js';

// Après un trait de pinceau, seuls les chunks TOUCHÉS doivent être remaillés.
// Avant, le renderer jetait tous les maillages et refaisait le build entier :
// dix secondes par trait sur un gros build, ce qui rend le pinceau inutilisable.

test('une boîte dans un seul chunk en touche plusieurs — la marge compte', () => {
  // Poser un bloc au bord d'un chunk change les faces visibles de son voisin :
  // le mailleur travaille avec une couche de padding (`paddedChunk`). Sans la
  // marge, un trait au bord laisse un mur de faces fantômes à la frontière.
  const keys = chunksInBounds({ min: { x: 5, y: 5, z: 5 }, max: { x: 6, y: 6, z: 6 } });
  assert.ok(keys.includes(chunkKey(0, 0, 0)));
  assert.equal(keys.length, 1, 'au milieu du chunk, la marge n’en sort pas');
});

test('une boîte COLLÉE au bord touche aussi le voisin', () => {
  const keys = chunksInBounds({ min: { x: 0, y: 5, z: 5 }, max: { x: 0, y: 5, z: 5 } });
  assert.ok(keys.includes(chunkKey(0, 0, 0)));
  assert.ok(keys.includes(chunkKey(-1, 0, 0)), 'le chunk d’à côté aussi');
});

test('les coordonnées NÉGATIVES tombent dans le bon chunk', () => {
  // Le bloc −1 est dans le chunk −1, pas le chunk 0 : c'est une division
  // PLANCHER, et une division entière naïve chargerait la mauvaise moitié.
  const keys = chunksInBounds({ min: { x: -20, y: 5, z: 5 }, max: { x: -18, y: 5, z: 5 } });
  assert.ok(keys.includes(chunkKey(-2, 0, 0)), keys.join(' '));
  assert.equal(keys.includes(chunkKey(0, 0, 0)), false);
});

test('une boîte à cheval sur plusieurs chunks les prend tous', () => {
  const keys = chunksInBounds({ min: { x: 5, y: 5, z: 5 }, max: { x: CH * 2 + 5, y: 5, z: 5 } });
  for (const cx of [0, 1, 2]) assert.ok(keys.includes(chunkKey(cx, 0, 0)), `cx=${cx}`);
});

test('une boîte absente ou incomplète ne rend rien plutôt que tout', () => {
  // Rendre « tout » serait pire que rien : on remaillerait le build entier en
  // croyant faire un remaillage local.
  assert.deepEqual(chunksInBounds(null), []);
  assert.deepEqual(chunksInBounds({ min: { x: 0, y: 0, z: 0 } }), []);
});

test('la signature de palette change quand un bloc est REMPLACÉ', () => {
  // Un décompte ne suffirait pas : le nombre d'entrées ne bouge pas, et toutes
  // les textures changeraient.
  const a = [{ name: 'minecraft:stone' }, { name: 'minecraft:dirt' }];
  const b = [{ name: 'minecraft:stone' }, { name: 'minecraft:sand' }];
  assert.notEqual(paletteSignature(a), paletteSignature(b));
  assert.equal(paletteSignature(a), paletteSignature([...a]));
  assert.equal(paletteSignature(null), '');
});

test('l’ORDRE de la palette compte', () => {
  // Les identifiants de voxel sont des indices : permuter la palette change
  // quel bloc porte quel identifiant.
  const a = [{ name: 'a' }, { name: 'b' }];
  assert.notEqual(paletteSignature(a), paletteSignature([a[1], a[0]]));
});
