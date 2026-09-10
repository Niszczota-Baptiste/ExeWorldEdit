import zlib from 'node:zlib';
import nbt from 'prismarine-nbt';

// Génération d'une CARTE Minecraft (item `filled_map`, 128×128) — fichier
// `data/map_<n>.dat`. Convertit une image/texte vers la palette de « map colors »
// du jeu : 62 couleurs de base × 4 nuances (multiplicateurs 180/220/255/135), le
// byte stocké = baseId*4 + nuance. baseId 0 = transparent (byte 0).

// Couleurs de base 1.16+ (id → RGB de référence).
const BASE = [
  [0, 0, 0], [127, 178, 56], [247, 233, 163], [199, 199, 199], [255, 0, 0],
  [160, 160, 255], [167, 167, 167], [0, 124, 0], [255, 255, 255], [164, 168, 184],
  [151, 109, 77], [112, 112, 112], [64, 64, 255], [143, 119, 72], [255, 252, 245],
  [216, 127, 51], [178, 76, 216], [102, 153, 216], [229, 229, 51], [127, 204, 25],
  [242, 127, 165], [76, 76, 76], [153, 153, 153], [76, 127, 153], [127, 63, 178],
  [51, 76, 178], [102, 76, 51], [102, 127, 51], [153, 51, 51], [25, 25, 25],
  [250, 238, 77], [92, 219, 213], [74, 128, 255], [0, 217, 58], [129, 86, 49],
  [112, 2, 0], [209, 177, 161], [159, 82, 36], [149, 87, 108], [112, 108, 138],
  [186, 133, 36], [103, 117, 53], [160, 77, 78], [57, 41, 35], [135, 107, 98],
  [87, 92, 92], [122, 73, 88], [76, 62, 92], [76, 50, 35], [76, 82, 42],
  [142, 60, 46], [37, 22, 16], [189, 48, 49], [148, 63, 97], [92, 25, 29],
  [22, 126, 134], [58, 142, 140], [86, 44, 62], [20, 180, 133], [100, 100, 100],
  [216, 175, 147], [127, 167, 150],
];
const SHADE = [180, 220, 255, 135];

// Palette résolue : { byte, r, g, b } pour baseId 1..61 × 4 nuances.
const PALETTE = (() => {
  const pal = [];
  for (let id = 1; id < BASE.length; id++) {
    const [br, bg, bb] = BASE[id];
    for (let s = 0; s < 4; s++) {
      const m = SHADE[s] / 255;
      pal.push({ byte: id * 4 + s, r: Math.round(br * m), g: Math.round(bg * m), b: Math.round(bb * m) });
    }
  }
  return pal;
})();

// RGB → byte de carte le plus proche (distance pondérée perceptuelle).
function nearestByte(r, g, b) {
  let best = PALETTE[0], bd = Infinity;
  for (const c of PALETTE) {
    const dr = r - c.r, dg = g - c.g, db = b - c.b;
    const d = dr * dr * 0.30 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bd) { bd = d; best = c; }
  }
  return best.byte;
}

// Données RGBA brutes 128×128 → tableau de 16384 bytes signés (NBT i8).
export function rgbaToMapColors(data, channels) {
  const out = new Int8Array(128 * 128);
  for (let i = 0; i < 128 * 128; i++) {
    const o = i * channels;
    const a = channels === 4 ? data[o + 3] : 255;
    if (a < 128) { out[i] = 0; continue; } // transparent
    const byte = nearestByte(data[o], data[o + 1], data[o + 2]);
    out[i] = byte > 127 ? byte - 256 : byte;
  }
  return out;
}

// ── Map-art EN BLOCS (survie) : baseId → bloc plat qui rend cette couleur ─────
// Pour une carte PLATE (tous les blocs au même Y), chaque couleur de base donne
// une seule nuance (×220) → ~60 couleurs. On choisit un bloc obtenable par base.
const BASE_BLOCK = {
  1: 'grass_block', 2: 'sand', 3: 'mushroom_stem', 4: 'redstone_block', 5: 'packed_ice',
  6: 'iron_block', 7: 'oak_leaves', 8: 'white_concrete', 9: 'clay', 10: 'dirt',
  11: 'stone', 12: 'water', 13: 'oak_planks', 14: 'quartz_block', 15: 'orange_concrete',
  16: 'magenta_concrete', 17: 'light_blue_concrete', 18: 'yellow_concrete', 19: 'lime_concrete', 20: 'pink_concrete',
  21: 'gray_concrete', 22: 'light_gray_concrete', 23: 'cyan_concrete', 24: 'purple_concrete', 25: 'blue_concrete',
  26: 'brown_concrete', 27: 'green_concrete', 28: 'red_concrete', 29: 'black_concrete', 30: 'gold_block',
  31: 'diamond_block', 32: 'lapis_block', 33: 'emerald_block', 34: 'podzol', 35: 'netherrack',
  36: 'white_terracotta', 37: 'orange_terracotta', 38: 'magenta_terracotta', 39: 'light_blue_terracotta', 40: 'yellow_terracotta',
  41: 'lime_terracotta', 42: 'pink_terracotta', 43: 'gray_terracotta', 44: 'light_gray_terracotta', 45: 'cyan_terracotta',
  46: 'purple_terracotta', 47: 'blue_terracotta', 48: 'brown_terracotta', 49: 'green_terracotta', 50: 'red_terracotta',
  51: 'black_terracotta', 52: 'crimson_nylium', 53: 'crimson_planks', 54: 'crimson_hyphae', 55: 'warped_nylium',
  56: 'warped_planks', 57: 'warped_hyphae', 58: 'warped_wart_block', 59: 'deepslate', 60: 'raw_iron_block',
};
// Palette PLATE (nuance ×220) restreinte aux bases ayant un bloc.
const FLAT_PALETTE = Object.entries(BASE_BLOCK).map(([id, block]) => {
  const [br, bg, bb] = BASE[Number(id)];
  const m = 220 / 255;
  return { block: `minecraft:${block}`, r: Math.round(br * m), g: Math.round(bg * m), b: Math.round(bb * m) };
});
function nearestFlatBlock(r, g, b) {
  let best = FLAT_PALETTE[0], bd = Infinity;
  for (const c of FLAT_PALETTE) {
    const dr = r - c.r, dg = g - c.g, db = b - c.b;
    const d = dr * dr * 0.30 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bd) { bd = d; best = c; }
  }
  return best.block;
}
// Données RGBA (w×h) → grille de noms de blocs (null si transparent).
export function imageToMapBlocks(data, w, h, channels) {
  const out = new Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * channels;
    const a = channels === 4 ? data[o + 3] : 255;
    out[i] = a < 128 ? null : nearestFlatBlock(data[o], data[o + 1], data[o + 2]);
  }
  return out;
}

// Construit le fichier `map_<n>.dat` (NBT gzip) à partir des 16384 bytes.
export function buildMapDat(colors, { dataVersion = 3578, xCenter = 0, zCenter = 0 } = {}) {
  const root = { type: 'compound', name: '', value: {
    DataVersion: { type: 'int', value: dataVersion },
    data: { type: 'compound', value: {
      scale: { type: 'byte', value: 0 },
      dimension: { type: 'string', value: 'minecraft:overworld' },
      trackingPosition: { type: 'byte', value: 0 },
      unlimitedTracking: { type: 'byte', value: 0 },
      locked: { type: 'byte', value: 1 },
      xCenter: { type: 'int', value: xCenter },
      zCenter: { type: 'int', value: zCenter },
      banners: { type: 'list', value: { type: 'compound', value: [] } },
      frames: { type: 'list', value: { type: 'compound', value: [] } },
      colors: { type: 'byteArray', value: Array.from(colors) },
    } },
  } };
  return zlib.gzipSync(nbt.writeUncompressed(root, 'big'));
}
