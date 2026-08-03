// mobmanager.test.js — shared line-of-sight: a cluster of mobs can spot the
// player together, but mobs walled off (or out of aggro range) do NOT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../vendor/three.module.js';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { MobManager } from '../src/game/MobManager.js';
import { deserializeBundle } from '../src/persistence/WorldBundle.js';

const stubRenderer = { update() {}, addMob() {}, removeMob() {}, clear() {} };

/** 48x48-cell floor with a tall wall down the middle at x=24. */
function walledWorld() {
  const w = new World();
  for (let x = 0; x < 48; x += 2) {
    for (let z = 0; z < 48; z += 2) w.place('grass', SIZE.BIG, x, 0, z);
  }
  for (let z = 0; z < 48; z++) {
    for (let y = 2; y <= 8; y++) w.place('stone', SIZE.SMALL, 24, y, z);
  }
  return w;
}

function makeManager(world) {
  return new MobManager({ THREE, scene: {}, world, onDamagePlayer: () => {}, renderer: stubRenderer });
}

test('a group of mobs shares LOS while walled/far mobs do not aggro', () => {
  const world = walledWorld();
  // West of the wall, near the player (world x ~5-6).
  world.addMobSpawn('imp', 10, 2, 22); // world (5.25, 1.0, 11.25)
  world.addMobSpawn('imp', 10, 2, 24); // world (5.25, 1.0, 12.25)
  world.addMobSpawn('imp', 12, 2, 22); // world (6.25, 1.0, 11.25)
  // East of the wall, within aggro range but with no line of sight.
  world.addMobSpawn('imp', 34, 2, 22); // world (17.25, 1.0, 11.25)
  world.addMobSpawn('imp', 36, 2, 24); // world (18.25, 1.0, 12.25)
  // Far corner, beyond aggro range entirely.
  world.addMobSpawn('imp', 46, 2, 46); // world (23.25, 1.0, 23.25)

  const mgr = makeManager(world);
  mgr.rebuild();
  assert.equal(mgr.mobs.length, 6);

  const player = { x: 6.25, y: 1.0, z: 12.25 }; // column (12,24), west of the wall
  for (let i = 0; i < 5; i++) mgr.update(0.1, player);

  const aggroByX = mgr.mobs.map((m) => ({ x: m.pos.x, aggro: m.aggro })).sort((a, b) => a.x - b.x);
  const near = aggroByX.filter((m) => m.x < 10);
  const walled = aggroByX.filter((m) => m.x > 15 && m.x < 20);
  const far = aggroByX.filter((m) => m.x > 22);

  assert.equal(near.length, 3, 'three mobs cluster near the player');
  assert.ok(near.every((m) => m.aggro), 'the cluster sees the player and aggroes');
  assert.equal(walled.length, 2);
  assert.ok(walled.every((m) => !m.aggro), 'mobs across a wall must not aggro');
  assert.equal(far.length, 1);
  assert.equal(far[0].aggro, false, 'mobs beyond aggro range must not aggro');
});

test('one LOS ray is cast per bucket, not per mob', () => {
  const world = walledWorld();
  // Three mobs in the SAME 3D bucket (world x 4.75/5.25/5.75 all in one
  // 1.5 m interval; z and floor identical too).
  world.addMobSpawn('imp', 9, 2, 22);  // world (4.75, 1.0, 11.25)
  world.addMobSpawn('imp', 10, 2, 22); // world (5.25, 1.0, 11.25)
  world.addMobSpawn('imp', 11, 2, 22); // world (5.75, 1.0, 11.25)

  const mgr = makeManager(world);
  mgr.rebuild();
  assert.equal(mgr.mobs.length, 3);
  const keys = new Set(mgr.mobs.map((m) => mgr._bucketKey(m)));
  assert.equal(keys.size, 1, 'all three mobs share one bucket');

  const player = { x: 6.25, y: 1.0, z: 12.25 };
  let rays = 0;
  const orig = mgr.solidWorld;
  mgr.solidWorld = new Proxy(orig, {
    get(t, prop) {
      return prop === 'get' ? (...a) => { rays++; return orig.get(...a); } : t[prop];
    },
  });
  // Run past the per-mob aggro stagger (0..0.3s) so every mob in the bucket
  // wakes, then verify they all share the same LOS verdict.
  for (let i = 0; i < 4; i++) mgr.update(0.1, player);
  // One bucket -> a bounded number of LOS rays, not one raycast per mob.
  assert.ok(rays > 0 && rays < 1000, `expected a bounded single ray walk, got ${rays} cell reads`);
  const verdicts = new Set(mgr.mobs.map((m) => m.sharedVisible));
  assert.equal(verdicts.size, 1, 'mobs in one bucket share a verdict');
  assert.ok(mgr.mobs.every((m) => m.aggro), 'and that verdict makes them all aggro');
});

test('mobs chase the player down the bundled-world staircase without disappearing', () => {
  // The real shipped map: a staircase descends ~3.5m into a basement. Mobs
  // chasing the player down it must descend (not vanish / fall through the
  // world / get flung off the map) — the bug seen at world (7.8, -0.4, 1.0).
  const raw = JSON.parse(readFileSync(new URL('../map/voxelbundle.json', import.meta.url), 'utf8'));
  const { world } = deserializeBundle(JSON.stringify(raw));
  world.addMobSpawn('imp', 15, 2, 5); // on the ground, above the staircase
  const mgr = new MobManager({ THREE, scene: {}, world, onDamagePlayer: () => {}, renderer: stubRenderer });
  mgr.rebuild();
  assert.ok(mgr.mobs.length >= 1, 'mobs spawn from the bundled map');

  // Aggro while the player is on the ground beside the staircase.
  const onGround = { x: 8.25, y: 1.0, z: 2.75 };
  for (let i = 0; i < 120; i++) mgr.update(1 / 60, onGround);

  // The player ducks down the staircase into the basement; mobs must follow
  // down without any position going non-finite or plunging below the world.
  const basement = { x: 4.25, y: -2.5, z: 0.75 };
  let minY = 1e9;
  let nonFinite = false;
  for (let i = 0; i < 30 * 60; i++) {
    const d = i % 45 === 0 ? 0.1 : 1 / 60; // include lag spikes
    mgr.update(d, basement);
    for (const m of mgr.mobs) {
      minY = Math.min(minY, m.pos.y);
      if (!Number.isFinite(m.pos.x + m.pos.y + m.pos.z)) { nonFinite = true; break; }
      if (m.pos.y < -20) { minY = m.pos.y; nonFinite = true; break; }
    }
    if (nonFinite) break;
  }
  assert.equal(nonFinite, false, 'no mob may disappear (non-finite position or plunge)');
  assert.ok(minY < -1.5, `at least one mob should descend into the basement (minY=${minY.toFixed(1)})`);
});
