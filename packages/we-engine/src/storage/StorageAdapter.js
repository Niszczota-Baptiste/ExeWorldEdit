// StorageAdapter — la seule frontière entre le moteur et son hôte.
//
// Le moteur ne sait pas s'il tourne dans un serveur Express avec SQLite ou dans
// un processus Electron qui écrit sous %APPDATA%. Tout ce qui diffère entre les
// deux passe par ici : où vivent les projets, comment on lit leurs métadonnées,
// où s'écrit le journal, où se range la bibliothèque de schematics.
//
// Ce qui ne passe PAS par ici, volontairement : la mécanique des snapshots undo,
// des fichiers de région et de l'aperçu. Les deux hôtes ont un vrai système de
// fichiers, et cette mécanique est du code testé qu'on ne gagne rien à
// réimplémenter deux fois. L'adapter se contente de NOMMER un dossier
// (`stagingDir`) que le moteur possède ensuite entièrement.
//
// ── Formes échangées ────────────────────────────────────────────────────────
//
// Project — un build ouvert :
//   {
//     id:     string|number,
//     name:   string,
//     min:    { x, y, z },          coin bas de l'emprise du CONTENU
//     size:   { x, y, z },          dimensions inclusives de cette emprise
//     source: { file, name }|null,  le .mca / .zip d'origine, tel qu'importé
//     world:  { path, kind }|null,  la save d'où vient le projet, s'il vient
//                                   d'un dossier de monde — la cible de
//                                   « Appliquer au monde »
//   }
//
//   `min`/`size` suivent le contenu réel, pas les limites d'édition : on peut
//   construire au-dessus (cf. buildLimits), et l'emprise grandit alors via
//   `saveExtent`.
//
// AuditEntry — une ligne de journal :
//   {
//     projectId, actor, operation,
//     params:        objet libre (sélection, paramètres de l'opération),
//     blocksChanged: number,
//     durationMs:    number,
//     timings:       { totalMs, phases: [{phase, ms}] }|null,
//     createdAt:     string ISO      (posé par l'adapter à l'écriture)
//   }
//
//   `timings` est le relevé par phase de l'opération. Il est CONSIGNÉ et pas
//   seulement affiché : une opération lente s'analyse le plus souvent après
//   coup, quand la barre de progression a disparu.
//
// SchematicMeta — une entrée de bibliothèque :
//   { id, name, sx, sy, sz, blockCount, createdAt }
//
//   L'adapter stocke un BLOB opaque : c'est `library.js` qui sait le sérialiser.
//   L'adapter n'a jamais à connaître le format d'un schematic.

const notImplemented = (method) => {
  throw new Error(`StorageAdapter.${method} n'est pas implémenté par cet adapter`);
};

export class StorageAdapter {
  // ── Projets ───────────────────────────────────────────────────────────────

  /** @returns {Project[]} */
  listProjects() { return notImplemented('listProjects'); }

  /** @returns {Project|null} */
  // eslint-disable-next-line no-unused-vars
  getProject(id) { return notImplemented('getProject'); }

  /** Crée ou remplace un projet. @returns {Project} tel que persisté (id posé). */
  // eslint-disable-next-line no-unused-vars
  saveProject(project) { return notImplemented('saveProject'); }

  /** Supprime le projet ET son espace de staging. */
  // eslint-disable-next-line no-unused-vars
  removeProject(id) { return notImplemented('removeProject'); }

  /**
   * Enregistre la nouvelle emprise du contenu après une opération qui a écrit
   * au-delà (construire au-dessus du build, stack qui déborde…).
   * @param {{min:{x,y,z},max:{x,y,z}}} extent boîte INCLUSIVE
   */
  // eslint-disable-next-line no-unused-vars
  saveExtent(id, extent) { return notImplemented('saveExtent'); }

  // ── Espace de staging ─────────────────────────────────────────────────────

  /**
   * Dossier de travail du projet, possédé par le moteur, qui y range
   * `regions/`, `undo/`, `redo/` et `preview.json.gz`. Doit exister au retour.
   * @returns {string} chemin absolu
   */
  // eslint-disable-next-line no-unused-vars
  stagingDir(id) { return notImplemented('stagingDir'); }

  /**
   * Contenu du fichier importé d'origine (.mca ou .zip d'un dossier region/).
   * Lu une seule fois, à la matérialisation du staging.
   * @returns {Buffer}
   */
  // eslint-disable-next-line no-unused-vars
  readSource(project) { return notImplemented('readSource'); }

  // ── Journal d'audit ───────────────────────────────────────────────────────

  // eslint-disable-next-line no-unused-vars
  appendAudit(entry) { return notImplemented('appendAudit'); }

  /** Plus récentes d'abord. @returns {AuditEntry[]} */
  // eslint-disable-next-line no-unused-vars
  listAudit(projectId, limit) { return notImplemented('listAudit'); }

  // ── Réglages ──────────────────────────────────────────────────────────────
  //
  // Un objet libre, propre à l'application : apparence, mode performance,
  // plafonds du moteur. Il passe par l'adapter plutôt que par le stockage du
  // navigateur, pour deux raisons — le renderer n'a pas accès au disque, et les
  // plafonds servent AU MOTEUR, qui ne lit pas un `localStorage`.

  /** @returns {object} les réglages enregistrés, `{}` si aucun. */
  readSettings() { return notImplemented('readSettings'); }

  /** Fusionne un correctif dans les réglages. @returns {object} le résultat. */
  // eslint-disable-next-line no-unused-vars
  writeSettings(patch) { return notImplemented('writeSettings'); }

  /**
   * Blocs SUPPLÉMENTAIRES déclarés par l'installation — typiquement les
   * `minefield:*` du serveur, que ce dépôt ne peut pas connaître. Rendus tels
   * quels : c'est `normalizeExtras` (worldedit/blockCatalog.js) qui valide.
   *
   * Passe par l'adapter et non par un `import` : la liste dépend de l'endroit
   * où vivent les données, et le renderer n'a pas accès au disque.
   *
   * @returns {object|Array} contenu brut, `[]` si rien n'est déclaré.
   */
  readBlockExtras() { return notImplemented('readBlockExtras'); }

  // ── Bibliothèque de schematics ────────────────────────────────────────────
  //
  // `scope` isole les bibliothèques les unes des autres : un workspace côté
  // site, une constante côté desktop (un seul utilisateur, une seule
  // bibliothèque).

  /** @returns {SchematicMeta[]} plus récentes d'abord */
  // eslint-disable-next-line no-unused-vars
  listSchematics(scope) { return notImplemented('listSchematics'); }

  /** @returns {SchematicMeta|null} */
  // eslint-disable-next-line no-unused-vars
  getSchematicMeta(scope, id) { return notImplemented('getSchematicMeta'); }

  /** @returns {SchematicMeta} avec son id */
  // eslint-disable-next-line no-unused-vars
  putSchematic(scope, meta, blob) { return notImplemented('putSchematic'); }

  /** @returns {Buffer} @throws {Error} `not_found` */
  // eslint-disable-next-line no-unused-vars
  getSchematicBlob(scope, id) { return notImplemented('getSchematicBlob'); }

  /** @throws {Error} `not_found` */
  // eslint-disable-next-line no-unused-vars
  deleteSchematic(scope, id) { return notImplemented('deleteSchematic'); }
}
