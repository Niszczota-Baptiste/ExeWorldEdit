import * as THREE from 'three';

// L'ATLAS : les textures du pack, empilées en une seule texture-tableau, et le
// matériau qui sait y piocher.
//
// Pourquoi une texture-TABLEAU (`DataArrayTexture`) et pas une planche d'atlas
// classique : le maillage est greedy, donc un quad couvre plusieurs blocs et sa
// texture doit se RÉPÉTER. Sur une planche, répéter déborde sur la tuile
// voisine — c'est le défaut classique des atlas, une frange de la mauvaise
// texture au bord de chaque face. Avec un tableau, chaque tuile est une couche
// indépendante : `fract(uv)` répète sans jamais sortir de la sienne.
//
// La couche 0 est BLANCHE. Un bloc sans texture s'y retrouve, et le produit
// avec sa couleur de sommet redonne exactement le rendu d'avant. Pas de
// branchement dans le nuanceur, pas de second matériau, pas de deuxième passe.

export const TUILE = 16;

/** Rend une image dans une tuile de 16 × 16, RGBA. */
function tuileDe(img) {
  const c = document.createElement('canvas');
  c.width = TUILE;
  c.height = TUILE;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  // Une texture ANIMÉE est une bande verticale : 16 de large, 16 × N de haut.
  // On prend la première image — la largeur donne la taille d'une case, et
  // étirer la bande entière sur une tuile donnerait une bouillie.
  const cote = Math.min(img.width, img.height) || TUILE;
  ctx.drawImage(img, 0, 0, cote, cote, 0, 0, TUILE, TUILE);
  return ctx.getImageData(0, 0, TUILE, TUILE).data;
}

async function charge(src) {
  const img = new Image();
  await new Promise((ok, ko) => { img.onload = ok; img.onerror = ko; img.src = src; });
  return img;
}

/**
 * Les six faces dans l'ordre du mailleur : `d * 2 + (front ? 1 : 0)`, donc la
 * face NÉGATIVE de chaque axe d'abord — −X +X −Y +Y −Z +Z.
 *
 * L'ordre a été MESURÉ, pas déduit d'un commentaire : celui du mailleur disait
 * « +Y −Y » et se trompait, ce qui mettait la texture du dessous sur le dessus
 * des blocs. Un terrain d'herbe ressortait en terre.
 */
export const FACES = ['west', 'east', 'down', 'up', 'north', 'south'];

/**
 * La table `id * 6 + face → couche`.
 *
 * L'INDEXATION est la seule chose difficile ici, et elle se trompe en silence :
 * l'identifiant d'un voxel est l'indice de palette **plus un**, parce que 0 est
 * réservé à l'air (`buildTables`, blockColors.js). Une table indexée sur la
 * palette décale tout d'un cran — chaque bloc prend la texture de son voisin,
 * et l'herbe sort en pierre. Vu à l'écran avant d'être vu dans le code.
 *
 * `coucheDe` est injecté pour que cette fonction se teste sans navigateur :
 * charger une image demande un canvas, décider d'un numéro de couche non.
 *
 * @param {{name:string}[]} palette palette de l'aperçu
 * @param {Record<string, Record<string,string>>} faces nom de bloc → face → source
 * @param {(src:string) => Promise<number>} coucheDe
 */
export async function atlasLayers(palette, faces, coucheDe) {
  // `+ 1` : la case 0 est celle de l'air, que le mailleur n'émet jamais.
  const layers = new Uint16Array((palette.length + 1) * 6);
  for (let i = 0; i < palette.length; i++) {
    const f = faces[palette[i]?.name];
    if (!f) continue;
    for (let k = 0; k < 6; k++) {
      // Séquentiel, et c'est voulu : c'est l'ORDRE des appels qui fixe le
      // numéro des couches. En parallèle, deux exécutions donneraient deux
      // atlas différents — et le cache rend la plupart des tours immédiats.
      layers[(i + 1) * 6 + k] = await coucheDe(f[FACES[k]]);
    }
  }
  return layers;
}

/**
 * Construit la texture-tableau et sa table de couches.
 *
 * @param {{name:string}[]} palette palette de l'aperçu, dans l'ordre des ids
 * @param {Record<string, Record<string,string>>} faces nom de bloc → face → `data:`
 * @param {string[]} [extras] textures à charger EN PLUS : celles des faces de
 *   modèle, qui ne passent pas par la table `id * 6 + face` mais doivent vivre
 *   dans le même atlas. Un second atlas voudrait un second matériau, donc un
 *   appel de dessin de plus par chunk.
 * @returns {Promise<{texture, layers, count, coucheDe: (src:string) => number}>}
 *   `coucheDe` est SYNCHRONE : tout est déjà chargé quand il est rendu.
 */
export async function buildAtlas(palette, faces, extras = []) {
  // Couche 0 : blanche, le neutre du produit.
  const tuiles = [new Uint8ClampedArray(TUILE * TUILE * 4).fill(255)];
  const parSource = new Map();

  // Une même texture sert des dizaines de blocs et plusieurs faces : on ne la
  // décode qu'une fois. Sans ça, un build ordinaire décoderait le même
  // `stone.png` deux cents fois.
  const coucheDe = async (src) => {
    if (!src) return 0;
    if (parSource.has(src)) return parSource.get(src);
    let n;
    try {
      tuiles.push(tuileDe(await charge(src)));
      n = tuiles.length - 1;
    } catch { n = 0; } // texture illisible : blanc, donc la couleur d'avant
    parSource.set(src, n);
    return n;
  };

  const layers = await atlasLayers(palette, faces, coucheDe);
  // Séquentiel comme ci-dessus, et pour la même raison : c'est l'ORDRE des
  // appels qui fixe le numéro des couches.
  for (const src of extras) await coucheDe(src);

  const data = new Uint8Array(TUILE * TUILE * 4 * tuiles.length);
  tuiles.forEach((t, i) => data.set(t, i * TUILE * TUILE * 4));

  const texture = new THREE.DataArrayTexture(data, TUILE, TUILE, tuiles.length);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  // Au plus près : une texture de 16 px lissée devient une bouillie, et c'est
  // précisément l'aspect qu'on veut garder.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  return { texture, layers, count: tuiles.length, coucheDe: (src) => parSource.get(src) || 0 };
}

/**
 * Le matériau : couleur de sommet × texture de la couche.
 *
 * On greffe sur `MeshBasicMaterial` plutôt que d'écrire un nuanceur complet —
 * le brouillard, les couleurs de sommet et la gestion d'espace colorimétrique
 * de three sont déjà là, et les refaire à la main est le meilleur moyen de
 * délaver le build une deuxième fois.
 */
export function makeAtlasMaterial(texture) {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  material.userData.atlas = { value: texture };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.atlas = material.userData.atlas;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 tileUv;
        attribute float tileLayer;
        varying vec2 vTileUv;
        varying float vTileLayer;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTileUv = tileUv;
        vTileLayer = tileLayer;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray atlas;
        varying vec2 vTileUv;
        varying float vTileLayer;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // fract() répète la tuile sur un quad greedy sans jamais sortir de sa
        // couche — c'est tout l'intérêt d'une texture-tableau.
        diffuseColor *= texture(atlas, vec3(fract(vTileUv), vTileLayer));`);
  };
  // Deux matériaux au nuanceur greffé différemment doivent être recompilés
  // séparément : sans clé distincte, three réutilise le programme du premier.
  material.customProgramCacheKey = () => 'titi-atlas-v1';
  return material;
}
