// Ce sur quoi la palette de commandes CHERCHE.
//
// Pur, donc testable sans navigateur — et c'est nécessaire : la valeur de
// recherche est une concaténation, exactement le genre de chaîne dont on croit
// qu'elle contient ce qu'il faut jusqu'à ce qu'un nom manque à l'appel.
//
// Le point qui compte : on cherche par le NOM WORLDEDIT. Quelqu'un qui connaît
// WorldEdit tape « //walls », pas « Murs ». Sans ça, il doit apprendre un
// second vocabulaire pour se servir d'un outil qui fait la même chose.

/** Tout ce par quoi une opération doit pouvoir être trouvée, en une chaîne. */
export const valeurDeRecherche = (op) => [
  op?.label,
  op?.id,
  ...(op?.we || []),
  op?.group,
].filter(Boolean).join(' ');

/**
 * Le filtre de la palette. Rend 1 si la ligne correspond, 0 sinon — c'est le
 * contrat de `cmdk`.
 *
 * Une simple recherche de sous-chaîne, volontairement : un score approximatif
 * ferait remonter « //hollow » sur une recherche « //hcyl » parce qu'ils
 * partagent des lettres, et une commande proposée à la place de celle qu'on a
 * tapée est pire que pas de résultat du tout.
 */
export const filtre = (valeur, recherche) => (
  String(valeur).toLowerCase().includes(String(recherche).toLowerCase().trim()) ? 1 : 0
);
