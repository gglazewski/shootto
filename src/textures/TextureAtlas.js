// TextureAtlas.js — procedural Minecraft-style tile atlas.
//
// Tiles are generated as pure pixel arrays (no DOM), so the generator is unit
// testable in Node. The atlas canvas wrapper is kept tiny and three-dependent
// only at the final texture-creation step.

import { listBlockIds, tileFor, listDecalIds, getDecal } from '../engine/VoxelTypes.js';

export const TILE_SIZE = 16;export const ATLAS_WIDTH = 8; // tiles per row
export const ATLAS_HEIGHT = 14; // rows (small tiles + multi-slot decal art)
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

// Position hash in [0,1): stable pseudo-random value per (x,y) pixel (or per
// coarse cell when the coords are pre-divided), independent of scan order.
const hash2 = (x, y) => {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

const stone = (x, y, s, rng) => {
  const mottle = Math.sin(x * 0.9 + y * 1.7) * 8 + Math.sin(x * 2.3 - y * 0.6) * 5;
  const n = (rng() - 0.5) * 18;
  if (hash2(x, y) < 0.05) return [92, 92, 96]; // dark chips
  const v = Math.max(95, Math.min(165, 130 + mottle + n));
  return [v, v, v * 1.03];
};

const gravel = (x, y, s, rng) => {
  // coarse 2x2 pebbles, each a stable random tone; rng adds fine grit
  const tone = hash2(x >> 1, y >> 1);
  const base = [
    [132, 127, 120], [110, 106, 100], [147, 142, 133], [96, 92, 88], [124, 111, 95],
  ][Math.floor(tone * 5)];
  const n = (rng() - 0.5) * 10;
  return [base[0] + n, base[1] + n, base[2] + n];
};

const asphalt = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 12;
  if (hash2(x, y) < 0.06) return [92, 92, 94]; // light aggregate specks
  const v = Math.max(44, Math.min(74, 58 + n));
  return [v, v, v + 2];
};

// Asphalt with a worn white lane line down the tile's center (use on py).
// White, not yellow — Polish road markings.
const asphaltLine = (x, y, s, rng) => {
  const mid = s >> 1;
  if ((x === mid - 1 || x === mid) && hash2(x, y) > 0.18) {
    const n = (rng() - 0.5) * 26;
    return [216 + n, 218 + n, 220 + n];
  }
  return asphalt(x, y, s, rng);
};

// Quarter-turn of the lane line: a 90° arc connecting the line entering one
// edge to the line leaving the adjacent edge. R rotates it for all corners.
const asphaltCorner = (x, y, s, rng) => {
  const d = Math.hypot(s - 0.5 - x, s - 0.5 - y);
  if (Math.abs(d - (s / 2)) < 1.1 && hash2(x, y) > 0.18) {
    const n = (rng() - 0.5) * 26;
    return [216 + n, 218 + n, 220 + n];
  }
  return asphalt(x, y, s, rng);
};

// Painted curb side: alternating red/white segments, grimy toward the base.
const curbSide = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 16;
  const red = ((x >> 3) & 1) === 0;
  const grime = y > s - 4 ? -34 : y > s - 6 ? -14 : 0;
  if (red) return [186 + grime + n, 52 + grime * 0.4, 46];
  return [216 + grime + n, 212 + grime + n, 206 + grime + n];
};

// Curb top: the paint wraps over the edge — same alternating segments,
// lightly worn, so the top matches the sides (R aligns the direction).
const curbTop = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 16;
  if (hash2(x, y) < 0.08) return concrete(x, y, s, rng); // chipped paint
  const red = ((x >> 3) & 1) === 0;
  if (red) return [178 + n, 54, 48];
  return [208 + n, 204 + n, 198 + n];
};

// Gas-station canopy panel: near-white sheet metal with seam lines.
const canopy = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 8;
  if ((x & 7) === 7) return [178 + n, 181 + n, 186 + n]; // panel seams
  const shade = (x & 7) === 0 ? 8 : 0;                   // lit seam edge
  return [222 + shade + n, 225 + shade + n, 230 + shade + n];
};

// Canopy brand band: white fascia with a bold red stripe (Orlen-style).
const canopyTrim = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 10;
  if (y >= 4 && y <= 11) return [198 + n, 34, 38];
  return [224 + n, 226 + n, 230 + n];
};

// Shop floor: glossy 8px tiles with gray grout, the odd tile dirtier.
const tileFloor = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 8;
  if ((x & 7) === 7 || (y & 7) === 7) return [168 + n, 168 + n, 166 + n]; // grout
  const dirty = hash2(x >> 3, y >> 3) < 0.25 ? -26 : 0;
  const check = (((x >> 3) + (y >> 3)) & 1) ? -8 : 0;
  const sheen = x - (x & 7) / 2 === y ? 10 : 0;
  return [214 + dirty + check + sheen + n, 213 + dirty + check + n, 206 + dirty + check + n];
};

// Dirty-white plaster: flat field with faint vertical grime streaks.
const plaster = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 10;
  const streak = hash2(x, 3) < 0.22 ? -16 - hash2(x, y) * 14 : 0;
  const base = 204 + streak + n;
  return [base, base - 3, base - 10];
};

// Roller shutter: horizontal galvanized slats with dark grooves.
const shutter = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 10;
  const p = y % 3;
  if (p === 2) return [96 + n, 99 + n, 104 + n];   // groove
  const v = p === 0 ? 172 : 148;                   // lit top / shaded bottom
  if (hash2(x, y) < 0.03) return [124, 86, 58];    // rust flecks
  return [v + n, v + 3 + n, v + 8 + n];
};

// Flat ceiling light panel: bright cool-white field in a dark frame. The
// block def marks it emissive (light 15) — the canopy light.
const lamp = (x, y, s, rng) => {
  if (x === 0 || x === s - 1 || y === 0 || y === s - 1) return [88, 92, 98];
  const edge = x === 1 || x === s - 2 || y === 1 || y === s - 2 ? -22 : 0;
  const n = (rng() - 0.5) * 8;
  return [236 + edge + n, 240 + edge + n, 246 + edge + n];
};

// Red neon block: glowing tube core with darker housing rows (light 9).
const neonRed = (x, y, s, rng) => {
  const band = Math.abs(y - (s >> 1)) // distance from the tube's center line
  const n = (rng() - 0.5) * 14;
  if (band <= 1) return [252, 96 + n, 84];
  if (band <= 3) return [204 + n, 48, 44];
  return [72 + n, 26, 26];
};

// Dark phases: the fixture with the light out (the blinking variants' lit
// phase reuses the normal lamp / neon tiles).
const lampOff = (x, y, s, rng) => {
  if (x === 0 || x === s - 1 || y === 0 || y === s - 1) return [72, 76, 82];
  const n = (rng() - 0.5) * 8;
  return [128 + n, 132 + n, 138 + n];
};

const neonOff = (x, y, s, rng) => {
  const band = Math.abs(y - (s >> 1));
  const n = (rng() - 0.5) * 10;
  if (band <= 1) return [116 + n, 52, 48]; // cold tube
  if (band <= 3) return [84 + n, 36, 34];
  return [52 + n, 22, 22];
};

const brick = (x, y, s, rng) => {
  const row = y >> 2;                     // 4px-high courses
  const off = (row & 1) ? 4 : 0;          // running bond stagger
  const mortar = (y & 3) === 3 || ((x + off) & 7) === 7;
  if (mortar) {
    const n = (rng() - 0.5) * 10;
    return [166 + n, 158 + n, 150 + n];
  }
  const tone = [0, -14, 10, -6][(row + ((x + off) >> 3)) & 3];
  const n = (rng() - 0.5) * 14;
  return [152 + tone + n, 64 + tone * 0.5 + n * 0.5, 50 + n * 0.4];
};

// --- decal tiles (alpha 0 = the block face shows through) ---

// Dried blood splatter: one main blob plus satellite drops.
const decalBlood = (x, y, s, rng) => {
  const d = Math.hypot(x - 10, y - 6);
  const blob = d < 3.2 + hash2(x, y) * 1.6;
  const drop = hash2(x, y) < 0.05 && d < 7.5;
  if (blob || drop) {
    const n = (rng() - 0.5) * 26;
    return [104 + n, 18, 14, 255];
  }
  return [0, 0, 0, 0];
};

// Blood runs: an impact blot with streaks bleeding down the face — reads as
// a sprayed wall, so the game favors it for vertical surfaces.
const decalBlood2 = (x, y, s, rng) => {
  const d = Math.hypot((x - 8) * 1.1, (y - 4) * 1.4);
  const blob = d < 2.8 + hash2(x, y) * 1.4;
  let run = false;
  for (const [rx, len] of [[5, 6], [8, 10], [11, 4]]) {
    if (Math.abs(x - rx) < 0.9 && y >= 4 && y < 4 + len && hash2(rx * 3, y) < 0.85) run = true;
  }
  if (blob || run) {
    const n = (rng() - 0.5) * 26;
    return [104 + n, 18, 14, 255];
  }
  return [0, 0, 0, 0];
};

// Blood mist: a fine cone of specks — the fringe of a spray that mostly
// missed — densest toward the off-center core.
const decalBlood3 = (x, y, s, rng) => {
  const d = Math.hypot(x - 6, (y - 8) * 1.1);
  if (hash2(x, y) < 0.55 - d * 0.055) {
    const n = (rng() - 0.5) * 30;
    return [112 + n, 22, 16, 255];
  }
  return [0, 0, 0, 0];
};

// 32x32 blood pool poured under a kill: an irregular coagulated puddle,
// darker and wetter toward the middle, with stray drops past the rim.
const decalBloodPool = (x, y, s, rng) => {
  const c = s / 2;
  const d = Math.hypot((x - c) * 1.05, (y - c) * 1.25) + hash2(x, y) * 2.6;
  if (d > s * 0.42) {
    if (d < s * 0.55 && hash2(x * 3, y * 3) < 0.04) return [96, 16, 12, 255];
    return [0, 0, 0, 0];
  }
  const core = 1 - d / (s * 0.42);
  const n = (rng() - 0.5) * 18;
  return [88 - core * 18 + n, 14, 11, 255];
};

// Wandering vertical crack with a short diagonal side-crack: a dark core
// line with a lighter chipped edge alongside it.
const decalCrack = (x, y, s, rng) => {
  const wander = (s >> 1) + Math.sin(y * 0.55) * 2.2;
  const main = Math.abs(x - wander) < 0.8;
  const side = y > 6 && y < 12 && Math.abs(x - (wander - (y - 6))) < 0.8;
  if (main || side) return [52, 50, 48, 255];
  const edge = Math.abs(x - wander) < 1.6 || (y > 6 && y < 12 && Math.abs(x - (wander - (y - 6))) < 1.6);
  if (edge && hash2(x, y) < 0.4) return [150, 148, 145, 255];
  return [0, 0, 0, 0];
};

// A discarded piece of clothing: a crumpled fabric pile with fold shadows
// and a sleeve trailing off to the side.
const decalClothes = (x, y, s, rng) => {
  const d = Math.hypot((x - 7) * 1.15, (y - 9) * 1.5);
  const sleeve = y > 3 && y < 7 && Math.abs(x - (10 + (y - 3) * 0.8)) < 1.4;
  if (d > 5.2 + hash2(x, y) * 1.5 && !sleeve) return [0, 0, 0, 0];
  const fold = Math.sin(x * 1.3 + y * 2.1) * 0.5 + 0.5;
  const n = (rng() - 0.5) * 14;
  return [56 + fold * 26 + n, 84 + fold * 30 + n, 96 + fold * 30 + n, 255];
};

// Shattered glass: angular shards radiating from an impact point + glints.
const decalGlass = (x, y, s, rng) => {
  const d = Math.hypot(x - 8, y - 8);
  const a = Math.atan2(y - 8, x - 8);
  const wedge = Math.abs(Math.sin(a * 3.5 + 0.7));
  if (d > 0.5 && d < 6.5 && wedge > 0.8 && hash2(x, y) < 0.85) {
    const n = (rng() - 0.5) * 24;
    return [196 + n, 222 + n, 234 + n, 255];
  }
  if (d < 7.5 && hash2(x * 7, y * 7) < 0.06) return [240, 250, 255, 255];
  return [0, 0, 0, 0];
};

// Windblown litter: three overlapping sheets of paper with faint print lines.
const decalPapers = (x, y, s, rng) => {
  const sheets = [[4, 10, 9, 14], [8, 6, 13, 12], [2, 3, 7, 9]]; // topmost first
  for (const [x0, y0, x1, y1] of sheets) {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
      const n = (rng() - 0.5) * 10;
      if (x === x0 || x === x1 || y === y0 || y === y1) return [180 + n, 178 + n, 168 + n, 255];
      const line = (y - y0) % 2 === 0 && x > x0 + 1 && x < x1 - 1 && hash2(x, y) < 0.7;
      return line ? [140, 140, 138, 255] : [226 + n, 223 + n, 212 + n, 255];
    }
  }
  return [0, 0, 0, 0];
};

// Crushed drink cans: two dented cylinders with bright lids and label bands.
const decalCans = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 16;
  if (x >= 2 && x <= 8 && y >= 4 && y <= 7) {
    if (x === 2 || x === 8) return [188 + n, 190 + n, 194 + n, 255]; // lids
    if (y === 4) return [212 + n, 214 + n, 218 + n, 255];           // top sheen
    return [172 + n, 46, 40, 255];                                  // red label
  }
  const u = x - (y - 9) * 0.5; // second can lies tilted
  if (u >= 7 && u <= 12 && y >= 9 && y <= 12) {
    if (u <= 7.9 || u >= 11.1) return [188 + n, 190 + n, 194 + n, 255];
    if (y === 9) return [212 + n, 214 + n, 218 + n, 255];
    return [44, 84, 168, 255];                                      // blue label
  }
  return [0, 0, 0, 0];
};

// Spilled fluid: a dark oily puddle with an irregular rim, faint sheen and
// stray drips around it.
const decalStain = (x, y, s, rng) => {
  const d = Math.hypot((x - 8) * 1.1, (y - 8) * 1.35) + hash2(x, y) * 2.2;
  if (d > 6.8) {
    if (hash2(x * 3, y * 3) < 0.035 && d < 9.5) return [38, 34, 30, 255];
    return [0, 0, 0, 0];
  }
  const sheen = Math.sin(x * 1.7 + y * 1.1) > 0.75 ? 26 : 0;
  const n = (rng() - 0.5) * 8;
  return [34 + sheen + n, 31 + sheen + n, 28 + sheen * 0.6 + n, 255];
};

// Dropped food: a pizza slice, a sauce smear and scattered crumbs.
const decalFood = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 14;
  if (x >= 3 && y >= 3 && x <= 10 && y <= 10 && (x - 3) + (y - 3) <= 8) {
    if ((x - 3) + (y - 3) >= 7) return [178 + n, 128 + n, 70, 255]; // crust
    return hash2(x, y) < 0.25 ? [200, 60, 50, 255] : [225 + n, 178 + n, 90, 255];
  }
  if (Math.hypot(x - 12, y - 11) < 1.8) return [150 + n, 40, 34, 255]; // sauce
  if (hash2(x * 5, y * 5) < 0.05) return [190 + n, 160 + n, 110, 255]; // crumbs
  return [0, 0, 0, 0];
};

// --- multi-cell decal art (span > 1x1; `s` is the art WIDTH in pixels) ---

// 64x32 spray-paint tag: a wavy two-tone band with a dark outline and drips.
const decalGraffiti = (x, y, s, rng) => {
  const my = 16 + Math.sin(x * 0.32 + 0.8) * 5 + Math.sin(x * 0.11) * 2;
  const half = 5.5 + Math.sin(x * 0.55) * 1.8;
  const d = Math.abs(y - my);
  if (d < half) {
    const n = (rng() - 0.5) * 20;
    if (d > half - 1.6) return [30, 24, 40, 255]; // dark outline
    const seg = Math.floor(x / 22) % 3;
    if (seg === 0) return [214 + n, 62, 150, 255];  // magenta
    if (seg === 1) return [66, 190 + n, 214, 255];  // cyan
    return [244 + n, 150, 48, 255];                 // orange
  }
  // paint drips below the band
  for (const dx of [11, 29, 47, 58]) {
    if (x === dx && y > my + half - 1 && y < my + half + 3 + hash2(dx, 7) * 6) {
      return [30, 24, 40, 255];
    }
  }
  return [0, 0, 0, 0];
};

// Stencil letters on a 10x23 grid (road-marking style).
const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const STOP_LETTERS = [
  (x, y) => inRect(x, y, 0, 0, 9, 2) || inRect(x, y, 0, 3, 2, 9) || inRect(x, y, 0, 10, 9, 12) || inRect(x, y, 7, 13, 9, 19) || inRect(x, y, 0, 20, 9, 22), // S
  (x, y) => inRect(x, y, 0, 0, 9, 2) || inRect(x, y, 3, 3, 6, 22),                                                                                          // T
  (x, y) => inRect(x, y, 0, 0, 9, 22) && !inRect(x, y, 3, 3, 6, 19),                                                                                        // O
  (x, y) => inRect(x, y, 0, 0, 9, 2) || inRect(x, y, 0, 3, 2, 22) || inRect(x, y, 7, 3, 9, 9) || inRect(x, y, 0, 10, 9, 12),                                // P
];

// 64x64 "STOP" road text: tall worn white stencil letters.
const decalStop = (x, y, s, rng) => {
  const li = Math.floor((x - 5) / 14);
  const lx = (x - 5) - li * 14;
  const ly = y - 20;
  if (li >= 0 && li < 4 && lx >= 0 && lx <= 9 && ly >= 0 && ly <= 22 && STOP_LETTERS[li](lx, ly)) {
    if (hash2(x, y) < 0.12) return [0, 0, 0, 0]; // worn paint
    const n = (rng() - 0.5) * 24;
    return [214 + n, 216 + n, 218 + n, 255];
  }
  return [0, 0, 0, 0];
};

// 32x64 straight-ahead road arrow, worn white paint.
const decalArrow = (x, y, s, rng) => {
  const head = y >= 4 && y <= 20 && Math.abs(x - 15.5) <= (y - 4) * 0.8;
  const shaft = y > 20 && y <= 58 && x >= 12 && x <= 19;
  if (head || shaft) {
    if (hash2(x, y) < 0.1) return [0, 0, 0, 0]; // worn paint
    const n = (rng() - 0.5) * 24;
    return [214 + n, 216 + n, 218 + n, 255];
  }
  return [0, 0, 0, 0];
};

// A burst of bullet impacts: dark holes with chipped light rims.
const decalBullets = (x, y, s, rng) => {
  const holes = [[4, 4], [11, 6], [7, 11]];
  for (const [hx, hy] of holes) {
    const d = Math.hypot(x - hx, y - hy);
    if (d < 1.3) return [28, 26, 24, 255];
    if (d < 2.4 && hash2(x + hx, y + hy) < 0.55) return [165, 162, 158, 255];
    if (d < 3.4 && hash2(x * 3 + hx, y * 3 + hy) < 0.18) return [90, 88, 85, 255]; // radial chips
  }
  return [0, 0, 0, 0];
};

// Collapsed-building fill: coarse chunks of concrete, brick and dust.
const rubble = (x, y, s, rng) => {
  const tone = hash2(x >> 1, y >> 1);
  const n = (rng() - 0.5) * 14;
  if (tone < 0.18) return [126 + n, 58 + n * 0.5, 46];      // brick shards
  if (tone < 0.36) return [98 + n, 90 + n, 80 + n];         // dark debris
  if (tone < 0.55) return [138 + n, 124 + n, 104 + n];      // dusty mortar
  const v = 128 + n + (tone - 0.55) * 60;                   // concrete chunks
  return [v, v, v * 0.98];
};

// Corrugated sheet metal: vertical ridges with rust pitting.
const metal = (x, y, s, rng) => {
  const ridge = Math.sin((x + 0.5) * (Math.PI / 2)) * 0.5 + 0.5; // 4px period
  if (hash2(x, y) < 0.045) return [128, 82, 52];            // rust spots
  const n = (rng() - 0.5) * 10;
  const v = 96 + ridge * 52 + n;
  return [v, v + 3, v + 8];
};

// Stacked khaki bags: staggered rows, dark seams, soft top highlight.
const sandbags = (x, y, s, rng) => {
  const rowH = 5;
  const row = Math.floor(y / rowH);
  const ly = y - row * rowH;
  const off = (row & 1) ? 4 : 0;
  const n = (rng() - 0.5) * 14;
  if (ly === rowH - 1) return [96 + n, 86 + n, 62];         // gap between rows
  if (((x + off) & 7) === 0) return [118 + n, 106 + n, 76]; // bag-end seam
  const bulge = ly === 1 ? 16 : ly === rowH - 2 ? -14 : 0;  // rounded profile
  return [158 + bulge + n, 143 + bulge + n, 104 + bulge * 0.7 + n];
};

// --- cutout tiles (alpha 0 = hole; drawn as centered cross quads) ---

// Diamond wire mesh; the frame rails top and bottom keep it readable.
const chainlink = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 20;
  if (y === 0 || y === s - 1) return [118 + n, 120 + n, 126, 255]; // rails
  const a = (x + y) % 5 === 0;
  const b = (x - y + s * 4) % 5 === 0;
  if (a || b) return [156 + n, 158 + n, 164, 255];
  return [0, 0, 0, 0];
};

// Vertical prison-style bars with top/bottom rails.
const bars = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 12;
  if (y === 0 || y === s - 1) return [78 + n, 80 + n, 88, 255];
  const p = x % 5;
  if (p === 1) return [104 + n, 107 + n, 116, 255]; // lit edge of the bar
  if (p === 2) return [66 + n, 68 + n, 76, 255];    // shaded edge
  return [0, 0, 0, 0];
};

// Barricade: two nailed-on horizontal boards and one diagonal across them.
const boards = (x, y, s, rng) => {
  const plank = (tone) => {
    const grain = Math.sin(x * 1.6 + tone) * 0.5 + 0.5;
    const n = (rng() - 0.5) * 16;
    const v = 142 + tone + grain * 18 + n;
    return [v, v * 0.68, v * 0.4, 255];
  };
  const nail = (x === 1 || x === s - 2);
  const diag = Math.abs(y - (s - 2 - x * 0.75)) < 1.6;
  if (diag) {
    const p = plank(-26);
    return nail && (y < 5 || y > s - 6) ? [70, 52, 34, 255] : p;
  }
  if (y >= 2 && y <= 5) return nail && y === 3 ? [70, 52, 34, 255] : plank(0);
  if (y >= 10 && y <= 13) return nail && y === 11 ? [70, 52, 34, 255] : plank(-12);
  return [0, 0, 0, 0];
};

// --- registry (adding a tile name here makes it available to block defs) ---

const GENERATORS = Object.freeze({
  grass_top: grassTop,
  grass_side: grassSide,
  dirt,
  stone,
  gravel,
  sand,
  concrete,
  asphalt,
  asphalt_line: asphaltLine,
  asphalt_corner: asphaltCorner,
  lamp,
  neon_red: neonRed,
  lamp_off: lampOff,
  neon_off: neonOff,
  curb_side: curbSide,
  curb_top: curbTop,
  canopy,
  canopy_trim: canopyTrim,
  tile_floor: tileFloor,
  plaster,
  shutter,
  brick,
  rubble,
  metal,
  sandbags,
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
  chainlink,
  bars,
  boards,
  decal_blood: decalBlood,
  decal_blood2: decalBlood2,
  decal_blood3: decalBlood3,
  decal_blood_pool: decalBloodPool,
  decal_crack: decalCrack,
  decal_bullets: decalBullets,
  decal_clothes: decalClothes,
  decal_glass: decalGlass,
  decal_papers: decalPapers,
  decal_cans: decalCans,
  decal_stain: decalStain,
  decal_food: decalFood,
  decal_graffiti: decalGraffiti,
  decal_stop: decalStop,
  decal_arrow: decalArrow,
});

/** Names of every registered tile, in deterministic order. */
export function listTileNames() {
  return Object.keys(GENERATORS);
}

// Atlas-slot span per tile name, derived from the decal registry (a decal
// spanning w x h cells has w x h slots of art, so texel density matches
// blocks). Plain tiles are 1x1.
const TILE_SPANS = (() => {
  const spans = {};
  for (const id of listDecalIds()) {
    const d = getDecal(id);
    if (d.span && (d.span[0] > 1 || d.span[1] > 1)) spans[d.tile] = [d.span[0], d.span[1]];
  }
  return spans;
})();

/** Atlas-slot span [cols, rows] of a tile (1x1 for everything but big decals). */
export function tileSpan(name) {
  return TILE_SPANS[name] ?? [1, 1];
}

/** Pixel dimensions [w, h] of a tile's art. */
export function tilePixelDims(name) {
  const [c, r] = tileSpan(name);
  return [c * TILE_SIZE, r * TILE_SIZE];
}

/**
 * Pure: render a tile as a flat RGBA Uint8ClampedArray (w*h*4 — see
 * tilePixelDims; plain tiles are TILE_SIZE^2 * 4). Generators receive the
 * art WIDTH as their size parameter.
 * @param {string} name
 * @param {number} [seed]
 */
export function generateTilePixels(name, seed = 1) {
  const gen = GENERATORS[name];
  if (!gen) throw new Error(`Unknown tile "${name}"`);
  const [w, h] = tilePixelDims(name);
  const rng = mulberry32(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = gen(x, y, w, rng);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return data;
}

/**
 * Pure: lay out tiles onto the atlas grid. 1x1 tiles pack row-major first;
 * multi-slot tiles (big decals) pack below them on shelves, tallest first.
 * Returns RGBA for the whole atlas plus a map of tile name -> atlas index
 * (a multi-slot tile's index is its top-left slot).
 * @param {string[]} names
 */
export function renderAtlasRGBA(names = listTileNames()) {
  const width = TILE_SIZE * ATLAS_WIDTH;
  const height = TILE_SIZE * ATLAS_HEIGHT;
  // Fill unused slots with an opaque neutral so accidental UV bleeding shows
  // as a flat color instead of black.
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const map = new Map();

  const blit = (name, ox, oy) => {
    const tile = generateTilePixels(name);
    const [tw, th] = tilePixelDims(name);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const src = (y * tw + x) * 4;
        const dst = ((oy + y) * width + (ox + x)) * 4;
        data[dst] = tile[src];
        data[dst + 1] = tile[src + 1];
        data[dst + 2] = tile[src + 2];
        data[dst + 3] = tile[src + 3];
      }
    }
  };

  const unique = [...new Set(names)];
  const smalls = unique.filter((n) => tileSpan(n)[0] === 1 && tileSpan(n)[1] === 1);
  const bigs = unique.filter((n) => !smalls.includes(n))
    .sort((a, b) => tileSpan(b)[1] - tileSpan(a)[1]); // tallest first packs densest

  smalls.forEach((name, index) => {
    blit(name, (index % ATLAS_WIDTH) * TILE_SIZE, Math.floor(index / ATLAS_WIDTH) * TILE_SIZE);
    map.set(name, index);
  });

  let row = Math.ceil(smalls.length / ATLAS_WIDTH);
  let col = 0;
  let shelfRows = 0;
  for (const name of bigs) {
    const [c, r] = tileSpan(name);
    if (col + c > ATLAS_WIDTH) {
      row += shelfRows;
      col = 0;
      shelfRows = 0;
    }
    if (row + r > ATLAS_HEIGHT) throw new Error(`Atlas full: "${name}" does not fit`);
    blit(name, col * TILE_SIZE, row * TILE_SIZE);
    map.set(name, row * ATLAS_WIDTH + col);
    col += c;
    shelfRows = Math.max(shelfRows, r);
  }

  return { width, height, data, map, atlas: { width: ATLAS_WIDTH, height: ATLAS_HEIGHT } };
}

/** Names of every tile referenced by registered block and decal defs. */
export function tilesForBlocks() {
  const names = new Set();
  for (const id of listBlockIds()) {
    for (const face of ['py', 'ny', 'px', 'nx', 'pz', 'nz']) {
      const t = tileFor(id, face);
      if (t) names.add(t);
    }
  }
  for (const id of listDecalIds()) names.add(getDecal(id).tile);
  return [...names];
}
