import { Fragment, useEffect, useMemo, useState } from 'react';
import { Play, Settings2, Undo2, Redo2, FileDown, Globe, AlertTriangle, Plus, Minus } from './icons.js';
import { OPERATIONS } from '@titi/we-engine/operations';
import { useApp } from '../store.js';
import { TOOL_OPS, TOOLS, TOOL_NOTES } from '../tools.js';
import PanelTool from './tools/PanelTool.jsx';
import HeightmapTool from './tools/HeightmapTool.jsx';
import LibraryTool from './tools/LibraryTool.jsx';
import BrushTool from './tools/BrushTool.jsx';
import { ActionSlot } from './actionSlot.js';

/**
 * Outils qui ont leur PROPRE écran au lieu d'un formulaire généré.
 *
 * Ce ne sont pas des opérations du descripteur : ce qu'ils envoient au moteur
 * n'est pas une poignée de paramètres mais une grille entière — un masque, des
 * noms de blocs, des hauteurs — que seule l'interface peut fabriquer.
 */
const TOOL_PANELS = {
  brush: BrushTool,
  panel: PanelTool,
  heightmap: HeightmapTool,
  library: LibraryTool,
};


// Inspecteur contextuel : les réglages de l'outil courant.
//
// Les champs sont GÉNÉRÉS depuis le descripteur d'opérations du moteur, comme
// le panneau du site. Ajouter un paramètre au moteur le fait apparaître ici
// sans toucher au renderer — et surtout, l'interface ne peut pas proposer une
// option que le moteur ne connaît pas.

const byId = new Map(OPERATIONS.map((o) => [o.id, o]));

export default function Inspector() {
  const tool = useApp((s) => s.tool);
  const operation = useApp((s) => s.operation);
  const setOperation = useApp((s) => s.setOperation);
  const block = useApp((s) => s.block);
  const selection = useApp((s) => s.selection);
  const busy = useApp((s) => s.busy);
  const project = useApp((s) => s.project());
  const run = useApp((s) => s.run);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);
  const exportBuild = useApp((s) => s.exportBuild);
  const applyToWorld = useApp((s) => s.applyToWorld);

  const ops = TOOL_OPS[tool] || [];
  // L'opération courante doit appartenir à l'outil courant. Sinon la liste
  // affiche son premier élément pendant que les champs, la description et le
  // bouton décrivent une AUTRE opération — et c'est celle-là qui part au
  // moteur. Retomber sur le premier élément est le seul état cohérent.
  const active = ops.length && !ops.includes(operation) ? ops[0] : operation;
  const Panneau = TOOL_PANELS[tool];
  const [actionsEl, setActionsEl] = useState(null);
  const spec = byId.get(active);
  const [values, setValues] = useState({});
  const toolMeta = TOOLS.find((t) => t.id === tool);

  const params = useMemo(() => {
    if (!spec) return {};
    const out = {};
    for (const p of spec.params || []) {
      const v = values[`${active}.${p.name}`] ?? p.default;
      switch (p.type) {
        case 'block': out[p.name] = { name: v || block }; break;
        // Les trois types COMPOSITES. Ils étaient déclarés par le moteur et
        // n'avaient aucun champ ici : le `Field` par défaut rendait une simple
        // case de texte, dont la chaîne partait telle quelle vers une opération
        // qui attend un tableau. « Remplacer » et « Mélange » — deux des
        // commandes les plus utilisées — ne pouvaient pas fonctionner.
        case 'blocklist':
          out[p.name] = (v?.length ? v : [block]).filter(Boolean).map((name) => ({ name }));
          break;
        case 'pattern':
          out[p.name] = (v?.length ? v : [{ name: block, weight: 100 }])
            .filter((e) => e?.name)
            .map((e) => ({ name: e.name, weight: Number(e.weight) || 1 }));
          break;
        case 'mask': out[p.name] = v || { type: 'all' }; break;
        default:
          if (v !== undefined && v !== '') out[p.name] = p.type === 'int' ? Number(v) : v;
      }
    }
    return out;
  }, [spec, values, active, block]);

  const set = (name, v) => setValues((s) => ({ ...s, [`${active}.${name}`]: v }));
  const get = (p) => values[`${active}.${p.name}`] ?? p.default ?? '';

  if (!project) {
    return (
      <section className="side-panel" style={{ flex: 1 }}>
        <Head icon={<Settings2 size={13} />} title="Inspecteur" />
        <div className="panel-body">
          <p className="hint">Ouvre un build pour accéder aux outils.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="side-panel" style={{ flex: 1 }}>
      <Head icon={<Settings2 size={13} />} title={toolMeta?.label || 'Inspecteur'} />
      <div className="panel-body">
        {/* La sélection d'abord : c'est SUR QUOI on opère, donc ça précède le
            choix de l'opération. Reléguée en bas, elle passait sous la ligne de
            flottaison du panneau et devenait introuvable. */}
        <Selection selection={selection} />

        {/* Outil sans opérations : son écran s'il en a un, sinon ce qu'il fait
            et ce qui manque. Jamais le formulaire de l'opération d'avant. */}
        {ops.length === 0 && (Panneau
          ? <ActionSlot.Provider value={actionsEl}><Panneau /></ActionSlot.Provider>
          : (
            <p className="hint" style={{ margin: '0 0 12px' }}>
              {TOOL_NOTES[tool]?.soon && <b style={{ color: 'var(--select)' }}>À venir. </b>}
              {TOOL_NOTES[tool]?.text || 'Cet outil n’a pas de réglages.'}
            </p>
          ))}

        {ops.length > 0 && (
          <div className="field">
            <label htmlFor="op">Opération</label>
            <select id="op" className="select" value={active} onChange={(e) => setOperation(e.target.value)}>
              {ops.map((id) => <option key={id} value={id}>{byId.get(id)?.label || id}</option>)}
            </select>
          </div>
        )}

        {ops.length > 0 && spec?.description && <p className="hint" style={{ margin: '0 0 12px' }}>{spec.description}</p>}

        {ops.length > 0 && (spec?.params || []).map((p) => {
          // `showIf` cache un champ qui n'a pas de sens avec les valeurs
          // actuelles — un champ grisé qu'on ne peut jamais remplir est pire
          // qu'un champ absent.
          if (p.showIf && !Object.entries(p.showIf).every(([k, v]) => String(get({ name: k, default: spec.params.find((q) => q.name === k)?.default })) === String(v))) return null;
          return <Field key={p.name} p={p} value={get(p)} onChange={(v) => set(p.name, v)} block={block} />;
        })}

        <Export onExport={exportBuild} />
        <ApplyToWorld project={project} onApply={applyToWorld} />

        {/* Épinglé en bas du panneau : avec « Mélange » et ses lignes de blocs,
            le bouton principal passait sous la ligne de flottaison et il
            fallait défiler pour le trouver. */}
        <div className="panel-actions">
          {/* Le bouton des écrans d'outils arrive ICI par portail, donc AVANT
              annuler/rétablir. */}
          <div ref={setActionsEl} />
          {ops.length > 0 && (
            <button
              className="btn btn-wide"
              data-variant="primary"
              disabled={!!busy || !selection || !spec}
              onClick={() => run(active, params)}
            >
              <Play size={13} />
              {busy ? 'En cours…' : `Appliquer ${spec?.label?.toLowerCase() || ''}`}
            </button>
          )}
          <div className="row" style={{ marginTop: ops.length > 0 ? 8 : 0 }}>
            <button className="btn" disabled={!project.undoDepth} onClick={undo}>
              <Undo2 size={13} /> Annuler
            </button>
            <button className="btn" disabled={!project.redoDepth} onClick={redo}>
              <Redo2 size={13} /> Rétablir
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Les trois sorties, au même endroit. Le `.mca` sort le build entier ; les deux
 * schematics sortent la SÉLECTION, comme WorldEdit.
 */
function Export({ onExport }) {
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
      <label style={{ display: 'block', marginBottom: 6, color: 'var(--text-dim)', fontSize: 'var(--t-micro)' }}>
        Exporter
      </label>
      <div className="row">
        <button className="btn" onClick={() => onExport('mca')} title="Le build entier, sans perte">
          <FileDown size={13} /> .mca
        </button>
        <button className="btn" onClick={() => onExport('schem')} title="La sélection, format Sponge">
          .schem
        </button>
        <button className="btn" onClick={() => onExport('litematic')} title="La sélection, format Litematica">
          .litematic
        </button>
      </div>
      {/* Le détail est dans les infobulles des boutons. Trois lignes de prose
          ici poussaient les réglages de l'opération hors de l'écran, et c'est
          la seule chose qu'on regarde vraiment souvent.
          La phrase sur le nom, elle, évite une vraie surprise : on renomme
          l'onglet et le .mca sort quand même en r.X.Z.mca. */}
      <p className="hint" title="WorldEdit ne colle les entités d’un schematic qu’avec //paste -e">
        <code>.mca</code> : le build entier, sans perte — une région seule garde son nom
        <code> r.X.Z.mca</code>, c’est ce qui la rend relisible par le jeu.
        Les schematics sortent la sélection, nommée comme l’onglet.
      </p>
    </div>
  );
}

/**
 * La seule action irréversible de l'application. Elle est volontairement à
 * part, en bas, avec sa couleur d'avertissement — et elle n'apparaît que si le
 * projet vient réellement d'un dossier de monde.
 */
function ApplyToWorld({ project, onApply }) {
  if (!project.world) return null;
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
      <button className="btn btn-wide" data-variant="danger" onClick={onApply}>
        <Globe size={13} /> Appliquer au monde
      </button>
      <p className="hint" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <AlertTriangle size={13} style={{ flex: 'none', marginTop: 1, color: 'var(--select)' }} />
        <span>
          Réécrit les régions dans <b>{project.world.path}</b>. Une sauvegarde zip horodatée est prise
          avant toute écriture, et le monde est refusé s’il est ouvert dans Minecraft.
        </span>
      </p>
    </div>
  );
}

function Head({ icon, title, extra }) {
  return (
    <div className="panel-head">
      {icon}
      <span>{title}</span>
      <span className="spacer" />
      {extra}
    </div>
  );
}

/** Masques proposés par le moteur (`MASK_TYPES`, operations.js). */
const MASKS = [
  ['all', 'Tout'],
  ['air', 'Air seulement'],
  ['solid', 'Blocs pleins seulement'],
  ['exposed', 'Exposé à l’air'],
  ['on_surface', 'Surface de chaque colonne'],
  ['above', 'Au-dessus de Y…'],
  ['below', 'En-dessous de Y…'],
];

/** Liste de blocs (« Remplacer » : plusieurs sources pour une cible). */
function BlockList({ p, value, onChange, block }) {
  const rows = value?.length ? value : [block];
  const set = (i, v) => onChange(rows.map((r, k) => (k === i ? v : r)));
  return (
    <div className="field">
      <label>{p.label}</label>
      {rows.map((r, i) => (
        <div className="row" key={i} style={{ marginBottom: 4 }}>
          <input className="input" value={r} onChange={(e) => set(i, e.target.value)} aria-label={`${p.label} ${i + 1}`} />
          <button className="btn btn-icon" disabled={rows.length < 2} onClick={() => onChange(rows.filter((_, k) => k !== i))} title="Retirer">
            <Minus size={13} />
          </button>
        </div>
      ))}
      <button className="btn" onClick={() => onChange([...rows, block])}>
        <Plus size={13} /> Ajouter un bloc
      </button>
    </div>
  );
}

/** Mélange pondéré : des blocs et leurs parts. */
function Pattern({ p, value, onChange, block }) {
  const rows = value?.length ? value : [{ name: block, weight: 100 }];
  const total = rows.reduce((s, r) => s + (Number(r.weight) || 0), 0);
  const set = (i, patch) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="field">
      <label>{p.label}</label>
      {rows.map((r, i) => (
        <div className="row" key={i} style={{ marginBottom: 4 }}>
          <input className="input" value={r.name} onChange={(e) => set(i, { name: e.target.value })} aria-label={`Bloc ${i + 1}`} />
          <input
            className="input" type="number" min="1" style={{ width: 62, flex: 'none' }}
            value={r.weight} onChange={(e) => set(i, { weight: e.target.value })} aria-label={`Part du bloc ${i + 1}`}
          />
          <button className="btn btn-icon" disabled={rows.length < 2} onClick={() => onChange(rows.filter((_, k) => k !== i))} title="Retirer">
            <Minus size={13} />
          </button>
        </div>
      ))}
      <div className="row">
        <button className="btn" onClick={() => onChange([...rows, { name: block, weight: 50 }])}>
          <Plus size={13} /> Ajouter
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        {/* Les parts sont RELATIVES : le moteur normalise sur leur somme. Le
            dire évite de croire qu'il faut tomber juste à 100. */}
        <span className="hint" style={{ margin: 0 }}>
          {rows.map((r) => `${Math.round(((Number(r.weight) || 0) / (total || 1)) * 100)} %`).join(' · ')}
        </span>
      </div>
    </div>
  );
}

function Mask({ p, value, onChange }) {
  const m = value || { type: 'all' };
  const seuil = m.type === 'above' || m.type === 'below';
  return (
    <div className="field">
      <label htmlFor={`p-${p.name}`}>{p.label}</label>
      <div className="row">
        <select
          id={`p-${p.name}`} className="select" value={m.type}
          onChange={(e) => onChange({ ...m, type: e.target.value })}
        >
          {MASKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {seuil && (
          <input
            className="input" type="number" style={{ width: 74, flex: 'none' }}
            value={m.y ?? 0} onChange={(e) => onChange({ ...m, y: Math.round(Number(e.target.value)) || 0 })}
            aria-label="Hauteur Y du masque"
          />
        )}
      </div>
    </div>
  );
}

function Field({ p, value, onChange, block }) {
  const id = `p-${p.name}`;
  if (p.type === 'blocklist') return <BlockList p={p} value={value} onChange={onChange} block={block} />;
  if (p.type === 'pattern') return <Pattern p={p} value={value} onChange={onChange} block={block} />;
  if (p.type === 'mask') return <Mask p={p} value={value} onChange={onChange} />;
  if (p.type === 'enum' || p.type === 'biome') {
    return (
      <div className="field">
        <label htmlFor={id}>{p.label}</label>
        <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          {(p.values || []).map((v) => <option key={v} value={v}>{p.labels?.[v] ?? v}</option>)}
        </select>
      </div>
    );
  }
  if (p.type === 'bool') {
    return (
      <div className="field">
        <label htmlFor={id} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {p.label}
        </label>
      </div>
    );
  }
  if (p.type === 'block') {
    // Le bloc courant vient de la palette : ce champ le montre plutôt que de
    // demander de retaper un identifiant.
    return (
      <div className="field">
        <label htmlFor={id}>{p.label}</label>
        <input id={id} className="input" value={value || block} onChange={(e) => onChange(e.target.value)} />
        <p className="hint">Choisi dans la palette, ou saisi ici. <kbd>Alt</kbd> + clic dans la vue pour pipetter.</p>
      </div>
    );
  }
  return (
    <div className="field">
      <label htmlFor={id}>{p.label}</label>
      <input
        id={id}
        className="input"
        type={p.type === 'int' ? 'number' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * Sélection ÉDITABLE.
 *
 * Il n'y a pas encore de sélection à la souris (phase 2.5) : sans champs, la
 * sélection restait bloquée sur l'emprise du build et l'application était
 * inutilisable pour éditer une zone précise. Six nombres suffisent — ce sont
 * ceux que Minecraft affiche sur F3.
 *
 * La saisie est validée à la sortie du champ, pas à la frappe : taper « -12 »
 * passe par « - », qui n'est pas un nombre.
 */
function Selection({ selection }) {
  const setSelection = useApp((s) => s.setSelection);
  const project = useApp((s) => s.project());

  if (!selection) return null;

  const size = {
    x: selection.max.x - selection.min.x + 1,
    y: selection.max.y - selection.min.y + 1,
    z: selection.max.z - selection.min.z + 1,
  };

  const commit = (coin, axe, brut) => {
    const n = Math.round(Number(brut));
    if (!Number.isFinite(n)) return;
    const next = {
      min: { ...selection.min },
      max: { ...selection.max },
      shape: selection.shape,
    };
    next[coin][axe] = n;
    // Coins inversés : on remet dans l'ordre plutôt que de refuser. Saisir
    // « de 100 à 20 » veut manifestement dire « de 20 à 100 ».
    for (const a of ['x', 'y', 'z']) {
      if (next.min[a] > next.max[a]) {
        const t = next.min[a]; next.min[a] = next.max[a]; next.max[a] = t;
      }
    }
    setSelection(next);
  };

  const tout = () => {
    if (!project?.extent) return;
    setSelection({ min: { ...project.extent.min }, max: { ...project.extent.max }, shape: selection.shape });
  };

  const trop = project?.limits && (
    selection.min.x < project.limits.min.x || selection.max.x > project.limits.max.x
    || selection.min.y < project.limits.min.y || selection.max.y > project.limits.max.y
    || selection.min.z < project.limits.min.z || selection.max.z > project.limits.max.z
  );

  return (
    <div className="sel">
      <label>
        Sélection
        <button className="sel-all" onClick={tout} title="Prendre tout le build">tout le build</button>
      </label>

      <div className="sel-grid">
        <span />
        <span className="sel-axis">X</span>
        <span className="sel-axis">Y</span>
        <span className="sel-axis">Z</span>
        {['min', 'max'].map((coin) => (
          <Fragment key={coin}>
            <span className="sel-row">{coin === 'min' ? 'De' : 'À'}</span>
            {['x', 'y', 'z'].map((axe) => (
              <SelField key={axe} value={selection[coin][axe]} onCommit={(v) => commit(coin, axe, v)} />
            ))}
          </Fragment>
        ))}
      </div>

      <div className="sel-size">
        {size.x} × {size.y} × {size.z} — {(size.x * size.y * size.z).toLocaleString('fr-FR')} blocs
      </div>
      {trop && <div className="sel-warn">Hors des limites du build : l’opération sera refusée.</div>}
    </div>
  );
}

/** Un nombre de la sélection. Réaffiche la valeur retenue, pas la saisie. */
function SelField({ value, onCommit }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    if (draft.trim() === '' || !Number.isFinite(Number(draft))) { setDraft(String(value)); return; }
    onCommit(draft);
  };
  return (
    <input
      className="input sel-input"
      value={draft}
      inputMode="numeric"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}
