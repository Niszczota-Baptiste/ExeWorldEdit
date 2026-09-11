import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OPERATIONS, OPERATION_IDS } from '@titi/we-engine/operations';
import { TOOLS, TOOL_OPS, ERREURS } from '../src/renderer/store.js';

// Le descripteur du moteur génère l'inspecteur : une opération qu'il déclare
// sans qu'aucun outil ne la propose existe, marche, est testée — et reste
// inatteignable. C'était le cas de `biome`, `copy` et `paste`.

const proposees = new Set(Object.values(TOOL_OPS).flat());

test('toute opération du moteur est atteignable depuis un outil', () => {
  const orphelines = [...OPERATION_IDS].filter((id) => !proposees.has(id));
  assert.deepEqual(orphelines, [], 'déclarées par le moteur, proposées par aucun outil');
});

test('aucun outil ne propose une opération que le moteur ne connaît pas', () => {
  const fantomes = [...proposees].filter((id) => !OPERATION_IDS.has(id));
  assert.deepEqual(fantomes, [], 'un bouton qui échouerait à l’usage');
});

test('chaque outil porteur d’opérations existe dans le rail', () => {
  const ids = new Set(TOOLS.map((t) => t.id));
  for (const tool of Object.keys(TOOL_OPS)) {
    assert.ok(ids.has(tool), `${tool} : des opérations, mais pas d’outil pour les atteindre`);
  }
});

test('tout type de paramètre déclaré a un champ dans l’inspecteur', async () => {
  // Un type sans champ retombait sur la case de texte par défaut, et sa chaîne
  // partait telle quelle vers une opération qui attend un tableau : c'est ce
  // qui rendait « Remplacer » (blocklist) et « Mélange » (pattern)
  // inutilisables sans la moindre erreur à l'écran.
  const src = await readFile(new URL('../src/renderer/shell/Inspector.jsx', import.meta.url), 'utf8');
  const types = new Set(OPERATIONS.flatMap((o) => o.params.map((p) => p.type)));
  for (const t of types) {
    assert.ok(src.includes(`p.type === '${t}'`), `type « ${t} » : aucun champ dédié dans Inspector.jsx`);
  }
});

/**
 * Le source des DEUX moteurs, concaténé : le paquet `we-engine` et la couche
 * moteur de l'application, qui lève ses propres codes (`no_world`,
 * `empty_area`…). N'en lire qu'un laissait la moitié de la table sans preuve.
 */
async function sourcesMoteur() {
  const { globSync } = await import('node:fs');
  const racines = [
    new URL('../../../packages/we-engine/src/', import.meta.url),
    new URL('../src/engine/', import.meta.url),
  ];
  let tout = '';
  for (const racine of racines) {
    for (const f of globSync('**/*.js', { cwd: racine })) tout += await readFile(new URL(f, racine), 'utf8');
  }
  return tout;
}

test('tout code d’erreur du moteur a une phrase en français', async () => {
  // Un code oublié s'affiche tel quel : « Échec de l'opération :
  // bad_heightmap ». Le lire dans le source du moteur plutôt que d'entretenir
  // une liste à la main est le seul moyen que ça reste vrai.
  const codes = new Set();
  for (const m of (await sourcesMoteur()).matchAll(/new Error\('([a-z_]+)'\)/g)) codes.add(m[1]);
  assert.ok(codes.size > 25, `trop peu de codes lus (${codes.size}) : le balayage du source a raté sa cible`);

  const sansPhrase = [...codes].filter((c) => !ERREURS[c]).sort();
  assert.deepEqual(sansPhrase, [], 'codes levés par le moteur et absents de la table');
});

test('la table ne garde pas de phrase pour un code disparu', async () => {
  const tout = await sourcesMoteur();
  // `selection_too_large`, `invalid_selection` et `out_of_bounds` sont RENDUS
  // par `validateSelection` (une chaîne), pas levés — d'où l'exception.
  const rendus = new Set(['selection_too_large', 'invalid_selection', 'out_of_bounds']);
  const mortes = Object.keys(ERREURS).filter((c) => !rendus.has(c) && !tout.includes(`'${c}'`));
  assert.deepEqual(mortes, [], 'phrases pour des codes que le moteur ne lève plus');
});
