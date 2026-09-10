/* eslint-disable security/detect-non-literal-fs-filename --
   Les chemins viennent d'un dossier choisi par l'utilisateur dans un dialogue
   système, joint à des noms de région r.X.Z.mca validés par REGION_FILE_RE. */
import fs from 'node:fs';
import path from 'node:path';
import { regionFileName } from '../anvil/index.js';
import { makeZip } from '../worldedit/zipWriter.js';

// Écriture dans une VRAIE save Minecraft — le seul endroit du moteur qui touche
// aux fichiers de quelqu'un d'autre. Trois garde-fous, dans cet ordre :
//
//   1. refuser si le monde est ouvert dans Minecraft (`session.lock`) ;
//   2. sauvegarder en zip horodaté tout ce qui va être réécrit ;
//   3. seulement ensuite, écrire.
//
// L'ordre n'est pas négociable : une sauvegarde prise après la première
// écriture ne sauvegarde plus rien.

const REGION_FILE_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

/**
 * Reconnaît ce qu'on vient d'ouvrir.
 *
 * @returns {{
 *   kind: 'save'|'region'|'unknown',
 *   root: string,
 *   regionDir: string|null,
 *   entitiesDir: string|null,
 *   sessionLock: string|null,
 *   name: string,
 * }}
 *
 * `kind`:
 *   - `save`   un dossier de monde (level.dat + region/) — écriture possible,
 *              mais soumise au verrou.
 *   - `region` un dossier `region/` isolé — pas de level.dat, donc pas de
 *              verrou à vérifier, mais pas de monde autour non plus.
 *   - `unknown` tout le reste.
 */
export function readSaveInfo(dir) {
  const root = path.resolve(dir);
  const name = path.basename(root);
  const has = (p) => fs.existsSync(path.join(root, p));

  // Un dossier de save : level.dat à la racine, régions dans region/.
  if (has('level.dat') || (has('region') && fs.statSync(path.join(root, 'region')).isDirectory())) {
    return {
      kind: 'save',
      root,
      name,
      regionDir: has('region') ? path.join(root, 'region') : null,
      // Les entités vivent dans leur propre dossier depuis la 1.17. Absent sur
      // un monde plus ancien, ou sur un monde neuf sans entité.
      entitiesDir: has('entities') ? path.join(root, 'entities') : null,
      sessionLock: has('session.lock') ? path.join(root, 'session.lock') : null,
    };
  }

  // Un dossier `region/` isolé : au moins un r.X.Z.mca dedans.
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()
      && fs.readdirSync(root).some((f) => REGION_FILE_RE.test(f))) {
    return { kind: 'region', root, name, regionDir: root, entitiesDir: null, sessionLock: null };
  }

  return { kind: 'unknown', root, name, regionDir: null, entitiesDir: null, sessionLock: null };
}

/** Régions présentes dans un dossier. */
export function listRegions(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((f) => { const m = f.match(REGION_FILE_RE); return m ? { file: f, regionX: Number(m[1]), regionZ: Number(m[2]) } : null; })
    .filter(Boolean);
}

// ── Choisir QUOI charger ────────────────────────────────────────────────────
//
// Une région couvre 512×512 blocs. Un monde survécu quelques mois en compte
// facilement plusieurs centaines, soit des dizaines de gigaoctets : tout
// charger n'est pas une option, c'est une panne. On ouvre donc une save en deux
// temps — d'abord la CARTE de ce qui existe (readdir + stat, instantané), puis
// seulement les régions qui recoupent la zone demandée.

export const REGION_SPAN = 512;

const fdiv = (a, b) => Math.floor(a / b);

/** Boîte monde couverte par une région, en X/Z (inclusive). */
export function regionBounds(regionX, regionZ) {
  return {
    minX: regionX * REGION_SPAN,
    minZ: regionZ * REGION_SPAN,
    maxX: regionX * REGION_SPAN + REGION_SPAN - 1,
    maxZ: regionZ * REGION_SPAN + REGION_SPAN - 1,
  };
}

/**
 * Régions qu'une boîte en coordonnées MONDE recoupe.
 * @param {{min:{x,z}, max:{x,z}}} bbox
 * @returns {{regionX:number, regionZ:number}[]}
 */
export function regionsForBBox(bbox) {
  const out = [];
  const x0 = Math.min(bbox.min.x, bbox.max.x), x1 = Math.max(bbox.min.x, bbox.max.x);
  const z0 = Math.min(bbox.min.z, bbox.max.z), z1 = Math.max(bbox.min.z, bbox.max.z);
  for (let rz = fdiv(z0, REGION_SPAN); rz <= fdiv(z1, REGION_SPAN); rz++) {
    for (let rx = fdiv(x0, REGION_SPAN); rx <= fdiv(x1, REGION_SPAN); rx++) {
      out.push({ regionX: rx, regionZ: rz });
    }
  }
  return out;
}

/**
 * Carte de ce que contient une save, SANS rien décoder : on lit le nom et la
 * taille de chaque fichier, rien de plus. Sur un monde de plusieurs
 * gigaoctets, ça reste instantané, et c'est ce qui permet de montrer la carte
 * avant de choisir quoi ouvrir.
 *
 * @returns {{
 *   regions: {regionX, regionZ, bytes, hasEntities}[],
 *   bounds: {minX, minZ, maxX, maxZ}|null,
 *   count: number,
 *   bytes: number,
 * }}
 */
export function worldOverview(info) {
  const entities = new Set(
    listRegions(info.entitiesDir).map((r) => `${r.regionX},${r.regionZ}`),
  );

  const regions = listRegions(info.regionDir).map((r) => {
    let bytes = 0;
    try { bytes = fs.statSync(path.join(info.regionDir, r.file)).size; } catch { /* disparue entre-temps */ }
    return {
      regionX: r.regionX, regionZ: r.regionZ, bytes,
      hasEntities: entities.has(`${r.regionX},${r.regionZ}`),
    };
  }).sort((a, b) => (a.regionZ - b.regionZ) || (a.regionX - b.regionX));

  if (!regions.length) return { regions: [], bounds: null, count: 0, bytes: 0 };

  const bounds = {
    minX: Math.min(...regions.map((r) => r.regionX)),
    maxX: Math.max(...regions.map((r) => r.regionX)),
    minZ: Math.min(...regions.map((r) => r.regionZ)),
    maxZ: Math.max(...regions.map((r) => r.regionZ)),
  };
  return {
    regions, bounds,
    count: regions.length,
    bytes: regions.reduce((s, r) => s + r.bytes, 0),
  };
}

/**
 * Ne retient, parmi les régions demandées, que celles qui EXISTENT vraiment.
 * Une zone qui déborde dans du terrain jamais généré est normale : on charge ce
 * qu'il y a, sans lever d'erreur pour du vide.
 */
export function selectRegions(info, wanted) {
  const present = new Set(listRegions(info.regionDir).map((r) => `${r.regionX},${r.regionZ}`));
  return wanted.filter((r) => present.has(`${r.regionX},${r.regionZ}`));
}

/** Lit les buffers des régions demandées. */
export function readRegions(info, wanted) {
  return selectRegions(info, wanted).map((r) => ({
    regionX: r.regionX, regionZ: r.regionZ,
    buffer: fs.readFileSync(path.join(info.regionDir, regionFileName(r.regionX, r.regionZ))),
  }));
}

/**
 * Le monde est-il ouvert dans Minecraft ?
 *
 * Minecraft garde un verrou exclusif sur `session.lock` tant que le monde est
 * chargé. Ce verrou n'est PAS détectable de la même façon partout :
 *
 * - **Windows** : le verrou est obligatoire au niveau du système. Ouvrir le
 *   fichier en écriture échoue (EBUSY / EPERM / EACCES). La détection est
 *   fiable, et c'est la plateforme visée.
 * - **Linux et macOS** : le verrou est *consultatif*. Ouvrir le fichier
 *   réussit même quand Minecraft le tient. On ne peut donc rien affirmer.
 *
 * D'où `reliable` dans le retour : mentir sur ce qu'on sait serait pire que de
 * l'avouer. Sur une plateforme où la détection n'est pas fiable, l'interface
 * doit demander confirmation plutôt que laisser croire que la voie est libre.
 *
 * @param {{ open?: (p: string) => void }} [io] point d'injection pour les tests
 */
export function probeWorldLock(info, io = {}) {
  const reliable = process.platform === 'win32';
  if (!info?.sessionLock) return { locked: false, reliable, reason: 'no_lock_file' };

  const open = io.open || ((p) => { const fd = fs.openSync(p, 'r+'); fs.closeSync(fd); });
  try {
    open(info.sessionLock);
    return { locked: false, reliable, reason: 'writable' };
  } catch (e) {
    const code = e?.code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      // Celui-là est sûr partout : si on ne PEUT pas écrire, on n'écrira pas.
      return { locked: true, reliable: true, reason: code };
    }
    // ENOENT ou autre : le fichier a disparu entre-temps, rien ne le tient.
    return { locked: false, reliable, reason: code || 'unknown' };
  }
}

const stamp = (d) => d.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');

/**
 * Sauvegarde en zip horodaté les fichiers de région QUI VONT ÊTRE RÉÉCRITS —
 * blocs et entités. Les autres ne sont pas copiés : sauvegarder un monde entier
 * à chaque application prendrait des gigaoctets pour rien.
 *
 * @param {{regionX:number, regionZ:number}[]} keys régions concernées
 * @returns {{file: string, entries: number, bytes: number}|null} null si rien à sauvegarder
 */
export function backupRegions({ info, keys, outDir, now = new Date() }) {
  const entries = [];
  for (const { regionX, regionZ } of keys) {
    const fname = regionFileName(regionX, regionZ);
    for (const [sub, dir] of [['region', info.regionDir], ['entities', info.entitiesDir]]) {
      if (!dir) continue;
      const src = path.join(dir, fname);
      // Une région absente est normale : on écrit peut-être là où il n'y avait
      // rien. Il n'y a alors rien à restaurer, donc rien à sauvegarder.
      if (!fs.existsSync(src)) continue;
      entries.push({ name: `${sub}/${fname}`, data: fs.readFileSync(src) });
    }
  }
  if (!entries.length) return null;

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${info.name}-${stamp(now)}.zip`);
  const buffer = makeZip(entries);
  fs.writeFileSync(file, buffer);
  return { file, entries: entries.length, bytes: buffer.length };
}

/**
 * Applique des régions à une save. Refuse si le monde est ouvert, sauvegarde
 * avant d'écrire, et n'écrit qu'ensuite.
 *
 * @param {{regionX:number, regionZ:number, buffer:Buffer}[]} regions
 * @throws {Error} `world_busy` — Minecraft tient le monde
 * @throws {Error} `no_region_dir` — la cible n'a pas de dossier region/
 * @throws {Error} `lock_unverifiable` — le verrou n'est pas vérifiable ici et
 *   l'appelant n'a pas confirmé (voir `force`)
 */
export function applyToWorld({ info, regions, backupDir, now = new Date(), force = false, io = {} }) {
  if (!info?.regionDir) throw new Error('no_region_dir');

  const lock = probeWorldLock(info, io);
  if (lock.locked) throw new Error('world_busy');
  // Détection non fiable (Linux, macOS) : on n'écrit pas dans le dos de
  // l'utilisateur. C'est à lui d'affirmer que Minecraft est fermé.
  if (!lock.reliable && info.sessionLock && !force) throw new Error('lock_unverifiable');

  const backup = backupRegions({ info, keys: regions, outDir: backupDir, now });

  let written = 0;
  for (const r of regions) {
    fs.writeFileSync(path.join(info.regionDir, regionFileName(r.regionX, r.regionZ)), r.buffer);
    written++;
  }
  return { written, backup, lock };
}
