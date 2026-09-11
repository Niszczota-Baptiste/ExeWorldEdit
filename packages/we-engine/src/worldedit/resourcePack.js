// Résolution d'un bloc vers son ICÔNE, depuis un pack de ressources.
//
// La palette montrait un carré de couleur par bloc. Utile pour distinguer, pas
// pour reconnaître : trente nuances de gris ne disent pas lequel est du
// cobblestone. Les vraies textures sont dans le jeu, pas dans ce dépôt — on ne
// peut pas les y embarquer —, donc l'application lit le pack que l'utilisateur
// lui désigne : le `.jar` d'une version de Minecraft, un pack de ressources
// zippé, ou un dossier déplié. Le pack du serveur Minefield fournit de la même
// façon les blocs `minefield:*`.
//
// La chaîne est celle du jeu, et il faut la suivre entièrement :
//
//   blockstates/<nom>.json   →   quel modèle pour quel état
//   models/block/<x>.json    →   parent, textures, elements (les cuboïdes)
//   textures/block/<y>.png   →   l'image
//
// On ne peut PAS sauter au nom de texture : beaucoup de blocs n'en ont pas qui
// porte leur nom (`grass_block` utilise `grass_block_top`, `dirt`,
// `grass_block_side`), et surtout un bloc peut n'être pas un cube — une chaise
// `minefield:*`, un escalier, une dalle. Dessiner sa texture sur un cube plein
// mentirait sur ce qu'on pose.

/** Une face vue en projection isométrique. Les trois autres sont cachées. */
export const FACES_VUES = ['up', 'north', 'east'];

const PREFIXE = /^([a-z0-9_.-]+):/;

/** `stone` → `minecraft:stone` ; `minefield:chaise` reste. */
function qualifie(ref, parNs = 'minecraft') {
  const s = String(ref || '');
  return PREFIXE.test(s) ? s : `${parNs}:${s}`;
}

/** `minecraft:block/stone` → `assets/minecraft/models/block/stone.json`. */
function cheminModele(ref) {
  const [ns, chemin] = qualifie(ref).split(':');
  // Un modèle sans dossier est sous `block/` : c'est la convention du jeu
  // depuis 1.13, et les packs la suivent.
  return `assets/${ns}/models/${chemin.includes('/') ? chemin : `block/${chemin}`}.json`;
}

/** `minecraft:block/stone` → `assets/minecraft/textures/block/stone.png`. */
function cheminTexture(ref) {
  const [ns, chemin] = qualifie(ref).split(':');
  return `assets/${ns}/textures/${chemin}.png`;
}

const LIRE_JSON = (pack, chemin) => {
  const buf = pack.read(chemin);
  if (!buf) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
};

/**
 * Modèle déclaré par le blockstate d'un bloc, ou `null`.
 *
 * On prend la PREMIÈRE variante. Un bloc a autant de variantes que d'états —
 * un escalier en a quarante — et une icône n'en montre qu'une : la première
 * déclarée est celle de l'état par défaut, c'est celle qu'on veut.
 */
export function modeleDuBloc(pack, id) {
  const [ns, nom] = qualifie(id).split(':');
  const bs = LIRE_JSON(pack, `assets/${ns}/blockstates/${nom}.json`);
  if (!bs) return null;
  if (bs.variants) {
    const premiere = Object.values(bs.variants)[0];
    const v = Array.isArray(premiere) ? premiere[0] : premiere;
    return v?.model || null;
  }
  if (Array.isArray(bs.multipart)) {
    for (const part of bs.multipart) {
      const a = Array.isArray(part.apply) ? part.apply[0] : part.apply;
      if (a?.model) return a.model;
    }
  }
  return null;
}

/** Profondeur d'héritage tolérée : au-delà, c'est une boucle ou un pack cassé. */
const MAX_PARENTS = 12;

/**
 * Aplatit la chaîne d'héritage d'un modèle.
 *
 * `textures` fusionne du parent vers l'enfant — l'enfant gagne. `elements` ne
 * fusionne PAS : la première définition rencontrée en remontant l'emporte,
 * c'est la règle du jeu (un enfant qui redéfinit `elements` remplace ceux du
 * parent, il ne s'y ajoute pas).
 */
export function aplatitModele(pack, ref) {
  let courant = ref;
  const textures = {};
  let elements = null;
  const vus = new Set();

  for (let i = 0; i < MAX_PARENTS && courant; i++) {
    const chemin = cheminModele(courant);
    if (vus.has(chemin)) break; // parent cyclique : un pack peut être cassé
    vus.add(chemin);
    const m = LIRE_JSON(pack, chemin);
    if (!m) break;
    // Le parent est visité APRÈS, donc ses textures ne doivent pas écraser
    // celles déjà posées par les enfants.
    for (const [k, v] of Object.entries(m.textures || {})) {
      if (!(k in textures)) textures[k] = v;
    }
    if (!elements && Array.isArray(m.elements)) elements = m.elements;
    courant = m.parent;
  }
  return { textures, elements, racine: courant || null };
}

/**
 * Résout une variable de texture (`#all`, `#side`) vers un chemin de fichier.
 * Les variables peuvent pointer vers d'autres variables — d'où la boucle.
 */
export function resoutTexture(textures, cle, profondeur = 6) {
  let v = textures[cle];
  for (let i = 0; i < profondeur && typeof v === 'string' && v.startsWith('#'); i++) {
    v = textures[v.slice(1)];
  }
  return typeof v === 'string' && !v.startsWith('#') ? v : null;
}

/** Le cuboïde couvre-t-il tout le bloc ? */
const estPlein = (e) => {
  const [a, b] = [e.from, e.to];
  return Array.isArray(a) && Array.isArray(b)
    && a.every((v) => v === 0) && b.every((v) => v === 16);
};

/**
 * Le modèle est-il un CUBE PLEIN ?
 *
 * La question compte : un bloc qui n'en est pas un — une chaise, un escalier,
 * une dalle, un quart de bloc `minefield:*` — dessiné en cube plein donne une
 * icône qui ment sur ce qu'on pose. Un seul cuboïde de 0 à 16 en est un ; tout
 * le reste se dessine par ses cuboïdes.
 */
export const estCubePlein = (elements) => Array.isArray(elements) && elements.length === 1 && estPlein(elements[0]);

/**
 * Ce qu'il faut pour dessiner l'icône d'un bloc : sa géométrie et les chemins
 * de ses textures. Le rendu lui-même appartient à qui a un canvas — pas au
 * moteur, qui n'en a pas et n'a pas à en avoir un.
 *
 * @returns {{ kind:'cube'|'model', elements:object[], textures:Record<string,string> }|null}
 */
export function planIcone(pack, id) {
  const ref = modeleDuBloc(pack, id);
  if (!ref) return null;
  const { textures, elements } = aplatitModele(pack, ref);

  // Un modèle sans `elements` hérite de la forme d'un cube : c'est le cas de
  // `cube_all` et de ses enfants, qui ne déclarent que des textures.
  const geo = elements && elements.length
    ? elements
    : [{ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(FACES_VUES.map((f) => [f, { texture: '#all' }])) }];

  // On ne rend que les textures RÉELLEMENT citées par les faces visibles :
  // un pack en contient des milliers, et l'icône n'en regarde que trois.
  const utiles = {};
  for (const e of geo) {
    for (const f of FACES_VUES) {
      const t = e.faces?.[f]?.texture;
      if (typeof t !== 'string') continue;
      const cle = t.startsWith('#') ? t.slice(1) : null;
      const chemin = cle ? resoutTexture(textures, cle) : t;
      if (chemin) utiles[t] = cheminTexture(chemin);
    }
  }
  // Repli : une face sans texture propre prend `#all`, `#texture` ou `#side` —
  // l'ordre dans lequel les modèles du jeu les déclarent.
  for (const cle of ['all', 'texture', 'side', 'top', 'end', 'particle']) {
    const chemin = resoutTexture(textures, cle);
    if (chemin) { utiles[`#${cle}`] = cheminTexture(chemin); break; }
  }

  return { kind: estCubePlein(geo) ? 'cube' : 'model', elements: geo, textures: utiles };
}
