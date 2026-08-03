// Physics.js — pure AABB-vs-voxel collision helpers.
//
// The world is a grid of 0.5 m cells (CELL_SIZE); every occupied cell is solid
// regardless of whether it belongs to a SMALL or BIG voxel, so per-cell checks
// are correct for both sizes. These functions are deliberately free of
// three.js/DOM so they can be unit tested in Node.
//
// AABB convention: { minX, minY, minZ, maxX, maxY, maxZ } in world meters.

import { CELL_SIZE } from './Space.js';

export const GROUND_EPS = 0.002;

/** World-coordinate cell indices spanned by an AABB, inclusive per axis. */
export function aabbCells(minX, minY, minZ, maxX, maxY, maxZ) {
  const x0 = Math.floor(minX / CELL_SIZE);
  const x1 = Math.ceil(maxX / CELL_SIZE) - 1;
  const y0 = Math.floor(minY / CELL_SIZE);
  const y1 = Math.ceil(maxY / CELL_SIZE) - 1;
  const z0 = Math.floor(minZ / CELL_SIZE);
  const z1 = Math.ceil(maxZ / CELL_SIZE) - 1;
  const out = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) out.push([x, y, z]);
  return out;
}

/** True when the AABB overlaps any solid cell. */
export function collides(world, box) {
  const cells = aabbCells(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
  for (const [x, y, z] of cells) {
    if (world.get(x, y, z)) return true;
  }
  return false;
}

const AXIS = { x: 0, y: 1, z: 2 };
const MIN = ['minX', 'minY', 'minZ'];
const MAX = ['maxX', 'maxY', 'maxZ'];

/**
 * Move an AABB along one axis by `delta` meters and resolve collisions by
 * snapping to the offending cell boundary. Returns { moved, hit }.
 * Mutates `box` in place.
 */
export function moveAxis(world, box, axis, delta) {
  if (delta === 0) return { moved: 0, hit: false };
  const i = AXIS[axis];
  const minK = MIN[i];
  const maxK = MAX[i];
  const startMin = box[minK];
  const startMax = box[maxK];
  box[minK] += delta;
  box[maxK] += delta;

  const cells = aabbCells(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
  let stop = null;
  for (const c of cells) {
    if (!world.get(c[0], c[1], c[2])) continue;
    const lo = c[i] * CELL_SIZE;
    const hi = (c[i] + 1) * CELL_SIZE;
    stop = stop === null ? (delta > 0 ? lo : hi) : delta > 0 ? Math.min(stop, lo) : Math.max(stop, hi);
  }
  if (stop === null) return { moved: delta, hit: false };

  const width = startMax - startMin;
  if (delta > 0) {
    box[maxK] = stop;
    box[minK] = stop - width;
  } else {
    box[minK] = stop;
    box[maxK] = stop + width;
  }
  return { moved: box[maxK] - startMax, hit: true };
}

/** True when a box shifted just below its feet touches anything (on ground). */
export function groundedAt(world, box) {
  const probe = {
    minX: box.minX,
    minY: box.minY - GROUND_EPS,
    minZ: box.minZ,
    maxX: box.maxX,
    maxY: box.maxY - GROUND_EPS,
    maxZ: box.maxZ,
  };
  return collides(world, probe);
}

/**
 * Move an AABB horizontally, automatically stepping up onto low obstacles
 * (up to `stepHeight`, e.g. 0.5 m blocks) when grounded. Tries the move at the
 * current height first; if it is blocked and a box raised by stepHeight fits
 * (no ceiling, no overlap at the destination) and gets further, that result is
 * used instead. Returns a new box. Does not mutate `box`.
 */
export function moveWithStep(world, box, dx, dz, stepHeight, grounded) {
  const moved = { ...box };
  const tx = moveAxis(world, moved, 'x', dx);
  const tz = moveAxis(world, moved, 'z', dz);
  if (!grounded || (!tx.hit && !tz.hit)) return moved;

  const raised = { ...box };
  if (moveAxis(world, raised, 'y', stepHeight).hit) return moved; // no headroom
  const rx = moveAxis(world, raised, 'x', dx);
  const rz = moveAxis(world, raised, 'z', dz);
  if (collides(world, raised)) return moved; // something in the way up top
  // Compare travel distance, not signed delta: `moved` is negative when moving
  // along -x/-z, so a step-up that clears the obstacle must be judged by |moved|.
  const improved =
    (tx.hit && Math.abs(rx.moved) > Math.abs(tx.moved)) ||
    (tz.hit && Math.abs(rz.moved) > Math.abs(tz.moved));
  return improved ? raised : moved;
}
