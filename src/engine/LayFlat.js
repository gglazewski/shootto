// LayFlat.js — resting pose of a pickable (equippable) item in the world.
//
// Equipment art is authored in its held orientation (a pistol upright, barrel
// along +Z), floating somewhere inside its build volume. Placed in the world
// it should read as an object laid down on the surface — a pistol flat on the
// ground — not as a standing voxel sculpture hovering in its volume. This
// module derives that resting pose from the authored micro-voxels:
//   1. crop to content: the tight bounding box of the painted voxels; the
//      empty build volume around them plays no part in placement,
//   2. lay flat: a proper 90° rotation that points the shape's thinnest axis
//      up, so the item rests on its largest face (a pistol rolls onto its
//      side; a shape that is already flattest in Y stays as authored),
//   3. re-base at the origin, so the shape starts at the placement anchor and
//      its bottom touches the surface.
//
// Held/hand rendering (PlayerHand) keeps the authored pose — only world
// placements, previews and the pickup flight use the resting pose. Pure
// data-in/data-out (no THREE / DOM) so it is unit-testable in Node. Results
// are memoized per def object: registries hand out stable objects until a
// re-save replaces them.

import { MICRO_GRID, gridOf } from './ItemTypes.js';

/** Tight bounds of a micro-voxel list.
 *  @returns {{min:[number,number,number], size:[number,number,number]}|null}
 *    null when the list is empty */
export function microBounds(voxels) {
  if (!Array.isArray(voxels) || voxels.length === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of voxels) {
    const p = [v.x, v.y, v.z];
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  }
  return { min, size: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1] };
}

const CACHE = new WeakMap();

/**
 * Resting-pose model of an item def: micro-voxels cropped to content, rotated
 * flat and re-based at the origin, plus the tight grid they now occupy.
 * An empty def keeps its authored build volume (nothing to crop to).
 * @returns {{microVoxels:{x,y,z,color}[], grid:[number,number,number]}}
 */
export function layFlat(def) {
  const cached = def && CACHE.get(def);
  if (cached) return cached;
  const b = microBounds(def?.microVoxels);
  let out;
  if (!b) {
    out = { microVoxels: [], grid: gridOf(def) };
  } else {
    const [sx, sy, sz] = b.size;
    let map;
    let grid;
    if (sy <= sx && sy <= sz) {
      // Already flattest along Y — cropping alone lays it on the surface.
      map = (x, y, z) => [x, y, z];
      grid = [sx, sy, sz];
    } else if (sx <= sz) {
      // Thinnest along X: roll 90° about Z, the width becomes the height.
      map = (x, y, z) => [y, sx - 1 - x, z];
      grid = [sy, sx, sz];
    } else {
      // Thinnest along Z: tip 90° about X, the depth becomes the height.
      map = (x, y, z) => [x, sz - 1 - z, y];
      grid = [sx, sz, sy];
    }
    const microVoxels = def.microVoxels.map((v) => {
      const [x, y, z] = map(v.x - b.min[0], v.y - b.min[1], v.z - b.min[2]);
      return { x, y, z, color: v.color };
    });
    out = { microVoxels, grid };
  }
  if (def && typeof def === 'object') CACHE.set(def, out);
  return out;
}

/** World footprint of the resting pose in 0.5 m cells [w, h, d] — what the
 *  placement claims in World.placeItem. Always at least one cell per axis. */
export function layFlatCells(def) {
  return layFlat(def).grid.map((g) => Math.max(1, Math.ceil(g / MICRO_GRID)));
}
