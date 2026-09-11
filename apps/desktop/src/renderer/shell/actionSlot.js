import { createContext } from 'react';

// L'emplacement ÉPINGLÉ des actions du panneau, partagé avec les écrans
// d'outils.
//
// Chacun a son bouton principal — « Poser 36 864 cases », « Sculpter le
// relief » — au bout d'un formulaire long : rendu dans le flux, il tombe sous
// la ligne de flottaison, exactement comme « Appliquer » l'a fait avant lui.
// Ils l'envoient donc ici par un portail, plutôt que chacun refasse sa barre.
//
// Dans son propre module et non dans `Inspector.jsx` : l'inspecteur importe les
// écrans d'outils, et si les écrans réimportaient l'inspecteur, le cycle
// tiendrait par chance — l'ordre d'initialisation des modules ESM n'est pas un
// endroit où poser sa confiance.
export const ActionSlot = createContext(null);
