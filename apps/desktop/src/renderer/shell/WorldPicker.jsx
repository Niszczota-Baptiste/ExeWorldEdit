import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderTree, Globe, AlertTriangle } from './icons.js';
import { useApp } from '../store.js';

// Choix de la zone à ouvrir dans une save.
//
// Une région couvre 512×512 blocs, et un monde joué quelques mois en compte
// facilement plusieurs centaines. Ouvrir « la save » n'a donc pas de sens : on
// montre la carte de ce qui existe, et on charge la zone désignée.
//
// La carte se dessine à partir des seuls noms de fichiers — aucune région n'est
// décodée tant qu'on n'a pas choisi.

const SPAN = 512;
const fmtBytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} Go` : n > 1e6 ? `${Math.round(n / 1e6)} Mo` : `${Math.round(n / 1e3)} ko`);

export default function WorldPicker() {
  const world = useApp((s) => s.pendingWorld);
  const close = useApp((s) => s.cancelWorld);
  const confirm = useApp((s) => s.openWorldArea);
  const [picked, setPicked] = useState(() => new Set());
  const [drag, setDrag] = useState(null);
  const gridRef = useRef(null);

  // La sélection se (ré)initialise à chaque monde présenté. Un état initial
  // paresseux ne suffirait pas : ce composant est monté dès le démarrage, bien
  // avant qu'une save existe, et son initialiseur ne repasse jamais.
  useEffect(() => {
    if (!world) return;
    const present = new Set(world.regions.map((r) => `${r.regionX},${r.regionZ}`));
    // La région de l'origine par défaut : c'est là que commencent la plupart
    // des builds, et ça évite d'ouvrir la fenêtre sur un bouton inerte.
    setPicked(present.has('0,0') ? new Set(['0,0']) : new Set());
  }, [world]);

  const cells = useMemo(() => {
    if (!world?.bounds) return null;
    const { minX, maxX, minZ, maxZ } = world.bounds;
    const present = new Map(world.regions.map((r) => [`${r.regionX},${r.regionZ}`, r]));
    return { minX, maxX, minZ, maxZ, cols: maxX - minX + 1, rows: maxZ - minZ + 1, present };
  }, [world]);

  if (!world || !cells) return null;

  const key = (x, z) => `${x},${z}`;
  const toggle = (x, z) => {
    if (!cells.present.has(key(x, z))) return; // une région absente n'a rien à charger
    setPicked((s) => {
      const next = new Set(s);
      next.has(key(x, z)) ? next.delete(key(x, z)) : next.add(key(x, z));
      return next;
    });
  };

  // Glisser sélectionne un rectangle de régions — le geste naturel quand on
  // veut « cette zone-là », plutôt que de cliquer vingt cases.
  const rectFrom = (a, b) => {
    const out = new Set();
    for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++) {
      for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
        if (cells.present.has(key(x, z))) out.add(key(x, z));
      }
    }
    return out;
  };

  const chosen = drag ? rectFrom(drag.from, drag.to) : picked;
  const chosenRegions = [...chosen].map((k) => {
    const [x, z] = k.split(',').map(Number);
    return { regionX: x, regionZ: z };
  });
  const bytes = chosenRegions.reduce((s, r) => s + (cells.present.get(key(r.regionX, r.regionZ))?.bytes || 0), 0);

  // Emprise monde de la sélection : c'est ce que l'utilisateur lit sur son F3.
  const span = chosenRegions.length ? {
    minX: Math.min(...chosenRegions.map((r) => r.regionX)) * SPAN,
    minZ: Math.min(...chosenRegions.map((r) => r.regionZ)) * SPAN,
    maxX: Math.max(...chosenRegions.map((r) => r.regionX)) * SPAN + SPAN - 1,
    maxZ: Math.max(...chosenRegions.map((r) => r.regionZ)) * SPAN + SPAN - 1,
  } : null;

  /** Saisie directe de coordonnées : on entre un point du F3, on prend sa région. */
  const pickAround = (x, z, radius) => {
    const next = new Set();
    const cx = Math.floor(x / SPAN), cz = Math.floor(z / SPAN);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (cells.present.has(key(cx + dx, cz + dz))) next.add(key(cx + dx, cz + dz));
      }
    }
    setPicked(next);
  };

  return (
    <div className="modal-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-label="Choisir la zone à ouvrir">
        <header className="modal-head">
          <FolderTree size={15} />
          <div>
            <b>{world.name}</b>
            <small>{world.count} régions · {fmtBytes(world.bytes)} · {world.path}</small>
          </div>
        </header>

        <div className="modal-body">
          {world.lock.locked && (
            <p className="warn">
              <AlertTriangle size={13} />
              Ce monde est ouvert dans Minecraft. Tu peux le lire, mais pas y réécrire tant que le jeu tourne.
            </p>
          )}

          <p className="hint" style={{ marginTop: 0 }}>
            Une région couvre 512 × 512 blocs. Choisis celles à ouvrir — clique, ou glisse pour
            prendre un rectangle. Seules celles-là seront chargées.
          </p>

          <CoordJump onPick={pickAround} />

          <div
            className="region-grid"
            ref={gridRef}
            style={{ gridTemplateColumns: `repeat(${cells.cols}, var(--cell))` }}
            onMouseUp={() => { if (drag) { setPicked(rectFrom(drag.from, drag.to)); setDrag(null); } }}
            onMouseLeave={() => { if (drag) { setPicked(rectFrom(drag.from, drag.to)); setDrag(null); } }}
          >
            {Array.from({ length: cells.rows }, (_, row) => Array.from({ length: cells.cols }, (_, col) => {
              const x = cells.minX + col;
              const z = cells.minZ + row;
              const region = cells.present.get(key(x, z));
              return (
                <button
                  key={key(x, z)}
                  className="region-cell"
                  data-present={!!region}
                  data-picked={chosen.has(key(x, z))}
                  disabled={!region}
                  title={region
                    ? `r.${x}.${z} — X ${x * SPAN} à ${x * SPAN + SPAN - 1}, Z ${z * SPAN} à ${z * SPAN + SPAN - 1} · ${fmtBytes(region.bytes)}`
                    : `r.${x}.${z} — terrain jamais généré`}
                  onMouseDown={() => region && setDrag({ from: { x, z }, to: { x, z } })}
                  onMouseEnter={() => drag && setDrag((d) => ({ ...d, to: { x, z } }))}
                  onClick={() => !drag && toggle(x, z)}
                />
              );
            }))}
          </div>

          <div className="picker-summary">
            {chosenRegions.length === 0
              ? <span className="hint">Aucune région choisie.</span>
              : (
                <>
                  <b>{chosenRegions.length} région{chosenRegions.length > 1 ? 's' : ''}</b>
                  <span>· {fmtBytes(bytes)}</span>
                  <span className="picker-span">
                    X {span.minX} → {span.maxX} · Z {span.minZ} → {span.maxZ}
                  </span>
                </>
              )}
          </div>
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={close}>Annuler</button>
          <button
            className="btn"
            data-variant="primary"
            disabled={!chosenRegions.length}
            onClick={() => confirm(chosenRegions)}
          >
            <Globe size={13} />
            Ouvrir {chosenRegions.length ? `${chosenRegions.length} région${chosenRegions.length > 1 ? 's' : ''}` : 'la zone'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Aller à des coordonnées du F3, plutôt que de chercher la bonne case à l'œil. */
function CoordJump({ onPick }) {
  const [x, setX] = useState('0');
  const [z, setZ] = useState('0');
  const [r, setR] = useState('0');
  const go = (e) => {
    e.preventDefault();
    const nx = Number(x), nz = Number(z);
    if (Number.isFinite(nx) && Number.isFinite(nz)) onPick(nx, nz, Math.max(0, Number(r) || 0));
  };
  return (
    <form className="coord-jump" onSubmit={go}>
      <label htmlFor="cj-x">X</label>
      <input id="cj-x" className="input" value={x} onChange={(e) => setX(e.target.value)} inputMode="numeric" />
      <label htmlFor="cj-z">Z</label>
      <input id="cj-z" className="input" value={z} onChange={(e) => setZ(e.target.value)} inputMode="numeric" />
      <label htmlFor="cj-r" title="Régions à prendre autour">±</label>
      <input id="cj-r" className="input" value={r} onChange={(e) => setR(e.target.value)} inputMode="numeric" />
      <button className="btn" type="submit">Autour de ce point</button>
    </form>
  );
}
