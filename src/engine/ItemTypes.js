// ItemTypes.js — data model for placeable "items" (micro-voxel objects).
//
// An item is a small voxel sculpture built in the F2 item editor. It has a
// world footprint (small = 0.5 m, big = 1 m, matching the two voxel sizes) and
// is made of colored micro-voxels laid out on a fixed grid. It may carry one
// light source (color + strength in game meters). A "solid" item blocks the
// player in test run; a "traversable" one lets them walk through.
//
// Pure module (no three.js / DOM), so it can be unit tested in Node.

import { CELL_SIZE } from './Space.js';

export const ITEM_FORMAT = 'voxelitem';
export const ITEM_VERSION = 1;
/** Micro-voxels per axis of the item grid (grid is MICRO_GRID^3 cells). */
export const MICRO_GRID = 8;

/** World footprint of each item size, in meters. */
export const ITEM_WORLD_SIZE = Object.freeze({ small: 0.5, big: 1.0 });

/** Edge length of one micro-voxel in world meters for a given item size. */
export function microCellSizeFor(size) {
  const m = ITEM_WORLD_SIZE[size];
  if (!m) throw new Error(`Unknown item size "${size}"`);
  return m / MICRO_GRID;
}

/** Rotate a micro-grid point (px, pz) by `yaw` radians around the grid's
 *  vertical centre axis (the footprint centre). Positions stay inside the
 *  grid. Used for placed-item yaw (R in the world editor). */
export function rotateMicroPoint(px, pz, yaw) {
  const c = MICRO_GRID / 2;
  const dx = px - c;
  const dz = pz - c;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [c + dx * cos - dz * sin, c + dx * sin + dz * cos];
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
 * @property {'small'|'big'} size    world footprint of the placed item
 * @property {boolean} solid         true = blocks the player (test run), false = traversable
 * @property {{x:number,y:number,z:number,color:[number,number,number]}[]} microVoxels
 * @property {{x:number,y:number,z:number,color:[number,number,number],strength:number}|null} light
 */

/** A blank item model. */
export function emptyItem(name = 'New Item') {
  return { id: null, name, size: 'small', solid: true, microVoxels: [], light: null };
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
      size: item.size,
      solid: item.solid !== false,
      microVoxels: item.microVoxels,
      light: item.light,
    },
    null,
    2,
  );
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
  const microVoxels = (Array.isArray(data.microVoxels) ? data.microVoxels : [])
    .filter(
      (v) =>
        v && Number.isInteger(v.x) && Number.isInteger(v.y) && Number.isInteger(v.z) &&
        Array.isArray(v.color) && v.color.length >= 3,
    )
    .map((v) => ({ x: v.x, y: v.y, z: v.z, color: [v.color[0], v.color[1], v.color[2]] }));
  const light =
    data.light && Array.isArray(data.light.color) && data.light.color.length >= 3
      ? {
          x: Math.floor(data.light.x),
          y: Math.floor(data.light.y),
          z: Math.floor(data.light.z),
          color: [data.light.color[0], data.light.color[1], data.light.color[2]],
          strength: typeof data.light.strength === 'number' ? Math.min(7.5, Math.max(0.5, data.light.strength)) : 3,
        }
      : null;
  const item = {
    id: typeof data.id === 'string' && data.id ? data.id : null,
    name: typeof data.name === 'string' && data.name ? data.name : 'Item',
    size: data.size === 'big' ? 'big' : 'small',
    solid: data.solid !== false,
    microVoxels,
    light,
  };
  return { item, errors };
}
