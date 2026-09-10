const { contextBridge, ipcRenderer } = require('electron');

// Pont d'API — en CommonJS, et c'est obligatoire : un preload en `sandbox: true`
// ne charge pas de modules ES.
//
// Le renderer ne reçoit qu'une LISTE BLANCHE de méthodes. Il n'a ni `require`,
// ni `fs`, ni un canal IPC générique : s'il est compromis par une dépendance,
// il ne peut faire que ce qui est écrit ci-dessous.

const ENGINE_METHODS = [
  'listProjects', 'getProject', 'openFile', 'rescanExtent', 'closeProject',
  'getGeometry',
  'apply', 'undo', 'redo', 'reset', 'audit',
  'listSchematics', 'saveSchematic', 'loadSchematic', 'removeSchematic', 'hasClipboard',
  'info',
];

const engine = {};
for (const method of ENGINE_METHODS) {
  engine[method] = (params) => ipcRenderer.invoke('engine:call', method, params);
}

contextBridge.exposeInMainWorld('titi', {
  engine,

  // Actions qui parlent à l'utilisateur : elles appartiennent au processus
  // principal, le renderer ne fait que les déclencher.
  openBuild: () => ipcRenderer.invoke('shell:openBuild'),
  saveExport: (opts) => ipcRenderer.invoke('shell:saveExport', opts),
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
