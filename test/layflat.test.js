import { test } from 'node:test';
import assert from 'node:assert/strict';

import { microBounds, layFlat, layFlatCells } from '../src/engine/LayFlat.js';

const vox = (x, y, z, color = [200, 100, 50]) => ({ x, y, z, color });

const extentOf = (voxels) => {
  const b = microBounds(voxels);
  return b ? b.size : null;
};

test('microBounds of an empty list is null', () => {
  assert.equal(microBounds([]), null);
  assert.equal(microBounds(undefined), null);
});

test('microBounds returns the tight min corner and size', () => {
  const b = microBounds([vox(2, 3, 4), vox(5, 3, 4), vox(2, 6, 9)]);
  assert.deepEqual(b.min, [2, 3, 4]);
  assert.deepEqual(b.size, [4, 4, 6]);
});

test('layFlat of an empty def keeps the authored build volume', () => {
  const def = { grid: [8, 16, 8], microVoxels: [] };
  assert.deepEqual(layFlat(def), { microVoxels: [], grid: [8, 16, 8] });
});

test('layFlat crops an already-flat shape and re-bases it at the origin', () => {
  // A 3×1×2 plate floating in the middle of an 8³ volume: y is thinnest, so
  // only the crop applies — same shape, shifted to the origin.
  const def = { grid: [8, 8, 8], microVoxels: [vox(2, 5, 3), vox(3, 5, 3), vox(4, 5, 4)] };
  const flat = layFlat(def);
  assert.deepEqual(flat.grid, [3, 1, 2]);
  assert.deepEqual(
    flat.microVoxels.map((v) => [v.x, v.y, v.z]),
    [[0, 0, 0], [1, 0, 0], [2, 0, 1]],
  );
});

test('layFlat rolls an X-thin shape onto its side (a pistol lies flat)', () => {
  // Pistol-like: 1 voxel wide (x), 3 tall (y), 4 long (z, the barrel).
  const def = {
    grid: [8, 8, 8],
    microVoxels: [
      vox(3, 2, 1), vox(3, 3, 1), vox(3, 4, 1), // grip column
      vox(3, 4, 2), vox(3, 4, 3), vox(3, 4, 4), // barrel
    ],
  };
  const flat = layFlat(def);
  // Width and height swap: the thin x-extent becomes the height.
  assert.deepEqual(flat.grid, [3, 1, 4]);
  const size = extentOf(flat.microVoxels);
  assert.deepEqual(size, [3, 1, 4]);
  assert.equal(flat.microVoxels.length, 6);
  // Everything sits on the ground plane and inside the grid.
  for (const v of flat.microVoxels) {
    assert.equal(v.y, 0);
    assert.ok(v.x >= 0 && v.x < flat.grid[0]);
    assert.ok(v.z >= 0 && v.z < flat.grid[2]);
  }
  // The barrel still runs along z (its z coordinates are untouched).
  assert.deepEqual([...new Set(flat.microVoxels.map((v) => v.z))].sort(), [0, 1, 2, 3]);
});

test('layFlat tips a Z-thin shape forward (a sign falls on its face)', () => {
  // A 4×3×1 upright panel: z is thinnest, so it tips about X.
  const def = {
    grid: [8, 8, 8],
    microVoxels: [0, 1, 2, 3].flatMap((x) => [0, 1, 2].map((y) => vox(x, y + 2, 5))),
  };
  const flat = layFlat(def);
  assert.deepEqual(flat.grid, [4, 1, 3]);
  assert.deepEqual(extentOf(flat.microVoxels), [4, 1, 3]);
  for (const v of flat.microVoxels) assert.equal(v.y, 0);
});

test('layFlat is a rotation, not a scramble: neighbours stay neighbours', () => {
  const def = { grid: [8, 8, 8], microVoxels: [vox(3, 2, 1), vox(3, 3, 1)] };
  const [a, b] = layFlat(def).microVoxels;
  const dist = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
  assert.equal(dist, 1);
});

test('layFlat memoizes per def object', () => {
  const def = { grid: [8, 8, 8], microVoxels: [vox(1, 1, 1)] };
  assert.equal(layFlat(def), layFlat(def));
});

test('layFlatCells claims one 0.5 m cell per 8 micro cells, at least one', () => {
  // A laid-flat long gun: 16 micro cells along z → 2 world cells deep.
  const def = {
    grid: [8, 8, 16],
    microVoxels: Array.from({ length: 16 }, (_, z) => vox(4, 3, z)),
  };
  assert.deepEqual(layFlatCells(def), [1, 1, 2]);
});

test('layFlatCells of an empty def falls back to the build volume', () => {
  assert.deepEqual(layFlatCells({ grid: [8, 16, 8], microVoxels: [] }), [1, 2, 1]);
});
