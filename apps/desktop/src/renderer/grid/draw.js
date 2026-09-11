// La moitié qui touche un canvas : rasteriser, échantillonner, réencoder.
//
// Elle est ici et pas dans le moteur parce que le renderer EST un navigateur —
// il sait décoder un PNG et peindre un SVG sans une ligne de code. Le moteur,
// lui, n'a pas de canvas, et lui en ajouter un voudrait dire une dépendance
// native de plus à empaqueter pour Windows.
//
// Le renderer ne lit toujours pas le disque : les octets d'image lui arrivent
// du processus principal (`openImage`), et le PNG qu'il produit repart par lui
// (`savePng`). Invariant n° 6 intact.

/** Redessine une source à la taille EXACTE de la grille et rend son RGBA. */
export function toRgba(source, w, h, { smooth = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Sans lissage, réduire une photo à 128 cases garde un pixel sur vingt et
  // perd tout le reste ; avec, chaque case est la moyenne de ce qu'elle couvre.
  // Pour du texte, au contraire, le lissage brouille les bords : on veut du net.
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/** Décode des octets d'image (PNG, JPEG…) en bitmap. */
export async function decodeImage(bytes) {
  return createImageBitmap(new Blob([bytes]));
}

/**
 * Peint un SVG et rend son RGBA.
 *
 * Le SVG vient du moteur, qui a la police embarquée. On passe par un blob et
 * non par une URL `data:` : un `data:` échoue dès que le texte contient un
 * caractère hors latin, et la police est là justement pour le coréen.
 */
export async function svgToRgba(svg, w, h) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('svg_illisible'));
      img.src = url;
    });
    return toRgba(img, w, h, { smooth: false });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Une grille RGBA → les octets d'un PNG, prêts pour `savePng`. */
export async function rgbaToPngBytes(rgba, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return blob.arrayBuffer();
}

/** Vignette (data URL) d'une grille RGBA — l'aperçu avant d'appliquer. */
export function rgbaToDataUrl(rgba, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  return canvas.toDataURL('image/png');
}

/** Masque 0/1 → RGBA noir et blanc, pour la vignette d'un panneau. */
export function maskToRgba(mask) {
  const out = new Uint8ClampedArray(mask.length * 4);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const v = mask[p] ? 235 : 30;
    out[i] = out[i + 1] = out[i + 2] = v;
    out[i + 3] = 255;
  }
  return out;
}
