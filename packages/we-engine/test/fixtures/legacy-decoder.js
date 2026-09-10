// Décodeur Anvil HISTORIQUE, repris tel quel du site (server/minecraftWorld/anvil.js).
//
// Il ne sert QU'AUX TESTS : c'est une seconde implémentation, indépendante de
// src/anvil/, qui relit ce que notre écrivain produit. Un round-trip qui se
// contente de relire avec son propre décodeur ne prouve rien ; celui-ci prouve
// que le fichier est lisible par du code qui ne partage aucune ligne avec lui.
//
// ⚠️ À GELER : ne jamais l'optimiser ni le « corriger » en même temps que
// src/anvil/. S'il diverge du décodeur du moteur, c'est le moteur qu'il faut
// regarder d'abord.

import zlib from 'node:zlib';
import nbt from 'prismarine-nbt';

// Parsing Anvil 1.18 d'un fichier de région (.mca) :
//  - header 8 Kio : 1024 offsets (3o secteur + 1o nb secteurs, secteurs de 4 Kio)
//    puis 1024 timestamps (ignorés).
//  - chaque chunk : longueur(4o BE) + compression(1o : 1 gzip / 2 zlib / 3 none)
//    + NBT compressé.
//  - 1.18 : données à la racine (plus de « Level ») ; blocs dans
//    sections[].block_states { palette:[{Name,Properties}], data:[long] }.
//  - data = indices paletteisés, bits = max(4, ceil(log2(len palette))),
//    4096 blocs/section en ordre YZX, un index NE chevauche PAS deux longs.
//    Palette de taille 1 sans « data » = section homogène.

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);
const SECTOR = 4096;

// Plafond de décompression d'un chunk NBT (anti zip-bomb). Un chunk inflaté
// dépasse rarement quelques Mo ; au-delà de cette borne zlib lève, et l'appelant
// (parseRegion) ignore simplement le chunk au lieu d'allouer plusieurs Go.
const MAX_CHUNK_INFLATED = Number(process.env.WORLD_MAX_CHUNK_BYTES || 32 * 1024 * 1024); // 32 Mo

// Orientation déduite des Properties de la palette → rotation [x,y,z] en degrés
// à appliquer au modèle. On gère l'`axis` (bûches/piliers couchés), fiable sans
// Properties NBT d'une entrée de palette → objet plat { prop: "val" } (ou null).
// On garde l'état complet du bloc : la résolution blockstate (variants/multipart,
// orientation, connexions) se fait côté client à partir de ces propriétés.
function propsOf(entry) {
  if (!entry || typeof entry === 'string' || !entry.Properties) return null;
  const out = {};
  for (const [k, v] of Object.entries(entry.Properties)) out[k] = String(v);
  return Object.keys(out).length ? out : null;
}

// prismarine-nbt représente un long selon la version : BigInt, [high,low], ou
// number. On ramène tout à un BigInt 64 bits non signé.
function toBig(el) {
  if (typeof el === 'bigint') return el & 0xffffffffffffffffn;
  if (Array.isArray(el)) {
    const hi = BigInt(el[0] | 0);
    const lo = BigInt(el[1] >>> 0);
    return ((hi << 32n) | lo) & 0xffffffffffffffffn;
  }
  return BigInt(el) & 0xffffffffffffffffn;
}

async function decodeChunk(payload, compression) {
  let raw;
  if (compression === 1) raw = zlib.gunzipSync(payload, { maxOutputLength: MAX_CHUNK_INFLATED });
  else if (compression === 2) raw = zlib.inflateSync(payload, { maxOutputLength: MAX_CHUNK_INFLATED });
  else raw = payload; // 3 = non compressé
  const { parsed } = await nbt.parse(raw);
  return nbt.simplify(parsed);
}

// Parse une région et appelle emit(x, y, z, name) pour chaque bloc non-air
// DANS la boîte. `bbox` = { minX, minY, minZ, maxX, maxY, maxZ } (inclusif).
export async function parseRegion(buf, regionX, regionZ, bbox, emit) {
  if (buf.length < 8192) return;
  for (let ci = 0; ci < 1024; ci++) {
    const loc = buf.readUInt32BE(ci * 4);
    const sectorOff = loc >>> 8;
    const sectorCount = loc & 0xff;
    if (sectorOff === 0 || sectorCount === 0) continue;

    const localX = ci % 32;
    const localZ = (ci / 32) | 0;
    const chunkX = regionX * 32 + localX;
    const chunkZ = regionZ * 32 + localZ;
    const baseX = chunkX * 16;
    const baseZ = chunkZ * 16;
    // Cull au niveau chunk (16×16 en X/Z).
    if (baseX > bbox.maxX || baseX + 15 < bbox.minX) continue;
    if (baseZ > bbox.maxZ || baseZ + 15 < bbox.minZ) continue;

    const off = sectorOff * SECTOR;
    if (off + 5 > buf.length) continue;
    const length = buf.readUInt32BE(off);
    if (length <= 1 || off + 4 + length > buf.length) continue;
    const compression = buf.readUInt8(off + 4);
    const payload = buf.subarray(off + 5, off + 4 + length);

    let root;
    try { root = await decodeChunk(payload, compression); } catch { continue; }
    const sections = root.sections || root.Sections || [];
    if (!Array.isArray(sections)) continue;

    for (const sec of sections) {
      const states = sec.block_states || sec.BlockStates;
      if (!states || !Array.isArray(states.palette) || states.palette.length === 0) continue;
      const baseY = (sec.Y | 0) * 16;
      if (baseY > bbox.maxY || baseY + 15 < bbox.minY) continue;

      const palette = states.palette;
      const names = palette.map((p) => (typeof p === 'string' ? p : p.Name));
      const props = palette.map(propsOf);

      // Section homogène (1 entrée, pas de data).
      if (palette.length === 1 || !states.data) {
        const name = names[0];
        if (AIR.has(name)) continue;
        for (let n = 0; n < 4096; n++) {
          const x = baseX + (n & 15);
          const z = baseZ + ((n >> 4) & 15);
          const y = baseY + ((n >> 8) & 15);
          if (x < bbox.minX || x > bbox.maxX || y < bbox.minY || y > bbox.maxY || z < bbox.minZ || z > bbox.maxZ) continue;
          emit(x, y, z, name, props[0]);
        }
        continue;
      }

      const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
      const mask = (1n << BigInt(bits)) - 1n;
      const perLong = Math.floor(64 / bits);
      const longs = states.data.map(toBig);

      for (let n = 0; n < 4096; n++) {
        const li = Math.floor(n / perLong);
        const within = n % perLong;
        const v = Number((longs[li] >> BigInt(within * bits)) & mask);
        const name = names[v];
        if (!name || AIR.has(name)) continue;
        const x = baseX + (n & 15);
        const z = baseZ + ((n >> 4) & 15);
        const y = baseY + ((n >> 8) & 15);
        if (x < bbox.minX || x > bbox.maxX || y < bbox.minY || y > bbox.maxY || z < bbox.minZ || z > bbox.maxZ) continue;
        emit(x, y, z, name, props[v]);
      }
    }
  }
}
