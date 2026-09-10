// Exécute UN scénario et rend son résultat en JSON sur la sortie standard.
//
// Un processus par scénario : c'est ce qui rend `maxRSS` exploitable, puisque
// c'est une marque haute cumulée — dans un processus partagé, le pic du premier
// scénario deviendrait le plancher de tous les suivants.
import { scenarios } from './scenarios.js';

const id = process.argv[2];
const fn = scenarios[id];
if (!fn) {
  process.stderr.write(`scénario inconnu : ${id}\n`);
  process.exit(2);
}

try {
  const { ms, peakMb, heapMb, n, unit, bytes } = await fn();
  process.stdout.write(`${JSON.stringify({ id, ms, peakMb, heapMb, n, unit, bytes })}\n`);
} catch (e) {
  process.stdout.write(`${JSON.stringify({ id, error: e?.message || String(e) })}\n`);
  process.exit(1);
}
