import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';

import { World } from '../src/engine/World.js';
import { SIZE, getDecal, isClimbableDecal } from '../src/engine/VoxelTypes.js';
import { WalkControls } from '../src/editor/WalkControls.js';

// --- registry ---

test('decal_ladder is a registered climbable 1x4 decal', () => {
  const d = getDecal('decal_ladder');
  assert.ok(d, 'ladder decal exists');
  assert.deepEqual(d.span, [1, 4]);
  assert.equal(d.climbable, true);
  assert.equal(isClimbableDecal('decal_ladder'), true);
  assert.equal(isClimbableDecal('decal_blood'), false);
  assert.equal(isClimbableDecal('nope'), false);
});

// --- placement (same rules as any decal) ---

test('ladder pins to a wall face like any decal', () => {
  const w = new World();
  for (let y = 1; y <= 4; y++) w.place('brick', SIZE.SMALL, 4, y, 4);
  assert.equal(w.canPlaceDecal('decal_ladder', 4, 1, 4, 'pz'), true);
  assert.equal(w.placeDecal('decal_ladder', 4, 1, 4, 'pz'), true);
  // footprint covers the whole 4-cell strip
  assert.ok(w.decalAt(4, 4, 4, 'pz'));
  // a 3-cell wall can't back the 4-cell footprint
  for (let y = 1; y <= 3; y++) w.place('brick', SIZE.SMALL, 7, y, 4);
  assert.equal(w.canPlaceDecal('decal_ladder', 7, 1, 4, 'pz'), false);
});

// --- climbing ---

const DT = 1 / 60;

/** Ground plane + a 2m wall column at cell (4, 1..4, 4). */
function ladderWorld() {
  const w = new World();
  for (let x = 0; x < 10; x++) {
    for (let z = 0; z < 10; z++) w.place('concrete', SIZE.SMALL, x, 0, z);
  }
  for (let y = 1; y <= 4; y++) w.place('brick', SIZE.SMALL, 4, y, 4);
  return w;
}

/** Player standing on the ground at cell (4,1,5), nose against the wall's
 *  +z face, facing it (yaw 0 looks along -z). */
function walker(world) {
  const camera = new THREE.PerspectiveCamera();
  const walk = new WalkControls({ THREE, camera, domElement: null, world });
  walk.spawnAt(4, 1, 5, 0);
  return walk;
}

test('pressing into a ladder climbs the wall', () => {
  const w = ladderWorld();
  assert.equal(w.placeDecal('decal_ladder', 4, 1, 4, 'pz'), true);
  const walk = walker(w);
  walk.onKeyDown('KeyW');
  for (let i = 0; i < 60; i++) walk.update(DT);
  assert.ok(walk.position.y > 1, `climbed to ${walk.position.y}`);
});

test('the same wall without a ladder is not climbable', () => {
  const walk = walker(ladderWorld());
  walk.onKeyDown('KeyW');
  for (let i = 0; i < 60; i++) walk.update(DT);
  assert.ok(walk.position.y < 0.6, `stayed at ${walk.position.y}`);
});

test('a ladder on the far side of the wall does not climb', () => {
  const w = ladderWorld();
  assert.equal(w.placeDecal('decal_ladder', 4, 1, 4, 'nz'), true);
  const walk = walker(w); // player on the +z side, ladder faces -z
  walk.onKeyDown('KeyW');
  for (let i = 0; i < 60; i++) walk.update(DT);
  assert.ok(walk.position.y < 0.6, `stayed at ${walk.position.y}`);
});

test('hands-off contact slides down instead of free-falling', () => {
  const w = ladderWorld();
  assert.equal(w.placeDecal('decal_ladder', 4, 1, 4, 'pz'), true);
  const walk = walker(w);
  walk.onKeyDown('KeyW');
  for (let i = 0; i < 30; i++) walk.update(DT); // climb partway up
  walk.onKeyUp('KeyW');
  const top = walk.position.y;
  assert.ok(top > 0.9, `climbed to ${top}`);
  walk.update(DT); // one hands-off tick: slow slide, not gravity
  assert.ok(top - walk.position.y < walk.ladderSlide * DT + 1e-6,
    `slid ${top - walk.position.y} in one tick`);
  assert.ok(walk.velocity.y === -walk.ladderSlide);
});

test('crouch holds position on the ladder', () => {
  const w = ladderWorld();
  assert.equal(w.placeDecal('decal_ladder', 4, 1, 4, 'pz'), true);
  const walk = walker(w);
  walk.onKeyDown('KeyW');
  for (let i = 0; i < 30; i++) walk.update(DT);
  walk.onKeyUp('KeyW');
  walk.onKeyDown('KeyC');
  const held = walk.position.y;
  for (let i = 0; i < 30; i++) walk.update(DT);
  assert.ok(Math.abs(walk.position.y - held) < 1e-6, 'held on');
});

test('pressing in while looking steeply down climbs down', () => {
  const w = ladderWorld();
  assert.equal(w.placeDecal('decal_ladder', 4, 1, 4, 'pz'), true);
  const walk = walker(w);
  walk.onKeyDown('KeyW');
  for (let i = 0; i < 30; i++) walk.update(DT);
  const top = walk.position.y;
  walk.pitch = -1.2; // look at the ground
  for (let i = 0; i < 30; i++) walk.update(DT);
  assert.ok(walk.position.y < top - 0.5, `descended from ${top} to ${walk.position.y}`);
});
