// itemConvert.js — move a voxel sculpture between the two catalogues.
//
// The F2 "Object Catalogue" (ItemRegistry / ItemTypes) and the F3 "Equipment
// Catalogue" (EquipmentRegistry) hold the same kind of art — colored
// micro-voxels on a 6.25 cm lattice — in two different envelopes:
//
//   object     footprint `cells` [w,h,d] in 0.5 m cells, build volume
//              cells × MICRO_GRID(8); carries `solid` + an optional light
//   equipment  explicit build volume `grid` (4..32 cells per axis); carries
//              kind / grip / stats / weapon-ammo-armor fields
//
// Because the voxel size is identical on both sides the shape transfers 1:1;
// only the envelope is rebuilt. What each side cannot express is dropped and
// reported so the caller can say so: an object's light has no equipment
// equivalent, and a shape longer than 32 cells on an axis does not fit an
// equipment build volume (its overhang is cropped).
//
// Pure module (no three.js / DOM) so it can be unit tested in Node.

import { MICRO_GRID, MAX_ITEM_CELLS } from './ItemTypes.js';
import {
  emptyEquipItem,
  normalizeGrid,
  normalizeKind,
  MIN_EQUIP_GRID,
  MAX_EQUIP_GRID,
} from './EquipmentRegistry.js';

/** Tight bounding box of a micro-voxel list: {min:[x,y,z], dims:[w,h,d]},
 *  or null when there is nothing to measure. */
export function voxelBounds(voxels) {
  const list = Array.isArray(voxels) ? voxels : [];
  if (!list.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of list) {
    min[0] = Math.min(min[0], v.x); max[0] = Math.max(max[0], v.x);
    min[1] = Math.min(min[1], v.y); max[1] = Math.max(max[1], v.y);
    min[2] = Math.min(min[2], v.z); max[2] = Math.max(max[2], v.z);
  }
  return { min, dims: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1] };
}

/** Re-seat a shape into a new build volume: the bounding box is centred on
 *  x/z and rests on the floor (y = 0), which is what both editors expect of a
 *  freshly loaded sculpture. Voxels that still fall outside `grid` (only
 *  possible when the shape is larger than the volume) are cropped.
 *  @returns {{microVoxels: object[], dropped: number}} */
export function refitVoxels(voxels, bounds, grid) {
  const out = [];
  if (!bounds) return { microVoxels: out, dropped: 0 };
  const off = [
    Math.floor((grid[0] - bounds.dims[0]) / 2) - bounds.min[0],
    -bounds.min[1],
    Math.floor((grid[2] - bounds.dims[2]) / 2) - bounds.min[2],
  ];
  let dropped = 0;
  for (const v of voxels) {
    const x = v.x + off[0];
    const y = v.y + off[1];
    const z = v.z + off[2];
    if (x < 0 || y < 0 || z < 0 || x >= grid[0] || y >= grid[1] || z >= grid[2]) {
      dropped++;
      continue;
    }
    out.push({ x, y, z, color: [v.color[0], v.color[1], v.color[2]] });
  }
  return { microVoxels: out, dropped };
}

/**
 * Placeable object → equippable item (F2 → F3). The build volume shrinks to
 * the sculpture's bounding box (clamped to the equipment limits), so a 1×1×1
 * object built in a corner still lands centred in the F3 editor.
 *
 * The copy has no id — the caller assigns one that is free in *both*
 * registries, since world placements share one id space.
 *
 * @param {object} item  an ItemDef from the object catalogue
 * @param {{kind?: string, name?: string}} [opts]  kind defaults to 'quest'
 *   (a pickable prop); pass 'weapon' / 'material' / 'ammo' / 'armor' to land
 *   in another F3 category.
 * @returns {{item: object, dropped: number, lightLost: boolean}}
 */
export function objectToEquip(item, { kind = 'quest', name } = {}) {
  const src = Array.isArray(item?.microVoxels) ? item.microVoxels : [];
  const bounds = voxelBounds(src);
  const dims = bounds?.dims ?? [MIN_EQUIP_GRID, MIN_EQUIP_GRID, MIN_EQUIP_GRID];
  const grid = normalizeGrid(
    dims.map((d) => Math.max(MIN_EQUIP_GRID, Math.min(MAX_EQUIP_GRID, d))),
  );
  const { microVoxels, dropped } = refitVoxels(src, bounds, grid);
  return {
    item: {
      ...emptyEquipItem(name ?? item?.name ?? 'New Item'),
      kind: normalizeKind(kind),
      grid,
      microVoxels,
    },
    dropped,
    lightLost: !!item?.light,
  };
}

/**
 * Equippable item → placeable object (F3 → F2). The footprint is the smallest
 * whole number of 0.5 m cells that holds the sculpture, and the shape is
 * re-seated centred on the floor of that volume.
 *
 * The copy has no id (see objectToEquip). Kind, grip, stats and the weapon /
 * ammo / armor profile have no object equivalent and are dropped.
 *
 * @param {object} equip  an EquipDef from the equipment catalogue
 * @param {{name?: string, solid?: boolean}} [opts]
 * @returns {{item: object, dropped: number}}
 */
export function equipToObject(equip, { name, solid = true } = {}) {
  const src = Array.isArray(equip?.microVoxels) ? equip.microVoxels : [];
  const bounds = voxelBounds(src);
  const dims = bounds?.dims ?? [1, 1, 1];
  const cells = dims.map((d) =>
    Math.max(1, Math.min(MAX_ITEM_CELLS, Math.ceil(d / MICRO_GRID))),
  );
  const grid = cells.map((c) => c * MICRO_GRID);
  const { microVoxels, dropped } = refitVoxels(src, bounds, grid);
  return {
    item: {
      id: null,
      name: name ?? equip?.name ?? 'New Item',
      cells,
      solid: solid !== false,
      microVoxels,
      light: null,
    },
    dropped,
  };
}
