// CATALOGUE DE BLOCS — ce qu'on peut poser, et comment le trouver.
//
// Jusqu'ici la palette de l'application ne listait que les blocs PRÉSENTS dans
// le build ouvert. Pratique pour reprendre un build qu'on n'a pas fait, inutile
// pour en commencer un : il fallait connaître l'identifiant par cœur et le
// taper. Ce module est la liste de ce qui existe.
//
// Pas de dépendance Node : le renderer l'importe directement, comme
// `blockPalette.js`. C'est de la donnée.
//
// Trois sources, dans cet ordre de confiance :
//   1. `VANILLA` — la palette de construction de Minecraft 1.18, écrite ici.
//   2. `MINEFIELD` — les blocs custom du serveur, DÉCLARÉS (voir plus bas).
//   3. les blocs découverts dans les builds ouverts (`mergeDiscovered`), qui
//      complètent les deux premières sans jamais les contredire.
//
// La 3 existe parce que la 2 ne peut pas être exhaustive depuis ce dépôt : les
// blocs `minefield:*` sont définis par le serveur, pas ici. Un bloc custom
// qu'on croise dans une save entre donc au catalogue tout seul, avec ses états.

/** Familles, dans l'ordre d'affichage. */
export const GROUPS = [
  { id: 'pierre', label: 'Pierre et roche' },
  { id: 'deepslate', label: 'Ardoise des abîmes' },
  { id: 'terre', label: 'Terre et herbe' },
  { id: 'sable', label: 'Sable et grès' },
  { id: 'bois', label: 'Bois' },
  { id: 'feuillage', label: 'Feuillage et plantes' },
  { id: 'brique', label: 'Briques et taillé' },
  { id: 'beton', label: 'Béton' },
  { id: 'terracotta', label: 'Terre cuite' },
  { id: 'laine', label: 'Laine et tapis' },
  { id: 'verre', label: 'Verre' },
  { id: 'metal', label: 'Métal et minerai' },
  { id: 'nether', label: 'Nether' },
  { id: 'end', label: 'End et Purpur' },
  { id: 'utilitaire', label: 'Utilitaire et redstone' },
  { id: 'liquide', label: 'Liquides et air' },
  { id: 'minefield', label: 'Minefield (custom)' },
  { id: 'autre', label: 'Autres' },
];

const GROUP_IDS = new Set(GROUPS.map((g) => g.id));

/** `pierre: 'stone cobblestone …'` → une entrée par identifiant. */
function famille(group, ids) {
  return ids.trim().split(/\s+/).map((id) => ({ id: `minecraft:${id}`, group }));
}

// ── Vanilla 1.18, palette de construction ────────────────────────────────────
// Volontairement PAS les 1 000 blocs du jeu : ni les plantes d'une seule
// hauteur, ni les têtes, ni les œufs de mob. Ce qu'on pose en masse dans une
// muraille, une arène ou une ville.
export const VANILLA = [
  ...famille('pierre', `
    stone smooth_stone stone_slab cobblestone mossy_cobblestone andesite polished_andesite
    diorite polished_diorite granite polished_granite calcite tuff dripstone_block
    gravel bedrock obsidian crying_obsidian amethyst_block budding_amethyst
    stone_stairs cobblestone_stairs cobblestone_wall mossy_cobblestone_wall
    andesite_stairs andesite_wall diorite_stairs diorite_wall granite_stairs granite_wall
  `),
  ...famille('deepslate', `
    deepslate cobbled_deepslate polished_deepslate chiseled_deepslate deepslate_bricks
    cracked_deepslate_bricks deepslate_tiles cracked_deepslate_tiles
    polished_deepslate_stairs polished_deepslate_wall deepslate_brick_stairs deepslate_brick_wall
    deepslate_tile_stairs deepslate_tile_wall smooth_basalt
  `),
  ...famille('terre', `
    dirt coarse_dirt rooted_dirt podzol mycelium grass_block dirt_path farmland
    clay mud packed_mud muddy_mangrove_roots moss_block snow_block powder_snow
  `),
  ...famille('sable', `
    sand red_sand sandstone chiseled_sandstone cut_sandstone smooth_sandstone
    red_sandstone chiseled_red_sandstone cut_red_sandstone smooth_red_sandstone
    sandstone_stairs sandstone_wall red_sandstone_stairs red_sandstone_wall
  `),
  ...famille('bois', `
    oak_log oak_wood stripped_oak_log stripped_oak_wood oak_planks oak_stairs oak_slab oak_fence
    spruce_log spruce_wood stripped_spruce_log stripped_spruce_wood spruce_planks spruce_stairs spruce_slab spruce_fence
    birch_log birch_wood stripped_birch_log stripped_birch_wood birch_planks birch_stairs birch_slab birch_fence
    jungle_log jungle_wood stripped_jungle_log jungle_planks jungle_stairs jungle_slab jungle_fence
    acacia_log acacia_wood stripped_acacia_log acacia_planks acacia_stairs acacia_slab acacia_fence
    dark_oak_log dark_oak_wood stripped_dark_oak_log dark_oak_planks dark_oak_stairs dark_oak_slab dark_oak_fence
    crimson_stem crimson_planks crimson_stairs crimson_slab crimson_fence
    warped_stem warped_planks warped_stairs warped_slab warped_fence
    bookshelf ladder scaffolding
  `),
  ...famille('feuillage', `
    oak_leaves spruce_leaves birch_leaves jungle_leaves acacia_leaves dark_oak_leaves
    azalea_leaves flowering_azalea_leaves vine glow_lichen hay_block bamboo
    pumpkin carved_pumpkin melon sea_lantern
  `),
  ...famille('brique', `
    bricks brick_stairs brick_wall stone_bricks mossy_stone_bricks cracked_stone_bricks
    chiseled_stone_bricks stone_brick_stairs stone_brick_wall mud_bricks mud_brick_stairs mud_brick_wall
    quartz_block chiseled_quartz_block quartz_pillar quartz_bricks smooth_quartz quartz_stairs
    prismarine prismarine_bricks dark_prismarine prismarine_stairs prismarine_wall
  `),
  ...famille('beton', `
    white_concrete light_gray_concrete gray_concrete black_concrete brown_concrete
    red_concrete orange_concrete yellow_concrete lime_concrete green_concrete
    cyan_concrete light_blue_concrete blue_concrete purple_concrete magenta_concrete pink_concrete
    white_concrete_powder gray_concrete_powder black_concrete_powder red_concrete_powder
  `),
  ...famille('terracotta', `
    terracotta white_terracotta light_gray_terracotta gray_terracotta black_terracotta
    brown_terracotta red_terracotta orange_terracotta yellow_terracotta lime_terracotta
    green_terracotta cyan_terracotta light_blue_terracotta blue_terracotta
    purple_terracotta magenta_terracotta pink_terracotta
    white_glazed_terracotta black_glazed_terracotta blue_glazed_terracotta
  `),
  ...famille('laine', `
    white_wool light_gray_wool gray_wool black_wool brown_wool red_wool orange_wool
    yellow_wool lime_wool green_wool cyan_wool light_blue_wool blue_wool
    purple_wool magenta_wool pink_wool
  `),
  ...famille('verre', `
    glass tinted_glass white_stained_glass gray_stained_glass black_stained_glass
    red_stained_glass orange_stained_glass yellow_stained_glass lime_stained_glass
    green_stained_glass cyan_stained_glass light_blue_stained_glass blue_stained_glass
    purple_stained_glass magenta_stained_glass pink_stained_glass
    glass_pane white_stained_glass_pane black_stained_glass_pane
  `),
  ...famille('metal', `
    iron_block gold_block diamond_block emerald_block netherite_block copper_block
    exposed_copper weathered_copper oxidized_copper cut_copper cut_copper_stairs
    coal_block raw_iron_block raw_copper_block raw_gold_block lapis_block redstone_block
    iron_bars chain anvil iron_ore copper_ore gold_ore diamond_ore coal_ore
    deepslate_iron_ore deepslate_diamond_ore
  `),
  ...famille('nether', `
    netherrack nether_bricks red_nether_bricks cracked_nether_bricks chiseled_nether_bricks
    nether_brick_stairs nether_brick_wall nether_brick_fence blackstone polished_blackstone
    chiseled_polished_blackstone polished_blackstone_bricks cracked_polished_blackstone_bricks
    gilded_blackstone basalt polished_basalt magma_block soul_sand soul_soil
    glowstone shroomlight nether_wart_block warped_wart_block
  `),
  ...famille('end', `
    end_stone end_stone_bricks end_stone_brick_stairs end_stone_brick_wall
    purpur_block purpur_pillar purpur_stairs purpur_slab
  `),
  ...famille('utilitaire', `
    barrel chest trapped_chest furnace blast_furnace smoker crafting_table
    lantern soul_lantern torch soul_torch campfire soul_campfire
    redstone_lamp note_block jukebox target observer piston sticky_piston
    dispenser dropper hopper lever stone_button oak_button repeater comparator
    oak_door oak_trapdoor iron_door iron_trapdoor oak_sign
    white_bed bell beacon
  `),
  ...famille('liquide', 'water lava air cave_air'),
];

// ── Blocs Minefield (custom) ─────────────────────────────────────────────────
//
// ATTENTION : cette liste est la seule partie de ce fichier qui ne peut pas
// être vérifiée depuis ce dépôt — les blocs `minefield:*` sont définis par le
// serveur. N'y figurent que ceux réellement ATTESTÉS dans le code (fixtures et
// tests). Le reste arrive par deux chemins, et aucun ne demande de toucher à ce
// fichier :
//
//   - `mergeDiscovered` : tout `minefield:*` croisé dans un build ouvert entre
//     au catalogue avec ses états ;
//   - `blocks.json` du dossier de données (voir `readBlockExtras` côté hôte) :
//     coller la liste du serveur la rend disponible sans recompiler.
//
// Inventer des identifiants plausibles serait pire que d'en avoir peu :
// l'invariant n° 3 dit qu'un `minefield:*` n'est JAMAIS remappé vanilla, donc
// un identifiant faux s'écrirait tel quel dans le monde et n'y rendrait rien.
export const MINEFIELD = [
  { id: 'minefield:quart_de_bloc', group: 'minefield', states: { facing: ['north', 'east', 'south', 'west'] } },
  { id: 'minefield:quart_de_bloc_custom', group: 'minefield', states: { facing: ['north', 'east', 'south', 'west'] } },
];

export const CATALOG = [...VANILLA, ...MINEFIELD];

// ── Recherche ────────────────────────────────────────────────────────────────
//
// Un builder francophone tape « pierre », pas « stone ». Sans alias, la palette
// ne répond rien à la moitié des recherches qu'on lui fait.
const ALIAS = {
  pierre: 'stone', caillou: 'cobblestone', pave: 'cobblestone', roche: 'stone',
  ardoise: 'deepslate', terre: 'dirt', herbe: 'grass', boue: 'mud', argile: 'clay',
  sable: 'sand', gres: 'sandstone', bois: 'planks log', planche: 'planks',
  rondin: 'log', chene: 'oak', sapin: 'spruce', bouleau: 'birch', jungle: 'jungle',
  acacia: 'acacia', feuille: 'leaves', feuillage: 'leaves', liane: 'vine',
  brique: 'brick', taille: 'chiseled', poli: 'polished', lisse: 'smooth',
  escalier: 'stairs', dalle: 'slab', mur: 'wall', barriere: 'fence', cloture: 'fence',
  beton: 'concrete', cuite: 'terracotta', laine: 'wool', verre: 'glass', vitre: 'glass_pane',
  fer: 'iron', or: 'gold', diamant: 'diamond', emeraude: 'emerald', cuivre: 'copper',
  charbon: 'coal', lapis: 'lapis', redstone: 'redstone', minerai: 'ore',
  neige: 'snow', glace: 'ice', eau: 'water', lave: 'lava', air: 'air',
  quartz: 'quartz', lanterne: 'lantern', torche: 'torch', coffre: 'chest',
  porte: 'door', trappe: 'trapdoor', echelle: 'ladder', enclume: 'anvil',
  citrouille: 'pumpkin', foin: 'hay', mousse: 'moss', champignon: 'mushroom mycelium',
  quart: 'quart_de_bloc', custom: 'minefield', mf: 'minefield',
};

/** « Pierre Taillée » → « pierre taillee » : sans accent, sans casse. */
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Nom lisible : `minecraft:stone_bricks` → `stone bricks`. */
export const blockLabel = (id) => String(id).replace(/^minecraft:/, '').replace(/_/g, ' ');

/**
 * Filtre un catalogue. Chaque mot de la requête doit se retrouver quelque part
 * (identifiant ou alias) : « mur pierre » trouve `stone_brick_wall`, dans
 * l'ordre qu'on veut.
 */
export function searchBlocks(catalog, query) {
  const mots = fold(query).split(/\s+/).filter(Boolean);
  if (!mots.length) return catalog;
  return catalog.filter((b) => {
    const cible = fold(b.id);
    return mots.every((m) => cible.includes(m) || (ALIAS[m] || '').split(' ').some((a) => a && cible.includes(a)));
  });
}

/**
 * Ajoute au catalogue les blocs vus dans un build et qu'il ne connaît pas.
 *
 * C'est ce qui rend les blocs `minefield:*` d'un serveur utilisables sans que
 * ce dépôt ait à les connaître : ouvrir un build où ils figurent suffit.
 *
 * @param {{id:string,group:string}[]} catalog
 * @param {string[]} ids identifiants relevés (nomenclature du build)
 */
export function mergeDiscovered(catalog, ids) {
  const connus = new Set(catalog.map((b) => b.id));
  const ajouts = [];
  for (const id of ids || []) {
    if (!id || connus.has(id)) continue;
    connus.add(id);
    ajouts.push({ id, group: id.startsWith('minefield:') ? 'minefield' : 'autre', discovered: true });
  }
  return ajouts.length ? [...catalog, ...ajouts] : catalog;
}

/**
 * Normalise une liste de blocs supplémentaires venue d'un fichier de données
 * (`blocks.json`), donc éditée à la main. On refuse au lieu d'assainir : un
 * identifiant mal formé écrit tel quel dans une région n'y rendrait rien.
 */
export function normalizeExtras(raw) {
  const list = Array.isArray(raw) ? raw : raw?.blocks;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    const id = String((typeof e === 'string' ? e : e?.id) || '').trim().toLowerCase();
    if (!/^[a-z0-9_]+:[a-z0-9_/.]+$/.test(id)) continue;
    const group = GROUP_IDS.has(e?.group) ? e.group : (id.startsWith('minefield:') ? 'minefield' : 'autre');
    const entree = { id, group, declared: true };
    // Couleur d'aperçu facultative. Sans elle un bloc inconnu reçoit une teinte
    // dérivée de son nom — lisible, mais sans rapport avec le bloc. La déclarer
    // est le seul moyen qu'un `minefield:*` s'affiche juste, tant qu'il n'y a
    // pas d'atlas de textures.
    const c = e?.color;
    if (Array.isArray(c) && c.length === 3 && c.every((v) => Number.isFinite(v))) {
      entree.color = c.map((v) => Math.max(0, Math.min(255, Math.round(v))));
    }
    out.push(entree);
    if (out.length >= 4096) break;
  }
  return out;
}
