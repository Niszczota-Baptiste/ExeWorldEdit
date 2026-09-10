import * as Icons from './icons.js';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useApp, TOOLS } from '../store.js';

// Rail d'outils. Il ne porte que des icônes : les libellés vivent dans
// l'infobulle et dans la roue radiale, pour que la colonne reste étroite et
// que le viewport garde la place.

export default function ToolRail() {
  const tool = useApp((s) => s.tool);
  const setTool = useApp((s) => s.setTool);

  return (
    <Tooltip.Provider delayDuration={420}>
      <nav className="rail" aria-label="Outils">
        {TOOLS.map((t, i) => {
          const Icon = Icons[t.icon] || Icons.Square;
          return (
            <div key={t.id} style={{ display: 'contents' }}>
              {(i === 1 || i === 5 || i === 9) && <div className="rail-sep" />}
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    className="tool"
                    data-active={tool === t.id}
                    disabled={t.soon}
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
