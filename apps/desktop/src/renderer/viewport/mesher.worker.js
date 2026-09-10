import { meshChunk } from './mesher.js';

// Guichet du worker. Toute la logique est dans `mesher.js`, qui se teste sans
// navigateur — un mailleur qu'on ne peut vérifier qu'à l'œil dans une fenêtre
// est un mailleur qu'on ne vérifie pas.

self.onmessage = (e) => {
  const { key, ids, opaque, colors, origin } = e.data;
  const mesh = meshChunk(new Uint16Array(ids), new Uint8Array(opaque), new Uint8Array(colors));
  self.postMessage(
    {
      key, origin,
      positions: mesh.positions.buffer,
      colors: mesh.colors.buffer,
      indices: mesh.indices.buffer,
      quads: mesh.quads,
    },
    [mesh.positions.buffer, mesh.colors.buffer, mesh.indices.buffer],
  );
};
