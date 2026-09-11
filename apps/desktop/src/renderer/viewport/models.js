// Les blocs qui NE SONT PAS des cubes, préparés une fois pour le mailleur.
//
// Le mailleur greedy ne sait rendre que des cubes pleins : il travaille sur une
// grille d'identifiants, et un identifiant n'a pas de forme. Un escalier, une
// dalle, une chaise `minefield:*` y passaient donc en cube plein — une volée
// d'escaliers s'affichait comme un mur, et c'est précisément la géométrie qu'on
// voulait vérifier à l'œil.
//
// Ce module traduit les cuboïdes d'un modèle (unités 0..16, Minecraft autorise
// −16 à 32) en QUADS prêts à poser, une fois par palette. Le mailleur n'a plus
// qu'à les translater sur la position du bloc. Faire ce calcul par voxel
// coûterait le même travail des milliers de fois pour un résultat identique.
//
// Module PUR : aucun DOM, aucun three.js, aucun canvas — donc testable dans
// Node. C'est le même choix que `mesher.js`, et pour la même raison : une
// géométrie qu'on ne peut vérifier qu'à l'œil dans une fenêtre est une
// géométrie qu'on ne vérifie pas.

/** L'ordre du mailleur : `d * 2 + (front ? 1 : 0)` — −X +X −Y +Y −Z +Z. */
export const FACES = ['west', 'east', 'down', 'up', 'north', 'south'];

/** Axe de la normale de chaque face, et son sens. */
const NORMALE = [
  [0, -1], [0, +1],
  [1, -1], [1, +1],
  [2, -1], [2, +1],
];

const U = 16; // unités de modèle par bloc

/**
 * Repère d'une face : d'où part le quad, dans quelle direction va le `u` de la
 * texture, dans quelle direction va son `v` — et les uv DÉDUITS quand le modèle
 * n'en déclare pas.
 *
 * Les uv déduits ne sont pas un détail cosmétique : c'est ce qui fait qu'une
 * dalle montre la moitié BASSE de sa texture et non la texture entière écrasée
 * sur quatre pixels de haut. Le `v` de Minecraft descend depuis le haut, d'où
 * les `16 −` sur les faces verticales.
 *
 * @param {number} f indice de face
 * @param {number[]} a coin bas du cuboïde, unités de modèle
 * @param {number[]} b coin haut
 */
function repere(f, a, b) {
  const [x1, y1, z1] = a;
  const [x2, y2, z2] = b;
  switch (f) {
    case 0: // west, −X
      return { o: [x1, y2, z1], du: [0, 0, z2 - z1], dv: [0, y1 - y2, 0], uv: [z1, U - y2, z2, U - y1] };
    case 1: // east, +X
      return { o: [x2, y2, z2], du: [0, 0, z1 - z2], dv: [0, y1 - y2, 0], uv: [U - z2, U - y2, U - z1, U - y1] };
    case 2: // down, −Y
      return { o: [x1, y1, z2], du: [x2 - x1, 0, 0], dv: [0, 0, z1 - z2], uv: [x1, z1, x2, z2] };
    case 3: // up, +Y
      return { o: [x1, y2, z1], du: [x2 - x1, 0, 0], dv: [0, 0, z2 - z1], uv: [x1, z1, x2, z2] };
    case 4: // north, −Z
      return { o: [x2, y2, z1], du: [x1 - x2, 0, 0], dv: [0, y1 - y2, 0], uv: [U - x2, U - y2, U - x1, U - y1] };
    default: // south, +Z
      return { o: [x1, y2, z2], du: [x2 - x1, 0, 0], dv: [0, y1 - y2, 0], uv: [x1, U - y2, x2, U - y1] };
  }
}

const croix = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Le quad regarde-t-il DEHORS ?
 *
 * Mesuré et non transcrit : on calcule `du × dv` et on le compare à la normale
 * attendue de la face. Recopier à la main l'ordre d'enroulement des six faces,
 * c'est six occasions de se tromper — et une face à l'envers ne se voit pas
 * tant qu'on ne tourne pas autour du bloc.
 */
function endroit(f, du, dv) {
  const [axe, sens] = NORMALE[f];
  return croix(du, dv)[axe] * sens > 0;
}

/**
 * Prépare les quads d'un bloc-modèle.
 *
 * @param {{from:number[], to:number[], faces:Record<string, {texture:string, uv:number[]|null}>}[]} boxes
 * @param {(src:string) => number} coucheDe texture → couche d'atlas
 * @returns {{pos:Float32Array, uv:Float32Array, layer:Uint16Array, face:Uint8Array, cull:Uint8Array, flip:Uint8Array, count:number}|null}
 *   `pos` : 4 coins × 3 en unités de BLOC (0..1), à translater sur le voxel.
 *   `cull` : indice de la face voisine capable de cacher ce quad, 255 sinon.
 */
export function prepareModele(boxes, coucheDe) {
  const pos = [];
  const uvs = [];
  const layer = [];
  const face = [];
  const cull = [];
  const flip = [];

  for (const box of boxes || []) {
    const a = box.from, b = box.to;
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    for (let f = 0; f < 6; f++) {
      const decl = box.faces?.[FACES[f]];
      if (!decl) continue;
      const { o, du, dv, uv } = repere(f, a, b);
      const r = Array.isArray(decl.uv) && decl.uv.length === 4 ? decl.uv : uv;

      // Les quatre coins, dans l'ordre (0,0) (1,0) (1,1) (0,1) du repère de la
      // texture — d'où la correspondance directe avec le rectangle uv.
      const coins = [
        [0, 0], [1, 0], [1, 1], [0, 1],
      ];
      for (const [cu, cv] of coins) {
        pos.push(
          (o[0] + du[0] * cu + dv[0] * cv) / U,
          (o[1] + du[1] * cu + dv[1] * cv) / U,
          (o[2] + du[2] * cu + dv[2] * cv) / U,
        );
        // En tuiles : le nuanceur échantillonne `fract(uv)` d'une couche de
        // 16 × 16, donc une coordonnée de texture vaut son pixel divisé par 16.
        uvs.push((cu ? r[2] : r[0]) / U, (cv ? r[3] : r[1]) / U);
      }
      layer.push(coucheDe(decl.texture) | 0);
      face.push(f);
      flip.push(endroit(f, du, dv) ? 0 : 1);

      // Une face ne peut être cachée que si elle est À RAS du bord du bloc :
      // l'assise d'une chaise flotte au milieu, rien ne la cache jamais.
      const [axe, sens] = NORMALE[f];
      const plat = sens < 0 ? a[axe] === 0 : b[axe] === U;
      cull.push(plat ? f : 255);
    }
  }

  if (!face.length) return null;
  return {
    pos: new Float32Array(pos),
    uv: new Float32Array(uvs),
    layer: new Uint16Array(layer),
    face: new Uint8Array(face),
    cull: new Uint8Array(cull),
    flip: new Uint8Array(flip),
    count: face.length,
  };
}

/**
 * La table `identifiant de voxel → quads`, et la liste des blocs à retirer des
 * opaques.
 *
 * Un bloc-modèle ne CACHE pas ce qu'il y a derrière : laissé opaque, il
 * supprimait les faces de ses voisins et un escalier creusait un trou dans le
 * mur qu'il touche. Il ne participe pas non plus à l'occlusion ambiante, pour
 * la même raison.
 *
 * L'identifiant d'un voxel est l'indice de palette **plus un** (0 = air) : une
 * table indexée sur la palette décalerait tout d'un cran, et chaque bloc
 * prendrait la forme de son voisin.
 *
 * @param {{name:string}[]} palette
 * @param {Record<string, {kind:string, boxes:object[]}>} formes
 * @param {(src:string) => number} coucheDe
 */
export function tableDesFormes(palette, formes, coucheDe) {
  const shapes = new Array(palette.length + 1).fill(null);
  const transparents = [];
  let modeles = 0;
  for (let i = 0; i < palette.length; i++) {
    const forme = formes?.[palette[i]?.name];
    if (!forme || forme.kind !== 'model') continue;
    const prep = prepareModele(forme.boxes, coucheDe);
    if (!prep) continue;
    shapes[i + 1] = prep;
    transparents.push(i + 1);
    modeles++;
  }
  return { shapes: modeles ? shapes : null, transparents, modeles };
}

/**
 * Les six textures des blocs CUBES, pour l'atlas.
 *
 * L'atlas ne s'occupe que des cubes : les faces d'un modèle portent leur couche
 * dans leurs quads, calculée ici même. Les deux lisent le même `planModele`,
 * donc un bloc ne peut pas être un cube pour l'un et un modèle pour l'autre.
 */
export function facesDesCubes(formes) {
  const out = {};
  for (const [nom, forme] of Object.entries(formes || {})) {
    if (forme?.kind !== 'model') {
      const f = forme?.boxes?.[0]?.faces;
      if (!f) continue;
      const six = {};
      for (const nomFace of FACES) if (f[nomFace]?.texture) six[nomFace] = f[nomFace].texture;
      if (Object.keys(six).length) out[nom] = six;
    }
  }
  return out;
}

/**
 * Toutes les textures citées par les faces de MODÈLE, sans doublon.
 *
 * L'atlas les charge en même temps que celles des cubes : elles doivent vivre
 * dans la même texture-tableau, sinon il faudrait un second matériau — donc un
 * appel de dessin de plus par chunk, pour rien.
 */
export function sourcesDesModeles(formes) {
  const vues = new Set();
  for (const forme of Object.values(formes || {})) {
    if (forme?.kind !== 'model') continue;
    for (const box of forme.boxes || []) {
      for (const decl of Object.values(box.faces || {})) {
        if (decl?.texture) vues.add(decl.texture);
      }
    }
  }
  return [...vues];
}
