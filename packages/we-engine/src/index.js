// @titi/we-engine — moteur WorldEdit partagé.
//
//   ./anvil     lecture/écriture .mca lossless (chunks intacts réémis tels quels)
//   ./worldedit modules purs : opérations, états de blocs, formats d'échange
//   ./storage   interface StorageAdapter + implémentation système de fichiers
//   ./staging   orchestration non destructive (snapshot/undo/audit/aperçu/export)
export * as anvil from './anvil/index.js';
export * as worldedit from './worldedit/index.js';
export * as storage from './storage/index.js';
