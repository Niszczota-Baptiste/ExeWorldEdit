import crypto from 'node:crypto';

// Registre de jobs en mémoire pour les transformations longues : la route
// renvoie un jobId immédiatement, le client interroge la progression. Les ops
// rendent la main au boucle d'événements entre les phases (cf. staging.js) pour
// que ce polling réponde même pendant un gros calcul.

const jobs = new Map(); // id -> { status, phase, pct, result, error, createdAt }
const JOB_TTL = Number(process.env.WORLDEDIT_JOB_TTL_MS || 5 * 60 * 1000);

export function createJob() {
  const id = crypto.randomUUID();
  jobs.set(id, { status: 'running', phase: 'queued', pct: 0, result: null, error: null, createdAt: Date.now() });
  return id;
}
export function updateJob(id, patch) {
  const j = jobs.get(id);
  if (j) Object.assign(j, patch);
}
export function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { status: j.status, phase: j.phase, pct: j.pct, result: j.result, error: j.error };
}

// Purge périodique des jobs terminés/anciens.
const timer = setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.createdAt > JOB_TTL) jobs.delete(id);
}, 60_000);
timer.unref?.();
