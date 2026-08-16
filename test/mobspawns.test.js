// mobspawns.test.js — mob spawn storage + world serialization.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';

function worldWithSpawns() {
  const w = new World();
  w.place('grass', SIZE.BIG, 0, 0, 0);
  w.place('grass', SIZE.BIG, 2, 0, 0);
  w.addMobSpawn('imp', 2, 3, 2);
  w.addMobSpawn('brute', 6, 3, 6);
  return w;
}

test('add/find/remove/iterate mob spawns', () => {
  const w = new World();
  assert.ok(w.addMobSpawn('imp', 2, 3, 2));
  assert.equal(w.addMobSpawn('imp', 2, 3, 2), false, 'duplicate cell rejected');
  assert.equal(w.mobSpawnAt(2, 3, 2).type, 'imp');
  assert.equal(w.mobSpawnAt(1, 3, 2), null);

  const seen = [];
  w.forEachMobSpawn((s) => seen.push(s.type));
  assert.deepEqual(seen, ['imp']);

  assert.deepEqual(w.removeMobSpawnAt(2, 3, 2), { type: 'imp', x: 2, y: 3, z: 2 });
  assert.equal(w.mobSpawnAt(2, 3, 2), null);
  assert.equal(w.removeMobSpawnAt(2, 3, 2), null);
});

test('clear() drops every mob spawn', () => {
  const w = worldWithSpawns();
  w.clear();
  let count = 0;
  w.forEachMobSpawn(() => count++);
  assert.equal(count, 0);
});

test('serialize/deserialize round-trips mob spawns', () => {
  const w = worldWithSpawns();
  const { world, errors } = deserialize(serialize(w));
  assert.deepEqual(errors, []);
  const types = [];
  world.forEachMobSpawn((s) => types.push(`${s.type}@${s.x},${s.y},${s.z}`));
  assert.deepEqual(types.sort(), ['brute@6,3,6', 'imp@2,3,2']);
});

test('deserialize tolerates old maps without a mobs field', () => {
  const text = JSON.stringify({ format: 'voxelmap', version: 1, cellSize: 0.5, spawn: null, blocks: [], items: [] });
  const { world, errors } = deserialize(text);
  assert.deepEqual(errors, []);
  let count = 0;
  world.forEachMobSpawn(() => count++);
  assert.equal(count, 0);
});

test('deserialize skips malformed or unknown mob spawns with errors', () => {
  const text = JSON.stringify({
    format: 'voxelmap',
    version: 1,
    cellSize: 0.5,
    spawn: null,
    blocks: [],
    items: [],
    mobs: [
      { type: 'imp', x: 1, y: 2, z: 3 },
      { type: 'dragon', x: 4, y: 5, z: 6 },
      { x: 7, y: 8, z: 9 },
      { type: 'imp', x: 'bad', y: 0, z: 0 },
    ],
  });
  const { world, errors } = deserialize(text);
  assert.equal(errors.length, 3, 'one unknown + one missing type + one malformed');
  let count = 0;
  world.forEachMobSpawn(() => count++);
  assert.equal(count, 1);
});

test('spawner settings (loot pool + respawn delay) ride the spawn record', () => {
  const w = new World();
  assert.ok(w.addMobSpawn('imp', 2, 3, 2, { loot: ['bat', 'pipe'], delay: [5, 15] }));
  const s = w.mobSpawnAt(2, 3, 2);
  assert.deepEqual(s.loot, ['bat', 'pipe']);
  assert.deepEqual(s.delay, [5, 15]);

  // Plain spawns carry no settings fields at all.
  assert.ok(w.addMobSpawn('imp', 4, 3, 2));
  assert.equal('loot' in w.mobSpawnAt(4, 3, 2), false);
  assert.equal('delay' in w.mobSpawnAt(4, 3, 2), false);

  // copyFrom threads the settings.
  const copy = new World();
  copy.copyFrom(w);
  assert.deepEqual(copy.mobSpawnAt(2, 3, 2).loot, ['bat', 'pipe']);
  assert.deepEqual(copy.mobSpawnAt(2, 3, 2).delay, [5, 15]);
  assert.equal('loot' in copy.mobSpawnAt(4, 3, 2), false);
});

test('serialize/deserialize round-trips spawner settings, omitting defaults', () => {
  const w = new World();
  w.place('grass', SIZE.BIG, 0, 0, 0);
  w.addMobSpawn('imp', 2, 3, 2, { loot: [], delay: [10, 20] });
  w.addMobSpawn('brute', 6, 3, 6);

  const text = serialize(w);
  const plain = JSON.parse(text).mobs.find((m) => m.type === 'brute');
  assert.equal('loot' in plain, false, 'default settings stay off the wire');
  assert.equal('delay' in plain, false);

  const { world, errors } = deserialize(text);
  assert.deepEqual(errors, []);
  const s = world.mobSpawnAt(2, 3, 2);
  assert.deepEqual(s.loot, [], 'an explicit empty pool (no drops) survives');
  assert.deepEqual(s.delay, [10, 20]);
  assert.equal('loot' in world.mobSpawnAt(6, 3, 6), false);
});

test('deserialize drops malformed spawner settings but keeps the spawn', () => {
  const text = JSON.stringify({
    format: 'voxelmap', version: 1, cellSize: 0.5, spawn: null, blocks: [], items: [],
    mobs: [{ type: 'imp', x: 1, y: 2, z: 3, loot: 'bat', delay: [5] }],
  });
  const { world, errors } = deserialize(text);
  assert.deepEqual(errors, []);
  const s = world.mobSpawnAt(1, 2, 3);
  assert.ok(s, 'the spawn itself loads');
  assert.equal('loot' in s, false, 'a non-array pool is ignored');
  assert.equal('delay' in s, false, 'a one-number range is ignored');
});
