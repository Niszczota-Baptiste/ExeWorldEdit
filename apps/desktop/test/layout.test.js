import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PANELS, PANEL_IDS, ZONE_IDS, DEFAULT_LAYOUT,
  normalizeLayout, movePanel, zoneOf, setActive, zoneUsed, sidesUsed,
} from '../src/renderer/layout.js';

// La règle de ce module tient en une phrase : ON NE PERD JAMAIS UN PANNEAU.
// Un panneau qui disparaît sans moyen de le faire revenir est une
// fonctionnalité perdue — et personne ne va éditer un JSON pour la retrouver.

const tous = (l) => ZONE_IDS.flatMap((z) => l.zones[z]);

test('la disposition par défaut est complète et sans doublon', () => {
  const l = normalizeLayout(DEFAULT_LAYOUT);
  assert.deepEqual(tous(l).slice().sort(), PANEL_IDS.slice().sort());
  assert.equal(new Set(tous(l)).size, PANEL_IDS.length);
});

test('un panneau ABSENT de la disposition enregistrée revient', () => {
  // Le cas d'un panneau ajouté au code après coup : sans ça, il n'apparaîtrait
  // jamais chez quelqu'un qui a déjà des réglages.
  const l = normalizeLayout({ zones: { rightTop: ['inspector'] }, active: {} });
  assert.deepEqual(tous(l).slice().sort(), PANEL_IDS.slice().sort());
  assert.ok(zoneOf(l, 'palette'), 'la palette est quelque part');
});

test('un panneau INCONNU est jeté, sans emporter les autres', () => {
  const l = normalizeLayout({ zones: { rightTop: ['inspector', 'panneau_disparu'], rightBottom: ['palette'] } });
  assert.equal(tous(l).includes('panneau_disparu'), false);
  assert.deepEqual(tous(l).slice().sort(), PANEL_IDS.slice().sort());
});

test('un panneau en DOUBLE n’est gardé qu’une fois', () => {
  // Il ne peut être qu'à un endroit : deux exemplaires voudraient dire deux
  // états, et l'un des deux mentirait.
  const l = normalizeLayout({ zones: { left: ['palette'], rightBottom: ['palette'], rightTop: ['inspector'] } });
  assert.equal(tous(l).filter((p) => p === 'palette').length, 1);
  assert.equal(zoneOf(l, 'palette'), 'left', 'le premier emplacement gagne');
});

test('une disposition illisible retombe sur celle d’origine', () => {
  for (const brut of [null, undefined, 42, 'texte', {}, { zones: 'non' }, { zones: { rightTop: 'non' } }]) {
    const l = normalizeLayout(brut);
    assert.deepEqual(tous(l).slice().sort(), PANEL_IDS.slice().sort(), JSON.stringify(brut));
  }
});

test('déplacer un panneau le retire de son ancien emplacement', () => {
  const l = movePanel(normalizeLayout(DEFAULT_LAYOUT), 'palette', 'left', 0);
  assert.equal(zoneOf(l, 'palette'), 'left');
  assert.equal(l.zones.rightBottom.includes('palette'), false);
  assert.deepEqual(tous(l).slice().sort(), PANEL_IDS.slice().sort(), 'rien n’est perdu en route');
});

test('réordonner VERS LA DROITE dans son propre emplacement ne saute pas d’un cran', () => {
  // Le défaut classique du glisser-déposer : on insère avant d'avoir retiré,
  // et l'onglet atterrit une place trop loin.
  let l = normalizeLayout({ zones: { rightTop: ['inspector', 'palette', 'perf', 'audit'] } });
  l = movePanel(l, 'inspector', 'rightTop', 2);
  assert.deepEqual(l.zones.rightTop, ['palette', 'inspector', 'perf', 'audit']);

  // Et vers la gauche.
  l = movePanel(l, 'audit', 'rightTop', 0);
  assert.deepEqual(l.zones.rightTop, ['audit', 'palette', 'inspector', 'perf']);
});

test('un panneau déposé DEVIENT l’onglet visible', () => {
  // Le déposer quelque part et ne pas le voir apparaître donne l'impression
  // que le geste a échoué.
  const l = movePanel(normalizeLayout(DEFAULT_LAYOUT), 'palette', 'rightTop', 0);
  assert.equal(l.active.rightTop, 'palette');
});

test('vider un emplacement lui choisit un autre onglet visible', () => {
  let l = normalizeLayout({ zones: { rightTop: ['inspector', 'perf'] }, active: { rightTop: 'perf' } });
  l = movePanel(l, 'perf', 'bottom', 0);
  assert.equal(l.active.rightTop, 'inspector', 'l’onglet actif suit ce qui reste');
  assert.equal(l.active.bottom, 'perf');
});

test('un emplacement vidé n’occupe plus de place', () => {
  let l = normalizeLayout({ zones: { rightTop: ['inspector'], rightBottom: ['palette', 'perf', 'audit'] } });
  assert.equal(zoneUsed(l, 'left'), false);
  assert.equal(zoneUsed(l, 'rightTop'), true);
  l = movePanel(l, 'inspector', 'rightBottom');
  assert.equal(zoneUsed(l, 'rightTop'), false, 'l’emplacement vidé ne laisse pas de bande morte');
  assert.deepEqual([...sidesUsed(l)], ['right']);
});

test('un déplacement impossible ne casse rien', () => {
  const l = normalizeLayout(DEFAULT_LAYOUT);
  assert.equal(movePanel(l, 'inconnu', 'left'), l);
  assert.equal(movePanel(l, 'palette', 'nulle_part'), l);
  // Un indice absurde est ramené dans les bornes, il ne jette pas le panneau.
  const m = movePanel(l, 'palette', 'left', 9999);
  assert.equal(zoneOf(m, 'palette'), 'left');
});

test('choisir un onglet qui n’est pas là ne change rien', () => {
  const l = normalizeLayout(DEFAULT_LAYOUT);
  assert.equal(setActive(l, 'rightTop', 'palette'), l);
  assert.equal(setActive(l, 'rightTop', 'inspector').active.rightTop, 'inspector');
});

test('chaque panneau a une étiquette et une icône', () => {
  for (const p of PANELS) {
    assert.ok(p.label, p.id);
    assert.ok(p.icon, p.id);
  }
  assert.equal(new Set(PANEL_IDS).size, PANEL_IDS.length, 'pas deux fois le même identifiant');
});

test('chaque icône de panneau existe dans icons.js', () => {
  // `icons.js` réexporte NOMMÉMENT les icônes utilisées : un nom qui n'y figure
  // pas rendait un onglet sans icône, sans la moindre erreur — `Icons[p.icon]`
  // vaut simplement `undefined` et le repli prend la main.
  const src = readFileSync(new URL('../src/renderer/shell/icons.js', import.meta.url), 'utf8');
  const exportes = new Set(src.match(/[A-Z][A-Za-z0-9]*/g) || []);
  for (const p of PANELS) assert.ok(exportes.has(p.icon), `${p.icon} n’est pas réexporté par icons.js`);
});

test('chaque panneau a un composant dans App.jsx', () => {
  // Le piège des DEUX tables : `layout.js` déclare les panneaux, `App.jsx` dit
  // ce que chacun affiche. Ajouter un panneau sans son entrée donnait un onglet
  // qui s'ouvre sur du vide — et rien ne le signalait.
  const src = readFileSync(new URL('../src/renderer/App.jsx', import.meta.url), 'utf8');
  const table = src.match(/const PANNEAUX = \{([\s\S]*?)\n\};/);
  assert.ok(table, 'la table PANNEAUX est introuvable dans App.jsx');
  // Une recherche de sous-chaîne et pas une expression régulière : un
  // identifiant vient d'une table, le compiler en motif n'apporte rien.
  const cles = new Set([...table[1].matchAll(/^\s*([a-zA-Z0-9_]+):/gm)].map((m) => m[1]));
  for (const id of PANEL_IDS) assert.ok(cles.has(id), `${id} n’a pas de composant`);
});
