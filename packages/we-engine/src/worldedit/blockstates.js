// Transformation des ÉTATS de blocs (Properties NBT) sous miroir / rotation.
//
// Repère : +X = Est, +Z = Sud, +Y = Haut. Rotations exprimées en quarts de tour
// horaires (vus de dessus) : quart 1 = 90° CW → north→east→south→west→north.
//
// Spec de référence : docs/worldedit-audit.md + l'annexe du cahier des charges.
// Chaque règle est couverte par un test unitaire (test/worldedit.test.js).

const CARDINALS = ['north', 'east', 'south', 'west'];

// facing horizontal : rotation de `q` quarts horaires. up/down inchangés.
function rotateFacing(dir, q) {
  const i = CARDINALS.indexOf(dir);
  if (i < 0) return dir; // up / down / autre
  return CARDINALS[(i + q) % 4];
}

function mirrorFacing(dir, axis) {
  if (axis === 'x') return dir === 'east' ? 'west' : dir === 'west' ? 'east' : dir;
  if (axis === 'z') return dir === 'north' ? 'south' : dir === 'south' ? 'north' : dir;
  if (axis === 'y') return dir === 'up' ? 'down' : dir === 'down' ? 'up' : dir;
  return dir;
}

// Escaliers : shape ∈ {straight, inner_left, inner_right, outer_left, outer_right}.
const STAIR_SHAPES = new Set(['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right']);
function mirrorStairShape(shape) {
  // Toute réflexion inverse la chiralité (gauche↔droite).
  return shape
    .replace('left', '\0').replace('right', 'left').replace('\0', 'right');
}

// Rails : shape ∈ droites/montées/courbes.
const RAIL_SHAPES = new Set([
  'north_south', 'east_west', 'ascending_east', 'ascending_west',
  'ascending_north', 'ascending_south', 'south_east', 'south_west', 'north_west', 'north_east',
]);
const RAIL_ROT90 = {
  north_south: 'east_west', east_west: 'north_south',
  ascending_east: 'ascending_south', ascending_south: 'ascending_west',
  ascending_west: 'ascending_north', ascending_north: 'ascending_east',
  south_east: 'south_west', south_west: 'north_west', north_west: 'north_east', north_east: 'south_east',
};
const RAIL_MIRROR_X = {
  ascending_east: 'ascending_west', ascending_west: 'ascending_east',
  south_east: 'south_west', south_west: 'south_east', north_east: 'north_west', north_west: 'north_east',
};
const RAIL_MIRROR_Z = {
  ascending_north: 'ascending_south', ascending_south: 'ascending_north',
  north_east: 'south_east', south_east: 'north_east', north_west: 'south_west', south_west: 'north_west',
};
function railRotate(shape, q) { let s = shape; for (let i = 0; i < q; i++) s = RAIL_ROT90[s] || s; return s; }
function railMirror(shape, axis) {
  if (axis === 'x') return RAIL_MIRROR_X[shape] || shape;
  if (axis === 'z') return RAIL_MIRROR_Z[shape] || shape;
  return shape;
}

// Remappe les propriétés cardinales de connexion (north/east/south/west présents
// comme CLÉS : barreaux, redstone, vignes, feu, champignons…).
function remapCardinalKeys(props, mapKey) {
  if (!CARDINALS.some((c) => c in props)) return props;
  const out = { ...props };
  for (const d of CARDINALS) if (d in props) delete out[d];
  for (const d of CARDINALS) {
    if (d in props) out[mapKey(d)] = props[d];
  }
  return out;
}

// op = { kind:'mirror', axis:'x'|'y'|'z' } | { kind:'rotate', quarts:1|2|3 }
export function transformProperties(props, op) {
  if (!props) return null;
  let p = { ...props };

  const setIf = (k, fn) => { if (k in p) p[k] = fn(p[k]); };

  if (op.kind === 'rotate') {
    const q = ((op.quarts % 4) + 4) % 4;
    if (q === 0) return props;
    setIf('facing', (v) => rotateFacing(v, q));
    setIf('rotation', (v) => String((Number(v) + 4 * q) % 16));
    setIf('axis', (v) => (q % 2 === 1 ? (v === 'x' ? 'z' : v === 'z' ? 'x' : v) : v));
    setIf('shape', (v) => (RAIL_SHAPES.has(v) ? railRotate(v, q) : v)); // escaliers : shape inchangé
    p = remapCardinalKeys(p, (d) => rotateFacing(d, q));
    return p;
  }

  // miroir
  const axis = op.axis;
  setIf('facing', (v) => mirrorFacing(v, axis));
  if (axis === 'x' || axis === 'z') {
    setIf('rotation', (v) => String(((axis === 'x' ? 16 : 8) - Number(v) + 16) % 16));
    setIf('hinge', (v) => (v === 'left' ? 'right' : v === 'right' ? 'left' : v));
    setIf('shape', (v) => (RAIL_SHAPES.has(v) ? railMirror(v, axis)
      : STAIR_SHAPES.has(v) ? mirrorStairShape(v) : v));
    p = remapCardinalKeys(p, (d) => mirrorFacing(d, axis));
  } else if (axis === 'y') {
    setIf('half', (v) => (v === 'top' ? 'bottom' : v === 'bottom' ? 'top'
      : v === 'upper' ? 'lower' : v === 'lower' ? 'upper' : v));
    setIf('type', (v) => (v === 'top' ? 'bottom' : v === 'bottom' ? 'top' : v)); // dalle (double inchangé)
  }
  return p;
}

// Blocs qui ne se retournent pas proprement à la verticale (miroir Y) : on les
// laisse intacts plutôt que de produire un état incohérent. Liste blanche
// inverse (on REFUSE le flip d'état pour ces familles).
const Y_MIRROR_UNSAFE = [/_door$/, /_bed$/, /banner$/, /_sign$/, /head$/, /skull$/];
export function isYMirrorSafe(name) {
  return !Y_MIRROR_UNSAFE.some((re) => re.test(name));
}

export const __test = { rotateFacing, mirrorFacing, mirrorStairShape, railRotate, railMirror };
