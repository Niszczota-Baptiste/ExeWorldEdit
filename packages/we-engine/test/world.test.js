import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSaveInfo, listRegions, probeWorldLock, backupRegions, applyToWorld } from '../src/world/save.js';
import { extractMcaEntries } from '../src/worldedit/zipReader.js';
import { buildRegion, readBack } from './fixtures/region.js';

// Écrire dans la save de quelqu'un est l'opération la plus dangereuse du
// moteur : ces tests portent surtout sur les REFUS, parce que c'est là qu'une
// régression coûte un monde.

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function makeSave({ withEntities = false, withLock = true, regions = [[0, 0]] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-world-'));
  roots.push(root);
  const save = path.join(root, 'Ma Partie');
  fs.mkdirSync(path.join(save, 'region'), { recursive: true });
  fs.writeFileSync(path.join(save, 'level.dat'), Buffer.from([0x1f, 0x8b]));
  if (withLock) fs.writeFileSync(path.join(save, 'session.lock'), '☃');
  if (withEntities) fs.mkdirSync(path.join(save, 'entities'), { recursive: true });
  for (const [rx, rz] of regions) {
    const buf = buildRegion([{ x: 0, y: 0, z: 0, Name: 'minecraft:stone' }]);
    fs.writeFileSync(path.join(save, 'region', `r.${rx}.${rz}.mca`), buf);
    if (withEntities) fs.writeFileSync(path.join(save, 'entities', `r.${rx}.${rz}.mca`), buf);
  }
  return { root, save };
}

// ── Reconnaître ce qu'on ouvre ──────────────────────────────────────────────

test('un dossier de save est reconnu, avec ses sous-dossiers', () => {
  const { save } = makeSave({ withEntities: true });
  const info = readSaveInfo(save);
  assert.equal(info.kind, 'save');
  assert.equal(info.name, 'Ma Partie');
  assert.ok(info.regionDir.endsWith('region'));
  assert.ok(info.entitiesDir.endsWith('entities'));
  assert.ok(info.sessionLock.endsWith('session.lock'));
});

test('un monde sans dossier entities/ le signale par null, pas par une erreur', () => {
  const { save } = makeSave({ withEntities: false });
  assert.equal(readSaveInfo(save).entitiesDir, null);
});

test('un dossier region/ isolé est reconnu comme tel', () => {
  const { save } = makeSave();
  const info = readSaveInfo(path.join(save, 'region'));
  assert.equal(info.kind, 'region');
  assert.equal(info.sessionLock, null, 'pas de level.dat, donc pas de verrou à chercher');
  assert.equal(info.regionDir, info.root);
});

test('un dossier quelconque n’est pas pris pour un monde', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-world-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'rien à voir');
  const info = readSaveInfo(root);
  assert.equal(info.kind, 'unknown');
  assert.equal(info.regionDir, null);
});

test('listRegions ne retient que les vrais noms de région', () => {
  const { save } = makeSave({ regions: [[0, 0], [-1, 2]] });
  const dir = path.join(save, 'region');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'r.bidon.mca'), 'x');
  const found = listRegions(dir).map((r) => `${r.regionX},${r.regionZ}`).sort();
  assert.deepEqual(found, ['-1,2', '0,0']);
});

// ── Le verrou ───────────────────────────────────────────────────────────────

test('un session.lock verrouillé est détecté, et ce verdict est fiable partout', () => {
  const { save } = makeSave();
  const info = readSaveInfo(save);
  // Minecraft tient le fichier : l'ouverture en écriture échoue.
  const busy = () => { const e = new Error('resource busy'); e.code = 'EBUSY'; throw e; };
  const lock = probeWorldLock(info, { open: busy });
  assert.equal(lock.locked, true);
  assert.equal(lock.reliable, true, 'un refus d’écriture est concluant, quelle que soit la plateforme');
});

test('un session.lock libre ne prouve rien hors de Windows', () => {
  const { save } = makeSave();
  const lock = probeWorldLock(readSaveInfo(save), { open: () => {} });
  assert.equal(lock.locked, false);
  // Le verrou POSIX est consultatif : sur Linux et macOS, une ouverture qui
  // réussit ne dit pas que Minecraft est fermé.
  assert.equal(lock.reliable, process.platform === 'win32');
});

test('pas de session.lock du tout : rien ne tient le monde', () => {
  const { save } = makeSave({ withLock: false });
  const lock = probeWorldLock(readSaveInfo(save), { open: () => {} });
  assert.equal(lock.locked, false);
  assert.equal(lock.reason, 'no_lock_file');
});

// ── La sauvegarde ───────────────────────────────────────────────────────────

test('la sauvegarde ne prend que les régions réécrites, blocs ET entités', () => {
  const { root, save } = makeSave({ withEntities: true, regions: [[0, 0], [1, 0]] });
  const info = readSaveInfo(save);
  const out = path.join(root, 'sauvegardes');

  const backup = backupRegions({ info, keys: [{ regionX: 0, regionZ: 0 }], outDir: out });
  assert.equal(backup.entries, 2, 'la région de blocs et celle d’entités');
  assert.ok(fs.existsSync(backup.file));
  assert.ok(backup.file.includes('Ma Partie'), 'le nom du monde apparaît dans le fichier');
  assert.match(path.basename(backup.file), /\d{4}-\d{2}-\d{2}T/, 'et un horodatage');
});

test('sauvegarder une région absente ne crée pas d’archive vide', () => {
  const { root, save } = makeSave();
  const info = readSaveInfo(save);
  // r.9.9 n'existe pas : il n'y a rien à restaurer, donc rien à sauvegarder.
  const backup = backupRegions({ info, keys: [{ regionX: 9, regionZ: 9 }], outDir: path.join(root, 'sauvegardes') });
  assert.equal(backup, null);
});

test('deux sauvegardes successives ne s’écrasent pas', () => {
  const { root, save } = makeSave();
  const info = readSaveInfo(save);
  const out = path.join(root, 'sauvegardes');
  const a = backupRegions({ info, keys: [{ regionX: 0, regionZ: 0 }], outDir: out, now: new Date('2026-01-01T10:00:00Z') });
  const b = backupRegions({ info, keys: [{ regionX: 0, regionZ: 0 }], outDir: out, now: new Date('2026-01-01T11:30:00Z') });
  assert.notEqual(a.file, b.file);
  assert.equal(fs.readdirSync(out).length, 2);
});

// ── L'application ───────────────────────────────────────────────────────────

const OAK = 'minecraft:oak_planks';
const newRegion = () => ({
  regionX: 0, regionZ: 0,
  buffer: buildRegion([{ x: 5, y: 5, z: 5, Name: OAK }]),
});

test('appliquer écrit la région et laisse une sauvegarde derrière', async () => {
  const { root, save } = makeSave();
  const info = readSaveInfo(save);
  const res = applyToWorld({
    info, regions: [newRegion()], backupDir: path.join(root, 'sauvegardes'),
    force: true, io: { open: () => {} },
  });

  assert.equal(res.written, 1);
  assert.ok(res.backup, 'une sauvegarde a bien été prise');

  const written = await readBack(fs.readFileSync(path.join(save, 'region', 'r.0.0.mca')));
  assert.equal(written.get('5,5,5').Name, OAK);
});

test('un monde ouvert dans Minecraft est refusé, et rien n’est écrit', () => {
  const { root, save } = makeSave();
  const info = readSaveInfo(save);
  const avant = fs.readFileSync(path.join(save, 'region', 'r.0.0.mca'));
  const busy = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };

  assert.throws(
    () => applyToWorld({ info, regions: [newRegion()], backupDir: path.join(root, 'sauvegardes'), io: { open: busy } }),
    /world_busy/,
  );

  assert.deepEqual(fs.readFileSync(path.join(save, 'region', 'r.0.0.mca')), avant, 'la région est intacte');
  assert.equal(fs.existsSync(path.join(root, 'sauvegardes')), false, 'et aucune sauvegarde inutile n’a été créée');
});

test('un verrou invérifiable bloque tant que l’utilisateur n’a pas confirmé', () => {
  const { root, save } = makeSave();
  const info = readSaveInfo(save);
  const call = (force) => applyToWorld({
    info, regions: [newRegion()], backupDir: path.join(root, 'sauvegardes'),
    force, io: { open: () => {} },
  });

  if (process.platform === 'win32') {
    // Sur Windows la détection est fiable : rien à confirmer.
    assert.equal(call(false).written, 1);
  } else {
    assert.throws(() => call(false), /lock_unverifiable/);
    assert.equal(call(true).written, 1, 'confirmé, l’écriture passe');
  }
});

test('une cible sans dossier region/ est refusée', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-world-'));
  roots.push(root);
  assert.throws(
    () => applyToWorld({ info: readSaveInfo(root), regions: [newRegion()], backupDir: root, force: true }),
    /no_region_dir/,
  );
});

test('la sauvegarde est prise AVANT l’écriture, jamais après', async () => {
  const { root, save } = makeSave();
  const info = readSaveInfo(save);
  const out = path.join(root, 'sauvegardes');
  const original = fs.readFileSync(path.join(save, 'region', 'r.0.0.mca'));

  const res = applyToWorld({ info, regions: [newRegion()], backupDir: out, force: true, io: { open: () => {} } });

  // On relit vraiment l'archive : ça prouve à la fois qu'elle est lisible et
  // qu'elle contient l'état d'AVANT. Une sauvegarde prise après l'écriture
  // archiverait la nouvelle version et ne servirait strictement à rien.
  const archived = extractMcaEntries(fs.readFileSync(res.backup.file));
  assert.equal(archived.length, 1);
  assert.deepEqual(archived[0].data, original, 'l’archive contient la région telle qu’elle était');

  const maintenant = fs.readFileSync(path.join(save, 'region', 'r.0.0.mca'));
  assert.notDeepEqual(maintenant, original, 'et le monde, lui, a bien changé');
  const relu = await readBack(maintenant);
  assert.equal(relu.get('5,5,5').Name, OAK);
});
