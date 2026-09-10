// Couleur d'un bloc, en attendant l'atlas de textures (phase 2.5).
//
// La base vient des VRAIES couleurs de carte du jeu, exportées par le moteur
// (`flatBlockColors`) : ~60 blocs dont la couleur n'est pas une approximation.
// Le complément ci-dessous couvre ce qu'un build utilise constamment et qui
// n'a pas de couleur de carte propre.
//
// Un bloc totalement inconnu — un `minefield:*` par exemple — reçoit une teinte
// dérivée de son nom : stable d'une session à l'autre, distincte de ses
// voisines, et jamais du gris uniforme qui rendrait le build illisible.

import { flatBlockColors } from '@titi/we-engine/colors';

const EXTRA = {
  'minecraft:cobblestone': [127, 127, 127],
  'minecraft:mossy_cobblestone': [110, 121, 100],
  'minecraft:stone_bricks': [122, 122, 122],
  'minecraft:mossy_stone_bricks': [113, 120, 103],
  'minecraft:cracked_stone_bricks': [118, 117, 113],
  'minecraft:chiseled_stone_bricks': [119, 119, 119],
  'minecraft:polished_deepslate': [72, 72, 74],
  'minecraft:dirt_path': [148, 121, 65],
  'minecraft:podzol': [91, 63, 26],
  'minecraft:oak_leaves': [60, 92, 34],
  'minecraft:andesite': [136, 136, 137],
  'minecraft:polished_andesite': [132, 135, 133],
  'minecraft:granite': [149, 103, 85],
  'minecraft:diorite': [188, 188, 189],
  'minecraft:gravel': [131, 127, 126],
  'minecraft:coarse_dirt': [119, 85, 59],
  'minecraft:grass_block': [116, 156, 74],
  'minecraft:oak_log': [102, 81, 50],
  'minecraft:spruce_log': [58, 43, 26],
  'minecraft:birch_log': [216, 215, 210],
  'minecraft:spruce_planks': [114, 84, 48],
  'minecraft:birch_planks': [192, 175, 121],
  'minecraft:dark_oak_planks': [66, 43, 20],
  'minecraft:spruce_leaves': [45, 76, 45],
  'minecraft:birch_leaves': [128, 167, 85],
  'minecraft:snow_block': [249, 254, 254],
  'minecraft:ice': [145, 183, 253],
  'minecraft:glass': [175, 213, 219],
  'minecraft:bricks': [150, 97, 83],
  'minecraft:smooth_stone': [158, 158, 158],
  'minecraft:calcite': [223, 222, 216],
  'minecraft:tuff': [108, 109, 102],
  'minecraft:deepslate_bricks': [72, 72, 74],
  'minecraft:cobbled_deepslate': [77, 77, 82],
  'minecraft:sandstone': [216, 203, 155],
  'minecraft:blackstone': [42, 35, 40],
  'minecraft:basalt': [80, 80, 86],
  'minecraft:lava': [207, 92, 21],
};

const cache = new Map();

function hashColor(name) {
  // FNV-1a : deux noms proches donnent des teintes bien séparées.
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hue = (h % 360) / 360;
  // Saturation et clarté bornées : une palette de repli doit rester sobre à
  // côté des vraies couleurs, pas crier plus fort qu'elles.
  return hslToRgb(hue, 0.26, 0.52);
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

let base = null;
function table() {
  if (base) return base;
  base = new Map();
  for (const { block, r, g, b } of flatBlockColors()) base.set(block, [r, g, b]);
  for (const [name, rgb] of Object.entries(EXTRA)) base.set(name, rgb);
  return base;
}

/** @returns {[number, number, number]} */
export function blockColor(name) {
  let c = cache.get(name);
  if (c) return c;
  c = table().get(name);
  if (!c) {
    // Un bloc dérivé hérite de la couleur de sa souche : `_stairs`, `_slab`,
    // `_wall` et compagnie ne méritent pas une teinte inventée.
    const stem = name.replace(/_(stairs|slab|wall|fence|fence_gate|button|pressure_plate|trapdoor|door|sign|pane)$/, '');
    c = table().get(stem) || hashColor(name);
  }
  cache.set(name, c);
  return c;
}

/**
 * Blocs qui ne cachent pas ce qu'il y a derrière : le mailleur doit garder les
 * faces de leurs voisins, sinon un mur derrière une vitre disparaît.
 */
const SEE_THROUGH = /(glass|_pane|water|lava|leaves|air|torch|ladder|vine|rail|sapling|grass$|fern|flower|barrier|light)/;
export const isOpaque = (name) => !SEE_THROUGH.test(name);

/**
 * sRGB → linéaire.
 *
 * `blockColor` rend du sRGB, parce que c'est ce que veulent les pastilles de
 * la palette (le CSS est en sRGB). Mais three.js traite les couleurs de sommet
 * comme LINÉAIRES et les réencode en sRGB à l'affichage : envoyer du sRGB tel
 * quel le fait passer deux fois dans l'encodage, et tout le build ressort
 * délavé. La conversion appartient donc ici, au seuil du moteur de rendu.
 *
 * Multiplier l'ombrage et l'occlusion en linéaire est aussi le geste juste :
 * c'est là que « moitié moins de lumière » veut dire moitié moins.
 */
const srgbToLinear = (c) => {
  const s = c / 255;
  return Math.round(255 * (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
};

/**
 * Tables prêtes pour le worker : indexées par identifiant (index de palette + 1,
 * 0 = air). Envoyées telles quelles, sans conversion côté worker.
 */
export function buildTables(palette) {
  const n = palette.length + 1;
  const colors = new Uint8Array(n * 3);
  const opaque = new Uint8Array(n);
  for (let i = 0; i < palette.length; i++) {
    const name = palette[i].name;
    const [r, g, b] = blockColor(name);
    colors[(i + 1) * 3] = srgbToLinear(r);
    colors[(i + 1) * 3 + 1] = srgbToLinear(g);
    colors[(i + 1) * 3 + 2] = srgbToLinear(b);
    opaque[i + 1] = isOpaque(name) ? 1 : 0;
  }
  return { colors, opaque };
}
