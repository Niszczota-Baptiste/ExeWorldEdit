import { parentPort } from 'node:worker_threads';
import { RegionStore } from './regionStore.js';
import { opTerrain, opNaturalize } from './transform.js';

// Un fil qui possède UNE région, du début à la fin.
//
// C'est la seule découpe qui gagne quelque chose : mesuré, transférer l'arbre
// NBT d'un chunk coûte PLUS que le décoder (65 ms contre 60 sur 128 chunks).
// Un worker qui rendrait des chunks décodés ferait donc perdre du temps. En
// revanche un `ArrayBuffer` se transfère sans copie : le fil reçoit la région
// brute, la décode, opère, la réencode, et rend des octets.
//
// Ne passent ici que les opérations COLONNE-LOCALES (voir `regionPool.js`) :
// elles ne lisent jamais hors de leur propre (x, z), donc découper par région
// ne peut pas changer le résultat.

const OPS = {
  terrain: opTerrain,
  naturalize: opNaturalize,
};

parentPort.on('message', async (msg) => {
  const { jobId, regionX, regionZ, buffer, operation, params, selection } = msg;
  try {
    const fn = OPS[operation];
    if (!fn) throw new Error(`operation_non_parallelisable: ${operation}`);

    const store = new RegionStore([{ regionX, regionZ, buffer: Buffer.from(buffer) }]);
    await store.warmup(selection);
    const res = await fn(store, selection, params, { yield: async () => {} });

    const commit = store.commit({ touchedOnly: true });
    const out = commit.get(`${regionX},${regionZ}`) || null;
    const payload = out
      ? out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
      : null;

    parentPort.postMessage(
      {
        jobId,
        ok: true,
        buffer: payload,
        blocksChanged: res.blocksChanged || 0,
        bounds: res.bounds || selection,
      },
      payload ? [payload] : [],
    );
  } catch (err) {
    parentPort.postMessage({ jobId, ok: false, error: err?.message || String(err) });
  }
});
