import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, RANGES, ACCENTS,
  normalizeSettings, themeVars, applyTheme, mix, inkOn, contrast, luminance,
} from '../src/renderer/theme.js';

// Le thème se teste sans navigateur : c'est tout l'intérêt de l'avoir sorti des
// composants. Un accent illisible ou une échelle qui laisse passer NaN ne se
// voit pas forcément à l'œil — et se voit très bien à l'usage.

test('des réglages absents rendent les valeurs par défaut', () => {
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
});

test('les échelles sont bornées, jamais rejetées', () => {
  assert.equal(normalizeSettings({ textScale: 99 }).textScale, RANGES.textScale.max);
  assert.equal(normalizeSettings({ textScale: 0 }).textScale, RANGES.textScale.min);
  assert.equal(normalizeSettings({ uiScale: -3 }).uiScale, RANGES.uiScale.min);
  assert.equal(normalizeSettings({ textScale: 1.2 }).textScale, 1.2);
});

test('une valeur illisible retombe sur le défaut au lieu de produire NaN', () => {
  const s = normalizeSettings({ textScale: 'grand', uiScale: undefined, accent: 'bleu' });
  assert.equal(s.textScale, DEFAULT_SETTINGS.textScale);
  assert.equal(s.uiScale, DEFAULT_SETTINGS.uiScale);
  assert.equal(s.accent, DEFAULT_SETTINGS.accent);
  assert.ok(!Object.values(themeVars(s)).some((v) => String(v).includes('NaN')));
});

test('le mode performance est strictement booléen', () => {
  assert.equal(normalizeSettings({ perf: true }).perf, true);
  assert.equal(normalizeSettings({ perf: 'oui' }).perf, false, 'une chaîne vraie ne vaut pas un oui');
  assert.equal(normalizeSettings({ perf: 1 }).perf, false);
});

test('un accent en minuscules est accepté et normalisé', () => {
  assert.equal(normalizeSettings({ accent: '#7fb8a4' }).accent, '#7FB8A4');
  assert.equal(normalizeSettings({ accent: '#7FB8A' }).accent, DEFAULT_SETTINGS.accent, 'cinq chiffres, refusé');
});

test('les tailles suivent leur échelle et tombent au pixel entier', () => {
  const v = themeVars({ textScale: 1.5, uiScale: 1 });
  assert.equal(v['--t-micro'], '18px');   // 12 × 1.5
  assert.equal(v['--t-title'], '27px');   // 18 × 1.5
  assert.equal(v['--titlebar-h'], '38px', 'l\'échelle du texte ne touche pas la coquille');

  const w = themeVars({ textScale: 1, uiScale: 1.25 });
  assert.equal(w['--rail-w'], '65px');    // 52 × 1.25
  assert.equal(w['--t-body'], '15px', 'l\'échelle de la coquille ne touche pas le texte');
  assert.ok(Object.values(w).every((s) => !/\d\.\d+px/.test(s)), 'aucune valeur fractionnaire');
});

test('le texte du bouton principal reste lisible sur n’importe quel accent', () => {
  for (const { hex } of ACCENTS) {
    assert.ok(contrast(hex, inkOn(hex)) >= 4.5, `${hex} : contraste insuffisant`);
  }
  // Les deux extrêmes : sur un accent presque noir il faut du texte blanc.
  assert.equal(inkOn('#FFFFFF'), '#14201C');
  assert.equal(inkOn('#101418'), '#FFFFFF');
});

test('les nuances d’accent restent des couleurs valides', () => {
  const v = themeVars({ accent: '#6BA6D6' });
  assert.match(v['--accent-dim'], /^#[0-9A-F]{6}$/);
  assert.match(v['--accent-hot'], /^#[0-9A-F]{6}$/);
  assert.match(v['--accent-wash'], /^rgba\(107, 166, 214, 0\.14\)$/);
  assert.ok(luminance(v['--accent-dim']) < luminance('#6BA6D6'), 'la nuance sombre est plus sombre');
  assert.ok(luminance(v['--accent-hot']) > luminance('#6BA6D6'), 'la nuance vive est plus claire');
});

test('mix aux bornes rend les couleurs d’origine', () => {
  assert.equal(mix('#7FB8A4', { r: 0, g: 0, b: 0 }, 0), '#7FB8A4');
  assert.equal(mix('#7FB8A4', { r: 0, g: 0, b: 0 }, 1), '#000000');
});

test('applyTheme n’écrit que sur la racine qu’on lui donne', () => {
  const written = new Map();
  const fakeRoot = { style: { setProperty: (k, v) => written.set(k, v) } };
  const vars = applyTheme({ accent: '#E3B64F', textScale: 1.1 }, fakeRoot);
  assert.equal(written.size, Object.keys(vars).length);
  assert.equal(written.get('--accent'), '#E3B64F');
  assert.equal(written.get('--t-body'), '17px'); // 15 × 1.1 = 16.5 → 17
});

test('les valeurs par défaut de tokens.css et du module ne divergent pas', async () => {
  // `tokens.css` sert au tout premier rendu, avant que le moteur ait répondu ;
  // le module sert ensuite. Si les deux s'écartent, l'interface saute au
  // démarrage — un défaut qu'on ne voit qu'en clignant des yeux au bon moment.
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/renderer/styles/tokens.css', import.meta.url), 'utf8');
  const declared = new Map(
    [...css.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]),
  );

  for (const [name, value] of Object.entries(themeVars(DEFAULT_SETTINGS))) {
    assert.equal(
      declared.get(name)?.toUpperCase(),
      String(value).toUpperCase(),
      `${name} : tokens.css dit « ${declared.get(name)} », le module « ${value} »`,
    );
  }
});
