// Encodage binaire de l'aperçu.
//
// L'aperçu était du JSON gzippé. Mesuré sur un build de 850 000 blocs, à chaque
// opération : `JSON.stringify` 46 ms, gzip 76 ms à l'écriture, et `JSON.parse`
// 161 ms + gunzip 48 ms à la relecture. Soit un plancher de ~330 ms par
// commande, quel que soit le nombre de blocs réellement changés.
//
// Le format ci-dessous écrit les mêmes données en ~10 ms et les relit en ~20 ms,
// pour 5 Mo au lieu de 2,3 Mo. C'est le bon échange : un aperçu est un FICHIER
// DE CACHE, régénérable à volonté et jamais partagé. On l'optimise pour le
// temps, pas pour la place — exactement comme le choix du niveau de gzip qui l'a
// précédé.
//
// Disposition :
//
//   0   8   magie « TITIPRV1 »
//   8   4   longueur de l'en-tête JSON (octets), Uint32 LE
//   12  n   en-tête JSON, complété à un multiple de 4
//   …       corps : dépend du mode (voir plus bas)
//
// Le corps est aligné sur 4 octets : une vue `Uint32Array` sur un décalage non
// aligné lève, et le bourrage est le seul moyen de le garantir.

const MAGIC = 'TITIPRV1';
const HEAD = 12;
const align4 = (n) => (n + 3) & ~3;

/**
 * Deux modes, choisis d'après les données :
 *
 * - `linear` (6 o/bloc) : un index de case unique en Uint32. Utilisable tant
 *   que le VOLUME de l'emprise tient dans 32 bits — soit une boîte de 1625³,
 *   ce qui couvre tout build réaliste.
 * - `triple` (14 o/bloc) : x, y, z séparés en Uint32. Le repli quand l'emprise
 *   est trop grande pour un index linéaire.
 *
 * Dans les deux cas la palette est en Uint16, sauf si elle dépasse 65 535
 * entrées — auquel cas on passe en Uint32 plutôt que de tronquer en silence.
 */
const U32_MAX = 4294967295;

export function encodePreview(sparse) {
  const { size, blocks, palette } = sparse;
  const count = sparse.count ?? blocks.length / 4;
  const volume = size.x * size.y * size.z;

  const mode = volume <= U32_MAX ? 'linear' : 'triple';
  const wide = palette.length > 65535;

  const header = {
    v: 1,
    mode,
    wide,
    count,
    truncated: !!sparse.truncated,
    min: sparse.min,
    size,
    palette,
    bom: sparse.bom || [],
  };
  const headBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const headLen = align4(headBuf.length);

  const coordBytes = mode === 'linear' ? 4 : 12;
  const palBytes = wide ? 4 : 2;
  const body = align4(count * coordBytes) + count * palBytes;

  const out = Buffer.alloc(HEAD + headLen + body);
  out.write(MAGIC, 0, 'ascii');
  out.writeUInt32LE(headBuf.length, 8);
  headBuf.copy(out, HEAD);

  const coordsAt = HEAD + headLen;
  const palAt = coordsAt + align4(count * coordBytes);
  const pal = wide
    ? new Uint32Array(out.buffer, out.byteOffset + palAt, count)
    : new Uint16Array(out.buffer, out.byteOffset + palAt, count);

  if (mode === 'linear') {
    const idx = new Uint32Array(out.buffer, out.byteOffset + coordsAt, count);
    const sxz = size.x * size.z;
    for (let i = 0, k = 0; k < count; i += 4, k++) {
      idx[k] = blocks[i + 1] * sxz + blocks[i + 2] * size.x + blocks[i];
      pal[k] = blocks[i + 3];
    }
  } else {
    const xyz = new Uint32Array(out.buffer, out.byteOffset + coordsAt, count * 3);
    for (let i = 0, k = 0; k < count; i += 4, k++) {
      xyz[k * 3] = blocks[i];
      xyz[k * 3 + 1] = blocks[i + 1];
      xyz[k * 3 + 2] = blocks[i + 2];
      pal[k] = blocks[i + 3];
    }
  }
  return out;
}

/** Reconnaît le format sans le décoder — sert à accepter les anciens fichiers. */
export function isBinaryPreview(buf) {
  return Buffer.isBuffer(buf) && buf.length >= HEAD && buf.toString('ascii', 0, 8) === MAGIC;
}

export function decodePreview(buf) {
  if (!isBinaryPreview(buf)) throw new Error('bad_preview');
  const headLenRaw = buf.readUInt32LE(8);
  const header = JSON.parse(buf.toString('utf8', HEAD, HEAD + headLenRaw));
  const { mode, wide, count, size } = header;

  const coordBytes = mode === 'linear' ? 4 : 12;
  const coordsAt = HEAD + align4(headLenRaw);
  const palAt = coordsAt + align4(count * coordBytes);
  const pal = wide
    ? new Uint32Array(buf.buffer, buf.byteOffset + palAt, count)
    : new Uint16Array(buf.buffer, buf.byteOffset + palAt, count);

  // Tableau ORDINAIRE prédimensionné : c'est la forme que le reste du moteur et
  // le renderer attendent, et la remplir par index coûte dix fois moins que de
  // convertir une vue typée (mesuré).
  const blocks = new Array(count * 4);

  if (mode === 'linear') {
    const idx = new Uint32Array(buf.buffer, buf.byteOffset + coordsAt, count);
    const sxz = size.x * size.z;
    for (let k = 0, i = 0; k < count; k++, i += 4) {
      const n = idx[k];
      const y = (n / sxz) | 0;
      const rest = n - y * sxz;
      blocks[i] = rest % size.x;
      blocks[i + 1] = y;
      blocks[i + 2] = (rest / size.x) | 0;
      blocks[i + 3] = pal[k];
    }
  } else {
    const xyz = new Uint32Array(buf.buffer, buf.byteOffset + coordsAt, count * 3);
    for (let k = 0, i = 0; k < count; k++, i += 4) {
      blocks[i] = xyz[k * 3];
      blocks[i + 1] = xyz[k * 3 + 1];
      blocks[i + 2] = xyz[k * 3 + 2];
      blocks[i + 3] = pal[k];
    }
  }

  return {
    palette: header.palette,
    blocks,
    bom: header.bom,
    count,
    truncated: header.truncated,
    min: header.min,
    size,
  };
}
