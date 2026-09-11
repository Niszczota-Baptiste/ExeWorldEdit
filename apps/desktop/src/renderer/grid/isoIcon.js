// Dessine l'icône d'un bloc en projection ISOMÉTRIQUE, depuis le plan que rend
// le moteur (géométrie + textures).
//
// Pourquoi ici et pas dans le moteur : il faut un canvas, et le moteur n'en a
// pas — lui en donner un voudrait dire une dépendance native de plus à
// empaqueter pour Windows. Le renderer, lui, EST un navigateur.
//
// Pourquoi pas simplement la texture de face, comme un inventaire 2D : parce
// que tous les blocs ne sont pas des cubes. Une chaise `minefield:*`, un
// escalier, une dalle, un quart de bloc — les dessiner en carré plein donne une
// icône qui ment sur ce qu'on pose. Chaque cuboïde du modèle est donc dessiné.

/**
 * Repère isométrique classique 2:1. Un point du bloc (x, y, z ∈ 0..16) va vers
 * l'écran ; +X part à droite, +Z à gauche, +Y monte.
 */
function projette(x, y, z, echelle) {
  return {
    x: (x - z) * echelle * 0.5,
    y: (x + z) * echelle * 0.25 - y * echelle * 0.5,
  };
}

/**
 * Éclairage par face. Les mêmes rapports que le viewport : le dessus en plein,
 * les côtés assombris, et les deux côtés différemment — sans ça un cube est un
 * hexagone uni et on ne voit plus ses arêtes.
 */
const OMBRE = { up: 1, north: 0.62, east: 0.82 };

/** Les quatre coins d'une face d'un cuboïde, dans l'ordre (u,v) de la texture. */
function coins(e, face) {
  const [x0, y0, z0] = e.from;
  const [x1, y1, z1] = e.to;
  if (face === 'up') return [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]];
  if (face === 'north') return [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]];
  // east
  return [[x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [x1, y0, z0]];
}

/**
 * Peint une image dans le parallélogramme (p0, p1, p3) — p0 est l'origine, p1
 * le bout de l'axe u, p3 le bout de l'axe v.
 *
 * Une face projetée est toujours un parallélogramme, donc l'image d'un carré
 * par une transformation AFFINE : `setTransform` suffit, sans découper en
 * triangles.
 */
function peint(ctx, img, p0, p1, p3, alpha) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(p1.x + p3.x - p0.x, p1.y + p3.y - p0.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(
    (p1.x - p0.x) / img.width, (p1.y - p0.y) / img.width,
    (p3.x - p0.x) / img.height, (p3.y - p0.y) / img.height,
    p0.x, p0.y,
  );
  // Un demi-pixel de débord : sans lui, deux faces voisines laissent une
  // couture claire là où leurs bords s'arrêtent au même endroit.
  ctx.drawImage(img, -0.5, -0.5, img.width + 1, img.height + 1);
  ctx.restore();
  if (alpha < 1) {
    ctx.save();
    ctx.globalAlpha = 1 - alpha;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p1.x + p3.x - p0.x, p1.y + p3.y - p0.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/** Charge les `data:` du plan en images, une seule fois par plan. */
async function charge(textures) {
  const out = {};
  await Promise.all(Object.entries(textures).map(async ([cle, src]) => {
    const img = new Image();
    await new Promise((ok, ko) => { img.onload = ok; img.onerror = ko; img.src = src; });
    out[cle] = img;
  }));
  return out;
}

/**
 * Icône d'un bloc, en `data:` PNG.
 *
 * @param {{kind:string, elements:object[], textures:Record<string,string>}} plan
 * @param {number} taille côté de l'icône en pixels
 * @returns {Promise<string|null>}
 */
export async function dessineIcone(plan, taille = 64) {
  if (!plan?.elements?.length) return null;
  let imgs;
  try { imgs = await charge(plan.textures); } catch { return null; }
  if (!Object.keys(imgs).length) return null;

  const canvas = document.createElement('canvas');
  canvas.width = taille;
  canvas.height = taille;
  const ctx = canvas.getContext('2d');
  // Les textures font 16 × 16 : les lisser les transforme en bouillie.
  ctx.imageSmoothingEnabled = false;

  // Le modèle est CADRÉ sur ses propres bornes, pas sur un cube de 16.
  //
  // Un élément peut déborder du bloc — Minecraft autorise −16 à 32, et le
  // dossier d'une chaise monte volontiers à 20. Supposer 0..16 rognait le haut
  // du dossier. À l'inverse, une dalle cadrée sur 16 se dessinerait minuscule
  // dans un coin ; ici elle occupe l'icône.
  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity;
  let bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
  for (const e of plan.elements) {
    if (!Array.isArray(e.from) || !Array.isArray(e.to)) continue;
    bx0 = Math.min(bx0, e.from[0], e.to[0]); bx1 = Math.max(bx1, e.from[0], e.to[0]);
    by0 = Math.min(by0, e.from[1], e.to[1]); by1 = Math.max(by1, e.from[1], e.to[1]);
    bz0 = Math.min(bz0, e.from[2], e.to[2]); bz1 = Math.max(bz1, e.from[2], e.to[2]);
  }
  if (bx0 === Infinity) return null;

  // On projette la boîte englobante pour connaître l'étendue à l'écran, puis on
  // choisit l'échelle qui la fait tenir. Calculer l'étendue à la main serait
  // refaire la projection une seconde fois, donc une occasion de se tromper.
  const brut = [];
  for (const x of [bx0, bx1]) for (const y of [by0, by1]) for (const z of [bz0, bz1]) brut.push(projette(x, y, z, 1));
  const ex0 = Math.min(...brut.map((p) => p.x)), ex1 = Math.max(...brut.map((p) => p.x));
  const ey0 = Math.min(...brut.map((p) => p.y)), ey1 = Math.max(...brut.map((p) => p.y));
  const marge = taille * 0.06;
  const dispo = taille - marge * 2;
  const echelle = Math.min(dispo / Math.max(1e-6, ex1 - ex0), dispo / Math.max(1e-6, ey1 - ey0));
  const ox = marge - ex0 * echelle + (dispo - (ex1 - ex0) * echelle) / 2;
  const oy = marge - ey0 * echelle + (dispo - (ey1 - ey0) * echelle) / 2;
  const P = (x, y, z) => {
    const p = projette(x, y, z, echelle);
    return { x: p.x + ox, y: p.y + oy };
  };

  // Les cuboïdes du fond d'abord. Sans tri, un pied de chaise se dessine
  // par-dessus l'assise.
  const tries = [...plan.elements].sort((a, b) => {
    const da = (a.from[0] + a.from[2]) - a.from[1];
    const db = (b.from[0] + b.from[2]) - b.from[1];
    return da - db;
  });

  const texturePour = (e, face) => {
    const ref = e.faces?.[face]?.texture;
    return (ref && imgs[ref]) || imgs['#all'] || imgs['#texture'] || imgs['#side']
      || imgs[Object.keys(imgs)[0]];
  };

  for (const e of tries) {
    if (!Array.isArray(e.from) || !Array.isArray(e.to)) continue;
    // Dessus en dernier des trois : il recouvre le haut des côtés.
    for (const face of ['north', 'east', 'up']) {
      const img = texturePour(e, face);
      if (!img) continue;
      const [a, b, , d] = coins(e, face).map(([x, y, z]) => P(x, y, z));
      peint(ctx, img, a, b, d, OMBRE[face]);
    }
  }
  return canvas.toDataURL('image/png');
}
