const { contextBridge, ipcRenderer } = require('electron');

// Pont d'API — en CommonJS, et c'est obligatoire : un preload en `sandbox: true`
// ne charge pas de modules ES.
//
// Le renderer ne reçoit qu'une LISTE BLANCHE de méthodes. Il n'a ni `require`,
// ni `fs`, ni un canal IPC générique : s'il est compromis par une dépendance,
// il ne peut faire que ce qui est écrit ci-dessous.

const ENGINE_METHODS = [
  'listProjects', 'getProject', 'closeProject', 'renameProject', 'rescanExtent',
  'openFile', 'openSchematic', 'openWorld', 'inspectWorldFolder', 'loadMoreRegions',
  'getGeometry',
  'apply', 'undo', 'redo', 'reset', 'audit',
  'inspectWorld',
  'listSchematics', 'saveSchematic', 'loadSchematic', 'removeSchematic', 'hasClipboard',
  'getSettings', 'saveSettings', 'listBlocks',
  'resourcePackInfo', 'setResourcePacks', 'blockIcons', 'blockFaces',
  // Panneau, carte en blocs, relief : l'interface prépare la grille, le moteur l'écrit.
  'textSvg', 'panelPresets', 'mapPalette', 'applyPanel', 'applyMapBlocks', 'applyHeightmap', 'exportHeightmap',
  'applyStroke',
  'info',
];

// `applyToWorld` et `exportSchematic` ne figurent PAS ici : elles écrivent chez
// l'utilisateur, donc elles passent par le processus principal, qui demande
// confirmation et choisit le chemin. Le renderer les déclenche, il ne les
// exécute pas.

const engine = {};
for (const method of ENGINE_METHODS) {
  engine[method] = (params) => ipcRenderer.invoke('engine:call', method, params);
}

contextBridge.exposeInMainWorld('titi', {
  engine,

  // Actions qui parlent à l'utilisateur : elles appartiennent au processus
  // principal, le renderer ne fait que les déclencher.
  openBuild: () => ipcRenderer.invoke('shell:openBuild'),
  openWorldFolder: () => ipcRenderer.invoke('shell:openWorldFolder'),
  /** Ouvre un chemin déjà connu — glisser-déposer. */
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  saveExport: (opts) => ipcRenderer.invoke('shell:saveExport', opts),
  /** Choisir une image (panneau, carte, relief) : le principal lit, pas nous. */
  openImage: () => ipcRenderer.invoke('shell:openImage'),
  pickResourcePack: () => ipcRenderer.invoke('shell:pickResourcePack'),
  savePng: (opts) => ipcRenderer.invoke('shell:savePng', opts),
  applyToWorld: (opts) => ipcRenderer.invoke('shell:applyToWorld', opts),
  window: {
    minimize: () => ipcRenderer.invoke('shell:window', 'minimize'),
    maximize: () => ipcRenderer.invoke('shell:window', 'maximize'),
    close: () => ipcRenderer.invoke('shell:window', 'close'),
  },

  /** Progression des opérations longues. Renvoie de quoi se désabonner. */
  onEngineEvent: (handler) => {
    const listener = (_e, msg) => handler(msg);
    ipcRenderer.on('engine:event', listener);
    return () => ipcRenderer.removeListener('engine:event', listener);
  },

  platform: process.platform,
});
