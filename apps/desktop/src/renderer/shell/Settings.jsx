import { useEffect, useState } from 'react';
import { Settings2, Gauge, Type, Layers, RotateCcw, Boxes } from './icons.js';
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
  const limits = useApp((s) => s.limits);
  const limitRanges = useApp((s) => s.limitRanges);
  const updateLimits = useApp((s) => s.updateLimits);

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
                <dt>Données</dt>
                <dd className="kv-path" title={info.dataRoot}>{info.dataRoot}</dd>
              </dl>
            )}
          </Section>

          <Section icon={<Boxes size={12} />} title="Plafonds du moteur">
            <p className="hint" style={{ marginTop: 0 }}>
              Ce que la machine peut encaisser. Les relever permet de travailler
              plus grand ; trop haut, une opération peut épuiser la mémoire.
            </p>
            {limits && limitRanges
              ? Object.entries(limitRanges).map(([key, range]) => (
                <LimitField
                  key={key}
                  id={`lim-${key}`}
                  limitKey={key}
                  range={range}
                  value={limits[key]}
                  onCommit={(v) => updateLimits({ [key]: v })}
                />
              ))
              : <p className="hint">Plafonds indisponibles : le moteur n’a pas répondu.</p>}
            <p className="hint">
              La hauteur du monde ({info?.limits?.worldMinY ?? -64} à{' '}
              {info?.limits?.worldMaxY ?? 319}) n’est pas réglable : c’est celle
              de Minecraft, pas une préférence.
            </p>
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

/**
 * Un plafond, saisi au clavier et validé à la sortie du champ.
 *
 * Le moteur BORNE ce qu'on lui envoie et rend la valeur retenue : on réaffiche
 * la sienne, pas celle qui a été tapée. Afficher la saisie ferait croire qu'un
 * réglage hors bornes a pris.
 */
function LimitField({ id, limitKey, range, value, onCommit }) {
  // Groupé par milliers à l'AFFICHAGE seulement : reformater à chaque frappe
  // déplacerait le curseur sous les doigts.
  const show = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('fr-FR') : '');
  const [draft, setDraft] = useState(() => show(value));
  useEffect(() => { setDraft(show(value)); }, [value]);

  const commit = async () => {
    const n = Number(draft.replace(/[\s\u202f\u00a0]/g, ''));
    if (!Number.isFinite(n) || draft.trim() === '') { setDraft(show(value)); return; }
    const applied = await onCommit(n);
    // Toujours réafficher la valeur RETENUE, même quand elle n'a pas changé :
    // saisir dix fois le plafond ne doit pas laisser le champ mentir.
    setDraft(show(applied?.[limitKey] ?? value));
  };

  return (
    <div className="field">
      <label htmlFor={id}>
        {range.label}
        <span className="field-value">{range.unit}</span>
      </label>
      <input
        id={id}
        className="input"
        value={draft}
        inputMode="numeric"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      <p className="hint" style={{ margin: '3px 0 0' }}>
        de {range.min.toLocaleString('fr-FR')} à {range.max.toLocaleString('fr-FR')}
      </p>
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
