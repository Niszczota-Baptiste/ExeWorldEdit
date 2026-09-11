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
      sendToRenderer({ event: 'open-path', path: startupPath });
    });
  }

  return win;
}

/**
 * Envoie un message au renderer, s'il y a encore quelqu'un pour l'entendre.
 *
 * `win?.` ne suffit PAS : une fenêtre détruite reste un objet parfaitement
 * vrai, et toucher son `webContents` lève « Object has been destroyed ». Le
 * moteur tourne dans son propre processus et peut très bien répondre après la
 * fermeture de la fenêtre — c'est même le cas normal quand on quitte pendant
 * une opération. Sans ce garde, quitter affiche une boîte d'erreur.
 */
function sendToRenderer(msg) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send('engine:event', msg);
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

  engine = startEngine({ onEvent: sendToRenderer });
  try {
    await engine.whenReady;
  } catch (err) {
    // Sans fenêtre et sans moteur, il n'y a rien à faire de plus qu'un
    // dialogue : l'alternative est une icône dans la barre des tâches qui ne
    // s'ouvre jamais.
    dialog.showErrorBox(
      'Titi WorldEdit n’a pas pu démarrer',
      `${err.message}\n\nLe détail est dans la console (« Afficher les journaux »).`,
    );
    app.exit(1);
    return;
  }

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

  /**
   * Choisit une image et rend ses OCTETS. Le renderer la décode lui-même (il a
   * un canvas ; le moteur n'en a pas), mais il ne lit pas le disque : c'est le
   * processus principal qui ouvre le dialogue et qui lit — invariant n° 6.
   */
  ipcMain.handle('shell:openImage', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choisir une image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin issu du dialogue « Ouvrir » du système
    const buffer = fs.readFileSync(res.filePaths[0]);
    return { name: path.basename(res.filePaths[0]), bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
  });

  /** Enregistre une image produite par le renderer (relief exporté). */
  ipcMain.handle('shell:savePng', async (_e, { bytes, defaultName = 'relief.png' }) => {
    const res = await dialog.showSaveDialog(win, { title: 'Enregistrer le relief', defaultPath: defaultName });
    if (res.canceled || !res.filePath) return null;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin issu du dialogue « Enregistrer » du système
    fs.writeFileSync(res.filePath, Buffer.from(bytes));
    return { path: res.filePath, bytes: bytes.byteLength ?? bytes.length };
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
    // Filet : une capture qui n'aboutit pas doit ÉCHOUER, pas pendre. Une des
    // étapes ci-dessous peut rejeter (un sélecteur qui ne trouve rien, une
    // page qui ne répond plus), et une promesse rejetée dans un `setTimeout`
    // ne se voit nulle part : le processus reste en vie, muet, jusqu'à ce
    // qu'on le tue à la main.
    const secours = setTimeout(() => {
      console.error(`✗ capture abandonnée : rien écrit après ${delay + 30000 + Number(process.env.TITI_SCREENSHOT_CLICK_WAIT || 0)} ms`);
      app.exit(1);
    }, delay + 30000 + Number(process.env.TITI_SCREENSHOT_CLICK_WAIT || 0));
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
       try {
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
        // Un outil, par sa LETTRE — celle que le rail affiche dans son
        // infobulle. Passer par le vrai raccourci plutôt que par un crochet de
        // test garantit que la capture montre un état atteignable : si la
        // touche n'est liée à rien, l'image le dit.
        if (process.env.TITI_SCREENSHOT_TOOL) {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: process.env.TITI_SCREENSHOT_TOOL });
          win.webContents.sendInputEvent({ type: 'char', keyCode: process.env.TITI_SCREENSHOT_TOOL });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: process.env.TITI_SCREENSHOT_TOOL });
          await new Promise((r) => setTimeout(r, 500));
        }
        // Une opération, par la liste déroulante de l'inspecteur. Pas de
        // raccourci pour ça : on pose la valeur sur le vrai `<select>` et on
        // déclenche un vrai `change`, donc le chemin React est le même qu'au
        // clic. Ce qui suit ne vit que dans la branche de capture.
        if (process.env.TITI_SCREENSHOT_OP) {
          await win.webContents.executeJavaScript(`(() => {
            const el = document.getElementById('op');
            if (!el) return 'pas de liste d’opérations';
            el.value = ${JSON.stringify(process.env.TITI_SCREENSHOT_OP)};
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return el.value;
          })()`);
          await new Promise((r) => setTimeout(r, 500));
        }
        // Une SÉLECTION, par les six champs de l'inspecteur. Chacun se valide
        // à la sortie du champ (`blur`), donc on remplit et on sort — le même
        // geste qu'à la main. « x0,y0,z0,x1,y1,z1 ».
        if (process.env.TITI_SCREENSHOT_SELECTION) {
          const v = process.env.TITI_SCREENSHOT_SELECTION.split(',').map((n) => n.trim());
          await win.webContents.executeJavaScript(`(() => {
            const champs = [...document.querySelectorAll('.sel-input')];
            const vals = ${JSON.stringify(v)};
            if (champs.length !== vals.length) return \`champs: \${champs.length}\`;
            const poser = window.Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            champs.forEach((el, i) => {
              // focus() puis blur() pour de vrai : React écoute focusout, qui
              // remonte, et pas l'événement blur posé sur l'élément, qui ne
              // remonte pas. Un dispatchEvent blur n'appelle donc jamais le
              // onBlur du composant — la sélection restait entière.
              // Pas de guillemet oblique ici : on est DANS un littéral gabarit.
              el.focus();
              poser.call(el, vals[i]);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.blur();
            });
            return 'ok';
          })()`);
          await new Promise((r) => setTimeout(r, 600));
        }
        // Un bouton de l'interface, par son sélecteur — `.click()` sur le vrai
        // élément, donc le même chemin qu'un clic de souris.
        if (process.env.TITI_SCREENSHOT_CLICK) {
          await win.webContents.executeJavaScript(
            `document.querySelector(${JSON.stringify(process.env.TITI_SCREENSHOT_CLICK)})?.click() ?? null`,
          );
          // Un clic peut LANCER quelque chose de long : 600 ms suffisent pour
          // voir un onglet changer, pas pour laisser une opération finir.
          await new Promise((r) => setTimeout(r, Number(process.env.TITI_SCREENSHOT_CLICK_WAIT || 600)));
        }
        // Même principe pour les réglages : Ctrl + virgule, le raccourci réel.
        if (process.env.TITI_SCREENSHOT_SETTINGS) {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: ['control'] });
          await new Promise((r) => setTimeout(r, 700));
        }
        const image = await win.webContents.capturePage();
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin de capture, fourni au lancement
        fs.writeFileSync(process.env.TITI_SCREENSHOT, image.toPNG());
        clearTimeout(secours);
        console.log(`capture écrite : ${process.env.TITI_SCREENSHOT}`);
       } catch (err) {
         clearTimeout(secours);
         console.error(`✗ capture échouée : ${err?.message || err}`);
         app.exit(1);
         return;
       }
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
