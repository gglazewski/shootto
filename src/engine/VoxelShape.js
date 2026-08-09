// VoxelShape.js — canonical rules for how voxel sizes map to grid cells.
//
// A voxel occupies a cuboid of cells anchored at a cell coordinate:
//   SMALL -> 1x1x1 starting at its anchor cell.
//   BIG   -> 2x2x2 starting at its anchor cell (anchors snap to even coords).
//   DOOR  -> 2x4x1 (w x h x d); odd rotations turn the footprint onto z.
//   DOOR3 -> 3x4x1; the wide blok-entrance door, turning like DOOR.
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
  [SIZE.DOOR3]: Object.freeze({ span: [3, 4, 1], parity: 1, turns: true }),
});

/** Resolve a size spec to its shape rule. String sizes come from the table;
 *  items pass their footprint directly as a [w, h, d] cell span (free
 *  anchoring, turning like doors). */
function defFor(size) {
  if (Array.isArray(size)) return { span: size, parity: 1, turns: true };
  return SIZES[size] ?? SIZES[SIZE.SMALL];
}

/** Horizontal edge length of a voxel in cells (the widest side for
 *  non-cubic sizes). Unknown sizes fall back to small. */
export function spanFor(size) {
  const s = defFor(size).span;
  return Math.max(s[0], s[2]);
}

/** Span in cells along [x, y, z]. Sizes that turn (doors, item footprints)
 *  swap x/z on odd quarter-turn rotations, matching the mesh orientation. */
export function spanVecFor(size, rotation = 0) {
  const def = defFor(size);
  const [sx, sy, sz] = def.span;
  return def.turns && (rotation & 1) ? [sz, sy, sx] : [sx, sy, sz];
}

/** Snap a cell coordinate to the anchor grid of a given size. */
export function anchorFor(x, y, z, size) {
  const mask = defFor(size).parity - 1;
  return [x & ~mask, y & ~mask, z & ~mask];
}

/**
 * Solid y-extent of a placed voxel in cell units, honoring its slab variant.
 * Variants only ever appear on cube-shaped blocks (World.place guards):
 * 'lower' keeps the bottom half of the voxel's height, 'upper' the top half,
 * anything else (or no variant) is the full height. Synthetic test voxels
 * may lack an anchor — `fallbackY` (the queried cell) stands in for it.
 * @returns {[number, number]} [minY, maxY] in cells
 */
export function solidYRange(voxel, fallbackY = 0) {
  const ay = voxel.anchor ? voxel.anchor[1] : fallbackY;
  const sy = spanVecFor(voxel.size, voxel.rotation ?? 0)[1];
  if (voxel.variant === 'lower') return [ay, ay + sy / 2];
  if (voxel.variant === 'upper') return [ay + sy / 2, ay + sy];
  return [ay, ay + sy];
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
