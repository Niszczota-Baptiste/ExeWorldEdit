import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsAdapter, StorageAdapter, defaultRoot } from '../src/storage/index.js';

// Suite de CONTRAT : elle ne teste pas FsAdapter, elle teste ce qu'un
// StorageAdapter doit garantir. Un futur adapter (SQLite côté site, par
// exemple) se branche ici et doit passer les mêmes assertions — c'est ce qui
// donne son sens à l'interface.
function contractSuite(label, makeAdapter) {
  test(`${label} — un projet enregistré se relit à l'identique`, () => {
    const a = makeAdapter();
    const saved = a.saveProject({ id: 'p1', name: 'Muraille', min: { x: -32, y: 60, z: 16 }, size: { x: 64, y: 20, z: 48 } });
    const read = a.getProject('p1');
    assert.equal(read.name, 'Muraille');
    assert.deepEqual(read.min, { x: -32, y: 60, z: 16 });
    assert.deepEqual(read.size, { x: 64, y: 20, z: 48 });
    assert.equal(read.id, saved.id);
  });

  test(`${label} — un projet inconnu renvoie null, jamais une exception`, () => {
    const a = makeAdapter();
    assert.equal(a.getProject('jamais-vu'), null);
  });

  test(`${label} — saveExtent convertit une boîte inclusive en min+size`, () => {
    const a = makeAdapter();
    a.saveProject({ id: 'p1', name: 'x', min: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } });
    a.saveExtent('p1', { min: { x: -5, y: -64, z: 10 }, max: { x: 4, y: -60, z: 10 } });
    const p = a.getProject('p1');
    assert.deepEqual(p.min, { x: -5, y: -64, z: 10 });
    // max inclus ⇒ size = max - min + 1, y compris sur un axe d'épaisseur 1.
    assert.deepEqual(p.size, { x: 10, y: 5, z: 1 });
  });

  test(`${label} — la source est relue octet pour octet`, () => {
    const a = makeAdapter();
    a.saveProject({ id: 'p1', name: 'x' });
    const buf = Buffer.from([0, 1, 2, 253, 254, 255]);
    a.attachSource('p1', { name: 'r.-1.2.mca', buffer: buf });
    assert.deepEqual(a.readSource(a.getProject('p1')), buf);
  });

  test(`${label} — un projet sans source lève no_source`, () => {
    const a = makeAdapter();
    const p = a.saveProject({ id: 'p1', name: 'x' });
    assert.throws(() => a.readSource(p), /no_source/);
  });

  test(`${label} — stagingDir existe au retour et est propre au projet`, () => {
    const a = makeAdapter();
    a.saveProject({ id: 'p1', name: 'x' });
    a.saveProject({ id: 'p2', name: 'y' });
    const d1 = a.stagingDir('p1');
    const d2 = a.stagingDir('p2');
    assert.ok(fs.existsSync(d1) && fs.statSync(d1).isDirectory());
    assert.notEqual(d1, d2);
  });

  test(`${label} — le journal ressort le plus récent en premier`, () => {
    const a = makeAdapter();
    a.saveProject({ id: 'p1', name: 'x' });
    a.appendAudit({ projectId: 'p1', actor: 'moi', operation: 'set', blocksChanged: 3, durationMs: 10 });
    a.appendAudit({ projectId: 'p1', actor: 'moi', operation: 'mirror', blocksChanged: 7, durationMs: 20 });
    const rows = a.listAudit('p1');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].operation, 'mirror');
    assert.equal(rows[0].blocksChanged, 7);
    assert.ok(rows[0].createdAt, 'createdAt posé par l’adapter');
  });

  test(`${label} — le journal respecte la limite demandée`, () => {
    const a = makeAdapter();
    a.saveProject({ id: 'p1', name: 'x' });
    for (let i = 0; i < 10; i++) a.appendAudit({ projectId: 'p1', operation: `op${i}` });
    const rows = a.listAudit('p1', 3);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].operation, 'op9');
  });

  test(`${label} — journal vide pour un projet qui n'a rien fait`, () => {
    const a = makeAdapter();
    a.saveProject({ id: 'p1', name: 'x' });
    assert.deepEqual(a.listAudit('p1'), []);
  });

  test(`${label} — bibliothèque : ranger, lister, relire, supprimer`, () => {
    const a = makeAdapter();
    const blob = Buffer.from('contenu-opaque-du-schematic');
    const meta = a.putSchematic('s', { name: 'tour', sx: 5, sy: 12, sz: 5, blockCount: 200 }, blob);
    assert.ok(meta.id);
    assert.equal(meta.name, 'tour');
    assert.equal(meta.blockCount, 200);

    assert.equal(a.listSchematics('s').length, 1);
    assert.deepEqual(a.getSchematicBlob('s', meta.id), blob);
    assert.equal(a.getSchematicMeta('s', meta.id).name, 'tour');

    a.deleteSchematic('s', meta.id);
    assert.equal(a.listSchematics('s').length, 0);
    assert.throws(() => a.getSchematicBlob('s', meta.id), /not_found/);
  });

  test(`${label} — les scopes de bibliothèque ne se voient pas`, () => {
    const a = makeAdapter();
    a.putSchematic('alpha', { name: 'a' }, Buffer.from('a'));
    a.putSchematic('beta', { name: 'b' }, Buffer.from('b'));
    assert.deepEqual(a.listSchematics('alpha').map((m) => m.name), ['a']);
    assert.deepEqual(a.listSchematics('beta').map((m) => m.name), ['b']);
  });

  test(`${label} — supprimer un schematic inconnu lève not_found`, () => {
    const a = makeAdapter();
    assert.throws(() => a.deleteSchematic('s', 'inexistant'), /not_found/);
  });

  test(`${label} — supprimer un projet efface aussi son staging`, () => {
    const a = makeAdapter();
    a.saveProject({ id: 'p1', name: 'x' });
    const dir = a.stagingDir('p1');
    fs.writeFileSync(path.join(dir, 'temoin'), 'x');
    a.removeProject('p1');
    assert.equal(a.getProject('p1'), null);
    assert.equal(fs.existsSync(dir), false);
  });
}

// ── FsAdapter ───────────────────────────────────────────────────────────────

const roots = [];
const tmpAdapter = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-engine-'));
  roots.push(root);
  return new FsAdapter({ root });
};
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

contractSuite('FsAdapter', tmpAdapter);

test('FsAdapter — un id de projet ne peut pas s’échapper de la racine', () => {
  const a = tmpAdapter();
  // Sans ça, un projet nommé « ../.. » écrirait n'importe où sur le disque.
  for (const bad of ['../evil', '..', '.', '/etc', 'a/b', '']) {
    assert.throws(() => a.projectDir(bad), /invalid_project_id/, `id refusé : ${JSON.stringify(bad)}`);
  }
});

test('FsAdapter — un nom de source ne peut pas s’échapper du dossier du projet', () => {
  const a = tmpAdapter();
  a.saveProject({ id: 'p1', name: 'x' });
  const p = a.attachSource('p1', { name: '../../../../etc/passwd', buffer: Buffer.from('x') });
  assert.ok(!p.source.file.includes('/'), 'le chemin est aplati en un simple nom');
  assert.ok(!p.source.file.startsWith('.'), 'pas de fichier caché ni de ..');
  // Le nom d'origine reste consultable, mais il ne sert jamais de chemin.
  assert.equal(p.source.name, '../../../../etc/passwd');
});

test('FsAdapter — listProjects ne renvoie que des projets valides', () => {
  const a = tmpAdapter();
  a.saveProject({ id: 'p1', name: 'un' });
  a.saveProject({ id: 'p2', name: 'deux' });
  // Un dossier parasite sans project.json ne doit pas casser le listing.
  fs.mkdirSync(path.join(a.projectsRoot, 'parasite'), { recursive: true });
  const names = a.listProjects().map((p) => p.name).sort();
  assert.deepEqual(names, ['deux', 'un']);
});

test('FsAdapter — une ligne de journal tronquée par un crash n’empêche pas de lire les autres', () => {
  const a = tmpAdapter();
  a.saveProject({ id: 'p1', name: 'x' });
  a.appendAudit({ projectId: 'p1', operation: 'set' });
  // Simule une écriture interrompue en fin de fichier.
  fs.appendFileSync(path.join(a.projectDir('p1'), 'audit.jsonl'), '{"operation":"mirr');
  const rows = a.listAudit('p1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation, 'set');
});

test('FsAdapter — un project.json corrompu ne fait pas tomber la lecture', () => {
  const a = tmpAdapter();
  a.saveProject({ id: 'p1', name: 'x' });
  fs.writeFileSync(path.join(a.projectDir('p1'), 'project.json'), '{ pas du json');
  assert.equal(a.getProject('p1'), null);
});

test('defaultRoot pointe sur un emplacement applicatif nommé', () => {
  const root = defaultRoot('MonApp');
  assert.ok(path.isAbsolute(root));
  assert.equal(path.basename(root), 'MonApp');
});

test('StorageAdapter nu : chaque méthode dit laquelle manque', () => {
  const bare = new StorageAdapter();
  assert.throws(() => bare.getProject('x'), /StorageAdapter\.getProject/);
  assert.throws(() => bare.stagingDir('x'), /StorageAdapter\.stagingDir/);
  assert.throws(() => bare.appendAudit({}), /StorageAdapter\.appendAudit/);
  assert.throws(() => bare.listSchematics('s'), /StorageAdapter\.listSchematics/);
});

test('FsAdapter — la save d’origine reste attachée au projet', () => {
  const a = tmpAdapter();
  a.saveProject({ id: 'p1', name: 'Monde', world: { path: '/chemin/vers/Ma Partie', kind: 'save' } });
  // Sans ça, « Appliquer au monde » ne saurait plus où appliquer après un
  // redémarrage de l'application.
  assert.deepEqual(a.getProject('p1').world, { path: '/chemin/vers/Ma Partie', kind: 'save' });

  // Une mise à jour d'emprise ne doit pas la faire disparaître au passage.
  a.saveExtent('p1', { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 9, z: 9 } });
  assert.equal(a.getProject('p1').world.path, '/chemin/vers/Ma Partie');
});

test('FsAdapter — un projet sans monde attaché le dit par null', () => {
  const a = tmpAdapter();
  a.saveProject({ id: 'p1', name: 'Schematic' });
  assert.equal(a.getProject('p1').world, null);
});

// ── Réglages ────────────────────────────────────────────────────────────────

test('FsAdapter — des réglages absents rendent un objet vide, pas null', () => {
  const a = tmpAdapter();
  assert.deepEqual(a.readSettings(), {});
});

test('FsAdapter — écrire des réglages FUSIONNE au lieu de remplacer', () => {
  const a = tmpAdapter();
  a.writeSettings({ theme: 'sombre', textScale: 1 });
  a.writeSettings({ textScale: 1.2 });
  // Sans fusion, un panneau qui ne connaît qu'un réglage effacerait les autres.
  assert.deepEqual(a.readSettings(), { theme: 'sombre', textScale: 1.2 });
});

test('FsAdapter — les réglages survivent à un redémarrage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-engine-'));
  roots.push(root);
  new FsAdapter({ root }).writeSettings({ perf: true });
  assert.equal(new FsAdapter({ root }).readSettings().perf, true);
});

test('FsAdapter — un settings.json corrompu ne fait pas tomber l’application', () => {
  const a = tmpAdapter();
  a.writeSettings({ theme: 'sombre' });
  fs.writeFileSync(path.join(a.root, 'settings.json'), '{ pas du json');
  // Mieux vaut repartir des valeurs par défaut que refuser de démarrer.
  assert.deepEqual(a.readSettings(), {});
  assert.deepEqual(a.writeSettings({ theme: 'clair' }), { theme: 'clair' });
});

// ── Blocs supplémentaires déclarés par l'installation ───────────────────────

test('FsAdapter — pas de blocks.json rend une liste vide, pas null', () => {
  // Le cas NORMAL : la plupart des installations n'en déclarent aucun.
  assert.deepEqual(tmpAdapter().readBlockExtras(), []);
});

test('FsAdapter — blocks.json est rendu tel quel, la validation est ailleurs', () => {
  const a = tmpAdapter();
  fs.writeFileSync(path.join(a.root, 'blocks.json'), JSON.stringify({
    blocks: [{ id: 'minefield:muraille', group: 'minefield' }, 'minefield:arene'],
  }));
  const brut = a.readBlockExtras();
  assert.equal(brut.blocks.length, 2, 'l’adapter ne filtre rien : c’est normalizeExtras qui trie');
});

test('FsAdapter — un blocks.json corrompu ne fait pas tomber l’application', () => {
  const a = tmpAdapter();
  fs.writeFileSync(path.join(a.root, 'blocks.json'), '{ pas du json');
  assert.deepEqual(a.readBlockExtras(), []);
});

test('FsAdapter — le journal conserve le relevé par phase', () => {
  const a = tmpAdapter();
  a.saveProject({ id: 'p1', name: 'x' });
  a.appendAudit({
    projectId: 'p1', operation: 'terrain', durationMs: 900,
    timings: { totalMs: 900, phases: [{ phase: 'load', ms: 700 }, { phase: 'apply', ms: 200 }] },
  });
  const [ligne] = a.listAudit('p1');
  assert.equal(ligne.timings.totalMs, 900);
  assert.deepEqual(ligne.timings.phases[0], { phase: 'load', ms: 700 });
});

test('FsAdapter — une opération sans relevé le dit par null', () => {
  const a = tmpAdapter();
  a.saveProject({ id: 'p1', name: 'x' });
  a.appendAudit({ projectId: 'p1', operation: 'undo' });
  assert.equal(a.listAudit('p1')[0].timings, null);
});
