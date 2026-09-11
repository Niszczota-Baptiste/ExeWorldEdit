import * as Icons from './icons.js';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useApp, TOOLS } from '../store.js';

// Rail d'outils. Il ne porte que des icônes : les libellés vivent dans
// l'infobulle et dans la roue radiale, pour que la colonne reste étroite et
// que le viewport garde la place.

export default function ToolRail() {
  const tool = useApp((s) => s.tool);
  const setTool = useApp((s) => s.setTool);
  const open = useApp((s) => s.open);
  const openWorld = useApp((s) => s.openWorld);

  return (
    <Tooltip.Provider delayDuration={420}>
      <nav className="rail" aria-label="Outils">
        {/* Ouvrir doit rester atteignable UNE FOIS un projet ouvert : les
            boutons de l'écran d'accueil disparaissent avec lui, et `Ctrl O`
            tout seul ne se devine pas. */}
        <Action icon={Icons.FolderOpen} label="Ouvrir un fichier" hint="Ctrl O" onClick={open} />
        <Action icon={Icons.FolderTree} label="Ouvrir une save" onClick={openWorld} />
        <div className="rail-sep" />

        {TOOLS.map((t, i) => {
          const Icon = Icons[t.icon] || Icons.Square;
          return (
            <div key={t.id} style={{ display: 'contents' }}>
              {(i === 5 || i === 9) && <div className="rail-sep" />}
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    className="tool"
                    data-active={tool === t.id}
                    // PAS `disabled` : un bouton mort n'explique rien. L'outil
                    // s'ouvre, et l'inspecteur dit ce qu'il fera et ce qui
                    // manque encore. Il reste hors de la roue radiale, qui est
                    // un geste rapide et n'a rien à proposer d'inutilisable.
                    data-soon={t.soon || undefined}
                    aria-label={t.label}
                    aria-pressed={tool === t.id}
                    onClick={() => setTool(t.id)}
                  >
                    <Icon size={17} strokeWidth={1.75} />
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content className="chip" side="right" sideOffset={8}>
                    <b>{t.label}</b>
                    {t.soon ? <span>· bientôt</span> : <kbd style={{ opacity: 0.7 }}>{t.key}</kbd>}
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </div>
          );
        })}
      </nav>
    </Tooltip.Provider>
  );
}

/** Une ACTION du rail — pas un outil : elle ne reste pas enfoncée. */
function Action({ icon: Icon, label, hint, onClick }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button className="tool" aria-label={label} onClick={onClick}>
          <Icon size={17} strokeWidth={1.75} />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="chip" side="right" sideOffset={8}>
          <b>{label}</b>
          {hint && <kbd style={{ opacity: 0.7 }}>{hint}</kbd>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
