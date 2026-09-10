import test from 'node:test';
import assert from 'node:assert/strict';
import { meshChunk, P } from '../src/renderer/viewport/mesher.js';
import { sparseToChunks, paddedChunk, CH } from '../src/renderer/viewport/voxels.js';

// Le mailleur se teste sans navigateur : c'est tout l'intérêt de l'avoir sorti
// du worker. Un mailleur qu'on ne vérifie qu'à l'œil dans une fenêtre est un
// mailleur qu'on ne vérifie pas — et une face manquante au milieu d'un build de
// 800 000 blocs ne se voit pas.

const pIdx = (x, y, z) => ((y + 1) * P + (z + 1)) * P + (x + 1);
const OPAQUE = new Uint8Array([0, 1, 1]);
const COLORS = new Uint8Array([0, 0, 0, 200, 100, 50, 40, 180, 90]);

const emptyChunk = () => new Uint16Array(P * P * P);

test('un bloc isolé donne exactement six faces', () => {
  const ids = emptyChunk();
  ids[pIdx(8, 8, 8)] = 1;
  const m = meshChunk(ids, OPAQUE, COLORS);
  assert.equal(m.quads, 6);
  assert.equal(m.positions.length / 3, 24, 'quatre sommets par face, non partagés');
  assert.equal(m.indices.length, 36);
});

test('deux blocs collés : la face commune disparaît et le reste fusionne', () => {
  const ids = emptyChunk();
  ids[pIdx(8, 8, 8)] = 1;
  ids[pIdx(9, 8, 8)] = 1;
  const m = meshChunk(ids, OPAQUE, COLORS);
  // Les deux faces qui se touchent ne sont pas émises, et les quatre côtés
  // longs (dessus, dessous, nord, sud) fusionnent chacun en UN quad de 2×1 :
  // 4 fusionnés + les 2 bouts en X = 6.
  assert.equal(m.quads, 6);
  // Le volume mesure bien 2 blocs de long : au moins un quad couvre 2 unités.
  const xs = [];
  for (let i = 0; i < m.positions.length; i += 3) xs.push(m.positions[i]);
  assert.equal(Math.max(...xs) - Math.min(...xs), 2, 'le maillage s’étend sur les deux blocs');
});

test('greedy : un mur plat coûte le même nombre de quads qu’un seul bloc', () => {
  const ids = emptyChunk();
  for (let x = 0; x < CH; x++) for (let z = 0; z < CH; z++) ids[pIdx(x, 0, z)] = 1;
  const m = meshChunk(ids, OPAQUE, COLORS);
  // Dessus et dessous fusionnent chacun en UN quad ; restent les 4 bords,
  // eux aussi fusionnés en un quad chacun. Sans fusion gloutonne ce serait
  // 256 × 6 = 1536.
  assert.equal(m.quads, 6, `attendu 6 quads pour une dalle 16×16, obtenu ${m.quads}`);
});

test('la fusion ne franchit pas une frontière de bloc différent', () => {
  const ids = emptyChunk();
  for (let x = 0; x < CH; x++) for (let z = 0; z < CH; z++) ids[pIdx(x, 0, z)] = x < 8 ? 1 : 2;
  const m = meshChunk(ids, OPAQUE, COLORS);
  // Deux matières → dessus et dessous se scindent en deux, les bords aussi.
  assert.ok(m.quads > 6, 'deux matières ne peuvent pas fusionner en un seul quad');
});

test('un voisin dans le padding supprime la face qu’il cache', () => {
  const bare = emptyChunk();
  bare[pIdx(0, 8, 8)] = 1;
  const alone = meshChunk(bare, OPAQUE, COLORS);

  const withNeighbour = emptyChunk();
  withNeighbour[pIdx(0, 8, 8)] = 1;
  withNeighbour[pIdx(-1, 8, 8)] = 1; // le voisin, dans la couche de padding
  const covered = meshChunk(withNeighbour, OPAQUE, COLORS);

  assert.equal(alone.quads, 6);
  assert.equal(covered.quads, 5, 'la face contre le voisin ne doit pas être émise');
});

test('un bloc translucide ne cache pas ce qu’il y a derrière', () => {
  const ids = emptyChunk();
  ids[pIdx(8, 8, 8)] = 1;
  ids[pIdx(9, 8, 8)] = 2;
  // id 2 déclaré non opaque : la face entre les deux doit réapparaître.
  const m = meshChunk(ids, new Uint8Array([0, 1, 0]), COLORS);
  assert.equal(m.quads, 6, 'seul le bloc plein est maillé, avec ses six faces');
});

test('l’occlusion ambiante assombrit un coin fermé', () => {
  // Un bloc au sol contre un mur : le coin intérieur doit être plus sombre que
  // le coin libre. C'est ce qui donne le relief sans la moindre lumière.
  const ids = emptyChunk();
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) ids[pIdx(x, 0, z)] = 1;
  for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) ids[pIdx(0, y, z)] = 1;
  const m = meshChunk(ids, OPAQUE, COLORS);

  const luminances = [];
  for (let i = 0; i < m.colors.length; i += 3) {
    luminances.push(m.colors[i] + m.colors[i + 1] + m.colors[i + 2]);
  }
  const min = Math.min(...luminances);
  const max = Math.max(...luminances);
  assert.ok(max > min * 1.3, `l’AO doit créer un écart net (min ${min}, max ${max})`);
});

test('les couleurs sortent de la table fournie, teintées par la face', () => {
  const ids = emptyChunk();
  ids[pIdx(8, 8, 8)] = 1;
  const m = meshChunk(ids, OPAQUE, COLORS);
  // Rouge dominant sur toutes les faces : l'ombrage module, il ne recolore pas.
  for (let i = 0; i < m.colors.length; i += 3) {
    assert.ok(m.colors[i] > m.colors[i + 1], 'le rouge reste dominant');
    assert.ok(m.colors[i + 1] > m.colors[i + 2], 'le vert reste devant le bleu');
  }
});

test('les indices restent dans les bornes des sommets', () => {
  const ids = emptyChunk();
  for (let x = 0; x < CH; x++) for (let y = 0; y < 5; y++) for (let z = 0; z < CH; z++) {
    if ((x + y + z) % 3) ids[pIdx(x, y, z)] = 1 + ((x + z) % 2);
  }
  const m = meshChunk(ids, OPAQUE, COLORS);
  const verts = m.positions.length / 3;
  for (const i of m.indices) assert.ok(i >= 0 && i < verts, `indice ${i} hors bornes (${verts} sommets)`);
  assert.equal(m.colors.length / 3, verts, 'une couleur par sommet');
});

// ── Découpage en chunks ─────────────────────────────────────────────────────

test('sparseToChunks range les blocs dans le bon chunk et la bonne case', () => {
  const sparse = {
    min: { x: 0, y: 0, z: 0 },
    palette: [{ name: 'minecraft:stone' }],
    blocks: [1, 2, 3, 0, 17, 2, 3, 0],
  };
  const chunks = sparseToChunks(sparse);
  assert.deepEqual([...chunks.keys()].sort(), ['0,0,0', '1,0,0']);
  assert.equal(chunks.get('0,0,0')[(2 * CH + 3) * CH + 1], 1);
  assert.equal(chunks.get('1,0,0')[(2 * CH + 3) * CH + 1], 1, 'x=17 → chunk 1, local 1');
});

test('sparseToChunks gère les coordonnées négatives', () => {
  const sparse = {
    min: { x: -20, y: -64, z: -5 },
    palette: [{ name: 'minecraft:stone' }],
    blocks: [0, 0, 0, 0],
  };
  const chunks = sparseToChunks(sparse);
  // (-20, -64, -5) → chunk (-2, -4, -1), local (12, 0, 11)
  const grid = chunks.get('-2,-4,-1');
  assert.ok(grid, 'un chunk négatif doit exister');
  assert.equal(grid[(0 * CH + 11) * CH + 12], 1);
});

test('paddedChunk recopie la face ENTIÈRE de chaque voisin', () => {
  const chunks = new Map();
  const self = new Uint16Array(CH ** 3);
  const east = new Uint16Array(CH ** 3);
  // Le voisin est plein sur toute la rangée qui nous touche (x local 0).
  for (let y = 0; y < CH; y++) for (let z = 0; z < CH; z++) east[(y * CH + z) * CH + 0] = 2;
  chunks.set('0,0,0', self);
  chunks.set('1,0,0', east);

  const padded = paddedChunk(chunks, 0, 0, 0);
  let copied = 0;
  for (let y = 0; y < CH; y++) for (let z = 0; z < CH; z++) {
    if (padded[((y + 1) * P + (z + 1)) * P + (CH + 1)] === 2) copied++;
  }
  // C'était le bug : une version antérieure n'en recopiait que 16 (la diagonale).
  assert.equal(copied, CH * CH, 'les 256 cases de la face doivent être copiées');
});

test('paddedChunk copie les six directions', () => {
  const chunks = new Map();
  chunks.set('0,0,0', new Uint16Array(CH ** 3));
  const dirs = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
  for (const [dx, dy, dz] of dirs) {
    const g = new Uint16Array(CH ** 3);
    g.fill(3);
    chunks.set(`${dx},${dy},${dz}`, g);
  }
  const padded = paddedChunk(chunks, 0, 0, 0);
  const at = (x, y, z) => padded[((y + 1) * P + (z + 1)) * P + (x + 1)];
  assert.equal(at(-1, 8, 8), 3, 'voisin ouest');
  assert.equal(at(CH, 8, 8), 3, 'voisin est');
  assert.equal(at(8, -1, 8), 3, 'voisin dessous');
  assert.equal(at(8, CH, 8), 3, 'voisin dessus');
  assert.equal(at(8, 8, -1), 3, 'voisin nord');
  assert.equal(at(8, 8, CH), 3, 'voisin sud');
});

test('deux chunks adjacents pleins ne produisent aucune face entre eux', () => {
  const chunks = new Map();
  const a = new Uint16Array(CH ** 3).fill(1);
  const b = new Uint16Array(CH ** 3).fill(1);
  chunks.set('0,0,0', a);
  chunks.set('1,0,0', b);

  const m = meshChunk(paddedChunk(chunks, 0, 0, 0), OPAQUE, COLORS);
  // Un cube plein isolé donnerait 6 faces ; avec un voisin plein à l'est il
  // n'en reste que 5. Sans le padding, la frontière afficherait un mur.
  assert.equal(m.quads, 5);
});
