import {
  writeRegion, readRegion, decodeChunk, chunkSections, readSection,
  encodeBlockStates, localIndex, SECTION_VOLUME, chunkBlockEntities, blockEntityPos,
} from '../../src/anvil/index.js';

// Fabrique de régions .mca pour les tests : pas de fixture binaire dans le
// dépôt, tout est construit à la volée. Un .mca commité serait opaque en revue
// et impossible à faire évoluer.

/**
 * Région r.0.0 avec un chunk (0,0) portant les blocs fournis en coordonnées
 * MONDE (x,z ∈ 0..15 ; y quelconque, la section est déduite).
 * @param {{x,y,z,Name,Properties?}[]} blocks
 */
export function buildRegion(blocks, { dataVersion = 2860, blockEntities = [] } = {}) {
  const bySection = new Map();
  for (const b of blocks) {
    const sy = Math.floor(b.y / 16);
    if (!bySection.has(sy)) bySection.set(sy, []);
    bySection.get(sy).push(b);
  }
  // Une section d'air garantie : sans elle, un chunk sans aucune section ne
  // ressemble pas à ce que Minecraft écrit.
  if (!bySection.has(0)) bySection.set(0, []);

  const sections = [...bySection.entries()].sort((a, b) => a[0] - b[0]).map(([sy, list]) => {
    const palette = [{ Name: 'minecraft:air', Properties: null }];
    const key = (n, p) => `${n}|${p ? JSON.stringify(p) : ''}`;
    const idx = new Map([[key('minecraft:air', null), 0]]);
    const indices = new Uint16Array(SECTION_VOLUME);
    for (const b of list) {
      const k = key(b.Name, b.Properties || null);
      let pi = idx.get(k);
      if (pi === undefined) { pi = palette.length; palette.push({ Name: b.Name, Properties: b.Properties || null }); idx.set(k, pi); }
      indices[localIndex(b.x & 15, ((b.y % 16) + 16) % 16, b.z & 15)] = pi;
    }
    return { Y: { type: 'byte', value: sy }, block_states: encodeBlockStates({ palette, indices }) };
  });

  const chunk = {
    index: 0, localX: 0, localZ: 0, chunkX: 0, chunkZ: 0,
    timestamp: 1, compression: 2, payload: null, dirty: true,
    root: {
      type: 'compound', name: '', value: {
        DataVersion: { type: 'int', value: dataVersion },
        xPos: { type: 'int', value: 0 }, yPos: { type: 'int', value: 0 }, zPos: { type: 'int', value: 0 },
        Status: { type: 'string', value: 'minecraft:full' },
        sections: { type: 'list', value: { type: 'compound', value: sections } },
        // Les block entities portent leurs coordonnées MONDE et un contenu
        // qu'on ne cherche pas à interpréter — ici un champ témoin suffit à
        // vérifier qu'il traverse les opérations intact.
        block_entities: {
          type: 'list',
          value: {
            type: 'compound',
            value: blockEntities.map((be) => ({
              id: { type: 'string', value: be.id },
              x: { type: 'int', value: be.x },
              y: { type: 'int', value: be.y },
              z: { type: 'int', value: be.z },
              ...(be.marque !== undefined ? { marque: { type: 'string', value: be.marque } } : {}),
            })),
          },
        },
      },
    },
  };
  return writeRegion({ regionX: 0, regionZ: 0, chunks: [chunk] });
}

/** Relit une région en Map("x,y,z" → entrée de palette), air exclu. */
export async function readBack(buffer, { regionX = 0, regionZ = 0 } = {}) {
  const region = readRegion(buffer, regionX, regionZ);
  const out = new Map();
  for (const chunk of region.chunks) {
    await decodeChunk(chunk);
    for (const { Y, comp } of chunkSections(chunk)) {
      const grid = readSection(comp);
      for (let n = 0; n < SECTION_VOLUME; n++) {
        const e = grid.palette[grid.indices[n]];
        if (!e || e.Name === 'minecraft:air') continue;
        const x = chunk.chunkX * 16 + (n & 15);
        const z = chunk.chunkZ * 16 + ((n >> 4) & 15);
        const y = Y * 16 + ((n >> 8) & 15);
        out.set(`${x},${y},${z}`, e);
      }
    }
  }
  return out;
}

/** Relit les block entities d'une région, en Map("x,y,z" → { id, marque }). */
export async function readBackEntities(buffer, { regionX = 0, regionZ = 0 } = {}) {
  const region = readRegion(buffer, regionX, regionZ);
  const out = new Map();
  for (const chunk of region.chunks) {
    await decodeChunk(chunk);
    for (const e of chunkBlockEntities(chunk)) {
      const p = blockEntityPos(e);
      if (!p) continue;
      out.set(`${p.x},${p.y},${p.z}`, { id: e.id?.value, marque: e.marque?.value });
    }
  }
  return out;
}
