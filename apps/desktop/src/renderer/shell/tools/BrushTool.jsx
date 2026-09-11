import { useContext } from 'react';
import { createPortal } from 'react-dom';
import { Brush, Undo2 } from '../icons.js';
import { useApp } from '../../store.js';
import { ActionSlot } from '../actionSlot.js';
import { BRUSH_SHAPES, BRUSH_MODES, MAX_RADIUS } from '../../viewport/brush.js';

// « Pinceau » : peindre dans la vue, sans passer par une sélection.
//
// Cet écran ne fait que RÉGLER. Le geste est dans le viewport, qui seul sait où
// pointe le curseur ; ce qui se pose ensuite part au moteur en un seul trait.
//
// Pas de bouton « Appliquer » : un pinceau qu'il faut valider n'est pas un
// pinceau. Ce qui est épinglé en bas est l'annulation — c'est d'elle qu'on a
// besoin tout de suite après un trait raté.

export default function BrushTool() {
  const brush = useApp((s) => s.brush);
  const setBrush = useApp((s) => s.setBrush);
  const block = useApp((s) => s.block);
  const project = useApp((s) => s.project());
  const undo = useApp((s) => s.undo);
  const busy = useApp((s) => s.busy);
  const slot = useContext(ActionSlot);

  const mode = BRUSH_MODES.find((m) => m.id === brush.mode);
  const cases = brush.shape === 'disc'
    ? Math.round(Math.PI * (brush.radius + 0.5) ** 2)
    : brush.shape === 'cube'
      ? (2 * brush.radius + 1) ** 3
      : Math.round((4 / 3) * Math.PI * (brush.radius + 0.5) ** 3);

  return (
    <>
      <p className="hint" style={{ margin: '0 0 12px' }}>
        Vise dans la vue et <b>glisse</b> pour peindre. Le pinceau ne se sert pas
        de la sélection : c’est la case sous le curseur qui décide.
      </p>

      <div className="field">
        <label htmlFor="br-mode">Ce que fait le trait</label>
        <select id="br-mode" className="select" value={brush.mode} onChange={(e) => setBrush({ mode: e.target.value })}>
          {BRUSH_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <p className="hint">{mode?.aide}</p>
      </div>

      <div className="field">
        <label htmlFor="br-shape">Forme</label>
        <select id="br-shape" className="select" value={brush.shape} onChange={(e) => setBrush({ shape: e.target.value })}>
          {BRUSH_SHAPES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>

      <div className="field">
        <label htmlFor="br-radius">Rayon ({brush.radius}) — environ {cases.toLocaleString('fr-FR')} cases</label>
        <input
          id="br-radius" className="input" type="range" min="0" max={MAX_RADIUS} step="1"
          value={brush.radius} onChange={(e) => setBrush({ radius: Number(e.target.value) })}
        />
      </div>

      <p className="hint" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <Brush size={13} style={{ flex: 'none', marginTop: 1 }} />
        <span>
          {brush.mode === 'erase'
            ? 'Les blocs visés sont retirés.'
            : <>Bloc posé : <code>{block}</code> — choisis-le dans la palette.</>}
          {' '}Un trait entier ne fait qu’<b>une</b> annulation, quel que soit le
          nombre de blocs.
        </span>
      </p>

      {slot && createPortal(
        <button className="btn btn-wide" disabled={!project?.undoDepth || !!busy} onClick={undo}>
          <Undo2 size={13} /> Annuler le dernier trait
        </button>,
        slot,
      )}
    </>
  );
}
