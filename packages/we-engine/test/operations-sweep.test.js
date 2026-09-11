import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsAdapter } from '../src/storage/index.js';
import { createStaging, blankRegions } from '../src/staging/index.js';
import { RegionStore } from '../src/worldedit/regionStore.js';
import { OPERATIONS } from '../src/worldedit/operations.js';
import { ECHANTILLONS_UI } from './fixtures/ui-params.js';

// BALAYAGE : chaque opération déclarée est réellement EXÉCUTÉE, avec les
// paramètres tels que l'interface les envoie, et chaque valeur de chaque menu
// déroulant est essayée.
//
// Les tests d'à côté vérifient qu'une opération est branchée (son nom est dans
// deux listes) et que ses paramètres survivent au normaliseur. Aucun ne la
// LANÇAIT. C'est ce qui laissait « Naturaliser → Personnalisé » et « Générer
// terrain → palette Personnalisé » planter sur `s.includes is not a function`
// dès qu'on choisissait ces entrées dans l'interface.
//
// Un bouton de l'interface qui lève une exception est un défaut, quel que soit
// le nombre de blocs qu'il change : ce test ne juge donc pas le résultat, il
// exige seulement que l'opération aille au bout et rende des `bounds`.

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const SEL = { min: { x: 2, y: 1, z: 2 }, max: { x: 29, y: 20, z: 29 } };

/**
 * Un build de 32³ avec de quoi mordre : un socle de terre, une surface d'herbe,
 * un bloc `minefield:*` orienté, et une flaque d'eau (pour `drain`).
 */
async function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-sweep-'));
  roots.push(root);
  const adapter = new FsAdapter({ root });
  const staging = createStaging(adapter);
  const id = 'sw';
  adapter.saveProject({ id, name: 'Balayage', min: { x: 0, y: 0, z: 0 }, size: { x: 32, y: 32, z: 32 } });

  const regions = blankRegions({ origin: { x: 0, y: 0, z: 0 }, size: { x: 32, y: 1, z: 32 } });
  const store = new RegionStore(regions);
  await store.warmup({ min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } });
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    for (let y = 0; y <= 5; y++) store.setBlock(x, y, z, { Name: 'minecraft:dirt', Properties: null });
    store.setBlock(x, 6, z, { Name: 'minecraft:grass_block', Properties: null });
  }
  for (let y = 7; y <= 11; y++) for (let z = 10; z < 18; z++) for (let x = 10; x < 18; x++) {
    store.setBlock(x, y, z, { Name: 'minefield:quart_de_bloc', Properties: { facing: 'north' } });
  }
  for (let z = 22; z < 26; z++) for (let x = 22; x < 26; x++) {
    store.setBlock(x, 6, z, { Name: 'minecraft:water', Properties: null });
  }
  const commit = store.commit({ touchedOnly: false });
  staging.seedRegions(id, regions.map((r) => ({ ...r, buffer: commit.get(`${r.regionX},${r.regionZ}`) || r.buffer })));
  return { staging, project: () => adapter.getProject(id) };
}

/** Lance une opération sur un build neuf. Rend le résultat, ou lève. */
async function lance(operation, params) {
  const { staging, project } = await build();
  // `paste` sans presse-papier est un refus légitime, pas un défaut : on le
  // remplit d'abord, comme le fait l'application après un « Copier ».
  let clipboard = null;
  if (operation === 'paste') {
    const c = await staging.applyOperation({ project: project(), operation: 'copy', params: {}, selection: SEL, actor: 't' });
    clipboard = c.clipboard;
    assert.ok(clipboard, 'copy doit rendre un presse-papier');
  }
  return staging.applyOperation({ project: project(), operation, params, selection: SEL, actor: 't', clipboard });
}

for (const op of OPERATIONS) {
  test(`opération « ${op.label} » (${op.id}) s’exécute avec les paramètres de l’interface`, async () => {
    const res = await lance(op.id, ECHANTILLONS_UI[op.id]);
    assert.ok(res.bounds, `${op.id} : pas de \`bounds\` — l’instantané d’annulation et l’aperçu incrémental s’y fient`);
    assert.equal(typeof res.blocksChanged, 'number');
  });
}

test('chaque valeur de chaque menu déroulant s’exécute', async () => {
  // Un préréglage est une branche de code à part entière : « Personnalisé »
  // plantait alors que « Plaine » passait.
  let essais = 0;
  for (const op of OPERATIONS) {
    for (const p of op.params.filter((q) => q.type === 'enum' && q.values.length > 1)) {
      for (const v of p.values) {
        const params = { ...ECHANTILLONS_UI[op.id], [p.name]: v };
        await assert.doesNotReject(
          () => lance(op.id, params),
          (err) => new Error(`${op.id} avec ${p.name} = ${v} : ${err.message}`),
        );
        essais++;
      }
    }
  }
  assert.ok(essais > 60, `balayage trop maigre : ${essais} essais`);
});
