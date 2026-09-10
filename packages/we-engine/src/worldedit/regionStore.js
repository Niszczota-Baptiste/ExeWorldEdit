import nbt from 'prismarine-nbt';
import {
  readRegion, writeRegion, decodeChunk, chunkSections, readSection, encodeBlockStates,
  localIndex, SECTION_VOLUME, decodeBiomes, encodeBiomes, biomeLocalIndex,
} from '../anvil/index.js';

// RegionStore : présente un ensemble de régions .mca comme un VOLUME adressable
// en coordonnées monde (interface getBlock/setBlock attendue par transform.js).
//
// Chargement paresseux : `warmup(bbox)` décode les chunks/sections qui
// intersectent la boîte ; ensuite get/setBlock sont synchrones. Les sections
// modifiées sont réencodées au `commit()`, qui renvoie les buffers des régions
// touchées (à écrire sur le staging). Hors des chunks chargés, setBlock lève
// `out_of_bounds` (on ne fabrique pas de chunk ex nihilo).

const AIR_NAMES = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);
const AIR = { Name: 'minecraft:air', Properties: null };
const fdiv = (a, b) => Math.floor(a / b);
const fmod = (a, b) => ((a % b) + b) % b;
const isAir = (b) => !b || AIR_NAMES.has(b.Name);
const propsKey = (p) => {
  if (!p) return '';
  const ks = Object.keys(p);
  if (ks.length === 0) return '';
  if (ks.length === 1) return `${ks[0]}=${p[ks[0]]}`;
  ks.sort();
  let out = '';
  for (let i = 0; i < ks.length; i++) out += `${i ? ',' : ''}${ks[i]}=${p[ks[i]]}`;
  return out;
};

/**
 * Clé d'identité d'un bloc dans une palette de section.
 *
 * Un bloc SANS état rend son nom tel quel : pas de concaténation, donc pas
 * d'allocation. C'est le cas de l'écrasante majorité des blocs d'un build
 * (pierre, terre, cobble…), et `propsKey` pesait encore 18 % de l'écriture
 * après le reste des optimisations.
 *
 * Les deux formes ne peuvent pas se confondre : un nom Minecraft est
 * `namespace:id` et ne contient jamais de barre verticale, donc « avec état »
 * en contient toujours une et « sans état » jamais.
 */
const entryKey = (name, props) => {
  const k = propsKey(props);
  // `{}` et `null` doivent rendre la MÊME clé, sinon un bloc sans état
  // décrit des deux façons occuperait deux entrées de palette.
  return k ? `${name}|${k}` : name;
};

/**
 * Index « clé de palette → position », construit une fois par section et tenu à
 * jour à chaque ajout.
 *
 * Avant, `setBlock` faisait un `findIndex` qui REFABRIQUAIT la clé texte de
 * chaque entrée de palette, à chaque bloc : mesuré au profileur, 44 % du temps
 * d'écriture partait là (`propsKey` 22 %, le rappel du `findIndex` 14 %, plus
 * le ramasse-miettes qui suivait). L'index ramène ça à une clé construite et
 * une recherche par bloc.
 *
 * `grid.palette` n'est modifiée qu'ici (vérifié) : l'index ne peut pas se
 * désynchroniser tant que ça reste vrai.
 */
function paletteIndex(grid) {
  let idx = grid.index;
  if (!idx) {
    idx = new Map();
    for (let i = 0; i < grid.palette.length; i++) {
      const e = grid.palette[i];
      idx.set(entryKey(e.Name, e.Properties), i);
    }
    grid.index = idx;
  }
  return idx;
}

export class RegionStore {
  // sources = [{ regionX, regionZ, buffer }]
  constructor(sources) {
    this.regions = new Map(); // "rx,rz" -> { region, chunks:Map("cx,cz"->rec) }
    this.sources = sources;
    this._memo = null; // dernière section résolue (voir `_resolve`)
    for (const s of sources) {
      this.regions.set(`${s.regionX},${s.regionZ}`, {
        regionX: s.regionX, regionZ: s.regionZ,
        region: readRegion(s.buffer, s.regionX, s.regionZ),
        chunks: null, // construit au warmup
        dirty: false,
      });
    }
  }

  _regionAt(cx, cz) {
    return this.regions.get(`${fdiv(cx, 32)},${fdiv(cz, 32)}`) || null;
  }

  // Décode les chunks/sections intersectant la boîte (coords monde, inclusive).
  async warmup(bbox) {
    // Le warmup peuple `rec.sections` : ce que le mémo tenait avant peut ne
    // plus être la bonne instance.
    this._forgetMemo();
    const cminX = fdiv(bbox.min.x, 16), cmaxX = fdiv(bbox.max.x, 16);
    const cminZ = fdiv(bbox.min.z, 16), cmaxZ = fdiv(bbox.max.z, 16);
    for (const r of this.regions.values()) {
      if (!r.chunks) {
        r.chunks = new Map();
        for (const chunk of r.region.chunks) r.chunks.set(`${chunk.chunkX},${chunk.chunkZ}`, { chunk, sections: null });
      }
      for (let cz = cminZ; cz <= cmaxZ; cz++) {
        for (let cx = cminX; cx <= cmaxX; cx++) {
          if (fdiv(cx, 32) !== r.regionX || fdiv(cz, 32) !== r.regionZ) continue;
          const rec = r.chunks.get(`${cx},${cz}`);
          if (rec) await this._decodeChunk(rec);
        }
      }
    }
  }

  async _decodeChunk(rec) {
    if (rec.sections) return rec;
    await decodeChunk(rec.chunk);
    const root = rec.chunk.root;
    rec.list = root?.value?.sections?.value?.value || null; // tableau tagué (insertion)
    rec.sections = new Map();
    for (const { Y, comp } of chunkSections(rec.chunk)) {
      // biomes : décodés à la demande (lazily) lors d'un premier accès biome.
      rec.sections.set(Y, { comp, grid: readSection(comp), biomes: null, dirty: false, biomesDirty: false, isNew: false });
    }
    return rec;
  }

  _chunkRec(cx, cz) {
    const r = this._regionAt(cx, cz);
    if (!r || !r.chunks) return null;
    return r.chunks.get(`${cx},${cz}`) || null;
  }

  /**
   * Résout (chunk, section, région) d'un coup, avec mémo d'UNE case.
   *
   * Les opérations parcourent en YZX : x varie le plus vite, donc seize blocs
   * consécutifs tombent dans la même section. Sans mémo, chacun refait deux
   * recherches sur des clés texte fabriquées à la volée — 12 % du temps
   * d'écriture au profileur. Une seule case suffit à absorber ça.
   *
   * On ne mémorise que les succès : un échec (section absente, `create` faux)
   * ne doit pas empêcher une création ultérieure de la trouver.
   */
  _resolve(cx, cz, sy, create = false) {
    const m = this._memo;
    if (m !== null && m.cx === cx && m.cz === cz && m.sy === sy) return m;

    const region = this._regionAt(cx, cz);
    if (!region || !region.chunks) return null;
    const rec = region.chunks.get(`${cx},${cz}`);
    if (!rec || !rec.sections) return null;

    let sec = rec.sections.get(sy);
    if (!sec && create) {
      sec = {
        comp: { Y: { type: 'byte', value: sy }, block_states: encodeBlockStates({ palette: [AIR], indices: new Uint16Array(SECTION_VOLUME) }) },
        grid: { palette: [{ ...AIR }], indices: new Uint16Array(SECTION_VOLUME) },
        dirty: false, isNew: true,
      };
      rec.sections.set(sy, sec);
    }
    if (!sec) return null;

    const hit = { cx, cz, sy, sec, rec, region };
    this._memo = hit;
    return hit;
  }

  /** Le mémo devient faux dès qu'on remplace des sections. */
  _forgetMemo() { this._memo = null; }

  _section(cx, cz, sy, create = false) {
    return this._resolve(cx, cz, sy, create)?.sec || null;
  }

  getBlock(x, y, z) {
    const sec = this._section(fdiv(x, 16), fdiv(z, 16), fdiv(y, 16), false);
    if (!sec) return null;
    const i = localIndex(fmod(x, 16), fmod(y, 16), fmod(z, 16));
    const b = sec.grid.palette[sec.grid.indices[i]];
    return isAir(b) ? null : { Name: b.Name, Properties: b.Properties ? { ...b.Properties } : null };
  }

  setBlock(x, y, z, block) {
    // Hors des chunks chargés (= hors du build) : on ignore l'écriture (clamp).
    // Le warmup couvre tout le build, donc seuls les débordements stack/sphère
    // au-delà des régions existantes sont concernés.
    const hit = this._resolve(fdiv(x, 16), fdiv(z, 16), fdiv(y, 16), true);
    if (!hit) return;
    const { sec, rec, region } = hit;

    const entry = isAir(block) ? AIR : { Name: block.Name, Properties: block.Properties || null };
    const key = entryKey(entry.Name, entry.Properties);
    const idx = paletteIndex(sec.grid);
    let pi = idx.get(key);
    if (pi === undefined) {
      pi = sec.grid.palette.length;
      sec.grid.palette.push(entry);
      idx.set(key, pi);
    }

    const i = localIndex(fmod(x, 16), fmod(y, 16), fmod(z, 16));
    if (sec.grid.indices[i] === pi) return;
    sec.grid.indices[i] = pi;
    sec.dirty = true;
    rec.dirty = true;
    region.dirty = true;
  }

  // Décode (paresseusement) la grille de biomes 4³ d'une section.
  _biomes(sec) {
    if (sec.biomes) return sec.biomes;
    const raw = sec.comp?.biomes ? nbt.simplify(sec.comp.biomes) : null;
    sec.biomes = decodeBiomes(raw || {});
    return sec.biomes;
  }

  getBiome(x, y, z) {
    const sec = this._section(fdiv(x, 16), fdiv(z, 16), fdiv(y, 16), false);
    if (!sec) return null;
    const bi = this._biomes(sec);
    const ci = biomeLocalIndex((fmod(x, 16)) >> 2, (fmod(y, 16)) >> 2, (fmod(z, 16)) >> 2);
    return bi.palette[bi.indices[ci]] || null;
  }

  // Peint le biome de la cellule 4³ contenant (x,y,z). Renvoie true si changé.
  setBiome(x, y, z, name) {
    const cx = fdiv(x, 16), cz = fdiv(z, 16);
    const rec = this._chunkRec(cx, cz);
    if (!rec || !rec.sections) return false;
    // On ne peint que les sections existantes (pas de section d'air créée pour
    // un biome dans le vide → évite de gonfler le fichier).
    const sec = this._section(cx, cz, fdiv(y, 16), false);
    if (!sec) return false;
    const bi = this._biomes(sec);
    let pi = bi.palette.indexOf(name);
    if (pi < 0) { pi = bi.palette.length; bi.palette.push(name); }
    const ci = biomeLocalIndex((fmod(x, 16)) >> 2, (fmod(y, 16)) >> 2, (fmod(z, 16)) >> 2);
    if (bi.indices[ci] === pi) return false;
    bi.indices[ci] = pi;
    sec.biomesDirty = true;
    rec.dirty = true;
    this._regionAt(cx, cz).dirty = true;
    return true;
  }

  // Réencode les sections modifiées et renvoie Map("rx,rz" -> Buffer) des régions
  // touchées. `touchedOnly` limite la sortie aux régions dirty.
  commit({ touchedOnly = true } = {}) {
    const out = new Map();
    for (const r of this.regions.values()) {
      if (touchedOnly && !r.dirty) continue;
      if (r.chunks) {
        for (const rec of r.chunks.values()) {
          if (!rec.sections) continue;
          let mutated = false;
          for (const sec of rec.sections.values()) {
            if (!sec.dirty && !sec.biomesDirty && !sec.isNew) continue;
            if (sec.dirty || sec.isNew) sec.comp.block_states = encodeBlockStates(sec.grid);
            if (sec.biomesDirty && sec.biomes) { sec.comp.biomes = encodeBiomes(sec.biomes); sec.biomesDirty = false; }
            if (sec.isNew && rec.list) { rec.list.push(sec.comp); sec.isNew = false; }
            sec.dirty = false;
            mutated = true;
          }
          if (mutated) rec.chunk.dirty = true;
        }
      }
      out.set(`${r.regionX},${r.regionZ}`, writeRegion(r.region));
    }
    return out;
  }

  // Re-dérive l'artefact sparse (même format que minecraftWorld/parse.js) pour
  // l'aperçu. Itère les sections déjà chargées (non-air only) — JAMAIS cellule
  // par cellule sur toute la boîte (qui peut compter des milliards de cases).
  // Suppose un warmup couvrant `bbox`.
  // `truncate` : au lieu de lever `too_many_blocks` au-delà de `maxBlocks`, on
  // arrête et on renvoie un aperçu PARTIEL (`truncated: true`). Sert aux grosses
  // opérations : la commande écrit tout le .mca, l'aperçu n'en montre qu'une part.
  deriveSparse(bbox, maxBlocks = 5_000_000, { truncate = false } = {}) {
    const palette = [];
    const index = new Map();
    const counts = new Map();
    const blocks = [];
    let count = 0;
    let truncated = false;
    const idxOf = (name, props) => {
      const key = `${name}|${propsKey(props)}`;
      let i = index.get(key);
      if (i === undefined) { i = palette.length; palette.push({ name, props: props || null }); index.set(key, i); }
      return i;
    };
    outer:
    for (const r of this.regions.values()) {
      if (!r.chunks) continue;
      for (const rec of r.chunks.values()) {
        if (!rec.sections) continue;
        const baseX = rec.chunk.chunkX * 16;
        const baseZ = rec.chunk.chunkZ * 16;
        if (baseX > bbox.max.x || baseX + 15 < bbox.min.x) continue;
        if (baseZ > bbox.max.z || baseZ + 15 < bbox.min.z) continue;
        for (const [sy, sec] of rec.sections) {
          const baseY = sy * 16;
          if (baseY > bbox.max.y || baseY + 15 < bbox.min.y) continue;
          const { palette: pal, indices } = sec.grid;
          for (let n = 0; n < SECTION_VOLUME; n++) {
            const e = pal[indices[n]];
            if (isAir(e)) continue;
            const x = baseX + (n & 15);
            const z = baseZ + ((n >> 4) & 15);
            const y = baseY + ((n >> 8) & 15);
            if (x < bbox.min.x || x > bbox.max.x || y < bbox.min.y || y > bbox.max.y || z < bbox.min.z || z > bbox.max.z) continue;
            if (count >= maxBlocks) {
              if (truncate) { truncated = true; break outer; }
              throw new Error('too_many_blocks');
            }
            blocks.push(x - bbox.min.x, y - bbox.min.y, z - bbox.min.z, idxOf(e.Name, e.Properties));
            counts.set(e.Name, (counts.get(e.Name) || 0) + 1);
            count++;
          }
        }
      }
    }
    const bom = [...counts.entries()].map(([blockId, c]) => ({ blockId, count: c })).sort((a, b) => b.count - a.count);
    return {
      palette, blocks, bom, count, truncated,
      min: { x: bbox.min.x, y: bbox.min.y, z: bbox.min.z },
      size: { x: bbox.max.x - bbox.min.x + 1, y: bbox.max.y - bbox.min.y + 1, z: bbox.max.z - bbox.min.z + 1 },
    };
  }
}
