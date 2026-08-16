// microOps.js — pure micro-voxel grid operations shared by the item editors.
//
// Everything here is plain data-in/data-out (no THREE, no DOM) so the editor
// tools — mirror painting, box fill, flood recolor, model nudging — are unit
// testable without a browser. Cells are [x, y, z] integer triples inside a
// GRID^3 build volume; voxels are {x, y, z, color:[r,g,b]} records.

/** Map key for a cell position. */
export const cellKey = (x, y, z) => `${x}|${y}|${z}`;

/** O(1) position → voxel lookup table for a voxel list. */
export function buildVoxelIndex(voxels) {
  const index = new Map();
  for (const v of voxels) index.set(cellKey(v.x, v.y, v.z), v);
  return index;
}

/** Mirror-mode cycle used by the Mirror toggle: off → X → Z → XZ → off. */
export function nextMirrorMode(mode) {
  const order = ['', 'x', 'z', 'xz'];
  return order[(order.indexOf(mode) + 1) % order.length];
}

/** Per-axis [gx, gy, gz] from a grid that may be a scalar or already a triple. */
export const gridDims = (grid) => (Array.isArray(grid) ? grid : [grid, grid, grid]);

/** The cell plus its mirror images for the given mode ('', 'x', 'z', 'xz'),
 *  mirrored across the grid's centre planes. Duplicates (cells on the mirror
 *  plane) are collapsed. `grid` is a scalar or per-axis [gx, gy, gz]. */
export function mirrorCells(cell, mode, grid) {
  const [gx, , gz] = gridDims(grid);
  const [x, y, z] = cell;
  const out = [[x, y, z]];
  if (mode.includes('x')) out.push(...out.map(([a, b, c]) => [gx - 1 - a, b, c]));
  if (mode.includes('z')) out.push(...out.map(([a, b, c]) => [a, b, gz - 1 - c]));
  const seen = new Set();
  return out.filter(([a, b, c]) => {
    const k = cellKey(a, b, c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** All cells in the axis-aligned cuboid spanned by corners a and b (inclusive). */
export function boxCells(a, b) {
  const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  const out = [];
  for (let x = lo[0]; x <= hi[0]; x++) {
    for (let y = lo[1]; y <= hi[1]; y++) {
      for (let z = lo[2]; z <= hi[2]; z++) out.push([x, y, z]);
    }
  }
  return out;
}

const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** Voxels of the 6-connected region that starts at `start` and shares that
 *  voxel's color. Empty when `start` is not a placed voxel. */
export function floodRegion(voxels, start) {
  const index = buildVoxelIndex(voxels);
  const seed = index.get(cellKey(start[0], start[1], start[2]));
  if (!seed) return [];
  const match = (v) => v.color[0] === seed.color[0] && v.color[1] === seed.color[1] && v.color[2] === seed.color[2];
  const region = [];
  const seen = new Set([cellKey(seed.x, seed.y, seed.z)]);
  const queue = [seed];
  while (queue.length) {
    const v = queue.pop();
    region.push(v);
    for (const [dx, dy, dz] of NEIGHBORS) {
      const k = cellKey(v.x + dx, v.y + dy, v.z + dz);
      if (seen.has(k)) continue;
      seen.add(k);
      const n = index.get(k);
      if (n && match(n)) queue.push(n);
    }
  }
  return region;
}

/** Translate every voxel by d = [dx, dy, dz]. Returns the moved copies, or
 *  null when any voxel would leave the grid (the move is refused, not
 *  clamped, so the model never deforms). `grid` is a scalar or [gx, gy, gz]. */
export function translateVoxels(voxels, d, grid) {
  const [gx, gy, gz] = gridDims(grid);
  const moved = voxels.map((v) => ({ ...v, x: v.x + d[0], y: v.y + d[1], z: v.z + d[2] }));
  for (const v of moved) {
    if (v.x < 0 || v.x >= gx || v.y < 0 || v.y >= gy || v.z < 0 || v.z >= gz) return null;
  }
  return moved;
}

/** Shift that keeps content centred when the build volume changes from
 *  oldDims to newDims (both [gx, gy, gz]). */
export const resizeShift = (oldDims, newDims) =>
  oldDims.map((o, i) => Math.floor((newDims[i] - o) / 2));

/** Re-anchor voxels for a build-volume resize: content shifts by half the
 *  size difference per axis so it stays centred. Returns the shifted copies,
 *  or null when the content does not fit the new volume (caller should refuse
 *  the resize rather than drop voxels). */
export function recenterForResize(voxels, oldDims, newDims) {
  return translateVoxels(voxels, resizeShift(oldDims, newDims), newDims);
}

/** Shift for a side-anchored build-volume resize (the prefab editor's model):
 *  `sides[i]` names the wall that MOVES on that axis — 'max' leaves content
 *  where it is (the +wall slides), 'min' slides content with the moving −wall
 *  so the still wall keeps its distance; anything else recenters. */
export const anchoredResizeShift = (oldDims, newDims, sides) =>
  oldDims.map((o, i) => {
    const d = newDims[i] - o;
    const side = sides?.[i];
    return side === 'min' ? d : side === 'max' ? 0 : Math.floor(d / 2);
  });

/** Rebuild a <select> so its options are None + the given {id, name} choices.
 *  Skips the DOM work when the options already match. */
export function syncSelect(select, choices, doc) {
  const stale =
    select.options.length !== choices.length + 1 ||
    [...select.options].some((o, i) => i > 0 && o.value !== choices[i - 1].id);
  if (!stale) return;
  select.innerHTML = '';
  const none = doc.createElement('option');
  none.value = '';
  none.textContent = 'None';
  select.appendChild(none);
  for (const { id, name } of choices) {
    const o = doc.createElement('option');
    o.value = id;
    o.textContent = name;
    select.appendChild(o);
  }
}
