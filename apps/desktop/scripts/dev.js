// Lance Vite et Electron ensemble, sans dépendance.
//
// Le script d'origine enchaînait `concurrently`, `wait-on` et `cross-env` —
// trois paquets qui n'ont jamais figuré dans les dépendances. `npm run dev`
// échouait donc sur tout clone neuf, avec « 'concurrently' n'est pas reconnu »,
// alors que `npm install` s'était déroulé sans une erreur. Une commande citée
// dans la documentation doit marcher après un `git clone` et un `npm install`,
// sinon elle ne sert à rien.
//
// Node sait tout faire lui-même, et le résultat est MEILLEUR que les trois
// paquets réunis :
//
//   - pas de variable d'environnement à poser depuis le shell : `spawn` la
//     passe dans `env`, donc ni `cross-env` ni les règles de citation de cmd,
//     qui sont un piège déjà rencontré ici ;
//   - l'attente du serveur est une vraie tentative de connexion TCP, pas une
//     temporisation à l'aveugle ;
//   - quand l'un des deux processus s'arrête, l'autre est arrêté aussi. Sans
//     ça, fermer la fenêtre laisserait un Vite orphelin qui tient le port 5180
//     et fait échouer le lancement SUIVANT.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const RACINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5180;             // même valeur que `server.port` de vite.config.js
const HOTE = '127.0.0.1';
const ATTENTE_MAX = 60_000;

// `shell: true` sous Windows : `vite` et `electron` y sont des fichiers .cmd,
// que `spawn` ne sait pas exécuter directement. Les deux commandes sont des
// constantes de ce fichier, rien ne vient de l'extérieur.
const windows = process.platform === 'win32';
const lance = (cmd, args, env) => spawn(cmd, args, {
  cwd: RACINE,
  stdio: 'inherit',
  shell: windows,
  env: { ...process.env, ...env },
});

/** Le serveur écoute-t-il ? Une connexion qui aboutit, pas une supposition. */
const ecoute = () => new Promise((ok) => {
  const s = net.connect({ port: PORT, host: HOTE });
  const fin = (r) => { s.destroy(); ok(r); };
  s.once('connect', () => fin(true));
  s.once('error', () => fin(false));
  s.setTimeout(1000, () => fin(false));
});

const dors = (ms) => new Promise((r) => { setTimeout(r, ms); });

let arret = false;
const enfants = [];
function tueTout(code) {
  if (arret) return;
  arret = true;
  for (const p of enfants) { try { p.kill(); } catch { /* déjà mort */ } }
  process.exit(code ?? 0);
}
process.on('SIGINT', () => tueTout(0));
process.on('SIGTERM', () => tueTout(0));

const vite = lance('vite', []);
enfants.push(vite);
vite.on('exit', (code) => {
  if (!arret) console.error(`\nVite s'est arrêté (code ${code}).`);
  tueTout(code ?? 0);
});

const debut = Date.now();
while (!arret && !(await ecoute())) {
  if (Date.now() - debut > ATTENTE_MAX) {
    console.error(`\nVite n'écoute toujours pas sur ${HOTE}:${PORT} après ${ATTENTE_MAX / 1000} s.`);
    tueTout(1);
  }
  await dors(200);
}
if (arret) process.exit(0);

console.log(`\nVite écoute sur http://localhost:${PORT} — lancement d'Electron.\n`);
// Ce qui suit `--` est transmis à Electron : c'est ce qui permet
// `npm run dev -- --no-sandbox` dans un conteneur, ou d'ouvrir un fichier au
// lancement sans toucher au script.
const electron = lance('electron', ['.', ...process.argv.slice(2)], { TITI_DEV_SERVER: `http://localhost:${PORT}` });
enfants.push(electron);
electron.on('exit', (code) => tueTout(code ?? 0));
