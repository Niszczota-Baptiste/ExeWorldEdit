import { useCallback, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, FolderOpen, FileDown } from '../icons.js';
import { useApp } from '../../store.js';
import { ActionSlot } from '../actionSlot.js';
import { toHeights, grayToRgba } from '../../grid/pixels.js';
import { decodeImage, toRgba, rgbaToDataUrl, rgbaToPngBytes } from '../../grid/draw.js';

// « Relief » : sculpter le terrain depuis une image en niveaux de gris, et
// ressortir celui d'une zone.
//
// L'aller et le retour sont là tous les deux exprès : exporter le relief d'une
// zone, le retoucher dans un éditeur d'image, le réimporter, c'est le flux de
// travail que cet outil sert. N'offrir que l'import en ferait un gadget.

export default function HeightmapTool() {
  const selection = useApp((s) => s.selection);
  const busy = useApp((s) => s.busy);
  const block = useApp((s) => s.block);
  const applyHeightmap = useApp((s) => s.applyHeightmap);
  const pullHeightmap = useApp((s) => s.pullHeightmap);
  const say = useApp((s) => s.say);
  const slot = useContext(ActionSlot);

  const [image, setImage] = useState(null);
  const [invert, setInvert] = useState(false);
  const [mode, setMode] = useState('solid');
  const [under, setUnder] = useState('');
  const [grille, setGrille] = useState(null);

  const taille = selection && {
    x: selection.max.x - selection.min.x + 1,
    z: selection.max.z - selection.min.z + 1,
    h: selection.max.y - selection.min.y,
  };

  const rebuild = useCallback(async () => {
    if (!image || !taille) { setGrille(null); return; }
    const rgba = toRgba(image.bitmap, taille.x, taille.z);
    // Des RAPPORTS 0..1 : c'est ce que le moteur attend. La hauteur en blocs
    // n'apparaît que dans la vignette et dans le texte ci-dessous.
    const heights = toHeights(rgba, { invert });
    // La vignette montre les hauteurs RETENUES — après arrondi au bloc —, pas
    // l'image d'origine : c'est là qu'on voit qu'une image de dix nuances sur
    // une sélection de cinquante blocs donne des marches.
    const vue = grayToRgba(Uint8Array.from(heights, (t) => {
      const blocs = Math.round(t * taille.h);
      return Math.round((blocs / Math.max(1, taille.h)) * 255);
    }));
    setGrille({ heights, apercu: rgbaToDataUrl(vue, taille.x, taille.z) });
  // Les trois dimensions séparément, et pas `taille` : c'est un objet neuf
  // à chaque rendu, donc la grille se referait sans arrêt.
  }, [image, invert, taille?.x, taille?.z, taille?.h]);

  useEffect(() => { rebuild(); }, [rebuild]);

  const choisirImage = async () => {
    const res = await window.titi.openImage();
    if (!res) return;
    setImage({ name: res.name, bitmap: await decodeImage(res.bytes) });
  };

  const exporter = async () => {
    const out = await pullHeightmap();
    if (!out) return;
    // `sizeX`/`sizeZ`, les noms que le moteur rend — pas `width`/`height` avec
    // un repli : un repli sur les dimensions de la sélection masquerait un
    // décalage au lieu de le signaler.
    const bytes = await rgbaToPngBytes(grayToRgba(out.data), out.sizeX, out.sizeZ);
    const saved = await window.titi.savePng({ bytes, defaultName: 'relief.png' });
    if (saved) say(`Relief enregistré : ${saved.path}`);
  };

  if (!selection) return <p className="hint">Choisis une sélection : c’est elle qui donne l’emprise et la hauteur du relief.</p>;

  return (
    <>
      <p className="hint" style={{ margin: '0 0 10px' }}>
        Grille de <b>{taille.x} × {taille.z}</b>, hauteur disponible <b>{taille.h}</b> blocs.
        Le blanc monte, le noir reste au sol.
      </p>

      <div className="field">
        <label>Image de relief</label>
        <button className="btn btn-wide" onClick={choisirImage}>
          <FolderOpen size={13} /> {image ? image.name : 'Choisir une image'}
        </button>
      </div>

      <div className="field">
        <label htmlFor="hm-mode">Remplissage</label>
        <select id="hm-mode" className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="solid">Plein (colonne remplie jusqu’en bas)</option>
          <option value="surface">Surface seule (une couche)</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="hm-under">Bloc sous la surface (optionnel)</label>
        <input id="hm-under" className="input" value={under} onChange={(e) => setUnder(e.target.value)} placeholder="minecraft:dirt" />
        <p className="hint">La surface utilise le bloc de la palette : <code>{block}</code>.</p>
      </div>

      <div className="field">
        <label htmlFor="hm-invert" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <input id="hm-invert" type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
          Inverser (le noir monte)
        </label>
      </div>

      {grille?.apercu && (
        <div className="field">
          <label>Hauteurs retenues</label>
          <img
            src={grille.apercu} alt="Aperçu du relief"
            style={{ width: '100%', imageRendering: 'pixelated', borderRadius: 'var(--r-field)', border: '1px solid var(--line)' }}
          />
        </div>
      )}

      {slot && createPortal(
        <button
          className="btn btn-wide" data-variant="primary" disabled={!grille || !!busy}
          onClick={() => applyHeightmap(grille.heights, {
            block: { name: block },
            under: under.trim() ? { name: under.trim() } : null,
            mode,
          })}
        >
          <Play size={13} /> {busy ? 'En cours…' : 'Sculpter le relief'}
        </button>,
        slot,
      )}

      <button className="btn btn-wide" onClick={exporter} disabled={!!busy}>
        <FileDown size={13} /> Exporter le relief actuel en PNG
      </button>
      <p className="hint">
        Exporte, retouche dans un éditeur d’image, réimporte : c’est le va-et-vient
        que cet outil sert.
      </p>
    </>
  );
}
