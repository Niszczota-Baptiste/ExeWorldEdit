import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATIONS } from '@titi/we-engine/operations';
import { valeurDeRecherche, filtre } from '../src/renderer/commands.js';
import { TOOL_OPS } from '../src/renderer/tools.js';

// La palette de commandes existait EN BOUTON depuis le début, `cmdk` était
// installé, et rien ne s'ouvrait — « déclaré, branché, inatteignable », encore.
//
// Ce qu'elle apporte vraiment : on y cherche par le nom WorldEdit. Sans ça, il
// faut apprendre un second vocabulaire pour se servir d'un outil qui fait la
// même chose que WorldEdit.

const trouve = (recherche) => OPERATIONS
  .filter((o) => filtre(valeurDeRecherche(o), recherche))
  .map((o) => o.id);

test('un nom WorldEdit mène à SON opération', () => {
  assert.deepEqual(trouve('//walls'), ['walls']);
  assert.deepEqual(trouve('//hollow'), ['hollow']);
  assert.deepEqual(trouve('//naturalize'), ['naturalize']);
  assert.deepEqual(trouve('//move'), ['translate'], 'notre « translation » est leur « move »');
  assert.deepEqual(trouve('//curve'), ['path'], 'notre « tracé » est leur « curve »');
  assert.deepEqual(trouve('//setbiome'), ['biome']);
});

test('les variantes CREUSES mènent à la forme qui porte l’option', () => {
  // WorldEdit a deux commandes là où nous avons une case à cocher. Chercher
  // « //hcyl » doit quand même tomber sur le cylindre.
  assert.deepEqual(trouve('//hcyl'), ['cyl']);
  assert.deepEqual(trouve('//hsphere'), ['sphere']);
  assert.deepEqual(trouve('//hpyramid'), ['pyramid']);
  for (const id of ['cyl', 'sphere', 'pyramid']) {
    assert.ok(OPERATIONS.find((o) => o.id === id).params.some((p) => p.name === 'hollow'),
      `${id} doit avoir l’option « creux », sinon l’alias ment`);
  }
});

test('le nom FRANÇAIS marche aussi, et le groupe', () => {
  assert.ok(trouve('murs').includes('walls'));
  assert.ok(trouve('Transformer').length >= 5);
});

test('une recherche approximative ne propose pas une AUTRE commande', () => {
  // Un score flou ferait remonter « //hollow » sur « //hcy » parce qu'ils
  // partagent des lettres. Une commande proposée à la place de celle qu'on a
  // tapée est pire que pas de résultat.
  assert.equal(filtre('Creuser hollow //hollow Blocs', '//hcyl'), 0);
  assert.equal(filtre('Murs walls //walls Blocs', '//wal'), 1);
});

test('chaque alias WorldEdit est UNIQUE, ou partagé exprès', () => {
  // Deux opérations sous le même nom rendraient la palette ambiguë. Les seules
  // tolérées sont celles qui font vraiment la même chose sous deux formes.
  const partages = { '//flip': ['mirror', 'mirrorcopy'], '//set': ['set', 'mix'] };
  const par = new Map();
  for (const o of OPERATIONS) for (const a of o.we || []) (par.get(a) ?? par.set(a, []).get(a)).push(o.id);
  for (const [alias, ids] of par) {
    if (ids.length === 1) continue;
    assert.deepEqual(ids, partages[alias], `${alias} est partagé par ${ids.join(', ')}`);
  }
});

test('toute opération ATTEIGNABLE par la palette a un outil', () => {
  // Sans outil, choisir l'entrée ne mènerait nulle part : l'inspecteur
  // n'afficherait aucun formulaire.
  const avecOutil = new Set(Object.values(TOOL_OPS).flat());
  for (const o of OPERATIONS) {
    assert.ok(avecOutil.has(o.id), `${o.id} n’appartient à aucun outil`);
  }
});
