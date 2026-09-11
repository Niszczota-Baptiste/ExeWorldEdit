import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, pickLatestVersion, orderPacks, pileComplete } from '../src/worldedit/packDetect.js';

test('les versions se comparent par NOMBRE, pas par texte', () => {
  // En texte, « 1.9 » passerait après « 1.18 » — et l'application ouvrirait
  // les textures d'une version de 2016.
  assert.ok(compareVersions('1.18', '1.9') > 0);
  assert.ok(compareVersions('1.21.4', '1.21') > 0);
  assert.ok(compareVersions('1.20.6', '1.21') < 0);
  assert.equal(compareVersions('1.20', '1.20.0'), 0, '1.20 et 1.20.0 sont la même chose');
});

test('une publication passe avant une capture instantanée', () => {
  // `24w14a` trie plus haut que `1.21` en texte, et n'a rien à faire dans une
  // palette par défaut.
  assert.ok(compareVersions('1.21', '24w14a') > 0);
  assert.ok(compareVersions('1.18.2', '1.19-pre1') > 0);
  assert.ok(compareVersions('1.0', '1.21-rc1') > 0);
});

test('la plus récente est choisie, quel que soit l’ordre du dossier', () => {
  assert.equal(pickLatestVersion(['1.18.2', '1.21.4', '1.9', '1.20.6']), '1.21.4');
  assert.equal(pickLatestVersion(['1.21.4', '24w14a', 'fabric-loader-0.15-1.21']), '1.21.4');
  assert.equal(pickLatestVersion([]), null);
  assert.equal(pickLatestVersion(null), null);
  // Rien que des noms modés : on rend quand même quelque chose plutôt que rien.
  assert.equal(typeof pickLatestVersion(['forge-1.18.2', 'forge-1.16.5']), 'string');
});

test('un pack de ressources RECOUVRE le jeu', () => {
  // L'ordre de Minecraft. Sans lui, un bloc `minefield:*` prendrait un trou au
  // lieu de la texture du serveur.
  const ordre = orderPacks([
    { path: '/v/1.21.4.jar', kind: 'jar' },
    { path: '/rp/minefield.zip', kind: 'pack' },
  ]);
  assert.deepEqual(ordre.map((c) => c.kind), ['pack', 'jar']);
});

test('un pack de serveur SEUL ne suffit pas', () => {
  // Il ne contient que ses blocs : la palette resterait vide pour tout le
  // vanilla, et l'écran des réglages doit le dire plutôt que laisser croire.
  assert.equal(pileComplete([{ kind: 'pack', path: '/rp/minefield.zip' }]), false);
  assert.equal(pileComplete([{ kind: 'jar', path: '/v/1.21.4.jar' }]), true);
  assert.equal(pileComplete([]), false);
});
