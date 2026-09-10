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
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('-'));
const saveBaseline = args.includes('--save-baseline');
// Médiane de N exécutions. Sur une machine partagée, un scénario peut bouger de
// près de 20 % d'un tour à l'autre à code identique — mesuré, pas supposé. La
// médiane de 3 ramène ça à quelques pour cent.
const repeat = Math.max(1, Number((args.find((a) => a.startsWith('--repeat=')) || '').split('=')[1]) || 1);
const ids = only.length ? SCENARIO_IDS.filter((id) => only.includes(id)) : SCENARIO_IDS;

// La référence : les mesures d'AVANT optimisation, figées dans le dépôt.
// C'est elle qui donne son sens à la colonne « vs référence », et c'est elle
// que l'intégration continue comparera pour repérer une régression.
const BASELINE_FILE = path.join(HERE, 'baseline.json');
const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : null;

/** Facteur d'accélération face à la référence, ou null si on ne peut pas comparer. */
function speedup(id, ms) {
  const before = baseline?.results?.[id]?.ms;
  if (!before || !ms) return null;
  return before / ms;
}
/**
 * Un écart doit dépasser le BRUIT pour être annoncé. Sur cette machine, un même
 * scénario bouge de près de 20 % d'un tour à l'autre : afficher « 1,1× plus
 * rapide » donnerait du crédit à une fluctuation.
 */
const NOISE = 1.25;
const fmtSpeedup = (f) => {
  if (f == null) return '—';
  if (f >= NOISE) return `**× ${f.toFixed(1)} plus rapide**`;
  if (f <= 1 / NOISE) return `⚠️ × ${(1 / f).toFixed(1)} plus lent`;
  return 'dans le bruit';
};

const GROUPS = [
  { title: 'Opérations', ids: ['set-10M', 'replace', 'mix', 'mirror-rotate', 'terrain-1024', 'naturalize'] },
  { title: 'Entrées / sorties', ids: ['region-decode', 'region-write', 'export-mca', 'export-schem'] },
  { title: 'Décomposition du chargement d’une région', ids: ['phase-inflate', 'phase-nbt-parse', 'phase-nbt-simplify', 'phase-unpack-sections'] },
  { title: 'Chemin chaud de RegionStore', ids: ['store-setblock', 'store-getblock'] },
];

const results = new Map();

/** Médiane sur le temps — pas la moyenne, qu'un seul tour lent suffit à fausser. */
function median(runs) {
  const sorted = [...runs].sort((a, b) => a.ms - b.ms);
  const mid = sorted[Math.floor(sorted.length / 2)];
  return {
    ...mid,
    spread: runs.length > 1 ? (sorted[sorted.length - 1].ms - sorted[0].ms) / mid.ms : 0,
    runs: runs.length,
  };
}

console.log(`Bench — ${ids.length} scénario${ids.length > 1 ? 's' : ''}, un processus chacun${repeat > 1 ? `, médiane de ${repeat}` : ''}\n`);
for (const id of ids) {
  process.stdout.write(`  ${id.padEnd(24)}`);
  try {
    const runs = [];
    for (let i = 0; i < repeat; i++) {
      const out = execFileSync(process.execPath, ['--expose-gc', path.join(HERE, 'one.js'), id], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        // Un scénario lent ne doit pas faire échouer tout le bench sans le dire.
        timeout: 10 * 60 * 1000,
      });
      runs.push(JSON.parse(out.trim().split('\n').pop()));
    }
    const ok = runs.filter((r) => !r.error);
    const r = ok.length ? median(ok) : runs[0];
    results.set(id, r);
    if (r.error) {
      console.log(`ÉCHEC — ${r.error}`);
    } else {
      const f = speedup(id, r.ms);
      const vs = f == null ? '' : f >= NOISE ? `  × ${f.toFixed(1)}` : f <= 1 / NOISE ? `  ⚠ × ${(1 / f).toFixed(1)} plus lent` : '  ~';
      console.log(`${fmtMs(r.ms).padStart(9)}  ${fmtMb(r.peakMb).padStart(8)}  ${fmtRate(r.n, r.ms).padStart(9)} ${r.unit}${vs}`);
    }
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
  if (r.error) return `| \`${id}\` | — | — | — | — | échec : ${r.error} |`;
  const before = baseline?.results?.[id]?.ms;
  return `| \`${id}\` | ${before ? fmtMs(before) : '—'} | ${fmtMs(r.ms)} | ${fmtMb(r.peakMb)} | ${fmtRate(r.n, r.ms)} ${r.unit} | ${fmtSpeedup(speedup(id, r.ms))} |`;
};

const decode = results.get('region-decode');
const phases = ['phase-inflate', 'phase-nbt-parse', 'phase-nbt-simplify', 'phase-unpack-sections']
  .map((id) => results.get(id)).filter((r) => r && !r.error);
const phaseTotal = phases.reduce((s, r) => s + r.ms, 0);

const lines = [
  '# Bench du moteur',
  '',
  `Généré par \`npm run bench\` le ${new Date().toISOString().slice(0, 10)}.`,
  baseline
    ? 'Deux colonnes de temps : la référence figée, et la mesure du jour.'
    : 'Aucune référence enregistrée — une seule colonne de temps.',
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
  baseline
    ? `La colonne « Avant » vient de \`bench/baseline.json\`, mesuré le ${baseline.takenAt.slice(0, 10)} sur la même machine.`
    : 'Aucune référence enregistrée : lance `npm run bench -- --save-baseline` pour en figer une.',
  '',
];

for (const g of GROUPS) {
  const rows = g.ids.map(row).filter(Boolean);
  if (!rows.length) continue;
  lines.push(`## ${g.title}`, '', '| Scénario | Avant | Après | Pic mémoire | Débit | Gain |', '|---|---|---|---|---|---|', ...rows, '');
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
  '## Ce que la mesure a appris',
  '',
  '**L’hypothèse de départ était fausse.** J’attendais que `prismarine-nbt`',
  'domine le chargement d’une région, et j’avais annoncé qu’il faudrait sans',
  'doute le remplacer. La décomposition dit l’inverse : avant optimisation, le',
  'NBT pesait 12 %, l’inflate 3 %, et **85 % du temps partait dans',
  '`readSection`** — notre propre dépack de sections.',
  '',
  'La cause était dans `decodeBlockStates` (`src/anvil/section.js`) : la boucle',
  'allouait **un BigInt par bloc** pour extraire un index de palette. Sur une',
  'région pleine — 12 288 sections × 4096 blocs — cela fait une cinquantaine de',
  'millions d’itérations à plusieurs allocations chacune.',
  '',
  'Le format 1.16+ ne fait jamais chevaucher un index sur deux longs, et un',
  'index tient sur 12 bits au plus. Tout se lit donc en arithmétique 32 bits',
  'ordinaire. La réécriture est couverte par `test/section-unpack.test.js`, qui',
  'compare la sortie à l’implémentation BigInt d’origine sur les onze largeurs',
  'de palette : une manipulation de bits ne se relit pas, elle se compare.',
  '',
  'Remplacer `prismarine-nbt` aurait été optimiser les 12 % en laissant les',
  '85 %. Maintenant que le dépack ne coûte plus rien, le NBT est effectivement',
  'devenu le premier poste du chargement — mais c’est la mesure qui l’a établi,',
  'pas l’intuition.',
  '',
  '## Sur le seuil de régression en intégration continue',
  '',
  'Le cahier des charges demande de signaler une régression de plus de 20 %.',
  'Mesuré ici : à **code identique**, `mirror-rotate` est passé de 9,3 s à',
  '11,0 s entre deux exécutions, soit 18 % d’écart pour rien. Un seuil à 20 %',
  'sur une machine partagée déclencherait sur du bruit, et une garde qui crie au',
  'loup finit désactivée.',
  '',
  'D’où deux protections dans le lanceur : `--repeat=3` prend la **médiane**',
  '(pas la moyenne, qu’un seul tour lent suffit à fausser), et tout écart de',
  'moins de 25 % s’affiche « dans le bruit » plutôt que comme un résultat.',
  '',
  '## Ce que ces chiffres n’incluent pas',
  '',
  '- Aucun parallélisme : tout tourne sur un seul fil. Le pool de `worker_threads`',
  '  est justement l’objet de la phase 1.2.',
  '- Le rendu. Le viewport a ses propres mesures, prises dans l’application.',
  '- Les entités : elles ne sont pas encore lues ni écrites (phase 1.3).',
  '',
);

fs.writeFileSync(path.join(HERE, 'RESULTS.md'), lines.join('\n'));
console.log('\nÉcrit : bench/RESULTS.md');

if (saveBaseline) {
  const payload = { takenAt: new Date().toISOString(), machine: cpu, node: process.versions.node, results: {} };
  for (const [id, r] of results) if (!r.error) payload.results[id] = { ms: r.ms, peakMb: r.peakMb, n: r.n, unit: r.unit };
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  console.log('Écrit : bench/baseline.json (nouvelle référence)');
}
