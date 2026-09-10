import { Minus, Square, X, Search, Pickaxe, Settings2, Gauge } from './icons.js';
import { useApp } from '../store.js';

// Barre de titre maison : onglets de projets et recherche. La zone vide est
// draggable (`-webkit-app-region`), les contrôles ne le sont pas — sans quoi
// cliquer un onglet déplacerait la fenêtre.

export default function TitleBar() {
  const projects = useApp((s) => s.projects);
  const activeId = useApp((s) => s.activeId);
  const activate = useApp((s) => s.activate);
  const closeProject = useApp((s) => s.closeProject);
  const openSettings = useApp((s) => s.setSettingsOpen);
  const perf = useApp((s) => s.settings.perf);
  const update = useApp((s) => s.updateSettings);
  const isWindows = window.titi?.platform === 'win32';

  return (
    <header className="titlebar">
      <div className="brand">
        <Pickaxe size={15} strokeWidth={2} />
        <span>Titi WorldEdit</span>
      </div>

      <div className="tabs" role="tablist" aria-label="Projets ouverts">
        {projects.map((p) => (
          // Un `div` et non un `button` : la croix est elle-même un bouton, et
          // un bouton dans un bouton n'est pas du HTML valide — le navigateur
          // défait l'imbrication et le clic devient imprévisible.
          <div
            key={p.id}
            className="tab"
            role="tab"
            tabIndex={0}
            data-active={p.id === activeId}
            aria-selected={p.id === activeId}
            onClick={() => activate(p.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(p.id); } }}
          >
            {/* Le point doré dit « modifications non exportées », comme la
                pastille de sélection du viewport. Même code couleur partout. */}
            {p.pending && <span className="tab-dot" title="Modifications non exportées" />}
            <span className="tab-name">{p.name}</span>
            <button
              className="tab-close"
              aria-label={`Fermer ${p.name}`}
              title="Fermer — supprime la copie de travail"
              onClick={(e) => { e.stopPropagation(); closeProject(p.id); }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>

      <button className="search" title="Palette de commandes">
        <Search size={12} />
        <span>Rechercher une action</span>
        <kbd>Ctrl K</kbd>
      </button>

      {/* Le relevé s'allume d'ici : quand une commande traîne, on veut savoir
          pourquoi tout de suite, pas après un détour par les réglages. */}
      <button
        className="title-btn"
        data-active={perf}
        title={perf ? 'Masquer le relevé de performance' : 'Afficher le relevé de performance'}
        aria-pressed={perf}
        onClick={() => update({ perf: !perf })}
      >
        <Gauge size={14} />
      </button>

      <button
        className="title-btn"
        title="Réglages (Ctrl ,)"
        aria-label="Réglages"
        onClick={() => openSettings(true)}
      >
        <Settings2 size={14} />
      </button>

      {/* Sur Windows, `titleBarOverlay` dessine les vrais boutons système :
          en redessiner ici en donnerait deux jeux. */}
      {!isWindows && (
        <div className="win-controls">
          <button className="win-btn" onClick={() => window.titi.window.minimize()} aria-label="Réduire"><Minus size={13} /></button>
          <button className="win-btn" onClick={() => window.titi.window.maximize()} aria-label="Agrandir"><Square size={11} /></button>
          <button className="win-btn" data-danger="true" onClick={() => window.titi.window.close()} aria-label="Fermer"><X size={14} /></button>
        </div>
      )}
    </header>
  );
}
