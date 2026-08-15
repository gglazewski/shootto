// commands.js — Command factories for undoable world edits.
//
// A command is { description, do(), undo() }. The caller (a tool) pushes the
// command onto History and runs do() itself, so a failed placement is never
// recorded.

import { stampPrefab, unstampPrefab } from '../engine/PrefabStamp.js';
import { translatePrefabContent } from './prefabResize.js';

/**
 * @param {object} world
 * @param {{type:string, size:string, anchor:[number,number,number], rotation?:number, variant?:string|null}} spec
 */
export function placeCommand(world, { type, size, anchor, rotation = 0, variant = null }) {
  return {
    description: `Place ${type}`,
    do() {
      return world.place(type, size, anchor[0], anchor[1], anchor[2], rotation, variant);
    },
    undo() {
      world.remove(anchor[0], anchor[1], anchor[2]);
    },
  };
}

/**
 * @param {object} world
 * @param {{type:string, size:string, anchor:[number,number,number], rotation?:number}} voxel
 */
export function removeCommand(world, voxel) {
  return {
    description: `Remove ${voxel.type}`,
    do() {
      return !!world.remove(voxel.anchor[0], voxel.anchor[1], voxel.anchor[2]);
    },
    undo() {
      world.place(voxel.type, voxel.size, voxel.anchor[0], voxel.anchor[1], voxel.anchor[2], voxel.rotation ?? 0, voxel.variant ?? null);
    },
  };
}

/**
 * @param {object} world
 * @param {{decalId:string, cell:[number,number,number], face:string, rotation?:number}} spec
 */
export function placeDecalCommand(world, { decalId, cell, face, rotation = 0 }) {
  return {
    description: `Place decal ${decalId}`,
    do() {
      return world.placeDecal(decalId, cell[0], cell[1], cell[2], face, rotation);
    },
    undo() {
      world.removeDecal(cell[0], cell[1], cell[2], face);
    },
  };
}

/**
 * @param {object} world
 * @param {{decalId:string, cell:[number,number,number], face:string, rotation?:number}} decal
 */
export function removeDecalCommand(world, decal) {
  return {
    description: `Remove decal ${decal.decalId}`,
    do() {
      return !!world.removeDecal(decal.cell[0], decal.cell[1], decal.cell[2], decal.face);
    },
    undo() {
      world.placeDecal(decal.decalId, decal.cell[0], decal.cell[1], decal.cell[2], decal.face, decal.rotation ?? 0);
    },
  };
}

/**
 * Repaint (or strip) many cell faces as ONE history entry — a whole paint
 * stroke undoes in a single step. Each entry carries the face's PREVIOUS
 * paint, so undo restores exactly what was there, whether that was another
 * paint or the block's own texture.
 *
 * Strokes apply eagerly while the button is held, so the command is pushed
 * without re-running do(); redo replays it verbatim.
 * @param {object} world
 * @param {{cell:[number,number,number], face:string, type:string|null, prev:string|null}[]} entries
 *   `type` null = strip the face back to its block's own texture
 */
export function paintFacesCommand(world, entries) {
  const stripping = entries.every((e) => e.type == null);
  const apply = (cell, face, type) => (type == null
    ? world.unpaintFace(cell[0], cell[1], cell[2], face)
    : world.paintFace(cell[0], cell[1], cell[2], face, type));
  return {
    description: entries.length === 1
      ? `${stripping ? 'Strip' : 'Paint'} face ${entries[0].face}`
      : `${stripping ? 'Strip' : 'Paint'} ${entries.length} faces`,
    do() {
      let n = 0;
      for (const e of entries) if (apply(e.cell, e.face, e.type)) n++;
      return n;
    },
    undo() {
      for (const e of entries) apply(e.cell, e.face, e.prev);
    },
  };
}

/**
 * Place many voxels (line/square). do() records which anchors actually took
 * so undo() removes exactly those.
 * @param {object} world
 * @param {[number,number,number][]} anchors  anchor cells to try, in order
 * @param {string} type
 * @param {string} size
 * @param {number} [rotation]  yaw quarter turns applied to every voxel
 * @param {'lower'|'upper'|null} [variant]  slab variant applied to every voxel
 */
export function multiPlaceCommand(world, anchors, type, size, rotation = 0, variant = null) {
  let placed = [];
  return {
    description: `Place ${anchors.length} ${type}`,
    do() {
      placed = [];
      for (const a of anchors) {
        if (world.place(type, size, a[0], a[1], a[2], rotation, variant)) placed.push(a);
      }
      return placed.length;
    },
    undo() {
      for (const a of placed) world.remove(a[0], a[1], a[2]);
      placed = [];
    },
  };
}

/**
 * Remove many voxels (sweep/line/square erase). do() records which voxels
 * actually came out so undo() restores exactly those. Pass applied=true when
 * the removals already happened eagerly (sweep erase removes while the button
 * is held) — the command is then pushed without re-running do(), but
 * undo/redo still roundtrip.
 * @param {object} world
 * @param {{type:string, size:string, anchor:[number,number,number], rotation?:number}[]} voxels
 * @param {{applied?:boolean}} [opts]
 */
export function multiRemoveCommand(world, voxels, { applied = false } = {}) {
  let removed = applied ? [...voxels] : [];
  return {
    description: `Remove ${voxels.length} voxels`,
    do() {
      removed = [];
      for (const v of voxels) {
        if (world.remove(v.anchor[0], v.anchor[1], v.anchor[2])) removed.push(v);
      }
      return removed.length;
    },
    undo() {
      for (const v of removed) {
        world.place(v.type, v.size, v.anchor[0], v.anchor[1], v.anchor[2], v.rotation ?? 0, v.variant ?? null);
      }
      removed = [];
    },
  };
}

/**
 * Delete a whole region (cube delete): voxels and placed items together as
 * ONE history entry. do() records what actually came out so undo() restores
 * exactly that — decals ride their voxel's faces and are not restored, same
 * as every other removal command.
 * @param {object} world
 * @param {{voxels: object[], items: object[]}} content  everything in the region
 * @param {() => void} [onChange]  items feed the light field; called when any moved
 * @returns {object} command; do() returns how many objects were removed
 */
export function cubeDeleteCommand(world, { voxels, items }, onChange) {
  let removedVoxels = [];
  let removedItems = [];
  return {
    description: `Delete ${voxels.length + items.length} in a cube`,
    do() {
      removedVoxels = [];
      removedItems = [];
      for (const v of voxels) {
        if (world.remove(v.anchor[0], v.anchor[1], v.anchor[2])) removedVoxels.push(v);
      }
      for (const it of items) {
        if (world.removeItemAt(it.anchor[0], it.anchor[1], it.anchor[2])) removedItems.push(it);
      }
      if (removedItems.length) onChange?.();
      return removedVoxels.length + removedItems.length;
    },
    undo() {
      for (const v of removedVoxels) {
        world.place(v.type, v.size, v.anchor[0], v.anchor[1], v.anchor[2], v.rotation ?? 0, v.variant ?? null);
      }
      for (const it of removedItems) {
        world.placeItem(it.itemId, it.cells, it.anchor[0], it.anchor[1], it.anchor[2], it.rotation ?? 0);
      }
      if (removedItems.length) onChange?.();
      removedVoxels = [];
      removedItems = [];
    },
  };
}

/**
 * @param {object} world
 * @param {{itemId:string, cells:[number,number,number], anchor:[number,number,number], rotation?:number}} spec
 * @param {() => void} [onChange]  items feed the light field; called after every apply
 */
export function placeItemCommand(world, { itemId, cells, anchor, rotation = 0 }, onChange) {
  return {
    description: `Place item ${itemId}`,
    do() {
      const ok = world.placeItem(itemId, cells, anchor[0], anchor[1], anchor[2], rotation);
      if (ok) onChange?.();
      return ok;
    },
    undo() {
      world.removeItemAt(anchor[0], anchor[1], anchor[2]);
      onChange?.();
    },
  };
}

/**
 * Stamp a whole prefab (blocks + items + decals) as ONE history entry.
 * Blocked cells skip their entry; the receipt from the first do() pins
 * exactly what redo re-places and undo removes.
 * @param {object} world
 * @param {object} prefab   parsed voxelprefab (PrefabSerializer)
 * @param {[number,number,number]} offset  world cell of the prefab's min corner
 * @param {number} turns    quarter turns CCW around +Y
 * @param {() => void} [onChange]  called after any apply that moved items
 * @param {boolean} [mirror]  stamp the mirror image (flipped before turning)
 */
export function pastePrefabCommand(world, prefab, offset, turns, onChange, mirror = false) {
  let receipt = null;
  return {
    description: `Paste ${prefab.name}`,
    get skipped() { return receipt?.skipped ?? 0; },
    get placed() { return receipt ? receipt.blocks.length + receipt.items.length + receipt.decals.length + receipt.paint.length : 0; },
    do() {
      if (!receipt) {
        receipt = stampPrefab(world, prefab, offset, turns, mirror);
      } else {
        // Redo: re-place the receipt verbatim, never re-evaluating collisions.
        for (const b of receipt.blocks) world.place(b.type, b.size, b.x, b.y, b.z, b.rotation, b.variant);
        for (const it of receipt.items) world.placeItem(it.itemId, it.cells, it.x, it.y, it.z, it.rotation);
        for (const d of receipt.decals) world.placeDecal(d.id, d.x, d.y, d.z, d.face, d.rotation);
        for (const p of receipt.paint) world.paintFace(p.x, p.y, p.z, p.face, p.type);
      }
      if (receipt.items.length) onChange?.();
      return receipt.blocks.length + receipt.items.length + receipt.decals.length > 0;
    },
    undo() {
      if (!receipt) return;
      unstampPrefab(world, receipt);
      if (receipt.items.length) onChange?.();
    },
  };
}

/**
 * Resize the prefab build volume as ONE history entry. Pulling a min side
 * also slides the content (`shift`) so the box keeps its corner at the origin;
 * `apply` re-seeds the baseplate, panel, gizmo and camera for the new frame.
 *
 * Undo/redo stay sound next to ordinary edits because History is strictly
 * linear: by the time an older placement is undone, this command has already
 * put the content back in the frame those anchors were recorded in.
 *
 * @param {object} world
 * @param {{dims:number[], prevDims:number[], shift:[number,number,number],
 *          apply:(dims:number[], shift:number[]) => void}} spec
 */
export function prefabResizeCommand(world, { dims, prevDims, shift, apply }) {
  return {
    description: `Resize volume to ${dims.join('×')}`,
    do() {
      translatePrefabContent(world, shift);
      apply(dims, shift);
      return true;
    },
    undo() {
      const back = shift.map((n) => (n === 0 ? 0 : -n)); // no -0 leaking into the camera math
      translatePrefabContent(world, back);
      apply(prevDims, back);
    },
  };
}

/**
 * @param {object} world
 * @param {{itemId:string, cells:[number,number,number], anchor:[number,number,number], rotation?:number}} item
 * @param {() => void} [onChange]
 */
export function removeItemCommand(world, item, onChange) {
  const { itemId, cells, anchor, rotation = 0 } = item;
  return {
    description: `Remove item ${itemId}`,
    do() {
      const ok = !!world.removeItemAt(anchor[0], anchor[1], anchor[2]);
      if (ok) onChange?.();
      return ok;
    },
    undo() {
      world.placeItem(itemId, cells, anchor[0], anchor[1], anchor[2], rotation);
      onChange?.();
    },
  };
}

/**
 * @param {object} world
 * @param {{type:string, cell:[number,number,number]}} spec
 */
export function addMobSpawnCommand(world, { type, cell }) {
  return {
    description: `Place mob ${type}`,
    do() {
      return world.addMobSpawn(type, cell[0], cell[1], cell[2]);
    },
    undo() {
      world.removeMobSpawnAt(cell[0], cell[1], cell[2]);
    },
  };
}

/**
 * @param {object} world
 * @param {{type:string, x:number, y:number, z:number}} spawn
 */
export function removeMobSpawnCommand(world, spawn) {
  return {
    description: `Remove mob ${spawn.type}`,
    do() {
      return !!world.removeMobSpawnAt(spawn.x, spawn.y, spawn.z);
    },
    undo() {
      world.addMobSpawn(spawn.type, spawn.x, spawn.y, spawn.z);
    },
  };
}

/**
 * @param {object} world
 * @param {{type:string, cell:[number,number,number]}} spec
 */
export function addNpcSpawnCommand(world, { type, cell }) {
  return {
    description: `Place NPC ${type}`,
    do() {
      return world.addNpcSpawn(type, cell[0], cell[1], cell[2]);
    },
    undo() {
      world.removeNpcSpawnAt(cell[0], cell[1], cell[2]);
    },
  };
}

/**
 * @param {object} world
 * @param {{type:string, x:number, y:number, z:number}} spawn
 */
export function removeNpcSpawnCommand(world, spawn) {
  return {
    description: `Remove NPC ${spawn.type}`,
    do() {
      return !!world.removeNpcSpawnAt(spawn.x, spawn.y, spawn.z);
    },
    undo() {
      world.addNpcSpawn(spawn.type, spawn.x, spawn.y, spawn.z);
    },
  };
}

/**
 * Set the player spawn; undo restores the previous spawn (and its yaw).
 * @param {object} world
 * @param {[number,number,number]} cell
 */
export function setSpawnCommand(world, cell) {
  let prev = null;
  let prevYaw = 0;
  return {
    description: 'Set player spawn',
    do() {
      prev = world.spawn ? [...world.spawn] : null;
      prevYaw = world.spawnYaw ?? 0;
      world.setSpawn(cell[0], cell[1], cell[2]);
      return true;
    },
    undo() {
      if (prev) {
        world.setSpawn(prev[0], prev[1], prev[2]);
        world.spawnYaw = prevYaw;
      } else {
        world.clearSpawn();
      }
    },
  };
}

/**
 * Clear the player spawn; undo puts it back where it was (with its yaw).
 * @param {object} world
 */
export function clearSpawnCommand(world) {
  let prev = null;
  let prevYaw = 0;
  return {
    description: 'Remove player spawn',
    do() {
      if (!world.spawn) return false;
      prev = [...world.spawn];
      prevYaw = world.spawnYaw ?? 0;
      world.clearSpawn();
      return true;
    },
    undo() {
      if (prev) {
        world.setSpawn(prev[0], prev[1], prev[2]);
        world.spawnYaw = prevYaw;
      }
    },
  };
}
