import { useEffect, useState } from 'react';
import { Gauge, ChevronDown, X } from './icons.js';
import { useApp } from '../store.js';

// Relevé de performance en direct.
//
// Une opération lente n'apprend rien tant qu'on ne sait pas OÙ elle est lente.
// Le moteur chronomètre quatre temps ; ce panneau les montre à l'échelle, côte
// à côte, et désigne le plus coûteux. C'est la même mesure que celle consignée
// au journal — pas un second chronomètre tenu ici, qui compterait aussi les
// allers-retours entre les processus et mentirait de quelques dizaines de ms.

/** Les phases du moteur, dans l'ordre où elles se déroulent. */
const PHASES = {
  load: { label: 'Lecture des régions', short: 'lecture', color: '#6BA6D6' },
  apply: { label: 'Calcul de l’opération', short: 'calcul', color: '#7FB8A4' },
  commit: { label: 'Écriture et instantané', short: 'écriture', color: '#E3B64F' },
  preview: { label: 'Régénération de l’aperçu', short: 'aperçu', color: '#9B8FD6' },
  reste: { label: 'Reste (validation, journal)', short: 'reste', color: '#5A6472' },
};
const phaseOf = (id) => PHASES[id] || { label: id, short: id, color: '#5A6472' };

const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} s` : `${Math.round(n)} ms`);

export default function PerfPanel() {
  const on = useApp((s) => s.settings.perf);
  const log = useApp((s) => s.perfLog);
  const busy = useApp((s) => s.busy);
  const stats = useApp((s) => s.stats);
  const info = useApp((s) => s.engineInfo);
  const refreshInfo = useApp((s) => s.refreshEngineInfo);
  const [folded, setFolded] = useState(false);

  // La mémoire du moteur ne se sonde que quand on la regarde : un RPC toutes
  // les deux secondes en permanence réveillerait le processus pour rien.
  useEffect(() => {
    if (!on || folded) return undefined;
    refreshInfo();
    const t = setInterval(refreshInfo, 2000);
    return () => clearInterval(t);
  }, [on, folded, refreshInfo]);

  if (!on) return null;

  // Cumul par phase sur tout le relevé : une commande lente une fois est un
  // accident, la même phase lente dix fois est une cible.
  const totals = new Map();
  for (const e of log) for (const p of e.phases) totals.set(p.phase, (totals.get(p.phase) || 0) + p.ms);
  const grand = [...totals.values()].reduce((s, v) => s + v, 0);

  return (
    <div className="perf" data-folded={folded}>
      <header className="perf-head">
        <Gauge size={12} />
        <b>Performances</b>
        <span className="perf-live">{folded ? `${stats.fps ?? '—'} i/s` : ''}</span>
        <button
          className="perf-btn"
          onClick={() => setFolded((f) => !f)}
          aria-label={folded ? 'Déplier le relevé' : 'Replier le relevé'}
          aria-expanded={!folded}
        >
          <ChevronDown size={13} style={{ transform: folded ? 'rotate(-90deg)' : 'none' }} />
        </button>
        <button
          className="perf-btn"
          onClick={() => useApp.getState().updateSettings({ perf: false })}
          aria-label="Fermer le relevé"
        >
          <X size={12} />
        </button>
      </header>

      {!folded && (
        <div className="perf-body">
          {/* Le direct d'abord : c'est ce qu'on regarde pendant qu'une commande
              tourne. L'historique est en dessous, pour après. */}
          <div className="perf-live-row">
            <span>{stats.fps ?? '—'} i/s</span>
            {stats.drawCalls != null && <span>{stats.drawCalls} dessins</span>}
            {stats.chunks != null && <span>{stats.chunks} chunks</span>}
            {info?.memory && <span>{Math.round(info.memory.rss / 1e6)} Mo</span>}
          </div>

          {busy && (
            <div className="perf-now">
              <span className="perf-dot" style={{ background: phaseOf(busy.phase).color }} />
              <b>{busy.operation}</b>
              <span>{phaseOf(busy.phase).label}</span>
              <span className="perf-now-pct">{busy.pct || 0} %</span>
            </div>
          )}

          {log.length === 0 && !busy && (
            <p className="hint" style={{ margin: 0 }}>
              Aucune opération mesurée sur ce build. Lance une commande : son
              découpage apparaîtra ici.
            </p>
          )}

          {log.slice(0, 6).map((e, i) => <Row key={`${e.at}-${i}`} entry={e} />)}

          {grand > 0 && (
            <div className="perf-totals">
              <span className="perf-totals-label">Cumul sur {log.length} opération{log.length > 1 ? 's' : ''}</span>
              {[...totals.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([id, v]) => (
                  <span key={id} className="perf-total">
                    <i style={{ background: phaseOf(id).color }} />
                    {phaseOf(id).short}
                    <b>{Math.round((v / grand) * 100)} %</b>
                  </span>
                ))}
            </div>
          )}

          {stats.meshMs != null && (
            <div className="perf-foot">
              Maillage du dernier aperçu : <b>{ms(stats.meshMs)}</b> — fait dans
              le renderer, il n’entre pas dans les totaux ci-dessus.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Une opération : total, barre à l'échelle de ses phases, phase dominante. */
function Row({ entry }) {
  const total = Math.max(1, entry.totalMs);
  // La phase dominante est ce qu'on cherchait en ouvrant le panneau : elle est
  // nommée en clair, pas laissée à déduire de la largeur des segments.
  const worst = entry.phases.reduce((a, b) => (b.ms > a.ms ? b : a), entry.phases[0]);

  return (
    <div className="perf-row">
      <div className="perf-row-head">
        <b>{entry.operation}</b>
        <span>{entry.blocksChanged.toLocaleString('fr-FR')} blocs</span>
        <span className="perf-row-total">{ms(entry.totalMs)}</span>
      </div>

      <div className="perf-bar" role="img" aria-label={entry.phases.map((p) => `${phaseOf(p.phase).short} ${Math.round(p.ms)} ms`).join(', ')}>
        {entry.phases.map((p, i) => (
          <i
            key={`${p.phase}-${i}`}
            style={{ width: `${(p.ms / total) * 100}%`, background: phaseOf(p.phase).color }}
            title={`${phaseOf(p.phase).label} — ${ms(p.ms)}`}
          />
        ))}
      </div>

      {/* La phase dominante, nommée : c'est la réponse à « où ça bloque », et
          la déduire de la largeur d'un segment n'est pas la donner. */}
      {worst && worst.ms > 0 && (
        <div className="perf-worst">
          <i style={{ background: phaseOf(worst.phase).color }} />
          {phaseOf(worst.phase).short}
          <b>{ms(worst.ms)}</b>
          <span>{Math.round((worst.ms / total) * 100)} %</span>
        </div>
      )}
    </div>
  );
}
