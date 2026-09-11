import { useEffect, useRef, useState } from 'react';
import { voxelFromHit, brushPositions, lineBetween, Stroke } from './brush.js';
import { buildAtlas, makeAtlasMaterial } from './atlas.js';
import { facesDesCubes, tableDesFormes, sourcesDesModeles } from './models.js';
import * as THREE from 'three';
import { sparseToChunks, paddedChunk, createMeshPool, CH } from './voxels.js';
import { buildTables } from './blockColors.js';

// Le viewport. Un maillage PAR CHUNK, construit en worker — pas un
// `InstancedMesh` par type de bloc : au-delà de quelques centaines de milliers
// de blocs, la seconde approche s'effondre sous le nombre d'instances alors que
// la première ne coûte qu'un appel de dessin par chunk.
//
// L'éclairage est CUIT dans les couleurs de sommet (ombrage par direction de
// face × occlusion ambiante), donc un matériau sans lumière suffit. C'est aussi
// ce qui donne le rendu Minecraft plutôt qu'un rendu de CAO.

const SKY_TOP = 0x2A3A48;
const SKY_BOTTOM = 0x171E25;

export default function Viewport({ geometry, layerY, onStats, onHover, brush, onStroke }) {
  const hostRef = useRef(null);
  const stateRef = useRef(null);
  const [ready, setReady] = useState(false);

  // ── Scène, caméra, boucle de rendu : montées une fois ────────────────────
  useEffect(() => {
    const host = hostRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = makeSky();
    scene.fog = new THREE.Fog(SKY_BOTTOM, 260, 900);

    const camera = new THREE.PerspectiveCamera(55, host.clientWidth / host.clientHeight, 0.1, 4000);
    camera.position.set(70, 60, 90);

    const world = new THREE.Group();
    scene.add(world);

    const grid = new THREE.GridHelper(512, 32, 0x3A424D, 0x2A313A);
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    scene.add(grid);

    const target = new THREE.Vector3();
    const controls = makeOrbit(renderer.domElement, camera, target);

    const state = { renderer, scene, camera, world, grid, controls, target, meshes: new Map(), pool: null, frames: 0, fps: 0 };
    stateRef.current = state;

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    let raf = 0;
    let lastFps = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
      state.frames++;
      const now = performance.now();
      if (now - lastFps >= 500) {
        state.fps = Math.round((state.frames * 1000) / (now - lastFps));
        state.frames = 0;
        lastFps = now;
        onStats?.({ fps: state.fps, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
      }
    };
    loop();
    setReady(true);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      state.pool?.dispose();
      state.material?.dispose();
      state.atlasTexture?.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  // ── Pinceau : viser, peindre, envoyer ────────────────────────────────────
  //
  // Le trait est accumulé ICI et envoyé d'un bloc au relâchement. Un appel au
  // moteur par déplacement de souris ferait un aller-retour par pixel et une
  // entrée d'annulation par pixel — le pinceau serait inutilisable et
  // l'annulation aussi.
  useEffect(() => {
    const state = stateRef.current;
    if (!ready || !state) return undefined;
    const dom = state.renderer.domElement;
    const actif = !!brush;
    state.controls.setActive(!actif);

    // Le curseur : une boîte filaire posée sur la case visée. Sans repère
    // visuel, on vise à l'aveugle — la face touchée n'est pas celle qu'on croit
    // dès que la caméra est de biais.
    if (!state.curseur) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0xF2C14E, depthTest: false, transparent: true, opacity: 0.9 }),
      );
      edges.renderOrder = 999;
      edges.visible = false;
      state.scene.add(edges);
      state.curseur = edges;
      geo.dispose();
    }
    state.curseur.visible = false;
    if (!actif) return () => { if (state.curseur) state.curseur.visible = false; };

    const ndc = new THREE.Vector2();
    const versNdc = (e) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      return ndc;
    };

    let trait = null;
    // Dernier centre posé : un trait relie les brosses successives, sans quoi
    // un mouvement rapide laisse des taches au lieu d'une trace.
    let dernier = null;
    const caseVisee = (e) => {
      const hit = pick(state, versNdc(e));
      return hit ? voxelFromHit(hit.point, hit.normal, brush.mode) : null;
    };
    const poser = (v) => {
      if (!v) return;
      const d = Math.max(1, 2 * brush.radius + 1);
      state.curseur.scale.set(d, brush.shape === 'disc' ? 1 : d, d);
      state.curseur.position.set(v.x + 0.5, v.y + 0.5, v.z + 0.5);
      state.curseur.visible = true;
    };

    const etaler = (v) => {
      for (const c of (dernier ? lineBetween(dernier, v) : [v])) {
        trait.add(brushPositions(c, { shape: brush.shape, radius: brush.radius, limits: brush.limits }));
      }
      dernier = v;
    };
    const onMove = (e) => {
      const v = caseVisee(e);
      poser(v);
      if (trait && v) etaler(v);
    };
    const onDown = (e) => {
      if (e.button !== 0) return;
      const v = caseVisee(e);
      if (!v) return;
      e.preventDefault();
      dom.setPointerCapture(e.pointerId);
      trait = new Stroke();
      dernier = null;
      etaler(v);
    };
    const onUp = (e) => {
      dom.releasePointerCapture?.(e.pointerId);
      if (!trait) return;
      const positions = trait.positions();
      trait = null;
      if (positions.length) onStroke?.(positions);
    };
    const onLeave = () => { state.curseur.visible = false; };

    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointerleave', onLeave);
    return () => {
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointerleave', onLeave);
      state.controls.setActive(true);
      if (state.curseur) state.curseur.visible = false;
    };
  }, [ready, brush, onStroke]);

  // ── (Re)maillage quand la géométrie change ───────────────────────────────
  useEffect(() => {
    const state = stateRef.current;
    if (!ready || !state || !geometry?.blocks?.length) return;
    let cancelled = false;

    for (const mesh of state.meshes.values()) disposeMesh(state.world, mesh);
    state.meshes.clear();

    const chunks = sparseToChunks(geometry);
    const { colors, opaque } = buildTables(geometry.palette);
    state.pool ??= createMeshPool();

    (async () => {
      const t0 = performance.now();
      let quads = 0;

      // L'ATLAS d'abord : les couches doivent partir AVEC le maillage, pas
      // après. Recoller des textures sur des maillages déjà construits
      // voudrait dire reconstruire tous les attributs — autant les mailler une
      // fois, bien.
      //
      // Sans pack, `blockShapes` rend un objet vide : tout tombe sur la couche
      // 0, qui est blanche, et le build s'affiche exactement comme avant.
      //
      // Le MÊME appel sert aux deux : les cubes vont à l'atlas, les autres
      // (escaliers, dalles, chaises) à la table de formes. Une seule source,
      // donc un bloc ne peut pas être un cube pour l'atlas et un modèle pour le
      // mailleur.
      let atlas = null;
      let shapes = null;
      try {
        const formes = await window.titi.engine.blockShapes({ ids: geometry.palette.map((b) => b.name) });
        if (Object.keys(formes).length) {
          atlas = await buildAtlas(geometry.palette, facesDesCubes(formes), sourcesDesModeles(formes));
          const table = tableDesFormes(geometry.palette, formes, atlas.coucheDe);
          shapes = table.shapes;
          // Un bloc-modèle ne CACHE pas ce qu'il y a derrière lui. Laissé
          // opaque, il supprimait les faces de ses voisins : un escalier
          // creusait un trou dans le mur qu'il touche.
          for (const id of table.transparents) opaque[id] = 0;
        }
      } catch { atlas = null; shapes = null; }
      if (cancelled) return;

      // L'ancien matériau est remplacé, pas gardé : deux matériaux vivants
      // voudraient dire deux programmes compilés pour le même build.
      state.material?.dispose();
      state.atlasTexture?.dispose();
      const material = atlas
        ? makeAtlasMaterial(atlas.texture)
        : new THREE.MeshBasicMaterial({ vertexColors: true });
      state.material = material;
      state.atlasTexture = atlas?.texture || null;
      // Les chunks les plus proches de la caméra d'abord : le build apparaît
      // depuis le point de vue au lieu de se remplir dans un ordre arbitraire.
      const keys = [...chunks.keys()].sort((a, b) => distToCamera(a, state.camera) - distToCamera(b, state.camera));

      await Promise.all(keys.map(async (key) => {
        const [cx, cy, cz] = key.split(',').map(Number);
        const ids = paddedChunk(chunks, cx, cy, cz);
        const res = await state.pool.mesh(
          {
            key,
            origin: [cx * CH, cy * CH, cz * CH],
            ids: ids.buffer,
            opaque: opaque.buffer.slice(0),
            colors: colors.buffer.slice(0),
            layers: atlas ? atlas.layers.buffer.slice(0) : null,
            shapes,
          },
          [ids.buffer],
        );
        if (cancelled || !res.quads) return;
        quads += res.quads;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(res.positions), 3));
        geo.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(res.colors), 3, true));
        // Les UV ne sont PAS normalisés : ils vont de 0 à la taille du quad, et
        // c'est `fract` dans le nuanceur qui répète la tuile.
        geo.setAttribute('tileUv', new THREE.BufferAttribute(new Float32Array(res.uv), 2));
        geo.setAttribute('tileLayer', new THREE.BufferAttribute(new Float32Array(new Uint16Array(res.layers)), 1));
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(res.indices), 1));
        geo.computeBoundingSphere();

        const mesh = new THREE.Mesh(geo, material);
        mesh.position.set(res.origin[0], res.origin[1], res.origin[2]);
        mesh.userData.chunkY = cy;
        state.world.add(mesh);
        state.meshes.set(key, mesh);
      }));

      if (cancelled) return;
      frameBuild(state, geometry);
      if (window.TITI_DIAG) {
        const first = state.meshes.values().next().value;
        console.warn('[diag] ' + JSON.stringify({
          meshes: state.meshes.size, quads,
          canvas: [state.renderer.domElement.width, state.renderer.domElement.height],
          clientSize: [state.renderer.domElement.clientWidth, state.renderer.domElement.clientHeight],
          cam: state.camera.position.toArray().map(Math.round),
          target: state.target.toArray().map(Math.round),
          firstOrigin: first && first.position.toArray(),
          firstVerts: first && first.geometry.attributes.position.count,
          firstBS: first && Math.round(first.geometry.boundingSphere.radius),
          firstColor: first && Array.from(first.geometry.attributes.color.array.slice(0, 3)),
          clip: state.renderer.clippingPlanes.length,
        }));
      }
      onStats?.({ meshMs: Math.round(performance.now() - t0), chunks: state.meshes.size, quads });
    })();

    return () => { cancelled = true; };
  }, [ready, geometry]);

  // ── Tranche de couche Y ──────────────────────────────────────────────────
  useEffect(() => {
    const state = stateRef.current;
    if (!state || layerY == null || !geometry) return;
    // Le plan de coupe est global : découper dans le shader évite de remailler
    // à chaque cran du curseur.
    state.renderer.clippingPlanes = layerY >= geometry.min.y + geometry.size.y - 1
      ? []
      : [new THREE.Plane(new THREE.Vector3(0, -1, 0), layerY + 1)];
  }, [layerY, geometry]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} onPointerMove={(e) => onHover?.(pick(stateRef.current, e))} />;
}

// ── Utilitaires ─────────────────────────────────────────────────────────────

function makeSky() {
  // Dégradé discret : assez pour donner un haut et un bas, jamais assez pour
  // attirer l'œil hors du build.
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const g = c.getContext('2d').createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, `#${SKY_TOP.toString(16).padStart(6, '0')}`);
  g.addColorStop(1, `#${SKY_BOTTOM.toString(16).padStart(6, '0')}`);
  const ctx = c.getContext('2d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function distToCamera(key, camera) {
  const [cx, cy, cz] = key.split(',').map(Number);
  return camera.position.distanceToSquared(new THREE.Vector3(cx * CH + 8, cy * CH + 8, cz * CH + 8));
}

function disposeMesh(world, mesh) {
  world.remove(mesh);
  mesh.geometry.dispose();
}

/** Cadre la caméra sur le build entier — l'équivalent de `F`. */
function frameBuild(state, geometry) {
  const { min, size } = geometry;
  const center = new THREE.Vector3(min.x + size.x / 2, min.y + size.y / 2, min.z + size.z / 2);
  const radius = Math.max(size.x, size.y, size.z);
  state.target.copy(center);
  state.grid.position.set(center.x, min.y, center.z);
  const dir = new THREE.Vector3(0.72, 0.52, 0.9).normalize();
  state.camera.position.copy(center).addScaledVector(dir, radius * 1.35 + 24);
  state.camera.lookAt(center);
  state.controls.sync();
}

/**
 * Bloc visé par le curseur, ou `null` si le rayon ne touche rien.
 *
 * On lance le rayon contre les MAILLAGES et pas contre les données : le
 * maillage est déjà là, il est à jour, et three sait l'interroger avec un
 * partitionnement. Refaire une traversée de voxels à côté voudrait dire deux
 * représentations du même build qui peuvent diverger — et la divergence se
 * verrait comme un pinceau qui peint à côté de ce qu'on vise.
 *
 * Le maillage est greedy : une face peut couvrir cent blocs. C'est pour ça
 * qu'on rend le POINT et la NORMALE plutôt qu'un indice de face, et que le
 * calcul de la case revient à `brush.js`, qui sait de quel côté se placer.
 */
function pick(state, ndc) {
  if (!state?.meshes?.size) return null;
  state.raycaster ??= new THREE.Raycaster();
  state.raycaster.setFromCamera(ndc, state.camera);
  const hits = state.raycaster.intersectObjects([...state.meshes.values()], false);
  if (!hits.length) return null;
  const h = hits[0];
  if (!h.face) return null;
  // La normale est locale au maillage ; les maillages de chunk ne sont que
  // translatés, donc elle vaut aussi en repère monde. La normaliser quand même
  // coûte trois multiplications et survit à une rotation qu'on ajouterait un
  // jour sans y penser.
  const n = h.face.normal.clone().transformDirection(h.object.matrixWorld).round();
  return { point: { x: h.point.x, y: h.point.y, z: h.point.z }, normal: { x: n.x, y: n.y, z: n.z }, distance: h.distance };
}

/**
 * Orbite + vol maison. `OrbitControls` de three ferait l'affaire, mais il vient
 * avec ses propres raccourcis et son amortissement, et cette caméra doit
 * répondre exactement comme celle du générateur du site (ZQSD/WASD, R/F).
 */
function makeOrbit(dom, camera, target) {
  let yaw = Math.atan2(camera.position.x - target.x, camera.position.z - target.z);
  let pitch = Math.asin(Math.min(1, (camera.position.y - target.y) / camera.position.distanceTo(target)));
  let dist = camera.position.distanceTo(target);
  let vYaw = 0, vPitch = 0, vDist = 0;
  const move = new THREE.Vector3();
  const keys = new Set();
  let dragging = false, lastX = 0, lastY = 0;
  // Pendant qu'on peint, faire tourner la caméra en même temps rendrait le
  // trait inutilisable. Le pinceau prend la main sur le bouton gauche.
  let actif = true;

  const onDown = (e) => {
    if (!actif) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY; dom.setPointerCapture(e.pointerId);
  };
  const onUp = (e) => { dragging = false; dom.releasePointerCapture?.(e.pointerId); };
  const onMove = (e) => {
    if (!dragging) return;
    vYaw -= (e.clientX - lastX) * 0.005;
    vPitch += (e.clientY - lastY) * 0.005;
    lastX = e.clientX; lastY = e.clientY;
  };
  const onWheel = (e) => { e.preventDefault(); vDist += e.deltaY * 0.0016 * dist; };
  const onKey = (e) => {
    const k = e.key.toLowerCase();
    if (e.type === 'keydown') keys.add(k); else keys.delete(k);
  };

  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);

  return {
    sync() {
      dist = camera.position.distanceTo(target);
      yaw = Math.atan2(camera.position.x - target.x, camera.position.z - target.z);
      pitch = Math.asin(Math.min(1, Math.max(-1, (camera.position.y - target.y) / dist)));
    },
    update() {
      // Amortissement : le mouvement s'arrête tout seul au lieu de piler net.
      yaw += vYaw; pitch += vPitch; dist = Math.max(6, dist + vDist);
      vYaw *= 0.82; vPitch *= 0.82; vDist *= 0.8;
      pitch = Math.max(-1.5, Math.min(1.5, pitch));

      // ZQSD/WASD relatifs à la vue, R/F verticaux — comme sur le site.
      const speed = dist * 0.012;
      move.set(0, 0, 0);
      if (keys.has('z') || keys.has('w')) move.z -= 1;
      if (keys.has('s')) move.z += 1;
      if (keys.has('q') || keys.has('a')) move.x -= 1;
      if (keys.has('d')) move.x += 1;
      if (keys.has('r')) move.y += 1;
      if (keys.has('f')) move.y -= 1;
      if (move.lengthSq()) {
        move.normalize().multiplyScalar(speed);
        const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
        const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
        target.addScaledVector(fwd, -move.z).addScaledVector(right, move.x);
        target.y += move.y;
      }

      camera.position.set(
        target.x + Math.sin(yaw) * Math.cos(pitch) * dist,
        target.y + Math.sin(pitch) * dist,
        target.z + Math.cos(yaw) * Math.cos(pitch) * dist,
      );
      camera.lookAt(target);
    },
    /** Le pinceau coupe l'orbite le temps d'un trait. La molette reste. */
    setActive(v) { actif = v; if (!v) dragging = false; },
    dispose() {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    },
  };
}
