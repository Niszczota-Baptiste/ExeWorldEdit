import { useMemo, useState } from 'react';
import { Play, Settings2, Undo2, Redo2, FileDown, Globe, AlertTriangle } from './icons.js';
import { OPERATIONS } from '@titi/we-engine/operations';
import { useApp, TOOL_OPS, TOOLS } from '../store.js';

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
  const spec = byId.get(operation);
  const [values, setValues] = useState({});
  const toolMeta = TOOLS.find((t) => t.id === tool);

  const params = useMemo(() => {
    if (!spec) return {};
    const out = {};
    for (const p of spec.params || []) {
      const v = values[`${operation}.${p.name}`] ?? p.default;
      if (p.type === 'block') out[p.name] = { name: v || block };
      else if (v !== undefined && v !== '') out[p.name] = p.type === 'int' ? Number(v) : v;
    }
    return out;
  }, [spec, values, operation, block]);

  const set = (name, v) => setValues((s) => ({ ...s, [`${operation}.${name}`]: v }));
  const get = (p) => values[`${operation}.${p.name}`] ?? p.default ?? '';

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
        {ops.length > 0 && (
          <div className="field">
            <label htmlFor="op">Opération</label>
            <select id="op" className="select" value={operation} onChange={(e) => setOperation(e.target.value)}>
              {ops.map((id) => <option key={id} value={id}>{byId.get(id)?.label || id}</option>)}
            </select>
          </div>
        )}

        {spec?.description && <p className="hint" style={{ margin: '0 0 12px' }}>{spec.description}</p>}

        {(spec?.params || []).map((p) => {
          // `showIf` cache un champ qui n'a pas de sens avec les valeurs
          // actuelles — un champ grisé qu'on ne peut jamais remplir est pire
          // qu'un champ absent.
          if (p.showIf && !Object.entries(p.showIf).every(([k, v]) => String(get({ name: k, default: byId.get(operation)?.params.find((q) => q.name === k)?.default })) === String(v))) return null;
          return <Field key={p.name} p={p} value={get(p)} onChange={(v) => set(p.name, v)} block={block} />;
        })}

        <button
          className="btn btn-wide"
          data-variant="primary"
          disabled={!!busy || !selection || !spec}
          onClick={() => run(operation, params)}
          style={{ marginTop: 4 }}
        >
          <Play size={13} />
          {busy ? 'En cours…' : `Appliquer ${spec?.label?.toLowerCase() || ''}`}
        </button>

        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" disabled={!project.undoDepth} onClick={undo}>
            <Undo2 size={13} /> Annuler
          </button>
          <button className="btn" disabled={!project.redoDepth} onClick={redo}>
            <Redo2 size={13} /> Rétablir
          </button>
        </div>

        <Export project={project} onExport={exportBuild} />
        <ApplyToWorld project={project} onApply={applyToWorld} />
        <Selection selection={selection} />
      </div>
    </section>
  );
}

/**
 * Les trois sorties, au même endroit. Le `.mca` sort le build entier ; les deux
 * schematics sortent la SÉLECTION, comme WorldEdit.
 */
function Export({ project, onExport }) {
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
      <p className="hint">
        Le <code>.mca</code> sort le build entier sans perte. Les schematics sortent la sélection ;
        WorldEdit ne colle leurs entités qu’avec <code>//paste -e</code>.
      </p>
      {project.world && (
        <p className="hint" style={{ color: 'var(--text-faint)' }}>
          Ce projet vient de <b>{project.world.path}</b>.
        </p>
      )}
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

function Field({ p, value, onChange, block }) {
  const id = `p-${p.name}`;
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

function Selection({ selection }) {
  if (!selection) return null;
  const size = {
    x: selection.max.x - selection.min.x + 1,
    y: selection.max.y - selection.min.y + 1,
    z: selection.max.z - selection.min.z + 1,
  };
  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
      <label style={{ display: 'block', marginBottom: 6, color: 'var(--text-dim)', fontSize: 'var(--t-micro)' }}>
        Sélection
      </label>
      <div style={{ display: 'grid', gap: 3, fontSize: 'var(--t-micro)', color: 'var(--text-faint)' }}>
        <Coord label="De" v={selection.min} />
        <Coord label="À" v={selection.max} />
        <div style={{ marginTop: 3, color: 'var(--select)' }}>
          {size.x} × {size.y} × {size.z} — {(size.x * size.y * size.z).toLocaleString('fr-FR')} blocs
        </div>
      </div>
    </div>
  );
}

const Coord = ({ label, v }) => (
  <div style={{ display: 'flex', gap: 8 }}>
    <span style={{ width: 16 }}>{label}</span>
    <span style={{ color: 'var(--text-dim)' }}>{v.x} · {v.y} · {v.z}</span>
  </div>
);
