// Doors.js — open/close state for door blocks.
//
// A door is ONE voxel spanning SIZE.DOOR cells. Its state is the block id
// itself: defs come in closed/open pairs linked by doorOpen/doorClosed
// (the same trick as the blinking lights), so toggling swaps the id in
// place, pushes a light-edit record and dirties the chunks — the renderer
// picks both up on its normal per-frame sync. The open phase is `passable`
// (collision facades skip it) and `shootThrough`.
//
// Extension points: locks (keys, buttons, switches) gate canToggle; bigger
// doors add a size in VoxelShape.SIZES plus defs with their own tileSpan.

import { getBlock } from './VoxelTypes.js';
import { cellsFor } from './VoxelShape.js';

/** Block id of the other phase (open<->closed), or null for non-doors. */
export function doorToggleId(type) {
  const def = getBlock(type);
  return def?.doorOpen ?? def?.doorClosed ?? null;
}

/** True for any door voxel, either phase. */
export function isDoorVoxel(voxel) {
  return !!voxel && doorToggleId(voxel.type) != null;
}

/** True when the voxel is a door standing open. */
export function isOpenDoor(voxel) {
  return !!voxel && !!getBlock(voxel.type)?.doorClosed;
}

/** Whether an actor may toggle a door. Mobs never can — a closed door is a
 *  wall to them. Locked doors (key items, wired buttons) will hook in here. */
export function canToggle(voxel, actor = 'player') {
  return actor === 'player' && isDoorVoxel(voxel);
}

/**
 * Swap a door voxel to its other phase in place. The voxel object is shared
 * by all its cells, so every cell updates at once; footprint cells never
 * change (only the leaf geometry does), so occupancy stays consistent.
 * @returns {boolean} true when the voxel was a door and got toggled
 */
export function toggleDoor(world, voxel) {
  const next = doorToggleId(voxel?.type);
  if (!next) return false;
  voxel.type = next;
  const [ax, ay, az] = voxel.anchor;
  world.edits.push({
    cells: [...cellsFor(ax, ay, az, voxel.size, voxel.rotation ?? 0)],
    remove: false,
    type: next,
  });
  world.markDirty(ax, ay, az);
  return true;
}
