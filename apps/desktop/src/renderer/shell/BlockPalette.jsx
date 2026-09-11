import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Layers, Search } from './icons.js';
import { searchBlocks, mergeDiscovered, blockLabel } from '@titi/we-engine/blocks';
import { useApp } from '../store.js';
import { blockColor } from '../viewport/blockColors.js';

// Palette de blocs, en DEUX onglets :
//
//   « Build »      les blocs réellement posés, avec leur décompte. Ce qu'on
//                  regarde en premier quand on ouvre un build qu'on n'a pas
//                  fait.
//   « Catalogue »  tout ce qu'on peut poser — la palette vanilla plus les
//                  `minefield:*` déclarés. Sans lui, commencer un build
//                  demandait de connaître l'identifiant par cœur et de le
//                  taper : la palette ne servait qu'à relire l'existant.
//
// La liste est VIRTUALISÉE : le catalogue dépasse trois cents entrées, et le
// `blocks.json` d'une installation peut en ajouter des milliers. Monter tout
// ça dans le DOM ferait ramer le viewport à chaque frappe.

export default function BlockPalette() {
  const geometry = useApp((s) => s.geometry);
  const block = useApp((s) => s.block);
  const setBlock = useApp((s) => s.setBlock);
  const query = useApp((s) => s.paletteQuery);
  const setQuery = useApp((s) => s.setPaletteQuery);
  const tab = useApp((s) => s.paletteTab);
  const setTab = useApp((s) => s.setPaletteTab);
  const catalog = useApp((s) => s.catalog);
  const groups = useApp((s) => s.catalogGroups);
  const parentRef = useRef(null);

  const groupLabel = useMemo(
    () => new Map((groups || []).map((g) => [g.id, g.label])),
    [groups],
  );

  // Le catalogue ACCUEILLE les blocs du build qu'il ne connaît pas : c'est ce
  // qui rend utilisables les `minefield:*` d'un serveur dont ce dépôt n'a pas
  // la liste — il suffit d'ouvrir un build où ils figurent.
  const complet = useMemo(() => {
    const base = catalog || [];
    const vus = (geometry?.bom || []).map((b) => b.blockId);
    return mergeDiscovered(base, vus);
  }, [catalog, geometry]);

  const rows = useMemo(() => {
    if (tab === 'build') {
      const list = (geometry?.bom || []).map((b) => ({ id: b.blockId, count: b.count }));
      return searchBlocks(list.map((r) => ({ ...r, id: r.id })), query);
    }
    return searchBlocks(complet, query);
  }, [tab, geometry, complet, query]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    overscan: 12,
  });

  const vide = tab === 'build'
    ? (geometry ? 'Aucun bloc ne correspond.' : 'Ouvre un build pour voir sa palette.')
    : (catalog ? 'Aucun bloc ne correspond.' : 'Catalogue en cours de chargement…');

  return (
    <section className="side-panel" style={{ flex: 1, borderTop: '1px solid var(--line)' }}>
      <div className="panel-head">
        <Layers size={13} />
        <span>Palette de blocs</span>
        <span className="spacer" />
        <span style={{ color: 'var(--text-faint)' }}>{rows.length}</span>
      </div>

      <div className="palette-tabs" role="tablist">
        {[['build', 'Dans le build'], ['catalogue', 'Catalogue']].map(([id, label]) => (
          <button
            key={id} role="tab" aria-selected={tab === id}
            className="palette-tab" data-active={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="palette-search">
        <div style={{ position: 'relative' }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--text-faint)' }} />
          <input
            className="input"
            style={{ paddingLeft: 26 }}
            placeholder={tab === 'build' ? 'Filtrer les blocs' : 'Chercher (pierre, mur, chêne…)'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Chercher un bloc"
          />
        </div>
      </div>

      <div className="palette-list" ref={parentRef}>
        {rows.length === 0 && <p className="hint" style={{ padding: '10px 12px' }}>{vide}</p>}
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
                <span className="block-name">{blockLabel(r.id)}</span>
                <span className="spacer" style={{ flex: 1 }} />
                <span className="block-count">
                  {r.count !== undefined
                    ? r.count.toLocaleString('fr-FR')
                    : (groupLabel.get(r.group) || (r.id.startsWith('minefield:') ? 'Minefield' : ''))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
