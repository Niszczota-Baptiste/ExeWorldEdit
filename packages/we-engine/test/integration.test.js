import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsAdapter } from '../src/storage/index.js';
import { createStaging, blankRegions, schematicToRegions, volumeToSchematic } from '../src/staging/index.js';
import { readSaveInfo, applyToWorld } from '../src/world/index.js';
import { RegionStore } from '../src/worldedit/regionStore.js';
import { schematicToSponge } from '../src/worldedit/schematicFormats.js';

// Le parcours complet, de bout en bout : ouvrir une vraie save, l'éditer,
// réécrire dedans, en ressortir un schematic et le rouvrir.
//
// Les tests unitaires couvrent chaque maillon ; celui-ci couvre la CHAÎNE, qui
// est là où les maillons corrects se raccordent mal.

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const STONE = 'minecraft:stone';
const GOLD = 'minecraft:gold_block';

/** Une save Minecraft plausible : level.dat, session.lock, un sol de pierre. */
async function makeRealSave() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'we-integration-'));
  roots.push(tmp);
  const save = path.join(tmp, 'Monde de test');
  fs.mkdirSync(path.join(save, 'region'), { recursive: true });
  fs.writeFileSync(path.join(save, 'level.dat'), Buffer.from([0x1f, 0x8b]));
  fs.writeFileSync(path.join(save, 'session.lock'), '☃');

  const regions = blankRegions({ origin: { x: 0, y: 0, z: 0 }, size: { x: 32, y: 1, z: 32 } });
  const store = new RegionStore(regions);
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 32, z: 31 } };
  await store.warmup(box);
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) store.setBlock(x, 4, z, { Name: STONE, Properties: null });
  for (const [key, buf] of store.commit({ touchedOnly: false })) {
    const [rx, rz] = key.split(',').map(Number);
    fs.writeFileSync(path.join(save, 'region', `r.${rx}.${rz}.mca`), buf);
  }
  return { tmp, save, box };
}

test('parcours complet : ouvrir une save, éditer, réécrire dedans', async () => {
  const { tmp, save, box } = await makeRealSave();
  const info = readSaveInfo(save);
  assert.equal(info.kind, 'save');

  const adapter = new FsAdapter({ root: path.join(tmp, 'donnees') });
  const staging = createStaging(adapter);

  // Ouvrir : les régions de la save deviennent le staging, et la save reste
  // attachée au projet pour qu'on sache plus tard où appliquer.
  adapter.saveProject({
    id: 'w1', name: info.name,
    min: { x: 0, y: 0, z: 0 }, size: { x: 32, y: 8, z: 32 },
    world: { path: info.root, kind: info.kind },
  });
  staging.seedRegions('w1', fs.readdirSync(info.regionDir)
    .filter((f) => /^r\.-?\d+\.-?\d+\.mca$/.test(f))
    .map((f) => {
      const [, rx, rz] = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f);
      return { regionX: +rx, regionZ: +rz, buffer: fs.readFileSync(path.join(info.regionDir, f)) };
    }));

  const project = () => adapter.getProject('w1');
  assert.equal(project().world.path, info.root);

  // Éditer.
  const res = await staging.applyOperation({
    project: project(), operation: 'set',
    params: { block: { name: GOLD } },
    selection: { min: { x: 4, y: 5, z: 4 }, max: { x: 8, y: 5, z: 8 } },
    actor: 'test',
  });
  assert.equal(res.blocksChanged, 25);

  // La save n'a pas encore bougé : tout le travail est resté sur la copie.
  const avant = fs.readFileSync(path.join(save, 'region', 'r.0.0.mca'));
  const relecture = new RegionStore([{ regionX: 0, regionZ: 0, buffer: avant }]);
  await relecture.warmup(box);
  assert.equal(relecture.getBlock(6, 5, 6), null, 'la save est intacte tant qu’on n’a pas appliqué');

  // Appliquer.
  const dir = staging.stagingRegionsDir('w1');
  const regions = staging.listRegionFiles('w1').map((f) => ({
    regionX: f.regionX, regionZ: f.regionZ,
    buffer: fs.readFileSync(path.join(dir, f.file)),
  }));
  const applied = applyToWorld({
    info, regions, backupDir: path.join(tmp, 'sauvegardes'),
    force: true, io: { open: () => {} },
  });
  assert.equal(applied.written, 1);
  assert.ok(applied.backup, 'une sauvegarde a été prise');

  // Relire la save comme le ferait Minecraft.
  const apres = new RegionStore([{
    regionX: 0, regionZ: 0,
    buffer: fs.readFileSync(path.join(save, 'region', 'r.0.0.mca')),
  }]);
  await apres.warmup(box);
  assert.equal(apres.getBlock(6, 5, 6).Name, GOLD, 'le bloc posé est dans la save');
  assert.equal(apres.getBlock(20, 4, 20).Name, STONE, 'et le sol d’origine n’a pas bougé');
});

test('parcours complet : sortir un schematic d’une save et le rouvrir', async () => {
  const { tmp, save, box } = await makeRealSave();
  const info = readSaveInfo(save);
  const adapter = new FsAdapter({ root: path.join(tmp, 'donnees') });
  const staging = createStaging(adapter);

  adapter.saveProject({ id: 'w1', name: info.name, min: { x: 0, y: 0, z: 0 }, size: { x: 32, y: 8, z: 32 } });
  staging.seedRegions('w1', [{
    regionX: 0, regionZ: 0,
    buffer: fs.readFileSync(path.join(info.regionDir, 'r.0.0.mca')),
  }]);

  const store = staging.loadStore(adapter.getProject('w1'));
  await store.warmup(box);

  const sel = { min: { x: 4, y: 4, z: 4 }, max: { x: 8, y: 4, z: 8 } };
  const file = await schematicToSponge(volumeToSchematic(store, sel), { name: 'dalle' });
  const rouvert = await schematicToRegions(file, 'dalle.schem');

  assert.equal(rouvert.blockCount, 25);
  // L'origine du schematic est celle de la sélection : le recoller sans
  // décalage le remet exactement où il a été pris.
  assert.deepEqual(rouvert.origin, { x: 4, y: 4, z: 4 });
  assert.deepEqual(rouvert.sparse.min, { x: 4, y: 4, z: 4 });
  assert.equal(rouvert.sparse.palette[rouvert.sparse.blocks[3]].name, STONE);
});
