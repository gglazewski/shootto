// mobevade.test.js — under-fire evasion: a shot mob that can't see or reach
// the shooter jukes between random nearby spots instead of standing still.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { NavMesh } from '../src/engine/NavMesh.js';
import { Mob } from '../src/game/Mob.js';
import { getMob } from '../src/engine/mobTypes.js';
import { CELL_SIZE } from '../src/engine/Space.js';

/** Open floor spanning cells 0..15 at y=0..1 (walk surface = cell y=2). */
function floorWorld() {
  const w = new World();
  for (let x = 0; x < 16; x += 2) {
    for (let z = 0; z < 16; z += 2) w.place('grass', SIZE.BIG, x, 0, z);
  }
  return w;
}

function makeMob(world, cx, cz) {
  const type = getMob('imp');
  const nav = new NavMesh(world, { halfWidth: type.halfWidth, height: type.height });
  const mob = new Mob({ type, spawnCell: [cx, 2, cz], world, nav, onDamagePlayer: () => {} });
  mob.sharedVisible = false; // the manager says: shooter not in sight
  return mob;
}

const DT = 1 / 30;

/** Step the mob for `seconds` against a fixed player position. */
function run(mob, player, seconds) {
  for (let t = 0; t < seconds; t += DT) mob.update(DT, player);
}

test('shot without sight or path: the mob starts juking instead of freezing', () => {
  const world = floorWorld();
  const mob = makeMob(world, 8, 8);
  const start = { x: mob.pos.x, z: mob.pos.z };
  // Shooter far off the navmesh (sniping from an unreachable perch).
  const shooter = { x: 100, y: 50, z: 100 };
  mob.takeDamage(1, shooter);
  let juked = false;
  for (let t = 0; t < 2; t += DT) {
    mob.update(DT, shooter);
    juked ||= mob._evading;
  }
  assert.ok(juked, 'mob entered the juke');
  const moved = Math.hypot(mob.pos.x - start.x, mob.pos.z - start.z);
  assert.ok(moved > 0.8, `mob displaced while under fire (moved ${moved.toFixed(2)} m)`);
});

test('reaching the empty last-known spot starts the juke', () => {
  const world = floorWorld();
  const mob = makeMob(world, 4, 4);
  // Shot from a reachable spot on the floor: the mob hunts it first...
  const shooter = { x: 12 * CELL_SIZE + 0.25, y: 1, z: 12 * CELL_SIZE + 0.25 };
  mob.takeDamage(1, shooter);
  // Sampled across frames: the mob must press all the way to the shot
  // origin, find nothing (still blind), and start juking. Between two hops
  // the flag can be momentarily false.
  let minDist = Infinity;
  let juked = false;
  for (let t = 0; t < 6; t += DT) {
    mob.update(DT, shooter);
    minDist = Math.min(minDist, Math.hypot(mob.pos.x - shooter.x, mob.pos.z - shooter.z));
    juked ||= mob._evading;
  }
  assert.ok(minDist < 1.6, `mob pressed to the shot origin (closest ${minDist.toFixed(2)} m)`);
  assert.ok(juked, 'mob jukes after searching the empty spot');
});

test('spotting a reachable player ends the juke and resumes the hunt', () => {
  const world = floorWorld();
  const mob = makeMob(world, 8, 8);
  const shooter = { x: 100, y: 50, z: 100 };
  mob.takeDamage(1, shooter);
  run(mob, shooter, 2);
  // The player steps into view across the floor. The mob finishes its
  // current dart, re-tries the goal at the hop end (sight forces the retry),
  // finds a path and drops the panic — within a hop's worth of time.
  const player = { x: mob.pos.x > 4 ? 1 : 7, y: 1, z: mob.pos.z > 4 ? 1 : 7 };
  mob.sharedVisible = true;
  run(mob, player, 2);
  // Charging (or already striking) both count as "hunting again".
  assert.ok(!mob._evading || mob.state === 'attack', 'sight resumes the hunt');
});

test('threat fades but the goal stays unreachable: panic keeps pacing', () => {
  const world = floorWorld();
  const mob = makeMob(world, 8, 8);
  const shooter = { x: 100, y: 50, z: 100 };
  mob.takeDamage(1, shooter);
  run(mob, shooter, 8); // THREAT_TIME (6 s) has expired
  // Still can't see or reach anything — the mob keeps darting (now with
  // breathers between hops instead of frantic chaining).
  let juked = false;
  for (let t = 0; t < 4; t += DT) {
    mob.update(DT, shooter);
    juked ||= mob._evading;
  }
  assert.ok(juked, 'calm panic still paces around');
});

test('a visible player with no path (perch): the mob panics, never shot', () => {
  const world = floorWorld();
  const mob = makeMob(world, 8, 8);
  mob.sharedVisible = true; // in plain sight...
  const player = { x: 4.25, y: 10, z: 4.25 }; // ...hovering 10 m up a perch
  const start = { x: mob.pos.x, z: mob.pos.z };
  let juked = false;
  let moved = 0;
  for (let t = 0; t < 6; t += DT) {
    mob.update(DT, player);
    juked ||= mob._evading;
    moved = Math.max(moved, Math.hypot(mob.pos.x - start.x, mob.pos.z - start.z));
  }
  assert.ok(juked, 'aggro without a path panics instead of standing');
  assert.ok(moved > 0.8, `mob ran around under the perch (max ${moved.toFixed(2)} m)`);
});
