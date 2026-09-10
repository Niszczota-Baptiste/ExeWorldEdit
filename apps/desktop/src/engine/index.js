import path from 'node:path';
import fs from 'node:fs';
import { FsAdapter, defaultRoot } from '@titi/we-engine/storage';
import { createStaging, createLibrary, buildExtent, buildLimits } from '@titi/we-engine/staging';
import { regionCoordsFromName } from '@titi/we-engine/anvil';

// LE MOTEUR — tourne dans un `utilityProcess`, jamais dans le renderer.
//
// C'est la source de vérité : lui seul lit et écrit les fichiers de région.
// Le renderer n'en reçoit que des instantanés et lui envoie des intentions.
// Une opération longue bloque ce processus-ci, pas l'interface.
//
// Le dialogue est un RPC minimal : { id, method, params } → { id, ok, result }
// ou { id, ok: false, error }. Rien d'autre ne traverse la frontière.

const root = process.env.TITI_DATA_ROOT || defaultRoot();
const adapter = new FsAdapter({ root });
const staging = createStaging(adapter);
const library = createLibrary(adapter);

/** Presse-papier par session, en mémoire — il ne survit pas à la fermeture. */
let clipboard = null;

const project = (id) => {
  const p = adapter.getProject(id);
  if (!p) throw new Error('not_found');
  return p;
};

/** Ce que l'interface a besoin de savoir d'un projet, et rien de plus. */
const projectState = (p) => ({
  ...p,
  extent: buildExtent(p),
  limits: buildLimits(p, staging.limits),
  undoDepth: staging.undoDepth(p.id),
  redoDepth: staging.redoDepth(p.id),
  pending: staging.hasPendingEdits(p.id),
});

const methods = {
  // ── Projets ───────────────────────────────────────────────────────────────

  listProjects: () => adapter.listProjects().map(projectState),

  getProject: ({ id }) => projectState(project(id)),

  /**
   * Ouvre un .mca ou un .zip de dossier region/. On COPIE le fichier dans
   * l'espace du projet et on ne retouche plus jamais l'original : c'est le
   * premier maillon du contrat non destructif.
   */
  async openFile({ filePath, name }) {
    const base = path.basename(filePath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin issu du dialogue « Ouvrir » du système, choisi par l'utilisateur
    const buffer = fs.readFileSync(filePath);
    const id = `p${Date.now().toString(36)}`;

    adapter.saveProject({ id, name: name || base, min: { x: 0, y: -64, z: 0 }, size: { x: 1, y: 1, z: 1 } });
    adapter.attachSource(id, { name: base, buffer });

    // L'emprise réelle n'est connue qu'après lecture : on part de la région
    // annoncée par le nom du fichier, puis on la resserre sur le contenu.
    const rc = /\.zip$/i.test(base) ? null : regionCoordsFromName(base);
    if (rc) {
      adapter.saveExtent(id, {
        min: { x: rc.regionX * 512, y: -64, z: rc.regionZ * 512 },
        max: { x: rc.regionX * 512 + 511, y: 319, z: rc.regionZ * 512 + 511 },
      });
    }
    await methods.rescanExtent({ id });
    return projectState(project(id));
  },

  /** Resserre l'emprise sur les blocs réellement présents. */
  async rescanExtent({ id }) {
    const p = project(id);
    const store = staging.loadStore(p);
    await store.warmup(buildLimits(p, staging.limits));
    const sparse = store.deriveSparse(buildLimits(p, staging.limits), staging.limits.previewMaxBlocks, { truncate: true });
    if (!sparse.count) return projectState(p);
    adapter.saveExtent(id, {
      min: sparse.min,
      max: {
        x: sparse.min.x + sparse.size.x - 1,
        y: sparse.min.y + sparse.size.y - 1,
        z: sparse.min.z + sparse.size.z - 1,
      },
    });
    await staging.regenPreview(project(id));
    return projectState(project(id));
  },

  closeProject: ({ id }) => { adapter.removeProject(id); return true; },

  // ── Géométrie pour le viewport ────────────────────────────────────────────

  /**
   * L'artefact creux du build : palette + triplets de coordonnées. C'est tout
   * ce que le renderer reçoit — jamais un fichier de région.
   */
  async getGeometry({ id }) {
    const p = project(id);
    const existing = staging.readPreview(id);
    if (existing) return existing;
    await staging.regenPreview(p);
    return staging.readPreview(id);
  },

  // ── Édition ───────────────────────────────────────────────────────────────

  async apply({ id, operation, params, selection }) {
    const res = await staging.applyOperation({
      project: project(id), operation, params, selection,
      actor: 'local', clipboard,
      onProgress: (phase, pct) => send({ event: 'progress', operation, phase, pct }),
    });
    if (res.clipboard) clipboard = res.clipboard;
    return { ...res, project: projectState(project(id)) };
  },

  async undo({ id }) {
    const res = await staging.undoLast({ project: project(id), actor: 'local' });
    return { ...res, project: projectState(project(id)) };
  },

  async redo({ id }) {
    const res = await staging.redoLast({ project: project(id), actor: 'local' });
    return { ...res, project: projectState(project(id)) };
  },

  reset({ id }) {
    staging.resetStaging(id);
    return projectState(project(id));
  },

  audit: ({ id, limit }) => staging.listAudit(id, limit),

  // ── Sortie ────────────────────────────────────────────────────────────────

  /**
   * Rend le fichier prêt à écrire. Le moteur ne choisit PAS où : c'est le
   * processus principal qui ouvre le dialogue et écrit, parce que lui seul a
   * le droit de parler à l'utilisateur.
   */
  async exportBuild({ id, offset }) {
    const out = await staging.exportBuild(project(id), offset || null);
    return { filename: out.filename, mime: out.mime, buffer: out.buffer };
  },

  // ── Bibliothèque ──────────────────────────────────────────────────────────

  listSchematics: () => library.list(),
  saveSchematic: ({ name }) => {
    if (!clipboard) throw new Error('empty_clipboard');
    return library.save({ name, schem: clipboard });
  },
  loadSchematic: ({ schematicId }) => {
    clipboard = library.load(schematicId);
    return { sx: clipboard.sx, sy: clipboard.sy, sz: clipboard.sz };
  },
  removeSchematic: ({ schematicId }) => library.remove(schematicId),

  hasClipboard: () => !!clipboard,

  // ── Diagnostic ────────────────────────────────────────────────────────────

  info: () => ({
    dataRoot: root,
    limits: staging.limits,
    memory: process.memoryUsage(),
    node: process.versions.node,
  }),
};

function send(message) {
  process.parentPort?.postMessage(message);
}

process.parentPort?.on('message', async (e) => {
  const { id, method, params } = e.data || {};
  const fn = methods[method];
  if (!fn) {
    send({ id, ok: false, error: `méthode inconnue : ${method}` });
    return;
  }
  try {
    send({ id, ok: true, result: await fn(params || {}) });
  } catch (err) {
    send({ id, ok: false, error: err?.message || String(err) });
  }
});

send({ event: 'ready', dataRoot: root });
