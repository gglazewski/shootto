// itemPick.js — world facade that makes placed items raycastable.
//
// Items occupy cells (World.itemCells) but are not voxels in World.cells, so a
// plain raycastVoxel never hits them. This facade presents a "world" whose
// get(x,y,z) returns either the voxel or a synthetic { item: true, ... } cell,
// letting the standard DDA raycaster aim at items too.

import { raycastVoxel, worldToCell } from '../engine/VoxelRaycaster.js';
import { getItem } from '../engine/ItemRegistry.js';

/** @returns {object} a world-like facade over voxels + placed items */
export function itemAwareWorld(world) {
  return {
    get(x, y, z) {
      const v = world.get(x, y, z);
      if (v) return v;
      const item = world.itemAt(x, y, z);
      return item ? { item: true, itemId: item.itemId, size: item.size, anchor: item.anchor } : null;
    },
  };
}

/** World facade for player collision (test run): voxels plus BLOCKING placed
 *  items are solid; traversable items are ignored, so the player walks through.
 *  The solid flag lives on the registered item, so re-saving an item in the F2
 *  editor updates every placement immediately. */
export function collisionWorld(world) {
  return {
    get(x, y, z) {
      const v = world.get(x, y, z);
      if (v) return v;
      const item = world.itemAt(x, y, z);
      return item && getItem(item.itemId)?.solid !== false ? item : null;
    },
    bounds: () => world.bounds(),
  };
}

/**
 * Pick the first voxel or item under the camera's aim ray.
 * @param {import('three').Vector3} [dir]  aim direction; defaults to the
 *   camera's forward so callers (weapon spread) can nudge the ray.
 * @returns {{cell:[number,number,number], normal:[number,number,number], dist:number}|null}
 *   when the hit cell is an item, the returned object's `item` flag is set.
 */
export function itemAwarePick(world, THREE, camera, maxCells, dir) {
  const origin = worldToCell(camera.position.toArray());
  const d = dir ?? camera.getWorldDirection(new THREE.Vector3());
  return raycastVoxel(itemAwareWorld(world), origin, [d.x, d.y, d.z], maxCells);
}
