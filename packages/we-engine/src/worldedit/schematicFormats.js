import zlib from 'node:zlib';
import nbt from 'prismarine-nbt';
import { Schematic } from './transform.js';

// Conversions entre une `Schematic` (presse-papier dense interne) et les formats
// d'échange Minecraft : Sponge `.schem` (v2) et Litematica `.litematic` (v6).
// Tout est NBT gzip. Un « bloc » interne = { Name, Properties|null } ; l'air =
// null. L'ordre linéaire de Schematic.data est `x + sx*(z + sz*y)` = l'ordre
// **YZX** des deux formats (index = (y*Length + z)*Width + x) — pas de réindexage.

const AIR = 'minecraft:air';
const DEFAULT_DATA_VERSION = Number(process.env.WORLDEDIT_DATA_VERSION || 3578); // 1.20.x

// ── Blockstate ⇄ chaîne « name[k=v,...] » (palette Sponge) ────────────────────
const sortedProps = (props) => (props ? Object.keys(props).sort() : []);
export function blockToStateString(b) {
  if (!b || b.Name === AIR) return AIR;
  const keys = sortedProps(b.Properties);
  if (!keys.length) return b.Name;
  return `${b.Name}[${keys.map((k) => `${k}=${b.Properties[k]}`).join(',')}]`;
}
export function stateStringToBlock(s) {
  const str = String(s).trim();
  const open = str.indexOf('[');
  if (open === -1) return { Name: str, Properties: null };
  const name = str.slice(0, open);
  const inner = str.endsWith(']') ? str.slice(open + 1, -1) : str.slice(open + 1);
  const props = {};
  for (const pair of inner.split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) props[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return { Name: name, Properties: Object.keys(props).length ? props : null };
}

const isAirBlock = (b) => !b || b.Name === AIR || b.Name === 'minecraft:cave_air' || b.Name === 'minecraft:void_air';

// ── Palette dense interne (utilisée pour la persistance bibliothèque) ─────────
// Renvoie { palette:[{Name,Properties}], indices:Int32Array } dans l'ordre data.
export function schemToPaletteIndices(schem) {
  const palette = [];
  const map = new Map();
  const N = schem.sx * schem.sy * schem.sz;
  const indices = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const b = schem.data[i];
    const key = isAirBlock(b) ? AIR : blockToStateString(b);
    let pi = map.get(key);
    if (pi === undefined) {
      pi = palette.length; map.set(key, pi);
      palette.push(isAirBlock(b) ? { Name: AIR, Properties: null } : { Name: b.Name, Properties: b.Properties || null });
    }
    indices[i] = pi;
  }
  return { palette, indices };
}

export function paletteIndicesToSchem({ sx, sy, sz, origin, palette, indices }) {
  const data = new Array(sx * sy * sz);
  for (let i = 0; i < data.length; i++) {
    const e = palette[indices[i]];
    data[i] = (!e || e.Name === AIR) ? null : { Name: e.Name, Properties: e.Properties || null };
  }
  return new Schematic(sx, sy, sz, data, origin || { x: 0, y: 0, z: 0 });
}

// Forme JSON compacte gzip pour la bibliothèque (pas un format Minecraft).
export function schemToBlob(schem) {
  const { palette, indices } = schemToPaletteIndices(schem);
  const json = JSON.stringify({
    sx: schem.sx, sy: schem.sy, sz: schem.sz, origin: schem.origin || { x: 0, y: 0, z: 0 },
    palette, indices: Array.from(indices),
  });
  return zlib.gzipSync(Buffer.from(json));
}
export function blobToSchem(buf) {
  const o = JSON.parse(zlib.gunzipSync(buf).toString());
  return paletteIndicesToSchem(o);
}

// ── Varint LEB128 (BlockData Sponge) ─────────────────────────────────────────
function writeVarint(arr, value) {
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    arr.push(b > 127 ? b - 256 : b); // i8 signé pour le byteArray NBT
  } while (v !== 0);
}
function readVarints(bytes, count) {
  const out = new Int32Array(count);
  let i = 0;
  for (let n = 0; n < count; n++) {
    let value = 0, shift = 0, b;
    do {
      b = bytes[i++] & 0xff;
      value |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    out[n] = value >>> 0;
  }
  return out;
}

// ── Sponge .schem (v2) ───────────────────────────────────────────────────────
export function schematicToSponge(schem, { dataVersion = DEFAULT_DATA_VERSION, name } = {}) {
  const { sx, sy, sz } = schem;
  // Palette de chaînes blockstate → index.
  const paletteMap = {};
  let next = 0;
  const idxOf = (b) => {
    const s = blockToStateString(b);
    if (!(s in paletteMap)) paletteMap[s] = next++;
    return paletteMap[s];
  };
  const blockData = [];
  for (let i = 0; i < schem.data.length; i++) writeVarint(blockData, idxOf(schem.data[i]));
  const paletteTag = { type: 'compound', value: {} };
  for (const [k, v] of Object.entries(paletteMap)) paletteTag.value[k] = { type: 'int', value: v };

  const root = { type: 'compound', name: 'Schematic', value: {
    Version: { type: 'int', value: 2 },
    DataVersion: { type: 'int', value: dataVersion },
    Width: { type: 'short', value: sx },
    Height: { type: 'short', value: sy },
    Length: { type: 'short', value: sz },
    Offset: { type: 'intArray', value: [schem.origin?.x || 0, schem.origin?.y || 0, schem.origin?.z || 0] },
    PaletteMax: { type: 'int', value: next },
    Palette: paletteTag,
    BlockData: { type: 'byteArray', value: blockData },
    Metadata: { type: 'compound', value: {
      Name: { type: 'string', value: String(name || 'schematic') },
      WEOffsetX: { type: 'int', value: 0 }, WEOffsetY: { type: 'int', value: 0 }, WEOffsetZ: { type: 'int', value: 0 },
    } },
  } };
  return zlib.gzipSync(nbt.writeUncompressed(root, 'big'));
}

export async function spongeToSchematic(buffer) {
  const { parsed } = await nbt.parse(buffer);
  // v3 imbrique sous "Schematic" puis "Blocks" ; v1/v2 à plat.
  let root = nbt.simplify(parsed);
  if (root.Schematic) root = root.Schematic;
  const blocks = root.Blocks || root; // v3 : { Blocks: { Palette, Data } }
  const sx = root.Width, sy = root.Height, sz = root.Length;
  const paletteObj = blocks.Palette || root.Palette || {};
  const dataBytes = blocks.Data || root.BlockData;
  if (!sx || !sy || !sz || !dataBytes) throw new Error('bad_schematic');
  // index → blockstate string
  const byIndex = [];
  for (const [k, v] of Object.entries(paletteObj)) byIndex[v] = k;
  const bytes = Buffer.isBuffer(dataBytes) ? dataBytes : Buffer.from(dataBytes);
  const indices = readVarints(bytes, sx * sy * sz);
  const data = new Array(sx * sy * sz);
  for (let i = 0; i < indices.length; i++) {
    const b = stateStringToBlock(byIndex[indices[i]] || AIR);
    data[i] = (b.Name === AIR) ? null : b;
  }
  const off = root.Offset || [0, 0, 0];
  return new Schematic(sx, sy, sz, data, { x: off[0] || 0, y: off[1] || 0, z: off[2] || 0 });
}

// ── LitematicaBitArray (packing 64 bits avec chevauchement) ──────────────────
const bitsFor = (paletteLen) => Math.max(2, Math.ceil(Math.log2(Math.max(2, paletteLen))));

// indices (Int32Array) → longArray NBT ([ [high,low], ... ]).
function packLitematicaBits(indices, bits) {
  const total = indices.length;
  const longCount = Math.ceil((total * bits) / 64);
  const longs = new Array(longCount).fill(0n);
  const mask = (1n << BigInt(bits)) - 1n;
  for (let i = 0; i < total; i++) {
    const startOffset = BigInt(i) * BigInt(bits);
    const startIdx = Number(startOffset >> 6n);
    const endIdx = Number((BigInt(i + 1) * BigInt(bits) - 1n) >> 6n);
    const startBit = Number(startOffset & 63n);
    const value = BigInt(indices[i] >>> 0) & mask;
    longs[startIdx] |= (value << BigInt(startBit)) & 0xFFFFFFFFFFFFFFFFn;
    if (startIdx !== endIdx) longs[endIdx] |= (value >> BigInt(64 - startBit)) & 0xFFFFFFFFFFFFFFFFn;
  }
  return longs.map((v) => {
    const hi = Number(BigInt.asIntN(32, v >> 32n));
    const lo = Number(BigInt.asIntN(32, v & 0xFFFFFFFFn));
    return [hi, lo];
  });
}

function unpackLitematicaBits(longPairs, bits, total) {
  const longs = longPairs.map(([hi, lo]) => (BigInt.asUintN(32, BigInt(hi)) << 32n) | BigInt.asUintN(32, BigInt(lo)));
  const mask = (1n << BigInt(bits)) - 1n;
  const out = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    const startOffset = BigInt(i) * BigInt(bits);
    const startIdx = Number(startOffset >> 6n);
    const endIdx = Number((BigInt(i + 1) * BigInt(bits) - 1n) >> 6n);
    const startBit = Number(startOffset & 63n);
    let value;
    if (startIdx === endIdx) {
      value = (longs[startIdx] >> BigInt(startBit)) & mask;
    } else {
      value = ((longs[startIdx] >> BigInt(startBit)) | (longs[endIdx] << BigInt(64 - startBit))) & mask;
    }
    out[i] = Number(value);
  }
  return out;
}

// ── Litematica .litematic (v6) ───────────────────────────────────────────────
export function schematicToLitematic(schem, { dataVersion = DEFAULT_DATA_VERSION, name, author = '' } = {}) {
  const { sx, sy, sz } = schem;
  // Palette : l'air DOIT être l'index 0.
  const palette = [{ Name: AIR, Properties: null }];
  const map = new Map([[AIR, 0]]);
  const indices = new Int32Array(schem.data.length);
  let nonAir = 0;
  for (let i = 0; i < schem.data.length; i++) {
    const b = schem.data[i];
    if (isAirBlock(b)) { indices[i] = 0; continue; }
    const key = blockToStateString(b);
    let pi = map.get(key);
    if (pi === undefined) { pi = palette.length; map.set(key, pi); palette.push({ Name: b.Name, Properties: b.Properties || null }); }
    indices[i] = pi; nonAir++;
  }
  const bits = bitsFor(palette.length);
  const longPairs = packLitematicaBits(indices, bits);

  const paletteTag = { type: 'list', value: { type: 'compound', value: palette.map((p) => {
    const v = { Name: { type: 'string', value: p.Name } };
    if (p.Properties && Object.keys(p.Properties).length) {
      const props = {};
      for (const [k, val] of Object.entries(p.Properties)) props[k] = { type: 'string', value: String(val) };
      v.Properties = { type: 'compound', value: props };
    }
    return v;
  }) } };

  const now = [0, Math.floor(Date.now() / 1000)]; // long [high, low] approx
  const region = { type: 'compound', value: {
    Position: vec3Tag(0, 0, 0),
    Size: vec3Tag(sx, sy, sz),
    BlockStatePalette: paletteTag,
    BlockStates: { type: 'longArray', value: longPairs },
    TileEntities: emptyCompoundList(),
    Entities: emptyCompoundList(),
    PendingBlockTicks: emptyCompoundList(),
    PendingFluidTicks: emptyCompoundList(),
  } };
  const regName = String(name || 'schematic');

  const root = { type: 'compound', name: '', value: {
    Version: { type: 'int', value: 6 },
    MinecraftDataVersion: { type: 'int', value: dataVersion },
    Metadata: { type: 'compound', value: {
      Name: { type: 'string', value: regName },
      Author: { type: 'string', value: String(author) },
      Description: { type: 'string', value: '' },
      EnclosingSize: vec3Tag(sx, sy, sz),
      RegionCount: { type: 'int', value: 1 },
      TimeCreated: { type: 'long', value: now },
      TimeModified: { type: 'long', value: now },
      TotalBlocks: { type: 'int', value: nonAir },
      TotalVolume: { type: 'int', value: sx * sy * sz },
    } },
    Regions: { type: 'compound', value: { [regName]: region } },
  } };
  return zlib.gzipSync(nbt.writeUncompressed(root, 'big'));
}

export async function litematicToSchematic(buffer) {
  const { parsed } = await nbt.parse(buffer);
  const root = nbt.simplify(parsed);
  const regions = root.Regions || {};
  const names = Object.keys(regions);
  if (!names.length) throw new Error('bad_litematic');
  // Emprise englobante de toutes les régions (coins min monde).
  const parsedRegions = names.map((rn) => {
    const r = regions[rn];
    const size = r.Size, pos = r.Position;
    const ax = Math.abs(size.x), ay = Math.abs(size.y), az = Math.abs(size.z);
    const minX = size.x >= 0 ? pos.x : pos.x + size.x + 1;
    const minY = size.y >= 0 ? pos.y : pos.y + size.y + 1;
    const minZ = size.z >= 0 ? pos.z : pos.z + size.z + 1;
    return { r, ax, ay, az, minX, minY, minZ, sgnX: size.x >= 0, sgnY: size.y >= 0, sgnZ: size.z >= 0 };
  });
  let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity, gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;
  for (const p of parsedRegions) {
    gMinX = Math.min(gMinX, p.minX); gMinY = Math.min(gMinY, p.minY); gMinZ = Math.min(gMinZ, p.minZ);
    gMaxX = Math.max(gMaxX, p.minX + p.ax - 1); gMaxY = Math.max(gMaxY, p.minY + p.ay - 1); gMaxZ = Math.max(gMaxZ, p.minZ + p.az - 1);
  }
  const SX = gMaxX - gMinX + 1, SY = gMaxY - gMinY + 1, SZ = gMaxZ - gMinZ + 1;
  const out = new Schematic(SX, SY, SZ, null, { x: gMinX, y: gMinY, z: gMinZ });
  for (const p of parsedRegions) {
    const pal = (p.r.BlockStatePalette || []).map((e) => ({ Name: e.Name, Properties: e.Properties || null }));
    if (!pal.length) continue;
    const bits = bitsFor(pal.length);
    const total = p.ax * p.ay * p.az;
    const idx = unpackLitematicaBits(p.r.BlockStates || [], bits, total);
    for (let ly = 0; ly < p.ay; ly++) for (let lz = 0; lz < p.az; lz++) for (let lx = 0; lx < p.ax; lx++) {
      const li = (ly * p.az + lz) * p.ax + lx;
      const e = pal[idx[li]];
      if (!e || e.Name === AIR) continue;
      const gx = (p.sgnX ? p.minX + lx : p.minX + (p.ax - 1 - lx)) - gMinX;
      const gy = (p.sgnY ? p.minY + ly : p.minY + (p.ay - 1 - ly)) - gMinY;
      const gz = (p.sgnZ ? p.minZ + lz : p.minZ + (p.az - 1 - lz)) - gMinZ;
      out.set(gx, gy, gz, { Name: e.Name, Properties: e.Properties || null });
    }
  }
  return out;
}

// ── Helpers NBT ──────────────────────────────────────────────────────────────
function vec3Tag(x, y, z) {
  return { type: 'compound', value: { x: { type: 'int', value: x }, y: { type: 'int', value: y }, z: { type: 'int', value: z } } };
}
function emptyCompoundList() { return { type: 'list', value: { type: 'compound', value: [] } }; }

// Détecte le format depuis l'extension/le contenu et renvoie une Schematic.
export async function parseSchematicFile(buffer, filename = '') {
  const ext = String(filename).toLowerCase();
  if (ext.endsWith('.litematic')) return litematicToSchematic(buffer);
  if (ext.endsWith('.schem') || ext.endsWith('.schematic')) return spongeToSchematic(buffer);
  // Repli : on tente Litematica (présence de "Regions") puis Sponge.
  try { return await litematicToSchematic(buffer); } catch { return spongeToSchematic(buffer); }
}
