import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// LE MOTEUR SE CHARGE.
//
// Un nom d'export erroné — `flatBlockColors` importé depuis `worldedit` alors
// qu'il vit dans `colors` — fait sortir l'`utilityProcess` dès son chargement.
// Le processus principal attendait `whenReady` avant d'ouvrir la fenêtre : pas
// de fenêtre, pas de message, pas de fin. C'est arrivé deux fois dans la même
// journée, et aucun test ne le voyait : le moteur n'était jamais importé.
//
// Celui-ci ne vérifie rien de subtil — il importe le module. C'est tout ce
// qu'il faut : une seule importation cassée et il échoue.

test('le module du moteur s’importe sans lever', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-boot-'));
  process.env.TITI_DATA_ROOT = root;
  try {
    const moteur = await import('../src/engine/index.js');
    // Quelques symboles publics, pour que le test échoue aussi si le module
    // se vide un jour au lieu de lever.
    assert.equal(typeof moteur.detecteInstances, 'function');
    assert.equal(typeof moteur.candidatsDe, 'function');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
