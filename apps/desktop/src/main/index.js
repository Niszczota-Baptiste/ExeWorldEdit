import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { registerAppScheme, serveAppProtocol, here } from './protocol.js';
import { startEngine } from './engine-host.js';

const DIR = here(import.meta.url);
const ROOT = path.join(DIR, '..', '..');
const isDev = !app.isPackaged && !!process.env.TITI_DEV_SERVER;

registerAppScheme(); // doit précéder app.whenReady()

// Sur une machine sans GPU — un runner d'intégration continue, une session
// distante — Chromium abandonne WebGL et le viewport reste noir. SwiftShader
// rend en logiciel : lent, mais correct, et c'est ce qui permet de vérifier le
// rendu automatiquement.
if (process.env.TITI_SOFTWARE_GL || process.env.TITI_SCREENSHOT) {
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.disableHardwareAcceleration();
}

let win = null;
let engine = null;

// Palette de l'atelier — dupliquée ici parce que la fenêtre existe avant que le
// renderer ait chargé la moindre CSS : sans ça, un flash blanc à l'ouverture.
const SHELL_BG = '#1E2329';
const PANEL_BG = '#272D35';
const TEXT = '#E6E9ED';

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: SHELL_BG,
    show: false,
    title: 'Titi WorldEdit',
    // Barre de titre maison : les onglets de projets et la recherche y vivent.
    titleBarStyle: 'hidden',
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { color: PANEL_BG, symbolColor: TEXT, height: 38 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(DIR, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Sans ça, une erreur de chargement dans le renderer ne laisse qu'une fenêtre
  // vide et aucune trace.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] échec de chargement ${url} : ${desc} (${code})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] processus perdu :', details.reason);
  });

  // Rien ne navigue hors de l'application, et aucun lien n'ouvre de fenêtre
  // Electron : les liens externes partent dans le navigateur du système.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://titi/') && !url.startsWith(process.env.TITI_DEV_SERVER || '\0')) e.preventDefault();
  });

  if (isDev) win.loadURL(process.env.TITI_DEV_SERVER);
  else win.loadURL(`app://titi/index.html${process.env.TITI_DIAG ? '#diag' : ''}`);

  // Chemin passé au lancement : « ouvrir avec », un fichier lâché sur l'icône,
  // une association de fichiers, ou `titi-worldedit.exe "C:\...\saves\Monde"`.
  // Il suit exactement le même chemin qu'un glisser-déposer.
  const startupPath = pendingOpen();
  if (startupPath) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('engine:event', { event: 'open-path', path: startupPath });
    });
  }

  return win;
}

/**
 * Le chemin à ouvrir au démarrage, s'il y en a un. Electron passe ses propres
 * options dans argv : on ne retient que le premier argument qui EXISTE
 * réellement sur le disque, ce qui écarte les drapeaux sans les lister.
 */
function pendingOpen() {
  if (process.env.TITI_OPEN) return process.env.TITI_OPEN;
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- argument de ligne de commande, seulement testé
    if (fs.existsSync(arg)) return arg;
  }
  return null;
}

app.whenReady().then(async () => {
  // `res` et non `assets` : Vite écrit déjà le bundle dans `dist/renderer/assets`,
  // et deux racines derrière le même préfixe se marchent dessus — les scripts de
  // l'application renvoyaient 404 sur une page parfaitement valide.
  serveAppProtocol({
    '': path.join(ROOT, 'dist', 'renderer'),
    res: path.join(ROOT, 'assets'),
  });

  engine = startEngine({
    onEvent: (msg) => win?.webContents.send('engine:event', msg),
  });
  await engine.whenReady;

  // Un seul canal vers le moteur : le preload n'expose qu'une liste blanche de
  // méthodes, et le renderer ne peut rien invoquer d'autre.
  ipcMain.handle('engine:call', (_e, method, params) => engine.call(method, params));

  /**
   * Un chemin, quelle que soit sa provenance — dialogue ou glisser-déposer —
   * arrive ici, et c'est l'extension qui décide de la porte d'entrée. Sans ce
   * point unique, chaque façon d'ouvrir un fichier aurait sa propre logique et
   * elles finiraient par diverger.
   */
  const openAnyPath = async (target) => {
    if (!target) return null;
    const ext = path.extname(target).toLowerCase();
    if (ext === '.schem' || ext === '.litematic' || ext === '.schematic') {
      return engine.call('openSchematic', { filePath: target });
    }
    if (ext === '.mca' || ext === '.zip') {
      return engine.call('openFile', { filePath: target });
    }
    // Ni l'un ni l'autre : c'est probablement un dossier (save ou region/).
    // Il rend sa carte, pas un projet — voir `shell:openWorldFolder`.
    return engine.call('inspectWorldFolder', { dirPath: target });
  };

  ipcMain.handle('shell:openBuild', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Ouvrir un build',
      properties: ['openFile'],
      filters: [
        { name: 'Tout ce qui s’ouvre', extensions: ['mca', 'zip', 'schem', 'litematic', 'schematic'] },
        { name: 'Région Anvil', extensions: ['mca'] },
        { name: 'Dossier region/ zippé', extensions: ['zip'] },
        { name: 'Schematic', extensions: ['schem', 'litematic', 'schematic'] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return openAnyPath(res.filePaths[0]);
  });

  /**
   * Choisir un dossier de monde rend sa CARTE, pas un projet : une save peut
   * peser des dizaines de gigaoctets, et l'ouvrir en entier n'aurait aucun sens.
   * C'est le renderer qui montre la carte, laisse choisir une zone, puis appelle
   * `openWorld` avec elle.
   */
  ipcMain.handle('shell:openWorldFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Ouvrir un dossier de save ou un dossier region/',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return engine.call('inspectWorldFolder', { dirPath: res.filePaths[0] });
  });

  ipcMain.handle('shell:openPath', (_e, target) => openAnyPath(target));

  /**
   * Écrire dans la save de quelqu'un est la seule action irréversible de
   * l'application. Elle passe donc par une confirmation MODALE qui dit
   * exactement ce qui va se passer — combien de régions, où, et qu'une
   * sauvegarde sera prise avant.
   */
  ipcMain.handle('shell:applyToWorld', async (_e, { id }) => {
    const info = await engine.call('inspectWorld', { id });
    if (!info.attached) throw new Error('no_world');
    if (info.lock.locked) throw new Error('world_busy');

    const incertain = !info.lock.reliable && !!info.lock.reason && info.lock.reason !== 'no_lock_file';
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Annuler', 'Appliquer au monde'],
      defaultId: 0,
      cancelId: 0,
      title: 'Appliquer au monde',
      message: `Réécrire ${info.regions} région${info.regions > 1 ? 's' : ''} dans « ${info.name} » ?`,
      detail: [
        `Dossier : ${info.path}`,
        'Une sauvegarde zip horodatée des régions concernées est prise avant toute écriture.',
        incertain
          ? `\nCette plateforme ne permet pas de vérifier si Minecraft tient le monde ouvert. Ferme le jeu avant de continuer — écrire dans un monde chargé le corrompt.`
          : '',
      ].filter(Boolean).join('\n'),
    });
    if (response !== 1) return null;

    return engine.call('applyToWorld', { id, force: true });
  });

  ipcMain.handle('shell:saveExport', async (_e, { id, offset, format = 'mca', selection, defaultName }) => {
    const out = format === 'mca'
      ? await engine.call('exportBuild', { id, offset })
      : await engine.call('exportSchematic', { id, selection, format });

    const res = await dialog.showSaveDialog(win, {
      title: 'Exporter le build',
      defaultPath: defaultName || out.filename,
    });
    if (res.canceled || !res.filePath) return null;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin issu du dialogue « Enregistrer » du système
    fs.writeFileSync(res.filePath, Buffer.from(out.buffer));
    return {
      path: res.filePath,
      bytes: out.buffer.byteLength ?? out.buffer.length,
      // WorldEdit ne colle les entités qu'avec `//paste -e` : le dire ici évite
      // de découvrir leur absence une fois le schematic collé en jeu.
      note: out.note || null,
    };
  });

  ipcMain.handle('shell:window', (_e, action) => {
    if (!win) return null;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
    return win.isMaximized();
  });

  createWindow();

  // Mode capture : rend la fenêtre, attend que le maillage se termine, écrit
  // un PNG et quitte. Sert à produire les images de la documentation et à
  // vérifier le rendu dans une session sans écran — ce qui est exactement le
  // cas d'un runner d'intégration continue.
  if (process.env.TITI_SCREENSHOT) {
    const delay = Number(process.env.TITI_SCREENSHOT_DELAY || 9000);
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        // Ouverture de la roue d'outils par un VRAI événement clavier plutôt
        // qu'un crochet de test : ce qu'on capture est alors exactement ce que
        // produit la touche Espace, pas un état forcé qui pourrait mentir.
        if (process.env.TITI_SCREENSHOT_WHEEL) {
          const [w, h] = win.getContentSize();
          win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(w * 0.36), y: Math.round(h * 0.34) });
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
          await new Promise((r) => setTimeout(r, 600));
          win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(w * 0.36), y: Math.round(h * 0.34) });
          await new Promise((r) => setTimeout(r, 400));
        }
        // Même principe pour les réglages : Ctrl + virgule, le raccourci réel.
        if (process.env.TITI_SCREENSHOT_SETTINGS) {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: ['control'] });
          await new Promise((r) => setTimeout(r, 700));
        }
        const image = await win.webContents.capturePage();
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin de capture, fourni au lancement
        fs.writeFileSync(process.env.TITI_SCREENSHOT, image.toPNG());
        console.log(`capture écrite : ${process.env.TITI_SCREENSHOT}`);
        app.quit();
      }, delay);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  engine?.kill();
  if (process.platform !== 'darwin') app.quit();
});
