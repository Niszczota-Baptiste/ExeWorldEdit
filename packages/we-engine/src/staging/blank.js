import {
  regionFileName, writeRegion, readRegion, decodeChunk, encodeBlockStates, SECTION_VOLUME,
} from '../anvil/index.js';
import { RegionStore } from '../worldedit/regionStore.js';
import { makeZip } from '../worldedit/zipWriter.js';
import { safeFileName } from '../storage/filename.js';
import { fdiv, panelPlane, tick, DEFAULT_LIMITS } from './geometry.js';

// Construction de régions .mca NEUVES : build vierge, carte en blocs autonome,
// export re-chunké à une autre position. Pas de stockage ici non plus — on
// renvoie des buffers, l'appelant décide où ils atterrissent.

const airSection = () => encodeBlockStates({ palette: [{ Name: 'minecraft:air', Properties: null }], indices: new Uint16Array(SECTION_VOLUME) });
const emptyList = () => ({ type: 'list', value: { type: 'end', value: [] } });
const emptyCompoundList = () => ({ type: 'list', value: { type: 'compound', value: [] } });
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Chunk synthétique plein d'air. REPLI seulement : dès qu'un build existe on
 * lui emprunte un chunk modèle (`templateChunk`), pour que la structure NBT
 * colle à la version Minecraft de l'utilisateur au lieu d'être devinée.
 */
function syntheticTemplate(dataVersion = 3578) {
  const sections = [];
  for (let y = -4; y <= 19; y++) {
    sections.push({
      Y: { type: 'byte', value: y },
      block_states: airSection(),
      biomes: { type: 'compound', value: { palette: { type: 'list', value: { type: 'string', value: ['minecraft:plains'] } } } },
    });
  }
  return { type: 'compound', name: '', value: {
    DataVersion: { type: 'int', value: dataVersion },
    Status: { type: 'string', value: 'minecraft:full' },
    xPos: { type: 'int', value: 0 }, yPos: { type: 'int', value: -4 }, zPos: { type: 'int', value: 0 },
    LastUpdate: { type: 'long', value: [0, 0] },
    InhabitedTime: { type: 'long', value: [0, 0] },
    sections: { type: 'list', value: { type: 'compound', value: sections } },
    block_entities: emptyCompoundList(),
    block_ticks: emptyList(),
    fluid_ticks: emptyList(),
    PostProcessing: emptyList(),
    structures: { type: 'compound', value: { starts: { type: 'compound', value: {} }, References: { type: 'compound', value: {} } } },
    Heightmaps: { type: 'compound', value: {} },
    isLightOn: { type: 'byte', value: 0 },
  } };
}

/**
 * Chunk d'air dérivé d'un modèle, replacé en (cx,cz) et purgé de tout ce qui
 * est lié à l'ancienne position : block entities, ticks, heightmaps.
 */
function airChunkFrom(template, cx, cz) {
  const root = structuredClone(template);
  const v = root.value;
  v.xPos = { type: 'int', value: cx };
  v.zPos = { type: 'int', value: cz };
  for (const sec of (v.sections?.value?.value || [])) sec.block_states = airSection();
  v.block_entities = emptyCompoundList();
  if (v.block_ticks) v.block_ticks = emptyList();
  if (v.fluid_ticks) v.fluid_ticks = emptyList();
  if (v.Heightmaps) v.Heightmaps = { type: 'compound', value: {} };
  return root;
}

function regionBuffersFromChunks(chunks) {
  const byRegion = new Map();
  for (const { cx, cz, root } of chunks) {
    const rx = fdiv(cx, 32), rz = fdiv(cz, 32);
    const key = `${rx},${rz}`;
    if (!byRegion.has(key)) byRegion.set(key, { rx, rz, chunks: [] });
    const localX = ((cx % 32) + 32) % 32, localZ = ((cz % 32) + 32) % 32;
    byRegion.get(key).chunks.push({ index: localX + localZ * 32, localX, localZ, chunkX: cx, chunkZ: cz, timestamp: nowSec(), compression: 2, payload: null, root, dirty: true });
  }
  const out = [];
  for (const { rx, rz, chunks: cs } of byRegion.values()) {
    cs.sort((a, b) => a.index - b.index);
    out.push({ regionX: rx, regionZ: rz, buffer: writeRegion({ regionX: rx, regionZ: rz, chunks: cs }) });
  }
  return out;
}

/**
 * Relit chaque région produite et décode son premier chunk. Garde-fou : mieux
 * vaut un `invalid_blank` ici qu'un build illisible une fois en jeu.
 * @throws {Error} `invalid_blank`
 */
export async function validateRegions(regions) {
  for (const r of regions) {
    let region;
    try { region = readRegion(r.buffer, r.regionX, r.regionZ); } catch { throw new Error('invalid_blank'); }
    if (!region.chunks.length) throw new Error('invalid_blank');
    const c = region.chunks[0];
    try { await decodeChunk(c); } catch { throw new Error('invalid_blank'); }
    const sections = c.root?.value?.sections?.value?.value;
    if (!Array.isArray(sections) || !sections.length) throw new Error('invalid_blank');
  }
  return true;
}

/** Régions d'air couvrant [origin, origin+size) en X/Z. */
export function blankRegions({ template, dataVersion, origin, size }) {
  const tmpl = template || syntheticTemplate(dataVersion);
  const cMinX = fdiv(origin.x, 16), cMaxX = fdiv(origin.x + size.x - 1, 16);
  const cMinZ = fdiv(origin.z, 16), cMaxZ = fdiv(origin.z + size.z - 1, 16);
  const chunks = [];
  for (let cz = cMinZ; cz <= cMaxZ; cz++) for (let cx = cMinX; cx <= cMaxX; cx++) chunks.push({ cx, cz, root: airChunkFrom(tmpl, cx, cz) });
  return regionBuffersFromChunks(chunks);
}

/**
 * Build PLAT d'une couche depuis une grille de noms de blocs — un mur (plan XY)
 * ou un sol (plan XZ) selon la forme de `size`. Emprunte le même chemin
 * blankRegions + RegionStore que le build vierge et l'export, si bien que la
 * source .mca et l'artefact 3D sortent du MÊME store et ne peuvent pas
 * diverger. `names` est indexé v*w+u (v=0 en haut du plan, null = laissé en air).
 */
export async function buildPlaneFromNames({ template, origin, size, names, cropMaxBlocks = DEFAULT_LIMITS.cropMaxBlocks }) {
  const bbox = {
    min: { x: origin.x, y: origin.y, z: origin.z },
    max: { x: origin.x + size.x - 1, y: origin.y + size.y - 1, z: origin.z + size.z - 1 },
  };
  const { flat, uAxis, vAxis, invertV, w, h } = panelPlane(bbox);
  if (!names || names.length < w * h) throw new Error('bad_plane');

  const regions = blankRegions({ template, origin, size });
  const store = new RegionStore(regions);
  await store.warmup(bbox);

  const cache = new Map();
  let count = 0;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const name = names[v * w + u];
      if (!name) continue;
      let block = cache.get(name);
      if (!block) { block = { Name: name, Properties: null }; cache.set(name, block); }
      const pos = { x: 0, y: 0, z: 0 };
      pos[uAxis] = bbox.min[uAxis] + u;
      pos[vAxis] = invertV ? bbox.max[vAxis] - v : bbox.min[vAxis] + v;
      pos[flat] = bbox.min[flat];
      store.setBlock(pos.x, pos.y, pos.z, block);
      count++;
    }
    if ((v & 15) === 0) await tick();
  }
  if (!count) throw new Error('empty_plane');

  const outRegions = [...store.commit({ touchedOnly: false })].map(([key, buffer]) => {
    const [rx, rz] = key.split(',').map(Number);
    return { regionX: rx, regionZ: rz, buffer };
  });
  const sparse = store.deriveSparse(bbox, cropMaxBlocks);
  return { regions: outRegions, sparse };
}

// ── Mise en forme d'un téléchargement ───────────────────────────────────────

/** Une région seule sort en .mca ; plusieurs sortent zippées en `region/`. */
export function regionsToDownload(regions, name) {
  if (regions.length === 1) {
    const r = regions[0];
    return { buffer: r.buffer, filename: regionFileName(r.regionX, r.regionZ), mime: 'application/octet-stream' };
  }
  const entries = regions.map((r) => ({ name: `region/${regionFileName(r.regionX, r.regionZ)}`, data: r.buffer }));
  return { buffer: makeZip(entries), filename: `${safeFileName(name)}-region.zip`, mime: 'application/zip' };
}
