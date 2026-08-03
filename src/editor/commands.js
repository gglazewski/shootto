// commands.js — Command factories for undoable world edits.
//
// A command is { description, do(), undo() }. The caller (a tool) pushes the
// command onto History and runs do() itself, so a failed placement is never
// recorded.

/**
 * @param {object} world
 * @param {{type:string, size:string, anchor:[number,number,number]}} spec
 */
export function placeCommand(world, { type, size, anchor }) {
  return {
    description: `Place ${type}`,
    do() {
      return world.place(type, size, anchor[0], anchor[1], anchor[2]);
    },
    undo() {
      world.remove(anchor[0], anchor[1], anchor[2]);
    },
  };
}

/**
 * @param {object} world
 * @param {{type:string, size:string, anchor:[number,number,number]}} voxel
 */
export function removeCommand(world, voxel) {
  return {
    description: `Remove ${voxel.type}`,
    do() {
      return !!world.remove(voxel.anchor[0], voxel.anchor[1], voxel.anchor[2]);
    },
    undo() {
      world.place(voxel.type, voxel.size, voxel.anchor[0], voxel.anchor[1], voxel.anchor[2]);
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
 */
export function multiPlaceCommand(world, anchors, type, size) {
  let placed = [];
  return {
    description: `Place ${anchors.length} ${type}`,
    do() {
      placed = [];
      for (const a of anchors) {
        if (world.place(type, size, a[0], a[1], a[2])) placed.push(a);
      }
      return placed.length;
    },
    undo() {
      for (const a of placed) world.remove(a[0], a[1], a[2]);
      placed = [];
    },
  };
}
