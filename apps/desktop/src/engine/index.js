import path from 'node:path';
import os from 'node:os';
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
import { CATALOG, GROUPS, normalizeExtras } from '@titi/we-engine/blocks';
import { renderTextSvg } from '@titi/we-engine/worldedit';
import { flatBlockColors } from '@titi/we-engine/colors';
import { safeFileNameExt } from '@titi/we-engine/filename';
import { planIcone, planModele, pickLatestVersion, orderPacks, pileComplete } from '@titi/we-engine/worldedit';
import { zipIndex, zipRead } from '@titi/we-engine/worldedit';
import { PANEL_PRESETS } from '@titi/we-engine/staging';

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

// Bornes du rendu de texte. Un panneau plus large que ça ne tiendrait pas dans
// une sélection raisonnable, et un suréchantillonnage démesuré ferait fabriquer
// un SVG de plusieurs mégaoctets pour le traverser aussitôt.
const clampSide = (v) => Math.max(1, Math.min(1024, Math.round(Number(v)) || 1));
const clampSS = (v) => Math.max(1, Math.min(8, Math.round(Number(v)) || 1));

/**
 * Pack de ressources ouvert, gardé d'un appel à l'autre.
 *
 * Un `.jar` de Minecraft pèse une vingtaine de mégaoctets pour plusieurs
 * milliers d'entrées : réindexer son catalogue à chaque icône rendrait la
 * palette inutilisable. L'index est fait une fois ; chaque entrée n'est
 * décompressée qu'à la demande.
 */
let packCache = null;

/**
 * Une PILE de packs lue comme un seul. Le premier qui a l'entrée gagne.
 *
 * C'est l'ordre de Minecraft : un pack de ressources recouvre le jeu. Sans ça,
 * un bloc `minefield:*` ne trouverait rien — le `.jar` de version ne le connaît
 * pas — et le vanilla resterait sans texture si on ne chargeait que le pack du
 * serveur.
 */
function ouvrePile(chemins) {
  const cle = chemins.join('\u0000');
  if (packCache?.cle === cle) return packCache.pack;
  const packs = [];
  for (const c of chemins) {
    try { packs.push(ouvreUn(c)); } catch { /* pack disparu ou illisible : on continue sans */ }
  }
  const pack = {
    count: packs.reduce((n, p) => n + (p.count || 0), 0) || null,
    sources: packs.length,
    read: (nom) => {
      for (const p of packs) {
        const buf = p.read(nom);
        if (buf) return buf;
      }
      return null;
    },
    ids: () => {
      const vus = new Set();
      for (const p of packs) for (const id of p.ids()) vus.add(id);
      return [...vus];
    },
  };
  packCache = { cle, pack };
  return pack;
}

/** Les chemins configurés, ou ceux détectés si rien n'est configuré. */
function cheminsPack() {
  const r = adapter.readSettings().resourcePacks;
  if (Array.isArray(r)) return r.filter((x) => typeof x === 'string' && x);
  // Rien de configuré : on prend ce qu'on trouve, sans rien demander. C'est la
  // différence entre « ça marche » et « ça marche après avoir lu la doc ».
  return orderPacks(detecteInstances().flatMap(candidatsDe)).map((c) => c.path);
}

// ── Détection de l'installation ───────────────────────────────────────────────
//
// Les textures du jeu ne sont pas livrées avec l'application : l'EULA de Mojang
// interdit de les redistribuer. On lit celles que l'utilisateur a déjà — ce que
// font tous les outils du genre — et le résultat est meilleur qu'un pack
// embarqué : le dossier d'un launcher contient AUSSI les packs du serveur, donc
// les blocs `minefield:*` arrivent avec leurs textures sans rien demander.

/** Racines où un launcher range ses affaires, selon la plateforme. */
function racinesLaunchers() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [process.env.APPDATA || path.join(home, 'AppData', 'Roaming')];
  }
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support')];
  return [home, path.join(home, '.local', 'share')];
}

const listeSure = (dir) => {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dossiers système connus, pas une saisie
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch { return []; }
};

/**
 * Instances de jeu trouvées sur la machine.
 *
 * Le critère est la présence d'un dossier `versions/`, pas le nom : la capture
 * d'un utilisateur montrait `%APPDATA%\.minefield_1_18`, le launcher du
 * serveur. Chercher « .minecraft » n'aurait rien trouvé chez lui — et c'est
 * justement l'installation qui contient à la fois le jeu et le pack du serveur.
 */
export function detecteInstances() {
  const out = [];
  for (const racine of racinesLaunchers()) {
    for (const e of listeSure(racine)) {
      if (!e.isDirectory()) continue;
      const dir = path.join(racine, e.name);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin joint sous une racine système
      if (!fs.existsSync(path.join(dir, 'versions'))) continue;
      out.push({ name: e.name, path: dir });
    }
  }
  return out;
}

/**
 * Candidats de pack d'une instance : son `.jar` de version le plus récent, et
 * les packs de ressources installés.
 */
export function candidatsDe(instance) {
  const out = [];
  const versions = listeSure(path.join(instance.path, 'versions'))
    .filter((e) => e.isDirectory()).map((e) => e.name);
  const v = pickLatestVersion(versions);
  if (v) {
    const jar = path.join(instance.path, 'versions', v, `${v}.jar`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin dérivé d'un dossier de versions
    if (fs.existsSync(jar)) out.push({ kind: 'jar', path: jar, name: `${instance.name} · ${v}`, version: v });
  }
  for (const e of listeSure(path.join(instance.path, 'resourcepacks'))) {
    const f = path.join(instance.path, 'resourcepacks', e.name);
    // Un pack est soit un zip, soit un dossier qui porte un `pack.mcmeta`.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin dérivé du dossier resourcepacks
    const ok = e.isFile() ? /\.zip$/i.test(e.name) : fs.existsSync(path.join(f, 'pack.mcmeta'));
    if (ok) out.push({ kind: 'pack', path: f, name: `${instance.name} · ${e.name}` });
  }
  return out;
}

/** `assets/<ns>/blockstates/<nom>.json` → `ns:nom`. */
const idDepuisBlockstate = (chemin) => {
  const m = chemin.match(/^assets\/([a-z0-9_.-]+)\/blockstates\/([a-z0-9_./-]+)\.json$/);
  return m ? `${m[1]}:${m[2]}` : null;
};

function ouvreUn(chemin) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin choisi par l'utilisateur dans un dialogue
  const stat = fs.statSync(chemin);
  let pack;
  if (stat.isDirectory()) {
    pack = {
      count: null,
      /** Les blocs DÉCLARÉS par le pack : un fichier de blockstate par bloc. */
      ids: () => {
        const out = [];
        const assets = path.join(chemin, 'assets');
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- racine choisie par l'utilisateur dans un dialogue
        if (!fs.existsSync(assets)) return out;
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- idem
        for (const ns of fs.readdirSync(assets)) {
          const dir = path.join(assets, ns, 'blockstates');
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- idem
          if (!fs.existsSync(dir)) continue;
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- idem
          for (const f of fs.readdirSync(dir)) {
            const id = idDepuisBlockstate(`assets/${ns}/blockstates/${f}`);
            if (id) out.push(id);
          }
        }
        return out;
      },
      read: (nom) => {
        // Un nom d'entrée vient de NOS résolveurs, pas d'une saisie ; on refuse
        // quand même tout ce qui remonte, plutôt que de faire confiance.
        if (nom.includes('..')) return null;
        const f = path.join(chemin, nom);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin joint sous la racine choisie
        return fs.existsSync(f) ? fs.readFileSync(f) : null;
      },
    };
  } else {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- idem
    const buf = fs.readFileSync(chemin);
    const index = zipIndex(buf);
    pack = {
      count: index.size,
      ids: () => [...index.keys()].map(idDepuisBlockstate).filter(Boolean),
      read: (nom) => zipRead(buf, index, nom),
    };
  }
  return pack;
}

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
      filename: safeFileNameExt(label, format),
      mime: 'application/octet-stream',
      // WorldEdit ne colle les entités qu'avec `//paste -e` : l'écran d'export
      // doit le rappeler, sinon elles manqueront sans que rien ne le dise.
      note: 'entities',
    };
  },

  /**
   * Renomme un projet. Ne touche QUE l'étiquette.
   *
   * C'est sans danger par construction : le dossier du projet est nommé par son
   * `id`, jamais par son nom (`FsAdapter.projectDir`). Renommer ne déplace donc
   * aucun fichier, ne casse aucun chemin de staging, ne perd ni l'historique
   * d'annulation ni la source d'origine. Le nom ne sert qu'à trois choses :
   * l'onglet, le nom de fichier proposé à l'export, et le champ `name` écrit
   * DANS un schematic exporté.
   *
   * Les lettres sont gardées telles quelles — accents, coréen, emoji. C'est à
   * l'export que le nom devient un nom de fichier, et `safeFileName` n'y retire
   * que ce qu'un système de fichiers refuse vraiment.
   */
  renameProject: ({ id, name }) => {
    const p = project(id);
    const propre = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!propre) throw new Error('bad_name');
    adapter.saveProject({ ...p, name: propre });
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

  // ── Panneau, carte et relief ───────────────────────────────────────────────
  //
  // Ces trois-là partagent une forme : l'interface prépare une GRILLE (masque,
  // noms de blocs, hauteurs) et le moteur l'écrit. Le découpage est volontaire —
  // rasteriser un SVG ou décoder un PNG est le métier d'un navigateur, et le
  // renderer en est un ; le moteur, lui, ne dépend d'aucun canvas.

  /**
   * Texte rendu en TRACÉS vectoriels, depuis la police embarquée. Le renderer
   * n'a plus qu'à le peindre dans un canvas et à seuiller.
   *
   * Pourquoi pas une police du système : elle n'est pas la même partout, et le
   * même panneau sortirait différent d'une machine à l'autre.
   */
  textSvg: ({ text, width, height, supersample = 3 }) => ({
    svg: String(renderTextSvg(String(text ?? ''), clampSide(width), clampSide(height), clampSS(supersample), '#000000', '#ffffff')),
    width: clampSide(width),
    height: clampSide(height),
  }),

  /** Préréglages de fond (marbre blanc, noir…) — l'interface génère sa liste. */
  panelPresets: () => Object.entries(PANEL_PRESETS).map(([id, p]) => ({ id, label: p.label, ink: p.ink })),

  /**
   * Palette de MAP ART : couleur de carte → bloc plat qui la rend. C'est la
   * table que le renderer utilise pour convertir une image en blocs, et elle
   * vient du moteur pour la même raison que les descripteurs d'opérations —
   * l'interface ne doit pas tenir sa propre copie.
   */
  mapPalette: () => flatBlockColors(),

  applyPanel: ({ id, selection, mask, inkBlock, preset, seed }) => staging.applyPanel({
    project: project(id), selection, mask, inkBlock, preset, seed, actor: 'local',
    onProgress: (phase, pct) => send({ event: 'progress', operation: 'panel', phase, pct }),
  }).then((res) => ({ ...res, project: projectState(project(id)) })),

  /**
   * Un trait de pinceau : des cases éparses, toutes du même bloc.
   *
   * Le renderer n'envoie PAS les anciennes valeurs. Le moteur est la source de
   * vérité : un renderer désynchronisé ferait réécrire à l'annulation des blocs
   * qui n'ont jamais existé.
   */
  applyStroke: ({ id, positions, block }) => staging.applyStroke({
    project: project(id), positions, block, actor: 'local',
    onProgress: (phase, pct) => send({ event: 'progress', operation: 'brush', phase, pct }),
  }).then((res) => ({ ...res, project: projectState(project(id)) })),

  applyMapBlocks: ({ id, selection, names }) => staging.applyMapBlocks({
    project: project(id), selection, names, actor: 'local',
    onProgress: (phase, pct) => send({ event: 'progress', operation: 'map', phase, pct }),
  }).then((res) => ({ ...res, project: projectState(project(id)) })),

  applyHeightmap: ({ id, selection, heights, params }) => staging.applyHeightmap({
    project: project(id), selection, heights, params, actor: 'local',
    onProgress: (phase, pct) => send({ event: 'progress', operation: 'heightmap', phase, pct }),
  }).then((res) => ({ ...res, project: projectState(project(id)) })),

  /** Relief de la sélection, en niveaux de gris (0 = colonne vide). */
  exportHeightmap: ({ id, selection }) => staging.exportHeightmap(project(id), selection),

  /**
   * Catalogue de blocs : vanilla + `minefield:*` déclarés dans `blocks.json`.
   *
   * Il passe par le MOTEUR et non par un import direct du renderer, parce que
   * les blocs déclarés dépendent d'où vivent les données — c'est justement ce
   * que le `StorageAdapter` sait et que le renderer ne doit pas savoir.
   */
  listBlocks: () => {
    const extras = normalizeExtras(adapter.readBlockExtras());
    const connus = new Set(CATALOG.map((b) => b.id));
    const blocks = [...CATALOG, ...extras.filter((b) => !connus.has(b.id))];
    for (const b of blocks) connus.add(b.id);

    // Le PACK est la liste de référence de ce qui existe : un fichier de
    // blockstate par bloc, `minefield:*` compris. C'est ce qui rend le
    // catalogue complet sans que ce dépôt ait à connaître les blocs du
    // serveur — désigner le pack du serveur suffit.
    const chemins = cheminsPack();
    if (chemins.length) {
      try {
        for (const id of ouvrePile(chemins).ids()) {
          if (connus.has(id)) continue;
          connus.add(id);
          blocks.push({ id, group: id.startsWith('minefield:') ? 'minefield' : 'autre', fromPack: true });
        }
      } catch { /* pack illisible : le catalogue se contente du reste */ }
    }
    return { groups: GROUPS, blocks };
  },

  // ── Icônes de blocs ───────────────────────────────────────────────────────
  //
  // Les textures du jeu ne sont pas dans ce dépôt et ne peuvent pas y être :
  // l'application lit le pack que l'utilisateur lui désigne — le `.jar` d'une
  // version de Minecraft, un pack zippé, ou un dossier déplié. Le pack du
  // serveur fournit de la même façon les blocs `minefield:*`.

  /** Ce que l'écran des réglages a besoin de savoir du pack configuré. */
  resourcePackInfo: () => {
    const configure = Array.isArray(adapter.readSettings().resourcePacks);
    const chemins = cheminsPack();
    const trouves = orderPacks(detecteInstances().flatMap(candidatsDe));
    if (!chemins.length) {
      return { paths: [], ok: false, reason: 'aucun', auto: !configure, candidates: trouves };
    }
    try {
      const pack = ouvrePile(chemins);
      // Une sonde plutôt qu'un simple test d'existence : un dossier qui n'est
      // pas un pack, ou un zip sans `assets/`, doit se dire tout de suite et
      // pas au premier bloc qui n'a pas d'icône.
      const sonde = pack.read('assets/minecraft/blockstates/stone.json');
      return {
        paths: chemins,
        ok: !!sonde,
        // Un pack de serveur seul ne connaît que ses blocs : le dire vaut mieux
        // que laisser croire à un bug quand tout le vanilla reste sans icône.
        reason: sonde ? 'ok' : (pileComplete(trouves) ? 'pas_un_pack' : 'sans_jeu'),
        entries: pack.count ?? null,
        sources: pack.sources,
        auto: !configure,
        candidates: trouves,
      };
    } catch (err) {
      return { paths: chemins, ok: false, reason: err?.message || 'illisible', auto: !configure, candidates: trouves };
    }
  },

  /** `paths: null` remet la détection automatique ; `[]` coupe les icônes. */
  setResourcePacks: ({ paths }) => {
    packCache = null; // le prochain accès rouvre
    adapter.writeSettings({ resourcePacks: Array.isArray(paths) ? paths : null });
    return methods.resourcePackInfo();
  },

  /**
   * Icônes de plusieurs blocs d'un coup.
   *
   * En lot parce que la palette est virtualisée : elle en demande la vingtaine
   * qu'elle affiche, pas les trois cent quarante-six du catalogue. Un aller-
   * retour par ligne ferait vingt allers-retours par défilement.
   *
   * Rend `null` pour un bloc absent du pack — jamais une icône approchée : une
   * icône fausse est pire qu'un carré de couleur, parce qu'on la croit.
   */
  blockIcons: ({ ids }) => {
    const chemins = cheminsPack();
    if (!chemins.length) return {};
    let pack;
    try { pack = ouvrePile(chemins); } catch { return {}; }

    const out = {};
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 256)) {
      let plan;
      try { plan = planIcone(pack, id); } catch { plan = null; }
      if (!plan) { out[id] = null; continue; }
      // Les PNG partent en `data:` : une texture de bloc fait 16 × 16, donc
      // quelques centaines d'octets, et le renderer n'a qu'à les donner à une
      // `Image`. Pas de fichier temporaire, pas de second protocole.
      const textures = {};
      for (const [cle, fichier] of Object.entries(plan.textures)) {
        const buf = pack.read(fichier);
        if (buf) textures[cle] = `data:image/png;base64,${buf.toString('base64')}`;
      }
      out[id] = Object.keys(textures).length ? { kind: plan.kind, elements: plan.elements, textures } : null;
    }
    return out;
  },

  /**
   * La GÉOMÉTRIE d'un lot de blocs, pour le viewport : la forme et les textures.
   *
   * Distinct de `blockIcons` : l'icône n'a besoin que des trois faces visibles,
   * le viewport les voit toutes — on tourne autour d'un build. Et surtout, le
   * viewport a besoin de savoir qu'un escalier n'est PAS un cube : le dessiner
   * en cube plein fait passer une volée de marches pour un mur.
   */
  blockShapes: ({ ids }) => {
    const chemins = cheminsPack();
    if (!chemins.length) return {};
    let pack;
    try { pack = ouvrePile(chemins); } catch { return {}; }

    const out = {};
    // Le cache de fichiers est PARTAGÉ par tous les blocs du lot : `stone.png`
    // sert des dizaines de blocs, et un build ordinaire le redemanderait deux
    // cents fois.
    const cache = new Map();
    const lire = (fichier) => {
      if (cache.has(fichier)) return cache.get(fichier);
      const buf = pack.read(fichier);
      const url = buf ? `data:image/png;base64,${buf.toString('base64')}` : null;
      cache.set(fichier, url);
      return url;
    };

    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 2048)) {
      let modele;
      try { modele = planModele(pack, id); } catch { modele = null; }
      if (!modele) continue;

      const boxes = [];
      for (const box of modele.boxes) {
        const faces = {};
        for (const [face, decl] of Object.entries(box.faces)) {
          const url = lire(decl.texture);
          if (url) faces[face] = { texture: url, uv: decl.uv, rotation: decl.rotation };
        }
        if (Object.keys(faces).length) boxes.push({ from: box.from, to: box.to, faces });
      }
      if (boxes.length) out[id] = { kind: modele.kind, boxes };
    }
    return out;
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
