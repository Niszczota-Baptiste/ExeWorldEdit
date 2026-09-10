import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIO_IDS } from './scenarios.js';
import { fmtMs, fmtMb, fmtRate } from './lib/measure.js';

// Lance chaque scénario dans son propre processus, agrège, et écrit RESULTS.md.
//
//   npm run bench                 tous les scénarios
//   npm run bench -- set-10M mix  seulement ceux-là

const HERE = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ids = only.length ? SCENARIO_IDS.filter((id) => only.includes(id)) : SCENARIO_IDS;

const GROUPS = [
  { title: 'Opérations', ids: ['set-10M', 'replace', 'mix', 'mirror-rotate', 'terrain-1024', 'naturalize'] },
  { title: 'Entrées / sorties', ids: ['region-decode', 'region-write', 'export-mca', 'export-schem'] },
  { title: 'Décomposition du chargement d’une région', ids: ['phase-inflate', 'phase-nbt-parse', 'phase-nbt-simplify', 'phase-unpack-sections'] },
  { title: 'Chemin chaud de RegionStore', ids: ['store-setblock', 'store-getblock'] },
];

const results = new Map();

console.log(`Bench — ${ids.length} scénario${ids.length > 1 ? 's' : ''}, un processus chacun\n`);
for (const id of ids) {
  process.stdout.write(`  ${id.padEnd(24)}`);
  try {
    const out = execFileSync(process.execPath, ['--expose-gc', path.join(HERE, 'one.js'), id], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      // Un scénario lent ne doit pas faire échouer tout le bench sans le dire.
      timeout: 10 * 60 * 1000,
    });
    const r = JSON.parse(out.trim().split('\n').pop());
    results.set(id, r);
    console.log(r.error ? `ÉCHEC — ${r.error}` : `${fmtMs(r.ms).padStart(9)}  ${fmtMb(r.peakMb).padStart(8)}  ${fmtRate(r.n, r.ms).padStart(9)} ${r.unit}`);
  } catch (e) {
    results.set(id, { id, error: e?.message?.split('\n')[0] || String(e) });
    console.log(`ÉCHEC — ${e?.message?.split('\n')[0]}`);
  }
}

// ── RESULTS.md ──────────────────────────────────────────────────────────────

const cpu = os.cpus()[0]?.model || 'inconnu';
const totalRam = Math.round(os.totalmem() / 1024 / 1024 / 1024);

const row = (id) => {
  const r = results.get(id);
  if (!r) return null;
  if (r.error) return `| \`${id}\` | — | — | — | échec : ${r.error} |`;
  const extra = r.bytes ? `${(r.bytes / 1e6).toFixed(1)} Mo` : '';
  return `| \`${id}\` | ${fmtMs(r.ms)} | ${fmtMb(r.peakMb)} | ${fmtRate(r.n, r.ms)} ${r.unit} | ${extra} |`;
};

const decode = results.get('region-decode');
const phases = ['phase-inflate', 'phase-nbt-parse', 'phase-nbt-simplify', 'phase-unpack-sections']
  .map((id) => results.get(id)).filter((r) => r && !r.error);
const phaseTotal = phases.reduce((s, r) => s + r.ms, 0);

const lines = [
  '# Bench du moteur — mesures AVANT optimisation',
  '',
  `Généré par \`npm run bench\` le ${new Date().toISOString().slice(0, 10)}.`,
  '',
  '## Comment lire ces chiffres',
  '',
  'Chaque scénario tourne dans **son propre processus** : `maxRSS` est une marque',
  'haute cumulée, donc dans un processus partagé le pic du premier scénario',
  'deviendrait le plancher de tous les suivants.',
  '',
  '⚠️ **Ces mesures viennent d’un conteneur partagé, pas d’une machine dédiée.**',
  'Les valeurs absolues bougeront d’une exécution à l’autre — parfois beaucoup.',
  'Ce qui est exploitable ici, ce sont les **rapports entre scénarios** et la',
  'décomposition du chargement : ils tiennent quelle que soit la machine.',
  '',
  `Machine : ${cpu}, ${os.cpus().length} cœurs, ${totalRam} Go, Node ${process.versions.node}.`,
  '',
];

for (const g of GROUPS) {
  const rows = g.ids.map(row).filter(Boolean);
  if (!rows.length) continue;
  lines.push(`## ${g.title}`, '', '| Scénario | Temps | Pic mémoire | Débit | Sortie |', '|---|---|---|---|---|', ...rows, '');
}

if (decode && !decode.error && phases.length === 4) {
  lines.push(
    '## Où part le temps au chargement',
    '',
    `Décoder une région pleine (1024 chunks, ${decode.n} sections) prend **${fmtMs(decode.ms)}**.`,
    'Répartition mesurée :',
    '',
    '| Étape | Temps | Part |',
    '|---|---|---|',
    ...phases.map((r) => `| \`${r.id.replace('phase-', '')}\` | ${fmtMs(r.ms)} | ${Math.round((r.ms / phaseTotal) * 100)} % |`),
    '',
    '(La somme des étapes ne retombe pas exactement sur le total : chacune',
    'réalloue de son côté. Ce sont les **proportions** qui comptent.)',
    '',
  );
}

lines.push(
  '## Ce que ces chiffres n’incluent pas',
  '',
  '- Aucun parallélisme : tout tourne sur un seul fil. Le pool de `worker_threads`',
  '  est justement l’objet de la phase 1.2.',
  '- Le rendu. Le viewport a ses propres mesures, prises dans l’application.',
  '- Les entités : elles ne sont pas encore lues ni écrites (phase 1.3).',
  '',
);

fs.writeFileSync(path.join(HERE, 'RESULTS.md'), lines.join('\n'));
console.log(`\nÉcrit : bench/RESULTS.md`);
