import path from 'node:path';
import { utilityProcess } from 'electron';
import { here } from './protocol.js';

// Hôte du moteur : lance l'`utilityProcess`, tient les promesses en attente et
// relaie les événements. Le processus principal ne calcule rien lui-même.

const TIMEOUT_MS = 10 * 60 * 1000; // une grosse opération peut être longue

export function startEngine({ onEvent } = {}) {
  const entry = path.join(here(import.meta.url), '..', 'engine', 'index.js');
  const child = utilityProcess.fork(entry, [], { serviceName: 'titi-we-engine', stdio: 'inherit' });

  const pending = new Map();
  let seq = 0;
  let ready = null;
  let failReady = null;
  let started = false;
  // `whenReady` doit pouvoir ÉCHOUER. Le processus principal l'attend avant
  // d'ouvrir la fenêtre : un moteur qui meurt à l'import (un export renommé
  // suffit) laissait sinon l'application sans fenêtre, sans message et sans
  // fin — le seul indice était la trace du fils, noyée dans les avertissements
  // de Chromium.
  const whenReady = new Promise((resolve, reject) => {
    ready = (msg) => { started = true; resolve(msg); };
    failReady = reject;
  });

  child.on('message', (msg) => {
    if (msg?.event) {
      if (msg.event === 'ready') ready(msg);
      onEvent?.(msg);
      return;
    }
    const entryPending = pending.get(msg?.id);
    if (!entryPending) return;
    pending.delete(msg.id);
    clearTimeout(entryPending.timer);
    if (msg.ok) entryPending.resolve(msg.result);
    else entryPending.reject(new Error(msg.error));
  });

  child.on('exit', (code) => {
    // Mort AVANT d'avoir dit « prêt » : c'est un échec de démarrage, et
    // personne d'autre ne le saura.
    if (!started) failReady(new Error(`le moteur n'a pas démarré (code ${code})`));
    // Un moteur mort ne doit pas laisser l'interface attendre indéfiniment.
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`le moteur s'est arrêté (code ${code})`));
    }
    pending.clear();
    onEvent?.({ event: 'engine-exit', code });
  });

  function call(method, params) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`le moteur ne répond pas (${method})`));
      }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.postMessage({ id, method, params });
    });
  }

  return { call, whenReady, kill: () => child.kill() };
}
