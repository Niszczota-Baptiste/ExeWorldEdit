import os from 'node:os';
import { Worker } from 'node:worker_threads';

// Pool de fils, un par région.
//
// Pourquoi cette découpe et pas une autre : mesuré, transférer l'arbre NBT d'un
// chunk décodé coûte plus que le décoder (rapport 1,08). Toute répartition qui
// fait traverser des chunks à la frontière des fils perd donc du temps. Un
// `ArrayBuffer` de région, lui, se transfère sans copie.
//
// Le prix : chaque fil redécode sa région entière. Ça ne vaut le coup que pour
// des opérations LONGUES sur PLUSIEURS régions — d'où les deux garde-fous plus
// bas.

/**
 * Opérations dont chaque case ne dépend que de sa propre colonne (x, z).
 *
 * C'est la condition pour découper par région SANS bordure : une opération qui
 * lit un voisin (lissage, érosion, dilatation) verrait de l'air au bord de sa
 * région et produirait une couture invisible. Une opération qui lit ailleurs
 * dans la sélection (miroir, rotation, translation, stack, échelle) n'a même
 * pas de sens découpée.
 *
 * `terrain` : hauteur tirée d'un bruit fonction de (x, z), remplissage et
 * `clearAbove` dans la colonne. `naturalize` : balayage de la colonne, biome lu
 * à la même colonne. Les deux qualifient.
 *
 * N'ajouter une opération ici qu'après avoir vérifié qu'elle ne lit jamais hors
 * de son (x, z) — un test compare le résultat parallèle au résultat série.
 */
export const COLUMN_LOCAL_OPS = new Set(['terrain', 'naturalize']);

/** Un fil de moins que de cœurs : le principal a encore du travail. */
export function defaultPoolSize() {
  const n = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, Math.min(8, n - 1));
}

/**
 * Vaut-il le coup de paralléliser ?
 *
 * Chaque fil redécode sa région : sur une seule région on paierait le démarrage
 * du pool pour rien, et sur une petite sélection le décodage dominerait. Deux
 * régions et un million de cases sont des seuils prudents — au pire on reste
 * sur le chemin série, qui est correct par construction.
 */
export const MIN_REGIONS = 2;
export const MIN_VOLUME = 1_000_000;

/**
 * @param {number} regionCount nombre de régions que la SÉLECTION traverse — pas
 *   le nombre de fichiers du projet : un build de treize régions dont on
 *   n'édite qu'un coin ne donne du travail qu'à un fil.
 */
export function shouldParallelize({ operation, regionCount, selection, poolSize = defaultPoolSize() }) {
  if (!COLUMN_LOCAL_OPS.has(operation)) return false;
  if (poolSize < 2 || regionCount < MIN_REGIONS) return false;
  const v = (selection.max.x - selection.min.x + 1)
    * (selection.max.y - selection.min.y + 1)
    * (selection.max.z - selection.min.z + 1);
  return v >= MIN_VOLUME;
}

const REGION_SPAN = 512;

/** Part de la sélection qui tombe dans une région — en X/Z seulement. */
export function clipToRegion(selection, regionX, regionZ) {
  const x0 = regionX * REGION_SPAN, z0 = regionZ * REGION_SPAN;
  const x1 = x0 + REGION_SPAN - 1, z1 = z0 + REGION_SPAN - 1;
  const minX = Math.max(selection.min.x, x0), maxX = Math.min(selection.max.x, x1);
  const minZ = Math.max(selection.min.z, z0), maxZ = Math.min(selection.max.z, z1);
  if (minX > maxX || minZ > maxZ) return null;
  return {
    // Y reste ENTIER : c'est la hauteur demandée, pas une propriété de la
    // région. La rogner changerait le relief calculé.
    min: { x: minX, y: selection.min.y, z: minZ },
    max: { x: maxX, y: selection.max.y, z: maxZ },
    shape: selection.shape,
  };
}

class Pool {
  constructor(size, workerUrl) {
    this.size = size;
    this.workerUrl = workerUrl;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.seq = 0;
  }

  _spawn() {
    const w = new Worker(this.workerUrl);
    w.on('message', (msg) => {
      const job = this.pending.get(msg.jobId);
      if (!job) return;
      this.pending.delete(msg.jobId);
      // Au repos, un fil ne doit pas empêcher le processus de se terminer ;
      // pendant un travail, il DOIT le maintenir en vie, sinon la promesse
      // reste suspendue et la boucle d'événements se vide sous elle.
      w.unref();
      this.idle.push(w);
      this._drain();
      if (msg.ok) job.resolve(msg); else job.reject(new Error(msg.error));
    });
    w.on('error', (err) => {
      // Un fil mort ne doit pas laisser un appel suspendu pour toujours.
      for (const [id, job] of this.pending) {
        if (job.worker === w) { this.pending.delete(id); job.reject(err); }
      }
      w.unref();
      this.workers = this.workers.filter((x) => x !== w);
      this.idle = this.idle.filter((x) => x !== w);
    });
    w.unref();
    this.workers.push(w);
    return w;
  }

  _drain() {
    while (this.queue.length && this.idle.length) {
      const { msg, transfer, resolve, reject } = this.queue.shift();
      const w = this.idle.pop();
      this.pending.set(msg.jobId, { resolve, reject, worker: w });
      w.ref();
      w.postMessage(msg, transfer);
    }
  }

  run(msg, transfer) {
    msg.jobId = ++this.seq;
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, transfer, resolve, reject });
      if (!this.idle.length && this.workers.length < this.size) this.idle.push(this._spawn());
      this._drain();
    });
  }

  async close() {
    const all = this.workers.slice();
    this.workers = []; this.idle = []; this.queue = [];
    await Promise.all(all.map((w) => w.terminate()));
  }
}

let shared = null;

/** Pool partagé, créé au premier besoin — pas au démarrage du moteur. */
export function getPool(size = defaultPoolSize()) {
  const url = new URL('./regionWorker.js', import.meta.url);
  if (!shared) shared = new Pool(size, url);
  return shared;
}

export async function closePool() {
  if (shared) { await shared.close(); shared = null; }
}

/**
 * Applique une opération colonne-locale, une région par fil.
 *
 * @param {object} o
 * @param {{regionX,regionZ,buffer:Buffer}[]} o.sources régions du staging
 * @param {string} o.operation
 * @param {object} o.params
 * @param {{min,max}} o.selection sélection COMPLÈTE, en coordonnées monde
 * @returns {Promise<{buffers: Map<string, Buffer>, blocksChanged: number, bounds: object}>}
 */
export async function runColumnLocal({ sources, operation, params, selection, poolSize }) {
  if (!COLUMN_LOCAL_OPS.has(operation)) throw new Error('operation_non_parallelisable');
  const pool = getPool(poolSize);

  const jobs = [];
  for (const src of sources) {
    const clipped = clipToRegion(selection, src.regionX, src.regionZ);
    if (!clipped) continue; // région hors sélection : rien à faire, rien à réécrire
    // `slice` détache une copie propre : le buffer d'origine reste utilisable
    // côté appelant, et c'est cette copie qui part sans être recopiée.
    const ab = src.buffer.buffer.slice(src.buffer.byteOffset, src.buffer.byteOffset + src.buffer.byteLength);
    jobs.push(pool.run(
      { regionX: src.regionX, regionZ: src.regionZ, buffer: ab, operation, params, selection: clipped },
      [ab],
    ).then((r) => ({ ...r, regionX: src.regionX, regionZ: src.regionZ })));
  }

  const done = await Promise.all(jobs);

  const buffers = new Map();
  let blocksChanged = 0;
  let bounds = null;
  for (const r of done) {
    blocksChanged += r.blocksChanged;
    if (r.buffer) buffers.set(`${r.regionX},${r.regionZ}`, Buffer.from(r.buffer));
    bounds = bounds ? unionBounds(bounds, r.bounds) : r.bounds;
  }
  return { buffers, blocksChanged, bounds: bounds || selection };
}

const unionBounds = (a, b) => ({
  min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
  max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
});
