// Vide `release/` avant un empaquetage, et explique clairement quand il ne peut
// pas.
//
// Sans ça, electron-builder échoue vingt lignes plus loin sur un `EBUSY:
// resource busy or locked, unlink …app.asar` — un message vrai mais muet sur la
// cause et sur le remède. Or la cause est presque toujours la même : une
// instance de l'application tourne encore, et Windows verrouille les fichiers
// ouverts (contrairement à Linux, où un fichier supprimé reste lisible par qui
// le tient déjà — d'où un piège qui ne se voit QUE sur la plateforme cible).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'release');

if (!fs.existsSync(OUT)) process.exit(0);

try {
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log('release/ vidé');
} catch (err) {
  const verrou = err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'ENOTEMPTY';
  if (!verrou) throw err;

  console.error(`
✗ Impossible de vider release/ : un fichier est verrouillé.
  (${err.code} sur ${path.relative(process.cwd(), err.path || OUT)})

  L'application tourne probablement encore — Electron lance plusieurs
  processus, et il suffit qu'un seul survive.

    Windows   taskkill /IM "Titi WorldEdit.exe" /F /T
    macOS     pkill -f "Titi WorldEdit"
    Linux     pkill -f titidesktop

  Si ça résiste, quelque chose d'autre tient le dossier. Sous Windows, un
  processus dont le RÉPERTOIRE COURANT est dedans suffit — un terminal, un
  explorateur de fichiers, un antivirus en cours d'analyse.

  Sortie de secours, qui ne touche pas au dossier verrouillé :

    cd apps/desktop
    npx electron-builder --win --publish never --config.directories.output=release2
`);
  process.exit(1);
}
