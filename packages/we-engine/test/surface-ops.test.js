import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryVolume, opCenter, opSnow, opThaw, opGreen, opFlora, opExtinguish, opFixLiquid,
} from '../src/worldedit/transform.js';

// Le lot « surface » de WorldEdit : //center, //snow, //thaw, //green, //flora,
// //extinguish, //fixwater. Elles travaillent toutes sur le bloc le plus haut
// de chaque colonne — le geste qu'on répète après avoir sculpté un relief.

const B = (n) => ({ Name: `minecraft:${n}`, Properties: null });
const nom = (v, x, y, z) => (v.getBlock(x, y, z)?.Name || 'minecraft:air').replace('minecraft:', '');

/** Un terrain plat : sol en `sol` à y = 0, du vide au-dessus. */
function terrain(sol = 'grass_block', w = 4, h = 6) {
  const v = new MemoryVolume();
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) v.setBlock(x, 0, z, B(sol));
  return { v, sel: { min: { x: 0, y: 0, z: 0 }, max: { x: w - 1, y: h, z: w - 1 } } };
}

// ── //center ────────────────────────────────────────────────────────────────

test('le centre d’une sélection IMPAIRE est un seul bloc', () => {
  const v = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } };
  const r = opCenter(v, sel, { block: { name: 'minecraft:gold_block' } });
  assert.equal(r.blocksChanged, 1);
  assert.equal(nom(v, 2, 2, 2), 'gold_block');
});

test('le centre d’une sélection PAIRE est huit blocs', () => {
  // Le centre d'une longueur paire tombe entre deux cases. Arrondir d'un côté
  // décalerait tout ce qu'on bâtit ensuite en symétrie — WorldEdit pose les
  // deux, et c'est ce qui en fait un repère utilisable.
  const v = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  const r = opCenter(v, sel, { block: { name: 'minecraft:gold_block' } });
  assert.equal(r.blocksChanged, 8);
  assert.deepEqual(r.bounds.min, { x: 0, y: 0, z: 0 });
  assert.deepEqual(r.bounds.max, { x: 1, y: 1, z: 1 });
});

test('les bounds du centre couvrent ce qui a été écrit, pas la sélection', () => {
  // L'instantané d'annulation ET l'aperçu incrémental s'y fient : des bounds
  // trop larges coûtent, des bounds trop étroits perdent des blocs.
  const v = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
  const r = opCenter(v, sel, { block: { name: 'minecraft:stone' } });
  assert.deepEqual(r.bounds.min, { x: 5, y: 5, z: 5 });
  assert.deepEqual(r.bounds.max, { x: 5, y: 5, z: 5 });
});

// ── //snow et //thaw ────────────────────────────────────────────────────────

test('la neige se pose sur la surface, pas dedans', () => {
  const { v, sel } = terrain();
  const r = opSnow(v, sel);
  assert.equal(r.blocksChanged, 16);
  assert.equal(nom(v, 1, 1, 1), 'snow');
  assert.equal(nom(v, 1, 0, 1), 'grass_block', 'le sol est intact');
});

test('la neige ne se pose PAS sur ce qui ne la retient pas', () => {
  // Feuilles, verre, dalles : en jeu la neige tombe. Poser quand même donne un
  // build qui perd sa neige au premier chargement — un défaut qui ne se voit
  // qu'une fois en ligne.
  for (const sol of ['oak_leaves', 'glass', 'stone_slab', 'oak_fence']) {
    const { v, sel } = terrain(sol);
    assert.equal(opSnow(v, sel).blocksChanged, 0, sol);
  }
});

test('la neige GÈLE l’eau au lieu de se poser dessus', () => {
  const { v, sel } = terrain('water');
  opSnow(v, sel);
  assert.equal(nom(v, 1, 0, 1), 'ice');
  assert.equal(nom(v, 1, 1, 1), 'air', 'pas de neige par-dessus la glace');
});

test('dégeler défait enneiger', () => {
  const { v, sel } = terrain();
  opSnow(v, sel);
  const r = opThaw(v, sel);
  assert.equal(r.blocksChanged, 16);
  for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) assert.equal(nom(v, x, 1, z), 'air');
});

test('dégeler refond la glace en eau', () => {
  const { v, sel } = terrain('ice');
  opThaw(v, sel);
  assert.equal(nom(v, 0, 0, 0), 'water');
});

// ── //green ─────────────────────────────────────────────────────────────────

test('reverdir ne touche QUE la terre exposée', () => {
  const v = new MemoryVolume();
  v.setBlock(0, 0, 0, B('dirt'));
  v.setBlock(1, 0, 0, B('stone'));
  v.setBlock(2, 0, 0, B('dirt'));
  v.setBlock(2, 1, 0, B('stone'));   // de la terre SOUS quelque chose
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 4, z: 0 } };
  const r = opGreen(v, sel);
  assert.equal(r.blocksChanged, 1);
  assert.equal(nom(v, 0, 0, 0), 'grass_block');
  assert.equal(nom(v, 1, 0, 0), 'stone', 'la pierre n’est pas de la terre');
  assert.equal(nom(v, 2, 0, 0), 'dirt', 'la terre couverte reste de la terre');
});

// ── //flora ─────────────────────────────────────────────────────────────────

test('la flore est REJOUABLE à graine égale', () => {
  // Invariant n° 4. Le tirage se hache sur la position, donc deux exécutions
  // donnent exactement le même semis.
  const lire = () => {
    const { v, sel } = terrain('grass_block', 12);
    opFlora(v, sel, { preset: 'plaine', density: 40, seed: 99 });
    const out = [];
    for (let z = 0; z < 12; z++) for (let x = 0; x < 12; x++) out.push(nom(v, x, 1, z));
    return out;
  };
  const a = lire();
  assert.deepEqual(lire(), a);
  assert.ok(a.some((n) => n !== 'air'), 'quelque chose a poussé');
});

test('deux graines différentes sèment différemment', () => {
  const semis = (seed) => {
    const { v, sel } = terrain('grass_block', 12);
    opFlora(v, sel, { preset: 'plaine', density: 40, seed });
    const out = [];
    for (let z = 0; z < 12; z++) for (let x = 0; x < 12; x++) out.push(nom(v, x, 1, z));
    return out.join(' ');
  };
  assert.notEqual(semis(1), semis(2));
});

test('la densité pilote la QUANTITÉ, pas l’espèce', () => {
  // Deux tirages indépendants sur la même case : un seul ferait que les fleurs
  // rares n'apparaîtraient qu'aux densités élevées.
  const compte = (density) => {
    const { v, sel } = terrain('grass_block', 16);
    return opFlora(v, sel, { preset: 'plaine', density, seed: 7 }).blocksChanged;
  };
  const bas = compte(10);
  const haut = compte(80);
  assert.ok(haut > bas * 3, `densité 80 (${haut}) doit largement dépasser 10 (${bas})`);
});

test('la flore ne pousse que sur un sol qui le permet, et dans le vide', () => {
  const { v, sel } = terrain('stone', 8);
  assert.equal(opFlora(v, sel, { preset: 'plaine', density: 100, seed: 3 }).blocksChanged, 0);

  // De l'herbe, mais couverte : rien ne pousse dans un plafond.
  const { v: v2, sel: s2 } = terrain('grass_block', 8);
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) v2.setBlock(x, 1, z, B('stone'));
  assert.equal(opFlora(v2, s2, { preset: 'plaine', density: 100, seed: 3 }).blocksChanged, 0);
});

// ── //extinguish ────────────────────────────────────────────────────────────

test('éteindre retire le feu et lui seul', () => {
  const v = new MemoryVolume();
  v.setBlock(0, 0, 0, B('fire'));
  v.setBlock(1, 0, 0, B('soul_fire'));
  v.setBlock(2, 0, 0, B('campfire'));
  const r = opExtinguish(v, { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } });
  assert.equal(r.blocksChanged, 2);
  assert.equal(nom(v, 2, 0, 0), 'campfire', 'un feu de camp est un BLOC, pas des flammes');
});

// ── //fixwater ──────────────────────────────────────────────────────────────

test('mettre à niveau remplit jusqu’au liquide le plus haut', () => {
  // Un bassin creusé en marches : l'eau existante est à y = 2 d'un côté, le
  // trou descend à y = 0.
  const v = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 3, z: 0 } };
  for (let x = 0; x <= 3; x++) v.setBlock(x, -1, 0, B('stone'));   // le fond
  v.setBlock(0, 0, 0, B('water'));
  v.setBlock(0, 1, 0, B('water'));
  v.setBlock(0, 2, 0, B('water'));
  const r = opFixLiquid(v, sel, { liquid: 'water' });
  assert.ok(r.blocksChanged > 0);
  for (let x = 0; x <= 3; x++) {
    for (let y = 0; y <= 2; y++) assert.equal(nom(v, x, y, 0), 'water', `${x},${y}`);
    assert.equal(nom(v, x, 3, 0), 'air', 'rien au-dessus du niveau');
  }
});

test('mettre à niveau ne NOIE pas ce qui est fermé', () => {
  // Une maison dans la sélection ne doit pas se remplir : le remplissage part
  // des liquides existants et se propage de proche en proche.
  const v = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 2, z: 0 } };
  v.setBlock(0, 0, 0, B('water'));
  // un mur étanche en x = 3, sur toute la hauteur
  for (let y = 0; y <= 2; y++) v.setBlock(3, y, 0, B('stone'));
  opFixLiquid(v, sel, { liquid: 'water' });
  assert.equal(nom(v, 2, 0, 0), 'water', 'avant le mur, ça se remplit');
  assert.equal(nom(v, 4, 0, 0), 'air', 'derrière le mur, non');
});

test('sans liquide dans la sélection, il n’y a rien à mettre à niveau', () => {
  const { v, sel } = terrain();
  assert.equal(opFixLiquid(v, sel, { liquid: 'water' }).blocksChanged, 0);
});

test('la lave se met à niveau comme l’eau', () => {
  const v = new MemoryVolume();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 0 } };
  v.setBlock(0, 0, 0, B('lava'));
  opFixLiquid(v, sel, { liquid: 'lava' });
  assert.equal(nom(v, 2, 0, 0), 'lava');
});

// ── L'état par défaut ne s'écrit pas ────────────────────────────────────────

test('reverdir écrit la MÊME herbe que naturaliser', () => {
  // `snowy=false` est l'état par défaut de `grass_block`. L'écrire explicitement
  // crée une SECONDE entrée de palette pour le même bloc : mesuré sur la vallée
  // de démonstration, 29 374 herbes d'un côté et 113 de l'autre. La palette se
  // dédouble, et un « remplacer » qui vise un état exact en rate la moitié.
  const v = new MemoryVolume();
  v.setBlock(0, 0, 0, B('dirt'));
  opGreen(v, { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 2, z: 0 } });
  const herbe = v.getBlock(0, 0, 0);
  assert.equal(herbe.Name, 'minecraft:grass_block');
  assert.equal(herbe.Properties, null, 'l’état par défaut ne s’écrit pas');
});

test('la neige non plus n’écrit pas son état par défaut', () => {
  const { v, sel } = terrain();
  opSnow(v, sel);
  assert.equal(v.getBlock(0, 1, 0).Properties, null);
});

test('aucune opération de surface n’ajoute une entrée de palette en double', () => {
  // Le test qui aurait attrapé le défaut tout seul : on pose de l'herbe « nue »,
  // on reverdit à côté, et on compte les FORMES distinctes écrites.
  const v = new MemoryVolume();
  v.setBlock(0, 0, 0, B('grass_block'));
  v.setBlock(1, 0, 0, B('dirt'));
  opGreen(v, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 0 } });
  const formes = new Set([0, 1].map((x) => JSON.stringify(v.getBlock(x, 0, 0))));
  assert.equal(formes.size, 1, `deux herbes différentes : ${[...formes].join(' vs ')}`);
});
