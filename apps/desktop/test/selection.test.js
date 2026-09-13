import test from 'node:test';
import assert from 'node:assert/strict';
import { boxFromCorners, boxVolume, clampBox, sameBox } from '../src/renderer/viewport/selection.js';

// La sélection ne se réglait que par les six champs de l'inspecteur : douze
// nombres à taper pour désigner un coin de build qu'on a sous les yeux. Et rien
// ne la montrait dans la vue, ce qui se lit « la sélection ne marche pas ».

test('les deux coins vont dans n’importe quel ORDRE', () => {
  // On tire aussi bien vers le nord-ouest que vers le sud-est. Supposer que le
  // premier coin est le plus petit donnerait une boîte vide une fois sur deux.
  const a = { x: 10, y: 20, z: 30 };
  const b = { x: 2, y: 25, z: 4 };
  const box = boxFromCorners(a, b);
  assert.deepEqual(box.min, { x: 2, y: 20, z: 4 });
  assert.deepEqual(box.max, { x: 10, y: 25, z: 30 });
  assert.deepEqual(boxFromCorners(b, a), box, 'l’ordre ne change rien');
});

test('un clic sans glisser sélectionne UN bloc', () => {
  // C'est une sélection légitime, et c'est comme ça qu'on en pose une petite.
  const v = { x: 4, y: 5, z: 6 };
  const box = boxFromCorners(v, v);
  assert.deepEqual(box.min, v);
  assert.deepEqual(box.max, v);
  assert.equal(boxVolume(box), 1);
});

test('le volume compte les BORNES', () => {
  // De 0 à 15 inclus fait seize blocs, pas quinze. Une erreur d'une unité ici
  // se propage à tout ce qui vérifie un plafond.
  assert.equal(boxVolume({ min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }), 4096);
  assert.equal(boxVolume(null), 0);
});

test('la boîte est serrée dans la hauteur du MONDE', () => {
  // Un glisser qui sort par le haut proposerait une sélection au-dessus du
  // plafond : le moteur la refuserait, après coup et sans qu'on comprenne.
  const box = { min: { x: 0, y: -200, z: 0 }, max: { x: 5, y: 900, z: 5 } };
  const serre = clampBox(box, { worldMinY: -64, worldMaxY: 319 });
  assert.equal(serre.min.y, -64);
  assert.equal(serre.max.y, 319);
  assert.equal(serre.min.x, 0, 'X et Z ne sont pas bornés : un monde est infini à plat');
  assert.equal(serre.max.x, 5);
});

test('sans limites connues, on retombe sur celles de Minecraft', () => {
  const serre = clampBox({ min: { x: 0, y: -500, z: 0 }, max: { x: 0, y: 500, z: 0 } }, null);
  assert.equal(serre.min.y, -64);
  assert.equal(serre.max.y, 319);
});

test('deux boîtes identiques sont reconnues', () => {
  // Un glisser produit des dizaines d'événements dont la plupart ne changent
  // rien : sans cette comparaison, chacun repartirait vers le moteur.
  const a = { min: { x: 1, y: 2, z: 3 }, max: { x: 4, y: 5, z: 6 } };
  assert.equal(sameBox(a, { min: { ...a.min }, max: { ...a.max } }), true);
  assert.equal(sameBox(a, { min: { ...a.min }, max: { ...a.max, z: 7 } }), false);
  assert.equal(sameBox(a, null), false);
  assert.equal(sameBox(null, null), true);
});

test('un coin manquant ne rend pas une boîte fausse', () => {
  assert.equal(boxFromCorners(null, { x: 0, y: 0, z: 0 }), null);
  assert.equal(clampBox(null, {}), null);
});
