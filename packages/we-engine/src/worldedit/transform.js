import { transformProperties, isYMirrorSafe } from './blockstates.js';

// Cœur de transformation WorldEdit : opère sur un VOLUME (accès bloc en coords
// monde) et une SÉLECTION { min:{x,y,z}, max:{x,y,z} } inclusive.
//
// Un « bloc » = { Name, Properties|null } ; l'air = null (ou Name minecraft:air).
// Les blocs custom `minefield:*` ne sont JAMAIS remappés vers du vanilla : seules
// leurs Properties sont transformées (comme n'importe quel bloc).
//
// Interface Volume attendue : getBlock(x,y,z) -> bloc|null ; setBlock(x,y,z,bloc|null).

const AIR_NAMES = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);
const isAir = (b) => !b || AIR_NAMES.has(b.Name);
const FACES6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// ── Schematic : grille dense d'une sélection (presse-papier) ─────────────────
// data[x + sx*(z + sz*y)] = bloc|null. origin = coin (min) d'origine.
export class Schematic {
  constructor(sx, sy, sz, data, origin = { x: 0, y: 0, z: 0 }) {
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.data = data || new Array(sx * sy * sz).fill(null);
    this.origin = origin;
  }

  idx(x, y, z) { return x + this.sx * (z + this.sz * y); }
  get(x, y, z) { return this.data[this.idx(x, y, z)]; }
  set(x, y, z, b) { this.data[this.idx(x, y, z)] = b; }
}

// ── Forme de sélection (boîte / sphère / cylindre) ───────────────────────────
export const SELECTION_SHAPES = new Set(['box', 'sphere', 'cylinder']);

// `sel` normalisée (min ≤ max). Renvoie true si (x,y,z) est DANS la sélection
// selon sa forme (par défaut une boîte).
export function selectionContains(sel, x, y, z) {
  if (x < sel.min.x || x > sel.max.x || y < sel.min.y || y > sel.max.y || z < sel.min.z || z > sel.max.z) return false;
  const type = sel.shape?.type || 'box';
  if (type === 'box') return true;
  const cx = (sel.min.x + sel.max.x) / 2, cy = (sel.min.y + sel.max.y) / 2, cz = (sel.min.z + sel.max.z) / 2;
  const rx = (sel.max.x - sel.min.x) / 2 + 0.5, ry = (sel.max.y - sel.min.y) / 2 + 0.5, rz = (sel.max.z - sel.min.z) / 2 + 0.5;
  if (type === 'sphere') return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1;
  if (type === 'cylinder') return ((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 <= 1;
  return true;
}

// Volume « masqué » par la forme de sélection : les écritures hors forme sont
// ignorées. Toute opération écrivant à travers ce volume respecte donc la forme
// SANS la modifier (sphère, cylindre…). La lecture passe à travers.
export class MaskedVolume {
  constructor(inner, sel) { this.inner = inner; this.sel = sel; }
  getBlock(x, y, z) { return this.inner.getBlock(x, y, z); }
  setBlock(x, y, z, b) { if (selectionContains(this.sel, x, y, z)) this.inner.setBlock(x, y, z, b); }
  getBiome(x, y, z) { return this.inner.getBiome ? this.inner.getBiome(x, y, z) : null; }
  setBiome(x, y, z, n) { return (selectionContains(this.sel, x, y, z) && this.inner.setBiome) ? this.inner.setBiome(x, y, z, n) : false; }
}

export function selectionSize(sel) {
  return {
    x: sel.max.x - sel.min.x + 1,
    y: sel.max.y - sel.min.y + 1,
    z: sel.max.z - sel.min.z + 1,
  };
}

export function readSelection(vol, sel) {
  const s = selectionSize(sel);
  const schem = new Schematic(s.x, s.y, s.z, null, { ...sel.min });
  for (let y = 0; y < s.y; y++) {
    for (let z = 0; z < s.z; z++) {
      for (let x = 0; x < s.x; x++) {
        schem.set(x, y, z, vol.getBlock(sel.min.x + x, sel.min.y + y, sel.min.z + z));
      }
    }
  }
  return schem;
}

const clone = (b) => (b ? { Name: b.Name, Properties: b.Properties ? { ...b.Properties } : null } : null);

function applyState(b, op) {
  if (isAir(b)) return b;
  if (op.kind === 'mirror' && op.axis === 'y' && !isYMirrorSafe(b.Name)) return clone(b);
  const props = transformProperties(b.Properties, op);
  return { Name: b.Name, Properties: props };
}

// ── Transformations géométriques d'une Schematic → nouvelle Schematic ────────

export function mirrorSchematic(schem, axis) {
  const { sx, sy, sz } = schem;
  const out = new Schematic(sx, sy, sz, null, schem.origin);
  const op = { kind: 'mirror', axis };
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const nx = axis === 'x' ? sx - 1 - x : x;
        const ny = axis === 'y' ? sy - 1 - y : y;
        const nz = axis === 'z' ? sz - 1 - z : z;
        out.set(nx, ny, nz, applyState(schem.get(x, y, z), op));
      }
    }
  }
  return out;
}

// Rotation horaire autour de Y, par quarts (1=90°, 2=180°, 3=270°).
export function rotateSchematic(schem, quarts) {
  const q = ((quarts % 4) + 4) % 4;
  if (q === 0) return schem;
  let cur = schem;
  for (let i = 0; i < q; i++) cur = rotate90(cur);
  return cur;
}

function rotate90(schem) {
  const { sx, sy, sz } = schem;
  // 90° CW : (x,z) -> (x'=(sz-1)-z, z'=x) ; dims X/Z permutées.
  const out = new Schematic(sz, sy, sx, null, schem.origin);
  const op = { kind: 'rotate', quarts: 1 };
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        out.set(sz - 1 - z, y, x, applyState(schem.get(x, y, z), op));
      }
    }
  }
  return out;
}

// ── Pose d'une Schematic dans un volume ──────────────────────────────────────
// mode 'overwrite' : écrit tout (y compris l'air → efface). 'overlay' : ne pose
// que les blocs non-air (l'air de la schematic laisse le volume intact).
export function stampSchematic(vol, schem, origin, mode = 'overwrite') {
  let changed = 0;
  for (let y = 0; y < schem.sy; y++) {
    for (let z = 0; z < schem.sz; z++) {
      for (let x = 0; x < schem.sx; x++) {
        const b = schem.get(x, y, z);
        if (mode === 'overlay' && isAir(b)) continue;
        const wx = origin.x + x, wy = origin.y + y, wz = origin.z + z;
        const before = vol.getBlock(wx, wy, wz);
        const after = isAir(b) ? null : clone(b);
        if (!sameBlock(before, after)) { vol.setBlock(wx, wy, wz, after); changed++; }
      }
    }
  }
  return changed;
}

function fillSelection(vol, sel, block) {
  let changed = 0;
  for (let y = sel.min.y; y <= sel.max.y; y++) {
    for (let z = sel.min.z; z <= sel.max.z; z++) {
      for (let x = sel.min.x; x <= sel.max.x; x++) {
        const before = vol.getBlock(x, y, z);
        if (!sameBlock(before, block)) { vol.setBlock(x, y, z, block ? clone(block) : null); changed++; }
      }
    }
  }
  return changed;
}

export function sameBlock(a, b) {
  if (isAir(a) && isAir(b)) return true;
  if (isAir(a) || isAir(b)) return false;
  if (a.Name !== b.Name) return false;
  const pa = a.Properties || {}, pb = b.Properties || {};
  const ka = Object.keys(pa), kb = Object.keys(pb);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => String(pa[k]) === String(pb[k]));
}

// `from`/`to` : { name, states? }. Un bloc matche si Name === from.name et que
// chaque état de from.states correspond (sous-ensemble). `to` impose le nom et
// fusionne to.states (ou conserve les états source si absent).
function matchBlock(b, from) {
  if (isAir(b)) return false;
  if (b.Name !== from.name) return false;
  if (!from.states) return true;
  const p = b.Properties || {};
  return Object.entries(from.states).every(([k, v]) => String(p[k]) === String(v));
}

// ── Opérations de haut niveau (sur volume + sélection) ───────────────────────
// Chaque op renvoie { blocksChanged, bounds? }. `bounds` = nouvelle emprise si
// l'opération peut déborder la sélection (rotate non carré, translate, paste).

export function opMirror(vol, sel, { axis }) {
  if (!['x', 'y', 'z'].includes(axis)) throw new Error('bad_axis');
  const schem = mirrorSchematic(readSelection(vol, sel), axis);
  const changed = stampSchematic(vol, schem, sel.min, 'overwrite');
  return { blocksChanged: changed, bounds: sel };
}

// Miroir COPIE : duplique la sélection en miroir de l'autre côté (l'original
// reste). Le plan miroir est la face de la sélection (côté + ou −) ; le copie est
// posée adjacente (écart `gap` réglable). Idéal pour symétriser une aile de build.
export function opMirrorCopy(vol, sel, { axis, side = 'positive', gap = 0, mode = 'overlay' }) {
  if (!['x', 'y', 'z'].includes(axis)) throw new Error('bad_axis');
  const schem = mirrorSchematic(readSelection(vol, sel), axis);
  const size = selectionSize(sel);
  const g = Math.max(0, Math.round(gap) || 0);
  const origin = { ...sel.min };
  origin[axis] = side === 'negative' ? sel.min[axis] - size[axis] - g : sel.max[axis] + 1 + g;
  const changed = stampSchematic(vol, schem, origin, mode === 'overwrite' ? 'overwrite' : 'overlay');
  return {
    blocksChanged: changed,
    bounds: { min: { ...origin }, max: { x: origin.x + size.x - 1, y: origin.y + size.y - 1, z: origin.z + size.z - 1 } },
  };
}

export function opRotate(vol, sel, { degrees }) {
  const quarts = { 90: 1, 180: 2, 270: 3 }[degrees];
  if (!quarts) throw new Error('bad_degrees');
  const src = readSelection(vol, sel);
  const schem = rotateSchematic(src, quarts);
  // On efface l'ancienne sélection puis on pose la version tournée au même coin.
  fillSelection(vol, sel, null);
  const changed = stampSchematic(vol, schem, sel.min, 'overwrite');
  const bounds = {
    min: { ...sel.min },
    max: { x: sel.min.x + schem.sx - 1, y: sel.min.y + schem.sy - 1, z: sel.min.z + schem.sz - 1 },
  };
  return { blocksChanged: changed, bounds };
}

export function opTranslate(vol, sel, { dx = 0, dy = 0, dz = 0 }) {
  const schem = readSelection(vol, sel);
  fillSelection(vol, sel, null);
  const origin = { x: sel.min.x + dx, y: sel.min.y + dy, z: sel.min.z + dz };
  const changed = stampSchematic(vol, schem, origin, 'overwrite');
  return {
    blocksChanged: changed,
    bounds: { min: origin, max: { x: origin.x + schem.sx - 1, y: origin.y + schem.sy - 1, z: origin.z + schem.sz - 1 } },
  };
}

// ── Masques : restreignent les cases affectées par set/mix/erode… ────────────
function neighborsAir(vol, x, y, z) {
  return isAir(vol.getBlock(x + 1, y, z)) || isAir(vol.getBlock(x - 1, y, z))
    || isAir(vol.getBlock(x, y + 1, z)) || isAir(vol.getBlock(x, y - 1, z))
    || isAir(vol.getBlock(x, y, z + 1)) || isAir(vol.getBlock(x, y, z - 1));
}
// mask = { type:'all'|'air'|'solid'|'exposed'|'on_surface'|'above'|'below', y? }
export function maskFn(mask) {
  const t = mask?.type || 'all';
  if (t === 'air') return (vol, x, y, z) => isAir(vol.getBlock(x, y, z));
  if (t === 'solid') return (vol, x, y, z) => !isAir(vol.getBlock(x, y, z));
  if (t === 'exposed') return (vol, x, y, z) => !isAir(vol.getBlock(x, y, z)) && neighborsAir(vol, x, y, z);
  if (t === 'on_surface') return (vol, x, y, z) => isAir(vol.getBlock(x, y, z)) && !isAir(vol.getBlock(x, y - 1, z));
  if (t === 'above') return (vol, x, y) => y >= (Number(mask.y) || 0);
  if (t === 'below') return (vol, x, y) => y <= (Number(mask.y) || 0);
  return () => true;
}
const matchAnyFrom = (b, froms) => froms.some((f) => f?.name && matchBlock(b, f));

// Remplace un ou PLUSIEURS blocs source par une cible.
export function opReplace(vol, sel, { from, to }) {
  if (!to?.name) throw new Error('bad_replace');
  const froms = (Array.isArray(from) ? from : [from]).filter((f) => f?.name);
  if (!froms.length) throw new Error('bad_replace');
  let changed = 0;
  for (let y = sel.min.y; y <= sel.max.y; y++) {
    for (let z = sel.min.z; z <= sel.max.z; z++) {
      for (let x = sel.min.x; x <= sel.max.x; x++) {
        const b = vol.getBlock(x, y, z);
        if (!matchAnyFrom(b, froms)) continue;
        const props = to.states ? { ...(b.Properties || {}), ...to.states } : (b.Properties ? { ...b.Properties } : null);
        vol.setBlock(x, y, z, { Name: to.name, Properties: props && Object.keys(props).length ? props : null });
        changed++;
      }
    }
  }
  return { blocksChanged: changed, bounds: sel };
}

export function opSet(vol, sel, { block, mask }) {
  if (!block?.name) throw new Error('bad_block');
  const b = { Name: block.name, Properties: block.states || null };
  if (!mask || mask.type === 'all') return { blocksChanged: fillSelection(vol, sel, b), bounds: sel };
  const mfn = maskFn(mask);
  // Deux passes : le masque est évalué sur l'état D'ORIGINE (sinon set en
  // cascade — ex. on_surface qui remonterait toute la colonne).
  const cells = [];
  for (let y = sel.min.y; y <= sel.max.y; y++)
    for (let z = sel.min.z; z <= sel.max.z; z++)
      for (let x = sel.min.x; x <= sel.max.x; x++) if (mfn(vol, x, y, z)) cells.push([x, y, z]);
  let changed = 0;
  for (const [x, y, z] of cells) if (!sameBlock(vol.getBlock(x, y, z), b)) { vol.setBlock(x, y, z, clone(b)); changed++; }
  return { blocksChanged: changed, bounds: sel };
}

// Mélange aléatoire pondéré : chaque case prend un bloc tiré au sort selon les
// poids (% relatifs). `from` optionnel = ne change que les blocs correspondants
// (sinon toute la sélection). Ex. 20% cobble / 30% terre / 20% andésite…
export function opMix(vol, sel, { from, pattern, mask }) {
  if (!Array.isArray(pattern) || pattern.length === 0) throw new Error('bad_pattern');
  const entries = pattern
    .filter((p) => p?.name && Number(p.weight) > 0)
    .map((p) => ({ block: { Name: p.name, Properties: p.states || null }, w: Number(p.weight) }));
  if (!entries.length) throw new Error('bad_pattern');
  const total = entries.reduce((s, e) => s + e.w, 0);
  let acc = 0;
  const cum = entries.map((e) => { acc += e.w; return { block: e.block, c: acc }; });
  const pick = () => {
    const r = Math.random() * total;
    for (const e of cum) if (r < e.c) return e.block;
    return cum[cum.length - 1].block;
  };
  const mfn = maskFn(mask);
  const froms = from ? (Array.isArray(from) ? from : [from]).filter((f) => f?.name) : [];
  const cells = [];
  for (let y = sel.min.y; y <= sel.max.y; y++) {
    for (let z = sel.min.z; z <= sel.max.z; z++) {
      for (let x = sel.min.x; x <= sel.max.x; x++) {
        const cur = vol.getBlock(x, y, z);
        if (froms.length && !matchAnyFrom(cur, froms)) continue;
        if (!mfn(vol, x, y, z)) continue;
        cells.push([x, y, z]);
      }
    }
  }
  let changed = 0;
  for (const [x, y, z] of cells) {
    const b = pick();
    if (!sameBlock(vol.getBlock(x, y, z), b)) { vol.setBlock(x, y, z, clone(b)); changed++; }
  }
  return { blocksChanged: changed, bounds: sel };
}

// copy → renvoie une Schematic (presse-papier) ; aucune écriture.
export function opCopy(vol, sel) {
  return { clipboard: readSelection(vol, sel) };
}

// cut → copie la sélection dans le presse-papier PUIS la vide (tout → air).
export function opCut(vol, sel) {
  const clipboard = readSelection(vol, sel);
  const blocksChanged = fillSelection(vol, sel, null); // null = air
  return { clipboard, blocksChanged, bounds: sel };
}

// ── Commandes type WorldEdit / GoBrush (toutes bornées par la sélection) ─────
const toBlock = (p) => (p && p.name ? { Name: p.name, Properties: p.states || null } : null);

// Murs : les 4 côtés verticaux de la sélection.
export function opWalls(vol, sel, { block }) {
  const b = toBlock(block); if (!b) throw new Error('bad_block');
  let c = 0;
  for (let y = sel.min.y; y <= sel.max.y; y++)
    for (let z = sel.min.z; z <= sel.max.z; z++)
      for (let x = sel.min.x; x <= sel.max.x; x++)
        if (x === sel.min.x || x === sel.max.x || z === sel.min.z || z === sel.max.z) {
          if (!sameBlock(vol.getBlock(x, y, z), b)) { vol.setBlock(x, y, z, clone(b)); c++; }
        }
  return { blocksChanged: c, bounds: sel };
}

// Faces : les 6 faces (murs + plafond + plancher).
export function opFaces(vol, sel, { block }) {
  const b = toBlock(block); if (!b) throw new Error('bad_block');
  let c = 0;
  for (let y = sel.min.y; y <= sel.max.y; y++)
    for (let z = sel.min.z; z <= sel.max.z; z++)
      for (let x = sel.min.x; x <= sel.max.x; x++)
        if (x === sel.min.x || x === sel.max.x || z === sel.min.z || z === sel.max.z || y === sel.min.y || y === sel.max.y) {
          if (!sameBlock(vol.getBlock(x, y, z), b)) { vol.setBlock(x, y, z, clone(b)); c++; }
        }
  return { blocksChanged: c, bounds: sel };
}

// Creuser : vide les blocs pleins entièrement entourés (garde une coque de 1).
export function opHollow(vol, sel) {
  const clear = [];
  for (let y = sel.min.y + 1; y < sel.max.y; y++)
    for (let z = sel.min.z + 1; z < sel.max.z; z++)
      for (let x = sel.min.x + 1; x < sel.max.x; x++) {
        if (isAir(vol.getBlock(x, y, z))) continue;
        const enclosed = !isAir(vol.getBlock(x + 1, y, z)) && !isAir(vol.getBlock(x - 1, y, z))
          && !isAir(vol.getBlock(x, y + 1, z)) && !isAir(vol.getBlock(x, y - 1, z))
          && !isAir(vol.getBlock(x, y, z + 1)) && !isAir(vol.getBlock(x, y, z - 1));
        if (enclosed) clear.push([x, y, z]);
      }
  for (const [x, y, z] of clear) vol.setBlock(x, y, z, null);
  return { blocksChanged: clear.length, bounds: sel };
}

// Overlay : pose un bloc juste au-dessus de la surface de chaque colonne.
export function opOverlay(vol, sel, { block }) {
  const b = toBlock(block); if (!b) throw new Error('bad_block');
  let c = 0;
  for (let z = sel.min.z; z <= sel.max.z; z++)
    for (let x = sel.min.x; x <= sel.max.x; x++) {
      let top = null;
      for (let y = sel.max.y; y >= sel.min.y; y--) { if (!isAir(vol.getBlock(x, y, z))) { top = y; break; } }
      if (top === null || top >= sel.max.y) continue;
      if (isAir(vol.getBlock(x, top + 1, z))) { vol.setBlock(x, top + 1, z, clone(b)); c++; }
    }
  return { blocksChanged: c, bounds: sel };
}

// Naturaliser : 1 herbe / 3 terre / reste pierre sous chaque surface exposée.
// Palettes « naturelles » par biome : surface / sous-sol / roche profonde (cette
// dernière est un mélange pondéré [bloc, poids] pour un rendu non uniforme —
// pierre + andésite + cobble… selon le terrain).
export const NATURALIZE_PRESETS = {
  plains: { surface: 'grass_block', soil: 'dirt', filler: [['stone', 82], ['andesite', 8], ['diorite', 6], ['gravel', 4]] },
  forest: { surface: 'grass_block', soil: 'dirt', filler: [['stone', 82], ['andesite', 10], ['coal_ore', 4], ['gravel', 4]] },
  savanna: { surface: 'grass_block', soil: 'dirt', filler: [['stone', 80], ['granite', 18], ['gravel', 2]] },
  swamp: { surface: 'grass_block', soil: 'dirt', filler: [['stone', 68], ['clay', 16], ['gravel', 16]] },
  desert: { surface: 'sand', soil: 'sandstone', filler: [['sandstone', 70], ['stone', 30]] },
  badlands: { surface: 'red_sand', soil: 'terracotta', filler: [['stone', 55], ['red_sandstone', 35], ['terracotta', 10]] },
  snowy: { surface: 'snow_block', soil: 'dirt', filler: [['stone', 78], ['andesite', 12], ['packed_ice', 10]] },
  mountain: { surface: 'stone', soil: 'cobblestone', filler: [['stone', 52], ['andesite', 26], ['cobblestone', 16], ['gravel', 6]] },
  stony_peaks: { surface: 'stone', soil: 'andesite', filler: [['stone', 48], ['andesite', 30], ['cobblestone', 22]] },
  mushroom: { surface: 'mycelium', soil: 'dirt', filler: [['stone', 88], ['andesite', 12]] },
};
export const NATURALIZE_PRESET_IDS = [...Object.keys(NATURALIZE_PRESETS), 'auto', 'custom'];

const nm = (s) => (s && s.includes(':') ? s : `minecraft:${s}`);
// Devine la palette depuis un nom de biome Minecraft (mode « auto »).
function biomeToPreset(biome) {
  const n = String(biome || '').replace('minecraft:', '');
  if (/desert/.test(n)) return 'desert';
  if (/badlands/.test(n)) return 'badlands';
  if (/snow|frozen|ice|grove|slopes/.test(n)) return 'snowy';
  if (/peak|jagged|stony/.test(n)) return 'stony_peaks';
  if (/mountain|windswept|meadow|cherry/.test(n)) return 'mountain';
  if (/savanna/.test(n)) return 'savanna';
  if (/swamp/.test(n)) return 'swamp';
  if (/mushroom/.test(n)) return 'mushroom';
  if (/forest|taiga|jungle|grove/.test(n)) return 'forest';
  return 'plains';
}

// Tireur pondéré pour la roche profonde (mélange par bloc).
function fillerPicker(filler) {
  const list = filler.map(([name, w]) => [toBlock({ name: nm(name) }), Math.max(1, w)]);
  const total = list.reduce((s, [, w]) => s + w, 0);
  return () => { let r = Math.random() * total; for (const [b, w] of list) { r -= w; if (r <= 0) return b; } return list[list.length - 1][0]; };
}
function paletteOf(p) {
  return { surface: toBlock({ name: nm(p.surface) }), soil: toBlock({ name: nm(p.soil) }), pick: fillerPicker(p.filler) };
}

export function opNaturalize(vol, sel, params = {}) {
  const presetKey = params.preset || 'plains';
  const auto = presetKey === 'auto';
  let pal;
  if (presetKey === 'custom') {
    pal = paletteOf({
      surface: params.surface || 'minecraft:grass_block',
      soil: params.soil || 'minecraft:dirt',
      filler: [[params.filler || 'minecraft:stone', 1]],
    });
  } else if (!auto) {
    pal = paletteOf(NATURALIZE_PRESETS[presetKey] || NATURALIZE_PRESETS.plains);
  }
  let c = 0;
  for (let z = sel.min.z; z <= sel.max.z; z++)
    for (let x = sel.min.x; x <= sel.max.x; x++) {
      let depth = 0;
      let col = pal; // palette de la colonne (auto : choisie à la surface)
      for (let y = sel.max.y; y >= sel.min.y; y--) {
        if (isAir(vol.getBlock(x, y, z))) { depth = 0; continue; }
        if (depth === 0 && auto) {
          const biome = vol.getBiome ? vol.getBiome(x, y, z) : null;
          col = paletteOf(NATURALIZE_PRESETS[biomeToPreset(biome)]);
        }
        const target = depth === 0 ? col.surface : depth <= 3 ? col.soil : col.pick();
        if (!sameBlock(vol.getBlock(x, y, z), target)) { vol.setBlock(x, y, z, clone(target)); c++; }
        depth++;
      }
    }
  return { blocksChanged: c, bounds: sel };
}

// ── Génération de terrain procédural (dénivelés naturels) ────────────────────
// Bruit de valeur fractal (fBm). Chaque style règle octaves / échelle / amplitude
// / exposant / crêtes (ridged) et un creusement éventuel (crevasse). La hauteur
// de chaque colonne est dérivée du bruit, puis la colonne est remplie avec une
// palette naturelle (réutilise NATURALIZE_PRESETS) et l'air au-dessus est purgé.
export const TERRAIN_STYLES = {
  plaine: { octaves: 3, scale: 48, amp: 0.14, exp: 1.0, ridged: false, base: 0.18, palette: 'plains' },
  collines: { octaves: 4, scale: 44, amp: 0.34, exp: 1.1, ridged: false, base: 0.22, palette: 'plains' },
  plateau: { octaves: 4, scale: 80, amp: 0.45, exp: 0.6, ridged: false, base: 0.30, palette: 'savanna' },
  montagne: { octaves: 5, scale: 64, amp: 0.85, exp: 1.4, ridged: false, base: 0.24, palette: 'mountain' },
  pic: { octaves: 5, scale: 56, amp: 0.96, exp: 2.2, ridged: true, base: 0.20, palette: 'stony_peaks' },
  crevasse: { octaves: 4, scale: 38, amp: 0.72, exp: 1.7, ridged: true, carve: true, base: 0.7, palette: 'mountain' },
};
export const TERRAIN_STYLE_IDS = Object.keys(TERRAIN_STYLES);

// Hash entier déterministe (x, z, seed) → [0,1).
function hash2(x, z, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
const smoothstep = (t) => t * t * (3 - 2 * t);
function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const v00 = hash2(ix, iz, seed), v10 = hash2(ix + 1, iz, seed);
  const v01 = hash2(ix, iz + 1, seed), v11 = hash2(ix + 1, iz + 1, seed);
  const sx = smoothstep(fx), sz = smoothstep(fz);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sz;
}
function fbm(x, z, octaves, seed) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, z * freq, seed + o * 1013);
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm; // [0,1]
}

export async function opTerrain(vol, sel, params = {}, ctx) {
  const style = TERRAIN_STYLES[params.style] || TERRAIN_STYLES.collines;
  const seed = Number.isFinite(params.seed) ? (params.seed | 0) : 1337;
  const scale = Math.max(4, Math.min(256, params.scale || style.scale));
  const ampMul = Number.isFinite(params.amplitude) ? Math.max(0, Math.min(1, params.amplitude)) : 1;
  const clearAbove = params.clearAbove !== false;
  const palKey = (params.palette && params.palette !== 'match') ? params.palette : style.palette;
  const auto = palKey === 'auto';
  const fixedPal = (!auto && palKey !== 'custom') ? paletteOf(NATURALIZE_PRESETS[palKey] || NATURALIZE_PRESETS.plains) : null;
  const customPal = palKey === 'custom'
    ? paletteOf({ surface: params.surface || 'minecraft:grass_block', soil: params.soil || 'minecraft:dirt', filler: [[params.filler || 'minecraft:stone', 1]] })
    : null;

  const minY = sel.min.y, maxY = sel.max.y;
  const range = Math.max(1, maxY - minY);
  const freq = 1 / scale;
  let c = 0;
  for (let z = sel.min.z; z <= sel.max.z; z++) {
    for (let x = sel.min.x; x <= sel.max.x; x++) {
      let n = fbm(x * freq, z * freq, style.octaves, seed);
      if (style.ridged) n = 1 - Math.abs(2 * n - 1); // crêtes acérées
      n = Math.pow(Math.max(0, Math.min(1, n)), style.exp);
      let hf = style.carve ? style.base - style.amp * ampMul * n : style.base + style.amp * ampMul * n;
      hf = Math.max(0, Math.min(1, hf));
      const topY = minY + Math.round(hf * range);
      const pal = auto ? paletteOf(NATURALIZE_PRESETS[biomeToPreset(vol.getBiome ? vol.getBiome(x, topY, z) : null)]) : (customPal || fixedPal);
      for (let y = minY; y <= topY; y++) {
        const depth = topY - y;
        const target = depth === 0 ? pal.surface : depth <= 3 ? pal.soil : pal.pick();
        if (!sameBlock(vol.getBlock(x, y, z), target)) { vol.setBlock(x, y, z, clone(target)); c++; }
      }
      if (clearAbove) {
        for (let y = topY + 1; y <= maxY; y++) {
          if (!isAir(vol.getBlock(x, y, z))) { vol.setBlock(x, y, z, null); c++; }
        }
      }
    }
    // Rend la main périodiquement (grosse zone → ne bloque pas le serveur).
    if (ctx?.yield && (z & 31) === 0) await ctx.yield();
  }
  return { blocksChanged: c, bounds: sel };
}

const STACK_DIR = { east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1] };

// Stack : répète la sélection `count` fois dans une direction.
export function opStack(vol, sel, { count, direction }) {
  const dir = STACK_DIR[direction]; if (!dir) throw new Error('bad_direction');
  const n = Math.max(1, Math.min(64, Math.round(count) || 1));
  const schem = readSelection(vol, sel);
  const size = selectionSize(sel);
  let changed = 0;
  let lo = { ...sel.min }, hi = { ...sel.max };
  for (let i = 1; i <= n; i++) {
    const origin = { x: sel.min.x + dir[0] * size.x * i, y: sel.min.y + dir[1] * size.y * i, z: sel.min.z + dir[2] * size.z * i };
    changed += stampSchematic(vol, schem, origin, 'overlay'); // l'air ne détruit pas l'existant
    lo = { x: Math.min(lo.x, origin.x), y: Math.min(lo.y, origin.y), z: Math.min(lo.z, origin.z) };
    hi = { x: Math.max(hi.x, origin.x + size.x - 1), y: Math.max(hi.y, origin.y + size.y - 1), z: Math.max(hi.z, origin.z + size.z - 1) };
  }
  return { blocksChanged: changed, bounds: { min: lo, max: hi } };
}

// Sphère (pinceau) : remplit une boule centrée sur la sélection. `hollow` = coque.
export function opSphere(vol, sel, { block, radius, hollow }) {
  const b = toBlock(block); if (!b) throw new Error('bad_block');
  const cx = (sel.min.x + sel.max.x) / 2, cy = (sel.min.y + sel.max.y) / 2, cz = (sel.min.z + sel.max.z) / 2;
  const r = Math.max(1, Math.round(radius) || 1), r2 = (r + 0.5) * (r + 0.5), ri2 = (r - 0.5) * (r - 0.5);
  let c = 0;
  for (let y = sel.min.y; y <= sel.max.y; y++)
    for (let z = sel.min.z; z <= sel.max.z; z++)
      for (let x = sel.min.x; x <= sel.max.x; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
        if (d2 > r2 || (hollow && d2 < ri2)) continue;
        if (!sameBlock(vol.getBlock(x, y, z), b)) { vol.setBlock(x, y, z, clone(b)); c++; }
      }
  return { blocksChanged: c, bounds: sel };
}

// Cylindre vertical (pinceau) : disque de rayon `radius` sur toute la hauteur.
export function opCyl(vol, sel, { block, radius, hollow }) {
  const b = toBlock(block); if (!b) throw new Error('bad_block');
  const cx = (sel.min.x + sel.max.x) / 2, cz = (sel.min.z + sel.max.z) / 2;
  const r = Math.max(1, Math.round(radius) || 1), r2 = (r + 0.5) * (r + 0.5), ri2 = (r - 0.5) * (r - 0.5);
  let c = 0;
  for (let y = sel.min.y; y <= sel.max.y; y++)
    for (let z = sel.min.z; z <= sel.max.z; z++)
      for (let x = sel.min.x; x <= sel.max.x; x++) {
        const d2 = (x - cx) ** 2 + (z - cz) ** 2;
        if (d2 > r2 || (hollow && d2 < ri2)) continue;
        if (!sameBlock(vol.getBlock(x, y, z), b)) { vol.setBlock(x, y, z, clone(b)); c++; }
      }
  return { blocksChanged: c, bounds: sel };
}

// Lisser (GoBrush) : adoucit la hauteur de la surface (moyenne de voisinage).
export function opSmooth(vol, sel, { iterations } = {}) {
  const w = sel.max.x - sel.min.x + 1, d = sel.max.z - sel.min.z + 1;
  const at = (x, z) => x * d + z;
  const height = new Float64Array(w * d).fill(-Infinity); // y de surface (absolu)
  const surf = new Array(w * d).fill(null);              // bloc de surface
  for (let xi = 0; xi < w; xi++) for (let zi = 0; zi < d; zi++) {
    const x = sel.min.x + xi, z = sel.min.z + zi;
    for (let y = sel.max.y; y >= sel.min.y; y--) {
      const blk = vol.getBlock(x, y, z);
      if (!isAir(blk)) { height[at(xi, zi)] = y; surf[at(xi, zi)] = blk; break; }
    }
  }
  const iters = Math.max(1, Math.min(8, Math.round(iterations) || 2));
  let h = height;
  for (let it = 0; it < iters; it++) {
    const nh = h.slice();
    for (let xi = 0; xi < w; xi++) for (let zi = 0; zi < d; zi++) {
      if (h[at(xi, zi)] === -Infinity) continue;
      let sum = 0, cnt = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const nx = xi + dx, nz = zi + dz;
        if (nx < 0 || nx >= w || nz < 0 || nz >= d) continue;
        const v = h[at(nx, nz)]; if (v === -Infinity) continue;
        sum += v; cnt++;
      }
      if (cnt) nh[at(xi, zi)] = sum / cnt;
    }
    h = nh;
  }
  let changed = 0;
  for (let xi = 0; xi < w; xi++) for (let zi = 0; zi < d; zi++) {
    const old = height[at(xi, zi)];
    if (old === -Infinity) continue;
    const target = Math.max(sel.min.y, Math.min(sel.max.y, Math.round(h[at(xi, zi)])));
    const x = sel.min.x + xi, z = sel.min.z + zi;
    if (target < old) {
      for (let y = old; y > target; y--) if (!isAir(vol.getBlock(x, y, z))) { vol.setBlock(x, y, z, null); changed++; }
    } else if (target > old) {
      const fill = surf[at(xi, zi)];
      for (let y = old + 1; y <= target; y++) if (isAir(vol.getBlock(x, y, z))) { vol.setBlock(x, y, z, clone(fill)); changed++; }
    }
  }
  return { blocksChanged: changed, bounds: sel };
}

// Échelle : redimensionne la sélection par un facteur (x0.5, x2, x3, x4, x6…).
// Échantillonnage au plus proche. Réécrit en place à partir du coin min ; pour
// f<1 on efface d'abord l'original. Borné pour éviter les volumes démesurés.
// Échelle ×N (échantillonnage au plus proche). `hollow` : après agrandissement,
// retire les blocs entièrement enfermés (tous voisins pleins) → ne garde que la
// COQUE extérieure. Évite de transformer chaque bloc en masse pleine N³ : on
// agrandit la structure mais on ne garde que les blocs « les plus à l'extérieur ».
export function opScale(vol, sel, { factor, hollow = false }) {
  const f = factor;
  const src = readSelection(vol, sel);
  const nsx = Math.max(1, Math.round(src.sx * f));
  const nsy = Math.max(1, Math.round(src.sy * f));
  const nsz = Math.max(1, Math.round(src.sz * f));
  if (nsx * nsy * nsz > 8_000_000) throw new Error('too_many_blocks');
  const sampled = (i, j, k) => src.get(
    Math.min(src.sx - 1, Math.floor(i / f)),
    Math.min(src.sy - 1, Math.floor(j / f)),
    Math.min(src.sz - 1, Math.floor(k / f)),
  );
  let changed = 0;
  if (f < 1) changed += fillSelection(vol, sel, null); // efface l'original avant réduction

  const writeCell = (i, j, k, block) => {
    const wx = sel.min.x + i, wy = sel.min.y + j, wz = sel.min.z + k;
    if (!sameBlock(vol.getBlock(wx, wy, wz), block)) { vol.setBlock(wx, wy, wz, block ? clone(block) : null); changed++; }
  };
  const bounds = { min: { ...sel.min }, max: { x: sel.min.x + nsx - 1, y: sel.min.y + nsy - 1, z: sel.min.z + nsz - 1 } };

  if (!hollow) {
    // Mode plein (historique) : flux cellule par cellule, mémoire légère.
    for (let j = 0; j < nsy; j++) for (let k = 0; k < nsz; k++) for (let i = 0; i < nsx; i++) {
      const after = sampled(i, j, k);
      writeCell(i, j, k, isAir(after) ? null : after);
    }
    return { blocksChanged: changed, bounds };
  }

  // Mode coque : on matérialise la grille agrandie, on retire l'intérieur (les
  // 6 voisins pleins ET dans les bornes), on n'écrit que la peau.
  const N = nsx * nsy * nsz;
  const idx = (i, j, k) => i + nsx * (k + nsz * j);
  const solidGrid = new Uint8Array(N);
  for (let j = 0; j < nsy; j++) for (let k = 0; k < nsz; k++) for (let i = 0; i < nsx; i++) {
    if (!isAir(sampled(i, j, k))) solidGrid[idx(i, j, k)] = 1;
  }
  const isSolid = (i, j, k) => i >= 0 && i < nsx && j >= 0 && j < nsy && k >= 0 && k < nsz && solidGrid[idx(i, j, k)] === 1;
  for (let j = 0; j < nsy; j++) for (let k = 0; k < nsz; k++) for (let i = 0; i < nsx; i++) {
    const after = sampled(i, j, k);
    if (isAir(after)) { writeCell(i, j, k, null); continue; }
    // intérieur = plein entouré de pleins (en bornes) → vidé ; sinon coque.
    const interior = isSolid(i - 1, j, k) && isSolid(i + 1, j, k)
      && isSolid(i, j - 1, k) && isSolid(i, j + 1, k)
      && isSolid(i, j, k - 1) && isSolid(i, j, k + 1);
    writeCell(i, j, k, interior ? null : after);
  }
  return { blocksChanged: changed, bounds };
}

// Ligne 3D entre les deux coins de la sélection (Bresenham).
export function opLine(vol, sel, { block }) {
  const b = toBlock(block); if (!b) throw new Error('bad_block');
  let x = sel.min.x, y = sel.min.y, z = sel.min.z;
  const x1 = sel.max.x, y1 = sel.max.y, z1 = sel.max.z;
  const dx = Math.abs(x1 - x), dy = Math.abs(y1 - y), dz = Math.abs(z1 - z);
  const sx = x <= x1 ? 1 : -1, sy = y <= y1 ? 1 : -1, sz = z <= z1 ? 1 : -1;
  let changed = 0;
  const put = (px, py, pz) => { if (!sameBlock(vol.getBlock(px, py, pz), b)) { vol.setBlock(px, py, pz, clone(b)); changed++; } };
  if (dx >= dy && dx >= dz) {
    let ey = dx / 2, ez = dx / 2;
    for (let i = 0; i <= dx; i++) { put(x, y, z); ey -= dy; if (ey < 0) { y += sy; ey += dx; } ez -= dz; if (ez < 0) { z += sz; ez += dx; } x += sx; }
  } else if (dy >= dx && dy >= dz) {
    let ex = dy / 2, ez = dy / 2;
    for (let i = 0; i <= dy; i++) { put(x, y, z); ex -= dx; if (ex < 0) { x += sx; ex += dy; } ez -= dz; if (ez < 0) { z += sz; ez += dy; } y += sy; }
  } else {
    let ex = dz / 2, ey = dz / 2;
    for (let i = 0; i <= dz; i++) { put(x, y, z); ex -= dx; if (ex < 0) { x += sx; ex += dz; } ey -= dy; if (ey < 0) { y += sy; ey += dz; } z += sz; }
  }
  return { blocksChanged: changed, bounds: sel };
}

// ── Tracé / route : chemin (droit ou courbe) entre les deux coins ────────────
// Chaque preset décrit la coupe transversale : `surface` (revêtement), `base`
// (couche dessous), `rail` (rambarde/garde-corps aux deux bords). « rail » comme
// surface pose des rails orientés selon la direction du tracé.
export const PATH_PRESETS = {
  dirt_path: { surface: 'minecraft:dirt_path', base: 'minecraft:dirt' },
  gravel: { surface: 'minecraft:gravel', base: 'minecraft:dirt' },
  cobblestone: { surface: 'minecraft:cobblestone' },
  stone_bricks: { surface: 'minecraft:stone_bricks' },
  planks: { surface: 'minecraft:oak_planks' },
  bridge: { surface: 'minecraft:oak_planks', rail: 'minecraft:oak_fence' },
  rail: { surface: 'minecraft:rail', base: 'minecraft:oak_planks' },
  fence: { rail: 'minecraft:oak_fence' },
};
export const PATH_PRESET_IDS = Object.keys(PATH_PRESETS);

// Échantillonne le tracé : droit (bow=0) ou courbe de Bézier quadratique dont le
// point de contrôle est le milieu décalé perpendiculairement (dans le plan XZ).
function samplePath(A, B, bow) {
  const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 };
  const dlen = Math.hypot(B.x - A.x, B.z - A.z) || 1;
  const perp = { x: -(B.z - A.z) / dlen, z: (B.x - A.x) / dlen };
  const C = { x: mid.x + perp.x * bow, y: mid.y, z: mid.z + perp.z * bow };
  const chord = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
  const steps = Math.max(2, Math.ceil((chord + Math.abs(bow)) * 2));
  const pts = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    if (!bow) { pts.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, z: A.z + (B.z - A.z) * t }); continue; }
    const u = 1 - t;
    pts.push({
      x: u * u * A.x + 2 * u * t * C.x + t * t * B.x,
      y: u * u * A.y + 2 * u * t * C.y + t * t * B.y,
      z: u * u * A.z + 2 * u * t * C.z + t * t * B.z,
    });
  }
  return pts;
}
function tangentAt(pts, s) {
  const a = pts[Math.max(0, s - 1)], b = pts[Math.min(pts.length - 1, s + 1)];
  const t = { x: b.x - a.x, z: b.z - a.z };
  const len = Math.hypot(t.x, t.z) || 1;
  return { x: t.x / len, z: t.z / len };
}

export function opPath(vol, sel, params) {
  const width = Math.max(1, Math.min(16, Math.round(params.width) || 1));
  const bow = Math.round(params.bow) || 0;
  const preset = PATH_PRESETS[params.preset] || PATH_PRESETS.dirt_path;
  const surfaceName = (params.block && params.block.name) || preset.surface || null;
  const isRailSurface = surfaceName === 'minecraft:rail';
  const surface = (surfaceName && !isRailSurface) ? { Name: surfaceName, Properties: params.block?.states || null } : null;
  const baseBlock = preset.base ? { Name: preset.base, Properties: null } : null;
  const railBlock = preset.rail ? { Name: preset.rail, Properties: null } : null;

  const A = sel.min, B = sel.max;
  const pts = samplePath(A, B, bow);
  let changed = 0;
  const mn = { x: Infinity, y: Infinity, z: Infinity }, mx = { x: -Infinity, y: -Infinity, z: -Infinity };
  const seen = new Set();
  const put = (x, y, z, b) => {
    if (!b) return;
    if (!sameBlock(vol.getBlock(x, y, z), b)) { vol.setBlock(x, y, z, clone(b)); changed++; }
    mn.x = Math.min(mn.x, x); mn.y = Math.min(mn.y, y); mn.z = Math.min(mn.z, z);
    mx.x = Math.max(mx.x, x); mx.y = Math.max(mx.y, y); mx.z = Math.max(mx.z, z);
  };
  for (let s = 0; s < pts.length; s++) {
    const p = pts[s];
    const t = tangentAt(pts, s);
    const perp = { x: -t.z, z: t.x };
    const railSurf = isRailSurface ? { Name: 'minecraft:rail', Properties: { shape: Math.abs(t.x) >= Math.abs(t.z) ? 'east_west' : 'north_south' } } : null;
    const half = (width - 1) / 2;
    for (let i = 0; i < width; i++) {
      const off = i - half;
      const cx = Math.round(p.x + perp.x * off);
      const cy = Math.round(p.y);
      const cz = Math.round(p.z + perp.z * off);
      const k = `${cx},${cy},${cz}`;
      if (!seen.has(k)) {
        seen.add(k);
        if (baseBlock) put(cx, cy - 1, cz, baseBlock);
        if (railSurf) put(cx, cy, cz, railSurf);
        else if (surface) put(cx, cy, cz, surface);
      }
      if (railBlock && (i === 0 || i === width - 1)) put(cx, cy + 1, cz, railBlock);
    }
  }
  if (!Number.isFinite(mn.x)) return { blocksChanged: 0, bounds: sel };
  return { blocksChanged: changed, bounds: { min: mn, max: mx } };
}

// Pyramide à base carrée inscrite dans la sélection (base au sol, sommet en haut).
export function opPyramid(vol, sel, { block, hollow }) {
  const b = toBlock(block); if (!b) throw new Error('bad_block');
  const cx = (sel.min.x + sel.max.x) / 2, cz = (sel.min.z + sel.max.z) / 2;
  const half = Math.min(sel.max.x - sel.min.x, sel.max.z - sel.min.z) / 2;
  const h = Math.max(1, sel.max.y - sel.min.y);
  let c = 0;
  for (let level = 0; level <= h; level++) {
    const r = half * (1 - level / h);
    if (r < 0) break;
    const y = sel.min.y + level;
    for (let z = sel.min.z; z <= sel.max.z; z++)
      for (let x = sel.min.x; x <= sel.max.x; x++) {
        if (Math.abs(x - cx) > r + 0.5 || Math.abs(z - cz) > r + 0.5) continue;
        if (hollow && level > 0 && Math.abs(x - cx) < r - 0.5 && Math.abs(z - cz) < r - 0.5) continue;
        if (!sameBlock(vol.getBlock(x, y, z), b)) { vol.setBlock(x, y, z, clone(b)); c++; }
      }
  }
  return { blocksChanged: c, bounds: sel };
}

// Cône : rayon décroissant avec la hauteur (base ronde au sol).
export function opCone(vol, sel, { block, hollow }) {
  const b = toBlock(block); if (!b) throw new Error('bad_block');
  const cx = (sel.min.x + sel.max.x) / 2, cz = (sel.min.z + sel.max.z) / 2;
  const baseR = Math.min(sel.max.x - sel.min.x, sel.max.z - sel.min.z) / 2;
  const h = Math.max(1, sel.max.y - sel.min.y);
  let c = 0;
  for (let level = 0; level <= h; level++) {
    const r = baseR * (1 - level / h);
    const r2 = (r + 0.5) * (r + 0.5), ri2 = (r - 0.5) * (r - 0.5);
    const y = sel.min.y + level;
    for (let z = sel.min.z; z <= sel.max.z; z++)
      for (let x = sel.min.x; x <= sel.max.x; x++) {
        const d2 = (x - cx) ** 2 + (z - cz) ** 2;
        if (d2 > r2 || (hollow && level > 0 && d2 < ri2)) continue;
        if (!sameBlock(vol.getBlock(x, y, z), b)) { vol.setBlock(x, y, z, clone(b)); c++; }
      }
  }
  return { blocksChanged: c, bounds: sel };
}

// Éroder : supprime les blocs pleins ayant ≥ `threshold` faces exposées à l'air.
export function opErode(vol, sel, { iterations, threshold }) {
  const iters = Math.max(1, Math.min(8, Math.round(iterations) || 1));
  const thr = Math.max(1, Math.min(6, Math.round(threshold) || 4));
  let changed = 0;
  for (let it = 0; it < iters; it++) {
    const rm = [];
    for (let y = sel.min.y; y <= sel.max.y; y++)
      for (let z = sel.min.z; z <= sel.max.z; z++)
        for (let x = sel.min.x; x <= sel.max.x; x++) {
          if (isAir(vol.getBlock(x, y, z))) continue;
          let air = 0;
          for (const [dx, dy, dz] of FACES6) if (isAir(vol.getBlock(x + dx, y + dy, z + dz))) air++;
          if (air >= thr) rm.push([x, y, z]);
        }
    for (const [x, y, z] of rm) vol.setBlock(x, y, z, null);
    changed += rm.length;
  }
  return { blocksChanged: changed, bounds: sel };
}

// Dilater : remplit les cases d'air ayant ≥ `threshold` voisins pleins, avec le
// bloc voisin majoritaire.
export function opDilate(vol, sel, { iterations, threshold }) {
  const iters = Math.max(1, Math.min(8, Math.round(iterations) || 1));
  const thr = Math.max(1, Math.min(6, Math.round(threshold) || 3));
  let changed = 0;
  for (let it = 0; it < iters; it++) {
    const add = [];
    for (let y = sel.min.y; y <= sel.max.y; y++)
      for (let z = sel.min.z; z <= sel.max.z; z++)
        for (let x = sel.min.x; x <= sel.max.x; x++) {
          if (!isAir(vol.getBlock(x, y, z))) continue;
          const counts = new Map(); let solid = 0;
          for (const [dx, dy, dz] of FACES6) {
            const nb = vol.getBlock(x + dx, y + dy, z + dz);
            if (!isAir(nb)) { solid++; counts.set(nb.Name, (counts.get(nb.Name) || 0) + 1); }
          }
          if (solid >= thr) {
            let best = null, bn = -1;
            for (const [k, n] of counts) if (n > bn) { bn = n; best = k; }
            add.push([x, y, z, best]);
          }
        }
    for (const [x, y, z, name] of add) vol.setBlock(x, y, z, { Name: name, Properties: null });
    changed += add.length;
  }
  return { blocksChanged: changed, bounds: sel };
}

// Drain : vide l'eau et la lave de la sélection (+ retire le waterlogged).
const FLUIDS = new Set(['minecraft:water', 'minecraft:lava', 'minecraft:flowing_water', 'minecraft:flowing_lava']);
export function opDrain(vol, sel) {
  let changed = 0;
  for (let y = sel.min.y; y <= sel.max.y; y++)
    for (let z = sel.min.z; z <= sel.max.z; z++)
      for (let x = sel.min.x; x <= sel.max.x; x++) {
        const b = vol.getBlock(x, y, z);
        if (isAir(b)) continue;
        if (FLUIDS.has(b.Name)) { vol.setBlock(x, y, z, null); changed++; }
        else if (b.Properties?.waterlogged === 'true') { vol.setBlock(x, y, z, { Name: b.Name, Properties: { ...b.Properties, waterlogged: 'false' } }); changed++; }
      }
  return { blocksChanged: changed, bounds: sel };
}

// paste → pose le presse-papier à `at` (coin min). mode overlay par défaut
// (l'air du presse-papier ne détruit pas l'existant).
export function opPaste(vol, clipboard, { at, mode = 'overlay' }) {
  const origin = { x: at.x, y: at.y, z: at.z };
  const changed = stampSchematic(vol, clipboard, origin, mode);
  return {
    blocksChanged: changed,
    bounds: { min: origin, max: { x: origin.x + clipboard.sx - 1, y: origin.y + clipboard.sy - 1, z: origin.z + clipboard.sz - 1 } },
  };
}

// ── Biome : peint le biome (cellule 4³) de la sélection ──────────────────────
export function opBiome(vol, sel, params) {
  if (typeof vol.setBiome !== 'function') throw new Error('biome_unsupported');
  const name = params.biome;
  if (!name) throw new Error('bad_biome');
  let changed = 0;
  // Pas de 4 blocs (granularité des biomes) — suffisant et bien plus léger.
  for (let y = sel.min.y; y <= sel.max.y; y += 4) {
    for (let z = sel.min.z; z <= sel.max.z; z += 4) {
      for (let x = sel.min.x; x <= sel.max.x; x += 4) {
        if (vol.setBiome(x, y, z, name)) changed++;
      }
    }
  }
  return { blocksChanged: changed, bounds: sel };
}

// ── Volume en mémoire (tests + petits builds) ────────────────────────────────
export class MemoryVolume {
  constructor() { this.map = new Map(); this.biomes = new Map(); }
  key(x, y, z) { return `${x},${y},${z}`; }
  getBlock(x, y, z) { return this.map.get(this.key(x, y, z)) || null; }
  setBlock(x, y, z, b) {
    const k = this.key(x, y, z);
    if (isAir(b)) this.map.delete(k); else this.map.set(k, b);
  }
  // Biome à la granularité 4³ (clé alignée sur la cellule).
  biomeKey(x, y, z) { return `${x >> 2},${y >> 2},${z >> 2}`; }
  getBiome(x, y, z) { return this.biomes.get(this.biomeKey(x, y, z)) || null; }
  setBiome(x, y, z, name) {
    const k = this.biomeKey(x, y, z);
    if (this.biomes.get(k) === name) return false;
    this.biomes.set(k, name); return true;
  }
}
