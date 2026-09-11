import { useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FolderOpen, FolderTree, Layers3 } from './shell/icons.js';
import TitleBar from './shell/TitleBar.jsx';
import ToolRail from './shell/ToolRail.jsx';
import Inspector from './shell/Inspector.jsx';
import BlockPalette from './shell/BlockPalette.jsx';
import StatusBar from './shell/StatusBar.jsx';
import ToolWheel from './shell/ToolWheel.jsx';
import WorldPicker from './shell/WorldPicker.jsx';
import Settings from './shell/Settings.jsx';
import PerfPanel from './shell/PerfPanel.jsx';
import Viewport from './viewport/Viewport.jsx';
import { useApp } from './store.js';
import { actionForEvent } from './keys.js';

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
  const openPath = useApp((s) => s.openPath);
  const openWorld = useApp((s) => s.openWorld);
  const loadSettings = useApp((s) => s.loadSettings);
  const loadCatalog = useApp((s) => s.loadCatalog);
  const loadPackInfo = useApp((s) => s.loadPackInfo);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const run = useApp((s) => s.run);
  const setTool = useApp((s) => s.setTool);
  const keys = useApp((s) => s.keys);
  const tool = useApp((s) => s.tool);
  const brush = useApp((s) => s.brush);
  const applyStroke = useApp((s) => s.applyStroke);
  const [dropping, setDropping] = useState(false);

  useEffect(() => { refresh(); }, [refresh]);
  // Le thème AVANT les projets : appliquer les réglages après coup montrerait
  // un instant l'apparence par défaut, puis la verrait sauter.
  useEffect(() => { loadSettings(); }, [loadSettings]);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);
  useEffect(() => { loadPackInfo(); }, [loadPackInfo]);

  // Glisser-déposer sur toute la fenêtre. Le renderer ne LIT pas le fichier :
  // il n'en transmet que le chemin, et c'est le processus principal qui décide
  // quoi en faire. Un renderer sans accès disque le reste.
  useEffect(() => {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    const onOver = (e) => { stop(e); setDropping(true); };
    const onLeave = (e) => { stop(e); if (e.relatedTarget === null) setDropping(false); };
    const onDrop = (e) => {
      stop(e);
      setDropping(false);
      const file = e.dataTransfer?.files?.[0];
      // `path` est posé par Electron sur les fichiers déposés ; c'est la seule
      // façon d'obtenir un chemin réel depuis un renderer en sandbox.
      if (file?.path) openPath(file.path);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [openPath]);

  // Événements venus du processus principal : progression des opérations
  // longues, et chemin à ouvrir passé au lancement.
  useEffect(() => window.titi.onEngineEvent((msg) => {
    if (msg.event === 'progress') useApp.setState({ busy: { operation: msg.operation, phase: msg.phase, pct: msg.pct } });
    if (msg.event === 'open-path') openPath(msg.path);
  }), [openPath]);

  // Raccourcis globaux.
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      // UNE table, celle des réglages. Avant, les combinaisons étaient écrites
      // en dur ici et les lettres d'outil dans `TOOLS` : rien de réassignable,
      // et rien qui empêchait deux actions de partager une touche.
      const action = actionForEvent(keys, e);
      if (!action) return;

      // La roue se MAINTIENT : c'est le seul raccourci qui se répète, donc le
      // seul qui doit filtrer `e.repeat`.
      if (action === 'wheel') {
        if (!typing && !e.repeat) { e.preventDefault(); setWheel(true); }
        return;
      }
      // Ce qui se tape dans un champ appartient au champ. Les raccourcis de
      // l'application n'y touchent pas — sauf ceux qui ont un modificateur et
      // qu'aucun champ n'utilise (ouvrir, réglages).
      if (typing && !['open', 'settings'].includes(action)) return;

      e.preventDefault();
      if (action.startsWith('tool.')) { setTool(action.slice(5)); return; }
      if (action === 'undo') undo();
      else if (action === 'redo') redo();
      else if (action === 'open') open();
      else if (action === 'settings') setSettingsOpen(true);
      else if (action === 'copy') run('copy', {});
      else if (action === 'paste') run('paste', { mode: 'overlay' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys, setWheel, undo, redo, open, setSettingsOpen, run, setTool]);

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
              {geometry
                ? (
                  <Viewport
                    geometry={geometry}
                    layerY={layerY}
                    onStats={setStats}
                    // Le pinceau n'est armé que quand son outil est choisi :
                    // sinon le clic gauche sert à tourner la caméra.
                    brush={tool === 'brush' && project ? { ...brush, limits: project.limits } : null}
                    onStroke={applyStroke}
                  />
                )
                : <Empty onOpen={open} onOpenWorld={openWorld} />}

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

              <PerfPanel />

              <ToolWheel />

              {dropping && (
                <div className="drop-veil">
                  <div className="drop-card">
                    <FolderOpen size={26} strokeWidth={1.3} />
                    <b>Déposer pour ouvrir</b>
                    <span>.mca · dossier region/ zippé · .schem · .litematic</span>
                  </div>
                </div>
              )}
            </div>
          </Panel>

          <PanelResizeHandle className="handle" />

          <Panel defaultSize={24} minSize={16} maxSize={40}>
            <div className="side" style={{ height: '100%' }}>
              <PanelGroup direction="vertical" autoSaveId="titi-side">
                {/* L'inspecteur d'abord : c'est la surface de travail. Une
                    opération à plusieurs paramètres — « Mélange » et ses lignes
                    de blocs — y tient sans défiler. */}
                <Panel defaultSize={66} minSize={20}><Inspector /></Panel>
                <PanelResizeHandle className="handle" />
                <Panel defaultSize={34} minSize={18}><BlockPalette /></Panel>
              </PanelGroup>
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <StatusBar />
      <WorldPicker />
      <Settings />
    </div>
  );
}

function Empty({ onOpen, onOpenWorld }) {
  return (
    <div className="empty">
      <Layers3 size={34} strokeWidth={1.2} style={{ color: 'var(--line)' }} />
      <h1>Aucun build ouvert</h1>
      <p>
        Ouvre un fichier de région <code>.mca</code>, un dossier <code>region/</code> zippé,
        un <code>.schem</code> ou un <code>.litematic</code>. Le fichier d’origine n’est jamais modifié :
        tout le travail se fait sur une copie.
      </p>
      <div className="row" style={{ flex: 'none' }}>
        <button className="btn" data-variant="primary" onClick={onOpen}>
          <FolderOpen size={13} /> Ouvrir un fichier
        </button>
        <button className="btn" onClick={onOpenWorld}>
          <FolderTree size={13} /> Ouvrir une save
        </button>
      </div>
      <p style={{ margin: 0, fontSize: 'var(--t-micro)', color: 'var(--line)' }}>
        …ou glisse un fichier dans la fenêtre.
      </p>
    </div>
  );
}
