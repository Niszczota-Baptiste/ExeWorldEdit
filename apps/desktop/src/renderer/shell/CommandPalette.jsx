import { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { OPERATIONS } from '@titi/we-engine/operations';
import * as Icons from './icons.js';
import { useApp } from '../store.js';
import { TOOLS, TOOL_OPS } from '../tools.js';
import { ACTIONS, describeBinding } from '../keys.js';
import { filtre, valeurDeRecherche } from '../commands.js';

// La PALETTE DE COMMANDES — Ctrl K.
//
// Le bouton existait depuis le début dans la barre de titre, `cmdk` était
// installé, et rien ne s'ouvrait. Encore un cas de « déclaré, branché,
// inatteignable ».
//
// Ce qu'elle apporte vraiment : on y cherche par le NOM WORLDEDIT. Quelqu'un
// qui connaît WorldEdit tape « //walls », pas « Murs » — et sans ça il doit
// apprendre un second vocabulaire pour se servir d'un outil qui fait la même
// chose. Les alias vivent dans le descripteur du moteur (`we`), donc ajouter
// une opération l'ajoute ici sans rien écrire.

/** L'outil qui porte une opération — c'est lui qu'il faut choisir d'abord. */
const OUTIL_DE = new Map(
  Object.entries(TOOL_OPS).flatMap(([outil, ops]) => ops.map((op) => [op, outil])),
);

export default function CommandPalette() {
  const [ouvert, setOuvert] = useState(false);
  const [q, setQ] = useState('');
  const setTool = useApp((s) => s.setTool);
  const setOperation = useApp((s) => s.setOperation);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const open = useApp((s) => s.open);
  const openWorld = useApp((s) => s.openWorld);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);
  const resetLayout = useApp((s) => s.resetLayout);
  const keys = useApp((s) => s.keys);

  // Ctrl+K écouté ICI et non dans la table des raccourcis : la palette doit
  // s'ouvrir même quand le focus est dans un champ, et se fermer avec la même
  // combinaison. C'est le comportement attendu partout ailleurs.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOuvert((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    const onDemande = () => setOuvert(true);
    window.addEventListener('titi:palette', onDemande);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('titi:palette', onDemande);
    };
  }, []);

  const raccourci = useMemo(
    () => new Map(ACTIONS.map((a) => [a.id, describeBinding(keys[a.id])])),
    [keys],
  );

  const lancer = (fn) => { setOuvert(false); setQ(''); fn(); };

  if (!ouvert) return null;

  return (
    <div className="modal-veil" onClick={() => setOuvert(false)}>
      <Command
        className="palette"
        onClick={(e) => e.stopPropagation()}
        // La recherche porte sur `value`, où l'on a concaténé le nom français,
        // le nom WorldEdit et le groupe : « //hcyl », « cylindre » et « formes »
        // mènent tous au même endroit.
        filter={filtre}
        loop
      >
        <div className="palette-head">
          <Icons.Search size={14} />
          <Command.Input
            value={q}
            onValueChange={setQ}
            autoFocus
            placeholder="Une commande, un outil, un réglage… ou son nom WorldEdit (//walls)"
          />
          <kbd>Échap</kbd>
        </div>

        <Command.List className="palette-list-cmd">
          <Command.Empty className="hint" style={{ padding: '14px 16px' }}>
            Rien ne correspond. Les commandes WorldEdit se tapent avec leurs deux
            barres obliques : <code>//set</code>, <code>//walls</code>,{' '}
            <code>//hollow</code>.
          </Command.Empty>

          <Command.Group heading="Opérations">
            {OPERATIONS.map((o) => {
              const outil = OUTIL_DE.get(o.id);
              return (
                <Command.Item
                  key={o.id}
                  value={valeurDeRecherche(o)}
                  onSelect={() => lancer(() => {
                    // L'outil AVANT l'opération : `setTool` repositionne
                    // l'opération sur la première de l'outil, et l'ordre inverse
                    // effacerait le choix qu'on vient de faire.
                    if (outil) setTool(outil);
                    setOperation(o.id);
                  })}
                  disabled={!outil}
                >
                  <span className="palette-nom">{o.label}</span>
                  <span className="palette-groupe">{o.group}</span>
                  {o.we?.length ? <code className="palette-we">{o.we.join(' ')}</code> : null}
                </Command.Item>
              );
            })}
          </Command.Group>

          <Command.Group heading="Outils">
            {TOOLS.map((t) => (
              <Command.Item
                key={t.id}
                value={`outil ${t.label} ${t.id}`}
                onSelect={() => lancer(() => setTool(t.id))}
              >
                <span className="palette-nom">{t.label}</span>
                <span className="palette-groupe">Outil</span>
                <kbd className="palette-kbd">{raccourci.get(`tool.${t.id}`)}</kbd>
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Application">
            {[
              ['Ouvrir un fichier', 'open', open],
              ['Ouvrir une save', null, openWorld],
              ['Annuler', 'undo', undo],
              ['Rétablir', 'redo', redo],
              ['Réglages', 'settings', () => setSettingsOpen(true)],
              ['Disposition des panneaux d’origine', null, resetLayout],
            ].map(([label, action, fn]) => (
              <Command.Item key={label} value={label} onSelect={() => lancer(fn)}>
                <span className="palette-nom">{label}</span>
                <span className="palette-groupe">Application</span>
                {action && <kbd className="palette-kbd">{raccourci.get(action)}</kbd>}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
