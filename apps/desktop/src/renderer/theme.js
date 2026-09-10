// Thème et densité de l'interface, dérivés des réglages.
//
// Tout passe par des variables CSS : un réglage change une poignée de valeurs
// sur `:root`, et la feuille de style entière suit. Aucun composant ne lit les
// réglages pour se dimensionner lui-même — sans quoi la moitié de l'interface
// obéirait et l'autre non.
//
// Ce fichier ne touche au DOM que dans `applyTheme`. Le reste est du calcul pur,
// donc testable sans navigateur (`test/theme.test.js`) : le contraste du texte
// sur la couleur d'accent est le genre de chose qu'on ne vérifie pas à l'œil.

export const DEFAULT_SETTINGS = {
  accent: '#7FB8A4',
  textScale: 1,
  uiScale: 1,
  /** Mode performance : relevé par phase des opérations, affiché en direct. */
  perf: false,
};

/** Bornes des curseurs. Au-delà, l'interface se casse — autant refuser avant. */
export const RANGES = {
  textScale: { min: 0.8, max: 1.6, step: 0.05 },
  uiScale: { min: 0.85, max: 1.5, step: 0.05 },
};

/** Accents proposés. Le champ libre reste possible : ceci n'est qu'un raccourci. */
export const ACCENTS = [
  { id: 'celadon', label: 'Céladon', hex: '#7FB8A4' },
  { id: 'or', label: 'Or', hex: '#E3B64F' },
  { id: 'azur', label: 'Azur', hex: '#6BA6D6' },
  { id: 'lavande', label: 'Lavande', hex: '#9B8FD6' },
  { id: 'brique', label: 'Brique', hex: '#DC7A63' },
  { id: 'mousse', label: 'Mousse', hex: '#8FB65B' },
];

// Valeurs de référence à l'échelle 1 — les mêmes que celles écrites en dur dans
// `tokens.css`, qui reste la source pour un démarrage sans réglages.
const BASE_TEXT = { '--t-micro': 12, '--t-small': 13, '--t-body': 15, '--t-title': 18 };
const BASE_CHROME = {
  '--titlebar-h': 38,
  '--statusbar-h': 30,
  '--rail-w': 52,
  '--tool-size': 36,
  '--ctl-h': 30,
  '--field-h': 28,
  '--perf-w': 290,
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };

export function hexToRgb(hex) {
  const s = String(hex).replace('#', '');
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

const hx = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
export const rgbToHex = ({ r, g, b }) => `#${hx(r)}${hx(g)}${hx(b)}`.toUpperCase();

/** Mélange linéaire vers une couleur cible. `t = 0` rend `hex` inchangé. */
export function mix(hex, target, t) {
  const a = hexToRgb(hex);
  return rgbToHex({
    r: a.r + (target.r - a.r) * t,
    g: a.g + (target.g - a.g) * t,
    b: a.b + (target.b - a.b) * t,
  });
}

/** Luminance relative WCAG — sert à choisir un texte lisible, pas à décorer. */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const INK_DARK = '#14201C';

/**
 * Texte à poser SUR la couleur d'accent (bouton principal). Sans ce calcul, un
 * accent sombre choisi par l'utilisateur donne un bouton noir sur noir : le
 * réglage casserait l'interface au lieu de la personnaliser.
 */
export function inkOn(hex) {
  return contrast(hex, INK_DARK) >= contrast(hex, '#FFFFFF') ? INK_DARK : '#FFFFFF';
}

/** Applique bornes et types. Un `settings.json` bricolé à la main ne casse rien. */
export function normalizeSettings(raw = {}) {
  const num = (v, { min, max }, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  const accent = HEX.test(String(raw?.accent ?? '')) ? String(raw.accent).toUpperCase() : DEFAULT_SETTINGS.accent;
  return {
    accent,
    textScale: num(raw?.textScale, RANGES.textScale, DEFAULT_SETTINGS.textScale),
    uiScale: num(raw?.uiScale, RANGES.uiScale, DEFAULT_SETTINGS.uiScale),
    perf: raw?.perf === true,
  };
}

/** Les variables CSS que ces réglages produisent. Pur : aucun DOM. */
export function themeVars(raw) {
  const s = normalizeSettings(raw);
  const { r, g, b } = hexToRgb(s.accent);
  const out = {
    '--accent': s.accent,
    '--accent-dim': mix(s.accent, BLACK, 0.28),
    '--accent-hot': mix(s.accent, WHITE, 0.16),
    '--accent-wash': `rgba(${r}, ${g}, ${b}, 0.14)`,
    '--accent-ink': inkOn(s.accent),
  };
  // Les tailles sont arrondies au pixel : une hauteur de barre en 37.62px
  // laisse une frange d'un demi-pixel sur les bordures d'un pixel.
  for (const [k, base] of Object.entries(BASE_TEXT)) out[k] = `${Math.round(base * s.textScale)}px`;
  for (const [k, base] of Object.entries(BASE_CHROME)) out[k] = `${Math.round(base * s.uiScale)}px`;
  return out;
}

/** Pose les variables sur `:root`. Seule fonction de ce fichier liée au DOM. */
export function applyTheme(settings, root = document.documentElement) {
  const vars = themeVars(settings);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  return vars;
}
