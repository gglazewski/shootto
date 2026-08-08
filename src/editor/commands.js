// commands.js — Command factories for undoable world edits.
//
// A command is { description, do(), undo() }. The caller (a tool) pushes the
// command onto History and runs do() itself, so a failed placement is never
// recorded.

/**
 * @param {object} world
 * @param {{type:string, size:string, anchor:[number,number,number], rotation?:number}} spec
 */
export function placeCommand(world, { type, size, anchor, rotation = 0 }) {
  return {
    description: `Place ${type}`,
    do() {
      return world.place(type, size, anchor[0], anchor[1], anchor[2], rotation);
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
      world.place(voxel.type, voxel.size, voxel.anchor[0], voxel.anchor[1], voxel.anchor[2], voxel.rotation ?? 0);
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
 * Place many voxels (line/square). do() records which anchors actually took
 * so undo() removes exactly those.
 * @param {object} world
 * @param {[number,number,number][]} anchors  anchor cells to try, in order
 * @param {string} type
 * @param {string} size
 * @param {number} [rotation]  yaw quarter turns applied to every voxel
 */
export function multiPlaceCommand(world, anchors, type, size, rotation = 0) {
  let placed = [];
  return {
    description: `Place ${anchors.length} ${type}`,
    do() {
      placed = [];
      for (const a of anchors) {
        if (world.place(type, size, a[0], a[1], a[2], rotation)) placed.push(a);
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
        world.place(v.type, v.size, v.anchor[0], v.anchor[1], v.anchor[2], v.rotation ?? 0);
      }
      removed = [];
    },
  };
}

/**
 * @param {object} world
 * @param {{itemId:string, size:string, anchor:[number,number,number], rotation?:number}} spec
 * @param {() => void} [onChange]  items feed the light field; called after every apply
 */
export function placeItemCommand(world, { itemId, size, anchor, rotation = 0 }, onChange) {
  return {
    description: `Place item ${itemId}`,
    do() {
      const ok = world.placeItem(itemId, size, anchor[0], anchor[1], anchor[2], rotation);
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
 * @param {object} world
 * @param {{itemId:string, size:string, anchor:[number,number,number], rotation?:number}} item
 * @param {() => void} [onChange]
 */
export function removeItemCommand(world, item, onChange) {
  const { itemId, size, anchor, rotation = 0 } = item;
  return {
    description: `Remove item ${itemId}`,
    do() {
      const ok = !!world.removeItemAt(anchor[0], anchor[1], anchor[2]);
      if (ok) onChange?.();
      return ok;
    },
    undo() {
      world.placeItem(itemId, size, anchor[0], anchor[1], anchor[2], rotation);
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
