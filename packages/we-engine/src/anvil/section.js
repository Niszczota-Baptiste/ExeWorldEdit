// Encodage/décodage d'une section Anvil 1.18+ : la grille 16³ de blocs
// paletteisée (`block_states { palette, data }`).
//
// Repère : index d'un bloc dans une section = i = y*256 + z*16 + x (ordre YZX),
//          x,y,z ∈ [0,15]. +X = Est, +Z = Sud, +Y = Haut.
// Format 1.18+ : data = tableau de longs 64 bits ; bits = max(4, ceil(log2(len
// palette))) ; perLong = floor(64 / bits) ; un index NE chevauche PAS deux longs
// (les bits de poids fort inutilisés de chaque long sont à 0).

export const SECTION_VOLUME = 4096; // 16 * 16 * 16

// prismarine-nbt encode un long sur 64 bits comme une paire [high, low] de deux
// entiers signés 32 bits. On convertit dans les deux sens via BigInt non signé.
export function pairToBig(el) {
  if (typeof el === 'bigint') return el & 0xffffffffffffffffn;
  if (Array.isArray(el)) {
    const hi = BigInt(el[0] | 0) & 0xffffffffn;
    const lo = BigInt(el[1] >>> 0);
    return ((hi << 32n) | lo) & 0xffffffffffffffffn;
  }
  return BigInt(el) & 0xffffffffffffffffn;
}

export function bigToPair(v) {
  const u = v & 0xffffffffffffffffn;
  const hi = Number(BigInt.asIntN(32, u >> 32n));
  const lo = Number(BigInt.asIntN(32, u & 0xffffffffn));
  return [hi, lo];
}

// Nombre de bits par index pour une palette de `len` entrées (règle Minecraft).
export function bitsForPalette(len) {
  return Math.max(4, Math.ceil(Math.log2(Math.max(2, len))));
}

// Convertit une entrée de palette NBT (compound simplifié) en forme normalisée
// { Name, Properties|null }. Les Properties sont des chaînes côté Minecraft.
function normalizePaletteEntry(entry) {
  if (typeof entry === 'string') return { Name: entry, Properties: null };
  const Name = entry?.Name;
  const props = entry?.Properties;
  if (!props || typeof props !== 'object') return { Name, Properties: null };
  const out = {};
  for (const [k, v] of Object.entries(props)) out[k] = String(v);
  return { Name, Properties: Object.keys(out).length ? out : null };
}

// Lit un compound `block_states` (déjà simplifié par nbt.simplify) et renvoie
// { palette:[{Name,Properties}], indices:Uint16Array(4096) }.
// Section homogène (palette de 1 / pas de `data`) → indices tous à 0.
export function decodeBlockStates(blockStates) {
  const rawPalette = blockStates?.palette || [];
  const palette = rawPalette.map(normalizePaletteEntry);
  const indices = new Uint16Array(SECTION_VOLUME);
  const data = blockStates?.data;
  if (!Array.isArray(data) || data.length === 0 || palette.length <= 1) {
    return { palette, indices };
  }
  const bits = bitsForPalette(palette.length);
  const mask = (1n << BigInt(bits)) - 1n;
  const perLong = Math.floor(64 / bits);
  const longs = data.map(pairToBig);
  for (let n = 0; n < SECTION_VOLUME; n++) {
    const li = Math.floor(n / perLong);
    const within = n % perLong;
    indices[n] = Number((longs[li] >> BigInt(within * bits)) & mask);
  }
  return { palette, indices };
}

// Recompose un compound `block_states` NBT (tagué) à partir de la palette
// normalisée + indices. Palette de taille 1 → pas de `data` (section homogène,
// comme Minecraft). Sinon repack des longs (sans chevauchement).
export function encodeBlockStates({ palette, indices }) {
  const paletteTag = {
    type: 'list',
    value: {
      type: 'compound',
      value: palette.map((e) => {
        const comp = { Name: { type: 'string', value: e.Name } };
        if (e.Properties && Object.keys(e.Properties).length) {
          comp.Properties = {
            type: 'compound',
            value: Object.fromEntries(
              Object.entries(e.Properties).map(([k, v]) => [k, { type: 'string', value: String(v) }]),
            ),
          };
        }
        return comp;
      }),
    },
  };

  if (palette.length <= 1) {
    return { type: 'compound', value: { palette: paletteTag } };
  }

  const bits = bitsForPalette(palette.length);
  const perLong = Math.floor(64 / bits);
  const longCount = Math.ceil(SECTION_VOLUME / perLong);
  const out = new Array(longCount);
  for (let li = 0; li < longCount; li++) {
    let acc = 0n;
    for (let within = 0; within < perLong; within++) {
      const n = li * perLong + within;
      if (n >= SECTION_VOLUME) break;
      acc |= (BigInt(indices[n] >>> 0) & ((1n << BigInt(bits)) - 1n)) << BigInt(within * bits);
    }
    out[li] = bigToPair(acc);
  }
  return {
    type: 'compound',
    value: {
      palette: paletteTag,
      data: { type: 'longArray', value: out },
    },
  };
}

// Index YZX ↔ coordonnées locales (0..15).
export const localIndex = (x, y, z) => (y << 8) | (z << 4) | x;
export const idxX = (n) => n & 15;
export const idxZ = (n) => (n >> 4) & 15;
export const idxY = (n) => (n >> 8) & 15;

// ── Biomes (1.18+) : grille 4×4×4 = 64 cellules par section, même packing que
// block_states mais bits = max(1, ceil(log2(len))). Index YZX en pas de 4 blocs.
export const BIOME_VOLUME = 64; // 4 * 4 * 4
export const biomeLocalIndex = (cx, cy, cz) => (cy << 4) | (cz << 2) | cx; // cx,cy,cz ∈ [0,3]
export function bitsForBiomes(len) {
  return Math.max(1, Math.ceil(Math.log2(Math.max(1, len))));
}

// Lit un compound `biomes` simplifié → { palette:[name], indices:Uint8Array(64) }.
export function decodeBiomes(biomes) {
  const palette = Array.isArray(biomes?.palette) ? biomes.palette.slice() : [];
  const indices = new Uint8Array(BIOME_VOLUME);
  const data = biomes?.data;
  if (palette.length <= 1 || !Array.isArray(data) || data.length === 0) {
    return { palette: palette.length ? palette : ['minecraft:plains'], indices };
  }
  const bits = bitsForBiomes(palette.length);
  const mask = (1n << BigInt(bits)) - 1n;
  const perLong = Math.floor(64 / bits);
  const longs = data.map(pairToBig);
  for (let n = 0; n < BIOME_VOLUME; n++) {
    const li = Math.floor(n / perLong);
    const within = n % perLong;
    indices[n] = Number((longs[li] >> BigInt(within * bits)) & mask);
  }
  return { palette, indices };
}

// Recompose un compound `biomes` tagué (palette de 1 → pas de `data`).
export function encodeBiomes({ palette, indices }) {
  const paletteTag = { type: 'list', value: { type: 'string', value: palette.slice() } };
  if (palette.length <= 1) return { type: 'compound', value: { palette: paletteTag } };
  const bits = bitsForBiomes(palette.length);
  const perLong = Math.floor(64 / bits);
  const longCount = Math.ceil(BIOME_VOLUME / perLong);
  const out = new Array(longCount);
  for (let li = 0; li < longCount; li++) {
    let acc = 0n;
    for (let within = 0; within < perLong; within++) {
      const n = li * perLong + within;
      if (n >= BIOME_VOLUME) break;
      acc |= (BigInt(indices[n] >>> 0) & ((1n << BigInt(bits)) - 1n)) << BigInt(within * bits);
    }
    out[li] = bigToPair(acc);
  }
  return { type: 'compound', value: { palette: paletteTag, data: { type: 'longArray', value: out } } };
}
