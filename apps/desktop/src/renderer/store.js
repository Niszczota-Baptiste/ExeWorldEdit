import { create } from 'zustand';

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
  { id: 'panel', label: 'Texte et carte', icon: 'Type', key: 'X' },
  { id: 'heightmap', label: 'Relief', icon: 'Waves', key: 'H' },
  { id: 'measure', label: 'Mesure', icon: 'Ruler', key: 'M' },
  { id: 'library', label: 'Bibliothèque', icon: 'Library', key: 'L' },
];

/** Les opérations que chaque outil met en avant dans l'inspecteur. */
export const TOOL_OPS = {
  transform: ['mirror', 'rotate', 'translate', 'stack', 'scale', 'mirrorcopy'],
  blocks: ['set', 'replace', 'mix', 'walls', 'faces', 'hollow', 'overlay', 'drain', 'cut'],
  shapes: ['sphere', 'cyl', 'pyramid', 'cone', 'line'],
  terrain: ['terrain', 'naturalize', 'smooth', 'erode', 'dilate'],
  path: ['path'],
  select: [],
};

export const useApp = create((set, get) => ({
  projects: [],
  activeId: null,
  geometry: null,
  selection: null,
  tool: 'select',
  operation: 'set',
  block: 'minecraft:stone',
  layerY: null,
  busy: null,          // { operation, phase, pct }
  stats: {},
  wheelOpen: false,
  paletteQuery: '',
  toast: null,

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
  setPaletteQuery: (paletteQuery) => set({ paletteQuery }),
  say: (toast) => {
    set({ toast });
    if (toast) setTimeout(() => { if (get().toast === toast) set({ toast: null }); }, 4000);
  },

  async refreshProjects() {
    const projects = await api().engine.listProjects();
    set({ projects });
    if (!get().activeId && projects[0]) await get().activate(projects[0].id);
    return projects;
  },

  async activate(id) {
    set({ activeId: id, geometry: null, selection: null });
    const geometry = await api().engine.getGeometry({ id });
    const project = get().projects.find((p) => p.id === id);
    set({
      geometry,
      layerY: geometry ? geometry.min.y + geometry.size.y - 1 : null,
      // Sélection par défaut : l'emprise du contenu, comme sur le site.
      selection: project ? { min: project.extent.min, max: project.extent.max } : null,
    });
  },

  async open() {
    const project = await api().openBuild();
    if (!project) return null;
    await get().refreshProjects();
    await get().activate(project.id);
    get().say(`« ${project.name} » ouvert.`);
    return project;
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

  async exportBuild() {
    const project = get().project();
    if (!project) return;
    const res = await api().saveExport({ id: project.id, defaultName: null });
    if (res) get().say(`Exporté : ${res.path}`);
  },
}));

/**
 * Les codes du moteur deviennent des phrases qui disent QUOI FAIRE. Afficher
 * `selection_too_large` à un utilisateur, c'est lui laisser deviner.
 */
function errorText(e, context) {
  const code = String(e?.message || '').replace(/^Error:\s*/, '');
  const table = {
    out_of_bounds: 'La sélection sort du build. Réduis-la ou étends l’emprise.',
    selection_too_large: 'Sélection trop grande pour cette opération. Découpe-la en plusieurs passes.',
    invalid_selection: 'Sélection incomplète : vérifie les deux coins.',
    nothing_to_undo: 'Rien à annuler.',
    nothing_to_redo: 'Rien à rétablir.',
    empty_clipboard: 'Le presse-papier est vide. Copie d’abord une zone.',
    no_source: 'Ce projet n’a plus de fichier source.',
    too_many_blocks: 'Zone trop dense pour être affichée d’un coup. Réduis la sélection.',
    empty_box: 'La zone ne contient aucun bloc.',
    unknown_operation: `Opération inconnue : ${context}.`,
  };
  return table[code] || `Échec de ${context} : ${code}`;
}
