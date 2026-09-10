import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsAdapter } from '../src/storage/index.js';
import { createStaging, createLibrary, buildExtent, buildLimits, validateSelection } from '../src/staging/index.js';
import { buildRegion, readBack } from './fixtures/region.js';

// Bout-en-bout du staging porté sur le StorageAdapter. C'est LE filet de
// sécurité du portage : les modules purs sont repris à l'identique, mais cette
// couche-ci a été réécrite, et seuls des tests qui écrivent vraiment sur disque
// prouvent qu'elle se comporte comme celle du site.

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const STONE = 'minecraft:stone';
const OAK = 'minecraft:oak_planks';

/** Projet de 16³ à l'origine, avec un sol de pierre en y=0 et un repère en oak. */
function makeProject({ blocks } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-staging-'));
  roots.push(root);
  const adapter = new FsAdapter({ root });
  const staging = createStaging(adapter);

  const content = blocks || (() => {
    const out = [];
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) out.push({ x, y: 0, z, Name: STONE });
    out.push({ x: 3, y: 5, z: 4, Name: OAK });
    return out;
  })();

  adapter.saveProject({ id: 'p1', name: 'Essai', min: { x: 0, y: 0, z: 0 }, size: { x: 16, y: 16, z: 16 } });
  adapter.attachSource('p1', { name: 'r.0.0.mca', buffer: buildRegion(content) });
  return { root, adapter, staging, project: () => adapter.getProject('p1') };
}

const sel = (min, max) => ({ min, max });
const ONE = (x, y, z) => sel({ x, y, z }, { x, y, z });

// ── Non-destructif ──────────────────────────────────────────────────────────

test('la source n’est jamais modifiée par une opération', async () => {
  const { adapter, staging, project } = makeProject();
  const before = adapter.readSource(project());

  await staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: OAK } }, selection: ONE(1, 1, 1), actor: 'moi',
  });

  assert.deepEqual(adapter.readSource(project()), before, 'le .mca importé est intact octet pour octet');
});

test('réinitialiser le staging ramène au contenu d’origine', async () => {
  const { staging, project } = makeProject();
  await staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: OAK } }, selection: ONE(1, 1, 1), actor: 'moi',
  });
  assert.equal(staging.hasPendingEdits('p1'), true);

  staging.resetStaging('p1');
  assert.equal(staging.hasPendingEdits('p1'), false);

  // La prochaine lecture rematérialise depuis la source : le bloc a disparu.
  const store = staging.loadStore(project());
  await store.warmup(buildExtent(project()));
  assert.equal(store.getBlock(1, 1, 1), null);
});

// ── Opérations ──────────────────────────────────────────────────────────────

test('set écrit dans le staging et l’écriture survit à un rechargement', async () => {
  const { staging, project } = makeProject();
  const res = await staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: OAK } }, selection: sel({ x: 1, y: 1, z: 1 }, { x: 2, y: 1, z: 2 }), actor: 'moi',
  });
  assert.equal(res.blocksChanged, 4);

  // Store neuf : on relit réellement les fichiers, pas un cache mémoire.
  const store = staging.loadStore(project());
  await store.warmup(buildExtent(project()));
  assert.equal(store.getBlock(1, 1, 1).Name, OAK);
  assert.equal(store.getBlock(2, 1, 2).Name, OAK);
  assert.equal(store.getBlock(3, 1, 3), null, 'hors sélection : inchangé');
});

test('une opération inconnue est refusée', async () => {
  const { staging, project } = makeProject();
  await assert.rejects(
    staging.applyOperation({ project: project(), operation: 'quantum_flux', selection: ONE(1, 1, 1) }),
    /unknown_operation/,
  );
});

test('une sélection hors des limites est refusée', async () => {
  const { staging, project } = makeProject();
  await assert.rejects(
    staging.applyOperation({ project: project(), operation: 'set', params: { block: { name: OAK } }, selection: ONE(999, 1, 1) }),
    /out_of_bounds/,
  );
});

test('coller sans presse-papier est refusé', async () => {
  const { staging, project } = makeProject();
  await assert.rejects(
    staging.applyOperation({ project: project(), operation: 'paste', selection: ONE(1, 1, 1) }),
    /empty_clipboard/,
  );
});

// ── Emprise ─────────────────────────────────────────────────────────────────

test('construire au-dessus du contenu fait grandir l’emprise du projet', async () => {
  const { staging, project } = makeProject();
  assert.equal(project().size.y, 16);

  // y=40 est hors de l'emprise du contenu mais dans la hauteur du monde.
  await staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: OAK } }, selection: ONE(5, 40, 5), actor: 'moi',
  });

  const p = project();
  assert.equal(p.min.y, 0);
  assert.equal(p.size.y, 41, 'l’emprise couvre maintenant y ∈ [0, 40]');
  assert.equal(buildExtent(p).max.y, 40);
});

test('les limites d’édition ouvrent toute la hauteur du monde, pas l’emprise du contenu', () => {
  const p = { min: { x: 0, y: 0, z: 0 }, size: { x: 16, y: 16, z: 16 } };
  const lim = buildLimits(p);
  assert.equal(lim.min.y, -64);
  assert.equal(lim.max.y, 319);
  assert.equal(lim.min.x, 0);
  assert.equal(lim.max.x, 15, 'X et Z restent bornés par le build');
});

// ── Undo / redo ─────────────────────────────────────────────────────────────

test('undo restaure, redo réapplique, et les profondeurs suivent', async () => {
  const { staging, project } = makeProject();
  const op = () => staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: OAK } }, selection: ONE(1, 1, 1), actor: 'moi',
  });

  assert.equal(staging.undoDepth('p1'), 0);
  await op();
  assert.equal(staging.undoDepth('p1'), 1);
  assert.equal(staging.redoDepth('p1'), 0);

  const after = staging.loadStore(project());
  await after.warmup(buildExtent(project()));
  assert.equal(after.getBlock(1, 1, 1).Name, OAK);

  await staging.undoLast({ project: project(), actor: 'moi' });
  assert.equal(staging.undoDepth('p1'), 0);
  assert.equal(staging.redoDepth('p1'), 1);
  const undone = staging.loadStore(project());
  await undone.warmup(buildExtent(project()));
  assert.equal(undone.getBlock(1, 1, 1), null, 'le bloc a disparu');

  await staging.redoLast({ project: project(), actor: 'moi' });
  assert.equal(staging.undoDepth('p1'), 1);
  assert.equal(staging.redoDepth('p1'), 0);
  const redone = staging.loadStore(project());
  await redone.warmup(buildExtent(project()));
  assert.equal(redone.getBlock(1, 1, 1).Name, OAK, 'le bloc est revenu');
});

test('une nouvelle opération invalide la pile de rétablissement', async () => {
  const { staging, project } = makeProject();
  const set = (x) => staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: OAK } }, selection: ONE(x, 1, 1), actor: 'moi',
  });

  await set(1);
  await staging.undoLast({ project: project(), actor: 'moi' });
  assert.equal(staging.redoDepth('p1'), 1);

  await set(2);
  assert.equal(staging.redoDepth('p1'), 0, 'on ne rétablit pas par-dessus une branche neuve');
});

test('undo sans rien à annuler est refusé', async () => {
  const { staging, project } = makeProject();
  await assert.rejects(staging.undoLast({ project: project(), actor: 'moi' }), /nothing_to_undo/);
  await assert.rejects(staging.redoLast({ project: project(), actor: 'moi' }), /nothing_to_redo/);
});

test('la pile undo est bornée par maxUndo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-staging-'));
  roots.push(root);
  const adapter = new FsAdapter({ root });
  const staging = createStaging(adapter, { maxUndo: 3 });
  adapter.saveProject({ id: 'p1', name: 'x', min: { x: 0, y: 0, z: 0 }, size: { x: 16, y: 16, z: 16 } });
  adapter.attachSource('p1', { name: 'r.0.0.mca', buffer: buildRegion([{ x: 0, y: 0, z: 0, Name: STONE }]) });

  for (let i = 1; i <= 6; i++) {
    await staging.applyOperation({
      project: adapter.getProject('p1'), operation: 'set',
      params: { block: { name: OAK } }, selection: ONE(i, 1, 1), actor: 'moi',
    });
  }
  assert.equal(staging.undoDepth('p1'), 3, 'les plus vieux snapshots sont purgés');
});

// ── Journal ─────────────────────────────────────────────────────────────────

test('chaque opération laisse une trace exploitable dans le journal', async () => {
  const { staging, project } = makeProject();
  await staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: OAK } }, selection: sel({ x: 1, y: 1, z: 1 }, { x: 2, y: 1, z: 1 }), actor: 'baptiste',
  });
  await staging.undoLast({ project: project(), actor: 'baptiste' });

  const rows = staging.listAudit('p1');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].operation, 'undo');
  assert.equal(rows[1].operation, 'set');
  assert.equal(rows[1].actor, 'baptiste');
  assert.equal(rows[1].blocksChanged, 2);
  assert.ok(rows[1].durationMs >= 0);
  assert.deepEqual(rows[1].params.selection.min, { x: 1, y: 1, z: 1 });
});

// ── Aperçu ──────────────────────────────────────────────────────────────────

test('l’aperçu reflète le staging et couvre l’emprise agrandie', async () => {
  const { staging, project } = makeProject();
  await staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: OAK } }, selection: ONE(5, 30, 5), actor: 'moi',
  });

  const preview = staging.readPreview('p1');
  assert.ok(preview, 'un aperçu est écrit');
  assert.equal(preview.size.y, 31, 'l’aperçu couvre y ∈ [0, 30]');
  // 256 blocs de sol + le repère + le bloc posé.
  assert.equal(preview.count, 258);
  assert.ok(preview.palette.some((e) => e.name === OAK));
  assert.ok(preview.bom.some((b) => b.blockId === STONE && b.count === 256));
});

test('l’aperçu est annoncé partiel plutôt que refusé au-delà du budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-staging-'));
  roots.push(root);
  const adapter = new FsAdapter({ root });
  // Budget d'affichage ridicule : le sol de 256 blocs le dépasse largement.
  const staging = createStaging(adapter, { previewMaxBlocks: 10 });
  adapter.saveProject({ id: 'p1', name: 'x', min: { x: 0, y: 0, z: 0 }, size: { x: 16, y: 16, z: 16 } });
  const floor = [];
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) floor.push({ x, y: 0, z, Name: STONE });
  adapter.attachSource('p1', { name: 'r.0.0.mca', buffer: buildRegion(floor) });

  const res = await staging.applyOperation({
    project: adapter.getProject('p1'), operation: 'set',
    params: { block: { name: OAK } }, selection: ONE(1, 1, 1), actor: 'moi',
  });
  assert.equal(res.previewTruncated, true, 'aperçu partiel signalé');

  // Mais l'écriture, elle, est complète : c'est tout l'intérêt de la troncature.
  const store = staging.loadStore(adapter.getProject('p1'));
  await store.warmup(buildExtent(adapter.getProject('p1')));
  assert.equal(store.getBlock(1, 1, 1).Name, OAK);
});

// ── Export ──────────────────────────────────────────────────────────────────

test('export sans décalage : recopie lossless des régions de staging', async () => {
  const { staging, project } = makeProject();
  await staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: OAK } }, selection: ONE(1, 1, 1), actor: 'moi',
  });

  const out = await staging.exportBuild(project());
  assert.equal(out.filename, 'r.0.0.mca');
  const blocks = await readBack(out.buffer);
  assert.equal(blocks.get('1,1,1').Name, OAK, 'la modification est dans l’export');
  assert.equal(blocks.get('3,5,4').Name, OAK, 'le contenu d’origine aussi');
  assert.equal(blocks.get('0,0,0').Name, STONE);
});

test('export avec décalage : le build est déplacé aux coordonnées voulues', async () => {
  const { staging, project } = makeProject();
  const out = await staging.exportBuild(project(), { dx: 100, dy: 0, dz: 0 });
  const blocks = await readBack(out.buffer, { regionX: 0, regionZ: 0 });
  assert.equal(blocks.get('103,5,4')?.Name, OAK, 'le repère a bougé de +100 en X');
  assert.equal(blocks.get('3,5,4'), undefined, 'et n’est plus à sa place d’origine');
});

test('exporter un projet sans staging ni source est refusé proprement', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-staging-'));
  roots.push(root);
  const adapter = new FsAdapter({ root });
  const staging = createStaging(adapter);
  adapter.saveProject({ id: 'vide', name: 'x', min: { x: 0, y: 0, z: 0 }, size: { x: 16, y: 16, z: 16 } });
  await assert.rejects(staging.exportBuild(adapter.getProject('vide')), /no_source/);
});

// ── Extraction de zone ──────────────────────────────────────────────────────

test('extraire une zone rend un sparse et des régions relisibles', async () => {
  const { staging, project } = makeProject();
  const { sparse, regions } = await staging.cropBuild(project(), {
    min: { x: 0, y: 0, z: 0 }, max: { x: 7, y: 7, z: 7 },
  });
  // 8×8 de sol en y=0, plus le repère en (3,5,4) qui tombe dans la boîte.
  assert.equal(sparse.count, 65);
  assert.equal(regions.length, 1);
  const blocks = await readBack(regions[0].buffer);
  assert.equal(blocks.get('0,0,0').Name, STONE);
  assert.equal(blocks.get('3,5,4').Name, OAK);
});

test('extraire une boîte vide est refusé', async () => {
  const { staging, project } = makeProject();
  await assert.rejects(
    staging.cropBuild(project(), { min: { x: 0, y: 9, z: 0 }, max: { x: 2, y: 11, z: 2 } }),
    /empty_box/,
  );
});

// ── Chunk modèle ────────────────────────────────────────────────────────────

test('le chunk modèle est emprunté au projet, avec sa version de données', async () => {
  const { staging, project } = makeProject();
  const tmpl = await staging.templateChunk(project());
  assert.ok(tmpl, 'un modèle est trouvé');
  assert.equal(tmpl.value.DataVersion.value, 2860, 'la DataVersion du monde ouvert, jamais une constante');
});

// ── Matérialisation ─────────────────────────────────────────────────────────

test('matérialiser deux fois ne réécrase pas le travail en cours', async () => {
  const { staging, project } = makeProject();
  await staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: OAK } }, selection: ONE(1, 1, 1), actor: 'moi',
  });
  staging.materialize(project()); // second appel : doit être un non-événement

  const store = staging.loadStore(project());
  await store.warmup(buildExtent(project()));
  assert.equal(store.getBlock(1, 1, 1).Name, OAK, 'la modification est toujours là');
});

// ── Relief ──────────────────────────────────────────────────────────────────

test('heightmap : la hauteur de chaque colonne suit la valeur donnée', async () => {
  const { staging, project } = makeProject();
  const sizeX = 4, sizeZ = 4;
  const heights = new Float64Array(sizeX * sizeZ).fill(0.5);
  await staging.applyHeightmap({
    project: project(), actor: 'moi',
    selection: sel({ x: 0, y: 1, z: 0 }, { x: 3, y: 11, z: 3 }),
    heights,
    params: { block: { name: OAK }, mode: 'surface' },
  });

  const store = staging.loadStore(project());
  await store.warmup(buildExtent(project()));
  // plage Y = 10, hauteur 0.5 → 5 au-dessus de y=1.
  assert.equal(store.getBlock(0, 6, 0).Name, OAK);
  assert.equal(store.getBlock(3, 6, 3).Name, OAK);
  assert.equal(store.getBlock(0, 7, 0), null);
});

test('exporter la zone en heightmap : la colonne la plus haute est la plus claire', async () => {
  const { staging, project } = makeProject();
  const { sizeX, sizeZ, data } = await staging.exportHeightmap(project(), {
    min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 10, z: 15 },
  });
  assert.equal(sizeX, 16);
  assert.equal(sizeZ, 16);
  // Le repère en oak est à y=5 sur (3,4) ; partout ailleurs le sol est à y=0.
  assert.equal(data[4 * 16 + 3], Math.round((5 / 10) * 255));
  assert.equal(data[0], 0, 'une colonne dont le sommet est en bas de plage → noir');
});

// ── Baguette magique ────────────────────────────────────────────────────────

test('la baguette sélectionne le sol connexe, pas le repère isolé', async () => {
  const { staging, project } = makeProject();
  const res = await staging.floodSelect(project(), { x: 0, y: 0, z: 0 });
  assert.equal(res.block, STONE);
  assert.equal(res.count, 256, 'tout le sol');
  assert.deepEqual(res.min, { x: 0, y: 0, z: 0 });
  assert.deepEqual(res.max, { x: 15, y: 0, z: 15 });
});

test('la baguette sur de l’air est refusée', async () => {
  const { staging, project } = makeProject();
  await assert.rejects(staging.floodSelect(project(), { x: 8, y: 8, z: 8 }), /empty_seed/);
});

// ── Presse-papier et bibliothèque ───────────────────────────────────────────

test('copier, ranger dans la bibliothèque, relire et coller ailleurs', async () => {
  const { adapter, staging, project } = makeProject();
  const library = createLibrary(adapter);

  const copied = await staging.applyOperation({
    project: project(), operation: 'copy',
    selection: sel({ x: 3, y: 5, z: 4 }, { x: 3, y: 5, z: 4 }),
  });
  assert.ok(copied.clipboard, 'copy ne modifie rien et rend le presse-papier');
  assert.equal(copied.blocksChanged, 0);

  const meta = library.save({ name: 'repère', schem: copied.clipboard });
  assert.equal(meta.name, 'repère');
  assert.equal(meta.blockCount, 1);
  assert.equal(library.list().length, 1);

  const reloaded = library.load(meta.id);
  await staging.applyOperation({
    project: project(), operation: 'paste',
    clipboard: reloaded, selection: ONE(10, 8, 10), actor: 'moi',
  });

  const store = staging.loadStore(project());
  await store.warmup(buildExtent(project()));
  assert.equal(store.getBlock(10, 8, 10).Name, OAK, 'collé à la nouvelle position');
  assert.equal(store.getBlock(3, 5, 4).Name, OAK, 'l’original est toujours là');
});

test('la bibliothèque refuse de dépasser son plafond', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-staging-'));
  roots.push(root);
  const library = createLibrary(new FsAdapter({ root }), { maxPerScope: 2 });
  const schem = { sx: 1, sy: 1, sz: 1, data: [{ Name: STONE, Properties: null }] };
  library.save({ name: 'a', schem });
  library.save({ name: 'b', schem });
  assert.throws(() => library.save({ name: 'c', schem }), /library_full/);
});

// ── Validation de sélection (pure) ──────────────────────────────────────────

test('validateSelection normalise les coins inversés', () => {
  const bbox = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } };
  const out = validateSelection(sel({ x: 9, y: 9, z: 9 }, { x: 2, y: 2, z: 2 }), bbox);
  assert.deepEqual(out.min, { x: 2, y: 2, z: 2 });
  assert.deepEqual(out.max, { x: 9, y: 9, z: 9 });
  assert.equal(out.shape.type, 'box');
});

test('validateSelection rend un code d’erreur, pas une exception', () => {
  const bbox = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } };
  assert.equal(validateSelection(null, bbox), 'invalid_selection');
  assert.equal(validateSelection(sel({ x: 0, y: 0, z: 0 }, { x: 99, y: 0, z: 0 }), bbox), 'out_of_bounds');
  assert.equal(validateSelection(sel({ x: 0, y: 0, z: 0 }, { x: 15, y: 15, z: 15 }), bbox, { maxVolume: 10 }), 'selection_too_large');
});

test('une forme de sélection non rectangulaire borne bien les écritures', async () => {
  const { staging, project } = makeProject();
  await staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: OAK } },
    selection: { ...sel({ x: 0, y: 1, z: 0 }, { x: 8, y: 9, z: 8 }), shape: { type: 'sphere' } },
    actor: 'moi',
  });

  const store = staging.loadStore(project());
  await store.warmup(buildExtent(project()));
  assert.equal(store.getBlock(4, 5, 4).Name, OAK, 'le centre de la sphère est rempli');
  assert.equal(store.getBlock(0, 1, 0), null, 'le coin de la boîte est hors sphère');
});

// ── Panneaux et carte en blocs ──────────────────────────────────────────────

test('carte en blocs : chaque cellule du plan reçoit son bloc', async () => {
  const { staging, project } = makeProject();
  // Sélection d'épaisseur 1 en Z → mur dans le plan XY, v=0 en haut.
  const wall = sel({ x: 0, y: 1, z: 5 }, { x: 3, y: 2, z: 5 });
  const names = [
    OAK, null, OAK, null, // v=0 → y=2 (haut)
    null, STONE, null, STONE, // v=1 → y=1
  ];
  const res = await staging.applyMapBlocks({ project: project(), selection: wall, names, actor: 'moi' });
  assert.deepEqual(res.plane, { w: 4, h: 2 });
  assert.equal(res.blocksChanged, 4);

  const store = staging.loadStore(project());
  await store.warmup(buildExtent(project()));
  assert.equal(store.getBlock(0, 2, 5).Name, OAK, 'v=0 est en haut du mur');
  assert.equal(store.getBlock(1, 2, 5), null, 'une cellule nulle est laissée telle quelle');
  assert.equal(store.getBlock(1, 1, 5).Name, STONE);
});

test('panneau : le masque sépare l’encre du fond, et le fond est reproductible', async () => {
  const { staging, project } = makeProject();
  const wall = sel({ x: 0, y: 1, z: 5 }, { x: 3, y: 2, z: 5 });
  const mask = [1, 0, 0, 1, 0, 1, 1, 0];
  // Générateur figé : le fond marbré doit être rejouable à l'identique.
  const fixedRandom = () => 0;

  await staging.applyPanel({
    project: project(), selection: wall, mask,
    preset: 'white_clean', actor: 'moi', random: fixedRandom,
  });

  const store = staging.loadStore(project());
  await store.warmup(buildExtent(project()));
  // white_clean : encre = béton noir, fond = quartz uni.
  assert.equal(store.getBlock(0, 2, 5).Name, 'minecraft:black_concrete');
  assert.equal(store.getBlock(1, 2, 5).Name, 'minecraft:quartz_block');
  assert.equal(store.getBlock(1, 1, 5).Name, 'minecraft:black_concrete');
});

test('panneau : un masque trop court est refusé', async () => {
  const { staging, project } = makeProject();
  await assert.rejects(
    staging.applyPanel({ project: project(), selection: sel({ x: 0, y: 1, z: 5 }, { x: 3, y: 2, z: 5 }), mask: [1] }),
    /bad_panel/,
  );
});

// ── Régression : annuler ne doit pas échouer sur un gros build ──────────────

test('annuler régénère un aperçu tronqué au lieu d’échouer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-staging-'));
  roots.push(root);
  const adapter = new FsAdapter({ root });
  const staging = createStaging(adapter, { previewMaxBlocks: 10 });
  adapter.saveProject({ id: 'p1', name: 'x', min: { x: 0, y: 0, z: 0 }, size: { x: 16, y: 16, z: 16 } });
  const floor = [];
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) floor.push({ x, y: 0, z, Name: STONE });
  adapter.attachSource('p1', { name: 'r.0.0.mca', buffer: buildRegion(floor) });

  await staging.applyOperation({
    project: adapter.getProject('p1'), operation: 'set',
    params: { block: { name: OAK } }, selection: ONE(1, 1, 1), actor: 'moi',
  });
  // Sur le site, cet appel levait `too_many_blocks` : l'annulation avait bien
  // eu lieu sur disque, mais l'utilisateur voyait une erreur.
  await staging.undoLast({ project: adapter.getProject('p1'), actor: 'moi' });

  const preview = staging.readPreview('p1');
  assert.equal(preview.truncated, true);
  const store = staging.loadStore(adapter.getProject('p1'));
  await store.warmup(buildExtent(adapter.getProject('p1')));
  assert.equal(store.getBlock(1, 1, 1), null, 'l’annulation a bien eu lieu');
});

// ── Parité descripteur ↔ exécution ─────────────────────────────────────────

test('toute opération déclarée dans le descripteur est réellement branchée', async () => {
  const { OPERATION_IDS } = await import('../src/worldedit/operations.js');
  const { OPERATION_NAMES } = await import('../src/staging/index.js');
  // `copy` et `paste` sont traitées à part dans applyOperation (presse-papier).
  const branchees = new Set([...OPERATION_NAMES, 'copy', 'paste']);

  const declareesNonBranchees = [...OPERATION_IDS].filter((id) => !branchees.has(id));
  assert.deepEqual(declareesNonBranchees, [], 'le descripteur génère l’interface : une opération listée là et absente ici donne un bouton qui échoue');

  const brancheesNonDeclarees = [...branchees].filter((id) => !OPERATION_IDS.has(id));
  assert.deepEqual(brancheesNonDeclarees, [], 'une opération branchée mais non déclarée est inatteignable depuis l’interface');
});
