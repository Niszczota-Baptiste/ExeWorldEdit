import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsAdapter } from '@titi/we-engine/storage';
import { createStaging, blankRegions, panelPlane } from '@titi/we-engine/staging';
import { toHeights, toMask, toBlockNames } from '../src/renderer/grid/pixels.js';

// La JONCTION entre l'interface et le moteur, pour les trois outils à grille.
//
// Les tests de `pixels.js` disent ce que l'interface produit ; ceux du moteur
// disent ce qu'il écrit. Aucun ne dit qu'ils se comprennent — et c'est là que
// ça s'est cassé : `toHeights` rendait des hauteurs en BLOCS quand
// `applyHeightmap` attend un rapport 0..1, donc `clamp01` ramenait toute
// cellule non nulle à 1. Résultat : un plateau plat au sommet de la sélection
// au lieu du relief demandé, et rien pour le signaler.

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** Un projet vide de 64³, prêt à recevoir une grille. */
function projet() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-grid-'));
  roots.push(root);
  const adapter = new FsAdapter({ root });
  const staging = createStaging(adapter);
  adapter.saveProject({ id: 'g', name: 'grille', min: { x: 0, y: 0, z: 0 }, size: { x: 64, y: 48, z: 64 } });
  staging.seedRegions('g', blankRegions({ origin: { x: 0, y: 0, z: 0 }, size: { x: 64, y: 1, z: 64 } }));
  return { adapter, staging, p: () => adapter.getProject('g') };
}

/** Une « image » RGBA, comme celle qu'un canvas rendrait. */
function image(w, h, f) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = f(x, y);
      const i = (y * w + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a ?? 255;
    }
  }
  return px;
}

test('relief : sculpter puis ressortir redonne les MÊMES hauteurs', async () => {
  const { staging, p } = projet();
  const sel = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 32, z: 31 } };
  const maxH = sel.max.y - sel.min.y;

  // Un dégradé diagonal : chaque colonne a sa propre hauteur, donc un aplatis-
  // sement se verrait tout de suite.
  const px = image(32, 32, (x, z) => {
    const v = Math.round(((x + z) / 62) * 255);
    return [v, v, v];
  });
  const heights = toHeights(px);
  assert.ok(heights.every((v) => v >= 0 && v <= 1), 'des rapports, pas des blocs');

  await staging.applyHeightmap({
    project: p(), selection: sel, heights, actor: 't',
    params: { block: { name: 'minecraft:grass_block' }, under: { name: 'minecraft:dirt' }, mode: 'solid' },
  });

  const out = await staging.exportHeightmap(p(), sel);
  assert.equal(out.sizeX, 32);
  assert.equal(out.sizeZ, 32);

  let pires = 0;
  for (let i = 0; i < heights.length; i++) {
    const demande = Math.round(heights[i] * maxH);
    const relu = Math.round((out.data[i] / 255) * maxH);
    pires = Math.max(pires, Math.abs(demande - relu));
  }
  assert.equal(pires, 0, 'le relief ressorti doit être celui qu’on a demandé');

  // Et il n'est PAS plat : c'est ce que donnait le défaut, et un aller-retour
  // plat-vers-plat passerait le test ci-dessus sans rien prouver.
  assert.ok(new Set(out.data).size > 8, 'le relief doit avoir des hauteurs variées');
});

test('panneau : le masque de l’interface tombe sur la bonne grille', async () => {
  const { staging, p } = projet();
  // Un mur mince : c'est le cas normal d'un panneau.
  const sel = { min: { x: 4, y: 4, z: 10 }, max: { x: 27, y: 19, z: 10 } };
  const plane = panelPlane(sel);
  assert.deepEqual([plane.flat, plane.w, plane.h], ['z', 24, 16]);

  // Moitié gauche en encre, moitié droite en fond.
  const px = image(plane.w, plane.h, (x) => (x < plane.w / 2 ? [255, 255, 255] : [0, 0, 0]));
  const mask = toMask(px);
  assert.equal(mask.length, plane.w * plane.h, 'le masque fait exactement la taille du plan');

  const res = await staging.applyPanel({
    project: p(), selection: sel, mask, preset: 'white_marble', seed: 3, actor: 't',
    inkBlock: { name: 'minecraft:black_concrete' },
  });
  assert.equal(res.blocksChanged, plane.w * plane.h, 'une case par cellule, sur un mur d’un bloc');

  const store = staging.loadStore(p());
  await store.warmup(sel);
  // L'encre est à gauche (u croissant = x croissant ici), le fond à droite.
  assert.equal(store.getBlock(5, 10, 10).Name, 'minecraft:black_concrete');
  assert.notEqual(store.getBlock(26, 10, 10).Name, 'minecraft:black_concrete');
});

test('carte : les noms de blocs de l’interface sont posés tels quels', async () => {
  const { staging, p } = projet();
  const sel = { min: { x: 0, y: 8, z: 0 }, max: { x: 7, y: 8, z: 7 } };
  const plane = panelPlane(sel);
  assert.equal(plane.flat, 'y');

  const palette = [
    { block: 'minecraft:red_concrete', r: 200, g: 20, b: 20 },
    { block: 'minecraft:blue_concrete', r: 20, g: 20, b: 200 },
  ];
  // Un damier : une erreur d'indexation le transformerait en bandes.
  const px = image(plane.w, plane.h, (x, y) => ((x + y) % 2 ? [200, 20, 20] : [20, 20, 200]));
  const names = toBlockNames(px, palette);

  await staging.applyMapBlocks({ project: p(), selection: sel, names, actor: 't' });
  const store = staging.loadStore(p());
  await store.warmup(sel);
  assert.equal(store.getBlock(0, 8, 0).Name, 'minecraft:blue_concrete');
  assert.equal(store.getBlock(1, 8, 0).Name, 'minecraft:red_concrete');
  assert.equal(store.getBlock(0, 8, 1).Name, 'minecraft:red_concrete');
});
