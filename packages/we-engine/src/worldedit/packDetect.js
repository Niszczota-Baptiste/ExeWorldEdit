// Choisir, parmi ce qui est installé sur la machine, les packs de ressources à
// empiler.
//
// Les textures de Minecraft appartiennent à Mojang et son EULA interdit de les
// redistribuer : une application qui les embarquerait exposerait celui qui la
// diffuse. Tous les outils du genre — WorldPainter, Amulet, Litematica — font
// donc la même chose, et c'est ce que fait celui-ci : lire les fichiers que
// l'utilisateur a DÉJÀ, dans sa propre installation. Le résultat est le même
// (« ça marche sans rien configurer »), et il est même meilleur : le dossier
// d'un launcher contient aussi les packs du serveur, donc les blocs custom
// arrivent avec.
//
// Ce module est pur : il reçoit des noms, il rend un ordre. Le parcours du
// disque appartient à l'hôte, qui seul sait où les choses vivent.

/** Une version « publique » : 1.21, 1.20.6, 1.18.2. Le reste est autre chose. */
// Découpé plutôt que reconnu par une expression : `^\d+(\.\d+)*$` a un
// quantificateur imbriqué, donc un risque de retour sur trace, et la question
// posée ici est simple — des nombres séparés par des points, pas plus de quatre.
const RELEASE = (s) => {
  const parts = String(s).split('.');
  return parts.length <= 4 && parts.every((p) => p.length > 0 && p.length < 6 && !/\D/.test(p));
};

/**
 * Compare deux noms de version. Positif si `a` est plus récente.
 *
 * Les publications passent avant tout le reste : une capture instantanée
 * (`24w14a`) ou une préversion (`1.21-pre1`) n'a rien à faire dans une palette
 * par défaut, même si son nom trie plus haut. Entre deux publications, la
 * comparaison est NUMÉRIQUE composant par composant — en texte, « 1.9 »
 * passerait après « 1.18 ».
 */
export function compareVersions(a, b) {
  const ra = RELEASE(a), rb = RELEASE(b);
  if (ra !== rb) return ra ? 1 : -1;
  if (!ra) return a < b ? -1 : a > b ? 1 : 0;
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** La plus récente publication d'une liste de noms de versions, ou `null`. */
export function pickLatestVersion(noms) {
  const propres = (noms || []).filter((n) => typeof n === 'string' && n);
  if (!propres.length) return null;
  return propres.slice().sort(compareVersions).pop();
}

/**
 * Ordonne une pile de packs, du PLUS PRIORITAIRE au moins.
 *
 * L'ordre de Minecraft : un pack de ressources recouvre le jeu. Le `.jar` de
 * version est donc la base, et les packs installés passent devant — c'est ce
 * qui fait qu'un bloc `minefield:*` prend la texture du serveur et non un trou.
 *
 * @param {{path:string, kind:'jar'|'pack', name?:string}[]} candidats
 */
export function orderPacks(candidats) {
  const packs = (candidats || []).filter((c) => c?.kind === 'pack');
  const jars = (candidats || []).filter((c) => c?.kind === 'jar');
  return [...packs, ...jars];
}

/**
 * Y a-t-il de quoi afficher des icônes ? Un pack de serveur seul ne suffit
 * pas : il ne contient que ses propres blocs, et la palette resterait vide pour
 * tout le vanilla.
 */
export const pileComplete = (candidats) => (candidats || []).some((c) => c?.kind === 'jar');
