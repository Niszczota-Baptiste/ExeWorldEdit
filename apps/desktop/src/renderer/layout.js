// La DISPOSITION des panneaux : qui est où, et dans quel ordre.
//
// Pur — aucun DOM, aucun React. C'est ici qu'on décide ce qu'un déplacement
// veut dire, et surtout ce qui se passe quand la disposition enregistrée ne
// correspond plus au code : un panneau renommé, un panneau ajouté, un fichier
// de réglages bricolé à la main. La règle tient en une phrase : **on ne perd
// jamais un panneau**. Un panneau qui disparaît de l'interface sans moyen de le
// faire revenir est une fonctionnalité perdue, et personne ne pense à aller
// éditer un JSON pour la retrouver.

/** Les panneaux déplaçables. L'ordre sert de recours quand tout est vide. */
export const PANELS = [
  { id: 'inspector', label: 'Inspecteur', icon: 'Settings2' },
  { id: 'palette', label: 'Palette de blocs', icon: 'Layers' },
  { id: 'perf', label: 'Performances', icon: 'Gauge' },
  { id: 'audit', label: 'Journal', icon: 'History' },
];

export const PANEL_IDS = PANELS.map((p) => p.id);

/**
 * Les emplacements. Deux à droite parce que c'est la disposition d'origine —
 * inspecteur au-dessus, palette en-dessous — et qu'elle reste la bonne par
 * défaut : on veut souvent voir les réglages ET la palette en même temps.
 * Les mettre en onglets dès le départ obligerait à faire l'aller-retour.
 */
export const ZONES = [
  { id: 'left', label: 'À gauche', side: 'left' },
  { id: 'rightTop', label: 'À droite, en haut', side: 'right' },
  { id: 'rightBottom', label: 'À droite, en bas', side: 'right' },
  { id: 'bottom', label: 'En bas', side: 'bottom' },
];

export const ZONE_IDS = ZONES.map((z) => z.id);

/**
 * Au premier lancement, l'interface est EXACTEMENT celle d'avant les onglets :
 * inspecteur en haut à droite, palette en dessous. Le relevé et le journal
 * viennent en onglets À CÔTÉ de la palette plutôt que d'ouvrir une colonne de
 * plus — une disposition par défaut doit se reconnaître, pas s'expliquer.
 */
export const DEFAULT_LAYOUT = {
  zones: { left: [], rightTop: ['inspector'], rightBottom: ['palette', 'audit', 'perf'], bottom: [] },
  active: { rightTop: 'inspector', rightBottom: 'palette' },
};

/**
 * Complète et corrige une disposition venue des réglages.
 *
 * Trois garanties, dans cet ordre :
 *  1. aucun panneau inconnu (un identifiant retiré du code disparaît) ;
 *  2. aucun panneau en double (il ne peut être qu'à un endroit) ;
 *  3. aucun panneau MANQUANT — ce qui n'est nulle part revient à sa place
 *     d'origine, ou au premier emplacement si elle n'existe plus.
 */
export function normalizeLayout(raw) {
  const zones = {};
  const vus = new Set();
  for (const z of ZONE_IDS) {
    const liste = Array.isArray(raw?.zones?.[z]) ? raw.zones[z] : [];
    zones[z] = [];
    for (const id of liste) {
      if (!PANEL_IDS.includes(id) || vus.has(id)) continue;
      vus.add(id);
      zones[z].push(id);
    }
  }
  // Ce qui manque revient là où il était à l'origine.
  for (const id of PANEL_IDS) {
    if (vus.has(id)) continue;
    const maison = ZONE_IDS.find((z) => DEFAULT_LAYOUT.zones[z]?.includes(id)) || ZONE_IDS[0];
    zones[maison].push(id);
  }

  // L'onglet actif d'un emplacement doit s'y trouver.
  const active = {};
  for (const z of ZONE_IDS) {
    const choisi = raw?.active?.[z];
    active[z] = zones[z].includes(choisi) ? choisi : (zones[z][0] || null);
  }
  return { zones, active };
}

/**
 * Déplace un panneau.
 *
 * `toIndex` est l'indice VU À L'ÉCRAN au moment du dépôt — celui de l'onglet
 * sur lequel on lâche, dans la liste telle qu'elle est affichée. C'est ce dont
 * dispose l'interface, et c'est ce qu'un utilisateur croit faire : « pose-le
 * là où est celui-ci ». `Infinity` veut dire « à la fin ».
 *
 * D'où le décalage à corriger : retirer le panneau raccourcit la liste devant
 * lui, donc tout indice situé APRÈS sa position d'origine glisse d'un cran.
 * Sans ça, déplacer un onglet vers la droite dans son propre emplacement le
 * pose systématiquement une place trop loin — le défaut classique de tout
 * réordonnancement par glisser, et celui que ce module avait au premier jet.
 */
export function movePanel(layout, panelId, toZone, toIndex = Infinity) {
  if (!PANEL_IDS.includes(panelId) || !ZONE_IDS.includes(toZone)) return layout;
  const depart = layout.zones[toZone]?.indexOf(panelId) ?? -1;

  const zones = Object.fromEntries(ZONE_IDS.map((z) => [z, layout.zones[z].filter((p) => p !== panelId)]));
  const cible = zones[toZone];
  if (!Number.isFinite(toIndex)) {
    cible.push(panelId);
  } else {
    let i = Math.max(0, Math.min(layout.zones[toZone].length, Math.round(Number(toIndex)) || 0));
    if (depart >= 0 && depart < i) i -= 1;
    cible.splice(Math.min(i, cible.length), 0, panelId);
  }

  // Le panneau déplacé devient l'onglet visible : le déposer quelque part et ne
  // pas le voir apparaître donne l'impression que le geste a échoué.
  const active = { ...layout.active, [toZone]: panelId };
  for (const z of ZONE_IDS) {
    if (!zones[z].includes(active[z])) active[z] = zones[z][0] || null;
  }
  return { zones, active };
}

/** Rend l'emplacement d'un panneau, ou `null`. */
export const zoneOf = (layout, panelId) => ZONE_IDS.find((z) => layout.zones[z].includes(panelId)) || null;

/** Choisit l'onglet visible d'un emplacement. */
export function setActive(layout, zone, panelId) {
  if (!layout.zones[zone]?.includes(panelId)) return layout;
  return { ...layout, active: { ...layout.active, [zone]: panelId } };
}

/** Un emplacement vide ne s'affiche pas : il ne doit pas laisser de bande morte. */
export const zoneUsed = (layout, zone) => (layout.zones[zone]?.length || 0) > 0;

/** Les côtés réellement occupés — pour savoir quelles colonnes monter. */
export function sidesUsed(layout) {
  const out = new Set();
  for (const z of ZONES) if (zoneUsed(layout, z.id)) out.add(z.side);
  return out;
}
