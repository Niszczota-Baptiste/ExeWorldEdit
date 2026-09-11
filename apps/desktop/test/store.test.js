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

test('l’opération de départ appartient à l’outil de départ', async () => {
  // Sinon la liste de l'inspecteur affiche son premier élément pendant que les
  // champs, la description et le bouton en décrivent un autre — et c'est ce
  // dernier qui part au moteur. Vu à la capture : « Copier » dans la liste,
  // « Appliquer remplir » sur le bouton.
  const { useApp } = await import('../src/renderer/store.js');
  const { tool, operation } = useApp.getState();
  const ops = TOOL_OPS[tool] || [];
  assert.ok(ops.includes(operation), `outil « ${tool} » : l’opération de départ « ${operation} » n’est pas dans sa liste`);
});

test('changer d’outil change d’opération pour une des siennes', async () => {
  const { useApp } = await import('../src/renderer/store.js');
  for (const tool of Object.keys(TOOL_OPS)) {
    useApp.getState().setTool(tool);
    const { operation } = useApp.getState();
    assert.ok(TOOL_OPS[tool].includes(operation), `${tool} → ${operation}`);
  }
});

test('un outil sans opérations a une note qui dit ce qu’il fait', async () => {
  const { TOOL_NOTES } = await import('../src/renderer/store.js');
  for (const t of TOOLS) {
    if (TOOL_OPS[t.id]?.length) continue;
    assert.ok(TOOL_NOTES[t.id]?.text, `${t.id} : ni opérations ni explication — l’inspecteur resterait muet`);
  }
});

test('le rail marque « bientôt » exactement les outils que l’inspecteur dit à venir', async () => {
  // Deux affichages de la même vérité : le rail grise le bouton, l'inspecteur
  // met « À venir ». Qu'ils divergent, et l'utilisateur clique sur un outil
  // annoncé prêt pour lire qu'il ne l'est pas.
  const { TOOL_NOTES } = await import('../src/renderer/store.js');
  for (const t of TOOLS) {
    assert.equal(!!t.soon, !!TOOL_NOTES[t.id]?.soon, `${t.id} : le rail et l’inspecteur ne disent pas la même chose`);
  }
});

test('les raccourcis d’outil sont uniques et réellement écoutés', async () => {
  // Le rail affiche ces lettres dans ses infobulles. Elles n'étaient liées à
  // rien : l'application annonçait onze raccourcis dont aucun ne marchait.
  const vus = new Map();
  for (const t of TOOLS) {
    assert.match(t.key, /^[A-Z]$/, `${t.id} : raccourci « ${t.key} » douteux`);
    assert.equal(vus.has(t.key), false, `raccourci « ${t.key} » partagé par ${vus.get(t.key)} et ${t.id}`);
    vus.set(t.key, t.id);
  }
  const app = await readFile(new URL('../src/renderer/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /TOOLS\.find\(/, 'App.jsx doit dériver les raccourcis de TOOLS, pas les recopier');
});

test('un outil sans opérations a soit son écran, soit une note « à venir »', async () => {
  // Trois états possibles et pas quatre : des opérations du moteur, un écran à
  // lui, ou l'aveu qu'il ne fait rien encore. Un outil qui n'a aucun des trois
  // ouvre un panneau vide.
  const { TOOL_NOTES } = await import('../src/renderer/store.js');
  const src = await readFile(new URL('../src/renderer/shell/Inspector.jsx', import.meta.url), 'utf8');
  const avecEcran = new Set([...src.matchAll(/^\s{2}(\w+): \w+Tool,$/gm)].map((m) => m[1]));
  assert.ok(avecEcran.size >= 3, `TOOL_PANELS illisible depuis Inspector.jsx (${avecEcran.size} trouvés)`);

  for (const t of TOOLS) {
    if (TOOL_OPS[t.id]?.length) continue;
    const ok = avecEcran.has(t.id) || TOOL_NOTES[t.id]?.soon || TOOL_NOTES[t.id]?.text;
    assert.ok(ok, `${t.id} : ni opérations, ni écran, ni note`);
    // Un outil qui a son écran n'est plus « à venir » : le rail le grisait
    // encore alors qu'il marchait.
    if (avecEcran.has(t.id)) assert.equal(!!t.soon, false, `${t.id} a son écran mais reste marqué « bientôt »`);
  }
});

test('toute méthode du moteur appelée par le renderer est dans la liste blanche', async () => {
  // Le preload est la SEULE porte du renderer vers le disque (invariant n° 6).
  // Une méthode oubliée là ne lève pas à la compilation : elle échoue au clic.
  const { globSync } = await import('node:fs');
  const racine = new URL('../src/renderer/', import.meta.url);
  const appels = new Set();
  for (const f of globSync('**/*.{js,jsx}', { cwd: racine })) {
    const src = await readFile(new URL(f, racine), 'utf8');
    for (const m of src.matchAll(/\bengine\.(\w+)\(/g)) appels.add(m[1]);
  }
  assert.ok(appels.size > 10, `trop peu d’appels relevés (${appels.size})`);

  const preload = await readFile(new URL('../src/preload/index.cjs', import.meta.url), 'utf8');
  const bloc = preload.slice(preload.indexOf('ENGINE_METHODS'), preload.indexOf('];', preload.indexOf('ENGINE_METHODS')));
  const blanches = new Set([...bloc.matchAll(/'(\w+)'/g)].map((m) => m[1]));

  const absentes = [...appels].filter((m) => !blanches.has(m)).sort();
  assert.deepEqual(absentes, [], 'appelées par le renderer, absentes de ENGINE_METHODS');
});

test('toute méthode de la liste blanche existe vraiment dans le moteur', async () => {
  // L'autre sens. Un nom dans `ENGINE_METHODS` que le moteur n'implémente pas
  // donne un pont qui répond « méthode inconnue » — au clic, jamais avant.
  const preload = await readFile(new URL('../src/preload/index.cjs', import.meta.url), 'utf8');
  const bloc = preload.slice(preload.indexOf('ENGINE_METHODS'), preload.indexOf('];', preload.indexOf('ENGINE_METHODS')));
  const blanches = [...bloc.matchAll(/'(\w+)'/g)].map((m) => m[1]);

  const moteur = await readFile(new URL('../src/engine/index.js', import.meta.url), 'utf8');
  const declarees = new Set([...moteur.matchAll(/^ {2}(?:async )?(\w+)[:(]/gm)].map((m) => m[1]));
  assert.ok(declarees.size > 20, `méthodes du moteur illisibles (${declarees.size})`);

  const fantomes = blanches.filter((m) => !declarees.has(m)).sort();
  assert.deepEqual(fantomes, [], 'exposées par le preload, absentes du moteur');
});
