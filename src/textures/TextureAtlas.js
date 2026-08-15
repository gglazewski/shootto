// TextureAtlas.js — procedural Minecraft-style tile atlas.
//
// Tiles are generated as pure pixel arrays (no DOM), so the generator is unit
// testable in Node. The atlas canvas wrapper is kept tiny and three-dependent
// only at the final texture-creation step.

import { listBlockIds, getBlock, tileFor, listDecalIds, getDecal } from '../engine/VoxelTypes.js';

export const TILE_SIZE = 16;export const ATLAS_WIDTH = 8; // tiles per row
export const ATLAS_HEIGHT = 40; // rows (small tiles + multi-slot decal/door art + runtime sign tiles)
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

// Cigarette butts: a scatter of short ground-out stubs — white paper bodies,
// orange filter tips, a smudge of grey ash at the burnt end.
const decalCigs = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 14;
  const stubs = [[2, 4, 4, 1], [9, 6, 4, 0], [4, 11, 4, 1], [11, 12, 3, 1]]; // [x0,y0,len,horizontal]
  for (const [x0, y0, len, horiz] of stubs) {
    const u = horiz ? x : y;
    const v = horiz ? y : x;
    const u0 = horiz ? x0 : y0;
    const v0 = horiz ? y0 : x0;
    if (v === v0 && u >= u0 && u < u0 + len) {
      if (u >= u0 + len - 2) return [200 + n, 128 + n, 54, 255]; // filter
      return [216 + n, 212 + n, 202 + n, 255];                   // paper
    }
    if (Math.hypot(u - (u0 - 1), v - v0) < 1.3 && hash2(x, y) < 0.5) {
      return [122 + n, 118 + n, 112 + n, 255];                   // ash smudge
    }
  }
  return [0, 0, 0, 0];
};

// Dog poop: a coiled pile of three stacked brown blobs shrinking upward,
// darker in the creases, with a dull highlight on the top coil.
const decalPoop = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 12;
  const coils = [[8, 11, 4.4, 2.2], [8, 8.5, 3.4, 1.9], [8.5, 6.5, 2.2, 1.5]]; // bottom→top
  for (let i = coils.length - 1; i >= 0; i--) {
    const [cx, cy, rx, ry] = coils[i];
    const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
    if (d < 1 + hash2(x + i * 7, y) * 0.12) {
      const crease = Math.abs(d - 0.85) < 0.12 ? -20 : 0;
      const hi = i === 2 && d < 0.45 ? 16 : 0;
      return [92 + crease + hi + n, 62 + crease * 0.7 + hi + n, 30 + n, 255];
    }
  }
  return [0, 0, 0, 0];
};

// Sunflower seed husks: the bench-side scatter — each shell two pixels, a
// pale striped fat end and a dark tip, strewn at mixed orientations.
const decalSeeds = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 18;
  const seeds = [
    [3, 3, 1], [7, 2, 0], [12, 4, 1], [5, 6, 0], [10, 7, 1], [14, 10, 0],
    [2, 9, 0], [8, 11, 1], [12, 13, 0], [4, 13, 1], [9, 14, 1],
  ]; // [x, y, horizontal]
  for (const [cx, cy, horiz] of seeds) {
    const du = horiz ? x - cx : y - cy;
    const dv = horiz ? y - cy : x - cx;
    if (dv === 0 && (du === 0 || du === 1)) {
      return du === 0
        ? [186 + n, 176 + n, 158 + n, 255] // striped fat end
        : [58 + n, 52 + n, 48 + n, 255];   // dark tip
    }
  }
  return [0, 0, 0, 0];
};

// 16x16 domofon: the brushed-steel entryphone panel at every blok entrance —
// speaker grille up top, a column of call buttons with worn name strips.
const decalDomofon = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 8;
  if (x < 4 || x > 11 || y < 1 || y > 14) return [0, 0, 0, 0];
  if (x === 4 || x === 11 || y === 1 || y === 14) return [88 + n, 90 + n, 96 + n, 255]; // bevel
  if (y >= 3 && y <= 5) { // speaker grille
    if (x >= 6 && x <= 9 && ((x + y) & 1) === 0) return [30, 30, 32, 255];
    return [136 + n, 138 + n, 144 + n, 255];
  }
  if (y >= 7 && y <= 12 && !((y - 7) & 1)) { // button rows
    if (x === 6) return hash2(3, y) < 0.3 ? [222 + n, 182, 92, 255] : [52 + n, 52 + n, 56, 255]; // call button (some lit)
    if (x >= 8 && x <= 10) return [212 + n, 208 + n, 196 + n, 255]; // name strip
    return [120 + n, 122 + n, 128 + n, 255];
  }
  const scuff = hash2(x * 3, y * 3) < 0.06 ? -18 : 0;
  return [150 + scuff + n, 152 + scuff + n, 158 + scuff + n, 255]; // brushed face
};

// 16x16 flip switch (wyłącznik): the square cream-plastic plate on every
// 90s Polish wall, one big rocker in the middle. Two tiles — rocker tipped
// out at the top (off) or at the bottom (on) — swapped at runtime by
// engine/Switches.js as its flag flips.
const switchFace = (x, y, s, rng, on) => {
  if (x < 5 || x > 10 || y < 5 || y > 10) return [0, 0, 0, 0];
  const n = (rng() - 0.5) * 6;
  if (x === 5 || x === 10 || y === 5 || y === 10) return [150 + n, 144 + n, 127 + n, 255]; // beveled rim
  if (x >= 7 && x <= 8 && y >= 6 && y <= 9) {
    const topOut = !on; // which half of the rocker sticks out of the plate
    if (y === (topOut ? 9 : 6)) return [96 + n, 92 + n, 80, 255]; // far edge of the pressed half, in shadow
    if (y === (topOut ? 7 : 8)) return [255, 252, 240, 255]; // protruding lip catching the light
    const outHalf = (y <= 7) === topOut;
    return outHalf ? [242 + n, 237 + n, 220 + n, 255] : [193 + n, 187 + n, 168 + n, 255];
  }
  return [225 + n, 219 + n, 200 + n, 255]; // cream plate
};
const decalSwitch = (x, y, s, rng) => switchFace(x, y, s, rng, false);
const decalSwitchOn = (x, y, s, rng) => switchFace(x, y, s, rng, true);

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

// --- doors (32x64 art: one 2x4-slot tile spans the whole leaf) ---

// 90s Polish entrance door: dark dermatoid (skay) padding quilted into
// diamonds by seam lines with studs at the crossings, brass handle at the
// right — the classic blok stairwell door.
const doorWood = (x, y, s, rng) => {
  const h = s * 2;
  const n = (rng() - 0.5) * 10;
  if (x < 2 || x >= s - 2 || y < 2 || y >= h - 2) return [56 + n, 41 + n, 29 + n, 255];
  if (x >= s - 11 && x <= s - 5 && y >= 31 && y <= 32) return [190 + n, 160 + n, 78, 255]; // lever
  if (x >= s - 6 && x <= s - 4 && y >= 29 && y <= 35) return [168 + n, 140 + n, 66, 255]; // rose plate
  const a = (x + y) % 12;
  const b = (x - y + 240) % 12;
  if (a === 0 && b === 0) return [48, 36, 26, 255]; // stud
  if (a === 0 || b === 0) return [72 + n, 52 + n, 36, 255]; // seam
  const puff = Math.min(a, 12 - a, b, 12 - b); // rises toward the diamond centre
  const v = 94 + puff * 7;
  return [v + n, v - 30 + n, v - 52 + n, 255];
};

// White-painted interior door: three frosted panes down the upper half, a
// recessed panel below — the standard PRL flat room door.
const doorWhite = (x, y, s, rng) => {
  const h = s * 2;
  const n = (rng() - 0.5) * 7;
  if (x < 2 || x >= s - 2 || y < 2 || y >= h - 2) return [172 + n, 168 + n, 158 + n, 255];
  for (let i = 0; i < 3; i++) {
    const top = 5 + i * 9;
    if (y >= top && y < top + 7 && x >= 7 && x < s - 7) {
      if (y === top || y === top + 6 || x === 7 || x === s - 8) return [146 + n, 142 + n, 132 + n, 255];
      const frost = 212 + Math.sin(x * 1.9 + y * 2.1) * 9;
      return [frost + n, frost + n, frost + 3 + n, 120]; // frosted glass — translucent
    }
  }
  if (x >= s - 9 && x <= s - 4 && y >= 33 && y <= 34) return [64 + n, 58 + n, 50 + n, 255]; // handle
  if ((y === 42 || y === 58) && x >= 7 && x <= s - 8) return [176 + n, 172 + n, 162 + n, 255];
  if ((x === 7 || x === s - 8) && y >= 42 && y <= 58) return [176 + n, 172 + n, 162 + n, 255];
  const v = 202 + Math.sin(y * 0.55 + x * 0.1) * 4;
  return [v + n, v + n, v - 9 + n, 255];
};

// Institution door (sklep, urząd, komisariat): boxy aluminium frame, full
// glazing with diagonal reflections, push bar, kick plate and a taped-on
// opening-hours card.
const doorShop = (x, y, s, rng) => {
  const h = s * 2;
  const n = (rng() - 0.5) * 8;
  const alu = (v) => [v + n, v + 2 + n, v + 7 + n, 255];
  if (x < 1 || x >= s - 1 || y < 1 || y >= h - 1) return alu(88);
  if (x < 3 || x >= s - 3 || y < 3 || y >= h - 3) return alu(134);
  if (y >= h - 11) return alu(y === h - 11 ? 100 : 122 + ((x + y) % 2) * 5); // kick plate
  if (y >= 30 && y <= 32) return alu(y === 31 ? 150 : 118); // push bar
  const d = Math.floor(x + y * 0.5);
  const streak = d % 17 === 4 || d % 17 === 5 ? 24 : 0; // window reflections
  return [42 + streak + n, 60 + streak + n, 64 + streak + n, 100]; // glazing — translucent
};

// --- mid-90s Poland set: blocks ---

// Wielka płyta prefab panel: weathered concrete slab with dark joint lines
// along the tile edges (tiling turns them into a panel grid) and grime
// streaks running down from the horizontal joint.
const panel = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 12;
  if (y === s - 1 || x === s - 1) return [118 + n, 116 + n, 112 + n]; // joints
  if (y === s - 2 || x === s - 2) return [148 + n, 146 + n, 142 + n]; // joint shadow
  // drip streaks bleeding down from the joint above (tile top edge)
  const drip = hash2(x, 11);
  if (drip < 0.2 && y < 3 + drip * 40) return [142 + n, 138 + n, 132 + n];
  const weather = Math.sin(x * 0.35 + y * 0.15) * 6;
  return [168 + weather + n, 165 + weather + n, 160 + weather + n];
};

// PRL lamperia: glossy olive-green oil paint — every stairwell, school and
// clinic corridor. Uniform so it tiles; stack white `plaster` above it and
// the boundary reads as the classic wainscot line.
const plasterPastel = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 7;
  const sheen = Math.sin(x * 1.9 + y * 0.6) > 0.78 ? 16 : 0;    // oil-paint gloss
  const streak = hash2(x, 5) < 0.16 ? -10 : 0;                   // wash streaks
  const scuff = hash2(x * 3, y * 3) < 0.02 ? -22 : 0;
  return [140 + sheen + streak + scuff + n, 152 + sheen + streak + scuff + n, 114 + sheen * 0.7 + streak + scuff + n];
};

// Lastryko terrazzo: grey cement field packed with polished stone chips —
// white, black, brick-red and blue-grey — the default 90s PL public floor.
const lastryko = (x, y, s, rng) => {
  const chip = hash2(x >> 1, y >> 1);
  const n = (rng() - 0.5) * 10;
  if (chip < 0.14) return [224 + n, 220 + n, 212 + n];   // white marble
  if (chip < 0.24) return [58 + n, 56 + n, 58 + n];      // black basalt
  if (chip < 0.32) return [148 + n, 84 + n, 68 + n];     // brick-red chips
  if (chip < 0.4) return [124 + n, 132 + n, 146 + n];    // blue-grey chips
  return [164 + n, 158 + n, 150 + n];                    // cement field
};

// Ruch-kiosk enamel: grey-green sheet panels with seam lines and rivets.
const kiosk = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 8;
  if ((x & 7) === 7) return [72 + n, 84 + n, 74];                  // panel seam
  if ((x & 7) === 3 && (y & 7) === 3) return [130 + n, 142 + n, 130]; // rivet head
  if ((x & 7) === 4 && (y & 7) === 3) return [66, 78, 68];         // rivet shadow
  const brush = Math.sin(y * 1.4) * 4;                             // enamel sheen
  const shade = (x & 7) === 0 ? 8 : 0;                             // lit seam edge
  return [98 + brush + shade + n, 112 + brush + shade + n, 100 + brush + shade + n];
};

// Galvanized corrugated sheet (blacha): bright zinc ridges, mottled spangle
// patches, no rust — garage colonies and bazaar roofs.
const blacha = (x, y, s, rng) => {
  const ridge = Math.sin((x + 0.5) * (Math.PI / 2)) * 0.5 + 0.5;
  const spangle = hash2(x >> 2, y >> 2) * 18 - 9;   // crystallite patches
  const n = (rng() - 0.5) * 8;
  if (hash2(x * 3, y * 3) < 0.02) return [228, 232, 238]; // zinc glints
  const v = 138 + ridge * 54 + spangle + n;
  return [v, v + 3, v + 9];
};

// Courtyard paving slabs: 8px concrete pavers, grass and soil in the joints,
// per-slab tone shifts and the odd cracked corner.
const paving = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 12;
  if ((x & 7) === 7 || (y & 7) === 7) {                          // joints
    return hash2(x, y) < 0.4 ? [82 + n, 112 + n, 54] : [88 + n, 76 + n, 60]; // grass / soil
  }
  const tone = [0, -14, 8, -6][((x >> 3) + (y >> 3) * 3) & 3];
  if (hash2(x * 5, y * 5) < 0.05) return [112 + n, 110 + n, 106]; // chips
  const edge = (x & 7) === 0 || (y & 7) === 0 ? 8 : 0;            // lit slab edge
  return [156 + tone + edge + n, 153 + tone + edge + n, 148 + tone + edge + n];
};

// Pre-war industrial brick: darker, browner courses under decades of soot,
// with near-black smoke streaks washing down the face.
const brickSooty = (x, y, s, rng) => {
  const row = y >> 2;
  const off = (row & 1) ? 4 : 0;
  const n = (rng() - 0.5) * 12;
  const soot = hash2(x, 3) < 0.3 ? 0.55 + hash2(x, y) * 0.25 : 1; // streaks
  if ((y & 3) === 3 || ((x + off) & 7) === 7) {
    return [96 * soot + n, 88 * soot + n, 80 * soot + n];          // dark mortar
  }
  const tone = [0, -12, 8, -5][(row + ((x + off) >> 3)) & 3];
  return [(118 + tone + n) * soot, (54 + tone * 0.5) * soot, (42 + n * 0.3) * soot];
};

// Worn brown linoleum: flat orange-brown sheet with pale marbled veins and
// sparse heel marks — apartments, offices, schools. Much flatter than dirt.
const lino = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 4;
  if (hash2(x * 7, y * 7) < 0.025) return [104 + n, 66, 40];     // heel marks
  const vein = Math.sin(x * 0.8 + Math.sin(y * 0.7) * 2.4) > 0.72 ? 18 : 0; // marbling
  const sheen = (x + y * 2) % 9 === 0 ? 8 : 0;                   // dull polish lines
  return [164 + vein + sheen + n, 110 + vein * 0.8 + sheen + n, 62 + vein * 0.4 + n];
};

// White shop neon: cold glowing tube core in a dark housing (SKLEP / BAR
// signage); the blinking variant strobes to neon_white_off.
const neonWhite = (x, y, s, rng) => {
  const band = Math.abs(y - (s >> 1));
  const n = (rng() - 0.5) * 12;
  if (band <= 1) return [246, 250 + n * 0.3, 255];
  if (band <= 3) return [178 + n, 192 + n, 210];
  return [62 + n, 68, 78];
};

const neonWhiteOff = (x, y, s, rng) => {
  const band = Math.abs(y - (s >> 1));
  const n = (rng() - 0.5) * 8;
  if (band <= 1) return [138 + n, 144, 152];   // cold dead tube
  if (band <= 3) return [92 + n, 98, 108];
  return [46 + n, 50, 58];
};

// Weathered picket fence (pane cutout): grey boards with pointed tips,
// 1px gaps, and shadow bands where the back rails carry the boards.
const pickets = (x, y, s, rng) => {
  const p = x & 3;
  if (p === 3) return [0, 0, 0, 0];                       // gap between boards
  if (y === 0 && p !== 1) return [0, 0, 0, 0];            // pointed tip corners
  const grain = Math.sin(x * 2.1 + y * 0.35) * 8;
  const rail = (y >= 4 && y <= 5) || (y >= 11 && y <= 12) ? -18 : 0; // rail shadow
  const tip = y === 1 && p !== 1 ? 14 : 0;                // lit tip bevel
  const n = (rng() - 0.5) * 14;
  const v = 128 + grain + rail + tip + n;
  return [v, v * 0.96, v * 0.86, 255];
};

// Facade plaster in estate pastels (image-of-the-90s blok colors): the
// dirty-white `plaster` field tinted per block, sharing its grime streaks.
const tintedPlaster = (tr, tg, tb) => (x, y, s, rng) => {
  const n = (rng() - 0.5) * 10;
  const streak = hash2(x, 3) < 0.22 ? -16 - hash2(x, y) * 14 : 0;
  return [tr + streak + n, tg + streak + n, tb + streak + n];
};
const plasterYellow = tintedPlaster(214, 196, 128);
const plasterOrange = tintedPlaster(220, 168, 116);
const plasterGreen = tintedPlaster(172, 190, 140);
const plasterBlue = tintedPlaster(148, 178, 194);

// Yellow clinker brick (rural shop plinths, garage rows): sand-yellow
// courses over grey mortar.
const brickYellow = (x, y, s, rng) => {
  const row = y >> 2;
  const off = (row & 1) ? 4 : 0;
  const mortar = (y & 3) === 3 || ((x + off) & 7) === 7;
  const n = (rng() - 0.5) * 12;
  if (mortar) return [158 + n, 152 + n, 142 + n];
  const tone = [0, -14, 10, -6][(row + ((x + off) >> 3)) & 3];
  return [196 + tone + n, 164 + tone + n, 92 + tone * 0.5 + n * 0.5];
};

// Papa — tar-paper roofing felt on every garage colony: near-black sheet
// with horizontal overlap seams and a sparse mineral-grit sparkle.
const papa = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 8;
  if ((y & 7) === 7) return [28 + n, 27 + n, 26 + n];        // overlap seam shadow
  if ((y & 7) === 0) return [62 + n, 60 + n, 58 + n];        // lit seam edge
  if (hash2(x * 3, y * 3) < 0.06) return [96 + n, 94 + n, 90 + n]; // grit sparkle
  return [46 + n, 45 + n, 44 + n];
};

// Painted steel garage door: vertical boards with grooves, a horizontal
// frame rib, rust blooming at the bottom edge and paint wear on the ridges.
const garageDoor = (pr, pg, pb) => (x, y, s, rng) => {
  const n = (rng() - 0.5) * 12;
  const p = x & 3;
  const rust = y >= s - 3 && hash2(x, y) < 0.45;
  if (rust) return [110 + n, 74 + n * 0.5, 48];
  if (x === 0 || x === s - 1) return [pr * 0.6 + n, pg * 0.6 + n, pb * 0.6 + n]; // frame
  if (y === 7 || y === 8) return [pr * 0.72 + n, pg * 0.72 + n, pb * 0.72 + n]; // cross rib
  if (p === 3) return [pr * 0.62 + n, pg * 0.62 + n, pb * 0.62 + n]; // board groove
  const wear = hash2(x * 5, y * 5) < 0.03 ? 26 : 0;          // chipped paint
  const lit = p === 0 ? 12 : 0;                              // lit board edge
  return [pr + lit + wear + n, pg + lit + wear + n, pb + lit + wear + n];
};
const garageBrown = garageDoor(118, 72, 52);
const garageGreen = garageDoor(74, 128, 82);
const garageRed = garageDoor(152, 62, 52);

// Framed window pane: white PVC/wood frame around slightly bluish glass
// with a diagonal sky reflection. Rendered in the transparent pass.
const windowWhite = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 8;
  if (x < 2 || x >= s - 2 || y < 2 || y >= s - 2) return [226 + n, 224 + n, 218 + n, 255]; // frame
  if (x === 2 || x === s - 3 || y === 2 || y === s - 3) return [148 + n, 150 + n, 152 + n, 255]; // frame shadow
  const d = Math.floor(x + y * 0.6);
  const streak = d % 11 === 3 || d % 11 === 4 ? 40 : 0;      // sky reflection
  // Glass texels stay below the cutout threshold (alpha < 128) so the
  // opaque pass discards them and the transparent pass blends them.
  return [96 + streak + n, 120 + streak + n, 138 + streak + n, 110];
};

// Balcony balustrade (pane cutout): corrugated sheet panel hung on a top
// rail with posts — the classic blok balcony front. Alpha above the rail.
const balconyRail = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 10;
  if (y === 1 || y === 2) return [92 + n, 94 + n, 98 + n, 255]; // handrail
  if (y < 5) {
    if ((x & 7) === 2 || (x & 7) === 6) return [104 + n, 106 + n, 110 + n, 255]; // posts
    return [0, 0, 0, 0];
  }
  if (y === 5) return [120 + n, 122 + n, 126 + n, 255];      // panel top rim
  const ridge = Math.sin((x + 0.5) * (Math.PI / 2)) * 0.5 + 0.5; // corrugation
  const drip = hash2(x, 7) < 0.18 && y > 10 ? -18 : 0;       // grime runs
  const v = 150 + ridge * 40 + drip + n;
  return [v, v + 1, v - 2, 255];
};

// Grey steel stairwell door (32x64): flat sheet, weld-framed edges, one
// narrow wired-glass slot left of center, round black knob at the right.
const doorSteel = (x, y, s, rng) => {
  const h = s * 2;
  const n = (rng() - 0.5) * 8;
  if (x < 2 || x >= s - 2 || y < 2 || y >= h - 2) return [88 + n, 92 + n, 100 + n, 255]; // frame
  if (x >= 10 && x <= 15 && y >= 10 && y <= 40) {            // glass slot
    if (x === 10 || x === 15 || y === 10 || y === 40) return [58 + n, 60 + n, 64 + n, 255]; // slot frame
    const wire = ((x + y) & 3) === 0 || ((x - y) & 3) === 0; // wired glass mesh
    const g = wire ? 148 : 176;
    return [g + n, g + 4 + n, g - 6 + n, wire ? 255 : 120]; // glass between the wires — translucent
  }
  if (Math.hypot(x - (s - 7), y - 33) < 1.8) return [26, 26, 28, 255]; // knob
  if (Math.hypot(x - (s - 7), y - 33) < 2.6) return [64 + n, 66 + n, 70 + n, 255]; // knob plate
  const scuff = hash2(x * 3, y * 3) < 0.025 ? -26 : 0;
  if (y >= h - 8 && hash2(x, y) < 0.25) return [96 + n, 76 + n, 58, 255]; // rust at the sill
  const v = 122 + Math.sin(y * 0.35) * 4 + scuff;
  return [v + n, v + 4 + n, v + 10 + n, 255];
};

// Wielka płyta stairwell door leaf (32x64): the aluminium joinery every blok
// entrance got — wired-glass upper glazing, sheet-metal lower panel, a kick
// plate gone rusty at the sill and a black bakelite grip. The fixed sidelight
// beside it is its own block (see sidelightPane).
const doorBlok = (x, y, s, rng) => {
  const h = s * 2;
  const n = (rng() - 0.5) * 8;
  const alu = (v) => [v + n, v + 2 + n, v + 7 + n, 255];
  const wired = () => {
    const wire = ((x + y) & 3) === 0 || ((x - y) & 3) === 0; // wired glass mesh
    const g = wire ? 148 : 176;
    return [g + n, g + 4 + n, g - 6 + n, wire ? 255 : 115]; // glass between the wires — translucent
  };
  const grime = hash2(x, 3) < 0.2 && y > 8 ? -hash2(x, y) * 22 : 0; // rain runs
  if (x < 2 || x >= s - 2 || y < 2 || y >= h - 2) return alu(88 + grime); // outer frame
  if (x < 4 || x >= s - 4 || y < 4 || y >= h - 4) return alu(132 + grime); // leaf frame
  if (y >= h - 12) {                                          // kick plate
    if (y >= h - 5 && hash2(x, y) < 0.4) return [104 + n, 74 + n, 52, 255]; // rust at the sill
    return alu(y === h - 12 ? 146 : 106);
  }
  if (y >= 37 && y <= 40) return alu(y === 40 ? 96 : 124);    // mid rail
  if (x >= 24 && x <= 27 && y >= 29 && y <= 36) {             // escutcheon plate
    if (x >= 25 && x <= 26 && y >= 30 && y <= 34) return [24 + n, 24 + n, 26 + n, 255]; // bakelite grip
    return [58 + n, 60 + n, 64 + n, 255];
  }
  if (y <= 36) {                                              // upper glazing
    if (y === 36 || x === 4 || x === s - 5) return alu(112);  // glazing bead
    const streak = (x + Math.floor(y * 0.6)) % 13 === 4 ? 34 : 0; // sky reflection
    const [r, g, b, a] = wired();
    return [r + streak, g + streak, b + streak, a];
  }
  const scuff = hash2(x * 3, y * 3) < 0.03 ? -20 : 0;
  return alu(126 + scuff + grime);                            // lower panel
};

// Blok sidelight (16x32): the fixed wired-glass pane beside the stairwell
// door, behind a flat-steel krata — grilles like this went up over every
// ground-floor window and entrance glazing in the 90s.
const sidelightPane = (x, y, s, rng) => {
  const h = s * 2;
  const n = (rng() - 0.5) * 8;
  const alu = (v) => [v + n, v + 2 + n, v + 7 + n, 255];
  if (x < 2 || x >= s - 2 || y < 2 || y >= h - 2) {           // outer frame
    if (y >= h - 4 && hash2(x, y) < 0.35) return [106 + n, 76 + n, 54, 255]; // rust at the sill
    return alu(90);
  }
  if (x === 2 || x === s - 3 || y === 2 || y === h - 3) return alu(116); // frame shadow
  if (y === 15 || y === 16) return alu(y === 15 ? 138 : 108); // mid rail
  const barV = (x >= 4 && x <= 5) || (x >= 10 && x <= 11);    // kraty bars
  const barH = (y >= 7 && y <= 8) || (y >= 23 && y <= 24);
  if (barV || barH) {
    if (hash2(x * 7, y * 7) < 0.06) return [96 + n, 66 + n, 46, 255]; // rust flecks
    const lit = barV && (x === 4 || x === 10) ? 16 : 0;       // lit bar edge
    return [50 + lit + n, 58 + lit + n, 54 + lit + n, 255];   // dark painted steel
  }
  const wire = ((x + y) & 3) === 0 || ((x - y) & 3) === 0;    // wired glass
  const g = wire ? 148 : 176;
  const streak = (x + Math.floor(y * 0.6)) % 11 === 4 ? 30 : 0;
  return [g + streak + n, g + 4 + streak + n, g - 6 + streak + n, wire ? 255 : 115];
};

// --- mid-90s Poland set: decals ---

// 32x32 peeling poster: off-white sheet, red header band, print lines, torn
// edges and a peeled-away bottom-right corner.
const decalPoster = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 10;
  if (x < 2 || x > 29 || y < 2 || y > 29) {
    // ragged torn border
    if (x < 1 || x > 30 || y < 1 || y > 30 || hash2(x, y) < 0.4) return [0, 0, 0, 0];
  }
  const peel = (x - 20) + (y - 20);                       // bottom-right corner gone
  if (peel > 14) return [0, 0, 0, 0];
  if (peel > 12) return [150 + n, 144 + n, 130 + n, 255]; // curled paper edge
  if (y <= 9) return [178 + n, 42, 40, 255];              // red header band
  if (y === 10) return [216 + n, 210 + n, 194 + n, 255];
  // print lines
  const line = (y & 3) === 0 && x > 4 && x < 27 && hash2(x, y) < 0.75;
  if (line) return [92, 90, 88, 255];
  return [226 + n, 220 + n, 204 + n, 255];
};

// 64x16 hand-painted shop sign: white block letters "SKLEP" on a worn
// dark-red board.
const SKLEP_LETTERS = [
  (x, y) => inRect(x, y, 0, 0, 6, 1) || inRect(x, y, 0, 2, 1, 4) || inRect(x, y, 0, 4, 6, 5) || inRect(x, y, 5, 6, 6, 7) || inRect(x, y, 0, 8, 6, 9), // S
  (x, y) => inRect(x, y, 0, 0, 1, 9) || (Math.abs((x - 2) - (3 - y)) < 1.2 && y <= 4 && x >= 2) || (Math.abs((x - 2) - (y - 5)) < 1.2 && y >= 5 && x >= 2), // K
  (x, y) => inRect(x, y, 0, 0, 1, 9) || inRect(x, y, 0, 8, 6, 9),                                                       // L
  (x, y) => inRect(x, y, 0, 0, 1, 9) || inRect(x, y, 0, 0, 6, 1) || inRect(x, y, 0, 4, 5, 5) || inRect(x, y, 0, 8, 6, 9), // E
  (x, y) => inRect(x, y, 0, 0, 1, 9) || inRect(x, y, 0, 0, 6, 1) || inRect(x, y, 5, 1, 6, 4) || inRect(x, y, 0, 4, 6, 5), // P
];

const decalSklep = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 12;
  if (x === 0 || x === s - 1 || y === 0 || y === 15) return [72 + n, 40, 30, 255]; // frame
  const li = Math.floor((x - 5) / 12);
  const lx = (x - 5) - li * 12;
  const ly = y - 3;
  if (li >= 0 && li < 5 && lx >= 0 && lx <= 6 && ly >= 0 && ly <= 9 && SKLEP_LETTERS[li](lx, ly)) {
    if (hash2(x, y) < 0.08) return [150 + n, 60, 48, 255]; // flaked paint
    return [228 + n, 224 + n, 214 + n, 255];
  }
  return [146 + n, 44, 36, 255]; // painted board
};

// 64x32 football-club wall war: a blue club scrawl crossed out with a red X,
// the rival's jagged tag sprayed over it — the definitive Polish wall art.
const decalClub = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 18;
  // rival red X through the middle of the old tag
  const cx = x - 30, cy = y - 10;
  if (cx >= -9 && cx <= 9 && Math.abs(Math.abs(cx * 0.9) - Math.abs(cy)) < 1.4) {
    return [196 + n, 44, 40, 255];
  }
  // old blue scrawl: wavy hand-height band, upper-left area
  const my = 9 + Math.sin(x * 0.5 + 1.2) * 2.5;
  if (x >= 3 && x <= 42 && Math.abs(y - my) < 2.2 && hash2(x, y) < 0.9) {
    return [46 + n, 78, 168, 255];
  }
  // rival's jagged red tag below-right, sharper zigzag
  const zy = 24 + (((x >> 2) & 1) ? 3 : -3) * ((x % 4) / 4);
  if (x >= 20 && x <= 60 && Math.abs(y - zy) < 1.8 && hash2(x, y) < 0.92) {
    return [200 + n, 48, 42, 255];
  }
  // stray drips from the X
  if ((x === 26 || x === 35) && y > 18 && y < 24 + hash2(x, 3) * 5) return [180, 40, 36, 255];
  return [0, 0, 0, 0];
};

// 64x32 "HWDP" tag: the four-letter anti-police acronym sprayed in black
// block letters on every 90s osiedle wall, drips included.
const HWDP_LETTERS = [
  (x, y) => inRect(x, y, 0, 0, 2, 17) || inRect(x, y, 6, 0, 8, 17) || inRect(x, y, 0, 7, 8, 10),                              // H
  (x, y) => inRect(x, y, 0, 0, 2, 17) || inRect(x, y, 6, 0, 8, 17) || inRect(x, y, 0, 15, 8, 17) || inRect(x, y, 3, 7, 5, 17), // W
  (x, y) => inRect(x, y, 0, 0, 2, 17) || inRect(x, y, 0, 0, 6, 2) || inRect(x, y, 0, 15, 6, 17) || inRect(x, y, 6, 2, 8, 15),  // D
  (x, y) => inRect(x, y, 0, 0, 2, 17) || inRect(x, y, 0, 0, 6, 2) || inRect(x, y, 6, 2, 8, 8) || inRect(x, y, 0, 7, 6, 9),     // P
];

const decalHwdp = (x, y, s, rng) => {
  const wx = x + Math.sin(y * 0.45 + x * 0.06) * 0.9; // shaky spray hand
  const li = Math.floor((wx - 3) / 15);
  const lx = (wx - 3) - li * 15;
  const ly = y - 7;
  if (li >= 0 && li < 4 && lx >= 0 && lx <= 8 && ly >= 0 && ly <= 17 && HWDP_LETTERS[li](lx, ly)) {
    if (hash2(x, y) < 0.1) return [0, 0, 0, 0]; // patchy spray
    const n = (rng() - 0.5) * 16;
    return [34 + n, 30 + n, 36 + n, 255];
  }
  // drips running off the letter bottoms
  for (const dx of [5, 20, 36, 52]) {
    if (x === dx && y > 23 && y < 26 + hash2(dx, 9) * 6) return [34, 30, 36, 255];
  }
  return [0, 0, 0, 0];
};

// 32x32 kotwica: the Polska Walcząca anchor stencil in worn white — the
// wartime symbol still resprayed on 90s walls.
const decalKotwica = (x, y, s, rng) => {
  const cx = 15.5;
  const shaft = Math.abs(x - cx) < 1.7 && y >= 3 && y <= 24;
  const loop = x >= cx && y <= 14 && Math.abs(Math.hypot(x - cx, y - 8.5) - 5.5) < 1.5;
  const arms = y >= 16 && Math.abs(Math.hypot(x - cx, y - 16) - 9) < 1.6;
  const tips = y >= 11 && y <= 16 &&
    (Math.abs(x - (cx - 9)) < (y - 10) * 0.65 || Math.abs(x - (cx + 9)) < (y - 10) * 0.65);
  if (shaft || loop || arms || tips) {
    if (hash2(x, y) < 0.12) return [0, 0, 0, 0]; // worn stencil paint
    const n = (rng() - 0.5) * 22;
    return [212 + n, 210 + n, 206 + n, 255];
  }
  return [0, 0, 0, 0];
};

// 32x32 circle-A: red spray anarchy sign, legs and crossbar overshooting the
// ring the way every osiedle punk drew it.
const decalAnarchy = (x, y, s, rng) => {
  const ring = Math.abs(Math.hypot(x - 15.5, y - 15.5) - 11) < 1.5;
  const legL = y >= 5 && y <= 27 && Math.abs(x - (15.5 - (y - 5) * 0.38)) < 1.3;
  const legR = y >= 5 && y <= 27 && Math.abs(x - (15.5 + (y - 5) * 0.38)) < 1.3;
  const bar = x >= 5 && x <= 27 && Math.abs(y - (18 + (x - 15.5) * 0.1)) < 1.2;
  if (ring || legL || legR || bar) {
    if (hash2(x, y) < 0.14) return [0, 0, 0, 0]; // patchy spray
    const n = (rng() - 0.5) * 22;
    return [188 + (ring ? -10 : 0) + n, 42, 38, 255];
  }
  if (x === 24 && y > 21 && y < 24 + hash2(7, 3) * 5) return [176, 38, 34, 255]; // drip
  return [0, 0, 0, 0];
};

// 32x32 damp and mold: dark blotch densest at the bottom (rising damp), a
// dithered fringe and green mold specks.
const decalDamp = (x, y, s, rng) => {
  const density = 0.15 + (y / s) * 0.75;                  // denser toward bottom
  const blotch = Math.sin(x * 0.6) * 3 + Math.sin(x * 0.23 + 2) * 4;
  if (hash2(x, y) < density + blotch * 0.02) {
    const n = (rng() - 0.5) * 12;
    if (hash2(x * 3, y * 3) < 0.12) return [74 + n, 92 + n, 52, 255]; // mold
    const deep = y / s;
    return [86 - deep * 24 + n, 82 - deep * 22 + n, 68 - deep * 18 + n, 255];
  }
  return [0, 0, 0, 0];
};

// 16x16 paper notice with tear-off phone strips along the bottom, some
// already torn away.
const decalAds = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 8;
  if (x < 2 || x > 13 || y < 1 || y > 13) return [0, 0, 0, 0];
  if (y >= 10) {                                          // tear-off fringe
    const strip = (x - 2) >> 1;
    if (hash2(strip, 7) < 0.4) return [0, 0, 0, 0];       // torn off
    if ((x - 2) & 1) return [188 + n, 184 + n, 172 + n, 255]; // strip gap
    return [226 + n, 222 + n, 208 + n, 255];
  }
  if (y === 1 || y === 9 || x === 2 || x === 13) return [190 + n, 186 + n, 174 + n, 255];
  const line = (y & 1) === 0 && x > 3 && x < 12 && hash2(x, y) < 0.7;
  return line ? [110, 110, 108, 255] : [232 + n, 228 + n, 214 + n, 255];
};

// 32x64 zebra-crossing band: wide worn white stripes with dirt tracked
// through the paint (lay flat on asphalt; R turns it).
const decalZebra = (x, y, s, rng) => {
  const stripe = (y >> 3) & 1;
  if (!stripe) return [0, 0, 0, 0];
  if (hash2(x, y) < 0.06) return [0, 0, 0, 0];            // worn through
  const ly = y & 7;
  const edgeWear = (ly === 0 || ly === 7) && hash2(x * 3, y) < 0.25;
  if (edgeWear) return [0, 0, 0, 0];
  const n = (rng() - 0.5) * 16;
  const tyre = hash2(x >> 2, 5) < 0.14 ? -30 : 0;         // tyre grime bands
  return [214 + tyre + n, 216 + tyre + n, 218 + tyre + n, 255];
};

// 32x32 hung rug: deep-red field, navy border, cream diamond medallions and
// end fringe — trzepak courtyard flavor.
const decalRug = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 10;
  if (y === 0 || y === 31) {                              // fringe rows
    return (x & 1) ? [206 + n, 196 + n, 172, 255] : [0, 0, 0, 0];
  }
  if (x < 1 || x > 30) return [0, 0, 0, 0];
  if (x < 4 || x > 27 || y < 4 || y > 27) return [38 + n, 46, 92, 255]; // navy border
  const dx = Math.abs((x - 15.5 + 8) % 16 - 8);           // two diamond medallions
  const dy = Math.abs(y - 15.5);
  if (dx / 5 + dy / 7 < 1) {
    if (dx / 5 + dy / 7 > 0.72) return [206 + n, 192 + n, 160, 255]; // cream outline
    return [150 + n, 38, 40, 255];
  }
  if (((x + y) & 7) === 0) return [110 + n, 30, 34, 255]; // field pattern ticks
  return [128 + n, 32, 36, 255];                          // madder-red field
};

// 16x16 party leftovers: a green bottle, a tipped brown one, scattered caps.
const decalBottles = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 12;
  if (y >= 3 && y <= 5 && x >= 2 && x <= 9) {             // green bottle, lying
    if (x >= 8) return y === 4 ? [72 + n, 110, 62, 255] : [0, 0, 0, 0]; // neck
    if (y === 3) return [118 + n, 158, 104, 255];         // glass highlight
    return [58 + n, 96, 52, 255];
  }
  const u = x - (y - 8);                                  // brown bottle, tilted
  if (y >= 8 && y <= 10 && u >= 1 && u <= 8) {
    if (u >= 7) return y === 9 ? [122 + n, 84, 44, 255] : [0, 0, 0, 0];
    if (y === 8) return [140 + n, 100, 56, 255];
    return [96 + n, 62, 30, 255];
  }
  for (const [bx, by, r, g, b] of [[12, 4, 196, 38, 34], [4, 13, 208, 178, 52], [12, 12, 178, 182, 188]]) {
    if (Math.abs(x - bx) <= 1 && Math.abs(y - by) <= 1) {
      if (x === bx - 1 && y === by - 1) return [r + 40, g + 40, b + 40, 255]; // glint
      return [r + n, g, b, 255];                          // bottle caps
    }
  }
  return [0, 0, 0, 0];
};

// 16x16 lace firanka: white curtain with an open net weave and a scalloped
// hem — pin it on glass to make a block read as an inhabited flat.
const decalCurtain = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 8;
  if (y <= 1) return [228 + n, 230 + n, 232 + n, 255];    // gathered top
  const hem = 12 + Math.sin(x * 1.15 + 0.7) * 2;          // scalloped bottom
  if (y > hem) return [0, 0, 0, 0];
  if (y > hem - 1.2) return [232 + n, 234 + n, 236 + n, 255]; // hem edge
  const net = ((x + y) % 5 === 0) || ((x - y + 40) % 5 === 0); // diamond mesh
  if (net) return [224 + n, 228 + n, 232 + n, 255];
  return [0, 0, 0, 0];
};

// 16x64 chalk hopscotch: worn white outlines — single squares, a double,
// and the rounded "niebo" at the top (lay flat on paving; R turns it).
const decalHopscotch = (x, y, s, rng) => {
  if (hash2(x, y) < 0.3) return [0, 0, 0, 0];             // chalk wears through
  const n = (rng() - 0.5) * 20;
  const chalk = [206 + n, 210 + n, 214 + n, 255];
  const box = (x0, y0, x1, y1) =>
    (inRect(x, y, x0, y0, x1, y0) || inRect(x, y, x0, y1, x1, y1) ||
     inRect(x, y, x0, y0, x0, y1) || inRect(x, y, x1, y0, x1, y1));
  // niebo: semicircle arc at the top
  const d = Math.hypot(x - 7.5, y - 16);
  if (y <= 16 && Math.abs(d - 6.5) < 0.9) return chalk;
  if (box(1, 17, 14, 31)) return chalk;                   // single
  if (box(1, 32, 14, 46) || (x === 7 && y >= 32 && y <= 46)) return chalk; // double
  if (box(1, 47, 14, 62)) return chalk;                   // single
  return [0, 0, 0, 0];
};

// 16x64 steel ladder: two weathered side rails with a rung every half metre
// and rust blooming around the welds. Climbable in the game (WalkControls
// reads the decal's `climbable` flag), so the art reads as hardware, not
// graffiti: solid rails, cutout gaps between the rungs.
const decalLadder = (x, y, s, rng) => {
  const n = (rng() - 0.5) * 14;
  const rail = x === 2 || x === 3 ? 2 : x === 12 || x === 13 ? 12 : 0;
  const rung = (y + 4) % 8 < 2 && x > 3 && x < 12;
  if (!rail && !rung) return [0, 0, 0, 0];
  const rust = hash2(x * 3, y * 3) < 0.14;
  if (rust) return [122 + n, 68 + n * 0.5, 40, 255];
  if (rail) {
    const lit = x === rail; // left texel of each rail catches the light
    const g = (lit ? 148 : 108) + n;
    return [g, g + 4, g + 10, 255];
  }
  const top = (y + 4) % 8 < 1; // upper texel row of the rung, in the light
  const g = (top ? 158 : 96) + n;
  return [g, g + 4, g + 10, 255];
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
  panel,
  plaster_pastel: plasterPastel,
  lastryko,
  kiosk,
  blacha,
  paving,
  brick_sooty: brickSooty,
  lino,
  neon_white: neonWhite,
  neon_white_off: neonWhiteOff,
  pickets,
  plaster_yellow: plasterYellow,
  plaster_orange: plasterOrange,
  plaster_green: plasterGreen,
  plaster_blue: plasterBlue,
  brick_yellow: brickYellow,
  papa,
  garage_brown: garageBrown,
  garage_green: garageGreen,
  garage_red: garageRed,
  window_white: windowWhite,
  balcony_rail: balconyRail,
  door_wood: doorWood,
  door_white: doorWhite,
  door_shop: doorShop,
  door_steel: doorSteel,
  door_blok: doorBlok,
  sidelight: sidelightPane,
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
  decal_cigs: decalCigs,
  decal_poop: decalPoop,
  decal_seeds: decalSeeds,
  decal_graffiti: decalGraffiti,
  decal_stop: decalStop,
  decal_arrow: decalArrow,
  decal_poster: decalPoster,
  decal_sklep: decalSklep,
  decal_club: decalClub,
  decal_hwdp: decalHwdp,
  decal_kotwica: decalKotwica,
  decal_anarchy: decalAnarchy,
  decal_damp: decalDamp,
  decal_ads: decalAds,
  decal_zebra: decalZebra,
  decal_rug: decalRug,
  decal_bottles: decalBottles,
  decal_curtain: decalCurtain,
  decal_hopscotch: decalHopscotch,
  decal_ladder: decalLadder,
  decal_domofon: decalDomofon,
  decal_switch: decalSwitch,
  decal_switch_on: decalSwitchOn,
});

// Runtime tiles (text signs): registered after module load, rendered by the
// same pipeline. The generator closes over its own art, the span is carried
// here because TILE_SPANS is computed once from the static registries.
const RUNTIME_TILES = new Map(); // name -> { gen, span }

/** Register (or replace) a runtime tile generator. */
export function registerRuntimeTile(name, gen, span = [1, 1]) {
  RUNTIME_TILES.set(name, { gen, span: [span[0], span[1]] });
}

/** True if the name resolves to a registered runtime tile. */
export function hasRuntimeTile(name) {
  return RUNTIME_TILES.has(name);
}

/** Names of every registered tile, in deterministic order. */
export function listTileNames() {
  return [...Object.keys(GENERATORS), ...RUNTIME_TILES.keys()];
}

// Atlas-slot span per tile name, derived from the decal registry (a decal
// spanning w x h cells has w x h slots of art, so texel density matches
// blocks) and from block defs carrying tileSpan (doors: one 2x4-slot art
// across the whole leaf). Plain tiles are 1x1.
const TILE_SPANS = (() => {
  const spans = {};
  for (const id of listDecalIds()) {
    const d = getDecal(id);
    if (d.span && (d.span[0] > 1 || d.span[1] > 1)) spans[d.tile] = [d.span[0], d.span[1]];
  }
  for (const id of listBlockIds()) {
    const b = getBlock(id);
    if (b?.tileSpan && (b.tileSpan[0] > 1 || b.tileSpan[1] > 1) && typeof b.tiles === 'string') {
      spans[b.tiles] = [b.tileSpan[0], b.tileSpan[1]];
    }
  }
  return spans;
})();

/** Atlas-slot span [cols, rows] of a tile (1x1 for everything but big decals). */
export function tileSpan(name) {
  return RUNTIME_TILES.get(name)?.span ?? TILE_SPANS[name] ?? [1, 1];
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
  const gen = GENERATORS[name] ?? RUNTIME_TILES.get(name)?.gen;
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
