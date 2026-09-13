// Le CODEX du site `titisite`, lu comme une source de modèles.
//
// Le site publie ses blocs sous une forme déjà APLATIE : plus de chaîne de
// `parent` à remonter, plus de variables de texture à résoudre d'un fichier à
// l'autre. Un état de bloc désigne un modèle, le modèle porte ses cuboïdes et
// des noms de fichiers directs.
//
//   blockstates.json                 id de bloc → modèle (variants / multipart)
//   render-models/block_<nom>.json   { textures: {clé: 'fichier.png'}, elements }
//   render-textures/<fichier>.png    l'image
//
// C'est la SEULE façon d'avoir les blocs `minefield:*` sans demander à
// l'utilisateur d'installer quoi que ce soit : ils appartiennent au serveur,
// donc on peut les embarquer — contrairement aux assets de Minecraft, qui
// restent lus depuis l'installation de l'utilisateur (voir `docs/desktop.md`).
//
// Ce module rend EXACTEMENT le même contrat que `planModele` / `planIcone` de
// `resourcePack.js`. C'est ce qui permet à l'appelant d'essayer l'un puis
// l'autre sans savoir lequel a répondu.

import { zipIndex, zipRead } from './zipReader.js';
import { FACES_CUBE, FACES_VUES, indiceCubePlein, resoutTexture } from './resourcePack.js';

/** `minefield:block/chaise` → `block_chaise.json`. La règle est celle du site. */
export const refVersFichier = (ref) => `block_${String(ref ?? '').replace(/^[^:]+:/, '').replace(/^block\//, '')}.json`;

/**
 * Ouvre une archive de codex. Tout est lu à la demande : l'archive fait
 * plusieurs mégaoctets et une session n'en regarde qu'une poignée d'entrées.
 *
 * @param {Buffer} buffer contenu du .zip
 * @throws {Error} `codex_invalid`
 */
export function ouvreCodex(buffer) {
  let index;
  try { index = zipIndex(buffer); } catch { throw new Error('codex_invalid'); }

  const cacheJson = new Map();
  const lireJson = (nom) => {
    if (cacheJson.has(nom)) return cacheJson.get(nom);
    let v = null;
    try {
      const b = zipRead(buffer, index, nom);
      if (b) v = JSON.parse(b.toString('utf8'));
    } catch { v = null; } // entrée absente ou illisible : le bloc n'existe pas, c'est tout
    cacheJson.set(nom, v);
    return v;
  };

  const etats = lireJson('blockstates.json') || {};
  return {
    /** Les identifiants déclarés — c'est aussi la liste des blocs du serveur. */
    ids: () => Object.keys(etats),
    etat: (id) => etats[id] || null,
    modele: (ref) => lireJson(`render-models/${refVersFichier(ref)}`),
    /** Le chemin d'une texture DANS l'archive, pour que l'appelant la lise. */
    cheminTexture: (fichier) => `render-textures/${fichier}`,
    lire: (chemin) => { try { return zipRead(buffer, index, chemin); } catch { return null; } },
    taille: index.size,
  };
}

const premier = (a) => (Array.isArray(a) ? a[0] : a);

/**
 * Le modèle désigné par l'état par défaut d'un bloc, ou `null`.
 *
 * On prend la PREMIÈRE variante, comme le fait `modeleDuBloc` pour un pack : un
 * bloc a autant de variantes que d'états, et on n'en affiche qu'une.
 */
export function modeleDuBlocCodex(codex, id) {
  const etat = codex.etat(id);
  if (!etat) return null;
  if (etat.variants) {
    const v = premier(Object.values(etat.variants)[0]);
    return v?.model || null;
  }
  for (const part of etat.multipart || []) {
    const a = premier(part.apply);
    if (a?.model) return a.model;
  }
  return null;
}

/** Résout `#clé` ou un nom de fichier direct vers le chemin dans l'archive. */
function textureDe(codex, textures, ref) {
  if (typeof ref !== 'string') return null;
  const nom = ref.startsWith('#') ? resoutTexture(textures, ref.slice(1)) : ref;
  return nom ? codex.cheminTexture(nom) : null;
}

/**
 * La géométrie complète d'un bloc du codex.
 *
 * Même contrat que `planModele` (`resourcePack.js`), y compris `tint` : les
 * textures teintées du codex sont grises comme celles du jeu.
 *
 * @returns {{kind:'cube'|'model', boxes:object[]}|null}
 */
export function planModeleCodex(codex, id) {
  const ref = modeleDuBlocCodex(codex, id);
  if (!ref) return null;
  const m = codex.modele(ref);
  const elements = m?.elements;
  if (!Array.isArray(elements) || !elements.length) return null;
  const textures = m.textures || {};

  // Repli, dans l'ordre où les modèles déclarent leurs textures.
  let defaut = null;
  for (const cle of ['all', 'texture', 'side', 'end', 'top', 'particle']) {
    defaut = resoutTexture(textures, cle);
    if (defaut) break;
  }

  // Un cuboïde qui remplit le bloc en fait un cube, quoi qu'on pose dessus.
  const plein = indiceCubePlein(elements);
  const utiles = plein >= 0 ? [elements[plein]] : elements;

  const boxes = [];
  for (const e of utiles) {
    if (!Array.isArray(e.from) || !Array.isArray(e.to)) continue;
    const faces = {};
    for (const f of FACES_CUBE) {
      const decl = e.faces?.[f];
      // Une face non déclarée n'existe pas : c'est ainsi qu'un modèle cache son
      // intérieur. On ne comble que si le cuboïde ne déclare aucune face.
      if (!decl && e.faces) continue;
      const chemin = textureDe(codex, textures, decl?.texture)
        || textureDe(codex, textures, `#${f}`)
        || (defaut ? codex.cheminTexture(defaut) : null);
      if (!chemin) continue;
      faces[f] = {
        texture: chemin,
        uv: Array.isArray(decl?.uv) && decl.uv.length === 4 ? decl.uv.map(Number) : null,
        rotation: Number(decl?.rotation) || 0,
        tint: decl?.tintindex != null,
      };
    }
    if (Object.keys(faces).length) boxes.push({ from: e.from.map(Number), to: e.to.map(Number), faces });
  }
  if (!boxes.length) return null;
  return { kind: plein >= 0 ? 'cube' : 'model', boxes };
}

/**
 * Ce qu'il faut pour dessiner l'ICÔNE d'un bloc du codex — trois faces suffisent
 * en projection isométrique. Même contrat que `planIcone`.
 *
 * @returns {{kind:'cube'|'model', elements:object[], textures:Record<string,string>}|null}
 */
export function planIconeCodex(codex, id) {
  const ref = modeleDuBlocCodex(codex, id);
  if (!ref) return null;
  const m = codex.modele(ref);
  const elements = m?.elements;
  if (!Array.isArray(elements) || !elements.length) return null;
  const textures = m.textures || {};

  // Seules les textures RÉELLEMENT citées par les faces visibles : le codex en
  // contient quinze cents, et une icône n'en regarde que trois.
  const utiles = {};
  for (const e of elements) {
    for (const f of FACES_VUES) {
      const t = e.faces?.[f]?.texture;
      const chemin = textureDe(codex, textures, t);
      if (chemin) utiles[t] = chemin;
    }
  }
  for (const cle of ['all', 'texture', 'side', 'top', 'end', 'particle']) {
    const nom = resoutTexture(textures, cle);
    if (nom) { utiles[`#${cle}`] = codex.cheminTexture(nom); break; }
  }
  if (!Object.keys(utiles).length) return null;

  return { kind: indiceCubePlein(elements) >= 0 ? 'cube' : 'model', elements, textures: utiles };
}
