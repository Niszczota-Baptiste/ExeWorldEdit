import { create } from 'zustand';
import { DEFAULT_SETTINGS, normalizeSettings, applyTheme } from './theme.js';
import { registerColors } from './viewport/blockColors.js';

// État de l'application. Le renderer ne détient JAMAIS de vérité sur le build :
// tout ce qui est ici est un reflet de ce que le moteur a répondu. Une opération
// se termine toujours par un rafraîchissement depuis le moteur, jamais par une
// mise à jour optimiste de la géométrie.

const api = () => window.titi;

export const TOOLS = [
  { id: 'select', label: 'Sélection', icon: 'BoxSelect', key: 'V' },
  { id: 'transform', label: 'Transformer', icon: 'FlipHorizontal2', key: 'T' },
  { id: 'blocks', label: 'Blocs', icon: 'Blocks', key: 'B' },
  { id: 'shapes', label: 'Formes', icon: 'Circle', key: 'F' },
  { id: 'terrain', label: 'Terrain', icon: 'Mountain', key: 'G' },
  { id: 'brush', label: 'Pinceau', icon: 'Brush', key: 'P', soon: true },
  { id: 'path', label: 'Tracé', icon: 'Spline', key: 'C' },
  { id: 'panel', label: 'Texte et carte', icon: 'Type', key: 'X', soon: true },
  { id: 'heightmap', label: 'Relief', icon: 'Waves', key: 'H', soon: true },
  { id: 'measure', label: 'Mesure', icon: 'Ruler', key: 'M' },
  { id: 'library', label: 'Bibliothèque', icon: 'Library', key: 'L', soon: true },
];

/**
 * Les opérations que chaque outil met en avant dans l'inspecteur.
 *
 * Un test (`test/store.test.js`) exige que TOUTE opération déclarée par le
 * moteur figure ici. Sans lui, `biome`, `copy` et `paste` étaient déclarées,
 * branchées, testées — et inatteignables : aucun outil ne les proposait et
 * aucun raccourci ne les appelait.
 */
export const TOOL_OPS = {
  transform: ['mirror', 'rotate', 'translate', 'stack', 'scale', 'mirrorcopy'],
  blocks: ['set', 'replace', 'mix', 'walls', 'faces', 'hollow', 'overlay', 'drain', 'cut'],
  shapes: ['sphere', 'cyl', 'pyramid', 'cone', 'line'],
  terrain: ['terrain', 'naturalize', 'smooth', 'erode', 'dilate', 'biome'],
  path: ['path'],
  // L'outil de sélection porte le presse-papier : c'est là qu'on a une zone
  // sous la main et rien d'autre à en faire.
  select: ['copy', 'paste'],
};

/**
 * Ce que dit l'inspecteur d'un outil qui n'a PAS d'opérations du moteur.
 *
 * Sans ça il gardait à l'écran la description, les champs et le bouton de
 * l'opération d'avant : choisir « Texte et carte » proposait « Appliquer
 * copier ». Un outil doit dire ce qu'il fait, ou dire qu'il ne le fait pas
 * encore — jamais présenter les commandes d'un autre.
 */
export const TOOL_NOTES = {
  brush: { soon: true, text: 'Peindre directement dans la vue, sans passer par une sélection. Phase 3.' },
  panel: { soon: true, text: 'Écrire un texte ou projeter une image en blocs sur un mur plat. Le moteur sait déjà le faire (`applyPanel`) ; l’écran de saisie reste à brancher.' },
  heightmap: { soon: true, text: 'Sculpter le relief depuis une image en niveaux de gris, et ressortir celui d’une zone. Le moteur sait déjà le faire (`applyHeightmap`) ; l’écran reste à brancher.' },
  measure: { text: 'Les dimensions de la sélection sont au-dessus : taille en blocs et volume. Rien à appliquer.' },
  library: { soon: true, text: 'Ranger une zone copiée et la reposer ailleurs, d’un build à l’autre. Le moteur et le pont sont prêts ; l’écran reste à brancher.' },
};

export const useApp = create((set, get) => ({
  projects: [],
  activeId: null,
  geometry: null,
  selection: null,
  tool: 'select',
  // La première opération de l'outil de départ, et pas une constante à part :
  // les deux ont divergé dès que `select` a eu des opérations, et l'inspecteur
  // affichait « Copier » dans sa liste tout en préparant un « Remplir ».
  operation: TOOL_OPS.select[0],
  block: 'minecraft:stone',
  layerY: null,
  busy: null,          // { operation, phase, pct }
  stats: {},
  wheelOpen: false,
  paletteQuery: '',
  /** Onglet de la palette : `build` (ce qui est posé) ou `catalogue` (tout). */
  paletteTab: 'build',
  /** Catalogue de blocs du moteur — chargé une fois, au démarrage. */
  catalog: null,
  catalogGroups: [],
  toast: null,
  /** Carte d'une save en attente de choix de zone (voir WorldPicker). */
  pendingWorld: null,

  // ── Réglages et performances ────────────────────────────────────────────
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  /** Relevés par phase des dernières opérations, plus récent en tête. */
  perfLog: [],
  engineInfo: null,
  // Plafonds du moteur et leurs bornes. Séparés de `settings` : ceux-là sont
  // l'affaire du moteur, `normalizeSettings` (theme.js) ne les connaît pas.
  limits: null,
  limitRanges: null,

  project: () => get().projects.find((p) => p.id === get().activeId) || null,

  setTool: (tool) => {
    const ops = TOOL_OPS[tool];
    set({ tool, ...(ops?.length ? { operation: ops[0] } : {}) });
  },
  setOperation: (operation) => set({ operation }),
  setBlock: (block) => set({ block }),
  setLayerY: (layerY) => set({ layerY }),
  setSelection: (selection) => set({ selection }),
  setStats: (patch) => set((s) => ({ stats: { ...s.stats, ...patch } })),
  setWheel: (wheelOpen) => set({ wheelOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setPaletteQuery: (paletteQuery) => set({ paletteQuery }),
  setPaletteTab: (paletteTab) => set({ paletteTab }),
  say: (toast) => {
    set({ toast });
    if (toast) setTimeout(() => { if (get().toast === toast) set({ toast: null }); }, 4000);
  },

  async refreshProjects({ activateFirst = true } = {}) {
    const projects = await api().engine.listProjects();
    set({ projects });
    if (activateFirst && !get().activeId && projects[0]) await get().activate(projects[0].id);
    return projects;
  },

  async activate(id) {
    set({ activeId: id, geometry: null, selection: null, perfLog: [] });
    const geometry = await api().engine.getGeometry({ id });
    const project = get().projects.find((p) => p.id === id);
    set({
      geometry,
      layerY: geometry ? geometry.min.y + geometry.size.y - 1 : null,
      // Sélection par défaut : l'emprise du contenu, comme sur le site.
      selection: project ? { min: project.extent.min, max: project.extent.max } : null,
    });
    await get().loadPerf(id);
  },

  // ── Réglages ──────────────────────────────────────────────────────────────

  /**
   * Les réglages vivent côté moteur. On applique le thème AVANT de rendre quoi
   * que ce soit d'autre : appliquer après, c'est afficher un instant l'ancienne
   * apparence puis la voir sauter.
   */
  /**
   * Charge le catalogue de blocs. Une fois par session : c'est une constante
   * du moteur plus le `blocks.json` de l'installation, rien qui change en cours
   * de route.
   */
  async loadCatalog() {
    try {
      const { groups, blocks } = await api().engine.listBlocks();
      // Avant de poser le catalogue : le viewport lit les couleurs au maillage,
      // et un build déjà affiché ne se redessine pas tout seul.
      registerColors(blocks);
      set({ catalog: blocks, catalogGroups: groups });
    } catch { /* moteur pas encore prêt : la palette se contente du build */ }
  },

  async loadSettings() {
    let settings = DEFAULT_SETTINGS;
    try {
      const raw = await api().engine.getSettings();
      settings = normalizeSettings(raw);
      set({ limits: raw.limits || null, limitRanges: raw.limitRanges || null });
    } catch { /* premier lancement, ou moteur pas encore prêt */ }
    applyTheme(settings);
    set({ settings });
    return settings;
  },

  /**
   * Appliqué tout de suite, enregistré ensuite : régler une taille de texte
   * demande de voir le résultat pendant qu'on bouge le curseur, pas après un
   * aller-retour vers le disque.
   */
  async updateSettings(patch) {
    const settings = normalizeSettings({ ...get().settings, ...patch });
    applyTheme(settings);
    set({ settings });
    try {
      await api().engine.saveSettings({ patch: settings });
    } catch {
      get().say('Réglages appliqués, mais non enregistrés : ils vaudront pour cette session.');
    }
    return settings;
  },

  resetSettings() { return get().updateSettings(DEFAULT_SETTINGS); },

  /**
   * Change un plafond du moteur. C'est LUI qui borne et qui rend la valeur
   * retenue : l'afficher telle qu'elle a été saisie ferait croire qu'un
   * réglage hors bornes a pris.
   */
  async updateLimits(patch) {
    try {
      const next = await api().engine.saveSettings({ patch: { limits: { ...get().limits, ...patch } } });
      set({ limits: next.limits });
      return next.limits;
    } catch (e) {
      get().say(errorText(e, 'réglage des plafonds'));
      return get().limits;
    }
  },

  // ── Relevés de performance ────────────────────────────────────────────────

  /**
   * Le journal du moteur est la source : ce qu'on affiche a réellement été
   * mesuré pendant l'opération, ce n'est pas un chronomètre tenu par
   * l'interface — qui compterait aussi ses propres allers-retours.
   */
  async loadPerf(id) {
    try {
      const lines = await api().engine.audit({ id, limit: 40 });
      set({
        perfLog: lines
          .filter((l) => l.timings?.phases?.length)
          .map((l) => ({
            at: Date.parse(l.createdAt) || Date.now(),
            operation: l.operation,
            blocksChanged: l.blocksChanged || 0,
            totalMs: l.timings.totalMs,
            phases: l.timings.phases,
          })),
      });
    } catch { /* pas de journal, pas de relevé */ }
  },

  /** Mémoire et plafonds du processus moteur — rafraîchis par le panneau. */
  async refreshEngineInfo() {
    try { set({ engineInfo: await api().engine.info() }); } catch { /* moteur occupé */ }
  },

  /**
   * Ferme un projet — ce qui EFFACE sa copie de travail.
   *
   * Il n'y a pas d'état « ouvert » séparé de l'existence : un projet est sa
   * copie de staging. Fermer, c'est donc supprimer, et ça se confirme — surtout
   * quand des modifications n'ont pas été exportées. Le fichier d'ORIGINE, lui,
   * n'est jamais touché : c'est l'invariant n° 1.
   */
  async closeProject(id) {
    const p = get().projects.find((x) => x.id === id);
    if (!p) return;
    const message = p.pending
      ? `Fermer « ${p.name} » ?\n\nSes modifications non exportées seront perdues.\nLe fichier d’origine n’est pas touché.`
      : `Fermer « ${p.name} » ?\n\nLa copie de travail est supprimée ; le fichier d’origine n’est pas touché.`;
    if (!window.confirm(message)) return;

    try {
      await api().engine.closeProject({ id });
    } catch (e) {
      get().say(errorText(e, 'fermeture'));
      return;
    }
    const reste = await get().refreshProjects({ activateFirst: false });
    if (get().activeId === id) {
      set({ activeId: null, geometry: null, selection: null, perfLog: [] });
      if (reste[0]) await get().activate(reste[0].id);
    }
    get().say(`« ${p.name} » fermé.`);
  },

  async open() { return get()._opened(() => api().openBuild()); },
  async openWorld() { return get()._opened(() => api().openWorldFolder()); },
  async openPath(filePath) { return get()._opened(() => api().openPath(filePath)); },

  cancelWorld: () => set({ pendingWorld: null }),

  /** Second temps de l'ouverture d'un monde : la zone est choisie, on charge. */
  async openWorldArea(regions) {
    const world = get().pendingWorld;
    if (!world) return null;
    set({ pendingWorld: null });
    return get()._opened(async () => {
      const project = await api().engine.openWorld({ dirPath: world.path, regions, name: world.name });
      if (project?.missing) {
        get().say(`${project.loaded} régions chargées ; ${project.missing} n’existent pas encore dans ce monde.`);
      }
      return project;
    });
  },

  /** Étend un projet ouvert avec les régions voisines. */
  async loadMore(area) {
    const id = get().activeId;
    if (!id) return;
    try {
      const res = await api().engine.loadMoreRegions({ id, area });
      await get().refreshProjects();
      set({ geometry: await api().engine.getGeometry({ id }) });
      get().say(res.loaded ? `${res.loaded} région(s) ajoutée(s).` : 'Rien de plus à charger dans cette zone.');
    } catch (e) {
      get().say(errorText(e, 'chargement'));
    }
  },

  async _opened(fn) {
    try {
      const result = await fn();
      if (!result) return null;

      // Un dossier de monde ne rend pas un projet mais sa CARTE : on n'ouvre
      // pas des dizaines de gigaoctets sans demander quoi charger.
      if (result.regions && !result.id) {
        set({ pendingWorld: result });
        return null;
      }
      const project = result;
      await get().refreshProjects();
      await get().activate(project.id);
      // Un monde ouvert dans Minecraft s'ouvre quand même en lecture — c'est
      // au moment d'écrire qu'on refuse. Le dire tout de suite évite de
      // travailler une heure avant de l'apprendre.
      if (project.lock?.locked) {
        get().say(`« ${project.name} » est ouvert dans Minecraft : lecture seule tant que le jeu tourne.`);
      } else {
        get().say(`« ${project.name} » ouvert.`);
      }
      return project;
    } catch (e) {
      get().say(errorText(e, 'ouverture'));
      return null;
    }
  },

  async run(operation, params) {
    const id = get().activeId;
    const selection = get().selection;
    if (!id || !selection) return;
    set({ busy: { operation, phase: 'load', pct: 0 } });
    try {
      const res = await api().engine.apply({ id, operation, params, selection });
      await get().refreshProjects();
      const geometry = await api().engine.getGeometry({ id });
      set({ geometry });
      if (res.timings?.phases?.length) {
        set((s) => ({
          perfLog: [{
            at: Date.now(),
            operation,
            blocksChanged: res.blocksChanged || 0,
            totalMs: res.timings.totalMs,
            phases: res.timings.phases,
          }, ...s.perfLog].slice(0, 40),
        }));
      }
      get().say(`${operation} — ${res.blocksChanged.toLocaleString('fr-FR')} blocs en ${res.durationMs} ms.`);
      return res;
    } catch (e) {
      get().say(errorText(e, operation));
      throw e;
    } finally {
      set({ busy: null });
    }
  },

  async undo() { return get()._history('undo'); },
  async redo() { return get()._history('redo'); },

  async _history(which) {
    const id = get().activeId;
    if (!id) return;
    try {
      await api().engine[which]({ id });
      await get().refreshProjects();
      set({ geometry: await api().engine.getGeometry({ id }) });
      get().say(which === 'undo' ? 'Opération annulée.' : 'Opération rétablie.');
    } catch (e) {
      get().say(errorText(e, which));
    }
  },

  /** @param {'mca'|'schem'|'litematic'} format */
  async exportBuild(format = 'mca') {
    const project = get().project();
    if (!project) return;
    try {
      const res = await api().saveExport({
        id: project.id, format,
        selection: format === 'mca' ? undefined : get().selection,
      });
      if (!res) return;
      get().say(res.note === 'entities'
        ? `Exporté : ${res.path} — WorldEdit ne colle les entités qu’avec //paste -e.`
        : `Exporté : ${res.path}`);
    } catch (e) {
      get().say(errorText(e, 'export'));
    }
  },

  /** Réécrit le staging dans la save d'origine. Irréversible côté monde. */
  async applyToWorld() {
    const project = get().project();
    if (!project?.world) return;
    try {
      const res = await api().applyToWorld({ id: project.id });
      if (!res) return; // annulé dans la confirmation
      await get().refreshProjects();
      get().say(res.backup
        ? `${res.written} région${res.written > 1 ? 's' : ''} appliquée${res.written > 1 ? 's' : ''}. Sauvegarde : ${res.backup.file}`
        : `${res.written} région${res.written > 1 ? 's' : ''} appliquée${res.written > 1 ? 's' : ''}.`);
    } catch (e) {
      get().say(errorText(e, 'application au monde'));
    }
  },
}));

/**
 * Les codes du moteur deviennent des phrases qui disent QUOI FAIRE. Afficher
 * `selection_too_large` à un utilisateur, c'est lui laisser deviner.
 */
export function errorText(e, context) {
  const code = String(e?.message || '').replace(/^Error:\s*/, '');
  return ERREURS[code] || `Échec de ${context} : ${code}`;
}

/**
 * Table complète des codes du moteur. Un test (`test/store.test.js`) relit les
 * `new Error('…')` de `packages/we-engine/src` et exige que chacun soit ici :
 * un code oublié s'affiche tel quel à l'utilisateur, en anglais et en
 * snake_case.
 */
export const ERREURS = {
  out_of_bounds: 'La sélection sort du build. Réduis-la ou étends l’emprise.',
  selection_too_large: 'Sélection trop grande pour cette opération. Découpe-la en plusieurs passes.',
  invalid_selection: 'Sélection incomplète : vérifie les deux coins.',
  nothing_to_undo: 'Rien à annuler.',
  nothing_to_redo: 'Rien à rétablir.',
  empty_clipboard: 'Le presse-papier est vide. Copie d’abord une zone.',
  no_source: 'Ce projet n’a plus de fichier source.',
  too_many_blocks: 'Zone trop dense pour être affichée d’un coup. Réduis la sélection.',
  scale_result_too_large: 'Le résultat dépasse 8 millions de blocs. Baisse le facteur, ou réduis la sélection.',
  // Refus du NORMALISEUR. Ils remontent jusqu'ici depuis que toute opération
  // passe par lui : un champ mal rempli doit dire lequel, pas « bad_block ».
  bad_block: 'Nom de bloc invalide. Attendu « namespace:identifiant », par exemple minecraft:stone.',
  bad_pattern: 'Le mélange est vide : ajoute au moins un bloc avec une part supérieure à 0.',
  bad_biome: 'Nom de biome invalide. Attendu « namespace:identifiant », par exemple minecraft:plains.',
  bad_axis: 'Axe invalide : choisis X, Y ou Z.',
  bad_degrees: 'Angle invalide : 90, 180 ou 270.',
  bad_offset: 'Décalage invalide : trois nombres entiers attendus.',
  bad_direction: 'Direction invalide.',
  bad_factor: 'Facteur d’échelle invalide.',
  bad_panel: 'Panneau invalide : le masque ne couvre pas toute la zone.',
  biome_unsupported: 'Ce build ne porte pas de données de biome.',
  empty_box: 'La zone ne contient aucun bloc.',
  unknown_operation: 'Opération inconnue : le moteur ne la connaît pas.',
  world_busy: 'Ce monde est ouvert dans Minecraft. Ferme le jeu, puis réessaie.',
  lock_unverifiable: 'Impossible de vérifier si Minecraft tient ce monde. Ferme le jeu avant d’appliquer.',
  no_world: 'Ce projet ne vient pas d’un dossier de monde : rien où l’appliquer.',
  not_a_world: 'Ce dossier n’est ni une save ni un dossier region/.',
  no_region_dir: 'Ce monde n’a pas de dossier region/.',
  no_region: 'Ce dossier ne contient aucun fichier de région.',
  no_area: 'Aucune zone demandée : choisis les régions à ouvrir.',
  empty_area: 'Cette zone n’a jamais été générée dans ce monde.',
  bad_schematic: 'Ce fichier n’est pas un schematic lisible.',
  region_coords_unknown: 'Impossible de situer cette région : ni son nom ni son contenu ne le disent. Ce fichier n’est peut-être pas un .mca valide.',
  bad_replace: 'Remplacement invalide : choisis au moins un bloc source et un bloc cible.',
  bad_plane: 'Cette sélection n’est pas un plan : un panneau demande une zone plate d’un bloc d’épaisseur.',
  empty_plane: 'Le plan est vide.',
  bad_heightmap: 'Relief invalide : les hauteurs ne couvrent pas toute la zone.',
  bad_preview: 'Aperçu illisible. Relance l’opération pour le régénérer.',
  bad_litematic: 'Ce fichier .litematic est illisible.',
  zip_invalid: 'Archive zip illisible ou sans fichier de région.',
  empty_seed: 'Aucune région à installer.',
  invalid_blank: 'Dimensions de build invalides.',
  invalid_project_id: 'Identifiant de projet invalide.',
  library_full: 'La bibliothèque est pleine : supprime une entrée avant d’en ranger une autre.',
  world_too_big: 'Ce monde est trop grand pour être ouvert d’un coup. Choisis une zone plus petite.',
  not_found: 'Projet introuvable.',
  operation_non_parallelisable: 'Cette opération ne se découpe pas par région.',
};
