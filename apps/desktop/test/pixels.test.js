import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatcher, toMask, toBlockNames, toHeights, grayToRgba, luma } from '../src/renderer/grid/pixels.js';

// Ce module n'a aucune dépendance au DOM, exprès : c'est lui qui décide quel
// bloc pour quelle couleur et quelle hauteur pour quel gris, et ces décisions
// doivent être vérifiables sans navigateur.

const PALETTE = [
  { block: 'minecraft:white_concrete', r: 250, g: 250, b: 250 },
  { block: 'minecraft:black_concrete', r: 10, g: 10, b: 10 },
  { block: 'minecraft:red_concrete', r: 200, g: 20, b: 20 },
  { block: 'minecraft:blue_concrete', r: 20, g: 20, b: 200 },
];

/** Quelques pixels RGBA, pour ne pas écrire des tableaux à la main partout. */
const rgba = (...px) => Uint8ClampedArray.from(px.flat());

test('le bloc choisi est le plus proche de la couleur', () => {
  const m = makeMatcher(PALETTE);
  assert.equal(m(255, 255, 255), 'minecraft:white_concrete');
  assert.equal(m(0, 0, 0), 'minecraft:black_concrete');
  assert.equal(m(180, 40, 30), 'minecraft:red_concrete');
  assert.equal(m(30, 40, 180), 'minecraft:blue_concrete');
});

test('la correspondance est mise en cache, sans changer de réponse', () => {
  // Exigence de performance, pas raffinement : une carte de 128² sur soixante
  // blocs fait un million de comparaisons, alors qu'une image réelle n'a que
  // quelques milliers de couleurs distinctes. La palette compte ses lectures.
  let lectures = 0;
  const espion = PALETTE.map((c) => ({
    block: c.block, g: c.g, b: c.b,
    get r() { lectures++; return c.r; },
  }));
  const m = makeMatcher(espion);

  const premier = m(123, 45, 67);
  const apresUn = lectures;
  assert.ok(apresUn >= PALETTE.length, 'le premier appel parcourt la palette');

  for (let i = 0; i < 50; i++) assert.equal(m(123, 45, 67), premier);
  assert.equal(lectures, apresUn, 'une couleur déjà vue ne reparcourt rien');

  m(200, 20, 20);
  assert.ok(lectures > apresUn, 'une couleur nouvelle, elle, est bien cherchée');
});

test('masque : le seuil tranche, et la transparence n’est jamais de l’encre', () => {
  const px = rgba(
    [255, 255, 255, 255], // blanc opaque → encre
    [0, 0, 0, 255], // noir opaque → fond
    [255, 255, 255, 0], // blanc TRANSPARENT → fond
    [140, 140, 140, 255], // gris au-dessus du seuil → encre
  );
  assert.deepEqual([...toMask(px)], [1, 0, 0, 1]);
  assert.deepEqual([...toMask(px, { invert: true })], [0, 1, 1, 0]);
  assert.deepEqual([...toMask(px, { threshold: 200 })], [1, 0, 0, 0]);
});

test('carte : une cellule transparente ne donne pas de bloc', () => {
  const px = rgba([250, 250, 250, 255], [0, 0, 0, 0], [200, 20, 20, 255]);
  assert.deepEqual(toBlockNames(px, PALETTE), [
    'minecraft:white_concrete', null, 'minecraft:red_concrete',
  ]);
});

test('relief : la luminance donne un RAPPORT, pas un nombre de blocs', () => {
  // `applyHeightmap` fait `clamp01(h) * maxH`. Lui donner des hauteurs absolues
  // faisait passer toute cellule non nulle à 1 — un plateau plat au sommet de
  // la sélection au lieu du relief demandé.
  const px = rgba([0, 0, 0, 255], [255, 255, 255, 255], [128, 128, 128, 255], [255, 255, 255, 0]);
  const h = toHeights(px);
  assert.equal(h[0], 0);
  assert.equal(h[1], 1);
  assert.ok(Math.abs(h[2] - 128 / 255) < 1e-6);
  assert.equal(h[3], 0, 'un pixel transparent vaut le sol');
  assert.ok(h.every((v) => v >= 0 && v <= 1), 'toujours dans 0..1');

  const inv = toHeights(px, { invert: true });
  assert.equal(inv[0], 1);
  assert.equal(inv[1], 0);
});

test('la luminance est perçue, pas une moyenne', () => {
  // Un vert pur paraît bien plus clair qu'un bleu pur à valeur égale. Une
  // moyenne les rendrait identiques, et un dégradé de ciel ressortirait plat.
  assert.ok(luma(0, 255, 0) > luma(0, 0, 255));
  assert.equal(Math.round(luma(255, 255, 255)), 255);
  assert.equal(luma(0, 0, 0), 0);
});

test('aller-retour gris → RGBA', () => {
  const out = grayToRgba(Uint8Array.from([0, 128, 255]));
  assert.deepEqual([...out], [0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
});
