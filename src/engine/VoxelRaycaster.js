// VoxelRaycaster.js — Amanatides & Woo grid traversal.
//
// Pure (no three.js): finds the first voxel a ray hits in a world that only
// needs to implement get(x, y, z). Coordinates are in cell units (0.5m).
// World-unit constants and transforms live in Space.js and are re-exported
// here for back-compat.

import { CELL_SIZE, MAX_RAY_DISTANCE, worldToCell, cellCenterToWorld, cellMinToWorld } from './Space.js';

export { CELL_SIZE, MAX_RAY_DISTANCE, worldToCell, cellCenterToWorld, cellMinToWorld };

/**
 * @param {object} world must expose get(x, y, z) -> voxel | null
 * @param {[number,number,number]} origin origin in cell units
 * @param {[number,number,number]} dir   normalized direction
 * @param {number} [maxDist] max cells to walk
 * @returns {{cell:[number,number,number], normal:[number,number,number], dist:number}|null}
 */
export function raycastVoxel(world, origin, dir, maxDist = MAX_RAY_DISTANCE) {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;

  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  // distance to the first plane crossed on each axis
  const fracX = dx !== 0 ? ((dx > 0 ? x + 1 - ox : ox - x) * tDeltaX) : Infinity;
  const fracY = dy !== 0 ? ((dy > 0 ? y + 1 - oy : oy - y) * tDeltaY) : Infinity;
  const fracZ = dz !== 0 ? ((dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ) : Infinity;

  let tMaxX = fracX, tMaxY = fracY, tMaxZ = fracZ;
  let normal = [0, 0, 0];
  let t = 0;

  for (let i = 0; i < maxDist; i++) {
    const hit = world.get(x, y, z);
    if (hit) {
      return { cell: [x, y, z], normal, dist: t };
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      normal = [-stepX, 0, 0];
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      normal = [0, -stepY, 0];
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      normal = [0, 0, -stepZ];
    }
  }
  return null;
}
