// mob.test.js — Mob AI: aggro, chase, melee attack, damage/death, step climbing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { NavMesh } from '../src/engine/NavMesh.js';
import { Mob } from '../src/game/Mob.js';
import { getMob } from '../src/engine/mobTypes.js';
import { CELL_SIZE } from '../src/engine/Space.js';

/** Floor of BIG voxels spanning cells 0..7 at y=0 (top surface = cell y=2). */
function floorWorld() {
  const w = new World();
  for (let x = 0; x < 8; x += 2) {
    for (let z = 0; z < 8; z += 2) w.place('grass', SIZE.BIG, x, 0, z);
  }
  return w;
}

function makeMob(world, cx, cz, cy = 2) {
  const type = getMob('imp');
  const nav = new NavMesh(world, { halfWidth: type.halfWidth, height: type.height });
  const hits = [];
  const mob = new Mob({ type, spawnCell: [cx, cy, cz], world, nav, onDamagePlayer: (dmg, pos) => hits.push({ dmg, pos }) });
  return { mob, hits, nav };
}

test('spawns snapped onto the walkable surface', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  assert.ok(mob.valid);
  assert.equal(mob.pos.y, 2 * CELL_SIZE, 'feet sit on the floor surface');
  assert.equal(mob.pos.x, 2 * CELL_SIZE + CELL_SIZE / 2);
});

test('idle mob ignores a player outside aggro range', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  const player = { x: 50, y: 2 * CELL_SIZE, z: 50 };
  mob.update(0.1, player);
  assert.equal(mob.state, 'idle');
  assert.equal(mob.aggro, false);
  assert.equal(mob.animName, 'idle');
});

test('aggros on sight and chases the player', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  const player = { x: 10 * CELL_SIZE, y: 2 * CELL_SIZE, z: 2 * CELL_SIZE }; // ~3.7 m away
  mob.update(0.1, player);
  assert.equal(mob.aggro, true);
  assert.notEqual(mob.state, 'idle');
  const d0 = Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z);
  for (let i = 0; i < 40; i++) mob.update(0.1, player);
  const d1 = Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z);
  assert.ok(d1 < d0 - 0.05, `mob should close distance (${d0} -> ${d1})`);
});

test('strikes the player when in reach with line of sight', () => {
  const world = floorWorld();
  const { mob, hits } = makeMob(world, 2, 2, 2);
  const player = { x: 2 * CELL_SIZE + CELL_SIZE / 2 + 0.7, y: 2 * CELL_SIZE, z: 2 * CELL_SIZE + CELL_SIZE / 2 };
  for (let i = 0; i < 40; i++) mob.update(0.1, player);
  assert.ok(hits.length >= 1, 'player took at least one hit');
  assert.equal(hits[0].dmg, getMob('imp').damage);
});

test('takes damage, flashes hurt, and dies when health runs out', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  const type = getMob('imp');
  assert.equal(mob.takeDamage(10), false);
  assert.equal(mob.health, type.health - 10);
  assert.equal(mob.hurtTimer > 0, true);
  assert.equal(mob.aggro, true);
  assert.equal(mob.takeDamage(type.health), true);
  assert.equal(mob.dead, true);
  assert.equal(mob.animName, 'dead');
  // Dead mobs don't move or attack.
  const player = { x: 2 * CELL_SIZE, y: 2 * CELL_SIZE, z: 2 * CELL_SIZE };
  const y0 = mob.pos.y;
  mob.update(0.1, player);
  assert.equal(mob.pos.y, y0);
});

test('a dead mob stops dealing damage', () => {
  const world = floorWorld();
  const { mob, hits } = makeMob(world, 2, 2, 2);
  mob.takeDamage(getMob('imp').health);
  const player = { x: mob.pos.x + 0.5, y: 2 * CELL_SIZE, z: mob.pos.z };
  for (let i = 0; i < 30; i++) mob.update(0.1, player);
  assert.equal(hits.length, 0);
});

test('climbs a 0.5 m step to reach a higher level', () => {
  const world = new World();
  for (let x = 0; x < 16; x += 2) {
    for (let z = 0; z < 8; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  world.place('wood', SIZE.SMALL, 8, 2, 2); // step blocking the row at x=8
  const { mob } = makeMob(world, 2, 2, 2);
  // Player far past the step: the mob must climb it to get there.
  const player = { x: 14 * CELL_SIZE + CELL_SIZE / 2, y: 2 * CELL_SIZE, z: 2 * CELL_SIZE + CELL_SIZE / 2 };
  let maxY = mob.pos.y;
  for (let i = 0; i < 200; i++) {
    mob.update(0.1, player);
    maxY = Math.max(maxY, mob.pos.y);
  }
  assert.ok(maxY >= 3 * CELL_SIZE - 0.2, `mob should step up onto the block (max y=${maxY})`);
});

// --- corner navigation (the "stuck on corners" regression) ---

/** 16x16 floor with an L-wall: a wall along x=7 (z=8..14) turning east at
 *  z=8. The mob must round the corner to reach the far side. */
function lWallWorld() {
  const world = new World();
  for (let x = 0; x < 16; x += 2) {
    for (let z = 0; z < 16; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  for (let z = 8; z <= 14; z++) for (let y = 2; y <= 5; y++) world.place('stone', SIZE.SMALL, 7, y, z);
  for (let x = 8; x <= 14; x++) for (let y = 2; y <= 5; y++) world.place('stone', SIZE.SMALL, x, y, 8);
  return world;
}

test('rounds an L-wall corner without getting stuck', () => {
  const { mob } = makeMob(lWallWorld(), 2, 2, 2);
  // Aggro in the open.
  const p1 = { x: 5 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 5 * CELL_SIZE + CELL_SIZE / 2 };
  for (let i = 0; i < 90; i++) mob.update(0.1, p1);
  assert.equal(mob.aggro, true);
  // Player ducks behind the L-corner; the mob must path around it.
  const player = { x: 12 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 12 * CELL_SIZE + CELL_SIZE / 2 };
  let maxStall = 0;
  let stall = 0;
  for (let i = 0; i < 600; i++) {
    const before = { x: mob.pos.x, z: mob.pos.z };
    mob.update(0.1, player);
    const moved = Math.hypot(mob.pos.x - before.x, mob.pos.z - before.z);
    stall = mob.state === 'chase' ? (moved < 0.01 ? stall + 0.1 : 0) : 0;
    maxStall = Math.max(maxStall, stall);
  }
  const d = Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z);
  assert.ok(d < 2.5, `mob should reach the player around the corner (d=${d.toFixed(2)})`);
  assert.ok(maxStall < 1.0, `mob must not stall at the corner (stalled ${maxStall.toFixed(1)}s)`);
});

test('turns cleanly in a 1-wide corridor with a 90-degree corner', () => {
  const world = new World();
  for (let x = 0; x <= 12; x++) {
    for (let z = 0; z <= 12; z++) {
      const inCorridor = (x === 5 && z >= 3 && z <= 12) || (z === 3 && x >= 0 && x <= 5);
      if (inCorridor) {
        const ax = x - (x % 2), az = z - (z % 2);
        if (!world.get(ax, 0, az)) world.place('grass', SIZE.BIG, ax, 0, az);
      } else {
        for (let y = 2; y <= 5; y++) world.place('stone', SIZE.SMALL, x, y, z);
      }
    }
  }
  const { mob } = makeMob(world, 5, 10, 2);
  // Straight down the corridor first (seen), then round the turn.
  const seen = { x: 5 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 8 * CELL_SIZE + CELL_SIZE / 2 };
  for (let i = 0; i < 90; i++) mob.update(0.1, seen);
  assert.equal(mob.aggro, true);
  const player = { x: 1 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 3 * CELL_SIZE + CELL_SIZE / 2 };
  let maxStall = 0;
  let stall = 0;
  for (let i = 0; i < 600; i++) {
    const before = { x: mob.pos.x, z: mob.pos.z };
    mob.update(0.1, player);
    const moved = Math.hypot(mob.pos.x - before.x, mob.pos.z - before.z);
    stall = mob.state === 'chase' ? (moved < 0.01 ? stall + 0.1 : 0) : 0;
    maxStall = Math.max(maxStall, stall);
  }
  const d = Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z);
  assert.ok(d < 2.5, `mob should round the 90-degree corner (d=${d.toFixed(2)})`);
  assert.ok(maxStall < 1.0, `mob must not stall in the corridor (stalled ${maxStall.toFixed(1)}s)`);
});

test('pauses to search when it loses sight, then resumes hunting', () => {
  const world = floorWorld();
  // A partial wall down the middle (leaving a route around it) so the player
  // can step out of sight.
  for (let z = 2; z <= 5; z++) for (let y = 2; y <= 5; y++) world.place('stone', SIZE.SMALL, 4, y, z);
  const { mob } = makeMob(world, 1, 4, 2); // west of the wall
  // Aggro while the player is on the same side (in sight).
  const seen = { x: 2 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 4 * CELL_SIZE + CELL_SIZE / 2 };
  for (let i = 0; i < 30; i++) mob.update(0.1, seen);
  assert.equal(mob.aggro, true);
  // Player steps to the far side of the wall — out of sight.
  const hidden = { x: 7 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 4 * CELL_SIZE + CELL_SIZE / 2 };
  let pausedFrames = 0;
  let moved = false;
  for (let i = 0; i < 30; i++) {
    const before = { ...mob.pos };
    mob.update(0.1, hidden);
    if (Math.hypot(mob.pos.x - before.x, mob.pos.z - before.z) < 0.001) pausedFrames++;
    else moved = true;
  }
  assert.equal(mob._searching, false, 'the search pause must end');
  assert.ok(pausedFrames >= 4, `mob should pause ~0.45s after losing sight (paused ${pausedFrames} frames)`);
  assert.ok(moved, 'mob should resume moving after the search pause');
});

test('a mob below the player cannot bite them', () => {
  const world = floorWorld();
  const { mob, hits } = makeMob(world, 2, 2, 2);
  // Player directly above the mob's column but out of vertical reach (~2m up).
  const player = { x: mob.pos.x, y: mob.pos.y + 2.0, z: mob.pos.z };
  for (let i = 0; i < 40; i++) mob.update(0.1, player);
  assert.equal(hits.length, 0, 'a mob below the player must not land a strike');
  assert.notEqual(mob.state, 'attack', 'mob must not enter the attack wind-up');
});

test('a mob at the same level in reach still attacks', () => {
  const world = floorWorld();
  const { mob, hits } = makeMob(world, 2, 2, 2);
  const player = { x: mob.pos.x + 0.5, y: mob.pos.y, z: mob.pos.z };
  for (let i = 0; i < 40; i++) mob.update(0.1, player);
  assert.ok(hits.length >= 1, 'same-level mob should strike the player');
});

test('walks off a ledge and lands on the lower surface (Y-aware waypoints)', () => {
  // Upper ground slab (surface y=2) with a cliff down to a lower slab (surface
  // y=-1) to the north. The mob must drop off the ledge, not strand on it.
  const world = new World();
  for (let x = 0; x < 8; x++) {
    for (let z = 0; z < 4; z++) {
      for (let y = 0; y <= 1; y++) world.place('stone', SIZE.SMALL, x, y, z);
    }
    for (let z = 4; z < 8; z++) world.place('stone', SIZE.SMALL, x, -2, z); // lower slab
  }
  const { mob } = makeMob(world, 2, 1, 2); // upper ground
  // Player on the lower slab, in sight over the cliff.
  const player = { x: 2 * CELL_SIZE + CELL_SIZE / 2, y: -1 * CELL_SIZE, z: 6 * CELL_SIZE + CELL_SIZE / 2 };
  for (let i = 0; i < 300; i++) mob.update(0.1, player);
  assert.ok(mob.pos.y <= -0.4, `mob should drop onto the lower slab (y=${mob.pos.y.toFixed(2)})`);
  assert.ok(mob.grounded, 'mob should be standing on the lower slab');
});

test('a long fall lands on the floor instead of tunneling through it', () => {
  // A 1m-thick floor (cells y=0,1) under open air.
  const world = new World();
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      for (let y = 0; y <= 1; y++) world.place('stone', SIZE.SMALL, x, y, z);
    }
  }
  const { mob } = makeMob(world, 2, 2, 2);
  mob.aggro = true;
  mob.state = 'chase';
  mob._repathTimer = 0;
  mob.pos.y = 15; // dropped from high above
  mob.grounded = false;
  mob.velY = 0;
  const player = { x: 7 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 7 * CELL_SIZE + CELL_SIZE / 2 };
  let minY = mob.pos.y;
  for (let i = 0; i < 600; i++) {
    mob.update(0.1, player); // 0.1s frames = worst-case lag
    minY = Math.min(minY, mob.pos.y);
    if (mob.grounded) break;
  }
  assert.ok(mob.grounded, 'mob should land on the floor');
  assert.ok(minY >= 1.0 - 0.01, `mob must not fall through the floor (minY=${minY.toFixed(2)})`);
  assert.ok(mob.pos.y >= 1.0 - 0.01 && mob.pos.y <= 1.0 + 0.01, `mob rests on the floor (y=${mob.pos.y.toFixed(2)})`);
});
