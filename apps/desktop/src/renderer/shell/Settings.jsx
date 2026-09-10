import { Settings2, Gauge, Type, Layers, RotateCcw } from './icons.js';
import { useApp } from '../store.js';
import { ACCENTS, RANGES, DEFAULT_SETTINGS } from '../theme.js';

// Réglages de l'atelier : lisibilité, densité, couleur, mode performance.
//
// Chaque champ s'applique À LA FRAPPE, pas au moment de valider. Un réglage
// d'apparence qu'on ne voit qu'après avoir fermé la fenêtre se règle à l'aveugle
// — donc il n'y a pas de bouton « Appliquer », seulement « Fermer ».

const pct = (v) => `${Math.round(v * 100)} %`;

export default function Settings() {
  const open = useApp((s) => s.settingsOpen);
  const close = () => useApp.getState().setSettingsOpen(false);
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const reset = useApp((s) => s.resetSettings);
  const info = useApp((s) => s.engineInfo);

  if (!open) return null;

  return (
    <div className="modal-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" style={{ width: 'min(560px, 88vw)' }} role="dialog" aria-label="Réglages">
        <header className="modal-head">
          <Settings2 size={15} />
          <div>
            <b>Réglages</b>
            <small>Appliqués immédiatement et conservés d’une session à l’autre.</small>
          </div>
        </header>

        <div className="modal-body">
          <Section icon={<Type size={12} />} title="Lisibilité">
            <Slider
              id="s-text"
              label="Taille du texte"
              value={settings.textScale}
              range={RANGES.textScale}
              format={pct}
              onChange={(textScale) => update({ textScale })}
            />
            <p className="hint" style={{ marginTop: 0 }}>
              N’agit que sur le texte. Les panneaux s’élargissent d’eux-mêmes.
            </p>
          </Section>

          <Section icon={<Layers size={12} />} title="Densité de l’interface">
            <Slider
              id="s-ui"
              label="Taille des barres et des boutons"
              value={settings.uiScale}
              range={RANGES.uiScale}
              format={pct}
              onChange={(uiScale) => update({ uiScale })}
            />
            <p className="hint" style={{ marginTop: 0 }}>
              Barre de titre, rail d’outils, barre d’état et champs. Le viewport
              garde toute la place qui reste.
            </p>
          </Section>

          <Section title="Couleur de l’interface">
            <div className="swatch-row">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  className="accent-chip"
                  data-active={settings.accent.toUpperCase() === a.hex}
                  style={{ '--chip': a.hex }}
                  title={a.label}
                  aria-label={a.label}
                  aria-pressed={settings.accent.toUpperCase() === a.hex}
                  onClick={() => update({ accent: a.hex })}
                />
              ))}
              <label className="accent-free" title="Couleur libre">
                <input
                  type="color"
                  value={settings.accent}
                  onChange={(e) => update({ accent: e.target.value })}
                  aria-label="Couleur d’accent libre"
                />
                <span>{settings.accent}</span>
              </label>
            </div>
            <p className="hint">
              Sert à l’outil actif, au focus et au bouton principal. L’or de la
              sélection ne bouge pas : c’est un code, pas une décoration.
            </p>
          </Section>

          <Section icon={<Gauge size={12} />} title="Performances">
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.perf}
                onChange={(e) => update({ perf: e.target.checked })}
              />
              <span className="switch-track" aria-hidden="true"><i /></span>
              <span>
                <b>Afficher le relevé des opérations</b>
                <small>
                  Décompose chaque commande en quatre temps — lecture des régions,
                  calcul, réécriture, aperçu — et montre lequel coûte.
                </small>
              </span>
            </label>

            {info && (
              <dl className="kv">
                <dt>Mémoire du moteur</dt>
                <dd>{Math.round((info.memory?.rss || 0) / 1e6)} Mo</dd>
                <dt>Volume de sélection maximal</dt>
                <dd>{(info.limits?.maxSelectionVolume || 0).toLocaleString('fr-FR')} blocs</dd>
                <dt>Budget d’aperçu</dt>
                <dd>{(info.limits?.previewMaxBlocks || 0).toLocaleString('fr-FR')} blocs</dd>
                <dt>Profondeur d’annulation</dt>
                <dd>{info.limits?.maxUndo}</dd>
                <dt>Données</dt>
                <dd className="kv-path" title={info.dataRoot}>{info.dataRoot}</dd>
              </dl>
            )}
          </Section>
        </div>

        <footer className="modal-foot">
          <button
            className="btn"
            onClick={reset}
            disabled={JSON.stringify(settings) === JSON.stringify(DEFAULT_SETTINGS)}
          >
            <RotateCcw size={13} /> Valeurs d’origine
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" data-variant="primary" onClick={close}>Fermer</button>
        </footer>
      </div>
    </div>
  );
}

function Section({ icon, title, children }) {
  return (
    <section className="settings-section">
      <h2>{icon}{title}</h2>
      {children}
    </section>
  );
}

/** Curseur avec sa valeur lue à côté : un curseur sans chiffre ne se règle pas. */
function Slider({ id, label, value, range, format, onChange }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}<span className="field-value">{format(value)}</span></label>
      <input
        id={id}
        className="range"
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
