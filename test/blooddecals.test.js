// blooddecals.test.js — blood stains stamped through the decal system on hits.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { CELL_SIZE } from '../src/engine/Space.js';
import { BloodDecals } from '../src/game/BloodDecals.js';

/** Floor at y=0..1 (top surface = cell y=2) with a wall along x=6. */
function roomWorld() {
  const w = new World();
  for (let x = 0; x < 6; x += 2) {
    for (let z = 0; z < 8; z += 2) w.place('grass', SIZE.BIG, x, 0, z);
  }
  for (let z = 0; z < 8; z += 2) {
    for (let y = 2; y < 8; y += 2) w.place('stone', SIZE.BIG, 6, y, z);
  }
  return w;
}

/** Mob stand-in on the floor at cell (cx, 2, cz). */
function fakeMob(cx, cz) {
  return {
    pos: { x: cx * CELL_SIZE + CELL_SIZE / 2, y: 2 * CELL_SIZE, z: cz * CELL_SIZE + CELL_SIZE / 2 },
    height: 0.9,
    halfWidth: 0.2,
  };
}

/** Run fn with Math.random pinned (kills jitter, forces the drip roll). */
function pinned(value, fn) {
  const orig = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

function countStains(world) {
  let n = 0;
  world.forEachDecal((d) => { if (d.decalId === 'decal_blood') n++; });
  return n;
}

test('hit sprays the wall behind the mob and drips on the floor', () => {
  const world = roomWorld();
  const blood = new BloodDecals({ world });
  const mob = fakeMob(3, 3);
  pinned(0.5, () => blood.splatter(mob, { x: 1, y: 0, z: 0 }, false));
  // Wall spray: shot direction +x from chest height (cell y=2) lands on the
  // wall's nx face (tile is a per-face random pick among the blood variants).
  const wall = world.decalAt(6, 2, 3, 'nx');
  assert.ok(wall, 'wall behind the mob is stained');
  assert.match(wall.decalId, /^decal_blood/);
  // Drip roll 0.5 < 0.6 passes: floor under the feet gets a stain on top.
  assert.ok(world.decalAt(3, 1, 3, 'py'), 'floor under the mob is stained');
});

test('kill pours the 2x2 blood pool under the corpse', () => {
  const world = roomWorld();
  const blood = new BloodDecals({ world });
  const mob = fakeMob(3, 3);
  pinned(0.5, () => blood.splatter(mob, { x: 1, y: 0, z: 0 }, true));
  const pool = world.decalAt(3, 1, 3, 'py');
  assert.ok(pool, 'floor under the corpse is stained');
  assert.equal(pool.decalId, 'decal_blood_pool');
  // The pool spans 2x2 cells — the anchor's neighbors share the same decal.
  assert.equal(world.decalAt(2, 1, 2, 'py'), pool);
});

test('never overwrites an existing decal', () => {
  const world = roomWorld();
  assert.ok(world.placeDecal('decal_graffiti', 6, 2, 2, 'nx', 0));
  const blood = new BloodDecals({ world });
  const mob = fakeMob(3, 3);
  pinned(0.5, () => blood.splatter(mob, { x: 1, y: 0, z: 0 }, false));
  // The graffiti spans [4,2] cells of the wall — the spray lands inside it
  // and must bounce off; the editor's art survives untouched.
  assert.equal(world.decalAt(6, 2, 3, 'nx').decalId, 'decal_graffiti');
});

test('stain budget peels the oldest stain off', () => {
  const world = roomWorld();
  const blood = new BloodDecals({ world });
  // Stamp way past the budget across distinct cell faces (6*8*2 = 96 > 64).
  for (const y of [1, 0]) {
    for (let x = 0; x < 6; x++) {
      for (let z = 0; z < 8; z++) {
        pinned(0.5, () => blood._stamp([x, y, z], 'py'));
      }
    }
  }
  assert.ok(countStains(world) <= 64, 'live stains stay within the budget');
  assert.equal(world.decalAt(0, 1, 0, 'py'), null, 'oldest stain was removed');
});

test('reset forgets bookkeeping without touching a fresh world', () => {
  const world = roomWorld();
  const blood = new BloodDecals({ world });
  pinned(0.5, () => blood.splatter(fakeMob(3, 3), { x: 1, y: 0, z: 0 }, false));
  world.clear(); // world reload path clears decals itself
  blood.reset();
  assert.equal(countStains(world), 0);
  assert.equal(blood._stains.length, 0);
});
