import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { protocol, net } from 'electron';

// Protocole `app://` — tout ce que le renderer charge vient de là : le bundle,
// les polices, les assets du codex. Aucun accès au réseau, aucun `file://`.

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

/**
 * Isolation cross-origin. Elle débloque `SharedArrayBuffer`, mais elle impose
 * aussi que TOUTE sous-ressource soit conforme, et complique le débogage.
 *
 * Le mailleur n'en a pas besoin : il reçoit un bloc paddé 18³ en ArrayBuffer
 * transféré, ce qui est déjà sans copie. On garde donc l'interrupteur à portée
 * de main, mais éteint tant que le profilage ne le réclame pas. Voir
 * `docs/desktop.md`, section architecture.
 */
export const CROSS_ORIGIN_ISOLATED = false;

/** À appeler AVANT `app.whenReady()` — sinon le scheme n'est pas privilégié. */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

/**
 * @param {Record<string, string>} roots préfixe d'URL → dossier sur disque.
 *   `app://titi/index.html` cherche `index.html` sous roots['']. Un préfixe
 *   nommé (`app://titi/assets/…`) cherche sous roots['assets'].
 */
export function serveAppProtocol(roots) {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    // Le host fait partie de l'origine : on n'en accepte qu'un.
    if (url.hostname !== 'titi') return new Response('not found', { status: 404 });

    const segments = url.pathname.replace(/^\/+/, '').split('/');
    const prefix = roots[segments[0]] ? segments.shift() : '';
    const root = roots[prefix];
    if (!root) return new Response('not found', { status: 404 });

    // Résolution puis vérification que le résultat est bien SOUS la racine :
    // un `..` encodé ne doit pas pouvoir sortir du dossier servi.
    const rel = segments.join('/') || 'index.html';
    const target = path.resolve(root, rel);
    const rootResolved = path.resolve(root);
    if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }

    try {
      await fs.access(target);
    } catch {
      // Application à page unique : une route inconnue rend l'index.
      if (prefix === '') return serveFile(path.join(rootResolved, 'index.html'));
      return new Response('not found', { status: 404 });
    }
    return serveFile(target);
  });
}

async function serveFile(target) {
  const res = await net.fetch(pathToFileURL(target).toString());
  const headers = new Headers(res.headers);
  headers.set('Content-Type', MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
  if (CROSS_ORIGIN_ISOLATED) {
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  }
  return new Response(res.body, { status: res.status, headers });
}

export const here = (metaUrl) => path.dirname(fileURLToPath(metaUrl));
