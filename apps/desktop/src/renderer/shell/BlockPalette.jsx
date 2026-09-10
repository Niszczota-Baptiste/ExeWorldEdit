import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Layers, Search } from 'lucide-react';
import { useApp } from '../store.js';
import { blockColor } from '../viewport/blockColors.js';

// Palette de blocs. La liste est VIRTUALISÉE : le codex complet fait ~3 200
// entrées, et monter trois mille lignes dans le DOM ferait ramer le viewport
// à chaque frappe.
//
// Aujourd'hui elle liste les blocs réellement présents dans le build, avec leur
// décompte — c'est ce dont on a besoin en premier quand on ouvre un build qu'on
// n'a pas fait. Le codex complet (vanilla + minefield, avec icônes) arrive avec
// les assets en phase 2.4.

const pretty = (id) => id.replace(/^minecraft:/, '').replace(/_/g, ' ');

export default function BlockPalette() {
  const geometry = useApp((s) => s.geometry);
  const block = useApp((s) => s.block);
  const setBlock = useApp((s) => s.setBlock);
  const query = useApp((s) => s.paletteQuery);
  const setQuery = useApp((s) => s.setPaletteQuery);
  const parentRef = useRef(null);

  const rows = useMemo(() => {
    const bom = geometry?.bom || [];
    const q = query.trim().toLowerCase();
    const list = bom.map((b) => ({ id: b.blockId, count: b.count }));
    if (!q) return list;
    // Recherche indulgente : sur l'identifiant ET sur le nom lisible, pour que
    // « pierre taillée » et « stone_bricks » trouvent la même chose.
    return list.filter((r) => r.id.toLowerCase().includes(q) || pretty(r.id).includes(q));
  }, [geometry, query]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    overscan: 12,
  });

  return (
    <section className="side-panel" style={{ flex: 1, borderTop: '1px solid var(--line)' }}>
      <div className="panel-head">
        <Layers size={13} />
        <span>Palette de blocs</span>
        <span className="spacer" />
        <span style={{ color: 'var(--text-faint)' }}>{rows.length}</span>
      </div>

      <div className="palette-search">
        <div style={{ position: 'relative' }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--text-faint)' }} />
          <input
            className="input"
            style={{ paddingLeft: 26 }}
            placeholder="Filtrer les blocs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filtrer les blocs"
          />
        </div>
      </div>

      <div className="palette-list" ref={parentRef}>
        {rows.length === 0 && (
          <p className="hint" style={{ padding: '10px 12px' }}>
            {geometry ? 'Aucun bloc ne correspond.' : 'Ouvre un build pour voir sa palette.'}
          </p>
        )}
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((v) => {
            const r = rows[v.index];
            const [cr, cg, cb] = blockColor(r.id);
            return (
              <button
                key={r.id}
                className="block-row"
                data-active={block === r.id}
                style={{ position: 'absolute', top: 0, left: 0, transform: `translateY(${v.start}px)`, height: v.size }}
                onClick={() => setBlock(r.id)}
                title={r.id}
              >
                <span className="swatch" style={{ background: `rgb(${cr},${cg},${cb})` }} />
                <span className="block-name">{pretty(r.id)}</span>
                <span className="spacer" style={{ flex: 1 }} />
                <span className="block-count">{r.count.toLocaleString('fr-FR')}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
