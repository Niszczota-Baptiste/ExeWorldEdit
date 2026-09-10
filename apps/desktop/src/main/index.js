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

  return win;
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

  ipcMain.handle('shell:openBuild', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Ouvrir un build',
      properties: ['openFile'],
      filters: [
        { name: 'Build Minecraft', extensions: ['mca', 'zip', 'schem', 'litematic'] },
        { name: 'Région Anvil', extensions: ['mca'] },
        { name: 'Dossier region/ zippé', extensions: ['zip'] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return engine.call('openFile', { filePath: res.filePaths[0] });
  });

  ipcMain.handle('shell:saveExport', async (_e, { id, offset, defaultName }) => {
    const out = await engine.call('exportBuild', { id, offset });
    const res = await dialog.showSaveDialog(win, {
      title: 'Exporter le build',
      defaultPath: defaultName || out.filename,
    });
    if (res.canceled || !res.filePath) return null;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin issu du dialogue « Enregistrer » du système
    fs.writeFileSync(res.filePath, Buffer.from(out.buffer));
    return { path: res.filePath, bytes: out.buffer.byteLength ?? out.buffer.length };
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
