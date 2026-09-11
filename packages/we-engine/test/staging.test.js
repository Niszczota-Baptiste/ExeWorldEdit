import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsAdapter } from '../src/storage/index.js';
import { createStaging, createLibrary, buildExtent, buildLimits, scanLimits, validateSelection, blankRegions } from '../src/staging/index.js';
import { RegionStore } from '../src/worldedit/regionStore.js';
import { buildRegion, readBack, readBackEntities } from './fixtures/region.js';

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

// ── Retrouver une emprise qu'on ne connaît pas encore ───────────────────────

test('scanLimits couvre les régions PRÉSENTES, sur toute la hauteur du monde', () => {
  const box = scanLimits([{ regionX: 0, regionZ: 0 }, { regionX: 1, regionZ: -1 }]);
  assert.deepEqual(box.min, { x: 0, y: -64, z: -512 });
  assert.deepEqual(box.max, { x: 1023, y: 319, z: 511 });
});

test('scanLimits sans région ne rend rien plutôt qu’une boîte vide', () => {
  assert.equal(scanLimits([]), null);
  assert.equal(scanLimits(undefined), null);
});

test('rescanExtent retrouve l’emprise d’un projet ouvert à 1 × 1 × 1', async () => {
  // C'est l'état exact d'une save au moment où on l'ouvre : les régions sont
  // là, mais on ne sait pas encore ce qu'elles contiennent, donc l'emprise est
  // un remplissage. Balayer À PARTIR d'elle ne regarde qu'une colonne — et une
  // save entière s'ouvrait ainsi en 1 × 1 × 1, viewport vide.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-rescan-'));
  roots.push(root);
  const adapter = new FsAdapter({ root });
  const staging = createStaging(adapter);

  adapter.saveProject({ id: 'w1', name: 'save', min: { x: 0, y: -64, z: 0 }, size: { x: 1, y: 1, z: 1 } });
  // Le contenu évite volontairement la colonne (0, 0) : c'est la seule que
  // l'ancien balayage regardait.
  const blocks = [];
  for (let x = 4; x <= 9; x++) for (let z = 6; z <= 11; z++) blocks.push({ x, y: 5, z, Name: STONE });
  adapter.attachSource('w1', { name: 'r.0.0.mca', buffer: buildRegion(blocks) });

  const bounds = await staging.rescanExtent(adapter.getProject('w1'));
  assert.deepEqual(bounds.min, { x: 4, y: 5, z: 6 });
  assert.deepEqual(bounds.max, { x: 9, y: 5, z: 11 });
  assert.deepEqual(adapter.getProject('w1').size, { x: 6, y: 1, z: 6 });
});

test('rescanExtent découvre une région ajoutée HORS de l’emprise courante', async () => {
  // Le cas « charger les régions voisines » : la nouvelle région ne recoupe
  // pas l'emprise d'avant, donc un balayage fondé sur celle-ci ne la verrait
  // jamais — elle resterait chargée mais invisible.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-rescan2-'));
  roots.push(root);
  const adapter = new FsAdapter({ root });
  const staging = createStaging(adapter);
  adapter.saveProject({ id: 'w2', name: 'save', min: { x: 0, y: -64, z: 0 }, size: { x: 1, y: 1, z: 1 } });

  const regions = blankRegions({ origin: { x: 0, y: 0, z: 0 }, size: { x: 1024, y: 1, z: 16 } });
  const store = new RegionStore(regions);
  await store.warmup({ min: { x: 0, y: 0, z: 0 }, max: { x: 1023, y: 16, z: 15 } });
  for (const [x, y, z] of [[10, 3, 5], [14, 3, 7], [600, 7, 9], [610, 7, 12]]) {
    store.setBlock(x, y, z, { Name: STONE, Properties: null });
  }
  const commit = store.commit({ touchedOnly: false });
  const seeded = regions.map((r) => ({ ...r, buffer: commit.get(`${r.regionX},${r.regionZ}`) || r.buffer }));
  assert.equal(seeded.length, 2, 'deux régions côte à côte');

  staging.seedRegions('w2', seeded.slice(0, 1));
  await staging.rescanExtent(adapter.getProject('w2'));
  assert.deepEqual(adapter.getProject('w2').size, { x: 5, y: 1, z: 3 }, 'emprise de la première région');

  staging.seedRegions('w2', seeded.slice(1));
  await staging.rescanExtent(adapter.getProject('w2'));
  const p = adapter.getProject('w2');
  assert.deepEqual(p.min, { x: 10, y: 3, z: 5 });
  assert.deepEqual(p.size, { x: 601, y: 5, z: 8 }, 'l’emprise couvre les DEUX régions');
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

// ── Ouvrir et écrire des schematics ────────────────────────────────────────

test('un .schem se rouvre comme un projet ordinaire', async () => {
  const { schematicToRegions, volumeToSchematic } = await import('../src/staging/index.js');
  const { schematicToSponge } = await import('../src/worldedit/schematicFormats.js');
  const { MemoryVolume } = await import('../src/worldedit/transform.js');

  // Un petit motif asymétrique : une erreur d'orientation se verrait.
  const vol = new MemoryVolume();
  vol.setBlock(0, 0, 0, { Name: STONE, Properties: null });
  vol.setBlock(2, 0, 0, { Name: OAK, Properties: null });
  vol.setBlock(0, 1, 0, { Name: OAK, Properties: null });
  vol.setBlock(0, 0, 3, { Name: STONE, Properties: null });
  const source = volumeToSchematic(vol, sel({ x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 3 }));

  const file = await schematicToSponge(source, { name: 'motif' });
  const out = await schematicToRegions(file, 'motif.schem', { origin: { x: 0, y: 0, z: 0 } });

  assert.deepEqual(out.size, { x: 3, y: 2, z: 4 });
  assert.equal(out.blockCount, 4, 'les quatre blocs posés, et rien d’autre');

  const at = (x, y, z) => {
    const i = out.sparse.blocks.findIndex((_, k) => k % 4 === 0
      && out.sparse.blocks[k] === x && out.sparse.blocks[k + 1] === y && out.sparse.blocks[k + 2] === z);
    return i < 0 ? null : out.sparse.palette[out.sparse.blocks[i + 3]].name;
  };
  assert.equal(at(0, 0, 0), STONE);
  assert.equal(at(2, 0, 0), OAK, 'le décalage en X est préservé');
  assert.equal(at(0, 1, 0), OAK, 'et celui en Y aussi');
  assert.equal(at(0, 0, 3), STONE, 'et celui en Z');
});

test('un .litematic fait le même aller-retour', async () => {
  const { schematicToRegions, volumeToSchematic } = await import('../src/staging/index.js');
  const { schematicToLitematic } = await import('../src/worldedit/schematicFormats.js');
  const { MemoryVolume } = await import('../src/worldedit/transform.js');

  const vol = new MemoryVolume();
  vol.setBlock(1, 2, 3, { Name: OAK, Properties: { facing: 'east' } });
  const source = volumeToSchematic(vol, sel({ x: 0, y: 0, z: 0 }, { x: 3, y: 3, z: 3 }));

  const file = await schematicToLitematic(source, { name: 'essai' });
  const out = await schematicToRegions(file, 'essai.litematic', { origin: { x: 0, y: 0, z: 0 } });
  assert.equal(out.blockCount, 1);
  const e = out.sparse.palette[out.sparse.blocks[3]];
  assert.equal(e.name, OAK);
  assert.equal(e.props?.facing, 'east', 'l’état du bloc survit au format');
});

test('un schematic garde son offset d’origine si on ne lui en impose pas', async () => {
  const { schematicToRegions, volumeToSchematic } = await import('../src/staging/index.js');
  const { schematicToSponge } = await import('../src/worldedit/schematicFormats.js');
  const { MemoryVolume } = await import('../src/worldedit/transform.js');

  const vol = new MemoryVolume();
  vol.setBlock(100, 70, 200, { Name: STONE, Properties: null });
  const source = volumeToSchematic(vol, sel({ x: 100, y: 70, z: 200 }, { x: 101, y: 71, z: 201 }));

  const out = await schematicToRegions(await schematicToSponge(source), 'x.schem');
  // Recoller sans décalage doit remettre le build là où il a été pris.
  assert.deepEqual(out.origin, { x: 100, y: 70, z: 200 });
  assert.deepEqual(out.sparse.min, { x: 100, y: 70, z: 200 });
});

test('un fichier qui n’est pas un schematic est refusé', async () => {
  const { schematicToRegions } = await import('../src/staging/index.js');
  await assert.rejects(schematicToRegions(Buffer.from('ceci n’est pas du NBT'), 'x.schem'));
});

// ── Relevé de performance ───────────────────────────────────────────────────

test('phaseTimer découpe une opération et n’oublie pas le reliquat', async () => {
  const { phaseTimer } = await import('../src/staging/index.js');
  let horloge = 1000;
  const t = phaseTimer(() => horloge);

  horloge += 5;            // 5 ms avant la première phase → reliquat
  t.enter('load'); horloge += 120;
  t.enter('apply'); horloge += 40;
  t.enter('commit'); horloge += 10;
  const out = t.finish();

  assert.equal(out.totalMs, 175);
  assert.deepEqual(out.phases, [
    { phase: 'load', ms: 120 },
    { phase: 'apply', ms: 40 },
    { phase: 'commit', ms: 10 },
    // Ce que les phases n'ont pas couvert doit apparaître : un total qui ne
    // tombe pas juste ferait douter de toute la mesure.
    { phase: 'reste', ms: 5 },
  ]);
});

test('phaseTimer sans reliquat n’invente pas de phase', async () => {
  const { phaseTimer } = await import('../src/staging/index.js');
  let horloge = 0;
  const t = phaseTimer(() => horloge);
  t.enter('load'); horloge += 30;
  const out = t.finish();
  assert.deepEqual(out.phases, [{ phase: 'load', ms: 30 }]);
  assert.equal(out.totalMs, 30);
});

test('une opération rend son relevé par phase, et le journal le garde', async () => {
  const { staging, project } = makeProject();
  const res = await staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: OAK } }, selection: ONE(1, 1, 1), actor: 'moi',
  });

  const noms = res.timings.phases.map((p) => p.phase);
  assert.ok(noms.includes('load'), 'la phase de chargement est mesurée');
  assert.ok(noms.includes('apply'));
  assert.ok(noms.includes('commit'));
  assert.ok(noms.includes('preview'));
  assert.ok(res.timings.totalMs >= 0);

  // Une opération lente s'analyse souvent APRÈS coup : le relevé doit survivre
  // à la disparition de la barre de progression.
  const [ligne] = staging.listAudit('p1');
  assert.ok(ligne.timings, 'le journal conserve le relevé');
  assert.deepEqual(ligne.timings.phases.map((p) => p.phase), noms);
});

// ── Aperçu incrémental ──────────────────────────────────────────────────────
//
// `growAndPreview` ne redérive plus l'emprise entière : il recolle la seule
// boîte touchée sur l'aperçu précédent. Un recollage faux ne plante pas, il
// affiche un build légèrement faux — donc le seul test qui prouve quelque
// chose est la comparaison avec la dérivation complète, qui reste l'autorité.

/** L'aperçu réduit à « quel bloc à quelle place », en coordonnées monde. */
const previewWorld = (p) => {
  const out = new Map();
  for (let i = 0; i < p.blocks.length; i += 4) {
    out.set(
      `${p.min.x + p.blocks[i]},${p.min.y + p.blocks[i + 1]},${p.min.z + p.blocks[i + 2]}`,
      p.palette[p.blocks[i + 3]].name,
    );
  }
  return out;
};

test('l’aperçu recollé est identique à une dérivation complète', async () => {
  const { staging, project } = makeProject();

  // Une suite d'opérations de natures différentes : remplissage, remplacement,
  // forme, déplacement — chacune touche une boîte différente et fait grandir
  // ou non l'emprise.
  const etapes = [
    ['set', { block: { name: 'minecraft:glass' } }, sel({ x: 1, y: 1, z: 1 }, { x: 4, y: 3, z: 4 })],
    ['replace', { from: { name: STONE }, to: { name: 'minecraft:dirt' } }, sel({ x: 0, y: 0, z: 0 }, { x: 7, y: 0, z: 7 })],
    ['sphere', { block: { name: 'minecraft:oak_log' }, radius: 2 }, sel({ x: 6, y: 6, z: 6 }, { x: 12, y: 12, z: 12 })],
    // Effacer : la boîte touchée doit RETIRER des blocs de l'aperçu, pas
    // seulement en réécrire — c'est le cas que le recollage rate le plus vite.
    ['set', { block: { name: 'minecraft:air' } }, sel({ x: 2, y: 1, z: 2 }, { x: 3, y: 2, z: 3 })],
    // `stack` écrit HORS de la sélection : c'est lui qui vérifie que la boîte
    // touchée suit bien `bounds` et pas seulement la sélection.
    ['stack', { count: 2, direction: 'up' }, sel({ x: 0, y: 0, z: 0 }, { x: 5, y: 2, z: 5 })],
  ];

  for (const [operation, params, selection] of etapes) {
    await staging.applyOperation({ project: project(), operation, params, selection, actor: 't' });

    const incremental = previewWorld(staging.readPreview('p1'));
    // `regenPreview` repart du staging sur disque et redérive TOUT : c'est la
    // vérité de référence, indépendante du chemin incrémental.
    await staging.regenPreview(project());
    const complet = previewWorld(staging.readPreview('p1'));

    assert.deepEqual(incremental, complet, `après « ${operation} », le recollage diverge`);
  }
});

test('la nomenclature recollée compte juste', async () => {
  const { staging, project } = makeProject();
  await staging.applyOperation({
    project: project(), operation: 'set', params: { block: { name: 'minecraft:glass' } },
    selection: sel({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 3 }), actor: 't',
  });

  const incremental = staging.readPreview('p1');
  await staging.regenPreview(project());
  const complet = staging.readPreview('p1');

  const bom = (p) => Object.fromEntries(p.bom.map((b) => [b.blockId, b.count]));
  assert.deepEqual(bom(incremental), bom(complet));
  assert.equal(incremental.count, complet.count);
  assert.equal(bom(incremental)['minecraft:glass'], 16, '4 × 4 cases remplacées');
});

test('annuler puis refaire retombe sur le même aperçu', async () => {
  const { staging, project } = makeProject();
  const avant = previewWorld((await staging.regenPreview(project()), staging.readPreview('p1')));

  await staging.applyOperation({
    project: project(), operation: 'set', params: { block: { name: 'minecraft:glass' } },
    selection: sel({ x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }), actor: 't',
  });
  await staging.undoLast({ project: project(), actor: 't' });

  assert.deepEqual(previewWorld(staging.readPreview('p1')), avant);
});

// ── Plafonds réglables ──────────────────────────────────────────────────────

test('normalizeLimits borne les plafonds réglables', async () => {
  const { normalizeLimits, LIMIT_RANGES, DEFAULT_LIMITS } = await import('../src/staging/geometry.js');

  assert.deepEqual(normalizeLimits(), DEFAULT_LIMITS);
  assert.equal(normalizeLimits({ maxUndo: 1e9 }).maxUndo, LIMIT_RANGES.maxUndo.max);
  assert.equal(normalizeLimits({ maxUndo: -5 }).maxUndo, LIMIT_RANGES.maxUndo.min);
  assert.equal(normalizeLimits({ wandMax: 'beaucoup' }).wandMax, DEFAULT_LIMITS.wandMax);
  assert.equal(normalizeLimits({ maxUndo: 12 }).maxUndo, 12);
});

test('la hauteur du monde n’est PAS réglable', async () => {
  const { normalizeLimits, DEFAULT_LIMITS } = await import('../src/staging/geometry.js');
  // Déplacer le plafond du monde produirait des régions qu'aucun jeu ne relit.
  const forcé = normalizeLimits({ worldMinY: -4000, worldMaxY: 9000 });
  assert.equal(forcé.worldMinY, DEFAULT_LIMITS.worldMinY);
  assert.equal(forcé.worldMaxY, DEFAULT_LIMITS.worldMaxY);
});

test('setLimits prend effet tout de suite sur une opération', async () => {
  const { staging, project } = makeProject();
  const grosse = sel({ x: 0, y: 0, z: 0 }, { x: 15, y: 15, z: 15 }); // 4096 cases

  staging.setLimits({ maxSelectionVolume: 1_000_000 });
  assert.equal(staging.limits.maxSelectionVolume, 1_000_000);

  // Sous le plancher de la borne : ramené au minimum, pas accepté tel quel.
  const applique = staging.setLimits({ maxSelectionVolume: 1 });
  assert.equal(applique.maxSelectionVolume, 1_000_000);

  // Et une opération passe bien avec le plafond courant.
  const res = await staging.applyOperation({
    project: project(), operation: 'set', params: { block: { name: OAK } },
    selection: grosse, actor: 't',
  });
  assert.ok(res.blocksChanged > 0);
});

test('un plafond réglé survit et s’applique au staging suivant', async () => {
  const { adapter, staging } = makeProject();
  staging.setLimits({ maxUndo: 7 });
  adapter.writeSettings({ limits: { maxUndo: 7 } });

  const { createStaging } = await import('../src/staging/index.js');
  const { normalizeLimits } = await import('../src/staging/geometry.js');
  const relance = createStaging(adapter, normalizeLimits(adapter.readSettings().limits));
  assert.equal(relance.limits.maxUndo, 7);
});

// ── Format d'aperçu ─────────────────────────────────────────────────────────

test('un aperçu JSON gzippé d’une version antérieure se relit encore', async () => {
  // Chemin de MISE À JOUR : un projet ouvert avant la phase 1.2 a un
  // `preview.json.gz` sur disque. Ne plus savoir le lire lui ferait perdre son
  // aperçu et son drapeau « modifié », en silence.
  const zlib = await import('node:zlib');
  const { createStaging } = await import('../src/staging/index.js');
  const { adapter, staging, project } = makeProject();

  await staging.applyOperation({
    project: project(), operation: 'set', params: { block: { name: OAK } },
    selection: ONE(1, 1, 1), actor: 't',
  });
  const attendu = staging.readPreview('p1');

  // On remet l'ancien format à la place du nouveau.
  const dir = path.dirname(staging.stagingRegionsDir('p1'));
  fs.writeFileSync(path.join(dir, 'preview.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(attendu))));
  fs.rmSync(path.join(dir, 'preview.bin'), { force: true });

  // Un staging NEUF sur le même dossier : pas de cache mémoire, donc il lit
  // vraiment le disque.
  const relu = createStaging(adapter);
  assert.equal(relu.hasPendingEdits('p1'), true, '« modifié » doit rester vrai');
  const p = relu.readPreview('p1');
  assert.equal(p.count, attendu.count);
  assert.deepEqual(p.blocks, attendu.blocks);
  assert.deepEqual(p.palette, attendu.palette);
});

test('la première écriture convertit l’ancien aperçu et le retire', async () => {
  const zlib = await import('node:zlib');
  const { createStaging } = await import('../src/staging/index.js');
  const { adapter, staging, project } = makeProject();

  await staging.applyOperation({
    project: project(), operation: 'set', params: { block: { name: OAK } },
    selection: ONE(1, 1, 1), actor: 't',
  });
  const dir = path.dirname(staging.stagingRegionsDir('p1'));
  fs.writeFileSync(path.join(dir, 'preview.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(staging.readPreview('p1')))));

  const frais = createStaging(adapter);
  await frais.regenPreview(project());

  assert.equal(fs.existsSync(path.join(dir, 'preview.bin')), true);
  assert.equal(fs.existsSync(path.join(dir, 'preview.json.gz')), false,
    'deux fichiers pour la même chose finiraient par diverger');
});

// ── Chemin parallèle ────────────────────────────────────────────────────────

test('une opération colonne-locale sur plusieurs régions passe par les fils, et donne le même résultat', async () => {
  const { closePool } = await import('../src/worldedit/regionPool.js');
  const { blankRegions } = await import('../src/staging/index.js');
  const { RegionStore } = await import('../src/worldedit/regionStore.js');
  const { opTerrain } = await import('../src/worldedit/transform.js');

  // Deux régions, et une sélection à cheval sur leur frontière (x = 512).
  const origin = { x: 0, y: 40, z: 0 };
  const size = { x: 1024, y: 1, z: 128 };
  const seed = () => blankRegions({ origin, size });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-par-'));
  roots.push(root);
  const adapter = new FsAdapter({ root });
  const staging = createStaging(adapter);
  adapter.saveProject({ id: 'par', name: 'Parallèle', min: origin, size: { x: 1024, y: 81, z: 128 } });
  staging.seedRegions('par', seed());

  const selection = sel({ x: 0, y: 40, z: 0 }, { x: 1023, y: 110, z: 127 });
  const params = { style: 'collines', amplitude: 0.7, scale: 0, seed: 7, palette: 'plains', clearAbove: true };

  const res = await staging.applyOperation({
    project: adapter.getProject('par'), operation: 'terrain', params, selection, actor: 't',
  });
  assert.equal(res.parallel, true, 'le chemin parallèle doit être pris ici');
  assert.ok(res.blocksChanged > 0);

  // Référence série, sur les mêmes régions vierges.
  const ref = new RegionStore(seed());
  await ref.warmup(selection);
  const refRes = await opTerrain(ref, selection, params, { yield: async () => {} });
  assert.equal(res.blocksChanged, refRes.blocksChanged, 'même nombre de blocs qu’en série');

  // Et le staging sur disque doit contenir exactement le même relief.
  const relu = staging.loadStore(adapter.getProject('par'));
  await relu.warmup(selection);
  for (const x of [0, 300, 511, 512, 513, 900, 1023]) {
    for (const z of [0, 63, 127]) {
      let hRef = null, hPar = null;
      for (let y = selection.max.y; y >= selection.min.y; y--) {
        if (hRef === null && ref.getBlock(x, y, z)) hRef = y;
        if (hPar === null && relu.getBlock(x, y, z)) hPar = y;
      }
      assert.equal(hPar, hRef, `hauteur différente en (${x}, ${z})`);
    }
  }

  // L'aperçu du projet doit exister et refléter le relief.
  const aperçu = staging.readPreview('par');
  assert.ok(aperçu.count > 0, 'l’aperçu est régénéré après le chemin parallèle');
  await closePool();
});

// ── Block entities ──────────────────────────────────────────────────────────
//
// Le contenu d'un coffre et le texte d'un panneau ne sont PAS dans la grille de
// blocs. Une opération qui recopie des blocs sans eux rend des coffres vides —
// une perte silencieuse, qui ne se voit qu'en jeu, longtemps après.

/** Projet 16³ avec un coffre marqué en (3, 2, 4). */
function projectAvecCoffre() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-be-'));
  roots.push(root);
  const adapter = new FsAdapter({ root });
  const staging = createStaging(adapter);
  const blocks = [];
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) blocks.push({ x, y: 0, z, Name: STONE });
  blocks.push({ x: 3, y: 2, z: 4, Name: 'minecraft:chest' });

  adapter.saveProject({ id: 'be', name: 'Coffre', min: { x: 0, y: 0, z: 0 }, size: { x: 16, y: 16, z: 16 } });
  adapter.attachSource('be', {
    name: 'r.0.0.mca',
    buffer: buildRegion(blocks, {
      blockEntities: [{ id: 'minecraft:chest', x: 3, y: 2, z: 4, marque: 'diamants' }],
    }),
  });
  return { adapter, staging, project: () => adapter.getProject('be') };
}

test('le store voit les block entities et les déplace sans les interpréter', async () => {
  const { staging, project } = projectAvecCoffre();
  const store = staging.loadStore(project());
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } };
  await store.warmup(box);

  const trouvees = store.listBlockEntities(box);
  assert.equal(trouvees.length, 1);
  assert.deepEqual({ x: trouvees[0].x, y: trouvees[0].y, z: trouvees[0].z }, { x: 3, y: 2, z: 4 });
  assert.equal(trouvees[0].entry.marque.value, 'diamants', 'le contenu traverse intact');

  // Une boîte qui ne la contient pas ne doit pas la voir.
  assert.equal(store.listBlockEntities({ min: { x: 8, y: 0, z: 8 }, max: { x: 15, y: 15, z: 15 } }).length, 0);
});

test('poser une entrée remplace celle qui occupait la case', async () => {
  const { staging, project } = projectAvecCoffre();
  const store = staging.loadStore(project());
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } };
  await store.warmup(box);

  const [{ entry }] = store.listBlockEntities(box);
  // Deux block entities sur la même case n'ont pas de sens : Minecraft n'en
  // lirait qu'une, et laquelle est indéfini.
  store.putBlockEntity(3, 2, 4, { ...entry, marque: { type: 'string', value: 'charbon' } });
  const apres = store.listBlockEntities(box);
  assert.equal(apres.length, 1);
  assert.equal(apres[0].entry.marque.value, 'charbon');

  assert.equal(store.removeBlockEntity(3, 2, 4), true);
  assert.equal(store.listBlockEntities(box).length, 0);
  assert.equal(store.removeBlockEntity(3, 2, 4), false, 'retirer deux fois ne ment pas');
});

test('l’export décalé emporte le coffre AVEC son contenu', async () => {
  // C'était la perte annoncée dans la documentation : l'export avec décalage
  // reconstruisait le build depuis la seule grille de blocs.
  const { staging, project } = projectAvecCoffre();
  const out = await staging.exportBuild(project(), { dx: 32, dy: 5, dz: 16 });

  assert.equal(out.carried.blockEntities, 1, 'l’export annonce ce qu’il a emporté');

  const entities = await readBackEntities(out.buffer, { regionX: 0, regionZ: 0 });
  assert.equal(entities.size, 1);
  const dep = entities.get('35,7,20'); // (3,2,4) + (32,5,16)
  assert.ok(dep, `coffre absent en (35, 7, 20) ; présents : ${[...entities.keys()].join(' ')}`);
  assert.equal(dep.id, 'minecraft:chest');
  assert.equal(dep.marque, 'diamants', 'le contenu a suivi le bloc');

  // Et le bloc lui-même est bien au même endroit que son entrée.
  const blocs = await readBack(out.buffer);
  assert.equal(blocs.get('35,7,20')?.Name, 'minecraft:chest');
});

test('l’export sans décalage reste lossless, entrées comprises', async () => {
  const { staging, project } = projectAvecCoffre();
  const out = await staging.exportBuild(project(), null);
  const entities = await readBackEntities(out.buffer);
  assert.equal(entities.get('3,2,4')?.marque, 'diamants');
});

test('les opérations qui DÉPLACENT des blocs emportent leurs block entities', async () => {
  // Sans ça, faire pivoter un build laisse tous les coffres derrière : les
  // blocs bougent, leur contenu reste sur place. Une corruption silencieuse
  // qu'on ne découvre qu'en jeu.
  const cas = [
    ['translate', { dx: 5, dy: 1, dz: 2 }, '8,3,6'],
    ['mirror', { axis: 'x' }, '12,2,4'],   // x local 3 → 15-3 = 12
    ['rotate', { degrees: 90 }, '11,2,3'], // (3,4) → (15-4, 3)
  ];

  for (const [operation, params, attendu] of cas) {
    const { staging, project } = projectAvecCoffre();
    await staging.applyOperation({
      project: project(), operation, params,
      selection: sel({ x: 0, y: 0, z: 0 }, { x: 15, y: 15, z: 15 }), actor: 't',
    });
    const out = await staging.exportBuild(project(), null);
    const entities = await readBackEntities(out.buffer);
    const blocs = await readBack(out.buffer);

    assert.equal(entities.size, 1, `${operation} : une entrée et une seule`);
    assert.ok(entities.has(attendu),
      `${operation} : coffre attendu en ${attendu}, trouvé en ${[...entities.keys()].join(' ')}`);
    assert.equal(entities.get(attendu).marque, 'diamants', `${operation} : contenu perdu`);
    assert.equal(blocs.get(attendu)?.Name, 'minecraft:chest',
      `${operation} : l’entrée doit être là où est le bloc`);
  }
});

test('stack répète le coffre ET son contenu', async () => {
  const { staging, project } = projectAvecCoffre();
  await staging.applyOperation({
    project: project(), operation: 'stack', params: { count: 2, direction: 'up' },
    selection: sel({ x: 0, y: 0, z: 0 }, { x: 15, y: 3, z: 15 }), actor: 't',
  });
  const out = await staging.exportBuild(project(), null);
  const entities = await readBackEntities(out.buffer);

  // L'original en y=2, plus une copie par répétition (hauteur de sélection 4).
  for (const y of [2, 6, 10]) {
    assert.ok(entities.has(`3,${y},4`), `copie manquante en y=${y} ; présentes : ${[...entities.keys()].join(' ')}`);
    assert.equal(entities.get(`3,${y},4`).marque, 'diamants');
  }
});

test('un bloc qui remplace un coffre n’en garde pas le contenu', async () => {
  const { staging, project } = projectAvecCoffre();
  await staging.applyOperation({
    project: project(), operation: 'set', params: { block: { name: STONE } },
    selection: ONE(3, 2, 4), actor: 't',
  });
  const out = await staging.exportBuild(project(), null);
  const entities = await readBackEntities(out.buffer);
  assert.equal(entities.size, 0, 'un coffre fantôme réapparaîtrait sous le bloc suivant');
});

// ── Nom de fichier bricolé ──────────────────────────────────────────────────
//
// Un nom de fichier est une métadonnée qui peut mentir : Windows renomme un
// téléchargement en double `r.0.0 (16).mca`. Refuser le fichier pour son nom
// alors que ses coordonnées sont lisibles DEDANS, c'est refuser un fichier
// parfaitement valide — et c'est ce qui arrivait.

test('regionCoordsFromContent lit les coordonnées dans le fichier', async () => {
  const { regionCoordsFromContent } = await import('../src/anvil/index.js');
  // La fixture construit un chunk (0,0) : région 0,0.
  const buf = buildRegion([{ x: 1, y: 1, z: 1, Name: STONE }]);
  assert.deepEqual(await regionCoordsFromContent(buf), { regionX: 0, regionZ: 0 });
});

test('regionCoordsFromContent rend null sur ce qui n’est pas une région', async () => {
  const { regionCoordsFromContent } = await import('../src/anvil/index.js');
  assert.equal(await regionCoordsFromContent(Buffer.alloc(0)), null);
  assert.equal(await regionCoordsFromContent(Buffer.from('pas une région')), null);
});

test('resolveRegionCoords préfère le nom, et retombe sur le contenu', async () => {
  const { staging } = makeProject();
  const buf = buildRegion([{ x: 1, y: 1, z: 1, Name: STONE }]);

  // Nom canonique : lu directement, sans décoder.
  assert.deepEqual(await staging.resolveRegionCoords('r.3.-2.mca', buf), { regionX: 3, regionZ: -2 });

  // Noms que Windows ou un utilisateur produisent : le contenu tranche.
  for (const nom of ['r.0.0 (16).mca', 'ma région.mca', 'copie de r.0.0.mca', '']) {
    assert.deepEqual(await staging.resolveRegionCoords(nom, buf), { regionX: 0, regionZ: 0 }, nom);
  }

  // Et rien de lisible nulle part : on le dit, on ne devine pas.
  assert.equal(await staging.resolveRegionCoords('inconnu.mca', Buffer.from('vide')), null);
});

// ── Emprise resserrée sur le contenu ────────────────────────────────────────

test('deriveSparse distingue la boîte DEMANDÉE des blocs TROUVÉS', async () => {
  const { RegionStore } = await import('../src/worldedit/regionStore.js');
  // Quatre blocs groupés dans un coin d'une région de 512.
  const store = new RegionStore([{
    regionX: 0, regionZ: 0,
    buffer: buildRegion([
      { x: 3, y: 4, z: 5, Name: STONE },
      { x: 6, y: 4, z: 5, Name: STONE },
      { x: 3, y: 9, z: 8, Name: OAK },
    ]),
  }]);
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } };
  await store.warmup(box);
  const sparse = store.deriveSparse(box, 1e6, { truncate: true });

  // La boîte demandée reste le repère des coordonnées de `blocks`.
  assert.deepEqual(sparse.min, { x: 0, y: 0, z: 0 });
  assert.deepEqual(sparse.size, { x: 16, y: 16, z: 16 });
  // Les bornes du contenu, elles, serrent les trois blocs.
  assert.deepEqual(sparse.bounds, {
    min: { x: 3, y: 4, z: 5 },
    max: { x: 6, y: 9, z: 8 },
  });
});

test('contentBounds serre le contenu, et est INDIFFÉRENT au budget d’aperçu', async () => {
  const { RegionStore } = await import('../src/worldedit/regionStore.js');
  const store = new RegionStore([{
    regionX: 0, regionZ: 0,
    buffer: buildRegion([
      { x: 3, y: 4, z: 5, Name: STONE },
      { x: 6, y: 4, z: 5, Name: STONE },
      { x: 3, y: 9, z: 8, Name: OAK },
    ]),
  }]);
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } };
  await store.warmup(box);

  assert.deepEqual(store.contentBounds(box), { min: { x: 3, y: 4, z: 5 }, max: { x: 6, y: 9, z: 8 } });

  // Le point de la manœuvre : `deriveSparse` TRONQUE et ses bornes ne valent
  // alors plus qu'une borne inférieure. Une région de vrai terrain dépasse le
  // budget d'un ordre de grandeur — resserrer une emprise dessus couperait le
  // build là où le balayage s'est arrêté.
  const tronque = store.deriveSparse(box, 1, { truncate: true });
  assert.equal(tronque.truncated, true);
  assert.notDeepEqual(tronque.bounds, store.contentBounds(box));
  assert.deepEqual(store.contentBounds(box), { min: { x: 3, y: 4, z: 5 }, max: { x: 6, y: 9, z: 8 } });
});

test('contentBounds : ses raccourcis rendent la MÊME chose qu’un balayage complet', async () => {
  // `contentBounds` saute les sections tout-air, prend la boîte entière d'une
  // section tout-plein, et ignore celles déjà comprises dans les bornes
  // acquises. Trois raccourcis, donc trois façons de se tromper : la seule
  // preuve utile est la comparaison au balayage sans raccourci de
  // `deriveSparse`, budget grand ouvert.
  const regions = blankRegions({ origin: { x: 0, y: 0, z: 0 }, size: { x: 1024, y: 1, z: 32 } });
  const store = new RegionStore(regions);
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1023, y: 47, z: 31 } };
  await store.warmup(box);

  // Une section ENTIÈREMENT pleine (le raccourci « aucun air »)…
  for (let y = 16; y < 32; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    store.setBlock(x, y, z, { Name: STONE, Properties: null });
  }
  // …des blocs épars, dont un dans la SECONDE région, plus loin que tout le
  // reste, et un autre plus haut.
  for (const [x, y, z] of [[5, 3, 7], [900, 40, 21], [17, 45, 3], [600, 2, 30]]) {
    store.setBlock(x, y, z, { Name: OAK, Properties: null });
  }

  const complet = store.deriveSparse(box, 1e9).bounds;
  assert.deepEqual(store.contentBounds(box), complet);
  assert.deepEqual(complet, { min: { x: 0, y: 2, z: 0 }, max: { x: 900, y: 45, z: 30 } });
});

test('contentBounds clipe sur la boîte demandée et ne rend rien si elle est vide', async () => {
  const { RegionStore } = await import('../src/worldedit/regionStore.js');
  const store = new RegionStore([{
    regionX: 0, regionZ: 0,
    buffer: buildRegion([{ x: 2, y: 1, z: 2, Name: STONE }, { x: 12, y: 1, z: 12, Name: STONE }]),
  }]);
  await store.warmup({ min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } });

  assert.deepEqual(
    store.contentBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 7, y: 15, z: 7 } }),
    { min: { x: 2, y: 1, z: 2 }, max: { x: 2, y: 1, z: 2 } },
    'le bloc hors de la boîte demandée ne compte pas',
  );
  assert.equal(store.contentBounds({ min: { x: 4, y: 0, z: 4 }, max: { x: 9, y: 15, z: 9 } }), null);
});

test('une zone vide n’invente pas de bornes', async () => {
  const { RegionStore } = await import('../src/worldedit/regionStore.js');
  const store = new RegionStore([{ regionX: 0, regionZ: 0, buffer: buildRegion([{ x: 0, y: 0, z: 0, Name: STONE }]) }]);
  const vide = { min: { x: 8, y: 8, z: 8 }, max: { x: 15, y: 15, z: 15 } };
  await store.warmup({ min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } });
  const sparse = store.deriveSparse(vide, 1e6, { truncate: true });
  assert.equal(sparse.count, 0);
  assert.equal(sparse.bounds, null, 'null, pas une boîte inversée à l’infini');
});
