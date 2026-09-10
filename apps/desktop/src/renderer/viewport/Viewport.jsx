import { useEffect, useRef, useState } from 'react';
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

export default function Viewport({ geometry, layerY, onStats, onHover }) {
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
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

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

    const material = new THREE.MeshBasicMaterial({ vertexColors: true });

    (async () => {
      const t0 = performance.now();
      let quads = 0;
      // Les chunks les plus proches de la caméra d'abord : le build apparaît
      // depuis le point de vue au lieu de se remplir dans un ordre arbitraire.
      const keys = [...chunks.keys()].sort((a, b) => distToCamera(a, state.camera) - distToCamera(b, state.camera));

      await Promise.all(keys.map(async (key) => {
        const [cx, cy, cz] = key.split(',').map(Number);
        const ids = paddedChunk(chunks, cx, cy, cz);
        const res = await state.pool.mesh(
          { key, origin: [cx * CH, cy * CH, cz * CH], ids: ids.buffer, opaque: opaque.buffer.slice(0), colors: colors.buffer.slice(0) },
          [ids.buffer],
        );
        if (cancelled || !res.quads) return;
        quads += res.quads;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(res.positions), 3));
        geo.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(res.colors), 3, true));
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

function pick() { return null; } // survol du bloc visé : phase 3 (curseur de brush)

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

  const onDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; dom.setPointerCapture(e.pointerId); };
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
