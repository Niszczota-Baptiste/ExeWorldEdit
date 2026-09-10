import { useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FolderOpen, Layers3 } from 'lucide-react';
import TitleBar from './shell/TitleBar.jsx';
import ToolRail from './shell/ToolRail.jsx';
import Inspector from './shell/Inspector.jsx';
import BlockPalette from './shell/BlockPalette.jsx';
import StatusBar from './shell/StatusBar.jsx';
import ToolWheel from './shell/ToolWheel.jsx';
import Viewport from './viewport/Viewport.jsx';
import { useApp } from './store.js';

export default function App() {
  const geometry = useApp((s) => s.geometry);
  const project = useApp((s) => s.project());
  const layerY = useApp((s) => s.layerY);
  const setLayerY = useApp((s) => s.setLayerY);
  const setStats = useApp((s) => s.setStats);
  const refresh = useApp((s) => s.refreshProjects);
  const open = useApp((s) => s.open);
  const setWheel = useApp((s) => s.setWheel);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);

  useEffect(() => { refresh(); }, [refresh]);

  // Progression des opérations longues, relayée depuis le moteur.
  useEffect(() => window.titi.onEngineEvent((msg) => {
    if (msg.event === 'progress') useApp.setState({ busy: { operation: msg.operation, phase: msg.phase, pct: msg.pct } });
  }), []);

  // Raccourcis globaux.
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.code === 'Space' && !typing && !e.repeat) { e.preventDefault(); setWheel(true); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); open(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setWheel, undo, redo, open]);

  const minY = geometry?.min.y ?? 0;
  const maxY = geometry ? geometry.min.y + geometry.size.y - 1 : 0;

  return (
    <div className="shell">
      <TitleBar />

      <div className="body">
        <ToolRail />

        <PanelGroup direction="horizontal" autoSaveId="titi-layout">
          <Panel defaultSize={76} minSize={40}>
            <div className="viewport">
              {geometry ? <Viewport geometry={geometry} layerY={layerY} onStats={setStats} /> : <Empty onOpen={open} />}

              {project && (
                <>
                  <div className="hud hud-tl">
                    <span className="chip"><b>{project.name}</b></span>
                    <span className="chip">
                      {project.size.x} × {project.size.y} × {project.size.z}
                    </span>
                    {project.pending && <span className="chip" data-tone="select">Modifications non exportées</span>}
                  </div>

                  <div className="hud hud-bl">
                    <span className="chip">Molette pour zoomer · glisser pour pivoter · <b>ZQSD</b> pour voler</span>
                    <span className="chip">Maintiens <b>Espace</b> pour la roue d’outils</span>
                  </div>

                  {geometry && (
                    <div className="layer-slider">
                      <span className="chip" style={{ padding: '0 6px' }} title="Couche Y affichée">
                        <Layers3 size={11} />
                      </span>
                      <input
                        type="range"
                        min={minY}
                        max={maxY}
                        value={layerY ?? maxY}
                        onChange={(e) => setLayerY(Number(e.target.value))}
                        aria-label="Couche Y affichée"
                      />
                      <span className="chip" style={{ padding: '0 7px' }}>{layerY ?? maxY}</span>
                    </div>
                  )}
                </>
              )}

              <ToolWheel />
            </div>
          </Panel>

          <PanelResizeHandle className="handle" />

          <Panel defaultSize={24} minSize={16} maxSize={40}>
            <div className="side" style={{ height: '100%' }}>
              <PanelGroup direction="vertical" autoSaveId="titi-side">
                <Panel defaultSize={58} minSize={20}><Inspector /></Panel>
                <PanelResizeHandle className="handle" />
                <Panel defaultSize={42} minSize={18}><BlockPalette /></Panel>
              </PanelGroup>
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <StatusBar />
    </div>
  );
}

function Empty({ onOpen }) {
  return (
    <div className="empty">
      <Layers3 size={34} strokeWidth={1.2} style={{ color: 'var(--line)' }} />
      <h1>Aucun build ouvert</h1>
      <p>
        Ouvre un fichier de région <code>.mca</code>, un dossier <code>region/</code> zippé,
        un <code>.schem</code> ou un <code>.litematic</code>. Le fichier d’origine n’est jamais modifié :
        tout le travail se fait sur une copie.
      </p>
      <button className="btn" data-variant="primary" onClick={onOpen}>
        <FolderOpen size={13} /> Ouvrir un build
      </button>
    </div>
  );
}
