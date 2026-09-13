/* eslint-disable security/detect-non-literal-fs-filename --
   Script de développement : la racine vient de la ligne de commande, et tout
   le reste est joint dessus à partir de noms lus dans le codex lui-même. */
// Extrait les blocs `minefield:*` du codex du site, en une archive embarquable.
//
//   node scripts/make-codex.js <chemin-vers-titisite> [sortie]
//
// Pourquoi extraire plutôt que tout prendre : le codex complet pèse 69 Mo et
// contient les modèles ET LES TEXTURES DE MINECRAFT, qu'on ne redistribue pas
// (même raison que pour le `.jar` — voir `docs/desktop.md`). Les blocs
// `minefield:*` appartiennent au serveur : eux, on peut les embarquer, et c'est
// ce qui fait qu'une chaise s'affiche en chaise sans rien installer.
//
// Le résultat est un .zip d'environ 7 Mo. Il est COMMITÉ, comme `build/icon.ico`
// : régénérable par ce script, jamais retouché à la main.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { makeZip } from '@titi/we-engine/worldedit';

const source = process.argv[2];
const sortie = process.argv[3] || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'codex-minefield.zip');
if (!source) {
  console.error('Indique le dossier de titisite : node scripts/make-codex.js <chemin> [sortie]');
  process.exit(1);
}

const CODEX = path.join(source, 'public', 'codex');
if (!fs.existsSync(path.join(CODEX, 'blockstates.json'))) {
  console.error(`Pas de codex sous ${CODEX} — est-ce bien une copie de titisite ?`);
  process.exit(1);
}

const lireJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** `minefield:block/chaise` → `block_chaise.json`, comme le fait le site. */
const refVersFichier = (ref) => `block_${String(ref).replace(/^[^:]+:/, '').replace(/^block\//, '')}.json`;

/** Tous les modèles cités par un état de bloc — variantes ET multipart. */
function modelesDe(etat) {
  const out = [];
  const premier = (a) => (Array.isArray(a) ? a[0] : a);
  if (etat?.variants) {
    for (const v of Object.values(etat.variants)) {
      const a = premier(v);
      if (a?.model) out.push(a.model);
    }
  }
  for (const part of etat?.multipart || []) {
    const a = premier(part.apply);
    if (a?.model) out.push(a.model);
  }
  return out;
}

const etats = lireJson(path.join(CODEX, 'blockstates.json'));
const gardes = {};
const modeles = new Map();
const textures = new Set();
let sansModele = 0;

for (const [id, etat] of Object.entries(etats)) {
  if (!id.startsWith('minefield:')) continue;
  gardes[id] = etat;
  for (const ref of modelesDe(etat)) {
    const fichier = refVersFichier(ref);
    if (modeles.has(fichier)) continue;
    const p = path.join(CODEX, 'render-models', fichier);
    if (!fs.existsSync(p)) { sansModele++; continue; }
    const m = lireJson(p);
    modeles.set(fichier, m);
    for (const t of Object.values(m.textures || {})) {
      if (typeof t === 'string' && !t.startsWith('#')) textures.add(t);
    }
  }
}

const entrees = [
  // Les blockstates sont réécrits sans les blocs vanilla : un tiers du fichier
  // d'origine, et surtout aucune ambiguïté sur ce que cette archive couvre.
  { name: 'blockstates.json', data: Buffer.from(JSON.stringify(gardes)) },
];
for (const [nom, m] of modeles) entrees.push({ name: `render-models/${nom}`, data: Buffer.from(JSON.stringify(m)) });

let sansTexture = 0;
for (const t of textures) {
  const p = path.join(CODEX, 'render-textures', t);
  if (!fs.existsSync(p)) { sansTexture++; continue; }
  entrees.push({ name: `render-textures/${t}`, data: fs.readFileSync(p) });
}

const zip = makeZip(entrees);
fs.mkdirSync(path.dirname(sortie), { recursive: true });
fs.writeFileSync(sortie, zip);

console.log(`codex minefield écrit : ${sortie}`);
console.log(`  ${Object.keys(gardes).length} blocs, ${modeles.size} modèles, ${textures.size} textures`);
console.log(`  ${(zip.length / 1e6).toFixed(1)} Mo`);
if (sansModele) console.log(`  ${sansModele} modèles cités mais introuvables`);
if (sansTexture) console.log(`  ${sansTexture} textures citées mais introuvables`);
