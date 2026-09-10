import zlib from 'node:zlib';
import nbt from 'prismarine-nbt';
import { decodeBlockStates, encodeBlockStates } from './section.js';

// Lecture/écriture d'un fichier de région Anvil (.mca) 1.18+.
//
// Header 8 Kio : 1024 entrées « location » (3 o offset secteur + 1 o nb secteurs)
// puis 1024 timestamps. Secteurs de 4096 o. Chaque chunk : longueur(4 o BE) +
// compression(1 o : 1 gzip / 2 zlib / 3 brut) + NBT compressé.
//
// Principe « non destructif » : à la lecture on garde le payload compressé brut
// de chaque chunk. À l'écriture, un chunk NON modifié est ré-émis **byte-for-byte**
// (on recopie son payload) ; seuls les chunks marqués `dirty` sont réencodés
// depuis leur NBT tagué. C'est ce qui garantit le round-trip lossless.

const SECTOR = 4096;
const MAX_CHUNK_INFLATED = Number(process.env.WORLD_MAX_CHUNK_BYTES || 32 * 1024 * 1024);

// Accepte les deux conventions de nom : « r.X.Z.mca » et « r_X_Z.mca ».
const REGION_RE = /(?:^|[/\\])?r[._](-?\d+)[._](-?\d+)\.mca$/;

export function regionCoordsFromName(name) {
  const m = String(name || '').match(REGION_RE);
  return m ? { regionX: Number(m[1]), regionZ: Number(m[2]) } : null;
}

export function regionFileName(regionX, regionZ, sep = '.') {
  return `r${sep}${regionX}${sep}${regionZ}.mca`;
}

function inflate(payload, compression) {
  if (compression === 1) return zlib.gunzipSync(payload, { maxOutputLength: MAX_CHUNK_INFLATED });
  if (compression === 2) return zlib.inflateSync(payload, { maxOutputLength: MAX_CHUNK_INFLATED });
  return payload; // 3 = non compressé
}

// Lit un .mca → { regionX, regionZ, chunks:[chunk] }. Chaque chunk :
//   { index, localX, localZ, chunkX, chunkZ, timestamp, compression,
//     payload:Buffer (compressé, brut), root:null, dirty:false }
// `root` (NBT tagué) n'est décodé qu'à la demande via decodeChunk().
export function readRegion(buf, regionX = 0, regionZ = 0) {
  const chunks = [];
  if (!buf || buf.length < 8192) return { regionX, regionZ, chunks };
  for (let ci = 0; ci < 1024; ci++) {
    const loc = buf.readUInt32BE(ci * 4);
    const sectorOff = loc >>> 8;
    const sectorCount = loc & 0xff;
    if (sectorOff === 0 || sectorCount === 0) continue;
    const off = sectorOff * SECTOR;
    if (off + 5 > buf.length) continue;
    const length = buf.readUInt32BE(off);
    if (length <= 1 || off + 4 + length > buf.length) continue;
    const compression = buf.readUInt8(off + 4);
    const payload = Buffer.from(buf.subarray(off + 5, off + 4 + length));
    const localX = ci % 32;
    const localZ = (ci / 32) | 0;
    chunks.push({
      index: ci,
      localX,
      localZ,
      chunkX: regionX * 32 + localX,
      chunkZ: regionZ * 32 + localZ,
      timestamp: buf.readUInt32BE(4096 + ci * 4),
      compression,
      payload,
      root: null,
      dirty: false,
    });
  }
  return { regionX, regionZ, chunks };
}

// Décode (paresseusement) le NBT tagué d'un chunk. Idempotent.
export async function decodeChunk(chunk) {
  if (chunk.root) return chunk.root;
  const raw = inflate(chunk.payload, chunk.compression);
  const { parsed } = await nbt.parse(raw);
  chunk.root = parsed;
  return parsed;
}

// Liste des sections (compounds NBT tagués) d'un chunk décodé, triées par Y.
export function chunkSections(chunk) {
  const root = chunk.root;
  const list = root?.value?.sections || root?.value?.Sections;
  const arr = list?.value?.value;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((comp) => ({ comp, Y: comp?.Y?.value ?? 0 }))
    .sort((a, b) => a.Y - b.Y);
}

// Lit la grille de blocs d'une section taguée → { palette, indices } ou null.
export function readSection(sectionComp) {
  const bs = sectionComp?.block_states;
  if (!bs) return null;
  return decodeBlockStates(nbt.simplify(bs));
}

// Réécrit la grille de blocs dans une section taguée (remplace block_states).
export function writeSection(sectionComp, grid) {
  sectionComp.block_states = encodeBlockStates(grid);
}

// Réémet le payload d'un chunk : recopie brut si non modifié, sinon réencode le
// NBT tagué en zlib. Renvoie { compression, payload }.
function encodeChunkPayload(chunk) {
  if (!chunk.dirty && chunk.payload) {
    return { compression: chunk.compression, payload: chunk.payload };
  }
  const raw = nbt.writeUncompressed(chunk.root, 'big');
  return { compression: 2, payload: zlib.deflateSync(raw) };
}

// Sérialise une région → Buffer (.mca). Header régénéré proprement ; chunks
// rangés en secteurs contigus à partir du secteur 2 (après le header).
export function writeRegion(region) {
  const header = Buffer.alloc(8192);
  const parts = [header];
  let sector = 2;
  const nowSec = Math.floor(Date.now() / 1000);

  for (const chunk of region.chunks) {
    const { compression, payload } = encodeChunkPayload(chunk);
    const recordLen = payload.length + 1; // +1 octet de compression
    const sectorsNeeded = Math.ceil((recordLen + 4) / SECTOR);
    if (sectorsNeeded > 0xff) throw new Error(`chunk_too_large@${chunk.index}`);

    const padded = Buffer.alloc(sectorsNeeded * SECTOR);
    padded.writeUInt32BE(recordLen, 0);
    padded.writeUInt8(compression, 4);
    payload.copy(padded, 5);

    header.writeUInt32BE((sector << 8) | sectorsNeeded, chunk.index * 4);
    header.writeUInt32BE(chunk.timestamp || nowSec, 4096 + chunk.index * 4);
    parts.push(padded);
    sector += sectorsNeeded;
  }
  return Buffer.concat(parts);
}
