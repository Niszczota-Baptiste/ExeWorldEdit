import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// La zone de DÉPLACEMENT de la fenêtre.
//
// La barre de titre est maison (`titleBarStyle: 'hidden'`), donc c'est le CSS
// qui décide où l'on peut attraper la fenêtre. Deux façons de se tromper, et
// toutes les deux sont muettes :
//
//   trop de `no-drag`  la fenêtre ne se déplace plus. C'est ce qui est arrivé :
//                      `.titlebar > * { no-drag }` visait tous les enfants
//                      directs, dont `.tabs` — qui porte `flex: 1` et occupe
//                      donc TOUT l'espace libre de la barre. Il ne restait que
//                      le logo, une centaine de pixels.
//   trop de `drag`     un bouton laissé déplaçable ne répond plus au clic.
//
// Rien ne le signale à la compilation, et sous Linux `-webkit-app-region` n'a
// aucun effet visible — donc invisible dans toutes les captures.

// Les commentaires sont retirés AVANT l'analyse : ils citent les règles dont ils
// parlent, accolades comprises, et un découpage naïf les prendrait pour du CSS.
const CSS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'styles', 'app.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** La valeur de `-webkit-app-region` déclarée pour un sélecteur, ou `null`. */
function region(selecteur) {
  const bloc = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .find(([, sel, corps]) => sel.split(',').some((s) => s.trim() === selecteur)
      && /-webkit-app-region/.test(corps));
  return bloc ? /-webkit-app-region:\s*([\w-]+)/.exec(bloc[2])?.[1] ?? null : null;
}

test('la barre de titre est déplaçable', () => {
  assert.equal(region('.titlebar'), 'drag');
});

test('la bande des onglets reste déplaçable', () => {
  // C'est elle qui occupe l'espace libre : sans ça, la fenêtre est collée.
  assert.equal(region('.titlebar .tabs'), 'drag');
});

test('tout ce qui se clique dans la barre est RETIRÉ du déplacement', () => {
  for (const sel of ['.titlebar button', '.titlebar input', '.titlebar .tab']) {
    assert.equal(region(sel), 'no-drag', sel);
  }
});

test('aucune règle ne rend la barre entière non déplaçable', () => {
  // `.titlebar > *` attrape les conteneurs en même temps que les boutons.
  // C'est exactement la règle qui avait figé la fenêtre.
  assert.equal(region('.titlebar > *'), null, '`.titlebar > *` vise trop large');
});
