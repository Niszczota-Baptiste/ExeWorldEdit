import zlib from 'node:zlib';
import nbt from 'prismarine-nbt';
import { PALETTE, FLAT_PALETTE } from './blockPalette.js';

// Génération d'une CARTE Minecraft (item `filled_map`, 128×128) — fichier
// `data/map_<n>.dat`. Convertit une image/texte vers la palette de « map colors »
// du jeu : 62 couleurs de base × 4 nuances (multiplicateurs 180/220/255/135), le
// byte stocké = baseId*4 + nuance. baseId 0 = transparent (byte 0).

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
