/* eslint-disable security/detect-non-literal-fs-filename --
   Script de développement : la racine vient de la ligne de commande, et tout
   le reste est joint dessus à partir de noms constants. Rien d'exposé. */
// Fabrique un build de démonstration DANS l'espace de données de l'application.
//
// Tout passe par le moteur, sans raccourci : régions vierges, puis les vraies
// opérations `terrain` et `naturalize`, puis un donjon posé à la main avec
// `set`, `walls` et `cyl`. Ce que l'application affiche ensuite est donc un
// build authentique, pas une maquette — si le moteur se trompe, la capture le
// montre.
//
//   node scripts/make-demo.js [racine-de-données]

import fs from 'node:fs';
import path from 'node:path';
import { FsAdapter } from '@titi/we-engine/storage';
import { createStaging, blankRegions } from '@titi/we-engine/staging';
import { readSaveInfo, worldOverview, readRegions } from '@titi/we-engine/world';
import { RegionStore } from '@titi/we-engine/worldedit';

const root = process.argv[2] || process.env.TITI_DATA_ROOT;
if (!root) {
  console.error('Indique la racine de données : node scripts/make-demo.js <dossier>');
  process.exit(1);
}

const adapter = new FsAdapter({ root });
const staging = createStaging(adapter);

const SIZE = 192;      // côté en blocs
const BASE_Y = 40;
const TOP_Y = 96;
const SEED = 20260910; // le rendu doit être identique d'une exécution à l'autre

const id = 'demo-vallee';
adapter.removeProject(id);
adapter.saveProject({
  id,
  name: 'Vallée de Minefield',
  min: { x: 0, y: BASE_Y, z: 0 },
  size: { x: SIZE, y: TOP_Y - BASE_Y + 1, z: SIZE },
});

// Régions d'air neuves : pas de source, on sème directement le staging.
const regions = blankRegions({ origin: { x: 0, y: BASE_Y, z: 0 }, size: { x: SIZE, y: 1, z: SIZE } });
staging.seedRegions(id, regions);

const project = () => adapter.getProject(id);
const box = (a, b) => ({ min: a, max: b });
const step = async (label, operation, params, selection) => {
  const t = Date.now();
  const res = await staging.applyOperation({
    project: project(), operation, params, selection, actor: 'demo',
  });
  console.log(`  ${label.padEnd(28)} ${String(res.blocksChanged).padStart(9)} blocs  ${String(Date.now() - t).padStart(5)} ms`);
  return res;
};

console.log(`Build de démonstration ${SIZE}×${SIZE}, seed ${SEED}`);

// ── Le relief ───────────────────────────────────────────────────────────────
await step('Relief (collines)', 'terrain', {
  style: 'collines', amplitude: 70, scale: 0, seed: SEED, palette: 'plains', clearAbove: true,
}, box({ x: 0, y: BASE_Y, z: 0 }, { x: SIZE - 1, y: TOP_Y, z: SIZE - 1 }));

// Un massif rocheux dans un coin : deux styles de terrain sur le même build,
// c'est ce qui donne une silhouette au lieu d'une bosse uniforme.
await step('Massif rocheux', 'terrain', {
  style: 'montagne', amplitude: 95, scale: 0, seed: SEED + 7, palette: 'mountain', clearAbove: false,
}, box({ x: 108, y: BASE_Y, z: 8 }, { x: SIZE - 1, y: TOP_Y, z: 92 }));

await step('Naturaliser (plaine)', 'naturalize', { preset: 'plains' },
  box({ x: 0, y: BASE_Y, z: 96 }, { x: 100, y: TOP_Y, z: SIZE - 1 }));

// ── Une construction, pour que le rendu montre aussi des arêtes nettes ──────
const KEEP = { x0: 30, z0: 118, x1: 74, z1: 162, y0: 62, y1: 78 };

await step('Assise du fort', 'set', { block: { name: 'minecraft:stone_bricks' } },
  box({ x: KEEP.x0, y: KEEP.y0, z: KEEP.z0 }, { x: KEEP.x1, y: KEEP.y0 + 1, z: KEEP.z1 }));

await step('Remparts', 'walls', { block: { name: 'minecraft:stone_bricks' } },
  box({ x: KEEP.x0, y: KEEP.y0, z: KEEP.z0 }, { x: KEEP.x1, y: KEEP.y1, z: KEEP.z1 }));

await step('Usure des remparts', 'mix', {
  from: [{ name: 'minecraft:stone_bricks' }],
  pattern: [
    { name: 'minecraft:stone_bricks', weight: 62 },
    { name: 'minecraft:mossy_stone_bricks', weight: 22 },
    { name: 'minecraft:cracked_stone_bricks', weight: 12 },
    { name: 'minecraft:cobblestone', weight: 4 },
  ],
  seed: SEED,
}, box({ x: KEEP.x0, y: KEEP.y0, z: KEEP.z0 }, { x: KEEP.x1, y: KEEP.y1, z: KEEP.z1 }));

// Quatre tours d'angle, en cylindres pleins puis creusés.
for (const [cx, cz] of [[KEEP.x0, KEEP.z0], [KEEP.x1, KEEP.z0], [KEEP.x0, KEEP.z1], [KEEP.x1, KEEP.z1]]) {
  await step(`Tour ${cx}/${cz}`, 'cyl', { block: { name: 'minecraft:stone_bricks' }, radius: 5, hollow: true },
    box({ x: cx - 5, y: KEEP.y0, z: cz - 5 }, { x: cx + 5, y: KEEP.y1 + 6, z: cz + 5 }));
}

await step('Toitures', 'set', { block: { name: 'minecraft:dark_oak_planks' } },
  box({ x: KEEP.x0 - 5, y: KEEP.y1 + 6, z: KEEP.z0 - 5 }, { x: KEEP.x0 + 5, y: KEEP.y1 + 6, z: KEEP.z0 + 5 }));

// ── Une route qui monte vers la porte ───────────────────────────────────────
await step('Route pavée', 'path', {
  preset: 'cobble', width: 5, bow: 14,
}, box({ x: 20, y: 58, z: 60 }, { x: 52, y: 70, z: 116 }));

const p = project();
console.log(`\nEmprise finale : ${p.size.x} × ${p.size.y} × ${p.size.z} à partir de (${p.min.x}, ${p.min.y}, ${p.min.z})`);
const preview = staging.readPreview(id);
console.log(`Aperçu : ${preview.count.toLocaleString('fr-FR')} blocs, ${preview.palette.length} entrées de palette${preview.truncated ? ' (partiel)' : ''}`);
console.log(`Palette dominante : ${preview.bom.slice(0, 6).map((b) => `${b.blockId.replace('minecraft:', '')} ×${b.count}`).join(', ')}`);

// ── Un second projet, issu d'un VRAI dossier de save ────────────────────────
//
// Le premier projet vient de régions fabriquées : il n'a pas de monde derrière,
// donc pas de « Appliquer au monde ». Celui-ci en a un, ce qui permet de voir
// et d'essayer le chemin d'écriture complet.

const savePath = path.join(root, 'monde-demo', 'Vallée (save)');
fs.rmSync(path.join(root, 'monde-demo'), { recursive: true, force: true });
fs.mkdirSync(path.join(savePath, 'region'), { recursive: true });
fs.mkdirSync(path.join(savePath, 'entities'), { recursive: true });
fs.writeFileSync(path.join(savePath, 'level.dat'), Buffer.from([0x1f, 0x8b]));
fs.writeFileSync(path.join(savePath, 'session.lock'), '☃');

// Plusieurs régions dispersées, comme un monde réellement joué : des zones
// explorées, des trous jamais générés. C'est ce qui donne au sélecteur de zone
// quelque chose à montrer.
const EXPLORED = [
  [0, 0], [1, 0], [2, 0],
  [0, 1], [1, 1], [2, 1], [3, 1],
  [1, 2], [2, 2],
  [-1, 0], [-1, 1],
  [4, 3], [5, 3],
];
for (const [rx, rz] of EXPLORED) {
  const originX = rx * 512;
  const originZ = rz * 512;
  const regions = blankRegions({ origin: { x: originX, y: 60, z: originZ }, size: { x: 512, y: 1, z: 512 } });
  const store = new RegionStore(regions);
  const box = { min: { x: originX, y: 60, z: originZ }, max: { x: originX + 511, y: 80, z: originZ + 511 } };
  await store.warmup(box);
  // Un damier grossier suffit : ce qui compte ici est la CARTE, pas le contenu.
  for (let x = 0; x < 512; x += 8) {
    for (let z = 0; z < 512; z += 8) {
      store.setBlock(originX + x, 62, originZ + z, { Name: 'minecraft:grass_block', Properties: null });
    }
  }
  for (const [key, buf] of store.commit({ touchedOnly: false })) {
    const [krx, krz] = key.split(',').map(Number);
    fs.writeFileSync(path.join(savePath, 'region', `r.${krx}.${krz}.mca`), buf);
  }
}

const info = readSaveInfo(savePath);
const map = worldOverview(info);
console.log(`\nSave de démonstration : ${savePath}`);
console.log(`  ${map.count} régions, ${(map.bytes / 1e6).toFixed(1)} Mo, emprise r.${map.bounds.minX}.${map.bounds.minZ} → r.${map.bounds.maxX}.${map.bounds.maxZ}`);
console.log('  → « Ouvrir une save » dans l’application montre sa carte et laisse choisir la zone.');

// Un projet déjà ouvert sur DEUX régions de cette save, pour que le chemin
// « Appliquer au monde » soit essayable sans repasser par le sélecteur.
const worldId = 'demo-save';
adapter.removeProject(worldId);
adapter.saveProject({
  id: worldId, name: `${info.name} (2 régions)`,
  min: { x: 0, y: 60, z: 0 }, size: { x: 1, y: 1, z: 1 },
  world: { path: info.root, kind: info.kind },
});
staging.seedRegions(worldId, readRegions(info, [{ regionX: 0, regionZ: 0 }, { regionX: 1, regionZ: 0 }]));
{
  const p2 = adapter.getProject(worldId);
  const store = staging.loadStore(p2);
  const lim = { min: { x: 0, y: -64, z: 0 }, max: { x: 1023, y: 319, z: 511 } };
  await store.warmup(lim);
  const sparse = store.deriveSparse(lim, staging.limits.previewMaxBlocks, { truncate: true });
  adapter.saveExtent(worldId, {
    min: sparse.min,
    max: { x: sparse.min.x + sparse.size.x - 1, y: sparse.min.y + sparse.size.y - 1, z: sparse.min.z + sparse.size.z - 1 },
  });
  await staging.regenPreview(adapter.getProject(worldId));
}

// La vallée redevient le projet le plus récent, donc celui qui s'ouvre : c'est
// elle qui montre quelque chose. La save reste dans le second onglet.
adapter.saveProject(adapter.getProject(id));
