// Mailleur de chunk — greedy meshing avec occlusion ambiante par sommet.
//
// Module PUR, sans rien de spécifique au worker : c'est ce qui permet de le
// tester dans Node sans navigateur. Le worker n'est qu'un guichet par-dessus.
//
// Reçoit un bloc PADDÉ 18³ d'identifiants (16³ du chunk + une couche de voisins
// sur chaque face) en ArrayBuffer transféré : zéro copie, et surtout aucun
// besoin d'isolation cross-origin. La couche de padding sert deux fois — à
// supprimer les faces cachées par le chunk d'à côté, et à calculer une
// occlusion ambiante correcte jusqu'au bord.
//
// La passe gloutonne ne traite que les CUBES PLEINS — elle travaille sur une
// grille d'identifiants, et un identifiant n'a pas de forme. Escaliers, dalles
// et chaises `minefield:*` passent par une SECONDE passe, qui pose les quads
// préparés par `models.js` sur chaque voxel concerné. Les deux remplissent le
// même tampon : un seul maillage, un seul appel de dessin par chunk.

export const P = 18;           // côté du bloc paddé
const PAD = 1;
const CH = 16;          // côté du chunk

const pIdx = (x, y, z) => ((y + PAD) * P + (z + PAD)) * P + (x + PAD);

// Ombrage par direction de face, façon Minecraft : le haut prend la lumière,
// le dessous la perd, et les deux axes horizontaux se distinguent pour que les
// arêtes d'un mur restent lisibles.
//
// L'ORDRE est `d * 2 + (front ? 1 : 0)`, donc la face NÉGATIVE de chaque axe
// vient en premier : −X +X −Y +Y −Z +Z. Le commentaire d'origine annonçait
// « +Y −Y » et la table suivait : le dessous des blocs était éclairé à plein et
// le dessus assombri. Ça ne saute pas aux yeux sur un build gris, mais un
// terrain en terrasses montrait bien ses marches plus claires que ses plats.
const FACE_SHADE = [0.80, 0.80, 0.52, 1.00, 0.66, 0.66]; // −X +X −Y +Y −Z +Z
const AO_LEVELS = [0.46, 0.66, 0.84, 1.00];

/** Occlusion d'un coin : deux côtés pleins qui se rejoignent = coin le plus sombre. */
function cornerAO(side1, side2, corner) {
  if (side1 && side2) return 0;
  return 3 - (side1 + side2 + corner);
}

/**
 * @param {Uint16Array} ids 18³ d'identifiants de palette (0 = air)
 * @param {Uint8Array} opaque table id → 1 si le bloc cache ce qu'il y a derrière
 * @param {Uint8Array} colors table id*3 → rgb
 * @param {Uint16Array} [layers] table `id * 6 + face` → couche de l'atlas.
 *   Absente, tout va sur la couche 0 — qui est BLANCHE, donc le produit avec la
 *   couleur de sommet redonne exactement le rendu sans textures. Pas de
 *   branchement dans le nuanceur, pas de second matériau.
 * @param {(object|null)[]} [shapes] table `id` → quads d'un bloc non-cube
 *   (`models.js`), ou `null`. Ces blocs doivent être NON opaques dans `opaque`,
 *   sinon la passe gloutonne leur dessine un cube par-dessus.
 */
export function meshChunk(ids, opaque, colors, layers, shapes) {
  const positions = [];
  const shades = [];
  const rgb = [];
  const indices = [];
  // UV et couche : deux attributs de plus par sommet. Les UV vont de 0 à la
  // TAILLE du quad — un quad greedy couvre plusieurs blocs, et c'est la
  // répétition de la texture qui doit suivre, pas son étirement.
  const uv = [];
  const lay = [];

  const at = (x, y, z) => ids[pIdx(x, y, z)];
  const solid = (x, y, z) => opaque[ids[pIdx(x, y, z)]];

  // d = axe de la normale ; u, v = axes du plan de coupe.
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const q = [0, 0, 0];
    q[d] = 1;

    // Un masque par tranche : chaque case porte le bloc visible et son AO.
    const mask = new Int32Array(CH * CH);
    const maskAO = new Uint8Array(CH * CH * 4);
    const pos = [0, 0, 0];

    for (let slice = -1; slice < CH; slice++) {
      let n = 0;
      for (let j = 0; j < CH; j++) {
        for (let i = 0; i < CH; i++, n++) {
          pos[d] = slice; pos[u] = i; pos[v] = j;
          const a = at(pos[0], pos[1], pos[2]);
          const aSolid = opaque[a];
          pos[d] = slice + 1;
          const b = at(pos[0], pos[1], pos[2]);
          const bSolid = opaque[b];

          // Une face n'existe qu'entre un plein et un vide.
          if (aSolid === bSolid) { mask[n] = 0; continue; }

          const front = aSolid === 1;         // la face regarde vers +d
          const id = front ? a : b;
          // Signe : positif = normale vers +d, négatif = vers -d.
          mask[n] = front ? id : -id;

          // AO : on échantillonne les 8 voisins dans le plan de la face, du
          // côté vide (c'est de là que vient la lumière).
          const base = [0, 0, 0];
          base[d] = front ? slice + 1 : slice;
          const du = [0, 0, 0]; du[u] = 1;
          const dv = [0, 0, 0]; dv[v] = 1;
          const sample = (su, sv) => {
            const p = [base[0], base[1], base[2]];
            p[u] += su; p[v] += sv;
            return solid(p[0], p[1], p[2]) ? 1 : 0;
          };
          base[u] = i; base[v] = j;
          const s00 = sample(-1, 0), s01 = sample(0, -1), s0c = sample(-1, -1);
          const s10 = sample(1, 0), s11 = sample(0, 1), s1c = sample(1, 1);
          const sc0 = sample(1, -1), sc1 = sample(-1, 1);
          maskAO[n * 4 + 0] = cornerAO(s00, s01, s0c);
          maskAO[n * 4 + 1] = cornerAO(s10, s01, sc0);
          maskAO[n * 4 + 2] = cornerAO(s10, s11, s1c);
          maskAO[n * 4 + 3] = cornerAO(s00, s11, sc1);
        }
      }

      // Fusion gloutonne : on agrandit d'abord en largeur, puis en hauteur,
      // tant que le bloc ET les quatre valeurs d'AO sont identiques. Fusionner
      // sur le seul bloc raboterait les dégradés d'occlusion.
      n = 0;
      for (let j = 0; j < CH; j++) {
        for (let i = 0; i < CH;) {
          const m = mask[n];
          if (m === 0) { i++; n++; continue; }

          const sameAt = (k) => {
            if (mask[k] !== m) return false;
            for (let c = 0; c < 4; c++) if (maskAO[k * 4 + c] !== maskAO[n * 4 + c]) return false;
            return true;
          };

          let w = 1;
          while (i + w < CH && sameAt(n + w)) w++;
          let h = 1;
          outer:
          while (j + h < CH) {
            for (let k = 0; k < w; k++) if (!sameAt(n + k + h * CH)) break outer;
            h++;
          }

          const front = m > 0;
          const id = Math.abs(m);
          const face = d * 2 + (front ? 1 : 0);
          emitQuad({
            positions, shades, rgb, uv, lay, indices, colors, layers,
            d, u, v, i, j, w, h,
            base: slice + 1,
            front, id, face,
            ao: [maskAO[n * 4], maskAO[n * 4 + 1], maskAO[n * 4 + 2], maskAO[n * 4 + 3]],
          });

          for (let hh = 0; hh < h; hh++) for (let ww = 0; ww < w; ww++) mask[n + ww + hh * CH] = 0;
          i += w;
          n += w;
        }
      }
    }
  }

  if (shapes) {
    emitModels({ positions, rgb, uv, lay, indices, colors, shapes, at, solid });
  }

  return {
    positions: new Float32Array(positions),
    colors: new Uint8Array(rgb),
    uv: new Float32Array(uv),
    layers: new Uint16Array(lay),
    indices: new Uint32Array(indices),
    quads: indices.length / 6,
    shades,
  };
}

function emitQuad({ positions, rgb, uv, lay, indices, colors, layers, d, u, v, i, j, w, h, base, front, id, face, ao }) {
  const p = [0, 0, 0];
  p[d] = base; p[u] = i; p[v] = j;
  const du = [0, 0, 0]; du[u] = w;
  const dv = [0, 0, 0]; dv[v] = h;

  const start = positions.length / 3;
  const corners = [
    [p[0], p[1], p[2]],
    [p[0] + du[0], p[1] + du[1], p[2] + du[2]],
    [p[0] + du[0] + dv[0], p[1] + du[1] + dv[1], p[2] + du[2] + dv[2]],
    [p[0] + dv[0], p[1] + dv[1], p[2] + dv[2]],
  ];
  for (const c of corners) positions.push(c[0], c[1], c[2]);

  // UV en unités de BLOC : le nuanceur répète la texture par `fract`, donc un
  // quad de 5 × 3 blocs montre cinq fois trois tuiles au lieu d'une étirée.
  uv.push(0, 0, w, 0, w, h, 0, h);
  const couche = layers ? layers[id * 6 + face] : 0;
  for (let c = 0; c < 4; c++) lay.push(couche);

  const shade = FACE_SHADE[face];
  // Quand une TEXTURE couvre la face, la couleur de sommet ne porte plus que
  // l'ombrage. Sinon la couleur du bloc est appliquée deux fois — une fois
  // comme teinte de repli, une fois dans la texture — et tout le build sort
  // deux fois trop sombre. Vu sur la première comparaison avant/après.
  const texture = couche !== 0;
  const r = texture ? 255 : colors[id * 3];
  const g = texture ? 255 : colors[id * 3 + 1];
  const b = texture ? 255 : colors[id * 3 + 2];
  for (let c = 0; c < 4; c++) {
    const k = shade * AO_LEVELS[ao[c]];
    rgb.push(Math.min(255, r * k) | 0, Math.min(255, g * k) | 0, Math.min(255, b * k) | 0);
  }

  // Le quad est coupé selon sa diagonale la moins contrastée, sinon un coin
  // sombre « bave » en diagonale sur toute la face.
  const flip = ao[0] + ao[2] > ao[1] + ao[3];
  const [a0, a1, a2, a3] = [start, start + 1, start + 2, start + 3];
  const tri = flip
    ? [a1, a2, a3, a1, a3, a0]
    : [a0, a1, a2, a0, a2, a3];
  // L'ordre d'enroulement dépend du sens de la normale.
  if (front) indices.push(...tri);
  else indices.push(tri[2], tri[1], tri[0], tri[5], tri[4], tri[3]);
}

/** Décalage du voisin de chaque face, dans l'ordre −X +X −Y +Y −Z +Z. */
const VOISIN = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];

/**
 * Seconde passe : les blocs qui ne sont pas des cubes.
 *
 * Leurs quads sont déjà calculés une fois pour toute la palette (`models.js`) ;
 * ici on ne fait que les translater sur chaque voxel et jeter ceux qu'un voisin
 * cache. Le calcul par voxel serait le même travail répété des milliers de fois
 * pour un résultat identique.
 *
 * Pas d'occlusion ambiante sur ces quads. L'AO du mailleur s'échantillonne dans
 * le PLAN d'une face de cube ; une face de modèle est n'importe où dans le
 * bloc, et l'y appliquer donnerait des dégradés faux — mieux vaut pas d'ombre
 * du tout qu'une ombre au mauvais endroit.
 */
function emitModels({ positions, rgb, uv, lay, indices, colors, shapes, at, solid }) {
  for (let y = 0; y < CH; y++) {
    for (let z = 0; z < CH; z++) {
      for (let x = 0; x < CH; x++) {
        const id = at(x, y, z);
        const forme = id && shapes[id];
        if (!forme) continue;

        for (let q = 0; q < forme.count; q++) {
          const cache = forme.cull[q];
          if (cache !== 255) {
            const [dx, dy, dz] = VOISIN[cache];
            if (solid(x + dx, y + dy, z + dz)) continue;
          }

          const start = positions.length / 3;
          for (let c = 0; c < 4; c++) {
            positions.push(
              x + forme.pos[q * 12 + c * 3],
              y + forme.pos[q * 12 + c * 3 + 1],
              z + forme.pos[q * 12 + c * 3 + 2],
            );
            uv.push(forme.uv[q * 8 + c * 2], forme.uv[q * 8 + c * 2 + 1]);
          }

          const couche = forme.layer[q];
          for (let c = 0; c < 4; c++) lay.push(couche);

          // Même règle que pour un cube : une face texturée ne porte que
          // l'ombrage, sinon la teinte du bloc s'applique deux fois.
          const k = FACE_SHADE[forme.face[q]];
          const texture = couche !== 0;
          const r = texture ? 255 : colors[id * 3];
          const g = texture ? 255 : colors[id * 3 + 1];
          const b = texture ? 255 : colors[id * 3 + 2];
          for (let c = 0; c < 4; c++) {
            rgb.push(Math.min(255, r * k) | 0, Math.min(255, g * k) | 0, Math.min(255, b * k) | 0);
          }

          const [a0, a1, a2, a3] = [start, start + 1, start + 2, start + 3];
          if (forme.flip[q]) indices.push(a2, a1, a0, a3, a2, a0);
          else indices.push(a0, a1, a2, a0, a2, a3);
        }
      }
    }
  }
}
