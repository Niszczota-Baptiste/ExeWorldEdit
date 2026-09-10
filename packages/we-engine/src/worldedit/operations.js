// Descripteur des opérations WorldEdit — sert GET /operations (génération de
// l'UI et de la doc côté client) et borne la validation côté serveur.
// Toutes les opérations d'écriture exigent le rôle « editor » (owner inclus) ;
// la sélection et l'aperçu sont accessibles au « viewer ».

const DIRECTIONS = ['east', 'west', 'up', 'down', 'south', 'north'];

// Biomes courants 1.20 proposés dans le menu (la saisie reste libre pour les
// biomes modés : on valide seulement le format « namespace:id »).
const BIOMES = [
  'minecraft:plains', 'minecraft:forest', 'minecraft:birch_forest', 'minecraft:dark_forest',
  'minecraft:taiga', 'minecraft:snowy_taiga', 'minecraft:jungle', 'minecraft:savanna',
  'minecraft:desert', 'minecraft:badlands', 'minecraft:swamp', 'minecraft:mangrove_swamp',
  'minecraft:beach', 'minecraft:snowy_plains', 'minecraft:ice_spikes', 'minecraft:mushroom_fields',
  'minecraft:meadow', 'minecraft:cherry_grove', 'minecraft:grove', 'minecraft:snowy_slopes',
  'minecraft:windswept_hills', 'minecraft:stony_peaks', 'minecraft:frozen_peaks', 'minecraft:jagged_peaks',
  'minecraft:ocean', 'minecraft:warm_ocean', 'minecraft:lukewarm_ocean', 'minecraft:frozen_ocean',
  'minecraft:river', 'minecraft:nether_wastes', 'minecraft:soul_sand_valley', 'minecraft:crimson_forest',
  'minecraft:warped_forest', 'minecraft:basalt_deltas', 'minecraft:the_end', 'minecraft:lush_caves',
  'minecraft:dripstone_caves', 'minecraft:deep_dark',
];

export const OPERATIONS = [
  {
    id: 'mirror', label: 'Miroir', minRole: 'editor', group: 'Transformer',
    description: 'Réfléchit la sélection EN PLACE (états retournés : escaliers, portes, panneaux…).',
    params: [{ name: 'axis', type: 'enum', values: ['x', 'y', 'z'], default: 'x', label: 'Axe' }],
  },
  {
    id: 'mirrorcopy', label: 'Miroir (copie)', minRole: 'editor', group: 'Transformer',
    description: 'Duplique la sélection en miroir de l’AUTRE côté (l’original reste). Ex. copier une aile à droite. La copie est posée juste à côté (écart réglable) ; les états sont retournés.',
    params: [
      { name: 'axis', type: 'enum', values: ['x', 'y', 'z'], labels: { x: 'X (Est ⇄ Ouest)', y: 'Y (haut ⇄ bas)', z: 'Z (Nord ⇄ Sud)' }, default: 'x', label: 'Axe miroir' },
      { name: 'side', type: 'enum', values: ['positive', 'negative'], labels: { positive: 'Vers + (Est / Sud / Haut)', negative: 'Vers − (Ouest / Nord / Bas)' }, default: 'positive', label: 'Côté' },
      { name: 'gap', type: 'int', default: 0, label: 'Écart (blocs)' },
      { name: 'mode', type: 'enum', values: ['overlay', 'overwrite'], labels: { overlay: 'Superposer (garde l’existant)', overwrite: 'Écraser (copie exacte, air inclus)' }, default: 'overlay', label: 'Mode' },
    ],
  },
  {
    id: 'rotate', label: 'Rotation', minRole: 'editor', group: 'Transformer',
    description: 'Tourne la sélection autour de Y (et ses états).',
    params: [{ name: 'degrees', type: 'enum', values: [90, 180, 270], default: 90, label: 'Angle' }],
  },
  {
    id: 'translate', label: 'Translation', minRole: 'editor', group: 'Transformer',
    description: 'Déplace la sélection ; l’origine est vidée.',
    params: [
      { name: 'dx', type: 'int', default: 0, label: 'ΔX (Est)' },
      { name: 'dy', type: 'int', default: 0, label: 'ΔY (Haut)' },
      { name: 'dz', type: 'int', default: 0, label: 'ΔZ (Sud)' },
    ],
  },
  {
    id: 'stack', label: 'Répéter (stack)', minRole: 'editor', group: 'Transformer',
    description: 'Répète la sélection plusieurs fois dans une direction.',
    params: [
      { name: 'count', type: 'int', default: 1, label: 'Nombre' },
      { name: 'direction', type: 'enum', values: DIRECTIONS, default: 'up', label: 'Direction' },
    ],
  },
  {
    id: 'scale', label: 'Échelle (×N)', minRole: 'editor', group: 'Transformer',
    description: 'Agrandit le build (×0.5 réduit). « Coque seule » agrandit la structure puis vide l’intérieur — ne garde que les blocs extérieurs (évite de transformer chaque bloc en masse pleine N³).',
    params: [
      { name: 'factor', type: 'enum', values: [0.5, 2, 3, 4, 6], default: 2, label: 'Facteur' },
      { name: 'hollow', type: 'bool', default: false, label: 'Coque seule (vider l’intérieur)' },
    ],
  },
  {
    id: 'replace', label: 'Remplacer', minRole: 'editor', group: 'Blocs',
    description: 'Remplace un ou plusieurs blocs source par une cible.',
    params: [
      { name: 'from', type: 'blocklist', label: 'Bloc(s) source' },
      { name: 'to', type: 'block', label: 'Bloc cible' },
    ],
  },
  {
    id: 'set', label: 'Remplir', minRole: 'editor', group: 'Blocs',
    description: 'Remplit la sélection d’un bloc (masque optionnel : surface, air…).',
    params: [
      { name: 'block', type: 'block', label: 'Bloc' },
      { name: 'mask', type: 'mask', label: 'Masque' },
    ],
  },
  {
    id: 'mix', label: 'Mélange (%)', minRole: 'editor', group: 'Blocs',
    description: 'Remplit/remplace par un mélange aléatoire pondéré (ex. 30% terre, 20% andésite…). Laisse « bloc source » vide pour toute la sélection.',
    params: [
      { name: 'from', type: 'block', label: 'Bloc source (vide = tous)' },
      { name: 'pattern', type: 'pattern', label: 'Mélange (blocs + poids %)' },
      { name: 'mask', type: 'mask', label: 'Masque' },
    ],
  },
  {
    id: 'walls', label: 'Murs', minRole: 'editor', group: 'Blocs',
    description: 'Pose un bloc sur les 4 côtés verticaux de la sélection.',
    params: [{ name: 'block', type: 'block', label: 'Bloc' }],
  },
  {
    id: 'faces', label: 'Faces (boîte)', minRole: 'editor', group: 'Blocs',
    description: 'Pose un bloc sur les 6 faces (murs + sol + plafond).',
    params: [{ name: 'block', type: 'block', label: 'Bloc' }],
  },
  {
    id: 'hollow', label: 'Creuser', minRole: 'editor', group: 'Blocs',
    description: 'Vide l’intérieur plein de la sélection (garde une coque de 1).',
    params: [],
  },
  {
    id: 'overlay', label: 'Recouvrir', minRole: 'editor', group: 'Blocs',
    description: 'Pose un bloc juste au-dessus de la surface de chaque colonne.',
    params: [{ name: 'block', type: 'block', label: 'Bloc' }],
  },
  {
    id: 'naturalize', label: 'Naturaliser', minRole: 'editor', group: 'Blocs',
    description: 'Recouvre chaque surface d’une palette naturelle (surface / sous-sol / roche profonde mélangée). « Auto » suit le biome de chaque colonne ; « Personnalisé » utilise tes blocs.',
    params: [
      {
        name: 'preset', type: 'enum',
        values: ['plains', 'forest', 'savanna', 'swamp', 'desert', 'badlands', 'snowy', 'mountain', 'stony_peaks', 'mushroom', 'auto', 'custom'],
        labels: {
          plains: 'Plaine (herbe · pierre/andésite)', forest: 'Forêt', savanna: 'Savane (granite)',
          swamp: 'Marais (argile)', desert: 'Désert (sable/grès)', badlands: 'Mesa (terre cuite)',
          snowy: 'Neige', mountain: 'Montagne (pierre · andésite · cobble)', stony_peaks: 'Pic rocheux',
          mushroom: 'Champignon (mycélium)', auto: '🌍 Auto (selon le biome)', custom: 'Personnalisé',
        },
        default: 'plains', label: 'Palette',
      },
      { name: 'surface', type: 'block', label: 'Surface', showIf: { preset: 'custom' } },
      { name: 'soil', type: 'block', label: 'Sous-sol', showIf: { preset: 'custom' } },
      { name: 'filler', type: 'block', label: 'Roche profonde', showIf: { preset: 'custom' } },
    ],
  },
  {
    id: 'drain', label: 'Drainer (eau/lave)', minRole: 'editor', group: 'Blocs',
    description: 'Vide l’eau et la lave de la sélection (retire aussi le waterlogged).',
    params: [],
  },
  {
    id: 'cut', label: 'Couper (→ air)', minRole: 'editor', group: 'Blocs',
    description: 'Vide la sélection (tous les blocs → air) et la copie dans le presse-papier.',
    params: [],
  },
  {
    id: 'sphere', label: 'Sphère', minRole: 'editor', group: 'Formes',
    description: 'Remplit une boule centrée sur la sélection (pinceau). Creux = coque.',
    params: [
      { name: 'block', type: 'block', label: 'Bloc' },
      { name: 'radius', type: 'int', default: 4, label: 'Rayon' },
      { name: 'hollow', type: 'bool', default: false, label: 'Creux' },
    ],
  },
  {
    id: 'cyl', label: 'Cylindre', minRole: 'editor', group: 'Formes',
    description: 'Remplit un cylindre vertical centré sur la sélection (pinceau).',
    params: [
      { name: 'block', type: 'block', label: 'Bloc' },
      { name: 'radius', type: 'int', default: 4, label: 'Rayon' },
      { name: 'hollow', type: 'bool', default: false, label: 'Creux' },
    ],
  },
  {
    id: 'pyramid', label: 'Pyramide', minRole: 'editor', group: 'Formes',
    description: 'Pyramide à base carrée inscrite dans la sélection.',
    params: [
      { name: 'block', type: 'block', label: 'Bloc' },
      { name: 'hollow', type: 'bool', default: false, label: 'Creuse' },
    ],
  },
  {
    id: 'cone', label: 'Cône', minRole: 'editor', group: 'Formes',
    description: 'Cône à base ronde, rayon décroissant avec la hauteur.',
    params: [
      { name: 'block', type: 'block', label: 'Bloc' },
      { name: 'hollow', type: 'bool', default: false, label: 'Creux' },
    ],
  },
  {
    id: 'line', label: 'Ligne', minRole: 'editor', group: 'Formes',
    description: 'Trace une ligne droite entre le coin A et le coin B.',
    params: [{ name: 'block', type: 'block', label: 'Bloc' }],
  },
  {
    id: 'path', label: 'Tracé / route', minRole: 'editor', group: 'Formes',
    description: 'Chemin entre le coin A et le coin B (route, pont, rail, rambarde). Largeur + courbure réglables ; courbe = Bézier.',
    params: [
      {
        name: 'preset', type: 'enum',
        values: ['dirt_path', 'gravel', 'cobblestone', 'stone_bricks', 'planks', 'bridge', 'rail', 'fence'],
        labels: {
          dirt_path: 'Chemin de terre', gravel: 'Gravier', cobblestone: 'Pavé (cobblestone)',
          stone_bricks: 'Pierre taillée', planks: 'Planches', bridge: 'Pont (planches + rambardes)',
          rail: 'Rail (sur planches)', fence: 'Rambarde seule',
        },
        default: 'dirt_path', label: 'Type de chemin',
      },
      { name: 'width', type: 'int', default: 3, label: 'Largeur' },
      { name: 'bow', type: 'int', default: 0, label: 'Courbure (0 = droit)' },
      { name: 'block', type: 'block', label: 'Revêtement personnalisé (optionnel)' },
    ],
  },
  {
    id: 'smooth', label: 'Lisser (terrain)', minRole: 'editor', group: 'Formes',
    description: 'Adoucit la hauteur de la surface (type GoBrush).',
    params: [{ name: 'iterations', type: 'int', default: 2, label: 'Passes' }],
  },
  {
    id: 'erode', label: 'Éroder', minRole: 'editor', group: 'Formes',
    description: 'Ronge les blocs trop exposés à l’air (arrondit le terrain).',
    params: [
      { name: 'iterations', type: 'int', default: 1, label: 'Passes' },
      { name: 'threshold', type: 'int', default: 4, label: 'Seuil (faces air)' },
    ],
  },
  {
    id: 'dilate', label: 'Dilater', minRole: 'editor', group: 'Formes',
    description: 'Comble les creux (ajoute des blocs autour de la matière).',
    params: [
      { name: 'iterations', type: 'int', default: 1, label: 'Passes' },
      { name: 'threshold', type: 'int', default: 3, label: 'Seuil (voisins pleins)' },
    ],
  },
  {
    id: 'biome', label: 'Peindre biome', minRole: 'editor', group: 'Minecraft',
    description: 'Change le biome de la sélection (cellules de 4×4×4). N’affecte que les sections déjà présentes du build.',
    params: [{ name: 'biome', type: 'biome', values: BIOMES, default: 'minecraft:plains', label: 'Biome' }],
  },
  {
    id: 'terrain', label: 'Générer terrain', minRole: 'editor', group: 'Terrain',
    description: 'Sculpte des dénivelés naturels sur toute la sélection (bruit fractal). Le style change l’allure du relief ; remplit avec une palette naturelle et purge l’air au-dessus.',
    params: [
      {
        name: 'style', type: 'enum',
        values: ['plaine', 'collines', 'plateau', 'montagne', 'pic', 'crevasse'],
        labels: { plaine: 'Plaine (doux)', collines: 'Collines', plateau: 'Plateau', montagne: 'Montagne', pic: 'Pic (crêtes acérées)', crevasse: 'Crevasse (creusé)' },
        default: 'collines', label: 'Style de relief',
      },
      { name: 'amplitude', type: 'int', default: 100, label: 'Amplitude (%)' },
      { name: 'scale', type: 'int', default: 0, label: 'Échelle (0 = auto)' },
      { name: 'seed', type: 'int', default: 0, label: 'Graine (seed)' },
      {
        name: 'palette', type: 'enum',
        values: ['match', 'auto', 'plains', 'forest', 'savanna', 'swamp', 'desert', 'badlands', 'snowy', 'mountain', 'stony_peaks', 'mushroom', 'custom'],
        labels: {
          match: 'Selon le style', auto: '🌍 Auto (biome)', plains: 'Plaine', forest: 'Forêt', savanna: 'Savane',
          swamp: 'Marais', desert: 'Désert', badlands: 'Mesa', snowy: 'Neige', mountain: 'Montagne',
          stony_peaks: 'Pic rocheux', mushroom: 'Champignon', custom: 'Personnalisé',
        },
        default: 'match', label: 'Palette de blocs',
      },
      { name: 'clearAbove', type: 'bool', default: true, label: 'Purger l’air au-dessus' },
      { name: 'surface', type: 'block', label: 'Surface', showIf: { palette: 'custom' } },
      { name: 'soil', type: 'block', label: 'Sous-sol', showIf: { palette: 'custom' } },
      { name: 'filler', type: 'block', label: 'Roche profonde', showIf: { palette: 'custom' } },
    ],
  },
  {
    id: 'copy', label: 'Copier', minRole: 'editor', group: 'Presse-papier',
    description: 'Copie la sélection dans le presse-papier serveur (lié à la session).',
    params: [],
  },
  {
    id: 'paste', label: 'Coller', minRole: 'editor', group: 'Presse-papier',
    description: 'Colle le presse-papier au coin min de la sélection.',
    params: [{ name: 'mode', type: 'enum', values: ['overlay', 'overwrite'], default: 'overlay', label: 'Mode' }],
  },
];

export const OPERATION_IDS = new Set(OPERATIONS.map((o) => o.id));

// Normalise/valide les params d'une opération. Renvoie l'objet params nettoyé
// ou une chaîne d'erreur.
export function normalizeParams(operation, raw = {}) {
  const num = (v) => Math.round(Number(v));
  switch (operation) {
    case 'mirror': {
      const axis = String(raw.axis || '').toLowerCase();
      return ['x', 'y', 'z'].includes(axis) ? { axis } : 'bad_axis';
    }
    case 'mirrorcopy': {
      const axis = String(raw.axis || '').toLowerCase();
      if (!['x', 'y', 'z'].includes(axis)) return 'bad_axis';
      return {
        axis,
        side: raw.side === 'negative' ? 'negative' : 'positive',
        gap: Math.max(0, Math.min(512, num(raw.gap) || 0)),
        mode: raw.mode === 'overwrite' ? 'overwrite' : 'overlay',
      };
    }
    case 'rotate': {
      const degrees = num(raw.degrees);
      return [90, 180, 270].includes(degrees) ? { degrees } : 'bad_degrees';
    }
    case 'translate': {
      const [dx, dy, dz] = [raw.dx, raw.dy, raw.dz].map(num);
      if ([dx, dy, dz].some((v) => !Number.isFinite(v))) return 'bad_offset';
      return { dx, dy, dz };
    }
    case 'replace': {
      const from = normBlockList(raw.from);
      const to = normBlock(raw.to);
      if (!from || !to?.name) return 'bad_block';
      return { from, to };
    }
    case 'walls': case 'faces': case 'overlay': case 'line': {
      const block = normBlock(raw.block);
      return block?.name ? { block } : 'bad_block';
    }
    case 'set': {
      const block = normBlock(raw.block);
      return block?.name ? { block, mask: normMask(raw.mask) } : 'bad_block';
    }
    case 'sphere': case 'cyl': {
      const block = normBlock(raw.block);
      if (!block?.name) return 'bad_block';
      const radius = Math.max(1, Math.min(256, num(raw.radius) || 1));
      return { block, radius, hollow: !!raw.hollow };
    }
    case 'pyramid': case 'cone': {
      const block = normBlock(raw.block);
      return block?.name ? { block, hollow: !!raw.hollow } : 'bad_block';
    }
    case 'erode': case 'dilate':
      return { iterations: Math.max(1, Math.min(8, num(raw.iterations) || 1)), threshold: Math.max(1, Math.min(6, num(raw.threshold) || 3)) };
    case 'stack': {
      const direction = String(raw.direction || '').toLowerCase();
      if (!['east', 'west', 'up', 'down', 'south', 'north'].includes(direction)) return 'bad_direction';
      const count = Math.max(1, Math.min(64, num(raw.count) || 1));
      return { count, direction };
    }
    case 'smooth': return { iterations: Math.max(1, Math.min(8, num(raw.iterations) || 2)) };
    case 'mix': {
      const from = normBlock(raw.from); // null → toute la sélection
      const pattern = normPattern(raw.pattern);
      if (!pattern) return 'bad_pattern';
      return { from: from?.name ? from : null, pattern, mask: normMask(raw.mask) };
    }
    case 'scale': {
      const factor = Number(raw.factor);
      return [0.5, 2, 3, 4, 6].includes(factor) ? { factor, hollow: !!raw.hollow } : 'bad_factor';
    }
    case 'biome': {
      const biome = String(raw.biome || '').trim().toLowerCase();
      return /^[a-z0-9_]+:[a-z0-9_/]+$/.test(biome) ? { biome } : 'bad_biome';
    }
    case 'path': {
      const presets = ['dirt_path', 'gravel', 'cobblestone', 'stone_bricks', 'planks', 'bridge', 'rail', 'fence'];
      const preset = presets.includes(raw.preset) ? raw.preset : 'dirt_path';
      const width = Math.max(1, Math.min(16, num(raw.width) || 1));
      const bow = Math.max(-128, Math.min(128, num(raw.bow) || 0));
      const block = normBlock(raw.block); // revêtement personnalisé optionnel
      return { preset, width, bow, block: block?.name ? block : null };
    }
    case 'naturalize': {
      const presets = ['plains', 'forest', 'savanna', 'swamp', 'desert', 'badlands', 'snowy', 'mountain', 'stony_peaks', 'mushroom', 'auto', 'custom'];
      const preset = presets.includes(raw.preset) ? raw.preset : 'plains';
      if (preset !== 'custom') return { preset };
      return {
        preset,
        surface: normBlock(raw.surface)?.name || null,
        soil: normBlock(raw.soil)?.name || null,
        filler: normBlock(raw.filler)?.name || null,
      };
    }
    case 'terrain': {
      const styles = ['plaine', 'collines', 'plateau', 'montagne', 'pic', 'crevasse'];
      const palettes = ['match', 'auto', 'plains', 'forest', 'savanna', 'swamp', 'desert', 'badlands', 'snowy', 'mountain', 'stony_peaks', 'mushroom', 'custom'];
      const style = styles.includes(raw.style) ? raw.style : 'collines';
      const palette = palettes.includes(raw.palette) ? raw.palette : 'match';
      const amp = num(raw.amplitude);
      const out = {
        style, palette,
        seed: num(raw.seed) || 0,
        scale: Math.max(0, Math.min(256, num(raw.scale) || 0)),
        amplitude: Number.isFinite(amp) ? Math.max(0, Math.min(100, amp)) / 100 : 1,
        clearAbove: raw.clearAbove !== false && raw.clearAbove !== 'false',
      };
      if (palette === 'custom') {
        out.surface = normBlock(raw.surface)?.name || null;
        out.soil = normBlock(raw.soil)?.name || null;
        out.filler = normBlock(raw.filler)?.name || null;
      }
      return out;
    }
    case 'hollow': case 'drain': case 'copy': case 'cut': return {};
    case 'paste': return { mode: raw.mode === 'overwrite' ? 'overwrite' : 'overlay' };
    default: return 'unknown_operation';
  }
}

// { name, states? } — name doit ressembler à « namespace:id » (vanilla ou
// minefield), states est un dictionnaire de chaînes optionnel.
function normBlock(b) {
  if (!b) return null;
  const name = String(b.name || '').trim().toLowerCase();
  if (!/^[a-z0-9_]+:[a-z0-9_/.]+$/.test(name)) return null;
  let states = null;
  if (b.states && typeof b.states === 'object') {
    states = {};
    for (const [k, v] of Object.entries(b.states)) {
      if (/^[a-z0-9_]+$/.test(k)) states[k] = String(v).slice(0, 32);
    }
    if (!Object.keys(states).length) states = null;
  }
  return { name, states };
}

// Liste de blocs source (multi) pour le remplacement.
function normBlockList(arr) {
  const list = (Array.isArray(arr) ? arr : [arr]).map(normBlock).filter((b) => b?.name);
  return list.length ? list : null;
}

const MASK_TYPES = ['all', 'air', 'solid', 'exposed', 'on_surface', 'above', 'below'];
function normMask(m) {
  const type = MASK_TYPES.includes(m?.type) ? m.type : 'all';
  const out = { type };
  if (type === 'above' || type === 'below') out.y = Math.round(Number(m?.y)) || 0;
  return out;
}

// Liste pondérée [{ name, states?, weight>0 }] pour le mélange aléatoire (max 32).
function normPattern(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const e of arr) {
    const b = normBlock(e);
    const w = Number(e?.weight);
    if (b?.name && Number.isFinite(w) && w > 0) out.push({ name: b.name, states: b.states, weight: w });
    if (out.length >= 32) break;
  }
  return out.length ? out : null;
}
