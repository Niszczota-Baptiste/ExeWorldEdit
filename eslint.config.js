import js from '@eslint/js';
import globals from 'globals';
import security from 'eslint-plugin-security';

// Configuration volontairement courte. Le moteur manipule des chemins et des
// buffers binaires : le plugin `security` est là pour que les accès disque
// construits dynamiquement soient signalés, et que les rares endroits
// légitimes portent un commentaire expliquant pourquoi (voir les en-têtes de
// staging.js et FsAdapter.js).
export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/release/**', '**/out/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      // Le moteur indexe des tableaux typés par des entiers calculés à longueur
      // de boucle chaude : cette règle n'y produit que du bruit.
      'security/detect-object-injection': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Les tests écrivent dans des dossiers temporaires qu'ils créent eux-mêmes :
    // signaler chacun de leurs accès disque noierait les avertissements utiles.
    files: ['**/test/**/*.js', '**/bench/**/*.js'],
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },
];
