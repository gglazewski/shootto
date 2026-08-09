// ItemTypes.js — data model for placeable "items" (micro-voxel objects).
//
// An item is a voxel sculpture built in the F2 item editor. Its world
// footprint is `cells` = [w, h, d] in 0.5 m world cells (a kitchen chair is
// 1×2×1, a big closet 2×4×1), and it is made of colored micro-voxels laid out
// on a cells×MICRO_GRID grid at a uniform 0.0625 m resolution. It may carry
// one light source (color + strength in game meters). A "solid" item blocks
// the player in test run; a "traversable" one lets them walk through.
//
// Version 1 files stored `size: 'small'|'big'` instead — loaders migrate them
// losslessly (small → 1×1×1; big → 2×2×2 with micro-voxels upscaled ×2).
//
// Pure module (no three.js / DOM), so it can be unit tested in Node.

import { CELL_SIZE } from './Space.js';

export const ITEM_FORMAT = 'voxelitem';
export const ITEM_VERSION = 2;
/** Micro-voxels per 0.5 m world cell along each axis. */
export const MICRO_GRID = 8;
/** World edge of one micro-voxel in meters — uniform across all items. */
export const MICRO_SIZE = CELL_SIZE / MICRO_GRID;
/** Largest footprint edge in cells (8 cells = 4 m). */
export const MAX_ITEM_CELLS = 8;

/** Clamp a raw cells spec to a valid [w, h, d] footprint. */
export function normalizeCells(cells) {
  const c = Array.isArray(cells) ? cells : [1, 1, 1];
  return [0, 1, 2].map((i) => {
    const n = Math.round(Number(c[i]));
    return Number.isFinite(n) ? Math.max(1, Math.min(MAX_ITEM_CELLS, n)) : 1;
  });
}

/** Footprint of an item def in cells along [x, y, z]. Equipment defs carry
 *  no cells and place at a single cell. */
export function cellsOf(item) {
  return normalizeCells(item?.cells);
}

/** Micro-voxel build volume [gx, gy, gz] of a def. Equipment defs carry an
 *  explicit grid; placeable items derive it from their footprint. */
export function gridOf(item) {
  if (Array.isArray(item?.grid)) return [...item.grid];
  return cellsOf(item).map((c) => c * MICRO_GRID);
}

/** Coerce a placement footprint spec — a cells array or a legacy
 *  'small'/'big' string — to a cells triple. */
export function footprintCells(spec) {
  if (spec === 'big') return [2, 2, 2];
  if (spec === 'small' || spec == null) return [1, 1, 1];
  return normalizeCells(spec);
}

/** Quarter-turn count (0..3) closest to a yaw in radians. */
export function quarterTurns(yaw) {
  return ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;
}

/** Rotate a micro-grid point (px, pz) by `yaw` radians around the build
 *  volume's vertical centre axis. On odd quarter turns the rotated footprint
 *  swaps its x/z extents (like doors), so the result is re-centred into the
 *  swapped volume — positions stay inside the rotated bounding box. Used for
 *  placed-item yaw (R in the world editor). `gx`/`gz` are the build volume's
 *  micro dims (default: the legacy 8³ grid). */
export function rotateMicroPoint(px, pz, yaw, gx = MICRO_GRID, gz = MICRO_GRID) {
  const dx = px - gx / 2;
  const dz = pz - gz / 2;
  const odd = quarterTurns(yaw) & 1;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [(odd ? gz : gx) / 2 + dx * cos - dz * sin, (odd ? gx : gz) / 2 + dx * sin + dz * cos];
}

/** Map a light strength in game meters to a 0..15 block-light level
 *  (the light field fades 1 per 0.5 m cell). */
export function lightLevelForMeters(meters) {
  return Math.max(0, Math.min(15, Math.round(meters / CELL_SIZE)));
}

/** A reasonable selection of voxel colors (name + rgb). */
export const ITEM_PALETTE = Object.freeze([
  { name: 'Red', color: [220, 40, 30] },
  { name: 'Dark Red', color: [140, 25, 20] },
  { name: 'Orange', color: [230, 120, 25] },
  { name: 'Yellow', color: [235, 205, 40] },
  { name: 'Lime', color: [150, 210, 50] },
  { name: 'Green', color: [55, 160, 55] },
  { name: 'Dark Green', color: [30, 105, 35] },
  { name: 'Cyan', color: [40, 185, 190] },
  { name: 'Light Blue', color: [90, 165, 235] },
  { name: 'Blue', color: [45, 90, 200] },
  { name: 'Dark Blue', color: [30, 50, 130] },
  { name: 'Purple', color: [150, 70, 200] },
  { name: 'Magenta', color: [210, 60, 150] },
  { name: 'Pink', color: [235, 140, 175] },
  { name: 'Brown', color: [140, 85, 45] },
  { name: 'Dark Brown', color: [90, 55, 30] },
  { name: 'White', color: [235, 235, 230] },
  { name: 'Light Gray', color: [170, 170, 170] },
  { name: 'Gray', color: [115, 115, 115] },
  { name: 'Black', color: [40, 40, 40] },
]);

/** A reasonable selection of light colors. */
export const LIGHT_COLORS = Object.freeze([
  { name: 'Warm White', color: [255, 224, 178] },
  { name: 'Cool White', color: [200, 224, 255] },
  { name: 'Orange', color: [255, 150, 46] },
  { name: 'Red', color: [255, 66, 52] },
  { name: 'Green', color: [88, 255, 110] },
  { name: 'Blue', color: [86, 138, 255] },
  { name: 'Purple', color: [176, 108, 255] },
]);

/**
 * @typedef {Object} ItemDef
 * @property {string|null} id        unique id (file name / registry key)
 * @property {string} name           human readable name
 * @property {[number,number,number]} cells  world footprint in 0.5 m cells [w, h, d]
 * @property {boolean} solid         true = blocks the player (test run), false = traversable
 * @property {{x:number,y:number,z:number,color:[number,number,number]}[]} microVoxels
 * @property {{x:number,y:number,z:number,color:[number,number,number],strength:number}|null} light
 */

/** A blank item model. */
export function emptyItem(name = 'New Item') {
  return { id: null, name, cells: [1, 1, 1], solid: true, microVoxels: [], light: null };
}

/** Slugify a name into a safe id base (lowercase alnum + underscores). */
export function slugifyName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
}

/** Serialize an item to the on-disk JSON format. */
export function serializeItem(item) {
  return JSON.stringify(
    {
      format: ITEM_FORMAT,
      version: ITEM_VERSION,
      id: item.id ?? null,
      name: item.name,
      cells: cellsOf(item),
      solid: item.solid !== false,
      microVoxels: item.microVoxels,
      light: item.light,
    },
    null,
    2,
  );
}

/** Normalize raw item data of any version into current {cells, microVoxels,
 *  light}. Version-1 sizes migrate losslessly: 'small' → 1×1×1 (voxels
 *  unchanged), 'big' → 2×2×2 with every micro-voxel upscaled ×2 (its 0.125 m
 *  voxels keep their world size at the uniform 0.0625 m resolution).
 *  Malformed voxels and voxels outside the build volume are dropped. */
export function normalizeItemData(data) {
  const legacyBig = !Array.isArray(data.cells) && data.size === 'big';
  const cells = Array.isArray(data.cells) ? normalizeCells(data.cells) : legacyBig ? [2, 2, 2] : [1, 1, 1];
  const scale = legacyBig ? 2 : 1;
  const [gx, gy, gz] = cells.map((c) => c * MICRO_GRID);
  const microVoxels = [];
  for (const v of Array.isArray(data.microVoxels) ? data.microVoxels : []) {
    if (!v || !Number.isInteger(v.x) || !Number.isInteger(v.y) || !Number.isInteger(v.z)) continue;
    if (!Array.isArray(v.color) || v.color.length < 3) continue;
    for (let dx = 0; dx < scale; dx++) {
      for (let dy = 0; dy < scale; dy++) {
        for (let dz = 0; dz < scale; dz++) {
          const x = v.x * scale + dx;
          const y = v.y * scale + dy;
          const z = v.z * scale + dz;
          if (x >= 0 && x < gx && y >= 0 && y < gy && z >= 0 && z < gz) {
            microVoxels.push({ x, y, z, color: [v.color[0], v.color[1], v.color[2]] });
          }
        }
      }
    }
  }
  const light =
    data.light && Array.isArray(data.light.color) && data.light.color.length >= 3
      ? {
          x: Math.floor(data.light.x) * scale,
          y: Math.floor(data.light.y) * scale,
          z: Math.floor(data.light.z) * scale,
          color: [data.light.color[0], data.light.color[1], data.light.color[2]],
          strength: typeof data.light.strength === 'number' ? Math.min(7.5, Math.max(0.5, data.light.strength)) : 3,
        }
      : null;
  return { cells, microVoxels, light };
}

/** @returns {{item: ItemDef|null, errors: string[]}} */
export function deserializeItem(text) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { item: null, errors: [`Invalid JSON: ${e.message}`] };
  }
  if (!data || data.format !== ITEM_FORMAT) {
    return { item: null, errors: ['Not a voxelitem file'] };
  }
  const item = {
    id: typeof data.id === 'string' && data.id ? data.id : null,
    name: typeof data.name === 'string' && data.name ? data.name : 'Item',
    solid: data.solid !== false,
    ...normalizeItemData(data),
  };
  return { item, errors };
}
