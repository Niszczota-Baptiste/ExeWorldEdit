import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeBox, opSphere, opCyl } from '../src/worldedit/transform.js';
import { RegionStore } from '../src/worldedit/regionStore.js';
import { blankRegions } from '../src/staging/blank.js';

// La PORTÉE d'une opération : ce qu'elle doit voir décodé pour s'exécuter.
//
// Le moteur chauffait l'emprise du BUILD ENTIER avant chaque opération, et les
// formes parcouraient la SÉLECTION ENTIÈRE pour écrire dans une bulle. Mesuré
// chez un utilisateur, sélection « tout le build » de 413 millions de cases :
// une sphère de 62 blocs prenait 5,2 secondes, dont 47 % à décoder des chunks
// qu'on ne lisait jamais et 52 % à recoller l'aperçu entier.
//
// Réduire ces zones n'est sûr QUE parce qu'une lecture hors zone décodée lève
// désormais `cold_read` au lieu de rendre de l'air. Ces tests figent les deux
// moitiés : la portée est juste, et la violer est bruyante.

const BOX = (x0, y0, z0, x1, y1, z1) => ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });

// ── La boîte d'une forme ────────────────────────────────────────────────────

test('la boîte d’une sphère dépend du RAYON, pas de la sélection', () => {
  // C'est tout le problème en une assertion : la même sphère dans une sélection
  // mille fois plus grande occupe exactement la même boîte.
  const petite = shapeBox(BOX(0, 0, 0, 20, 20, 20), { radius: 3 });
  const enorme = shapeBox(BOX(-500, -500, -500, 520, 520, 520), { radius: 3 });
  const cote = (b, k) => b.max[k] - b.min[k] + 1;
  for (const k of ['x', 'y', 'z']) {
    assert.equal(cote(petite, k), cote(enorme, k), `axe ${k}`);
    assert.ok(cote(petite, k) <= 2 * 3 + 3, `axe ${k} : ${cote(petite, k)} cases pour un rayon 3`);
  }
});

test('la boîte reste SERRÉE dans la sélection', () => {
  // Une sphère plus grande que la sélection ne doit pas déborder : l'opération
  // n'a le droit d'écrire que dans ce qu'on lui a désigné.
  const sel = BOX(0, 0, 0, 4, 4, 4);
  const box = shapeBox(sel, { radius: 50 });
  assert.deepEqual(box.min, sel.min);
  assert.deepEqual(box.max, sel.max);
});

test('un cylindre garde la HAUTEUR de la sélection', () => {
  const sel = BOX(0, 0, 0, 100, 60, 100);
  const box = shapeBox(sel, { radius: 4 }, true);
  assert.equal(box.min.y, 0);
  assert.equal(box.max.y, 60, 'la hauteur n’est pas bornée par le rayon');
  assert.ok(box.max.x - box.min.x + 1 <= 11, 'mais X l’est');
});

// ── Ce que les formes DÉCLARENT écrire ──────────────────────────────────────

/** Un store réel, sur une région vierge — le vrai chemin, pas un faux volume. */
async function store(bbox) {
  const s = new RegionStore(blankRegions({
    origin: { x: 0, y: 0, z: 0 },
    size: { x: 32, y: 1, z: 32 },
  }));
  await s.warmup(bbox);
  return s;
}

test('une sphère rend les bornes de la SPHÈRE, pas de la sélection', async () => {
  // Ce que ces bornes commandent : l'instantané d'annulation, le recollage de
  // l'aperçu et le remaillage du viewport. Rendre la sélection, c'était dire
  // « tout le build a changé » pour cent soixante-huit blocs.
  const sel = BOX(0, 10, 0, 31, 60, 31);
  const s = await store(sel);
  const r = opSphere(s, sel, { block: { name: 'minecraft:stone' }, radius: 3, hollow: false });
  assert.ok(r.blocksChanged > 0);
  const cote = (k) => r.bounds.max[k] - r.bounds.min[k] + 1;
  assert.ok(cote('x') <= 9, `${cote('x')} cases en X pour un rayon 3`);
  assert.ok(cote('y') <= 9, `${cote('y')} cases en Y`);
  assert.ok(cote('x') < (sel.max.x - sel.min.x + 1), 'plus étroit que la sélection');
});

test('la sphère écrit EXACTEMENT la même chose qu’avant la réduction', async () => {
  // Le risque de toute optimisation de boucle : écrire moins. On compare donc
  // le résultat au balayage naïf de toute la sélection.
  const sel = BOX(0, 10, 0, 31, 40, 31);
  const s = await store(sel);
  opSphere(s, sel, { block: { name: 'minecraft:stone' }, radius: 5, hollow: false });

  const cx = (sel.min.x + sel.max.x) / 2, cy = (sel.min.y + sel.max.y) / 2, cz = (sel.min.z + sel.max.z) / 2;
  const r2 = 5.5 * 5.5;
  let attendus = 0, trouves = 0;
  for (let y = sel.min.y; y <= sel.max.y; y++) {
    for (let z = sel.min.z; z <= sel.max.z; z++) {
      for (let x = sel.min.x; x <= sel.max.x; x++) {
        const dedans = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= r2;
        const pose = s.getBlock(x, y, z)?.Name === 'minecraft:stone';
        if (dedans) attendus++;
        if (pose) trouves++;
        assert.equal(pose, dedans, `(${x},${y},${z}) : posé=${pose}, attendu=${dedans}`);
      }
    }
  }
  assert.equal(trouves, attendus);
  assert.ok(attendus > 100, 'la sphère n’est pas vide');
});

test('un cylindre rend les bornes du CYLINDRE', async () => {
  const sel = BOX(0, 10, 0, 31, 40, 31);
  const s = await store(sel);
  const r = opCyl(s, sel, { block: { name: 'minecraft:stone' }, radius: 4, hollow: false });
  assert.ok(r.bounds.max.x - r.bounds.min.x + 1 <= 11);
  assert.equal(r.bounds.min.y, sel.min.y, 'la hauteur reste entière');
  assert.equal(r.bounds.max.y, sel.max.y);
});

// ── La violation est BRUYANTE ───────────────────────────────────────────────

test('lire hors de la zone décodée lève `cold_read`, au lieu de rendre de l’air', async () => {
  // C'est ce qui rend la réduction des portées vérifiable au lieu d'être
  // pariée. Avant, un chunk non décodé rendait `null` — donc de l'air — et
  // l'opération écrivait ce vide par-dessus de la pierre. Corruption
  // silencieuse, invisible en relecture.
  const s = new RegionStore(blankRegions({
    origin: { x: 0, y: 0, z: 0 },
    size: { x: 64, y: 1, z: 64 },
  }));
  await s.warmup(BOX(0, 0, 0, 15, 0, 15)); // un seul chunk réchauffé

  assert.doesNotThrow(() => s.getBlock(5, 0, 5), 'dans la zone : normal');
  assert.throws(() => s.getBlock(40, 0, 40), /cold_read/, 'hors zone : bruyant');
});

test('hors du monde, c’est toujours de l’air — et ce n’est PAS une erreur', async () => {
  // L'autre moitié de la distinction : « pas de chunk ici » est une réponse
  // légitime. Les confondre avec « chunk non décodé » est ce qui a masqué le
  // défaut pendant si longtemps.
  const s = new RegionStore(blankRegions({
    origin: { x: 0, y: 0, z: 0 },
    size: { x: 16, y: 1, z: 16 },
  }));
  await s.warmup(BOX(0, 0, 0, 15, 0, 15));
  assert.equal(s.getBlock(100000, 0, 100000), null);
});

test('`deriveSparse` rend aussi des blocs typés', async () => {
  // L'autre producteur. Si celui-ci rendait un tableau JS, le recollage
  // repasserait par le tas à chaque opération sans que rien ne le signale.
  const s = new RegionStore(blankRegions({ origin: { x: 0, y: 0, z: 0 }, size: { x: 16, y: 1, z: 16 } }));
  const bbox = BOX(0, 0, 0, 15, 20, 15);
  await s.warmup(bbox);
  s.setBlock(3, 4, 5, { Name: 'minecraft:stone', Properties: null });
  const sparse = s.deriveSparse(bbox, 1000);
  assert.ok(sparse.blocks instanceof Int32Array);
  assert.equal(sparse.count, 1);
  assert.equal(sparse.blocks.length, 4, 'la vue est serrée sur le contenu, pas sur le tampon');
  assert.deepEqual([...sparse.blocks.slice(0, 3)], [3, 4, 5]);
});
