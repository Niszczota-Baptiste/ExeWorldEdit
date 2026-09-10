import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import nbt from 'prismarine-nbt';
import { readRegion, writeRegion, decodeChunk, chunkSections, readSection } from '../src/anvil/index.js';
import { RegionStore } from '../src/worldedit/regionStore.js';
import { schematicToSponge } from '../src/worldedit/schematicFormats.js';
import { FsAdapter } from '../src/storage/index.js';
import { createStaging, volumeToSchematic } from '../src/staging/index.js';
import { buildTerrainRegion, blankRegions } from './lib/fixtures.js';
import { measure, collect } from './lib/measure.js';

// Les scénarios du bench. Chacun rend `{ ms, peakMb, n, unit }` — `n` étant ce
// dont le débit a du sens (blocs traités, chunks décodés…), pas un total
// arbitraire.
//
// Deux familles :
//   · les OPÉRATIONS, qui mesurent ce que coûte une commande à l'utilisateur ;
//   · la DÉCOMPOSITION, qui mesure où part le temps à l'intérieur du
//     chargement d'une région. C'est elle qui doit dire s'il faut optimiser
//     RegionStore ou autre chose — et l'ordre compte : optimiser au jugé, c'est
//     accélérer ce qui ne coûtait rien.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'we-bench-'));

/** Un volume en mémoire de la taille voulue, sans passer par un .mca. */
async function memoryVolume({ span = 256, height = 64, baseY = 0 }) {
  const regions = blankRegions({ origin: { x: 0, y: baseY, z: 0 }, size: { x: span, y: 1, z: span } });
  const store = new RegionStore(regions);
  const box = {
    min: { x: 0, y: baseY, z: 0 },
    max: { x: span - 1, y: baseY + height - 1, z: span - 1 },
  };
  await store.warmup(box);
  return { store, box, span, height };
}

/** Remplit un volume de pierre — le point de départ de la plupart des mesures. */
async function filledVolume(opts) {
  const v = await memoryVolume(opts);
  const stone = { Name: 'minecraft:stone', Properties: null };
  for (let y = v.box.min.y; y <= v.box.max.y; y++) {
    for (let z = v.box.min.z; z <= v.box.max.z; z++) {
      for (let x = v.box.min.x; x <= v.box.max.x; x++) v.store.setBlock(x, y, z, stone);
    }
  }
  return v;
}

/** Décompresse le payload d'un chunk selon son mode (1 gzip, 2 zlib, 3 brut). */
const inflateChunk = ({ data, compression }) => (
  compression === 1 ? zlib.gunzipSync(data)
    : compression === 2 ? zlib.inflateSync(data)
      : data
);

const volumeOf = (box) => (box.max.x - box.min.x + 1) * (box.max.y - box.min.y + 1) * (box.max.z - box.min.z + 1);

// ── Opérations ──────────────────────────────────────────────────────────────

export const scenarios = {
  async 'set-10M'() {
    // 256 × 160 × 256 ≈ 10,5 M de blocs : l'ordre de grandeur d'une grosse
    // commande sur une muraille ou un terrassement.
    const { store, box } = await memoryVolume({ span: 256, height: 160 });
    const { opSet } = await import('../src/worldedit/transform.js');
    collect();
    const m = await measure(() => opSet(store, box, { block: { name: 'minecraft:stone' } }));
    return { ...m, n: volumeOf(box), unit: 'blocs' };
  },

  async replace() {
    const { store, box } = await filledVolume({ span: 192, height: 96 });
    const { opReplace } = await import('../src/worldedit/transform.js');
    collect();
    const m = await measure(() => opReplace(store, box, {
      from: [{ name: 'minecraft:stone' }],
      to: { name: 'minecraft:deepslate' },
    }));
    return { ...m, n: volumeOf(box), unit: 'blocs' };
  },

  async mix() {
    const { store, box } = await filledVolume({ span: 192, height: 96 });
    const { opMix } = await import('../src/worldedit/transform.js');
    collect();
    const m = await measure(() => opMix(store, box, {
      pattern: [
        { name: 'minecraft:stone', weight: 50 },
        { name: 'minecraft:cobblestone', weight: 30 },
        { name: 'minecraft:andesite', weight: 20 },
      ],
      seed: 42,
    }));
    return { ...m, n: volumeOf(box), unit: 'blocs' };
  },

  async 'mirror-rotate'() {
    const { store, box } = await filledVolume({ span: 192, height: 96 });
    const { opMirror, opRotate } = await import('../src/worldedit/transform.js');
    collect();
    const m = await measure(async () => {
      opMirror(store, box, { axis: 'x' });
      opRotate(store, box, { degrees: 90 });
    });
    return { ...m, n: volumeOf(box) * 2, unit: 'blocs' };
  },

  async 'terrain-1024'() {
    // La sélection demandée par le cahier des charges : 1024 × 1024.
    const { store, box } = await memoryVolume({ span: 1024, height: 96, baseY: 40 });
    const { opTerrain } = await import('../src/worldedit/transform.js');
    collect();
    const m = await measure(() => opTerrain(store, box, {
      style: 'hills', amplitude: 70, scale: 0, seed: 20260910, palette: 'plains', clearAbove: true,
    }, { yield: async () => {} }));
    return { ...m, n: 1024 * 1024, unit: 'colonnes' };
  },

  async naturalize() {
    const { store, box } = await filledVolume({ span: 256, height: 64, baseY: 40 });
    const { opNaturalize } = await import('../src/worldedit/transform.js');
    collect();
    const m = await measure(() => opNaturalize(store, box, { preset: 'plains' }));
    return { ...m, n: 256 * 256, unit: 'colonnes' };
  },

  // ── Entrées / sorties ─────────────────────────────────────────────────────

  async 'region-decode'() {
    // Une région PLEINE : 1024 chunks, 12 sections chacun. C'est ce qu'on paie
    // à chaque ouverture de zone.
    const buffer = buildTerrainRegion({ chunks: 32, sections: 12 });
    collect();
    const m = await measure(async () => {
      const region = readRegion(buffer, 0, 0);
      let sections = 0;
      for (const c of region.chunks) {
        await decodeChunk(c);
        for (const { comp } of chunkSections(c)) { readSection(comp); sections++; }
      }
      return sections;
    });
    return { ...m, n: m.result, unit: 'sections', bytes: buffer.length };
  },

  async 'region-write'() {
    const buffer = buildTerrainRegion({ chunks: 32, sections: 12 });
    const region = readRegion(buffer, 0, 0);
    for (const c of region.chunks) { await decodeChunk(c); c.dirty = true; }
    collect();
    const m = await measure(() => writeRegion(region));
    return { ...m, n: region.chunks.length, unit: 'chunks', bytes: m.result.length };
  },

  async 'export-mca'() {
    const dir = tmp();
    const adapter = new FsAdapter({ root: dir });
    const staging = createStaging(adapter);
    adapter.saveProject({ id: 'b', name: 'bench', min: { x: 0, y: 0, z: 0 }, size: { x: 512, y: 192, z: 512 } });
    staging.seedRegions('b', [{ regionX: 0, regionZ: 0, buffer: buildTerrainRegion({ chunks: 32, sections: 12 }) }]);
    collect();
    const m = await measure(() => staging.exportBuild(adapter.getProject('b')));
    fs.rmSync(dir, { recursive: true, force: true });
    return { ...m, n: 1, unit: 'régions', bytes: m.result.buffer.length };
  },

  async 'export-schem'() {
    const { store, box } = await filledVolume({ span: 128, height: 64 });
    collect();
    const m = await measure(async () => {
      const schem = volumeToSchematic(store, box);
      return schematicToSponge(schem, { name: 'bench' });
    });
    return { ...m, n: volumeOf(box), unit: 'blocs', bytes: m.result.length };
  },

  // ── Décomposition du chargement d'une région ──────────────────────────────
  //
  // Le total, c'est `region-decode`. Ces quatre-là le découpent. La somme ne
  // tombe pas exactement juste (chaque étape réalloue), mais les PROPORTIONS
  // disent où chercher.

  async 'phase-inflate'() {
    const buffer = buildTerrainRegion({ chunks: 32, sections: 12 });
    const region = readRegion(buffer, 0, 0);
    // `payload` est déjà le flux compressé SANS l'octet de compression : celui-ci
    // est lu à part, dans `chunk.compression`. Le rogner ferait sauter l'en-tête
    // zlib, ce qui rate au premier chunk.
    const payloads = region.chunks.map((c) => ({ data: c.payload, compression: c.compression }));
    collect();
    const m = await measure(() => {
      let total = 0;
      for (const p of payloads) total += inflateChunk(p).length;
      return total;
    });
    return { ...m, n: payloads.length, unit: 'chunks' };
  },

  async 'phase-nbt-parse'() {
    const buffer = buildTerrainRegion({ chunks: 32, sections: 12 });
    const region = readRegion(buffer, 0, 0);
    const raws = region.chunks.map((c) => inflateChunk({ data: c.payload, compression: c.compression }));
    collect();
    const m = await measure(async () => {
      let n = 0;
      for (const raw of raws) { await nbt.parse(raw); n++; }
      return n;
    });
    return { ...m, n: raws.length, unit: 'chunks' };
  },

  async 'phase-nbt-simplify'() {
    const buffer = buildTerrainRegion({ chunks: 32, sections: 12 });
    const region = readRegion(buffer, 0, 0);
    const parsed = [];
    for (const c of region.chunks) {
      parsed.push((await nbt.parse(inflateChunk({ data: c.payload, compression: c.compression }))).parsed);
    }
    collect();
    const m = await measure(() => {
      let n = 0;
      for (const p of parsed) { nbt.simplify(p); n++; }
      return n;
    });
    return { ...m, n: parsed.length, unit: 'chunks' };
  },

  async 'phase-unpack-sections'() {
    const buffer = buildTerrainRegion({ chunks: 32, sections: 12 });
    const region = readRegion(buffer, 0, 0);
    const comps = [];
    for (const c of region.chunks) {
      await decodeChunk(c);
      for (const { comp } of chunkSections(c)) comps.push(comp);
    }
    collect();
    const m = await measure(() => {
      let n = 0;
      for (const comp of comps) { readSection(comp); n++; }
      return n;
    });
    return { ...m, n: comps.length, unit: 'sections' };
  },

  // ── Chemin chaud de RegionStore ───────────────────────────────────────────

  async 'store-setblock'() {
    // Mesure isolée du chemin que la phase 1.2 doit réécrire : clé texte +
    // findIndex sur la palette, à chaque bloc.
    const { store, box } = await memoryVolume({ span: 128, height: 64 });
    const blocks = [
      { Name: 'minecraft:stone', Properties: null },
      { Name: 'minecraft:oak_stairs', Properties: { facing: 'east', half: 'bottom', shape: 'straight' } },
      { Name: 'minecraft:cobblestone', Properties: null },
    ];
    collect();
    const m = await measure(() => {
      let n = 0;
      for (let y = box.min.y; y <= box.max.y; y++) {
        for (let z = box.min.z; z <= box.max.z; z++) {
          for (let x = box.min.x; x <= box.max.x; x++) { store.setBlock(x, y, z, blocks[n % 3]); n++; }
        }
      }
      return n;
    });
    return { ...m, n: m.result, unit: 'blocs' };
  },

  async 'store-getblock'() {
    const { store, box } = await filledVolume({ span: 128, height: 64 });
    collect();
    const m = await measure(() => {
      let seen = 0;
      for (let y = box.min.y; y <= box.max.y; y++) {
        for (let z = box.min.z; z <= box.max.z; z++) {
          for (let x = box.min.x; x <= box.max.x; x++) { if (store.getBlock(x, y, z)) seen++; }
        }
      }
      return seen;
    });
    return { ...m, n: volumeOf(box), unit: 'blocs' };
  },
};

export const SCENARIO_IDS = Object.keys(scenarios);
