// Passage de l'artefact creux du moteur à des chunks d'identifiants, puis
// distribution du maillage sur un petit pool de workers.
//
// L'artefact creux ne contient QUE les blocs non-air : c'est ce qui rend le
// transfert supportable, mais ça veut dire qu'il faut regonfler une grille pour
// mailler. On le fait par chunk de 16³, jamais sur le build entier.

export const CH = 16;
const P = 18;
const PAD = 1;

export const chunkKey = (cx, cy, cz) => `${cx},${cy},${cz}`;

/**
 * @param {{palette: {name: string}[], min: {x,y,z}, blocks: number[]}} sparse
 * @returns {{chunks: Map<string, Uint16Array>, palette: string[]}}
 *   Les identifiants sont l'index de palette + 1 ; 0 reste l'air.
 */
export function sparseToChunks(sparse) {
  const chunks = new Map();
  const { blocks, min } = sparse;
  for (let i = 0; i < blocks.length; i += 4) {
    const x = blocks[i] + min.x;
    const y = blocks[i + 1] + min.y;
    const z = blocks[i + 2] + min.z;
    const id = blocks[i + 3] + 1;

    const cx = Math.floor(x / CH), cy = Math.floor(y / CH), cz = Math.floor(z / CH);
    const key = chunkKey(cx, cy, cz);
    let grid = chunks.get(key);
    if (!grid) { grid = new Uint16Array(CH * CH * CH); chunks.set(key, grid); }
    const lx = x - cx * CH, ly = y - cy * CH, lz = z - cz * CH;
    grid[(ly * CH + lz) * CH + lx] = id;
  }
  return chunks;
}

/**
 * Bloc paddé 18³ : le chunk plus une couche de ses voisins. Sans cette couche,
 * chaque frontière de chunk afficherait un mur de faces qui devraient être
 * cachées, et l'occlusion ambiante se couperait net au bord.
 */
export function paddedChunk(chunks, cx, cy, cz) {
  const out = new Uint16Array(P * P * P);
  const self = chunks.get(chunkKey(cx, cy, cz));
  if (!self) return out;

  // Le chunk lui-même.
  for (let y = 0; y < CH; y++) {
    for (let z = 0; z < CH; z++) {
      const src = (y * CH + z) * CH;
      const dst = ((y + PAD) * P + (z + PAD)) * P + PAD;
      out.set(self.subarray(src, src + CH), dst);
    }
  }

  // La croûte : les 6 voisins de face, ce qui suffit à l'AO de cubes pleins
  // (les diagonales de coin ne changent que des cas invisibles).
  //
  // `axis` = l'axe du voisin, `side` son côté. On copie la rangée du voisin qui
  // touche la nôtre, en parcourant les DEUX autres axes indépendamment. Une
  // première version les confondait et ne recopiait qu'une diagonale : il en
  // restait des faces fantômes à chaque frontière de chunk.
  const local = [0, 0, 0];
  const copyFace = (axis, side) => {
    const nc = [cx, cy, cz];
    nc[axis] += side;
    const nb = chunks.get(chunkKey(nc[0], nc[1], nc[2]));
    if (!nb) return;

    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    // Le voisin est avant nous : c'est sa dernière rangée qui nous touche.
    local[axis] = side < 0 ? CH - 1 : 0;
    const padded = side < 0 ? -1 : CH;

    for (let a = 0; a < CH; a++) {
      local[u] = a;
      for (let b = 0; b < CH; b++) {
        local[v] = b;
        const id = nb[(local[1] * CH + local[2]) * CH + local[0]];
        if (!id) continue;
        const p = [0, 0, 0];
        p[axis] = padded;
        p[u] = a;
        p[v] = b;
        out[((p[1] + PAD) * P + (p[2] + PAD)) * P + (p[0] + PAD)] = id;
      }
    }
  };

  for (let axis = 0; axis < 3; axis++) { copyFace(axis, -1); copyFace(axis, 1); }

  return out;
}

/** Petit pool : le maillage ne doit jamais retenir le fil de l'interface. */
export function createMeshPool(size = Math.min(4, navigator.hardwareConcurrency || 2)) {
  const workers = [];
  const idle = [];
  const queue = [];
  const handlers = new Map();

  for (let i = 0; i < size; i++) {
    const w = new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const handler = handlers.get(w);
      handlers.delete(w);
      handler?.(e.data);
      idle.push(w);
      pump();
    };
    workers.push(w);
    idle.push(w);
  }

  function pump() {
    while (idle.length && queue.length) {
      const w = idle.pop();
      const job = queue.shift();
      handlers.set(w, job.resolve);
      w.postMessage(job.message, job.transfer);
    }
  }

  return {
    size,
    mesh(message, transfer) {
      return new Promise((resolve) => { queue.push({ message, transfer, resolve }); pump(); });
    },
    dispose() { for (const w of workers) w.terminate(); },
    get pending() { return queue.length; },
  };
}
