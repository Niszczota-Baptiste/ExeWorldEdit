/* eslint-disable security/detect-non-literal-fs-filename --
   Tous les chemins sont construits sous le dossier que l'adapter nous donne
   (`stagingDir`), à partir de noms de région r.X.Z.mca validés par
   REGION_FILE_RE. Jamais d'entrée utilisateur brute dans un chemin. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  regionFileName, regionCoordsFromName, writeRegion, readRegion, decodeChunk,
} from '../anvil/index.js';
import { extractMcaEntries } from '../worldedit/zipReader.js';
import { RegionStore } from '../worldedit/regionStore.js';
import { runColumnLocal, shouldParallelize } from '../worldedit/regionPool.js';
import {
  opMirror, opMirrorCopy, opRotate, opTranslate, opReplace, opSet, opCopy, opPaste, opCut,
  opWalls, opFaces, opHollow, opOverlay, opNaturalize, opStack, opSphere, opCyl, opSmooth, opScale, opMix,
  opLine, opPyramid, opCone, opErode, opDilate, opDrain, opBiome, opPath, opTerrain,
  MaskedVolume, sameBlock,
} from '../worldedit/transform.js';
import {
  DEFAULT_LIMITS, normalizeLimits, fdiv, buildExtent, buildLimits, validateSelection,
  clampBBox, unionBBox, regionKeysForBBox, panelPlane, weightedPicker,
  PANEL_PRESETS, clamp01, tick, phaseTimer,
} from './geometry.js';
import { blankRegions, regionsToDownload } from './blank.js';
import { splicePreview } from './preview.js';
import { encodePreview, decodePreview, isBinaryPreview } from './previewCodec.js';

// Orchestration NON DESTRUCTIVE des opérations WorldEdit.
//
// Le contrat, inchangé depuis le site : on ne touche JAMAIS au fichier source.
// À la première opération on matérialise une copie de staging, et c'est elle
// seule qu'on modifie. Chaque opération commence par un snapshot des régions
// qu'elle va toucher, ce qui donne l'undo. La source reste disponible pour
// repartir de zéro à tout moment.
//
// Tout ce qui dépend de l'hôte (où vivent les projets, les métadonnées, le
// journal) passe par le StorageAdapter reçu ici. Le reste — régions, snapshots,
// aperçu — vit dans le dossier que l'adapter nous donne, et nous appartient.

const REGION_FILE_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

const OPS = {
  mirror: (store, sel, p) => opMirror(store, sel, p),
  mirrorcopy: (store, sel, p) => opMirrorCopy(store, sel, p),
  rotate: (store, sel, p) => opRotate(store, sel, p),
  translate: (store, sel, p) => opTranslate(store, sel, p),
  replace: (store, sel, p) => opReplace(store, sel, p),
  set: (store, sel, p) => opSet(store, sel, p),
  cut: (store, sel) => opCut(store, sel), // copie + vide la sélection
  walls: (store, sel, p) => opWalls(store, sel, p),
  faces: (store, sel, p) => opFaces(store, sel, p),
  hollow: (store, sel) => opHollow(store, sel),
  overlay: (store, sel, p) => opOverlay(store, sel, p),
  naturalize: (store, sel, p) => opNaturalize(store, sel, p),
  stack: (store, sel, p) => opStack(store, sel, p),
  sphere: (store, sel, p) => opSphere(store, sel, p),
  cyl: (store, sel, p) => opCyl(store, sel, p),
  smooth: (store, sel, p) => opSmooth(store, sel, p),
  scale: (store, sel, p) => opScale(store, sel, p),
  mix: (store, sel, p) => opMix(store, sel, p),
  line: (store, sel, p) => opLine(store, sel, p),
  pyramid: (store, sel, p) => opPyramid(store, sel, p),
  cone: (store, sel, p) => opCone(store, sel, p),
  erode: (store, sel, p) => opErode(store, sel, p),
  dilate: (store, sel, p) => opDilate(store, sel, p),
  drain: (store, sel) => opDrain(store, sel),
  biome: (store, sel, p) => opBiome(store, sel, p),
  path: (store, sel, p) => opPath(store, sel, p),
  terrain: (store, sel, p) => opTerrain(store, sel, p),
};

export const OPERATION_NAMES = Object.keys(OPS);

/**
 * Lie le staging à un hôte.
 * @param {import('../storage/StorageAdapter.js').StorageAdapter} adapter
 * @param {Partial<typeof DEFAULT_LIMITS>} [options] plafonds, réglables par l'app
 */
export function createStaging(adapter, options = {}) {
  // Muté en place par `setLimits` : tous les usages lisent `limits.x` au moment
  // de l'appel, donc un changement prend effet sans reconstruire le staging
  // (et sans perdre le cache d'aperçu).
  //
  // PAS de bornage ici : `options` vient du code appelant, pas de
  // l'utilisateur. Un test qui demande un budget d'aperçu de 10 blocs pour
  // vérifier la troncature doit obtenir 10. Le bornage est à la frontière des
  // réglages — `setLimits`.
  const limits = { ...DEFAULT_LIMITS, ...options };

  // ── Arborescence de travail, sous le dossier que l'adapter nous donne ─────

  const dirFor = (id) => adapter.stagingDir(id);
  const regionsDir = (id) => path.join(dirFor(id), 'regions');
  const undoDir = (id) => path.join(dirFor(id), 'undo');
  const redoDir = (id) => path.join(dirFor(id), 'redo');
  const previewPath = (id) => path.join(dirFor(id), 'preview.bin');
  // L'aperçu était du JSON gzippé jusqu'à la phase 1.2. On continue de lire
  // l'ancien fichier — un projet ouvert avant la mise à jour ne doit pas perdre
  // son aperçu — mais on n'en écrit plus.
  const legacyPreviewPath = (id) => path.join(dirFor(id), 'preview.json.gz');

  const editLimits = (project) => buildLimits(project, limits);
  const checkSelection = (sel, bbox, maxVolume = limits.maxSelectionVolume) => {
    const out = validateSelection(sel, bbox, { maxVolume });
    if (typeof out === 'string') throw new Error(out);
    return out;
  };

  // ── Matérialisation ───────────────────────────────────────────────────────

  /** Déplie le source du projet en r.X.Z.mca sous regions/. Idempotent. */
  function materialize(project) {
    const rdir = regionsDir(project.id);
    if (fs.existsSync(rdir) && fs.readdirSync(rdir).some((f) => REGION_FILE_RE.test(f))) return rdir;
    if (!project.source?.file) throw new Error('no_source');
    fs.mkdirSync(rdir, { recursive: true });
    const buf = adapter.readSource(project);
    if (/\.zip$/i.test(project.source.name || '')) {
      for (const e of extractMcaEntries(buf)) {
        fs.writeFileSync(path.join(rdir, regionFileName(e.regionX, e.regionZ)), e.data);
      }
    } else {
      const rc = regionCoordsFromName(project.source.name);
      if (!rc) throw new Error('region_coords_unknown');
      fs.writeFileSync(path.join(rdir, regionFileName(rc.regionX, rc.regionZ)), buf);
    }
    return rdir;
  }

  /**
   * Installe des régions déjà construites comme staging du projet (build
   * vierge, carte en blocs, zone extraite). C'est le pendant « sans source »
   * de `materialize`.
   */
  function seedRegions(id, regions) {
    const rdir = regionsDir(id);
    fs.mkdirSync(rdir, { recursive: true });
    for (const r of regions) {
      fs.writeFileSync(path.join(rdir, regionFileName(r.regionX, r.regionZ)), r.buffer);
    }
    return rdir;
  }

  function listRegionFiles(id) {
    const rdir = regionsDir(id);
    if (!fs.existsSync(rdir)) return [];
    return fs.readdirSync(rdir)
      .map((f) => { const m = f.match(REGION_FILE_RE); return m ? { file: f, regionX: Number(m[1]), regionZ: Number(m[2]) } : null; })
      .filter(Boolean);
  }

  function loadStore(project) {
    materialize(project);
    const rdir = regionsDir(project.id);
    const sources = listRegionFiles(project.id).map(({ file, regionX, regionZ }) => ({
      regionX, regionZ, buffer: fs.readFileSync(path.join(rdir, file)),
    }));
    return new RegionStore(sources);
  }

  function writeRegions(id, commitMap) {
    const rdir = regionsDir(id);
    for (const [key, buffer] of commitMap) {
      const [rx, rz] = key.split(',').map(Number);
      fs.writeFileSync(path.join(rdir, regionFileName(rx, rz)), buffer);
    }
  }

  // ── Piles undo / redo (snapshots de fichiers de région) ───────────────────

  function dirSeqs(base) {
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base).map(Number).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  }
  const undoSeqs = (id) => dirSeqs(undoDir(id));
  const redoSeqs = (id) => dirSeqs(redoDir(id));

  /** Copie l'état actuel des régions `regionKeys` dans un nouveau snapshot. */
  function snapshotInto(base, id, regionKeys, cap = limits.maxUndo) {
    const seqs = dirSeqs(base);
    const seq = (seqs.length ? seqs[seqs.length - 1] : 0) + 1;
    const dest = path.join(base, String(seq));
    fs.mkdirSync(dest, { recursive: true });
    const rdir = regionsDir(id);
    for (const key of regionKeys) {
      const [rx, rz] = key.split(',').map(Number);
      const fname = regionFileName(rx, rz);
      const src = path.join(rdir, fname);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, fname));
    }
    for (const old of dirSeqs(base).slice(0, Math.max(0, dirSeqs(base).length - cap))) {
      fs.rmSync(path.join(base, String(old)), { recursive: true, force: true });
    }
  }
  const snapshotRegions = (id, regionKeys) => snapshotInto(undoDir(id), id, regionKeys);
  const clearRedo = (id) => fs.rmSync(redoDir(id), { recursive: true, force: true });

  /**
   * Restaure un snapshot dans regions/, en capturant d'abord l'état actuel des
   * mêmes régions dans `intoBase` — c'est ce qui rend l'opération réversible
   * dans les deux sens (undo ↔ redo).
   */
  function applySnapshot(snapDir, id, intoBase) {
    const rdir = regionsDir(id);
    const files = fs.readdirSync(snapDir).filter((f) => REGION_FILE_RE.test(f));
    const keys = files.map((f) => { const m = f.match(REGION_FILE_RE); return `${m[1]},${m[2]}`; });
    snapshotInto(intoBase, id, keys, limits.maxUndo);
    for (const f of files) fs.copyFileSync(path.join(snapDir, f), path.join(rdir, f));
    fs.rmSync(snapDir, { recursive: true, force: true });
  }

  // ── Aperçu ────────────────────────────────────────────────────────────────

  // Niveau 1 et non le niveau par défaut : mesuré sur le build de démonstration,
  // compresser 9,7 Mo d'aperçu coûtait 457 ms au défaut contre 67 ms au niveau 1,
  // pour 350 ko de plus. C'est un FICHIER DE CACHE local, régénérable à volonté —
  // payer 390 ms par opération pour l'alléger d'un tiers n'a aucun sens.

  // Dernier aperçu écrit, gardé en mémoire. Le recollage a besoin du précédent
  // à chaque opération, et le relire coûtait 209 ms (48 de gunzip, 161 de
  // `JSON.parse`) pour un objet qu'on venait soi-même d'écrire.
  //
  // Le cache est posé DANS `writePreview` et `readPreview` : toute écriture
  // passe par là, donc il ne peut pas se désynchroniser du fichier.
  //
  // UNE seule case, pas une table : un aperçu de 850 000 blocs pèse ~27 Mo en
  // mémoire, et on n'édite qu'un build à la fois. Changer de projet évince, ce
  // qui coûte une relecture — pas une fuite.
  let previewCache = null; // { id, sparse }

  function writePreview(id, sparse) {
    fs.writeFileSync(previewPath(id), encodePreview(sparse));
    // Un ancien aperçu resté à côté ferait deux sources pour la même chose.
    try { fs.rmSync(legacyPreviewPath(id), { force: true }); } catch { /* déjà parti */ }
    previewCache = { id, sparse };
  }

  /**
   * Fin de parcours commun : l'emprise grandit si l'opération a écrit au-delà
   * du contenu existant (construire au-dessus, stack qui déborde), bornée aux
   * limites du monde, et l'aperçu couvre la nouvelle emprise.
   */
  async function growAndPreview(project, store, sel, resultBounds) {
    const grown = clampBBox(unionBBox(buildExtent(project), resultBounds || sel), editLimits(project));
    adapter.saveExtent(project.id, grown);

    // Redériver l'emprise ENTIÈRE après chaque opération coûtait 82 % du temps
    // du moteur : 2,1 millions de cases reparcourues pour en changer 121. On ne
    // redérive donc que la boîte touchée, et on la recolle sur l'aperçu
    // précédent.
    //
    // La boîte touchée est `sel ∪ bounds` — exactement celle dont on vient de
    // prendre l'instantané d'annulation. Ce n'est pas un choix de confort : si
    // une opération écrivait hors de cette boîte, l'undo serait DÉJÀ faux. Le
    // recollage est donc aussi fiable que l'annulation, ni plus ni moins.
    const dirty = clampBBox(unionBBox(sel, resultBounds || sel), grown);
    const base = readPreview(project.id);
    if (base) {
      // Le store doit être chaud sur ce qu'on va parcourir. Il l'est déjà quand
      // l'opération vient de s'en servir, mais pas après le chemin parallèle,
      // où les fils ont travaillé sur des copies et où celui-ci sort du disque.
      // `warmup` saute ce qui est déjà décodé : le rappeler ne coûte rien.
      await store.warmup(dirty);
      const patch = store.deriveSparse(dirty, limits.previewMaxBlocks, { truncate: true });
      const spliced = splicePreview({ base, patch, dirty, extent: grown, maxBlocks: limits.previewMaxBlocks });
      // `null` = le recollage ne peut rien garantir (source tronquée, budget
      // dépassé). On retombe sur la dérivation complète, qui tronque proprement.
      if (spliced) { writePreview(project.id, spliced); return spliced; }
    }

    // Aperçu PARTIEL au-delà du budget : la commande, elle, a tout écrit.
    await store.warmup(grown);
    const sparse = store.deriveSparse(grown, limits.previewMaxBlocks, { truncate: true });
    writePreview(project.id, sparse);
    return sparse;
  }

  /**
   * Redérive l'aperçu depuis le staging (après undo/redo, qui restaurent des
   * fichiers sans passer par un store).
   *
   * Écart assumé avec le site : là-bas cette fonction appelait `deriveSparse`
   * sans troncature, si bien qu'annuler une opération sur un très gros build
   * levait `too_many_blocks` — l'annulation avait pourtant bien eu lieu sur
   * disque, seule la régénération de l'aperçu échouait, et l'utilisateur
   * voyait une erreur pour une opération réussie. On tronque comme partout
   * ailleurs.
   */
  async function regenPreview(project) {
    const bbox = buildExtent(project);
    const store = loadStore(project);
    await store.warmup(bbox);
    writePreview(project.id, store.deriveSparse(bbox, limits.previewMaxBlocks, { truncate: true }));
  }

  /**
   * Relève ou abaisse les plafonds depuis les RÉGLAGES, donc en bornant : c'est
   * ici qu'entre une valeur saisie par un humain. Rend le jeu complet appliqué.
   */
  function setLimits(patch) {
    Object.assign(limits, normalizeLimits({ ...limits, ...(patch || {}) }));
    return { ...limits };
  }

  // ── API ───────────────────────────────────────────────────────────────────

  const hasPendingEdits = (id) => previewFilePath(id) !== null;

  function previewFilePath(id) {
    const p = previewPath(id);
    if (fs.existsSync(p)) return p;
    const legacy = legacyPreviewPath(id);
    return fs.existsSync(legacy) ? legacy : null;
  }

  function readPreview(id) {
    const p = previewFilePath(id);
    if (!p) {
      if (previewCache?.id === id) previewCache = null;
      return null;
    }
    if (previewCache?.id === id) return previewCache.sparse;
    const raw = fs.readFileSync(p);
    // Le format se reconnaît à ses octets, pas à son nom : un aperçu écrit par
    // une version antérieure se relit, la prochaine écriture le convertit.
    const sparse = isBinaryPreview(raw)
      ? decodePreview(raw)
      : JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
    previewCache = { id, sparse };
    return sparse;
  }

  /**
   * Même contrat qu'`applyOperation`, mais chaque région part dans son fil.
   *
   * Réservé aux opérations COLONNE-LOCALES (`COLUMN_LOCAL_OPS`) : elles ne
   * lisent jamais hors de leur propre (x, z), donc découper par région ne peut
   * pas changer le résultat. Un test compare case par case avec le chemin
   * série, sélection à cheval sur une frontière de région.
   */
  async function applyInParallel({ project, operation, params, sel, actor, timer, progress, startedAt, files }) {
    timer.enter('load');
    progress('load', 5);
    const rdir = regionsDir(project.id);
    const sources = files.map(({ file, regionX, regionZ }) => ({
      regionX, regionZ, buffer: fs.readFileSync(path.join(rdir, file)),
    }));

    timer.enter('apply');
    progress('apply', 30); await tick();
    const out = await runColumnLocal({ sources, operation, params: params || {}, selection: sel });

    timer.enter('commit');
    progress('commit', 60); await tick();
    snapshotRegions(project.id, regionKeysForBBox(unionBBox(sel, out.bounds || sel)));
    clearRedo(project.id);
    writeRegions(project.id, out.buffers);

    timer.enter('preview');
    progress('preview', 85); await tick();
    // Le store est rechargé APRÈS écriture : les fils ont travaillé sur des
    // copies, celui-ci lit ce qui est réellement sur le disque.
    const store = loadStore(project);
    const sparse = await growAndPreview(project, store, sel, out.bounds);

    const durationMs = Date.now() - startedAt;
    const timings = timer.finish();
    adapter.appendAudit({
      projectId: project.id, actor, operation,
      params: { selection: sel, params: params || {} },
      blocksChanged: out.blocksChanged, durationMs, timings,
    });
    return {
      blocksChanged: out.blocksChanged, bounds: out.bounds || sel,
      durationMs, previewTruncated: !!sparse.truncated, timings, parallel: true,
    };
  }

  /**
   * Applique une opération sur le staging et renvoie le diff.
   * `onProgress(phase, pct)` est appelé entre les phases.
   */
  async function applyOperation({ project, operation, params, selection, actor, clipboard, onProgress }) {
    const startedAt = Date.now();
    // Le chronomètre suit les mêmes phases que la barre de progression : ce que
    // l'utilisateur voit défiler est exactement ce qui est mesuré.
    const timer = phaseTimer();
    const progress = (phase, pct) => { onProgress?.(phase, pct); };
    const extent = buildExtent(project);
    const sel = checkSelection(selection, editLimits(project));

    // Chemin PARALLÈLE : une région par fil, pour les opérations colonne-locales
    // assez grosses pour que ça vaille le démarrage du pool. Les fils rendent
    // des régions déjà réencodées ; le principal n'a plus qu'à les écrire.
    const rfiles = listRegionFiles(project.id);
    // Ce qui compte est le nombre de régions que la SÉLECTION traverse, pas le
    // nombre de fichiers du projet : un build de treize régions dont on n'édite
    // qu'un coin ne donne du travail qu'à un seul fil.
    const touchedRegions = regionKeysForBBox(sel).size;
    if (shouldParallelize({ operation, regionCount: touchedRegions, selection: sel })) {
      return applyInParallel({
        project, operation, params, sel, actor, timer, progress, startedAt, files: rfiles,
      });
    }

    timer.enter('load');
    progress('load', 5);
    const store = loadStore(project);
    await store.warmup(extent); // décode les chunks du build (XZ) — Y libre ensuite
    timer.enter('apply');
    progress('apply', 30); await tick();
    // Forme non rectangulaire → écritures bornées à la forme (sphère/cylindre).
    const target = sel.shape && sel.shape.type !== 'box' ? new MaskedVolume(store, sel) : store;

    let result;
    if (operation === 'copy') {
      // copy ne modifie rien : on renvoie le presse-papier, l'appelant le garde.
      result = opCopy(store, sel);
      return { clipboard: result.clipboard, blocksChanged: 0, bounds: sel };
    }
    if (operation === 'paste') {
      if (!clipboard) throw new Error('empty_clipboard');
      result = opPaste(target, clipboard, { at: sel.min, mode: params?.mode === 'overwrite' ? 'overwrite' : 'overlay' });
    } else {
      const fn = OPS[operation];
      if (!fn) throw new Error('unknown_operation');
      // ctx.yield : rendre la main périodiquement pendant les grosses ops.
      const ctx = { yield: async () => { await tick(); progress('apply', 45); } };
      result = await fn(target, sel, params || {}, ctx);
    }
    timer.enter('commit');
    progress('commit', 60); await tick();

    // Snapshot AVANT écriture : régions intersectant sélection ∪ emprise résultat.
    snapshotRegions(project.id, regionKeysForBBox(unionBBox(sel, result.bounds || sel)));
    clearRedo(project.id); // une nouvelle opération invalide la pile de rétablissement
    writeRegions(project.id, store.commit({ touchedOnly: true }));

    timer.enter('preview');
    progress('preview', 85); await tick();
    const sparse = await growAndPreview(project, store, sel, result.bounds);

    const durationMs = Date.now() - startedAt;
    const timings = timer.finish();
    adapter.appendAudit({
      projectId: project.id, actor, operation,
      params: { selection: sel, params: params || {} },
      blocksChanged: result.blocksChanged || 0, durationMs,
      // Le relevé va AU JOURNAL, pas seulement à l'écran : une opération lente
      // s'analyse souvent après coup, quand la barre de progression a disparu.
      timings,
    });

    // `clipboard` n'est présent que pour `cut` (presse-papier rempli au passage).
    return {
      blocksChanged: result.blocksChanged || 0, bounds: result.bounds || sel,
      clipboard: result.clipboard, durationMs, previewTruncated: !!sparse.truncated,
      timings,
    };
  }

  /**
   * Écrit une grille plate de blocs dans la sélection — un par cellule du plan.
   * Sert la carte EN BLOCS (chaque bloc rend une couleur de carte) et, avec un
   * masque, le panneau texte/image. `names` est indexé v*w+u (null = inchangé).
   */
  async function applyMapBlocks({ project, selection, names, actor, onProgress }) {
    const startedAt = Date.now();
    const sel = checkSelection(selection, editLimits(project));
    const { flat, uAxis, vAxis, invertV, w, h } = panelPlane(sel);
    if (!names || names.length < w * h) throw new Error('bad_panel');

    onProgress?.('load', 5);
    const store = loadStore(project);
    await store.warmup(buildExtent(project));
    onProgress?.('apply', 30); await tick();
    const cache = new Map();
    let changed = 0;
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const name = names[v * w + u];
        if (!name) continue;
        let block = cache.get(name);
        if (!block) { block = { Name: name, Properties: null }; cache.set(name, block); }
        const pos = { x: 0, y: 0, z: 0 };
        pos[uAxis] = sel.min[uAxis] + u;
        pos[vAxis] = invertV ? sel.max[vAxis] - v : sel.min[vAxis] + v;
        for (let t = sel.min[flat]; t <= sel.max[flat]; t++) {
          pos[flat] = t;
          if (!sameBlock(store.getBlock(pos.x, pos.y, pos.z), block)) {
            store.setBlock(pos.x, pos.y, pos.z, { Name: block.Name, Properties: null });
            changed++;
          }
        }
      }
      if ((v & 15) === 0) await tick();
    }
    onProgress?.('commit', 60); await tick();
    snapshotRegions(project.id, regionKeysForBBox(sel));
    clearRedo(project.id);
    writeRegions(project.id, store.commit({ touchedOnly: true }));
    onProgress?.('preview', 85); await tick();
    const sparse = await growAndPreview(project, store, sel, sel);

    const durationMs = Date.now() - startedAt;
    adapter.appendAudit({
      projectId: project.id, actor, operation: 'mapblocks',
      params: { selection: sel }, blocksChanged: changed, durationMs,
    });
    return { blocksChanged: changed, bounds: sel, durationMs, previewTruncated: !!sparse.truncated, plane: { w, h } };
  }

  /**
   * Écrit un panneau plat : `mask` (1 = bloc d'écriture, 0 = fond) indexé v*w+u.
   * `random` est injectable pour rendre le fond marbré reproductible.
   */
  async function applyPanel({ project, selection, mask, inkBlock, preset = 'white_marble', actor, onProgress, random }) {
    const startedAt = Date.now();
    const sel = checkSelection(selection, editLimits(project));
    const pal = PANEL_PRESETS[preset] || PANEL_PRESETS.white_marble;
    const ink = inkBlock?.name ? { Name: inkBlock.name, Properties: inkBlock.states || null } : { Name: pal.ink, Properties: null };
    const { flat, uAxis, vAxis, invertV, w, h } = panelPlane(sel);
    if (!mask || mask.length < w * h) throw new Error('bad_panel');

    onProgress?.('load', 5);
    const store = loadStore(project);
    await store.warmup(buildExtent(project));
    onProgress?.('apply', 30); await tick();
    const pick = weightedPicker(pal.bg, random);
    let changed = 0;
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const block = mask[v * w + u] === 1 ? ink : pick();
        const pos = { x: 0, y: 0, z: 0 };
        pos[uAxis] = sel.min[uAxis] + u;
        pos[vAxis] = invertV ? sel.max[vAxis] - v : sel.min[vAxis] + v;
        for (let t = sel.min[flat]; t <= sel.max[flat]; t++) {
          pos[flat] = t;
          if (!sameBlock(store.getBlock(pos.x, pos.y, pos.z), block)) {
            store.setBlock(pos.x, pos.y, pos.z, { Name: block.Name, Properties: block.Properties });
            changed++;
          }
        }
      }
      if ((v & 15) === 0) await tick();
    }
    onProgress?.('commit', 60); await tick();
    snapshotRegions(project.id, regionKeysForBBox(sel));
    clearRedo(project.id);
    writeRegions(project.id, store.commit({ touchedOnly: true }));
    onProgress?.('preview', 85); await tick();
    const sparse = await growAndPreview(project, store, sel, sel);

    const durationMs = Date.now() - startedAt;
    adapter.appendAudit({
      projectId: project.id, actor, operation: 'panel',
      params: { selection: sel, preset }, blocksChanged: changed, durationMs,
    });
    return { blocksChanged: changed, bounds: sel, durationMs, previewTruncated: !!sparse.truncated, plane: { w, h } };
  }

  /**
   * Génère du relief : `heights` (valeurs 0..1, indexées z*sizeX + x) donne la
   * hauteur de chaque colonne XZ dans la sélection, la hauteur max étant la
   * plage Y de la sélection. `solid` remplit la colonne (sous-couche `under` +
   * revêtement au sommet), `surface` ne pose que le sommet.
   */
  async function applyHeightmap({ project, actor, selection, heights, params, onProgress }) {
    const startedAt = Date.now();
    const extent = buildExtent(project);
    const sel = checkSelection(selection, editLimits(project));
    const surfaceName = params?.block?.name;
    if (!surfaceName) throw new Error('bad_block');
    const surface = { Name: surfaceName, Properties: params.block.states || null };
    const under = params?.under?.name ? { Name: params.under.name, Properties: params.under.states || null } : null;
    const mode = params?.mode === 'surface' ? 'surface' : 'solid';

    const sizeX = sel.max.x - sel.min.x + 1;
    const sizeZ = sel.max.z - sel.min.z + 1;
    const maxH = sel.max.y - sel.min.y;
    if (!heights || heights.length < sizeX * sizeZ) throw new Error('bad_heightmap');

    onProgress?.('load', 5);
    const store = loadStore(project);
    await store.warmup(extent);
    onProgress?.('apply', 30); await tick();

    let changed = 0;
    for (let z = 0; z < sizeZ; z++) {
      for (let x = 0; x < sizeX; x++) {
        const h = Math.round(clamp01(heights[z * sizeX + x]) * maxH);
        const wx = sel.min.x + x, wz = sel.min.z + z;
        const topY = sel.min.y + h;
        if (mode === 'surface') {
          if (!sameBlock(store.getBlock(wx, topY, wz), surface)) {
            store.setBlock(wx, topY, wz, { Name: surface.Name, Properties: surface.Properties });
            changed++;
          }
        } else {
          for (let y = sel.min.y; y <= topY; y++) {
            const b = (y === topY || !under) ? surface : under;
            if (!sameBlock(store.getBlock(wx, y, wz), b)) {
              store.setBlock(wx, y, wz, { Name: b.Name, Properties: b.Properties });
              changed++;
            }
          }
        }
      }
      if ((z & 31) === 0) await tick(); // respire périodiquement
    }
    onProgress?.('commit', 60); await tick();
    snapshotRegions(project.id, regionKeysForBBox(sel));
    clearRedo(project.id);
    writeRegions(project.id, store.commit({ touchedOnly: true }));
    onProgress?.('preview', 85); await tick();
    const sparse = await growAndPreview(project, store, sel, sel);

    const durationMs = Date.now() - startedAt;
    adapter.appendAudit({
      projectId: project.id, actor, operation: 'heightmap',
      params: { selection: sel, mode }, blocksChanged: changed, durationMs,
    });
    return { blocksChanged: changed, bounds: sel, durationMs, previewTruncated: !!sparse.truncated };
  }

  /**
   * L'inverse : pour chaque colonne XZ, la hauteur du bloc non-air le plus haut
   * → niveau de gris (blanc = haut, noir = colonne vide). Buffer brut 1 canal.
   */
  async function exportHeightmap(project, selection) {
    const sel = checkSelection(selection, editLimits(project));
    const store = loadStore(project);
    await store.warmup(buildExtent(project));
    const sizeX = sel.max.x - sel.min.x + 1;
    const sizeZ = sel.max.z - sel.min.z + 1;
    const range = Math.max(1, sel.max.y - sel.min.y);
    const data = new Uint8Array(sizeX * sizeZ); // 0 = colonne vide (noir)
    for (let z = 0; z < sizeZ; z++) {
      for (let x = 0; x < sizeX; x++) {
        const wx = sel.min.x + x, wz = sel.min.z + z;
        let topY = null;
        for (let y = sel.max.y; y >= sel.min.y; y--) {
          if (store.getBlock(wx, y, wz)) { topY = y; break; }
        }
        data[z * sizeX + x] = topY === null ? 0 : Math.round(((topY - sel.min.y) / range) * 255);
      }
      if ((z & 31) === 0) await tick();
    }
    return { sizeX, sizeZ, data };
  }

  // ── Undo / redo / reset ───────────────────────────────────────────────────

  async function undoLast({ project, actor }) {
    const seqs = undoSeqs(project.id);
    if (!seqs.length) throw new Error('nothing_to_undo');
    applySnapshot(path.join(undoDir(project.id), String(seqs[seqs.length - 1])), project.id, redoDir(project.id));
    await regenPreview(project);
    adapter.appendAudit({ projectId: project.id, actor, operation: 'undo', params: {}, blocksChanged: 0 });
    return { undone: true, remaining: undoSeqs(project.id).length, redoDepth: redoSeqs(project.id).length };
  }

  async function redoLast({ project, actor }) {
    const seqs = redoSeqs(project.id);
    if (!seqs.length) throw new Error('nothing_to_redo');
    applySnapshot(path.join(redoDir(project.id), String(seqs[seqs.length - 1])), project.id, undoDir(project.id));
    await regenPreview(project);
    adapter.appendAudit({ projectId: project.id, actor, operation: 'redo', params: {}, blocksChanged: 0 });
    return { redone: true, undoDepth: undoSeqs(project.id).length, redoDepth: redoSeqs(project.id).length };
  }

  /** Jette toutes les modifications : la prochaine op repart de la source. */
  function resetStaging(id) {
    fs.rmSync(dirFor(id), { recursive: true, force: true });
    if (previewCache?.id === id) previewCache = null;
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /**
   * Sans offset → recopie LOSSLESS des régions de staging (coffres, biomes,
   * entités préservés). Avec offset → on RE-CHUNK les blocs à la nouvelle
   * position monde, ce qui perd block-entities et biomes.
   *
   * ⚠️ Cette perte est une limite CONNUE, corrigée en phase 1.3. Tant qu'elle
   * tient, l'écran d'export doit le dire.
   */
  async function exportBuild(project, offset = null) {
    const off = offset && (offset.dx || offset.dy || offset.dz) ? offset : null;
    if (!off) {
      materialize(project);
      const rdir = regionsDir(project.id);
      const files = listRegionFiles(project.id);
      if (files.length === 0) throw new Error('no_region');
      const regions = files.map((f) => ({
        regionX: f.regionX, regionZ: f.regionZ,
        buffer: fs.readFileSync(path.join(rdir, f.file)),
      }));
      return regionsToDownload(regions, project.name);
    }
    const extent = buildExtent(project);
    const store = loadStore(project);
    await store.warmup(extent);
    const sparse = store.deriveSparse(extent, limits.cropMaxBlocks);
    const dx = Math.round(off.dx) || 0, dy = Math.round(off.dy) || 0, dz = Math.round(off.dz) || 0;
    const shifted = {
      min: { x: extent.min.x + dx, y: Math.max(limits.worldMinY, extent.min.y + dy), z: extent.min.z + dz },
      max: { x: extent.max.x + dx, y: Math.min(limits.worldMaxY, extent.max.y + dy), z: extent.max.z + dz },
    };
    const regions = blankRegions({
      template: await templateChunk(project),
      origin: shifted.min,
      size: { x: shifted.max.x - shifted.min.x + 1, y: 1, z: shifted.max.z - shifted.min.z + 1 },
    });
    const store2 = new RegionStore(regions);
    await store2.warmup(shifted);
    for (let i = 0; i < sparse.blocks.length; i += 4) {
      const e = sparse.palette[sparse.blocks[i + 3]];
      const x = sparse.min.x + sparse.blocks[i] + dx;
      const y = sparse.min.y + sparse.blocks[i + 1] + dy;
      const z = sparse.min.z + sparse.blocks[i + 2] + dz;
      if (y < limits.worldMinY || y > limits.worldMaxY) continue;
      store2.setBlock(x, y, z, { Name: e.name, Properties: e.props || null });
    }

    // Les blocs seuls ne font pas un build : un coffre recopié sans son entrée
    // `block_entities` arrive vide, un panneau arrive muet. Elles se déplacent
    // avec les blocs — l'entrée est recopiée telle quelle, seules ses
    // coordonnées changent, pour ne rien perdre d'une version de Minecraft
    // qu'on ne connaît pas.
    const movedEntities = store.copyBlockEntitiesTo(store2, extent, dx, dy, dz);

    // Les biomes non plus ne sont pas dans la grille de blocs.
    let movedBiomes = 0;
    for (let y = extent.min.y; y <= extent.max.y; y += 4) {
      for (let z = extent.min.z; z <= extent.max.z; z += 4) {
        for (let x = extent.min.x; x <= extent.max.x; x += 4) {
          const b = store.getBiome(x, y, z);
          if (!b) continue;
          const ty = y + dy;
          if (ty < limits.worldMinY || ty > limits.worldMaxY) continue;
          if (store2.setBiome(x + dx, ty, z + dz, b)) movedBiomes++;
        }
      }
    }

    const out = [...store2.commit({ touchedOnly: false })].map(([key, buffer]) => {
      const [rx, rz] = key.split(',').map(Number);
      return { regionX: rx, regionZ: rz, buffer };
    });
    // `carried` est annoncé à l'utilisateur : « 12 coffres et panneaux
    // déplacés » vaut mieux qu'un export silencieux dont on découvre plus tard
    // ce qu'il a gardé.
    return { ...regionsToDownload(out, project.name), carried: { blockEntities: movedEntities, biomes: movedBiomes } };
  }

  /**
   * Extrait une zone : l'artefact sparse de la sélection + des fichiers de
   * région RÉDUITS aux seuls chunks qu'elle intersecte (lossless, payloads
   * recopiés, coordonnées monde conservées). Sert à créer un projet léger,
   * bien plus rapide à charger que le .mca complet.
   */
  async function cropBuild(project, bbox) {
    const store = loadStore(project);
    await store.warmup(bbox);
    const sparse = store.deriveSparse(bbox, limits.cropMaxBlocks); // lève too_many_blocks au-delà
    if (!sparse.count) throw new Error('empty_box');
    const cMinX = fdiv(bbox.min.x, 16), cMaxX = fdiv(bbox.max.x, 16);
    const cMinZ = fdiv(bbox.min.z, 16), cMaxZ = fdiv(bbox.max.z, 16);
    const regions = [];
    for (const r of store.regions.values()) {
      const chunks = r.region.chunks.filter(
        (c) => c.chunkX >= cMinX && c.chunkX <= cMaxX && c.chunkZ >= cMinZ && c.chunkZ <= cMaxZ,
      );
      if (!chunks.length) continue;
      regions.push({ regionX: r.regionX, regionZ: r.regionZ, buffer: writeRegion({ regionX: r.regionX, regionZ: r.regionZ, chunks }) });
    }
    return { sparse, regions };
  }

  /**
   * Emprunte un chunk MODÈLE au projet : sa structure NBT est valide pour la
   * version Minecraft de l'utilisateur, ce qu'un chunk synthétisé ne peut que
   * deviner. Renvoie le NBT tagué, ou null si le projet n'a pas de source.
   */
  async function templateChunk(project) {
    if (!project?.source?.file) return null;
    materialize(project);
    const rdir = regionsDir(project.id);
    for (const f of listRegionFiles(project.id)) {
      const region = readRegion(fs.readFileSync(path.join(rdir, f.file)), f.regionX, f.regionZ);
      if (region.chunks.length) { await decodeChunk(region.chunks[0]); return region.chunks[0].root; }
    }
    return null;
  }

  /**
   * Baguette magique : remplissage 6-connexe depuis `seed` sur tous les blocs
   * de même type, borné à l'emprise et plafonné. Renvoie la boîte englobante.
   */
  async function floodSelect(project, seed) {
    const extent = buildExtent(project);
    const inB = (x, y, z) => x >= extent.min.x && x <= extent.max.x && y >= extent.min.y && y <= extent.max.y && z >= extent.min.z && z <= extent.max.z;
    const sx = Math.round(Number(seed?.x)), sy = Math.round(Number(seed?.y)), sz = Math.round(Number(seed?.z));
    if (![sx, sy, sz].every(Number.isFinite) || !inB(sx, sy, sz)) throw new Error('out_of_bounds');
    const store = loadStore(project);
    await store.warmup(extent);
    const target = store.getBlock(sx, sy, sz);
    if (!target) throw new Error('empty_seed'); // pas d'air
    const name = target.Name;
    const seen = new Set([`${sx},${sy},${sz}`]);
    const q = [[sx, sy, sz]];
    let min = { x: sx, y: sy, z: sz }, max = { x: sx, y: sy, z: sz };
    let count = 0;
    while (q.length) {
      if (count >= limits.wandMax) break;
      const [x, y, z] = q.pop();
      const b = store.getBlock(x, y, z);
      if (!b || b.Name !== name) continue;
      count++;
      min = { x: Math.min(min.x, x), y: Math.min(min.y, y), z: Math.min(min.z, z) };
      max = { x: Math.max(max.x, x), y: Math.max(max.y, y), z: Math.max(max.z, z) };
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = x + dx, ny = y + dy, nz = z + dz, k = `${nx},${ny},${nz}`;
        if (!inB(nx, ny, nz) || seen.has(k)) continue;
        seen.add(k); q.push([nx, ny, nz]);
      }
    }
    return { min, max, count, block: name };
  }

  return {
    limits,
    setLimits,
    adapter,
    // état
    hasPendingEdits,
    previewFilePath,
    readPreview,
    undoDepth: (id) => undoSeqs(id).length,
    redoDepth: (id) => redoSeqs(id).length,
    listAudit: (id, limit = 100) => adapter.listAudit(id, limit),
    // matérialisation
    materialize,
    seedRegions,
    listRegionFiles,
    /** Dossier des régions de travail — pour les relire telles quelles. */
    stagingRegionsDir: regionsDir,
    loadStore,
    templateChunk,
    // opérations
    applyOperation,
    applyMapBlocks,
    applyPanel,
    applyHeightmap,
    exportHeightmap,
    floodSelect,
    // historique
    undoLast,
    redoLast,
    resetStaging,
    regenPreview,
    // sortie
    exportBuild,
    cropBuild,
  };
}
