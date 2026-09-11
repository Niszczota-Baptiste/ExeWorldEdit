import path from 'node:path';
import fs from 'node:fs';
import { FsAdapter, defaultRoot } from '@titi/we-engine/storage';
import {
  createStaging, createLibrary, buildExtent, buildLimits,
  schematicToRegions, volumeToSchematic, normalizeLimits, LIMIT_RANGES,
} from '@titi/we-engine/staging';
import { regionFileName } from '@titi/we-engine/anvil';
import {
  readSaveInfo, probeWorldLock, applyToWorld,
  worldOverview, regionsForBBox, regionBounds, selectRegions, readRegions, REGION_SPAN,
} from '@titi/we-engine/world';
import { schematicToSponge, schematicToLitematic } from '@titi/we-engine/worldedit';

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
// Les plafonds viennent des réglages — bornés, parce qu'ils sortent d'un
// fichier que l'utilisateur peut éditer à la main.
const staging = createStaging(adapter, normalizeLimits(adapter.readSettings().limits));
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
    const isZip = /\.zip$/i.test(base);

    // Où vit cette région ? Le nom le dit d'habitude, mais pas toujours :
    // Windows renomme un téléchargement en double `r.0.0 (16).mca`. On lit
    // alors les coordonnées DANS le fichier, et on range le source sous son nom
    // canonique — ainsi tout le reste du moteur n'a affaire qu'à des `r.X.Z.mca`.
    const rc = isZip ? null : await staging.resolveRegionCoords(base, buffer);
    if (!isZip && !rc) throw new Error('region_coords_unknown');

    adapter.saveProject({ id, name: name || base, min: { x: 0, y: -64, z: 0 }, size: { x: 1, y: 1, z: 1 } });
    adapter.attachSource(id, {
      name: rc ? regionFileName(rc.regionX, rc.regionZ) : base,
      buffer,
    });

    // L'emprise posée ci-dessus est un remplissage : la vraie n'est connue
    // qu'après avoir lu le contenu. `rescanExtent` balaie les régions
    // matérialisées — pour un .zip, celles qu'il en dépaquette — et resserre.
    await methods.rescanExtent({ id });
    return projectState(project(id));
  },

  /** Resserre l'emprise sur les blocs réellement présents. */
  async rescanExtent({ id }) {
    await staging.rescanExtent(project(id));
    return projectState(project(id));
  },

  /**
   * Ouvre un `.schem` ou un `.litematic`. Un schematic n'a ni chunks ni
   * coordonnées : on lui fabrique des régions vierges et on l'y tamponne, pour
   * qu'il devienne un build ordinaire au lieu d'un cas particulier que tout le
   * moteur devrait connaître.
   */
  async openSchematic({ filePath, name }) {
    const base = path.basename(filePath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin issu du dialogue « Ouvrir »
    const buffer = fs.readFileSync(filePath);
    const out = await schematicToRegions(buffer, base);

    const id = `p${Date.now().toString(36)}`;
    adapter.saveProject({
      id, name: name || base.replace(/\.(schem|litematic|schematic)$/i, ''),
      min: out.origin, size: out.size,
    });
    staging.seedRegions(id, out.regions);
    await staging.regenPreview(project(id));
    return projectState(project(id));
  },

  /**
   * Regarde ce que contient une save SANS rien ouvrir : la liste des régions
   * présentes, leur taille, l'emprise totale. Instantané même sur un monde de
   * plusieurs gigaoctets, parce qu'on ne lit que des noms de fichiers.
   *
   * C'est le premier temps de l'ouverture d'un monde : on montre la carte,
   * l'utilisateur choisit sa zone, et on ne charge que ça.
   */
  inspectWorldFolder({ dirPath }) {
    const info = readSaveInfo(dirPath);
    if (info.kind === 'unknown') throw new Error('not_a_world');
    if (!info.regionDir) throw new Error('no_region_dir');
    const map = worldOverview(info);
    if (!map.count) throw new Error('no_region');
    return {
      path: info.root,
      name: info.name,
      kind: info.kind,
      hasEntities: !!info.entitiesDir,
      lock: probeWorldLock(info),
      regionSpan: REGION_SPAN,
      ...map,
      // Emprise en coordonnées MONDE, pas en indices de région : c'est ce que
      // l'utilisateur lit sur son F3.
      worldBounds: map.bounds && {
        minX: map.bounds.minX * REGION_SPAN,
        minZ: map.bounds.minZ * REGION_SPAN,
        maxX: map.bounds.maxX * REGION_SPAN + REGION_SPAN - 1,
        maxZ: map.bounds.maxZ * REGION_SPAN + REGION_SPAN - 1,
      },
    };
  },

  /**
   * Ouvre une save en ne chargeant QUE les régions demandées.
   *
   * Un monde joué quelques mois compte des centaines de régions, soit des
   * dizaines de gigaoctets. Tout matérialiser n'est pas lent, c'est impossible.
   * `area` (une boîte en coordonnées monde) ou `regions` (des indices explicites)
   * décide de ce qui entre dans le staging ; sans l'un ni l'autre, on refuse
   * plutôt que de tout prendre.
   */
  async openWorld({ dirPath, area, regions, name }) {
    const info = readSaveInfo(dirPath);
    if (info.kind === 'unknown') throw new Error('not_a_world');
    if (!info.regionDir) throw new Error('no_region_dir');

    const wanted = regions?.length ? regions : (area ? regionsForBBox(area) : null);
    if (!wanted) throw new Error('no_area');

    const present = selectRegions(info, wanted);
    if (!present.length) throw new Error('empty_area');

    const id = `p${Date.now().toString(36)}`;
    adapter.saveProject({
      id, name: name || info.name,
      // Emprise de REMPLISSAGE : on ne sait pas encore ce que ces régions
      // contiennent. `rescanExtent` la remplace en balayant les régions qu'on
      // vient de poser — c'est pour ça qu'il ne doit PAS partir de celle-ci.
      min: { x: 0, y: -64, z: 0 }, size: { x: 1, y: 1, z: 1 },
      world: { path: info.root, kind: info.kind },
    });
    staging.seedRegions(id, readRegions(info, present));
    await methods.rescanExtent({ id });

    return {
      ...projectState(project(id)),
      lock: probeWorldLock(info),
      loaded: present.length,
      // Ce qui a été demandé mais n'existe pas : du terrain jamais généré.
      // Le dire évite de croire qu'on a chargé une zone qu'on n'a pas.
      missing: wanted.length - present.length,
    };
  },

  /**
   * Étend un projet déjà ouvert avec des régions voisines. Les régions déjà
   * chargées ne sont PAS rechargées : le travail en cours dessus resterait
   * sinon écrasé par le contenu du disque.
   */
  async loadMoreRegions({ id, area }) {
    const p = project(id);
    if (!p.world?.path) throw new Error('no_world');
    const info = readSaveInfo(p.world.path);

    const already = new Set(staging.listRegionFiles(id).map((f) => `${f.regionX},${f.regionZ}`));
    const wanted = regionsForBBox(area).filter((r) => !already.has(`${r.regionX},${r.regionZ}`));
    const present = selectRegions(info, wanted);
    if (!present.length) return { ...projectState(p), loaded: 0, missing: wanted.length };

    staging.seedRegions(id, readRegions(info, present));
    await methods.rescanExtent({ id });
    return { ...projectState(project(id)), loaded: present.length, missing: wanted.length - present.length };
  },

  /** Ce que l'écran « Appliquer au monde » doit savoir avant de proposer quoi que ce soit. */
  inspectWorld({ id }) {
    const p = project(id);
    if (!p.world?.path) return { attached: false };
    const info = readSaveInfo(p.world.path);
    return {
      attached: true,
      path: info.root,
      name: info.name,
      hasEntities: !!info.entitiesDir,
      lock: probeWorldLock(info),
      regions: staging.listRegionFiles(id).length,
      loadedRegions: staging.listRegionFiles(id).map((f) => ({
        regionX: f.regionX, regionZ: f.regionZ, ...regionBounds(f.regionX, f.regionZ),
      })),
    };
  },

  /**
   * Réécrit les régions du staging dans la save d'origine. Le moteur refuse si
   * Minecraft tient le monde, et sauvegarde en zip horodaté AVANT d'écrire —
   * dans cet ordre, sans quoi la sauvegarde n'aurait plus rien à sauvegarder.
   */
  applyToWorld({ id, force = false }) {
    const p = project(id);
    if (!p.world?.path) throw new Error('no_world');
    const info = readSaveInfo(p.world.path);
    const dir = staging.stagingRegionsDir(id);
    const regions = staging.listRegionFiles(id).map((f) => ({
      regionX: f.regionX, regionZ: f.regionZ,
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- dossier du moteur, nom validé
      buffer: fs.readFileSync(path.join(dir, f.file)),
    }));
    const res = applyToWorld({
      info, regions, force,
      backupDir: path.join(root, 'sauvegardes'),
    });
    adapter.appendAudit({
      projectId: id, actor: 'local', operation: 'apply-to-world',
      params: { world: info.root, regions: res.written, backup: res.backup?.file || null },
      blocksChanged: 0,
    });
    return res;
  },

  /** Sort la sélection en `.schem` ou `.litematic`, prête à écrire. */
  async exportSchematic({ id, selection, format = 'schem', name }) {
    const p = project(id);
    const store = staging.loadStore(p);
    await store.warmup(buildExtent(p));
    const sel = selection || buildExtent(p);
    const schem = volumeToSchematic(store, sel);
    const label = name || p.name;
    const buffer = format === 'litematic'
      ? await schematicToLitematic(schem, { name: label })
      : await schematicToSponge(schem, { name: label });
    return {
      buffer,
      filename: `${label.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'build'}.${format}`,
      mime: 'application/octet-stream',
      // WorldEdit ne colle les entités qu'avec `//paste -e` : l'écran d'export
      // doit le rappeler, sinon elles manqueront sans que rien ne le dise.
      note: 'entities',
    };
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

  // ── Réglages ──────────────────────────────────────────────────────────────
  //
  // Ils vivent avec les données du moteur et non dans le `localStorage` du
  // renderer : celui-ci est effacé par un vidage de cache, et un réglage perdu
  // à chaque mise à jour n'est pas un réglage.

  // Les BORNES voyagent avec les réglages : l'interface génère ses champs
  // depuis elles, comme l'inspecteur génère les siens depuis les descripteurs
  // d'opérations. Les redéclarer côté renderer les ferait diverger, et
  // importerait le moteur entier dans le bundle.
  getSettings: () => ({
    ...adapter.readSettings(),
    limits: { ...staging.limits },
    limitRanges: LIMIT_RANGES,
  }),

  /** Fusion, pas remplacement : l'interface n'envoie que ce qu'elle change. */
  saveSettings: ({ patch }) => {
    const next = adapter.writeSettings(patch || {});
    // Les plafonds prennent effet TOUT DE SUITE : les relire au prochain
    // démarrage ferait croire que le réglage n'a pas marché.
    if (patch && patch.limits) next.limits = staging.setLimits(patch.limits);
    return { ...next, limits: { ...staging.limits } };
  },

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
