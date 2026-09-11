import { useEffect, useRef, useState } from 'react';
import * as Icons from './icons.js';
import { useApp } from '../store.js';
import { TOOLS } from '../tools.js';

// L'élément signature : la roue d'outils radiale.
//
// Maintenir Espace au-dessus du viewport l'ouvre au centre ; la direction du
// curseur choisit l'outil ; relâcher valide. On change d'outil SANS quitter le
// build des yeux — c'est tout l'intérêt, et c'est pour ça que toute l'audace
// visuelle de l'application est concentrée ici plutôt que dispersée partout.

const RADIUS = 104;

export default function ToolWheel() {
  const open = useApp((s) => s.wheelOpen);
  const setWheel = useApp((s) => s.setWheel);
  const setTool = useApp((s) => s.setTool);
  const tool = useApp((s) => s.tool);
  const [angle, setAngle] = useState(null);
  const wheelRef = useRef(null);

  const items = TOOLS.filter((t) => !t.soon);
  const hot = angle == null ? null : items[Math.round(angle / (360 / items.length)) % items.length];

  useEffect(() => {
    if (!open) { setAngle(null); return; }
    const onMove = (e) => {
      // Le centre est celui de la ROUE, pas celui de la fenêtre : la roue
      // s'ouvre au milieu du viewport, et les panneaux de droite décalent les
      // deux d'une bonne centaine de pixels. Prendre le mauvais centre fait
      // désigner un outil qui n'est pas celui que le curseur vise.
      const r = wheelRef.current?.getBoundingClientRect();
      if (!r) return;
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      // Zone morte au centre : sans elle, le moindre tremblement au repos
      // ferait sauter la sélection d'un outil à l'autre.
      if (Math.hypot(dx, dy) < 26) { setAngle(null); return; }
      setAngle((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360);
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [open]);

  useEffect(() => {
    const onUp = (e) => {
      if (e.code !== 'Space' && e.type === 'keyup') return;
      if (!open) return;
      if (hot) setTool(hot.id);
      setWheel(false);
    };
    window.addEventListener('keyup', onUp);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('pointerup', onUp);
    };
  }, [open, hot, setTool, setWheel]);

  if (!open) return null;

  const step = 360 / items.length;
  const current = hot || TOOLS.find((t) => t.id === tool);

  return (
    <div className="wheel-veil" role="dialog" aria-label="Roue d’outils">
      <div className="wheel" ref={wheelRef}>
        {items.map((t, i) => {
          const Icon = Icons[t.icon] || Icons.Square;
          const a = (i * step - 90) * Math.PI / 180;
          const dx = Math.cos(a) * RADIUS;
          const dy = Math.sin(a) * RADIUS;
          return (
            <div
              key={t.id}
              className="wheel-item"
              data-hot={hot?.id === t.id}
              style={{ '--dx': `${dx}px`, '--dy': `${dy}px`, transform: `translate(${dx}px, ${dy}px)` }}
            >
              <Icon size={18} strokeWidth={1.75} />
              <span>{t.label.split(' ')[0]}</span>
            </div>
          );
        })}
        <div className="wheel-hub">
          <span>{current?.label || 'Outils'}</span>
          <small>relâche pour choisir</small>
        </div>
      </div>
    </div>
  );
}
