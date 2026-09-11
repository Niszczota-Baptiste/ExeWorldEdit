import { TOOLS } from './tools.js';

// Raccourcis clavier, RÉASSIGNABLES.
//
// Les touches étaient écrites en dur dans deux endroits : la lettre de chaque
// outil dans `TOOLS`, et les combinaisons dans le gestionnaire d'`App.jsx`.
// Rien de configurable, et rien qui empêchait deux actions de partager la même
// touche.
//
// Ce module est pur — aucun accès au DOM, aucun `window` — donc testable sans
// navigateur. C'est là qu'on décide ce qu'une touche veut dire ; les composants
// se contentent de comparer.
//
// Format d'une liaison : les modificateurs dans un ordre FIXE, puis la touche.
//
//   « Ctrl+Shift+Z »   « Alt+F »   « Space »   « , »   « V »
//
// L'ordre fixe est ce qui rend deux liaisons comparables par simple égalité de
// chaînes — donc la détection de conflit, la persistance et l'affichage n'ont
// pas chacun leur idée de la forme canonique.

/** Modificateurs, dans l'ordre où ils s'écrivent. */
const MODS = ['Ctrl', 'Alt', 'Shift'];

/**
 * Touches nommées qu'on accepte en plus des caractères imprimables. Une liste
 * fermée : une liaison sur « Dead » ou « Unidentified » ne se rejouerait pas.
 */
const NOMMEES = new Set([
  'Space', 'Escape', 'Enter', 'Tab', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

/** Étiquettes françaises des touches, pour l'affichage seulement. */
const ETIQUETTES = {
  Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Maj',
  Space: 'Espace', Escape: 'Échap', Enter: 'Entrée', Tab: 'Tab',
  Backspace: 'Retour', Delete: 'Suppr',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  PageUp: 'Page ↑', PageDown: 'Page ↓', Home: 'Début', End: 'Fin',
};

/**
 * Actions liables. Celles des outils sont DÉRIVÉES de `TOOLS` : ajouter un
 * outil suffit, et sa lettre par défaut reste écrite au même endroit que lui.
 */
export const ACTIONS = [
  ...TOOLS.map((t) => ({ id: `tool.${t.id}`, label: t.label, group: 'Outils', defaut: t.key })),
  { id: 'wheel', label: 'Roue d’outils (maintenir)', group: 'Outils', defaut: 'Space' },
  { id: 'undo', label: 'Annuler', group: 'Édition', defaut: 'Ctrl+Z' },
  { id: 'redo', label: 'Rétablir', group: 'Édition', defaut: 'Ctrl+Shift+Z' },
  { id: 'copy', label: 'Copier la sélection', group: 'Édition', defaut: 'Ctrl+C' },
  { id: 'paste', label: 'Coller', group: 'Édition', defaut: 'Ctrl+V' },
  { id: 'open', label: 'Ouvrir un fichier', group: 'Application', defaut: 'Ctrl+O' },
  { id: 'settings', label: 'Réglages', group: 'Application', defaut: 'Ctrl+,' },
];

export const ACTION_IDS = ACTIONS.map((a) => a.id);
export const DEFAULT_KEYS = Object.fromEntries(ACTIONS.map((a) => [a.id, a.defaut]));

/** Groupes, dans l'ordre d'affichage, sans les recopier à la main. */
export const KEY_GROUPS = [...new Set(ACTIONS.map((a) => a.group))];

/**
 * Met une liaison sous sa forme canonique, ou rend `null` si elle n'en est pas
 * une. Refuser plutôt que corriger : une liaison approximative est une touche
 * qui ne répond pas, et c'est plus déroutant qu'un refus.
 */
export function normalizeBinding(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const touche = parts.pop();
  const mods = new Set();
  for (const p of parts) {
    const m = MODS.find((x) => x.toLowerCase() === p.toLowerCase());
    if (!m) return null;
    mods.add(m);
  }
  const nommee = [...NOMMEES].find((n) => n.toLowerCase() === touche.toLowerCase());
  // Une lettre est rangée en majuscule ; un caractère (virgule, point) reste
  // tel quel. Au-delà d'un caractère et hors des touches nommées, on refuse.
  const fin = nommee || (touche.length === 1 ? touche.toUpperCase() : null);
  if (!fin) return null;
  return [...MODS.filter((m) => mods.has(m)), fin].join('+');
}

/**
 * Liaison correspondant à un événement clavier, ou `null` si la frappe n'en
 * est pas une (un modificateur seul, une touche morte).
 */
export function bindingFromEvent(e) {
  const brut = e.key === ' ' ? 'Space' : e.key;
  if (['Control', 'Alt', 'Shift', 'Meta', 'Dead', 'Unidentified'].includes(brut)) return null;
  const mods = [];
  // `metaKey` compte comme Ctrl : sur un clavier Mac, c'est la même intention.
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return normalizeBinding([...mods, brut].join('+'));
}

/** L'événement déclenche-t-il cette liaison ? */
export function matchesBinding(binding, e) {
  const attendu = normalizeBinding(binding);
  return !!attendu && bindingFromEvent(e) === attendu;
}

/** Une liaison en morceaux affichables : `['Ctrl', 'Maj', 'Z']`. */
export function describeBinding(binding) {
  const b = normalizeBinding(binding);
  if (!b) return [];
  return b.split('+').map((p) => ETIQUETTES[p] || p);
}

/**
 * Complète et valide un jeu de raccourcis venu des réglages — donc d'un
 * fichier que l'utilisateur peut éditer à la main.
 *
 * Une liaison illisible retombe sur sa valeur par défaut, et une action
 * inconnue est ignorée : un `settings.json` bricolé ne doit pas rendre
 * l'application inutilisable au clavier.
 */
export function normalizeKeys(raw = {}) {
  const out = { ...DEFAULT_KEYS };
  for (const a of ACTIONS) {
    const v = normalizeBinding(raw?.[a.id]);
    if (v) out[a.id] = v;
  }
  return out;
}

/**
 * Actions qui partagent une liaison, par liaison. Rendu vide s'il n'y en a
 * aucune.
 *
 * On ne REFUSE pas un conflit : l'utilisateur est au milieu d'une
 * réassignation, et l'empêcher de poser une touche avant d'avoir libéré
 * l'autre est plus pénible que de le lui dire. On le signale, c'est tout.
 *
 * @returns {Record<string, string[]>} liaison → identifiants d'action
 */
export function keyConflicts(keys) {
  const par = new Map();
  for (const [id, b] of Object.entries(keys || {})) {
    if (!ACTION_IDS.includes(id)) continue;
    const n = normalizeBinding(b);
    if (!n) continue;
    par.set(n, [...(par.get(n) || []), id]);
  }
  return Object.fromEntries([...par].filter(([, ids]) => ids.length > 1));
}

/** L'action liée à un événement, ou `null`. La première trouvée suffit. */
export function actionForEvent(keys, e) {
  const b = bindingFromEvent(e);
  if (!b) return null;
  for (const a of ACTIONS) if (normalizeBinding(keys[a.id]) === b) return a.id;
  return null;
}
