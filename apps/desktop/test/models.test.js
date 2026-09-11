import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FACES, prepareModele, tableDesFormes, facesDesCubes, sourcesDesModeles,
} from '../src/renderer/viewport/models.js';
import { meshChunk, P } from '../src/renderer/viewport/mesher.js';

// Les blocs qui ne sont PAS des cubes. Ce qui s'y trompe en silence : l'ordre
// d'enroulement (une face à l'envers ne se voit qu'en tournant autour), les uv
// déduits (une dalle qui montre la texture entière écrasée), et le masquage par
// les voisins (un escalier qui creuse un trou dans le mur qu'il touche).

/** Un cuboïde plein, ses six faces sur la même texture. */
const cube = (from = [0, 0, 0], to = [16, 16, 16], tex = 'bois.png') => ({
  from, to, faces: Object.fromEntries(FACES.map((f) => [f, { texture: tex, uv: null, rotation: 0 }])),
});

const couche = () => {
  const vues = new Map();
  return (src) => {
    if (!src) return 0;
    if (!vues.has(src)) vues.set(src, vues.size + 1);
    return vues.get(src);
  };
};

test('un cuboïde plein rend six quads, dans l’ordre du mailleur', () => {
  const m = prepareModele([cube()], couche());
  assert.equal(m.count, 6);
  assert.deepEqual([...m.face], [0, 1, 2, 3, 4, 5]);
  // Toutes les positions tiennent dans le bloc, en unités de BLOC.
  for (const v of m.pos) assert.ok(v >= 0 && v <= 1, `${v} hors du bloc`);
});

test('chaque face regarde DEHORS — mesuré sur les triangles émis', () => {
  // L'ordre d'enroulement des six faces ne se recopie pas à la main : c'est six
  // occasions de se tromper, et une face à l'envers reste invisible tant qu'on
  // ne tourne pas autour du bloc. On maille donc un vrai bloc-modèle isolé et
  // on calcule la normale géométrique de chaque triangle.
  const shapes = [null, prepareModele([cube()], couche())];
  const ids = new Uint16Array(P * P * P);
  ids[(1 * P + 1) * P + 1] = 1;
  const out = meshChunk(ids, Uint8Array.from([0, 0]), Uint8Array.from([0, 0, 0, 9, 9, 9]), null, shapes);

  assert.equal(out.indices.length / 3, 12, 'six faces, douze triangles');

  const centre = [0.5, 0.5, 0.5];
  for (let t = 0; t < out.indices.length; t += 3) {
    const p = [0, 1, 2].map((k) => {
      const i = out.indices[t + k];
      return [out.positions[i * 3], out.positions[i * 3 + 1], out.positions[i * 3 + 2]];
    });
    const u = [0, 1, 2].map((k) => p[1][k] - p[0][k]);
    const v = [0, 1, 2].map((k) => p[2][k] - p[0][k]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    // Du centre du bloc vers un sommet du triangle : la normale doit aller
    // dans le même sens.
    const vers = [0, 1, 2].map((k) => p[0][k] - centre[k]);
    const dot = n[0] * vers[0] + n[1] * vers[1] + n[2] * vers[2];
    assert.ok(dot > 0, `triangle ${t / 3} à l’envers (produit scalaire ${dot})`);
  }
});

test('les uv DÉDUITS suivent les bornes du cuboïde', () => {
  // Une dalle montre la moitié BASSE de sa texture sur ses côtés, pas la
  // texture entière écrasée sur quatre pixels de haut. Le `v` de Minecraft
  // descend depuis le haut, d'où la moitié 0,5..1.
  const dalle = prepareModele([cube([0, 0, 0], [16, 8, 16])], couche());
  const uvDe = (nomFace) => {
    const q = [...dalle.face].indexOf(FACES.indexOf(nomFace));
    return [...dalle.uv.slice(q * 8, q * 8 + 8)];
  };
  const vs = uvDe('north').filter((_, i) => i % 2 === 1);
  assert.deepEqual([Math.min(...vs), Math.max(...vs)], [0.5, 1], 'le côté montre la moitié basse');

  // Le dessus d'une dalle est une face pleine : toute la texture.
  const dessus = uvDe('up');
  assert.deepEqual([Math.min(...dessus), Math.max(...dessus)], [0, 1]);
});

test('les uv DÉCLARÉS l’emportent sur les uv déduits', () => {
  const boite = cube([0, 0, 0], [16, 8, 16]);
  boite.faces.north.uv = [0, 0, 16, 16];
  const m = prepareModele([boite], couche());
  const q = [...m.face].indexOf(FACES.indexOf('north'));
  const vs = [...m.uv.slice(q * 8, q * 8 + 8)].filter((_, i) => i % 2 === 1);
  assert.deepEqual([Math.min(...vs), Math.max(...vs)], [0, 1]);
});

test('seule une face À RAS du bord peut être cachée', () => {
  // L'assise d'une chaise flotte au milieu du bloc : rien ne la cache jamais,
  // et la déclarer masquable la ferait disparaître contre un mur.
  const m = prepareModele([cube([2, 6, 2], [14, 8, 14])], couche());
  for (const c of m.cull) assert.equal(c, 255);

  const dalle = prepareModele([cube([0, 0, 0], [16, 8, 16])], couche());
  const cullDe = (nomFace) => dalle.cull[[...dalle.face].indexOf(FACES.indexOf(nomFace))];
  assert.equal(cullDe('down'), FACES.indexOf('down'), 'le dessous d’une dalle touche le bloc du dessous');
  assert.equal(cullDe('up'), 255, 'son dessus est au milieu du bloc');
  assert.equal(cullDe('north'), FACES.indexOf('north'), 'ses côtés touchent les bords en X/Z');
});

test('un voisin plein cache la face qui le touche, et elle seule', () => {
  const shapes = [null, prepareModele([cube([0, 0, 0], [16, 8, 16])], couche())];
  const poser = (voisin) => {
    const ids = new Uint16Array(P * P * P);
    const pose = (x, y, z, id) => { ids[((y + 1) * P + (z + 1)) * P + (x + 1)] = id; };
    pose(1, 1, 1, 1);                 // la dalle
    if (voisin) pose(1, 0, 1, 2);     // un cube plein juste dessous
    return ids;
  };
  const colors = new Uint8Array(3 * 3).fill(9);
  // Les quads du MODÈLE se comptent par leur couche d'atlas : la table
  // `id * 6 + face` est absente, donc tout ce que la passe gloutonne émet est
  // sur la couche 0. Compter par la géométrie confondait le dessus du cube
  // voisin avec le dessous de la dalle — ils sont au même endroit.
  const modele = (out) => {
    let n = 0;
    for (let q = 0; q < out.layers.length / 4; q++) if (out.layers[q * 4] !== 0) n++;
    return n;
  };

  const seul = meshChunk(poser(false), Uint8Array.from([0, 0, 1]), colors, null, shapes);
  const couvert = meshChunk(poser(true), Uint8Array.from([0, 0, 1]), colors, null, shapes);
  assert.equal(modele(seul), 6, 'les six faces de la dalle');
  assert.equal(modele(couvert), 5, 'exactement le dessous en moins');
});

test('la table des formes est indexée comme les VOXELS', () => {
  // L'identifiant d'un voxel est l'indice de palette PLUS UN : une table
  // indexée sur la palette donnerait à chaque bloc la forme de son voisin.
  const palette = [{ name: 'minecraft:stone' }, { name: 'minecraft:oak_stairs' }];
  const formes = {
    'minecraft:stone': { kind: 'cube', boxes: [cube()] },
    'minecraft:oak_stairs': { kind: 'model', boxes: [cube([0, 0, 0], [16, 8, 16])] },
  };
  const { shapes, transparents, modeles } = tableDesFormes(palette, formes, couche());
  assert.equal(modeles, 1);
  assert.equal(shapes[0], null, 'la case de l’air');
  assert.equal(shapes[1], null, 'la pierre est un cube : la passe gloutonne s’en charge');
  assert.ok(shapes[2], 'l’escalier a ses quads');
  assert.deepEqual(transparents, [2]);
});

test('sans aucun modèle, il n’y a pas de table du tout', () => {
  // `null` et non un tableau de `null` : c'est ce qui fait sauter la seconde
  // passe entière sur un build sans bloc non-cube — l'immense majorité.
  const palette = [{ name: 'minecraft:stone' }];
  const { shapes } = tableDesFormes(palette, { 'minecraft:stone': { kind: 'cube', boxes: [cube()] } }, couche());
  assert.equal(shapes, null);
});

test('l’atlas ne reçoit que les cubes, et toutes les textures sont chargées', () => {
  const formes = {
    'minecraft:stone': { kind: 'cube', boxes: [cube([0, 0, 0], [16, 16, 16], 'pierre.png')] },
    'minecraft:oak_stairs': { kind: 'model', boxes: [cube([0, 0, 0], [16, 8, 16], 'chene.png')] },
  };
  assert.deepEqual(Object.keys(facesDesCubes(formes)), ['minecraft:stone']);
  assert.deepEqual(Object.keys(facesDesCubes(formes)['minecraft:stone']).sort(), FACES.slice().sort());
  // Les textures des modèles ne passent pas par la table `id * 6 + face` : sans
  // cette liste, elles ne seraient jamais chargées et les escaliers sortiraient
  // en blanc.
  assert.deepEqual(sourcesDesModeles(formes), ['chene.png']);
});
