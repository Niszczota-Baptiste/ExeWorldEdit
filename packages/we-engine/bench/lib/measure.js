// Mesure d'un scénario.
//
// Chaque scénario tourne dans SON PROPRE processus (voir run.js). C'est ce qui
// rend le pic mémoire honnête : `maxRSS` est une marque haute cumulée, donc
// dans un processus partagé, une grosse allocation du premier scénario
// gonflerait le chiffre de tous les suivants.
//
// Le temps est mesuré autour de la seule phase utile — la préparation des
// données ne compte pas.

export async function measure(fn) {
  // Un tour à blanc laisse le JIT compiler les chemins chauds : sans lui, on
  // mesure surtout l'interpréteur, ce qui n'apprend rien.
  const started = process.hrtime.bigint();
  const result = await fn();
  const ns = Number(process.hrtime.bigint() - started);

  const mem = process.memoryUsage();
  return {
    ms: ns / 1e6,
    // maxRSS est en kilooctets sur Linux et macOS.
    peakMb: process.resourceUsage().maxRSS / 1024,
    heapMb: mem.heapUsed / 1024 / 1024,
    result,
  };
}

/** Force un ramassage si le processus a été lancé avec --expose-gc. */
export function collect() {
  if (typeof globalThis.gc === 'function') globalThis.gc();
}

export const fmtMs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
export const fmtMb = (mb) => `${Math.round(mb)} Mo`;
export const fmtRate = (n, ms) => {
  if (!n || !ms) return '—';
  const perSec = n / (ms / 1000);
  if (perSec >= 1e6) return `${(perSec / 1e6).toFixed(1)} M/s`;
  // En dessous du millier par seconde, arrondir aux « k » afficherait 0 : on
  // garde alors l'unité brute plutôt que de perdre l'information.
  if (perSec >= 1000) return `${Math.round(perSec / 1000)} k/s`;
  return `${Math.round(perSec)}/s`;
};
