import { meshChunk } from './mesher.js';

// Guichet du worker. Toute la logique est dans `mesher.js`, qui se teste sans
// navigateur — un mailleur qu'on ne peut vérifier qu'à l'œil dans une fenêtre
// est un mailleur qu'on ne vérifie pas.

self.onmessage = (e) => {
  const { key, ids, opaque, colors, layers, shapes, origin } = e.data;
  const mesh = meshChunk(
    new Uint16Array(ids),
    new Uint8Array(opaque),
    new Uint8Array(colors),
    layers ? new Uint16Array(layers) : null,
    // Les formes sont COPIÉES et non transférées : elles servent à tous les
    // chunks, et un transfert détacherait le tampon dès le premier.
    shapes || null,
  );
  self.postMessage(
    {
      key, origin,
      positions: mesh.positions.buffer,
      colors: mesh.colors.buffer,
      uv: mesh.uv.buffer,
      layers: mesh.layers.buffer,
      indices: mesh.indices.buffer,
      quads: mesh.quads,
    },
    [mesh.positions.buffer, mesh.colors.buffer, mesh.uv.buffer, mesh.layers.buffer, mesh.indices.buffer],
  );
};
