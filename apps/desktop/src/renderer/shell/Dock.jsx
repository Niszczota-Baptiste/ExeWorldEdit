import { useState } from 'react';
import * as Icons from './icons.js';
import { useApp } from '../store.js';
import { DockSlot } from './dockSlot.js';
import { PANELS, ZONES } from '../layout.js';

// Un EMPLACEMENT : une barre d'onglets, et le panneau visible en-dessous.
//
// Les onglets se déplacent comme ceux d'un navigateur — on en attrape un, on le
// dépose ailleurs, il s'y range. Rien de plus, et surtout pas un système de
// fenêtres flottantes : ce qu'on veut, c'est choisir où vivent les outils, pas
// gérer des fenêtres.
//
// Le transport passe par `dataTransfer` et non par un état global : c'est le
// mécanisme du navigateur, il survit au passage d'un conteneur à l'autre, et
// il donne gratuitement le curseur « déplacer » et l'annulation par Échap.

const byId = new Map(PANELS.map((p) => [p.id, p]));
const TYPE = 'application/x-titi-panel';

/** Ce qu'on déplace, lu depuis l'événement. `null` si ce n'est pas un panneau. */
function panneauDe(e) {
  const id = e.dataTransfer?.getData(TYPE);
  return id && byId.has(id) ? id : null;
}

export default function Dock({ zone, children }) {
  const layout = useApp((s) => s.layout);
  const movePanel = useApp((s) => s.movePanel);
  const setActivePanel = useApp((s) => s.setActivePanel);
  const setDragging = useApp((s) => s.setDragging);
  const [survol, setSurvol] = useState(null); // indice de dépôt visé
  // Un état et pas une `ref` : le portail du panneau a besoin du nœud AU RENDU,
  // et une `ref` vaut encore `null` à ce moment-là.
  const [extraEl, setExtraEl] = useState(null);

  const ids = layout.zones[zone] || [];
  const actif = layout.active[zone];
  if (!ids.length) return null;

  const deposer = (e, index) => {
    e.preventDefault();
    e.stopPropagation();
    setSurvol(null);
    const id = panneauDe(e);
    if (id) movePanel(id, zone, index);
  };

  return (
    <section className="dock" data-zone={zone}>
      <div
        className="dock-tabs"
        role="tablist"
        // Déposer sur la barre ELLE-MÊME range à la fin : sans ça, l'espace
        // vide à droite des onglets n'accepte rien et le geste échoue sans
        // qu'on comprenne pourquoi.
        onDragOver={(e) => { if (panneauDe(e) !== null || e.dataTransfer.types.includes(TYPE)) { e.preventDefault(); setSurvol(ids.length); } }}
        onDragLeave={() => setSurvol(null)}
        onDrop={(e) => deposer(e, ids.length)}
      >
        {ids.map((id, i) => {
          const p = byId.get(id);
          const Icon = Icons[p.icon] || Icons.Square;
          return (
            <button
              key={id}
              role="tab"
              className="dock-tab"
              data-panel={id}
              data-active={id === actif}
              data-drop={survol === i || undefined}
              aria-selected={id === actif}
              // Le nom d'un onglet rétréci finit en points de suspension : sans
              // l'infobulle, un panneau devient impossible à identifier.
              title={p.label}
              draggable
              onClick={() => setActivePanel(zone, id)}
              onDragStart={(e) => {
                e.dataTransfer.setData(TYPE, id);
                e.dataTransfer.effectAllowed = 'move';
                // C'est ce drapeau qui fait apparaître les bordures de dépôt
                // des emplacements vides : sans lui, un emplacement qu'on a
                // vidé n'aurait plus aucune surface pour le recevoir.
                setDragging(true);
              }}
              // `dragend` part TOUJOURS, y compris quand le geste est annulé
              // par Échap ou lâché dans le vide. S'en remettre au seul `drop`
              // laisserait les bandes affichées après un geste abandonné.
              onDragEnd={() => setDragging(false)}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(TYPE)) return;
                e.preventDefault();
                e.stopPropagation();
                setSurvol(i);
              }}
              onDrop={(e) => deposer(e, i)}
            >
              <Icon size={12} />
              <span>{p.label}</span>
            </button>
          );
        })}
        {survol === ids.length && <span className="dock-drop-end" aria-hidden="true" />}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="dock-extra" ref={setExtraEl} />
      </div>

      <div className="dock-body" role="tabpanel" aria-label={byId.get(actif)?.label}>
        <DockSlot.Provider value={extraEl}>{children(actif)}</DockSlot.Provider>
      </div>
    </section>
  );
}

/**
 * Zone de dépôt d'un CÔTÉ vide.
 *
 * Sans elle, un côté sans panneau n'existe pas dans le DOM et ne peut donc rien
 * recevoir : la gauche serait à jamais inaccessible une fois vidée. Elle ne se
 * montre que pendant un déplacement — une bande morte en permanence serait pire
 * que le problème qu'elle règle.
 */
export function DropZone({ zone, dragging }) {
  const movePanel = useApp((s) => s.movePanel);
  const [vise, setVise] = useState(false);
  const meta = ZONES.find((z) => z.id === zone);
  if (!dragging) return null;
  return (
    <div
      className="dock-empty"
      data-zone={zone}
      data-over={vise || undefined}
      onDragOver={(e) => { if (e.dataTransfer.types.includes(TYPE)) { e.preventDefault(); setVise(true); } }}
      onDragLeave={() => setVise(false)}
      onDrop={(e) => {
        e.preventDefault();
        setVise(false);
        const id = panneauDe(e);
        if (id) movePanel(id, zone, 0);
      }}
    >
      <span>{meta?.label}</span>
    </div>
  );
}

export { TYPE as PANEL_DRAG_TYPE };
