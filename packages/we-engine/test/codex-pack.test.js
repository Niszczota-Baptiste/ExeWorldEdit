import test from 'node:test';
import assert from 'node:assert/strict';
import { makeZip } from '../src/worldedit/zipWriter.js';
import {
  ouvreCodex, modeleDuBlocCodex, planModeleCodex, planIconeCodex, refVersFichier,
} from '../src/worldedit/codexPack.js';
import { FACES_CUBE } from '../src/worldedit/resourcePack.js';

// Le codex du site est une source de modèles DÉJÀ APLATIE : pas de chaîne de
// `parent`, pas de variables à résoudre d'un fichier à l'autre. Son contrat de
// sortie est celui de `planModele` — c'est ce qui permet à l'appelant d'essayer
// le pack de l'utilisateur puis le codex sans savoir lequel a répondu.
//
// Pas d'archive commitée pour ces tests : on la construit à la volée, comme les
// régions. Un .zip en dépôt serait opaque en revue.

const png = Buffer.from('89504e470d0a1a0a', 'hex'); // en-tête suffisant : on ne décode pas

function codex({ etats, modeles, textures = ['t.png'] }) {
  const entrees = [{ name: 'blockstates.json', data: Buffer.from(JSON.stringify(etats)) }];
  for (const [nom, m] of Object.entries(modeles)) {
    entrees.push({ name: `render-models/${nom}`, data: Buffer.from(JSON.stringify(m)) });
  }
  for (const t of textures) entrees.push({ name: `render-textures/${t}`, data: png });
  return ouvreCodex(makeZip(entrees));
}

const CUBE = (tex = '#all') => ({
  from: [0, 0, 0],
  to: [16, 16, 16],
  faces: Object.fromEntries(FACES_CUBE.map((f) => [f, { texture: tex }])),
});

test('la référence d’un modèle devient un nom de fichier, namespace compris', () => {
  assert.equal(refVersFichier('minefield:block/chaise'), 'block_chaise.json');
  assert.equal(refVersFichier('minecraft:block/stone'), 'block_stone.json');
  // Le codex est à plat : deux namespaces différents partagent le fichier. La
  // règle vient du site, la recopier autrement ferait diverger les deux.
  assert.equal(refVersFichier('block/stone'), 'block_stone.json');
  assert.equal(refVersFichier(null), 'block_.json');
});

test('un bloc du codex rend sa géométrie, avec les chemins de ses textures', () => {
  const c = codex({
    etats: { 'minefield:marbre': { type: 'variants', variants: { '': { model: 'minefield:block/marbre' } } } },
    modeles: { 'block_marbre.json': { textures: { all: 'marbre.png' }, elements: [CUBE()] } },
    textures: ['marbre.png'],
  });
  const m = planModeleCodex(c, 'minefield:marbre');
  assert.equal(m.kind, 'cube');
  assert.equal(m.boxes.length, 1);
  for (const f of FACES_CUBE) {
    assert.equal(m.boxes[0].faces[f].texture, 'render-textures/marbre.png', f);
  }
  assert.ok(c.lire('render-textures/marbre.png'), 'la texture est lisible dans l’archive');
});

test('un escalier reste un MODÈLE, un cube reste un cube', () => {
  const c = codex({
    etats: {
      'minefield:escalier': { type: 'variants', variants: { 'facing=east': { model: 'minefield:block/escalier' } } },
      'minefield:bloc': { type: 'variants', variants: { '': { model: 'minefield:block/bloc' } } },
    },
    modeles: {
      'block_escalier.json': {
        textures: { all: 't.png' },
        elements: [
          { from: [0, 0, 0], to: [16, 8, 16], faces: Object.fromEntries(FACES_CUBE.map((f) => [f, { texture: '#all' }])) },
          { from: [8, 8, 0], to: [16, 16, 16], faces: { up: { texture: '#all' }, west: { texture: '#all' } } },
        ],
      },
      'block_bloc.json': { textures: { all: 't.png' }, elements: [CUBE()] },
    },
  });
  assert.equal(planModeleCodex(c, 'minefield:escalier').kind, 'model');
  assert.equal(planModeleCodex(c, 'minefield:escalier').boxes.length, 2);
  assert.equal(planModeleCodex(c, 'minefield:bloc').kind, 'cube');
});

test('une décoration posée sur un cuboïde plein ne lui retire pas son opacité', () => {
  // La forme de `grass_block`, et la raison pour laquelle le mauvais critère
  // faisait mailler tout l'intérieur des terrains.
  const c = codex({
    etats: { 'minefield:herbe': { type: 'variants', variants: { '': { model: 'minefield:block/herbe' } } } },
    modeles: {
      'block_herbe.json': {
        textures: { all: 't.png' },
        elements: [CUBE(), { from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: '#all', tintindex: 0 } } }],
      },
    },
  });
  const m = planModeleCodex(c, 'minefield:herbe');
  assert.equal(m.kind, 'cube');
  assert.equal(m.boxes.length, 1, 'la décoration est laissée de côté');
});

test('`tintindex` remonte : sans lui, l’herbe du codex sortirait grise', () => {
  const c = codex({
    etats: { 'minefield:feuilles': { type: 'variants', variants: { '': { model: 'minefield:block/feuilles' } } } },
    modeles: {
      'block_feuilles.json': {
        textures: { all: 't.png' },
        elements: [{
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: { up: { texture: '#all', tintindex: 0 }, down: { texture: '#all' } },
        }],
      },
    },
  });
  const m = planModeleCodex(c, 'minefield:feuilles');
  assert.equal(m.boxes[0].faces.up.tint, true);
  assert.equal(m.boxes[0].faces.down.tint, false);
});

test('un multipart donne quand même un modèle', () => {
  const c = codex({
    etats: {
      'minefield:cloture': {
        type: 'multipart',
        multipart: [{ apply: { model: 'minefield:block/cloture_poteau' } }, { when: { north: 'true' }, apply: { model: 'minefield:block/cloture_cote' } }],
      },
    },
    modeles: { 'block_cloture_poteau.json': { textures: { all: 't.png' }, elements: [CUBE()] } },
  });
  assert.equal(modeleDuBlocCodex(c, 'minefield:cloture'), 'minefield:block/cloture_poteau');
  assert.ok(planModeleCodex(c, 'minefield:cloture'));
});

test('une variante peut être une LISTE : on prend la première', () => {
  const c = codex({
    etats: { 'minefield:x': { type: 'variants', variants: { '': [{ model: 'minefield:block/a' }, { model: 'minefield:block/b' }] } } },
    modeles: { 'block_a.json': { textures: { all: 't.png' }, elements: [CUBE()] } },
  });
  assert.equal(modeleDuBlocCodex(c, 'minefield:x'), 'minefield:block/a');
});

test('un bloc inconnu ne rend rien plutôt qu’une géométrie fausse', () => {
  const c = codex({ etats: {}, modeles: {} });
  assert.equal(planModeleCodex(c, 'minefield:fantome'), null);
  assert.equal(planIconeCodex(c, 'minefield:fantome'), null);
  assert.equal(c.ids().length, 0);
});

test('un modèle CITÉ mais absent de l’archive ne fait pas échouer le reste', () => {
  // Une archive tronquée ou un modèle oublié à l'extraction : le bloc n'a pas
  // d'icône, et c'est tout.
  const c = codex({
    etats: { 'minefield:x': { type: 'variants', variants: { '': { model: 'minefield:block/absent' } } } },
    modeles: {},
  });
  assert.equal(planModeleCodex(c, 'minefield:x'), null);
});

test('une archive illisible est refusée, pas devinée', () => {
  assert.throws(() => ouvreCodex(Buffer.from('pas un zip')), /codex_invalid/);
});

test('l’icône ne charge que les textures des faces VISIBLES', () => {
  const c = codex({
    etats: { 'minefield:m': { type: 'variants', variants: { '': { model: 'minefield:block/m' } } } },
    modeles: {
      'block_m.json': {
        textures: { all: 'a.png', cache: 'b.png' },
        elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#all' }, down: { texture: '#cache' } } }],
      },
    },
    textures: ['a.png', 'b.png'],
  });
  const ic = planIconeCodex(c, 'minefield:m');
  // `down` n'est pas une face visible en isométrie : sa texture ne doit pas
  // être citée. Le codex en contient quinze cents, l'icône en regarde trois.
  assert.ok(Object.values(ic.textures).includes('render-textures/a.png'));
  assert.equal(Object.values(ic.textures).includes('render-textures/b.png'), false);
});
