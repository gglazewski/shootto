// VoxelShape.js — canonical rules for how voxel sizes map to grid cells.
//
// A voxel occupies a cuboid of cells anchored at a cell coordinate:
//   SMALL -> 1x1x1 starting at its anchor cell.
//   BIG   -> 2x2x2 starting at its anchor cell (anchors snap to even coords).
//
// This is the single home for the size -> span/parity rule. Everything else
// (World storage, the ghost, the tools, the serializer) reads from here so a
// new size never has to be hunted across the codebase.

import { SIZE } from './VoxelTypes.js';

const SIZES = Object.freeze({
  [SIZE.SMALL]: Object.freeze({ span: 1, parity: 1 }),
  [SIZE.BIG]: Object.freeze({ span: 2, parity: 2 }),
});

/** Edge length of a voxel in cells. Unknown sizes fall back to small. */
export function spanFor(size) {
  return SIZES[size]?.span ?? 1;
}

/** Snap a cell coordinate to the anchor grid of a given size. */
export function anchorFor(x, y, z, size) {
  const mask = (SIZES[size]?.parity ?? 1) - 1;
  return [x & ~mask, y & ~mask, z & ~mask];
}

/** Cells covered by a voxel of `size` anchored at [ax, ay, az]. */
export function cellsFor(ax, ay, az, size) {
  const span = spanFor(size);
  const out = [];
  for (let x = ax; x < ax + span; x++)
    for (let y = ay; y < ay + span; y++)
      for (let z = az; z < az + span; z++) out.push([x, y, z]);
  return out;
}
