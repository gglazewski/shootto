import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { CELL_SIZE } from '../src/engine/Space.js';
import { aabbCells, collides, moveAxis, moveWithStep, groundedAt } from '../src/engine/Physics.js';

const box = (minX, minY, minZ, maxX, maxY, maxZ) => ({ minX, minY, minZ, maxX, maxY, maxZ });
// Standing player AABB centered at cx/cz on the x/z plane, feet at feetY.
const playerBox = (cx, cz, feetY, halfWidth = 0.3, height = 1.8) =>
  box(cx - halfWidth, feetY, cz - halfWidth, cx + halfWidth, feetY + height, cz + halfWidth);

// --- aabbCells ---

test('aabbCells includes boundary cells exactly', () => {
  // AABB from 0..0.5 spans exactly the cell [0,0,0].
  assert.deepEqual(aabbCells(0, 0, 0, CELL_SIZE, CELL_SIZE, CELL_SIZE), [[0, 0, 0]]);
  // Just past the boundary adds the next cell.
  const cells = aabbCells(0, 0, 0, CELL_SIZE + 0.001, CELL_SIZE, CELL_SIZE);
  assert.deepEqual(cells, [[0, 0, 0], [1, 0, 0]]);
});

// --- collides ---

test('collides: empty world is never solid', () => {
  const w = new World();
  assert.equal(collides(w, playerBox(0, 0, 0)), false);
});

test('collides: overlapping a small voxel is solid', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  assert.equal(collides(w, playerBox(0, 0, 0)), true, 'box spans cells (0,0,0)');
  assert.equal(collides(w, playerBox(10, 10, 10)), false, 'far away is clear');
});

test('collides: box resting on top of a block is clear', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  // feet exactly at the top face of cell (0,0,0) -> world y = CELL_SIZE
  assert.equal(collides(w, playerBox(0, 0, CELL_SIZE)), false);
});

test('collides: BIG voxel is solid across all 8 cells', () => {
  const w = new World();
  w.place('wood', SIZE.BIG, 0, 0, 0);
  // Player box overlapping any of the big voxel's sub-cells should collide.
  assert.equal(collides(w, playerBox(CELL_SIZE, CELL_SIZE, CELL_SIZE)), true);
  // Just above the big voxel top (world y = 2 * CELL_SIZE) is clear.
  assert.equal(collides(w, playerBox(CELL_SIZE, CELL_SIZE, 2 * CELL_SIZE)), false);
});

// --- moveAxis ---

test('moveAxis: free move applies the full delta', () => {
  const w = new World();
  const b = playerBox(0, 0, 0);
  const res = moveAxis(w, b, 'x', 0.4);
  assert.equal(res.hit, false);
  assert.equal(res.moved, 0.4);
  assert.equal(b.minX, -0.3 + 0.4);
});

test('moveAxis: +x stops flush at a solid cell boundary', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 1, 0, 0); // solid cell spans world x [0.5, 1.0]
  const b = playerBox(0, 0, 0); // box maxX = 0.3
  const res = moveAxis(w, b, 'x', 0.5); // would push maxX to 0.8, inside cell 1
  assert.equal(res.hit, true);
  assert.equal(b.maxX, CELL_SIZE, 'clamped to the cell min edge');
  assert.ok(Math.abs(b.minX - (CELL_SIZE - 0.6)) < 1e-9, 'width preserved');
});

test('moveAxis: -x stops flush at a solid cell boundary', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, -2, 0, 0); // solid cell spans world x [-1.0, -0.5]
  const b = playerBox(-0.4, 0, 0); // box minX = -0.7, clear of the block
  const res = moveAxis(w, b, 'x', -0.5); // would push minX to -1.2, inside cell -2
  assert.equal(res.hit, true);
  assert.equal(b.minX, -CELL_SIZE, 'clamped to the cell max edge');
  assert.ok(Math.abs(b.maxX - (-CELL_SIZE + 0.6)) < 1e-9, 'width preserved');
});

test('moveAxis: falling down lands on the block below', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0); // top face at world y = 0.5
  const b = playerBox(0, 0, 0.7); // feet 0.7, just above the block top (0.5)
  const res = moveAxis(w, b, 'y', -0.3); // would push feet to 0.4, inside block
  assert.equal(res.hit, true);
  assert.equal(b.minY, CELL_SIZE, 'feet rest exactly on the top face');
});

test('moveAxis: moving up under a ceiling is clamped', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 2, 0); // solid cell spans y [1.0, 1.5]
  const b = playerBox(0, 0, -0.9); // head at 0.9, just under the ceiling at 1.0
  const res = moveAxis(w, b, 'y', 0.4);
  assert.equal(res.hit, true);
  assert.equal(b.maxY, CELL_SIZE * 2, 'head clamped under the ceiling');
  assert.equal(b.minY, CELL_SIZE * 2 - 1.8, 'width preserved');
  assert.ok(Math.abs(res.moved - 0.1) < 1e-9, 'only the legal 0.1 m was travelled');
});

// --- groundedAt ---

test('groundedAt: resting on a block reports grounded', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  assert.equal(groundedAt(w, playerBox(0, 0, CELL_SIZE)), true, 'feet on the top face');
  assert.equal(groundedAt(w, playerBox(0, 0, 2 * CELL_SIZE)), false, 'floating above');
  assert.equal(groundedAt(w, playerBox(0, 0, -1)), true, 'embedded in a block, feet touch solid');
});

test('groundedAt: no floor at all', () => {
  const w = new World();
  assert.equal(groundedAt(w, playerBox(0, 0, 0)), false);
});

// --- moveWithStep (auto step-up) ---

// Floor at cell (0,0,0) (top face at world y = 0.5), 0.5 m step at (1,1,0).
function stepWorld() {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  w.place('grass', SIZE.SMALL, 1, 1, 0);
  return w;
}

test('moveWithStep: flat ground moves the full delta', () => {
  const w = stepWorld();
  const b = playerBox(0.2, 0.2, CELL_SIZE); // standing on the floor
  const r = moveWithStep(w, b, 0, 0.4, 0.5, true); // move along z, clear of the step
  assert.equal(r.minZ, 0.2 - 0.3 + 0.4, 'moved fully');
  assert.equal(r.minY, CELL_SIZE, 'feet stayed on the floor');
});

test('moveWithStep: grounded player steps up onto a 0.5m block', () => {
  const w = stepWorld();
  const b = playerBox(0.2, 0.2, CELL_SIZE); // feet on the floor, facing the step
  const r = moveWithStep(w, b, 0.4, 0, 0.5, true);
  assert.ok(Math.abs(r.minY - CELL_SIZE * 2) < 1e-9, 'feet raised onto the step top');
  assert.ok(Math.abs(r.minX - (0.2 - 0.3 + 0.4)) < 1e-9, 'moved past the step');
});

test('moveWithStep: does not step onto a 1m wall', () => {
  const w = stepWorld();
  w.place('grass', SIZE.SMALL, 1, 2, 0); // stack: now a 1m wall at x [0.5,1.0]
  const b = playerBox(0.2, 0.2, CELL_SIZE);
  const r = moveWithStep(w, b, 0.4, 0, 0.5, true);
  assert.equal(r.minY, CELL_SIZE, 'feet did not rise');
  assert.ok(r.minX < 0.5, 'blocked at the wall');
});

test('moveWithStep: airborne player does not step up', () => {
  const w = stepWorld();
  const b = playerBox(0.2, 0.2, CELL_SIZE);
  const r = moveWithStep(w, b, 0.4, 0, 0.5, false); // in mid-air
  assert.equal(r.minY, CELL_SIZE, 'no auto-step while airborne');
  assert.ok(r.minX < 0.5, 'blocked at the step');
});

test('moveWithStep: no step when a ceiling blocks the destination', () => {
  const w = stepWorld();
  w.place('grass', SIZE.SMALL, 1, 3, 0); // ceiling above the step
  const b = playerBox(0.2, 0.2, CELL_SIZE);
  const r = moveWithStep(w, b, 0.4, 0, 0.5, true);
  assert.equal(r.minY, CELL_SIZE, 'feet did not rise into the ceiling');
  assert.ok(r.minX < 0.5, 'blocked at the step');
});

test('moveWithStep: climbs a step approached from -x', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);   // floor, world x[0, 0.5]
  w.place('wood', SIZE.SMALL, -2, 1, 0);   // step, world x[-1.0, -0.5], top y 1.0
  const b = playerBox(0.1, 0, CELL_SIZE);  // feet on the floor, facing -x
  const r = moveWithStep(w, b, -0.4, 0, 0.5, true);
  assert.ok(Math.abs(r.minY - CELL_SIZE * 2) < 1e-9, 'feet raised onto the step');
  assert.ok(Math.abs(r.minX - (0.1 - 0.3 - 0.4)) < 1e-9, 'moved past the step');
});

test('moveWithStep: climbs a step approached from -z', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);   // floor, world z[0, 0.5]
  w.place('wood', SIZE.SMALL, 0, 1, -2);   // step, world z[-1.0, -0.5], top y 1.0
  const b = playerBox(0, 0.1, CELL_SIZE);  // feet on the floor, facing -z
  const r = moveWithStep(w, b, 0, -0.4, 0.5, true);
  assert.ok(Math.abs(r.minY - CELL_SIZE * 2) < 1e-9, 'feet raised onto the step');
  assert.ok(Math.abs(r.minZ - (0.1 - 0.3 - 0.4)) < 1e-9, 'moved past the step');
});

test('moveWithStep: does not step onto a 1m wall from -x either', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);   // floor
  w.place('wood', SIZE.SMALL, -2, 1, 0);   // step layer
  w.place('wood', SIZE.SMALL, -2, 2, 0);   // stacked => 1m wall
  const b = playerBox(0.1, 0, CELL_SIZE);
  const r = moveWithStep(w, b, -0.4, 0, 0.5, true);
  assert.equal(r.minY, CELL_SIZE, 'feet did not rise onto a 1m wall');
});
