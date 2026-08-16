import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cellKey,
  buildVoxelIndex,
  nextMirrorMode,
  mirrorCells,
  boxCells,
  floodRegion,
  translateVoxels,
  recenterForResize,
  resizeShift,
  anchoredResizeShift,
} from '../src/editor/items/microOps.js';

const GRID = 8;
const vox = (x, y, z, color = [200, 100, 50]) => ({ x, y, z, color });

test('buildVoxelIndex maps every voxel by position', () => {
  const list = [vox(0, 0, 0), vox(7, 3, 2)];
  const index = buildVoxelIndex(list);
  assert.equal(index.get(cellKey(0, 0, 0)), list[0]);
  assert.equal(index.get(cellKey(7, 3, 2)), list[1]);
  assert.equal(index.get(cellKey(1, 1, 1)), undefined);
});

test('nextMirrorMode cycles off → x → z → xz → off', () => {
  assert.equal(nextMirrorMode(''), 'x');
  assert.equal(nextMirrorMode('x'), 'z');
  assert.equal(nextMirrorMode('z'), 'xz');
  assert.equal(nextMirrorMode('xz'), '');
});

test('mirrorCells returns just the cell when mirroring is off', () => {
  assert.deepEqual(mirrorCells([1, 2, 3], '', GRID), [[1, 2, 3]]);
});

test('mirrorCells mirrors across the X centre plane', () => {
  assert.deepEqual(mirrorCells([1, 2, 3], 'x', GRID), [[1, 2, 3], [6, 2, 3]]);
});

test('mirrorCells mirrors across both planes for xz', () => {
  const cells = mirrorCells([1, 2, 3], 'xz', GRID);
  assert.equal(cells.length, 4);
  const keys = cells.map((c) => cellKey(...c));
  for (const expected of [[1, 2, 3], [6, 2, 3], [1, 2, 4], [6, 2, 4]]) {
    assert.ok(keys.includes(cellKey(...expected)), `missing ${expected}`);
  }
});

test('mirrorCells collapses duplicates on the mirror plane', () => {
  // Grid 5: z=2 IS the centre plane, so the cell mirrors onto itself.
  assert.deepEqual(mirrorCells([2, 0, 2], 'z', 5), [[2, 0, 2]]);
});

test('boxCells spans the cuboid between any two corners', () => {
  const cells = boxCells([2, 1, 3], [0, 1, 1]);
  assert.equal(cells.length, 3 * 1 * 3);
  const keys = cells.map((c) => cellKey(...c));
  assert.ok(keys.includes(cellKey(0, 1, 1)));
  assert.ok(keys.includes(cellKey(2, 1, 3)));
  assert.ok(keys.includes(cellKey(1, 1, 2)));
});

test('boxCells handles a single-cell box', () => {
  assert.deepEqual(boxCells([4, 4, 4], [4, 4, 4]), [[4, 4, 4]]);
});

test('floodRegion collects the connected same-color region only', () => {
  const red = [255, 0, 0];
  const blue = [0, 0, 255];
  const voxels = [
    vox(0, 0, 0, red),
    vox(1, 0, 0, red),
    vox(2, 0, 0, blue), // color border
    vox(3, 0, 0, red),  // same color but disconnected from the seed region
    vox(1, 1, 0, red),
  ];
  const region = floodRegion(voxels, [0, 0, 0]);
  const keys = region.map((v) => cellKey(v.x, v.y, v.z)).sort();
  assert.deepEqual(keys, ['0|0|0', '1|0|0', '1|1|0'].sort());
});

test('floodRegion returns empty for an empty start cell', () => {
  assert.deepEqual(floodRegion([vox(0, 0, 0)], [5, 5, 5]), []);
});

test('translateVoxels moves every voxel', () => {
  const moved = translateVoxels([vox(1, 1, 1), vox(2, 3, 4)], [1, 0, -1], GRID);
  assert.deepEqual(moved.map((v) => [v.x, v.y, v.z]), [[2, 1, 0], [3, 3, 3]]);
});

test('translateVoxels refuses a move that would leave the grid', () => {
  assert.equal(translateVoxels([vox(7, 0, 0)], [1, 0, 0], GRID), null);
  assert.equal(translateVoxels([vox(0, 0, 0)], [-1, 0, 0], GRID), null);
});

test('mirrorCells uses per-axis dims for non-cubic volumes', () => {
  // 16 cells along z: z=1 mirrors to z=14; x untouched by z-mirror.
  assert.deepEqual(mirrorCells([2, 0, 1], 'z', [8, 8, 16]), [[2, 0, 1], [2, 0, 14]]);
  assert.deepEqual(mirrorCells([2, 0, 1], 'x', [16, 8, 8]), [[2, 0, 1], [13, 0, 1]]);
});

test('translateVoxels respects per-axis bounds', () => {
  // Fits a 16-long volume but not an 8-long one.
  const list = [vox(0, 0, 10)];
  assert.notEqual(translateVoxels(list, [0, 0, 1], [8, 8, 16]), null);
  assert.equal(translateVoxels(list, [0, 0, 1], [8, 8, 11]), null);
});

test('resizeShift centres the size difference', () => {
  assert.deepEqual(resizeShift([8, 8, 8], [8, 8, 16]), [0, 0, 4]);
  assert.deepEqual(resizeShift([8, 8, 16], [8, 8, 8]), [0, 0, -4]);
});

test('anchoredResizeShift slides content only when the min wall moves', () => {
  // The +wall moves: content stays put.
  assert.deepEqual(anchoredResizeShift([8, 8, 8], [8, 8, 16], ['max', 'max', 'max']), [0, 0, 0]);
  // The −wall moves: content rides with it, keeping the +wall distance.
  assert.deepEqual(anchoredResizeShift([8, 8, 8], [8, 8, 16], ['max', 'max', 'min']), [0, 0, 8]);
  assert.deepEqual(anchoredResizeShift([8, 8, 16], [8, 8, 8], ['max', 'max', 'min']), [0, 0, -8]);
  // No side picked: falls back to centring (resizeShift).
  assert.deepEqual(anchoredResizeShift([8, 8, 8], [8, 8, 16], null), resizeShift([8, 8, 8], [8, 8, 16]));
});

test('recenterForResize keeps content centred when growing', () => {
  const moved = recenterForResize([vox(3, 3, 3)], [8, 8, 8], [8, 8, 16]);
  assert.deepEqual([moved[0].x, moved[0].y, moved[0].z], [3, 3, 7]);
});

test('recenterForResize refuses a shrink the content does not fit', () => {
  // Voxels span z=0..15; an 8-long volume cannot hold them.
  const long = [vox(0, 0, 0), vox(0, 0, 15)];
  assert.equal(recenterForResize(long, [8, 8, 16], [8, 8, 8]), null);
  // But content clustered near the middle survives the shrink.
  const mid = [vox(0, 0, 7), vox(0, 0, 8)];
  const moved = recenterForResize(mid, [8, 8, 16], [8, 8, 8]);
  assert.deepEqual(moved.map((v) => v.z), [3, 4]);
});

test('translateVoxels does not mutate the input', () => {
  const original = [vox(1, 1, 1)];
  translateVoxels(original, [1, 1, 1], GRID);
  assert.equal(original[0].x, 1);
  assert.equal(original[0].y, 1);
  assert.equal(original[0].z, 1);
});
