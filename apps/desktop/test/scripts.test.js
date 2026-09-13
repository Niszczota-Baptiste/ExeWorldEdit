import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Toute commande citée dans un script npm doit EXISTER après un `npm install`.
//
// `npm run dev` enchaînait `concurrently`, `wait-on` et `cross-env` — trois
// paquets qui n'ont jamais figuré dans les dépendances. Sur un clone neuf,
// `npm install` se déroulait sans une seule erreur, puis la commande citée en
// tête de la documentation échouait sur « 'concurrently' n'est pas reconnu en
// tant que commande interne ou externe ». Le seul endroit où ça se voyait était
// la machine de quelqu'un qui découvrait le projet.
//
// Ça ne se rattrape pas à la relecture : un script npm est du texte, personne
// ne va vérifier à la main que chaque mot correspond à un binaire installé.
// D'où ce test, qui relit les scripts des TROIS paquets de l'espace de travail
// et refuse un exécutable introuvable.

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.join(ICI, '..', '..', '..');
const BIN = path.join(RACINE, 'node_modules', '.bin');

const PAQUETS = ['package.json', 'apps/desktop/package.json', 'packages/we-engine/package.json'];

/** Ce que le système fournit : rien à installer, rien à déclarer. */
const FOURNIS = new Set(['node', 'npm', 'npx']);

/**
 * Les exécutables appelés par une ligne de script.
 *
 * On coupe sur `&&`, `||`, `;` et `|` — chaque segment commence par sa propre
 * commande — et on ne garde que le premier mot de chacun. Ce qui suit est un
 * argument, pas un programme.
 */
function executables(ligne) {
  return ligne
    .split(/&&|\|\||[;|]/)
    .map((seg) => seg.trim().split(/\s+/)[0])
    .filter(Boolean)
    // Une affectation de variable d'environnement en tête (`FOO=bar cmd`) n'est
    // pas une commande. Aucun script n'en a aujourd'hui, et c'est voulu : sous
    // cmd ça ne marche pas.
    .filter((mot) => !mot.includes('='));
}

/** Le binaire est-il là ? Windows écrit `.cmd`, Unix un lien sans extension. */
const installe = (nom) => ['', '.cmd', '.ps1', '.exe']
  .some((ext) => fs.existsSync(path.join(BIN, nom + ext)));

test('chaque script npm n’appelle que des commandes installées', () => {
  const manquants = [];
  for (const fichier of PAQUETS) {
    const chemin = path.join(RACINE, fichier);
    const { scripts = {} } = JSON.parse(fs.readFileSync(chemin, 'utf8'));
    for (const [nom, ligne] of Object.entries(scripts)) {
      for (const exe of executables(ligne)) {
        if (FOURNIS.has(exe) || installe(exe)) continue;
        manquants.push(`${fichier} → "${nom}" appelle « ${exe} », absent de node_modules/.bin`);
      }
    }
  }
  assert.deepEqual(manquants, [], `\n${manquants.join('\n')}\n`);
});

test('un script qui pose une variable d’environnement ne marcherait pas sous cmd', () => {
  // `FOO=bar commande` est de la syntaxe de shell POSIX. cmd la prend pour un
  // nom de programme et échoue. Windows est la cible : une variable se pose
  // depuis Node (`spawn`, option `env`), jamais depuis la ligne de script.
  const fautifs = [];
  for (const fichier of PAQUETS) {
    const { scripts = {} } = JSON.parse(fs.readFileSync(path.join(RACINE, fichier), 'utf8'));
    for (const [nom, ligne] of Object.entries(scripts)) {
      for (const seg of ligne.split(/&&|\|\||[;|]/)) {
        if (/^\s*[A-Z_][A-Z0-9_]*=/.test(seg)) fautifs.push(`${fichier} → "${nom}" : ${seg.trim()}`);
      }
    }
  }
  assert.deepEqual(fautifs, []);
});

test('les scripts de l’application existent sur le disque', () => {
  // `node scripts/x.js` avec un fichier absent échoue au lancement, pas à
  // l'installation — même angle mort que ci-dessus.
  const { scripts = {} } = JSON.parse(fs.readFileSync(path.join(RACINE, 'apps/desktop/package.json'), 'utf8'));
  for (const ligne of Object.values(scripts)) {
    for (const m of ligne.matchAll(/(?:^|\s)(scripts\/[\w.-]+\.js)/g)) {
      assert.ok(
        fs.existsSync(path.join(RACINE, 'apps/desktop', m[1])),
        `${m[1]} est cité par un script npm mais n’existe pas`,
      );
    }
  }
});
