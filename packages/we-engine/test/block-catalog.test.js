import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG, VANILLA, MINEFIELD, GROUPS,
  searchBlocks, mergeDiscovered, normalizeExtras, blockLabel,
} from '../src/worldedit/blockCatalog.js';

// Le catalogue est de la DONNÉE : ce qui peut y être faux, c'est un doublon, un
// identifiant mal formé, une famille qui n'existe pas, ou une recherche qui ne
// trouve rien de ce qu'un francophone tape.

test('aucun doublon, aucun identifiant mal formé', () => {
  const vus = new Set();
  for (const b of CATALOG) {
    assert.match(b.id, /^[a-z0-9_]+:[a-z0-9_/.]+$/, `identifiant mal formé : ${b.id}`);
    assert.equal(vus.has(b.id), false, `doublon : ${b.id}`);
    vus.add(b.id);
  }
  assert.ok(CATALOG.length > 250, `catalogue trop maigre : ${CATALOG.length}`);
});

test('chaque bloc appartient à une famille déclarée', () => {
  const ids = new Set(GROUPS.map((g) => g.id));
  for (const b of CATALOG) assert.ok(ids.has(b.group), `${b.id} : famille inconnue « ${b.group} »`);
});

test('le vanilla est vanilla, et les minefield ne sont jamais remappés', () => {
  // Invariant n° 3. Un `minefield:*` rangé sous `minecraft:` par inadvertance
  // s'écrirait dans le monde sous un nom que le serveur ne connaît pas.
  for (const b of VANILLA) assert.ok(b.id.startsWith('minecraft:'), `${b.id} n’est pas vanilla`);
  for (const b of MINEFIELD) {
    assert.ok(b.id.startsWith('minefield:'), `${b.id} n’est pas un bloc minefield`);
    assert.equal(b.group, 'minefield');
  }
});

test('la recherche comprend le français', () => {
  const trouve = (q) => searchBlocks(CATALOG, q).map((b) => b.id);
  assert.ok(trouve('pierre').includes('minecraft:stone'));
  assert.ok(trouve('chêne').includes('minecraft:oak_planks'), 'les accents ne doivent pas bloquer');
  assert.ok(trouve('chene').includes('minecraft:oak_planks'));
  assert.ok(trouve('escalier bouleau').includes('minecraft:birch_stairs'), 'plusieurs mots, dans l’ordre qu’on veut');
  assert.ok(trouve('bouleau escalier').includes('minecraft:birch_stairs'));
  assert.ok(trouve('verre').includes('minecraft:glass'));
  assert.ok(trouve('mf').some((id) => id.startsWith('minefield:')));
  assert.deepEqual(trouve('zzzz'), []);
  assert.equal(searchBlocks(CATALOG, '   ').length, CATALOG.length, 'une requête vide ne filtre rien');
});

test('un bloc croisé dans un build entre au catalogue', () => {
  // C'est ce qui rend utilisables les `minefield:*` d'un serveur dont ce dépôt
  // n'a pas la liste.
  const out = mergeDiscovered(CATALOG, ['minefield:muraille_de_siege', 'minecraft:stone', 'autremod:truc']);
  const ajoutes = out.filter((b) => b.discovered).map((b) => b.id);
  assert.deepEqual(ajoutes, ['minefield:muraille_de_siege', 'autremod:truc'], 'un bloc déjà connu n’est pas dupliqué');
  assert.equal(out.find((b) => b.id === 'minefield:muraille_de_siege').group, 'minefield');
  assert.equal(out.find((b) => b.id === 'autremod:truc').group, 'autre');
  assert.equal(mergeDiscovered(CATALOG, []), CATALOG, 'rien à ajouter : le même tableau, pas une copie');
});

test('blocks.json : ce qui est mal formé est REFUSÉ, pas assaini', () => {
  // Même raisonnement que pour les identifiants de projet : un identifiant
  // corrigé d'office s'écrirait dans une région sous un nom que le serveur ne
  // connaît pas, et n'y rendrait rien.
  const out = normalizeExtras({
    blocks: [
      'minefield:arene',
      { id: 'MINEFIELD:Muraille', group: 'minefield' },
      { id: 'sans_namespace' },
      { id: 'minefield:avec couleur', color: [1, 2, 3] },
      { id: 'minefield:colore', color: [300, -5, 12.6] },
      { id: 'minefield:mauvaise_couleur', color: 'rouge' },
      42, null,
    ],
  });
  assert.deepEqual(out.map((b) => b.id), [
    'minefield:arene', 'minefield:muraille', 'minefield:colore', 'minefield:mauvaise_couleur',
  ]);
  assert.equal(out[0].group, 'minefield', 'le namespace suffit à ranger le bloc');
  assert.deepEqual(out[2].color, [255, 0, 13], 'couleur bornée et arrondie');
  assert.equal(out[3].color, undefined, 'une couleur illisible est ignorée, le bloc reste');
});

test('blocks.json : une forme inattendue ne fait pas tomber le catalogue', () => {
  for (const brut of [null, undefined, 42, 'texte', {}, { blocks: 'non' }]) {
    assert.deepEqual(normalizeExtras(brut), [], `forme refusée : ${JSON.stringify(brut)}`);
  }
  assert.deepEqual(normalizeExtras(['minefield:x']), [{ id: 'minefield:x', group: 'minefield', declared: true }]);
});

test('le nom lisible enlève le namespace vanilla et garde l’autre', () => {
  assert.equal(blockLabel('minecraft:stone_bricks'), 'stone bricks');
  // Un `minefield:*` GARDE son préfixe à l'écran : c'est l'information utile.
  assert.equal(blockLabel('minefield:quart_de_bloc'), 'minefield:quart de bloc');
});
