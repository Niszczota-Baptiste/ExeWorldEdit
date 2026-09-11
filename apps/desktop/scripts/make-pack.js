/* eslint-disable security/detect-non-literal-fs-filename --
   Script de développement : la racine vient de la ligne de commande, et tout
   le reste est joint dessus à partir de noms constants. */
// Fabrique un pack de ressources de DÉMONSTRATION.
//
//   node scripts/make-pack.js <dossier>
//
// Ce ne sont PAS les assets de Minecraft — on ne peut pas les redistribuer, et
// un .jar commité serait opaque en revue exactement comme un .mca. Ce sont des
// textures générées, sous la vraie arborescence d'un pack, avec ce qu'il faut
// pour exercer chaque cas du résolveur d'icônes :
//
//   - des cubes pleins (`cube_all`),
//   - un bloc à faces différentes (`grass_block`),
//   - une dalle, qui n'est pas un cube,
//   - deux blocs `minefield:*`, dont une CHAISE en six cuboïdes.
//
// Pour de vraies icônes, désigner dans les réglages le `.jar` d'une version de
// Minecraft ou le pack du serveur.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = process.argv[2];
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
/** PNG 16×16 RGBA depuis une fonction (x, y) → [r,g,b]. */
function png16(f) {
  const N = 16;
  const brut = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) {
    const ligne = y * (N * 4 + 1);
    brut[ligne] = 0; // filtre « none »
    for (let x = 0; x < N; x++) {
      const [r, g, b] = f(x, y);
      const i = ligne + 1 + x * 4;
      brut[i] = r; brut[i + 1] = g; brut[i + 2] = b; brut[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(brut)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** Bruit stable, pour que les textures ne soient pas des aplats. */
const grain = (base, amp, seed) => (x, y) => {
  let h = Math.imul(x * 374761393 + y * 668265263 + seed, 1274126177);
  h = (h ^ (h >>> 15)) >>> 0;
  const d = ((h % 255) / 255 - 0.5) * amp;
  return base.map((c) => Math.max(0, Math.min(255, Math.round(c + d))));
};

const ecrire = (rel, buf) => {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.isBuffer(buf) ? buf : JSON.stringify(buf, null, 1));
};

fs.rmSync(OUT, { recursive: true, force: true });
ecrire('pack.mcmeta', { pack: { pack_format: 8, description: 'Pack de démonstration' } });

// ── Modèles de base, comme dans le jeu ───────────────────────────────────────
const FACES = ['down', 'up', 'north', 'south', 'west', 'east'];
ecrire('assets/minecraft/models/block/cube.json', {
  elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(FACES.map((f) => [f, { texture: `#${f}` }])) }],
});
ecrire('assets/minecraft/models/block/cube_all.json', {
  parent: 'block/cube',
  textures: Object.fromEntries([...FACES, 'particle'].map((f) => [f, '#all'])),
});

// ── Blocs vanilla ────────────────────────────────────────────────────────────
const CUBES = {
  stone: [125, 125, 125], cobblestone: [122, 122, 122], dirt: [134, 96, 67],
  andesite: [136, 136, 137], gravel: [131, 127, 126], sand: [219, 207, 163],
  oak_planks: [162, 130, 78], stone_bricks: [122, 122, 122], bricks: [150, 97, 83],
  quartz_block: [235, 229, 222], blackstone: [42, 35, 40], snow_block: [249, 254, 254],
};
Object.entries(CUBES).forEach(([nom, couleur], i) => {
  ecrire(`assets/minecraft/blockstates/${nom}.json`, { variants: { '': { model: `minecraft:block/${nom}` } } });
  ecrire(`assets/minecraft/models/block/${nom}.json`, { parent: 'minecraft:block/cube_all', textures: { all: `minecraft:block/${nom}` } });
  ecrire(`assets/minecraft/textures/block/${nom}.png`, png16(grain(couleur, 46, i * 97 + 3)));
});

// Un bloc à faces DIFFÉRENTES, pour vérifier que chaque face prend la sienne.
ecrire('assets/minecraft/blockstates/grass_block.json', { variants: { 'snowy=false': { model: 'minecraft:block/grass_block' } } });
ecrire('assets/minecraft/models/block/grass_block.json', {
  parent: 'block/cube',
  textures: {
    up: 'minecraft:block/grass_block_top', north: 'minecraft:block/grass_block_side',
    east: 'minecraft:block/grass_block_side', south: 'minecraft:block/grass_block_side',
    west: 'minecraft:block/grass_block_side', down: 'minecraft:block/dirt', particle: 'minecraft:block/dirt',
  },
});
ecrire('assets/minecraft/textures/block/grass_block_top.png', png16(grain([116, 156, 74], 40, 11)));
ecrire('assets/minecraft/textures/block/grass_block_side.png', png16((x, y) => (y < 4 ? grain([116, 156, 74], 40, 11)(x, y) : grain([134, 96, 67], 40, 5)(x, y))));

// Une DALLE : pas un cube, mais vanilla.
ecrire('assets/minecraft/blockstates/stone_slab.json', { variants: { 'type=bottom': { model: 'minecraft:block/stone_slab' } } });
ecrire('assets/minecraft/models/block/stone_slab.json', {
  textures: { all: 'minecraft:block/stone' },
  elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: Object.fromEntries(FACES.map((f) => [f, { texture: '#all' }])) }],
});

// ── Blocs minefield ──────────────────────────────────────────────────────────
ecrire('assets/minefield/textures/block/chene_taille.png', png16(grain([150, 110, 62], 50, 71)));
ecrire('assets/minefield/textures/block/muraille.png', png16(grain([118, 114, 106], 60, 23)));

ecrire('assets/minefield/blockstates/muraille.json', { variants: { '': { model: 'minefield:block/muraille' } } });
ecrire('assets/minefield/models/block/muraille.json', { parent: 'minecraft:block/cube_all', textures: { all: 'minefield:block/muraille' } });

const bois = Object.fromEntries(FACES.map((f) => [f, { texture: '#bois' }]));
ecrire('assets/minefield/blockstates/chaise.json', { variants: { 'facing=north': { model: 'minefield:block/chaise' } } });
ecrire('assets/minefield/models/block/chaise.json', {
  textures: { bois: 'minefield:block/chene_taille', particle: 'minefield:block/chene_taille' },
  elements: [
    { from: [2, 6, 2], to: [14, 8, 14], faces: bois },      // assise
    { from: [2, 8, 12], to: [14, 20, 14], faces: bois },    // dossier
    { from: [2, 0, 2], to: [4, 6, 4], faces: bois },        // pieds
    { from: [12, 0, 2], to: [14, 6, 4], faces: bois },
    { from: [2, 0, 12], to: [4, 6, 14], faces: bois },
    { from: [12, 0, 12], to: [14, 6, 14], faces: bois },
  ],
});

// Un quart de bloc, celui qu'on croise dans les tests du moteur.
ecrire('assets/minefield/blockstates/quart_de_bloc.json', { variants: { 'facing=north': { model: 'minefield:block/quart_de_bloc' } } });
ecrire('assets/minefield/models/block/quart_de_bloc.json', {
  textures: { all: 'minefield:block/muraille' },
  elements: [{ from: [0, 0, 0], to: [8, 8, 16], faces: Object.fromEntries(FACES.map((f) => [f, { texture: '#all' }])) }],
});

const compte = (d) => fs.readdirSync(d, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? compte(path.join(d, e.name)) : 1), 0);
console.log(`pack écrit : ${OUT} (${compte(OUT)} fichiers)`);
