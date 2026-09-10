import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeBlockStates, encodeBlockStates, bitsForPalette, pairToBig, SECTION_VOLUME,
} from '../src/anvil/index.js';

// Le dépack de section a été réécrit en arithmétique 32 bits pour supprimer un
// BigInt par bloc (85 % du temps de chargement d'une région, cf. bench).
//
// Une réécriture de manipulation de bits ne se relit pas : elle se COMPARE.
// L'implémentation d'origine, en BigInt, est reproduite ici comme référence et
// doit rendre exactement les mêmes indices, sur toutes les largeurs de palette.

/**
 * Le dépack d'origine, mot pour mot. À garder GELÉ : c'est le juge, pas du code
 * de production. S'il diverge de `decodeBlockStates`, c'est ce dernier qu'il
 * faut regarder.
 */
function referenceUnpack(palette, data) {
  const indices = new Uint16Array(SECTION_VOLUME);
  if (!Array.isArray(data) || data.length === 0 || palette.length <= 1) return indices;
  const bits = bitsForPalette(palette.length);
  const mask = (1n << BigInt(bits)) - 1n;
  const perLong = Math.floor(64 / bits);
  const longs = data.map(pairToBig);
  for (let n = 0; n < SECTION_VOLUME; n++) {
    const li = Math.floor(n / perLong);
    const within = n % perLong;
    indices[n] = Number((longs[li] >> BigInt(within * bits)) & mask);
  }
  return indices;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

const paletteOf = (n) => Array.from({ length: n }, (_, i) => ({
  Name: i === 0 ? 'minecraft:air' : `minecraft:bloc_${i}`,
  Properties: null,
}));

/** Section aléatoire mais reproductible, pour une taille de palette donnée. */
function randomSection(paletteSize, seed) {
  const rand = rng(seed);
  const palette = paletteOf(paletteSize);
  const indices = new Uint16Array(SECTION_VOLUME);
  for (let i = 0; i < SECTION_VOLUME; i++) indices[i] = (rand() * paletteSize) | 0;
  return { palette, indices };
}

// Les largeurs testées couvrent chaque cas de figure du dépack :
//   4 bits  → 16 par long, aucun index à cheval sur les 32 bits
//   5 bits  → 12 par long, l'index n° 6 est à cheval (30 → 35)
//   6 bits  → 10 par long, à cheval aussi, et 4 bits perdus en fin de long
//   8 bits  → 8 par long, aligné pile sur la frontière
//   ...
//   12 bits → la largeur maximale d'une palette de section
const WIDTHS = [
  { bits: 4, size: 16 },
  { bits: 5, size: 17 },
  { bits: 5, size: 32 },
  { bits: 6, size: 33 },
  { bits: 6, size: 64 },
  { bits: 7, size: 65 },
  { bits: 8, size: 200 },
  { bits: 9, size: 300 },
  { bits: 10, size: 600 },
  { bits: 11, size: 1100 },
  { bits: 12, size: 2500 },
];

for (const { bits, size } of WIDTHS) {
  test(`dépack ${bits} bits (palette de ${size}) : identique à la version BigInt`, () => {
    const source = randomSection(size, 1000 + size);
    assert.equal(bitsForPalette(source.palette.length), bits, 'la largeur testée est bien celle attendue');

    const encoded = encodeBlockStates(source);
    const data = encoded.value.data?.value;
    assert.ok(Array.isArray(data) && data.length, 'la section produit bien un tableau de longs');

    const attendu = referenceUnpack(source.palette, data);
    const obtenu = decodeBlockStates({ palette: encoded.value.palette.value.value, data }).indices;

    assert.deepEqual(obtenu, attendu);
    // Et surtout : on retrouve ce qu'on avait mis.
    assert.deepEqual(obtenu, source.indices, 'aller-retour exact');
  });
}

test('une section homogène n’a pas de données à dépacker', () => {
  const palette = paletteOf(1);
  const indices = new Uint16Array(SECTION_VOLUME);
  const encoded = encodeBlockStates({ palette, indices });
  assert.equal(encoded.value.data, undefined, 'palette de 1 → pas de tableau de longs, comme Minecraft');

  const out = decodeBlockStates({ palette: encoded.value.palette.value.value });
  assert.equal(out.indices.every((v) => v === 0), true);
});

test('des longs rendus en BigInt donnent le même résultat qu’en paires', () => {
  // prismarine-nbt rend des paires [haut, bas] ; d'autres lecteurs rendent des
  // BigInt. Les deux doivent se dépacker pareil.
  const source = randomSection(40, 77);
  const data = encodeBlockStates(source).value.data.value;
  const enPaires = decodeBlockStates({ palette: source.palette, data }).indices;
  const enBigInt = decodeBlockStates({ palette: source.palette, data: data.map(pairToBig) }).indices;
  assert.deepEqual(enBigInt, enPaires);
});

test('le bit de poids fort d’un long est lu sans signe', () => {
  // Un long dont la moitié haute a son bit 31 à 1 devient négatif en entier
  // signé 32 bits. Le lire sans `>>> 0` décalerait tous les index de ce long.
  const palette = paletteOf(16); // 4 bits, 16 index par long
  const indices = new Uint16Array(SECTION_VOLUME);
  // Remplit le premier long de 15 (tous les bits à 1) : la moitié haute vaut
  // 0xFFFFFFFF, soit -1 en signé.
  for (let i = 0; i < 16; i++) indices[i] = 15;
  const data = encodeBlockStates({ palette, indices }).value.data.value;

  const out = decodeBlockStates({ palette, data }).indices;
  for (let i = 0; i < 16; i++) assert.equal(out[i], 15, `index ${i}`);
  assert.deepEqual(out, referenceUnpack(palette, data));
});

test('un tableau de longs plus court que la section ne déborde pas', () => {
  // Une section tronquée (fichier abîmé) doit rendre des zéros pour le reste,
  // pas lire hors des bornes ni planter.
  const source = randomSection(40, 5);
  const data = encodeBlockStates(source).value.data.value.slice(0, 10);
  const out = decodeBlockStates({ palette: source.palette, data }).indices;
  assert.equal(out.length, SECTION_VOLUME);
  const perLong = Math.floor(64 / bitsForPalette(source.palette.length));
  for (let n = 10 * perLong; n < SECTION_VOLUME; n++) {
    assert.equal(out[n], 0, `au-delà des longs fournis, l’index ${n} reste à zéro`);
  }
});
