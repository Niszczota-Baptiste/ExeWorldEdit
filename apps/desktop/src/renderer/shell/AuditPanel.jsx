import { useMemo, useState } from 'react';
import { Search } from './icons.js';
import { OPERATIONS } from '@titi/we-engine/operations';
import { DockExtra } from './dockSlot.js';
import { useApp } from '../store.js';

// Le JOURNAL : ce qui a réellement été fait sur ce build, dans l'ordre.
//
// La source est le journal du moteur (`appendAudit`, FsAdapter), pas une liste
// tenue par l'interface. La différence compte : le moteur écrit sa ligne APRÈS
// l'écriture des régions, donc ce qui figure ici a été appliqué. Une liste
// côté interface enregistrerait aussi les opérations qui ont échoué en cours
// de route, et donnerait à relire un historique faux.
//
// Ce n'est pas l'historique d'annulation. Celui-là est une PILE — annuler en
// retire le sommet. Le journal, lui, garde tout, `undo` compris : c'est la
// seule façon de savoir ce qui a été annulé, et quand.

const labelOf = new Map(OPERATIONS.map((o) => [o.id, o.label]));
/** Les entrées qui ne sont pas des opérations du catalogue. */
const HORS_CATALOGUE = { undo: 'Annulation', redo: 'Rétablissement', stroke: 'Pinceau', panel: 'Texte et carte' };
const nomOp = (id) => labelOf.get(id) || HORS_CATALOGUE[id] || id;

const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} s` : `${Math.round(n)} ms`);

const heure = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

/**
 * Les paramètres d'une entrée, en une ligne lisible.
 *
 * Volontairement APLATI et tronqué : `selection` pèse à elle seule six nombres
 * imbriqués, et un JSON brut dans une ligne de journal ne se lit pas. Ce qui
 * intéresse en relisant, c'est « remplacer quoi par quoi », pas la sélection —
 * elle est déjà résumée par le nombre de blocs.
 */
function resume(params) {
  const p = params?.params && typeof params.params === 'object' ? params.params : params;
  if (!p || typeof p !== 'object') return '';
  const bouts = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === 'selection' || v == null || v === '') continue;
    let texte;
    if (Array.isArray(v)) texte = v.length > 3 ? `${v.length} entrées` : v.map((x) => (typeof x === 'object' ? (x?.block ?? '…') : x)).join(', ');
    else if (typeof v === 'object') continue;
    else texte = String(v);
    bouts.push(`${k} ${texte.replace(/^minecraft:/, '')}`);
    if (bouts.length === 4) break;
  }
  return bouts.join(' · ');
}

export default function AuditPanel() {
  const lines = useApp((s) => s.auditLog);
  const project = useApp((s) => s.project());
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const besoin = q.trim().toLowerCase();
    if (!besoin) return lines;
    return lines.filter((l) => `${l.operation} ${nomOp(l.operation)} ${resume(l.params)}`.toLowerCase().includes(besoin));
  }, [lines, q]);

  const blocs = lines.reduce((s, l) => s + (l.blocksChanged || 0), 0);

  return (
    <section className="side-panel">
      <DockExtra>{rows.length} entrée{rows.length > 1 ? 's' : ''}</DockExtra>

      {lines.length > 0 && (
        <div className="palette-search">
          <div style={{ position: 'relative' }}>
            <Search size={12} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--text-faint)' }} />
            <input
              className="input"
              style={{ paddingLeft: 26 }}
              placeholder="Filtrer le journal"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Filtrer le journal"
            />
          </div>
        </div>
      )}

      <div className="audit-list">
        {!project && <p className="hint" style={{ padding: '10px 12px' }}>Ouvre un build pour voir son journal.</p>}
        {project && rows.length === 0 && (
          <p className="hint" style={{ padding: '10px 12px' }}>
            {lines.length ? 'Aucune entrée ne correspond.' : 'Rien n’a encore été appliqué à ce build.'}
          </p>
        )}

        {rows.map((l, i) => (
          <div className="audit-row" key={`${l.createdAt}-${i}`}>
            <div className="audit-row-head">
              <b>{nomOp(l.operation)}</b>
              <span className="spacer" style={{ flex: 1 }} />
              {l.durationMs != null && <span className="audit-ms">{ms(l.durationMs)}</span>}
              <span className="audit-time">{heure(l.createdAt)}</span>
            </div>
            <div className="audit-row-foot">
              {l.blocksChanged > 0 && <span className="audit-count">{l.blocksChanged.toLocaleString('fr-FR')} blocs</span>}
              <span className="audit-params" title={resume(l.params)}>{resume(l.params)}</span>
            </div>
          </div>
        ))}
      </div>

      {blocs > 0 && (
        <div className="audit-foot">
          <b>{blocs.toLocaleString('fr-FR')}</b> blocs modifiés sur {lines.length} entrée{lines.length > 1 ? 's' : ''}
        </div>
      )}
    </section>
  );
}
