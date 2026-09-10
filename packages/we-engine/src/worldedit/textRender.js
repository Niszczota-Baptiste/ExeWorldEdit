import fs from 'node:fs';
import opentype from 'opentype.js';

// Rendu de texte EN TRACÉS VECTORIELS depuis une police embarquée (Unifont, qui
// couvre tout le BMP : coréen, latin, japonais…). On ne dépend d'AUCUNE police
// système : le SVG ne contient que des <path>, donc le rendu est identique
// partout (le serveur déployé n'a pas forcément de police CJK). Style pixel =
// idéal pour Minecraft.

let FONT = null;
function font() {
  if (FONT) return FONT;
  const path = new URL('../../assets/fonts/unifont.otf', import.meta.url);
  const buf = fs.readFileSync(path);
  // opentype.parse veut un ArrayBuffer exact (Buffer Node = vue sur un pool).
  FONT = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return FONT;
}

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// Découpe chaque ligne (séparée par \n) en sous-lignes qui tiennent dans la
// largeur — par mots, et par caractères si un mot est trop long (coréen sans
// espaces inclus).
function wrapLines(text, maxAdvAt1, maxLines) {
  const f = font();
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para) { out.push(''); continue; }
    const words = para.split(/(\s+)/); // garde les espaces
    let cur = '';
    const widthOf = (s) => f.getAdvanceWidth(s, 1);
    const pushChunked = (token) => {
      // mot plus large que la ligne → coupe caractère par caractère
      let buf = '';
      for (const ch of token) {
        if (buf && widthOf(buf + ch) > maxAdvAt1) { if (cur) { out.push(cur); cur = ''; } out.push(buf); buf = ch; }
        else buf += ch;
      }
      cur = (cur + buf);
    };
    for (const w of words) {
      if (!w) continue;
      if (widthOf(cur + w) <= maxAdvAt1) { cur += w; continue; }
      if (cur.trim()) { out.push(cur.trim()); cur = ''; }
      if (widthOf(w) > maxAdvAt1) { pushChunked(w); } else { cur = w; }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out.slice(0, maxLines).map((l) => l.trim());
}

// Construit un SVG (W×H px) avec le texte centré, ajusté pour remplir ~90 %.
export function renderTextSvg(text, w, h, ss, bg, fg) {
  const f = font();
  const W = w * ss, H = h * ss;
  const pad = 0.92;
  // Largeur d'1 em à taille 1 : on borne la largeur de ligne pour le wrap.
  const maxAdvAt1 = (W * pad); // advance à taille 1 ≈ pixels à taille 1
  let lines = wrapLines(text, maxAdvAt1, 16).filter((l, i, a) => !(l === '' && a.length === 1));
  if (!lines.length) lines = [''];
  const maxW1 = Math.max(1, ...lines.map((l) => f.getAdvanceWidth(l, 1)));
  const lineH1 = 1.15; // hauteur de ligne en em
  // Taille de police limitée par largeur ET hauteur.
  const fsW = (W * pad) / maxW1;
  const fsH = (H * pad) / (lines.length * lineH1);
  const fontSize = Math.max(2, Math.min(fsW, fsH));
  const lineH = fontSize * lineH1;
  const blockH = lines.length * lineH;
  const startY = (H - blockH) / 2;
  const ascent = fontSize * 0.78; // baseline ≈ haut + ascent
  let paths = '';
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    const lw = f.getAdvanceWidth(ln, fontSize);
    const x = (W - lw) / 2;
    const baseline = startY + i * lineH + ascent;
    const d = f.getPath(ln, x, baseline, fontSize).toPathData(1);
    if (d) paths += `<path d="${d}" fill="${fg}"/>`;
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${escapeXml(bg)}"/>${paths}</svg>`);
}
