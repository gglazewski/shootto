// TextureAtlas.js — procedural Minecraft-style tile atlas.
//
// Tiles are generated as pure pixel arrays (no DOM), so the generator is unit
// testable in Node. The atlas canvas wrapper is kept tiny and three-dependent
// only at the final texture-creation step.

import { listBlockIds, tileFor } from '../engine/VoxelTypes.js';

export const TILE_SIZE = 16;export const ATLAS_WIDTH = 4; // tiles per row
export const ATLAS_HEIGHT = 5; // rows
export const ATLAS_TILES = ATLAS_WIDTH * ATLAS_HEIGHT;

/** Deterministic PRNG so textures are stable between runs. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, palette) => palette[Math.floor(rng() * palette.length)];

// --- tile generators: (x, y, size, rng) -> [r, g, b] ---

const grassTop = (x, y, s, rng) => pick(rng, [
  [106, 170, 64], [96, 158, 58], [118, 182, 74], [84, 138, 52], [140, 190, 90],
]);

const dirt = (x, y, s, rng) => pick(rng, [
  [134, 96, 67], [122, 86, 58], [146, 106, 76], [110, 76, 50],
]);

const grassSide = (x, y, s, rng) =>
  y < Math.floor(s * 0.28) ? grassTop(x, y, s, rng) : dirt(x, y, s, rng);

const sand = (x, y, s, rng) => pick(rng, [
  [219, 207, 163], [207, 193, 148], [228, 216, 174], [196, 182, 138],
]);

const concrete = (x, y, s, rng) => pick(rng, [
  [170, 170, 170], [160, 160, 160], [181, 181, 181], [150, 150, 150],
]);

// Vertical bark grain. Color is driven by the cross-grain axis (x = texture-u)
// so the streaks read as vertical lines once mapped onto a side face (whose
// texture-u is horizontal, via FACE_TABLE.tex rotation); y adds fiber detail.
const woodSide = (x, y, s, rng) => {
  const grain = Math.sin(x * 1.15 + 0.5) * 0.5 + 0.5;
  const fiber = Math.sin(x * 4.2 + y * 0.7) * 0.5 + 0.5;
  const fissure = Math.abs(Math.sin(x * 0.5 + 0.4)) < 0.07 ? 0.62 : 1.0;
  const n = (rng() - 0.5) * 16;
  const v = (140 + grain * 36 + fiber * 14 + n) * fissure;
  const c = Math.max(40, Math.min(235, v));
  return [c, c * 0.7, c * 0.4];
};

// Cross-section of a log: a dark bark band around the outside, concentric
// growth rings inside, brightest near the centre (the pith).
const woodTop = (x, y, s, rng) => {
  const cx = (s - 1) / 2, cy = (s - 1) / 2;
  const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
  const barkR = s * 0.4; // inscribed log radius; beyond this is bark
  const n = (rng() - 0.5) * 12;
  // outer bark band: dark, desaturated
  if (d > barkR) {
    const v = 96 + n;
    const c = Math.max(45, Math.min(190, v));
    return [c, c * 0.66, c * 0.34];
  }
  // inner heartwood: growth rings, brightest at the pith, darkening outward
  const ring = Math.sin(d * 2.0) * 0.5 + 0.5;
  const fade = 1 - d / barkR;
  const v = 152 + ring * 26 + fade * 44 + n;
  const c = Math.max(70, Math.min(245, v));
  return [c, c * 0.72, c * 0.4];
};

// Wooden planks (oak-floor style): four horizontal boards separated by a dark
// gap line, each board's top edge catches a little light, staggered vertical
// end-joints (brick-laid), horizontal grain plus fine fiber. Used on all faces.
const planks = (x, y, s, rng) => {
  const boardH = s >> 2;                          // 4 boards per tile
  const board = (y / boardH) | 0;
  const ly = y - board * boardH;
  // staggered vertical end-joint between adjacent boards
  const seamX = [0, 8, 4, 12][board & 3];
  if (x === seamX) return [88, 64, 38];
  // dark gap along each board's bottom edge
  if (ly === boardH - 1) return [104, 76, 48];
  // top edge of each board catches a little highlight
  const edge = ly === 0 ? 14 : 0;
  // per-board base tone variation
  const tone = [0, -12, 7, -5][board & 3];
  // horizontal grain (streaks run along the board) + one darker grain band
  const grain = Math.sin(ly * 2.2 + board * 1.3) * 0.5 + 0.5;
  const band = Math.sin(ly * 1.05 + board * 0.7) > 0.55 ? -16 : 0;
  const fiber = Math.sin(x * 1.5 + ly * 2.0) * 0.5 + 0.5;
  const n = (rng() - 0.5) * 8;
  const v = 168 + tone + edge + grain * 20 + band + fiber * 5 + n;
  const c = Math.max(40, Math.min(238, v));
  return [c, c * 0.7, c * 0.4];
};

const glass = (x, y, s, rng) => {
  const border = x === 0 || x === s - 1 || y === 0 || y === s - 1;
  if (border) return [214, 232, 242, 255];
  const sheen = (rng() - 0.5) * 24;
  return [130 + sheen, 185 + sheen, 225 + sheen, 90];
};

// Wrap a generator to shift its brightness (keeps alpha intact). Used to
// derive light/dark wood and plank variants from the base generators.
const shade = (gen, factor) => (x, y, s, rng) => {
  const [r, g, b, a] = gen(x, y, s, rng);
  return [r * factor, g * factor, b * factor, a];
};

const woodSideLight = shade(woodSide, 1.25);
const woodTopLight = shade(woodTop, 1.25);
const woodSideDark = shade(woodSide, 0.6);
const woodTopDark = shade(woodTop, 0.6);
const planksLight = shade(planks, 1.25);
const planksDark = shade(planks, 0.6);

const torchSide = (x, y, s, rng) => {
  const cx = s >> 1;
  const stickTop = Math.floor(s * 0.6);
  if (x >= cx - 1 && x <= cx + 1 && y < stickTop) {
    const v = 140 + (rng() - 0.5) * 24;
    return [v, v * 0.55, v * 0.22, 255];
  }
  const dx = Math.abs(x - cx);
  const dy = y - stickTop;
  if (dy >= 0 && dy < 4 && dx + dy <= 3) {
    const t = dy / 3;
    const r = 255 - t * 40;
    const g = 180 - t * 120;
    const b = 60 - t * 50;
    return [r, g, b, 255];
  }
  return [0, 0, 0, 0];
};

const torchTop = (x, y, s, rng) => {
  const cx = s >> 1, cy = s >> 1;
  if (Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1) {
    const j = (rng() - 0.5) * 30;
    return [255, 200 + j, 90, 255];
  }
  return [0, 0, 0, 0];
};

// --- registry (adding a tile name here makes it available to block defs) ---

const GENERATORS = Object.freeze({
  grass_top: grassTop,
  grass_side: grassSide,
  dirt,
  sand,
  concrete,
  wood_side: woodSide,
  wood_top: woodTop,
  wood_side_light: woodSideLight,
  wood_top_light: woodTopLight,
  wood_side_dark: woodSideDark,
  wood_top_dark: woodTopDark,
  planks,
  planks_light: planksLight,
  planks_dark: planksDark,
  glass,
  torch_top: torchTop,
  torch_side: torchSide,
});

/** Names of every registered tile, in deterministic order. */
export function listTileNames() {
  return Object.keys(GENERATORS);
}

/**
 * Pure: render a tile as a flat RGBA Uint8ClampedArray (TILE_SIZE^2 * 4).
 * @param {string} name
 * @param {number} [seed]
 */
export function generateTilePixels(name, seed = 1) {
  const gen = GENERATORS[name];
  if (!gen) throw new Error(`Unknown tile "${name}"`);
  const rng = mulberry32(seed);
  const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const [r, g, b, a = 255] = gen(x, y, TILE_SIZE, rng);
      const i = (y * TILE_SIZE + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return data;
}

/**
 * Pure: lay out tiles onto the atlas grid. Returns RGBA for the whole atlas
 * plus a map of tile name -> atlas index.
 * @param {string[]} names
 */
export function renderAtlasRGBA(names = listTileNames()) {
  const width = TILE_SIZE * ATLAS_WIDTH;
  const height = TILE_SIZE * ATLAS_HEIGHT;
  // Fill unused slots with an opaque neutral so accidental UV bleeding shows
  // as a flat color instead of black.
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const map = new Map();
  let index = 0;
  for (const name of names) {
    if (map.has(name)) continue;
    const tile = generateTilePixels(name);
    const tx = index % ATLAS_WIDTH, ty = Math.floor(index / ATLAS_WIDTH);
    const ox = tx * TILE_SIZE, oy = ty * TILE_SIZE;
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const src = (y * TILE_SIZE + x) * 4;
        const dst = ((oy + y) * width + (ox + x)) * 4;
        data[dst] = tile[src];
        data[dst + 1] = tile[src + 1];
        data[dst + 2] = tile[src + 2];
        data[dst + 3] = tile[src + 3];
      }
    }
    map.set(name, index);
    index++;
  }
  return { width, height, data, map, atlas: { width: ATLAS_WIDTH, height: ATLAS_HEIGHT } };
}

/** Names of every tile referenced by registered block definitions. */
export function tilesForBlocks() {
  const names = new Set();
  for (const id of listBlockIds()) {
    for (const face of ['py', 'ny', 'px', 'nx', 'pz', 'nz']) {
      const t = tileFor(id, face);
      if (t) names.add(t);
    }
  }
  return [...names];
}
