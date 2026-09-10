// Fabrique un build de démonstration DANS l'espace de données de l'application.
//
// Tout passe par le moteur, sans raccourci : régions vierges, puis les vraies
// opérations `terrain` et `naturalize`, puis un donjon posé à la main avec
// `set`, `walls` et `cyl`. Ce que l'application affiche ensuite est donc un
// build authentique, pas une maquette — si le moteur se trompe, la capture le
// montre.
//
//   node scripts/make-demo.js [racine-de-données]

import { FsAdapter } from '@titi/we-engine/storage';
import { createStaging, blankRegions } from '@titi/we-engine/staging';

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
  style: 'hills', amplitude: 70, scale: 0, seed: SEED, palette: 'plains', clearAbove: true,
}, box({ x: 0, y: BASE_Y, z: 0 }, { x: SIZE - 1, y: TOP_Y, z: SIZE - 1 }));

// Un massif rocheux dans un coin : deux styles de terrain sur le même build,
// c'est ce qui donne une silhouette au lieu d'une bosse uniforme.
await step('Massif rocheux', 'terrain', {
  style: 'mountain', amplitude: 95, scale: 0, seed: SEED + 7, palette: 'mountain', clearAbove: false,
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
