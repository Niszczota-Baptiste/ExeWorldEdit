import {
  writeRegion, encodeBlockStates, localIndex, SECTION_VOLUME,
} from '../../src/anvil/index.js';

// Fabriques de données pour le bench. Aucun fichier binaire dans le dépôt : les
// régions sont construites à la volée, avec une seed, donc identiques d'une
// exécution à l'autre.
//
// Le contenu ressemble volontairement à du terrain Minecraft plutôt qu'à du
// bruit : palettes de quelques dizaines d'entrées par section, beaucoup de
// pierre, des sections entièrement pleines et d'autres entièrement vides. Une
// région de blocs aléatoires mesurerait un cas qui n'existe pas — palette
// saturée, compression inefficace, aucune section homogène.

/** Générateur déterministe, sans dépendance. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

const STRATA = [
  'minecraft:deepslate', 'minecraft:stone', 'minecraft:stone', 'minecraft:stone',
  'minecraft:andesite', 'minecraft:diorite', 'minecraft:granite', 'minecraft:gravel',
  'minecraft:dirt', 'minecraft:coarse_dirt', 'minecraft:grass_block',
  'minecraft:oak_log', 'minecraft:oak_leaves', 'minecraft:water', 'minecraft:sand',
];

/**
 * Une section de terrain : strates par hauteur, avec des veines pour que la
 * palette compte une dizaine d'entrées comme dans un vrai monde.
 */
function terrainSection(sy, rand) {
  const palette = [{ Name: 'minecraft:air', Properties: null }];
  const index = new Map([['minecraft:air', 0]]);
  const indices = new Uint16Array(SECTION_VOLUME);

  const idOf = (name) => {
    let i = index.get(name);
    if (i === undefined) { i = palette.length; palette.push({ Name: name, Properties: null }); index.set(name, i); }
    return i;
  };

  for (let y = 0; y < 16; y++) {
    const worldY = sy * 16 + y;
    // Au-dessus de 72 : essentiellement du vide, quelques arbres.
    if (worldY > 72) {
      if (rand() > 0.97) {
        for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
          if (rand() > 0.94) indices[localIndex(x, y, z)] = idOf('minecraft:oak_leaves');
        }
      }
      continue;
    }
    const base = worldY < 0 ? 'minecraft:deepslate' : worldY < 60 ? 'minecraft:stone' : worldY < 70 ? 'minecraft:dirt' : 'minecraft:grass_block';
    const baseId = idOf(base);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        // Veines : 6 % de blocs autres, comme un vrai sous-sol.
        const id = rand() > 0.94 ? idOf(STRATA[(rand() * STRATA.length) | 0]) : baseId;
        indices[localIndex(x, y, z)] = id;
      }
    }
  }
  return { Y: { type: 'byte', value: sy }, block_states: encodeBlockStates({ palette, indices }) };
}

function chunk(cx, cz, rand, { sections = 12, dataVersion = 2860 } = {}) {
  const list = [];
  for (let sy = -4; sy < -4 + sections; sy++) list.push(terrainSection(sy, rand));
  const localX = ((cx % 32) + 32) % 32;
  const localZ = ((cz % 32) + 32) % 32;
  return {
    index: localX + localZ * 32, localX, localZ, chunkX: cx, chunkZ: cz,
    timestamp: 1, compression: 2, payload: null, dirty: true,
    root: {
      type: 'compound', name: '', value: {
        DataVersion: { type: 'int', value: dataVersion },
        xPos: { type: 'int', value: cx }, yPos: { type: 'int', value: -4 }, zPos: { type: 'int', value: cz },
        Status: { type: 'string', value: 'minecraft:full' },
        sections: { type: 'list', value: { type: 'compound', value: list } },
        block_entities: { type: 'list', value: { type: 'compound', value: [] } },
        Heightmaps: { type: 'compound', value: {} },
      },
    },
  };
}

/**
 * Région r.0.0 avec `chunks`² chunks de terrain.
 * 32×32 = une région pleine, comme celles d'un monde réellement joué.
 */
export function buildTerrainRegion({ chunks: side = 32, sections = 12, seed = 7 } = {}) {
  const rand = rng(seed);
  const list = [];
  for (let cz = 0; cz < side; cz++) {
    for (let cx = 0; cx < side; cx++) list.push(chunk(cx, cz, rand, { sections }));
  }
  return writeRegion({ regionX: 0, regionZ: 0, chunks: list });
}

/** Régions d'air couvrant une zone, pour les scénarios d'écriture. */
export { blankRegions } from '../../src/staging/blank.js';
