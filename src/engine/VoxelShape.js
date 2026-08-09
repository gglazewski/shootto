// VoxelShape.js — canonical rules for how voxel sizes map to grid cells.
//
// A voxel occupies a cuboid of cells anchored at a cell coordinate:
//   SMALL -> 1x1x1 starting at its anchor cell.
//   BIG   -> 2x2x2 starting at its anchor cell (anchors snap to even coords).
//   DOOR  -> 2x4x1 (w x h x d); odd rotations turn the footprint onto z.
//
// This is the single home for the size -> span/parity rule. Everything else
// (World storage, the ghost, the tools, the serializer) reads from here so a
// new size never has to be hunted across the codebase. A bigger door later =
// one more entry with `turns: true`.

import { SIZE } from './VoxelTypes.js';

const SIZES = Object.freeze({
  [SIZE.SMALL]: Object.freeze({ span: [1, 1, 1], parity: 1 }),
  [SIZE.BIG]: Object.freeze({ span: [2, 2, 2], parity: 2 }),
  [SIZE.DOOR]: Object.freeze({ span: [2, 4, 1], parity: 1, turns: true }),
});

/** Horizontal edge length of a voxel in cells (the widest side for
 *  non-cubic sizes). Unknown sizes fall back to small. */
export function spanFor(size) {
  const s = SIZES[size]?.span ?? [1, 1, 1];
  return Math.max(s[0], s[2]);
}

/** Span in cells along [x, y, z]. Sizes that turn (doors) swap x/z on odd
 *  quarter-turn rotations, matching how the mesh is oriented. */
export function spanVecFor(size, rotation = 0) {
  const def = SIZES[size] ?? SIZES[SIZE.SMALL];
  const [sx, sy, sz] = def.span;
  return def.turns && (rotation & 1) ? [sz, sy, sx] : [sx, sy, sz];
}

/** Snap a cell coordinate to the anchor grid of a given size. */
export function anchorFor(x, y, z, size) {
  const mask = (SIZES[size]?.parity ?? 1) - 1;
  return [x & ~mask, y & ~mask, z & ~mask];
}

/** Cells covered by a voxel of `size` anchored at [ax, ay, az]. Rotation
 *  only matters for sizes with a non-square footprint (doors). */
export function cellsFor(ax, ay, az, size, rotation = 0) {
  const [sx, sy, sz] = spanVecFor(size, rotation);
  const out = [];
  for (let x = ax; x < ax + sx; x++)
    for (let y = ay; y < ay + sy; y++)
      for (let z = az; z < az + sz; z++) out.push([x, y, z]);
  return out;
}
