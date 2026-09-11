import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS, ACTION_IDS, DEFAULT_KEYS, KEY_GROUPS,
  normalizeBinding, bindingFromEvent, matchesBinding, describeBinding,
  normalizeKeys, keyConflicts, actionForEvent,
} from '../src/renderer/keys.js';
import { TOOLS } from '../src/renderer/tools.js';

/** Un événement clavier minimal, comme le navigateur en produit. */
const ev = (key, mods = {}) => ({
  key,
  ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift,
});

test('chaque outil a son action, avec sa lettre pour défaut', () => {
  // Dérivées de TOOLS et pas recopiées : ajouter un outil suffit.
  for (const t of TOOLS) {
    assert.equal(DEFAULT_KEYS[`tool.${t.id}`], t.key, `${t.id}`);
  }
  assert.equal(new Set(ACTION_IDS).size, ACTION_IDS.length, 'pas deux fois la même action');
  assert.ok(KEY_GROUPS.length >= 3);
});

test('les défauts ne se marchent pas dessus', () => {
  // Livrer une configuration en conflit serait le plus sûr moyen d'avoir une
  // touche qui « ne marche pas » dès le premier lancement.
  assert.deepEqual(keyConflicts(DEFAULT_KEYS), {});
});

test('une liaison a une forme canonique, et une seule', () => {
  // C'est ce qui permet de comparer deux liaisons par égalité de chaînes.
  assert.equal(normalizeBinding('ctrl+shift+z'), 'Ctrl+Shift+Z');
  assert.equal(normalizeBinding('Shift+Ctrl+Z'), 'Ctrl+Shift+Z', 'l’ordre des modificateurs est fixé');
  assert.equal(normalizeBinding('  alt + f  '), 'Alt+F');
  assert.equal(normalizeBinding('space'), 'Space');
  assert.equal(normalizeBinding(','), ',');
  assert.equal(normalizeBinding('v'), 'V');
});

test('ce qui n’est pas une liaison est REFUSÉ, pas rafistolé', () => {
  // Une liaison approximative est une touche qui ne répond pas — plus
  // déroutant qu'un refus franc.
  for (const mauvais of ['', '   ', 'Ctrl+', 'Hyper+K', 'ArrowSideways', 'abc', null, 42, undefined]) {
    assert.equal(normalizeBinding(mauvais), null, JSON.stringify(mauvais));
  }
});

test('un événement devient une liaison', () => {
  assert.equal(bindingFromEvent(ev('z', { ctrl: true })), 'Ctrl+Z');
  assert.equal(bindingFromEvent(ev('Z', { ctrl: true, shift: true })), 'Ctrl+Shift+Z');
  assert.equal(bindingFromEvent(ev(' ')), 'Space');
  assert.equal(bindingFromEvent(ev(',', { ctrl: true })), 'Ctrl+,');
  // Cmd sur un clavier Mac, c'est la même intention que Ctrl.
  assert.equal(bindingFromEvent(ev('o', { meta: true })), 'Ctrl+O');
  // Un modificateur seul n'est pas une frappe.
  for (const m of ['Control', 'Alt', 'Shift', 'Meta', 'Dead']) {
    assert.equal(bindingFromEvent(ev(m)), null, m);
  }
});

test('la comparaison tient compte des modificateurs ABSENTS', () => {
  // Le piège classique : « Z » qui répond aussi à Ctrl+Z, donc une annulation
  // qui déclenche un outil au passage.
  assert.equal(matchesBinding('Z', ev('z')), true);
  assert.equal(matchesBinding('Z', ev('z', { ctrl: true })), false);
  assert.equal(matchesBinding('Ctrl+Z', ev('z', { ctrl: true })), true);
  assert.equal(matchesBinding('Ctrl+Z', ev('z', { ctrl: true, shift: true })), false);
  assert.equal(matchesBinding('Ctrl+Shift+Z', ev('Z', { ctrl: true, shift: true })), true);
});

test('un réglage bricolé à la main ne casse pas le clavier', () => {
  const out = normalizeKeys({ 'tool.blocks': 'ctrl+b', undo: 'pas une touche', inconnu: 'X' });
  assert.equal(out['tool.blocks'], 'Ctrl+B', 'ce qui est lisible est repris');
  assert.equal(out.undo, DEFAULT_KEYS.undo, 'ce qui ne l’est pas retombe sur le défaut');
  assert.equal(out.inconnu, undefined, 'une action inconnue est ignorée');
  assert.deepEqual(Object.keys(out).sort(), ACTION_IDS.slice().sort(), 'toutes les actions sont là');
  assert.deepEqual(normalizeKeys(), DEFAULT_KEYS);
  assert.deepEqual(normalizeKeys(null), DEFAULT_KEYS);
});

test('les conflits sont SIGNALÉS, pas empêchés', () => {
  // Réassigner passe forcément par un état où deux actions partagent une
  // touche. Refuser obligerait à libérer d'abord, ce que personne ne fait.
  const keys = normalizeKeys({ 'tool.blocks': 'Ctrl+O' });
  const c = keyConflicts(keys);
  assert.deepEqual(c['Ctrl+O'].sort(), ['open', 'tool.blocks']);
  assert.equal(Object.keys(c).length, 1, 'et rien d’autre n’est signalé');
});

test('un événement retrouve son action', () => {
  const keys = normalizeKeys({});
  assert.equal(actionForEvent(keys, ev('b')), 'tool.blocks');
  assert.equal(actionForEvent(keys, ev('z', { ctrl: true })), 'undo');
  assert.equal(actionForEvent(keys, ev('z', { ctrl: true, shift: true })), 'redo');
  assert.equal(actionForEvent(keys, ev('œ', { alt: true })), null);
});

test('une liaison s’affiche en français', () => {
  assert.deepEqual(describeBinding('Ctrl+Shift+Z'), ['Ctrl', 'Maj', 'Z']);
  assert.deepEqual(describeBinding('Space'), ['Espace']);
  assert.deepEqual(describeBinding('Escape'), ['Échap']);
  assert.deepEqual(describeBinding('bidon'), []);
});

test('chaque action a une étiquette et un groupe', () => {
  for (const a of ACTIONS) {
    assert.ok(a.label && a.group, a.id);
    assert.ok(normalizeBinding(a.defaut), `${a.id} : défaut « ${a.defaut} » illisible`);
  }
});
