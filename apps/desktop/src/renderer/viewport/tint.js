// La TEINTE d'une face — ce qui rend l'herbe verte.
//
// Les textures teintées de Minecraft sont GRISES. Mesuré dans le codex du
// site : `grass_block_top.png` est un gris uni (147, 147, 147), et
// `oak_leaves.png` un gris plus sombre (97, 97, 97). Ce n'est pas un défaut du
// pack — c'est le format : le jeu multiplie ces textures par une couleur de
// biome au moment du rendu, ce que la face signale avec `tintindex`.
//
// Ignorer l'indication donnait un sol blanchâtre sur tout terrain, des feuilles
// grises, et rien ne le signalait : la texture s'affichait, simplement pas de
// la bonne couleur. Le symptôme se lit « les blocs ont la mauvaise couleur », ce
// qui ne désigne pas la cause.
//
// Module PUR : il ne fait que de l'arithmétique de couleur, donc il se teste
// sans navigateur.

/**
 * Le facteur qui amène une texture grise à la couleur voulue.
 *
 * On ne multiplie PAS bêtement par la couleur du bloc : la texture vaut déjà
 * ~0,58 en moyenne, et `gris × vert` donnerait un vert deux fois trop sombre.
 * On divise donc par la moyenne de la tuile, ce qui revient à demander « que la
 * face, une fois teintée, ait EN MOYENNE la couleur connue du bloc ». Le
 * facteur s'adapte ainsi tout seul à une texture claire comme à une sombre,
 * sans table de correspondance à tenir.
 *
 * @param {number[]} cible couleur voulue (la couleur de carte du bloc), 0..255
 * @param {number[]} moyenne moyenne des pixels opaques de la tuile, 0..255
 * @returns {number[]} facteur par canal, 0..255 où 255 = « ne change rien »
 */
export function facteurTeinte(cible, moyenne) {
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const m = moyenne?.[k];
    // Une tuile noire ou illisible ne donne aucune information : on laisse la
    // face telle quelle plutôt que de diviser par zéro et tout blanchir.
    if (!Number.isFinite(m) || m < 1) { out[k] = 255; continue; }
    const f = (Number(cible?.[k]) || 0) / m;
    // Plafond à 2×. Au-delà, ce n'est plus une teinte mais une correction
    // d'exposition, et les pixels clairs de la texture saturent en blanc.
    out[k] = Math.max(0, Math.min(255, Math.round(f * 255 * (f > 2 ? 2 / f : 1))));
  }
  return out;
}

/**
 * La table `id * 6 + face → facteur RVB`, pour les faces TEINTÉES seulement.
 *
 * Rend `null` si aucune face de la palette n'est teintée — l'immense majorité
 * des builds. Le mailleur saute alors la branche entière, et le rendu est au
 * bit près celui d'avant.
 *
 * Indexée comme les VOXELS, donc `(i + 1)` : 0 est l'air. Une table indexée sur
 * la palette décalerait tout d'un cran et teinterait le mauvais bloc.
 *
 * @param {{name:string}[]} palette
 * @param {Record<string, {kind:string, boxes:object[]}>} formes
 * @param {(nom:string) => number[]} couleurDe couleur de carte d'un bloc
 * @param {(src:string) => number[]} moyenneDe moyenne de la tuile d'une texture
 * @param {string[]} FACES l'ordre des faces du mailleur
 */
export function tableDesTeintes(palette, formes, couleurDe, moyenneDe, FACES) {
  const tints = new Uint8Array((palette.length + 1) * 6 * 3).fill(255);
  let teintees = 0;

  for (let i = 0; i < palette.length; i++) {
    const nom = palette[i]?.name;
    const forme = formes?.[nom];
    // Seuls les CUBES passent par cette table : les faces d'un modèle portent
    // leur teinte dans leurs propres quads (`models.js`).
    if (!forme || forme.kind === 'model') continue;
    const faces = forme.boxes?.[0]?.faces;
    if (!faces) continue;

    for (let k = 0; k < 6; k++) {
      const decl = faces[FACES[k]];
      if (!decl?.tint || !decl.texture) continue;
      const f = facteurTeinte(couleurDe(nom), moyenneDe(decl.texture));
      const base = ((i + 1) * 6 + k) * 3;
      tints[base] = f[0]; tints[base + 1] = f[1]; tints[base + 2] = f[2];
      teintees++;
    }
  }
  return teintees ? tints : null;
}
