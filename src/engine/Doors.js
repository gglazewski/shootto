// Doors.js — open/close state for door blocks.
//
// A door is ONE voxel spanning SIZE.DOOR cells. Its state is the block id
// itself: defs come in closed/open pairs linked by doorOpen/doorClosed
// (the same trick as the blinking lights), so toggling swaps the id in
// place, pushes a light-edit record and dirties the chunks — the renderer
// picks both up on its normal per-frame sync. The open phase is `passable`
// (collision facades skip it) and `shootThrough`.
//
// Authored settings ride on the voxel itself (all additive, all persisted
// by the world/prefab serializers):
//   locked     — the door refuses to toggle (canToggle says no).
//   hinge      — which jamb the leaf pivots on: 'left' (the anchor-side end
//                of the leaf, the default and what every older map means) or
//                'right' (the far end).
//   unlockFlag — name of a game flag driving the lock: in the game the door
//                stays locked until the flag is raised (a quest accepting,
//                say) and unlocks the moment it is — see game/Reactions.js.
// The swing direction — which side of the wall the open leaf lands on — is
// the door's `rotation`: 0/2 stand the leaf along x and open toward +z/-z,
// 1/3 stand it along z and open toward +x/-x. Rotation 0 and 2 (and 1 and 3)
// have the same footprint and the same closed geometry, so flipping the
// swing is a pure re-mesh, never a re-placement.
//
// Extension points: keys/buttons/switches can gate canToggle further; bigger
// doors add a size in VoxelShape.SIZES plus defs with their own tileSpan.

import { getBlock } from './VoxelTypes.js';
import { cellsFor } from './VoxelShape.js';

/** Face the open leaf swings toward, indexed by rotation. */
const SWING_FACE = ['pz', 'px', 'nz', 'nx'];

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

/** True when the author locked this door in the editor. */
export function isDoorLocked(voxel) {
  return !!voxel?.locked;
}

/** Which jamb the leaf pivots on: 'left' (anchor-side end of the leaf) or
 *  'right' (far end). Doors saved before hinges existed read as 'left'. */
export function doorHinge(voxel) {
  return voxel?.hinge === 'right' ? 'right' : 'left';
}

/** Face the open leaf swings toward ('pz'|'px'|'nz'|'nx'). */
export function doorSwing(voxel) {
  return SWING_FACE[(voxel?.rotation ?? 0) & 3];
}

/** Whether an actor may toggle a door. Mobs never can — a closed door is a
 *  wall to them; a locked door is a wall to everyone. */
export function canToggle(voxel, actor = 'player') {
  return actor === 'player' && isDoorVoxel(voxel) && !isDoorLocked(voxel);
}

/**
 * Lock or unlock a door. Purely a gate on interaction — nothing about the
 * leaf's geometry changes, so no re-mesh is needed.
 * @returns {boolean} true when the voxel was a door and the flag changed
 */
export function setDoorLocked(voxel, locked) {
  if (!isDoorVoxel(voxel)) return false;
  if (isDoorLocked(voxel) === !!locked) return false;
  if (locked) voxel.locked = true;
  else delete voxel.locked;
  return true;
}

/**
 * Copy authored door settings from a saved/stamped entry onto a freshly
 * placed voxel. Non-doors, missing entries and default values are no-ops, so
 * this is safe to call for every block a loader places.
 * @returns {object|null} the voxel, for chaining
 */
export function applyDoorSettings(voxel, entry) {
  if (!entry || !isDoorVoxel(voxel)) return voxel;
  if (entry.locked) voxel.locked = true;
  if (entry.hinge === 'right') voxel.hinge = 'right';
  if (typeof entry.unlockFlag === 'string' && entry.unlockFlag) voxel.unlockFlag = entry.unlockFlag;
  return voxel;
}

/**
 * Set how a door opens: `hinge` ('left'|'right') picks the jamb it pivots on,
 * `swing` (a face id, or 'positive'|'negative') picks the side of the wall
 * the open leaf lands on. The swing is stored as the voxel's rotation, whose
 * parity — the axis the closed leaf stands along — is never touched, so the
 * footprint stays exactly where it was. Either field may be omitted to leave
 * it alone.
 * @returns {boolean} true when something changed (caller re-meshes)
 */
export function setDoorOpening(world, voxel, { hinge, swing } = {}) {
  if (!isDoorVoxel(voxel)) return false;
  let changed = false;

  if (hinge === 'left' || hinge === 'right') {
    if (doorHinge(voxel) !== hinge) {
      if (hinge === 'right') voxel.hinge = 'right';
      else delete voxel.hinge;
      changed = true;
    }
  }

  if (swing != null) {
    const rot = (voxel.rotation ?? 0) & 3;
    const negative = swing === 'negative' || swing === 'nz' || swing === 'nx';
    const next = (rot & 1) | (negative ? 2 : 0);
    if (next !== rot) {
      if (next) voxel.rotation = next;
      else delete voxel.rotation;
      changed = true;
    }
  }

  if (!changed) return false;
  // The leaf is re-cut (and its art re-mirrored) but its opacity and
  // footprint are untouched, so the chunks just need to rebuild — no light
  // edit record, unlike an open/close toggle.
  const [ax, ay, az] = voxel.anchor;
  for (const [x, y, z] of cellsFor(ax, ay, az, voxel.size, voxel.rotation ?? 0)) {
    world.markDirty(x, y, z);
  }
  return true;
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
