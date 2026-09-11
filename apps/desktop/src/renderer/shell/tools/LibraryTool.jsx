import { useEffect, useState } from 'react';
import { Library, Play, X } from '../icons.js';
import { useApp } from '../../store.js';

// « Bibliothèque » : ranger une zone et la reposer ailleurs, d'un build à
// l'autre.
//
// Le presse-papier du MOTEUR est le pivot. Ranger y prend ce qu'un « Copier »
// vient d'y mettre ; reprendre l'y remet pour qu'un « Coller » le pose. Rien
// ne transite par le renderer : un build de plusieurs millions de blocs n'a
// rien à faire dans le processus d'affichage.

const ko = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} k` : String(n));

export default function LibraryTool() {
  const items = useApp((s) => s.library);
  const clipboardReady = useApp((s) => s.clipboardReady);
  const refresh = useApp((s) => s.refreshLibrary);
  const save = useApp((s) => s.saveToLibrary);
  const load = useApp((s) => s.loadFromLibrary);
  const remove = useApp((s) => s.removeFromLibrary);
  const run = useApp((s) => s.run);
  const selection = useApp((s) => s.selection);
  const busy = useApp((s) => s.busy);
  const [name, setName] = useState('');

  useEffect(() => { refresh(); }, [refresh]);

  /** Copier PUIS ranger : sans le copier d'abord, le moteur refuse. */
  const ranger = async () => {
    const nom = name.trim();
    if (!nom) return;
    await run('copy', {});
    await save(nom);
    setName('');
  };

  return (
    <>
      <div className="field">
        <label htmlFor="lib-name">Ranger la sélection</label>
        <div className="row">
          <input
            id="lib-name" className="input" value={name} placeholder="Nom de l’élément"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') ranger(); }}
          />
          <button className="btn" disabled={!name.trim() || !selection || !!busy} onClick={ranger}>
            Ranger
          </button>
        </div>
        <p className="hint">
          La sélection est copiée puis rangée. {clipboardReady
            ? 'Le presse-papier contient déjà quelque chose : Ctrl V le pose.'
            : 'Le presse-papier est vide.'}
        </p>
      </div>

      <div className="field">
        <label>Éléments rangés ({items.length})</label>
        {items.length === 0 && <p className="hint">Rien pour l’instant.</p>}
        {items.map((it) => (
          <div key={it.id} className="row" style={{ marginBottom: 4, alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</div>
              <div className="hint" style={{ margin: 0 }}>
                {it.sx} × {it.sy} × {it.sz} · {ko(it.blockCount || 0)} blocs
              </div>
            </div>
            <button className="btn" title="Mettre dans le presse-papier" onClick={() => load(it.id, it.name)}>
              <Play size={12} /> Reprendre
            </button>
            <button
              className="btn btn-icon" title="Supprimer"
              onClick={() => { if (window.confirm(`Supprimer « ${it.name} » de la bibliothèque ?`)) remove(it.id, it.name); }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>

      <p className="hint" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <Library size={13} style={{ flex: 'none', marginTop: 1 }} />
        <span>
          « Reprendre » met l’élément dans le presse-papier ; il se pose ensuite au coin
          minimum de la sélection, avec <kbd>Ctrl</kbd> <kbd>V</kbd> ou l’opération « Coller »
          de l’outil Sélection.
        </span>
      </p>
    </>
  );
}
