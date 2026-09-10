import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Le renderer est une application web ordinaire, servie par app:// en
// production. `base: './'` est indispensable : des chemins absolus casseraient
// dès que la page n'est plus servie depuis la racine d'un domaine.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome128',
    // Le mailleur est un worker de module : Vite doit le sortir en fichier
    // séparé, pas l'inliner dans le bundle principal.
    rollupOptions: { output: { manualChunks: { three: ['three'] } } },
  },
  worker: { format: 'es' },
  server: { port: 5180, strictPort: true },
});
