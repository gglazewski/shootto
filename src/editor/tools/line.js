// line.js — straight (axis-constrained) voxel-line helper for the tools.
//
// Shift-drag lines snap to the dominant axis between the last placed voxel
// and the aim target, so every voxel stays on the same X/Y/Z line. Computed
// in *anchor space* (one unit = one voxel of the current size) so small and
// big voxels both produce clean paths on their own grid.

import { spanFor } from '../../engine/VoxelShape.js';

/**
 * Anchor cells forming an axis-aligned line from a to b for a given size.
 * The dominant axis of the a->b delta wins; the other two coordinates are
 * locked to a's values.
 * @param {[number,number,number]} a
 * @param {[number,number,number]} b
 * @param {string} size
 * @returns {[number,number,number][]}
 */
export function orthogonalLineAnchors(a, b, size) {
  const span = spanFor(size);
  // Round instead of divide exactly: `a` may be a stale anchor placed at a
  // different voxel size (small -> big switch mid-line), so snap it onto the
  // current grid rather than producing fractional anchors.
  const ai = a.map((v) => Math.round(v / span));
  const bi = b.map((v) => Math.round(v / span));

  const dx = Math.abs(bi[0] - ai[0]);
  const dy = Math.abs(bi[1] - ai[1]);
  const dz = Math.abs(bi[2] - ai[2]);
  const axis = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;

  const step = bi[axis] >= ai[axis] ? 1 : -1;
  const out = [];
  for (let v = ai[axis]; step > 0 ? v <= bi[axis] : v >= bi[axis]; v += step) {
    const c = [ai[0], ai[1], ai[2]];
    c[axis] = v;
    out.push([c[0] * span, c[1] * span, c[2] * span]);
  }
  return out;
}
