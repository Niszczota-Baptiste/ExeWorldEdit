import test from 'node:test';
import assert from 'node:assert/strict';
import { facteurTeinte, tableDesTeintes } from '../src/renderer/viewport/tint.js';
import { moyenneTuile, FACES } from '../src/renderer/viewport/atlas.js';
import { meshChunk, P } from '../src/renderer/viewport/mesher.js';

// Les textures teintées du jeu sont GRISES. Mesuré dans le codex du site :
// `grass_block_top.png` vaut (147, 147, 147) et `oak_leaves.png` (97, 97, 97).
// C'est le jeu qui les multiplie par une couleur de biome, ce que la face
// signale avec `tintindex`. Ignorer l'indication donnait un sol blanchâtre sur
// tout terrain — la texture s'affichait, simplement pas de la bonne couleur.

const GRIS_HERBE = [147, 147, 147];   // moyenne réelle de grass_block_top.png
const VERT_HERBE = [116, 156, 74];    // couleur de carte du bloc

test('une texture grise teintée rend en moyenne la couleur voulue', () => {
  const f = facteurTeinte(VERT_HERBE, GRIS_HERBE);
  const rendu = [0, 1, 2].map((k) => Math.round((GRIS_HERBE[k] * f[k]) / 255));
  for (let k = 0; k < 3; k++) {
    // Une teinte est une MULTIPLICATION : elle ne peut qu'assombrir. Quand la
    // couleur visée est plus claire que la texture (ici le vert, 156 contre
    // 147), le facteur sature et on s'arrête à la texture — c'est la même
    // limite que dans le jeu, dont les couleurs de sommet vont aussi de 0 à 1.
    const plafond = Math.min(VERT_HERBE[k], GRIS_HERBE[k]);
    assert.ok(Math.abs(rendu[k] - plafond) <= 2, `canal ${k} : ${rendu[k]} ≠ ${plafond}`);
  }
  // L'essentiel : ce n'était plus du gris.
  assert.ok(rendu[1] > rendu[0] && rendu[1] > rendu[2], 'l’herbe est verte');
});

test('une teinte ne peut jamais ÉCLAIRCIR', () => {
  // Le facteur est une couleur de sommet, donc au plus 1. Un test qui exigerait
  // l'inverse demanderait l'impossible — et le premier l'a fait.
  const f = facteurTeinte([255, 255, 255], [40, 40, 40]);
  for (const c of f) assert.ok(c <= 255);
});

test('multiplier bêtement par la couleur du bloc donnerait deux fois trop sombre', () => {
  // C'est la solution évidente, et elle est fausse : la texture vaut déjà ~0,58
  // en moyenne. Ce test fige la raison d'être de la division.
  const naif = [0, 1, 2].map((k) => Math.round((GRIS_HERBE[k] * VERT_HERBE[k]) / 255));
  assert.ok(naif[1] < VERT_HERBE[1] * 0.75, `le vert naïf (${naif[1]}) est bien trop sombre`);
});

test('une tuile noire ou illisible ne teinte rien plutôt que de tout blanchir', () => {
  // Diviser par zéro donnerait un facteur infini, donc une face blanche.
  assert.deepEqual(facteurTeinte(VERT_HERBE, [0, 0, 0]), [255, 255, 255]);
  assert.deepEqual(facteurTeinte(VERT_HERBE, null), [255, 255, 255]);
});

test('le facteur est plafonné : une teinte n’est pas une correction d’exposition', () => {
  // Une texture très sombre demanderait un facteur énorme, et les pixels clairs
  // satureraient en blanc.
  const f = facteurTeinte([255, 255, 255], [8, 8, 8]);
  for (const c of f) assert.ok(c <= 255);
  assert.ok(f[0] >= 200, 'mais il reste franc');
});

test('la moyenne ignore les pixels TRANSPARENTS', () => {
  // Une feuille est aux trois quarts transparente : compter ses trous ferait
  // tendre la moyenne vers le noir, et la teinte exploserait pour compenser.
  const px = new Uint8ClampedArray(4 * 4);
  px.set([200, 100, 50, 255], 0);      // un pixel opaque
  px.set([0, 0, 0, 0], 4);             // trois pixels transparents
  px.set([0, 0, 0, 0], 8);
  px.set([0, 0, 0, 0], 12);
  assert.deepEqual(moyenneTuile(px), [200, 100, 50]);
});

test('la table des teintes est indexée comme les VOXELS', () => {
  const palette = [{ name: 'minecraft:stone' }, { name: 'minecraft:grass_block' }];
  const face = (tex, tint) => ({ texture: tex, uv: null, rotation: 0, tint });
  const formes = {
    'minecraft:stone': { kind: 'cube', boxes: [{ faces: Object.fromEntries(FACES.map((f) => [f, face('pierre.png', false)])) }] },
    'minecraft:grass_block': {
      kind: 'cube',
      boxes: [{ faces: { ...Object.fromEntries(FACES.map((f) => [f, face('cote.png', false)])), up: face('dessus.png', true) } }],
    },
  };
  const t = tableDesTeintes(palette, formes, () => VERT_HERBE, () => GRIS_HERBE, FACES);
  const at = (i, nomFace) => [0, 1, 2].map((k) => t[((i * 6) + FACES.indexOf(nomFace)) * 3 + k]);

  // id 2 = l'herbe (indice 1 + 1). Seul son DESSUS est teinté.
  assert.notDeepEqual(at(2, 'up'), [255, 255, 255], 'le dessus de l’herbe est teinté');
  assert.deepEqual(at(2, 'north'), [255, 255, 255], 'ses côtés ne le sont pas');
  assert.deepEqual(at(1, 'up'), [255, 255, 255], 'la pierre n’est jamais teintée');
  assert.deepEqual(at(0, 'up'), [255, 255, 255], 'la case de l’air reste neutre');
});

test('sans aucune face teintée, il n’y a pas de table', () => {
  // Le mailleur saute alors la branche entière, et le rendu est au bit près
  // celui d'avant — c'est l'immense majorité des builds.
  const palette = [{ name: 'minecraft:stone' }];
  const formes = { 'minecraft:stone': { kind: 'cube', boxes: [{ faces: { up: { texture: 'p.png', tint: false } } }] } };
  assert.equal(tableDesTeintes(palette, formes, () => VERT_HERBE, () => GRIS_HERBE, FACES), null);
});

test('le mailleur applique le facteur, et seulement sur la face teintée', () => {
  const ids = new Uint16Array(P * P * P);
  ids[(1 * P + 1) * P + 1] = 1;
  const layers = new Uint16Array(2 * 6).fill(3);        // tout est texturé
  const tints = new Uint8Array(2 * 6 * 3).fill(255);
  const iUp = FACES.indexOf('up');
  tints.set([40, 80, 20], (6 + iUp) * 3);               // seul le dessus est teinté

  const out = meshChunk(ids, Uint8Array.from([0, 1]), Uint8Array.from([0, 0, 0, 9, 9, 9]), layers, null, tints);

  // On retrouve chaque quad par la direction de sa normale, comme le fait le
  // test d'ordre des faces de l'atlas.
  const couleurs = {};
  for (let q = 0; q < out.positions.length / 12; q++) {
    const a = (c, k) => out.positions[(q * 4 + c) * 3 + k];
    const plat = (k) => [0, 1, 2, 3].every((c) => a(c, k) === a(0, k));
    let dir = null;
    if (plat(1)) dir = a(0, 1) === 1 ? 'up' : 'down';
    else if (plat(0)) dir = a(0, 0) === 1 ? 'east' : 'west';
    else dir = a(0, 2) === 1 ? 'south' : 'north';
    couleurs[dir] = [0, 1, 2].map((k) => out.colors[q * 12 + k]);
  }
  // Le dessus n'est pas à plein blanc : le facteur l'a assombri et verdi.
  assert.ok(couleurs.up[0] < couleurs.up[1], 'le dessus tire vers le vert');
  assert.ok(couleurs.up[0] < 200, 'et il est nettement moins clair que le blanc');
  // Un côté non teinté ne porte QUE l'ombrage : ses trois canaux restent égaux.
  assert.equal(couleurs.north[0], couleurs.north[1]);
  assert.equal(couleurs.north[1], couleurs.north[2]);
});
