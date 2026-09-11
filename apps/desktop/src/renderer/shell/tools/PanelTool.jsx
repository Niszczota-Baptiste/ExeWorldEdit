import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { panelPlane } from '@titi/we-engine/geometry';
import { Play, FolderOpen } from '../icons.js';
import { useApp } from '../../store.js';
import { ActionSlot } from '../actionSlot.js';
import { toMask, toBlockNames } from '../../grid/pixels.js';
import { svgToRgba, decodeImage, toRgba, maskToRgba, rgbaToDataUrl } from '../../grid/draw.js';

// « Texte et carte » : écrire sur un mur, ou y projeter une image.
//
// Le partage du travail est le même pour les trois outils à grille : le moteur
// donne ce que lui seul sait (la police embarquée, la palette de couleurs de
// carte), le renderer rasterise — il est un navigateur —, le moteur écrit.
//
// Le PLAN vient de `panelPlane`, la fonction du moteur : l'axe plat est la plus
// petite dimension de la sélection. La recopier ici la ferait diverger le jour
// où elle change.

/** Ce que la grille fait comme taille, d'après la sélection. */
function usePlane(selection) {
  return useMemo(() => (selection ? panelPlane(selection) : null), [selection]);
}

export default function PanelTool() {
  const selection = useApp((s) => s.selection);
  const busy = useApp((s) => s.busy);
  const block = useApp((s) => s.block);
  const applyPanel = useApp((s) => s.applyPanel);
  const applyMapBlocks = useApp((s) => s.applyMapBlocks);
  const say = useApp((s) => s.say);

  const plane = usePlane(selection);
  const slot = useContext(ActionSlot);
  const [mode, setMode] = useState('texte');
  const [text, setText] = useState('MINEFIELD');
  const [preset, setPreset] = useState('white_marble');
  const [presets, setPresets] = useState([]);
  const [seed, setSeed] = useState(1337);
  const [seuil, setSeuil] = useState(128);
  const [image, setImage] = useState(null);   // { name, bitmap }
  const [grille, setGrille] = useState(null); // { mask } | { names } + vignette

  useEffect(() => {
    window.titi.engine.panelPresets().then(setPresets).catch(() => setPresets([]));
  }, []);

  // La grille se REFAIT à chaque changement qui la concerne. La calculer au
  // moment d'appliquer laisserait montrer une vignette qui ne correspond plus.
  const rebuild = useCallback(async () => {
    if (!plane) return;
    const { w, h } = plane;
    try {
      if (mode === 'texte') {
        const { svg } = await window.titi.engine.textSvg({ text, width: w, height: h });
        const rgba = await svgToRgba(svg, w, h);
        const mask = toMask(rgba, { threshold: seuil });
        setGrille({ kind: 'mask', mask, apercu: rgbaToDataUrl(maskToRgba(mask), w, h) });
        return;
      }
      if (!image) { setGrille(null); return; }
      const rgba = toRgba(image.bitmap, w, h);
      if (mode === 'silhouette') {
        const mask = toMask(rgba, { threshold: seuil });
        setGrille({ kind: 'mask', mask, apercu: rgbaToDataUrl(maskToRgba(mask), w, h) });
      } else {
        const palette = await window.titi.engine.mapPalette();
        const names = toBlockNames(rgba, palette);
        setGrille({ kind: 'names', names, apercu: rgbaToDataUrl(rgba, w, h) });
      }
    } catch (e) {
      setGrille(null);
      say(`Aperçu impossible : ${e?.message || e}`);
    }
  }, [plane, mode, text, seuil, image, say]);

  useEffect(() => { rebuild(); }, [rebuild]);

  const choisirImage = async () => {
    const res = await window.titi.openImage();
    if (!res) return;
    setImage({ name: res.name, bitmap: await decodeImage(res.bytes) });
    if (mode === 'texte') setMode('carte');
  };

  if (!selection || !plane) return <p className="hint">Choisis une sélection : c’est elle qui donne la taille du panneau.</p>;

  const inkPreset = presets.find((p) => p.id === preset);
  const epaisseur = selection.max[plane.flat] - selection.min[plane.flat] + 1;
  const pret = !!grille && !busy;

  return (
    <>
      <p className="hint" style={{ margin: '0 0 10px' }}>
        Plan <b>{plane.flat.toUpperCase()}</b> — grille de <b>{plane.w} × {plane.h}</b> cases.
        L’axe plat est la plus petite dimension de la sélection.
      </p>
      {/* L'ÉPAISSEUR décide de tout : le panneau est estampé sur toute la
          profondeur de l'axe plat. Sur une sélection cubique ça fait un bloc
          massif de plusieurs millions de cases, et rien dans l'écran ne le
          disait — mesuré une fois : 1 647 870 blocs pour un « panneau ». */}
      {epaisseur > 1 && (
        <p className="hint" data-tone="select" style={{ margin: '0 0 10px' }}>
          <b>Épaisseur {epaisseur} blocs.</b> Le motif est estampé sur toute la profondeur,
          soit {(plane.w * plane.h * epaisseur).toLocaleString('fr-FR')} blocs.
          Pour un vrai panneau, aplatis la sélection sur {plane.flat.toUpperCase()}.
        </p>
      )}

      <div className="field">
        <label htmlFor="panel-mode">Contenu</label>
        <select id="panel-mode" className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="texte">Texte</option>
          <option value="carte">Image en couleurs (carte)</option>
          <option value="silhouette">Image en silhouette (2 blocs)</option>
        </select>
      </div>

      {mode === 'texte' ? (
        <div className="field">
          <label htmlFor="panel-text">Texte</label>
          <textarea
            id="panel-text" className="input" rows={3} value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ height: 'auto', resize: 'vertical', lineHeight: 1.4, padding: '6px 8px' }}
          />
          <p className="hint">
            Police embarquée (Unifont) : le rendu est le même partout, accents et coréen compris.
            Le texte est mis à l’échelle et coupé pour remplir la zone.
          </p>
        </div>
      ) : (
        <div className="field">
          <label>Image</label>
          <button className="btn btn-wide" onClick={choisirImage}>
            <FolderOpen size={13} /> {image ? image.name : 'Choisir une image'}
          </button>
          <p className="hint">
            Elle est redimensionnée à {plane.w} × {plane.h} avec lissage : chaque case est la
            moyenne de ce qu’elle couvre, pas un pixel pris au hasard.
          </p>
        </div>
      )}

      {(mode === 'texte' || mode === 'silhouette') && (
        <>
          <div className="field">
            <label htmlFor="panel-preset">Fond</label>
            <select id="panel-preset" className="select" value={preset} onChange={(e) => setPreset(e.target.value)}>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <p className="hint">Encre par défaut : <code>{inkPreset?.ink || '—'}</code>. Le bloc de la palette la remplace.</p>
          </div>
          <div className="row" style={{ marginBottom: 11 }}>
            <div className="field" style={{ flex: 1, marginBottom: 0 }}>
              <label htmlFor="panel-seuil">Seuil ({seuil})</label>
              <input
                id="panel-seuil" className="input" type="range" min="16" max="240" step="8"
                value={seuil} onChange={(e) => setSeuil(Number(e.target.value))}
              />
            </div>
            <div className="field" style={{ width: 90, flex: 'none', marginBottom: 0 }}>
              <label htmlFor="panel-seed">Graine</label>
              <input
                id="panel-seed" className="input" type="number"
                value={seed} onChange={(e) => setSeed(Math.round(Number(e.target.value)) || 0)}
              />
            </div>
          </div>
        </>
      )}

      {grille?.apercu && (
        <div className="field">
          <label>Aperçu</label>
          {/* Rendu au pixel : une vignette de 64 cases lissée ne dirait rien de
              ce qui sera réellement posé, case par case. */}
          <img
            src={grille.apercu} alt="Aperçu du panneau"
            style={{ width: '100%', imageRendering: 'pixelated', borderRadius: 'var(--r-field)', border: '1px solid var(--line)' }}
          />
        </div>
      )}

      {/* Épinglé avec les autres actions, pas au bout du formulaire. */}
      {slot && createPortal(
        <button
          className="btn btn-wide" data-variant="primary" disabled={!pret}
          onClick={() => (grille.kind === 'mask'
            ? applyPanel({ mask: grille.mask, preset, seed, inkBlock: { name: block } })
            : applyMapBlocks(grille.names))}
        >
          <Play size={13} />
          {busy ? 'En cours…' : `Poser ${(plane.w * plane.h).toLocaleString('fr-FR')} cases`}
        </button>,
        slot,
      )}
    </>
  );
}
