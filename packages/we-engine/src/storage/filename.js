// Un nom LISIBLE devient un nom de fichier, sans y perdre ses lettres.
//
// L'ancienne règle était `replace(/[^\w.-]+/g, '_')`. `\w` vaut `[A-Za-z0-9_]` :
// tout ce qui sort de l'ASCII disparaissait.
//
//   « Vallée de Minefield »  →  Vall_e_de_Minefield
//   « Arène N°3 »            →  Ar_ne_N_3
//   « 한국어 건물 »            →  _
//
// Le dernier cas est le pire : le nom entier est perdu, et deux builds coréens
// différents se retrouvent avec le même fichier. Or la police embarquée du
// moteur couvre tout le BMP justement pour qu'on puisse écrire du coréen — il
// serait absurde que le nom du build, lui, ne le supporte pas.
//
// Ce qu'un système de fichiers refuse VRAIMENT est une courte liste. Windows
// est la plateforme cible et la plus stricte des trois, donc c'est sa liste.

/**
 * Caractères interdits par Windows dans un nom de fichier, plus les caractères
 * de contrôle. Tout le reste — accents, CJK, emoji — est accepté par NTFS,
 * ext4 et APFS.
 */
// Un octet de contrôle dans un nom de fichier est refusé par le système, ou
// pire, accepté et illisible : c'est exactement ce qu'on veut exclure.
// eslint-disable-next-line no-control-regex -- voir ci-dessus
const INTERDITS = /[<>:"/\\|?*\u0000-\u001F]/g;

/**
 * Noms de périphériques réservés par Windows. `CON.mca` est refusé par le
 * système aussi sûrement que `CON`, d'où la comparaison sur la TIGE du nom.
 *
 * Un ensemble et pas une expression régulière : `^(con|…)(\..*)?$` fait
 * remonter un avertissement de retour sur trace, et ici la question est une
 * simple appartenance.
 */
const RESERVES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const estReserve = (s) => {
  const point = s.indexOf('.');
  return RESERVES.has((point > 0 ? s.slice(0, point) : s).toLowerCase());
};

/**
 * Nom de fichier sûr, dérivé d'un nom lisible.
 *
 * @param {string} nom nom affiché, tel que l'utilisateur l'a écrit
 * @param {{ fallback?: string, max?: number }} [o]
 * @returns {string} un nom de fichier non vide, sans extension
 */
export function safeFileName(nom, { fallback = 'build', max = 80 } = {}) {
  let s = String(nom ?? '')
    .replace(INTERDITS, ' ')
    // Les séparateurs de chemin sont déjà partis ; reste à empêcher qu'un nom
    // remonte d'un dossier.
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    // Windows refuse un nom qui se termine par un point ou une espace, et le
    // coupe en silence — d'où un fichier dont le nom n'est pas celui demandé.
    .replace(/[. ]+$/, '')
    .trim();

  if (!s || estReserve(s)) return fallback;
  return s;
}

/** `safeFileName` plus une extension. `« Arène N°3 », 'schem'` → `Arène N°3.schem`. */
export const safeFileNameExt = (nom, ext, o) => `${safeFileName(nom, o)}.${String(ext).replace(/^\./, '')}`;
