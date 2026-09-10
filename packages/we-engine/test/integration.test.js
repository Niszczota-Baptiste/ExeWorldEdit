import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsAdapter } from '../src/storage/index.js';
import { createStaging, blankRegions, schematicToRegions, volumeToSchematic } from '../src/staging/index.js';
import { readSaveInfo, applyToWorld, worldOverview, regionsForBBox, readRegions } from '../src/world/index.js';
import { RegionStore } from '../src/worldedit/regionStore.js';
import { schematicToSponge } from '../src/worldedit/schematicFormats.js';
import { buildRegion } from './fixtures/region.js';

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

test('parcours complet : n’ouvrir qu’une zone d’un monde qui en compte beaucoup', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'we-integration-'));
  roots.push(tmp);
  const save = path.join(tmp, 'Grand Monde');
  fs.mkdirSync(path.join(save, 'region'), { recursive: true });
  fs.writeFileSync(path.join(save, 'level.dat'), Buffer.from([0x1f, 0x8b]));

  // 25 régions : c'est la situation normale d'un monde joué, et tout charger
  // serait exactement le défaut qu'on corrige.
  const explored = [];
  for (let rz = -2; rz <= 2; rz++) {
    for (let rx = -2; rx <= 2; rx++) {
      explored.push([rx, rz]);
      fs.writeFileSync(
        path.join(save, 'region', `r.${rx}.${rz}.mca`),
        buildRegion([{ x: 0, y: 0, z: 0, Name: STONE }]),
      );
    }
  }

  const info = readSaveInfo(save);
  const map = worldOverview(info);
  assert.equal(map.count, 25);
  assert.deepEqual(map.bounds, { minX: -2, maxX: 2, minZ: -2, maxZ: 2 });

  // La zone demandée : autour de l'origine, 600 blocs de côté. Elle recoupe
  // quatre régions — pas vingt-cinq.
  const area = { min: { x: -100, z: -100 }, max: { x: 600, z: 600 } };
  const wanted = regionsForBBox(area);
  assert.deepEqual(
    wanted.map((r) => `${r.regionX},${r.regionZ}`).sort(),
    ['-1,-1', '-1,0', '-1,1', '0,-1', '0,0', '0,1', '1,-1', '1,0', '1,1'].filter((k) => {
      const [x, z] = k.split(',').map(Number);
      return x >= -1 && x <= 1 && z >= -1 && z <= 1;
    }).sort(),
  );

  const adapter = new FsAdapter({ root: path.join(tmp, 'donnees') });
  const staging = createStaging(adapter);
  adapter.saveProject({
    id: 'w1', name: info.name,
    min: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 },
    world: { path: info.root, kind: info.kind },
  });
  staging.seedRegions('w1', readRegions(info, wanted));

  const loaded = staging.listRegionFiles('w1');
  assert.equal(loaded.length, 9, 'seules les régions de la zone sont matérialisées');
  assert.equal(fs.readdirSync(info.regionDir).length, 25, 'et la save, elle, garde ses 25');

  // Étendre ensuite : les régions déjà là ne sont pas rechargées.
  // La zone X 600→1100, Z 0→500 recoupe r.1.0 et r.2.0 ; la première est déjà
  // chargée, donc une seule s'ajoute.
  const dejaLa = new Set(loaded.map((f) => `${f.regionX},${f.regionZ}`));
  const viseesParLExtension = regionsForBBox({ min: { x: 600, z: 0 }, max: { x: 1100, z: 500 } });
  assert.deepEqual(
    viseesParLExtension.map((r) => `${r.regionX},${r.regionZ}`).sort(),
    ['1,0', '2,0'],
  );

  const nouvelles = viseesParLExtension.filter((r) => !dejaLa.has(`${r.regionX},${r.regionZ}`));
  assert.deepEqual(nouvelles.map((r) => `${r.regionX},${r.regionZ}`), ['2,0'], 'r.1.0 était déjà là');

  staging.seedRegions('w1', readRegions(info, nouvelles));
  assert.equal(staging.listRegionFiles('w1').length, 10, 'une région ajoutée, aucune rechargée');
});
