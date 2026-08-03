// navmesh.test.js — NavMesh walkability, connectivity, pathfinding and LOS.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { NavMesh } from '../src/engine/NavMesh.js';
import { CELL_SIZE } from '../src/engine/Space.js';

/** Floor of BIG voxels spanning cells 0..span-1 at y=0 (top surface = cell y=2). */
function floorWorld(span) {
  const w = new World();
  for (let x = 0; x < span; x += 2) {
    for (let z = 0; z < span; z += 2) w.place('grass', SIZE.BIG, x, 0, z);
  }
  return w;
}

const navOpts = { halfWidth: 0.25, height: 1.7 };

test('flat floor yields one walkable node per column, one region', () => {
  const w = floorWorld(8);
  const nav = new NavMesh(w, navOpts);
  assert.ok(nav.valid);
  // 8x8 columns, each with a node on the floor surface (cell y = 2).
  const start = nav.nearestNodeAtCell(0, 0, 2);
  const goal = nav.nearestNodeAtCell(7, 7, 2);
  assert.ok(start && goal);
  assert.equal(start.y, 2);
  assert.equal(nav.regionOf(start) !== -1, true);
  const path = nav.findPath(start, goal);
  assert.ok(path && path.length > 1);
  assert.deepEqual([path[0].x, path[0].z], [0, 0]);
  assert.deepEqual([path[path.length - 1].x, path[path.length - 1].z], [7, 7]);
});

test('a full-span wall splits the map (no path through it)', () => {
  const w = floorWorld(8);
  for (let z = 0; z < 8; z++) {
    for (let y = 2; y <= 6; y++) w.place('stone', SIZE.SMALL, 3, y, z);
  }
  const nav = new NavMesh(w, navOpts);
  const start = nav.nearestNodeAtCell(0, 0, 2);
  const goal = nav.nearestNodeAtCell(7, 7, 2);
  assert.ok(start && goal);
  assert.notEqual(nav.regionOf(start), nav.regionOf(goal));
  assert.equal(nav.findPath(start, goal), null);
});

test('a short wall is routed around, never through', () => {
  const w = floorWorld(12);
  // Wall spans z 4..7 only, so a route exists around it via z<4 or z>7.
  for (let z = 4; z <= 7; z++) {
    for (let y = 2; y <= 6; y++) w.place('stone', SIZE.SMALL, 3, y, z);
  }
  const nav = new NavMesh(w, navOpts);
  const start = nav.nearestNodeAtCell(0, 0, 2);
  const goal = nav.nearestNodeAtCell(11, 11, 2);
  const path = nav.findPath(start, goal);
  assert.ok(path, 'expected a path around the wall');
  for (const node of path) {
    assert.ok(!(node.x === 3 && node.z >= 4 && node.z <= 7), 'path must not pass through the wall');
  }
});

test('a 0.5 m step connects the two levels and is climbable', () => {
  const w = floorWorld(8);
  // One SMALL voxel on the floor at column x=6: its top is a 0.5 m step up.
  w.place('wood', SIZE.SMALL, 6, 2, 0);
  const nav = new NavMesh(w, navOpts);
  const low = nav.nearestNodeAtCell(4, 0, 2);
  const high = nav.nearestNodeAtCell(6, 0, 3);
  assert.ok(low && high, 'both levels should be walkable');
  assert.equal(high.y, 3, 'step top surface is one cell (0.5 m) above the floor');
  assert.equal(nav.regionOf(low), nav.regionOf(high), 'step keeps both levels connected');
  const path = nav.findPath(low, high);
  assert.ok(path);
  assert.deepEqual([path[path.length - 1].x, path[path.length - 1].y, path[path.length - 1].z], [6, 3, 0]);
});

test('an isolated platform is a separate region (multi-floor maps)', () => {
  const w = floorWorld(8);
  // Floating platform: BIG voxel at y=8, top surface at cell y=10.
  w.place('stone', SIZE.BIG, 0, 8, 0);
  const nav = new NavMesh(w, navOpts);
  const ground = nav.nearestNodeAtCell(0, 0, 2);
  const platform = nav.nearestNodeAtCell(0, 0, 10);
  assert.ok(ground && platform);
  assert.notEqual(platform.y, ground.y);
  assert.notEqual(nav.regionOf(ground), nav.regionOf(platform), 'no stairs => separate regions');
  assert.equal(nav.findPath(ground, platform), null);
});

test('LOS is clear across open floor and blocked by a wall', () => {
  const w = floorWorld(8);
  const nav = new NavMesh(w, navOpts);
  // Eye-height points on the floor.
  const a = [0.25, 1.2, 0.25];
  const b = [3.25, 1.2, 3.25];
  assert.equal(nav.hasLOS(...a, ...b), true);
  // A wall in between at x=1 blocks the line (which runs along z=x).
  for (let y = 2; y <= 4; y++) {
    for (let z = 0; z <= 2; z++) w.place('stone', SIZE.SMALL, 1, y, z);
  }
  assert.equal(nav.hasLOS(...a, ...b), false);
});

test('no path drops straight through solid ground into a basement', () => {
  // A 1m-thick ground slab (cells y=0,1) with a basement floor 5m below
  // (cells y=-10,-9) and NO staircase. The navmesh must not invent a drop
  // edge through the rock — a mob could otherwise be ordered to walk straight
  // down into the floor.
  const w = new World();
  for (let x = 0; x < 8; x++) {
    for (let z = 0; z < 8; z++) {
      for (let y = 0; y <= 1; y++) w.place('stone', SIZE.SMALL, x, y, z);
      for (let y = -10; y <= -9; y++) w.place('stone', SIZE.SMALL, x, y, z);
    }
  }
  const nav = new NavMesh(w, navOpts);
  const ground = nav.nearestNodeAtCell(2, 2, 2);
  const basement = nav.nearestNodeAtCell(2, 2, -8);
  assert.ok(ground && basement);
  assert.equal(nav.findPath(ground, basement), null, 'basement unreachable without stairs');
});

test('a staircase is the path down, not a straight drop', () => {
  // Same slab + basement, but connected by a 2-cell-wide staircase that runs
  // all the way from ground level down to the basement floor.
  const w = new World();
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      const inTrench = x >= 6 && x <= 7 && z >= 4 && z <= 15;
      if (!inTrench) {
        for (let y = 0; y <= 1; y++) w.place('stone', SIZE.SMALL, x, y, z);
      }
      for (let y = -10; y <= -9; y++) w.place('stone', SIZE.SMALL, x, y, z);
    }
  }
  // Steps descend 0.5m per cell: step i (z=4+i) has surface cell y=2-i.
  for (let i = 0; i <= 10; i++) {
    const z = 4 + i;
    for (let x = 6; x <= 7; x++) w.place('stone', SIZE.SMALL, x, 1 - i, z);
  }
  const nav = new NavMesh(w, navOpts);
  const ground = nav.nearestNodeAtCell(2, 2, 2);
  const basement = nav.nearestNodeAtCell(2, 2, -8);
  const path = nav.findPath(ground, basement);
  assert.ok(path, 'stairs must connect ground to basement');
  // Every hop of the path moves gradually — no multi-meter instantaneous drops.
  for (let i = 1; i < path.length; i++) {
    const dy = path[i].y - path[i - 1].y;
    assert.ok(dy >= -3, `path step ${i} drops ${dy} cells (too far for one hop)`);
  }
});

test('nearestNode falls back to a neighbouring column when the exact one has no node', () => {
  const w = floorWorld(8);
  const nav = new NavMesh(w, navOpts);
  // Column (10,10) sits just outside the 8-cell floor — should resolve to the
  // nearest walkable node (the corner column) rather than crash or return null.
  const node = nav.nearestNode(10 * CELL_SIZE, 1, 10 * CELL_SIZE);
  assert.ok(node);
  assert.ok(node.x <= 7 && node.z <= 7);
});

test('a drop edge is rejected when a wall sits at the ledge in the target column', () => {
  // Ground slab at (0,0), basement floor below at (1,0), but a wall block at
  // the target column's feet level blocks the mob from walking off the ledge.
  const w = new World();
  for (let y = 0; y <= 1; y++) w.place('stone', SIZE.SMALL, 0, y, 0);
  w.place('stone', SIZE.SMALL, 1, -6, 0); // basement floor (surface y=-5)
  w.place('stone', SIZE.SMALL, 1, 2, 0); // wall in the target column at source level
  const nav = new NavMesh(w, navOpts);
  const src = nav.nearestNodeAtCell(0, 0, 2);
  const dst = nav.nearestNodeAtCell(1, 0, -5);
  assert.ok(src && dst);
  assert.equal(nav.findPath(src, dst), null, 'wall at the ledge blocks the drop');
});

test('a drop edge is rejected when an overhang clips the mob body', () => {
  // A step (surface y=-2) with an adjacent column that has the basement floor
  // below but a solid block overhead — the mob's 1.7m body would hit it.
  const w = new World();
  w.place('stone', SIZE.SMALL, 0, -3, 0); // step support -> surface y=-2
  w.place('stone', SIZE.SMALL, 1, -6, 0); // basement floor (surface y=-5)
  w.place('stone', SIZE.SMALL, 1, 0, 0); // overhang above the basement
  const nav = new NavMesh(w, navOpts);
  const src = nav.nearestNodeAtCell(0, 0, -2);
  const dst = nav.nearestNodeAtCell(1, 0, -5);
  assert.ok(src && dst);
  assert.equal(nav.findPath(src, dst), null, 'overhang blocks the drop');
  // Removing the overhang makes the same drop valid.
  w.remove(1, 0, 0);
  const nav2 = new NavMesh(w, navOpts);
  const src2 = nav2.nearestNodeAtCell(0, 0, -2);
  const dst2 = nav2.nearestNodeAtCell(1, 0, -5);
  assert.ok(nav2.findPath(src2, dst2), 'without the overhang the drop is open');
});
