import { Gauge, Boxes, Crosshair, MemoryStick, History, ArrowRight } from 'lucide-react';
import { useApp } from '../store.js';

// Barre d'état : coordonnées, sélection, blocs, mémoire, images par seconde,
// tâche en cours. Elle ne montre que des CHIFFRES qu'on peut vérifier, jamais
// un indicateur décoratif.

export default function StatusBar() {
  const project = useApp((s) => s.project());
  const geometry = useApp((s) => s.geometry);
  const selection = useApp((s) => s.selection);
  const stats = useApp((s) => s.stats);
  const busy = useApp((s) => s.busy);
  const toast = useApp((s) => s.toast);

  const selCount = selection
    ? (selection.max.x - selection.min.x + 1) * (selection.max.y - selection.min.y + 1) * (selection.max.z - selection.min.z + 1)
    : 0;

  return (
    <footer className="statusbar">
      <Timeline />

      <span className="spacer" />

      {toast && <span className="status-item" style={{ color: 'var(--text-dim)' }}>{toast}</span>}

      {busy && (
        <>
          <span className="status-item">
            <b>{busy.operation}</b>
            <span>{busy.phase}</span>
            <span className="progress"><i style={{ width: `${busy.pct || 0}%` }} /></span>
          </span>
          <span className="status-sep" />
        </>
      )}

      {project && (
        <>
          <span className="status-item" title="Emprise du contenu">
            <Crosshair size={12} />
            <b>{project.extent.min.x} · {project.extent.min.y} · {project.extent.min.z}</b>
            <ArrowRight size={10} />
            <b>{project.extent.max.x} · {project.extent.max.y} · {project.extent.max.z}</b>
          </span>
          <span className="status-sep" />
        </>
      )}

      {selection && (
        <>
          <span className="status-item" style={{ color: 'var(--select)' }} title="Sélection">
            <b style={{ color: 'inherit' }}>{selCount.toLocaleString('fr-FR')}</b> blocs sélectionnés
          </span>
          <span className="status-sep" />
        </>
      )}

      {geometry && (
        <>
          <span className="status-item" title="Blocs affichés · chunks maillés">
            <Boxes size={12} />
            <b>{geometry.count.toLocaleString('fr-FR')}</b>
            {stats.chunks ? <span>· {stats.chunks} chunks</span> : null}
            {geometry.truncated ? <span style={{ color: 'var(--select)' }}>· aperçu partiel</span> : null}
          </span>
          <span className="status-sep" />
        </>
      )}

      {stats.meshMs != null && (
        <>
          <span className="status-item" title="Temps de maillage du build">
            <MemoryStick size={12} />
            <b>{stats.meshMs} ms</b>
          </span>
          <span className="status-sep" />
        </>
      )}

      <span className="status-item" title="Images par seconde · appels de dessin">
        <Gauge size={12} />
        <b>{stats.fps ?? '—'}</b> i/s
        {stats.drawCalls != null && <span>· {stats.drawCalls} dessins</span>}
      </span>
    </footer>
  );
}

/**
 * Historique en ligne. Le journal du moteur est la source : ce qui s'affiche
 * ici a réellement été appliqué, ce n'est pas une liste tenue par l'interface
 * qui pourrait diverger.
 */
function Timeline() {
  const project = useApp((s) => s.project());
  if (!project) return <span className="status-item" style={{ color: 'var(--text-faint)' }}>Aucun projet</span>;

  return (
    <span className="status-item" style={{ minWidth: 0 }}>
      <History size={12} />
      <span className="timeline">
        <button className="tl-entry">Source</button>
        {project.undoDepth > 0 && (
          <>
            <ArrowRight size={10} className="tl-arrow" />
            <button className="tl-entry">
              {project.undoDepth} opération{project.undoDepth > 1 ? 's' : ''}
            </button>
          </>
        )}
        <ArrowRight size={10} className="tl-arrow" />
        <button className="tl-entry" data-head="true">
          {project.pending ? 'Modifié' : 'À jour'}
        </button>
      </span>
    </span>
  );
}
