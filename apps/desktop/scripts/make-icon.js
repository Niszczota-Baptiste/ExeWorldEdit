/* eslint-disable security/detect-non-literal-fs-filename --
   Script de développement : la sortie est un chemin constant sous `build/`. */
// Fabrique l'icône de l'application — `build/icon.ico` et `build/icon.png`.
//
//   npx electron scripts/make-icon.js
//
// Pourquoi un script et pas un fichier binaire posé là : une icône commitée
// sans sa source est opaque en revue et impossible à faire évoluer — le même
// raisonnement que pour les fixtures `.mca` du moteur, qui sont construites à
// la volée plutôt que commitées.
//
// Le rendu passe par Electron, seul outil de dessin dont ce dépôt dispose : il
// charge un SVG dans une fenêtre hors écran et capture. Aucune dépendance
// d'image à ajouter.
//
// L'ICO est écrit à la main : c'est un format simple (un en-tête, un
// répertoire, puis les images), et depuis Vista chaque entrée peut être un PNG
// tel quel. Windows choisit la taille qu'il veut selon le contexte — barre des
// tâches, explorateur, alt-tab — d'où plusieurs tailles dans le même fichier.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'build');

// Les tailles que Windows sait utiliser. 256 sert aux grandes vignettes, 16 à
// la barre de titre.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// La marque de l'application : le pioche de lucide, celle de la barre de titre
// (`shell/icons.js`), sur le céladon des jetons de style.
const ACCENT = '#7FB8A4';
const PANEL = '#232A31';
const PICKAXE = [
  'm14 13-8.381 8.38a1 1 0 0 1-3.001-3L11 9.999',
  'M15.973 4.027A13 13 0 0 0 5.902 2.373c-1.398.342-1.092 2.158.277 2.601a19.9 19.9 0 0 1 5.822 3.024',
  'M16.001 11.999a19.9 19.9 0 0 1 3.024 5.824c.444 1.369 2.26 1.676 2.603.278A13 13 0 0 0 20 8.069',
  'M18.352 3.352a1.205 1.205 0 0 0-1.704 0l-5.296 5.296a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l5.296-5.296a1.205 1.205 0 0 0 0-1.704z',
];

/** SVG de l'icône à la taille demandée. */
function svg(size) {
  // Marge proportionnelle : une icône collée aux bords paraît plus grosse que
  // ses voisines dans la barre des tâches.
  const pad = size * 0.17;
  const inner = size - pad * 2;
  const radius = size * 0.22;
  // Trait plus épais aux petites tailles, sinon la pioche disparaît.
  const stroke = size <= 32 ? 2.6 : size <= 64 ? 2.1 : 1.9;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${PANEL}"/>
  <g transform="translate(${pad} ${pad}) scale(${inner / 24})"
     fill="none" stroke="${ACCENT}" stroke-width="${stroke}"
     stroke-linecap="round" stroke-linejoin="round">
    ${PICKAXE.map((d) => `<path d="${d}"/>`).join('\n    ')}
  </g>
</svg>`;
}

/**
 * Rend un SVG en PNG dans une fenêtre hors écran, RÉUTILISÉE d'une taille à
 * l'autre.
 *
 * Deux détours qui n'en sont pas :
 *  - on passe par un fichier et non une URL `data:` — Chromium refuse la
 *    navigation de premier niveau vers `data:` ;
 *  - on garde UNE fenêtre. En créer puis en détruire une par taille échoue dès
 *    la deuxième (`ERR_FAILED`) dans un affichage virtuel.
 */
async function render(win, size, tmpDir) {
  const file = path.join(tmpDir, `icon-${size}.html`);
  fs.writeFileSync(file, `<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>${svg(size)}`);
  win.setContentSize(size, size);
  await win.loadFile(file);
  // Une capture prise trop tôt rend une image vide : on laisse passer une frame.
  await new Promise((r) => setTimeout(r, 150));
  const image = await win.webContents.capturePage();
  return image.toPNG();
}

/**
 * Assemble des PNG en un fichier ICO.
 *
 *   6 o    en-tête : réservé(2)=0, type(2)=1 (icône), nombre d'images(2)
 *   16 o   par image : largeur, hauteur, couleurs, réservé, plans(2),
 *          bits(2), taille des données(4), décalage(4)
 *   …      les PNG, bout à bout
 *
 * Une dimension de 256 s'écrit 0 : le champ ne fait qu'un octet.
 */
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = head.length + dir.length;
  images.forEach(({ size, png }, i) => {
    const at = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2);   // palette : aucune
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);   // plans
    dir.writeUInt16LE(32, at + 6);  // bits par pixel
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, dir, ...images.map((i) => i.png)]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'titi-icon-'));
  const win = new BrowserWindow({
    width: 256, height: 256, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  const images = [];
  try {
    for (const size of SIZES) {
      images.push({ size, png: await render(win, size, tmpDir) });
      process.stdout.write(`  ${size}×${size}\n`);
    }
  } finally {
    win.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const icoBuf = ico(images);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), icoBuf);

  // Le PNG 256 sert de source lisible, et de secours pour les cibles qui ne
  // veulent pas d'ICO (Linux, macOS).
  const big = images.find((i) => i.size === 256);
  fs.writeFileSync(path.join(OUT, 'icon.png'), big.png);
  fs.writeFileSync(path.join(OUT, 'icon.svg'), svg(256));

  // Un ICO dont une image serait vide passerait inaperçu jusqu'à l'installation.
  const vide = images.filter((i) => i.png.length < 200);
  if (vide.length) {
    console.error(`✗ ${vide.length} image(s) vides : ${vide.map((v) => v.size).join(', ')}`);
    app.exit(1);
    return;
  }

  console.log(`\nicon.ico  ${(icoBuf.length / 1024).toFixed(1)} ko, ${images.length} tailles`);
  console.log(`icon.png  ${(big.png.length / 1024).toFixed(1)} ko`);
  app.exit(0);
}).catch((err) => {
  console.error('✗ génération d’icône échouée :', err?.message || err);
  app.exit(1);
});
