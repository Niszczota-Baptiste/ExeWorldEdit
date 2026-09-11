import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

// Le bout DROIT de la barre d'onglets d'un emplacement, prêté au panneau
// visible.
//
// Chaque panneau avait sa propre barre de titre : une icône, son nom, et un
// chiffre à droite (le nombre de blocs, les images par seconde, l'outil en
// cours). Une fois les panneaux rangés en onglets, ce nom était écrit DEUX fois
// l'un au-dessus de l'autre — « Performances » dans l'onglet, « Performances »
// juste en dessous — pour trente pixels de hauteur perdus par panneau.
//
// L'onglet garde le nom, qu'il portait déjà ; le chiffre, lui, n'a nulle part
// où aller et remonte ici par un portail. Même procédé que `ActionSlot`, et
// pour la même raison : c'est le panneau qui CONNAÎT la valeur, mais la barre
// qui a la place de l'afficher.
//
// Dans son propre module : `Dock` fournit l'hôte et les panneaux le
// consomment ; si les panneaux réimportaient `Dock`, le cycle ne tiendrait que
// par l'ordre d'initialisation des modules ESM.
export const DockSlot = createContext(null);

/**
 * L'indicateur d'un panneau, posé au bout de SA barre d'onglets.
 *
 * Rend `null` hors d'un emplacement : c'est le cas du relevé flottant, qui a
 * gardé son propre en-tête et n'a donc pas d'hôte.
 */
export function DockExtra({ children }) {
  const hote = useContext(DockSlot);
  return hote ? createPortal(children, hote) : null;
}
