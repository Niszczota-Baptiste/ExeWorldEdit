/* eslint-disable security/detect-non-literal-fs-filename --
   Tous les chemins sont construits sous `root` à partir d'identifiants de
   projet assainis (`safeId`) et de noms de fichiers générés (randomUUID).
   Jamais d'entrée utilisateur brute dans un chemin. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { StorageAdapter } from './StorageAdapter.js';

// Implémentation « poste local » du StorageAdapter : tout vit dans une
// arborescence de fichiers, sans base de données.
//
//   <root>/
//   ├─ projects/
//   │  └─ <id>/
//   │     ├─ project.json          métadonnées (nom, emprise, source)
//   │     ├─ source/<fichier>      le .mca / .zip importé, conservé tel quel
//   │     ├─ regions/r.X.Z.mca     copie de staging (seule chose qu'on modifie)
//   │     ├─ undo/<n>/ redo/<n>/   snapshots des régions touchées
//   │     ├─ preview.json.gz       aperçu 3D dérivé
//   │     └─ audit.jsonl           journal, une ligne JSON par opération
//   └─ library/
//      ├─ <scope>.json             index des schematics
//      └─ blobs/<uuid>.we.gz
//
// Le journal est en JSON Lines et non en JSON : une opération ajoute une ligne
// en O(1) sans relire ni réécrire le fichier entier, et un journal tronqué par
// un crash reste lisible jusqu'à sa dernière ligne complète.

/** Emplacement conventionnel des données applicatives selon la plateforme. */
export function defaultRoot(appName = 'TitiWorldEdit') {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), appName);
}

// Un id de projet finit en nom de dossier. On VALIDE au lieu d'assainir : un
// assainissement fait collisionner deux ids distincts sur le même dossier
// (`a/b` et `a b` deviendraient tous deux `a_b`), et deux projets qui partagent
// un dossier, c'est une perte de données silencieuse. Les ids viennent de notre
// propre code (randomUUID), donc un refus signale un bug, pas une saisie.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const safeId = (id) => {
  const s = String(id ?? '');
  if (!ID_RE.test(s)) throw new Error('invalid_project_id');
  return s;
};
const safeFile = (name, fallback) => {
  const base = path.basename(String(name || ''));
  const s = base.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '');
  return s.slice(0, 120) || fallback;
};
const readJson = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
// Écriture atomique : un crash entre les deux laisse l'ancien fichier intact,
// jamais un JSON tronqué qui ferait perdre le projet.
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export class FsAdapter extends StorageAdapter {
  /** @param {{root?: string, scope?: string}} [opts] */
  constructor({ root = defaultRoot(), scope = 'local' } = {}) {
    super();
    this.root = root;
    this.defaultScope = scope;
    fs.mkdirSync(this.projectsRoot, { recursive: true });
    fs.mkdirSync(this.blobsRoot, { recursive: true });
  }

  get projectsRoot() { return path.join(this.root, 'projects'); }
  get libraryRoot() { return path.join(this.root, 'library'); }
  get blobsRoot() { return path.join(this.libraryRoot, 'blobs'); }

  projectDir(id) { return path.join(this.projectsRoot, safeId(id)); }
  _metaFile(id) { return path.join(this.projectDir(id), 'project.json'); }
  _auditFile(id) { return path.join(this.projectDir(id), 'audit.jsonl'); }

  // ── Projets ───────────────────────────────────────────────────────────────

  listProjects() {
    if (!fs.existsSync(this.projectsRoot)) return [];
    return fs.readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => readJson(path.join(this.projectsRoot, e.name, 'project.json')))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  getProject(id) {
    return readJson(this._metaFile(id));
  }

  saveProject(project) {
    const id = project?.id ?? crypto.randomUUID();
    const dir = this.projectDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const record = {
      id: safeId(id),
      name: String(project?.name || 'Build').slice(0, 120),
      min: { x: 0, y: 0, z: 0, ...(project?.min || {}) },
      size: { x: 1, y: 1, z: 1, ...(project?.size || {}) },
      source: project?.source ? { file: project.source.file, name: project.source.name } : null,
      // La save d'origine, quand le projet vient d'un dossier de monde : c'est
      // elle que vise « Appliquer au monde ». Absente pour un projet ouvert
      // depuis un .mca isolé ou un schematic.
      world: project?.world ? { path: project.world.path, kind: project.world.kind } : null,
      createdAt: this.getProject(id)?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeJson(this._metaFile(id), record);
    return record;
  }

  /**
   * Importe le fichier source dans le projet et enregistre sa référence.
   * Le fichier d'origine de l'utilisateur n'est jamais lu au-delà de cet appel :
   * tout le travail se fait ensuite sur la copie de staging.
   */
  attachSource(id, { name, buffer }) {
    const project = this.getProject(id);
    if (!project) throw new Error('not_found');
    const dir = path.join(this.projectDir(id), 'source');
    fs.mkdirSync(dir, { recursive: true });
    const file = safeFile(name, 'source.mca');
    fs.writeFileSync(path.join(dir, file), buffer);
    return this.saveProject({ ...project, source: { file, name: String(name || file) } });
  }

  removeProject(id) {
    fs.rmSync(this.projectDir(id), { recursive: true, force: true });
  }

  saveExtent(id, extent) {
    const project = this.getProject(id);
    if (!project) throw new Error('not_found');
    return this.saveProject({
      ...project,
      min: { x: extent.min.x, y: extent.min.y, z: extent.min.z },
      size: {
        x: extent.max.x - extent.min.x + 1,
        y: extent.max.y - extent.min.y + 1,
        z: extent.max.z - extent.min.z + 1,
      },
    });
  }

  // ── Espace de staging ─────────────────────────────────────────────────────

  stagingDir(id) {
    const dir = path.join(this.projectDir(id), 'staging');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  readSource(project) {
    if (!project?.source?.file) throw new Error('no_source');
    return fs.readFileSync(path.join(this.projectDir(project.id), 'source', project.source.file));
  }

  // ── Journal d'audit ───────────────────────────────────────────────────────

  appendAudit(entry) {
    const file = this._auditFile(entry.projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = {
      projectId: String(entry.projectId),
      actor: entry.actor || '',
      operation: entry.operation,
      params: entry.params || {},
      blocksChanged: entry.blocksChanged || 0,
      durationMs: entry.durationMs ?? null,
      createdAt: new Date().toISOString(),
    };
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    return line;
  }

  listAudit(projectId, limit = 100) {
    const file = this._auditFile(projectId);
    if (!fs.existsSync(file)) return [];
    const cap = Math.min(500, Number(limit) || 100);
    const out = [];
    // Une ligne illisible (journal tronqué par un crash) est ignorée, pas fatale.
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!raw) continue;
      try { out.push(JSON.parse(raw)); } catch { /* ligne incomplète */ }
    }
    return out.reverse().slice(0, cap);
  }

  // ── Bibliothèque de schematics ────────────────────────────────────────────

  _indexFile(scope) {
    fs.mkdirSync(this.libraryRoot, { recursive: true });
    return path.join(this.libraryRoot, `${safeId(scope ?? this.defaultScope)}.json`);
  }

  _index(scope) { return readJson(this._indexFile(scope), []) || []; }

  listSchematics(scope) {
    return this._index(scope).map(({ file: _file, ...meta }) => meta);
  }

  getSchematicMeta(scope, id) {
    const row = this._index(scope).find((r) => String(r.id) === String(id));
    if (!row) return null;
    const { file: _file, ...meta } = row;
    return meta;
  }

  putSchematic(scope, meta, blob) {
    const file = `${crypto.randomUUID()}.we.gz`;
    fs.writeFileSync(path.join(this.blobsRoot, file), blob);
    const record = {
      id: crypto.randomUUID(),
      name: String(meta?.name || 'schematic').slice(0, 80),
      sx: meta?.sx ?? 0, sy: meta?.sy ?? 0, sz: meta?.sz ?? 0,
      blockCount: meta?.blockCount ?? 0,
      createdAt: new Date().toISOString(),
      file,
    };
    const index = this._index(scope);
    index.unshift(record);
    writeJson(this._indexFile(scope), index);
    const { file: _file, ...out } = record;
    return out;
  }

  getSchematicBlob(scope, id) {
    const row = this._index(scope).find((r) => String(r.id) === String(id));
    if (!row) throw new Error('not_found');
    return fs.readFileSync(path.join(this.blobsRoot, row.file));
  }

  deleteSchematic(scope, id) {
    const index = this._index(scope);
    const i = index.findIndex((r) => String(r.id) === String(id));
    if (i < 0) throw new Error('not_found');
    const [row] = index.splice(i, 1);
    try { fs.unlinkSync(path.join(this.blobsRoot, row.file)); } catch { /* déjà absent */ }
    writeJson(this._indexFile(scope), index);
    return true;
  }
}
