import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modeleDuBloc, aplatitModele, resoutTexture, estCubePlein, planIcone, planFaces, planModele,
  FACES_VUES, FACES_CUBE,
} from '../src/worldedit/resourcePack.js';

// Pas de pack de ressources dans le dépôt — on ne peut pas y embarquer les
// assets du jeu, et un .jar commité serait opaque en revue exactement comme un
// .mca. On construit donc un pack en mémoire, avec la même arborescence que
// celle de Minecraft.

/** Un pack minimal : un objet chemin → contenu, exposé comme `pack.read`. */
function pack(fichiers) {
  const m = new Map(Object.entries(fichiers).map(([k, v]) => [
    k, Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)),
  ]));
  return { read: (nom) => m.get(nom) || null };
}

const VANILLA = {
  // La chaîne complète d'un bloc plein ordinaire.
  'assets/minecraft/blockstates/stone.json': { variants: { '': { model: 'minecraft:block/stone' } } },
  'assets/minecraft/models/block/stone.json': { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } },
  'assets/minecraft/models/block/cube_all.json': { parent: 'block/cube', textures: { particle: '#all', down: '#all', up: '#all', north: '#all', east: '#all', south: '#all', west: '#all' } },
  'assets/minecraft/models/block/cube.json': {
    elements: [{
      from: [0, 0, 0], to: [16, 16, 16],
      faces: Object.fromEntries(['down', 'up', 'north', 'south', 'west', 'east'].map((f) => [f, { texture: `#${f}` }])),
    }],
  },
  // Un bloc dont les faces DIFFÈRENT : l'icône doit prendre la bonne par face.
  'assets/minecraft/blockstates/grass_block.json': { variants: { 'snowy=false': [{ model: 'minecraft:block/grass_block' }] } },
  'assets/minecraft/models/block/grass_block.json': {
    parent: 'block/cube',
    textures: { up: 'minecraft:block/grass_block_top', north: 'minecraft:block/grass_block_side', east: 'minecraft:block/grass_block_side', particle: 'minecraft:block/dirt' },
  },
};

test('le blockstate mène au modèle, variante par défaut', () => {
  const p = pack(VANILLA);
  assert.equal(modeleDuBloc(p, 'minecraft:stone'), 'minecraft:block/stone');
  assert.equal(modeleDuBloc(p, 'stone'), 'minecraft:block/stone', 'le namespace est sous-entendu');
  // Une variante peut être une LISTE (choix pondéré du jeu) : on prend la première.
  assert.equal(modeleDuBloc(p, 'minecraft:grass_block'), 'minecraft:block/grass_block');
  assert.equal(modeleDuBloc(p, 'minecraft:inexistant'), null);
});

test('un multipart donne quand même un modèle', () => {
  // Les clôtures et les murs n'ont pas de `variants` : leur icône doit exister
  // quand même.
  const p = pack({
    'assets/minecraft/blockstates/oak_fence.json': {
      multipart: [
        { apply: { model: 'minecraft:block/oak_fence_post' } },
        { when: { north: 'true' }, apply: { model: 'minecraft:block/oak_fence_side' } },
      ],
    },
  });
  assert.equal(modeleDuBloc(p, 'minecraft:oak_fence'), 'minecraft:block/oak_fence_post');
});

test('l’héritage s’aplatit, et l’ENFANT gagne', () => {
  const p = pack(VANILLA);
  const { textures, elements } = aplatitModele(p, 'minecraft:block/stone');
  assert.equal(textures.all, 'minecraft:block/stone');
  assert.equal(textures.up, '#all', 'la variable du parent est conservée');
  assert.ok(elements, 'les elements viennent du grand-parent');

  // L'enfant redéfinit `up` : le parent ne doit pas le réécrire en remontant.
  const { textures: t2 } = aplatitModele(p, 'minecraft:block/grass_block');
  assert.equal(t2.up, 'minecraft:block/grass_block_top');
  assert.equal(t2.north, 'minecraft:block/grass_block_side');
});

test('un parent cyclique ou manquant ne fait pas boucler', () => {
  const p = pack({
    'assets/minecraft/models/block/a.json': { parent: 'block/b', textures: { all: 'x' } },
    'assets/minecraft/models/block/b.json': { parent: 'block/a' },
  });
  const out = aplatitModele(p, 'block/a');
  assert.equal(out.textures.all, 'x');
  assert.equal(aplatitModele(p, 'block/nulle_part').elements, null);
});

test('une variable de texture se résout, même en chaîne', () => {
  const t = { all: 'minecraft:block/stone', up: '#all', dessus: '#up' };
  assert.equal(resoutTexture(t, 'all'), 'minecraft:block/stone');
  assert.equal(resoutTexture(t, 'up'), 'minecraft:block/stone');
  assert.equal(resoutTexture(t, 'dessus'), 'minecraft:block/stone', 'deux sauts');
  assert.equal(resoutTexture(t, 'absente'), null);
  // Une variable qui se pointe elle-même ne doit pas boucler.
  assert.equal(resoutTexture({ x: '#x' }, 'x'), null);
});

test('un cube plein est reconnu, et rien d’autre', () => {
  assert.equal(estCubePlein([{ from: [0, 0, 0], to: [16, 16, 16] }]), true);
  assert.equal(estCubePlein([{ from: [0, 0, 0], to: [16, 8, 16] }]), false, 'une dalle n’est pas un cube');
  assert.equal(estCubePlein([{ from: [0, 0, 0], to: [16, 16, 16] }, { from: [0, 0, 0], to: [2, 2, 2] }]), false);
  assert.equal(estCubePlein([]), false);
  assert.equal(estCubePlein(null), false);
});

test('plan d’un bloc plein : un cube, et ses textures par face', () => {
  const plan = planIcone(pack(VANILLA), 'minecraft:grass_block');
  assert.equal(plan.kind, 'cube');
  assert.equal(plan.elements.length, 1);
  // Les trois faces visibles pointent vers de VRAIS chemins de fichier.
  assert.equal(plan.textures['#up'], 'assets/minecraft/textures/block/grass_block_top.png');
  assert.equal(plan.textures['#north'], 'assets/minecraft/textures/block/grass_block_side.png');
  assert.equal(plan.textures['#east'], 'assets/minecraft/textures/block/grass_block_side.png');
});

test('un bloc minefield EN 3D garde sa forme', () => {
  // Le cas que l'atlas ne couvre pas : une chaise n'est pas un cube. La
  // dessiner en cube plein mentirait sur ce qu'on pose.
  const p = pack({
    'assets/minefield/blockstates/chaise.json': { variants: { 'facing=north': { model: 'minefield:block/chaise' } } },
    'assets/minefield/models/block/chaise.json': {
      textures: { bois: 'minefield:block/chene_taille' },
      elements: [
        // assise
        { from: [2, 6, 2], to: [14, 8, 14], faces: Object.fromEntries(FACES_VUES.map((f) => [f, { texture: '#bois' }])) },
        // dossier
        { from: [2, 8, 12], to: [14, 20, 14], faces: Object.fromEntries(FACES_VUES.map((f) => [f, { texture: '#bois' }])) },
        // un pied
        { from: [2, 0, 2], to: [4, 6, 4], faces: Object.fromEntries(FACES_VUES.map((f) => [f, { texture: '#bois' }])) },
      ],
    },
  });
  const plan = planIcone(p, 'minefield:chaise');
  assert.equal(plan.kind, 'model', 'PAS un cube : l’icône doit être dessinée par cuboïdes');
  assert.equal(plan.elements.length, 3, 'assise, dossier et pied sont conservés');
  assert.equal(plan.textures['#bois'], 'assets/minefield/textures/block/chene_taille.png');
  // Le namespace custom traverse intact — invariant n° 3, jusque dans l'icône.
  assert.ok(Object.values(plan.textures).every((t) => t.startsWith('assets/minefield/')));
});

test('un bloc absent du pack ne rend rien plutôt qu’une icône fausse', () => {
  assert.equal(planIcone(pack(VANILLA), 'minefield:inconnu'), null);
  assert.equal(planIcone(pack({}), 'minecraft:stone'), null);
});

test('un modèle sans elements hérite de la forme d’un cube', () => {
  // Beaucoup de packs ne déclarent que des textures et comptent sur `cube_all`.
  const p = pack({
    'assets/minefield/blockstates/brique.json': { variants: { '': { model: 'minefield:block/brique' } } },
    'assets/minefield/models/block/brique.json': { textures: { all: 'minefield:block/brique' } },
  });
  const plan = planIcone(p, 'minefield:brique');
  assert.equal(plan.kind, 'cube');
  assert.equal(plan.textures['#all'], 'assets/minefield/textures/block/brique.png');
});

test('les SIX faces sont résolues, pour le rendu du build', () => {
  // L'icône n'a besoin que des trois faces visibles ; le viewport les voit
  // toutes — on tourne autour d'un build.
  const p = pack(VANILLA);
  const f = planFaces(p, 'minecraft:grass_block');
  assert.deepEqual(Object.keys(f).sort(), FACES_CUBE.slice().sort());
  assert.equal(f.up, 'assets/minecraft/textures/block/grass_block_top.png');
  assert.equal(f.north, 'assets/minecraft/textures/block/grass_block_side.png');
  // `down` n'est pas dans les faces visibles d'une icône, mais un build a un
  // dessous — et il vaut `dirt` ici, pas l'herbe.
  assert.equal(f.down, 'assets/minecraft/textures/block/dirt.png');
});

test('une face sans texture propre prend celle du bloc', () => {
  // Le mailleur ne sait rendre que des cubes pleins : un escalier ou un quart
  // de bloc en est un pour lui, et il lui faut une réponse pour chaque face.
  const p = pack({
    'assets/minefield/blockstates/quart.json': { variants: { '': { model: 'minefield:block/quart' } } },
    'assets/minefield/models/block/quart.json': {
      textures: { all: 'minefield:block/muraille' },
      elements: [{ from: [0, 0, 0], to: [8, 8, 16], faces: { up: { texture: '#all' } } }],
    },
  });
  const f = planFaces(p, 'minefield:quart');
  assert.equal(Object.keys(f).length, FACES_CUBE.length, 'les six, pas seulement `up`');
  for (const face of FACES_CUBE) assert.equal(f[face], 'assets/minefield/textures/block/muraille.png');
});

test('un bloc absent du pack n’a pas de faces', () => {
  assert.equal(planFaces(pack(VANILLA), 'minefield:rien'), null);
});

// ── La géométrie complète, pour le viewport ─────────────────────────────────
//
// `planFaces` rend six textures et suppose un cube ; `planModele` rend la
// FORME. C'est la différence entre une volée d'escaliers qui monte et un mur.

const ESCALIER = {
  'assets/minecraft/blockstates/oak_stairs.json': { variants: { 'facing=east,half=bottom,shape=straight': { model: 'minecraft:block/oak_stairs' } } },
  'assets/minecraft/models/block/oak_stairs.json': {
    textures: { bottom: 'minecraft:block/oak_planks', top: 'minecraft:block/oak_planks', side: 'minecraft:block/oak_planks' },
    elements: [
      { from: [0, 0, 0], to: [16, 8, 16], faces: { down: { texture: '#bottom', uv: [0, 0, 16, 16] }, up: { texture: '#top' }, north: { texture: '#side' }, south: { texture: '#side' }, west: { texture: '#side' }, east: { texture: '#side' } } },
      { from: [8, 8, 0], to: [16, 16, 16], faces: { up: { texture: '#top' }, west: { texture: '#side', uv: [0, 0, 16, 8] }, east: { texture: '#side' }, north: { texture: '#side' }, south: { texture: '#side' } } },
    ],
  },
};

test('un escalier rend DEUX cuboïdes, pas un cube', () => {
  const m = planModele(pack(ESCALIER), 'minecraft:oak_stairs');
  assert.equal(m.kind, 'model');
  assert.equal(m.boxes.length, 2);
  assert.deepEqual(m.boxes[0].from, [0, 0, 0]);
  assert.deepEqual(m.boxes[0].to, [16, 8, 16], 'la marche basse fait la moitié de la hauteur');
  assert.deepEqual(m.boxes[1].from, [8, 8, 0]);
});

test('une face NON déclarée par un cuboïde n’est pas inventée', () => {
  // C'est ainsi qu'un modèle cache une face intérieure. La combler ferait
  // apparaître une paroi au milieu de l'escalier — invisible de l'extérieur,
  // mais payée en triangles sur tout un build.
  const m = planModele(pack(ESCALIER), 'minecraft:oak_stairs');
  assert.equal('down' in m.boxes[1].faces, false, 'le dessous de la marche haute est contre la basse');
  assert.equal(Object.keys(m.boxes[0].faces).length, 6);
});

test('les uv déclarés sont conservés, et l’absence se distingue de zéro', () => {
  // `uv` absent veut dire « déduis-le des bornes du cuboïde », pas « 0,0,0,0 ».
  // Confondre les deux fait afficher un point de texture étiré sur la face.
  const m = planModele(pack(ESCALIER), 'minecraft:oak_stairs');
  assert.deepEqual(m.boxes[0].faces.down.uv, [0, 0, 16, 16]);
  assert.equal(m.boxes[0].faces.up.uv, null);
  assert.deepEqual(m.boxes[1].faces.west.uv, [0, 0, 16, 8]);
});

test('un cube plein est classé cube, avec ses six faces texturées', () => {
  const m = planModele(pack(VANILLA), 'minecraft:grass_block');
  assert.equal(m.kind, 'cube');
  assert.equal(m.boxes.length, 1);
  assert.deepEqual(Object.keys(m.boxes[0].faces).sort(), FACES_CUBE.slice().sort());
  assert.equal(m.boxes[0].faces.up.texture, 'assets/minecraft/textures/block/grass_block_top.png');
  assert.equal(m.boxes[0].faces.down.texture, 'assets/minecraft/textures/block/dirt.png');
});

test('un modèle sans elements est un cube plein, pas un modèle vide', () => {
  const p = pack({
    'assets/minefield/blockstates/brique.json': { variants: { '': { model: 'minefield:block/brique' } } },
    'assets/minefield/models/block/brique.json': { textures: { all: 'minefield:block/brique' } },
  });
  const m = planModele(p, 'minefield:brique');
  assert.equal(m.kind, 'cube');
  assert.equal(m.boxes.length, 1);
  for (const f of FACES_CUBE) assert.equal(m.boxes[0].faces[f].texture, 'assets/minefield/textures/block/brique.png');
});

test('un cuboïde qui DÉBORDE du bloc est rendu tel quel', () => {
  // Minecraft autorise −16 à 32, et le dossier d'une chaise monte à 20. Serrer
  // sur 0..16 raboterait le dossier sans rien signaler.
  const p = pack({
    'assets/minefield/blockstates/chaise.json': { variants: { '': { model: 'minefield:block/chaise' } } },
    'assets/minefield/models/block/chaise.json': {
      textures: { bois: 'minefield:block/chene' },
      elements: [{ from: [2, 8, 12], to: [14, 20, 14], faces: { up: { texture: '#bois' } } }],
    },
  });
  const m = planModele(p, 'minefield:chaise');
  assert.equal(m.kind, 'model');
  assert.deepEqual(m.boxes[0].to, [14, 20, 14]);
  assert.equal(m.boxes[0].faces.up.texture, 'assets/minefield/textures/block/chene.png');
});

test('un bloc absent du pack n’a pas de géométrie', () => {
  assert.equal(planModele(pack(VANILLA), 'minefield:rien'), null);
});
