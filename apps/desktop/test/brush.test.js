import test from 'node:test';
import assert from 'node:assert/strict';
import {
  voxelFromHit, brushPositions, positionsBounds, lineBetween, Stroke, MAX_RADIUS, BRUSH_SHAPES, BRUSH_MODES,
} from '../src/renderer/viewport/brush.js';

// Le pinceau n'a que deux décisions à prendre, et toutes deux se voient
// immédiatement quand elles sont fausses : de quel côté de la face on pose, et
// combien de cases part une brosse.

test('poser va DEHORS, effacer va DEDANS', () => {
  // Un rayon touche un plan entre deux cases : le point d'impact est pile sur
  // la frontière, et `Math.floor` y tombe d'un côté ou de l'autre selon
  // l'arrondi. C'est la différence entre poser un bloc sur la table et
  // remplacer la table.
  const point = { x: 5, y: 10, z: 3.5 };   // face supérieure du bloc (5, 9, 3)
  const normal = { x: 0, y: 1, z: 0 };
  assert.deepEqual(voxelFromHit(point, normal, 'paint'), { x: 5, y: 10, z: 3 });
  assert.deepEqual(voxelFromHit(point, normal, 'erase'), { x: 5, y: 9, z: 3 });
  assert.deepEqual(voxelFromHit(point, normal, 'replace'), { x: 5, y: 9, z: 3 });
});

test('chaque face donne la bonne case', () => {
  const cas = [
    [{ x: 4, y: 2.5, z: 7.5 }, { x: -1, y: 0, z: 0 }, { x: 3, y: 2, z: 7 }, { x: 4, y: 2, z: 7 }],
    [{ x: 5, y: 2.5, z: 7.5 }, { x: 1, y: 0, z: 0 }, { x: 5, y: 2, z: 7 }, { x: 4, y: 2, z: 7 }],
    [{ x: 4.5, y: 2.5, z: 7 }, { x: 0, y: 0, z: -1 }, { x: 4, y: 2, z: 6 }, { x: 4, y: 2, z: 7 }],
  ];
  for (const [p, n, dehors, dedans] of cas) {
    assert.deepEqual(voxelFromHit(p, n, 'paint'), dehors, `pose ${JSON.stringify(n)}`);
    assert.deepEqual(voxelFromHit(p, n, 'erase'), dedans, `efface ${JSON.stringify(n)}`);
  }
});

test('une brosse de rayon 0 ne touche qu’une case', () => {
  const p = brushPositions({ x: 3, y: 4, z: 5 }, { radius: 0 });
  assert.deepEqual([...p], [3, 4, 5]);
});

test('la sphère est ronde, le cube est plein', () => {
  const sphere = brushPositions({ x: 0, y: 0, z: 0 }, { shape: 'sphere', radius: 3 });
  const cube = brushPositions({ x: 0, y: 0, z: 0 }, { shape: 'cube', radius: 3 });
  assert.equal(cube.length / 3, 7 * 7 * 7, 'le cube couvre tout');
  assert.ok(sphere.length < cube.length, 'la sphère en couvre moins');
  // Le coin du cube est loin du centre : il ne doit pas être dans la sphère.
  const dans = (p, x, y, z) => {
    for (let i = 0; i < p.length; i += 3) if (p[i] === x && p[i + 1] === y && p[i + 2] === z) return true;
    return false;
  };
  assert.equal(dans(cube, 3, 3, 3), true);
  assert.equal(dans(sphere, 3, 3, 3), false, 'le coin sort de la boule');
  assert.equal(dans(sphere, 3, 0, 0), true, 'mais le bout de l’axe y est');
});

test('le disque est plat : une seule couche', () => {
  const d = brushPositions({ x: 0, y: 7, z: 0 }, { shape: 'disc', radius: 4 });
  for (let i = 1; i < d.length; i += 3) assert.equal(d[i], 7, 'toutes les cases au même Y');
  assert.ok(d.length / 3 > 40);
});

test('ce qui sort des limites est coupé ICI', () => {
  // Une case hors limites n'est pas « ignorée par le moteur » : elle ferait
  // refuser la commande entière.
  const limits = { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } };
  const p = brushPositions({ x: 0, y: 0, z: 0 }, { shape: 'cube', radius: 3, limits });
  assert.equal(p.length / 3, 4 * 4 * 4, 'seul le quart dans les limites');
  for (let i = 0; i < p.length; i += 3) {
    assert.ok(p[i] >= 0 && p[i + 1] >= 0 && p[i + 2] >= 0);
  }
});

test('le rayon est borné', () => {
  const p = brushPositions({ x: 0, y: 0, z: 0 }, { shape: 'cube', radius: 9999 });
  assert.equal(Math.cbrt(p.length / 3), MAX_RADIUS * 2 + 1);
});

test('un trait ne compte pas deux fois la même case', () => {
  // Les brosses d'un trait se recouvrent largement. Sans dédoublonnage, le
  // moteur compterait plusieurs fois les mêmes blocs — et « N blocs changés »
  // est la seule chose que l'utilisateur lit.
  const s = new Stroke();
  s.add(brushPositions({ x: 0, y: 0, z: 0 }, { shape: 'cube', radius: 1 }));
  assert.equal(s.size, 27);
  s.add(brushPositions({ x: 0, y: 0, z: 0 }, { shape: 'cube', radius: 1 }));
  assert.equal(s.size, 27, 'la même brosse deux fois ne change rien');
  s.add(brushPositions({ x: 1, y: 0, z: 0 }, { shape: 'cube', radius: 1 }));
  assert.equal(s.size, 27 + 9, 'un pas de côté n’ajoute qu’une tranche');
});

test('le trait distingue les coordonnées négatives', () => {
  // La clé entière ne doit pas faire collisionner (−1, 0, 0) et (0, 0, −1) :
  // le bloc −1 est un bloc comme un autre.
  const s = new Stroke();
  s.add(Int32Array.from([-1, 0, 0, 0, 0, -1, 0, -1, 0, 1, 0, 0]));
  assert.equal(s.size, 4);
});

test('les bornes d’un trait couvrent tout ce qu’il touche', () => {
  const b = positionsBounds(Int32Array.from([3, 4, 5, -2, 9, 0]));
  assert.deepEqual(b, { min: { x: -2, y: 4, z: 0 }, max: { x: 3, y: 9, z: 5 } });
  assert.equal(positionsBounds(Int32Array.from([])), null);
  assert.equal(positionsBounds(null), null);
});

test('formes et modes sont déclarés avec leur étiquette', () => {
  for (const s of BRUSH_SHAPES) assert.ok(s.id && s.label);
  for (const m of BRUSH_MODES) assert.ok(m.id && m.label && m.aide);
});

test('un trait RELIE deux brosses successives', () => {
  // La souris n'envoie qu'une poignée de positions par seconde : à vitesse
  // normale, deux brosses consécutives sont à dix blocs l'une de l'autre. Sans
  // interpolation, un trait est une suite de taches — un tampon, pas un pinceau.
  const l = lineBetween({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 });
  assert.deepEqual(l.map((p) => p.x), [0, 1, 2, 3, 4, 5]);

  // Aucune case sautée sur une diagonale : chaque pas avance d'au plus un bloc.
  const d = lineBetween({ x: 0, y: 0, z: 0 }, { x: 7, y: 3, z: -4 });
  for (let i = 1; i < d.length; i++) {
    const dx = Math.abs(d[i].x - d[i - 1].x), dy = Math.abs(d[i].y - d[i - 1].y), dz = Math.abs(d[i].z - d[i - 1].z);
    assert.ok(Math.max(dx, dy, dz) <= 1, `saut entre ${JSON.stringify(d[i - 1])} et ${JSON.stringify(d[i])}`);
  }
  assert.deepEqual(d[0], { x: 0, y: 0, z: 0 });
  assert.deepEqual(d[d.length - 1], { x: 7, y: 3, z: -4 });
});

test('un saut démesuré ne trace pas une barre en travers du build', () => {
  // Le curseur quitte le build et y revient ailleurs : relier les deux
  // peindrait une ligne à travers tout ce qu'il y a entre.
  const l = lineBetween({ x: 0, y: 0, z: 0 }, { x: 2000, y: 0, z: 0 });
  assert.deepEqual(l, [{ x: 2000, y: 0, z: 0 }]);
});

test('une brosse qui ne bouge pas ne se répète pas', () => {
  assert.deepEqual(lineBetween({ x: 3, y: 4, z: 5 }, { x: 3, y: 4, z: 5 }), [{ x: 3, y: 4, z: 5 }]);
});
